// day 场景：她自己按钟过的一天。起来以前先往排程表里放三条她自己排的（一次性的提醒、每天的提醒、一段专注），然后虚拟时间一步 30 秒
// （hhd 的定时器那一下）走 26 小时：每步先把时钟走到点、再 w.tick()（brain.tick、事件记忆的日常、书架重扫），然后每个还有没回的 send 的
// 会话按脑区演一轮固定的剧本，再排空。一天里她自己给自己发的话都留在记录里：专注时段和它的升级（找事做、好几轮没做事、额度紧）、放空、
// 到点的提醒、排的专注、额度跨档的提醒（往上、重置、被拒、烧得太快）、去睡觉、夜里那一觉（旧的整理或分段整理的第一段和催交）、醒来、
// 翻页压缩（分叉那条路和退回海马那条路各一次）。额度读数、翻页的时间、替系统回答的命令都在下面的表里：同一份快照每次一样。小判断照 judge.ts 回。
// 最后记一条 day-coverage（每一种话见没见到，按树自己的 P.* 认：src/lang/index.ts 的 P，绑过这个角色名字的那一份）和一条 info 的 log（没见到的列出来），再记状态。
//
// 默认配置的真数据上，下面这些按构造走不到（day-coverage 里是 false）：
// - 醒了（WOKE_UP）、小睡：要压缩块到 limits.sleepyAtTokens（默认 15 万）以上才困；这里的压缩稿只有一两千，快照里原有的块够不够看数据。
// - 夜里睡醒（WOKE_UP_AFTER_NIGHT）和睡过早上补的规划：闲着的假内核几分钟就把夜里做完（分段整理也只是开一段、催一次、再做一次），
//   醒来还在夜里放空里，到不了第一个专注时段以后。
// - 分段整理的第一段：场景只替它回答「等着整理的日子」那一问（RUN_ANSWERS）。别的命令（准备的脚本、切材料的）由记录用的 Runner
//   回成功、没输出，带材料的段找不到切片（sleep/<日>/slices/、input.md）就开不了会话，这里不替它写材料；走得到哪由真流程定。
//   不要材料的段走得到叫醒、没交就催一次、再做一次，然后推迟（小快照上最小的流程就是这样）。没有 flow.json 时旧的整理走到「接着整理」那一催。
// - 光一句「你还在专注」（FOCUS_CONTINUE 后面不带别的）：剧本从不调工具，专注里的空转计数一轮以后就 ≥ 1，接着的都是找事做 / 好几轮没做事。
// - 想干等（FOCUS_WAITING）、主线出错后一分钟一叫、她在干活时不叫（后台一轮里）：剧本的话是固定的、一轮马上结束，都碰不到。
import { focusSlotAt, nightOf } from "../../brainstem/clock.ts";
import { DEFAULT_LEVELS, levelOf, observeQuota, type QuotaReading, type QuotaState } from "../../brainstem/quota.ts";
import type { Config } from "../../config.ts";
import type { Script } from "../../kernel/fake.ts";
import type { ForkResult } from "../../kernel/types.ts";
import { P } from "../../lang/index.ts";   // the bound pack: what the brain reads, with the role's names filled in
import { kvGet } from "../../store/db.ts";
import type { RunResult } from "../../util/run.ts";
import { answerUnanswered, recordCall, type Answered } from "../drive.ts";
import { judgeAnswer } from "../judge.ts";
import type { Scenario } from "../scenario.ts";
import type { World } from "../world.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** 一天走多久：夜里那一觉前后都走到（从快照的时刻起） */
export const DAY_HOURS = 26;
/** 一步多长：hhd 每 30 秒 tick 一下 */
export const STEP_MS = 30_000;

// ———————————————— 场景自己放进去的输入 ————————————————

/** 起来以前放进排程表的（离 T0 多久到点）：哪份快照上都会到点（夜里放空时到点的提醒留到早上，专注夜里也照开） */
export const SCHEDULE_INPUTS: ReadonlyArray<{ kind: "remind" | "focus"; at: number; text: string; everyMs: number | null; minutes: number | null }> = [
  { kind: "remind", at: 40 * MIN, text: "（对照）一次性的提醒：给院子里的花浇水", everyMs: null, minutes: null },
  { kind: "remind", at: 90 * MIN, text: "（对照）每天的提醒：看一眼工具墙", everyMs: DAY, minutes: null },
  { kind: "focus", at: 2 * HOUR, text: "（对照）排的一段专注：整理工具墙", everyMs: null, minutes: 30 },
];

/**
 * 额度的一步（驱动的 quotaReading；醒着时 10 分钟问一次，读不到 2 分钟后再问）：从锚点往后 at 起，这一格是这个用量，到同一格的下一步为止；
 * gone = 读数里没有这一格。锚点 T0 是快照的时刻；S 是「额度紧」要落进去的那个专注时段的开头（tightSlot）。重置时刻一律从 T0 算。
 * 档位（brainstem/quota.ts）：5 小时 50/70/85/95，7 天 70/85/95；专注拉长叫醒的线 schedule.focusQuotaWeekMax（默认 90），闸门停下小判断的线
 * parallel.quotaWeekMax（默认 97）
 */
export type QuotaStep = { from: "T0" | "S"; at: number } & ({ used: number; resetsAt: number } | { gone: true });

/** 5 小时那格：一档档往上过 50/70/85/95，从最高档重置（直达），读不到一段以后又过 50，从低档重置（不说），最后没有这一格 */
export const FIVE_HOUR: readonly QuotaStep[] = [
  { from: "T0", at: 0, used: 20, resetsAt: 3 * HOUR },
  { from: "T0", at: 1 * HOUR, used: 55, resetsAt: 3 * HOUR },
  { from: "T0", at: 1.5 * HOUR, used: 72, resetsAt: 3 * HOUR },
  { from: "T0", at: 2 * HOUR, used: 88, resetsAt: 3 * HOUR },
  { from: "T0", at: 2.5 * HOUR, used: 96, resetsAt: 3 * HOUR },
  { from: "T0", at: 3 * HOUR, used: 4, resetsAt: 8 * HOUR },
  { from: "T0", at: 4 * HOUR + 10 * MIN, used: 10, resetsAt: 8 * HOUR },
  { from: "T0", at: 6 * HOUR, used: 52, resetsAt: 8 * HOUR },
  { from: "T0", at: 9 * HOUR, used: 3, resetsAt: 13 * HOUR },
  { from: "S", at: 2.5 * HOUR, gone: true },
];

/**
 * 7 天那格：过 70（这周烧得太快）、过 85；S 前半小时过专注的线 90，一直到重置都在线上，所以 S 那个专注时段整段都是「额度紧」；
 * 再过 95（直达）、过闸门的线 97，最后重置（直达）
 */
export const WEEK: readonly QuotaStep[] = [
  { from: "T0", at: 0, used: 30, resetsAt: 5 * DAY },
  { from: "T0", at: 4 * HOUR + 10 * MIN, used: 72, resetsAt: 5 * DAY },
  { from: "T0", at: 6 * HOUR, used: 86, resetsAt: 5 * DAY },
  { from: "S", at: -30 * MIN, used: 91, resetsAt: 5 * DAY },
  { from: "S", at: 1.5 * HOUR, used: 96, resetsAt: 5 * DAY },
  { from: "S", at: 2.5 * HOUR, used: 98, resetsAt: 5 * DAY },
  { from: "S", at: 4 * HOUR, used: 2, resetsAt: 12 * DAY },
];

/** 读不到额度的一段 */
export const QUOTA_OUTAGES: ReadonlyArray<{ from: "T0" | "S"; at: number; until: number }> = [{ from: "T0", at: 4 * HOUR, until: 4 * HOUR + 10 * MIN }];
/** 被拒的一段（读数带 rejected，到 resetsAt 恢复；这一段比恢复早结束，第二次问到时还在拒的期限里，不重复说） */
export const QUOTA_REJECTIONS: ReadonlyArray<{ from: "T0" | "S"; at: number; until: number; window: string; resetsAt: number }> = [
  { from: "S", at: 2.5 * HOUR, until: 2.5 * HOUR + 15 * MIN, window: "seven_day", resetsAt: 2.5 * HOUR + 20 * MIN },
];

/**
 * S 怎么定，才不管 T0 落在一天的什么时候都有一个醒着的专注时段整段在「额度紧」里：T0 + 7 小时以后（含）第一个固定专注时段开始的那一刻
 * （照配置的 focusSlots、focusMinutes、时区，用树自己的 focusSlotAt 一分钟一分钟找）。专注时段都在夜里那段（nightSleep 到第一个时段）之外，
 * 那时她醒着。7 小时：7 天那格的 72、86 两步（T0 + 4:10、6:00）都在 S 前面。默认配置相邻两个时段最远隔 13.5 小时，S 最晚 T0 + 20.5 小时，
 * 后面几步（最晚 S + 4 小时）都落在 26 小时里。两天里找不到时段（没配）就取 T0 + 8 小时
 */
export const TIGHT_AFTER = 7 * HOUR;
const TIGHT_FALLBACK = 8 * HOUR;

/**
 * 翻页的时间表（离 T0 多久）：到点以后主线演的那一轮报的上下文是 limits.maxContextTokens（过了「哪个脑区快满了」那条 95% 的线），这一轮结束就翻页。
 * 一直报到真的翻起来（记到一次分叉，或海马压缩开始了）才算用掉：这一轮结束没翻（onTurnEnd 提前返回）、正在翻页（不报）都留着下一轮。
 * 第一次分叉回合格的压缩稿（分叉那条路收下），以后的分叉回驱动默认的短稿（太短，退回海马压缩那条路）
 */
export const PAGE_TURNS: readonly number[] = [2 * HOUR + 10 * MIN, 8 * HOUR + 10 * MIN];

/**
 * 场景替系统回答的外部命令（World.answerRun；回了什么记在那条 run 的 answered 里），别的照默认（成功、没输出）。
 * 等着整理的日子只列一天（brain.ts pendingDays 照 YYYY-MM-DD 认）：这一夜的那一天（nightOf）。旧的整理、分段整理都先问它；
 * 一直列着这一天，旧的整理就走到「接着整理」那一催，分段整理这一夜试过这一天就不再试
 */
export const RUN_ANSWERS: ReadonlyArray<{ what: string; match: (cmd: string, args: readonly string[], cfg: Config) => boolean; answer: (now: number, cfg: Config) => RunResult }> = [
  {
    what: "sleep_digest.py pending",
    match: (cmd, args, cfg) => {
      const argv = cfg.sleep.pendingDays;   // the configured command, exactly (same condition as brain.ts pendingDays); unset = the night module's
      if (!(Array.isArray(argv) && argv.length > 0 && argv.every((x) => typeof x === "string" && x.length > 0))) return cmd === cfg.tools.python && args.length === 2 && args[0]!.endsWith("/modules/night/scripts/sleep_digest.py") && args[1] === "pending";
      return cmd === argv[0] && args.length === argv.length - 1 && args.every((x, i) => x === argv[i + 1]);
    },
    answer: (now, cfg) => ({ code: 0, stdout: `${nightOf(now, cfg.schedule.timezone)}\n`, stderr: "" }),
  },
];

/** 主线、一边做着的、慢慢想的、随口应的，夜里分段整理的会话，都回这一句 */
const SAY: Script = { say: "（对照）" };
/** 海马回这一句（翻页压缩、夜里整理） */
const HIPPOCAMPUS: Script = { say: "NO_REPLY" };

/**
 * 合格压缩稿的锚点：HH 在自己醒的一轮（专注、放空）说了话以后记的那条「这段没发给任何人」里的一段原话（prompts.ts UNSENT_REPLY）。
 * 翻页那一轮就是这样的一轮，这条一定在这一页里；两段写成同一句，取到的是比对范围里最早的那条
 */
const ANCHOR = "这一轮是自己醒的，没有谁在等回复";
/** 条数：去掉锚点也不短于分叉稿的下限（brain.ts forkMinChars：最多 1500 字） */
const FORK_ITEMS = 30;
/** 每条开头认得出是这份稿（收下以后在新前缀里找它） */
const FORK_MARK = "（对照）固定的压缩稿";
/** 第一次分叉回的压缩稿：每条「- 」开头、末尾带锚点，HH 换成编号范围以后条条有出处 */
export const VALID_FORK_TEXT = Array.from({ length: FORK_ITEMS }, (_, i) =>
  `- ${FORK_MARK}第 ${String(i + 1).padStart(2, "0")} 条：这一页里的一件事，照固定的稿子写，只为让分叉那条路收下这一段。〔锚：${ANCHOR}｜${ANCHOR}〕`).join("\n");
const NO_USAGE = { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

// ———————————————— 读表 ————————————————

/** 一天走多久（小时）：只给测试用的缩短写在快照配置的 parity.dayHours 里（场景子进程只拿到快照和配置）；开头那条 call day 记着 */
export function dayHours(cfg: unknown): number {
  const raw = (cfg as { parity?: { dayHours?: unknown } } | null)?.parity?.dayHours;
  if (raw === undefined) return DAY_HOURS;
  if (typeof raw !== "number" || !(raw > 0) || !Number.isFinite(raw)) throw new Error(`parity: config parity.dayHours must be a positive number of hours (got ${JSON.stringify(raw)})`);
  return raw;
}

/** S：T0 + TIGHT_AFTER 以后（含）第一个固定专注时段开始的那一刻（见 TIGHT_AFTER） */
export function tightSlot(t0: number, s: Pick<Config["schedule"], "focusSlots" | "focusMinutes" | "timezone">): number {
  const from = t0 + TIGHT_AFTER;
  for (let t = from; t < from + 2 * DAY; t += MIN) {
    const slot = focusSlotAt(t, s.timezone, s.focusSlots, s.focusMinutes);
    if (slot !== null && focusSlotAt(t - MIN, s.timezone, s.focusSlots, s.focusMinutes) !== slot) return t;
  }
  return t0 + TIGHT_FALLBACK;
}

/** 某一格在时刻 t 的那一步（锚点换成绝对时间）；还没到第一步给 null */
function stepAt(steps: readonly QuotaStep[], t0: number, s: number, t: number): QuotaStep | null {
  let cur: QuotaStep | null = null;
  for (const x of steps) if ((x.from === "T0" ? t0 : s) + x.at <= t) cur = x;
  return cur;
}

/** 时刻 t 的额度读数（重置时刻换成绝对时间）；在读不到的那一段里给 null */
export function quotaAt(t0: number, s: number, t: number): QuotaReading | null {
  const base = (from: "T0" | "S"): number => (from === "T0" ? t0 : s);
  if (QUOTA_OUTAGES.some((o) => base(o.from) + o.at <= t && t < base(o.from) + o.until)) return null;
  const win = (x: QuotaStep | null) => (x && "used" in x ? { used: x.used, resetsAt: t0 + x.resetsAt } : null);
  const five = win(stepAt(FIVE_HOUR, t0, s, t));
  const week = win(stepAt(WEEK, t0, s, t));
  const rej = QUOTA_REJECTIONS.find((r) => base(r.from) + r.at <= t && t < base(r.from) + r.until);
  return {
    ...(five ? { fiveHour: five } : {}),
    ...(week ? { sevenDay: week } : {}),
    ...(rej ? { rejected: { window: rej.window, resetsAt: base(rej.from) + rej.resetsAt } } : {}),
  };
}

// ———————————————— 认话：按树自己的 P.* ————————————————

/** 带参数的提示：参数换成记号渲染一遍，在记号处切开；真发出去的话里这几段按顺序都在，就算是它 */
function pieces(rendered: string, marks: readonly string[]): string[] {
  let parts = [rendered];
  for (const m of marks) parts = parts.flatMap((p) => p.split(m));
  return parts.filter(Boolean);
}
function fits(text: string, parts: readonly string[]): boolean {
  let i = 0;
  for (const p of parts) {
    const j = text.indexOf(p, i);
    if (j < 0) return false;
    i = j + p.length;
  }
  return parts.length > 0;
}
const MARK = "\u0000参数\u0000";
const N1 = 97_531;
const N2 = 86_420;
const TIGHT_PARTS = () => pieces(P.focusQuotaTight(N1, N2), [String(N1), String(N2)]);
const GUIDE_MARKS = { me: MARK, ta: MARK, workspace: MARK, guide: MARK, firstStep: MARK, lastStep: MARK, state: MARK, recallNote: MARK, eventNote: MARK };   // 角色自己的那几样也当洞：哪个角色的值都对得上
// Computed when asked, never kept: these prompts carry the role's names, which are bound only once the world is built
const ORGANIZE_PARTS = () => [true, false].map((m) => pieces(P.nightOrganize(MARK, m, GUIDE_MARKS), [MARK]));
const CONTINUE_PARTS = () => pieces(P.nightContinue(MARK, GUIDE_MARKS), [MARK]);
const STAGE_PARTS = () => pieces(P.SLEEP_STAGE_WAKE(MARK, MARK, MARK, { day: MARK, proposed: MARK }), [MARK]);
const COMPACT_PARTS = () => pieces(P.compactPrompt(N1), [String(N1)]);
const FORK_PARTS = () => [null, MARK].flatMap((boundary) => [false, true].map((gap) => pieces(P.compactForkPrompt(N1, { boundary, gap }), [String(N1), MARK])));

/** 额度提醒的几种（day-coverage 里的名字） */
const QUOTA_KINDS = ["quotaFiveHourUp", "quotaFiveHourReset", "quotaWeekUp", "quotaWeekReset", "quotaPace", "quotaRejected"] as const;

/** 一天里看到的：各会话收到的话、小判断的题、分叉的话、额度提醒（正文和是哪几种）、去睡觉的次数、分叉的稿收下没有 */
interface Seen {
  main: string[]; hippocampus: string[]; night: string[]; all: string[]; asks: string[]; forks: string[];
  notices: Array<{ text: string; kinds: string[] }>; sleeps: string[]; forkAccepted: boolean;
}

const has = (xs: readonly string[], s: string): boolean => xs.some((t) => t.includes(s));
const noticeSeen = (seen: Seen, kind: string): boolean =>
  seen.notices.some((n) => n.kinds.includes(kind) && (has(seen.all, n.text) || has(seen.asks, n.text)));
const reminder = (seen: Seen, text: string): boolean => seen.main.some((t) => t.includes(P.REMINDER_TRIGGER) && t.includes(text));
const [ONCE, DAILY, BLOCK] = SCHEDULE_INPUTS.map((x) => x.text) as [string, string, string];

/**
 * 这一天要走到的每一种话，和怎么认（都是树自己的常量、函数；排的提醒、专注认它们的内容，那是场景自己放进去的）。
 * 额度提醒：那次读数算出来的提醒（树自己的 observeQuota）进了哪个会话的话或小判断的题。去睡觉不发话：调过 Brain.sleep、调完她睡着了才算
 */
export const FAMILIES: ReadonlyArray<readonly [string, (s: Seen) => boolean]> = [
  ["focusPlan", (s) => has(s.main, P.FOCUS_PLAN)],
  ["focusRegular", (s) => s.main.some((t) => t.includes(P.FOCUS_REGULAR) && !t.includes(BLOCK))],
  ["focusFindWork", (s) => has(s.main, P.FOCUS_FIND_WORK)],
  ["focusIdleLong", (s) => has(s.main, P.FOCUS_IDLE_LONG)],
  ["focusQuotaTight", (s) => s.main.some((t) => fits(t, TIGHT_PARTS()))],
  ["wander", (s) => has(s.main, P.WANDER)],
  ["reminderTrigger", (s) => has(s.main, P.REMINDER_TRIGGER)],
  ["reminderOnce", (s) => reminder(s, ONCE)],
  ["reminderDaily", (s) => reminder(s, DAILY)],
  ["scheduledFocus", (s) => s.main.some((t) => t.includes(P.FOCUS_REGULAR) && t.includes(BLOCK))],
  ...QUOTA_KINDS.map((k) => [k, (s: Seen) => noticeSeen(s, k)] as const),
  ["goingToSleep", (s) => s.sleeps.length > 0],
  ["nightOrganize", (s) => s.hippocampus.some((t) => ORGANIZE_PARTS().some((p) => fits(t, p)))],
  ["nightStage", (s) => s.night.some((t) => fits(t, STAGE_PARTS()))],
  ["nightNudge", (s) => s.hippocampus.some((t) => fits(t, CONTINUE_PARTS())) || has(s.night, P.SLEEP_STAGE_CONTINUE)],
  ["wokeUp", (s) => has(s.main, P.WOKE_UP)],
  ["wokeUpAfterNight", (s) => has(s.main, P.WOKE_UP_AFTER_NIGHT)],
  ["pageTurnFork", (s) => s.forkAccepted && s.forks.some((t) => FORK_PARTS().some((p) => fits(t, p)))],
  ["pageTurnFallback", (s) => s.hippocampus.some((t) => fits(t, COMPACT_PARTS()))],
];

/**
 * 额度读数进来时，提醒是哪几种：用树自己的 observeQuota 从同一个状态算（Brain 存的那份，跟它算出来的一字不差），再把读数拆成单独一格
 * （被拒、5 小时、7 天）各算一次看是哪一格说了话；那一格落在 0 档的是重置，不然是升档。这周烧得太快：这一次记下了新的 paceDay
 */
function noticeKinds(prev: QuotaState, r: QuotaReading, opts: { now: number; timezone: string }): { state: QuotaState; notice: string | null; kinds: string[] } {
  const full = observeQuota(prev, r, opts);
  const kinds: string[] = [];
  if (full.notice) {
    if (r.rejected && observeQuota(prev, { rejected: r.rejected }, opts).notice) kinds.push("quotaRejected");
    if (r.fiveHour && observeQuota(prev, { fiveHour: r.fiveHour }, opts).notice) kinds.push(levelOf(r.fiveHour.used, DEFAULT_LEVELS.fiveHour) === 0 ? "quotaFiveHourReset" : "quotaFiveHourUp");
    if (r.sevenDay) {
      const paced = full.state.paceDay !== prev.paceDay;
      if (paced) kinds.push("quotaPace");
      // 只看升档、重置：这周烧得太快那句压掉（paceDay 当作今天已经说过）
      const quiet = full.state.paceDay === undefined ? prev : { ...prev, paceDay: full.state.paceDay };
      if (observeQuota(quiet, { sevenDay: r.sevenDay }, opts).notice) kinds.push(levelOf(r.sevenDay.used, DEFAULT_LEVELS.sevenDay) === 0 ? "quotaWeekReset" : "quotaWeekUp");
    }
  }
  return { state: full.state, notice: full.notice, kinds };
}

/** Brain 存着的额度状态（kv 的 quota，brain.ts QUOTA_KEY）：快照里有就从它接着算，没有就是空的 */
function storedQuota(w: World): QuotaState {
  try { return (JSON.parse(kvGet(w.db, "quota") ?? "{}") as QuotaState) ?? {}; } catch { return {}; }
}

export const day: Scenario = {
  name: "day",
  async run(w) {
    const hours = dayHours(w.cfg);
    const t0 = w.clock.now;
    const end = t0 + hours * HOUR;
    const tz = w.cfg.schedule.timezone;
    const s = tightSlot(t0, w.cfg.schedule);
    w.rec.add("call", { name: "day", args: { hours, stepMs: STEP_MS, tightSlot: s - t0 }, returned: null });
    w.driver.answerAsk(judgeAnswer);
    w.answerRun((cmd, args) => RUN_ANSWERS.find((x) => x.match(cmd, args, w.cfg))?.answer(w.clock.now, w.cfg));

    // 分叉：第一次回合格的稿，之后交给驱动默认的那个（太短，退回海马）；问了什么留着认话
    const fallback = w.driver.forkAnswer;
    const forks: string[] = [];
    w.driver.forkAnswer = (text, sess): ForkResult | Promise<ForkResult> => {
      forks.push(text);
      return forks.length === 1 ? { ok: true, text: VALID_FORK_TEXT, total: NO_USAGE } : fallback(text, sess);
    };
    // 额度：每次 Brain 问到读数，照它存的状态算出这次的提醒是哪几种（不改它拿到的读数）
    let quotaState = storedQuota(w);
    const notices: Seen["notices"] = [];
    const quota = w.driver.quota.bind(w.driver);
    w.driver.quota = async (o) => {
      const r = await quota(o);
      if (r) {
        const k = noticeKinds(quotaState, r, { now: w.clock.now, timezone: tz });
        quotaState = k.state;
        if (k.notice) notices.push({ text: k.notice, kinds: k.kinds });
      }
      return r;
    };
    // 去睡觉不发话：照样调原来的 Brain.sleep，调完她真睡着了才记一次（翻页中进去的只是排着等翻完，这一次不算；
    // 睡着是在第一个 await 之前定下的，小睡马上又醒，所以调用一返回就看）
    const sleeps: string[] = [];
    const sleep = w.brain.sleep.bind(w.brain);
    w.brain.sleep = (reason, kind) => {
      const done = sleep(reason, kind);
      if (w.brain.alertness === "asleep") sleeps.push(kind ?? "manual");
      return done;
    };

    // 她排的：照树自己写排程表的那一句（Schedule.add）放进工作副本的库
    const rows = SCHEDULE_INPUTS.map((x) => ({ kind: x.kind, due: t0 + x.at, text: x.text, everyMs: x.everyMs, minutes: x.minutes }));
    recordCall(w.rec, "schedule", rows, () => rows.map((x) => w.brain.schedule.add(x.kind, x.due, x.text, x.everyMs, x.minutes)), { rethrow: true });

    // 翻页：到点以后主线的那一轮报满上下文（正在翻页时不报），记到分叉或海马压缩开始了才用掉这一个
    const full = w.cfg.limits.maxContextTokens;
    const turns = [...PAGE_TURNS];
    let armed: number | null = null;
    const scriptFor = (_region: string, role?: string): Script => {
      if (role === "hippocampus") return HIPPOCAMPUS;
      if (role === "main" && turns.length && turns[0]! <= w.clock.now - t0 && !w.brain.turning) {
        armed ??= forks.length;
        return { ...SAY, contextTokens: full };
      }
      return SAY;
    };
    const turnStarted = (): void => {
      if (armed !== null && (forks.length > armed || w.brain.turning)) { turns.shift(); armed = null; }
    };

    w.driver.quotaReading = quotaAt(t0, s, t0);
    w.start();
    await w.drain();
    // 一步只演一圈（answerUnanswered）：演完又冒出来的留到下一步，那时钟已经走了 30 秒，跟真的一样隔着一轮
    const answered: Answered = new WeakMap();
    for (let t = t0 + STEP_MS; t <= end; t += STEP_MS) {
      w.driver.quotaReading = quotaAt(t0, s, t);
      await w.clock.advanceTo(t);
      await w.tick();
      await answerUnanswered(w, answered, scriptFor);
      await w.drain();
      turnStarted();
    }

    // 这一天走到了哪几种话
    const of = (pick: (id: string) => boolean): string[] => w.driver.sessions.filter((x) => pick(x.id)).flatMap((x) => x.sent.map((m) => m.text));
    const role = (id: string): string | undefined => w.brain.regions.get(id)?.spec.role;
    const blockIn = (text: string): string => text.split("\n").filter((l) => l.includes(FORK_MARK)).join("\n");
    const seen: Seen = {
      main: of((id) => role(id) === "main"), hippocampus: of((id) => role(id) === "hippocampus"), night: of((id) => role(id) === undefined), all: of(() => true),
      asks: w.driver.asks.map((a) => a.prompt), forks, notices, sleeps,
      forkAccepted: w.driver.sessions.some((x) => role(x.id) === "main" && P.blockHasRefs(blockIn(x.spec.systemAppend))),
    };
    const coverage = Object.fromEntries(FAMILIES.map(([name, test]) => [name, test(seen)]));
    w.rec.add("call", { name: "day-coverage", args: null, returned: coverage });
    const missing = FAMILIES.map(([name]) => name).filter((name) => !coverage[name]);
    w.rec.log("info", missing.length ? `parity: day did not reach: ${missing.join(", ")}` : "parity: day reached every family");
    w.recordState();
  },
};
