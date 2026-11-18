// 学习记分：每次又犯分成"挂了还犯"和"没挂就犯"，各出一道回测题（话题 → 应该挂的页）；种子题也在这里加。
// 夜里拿新封面重跑全部题（回测），每周的成长数字也从这些表里算。
// 记分表只增不改：learn_recur、learn_case、learn_case_run 都只 INSERT。
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../store/db.ts";
import { all, kvGet, kvSet, one } from "../store/db.ts";
import type { CentralMemory } from "../memory/central.ts";
import { TaskBook } from "../basal/tasks.ts";
import type { AssocResult, NoteAssociator } from "./associate.ts";
import type { Embedder } from "../memory/events/embed.ts";
import { EMBED_DIMS } from "../memory/events/embed.ts";
import { B, L, P } from "../lang/index.ts";
import { resolveId } from "./ids.ts";
import { LIST_ITEM } from "./notebook.ts";
import { param } from "./params.ts";
import { residentIds } from "./shelf.ts";
import type { Lesson, Page, Shelf } from "./notebook.ts";

export type RecurKind = "mounted" | "unmounted";

/** 又犯之前多久内挂过这页，算"挂了还犯" */
const MOUNT_WINDOW_MS = 6 * 3_600_000;
const DAY_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
/** 联想记录里的脑区名；出处不是这些（比如是收到的一条消息）就当 main 的事 */
const REGION = /^(?:main|deep|side-\d+)$/;

const insertCase = (db: Db, at: number, topic: string, expect: string, source: "seed" | RecurKind): number =>
  Number(db.prepare("INSERT INTO learn_case (at, topic, expect, source) VALUES (?, ?, ?, ?)").run(at, topic, expect, source).lastInsertRowid);

/** 种子题：人工出的第一批；topic 由 HH 这边的人给，不由她写 */
export function addSeedCase(db: Db, topic: string, expectPageId: string, now: number = Date.now()): number {
  return insertCase(db, now, topic, expectPageId, "seed");
}

export interface Moment { seq: number; ts: number; src: string }

/**
 * 这条教训在 day 这天又犯的那一刻：先找出处里发生在这天（按 tz）的那条；对不上就取和 day 在"犯的日子"里同一位置的出处；
 * 都没有（出处少了、中央记忆里没有）返回 null。
 */
function momentOf(db: Db, sources: number[], dayIndex: number, day: string, tz: string): Moment | null {
  if (!sources.length) return null;
  const rows = all<Moment>(db, `SELECT seq, ts, src FROM central WHERE seq IN (${sources.map(() => "?").join(",")})`, ...sources);
  const bySeq = new Map(rows.map((r) => [Number(r.seq), { seq: Number(r.seq), ts: Number(r.ts), src: r.src }]));
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  for (const s of sources) {
    const m = bySeq.get(s);
    if (m && fmt.format(m.ts) === day) return m;
  }
  return bySeq.get(sources[dayIndex] ?? -1) ?? null;
}

/**
 * 这一刻之前 6 小时内，这个脑区真挂给她看过这页的最近一行；没有返回 null，topic 可能为空。
 * 只算不挂的不算：她没看到，算成"挂了还犯"会让只算不挂那几天的又犯数字和后面没法比
 */
function lastMount(db: Db, region: string, pageIds: string[], t: number): { topic: string | null } | null {
  const rows = all<{ mounted: string; topic: string | null }>(
    db, "SELECT mounted, topic FROM learn_assoc WHERE region = ? AND shadow = 0 AND at >= ? AND at <= ? ORDER BY at DESC, id DESC", region, t - MOUNT_WINDOW_MS, t,
  );
  for (const r of rows) {
    try {
      if ((JSON.parse(r.mounted) as Array<{ id: string }>).some((m) => pageIds.includes(m.id))) return { topic: r.topic };
    } catch { /* 坏行跳过 */ }
  }
  return null;
}

/** 这个脑区在这一刻之前最近一次有内容的联想的话题（没内容的话和开关关着的不算） */
function lastTopic(db: Db, region: string, t: number): string | null {
  const r = one<{ topic: string }>(
    db, "SELECT topic FROM learn_assoc WHERE region = ? AND at < ? AND topic <> '' AND COALESCE(skipped, '') NOT IN ('lowinfo', 'off') ORDER BY at DESC, id DESC LIMIT 1", region, t,
  );
  return r?.topic ?? null;
}

/**
 * 一条教训在 day 又犯那一刻的分类（只读，什么都不写；classifyRecurrences 和夜里工作单共用）：
 * 找出处里的那一刻（momentOf），再看这个脑区在那一刻之前 6 小时内挂过这页没有（页的编号含别名）：挂过 mounted，没挂 unmounted；
 * topic 是出题用的话题（挂过的取那次挂载的，没挂过的取那一刻之前最近一次联想的），可能为空。
 * 出处对不上或中央记忆里没有 → unmounted、moment 和 topic 都是 null。day 不在这条的"犯的日子"里返回 null。
 */
export function classifyRecurrence(
  db: Db, page: Page, lesson: Lesson, day: string, tz: string,
): { kind: RecurKind; moment: Moment | null; topic: string | null } | null {
  const dayIndex = lesson.days.indexOf(day);
  if (dayIndex < 0) return null;
  const moment = momentOf(db, lesson.sources, dayIndex, day, tz);
  if (!moment) return { kind: "unmounted", moment: null, topic: null };
  const region = REGION.test(moment.src) ? moment.src : "main";
  const hit = lastMount(db, region, page.ids, moment.ts);
  return { kind: hit ? "mounted" : "unmounted", moment, topic: hit ? hit.topic : lastTopic(db, region, moment.ts) };
}

/**
 * 找"犯的日子"里有 day 的教训（活页里的，归档的不算），每条分成 mounted / unmounted 并出题（分类见 classifyRecurrence）。
 * 每条教训每天只记一次：这条的任何一个编号当天记过就跳过；返回的只有这次新记的。
 * 出处对不上或中央记忆里没有 → 记一笔 unmounted、不出题；没有话题可用 → 也不出题。
 * 题的 at 是又犯的那一刻，expect 是页编号。
 *
 * o.central 是约定好的入参，这里用不上：CentralMemory 没有按编号取一条的方法，出处直接查同一个库的 central 表。
 */
export function classifyRecurrences(
  db: Db, shelf: Shelf, day: string, o: { central: CentralMemory; tz: string },
): Array<{ lessonId: string; kind: RecurKind; caseId: number | null }> {
  const out: Array<{ lessonId: string; kind: RecurKind; caseId: number | null }> = [];
  if (!DAY_FORMAT.test(day)) return out;

  for (const page of shelf.pages) {
    if (page.archived || !page.ids.length) continue;
    for (const lesson of page.lessons) {
      if (!lesson.days.includes(day) || !lesson.ids.length) continue;
      // 并掉之前用旧编号记过的，也算记过
      const counted = one(db, `SELECT 1 FROM learn_recur WHERE day = ? AND lesson_id IN (${lesson.ids.map(() => "?").join(",")})`, day, ...lesson.ids);
      if (counted) continue;

      const { kind, moment: m, topic } = classifyRecurrence(db, page, lesson, day, o.tz)!;

      // 题和复发记录一起落：复发行已经有了（别的进程抢先）就连题一起撤回
      db.exec("BEGIN");
      try {
        const caseId = m && topic ? insertCase(db, m.ts, topic, page.ids[0]!, kind) : null;
        const r = db.prepare("INSERT OR IGNORE INTO learn_recur (lesson_id, day, seq, kind, case_id) VALUES (?, ?, ?, ?, ?)")
          .run(lesson.ids[0]!, day, m?.seq ?? null, kind, caseId);
        if (Number(r.changes) === 0) {
          db.exec("ROLLBACK");
          continue;
        }
        db.exec("COMMIT");
        out.push({ lessonId: lesson.ids[0]!, kind, caseId });
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }
  return out;
}

// ---------- 回测 ----------

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** 她的日子：按 tz 的日历日（和 decisions.ts 记花费的日子同一个写法；格式器按时区缓存，工作单一次要换算几千个时间） */
export function localDay(t: number, tz: string): string {
  let f = dayFormats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormats.set(tz, f);
  }
  return f.format(t);
}

/** 同一个话题、同一页（编号已换成现在的）算同一道题 */
const caseKey = (topic: string, expect: string): string => JSON.stringify([topic, expect]);

/** 这一晚最近一次回测有几道没判成（判断失败、向量算不出来）；表里只有判成了的，这个数记在 kv */
const skippedKey = (night: string): string => `learn.replay.skipped.${night}`;

/**
 * 这一晚回测的成绩：判成了的（同一道题——话题和页都一样——的几行只算一道）过了几道，加上最近一次跑时没判成几道；
 * 这一晚一道都没跑过返回 null
 */
export function replayScore(db: Db, night: string): { total: number; passed: number; skipped: number } | null {
  const rows = all<{ topic: string; expect: string; passed: number }>(
    db, "SELECT c.topic, c.expect, r.passed FROM learn_case_run r JOIN learn_case c ON c.id = r.case_id WHERE r.night = ? ORDER BY r.case_id", night,
  );
  const skipped = Number(kvGet(db, skippedKey(night))) || 0;
  if (!rows.length && !skipped) return null;
  const seen = new Map<string, boolean>();
  for (const r of rows) {
    const k = caseKey(r.topic, resolveId(db, r.expect));
    if (!seen.has(k)) seen.set(k, Number(r.passed) === 1);
  }
  return { total: seen.size, passed: [...seen.values()].filter(Boolean).length, skipped };
}

/** night 之前最近跑过回测的那一晚；没有返回 null */
export function previousNight(db: Db, night: string): string | null {
  return one<{ night: string | null }>(db, "SELECT MAX(night) AS night FROM learn_case_run WHERE night < ?", night)?.night ?? null;
}

/**
 * 回测：每道题用现在的封面重新联想一次（binding replay：每次都重新判、不去重、不记 learn_assoc），
 * 应该挂的页（expect 先按别名换成现在的编号）在挂上的页里就算过，结果按晚记进 learn_case_run。
 * - 同一个话题只判一次；话题和页都一样的几道题只算一道，几行记同一个结果
 * - 这一晚已经有结果的题不重判（表只增不改）：同一晚再跑只补新出的题，和已有的题一样的照抄那一道的结果
 * - 判断失败、话题向量算不出来（skipped judge / novec）的题这次不记、不算没过，数进 skipped（记在 kv），再跑时补上；
 *   开关关着（off）整次不算跑过，什么都不写
 * 一题一题按顺序判（夜里的预算）。total / passed 是这一晚判成了的成绩，skipped 是这次没判成几道，
 * prevPassed 是前一晚过了几道（没跑过是 null）。
 */
export async function runReplay(
  db: Db, notes: NoteAssociator, night: string,
): Promise<{ total: number; passed: number; skipped: number; prevPassed: number | null }> {
  const prev = previousNight(db, night);
  const prevPassed = prev ? replayScore(db, prev)?.passed ?? null : null;
  const done = new Map(all<{ case_id: number; passed: number }>(db, "SELECT case_id, passed FROM learn_case_run WHERE night = ?", night)
    .map((r) => [Number(r.case_id), Number(r.passed) === 1]));

  const groups = new Map<string, { topic: string; expect: string; ids: number[] }>();
  for (const c of all<{ id: number; topic: string; expect: string }>(db, "SELECT id, topic, expect FROM learn_case ORDER BY id")) {
    const expect = resolveId(db, c.expect);
    const k = caseKey(c.topic, expect);
    const g = groups.get(k) ?? { topic: c.topic, expect, ids: [] };
    g.ids.push(Number(c.id));
    groups.set(k, g);
  }

  const judged = new Map<string, AssocResult>();
  const ins = db.prepare("INSERT OR IGNORE INTO learn_case_run (night, case_id, passed) VALUES (?, ?, ?)");
  let skipped = 0;
  for (const g of groups.values()) {
    const todo = g.ids.filter((id) => !done.has(id));
    if (!todo.length) continue;
    const had = g.ids.find((id) => done.has(id));
    let passed: boolean;
    if (had !== undefined) {
      passed = done.get(had)!;
    } else {
      let r = judged.get(g.topic);
      if (!r) {
        r = await notes.associate(g.topic, { region: "replay", binding: "replay" });
        judged.set(g.topic, r);
      }
      if (r.skipped === "off") return { total: 0, passed: 0, skipped: 0, prevPassed };
      if (r.skipped === "judge" || r.skipped === "novec") {
        skipped += 1;
        continue;
      }
      passed = r.pages.some((p) => resolveId(db, p.id) === g.expect);
    }
    for (const id of todo) ins.run(night, id, passed ? 1 : 0);
  }
  kvSet(db, skippedKey(night), String(skipped));
  const s = replayScore(db, night);
  return { total: s?.total ?? 0, passed: s?.passed ?? 0, skipped, prevPassed };
}

// ---------- 接住了没有 ----------

/** 挂上之后多久内翻开算接住 */
const OPEN_WINDOW_MS = 3_600_000;
/** 不算"挂给她看"的绑定点：她自己找的、夜里回测的 */
export const NOT_MOUNTS: ReadonlySet<string> = new Set(["ask", "replay", "helper"]);

export interface AssocRow { at: number; binding: string | null; mounted: string; shadow: number; topic?: string | null }

/** 一次真挂上的一页：现在的编号、挂的话题、挂上之后 1 小时内她翻没翻 */
interface MountOutcome { at: number; id: string; topic: string | null; opened: boolean }

/**
 * 这些联想里真挂给她看的页（只算不挂的、她自己找的、回测的不算），每页挂上之后 1 小时内她翻没翻：
 * Read 了那一页、或者加载了那一本都算，哪个脑区翻的都算。挂的和翻的编号都先按别名换成现在的。按 rows 的顺序。
 */
function mountOutcomes(db: Db, shelf: Shelf, rows: AssocRow[]): MountOutcome[] {
  const shown = rows.filter((r) => Number(r.shadow) === 0 && !NOT_MOUNTS.has(r.binding ?? ""));
  if (!shown.length) return [];
  const bookOf = new Map<string, string>();
  for (const p of shelf.pages) for (const id of p.ids) bookOf.set(id, p.book);
  // 编号换成现在的：同一个编号只查一次（工作单一次过几万次挂载）
  const current = new Map<string, string>();
  const resolve = (id: string): string => {
    let r = current.get(id);
    if (r === undefined) current.set(id, (r = resolveId(db, id)));
    return r;
  };
  const lo = shown.reduce((m, r) => Math.min(m, Number(r.at)), Infinity);
  const hi = shown.reduce((m, r) => Math.max(m, Number(r.at)), -Infinity) + OPEN_WINDOW_MS;
  // 翻开的时间按页（p:编号）和本（b:本名）各存一份升序的，每次挂载二分找挂上之后第一次翻开
  const opens = new Map<string, number[]>();
  for (const o of all<{ at: number; page_id: string | null; book: string | null }>(db, "SELECT at, page_id, book FROM learn_open WHERE at >= ? AND at <= ? ORDER BY at", lo, hi)) {
    for (const key of [o.page_id === null ? null : `p:${resolve(o.page_id)}`, o.book === null ? null : `b:${o.book}`]) {
      if (key === null) continue;
      let ts = opens.get(key);
      if (!ts) opens.set(key, (ts = []));
      ts.push(Number(o.at));
    }
  }
  const openedWithin = (key: string, at: number): boolean => {
    const ts = opens.get(key);
    if (!ts) return false;
    let a = 0;
    let b = ts.length;
    while (a < b) {
      const mid = (a + b) >> 1;
      if (ts[mid]! < at) a = mid + 1;
      else b = mid;
    }
    return a < ts.length && ts[a]! <= at + OPEN_WINDOW_MS;
  };

  const out: MountOutcome[] = [];
  for (const r of shown) {
    let pages: Array<{ id: string }>;
    try { pages = JSON.parse(r.mounted) as Array<{ id: string }>; } catch { continue; }   // 坏行跳过
    const at = Number(r.at);
    for (const m of pages) {
      const id = resolve(m.id);
      const book = bookOf.get(m.id) ?? bookOf.get(id);
      out.push({ at, id, topic: r.topic ?? null, opened: openedWithin(`p:${id}`, at) || (book !== undefined && openedWithin(`b:${book}`, at)) });
    }
  }
  return out;
}

/** 挂了几页次、其中翻开了几页次（规则见 mountOutcomes） */
export function caught(db: Db, shelf: Shelf, rows: AssocRow[]): { mounts: number; opened: number } {
  const out = mountOutcomes(db, shelf, rows);
  return { mounts: out.length, opened: out.filter((o) => o.opened).length };
}

// ---------- 每周数字 ----------

export interface WeeklyNumbers {
  /** 这几天第一次见到的教训 */
  newLessons: number;
  /** 又犯：挂了还犯 / 没挂就犯 */
  recurMounted: number;
  recurUnmounted: number;
  /** 主人的纠正 */
  corrections: number;
  /** 真挂给她看的页次、其中 1 小时内翻开的、挂了没翻的 */
  mounts: number;
  opened: number;
  idleMounts: number;
  /** 待验证升级成靠谱：页里「## 做法」中 ✓ 日期落在这几天的条数 */
  promoted: number;
  /** 估时间的准头（实际 / 估的）；做完的事不到 3 件是 null */
  estimateRatio: number | null;
  /** 这几天里最近一晚的回测通过率；没跑过是 null */
  replayPassRate: number | null;
}

const DAY_MS = 86_400_000;
/** 一周：今天和之前 6 天（她的日子） */
const WEEK_DAYS = 7;

/** day 往后推 n 天（n 可以是负数） */
export function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 没归档的页的文件内容；读不了的页跳过，从几条路径都走得到的文件只给一次 */
function* pageTexts(root: string, pages: Iterable<Page>): Generator<[Page, string]> {
  const files = new Set<string>();
  for (const p of pages) {
    if (p.archived) continue;
    let text: string;
    try {
      const file = realpathSync(join(root, p.rel));
      if (files.has(file)) continue;
      files.add(file);
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    yield [p, text];
  }
}

/** 没归档的页文件里「## 做法」中 ✓ 日期落在 [from, to] 的条数；代码块里的不算 */
function promotedBetween(root: string, shelf: Shelf, from: string, to: string): number {
  let n = 0;
  for (const [, text] of pageTexts(root, shelf.pages)) {
    let section = "";
    let fence = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      if (line.startsWith("## ")) { section = line.slice(3).trim(); continue; }
      if (section !== B.forms.page.practice) continue;
      for (const m of line.matchAll(/✓\s*(\d{4}-\d{2}-\d{2})/g)) if (m[1]! >= from && m[1]! <= to) n += 1;
    }
  }
  return n;
}

/**
 * 最近 7 天（她的日子，今天和之前 6 天）的成长数字，都从记分表里算：
 * 新教训看 learn_item 第一次见到的时间；又犯看 learn_recur 的日子；纠正看 learn_correction；
 * 挂和翻见 caught；待验证升级数页里的 ✓ 日期；准头沿用 TaskBook.calibration（最近 10 件做完的事，不按周）；
 * 回测取这几天里最近一晚。只读，不发号、不写文件。
 *
 * o.central 是约定好的入参，这里用不上（同 classifyRecurrences）。
 */
export function weekly(db: Db, o: { now: number; tz: string; shelf: Shelf; central: CentralMemory; root: string }): WeeklyNumbers {
  const to = localDay(o.now, o.tz);
  const from = shiftDay(to, -(WEEK_DAYS - 1));
  // 时间戳先按 8 天粗筛，再按她的日子细筛（时区换算交给 Intl）
  const since = o.now - (WEEK_DAYS + 1) * DAY_MS;
  const inWeek = (t: number): boolean => t <= o.now && localDay(t, o.tz) >= from;
  const count = (sql: string): number => all<{ at: number }>(db, sql, since).filter((r) => inWeek(Number(r.at))).length;

  const recur = all<{ kind: string }>(db, "SELECT kind FROM learn_recur WHERE day >= ? AND day <= ?", from, to);
  const rows = all<AssocRow>(db, "SELECT at, binding, mounted, shadow FROM learn_assoc WHERE at >= ?", since).filter((r) => inWeek(Number(r.at)));
  const { mounts, opened } = caught(db, o.shelf, rows);
  const night = one<{ night: string | null }>(db, "SELECT MAX(night) AS night FROM learn_case_run WHERE night >= ? AND night <= ?", from, to)?.night ?? null;
  const score = night ? replayScore(db, night) : null;
  return {
    newLessons: count("SELECT first_seen AS at FROM learn_item WHERE kind = 'lesson' AND first_seen >= ?"),
    recurMounted: recur.filter((r) => r.kind === "mounted").length,
    recurUnmounted: recur.filter((r) => r.kind === "unmounted").length,
    corrections: count("SELECT at FROM learn_correction WHERE at >= ?"),
    mounts,
    opened,
    idleMounts: mounts - opened,
    promoted: promotedBetween(o.root, o.shelf, from, to),
    estimateRatio: new TaskBook(db).calibration()?.ratio ?? null,
    replayPassRate: score && score.total ? score.passed / score.total : null,
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** 每周数字写成几行（夜里写进 learn/weekly.md，周日的报告附上；hh learn week 也是这个） */
export function renderWeekly(w: WeeklyNumbers, owner: string): string {
  return [
    L.score.weeklyTitle,
    L.score.weeklyNewLessons(w.newLessons),
    L.score.weeklyRecur(w.recurMounted + w.recurUnmounted, w.recurMounted, w.recurUnmounted),
    L.weeklyCorrections(owner, w.corrections),
    L.score.weeklyCatchRate(w.mounts ? L.score.weeklyCatchValue(pct(w.opened / w.mounts), w.mounts, w.opened) : L.score.weeklyNoMounts),
    L.score.weeklyIdleMounts(w.idleMounts),
    L.score.weeklyPromoted(w.promoted),
    L.score.weeklyEstimate(w.estimateRatio === null ? L.score.weeklyEstimateTooFew : L.score.weeklyEstimateValue(w.estimateRatio)),
    L.score.weeklyReplay(w.replayPassRate === null ? L.score.weeklyReplayNeverRan : L.score.weeklyReplayValue(pct(w.replayPassRate))),
    "",
  ].join("\n");
}

// ---------- 夜里的工作单 ----------

/** 删减单、学会了看多少天：今天和之前 29 天 */
const WINDOW_DAYS = 30;
/** 挂了这么多次一次没翻，列进删减单 */
const IDLE_MOUNTS = 5;
/** 同一条教训犯了这么多天，该升级 */
const RECUR_DAYS = 3;
/** 页在窗口里这么多个不同的日子被挂过、这条没再犯，算学会了 */
const LEARNED_DAYS = 3;
/** 做成的事：做完之后这么久内被纠正过，不算做成 */
const CORRECTION_WINDOW_MS = 3 * 3_600_000;
/** 余弦到这个数算可能重复 */
const DUP_COS = 0.9;
/** 教训正文的向量一次算完（不在回复路径上），和封面向量批量重算同一个超时 */
const LESSON_EMBED_TIMEOUT_MS = 60_000;
/** 那条"到了"和收下这件事是同一刻写的，前后留几秒的空 */
const MET_SLACK_MS = 5_000;

/** YYYY-MM-DD，而且真有这一天（2026-02-30 不算） */
function validDay(s: string): boolean {
  if (!DAY_FORMAT.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 压成一行、太长的截断 */
const clip = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const pageRef = (c: Ctx, p: Page): string => L.score.pageRef(p.book, p.title, c.shelfDir, p.rel);
/** 教训在哪：页和编号（还没发号的教训没有编号） */
const lessonRef = (c: Ctx, p: Page, l: Lesson): string => L.score.lessonPageRef(p.book, p.title, c.shelfDir, p.rel, l.ids[0] ? L.score.lessonRefId(l.ids[0]) : "");
const lessonShort = (p: Page, l: Lesson): string => L.score.lessonBrief(clip(l.text), p.book, p.title, l.ids[0] ? L.score.lessonBriefId(l.ids[0]) : "");

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

interface Ctx {
  db: Db;
  shelf: Shelf;
  /** 整理的这一天 */
  day: string;
  tz: string;
  now: number;
  /** 书架上每个编号（含别名）对应的页；归档的页排在后面，同一个编号先给没归档的 */
  pageById: Map<string, Page>;
  /** 主人的名字（工作单里写到主人的那几句） */
  owner: string;
  /** 书架目录相对工作区的路径（工作单里页的路径用它做前缀） */
  shelfDir: string;
  /** 常驻单子的文件名，相对书架根目录 */
  residentFile: string;
}

const pageOf = (c: Ctx, id: string): Page | undefined => c.pageById.get(resolveId(c.db, id)) ?? c.pageById.get(id);

/** 她的日子 d1 到 d2 的时间戳先按 UTC 粗筛（时区差不到一天，前后放宽几天），再用 localDay 细筛；不超过现在 */
function span(c: Ctx, d1: string, d2: string): [number, number] {
  return [Date.parse(`${d1}T00:00:00Z`) - 2 * DAY_MS, Math.min(c.now, Date.parse(`${d2}T00:00:00Z`) + 3 * DAY_MS)];
}

/** 1. 今天挂了没翻的页：当天真挂的、1 小时内没人翻 */
function idleToday(c: Ctx, mounts: Array<MountOutcome & { day: string }>): string[] {
  const idle = new Map<Page | string, { id: string; n: number; topics: string[] }>();
  for (const m of mounts) {
    if (m.opened || m.day !== c.day) continue;
    const key = c.pageById.get(m.id) ?? m.id;
    const g = idle.get(key) ?? { id: m.id, n: 0, topics: [] };
    g.n += 1;
    const topic = clip(m.topic ?? "", 30);
    if (topic && !g.topics.includes(topic)) g.topics.push(topic);
    idle.set(key, g);
  }
  return [...idle].map(([key, g]) =>
    L.score.idleLine(typeof key === "string" ? L.score.idlePageMissing(key) : pageRef(c, key), g.n, g.topics.length ? L.score.idleTopics(g.topics.join(B.common.listSep)) : ""));
}

/**
 * 2. 今天又犯的：现场按书架里每条教训的"犯的日子"分类，只读（learn_recur 要等夜里整理完才记，整理时还是空的）。
 * 看这一天和前一天：前一天的日子可能是上一回工作单之后才补上的。没归档的页里每条教训，（教训，日子）只列一次；
 * 还没发号的教训、还没发号的页也算（新写的正是整理时才有）。每行写明是哪一天、出处和当时的话题。
 */
function recurToday(c: Ctx): { unmounted: string[]; mounted: string[] } {
  const out = { unmounted: [] as string[], mounted: [] as string[] };
  const seen = new Set<string>();
  for (const day of [shiftDay(c.day, -1), c.day]) {
    for (const page of c.shelf.pages) {
      if (page.archived) continue;
      for (const lesson of page.lessons) {
        const key = `${lesson.ids[0] ?? `${page.rel}#${lesson.line}`}|${day}`;
        if (seen.has(key)) continue;
        const r = classifyRecurrence(c.db, page, lesson, day, c.tz);
        if (!r) continue;
        seen.add(key);
        const tail = L.score.recurTail(day, r.moment ? L.score.recurSource(r.moment.seq) : "", r.topic ? L.score.recurTopic(clip(r.topic, 40)) : "");
        (r.kind === "mounted" ? out.mounted : out.unmounted).push(L.score.recurLine(clip(lesson.text), lessonRef(c, page, lesson), tail));
      }
    }
  }
  return out;
}

/** 往前看几天的纠正有没有落到笔记上 */
const UNFILED_DAYS = 3;
/**
 * 前几天的纠正里，消息编号（#N）在书架哪一页都找不到的：还没落到一条教训或一页做法上（11-12：两周 54 次纠正，教训出处里对得上的只有 7 次）。
 * 整理那一步要么把它写进对的那一页（出处带上 #N），要么在报告里说这条为什么不记
 */
function correctionsUnfiled(c: Ctx, root: string): string[] {
  const from = shiftDay(c.day, -UNFILED_DAYS);
  const [lo, hi] = span(c, from, c.day);   // 粗筛，下面按她的日子细筛：前 UNFILED_DAYS 天，不含今天
  const rows = all<{ at: number; seq: number | null; topic: string | null }>(
    c.db, "SELECT at, seq, topic FROM learn_correction WHERE at >= ? AND at <= ? AND seq IS NOT NULL ORDER BY at, id", lo, hi)
    .filter((r) => { const d = localDay(Number(r.at), c.tz); return d >= from && d < c.day; });
  if (!rows.length) return [];
  const cited = new Set<number>();
  for (const p of c.shelf.pages) {
    let text: string;
    try { text = readFileSync(join(root, p.rel), "utf8"); } catch { continue; }
    for (const m of text.matchAll(/#(\d{3,})/g)) cited.add(Number(m[1]));
  }
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return rows.filter((r) => !cited.has(Number(r.seq))).map((r) => {
    const t = fmt.formatToParts(Number(r.at)).reduce<Record<string, string>>((a, x) => ({ ...a, [x.type]: x.value }), {});
    return L.score.unfiledLine(t["month"], t["day"], t["hour"], t["minute"], r.seq, clip(r.topic ?? "", 60) || L.score.unfiledNoTopic);
  });
}

/** 3. 今天主人的纠正：带消息编号，让她挂到教训的出处上 */
function correctionsToday(c: Ctx): string[] {
  const [lo, hi] = span(c, c.day, c.day);
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: c.tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return all<{ at: number; seq: number | null; topic: string | null; task_id: number | null }>(
    c.db, "SELECT at, seq, topic, task_id FROM learn_correction WHERE at >= ? AND at <= ? ORDER BY at, id", lo, hi,
  ).filter((r) => localDay(Number(r.at), c.tz) === c.day).map((r) =>
    L.score.correctionLine(hhmm.format(Number(r.at)), r.seq !== null ? ` #${r.seq}` : L.score.correctionNoSeq, clip(r.topic ?? "", 60) || L.score.correctionNoTopic, r.task_id !== null ? L.score.correctionTask(r.task_id) : ""));
}

/**
 * 4. 做成的事：当天做完（state done）、最后一次回头看到了、做完之后 3 小时内没被纠正。
 * tasks 里 looks 只数没到的次数、missing 到了以后也不清，认不出最后一次到了没有；
 * 回头看到了时 brain 会用 P.lookedMet 给这个脑区记一条（不带事的编号），紧接着同一刻收下这件事，所以只认 ended 前后几秒里的那一条：
 * 一个脑区可以同时有几件事，别的事在这件开头到做完之间的"到了"不能算给这件
 * （额度紧没另开会话看、看的会话没给结论就直接收下的，没有这一条，不算）。
 * 纠正：有一条纠正挂在这件事上（做的时候、做完以后，什么时候都算），或者做完之后 3 小时内有任何纠正，都不算。
 */
function doneToday(c: Ctx): string[] {
  const [lo, hi] = span(c, c.day, c.day);
  const rows = all<{ id: number; topic: string; owner: string; started: number; ended: number; pages: string | null }>(
    c.db, "SELECT id, topic, owner, started, ended, pages FROM tasks WHERE state = 'done' AND ended >= ? AND ended <= ? ORDER BY ended, id", lo, hi,
  ).filter((t) => localDay(Number(t.ended), c.tz) === c.day);
  const out: string[] = [];
  for (const t of rows) {
    const ended = Number(t.ended);
    const met = one(c.db, "SELECT 1 FROM central WHERE src = ? AND kind = 'note' AND ts >= ? AND ts <= ? AND substr(text, 1, ?) = ?",
      t.owner, Math.max(Number(t.started), ended - MET_SLACK_MS), ended + MET_SLACK_MS, P.lookedMet("").length, P.lookedMet(""));
    if (!met) continue;
    if (one(c.db, "SELECT 1 FROM learn_correction WHERE task_id = ? OR (at >= ? AND at <= ?)", t.id, ended, ended + CORRECTION_WINDOW_MS)) continue;
    let ids: string[] = [];
    try { ids = t.pages ? JSON.parse(t.pages) as string[] : []; } catch { ids = []; }
    const titles = ids.map((id) => pageOf(c, id)?.title ?? id);
    out.push(L.score.doneLine(t.topic, t.id, titles.length ? L.score.donePages(titles.join(L.score.doneTitleSeparator)) : L.score.doneNoPages));
  }
  return out;
}

/**
 * 开始做时提过、没翻就做完了（做生成任务前，以前做过类似的都要先翻笔记；联想只给大概、不一定准）：
 * 这一天做完（或放下）的事里，开始做（on_it）时真挂给她看过页（教训已经整句贴在眼前的强教训页不算；上一件事带过来的不算），
 * 从开始前 10 分钟到结束这个脑区一页笔记都没翻、一本都没加载的。翻了哪页都算翻过（联想挑的不一定对，她自己找的常更对路）。
 * 和说做完时问的那一句（brain 的 beforeDoneCheck）是同一个口径：改一边要改另一边
 */
type Mounted = { id: string; strong?: boolean; carry?: boolean; hits?: unknown; loud?: unknown };
/** 这一页的教训当时是不是整句贴在「老毛病」那块：有 loud 就看 loud（封顶以后没再贴的强教训页不算贴过）；老的行没有 loud，看 strong 且有 hits */
const pastedLoud = (m: Mounted): boolean => (Array.isArray(m.loud) ? m.loud.length > 0 : m.strong === true && Array.isArray(m.hits) && m.hits.length > 0);
/** 先读了那页才说开始做的：开始前这么久之内翻的也算翻过 */
const READ_BEFORE_MS = 10 * 60_000;
function unreadDone(c: Ctx): string[] {
  const [lo, hi] = span(c, c.day, c.day);
  const tasks = all<{ id: number; topic: string; owner: string; started: number; ended: number }>(
    c.db, "SELECT id, topic, owner, started, ended FROM tasks WHERE state IN ('done', 'dropped') AND ended >= ? AND ended <= ? ORDER BY ended, id", lo, hi,
  ).filter((t) => localDay(Number(t.ended), c.tz) === c.day);
  let suggested = 0;
  const out: string[] = [];
  for (const t of tasks) {
    const ids = [...new Set(all<{ mounted: string }>(c.db, "SELECT mounted FROM learn_assoc WHERE binding = 'on_it' AND task_id = ? AND shadow = 0 AND mounted != '[]'", t.id)
      .flatMap((r) => { try { return (JSON.parse(r.mounted) as Mounted[]).filter((m) => m.carry !== true && !pastedLoud(m)).map((m) => m.id); } catch { return []; } }))];
    if (!ids.length) continue;
    suggested += 1;
    if (one(c.db, "SELECT 1 FROM learn_open WHERE region = ? AND at >= ? AND at <= ?", t.owner, Number(t.started) - READ_BEFORE_MS, Number(t.ended))) continue;
    out.push(L.score.unreadLine(t.topic, t.id, ids.map((id) => L.score.unreadPageTitle(pageOf(c, id)?.title ?? id)).join("")));
  }
  return out.length ? [L.score.unreadSummary(suggested, out.length), ...out] : [];
}

/** 5. 同一条犯了 3 天以上（没归档的页里；合法的日子，同一天算一次） */
function recurLong(c: Ctx): string[] {
  const out: string[] = [];
  for (const p of c.shelf.pages) {
    if (p.archived) continue;
    for (const l of p.lessons) {
      const days = [...new Set(l.days.filter(validDay))].sort();
      if (days.length >= RECUR_DAYS) out.push(L.score.recurLongLine(clip(l.text), lessonRef(c, p, l), days.length, days.join(L.score.recurDaysSeparator)));
    }
  }
  return out;
}

/**
 * 强度的升降建议（11-03）：按参数算——
 * 窗口（strength.windowDays）里犯了 residentDays 天 → 5、strongDays 天 → 至少 4；4 级以上 calmDays 天没犯 → 降一级（不低于 3）。
 * 常驻着（强度 5 或在常驻单子里）这一天还犯了的，提机制；强度 5 没进单子的、单子里很久没犯的，列出来让她换。
 * 只是建议：她夜里审过才写回那一行的「强度」
 */
function strengthList(c: Ctx, root: string): string[] {
  const window = param(c.db, "strength.windowDays");
  const strongDays = param(c.db, "strength.strongDays");
  const residentDays = param(c.db, "strength.residentDays");
  const calmDays = param(c.db, "strength.calmDays");
  const max = param(c.db, "strength.residentMax");
  let mine: string | null = null;
  try { mine = readFileSync(join(root, c.residentFile), "utf8"); } catch { mine = null; }
  // 常驻不常驻按前缀里真放的那几条算（renderResident 同一套）
  const listed = residentIds(mine, c.shelf, max);
  const yesterday = shiftDay(c.day, -1);
  const ago = (d: string): number => Math.round((Date.parse(`${c.day}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000);
  const out: string[] = [];
  const notListed: string[] = [];
  const stale: string[] = [];
  for (const p of c.shelf.pages) {
    if (p.archived) continue;
    for (const l of p.lessons) {
      const days = [...new Set(l.days.filter(validDay))].filter((d) => d <= c.day).sort();
      const recent = days.filter((d) => ago(d) < window);
      const cur = l.strength ?? 3;
      const quiet = days.length ? ago(days.at(-1)!) : Infinity;
      const sug = recent.length >= residentDays ? 5 : recent.length >= strongDays ? Math.max(cur, 4) : cur >= 4 && quiet >= calmDays ? Math.max(3, cur - 1) : cur;
      const who = L.score.strengthWho(clip(l.text), lessonRef(c, p, l));
      const id = l.ids[0];
      const resident = id !== undefined && listed.has(id);
      if (resident && (days.at(-1) === c.day || days.at(-1) === yesterday)) {
        out.push(L.residentStillRecurs(who, c.owner));
      } else if (sug !== cur) {
        const why = sug > cur ? L.score.strengthRaiseReason(window, recent.length, recent.map((d) => d.slice(5)).join(L.score.strengthDaysSeparator)) : L.score.strengthCalmReason(Number.isFinite(quiet) ? quiet : L.score.strengthAlways);
        out.push(L.score.strengthChange(who, cur, sug, why));
      }
      if (Math.max(cur, sug) >= 5 && id !== undefined && !listed.has(id) && quiet < calmDays) notListed.push(L.score.unlistedLesson(clip(l.text, 30), id));
      if (id !== undefined && listed.has(id) && quiet >= calmDays) stale.push(L.score.staleLesson(clip(l.text, 30), id, Number.isFinite(quiet) ? L.score.staleQuietDays(quiet) : L.score.staleNoDays));
    }
  }
  if (notListed.length) out.push(L.score.strengthUnlisted(notListed.join(B.common.listSep)));
  if (stale.length) out.push(L.score.strengthStale(stale.join(B.common.listSep)));
  if (!out.length) return [];
  return [L.score.strengthParams(window, strongDays, residentDays, calmDays, max), ...out];
}

/** 「### 待验证」下每一条（最外一层，连同它的子条目）的第一行文字和里面最晚的日期；没写日期的 date 是 null */
function pendingItems(text: string): Array<{ text: string; date: string | null }> {
  const rows: string[] = [];
  let section = "";
  let sub = "";
  let fence = false;
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (line.startsWith("## ")) { section = line.slice(3).trim(); sub = ""; continue; }
    if (line.startsWith("### ")) { sub = line.slice(4).trim(); continue; }
    if (section === B.forms.page.practice && sub === B.forms.page.pending) rows.push(line);
  }
  const outer = Math.min(...rows.map((r) => LIST_ITEM.exec(r)?.[1]!.length ?? Infinity));
  const groups: string[][] = [];
  for (const r of rows) {
    if (LIST_ITEM.exec(r)?.[1]!.length === outer) groups.push([r]);
    else groups.at(-1)?.push(r);
  }
  return groups.map((g) => {
    const dates = [...g.join("\n").matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]).filter(validDay).sort();
    return { text: clip(g[0]!.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")), date: dates.at(-1) ?? null };
  });
}

/** 6. 删减和降级：只列单子，由她定；四小节，没有内容的不列 */
function pruneList(c: Ctx, mounts: Array<MountOutcome & { day: string }>, root: string): string[] {
  const from = shiftDay(c.day, -(WINDOW_DAYS - 1));
  const inWindow = (d: string): boolean => d >= from && d <= c.day;
  const live = c.shelf.pages.filter((p) => !p.archived && p.ids.length > 0);
  /** 这页 / 这条教训（任何一个编号）最早什么时候在书架上见到；没有记录是 null */
  const firstSeen = (kind: "page" | "lesson", ids: string[]): number | null => {
    const t = ids.length ? one<{ t: number | null }>(c.db, `SELECT MIN(first_seen) AS t FROM learn_item WHERE kind = ? AND id IN (${ids.map(() => "?").join(",")})`, kind, ...ids)?.t : null;
    return t === null || t === undefined ? null : Number(t);
  };

  // 每页的挂和翻（挂 = 真挂给她看的）
  const stats = new Map<Page, { mounts: number; opened: number; days: Set<string> }>();
  for (const m of mounts) {
    const p = c.pageById.get(m.id);
    if (!p) continue;
    const s = stats.get(p) ?? { mounts: 0, opened: 0, days: new Set<string>() };
    s.mounts += 1;
    if (m.opened) s.opened += 1;
    s.days.add(m.day);
    stats.set(p, s);
  }
  const mountDays = (p: Page): string[] => [...(stats.get(p)?.days ?? [])].filter(inWindow);

  const idle = live.filter((p) => (stats.get(p)?.mounts ?? 0) >= IDLE_MOUNTS && stats.get(p)!.opened === 0)
    .map((p) => L.score.pruneIdleLine(pageRef(c, p), stats.get(p)!.mounts));

  // 窗口里翻开过的页和本（页编号、加载整本都算翻，和接住了没有同一个口径）
  const [lo, hi] = span(c, from, c.day);
  const opens = all<{ at: number; page_id: string | null; book: string | null }>(c.db, "SELECT at, page_id, book FROM learn_open WHERE at >= ? AND at <= ?", lo, hi)
    .filter((o) => inWindow(localDay(Number(o.at), c.tz)));
  const openedPages = new Set(opens.flatMap((o) => (o.page_id === null ? [] : [resolveId(c.db, o.page_id)])));
  const openedBooks = new Set(opens.flatMap((o) => (o.book === null ? [] : [o.book])));
  // 在书架上还没满窗口的页（或者不知道什么时候来的）不算冷
  const cold = live.filter((p) => {
    const t = firstSeen("page", p.ids);
    return t !== null && localDay(t, c.tz) < from && !mountDays(p).length && !p.ids.some((id) => openedPages.has(id)) && !openedBooks.has(p.book);
  }).map((p) => `- ${pageRef(c, p)}`);

  // 待验证里日期早于窗口、这页在窗口里没被挂过的条目（没写日期的不知道多久了，不列）
  const stale: string[] = [];
  for (const [p, text] of pageTexts(root, live.filter((x) => !mountDays(x).length))) {
    for (const it of pendingItems(text)) if (it.date !== null && it.date < from) stale.push(L.score.prunePendingLine(pageRef(c, p), it.text, it.date));
  }

  // 学会了：这页在窗口里 ≥3 个不同的日子被挂（只数这条教训已经在书架上之后的日子），这条在窗口里没有犯的日子
  const learned: string[] = [];
  for (const p of live) {
    for (const l of p.lessons) {
      const t = firstSeen("lesson", l.ids);
      if (t === null || !l.text || l.days.some((d) => validDay(d) && inWindow(d))) continue;
      const born = localDay(t, c.tz);
      const n = mountDays(p).filter((d) => d >= born).length;
      if (n >= LEARNED_DAYS) learned.push(L.score.pruneLearnedLine(clip(l.text), lessonRef(c, p, l), WINDOW_DAYS, n));
    }
  }

  const groups: Array<[string, string[]]> = [
    [L.score.pruneIdleTitle(IDLE_MOUNTS), idle],
    [L.score.pruneColdTitle(WINDOW_DAYS), cold],
    [L.score.prunePendingTitle(WINDOW_DAYS), stale],
    [L.score.pruneLearnedTitle, learned],
  ];
  return groups.flatMap(([title, lines]) => (lines.length ? [`### ${title}`, ...lines] : []));
}

/** 7. 可能重复的：封面向量相近的页对；教训正文相近的教训对（当场一次请求算完全部教训，算不了写明白） */
async function duplicates(c: Ctx, embedder: Embedder | null): Promise<string[]> {
  const out: string[] = [];
  // 页：只看没归档、存了封面向量的
  const vecs = new Map<string, Float32Array>();
  for (const r of all<{ page_id: string; vec: Uint8Array }>(c.db, "SELECT page_id, vec FROM learn_cover")) {
    if (r.vec.byteLength === EMBED_DIMS * 4) vecs.set(r.page_id, new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)));
  }
  const pages = c.shelf.pages.filter((p) => !p.archived && p.ids[0] !== undefined && vecs.has(p.ids[0]));
  const pairs: Array<{ line: string; cos: number }> = [];
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const cos = cosine(vecs.get(pages[i]!.ids[0]!)!, vecs.get(pages[j]!.ids[0]!)!);
      if (cos >= DUP_COS) pairs.push({ cos, line: L.score.dupPages(pageRef(c, pages[i]!), pageRef(c, pages[j]!), cos.toFixed(2)) });
    }
  }
  out.push(...pairs.sort((a, b) => b.cos - a.cos).map((x) => x.line));

  // 教训：不到两条没有可比的
  const lessons = c.shelf.pages.filter((p) => !p.archived).flatMap((p) => p.lessons.filter((l) => l.text).map((l) => ({ p, l })));
  if (lessons.length < 2) return out;
  let lv: Float32Array[] | null = null;
  try { lv = embedder ? await embedder.embed(lessons.map((x) => x.l.text), { timeoutMs: LESSON_EMBED_TIMEOUT_MS }) : null; } catch { lv = null; }
  if (!lv || lv.length !== lessons.length) return [...out, L.score.dupLessonsUnavailable];
  const dup: Array<{ line: string; cos: number }> = [];
  for (let i = 0; i < lessons.length; i++) {
    for (let j = i + 1; j < lessons.length; j++) {
      const cos = cosine(lv[i]!, lv[j]!);
      if (cos >= DUP_COS) dup.push({ cos, line: L.score.dupLessons(lessonShort(lessons[i]!.p, lessons[i]!.l), lessonShort(lessons[j]!.p, lessons[j]!.l), cos.toFixed(2)) });
    }
  }
  return [...out, ...dup.sort((a, b) => b.cos - a.cos).map((x) => x.line)];
}

/**
 * 夜里整理 day 这一天时给她的学习工作单（海马的 learn_worklist）：十节，标题固定，没有内容的节写（没有）。
 * 只读：不发号、不写表、不写文件。day 是她的日子（按 tz 的日历日）；root 是书架目录，读页里「待验证」的条目用。
 * 教训向量当场算，embedder 没有或算不出来时那一半写（今晚算不了），其余照常。
 * o.owner 是主人的名字，o.shelfDir 是书架目录相对工作区的路径（页的路径前缀），o.residentFile 是常驻单子的文件名（相对 root）。
 */
export async function worklist(
  db: Db, shelf: Shelf, day: string, o: { now: number; tz: string; embedder: Embedder | null; root: string; owner: string; shelfDir: string; residentFile: string },
): Promise<string> {
  if (!validDay(day)) throw new Error(L.score.badDay);
  // 编号 → 页：没归档的先放，同一个编号归档的不覆盖它
  const pageById = new Map<string, Page>();
  for (const page of [...shelf.pages].sort((a, b) => Number(a.archived) - Number(b.archived))) {
    for (const id of page.ids) if (!pageById.has(id)) pageById.set(id, page);
  }
  const c: Ctx = { db, shelf, day, tz: o.tz, now: o.now, pageById, owner: o.owner, shelfDir: o.shelfDir, residentFile: o.residentFile };

  // 到这一天为止所有真挂上的页（删减单要看历史），每次挂的那天也算好
  const [, upTo] = span(c, day, day);
  const rows = all<AssocRow>(db, "SELECT at, binding, topic, mounted, shadow FROM learn_assoc WHERE at <= ? ORDER BY at, id", upTo)
    .filter((r) => localDay(Number(r.at), o.tz) <= day);
  const mounts = mountOutcomes(db, shelf, rows).map((m) => ({ ...m, day: localDay(m.at, o.tz) }));

  const out = [L.score.worklistTitle(day)];
  const add = (title: string, lines: string[]): void => { out.push("", `## ${title}`, ...(lines.length ? lines : [L.score.none])); };
  add(L.score.titleIdleToday, idleToday(c, mounts));
  add(L.score.titleUnreadDone, unreadDone(c));
  const recur = recurToday(c);
  add(L.score.titleRecurUnmounted, recur.unmounted);
  add(L.score.titleRecurMounted, recur.mounted);
  add(L.worklistCorrectionsTitle(c.owner), [...correctionsToday(c), ...correctionsUnfiled(c, o.root)]);
  add(L.score.titleDone, doneToday(c));
  add(L.score.titleRecurLong, recurLong(c));
  add(L.score.titleStrength, strengthList(c, o.root));
  add(L.score.titlePrune, pruneList(c, mounts, o.root));
  add(L.score.titleDuplicates, await duplicates(c, o.embedder));
  return `${out.join("\n")}\n`;
}
