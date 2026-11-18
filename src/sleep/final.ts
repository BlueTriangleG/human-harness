// 全天考试（spec §8.8）：一天的各段都过了以后，对着「明天醒来的她」再考一遍——注入是各段的提案现在拼出来的样子，
// 事件库用 live（今晚各段的批都已经提交）。考：被两段以上碰过的东西上挂着的题（今天的待定题加生效题，上限 finalShared）、
// 今天各段的暗题、挂在今晚碰过的东西上的旧题（上限 finalOld）、题库里随机抽的（finalSample）；后两样不要今晚哪一段已经考过的
// （不重考一段考过、后来再没被别的段碰过的题）。常驻、查得到各开一个考生，只在仓库的查出处；一次判完；错的重考一次。
// 重考还错的追到最后一个碰过它的段，交回 runner 叫那一段带着这些题重做（runner 只重做一次，第二次考还点名的进报告「拿不准」）；
// 今晚以前就答不好的旧题、追不到今晚哪一段的，只写 notes（进报告最上面）。
// runner 给的是每次过了的尝试：全天考试叫的重做只在现在的提案上改，第一次和重做的碰过的东西、改过的文件合在一起算。
// 改层的 op 这里不动：重做过了的那次考试只换掉它重新定过的题的层 op，没重做的留着原来的。
// 不往外抛：考生或判分两次都坏了、里头出了没想到的错，都记 warn、写一句「全天考试没考完」、当作没有要重做的。
import type { Logger } from "../log.ts";
import { examOrder, type Bank, type Layer, type Question, type Tags, type Verdict } from "./bank.ts";
import { appendixText, checkArchive, examineLayer, grade, injectedFile, lineKept, markStripper, plainInjection, type ExamHost } from "./exam.ts";
import { touchesTags } from "./things.ts";
import { capOld, changedThings, declaredLayers, overlayOf, residentMemory, retiredNote, thing, withGold, withMemory } from "./examiner.ts";
import type { FlowConfig, Model } from "./flow.ts";
import type { LadderPlan } from "./ladder.ts";
import type { MiniFs, StageRecord } from "./record.ts";
import { P, S } from "../lang/index.ts";

export interface FinalOpts {
  host: ExamHost; bank: Bank; flow: FlowConfig;
  /** 路径相对工作区（跟 runner 的一样）：提案在 sleep/<日>/proposed/ 下 */
  fs: MiniFs;
  rnd: () => number; ladder: () => LadderPlan;
  /** runner 给的：这一天每次过了的尝试（按过的先后，同一段重做过了有两条）和那一次的变更记录 */
  passed: (day: string) => Array<{ stage: string; record: StageRecord }>;
  /** runner 给的：今晚改过的文件今晚以前的样子（只在仓库那层看挪走的那行还在不在）；不给就照旧只看那一行在不在 */
  tonight?: (day: string) => { before: Map<string, string | null>; after: Map<string, string | null> };
  /**
   * runner 给的：这一夜开始的那一刻。「今晚哪一段考过」「今晚以前最后一次答得怎样」都按结果记下的时刻跟它比
   * （同一天换一夜再整理时，材料的日子分不出今晚和以前）；不给是 0（以前的判定都看不到）
   */
  nightStart?: () => number;
  log?: Pick<Logger, "warn">;
}

type Redo = Array<{ stage: string; problems: string[] }>;
/** notes 有才给 */
interface Outcome { redo: Redo; notes?: string[] }

type Round = "after" | "retake";
interface Mark { verdict: Verdict; reason: string; answer: string }
/** 一道题这一次的卷子：layer 是今晚各段的 affects 写的新层（后过的段写的算），没写就是题自己的层 */
interface Paper { q: Question; layer: Layer; after?: Mark; retake?: Mark }
/** 一次过了的尝试碰过的东西（跟一段的考试同一个说法：改了的文件、change target 的文件和 e/n 编号） */
interface Touch { stage: string; record: StageRecord; files: Set<string>; events: Set<string> }
/**
 * hide：考生、判分都不让读的（sleep/ 和今晚改过的每个文件：答案从注入里给，旧版本不能翻）；
 * injection 只有改过的文件里明天会注入的，appendix 是别的改过的文件（查得到那层才给）；
 * residentOff：注入预览没拼成的理由（常驻那层不考），没出事是 null
 */
interface Room {
  o: FinalOpts; day: string; base: string; opening: string; injection: string; appendix: string; residentOff: string | null; grader: Model; hide: string[];
  /** 考生看的中期视图（exam.residentMemory 开着才有；全天考试只考整理后，用现在的库：切换前 P6） */
  memory: string;
  /** 「路径:行」的出处还在不在（lineKept：挪走的那行得还在今晚改过的文件里） */
  kept: (ref: string) => boolean;
}

/** 考生或判分会话两次都坏了 */
class Broken extends Error {}

const SITTING = ["resident", "searchable"] as const;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 每次调用考一次。同一天第二次调用（runner 重做完再考）会话 id 用 final2，而且第一次重考还错的题一定再考
 * （不管它重做时段的考试考没考过、上限满没满：丢了的还丢着，就进报告「拿不准」）。一夜一个（跟 runner 一起建）
 */
export function finalExam(o: FinalOpts): (day: string) => Promise<Outcome> {
  const calls = new Map<string, number>();
  const lost = new Map<string, string[]>();
  return async (day) => {
    const n = (calls.get(day) ?? 0) + 1;
    calls.set(day, n);
    try {
      const r = await sit(o, day, n, n > 1 ? lost.get(day) ?? [] : []);
      if (n === 1) lost.set(day, r.lost);
      return r.out;
    } catch (e) {
      o.log?.warn(e instanceof Broken ? "sleep: final exam session failed twice, not examined" : "sleep: final exam threw, not examined",
        { day, call: n, error: msg(e).slice(0, 300) });
      return { redo: [], notes: [S.final.notFinished(msg(e).slice(0, 300))] };
    }
  };
}

/** again：第一次重考还错的题号（第二次一定再考） */
async function sit(o: FinalOpts, day: string, n: number, again: string[]): Promise<{ out: Outcome; lost: string[] }> {
  const touches = o.passed(day).map(({ stage, record }): Touch => {
    const c = changedThings(record);
    return { stage, record, files: new Set(c.files), events: new Set(c.events) };
  });
  // 今晚一段都没过：什么都没改，不用考
  if (!touches.length) return { out: { redo: [] }, lost: [] };
  const notes: string[] = [];
  const papers = pick(o, day, touches, notes, again);
  if (!papers.length) return { out: withNotes({ redo: [] }, notes), lost: [] };
  const room = await seat(o, day, n, touches);
  if (room.residentOff) {
    notes.unshift(P.EXAM_PREVIEW_FAILED(room.residentOff));
    o.log?.warn("sleep: final exam injection preview failed, resident layer not examined", { day, error: room.residentOff });
  }
  // 注入预览没拼成：常驻那层的不考、不追
  const live = papers.filter((p) => !(room.residentOff && p.layer === "resident"));
  await round(room, "after", live);
  const wrong = live.filter((p) => p.layer !== "archive" && p.after?.verdict === "wrong");
  if (wrong.length) await round(room, "retake", wrong);
  const wrongStill = live.filter((p) => (p.retake ?? p.after)?.verdict === "wrong");
  const out = trace(o, day, wrongStill, touches);
  return { out: withNotes(out, [...notes, ...(out.notes ?? [])]), lost: wrongStill.map((p) => p.q.id) };
}

/** notes 有才给 */
const withNotes = (r: Outcome, notes: string[]): Outcome => (notes.length ? { redo: r.redo, notes } : { redo: r.redo });

// ---------- 挑题 ----------

/** 挂在这些东西上（跟 bank.touching 同一个说法，只看文件和事件标签） */
const hangs = (q: Question, t: Pick<Tags, "files" | "events">): boolean => touchesTags(q, t);

/**
 * 考哪几道（同一道只考一次）：
 * - 被两段以上碰过的东西上挂着的今天待定题和生效题：照 examOrder 取前 finalShared 道；
 * - 今天各段的暗题；
 * - 挂在今晚碰过的东西上的生效题（照 examOrder 取前 finalOld 道）、题库里抽的（finalSample）：都不要今晚哪一段已经考过的。
 * 三个上限都照 oldScale 压。省钱阶梯到了 final-old：只考生效题，跳过今天的待定题和暗题。只看今晚过了的段出的待定题
 */
function pick(o: FinalOpts, day: string, touches: Touch[], notes: string[], again: string[]): Paper[] {
  const plan = o.ladder();
  // 今晚过了的段申请的改题、退休：改了的照新答案考，退休的不考（spec §8.6）
  const ov = overlayOf(o.bank, day, [...new Set(touches.map((t) => t.stage))]);
  const cap = (k: number): number => capOld(k, plan.oldScale);
  // 每样东西被哪几段碰过（同一段第一次和重做都碰过，算一段）
  const stages = (key: "files" | "events"): Map<string, Set<string>> => {
    const m = new Map<string, Set<string>>();
    for (const t of touches) for (const x of t[key]) m.set(x, (m.get(x) ?? new Set()).add(t.stage));
    return m;
  };
  const files = stages("files");
  const events = stages("events");
  const shared = (m: Map<string, Set<string>>): string[] => [...m].filter(([, by]) => by.size >= 2).map(([x]) => x);
  const multi = { files: shared(files), events: shared(events) };
  const tonight = { files: [...files.keys()], events: [...events.keys()] };

  const passed = new Set(touches.map((t) => t.stage));
  const today = plan.finalOldOnly ? [] : o.bank.pending(day).filter((q) => passed.has(q.stage));
  const picked = new Map<string, Question>();
  const add = (q: Question): void => {
    if (picked.has(q.id)) return;
    if (ov.retired.has(q.id)) {
      const line = retiredNote(q);
      if (!notes.includes(line)) notes.push(line);
      return;
    }
    picked.set(q.id, withGold(ov, q));
  };
  // 第一次重考还错的（第二次调用）：一定再考，不算上限、不管今晚考没考过
  for (const id of again) {
    const q = o.bank.get(id);
    if (q && (q.status === "active" || (q.status === "pending" && q.day === day))) add(q);
  }
  [...today.filter((q) => !q.hidden && hangs(q, multi)), ...o.bank.touching(multi, Infinity)]
    .sort(examOrder).slice(0, cap(o.flow.exam.finalShared)).forEach(add);
  today.filter((q) => q.hidden).forEach(add);
  const examined = o.bank.examinedOn(day, o.nightStart?.() ?? 0);
  o.bank.touching(tonight, Infinity).filter((q) => !examined.has(q.id)).slice(0, cap(o.flow.exam.finalOld)).forEach(add);
  o.bank.sample(cap(o.flow.exam.finalSample), o.rnd, new Set([...picked.keys(), ...examined, ...ov.retired])).forEach(add);

  // affects 写的层（算数的、一次一层；后过的段写的算；申请了退休的不算）。没写的照今晚过了的段记下的改层 op
  // （段的考试判分判的、重要度 ≥ 4 的判分同意了的），不管重要度：明天醒来它就在那一层（plan 3 A5）
  const declared = new Map<string, Layer>();
  // 更正、合并的链接：照写下这条记录的那一次尝试的批认（修正轮 M1）
  const parentsFor = (r: StageRecord) => (id: string): string[] => { try { return o.host.parentsOf?.(id, { day: r.day, stage: r.stage, attempt: r.attempt }) ?? []; } catch { return []; } };
  for (const t of touches) for (const [q, layer] of declaredLayers(t.record, o.bank, day, ov.retired, parentsFor(t.record))) declared.set(q, layer);
  const agreed = new Map<string, Layer>();
  for (const op of o.bank.pendingOps(day, [...passed])) if (op.kind === "layer") agreed.set(op.q, op.layer);
  return [...picked.values()].map((q) => ({ q, layer: declared.get(q.id) ?? agreed.get(q.id) ?? q.layer }));
}

// ---------- 考 ----------

/**
 * 场地：各段改过的文件用 proposed/ 现在的样子：明天会注入的（基础块、exam.inject 点名的）进注入（走预览脚本），
 * 别的进查得到那层的附录；开头去掉今晚任何一段改过的基础块
 */
async function seat(o: FinalOpts, day: string, n: number, touches: Touch[]): Promise<Room> {
  const exam = o.flow.exam;
  const files = [...new Set(touches.flatMap((t) => t.record.actual.files.map((f) => f.path)))];
  const view = (ps: string[]) => new Map(ps.map((p): [string, string | null] => [p, o.fs.read(`sleep/${day}/proposed/${p}`)]));
  const injected = view(files.filter((p) => injectedFile(exam, p)));
  let injection: string = P.EXAM_NOTHING_INJECTED;
  let residentOff: string | null = null;
  if (injected.size) {
    try { injection = await o.host.preview({ day, stage: "final", state: "after", files: injected }); } catch (e) {
      residentOff = msg(e).slice(0, 300) || S.final.noReason;
      injection = plainInjection(injected);
    }
  }
  // 切换前 P6：常驻那层也看中期视图（现在的库）；拼不出来跟预览没拼成一样，常驻那层不考
  const mid = residentMemory(o.host, exam, { day, state: "after", store: "live" });
  if (mid.failed) residentOff ??= mid.failed;
  const tonight = o.tonight?.(day);
  const strip = markStripper(exam.ignoreMarks);
  const kept = lineKept({
    changed: new Set(files),
    before: (p) => (tonight ? (tonight.before.has(p) ? tonight.before.get(p)! : undefined) : undefined),
    after: (p) => o.fs.read(`sleep/${day}/proposed/${p}`),
    exists: (ref) => o.host.sourceExists(ref, { day, state: "after" }),
    ...(strip ? { strip } : {}),
  });
  return {
    o, day, injection, residentOff, kept, grader: o.ladder().cheap ? "sonnet" : exam.graderModel, hide: ["sleep/", ...files], memory: mid.text,
    appendix: appendixText(view(files.filter((p) => !injectedFile(exam, p))), exam.appendixChars),
    base: n === 1 ? `exam-${day}-final` : `exam-${day}-final${n}`,
    opening: o.host.opening(files.filter((p) => exam.baseBlocks.includes(p))),
  };
}

/** 每次判定都进题库的结果表（phase final） */
function mark(r: Room, phase: Round, p: Paper, m: Mark): void {
  p[phase] = m;
  r.o.bank.record({ q: p.q.id, day: r.day, stage: "final", phase: "final", layer: p.layer, verdict: m.verdict, reason: m.reason, answer: m.answer });
}

/** 考一轮：常驻、查得到这一层有题就开一个考生，只在仓库的查出处；考生交的一次判完 */
async function round(r: Room, phase: Round, papers: Paper[]): Promise<void> {
  const { host, flow } = r.o;
  const items: Array<{ p: Paper; answer: string }> = [];
  for (const layer of SITTING) {
    const group = papers.filter((p) => p.layer === layer);
    if (!group.length) continue;
    const answers = await examineLayer(host, {
      id: `${r.base}-${phase}-${layer}`, model: flow.exam.examineeModel, opening: r.opening, layer,
      // 中期视图常驻、查得到两层都给（跟她白天的前缀一样：终审修正轮 M3）
      injection: withMemory(r.injection, r.memory), questions: group.map((p) => p.q), store: "live", hide: r.hide,
      ...(layer === "searchable" && r.appendix ? { appendix: r.appendix } : {}),
    });
    if (!answers) throw new Broken(S.final.noPaper(phase, layer));
    for (const p of group) items.push({ p, answer: answers.get(p.q.id) ?? S.marks.noAnswer });
  }
  for (const p of papers.filter((x) => x.layer === "archive")) {
    const verdict = checkArchive(host, p.q, { day: r.day, state: "after" }, r.kept);
    mark(r, phase, p, { verdict, reason: verdict === "right" ? S.final.refsFound : S.final.refsMissing, answer: "" });
  }
  if (!items.length) return;
  const g = await grade(host, {
    id: `${r.base}-grade-${phase}`, model: r.grader, opening: r.opening,
    items: items.map(({ p, answer }) => ({ q: p.q, answer })), askLayers: [], hide: r.hide,
  });
  if (!g) throw new Broken(S.final.noGrades(phase));
  for (const { p, answer } of items) {
    const v = g.grades.get(p.q.id) ?? { verdict: "wrong" as const, reason: S.final.noVerdict };
    mark(r, phase, p, { verdict: v.verdict, reason: v.reason, answer });
  }
}

// ---------- 追到哪一段 ----------

/**
 * 重考还错的题追到哪一段：
 * - 旧题（不是今天的待定题）今晚以前最后一次就判错或部分对：整理前就答不好，不点名哪一段，只写 note；
 * - 按题的标签（文件、事件）和出处，从后往前找第一个碰过其中任何一样的过了的段；
 * - 找不到：今天出的题算出这道题的段（得是今晚过了的）；旧题、还找不到的只写 note。
 * 每段一条，按过的先后；note 都记 warn
 */
function trace(o: FinalOpts, day: string, lost: Paper[], touches: Touch[]): Outcome {
  const problems = new Map<string, string[]>();
  const notes: string[] = [];
  const brief = (q: Question) => ({ day, q: q.id, question: q.q.slice(0, 200), gold: q.gold.slice(0, 200) });
  for (const p of lost) {
    const old = !(p.q.status === "pending" && p.q.day === day);
    const before = old ? o.bank.lastVerdictBefore(p.q.id, o.nightStart?.() ?? 0) : null;
    if (before === "wrong" || before === "partial") {
      notes.push(S.final.wrongBefore(p.q.q));
      o.log?.warn("sleep: final exam wrong answer was shaky before tonight, no stage named", { ...brief(p.q), before });
      continue;
    }
    const things = [...p.q.tags.files, ...p.q.tags.events, ...p.q.sources].map(thing).filter(Boolean);
    // 从后往前：重做过了的那一次算后碰的。都没碰过：今天出的题算出题的那一段（得是今晚过了的）；旧题不算在同名的段头上
    const last = [...touches].reverse().find((t) => things.some((x) => t.files.has(x) || t.events.has(x)))?.stage
      ?? (!old ? touches.find((t) => t.stage === p.q.stage)?.stage : undefined);
    if (last === undefined) {
      notes.push(S.final.wrongUntraced(p.q.q, p.q.gold));
      o.log?.warn("sleep: final exam wrong answer traced to no stage tonight", brief(p.q));
      continue;
    }
    const line = S.final.wrongLine(p.q.q, p.q.gold);
    const list = problems.get(last);
    if (list) list.push(line);
    else problems.set(last, [line]);
  }
  const order = [...new Set(touches.map((t) => t.stage))];
  const redo = order.flatMap((stage) => { const ps = problems.get(stage); return ps ? [{ stage, problems: ps }] : []; });
  return notes.length ? { redo, notes } : { redo };
}
