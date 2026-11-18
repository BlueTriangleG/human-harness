// 控制台：只读数据层 + 网页服务。用临时目录里的假数据库、假 transcript，不碰真的。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join, relative } from "node:path";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/store/db.ts";
import { CentralMemory } from "../src/memory/central.ts";
import {
  activity, clip, events, hiddenThinking, logTail, maxSeq, openReadOnly, tailLines, transcriptSteps, validName, workers,
} from "../src/console/data.ts";
import { RENAMED, createConsole, hostAllowed } from "../src/console/server.ts";
import { brainRoutes } from "../src/console/routes/brain.ts";
import { memoryRoutes } from "../src/console/routes/memory.ts";
import { promptRoutes } from "../src/console/routes/prompt.ts";
import { eventRoutes } from "../src/console/routes/events.ts";
import { gateRoutes } from "../src/console/routes/gate.ts";
import { healthRoutes } from "../src/console/routes/health.ts";
import { approvedFrom } from "../src/persona/registry.ts";
import { buildLine } from "../src/gate/parse.ts";
import { sourcesFrom } from "../src/gate/sources.ts";
import type { Sources } from "../src/gate/sources.ts";
import type { ConsoleOptions } from "../src/console/server.ts";
import { WEB_FILES, loadWeb, webUrl } from "../src/console/web.ts";
import { WEB_DIR, consoleSource } from "./console-web.ts";
import { flatPack } from "../src/console/lang/index.ts";
import { OPEN_READS } from "./console-reads.ts";

const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);

function fixture() {
  const dir = tmpDir("hh-console-");
  const dbPath = join(dir, "hh.db");
  const db = openDb(dbPath);
  const central = new CentralMemory(db, () => T0);
  central.append(1, "外界", "input", "今天怎么样", { from: "ada", channel: "app" }, T0 - 120_000);
  central.append(1, "main", "think", "他在问近况，先看看今天做了什么", null, T0 - 110_000);
  central.append(1, "main", "act", 'Bash {"command":"ls"}', null, T0 - 100_000);
  central.append(1, "main", "result", "a\nb", { error: true }, T0 - 90_000);
  central.append(1, "perception-messages", "say", "嗯", null, T0 - 30_000);
  central.append(1, "main", "say", "还行", null, T0);

  const cc = join(dir, "cc");
  const projects = join(dir, "projects");
  mkdirSync(cc); mkdirSync(join(projects, "-work"), { recursive: true });
  const sid = "b14a6a8f-3e7e-4572-bc4b-22a102e7495d";
  writeFileSync(join(cc, "avatar.json"), JSON.stringify({ session_id: sid, model: "opus", bg_model: "opus", state: "idle", turn: 3, dir: "/w", created: "2026-10-29 08:00:00", token: "SECRET-TOKEN" }));
  writeFileSync(join(cc, "avatar.settings.json"), "{}");
  writeFileSync(join(cc, "broken.json"), "{not json");
  const lines = [
    { type: "user", timestamp: "2026-10-29T08:00:00Z", message: { role: "user", content: "把眼睛画大一点" } },
    { type: "user", isMeta: true, timestamp: "2026-10-29T08:00:00Z", message: { role: "user", content: "<meta>" } },
    { type: "assistant", timestamp: "2026-10-29T08:00:01Z", message: { content: [
      { type: "thinking", thinking: "", signature: "x" },
      { type: "thinking", thinking: "先看现在的参数", signature: "y" },
      { type: "text", text: "我先看一下" },
      { type: "tool_use", id: "tu1", name: "Read", input: { file_path: "/w/a.json" } },
    ] } },
    { type: "user", timestamp: "2026-10-29T08:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: [{ type: "text", text: "没有这个文件" }] }] } },
    { type: "summary", summary: "x" },
  ];
  writeFileSync(join(projects, "-work", `${sid}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  const logPath = join(dir, "hh.jsonl");
  writeFileSync(logPath, [
    { t: "2026-10-29T08:00:00Z", level: "info", mod: "hhd", msg: "started" },
    { t: "2026-10-29T08:00:01Z", level: "warn", mod: "hhd.brain", msg: "turn failed", region: "main" },
    "坏的一行",
    { t: "2026-10-29T08:00:02Z", level: "error", mod: "hhd.send", msg: "send failed" },
  ].map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n");
  return { dir, dbPath, db, central, cc, projects, logPath, sid };
}

test("events: last N, after, before, all in seq order; meta parsed", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const all = events(ro);
    assert.deepEqual(all.map((r) => r.seq), [1, 2, 3, 4, 5, 6]);
    assert.deepEqual(all[0]!.meta, { from: "ada", channel: "app" });
    assert.deepEqual(events(ro, { limit: 2 }).map((r) => r.seq), [5, 6]);
    assert.deepEqual(events(ro, { after: 4 }).map((r) => r.seq), [5, 6]);
    assert.deepEqual(events(ro, { before: 4, limit: 2 }).map((r) => r.seq), [2, 3]);
    assert.equal(maxSeq(ro), 6);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("read-only connection cannot write", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    assert.throws(() => ro.exec("DELETE FROM central"));
    assert.equal(maxSeq(ro), 6);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("clip keeps head and tail of long text", () => {
  const s = "头".repeat(100) + "中".repeat(1000) + "尾".repeat(100);
  const c = clip(s, 300);
  assert.ok(c.startsWith("头"));
  assert.ok(c.endsWith("尾"));
  assert.ok(c.includes("中间省略 900 字"));
  assert.equal(clip("短", 300), "短");
});

test("activity buckets per source per minute, last bucket is now", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const a = activity(ro, T0, 10);
    assert.equal(a.minutes, 10);
    assert.equal(a.lanes.main!.length, 10);
    assert.equal(a.lanes.main![9], 1);          // T0 那条
    assert.equal(a.lanes.main!.reduce((x, y) => x + y, 0), 4);
    assert.equal(a.lanes["perception-messages"]![8], 1);   // 30 秒前，还在上一分钟
    assert.equal(a.lanes["外界"]![7], 1);       // 两分钟前
    assert.equal(activity(ro, T0, 1).lanes.main![0], 1);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("activity on one connection looks only at rows after the last window's first row, and always equals a fresh count: window moving on, new rows, a longer window, an empty window", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  const same = (now: number, minutes: number, why: string): void => {
    const d = openReadOnly(f.dbPath);
    try { assert.deepEqual(activity(ro, now, minutes), activity(d, now, minutes), why); } finally { d.close(); }
  };
  try {
    same(T0, 10, "第一次");
    same(T0 + 3 * 60_000, 10, "窗口往后挪了三分钟");
    f.central.append(1, "main", "say", "新的一句", null, T0 + 4 * 60_000);
    f.central.append(1, "side-1", "think", "旧时间、后写进来的", null, T0 - 9 * 60_000);
    same(T0 + 4 * 60_000, 10, "多了两行，其中一行时间在前");
    same(T0 + 4 * 60_000, 60, "看更久以前：窗口往回挪");
    same(T0 + 5 * 60_000, 10, "再回到 10 分钟");
    same(T0 + 3 * 3600_000, 10, "窗口里一行都没有");
    f.central.append(1, "main", "say", "三小时后", null, T0 + 3 * 3600_000 + 30_000);
    same(T0 + 3 * 3600_000 + 60_000, 10, "空窗口以后又来一行");
    assert.equal(activity(ro, T0 + 3 * 3600_000 + 60_000, 10).lanes.main!.reduce((x, y) => x + y, 0), 1);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("workers: skips settings and broken files, never returns the token", () => {
  const f = fixture();
  try {
    const w = workers(f.cc, f.projects);
    assert.equal(w.length, 1);
    assert.equal(w[0]!.name, "avatar");
    assert.equal(w[0]!.sessionId, f.sid);
    assert.ok(w[0]!.lastActive);
    assert.ok(!JSON.stringify(w).includes("SECRET-TOKEN"));
    assert.deepEqual(workers(join(f.dir, "missing"), f.projects), []);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("validName rejects paths", () => {
  assert.ok(validName("avatar-motion"));
  assert.ok(validName("剪片子"));
  assert.ok(!validName("../x"));
  assert.ok(!validName(".hidden"));
  assert.ok(!validName("a/b"));
  assert.ok(!validName(""));
});

test("transcriptSteps: input / think / say / act / result with tool name; skips meta and empty thinking", () => {
  const f = fixture();
  try {
    const lines = tailLines(join(f.projects, "-work", `${f.sid}.jsonl`), 1_000_000);
    const steps = transcriptSteps(lines);
    assert.deepEqual(steps.map((s) => s.kind), ["input", "think", "say", "act", "result"]);
    assert.equal(steps[3]!.tool, "Read");
    assert.equal(steps[4]!.tool, "Read");
    assert.equal(steps[4]!.error, true);
    assert.equal(steps[4]!.text, "没有这个文件");
    assert.deepEqual(hiddenThinking(lines), { shown: 1, hidden: 1 });
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("tailLines drops the partial first line", () => {
  const f = fixture();
  try {
    const p = join(f.dir, "t.txt");
    writeFileSync(p, "第一行很长很长\nsecond\nthird\n");
    assert.deepEqual(tailLines(p, 13), ["third"]);
    assert.deepEqual(tailLines(p, 1000), ["第一行很长很长", "second", "third"]);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("logTail filters by level and skips bad lines", () => {
  const f = fixture();
  try {
    assert.deepEqual(logTail(f.logPath, 10, "warn").map((r) => r.msg), ["turn failed", "send failed"]);
    assert.equal(logTail(f.logPath, 10, "info").length, 3);
    assert.equal(logTail(f.logPath, 1, "info").length, 1);
    assert.deepEqual(logTail(join(f.dir, "nope.jsonl")), []);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("hostAllowed only accepts loopback names on our port", () => {
  assert.ok(hostAllowed("127.0.0.1:7790", 7790));
  assert.ok(hostAllowed("localhost:7790", 7790));
  assert.ok(!hostAllowed("evil.example:7790", 7790));
  assert.ok(!hostAllowed("127.0.0.1:80", 7790));
  assert.ok(!hostAllowed(undefined, 7790));
});

async function withServer(fn: (base: string, f: ReturnType<typeof fixture>) => Promise<void>, extra: (f: ReturnType<typeof fixture>) => Partial<ConsoleOptions> = () => ({})) {
  const f = fixture();
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: f.cc, projectsDir: f.projects, logPath: f.logPath,
    pageHtml: "<!doctype html><title>t</title>", now: () => T0, pollMs: 20, ...extra(f),
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`, f);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true });
  }
}

test("server: page, events, activity, workers, worker steps, log, status when hhd is down", async () => {
  await withServer(async (base) => {
    const page = await fetch(base + "/");
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    const ev = await (await fetch(base + "/api/events?after=4")).json() as { rows: Array<{ seq: number }>; maxSeq: number };
    assert.deepEqual(ev.rows.map((r) => r.seq), [5, 6]);
    assert.equal(ev.maxSeq, 6);
    const act = await (await fetch(base + "/api/activity?minutes=10")).json() as { lanes: Record<string, number[]> };
    assert.equal(act.lanes.main!.length, 10);
    const ws = await (await fetch(base + "/api/workers")).json() as { workers: Array<{ name: string }> };
    assert.deepEqual(ws.workers.map((w) => w.name), ["avatar"]);
    const w = await (await fetch(base + "/api/worker?name=avatar")).json() as { steps: unknown[]; thinking: { hidden: number } };
    assert.equal(w.steps.length, 5);
    assert.equal(w.thinking.hidden, 1);
    assert.equal((await fetch(base + "/api/worker?name=..%2Fx")).status, 400);
    assert.equal((await fetch(base + "/api/worker?name=nobody")).status, 404);
    const log = await (await fetch(base + "/api/log?level=error")).json() as { lines: Array<{ msg: string }> };
    assert.deepEqual(log.lines.map((l) => l.msg), ["send failed"]);
    const st = await (await fetch(base + "/api/status")).json() as { ok: boolean; error?: string };
    assert.equal(st.ok, false);
    assert.ok(st.error);
    assert.equal((await fetch(base + "/nope")).status, 404);
    assert.equal((await fetch(base + "/api/events", { method: "POST" })).status, 405);
  });
});

test("server: the two renamed endpoints — the new address and the old one give the same answer; the page asks only for new ones", async () => {
  await withServer(async (base) => {
    const [fresh, old] = await Promise.all(["/api/central?after=4", "/api/events?after=4"].map(async (p) => { const r = await fetch(base + p); return [r.status, await r.text()]; }));
    assert.equal(fresh![0], 200);
    assert.deepEqual(old, fresh);
    assert.deepEqual((JSON.parse(fresh![1] as string) as { rows: Array<{ seq: number }> }).rows.map((r) => r.seq), [5, 6]);
    // 事件记忆那一组：这份假库里没有事件表，新旧地址都答同一句（有数据时的样子在 console-events.test.ts）
    for (const [from, to] of Object.entries(RENAMED)) {
      const [a, b] = await Promise.all([from, to].map(async (p) => { const r = await fetch(base + p); return [r.status, await r.text()]; }));
      assert.deepEqual(a, b, `${from} 和 ${to}`);
      assert.notEqual(a![1], JSON.stringify({ error: "没有这个地址" }), `${from} 没接上`);
    }
    assert.equal((await fetch(base + "/api/central", { method: "POST" })).status, 405);
  });
  // 改名表指向的都是登记过的地址；各页登记的地址没有重的
  const site = { o: {} as ConsoleOptions, now: () => 0, withDb: () => { throw new Error("用不到"); } };
  const groups = [brainRoutes(site), memoryRoutes(site), promptRoutes(site), eventRoutes(site), gateRoutes(site), healthRoutes(site)].map((g) => Object.keys(g));
  const all = groups.flat();
  assert.equal(new Set(all).size, all.length, "两页登记了同一个地址");
  for (const to of Object.values(RENAMED)) assert.ok(all.includes(to), to);
  for (const from of Object.keys(RENAMED)) assert.equal(all.includes(from), false, `${from} 既是旧地址又是新地址`);
  for (const p of all) assert.match(p, /^\/api\/[a-z-]+(\/[a-z]+)?$/, p);
  // 页面脚本只用新地址
  const src = consoleSource();
  assert.doesNotMatch(src, /["'`]\/api\/mem["'`\/?]/);
  assert.doesNotMatch(src, /["'`]\/api\/events["'`?]/);
});

test("server: rejects a foreign Host header (DNS rebinding)", async () => {
  await withServer(async (base) => {
    const { request } = await import("node:http");
    const u = new URL(base);
    const code = await new Promise<number>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: "/api/events", headers: { host: "evil.example:" + u.port } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    assert.equal(code, 403);
  });
});

test("server: /web/ serves only the listed files; scripts are not allowed inline", async () => {
  const assets = new Map([["/web/js/a.js", { type: "text/javascript; charset=utf-8", body: "let a = 1;\n" }]]);
  await withServer(async (base) => {
    const page = await fetch(base + "/");
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.match(csp, /script-src 'self'(;|$)/, "页面里不放内联脚本");
    const a = await fetch(base + "/web/js/a.js");
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(a.headers.get("x-content-type-options"), "nosniff");
    assert.equal(await a.text(), "let a = 1;\n");
    assert.equal((await fetch(base + "/web/js/a.js", { method: "POST" })).status, 405);
    // 名单以外的一律没有：不拿请求里的路径去读文件
    const { request } = await import("node:http");
    const u = new URL(base);
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", reject);
      req.end();
    });
    for (const p of ["/web/js/b.js", "/web/", "/web/js/", "/web/js/../../server.ts", "/web/js/%2e%2e/%2e%2e/server.ts", "/web/js/a.js/", "/web//js/a.js", "/WEB/js/a.js"]) {
      assert.equal(await raw(p), 404, p);
    }
  }, () => ({ assets }));
  // 没给 assets 的（别的测试）照旧 404
  await withServer(async (base) => { assert.equal((await fetch(base + "/web/js/a.js")).status, 404); });
});

test("web: index.html, the list in web.ts and the files on disk agree; no inline script", () => {
  const w = loadWeb(WEB_DIR);
  assert.deepEqual([...w.assets.keys()], WEB_FILES.map(webUrl));
  // 骨架里引用的就是名单里的，顺序也一样（样式的先后决定谁盖谁；脚本是模块，入口 start.js 排最后，别的列出来让浏览器先取）
  const refs = [...w.pageHtml.matchAll(/<(?:link rel="(?:stylesheet|modulepreload)" href|script type="module" src)="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(refs, WEB_FILES.map(webUrl));
  // 磁盘上没有名单以外的文件（漏登记的在这里挂，不等到页面上 404）。web/wizard/ is the wizard's own page (src/wizard.ts
  // serves it), not the console's: it has no inline script or handler either
  const onDisk = (readdirSync(WEB_DIR, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((d) => !d.isDirectory()).map((d) => relative(WEB_DIR, join(d.parentPath, d.name))).filter((f) => !f.startsWith("wizard/")).sort();
  assert.deepEqual(onDisk, [...WEB_FILES, "index.html"].sort());
  const wizard = readFileSync(join(WEB_DIR, "wizard", "index.html"), "utf8");
  assert.doesNotMatch(wizard, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(wizard, /\son[a-z]+\s*=/i);
  // 页面里没有内联脚本、没有写在标签上的事件，也不引外面的东西
  assert.doesNotMatch(w.pageHtml, /<script(?![^>]*\b(?:src=|type="application\/json"))[^>]*>/, "除了给脚本的那块数据，没有内联脚本");
  assert.doesNotMatch(w.pageHtml, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(consoleSource(), /(?:src|href)=["']?(?:https?:)?\/\//i);
  assert.doesNotMatch(consoleSource(), /@import|url\(\s*["']?(?:https?:)?\/\//i);
});

test("server: stream pushes rows written after the cursor", async () => {
  await withServer(async (base, f) => {
    const ctrl = new AbortController();
    const res = await fetch(base + "/api/stream?after=6", { signal: ctrl.signal });
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    f.central.append(1, "side-1", "note", "一边开始做：剪片子", null, T0 + 1000);
    let buf = "";
    const deadline = Date.now() + 3000;
    while (!buf.includes("event: rows") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value);
    }
    ctrl.abort();
    assert.match(buf, /event: rows/);
    const data = JSON.parse(buf.split("event: rows\ndata: ")[1]!.split("\n")[0]!) as Array<{ seq: number; src: string }>;
    assert.deepEqual(data.map((r) => [r.seq, r.src]), [[7, "side-1"]]);
  });
});


test("学习区块的数据", async () => {
  // 书架：一页带了 ✓（这周升级的），一页还没有编号（控制台只读，不给它发号）
  const shelfOf = (f: ReturnType<typeof fixture>) => join(f.dir, "skills");
  const NO_ID = "# 没号的页\n简介：a\n什么时候翻：b\n";
  await withServer(async (base, f) => {
    const root = shelfOf(f);
    // 最近 25 次联想：只给最近 20 次，新的在前
    const ins = f.db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', 'wake', ?, 3, ?, 0, ?, 120, 1000)");
    for (let i = 0; i < 25; i++) ins.run(T0 - (25 - i) * 60_000, `话题${i}`, JSON.stringify(i === 24 ? [{ id: "0012", p: 0.91 }] : []), i === 24 ? null : "nothing");
    f.db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', '0012', NULL)").run(T0 - 30_000);
    f.db.prepare("INSERT INTO learn_correction (at, p) VALUES (?, 0.8)").run(T0 - 3_600_000);
    f.db.prepare("INSERT INTO kv (k, v) VALUES ('learn.spend.2026-10-29', '123456'), ('learn.spend.2026-10-28', '999999'), ('learn.alert', '联想的判断今天用到上限了')").run();

    const r = await (await fetch(base + "/api/learn")).json() as {
      alert: string | null; alertAt: number | null; spend: { day: string; tokens: number; usd: number; limit: number };
      weekly: Record<string, number | null>; recent: Array<{ at: number; topic: string; mounted: Array<{ id: string; p: number }>; skipped: string | null }>;
    };
    assert.equal(r.alert, "联想的判断今天用到上限了");
    assert.equal(r.alertAt, null, "旧的纯文字告警没有时间");
    assert.deepEqual(r.spend, { day: "2026-10-29", tokens: 123456, usd: 0.0123, limit: 1 });
    assert.equal(r.weekly.corrections, 1);
    assert.equal(r.weekly.mounts, 1);
    assert.equal(r.weekly.opened, 1);
    assert.equal(r.weekly.promoted, 1);
    assert.equal(r.weekly.replayPassRate, null);
    assert.equal(r.recent.length, 20);
    assert.equal(r.recent[0]!.topic, "话题24");
    assert.deepEqual(r.recent[0]!.mounted, [{ id: "0012", p: 0.91 }]);
    assert.equal(r.recent[0]!.skipped, null);
    assert.equal(r.recent[19]!.topic, "话题5");
    assert.equal(readFileSync(join(root, "做事/剪辑/没号.md"), "utf8"), NO_ID, "控制台不发号、不写她的文件");

    // 没有告警、今天没花钱
    f.db.prepare("DELETE FROM kv WHERE k IN ('learn.alert', 'learn.spend.2026-10-29')").run();
    const q = await (await fetch(base + "/api/learn")).json() as { alert: string | null; spend: { tokens: number; usd: number } };
    assert.equal(q.alert, null);
    assert.deepEqual([q.spend.tokens, q.spend.usd], [0, 0]);

    // 网页：右栏有「学习」这一块，读 /api/learn，告警标红
    const html = consoleSource();
    assert.match(html, /<h2>学习<\/h2>\s*<div id="learn">/);
    assert.match(html, /fetch\("\/api\/learn"\)/);
    assert.match(html, /\.learn-alert \{[^}]*var\(--err\)/);
    assert.match(html, /r\.alertAt \? T\("side\.learn\.alertAt", \{ alert: r\.alert, when: when\(r\.alertAt\) \}\) : r\.alert/, "告警带上写的时间");
  }, (f) => {
    const root = shelfOf(f);
    mkdirSync(join(root, "做事/剪辑"), { recursive: true });
    writeFileSync(join(root, "做事/剪辑/SKILL.md"), "---\nname: 剪辑\ndescription: 剪片子\n---\n");
    writeFileSync(join(root, "做事/剪辑/封面.md"), "# 封面 <!-- p:0012 -->\n简介：a\n什么时候翻：b\n\n## 做法\n- 先定字 ✓ 2026-10-28\n");
    writeFileSync(join(root, "做事/剪辑/没号.md"), NO_ID);
    return { learning: { root, generalCategory: "通用", archiveDir: "归档", residentFile: "常驻.md", tz: "UTC", dailyUsd: 1, shelf: false } };
  });
  // 没配学习：404
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/learn")).status, 404);
  });
});

// ---- 下意识：闸门的账（/api/gate） ----

// 枫湾 10 月底是夏令时（UTC+11）：她的 10-29 = 10-28 13:00Z 到 10-29 13:00Z。T0 = 她的 10-29 19:00
const MEL = "Australia/Melbourne";
const MIN = 60_000;
const SECRET = "SECRET-MARK-7f3a";
const EV_ONLY = "EV-ONLY-c91b";
const REGISTRY = {
  owner: { name: "主人", privacy: "owner", handles: { wx: ["主人备注"], xhs: ["主人号"] } },
  guest: { name: "小客", privacy: "guest", handles: { wx: ["小客"], xhs: ["客客"], bili: ["客B"] } },
  // 文件里被改成了主人，没批过（批准底子里还是访客）
  raised: { name: "阿升", privacy: "owner", handles: { wx: ["阿升"] } },
};
// 批准底子（kv registry_approved）：hhd 批过的样子，阿升还是访客
const BASELINE = approvedFrom({ ...REGISTRY, raised: { ...REGISTRY.raised, privacy: "guest" } });

interface GateSeed {
  ts: number; id: string; src: string; conv?: string; sender?: string; isGroup?: boolean; text: string;
  route: string | null; rule?: string; action?: string; verdict?: string; when?: string; gist?: string; why?: string;
  unsure?: boolean; delivered?: number; tokens?: number; units?: number;
  /** 写进 ev 的 system（角色自己的脚本写明的系统提示）；写什么就存什么，好试假的 */
  system?: unknown; do?: string; body?: string;
  /** ev 列原样写这个（试坏的、不是对象的 JSON） */
  rawEv?: string;
}

function seedGate(db: DatabaseSync, rows: GateSeed[]): void {
  const ins = db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev, route, rule, action, verdict, when_, gist, why, unsure, delivered, tokens, units, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const r of rows) {
    const line = buildLine(r.src, r.id, r.text, r.do, r.body);
    // probe 只在 ev 里：拿它看原始事件 JSON 有没有漏到网页上
    const ev = r.rawEv ?? JSON.stringify({ src: r.src, id: r.id, text: r.text, line, ...(r.conv !== undefined ? { conv: r.conv } : {}), ...(r.sender !== undefined ? { sender: r.sender } : {}), ...(r.isGroup !== undefined ? { isGroup: r.isGroup } : {}), ...(r.system !== undefined ? { system: r.system } : {}), ...(r.do ? { do: r.do } : {}), ...(r.body ? { body: r.body } : {}), probe: EV_ONLY });
    ins.run(r.ts, r.id, r.src, r.conv ?? null, r.sender ?? null, line, ev, r.route, r.rule ?? null, r.action ?? null, r.verdict ?? null, r.when ?? null,
      r.gist ?? null, r.why ?? null, r.unsure === undefined ? null : r.unsure ? 1 : 0, r.delivered ?? null, r.tokens ?? 0, r.units ?? null, r.route === null ? "new" : "done");
  }
}

const DAY_ROWS: GateSeed[] = [
  // 她的 10-29 01:00（按 UTC 还是 10-28）
  { ts: Date.UTC(2026, 9, 28, 14, 0), id: "g1", src: "goals", text: "今天的目标", route: "fixed-main", action: "fixed-main", when: "now", delivered: 1 },
  { ts: T0 - 60 * MIN, id: "r1", src: "remind", text: "该喝水了", route: "fixed-main", action: "fixed-main", when: "now", delivered: 1 },
  { ts: T0 - 50 * MIN, id: "x1", src: "xhs", conv: "通知", text: "有人赞了你的笔记", route: "rule", rule: "xhs-赞", action: "drop" },
  // 访客在群里：照常显示
  { ts: T0 - 40 * MIN, id: "w1", src: "wx", conv: "家里群", sender: "小客", isGroup: true, text: "家里群 小客：GROUP-MARK 晚上吃什么", route: "judge", action: "judge", verdict: "main", when: "now", gist: "问晚饭", why: "问到她了", delivered: 1, tokens: 5000 },
  // 陌生人私聊：照常显示；新行带 units
  { ts: T0 - 30 * MIN, id: "w2", src: "wx", conv: "路人甲", sender: "路人甲", isGroup: false, text: "路人甲：STRANGER-MARK 在吗", route: "judge", action: "judge", verdict: "drop", gist: "陌生人打招呼", why: "不认识", tokens: 1000, units: 300 },
  // 主人私聊：照常显示
  { ts: T0 - 20 * MIN, id: "w3", src: "wx", conv: "主人备注", sender: "主人备注", isGroup: false, text: "主人备注：OWNER-MARK 记得", route: "judge", action: "judge", verdict: "digest", gist: "提醒", why: "不急", unsure: true },
  // 访客私聊：原文、要点、原因都不出（兜底原因里也带着原文）
  { ts: T0 - 10 * MIN, id: "w4", src: "wx", conv: "小客", sender: "小客", isGroup: false, text: `小客：${SECRET} 只跟你说`, do: `回小客：${SECRET} 的做法`, body: `${SECRET} 的正文块`, route: "fallback", action: "judge", when: "now", gist: `${SECRET} 的要点`, why: `小判断出错：${SECRET}`, delivered: 1 },
  { ts: T0 - 5 * MIN, id: "b1", src: "bili", text: "有人回复了你", route: "fallback", action: "judge", when: "now", why: "小判断超时", delivered: 1 },
  { ts: T0 - 3 * MIN, id: "b2", src: "bili", text: "又有人回复了你", route: "fallback", action: "judge", when: "now", why: "小判断超时", delivered: 1 },
];
// 她的 10-28 23:00（按 UTC 也是 10-28，但和上面 10-28 14:00Z 那条不是同一天）
const OTHER_DAY: GateSeed = { ts: Date.UTC(2026, 9, 28, 12, 0), id: "old1", src: "wx", conv: "路人乙", sender: "路人乙", isGroup: false, text: "OLD-DAY-MARK", route: "judge", action: "judge", verdict: "drop", tokens: 9999 };

interface GateBody {
  day: string; today: string; total: number; limit: number; registryOk: boolean; baselineOk: boolean; aliasOk: boolean;
  stats: { received: number; byRoute: Record<string, number>; byVerdict: Record<string, number>; judgeCalls: number; units: number; dailyUnits: number; fallbackWhy: Record<string, number> };
  rows: Array<Record<string, unknown> & { ts: number; src: string; text: string | null; gist: string | null; why: string | null; private: boolean; delivered: boolean; unsure: boolean | null }>;
}

// 控制台 11-14 以前自己写的那份聊天来源（带 qq）；这些测试里出现的别的来源都明确标成别的类：和以前遮不遮一模一样
const CONSOLE_SOURCES = sourcesFrom({ chat: ["wx", "qq", "xhs", "bili_dm"], public: ["bili"], probe: ["phone_net", "load", "quota", "budget", "rss"], always: ["remind", "goals"], hands: ["cc"] });
// 她实例配置片段 1（/Users/Shared/hh-config-layers/闸门-1-senses.json）逐字一样的那张：动了片段或 maskAsChat，她页面上这几类会不会突然被遮，这里看得住
const HER_FRAGMENT_1 = sourcesFrom({ chat: ["wx", "xhs", "bili_dm"], public: ["bili"], probe: ["phone_net", "load", "quota", "budget"], always: ["remind", "goals", "load"], hands: ["cc"] });

function gateWorkspace(f: ReturnType<typeof fixture>, registry: string | null, baseline: string | null = JSON.stringify(BASELINE), sources: Sources = CONSOLE_SOURCES): Partial<ConsoleOptions> {
  const ws = join(f.dir, "ws");
  mkdirSync(join(ws, "memory", "people"), { recursive: true });
  if (registry !== null) writeFileSync(join(ws, "memory", "people", "registry.json"), registry);
  if (baseline !== null) f.db.prepare("INSERT INTO kv (k, v) VALUES ('registry_approved', ?)").run(baseline);
  return { gate: { workspace: ws, tz: MEL, dailyUnits: 2_000_000, haikuMultiplier: 0.5, sources } };
}

// 通道表（11-14 分离）：控制台的「聊天来源」读实例配置；表没给、来源没标的都当聊天遮（宁可多遮），qq 照遮
const SOURCE_ROWS: GateSeed[] = [
  { ts: T0 - 9 * MIN, id: "c1", src: "bili", text: `${SECRET} 评论`, route: "judge", action: "judge", verdict: "drop" },
  { ts: T0 - 8 * MIN, id: "c2", src: "cc", text: `${SECRET} 帮手`, route: "hands", action: "hands" },
  { ts: T0 - 7 * MIN, id: "c3", src: "plain", text: "PLAIN-MARK 一段话", route: "fixed-main", action: "fixed-main" },
  { ts: T0 - 6 * MIN, id: "c4", src: "hh-quota", text: "QUOTA-MARK 额度", route: "rule", rule: "q", action: "main" },
  { ts: T0 - 5 * MIN, id: "c5", src: "newapp", text: `${SECRET} 新来源`, route: "judge", action: "judge", verdict: "drop" },
  { ts: T0 - 3 * MIN, id: "c7", src: "qq", text: `${SECRET} qq`, route: "judge", action: "judge", verdict: "drop" },
  { ts: T0 - 2 * MIN, id: "c8", src: "budget", text: "BUDGET-MARK 预算", route: "rule", rule: "q", action: "main" },
  { ts: T0 - 1 * MIN, id: "c9", src: "quota", text: "QUOTA2-MARK 额度", route: "rule", rule: "q", action: "main" },
  { ts: T0 - 30 * 1000, id: "c10", src: "goals", text: "GOALS-MARK 今天的目标", route: "fixed-main", action: "fixed-main" },
];

test("/api/gate: with no source table every source except HH's own is masked as chat — a comment, a helper report, a new app all hide; plain and hh-quota stay", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, SOURCE_ROWS);
    const text = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(text) as GateBody;
    const bySrc = Object.fromEntries(r.rows.map((x) => [`${x.src}:${(x as Record<string, unknown>).conv ?? ""}`, x.private]));
    assert.deepEqual(bySrc, { "bili:": true, "cc:": true, "plain:": false, "hh-quota:": false, "newapp:": true, "qq:": true, "budget:": true, "quota:": true, "goals:": true });
    assert.ok(!text.includes(SECRET), "被遮的原文哪里都不出");
    assert.ok(text.includes("PLAIN-MARK") && text.includes("QUOTA-MARK"), "HH 自己的来源照常显示");
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY), JSON.stringify(BASELINE), sourcesFrom({})));
});

test("/api/gate: a source the table does not name is masked as chat; the kinds the table names as not chat (her budget / quota / goals included) stay readable; qq masks whether or not the table lists it", async () => {
  for (const sources of [CONSOLE_SOURCES, HER_FRAGMENT_1]) {
    await withServer(async (base, f) => {
      seedGate(f.db, SOURCE_ROWS);
      const text = await (await fetch(base + "/api/gate")).text();
      const r = JSON.parse(text) as GateBody;
      const bySrc = Object.fromEntries(r.rows.map((x) => [`${x.src}:${(x as Record<string, unknown>).conv ?? ""}`, x.private]));
      assert.deepEqual(bySrc, { "bili:": false, "cc:": false, "plain:": false, "hh-quota:": false, "newapp:": true, "qq:": true, "budget:": false, "quota:": false, "goals:": false }, JSON.stringify([...sources.chat]));
      assert.ok(!text.includes(`${SECRET} 新来源`) && !text.includes(`${SECRET} qq`));
      for (const m of ["BUDGET-MARK", "QUOTA2-MARK", "GOALS-MARK"]) assert.ok(text.includes(m), `${m}：她的额度提醒、目标照常显示`);
    }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY), JSON.stringify(BASELINE), sources));
  }
});

test("/api/gate: a group line held for the summary (quota pause) shows as 进总结, not delivered, under its own fallback reason, and is not counted as a judge verdict", async () => {
  await withServer(async (base, f) => {
    const t = Date.UTC(2026, 9, 29, 1, 0);
    seedGate(f.db, [
      { ts: t, id: "held1", src: "wx", conv: "某群", sender: "Bob", isGroup: true, text: "某群：Bob: 打球吗", route: "fallback", rule: "g", action: "judge", verdict: "digest", why: "这周额度快用完了，群里的先进总结" },
      { ts: t + 1, id: "jd1", src: "wx", conv: "某群", sender: "Bob", isGroup: true, text: "某群：Bob: 好", route: "judge", rule: "g", action: "judge", verdict: "digest", why: "闲聊", tokens: 10 },
    ]);
    const r = JSON.parse(await (await fetch(base + "/api/gate?day=2026-10-29")).text()) as GateBody;
    assert.deepEqual(r.stats.byVerdict, { main: 0, digest: 1, drop: 0 }, "只数小判断真判的");
    assert.deepEqual(r.stats.fallbackWhy, { "这周额度快用完了，群里的先进总结": 1 });
    const h = r.rows.find((x) => x.why === "这周额度快用完了，群里的先进总结")!;
    assert.deepEqual([h.route, h.verdict, h.delivered, h.private], ["fallback", "digest", false, false]);
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate: a system notice the role's own script marked (system: true, no conv, no sender) is shown; its 做法 comes apart from the text", async () => {
  await withServer(async (base, f) => {
    const t = Date.UTC(2026, 9, 29, 1, 0);
    seedGate(f.db, [
      { ts: t, id: "sys1", src: "xhs", text: "手机刚开（之前关了约 7 分钟）：去消息页看一眼", system: true, do: "去消息页核对最新私信再处理（很长的做法）", route: "rule", rule: "phone-catchup", action: "main", when: "now", delivered: 1 },
      { ts: t + 1, id: "sys2", src: "bili_dm", text: "B站私信接口不可用：账号没登录", system: true, route: "fallback", action: "judge", when: "now", why: "这周额度快用完了", delivered: 1 },
      { ts: t + 2, id: "body1", src: "wx", conv: "路人甲", sender: "路人甲", isGroup: false, text: "路人甲：看图", body: "图里写着字", do: "看完再回", route: "judge", action: "judge", verdict: "drop" },
      // 系统提示被小判断判过：要点、原因是小判断看着一整批写的，不出
      { ts: t + 3, id: "sys3", src: "bili_dm", text: "B站私信接口一直在限流", system: true, route: "judge", action: "judge", verdict: "main", when: "now", gist: "小客刚私信说了点什么", why: "同一批里的" },
      // ev 读不出来 / 没有正文：退回整行（去掉行首；做法、正文块都还在行里）
      { ts: t + 4, id: "raw1", src: "wx", conv: "路人乙", sender: "路人乙", text: "路人乙：坏了的", do: "照常处理", rawEv: "not json", route: "judge", action: "judge", verdict: "drop" },
      { ts: t + 5, id: "raw2", src: "bili", text: "有人回复了你", do: "看看", rawEv: JSON.stringify({ src: "bili", id: "raw2" }), route: "judge", action: "judge", verdict: "drop" },
    ]);
    const r = JSON.parse(await (await fetch(base + "/api/gate?day=2026-10-29")).text()) as GateBody;
    const s1 = r.rows.find((x) => x.text?.startsWith("手机刚开"))!;
    assert.deepEqual([s1.private, s1.text, s1.do], [false, "手机刚开（之前关了约 7 分钟）：去消息页看一眼", "去消息页核对最新私信再处理（很长的做法）"]);
    assert.equal(r.rows.find((x) => x.src === "bili_dm")!.private, false);
    assert.deepEqual(r.stats.fallbackWhy, { "这周额度快用完了": 1 }, "兜底原因也不再算成访客私聊");
    const b = r.rows.find((x) => x.conv === "路人甲")!;
    assert.deepEqual([b.text, b.body, b.do], ["路人甲：看图", "图里写着字", "看完再回"], "正文块、做法都另给");
    const j = r.rows.find((x) => x.text === "B站私信接口一直在限流")!;
    assert.deepEqual([j.private, j.gist, j.why], [false, null, null]);
    const raw1 = r.rows.find((x) => x.conv === "路人乙")!;
    assert.deepEqual([raw1.text, raw1.do, raw1.body], ["路人乙：坏了的（照常处理）", null, null]);
    const raw2 = r.rows.find((x) => x.src === "bili")!;
    assert.deepEqual([raw2.text, raw2.do, raw2.body], ["有人回复了你（看看）", null, null]);
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate: the system mark never shows a guest's private chat — rows with a conv or sender still go through who-is-it, only boolean true counts, and unreadable lists still hide everything", async () => {
  const forged: GateSeed[] = [
    // 访客私聊，就算 ev 里带着 system: true（假设伪造了）
    { ts: T0 - 9 * MIN, id: "f1", src: "wx", conv: "小客", sender: "小客", isGroup: false, system: true, text: `小客：${SECRET} 一`, do: `${SECRET} 做法`, body: `${SECRET} 正文`, route: "judge", action: "judge", verdict: "main", gist: `${SECRET}`, why: `${SECRET}` },
    // 被标成群的访客私聊（会话名是访客）
    { ts: T0 - 8 * MIN, id: "f2", src: "xhs", conv: "客客", sender: "客客", isGroup: true, system: true, text: `客客：${SECRET} 二`, route: "judge", action: "judge", verdict: "main" },
    // 只有发话人、没有会话名的访客私聊
    { ts: T0 - 7 * MIN, id: "f3", src: "wx", sender: "小客", isGroup: false, system: true, text: `${SECRET} 三`, do: `${SECRET} 做法三`, body: `${SECRET} 正文三`, route: "judge", action: "judge", verdict: "drop" },
    // 没名字、没带标记 / 标记不是布尔 true：照旧遮
    { ts: T0 - 6 * MIN, id: "f4", src: "xhs", text: `${SECRET} 四`, route: "judge", action: "judge", verdict: "drop" },
    { ts: T0 - 5 * MIN, id: "f5", src: "xhs", system: "true", text: `${SECRET} 五`, route: "judge", action: "judge", verdict: "drop" },
    { ts: T0 - 4 * MIN, id: "f6", src: "bili_dm", system: 1, text: `${SECRET} 六`, route: "judge", action: "judge", verdict: "drop" },
    // relay：一律遮
    { ts: T0 - 3 * MIN, id: "f7", src: "relay", system: true, text: `${SECRET} 七`, route: "fixed-main", action: "fixed-main" },
    // 名字是空字符串（不是没有）：照旧遮，不算系统提示的例外
    { ts: T0 - 2 * MIN, id: "f8", src: "xhs", conv: "", sender: "", system: true, text: `小客 私信你：${SECRET} 八`, route: "judge", action: "judge", verdict: "drop" },
    // 带着 isGroup（真的聊天事件都带）：不算系统提示
    { ts: T0 - 1 * MIN, id: "f9", src: "xhs", isGroup: false, system: true, text: `${SECRET} 九`, route: "judge", action: "judge", verdict: "drop" },
    // 标记有效（没有 isGroup）但带着名字的访客行：会话名 + 发话人、只有发话人、只有会话名，都照认人那套遮
    { ts: T0 - 50 * MIN, id: "f10", src: "wx", conv: "小客", sender: "小客", system: true, text: `小客：${SECRET} 十`, do: `${SECRET} 做法十`, body: `${SECRET} 正文十`, route: "judge", action: "judge", verdict: "main", gist: `${SECRET}`, why: `${SECRET}` },
    { ts: T0 - 49 * MIN, id: "f11", src: "wx", sender: "小客", system: true, text: `${SECRET} 十一`, route: "judge", action: "judge", verdict: "drop" },
    { ts: T0 - 48 * MIN, id: "f12", src: "xhs", conv: "客客", system: true, text: `${SECRET} 十二`, route: "judge", action: "judge", verdict: "drop" },
  ];
  await withServer(async (base, f) => {
    seedGate(f.db, forged);
    const text = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(text) as GateBody;
    assert.ok(!text.includes(SECRET), "原文、要点、原因、做法哪里都不出");
    assert.deepEqual(r.rows.map((x) => x.private), forged.map(() => true));
    assert.ok(r.rows.every((x) => x.text === null && x.gist === null && x.why === null && x.do === null && x.body === null));
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
  // 名单读不了：带标记、有名字的照旧全遮；没名字带标记的系统提示照样显示（里面没有谁说的话）
  await withServer(async (base, f) => {
    seedGate(f.db, [forged.find((x) => x.id === "f10")!, { ts: T0 - MIN, id: "ok1", src: "xhs", system: true, text: "手机刚开：去看一眼", route: "rule", action: "main" }]);
    const text = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(text) as GateBody;
    assert.ok(!text.includes(SECRET));
    assert.deepEqual(r.rows.map((x) => [x.private, x.text]), [[false, "手机刚开：去看一眼"], [true, null]]);
  }, (f) => gateWorkspace(f, null));
});

test("/api/gate: one local day, newest first, with route / verdict / judge-call / units / fallback counts", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, [...DAY_ROWS, OTHER_DAY]);
    const res = await fetch(base + "/api/gate");
    assert.equal(res.status, 200);
    const text = await res.text();
    const r = JSON.parse(text) as GateBody;
    assert.equal(r.day, "2026-10-29", "默认是她那边的今天");
    assert.equal(r.today, "2026-10-29");
    assert.equal(r.total, 9);
    assert.equal(r.registryOk, true);
    assert.equal(r.baselineOk, true);
    assert.deepEqual(r.rows.map((x) => x.ts), DAY_ROWS.map((x) => x.ts).sort((a, b) => b - a), "只有这一天的，新的在前");
    assert.ok(!text.includes("OLD-DAY-MARK"));
    assert.equal(r.stats.received, 9);
    assert.deepEqual(r.stats.byRoute, { "fixed-main": 2, hands: 0, rule: 1, judge: 3, fallback: 3 });
    assert.deepEqual(r.stats.byVerdict, { main: 1, digest: 1, drop: 1 });
    assert.equal(r.stats.judgeCalls, 2);
    assert.equal(r.stats.units, 5000 * 0.5 + 300, "老行（units 是 NULL）按 tokens × haiku 倍数估，新行用记下的 units");
    assert.equal(r.stats.dailyUnits, 2_000_000);
    assert.deepEqual(r.stats.fallbackWhy, { "小判断超时": 2, "访客私聊（不显示原文）": 1 });
    const x1 = r.rows.find((x) => x.src === "xhs")!;
    assert.equal(x1.text, "有人赞了你的笔记", "事件的正文（不带行首的 [src id=…]）");
    assert.deepEqual([x1.route, x1.rule, x1.action, x1.verdict, x1.when, x1.delivered], ["rule", "xhs-赞", "drop", null, null, false]);
    const w3 = r.rows.find((x) => x.ts === T0 - 20 * MIN)!;
    assert.equal(w3.unsure, true);
    assert.equal(w3.private, false, "主人的私聊照常显示");
    assert.match(w3.text ?? "", /OWNER-MARK/);

    // 指定哪一天
    const old = await (await fetch(base + "/api/gate?day=2026-10-28")).json() as GateBody;
    assert.equal(old.day, "2026-10-28");
    assert.equal(old.total, 1);
    assert.equal(old.rows[0]!.text, "OLD-DAY-MARK");
    assert.equal(old.stats.judgeCalls, 1);
    assert.equal(old.stats.units, 9999 * 0.5);
    const empty = await (await fetch(base + "/api/gate?day=2026-10-20")).json() as GateBody;
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.stats.byRoute, { "fixed-main": 0, hands: 0, rule: 0, judge: 0, fallback: 0 });
    assert.deepEqual(empty.stats.fallbackWhy, {});

    // 写法不对、没有这一天：400
    for (const bad of ["2026-13-01", "2026-1-01", "2026-02-30", "yesterday", "2026-10-29x"]) {
      assert.equal((await fetch(base + "/api/gate?day=" + encodeURIComponent(bad))).status, 400, bad);
    }
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate: at most 500 rows, total says how many there were", async () => {
  await withServer(async (base, f) => {
    const t = Date.UTC(2026, 9, 26, 14, 0);   // 她的 10-27 01:00
    seedGate(f.db, Array.from({ length: 503 }, (_, i) => ({ ts: t + i * 1000, id: `n${i}`, src: "bili", text: `第 ${i} 条`, route: "rule", rule: "b站", action: "drop" })));
    const r = await (await fetch(base + "/api/gate?day=2026-10-27")).json() as GateBody;
    assert.equal(r.rows.length, 500);
    assert.equal(r.limit, 500);
    assert.equal(r.total, 503);
    assert.equal(r.stats.received, 503);
    assert.equal(r.rows[0]!.text, "第 502 条");
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate privacy: a guest's one-on-one text never leaves the console; group, owner, stranger and non-chat rows are shown", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, DAY_ROWS);
    const body = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(body) as GateBody;
    assert.ok(!body.includes(SECRET), "访客私聊的原文、要点、原因（包括兜底原因的统计）都不出");
    assert.ok(!body.includes(EV_ONLY), "原始事件 JSON 不出");
    for (const x of r.rows) assert.ok(!("ev" in x));
    const guest = r.rows.find((x) => x.ts === T0 - 10 * MIN)!;
    assert.equal(guest.private, true);
    assert.deepEqual([guest.text, guest.gist, guest.why, guest.do, guest.body], [null, null, null, null, null]);
    assert.deepEqual([guest.src, guest.conv, guest.sender, guest.route, guest.delivered, guest.when], ["wx", "小客", "小客", "fallback", true, "now"], "谁、怎么分、送没送照常显示");
    const group = r.rows.find((x) => x.ts === T0 - 40 * MIN)!;
    assert.equal(group.private, false, "同一个访客在群里：照常显示");
    assert.equal(group.text, "家里群 小客：GROUP-MARK 晚上吃什么");
    assert.deepEqual([group.gist, group.why], ["问晚饭", "问到她了"]);
    const stranger = r.rows.find((x) => x.ts === T0 - 30 * MIN)!;
    assert.equal(stranger.private, false, "陌生人私聊照常显示");
    assert.match(stranger.text ?? "", /STRANGER-MARK/);
    assert.equal(r.rows.find((x) => x.ts === T0 - 20 * MIN)!.private, false, "主人的私聊照常显示");
    assert.ok(r.rows.filter((x) => x.src === "bili" || x.src === "remind").every((x) => !x.private && x.text));
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

// 访客的私聊，正文以「Note: 」开头，senses.py 标成了群：名单读不了时分不出它和真的群
const MISLABEL = "MISLABEL-MARK-5b7e";
const MISLABELLED: GateSeed = { ts: T0 - 45 * MIN, id: "m1", src: "wx", conv: "小客", sender: "Note", isGroup: true, text: `小客：Note: ${MISLABEL}`, route: "judge", action: "judge", verdict: "main", when: "now", gist: `${MISLABEL} 的要点`, why: "问她", delivered: 1 };

/** 名单或底子读不了：聊天来源（wx / xhs）的行全遮，群也遮；别的来源照常 */
function assertAllChatHidden(body: string): void {
  const r = JSON.parse(body) as GateBody;
  for (const m of [SECRET, MISLABEL, "OWNER-MARK", "STRANGER-MARK", "GROUP-MARK"]) assert.ok(!body.includes(m), m);
  const chat = r.rows.filter((x) => x.src === "wx" || x.src === "xhs");
  assert.equal(chat.length, 6);
  assert.ok(chat.every((x) => x.private && x.text === null && x.gist === null && x.why === null && x.do === null && x.body === null));
  const mis = r.rows.find((x) => x.ts === MISLABELLED.ts)!;
  assert.deepEqual([mis.conv, mis.sender], ["小客", null], "发话人是正文开头：不给");
  const other = r.rows.filter((x) => x.src !== "wx" && x.src !== "xhs");
  assert.equal(other.length, 4);
  assert.ok(other.every((x) => !x.private && x.text), "不是聊天来源的照常显示");
  assert.equal(r.stats.fallbackWhy["访客私聊（不显示原文）"], 1);
  assert.equal(r.stats.fallbackWhy["小判断超时"], 2);
}

test("/api/gate privacy: registry unreadable (broken or missing) → every chat-source row is private, groups included", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, [...DAY_ROWS, MISLABELLED]);
    const check = async () => {
      const body = await (await fetch(base + "/api/gate")).text();
      assert.equal((JSON.parse(body) as GateBody).registryOk, false);
      assertAllChatHidden(body);
    };
    await check();
    rmSync(join(f.dir, "ws", "memory", "people", "registry.json"));
    await check();
  }, (f) => gateWorkspace(f, "{broken"));
});

// fix round 1：被标成群的访客私聊、只认得出发话人的、小红书 / B站私信、认不出是谁的、显示名冒充主人的、没批过的「主人」
const M = (n: number): string => `PRIV-MARK-${n}-e2d4`;
const HARD_ROWS: GateSeed[] = [
  // senses.py 把正文以「Note: 」开头的私聊标成群，发话人是正文开头那个词（C1）
  { ts: T0 - 59 * MIN, id: "c1", src: "wx", conv: "小客", sender: "Note", isGroup: true, text: `小客：Note: ${M(1)} 明天`, route: "judge", action: "judge", verdict: "main", when: "now", gist: `${M(1)} 的要点`, why: `${M(1)} 的原因`, delivered: 1 },
  { ts: T0 - 58 * MIN, id: "c2", src: "xhs", conv: "客客", sender: "Re", isGroup: true, text: `客客 私信你：[2条]Re: ${M(2)}`, route: "judge", action: "judge", verdict: "digest", gist: `${M(2)} 的要点`, why: "不急" },
  // 只认得出发话人：没有会话名、会话名不是人（M9）
  { ts: T0 - 57 * MIN, id: "s1", src: "wx", sender: "小客", isGroup: false, text: `小客：${M(3)}`, route: "rule", rule: "r", action: "digest" },
  { ts: T0 - 56 * MIN, id: "s2", src: "wx", conv: "临时会话", sender: "小客", isGroup: false, text: `小客：${M(4)}`, route: "rule", rule: "r", action: "digest" },
  // B站私信的访客（M9）
  { ts: T0 - 55 * MIN, id: "b1", src: "bili_dm", conv: "客B", sender: "客B", isGroup: false, text: `客B：${M(5)}`, route: "judge", action: "judge", verdict: "drop", gist: `${M(5)} 的要点`, why: "闲聊" },
  // 会话名、发话人都没有：认不出是谁（M2）
  { ts: T0 - 54 * MIN, id: "n1", src: "wx", text: `${M(6)} 没头没尾`, route: "rule", rule: "r", action: "drop" },
  // 小红书显示名和主人的一样：不算核实，照样遮（M3）
  { ts: T0 - 53 * MIN, id: "o1", src: "xhs", conv: "主人号", sender: "主人号", isGroup: false, text: `主人号 私信你：${M(7)}`, route: "fixed-main", action: "fixed-main", when: "now", delivered: 1 },
  // 文件里改成主人、底子里还是访客（M1）
  { ts: T0 - 52 * MIN, id: "u1", src: "wx", conv: "阿升", sender: "阿升", isGroup: false, text: `阿升：${M(8)}`, route: "fixed-main", action: "fixed-main", when: "now", delivered: 1 },
  // 对照：主人的微信私聊（备注认出、底子里是主人）、陌生人被标成群的私聊，都照常显示
  { ts: T0 - 51 * MIN, id: "k1", src: "wx", conv: "主人备注", sender: "主人备注", isGroup: false, text: "主人备注：OWNER-WX-OK", route: "fixed-main", action: "fixed-main", when: "now", delivered: 1 },
  { ts: T0 - 50 * MIN, id: "k2", src: "wx", conv: "路人丙", sender: "Note", isGroup: true, text: "路人丙：Note: STRANGER-NOTE-OK", route: "judge", action: "judge", verdict: "drop", gist: "陌生人", why: "无关" },
  // relay：她跟访客聊的会话转述访客说了什么（fix round 3 N1），不管名单都遮
  { ts: T0 - 49 * MIN, id: "rl1", src: "relay", text: `访客说 ${M(9)}；我答应了`, route: "judge", action: "judge", verdict: "drop", gist: `${M(9)} 的要点`, why: `${M(9)} 的原因` },
];

test("/api/gate privacy (fix round 1): a guest's chat title hides the row whatever isGroup says; sender-only guests, xhs / bili_dm guests, unattributable chats, display-name owners and unapproved owners are hidden too", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, HARD_ROWS);
    const body = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(body) as GateBody;
    assert.equal(r.total, HARD_ROWS.length);
    for (let i = 1; i <= 9; i++) assert.ok(!body.includes(M(i)), M(i));
    const at = (id: string) => r.rows.find((x) => x.ts === HARD_ROWS.find((h) => h.id === id)!.ts)!;
    for (const id of ["c1", "c2", "s1", "s2", "b1", "n1", "o1", "u1", "rl1"]) {
      const x = at(id);
      assert.equal(x.private, true, id);
      assert.deepEqual([x.text, x.gist, x.why, x.do, x.body], [null, null, null, null, null], id);
    }
    // 被标成群的私聊：发话人是正文开头，不给；会话名照常
    assert.deepEqual([at("c1").conv, at("c1").sender], ["小客", null]);
    assert.deepEqual([at("c2").conv, at("c2").sender], ["客客", null]);
    assert.ok(!body.includes('"Re"'), "被标成群的访客私聊：正文开头那个词不出");
    assert.equal(body.split('"sender":"Note"').length - 1, 1, "只有陌生人那条带着 Note");
    assert.deepEqual([at("b1").conv, at("b1").sender], ["客B", "客B"], "发话人和会话名一样的照常给");
    const owner = at("k1");
    assert.equal(owner.private, false, "主人的微信私聊照常显示");
    assert.equal(owner.text, "主人备注：OWNER-WX-OK");
    const stranger = at("k2");
    assert.equal(stranger.private, false, "陌生人被标成群的私聊照常显示");
    assert.equal(stranger.sender, "Note");
    assert.match(stranger.text ?? "", /STRANGER-NOTE-OK/);
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

// #0042：名单 handles 里没有、事件库里那个人的别名有的名字（访客的小红书名、主人的一个微信名、文件里写成主人但没批过的阿升的小红书名）。
// 控制台遮行时库里的名字不排除主人（final-review R-2）：认出主人也是没核实的（按显示名），一对一就遮；阿升按底子是访客，也遮
const ALIAS_MARK = "ALIAS-MARK-3c9d";
const OWNER_ALIAS_MARK = "OWNER-ALIAS-MARK-7e21";
const RAISED_ALIAS_MARK = "RAISED-ALIAS-MARK-5b0a";
const ALIAS_ROWS: GateSeed[] = [
  { ts: T0 - 15 * MIN, id: "al1", src: "xhs", conv: "Foo Handle", sender: "Foo Handle", isGroup: false, text: `Foo Handle 私信你：${ALIAS_MARK}`, route: "judge", action: "judge", verdict: "main", when: "now", gist: `${ALIAS_MARK} 的要点`, why: `${ALIAS_MARK} 的原因`, delivered: 1 },
  { ts: T0 - 14 * MIN, id: "al2", src: "wx", conv: "Own Alias", sender: "Own Alias", isGroup: false, text: `Own Alias：${OWNER_ALIAS_MARK}`, route: "judge", action: "judge", verdict: "main", when: "now", delivered: 1 },
  { ts: T0 - 13 * MIN, id: "al3", src: "xhs", conv: "Raised Alias", sender: "Raised Alias", isGroup: false, text: `Raised Alias 私信你：${RAISED_ALIAS_MARK}`, route: "judge", action: "judge", verdict: "main", when: "now", gist: `${RAISED_ALIAS_MARK} 的要点`, delivered: 1 },
];
const aliasEntities = (db: DatabaseSync): void => {
  const ins = db.prepare("INSERT INTO mem_entity (id, kind, name, aliases, person_key) VALUES (?, 'person', ?, ?, ?)");
  ins.run("t1", "小客", JSON.stringify(["Foo Handle"]), "guest");
  ins.run("t2", "主人", JSON.stringify(["Own Alias"]), "owner");
  ins.run("t3", "阿升", JSON.stringify(["Raised Alias"]), "raised");
};

test("/api/gate privacy (#0042): a one-on-one from a name her memory has for a registry guest is private; so is one from the owner's memory name (unverified) and from an unapproved file-owner's (capped to guest, final-review R-2); without the event tables it works as before", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, [...DAY_ROWS, ...ALIAS_ROWS]);
    aliasEntities(f.db);
    const body = await (await fetch(base + "/api/gate")).text();
    assert.ok(!body.includes(ALIAS_MARK), "库里认出的访客：原文、要点、原因都不出");
    assert.ok(!body.includes(SECRET));
    const r = JSON.parse(body) as GateBody;
    assert.equal(r.aliasOk, true);
    const guest = r.rows.find((y) => y.ts === ALIAS_ROWS[0]!.ts)!;
    assert.equal(guest.private, true);
    assert.deepEqual([guest.text, guest.gist, guest.why, guest.conv], [null, null, null, "Foo Handle"]);
    const owner = r.rows.find((y) => y.ts === ALIAS_ROWS[1]!.ts)!;
    assert.deepEqual([owner.private, owner.text], [true, null], "主人在库里的名字：认出是主人但没核实（按显示名），一对一遮");
    assert.ok(!body.includes(OWNER_ALIAS_MARK));
    const raised = r.rows.find((y) => y.ts === ALIAS_ROWS[2]!.ts)!;
    assert.deepEqual([raised.private, raised.text, raised.gist], [true, null, null], "文件里写成主人、底子里还是访客：按访客遮");
    assert.ok(!body.includes(RAISED_ALIAS_MARK));
    assert.equal(r.rows.find((x) => x.ts === T0 - 30 * MIN)!.private, false, "陌生人照常显示");
    assert.equal(r.rows.find((x) => x.ts === T0 - 20 * MIN)!.private, false, "主人的微信备注照常显示");
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
  // 没有事件库的表（老库）：不查库，和以前一样
  await withServer(async (base, f) => {
    f.db.exec("DROP TABLE mem_entity");
    seedGate(f.db, [...DAY_ROWS, ...ALIAS_ROWS]);
    const res = await fetch(base + "/api/gate");
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.ok(!body.includes(SECRET), "名单认出的访客照样遮");
    const r = JSON.parse(body) as GateBody;
    assert.equal(r.aliasOk, true, "表不在不算查库出错");
    const al = r.rows.find((x) => x.ts === ALIAS_ROWS[0]!.ts)!;
    assert.equal(al.private, false, "认不出：当陌生人，照常显示");
    assert.match(al.text ?? "", new RegExp(ALIAS_MARK));
    assert.equal(r.rows.find((x) => x.ts === T0 - 10 * MIN)!.private, true);
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate privacy (review M3): the memory-name lookup fails for a reason other than a missing table → every chat-source row is private, a stranger's one-on-one and groups included", async () => {
  await withServer(async (base, f) => {
    // 表结构不对（以后的迁移改坏了、库坏了）：查得到表、查不了列
    f.db.exec("DROP TABLE mem_entity; CREATE TABLE mem_entity (id TEXT PRIMARY KEY)");
    seedGate(f.db, [...DAY_ROWS, MISLABELLED]);
    const body = await (await fetch(base + "/api/gate")).text();
    const r = JSON.parse(body) as GateBody;
    assert.deepEqual([r.registryOk, r.baselineOk, r.aliasOk], [true, true, false]);
    const stranger = r.rows.find((x) => x.ts === T0 - 30 * MIN)!;
    assert.deepEqual([stranger.private, stranger.text], [true, null], "陌生人的私聊也遮");
    assertAllChatHidden(body);
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY)));
});

test("/api/gate privacy: no readable approval baseline (missing or broken) → every chat-source row is private, groups included", async () => {
  await withServer(async (base, f) => {
    seedGate(f.db, [...DAY_ROWS, MISLABELLED]);
    const check = async () => {
      const body = await (await fetch(base + "/api/gate")).text();
      const r = JSON.parse(body) as GateBody;
      assert.deepEqual([r.registryOk, r.baselineOk], [true, false]);
      assertAllChatHidden(body);
    };
    await check();   // 没有底子
    f.db.prepare("INSERT INTO kv (k, v) VALUES ('registry_approved', '{broken')").run();
    await check();   // 底子坏了
  }, (f) => gateWorkspace(f, JSON.stringify(REGISTRY), null));
});

test("/api/gate: 404 when the console has no gate options", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(base + "/api/gate")).status, 404);
  });
});

test("page: 下意识 opens the gate view; the retired perception region is only a label for old rows", () => {
  const html = consoleSource();
  assert.match(html, /<section id="gatepane"/);
  assert.match(html, /fetch\("\/api\/gate"/);
  assert.match(html, /<g class="region" data-gate="1"[^>]*>\s*<title>下意识（丘脑）：/, "大脑图上的下意识点开是闸门");
  assert.doesNotMatch(html, /data-src="perception-messages"/);
  const pr = /const PREGIONS = \[([^\]]*)\]/.exec(html);
  assert.ok(pr && !pr[1]!.includes("perception"), "完整输入的脑区列表里没有已停用的下意识");
  assert.match(html, /"perception-messages": regionText\("oldPerception"/, "旧记录照样显示");
  assert.match(flatPack("zh")["regions.oldPerception.where"]!, /^已停用/, "标成已停用");
  assert.match(html, /访客私聊（不显示原文）/);
});
