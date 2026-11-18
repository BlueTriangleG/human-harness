// 专员 + 领导：前后一致的考试。一个专员交差、领导出了题以后，拿整理后的样子考一遍；答错的 keep 题再拿整理前的样子考——
// 整理前答得出、整理后答不出，就是这次改动碰坏的。
import type { LeadQuestion } from "./tools.ts";
import type { Logger } from "../log.ts";
import { P, S } from "../lang/index.ts";
import * as LP from "./leadprompts.ts";
import { SCORE, type Bank, type Question, type Verdict } from "./bank.ts";
import { appendixText, examineLayer, grading, injectedFile, plainInjection, type ExamHost } from "./exam.ts";
import { residentMemory, withMemory } from "./examiner.ts";
import type { FlowConfig, StageSpec } from "./flow.ts";
import { diff, type Snapshot } from "./record.ts";

/** 一个专员这一轮考下来的结果 */
export interface ConsistencyResult {
  /** 考完了没有（考生、判分的会话两次都坏了 = false：没法判：pass 也是 false，改了东西的专员不落地） */
  examined: boolean;
  pass: boolean;
  /** 没过的题：keep 题整理前答得出、整理后答不出；new / missed 题答错的（得分率不到线时才列） */
  failed: Array<{ id: string; probe: LeadQuestion["probe"]; q: string; gold: string; after: string; before?: string; why: string }>;
  /** 写进报告的话：两次都答不出的题、整理前那一场用的是现在的事件库…… */
  notes: string[];
  scoreAfter: number | null;
  scoreBefore: number | null;
  /** 考了的每道题整理后（重考过一次）的判定：下一轮没再考的 new / missed 题照它算进得分率 */
  marks?: Record<string, Verdict>;
  /** 考了的每道题整理后（重考过一次）她答的 */
  answers?: Record<string, string>;
  /**
   * 判分的会话还开着（考完了才有）：照给的标准答案把这几道题的回答再判一次——领导核过、改了标准答案里一个错的词以后重判用，
   * 不另开一场、不另开会话。判不了给 null。用完（定夺完）要 close
   */
  regrade?(items: Array<{ q: Question; answer: string }>): Promise<Map<string, { verdict: Verdict; reason: string }> | null>;
  close?(): Promise<void>;
}

/** 考生没答的那道题记的回答 */

type Phase = "after" | "retake" | "before";
interface Mark { verdict: Verdict; reason: string; answer: string }
/** 考生或判分的会话两次都没交 */
class Broken extends Error {}
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 一个专员这一轮的前后一致考试（before / after 是它动手前、交差时整个 proposed/ 的快照）：
 * 1. 整理后：所有题考一遍（常驻、查得到各一个考生，一起判）；答错的重考一次（考生有噪声，只重考一次）。
 * 2. 整理前：重考还错的 keep 题拿整理前的样子（文件照快照，事件库照 storeBefore 那份拷贝）考一遍。
 * 3. 判：keep 题整理后错、整理前对 = 这次改动碰坏的，没过；两次都错只记一句。new / missed 题只考整理后，合起来的得分率要到 team.tolerance；continuity（每晚固定要问的）也只考整理后，每一道都得答对，不进得分率。
 * 写事件库的专员没有拷贝（storeBefore 是 live）：现在的库里已经有它写的，冒充不了整理前——那一场不考，整理后答不出的 keep 题照碰坏了算。
 * 会话坏了没考完、没有题：examined false、pass false（没法判就不算过），notes 里说为什么。不往外抛
 */
export async function consistencyExam(o: { host: ExamHost; bank: Bank; flow: FlowConfig; log?: Pick<Logger, "warn"> }, x: {
  day: string; stage: StageSpec; attempt: number; round: number; questions: Question[]; probes: Map<string, LeadQuestion["probe"]>;
  before: Snapshot; after: Snapshot; storeBefore: string;
  /** 前面几轮答过、这一轮没再考的 new / missed 题的得分（对 1、部分对 0.5、错 0）：一起算进得分率 */
  carried?: number[];
  /** 会话 id 里多加的一段（同一轮里另考一场用，比如改了题单独再考：requiz） */
  tag?: string;
}): Promise<ConsistencyResult> {
  const { host, bank, flow } = o;
  const exam = flow.exam;
  const notes: string[] = [];
  const sitting = x.questions.filter((q) => q.layer !== "archive");
  if (sitting.length < x.questions.length) notes.push(LP.CONSIST.archive(x.questions.length - sitting.length));
  if (!sitting.length) return { examined: false, pass: false, failed: [], notes: [...notes, LP.CONSIST.noQuestions], scoreAfter: null, scoreBefore: null };
  const probeOf = (q: Question): LeadQuestion["probe"] => x.probes.get(q.id) ?? "keep";

  const files = diff(x.before, x.after).map((f) => f.path).sort();
  const injected = files.filter((p) => injectedFile(exam, p));
  const appended = files.filter((p) => !injectedFile(exam, p));
  // 整理前：快照里有的照快照（前面的专员改过的也在里面），没有的是这个专员头一回提议的，看工作区（beforeContent）
  const was = { files: x.before, writes: x.stage.writes };
  const text = (state: "after" | "before", p: string): string | null => (state === "after" ? x.after.get(p)?.text ?? null : host.beforeText(x.day, p, was));
  const contents = (state: "after" | "before", ps: string[]) => new Map(ps.map((p): [string, string | null] => [p, text(state, p)]));
  // 开头：这个专员改过的基础块不放（在注入里）；今晚前面的专员改过的基础块（动手前就在 proposed/ 里）用那一份
  const excluded = files.filter((p) => exam.baseBlocks.includes(p));
  const tomorrow = new Map(exam.baseBlocks.filter((p) => !excluded.includes(p) && x.before.get(p)).map((p): [string, string | null] => [p, x.before.get(p)!.text]));
  const opening = tomorrow.size ? host.opening(excluded, tomorrow) : host.opening(excluded);
  const base = `exam-${x.day}-${x.stage.id}-${x.attempt}${x.round > 1 ? `-r${x.round}` : ""}${x.tag ? `-${x.tag}` : ""}`;
  const hide = ["sleep/", ...files];
  /** 写事件库的专员、没有整理前的拷贝：整理前那一场考不了 */
  const noCopy = x.stage.memWrite && x.storeBefore === "live";
  /** 常驻那层为什么不考（注入预览、中期视图拼不出来）：按状态记 */
  const residentOff = new Map<string, string>();

  const grader = grading(host, { id: `${base}-grade-all`, model: exam.graderModel, opening: S.leadprompts.graderOpening, hide });
  // 整理前那一场另用一个判分的会话（用到才开）：判过两次「错」的那个会话带着自己的理由，容易把整理前的回答也判错——
  // 那就把「整理前答得出、整理后答不出」看成了「两次都答不出」，正是这场考试要抓的东西
  const graderBefore = grading(host, { id: `${base}-grade-before`, model: exam.graderModel, opening: S.leadprompts.graderOpening, hide });
  let keepOpen = false;
  type View = { injection: string; appendix: string };
  const views = new Map<string, Promise<View>>();
  const view = (state: "after" | "before"): Promise<View> => {
    let v = views.get(state);
    if (!v) {
      v = (async (): Promise<View> => {
        const appendix = appendixText(contents(state, appended), exam.appendixChars);
        const store = state === "after" ? "live" : x.storeBefore;
        const mid = residentMemory(host, exam, { day: x.day, state, store });
        if (mid.failed) residentOff.set(state, mid.failed);
        let injection = P.EXAM_NOTHING_INJECTED;
        if (injected.length) {
          const fs = contents(state, injected);
          try { injection = await host.preview({ day: x.day, stage: x.stage.id, state, files: fs }); } catch (e) {
            // 预览拼不出来：常驻那层不考（不拿原样的文件冒充明天的样子）；查得到那层给原样的
            residentOff.set(state, msg(e).slice(0, 300) || S.consistency.previewFailed);
            injection = plainInjection(fs);
          }
        }
        return { injection: withMemory(injection, mid.text), appendix };
      })();
      views.set(state, v);
    }
    return v;
  };

  /** 考一场：常驻、查得到各一个考生，交的一次判完，每道题的判定记进题库的结果表 */
  const sit = async (phase: Phase, papers: Question[]): Promise<Map<string, Mark>> => {
    const state = phase === "before" ? "before" : "after";
    const store = phase === "before" ? x.storeBefore : "live";
    const v = await view(state);
    const items: Array<{ q: Question; answer: string }> = [];
    for (const layer of ["resident", "searchable"] as const) {
      const group = papers.filter((q) => q.layer === layer);
      if (!group.length) continue;
      const off = layer === "resident" ? residentOff.get(state) : undefined;
      if (off) {
        const line = LP.CONSIST.residentOff(off);
        if (!notes.includes(line)) notes.push(line);
        o.log?.warn("sleep: consistency exam cannot build the resident view, resident layer not examined", { day: x.day, stage: x.stage.id, state, why: off });
        continue;
      }
      const answers = await examineLayer(host, {
        id: `${base}-${phase}-${layer}`, model: exam.examineeModel, opening, layer, injection: v.injection, questions: group, store, hide,
        ...(layer === "searchable" && v.appendix ? { appendix: v.appendix } : {}),
      });
      if (!answers) throw new Broken(S.consistency.noPaper(phase, layer));
      for (const q of group) items.push({ q, answer: answers.get(q.id) ?? S.marks.noAnswer });
    }
    const out = new Map<string, Mark>();
    if (!items.length) return out;
    // 判分的不带她的整份开头：一句话的开头就够；一场考试（整理后、重考、整理前）用同一个判分会话，不一轮开一个
    const g = await (phase === "before" ? graderBefore : grader).grade(items, []);
    if (!g) throw new Broken(S.consistency.noGrades(phase));
    for (const { q, answer } of items) {
      const got = g.grades.get(q.id);
      // 整理前那一场判分漏了哪道：不能当成「整理前也答不出」（那就放过去了）——没法判，这一场算没考成
      if (!got && phase === "before") throw new Broken(S.consistency.noVerdictFor(q.id));
      const r = got ?? { verdict: "wrong" as const, reason: S.consistency.noVerdict };
      out.set(q.id, { verdict: r.verdict, reason: r.reason, answer });
      bank.record({ q: q.id, day: x.day, stage: x.stage.id, phase, layer: q.layer, verdict: r.verdict, reason: r.reason, answer });
    }
    return out;
  };

  try {
    const after = await sit("after", sitting);
    const wrong = sitting.filter((q) => after.get(q.id)?.verdict === "wrong");
    if (wrong.length) for (const [id, m] of await sit("retake", wrong)) after.set(id, m);
    const examined = sitting.filter((q) => after.has(q.id));
    if (!examined.length) return { examined: false, pass: false, failed: [], notes: [...notes, LP.CONSIST.noQuestions], scoreAfter: null, scoreBefore: null };

    const failed: ConsistencyResult["failed"] = [];
    const row = (q: Question, why: string, before?: string): ConsistencyResult["failed"][number] =>
      ({ id: q.id, probe: probeOf(q), q: q.q, gold: q.gold, after: after.get(q.id)!.answer, ...(before !== undefined ? { before } : {}), why });
    // keep：整理后还错的，拿整理前的样子考
    const lost = examined.filter((q) => probeOf(q) === "keep" && after.get(q.id)!.verdict === "wrong");
    let scoreBefore: number | null = null;
    if (lost.length && noCopy) {
      notes.push(LP.CONSIST.noCopyNote);
      o.log?.warn("sleep: no event-store copy for a specialist that writes the store, the before sitting is skipped and wrong keep-questions count as broken", { day: x.day, stage: x.stage.id });
      for (const q of lost) failed.push(row(q, LP.CONSIST.noCopy));
    } else if (lost.length) {
      const before = await sit("before", lost);
      scoreBefore = mean([...before.values()].map((m) => SCORE[m.verdict]));
      for (const q of lost) {
        const b = before.get(q.id);
        // 常驻那层整理前的样子拼不出来（上面记过一句）：没法判，跟没有拷贝一样照碰坏了算
        if (!b) { failed.push(row(q, LP.CONSIST.noBeforeView)); continue; }
        if (b.verdict === "right") failed.push(row(q, LP.CONSIST.lost, b.answer));
        else notes.push(b.verdict === "partial" ? LP.CONSIST.beforePartial(q.q) : LP.CONSIST.bothWrong(q.q));
      }
    }
    for (const q of examined) if (probeOf(q) === "keep" && after.get(q.id)!.verdict === "partial") notes.push(LP.CONSIST.afterPartial(q.q));
    // new / missed：只考整理后（不考整理前），合起来的得分率要到线
    // continuity（每晚固定要问的）单独判：每一道整理后（重考过一次）都得答对，不进得分率
    for (const q of examined) if (probeOf(q) === "continuity" && after.get(q.id)!.verdict !== "right") failed.push(row(q, LP.CONSIST.continuity));
    const fresh = examined.filter((q) => probeOf(q) === "new" || probeOf(q) === "missed");
    const rate = fresh.length ? mean([...fresh.map((q) => SCORE[after.get(q.id)!.verdict]), ...(x.carried ?? [])]) : null;
    const need = flow.team?.tolerance ?? 0.85;
    const missed = fresh.filter((q) => after.get(q.id)!.verdict !== "right");
    const below = rate !== null && rate < need;
    if (below) for (const q of missed) failed.push(row(q, LP.CONSIST.belowRate(rate, need)));
    else for (const q of missed) notes.push(LP.CONSIST.newWrong(q.q, probeOf(q)));
    // 这一场的题都对、带过来的把得分率拖到线下：也不算过
    if (below && !missed.length) notes.push(LP.CONSIST.belowRate(rate, need));
    keepOpen = true;
    return {
      examined: true, pass: failed.length === 0 && !below, failed, notes, scoreAfter: mean(examined.map((q) => SCORE[after.get(q.id)!.verdict])), scoreBefore,
      marks: Object.fromEntries(examined.map((q) => [q.id, after.get(q.id)!.verdict])),
      answers: Object.fromEntries(examined.map((q) => [q.id, after.get(q.id)!.answer])),
      regrade: async (items) => { try { return (await grader.grade(items, []))?.grades ?? null; } catch { return null; } },
      close: () => grader.close(),
    };
  } catch (e) {
    if (!(e instanceof Broken)) o.log?.warn("sleep: consistency exam threw", { day: x.day, stage: x.stage.id, error: msg(e).slice(0, 300) });
    return { examined: false, pass: false, failed: [], notes: [...notes, LP.CONSIST.broken(msg(e).slice(0, 200))], scoreAfter: null, scoreBefore: null };
  } finally {
    await graderBefore.close();
    // 考完了的把判分的会话留着（领导定夺时可能要照改过的标准答案重判一次），调用方定完再关；没考完的这里就关
    if (!keepOpen) await grader.close();
  }
}

/** 固定要问的一道题：题库里的那道（gold = must）加上 must 和细节 */
export type ContinuityQuestion = Question & { must: string; extras: string[] };
export interface ContinuityResult {
  examined: boolean;
  pass: boolean;
  /** 要点没答对的（重考过一次） */
  failed: Array<{ id: string; q: string; must: string; answer: string }>;
  must: { right: number; total: number };
  extras: { right: number; total: number };
  notes: string[];
}

/**
 * 固定要问的题单独一场（常驻那层，不让查）：opening、injection 是今晚都整理完她醒来看到的样子（调用方拼好给进来）。
 * 判分：每道题的要点（must）一条、每个细节一条，各判各的。要点得判「对」——错了、只对一部分的重考一次，还不对这道题就没过；
 * 细节只数对了几条。会话坏了没考完：examined false、pass false。不往外抛
 */
export async function continuityExam(o: { host: ExamHost; bank: Bank; flow: FlowConfig; log?: Pick<Logger, "warn"> }, x: {
  day: string; stage: StageSpec; attempt: number; round: number; questions: ContinuityQuestion[]; opening: string; injection: string;
  /** 会话 id 里多加的一段（改了题单独再考：requiz） */
  tag?: string;
}): Promise<ContinuityResult> {
  const { host, bank, flow } = o;
  const none: ContinuityResult = { examined: false, pass: false, failed: [], must: { right: 0, total: x.questions.length }, extras: { right: 0, total: 0 }, notes: [] };
  if (!x.questions.length) return { ...none, notes: [LP.CONSIST.noQuestions] };
  const base = `exam-${x.day}-${x.stage.id}-${x.attempt}${x.round > 1 ? `-r${x.round}` : ""}-continuity${x.tag ? `-${x.tag}` : ""}`;
  const hide = ["sleep/"];
  const grader = grading(host, { id: `${base}-grade-all`, model: flow.exam.graderModel, opening: S.leadprompts.graderOpening, hide });
  const sit = async (tag: string, qs: ContinuityQuestion[]): Promise<Map<string, { must: Verdict; answer: string; extras: Verdict[] }>> => {
    const answers = await examineLayer(host, { id: `${base}${tag}-resident`, model: flow.exam.examineeModel, opening: x.opening, layer: "resident", injection: x.injection, questions: qs, store: "live", hide });
    if (!answers) throw new Broken(S.consistency.continuityNoPaper(tag));
    // 判分的卷子：要点一条（题号原样）、每个细节一条（题号后面接 #细节几）
    const items = qs.flatMap((q) => {
      const answer = answers.get(q.id) ?? S.marks.noAnswer;
      return [{ q: { ...q, gold: q.must }, answer }, ...q.extras.map((e, i) => ({ q: { ...q, id: S.consistency.detailId(q.id, i + 1), gold: e, accept: "" }, answer }))];
    });
    const g = await grader.grade(items, []);
    if (!g) throw new Broken(S.consistency.continuityNoGrades(tag));
    const out = new Map<string, { must: Verdict; answer: string; extras: Verdict[] }>();
    for (const q of qs) {
      const m = g.grades.get(q.id);
      if (!m) throw new Broken(S.consistency.continuityNoVerdict(tag, q.id));
      const answer = answers.get(q.id) ?? S.marks.noAnswer;
      bank.record({ q: q.id, day: x.day, stage: x.stage.id, phase: tag ? "retake" : "after", layer: "resident", verdict: m.verdict, reason: m.reason, answer });
      out.set(q.id, { must: m.verdict, answer, extras: q.extras.map((_e, i) => g.grades.get(S.consistency.detailId(q.id, i + 1))?.verdict ?? "wrong") });
    }
    return out;
  };
  try {
    const marks = await sit("", x.questions);
    const again = x.questions.filter((q) => marks.get(q.id)!.must !== "right");
    if (again.length) for (const [id, m] of await sit("-retake", again)) marks.set(id, m);
    const failed = x.questions.filter((q) => marks.get(q.id)!.must !== "right").map((q) => ({ id: q.id, q: q.q, must: q.must, answer: marks.get(q.id)!.answer }));
    const ex = x.questions.flatMap((q) => marks.get(q.id)!.extras);
    return {
      examined: true, pass: failed.length === 0, failed, notes: [],
      must: { right: x.questions.length - failed.length, total: x.questions.length },
      extras: { right: ex.filter((v) => v === "right").length, total: ex.length },
    };
  } catch (e) {
    if (!(e instanceof Broken)) o.log?.warn("sleep: continuity exam threw", { day: x.day, stage: x.stage.id, error: msg(e).slice(0, 300) });
    return { ...none, notes: [LP.CONSIST.broken(msg(e).slice(0, 200))] };
  } finally {
    await grader.close();
  }
}
