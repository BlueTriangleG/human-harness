// The English pack's gate: the entries of src/lang/zh/gate.ts translated so far (src/lang/en/index.ts lays them over the reference).
// An entry missing here is read from the reference pack, src/lang/zh/gate.ts; `hh lang status en --list gate` lists them.
// Names, parameter lists and placeholders ({{me}}, {{owner}}, {{Owner}}, {{ta}}, {{place}}) must match the reference entry.

// src/gate/card.ts
export const card = {
  nowDoing: "Doing now: ",
};

// src/gate/digest.ts
export const digest = {
  nomineesHeading: "[Add to the people you know?]",
  nomineeLine: (conv: unknown, src: unknown, count: unknown) => `- ${conv} (${src}, ${count} items)`,
  ruleErrorsHeading: "[Problems with the rules file]",
  registryChangesHeading: "[Today's changes to the people list]",
  ruleHitsHeading: "[How much each rule looked at]",
  ruleHitsNoRule: "default",
  ruleHitsItem: (ruleId: unknown, count: unknown) => `${ruleId} ${count}`,
  ruleHitsSeparator: ", ",
  unsureHeading: "[Unsure]",
  unsureReasonSuffix: (reason: unknown) => ` (${reason})`,
  unsureLine: (conv: unknown, text: unknown, reasonSuffix: unknown) => `- ${conv}: ${text}${reasonSuffix}`,
  unsureMore: (count: unknown) => `… and ${count} more`,
  setAsideHeading: "[What was let go, place by place]",
  setAsideGroupLine: (conv: unknown, src: unknown, digestCount: unknown, dropCount: unknown) => `${conv} (${src}): ${digestCount} into the digest, ${dropCount} dropped outright`,
  setAsideGroupMore: (count: unknown) => `… and ${count} more`,
};

// src/gate/fixed.ts
export const fixed = {
  mentionedInGroup: "someone mentioned you in a group",
};

// src/gate/gate.ts
export const gate = {
  pauseDailyQuotaUsed: "today's allowance for the quick judge is used up",
  pauseJudgeBroken: "the quick judge did not answer just now",
  pauseJudgeBrokenSendDirect: (brokenNote: unknown) => `${brokenNote}; handed to you directly for now`,
  pauseCheckFailed: (reason: unknown) => `the check failed: ${reason}`,
  fallbackLogFailed: (reason: unknown) => `the bookkeeping failed: ${reason}`,
  fallbackDispatchFailed: (reason: unknown) => `the gate failed: ${reason}`,
  fallbackDispatchFailedAtJudging: (reason: unknown) => `the gate failed: ${reason}`,
  fallbackPeopleUnreadable: (reason: unknown) => `the people list cannot be read: ${reason}`,
  fallbackRoutingFailed: (reason: unknown) => `the routing failed: ${reason}`,
  judgeNoVerdict: "no verdict came out",
  judgeTimedOut: "the quick judge timed out",
  heldToDigestSuffix: "; what is from a group goes into the digest first",
  heldUnsureToDigestSuffix: " (unsure; into the digest, as the rule says)",
  deliveryFailed: (reason: unknown) => `could not be delivered: ${reason}`,
};

// src/gate/judge.ts
export const judge = {
  contextHeading: "In the same group just before:",
  itemSenderSuffix: (sender: unknown) => ` (${sender})`,
  itemHeader: (eventId: unknown, conv: unknown, senderSuffix: unknown) => `[${eventId}] source: ${conv}${senderSuffix}`,
  itemWant: (want: unknown) => `What the rule wants to see: ${want}`,
  itemUnreadMore: (count: unknown) => `(${count} more before this were not seen)`,
};

// src/gate/parse.ts
export const parse = {
  eventDetailSuffix: (detail: unknown) => ` (${detail})`,
  eventBodyBlock: (body: unknown) => `\n  ┄┄┄┄ body ┄┄┄┄\n${body}\n  ┄┄┄┄┄┄┄┄┄┄┄┄`,
  bodyOpen: "┄┄┄┄ body ┄┄┄┄",
  asksTail: "·needs you",
  ackHead: "When you have checked and dealt with them",
};

// src/gate/rules.ts
export const rules = {
  defaultWant: "Someone is talking to me, I am mentioned, it has to do with what I am working on, or it is something I would truly care about; plain notifications and what has nothing to do with me are not wanted.",
  invalidRuleNotObject: "the rule is not an object",
  invalidRuleId: "id must be a non-empty string",
  invalidMatchNotObject: (ruleId: unknown) => `${ruleId}: match must be an object`,
  invalidAction: (ruleId: unknown) => `${ruleId}: action can only be main/judge/digest/drop`,
  invalidWhen: (ruleId: unknown) => `${ruleId}: when can only be now/work/leisure`,
  invalidWant: (ruleId: unknown) => `${ruleId}: want must be a string`,
  invalidIfUnsure: (ruleId: unknown) => `${ruleId}: ifUnsure can only be main/digest`,
  invalidNote: (ruleId: unknown) => `${ruleId}: note must be a string`,
  invalidMatchField: (ruleId: unknown, problem: unknown) => `${ruleId}: match.${problem}`,
  matchSrcType: "src must be a string or an array of strings",
  matchConvType: "conv must be a string",
  matchSenderType: "sender must be a string",
  matchRegexType: "regex must be a string",
  matchKeywordsType: "keywords must be an array of strings",
  matchKnownType: "known must be a boolean",
  matchIsGroupType: "isGroup must be a boolean",
  matchMentionsMeType: "mentionsMe must be a boolean",
  matchFieldUnknown: (field: unknown) => `${field} is not known`,
  matchRegexTooComplex: "regex: this pattern is too complex (200 characters at most, and no nested repetition like (a+)+ or (a{2,})*)",
  fileMissingNoRules: "there is no rules file: no rules for now, and everything goes to the gate's judging",
  fileMissingLog: "gate rules: no rules file, no rules for now",
  fileVanished: "the rules file is gone",
  fileUnreadable: "the rules file cannot be read",
  fileReadFailed: (reason: unknown) => `the rules file cannot be read: ${reason}`,
  fileNoRulesArray: "the rules file has no rules array at the top level",
  fileRegexInvalid: (ruleId: unknown) => `${ruleId}: regex does not compile; this rule is skipped`,
  fileRulesSkippedLog: "gate rules: some rules were skipped",
  fileKeepingLastLog: "gate rules: the rules file has a problem; keeping the last version",
  toolRegexInvalid: (ruleId: unknown, reason: unknown) => `${ruleId}: regex does not compile (${reason})`,
  toolSourceSeparator: ", ",
  toolRuleOnlyFixedSources: (ruleId: unknown, sources: unknown) => `${ruleId}: ${sources} take the fixed route (straight to me), out of the rules' reach`,
  toolFileNoRulesArray: "there is no rules array at the top level",
  toolRuleIdExists: (ruleId: unknown) => `there already is a rule ${ruleId}: to change it use edit`,
  toolPositionOutOfRange: (max: unknown) => `to can only be 0 to ${max}`,
  toolRuleNotFound: (ruleId: unknown) => `there is no rule ${ruleId} (look with list first)`,
  toolPositionOutOfRangeAtMove: (max: unknown) => `to can only be 0 to ${max}`,
  toolRuleIdTaken: (ruleId: unknown) => `there already is a rule ${ruleId}; the id cannot be changed to that`,
  listMatchAll: "(matches anything)",
  listUnsureJudgeOnly: " (only for judge)",
  listIfUnsure: (choice: unknown, note: unknown) => `｜if unsure: ${choice}${note}`,
  outcomeName: { main: "straight to me", judge: "handed to judging", digest: "into the digest", drop: "dropped" },
  listWant: (want: unknown) => `｜want: ${want}`,
  listRuleLine: (index: unknown, ruleId: unknown, action: unknown, when: unknown, match: unknown, ifUnsure: unknown, want: unknown) => `${index}. ${ruleId}: ${action} ${when}｜${match}${ifUnsure}${want}`,
};

// src/gate/outbound.ts
export const outbound = {
  latinLineRefused: "Not sent: the outbound filter took it for a narration of the process in English. Sent again unchanged it will be held again; to send it, put it the way you ordinarily talk to this person, or do not send it.",
};
