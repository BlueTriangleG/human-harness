// 夜里考试的会话：考生（常驻层 / 查得到层）、判分、只在仓库那层查出处。
import type { StageSession, StageUsage } from "./session.ts";
import type { Snapshot } from "./record.ts";
import { matchWrites, type ExamConfig } from "./flow.ts";
import type { Layer, Question, QuestionIn, Verdict } from "./bank.ts";
import type { ExamAnswers, ExamGrades, QuestionsIn } from "./tools.ts";
import { P, S } from "../lang/index.ts";
import { centralRef } from "./things.ts";

export interface ExamSession extends StageSession {
  onAnswers(fn: (a: ExamAnswers) => string): void;
  onGrades(fn: (g: ExamGrades) => string): void;
  onQuestions(fn: (q: QuestionsIn) => string): void;
}

/** 开一个考试会话要的 */
export interface ExamOpen {
  id: string; model: string; opening: string; allowed: string[]; store: string;
  /**
   * 不让读的（相对工作区的路径；以 / 结尾是整个目录）：答案从注入里给的那几个文件（它们的旧版本）。
   * sleep/ 不管给不给都不让读（今晚的整理）
   */
  hide?: string[];
  /** false：Read / Grep / Glob 一律不让用（常驻那层的考生、判分、出暗题的）；不给 = 照 hide 和读拦截管 */
  reads?: boolean;
}

/** 这个文件明天会注入她的前缀：基础块，或者配置 exam.inject 点名的 */
export const injectedFile = (exam: Pick<ExamConfig, "baseBlocks" | "inject">, p: string): boolean =>
  exam.baseBlocks.includes(p) || matchWrites(exam.inject, p);

/** 没配预览脚本时的注入：文件原样拼起来（null = 删了） */
export const plainInjection = (files: Map<string, string | null>): string =>
  [...files].map(([p, t]) => `=== ${p} ===\n${t ?? P.EXAM_PREVIEW_GONE}`).join("\n\n");

/** 查得到那层的附录：改过、不注入的文件（这一轮那个状态的样子），一共最多 cap 个字，截了就说 */
export function appendixText(files: Map<string, string | null>, cap: number): string {
  if (!files.size) return "";
  const body = plainInjection(files);
  return `${P.EXAM_APPENDIX_HEAD}\n${body.length > cap ? `${body.slice(0, cap)}\n${P.EXAM_APPENDIX_CUT(cap)}` : body}`;
}

/**
 * 交的一道题有什么毛病（没毛病给 null）：出处里不能有私密的印象（isPrivate；题库和判分主人看得到，plan 3 A9）、
 * 重要度 1–5 的整数、今天的新要点不能直接放进只在仓库、标签不能全空、
 * 出处至少一条查得到（resolves：整理前的样子）；只在仓库那层的还要至少一条查得到的「路径:行」（只写路径、#序号、
 * 编号证明不了那段原文还在：checkArchive 照出处判，plan 3 A1）。段交的题、出暗题的交的题都照这个查（final fix M10）
 */
export function questionProblem(q: QuestionIn, resolves: (ref: string) => boolean, isPrivate?: (ref: string) => boolean): string | null {
  const refs = Array.isArray(q.sources) ? q.sources.map(String) : [];
  // 编号后面带「小节」、#锚点、:行号、空白的也算（切出开头那一段再问）
  if (isPrivate && refs.some((r) => isPrivate(r.trim().split(/[\s「#:]/)[0]!))) return P.QUESTION_REFUSED.private;
  if (!Number.isInteger(q.importance) || q.importance < 1 || q.importance > 5) return P.QUESTION_REFUSED.importance;
  if (q.isNew && q.layer === "archive") return P.QUESTION_REFUSED.newArchive;
  const tags = q.tags ?? { who: [], events: [], files: [], lessons: [] };
  if (![tags.who, tags.events, tags.files, tags.lessons].some((t) => Array.isArray(t) && t.length > 0)) return P.QUESTION_REFUSED.noTags;
  const sources = Array.isArray(q.sources) ? q.sources : [];
  if (!sources.some((r) => resolves(String(r)))) return P.QUESTION_REFUSED.noSource(sources.map(String));
  if (q.layer === "archive" && !sources.some((r) => pathRef(String(r)) !== null && resolves(String(r)))) return P.QUESTION_REFUSED.archiveLine;
  return null;
}

/** 考整理前要的：这一段开始时 proposed/ 里它那几个文件的样子（快照）和它能写的范围 */
export interface BeforeView { files: Snapshot; writes?: string[] }

/**
 * 一个文件整理前的内容（出处核对和整理前的注入预览都用这一个）：
 * 1. 这一段开始时的快照里有：用快照里的；
 * 2. 在这一段能写的范围里、快照里却没有：今天是它头一回提议这个文件，整理前就是工作区里的；
 * 3. 别的：今天的提案里有就用它（前面几段过了的改动，这一段动不了），没有就用工作区里的。
 * 都没有给 null
 */
export function beforeContent(path: string, v: BeforeView, read: { proposed(p: string): string | null; workspace(p: string): string | null }): string | null {
  if (v.files.has(path)) return v.files.get(path)?.text ?? null;
  if (v.writes && matchWrites(v.writes, path)) return read.workspace(path);
  return read.proposed(path) ?? read.workspace(path);
}

export interface ExamHost {
  /** 开一个考试会话：prefix = opening；store 是 "live" 或事件库拷贝的路径（整理前那次用）；allowed 是放行的工具 */
  open(o: ExamOpen): ExamSession;
  /**
   * 考场开头：基础块按配置顺序拼起来，exclude 里的块不放；tonight 里有的基础块用它（今晚前面过了的段改过的：明天的样子，
   * null = 删了，不放），别的用工作区里的
   */
  opening(exclude: string[], tonight?: Map<string, string | null>): string;
  /** 这些文件明天注入的样子；files 是 路径 → 内容（null = 删了）。配了预览脚本、它没跑成：抛错（理由在 message 里） */
  preview(o: { day: string; stage: string; state: "before" | "after"; files: Map<string, string | null> }): Promise<string>;
  /**
   * 出处查得到吗（#序号或 c:序号、q编号、e、n、t、i 编号、路径:行）；state=after 时路径先看 proposed、再看工作区。
   * 验证时考整理前给 files（这一段开始时的样子）和 writes（它的范围）：路径照 beforeContent 找
   */
  sourceExists(ref: string, o: { day: string; state: "before" | "after"; files?: Snapshot; writes?: string[] }): boolean;
  /** 一个文件整理前的内容（beforeContent）；整理前的注入预览用 */
  beforeText(day: string, path: string, v: BeforeView): string | null;
  /** 这个编号是私密的印象（visibility 不是 all）：不出题（题库和判分主人看得到）。不给 = 都不是私密的 */
  isPrivate?(ref: string): boolean;
  /**
   * 事件库里这个编号顶替了哪些（切换前 P4）：只认 at 这一次尝试自己的批里写的（修正轮 M1）——更正（经过 n 的 corrects）、
   * 并进来的事件（merge 把经过搬过来；supersede 不搬，不认）、印象新行顶掉的旧行（supersedes），一路往前认；
   * 更正、合并新建的编号动手前不知道，题挂在原来那条上也算挂在它上面。文件、没有事件库、查不到的给 []。不给 = 不认链接
   */
  parentsOf?(id: string, at: { day: string; stage: string; attempt: number }): string[];
  /**
   * 她前缀里从事件库渲染的那一块（HH 自己的中期视图，照那一天夜里的时刻算），常驻那层的考生看（exam.residentMemory，切换前 P6）：
   * store 是 "live"（整理后、或这一段没拷）或拷贝的路径（整理前）。她的前缀里本来就没有这一块（没开中期视图）给 ""；拼不出来抛错
   */
  memory?(o: { day: string; state: "after" | "before"; store: string }): string;
  /** 会话结束时报用量 */
  spent(id: string, model: string, u: StageUsage): void;
  timeoutMs: number;
}

/** 查得到那层的考生能用的想起事情的工具；recall（原话）不在里面：原话是只在仓库那层（spec §8.3 的偏离，final fix I7） */
export const SEARCH_TOOLS = ["remember", "recall_event", "recall_person", "recall_period"];

/** 开会话、等交卷：一轮结束没交就催一次；出错 / 结束了还没交 = 这次失败。不往外抛。 */
async function attempt<T>(host: ExamHost, open: ExamOpen, wake: string,
  hook: (s: ExamSession, set: (v: T) => void) => void): Promise<T | null> {
  let s: ExamSession;
  try { s = host.open(open); } catch { return null; }
  let got: T | null = null;
  let nudged = false;
  let finish!: () => void;
  const done = new Promise<void>((r) => { finish = r; });
  try { hook(s, (v) => { if (!got) got = v; }); } catch { return null; }
  // 会话结算时只报一次用量（成功、失败、超时都走这里；重开的是另一个会话）
  s.settled.then((r) => { try { host.spent(open.id, open.model, r.usage); } catch { /* 记账失败不挡考试 */ } }, () => {});
  s.onTurnEnd((ok) => {
    if (got || !ok) return finish();
    if (nudged) return finish();
    nudged = true;
    try { s.wake(P.EXAM_NUDGE); } catch { finish(); }
  });
  s.settled.then(finish, finish);
  try { s.wake(wake); } catch { finish(); }
  await done;
  try { await s.close(); } catch { /* 关不掉也算了 */ }
  return got;
}

async function twice<T>(id: string, run: (id: string) => Promise<T | null>): Promise<T | null> {
  return (await run(id)) ?? (await run(`${id}-r`));
}

/**
 * 题号的认法（回放第 1 次 F1）：考生、判分的有时把 q:2026-11-06/events/3 写成 2026-11-06/events/3。去掉头尾空白、
 * 去掉开头的 q:（大小写都认）以后比；对上的换回卷子上的题号，后面一律按卷子上的题号查
 */
export const idKey = (id: unknown): string => String(id ?? "").trim().replace(/^q:\s*/i, "");

/** 卷子上的题号：交上来的题号（带不带 q: 都行）→ 卷子上的那个；对不上给 undefined */
function paper(ids: string[]): (id: unknown) => string | undefined {
  const m = new Map(ids.map((id): [string, string] => [idKey(id), id]));
  return (id) => m.get(idKey(id));
}

/** 题号对不上、还没交的：回一句叫它照卷子上的题号再交（再交的跟前面的合在一起） */
function mismatch(unknown: string[], missing: string[], what: string): string {
  const parts = [
    ...(unknown.length ? [S.exam.unknownIds(unknown.join(S.marks.listSep))] : []),
    ...(missing.length ? [S.exam.notYet(what, missing.join(S.marks.listSep))] : []),
  ];
  return S.exam.resubmit(parts.join(S.marks.clauseSep));
}

export async function examineLayer(host: ExamHost, o: {
  id: string; model: string; opening: string; layer: "resident" | "searchable"; injection: string; questions: Question[]; store: string;
  /** 不让读的（ExamOpen.hide） */
  hide?: string[];
  /** 查得到那层的附录（改过、不注入的文件） */
  appendix?: string;
}): Promise<Map<string, string> | null> {
  const resident = o.layer === "resident";
  const allowed = resident ? ["exam_answers"] : [...SEARCH_TOOLS, "exam_answers"];
  const wake = P.EXAM_SITTER(o.layer, o.injection, o.questions, o.appendix ?? "");
  // 常驻那层什么都不让读；查得到那层照 hide 和读拦截
  const guard = { ...(o.hide ? { hide: o.hide } : {}), ...(resident ? { reads: false } : {}) };
  const onPaper = paper(o.questions.map((q) => q.id));
  return twice(o.id, (id) => attempt<Map<string, string>>(host, { id, model: o.model, opening: o.opening, allowed, store: o.store, ...guard }, wake, (s, set) => {
    // 这一个会话交的都合在一起（再交的覆盖同一道题前面的）
    const got = new Map<string, string>();
    s.onAnswers((a) => {
      if (o.questions.length > 0 && a.answers.length === 0) return S.exam.emptyAnswers;
      const unknown: string[] = [];
      for (const x of a.answers) {
        const k = onPaper(x.id);
        if (k === undefined) unknown.push(String(x.id));
        else got.set(k, x.answer);
      }
      if (got.size) set(got);
      const missing = o.questions.map((q) => q.id).filter((q) => !got.has(q));
      return unknown.length || missing.length ? mismatch(unknown, missing, S.exam.answered) : S.marks.received;
    });
  }));
}

/**
 * 出题人：只放行 exam_questions；给了 check 就逐道查（questionProblem），不合格的不收、回话里说为什么，
 * 一道合格的都没有算没交（催一次、换个会话再来）；两次都没交 = null。不往外抛。
 */
export async function setQuestions(host: ExamHost, o: { id: string; model: string; opening: string; wake: string; check?: (q: QuestionIn) => string | null }): Promise<QuestionIn[] | null> {
  const got = await twice(o.id, (id) => attempt<QuestionIn[]>(host, { id, model: o.model, opening: o.opening, allowed: ["exam_questions"], store: "live", reads: false }, o.wake, (s, set) =>
    s.onQuestions((q) => {
      if (q.questions.length === 0) return S.exam.emptyQuestions;
      const refused: string[] = [];
      const ok = q.questions.filter((x, i) => {
        const why = o.check?.(x) ?? null;
        if (why) refused.push(S.exam.refusedOne(i + 1, String(x.q ?? "").slice(0, 30), why));
        return !why;
      });
      if (!ok.length) return S.exam.noneTaken(refused.join(S.marks.clauseSep));
      set(ok);
      return refused.length ? S.exam.someTaken(ok.length, refused.join(S.marks.clauseSep)) : S.marks.received;
    })));
  return got;
}

export type Graded = { grades: Map<string, { verdict: Verdict; reason: string }>; layers: Map<string, Layer> };

/** 开着的判分会话：一轮结束、会话结束都转给眼下这一问 */
interface Live { s: ExamSession; dead: boolean; turn: ((ok: boolean) => void) | null; gone: (() => void) | null; on: ((g: ExamGrades) => string) | null }

function openLive(host: ExamHost, open: ExamOpen): Live {
  const s = host.open(open);
  const l: Live = { s, dead: false, turn: null, gone: null, on: null };
  s.onGrades((g) => (l.on ? l.on(g) : S.marks.received));
  // 会话结算时只报一次用量（判了几轮都是这一个会话）
  s.settled.then((r) => { try { host.spent(open.id, open.model, r.usage); } catch { /* 记账失败不挡考试 */ } }, () => {});
  const die = (): void => { l.dead = true; l.gone?.(); };
  s.settled.then(die, die);
  s.onTurnEnd((ok) => l.turn?.(ok));
  return l;
}

/** 在开着的会话上问一次：叫醒、等交卷；一轮结束没交就催一次；这一轮出错、会话结束了还没交 = null */
async function askLive<T>(l: Live, wake: string, got: () => T | null): Promise<T | null> {
  if (l.dead) return null;
  let nudged = false;
  await new Promise<void>((finish) => {
    l.gone = finish;
    l.turn = (ok) => {
      if (got() || !ok) return finish();
      if (nudged) return finish();
      nudged = true;
      try { l.s.wake(P.EXAM_NUDGE); } catch { finish(); }
    };
    try { l.s.wake(wake); } catch { finish(); }
  });
  l.turn = null;
  l.gone = null;
  return got();
}

/**
 * 一个判分会话，可以接着判好几轮（一段的重考和整理前那轮同一个会话判，省一个会话：final fix M3）。
 * 每一轮两次机会：会话坏了（这一轮没交、出错、结束了）就关掉，换一个新的会话（id 依次加 -r、-r2…）再判这一轮。
 * 不往外抛；用完要 close
 */
export function grading(host: ExamHost, o: { id: string; model: string; opening: string; hide?: string[] }): {
  grade(items: Array<{ q: Question; answer: string }>, askLayers: Question[]): Promise<Graded | null>;
  close(): Promise<void>;
} {
  let live: Live | null = null;
  let opens = 0;
  const idOf = (n: number): string => (n === 0 ? o.id : n === 1 ? `${o.id}-r` : `${o.id}-r${n}`);
  const drop = async (): Promise<void> => {
    const l = live;
    live = null;
    if (l) try { await l.s.close(); } catch { /* 关不掉也算了 */ }
  };
  return {
    async grade(items, askLayers) {
      let wake: string;
      try { wake = P.EXAM_GRADER(items, askLayers); } catch { return null; }
      for (let tries = 0; tries < 2; tries++) {
        if (live?.dead) await drop();
        if (!live) {
          try {
            live = openLive(host, { id: idOf(opens++), model: o.model, opening: o.opening, allowed: ["exam_grades"], store: "live", ...(o.hide ? { hide: o.hide } : {}), reads: false });
          } catch { continue; }
        }
        // 这一轮交的都合在一起（再交的覆盖同一道题前面的）；题号带不带 q: 都认，换回卷子上的
        let got: Graded | null = null;
        const graded: Graded = { grades: new Map(), layers: new Map() };
        const onPaper = paper(items.map((x) => x.q.id));
        const onAsk = paper(askLayers.map((q) => q.id));
        const l: Live = live;
        l.on = (g) => {
          if (items.length > 0 && g.grades.length === 0) return S.exam.emptyGrades;
          const unknown: string[] = [];
          for (const x of g.grades) {
            const k = onPaper(x.id);
            if (k === undefined) unknown.push(String(x.id));
            else graded.grades.set(k, { verdict: x.verdict, reason: x.reason });
          }
          for (const x of g.layers) {
            const k = onAsk(x.id) ?? onPaper(x.id);
            if (k === undefined) unknown.push(String(x.id));
            else graded.layers.set(k, x.layer);
          }
          // 一道都没对上（判分要判的题）：不算交了（一轮结束会催一次）
          if (graded.grades.size || graded.layers.size || !items.length) got = graded;
          const missing = items.map((x) => x.q.id).filter((q) => !graded.grades.has(q));
          return unknown.length || missing.length ? mismatch(unknown, missing, S.exam.graded) : S.marks.received;
        };
        const r = await askLive(l, wake, () => got);
        l.on = null;
        if (r) return r;
        await drop();
      }
      return null;
    },
    close: drop,
  };
}

/** 判一轮：开一个判分会话，判完就关 */
export async function grade(host: ExamHost, o: {
  id: string; model: string; opening: string; items: Array<{ q: Question; answer: string }>; askLayers: Question[];
  /** 不让读的（ExamOpen.hide） */
  hide?: string[];
}): Promise<Graded | null> {
  const g = grading(host, o);
  try { return await g.grade(o.items, o.askLayers); } finally { await g.close(); }
}

// 中央记忆的序号（#N、c:N）：things.ts 里，这里照旧导出
export { centralRef };

/** 出处里的「路径:行」（或「路径:起-止」）；别的写法（含 c:N）给 null */
export function pathRef(ref: string): { path: string; from: number; to: number } | null {
  if (centralRef(ref) !== null) return null;
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const from = Number(m[2]);
  return { path: m[1]!.trim(), from, to: Number(m[3] ?? m[2]) };
}

/** 一行最多喂给标记正则多少字（再长的后面原样留着：防她配的正则回溯卡住整个 hhd，修正轮 2 M1） */
export const MARK_RE_CHARS = 4000;
/** ignoreMarks 里写成正则的前缀；不带它的是字面的标记 */
export const MARK_RE = "re:";

/**
 * 去掉配置里要忽略的标记（exam.ignoreMarks，切换前 P5）：一行里每一处都去掉；没配给 undefined（照旧比）。
 * 默认是字面的（原样找、原样去）；写成 re:… 的才当正则（parseFlow 已经核过能编译），只喂这一行的前 MARK_RE_CHARS 个字
 */
export function markStripper(sources: readonly string[]): ((line: string) => string) | undefined {
  if (!sources.length) return undefined;
  const steps = sources.map((s): ((t: string) => string) => {
    if (!s.startsWith(MARK_RE)) return (t) => t.split(s).join("");
    const re = new RegExp(s.slice(MARK_RE.length), "gu");
    return (t) => (t.length > MARK_RE_CHARS ? t.slice(0, MARK_RE_CHARS).replace(re, "") + t.slice(MARK_RE_CHARS) : t.replace(re, ""));
  });
  return (line) => steps.reduce((t, step) => step(t), line);
}

/**
 * 整理后「路径:行」的出处还在不在（spec §8.3 只在仓库那层；final fix I3）：今晚没改的文件照旧看那一行在不在（exists）；
 * 今晚改过的：整理前那几行（去掉头尾空白、空行不算）每一行都还得出现在这个文件、或者今晚改过的哪个文件现在的样子里。
 * before 给 undefined = 不知道整理前的样子，照旧看那一行在不在；给 null = 整理前没有这个文件
 */
export function lineKept(o: {
  changed: ReadonlySet<string>; before(path: string): string | null | undefined; after(path: string): string | null; exists(ref: string): boolean;
  /** 比之前先去掉要忽略的标记（markStripper）：引的那几行、今晚改过的文件现在的样子，一行一行地 */
  strip?: (line: string) => string;
}): (ref: string) => boolean {
  const strip = o.strip ?? ((l: string) => l);
  return (ref) => {
    const r = pathRef(ref);
    if (!r || !o.changed.has(r.path)) return o.exists(ref);
    const was = o.before(r.path);
    if (was === undefined) return o.exists(ref);
    if (was === null || r.from < 1 || r.to < r.from) return false;
    const lines = was.replace(/\n$/, "").split("\n");
    if (lines.length < r.to) return false;
    const cited = lines.slice(r.from - 1, r.to).map((l) => strip(l).trim()).filter(Boolean);
    const now = [...o.changed].flatMap((p) => { const t = o.after(p); return t === null ? [] : [o.strip ? t.split("\n").map(o.strip).join("\n") : t]; });
    return cited.every((l) => now.some((t) => t.includes(l)));
  };
}

/**
 * 「只在仓库」那层不用考生：出处都查得到就是 right；一条出处都没有是 wrong。
 * 给了 kept（整理后那几轮）：出处照它看（lineKept：挪走的那行得还在今晚改过的文件里），不然照 sourceExists
 */
export function checkArchive(host: ExamHost, q: Question, o: { day: string; state: "before" | "after"; files?: Snapshot; writes?: string[] }, kept?: (ref: string) => boolean): Verdict {
  if (!q.sources.length) return "wrong";
  try { return q.sources.every((r) => (kept ? kept(r) : host.sourceExists(r, o))) ? "right" : "wrong"; } catch { return "wrong"; }
}
