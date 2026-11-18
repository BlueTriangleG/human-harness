// 中央记忆：所有脑区共享的一条按时间排序的总记录（也是原文存档）。
// - append：任何脑区 / 外界输入写进来，原文全部保存
// - since：某个脑区游标之后、别人写的记录
// - render：把别人的记录渲染成"你自己的经历"（C1 验证过的写法：过去时、不是指令）
import type { PromptFolds } from "./folds.ts";
import type { Db } from "../store/db.ts";
import { all } from "../store/db.ts";
import { estimateTokens } from "./tokens.ts";
import { MCP_PREFIX } from "../kernel/types.ts";
import { targetKey } from "../persona/people.ts";
import { B, M, dateLocale } from "../lang/index.ts";

export type Kind = "input" | "think" | "say" | "act" | "result" | "note" | "system";

export interface Entry {
  seq: number;
  ts: number;
  epoch: number;
  src: string;
  kind: Kind;
  text: string;
  tokens: number;
  meta: Record<string, unknown> | null;
}

/** 中央记忆里的一截：编号大于 after、不超过 upTo；keep 这个来源写的不算在里面 */
export interface SeqGap { after: number; upTo: number; keep?: string }

/** 记忆里怎么标来源；e 是这一条（按它发生的时间标当时在做的事） */
export interface Labeler { (src: string, e?: Entry): string }

const HALF_HOUR = 30 * 60_000;

/** 时间标记：和上一次标的隔了半小时以上才标，精确到半小时；跨天带日期 */
export interface TimeMarks { last: number | null }

function timeMark(ts: number, tz: string, marks: TimeMarks): string {
  if (marks.last !== null && ts - marks.last < HALF_HOUR) return "";
  const prev = marks.last;
  marks.last = ts;
  const slot = Math.floor(ts / HALF_HOUR) * HALF_HOUR;
  const day = (x: number) => new Intl.DateTimeFormat(dateLocale(), { timeZone: tz, month: "2-digit", day: "2-digit" }).format(x);
  const withDay = prev === null ? false : day(prev) !== day(ts);
  return `〔${withDay ? `${day(slot)} ` : ""}${hm(slot, tz)}〕`;
}

export class CentralMemory {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  append(epoch: number, src: string, kind: Kind, text: string, meta: Record<string, unknown> | null = null, at?: number): Entry {
    const ts = at ?? this.now();
    const tokens = estimateTokens(text);
    const r = this.db
      .prepare("INSERT INTO central (ts, epoch, src, kind, text, tokens, meta) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(ts, epoch, src, kind, text, tokens, meta ? JSON.stringify(meta) : null);
    return { seq: Number(r.lastInsertRowid), ts, epoch, src, kind, text, tokens, meta };
  }

  /** 游标之后的记录；exclude 里的来源不要（自己的记录不回灌给自己） */
  since(cursor: number, exclude: ReadonlySet<string> = new Set()): Entry[] {
    const rows = all<RawRow>(this.db, "SELECT * FROM central WHERE seq > ? ORDER BY seq", cursor);
    return rows.map(toEntry).filter((e) => !exclude.has(e.src));
  }

  /** 一件事的经过（回头看用）：做它的那部分从某个时刻起的记录，加上它派的帮手交回来的 */
  ownedSince(owner: string, sinceTs: number): Entry[] {
    return all<RawRow>(this.db, "SELECT * FROM central WHERE ts >= ? AND (src = ? OR (kind = 'input' AND meta LIKE '%\"hands\":true%')) ORDER BY seq", sinceTs, owner)
      .map(toEntry).filter((e) => e.src === owner || (e.meta?.owner ?? "main") === owner);
  }

  /** 某一页（纪元）的全部记录 */
  page(epoch: number): Entry[] {
    const rows = all<RawRow>(this.db, "SELECT * FROM central WHERE epoch = ? ORDER BY seq", epoch);
    return rows.map(toEntry);
  }

  /**
   * 最后一段记录，总量不超过 maxTokens（换班时带给新实例）。
   * skip：编号在 (after, upTo] 的那一截当它不存在（#0054：夜里睡着到醒来之间写进来的是整理的记录，不是她的经历）；
   * skip.keep 这个来源写的照样带（她自己那一刻的话、以她的名义记下的）。
   * upTo：只取编号到这里为止的（整页带上的开场前面接的睡前那段：那一截以前的最后一段，#0054）
   */
  tail(maxTokens: number, skip?: SeqGap, upTo = Number.MAX_SAFE_INTEGER): Entry[] {
    const rows = skip
      ? all<RawRow>(this.db, "SELECT * FROM central WHERE seq <= ? AND (seq <= ? OR seq > ? OR src = ?) ORDER BY seq DESC LIMIT 2000", upTo, skip.after, skip.upTo, skip.keep ?? "")
      : all<RawRow>(this.db, "SELECT * FROM central WHERE seq <= ? ORDER BY seq DESC LIMIT 2000", upTo);
    const out: Entry[] = [];
    let sum = 0;
    for (const r of rows) {
      if (sum + r.tokens > maxTokens && out.length) break;
      sum += r.tokens;
      out.push(toEntry(r));
    }
    return out.reverse();
  }

  /** 这一截里有没有会被跳过的记录（一条都没有的话，跳不跳取到的都一样） */
  skips(gap: SeqGap): boolean {
    return this.db.prepare("SELECT 1 AS x FROM central WHERE seq > ? AND seq <= ? AND src != ? LIMIT 1").get(gap.after, gap.upTo, gap.keep ?? "") !== undefined;
  }

  /** 翻页时：切页点之后写进来的记录归到新的一页 */
  retag(afterSeq: number, epoch: number): number {
    return Number(this.db.prepare("UPDATE central SET epoch = ? WHERE seq > ?").run(epoch, afterSeq).changes);
  }

  /** 某一页里、到 maxSeq 为止的记录（翻页压缩的输入） */
  pageUpTo(epoch: number, maxSeq: number): Entry[] {
    return all<RawRow>(this.db, "SELECT * FROM central WHERE epoch = ? AND seq <= ? ORDER BY seq", epoch, maxSeq).map(toEntry);
  }

  pageTokens(epoch: number): number {
    // 下意识自己的过程不算进这一页（它不同步给别人，也不进压缩）
    const r = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM central WHERE epoch = ? AND (meta IS NULL OR meta NOT LIKE '%\"inner\":true%')").get(epoch) as { n: number };
    return Number(r.n);
  }

  /**
   * 这一页在某个主意识眼前有多大。她自己的记录照原样算
   * （在她自己的会话里就是原样）；别人的照 sync 视角渲染的样子估：动作（自己那几个工具除外）最多 SYNC_ACT_CHARS 字、
   * 工具结果折成一行（出错的带前 SYNC_ERROR_CHARS 字）、别的最多 maxItemChars 字；下意识的内部过程看不见的不算。
   * 11-04 一天翻了 6 页，撑满的主要是后台帮手的工具结果原文，她眼前只有一行。afterSeq：只算这条以后的（联想「隔多少再挂」用）
   */
  viewTokens(epoch: number, viewer: string, o: { maxItemChars: number; afterSeq?: number; thinkChars?: number }): number {
    return this.viewRows(epoch, viewer, o.afterSeq ?? 0, o.maxItemChars, o.thinkChars).reduce((n, r) => n + r.n, 0);
  }

  /**
   * 同一个视角，一次算好几个起点：每个 seq 以后（不含它）又多了多少（联想「隔多少再挂」一次要问好几个挂的时刻，
   * 一个个 viewTokens 是一遍遍从头扫到尾；这里只扫一遍、从后往前累加）
   */
  viewTokensAfter(epoch: number, viewer: string, seqs: number[], o: { maxItemChars: number; thinkChars?: number }): Map<number, number> {
    const out = new Map<number, number>();
    if (!seqs.length) return out;
    const sorted = [...new Set(seqs)].sort((a, b) => b - a);
    const rows = this.viewRows(epoch, viewer, sorted.at(-1)!, o.maxItemChars, o.thinkChars);
    let i = rows.length - 1;
    let acc = 0;
    for (const s of sorted) {
      for (; i >= 0 && rows[i]!.seq > s; i--) acc += rows[i]!.n;
      out.set(s, acc);
    }
    return out;
  }

  /** 这一页里 afterSeq 以后、viewer 眼前的每一条各算多少 token（按 seq 升序）；thinkChars：别人的「想」折成一行（renderMemory 的 thinkChars） */
  private viewRows(epoch: number, viewer: string, afterSeq: number, maxItemChars: number, thinkChars?: number): Array<{ seq: number; n: number }> {
    const rows = this.db.prepare(
      "SELECT seq, src, kind, tokens, length(text) AS len, json_extract(meta, '$.tool') AS tool, json_extract(meta, '$.error') AS err FROM central " +
      "WHERE epoch = ? AND seq > ? AND (src = ? OR meta IS NULL OR meta NOT LIKE '%\"inner\":true%' OR json_extract(meta, '$.for') = ?) ORDER BY seq",
    ).all(epoch, afterSeq, viewer, viewer) as Array<{ seq: number; src: string; kind: string; tokens: number; len: number; tool: string | null; err: number | null }>;
    return rows.map((r) => {
      const t = Number(r.tokens);
      if (r.src === viewer) return { seq: Number(r.seq), n: t };
      const cap = (chars: number): number => Math.min(t, Math.ceil((t * chars) / Math.max(1, Number(r.len))));
      const n = r.kind === "result" ? FOLDED_LINE_TOKENS + (Number(r.err) === 1 ? cap(SYNC_ERROR_CHARS) : 0)
        : r.kind === "act" && !(r.tool && SELF_TOOLS.has(r.tool)) ? cap(SYNC_ACT_CHARS)
        : r.kind === "think" && thinkChars ? cap(thinkChars)
        : cap(maxItemChars);
      return { seq: Number(r.seq), n };
    });
  }

  /** 最近发给某个目标的话（她自己说过的，给"别复读、别光说不做"用）；目标按 targetKey 比，记着网关认出的会话号（toId）的也算 */
  recentSent(target: string, sinceTs: number): Array<{ text: string; at: number; batch?: string }> {
    const rows = all<RawRow>(this.db, "SELECT * FROM central WHERE kind = 'note' AND ts > ? AND meta LIKE '%\"sent\":true%' ORDER BY seq", sinceTs);
    return rows.map(toEntry).filter((e) => sentTo(e.meta, target))
      .map((e) => ({ text: sentBody(e.text), at: e.ts, ...(typeof e.meta?.batch === "string" ? { batch: e.meta.batch } : {}) }));
  }

  /** 这个人在这个渠道最后一次来消息的时间（QQ 机器人只能在对方来消息后一小时内回）；没来过返回 null。目标按 targetKey 比 */
  lastHeardFrom(channel: string, target: string): number | null {
    // 每个回复目标一行（不同的人、群没多少），再按键比：QQ 号大小写两种写法都算这个人
    const rows = this.db.prepare(
      "SELECT json_extract(meta, '$.replyTo.target') AS target, MAX(ts) AS t FROM central WHERE kind = 'input' AND json_extract(meta, '$.replyTo.channel') = ? GROUP BY target",
    ).all(channel) as Array<{ target: unknown; t: number | null }>;
    const key = targetKey(target);
    let last: number | null = null;
    for (const r of rows) if (typeof r.target === "string" && r.t != null && targetKey(r.target) === key) last = Math.max(last ?? -Infinity, Number(r.t));
    return last;
  }

  /** 某个时间之后的输入和发出去的话（看最近聊得多不多） */
  chatSince(ts: number): Entry[] {
    return all<RawRow>(this.db, "SELECT * FROM central WHERE ts > ? AND kind IN ('input', 'note') ORDER BY seq", ts).map(toEntry);
  }

  /**
   * 某个时刻以后、文字里提到这几个词之一的动作（循环提醒到点时，看今天是不是已经做过了）。
   * 先从最后一条往回找到这个时刻以前的最后一条，只扫它后面的（时间跟着编号往前走；不然每次都扫整张表）
   */
  actsMentioning(sinceTs: number, needles: string[]): Entry[] {
    if (!needles.length) return [];
    const any = needles.map(() => "instr(text, ?) > 0").join(" OR ");
    return all<RawRow>(
      this.db,
      `SELECT * FROM central WHERE seq > COALESCE((SELECT seq FROM central WHERE ts < ? ORDER BY seq DESC LIMIT 1), 0) AND kind = 'act' AND ts >= ? AND (${any}) ORDER BY seq`,
      sinceTs, sinceTs, ...needles,
    ).map(toEntry);
  }

  lastSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM central").get() as { n: number };
    return Number(r.n);
  }
}

/** A "sent" record without the head that names who it went to (B.forms.sentHead): the words that were sent */
export const sentBody = (text: string): string => text.replace(B.forms.sentHead, "");

/** 一条「发出去了」的记录是不是发给这个目标的：她写的目标（to）或网关认出的会话号（toId）按 targetKey 对上就算 */
export function sentTo(meta: Record<string, unknown> | null, target: string): boolean {
  const key = targetKey(target);
  return [meta?.to, meta?.toId].some((x) => typeof x === "string" && targetKey(x) === key);
}

interface RawRow { seq: number; ts: number; epoch: number; src: string; kind: string; text: string; tokens: number; meta: string | null }

function toEntry(r: RawRow): Entry {
  return {
    seq: Number(r.seq), ts: Number(r.ts), epoch: Number(r.epoch), src: r.src, kind: r.kind as Kind,
    text: r.text, tokens: Number(r.tokens), meta: r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : null,
  };
}

function hm(ts: number, tz: string): string {
  return new Intl.DateTimeFormat(dateLocale(), { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);
}

export function truncate(text: string, maxChars: number, seq: number): string {
  if (text.length <= maxChars) return text;
  return M.central.truncated(text.slice(0, maxChars), text.length, seq);
}

/** 她自己的工具（决定和说过的话）：入参全文保留，压缩视角里也不折 */
export const SELF_TOOLS = new Set(["message", "jot_down", "on_it", "set_bar", "done_with", "meanwhile", "think_it_over", "remind", "goals", "hands", "recall", "computer", "ack"]);

const FOLD_THINK_CHARS = 200;
const FOLD_ERROR_CHARS = 200;
/** 主意识之间同步：动作参数最多给这么多字，出错的结果留这么多字 */
export const SYNC_ACT_CHARS = 300;
export const SYNC_ERROR_CHARS = 200;
/** 折成一行的工具结果（「→ 完成（N 字，#编号）」）大约多少 token */
const FOLDED_LINE_TOKENS = 10;
/** 帮手的回报：不是派活的那部分只看这么多字 */
export const HELPER_OTHERS_CHARS = 200;

/** 这个观看者看得到哪些：别的脑区标了 inner 的（下意识自己的过程）只存档、不给看 */
export function visibleTo(entries: Entry[], viewer: string): Entry[] {
  return entries.filter((e) => e.src === viewer || e.meta?.inner !== true || e.meta?.for === viewer);
}

function pick(text: string, key: string): string | null {
  const m = new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`).exec(text);
  return m ? m[1]!.replace(/\\n/g, " ").replace(/\\"/g, '"') : null;
}

/**
 * 记忆里的动作用内核里真调得到的名字（11-02）：HH 自己的工具记的是去掉 mcp__self__ 的短名字，
 * 新会话开头只看得到这段记忆，照着「sticker {…}」去调会报没有这个工具。内置工具（Bash、Read……首字母大写）
 * 和别的 MCP 工具（本来就带 mcp__ 前缀）原样。存档的原文不动，只在渲染给她看时换。
 */
function callName(tool: string): string {
  return /^[a-z]/.test(tool) && !tool.startsWith("mcp__") ? MCP_PREFIX + tool : tool;
}
const toolOf = (e: Entry): string => (typeof e.meta?.tool === "string" ? e.meta.tool : e.text.split(" ", 1)[0]!);
/** 动作原文开头的工具名换成真名 */
function actText(e: Entry): string {
  const tool = toolOf(e);
  return e.text.startsWith(`${tool} `) ? callName(tool) + e.text.slice(tool.length) : e.text;
}

/** 一次工具调用压成一句：用了什么、动的是哪个文件 / 干什么 */
export function foldAct(e: Entry): string {
  const tool = callName(toolOf(e));
  const path = pick(e.text, "file_path") ?? pick(e.text, "notebook_path") ?? pick(e.text, "path");
  const what = pick(e.text, "description") ?? pick(e.text, "pattern") ?? pick(e.text, "url") ?? pick(e.text, "query");
  const cmd = pick(e.text, "command");
  const parts = [path, what ?? (cmd ? cmd.slice(0, 80) + (cmd.length > 80 ? M.central.cmdCut : "") : null)].filter(Boolean);
  return `${tool}${parts.length ? M.central.foldParts(parts) : ""}`;
}

function foldResult(r: Entry | undefined): string {
  if (!r) return M.central.noResultYet;
  if (r.meta?.error === true) return M.central.foldError(r.text.slice(0, FOLD_ERROR_CHARS).replace(/\s+/g, " "), r.text.length > FOLD_ERROR_CHARS, r.seq);
  return M.central.foldDone(r.seq);
}

export interface RenderOpts {
  maxItemChars: number;
  timezone: string;
  /** 时间标记的状态（同一个会话里接着用，就不会每段都重新标时间）；不给就每次从头标 */
  marks?: TimeMarks;
  /** 压缩视角（下意识用）：别人用工具的过程折成一行，别人的思考只留开头；对话、决定、她说过和发出去的话照原样。等于 mode: "fold" */
  fold?: boolean;
  /**
   * full：全量；fold：压缩视角（下意识）；
   * sync：主意识之间——想的、说的、记下的、动作原样，动作参数超过 300 字截断带编号，工具结果折成一行带字数和编号
   */
  mode?: "full" | "sync" | "fold";
  /** 谁在看：帮手的回报只给派活的那部分看原样，别人看开头 */
  viewer?: string;
  /** 每行末尾带上它的编号（翻页压缩用：压出来的每件事要能顺着编号翻回原样） */
  seqs?: boolean;
  /** sync 视角里这个脑区自己的记录照原样（翻页压缩照主线眼前的样子：她自己的原样，别人的折起来） */
  fullFor?: string;
  /** 这个会话里已经说明过一次：抬头只留一句短的（11-02：每段增量都带整段说明，一页里光抬头就上万） */
  brief?: boolean;
  /**
   * sync 视角里别人的「想」折成一行、最多这么多字，后面带编号（主线眼前后台的思考只占一行）。
   * viewer 自己的、fullFor 的照原样；不给就原样（10-31）
   */
  thinkChars?: number;
  /** 进提示前折成一句（memory.promptFolds）：真人的话只换字，别的命中就整条换；不给 = 原样 */
  folds?: PromptFolds;
}

/** 一段「想」折成一行：空白并成一个空格，长了截断带编号 */
function foldThink(e: Entry, chars: number): string {
  const one = e.text.replace(/\s+/g, " ").trim();
  return one.length > chars ? M.central.thinkCut(one.slice(0, chars), e.seq) : one;
}

function syncResult(r: Entry | undefined): string {
  if (!r) return "";
  if (r.meta?.error === true) return M.central.syncError(r.text.slice(0, SYNC_ERROR_CHARS).replace(/\s+/g, " "), r.text.length > SYNC_ERROR_CHARS, r.seq);
  return M.central.syncDone(r.text.length, r.seq);
}

/**
 * 渲染成一段追加进上下文的记忆（记忆是她自己的，第一人称，主语默认是自己，不写"我说""你说"；
 * 时间只在隔了半小时以上才标，精确到半小时）。label 决定"谁"：主线是空的（就是自己），另一头、下意识等才标出来。
 */
/** 「这段没发给任何人」的标记行：记忆里不单列，标在那段话上（所以渲染出来没有它自己的一行） */
export const unsentMark = (e: Entry): boolean => e.kind === "note" && e.meta?.unsent === true;

export function renderMemory(entries: Entry[], label: Labeler, opts: RenderOpts): string {
  if (!entries.length) return "";
  const folds = opts.folds;
  if (folds && !folds.empty) entries = entries.map((e) => folds.entry(e));
  const marks = opts.marks ?? { last: null };
  const mode = opts.mode ?? (opts.fold ? "fold" : "full");
  const fold = mode === "fold";
  const sync = mode === "sync";
  const results = new Map<string, Entry>();
  const used = new Set<number>();
  if (fold || sync) for (const e of entries) if (e.kind === "result" && typeof e.meta?.id === "string" && !(sync && e.src === opts.fullFor)) results.set(e.meta.id, e);
  const who = (src: string, kind: Kind, e?: Entry) => { const l = label(src, e); return l ? `${l}${M.central.verb[kind]}` : M.central.verb[kind]; };
  // 没人收的最终回复（brain.ts 回合结束时记的那条）：不单占一行，标在那几段话上（11-03）
  const unsent = new Set<number>();
  for (const e of entries) if (unsentMark(e) && Array.isArray(e.meta!.of)) for (const s of e.meta!.of) unsent.add(Number(s));
  const lines: string[] = [];
  const push = (seq: number, line: string): void => { lines.push(opts.seqs ? M.central.withSeq(line, seq) : line); };
  for (const e of entries) {
    if (unsentMark(e)) continue;
    const t = timeMark(e.ts, opts.timezone, marks);
    if (e.kind === "input") {
      const otherHelper = opts.viewer !== undefined && e.meta?.hands === true && (e.meta.owner ?? "main") !== opts.viewer;
      const body = otherHelper && e.text.length > HELPER_OTHERS_CHARS
        ? M.central.helperCut(e.text.slice(0, HELPER_OTHERS_CHARS), e.seq)
        : truncate(e.text, opts.maxItemChars, e.seq);
      const from = typeof e.meta?.from === "string" ? e.meta.from : M.central.outside;
      const tag = typeof e.meta?.tag === "string" ? e.meta.tag : null;
      const ch = typeof e.meta?.channel === "string" ? e.meta.channel : null;
      const via = tag || ch ? M.central.via([tag, ch].filter(Boolean)) : "";
      // 感官的动静和自己排的提醒也是自己的经历：「我看到」「我想起来」
      if (from === "感官") push(e.seq, M.central.saw(t, body));
      else if (B.forms.reminderSource.test(from)) push(e.seq, M.central.remembered(t, from, body));
      else push(e.seq, M.central.heard(t, from, via, body));
      continue;
    }
    // 下意识想通的结论：不带标签、不带动词，就是她自己想到的
    if (e.meta?.insight === true) { push(e.seq, `${t}${e.text}`); continue; }
    if (sync && e.src !== opts.fullFor) {
      if (e.kind === "think" && opts.thinkChars && e.src !== opts.viewer) {
        push(e.seq, M.central.thinkLine(t, who(e.src, "think", e), foldThink(e, opts.thinkChars)));
        continue;
      }
      const tool = typeof e.meta?.tool === "string" ? e.meta.tool : null;
      if (e.kind === "act" && !(tool && SELF_TOOLS.has(tool))) {
        const r = typeof e.meta?.id === "string" ? results.get(e.meta.id) : undefined;
        if (r) used.add(r.seq);
        const text = actText(e);
        const body = text.length > SYNC_ACT_CHARS ? M.central.actCut(text.slice(0, SYNC_ACT_CHARS), e.seq) : text;
        const tail = syncResult(r);
        push(e.seq, M.central.syncActLine(t, who(e.src, "act", e), body, tail));
        continue;
      }
      if (e.kind === "result") {
        if (used.has(e.seq)) continue;
        push(e.seq, M.central.syncResultLine(t, who(e.src, "result", e), syncResult(e)));
        continue;
      }
    }
    if (fold) {
      const tool = typeof e.meta?.tool === "string" ? e.meta.tool : null;
      if (e.kind === "act" && !(tool && SELF_TOOLS.has(tool))) {
        const r = typeof e.meta?.id === "string" ? results.get(e.meta.id) : undefined;
        if (r) used.add(r.seq);
        push(e.seq, M.central.foldActLine(t, who(e.src, "act", e), foldAct(e), foldResult(r), e.seq));
        continue;
      }
      if (e.kind === "result") {
        if (used.has(e.seq)) continue;
        push(e.seq, M.central.foldResultLine(t, who(e.src, "result", e), e.meta?.error === true ? foldResult(e) : M.central.foldResultSize(e.text.length, e.seq)));
        continue;
      }
      if (e.kind === "think" && e.text.length > FOLD_THINK_CHARS) {
        push(e.seq, M.central.foldThinkLine(t, who(e.src, "think", e), e.text.slice(0, FOLD_THINK_CHARS), e.seq));
        continue;
      }
    }
    const verb = `${who(e.src, e.kind, e)}${e.kind === "say" && unsent.has(e.seq) ? M.central.unsent : ""}`;
    push(e.seq, M.central.line(t, verb, truncate(e.kind === "act" ? actText(e) : e.text, opts.maxItemChars, e.seq)));
  }
  if (!lines.length) return "";   // 只剩看不见的标记行（那段话在上一段增量里）
  return [
    `<${M.central.tag}>`,
    M.central.intro(opts.brief === true, fold, sync),
    ...lines,
    `</${M.central.tag}>`,
  ].join("\n");
}
