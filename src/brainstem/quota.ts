import { B, dateLocale } from "../lang/index.ts";
// 额度感：Claude 订阅的 5 小时 / 7 天用量。数字从内核来（每次调用附带的限流事件 + 定时问一次用量），
// 跨过一档就变成一条感官事件交给下意识（额度护栏放在感官层，由她自己调整节奏）。
// 这里只管"什么时候该告诉她、怎么说"，不替她做决定。

export type WindowName = "fiveHour" | "sevenDay";

export interface QuotaWindow { used: number; resetsAt: number | null }

/** 内核报上来的一次读数（缺的窗口就是这次没读到） */
export interface QuotaReading {
  fiveHour?: QuotaWindow;
  sevenDay?: QuotaWindow;
  /** 被限流拒绝了（额度用完）：哪个窗口、什么时候恢复 */
  rejected?: { window: string; resetsAt: number | null };
}

export interface QuotaLevels { fiveHour: number[]; sevenDay: number[] }

export const DEFAULT_LEVELS: QuotaLevels = { fiveHour: [50, 70, 85, 95], sevenDay: [70, 85, 95] };

/** 被拒的那个窗口，用量比被拒那一刻少了这么多点：额度被重置了（重置卡、或者窗口自己滚过去了） */
const RESET_DROP = 20;
const WINDOW_OF: Record<string, WindowName> = { five_hour: "fiveHour", seven_day: "sevenDay" };
function recovered(prev: QuotaState, r: QuotaReading): boolean {
  // 老状态没记被拒的窗口和那一刻的用量（11-13 线上那份就是）：被拒当成用到了 100，几个窗口都看
  const wins: readonly WindowName[] = prev.rejectedWindow === undefined ? ["fiveHour", "sevenDay"] : prev.rejectedWindow ? [prev.rejectedWindow] : [];
  const at = prev.rejectedUsed ?? 100;
  return wins.some((w) => { const b = r[w]; return !!b && at - b.used >= RESET_DROP; });
}

/** 记下来的状态（存进 kv，重启后不重复提醒） */
export interface QuotaState {
  fiveHour?: QuotaWindow & { level: number };
  sevenDay?: QuotaWindow & { level: number };
  rejectedUntil?: number | null;
  /** 被拒的是哪个窗口（不是这两个窗口的就是 null：只等到恢复时刻）、被拒那一刻它用到多少；没被拒时不存 */
  rejectedWindow?: WindowName | null;
  rejectedUsed?: number;
  /** 上一次报「烧得太快」是她的哪一天（一天最多报一次） */
  paceDay?: string;
  at?: number;
}

const nameOf = (w: WindowName): string => (w === "fiveHour" ? B.quota.windowNameFiveHour : B.quota.windowNameSevenDay);

/** 用量落在第几档（0 = 还没到第一档） */
export function levelOf(used: number, levels: readonly number[]): number {
  let n = 0;
  for (const l of levels) if (used >= l) n += 1;
  return n;
}

function fmtReset(ts: number | null, tz: string, now: number): string {
  if (!ts) return "";
  const sameDay = new Date(ts).toLocaleDateString(dateLocale(), { timeZone: tz }) === new Date(now).toLocaleDateString(dateLocale(), { timeZone: tz });
  const s = new Intl.DateTimeFormat(dateLocale(), {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
    ...(sameDay ? {} : { weekday: "short", month: "numeric", day: "numeric" }),
  }).format(ts);
  return B.quota.resetSuffix(s);
}

function advice(w: WindowName, level: number, levels: readonly number[]): string {
  const top = levels.length;
  if (w === "fiveHour") {
    if (level >= top) return B.quota.fiveHourAdviceUsedUp;
    if (level >= top - 1) return B.quota.fiveHourAdviceNearlyEmpty;
    if (level >= 2) return B.quota.fiveHourAdviceFast;
    return B.quota.fiveHourAdviceHalf;
  }
  if (level >= top) return B.quota.sevenDayAdviceUsedUp;
  if (level >= top - 1) return B.quota.sevenDayAdviceTight;
  return B.quota.sevenDayAdviceBusy;
}

/**
 * 读数进来，返回要不要告诉她（一条感官事件的正文），不用就 null。
 * 规则：某个窗口升了一档 → 说；从有档掉回 0 档（窗口重置了）→ 说一声恢复了；被拒绝（用完）→ 说，恢复前不重复。
 * urgent：被拒、重置、或这次读到的某个窗口到了最高档——闸门直达主意识；别的交给她的规则（quota-pace）去判。
 */
export function observeQuota(
  prev: QuotaState,
  r: QuotaReading,
  opts: { now: number; timezone: string; levels?: QuotaLevels },
): { state: QuotaState; notice: string | null; urgent: boolean } {
  const levels = opts.levels ?? DEFAULT_LEVELS;
  const state: QuotaState = { ...prev, at: opts.now };
  const lines: string[] = [];
  const tips: string[] = [];
  let urgent = false;

  if (r.rejected) {
    const until = r.rejected.resetsAt;
    const already = prev.rejectedUntil !== undefined && prev.rejectedUntil !== null && (until === null || prev.rejectedUntil >= until) && opts.now < prev.rejectedUntil;
    state.rejectedUntil = until ?? opts.now + 30 * 60_000;
    const win = WINDOW_OF[r.rejected.window] ?? null;
    state.rejectedWindow = win;
    state.rejectedUsed = (win && (r[win]?.used ?? prev[win]?.used)) ?? 100;
    if (!already) {
      const name = r.rejected.window === "seven_day" ? nameOf("sevenDay") : r.rejected.window === "five_hour" ? nameOf("fiveHour") : "";
      lines.push(B.quota.rejectedNotice(name, fmtReset(until, opts.timezone, opts.now)));
      tips.push(B.quota.rejectedTip);
      urgent = true;
    }
  } else if (prev.rejectedUntil && (opts.now >= prev.rejectedUntil || recovered(prev, r))) {
    // 被拒记到那个窗口重置的时刻；重置卡只把用量清零、重置时刻不变（11-13 07:56 周额度 100% → 1%，「被拒绝中」挂到了 11-17，
    // 再被拒一次也会被当成提醒过）：被拒的那个窗口比被拒那一刻少了一大截，就是已经恢复了。
    // 跟被拒那一刻比，不跟上一次读数比：重置发生在这版上线之前的（11-13 线上），上一次读数早就是低的了
    state.rejectedUntil = null;
    delete state.rejectedWindow;
    delete state.rejectedUsed;
  }

  for (const w of ["fiveHour", "sevenDay"] as const) {
    const cur = r[w];
    if (!cur) continue;
    const lv = levelOf(cur.used, levels[w]);
    const old = prev[w];
    state[w] = { ...cur, level: lv };
    if (lv >= levels[w].length) urgent = true;   // 到了最高档：几乎用完
    const reset = old && cur.resetsAt && old.resetsAt && cur.resetsAt > old.resetsAt + 60_000;
    if (old && lv > old.level && !reset) {
      lines.push(B.quota.usedPercentNotice(nameOf(w), Math.round(cur.used), fmtReset(cur.resetsAt, opts.timezone, opts.now)));
      tips.push(advice(w, lv, levels[w]));
    } else if (!old && lv > 0) {
      lines.push(B.quota.usedPercentNotice(nameOf(w), Math.round(cur.used), fmtReset(cur.resetsAt, opts.timezone, opts.now)));
      tips.push(advice(w, lv, levels[w]));
    } else if (old && old.level >= 2 && lv === 0) {
      lines.push(B.quota.windowResetNotice(nameOf(w), Math.round(cur.used)));
      tips.push(w === "sevenDay" ? B.quota.windowResetTipWeekly : B.quota.windowResetTipFiveHour);
      urgent = true;
    }
  }

  // 订阅已经没有 5 小时限制（CC ultra plan 取消了），读数里不再有它：存着的旧数过了重置时间就扔掉，别一直显示 1%
  if (!r.fiveHour && prev.fiveHour?.resetsAt && prev.fiveHour.resetsAt < opts.now) delete state.fiveHour;

  // 烧得太快：照这周到现在的速度，比重置早一天以上就会用完——一天报一次（一天用了 20%，70% 那一档要第 4 天才响）
  const pace = r.sevenDay ? paceLine(state.sevenDay, opts.now, opts.timezone) : null;
  const today = localDay(opts.now, opts.timezone);
  if (pace && prev.paceDay !== today) {
    lines.push(pace.line);
    tips.push(pace.tip);
    state.paceDay = today;
  }

  if (!lines.length) return { state, notice: null, urgent: false };
  return { state, notice: B.quota.quotaNotice(lines.join(""), tips.join("")), urgent };
}

const DAY = 24 * 3600_000;
const WEEK = 7 * DAY;

function localDay(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

/**
 * 这周的速度：过去了几天、用了多少，照这个速度哪天用完。早于重置一天以上才算「烧得太快」；
 * 刚重置不到 6 小时、用了不到 10% 的不算（数太少，一顿饭的工夫就能吓人一跳）
 */
export function paceLine(w: (QuotaWindow & { level: number }) | undefined, now: number, tz: string): { line: string; tip: string } | null {
  if (!w?.resetsAt || w.used < 10) return null;
  const elapsed = (now - (w.resetsAt - WEEK)) / DAY;
  const remaining = (w.resetsAt - now) / DAY;
  if (elapsed < 0.25 || remaining <= 0) return null;
  const perDay = w.used / elapsed;
  const toFull = (100 - w.used) / perDay;
  if (toFull >= remaining - 1) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat(dateLocale(), { timeZone: tz, weekday: "short", month: "numeric", day: "numeric" })
    .formatToParts(now + toFull * DAY).map((p) => [p.type, p.value]));
  const when = B.quota.paceDate(parts.month, parts.day, parts.weekday);
  return {
    line: B.quota.paceTooFastLine(Math.round(w.used), elapsed.toFixed(1), when, (remaining - toFull).toFixed(1)),
    // 省的是帮手和重活，不是醒着发呆（11-05：她把「放慢」当成醒了也回 NO_REPLY，专注里 122 次白读整段上下文）
    tip: B.quota.paceSlowDownTip(Math.round(100 / 7)),
  };
}

/** 状态面板用的一行 */
export function quotaSummary(s: QuotaState, timezone: string, now: number): string | null {
  const parts: string[] = [];
  for (const w of ["fiveHour", "sevenDay"] as const) {
    const x = s[w];
    if (x) parts.push(`${nameOf(w)} ${Math.round(x.used)}%${fmtReset(x.resetsAt, timezone, now)}`);
  }
  if (s.rejectedUntil && now < s.rejectedUntil) parts.push(B.quota.summaryRejected);
  return parts.length ? parts.join(B.quota.summarySep) : null;
}
