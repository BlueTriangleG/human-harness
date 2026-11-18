// 事件记忆的门面：Brain、工具、命令行都只经过这里。
// 写入只在两种时候开着：夜里整理的一跑（批次 open）、导入模式。白天调写工具一律拒绝。
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { Db } from "../../store/db.ts";
import { all, one } from "../../store/db.ts";
import { EventStore } from "./store.ts";
import type { SectionWrite } from "./store.ts";
import { MemIndex } from "./index.ts";
import type { Embedder } from "./embed.ts";
import { EventRecall, MOMENT_COS, parseRange } from "./recall.ts";
import type { Range } from "./recall.ts";
import { BRACKETS, ENTITY_KINDS, GIST_MAX, kindLabel, stanceWord, TITLE_MAX, isSelfName, likeLabel, localToUtc, normName } from "./schema.ts";
import type { EntityRow, EventRow, ImpressionRow, Rel, Stance } from "./schema.ts";
import { fmtTime, fmtDay } from "./render.ts";
import { byId, cardDigest, cardPath, cardSections, cardTotal, exportPeople, fieldSpec, fieldUsage, keepHint, lostLines, promoteLine, quoteMax, quoteSpec, renderCard, renderNear, specFor, visibleTo } from "./people.ts";
import type { PeopleTemplate } from "./people.ts";
import { B, M, N, fromEveryPack } from "../../lang/index.ts";

const DAY = 86_400_000;
/** recall_person 一次最多给多少字（卡最多占一半） */
const RECALL_PERSON_BUDGET = 2500;
/** 原话是谁说的：「我→主人」是我说给主人的，「我（笔记）」是我记的 */
const speaker = (who: string): string => who.split("→")[0]!.replace(/（.*$/, "").toLowerCase();
/** the head of what the role said to someone, in any pack's word for itself (B.common.self): 我→, me→ */
const selfTo = (): RegExp => new RegExp(`^(?:${fromEveryPack((p) => escapeRe(p.brain.common.self)).join("|")})→`);

export type WriteOp =
  | "mem_event_create" | "mem_event_update" | "mem_entry_add" | "mem_entries_add" | "mem_entry_correct" | "mem_link" | "mem_unlink"
  | "mem_merge" | "mem_split" | "mem_supersede" | "mem_retire" | "mem_entity_upsert" | "mem_entity_merge" | "mem_entity_drop" | "mem_entity_tag" | "mem_day_done"
  | "mem_person_set" | "mem_quote_pin";

/** 白天记喜好（like）：how = 喜欢上 / 烦上 / 又一下 / 腻了（不烦了） / 又喜欢上（又烦上）；fix 改标题、一句话；drop 记错了、不算数 */
export type LikeHow = "like" | "dislike" | "feel" | "over" | "again" | "fix" | "drop";
export interface LikeArgs {
  /** 那个东西：作品、角色、一类内容 */
  what: string;
  how: LikeHow;
  /** 这一下的感受和为什么，她自己的话（fix、drop 以外必填） */
  feeling?: string;
  /** fix：新标题（没带「喜欢 」「烦 」就按 stance 补上） */
  title?: string;
  /** fix：新的一句话（超 80 字截断） */
  gist?: string;
  /** fix、drop：为什么改 / 为什么不算数（必填，写进那次改动） */
  why?: string;
  /** 已有那件的编号：写了就直接接它 */
  event?: string;
  /** 只在新建时用，默认 3 */
  importance?: number;
  /** 只对 like / dislike：不找已有的，直接单独新建一件 */
  new?: boolean;
}
/** like 只在白天醒着做事的那几头：主线、一心多用的那头。整理、导入、体检、潜意识、随口、下意识都不记 */
const LIKE_REGIONS = /^(main|side-\d+)$/;
const clipGist = (s: string): string => (s.length <= GIST_MAX ? s : s.slice(0, GIST_MAX - 1) + M.like.gistCut);
/**
 * 标题的格式前缀：「喜欢 」「烦 」（带空格），或「喜欢」「烦」紧跟开括号（「喜欢《史记》」）。
 * 名字本身以这两个词开头的（喜欢你、烦恼）不算前缀，不去。what 带了这种前缀，新建时也先去掉再拼标题
 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * The like / dislike words as alternatives of a regex: the role's own pack's (what it writes and what it passes), or every
 * pack's (a stored title, written in whichever language the role had). A word in letters ends at a word boundary.
 */
const stanceAlt = (every: boolean): string =>
  (every ? fromEveryPack((p) => p.brain.forms.stance) : [B.forms.stance]).flatMap((s) => [s.like, s.dislike]).map((w) => (/\w$/.test(w) ? `${escapeRe(w)}\\b` : escapeRe(w))).join("|");
const likePrefix = (every: boolean): RegExp => new RegExp(`^\\s*(?:${stanceAlt(every)})(?:\\s+|(?=[《「『〈【（(“‘]))`, "i");
/** every = a stored title (any pack's word); otherwise what the role passes (its own pack's) */
export const stripLikePrefix = (s: string, every = false): string => s.replace(likePrefix(every), "");
/** 标题比较用的名字：去掉格式前缀再规范化 */
export const likeKey = (title: string): string => normName(stripLikePrefix(title, true));
/** 去掉开头「喜欢」「烦」（不管后面跟什么）再规范化；去完少于 2 个字就不算（免得「喜欢你」变成「你」、「烦恼」变成「恼」） */
function bareKey(s: string, every: boolean): string | null {
  const b = normName(s.replace(new RegExp(`^\\s*(?:${stanceAlt(every)})`, "i"), ""));
  return [...b].length >= 2 ? b : null;
}
/** what 拿两种形式去比：原样规范化；去掉开头「喜欢」「烦」再规范化 */
function whatKeys(what: string): string[] {
  const b = bareKey(what, false);
  return [...new Set([normName(what), ...(b ? [b] : [])])].filter(Boolean);
}
/** 标题也拿两种形式（和 what 对称）：去掉格式前缀的（「喜欢 会长」「喜欢《史记》」）；去掉开头「喜欢」「烦」的（线上老标题「喜欢会长」「烦鸡汤结尾和煽情旁白」） */
function titleKeys(title: string): string[] {
  const b = bareKey(title, true);
  return [...new Set([likeKey(title), ...(b ? [b] : [])])].filter(Boolean);
}
/**
 * what 和这个标题：exact = 两边任一形式规范化后完全一样（只有这种自动接上）；near = 任一对形式一方包含另一方（短的那方至少 2 个字），
 * 只拿来列「最像的」让她选；都不是 null
 */
export function likeMatch(what: string, title: string): "exact" | "near" | null {
  const ts = titleKeys(title), ks = whatKeys(what);
  if (ks.some((k) => ts.includes(k))) return "exact";
  return ks.some((k) => ts.some((t) => { const [short, long] = k.length <= t.length ? [k, t] : [t, k]; return [...short].length >= 2 && long.includes(short); })) ? "near" : null;
}
/** 两个标题是不是同一个名字：两边的形式有一对相等（「喜欢会长」和「喜欢 会长」是同一个，「喜欢 会长」和「喜欢 喜欢会长」不是） */
const sameName = (a: string, b: string): boolean => { const kb = titleKeys(b); return titleKeys(a).some((k) => kb.includes(k)); };
/** 最像的排前面：长短越接近越像（都是包含关系） */
const closeness = (what: string, title: string): number =>
  Math.max(...whatKeys(what).flatMap((k) => titleKeys(title).map((t) => { const a = [...k].length, b = [...t].length; return Math.min(a, b) / Math.max(a, b, 1); })), 0);
/** 最像的最多列几件 */
const NEAR_MAX = 5;
/** 意思像（向量）要多像才算候选：照联想片段的门槛（recall.ts 的 MOMENT_COS，11-01 拿真实联想校准的） */
const LIKE_MEANING_COS = MOMENT_COS;
/** 意思像最多拿几件 */
const LIKE_MEANING_TOP = 3;
/** 线索转向量最多等多久：和联想一样 1.5 秒，超时就只比名字 */
const LIKE_MEANING_MS = 1500;
/** 新建时「以前零碎提过」最多说几件 */
const MENTION_MAX = 3;
/** 「以前零碎提过」按全文找时，名字至少几个字 */
const MENTION_FTS_MIN = 3;
/** 事件记忆记日志用（hhd 给的）：人物卡导出出错、like 按意思找出错走 warn；like 按意思找到的候选（余弦）走 info */
export interface MemLog { warn(msg: string, data: Record<string, unknown>): void; info?(msg: string, data: Record<string, unknown>): void }
/** 按意思找的结果：几件像的（事件编号、余弦），或者这次没找成 */
export type LikeMeaning = { hits: Array<{ id: string; cos: number }> } | { failed: true };
/** my_likes 一页最多约这么多字（整份输出，含组标题和末尾那句） */
const MY_LIKES_PAGE = 4000;

/** 新建时记进理由里的「以前提过」编号（工作单第 9 节从这里读出来） */
const MENTIONED = "；以前提过：";

/** 撤回后留档的批次名里带的记号（store.ts 的 REVERTED）：工作单认白天记的喜好时不算撤回的 */
const REVERTED_MARK = "~reverted@";
/** 写了这些之后立刻重新导出人物卡和近况（P4：夜里第 10 步就要读到新卡）；mem_day_done：做完一天，现算段跟上这一天写的事 */
const EXPORT_AFTER: ReadonlySet<WriteOp> = new Set<WriteOp>(["mem_entity_upsert", "mem_entity_merge", "mem_entity_drop", "mem_person_set", "mem_quote_pin", "mem_day_done"]);
/**
 * 写了这些，现算段（我们的大事、近况）会变，但不当场导出（夜里几百次写，每次全导一遍太贵）：只记下要导出，
 * MemChores 每 30 秒那一下导出（flushPeople）；mem_day_done 当场导出
 */
export const PEOPLE_DIRTY_AFTER: ReadonlySet<WriteOp> = new Set<WriteOp>([
  "mem_event_create", "mem_event_update", "mem_entry_add", "mem_entries_add", "mem_entry_correct", "mem_entity_tag", "mem_merge", "mem_split", "mem_supersede", "mem_retire",
]);
/** 导入的批次：beginImport 的 import:<份>、手工导入（setImporting）的 import（裁定 R1）——写人物卡不等批 */
const isImportBatch = (b: string): boolean => b === "import" || b.startsWith("import:");

/** 工作单「太大的事」：直接挂着超过这么多条，或至少这么多条又拖了这么多天，就提醒拆成子事件 */
const SPLIT_ENTRIES = 40;
const SPLIT_MIN = 15;
const SPLIT_DAYS = 14;

export class EventMemory {
  readonly store: EventStore;
  readonly index: MemIndex;
  readonly recall: EventRecall;
  readonly tz: string;
  private readonly now: () => number;
  private batch: string | null = null;
  private importing = false;
  private importBatch: string | null = null;
  /** 这一份导入写的人物卡字段一律等人批（beginImport 的 forcePending：迁移时要主人先看过的第一版卡，P24） */
  private importForcePending = false;
  /** 人物卡、近况导出到哪（hhd：<工作区>/ledger/people）；没配就不导出 */
  private readonly peopleDir: string | null;
  /** 上一次导出人物卡出的错；成功了清掉 */
  peopleExportError: string | null = null;
  private readonly log: MemLog | null;
  /** 人物卡切过去了没有（R33、R34）：hhd 看工作区里退役的档案收了没有；每次问都重看 */
  private readonly peopleActive: () => boolean;
  /** 事件、经过写过、人物卡还没跟着导出（PEOPLE_DIRTY_AFTER） */
  private peopleStale = false;

  /** 配了向量服务没有（没配 = 只有全文，like 不按意思找，也不算出错） */
  private readonly vectors: boolean;

  /**
   * peopleTemplate：人物卡模板（HH 配置 memory.people.template，parseTemplate 校验过）；没给就不开人物卡——
   * 写字段、钉原话都拒，导出什么都不写（near.md 也不写），card()、near() 是空的。
   * peopleActive：人物卡切过去了没有（迁移以后、旧的人物档案收进档案那一刻起是 true；不给就一直是 true）。
   * 没切的时候：夜里不能写人物卡（导入照写，迁移在切之前跑，R33）、工作单第 8 节没有人物卡那一段、
   * 访客卡和指路照旧用旧档案（storedCard 是 null，R34）。导出、card()、recall_person 不管切没切。
   */
  constructor(o: { db: Db; embedder: Embedder | null; now?: () => number; tz: string; peopleDir?: string; peopleTemplate?: PeopleTemplate; peopleActive?: () => boolean; log?: MemLog }) {
    this.now = o.now ?? Date.now;
    this.tz = o.tz;
    this.vectors = o.embedder !== null;
    this.peopleDir = o.peopleDir ?? null;
    this.peopleActive = o.peopleActive ?? (() => true);
    this.log = o.log ?? null;
    this.store = new EventStore(o.db, this.now, o.tz, { peopleTemplate: o.peopleTemplate ?? null });
    this.index = new MemIndex(o.db, o.embedder, this.now);
    this.store.onReindex = (ref) => this.index.forget(ref);
    this.recall = new EventRecall({ store: this.store, index: this.index, now: this.now, tz: o.tz });
  }

  // ---------- 读 ----------
  /** touch=false：翻了不留痕迹（记忆体检），不算碰过、也不算进被想起的次数 */
  remember(cue: string, o: { who?: string; from?: string; to?: string; budget?: number; region?: string; touch?: boolean } = {}): Promise<string> {
    const r = o.from || o.to ? this.range(`${o.from ?? "2000-01-01"}~${o.to ?? fmtIso(this.now(), this.tz)}`) : null;
    // 不认识的人：照样想，只是不按人筛，并且说一声
    const who = o.who && this.store.entity(o.who) ? o.who : undefined;
    const note = o.who && !who ? M.remember.unknownWho(o.who) : "";
    return this.recall.cluster(cue, {
      ...(o.budget ? { budget: Math.min(o.budget, 4000) } : {}), ...(who ? { who } : {}),
      ...(r ? { from: r.from, to: r.to } : {}), ...(o.region ? { region: o.region } : {}), ...(o.touch === false ? { touch: false } : {}),
      header: M.recall.assocHeader,
    }).then((t) => note + (t.replace(B.forms.rememberHead, "").trim() ? t : M.remember.nothing(cue)));
  }

  /** recall_person：这个人的卡（只有公开的部分；主人只给一行指路）+ 最近几件事 */
  recallPerson(who: string, n?: number, o: { touch?: boolean } = {}): string {
    return this.recall.person(who, Math.min(n ?? 5, 10), RECALL_PERSON_BUDGET, { card: true, ...(o.touch === false ? { touch: false } : {}) });
  }

  recallEvent(ref: string, o: { from?: string; to?: string; region?: string; clearing?: boolean; touch?: boolean } = {}): string {
    const r = o.from || o.to ? this.range(`${o.from ?? "2000-01-01"}~${o.to ?? fmtIso(this.now(), this.tz)}`) : null;
    return this.recall.event(ref, { ...(r ? { from: r.from, to: r.to } : {}), ...(o.region ? { region: o.region } : {}), ...(o.clearing === false ? { clearing: false } : {}), ...(o.touch === false ? { touch: false } : {}) });
  }

  recallPeriod(when: string, o: { to?: string; who?: string; minImportance?: number; page?: number } = {}): string {
    const r = this.range(o.to ? `${when}~${o.to}` : when);
    if (!r) return M.recallPeriod.badRange(when);
    return this.recall.period(r, { ...(o.who ? { who: o.who } : {}), ...(o.minImportance !== undefined ? { minImportance: o.minImportance } : {}), ...(o.page ? { page: o.page } : {}) });
  }

  reverse(ref: string): string { return this.recall.reverse(ref); }

  /** 按意思找原话（原话层：HH 的原话 + 导入的 Honcho 旧原话 + 笔记）；没找到返回空字符串 */
  /**
   * 原话库里找原话：先逐字、再按意思。
   * olderOnly：中央记忆那边已经逐字找过了，这里只补中央记忆以外的（切过来以前的、别处导入的），也只要逐字对上的
   */
  async quotes(q: string, o: { who?: string; limit?: number; olderOnly?: boolean } = {}): Promise<string> {
    const said = (x: { who: string }) => !o.who || speaker(x.who).includes(o.who.toLowerCase());
    let rows: Array<{ id: number; at: number; who: string; channel: string; text: string }>;
    if (o.olderOnly) {
      const words = q.split(/\s+/).filter(Boolean);
      if (!words.length) return "";
      rows = all<{ id: number; at: number; who: string; channel: string; text: string }>(this.store.db,
        `SELECT id, at, who, channel, text FROM mem_quote WHERE src != 'central' AND ${words.map(() => "text LIKE ?").join(" AND ")} ORDER BY at DESC LIMIT 200`,
        ...words.map((w) => `%${w}%`)).filter(said);
    } else {
      const hits = (await this.index.search(q, { limit: 40, kinds: ["quote"] })).filter((h) => h.fts || (h.cos ?? 0) >= 0.3);
      rows = hits.map((h) => this.index.quote(h.ref)).filter((x): x is NonNullable<typeof x> => !!x && said(x));
    }
    if (!rows.length) return "";
    return rows.slice(0, o.limit ?? 12).map((x) => M.quotes.line(x.id, fmtTime(x.at, this.tz), x.who, x.channel, x.text.length > 500 ? x.text.slice(0, 500) + M.quotes.cut : x.text)).join("\n");
  }

  /** 某一天（她的一天从 4 点起）原话层里的原话，按时间；没有返回空字符串 */
  quotesDay(day: string, o: { who?: string; limit?: number } = {}): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
    const w = this.dayWindow(day);
    const rows = all<{ id: number; at: number; who: string; channel: string; text: string }>(this.store.db,
      "SELECT id, at, who, channel, text FROM mem_quote WHERE at BETWEEN ? AND ? AND src != 'central' ORDER BY at", w.from, w.to)
      .filter((x) => !o.who || speaker(x.who).includes(o.who.toLowerCase()));
    if (!rows.length) return "";
    return rows.slice(-(o.limit ?? 80)).map((x) => M.quotes.dayLine(x.id, fmtTime(x.at, this.tz), x.who, x.channel, x.text.length > 500 ? x.text.slice(0, 500) + M.quotes.dayCut : x.text)).join("\n");
  }

  range(s: string): Range | null { return parseRange(s, this.now(), this.tz); }

  /**
   * 一个人或群的卡（名字、别名、person_key、编号都认）；viewer 是看的人的 person_key，null 只给公开的。
   * 现算段按现在现算（近况的窗口按她的一天）。不认识、不出卡（规则同导出：没存着字段、重要度又不够）、卡是空的、没开人物卡，返回空字符串
   */
  card(who: string, o: { viewer: string | null }): string {
    const t = this.store.entity(who);
    return t ? renderCard(this.store, t, { viewer: o.viewer, now: this.now(), tz: this.tz }) : "";
  }

  /**
   * 人物卡切过去了（peopleActive）、名单上这个人（person_key，一字不差）在库里又存着卡（他自己看得到的字段或钉的原话，不只是现算的两段），
   * 就给他的实体和导出的文件（相对工作区），不然 null（R34）。没切以前旧档案还是真的：迁移那一跑写了一半的卡（公开的字段还在等批）
   * 不顶掉旧档案，访客卡和指路一起在切的那一刻换（部署本身、迁移本身都不改变她的行为）。
   * 只查印象表、不渲染（每条渠道消息都要问一次）；要附卡再用 sectionsOf 渲染。没开人物卡也是 null
   */
  storedCard(key: string): { entity: EntityRow; path: string } | null {
    if (!this.store.peopleTemplate || !this.peopleActive()) return null;
    const t = this.store.entities().find((e) => e.person_key === key);
    return t && this.store.impressions(t.id).some((r) => visibleTo(r, key)) ? { entity: t, path: cardPath(t) } : null;
  }

  /** 卡的各段（viewer 看的那一面，不带文件头那两行），附进叫醒她的话里用；不出卡、看得到的是空的就是空数组 */
  sectionsOf(entity: EntityRow, viewer: string | null): string[] {
    return cardSections(this.store, entity, { viewer, now: this.now(), tz: this.tz });
  }

  /** 人物近况（出卡的人和群现算的近况）；没开人物卡是空字符串 */
  near(): string { return renderNear(this.store, { now: this.now(), tz: this.tz }); }

  /**
   * 把人物卡和近况导出到 peopleDir（P4）。没配目录、没开人物卡（没有模板）返回 null、不碰目录；
   * 出错不抛（写路径上不能因为导出失败而失败），记在 peopleExportError、返回 null
   */
  exportPeople(): { written: string[]; removed: string[] } | null {
    if (!this.peopleDir || !this.store.peopleTemplate) return null;
    try {
      const r = exportPeople(this.store, this.peopleDir, { now: this.now(), tz: this.tz });
      this.peopleExportError = null;
      this.peopleStale = false;
      return r;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 第一次出错（或换了个错）当场记：夜里写的时候坏了、后来又好了，10 分钟那次就看不到了；一样的错不再记（一晚上几百次写）
      if (msg !== this.peopleExportError) this.log?.warn("people export failed", { error: msg.slice(0, 300) });
      this.peopleExportError = msg;
      return null;
    }
  }

  /** 事件、经过写过、人物卡还没跟着导出（导出成功就清掉；出错留着，下一次再导） */
  get peopleDirty(): boolean { return this.peopleStale; }

  /** MemChores 每 30 秒一次：事件、经过写过（peopleDirty）就导出一次人物卡和近况 */
  flushPeople(): void { if (this.peopleStale) this.exportPeople(); }

  /** 主线回复里引用了编号 = 碰过（15.5） */
  cited(text: string, region = "main"): string[] {
    const ids = [...new Set([...text.matchAll(/\b([en]\d{4,5})\b/g)].map((m) => m[1]!))]
      .filter((id) => (id.startsWith("e") ? this.store.event(id) : this.store.entry(id)));
    for (const id of ids) this.store.touch(id, "cite", region);
    return ids;
  }

  // ---------- 写（夜里、导入） ----------
  writable(region?: string): boolean { return this.batchFor(region) !== null; }
  get currentBatch(): string | null { return this.batchFor(); }

  /** 写进哪一批：导入者写导入批次，海马写夜里那一跑；没指明的（命令行、测试）先夜里、再导入 */
  batchFor(region?: string): string | null {
    const imp = this.importing ? this.importBatch : null;
    if (region === "importer") return imp;
    if (region === "hippocampus") return this.batch;
    const st = region ? this.stages.get(region) : undefined;
    if (st) return st.batch;
    return this.batch ?? imp;
  }

  /** 夜里引擎每一段睡眠一个 region → 一批：这一段单独提交、单独撤回；mem_day_done 只记下，落地时才标 */
  private stages = new Map<string, { batch: string; days: string[] }>();

  beginStage(region: string, batch: string): void {
    this.store.openBatch(batch);
    this.stages.set(region, { batch, days: [] });
  }

  /** 提交这一段的批；返回这一段 mem_day_done 记下的日子（不标完成，等 markDays） */
  commitStage(region: string): { days: string[] } | null {
    const st = this.stages.get(region);
    if (!st) return null;
    this.store.commitBatch(st.batch);
    this.stages.delete(region);
    return { days: st.days };
  }

  /** 这一段没成功：只撤回它自己的批 */
  revertStage(region: string): { reverted: number; conflicts: string[] } | null {
    const st = this.stages.get(region);
    if (!st) return null;
    const r = this.store.revertBatch(st.batch);
    this.stages.delete(region);
    this.exportPeople();
    return r;
  }

  /** 这一段开着的批写了几行（引擎拿来对「说了改事件库」和「实际改了」）；没开着就是 0 */
  stageOps(region: string): number {
    const st = this.stages.get(region);
    return st ? this.store.ops(st.batch).length : 0;
  }

  /**
   * 这一天这一跑从头来（重启、没落地，spec §6.4）：since（这一跑准备完的时刻）以后开的、这一天新睡眠各段的批次
   * （sleep:<日>/…，提交了的、还开着的）全部撤回，新的先撤；以前几夜的、撤回过的、~reverted@ 留档的不动。
   */
  revertDayStages(day: string, since: number): { reverted: number; conflicts: string[] } {
    let reverted = 0;
    const conflicts: string[] = [];
    for (const b of this.store.liveBatches(`sleep:${day}/`, since)) {
      const r = this.store.revertBatch(b);
      reverted += r.reverted;
      conflicts.push(...r.conflicts);
      for (const [region, st] of this.stages) if (st.batch === b) this.stages.delete(region);
    }
    this.exportPeople();
    return { reverted, conflicts };
  }

  /** 引擎落地后调：把这些日子标成整理完了 */
  markDays(days: string[]): void {
    for (const d of days) this.store.markDay(d);
  }

  beginNight(id: string): void {
    this.store.openBatch(id);
    this.batch = id;
  }

  /** 她说做完了的日子（mem_day_done）：这一跑提交时才记，撤回就不算 */
  private doneDays: string[] = [];

  /** 这一跑成功收尾：提交；她用 mem_day_done 标过的日子这时才记下 */
  commitNight(_day?: string | null): void {
    if (!this.batch) return;
    this.store.commitBatch(this.batch);
    for (const d of this.doneDays) this.store.markDay(d);
    this.doneDays = [];
    this.batch = null;
  }

  /** 这一跑没成功收尾：整批撤回 */
  revertNight(): { reverted: number; conflicts: string[] } | null {
    if (!this.batch) return null;
    const r = this.store.revertBatch(this.batch);
    this.batch = null;
    this.doneDays = [];
    this.exportPeople();
    return r;
  }

  /** hhd 启动：上次没收尾的批次（重启、崩溃）全部撤回；然后导出一次人物卡（撤没撤都导） */
  recoverOpenBatches(): string[] {
    const open = this.store.openBatches();
    for (const b of open) this.store.revertBatch(b);
    this.exportPeople();
    return open;
  }

  /** 手工导入（命令行、测试）：写进 "import" 这一批 */
  setImporting(on: boolean): void {
    this.importing = on;
    this.importForcePending = false;
    if (on) { this.importBatch = "import"; this.store.openBatch("import"); } else this.importBatch = null;
  }

  /** 导入：每个文件一批（import:<文件>），失败的那批单独撤回 */
  /** 导入时这一批对应的原文（出处编号 → 那一行原文）：条目只给出处、不给 full 时用它，保证一字不差 */
  private lineTexts = new Map<string, string>();

  /** forcePending：这一份里 mem_person_set 写的字段一律存成待批（不是导入平常的不等批），人批了才上卡；私密字段、钉原话照旧不等 */
  beginImport(key: string, lines: Map<string, string> = new Map(), o: { forcePending?: boolean } = {}): void {
    this.lineTexts = lines;
    this.importing = true;
    this.importBatch = `import:${key}`;
    this.importForcePending = o.forcePending === true;
    this.store.openBatch(this.importBatch);
  }
  /** 这一批写了几行（导入时判断是不是一条都没写） */
  importOps(): number { return this.importBatch ? this.store.ops(this.importBatch).length : 0; }

  endImport(ok: boolean): { reverted: number; conflicts: string[] } | null {
    this.lineTexts = new Map();
    this.importForcePending = false;
    const b = this.importBatch;
    this.importBatch = null;
    if (!b) return null;
    const r = ok ? (this.store.commitBatch(b), null) : this.store.revertBatch(b);
    this.exportPeople();
    return r;
  }

  write(op: WriteOp, a: Record<string, unknown>, region?: string): string {
    const out = this.apply(op, a, region);
    if (EXPORT_AFTER.has(op)) this.exportPeople();
    else if (PEOPLE_DIRTY_AFTER.has(op) && this.peopleDir && this.store.peopleTemplate) this.peopleStale = true;
    return out;
  }

  private apply(op: WriteOp, a: Record<string, unknown>, region?: string): string {
    const batch = this.batchFor(region);
    if (!batch) throw new Error(M.write.closed);
    // 人物卡切过去以前（R33）：夜里不写卡（旧的人物文件还是真的，照旧写它们的提案）；导入不拦——迁移就在切之前跑
    if ((op === "mem_person_set" || op === "mem_quote_pin") && !isImportBatch(batch) && !this.peopleActive()) throw new Error(M.write.peopleOff);
    const s = this.store;
    switch (op) {
      case "mem_event_create": { const e = s.createEvent(a, batch, String(a.reason ?? "")); return M.write.eventCreated(e.id, e.title); }
      case "mem_event_update": { const { id, reason, ...patch } = a; const e = s.updateEvent(String(id), patch, String(reason ?? ""), batch); return M.write.eventUpdated(e.id); }
      case "mem_entry_add": { const r = s.addEntry(this.withFull(a), batch, String(a.reason ?? "")); return r.existed ? M.write.entryExisted(r.entry.id) : M.write.entryAdded(r.entry.id, r.entry.event_id); }
      case "mem_entries_add": {
        const list = (a.entries as Array<Record<string, unknown>>) ?? [];
        const ok: string[] = [], had: string[] = [], bad: string[] = [];
        list.forEach((e, i) => {
          try {
            const r = s.addEntry(this.withFull({ ...e, event: e.event ?? a.event }), batch, String(a.reason ?? ""));
            (r.existed ? had : ok).push(r.entry.id);
          } catch (err) { bad.push(M.write.entryFailed(i + 1, err instanceof Error ? err.message : String(err))); }
        });
        return [M.write.entriesAdded(ok, had), ...bad].join("\n");
      }
      case "mem_entry_correct": { const { id, ...rest } = a; const n = s.correctEntry(String(id), rest, batch); return M.write.corrected(n.id, n.corrects); }
      case "mem_link": s.link(String(a.a), String(a.b), a.rel as Rel, String(a.note ?? ""), batch); return M.write.linked(a.a, a.rel, a.b);
      case "mem_unlink": return s.unlink(String(a.a), String(a.b), a.rel as Rel, String(a.reason ?? ""), batch) ? M.write.unlinked : M.write.noSuchLink;
      case "mem_merge": s.merge(String(a.keep), (a.others as string[]) ?? [], String(a.reason ?? ""), batch); return M.write.merged(a.keep);
      case "mem_split": {
        const under = a.under === true;
        const e = s.split(String(a.id), (a.entries as string[]) ?? [], a.event, batch, String(a.reason ?? ""), { under });
        return under ? M.write.splitUnder(e.id, e.title, a.id) : M.write.splitSame(e.id, e.title, a.id);
      }
      case "mem_supersede": s.supersede(String(a.old), String(a.by), String(a.reason ?? ""), batch); return M.write.superseded(a.old, a.by);
      case "mem_retire": s.retire(String(a.id), String(a.reason ?? ""), batch); return M.write.retired(a.id);
      case "mem_entity_upsert": { const t = s.upsertEntity(a, batch); return M.write.entityUpserted(t.id, t.name, kindLabel(t.kind), t.importance, t.aliases); }
      case "mem_entity_merge": {
        const t = s.mergeEntities(String(a.keep), (a.others as string[]) ?? [], String(a.reason ?? ""), batch);
        return M.write.entitiesMerged(t.name, t.aliases);
      }
      case "mem_entity_tag": {
        const t = s.tagEntity(String(a.name), String(a.to), String(a.role ?? "with"), batch, String(a.reason ?? ""));
        return M.write.entityTagged(t.name, a.to);
      }
      case "mem_entity_drop": { const t = s.dropEntity(String(a.name), String(a.reason ?? ""), batch); return M.write.entityDropped(t.name); }
      // 人物卡：导入那一跑不等批（R1），带 forcePending 的那一份一律等批；回话给只看人物材料的小 agent 看，自己说得清（P30）
      case "mem_person_set": return this.personSetReply(a, s.setSection(a, batch, this.approvalFor(batch)));
      case "mem_quote_pin": {
        const r = s.pinQuote(a, batch);
        if (r.existed) return M.write.alreadyPinned(r.row.id);
        const n = s.impressions(r.row.about).filter((x) => x.kind === "quote" && x.section === r.row.section).length;
        const who = s.entityById(r.row.about);
        const max = quoteMax(quoteSpec(s.peopleTemplate!, r.row.section)!, who ? s.isOwner(who) : false);
        const what = M.write.pinWhat(this.nameOf(r.row.about), r.row.section, n, max, r.row.visibility);
        return M.write.pinned(r.replaced, r.row.id, what);
      }
      case "mem_day_done": {
        const day = String(a.day ?? "").trim();
        if (!realDay(day)) throw new Error(M.write.badDay(day));
        // 事件、东西、人都要有重要度（以后的遗忘曲线按它算）：这一跑登记或挂上的，没打分不算做完
        const stage = [...this.stages.values()].find((x) => x.batch === batch);
        if (batch === this.batch || stage) {
          const bare = this.unrated(batch);
          if (bare.length) throw new Error(M.write.unrated(bare.slice(0, 30).map((t) => M.write.unratedItem(t.name, kindLabel(t.kind))), bare.length));
        }
        if (stage) { stage.days.push(day); return M.write.dayNoted(day); }
        if (batch === this.batch) this.doneDays.push(day); else s.markDay(day);
        return M.write.dayMarked(day);
      }
    }
  }

  /** 写人物卡字段等不等批：夜里照字段的类型（{}）；导入批次不按大改等批（R1）；beginImport 带了 forcePending 的那一批一律等人批（P24，迁移时要主人先看过的第一版卡） */
  private approvalFor(batch: string): { noApproval?: boolean; forcePending?: boolean } {
    if (!isImportBatch(batch)) return {};
    return batch === this.importBatch && this.importForcePending ? { forcePending: true } : { noApproval: true };
  }

  /** 人物卡要谁批：名单上的主人（store.owners），没有就是「人」 */
  private approver(): string {
    const o = [...this.store.owners].sort();
    return o.length ? ` ${o.join(M.personSet.approverOr)} ` : M.personSet.approverAnyone;
  }

  private nameOf(entityId: string): string { return this.store.entityById(entityId)?.name ?? entityId; }

  /** mem_person_set 的回话：改好了（这个字段多大 / 上限，卡合计多大 / 上限）、清掉了、存成待批（为什么、要谁批、怎么批）、没变；顺带驳回的待批也说一句 */
  private personSetReply(a: Record<string, unknown>, r: SectionWrite): string {
    const s = this.store, t = s.peopleTemplate!;
    const who = String(a.who ?? "").trim();
    const e = (r.row ? s.entityById(r.row.about) : undefined) ?? s.entityById(who) ?? s.entity(who)!;
    const section = String(a.section ?? "").trim();
    const what = M.personSet.what(e.name, section);
    const dropped = r.rejected.length ? M.personSet.dropped(r.rejected, s.impression(r.rejected[0]!)!.why) : "";
    if (r.pending) {
      const id = r.row!.id;
      if (r.unchanged) return M.personSet.unchangedPending(id, this.approver());
      const why = M.personSet.waitWhy[r.because!]({ section, name: e.name, lost: r.lost, of: r.of, cleared: !String(a.text ?? "").trim() });
      // protect（修订 C）：说一句怎么写不用批
      const tail = r.because === "protect" ? M.personSet.protectTail : "";
      return M.personSet.pending(id, why, this.approver(), tail, dropped);
    }
    if (r.unchanged) return M.personSet.unchanged;
    if (r.cleared) return M.personSet.cleared(what, dropped);
    const owner = s.isOwner(e), spec = specFor(fieldSpec(t, section)!, owner);
    const { total, cap } = cardTotal(t, owner, s.impressions(e.id, { status: ["current", "pending"] }));
    // 主人的 protect 字段（修订 C）：不叫她收别的字段，写给主人的提案
    const over = total > cap ? M.personSet.over(total - cap, keepHint(spec, owner, () => s.ownerNames())) : "";
    return M.personSet.saved(what, fieldUsage(spec, r.row!.text).text, total, cap, over, dropped);
  }

  // ---------- 人批待批的（hh mem approve / reject；P24） ----------
  /**
   * 命令行的一批：approve:<…>@<毫秒>（同一毫秒里重名就加后缀：出错撤回时不能撤到前一次的），写完提交；
   * 出错整批撤回（不留开着的批次）再抛出去。收尾以后导出人物卡
   */
  private cliBatch<T>(name: string, fn: (batch: string) => T): T {
    const s = this.store;
    const at = this.now();
    let batch = `approve:${name}@${at}`;
    for (let i = 2; s.batchState(batch) !== null; i++) batch = `approve:${name}@${at}-${i}`;
    s.openBatch(batch);
    let r: T;
    try { r = fn(batch); } catch (e) { s.revertBatch(batch); throw e; }
    s.commitBatch(batch);
    this.exportPeople();
    return r;
  }

  /** 批一个待批的：换上去（清掉的就清掉） */
  approve(id: string): string {
    const p = this.cliBatch(id, (b) => this.store.approveImpression(id, b));
    return B.eventsOwner.approved(id, this.nameOf(p.about), p.section, p.status === "current");
  }

  /** 驳回一个待批的：现行的不变 */
  reject(id: string, why: string): string {
    const p = this.cliBatch(id, (b) => this.store.rejectImpression(id, why, b));
    return B.eventsOwner.rejected(id, this.nameOf(p.about), p.section);
  }

  /** 批一个人的全部待批（P24：迁移后主人一次批一个人）：按编号一个个批，过时的（批不了的）跳过并列出来；一批 approve:<who>@<毫秒> */
  approveWho(who: string): string {
    const s = this.store;
    const t = s.entityById(who) ?? s.entity(who);
    if (!t) throw new Error(B.eventsOwner.unknownWho(who));
    const pend = s.pendingImpressions().filter((r) => r.about === t.id).sort((a, b) => byId(a.id, b.id));
    if (!pend.length) return B.eventsOwner.nonePendingFor(t.name);
    const done: ImpressionRow[] = [], skipped: string[] = [];
    this.cliBatch(who.trim(), (b) => {
      for (const p of pend) {
        try { done.push(s.approveImpression(p.id, b)); } catch (e) { skipped.push(B.eventsOwner.skippedItem(p.id, p.section, e instanceof Error ? e.message : String(e))); }
      }
    });
    return [
      done.length ? B.eventsOwner.approvedMany(done.length, done.map((p) => B.eventsOwner.item(p.id, p.section))) : B.eventsOwner.approvedNone,
      ...(skipped.length ? [B.eventsOwner.skippedMany(skipped.length, skipped)] : []),
    ].join("\n");
  }

  /** hh mem pending：一行一条——编号、谁·字段、丢了几行（新建、清掉）、新的内容、为什么；批不了的（过时）标出来 */
  pendingList(): string {
    const s = this.store;
    const rows = s.pendingImpressions().sort((a, b) => byId(a.id, b.id));
    if (!rows.length) return B.eventsOwner.nonePending;
    return rows.map((p) => {
      const cur = p.supersedes ? s.impression(p.supersedes) : undefined;
      const now = s.impressions(p.about).find((x) => x.kind === "section" && x.section === p.section)?.id ?? null;
      const change = !p.text ? B.eventsOwner.changeCleared : !cur ? B.eventsOwner.changeNew : (({ lost, of }) => B.eventsOwner.changeLost(lost, of))(lostLines(cur.text, p.text));
      // 私密的（private:<key>）不显示内容和为什么：批的人（主人）不该看到访客私聊里的东西（R24）
      const secret = p.visibility !== "all";
      return [
        B.eventsOwner.pendingHead(p.id, this.nameOf(p.about), p.section), change,
        ...(secret ? [B.eventsOwner.pendingSecret] : [
          ...(p.text ? [B.eventsOwner.pendingNew(p.text.split("\n").map((l) => l.trim()).filter(Boolean))] : []),
          ...(p.why.trim() ? [B.eventsOwner.pendingWhy(p.why.replace(/\s+/g, " ").trim())] : []),
        ]),
        ...(p.supersedes === now ? [] : [B.eventsOwner.pendingStale(p.supersedes, now)]),
      ].join(B.eventsOwner.pendingSep);
    }).join("\n");
  }

  // ---------- 白天自己记喜好（她自己当场改喜欢什么、烦什么，不等夜里替她判断） ----------
  /**
   * 喜欢上 / 烦上一个东西，或对喜欢 / 烦着的东西又有一下感受、腻了、又喜欢上了。
   * 每次调用自己一批（day-like:<时刻>），写完就提交；中途出错整批撤回再把错抛出去。不走 write()：夜里那一批开着也不进它，
   * 夜里那批撤回、hhd 启动撤回没收尾的批次都撤不到这里。只有名字完全一样的才自动接上：完全一样的有好几件、
   * 或者只是包含关系的，都什么都不写，返回候选让她用 event 指定（like / dislike 还能 new=true 单独新建）。
   * fix（改标题、一句话）、drop（记错了、不算数）也走这里找那件，见 likeEdit。
   */
  like(a: LikeArgs, o: { region?: string; meaning?: LikeMeaning } = {}): string {
    const { editing, adding, feeling, why, newTitle, newGist, what } = this.likeCheck(a, o.region);
    const s = this.store;
    const pool = this.likePool();
    const matches = (kind: "exact" | "near", st?: Stance) => pool.filter((e) => (!st || e.stance === st) && likeMatch(what, e.title) === kind);
    let target: EventRow | null = null;
    if (a.event) {
      const e = s.event(a.event.trim());
      if (!e) throw new Error(M.like.noEvent(a.event));
      if (!e.stance) throw new Error(M.like.notStance(e.id, e.title));
      if (e.status === "superseded") throw new Error(M.like.mergedAway(e.id, e.title, e.superseded_by));
      if (e.status === "retired") throw new Error(M.like.retired(e.id, e.title, a.how, e.stance));
      if (adding && e.stance !== a.how) throw new Error(M.like.wrongSide(e.id, e.title, stanceWord(e.stance), a.how, e.stance));
      target = e;
    } else if (!a.new) {
      // 只有完全一样的才自动接上；名字沾边的、挂着的东西叫这个名字的、意思像的，一律不写，列出来让她用 event 选，或者 new=true 单独新建
      const st = adding ? (a.how as Stance) : undefined;
      const hit = matches("exact", st);
      if (hit.length > 1) {
        return [M.like.severalExact(what), ...hit.map((e) => M.like.exactItem(e.title, e.id, likeLabel(e)))].join("\n");
      }
      target = hit[0] ?? null;
      // 还算数的里没有、对上的只有撤掉的那件：不是「第一次」，说清楚它撤掉了、要重新记就新记一件
      const gone = !target && !adding ? this.likeDropped(what, st)[0] : undefined;
      if (gone) throw new Error(M.like.nameRetired(what, gone.id, a.how, gone.stance));
      if (!target) {
        const near = this.likeCandidates(what, pool, st, o.meaning);
        if (near.length) {
          // fix / drop 是改和撤，不是「接上、再记一次」
          const verb = a.how === "fix" ? M.like.verbFix : M.like.verbDrop;
          const how = editing ? (near.length === 1 ? M.like.editOne(verb, near[0]!.e.id) : M.like.editWhich(verb))
            : near.length === 1 ? M.like.attachOne(near[0]!.e.id) : M.like.attachWhich;
          const list = near.map(({ e, alias }) => M.like.nearItem(e.title, e.id, likeLabel(e), alias)).join(M.like.nearSep);
          return M.like.nearest(list, how, adding);
        }
        if (editing) throw new Error(M.like.editNotFound(what));
        if (!adding) throw new Error(M.like.notFound(what));
      }
    } else {
      // new=true：同一边已经有完全一样的就不建（建了以后按名字记就一直对上两件）
      const same = matches("exact", a.how as Stance);
      if (same.length) throw new Error(M.like.sameExists(same.map((e) => M.like.sameItem(e.title, e.id)), same[0]!.id));
    }
    if (editing) return this.likeEdit(target!, a.how as "fix" | "drop", newTitle, newGist, why);
    const stance: Stance = target?.stance ?? (a.how as Stance);
    const title = `${stanceWord(stance)} ${stripLikePrefix(what)}`;
    if (!target && title.length > TITLE_MAX) throw new Error(M.like.whatTooLong(title, TITLE_MAX));
    const importance = a.importance ?? 3;
    // 另一种 stance 里还挂着的同一个东西：不动它，提一句
    const other = adding ? matches("exact", stance === "like" ? "dislike" : "like").filter((e) => e.status === "ongoing") : [];
    // 新建时同一边有撤掉了的同名：提一句，免得以为是那件回来了
    const was = !target ? this.likeDropped(what, stance)[0] : undefined;
    // 新建时查以前零碎提到过的（不拦，照建）：返回里说一句，编号记进这次新建的理由，夜里工作单带上去连
    const mentions = !target ? this.priorMentions(what) : [];

    const how = a.how as Exclude<LikeHow, "fix" | "drop">;
    const now = this.now();
    let out = this.dayBatch((batch) => {
      const reason = `like ${how}`;
      const ev = target ?? s.createEvent({
        title, summary: feeling, gist: clipGist(feeling), importance, why: importance >= 4 ? feeling : "", status: "ongoing", stance,
      }, batch, mentions.length ? `${reason}${MENTIONED}${mentions.map((x) => x.e.id).join(" ")}` : reason);
      // 不写出处：c:N 会让夜里工作单把那句原话当成已经进库、藏起来；夜里靠时间和批次（day-like:）认出是白天自己记的
      const r = s.addEntry({ event: ev.id, at: now, kind: "feeling", full: feeling, gist: clipGist(feeling), title: M.like.feltTitle[how][stance] }, batch, reason);
      // 状态：like / dislike / again 把腻了的改回来；over 改成腻了（已经腻了的只加感受）
      const to = how === "over" ? "done" : adding || how === "again" ? "ongoing" : null;
      const changed = target !== null && to !== null && target.status !== to;
      if (changed) {
        const why = to === "done" ? clipGist(feeling) : stance === "like" ? M.like.reasonLikeAgain : M.like.reasonDislikeAgain;
        s.updateEvent(ev.id, { status: to }, why, batch);
      }
      const cur = s.event(ev.id)!;
      const n = r.existed ? M.like.feltExisted(r.entry.id) : r.entry.id;
      return !target ? M.like.created(cur.id, cur.title, likeLabel(cur), cur.importance, n)
        : changed ? M.like.feltChanged(cur.title, cur.id, to, likeLabel(cur), n)
        : M.like.felt(cur.title, cur.id, likeLabel(cur), n);
    });
    if (mentions.length) out += M.like.mentioned(mentions.map((x) => M.like.mentionItem(x.e.title, x.e.id, x.n)));
    for (const e of other) out += M.like.otherSide(e.title, e.id, e.stance);
    if (was) out += M.like.wasDropped(was.title, was.id);
    return out;
  }

  /** like 的参数检查（不碰库）：不对就抛，按意思找之前先查，免得白等向量 */
  private likeCheck(a: LikeArgs, region?: string): { editing: boolean; adding: boolean; feeling: string; why: string; newTitle: string; newGist: string; what: string } {
    if (region !== undefined && !LIKE_REGIONS.test(region)) throw new Error(M.likeCheck.notNow);
    // fix / drop 是改错、撤掉：不记感受，要写 why；其余几种记的是这一下，feeling 必填
    const editing = a.how === "fix" || a.how === "drop";
    const feeling = (a.feeling ?? "").trim();
    const why = (a.why ?? "").trim();
    const newTitle = (a.title ?? "").trim(), newGist = (a.gist ?? "").trim();
    if (editing && !why) throw new Error(M.likeCheck.needWhy(a.how));
    if (!editing && !feeling) throw new Error(M.likeCheck.needFeeling);
    if (a.how === "fix" && !newTitle && !newGist) throw new Error(M.likeCheck.fixNeedsTitleOrGist);
    const what = a.what.trim();
    if (!a.event && !whatKeys(what).length) throw new Error(M.likeCheck.needWhat);
    const adding = a.how === "like" || a.how === "dislike";
    if (a.new && !adding) throw new Error(M.likeCheck.newOnlyAdding);
    if (a.new && a.event) throw new Error(M.likeCheck.newOrEvent);
    return { editing, adding, feeling, why, newTitle, newGist, what };
  }

  /** 还算数的喜欢 / 烦的事（腻了的也算） */
  private likePool(): EventRow[] {
    return all<EventRow>(this.store.db, "SELECT * FROM mem_event WHERE stance IS NOT NULL AND status NOT IN ('superseded','retired') ORDER BY id");
  }

  /** 撤掉了的（不算数）里名字完全一样的，最近撤的在前：不接、不复活，只拿来把话说清楚 */
  private likeDropped(what: string, st?: Stance): EventRow[] {
    return all<EventRow>(this.store.db, "SELECT * FROM mem_event WHERE stance IS NOT NULL AND status = 'retired' ORDER BY updated_at DESC, id DESC")
      .filter((e) => (!st || e.stance === st) && likeMatch(what, e.title) === "exact");
  }

  /**
   * 名字没有完全一样的时候的候选（只列不接），合并去重、按像的程度排，最多 NEAR_MAX 件：
   * 名字沾边（一方包含另一方）；挂着的东西的名字或别名和 what 一样（一件事可能挂好几个东西）；意思像（meaning，向量找的）
   */
  private likeCandidates(what: string, pool: EventRow[], st: Stance | undefined, meaning?: LikeMeaning): Array<{ e: EventRow; score: number; alias?: string }> {
    const scope = pool.filter((e) => !st || e.stance === st);
    const byId = new Map(scope.map((e) => [e.id, e]));
    const out = new Map<string, { e: EventRow; score: number; alias?: string }>();
    const add = (e: EventRow, score: number, alias?: string) => {
      const cur = out.get(e.id);
      const name = alias ?? cur?.alias;
      out.set(e.id, { e, score: Math.max(score, cur?.score ?? 0), ...(name ? { alias: name } : {}) });
    };
    for (const e of scope) if (likeMatch(what, e.title) === "near") add(e, 0.6 + 0.4 * closeness(what, e.title));
    const keys = whatKeys(what);
    if (scope.length) {
      const rows = all<{ event_id: string; name: string; aliases: string }>(this.store.db,
        `SELECT ee.event_id, t.name, t.aliases FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE ee.event_id IN (${scope.map(() => "?").join(",")})`, ...scope.map((e) => e.id));
      for (const r of rows) {
        const name = [r.name, ...(JSON.parse(r.aliases || "[]") as string[])].find((x) => keys.includes(normName(x)));
        if (name) add(byId.get(r.event_id)!, 1, name);
      }
    }
    if (meaning && "hits" in meaning) for (const h of meaning.hits) { const e = byId.get(h.id); if (e) add(e, h.cos); }
    return [...out.values()].sort((x, y) => y.score - x.score || x.e.id.localeCompare(y.e.id)).slice(0, NEAR_MAX);
  }

  /**
   * like 的完整版（工具走这里）：名字没有完全一样的时候，先按意思找一遍（向量，线索「what：feeling」，不留碰过的痕迹），
   * 再交给 like。没配向量就只比名字；出错、超时也只比名字，返回里说一句、记 warn
   */
  async likeWithMeaning(a: LikeArgs, o: { region?: string; timeoutMs?: number } = {}): Promise<string> {
    const c = this.likeCheck(a, o.region);
    const st = c.adding ? (a.how as Stance) : undefined;
    const need = this.vectors && !a.event && !a.new
      && !this.likePool().some((e) => (!st || e.stance === st) && likeMatch(c.what, e.title) === "exact")
      && !(!c.adding && this.likeDropped(c.what, st).length);
    const meaning = need ? await this.likeMeaning(c.what, c.feeling ? M.like.meaningCue(c.what, c.feeling) : c.what, st, o.timeoutMs ?? LIKE_MEANING_MS) : undefined;
    const note = meaning && "failed" in meaning ? `\n${M.like.noMeaning}` : "";
    try {
      return this.like(a, { ...(o.region !== undefined ? { region: o.region } : {}), ...(meaning ? { meaning } : {}) }) + note;
    } catch (e) {
      if (note && e instanceof Error) e.message += note;
      throw e;
    }
  }

  /** 按意思找：喜欢 / 烦的事和它们的经过（经过归到它的事件），过门槛的前 LIKE_MEANING_TOP 件；只读向量，不算碰过 */
  private async likeMeaning(what: string, cue: string, st: Stance | undefined, timeoutMs: number): Promise<LikeMeaning> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const found = await Promise.race([
        this.index.vector(cue, 60, { timeoutMs, kinds: ["event", "entry"] }),
        new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), timeoutMs); }),
      ]);
      if (found === "timeout") throw new Error(`no vector within ${timeoutMs}ms`);
      if (!found) throw new Error("embedding unavailable");
      const alive = new Set(this.likePool().filter((e) => !st || e.stance === st).map((e) => e.id));
      const best = new Map<string, number>();
      for (const h of found) {
        if (h.cos < LIKE_MEANING_COS) continue;
        const id = h.ref.startsWith("e") ? h.ref : this.store.entry(h.ref)?.event_id;
        if (id && alive.has(id)) best.set(id, Math.max(best.get(id) ?? 0, h.cos));
      }
      const hits = [...best].sort((x, y) => y[1] - x[1]).slice(0, LIKE_MEANING_TOP).map(([id, cos]) => ({ id, cos }));
      // 每个候选记一条（余弦值）：以后看门槛松不松用
      for (const h of hits) this.log?.info?.("like: meaning candidate", { what, event: h.id, cos: Math.round(h.cos * 1000) / 1000 });
      return { hits };
    } catch (e) {
      this.log?.warn("like: meaning search failed, comparing names only", { error: String(e).slice(0, 200) });
      return { failed: true };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 以前零碎提到过（新建时查，不拦）：不是喜欢 / 烦的事里，经过（或事件）挂着同名东西、或全文对得上 what 的，
   * 按事件归，提到的经过多的在前，最多 MENTION_MAX 件；被并掉、不算数的不算
   */
  private priorMentions(what: string): Array<{ e: EventRow; n: number }> {
    const s = this.store;
    const keys = whatKeys(what);
    const hits = new Map<string, Set<string>>();
    const hit = (eventId: string, entryId?: string) => {
      const x = hits.get(eventId) ?? new Set<string>();
      if (entryId) x.add(entryId);
      hits.set(eventId, x);
    };
    const ents = s.entities().filter((t) => [t.name, ...t.aliases].some((x) => keys.includes(normName(x)))).map((t) => t.id);
    if (ents.length) {
      const q = ents.map(() => "?").join(",");
      for (const r of all<{ id: string; event_id: string }>(s.db, `SELECT n.id, n.event_id FROM mem_entry_entity ne JOIN mem_entry n ON n.id = ne.entry_id WHERE ne.entity_id IN (${q})`, ...ents)) hit(r.event_id, r.id);
      for (const r of all<{ event_id: string }>(s.db, `SELECT event_id FROM mem_event_entity WHERE entity_id IN (${q})`, ...ents)) hit(r.event_id);
    }
    // 全文只认 3 个字以上的（去掉括号引号空白后数）：两个字的「会长」会把「社会长期主义」也算进来
    const words = [...new Set([what, what.replace(BRACKETS, ""), stripLikePrefix(what)].map((x) => x.trim()))].filter((x) => [...normName(x)].length >= MENTION_FTS_MIN);
    for (const w of words) {
      for (const r of all<{ ref: string }>(s.db, "SELECT ref FROM mem_fts WHERE ref NOT LIKE 'q%' AND text LIKE ? ESCAPE '\\'", `%${w.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)) {
        if (r.ref.startsWith("e")) hit(r.ref);
        else { const n = s.entry(r.ref); if (n) hit(n.event_id, n.id); }
      }
    }
    return [...hits].map(([id, ns]) => ({ e: s.event(id), n: Math.max(1, ns.size) }))
      .filter((x): x is { e: EventRow; n: number } => x.e !== undefined && !x.e.stance && x.e.status !== "superseded" && x.e.status !== "retired")
      .sort((x, y) => y.n - x.n || (y.e.ended_at ?? 0) - (x.e.ended_at ?? 0) || x.e.id.localeCompare(y.e.id)).slice(0, MENTION_MAX);
  }

  /**
   * 改错、撤掉（fix / drop）：不加感受经过，理由（why）写进那次改动。
   * fix 改标题和 / 或一句话：新标题按这件的 stance 补「喜欢 」「烦 」（和新建同一规则），前缀是另一边的就拒绝（白天不改 stance）；
   * drop 照 mem_retire 的意思标成不算数（还能找到；my_likes、「最近喜欢的」都不再列）
   */
  private likeEdit(e: EventRow, how: "fix" | "drop", title: string, gist: string, why: string): string {
    const s = this.store;
    if (how === "drop") {
      this.dayBatch((batch) => s.retire(e.id, why, batch));
      return M.likeEdit.dropped(e.id, e.title);
    }
    const stance = e.stance!;
    const own = stanceWord(stance);
    // 新标题开头的「喜欢」「烦」：后面还有 2 个字以上（「喜欢会长大人」「烦 鸡汤结尾」），或者是带空格、括号的格式前缀，就算写明了方向；
    // 只剩一个字的（「烦恼」「喜欢你」）是名字本身，按这件补前缀
    const word = new RegExp(`^\\s*(${stanceAlt(false)})`, "i").exec(title)?.[1];
    const marked = word !== undefined && (bareKey(title, false) !== null || likePrefix(false).test(title));
    if (marked && word.toLowerCase() !== own.toLowerCase()) {
      throw new Error(M.likeEdit.wrongSide(e.id, e.title, own, word, stance));
    }
    const t = !title ? e.title : marked ? title : `${own} ${stripLikePrefix(title)}`;
    if (t.length > TITLE_MAX) throw new Error(M.likeEdit.titleTooLong(t, TITLE_MAX));
    // 改出来和同一边另一件名字完全一样：两件同名以后按名字记就一直对上两件（和 new=true 同一个理）
    if (t !== e.title) {
      const twin = all<EventRow>(s.db, "SELECT * FROM mem_event WHERE stance = ? AND id != ? AND status NOT IN ('superseded','retired') ORDER BY id", stance, e.id)
        .find((o) => sameName(t, o.title));
      if (twin) throw new Error(M.likeEdit.twin(t, twin.title, twin.id));
    }
    const g = gist ? clipGist(gist) : e.gist;
    if (t === e.title && g === e.gist) return M.likeEdit.unchanged(e.id, e.title);
    this.dayBatch((batch) => s.updateEvent(e.id, { ...(t !== e.title ? { title: t } : {}), ...(g !== e.gist ? { gist: g } : {}) }, why, batch));
    const parts = [t !== e.title ? M.likeEdit.titleChanged(e.title, t) : "", g !== e.gist ? M.likeEdit.gistChanged(g) : ""].filter(Boolean);
    return M.likeEdit.fixed(e.id, likeLabel(s.event(e.id)!), parts);
  }

  /** 白天记喜好的每次调用自己一批（day-like:<时刻>，重名加后缀）：写完就提交，中途出错整批撤回再把错抛出去 */
  private dayBatch<T>(fn: (batch: string) => T): T {
    const s = this.store;
    const now = this.now();
    let batch = `day-like:${now}`;
    for (let i = 2; s.batchState(batch) !== null; i++) batch = `day-like:${now}-${i}`;
    s.openBatch(batch);
    try {
      const r = fn(batch);
      s.commitBatch(batch);
      return r;
    } catch (e) {
      s.revertBatch(batch);
      throw e;
    }
  }

  /**
   * 我喜欢 / 烦的全部（my_likes）：分四组，组里按最近一次感受倒序（没有感受按改动时间，和中期「最近喜欢的」同一个排法）。
   * 只读：不算碰过、不改联想计数。被并掉、不算数的不列；不是 ongoing 的（腻了、不烦了）算「以前」。
   * 一页最多约 MY_LIKES_PAGE 字：按组的顺序往下列，停在整行，末尾说还有几件、page=N 看下一页
   */
  myLikes(page = 1): string {
    const rows = all<EventRow & { felt: number; fat: number | null; fgist: string | null }>(this.store.db, `
      SELECT e.*, COALESCE(f.at, e.updated_at) felt, f.at fat, f.gist fgist FROM mem_event e
      LEFT JOIN mem_entry f ON f.id = (SELECT n.id FROM mem_entry n WHERE n.event_id = e.id AND n.kind = 'feeling' ORDER BY n.at DESC, n.id DESC LIMIT 1)
      WHERE e.stance IS NOT NULL AND e.status NOT IN ('superseded','retired') ORDER BY felt DESC, e.id`);
    const groups: Array<[string, (e: EventRow) => boolean]> = [
      [M.myLikes.likingHead, (e) => e.stance === "like" && e.status === "ongoing"],
      [M.myLikes.dislikingHead, (e) => e.stance === "dislike" && e.status === "ongoing"],
      [M.myLikes.likedHead, (e) => e.stance === "like" && e.status !== "ongoing"],
      [M.myLikes.dislikedHead, (e) => e.stance === "dislike" && e.status !== "ongoing"],
    ];
    // 一句话和最近那一下是同一句（白天新建、只记过一下的）：「最近一下」那段不重复写
    const items = groups.flatMap(([head, keep]) => rows.filter(keep).map((e) => ({
      head, line: M.myLikes.line(e.title, e.importance, e.id, e.gist, e.fat === null || e.fgist === e.gist ? "" : M.myLikes.lastFelt(fmtDay(e.fat, this.tz), e.fgist)),
    })));
    if (!items.length) return M.myLikes.none;
    const render = (xs: typeof items): string => {
      const out: string[] = [];
      xs.forEach((x, i) => { if (i === 0 || xs[i - 1]!.head !== x.head) out.push(`${out.length ? "\n" : ""}${x.head}`); out.push(x.line); });
      return out.join("\n");
    };
    // 分页：整行为单位往下装，留出末尾那句的位置；一行再长也至少放一件
    const FOOT = 40;
    const pages: Array<[number, number]> = [];
    for (let from = 0; from < items.length;) {
      let to = from + 1;
      while (to < items.length && render(items.slice(from, to + 1)).length + FOOT <= MY_LIKES_PAGE) to++;
      pages.push([from, to]);
      from = to;
    }
    const p = pages[Math.max(1, Math.floor(page)) - 1];
    if (!p) return M.myLikes.noPage(page, pages.length);
    const left = items.length - p[1];
    return render(items.slice(p[0], p[1])) + (left ? M.myLikes.more(left, Math.max(1, Math.floor(page)) + 1) : "");
  }

  /** 这一批登记的、挂到事件或经过上的人和东西里，还没打重要度的 */
  private unrated(batch: string): EntityRow[] {
    return all<{ id: string }>(this.store.db, `
      SELECT json_extract(key, '$.entity_id') id FROM mem_op WHERE batch = ? AND tbl IN ('mem_event_entity', 'mem_entry_entity') AND after IS NOT NULL
      UNION SELECT json_extract(key, '$.id') FROM mem_op WHERE batch = ? AND tbl = 'mem_entity' AND after IS NOT NULL`, batch, batch)
      .map((r) => this.store.entityById(r.id)).filter((t): t is EntityRow => Boolean(t) && t!.importance === null);
  }

  /** 没写 full、出处是导入的那一行：用原文 */
  private withFull(e: Record<string, unknown>): Record<string, unknown> {
    if (typeof e.full === "string" && e.full.trim()) return e;
    const refs = ((e.source as string[] | undefined) ?? []).filter((r) => this.lineTexts.has(r));
    if (!refs.length) {
      const asked = ((e.source as string[] | undefined) ?? []).join(M.write.noFullSep);
      throw new Error(M.write.noFull(asked));
    }
    return { ...e, full: refs.map((r) => this.lineTexts.get(r)!).join("\n") };
  }

  /**
   * 名单（memory/people/registry.json）里的人同步进事件库：名字、别名（表姐、Alex、Sam…）、person_key。
   * registry 的 key（如 aqing、li）只当 person_key、不当别名：两三个字母会在别的话里误认出人。没变化就不写。
   * 顺便认主人（privacy 是 owner 的 key）交给 store.owners（人物卡用：没有私密字段、合计上限大、原话默认公开）——
   * 只该用过了批准底子的名单（Brain 启动时给的那份）；owners: false 只同步人、不改主人（hh mem sync-people 读的是名单文件原样）。
   * 返回改了哪些人。
   */
  syncPeople(registry: Record<string, unknown>, o: { owners?: boolean } = {}): string[] {
    const s = this.store;
    // 先认主人：下面同步人半路出错（Brain 接住记日志）也不留着旧的
    let ownersChanged = false;
    if (o.owners !== false) {
      const next = new Set(Object.entries(registry).filter(([key, v]) => !key.startsWith("_") && typeof v === "object" && v !== null && (v as { privacy?: unknown }).privacy === "owner").map(([key]) => key));
      ownersChanged = next.size !== s.owners.size || [...next].some((k) => !s.owners.has(k));
      s.owners = next;
    }
    const changed: string[] = [];
    const batch = `sync:people:${new Date(this.now()).toISOString()}`;
    let opened = false;
    for (const [key, v] of Object.entries(registry)) {
      if (key.startsWith("_") || !v || typeof v !== "object") continue;
      const p = v as { name?: unknown; aliases?: unknown };
      const name = typeof p.name === "string" && p.name.trim() ? p.name.trim() : key;
      const aliases: string[] = [];
      for (const a of Array.isArray(p.aliases) ? p.aliases : []) {
        const x = typeof a === "string" ? a.trim() : "";
        if (x && x.toLowerCase() !== name.toLowerCase() && !aliases.some((y) => y.toLowerCase() === x.toLowerCase())) aliases.push(x);
      }
      const cur = s.entity(name) ?? s.entity(key) ?? aliases.map((a) => s.entity(a)).find(Boolean);
      // 撞上的是群、地方、东西：不把它改成人、也不给它名单 key（名单上的只认人）
      if (cur && cur.kind !== "person") continue;
      const known = new Set(cur ? [cur.name, ...cur.aliases].map((x) => x.toLowerCase()) : []);
      // 已经是别的人/东西的名字或别名的不收（upsert 会拒绝整个人）
      const missing = aliases.filter((a) => !known.has(a.toLowerCase()) && !isSelfName(a) && (!s.entity(a) || s.entity(a)!.id === cur?.id));
      if (cur && !missing.length && cur.person_key === key) continue;
      if (!opened) { s.openBatch(batch); opened = true; }
      s.upsertEntity({ name: cur?.name ?? name, kind: "person", aliases: missing, person_key: key }, batch);
      changed.push(cur?.name ?? name);
    }
    if (opened) s.commitBatch(batch);
    // person_key 变了，卡的文件名跟着变；主人变了，谁的卡文件带现算段跟着变（R35；启动时导出在认主人之前）
    if (changed.length || ownersChanged) this.exportPeople();
    return changed;
  }

  // ---------- 夜里的工作单 ----------
  /** 她的一天：本地 04:00 到第二天 04:00 */
  dayWindow(day: string): Range {
    const [y, m, d] = day.split("-").map(Number) as [number, number, number];
    const from = localToUtc(y, m, d, 4, 0, this.tz);
    return { from, to: from + DAY - 1 };
  }

  worklist(day: string): string {
    const w = this.dayWindow(day);
    const s = this.store;
    const out: string[] = [M.worklist.title(day, s.dayDone(day))];
    // 1. 今天的材料里还没进任何时间线的原话，按时间段（隔 45 分钟以上分开）聚团
    const used = new Set<string>();
    for (const r of all<{ source: string }>(s.db, "SELECT source FROM mem_entry WHERE at BETWEEN ? AND ? OR created_at >= ?", w.from - DAY, w.to + DAY, w.from)) {
      for (const x of JSON.parse(r.source) as string[]) used.add(x);
    }
    const qs = all<{ id: number; src: string; ref: string; at: number; who: string; channel: string; text: string }>(s.db,
      "SELECT * FROM mem_quote WHERE at BETWEEN ? AND ? AND src != 'note' ORDER BY at", w.from, w.to)
      .filter((q) => !used.has(`q${q.id}`) && !(q.src === "central" && used.has(`c:${q.ref}`)));
    const groups: Array<typeof qs> = [];
    for (const q of qs) {
      const g = groups[groups.length - 1];
      // 隔 30 分钟以上、或者这一团已经超过 90 分钟，就另起一团
      if (g && q.at - g[g.length - 1]!.at < 30 * 60_000 && q.at - g[0]!.at < 90 * 60_000) g.push(q); else groups.push([q]);
    }
    out.push(M.worklist.materialHead(qs.length, groups.length));
    out.push(M.worklist.materialHow(day));
    for (const g of groups.slice(0, 40)) {
      const who = [...new Set(g.map((q) => q.who.replace(selfTo(), "")))].join(M.worklist.groupWhoSep);
      const refs = g.map((q) => (q.src === "central" ? `c:${q.ref}` : `q${q.id}`));
      out.push(M.worklist.group(fmtTime(g[0]!.at, this.tz), fmtTime(g[g.length - 1]!.at, this.tz).slice(6), who, refs.length, refs.length > 6 ? M.worklist.groupRefsCut(refs.slice(0, 3).join(" "), refs.slice(-2).join(" ")) : refs.join(" ")));
      for (const q of g.slice(0, 3)) out.push(M.worklist.groupQuote(q.who, q.text.replace(/\s+/g, " ").slice(0, 80)));
    }
    if (groups.length > 40) out.push(M.worklist.moreGroups(groups.length - 40, day));
    // 2. 今天有进展的事件；6. 总结没跟上的
    const progressed = all<{ id: string; title: string; importance: number; n: number; last: number; updated_at: number }>(s.db, `
      SELECT e.id, e.title, e.importance, e.updated_at, count(n.id) n, max(n.created_at) last FROM mem_event e JOIN mem_entry n ON n.event_id = e.id
      WHERE n.at BETWEEN ? AND ? AND e.status != 'retired' GROUP BY e.id ORDER BY last DESC`, w.from, w.to);   // 不算数的不列（她白天撤掉的，夜里别去核它的状态）
    out.push(M.worklist.progressHead);
    out.push(progressed.length ? progressed.map((e) => M.worklist.progressLine(e.id, e.title, e.importance, e.n, e.updated_at, e.last)).join("\n") : M.worklist.progressNone);
    // 3. 疑似重复
    const recent = all<{ id: string; title: string }>(s.db, "SELECT id, title FROM mem_event WHERE status NOT IN ('superseded','retired') AND (updated_at >= ? OR ended_at >= ?)", w.from, w.from);
    const dups: string[] = [];
    for (const e of recent) {
      for (const h of this.index.fts(e.title, 8)) {
        if (!h.ref.startsWith("e") || h.ref === e.id) continue;
        const o = s.event(h.ref);
        if (!o || titleSim(e.title, o.title) < 0.5) continue;   // 标题真的像才算
        if ((s.event(e.id)!.stance ?? null) !== (o.stance ?? null)) continue;   // 喜欢 / 烦的事不和别的并：和当时那件事用 mem_link 连
        if (s.links(e.id).some((l) => l.a === o.id || l.b === o.id)) continue;   // 已经连过的不再推
        if (o && o.status !== "superseded" && o.status !== "retired" && !dups.some((d) => d.includes(e.id) && d.includes(o.id))) dups.push(M.worklist.dupLine(e.id, e.title, o.id, o.title));
      }
    }
    out.push(M.worklist.dupHead);
    out.push(dups.slice(0, 10).join("\n") || M.worklist.dupNone);
    // 4. 疑似关联：共享不常见的人或东西、时间相近、还没关联
    const pairs: string[] = [];
    for (const e of recent) {
      for (const t of s.entitiesOf(e.id)) {
        if ([N.owner.toLowerCase(), N.me.toLowerCase()].includes(t.name.toLowerCase())) continue;
        const evs = s.eventsOf(t.id);
        if (evs.length > 12) continue;
        for (const o of evs) {
          if (o.id === e.id || s.links(e.id).some((l) => l.a === o.id || l.b === o.id)) continue;
          if (Math.abs((o.ended_at ?? 0) - (s.event(e.id)!.ended_at ?? 0)) > 10 * DAY) continue;
          const line = M.worklist.pairLine(e.id, e.title, o.id, o.title, t.name);
          if (!pairs.some((p) => p.includes(e.id) && p.includes(o.id))) pairs.push(line);
        }
      }
    }
    out.push(M.worklist.pairHead);
    out.push(pairs.slice(0, 20).join("\n") || M.worklist.pairNone);
    // 7. 有纠错但总结没更新
    const fixes = all<{ id: string; title: string }>(s.db, `
      SELECT DISTINCT e.id, e.title FROM mem_event e JOIN mem_entry n ON n.event_id = e.id WHERE n.kind = 'correction' AND n.created_at > e.updated_at`);
    out.push(M.worklist.fixHead);
    out.push(fixes.map((e) => M.worklist.fixLine(e.id, e.title)).join("\n") || M.worklist.fixNone);
    // 最后一次进展正好在 14 天前那一天的：明天起不在中期视图「最近在发生的事」里了（替代事件线时代的 6b）
    const leaving = all<{ id: string; title: string; gist: string; importance: number }>(s.db, `
      SELECT id, title, gist, importance FROM mem_event WHERE status NOT IN ('superseded','retired') AND stance IS NULL AND ended_at BETWEEN ? AND ? ORDER BY ended_at`, w.from - 14 * DAY, w.to - 14 * DAY);
    out.push(M.worklist.leavingHead);
    out.push(leaving.map((e) => M.worklist.leavingLine(e.id, e.title, e.importance, e.gist)).join("\n") || M.worklist.leavingNone);
    // 7. 太大的事：直接挂着的经过太多、或拖得太久，拆成子事件（事件要有子事件的颗粒度）
    const big = all<{ id: string; title: string; n: number; first: number; last: number }>(s.db, `
      SELECT e.id, e.title, count(n.id) n, min(n.at) first, max(n.at) last FROM mem_event e JOIN mem_entry n ON n.event_id = e.id
      WHERE e.status NOT IN ('superseded','retired') AND e.stance IS NULL GROUP BY e.id
      HAVING n > ? OR (n >= ? AND max(n.at) - min(n.at) > ?) ORDER BY n DESC LIMIT 8`, SPLIT_ENTRIES, SPLIT_MIN, SPLIT_DAYS * DAY);
    out.push(M.worklist.bigHead(SPLIT_ENTRIES, SPLIT_DAYS));
    out.push(big.map((e) => {
      const kids = s.children(e.id).length;
      return M.worklist.bigLine(e.id, e.title, e.n, fmtDay(e.first, this.tz), fmtDay(e.last, this.tz), kids);
    }).join("\n") || M.worklist.bigNone);
    // 8. 人和东西：名单（经过里的 people 用这里的名字）、还没打重要度的
    const ents = s.entities();
    out.push(M.worklist.entitiesHead(ents.length));
    for (const k of [...ENTITY_KINDS, "project", "topic"]) {
      const xs = ents.filter((t) => t.kind === k).sort((a, b) => (b.importance ?? -1) - (a.importance ?? -1) || a.name.localeCompare(b.name));
      if (xs.length) out.push(M.worklist.entityKind(kindLabel(k), xs.map((t) => M.worklist.entityItem(t.name, t.importance, t.aliases.slice(0, 3)))));
    }
    const bare = ents.filter((t) => t.importance === null);
    if (bare.length) out.push(M.worklist.unratedNote(bare.length));
    // 最近常打交道、重要度还不到出卡门槛的（群友聊熟了该升、该有卡）
    // 人物卡还没开（R33）就不提：提了要她写卡，写卡会被拒
    const promote = this.peopleActive() ? promoteLine(s, w, this.tz) : "";
    if (promote) out.push(promote);
    // 第 8 节末尾：人物卡（P30：每个有卡的人一块，给只看人物材料的小 agent）；没开人物卡、还没切过去（R33）就没有
    const cards = this.peopleActive() ? cardDigest(s, w) : "";
    if (cards) out.push(`\n${cards}`);
    // 9. 喜欢 / 烦着的事（stance，进行中的）：今天材料里「口味」那几行先接到这里。
    // 11-04 起她白天用 like 自己当场记（主人：她自己改喜欢什么、不喜欢什么）：白天记过的照她的，夜里只补挂东西、连到当时那件事。
    // 白天记的认批次名 day-like:（撤回的留档批次不算；经过要还在、而且落在这一天）
    const liked = new Map(all<{ event_id: string; n: number }>(s.db, `
      SELECT n.event_id, count(*) n FROM mem_op o JOIN mem_entry n ON n.id = json_extract(o.key, '$.id')
      WHERE o.batch LIKE 'day-like:%' AND o.batch NOT LIKE '%${REVERTED_MARK}%' AND o.tbl = 'mem_entry' AND o.op = 'entry_add' AND o.after IS NOT NULL AND n.at BETWEEN ? AND ?
      GROUP BY n.event_id`, w.from, w.to).map((r) => [r.event_id, Number(r.n)]));
    // 白天新建的、还没挂任何人和东西的（不限哪天，挂上了才不标）
    // 新建时查到的「以前零碎提过」的事记在那次新建的理由里：带上编号，夜里去连
    const unattached = new Map(all<{ id: string; reason: string }>(s.db, `
      SELECT json_extract(o.key, '$.id') id, o.reason FROM mem_op o
      WHERE o.batch LIKE 'day-like:%' AND o.batch NOT LIKE '%${REVERTED_MARK}%' AND o.tbl = 'mem_event' AND o.op = 'event_create' AND o.after IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM mem_event_entity ee WHERE ee.event_id = json_extract(o.key, '$.id'))`)
      .map((r) => [r.id, (r.reason.split(MENTIONED)[1] ?? "").split(/\s+/).filter((x) => /^e\d+$/.test(x))]));
    // 进行中的都列；今天白天记过、白天新建还没挂的，腻了 / 不烦了也列
    const held = all<{ id: string; title: string; gist: string; stance: string; status: string; last: number }>(s.db, `
      SELECT e.id, e.title, e.gist, e.stance, e.status, COALESCE((SELECT max(n.at) FROM mem_entry n WHERE n.event_id = e.id AND n.kind = 'feeling'), e.updated_at) last
      FROM mem_event e WHERE e.stance IS NOT NULL AND e.status NOT IN ('superseded','retired') ORDER BY last DESC, e.id`)
      .filter((e) => e.status === "ongoing" || liked.has(e.id) || unattached.has(e.id));
    out.push(M.worklist.likesHead);
    out.push(M.worklist.likesHow);
    const HELD_MAX = 40;
    const heldLabel = (e: { stance: string; status: string }) => (e.stance === "like" ? (e.status === "ongoing" ? M.worklist.heldLiking : M.worklist.heldLiked) : (e.status === "ongoing" ? M.worklist.heldDisliking : M.worklist.heldDisliked));
    out.push(held.slice(0, HELD_MAX).map((e) => M.worklist.heldLine(e.title, heldLabel(e), e.id, e.gist, fmtDay(e.last, this.tz))
      + (liked.has(e.id) ? M.worklist.heldFeltToday(liked.get(e.id)) : "")
      + (unattached.has(e.id) ? M.worklist.heldUnattached : "")
      + (unattached.get(e.id)?.length ? M.worklist.heldMentioned(unattached.get(e.id)!) : "")).join("\n") || M.worklist.heldNone);
    if (held.length > HELD_MAX) out.push(M.worklist.heldMore(held.length - HELD_MAX));
    // 今天白天她自己撤掉的（like drop，不算数）：夜里别记回来、别另建同名的。认 day-like 批次里把事件改成 retired 的那一步（撤回的留档不算）
    const dropped = all<{ id: string; why: string }>(s.db, `
      SELECT json_extract(o.key, '$.id') id, o.reason why FROM mem_op o
      WHERE o.batch LIKE 'day-like:%' AND o.batch NOT LIKE '%${REVERTED_MARK}%' AND o.tbl = 'mem_event' AND o.op = 'retire'
        AND json_extract(o.after, '$.status') = 'retired' AND o.at BETWEEN ? AND ? ORDER BY o.id`, w.from, w.to)
      .map((r) => ({ e: s.event(r.id), why: r.why })).filter((r) => r.e?.status === "retired");
    if (dropped.length) {
      out.push(M.worklist.droppedHead);
      out.push(dropped.map((r) => M.worklist.droppedLine(r.e!.title, r.e!.id, r.why)).join("\n"));
      out.push(M.worklist.droppedHow);
    }
    out.push(M.worklist.finish(day));
    return out.join("\n");
  }

  // ---------- 导出 ----------
  exportJson(path: string): number {
    const s = this.store;
    const events = s.allEvents().map((e) => ({
      ...e, people: s.peopleOf(e.id),
      entities: s.entitiesOf(e.id).map((t) => ({ id: t.id, name: t.name, kind: t.kind, role: t.role, person_key: t.person_key })),
      links: s.links(e.id).map((l) => ({ a: l.a, b: l.b, rel: l.rel, note: l.note })),
      entries: s.entries(e.id).map((n) => ({ id: n.id, at: n.at, until: n.until, kind: n.kind, full: n.full, gist: n.gist, title: n.title, source: JSON.parse(n.source) as string[], corrects: n.corrects, people: s.entryPeople(n.id) })),
    }));
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ generated: new Date(this.now()).toISOString(), timezone: this.tz, events }, null, 1));
    renameSync(tmp, path);
    return events.length;
  }

  stats(): Record<string, number> {
    const n = (sql: string) => one<{ n: number }>(this.store.db, sql)?.n ?? 0;
    return {
      events: n("SELECT count(*) n FROM mem_event"), entries: n("SELECT count(*) n FROM mem_entry"), entities: n("SELECT count(*) n FROM mem_entity"),
      links: n("SELECT count(*) n FROM mem_link"), quotes: n("SELECT count(*) n FROM mem_quote"), vectors: n("SELECT count(*) n FROM mem_vec"),
      missingVectors: this.index.missingVectors(),
    };
  }
}

/** 标题像不像：两两相邻字的重合比例（Dice） */
export function titleSim(a: string, b: string): number {
  const na = a.replace(/\s+/g, "").toLowerCase(), nb = b.replace(/\s+/g, "").toLowerCase();
  if (Math.min([...na].length, [...nb].length) >= 2 && (na.includes(nb) || nb.includes(na))) return 1;
  const grams = (x: string) => { const c = [...x.replace(/\s+/g, "").toLowerCase()]; return c.length < 2 ? [c.join("")] : c.slice(1).map((ch, i) => c[i] + ch); };
  const A = grams(a), B = grams(b);
  const bs = [...B];
  let hit = 0;
  for (const g of A) { const i = bs.indexOf(g); if (i >= 0) { hit += 1; bs.splice(i, 1); } }
  return (2 * hit) / (A.length + B.length || 1);
}

/** 真实存在的一天：YYYY-MM-DD，没有 2 月 30 日这种 */
function realDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

function fmtIso(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}
export { fmtDay };
