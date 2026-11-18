// 专员 + 领导模式的领导：一天一个会话（lead-<日>），每个专员交差以后问它两次——看改动出题（review）、看考试结果定过不过（verdict）。
// 它只看、只定；定的照硬规矩收（leadRuled）：前后一致的考试没过，它说过也不算。它没回（会话坏了、超时、催了还不交）：照考试的结果走。
import { P, S } from "../lang/index.ts";
import * as LP from "./leadprompts.ts";
import type { Logger } from "../log.ts";
import type { StageSpec } from "./flow.ts";
import type { LeadHost } from "./host.ts";
import type { SpecialistDiff } from "./opsdiff.ts";
import type { ConsistencyResult } from "./consistency.ts";
import { questionProblem } from "./exam.ts";

import type { LeadQuestion, LeadReview, LeadVerdict, StageDone, WithdrawEvidence } from "./tools.ts";
import { centralRef } from "./things.ts";

export type { LeadQuestion, LeadReview, LeadVerdict } from "./tools.ts";

/** runner 用的：null = 没回 */
export interface LeadLike {
  /** continuity：这一天固定要问的几道题（只在点名的那个专员那里给一次） */
  /** check：这个专员这一次另外要查的（出处是不是它自己这次写的，ownChangeProblem）；有毛病给理由 */
  review(b: { day: string; stage: StageSpec; round: number; done: StageDone; diff: SpecialistDiff; continuity?: string[]; check?: (q: LeadQuestion) => string | null; changesCap?: number;
    /** 这个专员这一次核标准答案用的出处原文（照它动手前的样子读；盖过 LeadOpts.excerpt） */
    excerpt?: (q: LeadQuestion) => { ref: string; text: string } | null }): Promise<LeadReview | null>;
  /** note：这一份前面要说的一句（比如这一轮什么都没改、考试是上一轮的） */
  verdict(b: { day: string; stage: StageSpec; round: number; exam: ConsistencyResult; intent: LeadReview["intent"]; note?: string; twice?: Array<{ id: string; q: string; gold: string; answers: string[]; sources?: Array<{ ref: string; text: string | null }> }> }): Promise<LeadVerdict | null>;
  close(): Promise<void>;
}

export interface LeadOpts {
  /** 会话 id：lead-<日>（坏了重开的接 -2、-3） */
  id: string; model: string;
  /** 会话最多活多久、一份最多等多久 */
  nightMs: number; turnMs: number;
  /** 第一条消息最前面的说明（LP.LEAD_ROLE(它的 skill 页)） */
  role: string;
  later(fn: () => void, ms: number): () => void;
  log: Pick<Logger, "warn">;
  /** 逐道查交上来的题（leadQuestionProblem）：有毛病给理由，不收。不给 = 都收 */
  check?: (q: LeadQuestion, at: { day: string; stage: string }) => string | null;
  /** 一个专员最多收几道题（默认 20） */
  maxQuestions?: number;
  /**
   * 一道题头一条读得出原文的出处和那段原文（开头几百字）；读不出来给 null。给了这个：带 new / missed / continuity 题的头一次交差不收，
   * 把每道题的标准答案和出处原文并排回给领导核，第二次交才收。不给 = 不核，一次就收
   */
  excerpt?: (q: LeadQuestion, at: { day: string; stage: string }) => { ref: string; text: string } | null;
}

export const LEAD_MAX_QUESTIONS = 20;

/**
 * 领导交的一道题有什么毛病（没毛病给 null）：probe、layer 要对（只在仓库那层领导不用）；别的照段交的题查（questionProblem）——
 * 出处里不能有私密的印象、至少一条出处查得到（标准答案不能只是照着专员交的改动抄的）、重要度、标签
 */
export function leadQuestionProblem(q: LeadQuestion, resolves: (ref: string) => boolean, isPrivate?: (ref: string) => boolean): string | null {
  if (q.probe !== "keep" && q.probe !== "new" && q.probe !== "missed" && q.probe !== "continuity") return LP.LEAD_REFUSED.probe;
  if (q.layer !== "resident" && q.layer !== "searchable") return LP.LEAD_REFUSED.layer;
  if (q.probe === "continuity" && !q.must?.trim()) return LP.LEAD_REFUSED.must;
  return questionProblem({ ...q, isNew: q.probe !== "keep" }, resolves, isPrivate);
}

/** 照分句的标点（中英文的逗号、句号、分号、叹号、问号、顿号，和换行）切成一句一句，去掉空白 */
const clauses = (t: string): string[] => t.split(/[，。；！？、,.;!?\n]/).map((c) => c.replace(/\s+/g, "")).filter(Boolean);

/**
 * 领导判「是题的毛病」时给的新标准答案收不收（收给 null，不收给理由）：只能是把原来的收窄——新的每一句都得是原来标准答案里
 * 完整的一句（照分句的标点切；一句里的一截不行：「他没有答应周五交」留「答应周五交」意思就反了），而且留下的比原来少；
 * 不能是空的、不能跟原来一样。空白不算。
 * 她没过的那两次回答里有没有这一句不管：原来的标准答案把几件事并成一句、她已经答出要紧的那一件，正是要收窄的时候——
 * 收窄掉的是不是真丢了的那一半，由人看报告里列的（原来的、改成的、她两次答的）判
 */
export function goldRevisionProblem(oldGold: string, newGold: string): string | null {
  const o = clauses(oldGold), n = clauses(newGold);
  if (!n.length || (n.length === o.length && n.every((c, i) => c === o[i]))) return LP.REVISION.same;
  const kept = new Set(n);
  if (!n.every((c) => o.includes(c)) || kept.size >= new Set(o).size) return LP.REVISION.notNarrower;
  return null;
}

/** 去掉空白、标点、引号（撤题的机械核对都照这个比） */
const plain = (t: string): string => t.replace(/[\s，。；！？、,.;!?：:「」『』“”"'‘’（）()《》〈〉<>—\-…·]/g, "");
const sameRef = (a: string, b: string): boolean => {
  const x = a.trim(), y = b.trim();
  if (x === y) return true;
  const cx = centralRef(x), cy = centralRef(y);
  return cx !== null && cx === cy;
};

const CN_DIGIT: Record<string, string> = { 〇: "0", 零: "0", 一: "1", 二: "2", 两: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };
/** 机械核对前两边都这样归一：全半角（NFKC）、大小写、空白和标点去掉、汉字数字换成阿拉伯数字 */
const norm = (t: string): string => plain(t.normalize("NFKC").toLowerCase()).replace(/[〇零一二两三四五六七八九]/g, (c) => CN_DIGIT[c] ?? c);

/**
 * 领导说一道连着两轮没过的题「标准答案有毛病」，认不认（认给 null，不认给理由）。全是机械的，两边都归一了再比（norm）。
 * 共同的：证据的出处都得是这道题出题时自己写的出处，而且读得出原文（texts 跟 refs 一一对应，读不出来是 null）。
 * gold-wrong（标准答案里一个词写错了；认了以后引擎把那个词改对、让判分的重判，不是把题撤掉）：
 * - 两个词都得有，至少两个字（两个都是单个汉字的除外），不能一样、不能一个包着另一个；
 * - wrongToken 在标准答案里，不在引的出处原文里，也不在这道题别的读得出的自己的出处里（own）；
 * - rightToken 不在标准答案里，在引的出处原文里，不在题目里、也不在这个专员别的待定题的标准答案里（那是哪儿都有的词），
 *   而且她两次回答里至少一次有它（没答的占位不算）；
 * - 标准答案里含 wrongToken 的那一句除了它还得剩至少两个字（整句都是那个词的没法对位置）；
 * - keep 的题：她整理前的回答里得带着 wrongToken（旧的记忆本来就错、专员改对了）。
 * two-answers（出处里两种说法都有）：默认不开（twoAnswers）；开了只收一条出处，A、B 都在那条出处里、互不包着，
 * A 在标准答案里、不在她答的里，B 不在标准答案里、在她答的里
 */
export function withdrawProblem(x: {
  gold: string; stem: string; otherGolds: string[]; answers: string[]; sources: string[]; evidence: WithdrawEvidence | undefined;
  texts: Array<string | null>; own: Array<string | null>; probe: LeadQuestion["probe"]; before?: string; twoAnswers: boolean;
}): string | null {
  const e = x.evidence;
  if (!e || !Array.isArray(e.refs) || e.refs.length < 1 || e.refs.length > 2 || (e.kind !== "gold-wrong" && e.kind !== "two-answers")) return LP.WITHDRAW.noEvidence;
  if (e.kind === "two-answers" && !x.twoAnswers) return LP.WITHDRAW.twoAnswersOff;
  if (e.kind === "two-answers" && e.refs.length !== 1) return LP.WITHDRAW.noEvidence;
  if (!e.refs.every((r) => x.sources.some((s) => sameRef(String(s), String(r))))) return LP.WITHDRAW.refNotSource;
  if (x.texts.length !== e.refs.length || x.texts.some((t) => t === null)) return LP.WITHDRAW.refUnreadable;
  // 这道题自己的出处有一条读不出原文（事件编号这类）：标准答案可能就是它撑着的，核不了——不动，照答的毛病
  const blind = x.sources.filter((_, i) => (x.own[i] ?? null) === null).map(String);
  if (blind.length || x.own.length !== x.sources.length) return LP.WITHDRAW.ownUnreadable(blind);
  const gold = norm(x.gold), sources = (x.texts as string[]).map(norm);
  // 没答的占位不算她答的
  const answers = x.answers.map(norm).filter((a) => a && a !== norm(S.marks.noAnswer));
  const inSource = (t: string): boolean => sources.some((s) => s.includes(t));
  const inAnswer = (t: string): boolean => answers.some((a) => a.includes(t));
  const single = (t: string): boolean => /^\p{Script=Han}$/u.test(t);
  const badPair = (a: string, b: string): boolean => !a || !b || a === b || a.includes(b) || b.includes(a) || ((a.length < 2 || b.length < 2) && !(single(a) && single(b)));
  if (e.kind === "gold-wrong") {
    const wrong = norm(e.wrongToken ?? ""), right = norm(e.rightToken ?? "");
    if (badPair(wrong, right)) return LP.WITHDRAW.tokens;
    if (!gold.includes(wrong)) return LP.WITHDRAW.wrongNotInGold;
    if (inSource(wrong)) return LP.WITHDRAW.wrongInSource;
    if (x.own.some((s) => s !== null && norm(s).includes(wrong))) return LP.WITHDRAW.wrongInOwnSource;
    if (gold.includes(right)) return LP.WITHDRAW.rightInGold;
    if (!inSource(right)) return LP.WITHDRAW.rightNotInSource;
    if (norm(x.stem).includes(right) || x.otherGolds.some((g) => norm(g).includes(right))) return LP.WITHDRAW.rightCommon;
    if (!inAnswer(right)) return LP.WITHDRAW.rightNotInAnswer;
    const hit = clauses(x.gold).map(norm).filter((c) => c.includes(wrong));
    if (!hit.length || hit.some((c) => c.replaceAll(wrong, "").length < 2)) return LP.WITHDRAW.noContext;
    // 对的那个词得是在说同一件事的地方出现的：有它的那条证据里，还得有标准答案那一句别的字（连着的两个字就算）
    const grams = hit.flatMap((c) => c.split(wrong)).flatMap((part) => Array.from({ length: Math.max(0, part.length - 1) }, (_, i) => part.slice(i, i + 2)));
    if (!sources.some((s) => s.includes(right) && grams.some((g) => s.includes(g)))) return LP.WITHDRAW.rightElsewhere;
    if (x.probe === "keep" && !(x.before !== undefined && norm(x.before).includes(wrong))) return LP.WITHDRAW.keepNotCarried;
    return null;
  }
  const a = norm(e.answerA ?? ""), b = norm(e.answerB ?? "");
  if (badPair(a, b)) return LP.WITHDRAW.tokens;
  if (!inSource(a) || !inSource(b)) return LP.WITHDRAW.notBoth;
  if (!gold.includes(a)) return LP.WITHDRAW.aNotInGold;
  if (gold.includes(b)) return LP.WITHDRAW.rightInGold;
  if (!inAnswer(b)) return LP.WITHDRAW.bNotInAnswer;
  if (inAnswer(a)) return LP.WITHDRAW.aInAnswer;
  return null;
}

/**
 * new / missed / continuity 的题：标准答案得从这个专员的改动以外来——至少一条出处 outside 认（原话，或者它动手以前就有的）；
 * 全是它这次自己写的不收。keep 的题不管这一条
 */
export function ownChangeProblem(q: LeadQuestion, outside: (ref: string) => boolean): string | null {
  if (q.probe === "keep") return null;
  return (Array.isArray(q.sources) ? q.sources : []).some((r) => outside(String(r))) ? null : LP.LEAD_REFUSED.ownChange;
}

/**
 * 硬规矩：考试没考成（examined false），不管领导说什么都不过；考试没过，领导说过也不算（写一句）；考过了，领导可以不过，但要写哪里要改（没写照过）；
 * 领导没回：照考试的结果。problems 是交给专员（或写进报告）的：没过的题 + 领导写的要改的地方
 */
export function leadRuled(o: { title: string; exam: ConsistencyResult; answer: LeadVerdict | null }): { pass: boolean; problems: string[]; notes: string[]; by: "lead" | "rule"; fixes?: string[] } {
  const { title, exam, answer } = o;
  const failed = exam.failed.map((f) => S.lead.failedLine(f.q, f.probe, f.why, f.gold, f.after || S.marks.noAnswer));
  // 没考成：没法判，不过（专员什么都没改的例外在 runner 里：那种不来问这里）
  if (!exam.examined) return { pass: false, problems: [LP.CONSIST.notExamined(exam.notes.at(-1) ?? LP.CONSIST.noQuestions)], notes: answer ? [] : [S.lead.silentFor(S.lead.silent, title)], by: answer ? "lead" : "rule" };
  if (!answer) return { pass: exam.pass, problems: exam.pass ? [] : failed, notes: [S.lead.silentFor(S.lead.silent, title)], by: "rule" };
  const notes = answer.notes.map((t) => t.trim()).filter(Boolean).map((t) => S.lead.note(title, t));
  const fixes = answer.fixes.filter((f) => f.what.trim() || f.fix.trim()).map((f) => (f.fix.trim() ? S.lead.fixLine(f.what.trim(), f.fix.trim()) : f.what.trim()));
  if (!exam.pass) {
    if (answer.pass) notes.push(S.lead.wantedPass(title));
    return { pass: false, problems: [...failed, ...fixes], notes, by: "lead", fixes };
  }
  if (answer.pass) return { pass: true, problems: [], notes, by: "lead" };
  if (!fixes.length) return { pass: true, problems: [], notes: [...notes, S.lead.failNoFix(title)], by: "lead" };
  return { pass: false, problems: fixes, notes, by: "lead", fixes };
}

type Kind = "review" | "verdict";
type Sess = ReturnType<LeadHost["open"]>;

/**
 * 一天一个会话，一份一份排队问；一份等 turnMs 没回就关掉这个会话（它卡住了），下一份重开（重开的第一条也带角色）；最多开 3 个
 */
export class Lead implements LeadLike {
  private sess: Sess | null = null;
  private opened = 0;
  private closed = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** 正在等的那一份：交了、会话结束、超时都调它 */
  private pending: ((v: LeadReview | LeadVerdict | null) => void) | null = null;
  private kind: Kind | null = null;
  private at: { day: string; stage: string } = { day: "", stage: "" };
  /** 这一份另外要查的（review 给的 check） */
  private extra: ((q: LeadQuestion) => string | null) | null = null;
  /** 这一份已经把出处贴回去核过一次了（下一次交就收） */
  private shown = false;
  /** 这一份核标准答案用的出处原文 */
  private excerptNow: ((q: LeadQuestion) => { ref: string; text: string } | null) | null = null;
  private keptIntent: LeadReview["intent"] = [];
  /** 头一次交、过了收题那几关、出处贴回去等它核的题（它再交一次就不用了） */
  private held: LeadQuestion[] | null = null;
  /** 这一份收到的：等这一轮结束才交回去 */
  private got: LeadReview | LeadVerdict | null = null;
  private nudged = false;

  private readonly host: LeadHost;
  private readonly o: LeadOpts;

  constructor(host: LeadHost, o: LeadOpts) {
    this.host = host;
    this.o = o;
  }

  review(b: Parameters<LeadLike["review"]>[0]): Promise<LeadReview | null> {
    const brief = LP.LEAD_REVIEW_BRIEF({ day: b.day, title: b.stage.title, round: b.round, done: b.done, diff: b.diff, ...(b.continuity?.length ? { continuity: b.continuity } : {}), maxQuestions: this.max, ...(b.changesCap ? { changesCap: b.changesCap } : {}) });
    return this.queue("review", { day: b.day, stage: b.stage.id }, brief, b.check, b.excerpt) as Promise<LeadReview | null>;
  }

  verdict(b: Parameters<LeadLike["verdict"]>[0]): Promise<LeadVerdict | null> {
    const brief = LP.LEAD_VERDICT_BRIEF({ day: b.day, title: b.stage.title, round: b.round, exam: b.exam, intent: b.intent, ...(b.note ? { note: b.note } : {}), ...(b.twice?.length ? { twice: b.twice } : {}) });
    return this.queue("verdict", { day: b.day, stage: b.stage.id }, brief) as Promise<LeadVerdict | null>;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.answer(null);
    const s = this.sess;
    this.sess = null;
    if (s) await s.close().catch(() => {});
  }

  private get max(): number { return this.o.maxQuestions ?? LEAD_MAX_QUESTIONS; }

  private queue(kind: Kind, at: { day: string; stage: string }, brief: string, extra?: (q: LeadQuestion) => string | null, excerpt?: (q: LeadQuestion) => { ref: string; text: string } | null): Promise<LeadReview | LeadVerdict | null> {
    const run = this.chain.then(() => { this.extra = extra ?? null; this.excerptNow = excerpt ?? (this.o.excerpt ? (q: LeadQuestion) => this.o.excerpt!(q, this.at) : null); return this.ask(kind, at, brief); });
    this.chain = run.catch(() => {});
    return run;
  }

  private answer(v: LeadReview | LeadVerdict | null): void {
    const p = this.pending;
    this.pending = null;
    this.kind = null;
    p?.(v);
  }

  /** 收一次 lead_review：逐道查，合格的跟这一份前面收的合在一起；intent 写了就换成新的 */
  private takeReview(r: LeadReview): string {
    const cur = (this.got as LeadReview | null) ?? { intent: [], questions: [] };
    const refused: string[] = [];
    const ok: LeadQuestion[] = [];
    r.questions.forEach((q, i) => {
      const name = S.lead.itemName(i + 1, String(q.q ?? "").slice(0, 30));
      let why: string | null = null;
      try { why = this.o.check?.(q, this.at) ?? this.extra?.(q) ?? null; } catch (e) { why = S.lead.cannotCheck(e instanceof Error ? e.message : String(e)); }
      if (why) refused.push(S.marks.labeled(name, why));
      else if (cur.questions.length + ok.length >= this.max) refused.push(S.marks.labeled(name, LP.LEAD_REFUSED.full(this.max)));
      else ok.push({ ...q, isNew: q.probe !== "keep" });
    });
    // 头一次交、里面有 new / missed / continuity 的题：先不收，把每道的标准答案和出处原文并排贴回去让它核（只来回这一次）
    const fresh = ok.map((q, i) => ({ q, n: r.questions.indexOf(r.questions.find((x) => x.q === q.q && x.probe === q.probe) ?? q) + 1 || i + 1 })).filter((x) => x.q.probe !== "keep");
    if (this.excerptNow && !this.shown && fresh.length) {
      this.shown = true;
      // 这一次写的 intent 先留着（第二次没写就用它）；不算交了。过了收题那几关的题也留着：它要是不交第二次，照这一份收（标上没核过）
      if (r.intent.length) this.keptIntent = r.intent;
      this.held = ok;
      const items = fresh.map(({ q, n }) => {
        let e: { ref: string; text: string } | null = null;
        try { e = this.excerptNow!(q); } catch { e = null; }
        return { n, q: q.q, gold: q.probe === "continuity" && q.must?.trim() ? q.must : q.gold, ref: e?.ref ?? q.sources[0] ?? "", text: e?.text ?? null };
      });
      return LP.CHECK_GOLD(items, refused);
    }
    // 交了题却一道都没收：不算交了（回话里说为什么，这一轮结束会催一次）
    if (r.questions.length > 0 && ok.length === 0 && cur.questions.length === 0) return S.lead.noneTaken(refused.join(S.marks.clauseSep));
    this.got = { intent: r.intent.length ? r.intent : cur.intent.length ? cur.intent : this.keptIntent, questions: [...cur.questions, ...ok] };
    // 出处贴回去以后又交了一次：头一次留着的不用了
    if (this.shown) this.held = null;
    return refused.length ? S.lead.someTaken(ok.length, refused.join(S.marks.clauseSep)) : S.marks.received;
  }

  /** 这一份到此为止交回去的：收下的，加上头一次交了、出处贴回去以后没再交的那几道（标上没核过） */
  private settled(): LeadReview | LeadVerdict | null {
    const held = this.held;
    this.held = null;
    if (!held?.length || this.kind !== "review") return this.got;
    const cur = (this.got as LeadReview | null) ?? { intent: this.keptIntent, questions: [] };
    const room = Math.max(0, this.max - cur.questions.length);
    return { intent: cur.intent.length ? cur.intent : this.keptIntent, questions: [...cur.questions, ...held.slice(0, room)], unchecked: true };
  }

  private openOne(): Sess | null {
    if (this.opened >= 3) return null;
    this.opened += 1;
    const id = this.opened === 1 ? this.o.id : `${this.o.id}-${this.opened}`;
    let s: Sess;
    try { s = this.host.open({ id, model: this.o.model, timeoutMs: this.o.nightMs }); } catch (e) {
      this.o.log.warn("sleep: lead session would not open", { id, error: String(e).slice(0, 200) });
      return null;
    }
    const mine = (kind: Kind): boolean => this.sess === s && this.pending !== null && this.kind === kind;
    s.onReview((r) => (mine("review") ? this.takeReview(r) : S.lead.notNow));
    s.onVerdict((v) => {
      if (!mine("verdict")) return S.lead.notNow;
      this.got = v;
      return S.marks.received;
    });
    s.onTurnEnd((ok) => {
      if (this.sess !== s || !this.pending) return;
      // 交过一次、出处贴回去了、还没交第二次：催一次（手上已经有收下的题也催——不然等着核的那几道就悄悄丢了）；还不交就照头一次的收
      if (this.held) {
        if (ok && !this.nudged) {
          this.nudged = true;
          try { s.wake(S.leadprompts.nudge.check); return; } catch { /* 叫不醒：照头一次的收 */ }
        }
        return this.answer(this.settled());
      }
      if (this.got) return this.answer(this.got);
      if (!ok || this.nudged) return this.answer(null);
      this.nudged = true;
      try { s.wake(LP.LEAD_NUDGE(this.kind ?? "review")); } catch { this.answer(null); }
    });
    const gone = (): void => { if (this.sess === s) { this.sess = null; this.answer(this.settled()); } };
    s.settled.then(gone, gone);
    return s;
  }

  private ask(kind: Kind, at: { day: string; stage: string }, brief: string): Promise<LeadReview | LeadVerdict | null> {
    if (this.closed) return Promise.resolve(null);
    let first = false;
    if (!this.sess) {
      this.sess = this.openOne();
      if (!this.sess) return Promise.resolve(null);
      first = true;
    }
    const s = this.sess;
    return new Promise((resolve) => {
      this.nudged = false;
      this.got = null;
      this.shown = false;
      this.keptIntent = [];
      this.held = null;
      this.kind = kind;
      this.at = at;
      let cancel = (): void => {};
      this.pending = (v) => { cancel(); resolve(v); };
      cancel = this.o.later(() => {
        if (this.sess !== s || !this.pending) return;
        this.o.log.warn("sleep: lead did not answer in time, closing its session", { id: s.id, kind });
        this.sess = null;
        this.answer(this.settled());
        s.close().catch(() => {});
      }, this.o.turnMs);
      try { s.wake(first ? `${this.o.role}\n\n${brief}` : brief); } catch { this.answer(null); }
    });
  }
}
