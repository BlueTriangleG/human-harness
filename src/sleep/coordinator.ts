// 前额叶（配了 coordinator 才有）：一夜一个会话，每一段的一次尝试验完，runner 把简报交给它，它定过、重做还是推迟。
// 它只看、只定（只能交 coordinate）；定的照硬规矩收（ruled）：有验证没过不能过、都过了不能推迟、重做要写为什么。
// 它没回（会话坏了、超时、催了还不交）：按规矩走，报告最上面写一句。
import { P, S } from "../lang/index.ts";
import type { FlowConfig, Personas } from "./flow.ts";
import { reviewValidator, type ReviewHost } from "./review.ts";
import type { StageSession } from "./session.ts";
import type { CoordinateIn } from "./tools.ts";
import type { StageValidator } from "./validate.ts";

export interface CoordHost {
  /** 只读、只能交 coordinate；timeoutMs 是这个会话最多活多久（一整夜） */
  open(o: { id: string; model: string; timeoutMs: number }): StageSession & { onCoordinate(fn: (c: CoordinateIn) => string): void };
}

/** runner 用的：给一份简报，等它定；null = 没回 */
export interface CoordinatorLike {
  decide(brief: string): Promise<CoordinateIn | null>;
  close(): Promise<void>;
}

export interface CoordinatorOpts {
  /** 会话 id：coord-<夜> */
  id: string; model: string;
  /** 会话最多活多久（一整夜，看门狗的时长）、一份简报最多等多久 */
  nightMs: number; turnMs: number;
  /** 第一份简报前面的说明（P.SLEEP_COORD_ROLE） */
  role: string;
  later(fn: () => void, ms: number): () => void;
  log: { warn(m: string, d?: Record<string, unknown>): void };
}

export type Decision = "pass" | "redo" | "defer";

/**
 * 硬规矩：failed = 有验证没过；left = 还能重做几轮；problems = 验证给的问题。
 * 没回（answer null）照机械的规矩：没过有轮数重做、没轮数推迟；过了就过
 */
export function ruled(o: { title: string; failed: boolean; left: number; problems: string[]; answer: CoordinateIn | null }): {
  decision: Decision; problems: string[]; notes: string[]; by: "coord" | "rule";
} {
  const { title, failed, left, answer } = o;
  const why = answer?.why.trim() ?? "";
  const notes = answer ? answer.notes.map((t) => t.trim()).filter(Boolean).map((t) => S.coordinator.note(title, t)) : [];
  if (!answer) return { decision: failed ? (left > 0 ? "redo" : "defer") : "pass", problems: o.problems, notes: [S.coordinator.silentFor(S.coordinator.silent, title)], by: "rule" };
  if (failed) {
    // 有验证没过：只能重做（还有轮数）或推迟；它说过算重做
    const extra = why ? [...o.problems, S.coordinator.said(why)] : o.problems;
    if (answer.decision === "defer") return { decision: "defer", problems: extra, notes, by: "coord" };
    if (answer.decision === "pass") notes.push(S.coordinator.wantedPass(title, left > 0 ? S.coordinator.redo : S.coordinator.defer));
    return { decision: left > 0 ? "redo" : "defer", problems: extra, notes, by: "coord" };
  }
  // 都过了：可以过，也可以重做（要写为什么、还有轮数）；不能推迟
  if (answer.decision === "redo") {
    if (!why) return { decision: "pass", problems: [], notes: [...notes, S.coordinator.redoNoWhy(title)], by: "coord" };
    if (left <= 0) return { decision: "pass", problems: [], notes: [...notes, S.coordinator.redoNoRounds(title, why)], by: "coord" };
    return { decision: "redo", problems: [S.coordinator.said(why)], notes, by: "coord" };
  }
  if (answer.decision === "defer") notes.push(S.coordinator.deferPassed(title));
  return { decision: "pass", problems: [], notes, by: "coord" };
}

/**
 * 一夜一个会话（id = coord-<夜>；坏了重开的接 -2、-3），简报一份一份排队问（并行的段不会抢）；
 * 一份等 turnMs 没回就关掉这个会话（它卡住了），下一份重开；最多开 3 个
 */
export class Coordinator implements CoordinatorLike {
  private sess: ReturnType<CoordHost["open"]> | null = null;
  private opened = 0;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** 正在等的那一份：收到 coordinate、会话结束、超时都调它 */
  private pending: ((c: CoordinateIn | null) => void) | null = null;
  /** 这一份收到的 coordinate：等这一轮结束才交回去（这一轮的花费先记到这一次头上，下一份也不会撞上还没结束的一轮） */
  private got: CoordinateIn | null = null;
  private nudged = false;

  private readonly host: CoordHost;
  private readonly o: CoordinatorOpts;

  constructor(host: CoordHost, o: CoordinatorOpts) {
    this.host = host;
    this.o = o;
  }

  decide(brief: string): Promise<CoordinateIn | null> {
    const run = this.chain.then(() => this.ask(brief));
    this.chain = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.answer(null);
    const s = this.sess;
    this.sess = null;
    if (s) await s.close().catch(() => {});
  }

  private answer(c: CoordinateIn | null): void {
    const p = this.pending;
    this.pending = null;
    p?.(c);
  }

  private openOne(): ReturnType<CoordHost["open"]> | null {
    if (this.opened >= 3) return null;
    this.opened += 1;
    const id = this.opened === 1 ? this.o.id : `${this.o.id}-${this.opened}`;
    let s: ReturnType<CoordHost["open"]>;
    try { s = this.host.open({ id, model: this.o.model, timeoutMs: this.o.nightMs }); } catch (e) {
      this.o.log.warn("sleep: coordinator session would not open", { id, error: String(e).slice(0, 200) });
      return null;
    }
    s.onCoordinate((c) => {
      if (this.sess !== s || !this.pending || this.got) return S.coordinator.alreadyDecided;
      this.got = c;
      return S.marks.received;
    });
    s.onTurnEnd((ok) => {
      if (this.sess !== s || !this.pending) return;
      if (this.got) return this.answer(this.got);
      if (!ok || this.nudged) return this.answer(null);
      this.nudged = true;
      try { s.wake(P.SLEEP_COORD_NUDGE); } catch { this.answer(null); }
    });
    const gone = (): void => { if (this.sess === s) { this.sess = null; this.answer(this.got); } };
    s.settled.then(gone, gone);
    return s;
  }

  private ask(brief: string): Promise<CoordinateIn | null> {
    if (this.closed) return Promise.resolve(null);
    let first = false;
    if (!this.sess) {
      this.sess = this.openOne();
      if (!this.sess) return Promise.resolve(null);
      first = true;
    }
    const s = this.sess;
    return new Promise<CoordinateIn | null>((resolve) => {
      this.nudged = false;
      this.got = null;
      let cancel = (): void => {};
      this.pending = (c) => { cancel(); resolve(c); };
      cancel = this.o.later(() => {
        if (this.sess !== s || !this.pending) return;
        this.o.log.warn("sleep: coordinator did not answer in time, closing its session", { id: s.id });
        this.sess = null;
        this.answer(this.got);
        s.close().catch(() => {});
      }, this.o.turnMs);
      try { s.wake(first ? `${this.o.role}\n\n${brief}` : brief); } catch { this.answer(null); }
    });
  }
}

/**
 * 多人模式要接上的几样（Brain 的夜里、回放都用这一个）：交叉审的验证器（排在核依据后面、考试前面）、给 runner 的 personas 和前额叶。
 * 没写 personasFile / coordinator 的夜全是空的，什么都不接
 */
export function teamParts(
  hosts: { review: ReviewHost | null; coord: CoordHost | null },
  plan: { flow: FlowConfig; personas?: Personas },
  o: { night: string; auditMs: number; nightMs: number; later(fn: () => void, ms: number): () => void; log: CoordinatorOpts["log"] },
): { review: StageValidator | null; runner: { personas?: Personas; coordinator?: CoordinatorLike } } {
  const { flow, personas } = plan;
  const review = hosts.review && personas ? reviewValidator(hosts.review, { model: flow.reviewModel ?? "sonnet", personas }) : null;
  const c = flow.coordinator;
  const coordinator = hosts.coord && c ? new Coordinator(hosts.coord, {
    id: `coord-${o.night}`, model: c.model, nightMs: o.nightMs, turnMs: o.auditMs,
    role: P.SLEEP_COORD_ROLE(c.persona ? personas?.[c.persona] ?? null : null, !!personas), later: o.later, log: o.log,
  }) : null;
  return { review, runner: { ...(personas ? { personas } : {}), ...(coordinator ? { coordinator } : {}) } };
}
