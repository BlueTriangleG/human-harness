// The Chinese pack's repair text: what the role reads from the repair code (what hh fix and hh deploy answer the role).
// Code under src/repair/ reads it through R (see src/lang/index.ts).
// Empty for now: the file and the binding exist so that moving the text touches only this file. Delete the last
// line (export {}) with the first real export.
// The rules of every pack file apply: the text is moved character for character; a literal without ${} keeps its
// kind, one with ${} becomes an arrow function whose body is the template; plain identifier keys; no runtime
// import here (import type only); text that code matches against (a token) does not belong here.
// A language pack is one per language, shared by every role of that language: nothing of one role (a name, a
// channel, a file name, a path) goes in here — that is instance configuration, passed into a sentence as a parameter.

// src/repair/approvals.ts
export const approvals = {
  // ---- Owner approval check ----
  approvalTrailersMissing: "提交说明里缺 Asked / Owner-OK / Ask-reasons",
  approvalAskNotSent: (askedSeq: unknown) => `消息库里 #${askedSeq} 不是{{ta}}发给 {{owner}} 的消息`,
  approvalFixIdLabel: "毛病编号",
  approvalAskMissingFix: (askedSeq: unknown, fixId: unknown) => `{{ta}}问 {{owner}} 的 #${askedSeq} 里没提 ${fixId}`,
  approvalReplyNotFromOwner: (replySeq: unknown) => `消息库里 #${replySeq} 不是 {{owner}} 发来的消息`,
  approvalChannelRejected: (replySeq: unknown, channel: unknown, allowedChannels: unknown) => `#${replySeq} 来自 ${channel} 渠道，只认 ${allowedChannels}`,
  approvalReplyBeforeAsk: (replySeq: unknown, askedSeq: unknown) => `{{owner}} 的 #${replySeq} 在{{ta}}问的 #${askedSeq} 之前`,
  approvalReasonSeparator: "、",
  approvalReasonsNotAsked: (reasons: unknown) => `问 {{owner}} 时没列这些理由，要再问一次：${reasons}`,
  approvalGranted: (replySeq: unknown, replyText: unknown, askedSeq: unknown, fixId: unknown) => `{{owner}} #${replySeq}「${replyText}」批了 #${askedSeq} 问的 ${fixId}`,
};

// src/repair/audit.ts
export const audit = {
  // ---- Audit stamps ----
  auditNoStamp: "无",
  auditNoBaseline: "没有基线",
};

// src/repair/check.ts
export const check = {
  // ---- Check runs ----
  checkCloneBusy: "另一个检查正在用检查克隆（hh fix check/merge 或 hh deploy），等它跑完再来",
  checkWaitMinutes: (minutes: unknown) => `${minutes} 分钟`,
  checkWaitSeconds: (seconds: unknown) => `${seconds} 秒`,
  checkHeavyLockTimedOut: (waited: unknown, waitingFor: unknown) => `重活锁等了 ${waited}没等到，在等：${waitingFor}。没跑类型检查和测试，等它跑完再来`,
};

// src/repair/cli.ts
export const cli = {
  // ---- Gate verdict ----
  verdictPass: "守门：通过",
  verdictAskOwner: "守门：要问 {{owner}}（问的时候把这些 key 抄进 --ask-reasons）",
  verdictFail: "守门：不过（先改）",
  verdictReason: (key: unknown, detail: unknown) => `- ${key}：${detail}`,
  // ---- Fix check ----
  repairCommandNotLive: (liveRoot: unknown, runningRoot: unknown) => `修理命令要用线上那份跑（hh，或 node ${liveRoot}/src/cli.ts），现在跑的是 ${runningRoot}`,
  usageFix: (command: unknown) => `用法：hh fix ${command} <分支> …`,
  checkSquashedCommit: (commit: unknown, baseCommit: unknown) => `压成一个提交 ${commit}（在共享 master ${baseCommit} 上）`,
  checkHeavyLockLabel: (command: unknown, branch: unknown) => `hh fix ${command}（${branch}）`,
  checkTscPassed: "过",
  checkTscFailed: "没过",
  checkTestsPassed: (seconds: unknown) => `过（${seconds} 秒）`,
  checkTestsFailed: "没过",
  checkResultLine: (tscResult: unknown, testsResult: unknown) => `类型检查：${tscResult}；测试：${testsResult}`,
  checkMergeReady: "可以合并：hh fix merge 同样的参数",
  checkBlockerFallback: "测试",
  checkMergeMissing: (reason: unknown) => `要合并还缺：${reason}`,
  checkEventCanMerge: "能合并",
  checkEventCannotMerge: "还不能合并",
  checkEventText: (subject: unknown, verdict: unknown) => `${subject}：${verdict}`,
  // ---- Fix merge ----
  mergeBlockedFallback: "测试或类型检查没过",
  mergeRefused: (reason: unknown) => `没合并：${reason}`,
  mergePushFailed: (error: unknown) => `推不上去（多半是共享 master 刚有人推了）：重新跑一次 hh fix merge。${error}`,
  mergeEventBy: "{{me}}",
  mergeDone: (commit: unknown) => `合进共享 master 了（${commit}）。接着 hh deploy 上线。`,
  // ---- 检查、合并在后台跑（#0091） ----
  fixStarted: (command: unknown, branch: unknown, pid: unknown) => `hh fix ${command} ${branch} 在后台跑了（pid ${pid}）：压提交、tsc、全套${command === "merge" ? "，过了就推" : ""}。这一轮被打断、Bash 超时都停不了它。跑完你会收到一条提醒，里面是结果；hh fix log 里也有。`,
  fixFinished: (command: unknown, branch: unknown, result: unknown) => `你自己在后台跑的活回来了（不是谁发来的消息）：hh fix ${command} ${branch} 跑完了。\n${result}`,
  fixStopped: (command: unknown, branch: unknown, signal: unknown) => `你自己在后台跑的活回来了（不是谁发来的消息）：hh fix ${command} ${branch} 没跑完就被停了（${signal}）。它拿着的锁已经清掉；跑到哪一步看 hh fix log。要的话再起一次。`,
  fixDied: (command: unknown, branch: unknown, how: unknown, tail: unknown) => `你自己在后台跑的活回来了（不是谁发来的消息）：hh fix ${command} ${branch} 没跑出结果就结束了（${how}）。它拿着的锁已经清掉。最后打出来的：\n${tail}`,
  fixEndedEvent: (command: unknown, branch: unknown, how: unknown) => `hh fix ${command} ${branch} 没跑出结果就结束了（${how}），它拿着的锁已清掉`,
  // ---- Deploy command ----
  deployByDefault: "{{me}}",
  deployHeavyLockLabel: (commit: unknown, by: unknown) => `hh deploy ${commit}（${by}）`,
  // ---- Audit command ----
  auditNoTrustedBaseline: "没有可信的基线（baseline/sensitive.json 不存在，或者角色自己的账号能改），敏感文件没核对",
  auditNoDeployRecord: "还没有部署记录",
  auditFileChanged: "被改过",
  auditFileMissing: "不见了",
  auditFileExtra: "多出来了",
  auditLiveFile: (path: unknown, how: unknown) => `${path} ${how}`,
  auditLocalEdits: (count: unknown, head: unknown, files: unknown) => `{{me}}本地改了 ${count} 个文件（和 HEAD ${head} 比）：${files}`,
  auditSensitiveChanged: (path: unknown, was: unknown, now: unknown) => `${path} 变了（${was} → ${now}）`,
  auditAppFaults: (app: unknown, faults: unknown) => `{{me}}的 app（${app}）不对：${faults}`,
  auditAppMissing: "app 不在了",
  auditAppUnsigned: "签名无效",
  auditAppIdentity: "读不到{{me}}的签名证书",
  auditAppSigner: "签名不是{{me}}自己的证书",
  auditAppBundle: "Info.plist 的 bundle id 不对",
  auditAppLauncher: "启动器不归{{me}}的账号，或者别人也能改",
  auditClean: "核对：线上代码和敏感文件都没在流程外变过",
  // ---- Log and summary commands ----
  logEmpty: "（没有记录）",
  summaryEmpty: "（昨天没有修理的事）",
  usageUnknownCommand: (command: unknown) => `hh fix 不认识：${command}（check / merge / audit / log / summary；部署是 hh deploy）`,
  // ---- Watchdog start ----
  spawnWatchdog: "线上还没有看守（第一次部署），这次没人看着",
  watchdogDown: "看守 15 秒内没起来：这次部署没有自动退回，要人手工盯着",
};

// src/repair/deploy.ts
export const deploy = {
  // ---- Tree extraction ----
  deployExtractFailed: (error: unknown) => `解包失败：${error}`,
  deployTreeMismatch: (path: unknown) => `解包后 ${path} 和提交对不上`,
  // ---- Deploy refusals ----
  deployLockBusy: "另一个部署正在进行（deploy.lock），等它做完再来",
  deployCommitNotFound: (target: unknown) => `共享仓库里找不到 ${target}`,
  deployNotOnMaster: "只部署共享 master 上的提交",
  deployNoRecord: "还没有部署记录（repair/deployed.json），要先做一次 bootstrap",
  deployAlreadyCurrent: "已经是这个版本",
  deployNotDescendant: (target: unknown, live: unknown) => `要部署的 ${target} 不是线上 ${live} 的后代（不能拿旧的盖新的）`,
  deployLocalNotKept: (error: unknown) => `线上有{{me}}本地的改动，存成分支没成功，这次不部署（线上没动）：${error}`,
  deployLocalKept: (count: unknown, branch: unknown) => `{{me}}本地改动（${count} 个文件）已存到 ${branch}`,
  localCommitMessage: (from: unknown, to: unknown, count: unknown) => `{{me}}在线上那份代码里的改动（${count} 个文件），部署 ${to} 前原样存下\n\n基于 ${from}，就是当时线上部署的那个提交。要不要合进 master 由团队看过再定。`,
  deployBlockedItem: (commit: unknown, via: unknown, why: unknown) => `${commit} ${via}：${why}`,
  deployBlockedCommits: (items: unknown) => `这些提交还不能上线：${items}`,
  deployRollbackRangeSeparator: "、",
  deployRollbackNotReverted: (ranges: unknown) => `看守退回过 ${ranges}，共享 master 上还没还原（还原有冲突）：先在 master 上手工还原（提交说明带 Rollback-range: <prev>..<target>），再部署`,
  deployTscFailed: (output: unknown) => `类型检查没过：\n${output}`,
  deployTestsFailed: (output: unknown) => `测试没过：\n${output}`,
  deployTestsSlower: (beforeSeconds: unknown, afterSeconds: unknown) => `测试明显变慢（${beforeSeconds} 秒 → ${afterSeconds} 秒），要问 {{owner}}`,
  deployInstallFailed: (error: unknown) => `装依赖失败（线上没动）：${error}`,
  deployExtractRolledBack: (error: unknown) => `解包出错，已经放回原样：${error}`,
  // ---- Deploy result ----
  deployRollbackNote: (count: unknown) => `、看守退回 ${count}`,
  deployDone: (fromCommit: unknown, toCommit: unknown, count: unknown, sessionCount: unknown, helperCount: unknown, ownerCount: unknown, rollbackNote: unknown) => `部署了 ${fromCommit} → ${toCommit}（${count} 个提交：会话批的 ${sessionCount}、帮手审过的 ${helperCount}、{{owner}} 批的 ${ownerCount}${rollbackNote}）；等{{ta}}闲下来自己重启`,
  deployItemLine: (commit: unknown, via: unknown, why: unknown) => `${commit} ${via}：${why}`,
};

// src/repair/entries.ts
export const entries = {
  // ---- Entry check ----
  entriesClipped: (hiddenLines: unknown) => `（后面还有 ${hiddenLines} 行没列出）`,
  entriesDefaultAdvice: "修好这些脚本（或起它们的定时任务）再部署。",
  entriesSkippedByWaiver: (by: unknown, why: unknown) => `入口检查按 ${by} 的放行跳过：${why}`,
  entriesNotRun: (error: unknown) => `入口检查没跑成（从共享仓库里读不出脚本），先不部署：${error}`,
  entriesNoScript: "这个提交里没有入口检查脚本，跳过",
  entriesRowMarkRed: "红",
  entriesRowMarkLook: "看",
  entriesNeedLook: (count: unknown, rows: unknown) => `入口检查有 ${count} 处要人看：\n${rows}`,
  entriesRowMarkRedAtRejection: "红",
  entriesRedRejected: (count: unknown, rows: unknown, advice: unknown) => `有入口没带 HH_CONFIG（${count} 处），上线后它们会直接退出：\n${rows}\n${advice}`,
  entriesUndecided: (exitCode: unknown, tail: unknown) => `入口检查自己没跑成（退出码 ${exitCode}），没法判断，先不部署：\n${tail}`,
};

// src/repair/gate.ts
export const gate = {
  // ---- Weakened tests ----
  gateDeletedSeparator: "、",
  gateTestsDeleted: (paths: unknown) => `删了测试：${paths}`,
  gateSkippedSeparator: "、",
  gateTestsSkipped: (paths: unknown) => `跳过了测试：${paths}`,
  gateAssertionsLost: (count: unknown) => `断言少了 ${count} 条`,
  // ---- Protected paths ----
  gateProtectedPath: (path: unknown) => `碰了保护名单上的 ${path}`,
  gateRootsSeparator: "、",
  gateOutsideRoots: (path: unknown, roots: unknown) => `${path} 不在 ${roots} 里`,
  gateAutoloadedPath: (path: unknown) => `${path} 会被 Claude Code 自己读进去当指令`,
  gateCapabilityAdded: (path: unknown, capability: unknown) => `${path} 新加了 ${capability} 类的代码`,
  gateToolAdded: (path: unknown, lines: unknown) => `${path} 新加了工具：${lines}`,
  // ---- Change size ----
  gateTooManyFiles: (count: unknown, limit: unknown) => `改了 ${count} 个文件（上限 ${limit}）`,
  gateTooManyLines: (count: unknown, limit: unknown) => `改了 ${count} 行（上限 ${limit}）`,
  gateMovedSeparator: "、",
  gateFilesMoved: (paths: unknown) => `删掉或挪动了：${paths}`,
  gateCoreFileChanged: (path: unknown, lines: unknown, limit: unknown) => `核心文件 ${path} 改了 ${lines} 行（上限 ${limit}）`,
  gateSchemaChanged: "改了数据库结构",
  gatePrefixGrown: (chars: unknown, limit: unknown) => `每轮固定带的说明多了 ${chars} 字（上限 ${limit}）`,
};

// src/repair/lock.ts
export const lock = {
  // ---- Heavy lock ----
  lockUnavailable: (path: unknown, reason: unknown) => `拿不了重活锁 ${path}（${reason}）`,
  lockHolder: (who: unknown, pid: unknown) => `${who}（pid ${pid}）`,
  lockHolderDead: (holder: unknown, path: unknown) => `${holder}——那个进程已经没了，可锁目录删不掉（${path}），要人去清`,
};

// src/repair/log.ts
export const log = {
  // ---- Daily summary ----
  summaryFixedItem: (fix: unknown, text: unknown) => `${fix}（${text}）`,
  summaryFixedSeparator: "、",
  summaryFixed: (items: unknown) => `修好 ${items}`,
  summaryRollbackSeparator: "、",
  summaryRollbacks: (count: unknown, reasons: unknown) => `自动退回了 ${count} 次部署（${reasons}）`,
  summaryOwnerApproved: (items: unknown) => `上线了 {{owner}} 批过的：${items}`,
  summaryAuditFindings: (findings: unknown) => `核对发现：${findings}`,
  summaryNothingFixed: "没修东西",
  summaryWaitingSeparator: "、",
  summaryWaiting: (items: unknown) => `还在等 {{owner}}：${items}。`,
  summaryYesterday: (parts: unknown, waiting: unknown) => `昨天的修理：${parts}。${waiting}`,
  summaryWaitingFile: "毛病本.md",
  /** The heading of the section of that file that lists what waits for the owner (src/repair/log.ts waitingIds) */
  waitingHeading: "问 {{owner}}",
};

// src/repair/range.ts
export const range = {
  // ---- Range verdicts ----
  rangeSessionApproved: (by: unknown, why: unknown) => `${by}：${why}`,
  rangeRollbackCommit: (range: unknown) => `看守退回 ${range}`,
  rangeNeedFixAndVerdict: "{{ta}}的修理提交要有修理单号（Fix: #NNNN）和帮手结论（Verified-by: … 通过）",
  rangeNeedApprovalOrFix: "没有会话的批准记录（hh-guard approve），也没有修理单号和帮手结论（Fix: #NNNN、Verified-by: … 通过）",
  rangeHelperVerified: (verifiedBy: unknown) => `帮手：${verifiedBy}`,
  rangeNoMessageDb: "没有消息库，核对不了 {{owner}} 的批准",
  rangeAskOwner: (reasons: unknown, why: unknown) => `要问 {{owner}}（${reasons}）：${why}`,
};

// src/repair/restart.ts
export const restart = {
  // ---- Guarded restart ----
  snapshotAtBoot: "没等{{ta}}闲下来就起来了（崩过、重启过电脑或手工重启）：开库前备份了数据库",
  restartAlreadyRunning: "已经在跑这一版了（之前崩过或重启过），不用再为部署重启",
  restartWhenIdle: "{{ta}}闲着，为部署重启",
  markBoot: (pid: unknown) => `hhd 起来了（pid ${pid}）`,
  restartTurnsFailed: (failedTurns: unknown) => `开头 ${failedTurns} 轮都失败`,
  restartProvenStable: "这一版跑稳了",
  restartFirstTurnDone: "这一版跑完了第一轮",
  restartHandedToWatchdog: (reason: unknown) => `${reason}，交给看守退回`,
  ensureWatchdog: "这次部署的看守不在了（重启过电脑、或者等重启等太久走了）：重新叫了一个",
};

// src/repair/watchdog.ts
// Unlike the other groups: deploy.ts renders this one ahead (watchdogText()) and hands it to the watchdog, which runs from a copy and
// fills the holes (\u0001<n>) itself. So every entry must be a plain template — arguments only placed into the sentence, never tested
// or computed on — with at most 9 holes; and the watchdog looks entries up by key (say(a, "rollbackFailingFromStart")), so a key renamed here must be
// renamed in src/repair/watchdog.ts too (test/repair.test.ts checks the two sides match).
export const watchdog = {
  // ---- Rollback triggers ----
  rollbackBootTimedOut: (minutes: unknown) => `重启后 ${minutes} 分钟没起来`,
  rollbackFailingFromStart: "起来了，但开头几轮都失败",
  rollbackNeverSettled: "起来了但没跑稳（tick 一直出错，或者一轮都没跑成）",
  rollbackStableThenFailing: "跑稳了，但开头几轮都失败（一轮都没跑完）",
  // ---- Revert on master ----
  revertGitName: "user.name={{me}}的看守",
  revertConflict: (detail: unknown) => `还原有冲突，要人来：${detail}`,
  revertCommitMessage: (prevShort: unknown, targetShort: unknown, reason: unknown, ofCommit: unknown, rangeFrom: unknown, rangeTo: unknown) => `revert: 退回部署 ${prevShort}..${targetShort}（${reason}）\n\nRollback-of: ${ofCommit}\nRollback-range: ${rangeFrom}..${rangeTo}`,
  revertMasterMoving: "master 一直在变，没推上去",
  revertError: (error: unknown) => `还原出错：${error}`,
  // ---- Owner notice ----
  notifyOwnerRollback: (text: unknown) => `（自动退回）${text}`,
  notifySendFailed: "告诉 {{owner}} 没发出去",
  rollbackFailed: (prevShort: unknown, targetShort: unknown, reason: unknown, error: unknown) => `退回 ${prevShort} → ${targetShort} 中途出错（要人来看）：${reason}；${error}`,
  // ---- Rollback steps ----
  rollbackExtractFailed: (error: unknown) => `解包旧版本出错（要人来看）：${error}`,
  rollbackDepsSwapped: "依赖换回了旧版本",
  rollbackDepsReinstalled: "依赖装回了旧版本",
  rollbackDepsNotRestored: "依赖没装回去（要人来看）",
  rollbackDbRestored: "数据库换回了重启那一刻的备份",
  rollbackDbRestoredKeepNew: (keptFile: unknown) => `数据库换回了重启那一刻的备份（新版本写过的那份留在 ${keptFile}）`,
  rollbackDbNotRestored: "数据库没换回：新版本跑稳过、已经在新库里记了东西（要退回数据库得人来）",
  rollbackRevertCommitted: (commit: unknown) => `共享 master 上加了还原提交 ${commit}`,
  rollbackRangeHeld: "这几个提交先拦着，master 上还原以后才能再部署",
  rollbackDone: (prevShort: unknown, targetShort: unknown, reason: unknown, notes: unknown) => `退回了部署 ${prevShort} → ${targetShort}：${reason}；${notes}`,
  // ---- Watch outcome ----
  watchGaveUp: "看守：没等到这次部署的重启（或者被更新的部署接手了），不管了",
  watchFailed: (error: unknown) => `看守出错，不看了：${error}`,
};
