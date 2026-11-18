// The Chinese pack's gate text: what the role reads from the gate code (why a message was delivered or held, the lines the small judge sees before each item, the headings of the daily digest material).
// Code under src/gate/ reads it through G (see src/lang/index.ts).
// Empty for now: the file and the binding exist so that moving the text touches only this file. Delete the last
// line (export {}) with the first real export.
// The rules of every pack file apply: the text is moved character for character; a literal without ${} keeps its
// kind, one with ${} becomes an arrow function whose body is the template; plain identifier keys; no runtime
// import here (import type only); text that code matches against (a token) does not belong here.
// A language pack is one per language, shared by every role of that language: nothing of one role (a name, a
// channel, a file name, a path) goes in here — that is instance configuration, passed into a sentence as a parameter.

// src/gate/card.ts
export const card = {
  // ---- Activity card ----
  nowDoing: "现在在做：",
};

// src/gate/digest.ts
export const digest = {
  // ---- People and rules ----
  nomineesHeading: "【要加进认识的人吗】",
  nomineeLine: (conv: unknown, src: unknown, count: unknown) => `- ${conv}（${src}，${count} 条）`,
  ruleErrorsHeading: "【规则文件的问题】",
  registryChangesHeading: "【名单今天的变动】",
  ruleHitsHeading: "【规则各看过多少】",
  /** What the count of decisions no rule made is listed under */
  ruleHitsNoRule: "默认",
  ruleHitsItem: (ruleId: unknown, count: unknown) => `${ruleId} ${count} 条`,
  ruleHitsSeparator: "、",
  // ---- Unsure items ----
  unsureHeading: "【拿不准的】",
  unsureReasonSuffix: (reason: unknown) => `（${reason}）`,
  unsureLine: (conv: unknown, text: unknown, reasonSuffix: unknown) => `- ${conv}：${text}${reasonSuffix}`,
  unsureMore: (count: unknown) => `…还有 ${count} 条`,
  // ---- Set-aside events ----
  setAsideHeading: "【各处放下的动静】",
  setAsideGroupLine: (conv: unknown, src: unknown, digestCount: unknown, dropCount: unknown) => `${conv}（${src}）：进总结 ${digestCount} 条，直接丢掉 ${dropCount} 条`,
  setAsideGroupMore: (count: unknown) => `…还有 ${count} 条`,
};

// src/gate/fixed.ts
export const fixed = {
  // ---- Fixed routes ----
  mentionedInGroup: "群里有人 @你",
};

// src/gate/gate.ts
export const gate = {
  // ---- Quota pause ----
  pauseDailyQuotaUsed: "今天的小判断额度用完了",
  pauseJudgeBroken: "小判断刚才没回",
  pauseJudgeBrokenSendDirect: (brokenNote: unknown) => `${brokenNote}，先直接给你`,
  pauseCheckFailed: (reason: unknown) => `把关出错：${reason}`,
  // ---- Fallback to role ----
  fallbackLogFailed: (reason: unknown) => `记账失败：${reason}`,
  fallbackDispatchFailed: (reason: unknown) => `闸门出错：${reason}`,
  fallbackDispatchFailedAtJudging: (reason: unknown) => `闸门出错：${reason}`,
  fallbackPeopleUnreadable: (reason: unknown) => `名单读不了：${reason}`,
  fallbackRoutingFailed: (reason: unknown) => `分流出错：${reason}`,
  // ---- Judge failures ----
  judgeNoVerdict: "没判出来",
  judgeTimedOut: "小判断超时",
  // ---- Held to digest ----
  heldToDigestSuffix: "，群里的先进总结",
  heldUnsureToDigestSuffix: "（拿不准，按规则进总结）",
  // ---- Delivery ----
  deliveryFailed: (reason: unknown) => `送不出去：${reason}`,
};

// src/gate/judge.ts
export const judge = {
  // ---- Judge input ----
  contextHeading: "同一个群刚才：",
  itemSenderSuffix: (sender: unknown) => `（${sender}）`,
  itemHeader: (eventId: unknown, conv: unknown, senderSuffix: unknown) => `[${eventId}] 来源：${conv}${senderSuffix}`,
  itemWant: (want: unknown) => `规则想看的：${want}`,
  itemUnreadMore: (count: unknown) => `（前面还有 ${count} 条没看到）`,
};

// src/gate/parse.ts
export const parse = {
  // ---- Event line ----
  eventDetailSuffix: (detail: unknown) => `（${detail}）`,
  eventBodyBlock: (body: unknown) => `\n  ┄┄┄┄ 正文 ┄┄┄┄\n${body}\n  ┄┄┄┄┄┄┄┄┄┄┄┄`,
  // ---- What the gate reads back in a wake-up's text, in every pack's form (src/gate/parse.ts) ----
  /** The line that opens an event's body (eventBodyBlock, the senses script's line) */
  bodyOpen: "┄┄┄┄ 正文 ┄┄┄┄",
  /** How a probe's tag ends when it asks for the role itself: [手机断网·要你处理] */
  asksTail: "·要你处理",
  /** How the senses script's line after the events starts (it asks for the acknowledgement) */
  ackHead: "核对处理完再运行",
};

// src/gate/rules.ts
export const rules = {
  // ---- Defaults ----
  defaultWant: "有人在跟我说话、提到我、和我在做的事有关、或者是我真会感兴趣的；纯通知和跟我无关的不用。",
  // ---- Rule validation ----
  invalidRuleNotObject: "规则不是对象",
  invalidRuleId: "id 要是非空字符串",
  invalidMatchNotObject: (ruleId: unknown) => `${ruleId}：match 要是对象`,
  invalidAction: (ruleId: unknown) => `${ruleId}：action 只能是 main/judge/digest/drop`,
  invalidWhen: (ruleId: unknown) => `${ruleId}：when 只能是 now/work/leisure`,
  invalidWant: (ruleId: unknown) => `${ruleId}：want 要是字符串`,
  invalidIfUnsure: (ruleId: unknown) => `${ruleId}：ifUnsure 只能是 main/digest`,
  invalidNote: (ruleId: unknown) => `${ruleId}：note 要是字符串`,
  invalidMatchField: (ruleId: unknown, problem: unknown) => `${ruleId}：match.${problem}`,
  // ---- Match field types ----
  matchSrcType: "src 要是字符串或字符串数组",
  matchConvType: "conv 要是字符串",
  matchSenderType: "sender 要是字符串",
  matchRegexType: "regex 要是字符串",
  matchKeywordsType: "keywords 要是字符串数组",
  matchKnownType: "known 要是布尔",
  matchIsGroupType: "isGroup 要是布尔",
  matchMentionsMeType: "mentionsMe 要是布尔",
  matchFieldUnknown: (field: unknown) => `${field} 不认识`,
  matchRegexTooComplex: "regex：这个正则太复杂（最多 200 字，不能有 (a+)+、(a{2,})* 这种套着的重复）",
  // ---- Rule file loading ----
  fileMissingNoRules: "没有规则文件：现在没有规则，都交给下意识判断",
  fileMissingLog: "gate rules: 没有规则文件，现在没有规则",
  fileVanished: "规则文件不见了",
  fileUnreadable: "规则文件读不到",
  fileReadFailed: (reason: unknown) => `规则文件读不了：${reason}`,
  fileNoRulesArray: "规则文件顶层没有 rules 数组",
  fileRegexInvalid: (ruleId: unknown) => `${ruleId}：regex 编不过，这条跳过`,
  fileRulesSkippedLog: "gate rules: 有规则被跳过",
  fileKeepingLastLog: "gate rules: 规则文件有问题，沿用上一份",
  // ---- Rule tool errors ----
  toolRegexInvalid: (ruleId: unknown, reason: unknown) => `${ruleId}：regex 编不过（${reason}）`,
  toolSourceSeparator: "、",
  toolRuleOnlyFixedSources: (ruleId: unknown, sources: unknown) => `${ruleId}：${sources} 走固定的路（直接到我面前），规则管不到`,
  toolFileNoRulesArray: "顶层没有 rules 数组",
  toolRuleIdExists: (ruleId: unknown) => `已经有 ${ruleId} 这条了：要改用 edit`,
  toolPositionOutOfRange: (max: unknown) => `to 只能是 0 到 ${max}`,
  toolRuleNotFound: (ruleId: unknown) => `没有 ${ruleId} 这条规则（先 list 看看）`,
  toolPositionOutOfRangeAtMove: (max: unknown) => `to 只能是 0 到 ${max}`,
  toolRuleIdTaken: (ruleId: unknown) => `已经有 ${ruleId} 这条了，不能改成这个 id`,
  // ---- Rule listing ----
  listMatchAll: "（什么都对得上）",
  listUnsureJudgeOnly: "（只对 judge 有用）",
  listIfUnsure: (choice: unknown, note: unknown) => `｜拿不准：${choice}${note}`,
  /** each action said as where the event goes (the rule check's buckets, a rule's if-unsure) */
  outcomeName: { main: "直达", judge: "交给判断", digest: "进总结", drop: "丢" },
  listWant: (want: unknown) => `｜want：${want}`,
  listRuleLine: (index: unknown, ruleId: unknown, action: unknown, when: unknown, match: unknown, ifUnsure: unknown, want: unknown) => `${index}. ${ruleId}：${action} ${when}｜${match}${ifUnsure}${want}`,
};

// src/gate/outbound.ts
export const outbound = {
  // ---- Refusals ----
  latinLineRefused: "没发出去：出口过滤把它当成了英文的过程说明（旁白）。原样重发还会被拦；要发就改成平常跟人说话的中文，或者不发。",
};
