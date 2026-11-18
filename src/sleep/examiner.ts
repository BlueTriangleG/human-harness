// 一段的考试（spec §8.1–§8.4、§8.7）：挑题 → 要压缩的每一处都出了题吗 → 考整理后（常驻、查得到各开一个考生，
// 只在仓库的查出处）→ 一次判完 → 错的重考一次 → 还错的旧题补考整理前（重考和整理前同一个判分会话判）→ 过门槛 → 记结果。
// 考试会话两次都坏了、或者里头出了没想到的错：这一段不算没过，runner 在报告最上面写「X 段没考完」。
import { all, type Db } from "../store/db.ts";
import type { Logger } from "../log.ts";
import { SCORE, type Bank, type Layer, type Op, type Question, type Tags, type Verdict } from "./bank.ts";
import { MEM_ID, mentions, thing } from "./things.ts";
import { appendixText, checkArchive, examineLayer, grade, grading, injectedFile, lineKept, markStripper, pathRef, plainInjection, questionProblem, type ExamHost } from "./exam.ts";
import { matchWrites, type FlowConfig, type StageExam, type StageSpec } from "./flow.ts";
import { setHidden } from "./hidden.ts";
import { setStageExam } from "./ledger.ts";
import type { Model } from "./flow.ts";
import type { LadderPlan } from "./ladder.ts";
import type { StageRecord } from "./record.ts";
import type { Precheck, StageValidator, ValidateCtx } from "./validate.ts";
import { P, S } from "../lang/index.ts";

/** 考试会话两次都坏了时验证器给的话：runner 认它，写成报告最上面的「<段名> 段没考完」 */

export interface ExaminerOpts {
  host: ExamHost; bank: Bank; flow: FlowConfig; db: Db; rnd: () => number; ladder: () => LadderPlan;
  /** 这一天今晚在这一段之前过了的段（runner 给）：它们申请的改题、退休今晚就算（spec §8.6） */
  passed?: (day: string) => string[];
  /** 这一天今晚过了的尝试改过的文件（runner.tonight）：只在仓库那层看挪走的那行是不是挪进了它们 */
  tonight?: (day: string) => { before: Map<string, string | null>; after: Map<string, string | null> };
  log?: Pick<Logger, "warn">;
}

type Phase = "after" | "retake" | "before";
interface Mark { verdict: Verdict; reason: string; answer: string }

/** 一道题这一次的卷子 */
interface Paper {
  q: Question;
  /** 这一次在哪一层考：这一段的 affects 写了新层就照它，不然是题自己的层；判分判了更低的层、在原来那层没答对的，重考挪到判的那层 */
  layer: Layer;
  /** 判分判了更低的层，重考在那层考（spec §8.2：在原来那层答错不算倒退） */
  moved?: boolean;
  /** 这一段今天交的、问今天新要点的题：只考整理后，不补考整理前，按 newRate 过门槛 */
  fresh: boolean;
  /** 暗题：整理的人没见过；只考整理后（和重考），记 hidden 阶段，不补考整理前 */
  hidden?: boolean;
  /** 只是抽到的（不挂在改过的东西上、不是这一段的）：答不好只记一句，不拦、不补考整理前（final fix M2） */
  sampled?: boolean;
  /**
   * 这一段申请了改题（q.gold 是新的标准答案）：整理前那轮照这个判——这一段之前的标准答案（今晚前面过了的段改过的，
   * 不然是题库里的）。改题没写进记忆的，整理后答旧的就是倒退（plan 3 A4）
   */
  beforeGold?: string;
  after?: Mark; retake?: Mark; before?: Mark;
  /** 整理前那一场没法考（写事件库的段、整理前的拷贝没拷成）：before 是照「做题的时候答得出」保守记的，不是考出来的（终审修正轮 M1） */
  assumed?: boolean;
}

/** 一段考下来攒的：几道题、落地时要改层的 op（过了才记）、affects 写了的题、考完了的那几轮的分（后面坏了也照记） */
interface Tally { questions: number; ops: Op[]; declared: string[]; scoreAfter: number | null; scoreBefore: number | null; hiddenScore: number | null }

/**
 * 一个状态（整理后 / 整理前）考生看到的：注入（改过的文件里明天会注入前缀的那几个：基础块、exam.inject 点名的）、
 * 查得到那层的附录（改过的别的文件，那个状态的样子）；注入预览没拼成给理由（这时注入是原样的文件，只给查得到那层用）
 */
interface View { injection: string; appendix: string; failed: string | null }

/** 这一次考试的场地：会话 id 的前半、开头、两个状态考生看到的（用到才拼，拼一次） */
interface Room {
  o: ExaminerOpts; stage: StageSpec; day: string; ctx: ValidateCtx;
  base: string; opening: string; view: (state: "after" | "before") => Promise<View>;
  /** 考生、判分都不让读的：sleep/（今晚的整理）和这一段改过的文件（答案从注入里给，旧版本不能翻） */
  hide: string[];
  /** 判分、出暗题用的模型：省钱阶梯到了 cheap 就用 sonnet（考生的不变） */
  grader: Model;
  /** 注入预览没拼成的理由：从那以后常驻那层不考、不算（不拿原样的文件冒充明天的样子）；没出事是 null */
  residentOff: string | null;
  /** 整理后那几轮「路径:行」的出处还在不在（lineKept：挪走的那行得还在今晚改过的文件里） */
  kept: (ref: string) => boolean;
  /** 出处在这一段整理前查得到吗：只在仓库那几轮只照这些出处判（评审 K1c） */
  resolves: (ref: string) => boolean;
  /** 能不能放进只在仓库（noArchive 用） */
  lineOk: LineOk;
  /** 重考和整理前那轮共用的判分会话（用到才开；final fix M3），考完关 */
  later: ReturnType<typeof grading> | null;
  /** 考生看的中期视图（exam.residentMemory 开着才有，用到才拼，每个状态拼一次）：拼不出来给理由 */
  memory: (state: "after" | "before") => { text: string; failed: string | null };
  /**
   * 整理前那份中期视图靠不住（写事件库的段、整理前的拷贝没拷成：现在的库里已经有这一段写的；终审修正轮 M1）。没出这事是 false
   */
  untrusted: () => boolean;
  /** 整理前那一场才发现的毛病（注入预览、中期视图拼不出来）：跟 untrusted 一样只跳过常驻那层的整理前（R1）；没出事是 null */
  beforeFailed: string | null;
  /** 常驻那层的整理前那一场为什么不能考（untrusted 或 beforeFailed）；能考给 null */
  beforeOff: () => string | null;
  /** 真的跳过了常驻那层的整理前那一场：为什么（报告里写一句） */
  beforeSkipped: string | null;
}

/** 考生或判分会话两次都坏了 */
class Broken extends Error {}

/** 标着这些的改动算压缩（另外照实际的 diff 看：整理前的哪一行整理后没了也算） */
const COMPRESS = /^(compress|fade|merge|rewrite|remove|archive|shorten|change|改写|降一级|挪进档案|压缩|合并|删|缩短|淡)/;
const ORDER: Layer[] = ["resident", "searchable", "archive"];

const LAYER_NAME: Record<Layer, string> = { get resident() { return S.examiner.layerName.resident; }, get searchable() { return S.examiner.layerName.searchable; }, get archive() { return S.examiner.layerName.archive; } };
/** 层的深浅：常驻最浅，只在仓库最深 */
const DEPTH: Record<Layer, number> = { resident: 0, searchable: 1, archive: 2 };
const VERDICT_NAME: Record<Verdict, string> = { get right() { return S.examiner.verdictName.right; }, get partial() { return S.examiner.verdictName.partial; }, get wrong() { return S.examiner.verdictName.wrong; } };
const SITTING = ["resident", "searchable"] as const;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round2 = (x: number): number => Math.round(x * 100) / 100;
/** 整理后算数的那次：错了重考过的看重考 */
const afterOf = (p: Paper): Verdict => (p.retake ?? p.after)!.verdict;
/** 重要度 4–5 的题：今天新的要全对，旧的整理后不能比整理前差 */
const important = (p: Paper): boolean => p.q.importance >= 4;
/** 写了「路径:行」的出处（不管查不查得到） */
const hasLine = (q: Question): boolean => q.sources.some((s) => pathRef(s) !== null);
/**
 * 能放进只在仓库：只在仓库那层照「路径:行」判（checkArchive），只写编号判不出那段原文还在（plan 3 A1 的同一类）。
 * 段的考试照「至少一条路径:行在这一段整理前查得到」（行号过了头的不算：评审 K1）；全天考试不知道各段的整理前，只看写没写
 */
type LineOk = (q: Question) => boolean;
/**
 * 这道题不能放进只在仓库：过不了 lineOk。题库里本来就在只在仓库、一条「路径:行」都没写的（导进来的旧题）不算——
 * 不是挪；写了「路径:行」却整理前都查不到的算（评审 V3：按查得到考了，判分也不能再把它挪回去）
 */
const noArchiveFor = (q: Question, lineOk: LineOk): boolean => !lineOk(q) && !(q.layer === "archive" && !hasLine(q));
/** 挪进只在仓库、却过不了 lineOk 的题按查得到算（affects 写的、判分判的都一样），记一句 */
const noArchive = (q: Question, to: Layer, notes: string[], lineOk: LineOk): Layer => {
  if (to !== "archive" || !noArchiveFor(q, lineOk)) return to;
  const line = hasLine(q)
    ? S.examiner.archiveUnfound(q.q, q.id)
    : S.examiner.archiveNoSource(q.q, q.id);
  if (!notes.includes(line)) notes.push(line);
  return "searchable";
};

/** 出处在这一段整理前查得到吗（开始时的快照 → 它的范围里没进快照的看工作区 → 别的看提案、再看工作区：beforeContent） */
const resolverBefore = (o: ExaminerOpts, stage: StageSpec, day: string, ctx: ValidateCtx): ((ref: string) => boolean) => {
  const where = { day, state: "before" as const, files: ctx.before, writes: stage.writes };
  return (ref) => o.host.sourceExists(ref, where);
};

/**
 * 整理前那轮的标准答案：今晚前面过了的段和这一段以前几次（过了的；没过的已经撤回了）申请、还没执行的改题，
 * 照记下的先后叠（后记的算），跟整理后那轮的同一个叠法，只去掉这一段这一次（和以后）的。
 * 全天考试叫的重做：前一次过了的样子加上后来别的段改的，就是这一次的整理前（评审 K2、V4）
 */
function beforeGold(db: Db, day: string, stages: string[], stage: string, attempt: number): Map<string, string> {
  const gold = new Map<string, string>();
  if (!stages.length) return gold;
  const rows = all<{ stage: string; q: string; value: string; attempt: number | null }>(db,
    `SELECT stage, q, value, attempt FROM exam_op WHERE status = 'pending' AND kind = 'revise' AND day = ? AND stage IN (${stages.map(() => "?").join(",")}) ORDER BY id`,
    day, ...stages);
  for (const r of rows) {
    if (r.stage === stage && (r.attempt === null || r.attempt >= attempt)) continue;
    gold.set(r.q, String((JSON.parse(r.value) as { gold?: unknown }).gold ?? ""));
  }
  return gold;
}

export function examValidator(o: ExaminerOpts): StageValidator {
  return {
    name: "exam",
    async validate(stage, day, record, ctx) {
      if (!stage.exam) return { pass: true, problems: [] };
      const tally: Tally = { questions: 0, ops: [], declared: [], scoreAfter: null, scoreBefore: null, hiddenScore: null };
      try {
        if (!ctx) throw new Error(S.examiner.noSnapshot);
        return await sit(o, stage, stage.exam, day, record, ctx, tally);
      } catch (e) {
        o.log?.warn(e instanceof Broken ? "sleep: exam session failed twice, stage not examined" : "sleep: exam threw, stage not examined",
          { day, stage: stage.id, attempt: record.attempt, error: msg(e).slice(0, 300) });
        settle(o, stage, day, record, tally, { examined: 0, pass: true });
        return { pass: true, problems: [S.examiner.notExamined] };
      }
    },
    // 切换前 P2：交 stage_done 时当场查要压缩的每一处都出了题没有（跟考试开头的覆盖检查同一份代码），没出的退回去补
    precheck(stage, day, record, ctx) {
      if (!stage.exam) return { problems: [], targets: [] };
      const p = prelude(o, stage, day, record, ctx);
      return coverage(o, stage, day, record, p.own, p.decl, ctx, []);
    },
  };
}

/**
 * 考试和当场核对共用的开头：今晚申请的改题、退休（这一段的、今晚在它前面过了的段的）叠上去；这一段自己交的题（去掉申请了退休的、
 * 换上新的标准答案）；整理前查得到的出处；affects 写的算数的
 */
function prelude(o: ExaminerOpts, stage: StageSpec, day: string, record: StageRecord, ctx: ValidateCtx) {
  const earlier = (o.passed?.(day) ?? []).filter((s) => s !== stage.id);
  const ov = overlayOf(o.bank, day, [stage.id, ...earlier]);
  const mine = o.bank.pending(day, stage.id).filter((q) => !q.hidden);
  const own = mine.filter((q) => !ov.retired.has(q.id)).map((q) => withGold(ov, q));
  const resolves = resolverBefore(o, stage, day, ctx);
  const lineOk: LineOk = (q) => q.sources.some((s) => pathRef(s) !== null && resolves(s));
  // 申请了退休的题什么都不护（plan 3 A3）：affects 点名它不算出了题、不定层
  const decl = declaredOf(o.bank, record, day, ov.retired, lineOk, parentsVia(o.host, record));
  return { earlier, ov, mine, own, resolves, lineOk, decl };
}

/** 一段考一次：照 spec §8.1 的顺序 */
async function sit(o: ExaminerOpts, stage: StageSpec, exam: StageExam, day: string, record: StageRecord, ctx: ValidateCtx, tally: Tally): Promise<{ pass: boolean; problems: string[] }> {
  // 今晚申请的改题、退休（这一段的、今晚在它前面过了的段的）：改了的照新答案考，退休的不考（spec §8.6）
  const { earlier, ov, mine, own, lineOk, decl } = prelude(o, stage, day, record, ctx);
  const notes: string[] = [];
  for (const q of mine) if (ov.retired.has(q.id)) notes.push(retiredNote(q));
  notes.push(...decl.notes);
  // 这一段申请了改题的都考（评审 K7/K8）：改了没写进记忆的，在申请的这一段就是倒退（没过的这一次，改题撤回）
  const revised = [...overlayOf(o.bank, day, [stage.id]).gold.keys()];
  const { papers, touched } = pick(o, exam, record, own, decl, ov, notes, revised);
  // 已经在只在仓库、写了「路径:行」却整理前都查不到的：只在仓库那层判不了，按查得到考（评审 K1c）。
  // 这一段自己交的、引的是今天新加的行（整理后查得到）：说是今天新加的（评审 W2）
  const ownIds = new Set(own.map((q) => q.id));
  for (const p of papers) {
    if (p.layer !== "archive" || !hasLine(p.q) || lineOk(p.q)) continue;
    p.layer = "searchable";
    const added = ownIds.has(p.q.id) && p.q.sources.some((s) => pathRef(s) !== null && o.host.sourceExists(s, { day, state: "after" }));
    const line = added ? S.examiner.sourceNewToday(p.q.q, p.q.id) : S.examiner.sourceUnfound(p.q.q, p.q.id);
    if (!notes.includes(line)) notes.push(line);
  }
  // 整理前那轮的标准答案：跟整理后那轮同一个叠法（按记下的先后），只去掉这一段这一次的
  beforeGolds(o.bank, papers, ov, { gold: beforeGold(o.db, day, [stage.id, ...earlier], stage.id, record.attempt), retired: new Set() });
  tally.questions = papers.length;
  tally.declared = [...decl.layers.keys(), ...decl.important];
  tally.ops.push(...affectsOps(o.bank, decl));

  const uncovered = coverage(o, stage, day, record, own, decl, ctx, notes).problems;
  if (uncovered.length) return { pass: false, problems: uncovered };
  // 一道题都没有：不拼注入、不开会话
  if (!papers.length) {
    settle(o, stage, day, record, tally, { examined: 1, pass: true, regressions: 0 });
    return { pass: true, problems: notes };
  }

  const room = seat(o, stage, day, record, ctx);
  try {
    return await sitIn(o, stage, exam, day, record, tally, room, { papers, touched, decl, notes });
  } finally {
    await room.later?.close();
  }
}

/** 场地开好以后：出暗题 → 整理后 → 重考 → 整理前 → 门槛 → 记结果 */
async function sitIn(o: ExaminerOpts, stage: StageSpec, exam: StageExam, day: string, record: StageRecord, tally: Tally, room: Room,
  x: { papers: Paper[]; touched: Question[]; decl: Declared; notes: string[] }): Promise<{ pass: boolean; problems: string[] }> {
  const { papers, touched, decl, notes } = x;
  const declared = decl.layers;
  const wantHidden = exam.hidden > 0 && o.ladder().hidden;
  const hiddenOk = !wantHidden || await hiddenQuestions(room, exam);
  const hiddenPapers = !wantHidden ? [] : o.bank.pending(day, stage.id).filter((q) => q.hidden)
    .map((q): Paper => ({ q, layer: q.layer, fresh: true, hidden: true }));
  // 暗题只在这一轮和重考里考；分数、倒退、整理前都只算这一段自己的题
  const asked = [...papers, ...hiddenPapers];
  // 问判分该在哪层：挂在改过的东西上的旧题（affects 没写的）、重要度 ≥ 4 写了 affects 的（判分同意才挪）
  const askLayers = [...new Map([...touched.filter((q) => !declared.has(q.id)), ...papers.filter((p) => decl.important.has(p.q.id)).map((p) => p.q)]
    .map((q): [string, Question] => [q.id, q])).values()];
  const said = await round(room, "after", asked, askLayers);
  // 判分判了只在仓库、题没有「路径:行」出处：按查得到（不挪进只在仓库、不在那层重考、落地也不挪）
  // 本来就在只在仓库、「路径:行」整理前都查不到的（按查得到考的）：判分说只在仓库就当没说——不挪、不写改层的 op（评审 V3）
  const calls = new Map<string, Layer>();
  for (const [id, layer] of said) {
    const q = askLayers.find((x) => x.id === id);
    if (q && layer === "archive" && q.layer === "archive" && noArchiveFor(q, room.lineOk)) continue;
    calls.set(id, q ? noArchive(q, layer, notes, room.lineOk) : layer);
  }
  tally.ops.push(...graderOps(askLayers, calls));
  movedByGrader(asked, askLayers, calls, room.lineOk);
  /** 算数的题：注入预览没拼成以后，常驻那层的不算 */
  const live = (ps: Paper[]): Paper[] => ps.filter((p) => !(room.residentOff && p.layer === "resident"));
  tally.scoreAfter = mean(live(papers).map((p) => SCORE[afterOf(p)]));
  await retake(room, live(asked));
  tally.scoreAfter = mean(live(papers).map((p) => SCORE[afterOf(p)]));
  tally.hiddenScore = mean(live(hiddenPapers).map((p) => SCORE[afterOf(p)]));
  await before(room, live(papers), exam);
  // 记下的分数跟把关用的同一批题（整理前那一场才发现预览拼不出来、常驻那层不算了，整理后的分也重算；终审修正轮 M1）；
  // 照倒退算的整理前（assumed）不是考出来的，不进整理前的分
  tally.scoreAfter = mean(live(papers).map((p) => SCORE[afterOf(p)]));
  tally.hiddenScore = mean(live(hiddenPapers).map((p) => SCORE[afterOf(p)]));
  tally.scoreBefore = mean(live(papers).flatMap((p) => (p.before && !p.assumed ? [SCORE[p.before.verdict]] : [])));

  const g = gates(exam, live(papers), exam.hiddenGates ? live(hiddenPapers) : []);
  g.notes.unshift(...notes);
  if (room.residentOff) g.notes.unshift(P.EXAM_PREVIEW_FAILED(room.residentOff));
  else if (room.beforeSkipped) g.notes.unshift(P.EXAM_BEFORE_ASSUMED(room.beforeSkipped));
  if (!hiddenOk) g.notes.push(S.examiner.hiddenFailed);
  const pass = g.problems.length === 0;
  settle(o, stage, day, record, tally, { examined: room.residentOff ? 0 : 1, pass, regressions: g.regressions });
  return pass ? { pass: true, problems: g.notes } : { pass: false, problems: g.problems };
}

/**
 * 出暗题（验证开始时，整理已经做完，出题人只看材料和整理前的注入）：这一天这一段已经有暗题就沿用（重做时不重出），
 * （stage.exam.hidden 是 0 或省钱阶梯不要暗题时调用方不进来）。出不成（含整理前的注入拼不出来）返回 false
 */
async function hiddenQuestions(r: Room, exam: StageExam): Promise<boolean> {
  if (r.o.bank.pending(r.day, r.stage.id).some((q) => q.hidden)) return true;
  try {
    const v = await viewOf(r, "before");
    // 出暗题的交的题跟段交的一样查（final fix M10）：出处照这一段整理前的样子
    const before = { day: r.day, state: "before" as const, files: r.ctx.before, writes: r.stage.writes };
    const ids = await setHidden(r.o.host, r.o.bank, {
      id: `${r.base}-hidden`, day: r.day, stage: r.stage, material: r.ctx.material, before: v.appendix ? `${v.injection}\n\n${v.appendix}` : v.injection,
      n: exam.hidden, model: r.grader, opening: r.opening,
      check: (q) => questionProblem(q, (ref) => r.o.host.sourceExists(ref, before), (ref) => r.o.host.isPrivate?.(ref) ?? false),
    });
    return ids !== null;
  } catch (e) {
    r.o.log?.warn("sleep: hidden questions not set", { day: r.day, stage: r.stage.id, error: msg(e).slice(0, 300) });
    return false;
  }
}

// ---------- 挑题、覆盖 ----------

/**
 * 这一段的 affects 里算数的（final fix I3）：点名的题能考、没申请退休、挂在那条改动的 target 上（标签或出处说到 target 的文件或编号）。
 * layers：题号 → 这一次照哪一层考（一次只挪一层，写多了的挪一层、记一句；同一道写了几次，后写的算）；
 * important：重要度 ≥ 4 的（不照写的挪：问判分，判分同意才挪）；why：哪一条改动写的；
 * valid / stray / retired：每条改动（下标）点名的、算数的题号 / 题库里有、却不挂在它上面的题号 / 申请了退休的题号（覆盖检查用）
 */
export interface Declared {
  layers: Map<string, Layer>; important: Set<string>; why: Map<string, string>; notes: string[];
  valid: Map<number, string[]>; stray: Map<number, string[]>; retired: Map<number, string[]>;
  /** 题库里在只在仓库、写成挪进只在仓库被拦下来按查得到考的：今晚照查得到考，不写改层的 op（跟判分那条路一样；评审 N2） */
  stay: Set<string>;
}

/**
 * 题挂在这一处上：出处或标签（文件、事件、教训）说到 target 的那样东西（mentions：两边都照 thing 比，「路径「小节」」「编号（注）」
 * 都认）；给了 parents（ExamHost.parentsOf），也认它顶替了的那几条（更正、合并新建的编号动手前不知道，题挂在原来那条上：切换前 P4）。
 * 覆盖检查、affects、退回以后交题都用这一个（修正轮 I1、I2）
 */
export const hangsOn = (q: Pick<Question, "tags" | "sources">, target: string, parents?: (id: string) => string[]): boolean => {
  const ups = parents?.(thing(target)) ?? [];
  return [...q.sources, ...q.tags.files, ...q.tags.events, ...q.tags.lessons].some((r) => mentions(r, target) || ups.some((u) => mentions(r, u)));
};

/** 这一次尝试的批里，编号顶替了哪些（host 没给、出错都是 []） */
const parentsVia = (host: Pick<ExamHost, "parentsOf">, record: Pick<StageRecord, "day" | "stage" | "attempt">) => (id: string): string[] => {
  try { return host.parentsOf?.(id, { day: record.day, stage: record.stage, attempt: record.attempt }) ?? []; } catch { return []; }
};

/** 从 from 挪向 to，一次最多一层 */
const oneStep = (from: Layer, to: Layer): Layer => {
  const d = DEPTH[to] - DEPTH[from];
  return Math.abs(d) <= 1 ? to : ORDER[DEPTH[from] + Math.sign(d)]!;
};

/**
 * retired：今晚申请了退休的题（overlayOf 的）：什么都不护，不算数、不定层（plan 3 A3）；
 * lineOk：能不能放进只在仓库（段的考试照整理前查得到的「路径:行」，不给只看写没写）；parents：认更正、合并的链接（切换前 P4）
 */
export function declaredOf(bank: Bank, record: StageRecord, day: string, retired: ReadonlySet<string> = new Set(), lineOk: LineOk = hasLine, parents?: (id: string) => string[]): Declared {
  const out: Declared = { layers: new Map(), important: new Set(), why: new Map(), notes: [], valid: new Map(), stray: new Map(), retired: new Map(), stay: new Set() };
  const push = (m: Map<number, string[]>, i: number, id: string): void => { m.set(i, [...(m.get(i) ?? []), id]); };
  record.changes.forEach((c, i) => {
    for (const a of c.affects ?? []) {
      const q = examinable(bank, a.q, day);
      if (!q) continue;
      if (retired.has(q.id)) { push(out.retired, i, q.id); continue; }
      if (!hangsOn(q, c.target, parents)) { push(out.stray, i, q.id); continue; }
      push(out.valid, i, q.id);
      out.why.set(q.id, c.target);
      if (q.importance >= 4) { out.important.add(q.id); out.layers.delete(q.id); continue; }
      const step = oneStep(q.layer, a.layer);
      if (step !== a.layer) {
        const line = S.examiner.oneLayerOnly(q.q, q.id, LAYER_NAME[q.layer], LAYER_NAME[a.layer], LAYER_NAME[step]);
        if (!out.notes.includes(line)) out.notes.push(line);
      }
      const to = noArchive(q, step, out.notes, lineOk);
      out.important.delete(q.id);
      out.layers.set(q.id, to);
      if (to !== step && q.layer === "archive") out.stay.add(q.id);
      else out.stay.delete(q.id);
    }
  });
  return out;
}

/** 这一段的 affects 写的、算数的：题号 → 这一次照哪一层考（全天考试用；重要度 ≥ 4 的、申请了退休的不在里面） */
export const declaredLayers = (record: StageRecord, bank: Bank, day: string, retired?: ReadonlySet<string>, parents?: (id: string) => string[]): Map<string, Layer> =>
  declaredOf(bank, record, day, retired, hasLine, parents).layers;

// 说到的那样东西（thing）：things.ts 里，这里照旧导出
export { thing };

/** 题号点到的题能不能考：生效的，或者这一天的、不是暗题的待定题（挑题和覆盖检查同一个说法） */
function examinable(bank: Bank, id: string, day: string): Question | null {
  const q = bank.get(id);
  return q && (q.status === "active" || (q.status === "pending" && !q.hidden && q.day === day)) ? q : null;
}

/** 今晚申请的改题（新的标准答案）和退休：落地前不改题库，今晚考试照这个考 */
export interface Overlay { gold: Map<string, string>; retired: Set<string> }

/** 这一天这几段还没执行的 revise / retire（后记的算） */
export function overlayOf(bank: Bank, day: string, stages: string[]): Overlay {
  const gold = new Map<string, string>();
  const retired = new Set<string>();
  for (const op of bank.pendingOps(day, stages)) {
    if (op.kind === "revise") gold.set(op.q, op.gold);
    else if (op.kind === "retire") retired.add(op.q);
  }
  return { gold, retired };
}

/** 申请了改题的：换成新的标准答案 */
export const withGold = (ov: Overlay, q: Question): Question => {
  const g = ov.gold.get(q.id);
  return g === undefined ? q : { ...q, gold: g };
};

export const retiredNote = (q: Question): string => S.examiner.retired(q.q);

/**
 * 申请了改题的卷子记下整理前那轮照哪个标准答案判（Paper.beforeGold）：was 是这一段之前的改题（今晚前面过了的段的），
 * 没有就是题库里的。跟整理后那轮的一样就不记
 */
function beforeGolds(bank: Bank, papers: Paper[], ov: Overlay, was: Overlay): void {
  for (const p of papers) {
    if (!ov.gold.has(p.q.id)) continue;
    const g = was.gold.get(p.q.id) ?? bank.get(p.q.id)?.gold;
    if (g !== undefined && g !== p.q.gold) p.beforeGold = g;
  }
}

/** 这一段改过的东西：实际改了的文件、change target 里的文件和 e/n/t/i 编号（人名引擎不知道，挂人的题靠它的文件、事件标签找到） */
export function changedThings(record: StageRecord): Pick<Tags, "files" | "events"> {
  const files = new Set(record.actual.files.map((f) => f.path));
  const events = new Set<string>();
  for (const c of record.changes) {
    const t = thing(c.target);
    if (MEM_ID.test(t)) events.add(t);
    else if (t) files.add(t);
  }
  return { files: [...files], events: [...events] };
}

/** 旧题、抽题的上限照省钱阶梯的 oldScale 压：向下取整，至少 1（本来是 0 的还是 0） */
export const capOld = (n: number, scale: number): number => (n <= 0 ? 0 : Math.max(1, Math.floor(n * scale)));

/**
 * 考哪几道（同一道只考一次）：这一段自己交的题、affects 点名的题、挂在改过的东西上的旧题（上限 exam.old）、
 * 题库里随机抽的（exam.sample）；省钱阶梯的 oldScale 压旧题和抽题的上限（向下取整，至少 1）。
 * touched 是挂在改过的东西上的那几道（问判分该在哪一层）
 */
function pick(o: ExaminerOpts, exam: StageExam, record: StageRecord, own: Question[], decl: Declared, ov: Overlay, notes: string[], revised: string[] = []): { papers: Paper[]; touched: Question[] } {
  const declared = decl.layers;
  const scale = o.ladder().oldScale;
  const cap = (n: number): number => capOld(n, scale);
  const picked = new Map<string, Question>();
  const retiring = (q: Question): boolean => {
    if (!ov.retired.has(q.id)) return false;
    const line = retiredNote(q);
    if (!notes.includes(line)) notes.push(line);
    return true;
  };
  const add = (q: Question): void => { if (!picked.has(q.id) && !retiring(q)) picked.set(q.id, withGold(ov, q)); };
  own.forEach(add);
  for (const id of [...declared.keys(), ...decl.important, ...revised]) {
    const q = examinable(o.bank, id, record.day);
    if (q) add(q);
  }
  const touched = o.bank.touching(changedThings(record), cap(exam.old)).filter((q) => !retiring(q)).map((q) => withGold(ov, q));
  touched.forEach(add);
  const drawn = new Set<string>();
  for (const q of o.bank.sample(cap(exam.sample), o.rnd, new Set([...picked.keys(), ...ov.retired]))) { drawn.add(q.id); add(q); }
  const ownIds = new Set(own.map((q) => q.id));
  const papers = [...picked.values()].map((q): Paper => ({
    q, layer: declared.get(q.id) ?? q.layer, fresh: ownIds.has(q.id) && q.isNew, ...(drawn.has(q.id) ? { sampled: true } : {}),
  }));
  return { papers, touched };
}

/**
 * 比较压缩前的样子：去掉空白、全角字符换成半角（同一个字的两种写法）。标点照留：小数点、负号、列表的「- 」都有意思
 * （评审 W1：3.5 → 35、-5 → 5、删掉的「- 不吃香菜」都得算改了）
 */
const bare = (s: string): string => s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/\s/g, "");

/**
 * 照 diff 数一个文件压缩了几处（plan 3 A2）：整理前的一行（去掉头尾空白）整理后哪儿都没有了算删掉，连着删掉的几行算一处
 * （空行不算、也不隔开；还在的一行隔开）。删掉的文件、整理前有内容的，算一处。
 * 两档（评审第 3 轮）：照 bare 没了才算改；照 bare 没了、再去掉标点和符号还在的（只改了标点），自己算一处、不把前后两处连起来
 */
function compressions(before: string | null, after: string | null, strip?: (line: string) => string): number {
  if (before === null) return 0;
  // 切换前 P5：两边的每一行都先去掉配置里要忽略的标记（只加了标记的一行不算改过）
  if (strip) {
    before = before.split("\n").map(strip).join("\n");
    if (after !== null) after = after.split("\n").map(strip).join("\n");
  }
  // 两边都去掉空白、全角换半角再比（一行一行地，不跨行）：只插了空格、换了全角半角的不算删掉，也不把两处连成一处（评审 K4、W1）
  const now = (after ?? "").split("\n").map(bare).join("\n");
  const loose = (x: string): string => bare(x).replace(/[\p{P}\p{S}]/gu, "");
  const nowLoose = (after ?? "").split("\n").map(loose).join("\n");
  let runs = 0;
  let inRun = false;
  for (const raw of before.split("\n")) {
    const l = bare(raw);
    if (!l) continue;
    const gone = !now.includes(l);
    // 只改了标点的一行：算一处（标点可能有意思：3.5 → 35），但它不隔开、也不接上前后删掉的
    const light = gone && loose(raw) !== "" && nowLoose.includes(loose(raw));
    if (light) { runs += 1; inRun = false; continue; }
    if (gone && !inRun) runs += 1;
    inRun = gone;
  }
  return runs;
}

/** 题挂在这个文件上：出处或标签说到它（「路径「小节」」也算：修正轮 I1） */
const onFile = (q: Question, path: string): boolean => hangsOn(q, path);

/**
 * 要压缩的每一处都得先出题（spec §8.6；final fix I4）：
 * 1. 标着压缩的改动（COMPRESS）：这一段的题的出处或标签说到它，或者这条改动的 affects 点名了至少一道算数的题；
 *    target 是私密的印象（host.isPrivate）的不出题，记一句进 notes（题库和判分主人看得到）；
 * 2. 照实际的 diff：改过的文件删掉了几处（compressions：连着删掉的几行算一处），挂在这个文件上的题（这一段的题、
 *    算数的 affects）就至少要几道（plan 3 A2）；changes 里挂在这个文件上的写了更多条，照条数（最终评审 C1）；
 *    各文件要的加起来超过这一段的 exam.max：一共只要求 max 道不同的题、每个文件至少 1 道，记一句「改动太散」（最终评审 I1、修正第 2 轮 N2）
 */
function coverage(o: ExaminerOpts, stage: StageSpec, day: string, record: StageRecord, own: Question[], decl: Declared, ctx: ValidateCtx, notes: string[]): Precheck {
  const r = coverageOf(o, stage, day, record, own, decl, ctx, notes);
  if (!r.problems.length || !stage.exam) return r;
  // 修正轮 M7a：这一段不收题（exam.max 是 0）：要压缩的那几处只能改回去，不叫它出题（退回也不点名要补题的地方）
  if (stage.exam.max === 0) return { problems: r.targets.map((t) => P.EXAM_NO_CUTS(t)), targets: [] };
  // 终审修正轮 M5：这一段的题已经收满了：再出题也收不下——改回去，或者在 affects 里点名一道挂在它上面的旧题（不点名要补题的地方，交题照旧）
  const have = o.bank.pending(day, stage.id).filter((q) => !q.hidden).length;
  if (have >= stage.exam.max) return { problems: r.targets.map((t) => P.EXAM_FULL_CUTS(t, stage.exam!.max)), targets: [] };
  return r;
}

function coverageOf(o: ExaminerOpts, stage: StageSpec, day: string, record: StageRecord, own: Question[], decl: Declared, ctx: ValidateCtx, notes: string[]): Precheck {
  const parents = parentsVia(o.host, record);
  const was = { files: ctx.before, writes: stage.writes };
  const strip = markStripper(o.flow.exam.ignoreMarks);
  /** 这个文件去掉要忽略的标记以后整理前后一样：只加了标记，标着压缩也不用出题（修正轮 2 M5） */
  const markOnly = (target: string): boolean => {
    const path = thing(target);
    if (!strip || !record.actual.files.some((f) => f.path === path)) return false;
    const b = o.host.beforeText(day, path, was);
    const a = ctx.after.get(path)?.text ?? null;
    const lines = (t: string): string => t.split("\n").map(strip).join("\n");
    return b !== null && a !== null && lines(b) === lines(a);
  };
  const problems: string[] = [];
  const flagged = new Set<string>();
  /** 没过的那几处（当场核对退回时点名：这时 exam_questions 只收挂在它们上面的）：点名那样东西（thing，去掉小节、注） */
  const targets: string[] = [];
  const name = (t: string): void => { const x = thing(t) || t; if (!targets.includes(x)) targets.push(x); };
  record.changes.forEach((c, i) => {
    // 题挂在 target 上，或者挂在它顶替了的那几条上（更正、合并：切换前 P4）；跟退回以后交题同一个说法（hangsOn）
    if (!COMPRESS.test(c.op.trim().toLowerCase()) || own.some((q) => hangsOn(q, c.target, parents)) || decl.valid.get(i)?.length || markOnly(c.target)) return;
    if (o.host.isPrivate?.(thing(c.target))) {
      const line = S.examiner.privateField(c.target);
      if (!notes.includes(line)) notes.push(line);
      return;
    }
    flagged.add(thing(c.target));
    name(c.target);
    if (!c.affects?.length) problems.push(S.examiner.compressNoQuestion(c.target));
    else if (decl.stray.get(i)?.length) problems.push(S.examiner.affectsNotOn(c.target));
    else if (decl.retired.get(i)?.length) problems.push(S.examiner.affectsRetired(c.target));
    else problems.push(S.examiner.affectsMissing(c.target));
  });
  const files: Array<{ path: string; counted: number; covering: Set<string> }> = [];
  for (const { path } of record.actual.files) {
    const runs = compressions(o.host.beforeText(day, path, was), ctx.after.get(path)?.text ?? null, strip);
    if (!runs) continue;
    // 最终评审 C1：changes 里写了几条挂在这个文件上的，也至少要几道（diff 数的处数只能往上加，不能往下减）
    const counted = Math.max(runs, record.changes.filter((c) => thing(c.target) === path).length);
    const covering = new Set([
      ...own.filter((q) => onFile(q, path)).map((q) => q.id),
      ...record.changes.flatMap((c, i) => (thing(c.target) === path ? decl.valid.get(i) ?? [] : [])),
    ]);
    files.push({ path, counted, covering });
  }
  const none = (path: string): void => { if (!flagged.has(path)) { problems.push(S.examiner.rewroteNoQuestion(path)); name(path); } };
  // 最终评审 I1、修正第 2 轮 N2：一段最多收 exam.max 道题，所以上限按整段算——各文件要的加起来超过 max，就只要一共 max 道不同的题、
  // 每个改了的文件至少 1 道（文件比 max 还多就不要求每个都有），记一句「改动太散」（不然改得散的永远过不了）
  // 切换前 P10a：上限至少按 1 算（exam.max = 0 不能把覆盖检查关掉：删了内容就得有题）
  const max = stage.exam ? Math.max(1, stage.exam.max) : undefined;
  const total = files.reduce((a, f) => a + f.counted, 0);
  if (max === undefined || total <= max) {
    for (const f of files) {
      if (f.covering.size >= f.counted) continue;
      if (!f.covering.size) none(f.path);
      else { problems.push(S.examiner.tooFewQuestions(f.path, f.counted, f.covering.size)); name(f.path); }
    }
    return { problems, targets };
  }
  const one = files.length === 1 ? files[0]! : null;
  const names = files.map((f) => S.examiner.placesIn(f.path, f.counted)).join(S.marks.listSep);
  const line = one ? S.examiner.scatteredOne(one.path, one.counted, max) : S.examiner.scatteredMany(names, total, max, files.length <= max ? S.examiner.perFileOne : "");
  if (!notes.includes(line)) notes.push(line);
  if (files.length <= max) for (const f of files) if (!f.covering.size) none(f.path);
  const distinct = new Set(files.flatMap((f) => [...f.covering])).size;
  if (problems.length || distinct >= max) return { problems, targets };
  for (const f of files) name(f.path);
  problems.push(one
    ? S.examiner.tooFewScatteredOne(one.path, one.counted, distinct, max)
    : S.examiner.tooFewScatteredMany(names, total, distinct, max));
  return { problems, targets };
}

// ---------- 考 ----------

/**
 * 场地：开头去掉这一段改过的基础块（新版本在注入里）；两个状态考生看到的用到才拼：
 * 改过的文件里明天会注入的进注入（走预览脚本），别的进查得到那层的附录（那个状态的样子）
 */
function seat(o: ExaminerOpts, stage: StageSpec, day: string, record: StageRecord, ctx: ValidateCtx): Room {
  const files = record.actual.files.map((f) => f.path);
  const exam = o.flow.exam;
  const injected = files.filter((p) => injectedFile(exam, p));
  const appended = files.filter((p) => !injectedFile(exam, p));
  // 整理前：快照里没有的（今天头一回提议的）用工作区里的，不是「删掉了」（beforeContent）
  const was = { files: ctx.before, writes: stage.writes };
  const text = (state: "after" | "before", p: string): string | null => (state === "after" ? ctx.after.get(p)?.text ?? null : o.host.beforeText(day, p, was));
  const contents = (state: "after" | "before", ps: string[]) => new Map(ps.map((p): [string, string | null] => [p, text(state, p)]));
  const views = new Map<string, Promise<View>>();
  const build = async (state: "after" | "before"): Promise<View> => {
    const appendix = appendixText(contents(state, appended), exam.appendixChars);
    if (!injected.length) return { injection: P.EXAM_NOTHING_INJECTED, appendix, failed: null };
    const files = contents(state, injected);
    try {
      return { injection: await o.host.preview({ day, stage: stage.id, state, files }), appendix, failed: null };
    } catch (e) {
      return { injection: plainInjection(files), appendix, failed: msg(e).slice(0, 300) || S.final.noReason };
    }
  };
  // 整理后「路径:行」的出处：今晚改过的文件（这一段的、前面过了的段的）里那一行还在不在
  const tonight = o.tonight?.(day) ?? { before: new Map<string, string | null>(), after: new Map<string, string | null>() };
  // 开头：这一段改过的基础块不放（新版本在注入里）；今晚前面过了的段改过的基础块用明天的样子
  const excluded = files.filter((p) => exam.baseBlocks.includes(p));
  const tomorrow = new Map([...tonight.after].filter(([p]) => exam.baseBlocks.includes(p) && !excluded.includes(p)));
  const strip = markStripper(exam.ignoreMarks);
  const kept = lineKept({
    changed: new Set([...files, ...tonight.after.keys()]),
    before: (p) => o.host.beforeText(day, p, was),
    after: (p) => (matchWrites(stage.writes, p) ? ctx.after.get(p)?.text ?? null : tonight.after.get(p) ?? null),
    exists: (ref) => o.host.sourceExists(ref, { day, state: "after" }),
    ...(strip ? { strip } : {}),
  });
  const resolves = resolverBefore(o, stage, day, ctx);
  const mids = new Map<string, { text: string; failed: string | null }>();
  const memoryOf = (state: "after" | "before"): { text: string; failed: string | null } => {
    let m = mids.get(state);
    if (!m) {
      // 写事件库的段、整理前那份没拷成：现在的库冒充不了整理前；常驻那层那一场不考（untrusted），查得到那层的考生
      // 查找工具读的就是现在的库，给它整理后那份（跟它的工具一致；R3）
      m = state === "before" && untrusted() ? memoryOf("after") : residentMemory(o.host, exam, { day, state, store: state === "after" ? "live" : ctx.storeBefore });
      mids.set(state, m);
    }
    return m;
  };
  // 写事件库的段、整理前的拷贝没拷成（storeBefore 是 live）、她的前缀里有中期视图：整理前那份靠不住（修正轮 2 M2、终审修正轮 M1）
  let trust: boolean | null = null;
  const untrusted = (): boolean => {
    if (trust === null) {
      const live = stage.memWrite && ctx.storeBefore === "live" ? residentMemory(o.host, exam, { day, state: "after", store: "live" }) : null;
      trust = !(live && (live.text || live.failed));
    }
    return !trust;
  };
  return {
    o, stage, day, ctx, kept, later: null, grader: o.ladder().cheap ? "sonnet" : exam.graderModel, resolves,
    // 切换前 P6：整理后照现在的库，整理前照这一段动手前的拷贝（没拷的就是现在的库）
    // 已知的限制（终审 M2，没修）：不写事件库的段跟写事件库的段同时跑时，它的 storeBefore 是 live，两份中期视图都从现在的库拼，
    // 里面有那一段还没提交的写入（前后一样，不会凭空多出倒退或进步；她的流程一次只跑一段）
    memory: memoryOf,
    untrusted,
    beforeFailed: null,
    beforeSkipped: null,
    beforeOff() { return untrusted() ? P.EXAM_NO_BEFORE_COPY : this.beforeFailed; },
    lineOk: (q) => q.sources.some((s) => pathRef(s) !== null && resolves(s)),
    base: `exam-${day}-${stage.id}-${record.attempt}`, hide: ["sleep/", ...files], residentOff: null,
    opening: tomorrow.size ? o.host.opening(excluded, tomorrow) : o.host.opening(excluded),
    view: (state) => { let v = views.get(state); if (!v) { v = build(state); views.set(state, v); } return v; },
  };
}

/**
 * 常驻那层的考生看的中期视图（切换前 P6）：exam.residentMemory 关着、host 不会拼都是 ""；拼不出来给理由
 * （跟注入预览没拼成一样：常驻那层不考，不拿缺了一块的样子冒充明天的）
 */
export function residentMemory(host: Pick<ExamHost, "memory">, exam: Pick<FlowConfig["exam"], "residentMemory">, at: { day: string; state: "after" | "before"; store: string }): { text: string; failed: string | null } {
  if (!exam.residentMemory || !host.memory) return { text: "", failed: null };
  try { return { text: host.memory(at).trim(), failed: null }; } catch (e) { return { text: "", failed: P.EXAM_MEMORY_FAILED(msg(e).slice(0, 300) || S.final.noReason) }; }
}

/** 常驻那层考生看到的注入：注入的那几块，后面接中期视图（自己的标题，跟她的前缀里一样排在后面） */
export const withMemory = (injection: string, memory: string): string => (memory ? `${injection}\n\n${memory}` : injection);

/** 拿一个状态考生看到的；注入预览没拼成：从这以后常驻那层不考（记 warn，报告里写一句） */
async function viewOf(r: Room, state: "after" | "before"): Promise<View> {
  const v = await r.view(state);
  // 整理前那一场才发现的：只跳过常驻那层的整理前，整理后照旧把关（R1）
  if (v.failed && state === "before") {
    if (!r.beforeFailed) {
      r.beforeFailed = P.EXAM_PREVIEW_FAILED_BEFORE(v.failed);
      r.o.log?.warn("sleep: exam injection preview failed for the before state, resident before sitting skipped", { day: r.day, stage: r.stage.id, error: v.failed });
    }
    return v;
  }
  if (v.failed && !r.residentOff) {
    r.residentOff = v.failed;
    r.o.log?.warn("sleep: exam injection preview failed, resident layer not examined", { day: r.day, stage: r.stage.id, state, error: v.failed });
  }
  return v;
}

/** 记一道题这一阶段的判定（每次判分都进题库的结果表） */
function mark(r: Room, phase: Phase, p: Paper, m: Mark): void {
  p[phase] = m;
  r.o.bank.record({ q: p.q.id, day: r.day, stage: r.stage.id, phase: p.hidden ? "hidden" : phase, layer: p.layer, verdict: m.verdict, reason: m.reason, answer: m.answer });
}

/**
 * 考一轮：常驻、查得到这一层有题就开一个考生（整理前那次用整理前的注入和事件库拷贝），只在仓库的查出处；
 * 考生交的一次判完。返回判分人对 askLayers 判的层
 */
async function round(r: Room, phase: Phase, papers: Paper[], askLayers: Question[]): Promise<Map<string, Layer>> {
  const { host, flow } = r.o;
  const store = phase === "before" ? r.ctx.storeBefore : "live";
  const items: Array<{ p: Paper; answer: string }> = [];
  for (const layer of SITTING) {
    const group = papers.filter((p) => p.layer === layer);
    if (!group.length) continue;
    const state = phase === "before" ? "before" : "after";
    const v = await viewOf(r, state);
    // 注入后面接中期视图（exam.residentMemory 开着才有；常驻、查得到两层都给，跟她白天的前缀一样：终审修正轮 M3）。拼不出来：
    // 整理前那一场的，跟 untrusted 一样只跳过常驻那层的整理前（R1）；整理后的，常驻那一轮里才算常驻那层不考（只有查得到的题照常记考了：R2）
    const mid = r.memory(state);
    if (mid.failed && state === "before" && !r.beforeFailed) {
      r.beforeFailed = mid.failed;
      r.o.log?.warn("sleep: exam mid-term view failed for the before state, resident before sitting skipped", { day: r.day, stage: r.stage.id, error: mid.failed });
    } else if (mid.failed && state === "after" && layer === "resident" && !r.residentOff) {
      r.residentOff = mid.failed;
      r.o.log?.warn("sleep: exam mid-term view failed, resident layer not examined", { day: r.day, stage: r.stage.id, state, error: mid.failed });
    }
    if (layer === "resident" && r.residentOff) continue;
    // 整理前那一场常驻那层考不了（拷贝靠不住、整理前的预览或中期视图拼不出来）：不考，答错的旧题在 before() 里保守地照倒退算（终审修正轮 M1、R1）
    const off = phase === "before" && layer === "resident" ? r.beforeOff() : null;
    if (off) { r.beforeSkipped ??= off; continue; }
    const answers = await examineLayer(host, {
      id: `${r.base}-${phase}-${layer}`, model: flow.exam.examineeModel, opening: r.opening, layer, injection: withMemory(v.injection, mid.text), questions: group.map((p) => p.q), store, hide: r.hide,
      ...(layer === "searchable" && v.appendix ? { appendix: v.appendix } : {}),
    });
    if (!answers) throw new Broken(S.final.noPaper(phase, layer));
    for (const p of group) items.push({ p, answer: answers.get(p.q.id) ?? S.marks.noAnswer });
  }
  // 整理前那次查出处：路径照 beforeContent（开始时的快照 → 它的范围里没进快照的看工作区 → 别的看提案、再看工作区）
  const where = phase === "before" ? { day: r.day, state: "before" as const, files: r.ctx.before, writes: r.stage.writes } : { day: r.day, state: "after" as const };
  for (const p of papers.filter((x) => x.layer === "archive")) {
    // 只照整理前查得到的出处判（行号过了头、编号没了的不算数；一条都不剩是错）
    const verdict = checkArchive(host, { ...p.q, sources: p.q.sources.filter(r.resolves) }, where, phase === "before" ? undefined : r.kept);
    mark(r, phase, p, { verdict, reason: verdict === "right" ? S.final.refsFound : S.final.refsMissing, answer: "" });
  }
  if (!items.length && !askLayers.length) return new Map();
  // 整理前那轮：申请了改题的照这一段之前的标准答案判（plan 3 A4）
  const graded = items.map(({ p, answer }) => ({ q: phase === "before" && p.beforeGold !== undefined ? { ...p.q, gold: p.beforeGold } : p.q, answer }));
  // 整理后那轮自己一个判分会话；重考和整理前那轮共用一个（先用到的那轮起名）
  const g = phase === "after"
    ? await grade(host, { id: `${r.base}-grade-after`, model: r.grader, opening: r.opening, items: graded, askLayers, hide: r.hide })
    : await (r.later ??= grading(host, { id: `${r.base}-grade-${phase}`, model: r.grader, opening: r.opening, hide: r.hide })).grade(graded, askLayers);
  if (!g) throw new Broken(S.final.noGrades(phase));
  for (const { p, answer } of items) {
    const v = g.grades.get(p.q.id) ?? { verdict: "wrong" as const, reason: S.final.noVerdict };
    mark(r, phase, p, { verdict: v.verdict, reason: v.reason, answer });
  }
  return g.layers;
}

/**
 * 判分判了比考的那层更低的层（问到层的旧题）、在考的那层答错：不算倒退，挪到判的那层，重考在那层考，算那一次的。
 * 在原来那层部分对的，只有重要度 ≥ 4 的也挪（整理后不能比整理前差：在它该在的那层答得出才算数）；别的部分对不挪，
 * 照部分对记一句（plan 3 A6）
 */
function movedByGrader(papers: Paper[], askLayers: Question[], calls: Map<string, Layer>, lineOk: LineOk): void {
  const asked = new Set(askLayers.map((q) => q.id));
  for (const p of papers) {
    const l = calls.get(p.q.id);
    if (!l || !asked.has(p.q.id) || DEPTH[l] <= DEPTH[p.layer] || !p.after || p.after.verdict === "right") continue;
    // 只在仓库判不了的题不往只在仓库挪（noArchive 会拦的那些；评审 V3）
    if (l === "archive" && noArchiveFor(p.q, lineOk)) continue;
    if (p.after.verdict === "partial" && !important(p)) continue;
    p.layer = l;
    p.moved = true;
  }
}

/** 整理后判错的（考生考的那几层）、判分挪了层的再开新会话重考一次，重考对了就算对 */
async function retake(r: Room, papers: Paper[]): Promise<void> {
  const wrong = papers.filter((p) => p.moved || (p.layer !== "archive" && p.after?.verdict === "wrong"));
  if (wrong.length) await round(r, "retake", wrong, []);
}

/**
 * 拿整理前的样子补考（一轮，每层至多一个考生）：重考还错的旧题——整理前答得出才算这一段丢的；
 * 管重要的题时，重要度 ≥ 4、整理后部分对的旧题也一起考——整理后不能比整理前差。只是抽到的不补考
 */
async function before(r: Room, papers: Paper[], exam: StageExam): Promise<void> {
  const lost = papers.filter((p) => !p.fresh && !p.sampled && (afterOf(p) === "wrong" || (exam.highAllRight && important(p) && afterOf(p) === "partial")));
  if (lost.length) await round(r, "before", lost, []);
  // 常驻那层整理前没考（拷贝靠不住、整理前那一场拼不出来：终审修正轮 M1、R1）：旧题出的时候答得出，保守地当整理前答对
  // （照倒退算，不进题库的结果表、不进整理前的分）
  const why = r.beforeSkipped;
  if (!why || r.residentOff) return;
  for (const p of lost) {
    if (p.layer !== "resident" || p.before) continue;
    p.before = { verdict: "right", reason: P.EXAM_BEFORE_ASSUMED(why), answer: "" };
    p.assumed = true;
  }
}

// ---------- 门槛、记结果 ----------

/**
 * 门槛（spec §8.4）：倒退、今天新要点各层的得分率、重要的题（今天新的要全对，旧的整理后不能比整理前差）；
 * 部分对、整理前也答不出的记进 notes
 */
function gates(exam: StageExam, papers: Paper[], hidden: Paper[]): { problems: string[]; notes: string[]; regressions: number } {
  const problems: string[] = [];
  const notes: string[] = [];
  // 每一行都带题号（final fix I6）：重做的段对得上是哪一道
  const lost = (p: Paper) => S.examiner.regressed(p.q.q, p.q.id, p.q.gold, p.assumed && p.before ? S.examiner.beforeReason(p.before.reason) : "");
  const short = (ps: Paper[]) => ps.filter((p) => afterOf(p) !== "right").map((p) => p.q.id).join(S.marks.listSep);
  const regressed = papers.filter((p) => !p.sampled && p.before?.verdict === "right" && afterOf(p) === "wrong");
  const failing = regressed.length > exam.regressions;
  (failing ? problems : notes).push(...regressed.map(lost));

  for (const p of papers) {
    const a = afterOf(p);
    // 只是抽到的：不挂在这一段改的东西上，答不好只记一句（final fix M2）
    if (p.sampled && a === "wrong") notes.push(S.examiner.wrongNotHere(p.q.q, p.q.id));
    else if (a === "wrong" && p.before?.verdict === "wrong") notes.push(S.examiner.wrongBefore(p.q.q));
    else if (a === "wrong" && p.before?.verdict === "partial") notes.push(S.examiner.partBefore(p.q.q));
    else if (!p.fresh && a === "partial") notes.push(S.examiner.partly(p.q.q));
  }

  for (const layer of SITTING) {
    const fresh = papers.filter((p) => p.fresh && p.layer === layer);
    if (!fresh.length) continue;
    const rate = fresh.reduce((a, p) => a + SCORE[afterOf(p)], 0) / fresh.length;
    if (rate < exam.newRate[layer]) problems.push(S.examiner.newRateLow(LAYER_NAME[layer], round2(rate), exam.newRate[layer], fresh.length, short(fresh)));
  }

  // 暗题只在 hiddenGates 打开时才拦（照新要点的得分率）
  for (const layer of SITTING) {
    const hid = hidden.filter((p) => p.layer === layer);
    if (!hid.length) continue;
    const rate = hid.reduce((a, p) => a + SCORE[afterOf(p)], 0) / hid.length;
    if (rate < exam.newRate[layer]) problems.push(S.examiner.hiddenRateLow(LAYER_NAME[layer], round2(rate), exam.newRate[layer], hid.length, short(hid)));
  }

  if (exam.highAllRight) {
    for (const p of papers) {
      const a = afterOf(p);
      if (!important(p) || a === "right" || p.sampled) continue;
      if (p.fresh || !p.before) {
        problems.push(S.examiner.importantWrong(p.q.importance, p.q.q, p.q.id, p.q.gold));
        continue;
      }
      // 旧题：整理后不比整理前差就不算这一段丢的；已经按倒退打回的不重复写
      if (SCORE[a] >= SCORE[p.before.verdict] || (failing && regressed.includes(p))) continue;
      problems.push(S.examiner.importantWorse(p.q.importance, VERDICT_NAME[p.before.verdict], VERDICT_NAME[a], p.q.q, p.q.id, p.q.gold));
    }
  }
  return { problems, notes, regressions: regressed.length };
}

/** affects 写的新层（算数的、挪一层以内的；重要度 ≥ 4 的等判分；被拦下来照查得到考的不算）：跟题现在的层不一样的，落地时改 */
function affectsOps(bank: Bank, decl: Declared): Op[] {
  const ops: Op[] = [];
  for (const [id, layer] of decl.layers) {
    const q = bank.get(id);
    if (!q || q.layer === layer || decl.stay.has(id)) continue;
    ops.push({ kind: "layer", q: id, layer, why: S.examiner.movedTo(LAYER_NAME[layer], decl.why.get(id) ?? S.examiner.noPlaceNamed) });
  }
  return ops;
}

/** 判分判的新层：只认问到的那几道、跟现在不一样的；今晚照旧考，落地时改 */
function graderOps(askLayers: Question[], calls: Map<string, Layer>): Op[] {
  return askLayers.flatMap((q): Op[] => {
    const layer = calls.get(q.id);
    return layer && layer !== q.layer ? [{ kind: "layer", q: q.id, layer, why: S.examiner.graderLayer(LAYER_NAME[layer]) }] : [];
  });
}

/**
 * 记账、记改层的 op（这一段在考试这一步过了才记，没过的这一次会撤回）。过了的这一次只换掉它这次重新定了层的题以前记下、
 * 还没执行的改层 op：affects 写了的（写的就是现在的层也算——上一次的挪层撤掉、不写新的）、判分判了新层的；别的题照旧
 * （全天考试叫的重做只在现在的提案上改，抽到、顺带考到的题它没说话）。没考完的照记已经考完的那几轮的分。
 * 记不进去只记日志，不改考试的结论
 */
function settle(o: ExaminerOpts, stage: StageSpec, day: string, record: StageRecord, tally: Tally,
  r: { examined: 0 | 1; pass: boolean; regressions?: number }): void {
  try {
    // 考试这一步过了就记：靠考试是最后一个验证器（runner 照顺序验，考试过了这一次就过了）。
    // 考试后面要是再加验证器，它没过的这一次也会写下 op、换掉上一次过了的，得改成 runner 提交时再记
    if (r.pass) {
      const redecided = new Set([...tally.declared, ...tally.ops.flatMap((op) => (op.kind === "layer" ? [op.q] : []))]);
      o.bank.dropOps(day, stage.id, ["layer"], redecided);
      for (const op of tally.ops) o.bank.addOp(day, stage.id, op, record.attempt);
    }
  } catch (e) {
    o.log?.warn("sleep: exam layer ops not recorded", { day, stage: stage.id, error: msg(e).slice(0, 300) });
  }
  try {
    setStageExam(o.db, {
      day, stage: stage.id, attempt: record.attempt, questions: tally.questions,
      scoreBefore: tally.scoreBefore, scoreAfter: tally.scoreAfter, regressions: r.regressions ?? null,
      hiddenScore: tally.hiddenScore, examined: r.examined,
    });
  } catch (e) {
    o.log?.warn("sleep: exam scores not recorded", { day, stage: stage.id, error: msg(e).slice(0, 300) });
  }
}
