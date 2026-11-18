// Brain：唯一的编排者。把各个模块接起来：
//   外界消息 → 丘脑 → 脑区；脑区的一切 → 中央记忆；
//   每轮结束 → 检查翻页 / 专注续命；定时 tick → 脑干决定困不困、睡不睡，专注时段、放空漫想、提醒。
// 翻页和睡觉都是"交给海马做、等它这一轮结束"的异步流程：失败会退避重试，不会丢记忆；有看门狗防卡死。
import { basename, dirname, join, posix } from "node:path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { Config } from "./config.ts";
import { DEFAULT_MORNING, kernelEnv, roleNames } from "./config.ts";
import type { Db } from "./store/db.ts";
import { all, kvGet, kvSet } from "./store/db.ts";
import { approvedFrom, changeText, storeMissingIdentity } from "./persona/registry.ts";
import { TaskBook, parseDuration } from "./basal/tasks.ts";
import type { Pri, TaskRow } from "./basal/tasks.ts";
import { decideDispatch, chatActivity, helperSessionsDir } from "./basal/dispatch.ts";
import { drainSpool, spoolDirOf } from "./relaySpool.ts";
import { afterBackgroundTurn, helperNameFromAct, helperStoppedFromAct, askedPerson, overTime, touchedOf, attachHelperTo, ghostHelpers, HELPER_ASK_AFTER_MS } from "./basal/lifecycle.ts";
import { parallelLines, withoutVolatile } from "./basal/situationLines.ts";
import { readEvents, summarize, waitingIds } from "./repair/log.ts";
import type { Entry, SeqGap } from "./memory/central.ts";
import { CentralMemory, renderMemory, sentBody, sentTo, unsentMark, visibleTo } from "./memory/central.ts";
import { resolveAnchors } from "./memory/anchors.ts";
import { estimateTokens } from "./memory/tokens.ts";
import type { Kind } from "./memory/central.ts";
import { Epochs } from "./epoch/epoch.ts";
import type { Epoch } from "./epoch/epoch.ts";
import { buildPrefix, runtimeFactsOf } from "./persona/persona.ts";
import type { Persona } from "./persona/persona.ts";
import { People, replyTarget, relationOf, relationTag, personOfTarget, targetKey } from "./persona/people.ts";
import type { AliasKey, Person } from "./persona/people.ts";
import { Claims } from "./basal/claims.ts";
import { Thalamus, Schedule, scriptNames, mentionsScript } from "./thalamus/router.ts";
import type { ScheduleItem } from "./thalamus/router.ts";
import { parseSenses, mentionsMe, asksForMe, senseIds, helperOf, buildLine } from "./gate/parse.ts";
export { mentionsMe, asksForMe, senseIds } from "./gate/parse.ts";
import { Bank } from "./sleep/bank.ts";
import { Gate, NO_UPSTREAM_ID } from "./gate/gate.ts";
import type { Delivery, GateStats, JudgeFn } from "./gate/gate.ts";
import { defaultWant, Rules } from "./gate/rules.ts";
import { judgeBatch } from "./gate/judge.ts";
import { dailyDigest, dailyDigestMaterial, nextDigestFrom, nomineeCounts, pruneGateLog } from "./gate/digest.ts";
import type { JudgeItem } from "./gate/judge.ts";
import { buildCard, nowDoing } from "./gate/card.ts";
import { sourcesOf } from "./gate/sources.ts";
import type { SenseEvent } from "./gate/types.ts";
import type { Inbound } from "./thalamus/router.ts";
import { decide } from "./brainstem/state.ts";
import type { Alertness, SleepKind } from "./brainstem/state.ts";
import { focusSlotAt, localTime, parseHM, nightSleepDue, inNight, nightOf, hhmm } from "./brainstem/clock.ts";
import { regionSpecs, modelFor, modelOf, fallbackFor, type RegionSpec, type Role } from "./regions/specs.ts";
import { addSpend, providerEnv, providerOf, turnUsd, weekSpend, type Spend } from "./providers.ts";
import { localDay } from "./learning/score.ts";
import { Region, SessionOpenError } from "./regions/region.ts";
import { PromptFolds } from "./memory/folds.ts";
import type { KernelDriver, KernelEvent, ToolDef, AskResult, TurnTotal } from "./kernel/types.ts";
import { z } from "zod";
import { buildTools } from "./tools/hhtools.ts";
import type { ToolContext } from "./tools/hhtools.ts";
import type { Runner } from "./util/run.ts";
import { runProcess } from "./util/run.ts";
import { bashWritesTo } from "./util/bashWrites.ts";
import type { Logger } from "./log.ts";
import { M, P, T, type CheckEntry, type CheckPage, type WakeKind, S } from "./lang/index.ts";
import { parseWhen, parseEvery } from "./tools/hhtools.ts";
import type { InboundMessage, Send } from "./channels/types.ts";
import { WordList, wordHits } from "./tools/wordlist.ts";
import type { ListedWord } from "./tools/wordlist.ts";
import { recallCentral } from "./memory/recall.ts";
import type { GatewayCaller } from "./gateway/client.ts";
import type { Chrome } from "./browser/chrome.ts";
import type { Situation, HumanContext, Said } from "./memory/situation.ts";
import { EventMemory } from "./memory/events/memory.ts";
import { aliasLookup } from "./memory/events/store.ts";
import { memTools } from "./tools/memtools.ts";
import type { CheckCandidate } from "./tools/memtools.ts";
import { renderMidterm } from "./memory/events/midterm.ts";
import { CARD_DIR } from "./memory/events/people.ts";
import { Recognizer } from "./memory/events/recognize.ts";
import type { Recognized } from "./memory/events/recognize.ts";
import { likeName } from "./memory/events/schema.ts";
import { scanShelf } from "./learning/notebook.ts";
import type { LearningRuntime } from "./learning/runtime.ts";
import { renderResident, renderShelf, shelfDirOf } from "./learning/shelf.ts";
import { SHELF_FILE, readShelfRules } from "./learning/layers.ts";
import { param } from "./learning/params.ts";
import { MEM_READ_TOOLS } from "./tools/memtools.ts";
import { saveExam } from "./memory/events/exam.ts";
import { OPENINGS_DIR, refreshBeforeWake, saveOpening } from "./sleep/wake.ts";
import { nightGuide, organizerOf } from "./sleep/guide.ts";
import type { ExamAnswer, ExamQuestion } from "./memory/events/exam.ts";
import { openDb } from "./store/db.ts";
import { DatabaseSync } from "node:sqlite";
import { observeQuota, quotaSummary } from "./brainstem/quota.ts";
import type { QuotaReading, QuotaState } from "./brainstem/quota.ts";
import type { LearnNight } from "./tools/memtools.ts";
import { Budget, units, type Model, type Weights } from "./sleep/budget.ts";
import { setRunQuota } from "./sleep/ledger.ts";
import { SleepRunner } from "./sleep/runner.ts";
import type { NightResult } from "./sleep/runner.ts";
import { assembleNight } from "./sleep/night.ts";
import { ReplayManager, type ReplayDeps } from "./sleep/replay.ts";
import { REPLAY_CONFIRM } from "./sleep/stopped.ts";
import type { MiniFs } from "./sleep/record.ts";
import { nodeFs, readNight, sleepWeights } from "./sleep/host.ts";
import { planText } from "./sleep/flow.ts";
import type { NightBrain, NightHosts, NightPlan } from "./sleep/host.ts";
import { B, N, dateLocale, fromEveryPack } from "./lang/index.ts";
import type { Modules } from "./modules/load.ts";
import { LAYOUT } from "./persona/layout.ts";

export interface BrainDeps {
  cfg: Config;
  db: Db;
  driver: KernelDriver;
  persona: Persona;
  /** 重新读人格和记忆文件（夜里整理会改它们）：翻页、睡醒换前缀时调；读失败就用旧的 */
  reloadPersona?: () => Persona;
  log: Logger;
  run?: Runner;
  now?: () => number;
  /** 延时执行（测试里换成手动时钟）；返回取消的更好（夜里引擎用它取消看门狗、各段的时限），不返回也行 */
  later?: (fn: () => void, ms: number) => void | (() => void);
  /** 文件在不在（测试里可以换掉） */
  fileExists?: (path: string) => boolean;
  /** 读文本文件（读不到给 null；测试里可以换掉） */
  readText?: (path: string) => string | null;
  /** 文件的修改时间（毫秒，没有给 null）：闸门的规则文件改了就重读（测试里可以换掉） */
  mtime?: (path: string) => number | null;
  people?: People;
  /** 名单文件（她手改了不用重启）：mtime 变了就重读；读不到保留当前名单。不给就不重载 */
  registryFile?: { mtime(): number | null; read(): Record<string, unknown> };
  /** 给每个脑区加载的本地插件目录（技能手册） */
  plugins?: string[];
  /** The gateway client, only handed on to the tools for the computer tool (messages go out through send) */
  gateway?: GatewayCaller;
  /** How every message goes out: the final reply here, the message and sticker tools through their context (openChannels) */
  send: Send;
  /** 她自己的 Chrome（不给就没有 browser 工具可用） */
  browser?: Chrome;
  /** 两个气泡之间的停顿（毫秒，测试里设 0） */
  bubbleGapMs?: () => number;
  /** 两个气泡之间怎么等（不给就是真的等那么久）；测试拿它卡在两条气泡中间、由测试放行，不靠真实的毫秒数 */
  bubbleWait?: (ms: number) => Promise<void>;
  /** 叫醒主线时附上的情境（时间、负载、目标、联想……）；没有就不附 */
  situation?: Situation;
  /** The role's loaded modules (src/modules/load.ts): their tools, commands, MCP servers and guides */
  modules?: Modules;
  /** 电脑吃紧没有（吃紧时不往外分）；不给就当不紧 */
  loadTight?: () => boolean;
  /** 技能手册重新打包（换前缀时调） */
  refreshSkills?: () => void;
  /** 长期事件记忆（想起事情的工具、夜里整理写库）；没有就不挂这些工具 */
  mem?: EventMemory;
  /** 学习（笔记本和话题联想）；有的话叫醒主线时联想笔记（接进情境里），没有就不联想 */
  learning?: LearningRuntime;
  /** 夜里分段整理读写的文件（提案、变更记录、报告、上一份能用的流程）：相对路径按工作区算；不给就是真文件（测试里换成内存的） */
  sleepFs?: MiniFs;
}

/** 补交的消息存了多久以上，前面说一句「X 分钟前发的」 */
const SPOOLED_NOTE_MS = 2 * 60_000;

/** 有人来消息时那句提示里的「他是谁」：关系、指路的文件；指的是导出的人物卡（不是迁移前的档案）就用卡的说法（R28） */
/** owner: the relation line names the owner first (no relation line at all also means the owner) — the prompt leaves out the "mind who you are talking to" part then */
const triggerWho = (ev: Inbound): { relation?: string; profile?: string; card?: boolean; owner: boolean } =>
  ({ relation: ev.relation, profile: ev.profile, ...(ev.profile?.startsWith(`${CARD_DIR}/`) ? { card: true } : {}), owner: !ev.relation || (N.owner !== "" && ev.relation.startsWith(N.owner)) });

const FOCUS_GAP_MS = 1_000;
const FOCUS_IDLE_MAX = 3;                   // 专注里连着超过这么多轮没做事（没调工具），提示换成更直接的那句
// 最近 FOCUS_RECENT 个专注轮里有 FOCUS_RECENT_IDLE 个空轮、又不是一口气连着空的：也给带「想干等」的那句。
// 11-13 09:00–09:25 她空一轮、动一下，连着空转的计数一直清零，143 个专注轮里那句一次都没出来
const FOCUS_RECENT = 6;
const FOCUS_RECENT_IDLE = 3;
const FOCUS_PARK_MAX_MS = 30 * 60_000;     // 她在干活、专注没叫主线：最多停这么久照叫一次（后台一轮卡住不结束也不至于整段专注都不叫）
const FOCUS_WAIT_MS = 60_000;               // 她说了想干等：一分钟叫一次
const FOCUS_TIGHT_GAP_MS = 15 * 60_000;     // 这周额度到线（schedule.focusQuotaWeekMax）、专注里没在做事：一刻钟才叫一次
/** 额度紧时专注空转叫她的那句：还在专注 + 额度紧、挑省额度的轻活（不带找事做、升级、想干等那几句） */
const focusTightText = (used: number): string => `${P.FOCUS_CONTINUE}\n${P.focusQuotaTight(used, FOCUS_TIGHT_GAP_MS / 60_000)}`;
const UNSENT_HINT_GAP_MS = 3_600_000;       // 「那段话没发给任何人」一小时最多说一次（专注里几乎每轮都有话收尾）
const LONG_TURN_MS = 5 * 60_000;            // 前台一轮做了这么久还没完：提醒她交给一边做，好回消息
const WORK_LOOKBACK_MS = 15 * 60_000;        // 「刚碰过的」往回看多久
const HANDOVER_BURST_MS = 3 * 60_000;        // 连着贴稿子：这么久里发给主人的字加起来算
const WORD_HOLD_MS = 10 * 60_000;            // 词表拦下的那句：这么久里原样再发照发（#0015）
const ALIAS_ERRORS_MAX = 20;                 // 查库里名字出错：最多记这么多种不同的错（每种一次 warn）
const BLOCK_MAX_CHARS = 20_000;
/** wakeMain 的选项（各项见 wakeMain 的说明） */
/** A conversation's key: channel and target */
const convKey = (r: Inbound["replyTo"]): string => (r ? `${r.channel}:${r.target}` : "");

type WakeOpts = { human?: boolean; urgent?: string; replyTo?: Inbound["replyTo"]; record?: () => void; humanCtx?: HumanContext; cue?: string; noInterject?: boolean; leisure?: boolean; conv?: string; who?: string; rerun?: () => void; gate?: boolean; cause?: WakeCause; resumed?: boolean; shownText?: string; shownUnsentText?: string; recordedSeq?: number; lastUnsent?: boolean; pendingId?: string };
const HOLD_MAX_MS = 20_000;                // 真人的消息最多等主线这一轮多久，超过就打断
const PARALLEL_EVERY_MS = 30 * 60_000;     // 「同时在做」没变时隔多久再给一次（和负载、目标一样）
const COMPACT_ITEM_CHARS = 8_000;
const FORK_TIMEOUT_MS = 8 * 60_000;        // 分叉压缩最多等多久，超了退回海马
/** 分叉压出来的稿至少多长（短了多半是被拦了一半、写了句话就停），不然退回海马：按这一页的大小，每 200 token 至少 1 个字，夹在 200–1500 字之间 */
const forkMinChars = (pageTokens: number): number => Math.max(200, Math.min(1_500, Math.round(pageTokens / 200)));
/** The line that opens or closes a stretch of rendered memory (the tag is M.central.tag) */
export const memoryTagLine = (): RegExp => new RegExp(`^<\\/?${M.central.tag}>`);
/** A final reply that is meant for nobody: NO_REPLY, or the words that say the role only wants to wait (B.forms.focusWaitSaid) */
export const meantForNobody = (): RegExp => new RegExp(`\\bNO_REPLY\\b|${B.forms.focusWaitSaid.source}`);
/** 渲染好的一段记忆里第一行经历（去掉 <记忆> 抬头和时间标记），取开头 30 字：告诉分叉这一页从哪一行开始 */
const seenLine = (rendered: string): string | null => {
  const tagLine = memoryTagLine();
  const line = rendered.split("\n").find((l) => l.trim() && !tagLine.test(l) && !B.forms.memoryIntroHead.test(l));
  return line ? line.replace(/^〔[^〕]*〕/, "").replace(/\s+/g, " ").trim().slice(0, 30) || null : null;
};
const VIEW_K_KEY = "pageViewK";           // 「她眼前这一页」估算的校准倍数 {k, n}：主线真实上下文涨幅 ÷ 估算涨幅（重启接着用）
const VIEW_K_MIN_GROWTH = 20_000;         // 估算至少涨这么多才算一次（窗口太小噪声大）
const VIEW_K_ALPHA = 0.3;                 // 新的一次占多少（平滑）
const VIEW_K_MIN = 1, VIEW_K_MAX = 5;     // 倍数的范围；单次超过上限的当异常（一下读了好多图之类），不算。11-05 下午回放：正常的一次在 3.0–4.4 之间
const FORK_WAY_OVER = 1.3;                 // 主线一直忙、页已经大到翻页线的这么多倍：不等了，照旧交给海马
const FORK_CACHE_MISS_TOKENS = 100_000;    // 分叉写进缓存的超过这么多、又比读的多：缓存大半没命中，记一条警告
const LOOK_CHAT_LINES = 12;                // 回头看时带上最近这么多句聊天（她 11-05 升级需求①：别拿人已经改掉的决定来要求）
const LOOK_CHAT_HOURS = 24;
const LOOK_RECORD_CHARS = 80_000;          // 回头看时带上的经过最多这么长（太长只留最后一段）
/** #0031：topic 前 40 字取词——汉字连续段的相邻两字，拉丁/数字取长度≥2 的词（小写） */
export function topicWords(topic: string): Set<string> {
  const out = new Set<string>();
  const s = topic.slice(0, 40);
  for (const run of s.match(/[\u4e00-\u9fff]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  for (const w of s.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/g) ?? []) if (w.length >= 2) out.add(w);
  return out;
}

const LOOKING_KEY = "looking";             // 正在回头看的事（重启后接着看）
/** 是什么叫醒了主线（main wake 日志里的 cause；hh numbers 按它分类） */
export type WakeCause = "human" | "message" | "gate" | "senses" | "helper" | "reminder" | "focus" | "task" | "wander" | "side" | "insight" | "subconscious" | "wake-up" | "manual" | "other";
const RELAY_SEEN_KEY = "relaySeen";       // 最近交进来的消息（渠道:编号，留最近 500 条）：relay-spool 补交、重复投递时去重
const RELAY_SEEN_MAX = 500;
const HELPERS_KEY = "helpersBusy";         // 还在跑的帮手：{名字: 派出去的时间}（重启也记得，没交回的事不算做完）
const HELPERS_ASKED_KEY = "helpersAsked";  // 挂了一天多、已经问过她清不清的帮手：{名字: 问的是哪一次派的（派出去的时间）}（重启不再问）
/** 说了做完（或卡住了）、正等着回头看的：记成什么状态、卡在什么上；retried：看的会话没给结论、已经换过一次会话 */
type Pending = { state: "done" | "follow" | "stuck"; on?: string; retried?: boolean };
/** 干活时在后台算的那次联想：算完带文字、完成时刻，有页时带 confirm（贴的那一刻调，才记成挂过） */
type MidworkJob = { taskId: number | null; text?: string; doneAt?: number; confirm?: () => { text: string } };
/** 把关交的一条结论（checked 工具的 verdicts） */
type CheckVerdict = { i: number; verdict: "add" | "merge" | "reject"; into?: string; text?: string; why: string };
const CHECK_PAGE_CHARS = 20_000;           // 把关时一页最多贴这么多字（太长的叫它自己打开看）
const CHECK_PAGES_CHARS = 100_000;         // 一次把关贴的页加起来最多这么多字
const CONTINUE_GAP_MS = 1_000;            // 后台一轮停了、事没做完，隔这么久叫它接着做
const URGENT_RETRY_MS = 60_000;           // 记了急事、说话的那头这会儿叫不了（翻页、睡着）：隔这么久再试
const SENSE_SEEN_KEY = "sense-seen";
const CALIB_DAY_KEY = "calib-day";         // 准头哪天提过了（一天一次）
const PAUSED_KEY = "paused-overnight";
const REPAIR_NOTE_DAY_KEY = "repair-note-day";   // 早上的修理小结一天提一次
const REPAIR_NOTE_TOLD_KEY = "repair-note-told"; // 提到哪条记录为止
const DEEP_QUEUE_KEY = "deep-queue";        // 放着慢慢想的事（排着队）
const DEEP_CURRENT_KEY = "deep-current";    // 下意识正在想的那件
const DEEP_STARTED_KEY = "deep-started";    // 那件从什么时候开始想
const DEEP_MAX_MS = 60 * 60_000;            // 一件最多想一小时
const DEEP_MAX_TURNS = 30;                  // 最多想 30 轮     // 睡觉时放下的事，第二天第一次叫醒前台时提一次
const SENSE_SEEN_MAX = 500;         // 压缩 / 睡眠整理时，单条记录给海马看多少字
const MAIN_STOP_ROTATE_MAX = 3;             // ④ 主线被停过就换新会话：这段时间里最多换这么多次，再停就留给翻页（换了还停，毛病不在会话历史里）
const MAIN_STOP_ROTATE_WINDOW_MS = 2 * 3_600_000;
const ROTATE_QUIET_MS = 3_000;            // 换班前要安静这么久（防止把正在处理的消息丢掉）
const RETRY_BASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const DEEP_RETRY_MS = 10 * 60_000;       // 慢慢想的那头开不起来：排着的隔这么久再试（不每次 tick 都试、刷日志）
const TURN_COOLDOWN_MS = 10 * 60_000;     // 翻页彻底失败后，隔一阵再试
const TURNING_WATCHDOG_MS = 20 * 60_000;
const SLEEP_WATCHDOG_MS = 100 * 60_000;   // 一次整理（一天）最多这么久；整理指南给的上限是 90 分钟
const FLOW_WATCHDOG_GRACE_MS = 60 * 60_000;   // 分段整理：引擎的整夜看门狗（sleep.watchdogHours）到点后还收不了尾，再等这么久就醒
const NIGHT_STOP_WAIT_MS = 10_000;        // 停机时等夜里引擎收尾（撤回这一天、记账）最多这么久
const NIGHT_MAX_DAYS = 3;                 // 一夜最多补整理几天（积压的）：sleep.nightMaxDays 没写时的默认
const REGISTRY_APPROVED_KEY = "registry_approved";   // 主人批过的权限字段底子
const REGISTRY_CHANGES_KEY = "registry_changes";     // 名单/工具变动记录 [{ts,line}]
const REGISTRY_CAPPED_KEY = "registry_capped";       // 上次装名单时被裁的 key.field（只报新出现的）
const WORK_KEY = "workBlock";             // 正在进行的专注（上班）：{until, why}；重启也接得上
const QUOTA_KEY = "quota";                // 额度最近一次读数和档位（重启后不重复提醒）
const SPEND_KEY = "spend";                // what the regions on other providers spent, by provider and day (src/providers.ts)
const QUOTA_POLL_MS = 10 * 60_000;

/** What someone at this computer is told when the turn answering them failed: why and what to do (error: the kernel's, api_error:<code>) */
export function turnFailedText(error: string | undefined): string {
  const why = (error ?? "").replace(/^api_error:/, "") || "unknown";
  if (/^(authentication_failed|oauth_org_not_allowed|account_on_hold|verification_required|cloud_credential_error)$/.test(why)) return B.brain.turnFailedLogin(why);
  if (why === "rate_limit" || why === "billing_error") return B.brain.turnFailedLimit(why);
  if (why === "overloaded" || why === "server_error") return B.brain.turnFailedBusy(why);
  return B.brain.turnFailedOther(why);
}        // 醒着时多久主动问一次额度
const PENDING_KEY = "pendingHuman";       // 还没回完的真人消息（重启时接着处理，不丢）：[{id, ev, delivered}]
const PENDING_MAX_AGE_MS = 2 * 3600_000;
const GATE_DIGEST_DAY_KEY = "gate_digest_day";    // 每日总结哪天做过（本地日期）
const GATE_DIGEST_LAST_KEY = "gate_digest_last_ts";   // 上次总结到哪（毫秒），下次从这里接
const GATE_DIGEST_NOMINEES_KEY = "gate_digest_nominees";   // 上次总结里提名的会话和条数
const NIGHT_GAP_KEY = "nightGap";         // 最近那一夜在中央记忆里占的那一截 {after, upTo, done}：睡下就记 after，醒来（或半路停了、再启动时）收上 upTo；done = 那一夜整理好了。之后新会话的开场跳过它（#0054）
const NIGHT_KEY = "lastNight";            // 哪一夜已经睡过（nightOf 的日期）：开始睡就记，整理失败也不会一夜反复睡
const GATE_PENDING_KEY = "gatePending";   // 闸门交来、还没记进记忆的（压着等这一轮、睡着时判出来的）：[{id, items}]，醒来、重启接着送
const GATE_CUE_CHARS = 200;               // 闸门叫醒拿去联想的话题最多多长
const GATE_WAKES_KEY = "gate_main_wakes";  // 闸门叫醒主意识的次数，按本地日期：{ "2026-11-03": 5 }，留 14 天（观察日看）
/** 她看得到的「来源」（也是「按X显示名认的」里的 X）：不给她看内部的 src 名（final review M8）；没名字的显示原名 */
const srcName = (src: string, labels: Record<string, string> | undefined): string => {
  const v = labels && Object.hasOwn(labels, src) ? labels[src] : undefined;
  return typeof v === "string" && v ? v : ({ "hh-quota": B.brain.sourceNameQuota, plain: B.brain.sourceNamePlain } as Record<string, string>)[src] ?? src;
};
/** 事件里写给她的办法（do）去掉「…ack」那句：HH 接手时已经确认过了 */
function withoutAck(d: string): string {
  return d.split(/(?<=[。；，;,])/).filter((x) => !/\back\b/i.test(x)).join("").replace(/[，,；;\s]+$/, "").trim();
}
/** 原文开头的「- [src id=…]」 */
const SENSE_HEAD = /^- \[[\w-]+ id=[^\]\s]+\] ?/;
/** 有人找她的那条闸门叫醒按谁算「同一件事」：像真人消息按会话（final review M2） */
const gateConvKey = (d: Delivery): string => `gate:${d.ev.src}:${d.ev.conv ?? d.ev.sender ?? d.ev.id}`;
/** 在等她回的是谁：核实过的人名；按显示名认的、没认出来的写会话名（显示名谁都能起，不说成是那个人） */
const gateWho = (d: Delivery, labels: Record<string, string> | undefined): string => (d.who && !d.who.byDisplayName ? d.who.name : d.ev.conv ?? d.ev.sender ?? d.who?.name ?? srcName(d.ev.src, labels));

/** via：fork = 分叉主线会话压缩（整页按缓存价读）；hippocampus = 新开海马压缩（以前的做法，分叉不成时退回这条） */
interface PageTurn { cutSeq: number; attempts: number; since: number; refRetried?: boolean; via: "fork" | "hippocampus" }
/** 闸门交来、还没送到她面前的一次叫醒（见 Brain.gateOpen） */
interface GateBatch { id: string; items: Delivery[]; key: string | null; waking: boolean; rerun: () => void }
interface Sleeping {
  reason: string; kind: SleepKind | "manual"; attempts: number; since: number; days: number; firstPending: string | null;
  /** 这一夜谁整理：legacy = 海马一个会话（askHippocampusToOrganize）；flow = 分段的引擎（flow.json，sleep/runner.ts）；team = 专员 + 领导（sleep/teamrun.ts） */ engine: "legacy" | "flow" | "team";
  /** 这一天已经叫她接着做过一次 */ nudged: boolean;
  /** 这一夜整理完、学习收尾还没做最后一步（回测、每周数字）的那天：后面那天整理不成放弃时补上 */ learnDay: string | null;
  /** 分段整理：已经在醒了（这一夜自己的收尾和兜底的看门狗撞上时只醒一次） */ waking?: boolean;
  /** 「去睡觉了」那条记录的编号：之后到醒来写进中央记忆的，是这一觉里的（#0054） */ fromSeq?: number;
}

export interface BrainStatus {
  alertness: Alertness;
  epoch: number;
  pageTokens: number;
  /** 这一页在主线眼前有多大（翻页看这个）：估算 × 校准倍数 */
  pageView: number;
  /** 没校准的估算，和校准倍数（主线真实上下文涨幅 ÷ 估算涨幅） */
  pageViewRaw: number;
  pageViewK: number;
  compactedTokens: number;
  focusSlot: string | null;
  focusUntil: string | null;
  turning: boolean;
  /** 前台闲着：没在回话、没在准备叫醒、没压着消息（部署后的重启只在这时候） */
  frontIdle: boolean;
  /** 夜里睡过、还没到早上：夜里放空（消息照常回，不主动做事） */
  nightRest: boolean;
  regions: Array<{ id: string; open: boolean; busy: boolean; contextTokens: number; generation: number; sessionId: string | null }>;
  todos: number;
  quota: string | null;
  /** 额度的数字（百分比）和读到的时间：给 quota.sh 读，不用再起 openclaw status */
  quotaUsed: { fiveHour: number | null; sevenDay: number | null; fiveHourResetsAt: number | null; sevenDayResetsAt: number | null; at: number | null };
  /** Each configured provider's 7-day spend and its weekUsd, in USD; absent when no provider is configured */
  spend?: Record<string, { week: number; weekUsd: number }>;
  claims: Array<{ topic: string; owner: string }>;
  /** 闸门今天（本地日历日）的账，mainWakes 是今天闸门叫醒主意识几次；闸门没开是 null */
  gate: (GateStats & { mainWakes: number }) | null;
  /** 她的规则文件（senses/gate.json）的问题：坏了的、被跳过的规则 */
  rulesErrors: string[];
  /** 名单和工具最近 14 天的变动（新的在前，最多 30 条）：总结默认关着，主人在这里看（final review I4） */
  registryChanges: string[];
}

// ---------- 退役的文件：谁写都拦下，说记到哪 ----------
// 规矩是这个角色的数据（实例配置 memory.retiredFiles），框架默认没有。Write/Edit 和 Bash 写它们都拦，说的是同一句；海马（夜里整理）的话和别的脑区不同。
// whenExists / whenMissing：从什么时候起拦（工作区里某个文件在 / 不在，每次调用都看）；都没有就一直拦。
/** 人物卡切过去的开关文件（实例配置 memory.peopleSwitchFile，相对工作区）：空 = 没有这回事（人物卡一直算切过去了）。退役文件的拦、hhd 给事件记忆的 peopleActive、回放都认它 */
export function peopleSwitchFileOf(cfg: Pick<Config, "memory">): string {
  return cfg.memory?.peopleSwitchFile ?? "";
}
type RetiredFile = { path: RegExp; whenExists?: string; whenMissing?: string; hippocampus: string; other: string };
/** 配置里的退役文件 → 编好的正则；正则编不过的那条跳过（记一笔） */
function retiredFilesOf(cfg: Pick<Config, "memory">, log: Logger): RetiredFile[] {
  const out: RetiredFile[] = [];
  for (const f of cfg.memory?.retiredFiles ?? []) {
    try { out.push({ ...f, path: new RegExp(f.path) }); } catch (e) { log.warn("retired file rule skipped: bad regex", { path: f.path, error: String(e).slice(0, 200) }); }
  }
  return out;
}
/** 认出东西一次最多附几件 */
const RECOGNIZE_MAX = 2;
/** 认出来以后多久内附上才算数：再晚就和手上的事不相干了，丢掉（下次碰到再认） */
const RECOGNIZE_FRESH_MS = 30 * 60_000;
/** 这些工具的结果本来就是她的记忆，不拿去认 */
const RECOGNIZE_SKIP_TOOLS = new Set(["like", "my_likes", "remember", "recall_event", "recall_period", "recall_person", "recall"]);
/** 其中这几个的结果里写到的事，算她这一下自己刚碰过（这个前缀里不再提）；my_likes 列的是全部，不算 */
const RECOGNIZE_SEEN_TOOLS = new Set(["like", "remember", "recall_event", "recall_period", "recall_person"]);
/** 一段文字里的事件编号 */
const EVENT_IDS = /\be\d{4,}\b/g;

export class Brain {
  readonly cfg: Config;
  readonly central: CentralMemory;
  readonly epochs: Epochs;
  readonly claims: Claims;
  /** 她手上在做的事（估多久、谁在做） */
  readonly tasks: TaskBook;
  private readonly loadTight: () => boolean;
  readonly thalamus: Thalamus;
  readonly schedule: Schedule;
  readonly regions = new Map<string, Region>();
  private readonly db: Db;
  private readonly driver: KernelDriver;
  private persona: Persona;
  private readonly reloadPersona: (() => Persona) | undefined;
  private readonly log: Logger;
  private readonly run: Runner;
  private readonly now: () => number;
  private readonly later: (fn: () => void, ms: number) => void | (() => void);
  private readonly fileExists: (path: string) => boolean;
  private readonly readText: (path: string) => string | null;
  private readonly sleepFs: MiniFs;
  /**
   * 夜里分段整理正在跑的这一夜（没跑是 null）：learn_check 的结论交回发起它的那一段；停机、兜底看门狗叫停 runner、关会话。
   * notes：各天报告最上面要加的几行（把关结论回来时那一段已经关了）
   */
  private night: { hosts: NightHosts; runner: SleepRunner; notes: Map<string, string[]>; budget: Budget; weights: Weights } | null = null;
  /** hh sleep replay：同时只有一个回放（sleep/replay.ts），后台跑 */
  private readonly replays = new ReplayManager();
  /** 有回放在跑（部署后的重启等它跑完：hhd 的 tick 看这个） */
  get replayRunning(): boolean { return this.replays.holdsRestart(this.now(), this.cfg.sleep.watchdogHours * 3_600_000 + 30 * 60_000); }
  /** 这一夜引擎那一整段（flowNight）：停机时等它收个尾（有上限） */
  private nightDone: Promise<void> | null = null;
  /** 停机了：引擎收完尾不再叫醒她 */
  private stopping = false;
  private people: People;
  private readonly registryFile: BrainDeps["registryFile"];
  private registryMtime: number | null = null;
  /** 主线这一轮是被谁的消息叫起来的：这一轮的最终回复发回给他（跟 OpenClaw 一样；写 NO_REPLY 就不发） */
  private mainReplyTo: Inbound["replyTo"] = undefined;
  /** 送进主线的每条消息是谁的（编号 → 回给谁，内部唤醒是 undefined）；内核报 answering 时据此定这一轮回给谁 */
  private readonly mainWakeTo = new Map<string, Inbound["replyTo"]>();
  /** 这一轮在回谁：内核报过 answering 才有。没有 = 内核自己开的一轮（后台任务交回），不回谁 */
  private mainTurn: { to: Inbound["replyTo"] } | null = null;
  /** The last wake of each person's message to the main region (by conversation): handed over again if the turn answering it is stopped */
  private personWakes = new Map<string, { text: string; opts: WakeOpts }>();
  /** 这个进程起来以后最早几轮的成败（部署后看这一版能不能跑完一轮，repair/restart.ts HealthMark） */
  private readonly turnLog: Array<{ ok: boolean; error?: string }> = [];
  /** 内核报过 answering 没有（老内核不报，就还按 mainReplyTo） */
  private answeringSeen = false;
  private readonly plugins: string[];
  private readonly gateway: GatewayCaller | undefined;
  private readonly send: Send;
  readonly browser: Chrome | undefined;
  private readonly bubbleGapMs: () => number;
  private readonly bubbleWait: (ms: number) => Promise<void>;
  private readonly situation: Situation | undefined;
  private readonly modules: Modules | undefined;
  private readonly refreshSkills: (() => void) | undefined;
  readonly mem: EventMemory | undefined;
  /** 认出东西：她自己碰到挂在喜欢 / 烦的事上的东西时提一句（没有事件记忆就没有） */
  private readonly recognizer: Recognizer | null;
  readonly learning: LearningRuntime | undefined;
  /** 潜意识门（11-03）：开着、又没配下意识（regions.perception 空）时，感官事件都先过它；没有就是老路 */
  readonly gate: Gate | undefined;
  private readonly gateRules: Rules | undefined;
  // 退役文件的规矩（实例配置 memory.retiredFiles），第一次用到时编好
  private retiredFiles: RetiredFile[] | undefined;
  private prefixBuilds = 0;
  /** 正在为主线准备情境（几毫秒到几秒）：这期间算主线忙，别的事先排队 */
  private mainPreparing = 0;
  private outbox: Promise<void> = Promise.resolve();
  /** 最终回复正在一条条发、还没发出去的那几条（按目标的 targetKey）：「最近说过的话」里带上、标「正在发」（#0051） */
  private inflight = new Map<string, Said[]>();
  /** 主线正在说的这一轮之外、等着的事（别的人的消息、自己心里的事）；这一轮完了按顺序处理 */
  /** run 返回 false = 这次什么也没交给说话的那头（比如急事到时候再看，发现它都看过了）；不返回（void）算交了 */
  private readonly heldForMain: Array<{ human: boolean; conv: string; run: () => boolean | void }> = [];
  /**
   * 她这一轮还在忙时同一个人又来的话（按会话；每人一份，后来的接在后面）：已经记下了，叫醒压在 heldForMain 里等这一轮结束。
   * seqs：这几条的记录编号；text / opts：最后一条的叫醒（叫醒时 <记忆> 一次带上没给她看过的全部）
   */
  private readonly mergedHeld = new Map<string, { seqs: number[]; pendingIds: string[]; lastUnsent?: boolean; text: string; opts: WakeOpts; held: { human: boolean; conv: string; run: () => boolean | void } }>();
  /** 这一轮送进去的、闸门交来的有人找她（gateConvKey）：同一个人再来的并进这一轮；她在回人，别的消息等久了也不打断这一轮 */
  private readonly mainGateConvs = new Set<string>();
  /** 主线这一轮写的话（和它在中央记忆的编号），还不知道是不是最后的回复（后面又调了工具就是中途的自言自语，不发） */
  private pendingSays: Array<{ text: string; seq: number }> = [];
  /** 一心多用时，每份心思手上在做的事（标签用） */

  private epoch!: Epoch;
  private prefix = "";
  alertness: Alertness = "awake";
  private lastActivity = 0;
  private turn: PageTurn | null = null;
  /** 这一页「等主线这一轮结束再分叉」已经记过日志了（每页只记一次） */
  private forkWaitLogged: number | null = null;
  /** 这一页分叉超时过：剩下的这一页不再试分叉，直接交给海马（复核 #5） */
  private forkOffEpoch: number | null = null;
  /** 「她眼前这一页」的校准（估算把汉字算 1.1 个 token、挂页图片不在 central 里，实际约 1.6 倍） */
  private viewK = { k: 1, n: 0 };
  private viewAnchor: { epoch: number; generation: number; session: string; raw: number; ctx: number } | null = null;
  private turnCooldownUntil = 0;
  private sleeping: Sleeping | null = null;
  private pendingSleep: { reason: string; kind: SleepKind | "manual" } | null = null;
  private focusTimer = 0;                 // 只认最新的一个专注定时器
  private mainActed = false;              // 主线这一轮调过工具没有
  private focusIdle = 0;                  // 专注里连着几轮没做事（没调工具；回人的那几轮不算）
  private focusRecent: boolean[] = [];    // 最近 FOCUS_RECENT 个专注轮，true = 空轮（没调工具）
  private focusWaiting = false;           // 她说了想干等：一分钟叫一次，动手以后照常
  private focusParked = false;            // 专注里她的后台正在一轮里干活：不叫主线，那一轮结束再看
  private focusParkedSince = 0;
  private taskTimer = 0;                  // only the latest call back to main's own task counts
  private taskIdle = false;               // main's last turn outside focus did nothing
  private taskWaiting = false;            // it said it only wants to wait: called once a minute, as in focus
  private taskCut = false;                // its turn on the task was interrupted for a waiting message
  private mainApiError = false;
  private mainTurnStartedAt = 0;          // 前台这一轮从什么时候开始（0 = 没在跑）
  private mainLongNudged = false;         // 这一轮做太久的提醒给过没有
  private unsentReply = false;            // 有一轮最后写的话没人收，之后自己醒的那一轮告诉她
  private unsentHintAt = -Infinity;       // 上次告诉她的时刻
  /** 前台这一轮在忙时来消息、在等她回的人（并进这一轮的、压着的）：下一次工具调用后提醒一次 */
  private mainWaiting: Array<{ conv: string; who: string; nudged: boolean }> = [];           // 主线上一轮因为 API 报错失败（被拦、额度没了）：专注隔一分钟再叫，不每秒去撞
  private work: { until: number; why: string } | null = null;   // 排出来的专注（她自己或主人）
  private lastFocusSlotKey: string | null = null;
  private lastWander = 0;
  private lastQuotaPoll = 0;
  /** the last quota poll said this login has no plan limits (pollQuota) */
  private noPlan = false;

  constructor(deps: BrainDeps) {
    this.folds = new PromptFolds(deps.cfg.memory?.promptFolds ?? [], deps.cfg.schedule.timezone);
    this.cfg = deps.cfg;
    this.db = deps.db;
    this.driver = deps.driver;
    this.persona = deps.persona;
    this.reloadPersona = deps.reloadPersona;
    this.log = deps.log;
    this.run = deps.run ?? runProcess;
    this.now = deps.now ?? Date.now;
    this.later = deps.later ?? ((fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return () => clearTimeout(h); });
    this.fileExists = deps.fileExists ?? existsSync;
    this.readText = deps.readText ?? ((p) => { try { return readFileSync(p, "utf8"); } catch { return null; } });
    this.sleepFs = deps.sleepFs ?? nodeFs(this.cfg.workspace);
    this.people = deps.people ?? new People({});
    this.registryFile = deps.registryFile;
    this.plugins = deps.plugins ?? [];
    this.gateway = deps.gateway;
    this.send = deps.send;
    this.browser = deps.browser;
    this.bubbleGapMs = deps.bubbleGapMs ?? (() => 700 + Math.random() * 900);   // 像人打字一样隔一下
    this.bubbleWait = deps.bubbleWait ?? sleep;
    this.situation = deps.situation;
    this.modules = deps.modules;
    this.loadTight = deps.loadTight ?? (() => false);
    this.refreshSkills = deps.refreshSkills;
    this.mem = deps.mem;
    this.recognizer = deps.mem ? new Recognizer(deps.mem.store.db, this.cfg.schedule.timezone) : null;
    this.central = new CentralMemory(this.db, this.now);
    this.epochs = new Epochs(this.db, this.now);
    this.claims = new Claims(this.db, this.now);
    this.tasks = new TaskBook(this.db, this.now);
    this.thalamus = new Thalamus(this.db, this.now);
    this.schedule = new Schedule(this.db);
    this.learning = deps.learning;
    // 情境在外面建：笔记联想、主人的纠正（记进库、挂在主线手上那件事上）从这里接上
    if (this.learning) {
      this.situation?.attachNotes(this.learning.notes, {
        db: this.db,
        threshold: this.cfg.learning.threshold,
        // 主线手上没事时取最近开始的那件（交给一边做着的也是她手上的事）
        currentTask: () => { const t = this.tasks.doing("main")[0] ?? this.tasks.doing().at(-1); return t ? { id: t.id, topic: t.topic } : null; },
      });
    }
    // 闸门：配了 regions.perception 就是回滚到老路（下意识先看）。它的出口要用到脑区，start() 里建好脑区以后才 recover
    const mtime = deps.mtime ?? ((p: string) => { try { return statSync(p).mtimeMs; } catch { return null; } });
    const words = this.cfg.tools.wordListFile;
    this.wordList = new WordList({ path: words ? join(this.cfg.workspace, words) : null, read: this.readText, mtime, log: this.log });
    if (this.cfg.gate.enabled && this.cfg.regions.perception.length === 0) {
      const log = this.log.child("gate");
      // 默认标准空着（框架的 default.json 不带人格的话）= 闸门自带的那句：没写 want 的规则、主人在群里没 @ 她那条（gate.ts 的 judge-floor）都用它
      const gateCfg = this.cfg.gate.defaultWant?.trim() ? this.cfg.gate : { ...this.cfg.gate, defaultWant: defaultWant() };
      this.gateRules = new Rules({ path: join(this.cfg.workspace, this.cfg.gate.rulesFile), readFile: this.readText, mtime, log, defaultWant: gateCfg.defaultWant });
      this.gate = new Gate({
        db: this.db, cfg: gateCfg, names: this.cfg.names, sources: sourcesOf(this.cfg), people: () => this.currentPeople(), rules: this.gateRules,
        judge: (items, context) => this.judgeSenses(items, context),
        // 这周额度到了并行的把关线：小判断也停，本该判的直达（宁可吵）
        paused: () => ((this.quotaState().sevenDay?.used ?? 0) >= this.cfg.parallel.quotaWeekMax ? B.brain.parallelPausedWeekQuota : null),
        sinks: { toMain: (items) => this.gateToMain(items), toHands: (ev) => this.gateToHands(ev) },
        now: this.now, log, weights: sleepWeights(this.cfg.sleep.weights),   // 缺项用默认补齐（不然 units() 得 NaN）
      });
    }
  }

  /** 批准底子的状态：没有 / 坏了 / 好的 */
  private baselineState(): { kind: "ok"; base: Record<string, Record<string, unknown>> } | { kind: "absent" } | { kind: "corrupt" } {
    const v = kvGet(this.db, REGISTRY_APPROVED_KEY);
    if (v === undefined) return { kind: "absent" };
    try {
      const base = JSON.parse(v) as unknown;
      if (typeof base !== "object" || base === null || Array.isArray(base)) return { kind: "corrupt" };
      return { kind: "ok", base: base as Record<string, Record<string, unknown>> };
    } catch { return { kind: "corrupt" }; }
  }

  /** 认人时也按事件库里那个人的名字、别名认（#0042，只用来分流，认不出主人）：开着事件记忆才有；索引一分钟一换（按 Brain 的钟），她新加的别名不用重载名单就生效 */
  private aliasKey(): AliasKey | undefined {
    const db = this.mem?.store.db;
    if (!db) return undefined;
    return (name) => {
      if (!name.trim()) return null;
      try {
        return aliasLookup(db, this.now())(name);
      } catch (e) {
        // 查库出错（没有这张表不算错）：认不出、分流照常；同一个错只记一次 warn，不然 #0042 悄悄关了也没人知道（final-review N3）
        const error = e instanceof Error ? e.message : String(e);
        if (!this.aliasErrors.has(error) && this.aliasErrors.size < ALIAS_ERRORS_MAX) {
          this.aliasErrors.add(error);
          this.log.warn("people: memory name lookup failed, names from memory not recognized", { error: error.slice(0, 200) });
        }
        return null;
      }
    };
  }
  /** 查库里名字出过的错（每个只记一次 warn） */
  private readonly aliasErrors = new Set<string>();

  /** 读不动名单时的保底：名单里除了底子里的主人，谁都按访客上限；连底子都没有就全按访客上限 */
  private failClosedPeople(): void {
    try {
      const st = this.baselineState();
      this.people = People.from(this.people.registry, st.kind === "ok" ? st.base : {}, this.aliasKey());
    } catch { this.people = new People({}); }
  }

  private peopleFromFile = false;
  private peopleFailWarned: string | null = null;

  /** 重读名单并按底子裁权限；返回被裁掉的字段（"key.field"），同时写日志和每日总结要读的变更记录。
   *  读不动、内容坏了就保留当前名单（同一个 mtime 只警告一次，不反复重试） */
  reloadPeople(): string[] {
    if (!this.registryFile) return [];
    let m: number | null = null;
    try { m = this.registryFile.mtime(); } catch { m = null; }
    this.registryMtime = m;   // 不管成败都记下，同一版文件不重复处理
    const fail = (what: string, e?: unknown): string[] => {
      const mark = `${what}@${m}`;
      if (this.peopleFailWarned !== mark) this.log.warn(`people: ${what}, keeping current`, { error: e === undefined ? "" : String(e).slice(0, 200) });
      this.peopleFailWarned = mark;
      return [];
    };
    try {
      const raw = this.registryFile.read();
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("registry is not an object");
      let st = this.baselineState();
      if (st.kind !== "ok") {
        // 第一次（上线那一刻的现状算批过的）或底子坏了：按现在的文件重新记
        const base = approvedFrom(raw);
        if (st.kind === "corrupt") {
          this.log.error("people: approved baseline corrupt, re-seeded from current file", {});
          this.noteRegistryChange(B.brain.peopleBaselineReseeded);
        }
        kvSet(this.db, REGISTRY_APPROVED_KEY, JSON.stringify(base));
        st = { kind: "ok", base };
      }
      // ruling 38 上线后第一次：升过权的人底子里还没记号和显示名，按现在的文件记一次（之后多出来的就要 approve）
      const stored = storeMissingIdentity(st.base, raw);
      if (stored.length) {
        kvSet(this.db, REGISTRY_APPROVED_KEY, JSON.stringify(st.base));
        this.log.info("people: stored approved identity for elevated persons (once)", { keys: stored });
      }
      const next = People.from(raw, st.base, this.aliasKey());
      this.people = next;
      this.peopleFromFile = true;
      this.peopleFailWarned = null;
      if (next.issues.length) this.log.warn("people: registry has malformed fields", { issues: next.issues });
      const dropped = next.dropped.map((d) => `${d.key}.${d.field}`);
      // 升过权的人多出来的号、显示名照写出来（主人看总结时要知道多的是哪个号）
      const ids = next.unapproved.flatMap((u) => u.ids.map((i) => `${u.key} ${i}`));
      // 只记新出现的（一直被裁着的不每次重启都再报）
      let prev: string[] = [];
      try { prev = JSON.parse(kvGet(this.db, REGISTRY_CAPPED_KEY) ?? "[]") as string[]; } catch { prev = []; }
      const fresh = [...dropped, ...ids].filter((d) => !prev.includes(d));
      kvSet(this.db, REGISTRY_CAPPED_KEY, JSON.stringify([...dropped, ...ids]));
      if (fresh.length) {
        const fd = dropped.filter((d) => fresh.includes(d));
        const fi = ids.filter((d) => fresh.includes(d));
        this.log.warn("people: permissions above the guest cap were dropped", { dropped: fd, unapprovedIds: fi });
        const parts = [
          ...(fd.length ? [B.brain.peopleCappedFieldsNote(fd.join(B.brain.peopleCappedFieldsSep))] : []),
          ...(fi.length ? [B.brain.peopleUnapprovedIdsNote(fi.join(B.brain.peopleUnapprovedIdsSep))] : []),
        ];
        this.noteRegistryChange(B.brain.peopleListChangedNote(parts.join(B.common.listSep)));
      }
      return dropped;
    } catch (e) { return fail(m === null ? "registry file missing or unreadable" : "registry unusable", e); }
  }

  /** 当前名单：文件 mtime 变了先重载。闸门每次处理都用它，任何情况下都不抛 */
  currentPeople(): People {
    if (this.registryFile) {
      let m: number | null = null;
      try { m = this.registryFile.mtime(); } catch { m = null; }
      if (m !== this.registryMtime) this.reloadPeople();
    }
    return this.people;
  }

  /** 主人批准：把这个人当前文件里的权限字段写进底子（主人整条），再重载。不能凭空批出新主人 */
  approvePerson(key: string): Record<string, unknown> {
    if (!this.registryFile) throw new Error(B.brain.peopleApproveNoFile);
    const st = this.baselineState();
    if (st.kind !== "ok") throw new Error(B.brain.peopleApproveBaselineUnreadable);
    const raw = this.registryFile.read();
    if (typeof raw !== "object" || raw === null || !Object.hasOwn(raw, key)) throw new Error(B.brain.peopleApproveNotInList(key));
    const entry = (raw as Record<string, unknown>)[key];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(B.brain.peopleApproveEntryMalformed(key));
    const wasOwner = Object.hasOwn(st.base, key) && st.base[key]!.privacy === "owner";
    if ((entry as Record<string, unknown>).privacy === "owner" && !wasOwner) throw new Error(B.brain.peopleApproveNewOwnerRefused(key, REGISTRY_APPROVED_KEY));
    // 主人整条照文件抄：文件里不是 owner 了就不批（不能顺手把主人降级），见 final review M5
    if (wasOwner && (entry as Record<string, unknown>).privacy !== "owner") throw new Error(B.brain.peopleApproveOwnerDemoteRefused(key, REGISTRY_APPROVED_KEY));
    const oldBase = Object.hasOwn(st.base, key) ? st.base[key]! : {};
    // 升过权的连现在的号和显示名一起记（ruling 38）：之后再多出来的还要再批
    const fields = approvedFrom({ [key]: entry })[key]!;
    st.base[key] = fields;
    kvSet(this.db, REGISTRY_APPROVED_KEY, JSON.stringify(st.base));
    const perms = Object.keys(fields).filter((f) => f !== "identity");
    // 主人是整条抄的：照写改了什么（加了哪个号、改了哪个字段），主人看得见，不能悄悄多出号来
    const diff = wasOwner ? changeText(oldBase, fields) : [];
    this.noteRegistryChange(wasOwner
      ? B.brain.peopleApprovedOwnerEntry(key, diff.join(B.common.listSep) || B.brain.peopleApprovedNoChange)
      : B.brain.peopleApprovedPerms(key, perms.join(B.brain.peopleApprovedPermsSep) || B.brain.peopleApprovedNoPerms, fields.identity ? B.brain.peopleApprovedIdentityNote : ""));
    this.log.info("people: approved", { key, fields: perms, identity: !!fields.identity });
    this.reloadPeople();
    return fields;
  }

  /** 名单和工具的变动记一笔（留 14 天），每日总结读 */
  noteRegistryChange(line: string): void {
    const cut = this.now() - 14 * 86_400_000;
    let list: Array<{ ts: number; line: string }> = [];
    try { list = JSON.parse(kvGet(this.db, REGISTRY_CHANGES_KEY) ?? "[]") as typeof list; } catch { list = []; }
    list = list.filter((x) => x.ts >= cut);
    list.push({ ts: this.now(), line });
    kvSet(this.db, REGISTRY_CHANGES_KEY, JSON.stringify(list));
  }

  get turning(): boolean { return this.turn !== null; }

  /** What the loop watch notes beside a stall: fields only, no query or scan (status() reads the page and the gate's day) */
  loopState(): { alertness: Alertness; turning: boolean; busy: string[]; replay: boolean } {
    return { alertness: this.alertness, turning: this.turning, busy: [...this.regions.values()].filter((r) => r.busy).map((r) => r.id), replay: this.replayRunning };
  }

  // ---------- 启动 ----------
  start(): void {
    // 名单：按文件和批准底子装一遍（底子第一次在这里种）；装不成就用保底（不留 hhd 传进来的没裁过的那份）
    if (this.registryFile) {
      this.reloadPeople();
      if (!this.peopleFromFile) this.failClosedPeople();
    }
    // 上次夜里整理没收尾（重启、崩溃）：那一跑写进事件库的整批撤回
    const reverted = this.mem?.recoverOpenBatches() ?? [];
    if (reverted.length) this.log.warn("event memory: reverted unfinished batches", { batches: reverted });
    // 名单里的人（别名、person_key）同步进事件库：话里说 Sam、表姐也认得出是谁。要在撤回之后（不然会写在没收尾的那一跑上面）
    try {
      const changed = this.mem?.syncPeople(this.people.registry) ?? [];
      if (changed.length) this.log.info("event memory: people synced from registry", { changed });
    } catch (e) { this.log.warn("event memory: people sync failed", { error: String(e).slice(0, 200) }); }
    this.epoch = this.epochs.current() ?? this.epochs.begin("boot", this.central.lastSeq() + 1);
    // 上次夜里那一觉半路停了（崩溃、重启），那一截还开着：收到现在为止，算没整理好（#0054）
    const openGap = this.storedNightGap();
    if (openGap && openGap.upTo === undefined) this.closeNightGap(openGap.after, false);
    this.rebuildPrefix();
    try { this.work = JSON.parse(kvGet(this.db, WORK_KEY) ?? "null") as typeof this.work; } catch { this.work = null; }
    try {
      const busy = JSON.parse(kvGet(this.db, HELPERS_KEY) ?? "{}") as Record<string, number>;
      // --help 这种根本不是帮手的名字启动时就丢，不然状态栏一直挂着（#0057 后续）；挂得久的不丢，状态栏里问她（freshParallel）
      // where the sessions are is the helpers module's to say (helperSessionsDir): a name like -x that was really sent is kept; module off or no such folder: dropped by name alone
      const sessionsDir = helperSessionsDir(this.cfg);
      const has = sessionsDir && this.fileExists(sessionsDir) ? (n: string) => this.fileExists(join(sessionsDir, `${n}.json`)) : null;
      const ghosts = ghostHelpers(busy, has);
      for (const [k, v] of Object.entries(busy)) if (!ghosts.includes(k)) this.helpersBusy.set(k, v);
      // 问过的先读进来，再为假帮手存一次（不然存的时候把问过的整个写空，重启后又问一遍）
      const asked = JSON.parse(kvGet(this.db, HELPERS_ASKED_KEY) ?? "{}") as Record<string, number>;
      for (const [k, v] of Object.entries(asked)) if (this.helpersBusy.get(k) === v) this.helpersAsked.set(k, v);
      if (ghosts.length) { this.log.info("helpers: ghosts dropped", { ghosts }); this.saveHelpers(); }
    } catch { /* 读不到就当没有 */ }
    try {
      const v = JSON.parse(kvGet(this.db, VIEW_K_KEY) ?? "null") as { k?: unknown; n?: unknown } | null;
      if (v && typeof v.k === "number" && v.k >= VIEW_K_MIN && v.k <= VIEW_K_MAX) this.viewK = { k: v.k, n: typeof v.n === "number" ? v.n : 1 };
    } catch { /* 读不到就从 1 开始重新学 */ }
    this.lastActivity = this.now();
    this.lastWander = this.now();
    const specs = regionSpecs(this.cfg);
    const labeler = (src: string, e?: Entry) => this.labelOf(src, e);
    // 学习这一块夜里给海马的：工作单、把关（没接学习就不给，两个工具自己回笔记本没开）
    const learnNight = this.learnNight();
    // 两档配成同一个模型：side、deep、海马这回没有退路（被拒那一轮直接失败），启动时记一笔
    // byRole 写了、却没有这个角色的脑区（比如闸门开着时没有下意识、sideThreads 是 0）：那一项不起作用，记一笔，别悄悄忽略
    const unused = Object.keys(this.cfg.models.byRole ?? {}).filter((r) => !specs.some((x) => x.role === r));
    if (unused.length) this.log.warn("regions: models.byRole names roles with no region", { roles: unused });
    // 按角色指定了模型以后，几个不对外说话的脑区可能有的带退路、有的不带：没带的都列出来
    const noFallback = specs.filter((x) => x.tier === "opus" && x.outlet === "none" && !this.fallbackOf(x));
    if (noFallback.length) this.log.info("regions: no fallback model", { regions: noFallback.map((x) => x.id), model: this.modelOf(noFallback[0]!), sonnet: this.cfg.models.sonnet });
    // 每个脑区实际用的模型（和退路）记一行：改了 models / byRole、或者看守把代码退回去以后，一眼看得出主线到底在用哪个（11-14 CEO）
    this.log.info("regions: models", Object.fromEntries(specs.map((x) => { const fb = this.fallbackOf(x); return [x.id, fb ? `${this.modelOf(x)} → ${fb}` : this.modelOf(x)]; })));
    const kernel = this.kernelSeam();
    if (this.modules) this.modules.kernelHooks = { remind: (text, due) => { this.schedule.add("remind", due ?? this.now(), text); } };
    for (const spec of specs) {
      const fallbackModel = this.fallbackOf(spec);
      const provider = providerOf(this.cfg, spec.role);
      const region: Region = new Region(spec, {
        driver: this.driver,
        central: this.central,
        labeler,
        render: { maxItemChars: this.cfg.limits.maxItemChars, timezone: this.cfg.schedule.timezone, syncThinkChars: this.cfg.limits.syncThinkChars ?? 0, folds: this.folds },
        model: this.modelOf(spec),
        ...(fallbackModel ? { fallbackModel } : {}),
        cwd: this.cfg.workspace,
        permissionMode: this.cfg.kernel.permissionMode,
        env: provider ? { ...kernel.env, ...providerEnv(provider.name, provider.provider, this.cfg.stateDir) } : kernel.env,
        claudeExecutable: this.cfg.kernel.claudeExecutable,
        allowedTools: this.cfg.kernel.allowedTools,
        builtinTools: this.cfg.kernel.builtinTools,
        mcpServers: kernel.mcpServers,
        plugins: this.plugins,
        tools: this.regionTools(spec, learnNight),
        prefix: () => this.prefix,
        tailTokens: this.cfg.limits.rotationTailTokens,
        // 海马在白天这一页里的记录只有翻页压缩的稿和压出来的那段（已在前缀里）、或者没整理完的夜里那一觉：不重放给主线
        pageSoFar: () => this.central.page(this.epoch.id).filter((e) => e.src !== "hippocampus"),
        sleptThrough: () => this.sleptThrough(),
        ...(spec.role === "main" ? { opened: (prefix: string, text: string) => this.keepOpening(prefix, text) } : {}),
        ...(this.cfg.limits.restartPageTokens !== undefined ? { restartPageTokens: this.cfg.limits.restartPageTokens } : {}),
        now: this.now,
        onEvent: (r, ev) => this.onRegionEvent(r, ev),
        ...(spec.role === "main" ? { afterToolNote: () => [this.mainNudge(), this.unreadNudge(spec.id), this.midwork(spec.id), this.takeRecognized(spec.id)].filter(Boolean).join("\n") || undefined }
          : spec.role === "side" ? { afterToolNote: () => [this.unreadNudge(spec.id), this.midwork(spec.id), this.takeRecognized(spec.id)].filter(Boolean).join("\n") || undefined } : {}),
        guard: (tool: string, input: unknown) => {
          // 她翻开了哪页笔记：只记录、不拦；记录出任何错都不能影响下面的把关。
          // 夜里整理（海马）翻的页不算：那是整理时在看，算了会抬高接住率、让冷掉的页显得常被翻（临时开的回头看、把关会话不走这里）
          if (spec.role !== "hippocampus") {
            try { this.learning?.notes.observeTool(spec.id, tool, input); } catch { /* 记录失败不影响把关 */ }
          }
          return this.retiredFileGuard(tool, input, spec.role) ?? (spec.role === "hippocampus" ? this.organizerGuard(tool, input) : undefined);
        },
        log: this.log.child("region"),
      });
      this.regions.set(spec.id, region);
    }
    this.log.info("brain started", { epoch: this.epoch.id, regions: [...this.regions.keys()] });
    // 重启前在做的事：认领表里没人在做的清掉；一边做着的接着做；没想完的接着想（review I1 / C3 / M8）
    this.cleanStaleClaims();
    this.restoreLooks();
    this.resumeBackgrounds();
    this.resumeDeep(false);
    // 先接上重启前没回完的真人消息，再处理上次没处理完的待办（比如睡着时重启了）
    this.resumePendingHuman();
    if (this.thalamus.pendingTodos() > 0) this.deliverTodos();
    // 闸门：重启前交来还没送到的接着送；库里接手了还没分流完的再分一次
    this.resumeGated();
    this.gate?.recover();
  }

  /** A region's model: its provider's when it runs on one, else models.byRole or its tier */
  private modelOf(spec: RegionSpec): string {
    return providerOf(this.cfg, spec.role)?.provider.model ?? modelOf(this.cfg, spec);
  }

  /** A region on another provider has no fallback: the fallback is a model of the subscription's */
  private fallbackOf(spec: RegionSpec): string | undefined {
    return providerOf(this.cfg, spec.role) ? undefined : fallbackFor(this.cfg, spec);
  }

  /** The kernel's environment (kernelEnv: this role's temporary root) and MCP servers, with the loaded modules' (bin/ on PATH, their servers) */
  private kernelSeam(): { env: Record<string, string>; mcpServers: Record<string, unknown> } {
    const kernel = { ...this.cfg.kernel, env: kernelEnv(this.cfg) };
    return this.modules ? this.modules.kernel(kernel) : { env: kernel.env, mcpServers: kernel.mcpServers };
  }

  /** A region's tools: HH's own for its names, the event-memory ones, and the modules' for its role (lent the region's notes) */
  private regionTools(spec: RegionSpec, learnNight: LearnNight | undefined): ToolDef[] {
    const tc = this.toolContext(spec.id);
    const own = [...buildTools(tc, spec.tools), ...memTools(this.mem, spec.id, spec.tools, learnNight)];
    return this.modules ? this.modules.withTools(own, spec.role, tc.recallNotes ? { notes: tc.recallNotes } : {}) : own;
  }

  private rebuildPrefix(): void {
    if (this.reloadPersona) {
      try { this.persona = this.reloadPersona(); }
      catch (e) { this.log.warn("persona reload failed, keeping the old one", { error: String(e) }); }
    }
    // 重扫书架（补编号、换缓存、后台刷封面）：启动时建第一个前缀扫一次，之后每次换前缀一次；书架目录和联想都用这一份
    if (this.learning) {
      try { this.learning.scan(); }
      catch (e) { this.log.warn("learning: shelf scan failed", { error: String(e).slice(0, 200) }); }
    }
    const midterm = this.mem && this.cfg.memory?.events?.midterm
      ? (() => { try { return renderMidterm(this.mem!.recall, { now: this.now(), tz: this.cfg.schedule.timezone }); } catch (e) { this.log.warn("midterm render failed", { error: String(e) }); return ""; } })()
      : "";
    const shelf = this.cfg.learning.shelf ? this.shelfText() : "";
    // 压缩块进前缀前也过折叠表（库里的块不改，memory.promptFolds）
    // 限时间段的条目按那一页的起止判：块的 created 是那一页压完的时刻，上一块的 created 是这一页开始（第一块往前算一天）
    const raw = this.epochs.blocks();
    const sorted = [...raw].sort((a, b) => a.created - b.created);
    const startOf = new Map(sorted.map((b, i) => [b.id, i > 0 ? sorted[i - 1]!.created : b.created - 86_400_000]));
    const blocks = this.folds.empty ? raw : raw.map((b) => ({ ...b, text: this.folds.lines(b.text, [startOf.get(b.id) ?? b.created, b.created]) }));
    this.prefix = buildPrefix(this.persona, blocks, { midterm, shelf, language: this.cfg.writingLanguage, guides: this.modules?.guides() ?? "", facts: runtimeFactsOf(this.cfg) });
    this.shownParallel = null;   // 新前缀多半跟着新会话：同时在做的事重新给一遍
    this.prefixBuilds += 1;
    const ledger = this.persona.files.find((f) => f.path === LAYOUT.snapshot)?.text ?? "";
    this.situation?.prefixRebuilt(ledger);
    // 挂过的页、上一个话题：每个脑区都清（交出去做的、深想的也是），新前缀里重新算
    this.learning?.notes.prefixRebuilt();
    // 认出东西：一件事换一次前缀只提一次（和联想「一个前缀只附一次」同一个思路）；攒着没附的也清掉
    this.recognizedGiven.clear();
    this.recognizedPending.clear();
    if (this.prefixBuilds > 1 && this.refreshSkills) {
      try { this.refreshSkills(); } catch (e) { this.log.warn("skills refresh failed, keeping the old ones", { error: String(e) }); }
    }
  }

  /** 书架目录（learning.shelf 开着才调）：扫不动不影响建前缀，记一条 warn、这次不带书架 */
  private shelfText(): string {
    try {
      const { root, generalCategory, archiveDir, residentFile } = this.cfg.learning;
      // 接了学习就用刚扫过的那份（不再扫一遍）；没接才自己扫
      const shelf = this.learning ? this.learning.shelf() : scanShelf(root, generalCategory, archiveDir);
      // 接了学习的，扫描的问题学习那边扫的时候记（书架目录关着也记）；没接的这里记
      if (!this.learning && shelf.problems.length) this.log.warn("shelf scan problems", { count: shelf.problems.length, first: shelf.problems.slice(0, 3) });
      // 常驻单子（11-03 强度）：角色自己写的那份（书架根目录下的 learning.residentFile），没有就按强度 5 的教训列；接在书架目录后面
      let mine: string | null = null;
      try { mine = readFileSync(join(root, residentFile), "utf8"); } catch { mine = null; }
      // 给她看的路径和「留着的记号」：接了学习就用它扫书架时算好的；没接的这里自己算一次
      const shelfDir = this.learning?.shelfDir ?? shelfDirOf(this.cfg.workspace, root);
      const keep = this.learning?.marks() ?? readShelfRules(root, this.cfg.learning.shelfFile ?? SHELF_FILE).rules.importantMarks;
      return [renderShelf(shelf), renderResident(mine, shelf, param(this.db, "strength.residentMax"), { shelfDir, residentFile, keep })].filter(Boolean).join("\n\n");
    } catch (e) {
      this.log.warn("shelf render failed, no shelf in the prefix", { error: String(e) });
      return "";
    }
  }

  private region(id: string): Region {
    const r = this.regions.get(id);
    if (!r) throw new Error(`unknown region ${id}`);
    return r;
  }

  private record(src: string, kind: Kind, text: string, meta: Record<string, unknown> | null = null): Entry {
    return this.central.append(this.epoch.id, src, kind, text, meta);
  }

  /** 送去了还没真送到的感官事件 id（压着等前台的）：重复来的先挡住；真送到才记成见过，压着时重启了，重发的还进得来 */
  private readonly senseInflight = new Set<string>();

  /** 感官事件 id 去重：见过的（或正压着的）直接跳过（中央记忆只追加，不改旧行） */
  private senseKnown(ids: string[]): boolean {
    if (!ids.length) return false;
    const seen = this.sensesSeen();
    return ids.every((id) => seen.includes(id) || this.senseInflight.has(id));
  }

  private sensesSeen(): string[] {
    try { return JSON.parse(kvGet(this.db, SENSE_SEEN_KEY) ?? "[]") as string[]; } catch { return []; }
  }

  private senseMarkSeen(ids: string[]): void {
    for (const id of ids) this.senseInflight.delete(id);
    const seen = this.sensesSeen();
    const fresh = ids.filter((id) => !seen.includes(id));
    if (fresh.length) kvSet(this.db, SENSE_SEEN_KEY, JSON.stringify([...seen, ...fresh].slice(-SENSE_SEEN_MAX)));
  }

  /** 每个感知脑区这一轮看了哪几条原文（它记下的那一句、叫你好好想时，带上编号和 id） */
  private readonly senseRaw = new Map<string, Array<{ seq: number; ids: string[] }>>();
  private senseRefs(region: string, withIds: boolean): string {
    const raw = this.senseRaw.get(region) ?? [];
    if (!raw.length) return "";
    const seqs = raw.map((x) => `#${x.seq}`).join(B.brain.senseRefSeqSep);
    const ids = [...new Set(raw.flatMap((x) => x.ids))];
    return withIds && ids.length ? B.brain.senseRefsWithIds(seqs, ids.join(B.brain.senseRefIdSep)) : B.brain.senseRefsSeqOnly(seqs);
  }

  // ---------- 工具需要的能力 ----------
  private toolContext(regionId: string): ToolContext {
    return {
      regionId,
      workspace: this.cfg.workspace,
      python: this.cfg.tools.python,
      sendDryRun: this.cfg.tools.sendDryRun,
      send: this.send,
      gateway: this.gateway,
      log: this.log,
      shotsDir: join(this.cfg.stateDir, "shots"),
      ...(this.browser ? { browser: this.browser } : {}),
      timezone: this.cfg.schedule.timezone,
      sideThreads: this.cfg.regions.sideThreads,
      run: this.run,
      now: this.now,
      note: (text, o) => {
        // 下意识想通的结论：不是 inner，标成 insight（她自己想到的，不带标签）
        const role = this.regions.get(regionId)?.spec.role;
        if (role === "deep") { this.record(regionId, "note", text, { insight: true }); this.afterInsight(); return; }
        // 急事只对一边做着的那头有意义：说话的那头自己就能说
        const urgent = o?.urgent === true && role === "side";
        const e = this.record(regionId, "note", text, urgent ? { urgent: true } : null);
        this.recognizeIn(regionId, text);
        if (!this.afterNote(regionId, text) && urgent) this.wakeForUrgentNote(e.seq, text);
      },
      start: (topic, about, pri) => this.startTask(regionId, topic, about, pri),
      finish: (topic, state, on) => this.finishTask(regionId, topic, state, on),
      setBar: (bar, why, topic) => this.setBar(regionId, bar, why, topic),
      mullOver: (what) => this.mullOver(what),
      thinkItOver: (what) => this.thinkItOver(regionId, what),
      schedule: (kind, due, text, everyMs, minutes) => this.schedule.add(kind, due, text, everyMs, minutes ?? null),
      scheduled: () => this.schedule.list(),
      unschedule: (id) => this.schedule.remove(id),
      remindDone: (id) => this.schedule.setDone(id, this.now()),
      remindDoneAt: (id) => this.schedule.doneAt(id),
      resolveTarget: (channel, target) => this.currentPeople().targetFor(target, channel) ?? target,
      currentChat: () => { const to = regionId === "main" ? this.mainTarget() : undefined; return to ? { ...to } : null; },
      lastHeardFrom: (channel, target) => this.central.lastHeardFrom(channel, target),
      nameOf: (target) => personOfTarget(this.currentPeople(), target)?.name ?? null,
      beforeSend: async (target, text, media) => this.wordCheck(regionId, target, text) ?? this.handoverCheck(regionId, target, text, media),
      recordSend: (to, text, resolved) => {
        const person = personOfTarget(this.currentPeople(), to);
        const name = person?.name ?? to;
        // 她写的是群名之类、网关认出的会话号不一样：也记下（「最近说过的」按会话号问也找得到）
        const toId = resolved && targetKey(resolved) !== targetKey(to) ? resolved : undefined;
        this.record(regionId, "note", B.brain.sentNote(name, text), { sent: true, to, ...(toId ? { toId } : {}), name, batch: this.nextSendBatch() });
      },
      ...(this.mem ? {
        recallQuotes: (q: string, who?: string, o?: { olderOnly?: boolean }) => this.mem!.quotes(q, { ...(who ? { who } : {}), ...(o?.olderOnly ? { olderOnly: true } : {}) }),
        recallQuotesDay: (day: string, who?: string) => this.mem!.quotesDay(day, who ? { who } : {}),
      } : {}),
      // a module's script and the role's channels are there whether or not learning is on (a role with no channel gets no message tool)
      moduleRun: (module, script, args, o) => this.modules?.run(module, script, args, o) ?? null,
      channels: Object.keys(this.cfg.channels),
      ...(this.learning ? {
        recallNotes: (topic: string, binding: "goals") => this.notesFor(topic, binding, regionId, this.tasks.doing(regionId)[0]?.id),
      } : {}),
      askNotes: (topic, category) => this.askNotes(topic, category, regionId),
      // 她改自己的下意识规则（闸门开着才有）：写完马上重读；try 用当前名单认人、读最近的真动静
      ...(this.gateRules ? {
        gateRules: {
          file: this.cfg.gate.rulesFile,
          current: () => this.gateRules!.current(),
          reread: () => this.gateRules!.reread(),
          people: () => this.currentPeople(),
          names: this.cfg.names,
          sources: sourcesOf(this.cfg),
          recent: (days: number) => this.recentSenses(days),
        },
      } : {}),
      // 她改认识的人名单（有名单文件才有）：写完马上重载、记一笔给每日总结
      ...(this.registryFile ? {
        registry: {
          approved: () => { const st = this.baselineState(); return st.kind === "ok" ? st.base : null; },
          changed: (line: string) => { this.reloadPeople(); this.noteRegistryChange(line); },
          people: () => this.currentPeople(),
        },
      } : {}),
      recallLocal: (args) => recallCentral(this.db, args, {
        timezone: this.cfg.schedule.timezone,
        labels: (src) => this.labelOf(src) || B.common.self,
        folds: this.folds,
      }),
    };
  }

  /** 工具调用编号 → 工具名（内核报结果时只带编号；认出东西要知道是哪个工具的结果） */
  private readonly actTools = new Map<string, string>();
  private rememberActTool(id: string, tool: string): void {
    this.actTools.set(id, tool);
    if (this.actTools.size > 200) this.actTools.delete(this.actTools.keys().next().value!);
  }

  // ---------- 认出东西 ----------
  /** 每个脑区这个前缀里提过的事（换前缀清空） */
  private readonly recognizedGiven = new Map<string, Set<string>>();
  /** 每个脑区认出来、还没附上的（下一次工具调用后或下一次叫醒时附），带认出来的时刻 */
  private readonly recognizedPending = new Map<string, Map<string, { r: Recognized; at: number }>>();

  private recognizeOn(): boolean {
    return this.recognizer !== null && this.cfg.memory?.events?.recognize === true;
  }

  private givenIn(regionId: string): Set<string> {
    let g = this.recognizedGiven.get(regionId);
    if (!g) { g = new Set(); this.recognizedGiven.set(regionId, g); }
    return g;
  }

  /**
   * 她自己那几头（主线、一心多用）新进来的一段文字（工具结果、说的、记的、别人发来的）：认出挂在喜欢 / 烦的事上的东西，攒着等下一次附。
   * 前缀、系统提示、这里自己附的那行都不经过这里；整理、导入、体检、潜意识、随口、下意识的不认
   */
  private recognizeIn(regionId: string, text: string): void {
    if (!this.recognizeOn() || !text) return;
    const role = this.regions.get(regionId)?.spec.role;
    if (role !== "main" && role !== "side") return;
    try {
      const pending = this.recognizedPending.get(regionId) ?? new Map<string, { r: Recognized; at: number }>();
      const skip = new Set([...this.givenIn(regionId), ...pending.keys()]);
      for (const r of this.recognizer!.find(text, skip)) pending.set(r.id, { r, at: this.now() });
      if (pending.size) this.recognizedPending.set(regionId, pending);
    } catch (e) {
      this.log.warn("recognize failed", { region: regionId, error: String(e).slice(0, 200) });
    }
  }

  /**
   * 工具结果：记忆自己的工具（like、my_likes、remember、recall_* 这些列的本来就是她的记忆）不认；
   * like、remember、recall_event / person / period 的结果里写到的那几件，算她这一下自己刚碰过：这个前缀里不再提
   */
  private recognizeResult(regionId: string, tool: string, text: string): void {
    if (RECOGNIZE_SEEN_TOOLS.has(tool)) this.markRecognized(regionId, [...text.matchAll(EVENT_IDS)].map((m) => m[0]));
    if (RECOGNIZE_SKIP_TOOLS.has(tool)) return;
    this.recognizeIn(regionId, text);
  }

  /** 这几件算提过了（她自己刚碰过、联想刚带出过）：这个前缀里不再提，攒着的也不附 */
  private markRecognized(regionId: string, ids: string[]): void {
    if (!ids.length) return;
    const given = this.givenIn(regionId);
    const pending = this.recognizedPending.get(regionId);
    for (const id of ids) { given.add(id); pending?.delete(id); }
  }

  /**
   * 附上攒着的：只要 RECOGNIZE_FRESH_MS 内认出来的；附之前再看一眼那件（状态变了照新的写，撤掉了不附）；
   * 一次最多 RECOGNIZE_MAX 件，最近一下新的在前。附上的才算提过，没附上的丢掉（下次碰到再认）。
   * shown：同一次叫醒里别处（联想）已经带出的事件编号，不再附、照样算提过
   */
  private takeRecognized(regionId: string, shown: string[] = []): string | undefined {
    this.markRecognized(regionId, shown);
    const pending = this.recognizedPending.get(regionId);
    if (!pending?.size) return undefined;
    this.recognizedPending.delete(regionId);
    if (!this.recognizeOn()) return undefined;
    const given = this.givenIn(regionId);
    const fresh = [...pending.values()].filter((p) => !given.has(p.r.id) && this.now() - p.at <= RECOGNIZE_FRESH_MS);
    if (!fresh.length) return undefined;
    let now: Map<string, Omit<Recognized, "name">>;
    try { now = this.recognizer!.current(fresh.map((p) => p.r.id)); } catch (e) {
      this.log.warn("recognize failed", { region: regionId, error: String(e).slice(0, 200) });
      return undefined;
    }
    const pick = fresh.filter((p) => now.has(p.r.id)).map((p) => ({ ...now.get(p.r.id)!, name: p.r.name }))
      .sort((a, b) => b.felt - a.felt || a.id.localeCompare(b.id)).slice(0, RECOGNIZE_MAX);
    if (!pick.length) return undefined;
    for (const r of pick) {
      given.add(r.id);
      this.log.info("recognized", { name: r.name, event: r.id, region: regionId });
    }
    return pick.map((r) => P.recognized({ seen: r.name, state: r.state, name: likeName(r.title, r.stance), id: r.id, like: r.stance === "like", last: r.last })).join("\n");
  }

  /** 最近动作里的文件路径（看图时有原路径就只记路径，不另存） */
  private readonly actPaths = new Map<string, string>();
  private rememberActPath(id: string, input: unknown): void {
    const p = (input as { file_path?: unknown } | null)?.file_path;
    if (typeof p !== "string" || !p) return;
    this.actPaths.set(id, p);
    if (this.actPaths.size > 200) this.actPaths.delete(this.actPaths.keys().next().value!);
  }

  /** 看过的图：有原路径记原路径；没有的存进 stateDir/seen，记下存在哪 */
  private seenImages(toolId: string, images: Array<{ mediaType: string; data: string }>): string {
    const path = this.actPaths.get(toolId);
    if (path) return B.brain.imageSeen(path);
    const out: string[] = [];
    try {
      const dir = join(this.cfg.stateDir, "seen");
      mkdirSync(dir, { recursive: true });
      images.forEach((img, i) => {
        const ext = (img.mediaType.split("/")[1] ?? "png").replace("jpeg", "jpg");
        const file = join(dir, `${toolId || this.now()}-${i}.${ext}`);
        writeFileSync(file, Buffer.from(img.data, "base64"));
        out.push(file);
      });
    } catch (e) {
      this.log.warn("saving seen image failed", { error: String(e) });
    }
    return out.length ? B.brain.imageSeen(out.join(B.brain.imageSeenSep)) : "";
  }

  /**
   * 记忆里怎么标这条记录的来源：前台是空的（就是自己）；一边做着的事按事情标「（弄X时）」（按这条发生的时间找当时那件事），
   * 不按大脑的哪一部分标；下意识这些才标出来。
   */
  labelOf(src: string, e?: Entry): string {
    const r = this.regions.get(src);
    if (r?.spec.role === "side") {
      const t = e ? this.tasks.atTime(src, e.ts) : this.tasks.doing(src)[0];
      return t ? B.brain.sideTaskLabel(labelTopic(t.topic)) : "";
    }
    return r?.spec.label ?? src;
  }

  /** 这周额度快用完或电脑吃紧：不往外分（长活她自己做）、做完不另开会话回头看、下意识也不开工（spec 13） */
  private gated(): boolean {
    const week = this.weekUsed("side") ?? 0;
    return week >= this.cfg.parallel.quotaWeekMax || this.loadTight();
  }

  /** 空着的那部分（没在做事、也没在跑） */
  private freeBackground(): string | null {
    const side = [...this.regions.values()].find((r) => r.spec.role === "side" && !r.busy && this.tasks.doing(r.id).length === 0);
    return side?.id ?? null;
  }

  /** 开始做事时联想笔记开着没有（没有学习、或 learning.enabled 关着：完全不联想，叫醒照旧马上叫） */
  private notesOn(): boolean {
    return !!this.learning && this.cfg.learning.enabled;
  }

  /**
   * 她自己找全（what_do_i_know）：笔记里相关的页 + 以前做过的类似的事，两段之间空一行，只有一段就只给那一段，都没有给 T.what_do_i_know.none。
   * 不受 learning.enabled 开关管（她自己要找）；两边各自出错只记 warn、不让另一边也没了。
   * 找页失败（判断没回来、出错）页那段说翻不了（T.what_do_i_know.unreadable），不说成没有；给的大类书架上没有就说有哪些大类，不去判。
   */
  private async askNotes(topic: string, category: string | undefined, regionId: string): Promise<string> {
    const soft = async (what: string, f: () => Promise<string>, failed = ""): Promise<string> => {
      try { return (await f()).trim(); }
      catch (e) { this.log.warn("what_do_i_know: lookup failed", { what, error: String(e).slice(0, 200) }); return failed; }
    };
    const learning = this.learning;
    const mem = this.mem;
    const [pages, events] = await Promise.all([
      learning ? soft("pages", () => this.askPages(learning, topic, category), T.what_do_i_know.unreadable) : "",
      mem ? soft("events", () => mem.recall.cluster(topic, { budget: 800, region: regionId })) : "",
    ]);
    return [pages, events].filter(Boolean).join("\n\n") || T.what_do_i_know.none;
  }

  /** what_do_i_know 的页那一段：大类不在书架上（书架目录里的大类，通用在前）、判断没回来、找到的页；真没找到是空串 */
  private async askPages(learning: LearningRuntime, topic: string, category: string | undefined): Promise<string> {
    if (category !== undefined) {
      const general = this.cfg.learning.generalCategory;
      const names = [...new Set(learning.shelf().books.map((b) => b.category))].sort((a, b) => Number(b === general) - Number(a === general));
      if (!names.includes(category)) return T.what_do_i_know.categoryMissing(category, names);
    }
    const r = await learning.notes.ask(topic, category);
    return r.failed ? T.what_do_i_know.unreadable : r.text;
  }

  /**
   * 开始做一件事时联想笔记（on_it、goals、hands、mull_over）：挂给她的文字，没想起来是空串。
   * on_it 判过了却一页都没想起来、笔记又是真挂给她看的（inject）：换成「像是新领域，先摸底」那句。
   * 联想出错、超过联想自己的时限（limitFor）+ 100ms 都按没想起来算，不抛错、不让调用的一方多等。
   * 只算不挂（inject 关）：结果给不了她，联想在后台算完照样记，这里马上给空串（开始做事、叫醒那一边都不等）。
   */
  /** 「像是新领域，先摸底」那一句：页由配置 learning.newGroundPage 给（相对书架根目录）；没配就没有这一句 */
  private newGround(): string {
    const page = this.cfg.learning.newGroundPage;
    if (!page) return "";
    const title = page.split("/").pop()!.replace(/\.md$/, "");
    return P.newGround(title, `${shelfDirOf(this.cfg.workspace, this.cfg.learning.root)}/${page}`);
  }
  private notesFor(topic: string, binding: "on_it" | "goals" | "mull_over", regionId: string, taskId?: number): Promise<string> {
    if (!this.notesOn()) return Promise.resolve("");
    const text = this.learning!.notes.associate(topic, { region: regionId, binding, ...(taskId === undefined ? {} : { taskId }) })
      .then((r) => r.text || (binding === "on_it" && r.skipped === "nothing" && this.cfg.learning.inject ? this.newGround() : ""))
      .catch((e: unknown) => { this.log.warn("note association failed", { binding, error: String(e).slice(0, 200) }); return ""; });
    if (!this.cfg.learning.inject) return Promise.resolve("");
    // 等到联想自己的时限（冷的时候它给自己放宽了）再放弃：比它先放弃的话她没看到，联想却记成挂过
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((resolve) => { timer = setTimeout(() => resolve(""), this.learning!.notes.limitFor(binding) + 100); });
    return Promise.race([text, late]).finally(() => clearTimeout(timer));
  }

  /**
   * 开始做一件事（on_it）：她估的时间超过阈值，就交给空着的那部分一边做着（靠她估的时间）。
   * 返回给她的话里不提大脑的结构。自己做的，返回后面接想起来的笔记；交出去的，等笔记（有时限）再叫醒那一边、笔记接在叫醒后面。
   */
  private async startTask(regionId: string, topic: string, about?: string, priText?: string): Promise<string> {
    const role = this.regions.get(regionId)?.spec.role;
    const mine = this.tasks.doing(regionId);
    if (mine.some((t) => t.topic === topic)) return B.brain.taskAlreadyStarted;               // 再说一遍不多开一条（review I2）
    if (role === "side" && mine.length) return B.brain.taskSideStepNoNew;                                      // 手上那件事里的一步，不另开
    const like = this.similarTask(regionId, topic);
    if (like) return like;
    const holder = this.claims.claim(topic, regionId);
    if (holder) {
      const t = this.tasks.byTopic(topic);
      const mins = t ? Math.max(1, Math.round((this.now() - t.started) / 60_000)) : null;
      return B.brain.taskAlreadyHeld(mins ? B.brain.taskHolderMinutes(mins) : "");
    }
    const aboutMin = parseDuration(about);
    const pri = (["T0", "T1", "T2", "T3"].includes(priText ?? "") ? priText : "T2") as Pri;
    const askedBy = role === "main" ? this.mainTarget()?.name ?? null : null;
    const ask = askedBy ? this.lastAsk(askedBy) : null;
    const busyChat = chatActivity(this.central.chatSince(this.now() - this.cfg.parallel.busyChat.windowMin * 60_000), this.now(), this.cfg.parallel.busyChat).busy;
    const long = role === "main" && aboutMin !== null && aboutMin > this.cfg.parallel.thresholdMin;
    const gated = long && this.gated();
    const d = decideDispatch({
      caller: role === "main" ? "front" : "background",
      aboutMin, pri, busyChat, gated,
      freeBackground: long && !gated ? this.freeBackground() : null,
      doingTopics: this.tasks.doing().filter((t) => t.owner !== regionId).map((t) => t.topic),
      thresholdMin: this.cfg.parallel.thresholdMin,
    });
    this.log.info("dispatch", { topic, about: about ?? null, aboutMin, pri, region: regionId, decision: d.kind === "background" ? d.region : d.kind, gated, busyChat });
    if (d.kind === "notebook") {
      this.claims.release(topic, regionId);
      if (!d.doing.length) return B.brain.taskNotebookBusy;
      return B.brain.taskNotebookManyDoing(d.doing.join(B.brain.taskNotebookDoingSep));
    }
    if (d.kind === "background") {
      this.claims.release(topic, regionId);
      // 先把那头的会话开起来：开不起来当场告诉她没交出去，不记成在做（11-13 09:00 退路模型那次：她以为在读史记，其实没起来，空等了 25 分钟）
      const why = this.region(d.region).tryOpen();
      if (why !== null) {
        this.log.error("dispatch: side session would not open, not handed off", { topic, region: d.region, error: why.slice(0, 200) });
        return P.sideNotStarted(topic);
      }
      this.claims.claim(topic, d.region);
      const task = this.tasks.start({ topic, owner: d.region, aboutMin, pri, askedBy, ask });
      const wake = B.brain.taskHandedToSide(topic, about, P.SET_BAR_FIRST);
      if (!this.notesOn()) { this.wakeSide(this.region(d.region), wake, task); return P.HANDED_OFF; }
      void this.notesFor(topic, "on_it", d.region, task.id).then((notes) => {
        // 等笔记的这一会儿可能已经睡了、这件事被收掉了：不叫（醒来、换班后还在做的照常接着做）
        if (this.sleeping || this.alertness === "asleep" || !this.tasks.doing(d.region).some((x) => x.id === task.id)) return;
        this.wakeSide(this.region(d.region), notes ? `${wake}\n${notes}` : wake, task);
      });
      return P.HANDED_OFF;
    }
    const task = this.tasks.start({ topic, owner: regionId, aboutMin, pri, askedBy, ask });
    const notes = await this.notesFor(topic, "on_it", regionId, task.id);
    const head = gated ? `${P.YOURS}\n${this.tightNote()}` : P.YOURS;
    return notes ? `${head}\n${notes}` : head;
  }

  /** #0031：被提醒过的 (region, topic) → 时间；10 分钟内一字不差再说一次就放行 */
  private readonly similarWarned = new Map<string, number>();
  /** 进提示前折成一句（memory.promptFolds）：渲染记忆、recall、前缀里的压缩块、「最近说过的话」都过它 */
  private readonly folds: PromptFolds;
  /** 被停过、要为它换一次新会话的事：task id → 记下时那一头是第几班（换过了 generation 才变；没换成之前又停不算「换过还停」）（④） */
  private readonly sideRefused = new Map<number, number>();
  /** 约好了隔一会儿接着做的那几头（continueSide） */
  private readonly sideContinuing = new Set<string>();
  /** 主线因为被停过换新会话的时刻（④，上限见 MAIN_STOP_ROTATE_MAX） */
  private readonly mainStopRotations: number[] = [];

  /** #0031：on_it 的 topic 跟正在做的某件相近 → 返回提醒（不开新事）；放行或不相近返回 null */
  private similarTask(regionId: string, topic: string): string | null {
    const now = this.now();
    for (const [k, at] of this.similarWarned) if (now - at > 10 * 60_000) this.similarWarned.delete(k);
    const key = `${regionId}\u0000${topic}`;
    if (this.similarWarned.delete(key)) return null;
    const mine = topicWords(topic);
    let best: { t: TaskRow; ratio: number; shared: number } | null = null;
    for (const t of this.tasks.doing()) {
      if (t.topic === topic) continue;
      const theirs = topicWords(t.topic);
      let shared = 0;
      for (const w of mine) if (theirs.has(w)) shared++;
      const ratio = shared / (Math.min(mine.size, theirs.size) || 1);
      const noted = this.looking.has(t.id) || !!t.missing;
      if (!((noted && shared >= 1) || ratio >= 0.5)) continue;
      if (!best || ratio > best.ratio || (ratio === best.ratio && shared > best.shared)) best = { t, ratio, shared };
    }
    if (!best) return null;
    this.similarWarned.set(key, now);
    return P.similarOnIt(best.t.topic, Math.max(1, Math.round((now - best.t.started) / 60_000)), best.t.missing || null);
  }

  /** 把关时开工那句后面跟的提醒：额度到线了说用了多少，不然是电脑紧 */
  private tightNote(): string {
    const week = this.weekUsed("side") ?? 0;
    return week >= this.cfg.parallel.quotaWeekMax ? P.quotaTight(week) : P.LOAD_TIGHT;
  }

  /** 当初要她做这件事的那句话：这个人最近半小时里最后说的 */
  private lastAsk(who: string): string | null {
    const said = this.central.chatSince(this.now() - 30 * 60_000).filter((e) => e.kind === "input" && e.meta?.from === who);
    return said.at(-1)?.text ?? null;
  }

  /** 定下做到什么样才算好（set_bar）；定过的要改得说为什么，理由进记忆 */
  private setBar(regionId: string, bar: string, why?: string, topic?: string): string {
    const mine = this.tasks.doing(regionId);
    const t = (topic ? mine.find((x) => x.topic === topic) ?? this.tasks.byTopic(topic) : undefined) ?? (mine.length === 1 ? mine[0] : undefined);
    if (!t) return mine.length ? B.brain.taskSetBarWhichTopic(mine.map((x) => x.topic).join(B.brain.taskSetBarTopicSep)) : B.brain.taskSetBarNoneStarted;
    const text = bar.trim();
    if (!text) return B.brain.taskSetBarEmpty;
    if (t.bar && !why?.trim()) return P.barNeedsWhy(t.bar);
    this.tasks.setBar(t.id, text);
    if (t.bar) this.record(t.owner, "note", P.barChanged(t.topic, why!.trim(), text));
    return this.gated() ? P.BAR_SET_TIGHT : P.BAR_SET;   // 把关时 finishTask 不回头看（review cb819f8）
  }

  /**
   * 说做完了 / 只剩跟进 / 卡住了（done_with）：没定标准不收；定了就另开一个干净的会话回头看——做完的对照标准看到没到，卡住的看卡得算不算数。
   * 额度或电脑紧时不另开会话，照旧收下。
   */
  private async finishTask(regionId: string, topic: string, state?: string, on?: string): Promise<string> {
    const mine = this.tasks.doing(regionId);
    const onlyOne = this.regions.get(regionId)?.spec.role === "side" && mine.length === 1 ? mine[0] : undefined;   // 换了说法也收掉唯一那件（review I2）
    const t0 = mine.find((x) => x.topic === topic) ?? onlyOne ?? this.tasks.byTopic(topic);
    if (!t0) return this.claims.release(topic, regionId) ? B.brain.taskFinishClaimReleased : B.brain.taskFinishNotOnIt;
    if (this.looking.has(t0.id)) return P.STILL_LOOKING;
    const running = state === B.forms.doneStates.stuck ? [] : t0.helpers.filter((h) => this.helpersBusy.has(h));
    if (running.length) return P.helpersStillRunning(running);   // 交给帮手不算做完
    if (!t0.bar) return P.NEED_BAR;
    if (state === B.forms.doneStates.stuck && !on?.trim()) return P.STUCK_NEEDS_ON;
    const pending: Pending = state === B.forms.doneStates.stuck ? { state: "stuck", on: on!.trim() } : { state: state === B.forms.doneStates.follow ? "follow" : "done" };
    // 交出去之前：笔记里跟这件事对得上的几条（卡住了不是要交，不贴）；等联想的这会儿别的调用可能已经收了或开始看了
    const midwork = this.midworkState.get(regionId);
    if (midwork) midwork.pending = null;   // 中途在算的不再贴：交之前这一下贴的就是它
    const notes = pending.state === "stuck" ? "" : await this.deliveryNotes(t0);
    // 等联想的这会儿：别的调用可能已经开始看、收了、停了；标准也可能刚改过（并行的 set_bar），后面都用最新的这条
    if (this.looking.has(t0.id)) return P.STILL_LOOKING;
    const t = this.tasks.doing(t0.owner).find((x) => x.id === t0.id);
    if (!t) return B.brain.taskFinishNoLongerDoing;
    const check = notes ? `\n${P.CHECK_BEFORE_HANDING_OVER}\n${notes}` : "";
    const elapsed = P.finishedAfter(this.now() - t.started, t.aboutMin);
    // 做完、只剩跟进、卡住这几种说法，不管直接收下还是先回头看，末尾都带这句（想到的做法和教训这会儿最新鲜）
    const nudge = this.notePagesOf(t);
    const tail = nudge ? `\n${nudge}` : "";
    if (this.gated()) { this.settle(t, pending, false); return `${elapsed}${check}${tail}`; }
    this.looking.set(t.id, pending);
    this.saveLooks();
    this.lookAgain(t, pending, notes);
    return `${elapsed}${pending.state === "stuck" ? P.LOOK_STUCK_FIRST : P.LOOK_FIRST}${check}${tail}`;
  }

  /** 交出去之前（done_with）：拿这件事、标准、刚碰过的东西联想一次，挂出来的页和对得上的条目（纠正多半出在交东西那一下）。出错不挡收尾 */
  private async deliveryNotes(t: TaskRow): Promise<string> {
    if (!this.notesOn()) return "";
    try {
      const r = await this.learning!.notes.associate(this.workTopic(t.owner, t), { region: t.owner, binding: "done_with", taskId: t.id });
      return r.text;
    } catch (e) {
      this.log.warn("done_with: notes before handing over failed", { topic: t.topic, error: String(e).slice(0, 200) });
      return "";
    }
  }

  /**
   * 她手上这一步在干什么（干活时联想、交之前对一遍用）：这件事、标准、最近碰过的文件和命令、最近说的一句中文。
   * 不用思考：那是 API 给的英文摘要，跟中文的封面对不上
   */
  private workTopic(regionId: string, t: TaskRow | undefined): string {
    const recent = this.central.ownedSince(regionId, this.now() - WORK_LOOKBACK_MS);
    const touched = touchedOf(recent.filter((e) => e.kind === "act").slice(-12).map((e) => e.text));
    // 她自己的话：说的、真发出去的；HH 以她名义记的（没发出去的标记、改标准、回头看的结论）不算（review f5abb18）
    const said = recent.filter((e) => (e.kind === "say" || (e.kind === "note" && e.meta?.sent === true)) && /[\u4e00-\u9fff]/.test(e.text)).at(-1)?.text.replace(/\s+/g, " ").trim();   // 压成一行：midwork 去重时整行去掉
    return [
      t ? B.brain.taskWorkTopic(t.topic) : "",
      t?.bar ? B.brain.taskWorkBar([...t.bar].slice(0, 200).join("")) : "",
      touched.length ? B.brain.taskWorkTouched(touched.join(B.brain.taskWorkTouchedSep)) : "",
      said ? B.brain.taskWorkLastSaid([...said].slice(0, 120).join("")) : "",
    ].filter(Boolean).join("\n");
  }

  /** 每个脑区上一次「交给主人之前」拦下的时刻：之后 handover.graceMin 分钟里照发 */
  private readonly handoverHeld = new Map<string, number>();

  /** 她记下的不自然的词（tools.wordListFile，#0015） */
  private readonly wordList: WordList;
  /** 词表拦下过的（目标的 targetKey + 原话 → 拦下或上一次原样照发的时刻）：WORD_HOLD_MS 里原样再发给同一个人就照发 */
  private readonly wordHeld = new Map<string, number>();
  /**
   * 下一次叫醒她时附的（main 自己记的那几笔，她正在跑的会话里看不见：自己的记录不回灌给自己）：
   * misses = 最终回复没全发出去的（一个回复一项）；words = 发出去的话里用了她记下的词（同一个词留第一次的理由）。给过就清
   */
  private wakeHint: { misses: ReplyMiss[]; words: ListedWord[] } = { misses: [], words: [] };

  /**
   * 取走要附的那几行（先说没发出去的、再说用了的词）；release：叫醒没成，放回去（这期间新攒的接在后面）。
   * replyTo：这一叫是回谁的。没发全的那个人就是他：在这次回复里补；别的（回别人的、自己醒的）：要补用 message 发给那个人，
   * 不然补的话会跟着这一轮发给别人（final-review F-1）。哪种都不压着，下一次叫醒就说（#0063）
   */
  private takeWakeHint(replyTo?: Inbound["replyTo"]): { text: string; release: () => void } {
    const taken = this.wakeHint;
    if (!taken.misses.length && !taken.words.length) return { text: "", release: () => {} };
    this.wakeHint = { misses: [], words: [] };
    const here = replyTo ? targetKey(replyTo.target) : null;
    const line = (m: ReplyMiss): string => (m.key === here ? P.replyNotAllSentHere(m.who, m) : P.replyNotAllSentElsewhere(m));
    const text = [...taken.misses.map(line), ...(taken.words.length ? [P.wordsUsedHint(taken.words)] : [])].join("\n");
    return {
      text,
      release: () => { const now = this.wakeHint; this.wakeHint = { misses: [...taken.misses, ...now.misses], words: addWords([...taken.words], now.words) }; },
    };
  }

  /**
   * 发之前对一遍她记下的词表（#0015，她要的：「不拦，只回我一句『这个词他说过不自然』让我换」）：
   * 对上了这一条先不发，告诉她是哪个词、为什么；同一句话十分钟里原样再发给同一个人就照发（她说了算）
   */
  private wordCheck(regionId: string, target: string, text: string): string | null {
    const hits = wordHits(this.wordList.current(), text);
    if (!hits.length) return null;
    const now = this.now();
    for (const [k, at] of this.wordHeld) if (now - at >= WORD_HOLD_MS) this.wordHeld.delete(k);
    const key = `${targetKey(target)}\n${text}`;
    // 原样再发：照发，从这一次重新算（她可能还在核别的检查叫她核的东西，review M-1）
    if (this.wordHeld.has(key)) { this.wordHeld.set(key, now); return null; }
    this.wordHeld.set(key, now);
    this.log.info("word list: held a message", { region: regionId, words: hits.map((h) => h.word) });
    return P.wordsHeld(hits);
  }

  /**
   * 交给主人之前（重要的立马贴，不重要的不立刻贴）：给他发图、文件、长稿（或者三分钟里连着贴了不少字）时，
   * 拿手上的事和要发的东西联想（先算不挂）。笔记里有强的、标了「提醒：发之前」的条目对得上（11-05 起只认这种）：这条先不发，把对得上的贴给她，确认才记成挂过；
   * 拦过一次以后一阵子照发，不让她发不出去。没有强的不拦、不贴、不记；出错照发
   */
  private async handoverCheck(regionId: string, target: string, text: string, media?: string): Promise<string | null> {
    if (!this.notesOn() || personOfTarget(this.currentPeople(), target)?.privacy !== "owner") return null;
    const now = this.now();
    if (now - (this.handoverHeld.get(regionId) ?? -Infinity) < param(this.db, "handover.graceMin") * 60_000) return null;
    const len = [...text].length;
    const burst = this.central.recentSent(target, now - HANDOVER_BURST_MS).reduce((n, s) => n + [...s.text].length, 0) + len;
    if (!media && len < param(this.db, "handover.minChars") && burst < param(this.db, "handover.burstChars")) return null;
    // 书架上没有标了「提醒：发之前」的强教训（只有这种能拦，11-05）：问了也拦不下，别白等这一次联想（review 655b453）
    const strongMin = param(this.db, "strength.strongMin");
    if (!this.learning!.shelf().pages.some((p) => p.lessons.some((l) => (l.strength ?? 3) >= strongMin && l.send))) return null;
    try {
      const t = this.tasks.doing(regionId)[0];
      const topic = [
        this.workTopic(regionId, t),
        media ? B.brain.taskHandoverMedia(media.split("/").slice(-2).join("/")) : "",
        text ? B.brain.taskHandoverText([...text].slice(0, 300).join("")) : "",
      ].filter(Boolean).join("\n");
      const r = await this.learning!.notes.associate(topic, { region: regionId, binding: "handover", hold: true, ...(t ? { taskId: t.id } : {}) });
      // 没对上能拦的：不贴，但记一行（这次各题的概率留在 asked 里，以后调「发之前」的门槛要看没拦下的那些）
      if (!r.confirm || !r.pages.some((p) => p.strong)) { r.discard?.(); return null; }
      const shown = r.confirm();
      if (!shown.text) return null;
      this.handoverHeld.set(regionId, now);
      // 拦下的这条要她自己再发：一阵子过去还没再发给他，记一条，别让主人白等（review 655b453）
      const grace = param(this.db, "handover.graceMin") * 60_000;
      const mark = this.central.lastSeq();   // 按先后认「之后发过没有」，不按时刻（同一毫秒分不出先后）
      this.later(() => {
        const resent = this.central.since(mark).some((e) => e.kind === "note" && e.meta?.sent === true && sentTo(e.meta, target));
        if (!resent) this.log.warn("handover: held a message for the owner and the role has not sent it since", { region: regionId, minutes: grace / 60_000 });
      }, grace);
      return `${P.HANDOVER_CHECK}\n${shown.text}`;
    } catch (e) {
      this.log.warn("handover check failed (sent anyway)", { region: regionId, error: String(e).slice(0, 200) });
      return null;
    }
  }

  /** 干活时联想的进度：每个脑区上一次的时刻、之后用了几次工具、上一个话题、在算的那次（算完带结果） */
  private readonly midworkState = new Map<string, { at: number; tools: number; topic: string; pending: MidworkJob | null }>();

  /** 「挂了没翻」：每个脑区手上那件事，从开始起用了几次工具；提醒过的事 */
  private readonly unreadState = new Map<string, { taskId: number; tools: number; pages: string[] | null }>();
  private readonly unreadReminded = new Set<number>();

  /**
   * 挂了没翻（做生成任务前，以前做过类似的都要先翻笔记；联想只给个大概，不一定准）：这件事开始时（on_it）真挂给她看过页，
   * 她用了 midwork.unreadTools 次工具、这个脑区从开始起一页都没翻，就提醒一次，点出那几页的标题。不拦、不判、不调接口，
   * 只看 learn_assoc 和 learn_open。规矩本身在她的笔记里，这里只是通用的「挂了没翻」
   */
  private unreadNudge(regionId: string): string | undefined {
    if (!this.learning) return undefined;
    const t = this.tasks.doing(regionId)[0];
    if (!t) { this.unreadState.delete(regionId); return undefined; }
    if (this.unreadReminded.has(t.id)) return undefined;
    let st = this.unreadState.get(regionId);
    if (!st || st.taskId !== t.id) { st = { taskId: t.id, tools: 0, pages: null }; this.unreadState.set(regionId, st); }
    st.tools += 1;
    if (st.tools < param(this.db, "midwork.unreadTools")) return undefined;
    if (st.pages === null) {
      // 开始做时真挂给她看过的页（只算不挂的 shadow 不算）
      const rows = all<{ mounted: string }>(this.db, "SELECT mounted FROM learn_assoc WHERE binding = 'on_it' AND task_id = ? AND shadow = 0 AND mounted != '[]' ORDER BY at", t.id);
      // 因为强联想条目（规矩、常犯的教训）才挂上的页不算「做过类似的」，只看普通联想挂上的
      st.pages = [...new Set(rows.flatMap((r) => { try { return (JSON.parse(r.mounted) as Array<{ id: string; strong?: boolean }>).filter((m) => !m.strong).map((m) => m.id); } catch { return []; } }))];
    }
    if (!st.pages.length) { this.unreadReminded.add(t.id); return undefined; }
    // 从开始起翻过笔记本里任何一页、加载过任何一本都算翻过：要的是做之前翻笔记，不是非翻联想挑的那几页
    // （联想只对四成左右；11-05 07:39 第一次提醒时，她自己翻的三页才是对路的）
    const opened = all<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM learn_open WHERE region = ? AND at >= ?", regionId, t.started)[0]?.n ?? 0;
    this.unreadReminded.add(t.id);   // 翻过了也算问过：一件事只看一次
    if (Number(opened) > 0) return undefined;
    const shelf = this.learning.shelf().pages;
    const titles = st.pages.slice(0, 3).map((id) => shelf.find((p) => p.ids[0] === id)?.title ?? id);
    this.log.info("unread notes nudge", { region: regionId, task: t.id, pages: st.pages });
    return P.unreadNotes(titles);
  }

  /**
   * 干活时跟着手上的事联想（技能联想她要能自己用；以前只在来消息时联想，她写稿那二十分钟一页都没冒出来）：
   * 手上有 on_it 的事、或者刚碰过文件时，隔一阵（至少 2 分钟，5 分钟或 8 次工具）手上这一步变了就在后台联想一次，
   * 算好了下一次工具调用后附上；事换了就丢掉。不拖她的工具调用
   */
  private midwork(regionId: string): string | undefined {
    if (!this.notesOn() || this.gated()) return undefined;   // 把关时不另花判断
    const st = this.midworkState.get(regionId) ?? { at: this.now(), tools: 0, topic: "", pending: null };
    this.midworkState.set(regionId, st);
    const t = this.tasks.doing(regionId)[0];
    const taskId = t?.id ?? null;
    let out: string | undefined;
    const everyMs = param(this.db, "midwork.everyMin") * 60_000;
    if (st.pending && st.pending.text !== undefined) {
      // 算好以后她停了一阵没用工具（等人、聊天）：过时了，不贴
      const fresh = this.now() - (st.pending.doneAt ?? 0) <= everyMs;
      // 真贴的这一刻才确认（这时才记成挂过）；丢掉的不确认，什么都不记
      if (st.pending.taskId === taskId && st.pending.text && fresh) out = (st.pending.confirm ? st.pending.confirm().text : st.pending.text) || undefined;
      st.pending = null;
    }
    st.tools += 1;
    const since = this.now() - st.at;
    if (st.pending || since < param(this.db, "midwork.minMin") * 60_000 || (since < everyMs && st.tools < param(this.db, "midwork.everyTools"))) return out;
    const topic = this.workTopic(regionId, t);
    st.at = this.now();
    st.tools = 0;
    // 手上这一步 = 这件事 + 碰的东西；光多说了一句不算变了（11-04 一天联想 243 次、把判断的每日上限用完）
    // the two lines are read by the heads workTopic wrote them with (the pack entry with nothing in it)
    const step = topic.split("\n").filter((l) => !l.startsWith(B.brain.taskWorkLastSaid(""))).join("\n");
    if (!topic.includes(B.brain.taskWorkTouched("")) || step === st.topic) return out;   // 没在碰东西（聊天、等人）、或者手上这一步没变：不联想
    st.topic = step;
    const job: MidworkJob = { taskId };
    st.pending = job;
    void this.learning!.notes.associate(topic, { region: regionId, binding: "midwork", hold: true, ...(t ? { taskId: t.id } : {}) })
      .then((r) => { job.text = r.text; job.doneAt = this.now(); if (r.confirm) job.confirm = r.confirm; })
      .catch((e) => { job.text = ""; this.log.warn("midwork notes failed", { region: regionId, error: String(e).slice(0, 200) }); });
    return out;
  }

  /**
   * 说做完时：记下这件事里挂给她看过的页（这个脑区从开头起真挂过的；只算不挂的日子是空的），再说一次就整个重数。
   * learning.inject 开着才返回提醒她当场记的那句（标题按页编号从当前书架取，取不到用编号）；没开返回空串，她看到的话不变。
   * 出错只记 warn，不挡着收尾。
   */
  private notePagesOf(t: TaskRow): string {
    const learning = this.learning;
    if (!learning) return "";
    try {
      const ids = learning.notes.mountedSince(t.owner, t.started);
      this.tasks.setPages(t.id, ids);
      if (!this.cfg.learning.inject) return "";
      const pages = learning.shelf().pages;
      return P.writeDownNow(ids.map((id) => pages.find((p) => p.ids[0] === id)?.title ?? id));
    } catch (e) {
      this.log.warn("done_with: noting the pages that came up failed", { topic: t.topic, error: String(e).slice(0, 200) });
      return "";
    }
  }

  /** 照说的收下：做完的算做完，卡住的先放下 */
  private settle(t: TaskRow, how: Pending, later: boolean, seen = ""): void {
    if (how.state === "stuck") this.park(t, how.on ?? B.brain.stuckReasonUnclear, seen);
    else this.concludeTask(t, how.state, later);
  }

  /** 真卡住了：先放下，告诉自己记进待办账本、等到了再接着做 */
  private park(t: TaskRow, on: string, seen: string): void {
    this.pauseTask(t, on);
    this.wakeMain(P.parked(t.topic, on, seen), { cause: "side" });
  }

  /** 真的收下：记钟表时间（她自报的不准：10-31 自报 20/45/20/40，钟表 1/3/1.5/9 分钟）；一边做着的那件叫前台（这一轮还没完就等这一轮完） */
  private concludeTask(t: TaskRow, state: "done" | "follow", later: boolean): void {
    this.claims.release(t.topic, t.owner);
    this.tasks.finish(t.id, state, Math.round((this.now() - t.started) / 60_000));
    const r = this.regions.get(t.owner);
    if (r?.spec.role !== "side") return;
    if (!later || r.busy) { this.justFinished.set(t.owner, t.topic); return; }
    this.wakeMainSoon(P.backgroundDone(t.topic), "side");
  }

  // ---------- 回头看：她自己换一双挑剔的眼睛，对照开头定的标准看；过程不进记忆，结论用她的口气记下 ----------
  private readonly looking = new Map<number, Pending>();
  /** 正在看的会话（停机时一起关） */
  private readonly lookRegions = new Set<Region>();

  private saveLooks(): void {
    kvSet(this.db, LOOKING_KEY, JSON.stringify([...this.looking]));
  }

  /** 重启前正在回头看的事：重启后接着看（不叫它接着做） */
  private restoreLooks(): void {
    let saved: Array<[number, Pending]> = [];
    try { saved = JSON.parse(kvGet(this.db, LOOKING_KEY) ?? "[]") as typeof saved; } catch { saved = []; }
    for (const [id, pending] of saved) {
      let t: TaskRow;
      try { t = this.tasks.byId(id); } catch { continue; }
      if (t.state !== "doing" || !t.bar) continue;
      this.looking.set(id, pending);
      this.lookAgain(t, pending);
    }
    this.saveLooks();
  }

  /** 一直够不着标准：先放下，叫前台去跟当初要她做的人说 */
  private giveUp(t: TaskRow, missing: string, looks: number): void {
    const mins = Math.max(1, Math.round((this.now() - t.started) / 60_000));
    this.pauseTask(t, missing);
    this.wakeMain(P.stuckOnBar(t.topic, mins, looks, missing, t.askedBy ?? roleNames(this.cfg).owner), { cause: "side" });
  }

  /**
   * 临时开一个只看不动的会话（回头看、把关）：自己的空记忆，只给 Read/Grep/Glob、recall 和交结论的 tool，不挂外部的东西、不能开口。
   * 这一轮结束或超时（parallel.look.timeoutMin）就关掉；onSettle 只调一次，how 是 ok、出错的原因或 timeout。叫醒由调用的人来
   */
  private scratchSession(o: { id: string; roleText: string; tool: ToolDef; log: string; set: Set<Region>; onSettle: (how: string) => void; onUsage?: (total: TurnTotal, tier: Model) => void }): Region {
    let settled = false;
    const scratch = openDb(":memory:");
    const spec = {
      id: o.id, role: "hippocampus" as const, tier: "opus" as const, label: "", outlet: "none" as const, external: false,
      builtinTools: ["Read", "Grep", "Glob"], tools: ["recall"], roleText: o.roleText,
    };
    const region: Region = new Region(spec, {
      driver: this.driver, central: new CentralMemory(scratch, this.now), labeler: () => "",
      render: { maxItemChars: this.cfg.limits.maxItemChars, timezone: this.cfg.schedule.timezone, syncThinkChars: this.cfg.limits.syncThinkChars ?? 0, folds: this.folds },
      model: modelFor(this.cfg, spec.tier), cwd: this.cfg.workspace, permissionMode: this.cfg.kernel.permissionMode,
      env: this.kernelSeam().env, claudeExecutable: this.cfg.kernel.claudeExecutable, allowedTools: this.cfg.kernel.allowedTools,
      tools: [...buildTools(this.toolContext(o.id), spec.tools), o.tool],
      prefix: () => this.prefix, tailTokens: 0, now: this.now,
      onEvent: (_r, ev) => {
        if (ev.type !== "turn-end") return;
        if (ev.total) o.onUsage?.(ev.total, spec.tier);
        settle(ev.ok ? "ok" : (ev.error ?? "error"));
      },
      log: this.log.child(o.log),
    });
    o.set.add(region);
    const settle = (how: string): void => {
      if (settled) return;
      settled = true;
      o.set.delete(region);
      void region.close().finally(() => scratch.close());
      o.onSettle(how);
    };
    this.later(() => settle("timeout"), this.cfg.parallel.look.timeoutMin * 60_000);
    return region;
  }

  private lookAgain(t: TaskRow, pending: Pending, notes = ""): void {
    let verdict: { met: boolean; missing: string; seen: string } | null = null;
    const looked: ToolDef = {
      name: "looked_again",
      description: T.looked_again.description,
      shape: { met: z.boolean(), missing: z.string().optional(), seen: z.string().optional() },
      handler: async (a) => {
        verdict = { met: a.met === true, missing: String(a.missing ?? "").trim(), seen: String(a.seen ?? "").trim() };
        return T.looked_again.ok;
      },
    };
    const region = this.scratchSession({
      id: `look-${t.id}`, roleText: P.LOOK_ROLE, tool: looked, log: "look", set: this.lookRegions,
      onSettle: (how) => this.afterLook(t.id, how, verdict),
    });
    const render = { maxItemChars: this.cfg.limits.maxItemChars, timezone: this.cfg.schedule.timezone, mode: "sync" as const, folds: this.folds };
    // 只看做了什么、写了什么、说了什么，不带她想的过程（10-31 18:01 线上：带着一长串思考让它评判，被安全过滤当成套取思考拦下了）
    const all = renderMemory(this.central.ownedSince(t.owner, t.started).filter((e) => e.kind !== "think"), () => "", render);
    const record = all.length > LOOK_RECORD_CHARS ? B.brain.lookRecordTrimmed(all.slice(-LOOK_RECORD_CHARS)) : all;
    const chatRows = this.lookChat(t.askedBy);
    const chat = chatRows.map((x) => x.line).join("\n");
    this.log.info("look", { topic: t.topic, owner: t.owner, looks: t.looks, chat: chatRows.length });
    region.wake(P.lookAgain({ topic: t.topic, ask: t.ask, askedBy: t.askedBy, bar: t.bar ?? "", aboutMin: t.aboutMin, ms: this.now() - t.started, follow: pending.state === "follow", stuckOn: pending.state === "stuck" ? pending.on : null, missing: t.missing, record, notes, chat }), { raw: true });
  }

  /**
   * 回头看时带上的最近聊天（她 11-05 升级需求①：08:29 主人砍了 Gemini，回头看还说它该当第一期）：
   * 只要要她做这件事的人、主人，一对一说的和她发给他们的；陌生人、群里的不带（外面一句「不用做了」不能放松主人交代的事）
   */
  private lookChat(askedBy: string | null): Array<{ line: string }> {
    const people = this.currentPeople();
    const counts = (target: unknown): string | null => {
      const p = typeof target === "string" ? personOfTarget(people, target) : null;
      return p && (p.privacy === "owner" || (askedBy !== null && p.name === askedBy)) ? p.name : null;
    };
    const hm = (ts: number) => new Intl.DateTimeFormat(dateLocale(), { timeZone: this.cfg.schedule.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(ts);
    const out: Array<{ line: string }> = [];
    for (const e of this.central.chatSince(this.now() - LOOK_CHAT_HOURS * 3600_000)) {
      if (e.kind === "input" && e.meta?.human === true) {
        const who = counts((e.meta.replyTo as { target?: unknown } | null)?.target);
        if (who) out.push({ line: B.brain.lookChatIncoming(hm(e.ts), who, e.text.slice(0, 500)) });
      } else if (e.kind === "note" && e.meta?.sent === true) {
        const who = counts(e.meta.to);
        if (who) out.push({ line: B.brain.lookChatSent(hm(e.ts), who, sentBody(e.text).slice(0, 500)) });
      }
    }
    return out.slice(-LOOK_CHAT_LINES);
  }

  /** 看完了：到了就收（卡住的确实卡住就先放下）；没到就记下还差什么、接着做；一直够不着就先放下去问人；看的会话出了岔子不卡住她，照旧收下 */
  private afterLook(id: number, how: string, verdict: { met: boolean; missing: string; seen: string } | null): void {
    const pending = this.looking.get(id);
    this.looking.delete(id);
    this.saveLooks();
    const t = this.tasks.byId(id);
    if (!pending || t.state !== "doing") return;
    if (!verdict) {
      // 被拦下、出错：换个会话再看一次；还不行（或者是超时）才照旧收下
      if (how !== "timeout" && !pending.retried) {
        this.log.warn("look gave no verdict, looking again", { topic: t.topic, how });
        const again = { ...pending, retried: true };
        this.looking.set(id, again);
        this.saveLooks();
        this.lookAgain(t, again);
        return;
      }
      this.log.warn("look gave no verdict", { topic: t.topic, how });
      this.settle(t, pending, true);
      return;
    }
    const stuck = pending.state === "stuck";
    this.log.info("looked", { topic: t.topic, met: verdict.met, stuck, looks: t.looks + (verdict.met ? 0 : 1) });
    if (verdict.met && stuck) {
      const seen = verdict.seen || B.brain.lookSeenStuckMet;
      this.record(t.owner, "note", P.lookedStuck(seen));
      this.park(t, pending.on ?? B.brain.stuckReasonUnclear, seen);
      return;
    }
    if (verdict.met) {
      const seen = verdict.seen || B.brain.lookSeenMet;
      this.record(t.owner, "note", P.lookedMet(seen));
      this.concludeTask(t, pending.state === "follow" ? "follow" : "done", true);
      if (this.regions.get(t.owner)?.spec.role !== "side") this.wakeMain(P.lookedMetMine(t.topic, seen), { cause: "side" });
      return;
    }
    const missing = verdict.missing || verdict.seen || B.brain.lookMissingUnclear;
    const n = this.tasks.noteLook(t.id, missing);
    this.record(t.owner, "note", stuck ? P.lookedNotStuck(missing) : P.lookedShort(missing));
    const mins = Math.max(1, Math.round((this.now() - t.started) / 60_000));
    const look = this.cfg.parallel.look;
    if (n >= look.maxLooks || (t.aboutMin && mins >= look.overFactor * t.aboutMin)) {
      this.giveUp(t, missing, n);
      return;
    }
    const text = P.keepGoing(t.topic, missing, stuck);
    if (t.owner === "main") this.wakeMain(text, { cause: "side" });
    else if (!this.sleeping) this.wakeSide(this.region(t.owner), text, t);
  }

  // ---------- 把关（spec 7.4）：夜里要进笔记本的候选不直接进页，先交给一个分开的会话，按写死的标准（P.CHECK_ROLE）逐条判 ----------
  /** 正在把关的会话（停机时一起关） */
  private readonly checkRegions = new Set<Region>();

  /** 学习这一块夜里给整理的（海马、分段整理的各段）：工作单、把关；没接学习就不给（两个工具自己回笔记本没开） */
  private learnNight(): LearnNight | undefined {
    const learning = this.learning;
    return learning ? { worklist: (day: string) => learning.worklist(day), check: (day: string, c: CheckCandidate[], requester: string) => this.startCheck(day, c, requester) } : undefined;
  }

  /**
   * learn_check：开一个把关会话就返回；看完（或超时）结论写进 learn/check/<day>.json，再叫醒发起的那个会话逐条说
   * （requester：海马 = 旧的整理，还在夜里整理就叫醒它；分段整理的一段 = 它的会话还开着就叫它）
   */
  private startCheck(day: string, candidates: CheckCandidate[], requester: string): string {
    // 分段整理的一段已经交差了：结论回来没人照着写，不收
    if (this.night?.hosts.live.get(requester)?.handedIn) return S.host.checkAfterDone;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(B.brain.checkDayFormat);   // 它是文件名
    if (!candidates.length) return P.CHECK_NOTHING;
    const ask = P.checkAsk(candidates, this.checkPages(candidates));
    const verdicts = new Map<number, CheckVerdict>();
    const checked: ToolDef = {
      name: "checked",
      description: T.checked.description,
      shape: {
        verdicts: z.array(z.object({
          i: z.number().int(),
          verdict: z.enum(["add", "merge", "reject"]),
          into: z.string().optional().describe(T.checked.params.into),
          text: z.string().optional().describe(T.checked.params.text),
          why: z.string(),
        })),
      },
      handler: async (a) => {
        for (const v of (a.verdicts as CheckVerdict[] | undefined) ?? []) verdicts.set(v.i, v);
        return T.checked.ok;
      },
    };
    // 分段整理的一段交来的：把关花的算进这一夜的花费（按把关会话的模型换算）
    const night = this.night?.hosts.live.has(requester) ? this.night : null;
    const region = this.scratchSession({
      id: `check-${day}`, roleText: P.CHECK_ROLE, tool: checked, log: "check", set: this.checkRegions,
      // 超时：已经交了的也不算，整批按没看完
      onSettle: (how) => this.afterCheck(day, candidates, how === "timeout" ? new Map() : verdicts, how, requester),
      ...(night ? { onUsage: (total: TurnTotal, tier: Model) => night.budget.add(units(total, tier, night.weights)) } : {}),
    });
    // 分段整理的一段交来的：它这一轮结束了先不算没交，等结论
    const stage = this.night?.hosts.live.get(requester);
    if (stage) stage.checks += 1;
    this.log.info("check", { day, candidates: candidates.length, ...(requester !== "hippocampus" ? { requester } : {}) });
    region.wake(ask, { raw: true });
    return P.CHECK_STARTED;
  }

  /** 每条候选要进的那页现在的样子：按页编号（并进来的旧编号也算）在书架上找，找不到是新页（null）；同一页只读一次，单页和总共都有上限 */
  private checkPages(candidates: CheckCandidate[]): Array<CheckPage | null> {
    const pages = this.learning?.shelf().pages ?? [];
    const read = new Map<string, CheckPage>();
    let budget = CHECK_PAGES_CHARS;
    return candidates.map((c) => {
      const id = c.page.trim().replace(/^p:/, "");
      const page = pages.find((p) => p.ids.includes(id));
      if (!page) return null;
      const path = join(this.cfg.learning.root, page.rel);
      const seen = read.get(path);
      if (seen) return seen;
      let text: string;
      try { text = readFileSync(path, "utf8"); }
      catch (e) { text = B.brain.checkPageUnreadable(String(e).slice(0, 200)); }
      const n = Math.min(CHECK_PAGE_CHARS, budget);
      const out: CheckPage = { path, text: text.slice(0, n), full: text.length <= n };
      budget -= out.text.length;
      read.set(path, out);
      return out;
    });
  }

  /**
   * 把关看完了（或超时）：结论接着写进这一天的文件（同一晚交了几次就接着往后记，编号接着数）；再叫醒发起的会话逐条说：
   * 分段整理的那一段还开着就叫它；海马发起的照旧（还在夜里整理就叫醒海马）；那一段已经结束了就只写文件
   */
  private afterCheck(day: string, candidates: CheckCandidate[], verdicts: ReadonlyMap<number, CheckVerdict>, how: string, requester: string): void {
    const file = join(this.cfg.stateDir, "learn", "check", `${day}.json`);
    let before: CheckEntry[] = [];
    if (existsSync(file)) {
      try {
        const prev: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(prev)) before = prev as CheckEntry[];
      } catch (e) {
        this.log.warn("check: earlier verdicts of the day can't be read, starting the file over", { day, error: String(e).slice(0, 200) });
      }
    }
    const entries = candidates.map((c, k): CheckEntry => {
      const given = verdicts.get(k + 1);
      const text = given?.text?.trim() ? given.text : null;
      // 并进却没给合并后的文字：她没东西可写，按没看完算
      const v = given?.verdict === "merge" && !text ? undefined : given;
      return {
        i: before.length + k + 1, kind: c.kind, page: c.page, text: c.text,
        verdict: v?.verdict ?? "unchecked",
        into: v?.into ?? null,
        // 收、并进用把关给的文字；收但没给文字就用候选原文；不收、没看完的不进页
        finalText: !v || v.verdict === "reject" ? null : text ?? c.text,
        why: v?.why ?? null,
      };
    });
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify([...before, ...entries], null, 2)}\n`);
    } catch (e) {
      this.log.warn("check: writing the verdicts failed", { day, error: String(e).slice(0, 200) });
    }
    const unchecked = entries.filter((e) => e.verdict === "unchecked").length;
    if (unchecked) this.log.warn("check: some candidates got no verdict", { day, how, unchecked, of: entries.length });
    else this.log.info("checked", { day, candidates: entries.length });
    const stage = this.night?.hosts.live.get(requester);
    if (stage) {
      stage.checks = Math.max(0, stage.checks - 1);
      stage.wake(P.checked(day, entries));
      return;
    }
    if (requester !== "hippocampus") {
      // 那一段已经关了（超时、出错）：结论只在文件里，没写进提案；这一天的报告最上面说一句
      this.log.warn("check: the stage that asked has ended, the verdicts are only in the file", { day, requester, candidates: candidates.length });
      const notes = this.night?.notes;
      if (notes) notes.set(day, [...(notes.get(day) ?? []), B.brain.checkStageClosedNote(candidates.length)]);
      return;
    }
    if (this.sleeping?.kind === "night") this.region("hippocampus").wake(P.checked(day, entries), { raw: true });
  }

  // ---------- 一边做着的事（后台那部分的一生，spec 8 / 8.1） ----------
  /** 还在跑的帮手 → 派出去的时间：派活时记上，回报到了、叫停了才去掉 */
  private readonly helpersBusy = new Map<string, number>();
  /** 挂了一天多、问过她清不清的帮手 → 问的是哪一次派的（重新派了就不算问过） */
  private readonly helpersAsked = new Map<string, number>();
  /** 正在问（附进了一次叫醒、还在等情境、没真发出去）：这期间别的叫醒不再问一遍（复核 ef45c4cb） */
  private readonly helpersAsking = new Map<string, number>();
  private readonly justFinished = new Map<string, string>();

  /** 前台闲着（可以叫它起来）：没在跑、没在准备、没在翻页或睡觉，也没有压着等它的事（压着的事重启会丢） */
  private frontIdle(): boolean {
    const main = this.regions.get("main");
    return !!main && !main.busy && this.mainPreparing === 0 && !this.turn && !this.sleeping && this.alertness !== "asleep" && this.heldForMain.length === 0;
  }

  /**
   * 后台交回来的事（做完了、要问人、想通了）叫前台：闲着马上叫；这一轮还没完就排在后面（以前直接不叫，11-01 后台做完 24 件只叫到 6 次）。
   * 睡着、睡觉整理、翻页时不叫：结论在记忆增量里，醒来看得到。
   */
  private wakeMainSoon(text: string, cause: WakeCause): void {
    const main = this.regions.get("main");
    if (!main || this.turn || this.sleeping || this.alertness === "asleep") return;
    // 刚说完一轮、气泡还在发时压着同一个人的话：让它先（不然这件开的一轮做多久，那几句就等多久，复核 11-13）
    if (!main.busy && this.mainPreparing === 0 && this.mergedHeld.size === 0) { this.wakeMain(text, { cause }); return; }
    this.heldForMain.push({ human: false, conv: "", run: () => this.wakeMainSoon(text, cause) });
  }

  /** 派了帮手：记在正在做的那件事上 */
  private trackHelper(regionId: string, actText: string): void {
    const stopped = helperStoppedFromAct(actText);
    if (stopped) { this.helperDone(stopped); return; }
    const name = helperNameFromAct(actText);
    if (!name) return;
    this.helpersBusy.set(name, this.now());
    this.saveHelpers();
    const task = this.tasks.doing(regionId)[0];
    const front = this.regions.get(regionId)?.spec.role === "main";   // 前台那件事常常一整天没收：新鲜、帮手在这件事里出生才挂（#0052）
    if (task && (!front || attachHelperTo({ task, helper: name, now: this.now(), seenElsewhere: this.tasks.helperSeenElsewhere(name, task.id) }))) this.tasks.addHelper(task.id, name);
  }

  private helperDone(name: string): void {
    if (this.helpersBusy.delete(name)) this.saveHelpers();
  }

  private saveHelpers(): void {
    kvSet(this.db, HELPERS_KEY, JSON.stringify(Object.fromEntries(this.helpersBusy)));
    for (const [k, v] of this.helpersAsked) if (this.helpersBusy.get(k) !== v) this.helpersAsked.delete(k);   // 叫停了、交回了、重新派了：不算问过
    kvSet(this.db, HELPERS_ASKED_KEY, JSON.stringify(Object.fromEntries(this.helpersAsked)));
  }

  /** 后台记下「要问 X：…」：那件事等着 X；前台闲着就叫它去问。叫了返回 true */
  private afterNote(regionId: string, text: string): boolean {
    if (this.regions.get(regionId)?.spec.role !== "side") return false;
    const who = askedPerson(text);
    const task = this.tasks.doing(regionId)[0];
    if (!who || !task) return false;
    this.tasks.setWaiting(task.id, who);
    this.wakeMainSoon(P.askSomeone(text), "side");
    return true;
  }

  // ---------- 一边做着的那头记了急事（jot_down urgent） ----------
  /** 还没叫说话的那头看的急事（中央记忆里的编号 + 原话） */
  private readonly urgentPending: Array<{ seq: number; text: string }> = [];
  /** 上一次为急事叫说话的那头的时间 */
  private lastUrgentWake = Number.NEGATIVE_INFINITY;
  /** 已经排了一个到点再看的计时（只排一个） */
  private urgentTimerSet = false;
  /** 已经在说话的那头这一轮后面排了一次「到时候再看」（只排一个） */
  private urgentQueued = false;

  /** 记了急事：叫说话的那头看。最多每 minGapMin 分钟叫一次，期间记的攒着、到点一起给；那时它已经看过的就不再叫 */
  private wakeForUrgentNote(seq: number, text: string): void {
    this.urgentPending.push({ seq, text });
    this.log.info("urgent note: pending", { seq, pending: this.urgentPending.length });
    this.flushUrgentNotes();
  }

  /**
   * 看一眼攒着的急事（真叫醒说话的那头之前一直攒在这里）：它已经看过的拿掉；翻页、睡着时过一会儿再试（这时叫了也会被丢掉）；
   * 离上次真为急事叫它不到 minGapMin 分钟，到点再看；它这一轮正忙，就排在这一轮后面到时候再看一次（不打断：她正在回人时打断，
   * 那一轮的话就不发了，11-01 22:36；原话也不先定死，这一轮里看过的到时候就不叫了）；都不是就现在叫。叫了返回 true
   */
  private flushUrgentNotes(): boolean {
    if (this.urgentTimerSet || this.urgentQueued) return false;   // 已经排着一次再看：到时候一起给
    const main = this.regions.get("main");
    if (!main) return false;
    // 说话的那头已经看过的（它的记忆读到了那一条以后）不用再叫
    const seen = main.seenUpTo();
    for (let i = this.urgentPending.length - 1; i >= 0; i--) if (this.urgentPending[i]!.seq <= seen) this.urgentPending.splice(i, 1);
    if (!this.urgentPending.length) return false;
    if (this.turn || this.sleeping || this.alertness === "asleep") { this.urgentLater(URGENT_RETRY_MS); return false; }
    const wait = this.lastUrgentWake + this.cfg.parallel.urgentNote.minGapMin * 60_000 - this.now();
    if (wait > 0) { this.urgentLater(wait); return false; }
    if (main.busy || this.mainPreparing > 0) {
      this.urgentQueued = true;
      this.heldForMain.push({ human: false, conv: "", run: () => this.urgentAfterTurn() });
      return false;
    }
    const texts = this.urgentPending.splice(0).map((x) => x.text);
    this.lastUrgentWake = this.now();
    this.log.info("urgent note: waking main", { notes: texts.length });
    this.wakeMain(P.urgentNotes(texts), { cause: "side" });
    return true;
  }

  /**
   * 说话的那头这一轮完了：再看一次。这次没叫它（都看过了、要等），把后面压着的下一件放进去，不然它们要等到它下一轮完。
   * 返回有没有交给它东西：没有的话这一轮的收尾照常做（接着专注、翻页、换班），不然她会停在那儿
   */
  private urgentAfterTurn(): boolean {
    this.urgentQueued = false;
    if (this.flushUrgentNotes()) return true;
    const main = this.regions.get("main");
    return !!main && !main.busy && this.mainPreparing === 0 && this.runHeld();
  }

  private urgentLater(ms: number): void {
    this.urgentTimerSet = true;
    this.later(() => { this.urgentTimerSet = false; this.flushUrgentNotes(); }, ms);
  }

  /** 有人来消息了：等着这个人的事接着做 */
  private wakeWaitingFor(from: string): void {
    for (const t of this.tasks.doing()) {
      if (!t.waitingFor || t.waitingFor.toLowerCase() !== from.toLowerCase()) continue;
      const r = this.regions.get(t.owner);
      if (!r || r.spec.role !== "side") continue;
      this.tasks.setWaiting(t.id, null);
      this.wakeSide(r, B.brain.taskWaitedPersonReplied(from, t.topic), t);
    }
  }

  /** 后台一轮结束：做完了叫前台；没做完就接着做 / 等帮手 / 等人 / 先放下 */
  private afterSideTurn(r: Region, ev: Extract<KernelEvent, { type: "turn-end" }>): void {
    const finished = this.justFinished.get(r.id);
    if (finished) {
      this.justFinished.delete(r.id);
      this.wakeMainSoon(P.backgroundDone(finished), "side");
    }
    const task = this.tasks.doing(r.id)[0];
    if (!task) return;
    if (this.looking.has(task.id)) return;                // 正在回头看：等看完
    if (!ev.ok && (ev.refused || ev.stopped)) { this.afterSideRefused(r, task, ev.refused ?? "unknown"); return; }
    if (ev.ok && ev.stopped) this.afterSideStopped(r, task);
    const usedTools = r.toolsThisTurn > 0;
    const decision = afterBackgroundTurn({
      task, usedTools, now: this.now(),
      helperRunning: task.helpers.some((h) => this.helpersBusy.has(h)),
      sdkBackground: ev.background ?? 0,
      barFactor: this.cfg.parallel.look.overFactor,
    });
    if (usedTools) this.tasks.resetIdle(task.id);
    else this.tasks.bumpIdle(task.id);
    if (decision === "pause") {
      if (task.bar && overTime(task, this.now(), this.cfg.parallel.look.overFactor)) this.giveUp(task, task.missing ?? (r.finalSay() || B.brain.giveUpMissing), task.looks);
      else this.shelve(task, r.finalSay());
      return;
    }
    if (decision !== "continue") return;
    this.continueSide(r, task, usedTools ? "" : `\n${P.IDLE_NUDGE}`);
  }

  /** 隔一会儿叫它接着做这件事；要换班的（翻页时它正忙、这一轮被停过）先换新会话再接着做。到时它在忙（内核自己开了一轮）就不叫：那一轮结束会再走 afterSideTurn */
  private continueSide(r: Region, task: TaskRow, nudge: string): void {
    if (this.sideContinuing.has(r.id)) return;   // 已经约好接着做了（同一刻两轮收尾：被停又被内核自己开的一轮停），别叫两遍
    this.sideContinuing.add(r.id);
    this.later(() => {
      this.sideContinuing.delete(r.id);
      const t = this.tasks.doing(r.id)[0];
      if (!t || t.id !== task.id || r.busy || this.sleeping) return;
      if (!r.pendingRotate) { this.wakeSide(r, B.brain.taskContinue(t.topic, nudge), t); return; }
      // 翻页时它正忙：先换班再接着做（不然一直用旧会话，review I5）
      void this.rotateRegion(r).then(() => {
        const mins = Math.max(1, Math.round((this.now() - t.started) / 60_000));
        if (!r.busy && this.tasks.doing(r.id)[0]?.id === t.id) this.wakeSide(r, B.brain.taskContinueAfterRotate(t.topic, mins, nudge), t);
      });
    }, CONTINUE_GAP_MS);
  }

  /**
   * 一边做的那头这一轮被停了、没做成（内核报 refused 或 stopped，以失败收尾）：同一个会话里再叫多半还是停（11-13 16:25 同一会话连撞 8 次、两件事被当成空转放下）。
   * 这件事还没为它换过会话：换个新会话接着做（从记忆接上，不带被停的那段上下文）；换过还是没做成：这件放下，当场告诉她别再原样交，让她换做法或者问主人。
   * 只是别让坏掉的会话白烧轮次，不是想办法让被停的内容过去。类别只进日志，她读到的话里不带（④：这类说法进了记忆会越喂越停）
   */
  private afterSideRefused(r: Region, task: TaskRow, category: string): void {
    const marked = this.sideRefused.get(task.id);
    if (marked === undefined || marked === r.generation) {   // 还没为它换过（或者记下了、还没来得及换，内核自己又开了一轮又停了）
      this.sideRefused.set(task.id, r.generation);
      this.log.warn("side: refused by the safety classifier, continuing in a fresh session", { region: r.id, topic: task.topic, category });
      r.pendingRotate = true;              // 到时它在忙（内核自己开了一轮）也不丢：那一轮结束再换（continueSide / rotateWhenQuiet）
      this.continueSide(r, task, "");
      return;
    }
    this.log.warn("side: refused again in a fresh session, task put down", { region: r.id, topic: task.topic, category });
    this.tasks.pause(task.id);
    this.claims.release(task.topic, task.owner);
    this.record(task.owner, "note", P.sideRefusedNote(task.topic));
    this.wakeMainSoon(P.sideRefused(task.topic, this.cfg.names?.owner?.trim() || B.brain.ownerNameFallback), "side");   // 主人的名字从配置取（框架在拆，不写死）
  }

  /** 一边做的那头这一轮被停过、但 CLI 接着跑成了：被停的那段还在会话历史里，下一轮换个新会话（每件事只换一次；换过再停就照常走，没做成才放下） */
  private afterSideStopped(r: Region, task: TaskRow): void {
    if (this.sideRefused.has(task.id) || r.pendingRotate) return;
    this.sideRefused.set(task.id, r.generation);
    this.log.warn("side: stopped this turn, next round in a fresh session", { region: r.id, topic: task.topic });
    r.pendingRotate = true;
  }

  /**
   * 主线这一轮被停过（④，CEO 11-13：「主线被停过就换」）：被停的那段留在会话历史里，同一个会话接着用就容易连着停（11-13 21:04–21:36 半小时停了 10 次）。
   * 等这一轮收完、安静了就换新会话（不分叉：分叉带着被停的那段，翻页时也是分叉被拒）；下一次叫醒先换再送（wakeMain）。
   * 带上限：MAIN_STOP_ROTATE_WINDOW_MS 里最多 MAIN_STOP_ROTATE_MAX 次，再停说明毛病不在会话历史里，留给翻页。翻页中、睡着时不管（本来就会换）
   */
  private afterMainStopped(r: Region, ev: Extract<KernelEvent, { type: "turn-end" }>, to: Inbound["replyTo"]): void {
    if (this.turn || this.sleeping || r.pendingRotate) return;
    const now = this.now();
    const recent = this.mainStopRotations.filter((t) => now - t < MAIN_STOP_ROTATE_WINDOW_MS);
    this.mainStopRotations.length = 0;
    this.mainStopRotations.push(...recent);
    if (recent.length >= MAIN_STOP_ROTATE_MAX) {
      this.log.warn("main: stopped again, fresh-session cap reached; leaving it to the page turn", { ok: ev.ok, rotations: recent.length });
      return;
    }
    this.mainStopRotations.push(now);
    this.log.warn("main: stopped this turn, switching to a fresh session when quiet", { ok: ev.ok, ...(ev.refused ? { category: ev.refused } : {}), rotations: recent.length + 1 });
    r.pendingRotate = true;
    // the turn was answering someone and nothing went out: hand that message over again, in the fresh session (wakeMain
    // switches first), opening with "you saw it, your last answer did not reach them"; not recorded a second time
    const again = !ev.ok && to ? this.personWakes.get(convKey(to)) : undefined;
    if (again) {
      const { record: _recorded, ...opts } = again.opts;
      const seq = opts.humanCtx?.seq;
      this.log.info("main: stopped while answering someone, message handed over again", { seq: seq ?? null });
      // the fresh session opens with that message in its memory: say so, and that the last answer did not reach them
      this.wakeMain(opts.shownUnsentText ?? again.text, { ...opts, ...(seq !== undefined ? { recordedSeq: seq } : {}), lastUnsent: true });
      return;
    }
    this.rotateWhenQuiet(r);
  }

  /** 做太久或连着空转：先放下，空出来；记一笔她看得到的；返回记下的卡在哪 */
  private pauseTask(task: TaskRow, stuckText: string): string {
    this.tasks.pause(task.id);
    this.claims.release(task.topic, task.owner);
    const mins = Math.max(1, Math.round((this.now() - task.started) / 60_000));
    const stuck = stuckText.replace(/\s+/g, " ").trim().slice(0, 60) || B.brain.stuckReasonUnclear;
    this.record(task.owner, "note", B.brain.taskPausedNote(task.topic, mins, stuck));
    this.log.info("background task paused", { topic: task.topic, owner: task.owner, mins });
    return stuck;
  }

  /** 做着做着停住了：先放下，告诉自己一声（10-31 19:08 线上：空转后悄悄放下，没人知道） */
  private shelve(task: TaskRow, stuckText: string): void {
    this.wakeMain(P.shelved(task.topic, this.pauseTask(task, stuckText)), { cause: "side" });
  }

  /** 做太久的事：就算一直没有一轮结束（在等帮手、等人），到点也收回（review I1） */
  private sweepBackgrounds(): void {
    for (const t of this.tasks.doing()) {
      const r = this.regions.get(t.owner);
      if (!r || r.spec.role !== "side" || r.busy || this.looking.has(t.id)) continue;
      if (!overTime(t, this.now(), this.cfg.parallel.look.overFactor)) continue;
      const why = t.waitingFor ? B.brain.taskWaitingForPerson(t.waitingFor) : t.helpers.length ? B.brain.taskWaitingForHelper : "";
      if (t.bar) this.giveUp(t, t.missing ?? (why || B.brain.giveUpMissing), t.looks);
      else this.shelve(t, why);
    }
  }

  /** 认领表里没有对应「在做」的（旧的、重启前的、已经没有的那部分的）清掉，不然会挡住 on_it（review M8） */
  private cleanStaleClaims(): void {
    const doing = new Set(this.tasks.doing().map((t) => `${t.owner}\u0000${t.topic}`));
    for (const c of this.claims.list()) if (!doing.has(`${c.owner}\u0000${c.topic}`)) this.claims.release(c.topic, c.owner);
  }

  /** 换班（翻页、小睡）后：还在做的事接着做 */
  private resumeBackgrounds(): void {
    for (const t of this.tasks.doing()) {
      const r = this.regions.get(t.owner);
      if (!r || r.spec.role !== "side" || r.busy || this.looking.has(t.id)) continue;
      const mins = Math.max(1, Math.round((this.now() - t.started) / 60_000));
      this.wakeSide(r, B.brain.taskResumeAfterRotate(t.topic, mins), t);
    }
  }

  /**
   * 叫一边做的那头做这件事。会话开不起来（SessionOpenError）：这件放下、认领放掉、给她记一笔看得到的，返回 false；
   * 不再一直挂着「在做」（11-13 那次挂了 140 分钟，最后被当成做太久放下）。别的错照旧抛
   */
  private wakeSide(r: Region, text: string, task: TaskRow): boolean {
    try { r.wake(text); return true; } catch (e) {
      if (!(e instanceof SessionOpenError)) throw e;
      this.log.error("side: session would not open, task put down", { region: r.id, topic: task.topic, error: e.reason.slice(0, 200) });
      if (this.tasks.doing(task.owner).some((x) => x.id === task.id)) {
        this.tasks.pause(task.id);
        this.claims.release(task.topic, task.owner);
        this.record(task.owner, "note", P.sideNotOpened(task.topic));
      }
      return false;
    }
  }

  /** 夜里睡觉：后台的事先放下，第二天第一次叫醒前台时提一次 */
  private async pauseBackgroundsForNight(): Promise<void> {
    const paused: string[] = [];
    for (const t of this.tasks.doing()) {
      const side = this.regions.get(t.owner)?.spec.role === "side";
      const mins = Math.max(1, Math.round((this.now() - t.started) / 60_000));
      if (side) paused.push(B.brain.taskPausedForNight(t.topic, mins));          // 前台自己的也放下，只是不提（多半是忘了 done_with，review I3）
      this.tasks.pause(t.id);
      this.claims.release(t.topic, t.owner);
    }
    if (paused.length) kvSet(this.db, PAUSED_KEY, JSON.stringify(paused));
    for (const r of this.regions.values()) if ((r.spec.role === "side" || r.spec.role === "deep") && r.busy) await r.interrupt();
    // 正在回头看的也停下（事都放下了，看完也用不上）
    this.looking.clear();
    this.saveLooks();
    for (const r of this.lookRegions) await r.close();
    this.lookRegions.clear();
  }

  // ---------- 下意识思考（spec 10） ----------
  private deepInsightThisTurn = false;
  private deepRetryAt = 0;                 // 慢慢想的那头开不起来：到这个时刻之前不再试

  private deepQueue(): string[] {
    try { return JSON.parse(kvGet(this.db, DEEP_QUEUE_KEY) ?? "[]") as string[]; } catch { return []; }
  }

  /** 放着慢慢想：排进队；下意识空着就马上开始想第一件 */
  private mullOver(what: string): string {
    kvSet(this.db, DEEP_QUEUE_KEY, JSON.stringify([...this.deepQueue(), what]));
    if (kvGet(this.db, DEEP_CURRENT_KEY)) return B.brain.mullQueuedBusy;
    this.nextMull();
    // 那头刚才（或这次）开不起来：当场说没开始想，别让她以为在想（11-13）
    return this.now() < this.deepRetryAt ? P.MULL_NOT_STARTED : B.brain.mullStarted;
  }

  /** 开始想下一件：睡着、额度或电脑紧的时候先排着（tick 里再试，review I7） */
  private nextMull(): void {
    kvSet(this.db, DEEP_CURRENT_KEY, "");
    if (this.sleeping || this.alertness === "asleep" || this.gated()) return;
    if (this.now() < this.deepRetryAt) return;   // 那头开不起来：过一阵再试
    const [next, ...rest] = this.deepQueue();
    if (!next) return;
    // 先把会话开起来：开不起来就还排着、不算在想，隔一阵再试
    const why = this.region("deep").tryOpen();
    if (why !== null) { this.deepWouldNotOpen(next, why, false); return; }
    kvSet(this.db, DEEP_QUEUE_KEY, JSON.stringify(rest));
    kvSet(this.db, DEEP_CURRENT_KEY, next);
    kvSet(this.db, DEEP_STARTED_KEY, String(this.now()));
    this.deepIdle = 0;
    this.deepTurns = 0;
    const wake = P.mullOver(next);
    if (!this.notesOn()) { this.wakeDeep(wake, next); return; }
    void this.notesFor(next, "mull_over", "deep").then((notes) => {
      // 等笔记的这一会儿可能已经睡了、换了一件在想：不叫（醒来后 resumeDeep 接着想）
      if (kvGet(this.db, DEEP_CURRENT_KEY) !== next || this.sleeping || this.alertness === "asleep") return;
      this.wakeDeep(notes ? `${wake}\n${notes}` : wake, next);
    });
  }

  /** 叫慢慢想的那头想 what；会话开不起来：放回队首、不算在想，隔一阵再试。别的错照旧抛 */
  private wakeDeep(text: string, what: string): void {
    try { this.region("deep").wake(text); } catch (e) {
      if (!(e instanceof SessionOpenError)) throw e;
      this.deepWouldNotOpen(what, e.reason, true);
    }
  }

  /** 慢慢想的那头开不起来：what 还排着（taken = 已经从队里取出来了，放回队首），手上不算在想，DEEP_RETRY_MS 后再试 */
  private deepWouldNotOpen(what: string, reason: string, taken: boolean): void {
    this.log.error("deep: session would not open, kept in the queue", { what, error: reason.slice(0, 200) });
    if (taken) kvSet(this.db, DEEP_QUEUE_KEY, JSON.stringify([what, ...this.deepQueue()]));
    kvSet(this.db, DEEP_CURRENT_KEY, "");
    this.deepRetryAt = this.now() + DEEP_RETRY_MS;
  }

  /** 重启、醒来后：没想完的接着想；没在想、队里有的就开始（tick=true 时只补开始） */
  private resumeDeep(tick: boolean): void {
    const deep = this.regions.get("deep");
    if (!deep || deep.busy || this.sleeping || this.alertness === "asleep") return;
    const current = kvGet(this.db, DEEP_CURRENT_KEY);
    if (!current) { if (this.deepQueue().length) this.nextMull(); return; }
    if (!tick) this.wakeDeep(B.brain.mullResume(current), current);
  }

  /** 想了太久或空转：放下，留一句她看得到的 */
  private giveUpMull(current: string): void {
    this.log.info("deep: giving up", { what: current });
    this.record("deep", "note", B.brain.mullGaveUp(current));
    this.nextMull();
  }

  private deepIdle = 0;
  private deepTurns = 0;

  /** 下意识一轮结束：想通了（记下结论）就接下一件；没想完就接着想，连着三轮没动静就放下 */
  private afterDeepTurn(r: Region, ev: Extract<KernelEvent, { type: "turn-end" }>): void {
    const current = kvGet(this.db, DEEP_CURRENT_KEY);
    if (!current) return;
    if (this.deepInsightThisTurn) { this.deepInsightThisTurn = false; this.nextMull(); return; }
    if (this.sleeping || this.alertness === "asleep") return;   // 睡觉时打断的：手上那件留着，醒来接着想
    this.deepTurns += 1;
    const started = Number(kvGet(this.db, DEEP_STARTED_KEY) ?? this.now());
    if (this.now() - started > DEEP_MAX_MS || this.deepTurns > DEEP_MAX_TURNS) { this.giveUpMull(current); return; }
    if ((ev.background ?? 0) > 0) return;                     // 它派的帮手还在跑：等交回
    this.deepIdle = r.toolsThisTurn > 0 ? 0 : this.deepIdle + 1;
    if (this.deepIdle >= 3) { this.giveUpMull(current); return; }
    this.later(() => { if (kvGet(this.db, DEEP_CURRENT_KEY) === current && !r.busy && !this.sleeping) this.wakeDeep(B.brain.mullContinue(current), current); }, CONTINUE_GAP_MS);
  }

  /** 想通了：叫前台（结论在它的记忆增量里） */
  private afterInsight(): void {
    this.deepInsightThisTurn = true;
    this.wakeMainSoon(P.INSIGHT, "insight");
  }

  /**
   * 同时在做的几句：事情、帮手、谁在聊变了才给，没变的隔 30 分钟再给一次（11-02：「做了 N 分钟」每次都变，
   * 按原文比等于每轮都给）。前缀重建（翻页、睡醒）后从头算。
   * askOk：这一叫可以问她挂了一天多的帮手清不清（她自己醒来的那几轮；回人、有人找她的那一轮不问，夹在别人的话里容易略过去）。
   * 真叫醒了再调 seen()：问过的这才记下；叫醒抛错调 release()，下次照样问
   */
  private freshParallel(askOk: boolean): { text: string; seen: () => void; release: () => void } {
    const none = { text: "", seen: () => {}, release: () => {} };
    const now = this.now();
    const ask = askOk ? [...this.helpersBusy].filter(([name, since]) => now - since > HELPER_ASK_AFTER_MS && this.helpersAsked.get(name) !== since && this.helpersAsking.get(name) !== since) : [];
    const text = this.parallelContext(now, new Set(ask.map(([name]) => name))).join("\n");
    if (!text) return none;
    const sig = withoutVolatile(text);
    if (this.shownParallel && this.shownParallel.sig === sig && now - this.shownParallel.at < PARALLEL_EVERY_MS) return none;
    this.shownParallel = { sig, at: now };
    for (const [name, since] of ask) this.helpersAsking.set(name, since);
    const release = (): void => { for (const [name, since] of ask) if (this.helpersAsking.get(name) === since) this.helpersAsking.delete(name); };
    return {
      text,
      // 挂了一天多的帮手问过这一次了：以后回到「帮手在跑」里照常列着，不再问（她不清就是要留着）
      seen: () => { release(); if (ask.length) { for (const [name, since] of ask) this.helpersAsked.set(name, since); this.saveHelpers(); } },
      release,
    };
  }
  private shownParallel: { sig: string; at: number } | null = null;

  /** 前台每轮情境里：同时在做什么、最近谁发了几条；准头一天一次 */
  private parallelContext(now: number, ask: Set<string>): string[] {
    const bc = this.cfg.parallel.busyChat;
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.schedule.timezone }).format(now);
    const calibration = this.tasks.calibration();
    const showCalibration = !!calibration && kvGet(this.db, CALIB_DAY_KEY) !== day;
    if (showCalibration) kvSet(this.db, CALIB_DAY_KEY, day);
    const doing = this.tasks.doing();
    return parallelLines({
      doing: doing.filter((t) => this.regions.get(t.owner)?.spec.role === "side"),   // 前台自己手上的不算「同时在做」（review I3）
      helpers: [...this.helpersBusy].map(([name, since]) => ({ name, since, ...(this.tasks.ownerOfHelper(name) ? { topic: this.tasks.ownerOfHelper(name)!.topic } : {}), ...(ask.has(name) ? { ask: true } : {}) })),
      chat: chatActivity(this.central.chatSince(now - bc.windowMin * 60_000), now, bc),
      windowMin: bc.windowMin,
      calibration, showCalibration, now,
    });
  }

  /** 每天第一次叫醒前台时：昨天（及以前没说过的）修理小结，让她跟主人说话时顺带一句（不每件都发消息） */
  private takeRepairNote(): string {
    const tz = this.cfg.schedule.timezone;
    const today = localTime(this.now(), tz).day;
    if (kvGet(this.db, REPAIR_NOTE_DAY_KEY) === today) return "";
    kvSet(this.db, REPAIR_NOTE_DAY_KEY, today);
    const told = Number(kvGet(this.db, REPAIR_NOTE_TOLD_KEY) ?? 0);
    const events = readEvents(this.cfg.stateDir, told + 1).filter((e) => localTime(Date.parse(e.t), tz).day < today);
    const text = summarize(events, waitingIds(this.cfg.workspace));
    if (events.length) kvSet(this.db, REPAIR_NOTE_TOLD_KEY, String(Math.max(...events.map((e) => Date.parse(e.t)))));
    return text ? B.brain.repairNoteForOwner(text) : "";
  }

  /**
   * 有一轮最后写的话没人收：自己醒的这一轮告诉她（回人的那一轮不夹，那一轮最后写的话是要发给他的）；
   * 一小时最多一次，这期间再有的不攒着
   */
  private takeUnsentHint(): string {
    if (!this.unsentReply) return "";
    this.unsentReply = false;
    if (this.now() - this.unsentHintAt < UNSENT_HINT_GAP_MS) return "";
    this.unsentHintAt = this.now();
    return this.hasChannels() ? P.UNSENT_REPLY_HINT : P.UNSENT_REPLY_HINT_KEEP;
  }

  /** 第二天第一次叫醒前台时提一次昨晚放下的事 */
  private takeOvernightNote(): string {
    let list: string[] = [];
    try { list = JSON.parse(kvGet(this.db, PAUSED_KEY) ?? "[]") as string[]; } catch { list = []; }
    if (!list.length) return "";
    kvSet(this.db, PAUSED_KEY, "[]");
    return B.brain.overnightNote(list.join(B.brain.overnightNoteSep));
  }

  /** 下意识注意到值得认真对待的事：叫主线好好想 */
  private thinkItOver(from: string, what: string): string {
    const refs = this.senseRefs(from, true);
    this.wakeMain(P.thinkItOver(`${what}${refs}`), { record: () => this.record(from, "think", B.brain.thinkItOverRecord(what, refs)), cue: what, cause: "subconscious" });
    return B.brain.thinkItOverAck;
  }

  /** 感官的动静先到下意识（有的话） */
  private senseRegion(): string | undefined {
    return [...this.regions.values()].find((r) => r.spec.role === "perception")?.id;
  }

  // ---------- 外界 ----------
  inbound(ev: Inbound): "delivered" | "queued" {
    // a role connected to no channel answers a tell on this machine: its reply goes back to whoever told (hh tell prints it)
    if (ev.channel === P.LOCAL_CHANNEL && !ev.replyTo && !this.hasChannels()) ev = { ...ev, replyTo: { channel: P.LOCAL_CHANNEL, target: ev.from, name: ev.from } };
    const route = this.thalamus.route(ev, this.alertness === "asleep");
    // 闸门接手的不算她有事：进总结、丢掉的她根本没看到（群里刷屏不能让她一直睡不着、放空不了）；送到她面前时叫醒自会算
    const toGate = ev.from === "感官" && this.gate !== undefined;
    if (!toGate) this.lastActivity = this.now();
    if (route.kind === "queue") {
      this.log.info("queued while asleep", { from: ev.from });
      return "queued";
    }
    // 闸门开着：感官事件全交给它（落库就算接手，它自己按 id 去重、分流）；帮手的回报它再从 gateToHands 交回来
    if (toGate && this.gate) {
      this.gate.receive(ev.events?.length ? ev.events : parseSenses(ev.text));
      return "delivered";
    }
    return this.deliverInbound(ev, route.region, false);
  }

  /** 送进脑区。gated：闸门交回的帮手回报（它已经去过重，不再用老的 id 去重） */
  private deliverInbound(ev: Inbound, region: string, gated: boolean): "delivered" {
    const sense = ev.from === "感官";
    // 一批里有好几个帮手的回报：按条拆开，各回给派它的那份心思（只认第一个的话，别的那件事会一直等帮手）
    if (sense) {
      const [head, ...items] = ev.text.split(/\n(?=- \[cc id=)/);
      if (items.length > 1) {
        const title = head!.split("\n")[0]!;   // 别的条目（不是帮手的）只跟第一份走，不重复
        items.forEach((it, i) => this.deliverInbound({ ...ev, text: `${i === 0 ? head : title}\n${it}` }, region, gated));
        return "delivered";
      }
    }
    const ids = sense ? senseIds(ev.text) : [];
    if (sense && !gated && this.senseKnown(ids)) {
      this.log.info("sense already seen, skipped", { ids });
      return "delivered";
    }
    if (!gated) for (const id of ids) this.senseInflight.add(id);
    // Claude Code 帮手的回报直接给主线：活是主线派的，结果也由主线接（下意识插手会跟主线打架）
    const fromHands = sense && /\[cc id=/.test(ev.text);
    // 帮手回报给派它的那部分（那件事还在做的话）；不然给前台
    const helper = fromHands ? helperOf(ev.text) : null;
    if (helper) this.helperDone(helper);
    const helperTask = helper ? this.tasks.ownerOfHelper(helper) : undefined;
    const helperOwner = helperTask && helperTask.owner !== "main" && this.regions.has(helperTask.owner) ? helperTask.owner : null;
    // 群里有人 @她：直接给前台，排在前面（算高优先级；以前下意识看一眼就放下或挂着，11-01 22:23 那条 21 分钟后才回）
    const mention = sense && !fromHands && mentionsMe(ev.text, this.cfg.names);
    // 感官层自己标了「…·要你处理」的（比如手机断网半小时以上、修不好）：也直接给前台，分拣看一眼就放下的不行（11-03）
    const forMe = sense && !fromHands && asksForMe(ev.text, sourcesOf(this.cfg).probe);
    const target = helperOwner ?? ((sense && !fromHands && !mention && !forMe && this.senseRegion()) || region);
    // 感官原文只给处理它的下意识看，存档、不同步给主意识（记忆里只留处理后的）；帮手回报照给，别人看开头
    const senseMeta: Record<string, unknown> = !sense ? {}
      : fromHands ? { hands: true, owner: target, ...(helper ? { helper } : {}), senseIds: ids }
      : target !== "main" ? { inner: true, for: target, senseIds: ids } : { senseIds: ids };
    // 真人的消息、她排的提醒：送到前先记下，重启了接着送（提醒以前只在内存里压着，重启就没了）
    const pendingId = (ev.human || ev.channel === "internal") && region === "main" ? this.pendingAdd(ev) : null;
    const humanCtx: HumanContext | undefined = target === "main" && ev.human
      ? { person: this.currentPeople().identify(ev.senderId, ev.sessionKey), text: ev.text, said: ev.replyTo ? this.saidTo(ev.replyTo.target) : [], ...(ev.group ? { group: true } : {}) }
      : undefined;
    const record = () => {
      const e = this.record("外界", "input", ev.text, { from: ev.from, channel: ev.channel ?? null, human: ev.human, replyTo: ev.replyTo ?? null, ...(ev.tag ? { tag: ev.tag } : {}), ...senseMeta });
      // 别人发来的（帮手的回报给派活的那份）也认；只给下意识看的感官原文不认
      if (senseMeta.inner !== true) this.recognizeIn(target, ev.text);
      if (humanCtx) humanCtx.seq = e.seq;   // 记纠正时按这条消息的编号去重
      if (senseMeta.inner === true) this.senseRaw.set(target, [...(this.senseRaw.get(target) ?? []), { seq: e.seq, ids }]);
      if (pendingId) this.pendingMark(pendingId);
      if (ids.length && !gated) this.senseMarkSeen(ids);
    };
    // 闸门交回的帮手回报：HH 接手时已经确认，不再叫她 ack（T9）
    const trigger = sense ? (gated ? P.handsTrigger() : target === "main" || fromHands ? P.senseTrigger() : P.senseGlance())
      : ev.channel === "internal" ? P.REMINDER_TRIGGER
      : P.inboundTrigger(ev.from, ev.replyTo, triggerWho(ev));
    if (target === "main") {
      // 联想笔记的话题是这条消息本身（提醒、感官的原话不在叫醒的那段说明里）；感官的去掉固定说明，帮手的回报带上它在做的那件事
      const cue = sense ? senseCue(this.folds.whole(ev.text, this.now()), (name) => this.tasks.ownerOfHelper(name)?.topic) : this.folds.words(ev.text, this.now());
      const cause: WakeCause = sense ? (gated || fromHands ? "helper" : "senses") : ev.channel === "internal" ? "reminder" : ev.human ? "human" : "message";
      // 别人的消息：叫醒时它的记录已经在前面送到她眼前了（她干活中途钩子补的、跟前一条一起送的），换这个开头（11-13）
      const shown = !sense && ev.channel !== "internal"
        ? { shownText: P.inboundTriggerShown(ev.from, ev.replyTo, triggerWho(ev), this.folds.words(ev.text, this.now())), shownUnsentText: P.inboundTriggerShown(ev.from, ev.replyTo, triggerWho(ev), this.folds.words(ev.text, this.now()), true) }
        : {};
      this.wakeMain(trigger, { human: ev.human, ...(mention ? { urgent: B.brain.groupMentionUrgent } : {}), ...(ev.replyTo ? { replyTo: ev.replyTo } : {}), record, cue, ...(humanCtx ? { humanCtx } : {}), cause, ...shown, ...(pendingId ? { pendingId } : {}) });
    } else {
      record();
      this.region(target).wake(trigger, { human: ev.human });
    }
    if (ev.human) this.wakeWaitingFor(ev.from);
    return "delivered";
  }

  // ---------- 潜意识门的两个出口（11-03） ----------
  /** 帮手的回报：照老路给派活的那份心思（交回、感官层那句说明、联想话题都一样），只是从闸门进来 */
  private gateToHands(ev: SenseEvent): void {
    this.lastActivity = this.now();   // 帮手交回来了：算有事（交给一边做着的那份心思时，脑区的动静不算）
    this.deliverInbound({ from: "感官", channel: "senses", text: B.brain.senseGateToHands(ev.line), human: false, events: [ev] }, "main", true);
  }

  /**
   * 还没送到她面前的那一次闸门叫醒（压着等这一轮完、睡着了）。这期间闸门再交来的都并进它，一次叫醒全带上
   * （final review I2：忙的时候来六批就叫六轮 Opus）。送到（record）就关上，之后来的另起一次。
   * key：有人找她时按谁算（gateConvKey），null 是不急的；waking：叫醒已经发出去（送到了或压着等这一轮）；rerun：压着的那条到点就跑它
   */
  private gateOpen: GateBatch | null = null;

  /** 要马上给主意识的一批：先记进 kv（压着等这一轮、睡着、重启都不丢）；还有没送到的那次叫醒就并进去 */
  private gateToMain(items: Delivery[]): void {
    if (!items.length) return;
    const open = this.gateOpen;
    if (!open) {
      const batch: GateBatch = { id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`, items: [...items], key: null, waking: false, rerun: () => this.wakeForGate(batch) };
      this.gateOpen = batch;
      this.gatePendingPut(batch);
      this.wakeForGate(batch);
      return;
    }
    open.items.push(...items);
    this.gatePendingPut(open);
    const pri = items.find((d) => d.priority);
    // 压着的是不急的那种、这次有人找她：换成有人找她的叫醒（排在前面、等久了打断）
    if ((pri && open.key === null) || !open.waking) { this.wakeForGate(open); return; }
    // 已经是有人找她的：在等她回的再记一个人（工具调用之后提醒她）
    const main = this.regions.get("main");
    if (pri && main && (main.busy || this.mainPreparing > 0)) this.mainWaiting.push({ conv: open.key!, who: gateWho(pri, this.cfg.senses?.labels), nudged: false });
  }

  /** 叫醒她看这一批（文字、联想话题、优先级都按现在攒着的算）；睡着不叫，留在 kv 里醒来再送 */
  private wakeForGate(batch: GateBatch): void {
    if (this.gateOpen !== batch) return;   // 已经送到了（压着的那条后来又跑了一次）
    this.gateHeldDrop(batch);              // 之前压着的那条作废，下面按现在攒的重新叫
    batch.waking = false;
    if (this.alertness === "asleep") return;
    const items = batch.items;
    const pri = items.find((d) => d.priority);
    batch.key = pri ? gateConvKey(pri) : null;
    const record = () => {
      this.gateOpen = null;
      this.gateHeldDrop(batch);
      for (const d of items) this.gateSeen(d, this.gateRaw(d));
      this.gatePendingSave(this.gatePendingList().filter((p) => p.id !== batch.id));
    };
    const who = [...new Set(items.filter((d) => d.priority).map((d) => gateWho(d, this.cfg.senses?.labels)))].join(B.brain.senseGateWhoSep);
    try {
      // 不急的不插话：她在忙自己的一轮就等这一轮完（插话会被内核包成英文的 new message）；
      // 有人找她的照真人消息的规矩：按谁算会话，压着、等久了打断，不插进她自己的那一轮（M2）
      this.wakeMain(P.senseSeen(items.length), {
        ...(pri ? { urgent: pri.urgent ?? B.brain.senseGateWhoDefault, conv: batch.key!, who } : {}),
        record, cue: this.gateCue(items[0]!), noInterject: !pri, rerun: batch.rerun, gate: true, cause: "gate",
      });
      batch.waking = this.gateOpen === batch;
    } catch (e) {
      // 叫醒出错（T9）：还在 kv 里；下一批交来、醒来、重启都会再叫
      this.log.error("gate: wake failed, kept for retry", { id: batch.id, error: String(e).slice(0, 200) });
    }
  }

  /** 这一批压着的叫醒（按 rerun 认）拿掉 */
  private gateHeldDrop(batch: GateBatch): void {
    for (let i = this.heldForMain.length - 1; i >= 0; i--) if (this.heldForMain[i]!.run === batch.rerun) this.heldForMain.splice(i, 1);
  }

  /** 醒来、重启后：kv 里还没送到的并成一次接着送（这个进程里正在送的不重复）。闸门关了（回滚）也送：已经接手了 */
  private resumeGated(): void {
    const open = this.gateOpen;
    const rest = this.gatePendingList().filter((p) => p.id !== open?.id && Array.isArray(p.items) && p.items.length);
    if (rest.length) {
      const items = rest.flatMap((p) => p.items);
      if (open) open.items.push(...items);
      else {
        const batch: GateBatch = { id: rest[0]!.id, items, key: null, waking: false, rerun: () => this.wakeForGate(batch) };
        this.gateOpen = batch;
      }
      this.gatePendingSave([{ id: this.gateOpen!.id, items: this.gateOpen!.items }]);
    }
    if (this.gateOpen && !this.gateOpen.waking) this.wakeForGate(this.gateOpen);
  }

  private gatePendingList(): Array<{ id: string; items: Delivery[] }> {
    try {
      const v = JSON.parse(kvGet(this.db, GATE_PENDING_KEY) ?? "[]") as unknown;
      return Array.isArray(v) ? (v as Array<{ id: string; items: Delivery[] }>) : [];
    } catch { return []; }
  }

  /** 写不进 kv 不能把这一批弄丢（final review I3）：记日志，照样记进记忆、照样叫醒；只是重启就接不上了 */
  private gatePendingSave(list: Array<{ id: string; items: Delivery[] }>): void {
    try { kvSet(this.db, GATE_PENDING_KEY, JSON.stringify(list)); } catch (e) {
      this.log.error("gate: cannot save pending batches", { n: list.length, error: String(e).slice(0, 200) });
    }
  }

  /** 这一批在 kv 里的那条换成现在的（没有就加上） */
  private gatePendingPut(batch: { id: string; items: Delivery[] }): void {
    const list = this.gatePendingList().filter((p) => p.id !== batch.id);
    this.gatePendingSave([...list, { id: batch.id, items: batch.items }]);
  }

  /**
   * 她看得到的那句。判过的先记原文（只存档：标 inner、谁都不同步，要看用 recall 翻），那句写 gist、来源、原文编号；
   * 没判过的（固定直达、退回）那句就是原文，不再另存一条一样的（T9）
   */
  private gateRaw(d: Delivery): string {
    if (!d.gist) return this.gateText(d, null);
    const raw = this.record("外界", "input", d.ev.line, { from: "感官", channel: "senses", inner: true, for: "gate", senseIds: [d.ev.id] });
    return this.gateText(d, raw.seq);
  }

  /** 她看得到的那句：判过的写 gist、来源（聊天来源带上原文里写的回法）、原文编号；固定直达的照原文，退回的照原文注明没细看 */
  private gateText(d: Delivery, rawSeq: number | null): string {
    // 显示名谁都能改：认出来也只说是按显示名认的（关系不写「主人本人」）
    const by = d.who?.byDisplayName ? B.brain.senseIdentifiedByDisplayName(srcName(d.ev.src, this.cfg.senses?.labels)) : "";
    if (d.gist) {
      // 判过的那句里没有原文的（do）了：聊天来源把怎么回带上，不然她不知道该去哪个 app 回（I1）
      const how = sourcesOf(this.cfg).chat.has(d.ev.src) || sourcesOf(this.cfg).public.has(d.ev.src) ? withoutAck(d.ev.do ?? "").replace(/[。.]+$/, "") : "";
      return B.brain.senseGateLine(d.gist, this.strangerHint(d), d.ev.conv ?? srcName(d.ev.src, this.cfg.senses?.labels), by ? B.brain.senseGateByNote(by) : "", how ? B.brain.senseGateHowNote(how) : "", rawSeq);
    }
    const line = this.gateOriginal(d.ev);
    if (d.fallback) return B.brain.senseGateFallbackLine(line);
    return by ? B.brain.senseGateLineWithBy(line, by) : line;
  }

  /** 没判过的原文：开头的 [src id=…] 换成平台名，原文里的办法去掉 ack 那句（HH 已经确认过了） */
  private gateOriginal(ev: SenseEvent): string {
    if (!SENSE_HEAD.test(ev.line)) return ev.line;   // 纯文字（plain）原样
    // 库里的 ev 坏了、从列里拼回来的：text 就是整行，只换开头
    if (SENSE_HEAD.test(ev.text)) return ev.text.replace(SENSE_HEAD, `[${srcName(ev.src, this.cfg.senses?.labels)}] `);
    const d = ev.do ? withoutAck(ev.do) : "";
    return buildLine(ev.src, ev.id, ev.text, d || undefined, ev.body).replace(SENSE_HEAD, `[${srcName(ev.src, this.cfg.senses?.labels)}] `);
  }

  /** 记她看得到的那句，闸门账上记下是哪条。src=main：叫醒文字里已经给过了，不再回灌给主意识 */
  private gateSeen(d: Delivery, text: string, src = "外界"): void {
    const e = this.record(src, "input", text, { from: "感官", channel: "senses", senseIds: [d.ev.id], gate: d.rowId });
    if (d.rowId > 0) this.gate?.markDelivered([d.rowId], e.seq);
  }

  /** 陌生人私聊判了 main、名字和事件库里的一个人对得上：提醒她可以加进认识的人（spec §4.8 第 4 条，甄有才就是伯伯） */
  private strangerHint(d: Delivery): string {
    const { src, conv, isGroup } = d.ev;
    if (!this.mem || !conv || isGroup === true || d.who || !sourcesOf(this.cfg).chat.has(src)) return "";
    try {
      if (this.currentPeople().identifyHandle(src, conv)) return "";
      const e = this.mem.store.entity(conv);
      // 像的是主人：不提（不把陌生人说成像主人，主人也不能经 people_i_know 加，final-review N2）
      return e?.kind === "person" && !this.mem.store.isOwner(e) ? B.brain.senseStrangerHint(e.name) : "";
    } catch { return ""; }
  }

  /** 联想的话题：判过的用 gist，没判的去掉 [xx id=…] 和时间；只看这一条 */
  private gateCue(d: Delivery): string {
    if (d.gist) return d.gist.slice(0, GATE_CUE_CHARS);
    const wrapped = B.brain.senseCueWrapped(d.ev.line);
    const c = senseCue(wrapped, (name) => this.tasks.ownerOfHelper(name)?.topic);
    return (c === wrapped ? d.ev.text : c).slice(0, GATE_CUE_CHARS);
  }

  /** 跟着某次叫醒走、还没记进记忆的 work / leisure（闸门的行号）：别的叫醒别再取 */
  private readonly alongTaken = new Set<number>();

  /**
   * 不是真人消息的醒来：攒着的 work 附在后面（「顺便看到」）；放空那次再给 leisure 的「待看」。
   * 原文先记（只存档）；她看得到的那句等叫醒送进去以后再记、记成 main 的（叫醒文字里有了，记忆里不再给她一遍）
   */
  private takeAlong(leisure: boolean): { text: string; seen: () => void; release: () => void } | null {
    const gate = this.gate;
    if (!gate) return null;
    const n = Math.max(0, Math.floor(this.cfg.gate.attachMax));
    const take = (kind: "work" | "leisure") => gate.takeQueued(kind, n + this.alongTaken.size).filter((d) => !this.alongTaken.has(d.rowId)).slice(0, n);
    const work = take("work");
    const free = leisure ? take("leisure") : [];
    if (!work.length && !free.length) return null;
    const prep = (ds: Delivery[]) => ds.map((d) => { this.alongTaken.add(d.rowId); return { d, text: this.gateRaw(d) }; });
    const w = prep(work);
    const f = prep(free);
    const list = (xs: Array<{ text: string }>) => xs.map((x) => (x.text.startsWith("- ") ? x.text : `- ${x.text}`)).join("\n");
    const text = [w.length ? B.brain.senseAlongWork(list(w)) : "", f.length ? B.brain.senseAlongFree(list(f)) : ""].filter(Boolean).join("\n");
    return {
      text,
      seen: () => { for (const x of [...w, ...f]) { this.alongTaken.delete(x.d.rowId); this.gateSeen(x.d, x.text, "main"); } },
      release: () => { for (const x of [...w, ...f]) this.alongTaken.delete(x.d.rowId); },
    };
  }

  /** 小判断：她的人格卡 + 现在在做 + 这一批。内核没有一次性调用就抛错，闸门退回直达 */
  private async judgeSenses(items: JudgeItem[], context: (conv: string, src: string) => string[]): ReturnType<JudgeFn> {
    const ask = this.driver.ask?.bind(this.driver);
    if (!ask) throw new Error(B.brain.gateNoAsk);
    const g = this.cfg.gate;
    const goals = this.situation ? await this.situation.moduleParts().catch(() => "") : "";
    return judgeBatch({
      ask,
      card: buildCard({ workspace: this.cfg.workspace, stateDir: this.cfg.stateDir, files: g.card.soul, midterm: g.card.midterm, midtermMaxChars: g.card.midtermMaxChars, names: this.cfg.names, readFile: this.readText }),
      nowDoing: nowDoing(this.tasks.doing(), goals),
      items, context,
      // 比闸门自己的超时早一点：先让这次调用自己收掉
      base: { model: this.cfg.models.haiku, cwd: this.cfg.workspace, env: kernelEnv(this.cfg), claudeExecutable: this.cfg.kernel.claudeExecutable, timeoutMs: Math.max(1_000, g.judgeTimeoutMs - 5_000) },
    });
  }

  /** 感官层的事件日志（配置 senses.logFile，相对工作区；ts 是秒）里 [a, b) 毫秒这一段；坏行跳过；没配、读不到返回 null */
  private senseLog(a: number, b: number): Array<{ ev: SenseEvent; ms: number; t: string }> | null {
    const raw = this.cfg.senses?.logFile ? this.readText(join(this.cfg.workspace, this.cfg.senses.logFile)) : null;
    if (raw === null) return null;
    const out: Array<{ ev: SenseEvent; ms: number; t: string }> = [];
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      let o: unknown;
      try { o = JSON.parse(l); } catch { continue; }   // 坏行跳过
      if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
      const r = o as Record<string, unknown>;
      const ms = typeof r.ts === "number" ? r.ts * 1000 : NaN;
      if (!(ms >= a && ms < b)) continue;
      for (const ev of parseSenses("", [r])) out.push({ ev, ms, t: typeof r.t === "string" ? r.t : new Date(ms).toISOString() });
    }
    return out;
  }

  /** what_reaches_me try：最近几天的真动静，同一个 id 只算一次（和闸门一样，plain / hh-quota 除外） */
  private recentSenses(days: number): SenseEvent[] | null {
    const log = this.senseLog(this.now() - days * 86_400_000, Infinity);
    if (log === null) return null;
    const seen = new Set<string>();
    return log.map((x) => x.ev).filter((ev) => {
      if (NO_UPSTREAM_ID.has(ev.src)) return true;
      if (seen.has(ev.id)) return false;
      seen.add(ev.id);
      return true;
    });
  }

  /** hh gate replay：拿事件日志（senses.logFile）里 [from, to) 这一段重判一遍，只判不送、不记账（小判断照调） */
  async gateReplay(from: string, to: string): Promise<Array<{ t: string; src: string; text: string; route: string; rule: string | null; verdict?: string; when?: string; gist?: string; why?: string; unsure?: boolean }>> {
    if (!this.gate) throw new Error(B.brain.gateReplayGateOff);
    const a = Date.parse(from);
    const b = Date.parse(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(B.brain.gateReplayUsage);
    const log = this.senseLog(a, b);
    if (log === null) throw new Error(B.brain.gateReplayUnreadable(this.cfg.senses?.logFile || B.brain.gateReplayEventsFileUnset));
    const evs = log.map((x) => x.ev);
    const label = new Map(log.map((x) => [x.ev, x.t]));
    const out = await this.gate.replay(evs, log.map((x) => x.ms));
    return out.map((r) => ({
      t: label.get(r.ev) ?? "", src: r.ev.src, text: r.ev.text.slice(0, 200), route: r.route, rule: r.rule,
      ...(r.verdict ? { verdict: r.verdict.verdict, when: r.verdict.when, gist: r.verdict.gist, why: r.verdict.why, ...(r.verdict.unsure ? { unsure: true } : {}) } : {}),
    }));
  }

  // ---------- 重启不丢真人消息 ----------
  private pendingList(): Array<{ id: string; at: number; ev: Inbound; delivered: boolean }> {
    try { return (JSON.parse(kvGet(this.db, PENDING_KEY) ?? "[]") as Array<{ id: string; at: number; ev: Inbound; delivered: boolean }>) ?? []; } catch { return []; }
  }

  private pendingSave(list: Array<{ id: string; at: number; ev: Inbound; delivered: boolean }>): void {
    kvSet(this.db, PENDING_KEY, JSON.stringify(list));
  }

  private pendingAdd(ev: Inbound): string {
    const id = `${this.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingSave([...this.pendingList(), { id, at: this.now(), ev, delivered: false }]);
    return id;
  }

  private pendingMark(id: string): void {
    this.pendingSave(this.pendingList().map((p) => (p.id === id ? { ...p, delivered: true } : p)));
  }

  private pendingDropDelivered(): void {
    // 记下了但叫醒还压着的（同一个人在她忙时又来的话）不算回完：重启了还要接着叫（复核 11-13）
    const held = new Set([...this.mergedHeld.values()].flatMap((m) => m.pendingIds));
    const list = this.pendingList();
    if (list.some((p) => p.delivered && !held.has(p.id))) this.pendingSave(list.filter((p) => !p.delivered || held.has(p.id)));
  }

  /** 重启前没回完的真人消息：送到了的叫她接着回（原话已经在记忆里），没送到的重新送 */
  private resumePendingHuman(): void {
    const list = this.pendingList().filter((p) => this.now() - p.at < PENDING_MAX_AGE_MS);
    this.pendingSave([]);
    if (!list.length) return;
    this.log.info("resuming human messages interrupted by a restart", { count: list.length });
    for (const p of list) {
      if (p.delivered) {
        const ev = p.ev;
        const pendingId = this.pendingAdd(ev);
        const internal = ev.channel === "internal";   // 她排的提醒
        this.wakeMain(`${P.RESUMED_AFTER_RESTART}\n${internal ? P.REMINDER_TRIGGER : P.inboundTrigger(ev.from, ev.replyTo, triggerWho(ev))}`, {
          human: !internal, ...(ev.replyTo ? { replyTo: ev.replyTo } : {}), record: () => this.pendingMark(pendingId), cue: ev.text, cause: internal ? "reminder" : "human", resumed: true,
        });
      } else {
        this.inbound(p.ev);
      }
    }
  }

  /**
   * 叫主线。她这一轮在跟谁说话（或者在自己想事），同一件事的新话直接并进来；
   * 别的事（另一个人的消息、自己心里冒出来的事）先等这一轮说完——不然那一轮的话会发错人。
   * 真人的消息等了 HOLD_MAX_MS 还没轮到，就把手上这一轮打断（像人抬头先回话）。
   * record 在真正送到时才记，免得她这一轮中途就看到。
   * cue：拿来联想笔记的话。只有 spec 5.1 列的几种叫醒给：有人来消息、提醒、感官和下意识报上来的事（都是那件事的原话）、
   * 一段专注开始（专注的那段话）；接着做、放空、做完了这类 HH 自己的说明不给，不联想（每次都要花一次判断，还会挂上不相干的页）。
   * noInterject：闸门送来的不急的动静，她在忙（或在准备叫醒）就等这一轮完，不并进这一轮。
   * leisure：放空那次醒来，除了 work 再附上闸门攒的「待看」。
   * conv / who：闸门送来的有人找她（没有 replyTo）按谁算会话、提醒她时说谁在等（M2）；rerun：压着到点时跑它（闸门按到那时攒的重新叫）；
   * gate：闸门的叫醒（记进每天的次数）
   * cause：是什么叫醒的，真叫醒时记一行 main wake（周表按它数被叫醒的次数，不靠叫醒话的中文开头认）；resumed：重启后接着回压着的那条；
   * 并进正在跑的一轮的记 merged（周表要数「叫醒了几轮」时去掉它们，闸门复核 2ad15c64）
   * 同一个人的真人消息、她这一轮还在忙：只记下，叫醒等这一轮结束（holdMerged）。
   * shownText：叫醒时这条的记录已经在前面送到她眼前了（钩子补的、跟前一条一起送的）换用的开头，不说「上面记忆最后一条」；recordedSeq：这条记下的编号（压着的那条叫醒时带）
   */
  /** Whether this role is connected to any channel (config channels) */
  private hasChannels(): boolean {
    return Object.keys(this.cfg.channels).length > 0;
  }

  private wakeMain(text: string, opts: WakeOpts = {}): void {
    // connected to no channel: what the role would send it keeps for the owner's next word instead
    if (!this.hasChannels()) text = text.replaceAll(P.VIA_MESSAGE, P.VIA_KEEP);
    const main = this.region("main");
    const conv = (r: Inbound["replyTo"]) => (r ? `${r.channel}:${r.target}` : "");
    const key = opts.conv ?? conv(opts.replyTo);
    const priority = Boolean(opts.human || opts.urgent);   // 真人的消息、群里 @她：排在前面，等久了打断
    const busy = main.busy || this.mainPreparing > 0;
    if (busy && priority) this.mainWaiting.push({ conv: key, who: opts.who || opts.urgent || opts.replyTo?.name || opts.replyTo?.target || B.brain.mainWaitingWhoDefault, nudged: false });
    // 同一件事并进这一轮：同一个人的真人消息；闸门送来的、她这一轮已经在看的那个人
    const same = key === conv(this.mainReplyTo) || (opts.conv !== undefined && this.mainGateConvs.has(opts.conv));
    if (busy && same && !opts.noInterject && opts.humanCtx && opts.record) { this.holdMerged(key, text, opts); return; }
    if (busy && (opts.noInterject || !same)) {
      const held = { human: priority, conv: key, run: opts.rerun ?? (() => this.wakeMain(text, opts)) };
      this.heldForMain.push(held);
      if (priority) {
        // 只管自己这条：已经放进去了就不打断；她这一轮正在回真人（含闸门送来的人）也不打断（打断了那一轮的话就不发了，11-01 22:36）
        this.later(() => {
          if (this.heldForMain.includes(held) && main.busy && !this.mainTarget() && this.mainGateConvs.size === 0) {
            this.log.info("interrupting main for a waiting message");
            this.taskCut = this.tasks.doing("main").length > 0;
            main.interrupt().catch(() => {});
          }
        }, HOLD_MAX_MS);
      }
      return;
    }
    opts.record?.();
    // 「最近说过的话」在真叫醒的这一刻现取（#0051 11-09：消息进来时就取好了，压着等的、或者赶在上一轮的气泡还在一条条发时进来的，
    // 都少了刚发的那几句，她以为没发出去，同一句给一个朋友补发了三遍）
    if (opts.humanCtx && opts.replyTo) opts.humanCtx.said = this.saidTo(opts.replyTo.target);
    if (opts.replyTo) this.mainReplyTo = opts.replyTo;
    if (opts.conv) this.mainGateConvs.add(opts.conv);
    // 修理的小结里有主人的原话：只在跟主人说话的那一轮带
    const withOwner = !!opts.replyTo && personOfTarget(this.currentPeople(), opts.replyTo.target)?.privacy === "owner";
    // 主线上一轮被停过、还在等安静了再换（④）：这就换，别把这一条送进被停过的会话（rotate 同步就把会话摘掉了，下面照新会话来）
    if (main.pendingRotate && !main.busy && !this.turn && !this.sleeping) {
      void main.rotate();
      this.learning?.notes.prefixRebuilt(main.id);   // 跟 rotateRegion 一样，只是要在这一叫之前做完
    }
    // 这一叫会开新会话（换班后、会话断了）：附带的东西从头给（旧会话看过的新会话没看过）
    if (!main.open) { this.shownParallel = null; this.situation?.newMainSession(); }
    // 不是真人消息的醒来（专注、手上的事、提醒、感官、放空）：闸门攒着的 work 顺带给，放空那次再给 leisure；接在最后
    const along = opts.human || opts.replyTo ? null : this.takeAlong(opts.leisure === true);
    if (opts.gate || along) this.countGateWake();
    // 上一次回复没全发出去的、用了她记下的词的：哪种叫醒都附；没发全的那一行按这一轮回不回那个人换说法（F-1）
    const hint = this.takeWakeHint(opts.replyTo);
    const parallel = this.freshParallel(!opts.human && !opts.replyTo && !opts.urgent);
    const extra = [parallel.text, this.takeOvernightNote(), withOwner ? this.takeRepairNote() : "", opts.replyTo ? "" : this.takeUnsentHint(), hint.text, along?.text ?? ""].filter(Boolean).join("\n");
    // 叫醒抛错：顺带取走的那几条放回去，下次叫醒再附（T9）；取走的提醒也放回去
    const send = (rest: string): void => {
      let id: string;
      const merged = main.busy;
      // 压着的那条：它的记录已经在前面送到她眼前了（钩子补的、跟前一条一起送的），这次的 <记忆> 里没有它，换个开头
      const shown = opts.recordedSeq !== undefined && main.open && main.seenUpTo() >= opts.recordedSeq;
      const head = !shown ? text : (opts.lastUnsent ? opts.shownUnsentText : opts.shownText) ?? text;
      // 兜底：真人消息还是排到了她手上那一轮后面（情境准备的那一两秒里内核自己开了一轮），那一轮最后写的话不在两栏里，说一声
      const note = merged && opts.humanCtx && opts.replyTo ? P.mergedSaid(opts.replyTo.name ?? opts.replyTo.target) : "";
      const all = [rest, note].filter(Boolean).join("\n");
      const body = all ? `${head}\n\n${all}` : head;
      try { id = main.wake(body, { human: opts.human }); } catch (e) { along?.release(); hint.release(); parallel.release(); this.shownParallel = null; throw e; }
      this.noteMainWake(id, opts.replyTo);
      if (opts.human && opts.replyTo) this.personWakes.set(convKey(opts.replyTo), { text, opts });
      along?.seen();
      parallel.seen();
      this.log.info("main wake", { cause: opts.cause ?? "other", ...(opts.resumed ? { resumed: true } : {}), ...(merged ? { merged: true } : {}), ...(shown ? { shown: true } : {}) });
    };
    // 认出东西：附在最后；同一次叫醒里联想已经带出的那几件不再附（拿到联想以后再取）
    const withRecognized = (ctx: string, more: string): string => [more, this.takeRecognized("main", [...ctx.matchAll(EVENT_IDS)].map((m) => m[0])) ?? ""].filter(Boolean).join("\n");
    if (!this.situation) { send(withRecognized("", extra)); return; }
    // 附上情境（OpenClaw 时代每轮都有的那段"只给你看"）再叫
    this.mainPreparing += 1;
    void this.situation.forMain(opts.humanCtx, opts.cue)
      .catch((e: unknown) => { this.log.warn("situation failed", { error: String(e) }); return ""; })
      .then((ctx) => {
        this.mainPreparing -= 1;
        const all = [ctx, withRecognized(ctx, extra)].filter(Boolean).join("\n");
        try { send(all); } catch (e) {
          this.log.error("main wake failed", { error: String(e).slice(0, 200) });
          // 没叫成、她也没在忙：压着的（含准备这一轮时同一个人又来的）接着放，别等下一次不相干的叫醒（复核 11-13）
          if (!main.busy && this.mainPreparing === 0) this.runHeld();
        }
      });
  }

  /**
   * 同一个人又来一句、她这一轮还在忙：先记下（她下一次调完工具，钩子就把它补进这一轮，还提醒她先回一句），叫醒压到这一轮结束再拼——
   * 那时她这一轮最后写的话已经发出去了，「最近说过的话」「说过要做」才算得上它。这一轮里她已经看到、话也回给了这个人的，就不再叫（settleMergedHeld）。
   * 以前直接排进内核：排进去那一刻拼的两栏少了她正在写的那段，钩子又已经给她看过一遍，下一轮她以为没发出去，又说一遍
   * （11-12 00:18 朋友那次、11-13 00:02 主人那次，11-09 也是）。
   * 同一个人这期间来的几条只压一份：叫醒时 <记忆> 一次带上没给她看过的全部，开头照最后一条说；排在别人压着的前面。
   * 等太久照压着的规矩打断（只在她这一轮不是回人时）
   */
  private holdMerged(key: string, text: string, opts: WakeOpts): void {
    opts.record!();
    const seq = opts.humanCtx?.seq;
    const latest = { ...opts, record: undefined };
    const prev = this.mergedHeld.get(key);
    if (prev) {
      if (seq !== undefined) prev.seqs.push(seq);
      if (opts.pendingId) prev.pendingIds.push(opts.pendingId);
      prev.text = text;
      prev.opts = latest;
      return;
    }
    const held = {
      human: true, conv: key,
      run: (): void => {
        const m = this.mergedHeld.get(key);
        if (!m) return;
        // 同一批放出来的、同一个人先放的那件已经在叫醒了（这几句的记录跟着它进去）：接着压，等那一轮结束再结算，别排进内核
        const main = this.region("main");
        if (main.busy || this.mainPreparing > 0) { this.heldForMain.unshift(held); return; }
        this.mergedHeld.delete(key);
        this.wakeMain(m.text, { ...m.opts, ...(m.seqs.length ? { recordedSeq: Math.max(...m.seqs) } : {}), ...(m.lastUnsent ? { lastUnsent: true } : {}) });
      },
    };
    this.mergedHeld.set(key, { seqs: seq !== undefined ? [seq] : [], pendingIds: opts.pendingId ? [opts.pendingId] : [], text, opts: latest, held });
    this.heldForMain.unshift(held);   // 接着这一轮的话头：排在别人压着的前面（以前是直接并进这一轮的）
    const main = this.region("main");
    this.later(() => {
      if (this.heldForMain.includes(held) && main.busy && !this.mainTarget() && this.mainGateConvs.size === 0) {
        this.log.info("interrupting main for a waiting message");
        this.taskCut = this.tasks.doing("main").length > 0;
        main.interrupt().catch(() => {});
      }
    }, HOLD_MAX_MS);
  }

  /** 发出去的话按「一次发送」编批：一段最终回复的几个气泡同一批，message 每发一次一批 */
  private sendBatchN = 0;
  private nextSendBatch(): string { return `${this.now()}-${++this.sendBatchN}`; }

  /**
   * 主线一轮结束：压着的同一个人的话，这一轮里全都送到过她眼前（开头带着的、钩子补的），这一轮好好结束、最后的话也回给了这个人 = 回过了，
   * 不再叫一轮。被打断、出错、这一轮其实不是回他的、有一条没赶上，都照常叫（叫醒时开头照有没有给她看过说）
   */
  private settleMergedHeld(main: Region, ok: boolean, to: Inbound["replyTo"]): void {
    const convOf = (r: Inbound["replyTo"]): string => (r ? `${r.channel}:${r.target}` : "");
    for (const [key, m] of this.mergedHeld) {
      const toThem = ok && convOf(to) === key;
      // 「上一轮那段没发给他」只照最近一轮说：这一轮的话发给他了就清；这一轮给她看过其中几句、话却没发给他（被打断、出错、不是回他的）就记上
      if (toThem) m.lastUnsent = false;
      else if (m.seqs.some((s) => main.shownThisTurn(s))) m.lastUnsent = true;
      if (!toThem || !m.seqs.length || !m.seqs.every((s) => main.shownThisTurn(s))) continue;
      this.mergedHeld.delete(key);
      const i = this.heldForMain.indexOf(m.held);
      if (i >= 0) this.heldForMain.splice(i, 1);
      this.log.info("held message already answered in this turn, not woken again", { seqs: m.seqs });
    }
  }

  /**
   * 压着等说话的那头的事放一件进去：真人的消息先；同一个人压着的几条按顺序一起放进去（不然一条一轮，后面的还会被它的计时器打断）。
   * 返回有没有真交给它东西：没有压着的、放进去的那件什么也没交（run 返回 false）都是 false
   */
  private runHeld(): boolean {
    const i = Math.max(0, this.heldForMain.findIndex((h) => h.human));
    const next = this.heldForMain.splice(i, 1)[0];
    if (!next) return false;
    this.mainWaiting = this.mainWaiting.filter((w) => w.conv !== next.conv);   // 放进去了：这一轮她自己会回，不用再提醒
    const handed = next.run() !== false;
    if (next.conv) for (const h of this.heldForMain.filter((x) => x.conv === next.conv)) { this.heldForMain.splice(this.heldForMain.indexOf(h), 1); h.run(); }
    return handed;
  }

  /** 记下这条消息是谁的（只留最近 64 条：内核按顺序消化，前面的早回过了） */
  private noteMainWake(id: string, to: Inbound["replyTo"]): void {
    this.mainWakeTo.set(id, to);
    for (const k of this.mainWakeTo.keys()) { if (this.mainWakeTo.size <= 64) break; this.mainWakeTo.delete(k); }
  }

  /**
   * 内核说这一轮在回哪几条：回给其中最后一个有人的；全是内部唤醒（没人，或者没走 wakeMain 直接叫的）就还回这一轮原来那个人。
   * 以前收件人只看 mainReplyTo，上一轮发完气泡才清，那时候并进来的话已经开了下一轮，回复就悄悄丢了（10-31 一个朋友连发时丢了 7 条）。
   */
  private onMainAnswering(ids: string[]): void {
    this.answeringSeen = true;
    const to = ids.map((id) => this.mainWakeTo.get(id)).filter(Boolean).at(-1) ?? this.mainTurn?.to;
    this.mainTurn = { to };
    if (to) this.mainReplyTo = to;   // 排队看的也是她现在在跟谁说
    const keys = [...this.mainWakeTo.keys()];
    const last = Math.max(...ids.map((id) => keys.indexOf(id)));
    for (const k of keys.slice(0, last + 1)) this.mainWakeTo.delete(k);   // 内核按顺序消化：这条之前的都回过了
  }

  /** 主线这一轮该回给谁 */
  private mainTarget(): Inbound["replyTo"] {
    return this.answeringSeen ? this.mainTurn?.to : this.mainReplyTo;
  }

  /** OpenClaw relay 送来的渠道消息：认出是谁、算好怎么回，再走丘脑 */
  fromChannel(m: InboundMessage): "delivered" | "queued" {
    // 同一条消息只收一次：relay 连不上时存进 relay-spool、hhd 起来再补交，补交前万一已经收过（或者渠道重投）就跳过
    // 记「渠道:编号|内容的指纹」：同一编号内容也一样才算重复；编号一样内容不同（编辑过的消息？）照收、记一笔
    const key = m.messageId ? `${m.channel}:${m.messageId}` : null;
    const entry = key ? `${key}|${createHash("sha1").update(m.text).digest("hex").slice(0, 10)}` : null;
    if (key && entry) {
      const seen = this.relaySeen();
      if (seen.includes(entry)) { this.log.info("relay: message already taken, skipped", { key }); return "delivered"; }
      if (seen.some((x) => x.startsWith(`${key}|`))) this.log.warn("relay: same message id with different text, taken again", { key });
    }
    const r = this.takeChannel(m);
    // 收下了才记：没收下（抛错）的，relay 存进 spool 再补交时还要能交进来（复核 3b5afaa4）
    if (entry) {
      this.relaySeenList = [...this.relaySeen(), entry].slice(-RELAY_SEEN_MAX);
      kvSet(this.db, RELAY_SEEN_KEY, JSON.stringify(this.relaySeenList));
    }
    return r;
  }

  /** hhd 不在时 relay 存下的消息按先后补交（启动、每次 tick、每次 relay 交来新消息之前：存着的总是先交，不乱序） */
  drainRelaySpool(): void {
    try { drainSpool({ dir: spoolDirOf(this.cfg.stateDir), deliver: (m) => this.fromChannel(m), log: this.log }); }
    catch (e) { this.log.warn("relay spool: drain failed", { error: String(e).slice(0, 200) }); }
  }

  private takeChannel(m: InboundMessage): "delivered" | "queued" {
    const person = this.currentPeople().identify(m.senderId, m.sessionKey);
    const from = person?.name ?? (m.senderId ? B.brain.inboundStrangerWithId(m.senderId) : B.brain.inboundStranger);
    const tag = relationTag(person);
    const profile = this.profileOf(person);
    const isChat = m.channel === "qqbot" || m.channel === "whatsapp";
    const replyTo = isChat && m.senderId
      ? { channel: m.channel, target: replyTarget(m.channel, m.senderId, { isGroup: m.isGroup, conversationId: m.conversationId }), ...(m.messageId ? { messageId: m.messageId } : {}), name: from, ...(m.isGroup ? { group: true } : {}) }
      : undefined;
    const quote = m.replyToBody ? B.brain.inboundQuote(m.replyToBody.slice(0, 200)) : "";
    // 补交的、存了好一会儿：说清是什么时候发的，别当成刚收到的来回
    const late = m.spooledAt !== undefined && this.now() - m.spooledAt >= SPOOLED_NOTE_MS
      ? B.brain.inboundLateDelivery(Math.round((this.now() - m.spooledAt) / 60_000)) : "";
    return this.inbound({
      from, channel: m.channel, text: late + quote + m.text, human: true,
      ...(m.senderId ? { senderId: m.senderId } : {}), ...(m.sessionKey ? { sessionKey: m.sessionKey } : {}),
      relation: relationOf(person), ...(tag ? { tag } : {}), ...(profile ? { profile } : {}),
      ...(m.isGroup ? { relation: B.brain.inboundGroupRelation(relationOf(person)), group: true } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
  }

  private relaySeenList: string[] | null = null;
  private relaySeen(): string[] {
    if (!this.relaySeenList) {
      try { const v = JSON.parse(kvGet(this.db, RELAY_SEEN_KEY) ?? "[]") as unknown; this.relaySeenList = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; } catch { this.relaySeenList = []; }
    }
    return this.relaySeenList;
  }

  /**
   * 消息末尾「关于X你记得的在 …」指的文件（相对工作区）：人物卡切过去了、不是主人、事件库里有他的卡（存着字段或钉的原话）→ 导出的卡；
   * 主人有卡就不指（他的卡在前缀里）；没切（R34：迁移写了卡也算没切，旧档案还是真的）、库里没卡（只有现算段的也算没有）
   * → 名单上的 profile，且那个文件还在（自由文本、搬走了的都不算）；都没有不给
   */
  private profileOf(person: Person | null): string | undefined {
    if (!person) return undefined;
    let own: { path: string } | null = null;
    try { own = this.mem?.storedCard(person.key) ?? null; } catch (e) { this.log.warn("person card lookup failed", { error: String(e).slice(0, 200) }); }
    if (own) return person.privacy === "owner" ? undefined : own.path;
    return person.profile && this.fileExists(join(this.cfg.workspace, person.profile)) ? person.profile : undefined;
  }

  /** 感官层的事件（senses.py 叫醒） */
  fromSenses(text: string, events?: unknown): "delivered" | "queued" {
    const evs = parseSenses(text, events);
    return this.inbound({ from: "感官", channel: "senses", text, human: false, events: evs });
  }

  /**
   * 这一轮的最终回复发给叫醒她的人（只发最终回复，工具调用之间的自言自语不发）。
   * 按空行拆成几个气泡、中间隔一下；里面有 NO_REPLY 就整条不发（跟 OpenClaw 一样）。
   * 不是被消息叫起来的（专注、感官、放空）一律不发。
   */
  private sendFinalReply(text: string, to: Inbound["replyTo"]): void {
    if (!to) return;
    if (/\bNO_REPLY\b/.test(text)) return;
    const bubbles = splitBubbles(text);
    if (!bubbles.length) return;
    if (to.channel === P.LOCAL_CHANNEL) {   // printed back by hh tell, nothing goes through a channel
      this.record("main", "note", B.brain.saidLocallyNote(to.name ?? to.target, text), { sent: true, to: to.target, local: true });
      return;
    }
    const batch = this.nextSendBatch();   // 这一段的几个气泡同一批（「说过要做」认后来兑现时，同一段里的不算）
    // 这一轮要发的先记成「在路上」，发出去（或失败）一条划掉一条（#0051）
    const queued: Said[] = bubbles.map((b) => ({ text: b, at: this.now(), pending: true, batch }));
    const key = targetKey(to.target);   // QQ 号大小写两种写法都算这个人
    this.inflight.set(key, [...(this.inflight.get(key) ?? []), ...queued]);
    const settle = (q: Said): void => {
      const rest = (this.inflight.get(key) ?? []).filter((x) => x !== q);
      if (rest.length) this.inflight.set(key, rest); else this.inflight.delete(key);
    };
    const sendAll = async (): Promise<void> => {
      const used: ListedWord[] = [];
      const miss: ReplyMiss = { key, who: to.name ?? to.target, channel: to.channel, target: to.target, ...(to.group ? { group: true } : {}), notSent: [], unsure: [], withheld: [] };
      for (const [i, b] of bubbles.entries()) {
        if (i > 0) await this.bubbleWait(this.bubbleGapMs());
        const r = await this.send({ channel: to.channel, target: to.target, text: b, replyTo: to.channel === "qqbot" ? to.messageId : undefined });
        if (r.ok) {
          this.record("main", "note", B.brain.sentNote(to.name ?? to.target, b), { sent: true, to: to.target, ...(to.name ? { name: to.name } : {}), batch });
          for (const w of wordHits(this.wordList.current(), b)) if (!used.some((u) => u.word === w.word)) used.push(w);
        }
        else {
          this.log.warn("reply delivery failed", { to: to.target, out: r.out.slice(-300) });
          // 记进她的记忆：哪句没发出去、为什么（以前只有日志，她以为发了）
          this.record("main", "note", B.brain.sendFailedNote(to.name ?? to.target, r.out.slice(0, 200), b), { sendFailed: true, to: to.target });
          (r.unsure ? miss.unsure : miss.notSent).push(b);
        }
        settle(queued[i]!);   // 记进中央记忆以后才从「在路上」划掉，中间不会两边都没有
        if (r.unsure === "rechecked") {
          // 超时了、再问一次也没回音（网关卡住了）：后面几句先不发。每句都再等一遍只会让后面所有回复跟着等，
          // 发出去的还可能赶到它前面（review I-1）。连接断了的不在这（下一句会重连，断了多半是网关重启，赶不到它前面），
          // 网关明确拒了的（确定没发出去）也不在这：都照旧接着发
          for (const [j, left] of bubbles.entries()) {
            if (j <= i) continue;
            this.record("main", "note", B.brain.sendWithheldNote(to.name ?? to.target, left), { sendFailed: true, to: to.target });
            miss.withheld.push(left);
            settle(queued[j]!);
          }
          break;
        }
      }
      // 没全发出去：下一次叫醒她时说清楚（#0063：别让她靠猜）
      if (miss.notSent.length || miss.unsure.length || miss.withheld.length) this.wakeHint.misses.push(miss);
      // 最终回复拦不下（要再开一轮）：发出去的话里用了她记下的词，这一轮记一笔提醒（#0015）。不标 sent，不算说过的话
      if (used.length) this.record("main", "note", P.wordsUsed(to.name ?? to.target, used), { wordHint: true });
      // 她要看得见：下一次叫醒时说一句（几轮攒下的并成一行，同一个词留第一次的理由）
      addWords(this.wakeHint.words, used);
    };
    this.outbox = this.outbox.then(async () => {
      try { await sendAll(); } finally { for (const q of queued) settle(q); }   // 中途出错也不留「正在发」
    }).catch((e: unknown) => this.log.error("outbox failed", { error: String(e) }));
  }

  /** 最近两小时发给这个目标的话（中央记忆里记了 sent 的），后面接上还在路上的（标 pending） */
  private saidTo(target: string): Said[] {
    const said = [...this.central.recentSent(target, this.now() - 2 * 3600_000), ...(this.inflight.get(targetKey(target)) ?? [])];
    // 她自己说过的话进提示前也过折叠表（memory.promptFolds）：命中就整条换
    return this.folds.empty ? said : said.map((x) => ({ ...x, text: this.folds.whole(x.text, x.at) }));
  }

  /** 待办逐条送达，送到一条标记一条（中途崩了不会丢） */
  private deliverTodos(): void {
    for (const item of this.thalamus.pendingTodoItems()) {
      if (this.inbound(item.event) !== "delivered") return;
      this.thalamus.markDone(item.id);
    }
  }

  // ---------- 脑区事件 ----------
  /**
   * 这条记录只存档、不同步：下意识自己的过程；还有翻页压缩时海马的过程和压出来的那段（11-02：那段已经进了前缀的压缩块，
   * 再算进新的一页、带进新会话的开场就是一式两份，被打回的稿也留在页里）
   */
  private innerNow(r: Region): Record<string, unknown> | null {
    return inner(r) ?? (r.spec.role === "hippocampus" && this.turn ? { inner: true } : null);
  }

  private onRegionEvent(r: Region, ev: KernelEvent): void {
    // 一边做着的事、慢慢想的事不算她醒着在忙（不然后台一直干活她夜里就睡不着，review C2）
    if (r.spec.role !== "side" && r.spec.role !== "deep") this.lastActivity = this.now();
    if (r.spec.role === "main" && !this.mainTurnStartedAt && ev.type !== "turn-end") this.mainTurnStartedAt = this.now();
    switch (ev.type) {
      case "think": this.record(r.id, "think", ev.text, this.innerNow(r)); return;
      case "say": {
        const e = this.record(r.id, "say", ev.text, this.innerNow(r));
        this.recognizeIn(r.id, ev.text);
        // 先都攒着：发给谁到这一轮结束才定得下来（中途并进来的消息，内核到 result 才报）
        if (r.spec.role === "main") this.pendingSays.push({ text: ev.text, seq: e.seq });
        return;
      }
      case "act":
        if (r.spec.role === "main") { this.pendingSays = []; this.mainActed = true; }   // 说完又去做事：刚才那段是中途的话，不发
        // 存全文（缩小的记忆都要能翻出原样）；渲染时各视角自己截
        this.record(r.id, "act", `${ev.tool} ${JSON.stringify(ev.input)}`, { tool: ev.tool, ...(ev.id ? { id: ev.id } : {}), ...this.innerNow(r) });
        if (ev.id) this.rememberActPath(ev.id, ev.input);
        if (ev.id) this.rememberActTool(ev.id, ev.tool);
        this.trackHelper(r.id, `${ev.tool} ${JSON.stringify(ev.input)}`);
        return;
      case "result": {
        const seen = ev.images?.length ? this.seenImages(ev.tool, ev.images) : "";
        this.record(r.id, "result", seen ? `${ev.text}${ev.text ? "\n" : ""}${seen}` : ev.text, { ...(ev.tool ? { id: ev.tool } : {}), ...(ev.isError ? { error: true } : {}), ...this.innerNow(r) });
        this.recognizeResult(r.id, this.actTools.get(ev.tool) ?? ev.tool, ev.text);
        return;
      }
      case "rate": if (!providerOf(this.cfg, r.spec.role)) this.observeQuota(ev.reading); return;   // a provider's limits are not the subscription's
      case "answering": if (r.spec.role === "main") this.onMainAnswering(ev.ids); return;
      case "turn-end":
        this.countSpend(r.spec.role, ev.total);
        this.onTurnEnd(r, ev).catch((e: unknown) => this.log.error("turn-end handling failed", { region: r.id, error: e instanceof Error ? e.stack : String(e) }));
        return;
    }
  }

  private async onTurnEnd(r: Region, ev: Extract<KernelEvent, { type: "turn-end" }>): Promise<void> {
    if (this.turnLog.length < 20) this.turnLog.push({ ok: ev.ok, ...(!ev.ok && r.interruptedThisTurn ? { error: "interrupted" } : ev.error ? { error: ev.error } : {}) });
    if (!ev.ok) this.log.warn("turn failed", { region: r.id, error: ev.error });
    if (r.spec.role === "side" && !r.busy) this.afterSideTurn(r, ev);
    // 专注里因为她在干活没叫主线：后台这一轮结束、没有哪一头还在干活了，接着逼她起来
    if (r.spec.role === "side" && !r.busy && this.focusParked && !this.herWorking()) { this.focusParked = false; this.continueFocusIfNeeded(); }
    if (r.spec.role === "deep" && !r.busy) this.afterDeepTurn(r, ev);   // 要在第一个 await 之前（这一轮用了几次工具，交出去以后就清零）
    if (r.spec.role === "main") {
      const says = this.pendingSays.map((x) => x.text);
      const saySeqs = this.pendingSays.map((x) => x.seq);
      const to = this.mainTarget();       // 这时候就定下来：下面要等气泡发完，那几秒里下一轮可能已经开始
      this.pendingSays = [];
      this.mainTurn = null;
      if (ev.ok && says.length) this.sendFinalReply(says.join("\n\n"), to);   // 被打断 / 出错的那一轮不发半截话
      // a turn that failed while someone at this computer waits for its answer (hh tell, the console's talk pane, the first
      // greeting): why, and what to do, at once; the waiting command would sit out its ten minutes. One stopped while
      // answering is tried again in a fresh session (afterMainStopped) and an interrupted one goes on: neither is said
      if (!ev.ok && !ev.stopped && !r.interruptedThisTurn && to?.channel === P.LOCAL_CHANNEL) {
        this.record("main", "note", turnFailedText(ev.error), { local: true, failed: true, to: to.target });
      }
      this.settleMergedHeld(r, ev.ok, to);   // 要在 region 清掉这一轮的记号之前（同步这一段里）
      // 专注里说「想干等」是写给 HH 的（noteFocusTurn 认这句），不算没人收的话
      if (ev.ok && !to && says.length && !meantForNobody().test(says.join("\n")) && splitBubbles(says.join("\n\n")).length) {
        this.record("main", "note", P.UNSENT_REPLY, { unsent: true, of: saySeqs });   // 记忆里标在这几段话上（central.ts renderMemory）
        this.unsentReply = true;
      }
      const acted = this.mainActed;
      this.mainActed = false;
      this.mainTurnStartedAt = 0;
      this.mainLongNudged = false;
      this.mainWaiting = this.mainWaiting.filter((w) => this.heldForMain.some((h) => h.conv === w.conv));   // 还压着的留着，回过的不提
      this.mainApiError = !ev.ok && /^api_error/.test(ev.error ?? "");
      if (ev.ok && !to) { this.noteFocusTurn(acted, says.join("\n")); this.noteTaskTurn(acted, says.join("\n")); }
      else if (ev.ok && acted) { this.noteFocusTurn(true, ""); this.noteTaskTurn(true, ""); }   // 回人的那一轮动了手也算在做事（#0060 复核：不然额度紧时回完人要等一刻钟、还说她没做事）
      if (ev.ok && this.mem) this.mem.cited([...says, r.finalSay()].join("\n"), r.id);   // 说话时提到了哪件事的编号 = 碰过
      if (ev.ok && !r.pendingRotate) this.calibrateView(r, ev.usage.contextTokens);
      if (ev.stopped || ev.refused) this.afterMainStopped(r, ev, to);
    }
    this.log.info("turn end", {
      region: r.id, ok: ev.ok, contextTokens: ev.usage.contextTokens, cacheRead: ev.usage.cacheRead, cacheWrite: ev.usage.cacheWrite,
      ...(ev.total ? { calls: ev.total.calls, cacheReadTotal: ev.total.cacheRead, cacheWriteTotal: ev.total.cacheWrite, outputTotal: ev.total.output } : {}),
    });

    if (r.spec.role === "main" && !r.busy) {
      await this.outbox;                  // 这一轮的话发完了再收尾
      if (r.busy || this.mainPreparing > 0) return;   // 发气泡这几秒里下一轮已经开始（或正要送进去）：等那一轮结束再收尾
      this.mainReplyTo = undefined;
      this.mainGateConvs.clear();
      this.pendingDropDelivered();        // 送到并回完（或决定不回）的真人消息，不用再记着
      if (this.runHeld()) return;
    }
    // 下意识每处理完一轮都给主意识留一句：发生了什么、怎么处理的（不同步过程，但状态要同步）
    if (r.spec.role === "perception" && !r.busy) {
      const line = r.finalSay().trim().replace(/\s*\n\s*/g, " ");
      r.takeTurnText();
      const refs = this.senseRefs(r.id, false);
      this.senseRaw.delete(r.id);
      this.record(r.id, "note", `${line ? line.slice(0, 600) : B.brain.senseTurnEndNoNote}${refs}`);   // 显示成"你下意识记下"，带原文编号
    }
    // 海马这一轮结束时后台还有帮手在跑：等它们交回（内核会自己再开一轮），别收工、别换班，不然帮手的活就断了（10-30 那晚）
    if (r.spec.role === "hippocampus" && (this.turn || this.sleeping) && ev.ok && (ev.background ?? 0) > 0) {
      this.log.info("hippocampus ended its turn with background work still running; waiting for it", { background: ev.background, tasks: ev.backgroundTasks ?? [] });
      r.takeTurnText();   // 「等帮手交回」这类话不进翻页的压缩块、不算整理的回复
      return;
    }
    // 夜里整理时她这一轮结束了，交去把关的还没看完：等结论（看完会叫醒她，那一轮结束再照常收工；把关有超时、整理有看门狗）。
    // 她以 AUTOMATION_FAILED 收尾的不等：照失败处理（撤回、重来），不然这句被吞掉，失败的一夜会被当成整理好了
    if (r.spec.role === "hippocampus" && this.sleeping?.kind === "night" && ev.ok && this.checkRegions.size > 0 && !/^AUTOMATION_FAILED/.test(r.finalSay().trim())) {
      this.log.info("hippocampus ended its turn while the checker is still looking; waiting for the verdicts", { checks: this.checkRegions.size });
      r.takeTurnText();
      return;
    }
    if (r.spec.role === "hippocampus" && this.turn?.via === "hippocampus") return this.finishPageTurn(r, ev.ok);
    if (r.spec.role === "hippocampus" && this.turn) { r.takeTurnText(); return; }   // 分叉在压：海马冒出来的一轮不算压缩稿
    if (r.spec.role === "hippocampus" && this.sleeping) {
      // 分段整理的夜里海马不整理：它冒出来的一轮（不该有）不算整理收工
      if (this.sleeping.engine !== "legacy") { r.takeTurnText(); return; }
      return this.finishSleep(r, ev.ok);
    }
    // 下意识自己单独换班：上下文太大就换，不等全局翻页（新会话只带压缩视角的最近一段）
    if (r.spec.role === "perception" && !r.pendingRotate && ev.usage.contextTokens >= (this.cfg.limits.perceptionRotateTokens ?? 150_000)) {
      this.log.info("perception rotates on its own", { region: r.id, contextTokens: ev.usage.contextTokens });
      r.pendingRotate = true;
    }
    // 后台脑区也看自己眼前的上下文：全局翻页变少以后，它不能一直涨到快满
    // （11-04 side-1 每次调用中位读 28.6 万、最多 58 万）。到线就自己换班，手上的事换完接着做（见 afterBackgroundTurn 的 pendingRotate）
    if (r.spec.role === "side" && !r.pendingRotate && ev.usage.contextTokens >= (this.cfg.limits.sideRotateTokens ?? 250_000)) {
      this.log.info("side rotates on its own", { region: r.id, contextTokens: ev.usage.contextTokens });
      r.pendingRotate = true;
    }
    if (r.pendingRotate) this.rotateWhenQuiet(r);

    if (!this.turn && !this.sleeping && this.pageTurnNeeded()) {
      this.startPageTurn();
      return;
    }
    if (r.spec.role === "main") { this.continueFocusIfNeeded(); this.continueTaskIfNeeded(); }
  }

  // ---------- 额度感（放在感官层，跨档时告诉下意识，由她自己调整节奏） ----------
  private quotaState(): QuotaState {
    try { return (JSON.parse(kvGet(this.db, QUOTA_KEY) ?? "{}") as QuotaState) ?? {}; } catch { return {}; }
  }

  private spend(): Spend {
    return JSON.parse(kvGet(this.db, SPEND_KEY) ?? "{}") as Spend;
  }

  /** A turn of a region on another provider: its cost at the provider's prices, added to today's spend */
  private countSpend(role: Role, total: TurnTotal | undefined): void {
    const p = providerOf(this.cfg, role);
    if (p && total) kvSet(this.db, SPEND_KEY, JSON.stringify(addSpend(this.spend(), p.name, localDay(this.now(), this.cfg.schedule.timezone), turnUsd(p.provider, total))));
  }

  /** The week's quota a role runs against, in percent: its provider's 7-day spend against weekUsd, or the subscription's 7-day reading */
  private weekUsed(role: Role): number | undefined {
    const p = providerOf(this.cfg, role);
    if (!p) return this.quotaState().sevenDay?.used;
    return Math.round((weekSpend(this.spend(), p.name, localDay(this.now(), this.cfg.schedule.timezone)) / p.provider.weekUsd) * 100);
  }

  observeQuota(reading: QuotaReading): void {
    const prev = this.quotaState();
    const { state, notice, urgent } = observeQuota(prev, reading, { now: this.now(), timezone: this.cfg.schedule.timezone });
    kvSet(this.db, QUOTA_KEY, JSON.stringify(state));
    // 读数变了就记一行（周表按天算额度用了百分之几，hh numbers）：只记数，不改她看到的
    const moved = (a: { used: number; resetsAt: number | null } | undefined, b: { used: number; resetsAt: number | null } | undefined): boolean => !!b && (a?.used !== b.used || a?.resetsAt !== b.resetsAt);
    if (moved(prev.sevenDay, reading.sevenDay) || moved(prev.fiveHour, reading.fiveHour) || reading.rejected) {
      this.log.info("quota reading", { ...(reading.sevenDay ? { sevenDay: reading.sevenDay } : {}), ...(reading.fiveHour ? { fiveHour: reading.fiveHour } : {}), ...(reading.rejected ? { rejected: reading.rejected } : {}) });
    }
    if (!notice) return;
    this.log.info("quota notice", { notice, urgent });
    if (!this.gate) { this.fromSenses(notice); return; }
    // 闸门：见底（被拒、重置、到了最高档）直达；别的交给她的规则（quota-pace）去判。id 按文字算，闸门自己再加上到达时刻
    const ev: SenseEvent = { src: "hh-quota", id: createHash("sha1").update(notice).digest("hex").slice(0, 16), text: notice, line: notice, ...(urgent ? { urgent: true } : {}) };
    this.inbound({ from: "感官", channel: "senses", text: notice, human: false, events: [ev] });
  }

  /** 单独开一个临时的轻量连接问一次额度（不占她正在用的会话，也不调模型）；读不到就下次再问 */
  private async pollQuota(): Promise<QuotaReading | "no-plan" | null> {
    if (!this.driver.quota) return null;
    try {
      const reading = await withTimeout(this.driver.quota({
        model: modelFor(this.cfg, "haiku"), cwd: this.cfg.workspace, env: kernelEnv(this.cfg), claudeExecutable: this.cfg.kernel.claudeExecutable,
      }), 60_000);
      // an API key, Bedrock or Vertex has no plan limits: not a failed read, so asked again only at the usual pace (the owner
      // may log in with a subscription meanwhile) and said once, not warned every two minutes
      if (reading === "no-plan") {
        if (!this.noPlan) this.log.info("quota: this login has no plan limits (an API key or another provider), so there is no reading");
        this.noPlan = true;
        return reading;
      }
      this.noPlan = false;
      if (!reading) { this.log.warn("quota poll: no reading"); return null; }
      this.observeQuota(reading);
      return reading;
    } catch (e) {
      this.log.warn("quota poll failed", { error: String(e) });
      return null;
    }
  }

  /** hh gate probe：量一次性调用的固定开销，再看同一张卡连问两次第二次吃没吃到缓存 */
  async gateProbe(): Promise<{ tiny: AskResult["usage"]; card1: AskResult["usage"]; card2: AskResult["usage"]; cardChars: number }> {
    const ask = this.driver.ask?.bind(this.driver);
    if (!ask) throw new Error(B.brain.gateNoAsk);
    const base = { cwd: this.cfg.workspace, env: kernelEnv(this.cfg), claudeExecutable: this.cfg.kernel.claudeExecutable, timeoutMs: 60_000 };
    const g = this.cfg.gate.card;
    const parts = [
      ...g.soul.map((p) => this.readText(join(this.cfg.workspace, p))),
      this.readText(join(this.cfg.stateDir, g.midterm)),
    ].filter((x): x is string => x !== null);
    const card = parts.join("\n\n");
    const model = this.cfg.models.haiku;
    // 顺序跑：card2 要紧跟 card1，缓存才吃得到
    const tiny = await ask({ ...base, model, system: B.brain.gateProbeTinySystem, prompt: B.brain.gateProbeTinyPrompt });
    const card1 = await ask({ ...base, model, system: card, prompt: B.brain.gateProbeCardFirstPrompt });
    const card2 = await ask({ ...base, model, system: card, prompt: B.brain.gateProbeCardSecondPrompt });
    return { tiny: tiny.usage, card1: card1.usage, card2: card2.usage, cardChars: card.length };
  }

  // ---------- 专注（像上班：这段时间一直醒着做事，不睡、不停） ----------
  private currentFocusSlot(): string | null {
    const s = this.cfg.schedule;
    const slot = focusSlotAt(this.now(), s.timezone, s.focusSlots, s.focusMinutes);
    if (slot) return slot;
    return this.work && this.now() < this.work.until ? this.work.why : null;
  }

  private focusUntil(): number | null {
    const s = this.cfg.schedule;
    const now = this.now();
    const slot = focusSlotAt(now, s.timezone, s.focusSlots, s.focusMinutes);
    const fixedEnd = slot ? now + (parseHM(slot) + s.focusMinutes - localTime(now, s.timezone).minutes) * 60_000 : 0;
    const workEnd = this.work && now < this.work.until ? this.work.until : 0;
    const end = Math.max(fixedEnd, workEnd);
    return end || null;
  }

  /** 开始一段排出来的专注 */
  private startWork(why: string, minutes: number): void {
    const until = Math.max(this.now() + minutes * 60_000, this.work && this.now() < this.work.until ? this.work.until : 0);
    this.work = { until, why };
    kvSet(this.db, WORK_KEY, JSON.stringify(this.work));
    this.wakeMain(B.brain.focusStarted(P.FOCUS_REGULAR, why), { cue: why, cause: "focus" });
  }

  /** A reminder handed in from outside hhd (control "remind": the role's own background hh fix reporting back). Due now,
   *  delivered like the role's own reminders (held while asleep or turning a page, kept until morning at night); it has no
   *  sender: nobody's words, nobody's approval */
  remind(text: string): void { this.schedule.add("remind", this.now(), text); }

  /** 主人用命令行排专注（when 可以写 now） */
  addWork(when: string, minutes: number, why: string, every?: string): { id: number; due: string } {
    const tz = this.cfg.schedule.timezone;
    const due = when === "now" ? this.now() : parseWhen(when, this.now(), tz);
    const id = this.schedule.add("focus", due, B.brain.focusScheduledByOwner(why), parseEvery(every), minutes);
    if (when === "now") void this.tick();
    return { id, due: new Date(due).toLocaleString(dateLocale(), { timeZone: tz }) };
  }

  listSchedule(): ReturnType<Schedule["list"]> { return this.schedule.list(); }
  removeSchedule(id: number): boolean { return this.schedule.remove(id); }

  /** 结束现在这段排出来的专注（主人用） */
  stopWork(): boolean {
    const had = this.work !== null && this.now() < this.work.until;
    this.work = null;
    kvSet(this.db, WORK_KEY, "null");
    return had;
  }

  /** 前台每次工具调用之后补的一句：有人在等她回（每人提醒一次），这一轮做太久了（一轮提醒一次） */
  private mainNudge(): string | undefined {
    const lines: string[] = [];
    const fresh = this.mainWaiting.filter((w) => !w.nudged);
    if (fresh.length) {
      for (const w of fresh) w.nudged = true;
      // 闸门交来的（微信、小红书、B站……）message 发不到：照原文里写的办法回
      const names = (ws: typeof fresh) => [...new Set(ws.map((w) => w.who))].join(B.brain.waitingNamesSep);
      const human = fresh.filter((w) => !w.conv.startsWith("gate:"));
      const gated = fresh.filter((w) => w.conv.startsWith("gate:"));
      if (human.length) lines.push(B.brain.waitingHumanNudge(names(human)));
      if (gated.length) lines.push(B.brain.waitingGatedNudge(names(gated)));
    }
    if (this.mainTurnStartedAt && !this.mainLongNudged && this.now() - this.mainTurnStartedAt > LONG_TURN_MS) {
      this.mainLongNudged = true;
      lines.push(B.brain.longTurnNudge(Math.round((this.now() - this.mainTurnStartedAt) / 60_000)));
    }
    return lines.join("\n") || undefined;
  }

  /** 专注里她自己醒来的一轮结束：动手了就清零；没动手就记一轮空转；说了想干等就改成一分钟叫一次 */
  private noteFocusTurn(acted: boolean, said: string): void {
    if (!this.currentFocusSlot()) return;
    if (acted) { this.focusIdle = 0; this.focusWaiting = false; }
    else this.focusIdle += 1;
    this.focusRecent = [...this.focusRecent, !acted].slice(-FOCUS_RECENT);
    if (B.forms.focusWaitSaid.test(said)) this.focusWaiting = true;
  }

  /**
   * 她自己在干活：后台哪一头正在一轮里做事。
   * 只有 Claude Code 帮手在跑、她自己哪头都没在做事，不算（那是在等，照常逼她找别的事干）
   */
  private herWorking(): boolean {
    return [...this.regions.values()].some((r) => r.spec.role === "side" && r.busy);
  }

  /**
   * 专注里每一轮结束都马上叫回来；这一轮没干什么事，就提醒她自己找事做（不拉长间隔放她歇着）。
   * 例外（#0060）：这周额度到 schedule.focusQuotaWeekMax 时，没做事的那几下拉长到一刻钟一次，提示挑省额度的轻活。
   * 连着超过 FOCUS_IDLE_MAX 轮没做事，换成更直接的那句；她说了想干等，就一分钟叫一次。
   * 最近 FOCUS_RECENT 轮里有 FOCUS_RECENT_IDLE 轮空、又不是一口气连着空的（空一轮动一下），也给带「想干等」的那句；叫醒的节奏不变。
   * 她在干活（后台哪一头正在一轮里）就不叫，那一轮结束再看；没在干活就照常一直叫。
   */
  private continueFocusIfNeeded(): void {
    if (!this.currentFocusSlot() || this.alertness === "asleep") { this.focusIdle = 0; this.focusRecent = []; this.focusWaiting = false; this.focusParked = false; this.focusParkedSince = 0; return; }
    const main = this.region("main");
    if (this.herWorking()) { this.parkFocus(); return; }
    this.focusParked = false;
    this.focusParkedSince = 0;
    // 这周额度到线、上一轮没做事（空转、说了想干等）：一刻钟才叫一次，说额度紧、挑省额度的轻活（
    // 11-10 18:02 额度 96% 还每轮叫她找事做，她只回「没事，等着」，两头空转烧额度）。动手的那轮之后照常马上接着叫；
    // 有人找、感官、帮手交回不走这里，照常叫醒
    const tight = this.focusWaiting || this.focusIdle > 0 ? this.focusQuotaTight() : null;
    if (tight !== null) this.log.info("focus: week quota tight, idle nudge stretched", { week: tight, mins: FOCUS_TIGHT_GAP_MS / 60_000 });
    const text = tight !== null ? focusTightText(tight)
      : this.focusWaiting ? P.FOCUS_WAITING
      : this.focusIdle > FOCUS_IDLE_MAX ? `${P.FOCUS_CONTINUE}\n${P.FOCUS_IDLE_LONG}`
      : this.focusIdle > 0 && this.idleOften() ? `${P.FOCUS_CONTINUE}\n${P.FOCUS_IDLE_OFTEN}`
      : this.focusIdle > 0 ? `${P.FOCUS_CONTINUE}\n${P.FOCUS_FIND_WORK}`
      : P.FOCUS_CONTINUE;
    const token = ++this.focusTimer;
    const fire = (): void => {
      if (token !== this.focusTimer) return;                 // 有更新的定时器了
      if (!this.currentFocusSlot() || this.alertness === "asleep") return;
      if (this.turn || main.busy) { this.later(fire, FOCUS_GAP_MS); return; }   // 翻页中 / 主线忙：等一下再看
      if (this.herWorking()) { this.parkFocus(); return; }   // 等的这一会儿后台开工了
      this.wakeMain(text, { cause: "focus" });
    };
    this.later(fire, tight !== null ? FOCUS_TIGHT_GAP_MS : this.focusWaiting || this.mainApiError ? FOCUS_WAIT_MS : FOCUS_GAP_MS);
  }

  private noteTaskTurn(acted: boolean, said: string): void {
    if (acted) { this.taskIdle = false; this.taskWaiting = false; } else this.taskIdle = true;
    if (B.forms.focusWaitSaid.test(said)) this.taskWaiting = true;
  }

  /**
   * Main's own task (on_it, no done_with yet, not handed to a side region), outside focus: a turn that ends with nothing
   * else waiting calls it back to the task by focus's rules — at once; once a minute after it said it only wants to wait;
   * a quarter of an hour apart when the week's quota is past schedule.focusQuotaWeekMax and the turn did nothing.
   * Not at night, asleep, or during a page turn (after it, then).
   */
  private continueTaskIfNeeded(): void {
    const off = (): boolean => this.currentFocusSlot() !== null || this.alertness === "asleep" || !!this.sleeping || this.nightRest();
    const task = this.tasks.doing("main")[0];
    if (!task || off()) { this.taskIdle = false; this.taskWaiting = false; this.taskCut = false; return; }
    const tight = this.taskWaiting || this.taskIdle ? this.focusQuotaTight() : null;
    const token = ++this.taskTimer;
    const fire = (): void => {
      const t = this.tasks.doing("main").find((x) => x.id === task.id);
      if (token !== this.taskTimer || !t || off()) return;
      if (this.region("main").busy || this.heldForMain.length) return;   // that turn's end looks again
      if (this.turn) { this.later(fire, FOCUS_GAP_MS); return; }
      const go = P.mainTaskContinue(t.topic, this.taskCut, this.taskIdle && tight === null);
      this.taskCut = false;
      this.wakeMain(tight !== null ? `${go}\n${P.focusQuotaTight(tight, FOCUS_TIGHT_GAP_MS / 60_000)}` : this.taskWaiting ? P.mainTaskWaiting(t.topic) : go, { cause: "task" });
    };
    this.later(fire, tight !== null ? FOCUS_TIGHT_GAP_MS : this.taskWaiting || this.mainApiError ? FOCUS_WAIT_MS : FOCUS_GAP_MS);
  }

  /**
   * 最近几个专注轮里空轮够多，而且不是一口气连着空的（空轮数比眼下连着空转的轮数多：空一轮动一下那种）：给带「想干等」的那句。
   * 连着空转的照旧走 focusIdle（第四轮才给「连着好几轮」那句）。只管提示，不管叫醒的节奏
   */
  private idleOften(): boolean {
    const idle = this.focusRecent.filter(Boolean).length;
    return idle >= FOCUS_RECENT_IDLE && idle > this.focusIdle;
  }

  /** 这周额度到了 schedule.focusQuotaWeekMax：返回用了多少；没到、还没读到这周的读数（照旧叫）给 null（#0060） */
  private focusQuotaTight(): number | null {
    const week = this.weekUsed("main");
    return typeof week === "number" && week >= this.cfg.schedule.focusQuotaWeekMax ? week : null;
  }

  /** 她在干活：专注先不叫主线（作废等着的那次），后台这一轮结束再看（onTurnEnd）；停够 FOCUS_PARK_MAX_MS 照叫一次 */
  private parkFocus(): void {
    const token = ++this.focusTimer;
    if (!this.focusParked) {
      this.log.info("focus: she is working, main not woken until that turn ends", { working: [...this.regions.values()].filter((r) => r.spec.role === "side" && r.busy).map((r) => r.id) });
      this.focusParkedSince = this.now();
    }
    this.focusParked = true;
    const left = FOCUS_PARK_MAX_MS - (this.now() - this.focusParkedSince);
    this.later(() => {
      if (token !== this.focusTimer || !this.focusParked) return;
      if (!this.currentFocusSlot() || this.alertness === "asleep" || this.turn || this.region("main").busy) return;   // 主线自己这一轮结束会再看
      this.log.info("focus: parked too long, waking main once", { mins: Math.round((this.now() - this.focusParkedSince) / 60_000) });
      this.focusParked = false;
      this.focusParkedSince = 0;
      const tight = this.focusIdle > 0 ? this.focusQuotaTight() : null;   // 额度紧：不逼她找事做，说挑轻活（#0060）
      this.wakeMain(tight !== null ? focusTightText(tight) : this.focusIdle > 0 ? `${P.FOCUS_CONTINUE}\n${P.FOCUS_FIND_WORK}` : P.FOCUS_CONTINUE, { cause: "focus" });
    }, Math.max(FOCUS_GAP_MS, left));
  }

  // ---------- 翻页（海马自动压缩，不是睡觉） ----------
  pageTurnNeeded(): boolean {
    if (this.now() < this.turnCooldownUntil) return false;
    // 翻页看她（主线）眼前这一页有多大，不看所有脑区的原文合计；哪个脑区自己的上下文快满了照样翻
    return this.pageView() >= this.cfg.limits.pageTokens || this.maxRegionContext() >= this.cfg.limits.maxContextTokens * 0.95;
  }

  /** 各脑区眼前最大的上下文（换班中的不算） */
  private maxRegionContext(): number {
    const live = [...this.regions.values()].filter((x) => !x.pendingRotate);
    return Math.max(0, ...live.map((x) => x.usage.contextTokens));
  }

  /** 这一页在主线眼前有多大：估算 × 校准倍数（翻页、分叉等不等都看这个） */
  private pageView(): number {
    return Math.round(this.pageViewRaw() * this.viewK.k);
  }

  /** 没校准的估算（central 按字数估，汉字约 1.1 个 token） */
  private pageViewRaw(): number {
    return this.central.viewTokens(this.epoch.id, "main", { maxItemChars: this.cfg.limits.maxItemChars, thinkChars: this.cfg.limits.syncThinkChars ?? 0 });
  }

  /**
   * 拿主线真实的上下文校准估算：同一个会话里，估算涨了 VIEW_K_MIN_GROWTH 以上，
   * 就算一次「真实涨幅 ÷ 估算涨幅」。用涨幅不用绝对值：开场的前缀、系统提示自然扣掉了；挂进来的笔记页、图片这些
   * 不在 central、但确实在她眼前的，也一起算进倍数。换了会话、换了页、上下文变小了（内核自己压过）就从这里重新起算
   */
  private calibrateView(r: Region, ctx: number): void {
    const session = r.sessionId;
    if (!session || ctx <= 0) { this.viewAnchor = null; return; }
    // 只算她已经收到的：别人刚记下、还没送进主线的那几条，估算里有、她的上下文里还没有，两头都扣掉
    const raw = Math.max(0, this.pageViewRaw() - estimateTokens(r.pendingView().text));
    const here = { epoch: this.epoch.id, generation: r.generation, session, raw, ctx };
    const a = this.viewAnchor;
    if (!a || a.epoch !== here.epoch || a.generation !== here.generation || a.session !== session || ctx < a.ctx || raw < a.raw) { this.viewAnchor = here; return; }
    const dRaw = raw - a.raw;
    if (dRaw < VIEW_K_MIN_GROWTH) return;
    this.viewAnchor = here;
    const sample = (ctx - a.ctx) / dRaw;
    if (sample > VIEW_K_MAX) { this.log.info("page view calibration: sample skipped", { sample: Math.round(sample * 100) / 100, dRaw, dCtx: ctx - a.ctx }); return; }
    const s = Math.max(VIEW_K_MIN, sample);
    const k = this.viewK.n === 0 ? s : this.viewK.k + VIEW_K_ALPHA * (s - this.viewK.k);
    this.viewK = { k: Math.round(k * 1000) / 1000, n: this.viewK.n + 1 };
    kvSet(this.db, VIEW_K_KEY, JSON.stringify(this.viewK));
    this.log.info("page view calibrated", { sample: Math.round(sample * 100) / 100, k: this.viewK.k, n: this.viewK.n, dRaw, dCtx: ctx - a.ctx });
  }

  /** now=true（手动翻页）：主线忙就不等了，直接交给海马 */
  startPageTurn(opts: { now?: boolean } = {}): void {
    if (this.turn || this.sleeping) return;
    const main = this.regions.get("main");
    // 分叉主线会话压缩：整页本来就在主线的会话和缓存里，分叉一份把压缩要求当一条消息发进去，按读缓存算。
    // 主线这一轮还没完、或者正要叫醒她，就先不翻（半截的回合分叉不了），她这一轮结束会再看一次；页已经大出很多就不等了，照旧交给海马。
    // 主线还有没换完的班（上次翻页时她正忙）、这一页分叉超时过：也交给海马
    const forkable = this.cfg.limits.pageTurnFork && !!main?.canFork && !main.pendingRotate && this.forkOffEpoch !== this.epoch.id;
    if (forkable && main) {
      if (!main.busy && this.mainPreparing === 0) {
        this.turn = { cutSeq: this.central.lastSeq(), attempts: 0, since: this.now(), via: "fork" };
        void this.compactByFork(main, this.turn);
        return;
      }
      const over = this.pageView() >= this.cfg.limits.pageTokens * FORK_WAY_OVER || this.maxRegionContext() >= this.cfg.limits.maxContextTokens * 0.95;
      if (!over && !opts.now) {
        if (this.forkWaitLogged !== this.epoch.id) { this.forkWaitLogged = this.epoch.id; this.log.info("page turn: waiting for main to finish its turn to fork", { epoch: this.epoch.id, pageView: this.pageView() }); }
        return;
      }
      this.log.warn("page turn: main still busy, compacting with the hippocampus", { epoch: this.epoch.id, pageView: this.pageView(), manual: opts.now === true });
    }
    this.turn = { cutSeq: this.central.lastSeq(), attempts: 0, since: this.now(), via: "hippocampus" };
    this.log.info("page turn: compacting", { epoch: this.epoch.id, cutSeq: this.turn.cutSeq, pageTokens: this.central.pageTokens(this.epoch.id), pageView: this.pageView() });
    void this.askHippocampusToCompact();
  }

  /**
   * 分叉主线会话压缩这一页。分叉的那条消息里依次是：
   * 这一页里主线会话开始以前的那段（翻页后新会话只带最近一段、重启后只带一截，复核 #1）、还没送到主线的别人的记录、压缩要求。
   * 这样分叉看到的就是整页到此刻为止的全部，切页点就是现在。会话开头带着的上一页的尾巴不再压（要求里点明这一页从哪条开始，落在前面的条目删掉）。
   * 压缩稿每条末尾抄两小段原话当锚点，这里到这一页的记录里找回编号范围（主线眼前每行没有编号）。
   * 出错、被拦、太短、锚点换出编号的不到八成：这一次退回海马压缩（同一个切页点），不算失败
   */
  private async compactByFork(main: Region, turn: PageTurn): Promise<void> {
    const fallback = (why: string, extra: Record<string, unknown> = {}): void => {
      if (this.turn !== turn) return;
      this.log.warn("page turn: fork compaction not usable, compacting with the hippocampus", { why, ...extra });
      turn.via = "hippocampus";
      turn.since = this.now();   // 海马从头算看门狗（复核 #5）
      void this.askHippocampusToCompact();
    };
    let block: string;
    try {
      const pageFrom = this.epoch.firstSeq;
      const page = visibleTo(this.central.pageUpTo(this.epoch.id, turn.cutSeq), "main");
      const pending = main.pendingView();
      const gap = page.filter((e) => e.seq < main.coveredFrom && e.seq <= pending.upTo);
      const gapText = gap.length ? main.renderAsSeen(gap) : "";
      // HH 以她的名义记下、却不在这段对话里的：这句没发出去、今天下意识放下的（她自己会话里写的本来就在）（复核 #3）
      const noted = page.filter((e) => e.src === "main" && e.seq >= main.coveredFrom && (e.meta?.sendFailed === true || e.meta?.gateDigest === true));
      const notedText = noted.length ? main.renderAsSeen(noted) : "";
      // 会话开头带着上一页的尾巴：点明这一页从哪条开始，引她眼前那一行的开头几个字（复核 #2：工具结果折在动作那行里、没发出去的标记不单独成行，都跳过）
      const firstHere = main.openedFrom < pageFrom ? page.find((e) => e.seq >= Math.max(pageFrom, main.coveredFrom) && e.kind !== "result" && !unsentMark(e)) : undefined;
      const boundary = firstHere ? seenLine(main.renderAsSeen([firstHere])) : null;
      this.log.info("page turn: compacting by fork", {
        epoch: this.epoch.id, cutSeq: turn.cutSeq, pageView: this.pageView(),
        gapEntries: gap.length, gapChars: gapText.length, pendingChars: pending.text.length, noted: noted.length, boundary: boundary !== null,
      });
      const message = [
        gapText ? `${P.FORK_GAP_HEAD}\n${gapText}` : "",
        pending.text,
        notedText ? `${P.FORK_NOTED_HEAD}\n${notedText}` : "",
        P.compactForkPrompt(BLOCK_MAX_CHARS, { boundary, gap: !!gapText }),
      ].filter(Boolean).join("\n\n");
      const r = await main.fork(message, FORK_TIMEOUT_MS);
      if (this.turn !== turn) return;   // 等的时候看门狗放弃了这次翻页
      if (!r) return fallback("main session not forkable");
      this.log.info("page turn: fork", { ok: r.ok, error: r.error, calls: r.total.calls, cacheRead: r.total.cacheRead, cacheWrite: r.total.cacheWrite, input: r.total.input, output: r.total.output, chars: r.text.length });
      // 缓存大半没命中（工具清单、系统提示和主线不一样了？）：照样能用，但要显眼，不然省不下来也没人知道
      if (r.total.cacheWrite > FORK_CACHE_MISS_TOKENS && r.total.cacheWrite > r.total.cacheRead) this.log.warn("page turn: fork mostly missed the cache", { cacheRead: r.total.cacheRead, cacheWrite: r.total.cacheWrite });
      if (r.error === "timeout") this.forkOffEpoch = this.epoch.id;   // 这一页别再试分叉了
      if (!r.ok || !r.text.trim()) return fallback(r.error ?? "empty");
      // 比对的范围带上会话开头的上一页尾巴（压了就认出来删掉），别人的记录只按她当时看到的样子比
      const window = main.openedFrom < pageFrom
        ? [...visibleTo(this.central.since(main.openedFrom - 1), "main").filter((e) => e.seq < pageFrom && !this.inNightGap(e)), ...page]
        : page;
      const { text, stats } = resolveAnchors(r.text.trim(), window, { viewer: "main", pageFrom });
      const coverage = Math.round(P.refCoverage(text) * 100) / 100;
      this.log.info("page turn: fork anchors", { anchored: stats.anchored, resolved: stats.resolved, ambiguous: stats.ambiguous, dropped: stats.dropped, coverage, missing: stats.missing, ambiguousWhy: stats.ambiguousWhy });
      const minChars = forkMinChars(page.reduce((n, e) => n + e.tokens, 0));
      if (text.length < minChars) return fallback("too short", { chars: text.length, minChars });
      if (!P.blockHasRefs(text)) return fallback("anchors unresolved", { coverage });
      block = text;
    } catch (e) {
      return fallback("fork compaction threw", { error: String(e).slice(0, 200) });
    }
    // 收下压缩稿不在上面的 try 里：开了新一页以后再出错不能退回海马（那时旧页已经关了，海马只会压一页空的），只记日志（复核 #1）
    try {
      await this.acceptBlock(turn, block);
    } catch (e) {
      this.log.error("page turn: accepting the fork block failed", { error: String(e).slice(0, 300) });
    }
  }

  /** 整页（到切页点为止）交给一个新开的海马会话压缩，不靠它的游标或"最近一段" */
  private async askHippocampusToCompact(): Promise<void> {
    if (!this.turn) return;
    const hippo = this.region("hippocampus");
    await hippo.rotate();
    // 海马自己的记录不进压缩：上一次翻页压出来的稿和那段已经在前缀里，再压一遍就把上一页又总结一次（review 11-02）
    const page = visibleTo(this.central.pageUpTo(this.epoch.id, this.turn.cutSeq), hippo.id).filter((e) => e.src !== hippo.id);
    // 照主线眼前的样子压：她自己的原样（一条最多 COMPACT_ITEM_CHARS 字），别的脑区的工具结果折成一行、动作截到 300 字，说的记的照旧。
    // 翻页按她眼前算以后（11-04），一页里帮手的原文能到眼前的几倍，全量喂进去会超过海马的上下文
    const text = renderMemory(page, (s, e) => this.labelOf(s, e), { maxItemChars: COMPACT_ITEM_CHARS, timezone: this.cfg.schedule.timezone, seqs: true, mode: "sync", fullFor: "main", thinkChars: this.cfg.limits.syncThinkChars ?? 0, folds: this.folds });
    try {
      hippo.wake(`${text}\n\n${P.compactPrompt(BLOCK_MAX_CHARS)}`, { raw: true });
    } catch (e) {
      if (!(e instanceof SessionOpenError)) throw e;
      // 海马开不起来：这一次翻页马上放弃，隔一阵再试（11-13 两次各卡到 20 分钟看门狗，主线这一页一直涨）
      this.log.error("page turn: hippocampus would not open, giving up this time", { error: e.reason.slice(0, 200) });
      this.abortPageTurn();
    }
  }

  private async finishPageTurn(hippo: Region, ok: boolean): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    const summary = hippo.takeTurnText();
    if (!ok || !summary) {
      turn.attempts += 1;
      if (turn.attempts < MAX_ATTEMPTS) {
        this.log.warn("page turn: compaction failed, retrying", { attempts: turn.attempts, ok, empty: !summary });
        this.later(() => void this.askHippocampusToCompact(), RETRY_BASE_MS * turn.attempts);
      } else {
        this.log.error("page turn: compaction failed, giving up for now (page kept)");
        this.abortPageTurn();
      }
      return;
    }
    // 每条都要带编号；缺的先重试一次，第二次带警告收下（不算失败，免得翻页卡住、上下文一直涨）
    this.log.info("page turn: block ref coverage", { coverage: Math.round(P.refCoverage(summary) * 100) / 100, retried: turn.refRetried ?? false });
    if (!P.blockHasRefs(summary)) {
      if (!turn.refRetried) {
        turn.refRetried = true;
        this.log.warn("page turn: block without refs, retrying");
        void this.askHippocampusToCompact();
        return;
      }
      this.log.warn("page turn: block without refs, accepted");
    }
    await this.acceptBlock(turn, summary);
  }

  /** 收下压缩稿：加压缩块、开新一页（切页点以后的归新一页）、换前缀、各脑区换班 */
  private async acceptBlock(turn: PageTurn, summary: string): Promise<void> {
    this.epochs.addBlock(this.epoch.id, summary);
    this.epoch = this.epochs.begin("page-turn", turn.cutSeq + 1);
    this.central.retag(turn.cutSeq, this.epoch.id);          // 压缩期间写进来的记录归新的一页
    this.rebuildPrefix();
    this.turn = null;
    this.record("system", "system", B.brain.pageTurnRecorded(this.epoch.id, summary.length));
    await this.rotateAll();
    this.resumeBackgrounds();
    this.log.info("page turn done", { epoch: this.epoch.id, compactedTokens: this.epochs.compactedTokens(), via: turn.via });
    this.afterPageTurn();
  }

  private abortPageTurn(): void {
    this.turn = null;
    this.turnCooldownUntil = this.now() + TURN_COOLDOWN_MS;
    this.afterPageTurn();
  }

  private afterPageTurn(): void {
    if (this.pendingSleep) {
      const s = this.pendingSleep;
      this.pendingSleep = null;
      void this.sleep(s.reason, s.kind);
      return;
    }
    this.continueFocusIfNeeded();
    this.continueTaskIfNeeded();
  }

  /** 所有脑区换班：空闲的马上换，忙的等这一轮结束、安静下来再换；说话层先、主线最后 */
  private async rotateAll(): Promise<void> {
    const order = [...this.regions.values()].sort((a, b) => rank(a.spec.role) - rank(b.spec.role));
    for (const r of order) {
      if (r.busy) r.pendingRotate = true;
      else await r.rotate();
    }
  }

  private rotateWhenQuiet(r: Region): void {
    const check = (): void => {
      if (!r.pendingRotate) return;
      // 主线在翻页中先不换：翻页收尾会整体换班（rotateAll），翻页没成就等它结束再换（④ 主线被停过就换，可能正赶上翻页）
      if (r.busy || this.now() - r.lastEventAt < ROTATE_QUIET_MS || (r.spec.role === "main" && this.turn)) { this.later(check, ROTATE_QUIET_MS); return; }
      void this.rotateRegion(r);
    };
    this.later(check, ROTATE_QUIET_MS);
  }

  /**
   * 一个脑区单独换班（自己上下文满了、翻页时它正忙）：换完清它挂过的笔记页——新会话里只剩前缀和最近一段，
   * 换班前挂的页已经看不见了，不清的话要等下一次全局翻页才能再挂
   */
  private async rotateRegion(r: Region): Promise<void> {
    await r.rotate();
    this.learning?.notes.prefixRebuilt(r.id);
  }

  // ---------- 睡觉 ----------
  // 夜里那一觉就是记忆整理（原来 2:30 的整理并进海马）：海马照 scripts/sleep_organize.md 把这一天
  // 整理进记忆和人格（材料、提案、核对、按 hash 应用都是原来那套），积压的接着整理，全部整理完才清空压缩块、换新前缀。
  // 白天困了的小睡不整理：原始记录都在中央记忆里，夜里统一整理。
  async sleep(reason: string, kind: SleepKind | "manual" = "manual"): Promise<void> {
    if (this.sleeping) return;
    if (this.turn) { this.pendingSleep = { reason, kind }; return; }   // 翻完页再睡
    this.alertness = "asleep";
    if (kind === "night") kvSet(this.db, NIGHT_KEY, nightOf(this.now(), this.cfg.schedule.timezone));
    this.sleeping = { reason, kind, attempts: 0, since: this.now(), days: 0, firstPending: null, nudged: false, learnDay: null, engine: "legacy" };
    this.sleeping.fromSeq = this.record("system", "system", B.brain.sleepStarted(reason)).seq;
    // 夜里那一觉：那一截的开头现在就记下（半路 hhd 停了，再启动时收得上）；睡着时这一截还开着，开场照没有它来
    if (kind === "night") this.openNightGap(this.sleeping.fromSeq);
    this.log.info("sleep", { reason, kind });
    if (kind !== "night") {
      this.log.info("nap: no consolidation, raw memory stays for tonight's organizing");
      await this.wakeUp("consolidated");
      return;
    }
    // 真的夜里要开始了：手上的回放先停（开着的会话关掉），别跟她真的整理抢
    if (this.replays.running) {
      this.log.warn("sleep: the real night starts, stopping the running replay");
      // 停不下来也不能丢了她真的这一夜（最终评审 I4）
      try { await this.replays.stop(B.brain.replayStopRealNightStarts); } catch (e) { this.log.warn("sleep: stopping the replay failed", { error: String(e) }); }
    }
    await this.pauseBackgroundsForNight();
    // flow.json 说用分段的引擎（spec §5）：睡前那几步照旧，然后整夜交给引擎（不在这里等：tick 要接着跑，看门狗才看得见）
    const plan = this.nightEngine();
    if (plan) {
      const s = this.sleeping;
      s.engine = plan.flow.engine === "team" ? "team" : "flow";
      await this.recordGateDigest();
      this.pruneGate();
      if (this.sleeping !== s) return;
      const done: Promise<void> = this.flowNight(s, plan)
        .catch((e: unknown) => this.log.error("sleep: flow night wrap-up failed", { error: e instanceof Error ? e.stack : String(e) }))
        .finally(() => { if (this.nightDone === done) this.nightDone = null; });
      this.nightDone = done;
      return;
    }
    this.sleeping.firstPending = await this.firstPendingDay();
    await this.recordGateDigest();
    this.pruneGate();
    await this.askHippocampusToOrganize();
  }

  /**
   * 每日总结：整理前把今天闸门放下的动静记成一条 main 的笔记（夜里整理读它）。
   * 不带 inner：sleep_digest 收 main 的笔记时跳过 inner。同一天只做一次；出错只记日志，最多拖 60 秒（dailyDigest 的硬超时）。
   */
  private async recordGateDigest(): Promise<void> {
    if (!this.cfg.gate.digest) return;
    try {
      const now = this.now();
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.schedule.timezone }).format(now);
      if (kvGet(this.db, GATE_DIGEST_DAY_KEY) === day) return;
      const from = Number(kvGet(this.db, GATE_DIGEST_LAST_KEY)) || now - 86_400_000;
      let changes: Array<{ ts: number; line: string }> = [];
      try { changes = JSON.parse(kvGet(this.db, REGISTRY_CHANGES_KEY) ?? "[]") as typeof changes; } catch { changes = []; }
      let last: Record<string, number> = {};
      try { last = JSON.parse(kvGet(this.db, GATE_DIGEST_NOMINEES_KEY) ?? "{}") as typeof last; } catch { last = {}; }
      const people = this.currentPeople();
      const material = dailyDigestMaterial(this.db, from, now, this.gateRulesErrors(), changes.filter((c) => c.ts >= from && c.ts < now).map((c) => c.line), people, sourcesOf(this.cfg).chat, last);
      if (material === null) return;
      const ask = this.driver.ask?.bind(this.driver);
      const text = ask
        ? await dailyDigest({
            db: this.db, ask, material, later: this.later,
            base: { model: this.cfg.models.haiku, cwd: this.cfg.workspace, env: kernelEnv(this.cfg), claudeExecutable: this.cfg.kernel.claudeExecutable, timeoutMs: 60_000 },
          })
        : material.slice(0, 1500);
      this.record("main", "note", B.brain.gateDigestPrefix + text, { gateDigest: true });
      kvSet(this.db, GATE_DIGEST_LAST_KEY, String(nextDigestFrom(this.db, from, now)));   // 还没判完的行下次接着算
      kvSet(this.db, GATE_DIGEST_NOMINEES_KEY, JSON.stringify(nomineeCounts(this.db, now, people, sourcesOf(this.cfg).chat)));
      kvSet(this.db, GATE_DIGEST_DAY_KEY, day);
    } catch (e) {
      this.log.warn("gate digest failed", { error: String(e) });
    }
  }

  /** 闸门的账只留 30 天：每夜睡觉时清一次，不管每日总结开没开（final review M7） */
  private pruneGate(): void {
    try { pruneGateLog(this.db, this.now()); } catch (e) {
      this.log.warn("gate log prune failed", { error: String(e).slice(0, 200) });
    }
  }

  /**
   * 退役的文件（实例配置 memory.retiredFiles）：Write/Edit 写、Bash 往里写（重定向、tee、sed -i、cp/mv 的目标……）都拦下并说记到哪；
   * 读不拦。夜里整理写它们的提案（sleep/<日期>/proposed/…）也拦。
   */
  private retiredFileGuard(tool: string, input: unknown, role?: string): string | undefined {
    let hits: (re: RegExp) => boolean;
    if (tool === "Bash") {
      const command = String((input as { command?: unknown } | null)?.command ?? "");
      hits = (re) => bashWritesTo(command, re);
    } else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
      const raw = (input as { file_path?: unknown; notebook_path?: unknown } | null) ?? {};
      const path = posix.normalize(String(raw.file_path ?? raw.notebook_path ?? ""));
      hits = (re) => re.test(path);
    } else return undefined;
    const exists = (rel: string): boolean => this.fileExists(join(this.cfg.workspace, rel));
    for (const f of (this.retiredFiles ??= retiredFilesOf(this.cfg, this.log))) {
      if (!hits(f.path) || (f.whenExists !== undefined && !exists(f.whenExists)) || (f.whenMissing !== undefined && exists(f.whenMissing))) continue;
      return role === "hippocampus" ? f.hippocampus : f.other;
    }
    return undefined;
  }

  /** 夜里整理时海马只能往 sleep/ 里写（整理指南的硬规矩：改哪个文件都写成 sleep/<日期>/proposed/ 里的提案，由 sleep_apply 核过再换） */
  private organizerGuard(tool: string, input: unknown): string | undefined {
    if (this.sleeping?.kind !== "night") return undefined;
    if (!["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) return undefined;
    const raw = (input as { file_path?: unknown; notebook_path?: unknown } | null) ?? {};
    const path = String(raw.file_path ?? raw.notebook_path ?? "");
    const dir = this.cfg.sleep.workDir;
    const sleepDir = join(this.cfg.workspace, dir) + "/";
    const abs = path.startsWith("~/") ? join(this.cfg.sleep.home || homedir(), path.slice(2)) : path.startsWith("/") ? path : join(this.cfg.workspace, path);
    if (abs.startsWith(sleepDir) && !abs.includes("/../")) return undefined;
    const g = organizerOf(this.cfg, this.nightDir());
    return B.brain.organizerGuardRefusal(dir, path || B.brain.organizerGuardFileFallback, dir, g?.apply ? B.brain.organizerGuardCheckStep(g.lastStep ?? "", g.apply) : "");
  }

  private async askHippocampusToOrganize(): Promise<void> {
    const s = this.sleeping;
    if (!s) return;
    s.since = this.now();
    s.nudged = false;
    const hippo = this.region("hippocampus");
    await hippo.rotate();
    if (this.mem) {
      this.mem.revertNight();   // 上一跑没收尾的先撤掉，这一跑从干净状态开始
      this.mem.beginNight(`night:${nightOf(this.now(), this.cfg.schedule.timezone)}/${s.firstPending ?? "today"}`);
    }
    try {
      hippo.wake(P.nightOrganize(s.reason, Boolean(this.mem), nightGuide(this.cfg, this.cfg.sleep.home || homedir(), this.nightDir())), { raw: true });
    } catch (e) {
      if (!(e instanceof SessionOpenError)) throw e;
      // 海马开不起来：照整理失败处理（撤回这一批、过一会儿再试一次，还不行就带着压缩块醒来），不等整夜看门狗
      this.log.error("sleep: hippocampus would not open", { error: e.reason.slice(0, 200) });
      await this.finishSleep(hippo, false);
    }
  }

  /** 最早一个没整理的日子（sleep_digest.py pending 每行一个日期）；没有就 null（旧的整理：查不成也当没有，照旧整理今天） */
  /** The night module is on (it is required; a test brain may have no modules) */
  private nightOn(): boolean {
    return this.nightDir() !== null;
  }

  /** The night module's directory, when it is on */
  private nightDir(): string | null {
    return this.modules?.loaded.find((l) => l.spec.name === "night")?.ctx.dir ?? null;
  }

  private async firstPendingDay(): Promise<string | null> {
    return (await this.pendingDays(false))[0] ?? null;
  }

  /**
   * 没整理的日子，最早的在前（sleep_digest.py pending 每行一个日期）。查不成（退出码不是 0、超时）：
   * strict 就抛错（分段整理：这一夜算出错，日志看得见），不然就是空的
   */
  private async pendingDays(strict: boolean): Promise<string[]> {
    const argv = this.cfg.sleep.pendingDays;
    const own = Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string" && a.length > 0);
    // none configured: the night module's sleep_digest.py pending, when that module is on; neither: this role has no such command
    if (!own && !this.nightOn()) return [];
    const r = own ? await this.run(argv[0]!, argv.slice(1), { cwd: this.cfg.workspace, timeoutMs: 60_000 }) : await this.modules!.run("night", "sleep_digest.py", ["pending"], { timeoutMs: 60_000 })!;
    if (r.code !== 0) {
      if (strict) throw new Error(B.brain.pendingDaysFailed(own ? argv.map((a) => basename(a)).join(" ") : "sleep_digest.py pending", r.code, (r.stderr.trim() || r.stdout.trim()).slice(0, 300)));
      return [];
    }
    return [...new Set(r.stdout.match(/\d{4}-\d{2}-\d{2}/g) ?? [])];
  }

  // ---------- 夜里分段整理（sleep-flow，spec §4–§10）：flow.json 说用引擎才走这里，不然照旧海马整理 ----------

  /**
   * 这一夜用不用分段的引擎：配置 sleep.newEngine 是 true 才读 flow.json（坏了用上一份能用的）+ SOUL + common，都有、engine 是 flow 才给；
   * 不给就是旧的整理，日志里写为什么
   */
  private nightEngine(): NightPlan | null {
    return this.nightEngineWhy().plan;
  }

  /** nightEngine 加上不用引擎的原因（hh sleep plan 要把原因说给人听） */
  private nightEngineWhy(): { plan: NightPlan | null; why: string } {
    // 新的睡眠停了（sleep/stopped.ts）：配置明说开才读 flow.json，不然有没有流程文件都走旧的整理（回放带自己的流程目录，不走这里）
    if (this.cfg.sleep.newEngine !== true) {
      this.log.info("sleep: legacy organizer tonight", { why: S.stopped.newEngineOff });
      return { plan: null, why: S.stopped.newEngineOff };
    }
    const r = readNight({ cfg: this.cfg, read: this.readText, write: (p, s) => this.sleepFs.write(p, s) });
    if (!r.plan) {
      const data = { why: r.why, ...(r.problems.length ? { problems: r.problems.slice(0, 10) } : {}) };
      // 没有 flow.json、engine 写的 legacy：本来就该走旧的，info；真出了问题（坏了又没有上一份、缺 SOUL / common / skill 页）才 warn
      if (r.quiet) this.log.info("sleep: legacy organizer tonight", data);
      else this.log.warn("sleep: flow not usable, legacy organizer tonight", data);
      return { plan: null, why: r.why };
    }
    if (r.source === "last-good") this.log.warn("sleep: flow file has problems, running the last good one", { problems: r.problems.slice(0, 10) });
    else if (r.problems.length) this.log.warn("sleep: flow loaded with problems", { problems: r.problems.slice(0, 10) });
    return { plan: r.plan, why: "" };
  }

  /**
   * hh sleep replay <日>：拿新的流程在隔离的工作区、事件库拷贝上把那一天重新整理一遍（sleep/replay.ts），马上回回放目录、后台跑。
   * 没明说 iKnowItSpendsQuota（--i-know-it-spends-quota）就只回一句、什么都不开（新的睡眠停了，sleep/stopped.ts；hhd 这边核，不只是命令行）；
   * 正在跑一个、她正在夜里睡（真的整理在跑）都不开
   */
  sleepReplay(day: string, o: { base?: string; flowDir?: string; iKnowItSpendsQuota?: boolean } = {}): string {
    const { iKnowItSpendsQuota, ...opts } = o;
    if (iKnowItSpendsQuota !== true) return S.stopped.replayRefused(REPLAY_CONFIRM, REPLAY_CONFIRM);
    if (this.sleeping?.kind === "night") throw new Error(B.brain.sleepReplayRefusedDuringNight);
    const { dir } = this.replays.start(this.replayDeps(), { day, ...opts });
    return B.brain.sleepReplayStarted(dir, join(dir, "out"));
  }

  /** hh sleep replay-status */
  sleepReplayStatus(): string {
    return this.replays.status(this.cfg.stateDir, this.now());
  }

  /** hh sleep replay-stop：叫停手上的回放（runner 叫停、开着的会话全关） */
  sleepReplayStop(): Promise<string> {
    return this.replays.stop(B.brain.sleepReplayStoppedManually);
  }

  /**
   * 回放要的 Brain：事件记忆一律不带向量服务（embedder: null，不读 OpenAI 的 key）；HH 工具里「想起原话」读拷贝上的中央记忆和原话层，
   * 笔记的联想（会调 OpenAI）不给；学习的工作单、把关由回放自己给（不判断、不送把关）
   */
  private replayDeps(): ReplayDeps {
    const later = this.nightBrain().later;
    const openMem: ReplayDeps["openMem"] = (db, o) => {
      const live = this.mem;
      const tpl = live?.store.peopleTemplate;
      const mem = new EventMemory({
        db, embedder: null, now: this.now, tz: live?.tz ?? this.cfg.schedule.timezone, ...(tpl ? { peopleTemplate: tpl } : {}),
        ...(o.peopleDir ? { peopleDir: o.peopleDir } : {}), ...(o.peopleActive ? { peopleActive: o.peopleActive } : {}),
        log: { warn: (m, data) => this.log.warn(m, data), info: (m, data) => this.log.info(m, data) },
      });
      if (live) mem.store.owners = live.store.owners;
      return mem;
    };
    return {
      cfg: this.cfg, driver: this.driver, db: this.db, log: this.log, run: this.run, now: this.now, later, openMem,
      peopleSwitch: peopleSwitchFileOf(this.cfg),
      tools: (id, names, x) => {
        const { recallNotes: _notes, askNotes: _ask, ...ctx } = this.toolContext(id);
        const replayCtx: ToolContext = {
          ...ctx, workspace: x.workspace,
          recallLocal: (args) => recallCentral(x.db, args, { timezone: this.cfg.schedule.timezone, labels: (src) => this.labelOf(src) || B.common.self, folds: this.folds }),
          recallQuotes: (q, who, o) => x.mem.quotes(q, { ...(who ? { who } : {}), ...(o?.olderOnly ? { olderOnly: true } : {}) }),
          recallQuotesDay: (day, who) => x.mem.quotesDay(day, who ? { who } : {}),
          askNotes: async () => S.replay.notHere,
        };
        return [...buildTools(replayCtx, names), ...memTools(x.mem, id, names, x.learn)];
      },
    };
  }

  /** hh sleep plan：今晚引擎排的先后；不用引擎就说用旧的整理和为什么 */
  sleepPlan(): string {
    const { plan, why } = this.nightEngineWhy();
    if (!plan) return B.brain.sleepPlanLegacy(why);
    return B.brain.sleepPlanEngine(plan.flow.engine, plan.flow.maxParallel, planText(plan.flow));
  }

  /** hh sleep bank import：读体检格式的题文件进题库（读不了、格式不对就回原因，什么都不写） */
  bankImport(file: string, tag: string, layer: "resident" | "searchable" | "archive"): string {
    let text: string;
    try { text = readFileSync(file, "utf8"); } catch (e) { return B.brain.bankImportUnreadable(file, (e as Error).message); }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return B.brain.bankImportBadJson(file); }
    if (!Array.isArray(raw)) return B.brain.bankImportNotArray(file);
    if (raw.some((x) => typeof x !== "object" || x === null || Array.isArray(x))) return B.brain.bankImportItemNotObject(file);
    try {
      const n = new Bank(this.db, this.now).importSeed(raw, { tag, layer, day: this.localDay(this.now()) });
      return B.brain.bankImportDone(n, tag, layer);
    } catch (e) { return B.brain.bankImportRejected(file, (e as Error).message); }
  }

  /** hh sleep bank stats */
  bankStats(): string {
    const s = new Bank(this.db, this.now).stats();
    const layers = (["resident", "searchable", "archive"] as const);
    const rate = layers.map((l) => `${l} ${s.passRate[l] === null ? "—" : `${Math.round(s.passRate[l]! * 100)}%`}`).join(B.brain.bankStatsRateSep);
    return B.brain.bankStatsSummary(s.active, s.pending, s.retired, layers.map((l) => `${l} ${s.byLayer[l]}`).join(B.brain.bankStatsLayerSep), rate);
  }

  /** 夜里引擎用的 Brain：会话、脚本、文件、事件库、钟（和事件库同一个）、可取消的定时、给一个会话的 HH 工具 */
  private nightBrain(): NightBrain {
    return {
      cfg: this.cfg, driver: this.driver, db: this.db, log: this.log, mem: this.mem ?? null, fs: this.sleepFs,
      run: (cmd, args, o) => this.run(cmd, args, o),
      readText: this.readText,
      now: this.now,
      later: (fn, ms) => {
        let off = false;
        const cancel = this.later(() => { if (!off) fn(); }, ms);
        return () => { off = true; if (typeof cancel === "function") cancel(); };
      },
      hhTools: (id, names, mem) => [...buildTools(this.toolContext(id), names), ...memTools(mem ?? this.mem, id, names, this.learnNight())],
      dayNotes: (day) => this.night?.notes.get(day) ?? [],
      memAt: (path) => this.memAt(path),
    };
  }

  /**
   * 考整理前用：在事件库拷贝上开一个只读的事件记忆，向量服务、时区、人物卡模板、主人跟 Brain 自己的一样（hhd.ts 怎么建的就怎么建）；
   * 不给人物卡目录（拷贝上的不往工作区导出）。没有事件记忆给 null
   */
  private memAt(path: string): { mem: EventMemory; close(): void } | null {
    const live = this.mem;
    if (!live) return null;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const tpl = live.store.peopleTemplate;
      const mem = new EventMemory({
        db, embedder: live.index.embedder, now: this.now, tz: live.tz, ...(tpl ? { peopleTemplate: tpl } : {}),
        log: { warn: (m, data) => this.log.warn(m, data), info: (m, data) => this.log.info(m, data) },
      });
      mem.store.owners = live.store.owners;
      return { mem, close: () => db.close() };
    } catch (e) {
      db.close();
      throw e;
    }
  }

  /**
   * 这周额度的读数（百分比；额度把关看的那一个）：先问一次新的。问不到：stale 就用存着的（睡前：几分钟前醒着时问过的），
   * 不然给 null（睡后：存着的是睡前的，拿它对账会以为一夜没花）
   */
  private async weekQuota(stale: boolean): Promise<number | null> {
    const r = await this.pollQuota();
    if (r === "no-plan") return null;
    if (r) return r.sevenDay?.used ?? null;
    return stale ? this.quotaState().sevenDay?.used ?? null : null;
  }

  /**
   * 一整夜交给引擎：积压的日子一天天整理（最旧的先），落地的日子做学习的收尾，再醒来
   * （整夜做完——正常收尾、落地了、没有哪天整天推迟——才算整理好、换新前缀）。
   * 某一天里出错：引擎撤回那一天、这一夜停下（stoppedBy error，前面落地的照算），这里记日志、照样收尾醒来；
   * 引擎外面抛错：记日志、醒来。这一夜都不退回旧的整理
   */
  private async flowNight(s: Sleeping, plan: NightPlan): Promise<void> {
    const sc = this.cfg.sleep;
    const weights = sleepWeights(sc.weights);
    const budget = new Budget({ unitsPerPct: sc.unitsPerPct, targetPct: plan.flow.budget.targetPct, hardPct: plan.flow.budget.hardPct });
    const auditMs = sc.auditMinutes * 60_000;
    let res: NightResult | null = null;
    let night: Brain["night"] = null;
    /** pending 列过的日子（这一夜一共） */
    const seen = new Set<string>();
    try {
      const before = await this.weekQuota(true);
      if (this.stopping) {   // 读额度最多等 60 秒；这期间停机了，别在关机的时候开始这一夜
        this.log.info("sleep: stopping, flow night not started");
        return;
      }
      const notes = new Map<string, string[]>();
      // 会话的 host、验证器、多人模式、全天考试、runner 怎么拼：sleep/night.ts（回放也用这一份）
      const nightId = nightOf(this.now(), this.cfg.schedule.timezone);
      const { hosts, runner } = assembleNight(this.nightBrain(), plan, { night: nightId, budget, weights, auditMs, watchdogMs: sc.watchdogHours * 3_600_000, maxDays: Infinity });
      night = { hosts, runner, notes, budget, weights };
      this.night = night;
      this.log.info("sleep: flow night starts", { flow: plan.hash, stages: plan.flow.stages.length, tools: hosts.union.length });
      let listed: string[] | null = null;
      const lookup = async (): Promise<string[]> => { listed = await this.pendingDays(true); for (const d of listed) seen.add(d); return listed; };
      res = await runner.runNight({
        night: nightId,
        pending: async () => (await lookup())[0] ?? null,
        backlog: async () => (listed ?? (await lookup())).length,
      });
      // 哪一天里抛了错：引擎停在那一天（撤回它），前面落地的照算——照样做学习的收尾、醒来
      if (res.stoppedBy === "error") this.log.error("sleep: flow night failed", { error: res.error ?? "", landed: res.landed });
      if (!res.landed.length && seen.size) {
        this.log.warn("sleep: flow night landed nothing", { listed: [...seen], deferredDays: res.deferredDays, stoppedBy: res.stoppedBy });
      }
      const after = this.stopping ? null : await this.weekQuota(false);
      try { setRunQuota(this.db, res.runId, before, after); } catch (e) { this.log.warn("sleep: writing the quota readings failed", { error: String(e).slice(0, 200) }); }
    } catch (e) {
      this.log.error("sleep: flow night failed", { error: e instanceof Error ? e.stack ?? e.message : String(e) });
    } finally {
      if (night && this.night === night) this.night = null;
    }
    if (this.stopping) {
      this.log.info("sleep: flow night wrapped up during shutdown, not waking", { landed: res?.landed ?? [] });
      return;
    }
    if (this.sleeping !== s) {
      this.log.warn("sleep: flow night ended after she was already woken (watchdog)", { landed: res?.landed ?? [] });
      return;
    }
    const landed = res?.landed ?? [];
    // 学习的收尾：每个落地的日子都做（又犯），最后一天再回测、写每周数字
    landed.forEach((day, i) => this.learnAfterNight(day, i === landed.length - 1));
    // 清空压缩块、换新前缀只在这一夜整个做完时：正常收尾、至少落地了一天、没有哪天整天推迟或撤回（不然跟旧的整理失败一样留着）
    await this.wakeUp(res?.stoppedBy === "done" && landed.length > 0 && res.deferredDays.length === 0 ? "consolidated" : "failed", s);
  }

  private async finishSleep(hippo: Region, ok: boolean): Promise<void> {
    const s = this.sleeping;
    if (!s) return;
    // 看最后那段话（前面可能说过「等帮手交回」之类的）
    const last = hippo.finalSay().trim();
    const text = hippo.takeTurnText().trim();
    const failed = !ok || /^AUTOMATION_FAILED/.test(last);
    if (failed) {
      const r = this.mem?.revertNight();
      if (r) this.log.warn("event memory: organizing failed, batch reverted", { reverted: r.reverted, conflicts: r.conflicts.length });
      s.attempts += 1;
      this.log.warn("sleep: organizing failed", { attempts: s.attempts, ok, report: text.slice(0, 300) });
      if (s.attempts < 2) {
        this.later(() => void this.askHippocampusToOrganize(), RETRY_BASE_MS);
        return;
      }
      this.log.error("sleep: organizing failed, waking up with blocks kept");
      await this.wakeUp("failed");
      return;
    }
    // 这一天还没标完成：多半是她提前结束了这一轮（半路停了）——同一个会话里叫她接着做一次（这一跑的批次还开着）
    const pending = await this.firstPendingDay();
    if (this.sleeping !== s) return;   // 等的时候看门狗已经放弃了这一觉
    if (pending && pending === s.firstPending && !s.nudged) {
      s.nudged = true;
      this.log.info("sleep: the day is still pending after the turn, asking the organizer to continue", { day: pending });
      hippo.wake(P.nightContinue(pending, nightGuide(this.cfg, this.cfg.sleep.home || homedir(), this.nightDir())), { raw: true });
      return;
    }
    this.mem?.commitNight(s.firstPending);
    // 整理的是积压的那天；没有积压就是刚过去的这一夜那天
    const day = s.firstPending ?? nightOf(this.now(), this.cfg.schedule.timezone);
    s.days += 1;
    s.attempts = 0;
    s.nudged = false;
    // 还有积压就接着整理；最早那天还是刚才那天（被推迟了：额度紧、只写了提案），就等下一晚，别空跑
    const maxDays = this.cfg.sleep.nightMaxDays;
    const next = s.days < (Number.isInteger(maxDays) && maxDays! > 0 ? maxDays! : NIGHT_MAX_DAYS) ? pending : null;
    const another = next && next !== s.firstPending ? next : null;
    // 学习的收尾：还要接着整理下一天时只记这一天的又犯，最后一天整理完才用最后的封面回测一次
    this.learnAfterNight(day, !another);
    s.learnDay = another ? day : null;
    if (another) {
      this.log.info("sleep: another day pending, organizing it too", { done: s.days, next: another });
      s.firstPending = another;
      await this.askHippocampusToOrganize();
      return;
    }
    if (next) this.log.info("sleep: the same day is still pending (deferred), leaving it for the next night", { day: next });
    await this.wakeUp(pending !== null ? "deferred" : "consolidated");   // 还有日子列着（最早那天推迟了，或到了一夜最多那几天）：压缩块整份留着，前面几天整理好了也留（还列着的那天白天压的块在里面，分不开）
  }

  /**
   * 整理完一天后学习的收尾（又犯；final 时再发号、刷封面、回测、写每周数字）：放着自己跑，不等它；出错只记 warn，不挡醒来
   */
  private learnAfterNight(day: string, final: boolean): void {
    const learning = this.learning;
    if (!learning) return;
    const failed = (e: unknown): void => this.log.warn("learning: after-night failed", { day, error: String(e).slice(0, 200) });
    try {
      learning.afterNight(day, { final }).catch(failed);
    } catch (e) {
      failed(e);
    }
  }

  /** 早上第一个专注时段：夜里到这个点为止 */
  private morning(): string {
    return this.cfg.schedule.focusSlots[0] ?? this.cfg.schedule.morning ?? DEFAULT_MORNING;
  }

  /**
   * 循环提醒排在 due 的这一次已经做过了：记的「做过了」和它在同一天（HH 的一天，凌晨 4 点换），
   * 或者记在它该叫之后（夜里压到早上才叫的、停机补叫的：排的那一刻以后做过就不用再叫）
   */
  private remindDoneFor(id: number, due: number): boolean {
    const done = this.schedule.doneAt(id);
    const tz = this.cfg.schedule.timezone;
    return done !== null && (done >= due || localTime(done, tz).day === localTime(due, tz).day);
  }

  /**
   * 循环提醒到点、没记做过了：上一次该叫以后（最多一天）、今天、此刻以前，跑命令的动作（schedule.remindEvidenceTools）里
   * 出现过提醒里写的脚本，附一句什么时候看到的，让她自己判断；排提醒、看提醒的那一下（remind / reminders）本身就带着文件名，不算
   */
  private remindLooksDone(item: ScheduleItem, now: number): string {
    if (!item.everyMs) return "";
    const names = scriptNames(item.text);
    if (!names.length) return "";
    const tz = this.cfg.schedule.timezone;
    const today = localTime(now, tz).day;
    const tools = new Set(this.cfg.schedule.remindEvidenceTools ?? []);
    const since = Math.max(now - 86_400_000, item.due - item.everyMs);
    const hits = this.central.actsMentioning(since, names).filter((e) =>
      e.ts < now && localTime(e.ts, tz).day === today && tools.has(String(e.meta?.tool ?? "")) &&
      !/^remind(?:ers)? /.test(e.text) && names.some((n) => mentionsScript(e.text, n)));
    if (!hits.length) return "";
    const touched = names.filter((n) => hits.some((e) => mentionsScript(e.text, n)));
    const ts = hits.map((e) => e.ts);
    return P.remindLooksDone(hhmm(Math.min(...ts), tz), hhmm(Math.max(...ts), tz), touched);
  }

  /** 夜里放空：这一夜已经睡过（整理完或放弃了），还没到早上。消息照常回，自己不主动做事 */
  private nightRest(now = this.now()): boolean {
    const s = this.cfg.schedule;
    return !this.sleeping && kvGet(this.db, NIGHT_KEY) === nightOf(now, s.timezone) && inNight(now, s.timezone, s.nightSleep, this.morning());
  }

  /**
   * 最近那一夜在中央记忆里占的那一截（内存里没有就读存着的；没睡过、还开着、存坏了给 null）。
   * 主线自己写的不算在里面（keep）；那一夜整理好了、或者最早那天推迟了，才带那句说明（两种说法不同）
   */
  private nightGapCache: (SeqGap & { note?: string }) | null | undefined;
  private nightGap(): (SeqGap & { note?: string }) | null {
    if (this.nightGapCache !== undefined) return this.nightGapCache;
    const g = this.storedNightGap();
    this.nightGapCache = g && g.upTo !== undefined && g.upTo >= g.after
      ? { after: g.after, upTo: g.upTo, keep: "main", ...(g.done ? { note: P.BEFORE_SLEEP_NOTE } : g.deferred ? { note: P.BEFORE_SLEEP_DEFERRED_NOTE } : {}) }
      : null;
    return this.nightGapCache;
  }

  /**
   * 给开场用的那一截：现在这一页正是那一夜整理好或推迟了（才有那句说明）以后开的醒来那一页、还没翻过页（醒来时先收那一截、紧接着开这一页），
   * 就加上 wakePage——重启后整页带上的开场也接上睡前那段（#0054 漏洞）
   */
  private sleptThrough(): (SeqGap & { note?: string; wakePage?: boolean }) | null {
    const g = this.nightGap();
    return g?.note && this.epoch.firstSeq === g.upTo + 1 ? { ...g, wakePage: true } : g;
  }

  /** 醒来那一页里主线每次开场（前缀 + 第一条消息）原样存一份（stateDir/wake，留最新 14 份）：不用再猜她早上看到了什么 */
  private keepOpening(prefix: string, text: string): void {
    try {
      if (this.sleptThrough()?.wakePage) saveOpening({ dir: join(this.cfg.stateDir, OPENINGS_DIR), at: this.now(), tz: this.cfg.schedule.timezone, prefix, text, epoch: this.epoch.id, log: this.log });
    } catch (e) { this.log.warn("wake opening: not archived", { error: String(e).slice(0, 200) }); }   // 存不了不挡开场
  }

  private storedNightGap(): { after: number; upTo?: number; done?: boolean; deferred?: boolean } | null {
    try {
      const g = JSON.parse(kvGet(this.db, NIGHT_GAP_KEY) ?? "null") as { after?: unknown; upTo?: unknown; done?: unknown } | null;
      if (!g || !Number.isInteger(g.after)) return null;
      return { after: g.after as number, ...(Number.isInteger(g.upTo) ? { upTo: g.upTo as number } : {}), done: g.done === true, deferred: "deferred" in g && g.deferred === true };
    } catch { return null; }
  }

  /** 这条记录落在最近那一夜的那一截里（主线的开场没带它） */
  private inNightGap(e: Entry): boolean {
    const g = this.nightGap();
    return !!g && e.seq > g.after && e.seq <= g.upTo && e.src !== g.keep;
  }

  private openNightGap(after: number): void {
    kvSet(this.db, NIGHT_GAP_KEY, JSON.stringify({ after }));
    this.nightGapCache = undefined;
  }

  private closeNightGap(after: number, done: boolean, deferred = false): void {
    kvSet(this.db, NIGHT_GAP_KEY, JSON.stringify({ after, upTo: this.central.lastSeq(), done, ...(deferred ? { deferred: true } : {}) }));
    this.nightGapCache = undefined;
  }

  /** 整理后的记忆收尾：开新一页、换前缀；clear（整理好了）才清空压缩块，推迟了的一夜留着 */
  private async beginWakePage(clear: boolean): Promise<void> {
    if (clear) this.epochs.clearBlocks();
    this.epoch = this.epochs.begin("wake", this.central.lastSeq() + 1);
    // 夜里那一觉：开了醒来那一页以后、换前缀以前跑一次配好的命令（sleep.wakeRefresh），换上的是按「醒了」重新生成的文件。
    // 等它的时候看门狗从现在算（命令有上限），不会在半路再叫醒一次
    // none configured: the night module's persona snapshot, when that module is on
    const refresh = this.cfg.sleep.wakeRefresh
      ?? (this.nightOn() ? { name: "ledger_snapshot.py", run: (ms: number) => this.modules!.run("night", "ledger_snapshot.py", [], { timeoutMs: ms })! } : undefined);
    if (this.sleeping?.kind === "night" && refresh !== undefined) {
      this.sleeping.since = this.now();
      await refreshBeforeWake(refresh, this.cfg.sleep.wakeRefreshSec, { cwd: this.cfg.workspace, run: this.run, later: this.later, now: this.now, log: this.log });
    }
    this.rebuildPrefix();
    await this.rotateAll();
  }

  /**
   * 醒来。how：consolidated 清空压缩块、开醒来那一页；deferred 也开醒来那一页、换前缀，压缩块留着；failed 压缩块原样留着、不开新页。
   * 夜里（这一夜睡过、还没到早上）醒来不叫主线起来做事，只记一笔，进入夜里放空；睡着时攒的消息马上处理。
   */
  private async wakeUp(how: WakeKind, flow?: Sleeping): Promise<void> {
    if (!flow) return this.wakeUpNow(how);
    // 分段整理的一夜（flow 给了）：只醒一次——兜底的看门狗和这一夜自己的收尾撞上时，后到的那个什么都不做
    if (this.sleeping !== flow || flow.waking) return;
    flow.waking = true;
    try {
      await this.wakeUpNow(how);
    } catch (e) {
      // 醒到一半出错（换新前缀时关会话失败之类）：她还睡着，放开闩，兜底的看门狗到点再叫（不清压缩块）
      this.log.error("sleep: waking up from the flow night failed", { consolidated: how === "consolidated", error: e instanceof Error ? e.stack ?? e.message : String(e) });
    } finally {
      if (this.sleeping === flow) flow.waking = false;
    }
  }

  private async wakeUpNow(how: WakeKind): Promise<void> {
    this.mem?.revertNight();   // 还开着的一跑（看门狗、放弃）不算数
    const learnDay = this.sleeping?.learnDay;
    const engine = this.sleeping?.engine ?? "legacy";
    const night = this.sleeping?.kind === "night";
    // 整理放弃了：关掉海马的会话（后台帮手跟着停），免得帮手交回时冒出一轮没人看着的整理（分段整理的夜里海马没整理，不用关）
    if (how === "failed" && this.sleeping && engine === "legacy") await this.region("hippocampus").rotate();
    // 前面整理完的那天还没做学习收尾的最后一步（后面那天整理不成放弃了）：海马关了再补上（发号要改她的页，别和卡住的整理抢）
    if (learnDay) this.learnAfterNight(learnDay, true);
    // 夜里那一觉（整理好没好都记）：睡着到这一刻写进中央记忆的那一截收上，之后新会话的开场跳过它、带睡着以前的（#0054）。
    // 要在换班以前：换班时开出来的会话不能用前一夜的那一截。小睡不记：它中间没有整理，开场照旧
    if (night && this.sleeping?.fromSeq !== undefined) this.closeNightGap(this.sleeping.fromSeq, how === "consolidated", how === "deferred");
    if (how !== "failed") await this.beginWakePage(how === "consolidated");
    this.sleeping = null;
    this.alertness = "awake";
    this.lastActivity = this.now();
    if (this.nightRest()) {
      this.record("system", "system", P.nightRestNote(this.morning(), how));
      this.log.info("night sleep done: resting until morning", { epoch: this.epoch.id, consolidated: how === "consolidated", ...(how === "deferred" ? { deferred: true } : {}), engine });
    } else {
      this.record("system", "system", how === "consolidated" ? B.brain.wokeConsolidated : how === "deferred" ? P.WOKE_UP_DEFERRED : B.brain.wokeNotConsolidated);
      this.resumeBackgrounds();
      this.log.info("woke up", { epoch: this.epoch.id, consolidated: how === "consolidated", ...(how === "deferred" ? { deferred: true } : {}), engine });
      // 夜里那一觉睡过了早上：第一个专注时段（规划）已经开始了、今天还没开过，醒来马上补上（spec §10.2）
      if (night && this.catchUpMorningPlan()) this.wakeMain(`${P.WOKE_UP_AFTER_NIGHT}\n\n${P.FOCUS_PLAN}`, { cue: P.FOCUS_PLAN, cause: "wake-up" });
      else this.wakeMain(night ? P.WOKE_UP_AFTER_NIGHT : P.WOKE_UP, { cause: "wake-up" });
    }
    this.resumeDeep(false);
    this.deliverTodos();
    this.resumeGated();   // 睡着时闸门判出来、要给她看的
  }

  /**
   * 睡过了早上（spec §10.2）：今天早上第一个专注时段已经开始了、还没开过 → 记成开过了，要补上规划专注；
   * 那个时段已经过了就排一段一样长的专注（每轮结束照样叫回来）。返回要不要补
   */
  private catchUpMorningPlan(): boolean {
    const s = this.cfg.schedule;
    const first = s.focusSlots[0];
    if (!first) return false;
    const now = this.now();
    const lt = localTime(now, s.timezone);
    const key = `${lt.day} ${first}`;
    if (lt.minutes < parseHM(first) || this.lastFocusSlotKey === key) return false;
    this.lastFocusSlotKey = key;
    if (focusSlotAt(now, s.timezone, s.focusSlots, s.focusMinutes) !== first) {
      const until = Math.max(now + s.focusMinutes * 60_000, this.work && now < this.work.until ? this.work.until : 0);
      this.work = { until, why: B.brain.morningPlanLate };
      kvSet(this.db, WORK_KEY, JSON.stringify(this.work));
    }
    this.log.info("slept past the morning slot: planning focus now", { slot: first });
    return true;
  }

  // ---------- 定时 ----------
  async tick(): Promise<void> {
    const now = this.now();
    const s = this.cfg.schedule;

    this.sweepBackgrounds();
    if (!this.sleeping && this.alertness !== "asleep") this.resumeDeep(true);

    // 看门狗：翻页 / 睡觉卡太久就放弃，免得一直卡着
    if (this.turn && now - this.turn.since > TURNING_WATCHDOG_MS) {
      this.log.error("page turn watchdog: stuck, aborting");
      this.abortPageTurn();
    }
    if (this.sleeping && this.sleeping.engine !== "legacy") {
      // 分段整理：引擎自己有整夜的看门狗（watchdogHours，到点关掉手上的段、收尾）；这里只兜它收不了尾的情况（已经在醒了就不兜）
      const s = this.sleeping;
      if (!s.waking && now - s.since > this.cfg.sleep.watchdogHours * 3_600_000 + FLOW_WATCHDOG_GRACE_MS) {
        this.log.error("sleep watchdog: stuck, waking up", { engine: s.engine });
        const night = this.night;
        if (night) {
          night.runner.abort(B.brain.sleepWatchdogAbort);
          await withTimeout(night.hosts.shut(), NIGHT_STOP_WAIT_MS);
        }
        // 等收摊的时候这一夜自己收了尾、已经醒了（或正在醒）：不再醒一次
        await this.wakeUp("failed", s);
      }
    } else if (this.sleeping && now - this.sleeping.since > SLEEP_WATCHDOG_MS) {
      this.log.error("sleep watchdog: stuck, waking up");
      await this.wakeUp("failed");
    }

    const busy = [...this.regions.values()].some((r) => r.busy && r.spec.role !== "side" && r.spec.role !== "deep");   // 后台和下意识在忙不挡睡觉（睡前会先放下）
    const slot = this.currentFocusSlot();

    // 脑干：困不困、睡不睡
    const d = decide(this.alertness, {
      now,
      compactedTokens: this.epochs.compactedTokens(),
      busy,
      lastActivity: this.lastActivity,
      inFocus: slot !== null || this.nightRest(now),   // 夜里放空不小睡（推迟了的一夜留着的块别被小睡清掉、再记一句「做完了」）；到了必须睡照睡
      nightDue: nightSleepDue(now, s.timezone, s.nightSleep, this.morning(), kvGet(this.db, NIGHT_KEY) ?? null),
    }, { sleepyAt: this.cfg.limits.sleepyAtTokens, mustSleepAt: this.cfg.limits.mustSleepAtTokens, idleMinutes: this.cfg.limits.idleMinutesBeforeSleep });
    if (d.sleepNow) {
      await this.sleep(d.reason, d.kind);
      return;
    }
    if (this.alertness !== "asleep") this.alertness = d.state;
    if (this.alertness === "asleep" || this.turn) return;

    // 没读到也隔 2 分钟再试（不每个 tick 都开一个连接）
    if (now - this.lastQuotaPoll >= QUOTA_POLL_MS) {
      this.lastQuotaPoll = (await this.pollQuota()) ? now : now - QUOTA_POLL_MS + 2 * 60_000;
    }

    // 排出来的专注：夜里也照开（明确排了的就是要做）
    for (const item of this.schedule.takeDue(now, "focus")) this.startWork(item.text, item.minutes ?? s.focusMinutes);

    // 夜里放空：到早上前不漫想、不开固定专注，她排的提醒也留到早上；消息和感官事件不走这里，照常送到
    if (this.nightRest(now)) return;

    // 她自己排的提醒：循环的、这一次已经记了做过了，不叫；没记的，今天看上去已经碰过就附一句
    for (const item of this.schedule.takeDue(now, "remind")) {
      if (item.everyMs && this.remindDoneFor(item.id, item.due)) {
        this.log.info("reminder skipped: done today", { id: item.id });
        continue;
      }
      const hint = this.remindLooksDone(item, now);
      this.inbound({ from: B.brain.reminderSenderLabel, channel: "internal", text: hint ? `${item.text}\n${hint}` : item.text, human: false });
    }

    // 固定专注时段开始
    const fixed = focusSlotAt(now, s.timezone, s.focusSlots, s.focusMinutes);
    const key = fixed ? `${localTime(now, s.timezone).day} ${fixed}` : null;
    if (key && key !== this.lastFocusSlotKey) {
      this.lastFocusSlotKey = key;
      const focus = fixed === s.focusSlots[0] ? P.FOCUS_PLAN : P.FOCUS_REGULAR;
      this.wakeMain(focus, { cue: focus, cause: "focus" });
      return;
    }

    // 放空：主线低频漫想
    const main = this.region("main");
    if (!slot && !main.busy && s.wanderEveryMinutes > 0 && now - this.lastWander >= s.wanderEveryMinutes * 60_000 && now - this.lastActivity >= 5 * 60_000) {
      this.lastWander = now;
      this.wakeMain(P.WANDER, { leisure: true, cause: "wander" });
    }
  }

  // ---------- 记忆体检----------
  /**
   * 用她的人格前缀和只读的记忆工具单开一个会话答考卷：每道题换一个新会话（前一道不提示后一道），不进她的中央记忆、不能对外说话、不能写记忆，
   * 她在这里展开事情也不算真的想起过（不让体检本身把记忆变清楚）。每答完一道就把结果写进 out。
   */
  async runExam(questions: ExamQuestion[], out: string, o: { tier?: "opus" | "sonnet"; timeoutMs?: number } = {}): Promise<ExamAnswer[]> {
    const mem = this.mem;
    if (!mem) throw new Error(B.brain.examMemoryOff);
    if (this.examining) throw new Error(B.brain.examAlreadyRunning);
    this.examining = true;
    const answers: ExamAnswer[] = [];
    let turn: ((r: { ok: boolean; text: string; total: ExamAnswer["total"] }) => void) | null = null;
    let tools: string[] = [];
    const spec = {
      id: "exam", role: "hippocampus" as const, tier: o.tier ?? "opus", label: B.brain.examJobLabel, outlet: "none" as const, external: false,
      builtinTools: ["Read", "Grep", "Glob"], tools: ["recall", ...MEM_READ_TOOLS], roleText: M.exam.role,
    };
    const region: Region = new Region(spec, {
      driver: this.driver, central: new CentralMemory(openDb(":memory:"), this.now), labeler: (src) => this.labelOf(src),
      render: { maxItemChars: this.cfg.limits.maxItemChars, timezone: this.cfg.schedule.timezone, syncThinkChars: this.cfg.limits.syncThinkChars ?? 0, folds: this.folds },
      model: modelFor(this.cfg, spec.tier), cwd: this.cfg.workspace, permissionMode: this.cfg.kernel.permissionMode,
      env: this.kernelSeam().env, claudeExecutable: this.cfg.kernel.claudeExecutable, allowedTools: this.cfg.kernel.allowedTools,
      tools: [...buildTools(this.toolContext("exam"), spec.tools), ...memTools(mem, "exam", spec.tools)],
      prefix: () => this.prefix, tailTokens: 0, now: this.now,
      onEvent: (r, ev) => {
        if (ev.type === "act") tools.push(ev.tool);
        if (ev.type === "turn-end") { const text = r.takeTurnText(); turn?.({ ok: ev.ok, text, total: ev.total ?? null }); }
      },
      log: this.log.child("exam"),
    });
    const meta = { started: new Date(this.now()).toISOString(), tier: spec.tier, questions: questions.length };
    try {
      for (const [i, q] of questions.entries()) {
        if (i > 0) await region.rotate();
        tools = [];
        const t0 = Date.now();
        const r = await new Promise<{ ok: boolean; text: string; total: ExamAnswer["total"] }>((resolve) => {
          turn = resolve;
          this.later(() => resolve({ ok: false, text: B.brain.examTimedOut, total: null }), o.timeoutMs ?? 5 * 60_000);
          region.wake(M.exam.question(q.q), { raw: true });
        });
        turn = null;
        answers.push({ id: q.id, q: q.q, answer: r.text.trim(), ok: r.ok, ms: Date.now() - t0, tools, total: r.total });
        saveExam(out, meta, answers);
        if (!r.ok) await region.rotate();
      }
      saveExam(out, { ...meta, finished: new Date(this.now()).toISOString() }, answers);
      this.log.info("memory exam finished", { out, answered: answers.length });
    } finally {
      this.examining = false;
      await region.close();
    }
    return answers;
  }
  private examining = false;
  logInfo(msg: string, data: Record<string, unknown>): void { this.log.info(msg, data); }

  status(): BrainStatus {
    return {
      alertness: this.alertness,
      epoch: this.epoch.id,
      pageTokens: this.central.pageTokens(this.epoch.id),
      pageView: this.pageView(),
      pageViewRaw: this.pageViewRaw(),
      pageViewK: this.viewK.k,
      compactedTokens: this.epochs.compactedTokens(),
      focusSlot: this.currentFocusSlot(),
      focusUntil: ((u) => (u ? new Date(u).toLocaleString(dateLocale(), { timeZone: this.cfg.schedule.timezone }) : null))(this.focusUntil()),
      turning: this.turning,
      frontIdle: this.frontIdle(),
      nightRest: this.nightRest(),
      regions: [...this.regions.values()].map((r) => ({ id: r.id, open: r.open, busy: r.busy, contextTokens: r.usage.contextTokens, generation: r.generation, sessionId: r.sessionId })),
      todos: this.thalamus.pendingTodos(),
      quota: quotaSummary(this.quotaState(), this.cfg.schedule.timezone, this.now()),
      quotaUsed: ((q) => ({
        fiveHour: q.fiveHour?.used ?? null, sevenDay: q.sevenDay?.used ?? null,
        fiveHourResetsAt: q.fiveHour?.resetsAt ?? null, sevenDayResetsAt: q.sevenDay?.resetsAt ?? null, at: q.at ?? null,
      }))(this.quotaState()),
      ...(this.cfg.models.providers ? { spend: this.spendStatus(this.cfg.models.providers) } : {}),
      claims: this.claims.list().map(({ topic, owner }) => ({ topic, owner })),
      gate: this.gateStatsToday(),
      rulesErrors: this.gateRulesErrors(),
      registryChanges: this.registryChangesRecent(),
    };
  }

  private spendStatus(providers: Record<string, { weekUsd: number }>): Record<string, { week: number; weekUsd: number }> {
    const today = localDay(this.now(), this.cfg.schedule.timezone);
    return Object.fromEntries(Object.entries(providers).map(([name, p]) => [name, { week: weekSpend(this.spend(), name, today), weekUsd: p.weekUsd }]));
  }

  /** 先按文件现在的样子读一遍（不然报的是上次读的时候的问题） */
  private gateRulesErrors(): string[] {
    if (!this.gateRules) return [];
    try { this.gateRules.current(); } catch { /* 读不了就报上次的 */ }
    return this.gateRules.errors();
  }

  /** 最近 14 天的名单变动，新的在前、最多 30 条，带本地时间 */
  private registryChangesRecent(): string[] {
    let list: Array<{ ts: number; line: string }> = [];
    try { list = JSON.parse(kvGet(this.db, REGISTRY_CHANGES_KEY) ?? "[]") as typeof list; } catch { return []; }
    if (!Array.isArray(list)) return [];
    const cut = this.now() - 14 * 86_400_000;
    const fmt = new Intl.DateTimeFormat(dateLocale(), { timeZone: this.cfg.schedule.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    return list.filter((x) => x && typeof x.ts === "number" && x.ts >= cut && typeof x.line === "string")
      .sort((a, b) => b.ts - a.ts).slice(0, 30).map((x) => `${fmt.format(x.ts)} ${x.line}`);
  }

  /** 闸门本地今天（日历日，0 点起）的账；查不了给 null，不能让 status 坏掉 */
  private gateStatsToday(): (GateStats & { mainWakes: number }) | null {
    if (!this.gate) return null;
    const now = this.now();
    const start = now - localTime(now, this.cfg.schedule.timezone).minutes * 60_000 - (now % 60_000);
    try { return { ...this.gate.stats(start, now + 1), mainWakes: this.gateWakes()[this.localDay(now)] ?? 0 }; } catch (e) {
      this.log.warn("gate stats failed", { error: String(e).slice(0, 200) });
      return null;
    }
  }

  /** 本地日期（YYYY-MM-DD） */
  private localDay(ms: number): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: this.cfg.schedule.timezone }).format(ms);
  }

  private gateWakes(): Record<string, number> {
    try {
      const v = JSON.parse(kvGet(this.db, GATE_WAKES_KEY) ?? "{}") as unknown;
      return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};
    } catch { return {}; }
  }

  /** 闸门叫醒了主意识一次（闸门交来的、或者带着顺便看到 / 待看）：按本地日期记，只留 14 天（M6，观察日看） */
  private countGateWake(): void {
    try {
      const now = this.now();
      const m = this.gateWakes();
      const day = this.localDay(now);
      m[day] = (Number(m[day]) || 0) + 1;
      const oldest = this.localDay(now - 13 * 86_400_000);
      kvSet(this.db, GATE_WAKES_KEY, JSON.stringify(Object.fromEntries(Object.entries(m).filter(([k]) => k >= oldest))));
    } catch (e) {
      this.log.warn("gate: cannot count main wake", { error: String(e).slice(0, 200) });   // 记不上不能挡叫醒
    }
  }

  /** 起来以后最早 20 轮的成败 */
  turnOutcomes(): Array<{ ok: boolean; error?: string }> { return this.turnLog; }

  /** 测试和控制面板用：直接叫醒某个脑区 */
  wakeRegion(id: string, text: string): void {
    if (id === "main") this.wakeMain(text, { cause: "manual" });
    else this.region(id).wake(text);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // 夜里分段整理在跑：先叫停 runner（关掉的会话算中止：这一天撤回、不落地），再关它的会话，等它收个尾（有上限）
    const night = this.night;
    if (night) {
      night.runner.abort(B.brain.hhdStopped);
      await withTimeout(night.hosts.shut(), NIGHT_STOP_WAIT_MS);
    }
    if (this.nightDone) await withTimeout(this.nightDone, NIGHT_STOP_WAIT_MS);
    await this.replays.stop(B.brain.hhdStopped);
    for (const r of this.regions.values()) await r.close();
    for (const r of this.lookRegions) await r.close();
    for (const r of this.checkRegions) await r.close();
    this.log.info("brain stopped");
  }
}

/** 一段话拆成气泡：按空行拆；NO_REPLY 和空的不要 */
/**
 * 记忆里「（弄X时）」的 X：事情名开头那一截（到第一个冒号、括号、逗号、句号为止，引号里的不算），太长截到 LABEL_TOPIC_CHARS 字。
 * 这个标每条同步的记录都带一次：11-05 下午主线两小时里标了 1153 次、事情名平均 190 字，占同步进来的 40%。
 * 全名她派活、定标准时都看过，标签只用来认出是哪件事
 */
export const LABEL_TOPIC_CHARS = 24;
export function labelTopic(topic: string): string {
  const t = topic.trim().replace(/\s+/g, " ");
  let depth = 0;
  let cut = t.length;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (B.brain.labelTopicOpenBrackets.includes(c)) { depth += 1; continue; }
    if (B.brain.labelTopicCloseBrackets.includes(c)) { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && i >= 2 && B.brain.labelTopicCutChars.includes(c)) { cut = i; break; }
  }
  const head = t.slice(0, cut).trim();
  return head.length > LABEL_TOPIC_CHARS ? `${head.slice(0, LABEL_TOPIC_CHARS)}…` : head;
}

export function splitBubbles(text: string): string[] {
  return text.split(/\n\s*\n/).map((s) => s.trim()).filter((s) => s && s !== "NO_REPLY" && !/^NO_REPLY\W*$/.test(s));
}

/** 等不到就当没读到（不让 tick 卡住） */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>((r) => { setTimeout(() => r(null), ms).unref(); })]);
}

/**
 * 一个最终回复里没确定发出去的那几句（下一次叫醒她时说）：发给谁（targetKey、称呼，渠道和原样的发送目标、是不是群）；
 * 确定没发出去的、拿不准的、跟在拿不准的后面先没发的
 */
interface ReplyMiss { key: string; who: string; channel: string; target: string; group?: boolean; notSent: string[]; unsure: string[]; withheld: string[] }

/** 词并进 into（同一个词只留先来的那条）；返回 into */
function addWords(into: ListedWord[], add: readonly ListedWord[]): ListedWord[] {
  for (const w of add) if (!into.some((u) => u.word === w.word)) into.push(w);
  return into;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** 下意识自己的过程（它的思考、工具调用、自言自语）只存档，不同步给别的脑区；它上报的事（think_it_over）和记下的话照常同步 */
function inner(r: Region): Record<string, unknown> | null {
  return r.spec.role === "perception" || r.spec.role === "deep" ? { inner: true } : null;   // 下意识自己的过程只存档、不同步
}

function rank(role: string): number {
  return { speech: 0, perception: 1, side: 2, hippocampus: 3, main: 4 }[role] ?? 5;
}

/**
 * 感官叫醒拿去联想的话题（11-03：帮手回报整段当话题，开头那句和后面的固定说明每次都一样，联想总挂出同几页）：
 * 去掉「[感官] 有新动静…」那行，每条只留第一行、去掉 [xx id=…] 和时间；帮手的回报去掉「（它最后回你的消息…）」那段说明，
 * 前面换成它在做的那件事（taskOf 查得到时）。不是这套格式的原样返回
 */
export function senseCue(text: string, taskOf: (helper: string) => string | undefined): string {
  const lines = text.split("\n");
  if (!fromEveryPack((p) => p.brain.brain.senseHeader).some((h) => lines[0]?.startsWith(h))) return text;
  const items = lines.slice(1).filter((l) => l.startsWith("- ")).map((l) => {
    const first = l.replace(/^- (?:\[[\w-]+ id=[^\]]*\]\s*)?/, "").replace(/^\d{2}-\d{2} \d{1,2}:\d{2}\s*/, "");
    const cc = /^Claude Code「([^」]+)」(.*)$/.exec(first);
    if (!cc) return first;
    const rest = cc[2]!.replace(/（它最后回你的消息.*$/, "").trim();
    const task = taskOf(cc[1]!);
    // 「回完了：…」取冒号后面它说的；「出错停了」「卡住了」这种没冒号的，就是那句状态
    const said = /^[^：]*：(.*)$/.exec(rest);
    return said
      ? B.brain.helperReportWithSaid(task ? B.brain.helperReportTaskReturned(task, cc[1]) : B.brain.helperReportReturned(cc[1]), said[1]!.trim())
      : `${task ? B.brain.helperReportTaskNamed(task, cc[1]) : B.brain.helperReportNamed(cc[1])}${rest}`;
  }).filter(Boolean);
  return items.length ? items.join("\n") : text;
}

