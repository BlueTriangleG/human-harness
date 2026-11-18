// 她手上在做的事：估多久、实际多久、谁在做、派了哪些帮手。分派、后台的生命周期、准头都从这里读。
import type { Db } from "../store/db.ts";
import { all } from "../store/db.ts";
import { B } from "../lang/index.ts";

export type Pri = "T0" | "T1" | "T2" | "T3";
export type TaskState = "doing" | "done" | "follow" | "paused" | "dropped";

export interface TaskRow {
  id: number;
  topic: string;
  owner: string;
  aboutMin: number | null;
  pri: Pri;
  askedBy: string | null;
  state: TaskState;
  started: number;
  ended: number | null;
  tookMin: number | null;
  helpers: string[];
  waitingFor: string | null;
  idleWakes: number;
  /** 开头定的：做到什么样才算好 */
  bar: string | null;
  /** 当初别人要她做时的原话（自己要做的事是 null） */
  ask: string | null;
  /** 说做完以后回头看了几次（没到的次数） */
  looks: number;
  /** 上次回头看觉得还差什么 */
  missing: string | null;
  /** 做完时记下的：这件事里挂给她看过的页（页编号）；还没说做完过是 null */
  pages: string[] | null;
}

interface Raw { id: number; topic: string; owner: string; about_min: number | null; pri: string; asked_by: string | null; state: string; started: number; ended: number | null; took_min: number | null; helpers: string; waiting_for: string | null; idle_wakes: number; bar: string | null; ask: string | null; looks: number; missing: string | null; pages: string | null }

function toRow(r: Raw): TaskRow {
  return {
    id: Number(r.id), topic: r.topic, owner: r.owner, aboutMin: r.about_min === null ? null : Number(r.about_min), pri: r.pri as Pri,
    askedBy: r.asked_by, state: r.state as TaskState, started: Number(r.started), ended: r.ended === null ? null : Number(r.ended),
    tookMin: r.took_min === null ? null : Number(r.took_min), helpers: JSON.parse(r.helpers) as string[], waitingFor: r.waiting_for, idleWakes: Number(r.idle_wakes),
    bar: r.bar, ask: r.ask, looks: Number(r.looks), missing: r.missing,
    pages: r.pages === null ? null : JSON.parse(r.pages) as string[],
  };
}

const CN: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 一个数：阿拉伯数字或中文（到 99）。区间、约数取大的：「一两」「三四十」→ 上限；「十几」→ 15；「几」→ 3；「多」→ 加半个单位，由调用方处理。
 */
function amount(s: string): number | null {
  if (/^[\d.]+$/.test(s)) return Number(s);
  if (s === "几") return 3;
  if (s === "十几") return 15;
  if (s === "半") return 0.5;
  // 「三四十」「二三十」：两个相邻数 + 十 → 大的那个乘十
  const r10 = /^([一二两三四五六七八九])([一二两三四五六七八九])十$/.exec(s);
  if (r10) return CN[r10[2]!]! * 10;
  // 「一两」「两三」：两个相邻数 → 大的
  if (s.length === 2 && CN[s[0]!] !== undefined && CN[s[1]!] !== undefined) return CN[s[1]!]!;
  if (!s.includes("十")) return s.length === 1 && CN[s] !== undefined ? CN[s]! : null;
  const [x, y] = s.split("十");
  const tens = x ? CN[x] : 1;
  const ones = y ? CN[y] : 0;
  return tens === undefined || ones === undefined ? null : tens * 10 + ones;
}

/** 一段里的「几小时几分」→ 分钟；没有时长返回 null */
function oneSpan(t: string): number | null {
  const d = B.forms.duration;
  if (d.halfDay.test(t)) return 240;
  if (d.day.test(t)) return 480;
  if (d.quarter.test(t)) return 15;
  if (d.halfHour.test(t)) return 30;
  let total = 0;
  let found = false;
  const h = new RegExp(`${B.tasks.numberPattern}\\s*${B.tasks.hourUnitPattern}`).exec(t);
  if (h) {
    const n = amount(h[1]!);
    if (n === null || Number.isNaN(n)) return null;
    total += (n + (h[2] || h[3] ? 0.5 : 0)) * 60;
    found = true;
  }
  const rest = h ? t.slice(h.index + h[0].length) : t;
  const m = new RegExp(B.tasks.amountWithUnitPattern(B.tasks.numberPattern, B.tasks.minuteUnitPattern)).exec(rest);
  if (m) {
    const n = amount(m[1]!);
    if (n === null || Number.isNaN(n)) return null;
    total += n;
    found = true;
  }
  return found ? Math.round(total) : null;
}

/** 她写的「大概要多久」→ 分钟；区间取上限；看不懂返回 null */
export function parseDuration(s: string | undefined): number | null {
  let t = (s ?? "").trim().toLowerCase();
  if (!t) return null;
  t = t.replace(B.forms.duration.hedge, "");
  if (!t) return null;
  // 区间「a 到 b」「a-b」：两边都能读就取大的；右边没单位时借左边的单位（1-2h）
  const parts = t.split(B.forms.duration.to).filter(Boolean);
  if (parts.length === 2) {
    const right = oneSpan(parts[1]!);
    if (right !== null) return Math.max(right, oneSpan(parts[0]!) ?? 0);
  }
  return oneSpan(t);
}

export class TaskBook {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  byId(id: number): TaskRow {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Raw | undefined;
    if (!r) throw new Error(B.tasks.taskNotFound(id));
    return toRow(r);
  }

  start(a: { topic: string; owner: string; aboutMin: number | null; pri: Pri; askedBy: string | null; ask?: string | null }): TaskRow {
    const r = this.db.prepare("INSERT INTO tasks (topic, owner, about_min, pri, asked_by, state, started, ask) VALUES (?, ?, ?, ?, ?, 'doing', ?, ?)")
      .run(a.topic, a.owner, a.aboutMin, a.pri, a.askedBy, this.now(), a.ask ?? null);
    return this.byId(Number(r.lastInsertRowid));
  }

  setBar(id: number, bar: string): void {
    this.db.prepare("UPDATE tasks SET bar = ? WHERE id = ?").run(bar, id);
  }

  /** 记下这件事里挂过哪几页（整个换掉：再说一次做完时重新数） */
  setPages(id: number, pages: string[]): void {
    this.db.prepare("UPDATE tasks SET pages = ? WHERE id = ?").run(JSON.stringify(pages), id);
  }

  /** 回头看了一遍、还没到：记下还差什么，返回一共没到几次了 */
  noteLook(id: number, missing: string): number {
    this.db.prepare("UPDATE tasks SET looks = looks + 1, missing = ? WHERE id = ?").run(missing, id);
    return this.byId(id).looks;
  }

  doing(owner?: string): TaskRow[] {
    const rows = owner
      ? all<Raw>(this.db, "SELECT * FROM tasks WHERE state = 'doing' AND owner = ? ORDER BY id", owner)
      : all<Raw>(this.db, "SELECT * FROM tasks WHERE state = 'doing' ORDER BY id");
    return rows.map(toRow);
  }

  byTopic(topic: string): TaskRow | undefined {
    return this.doing().find((t) => t.topic === topic);
  }

  finish(id: number, state: "done" | "follow" | "dropped", tookMin: number | null): TaskRow {
    this.db.prepare("UPDATE tasks SET state = ?, ended = ?, took_min = ?, waiting_for = NULL WHERE id = ?").run(state, this.now(), tookMin, id);
    return this.byId(id);
  }

  pause(id: number): void {
    this.db.prepare("UPDATE tasks SET state = 'paused', ended = ? WHERE id = ?").run(this.now(), id);
  }

  reassign(id: number, owner: string): void {
    this.db.prepare("UPDATE tasks SET owner = ? WHERE id = ?").run(owner, id);
  }

  addHelper(id: number, name: string): void {
    const t = this.byId(id);
    if (t.helpers.includes(name)) return;
    this.db.prepare("UPDATE tasks SET helpers = ? WHERE id = ?").run(JSON.stringify([...t.helpers, name]), id);
  }

  /** 这个帮手是哪件正在做的事派的（同名帮手取最近的那件） */
  ownerOfHelper(name: string): TaskRow | undefined {
    return this.doing().reverse().find((t) => t.helpers.includes(name));
  }

  /** 这个帮手挂到过除 exceptId 以外的哪件事上没有（不论那件事什么状态） */
  helperSeenElsewhere(name: string, exceptId: number): boolean {
    const rows = all<{ helpers: string }>(this.db, "SELECT helpers FROM tasks WHERE id != ? AND helpers LIKE ?", exceptId, `%${JSON.stringify(name)}%`);
    return rows.some((r) => (JSON.parse(r.helpers) as string[]).includes(name));
  }

  setWaiting(id: number, who: string | null): void {
    this.db.prepare("UPDATE tasks SET waiting_for = ? WHERE id = ?").run(who, id);
  }

  bumpIdle(id: number): number {
    this.db.prepare("UPDATE tasks SET idle_wakes = idle_wakes + 1 WHERE id = ?").run(id);
    return this.byId(id).idleWakes;
  }

  resetIdle(id: number): void {
    this.db.prepare("UPDATE tasks SET idle_wakes = 0 WHERE id = ?").run(id);
  }

  /** 某个时刻这部分在做哪件事：最近一件已经开头的（老记录标当时那件，不标现在这件；标完做完以后那段收尾的话也算它，10-31 线上） */
  atTime(owner: string, ts: number): TaskRow | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE owner = ? AND started <= ? ORDER BY started DESC, id DESC LIMIT 1").get(owner, ts) as Raw | undefined;
    return r ? toRow(r) : undefined;
  }

  pausedSince(ts: number): TaskRow[] {
    return all<Raw>(this.db, "SELECT * FROM tasks WHERE state = 'paused' AND ended >= ? ORDER BY id", ts).map(toRow);
  }

  /** 准头：最近 n 件做完（或只剩跟进）、估过时间的事，钟表分钟总和 / 估的分钟总和；不足 3 件不给 */
  calibration(n = 10): { n: number; ratio: number } | null {
    const rows = all<Raw>(this.db, "SELECT * FROM tasks WHERE state IN ('done', 'follow') AND about_min > 0 AND ended IS NOT NULL ORDER BY ended DESC LIMIT ?", n).map(toRow);
    if (rows.length < 3) return null;
    // 总实际 / 总估计（一件忘了关的不会把平均拉飞，review I3）
    const actual = rows.reduce((a, t) => a + (t.ended! - t.started) / 60_000, 0);
    const est = rows.reduce((a, t) => a + t.aboutMin!, 0);
    return { n: rows.length, ratio: Math.round((actual / est) * 10) / 10 };
  }
}
