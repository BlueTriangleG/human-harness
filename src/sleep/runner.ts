// 一夜怎么跑（spec §4、§6–§10）：对每个积压的日子（最旧的先）准备 → 按依赖和「改不改同一个文件」开段 →
// 每段交了 stage_done 马上验证（机械检查 + 各验证器）→ 不过带着问题重做一次 → 还不过推迟（依赖它的跟着推迟、记欠着）→
// 全天考试 → 拼报告 → 落地（核对脚本、finish）→ 标完成。
// 引擎只认配置里的段，不写任何一段的专门代码（spec §13）；用到 Brain 的地方都走 StageHost。
// 一个 SleepRunner 只跑一夜（再调 runNight 会抛错）：看门狗从 runNight 开始计时，runNight 返回时取消。
import { one, type Db } from "../store/db.ts";
import type { Logger } from "../log.ts";
import type { EventMemory } from "../memory/events/memory.ts";
import { P, S } from "../lang/index.ts";
import { saveLevel } from "./ladder.ts";
import { DEFAULT_WEIGHTS, units, type Budget, type Weights } from "./budget.ts";
import { conflict, matchWrites, runnable, type FlowConfig, type Personas, type StageSpec } from "./flow.ts";
import * as L from "./ledger.ts";
import { diff, recordPath, restore, snapshot, type MiniFs, type Snapshot, type StageRecord } from "./record.ts";
import type { StageSession, StageUsage } from "./session.ts";
import type { StageDone } from "./tools.ts";
import { bookkeeping, mechanical, type Precheck, type StageValidator, type ValidateCtx } from "./validate.ts";

import { pickFixer, snapDiff } from "./review.ts";
import { ruled, type CoordinatorLike, type Decision } from "./coordinator.ts";

/** 一段一次尝试在事件库里的批名（runner 开批、host 认这一次写的更正和合并都用它） */
export const stageBatch = (day: string, stage: string, attempt: number): string => `sleep:${day}/${stage}/${attempt}`;

export type OpenedStage = StageSession & {
  onDone(fn: (d: StageDone) => string): void;
  /**
   * 引擎把这次交的 stage_done 退回去了（当场核对没过，会话还开着）：这次不算交差（还能交去把关）；
   * questionsFor 是退回里点名要补题的那几处，exam_questions 这时只收挂在它们上面的。不给 = host 不管这些
   */
  bounced?(o: { questionsFor: string[] }): void;
  /** 这个会话还是当初开的那一个、还活着吗（StageSession.alive）；host 不给 = 不知道，当作活着 */
  alive?(): boolean;
};

export interface StageHost {
  flowHash: string;
  /** SOUL + common：所有段一样的开头（open 开会话时用） */
  prefix: string;
  /** id 既是会话 id 也是事件库的 region：sleep-<日>-<段>-<第几次>；allowed = 这一段的 tools + stage_done */
  open(o: { id: string; stage: StageSpec; day: string; allowed: ReadonlySet<string> }): OpenedStage;
  run(argv: string[], timeoutMs: number): Promise<{ code: number; out: string }>;
  /** 路径都相对工作区：sleep/<日>/proposed/…、sleep/<日>/flow/…、sleep/<日>/report.md */
  fs: MiniFs;
  mem: Pick<EventMemory, "beginStage" | "commitStage" | "revertStage" | "markDays" | "stageOps" | "revertDayStages"> | null;
  /** 这一段的 skill 页；找不到给 null */
  skillText(stage: StageSpec): string | null;
  materialText(day: string, names: string[], stage?: StageSpec): string;
  /** 叫醒这一段时接在材料后面的（比如挂在它要改的东西上的旧题）：只进叫醒的话，不进验证器拿到的材料；没有给 "" */
  wakeNotes?(day: string, stage: StageSpec): string;
  /**
   * 这一天这一段在题库里待定的题和 op 一共几条（考试夜才有）：多人模式里没改文件、没动事件库的尝试只有这里也是 0 才不请验证器
   * （交了题、改题、退休的照样要考，不然落地时不考就生效）。给了 attempt 只算这一次记的 op 和还没在过了的一次里考过的题
   * （最终评审 M4：打磨的那次什么都没改，不因为过了的第 1 次的题再考一遍；没过以后的重做照样考上一次交的题）
   */
  examPending?(day: string, stage: string, attempt?: number): number;
  db: Db;
  now(): number;
  /** 定时；返回取消 */
  later(fn: () => void, ms: number): () => void;
  log: Logger;
  /** 这一天报告最上面要加的几行（引擎外的事：比如把关结论回来时发起的那一段已经关了）；拼报告时放在最上面 */
  dayNotes?(day: string): string[];
  /** 这一段动手前拷的那份事件库的路径（考整理前用）；没拷（不写事件库）给 "live"。不给这个方法 = "live" */
  storeBefore?(day: string, stage: string): string;
  /**
   * 这一段的这一次尝试结束了（验没验、过没过、出没出错都调）：storeBefore 给出去的拷贝可以删了；
   * passed = 这一次过了没有（没过的那一次申请的改题、退休不落地），attempt 是第几次
   */
  attemptEnded?(day: string, stage: string, passed: boolean, attempt: number): void;
  /**
   * 这一段这一次在事件库里那一批的每一行变化（sleep/opsdiff.ts 的 batchDiff；批还开着也看得到）：专员 + 领导模式里给领导看。
   * cap = 最多多少字。没有事件库给一句说明
   */
  opsText?(day: string, stage: string, attempt: number, cap?: number, skip?: number): string;
  /**
   * 专员 + 领导模式才有：这个专员的会话开之前把事件库拷一份（写事件库的才拷），storeBefore 之后给的就是它；
   * 留到 attemptEnded（这个专员定了）才删，原地修的几轮都考同一份整理前
   */
  copyBefore?(day: string, stage: string, attempt: number): Promise<void>;
  /** 专员 + 领导模式才有：这一段这一次在事件库里新建的编号（e / n / t / i） */
  madeIn?(day: string, stage: string, attempt: number): Set<string>;
  /** 专员 + 领导模式才有：这一段这一次的批里第 skip 行以后碰过的编号（改的那一轮实际动了哪些事件、经过、人、印象） */
  touchedIn?(day: string, stage: string, attempt: number, skip?: number): string[];
  /** 专员 + 领导模式才有：编号后面带上一句标题（e、n、t；查不到只给编号） */
  idTitles?(ids: string[]): string[];
  /** 这一天落地了（finish 退出码 0）：stages 是过了验证的段 */
  landed?(day: string, stages: string[]): void;
  /** 这一天整天撤回、或者要从头整理（上一跑没收尾）：keep 是推迟了的段（它们的东西留着） */
  abandoned?(day: string, keep: string[]): void;
}

export interface RunnerOptions {
  validators: StageValidator[];
  /** 全天考试（第 2 份）：答错的题追到哪一段，那一段带着问题重做一次；notes 写进报告最上面 */
  finalCheck?: (day: string) => Promise<{ redo: Array<{ stage: string; problems: string[] }>; notes?: string[] }>;
  budget: Budget;
  watchdogMs: number;
  /** 一夜最多整理几天；Infinity = 不限 */
  maxDays: number;
  /** 花费换算系数；不给用默认的 */
  weights?: Weights;
  /** 多人模式（flow 写了 personasFile）：段由 persona 做，没过换另一个她修，最多 1 + maxFixRounds 次。不给 = 照旧两次 */
  personas?: Personas;
  /** 前额叶：每次尝试验完问它定过、重做还是推迟（照硬规矩收）。不给 = 照机械的规矩 */
  coordinator?: CoordinatorLike;
}

export interface NightResult {
  /** 这一晚记账那一行（sleep_run）的编号：Brain 往上记睡前睡后的周额度 */
  runId: number;
  landed: string[];
  deferredDays: string[];
  owed: Array<{ day: string; stage: string }>;
  /** aborted：外面叫停的（hhd 停机，abort()）；error：哪一天里抛了错，这一夜停在那里（前面落地的照算） */
  stoppedBy: "done" | "budget" | "watchdog" | "aborted" | "error";
  /** stoppedBy 是 error 时：出了什么错 */
  error?: string;
}

/** 一段在这一天的下场 */
export type Fate =
  | { kind: "passed"; done: StageDone }
  /** done：最后一次交的 stage_done（它说的拿不准、提案、毛病照样进报告） */
  | { kind: "deferred"; problems: string[]; done: StageDone | null }
  | { kind: "followed"; upstream: string }
  | { kind: "budget" }
  | { kind: "not-today"; why: string }
  | { kind: "aborted"; why: string }
  | { kind: "script"; code: number; out: string };

/** 多人模式：一段一次尝试的样子（报告「谁做的、谁审的」一节） */
interface Round {
  n: number; doer: string | null; reviewer: string | null; ok: boolean; problems: string[];
  /** keep：全天考试叫的重做没过，留着上一次过了的；abort：这一天中止了 */
  /** polish：都过了、前额叶要再修一次（这一次照样算过，再在它上面修一次，修不好留着这一次的） */
  decision: Decision | "polish" | "keep" | "abort"; by: "coord" | "rule"; skipped: boolean;
  /** polish 没做：为什么（绝对线、目标线、上限） */
  notDone?: string;
}
/** 多人模式：一段（或一次尝试）各花了多少单位：做的、审的、核依据、考试、前额叶 */
interface Cost { do: number; review: number; audit: number; exam: number; coord: number }
const NO_COST = (): Cost => ({ do: 0, review: 0, audit: 0, exam: 0, coord: 0 });
/** 给前额叶的简报里一个验证器的结论最多几个字、问题最多列几条（最终评审 M2：它的会话一夜都在，每份简报都要再读） */
const BRIEF_RESULT_CHARS = 400;
const BRIEF_PROBLEMS = 8;
/** 问题列出前 BRIEF_PROBLEMS 条，多的说还有几条 */
const listed = (ps: string[]): string => ps.slice(0, BRIEF_PROBLEMS).join(S.marks.clauseSep) + (ps.length > BRIEF_PROBLEMS ? S.runner.moreProblems(ps.length - BRIEF_PROBLEMS) : "");
/** 一个结论最多 BRIEF_RESULT_CHARS 个字，多的说还有几个字 */
const capped = (t: string): string => (t.length > BRIEF_RESULT_CHARS ? S.runner.moreChars(t.slice(0, BRIEF_RESULT_CHARS), t.length - BRIEF_RESULT_CHARS) : t);
/** 一夜最多打磨几次（coordinator.maxPolish 没写时） */
const DEFAULT_MAX_POLISH = 2;
/** 验证器的名字说给前额叶、报告听 */
const CHECK_NAME: Record<string, string> = { get audit() { return S.runner.check.audit; }, get review() { return S.runner.check.review; }, get exam() { return S.runner.check.exam; } };
/** validate 顺带记下的（多人模式才收）：每个验证器的结论、没改东西跳过了验证、谁审的 */
interface Checked { checks: Array<{ name: string; result: string }>; skipped: boolean; reviewer: string | null }

/**
 * 一次尝试的结果：again = 没过、后面还有一次（这一次是 redo）；stop = 这一次被定成推迟（前额叶或规矩）、不再往下修；
 * polish = 过了、前额叶要再修一次（修的人看的问题）
 */
export interface Attempted { passed: StageDone | null; done: StageDone | null; problems: string[]; again: boolean; stop?: "coord" | "rule"; polish?: string[];
  /** 调用次数到了上限推迟的：原因（整天推迟时报告用） */
  overBudget?: string;
  /** 记账那一行（sleep_stage.id）：打磨没做时在它的 decision 后面注一句 */
  row?: number;
  /** 没过、写过事件库（批撤了）：重做时新建的编号会变（切换前 P9） */
  memReverted?: boolean }

/** fail：交了也不算（比如调用次数超了上限），这一次直接没过 */
export interface Talk { done: StageDone | null; error: string | null; fail: string | null; usage: StageUsage | null;
  /** 交 stage_done 时当场退回了几次（记账写进 verdict：回放对比数省了几次重做） */
  bounces?: number;
  /** 调用次数到了上限、没交差：这一段直接推迟，不再修（回放第 1 次 F3） */
  overBudget?: boolean }

/** 交 stage_done 时当场核对没过、退回去补：每次尝试最多退几次（再交就照交的收下，交给后面的检查） */
const MAX_BOUNCES = 2;
/** 核依据的会话两次都没做完时验证器给的话（validate.ts） */
const CHECK_MS = 10 * 60_000;
/** 回放第 1 次 F3：调用次数到了上限（没交差）就推迟、不重做（重做差不多再花一倍） */
const OVER_CALLS = (n: number): string => S.runner.overCalls(n);
/** 这一段的会话花过了它的 budget 没有（以后加 budget.units 在这里加一行） */
const overBudget = (use: StageUsage, b: StageSpec["budget"]): boolean => use.calls > b.calls;
/** 到这么多次（上限的 80%）还没交差：催它收尾一次 */
const nearBudget = (use: StageUsage, b: StageSpec["budget"]): boolean => use.calls >= Math.ceil(0.8 * b.calls);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** 记账的 verdict：过了 / 问题；当场退回过的注上几次 */
const verdictOf = (ok: boolean, problems: string[], bounces: number): string => {
  const note = bounces ? S.runner.bounced(bounces) : "";
  if (ok) return note ? S.teamrun.passedWith(note) : S.teamrun.passed;
  return `${note ? S.runner.noteSep(note) : ""}${problems.join(S.marks.clauseSep)}`.slice(0, 1000);
};
const isSunday = (day: string): boolean => new Date(`${day}T00:00:00Z`).getUTCDay() === 0;

/** list 里的段按 after 排先后（list 外的依赖不管），同一层照配置顺序 */
function inOrder(list: StageSpec[]): StageSpec[] {
  const ids = new Set(list.map((s) => s.id));
  const placed = new Set<string>();
  const out: StageSpec[] = [];
  for (;;) {
    const next = list.find((s) => !placed.has(s.id) && s.after.every((a) => !ids.has(a) || placed.has(a)));
    if (!next) return out;
    placed.add(next.id);
    out.push(next);
  }
}

/** 一天的进度 */
export class Day {
  readonly day: string;
  readonly fates = new Map<string, Fate>();
  /** 每段最近一次是第几次（接着以前几夜往下数） */
  readonly attempts = new Map<string, number>();
  /** 每段今晚试了几次（报告用） */
  readonly tries = new Map<string, number>();
  readonly spent = new Map<string, number>();
  readonly sessions = new Set<OpenedStage>();
  /** 报告最上面那几行：没核依据、验证器出错、准备没过 */
  readonly notes: string[] = [];
  /** 全天考试重做了还没过的：进报告「拿不准」 */
  readonly leftovers: string[] = [];
  /** 每次过了的尝试，按过的先后：全天考试叫的重做过了，同一段再记一条（重做只在现在的提案上改，第一次的照样算） */
  readonly passes: Array<{ stage: string; n: number }> = [];
  /** 今晚过了的尝试改过的文件：今晚以前的样子（头一个改它的段开始时）、现在的样子（最后一个改它的段过的时候）；null = 不存在 */
  readonly tonight = { before: new Map<string, string | null>(), after: new Map<string, string | null>() };
  save = false;
  partial = false;
  backlog = 0;
  /** 这一天不往下做了（看门狗、required 的段推迟、落地没成、出错）：不落地，下一晚从头来 */
  abortWhy: string | null = null;
  /** finish 退出码 0 了：这一天落地了，之后出什么事（后面的脚本没过、叫停、抛错）都只记进报告，不撤回 */
  finished = false;
  /** 准备完那一刻（毫秒）和那时 proposed/ 的样子：不落地时撤回这一刻以后开的批次、恢复成这一份 */
  prepared: { at: number; snap: Snapshot } | null = null;
  /** 多人模式：每段最近一次是谁做的、那一次交的改动和 diff（下一个修的人看）、每次尝试的样子 */
  readonly doers = new Map<string, string | null>();
  readonly prev = new Map<string, { changes: string; diff: string } | null>();
  readonly rounds = new Map<string, Round[]>();

  constructor(day: string) { this.day = day; }
  get root(): string { return `sleep/${this.day}/proposed`; }
  get preparedPath(): string { return `sleep/${this.day}/flow/prepared.json`; }
  /** 落地后标完成（省电、材料不完整都不标，这一天下一晚整天重来） */
  get complete(): boolean { return !this.save && !this.partial; }
  /**
   * 这一段的第几次：这一天以前几夜记过账的接着往下数（seed 给已经记到第几次），
   * 这样同一天换了一夜再来，批次名 sleep:<日>/<段>/<次> 和记录文件不会撞上已经提交过的
   */
  nextAttempt(id: string, seed: () => number): number {
    const n = (this.attempts.get(id) ?? seed()) + 1;
    this.attempts.set(id, n);
    this.tries.set(id, (this.tries.get(id) ?? 0) + 1);
    return n;
  }
}

export class SleepRunner {
  protected readonly host: StageHost;
  protected readonly flow: FlowConfig;
  protected readonly o: RunnerOptions;
  protected readonly weights: Weights;
  private readonly byId: Map<string, StageSpec>;
  /** 准备：不在任何 agent 段后面的脚本段 */
  private readonly preparing: StageSpec[];
  /** 落地：finish，和排在 agent 段（或别的落地脚本）后面的脚本段（核对） */
  private readonly landing: StageSpec[];
  private readonly landingIds: Set<string>;
  protected readonly agents: StageSpec[];
  protected runId = 0;
  /** runNight 开始的那一刻（这一夜开始：考试按结果记下的时刻跟它比） */
  private started = 0;
  protected spent = 0;
  /** 今晚打磨了几次（都过了、前额叶要再修一次的） */
  private polished = 0;
  private current: Day | null = null;
  private stopped: "watchdog" | "aborted" | null = null;
  private over = false;
  private used = false;
  /** 多人模式（给了 personas 或前额叶）：报告、记账多写谁做谁审、怎么定的、各花了多少；没改东西的尝试不请验证器 */
  private readonly team: boolean;
  /** 一段最多做几次：多人模式 1 + maxFixRounds，不然照旧 2 */
  private readonly maxTries: number;
  /** 段外会话的花费记到各段头上：<日>/<段> 和 <日>/<段>/<次>；<日>/ 是全天考试那些不归哪一段的 */
  protected readonly costs = new Map<string, Cost>();
  /** 前额叶正在定的那一次（它的花费记到这一次头上）；并行的段一份一份排队问，不然记混 */
  private deciding: { day: string; stage: string; n: number } | null = null;
  private asking: Promise<unknown> = Promise.resolve();

  constructor(host: StageHost, flow: FlowConfig, o: RunnerOptions) {
    this.host = host;
    this.flow = flow;
    this.o = o;
    this.weights = o.weights ?? DEFAULT_WEIGHTS;
    this.byId = new Map(flow.stages.map((s) => [s.id, s]));
    const isLanding = (s: StageSpec): boolean => s.kind === "script" && (s.id === "finish" ||
      s.after.some((a) => { const u = this.byId.get(a); return u !== undefined && (u.kind === "agent" || isLanding(u)); }));
    const scripts = flow.stages.filter((s) => s.kind === "script");
    this.landing = inOrder(scripts.filter(isLanding));
    this.preparing = inOrder(scripts.filter((s) => !isLanding(s)));
    this.landingIds = new Set(this.landing.map((s) => s.id));
    this.agents = inOrder(flow.stages.filter((s) => s.kind === "agent"));
    this.team = !!o.personas || !!o.coordinator;
    this.maxTries = o.personas ? 1 + (flow.maxFixRounds ?? 2) : 2;
  }

  /**
   * 段外的会话花了 u 单位（host 报上来的：audit-、review-、exam-<日>-<段>-<次>-…，coord-…）：记到那一段那一次头上；
   * 前额叶的记到它正在定的那一次；全天考试（exam-<日>-final…）记在这一天
   */
  charge(id: string, u: number): void {
    if (!(u > 0)) return;
    const m = /^(audit|review|exam|coord)-/.exec(id);
    if (!m) return;
    const kind = m[1] as "audit" | "review" | "exam" | "coord";
    let day: string, stage: string | null = null, n: number | null = null;
    if (kind === "coord") {
      if (!this.deciding) return;
      ({ day, stage, n } = this.deciding);
    } else {
      const rest = id.slice(kind.length + 1);
      day = rest.slice(0, 10);
      const tail = rest.slice(11);
      const ids = [...this.byId.keys()].sort((a, b) => b.length - a.length);
      stage = ids.find((s) => tail.startsWith(`${s}-`) && /^\d+/.test(tail.slice(s.length + 1))) ?? null;
      if (stage) n = Number(/^\d+/.exec(tail.slice(stage.length + 1))![0]);
    }
    const add = (key: string): void => { const c = this.costs.get(key) ?? NO_COST(); c[kind] += u; this.costs.set(key, c); };
    add(`${day}/${stage ?? ""}`);
    if (stage && n !== null) add(`${day}/${stage}/${n}`);
  }

  protected costOf(key: string): Cost { return this.costs.get(key) ?? NO_COST(); }

  /** 这一夜到过的最高一级省钱阶梯（各段开头、收尾时采样） */
  private maxSave = 0;
  protected sampleSave(): void { this.maxSave = Math.max(this.maxSave, saveLevel(this.o.budget)); }

  async runNight(o: { night: string; pending(): Promise<string | null>; backlog?: () => Promise<number> }): Promise<NightResult> {
    if (this.used) throw new Error(S.runner.oneNight);
    this.used = true;
    const h = this.host;
    this.started = h.now();
    this.runId = L.startRun(h.db, o.night, h.flowHash, this.started);
    const res: NightResult = { runId: this.runId, landed: [], deferredDays: [], owed: [], stoppedBy: "done" };
    const cancel = h.later(() => this.watchdog(), this.o.watchdogMs);
    try {
      await this.nightLoop(o, res);
    } catch (e) {
      // nightLoop 自己把错收成 stoppedBy: error；到这里的是没想到的。记账出错也不能盖掉原来那个错
      try {
        this.sampleSave();
        L.setRunSaveLevel(h.db, this.runId, this.maxSave);
      } catch (e2) {
        h.log.error("sleep: writing the night's save level failed", { error: msg(e2).slice(0, 300) });
      }
      try {
        L.endRun(h.db, this.runId, { status: "error", days: res.landed, spentUnits: this.o.budget.spent, notes: msg(e).slice(0, 500) }, h.now());
      } catch (e2) {
        h.log.error("sleep: writing the night's ledger row failed", { error: msg(e2).slice(0, 300) });
      }
      throw e;
    } finally {
      this.over = true;
      cancel();
      this.closeCoordinator();
    }
    // 出错停下的：错是这一夜真正的下场（叫停、看门狗可能是跟着来的）
    if (this.stopped && res.stoppedBy !== "error") res.stoppedBy = this.stopped;
    const notes = [
      ...(res.error ? [S.runner.stoppedOnError(res.error)] : []),
      ...(res.deferredDays.length ? [S.runner.notLandedDays(res.deferredDays.join(S.marks.listSep))] : []),
    ].join(S.marks.clauseSep).slice(0, 500) || undefined;
    // 记账的花费是整个 Budget：各段的，加上 runner 外面算进来的（核依据的会话）；记不进去也照样把这一夜的结果交回去
    try {
      this.sampleSave();
      L.setRunSaveLevel(h.db, this.runId, this.maxSave);
    } catch (e) {
      h.log.error("sleep: writing the night's save level failed", { error: msg(e).slice(0, 300) });
    }
    try {
      L.endRun(h.db, this.runId, { status: res.stoppedBy, days: res.landed, spentUnits: this.o.budget.spent, ...(notes ? { notes } : {}) }, h.now());
    } catch (e) {
      h.log.error("sleep: writing the night's ledger row failed", { error: msg(e).slice(0, 300), stoppedBy: res.stoppedBy, landed: res.landed });
    }
    h.log.info("sleep: night done", { ...res, units: Math.round(this.o.budget.spent), stageUnits: Math.round(this.spent), pct: this.o.budget.pct });
    return res;
  }

  /**
   * 一天接一天（最旧的先）：每等完一样（pending、backlog）都再看一眼看门狗；过了绝对线不开新的一天。
   * 哪里抛了错（问积压、某一天里头）：这一夜停在这里，前面落地的照算，stoppedBy = error，不往外抛
   */
  private async nightLoop(o: { pending(): Promise<string | null>; backlog?: () => Promise<number> }, res: NightResult): Promise<void> {
    const tried = new Set<string>();
    try {
      while (!this.stopped && tried.size < this.o.maxDays) {
        const day = await o.pending();
        // 推迟的、没标完成的日子还会再给回来：这一夜试过的不再试
        if (this.stopped || day === null || tried.has(day)) return;
        if (this.o.budget.overHard) { res.stoppedBy = "budget"; return; }
        const backlog = o.backlog ? await o.backlog() : 0;
        if (this.stopped) return;
        tried.add(day);
        const d = new Day(day);
        d.backlog = backlog;
        this.current = d;
        const r = await this.runDay(d);
        this.current = null;
        if (r.landed) {
          res.landed.push(day);
          if (d.complete) res.owed.push(...this.recordOwed(d));
        } else res.deferredDays.push(day);
        if ("error" in r) throw r.error;
      }
    } catch (e) {
      this.current = null;
      res.stoppedBy = "error";
      res.error = msg(e).slice(0, 1000);
      this.host.log.error("sleep: night stopped by an error", { error: e instanceof Error ? e.stack ?? e.message : String(e), landed: res.landed });
    }
  }

  // ---------- 一天 ----------

  /**
   * 一天，不管落没落地都删掉 prepared.json。抛错：finish 已经过了的算落地（不撤回）；没过的尽量撤回
   * （abandon：准备完以后的批次、proposed/ 恢复），撤成了才删 prepared.json——撤不成、或者还没准备完就出错，留着它，
   * 下一次开这一天时从头来（hhd 重启、崩溃时也是靠它）
   */
  private async runDay(d: Day): Promise<{ landed: boolean; error?: unknown }> {
    try {
      const landed = await this.dayPhases(d);
      this.host.fs.remove(d.preparedPath);
      return { landed };
    } catch (e) {
      this.host.log.error("sleep: day threw", { day: d.day, finished: d.finished, error: msg(e).slice(0, 500) });
      if (d.finished) {
        // 落地了（prepared.json 在 finish 过了那一刻已经删了）：完整的一天照样标（标过了再标一次没关系）
        if (d.complete) {
          try { this.host.mem?.markDays([d.day]); } catch (e2) { this.host.log.error("sleep: marking the landed day failed", { day: d.day, error: msg(e2).slice(0, 300) }); }
        }
        return { landed: true, error: e };
      }
      this.abortDay(d, S.teamrun.failed(msg(e)));
      if (d.prepared) {
        try {
          this.abandon(d);
          this.host.fs.remove(d.preparedPath);
        } catch (e2) {
          this.host.log.error("sleep: undoing the day after the error failed too; prepared.json kept, the day starts over next time", { day: d.day, error: msg(e2).slice(0, 300) });
        }
      }
      return { landed: false, error: e };
    }
  }

  private async dayPhases(d: Day): Promise<boolean> {
    const left = this.host.fs.read(d.preparedPath);
    if (left !== null) this.startOver(d, left);
    if (!(await this.prepare(d))) return false;
    this.savePrepared(d);
    await this.runStages(d);
    if (!d.abortWhy) await this.finalPass(d);
    if (d.abortWhy) {
      this.abandon(d);
      this.writeReport(d);
      return false;
    }
    this.writeReport(d);
    const failed = await this.land(d);
    if (failed === null) return true;
    // 落地没成：跟 required 的段推迟一样整天撤回；报告已经交给落地脚本了，只在最上面补几行
    d.abortWhy = failed;
    const seen = d.notes.length;
    this.abandon(d);
    this.prependReport(d, [S.runner.dayNotLanded(failed), ...d.notes.slice(seen)]);
    return false;
  }

  /** 准备完：记下这一刻和 proposed/ 的样子（重启后、不落地时恢复成这一份） */
  private savePrepared(d: Day): void {
    const at = this.host.now();
    const snap = snapshot(d.root, () => true, this.host.fs);
    d.prepared = { at, snap };
    this.host.fs.write(d.preparedPath, JSON.stringify({ at, files: Object.fromEntries(snap) }));
  }

  /** 上一次这一天没收尾（重启）：撤回那一跑准备完以后开的批次、proposed/ 恢复成准备完那份，再从准备重来（spec §6.4） */
  private startOver(d: Day, text: string): void {
    let prev: { at: number; snap: Snapshot } | null = null;
    try {
      const raw = JSON.parse(text) as { at?: unknown; files?: Record<string, { sha: string; text: string }> };
      if (typeof raw.at === "number" && raw.files && typeof raw.files === "object") prev = { at: raw.at, snap: new Map(Object.entries(raw.files)) };
    } catch { /* 下面记日志 */ }
    // 读不出来：不能从 0 撤（会把以前几夜提交过的这一天的批次也撤了）——用崩了的那一跑（最近一个没收尾的，不算这一跑自己）开始的时刻
    let since = prev?.at ?? null;
    if (!prev) {
      since = L.crashedRunStart(this.host.db, this.runId);
      if (since === null) this.host.log.error("sleep: prepared.json unreadable and no crashed run in the ledger; event batches not reverted, proposals not restored", { day: d.day });
      else this.host.log.error("sleep: prepared.json unreadable, reverting the day's stage batches since the crashed run started; proposals not restored", { day: d.day, since });
    }
    const r = since === null ? null : this.host.mem?.revertDayStages(d.day, since) ?? null;
    this.noteConflicts(d, S.runner.withdrawAfterRestart, r);
    // 上一跑哪几段推迟了不知道：都不留
    this.tellAbandoned(d, []);
    this.host.log.warn("sleep: day left half-done, starting over from prepare", { day: d.day, reverted: r?.reverted ?? 0, conflicts: r?.conflicts.length ?? 0 });
    if (prev) restore(d.root, prev.snap, () => true, this.host.fs);
  }

  /** 这一天不落地、下一晚从头来：准备完以后开的批次撤回（以前几夜的不动），proposed/ 恢复成准备完那份 */
  private abandon(d: Day): void {
    if (!d.prepared) return;
    this.tellAbandoned(d, this.agents.filter((s) => d.fates.get(s.id)?.kind === "deferred").map((s) => s.id));
    const r = this.host.mem?.revertDayStages(d.day, d.prepared.at) ?? null;
    this.noteConflicts(d, S.runner.withdrawDay, r);
    this.host.log.warn("sleep: day not landed, its stages undone", { day: d.day, why: d.abortWhy, reverted: r?.reverted ?? 0, conflicts: r?.conflicts.length ?? 0 });
    restore(d.root, d.prepared.snap, () => true, this.host.fs);
  }

  /** 告诉 host 这一天撤回了（它丢掉这一天待定的东西，keep 的段留着）；出错只记日志，撤回照做 */
  private tellAbandoned(d: Day, keep: string[]): void {
    try { this.host.abandoned?.(d.day, keep); } catch (e) {
      this.host.log.error("sleep: host failed to drop the abandoned day's pending state", { day: d.day, keep, error: msg(e).slice(0, 300) });
    }
  }

  /** 撤回时没撤动的（之后又被改过、别处还在用）：写在报告最上面 */
  protected noteConflicts(d: Day, what: string, r: { conflicts: string[] } | null): void {
    if (!r?.conflicts.length) return;
    d.notes.push(S.runner.conflicts(what, r.conflicts.length, r.conflicts.slice(0, 10).join(S.marks.clauseSep), r.conflicts.length > 10 ? "……" : ""));
  }

  /** 准备：准备的脚本段按 after 先后跑；输出第一行是 defer / save / partial 时照它办 */
  private async prepare(d: Day): Promise<boolean> {
    for (const s of this.preparing) {
      if (d.abortWhy) return false;
      const why = this.notToday(s, d);
      if (why) { d.fates.set(s.id, { kind: "not-today", why }); continue; }
      const up = s.after.find((a) => !this.satisfied(d, a));
      if (up !== undefined) {
        d.fates.set(s.id, { kind: "followed", upstream: up });
        if (s.required) return false;
        continue;
      }
      const r = await this.script(d, s);
      const word = r.out.trimStart().split(/\s+/, 1)[0];
      if (word === "defer") {
        this.host.log.info("sleep: gate says defer, day left for another night", { day: d.day, stage: s.id });
        return false;
      }
      if (word === "save") d.save = true;
      if (word === "partial") d.partial = true;
      if (r.code !== 0) {
        d.notes.push(S.runner.prepareFailed(s.title, r.code, r.out.slice(0, 300)));
        this.host.log.warn("sleep: prepare script failed", { day: d.day, stage: s.id, code: r.code, required: s.required });
        if (s.required) return false;
      }
    }
    return !d.abortWhy;
  }

  /** 各段：照 runnable() 开（依赖都过了验证、不跟正在跑的改同一个文件、不超过 maxParallel），做完一段再看能开哪些 */
  private async runStages(d: Day): Promise<void> {
    for (const s of this.agents) {
      const why = this.notToday(s, d);
      if (why) d.fates.set(s.id, { kind: "not-today", why });
    }
    const tasks = new Map<string, Promise<void>>();
    const crashes: unknown[] = [];
    for (;;) {
      while (!d.abortWhy) {
        const picks = runnable(this.flow, this.progress(d, tasks));
        if (!picks.length) break;
        for (const s of picks) {
          // 过了绝对线：开了头的做完，没开的不开（required 的照开，spec §10.1）
          if (this.o.budget.overHard && !s.required) { d.fates.set(s.id, { kind: "budget" }); continue; }
          tasks.set(s.id, this.runStage(d, s)
            .catch((e: unknown) => { crashes.push(e); this.abortDay(d, S.teamrun.failed(msg(e))); })
            .finally(() => tasks.delete(s.id)));
        }
      }
      if (!tasks.size) break;
      await Promise.race(tasks.values());
    }
    if (crashes.length) throw crashes[0];
    this.followUpstream(d);
  }

  /** runnable() 要的四个集合：今天不跑的、跑完了的准备脚本当作过了；落地脚本不归这里开 */
  private progress(d: Day, tasks: Map<string, unknown>) {
    const done = new Set<string>();
    const failed = new Set<string>();
    for (const s of this.flow.stages) {
      if (this.satisfied(d, s.id)) done.add(s.id);
      else if (d.fates.has(s.id)) failed.add(s.id);
    }
    return { done, failed, running: new Set(tasks.keys()), skipped: this.landingIds };
  }

  /** 一段：做一次，不过带着问题再做一次，还不过推迟；required 的推迟了，这一天整天推迟 */
  protected async runStage(d: Day, s: StageSpec): Promise<void> {
    this.sampleSave();
    // 不是多人模式：一共两次（第一次 redo、第二次 defer），照旧。多人模式：1 + maxFixRounds 次（过了绝对线最多两次），
    // 前额叶定了推迟就停。每一次开头定它是不是最后一次（redo 的后面一定还有一次）
    let r = await this.attempt(d, s, [], this.triesCap() > 1 ? "redo" : "defer");
    // 没过的那一次写过事件库（批撤了）：交给修的人的问题后面接一句「编号会变」（切换前 P9）
    for (let k = 2; !r.passed && !d.abortWhy && r.again; k++) r = await this.attempt(d, s, r.memReverted ? [...r.problems, P.SLEEP_IDS_CHANGE] : r.problems, k < this.triesCap() ? "redo" : "defer");
    if (r.passed) {
      // 都过了、前额叶要再修一次：这一次已经提交了；再修（keep，跟全天考试叫的重做一样）修不好留着这一次的。修完才算过（下游等它）
      const done = r.polish ? await this.polish(d, s, r.passed, r.polish, r.row) : r.passed;
      d.fates.set(s.id, { kind: "passed", done });
    } else if (d.abortWhy) d.fates.set(s.id, { kind: "aborted", why: d.abortWhy });
    else {
      d.fates.set(s.id, { kind: "deferred", problems: r.problems, done: r.done });
      this.host.log.warn("sleep: stage deferred", { day: d.day, stage: s.id, ...(s.region ? { region: s.region } : {}), problems: r.problems.slice(0, 5) });
      if (s.required) this.abortDay(d, r.overBudget ? S.runner.stageOverBudget(s.title, r.overBudget) : r.stop === "coord" ? S.runner.stageCoordDeferred(s.title) : this.maxTries === 2 ? S.runner.stageFailedTwice(s.title) : S.runner.stageFailedN(s.title, d.tries.get(s.id) ?? this.maxTries));
    }
  }

  /** 一段最多做几次：多人模式 1 + maxFixRounds；过了绝对线最多两次（不再多修）；不是多人模式照旧 2 */
  private triesCap(): number { return this.o.budget.overHard ? Math.min(2, this.maxTries) : this.maxTries; }

  /** 前额叶叫都过了的一次再修一次：keep 模式（在现在的提案上改、不问前额叶），过了接在第一次的报告后面；过了绝对线不修，报告最上面写一句 */
  private async polish(d: Day, s: StageSpec, first: StageDone, problems: string[], row?: number): Promise<StageDone> {
    if (d.abortWhy) return first;
    const said = S.coordinator.said("");   // what the prefrontal's problems start with: dropped here
    const why = problems.map((p) => (p.startsWith(said) ? p.slice(said.length) : p)).join(S.marks.clauseSep);
    if (this.o.budget.overHard) {
      d.notes.push(S.runner.polishOverHard(s.title, why));
      return this.notPolished(d, s, first, row, S.runner.line.hard);
    }
    // 最终评审 I2：过了目标线（= 省钱阶梯开始生效，saveLevel > 0）不打磨；一夜最多打磨 maxPolish 次（默认 2）
    if (this.o.budget.overTarget || saveLevel(this.o.budget) > 0) {
      d.notes.push(S.runner.polishOverTarget(s.title, why));
      return this.notPolished(d, s, first, row, S.runner.line.target);
    }
    const cap = this.flow.coordinator?.maxPolish ?? DEFAULT_MAX_POLISH;
    if (this.polished >= cap) {
      d.notes.push(S.runner.polishCapped(s.title, this.polished, cap, why));
      return this.notPolished(d, s, first, row, S.runner.line.cap);
    }
    this.polished += 1;
    const r = await this.attempt(d, s, problems, "keep");
    return r.passed ? afterRedo(first, r.passed, S.runner.polishAsked) : first;
  }

  /**
   * 前额叶要的打磨没做（修正第 2 轮 m2）：记账那一行的 decision 后面注「（没做：…）」、报告里那一次也这么写，
   * compare.md 的协调一栏就不把没做的算成打磨了
   */
  private notPolished(d: Day, s: StageSpec, first: StageDone, row: number | undefined, why: string): StageDone {
    if (row !== undefined) L.noteStageDecision(this.host.db, row, S.runner.notDone(why));
    const last = [...(d.rounds.get(s.id) ?? [])].reverse().find((x) => x.decision === "polish");
    if (last) last.notDone = why;
    return first;
  }

  /** 没开的段：上游没过的跟着推迟；required 的跟着推迟 = 整天推迟 */
  private followUpstream(d: Day): void {
    for (const s of this.agents) {
      if (d.fates.has(s.id)) continue;
      const up = s.after.find((a) => !this.satisfied(d, a));
      if (up === undefined) { d.fates.set(s.id, { kind: "aborted", why: d.abortWhy ?? S.runner.notReached }); continue; }
      d.fates.set(s.id, { kind: "followed", upstream: up });
      if (s.required) this.abortDay(d, S.runner.followedUpstream(s.title, this.titleOf(up)));
    }
  }

  // ---------- 一次尝试 ----------

  /**
   * 一次尝试：快照 → 开批 → 叫醒 → 等交差 → 记录 → 验证 → 过了提交；不过恢复快照、撤批。
   * onFail：redo 后面还有一次；defer 是最后一次（提案先抄到 deferred/）；keep 是全天考试叫的重做，不过就留着上一次过了的
   */
  private async attempt(d: Day, s: StageSpec, redo: string[], onFail: "redo" | "defer" | "keep"): Promise<Attempted> {
    let passed = false;
    try {
      const r = await this.attemptOnce(d, s, redo, onFail);
      passed = r.passed !== null;
      return r;
    } finally {
      // 这一次结束了（验没验、过没过、抛没抛错）：告诉 host，它给这一次的东西（整理前的事件库拷贝）可以收了，
      // 没过的那一次申请的改题、退休不落地
      try { this.host.attemptEnded?.(d.day, s.id, passed, d.attempts.get(s.id) ?? 0); } catch (e) { this.host.log.warn("sleep: host cleanup after the attempt failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    }
  }

  private async attemptOnce(d: Day, s: StageSpec, redo: string[], onFail: "redo" | "defer" | "keep"): Promise<Attempted> {
    const h = this.host;
    const n = this.nextAttempt(d, s.id);
    const region = `sleep-${d.day}-${s.id}-${n}`;
    // 多人模式：这一次谁做（今晚头一次是段的 persona，之后换一个不是上一次做的人来修）
    const doer = this.doerFor(d, s);
    const checked: Checked | null = this.team ? { checks: [], skipped: false, reviewer: null } : null;
    if (this.team) h.log.info("sleep: stage attempt", { day: d.day, stage: s.id, attempt: n, ...(s.region ? { region: s.region } : {}), ...(doer ? { persona: doer } : {}) });
    const scope = (p: string) => matchWrites(s.writes, p);
    const row = L.startStage(h.db, { runId: this.runId, day: d.day, stage: s.id, attempt: n, model: s.model }, h.now());
    const before = snapshot(d.root, scope, h.fs);
    let after = before;
    let talk: Talk = { done: null, error: null, fail: null, usage: null };
    let problems: string[];
    let begun = false;
    let decided: { decision: Decision | "polish"; by: "coord" | "rule" } | null = null;
    let polish: string[] | undefined;
    const wake = this.wakeText(d, s, redo, doer, onFail === "keep");
    if ("problem" in wake) {
      problems = [wake.problem];
      talk.error = wake.problem;
    } else {
      h.mem?.beginStage(region, stageBatch(d.day, s.id, n));
      begun = true;
      // 交 stage_done 时当场核对：照这一刻的提案和事件库算 actual（跟交差后验证的同一个算法），机械的那几样 + 验证器的 precheck
      const check = (x: StageDone): Precheck => {
        const now = snapshot(d.root, scope, h.fs);
        return this.precheck(d, s, this.recordOf(d, s, n, region, x, before, now),
          { before, after: now, material: wake.material, storeBefore: this.storeBefore(d, s), ...(doer ? { doer } : {}) });
      };
      talk = await this.converse(d, s, region, wake.text, check);
      after = snapshot(d.root, scope, h.fs);
      let validated = false;
      problems = talk.fail ? [talk.fail]
        : talk.done && !d.abortWhy ? (validated = true, await this.validate(d, s, n, region, talk.done, { before, after, material: wake.material, storeBefore: this.storeBefore(d, s), ...(doer ? { doer } : {}) }, checked))
        : [talk.error ?? S.teamrun.noStageDone];
      // 等会话、验证的时候这一天中止了（看门狗、别的 required 段推迟）：过了也不算
      if (d.abortWhy) problems = [S.teamrun.aborted(d.abortWhy)];
      // 多人模式：验完了（没改东西跳过验证的不算）问前额叶；它定的照硬规矩收（全天考试叫的重做不问）
      else if (checked && validated && !checked.skipped && onFail !== "keep") {
        const left = onFail === "redo" ? Math.max(0, this.triesCap() - (d.tries.get(s.id) ?? 0)) : 0;
        const failed = problems.length > 0;
        // 简报里的花费算上这一次做的（还没记进 budget）
        const doing = talk.usage ? units(talk.usage, s.model, this.weights) : 0;
        const r = await this.decide(d, s, n, doer, talk.done!, problems, checked, left, doing, failed ? h.mem?.stageOps(region) ?? 0 : 0);
        // 都过了、前额叶要重做：这一次照样过（提交），runStage 再让另一个你在它上面修一次
        if (!failed && r.decision === "redo") { decided = { decision: "polish", by: r.by }; polish = r.problems; problems = []; }
        else { decided = r; problems = r.problems; }
        // 等前额叶的时候这一天中止了：过了也不算
        if (d.abortWhy) { problems = [S.teamrun.aborted(d.abortWhy)]; decided = null; polish = undefined; }
      }
    }
    const u = talk.usage ? units(talk.usage, s.model, this.weights) : 0;
    this.o.budget.add(u);
    this.spent += u;
    d.spent.set(s.id, (d.spent.get(s.id) ?? 0) + u);

    const ok = problems.length === 0;
    // 没过的这一次写过事件库：下面撤批，重做时编号会变（切换前 P9）
    const memReverted = !ok && begun && (h.mem?.stageOps(region) ?? 0) > 0;
    // 前额叶定了推迟、或者调用次数到了上限（回放第 1 次 F3；全天考试叫的重做照旧留着上一次过了的）：这一次就是最后一次（提案抄到 deferred/、记账写 deferred）
    const capped = !ok && talk.overBudget === true && onFail === "redo";
    const stop = (!ok && decided?.decision === "defer" && onFail === "redo") || capped;
    if (stop) onFail = "defer";
    const again = !ok && onFail === "redo";
    // 多人模式：记下这一次（报告用）、它交的改动和 diff（下一个修的人看；过了的留着提案，修的人在上面改）
    const decision: Round["decision"] = decided?.decision ?? (ok ? "pass" : d.abortWhy ? "abort" : onFail === "keep" ? "keep" : onFail === "redo" ? "redo" : "defer");
    if (this.team) {
      const rs = d.rounds.get(s.id) ?? [];
      rs.push({ n, doer, reviewer: checked?.reviewer ?? null, ok, problems: ok ? [] : problems, decision, by: decided?.by ?? "rule", skipped: checked?.skipped ?? false });
      d.rounds.set(s.id, rs);
      d.doers.set(s.id, doer);
      d.prev.set(s.id, talk.done ? { changes: JSON.stringify(talk.done.changes, null, 2).slice(0, 20000), diff: snapDiff(before, after) } : null);
    }
    // 段里 mem_day_done 记下的日子不用：落地时引擎只标这一天（d.day），别的日子不跟着标
    if (ok) {
      h.mem?.commitStage(region);
      d.passes.push({ stage: s.id, n });
      // 记下今晚改过的文件：快照里没有的是这一段头一回提议的，今晚以前的样子在工作区里
      for (const f of diff(before, after)) {
        if (!d.tonight.before.has(f.path)) d.tonight.before.set(f.path, before.get(f.path)?.text ?? h.fs.read(f.path));
        d.tonight.after.set(f.path, after.get(f.path)?.text ?? null);
      }
    } else {
      if (onFail === "defer" && !d.abortWhy) this.keepDeferred(d, s, before, after);
      restore(d.root, before, scope, h.fs);
      if (begun) this.noteConflicts(d, S.runner.withdrawTry(s.title, n), h.mem?.revertStage(region) ?? null);
    }
    const use = talk.usage;
    const status = ok ? "passed" : d.abortWhy || onFail === "keep" ? "failed" : onFail === "redo" ? "redo" : "deferred";
    // 多人模式多记：脑区、谁做的、谁审的、怎么定的、这一次各花了多少
    const cost = { ...this.costOf(`${d.day}/${s.id}/${n}`), do: u };
    const team = !this.team ? {} : {
      ...(s.region ? { region: s.region } : {}), ...(doer ? { persona: doer } : {}), ...(checked?.reviewer ? { reviewer: checked.reviewer } : {}),
      decision: `${decided?.by ?? "rule"}:${decision}`,
      cost: JSON.stringify(cost),
    };
    L.endStage(h.db, row, {
      status,
      ...(use ? { calls: use.calls, maxCtx: use.maxCtx, cacheRead: use.cacheRead, cacheWrite: use.cacheWrite, input: use.input, output: use.output } : {}),
      units: u, changes: talk.done?.changes.length ?? 0,
      // 当场退回了几次写进 verdict（修正轮 M4：回放对比数省了几次重做）：过了的「过了（当场退回 N 次）」，没过的开头「当场退回 N 次；」
      verdict: verdictOf(ok, problems, talk.bounces ?? 0),
      error: (talk.error ?? "").slice(0, 200),
      ...team,
    }, h.now());
    // 定成推迟的（前额叶的或规矩的，最后一次也算）：记下谁定的，整天推迟时报告写对（最终评审 M6）
    const deferredBy = !ok && decided?.decision === "defer" ? decided.by : capped ? "rule" : stop ? decided!.by : null;
    return { passed: ok ? talk.done : null, done: talk.done, problems, again, ...(deferredBy ? { stop: deferredBy } : {}), ...(ok && polish ? { polish, row } : {}), ...(!ok && talk.overBudget ? { overBudget: problems[0] ?? "" } : {}), ...(memReverted ? { memReverted } : {}) };
  }

  /** 多人模式：这一次谁做。今晚这一段头一次：段的 persona；之后（换人修、全天考试叫的重做）：pickFixer 挑一个不是上一次做的人 */
  private doerFor(d: Day, s: StageSpec): string | null {
    const ps = this.o.personas;
    if (!ps) return null;
    const k = d.tries.get(s.id) ?? 1;
    if (!d.doers.has(s.id) || k <= 1) return s.persona ?? null;
    return pickFixer(s, ps, d.doers.get(s.id) ?? null, k - 1);
  }

  /**
   * 问前额叶（没配就是机械的规矩）：简报是这一段、脑区、谁做的、各验证的结论、改了几条、报告开头、第几次、还能重做几轮。
   * 它的话照硬规矩收（ruled）；notes 写进报告最上面
   */
  private async decide(d: Day, s: StageSpec, n: number, doer: string | null, done: StageDone, problems: string[], checked: Checked, left: number, doing = 0, memOps = 0): Promise<{ decision: Decision; by: "coord" | "rule"; problems: string[] }> {
    const failed = problems.length > 0;
    const c = this.o.coordinator;
    if (!c) return { decision: failed ? (left > 0 ? "redo" : "defer") : "pass", by: "rule", problems };
    // 有验证没过、又没有轮数了：只能推迟，不用问它（报告最上面写一句）
    if (failed && left === 0) {
      d.notes.push(S.runner.deferredByRule(s.title, d.tries.get(s.id) ?? n));
      return { decision: "defer", by: "rule", problems };
    }
    const brief = P.SLEEP_COORD_BRIEF({
      day: d.day, title: s.title, region: s.region ?? null, doer: doer ? this.o.personas?.[doer]?.name ?? doer : null,
      attempt: d.tries.get(s.id) ?? 1, roundsLeft: left, checks: checked.checks, changes: done.changes.length, report: done.report,
      spent: { pct: (this.o.budget.spent + doing) / this.o.budget.unitsPerPct, targetPct: this.o.budget.targetPct },
      ...(failed && memOps > 0 ? { memOps } : {}),
    });
    let answer: Awaited<ReturnType<CoordinatorLike["decide"]>> = null;
    const ask = async (): Promise<typeof answer> => {
      this.deciding = { day: d.day, stage: s.id, n };
      try { return await c.decide(brief); } finally { this.deciding = null; }
    };
    const asked = this.asking.then(ask);
    this.asking = asked.catch(() => {});
    try { answer = await asked; } catch (e) {
      this.host.log.warn("sleep: coordinator threw, deciding by the rules", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) });
    }
    const r = ruled({ title: s.title, failed, left, problems, answer });
    for (const t of r.notes) if (!d.notes.includes(t)) d.notes.push(t);
    this.host.log.info("sleep: coordinator decided", { day: d.day, stage: s.id, attempt: n, said: answer?.decision ?? null, decision: r.decision, by: r.by });
    return { decision: r.decision, by: r.by, problems: r.decision === "pass" ? [] : r.problems };
  }

  /** 叫醒的话：skill 页 + 材料 + 前面几段交上来的；重做时问题放在最前面。material 是给它的材料（验证器要用） */
  protected wakeText(d: Day, s: StageSpec, redo: string[], doer: string | null = null, kept = false): { text: string; material: string } | { problem: string } {
    let skill: string | null;
    try { skill = this.host.skillText(s); } catch (e) { return { problem: S.runner.noSkillPageWhy(s.skill, msg(e)) }; }
    if (skill === null) return { problem: S.runner.noSkillPage(s.skill) };
    let material: string;
    try { material = this.host.materialText(d.day, s.material, s); } catch (e) { return { problem: S.runner.materialUnreadable(msg(e)) }; }
    let notes = "";
    try { notes = this.host.wakeNotes?.(d.day, s) ?? ""; } catch (e) { this.host.log.warn("sleep: wake notes unreadable", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    const shown = notes ? (material ? `${material}\n\n${notes}` : notes) : material;
    const text = P.SLEEP_STAGE_WAKE(skill, shown, this.upstream(d, s), { day: d.day, proposed: d.root });
    const me = doer ? this.o.personas?.[doer] : undefined;
    if (!me) return { text: redo.length ? `${P.SLEEP_STAGE_REDO(redo)}\n\n${text}` : text, material };
    // 多人模式：最前面是谁来做（第一条用户消息里，不进开头）；换人修的再带上问题和上一次的样子
    const prevDoer = d.doers.get(s.id) ?? null;
    const prevName = prevDoer ? this.o.personas?.[prevDoer]?.name ?? prevDoer : S.runner.otherYou;
    const fix = redo.length ? P.SLEEP_STAGE_FIX(redo, prevName, kept ? "kept" : d.prev.get(s.id) ?? null) : "";
    return { text: [P.SLEEP_PERSONA_DO(me.name, me.text), fix, text].filter(Boolean).join("\n\n"), material };
  }

  /** 这一段整理前的事件库（考整理前用）：host 没给、或者给不出来，就是 "live" */
  protected storeBefore(d: Day, s: StageSpec): string {
    try { return this.host.storeBefore?.(d.day, s.id) ?? "live"; } catch (e) {
      this.host.log.warn("sleep: no event-store copy for the before exam, using live", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) });
      return "live";
    }
  }

  /** 前面几段交上来的报告：它依赖的、跟它改同一个文件的（过了验证的才有） */
  private upstream(d: Day, s: StageSpec): string {
    return this.flow.stages
      .filter((o) => o.id !== s.id && (s.after.includes(o.id) || conflict(s, o)))
      .flatMap((o) => { const f = d.fates.get(o.id); return f?.kind === "passed" ? [S.runner.upstreamReport(o.title, f.done.report)] : []; })
      .join("\n\n");
  }

  /**
   * 交 stage_done 时当场核对（切换前 P2）：说的和实际改的对不上（bookkeeping，不跑点名的检查）、验证器的 precheck（考试：要压缩的每一处都出了题没有）。
   * 做不下去（blocked）的不核：照旧交给后面。核对自己出错了不拦（记 warn，照旧收下）
   */
  private precheck(d: Day, s: StageSpec, record: StageRecord, ctx: ValidateCtx): Precheck {
    if (record.status === "blocked") return { problems: [], targets: [] };
    const problems = bookkeeping(s, record);
    const targets: string[] = [];
    for (const v of this.o.validators) {
      if (!v.precheck) continue;
      try {
        const r = v.precheck(s, d.day, record, ctx);
        problems.push(...r.problems);
        for (const t of r.targets) if (!targets.includes(t)) targets.push(t);
      } catch (e) {
        this.host.log.warn("sleep: in-session check threw, not bouncing on it", { day: d.day, stage: s.id, validator: v.name, error: msg(e).slice(0, 200) });
      }
    }
    return { problems, targets };
  }

  /**
   * 开会话、叫醒、等它交 stage_done：一轮结束没交（或这一轮出错）就在同一个会话里催一次；再没交、超时都算没交。
   * check：交的时候当场核对；没过退回去（会话不关），每次尝试最多 MAX_BOUNCES 次，再交就照交的收下。
   * 退回以后这一轮结束了还没再交：再说一遍退回的问题（每次退回一次）；最后也没再交的，照最后交的那一次收（跟没有当场核对时一样）
   */
  private converse(d: Day, s: StageSpec, id: string, text: string, check?: (x: StageDone) => Precheck): Promise<Talk> {
    let sess: OpenedStage;
    try { sess = this.host.open({ id, stage: s, day: d.day, allowed: new Set([...s.tools, "stage_done"]) }); } catch (e) {
      return Promise.resolve({ done: null, error: S.teamrun.sessionFailed(msg(e)), fail: null, usage: null });
    }
    d.sessions.add(sess);
    return new Promise<Talk>((resolve) => {
      let got: StageDone | null = null;
      let error: string | null = null;
      let fail: string | null = null;
      let nudged = false;
      let warned = false;
      let over = false;
      let ended = false;
      /** 退回了几次；最后退回的那一次交的（最后没再交就收它）；退回以后这一轮还没结束、还没再说一遍的问题 */
      let bounces = 0;
      let bounced: StageDone | null = null;
      let unsaid: string[] | null = null;
      let unsaidTargets: string[] = [];
      const end = (why: string | null): void => {
        if (ended) return;
        ended = true;
        // 退回以后没再交：照最后交的那一次收，为什么结束的照样记进这一次的 error（修正轮 M4）
        if (!got && bounced) { got = bounced; if (why) error = why; }
        if (!got) error = why ?? S.teamrun.noStageDone;
        const settle = (usage: StageUsage | null) => { d.sessions.delete(sess); resolve({ done: got, error: fail ?? error, fail, usage, ...(over ? { overBudget: true } : {}), ...(bounces ? { bounces } : {}) }); };
        Promise.resolve().then(() => sess.close()).catch(() => {}).then(() => sess.settled).then((r) => settle(r.usage), () => settle(null));
      };
      sess.onDone((x) => {
        if (!got && !ended && check && bounces < MAX_BOUNCES) {
          let r: Precheck = { problems: [], targets: [] };
          try { r = check(x); } catch (e) { this.host.log.warn("sleep: in-session check threw, taking the hand-in", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
          if (r.problems.length) {
            bounces += 1;
            bounced = x;
            unsaid = r.problems;
            this.host.log.info("sleep: stage_done bounced in session", { day: d.day, stage: s.id, id, bounce: bounces, problems: r.problems.slice(0, 5), targets: r.targets });
            try { sess.bounced?.({ questionsFor: r.targets }); } catch (e) { this.host.log.warn("sleep: host failed to take the bounce", { id, error: msg(e).slice(0, 200) }); }
            unsaidTargets = r.targets;
            return P.SLEEP_STAGE_BOUNCED(r.problems, MAX_BOUNCES - bounces, r.targets);
          }
        }
        got ??= x;
        unsaid = null;
        return S.teamrun.handedIn;
      });
      // 一轮结束没交、这一轮出错，都在同一个会话里催一次（只催一次）；再这样就算没交
      sess.onTurnEnd((ok, err, use) => {
        if (ended) return;
        // 调用次数超了这一段的上限（budget.calls）、又还没交：算没过，不再催；这一轮里交了的照常收下
        if (use && overBudget(use, s.budget) && !got && !bounced) {
          fail = OVER_CALLS(s.budget.calls);
          over = true;
          return end(fail);
        }
        // 退回过、调用次数又超了：照最后交的那一次收（跟没有当场核对时一样，交给后面的检查），error 记上为什么
        if (got) return end(null);
        if (use && overBudget(use, s.budget)) return end(S.runner.callLimit(s.budget.calls));
        // 退回以后这一轮结束了还没再交：再说一遍退回的问题（快到上限的催收尾一起说，只说一次）
        if (unsaid) {
          const again = P.SLEEP_STAGE_BOUNCED_AGAIN(unsaid, unsaidTargets);
          unsaid = null;
          const near = use && !warned && nearBudget(use, s.budget) ? P.SLEEP_STAGE_NEAR_BUDGET(use.calls, s.budget.calls) : null;
          if (near) warned = true;
          try { sess.wake(near ? `${again}\n\n${near}` : again); } catch (e) { end(S.teamrun.cannotWake(msg(e))); }
          return;
        }
        // 快到上限（80%）还没交：催它收尾，一次（不算那一次「没交接着做」的催）
        if (use && !warned && nearBudget(use, s.budget)) {
          warned = true;
          try { sess.wake(P.SLEEP_STAGE_NEAR_BUDGET(use.calls, s.budget.calls)); } catch (e) { end(S.teamrun.cannotWake(msg(e))); }
          return;
        }
        if (nudged) return end(ok ? S.teamrun.nudgedNoStageDone : S.teamrun.roundFailed(err ?? S.final.noReason));
        nudged = true;
        try { sess.wake(P.SLEEP_STAGE_CONTINUE); } catch (e) { end(S.teamrun.cannotWake(msg(e))); }
      });
      sess.settled.then(
        (r) => end(d.abortWhy ? S.teamrun.aborted(d.abortWhy) : r.how === "timeout" ? S.teamrun.timedOut(s.budget.minutes) : S.teamrun.sessionEnded(r.how)),
        (e: unknown) => end(S.teamrun.sessionError(msg(e))),
      );
      try { sess.wake(text); } catch (e) { end(S.teamrun.cannotWake(msg(e))); }
    });
  }

  /** 这一次的变更记录：段交的 + 实际改了的（两份快照的 diff、这一次的批在事件库里记了几条 op） */
  protected recordOf(d: Day, s: StageSpec, n: number, region: string, done: StageDone, before: Snapshot, after: Snapshot): StageRecord {
    const files = diff(before, after);
    return {
      day: d.day, stage: s.id, attempt: n, status: done.status, ...(done.blockedWhy ? { blockedWhy: done.blockedWhy } : {}),
      changes: done.changes, report: done.report, uncertain: done.uncertain, proposals: done.proposals, bugs: done.bugs,
      actual: { files: [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), memOps: this.host.mem?.stageOps(region) ?? 0 },
    };
  }

  /** 写变更记录，再验证：机械检查没过就不再请验证器（省钱）；验证器照顺序，一个没过就停。快照用 ctx 里这一次尝试的 */
  private async validate(d: Day, s: StageSpec, n: number, region: string, done: StageDone, ctx: ValidateCtx, info: Checked | null = null): Promise<string[]> {
    const h = this.host;
    const record = this.recordOf(d, s, n, region, done, ctx.before, ctx.after);
    h.fs.write(recordPath(d.day, s.id, n), JSON.stringify(record, null, 2));
    const problems = await mechanical({ stage: s, record, checks: this.flow.checks, run: (argv) => h.run(argv, CHECK_MS), day: d.day });
    info?.checks.push({ name: S.runner.check.mechanical, result: problems.length ? capped(S.runner.failedWith(listed(problems))) : S.teamrun.passed });
    // 多人模式：什么都没改（没改文件、事件库没动）的不请验证器（核依据、交叉审、考试都不开），机械检查过了就过
    // 交了题、改题、退休（题库里这一段有待定的）的照样要验：不然落地时不考就生效
    if (info && record.actual.files.length === 0 && record.actual.memOps === 0 && this.examPending(d, s, n) === 0) info.skipped = true;
    if (problems.length) return problems;
    if (info?.skipped) return [];
    const notes: string[] = [];
    for (const [i, v] of this.o.validators.entries()) {
      let r: { pass: boolean; problems: string[]; by?: string };
      const name = CHECK_NAME[v.name] ?? v.name;
      try { r = await v.validate(s, d.day, record, ctx); } catch (e) {
        notes.push(S.runner.checkFailed(s.title, v.name, msg(e)));
        info?.checks.push({ name, result: S.runner.checkError(msg(e).slice(0, 200)) });
        continue;
      }
      if (info && r.by) info.reviewer = r.by;
      info?.checks.push({ name: r.by ? S.runner.checkBy(name, this.o.personas?.[r.by]?.name ?? r.by) : name, result: capped(r.pass ? (r.problems.length ? S.teamrun.passedWith(listed(r.problems)) : S.teamrun.passed) : S.runner.failedWith(listed(r.problems) || S.runner.noReasonWritten)) });
      if (!r.pass) {
        for (const w of this.o.validators.slice(i + 1)) info?.checks.push({ name: CHECK_NAME[w.name] ?? w.name, result: S.runner.notRun });
        return r.problems.length ? r.problems : [S.runner.checkNotPassed(v.name)];
      }
      if (r.problems.includes(S.validate.notDone)) notes.push(S.runner.stageNotAudited(s.title));
      else if (r.problems.includes(S.examiner.notExamined)) notes.push(S.runner.stageNotExamined(s.title));
      else if (r.problems.includes(S.review.notReviewed)) notes.push(S.runner.stageNotReviewed(s.title));
      else if (r.problems.length) notes.push(S.runner.stageProblems(s.title, v.name, r.problems.join(S.marks.clauseSep)));
    }
    d.notes.push(...notes);
    return [];
  }

  /** 推迟的段：最后一次改了的文件抄到 sleep/<日>/deferred/<段>/ 留着看 */
  protected keepDeferred(d: Day, s: StageSpec, before: Snapshot, after: Snapshot): void {
    for (const f of diff(before, after)) {
      const v = after.get(f.path);
      if (v) this.host.fs.write(`sleep/${d.day}/deferred/${s.id}/${f.path}`, v.text);
    }
  }

  // ---------- 全天考试、报告、落地 ----------

  /**
   * 全天考试：答错的题追到的段带着问题重做一次（在现在的提案上；过了的话报告接在第一次后面），再考一次；还错就照样落地，
   * 写进报告「拿不准」（spec §8.8）。考试给的 notes 写进报告最上面；花费到了绝对线，不重做（required 的照做）、不再考
   */
  private async finalPass(d: Day): Promise<void> {
    const check = this.o.finalCheck;
    if (!check) return;
    if (this.o.budget.overHard) { d.notes.push(S.runner.dayExamOverHard); return; }
    const ask = async (): Promise<Array<{ stage: string; problems: string[] }>> => {
      try {
        const r = await check(d.day);
        for (const t of r.notes ?? []) if (!d.notes.includes(t)) d.notes.push(t);
        return r.redo;
      } catch (e) { d.notes.push(S.runner.dayExamFailed(msg(e))); return []; }
    };
    const first = await ask();
    if (!first.length) return;
    for (const s of this.agents) {
      const problems = first.filter((x) => x.stage === s.id).flatMap((x) => x.problems);
      if (!problems.length || d.fates.get(s.id)?.kind !== "passed" || d.abortWhy) continue;
      if (this.o.budget.overHard && !s.required) {
        d.leftovers.push(S.runner.dayExamRedoOverHard(s.title, problems.join(S.marks.clauseSep)));
        continue;
      }
      const r = await this.attempt(d, s, problems, "keep");
      if (!r.passed) continue;
      const was = d.fates.get(s.id);
      d.fates.set(s.id, { kind: "passed", done: was?.kind === "passed" ? afterRedo(was.done, r.passed) : r.passed });
    }
    if (d.abortWhy) return;
    if (this.o.budget.overHard) { d.notes.push(S.runner.dayExamAfterRedoOverHard); return; }
    for (const x of await ask()) d.leftovers.push(S.runner.dayExamStillFails(this.titleOf(x.stage), x.problems.join(S.marks.clauseSep)));
  }

  private writeReport(d: Day): void {
    let hostNotes: string[] = [];
    try { hostNotes = this.host.dayNotes?.(d.day) ?? []; } catch (e) { this.host.log.warn("sleep: day notes unreadable", { day: d.day, error: msg(e).slice(0, 200) }); }
    const text = dayReport({
      d, hostNotes, agents: this.agents, scripts: this.preparing, budget: this.o.budget, titleOf: (id) => this.titleOf(id),
      ...(this.team ? { team: { name: (id: string) => this.o.personas?.[id]?.name ?? id, cost: (stage: string) => ({ ...this.costOf(`${d.day}/${stage}`), do: d.spent.get(stage) ?? 0 }), dayCost: this.costOf(`${d.day}/`) } } : {}),
    });
    this.host.fs.write(`sleep/${d.day}/report.md`, text);
  }

  /**
   * 落地：落地的脚本段（核对、finish）按 after 先后跑。finish 之前：finish 或 required 的落地脚本没过、叫停了 → 给出原因（这一天撤回）。
   * finish 退出码 0 就算落地了：后面的脚本没过、叫停（看门狗、hhd 停机）都只记进报告最上面，不撤回。
   * 落地了、又不是省电 / 材料不完整，引擎把这一天标完成（只标 d.day；spec §6.4）
   */
  private async land(d: Day): Promise<string | null> {
    const after: string[] = [];
    for (const s of this.landing) {
      if (d.abortWhy) {
        // 落地的脚本之间叫停了：后面的不跑；finish 之前叫停，这一天不落地
        if (!d.finished) return S.teamrun.aborted(d.abortWhy);
        after.push(S.runner.stoppedAfterLanding(d.abortWhy, s.title));
        break;
      }
      if (this.notToday(s, d)) continue;
      const r = await this.script(d, s);
      if (r.code === 0) continue;   // finish 的 0 在 script() 里一拿到就记了落地
      this.host.log.warn("sleep: landing script failed", { day: d.day, stage: s.id, code: r.code, out: r.out.slice(0, 300), landed: d.finished });
      if (d.finished) { after.push(S.runner.afterLandFailed(s.title, r.code, r.out.slice(0, 300))); continue; }
      if (s.id === "finish" || s.required) return S.runner.landFailed(s.title, r.code, r.out.slice(0, 300));
    }
    if (!d.finished) return S.runner.noFinish;
    if (d.complete) this.host.mem?.markDays([d.day]);
    if (after.length) this.prependReport(d, after);
    return null;
  }

  /** 报告已经写好、交给落地脚本以后要补的：加在最上面，不动脚本加的那几节 */
  private prependReport(d: Day, lines: string[]): void {
    const path = `sleep/${d.day}/report.md`;
    this.host.fs.write(path, `${lines.join("\n")}\n\n${this.host.fs.read(path) ?? ""}`);
  }

  /** 标完成的这一天里没做成的段记进欠着的单子（carry: drop 的不记）；没标完成的日子下一晚整天重来，不记 */
  private recordOwed(d: Day): Array<{ day: string; stage: string }> {
    const out: Array<{ day: string; stage: string }> = [];
    for (const s of this.agents) {
      const problems = s.carry === "drop" ? null : owedProblems(d.fates.get(s.id), (id) => this.titleOf(id));
      if (!problems) continue;
      L.owe(this.host.db, d.day, s.id, problems, this.host.now());
      out.push({ day: d.day, stage: s.id });
    }
    return out;
  }

  // ---------- 小工具 ----------

  /**
   * 跑一个脚本段：{day} 换成日子，{partial} 在省电模式、材料不完整时换成 --partial（finish 落地、提交，但不标这一天做完），
   * 完整的一天去掉这个词
   */
  private async script(d: Day, s: StageSpec): Promise<{ code: number; out: string }> {
    const h = this.host;
    const argv = (s.command ?? []).flatMap((a) => (a === "{partial}" ? (d.complete ? [] : ["--partial"]) : [a.replaceAll("{day}", d.day)]));
    const row = L.startStage(h.db, { runId: this.runId, day: d.day, stage: s.id, attempt: this.nextAttempt(d, s.id), model: "script" }, h.now());
    let r: { code: number; out: string };
    try { r = await h.run(argv, s.budget.minutes * 60_000); } catch (e) { r = { code: -1, out: S.runner.cannotRun(msg(e)) }; }
    // finish 退出码 0：这一天就落地了，先于一切（记账抛错也不能把它变回没落地）；prepared.json 马上删——
    // 落地了的一天（省电、材料不完整的还会再来）下一次决不能当成没收尾、从头来（那会撤掉已经落地的批次）
    if (s.id === "finish" && r.code === 0) {
      d.finished = true;
      try { h.fs.remove(d.preparedPath); } catch (e) { h.log.error("sleep: removing prepared.json after finish failed", { day: d.day, error: msg(e).slice(0, 300) }); }
      // 落地了：过了验证的段告诉 host（题库里它们的待定题生效）；出错只记日志，落地照算
      const passed = this.agents.filter((x) => d.fates.get(x.id)?.kind === "passed").map((x) => x.id);
      try { h.landed?.(d.day, passed); } catch (e) { h.log.error("sleep: host failed to take the landed day", { day: d.day, stages: passed, error: msg(e).slice(0, 300) }); }
    }
    L.endStage(h.db, row, {
      status: r.code === 0 ? "passed" : "failed",
      verdict: (r.out.split("\n", 1)[0] ?? "").slice(0, 200),
      error: r.code === 0 ? "" : r.out.slice(0, 200),
    }, h.now());
    d.fates.set(s.id, { kind: "script", code: r.code, out: r.out });
    return r;
  }

  /** 今天不跑的理由（关着、when 不满足、省电模式、材料不完整）；今天要跑给 null */
  private notToday(s: StageSpec, d: Day): string | null {
    if (!s.enabled) return S.runner.why.off;
    for (const w of s.when) {
      if (w === "sunday" && !isSunday(d.day)) return S.runner.why.sundays;
      if (w === "material-full" && d.partial) return S.runner.why.material;
      if (w === "backlog<=1" && d.backlog > 1) return S.runner.why.backlog(d.backlog);
    }
    if (s.kind === "agent" && d.save && !this.flow.saveMode.includes(s.id)) return S.runner.why.saving;
    if (s.kind === "agent" && d.partial && s.needsDialogue) return S.runner.why.materialTalk;
    return null;
  }

  /** 对下游来说算过了：过了验证、今天不跑、脚本退出码 0；builtin 段在引擎外做（睡前、收尾），一律算过了 */
  private satisfied(d: Day, id: string): boolean {
    if (this.byId.get(id)?.kind === "builtin") return true;
    const f = d.fates.get(id);
    return f?.kind === "passed" || f?.kind === "not-today" || (f?.kind === "script" && f.code === 0);
  }

  protected abortDay(d: Day, why: string): void {
    if (d.abortWhy) return;
    d.abortWhy = why;
    this.host.log.warn("sleep: day stopped", { day: d.day, why });
    for (const s of d.sessions) Promise.resolve().then(() => s.close()).catch(() => {});
  }

  /**
   * 外面叫停（hhd 停机）：跟看门狗一样——不开新的一天，手上这一天中止（开着的段关掉、算中止，不重做、不推迟、不落地，
   * 今晚的批次撤回、提案恢复）。runNight 结束以后再叫没有用
   */
  abort(why: string): void {
    if (this.over || this.stopped) return;
    this.stopped = "aborted";
    this.host.log.warn("sleep: night aborted", { why, day: this.current?.day ?? null });
    if (this.current) this.abortDay(this.current, why);
    // 正在等前额叶的那一次别等到它超时：关掉它，那一份按规矩走（这一天反正中止了）
    this.closeCoordinator();
  }

  private watchdog(): void {
    if (this.over || this.stopped) return;
    this.stopped = "watchdog";
    this.host.log.warn("sleep: watchdog fired", { afterMs: this.o.watchdogMs, day: this.current?.day ?? null });
    if (this.current) this.abortDay(this.current, S.runner.watchdogDue);
    this.closeCoordinator();
  }

  /** 这一段在题库里待定的题和 op（host 没给 = 0）；读不出来当作有（照常验） */
  private examPending(d: Day, s: StageSpec, attempt: number): number {
    try { return this.host.examPending?.(d.day, s.id, attempt) ?? 0; } catch (e) {
      this.host.log.warn("sleep: exam bank unreadable, validating the unchanged attempt anyway", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) });
      return 1;
    }
  }

  /** 前额叶的会话一夜一个：这一夜完了、叫停了就关（不等它关完：关不掉也不能把这一夜卡住；出错记日志）；关过了再关没事 */
  private closeCoordinator(): void {
    const c = this.o.coordinator;
    if (!c) return;
    const warn = (e: unknown): void => this.host.log.warn("sleep: closing the coordinator failed", { error: msg(e).slice(0, 200) });
    try { c.close().catch(warn); } catch (e) { warn(e); }
  }

  protected nextAttempt(d: Day, id: string): number {
    return d.nextAttempt(id, () => one<{ n: number | null }>(this.host.db, "SELECT max(attempt) n FROM sleep_stage WHERE day = ? AND stage = ?", d.day, id)?.n ?? 0);
  }

  protected titleOf(id: string): string { return this.byId.get(id)?.title ?? id; }

  /**
   * 手上这一天今晚过了的尝试改过的文件（相对工作区的路径）：before 是今晚以前的样子，after 是现在（最后一次过了的）的样子；
   * 考试用：只在仓库那层看挪走的那行还在不在、开头用前面几段改过的基础块。不是手上这一天给两个空的
   */
  tonight(day: string): { before: Map<string, string | null>; after: Map<string, string | null> } {
    const d = this.current;
    if (!d || d.day !== day) return { before: new Map(), after: new Map() };
    return { before: new Map(d.tonight.before), after: new Map(d.tonight.after) };
  }

  /** 这一夜开始的那一刻（全天考试：今晚考过的、今晚以前的判定都按结果记下的时刻跟它比） */
  startedAt(): number { return this.started; }

  /** 手上这一天现在算过了的段（考试叫它们申请的改题、退休今晚就算）；不是手上这一天给 [] */
  passedStages(day: string): string[] {
    const d = this.current;
    if (!d || d.day !== day) return [];
    return this.agents.filter((s) => d.fates.get(s.id)?.kind === "passed").map((s) => s.id);
  }

  /**
   * 全天考试要的：手上这一天每次过了的尝试（按过的先后；全天考试叫的重做过了，同一段有两条）和那一次的变更记录
   * （validate 写的那份）。不是手上这一天给 []；记录读不出来的那一条记 warn、不给
   */
  passed(day: string): Array<{ stage: string; record: StageRecord }> {
    const d = this.current;
    if (!d || d.day !== day) return [];
    const out: Array<{ stage: string; record: StageRecord }> = [];
    for (const { stage, n } of d.passes) {
      if (d.fates.get(stage)?.kind !== "passed") continue;
      let record: StageRecord | null = null;
      try {
        const text = this.host.fs.read(recordPath(day, stage, n));
        if (text !== null) record = JSON.parse(text) as StageRecord;
      } catch { /* 下面记 */ }
      if (record) out.push({ stage, record });
      else this.host.log.warn("sleep: passed stage's record unreadable", { day, stage, attempt: n });
    }
    return out;
  }
}

/** 全天考试叫的重做过了：报告留着第一次交的，后面接上重做的；拿不准、提案、毛病合在一起（去重） */
function afterRedo(first: StageDone, redo: StageDone, label = S.runner.afterDayExam): StageDone {
  const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
  return {
    ...redo,
    report: [first.report.trim(), S.runner.redoReport(label, redo.report.trim())].filter(Boolean).join("\n\n"),
    uncertain: union(first.uncertain, redo.uncertain), proposals: union(first.proposals, redo.proposals), bugs: union(first.bugs, redo.bugs),
  };
}

/** 欠着的段写什么问题；不欠给 null */
function owedProblems(f: Fate | undefined, titleOf: (id: string) => string): string[] | null {
  if (f?.kind === "deferred") return f.problems;
  if (f?.kind === "followed") return [S.runner.followed(titleOf(f.upstream))];
  if (f?.kind === "budget") return [S.runner.notOpenedOverHard];
  return null;
}

/** 报告（spec §7）：最上面是要显眼的几行和这一天的记账，下面按段放各段交的那一小节，再列拿不准的、给主人的提案、毛病 */
function dayReport(o: {
  d: Day; hostNotes: string[]; agents: StageSpec[]; scripts: StageSpec[]; budget: Budget; titleOf(id: string): string;
  /** 多人模式：persona 的名字、各段各花了多少（做的是 d.spent 里的）、不归哪一段的（全天考试） */
  team?: { name(id: string): string; cost(stage: string): Cost; dayCost: Cost };
}): string {
  const { d, budget } = o;
  const pct = (u: number) => (u / budget.unitsPerPct).toFixed(2);
  const out: string[] = [S.runner.report.title(d.day), ""];

  const top = [...(d.abortWhy ? [S.runner.dayNotLanded(d.abortWhy)] : []), ...new Set([...o.hostNotes, ...d.notes])];
  if (top.length) out.push(...top, "");

  out.push(S.runner.report.accounts);
  if (d.save) out.push(S.runner.report.savingMode);
  if (d.partial) out.push(S.runner.report.materialMode);
  const dayUnits = [...d.spent.values()].reduce((a, b) => a + b, 0);
  out.push(S.runner.report.spending(Math.round(dayUnits), pct(dayUnits), budget.pct.toFixed(2), budget.targetPct, budget.hardPct));
  for (const s of o.scripts) {
    const f = d.fates.get(s.id);
    if (f?.kind === "script") out.push(S.runner.report.prepared(s.title, f.code));
    else if (f?.kind === "not-today") out.push(S.runner.report.prepareSkipped(s.title, f.why));
  }
  for (const s of o.agents) {
    const f = d.fates.get(s.id);
    const n = d.tries.get(s.id) ?? 0;
    const cost = S.runner.report.cost(n, Math.round(d.spent.get(s.id) ?? 0));
    if (!f) continue;
    // 挂了脑区的段：名字后面带上脑区
    const t = s.region ? S.runner.report.stageRegion(s.title, s.region) : s.title;
    if (f.kind === "passed") out.push(S.runner.report.passed(t, cost));
    else if (f.kind === "deferred") out.push(S.runner.report.deferred(t, cost, f.problems.join(S.marks.clauseSep)));
    else if (f.kind === "followed") out.push(S.runner.report.followed(t, o.titleOf(f.upstream)));
    else if (f.kind === "budget") out.push(S.runner.report.overHard(t));
    else if (f.kind === "not-today") out.push(S.runner.report.notToday(t, f.why));
    else if (f.kind === "aborted") out.push(S.runner.report.unfinished(t, f.why, n ? S.runner.report.costSuffix(cost) : ""));
  }
  if (!d.abortWhy && d.complete) {
    const owed = o.agents.filter((s) => owedProblems(d.fates.get(s.id), o.titleOf));
    const carry = owed.filter((s) => s.carry !== "drop").map((s) => s.title);
    const dropped = owed.filter((s) => s.carry === "drop").map((s) => s.title);
    if (carry.length) out.push(S.runner.report.carry(carry.join(S.marks.listSep)));
    if (dropped.length) out.push(S.runner.report.dropped(dropped.join(S.marks.listSep)));
  }
  out.push("");

  if (o.team) out.push(...teamSection(d, o.agents, o.team));

  const passed = o.agents.flatMap((s) => { const f = d.fates.get(s.id); return f?.kind === "passed" ? [{ s, done: f.done }] : []; });
  if (passed.length) {
    out.push(S.runner.report.stages);
    for (const { s, done } of passed) out.push(`### ${s.title}`, done.report.trim() || S.runner.report.notWritten, "");
  }
  // 推迟了的段最后一次交的拿不准、提案、毛病也列上
  const told = o.agents.flatMap((s) => {
    const f = d.fates.get(s.id);
    if (f?.kind === "passed") return [{ who: s.title, done: f.done }];
    return f?.kind === "deferred" && f.done ? [{ who: S.runner.report.deferredWho(s.title), done: f.done }] : [];
  });
  const list = (title: string, pick: (x: StageDone) => string[], extra: string[] = []) => {
    const items = [...told.flatMap(({ who, done }) => pick(done).map((t) => S.runner.report.item(who, t))), ...extra.map((t) => `- ${t}`)];
    if (items.length) out.push(title, ...items, "");
  };
  list(S.runner.report.unsure, (x) => x.uncertain, d.leftovers);
  list(S.runner.report.proposals, (x) => x.proposals);
  list(S.runner.report.bugs, (x) => x.bugs);
  return out.join("\n");
}

const DECISION: Record<Round["decision"], string> = { get pass() { return S.runner.decision.pass; }, get polish() { return S.runner.decision.polish; }, get redo() { return S.runner.decision.redo; }, get defer() { return S.runner.decision.defer; }, get keep() { return S.runner.decision.keep; }, get abort() { return S.runner.decision.abort; } };
const r0 = (x: number): number => Math.round(x);
/** 「做 x / 审 y / 核 z / 考 w / 协调 c」（单位，取整）：回放的对照表照这一行读 */
export const costLine = (c: Cost): string => S.runner.costLine(r0(c.do), r0(c.review), r0(c.audit), r0(c.exam), r0(c.coord));

/** 多人模式的报告一节：每段挂在哪个脑区，每一次谁做、谁审、过没过、怎么定的，和各花了多少 */
function teamSection(d: Day, agents: StageSpec[], team: { name(id: string): string; cost(stage: string): Cost; dayCost: Cost }): string[] {
  const out: string[] = [];
  for (const s of agents) {
    const rs = d.rounds.get(s.id);
    if (!rs?.length) continue;
    out.push(`### ${s.title}${s.region ? S.runner.regionNote(s.region) : ""}`);
    rs.forEach((r, i) => {
      const who = r.doer ? `${team.name(r.doer)}${i === 0 ? S.runner.who.did : S.runner.who.fixed}` : S.runner.who.doing;
      const rev = r.skipped ? S.runner.rev.skipped : r.reviewer ? S.runner.rev.by(team.name(r.reviewer)) : S.runner.rev.none;
      const res = r.ok ? S.teamrun.passed : S.runner.failedWith(r.problems.join(S.marks.clauseSep).slice(0, 300));
      const decided = r.notDone ? S.runner.polishNotDone(r.notDone) : DECISION[r.decision];
      out.push(S.runner.tryLine(r.n, who, rev, res, decided, r.by === "coord" ? S.runner.by.coord : S.runner.by.rule));
    });
    out.push(S.runner.spent(costLine(team.cost(s.id))));
    out.push("");
  }
  if (!out.length) return [];
  const day = team.dayCost;
  if (day.exam + day.review + day.audit + day.coord > 0) out.push(S.runner.dayCost(costLine(day)), "");
  return [S.runner.report.team, ...out];
}
