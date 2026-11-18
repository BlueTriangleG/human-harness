// 生物钟：按她的时区算"现在几点"、是不是专注时段、夜里该不该睡。纯函数，方便测试。
import { localToUtc } from "../memory/events/schema.ts";

/** 那一天的夜里从几点算起（nightSleep；中午以前的算第二天凌晨）到 +8 小时（毫秒） */
export function nightWindow(day: string, tz: string, nightSleep: string): { from: number; to: number } {
  const [h = 0, mi = 0] = nightSleep.split(":").map(Number);
  const d = new Date(`${day}T00:00:00Z`);
  if (h < 12) d.setUTCDate(d.getUTCDate() + 1);
  const from = localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), h, mi, tz);
  return { from, to: from + 8 * 3_600_000 };
}

export interface LocalTime { day: string; minutes: number }   // day = YYYY-MM-DD（凌晨 4 点前算前一天）

const DAY_START_MIN = 4 * 60;

export function localTime(now: number, tz: string): LocalTime {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  let day = `${parts.year}-${parts.month}-${parts.day}`;
  if (minutes < DAY_START_MIN) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    day = d.toISOString().slice(0, 10);
  }
  return { day, minutes };
}

/** 本地的钟点 HH:MM（给她看的） */
export function hhmm(now: number, tz: string): string {
  const m = localTime(now, tz).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 整理完 day 那一夜、她第二天一开始的那一刻（毫秒）：那一夜开始（nightWindow）和第二天 04:00（她的一天从 4 点算，
 * 跟 localTime、中期视图同一个界）里晚的那个。考场渲染她明天前缀里的中期视图用它（修正轮 2 I1）
 */
export function nextDayStart(day: string, tz: string, nightSleep: string): number {
  const [y, m, d] = nextDay(day).split("-").map(Number) as [number, number, number];
  return Math.max(nightWindow(day, tz, nightSleep).from, localToUtc(y, m, d, Math.floor(DAY_START_MIN / 60), DAY_START_MIN % 60, tz));
}

/** 某一天（YYYY-MM-DD）的下一天 */
export function nextDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 日历上的那一天（不按凌晨 4 点换）：给她看日期用 */
export function calendarDay(now: number, tz: string): string {
  const { day, minutes } = localTime(now, tz);
  return minutes < DAY_START_MIN ? nextDay(day) : day;
}

export function parseHM(hm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hm);
  if (!m) throw new Error(`bad HH:MM ${hm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 现在在哪个专注时段里（返回时段开始的 HH:MM），不在就 null */
export function focusSlotAt(now: number, tz: string, slots: readonly string[], focusMinutes: number): string | null {
  const { minutes } = localTime(now, tz);
  for (const s of slots) {
    const start = parseHM(s);
    if (minutes >= start && minutes < start + focusMinutes) return s;
  }
  return null;
}

// ---------- 夜里 ----------
// 一夜从傍晚算到第二天早上：中午 12 点前都算前一天的夜里（跟上面"凌晨 4 点换天"分开，夜里那段要跨过 4 点）。
const NOON_MIN = 12 * 60;

function nightClock(now: number, tz: string): { night: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (minutes >= NOON_MIN) return { night: date, minutes };
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { night: d.toISOString().slice(0, 10), minutes: minutes + 24 * 60 };
}

const nightMinutes = (hm: string): number => { const m = parseHM(hm); return m < NOON_MIN ? m + 24 * 60 : m; };

/** 这是哪一夜（傍晚那天的日期）：记"这一夜睡过了"用 */
export function nightOf(now: number, tz: string): string {
  return nightClock(now, tz).night;
}

/** 现在在不在夜里那段：从睡觉点 nightSleep 到早上 morning（第一个专注时段）之前 */
export function inNight(now: number, tz: string, nightSleep: string, morning: string): boolean {
  const { minutes } = nightClock(now, tz);
  return minutes >= nightMinutes(nightSleep) && minutes < nightMinutes(morning);
}

/** 夜里固定睡觉的时间到了没有：在夜里那段里，而且这一夜还没睡过（3 点在聊天、聊到 5 点，闲下来照样睡） */
export function nightSleepDue(now: number, tz: string, nightSleep: string, morning: string, lastNight: string | null): boolean {
  return lastNight !== nightOf(now, tz) && inNight(now, tz, nightSleep, morning);
}
