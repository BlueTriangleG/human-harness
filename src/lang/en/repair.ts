// The English pack's repair: the entries of src/lang/zh/repair.ts translated so far (src/lang/en/index.ts lays them over the reference).
// An entry missing here is read from the reference pack, src/lang/zh/repair.ts; `hh lang status en --list repair` lists them.
// Names, parameter lists and placeholders ({{me}}, {{owner}}, {{Owner}}, {{ta}}, {{place}}) must match the reference entry.
// Kept as the reference writes them: the names of commit trailers and the word 通过 a Verified-by trailer ends with, the
// two row marks of the entry check (红, 看). The bug book is memory/bugs.md with its "## Ask <owner>" section, as the
// English night guide writes it; the morning summary reads every pack's file and heading.

// src/repair/approvals.ts
export const approvals = {
  approvalTrailersMissing: "the commit message lacks Asked / Owner-OK / Ask-reasons",
  approvalAskNotSent: (askedSeq: unknown) => `#${askedSeq} in the message store is not a message {{ta}} sent to {{owner}}`,
  approvalFixIdLabel: "fault id",
  approvalAskMissingFix: (askedSeq: unknown, fixId: unknown) => `#${askedSeq}, in which {{ta}} asked {{owner}}, does not mention ${fixId}`,
  approvalReplyNotFromOwner: (replySeq: unknown) => `#${replySeq} in the message store is not a message from {{owner}}`,
  approvalChannelRejected: (replySeq: unknown, channel: unknown, allowedChannels: unknown) => `#${replySeq} came over the channel ${channel}; only ${allowedChannels} count`,
  approvalReplyBeforeAsk: (replySeq: unknown, askedSeq: unknown) => `#${replySeq} from {{owner}} is earlier than #${askedSeq}, in which {{ta}} asked`,
  approvalReasonSeparator: ", ",
  approvalReasonsNotAsked: (reasons: unknown) => `these reasons were not listed when {{owner}} was asked, so ask once more: ${reasons}`,
  approvalGranted: (replySeq: unknown, replyText: unknown, askedSeq: unknown, fixId: unknown) => `{{owner}} #${replySeq} "${replyText}" approved ${fixId}, asked about in #${askedSeq}`,
};

// src/repair/audit.ts
export const audit = {
  auditNoStamp: "none",
  auditNoBaseline: "no baseline",
};

// src/repair/check.ts
export const check = {
  checkCloneBusy: "another check is using the check clone (hh fix check/merge or hh deploy); come back when it has finished",
  checkWaitMinutes: (minutes: unknown) => `${minutes} minutes`,
  checkWaitSeconds: (seconds: unknown) => `${seconds} seconds`,
  checkHeavyLockTimedOut: (waited: unknown, waitingFor: unknown) => `waited ${waited} for the heavy lock without getting it; waiting behind: ${waitingFor}. The type check and the tests were not run; come back when it has finished`,
};

// src/repair/cli.ts
export const cli = {
  // ---- Gate verdict ----
  verdictPass: "Gate: pass",
  verdictAskOwner: "Gate: ask {{owner}} (when asking, copy these keys into --ask-reasons)",
  verdictFail: "Gate: fail (change it first)",
  verdictReason: (key: unknown, detail: unknown) => `- ${key}: ${detail}`,
  // ---- Fix check ----
  repairCommandNotLive: (liveRoot: unknown, runningRoot: unknown) => `Repair commands must be run from the live copy (hh, or node ${liveRoot}/src/cli.ts); what is running now is ${runningRoot}`,
  usageFix: (command: unknown) => `usage: hh fix ${command} <branch> …`,
  checkSquashedCommit: (commit: unknown, baseCommit: unknown) => `squashed into one commit ${commit} (on the shared master ${baseCommit})`,
  checkHeavyLockLabel: (command: unknown, branch: unknown) => `hh fix ${command} (${branch})`,
  checkTscPassed: "passed",
  checkTscFailed: "failed",
  checkTestsPassed: (seconds: unknown) => `passed (${seconds} s)`,
  checkTestsFailed: "failed",
  checkResultLine: (tscResult: unknown, testsResult: unknown) => `type check: ${tscResult}; tests: ${testsResult}`,
  checkMergeReady: "ready to merge: hh fix merge with the same arguments",
  checkBlockerFallback: "tests",
  checkMergeMissing: (reason: unknown) => `still lacking before it can merge: ${reason}`,
  checkEventCanMerge: "can merge",
  checkEventCannotMerge: "cannot merge yet",
  checkEventText: (subject: unknown, verdict: unknown) => `${subject}: ${verdict}`,
  // ---- Fix merge ----
  mergeBlockedFallback: "the tests or the type check failed",
  mergeRefused: (reason: unknown) => `Not merged: ${reason}`,
  mergePushFailed: (error: unknown) => `Could not push (most likely someone just pushed to the shared master): run hh fix merge once more. ${error}`,
  mergeEventBy: "{{me}}",
  mergeDone: (commit: unknown) => `Merged into the shared master (${commit}). Next, hh deploy to put it live.`,
  // ---- Check and merge run in the background (#0091) ----
  fixStarted: (command: unknown, branch: unknown, pid: unknown) => `hh fix ${command} ${branch} is running in the background (pid ${pid}): the squash, tsc and the full suite${command === "merge" ? ", then the push" : ""}. An interrupted turn or a Bash timeout does not stop it. When it ends you get a reminder with the result; hh fix log has it too.`,
  fixFinished: (command: unknown, branch: unknown, result: unknown) => `Your own background job is back (not a message from anyone): hh fix ${command} ${branch} has finished.\n${result}`,
  fixStopped: (command: unknown, branch: unknown, signal: unknown) => `Your own background job is back (not a message from anyone): hh fix ${command} ${branch} was stopped (${signal}) before it finished. The locks it held are cleared; hh fix log shows how far it got. Run it again when you want it.`,
  fixDied: (command: unknown, branch: unknown, how: unknown, tail: unknown) => `Your own background job is back (not a message from anyone): hh fix ${command} ${branch} ended without a result (${how}). The locks it held are cleared. The last it printed:\n${tail}`,
  fixEndedEvent: (command: unknown, branch: unknown, how: unknown) => `hh fix ${command} ${branch} ended without a result (${how}); the locks it held were cleared`,
  // ---- Deploy command ----
  deployByDefault: "{{me}}",
  deployHeavyLockLabel: (commit: unknown, by: unknown) => `hh deploy ${commit} (${by})`,
  // ---- Audit command ----
  auditNoTrustedBaseline: "there is no trusted baseline (baseline/sensitive.json does not exist, or the role's own user can change it); the sensitive files were not checked",
  auditNoDeployRecord: "there is no deploy record yet",
  auditFileChanged: "was changed",
  auditFileMissing: "is gone",
  auditFileExtra: "is extra",
  auditLiveFile: (path: unknown, how: unknown) => `${path} ${how}`,
  auditLocalEdits: (count: unknown, head: unknown, files: unknown) => `{{me}} changed ${count} files locally (against HEAD ${head}): ${files}`,
  auditSensitiveChanged: (path: unknown, was: unknown, now: unknown) => `${path} changed (${was} → ${now})`,
  auditAppFaults: (app: unknown, faults: unknown) => `{{me}}'s app (${app}) is not as it was built: ${faults}`,
  auditAppMissing: "it is gone",
  auditAppUnsigned: "its signature is not valid",
  auditAppIdentity: "{{me}}'s signing certificate cannot be read",
  auditAppSigner: "it is not signed by {{me}}'s own certificate",
  auditAppBundle: "Info.plist's bundle id is wrong",
  auditAppLauncher: "its launcher is not {{me}}'s account's, or others can write it",
  auditClean: "Audit: neither the live code nor the sensitive files changed outside the process",
  // ---- Log and summary commands ----
  logEmpty: "(no records)",
  summaryEmpty: "(no repairs yesterday)",
  usageUnknownCommand: (command: unknown) => `hh fix does not know: ${command} (check / merge / audit / log / summary; deploying is hh deploy)`,
  // ---- Watchdog start ----
  spawnWatchdog: "there is no watchdog on the live copy yet (the first deploy); nobody is watching this time",
  watchdogDown: "the watchdog was not up within 15 seconds: this deploy has no automatic rollback and needs a person to watch it",
};

// src/repair/deploy.ts
export const deploy = {
  deployExtractFailed: (error: unknown) => `unpacking failed: ${error}`,
  deployTreeMismatch: (path: unknown) => `after unpacking, ${path} does not match the commit`,
  deployLockBusy: "another deploy is in progress (deploy.lock); come back when it is done",
  deployCommitNotFound: (target: unknown) => `${target} was not found in the shared repository`,
  deployNotOnMaster: "only commits on the shared master are deployed",
  deployNoRecord: "there is no deploy record yet (repair/deployed.json); a bootstrap has to be done first",
  deployAlreadyCurrent: "already at this version",
  deployNotDescendant: (target: unknown, live: unknown) => `${target}, the one to deploy, is not a descendant of the live ${live} (an old version cannot be put over a new one)`,
  deployLocalNotKept: (error: unknown) => `the live copy has {{me}}'s own edits, and keeping them on a branch failed, so nothing is deployed (the live copy is untouched): ${error}`,
  deployLocalKept: (count: unknown, branch: unknown) => `{{me}}'s local edits (${count} files) are kept on ${branch}`,
  localCommitMessage: (from: unknown, to: unknown, count: unknown) => `{{me}}'s edits to the live copy (${count} files), kept as they were before deploying ${to}\n\nOn top of ${from}, the commit deployed then. Whether it goes into master is for the team to read and decide.`,
  deployBlockedItem: (commit: unknown, via: unknown, why: unknown) => `${commit} ${via}: ${why}`,
  deployBlockedCommits: (items: unknown) => `these commits cannot go live yet: ${items}`,
  deployRollbackRangeSeparator: ", ",
  deployRollbackNotReverted: (ranges: unknown) => `the watchdog rolled back ${ranges}, and the shared master has not been reverted yet (the revert had conflicts): revert on master by hand first (with Rollback-range: <prev>..<target> in the commit message), then deploy`,
  deployTscFailed: (output: unknown) => `the type check failed:\n${output}`,
  deployTestsFailed: (output: unknown) => `the tests failed:\n${output}`,
  deployTestsSlower: (beforeSeconds: unknown, afterSeconds: unknown) => `the tests got clearly slower (${beforeSeconds} s → ${afterSeconds} s); ask {{owner}}`,
  deployInstallFailed: (error: unknown) => `installing dependencies failed (the live copy is untouched): ${error}`,
  deployExtractRolledBack: (error: unknown) => `unpacking failed, and everything was put back as it was: ${error}`,
  deployRollbackNote: (count: unknown) => `, ${count} rolled back by the watchdog`,
  deployDone: (fromCommit: unknown, toCommit: unknown, count: unknown, sessionCount: unknown, helperCount: unknown, ownerCount: unknown, rollbackNote: unknown) => `Deployed ${fromCommit} → ${toCommit} (${count} commits: ${sessionCount} approved by a session, ${helperCount} reviewed by a helper, ${ownerCount} approved by {{owner}}${rollbackNote}); {{ta}} restarts by itself when idle`,
  deployItemLine: (commit: unknown, via: unknown, why: unknown) => `${commit} ${via}: ${why}`,
};

// src/repair/entries.ts
export const entries = {
  entriesClipped: (hiddenLines: unknown) => `(${hiddenLines} more lines not listed)`,
  entriesDefaultAdvice: "Repair these scripts (or the timed jobs that start them) before deploying.",
  entriesSkippedByWaiver: (by: unknown, why: unknown) => `the entry check was skipped on a waiver by ${by}: ${why}`,
  entriesNotRun: (error: unknown) => `the entry check could not be run (the script could not be read from the shared repository); not deploying for now: ${error}`,
  entriesNoScript: "this commit has no entry check script; skipped",
  entriesRowMarkRed: "红",
  entriesRowMarkLook: "看",
  entriesNeedLook: (count: unknown, rows: unknown) => `the entry check has ${count} places a person must look at:\n${rows}`,
  entriesRowMarkRedAtRejection: "红",
  entriesRedRejected: (count: unknown, rows: unknown, advice: unknown) => `some entries do not carry HH_CONFIG (${count} places) and would exit at once after going live:\n${rows}\n${advice}`,
  entriesUndecided: (exitCode: unknown, tail: unknown) => `the entry check itself did not run (exit code ${exitCode}), so nothing can be decided; not deploying for now:\n${tail}`,
};

// src/repair/gate.ts
export const gate = {
  gateDeletedSeparator: ", ",
  gateTestsDeleted: (paths: unknown) => `tests deleted: ${paths}`,
  gateSkippedSeparator: ", ",
  gateTestsSkipped: (paths: unknown) => `tests skipped: ${paths}`,
  gateAssertionsLost: (count: unknown) => `${count} fewer assertions`,
  gateProtectedPath: (path: unknown) => `touches ${path}, which is on the protected list`,
  gateRootsSeparator: ", ",
  gateOutsideRoots: (path: unknown, roots: unknown) => `${path} is not inside ${roots}`,
  gateAutoloadedPath: (path: unknown) => `${path} is read in by Claude Code itself as instructions`,
  gateCapabilityAdded: (path: unknown, capability: unknown) => `${path} adds code of the kind ${capability}`,
  gateToolAdded: (path: unknown, lines: unknown) => `${path} adds a tool: ${lines}`,
  gateTooManyFiles: (count: unknown, limit: unknown) => `${count} files changed (limit ${limit})`,
  gateTooManyLines: (count: unknown, limit: unknown) => `${count} lines changed (limit ${limit})`,
  gateMovedSeparator: ", ",
  gateFilesMoved: (paths: unknown) => `deleted or moved: ${paths}`,
  gateCoreFileChanged: (path: unknown, lines: unknown, limit: unknown) => `the core file ${path} has ${lines} lines changed (limit ${limit})`,
  gateSchemaChanged: "the database structure was changed",
  gatePrefixGrown: (chars: unknown, limit: unknown) => `the instructions carried every turn grew by ${chars} characters (limit ${limit})`,
};

// src/repair/lock.ts
export const lock = {
  lockUnavailable: (path: unknown, reason: unknown) => `the heavy lock ${path} cannot be taken (${reason})`,
  lockHolder: (who: unknown, pid: unknown) => `${who} (pid ${pid})`,
  lockHolderDead: (holder: unknown, path: unknown) => `${holder} — that process is gone, but the lock directory cannot be removed (${path}); a person has to clear it`,
};

// src/repair/log.ts
export const log = {
  summaryFixedItem: (fix: unknown, text: unknown) => `${fix} (${text})`,
  summaryFixedSeparator: ", ",
  summaryFixed: (items: unknown) => `fixed ${items}`,
  summaryRollbackSeparator: ", ",
  summaryRollbacks: (count: unknown, reasons: unknown) => `${count} deploys were rolled back automatically (${reasons})`,
  summaryOwnerApproved: (items: unknown) => `what {{owner}} approved went live: ${items}`,
  summaryAuditFindings: (findings: unknown) => `the audit found: ${findings}`,
  summaryNothingFixed: "nothing fixed",
  summaryWaitingSeparator: ", ",
  summaryWaiting: (items: unknown) => `Still waiting for {{owner}}: ${items}.`,
  summaryYesterday: (parts: unknown, waiting: unknown) => `Yesterday's repairs: ${parts}. ${waiting}`,
  summaryWaitingFile: "bugs.md",
  // the fault book is written by the night, which writes Chinese for now: its file name and this heading stay as it writes them
  waitingHeading: "Ask {{owner}}",
};

// src/repair/range.ts
export const range = {
  rangeSessionApproved: (by: unknown, why: unknown) => `${by}: ${why}`,
  rangeRollbackCommit: (range: unknown) => `the watchdog rolled back ${range}`,
  rangeNeedFixAndVerdict: "a repair commit by {{ta}} needs a repair ticket number (Fix: #NNNN) and a helper's verdict (Verified-by: … 通过)",
  rangeNeedApprovalOrFix: "there is no approval record from a session (hh-guard approve), and no repair ticket number and helper's verdict either (Fix: #NNNN, Verified-by: … 通过)",
  rangeHelperVerified: (verifiedBy: unknown) => `helper: ${verifiedBy}`,
  rangeNoMessageDb: "there is no message store, so the approval by {{owner}} cannot be checked",
  rangeAskOwner: (reasons: unknown, why: unknown) => `ask {{owner}} (${reasons}): ${why}`,
};

// src/repair/restart.ts
export const restart = {
  snapshotAtBoot: "came up without waiting for {{ta}} to be idle (a crash, a restart of the computer, or a restart by hand): the database was backed up before it was opened",
  restartAlreadyRunning: "this version is already running (after an earlier crash or restart); no restart needed for the deploy",
  restartWhenIdle: "{{ta}} is idle; restarting for the deploy",
  markBoot: (pid: unknown) => `hhd is up (pid ${pid})`,
  restartTurnsFailed: (failedTurns: unknown) => `the first ${failedTurns} turns all failed`,
  restartProvenStable: "this version runs stable",
  restartFirstTurnDone: "this version finished its first turn",
  restartHandedToWatchdog: (reason: unknown) => `${reason}; handed to the watchdog to roll back`,
  ensureWatchdog: "this deploy's watchdog was gone (the computer was restarted, or it left after waiting too long for the restart): a new one was called",
};

// src/repair/watchdog.ts
// Every entry here must be a plain template with at most 9 holes — arguments only placed into the sentence, never tested
// or computed on: the watchdog runs from a copy and fills the holes itself, and looks entries up by key.
export const watchdog = {
  rollbackBootTimedOut: (minutes: unknown) => `not up ${minutes} minutes after the restart`,
  rollbackFailingFromStart: "up, but the first few turns all failed",
  rollbackNeverSettled: "up but never stable (the tick kept failing, or not one turn ran through)",
  rollbackStableThenFailing: "ran stable, but the first few turns all failed (not one turn finished)",
  revertGitName: "user.name=HH watchdog",
  revertConflict: (detail: unknown) => `the revert has conflicts and needs a person: ${detail}`,
  revertCommitMessage: (prevShort: unknown, targetShort: unknown, reason: unknown, ofCommit: unknown, rangeFrom: unknown, rangeTo: unknown) => `revert: roll back the deploy ${prevShort}..${targetShort} (${reason})\n\nRollback-of: ${ofCommit}\nRollback-range: ${rangeFrom}..${rangeTo}`,
  revertMasterMoving: "master kept changing; the push did not go through",
  revertError: (error: unknown) => `the revert failed: ${error}`,
  notifyOwnerRollback: (text: unknown) => `(automatic rollback) ${text}`,
  notifySendFailed: "telling {{owner}} did not go out",
  rollbackFailed: (prevShort: unknown, targetShort: unknown, reason: unknown, error: unknown) => `rolling back ${prevShort} → ${targetShort} failed midway (a person has to look): ${reason}; ${error}`,
  rollbackExtractFailed: (error: unknown) => `unpacking the old version failed (a person has to look): ${error}`,
  rollbackDepsSwapped: "the dependencies were swapped back to the old version",
  rollbackDepsReinstalled: "the dependencies were reinstalled at the old version",
  rollbackDepsNotRestored: "the dependencies were not put back (a person has to look)",
  rollbackDbRestored: "the database was put back to the backup taken at the restart",
  rollbackDbRestoredKeepNew: (keptFile: unknown) => `the database was put back to the backup taken at the restart (the one the new version wrote to is kept at ${keptFile})`,
  rollbackDbNotRestored: "the database was not put back: the new version ran stable and has already recorded things in the new database (putting the database back needs a person)",
  rollbackRevertCommitted: (commit: unknown) => `a revert commit ${commit} was added on the shared master`,
  rollbackRangeHeld: "these commits are held for now and can be deployed again only after the revert on master",
  rollbackDone: (prevShort: unknown, targetShort: unknown, reason: unknown, notes: unknown) => `Rolled back the deploy ${prevShort} → ${targetShort}: ${reason}; ${notes}`,
  watchGaveUp: "watchdog: the restart of this deploy never came (or a newer deploy took over); letting go",
  watchFailed: (error: unknown) => `watchdog failed and stops watching: ${error}`,
};
