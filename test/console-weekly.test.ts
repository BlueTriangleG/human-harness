// 控制台「这一周」那张表：/api/numbers 把 numbers() 的五个数（库和日志）和按文件接着读的用量当量拼在一起。口径在 src/metrics/ 下，那边各有测试。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { lutimesSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { createConsole } from "../src/console/server.ts";
import { weeklyView } from "../src/console/weekly.ts";
import type { WeeklyView } from "../src/console/weekly.ts";
import { projectDirOf } from "../src/metrics/numbers.ts";
import { UsageScanner } from "../src/metrics/usage.ts";
import { openDb } from "../src/store/db.ts";
import { LANG_COOKIE } from "../src/console/lang/index.ts";
import { consoleSource } from "./console-web.ts";
import { tmpDir } from "./tmp.ts";
import { OPEN_READS } from "./console-reads.ts";

const TZ = "Australia/Melbourne";
const NOW = Date.UTC(2026, 10, 12, 10, 0);          // 枫湾 11-12 21:00
const L = (d: number, h: number, mi = 0): number => Date.UTC(2026, 10, d, h - 11, mi);
const DIRS = { workspace: "/demo/ws", replay: ["/demo/state/replay"] };
const iso = (t: number): string => new Date(t).toISOString();

function fixture(): { root: string; dbPath: string; logPath: string; projectsDir: string } {
  const root = tmpDir("hh-console-weekly-");
  const dbPath = join(root, "hh.db");
  const db = openDb(dbPath);
  db.prepare("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('l:1', '2026-11-11', 'mounted'), ('l:2', '2026-11-11', 'mounted'), ('l:1', '2026-11-03', 'mounted')").run();
  db.prepare("INSERT INTO learn_correction (at, p) VALUES (?, 0.9), (?, 0.8)").run(L(12, 9), L(4, 9));
  db.close();
  const logPath = join(root, "logs", "hh.jsonl");
  mkdirSync(dirname(logPath), { recursive: true });
  const log = (t: number, msg: string, extra: Record<string, unknown>): string => JSON.stringify({ t: iso(t), level: "info", mod: "hhd", msg, ...extra });
  writeFileSync(logPath, [
    log(L(12, 9), "main wake", { cause: "human" }), log(L(12, 10), "main wake", { cause: "focus" }), log(L(12, 11), "main wake", { cause: "human" }),
    log(L(11, 8), "quota reading", { sevenDay: { used: 30, resetsAt: 1 } }), log(L(12, 8), "quota reading", { sevenDay: { used: 42, resetsAt: 1 } }),
    log(L(3, 9), "main wake", { cause: "gate" }),
  ].join("\n") + "\n");
  const projectsDir = join(root, "projects");
  const put = (rel: string, rows: Array<[number, string, Record<string, number>]>): void => {
    const p = join(projectsDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, rows.map(([t, id, usage]) => JSON.stringify({ type: "assistant", timestamp: iso(t), requestId: `req-${id}`, message: { id, usage } }) + "\n").join(""));
    utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
  };
  put(`${projectDirOf(DIRS.workspace)}/s.jsonl`, [[L(12, 9), "m1", { input_tokens: 2_000_000 }], [L(4, 9), "m0", { output_tokens: 200_000 }]]);
  put("-demo-helpers-picnic/h.jsonl", [[L(12, 12), "h1", { input_tokens: 500_000 }]]);
  return { root, dbPath, logPath, projectsDir };
}
const day = (v: WeeklyView, d: string) => [...v.days, ...v.prev].find((x) => x.day === d)!;

test("console weekly: seven days and the seven before from numbers(); usage stays empty until the session files have been read, then follows the tally", async () => {
  const f = fixture();
  const db = openDb(f.dbPath);
  try {
    const o = { logPath: f.logPath, tz: TZ, dirs: DIRS };
    const usage = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ });
    const before = weeklyView(db, o, usage, NOW);
    assert.deepEqual([before.tz, before.today, before.days.length, before.prev.length], [TZ, "2026-11-12", 7, 7]);
    assert.deepEqual([before.days[0]!.day, before.days[6]!.day, before.prev[0]!.day, before.prev[6]!.day], ["2026-11-06", "2026-11-12", "2026-10-30", "2026-11-05"]);
    assert.deepEqual(before.usage, { ready: false, at: null, reading: null, unread: null });
    assert.deepEqual(day(before, "2026-11-12").usage, { hh: 0, helpers: 0, team: 0, replay: 0, other: 0 });
    // 库和日志那几样不等用量
    assert.deepEqual([day(before, "2026-11-11").recur, day(before, "2026-11-03").recur, day(before, "2026-11-12").corrections, day(before, "2026-11-04").corrections], [2, 1, 1, 1]);
    assert.deepEqual([day(before, "2026-11-12").wakes, day(before, "2026-11-12").wakeCauses, day(before, "2026-11-03").wakes], [3, { human: 2, focus: 1 }, 1]);
    assert.equal(day(before, "2026-11-12").quotaPct, 12);
    await usage.scan(NOW);
    const after = weeklyView(db, o, usage, NOW);
    assert.deepEqual(after.usage, { ready: true, at: NOW, reading: null, unread: null });
    assert.deepEqual(day(after, "2026-11-12").usage, { hh: 2, helpers: 0.5, team: 0, replay: 0, other: 0 });
    assert.deepEqual(day(after, "2026-11-04").usage, { hh: 1, helpers: 0, team: 0, replay: 0, other: 0 });
    // 没配会话记录目录：五个数照出，用量一直空着；没有库、没有日志也不报错
    const none = weeklyView(null, { ...o, logPath: join(f.root, "none.jsonl") }, null, NOW);
    assert.deepEqual([none.days.length, none.usage.ready, none.days[6]!.wakes, none.days[6]!.recur], [7, false, 0, 0]);
  } finally { db.close(); }
});

test("console weekly: archived records that cannot be read are reported with the day up to which usage may be short, and the page marks those rows", async () => {
  const f = fixture();
  // 一个归档走的工作目录：链接留着，它指的那个盘没挂上；链接是 11-10 中午放的
  const link = join(f.projectsDir, "-demo-helpers-archived");
  symlinkSync(join(f.root, "not-mounted", "x"), link);
  lutimesSync(link, new Date(L(10, 12)), new Date(L(10, 12)));
  const usage = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ });
  await usage.scan(NOW);
  const v = weeklyView(null, { logPath: f.logPath, tz: TZ, dirs: DIRS }, usage, NOW);
  assert.deepEqual(v.usage.unread, { links: 1, upTo: "2026-11-10" });
  assert.deepEqual(day(v, "2026-11-12").usage, { hh: 2, helpers: 0.5, team: 0, replay: 0, other: 0 }, "读得到的照常");
  // 页面：那一天和更早的行（连同带着它们的合计行）标「记录不全」，表下面写明是读不到、不是真的少
  const src = consoleSource();
  assert.match(src, /const partial = \(rows\) => !!unread && rows\.some\(\(d\) => d\.day <= unread\.upTo\);/);
  assert.match(src, /if \(o\.partial\) \{ const tag = el\("span", "wpart", T\("health\.week\.usagePartial"\)\);/);
  assert.match(src, /if \(unread\) nodes\.push\(el\("p", "hint wwarn", T\("health\.week\.usageUnread", \{ n: unread\.links, day: hmd\(unread\.upTo\) \}\)\)\);/);
});

test("console weekly: work the team runs under its own folder shows as team, apart from her own usage; the page lists it between helpers and replays", async () => {
  const f = fixture();
  const TEAM = "/srv/hh-team";
  const p = join(f.projectsDir, projectDirOf(TEAM + "/tuning"), "t.jsonl");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify({ type: "assistant", timestamp: iso(L(12, 15)), requestId: "req-t1", message: { id: "t1", usage: { input_tokens: 3_000_000 } } }) + "\n");
  utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
  const dirs = { ...DIRS, team: [TEAM] };
  const usage = new UsageScanner({ projectsDir: f.projectsDir, dirs, tz: TZ });
  await usage.scan(NOW);
  const v = weeklyView(null, { logPath: f.logPath, tz: TZ, dirs }, usage, NOW);
  assert.deepEqual(day(v, "2026-11-12").usage, { hh: 2, helpers: 0.5, team: 3, replay: 0, other: 0 });
  // 没配团队目录的控制台：同一份记录算在帮手里（和以前一样）
  const plain = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ });
  await plain.scan(NOW);
  assert.deepEqual(day(weeklyView(null, { logPath: f.logPath, tz: TZ, dirs: DIRS }, plain, NOW), "2026-11-12").usage, { hh: 2, helpers: 3.5, team: 0, replay: 0, other: 0 });
  // 页面：合计和下面那行小字都按这个名单走，团队排在帮手后面；服务端没给的那一类当 0
  const src = consoleSource();
  assert.match(src, /const WDESTS = \["hh", "helpers", "team", "replay", "other"\];/);
  assert.match(src, /for \(const k of WDESTS\) usage\[k\] = wsum\(rows, \(r\) => r\.usage\[k\] \|\| 0\);/);
  assert.match(src, /const total = WDESTS\.reduce\(\(n, k\) => n \+ \(r\.usage\[k\] \|\| 0\), 0\);/);
});

async function withServer(f: ReturnType<typeof fixture> | null, fn: (get: (path: string, cookie?: string) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>): Promise<void> {
  const dir = tmpDir("hh-console-weekly-srv-");
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f?.dbPath ?? join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "projects"), logPath: f?.logPath ?? join(dir, "hh.jsonl"),
    pageHtml: "<!doctype html><title>t</title>", now: () => NOW,
    ...(f ? { numbers: { projectsDir: f.projectsDir, workspace: DIRS.workspace, replay: DIRS.replay, tz: TZ } } : {}),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(async (path, cookie) => { const r = await fetch(base + path, cookie ? { headers: { cookie } } : {}); return { status: r.status, body: await r.json() as Record<string, unknown> }; });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("console weekly: /api/numbers answers at once and fills usage in when the background read is done; without the option it says so", async () => {
  await withServer(fixture(), async (get) => {
    let r = await get("/api/numbers");
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.body).sort(), ["days", "prev", "today", "tz", "usage"]);
    assert.equal((r.body.days as unknown[]).length, 7);
    // 第一次问的时候用量多半还没读完；再问几次就有了（文件很小）
    for (let i = 0; i < 50 && !(r.body.usage as { ready: boolean }).ready; i++) { await new Promise((ok) => setTimeout(ok, 20)); r = await get("/api/numbers"); }
    assert.equal((r.body.usage as { ready: boolean }).ready, true);
    const days = r.body.days as Array<{ day: string; wakes: number; usage: { hh: number; helpers: number } }>;
    assert.deepEqual([days[6]!.day, days[6]!.wakes, days[6]!.usage.hh, days[6]!.usage.helpers], ["2026-11-12", 3, 2, 0.5]);
  });
  await withServer(null, async (get) => {
    assert.deepEqual([(await get("/api/numbers")).status, (await get("/api/numbers")).body.error], [404, "没配「这一周」要读的会话记录目录"]);
    assert.equal((await get("/api/numbers", `${LANG_COOKIE}=en`)).body.error, "The session-file directory for the weekly table is not configured");
  });
});

test("console weekly: the health tab has the two views, and the weekly one asks only its endpoint", () => {
  const src = consoleSource();
  assert.match(src, /<button data-hview="day" aria-pressed="true">最近 24 小时<\/button>\s*<button data-hview="week" aria-pressed="false">这一周<\/button>/);
  assert.match(src, /async function loadWeek\(\) \{[\s\S]*?fetch\("\/api\/numbers"\)/);
  assert.match(src, /if \(healthView === "week"\) return loadWeek\(\);/);
  assert.match(src, /tab === "health" \? "#health" \+ \(healthView === "week" \? ":week" : ""\)/);
});
