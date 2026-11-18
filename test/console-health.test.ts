// 控制台「顺不顺」那一页：/api/incidents 只给数（口径在 src/metrics/incidents.ts，那边另有测试），页面有这个标签页。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createConsole } from "../src/console/server.ts";
import type { ConsoleOptions } from "../src/console/server.ts";
import { STOP_NOTICE } from "../src/metrics/incidents.ts";
import type { IncidentCounts, IncidentHour } from "../src/metrics/incidents.ts";
import { stretches } from "../src/console/health.ts";
import type { Stretch } from "../src/console/health.ts";
import type { RepairEvent } from "../src/repair/log.ts";
import { LANG_COOKIE } from "../src/console/lang/index.ts";
import { consoleSource } from "./console-web.ts";
import { tmpDir } from "./tmp.ts";
import { OPEN_READS } from "./console-reads.ts";

const TZ = "Australia/Melbourne";
const NOW = Date.UTC(2026, 10, 13, 9, 30);   // 枫湾 11-13 20:30
const L = (h: number, mi = 0, s = 0): number => Date.UTC(2026, 10, 13, h - 11, mi, s);
const iso = (t: number): string => new Date(t).toISOString();
const SECRET = "这一句是被拦下的正文，不该出现在接口里";

/** 修理的留痕里的行（提交号、说明都是编的） */
const ev = (t: number, kind: RepairEvent["kind"], extra: Partial<RepairEvent> = {}): RepairEvent => ({ t: iso(t), kind, text: `${kind} 的说明`, ...extra });
const REPAIR: RepairEvent[] = [
  ev(L(9, 0), "deploy", { by: "ops", from: "c0", to: "c1", text: "部署了 c0 → c1（2 个提交）", items: ["c1a session：ops：第一件", "c1b ada：第二件"] }),
  ev(L(9, 5), "boot", { to: "c1" }),
  ev(L(9, 8), "healthy", { to: "c1" }),
  ev(L(18, 30), "deploy", { by: "ops", from: "c1", to: "c2", text: "部署了 c1 → c2（1 个提交）", items: ["c2a session：ops：热修"] }),
  ev(L(18, 40), "deploy", { by: "dev", from: "c2", to: "c3", text: "部署了 c2 → c3（1 个提交）", items: ["c3a session：dev：再修"] }),
  ev(L(18, 45), "restart", { to: "c3" }),
  ev(L(18, 45, 2), "boot", { to: "c3" }),
  ev(L(19, 10), "boot", { to: "c3" }),                                                     // 只是重启
  ev(L(19, 20), "rollback", { by: "watchdog", from: "c3", to: "c2", text: "退回：c3 → c2" }),
  ev(L(19, 21), "rollback", { by: "mira", from: "c3", to: "c2", text: "她自己试的，不算" }),
  ev(L(19, 21, 30), "rollback", { by: "watchdog", text: "告诉 ada 没发出去" }),            // 看守退回以后的一句提示：没有从哪到哪，不算一次退回
  ev(L(19, 22), "boot", { to: "c2" }),
  ev(L(20, 0), "deploy", { by: "ops", from: "c2", to: "c4", text: "部署了 c2 → c4（1 个提交）；等她闲下来自己重启", items: ["c4a session：ops：还没生效的"] }),
  ev(L(21, 0), "boot", { to: "c9" }),                                                      // 现在以后的：不看
];

test("console health: stretches — one per start of hhd inside the window, what went live with it, and what is deployed but not live yet", () => {
  const seen: Array<[number, number]> = [];
  const count = (from: number, to: number): IncidentCounts => { seen.push([from, to]); return { requests: (to - from) / 60_000, stops: 0, refusals: 0, blocks: 0, blockedMs: 0, longestMs: 0 }; };
  const from = L(12, 0);
  const r = stretches(REPAIR, from, NOW, count);
  const brief = (s: Stretch) => [s.from, s.to, s.bootAt, s.commit, s.changes.map((c) => `${c.kind}:${c.by}:${c.items.length}`)];
  assert.ok(r.stretches.every((s) => s.versions.length === 0 && !s.configChanged) && !r.configPending, "没给版本和配置的修改时间：都不标");
  assert.deepEqual(r.stretches.map(brief), [
    [from, L(18, 45, 2), L(9, 5), "c1", ["deploy:ops:2"]],                                  // 窗口以前就在跑的那一版：只算窗口里的，上线的是更早那次部署
    [L(18, 45, 2), L(19, 10), L(18, 45, 2), "c3", ["deploy:ops:1", "deploy:dev:1"]],       // 两次部署攒到一次重启里
    [L(19, 10), L(19, 22), L(19, 10), "c3", []],                                           // 只是重启
    [L(19, 22), NOW, L(19, 22), "c2", ["rollback:watchdog:0"]],                            // 看守退回的算，她自己试的不算
  ]);
  assert.deepEqual(seen, r.stretches.map((s) => [s.from, s.to]));
  assert.equal(r.stretches[1]!.requests, (L(19, 10) - L(18, 45, 2)) / 60_000);
  assert.deepEqual(r.pending.map((c) => [c.at, c.by, c.items]), [[L(20, 0), "ops", ["c4a session：ops：还没生效的"]]]);
  // 内核版本按段问；配置文件是在哪两次起来之间改的，就标在后一次起来的那一段上
  const versions = (a: number, b: number): string[] => (a < L(19, 0) && b > L(18, 45) ? ["2.1.312", "2.1.322"] : ["2.1.312"]);
  const marks = (m: number | null) => { const x = stretches(REPAIR, from, NOW, count, { versions, configMtime: m }); return [x.stretches.map((s) => s.configChanged), x.configPending]; };
  assert.deepEqual(stretches(REPAIR, from, NOW, count, { versions }).stretches.map((s) => s.versions), [["2.1.312", "2.1.322"], ["2.1.312", "2.1.322"], ["2.1.312"], ["2.1.312"]]);
  assert.deepEqual(marks(L(18, 44)), [[false, true, false, false], false], "18:44 改的：18:45 起来的那一段");
  assert.deepEqual(marks(L(19, 10)), [[false, false, true, false], false], "正好和起来同一刻：算在这一次上");
  assert.deepEqual(marks(L(19, 15)), [[false, false, false, true], false]);
  assert.deepEqual(marks(L(20, 5)), [[false, false, false, false], true], "最近一次起来之后改的：还没生效");
  assert.deepEqual(marks(L(8, 0)), [[false, false, false, false], false], "留痕里最早那次起来以前改的：不标（不知道隔了多久）");
  assert.deepEqual(marks(L(21, 30)), [[false, false, false, false], false], "修改时间在现在以后：不标");
  assert.deepEqual(marks(null), [[false, false, false, false], false]);
  // 留痕里一次起来都没有：整个窗口一段，哪一版不知道
  const none = stretches(REPAIR.filter((e) => e.kind !== "boot"), from, NOW, count);
  assert.deepEqual(none.stretches.map(brief), [[from, NOW, null, null, []]]);
  assert.deepEqual(none.pending, []);
  // 窗口以前没起来过、窗口里才第一次起来：前面那一截也是一段
  const late = stretches(REPAIR.filter((e) => Date.parse(e.t) >= L(18, 0)), from, NOW, count);
  assert.deepEqual(late.stretches.map(brief).slice(0, 2), [[from, L(18, 45, 2), null, null, []], [L(18, 45, 2), L(19, 10), L(18, 45, 2), "c3", ["deploy:ops:1", "deploy:dev:1"]]]);
  // 坏的时间、太长的一行
  const odd = stretches([{ t: "不是时间", kind: "boot", text: "x" }, ev(L(13, 0), "deploy", { by: "ops", to: "c5", items: ["长".repeat(2000), ...Array.from({ length: 60 }, (_, i) => `第 ${i} 个`)] }), ev(L(13, 1), "boot", { to: "c5" })], from, NOW, count);
  const items = odd.stretches[1]!.changes[0]!.items;
  assert.deepEqual([odd.stretches.length, items.length, items[0]!.length], [2, 40, 601]);
});

function fixture(): { dir: string; sessions: string; logPath: string; file: string; configPath: string } {
  const dir = tmpDir("hh-console-health-");
  const sessions = join(dir, "projects", "-ws");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(dir, "logs"));
  const file = join(sessions, "s1.jsonl");
  const row = (o: Record<string, unknown>): string => JSON.stringify(o) + "\n";
  const asst = (t: number, rid: string, stop: string | null = null, text = "好的"): string =>
    row({ type: "assistant", timestamp: iso(t), requestId: rid, version: t < L(19, 0) ? "2.1.312" : "2.1.322", message: { model: "m", stop_reason: stop, content: [{ type: "text", text }] } });
  writeFileSync(file, [
    asst(L(18, 1), "r1"), asst(L(18, 2), "r2", "refusal", SECRET),
    row({ type: "system", subtype: "informational", timestamp: iso(L(18, 2, 3)), uuid: "u1", content: `${STOP_NOTICE}：${SECRET}` }),
    asst(L(19, 5), "r3"),
    row({ type: "system", subtype: "model_refusal_no_fallback", timestamp: iso(L(19, 6)), uuid: "u2" }),
  ].join(""));
  const logPath = join(dir, "logs", "hh.jsonl");
  writeFileSync(logPath, JSON.stringify({ t: iso(L(19, 7)), level: "warn", mod: "hhd", msg: "event loop blocked", ms: 5200, busy: ["main"] }) + "\n");
  mkdirSync(join(dir, "repair"));
  writeFileSync(join(dir, "repair", "log.jsonl"), REPAIR.map((e) => JSON.stringify(e) + "\n").join("") + "半行");
  // 她的线上配置：只看修改时间。这里放在 19:15（19:10 那次起来之后、19:22 那次之前）
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify({ secret: SECRET }));
  utimesSync(configPath, new Date(L(19, 15)), new Date(L(19, 15)));
  return { dir, sessions, logPath, file, configPath };
}

async function withServer(o: Partial<ConsoleOptions>, fn: (get: (path: string, cookie?: string) => Promise<{ status: number; text: string; body: Record<string, unknown> }>) => Promise<void>, clock = { now: NOW }): Promise<void> {
  const dir = tmpDir("hh-console-health-srv-");
  const server = createConsole({ tell: OPEN_READS,
    dbPath: join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "projects"), logPath: join(dir, "hh.jsonl"),
    pageHtml: "<!doctype html><title>t</title>", now: () => clock.now, ...o,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fn(async (path, cookie) => {
      const r = await fetch(base + path, cookie ? { headers: { cookie } } : {});
      const text = await r.text();
      return { status: r.status, text, body: JSON.parse(text) as Record<string, unknown> };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

test("console health: /api/incidents gives the hourly numbers and nothing of what was stopped; inside five minutes it is the same pass", async () => {
  const f = fixture();
  const clock = { now: NOW };
  await withServer({ incidents: { dir: f.sessions, logPath: f.logPath, tz: TZ, stateDir: f.dir, configPath: f.configPath } }, async (get) => {
    const r = await get("/api/incidents");
    assert.equal(r.status, 200);
    const hours = r.body.hours as IncidentHour[];
    assert.equal(hours.length, 25);
    const at = (h: number): IncidentHour => hours.find((x) => x.day === "2026-11-13" && x.hour === h)!;
    assert.deepEqual([at(18).requests, at(18).stops, at(18).refusals, at(18).blocks], [2, 1, 0, 0]);
    assert.deepEqual([at(19).requests, at(19).stops, at(19).refusals, at(19).blocks, at(19).blockedMs, at(19).longestMs], [1, 0, 1, 1, 5200, 5200]);
    assert.equal(r.body.tz, TZ);
    assert.equal(r.body.at, NOW);
    assert.equal(r.text.includes(SECRET) || r.text.includes(STOP_NOTICE) || r.text.includes("r2") || r.text.includes("main"), false, "只有数：正文、提示原文、请求号、日志里别的字段都不出来");
    assert.deepEqual(Object.keys(r.body).sort(), ["at", "configPending", "hours", "pending", "readBytes", "stretches", "tookMs", "tz"]);
    // 每次上线之后：窗口从 11-12 20:00 起；18:45 起来的那一段里是 19:05 的那个请求和 19:06 的被拒、19:07 的卡顿
    const st = r.body.stretches as Stretch[];
    assert.deepEqual(st.map((s) => [s.commit, s.requests, s.stops, s.refusals, s.blocks]), [[null, 0, 0, 0, 0], ["c1", 2, 1, 0, 0], ["c3", 1, 0, 1, 1], ["c3", 0, 0, 0, 0], ["c2", 0, 0, 0, 0]]);
    assert.equal(st[0]!.from, (r.body.hours as IncidentHour[])[0]!.start);
    assert.deepEqual(st.map((s) => [s.versions, s.configChanged]), [[[], false], [["2.1.312"], false], [["2.1.322"], false], [[], false], [[], true]]);
    assert.equal(r.body.configPending, false);
    assert.deepEqual((r.body.pending as Array<{ by: string }>).map((c) => c.by), ["ops"]);
    assert.deepEqual(Object.keys(hours[0]!).sort(), ["blockedMs", "blocks", "day", "hour", "longestMs", "refusals", "requests", "start", "stops"]);
    // 五分钟内：同一份（文件又多了一行也不读）
    appendFileSync(f.file, JSON.stringify({ type: "assistant", timestamp: iso(L(20, 31)), requestId: "r4", message: { model: "m" } }) + "\n");
    clock.now = NOW + 4 * 60_000;
    assert.equal((await get("/api/incidents")).body.at, NOW);
    // 过了五分钟：接着读新加的
    clock.now = NOW + 6 * 60_000;
    const later = await get("/api/incidents");
    assert.equal(later.body.at, NOW + 6 * 60_000);
    assert.equal((later.body.hours as IncidentHour[]).reduce((n, h) => n + h.requests, 0), 4);
  }, clock);
});

test("console health: without the option the endpoint says so, in the viewer's language; it is read-only like the rest", async () => {
  await withServer({}, async (get) => {
    const zh = await get("/api/incidents");
    assert.deepEqual([zh.status, zh.body.error], [404, "没配「顺不顺」要读的会话记录和日志"]);
    const en = await get("/api/incidents", `${LANG_COOKIE}=en`);
    assert.deepEqual([en.status, en.body.error], [404, "The session files and log for the health page are not configured"]);
  });
});

test("console health: the page has its place in the left column, its pane and its script, and asks only the one endpoint", () => {
  const src = consoleSource();
  assert.match(src, /<button data-page="run">运行<\/button>/);
  assert.match(src, /<section id="healthview" hidden aria-label="运行">/);
  assert.match(src, /async function loadHealth\(\) \{[\s\S]*?fetch\("\/api\/incidents"\)/);
  assert.match(src, /if \(t === "health"\) loadHealth\(\);/);
  // 地址带 #health 直接开这一页：要在 setLens（它会改地址栏）之前认
  assert.match(src, /const hh = location\.hash\.match\(\/\^#health\(\?::\(week\)\)\?\$\/\);[\s\S]*?setLens\(lens\);[\s\S]*?if \(hh\) \{[^\n]*setTab\("health"\); \}/);
});
