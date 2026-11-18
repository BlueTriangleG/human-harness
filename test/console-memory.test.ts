// 控制台的记忆页：一页一页、压缩记忆、前缀组成、长期记忆文件、回想。临时目录里的假数据。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openDb } from "../src/store/db.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import { openReadOnly } from "../src/console/data.ts";
import {
  areas, blockList, blockText, centralTotals, organizer, pages, prefixParts, readMemoryFile, recallCalls, recentlyChanged, wakeOpenings,
} from "../src/console/memory.ts";
import { createConsole } from "../src/console/server.ts";
import { DEMO_MEMORY_PAGE } from "./console-demo.ts";
import { OPEN_READS } from "./console-reads.ts";

const T0 = Date.UTC(2026, 9, 29, 8, 0, 0);
const FILES = ["IDENTITY.md", "MEMORY.md", "ledger/SOUL.md"];

function fixture() {
  const dir = tmpDir("hh-mem-");
  const dbPath = join(dir, "state", "hh.db");
  const db = openDb(dbPath);
  let t = T0;
  const central = new CentralMemory(db, () => t);
  const epochs = new Epochs(db, () => t);
  // 第 1 页：开机 → 翻页压成第 1 段
  epochs.begin("boot", 1);
  central.append(1, "外界", "input", "早", { from: "ada" });
  central.append(1, "main", "say", "早呀");
  central.append(1, "perception-messages", "think", "下意识自己琢磨的很长很长".repeat(20), { inner: true });
  t += 60_000;
  epochs.addBlock(1, "第一段压缩记忆：早上和 ada 打了招呼。");
  epochs.begin("page-turn", 4);
  // 第 2 页：睡觉整理 → 压缩块清空，醒来开第 3 页
  central.append(2, "main", "act", 'recall {"args":["search","视频"]}', { tool: "recall", id: "r1" });
  central.append(2, "main", "result", "#12 [10-29 07:00] ada说：视频剪完了吗", { id: "r1" });
  central.append(2, "main", "act", 'recall {"args":["search","不存在"]}', { tool: "recall", id: "r2" });
  central.append(2, "main", "result", "自己的记忆里没找到；Honcho 现在也查不了（x）。", { id: "r2" });
  t += 60_000;
  epochs.clearBlocks();
  epochs.begin("wake", 8);
  // 第 3 页：重启 → 第 4 页（现在这页）
  central.append(3, "main", "say", "醒了");
  epochs.addBlock(3, "第二段：醒来以后剪了视频。");
  epochs.begin("boot", 9);
  central.append(4, "main", "say", "接着做");

  const ws = join(dir, "ws");
  for (const d of ["ledger", "memory/threads", "memory/people", "memory/compactions", "memory/anime", "memory/.dreams", "memory/empty", "soul", "sleep/2026-10-28", "skills", "guests/xiaobei"]) mkdirSync(join(ws, d), { recursive: true });
  writeFileSync(join(ws, "memory/.dreams/x.md"), "隐藏");
  writeFileSync(join(ws, "IDENTITY.md"), "我是米拉");
  writeFileSync(join(ws, "MEMORY.md"), "记忆".repeat(100));
  writeFileSync(join(ws, "memory/2026-10-28.md"), "昨天");
  writeFileSync(join(ws, "memory/threads/B站.md"), "事件线");
  writeFileSync(join(ws, "memory/people/ada.md"), "ada");
  writeFileSync(join(ws, "memory/compactions/old.md"), "旧存档");
  writeFileSync(join(ws, "memory/anime/list.md"), "番");
  writeFileSync(join(ws, "memory/threads/notes.json"), "{}");
  writeFileSync(join(ws, "soul/20-性格.md"), "性格");
  writeFileSync(join(ws, "skills/a.md"), "手册");
  mkdirSync(join(ws, "scripts"), { recursive: true });
  writeFileSync(join(ws, "scripts/a.md"), "脚本说明");
  writeFileSync(join(ws, "guests/xiaobei/s.md"), "访客");
  writeFileSync(join(ws, "sleep/state.json"), JSON.stringify({ last_done: "2026-10-28", last_applied_at: "2026-10-29T02:43:50+11:00" }));
  writeFileSync(join(ws, "sleep/2026-10-28/report.md"), "报告");
  const old = (T0 - 5 * 86_400_000) / 1000;
  utimesSync(join(ws, "memory/people/ada.md"), old, old);
  utimesSync(join(ws, "soul/20-性格.md"), old, old);
  const hh = join(dir, "state");
  mkdirSync(join(hh, "sleep"), { recursive: true });
  writeFileSync(join(hh, "sleep/2026-10-28T16-00-20-875Z.md"), "整理稿");
  writeFileSync(join(dir, "outside.md"), "外面的文件");
  symlinkSync(join(dir, "outside.md"), join(ws, "memory/escape.md"));
  // 早上的开头存档（hhd 存的）和那个目录里不该给看的几样
  mkdirSync(join(hh, "wake/2026-10-26-070000.md"), { recursive: true });               // 名字对、可它是个目录
  writeFileSync(join(hh, "wake/2026-10-28-064500.md"), "===== 前缀 =====\n昨天的开头");
  writeFileSync(join(hh, "wake/2026-10-29-073012.md"), "===== 前缀 =====\n今天的开头");
  writeFileSync(join(hh, "wake/notes.md"), "别的文件");
  writeFileSync(join(hh, "wake/2026-10-29-073012.md.bak"), "备份");
  symlinkSync(join(dir, "outside.md"), join(hh, "wake/2026-10-27-070000.md"));          // 名字对、可它指到外面
  return { dir, dbPath, db, ws, hh };
}

test("pages: how each page ended, tokens without the subconscious's inner process, which block it became", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const p = pages(ro);
    assert.deepEqual(p.map((x) => [x.id, x.reason, x.end]), [[1, "boot", "page-turn"], [2, "page-turn", "sleep"], [3, "wake", "restart"], [4, "boot", "current"]]);
    assert.equal(p[0]!.rows, 3);
    const inner = ro.prepare("SELECT tokens FROM central WHERE seq = 3").get() as { tokens: number };
    const all = ro.prepare("SELECT SUM(tokens) AS t FROM central WHERE epoch = 1").get() as { t: number };
    assert.equal(p[0]!.tokens, all.t - inner.tokens);
    assert.equal(p[0]!.block?.id, 1);
    assert.ok(p[0]!.block?.cleared);          // 睡觉整理过
    assert.equal(p[1]!.block, null);
    assert.equal(p[2]!.block?.id, 2);
    assert.equal(p[2]!.block?.cleared, null);  // 还在前缀里
    assert.equal(pages(ro, 2).map((x) => x.id).join(), "3,4");
    assert.equal(pages(ro, 2)[1]!.end, "current");
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("pages / centralTotals count incrementally on one connection and always equal a fresh count: after more rows, after a page turn moves the tail to a new page, across many pages, after the periodic full recount", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  let now = T0;
  // 同一个连接上接着数的，和新开一个连接整张现数的，每一步都要一样
  const same = (why: string): void => {
    const d = openReadOnly(f.dbPath);
    try {
      assert.deepEqual(pages(ro, 60, now), pages(d, 60, now), `pages：${why}`);
      assert.deepEqual(centralTotals(ro, now), centralTotals(d, now), `centralTotals：${why}`);
    } finally { d.close(); }
  };
  try {
    let t = T0 + 500_000;
    const central = new CentralMemory(f.db, () => t);
    const epochs = new Epochs(f.db, () => t);
    same("第一次");
    assert.equal(centralTotals(ro, now).rows, 9);
    // 现在这一页接着写（带一条下意识的内部过程、一条导入的）
    central.append(4, "main", "think", "再想想");
    central.append(4, "perception-messages", "think", "内部".repeat(50), { inner: true });
    central.append(4, "外界", "input", "旧的", { imported: true });
    same("多了三行");
    assert.equal(centralTotals(ro, now).rows, 12);
    assert.equal(centralTotals(ro, now).imported, 1);
    // 翻页：切页点之后写进来的那两行改归新的一页（central.retag），老页的数要跟着少
    const cut = Number((f.db.prepare("SELECT MAX(seq) AS s FROM central").get() as { s: number }).s) - 2;
    t += 60_000;
    epochs.begin("page-turn", cut + 1);
    assert.equal(central.retag(cut, 5), 2);
    same("翻页挪了两行");
    assert.deepEqual(pages(ro, 60, now).slice(-2).map((x) => [x.id, x.rows, x.end]), [[4, 2, "page-turn"], [5, 2, "current"]]);
    // 再翻很多页：早的页不再重数，数还得对
    for (let e = 6; e <= 12; e++) {
      t += 60_000;
      epochs.begin("page-turn", Number((f.db.prepare("SELECT MAX(seq) AS s FROM central").get() as { s: number }).s) + 1);
      central.append(e, "main", "say", `第 ${e} 页的话`);
      central.append(e, "main", "think", "想".repeat(e));
      same(`第 ${e} 页`);
    }
    // 一页的行全被挪走：那一页不该还留着旧的数
    assert.equal(central.retag(Number((f.db.prepare("SELECT MIN(seq) AS s FROM central WHERE epoch = 12").get() as { s: number }).s) - 1, 13), 2);
    t += 1000;
    epochs.begin("page-turn", Number((f.db.prepare("SELECT MIN(seq) AS s FROM central WHERE epoch = 13").get() as { s: number }).s));
    same("第 12 页的行全挪到第 13 页");
    assert.equal(pages(ro, 60, now).find((x) => x.id === 12)!.rows, 0);
    // 过了十分钟：整张重数一遍，还是一样；钟往回拨也重数
    now += 11 * 60_000;
    central.append(13, "main", "say", "十分钟以后");
    same("十分钟后的重数");
    now -= 60 * 60_000;
    same("钟往回拨");
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("blocks: newest first, preview, cleared flag, full text by id", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const b = blockList(ro);
    assert.deepEqual(b.map((x) => [x.id, x.cleared === null]), [[2, true], [1, false]]);
    assert.equal(b[0]!.preview, "第二段：醒来以后剪了视频。");
    assert.equal(blockText(ro, 1), "第一段压缩记忆：早上和 ada 打了招呼。");
    assert.equal(blockText(ro, 99), null);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("central totals and recall calls (found / not found)", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const c = centralTotals(ro);
    assert.equal(c.rows, 9);
    assert.ok(c.tokens > 0);
    const r = recallCalls(ro);
    assert.deepEqual(r.map((x) => [x.query, x.found]), [['{"args":["search","不存在"]}', false], ['{"args":["search","视频"]}', true]]);
  } finally { ro.close(); f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("prefix parts: runtime note, persona files (missing flagged), active blocks", () => {
  const f = fixture();
  try {
    const parts = prefixParts(f.ws, [...FILES, "NOPE.md"], "运行说明全文", [{ id: 2, tokens: 50, chars: 13 }]);
    assert.deepEqual(parts.map((p) => [p.name, p.kind]), [["运行说明", "note"], ["IDENTITY.md", "file"], ["MEMORY.md", "file"], ["ledger/SOUL.md", "file"], ["NOPE.md", "file"], ["压缩记忆 第 1 段", "block"]]);
    assert.equal(parts[2]!.chars, 200);
    assert.ok(parts[2]!.tokens > 0);
    assert.equal(parts[3]!.missing, true);     // ledger/SOUL.md 没建
    assert.equal(parts[4]!.missing, true);
    assert.equal(parts[5]!.blockId, 2);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("prefix parts follow buildPrefix order: persona files, then the 你的人生 frame, then memory files and blocks", () => {
  const f = fixture();
  try {
    const parts = prefixParts(f.ws, FILES, "说明", [{ id: 2, tokens: 50, chars: 13 }], { frame: "# 你的人生\n\n接下来是你经历的人生。", files: new Set(["ledger/SOUL.md"]) });
    assert.deepEqual(parts.map((p) => p.name), ["运行说明", "IDENTITY.md", "MEMORY.md", "过渡句", "ledger/SOUL.md", "压缩记忆 第 1 段"]);
    assert.equal(parts[3]!.kind, "note");
    assert.ok(parts[3]!.tokens > 0);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("prefix parts: the shelf sits between persona files and the frame, like buildPrefix; no shelf, no part", () => {
  const f = fixture();
  try {
    const shelf = "# 我的书架\n我的做法和教训都记在这些笔记本里。\n\n## 做事\n- 剪辑：剪片子（2 页）";
    const memory = { frame: "# 你的人生\n\n接下来是你经历的人生。", files: new Set(["ledger/SOUL.md"]) };
    const parts = prefixParts(f.ws, FILES, "说明", [], { ...memory, shelf });
    assert.deepEqual(parts.map((p) => p.name), ["运行说明", "IDENTITY.md", "MEMORY.md", "书架目录", "过渡句", "ledger/SOUL.md"]);
    assert.equal(parts[3]!.kind, "note");
    assert.equal(parts[3]!.chars, shelf.length);
    assert.ok(parts[3]!.tokens > 0);
    assert.ok(!prefixParts(f.ws, FILES, "说明", [], { ...memory, shelf: "" }).some((p) => p.name === "书架目录"));
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("areas: known dirs get names, other memory dirs listed as-is, compactions and guests left out, only .md counted", () => {
  const f = fixture();
  try {
    const a = areas(f.ws, DEMO_MEMORY_PAGE);
    const by = new Map(a.map((x) => [x.dir, x]));
    assert.equal(by.get("memory")!.label, "每日笔记");
    assert.equal(by.get("memory")!.files, 1);              // 只算顶层的 .md
    assert.equal(by.get("memory/threads")!.files, 1);      // notes.json 不算
    assert.equal(by.get("memory/anime")!.label, "anime");
    assert.ok(!by.has("memory/compactions"));
    assert.ok(!by.has("memory/.dreams"));
    assert.ok(!by.has("memory/empty"));                     // 空目录不列
    assert.ok(![...by.keys()].some((k) => k.startsWith("guests")));
    assert.equal(by.get("sleep")!.files, 1);               // report.md
    const recent = recentlyChanged(a, FILES, f.ws, T0 - 86_400_000).map((x) => x.name);
    assert.ok(recent.includes("memory/threads/B站.md"));
    assert.ok(recent.includes("MEMORY.md"));
    assert.ok(!recent.includes("memory/people/ada.md")); // 5 天前改的
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("organizer state", () => {
  const f = fixture();
  try {
    const o = organizer(f.ws, "sleep");
    assert.equal(o.lastDone, "2026-10-28");
    assert.deepEqual(o.runs.map((r) => [r.day, r.report]), [["2026-10-28", "ws:sleep/2026-10-28/report.md"]]);
    assert.deepEqual(organizer(join(f.dir, "none"), "sleep"), { lastDone: null, lastAppliedAt: null, runs: [] });
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("wake openings: only the files hhd names that way are listed (newest first) and can be opened; nothing else in the state dir", () => {
  const f = fixture();
  const roots = { workspace: f.ws, stateDir: f.hh, files: FILES, layout: DEMO_MEMORY_PAGE };
  try {
    assert.deepEqual(wakeOpenings(f.hh).map((w) => [w.key, w.day, w.time]), [["wake:2026-10-29-073012.md", "2026-10-29", "07:30"], ["wake:2026-10-28-064500.md", "2026-10-28", "06:45"]]);
    assert.ok(wakeOpenings(f.hh).every((w) => w.bytes > 0 && w.mtime > 0));
    assert.deepEqual(wakeOpenings(join(f.dir, "none")), []);
    assert.equal(readMemoryFile("wake:2026-10-29-073012.md", roots)?.text, "===== 前缀 =====\n今天的开头");
    for (const bad of [
      "wake:notes.md", "wake:2026-10-29-073012.md.bak", "wake:2026-10-27-070000.md", "wake:2026-10-26-070000.md", "wake:2026-10-30-000000.md",
      "wake:../hh.db", "wake:../sleep/2026-10-28T16-00-20-875Z.md", "wake:sub/2026-10-29-073012.md", "wake:", "wake:/etc/passwd",
    ]) assert.equal(readMemoryFile(bad, roots), null, bad);
    assert.equal(readMemoryFile("wake:2026-10-29-073012.md", { workspace: f.ws, files: FILES, layout: DEMO_MEMORY_PAGE }), null, "没给状态目录：不开");
    // 多于 14 份时只列最新的 14 份（hhd 自己也只留这么多）
    for (let d = 1; d <= 20; d++) writeFileSync(join(f.hh, `wake/2026-09-${String(d).padStart(2, "0")}-070000.md`), "x");
    const all = wakeOpenings(f.hh);
    assert.equal(all.length, 14);
    assert.deepEqual([all[0]!.day, all[13]!.day], ["2026-10-29", "2026-09-09"]);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("readMemoryFile only opens memory files inside the roots", () => {
  const f = fixture();
  const roots = { workspace: f.ws, stateDir: f.hh, files: FILES, layout: DEMO_MEMORY_PAGE };
  try {
    assert.equal(readMemoryFile("ws:memory/threads/B站.md", roots)?.text, "事件线");
    assert.equal(readMemoryFile("ws:MEMORY.md", roots)?.text.length, 200);
    assert.equal(readMemoryFile("ws:sleep/2026-10-28/report.md", roots)?.text, "报告");
    assert.equal(readMemoryFile("hh:sleep/2026-10-28T16-00-20-875Z.md", roots), null, "状态目录里的旧整理稿不再给看（11-13 删了这一样）");
    assert.equal(readMemoryFile("ws:skills/a.md", roots)?.text, "手册");          // 技能手册（小脑）也能看
    for (const bad of [
      "ws:../outside.md", "ws:/etc/passwd", "ws:memory/compactions/old.md", "ws:scripts/a.md", "ws:guests/xiaobei/s.md",
      "ws:memory/threads/notes.json", "ws:memory/escape.md", "hh:hh.db", "hh:logs/hh.jsonl", "x:MEMORY.md", "ws:memory//a.md", "ws:memory/.hidden.md",
    ]) assert.equal(readMemoryFile(bad, roots), null, bad);
    const big = readMemoryFile("ws:MEMORY.md", roots, 10);
    assert.equal(big?.clipped, true);
    assert.equal(big?.bytes, 600);
  } finally { f.db.close(); rmSync(f.dir, { recursive: true }); }
});

test("server: /api/memory summary, block text, file viewer refuses outside files", async () => {
  const f = fixture();
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "p"), logPath: join(f.dir, "l.jsonl"),
    pageHtml: "<!doctype html>", now: () => T0,
    memory: { workspace: f.ws, stateDir: f.hh, layout: DEMO_MEMORY_PAGE, sleepDir: "sleep", skillsDir: "skills", limits: { pageTokens: 300000, maxContextTokens: 600000, sleepyAtTokens: 150000, mustSleepAtTokens: 200000 }, files: FILES, runtimeNote: "说明" },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const m = await (await fetch(base + "/api/memory")).json() as {
      pages: Array<{ id: number; end: string }>; blocks: unknown[]; prefix: Array<{ kind: string }>; areas: unknown[]; organizer: { lastDone: string };
      digests?: unknown; recall: unknown[]; limits: { pageTokens: number }; central: { rows: number }; wakes: Array<{ key: string }>;
    };
    assert.equal(m.pages.at(-1)!.end, "current");
    assert.equal(m.blocks.length, 2);
    assert.equal(m.prefix.filter((p) => p.kind === "block").length, 1);   // 只有没清空的那段在前缀里
    assert.equal(m.organizer.lastDone, "2026-10-28");
    assert.equal(m.digests, undefined, "旧整理稿那一栏删了");
    assert.deepEqual(m.wakes.map((w) => w.key), ["wake:2026-10-29-073012.md", "wake:2026-10-28-064500.md"]);
    assert.equal(((await (await fetch(base + "/api/memory/file?key=" + encodeURIComponent(m.wakes[0]!.key))).json()) as { text: string }).text, "===== 前缀 =====\n今天的开头");
    assert.equal((await fetch(base + "/api/memory/file?key=" + encodeURIComponent("wake:notes.md"))).status, 404);
    assert.equal(m.recall.length, 2);
    assert.equal(m.limits.pageTokens, 300000);
    assert.equal(m.central.rows, 9);
    assert.equal((m as unknown as { skills: { files: number; label: string } }).skills.files, 1);
    assert.equal((m as unknown as { skills: { label: string } }).skills.label, "本事");
    const b = await (await fetch(base + "/api/memory/block?id=2")).json() as { text: string };
    assert.equal(b.text, "第二段：醒来以后剪了视频。");
    assert.equal((await fetch(base + "/api/memory/block?id=99")).status, 404);
    const file = await (await fetch(base + "/api/memory/file?key=" + encodeURIComponent("ws:memory/threads/B站.md"))).json() as { text: string };
    assert.equal(file.text, "事件线");
    assert.equal((await fetch(base + "/api/memory/file?key=" + encodeURIComponent("ws:../outside.md"))).status, 404);
    assert.ok(!(m.prefix as Array<{ name?: string }>).some((p) => p.name === "书架目录"), "没配学习：前缀里没有书架");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    f.db.close();
    rmSync(f.dir, { recursive: true });
  }
});

test("server: /api/memory shows the shelf in the prefix when learning.shelf is on", async () => {
  const f = fixture();
  const root = join(f.dir, "skills");
  mkdirSync(join(root, "做事/剪辑"), { recursive: true });
  writeFileSync(join(root, "做事/剪辑/SKILL.md"), "---\nname: 剪辑\ndescription: 剪片子\n---\n");
  writeFileSync(join(root, "做事/剪辑/封面.md"), "# 封面 <!-- p:0012 -->\n简介：a\n什么时候翻：b\n");
  const make = (shelf: boolean) => createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "p"), logPath: join(f.dir, "l.jsonl"),
    pageHtml: "<!doctype html>", now: () => T0,
    memory: { workspace: f.ws, stateDir: f.hh, layout: DEMO_MEMORY_PAGE, sleepDir: "sleep", skillsDir: "skills", limits: { pageTokens: 300000, maxContextTokens: 600000, sleepyAtTokens: 150000, mustSleepAtTokens: 200000 }, files: FILES, runtimeNote: "说明" },
    learning: { root, generalCategory: "通用", archiveDir: "归档", residentFile: "常驻.md", tz: "UTC", dailyUsd: 1, shelf },
  });
  const prefixOf = async (shelf: boolean): Promise<Array<{ name: string; chars: number }>> => {
    const server = make(shelf);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const m = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/memory`)).json() as { prefix: Array<{ name: string; chars: number }> };
      return m.prefix;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  };
  try {
    const on = await prefixOf(true);
    assert.deepEqual(on.map((p) => p.name).slice(0, 5), ["运行说明", "IDENTITY.md", "MEMORY.md", "ledger/SOUL.md", "书架目录"]);
    assert.ok(on.find((p) => p.name === "书架目录")!.chars > 0);
    assert.ok(!(await prefixOf(false)).some((p) => p.name === "书架目录"));
  } finally {
    f.db.close();
    rmSync(f.dir, { recursive: true });
  }
});
