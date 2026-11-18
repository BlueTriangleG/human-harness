import { S } from "../lang/index.ts";
// 专员 + 领导模式（engine: "team"）说给会话听的话。跟 prompts.ts 里 SLEEP_* 一个口气；这里不写任何人的名字、页名、说法（那些在工作区的流程配置和 skill 页里）。

/**
 * 专员和领导的开头第一句：下面是整理之前的基础块（核心的样子）。专员和领导用同一句，开头才一字不差、吃得到同一份缓存；
 * 谁是领导、谁做哪一段，写在叫醒它的第一条消息里，不进开头
 */

/** 领导的第一条消息最前面：它是谁、今晚做什么；page 是它的 skill 页（流程配置里 team.lead.skill 指的那一页） */
export const LEAD_ROLE = (page: string): string => [
  S.leadprompts.role.lead,
  S.leadprompts.role.onlyLook,
  page.trim(),
].filter(Boolean).join("\n\n");

/** 领导交的题不收的理由（别的理由跟段交的题一样：prompts.ts 的 QUESTION_REFUSED） */
export const LEAD_REFUSED = {
  get layer() { return S.leadprompts.refused.layer; },
  get probe() { return S.leadprompts.refused.probe; },
  /** new / missed / continuity 的题：出处全是这个专员这次自己写的（它这一批新建的编号、它提案里新加的行） */
  get ownChange() { return S.leadprompts.refused.ownChange; },
  full: (max: number) => S.leadprompts.refused.full(max),
  get must() { return S.leadprompts.refused.must; },
};

/** 领导没交：催一次 */
export const LEAD_NUDGE = (kind: "review" | "verdict"): string => (kind === "review"
  ? S.leadprompts.nudge.review
  : S.leadprompts.nudge.verdict);

/** 给领导看的那一份（它列的改动、文件 diff、事件库的变化）每样默认最多这么多字（team.diffCap 可以改；全文在 .diff 文件里） */
export const LEAD_DIFF_CAP = 12000;

/**
 * 给领导的第一份：一个专员交差了。它说的（报告、改动）、实际改的（文件 diff、事件库那一批的变化）、引擎对账看出来的；
 * continuity 是这一天固定要问的几道题（配置里来的，问法原样）
 */
export const LEAD_REVIEW_BRIEF = (b: {
  day: string; title: string; round: number;
  done: { status: string; report: string; changes: unknown[]; uncertain: string[] };
  diff: { files: string; ops: string; fileCount: number; opCount: number; hints: string[] };
  continuity?: string[]; maxQuestions: number; changesCap?: number;
}): string => {
  const CHANGES_CAP = b.changesCap ?? LEAD_DIFF_CAP;
  const changes = JSON.stringify(b.done.changes);
  return [
    S.leadprompts.review.head(b.day, b.title, b.round > 1 ? S.leadprompts.review.round(b.round) : ""),
    S.leadprompts.review.said(b.done.status, b.done.report.trim() || S.runner.report.notWritten),
    ...(b.done.uncertain.length ? [S.leadprompts.review.uncertain(b.done.uncertain.map((x) => `- ${x}`).join("\n"))] : []),
    S.leadprompts.review.changes(changes.length > CHANGES_CAP ? S.leadprompts.review.changesCut(changes.slice(0, CHANGES_CAP)) : changes),
    ...(b.round > 1 ? [S.leadprompts.fix.roundNote(S.leadprompts.fix.noPaste)] : []),
    S.leadprompts.review.files(b.diff.fileCount, b.diff.files.trim()),
    S.leadprompts.review.ops(b.diff.opCount, b.diff.ops.trim()),
    ...(b.diff.hints.length ? [S.leadprompts.review.hints(b.diff.hints.map((x) => `- ${x}`).join("\n"))] : []),
    ...(b.continuity?.length ? [S.leadprompts.review.continuity(b.continuity.map((x) => `- ${x}`).join("\n"))] : []),
    [
      S.leadprompts.review.handIn(b.maxQuestions, READ_ON_DEMAND(b.day)),
      S.leadprompts.review.intent,
      S.leadprompts.review.questions,
      S.leadprompts.review.layer,
      S.leadprompts.review.gold,
      `- ${S.leadprompts.checkGold.brief}`,
    ].join("\n"),
  ].join("\n\n");
};

/** 给领导的第二份：前后两场考完了 */
export const LEAD_VERDICT_BRIEF = (b: {
  day: string; title: string; round: number;
  exam: { examined: boolean; pass: boolean; failed: Array<{ id: string; probe: string; q: string; gold: string; after: string; before?: string; why: string }>; notes: string[]; scoreAfter: number | null; scoreBefore: number | null };
  intent: Array<{ target: string; what: string; fix: string }>;
  note?: string;
  /** 连着两轮没过的题（题号、题、标准答案、上一轮和这一轮答的）：先判是题的毛病还是答的毛病 */
  twice?: Array<{ id: string; q: string; gold: string; answers: string[]; sources?: Array<{ ref: string; text: string | null }> }>;
}): string => {
  const pct = (x: number | null): string => (x === null ? S.leadprompts.verdict.notExamined : `${Math.round(x * 100)}%`);
  const fixes = b.intent.filter((x) => x.fix.trim());
  return [
    ...(b.note ? [b.note] : []),
    S.leadprompts.verdict.head(b.day, b.title, b.round > 1 ? S.leadprompts.verdict.round(b.round) : "", !b.exam.examined ? S.leadprompts.verdict.broken : b.exam.pass ? S.leadprompts.verdict.consistent : S.leadprompts.verdict.failed, pct(b.exam.scoreAfter), pct(b.exam.scoreBefore)),
    ...(b.exam.failed.length ? [S.leadprompts.verdict.failedQuestions(b.exam.failed.map((f) => S.leadprompts.verdict.failedQuestion(f.id, f.probe, f.q, f.gold, f.after || S.marks.noAnswer, f.before !== undefined ? S.leadprompts.verdict.beforeAnswer(f.before || S.marks.noAnswer) : "", f.why)).join("\n"))] : []),
    ...(b.exam.notes.length ? [S.leadprompts.verdict.notes(b.exam.notes.map((x) => `- ${x}`).join("\n"))] : []),
    ...(fixes.length ? [S.leadprompts.verdict.fixes(fixes.map((x) => S.leadprompts.verdict.fix(x.target, x.fix)).join("\n"))] : []),
    ...(b.twice?.length ? [S.leadprompts.verdict.twice(S.leadprompts.twice.head, b.twice.map((t) => S.leadprompts.verdict.twiceQuestion(t.id, t.q, t.gold, t.answers.map((x) => x || S.marks.noAnswer).join(S.replay.answerSep), (t.sources ?? []).map((s) => S.leadprompts.verdict.source(s.ref, s.text ?? S.leadprompts.noOriginal)).join(""))).join("\n"), S.leadprompts.twice.how, S.leadprompts.withdraw.how)] : []),
    S.leadprompts.verdict.handIn,
  ].join("\n\n");
};

/** 前后一致的考试说的话（进领导的简报、报告、记账） */
export const CONSIST = {
  /** keep 题：整理后（重考了一次）答不出、整理前答得出 */
  get lost() { return S.leadprompts.consist.lost; },
  /** 写事件库的专员、整理前的事件库没拷成：没法考整理前，整理后答不出的照碰坏了算 */
  get noCopy() { return S.leadprompts.consist.noCopy; },
  get noCopyNote() { return S.leadprompts.consist.noCopyNote; },
  bothWrong: (q: string): string => S.leadprompts.consist.bothWrong(q),
  beforePartial: (q: string): string => S.leadprompts.consist.beforePartial(q),
  newWrong: (q: string, probe: string): string => S.leadprompts.consist.newWrong(probe, q),
  belowRate: (rate: number, need: number): string => S.leadprompts.consist.belowRate(Math.round(rate * 100), Math.round(need * 100)),
  /** 第 1 轮出的 new / missed 题单算的得分率不到线（改的那几轮新加的题只能拉低、不能拉高） */
  belowRoundOne: (rate: number, need: number): string => S.leadprompts.consist.belowRoundOne(Math.round(rate * 100), Math.round(need * 100)),
  /** 每晚固定要问的题：整理后答不对 */
  get continuity() { return S.leadprompts.consist.continuity; },
  broken: (why: string): string => S.leadprompts.consist.broken(why),
  get noQuestions() { return S.leadprompts.consist.noQuestions; },
  /** 改了东西却没考成：不落地 */
  notExamined: (why: string): string => S.leadprompts.consist.notExamined(why),
  /** 常驻那层整理前的样子拼不出来：没法考整理前，整理后答不出的照碰坏了算 */
  get noBeforeView() { return S.leadprompts.consist.noBeforeView; },
  afterPartial: (q: string): string => S.leadprompts.consist.afterPartial(q),
  residentOff: (why: string): string => S.leadprompts.consist.residentOff(why),
  archive: (n: number): string => S.leadprompts.consist.archive(n),
};

/** 领导第 2 次起看的那一份前面：下面只有这一轮新改的 */
/** 改的那一轮什么都没改：不再考，上一轮的考试结果照旧，领导照它定 */
/** 交差以后、提交以前提案又变了 */
export const CHANGED_AFTER_HANDIN = (paths: string[]): string => S.leadprompts.changedAfterHandIn(paths.slice(0, 5).join(S.marks.listSep), paths.length > 5 ? "……" : "");
/** 留着的专员会话不在了（内核会话死了、被重开过）：没法在原来的会话里改 */
export const FIX_SESSION_GONE = (title: string): string => S.leadprompts.fix.sessionGone(title);
/** 花费到了绝对线：不再退回去改 */
export const FIX_OVER_BUDGET = (title: string): string => S.leadprompts.fix.overBudget(title);

/**
 * 退回去改：发给还开着的那个专员会话。problems 是没过的题（标准答案、它整理后答成什么、差在哪）和领导写的要改的地方；
 * left = 这一次改完以后还能再改几轮
 */
export const LEAD_FIX = (problems: string[], left: number): string => [
  S.leadprompts.fix.head,
  problems.map((p) => `- ${p}`).join("\n"),
  S.leadprompts.fix.handIn(left > 0 ? S.leadprompts.fix.roundsLeft(left) : S.leadprompts.fix.lastRound),
].join("\n\n");

/** 这个专员前几天有没做成、欠着的：今晚先把那几天它这一段该做的补上（材料在那几天的目录里），再做今天的 */
export const OWED_FIRST = (days: string[]): string =>
  S.leadprompts.owed.first(days.join(S.marks.listSep), days.length > 1 ? S.leadprompts.owed.these : S.leadprompts.owed.that, days.map((x) => `sleep/${x}/`).join(S.marks.listSep), days[0]);
/** 给领导的提示：这个专员今晚还补了前几天欠着的 */
export const OWED_HINT = (days: string[]): string => S.leadprompts.owed.hint(days.join(S.marks.listSep), days.map((x) => `sleep/${x}/`).join(S.marks.listSep));

/** 固定要问的题（continuity）单独考的那一场说的话 */
export const CONT = {
  /** 要点没答对：发回给专员的 */
  mustWrong: (q: string, answer: string, sources: string[]): string => S.leadprompts.cont.mustWrong(q, answer || S.marks.noAnswer, sources.length ? sources.join(S.marks.listSep) : S.teamrun.noSources),
  /** 记账、报告里的一句：要点对了几道、细节对了几条 */
  ratio: (must: { right: number; total: number }, extras: { right: number; total: number }): string => S.leadprompts.cont.ratio(must.right, must.total, extras.right, extras.total),
  /** 回放里落地那几步没拼出来 */
  buildFailed: (why: string): string => S.leadprompts.cont.buildFailed(why),
  notExamined: (why: string): string => S.leadprompts.cont.notExamined(why),
  /** 配置里固定要问的题领导没交上来（没有标准答案，没法考） */
  notHandedIn: (qs: string[]): string => S.leadprompts.cont.notHandedIn(qs.join(S.marks.clauseSep)),
};

/** 领导改标准答案（止损）收不收 */
export const REVISION = {
  get same() { return S.leadprompts.revision.same; },
  get notNarrower() { return S.leadprompts.revision.notNarrower; },
  /** 报告里的一句：领导要改、没收 */
  refused: (q: string, why: string): string => S.leadprompts.revision.refused(q, why),
};
/** 回放里落地那几步动了提案目录：开头固定这一句（回放据此算没跑成） */
export const FINISH_TOUCHED = (cmd: string, paths: string[]): string => S.leadprompts.finishTouched(S.leadprompts.finishTouchedHead, paths.slice(0, 5).join(S.marks.listSep), paths.length > 5 ? "……" : "", cmd);
/** 记账那一行里注一句：这一轮是在回放里拼过的工作区上改的 */

/** 连着两轮没过的题：定夺那一份里的开头一句 */
/** 报告里的一句：领导判了是题的毛病，改了标准答案 */
export const QUESTION_REVISED = (x: { q: string; from: string; to: string; answers: string[]; why: string }): string =>
  S.leadprompts.questionRevised(x.q, x.from, x.to, x.answers.map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep), x.why || S.runner.report.notWritten);
/** 定夺那一份里说怎么收窄 */
/** 领导要翻这一天的材料：按题去翻，不要整份读（整份读进来，它这一天后面每一轮都要再付一遍） */
export const READ_ON_DEMAND = (day: string): string => S.leadprompts.readOnDemand(day);
/** 判分的会话的开头：一句话就够（判分只对答案和标准答案，不用她的整份样子） */

/** 交差时该管的文件有没动、也没说为什么的：当场退回一次 */
export const DUTY_BOUNCE = (left: string[]): string =>
  S.leadprompts.duty.bounce(left.join(S.marks.listSep));
/** 给领导的提示：该管的一处没动，它说的理由（没说是 null） */
export const DUTY_LEFT = (path: string, reason: string | null): string => S.leadprompts.duty.left(path, reason ?? S.leadprompts.duty.noReason);

/** 材料的一片太长，没贴进第一条消息：只写它在哪 */
export const SLICE_TOO_LONG = (path: string, chars: number): string => S.leadprompts.sliceTooLong(chars, path);
/** 切片默认超过这么多字不贴 */
export const SLICE_CAP = 20000;

/** 领导每个专员一个会话：第一条消息里、这个专员交的东西前面，先说前面几个专员今晚定了什么 */
export const DIGEST_CAP = 1500;
/** 一个专员那一块：过没过、改了哪些（文件、事件库的编号带标题）、那一次领导留的话（没过的是为什么）；最多 cap 个字 */
export const DIGEST_BLOCK = (x: { title: string; passed: boolean; targets: string[]; notes: string[] }, cap: number): string => {
  const text = [
    S.leadprompts.digest.title(x.title, x.passed ? S.teamrun.passed : S.leadprompts.digest.dropped),
    // 把关留的话（为什么）排在改了哪些前面：太长要截的时候截的是那一长串文件和编号
    ...(x.notes.length ? [S.marks.labeled(x.passed ? S.leadprompts.digest.notes : S.leadprompts.digest.why, x.notes.join(S.marks.clauseSep))] : []),
    ...(x.passed && x.targets.length ? [S.leadprompts.digest.changed(x.targets.join(S.marks.listSep))] : []),
  ].join("\n");
  return text.length > cap ? S.leadprompts.digest.cut(text.slice(0, cap)) : text;
};
export const LEAD_DIGEST = (blocks: string[]): string => (blocks.length ? `${S.leadprompts.digest.head}\n\n${blocks.join("\n\n")}` : "");

/** 领导头一次交题：不收，把 new / missed / continuity 每道题的标准答案和出处原文并排贴回去 */
export const CHECK_GOLD_NO_TEXT = (ref: string): string => S.leadprompts.checkGold.noText(ref || S.leadprompts.checkGold.noRef);
export const CHECK_GOLD = (items: Array<{ n: number; q: string; gold: string; ref: string; text: string | null }>, refused: string[]): string => [
  S.leadprompts.checkGold.head,
  ...items.map((x) => S.leadprompts.checkGold.question(x.n, x.q, x.gold, x.text === null ? CHECK_GOLD_NO_TEXT(x.ref) : S.marks.labeled(x.ref, x.text))),
  ...(refused.length ? [S.leadprompts.checkGold.refused(refused.join(S.marks.clauseSep))] : []),
  S.leadprompts.checkGold.how,
].join("\n");
/** 简报里的一句：交题要交两次 */

/** 定夺那一份里说什么时候能撤一道题 */
/** 撤题不收的理由 */
export const WITHDRAW = {
  get noEvidence() { return S.leadprompts.withdraw.noEvidence; },
  get twoAnswersOff() { return S.leadprompts.withdraw.twoAnswersOff; },
  get wrongInOwnSource() { return S.leadprompts.withdraw.wrongInOwnSource; },
  get rightCommon() { return S.leadprompts.withdraw.rightCommon; },
  get keepNotCarried() { return S.leadprompts.withdraw.keepNotCarried; },
  get aInAnswer() { return S.leadprompts.withdraw.aInAnswer; },
  stillWrong: (gold: string): string => S.leadprompts.withdraw.stillWrong(gold),
  get noGrader() { return S.leadprompts.withdraw.noGrader; },
  get refNotSource() { return S.leadprompts.withdraw.refNotSource; },
  get refUnreadable() { return S.leadprompts.withdraw.refUnreadable; },
  /** 这道题自己的出处里有引擎读不出原文的：标准答案可能就是它撑着的，核不了，不动 */
  ownUnreadable: (refs: string[]): string => S.leadprompts.withdraw.ownUnreadable(refs.join(S.marks.listSep)),
  get rightElsewhere() { return S.leadprompts.withdraw.rightElsewhere; },
  get tokens() { return S.leadprompts.withdraw.tokens; },
  get noContext() { return S.leadprompts.withdraw.noContext; },
  get wrongNotInGold() { return S.leadprompts.withdraw.wrongNotInGold; },
  get wrongInSource() { return S.leadprompts.withdraw.wrongInSource; },
  get rightInGold() { return S.leadprompts.withdraw.rightInGold; },
  get rightNotInSource() { return S.leadprompts.withdraw.rightNotInSource; },
  get rightNotInAnswer() { return S.leadprompts.withdraw.rightNotInAnswer; },
  get notBoth() { return S.leadprompts.withdraw.notBoth; },
  get aNotInGold() { return S.leadprompts.withdraw.aNotInGold; },
  get bNotInAnswer() { return S.leadprompts.withdraw.bNotInAnswer; },
  get continuity() { return S.leadprompts.withdraw.continuity; },
  capStage: (n: number): string => S.leadprompts.withdraw.capStage(n),
  capNight: (n: number): string => S.leadprompts.withdraw.capNight(n),
  /** 报告里的一句：领导要改（撤）、没动 */
  refused: (q: string, why: string): string => S.leadprompts.withdraw.refused(q, why),
};
/** 报告最上面：撤掉的题（一道一行，带上人看得出撤得对不对的全部东西） */
export const WITHDRAWN = (x: { q: string; gold: string; answers: string[]; kind: string; tokens: string[]; refs: string[]; excerpts: string[]; why: string }): string =>
  S.leadprompts.withdrawn(S.leadprompts.withdrawnHead, x.q, x.gold, x.answers.map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep), x.kind, x.tokens.map((t) => S.replay.quoted(t)).join(S.replay.answerSep), x.refs.map((r, i) => S.marks.labeled(r, x.excerpts[i] ?? "")).join(S.replay.refSep), x.why || S.runner.report.notWritten);

/** 报告最上面：改了标准答案的题（领导判标准答案里一个词写错了，引擎核过、判分的照改过的重判了她的回答；这些题算对、不进题库） */
export const CORRECTED = (x: { q: string; gold: string; newGold: string; answers: string[]; tokens: string[]; refs: string[]; excerpts: string[]; unreadable: string[]; why: string }): string =>
  S.leadprompts.corrected(S.leadprompts.correctedHead, x.q, x.gold, x.newGold, x.tokens[0], x.tokens[1], x.answers.map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep), x.refs.map((r, i) => S.marks.labeled(r, x.excerpts[i] ?? "")).join(S.replay.refSep), x.unreadable.length ? S.leadprompts.correctedUnread(x.unreadable.join(S.marks.listSep)) : "", x.why || S.runner.report.notWritten);

/** 领导交过一次题、出处贴回去了、这一轮结束了还没交第二次：催的这一句（它不是「还没调」） */
/** 报告里的一句：这个专员的题领导没核过出处就收了 */
export const UNCHECKED = (title: string): string => S.leadprompts.unchecked(title);
