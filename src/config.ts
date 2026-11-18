// HH 配置：从低到高四层按字段合并——语言包的默认值（src/lang/<code>/defaults.ts）→ config/default.json（框架的默认值）
// → HH_CONFIG 指向的实例文件（这个人格自己的）→ 调用处给的。合并完再把几个相对路径解析成绝对的、没写时区的用本机的时区。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Weights } from "./sleep/budget.ts";
import { langDefaults } from "./lang/index.ts";

export interface Limits {
  maxContextTokens: number;      // 每个脑区上下文上限
  pageTokens: number;            // 一页多大就翻页（海马压缩）
  sleepyAtTokens: number;        // 压缩块总量到这里开始困
  mustSleepAtTokens: number;     // 到这里必须睡
  idleMinutesBeforeSleep: number;
  maxItemChars: number;          // 单条记录广播时最多多少字
  rotationTailTokens: number;    // 换班时带进新实例的"最近一段"
  /** 下意识自己的上下文到这里就单独换班（不等全局翻页）；不写默认 150000 */
  perceptionRotateTokens?: number;
  /** 后台脑区（side）自己的上下文到这里就单独换班、接着做手上的事（翻页按眼前算，后台不跟着全局翻页换）；不写默认 250000 */
  sideRotateTokens?: number;
  /** 主线不是因为换班开新会话（hhd 重启、会话断了重开）时，带进来的这一页最多多少（渲染后估算）；不写默认 150000 */
  restartPageTokens?: number;
  /** 翻页压缩从主线会话分叉做（整页按缓存价读）；false = 照旧新开海马压缩。不写默认开 */
  pageTurnFork: boolean;
  /**
   * 主线眼前别的脑区的「想」折成一行、最多这么多字，带编号；后台脑区自己的会话里照旧是原样。
   * 不写或 0 = 原样同步（10-31 的做法）
   */
  syncThinkChars?: number;
}

/** sleep.organizer 的形状（都可以不写） */
export interface NightGuideCfg { guide?: string; firstStep?: string; lastStep?: string; state?: string; recallNote?: string; eventNote?: string; apply?: string }

/** schedule.focusSlots 是空的、schedule.morning 也没写时，夜里到这个点为止 */
export const DEFAULT_MORNING = "07:30";

export interface Schedule {
  focusSlots: string[];          // "HH:MM"
  /** 一个专注时段都没配时，夜里放空到几点算早上（"HH:MM"）；不写 = DEFAULT_MORNING */
  morning?: string;
  focusMinutes: number;
  nightSleep: string;            // "HH:MM"
  wanderEveryMinutes: number;    // 放空时主线多久漫想一次；0 = 不放空
  /** 这周额度用到这么多（%）：专注里没在做事的那几下叫醒拉长、改说挑省额度的轻活；真事照常叫，没读数照旧 */
  focusQuotaWeekMax: number;
  timezone: string;
  /** 循环提醒到点时，哪些工具的动作里出现过提醒写的脚本才算「今天碰过」（跑命令的那些；记一笔、发消息、读文件不算） */
  remindEvidenceTools: string[];
}

/**
 * 学习（笔记本）：三个开关默认全关。enabled = 算不算联想；inject = 算出来的给不给她看（false = 只算不挂，照样记录）；shelf = 书架目录进不进前缀。
 * threshold / askThreshold 是判断的概率线；maxPages 一次最多挂几页；kWake / kTask 是醒来 / 开始做事时先筛多少页进判断；
 * timeoutMs 一次判断等多久；dailyUsd 一天花多少上限。
 */
export interface LearningCfg {
  enabled: boolean;
  inject: boolean;
  shelf: boolean;
  /** 书架根目录：skills/<大类>/<本>/<页>.md */
  root: string;
  /** 通用大类的名字：不管有没有进前 k 都当候选 */
  generalCategory: string;
  /** 归档目录的名字：书架上任何一层叫这个名字的目录，里面的页都算归档（照样扫、编号还认，不进联想、不上书架目录）；默认值在语言包里 */
  archiveDir: string;
  /** 常驻单子的文件名，相对 root：角色自己写的那份「每一轮都记着」的单子；默认值在语言包里 */
  residentFile: string;
  threshold: number;
  askThreshold: number;
  maxPages: number;
  kWake: number;
  kTask: number;
  timeoutMs: number;
  dailyUsd: number;
  /** 书架的规矩文件（她自己的数据：哪些记号算重要、重要度的键名），相对 root；不给按 shelf.json */
  shelfFile?: string;
  /**
   * 讲「怎么学一样新本事」的那一页，相对 root（比如 <大类>/<本>/<页>.md）。开始做一件事、笔记里一页都没想起来时，提醒角色先照这页摸个底。
   * 不给 = 不提醒这一句
   */
  newGroundPage?: string;
  /** 派活时不附给帮手的本（讲她自己的：怎么说话、怎么学、身体、怎么派活、聊天） */
  helperSkipBooks?: string[];
  /**
   * 同一个前缀里挂过的页，叫醒时不再挂；干活的时刻（开始做、中途、交之前）她又看了这么多 token 的经历才再挂
   * （挂过的那行早被几十轮对话埋掉了）。不给按 50000
   */
  remountTokens?: number;
}

/**
 * 夜里分段整理（sleep-flow）：flowFile / commonFile / soulFile 相对工作区（flow.json 不在 = 旧的整理；engine 写 legacy、newEngine 不是 true 也是）；
 * lastGood 相对 stateDir（读成功就存一份，flow.json 坏了用它）；watchdogHours 整夜看门狗；auditMinutes 核依据一个会话最多多久；
 * unitsPerPct、weights 是花费换算（spec §10.1：每次调用换算成「单位」，多少单位约等于周额度的 1%）；
 * examScratch 相对 stateDir：考整理前用的事件库拷贝放这里（不放工作区：那是她的 git 仓库）；
 * examMinFree：剩余空间不到库文件（含 -wal）的这么多倍就不拷，整理前补考用现在的事件库
 */
export interface SleepCfg {
  flowFile: string;
  commonFile: string;
  soulFile: string;
  lastGood: string;
  watchdogHours: number;
  auditMinutes: number;
  unitsPerPct: number;
  weights: Weights;
  examScratch: string;
  examMinFree: number;
  /** 回放（hh sleep replay）的子进程里要指到回放工作区的环境变量名（她的平台用哪个名字找工作区）；没写 = [] */
  workspaceEnv?: string[];
  /** 回放的子进程里要指到回放那份库拷贝（<回放>/hh.db）的环境变量名（她的脚本用哪个名字找库）；没写 = [] */
  dbEnv?: string[];
  /**
   * 夜里那一觉整理好、开了醒来那一页以后，换前缀以前在工作区里跑一次的命令（argv，不经 shell，以 hhd 自己的身份）：
   * 给人格自己的脚本按「已经醒了」重新生成进前缀的文件。最多等 wakeRefreshSec 秒（不写 60，最多 600）；跑不成、超时只记 warn，照旧醒来。
   * Unset: the night module's ledger_snapshot.py (in that module's environment), when the module is on
   */
  wakeRefresh?: string[];
  wakeRefreshSec?: number;
  /**
   * 夜里整理照着做的那份指南（角色工作区里的东西），给整理者的话里要点到的几样；哪一项不写，话里那一段就不出：
   * guide 指南文件（相对工作区）、firstStep / lastStep 指南的第一步和最后一步的编号、state 记每天做没做完的文件（相对工作区）、
   * recallNote 核原话那一句括号里补的一句、eventNote 事件库那一句括号里补的一句、apply 最后一步里核提案再换上去的那个脚本叫什么
   */
  organizer?: NightGuideCfg;
  /** The only folder, relative to the workspace, the nightly organizer may write into; its state.json and each night's <day>/report.md are there */
  workDir: string;
  /**
   * 夜里整理每晚那份报告在哪：相对工作区的路径模板，{day} 换成那一晚整理的日子（YYYY-MM-DD）。
   * 不写 = 这个角色的整理不出报告，读它的地方（学习夜里往报告末尾追加的那一节）就不做
   */
  reportFile?: string;
  /** 整理时她写的路径以 ~/ 开头，~ 指哪儿（绝对路径）；不写 = 跑 hhd 的系统用户的家目录 */
  home?: string;
  /**
   * 问「还有哪几天等着整理」的命令（argv，不经 shell，在工作区里跑，最多 60 秒）：标准输出每行一个 YYYY-MM-DD、最早的在前，退出码 0。
   * Unset: the night module's sleep_digest.py pending, when the module is on; with neither, nothing is asked and no day counts as pending
   * (the organizer still gets its one run a night).
   */
  pendingDays?: string[];
  /** 一夜最多整理几天（积压的日子接着做）：正整数；不写、写错 = 3 */
  nightMaxDays?: number;
  /**
   * 夜里用不用分段的引擎（flow / team）：写 true 才去读 flowFile；不写、写别的，一律旧的整理（有 flow.json 也一样，不读它）。
   * 新的睡眠项目 2026-11-13 停了（sleep/stopped.ts）。回放（hh sleep replay）带自己的流程目录、要明说才开，不看它
   */
  newEngine?: boolean;
}

/**
 * The role's workspace as the console's memory page shows it. Paths are relative to the workspace.
 * Nothing set = the page opens nothing of the workspace beyond the files in the role's prefix, and lists only
 * the nightly reports and the skill manuals (those two folders come from sleep.workDir and skills.discover).
 */
export interface MemoryPageConfig {
  /** folders listed as areas, in order: [folder, label]; the label is a code the interface pack names (memory.area.<code>) or, failing that, shown as written */
  areas?: Array<[string, string]>;
  /** every other sub-folder of this folder is listed too, under its own name; the folder itself then lists only the files directly in it */
  restOf?: string;
  /** folders whose .md files may be opened (prefixes, e.g. "memory/") */
  readable?: string[];
  /** never listed, never opened: these paths and everything under them */
  hidden?: string[];
  /** [folder, file]: under that folder only that one file is shown */
  only?: Array<[string, string]>;
  /** never listed, never opened: paths matching these patterns (matched in lower case) */
  hiddenPatterns?: string[];
}

export interface Config {
  /** The role's id: part of its launchd labels, roleNames().id, the ASCII alias the console shows in Latin script */
  id: string;
  /** A square picture of the role (absolute path, PNG or JPEG): its app's icon (launchd.app) */
  avatar?: string;
  /** The role's names: what it is called (me), what it calls its owner (owner), names containing me that are not it (notMe), its pronoun (ta), its place,
   *  and what it calls an ordinary person on its list (ordinary: the permissions it may give by itself are that person's; unset, the pack's words). Read through roleNames */
  names: { me: string; owner: string; notMe: string[]; ta?: string; place?: string; ordinary?: string };
  /** Where the gateway's auth file is (absolute); unset = openclaw.json next to the workspace (src/channels/gateway.ts) */
  gateway?: { authFile?: string };
  /** Where the load status file is (absolute); unset = <workspace>/../state/load/status.json */
  load?: { statusFile?: string };
  /** The workspace files the persona is built from, relative to the workspace, in this order (the default is the five files hh new writes) */
  personaFiles: string[];
  /** 她自己想的、说的、记下的用什么语言（写进共用的运行说明）；空 = 不写这一条 */
  writingLanguage: string;
  /** 用哪个语言包（src/lang/ 下的代号，没写或空着 = zh）；跟上面写进说明里的 writingLanguage 那句话是两回事 */
  lang?: string;
  workspace: string;
  stateDir: string;
  /** byRole：按脑区角色指定模型（没写的角色照旧按档）；角色名只认 MODEL_ROLES 里的，写错了 requireInstance 当场报 */
  models: {
    opus: string; sonnet: string; haiku: string; byRole?: Partial<Record<ModelRole, string>>;
    /** Other model providers by name; a role in providerByRole runs its sessions on that provider (src/providers.ts) */
    providers?: Record<string, Provider>; providerByRole?: Partial<Record<ModelRole, string>>;
  };
  /** 周表、控制台统计用：teamDirs 是团队干活的目录（团队用她账号的额度时 cwd 放在这些目录下），会话记录按目录认成「团队」；不写就没有这一类 */
  metrics?: { teamDirs?: string[] };
  limits: Limits;
  schedule: Schedule;
  regions: { sideThreads: number; perception: string[] };
  /**
   * 并行：她估的超过 thresholdMin 分钟就交给空着的那部分；聊得多不多；这周额度到 quotaWeekMax% 就不往外分、她自己做（97 才把关，把关也不拦她，只提醒省着点）。
   * look：说做完时回头对照标准看；没到 maxLooks 次、或者做到估的 overFactor 倍还没到，就先放下去问人；看一次最多 timeoutMin 分钟
   */
  /**
   * 感官：角色自己的感官脚本送来的事件。框架的默认全空，角色的值写在实例配置里（约定见 docs/contracts/senses.md）。
   * sources：每个来源算哪一类，一个来源可以在几类里——
   * chat 聊天（按名单认人、陌生人私聊走规则、控制台遮访客的原文、每日总结提名进名单）；public 公开场合别人对角色说的（交规则判、控制台不遮、送去时带上怎么回）；
   * probe 角色自己的探针（只有它们带的 alarm、「要你处理」算数）；always 一律直达；hands 帮手的回报。表里没有的来源交规则判，控制台当聊天遮。
   * 读表经 src/gate/sources.ts（缺的类、写坏的当空的）。logFile：事件日志，相对工作区；空 = 没有这份日志（重判、规则试算就不做）。
   * labels：给角色看的来源名（{ 来源: 名字 }，角色用自己的语言读，不分语言）；没写的来源显示原名
   */
  senses?: { sources?: { chat?: string[]; public?: string[]; probe?: string[]; always?: string[]; hands?: string[] }; logFile?: string; labels?: Record<string, string> };
  // gate.dailyUnits：每日小判断额度，单位同睡眠预算的单位（缓存读 1/10、模型倍数）
  gate: { enabled: boolean; digest: boolean; rulesFile: string; batchMax: number; judgeTimeoutMs: number; dailyUnits: number; convContext: number; convContextMinutes: number; workMaxAgeHours: number; attachMax: number; defaultWant: string; card: { soul: string[]; midterm: string; midtermMaxChars: number } };
  parallel: {
    thresholdMin: number; busyChat: { windowMin: number; count: number; exchangeMin: number }; quotaWeekMax: number; look: { maxLooks: number; overFactor: number; timeoutMin: number };
    /** 一边做着的事里记了急事（jot_down urgent）：最多每 minGapMin 分钟叫一次说话的那头，期间记的攒着到点一起给 */
    urgentNote: { minGapMin: number };
  };
  kernel: {
    /**
     * 内核的权限模式（默认 bypassPermissions）。改成 auto 之前先改 HH 认一轮结束的地方（src/kernel/sdk.ts 把每个 result 当一轮结束）：
     * SDK 0.3.321 起 auto 模式下排队的子代理回报合成一次调用，除了最后一个都结束在空的 result（num_turns: 0）上，会被当成好几轮（11-13 读更新说明）
     */
    permissionMode: string;
    allowedTools: string[];
    /**
     * The kernel's own tools a region gets, by name; a region whose spec names its own list (the hippocampus: Read,
     * Grep, Glob) gets that one. Nothing outside the list reaches the role, so a tool a later Claude Code adds does not
     * appear by itself: such tools (push notifications, remote triggers, schedules) go round HH's outbound filter and
     * simulated sending.
     */
    builtinTools: string[];
    claudeExecutable: string | null;
    env: Record<string, string>;
    /** 额外挂给每个脑区的 MCP 服务器（比如 B站） */
    mcpServers: Record<string, unknown>;
  };
  /** 她的技能手册：去哪找、要哪些 */
  /** names = 一定要加载的；discover = 再把这个目录下所有带 SKILL.md 的都带上（她新开的手册不用改配置），exclude 除外 */
  skills: { roots: string[]; names: string[]; discover?: string; exclude?: string[] };
  memory?: {
    /**
     * 事件记忆：enabled 挂工具和夜里写库；inject 用新联想；midterm 中期视图进前缀；
     * recognize 认出东西（她自己碰到挂在喜欢 / 烦的事上的东西时提一句，不写 = 开）
     */
    events?: { enabled: boolean; inject: boolean; midterm: boolean; recognize: boolean };
    /**
     * 人物卡（R17）：template 是这个人格的卡——字段、类型、写法和上限、哪个私密、原话段、现算段、合计上限；
     * hhd 用 people.ts 的 parseTemplate 校验（结构见那里的 PeopleTemplate）。没配或配坏了就不开人物卡（hhd 照常起来）
     */
    people?: { template: unknown };
    /**
     * 进提示前折成一句（src/memory/folds.ts）：[{ find, say, word?, note? }]，词和替换句都是这个实例的数据。
     * 渲染中央记忆（增量、开场、给海马的整页）、recall 的结果、前缀里的压缩块、「最近说过的话」都过它；库和控制台照原样。
     * 11-13 加的止血带：一件事的说明被反复喂回各个会话、越喂越多。每条的 note 写加的日期和原因，到期复查能不能清空
     */
    promptFolds?: Array<{ find: string; say: string; word?: string; note?: string }>;
    /**
     * 人物卡切过去的开关文件（相对工作区）：这个文件出现以后人物卡才算切过去（旧人物档案收进档案的那一刻）。空 = 没有这回事，人物卡一直算切过去了
     */
    peopleSwitchFile?: string;
    /**
     * 退役的文件：谁写都拦下，说记到哪。path 是正则（相对工作区的路径）；whenExists / whenMissing：工作区里这个文件在 / 不在时才拦（都不写 = 一直拦）；
     * hippocampus 是说给夜里整理的话，other 说给别的脑区。都是这个角色的数据；框架默认没有
     */
    retiredFiles?: Array<{ path: string; whenExists?: string; whenMissing?: string; hippocampus: string; other: string }>;
  };
  learning: LearningCfg;
  sleep: SleepCfg;
  /**
   * wordListFile：她记下的不自然的词（相对工作区；空字符串 = 不查）。message 发之前对一遍，对上了先不发、告诉她一句，原样再发照发；
   * 最终回复发出去以后记一笔提醒（#0015）
   */
  /** extra: tools a region gets only when the instance lists them here (today: "computer") */
  /** node: the node the launchd jobs run (hhd, the console, the modules' timers and services); unset = the one running now.
   * macOS grants system permissions to that very file: keep node at one path, overwrite it in place to upgrade */
  tools: { sendDryRun: boolean; python: string; node?: string; wordListFile: string; extra: string[] };
  /** The channels this role is connected to: { <channel name>: { via: <implementation> } } (docs/contracts/channels.md); empty = none */
  channels: Record<string, { via: string }>;
  /**
   * The outbound filter on every send (src/gate/outbound.ts); unset or all off = none. refuseLatinLines: a short line in
   * Latin words only is refused, except to a target containing one of latinLinesTo, or while latinLinesFile holds
   * { until } (ms) in the future. tidyLines: a one-line message loses a leading list mark and trailing 。
   */
  outbound?: { refuseLatinLines?: boolean; latinLinesTo?: string[]; latinLinesFile?: string; tidyLines?: boolean };
  /** Per module: enabled turns it on, the rest is its own config (docs/contracts/modules.md) */
  modules?: Record<string, { enabled?: boolean; guide?: boolean } & Record<string, unknown>>;
  /** More directories holding modules, besides the repo's and the workspace's modules/ (module.json only) */
  modulePaths?: string[];
  /** What only the console's interface needs from the instance. sourceLabels / channelLabels: display names of the role's own sources (gate page) and input channels (timeline), per interface language: { zh: { <code>: <name> }, en: { … } } */
  console?: { sourceLabels?: Record<string, Record<string, string>>; channelLabels?: Record<string, Record<string, string>>; memoryPage?: MemoryPageConfig;
    /**
     * The console's talk pane (its write ports, src/console/owner.ts) asks for the owner's token; hh console makes it and
     * pairs the owner's browser. ownerTokenFile: where the token's sha256 is kept (default <stateDir>/console/owner.sha256).
     * ownerToken false: no token, only the Host, Origin and header checks, which keep out web pages but not another account's
     * processes on this computer. The pane is on by default for a role under an account that administers the machine
     * (the owner's own); a role under a standard account gets it when ownerTokenFile names a file it cannot write.
     */
    ownerTokenFile?: string; ownerToken?: false;
    /** the settings page's system permissions: a read-only command (argv, no shell) that prints them as JSON, e.g. the operator's permissions.py --json; absent = the page says it is not set up */
    permissionsCheck?: string[];
    /** the monitor's "who holds the heavy-job lock": a folder holding the holder's who and pid; absent = not shown */
    lockDir?: string };
  /** 她自己的 Chrome：哪个程序、哪份用户资料、调试端口（跟 OpenClaw 时代同一份，登录都在） */
  /** logins: what the browser tool's description says is signed in there, in the role's language; unset: the pack's general words */
  browser: { chrome: string; userDataDir: string; port?: number; logins?: string };
  /** launchd job labels for this role's hhd and console (see launchdLabels) */
  /**
   * The role's launchd labels, and the console's port its job is started with (hh new picks one). app: the role's own app
   * (macOS, /Users/Shared/HH/<id>/<name>.app): every job of the role is started by its launcher, so the owner's privacy
   * grants are the app's; hh modules install builds and signs it (src/services/app.ts) in its folder, which the owner
   * makes, named as the role's id
   */
  /** extraPath: folders added at the end of the role's jobs' PATH (ones on an external disk are otherwise left out: jobPath) */
  launchd?: { hhd?: string; console?: string; consolePort?: number; app?: string; extraPath?: string[] };
}

/** 配置的一部分（一层、一段覆盖）：对象一层层都可以缺；数组和标量整个给（deepMerge 里数组是整个替换的，不逐个合） */
export type DeepPartial<T> =
  T extends readonly unknown[] ? T :
  T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } :
  T;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** p 是 root 本身或在它下面（只比字面、分大小写，按路径边界：/a/ws2 不在 /a/ws 里） */
function within(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 配置树里（对象的值、数组的元素，任意深；键不动）等于某个 from 或在它下面的字符串，换成 to 下面的同一位置：
 * 落在好几个 from 里取最长的；只换一遍（换出来的不再看）。分大小写；大小写写得不一样的没换（调用处自己再查）。
 * 平行世界和回放都用它：把指进真实工作区、真实状态目录的路径指到自己的副本里
 */
export function remapConfig<T>(v: T, pairs: readonly (readonly [from: string, to: string])[]): T {
  const map = (x: unknown): unknown => {
    if (typeof x === "string") {
      let best: readonly [string, string] | null = null;
      for (const pair of pairs) if (within(x, pair[0]) && (best === null || pair[0].length > best[0].length)) best = pair;
      return best ? best[1] + x.slice(best[0].length) : x;
    }
    if (Array.isArray(x)) return x.map(map);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, map(y)]));
    return x;
  };
  return map(v) as T;
}

export function deepMerge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in out ? deepMerge(out[k], v) : v;
  return out as T;
}

/**
 * 合并：语言包的默认值 → config/default.json → 实例文件（HH_CONFIG）→ overrides（对象逐字段合，数组、标量整个替换）。
 * 用哪个语言包看实例文件的 lang，没写看 default.json 的（都没写 = zh，空和不认识的照 setLang 的规矩）。
 * 合并完解析相对路径（resolvePaths）。这里不校验：测试和工具常拿不全的配置用；常驻进程和命令行起来时自己调 requireInstance
 */
export function loadConfig(overrides: unknown = undefined): Config {
  const base = JSON.parse(readFileSync(join(ROOT, "config/default.json"), "utf8")) as Config;
  const file = process.env.HH_CONFIG;
  const instance: unknown = file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  const lang = (isObject(instance) ? instance.lang as string | null | undefined : undefined) ?? base.lang;
  // 拷一份再合：合出来的配置里没有语言包自己的对象（谁改了配置也改不到包里，下一次 loadConfig 照旧）
  let cfg = deepMerge(structuredClone(langDefaults(lang)) as Config, base);
  if (instance !== undefined) cfg = deepMerge(cfg, instance);
  if (overrides !== undefined) cfg = deepMerge(cfg, overrides);
  return resolvePaths(cfg);
}

/**
 * 合并以后：skills.roots 里的每一个、skills.discover、learning.root 相对工作区，browser.userDataDir 相对状态目录，解析成绝对路径；
 * 已经是绝对的原样不动，空字符串照旧是空（空 = 不要这一样）。工作区 / 状态目录本身没给或不是绝对路径时不解析
 * （不拿当前目录去凑：起来时 requireInstance 会拦下）。schedule.timezone 没写或空着 = 本机的时区。
 * 不改传进来的对象，换掉的那几段是新的
 */
function resolvePaths(cfg: Config): Config {
  const under = (base: unknown) => <T>(p: T): T =>
    typeof p === "string" && p !== "" && !isAbsolute(p) && typeof base === "string" && isAbsolute(base) ? resolve(base, p) as T : p;
  const ws = under(cfg.workspace);
  const st = under(cfg.stateDir);
  const out: Config = { ...cfg };
  if (isObject(cfg.skills)) {
    const skills = { ...cfg.skills };
    if (Array.isArray(skills.roots)) skills.roots = skills.roots.map(ws);
    if (skills.discover !== undefined) skills.discover = ws(skills.discover);
    out.skills = skills;
  }
  if (isObject(cfg.learning) && cfg.learning.root !== undefined) out.learning = { ...cfg.learning, root: ws(cfg.learning.root) };
  if (isObject(cfg.browser) && cfg.browser.userDataDir !== undefined) out.browser = { ...cfg.browser, userDataDir: st(cfg.browser.userDataDir) };
  if (isObject(cfg.schedule)) {
    const tz: unknown = cfg.schedule.timezone;
    if (tz === undefined || tz === null || (typeof tz === "string" && tz.trim() === "")) {
      out.schedule = { ...cfg.schedule, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
  }
  return out;
}

export type ModelRole = (typeof MODEL_ROLES)[number];

/** An Anthropic-format endpoint: its URL, a file holding its key, its model (smallModel for the small slot), prices in USD per
 * million tokens, and the 7-day spend that counts as a full week's quota */
export interface Provider {
  baseUrl: string; keyFile: string; model: string; smallModel?: string;
  /** subagents' model (else smallModel); the model's context window (Claude Code takes an unknown model for 1M); the
   *  Claude Code CLI version the provider was tried on; its own config directory (else <stateDir>/providers/<name>) */
  subagentModel?: string; contextTokens: number; cliVersion: string; configDir?: string;
  price: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  weekUsd: number;
}

/** models.byRole 认得的角色（和 src/regions/specs.ts 的 Role 一样；test/models-byrole.test.ts 钉着两边一致） */
export const MODEL_ROLES = ["main", "side", "deep", "hippocampus", "speech", "perception"] as const;

/**
 * The names of this role: what it is called (me), what its owner is called (owner), the third-person word others use for it
 * (ta: she, he, it …), the name of the place it lives in as its clock is announced (place; may be empty), and its id (the
 * config's id: the ASCII alias it also answers to).
 * The same shape the language pack's placeholders are filled with (PackNames in src/lang/index.ts).
 */
export interface RoleNames { me: string; owner: string; ta: string; place: string; id: string; ordinary?: string }

/**
 * The names of this role. Whenever text shown to the role addresses someone, code has to recognise "the owner's name",
 * or the console or another brain region refers to the role in the third person, the name comes from here — never from
 * the config path directly: if the names move, only this function changes. Returns a fresh object; changing it does not
 * change the config.
 * me and owner are empty strings when the config does not set them (with the gate on, requireInstance has already
 * refused empty ones; with it off, the caller decides what an empty name means).
 * ta falls back to the role's own name when unset or blank: that reads correctly in any language, and the framework
 * does not decide for a role whether it is a "she" or a "he".
 * Identities that must resist the role itself — who may approve, whose commits count as the role's — do NOT come from
 * here: a role can edit its own instance config.
 */
/** the console's usage cache (how far its usage reader got): in the system temp dir, named after the role's state dir so two roles under one user do not share it; never inside the state dir */
export const consoleUsageCache = (stateDir: string, tmp = tmpdir()): string =>
  join(tmp, `hh-console-usage-${createHash("sha256").update(stateDir).digest("hex").slice(0, 12)}.json`);

export function roleNames(cfg: Config): RoleNames {
  const names = cfg.names;
  const me = names?.me ?? "";
  const ordinary = names?.ordinary?.trim();
  return { me, owner: names?.owner ?? "", ta: names?.ta?.trim() || me, place: names?.place?.trim() ?? "", id: cfg.id ?? "", ...(ordinary ? { ordinary } : {}) };
}

/**
 * 常驻进程、命令行、控制台起来时调（loadConfig 之后马上）：这个人格自己的几样没配就停下，一行说清缺哪个、看的是哪个实例文件——
 * 不拿框架的默认值或别的人格的值凑。workspace、stateDir 要是绝对路径；闸门开着时 names.me、names.owner 不能空
 */
/**
 * The environment of this role's kernel sessions: the configured one, with the kernel's temp root in this role's state dir.
 * The kernel's default root is per system user (/tmp/claude-<uid>), so roles sharing a user would share it.
 */
export function kernelEnv(cfg: Pick<Config, "stateDir" | "kernel">): Record<string, string> {
  const tmp = join(cfg.stateDir, "tmp");
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { CLAUDE_CODE_TMPDIR: tmp, ...cfg.kernel.env };
}

/** This role's launchd labels. The defaults are the first role's; any further role under the same user sets its own (hh new writes them) */
export function launchdLabels(cfg: Pick<Config, "launchd">): { hhd: string; console: string } {
  return { hhd: cfg.launchd?.hhd ?? "ai.hh.hhd", console: cfg.launchd?.console ?? "ai.hh.console" };
}

export function requireInstance(cfg: Config): void {
  const file = process.env.HH_CONFIG;
  const where = file ? `HH_CONFIG=${file}` : "HH_CONFIG is not set";
  for (const key of ["workspace", "stateDir"] as const) {
    const v: unknown = cfg[key];
    if (typeof v !== "string" || v.trim() === "") throw new Error(`config: ${key} is not set — the instance file must give it as an absolute path (${where})`);
    if (!isAbsolute(v)) throw new Error(`config: ${key} must be an absolute path, got ${JSON.stringify(v)} (${where})`);
  }
  const byRole: unknown = (cfg.models as { byRole?: unknown } | undefined)?.byRole;
  if (byRole !== undefined) {
    if (!byRole || typeof byRole !== "object" || Array.isArray(byRole)) throw new Error(`config: models.byRole must be an object like {"main": "<model>"} (${where})`);
    for (const [role, model] of Object.entries(byRole)) {
      if (!(MODEL_ROLES as readonly string[]).includes(role)) throw new Error(`config: models.byRole has an unknown role ${JSON.stringify(role)} — known roles: ${MODEL_ROLES.join(", ")} (${where})`);
      if (typeof model !== "string" || model.trim() === "") throw new Error(`config: models.byRole.${role} must be a model name (${where})`);
      if (model !== model.trim()) throw new Error(`config: models.byRole.${role} has spaces around the model name ${JSON.stringify(model)} (${where})`);
    }
  }
  for (const [name, p] of Object.entries(cfg.models?.providers ?? {})) {
    const str = (v: unknown) => typeof v === "string" && v.trim() !== "";
    const num = (v: unknown) => typeof v === "number" && v >= 0;
    if (!str(p?.baseUrl) || !str(p?.keyFile) || !str(p?.model) || !num(p?.price?.input) || !num(p?.price?.output) || !(num(p?.weekUsd) && p.weekUsd > 0)
      || !(num(p?.contextTokens) && p.contextTokens > 0) || !/^\d+\.\d+\.\d+$/.test(String(p?.cliVersion ?? ""))) {
      throw new Error(`config: models.providers.${name} needs baseUrl, keyFile, model, price.input, price.output (USD per million tokens), weekUsd above 0, contextTokens (the model's context window) and cliVersion (the Claude Code version it was tried on, like 2.1.330) (${where})`);
    }
  }
  // a base URL in the kernel's environment would go with every session, the owner's login and no token of its own
  if (cfg.kernel?.env?.ANTHROPIC_BASE_URL) throw new Error(`config: kernel.env sets ANTHROPIC_BASE_URL, so every session would send this computer's claude.ai login there; put another provider in models.providers (its own token and config directory) and take it out of kernel.env (${where})`);
  for (const [role, name] of Object.entries(cfg.models?.providerByRole ?? {})) {
    if (!(MODEL_ROLES as readonly string[]).includes(role)) throw new Error(`config: models.providerByRole has an unknown role ${JSON.stringify(role)} — known roles: ${MODEL_ROLES.join(", ")} (${where})`);
    if (!cfg.models.providers?.[name]) throw new Error(`config: models.providerByRole.${role} names ${JSON.stringify(name)}, which models.providers does not have (${where})`);
  }
  if (cfg.gate?.enabled) {
    for (const key of ["me", "owner"] as const) {
      const v: unknown = cfg.names?.[key];
      if (typeof v !== "string" || v.trim() === "") throw new Error(`config: names.${key} is empty while the gate is enabled — set it in the instance file, or set gate.enabled to false (${where})`);
    }
  }
}

/** The node a launchd job runs: tools.node, or the one running now */
export const nodeBin = (cfg: Pick<Config, "tools">): string => cfg.tools.node || process.execPath;
