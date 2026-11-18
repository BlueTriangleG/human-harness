// 专员 + 领导的一夜（engine: "team"）：专员照配置里的顺序一个个做；每个交差以后，领导看它实际改了什么、出题，
// 拿整理后、整理前各考一遍（consistency.ts），领导照结果定过不过（硬规矩：考试没过，它说过也不算）。
// 这一版没过就是整份不要：它的文件恢复、事件库那一批撤回、题丢掉；required 的专员没过，这一天不落地；别的专员没过，这一天照样落地、记一条欠着。
// 没有核依据、交叉审、前额叶的会话，也没有每段自己的考试和全天考试。
import * as L from "./ledger.ts";
import * as LP from "./leadprompts.ts";
import { B, P, S } from "../lang/index.ts";
import type { Bank, Question, Verdict } from "./bank.ts";
import { SCORE } from "./bank.ts";
import { units } from "./budget.ts";
import { consistencyExam, continuityExam, type ConsistencyResult, type ContinuityQuestion, type ContinuityResult } from "./consistency.ts";
import { injectedFile, plainInjection } from "./exam.ts";
import { residentMemory, withMemory } from "./examiner.ts";
import { changedThings } from "./examiner.ts";
import { matchWrites, type FlowConfig, type StageSpec, type TeamConfig } from "./flow.ts";
import { leadId, nightHosts, replayArgs, type NightBrain, type NightHosts, type NightPlan } from "./host.ts";
import { Lead, goldRevisionProblem, leadQuestionProblem, leadRuled, ownChangeProblem, withdrawProblem, type LeadLike } from "./lead.ts";
import { centralRef, touchesTags } from "./things.ts";
import type { AssembleOpts } from "./night.ts";
import { specialistDiff } from "./opsdiff.ts";
import { diff, proposedFiles, recordPath, restore, snapshot, type Snapshot } from "./record.ts";
import { Day, SleepRunner, stageBatch, type OpenedStage, type RunnerOptions, type StageHost } from "./runner.ts";
import type { StageUsage } from "./session.ts";
import type { LeadQuestion, LeadReview, StageDone } from "./tools.ts";
import { bookkeeping } from "./validate.ts";

/** 一个专员最多撤几道题；一夜的上限（team.withdrawCap 没写时） */
const WITHDRAW_STAGE_CAP = 2;
const WITHDRAW_NIGHT_CAP = 4;
/** 领导核标准答案时每条出处贴回去多少字 */
const EXCERPT_CHARS = 300;
/** 回放里落地的命令动了提案目录：不是哪个专员没过，是这次回放不能信（一路抛出去，回放算没跑成） */
export class FinishTouched extends Error {}
/** 回放里落地那几步一条命令最多跑多久 */
const FINISH_BUILD_MS = 10 * 60_000;
/** 引擎自己加的旧题（挂在这个专员改过的东西上的生效题）最多几道：team.old 没写时 */
export const TEAM_OLD_DEFAULT = 30;

export interface TeamRunnerOptions {
  team: TeamConfig;
  bank: Bank;
  /**
   * 这个专员的领导（一个专员一个会话：它头一次交差时开，定了就关；这一夜完了、叫停时也关）。
   * digest = 今晚前面几个专员定了什么（放在它第一条消息里），没有是 ""
   */
  lead(day: string, stage: StageSpec, digest: string): LeadLike;
  exam(x: Parameters<typeof consistencyExam>[1]): Promise<ConsistencyResult>;
  /**
   * 一条出处是不是从这个专员的改动以外来的（原话，或者它动手以前就有的；made = 它这一次在事件库里新建的编号）：
   * new / missed / continuity 的题至少要一条这样的出处。不给 = 不查这一条
   */
  outside?(x: { day: string; stage: StageSpec; before: Snapshot; made: ReadonlySet<string> }): (ref: string) => boolean;
  /** 回放：只有那一天的材料，不提、不划以前欠着的日子 */
  replay?: boolean;
  /**
   * 一条从改动以外来的出处的原文（host 的 exam.rawSource）：领导核标准答案、撤题的证据都照它读。
   * 读不出来的给 null。不给 = 都读不出来（就撤不了题、核不了）
   */
  rawSource?(x: { day: string; stage: StageSpec; before: Snapshot; ref: string }): { kind: "central" | "quote" | "path"; text: string } | null;
  /** 固定要问的题（continuity）单独的那一场 */
  continuity(x: Parameters<typeof continuityExam>[1]): Promise<ContinuityResult>;
  /** 今晚都整理完她醒来看到的样子（那一场的开头和注入）；built = 回放里落地那几步已经在工作区里拼过了 */
  wake(x: { day: string; built: boolean }): Promise<{ opening: string; injection: string }>;
  /** 回放才有：把真的夜里落地时拼的东西在回放的工作区里拼出来；拼不成给原因 */
  finishBuild?(day: string): Promise<string | null>;
}

interface RoleCost { do: number; lead: number; exam: number }

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const same = (a: string, b: string): boolean => a.replace(/\s+/g, "") === b.replace(/\s+/g, "");

/**
 * 专员照配置里的顺序做，不照 after：专员之间的 after 去掉（一个专员整份不要了，后面的照常做，不跟着推迟）；
 * 排在脚本后面的 after 留着（准备没过照旧挡住）
 */
function byPosition(flow: FlowConfig): FlowConfig {
  const agents = new Set(flow.stages.filter((s) => s.kind === "agent").map((s) => s.id));
  return { ...flow, stages: flow.stages.map((s) => (s.kind === "agent" ? { ...s, after: s.after.filter((a) => !agents.has(a)) } : s)) };
}

export class TeamRunner extends SleepRunner {
  private readonly t: TeamRunnerOptions;
  /** 这一天的领导 */
  private leadNow: { key: string; lead: LeadLike } | null = null;
  /** 今晚各天已经定了的专员（按定的先后）：下一个专员的领导开头要带 */
  /** 今晚一共撤了几道题（一夜的上限 team.withdrawCap） */
  private withdrawnTonight = 0;
  private readonly settledOf = new Map<string, Array<{ title: string; passed: boolean; targets: string[]; notes: string[] }>>();
  /** 领导正在看的那个专员（它这一轮的花费记到这一次头上） */
  private reviewing: { day: string; stage: string; n: number } | null = null;
  /** 领导的花费：<日>/<段>/<次> → 单位 */
  private readonly leadCost = new Map<string, number>();

  constructor(host: StageHost, flow: FlowConfig, o: RunnerOptions & TeamRunnerOptions) {
    super(host, byPosition(flow), o);
    this.t = o;
  }

  /** 段外会话的花费：领导的（lead-<日>…）记到它正在看的那个专员头上；考试的照旧（exam-<日>-<段>-<次>-…） */
  override charge(id: string, u: number): void {
    if (!id.startsWith("lead-")) return super.charge(id, u);
    if (!(u > 0) || !this.reviewing) return;
    const key = `${this.reviewing.day}/${this.reviewing.stage}/${this.reviewing.n}`;
    this.leadCost.set(key, (this.leadCost.get(key) ?? 0) + u);
  }

  override async runNight(o: Parameters<SleepRunner["runNight"]>[0]): ReturnType<SleepRunner["runNight"]> {
    try { return await super.runNight(o); } finally { this.closeLead(); }
  }

  override abort(why: string): void {
    super.abort(why);
    // 正在等领导的那一份别等到它超时
    this.closeLead();
  }

  private leadOf(day: string, s: StageSpec): LeadLike {
    const key = `${day}/${s.id}`;
    if (this.leadNow?.key !== key) {
      this.closeLead();
      const cap = this.t.team.digestCap ?? LP.DIGEST_CAP;
      const digest = LP.LEAD_DIGEST((this.settledOf.get(day) ?? []).map((x) => LP.DIGEST_BLOCK(x, cap)));
      this.leadNow = { key, lead: this.t.lead(day, s, digest) };
    }
    return this.leadNow.lead;
  }

  private closeLead(): void {
    const l = this.leadNow;
    this.leadNow = null;
    if (!l) return;
    const warn = (e: unknown): void => this.host.log.warn("sleep: closing the lead failed", { lead: l.key, error: msg(e).slice(0, 200) });
    try { l.lead.close().catch(warn); } catch (e) { warn(e); }
  }

  /** 这一天固定要问的题在哪个专员那里问：配置点名的，不然最后一个开着的专员 */
  private continuityAt(): string | null {
    if (!this.t.team.continuity.length) return null;
    return this.t.team.continuityAt ?? [...this.agents].reverse().find((s) => s.enabled)?.id ?? null;
  }

  /**
   * 一个专员：做一趟 → 领导看改动、出题 → 前后一致的考试 → 领导定。过了提交；没过、还有轮数：把要改的发回它还开着的那个会话，
   * 改完再交、领导只看这一轮新改的、再考（上一轮没过的题、领导新出的、这一轮碰过的已经过了的题）。最多 team.maxFixRounds 轮；
   * 还不过、会话不在了、这一轮超时或调用次数超了：整份不要。会话、事件库那一批、整理前的拷贝从头留到它定了
   */
  protected override async runStage(d: Day, s: StageSpec): Promise<void> {
    this.sampleSave();
    const h = this.host;
    const n1 = this.nextAttempt(d, s.id);
    const region = `sleep-${d.day}-${s.id}-${n1}`;
    const before = snapshot(d.root, () => true, h.fs);
    const run: Run = { n1, region, before, after: before, begun: false, held: null, billed: zeroUse(), examBilled: 0, done: null, pending: [], fixedIds: [], probes: new Map(), passed: new Map(), counts: { keep: 0, new: 0, missed: 0, continuity: 0 }, ops: 0, owed: [], lastExam: null, marks: new Map(), cont: new Map(), contRatio: null, lastFailed: new Map(), contFailed: new Map(), revised: new Map(), contMissing: [], rebuilt: false, rowOnRebuilt: false, rebuiltSince: false, leadNotes: [], withdrawn: new Map(), corrected: new Map(), refused: [], roundOne: new Set(), answers: new Map(), graders: [] };
    const maxRounds = 1 + Math.max(0, this.t.team.maxFixRounds);
    let n = n1;
    let row = L.startStage(h.db, { runId: this.runId, day: d.day, stage: s.id, attempt: n, model: s.model }, h.now());
    let out: RoundOut = { ok: false, problems: [], by: "rule", exam: null, asked: 0, error: null };
    try {
      const wake = this.wakeText(d, s, []);
      if ("problem" in wake) out = { ...out, problems: [wake.problem], error: wake.problem };
      else {
        // 整理前的事件库：会话开之前拷一份（只拷这一次；留到这个专员定了）
        try { await h.copyBefore?.(d.day, s.id, n1); } catch (e) { h.log.warn("sleep: copying the event store before the specialist failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
        // 以前几天这一段没做成、欠着的（今天这一天的不算）：叫醒的话最前面加一句，先补那几天的
        try { run.owed = this.t.replay ? [] : L.owed(h.db).filter((r) => r.stage === s.id && r.day < d.day).map((r) => r.day); } catch (e) { h.log.warn("sleep: reading the owed days failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
        let text = run.owed.length ? `${LP.OWED_FIRST(run.owed)}\n\n${wake.text}` : wake.text;
        let prev = before;
        let retry: string[] = [];
        for (let round = 1; !d.abortWhy; round++) {
          if (round === 1) {
            h.mem?.beginStage(region, stageBatch(d.day, s.id, n1));
            run.begun = true;
            run.held = this.hold(d, s, region);
          }
          this.reviewing = { day: d.day, stage: s.id, n };
          try { out = await this.round(d, s, run, { round, n, text, prev, retry }); } finally {
            // 这一轮考完还开着的判分会话（留着给领导定夺时重判用的）：定完了，关
            for (const close of run.graders.splice(0)) { try { await close(); } catch { /* 关不掉也算了：收摊时 host 会关 */ } }
          }
          // 它自己的题过了：固定要问的题（轮到它问的话）单独考一场，要点错了一样发回去改
          // 配置里固定要问的题领导没交上来：没有标准答案没法考，这道关不算过（不是写一句就放过去），也不发回去改
          if (out.ok && !d.abortWhy && run.contMissing.length) out = { ...out, ok: false, by: "rule", gate: false, problems: [LP.CONT.notHandedIn(run.contMissing)] };
          if (out.ok && !d.abortWhy && run.cont.size) out = await this.continuity(d, s, run, round, out);
          if (out.ok || d.abortWhy) break;
          // 没过：还能不能退回去改
          const fixable = (out.gate === true || (out.exam?.examined === true && out.gate !== false)) && round < maxRounds;
          if (!fixable) break;
          if (this.o.budget.overHard) { d.notes.push(LP.FIX_OVER_BUDGET(s.title)); break; }
          const live = run.held && !("error" in run.held) ? run.held : null;
          if (!live || !live.alive()) { d.notes.push(LP.FIX_SESSION_GONE(s.title)); h.log.warn("sleep: the held specialist session is gone, dropping instead of fixing", { day: d.day, stage: s.id, round }); break; }
          // 这一轮记一行（退回去改），下一轮另起一行
          this.endRow(d, s, run, row, n, { ...out, status: "redo", decision: `${out.by}:fix` });
          retry = (out.exam?.failed ?? []).map((f) => f.id);
          prev = run.after;
          text = LP.LEAD_FIX(out.fixes?.length ? out.fixes : out.problems, maxRounds - round - 1);
          n = this.nextAttempt(d, s.id);
          row = L.startStage(h.db, { runId: this.runId, day: d.day, stage: s.id, attempt: n, model: s.model }, h.now());
          run.rowOnRebuilt = run.rebuilt;
          h.log.info("sleep: specialist sent back to fix in its session", { day: d.day, stage: s.id, round: round + 1, problems: out.problems.length });
        }
        if (d.abortWhy) out = { ...out, ok: false, problems: [S.teamrun.aborted(d.abortWhy)] };
      }
    } catch (e) {
      // 这一趟里抛了错：这个专员的东西不能留一半，照没过收拾，再往外抛（runStages 会中止这一天）
      await this.settle(d, s, run, row, n, { ...out, ok: false, problems: [S.teamrun.failed(msg(e))], by: "rule" });
      throw e;
    } finally {
      this.reviewing = null;
    }
    await this.settle(d, s, run, row, n, out);
    // 这个专员定了：它的领导会话关掉（一个专员一个；下一个专员的领导是新的会话，开头带今晚到现在定了什么）
    this.closeLead();
  }

  /** 一轮：叫醒（第 1 轮是活儿，之后是要改的）→ 等交差 → 记录 → 领导看这一轮的改动、出题 → 考 → 领导定 */
  private async round(d: Day, s: StageSpec, run: Run, x: { round: number; n: number; text: string; prev: Snapshot; retry: string[] }): Promise<RoundOut> {
    const h = this.host;
    const none: RoundOut = { ok: false, problems: [], by: "rule", exam: null, asked: 0, error: null };
    const held = run.held;
    if (!held) return { ...none, problems: [S.teamrun.noSession], error: S.teamrun.noSession };
    if ("error" in held) return { ...none, problems: [held.error], error: held.error };
    // 该管的文件：交差时哪一处没动、也没说为什么，当场退回一次（会话里）
    const dutyLeft = (done: StageDone): Array<{ path: string; reason: string | null }> => {
      if (!s.duty?.length) return [];
      const changed = diff(run.before, snapshot(d.root, () => true, h.fs)).map((f) => f.path);
      // 前面几轮说过的也算（改的那一轮的报告只写这一轮改了什么）
      const lines = `${run.done?.report ?? ""}\n${done.report}`.split("\n");
      return s.duty.filter((g) => !changed.some((p) => matchWrites([g], p)))
        .map((g) => ({ path: g, reason: lines.find((l) => l.includes(g) && B.forms.dutyNoChange.test(l))?.trim() ?? null }));
    };
    const w = await held.work(x.text, (done) => {
      if (done.status === "blocked") return null;
      const silent = dutyLeft(done).filter((y) => y.reason === null).map((y) => y.path);
      return silent.length ? LP.DUTY_BOUNCE(silent) : null;
    });
    run.after = snapshot(d.root, () => true, h.fs);
    if (d.abortWhy) return { ...none, problems: [S.teamrun.aborted(d.abortWhy)] };
    if (!w.done) return { ...none, problems: [w.error ?? S.teamrun.noStageDone], error: w.error };
    // 改的那一轮交上来以后再看一眼：会话要是半路重开过，交的是一个不记得前面的会话做的，不算
    if (x.round > 1 && !held.alive()) { d.notes.push(LP.FIX_SESSION_GONE(s.title)); return { ...none, problems: [LP.FIX_SESSION_GONE(s.title)] }; }
    // 记录照整个专员算（动手前到现在）：后面的专员、落地看的是它；这一轮交的报告接在前面几轮后面
    const done: StageDone = run.done ? { ...w.done, changes: [...run.done.changes, ...w.done.changes], report: S.teamrun.reportAgain(run.done.report, x.round, w.done.report) } : w.done;
    run.done = done;
    const record = this.recordOf(d, s, run.n1, run.region, done, run.before, run.after);
    h.fs.write(recordPath(d.day, s.id, run.n1), JSON.stringify(record, null, 2));
    const changed = record.actual.files.length > 0 || record.actual.memOps > 0;
    if (w.done.status === "blocked") return { ...none, problems: [S.teamrun.cannotGoOn(w.done.blockedWhy ?? S.teamrun.noBlockedWhy)] };
    if (!changed && this.continuityAt() !== s.id) return { ...none, ok: true };
    const skip = x.round > 1 ? run.ops : 0;
    const lead = this.leadOf(d.day, s);
    const roundFiles = diff(x.prev, run.after);
    // 改的那一轮什么都没改（文件、事件库都没动）：不再看改动、不再考——上一轮的考试结果照旧，领导照它定（它上一次要改的没改）
    if (x.round > 1 && run.lastExam && roundFiles.length === 0 && record.actual.memOps - skip <= 0) {
      const exam = run.lastExam;
      const answer = await lead.verdict({ day: d.day, stage: s, round: x.round, exam, intent: [], note: S.leadprompts.fix.nothingChanged });
      const r = leadRuled({ title: s.title, exam, answer });
      d.notes.push(...r.notes.filter((t) => !d.notes.includes(t)));
      if (d.abortWhy) return { ...none, problems: [S.teamrun.aborted(d.abortWhy)] };
      return { ok: r.pass, problems: r.pass ? [] : r.problems.length ? r.problems : [S.teamrun.leadFailed], by: r.by, exam, asked: 0, error: null, fixes: this.fixesFor(exam, r.fixes ?? [], []) };
    }
    // 领导看的：这一轮实际改的（第 1 轮是全部；之后只有这一轮新改的），全文写到 flow/lead/<段>.<轮>.diff；给它的那一份每样照 team.diffCap 截
    const cap = this.t.team.diffCap ?? LP.LEAD_DIFF_CAP;
    const view = specialistDiff({
      fs: h.fs, day: d.day, stage: s.id, round: x.round, before: x.prev, after: run.after, opCount: record.actual.memOps - skip, filesCap: cap, opsCap: cap,
      hints: [...bookkeeping(s, record), ...(run.owed.length ? [LP.OWED_HINT(run.owed)] : []), ...dutyLeft(w.done).map((y) => LP.DUTY_LEFT(y.path, y.reason))], ops: (cap) => h.opsText?.(d.day, s.id, run.n1, cap, skip) ?? S.marks.noStore,
    });
    run.ops = record.actual.memOps;
    const fixed = x.round === 1 && this.continuityAt() === s.id ? this.t.team.continuity : [];
    // 标准答案得从这个专员的改动以外来：它这一批新建的编号、它提案里新加的行不算出处
    let made: ReadonlySet<string> = new Set();
    try { made = h.madeIn?.(d.day, s.id, run.n1) ?? made; } catch (e) { h.log.warn("sleep: reading the specialist's new ids failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    const outside = this.t.outside?.({ day: d.day, stage: s, before: run.before, made });
    const changesChars = Math.min(JSON.stringify(w.done.changes).length, cap);
    h.log.info("sleep: lead brief", { day: d.day, stage: s.id, round: x.round, chars: changesChars + view.files.length + view.ops.length, parts: { changes: changesChars, files: view.files.length, ops: view.ops.length } });
    const review = await lead.review({
      day: d.day, stage: s, round: x.round, done: w.done, diff: view, changesCap: cap, ...(fixed.length ? { continuity: fixed } : {}),
      ...(outside ? { check: (q: LeadQuestion) => ownChangeProblem(q, outside) } : {}),
      // 核标准答案时给它看的出处原文：头一条从改动以外来、读得出原文的出处，照这个专员动手前的样子读
      ...(this.t.rawSource ? { excerpt: (q: LeadQuestion) => {
        for (const ref of q.sources.map(String)) {
          if (outside && !outside(ref)) continue;
          const t = this.t.rawSource!({ day: d.day, stage: s, before: run.before, ref });
          if (t) return { ref, text: t.text.length > EXCERPT_CHARS ? `${t.text.slice(0, EXCERPT_CHARS)}…` : t.text };
        }
        return null;
      } } : {}),
    });
    // 这一轮实际碰过的：文件照两份快照的 diff，事件库的编号照这一批这一轮的行（不靠它交差时列没列）；第 1 轮再加上它自己列的
    let rows: string[] = [];
    try { rows = h.touchedIn?.(d.day, s.id, run.n1, skip) ?? []; } catch (e) { h.log.warn("sleep: reading the round's touched ids failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    const listed = x.round === 1 ? changedThings(record) : { files: [], events: [] };
    const touched = { files: [...new Set([...roundFiles.map((f) => f.path), ...listed.files])], events: [...new Set([...rows, ...listed.events])] };
    // 这一轮动没动常驻那层考生看得到的东西（基础块、会注入的文件；开着中期视图时事件库动了也算）：没动，过了的常驻题就不用再考
    // （回放里上一场以后落地那几步拼过工作区：考生看到的是照工作区拼的，也算变了）
    const viewChanged = roundFiles.some((f) => injectedFile(this.flow.exam, f.path)) || (this.flow.exam.residentMemory && record.actual.memOps - skip > 0) || run.rebuiltSince;
    run.rebuiltSince = false;
    const set = this.questions(d, s, run, x.round, touched, review, fixed, x.retry, viewChanged);
    if (d.abortWhy) return { ...none, problems: [S.teamrun.aborted(d.abortWhy)] };
    // 前面几轮答过、这一轮没再考的 new / missed 题照上一次的判定算进得分率
    const sitting = new Set(set.questions.map((q) => q.id));
    const carried = [...run.marks].filter(([id]) => !sitting.has(id) && (run.probes.get(id) === "new" || run.probes.get(id) === "missed")).map(([, v]) => SCORE[v]);
    const exam = await this.t.exam({ day: d.day, stage: s, attempt: run.n1, round: x.round, questions: set.questions, probes: run.probes, before: run.before, after: run.after, storeBefore: this.storeBefore(d, s), ...(carried.length ? { carried } : {}) });
    if (exam.close) run.graders.push(exam.close);
    if (exam.examined) { run.lastExam = exam; for (const [id, v] of Object.entries(exam.marks ?? {})) run.marks.set(id, v); for (const [id, a0] of Object.entries(exam.answers ?? {})) run.answers.set(id, a0); }
    d.notes.push(...set.notes, ...exam.notes.map((t) => S.marks.labeled(s.title, t)));
    if (!review) d.notes.push(S.lead.silentFor(S.lead.silent, s.title));
    if (review?.unchecked) d.notes.push(LP.UNCHECKED(s.title));
    // 这一轮考过了的题记下（下一轮不再考，除非那一轮碰到它挂着的东西）
    const failed = new Set(exam.failed.map((f) => f.id));
    if (exam.examined) for (const q of set.questions) { if (failed.has(q.id)) run.passed.delete(q.id); else run.passed.set(q.id, q); }
    const base = { exam, asked: set.questions.length, error: null };
    if (!exam.examined && !changed) {
      // 什么都没改、也没考成（只是轮到它问固定的题）：没有东西可丢，照过
      d.notes.push(S.teamrun.nothingChanged(s.title));
      return { ...base, ok: true, problems: [], by: "rule" };
    }
    // 连着两轮没过的题：定夺的时候先问领导是题的毛病还是答的毛病
    const failedNow = new Map(exam.failed.map((f) => [f.id, f]));
    // 每道带上它自己的出处和原文（照动手前的样子）：领导要指证据，得看得见（重开过的领导会话没见过出题那一轮）
    const twice = exam.examined ? [...failedNow.values()].filter((f) => run.lastFailed.has(f.id)).map((f) => ({
      id: f.id, q: f.q, gold: f.gold, answers: [run.lastFailed.get(f.id) ?? "", f.after],
      sources: (this.t.bank.get(f.id)?.sources ?? []).map((ref) => {
        let t: string | null = null;
        try { t = this.t.rawSource?.({ day: d.day, stage: s, before: run.before, ref: String(ref) })?.text ?? null; } catch { t = null; }
        return { ref: String(ref), text: t === null ? null : t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t };
      }),
    })) : [];
    if (exam.examined) run.lastFailed = new Map([...failedNow].map(([id, f]) => [id, f.after]));
    // 没考成的不问领导（没法判，问了也不算）：leadRuled 照没过收
    const answer = d.abortWhy || !exam.examined ? null : await lead.verdict({ day: d.day, stage: s, round: x.round, exam, intent: review?.intent ?? [], ...(twice.length ? { twice } : {}) });
    // 领导说标准答案有毛病的题：条件全是机械的（withdrawProblem）。标准答案里一个词写错了的（gold-wrong）不是撤掉——
    // 把那个词改对，让还开着的判分会话照改过的标准答案重判她这一轮的回答：判对了这道题算对、不进题库；判不对还是答的毛病。
    // 出处里两种说法都有的（two-answers，默认不开）才是撤掉、不算分
    let basis = exam;
    const pull = (answer?.faults ?? []).filter((f) => f.fault === "question" && (f.action === "withdraw" || f.action === "correct") && twice.some((t) => t.id === f.id));
    for (const f of d.abortWhy ? [] : pull) {
      const cur = this.t.bank.get(f.id);
      // 只动今晚这个专员的领导自己出的题（题库里的旧题不能动）；一道只动一次
      if (!cur || !run.pending.includes(f.id) || run.withdrawn.has(f.id) || run.corrected.has(f.id)) continue;
      const answers = twice.find((t) => t.id === f.id)?.answers ?? [];
      const refs = (f.evidence?.refs ?? []).map(String);
      const read = (ref: string) => { try { return this.t.rawSource?.({ day: d.day, stage: s, before: run.before, ref }) ?? null; } catch { return null; } };
      // 证据只认中央记忆的行和路径:行（照动手前的样子）；原话层的编号不当证据
      const texts = refs.map((ref) => { const r0 = read(ref); return r0 && r0.kind !== "quote" ? r0.text : null; });
      // 这道题自己的出处，读得出的都得核（原话层的也算）；读不出来的记下来
      const own = cur.sources.map((ref) => ({ ref: String(ref), text: read(String(ref))?.text ?? null }));
      const fresh = run.counts.new + run.counts.missed;
      const stageCap = Math.min(WITHDRAW_STAGE_CAP, Math.max(1, Math.floor(fresh / 5)));
      const nightCap = this.t.team.withdrawCap ?? WITHDRAW_NIGHT_CAP;
      const done0 = run.withdrawn.size + run.corrected.size;
      const probe = run.probes.get(f.id) ?? "keep";
      // 先看上限（一个专员：它的 new / missed 题的五分之一，最少 1、最多 WITHDRAW_STAGE_CAP；一夜：team.withdrawCap），再核证据
      let why = probe === "continuity" ? LP.WITHDRAW.continuity
        : done0 >= stageCap ? LP.WITHDRAW.capStage(stageCap) : this.withdrawnTonight >= nightCap ? LP.WITHDRAW.capNight(nightCap)
        : withdrawProblem({
          // 别的待定题的标准答案（改过的照改之前的算）
          gold: cur.gold, stem: cur.q, otherGolds: run.pending.filter((id) => id !== f.id).flatMap((id) => { const o = this.t.bank.get(id); return o ? [run.corrected.get(id)?.gold ?? o.gold] : []; }),
          answers, sources: cur.sources, evidence: f.evidence, texts, own: own.map((o) => o.text), probe,
          ...(failedNow.get(f.id)?.before !== undefined ? { before: failedNow.get(f.id)!.before! } : {}), twoAnswers: this.t.team.withdrawTwoAnswers === true,
        });
      const e = f.evidence;
      const excerpts = texts.map((t) => ((t ?? "").length > EXCERPT_CHARS ? `${(t ?? "").slice(0, EXCERPT_CHARS)}…` : t ?? ""));
      if (!why && e?.kind === "gold-wrong") {
        // 改标准答案：把那个错的词换成对的（照领导写的原样换；标准答案里原样找不到那个词的不动）
        const wrong = e.wrongToken!.trim(), right = e.rightToken!.trim();
        const newGold = cur.gold.includes(wrong) ? cur.gold.replaceAll(wrong, right) : null;
        if (newGold === null) why = LP.WITHDRAW.wrongNotInGold;
        else {
          const latest = answers.at(-1) ?? "";
          const marks = exam.regrade ? await exam.regrade([{ q: { ...cur, gold: newGold }, answer: latest }]) : null;
          const v = marks?.get(f.id)?.verdict;
          if (!marks) why = LP.WITHDRAW.noGrader;
          else if (v !== "right") why = LP.WITHDRAW.stillWrong(newGold);
          else {
            const rec = { q: cur.q, gold: cur.gold, newGold, answers, tokens: [wrong, right], refs, excerpts, unreadable: own.filter((o) => o.text === null).map((o) => o.ref), why: f.why.trim() };
            run.corrected.set(f.id, rec);
            this.withdrawnTonight += 1;
            // 后面几轮要是再考到它，照改过的标准答案考（它反正不进题库）
            this.t.bank.reviseGold(f.id, newGold);
            const q2 = this.t.bank.get(f.id);
            run.lastFailed.delete(f.id);
            run.marks.set(f.id, "right");
            if (q2) run.passed.set(f.id, q2);
            d.notes.push(LP.CORRECTED(rec));
            h.log.info("sleep: a question's gold corrected by the lead and re-marked right", { day: d.day, stage: s.id, question: f.id });
            continue;
          }
        }
      }
      if (why) { d.notes.push(LP.WITHDRAW.refused(cur.q, why)); run.refused.push({ id: f.id, q: cur.q, why }); continue; }
      const rec = { q: cur.q, gold: cur.gold, answers, kind: e!.kind, tokens: [e!.answerA!.trim(), e!.answerB!.trim()], refs, excerpts, why: f.why.trim() };
      run.withdrawn.set(f.id, rec);
      this.withdrawnTonight += 1;
      run.lastFailed.delete(f.id);
      run.passed.delete(f.id);
      run.marks.delete(f.id);
      d.notes.push(LP.WITHDRAWN(rec));
      h.log.info("sleep: a question withdrawn by the lead", { day: d.day, stage: s.id, question: f.id, kind: e!.kind });
    }
    if ((run.withdrawn.size || run.corrected.size) && exam.examined) {
      // 改对了的算对、撤掉的不算：keep 的没过照旧算；new / missed 的照现在的判定重算得分率（够线了，因为不到线才列的那些就不算没过）
      const gone = (id: string): boolean => run.withdrawn.has(id) || (run.corrected.has(id) && run.marks.get(id) === "right");
      const left = exam.failed.filter((f) => !gone(f.id));
      const fresh = [...run.marks].filter(([id]) => run.probes.get(id) === "new" || run.probes.get(id) === "missed").map(([, v]) => SCORE[v]);
      const rate = fresh.length ? fresh.reduce((a, b) => a + b, 0) / fresh.length : null;
      const ok = rate === null || rate >= this.t.team.tolerance;
      const failed = left.filter((f) => f.probe === "keep" || f.probe === "continuity" || !ok);
      basis = { ...exam, failed, pass: failed.length === 0 };
      run.lastExam = basis;
    }
    let judged = basis;
    // 领导判是题的毛病、给了新的标准答案：换上，那几道单独再考一场；过了就不为它们把专员发回去
    const revise = (answer?.faults ?? []).filter((f) => f.fault === "question" && f.action !== "withdraw" && f.action !== "correct" && f.gold?.trim() && twice.some((t) => t.id === f.id) && !run.withdrawn.has(f.id) && !run.corrected.has(f.id));
    if (revise.length && !d.abortWhy) {
      const again: Question[] = [];
      for (const f of revise) {
        const cur = this.t.bank.get(f.id);
        // 只改今晚待定的题（题库里的旧题不动）；一道只改一次；新的标准答案得是把原来的收窄、不能是她答的那句
        if (!cur || cur.status !== "pending" || run.revised.has(f.id)) continue;
        const why = goldRevisionProblem(cur.gold, f.gold!);
        if (why) { d.notes.push(LP.REVISION.refused(cur.q, why)); continue; }
        if (!this.t.bank.reviseGold(f.id, f.gold!.trim())) continue;
        const q = this.t.bank.get(f.id);
        if (!q) continue;
        const rev = { q: q.q, from: cur.gold, to: q.gold, answers: twice.find((t) => t.id === f.id)?.answers ?? [], why: f.why.trim() };
        run.revised.set(f.id, rev);
        again.push(q);
        run.lastFailed.delete(f.id);
        d.notes.push(LP.QUESTION_REVISED(rev));
      }
      if (again.length) {
        const ids = new Set(again.map((q) => q.id));
        const others = [...run.marks].filter(([id]) => !ids.has(id) && (run.probes.get(id) === "new" || run.probes.get(id) === "missed")).map(([, v]) => SCORE[v]);
        const re = await this.t.exam({ day: d.day, stage: s, attempt: run.n1, round: x.round, tag: "requiz", questions: again, probes: run.probes, before: run.before, after: run.after, storeBefore: this.storeBefore(d, s), ...(others.length ? { carried: others } : {}) });
        d.notes.push(...re.notes.map((t) => S.marks.labeled(s.title, t)));
        if (re.close) run.graders.push(re.close);
        if (re.examined) {
          for (const [id, a0] of Object.entries(re.answers ?? {})) run.answers.set(id, a0);
          for (const [id, v] of Object.entries(re.marks ?? {})) run.marks.set(id, v);
          for (const q of again) { if (re.failed.some((f) => f.id === q.id)) run.passed.delete(q.id); else run.passed.set(q.id, q); }
          // 别的没过的题：keep 的照旧算没过；new / missed 的是因为得分率不到线才列的，重考以后得分率够了就不算了
          const rest = basis.failed.filter((f) => !ids.has(f.id) && (f.probe === "keep" || !re.pass));
          const failed = [...rest, ...re.failed];
          judged = { ...basis, failed, pass: failed.length === 0 && re.pass };
          run.lastExam = judged;
        }
      }
    }
    if (answer) run.leadNotes = answer.notes.map((t) => t.trim()).filter(Boolean);
    // 改的那几轮新加的题只能拉低得分率、不能拉高：第 1 轮出的 new / missed 题单算也得到线
    if (judged.examined && x.round > 1) {
      const one = [...run.roundOne].filter((id) => !run.withdrawn.has(id) && run.marks.has(id));
      const rate1 = one.length ? one.reduce((a0, id) => a0 + SCORE[run.marks.get(id)!], 0) / one.length : null;
      if (rate1 !== null && rate1 < this.t.team.tolerance) {
        const why = LP.CONSIST.belowRoundOne(rate1, this.t.team.tolerance);
        const have = new Set(judged.failed.map((f) => f.id));
        const more = one.filter((id) => run.marks.get(id) !== "right" && !have.has(id)).flatMap((id) => {
          const q = this.t.bank.get(id);
          return q ? [{ id, probe: run.probes.get(id) ?? "new", q: q.q, gold: q.gold, after: run.answers.get(id) ?? "", why }] : [];
        });
        judged = { ...judged, failed: [...judged.failed, ...more], pass: false, notes: more.length ? judged.notes : [...judged.notes, why] };
        run.lastExam = judged;
      }
    }
    const r = leadRuled({ title: s.title, exam: judged, answer });
    d.notes.push(...r.notes.filter((t) => !d.notes.includes(t)));
    if (d.abortWhy) return { ...base, ok: false, problems: [S.teamrun.aborted(d.abortWhy)], by: r.by };
    // 没过：交给专员的除了没过的题、领导定的，还有领导看改动时就记下的要改的地方
    const intent = (review?.intent ?? []).filter((i) => i.fix.trim()).map((i) => S.marks.labeled(i.target, i.fix.trim()));
    const problems = r.pass ? [] : [...(r.problems.length ? r.problems : [S.teamrun.leadFailed]), ...intent.filter((t) => !r.problems.includes(t))];
    return { ...base, exam: judged, ok: r.pass, problems, by: r.by, fixes: this.fixesFor(judged, r.fixes ?? [], intent) };
  }

  /**
   * 发回给专员的：没过的题只给问题、差在哪、它整理后答成什么、题的出处——不给标准答案那句话（它得回到出处去看缺了什么，
   * 不是把答案抄进去）；再加领导写的要改的地方
   */
  private fixesFor(exam: ConsistencyResult, leadFixes: string[], intent: string[]): string[] {
    const failed = exam.failed.map((f) => {
      const src = this.t.bank.get(f.id)?.sources ?? [];
      return S.teamrun.failedQuestion(f.q, f.why, f.after || S.marks.noAnswer, src.length ? src.join(S.marks.listSep) : S.teamrun.noSources);
    });
    return [...failed, ...leadFixes, ...intent.filter((t) => !leadFixes.includes(t))];
  }

  /**
   * 固定要问的题那一场：回放里先把落地时拼的东西在回放的工作区里拼出来（真的夜里她醒来看到的就是那样），再照那个样子考。
   * 每道题的要点得答对，错了发回这个专员改；细节只记对了几条。拼不出来、没考成：不算过，也不发回去改
   */
  private async continuity(d: Day, s: StageSpec, run: Run, round: number, out: RoundOut): Promise<RoundOut> {
    const h = this.host;
    const bad = (problem: string): RoundOut => ({ ...out, ok: false, by: "rule", problems: [problem], gate: false });
    let built = false;
    if (this.t.finishBuild) {
      let why: string | null;
      try { why = await this.t.finishBuild(d.day); } catch (e) { if (e instanceof FinishTouched) throw e; why = msg(e).slice(0, 200); }
      if (why) { h.log.warn("sleep: the replay's finish-side build failed, continuity not examined", { day: d.day, why }); return bad(LP.CONT.buildFailed(why)); }
      built = true;
      run.rebuilt = true;
      run.rebuiltSince = true;
    }
    if (d.abortWhy) return { ...out, ok: false, problems: [S.teamrun.aborted(d.abortWhy)] };
    const qs = [...run.cont].flatMap(([id, c]): ContinuityQuestion[] => { const q = this.t.bank.get(id); return q ? [{ ...q, must: c.must, extras: c.extras }] : []; });
    let r: ContinuityResult;
    try {
      const view = await this.t.wake({ day: d.day, built });
      r = await this.t.continuity({ day: d.day, stage: s, attempt: run.n1, round, questions: qs, opening: view.opening, injection: view.injection });
    } catch (e) { return bad(LP.CONT.notExamined(msg(e).slice(0, 200))); }
    if (d.abortWhy) return { ...out, ok: false, problems: [S.teamrun.aborted(d.abortWhy)] };
    if (!r.examined) return bad(LP.CONT.notExamined(r.notes.at(-1) ?? S.final.noReason));
    run.contRatio = LP.CONT.ratio(r.must, r.extras);
    if (r.pass) { run.contFailed.clear(); return out; }
    // 同一道固定的题连着两轮要点没答对：先问领导是题的毛病还是答的毛病；题的毛病就换要点、那几道单独再考
    const twice = r.failed.filter((f) => run.contFailed.has(f.id)).map((f) => ({ id: f.id, q: f.q, gold: f.must, answers: [run.contFailed.get(f.id) ?? "", f.answer] }));
    run.contFailed = new Map(r.failed.map((f) => [f.id, f.answer]));
    if (twice.length) {
      const asExam: ConsistencyResult = { examined: true, pass: false, notes: [], scoreAfter: null, scoreBefore: null, failed: r.failed.map((f) => ({ id: f.id, probe: "continuity", q: f.q, gold: f.must, after: f.answer, why: LP.CONSIST.continuity })) };
      const answer = await this.leadOf(d.day, s).verdict({ day: d.day, stage: s, round, exam: asExam, intent: [], twice });
      for (const f of (answer?.faults ?? []).filter((y) => (y.action === "withdraw" || y.action === "correct") && twice.some((t) => t.id === y.id))) d.notes.push(LP.WITHDRAW.refused(this.t.bank.get(f.id)?.q ?? f.id, LP.WITHDRAW.continuity));
      const revise = (answer?.faults ?? []).filter((f) => f.fault === "question" && f.action !== "withdraw" && f.action !== "correct" && f.gold?.trim() && twice.some((t) => t.id === f.id));
      const again: ContinuityQuestion[] = [];
      for (const f of revise) {
        const c = run.cont.get(f.id);
        const cur = this.t.bank.get(f.id);
        if (!c || !cur || cur.status !== "pending" || run.revised.has(f.id)) continue;
        const bad2 = goldRevisionProblem(c.must, f.gold!);
        if (bad2) { d.notes.push(LP.REVISION.refused(cur.q, bad2)); continue; }
        if (!this.t.bank.reviseGold(f.id, f.gold!.trim())) continue;
        const rev = { q: cur.q, from: c.must, to: f.gold!.trim(), answers: twice.find((t) => t.id === f.id)?.answers ?? [], why: f.why.trim() };
        run.revised.set(f.id, rev);
        c.must = f.gold!.trim();
        const q = this.t.bank.get(f.id);
        if (!q) continue;
        again.push({ ...q, must: c.must, extras: c.extras });
        run.contFailed.delete(f.id);
        d.notes.push(LP.QUESTION_REVISED(rev));
      }
      if (again.length && !d.abortWhy) {
        try {
          const view = await this.t.wake({ day: d.day, built });
          const re = await this.t.continuity({ day: d.day, stage: s, attempt: run.n1, round, tag: "requiz", questions: again, opening: view.opening, injection: view.injection });
          if (re.examined) {
            const ids = new Set(again.map((q) => q.id));
            r = { ...r, failed: [...r.failed.filter((f) => !ids.has(f.id)), ...re.failed] };
            r.pass = r.failed.length === 0;
            r.must = { right: qs.length - r.failed.length, total: qs.length };
            run.contRatio = LP.CONT.ratio(r.must, r.extras);
            if (r.pass) return out;
          }
        } catch (e) { h.log.warn("sleep: re-sitting the revised continuity question failed", { day: d.day, error: msg(e).slice(0, 200) }); }
      }
    }
    const fixes = r.failed.map((f) => LP.CONT.mustWrong(f.q, f.answer, this.t.bank.get(f.id)?.sources ?? []));
    return { ...out, ok: false, by: "rule", gate: true, problems: [run.contRatio, ...fixes], fixes };
  }

  /**
   * 这一轮要考的题：领导这一轮出的存进题库（待定，落地时生效）；固定要问的题（问法对得上的）定成常驻、continuity；
   * 第 1 轮引擎再加挂在它改过的东西上的旧题（keep，上限 team.old）；之后的轮：上一轮没过的、这一轮新出的、
   * 这一轮碰到的已经过了的题。probe 题库里没有这一列，连同题号写到 flow/lead/<段>.json
   */
  private questions(d: Day, s: StageSpec, run: Run, round: number, touched: { files: string[]; events: string[] }, review: LeadReview | null, fixed: string[], retry: string[], viewChanged = true): { questions: Question[]; notes: string[] } {
    const bank = this.t.bank;
    const notes: string[] = [];
    // 固定要问的题（问法对得上的）：常驻、continuity；别的题标了 continuity 的照 new 算
    // 固定的题存进题库时标准答案就是它的要点（must；领导没写就拿它写的标准答案当要点）
    const mine = (review?.questions ?? []).map((q): LeadQuestion => (fixed.some((f) => same(f, q.q))
      ? { ...q, probe: "continuity", layer: "resident", isNew: true, must: q.must?.trim() || q.gold, gold: q.must?.trim() || q.gold }
      : q.probe === "continuity" ? { ...q, probe: "new" } : q));
    for (const f of fixed) if (!mine.some((q) => same(f, q.q))) { notes.push(S.teamrun.fixedNotSet(f)); run.contMissing.push(f); }
    const ids = mine.length ? bank.addPending(d.day, s.id, mine.map(({ probe: _probe, must: _must, extras: _extras, ...q }) => q)) : [];
    ids.forEach((id, i) => { const q = mine[i]!; if (q.probe === "continuity") run.cont.set(id, { must: q.must ?? q.gold, extras: (q.extras ?? []).map((e) => e.trim()).filter(Boolean) }); });
    ids.forEach((id, i) => { run.probes.set(id, mine[i]!.probe); run.counts[mine[i]!.probe] += 1; if (round === 1 && (mine[i]!.probe === "new" || mine[i]!.probe === "missed")) run.roundOne.add(id); });
    run.pending.push(...ids);
    run.fixedIds.push(...ids.filter((id) => run.probes.get(id) === "continuity"));
    const own = ids.flatMap((id) => { const q = bank.get(id); return q ? [q] : []; });
    let more: Question[];
    if (round === 1) {
      const cap = this.t.team.old ?? TEAM_OLD_DEFAULT;
      more = cap > 0 ? bank.touching(touched, cap).filter((q) => q.layer !== "archive" && !run.probes.has(q.id)) : [];
      for (const q of more) { run.probes.set(q.id, "keep"); run.counts.keep += 1; }
    } else {
      // 上一轮没过的接着考；已经过了的只有这一轮碰到它挂着的东西才再考
      const again = retry.flatMap((id) => { const q = bank.get(id); return q ? [q] : []; });
      // 常驻那层的题不查任何东西，只看开头和注入：这一轮没动那些，上一次的判定照旧，不再开一场（也不放进能查的那一场——那就不是常驻了）
      const hit = [...run.passed.values()].filter((q) => touchesTags(q, touched) && (q.layer !== "resident" || viewChanged));
      more = [...again, ...hit].filter((q, i, all) => all.findIndex((y) => y.id === q.id) === i && !ids.includes(q.id));
      // 这一轮改了东西却一道题都轮不到（没有没过的、领导没出新的、改的地方没挂着过了的题）：过了的题整份再考一遍，不能算没考
      if (!own.length && !more.length) {
        const all = [...run.passed.values()];
        const light = all.filter((q) => q.layer !== "resident" || viewChanged);
        more = light.length ? light : all;
      }
    }
    // 固定要问的题不进它自己的卷子：等它自己的题过了单独考一场（照今晚都整理完她醒来的样子）
    const questions = [...own.filter((q) => run.probes.get(q.id) !== "continuity"), ...more];
    this.host.fs.write(`sleep/${d.day}/flow/lead/${s.id}.json`, JSON.stringify({
      attempt: run.n1, round, answered: review !== null, intent: review?.intent ?? [], counts: run.counts,
      questions: own.map((q) => ({ id: q.id, probe: run.probes.get(q.id), layer: q.layer, q: q.q })),
      ...(round === 1 ? { old: more.map((q) => q.id) } : { again: more.map((q) => q.id) }),
    }, null, 2));
    return { questions, notes };
  }

  /** 这一轮的记账那一行：这一轮自己花的（做的是会话到现在的合计减掉前面几轮记过的；领导、考试照这一轮算） */
  private endRow(d: Day, s: StageSpec, run: Run, row: number, n: number, x: RoundOut & { status: "passed" | "redo" | "deferred" | "failed"; decision: string; final?: StageUsage | null }): void {
    const h = this.host;
    const total = x.final ?? (run.held && !("error" in run.held) ? run.held.usage() : null);
    const use = total ? minusUse(total, run.billed) : null;
    if (total) run.billed = { ...total };
    const u = use ? units(use, s.model, this.weights) : 0;
    this.o.budget.add(u);
    this.spent += u;
    d.spent.set(s.id, (d.spent.get(s.id) ?? 0) + u);
    // 考试的会话都记在第 1 次头上（exam-<日>-<段>-<第 1 次>-…）：这一轮的 = 到现在的减掉前面几轮的
    const examAll = this.costOf(`${d.day}/${s.id}/${run.n1}`).exam;
    const cost: RoleCost = { do: u, lead: this.leadCost.get(`${d.day}/${s.id}/${n}`) ?? 0, exam: examAll - run.examBilled };
    run.examBilled = examAll;
    L.endStage(h.db, row, {
      status: x.status,
      ...(use ? { calls: use.calls, maxCtx: total!.maxCtx, cacheRead: use.cacheRead, cacheWrite: use.cacheWrite, input: use.input, output: use.output } : {}),
      units: u, changes: run.done?.changes.length ?? 0,
      verdict: `${x.ok ? (run.contRatio ? S.teamrun.passedWith(run.contRatio) : S.teamrun.passed) : x.problems.join(S.marks.clauseSep)}${run.rowOnRebuilt ? S.teamrun.rebuiltNote(S.leadprompts.roundOnRebuilt) : ""}`.slice(0, 1000),
      error: (x.error ?? "").slice(0, 200),
      decision: x.decision,
      cost: JSON.stringify(cost),
    }, h.now());
    if (x.exam) {
      try {
        L.setStageExam(h.db, { day: d.day, stage: s.id, attempt: n, questions: x.asked, scoreBefore: x.exam.scoreBefore, scoreAfter: x.exam.scoreAfter,
          regressions: x.exam.failed.filter((f) => f.probe === "keep").length, hiddenScore: null, examined: x.exam.examined ? 1 : 0 });
      } catch (e) { h.log.warn("sleep: writing the specialist's exam scores failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    }
  }

  /** 这个专员定了：关会话；过了提交、记下今晚改过的文件；没过恢复文件、撤批、丢题（留一份改动给人看）。记账、告诉 host 这一次结束了 */
  private async settle(d: Day, s: StageSpec, run: Run, row: number, n: number, x: RoundOut): Promise<void> {
    const h = this.host;
    const held = run.held && !("error" in run.held) ? run.held : null;
    let final: StageUsage | null = null;
    if (held) { try { final = await held.close(); } catch { final = held.usage(); } }
    const done = run.done;
    // 固定要问的题只管今晚：考完就丢（落地时不生效，不然明晚成了答案过期的旧题）
    this.t.bank.dropQuestions(run.fixedIds);
    // 领导改过标准答案的题：不进题库（改过的答案没再对过出处），记在这一段的记录里（回放的 compare.md 列出来）
    if (run.revised.size || run.withdrawn.size || run.corrected.size || run.refused.length) {
      this.t.bank.dropQuestions([...run.revised.keys(), ...run.withdrawn.keys(), ...run.corrected.keys()]);
      try {
        const path = `sleep/${d.day}/flow/lead/${s.id}.json`;
        const j = JSON.parse(h.fs.read(path) ?? "{}") as Record<string, unknown>;
        if (run.revised.size) j.revised = [...run.revised].map(([id, v]) => ({ id, ...v }));
        if (run.withdrawn.size) j.withdrawn = [...run.withdrawn].map(([id, v]) => ({ id, ...v }));
        if (run.corrected.size) j.corrected = [...run.corrected].map(([id, v]) => ({ id, ...v }));
        // 领导要改、要撤，引擎没动的（连理由）
        if (run.refused.length) j.refused = run.refused;
        h.fs.write(path, JSON.stringify(j, null, 2));
      } catch (e) { h.log.warn("sleep: recording the revised questions failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
    }
    let ok = x.ok && done !== null && !d.abortWhy;
    // 交差以后会话还开着：提交以前再看一眼提案，跟考的那一份不一样就不提交
    if (ok) {
      const late = diff(run.after, snapshot(d.root, () => true, h.fs));
      if (late.length) { ok = false; x = { ...x, ok: false, by: "rule", problems: [LP.CHANGED_AFTER_HANDIN(late.map((f) => f.path))] }; }
    }
    if (ok && done) {
      h.mem?.commitStage(run.region);
      d.passes.push({ stage: s.id, n: run.n1 });
      for (const f of diff(run.before, run.after)) {
        if (!d.tonight.before.has(f.path)) d.tonight.before.set(f.path, run.before.get(f.path)?.text ?? h.fs.read(f.path));
        d.tonight.after.set(f.path, run.after.get(f.path)?.text ?? null);
      }
      d.fates.set(s.id, { kind: "passed", done });
      if (run.contRatio) d.notes.push(run.contRatio);
      // 以前欠着的那几天今晚补上了：划掉（没过的留着，下一晚再补）
      // 只划它交差时说了补上的那几天（report、changes 里原样写了日期的）；没提的留着
      const said = `${done.report}\n${JSON.stringify(done.changes)}`;
      for (const day of run.owed.filter((x0) => said.includes(x0))) { try { L.settleOwed(h.db, day, s.id, "done", h.now()); } catch (e) { h.log.warn("sleep: settling an owed day failed", { day, stage: s.id, error: msg(e).slice(0, 200) }); } }
    } else {
      if (!d.abortWhy) this.keepDeferred(d, s, run.before, run.after);
      // 专员一个个做：整个 proposed/ 恢复成它动手前的样子（前面专员的改动在那份快照里，不会动）
      restore(d.root, run.before, () => true, h.fs);
      if (run.begun) this.noteConflicts(d, S.teamrun.withdrawBatch(s.title), h.mem?.revertStage(run.region) ?? null);
      const dropped = this.t.bank.dropQuestions(run.pending);
      if (d.abortWhy) d.fates.set(s.id, { kind: "aborted", why: d.abortWhy });
      else {
        d.fates.set(s.id, { kind: "deferred", problems: x.problems, done });
        d.notes.push(S.teamrun.notLanded(s.title, x.problems.slice(0, 5).join(S.marks.clauseSep)));
        h.log.warn("sleep: specialist dropped", { day: d.day, stage: s.id, problems: x.problems.slice(0, 5), questions: dropped });
        if (s.required) this.abortDay(d, S.teamrun.dropped(s.title));
      }
    }
    // 记下这个专员定了什么：改了哪些文件、事件库里碰了哪些（带标题）、领导留的话（没过的是为什么）——下一个专员的领导开头带
    if (!d.abortWhy) {
      let ids: string[] = [];
      try { ids = ok ? h.idTitles?.(h.touchedIn?.(d.day, s.id, run.n1, 0) ?? []) ?? [] : []; } catch (e) { h.log.warn("sleep: reading the settled specialist's ids failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
      const list = this.settledOf.get(d.day) ?? [];
      list.push({ title: s.title, passed: ok, targets: ok ? [...diff(run.before, run.after).map((f) => f.path).sort(), ...ids] : [], notes: ok ? run.leadNotes : x.problems.slice(0, 3) });
      this.settledOf.set(d.day, list);
    }
    this.endRow(d, s, run, row, n, { ...x, ok, status: ok ? "passed" : d.fates.get(s.id)?.kind === "aborted" ? "failed" : "deferred", decision: `${x.by}:${ok ? "pass" : "drop"}`, final });
    try { h.attemptEnded?.(d.day, s.id, ok, run.n1); } catch (e) { h.log.warn("sleep: host cleanup after the specialist failed", { day: d.day, stage: s.id, error: msg(e).slice(0, 200) }); }
  }

  /**
   * 开一个留着的专员会话：work(text) 叫醒它、等它交 stage_done（不当场退回：对账看出来的交给领导当提示），可以叫好几轮。
   * 每一轮各有自己的时限（段的 budget.minutes）和调用次数（budget.calls，从这一轮开始数）：一轮结束没交、这一轮出错，催一次；
   * 快到上限催它收尾一次；超了上限还没交、再没交、到点了都算这一轮没交（到点的把会话关掉）。会话结束（关了、中止、超时）以后再叫就是没交
   */
  private hold(d: Day, s: StageSpec, id: string): Held | { error: string } {
    let sess: OpenedStage;
    try { sess = this.host.open({ id, stage: s, day: d.day, allowed: new Set([...s.tools, "stage_done"]) }); } catch (e) {
      return { error: S.teamrun.sessionFailed(msg(e)) };
    }
    d.sessions.add(sess);
    let cum: StageUsage = zeroUse();
    let gone: string | null = null;
    let finalUse: StageUsage | null = null;
    /** 正在等的那一轮 */
    let open: { got: StageDone | null; nudged: boolean; warned: boolean; base: number; check: ((done: StageDone) => string | null) | null; finish(why: string | null): void } | null = null;
    sess.onDone((x) => {
      if (!open) return S.teamrun.notYet;
      // 当场退回（一轮一次）：这次不算交，改完再交
      if (!open.got && open.check) {
        const check = open.check;
        open.check = null;
        let why: string | null = null;
        try { why = check(x); } catch (e) { this.host.log.warn("sleep: the hand-in check threw, taking the hand-in", { id, error: msg(e).slice(0, 200) }); }
        if (why) return why;
      }
      open.got ??= x;
      return S.teamrun.handedIn;
    });
    sess.onTurnEnd((ok, err, use) => {
      if (use) cum = { ...use };
      const o = open;
      if (!o) return;
      if (o.got) return o.finish(null);
      const cap = s.budget.calls;
      const calls = cum.calls - o.base;
      if (calls > cap) return o.finish(S.teamrun.callCap(cap));
      if (!o.warned && calls >= Math.ceil(0.8 * cap)) {
        o.warned = true;
        try { sess.wake(P.SLEEP_STAGE_NEAR_BUDGET(calls, cap)); } catch (e) { o.finish(S.teamrun.cannotWake(msg(e))); }
        return;
      }
      if (o.nudged) return o.finish(ok ? S.teamrun.nudgedNoStageDone : S.teamrun.roundFailed(err ?? S.final.noReason));
      o.nudged = true;
      try { sess.wake(P.SLEEP_STAGE_CONTINUE); } catch (e) { o.finish(S.teamrun.cannotWake(msg(e))); }
    });
    sess.settled.then(
      (r) => { finalUse = r.usage; cum = { ...r.usage }; gone ??= d.abortWhy ? S.teamrun.aborted(d.abortWhy) : S.teamrun.sessionEnded(r.how); d.sessions.delete(sess); open?.finish(gone); },
      (e: unknown) => { gone ??= S.teamrun.sessionError(msg(e)); d.sessions.delete(sess); open?.finish(gone); },
    );
    return {
      alive: () => gone === null && (sess.alive?.() ?? true),
      usage: () => ({ ...cum }),
      work: (text, check) => new Promise((resolve) => {
        if (gone !== null) { resolve({ done: null, error: gone }); return; }
        let cancel = (): void => {};
        const round = {
          got: null as StageDone | null, nudged: false, warned: false, base: cum.calls, check: check ?? null,
          finish: (why: string | null): void => {
            if (open !== round) return;
            open = null;
            cancel();
            resolve({ done: round.got, error: round.got ? null : why ?? S.teamrun.noStageDone });
          },
        };
        open = round;
        // 这一轮的时限：到点还没交就关掉会话（它卡住了），这一轮算没交
        cancel = this.host.later(() => {
          if (open !== round) return;
          gone ??= S.teamrun.timedOut(s.budget.minutes);
          round.finish(gone);
          Promise.resolve().then(() => sess.close()).catch(() => {});
        }, s.budget.minutes * 60_000);
        // 改的那一轮：重新算没交差（learn_check 那边）
        try { sess.bounced?.({ questionsFor: [] }); } catch { /* host 不管这个 */ }
        try { sess.wake(text); } catch (e) { round.finish(S.teamrun.cannotWake(msg(e))); }
      }),
      close: async () => {
        gone ??= S.teamrun.closed;
        try { await sess.close(); } catch { /* 关不掉也算了 */ }
        try { await sess.settled; } catch { /* 上面记过了 */ }
        d.sessions.delete(sess);
        return finalUse ?? { ...cum };
      },
    };
  }
}

/** 留着的专员会话 */
interface Held {
  alive(): boolean;
  /** 会话到现在的合计用量 */
  usage(): StageUsage;
  /** check：交差时当场看一眼（有话说就退回去，这一轮只退一次） */
  work(text: string, check?: (done: StageDone) => string | null): Promise<{ done: StageDone | null; error: string | null }>;
  /** 关会话，给最后的合计用量 */
  close(): Promise<StageUsage>;
}
/** 一个专员这一夜的账：第 1 次的编号（会话、批、记录都用它）、动手前和现在的样子、会话、题 */
interface Run {
  n1: number; region: string; before: Snapshot; after: Snapshot; begun: boolean; held: Held | { error: string } | null;
  /** 前面几轮记过账的用量、考试花费 */
  billed: StageUsage; examBilled: number;
  /** 到现在交的（几轮的改动、报告合起来） */
  done: StageDone | null;
  /** 这一夜存进题库的待定题、其中固定要问的 */
  pending: string[]; fixedIds: string[];
  probes: Map<string, LeadQuestion["probe"]>;
  /** 考过了的题（下一轮不再考，除非那一轮碰到它挂着的东西） */
  passed: Map<string, Question>;
  counts: Record<LeadQuestion["probe"], number>;
  /** 上一轮结束时这一批记了几行（下一轮给领导只列后面的） */
  ops: number;
  /** 以前几天这一段欠着的日子（今晚先补；过了、交差时说了补哪天的才划掉） */
  owed: string[];
  /** 上一轮的考试结果（改的那一轮什么都没改时照它）；考过的每道题最近一次的判定 */
  lastExam: ConsistencyResult | null;
  marks: Map<string, Verdict>;
  /** 固定要问的题（题号 → 要点、细节）；最近一场的要点、细节各对了几（记账、报告里写一句） */
  cont: Map<string, { must: string; extras: string[] }>;
  contRatio: string | null;
  /** 上一轮没过的题（题号 → 那一轮答的）；固定要问的题上一轮没答对要点的 */
  lastFailed: Map<string, string>;
  contFailed: Map<string, string>;
  /** 领导改过标准答案的题（一道只改一次；改过的不进题库） */
  revised: Map<string, { q: string; from: string; to: string; answers: string[]; why: string }>;
  /** 配置里固定要问、领导没交上来的题 */
  contMissing: string[];
  /** 回放里落地那几步拼过工作区了；手上这一行（这一轮）是不是在拼过的工作区上做的 */
  rebuilt: boolean;
  rowOnRebuilt: boolean;
  /** 上一场考试以后又拼过一次（下一轮算常驻那层看到的变了） */
  rebuiltSince: boolean;
  /** 领导最近一次定夺时留的话（下一个专员的领导开头要带） */
  leadNotes: string[];
  /** 撤掉的题（一个专员最多 WITHDRAW_STAGE_CAP 道）：不算分、不进题库，记下人看得出撤得对不对的全部东西 */
  withdrawn: Map<string, { q: string; gold: string; answers: string[]; kind: string; tokens: string[]; refs: string[]; excerpts: string[]; why: string }>;
  /** 改了标准答案里一个错的词、判分的重判判对了的题：算对、不进题库 */
  corrected: Map<string, { q: string; gold: string; newGold: string; answers: string[]; tokens: string[]; refs: string[]; excerpts: string[]; unreadable: string[]; why: string }>;
  /** 领导要改、要撤，引擎没动的题和理由 */
  refused: Array<{ id: string; q: string; why: string }>;
  /** 第 1 轮出的 new / missed 题（后面几轮新加的题只能拉低得分率、不能拉高） */
  roundOne: Set<string>;
  /** 每道题最近一次答的 */
  answers: Map<string, string>;
  /** 考完了还开着的判分会话：这一轮定完要关 */
  graders: Array<() => Promise<void>>;
}
interface RoundOut {
  ok: boolean; problems: string[]; by: "lead" | "rule"; exam: ConsistencyResult | null; asked: number; error: string | null;
  /** 没过时发回给专员的（题、它答的、出处——不带标准答案那句话；领导写的要改的地方） */
  fixes?: string[];
  /** 固定要问的题那一场定的：true = 要点没答对（能发回去改）；false = 那一场没法考（不发回去改，直接不要） */
  gate?: boolean;
}
const zeroUse = (): StageUsage => ({ calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, maxCtx: 0 });
const minusUse = (a: StageUsage, b: StageUsage): StageUsage => ({
  calls: a.calls - b.calls, input: a.input - b.input, cacheRead: a.cacheRead - b.cacheRead, cacheWrite: a.cacheWrite - b.cacheWrite, output: a.output - b.output, maxCtx: a.maxCtx,
});

/**
 * 拼 team 的一夜（真的夜里和回放都从 sleep/night.ts 的 assembleNight 进来）：host、领导（一天一个）、前后一致的考试、TeamRunner。
 * 不接核依据、交叉审、前额叶、每段的考试、全天考试
 */
export function assembleTeamNight(b: NightBrain, plan: NightPlan, o: AssembleOpts): { hosts: NightHosts; runner: SleepRunner } {
  const team = plan.flow.team;
  if (plan.flow.engine !== "team" || !team) throw new Error(S.teamrun.needsTeam);
  const hosts = nightHosts(b, plan, {
    budget: o.budget, weights: o.weights, auditMs: o.auditMs, holdMs: o.watchdogMs,
    charge: (id, u) => runner.charge(id, u), passed: (day) => runner.passed(day),
  });
  const exam = hosts.exam;
  const leadHost = hosts.lead;
  if (!exam || !leadHost) throw new Error(S.teamrun.noHosts);
  const log = hosts.stage.log;
  // 领导的 skill 页（readNight 查过它在）：跟专员的页一样相对 flow.json 所在的目录
  const page = hosts.stage.skillText({ skill: team.lead.skill } as StageSpec) ?? "";
  const resolves = (day: string) => (ref: string): boolean => exam.sourceExists(ref, { day, state: "after" }) || exam.sourceExists(ref, { day, state: "before" });
  const runner: TeamRunner = new TeamRunner(hosts.stage, plan.flow, {
    validators: [], budget: o.budget, weights: o.weights, watchdogMs: o.watchdogMs, maxDays: o.maxDays,
    team, bank: hosts.bank,
    lead: (day, stage, digest) => new Lead(leadHost, {
      id: leadId(day, stage.id), model: team.lead.model, nightMs: o.watchdogMs, turnMs: team.lead.turnMinutes * 60_000,
      role: [LP.LEAD_ROLE(page), digest].filter(Boolean).join("\n\n"), later: hosts.stage.later, log,
      check: (q, at) => leadQuestionProblem(q, resolves(at.day), exam.isPrivate),
    }),
    exam: (x) => consistencyExam({ host: exam, bank: hosts.bank, flow: plan.flow, log }, x),
    ...(o.replay ? { replay: true } : {}),
    rawSource: ({ day, stage, before, ref }) => exam.rawSource(ref, { day, before, writes: stage.writes }),
    continuity: (x) => continuityExam({ host: exam, bank: hosts.bank, flow: plan.flow, log }, x),
    // 今晚都整理完她醒来看到的：开头是基础块（回放里拼过了照工作区现在的，不然有提案用提案里的）；注入是今晚提案里别的会注入的文件
    wake: async ({ day, built }) => {
      const fs = hosts.stage.fs;
      const root = `sleep/${day}/proposed`;
      const cfgExam = plan.flow.exam;
      const proposed = proposedFiles(root, fs);
      // 回放里落地那几步拼过了：工作区里合 exam.inject 的文件也算（落地时生成、没有哪个专员提议过的，比如快照）。
      // 照每条 inject 通配前面那段固定的目录去找（一上来就是通配的不找：那要翻整个工作区）
      const rebuilt = !built ? [] : cfgExam.inject.filter((g) => !g.startsWith("!")).flatMap((g) => {
        const segs = g.split("/");
        const wild = segs.findIndex((x) => x.includes("*"));
        if (wild === -1) return fs.read(g) !== null ? [g] : [];
        if (wild === 0) return [];
        const dir = segs.slice(0, wild).join("/");
        return proposedFiles(dir, fs).map((p) => `${dir}/${p}`);
      });
      const paths = [...new Set([...proposed, ...rebuilt])].filter((p) => injectedFile(cfgExam, p) && !cfgExam.baseBlocks.includes(p)).sort();
      const files = new Map(paths.map((p): [string, string | null] => [p, (built ? fs.read(p) : null) ?? fs.read(`${root}/${p}`)]));
      let injection = P.EXAM_NOTHING_INJECTED;
      if (files.size) { try { injection = await exam.preview({ day, stage: "continuity", state: "after", files }); } catch { injection = plainInjection(files); } }
      const mid = residentMemory(exam, cfgExam, { day, state: "after", store: "live" });
      return { opening: exam.wakeOpening(day, built), injection: withMemory(injection, mid.text) };
    },
    // 回放：落地那几步（flow.json 的 replayFinish）在回放的工作区里跑，把她醒来看到的拼出来；真的夜里不跑（落地在考完以后）
    ...(o.replay && plan.flow.replayFinish?.length ? { finishBuild: async (day: string): Promise<string | null> => {
      const root = `sleep/${day}/proposed`;
      for (const c of plan.flow.replayFinish ?? []) {
        // 落地命令只能往工作区里拼：动了提案目录，后面的判定就不是照专员交的那一份了——这次回放停下，说是哪条命令
        const was = snapshot(root, () => true, hosts.stage.fs);
        const r = await hosts.stage.run(replayArgs(c, { day, tz: b.cfg.schedule.timezone, nightSleep: b.cfg.schedule.nightSleep }), FINISH_BUILD_MS);
        const moved = diff(was, snapshot(root, () => true, hosts.stage.fs)).map((f) => f.path);
        if (moved.length) throw new FinishTouched(LP.FINISH_TOUCHED(c.join(" "), moved));
        if (r.code !== 0) return S.teamrun.finishFailed(c.join(" "), r.code, r.out.trim().slice(0, 200));
      }
      return null;
    } } : {}),
    // 从改动以外来的出处：原话（#N / c:N / q编号）要真有；事件库的编号不能是它这一次新建的；路径:行照它动手前的样子查（beforeContent）
    outside: ({ day, stage, before, made }) => (ref) => {
      const r = ref.trim();
      if (centralRef(r) !== null || /^q\d+$/.test(r)) return exam.sourceExists(r, { day, state: "after" });
      const head = r.split(/[\s「#]/)[0]!;
      if (/^[enti]\d+$/.test(head)) return !made.has(head) && exam.sourceExists(head, { day, state: "before" });
      // 路径:行：照动手前的样子读得出来才算（sleep/ 下面只认当天的材料——引擎抄的那份改动、提案目录是今晚的改动本身）
      return exam.rawSource(r, { day, before, writes: stage.writes }) !== null;
    },
  });
  return { hosts, runner };
}
