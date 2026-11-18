// 控制台的「事件记忆」：只读查 mem_* 表。用 EventStore 真写一个小库，再用只读连接查。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/store/db.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { openReadOnly } from "../src/console/data.ts";
import { recallCalls, prefixParts } from "../src/console/memory.ts";
import { splitPrefix } from "../src/console/prompt.ts";
import { batchOps, entityList, eventDetail, eventList, midtermView, overview, quoteList } from "../src/console/events.ts";
import { createConsole } from "../src/console/server.ts";
import { OPEN_READS } from "./console-reads.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 30, 3, 0);

function fixture() {
  const dir = tmpDir("hh-mem-");
  const dbPath = join(dir, "hh.db");
  const db = openDb(dbPath);
  const s = new EventStore(db, () => NOW);
  s.openBatch("night:2026-10-29/2026-10-29");
  const face = s.createEvent({
    title: "做脸", summary: "照官方分层重做才过审。", gist: "照官方分层重做才过", why: "第一次自己做出能用的形象", importance: 4, status: "done",
    entities: [{ name: "ada", kind: "person", role: "with" }, { name: "Live2D", kind: "work", role: "about" }],
  }, "night:2026-10-29/2026-10-29", "夜里整理");
  const a = s.addEntry({ event: face.id, at: NOW - 2 * DAY, kind: "happened", full: "下午照官方分层重做了脸，提交后过审。", gist: "重做的脸过审了", title: "过审", people: ["ada"], source: ["c:12"] }, "night:2026-10-29/2026-10-29").entry;
  s.addEntry({ event: face.id, at: NOW - DAY, kind: "said", full: "ada 说这次可以。", gist: "ada 说可以", title: "他说可以", people: ["ada"], source: ["q1"] }, "night:2026-10-29/2026-10-29");
  s.correctEntry(a.id, { full: "其实是晚上提交的，第二天早上才过审。", gist: "第二天早上才过审", title: "过审时间", why: "看了原话" }, "night:2026-10-29/2026-10-29");
  const old = s.createEvent({ title: "旧头像", summary: "很早以前的小事。", gist: "旧头像的事", importance: 0, status: "done", entities: [] }, "night:2026-10-29/2026-10-29");
  s.addEntry({ event: old.id, at: NOW - 400 * DAY, kind: "happened", full: "换过一次头像。", gist: "换头像", title: "换头像", people: ["小贝"], source: [] }, "night:2026-10-29/2026-10-29");
  s.link(old.id, face.id, "cause", "先有旧的才想重做", "night:2026-10-29/2026-10-29");
  s.commitBatch("night:2026-10-29/2026-10-29");
  s.openBatch("night:2026-10-30/2026-10-30");
  s.createEvent({ title: "撤回的", summary: "这一批没收尾。", gist: "没收尾", importance: 1, entities: [] }, "night:2026-10-30/2026-10-30");
  s.revertBatch("night:2026-10-30/2026-10-30");
  s.touch(face.id, "open", "main", NOW - 3600_000);
  s.touch(face.id, "auto", "main", NOW - 60_000);
  db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES (?, ?, ?, ?, ?, ?)").run("central", "12", NOW - 2 * DAY, "ada", "qq", "这次可以 50%_的把握");
  db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES (?, ?, ?, ?, ?, ?)").run("honcho", "h1", NOW - 9 * DAY, "小贝", "", "你好呀");
  // 回想工具：旧的 recall + 事件库的四种
  const c = new CentralMemory(db, () => NOW);
  c.append(1, "main", "act", 'remember {"cue":"做脸"}', { tool: "remember", id: "m1" });
  c.append(1, "main", "result", "想起来的（编号可以用 recall_event 展开）：\n· 做脸〔4〕e0001", { id: "m1" });
  c.append(1, "side-1", "act", 'recall_person {"who":"阿猫"}', { tool: "recall_person", id: "m2" });
  c.append(1, "side-1", "result", "不认识「阿猫」：记忆里没有这个人或东西。", { id: "m2" });
  c.append(1, "main", "act", 'recall_period {"when":"上周"}', { tool: "recall_period", id: "m3" });
  c.append(1, "main", "result", "10-20–10-26 没有记下的事。", { id: "m3" });
  // 状态目录：中期视图
  const state = join(dir, "state");
  mkdirSync(join(state, "exports"), { recursive: true });
  mkdirSync(join(dir, "ws"), { recursive: true });
  writeFileSync(join(state, "exports", "midterm.md"), "# 最近这一段\n\n每件事后面的编号或标题，用 recall_event 就能展开细想。\n\n## 今天\n\n（今天还没有）");
  return { dir, dbPath, db, state, face: face.id, old: old.id, entryA: a.id };
}

const touchCount = (dbPath: string): number => {
  const ro = openReadOnly(dbPath);
  try { return Number((ro.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n); } finally { ro.close(); }
};

test("overview: 老库（还没迁出 stance 列，控制台比 hhd 先重启）也能出总览", () => {
  const f = fixture();
  f.db.exec("ALTER TABLE mem_event DROP COLUMN stance");
  const ro = openReadOnly(f.dbPath);
  try {
    const o = overview(ro, NOW);
    assert.equal(o.ready, true);
    assert.equal(o.counts.events, 2);
  } finally { ro.close(); }
});

test("overview: 白天记喜好的批次（day-like:）不进批次列表（每记一下就是一批，会把夜里那几批挤掉），另给一个次数", () => {
  const f = fixture();
  const s = new EventStore(f.db, () => NOW);
  for (let i = 0; i < 3; i++) {
    const b = `day-like:${NOW + i}`;
    s.openBatch(b);
    s.createEvent({ title: `喜欢 第${i}个`, summary: "s", gist: "g", importance: 3, stance: "like", status: "ongoing" }, b);
    s.commitBatch(b);
  }
  s.openBatch("day-like:bad");
  s.createEvent({ title: "喜欢 没记成的", summary: "s", gist: "g", importance: 3, stance: "like", status: "ongoing" }, "day-like:bad");
  s.revertBatch("day-like:bad");
  const ro = openReadOnly(f.dbPath);
  try {
    const o = overview(ro, NOW);
    assert.ok(!o.batches.some((b) => b.id.startsWith("day-like:")), o.batches.map((b) => b.id).join(" "));
    assert.equal(o.batches.length, 3, "夜里、导入那几批照旧都在");
    assert.equal(o.dayLikes, 3, "只数记成了的");
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("overview: counts, status, importance, clarity, quotes by source, batches (reverted too), import progress", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const o = overview(ro, NOW);
    assert.equal(o.ready, true);
    assert.equal(o.counts.events, 2, "撤回的那批不算");
    assert.equal(o.counts.entries, 4);
    assert.equal(o.counts.corrections, 1);
    assert.equal(o.counts.quotes, 2);
    assert.deepEqual(o.importance, [1, 0, 0, 0, 1, 0]);
    assert.equal(o.clarity.full, 1);
    assert.equal(o.clarity.hidden, 1, "0 级、一年多前的事想不起来了");
    assert.deepEqual(o.quotes.map((q) => [q.src, q.n]), [["central", 1], ["honcho", 1]]);
    assert.deepEqual(o.batches.map((b) => b.state).sort(), ["committed", "reverted", "reverted"]);
    assert.ok(o.batches.find((b) => b.state === "committed")!.ops > 0);
    assert.equal(o.batches.find((b) => b.id === "night:2026-10-30/2026-10-30")!.ops, 0, "原批次名空出来了");
    assert.ok(o.batches.find((b) => b.id.startsWith("night:2026-10-30/2026-10-30~reverted@"))!.ops > 0, "撤回的明细挪到留档批次里还查得到");
    assert.equal("import" in o, false, "导入进度那一栏删了（11-13）");
    assert.ok(o.lastWrite);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("overview without the mem tables (hhd not migrated yet) is empty, not an error", () => {
  const dir = tmpDir("hh-mem0-");
  const p = join(dir, "x.db");
  const w = new DatabaseSync(p);
  w.exec("CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  w.close();
  const ro = openReadOnly(p);
  try {
    assert.equal(overview(ro, NOW).ready, false);
    assert.deepEqual(eventList(ro, NOW), { total: 0, items: [] });
    assert.equal(eventDetail(ro, "e0001", NOW), null);
    assert.deepEqual(entityList(ro), []);
    assert.deepEqual(quoteList(ro), { total: 0, items: [] });
  } finally { ro.close(); rmSync(dir, { recursive: true }); }
});

test("eventList: newest first, people, entry counts, clarity; filters by text, person, status, importance", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const all = eventList(ro, NOW);
    assert.equal(all.total, 2);
    assert.deepEqual(all.items.map((e) => e.id), [f.face, f.old]);
    const face = all.items[0]!;
    assert.deepEqual(face.people, ["ada"]);
    assert.equal(face.entries, 3);
    assert.equal(face.clarity, "full");
    assert.equal(face.touched, NOW - 3600_000, "auto 的碰不算");
    assert.deepEqual(all.items[1]!.people, ["小贝"]);
    assert.equal(all.items[1]!.clarity, "hidden");
    assert.deepEqual(eventList(ro, NOW, { q: "第二天早上" }).items.map((e) => e.id), [f.face], "按时间线里的字找");
    assert.deepEqual(eventList(ro, NOW, { q: "live2d" }).items.map((e) => e.id), [f.face], "按关联的东西找");
    assert.deepEqual(eventList(ro, NOW, { q: f.old }).items.map((e) => e.id), [f.old], "按编号找");
    assert.deepEqual(eventList(ro, NOW, { q: "%" }).items, [], "% 不当通配符");
    const xiao = entityList(ro).find((t) => t.name === "小贝")!;
    assert.deepEqual(eventList(ro, NOW, { who: xiao.id }).items.map((e) => e.id), [f.old], "时间线里出现的人也算");
    assert.deepEqual(eventList(ro, NOW, { min: 3 }).items.map((e) => e.id), [f.face]);
    assert.equal(eventList(ro, NOW, { status: "ongoing" }).total, 0);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("eventDetail: summary, entities with roles, link direction, timeline with correction pairing, touches, ops; entry id opens its event", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const d = eventDetail(ro, f.face, NOW)!;
    assert.equal(d.event.summary, "照官方分层重做才过审。");
    assert.equal(d.event.why, "第一次自己做出能用的形象");
    assert.deepEqual(d.entities.map((t) => [t.name, t.role]), [["ada", "with"], ["Live2D", "about"]]);
    assert.deepEqual(d.links.map((l) => [l.rel, l.id, l.title]), [["cause", f.old, "旧头像"]], "从做脸看，旧头像是起因");
    assert.deepEqual(eventDetail(ro, f.old, NOW)!.links.map((l) => [l.rel, l.id]), [["followup", f.face]], "从旧头像看，做脸是后续");
    assert.deepEqual(d.entries.map((n) => n.kind), ["happened", "correction", "said"], "更正和原条目同一个时间，挨着");
    const [first, fix, said] = d.entries;
    assert.equal(first!.correctedBy, fix!.id);
    assert.equal(fix!.corrects, first!.id);
    assert.deepEqual(said!.source, ["q1"]);
    assert.deepEqual(first!.people, ["ada"]);
    assert.ok(d.touches.some((t) => t.how === "open") && d.touches.some((t) => t.how === "auto"));
    assert.ok(d.ops.some((o) => o.tbl === "mem_event"), "建事件那一步");
    assert.ok(d.ops.some((o) => o.tbl === "mem_link"), "关联那一步（组合键里带着事件编号）");
    assert.ok(d.ops.some((o) => o.tbl === "mem_entry"), "条目那几步");
    const viaEntry = eventDetail(ro, f.entryA, NOW)!;
    assert.equal(viaEntry.event.id, f.face);
    assert.equal(viaEntry.focus, f.entryA);
    assert.equal(eventDetail(ro, "e9999", NOW), null);
    assert.equal(eventDetail(ro, "x'; DROP", NOW), null);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("子事件：列表里带 parent；详情里写属于哪件、下面有哪些子事件（标题、一句话、条数、状态）", () => {
  const dir = tmpDir("hh-mem-kids-");
  try {
    const db = openDb(join(dir, "hh.db"));
    const s = new EventStore(db, () => NOW);
    const big = s.createEvent({ title: "B站30天挑战", summary: "s", gist: "养活自己", importance: 5, why: "w", entities: [] }, "b");
    const kid = s.createEvent({ title: "祥子那期", summary: "s", gist: "第一条带内容的视频", importance: 3, parent: big.id, entities: [] }, "b");
    s.addEntry({ event: kid.id, at: NOW - DAY, kind: "happened", full: "发出去了", gist: "发了", title: "发布", people: [], source: ["c:1"] }, "b");
    const ro = new DatabaseSync(join(dir, "hh.db"), { readOnly: true });
    assert.equal(eventList(ro, NOW).items.find((e) => e.id === kid.id)!.parent, big.id);
    const d = eventDetail(ro, big.id, NOW)!;
    assert.equal(d.parent, null);
    assert.deepEqual(d.children, [{ id: kid.id, title: "祥子那期", gist: "第一条带内容的视频", status: "ongoing", entries: 1 }]);
    assert.deepEqual(eventDetail(ro, kid.id, NOW)!.parent, { id: big.id, title: "B站30天挑战" });
    ro.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("entities, quotes (filters, paging, literal %), batch ops with before/after", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const ents = entityList(ro);
    const g = ents.find((t) => t.name === "ada")!;
    assert.equal(g.kind, "person");
    assert.equal(g.events, 1);
    assert.equal(g.entries, 2);
    assert.ok(ents.find((t) => t.name === "Live2D"));
    assert.equal(quoteList(ro).total, 2);
    assert.deepEqual(quoteList(ro).items.map((q) => q.who), ["ada", "小贝"], "新的在前");
    assert.deepEqual(quoteList(ro, { src: "honcho" }).items.map((q) => q.who), ["小贝"]);
    assert.deepEqual(quoteList(ro, { q: "50%_" }).items.map((q) => q.who), ["ada"]);
    assert.equal(quoteList(ro, { q: "%" }).total, 1, "% 只配字面的 %");
    assert.deepEqual(quoteList(ro, { offset: 1, limit: 1 }).items.map((q) => q.who), ["小贝"]);
    assert.deepEqual(quoteList(ro, { q: "q2" }).items.map((q) => q.who), ["小贝"], "q<编号> 直接找那一条（条目的出处就这么写）");
    const b = batchOps(ro, "night:2026-10-29/2026-10-29");
    assert.equal(b.batch!.state, "committed");
    const create = b.ops.find((o) => o.tbl === "mem_event")!;
    assert.equal(create.before, null);
    assert.match(create.after!, /做脸/);
    assert.equal(batchOps(ro, "nope").batch, null);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("midterm export, recall stats count the new tools", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    assert.match(midtermView(f.state)!.text, /^# 最近这一段/);
    assert.equal(midtermView(join(f.dir, "none")), null);
    const r = recallCalls(ro);
    assert.deepEqual(r.map((x) => [x.tool, x.query, x.found]), [
      ["recall_period", '{"when":"上周"}', false], ["recall_person", '{"who":"阿猫"}', false], ["remember", '{"cue":"做脸"}', true],
    ]);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("prefix: the mid-term view sits after memory files and before blocks (memory lens and 完整输入)", () => {
  const parts = prefixParts("/nonexistent", ["SOUL.md", "ledger/SOUL.md"], "说明", [{ id: 1, tokens: 10, chars: 5 }], { frame: "# 你的人生", files: new Set(["ledger/SOUL.md"]), midterm: "# 最近这一段\n\n今天" });
  assert.deepEqual(parts.map((p) => p.name), ["运行说明", "SOUL.md", "过渡句", "ledger/SOUL.md", "中期视图", "压缩记忆 第 1 段"]);
  const prefix = "# 你现在的运行方式\n\n你是阿青。\n\n---\n\n<file path=\"SOUL.md\">\n人格\n</file>\n\n---\n\n# 你的人生\n\n下面是你自己的记忆。\n\n<file path=\"ledger/SOUL.md\">\n账本\n</file>\n\n# 最近这一段\n\n每件事后面的编号。\n\n## 今天\n\n- 09:00 做脸\n\n## 这次醒来以后（压缩过的记忆）\n\n### 第 1 段\n\n早上";
  const seg = splitPrefix(prefix);
  assert.deepEqual(seg.map((x) => x.label), ["HH 运行说明", "人格文件 SOUL.md", "过渡句：你的人生", "记忆文件 ledger/SOUL.md", "中期记忆（事件库最近这一段）", "压缩记忆（这次醒来以后）"]);
  assert.ok(seg[3]!.text.endsWith("</file>"), "账本不粘上中期视图");
  assert.ok(seg[4]!.text.includes("## 今天"));
});

test("server: /api/mem* endpoints answer and reading never writes a touch", async () => {
  const f = fixture();
  const before = touchCount(f.dbPath);
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "projects"), logPath: join(f.dir, "l.jsonl"),
    pageHtml: "<!doctype html>", now: () => NOW,
    memory: { workspace: join(f.dir, "ws"), stateDir: f.state, limits: { pageTokens: 1, maxContextTokens: 1, sleepyAtTokens: 1, mustSleepAtTokens: 2 }, files: [], runtimeNote: "x", events: { enabled: true, inject: false, midterm: false } },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  try {
    const m = await get("/api/mem");
    assert.equal(m.status, 200);
    assert.equal((m.body.flags as { inject: boolean }).inject, false);
    assert.equal((m.body.counts as { events: number }).events, 2);
    assert.equal(m.body.compareDays, undefined, "联想对比那一页删了（11-13），总览不再带它的日子");
    assert.ok((m.body.midterm as { tokens: number }).tokens > 0);
    assert.equal(m.body.vectors, null, "hhd 还没导出向量的情况");
    writeFileSync(join(f.state, "exports", "vectors.json"), JSON.stringify({ at: NOW, missing: 37, lastError: "HTTP 429 insufficient_quota", lastErrorAt: NOW - 60_000, lastOkAt: NOW - 3_600_000, pausedUntil: NOW + 540_000 }));
    assert.deepEqual((await get("/api/mem")).body.vectors, { at: NOW, missing: 37, lastError: "HTTP 429 insufficient_quota", lastErrorAt: NOW - 60_000, lastOkAt: NOW - 3_600_000, pausedUntil: NOW + 540_000 });
    assert.equal(((await get("/api/mem/events?q=做脸")).body.items as unknown[]).length, 1);
    assert.equal((await get(`/api/mem/event?id=${f.face}`)).status, 200);
    assert.equal((await get("/api/mem/event?id=e9999")).status, 404);
    assert.ok(((await get("/api/mem/entities")).body.entities as unknown[]).length >= 3);
    assert.equal((await get("/api/mem/quotes?src=central")).body.total, 1);
    assert.equal(((await get("/api/mem/batch?id=" + encodeURIComponent("night:2026-10-29/2026-10-29"))).body.ops as unknown[]).length > 0, true);
    assert.equal((await get("/api/mem/batch")).status, 400);
    assert.equal((await get("/api/mem/midterm")).body.inPrefix, false);
    assert.equal((await get("/api/mem/compare")).status, 404, "联想对比的接口删了");
    const mem = await get("/api/memory");
    assert.equal((mem.body.events as { ready: boolean }).ready, true);
    assert.equal(touchCount(f.dbPath), before, "翻看不算她碰过");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("overview: the database half is read once while nobody writes, clarity still follows the clock, and a write by anyone is seen on the next call", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  // 记下这条连接上准备过哪些查询（只留开头两个词）
  const asked: string[] = [];
  const prepare = ro.prepare.bind(ro);
  ro.prepare = ((sql: string) => { asked.push(sql.trim().split(/\s+/).slice(0, 2).join(" ")); return prepare(sql); }) as typeof ro.prepare;
  try {
    const first = overview(ro, NOW);
    assert.ok(asked.length > 10, `第一次把那几张表都读一遍（${asked.length} 句）`);
    assert.deepEqual([first.clarity.full, first.clarity.hidden], [1, 1]);
    asked.length = 0;
    const again = overview(ro, NOW + 30_000);
    assert.deepEqual(asked, ["PRAGMA data_version"], "库没人写：只问一句库变没变，不再读表");
    assert.deepEqual(again, first);
    assert.ok(again.counts !== first.counts && again.batches !== first.batches, "给出去的是一份新的，改了它不会改到记着的那一份");
    // 清晰度按给的时刻算，不读库：往回拨四百天，那件一年多前的小事还没淡
    asked.length = 0;
    const earlier = overview(ro, NOW - 400 * DAY);
    assert.deepEqual(asked, ["PRAGMA data_version"]);
    assert.deepEqual([earlier.clarity.full, earlier.clarity.hidden ?? 0], [2, 0]);
    assert.deepEqual(earlier.counts, first.counts);
    // 别的连接写了一笔（哪张表都算）：下一次重读，看得到
    const s = new EventStore(f.db, () => NOW);
    s.createEvent({ title: "新的一件", summary: "s", gist: "g", importance: 3, status: "ongoing", entities: [] }, "b1");
    asked.length = 0;
    const fresh = overview(ro, NOW);
    assert.ok(asked.length > 10, "库变了：重读");
    assert.equal(fresh.counts.events, (first.counts.events ?? 0) + 1);
    asked.length = 0;
    assert.deepEqual([overview(ro, NOW).counts.events, asked], [fresh.counts.events, ["PRAGMA data_version"]]);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("overview/eventList: 喜欢中的老事 clarity 是 full，腻了就按重要度淡", () => {
  const f = fixture();
  const s = new EventStore(f.db, () => NOW - 400 * DAY);
  const like = s.createEvent({ title: "老喜欢", summary: "s", gist: "g", importance: 2, status: "ongoing", stance: "like", entities: [] }, "b1");
  const ro = openReadOnly(f.dbPath);
  try {
    assert.equal(eventList(ro, NOW).items.find((e) => e.id === like.id)!.clarity, "full");
    assert.equal(overview(ro, NOW).clarity.full, 2);
    assert.equal(eventDetail(ro, like.id, NOW)!.event.clarity, "full");
  } finally { ro.close(); }
  f.db.prepare("UPDATE mem_event SET status = 'done' WHERE id = ?").run(like.id);
  const ro2 = openReadOnly(f.dbPath);
  try {
    assert.notEqual(eventList(ro2, NOW).items.find((e) => e.id === like.id)!.clarity, "full");
  } finally { ro2.close(); }
});
