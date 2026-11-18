// 假数据演示（test/console-demo.ts）不能悄悄坏掉：建一份、起控制台，把每个接口读一遍，每一页要紧的字段都得有东西。
// 钟是定死的（造数据的 now 也给控制台用），和真的时间无关。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { SECRETS, buildDemo, readDemo, startDemo } from "./console-demo.ts";
import type { Demo, DemoOptions } from "./console-demo.ts";
import { WEB_FILES, webUrl } from "../src/console/web.ts";

const NOW = Date.UTC(2026, 10, 12, 3, 30);   // 枫湾 11-12 14:30
const TZ = "Australia/Melbourne";
const REGIONS = ["main", "side-1", "side-2", "deep", "speech", "hippocampus"];
/** 演示数据里不许出现的真名 */
const REAL_NAMES = /米拉|ada|小贝/i;

type Json = Record<string, unknown>;
type Rows = Json[];

async function withDemo(now: number, tz: string, fn: (d: Demo, get: <T = Json>(path: string, code?: number) => Promise<T>, bodies: Map<string, string>) => Promise<void>, extra: Partial<DemoOptions> = {}): Promise<void> {
  const dir = tmpDir("hh-demo-");
  buildDemo(dir, now, { tz });
  const demo = await startDemo({ dir, port: 0, now: () => now, ...extra });
  const bodies = new Map<string, string>();
  const get = async <T = Json>(path: string, code = 200): Promise<T> => {
    const r = await fetch(demo.url + path);
    const text = await r.text();
    assert.equal(r.status, code, `${path} → ${r.status} ${text.slice(0, 200)}`);
    bodies.set(path, text);
    return JSON.parse(text) as T;
  };
  try { await fn(demo, get, bodies); } finally { await demo.close(); }
}
const q = encodeURIComponent;

test("demo: every console endpoint answers with data for its page", async () => {
  await withDemo(NOW, TZ, async (demo, get, bodies) => {
    const s = demo.info.sample;

    // 网页：骨架和名单里的每个文件
    const page = await fetch(demo.url + "/");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<link rel="modulepreload" href="\/web\/js\/core\.js">/);
    assert.match(html, /<script type="module" src="\/web\/js\/start\.js"><\/script>/, "页面脚本是模块，入口是 start.js");
    for (const f of WEB_FILES) {
      const r = await fetch(demo.url + webUrl(f));
      assert.equal(r.status, 200, f);
      assert.ok((await r.text()).length > 0, f);
    }

    // 顶栏和大脑图：假 hhd 在线，六个脑区
    const st = await get<{ ok: boolean; status: { alertness: string; regions: Array<{ id: string; open: boolean; busy: boolean; contextTokens: number; sessionId: string | null }>; quota: string; claims: unknown[]; focusUntil: string } }>("/api/status");
    assert.equal(st.ok, true);
    assert.deepEqual(st.status.regions.map((r) => r.id), REGIONS);
    assert.ok(st.status.regions.every((r) => r.contextTokens < 6000) && st.status.regions[0]!.contextTokens > 3000);
    assert.ok(st.status.regions.some((r) => r.busy) && st.status.regions.some((r) => !r.open));
    assert.ok(st.status.quota && st.status.claims.length && st.status.focusUntil);

    // 时间线：各脑区、各种记录，工具的调用和结果配得上，有出错的、发出去的、只存档的
    const ev = await get<{ rows: Array<{ seq: number; ts: number; src: string; kind: string; text: string; meta: Json | null }>; maxSeq: number }>("/api/events?limit=600");
    assert.ok(ev.rows.length >= 100 && ev.maxSeq === ev.rows.at(-1)!.seq);
    assert.deepEqual([...new Set(ev.rows.map((r) => r.kind))].sort(), ["act", "input", "note", "result", "say", "system", "think"]);
    for (const src of ["外界", "system", "perception-messages", ...REGIONS]) assert.ok(ev.rows.some((r) => r.src === src), src);
    assert.ok(ev.rows.every((r, i) => i === 0 || r.ts >= ev.rows[i - 1]!.ts), "编号的先后就是时间的先后");
    const act = ev.rows.find((r) => r.kind === "act" && r.meta?.tool === "Bash")!;
    assert.ok(ev.rows.some((r) => r.kind === "result" && r.meta?.id === act.meta!.id), "调用和结果是一对");
    assert.ok(ev.rows.some((r) => r.kind === "result" && r.meta?.error === true));
    assert.ok(ev.rows.some((r) => r.kind === "note" && r.meta?.sent === true && r.text.startsWith("（发给 阿树）")));
    assert.ok(ev.rows.some((r) => r.kind === "note" && r.meta?.unsent === true));
    assert.ok(ev.rows.some((r) => r.meta?.inner === true));
    assert.equal((await get<{ rows: unknown[] }>("/api/events?before=20&limit=5")).rows.length, 5);
    const strip = await get<{ minutes: number; lanes: Record<string, number[]> }>("/api/activity?minutes=60");
    assert.ok(Object.keys(strip.lanes).length >= 7, Object.keys(strip.lanes).join(" "));
    assert.ok(strip.lanes.main!.filter((n) => n > 0).length >= 12, "最近一小时主意识那一道有十几根柱子");
    const live = await fetch(demo.url + "/api/stream?after=0");
    assert.match(live.headers.get("content-type") ?? "", /text\/event-stream/);
    await live.body!.cancel();

    // 帮手：空闲的、在跑的、有一步出错的；口令不往外给
    const ws = await get<{ workers: Array<{ name: string; state: string; lastActive: number }> }>("/api/workers");
    assert.deepEqual(ws.workers.map((w) => [w.name, w.state]), [["recipe-video", "running"], ["picnic-list", "idle"], ["weather-notes", "idle"]]);
    assert.ok(!bodies.get("/api/workers")!.includes("token"));
    for (const w of ws.workers) {
      const d = await get<{ steps: Array<{ kind: string; error?: boolean }>; thinking: { shown: number; hidden: number } }>(`/api/worker?name=${w.name}`);
      assert.ok(d.steps.length >= 4, w.name);
      if (w.name === "weather-notes") assert.ok(d.steps.some((x) => x.error) && d.thinking.hidden === 1);
    }
    const warn = await get<{ lines: Array<{ level: string }> }>("/api/log?level=warn");
    assert.deepEqual([...new Set(warn.lines.map((l) => l.level))].sort(), ["error", "warn"]);
    assert.ok(warn.lines.length >= 5 && (await get<{ lines: unknown[] }>("/api/log")).lines.length > warn.lines.length);

    // 记忆页：一页一页、压缩记忆、前缀、各个区、睡觉整理、回想、本事
    const mem = await get<{
      limits: Json; pages: Array<{ id: number; end: string; tokens: number; block: { cleared: number | null } | null }>; blocks: Array<{ id: number; cleared: number | null }>;
      prefix: Array<{ name: string; kind: string; key?: string; missing?: boolean; tokens: number }>; areas: Array<{ dir: string; files: number }>; recent: Array<{ key: string }>;
      organizer: { lastDone: string; lastAppliedAt: string; runs: Array<{ day: string; report: string | null }> }; wakes: Array<{ key: string }>;
      recall: Array<{ tool: string; found: boolean | null }>; skills: { files: number; list: Array<{ name: string; key: string }> }; central: { rows: number; imported: number }; events: { ready: boolean };
    }>("/api/memory");
    assert.deepEqual(mem.pages.map((p) => p.end), ["page-turn", "sleep", "page-turn", "restart", "page-turn", "current"]);
    assert.deepEqual(mem.limits, { pageTokens: 3000, maxContextTokens: 6000, sleepyAtTokens: 1500, mustSleepAtTokens: 2000 }, "阈值是默认配置的 1/100，和假数据一个量级");
    assert.ok(mem.pages.every((p) => p.tokens > 1000 && p.tokens <= 3000), mem.pages.map((p) => p.tokens).join(" "));
    assert.ok(mem.prefix.every((p) => p.tokens > 40 && p.tokens < 1200), "前缀里每一段都不至于小得看不见");
    assert.deepEqual(mem.blocks.map((b) => b.cleared === null), [true, true, false], "两段还在前缀里，一段睡觉时整理掉了");
    assert.ok(!mem.prefix.some((p) => p.missing) && mem.prefix.every((p) => p.tokens > 0));
    assert.deepEqual(mem.prefix.map((p) => p.name), ["运行说明", "IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "书架目录", "过渡句", "SOUL.memory.md", "ledger/SOUL.md", "中期视图", "压缩记忆 第 1 段", "压缩记忆 第 2 段"]);
    for (const dir of ["memory", "memory/archive/threads", "memory/midterm", "memory/story", "memory/diary", "memory/goals", "soul", "ledger", "sleep", "memory/食谱"]) assert.ok(mem.areas.some((a) => a.dir === dir && a.files > 0), dir);
    assert.ok(mem.recent.length >= 5 && mem.recent.length < mem.areas.reduce((n, a) => n + a.files, 0), "最近改过的只是一部分");
    assert.equal(mem.organizer.lastDone, s.yesterday);
    assert.equal(mem.wakes.length, 2);
    assert.match((await get<{ text: string }>(`/api/memory/file?key=${q(mem.wakes[0]!.key)}`)).text, /===== 开场/);
    assert.ok(mem.organizer.lastAppliedAt && mem.organizer.runs.length === 2 && mem.organizer.runs.every((r) => r.report));
    assert.deepEqual([...new Set(mem.recall.map((r) => r.tool))].sort(), ["recall", "recall_event", "recall_period", "recall_person", "remember"]);
    assert.deepEqual(mem.recall.map((r) => r.found), [null, false, false, false, true, true, true], "刚去想还没结果的、没想起来的、想起来的");
    assert.ok(mem.skills.files >= 7 && mem.skills.list.some((f) => f.name === "skills/MAP.md"));
    assert.ok(mem.central.rows === ev.rows.length && mem.central.imported === 2 && mem.events.ready);
    assert.ok((await get<{ text: string }>(`/api/memory/block?id=${s.block}`)).text.length > 50);
    const files = [s.file, ...mem.prefix.flatMap((p) => (p.key ? [p.key] : [])), ...mem.organizer.runs.map((r) => r.report!), mem.skills.list[0]!.key, "ws:memory/archive/threads/做饭.md", "ws:memory/archive/timeline-2026-10-31.md"];
    for (const key of files) assert.ok((await get<{ text: string }>(`/api/memory/file?key=${q(key)}`)).text.length > 10, key);

    // 完整输入：hhd 报的会话；系统提示、工具、附件、对话、用量
    const pr = await get<{
      how: string; session: { id: string; model: string }; system: Array<{ label: string; text: string }>; tools: Array<{ name: string }>; deferred: string[];
      attachments: Array<{ type: string }>; messages: Array<{ role: string; kind: string; error?: boolean }>; usage: Array<{ total: number }>;
    }>("/api/prompt?region=main");
    assert.deepEqual([pr.how, pr.session.id], ["hhd 报的当前会话", s.session]);
    assert.deepEqual(pr.system.map((x) => x.label), [
      "Claude Code：开场介绍", "（缓存分界线）", "Claude Code：怎么跟人说话", "Claude Code：Tone and style", "HH 运行说明",
      "人格文件 IDENTITY.md", "人格文件 SOUL.md", "人格文件 USER.md", "人格文件 MEMORY.md", "人格文件 AGENTS.md", "书架目录", "过渡句：你的人生",
      "记忆文件 SOUL.memory.md", "记忆文件 ledger/SOUL.md", "中期记忆（事件库最近这一段）", "压缩记忆（这次醒来以后）",
    ]);
    assert.ok(pr.tools.length >= 6 && pr.deferred.length >= 4 && pr.attachments.length >= 5 && pr.session.model);
    assert.deepEqual([...new Set(pr.messages.map((m) => `${m.role}:${m.kind}`))].sort(), ["assistant:text", "assistant:thinking", "assistant:tool_use", "user:text", "user:tool_result"]);
    assert.ok(pr.messages.some((m) => m.error) && pr.usage.length >= 8 && pr.usage.at(-1)!.total > pr.usage[0]!.total);
    assert.ok(Math.abs(pr.usage.at(-1)!.total - st.status.regions[0]!.contextTokens) < 100, "模型最后报的上下文和 hhd 报的对得上");
    assert.equal((await get<{ sessions: unknown[] }>("/api/prompt/sessions?region=main")).sessions.length, 2);
    for (const region of ["side-1", "side-2", "speech"]) assert.equal((await get<{ how: string }>(`/api/prompt?region=${region}`)).how, "hhd 报的当前会话", region);
    for (const region of ["hippocampus"]) assert.equal((await get<{ how: string }>(`/api/prompt?region=${region}`)).how, "按开场白找到的最近会话", region);
    await get("/api/prompt?region=deep", 404);   // 没开的脑区：页面上是「现在没有会话」
    assert.equal((await get<{ how: string }>(`/api/prompt?session=${s.session}`)).how, "指定的会话");

    // 事件记忆：总览
    const ov = await get<{
      ready: boolean; counts: Record<string, number>; status: Record<string, number>; importance: number[]; clarity: Record<string, number>; quotes: Array<{ src: string }>;
      days: unknown[]; batches: Array<{ id: string; state: string; ops: number }>; dayLikes: number; lastWrite: number;
      midterm: { tokens: number } | null; vectors: { missing: number; lastError: string } | null; flags: { inject: boolean };
    }>("/api/mem");
    assert.ok(ov.ready && ov.flags.inject && ov.lastWrite);
    for (const k of ["events", "entries", "corrections", "entities", "people", "links", "quotes", "vectors", "quoteVectors", "touches"]) assert.ok(ov.counts[k]! > 0, k);
    assert.ok(ov.counts.quoteVectors! < ov.counts.quotes! && ov.counts.quoteVectors! <= ov.counts.vectors!, "原话里有向量的不超过原话数（网页拿这两个数算百分比）");
    assert.deepEqual(Object.keys(ov.status).sort(), ["done", "ongoing", "paused", "retired", "superseded"]);
    assert.ok(ov.importance.every((n) => n > 0), "0–5 每个重要度都有事");
    assert.deepEqual(Object.keys(ov.clarity).sort(), ["fold", "full", "gist", "hidden", "title"]);
    assert.deepEqual(ov.quotes.map((x) => x.src).sort(), ["central", "honcho", "note"]);
    assert.deepEqual([...new Set(ov.batches.map((b) => b.state))].sort(), ["committed", "reverted"]);
    assert.ok(ov.batches.some((b) => b.id.includes("~reverted@") && b.ops > 0) && ov.batches.some((b) => b.id.startsWith("import:")));
    assert.ok(ov.dayLikes === 2 && ov.days.length === 2);
    assert.ok(ov.midterm!.tokens > 100 && ov.vectors!.missing > 0 && ov.vectors!.lastError);

    // 事件、子事件（两层）、筛选
    interface Item { id: string; title: string; parent: string | null; status: string; importance: number; people: string[]; clarity: string; pinned: boolean }
    const list = await get<{ total: number; items: Item[] }>("/api/mem/events");
    assert.equal(list.total, ov.counts.events);
    const kid = list.items.find((e) => e.id === s.event)!;
    const grand = list.items.find((e) => e.parent === s.event)!;
    assert.ok(kid.parent && grand, "大事 → 子事件 → 再下一层");
    assert.ok(list.items.some((e) => e.pinned));
    assert.equal((await get<{ total: number }>(`/api/mem/events?q=${q("番茄炒蛋")}`)).total > 1, true);
    assert.equal((await get<{ total: number }>("/api/mem/events?status=paused")).total, 1);
    assert.equal((await get<{ total: number }>("/api/mem/events?min=4")).total, 3);
    const d = await get<{
      focus: string | null; event: { id: string; summary: string; touched: number | null; threadPath: string | null }; entities: unknown[]; parent: { id: string } | null; children: unknown[];
      links: Array<{ rel: string }>; entries: Array<{ id: string; kind: string; source: string[]; correctedBy: string | null }>; touches: Array<{ how: string }>; ops: unknown[];
    }>(`/api/mem/event?id=${s.event}`);
    assert.ok(d.event.summary && d.event.touched && d.entities.length === 2 && d.parent && d.children.length === 1 && d.ops.length > 5);
    assert.deepEqual(d.links.map((l) => l.rel), ["followup", "followup"], "从它看过去，下一道菜和野餐都是后续");
    assert.deepEqual(d.entries.map((n) => n.kind).sort(), ["correction", "feeling", "happened", "result", "said"]);
    assert.ok(d.entries.some((n) => n.correctedBy) && d.entries.some((n) => n.source.some((x) => /^c:\d+$/.test(x))));
    assert.ok(d.touches.some((t) => t.how === "open") && d.touches.some((t) => t.how === "auto") && d.touches.some((t) => t.how === "new"));
    const viaEntry = await get<{ focus: string; event: { id: string } }>(`/api/mem/event?id=${s.entry}`);
    assert.deepEqual([viaEntry.focus, viaEntry.event.id], [s.entry, s.event]);
    const top = await get<{ event: { threadPath: string | null }; links: Array<{ rel: string }>; children: unknown[]; entries: Array<{ source: string[] }> }>(`/api/mem/event?id=${kid.parent}`);
    assert.ok(top.event.threadPath && top.children.length === 2 && top.links.some((l) => l.rel === "related"));
    assert.ok(top.entries.some((n) => n.source.some((x) => x.startsWith("thread:"))) && top.entries.some((n) => n.source.includes("timeline#4")));
    // 每件事都打得开；六种关联、后来变了的那件都在
    const rels = new Set<string>();
    for (const e of list.items) {
      const x = await get<{ event: { supersededBy: string | null }; links: Array<{ rel: string }>; entries: unknown[] }>(`/api/mem/event?id=${e.id}`);
      for (const l of x.links) rels.add(l.rel);
      assert.equal(Boolean(x.event.supersededBy), e.status === "superseded", e.title);
      assert.ok(x.entries.length > 0 || e.status === "retired", e.title);
    }
    assert.deepEqual([...rels].sort(), ["cause", "contrast", "followup", "related", "same_thread", "supersedes"]);

    // 人和东西、人物卡（主人、信任的访客、群）
    const ents = (await get<{ entities: Array<{ id: string; kind: string; name: string; events: number }> }>("/api/mem/entities")).entities;
    assert.deepEqual([...new Set(ents.map((t) => t.kind))].sort(), ["group", "person", "place", "thing", "work"]);
    assert.ok((await get<{ total: number }>(`/api/mem/events?who=${ents.find((t) => t.name === "访客甲")!.id}`)).total >= 2);
    const cards = await get<{ enabled: boolean; people: Array<{ id: string; name: string; owner: boolean; kind: string; relation: string; pending: number; total: number }> }>("/api/mem/people");
    assert.ok(cards.enabled);
    assert.deepEqual(cards.people.map((p) => [p.name, p.owner, p.kind, p.pending]), [["阿树", true, "person", 1], ["访客甲", false, "person", 0], ["测试群", false, "group", 1]]);
    assert.ok(cards.people.every((p) => p.relation && p.total > 0));
    interface Card { sections: Array<{ name: string; kind: string }>; privateCount: number; pending: Array<{ change: string; text: string | null }>; history: Array<{ status: string; secret: boolean; text: string | null; why: string | null; ops: unknown[] }> }
    const [owner, guest, group] = await Promise.all(cards.people.map((p) => get<Card>(`/api/mem/person?id=${p.id}`)));
    assert.deepEqual([...new Set(owner!.sections.map((x) => x.kind))].sort(), ["computed", "field", "quote"]);
    assert.ok(owner!.sections.length >= 9 && owner!.pending[0]!.change.startsWith("丢了") && owner!.privateCount === 0);
    assert.deepEqual([...new Set(owner!.history.map((h) => h.status))].sort(), ["current", "pending", "rejected", "superseded"]);
    assert.equal(guest!.privateCount, 2, "私下说的一段 + 钉的一句私密原话");
    assert.equal(s.person, cards.people[1]!.id);
    assert.ok(guest!.sections.some((x) => x.kind === "computed") && guest!.sections.some((x) => x.kind === "quote"));
    const hidden = guest!.history.filter((h) => h.secret);
    assert.ok(hidden.length === 3 && hidden.every((h) => h.text === null && h.why === null) && guest!.history.every((h) => h.ops.length > 0));
    assert.equal(group!.pending[0]!.change, "新建（还没有现行的）");

    // 原话层、夜里改了什么、中期视图、联想对比
    const quotes = await get<{ total: number; items: Array<{ who: string }> }>("/api/mem/quotes");
    assert.ok(quotes.total >= 50 && quotes.items.some((x) => x.who === "我→阿树") && quotes.items.some((x) => x.who === "感官"));
    assert.equal((await get<{ total: number }>("/api/mem/quotes?q=q1")).total, 1);
    assert.equal((await get<{ total: number }>("/api/mem/quotes?src=honcho")).total, 2);
    for (const b of ov.batches) {
      const r = await get<{ batch: { state: string } | null; ops: unknown[] }>(`/api/mem/batch?id=${q(b.id)}`);
      assert.equal(r.ops.length, b.ops, b.id);
    }
    const night = await get<{ batch: { state: string }; ops: Array<{ tbl: string; before: string | null; after: string | null }> }>(`/api/mem/batch?id=${q(s.batch)}`);
    assert.equal(night.batch.state, "committed");
    for (const tbl of ["mem_event", "mem_entry", "mem_link", "mem_impression", "mem_event_entity"]) assert.ok(night.ops.some((o) => o.tbl === tbl), tbl);
    assert.ok(night.ops.some((o) => o.before && o.after) && night.ops.length > 40);
    const mid = await get<{ text: string; inPrefix: boolean }>("/api/mem/midterm");
    assert.ok(mid.inPrefix && mid.text.startsWith("# 最近这一段"));
    for (const part of ["## 今天", "## 有日子的事", "## 最近在发生的事", "## 最近喜欢的", s.event]) assert.ok(mid.text.includes(part), part);

    // 顺不顺：最近 24 小时的请求、被停 / 被拒、卡顿（数是 console-demo.ts 的 seedHealth 编的；脑区那几份演示会话里的请求也算在里面）
    const inc = await get<{ tz: string; hours: Array<{ day: string; hour: number; requests: number; stops: number; refusals: number; blocks: number; blockedMs: number; longestMs: number }>; stretches: Array<{ commit: string | null; requests: number; versions: string[]; configChanged: boolean; changes: Array<{ items: string[] }> }>; pending: unknown[]; configPending: boolean }>("/api/incidents");
    const sumOf = (k: "requests" | "stops" | "refusals" | "blocks" | "blockedMs"): number => inc.hours.reduce((n, h) => n + h[k], 0);
    assert.ok(inc.tz === TZ && inc.hours.length === 25 && sumOf("requests") >= 676, `请求 ${sumOf("requests")}`);
    assert.deepEqual([sumOf("stops"), sumOf("refusals"), sumOf("blocks"), sumOf("blockedMs")], [5, 1, 4, 13_900]);
    // 每次上线之后：演示的留痕里到 14:30 为止起来过两回（昨天上午那一版跑到今天 09:42，之后是 09:40 部署的那一版）
    assert.deepEqual(inc.stretches.map((s) => [s.commit, s.changes.map((c) => c.items.length)]), [["b2c3d4e", [1]], ["c3d4e5f", [2]]]);
    assert.ok(inc.stretches.every((s) => s.requests > 0) && inc.pending.length === 0);
    assert.deepEqual(inc.stretches.map((s) => [s.versions, s.configChanged]), [[["9.1.100"], false], [["9.1.100"], false]]);
    assert.equal(inc.configPending, false);
    const four = inc.hours.find((h) => h.hour === 16)!;
    assert.deepEqual([four.stops, four.refusals, four.blocks, four.longestMs], [4, 1, 3, 6_100]);

    // 学习
    const learn = await get<{ alert: string; alertAt: number; spend: { tokens: number; usd: number }; weekly: Record<string, number | null>; recent: Array<{ binding: string; mounted: unknown[]; shadow: boolean; skipped: string | null }> }>("/api/learn");
    assert.ok(learn.alert && learn.alertAt && learn.spend.tokens > 0 && learn.spend.usd > 0);
    for (const k of ["newLessons", "recurMounted", "recurUnmounted", "corrections", "mounts", "opened", "idleMounts", "promoted", "estimateRatio", "replayPassRate"]) assert.ok(learn.weekly[k], k);
    assert.ok(learn.recent.length >= 15 && learn.recent.some((a) => a.mounted.length) && learn.recent.some((a) => a.shadow));
    assert.deepEqual([...new Set(learn.recent.map((a) => a.skipped).filter(Boolean))].sort(), ["budget", "judge", "lowinfo", "nothing", "novec", "same"]);
    assert.ok(new Set(learn.recent.map((a) => a.binding)).size >= 6);

    // 下意识（闸门）：今天和昨天；每种分法、每种判法；访客私聊遮着，群、主人照常
    interface GateRow { src: string; conv: string | null; route: string | null; action: string | null; when: string | null; unsure: boolean | null; delivered: boolean; text: string | null; gist: string | null; why: string | null; private: boolean }
    interface Gate { day: string; today: string; total: number; registryOk: boolean; baselineOk: boolean; aliasOk: boolean; stats: { byRoute: Record<string, number>; byVerdict: Record<string, number>; judgeCalls: number; units: number; fallbackWhy: Record<string, number> }; rows: GateRow[] }
    const gate = await get<Gate>("/api/gate");
    assert.deepEqual([gate.day, gate.today, gate.registryOk, gate.baselineOk, gate.aliasOk], ["2026-11-12", "2026-11-12", true, true, true]);
    assert.ok(gate.total === gate.rows.length && gate.total >= 18);
    for (const r of ["fixed-main", "hands", "rule", "judge", "fallback", "pending"]) assert.ok(gate.stats.byRoute[r]! > 0, r);
    for (const v of ["main", "digest", "drop"]) assert.ok(gate.stats.byVerdict[v]! > 0, v);
    assert.ok(gate.stats.judgeCalls > 0 && gate.stats.units > 0);
    assert.deepEqual(Object.keys(gate.stats.fallbackWhy).sort(), ["小判断超时", "访客私聊（不显示原文）", "这周额度快用完了，群里的先进总结"].sort());
    const priv = gate.rows.filter((r) => r.private);
    assert.deepEqual(priv.map((r) => [r.conv, r.text, r.gist, r.why]), [["访客甲", null, null, null]]);
    assert.ok(gate.rows.some((r) => r.conv === "测试群" && r.text && !r.private) && gate.rows.some((r) => r.conv === "阿树" && r.text && !r.private));
    assert.ok(gate.rows.some((r) => r.unsure) && gate.rows.some((r) => r.action === "judge-floor") && gate.rows.some((r) => r.when === "work" && !r.delivered));
    assert.deepEqual([...new Set(gate.rows.map((r) => r.when).filter(Boolean))].sort(), ["leisure", "now", "work"]);
    const old = await get<Gate>(`/api/gate?day=${s.yesterday}`);
    assert.deepEqual([old.day, old.total], ["2026-11-11", 6]);
    assert.ok(old.rows.some((r) => r.private));

    // 访客私下的不出：人物卡、夜里改了什么、闸门里都没有那几个字；真名哪儿都没有
    for (const [path, body] of bodies) {
      if (/^\/api\/mem\/(person|people|batch)/.test(path)) assert.ok(!body.includes(SECRETS.card), `${path} 漏了访客私下说的`);
      if (path.startsWith("/api/gate")) assert.ok(!body.includes(SECRETS.gate), `${path} 漏了访客私聊`);
      assert.doesNotMatch(body, REAL_NAMES, `${path} 里有真名`);
    }
    assert.ok(bodies.get("/api/mem/quotes")!.includes(SECRETS.card), "原话层照常有那句（遮的只是人物卡）");
    assert.ok(bodies.size >= 60, `读了 ${bodies.size} 个地址`);
  });
});

test("demo: built five minutes after local midnight (and after New Year) there is still a today", async () => {
  await withDemo(Date.UTC(2026, 0, 1, 0, 5), "UTC", async (demo, get) => {
    assert.equal(demo.info.sample.yesterday, "2025-12-31");
    const gate = await get<{ day: string; total: number; stats: { byRoute: Record<string, number> } }>("/api/gate");
    assert.deepEqual([gate.day, gate.total], ["2026-01-01", 18]);
    assert.equal((await get<{ total: number }>("/api/gate?day=2025-12-31")).total, 6);
    const learn = await get<{ spend: { day: string; tokens: number }; weekly: { promoted: number; mounts: number } }>("/api/learn");
    assert.deepEqual([learn.spend.day, learn.spend.tokens > 0, learn.weekly.promoted, learn.weekly.mounts], ["2026-01-01", true, 1, 7]);
    assert.ok(Object.keys((await get<{ lanes: Json }>("/api/activity")).lanes).length >= 7);
    assert.equal((await get<{ how: string }>("/api/prompt?region=main")).how, "hhd 报的当前会话");
    assert.equal((await get<{ people: Rows }>("/api/mem/people")).people.length, 3);
  });
});

test("demo: --dir is only rebuilt when it is a demo dir; other files in it are left alone", () => {
  const dir = tmpDir("hh-demo-dir-");
  writeFileSync(join(dir, "mine.txt"), "别人的东西");
  assert.throws(() => buildDemo(dir, NOW, { tz: TZ }), /不是演示目录/);
  assert.deepEqual([existsSync(join(dir, "mine.txt")), existsSync(join(dir, "hh.db"))], [true, false], "别人的非空目录原样不动");
  assert.throws(() => readDemo(dir), /不是演示目录/);

  const own = join(dir, "demo");   // 不在的目录：建
  const first = buildDemo(own, NOW, { tz: TZ });
  writeFileSync(join(own, "mine.txt"), "后来放进来的");
  writeFileSync(join(own, "ws", "MEMORY.md"), "改过的");
  const again = buildDemo(own, NOW + 3_600_000, { tz: TZ });
  assert.equal(again.now, first.now + 3_600_000);
  assert.deepEqual(readDemo(own), again);
  assert.equal(readFileSync(join(own, "mine.txt"), "utf8"), "后来放进来的", "不是我们建的不删");
  assert.notEqual(readFileSync(join(own, "ws", "MEMORY.md"), "utf8"), "改过的", "我们建的从头重建");
});

test("demo: --page serves the pre-split single file with its inline script allowed and no /web/ files; --web and --page together are refused", async () => {
  const dir = tmpDir("hh-demo-page-");
  const file = join(dir, "page.html");
  writeFileSync(file, "<!doctype html><title>旧页面</title><script>let old = 1;</script>");
  await withDemo(NOW, TZ, async (demo, get) => {
    const page = await fetch(demo.url + "/");
    assert.equal(await page.text(), readFileSync(file, "utf8"));
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self' 'unsafe-inline'/);
    assert.equal((await fetch(demo.url + "/web/js/core.js")).status, 404);
    assert.equal((await fetch(demo.url + "/", { method: "POST" })).status, 405, "别的照旧交给控制台");
    assert.equal((await get<{ ok: boolean }>("/api/status")).ok, true);
  }, { page: file });
  const built = tmpDir("hh-demo-both-");
  buildDemo(built, NOW, { tz: TZ });
  await assert.rejects(startDemo({ dir: built, port: 0, web: dir, page: file }), /只能给一个/);
});

// ---------- 英文那份（test/console-demo-en.ts）：每一页有东西，访客私下的照样遮，真名、中文人名都不出 ----------
import { SECRETS_EN } from "./console-demo-en.ts";
import { seedsFor } from "./console-demo.ts";

test("demo (English): every page has data; guests' private chats stay hidden; a marked system notice, an @ in the group and a guest speaking in the group are shown", async () => {
  const seeds = await seedsFor("en");
  const dir = tmpDir("hh-demo-en-");
  const info = buildDemo(dir, NOW, { tz: TZ, seeds });
  assert.deepEqual([info.lang, info.names], ["en", { me: "Mira", owner: "Sam" }]);
  const demo = await startDemo({ dir, port: 0, now: () => NOW });   // 按目录里记的语言取那份（不传 seeds）
  const bodies = new Map<string, string>();
  const get = async <T = Json>(path: string): Promise<T> => {
    const r = await fetch(demo.url + path);
    const text = await r.text();
    assert.equal(r.status, 200, `${path} → ${r.status} ${text.slice(0, 200)}`);
    bodies.set(path, text);
    return JSON.parse(text) as T;
  };
  try {
    const page = await (await fetch(demo.url + "/")).text();
    assert.match(page, /"demo":true/, "页面带着演示标记（角上的 Demo data）");
    const st = await get<{ status: { regions: Array<{ id: string; busy: boolean }>; quota: string; claims: unknown[]; focusUntil: string } }>("/api/status");
    assert.deepEqual(st.status.regions.map((r) => r.id), REGIONS);
    assert.ok(st.status.regions.find((r) => r.id === "deep")!.busy && st.status.quota && st.status.claims.length);
    assert.match(st.status.focusUntil, /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/, "和线上 hhd 一样的写法（页面从结尾取时:分）");
    const ev = await get<{ rows: Array<{ text: string }> }>("/api/events?limit=600");
    assert.ok(ev.rows.length > 100 && ev.rows.some((r) => r.text.startsWith("(to Sam) ")));
    interface GateRow { src: string; conv: string | null; sender: string | null; text: string | null; gist: string | null; why: string | null; do: string | null; private: boolean }
    const gate = await get<{ rows: GateRow[]; stats: { byRoute: Record<string, number>; fallbackWhy: Record<string, number> } }>("/api/gate");
    const priv = gate.rows.filter((r) => r.private);
    assert.deepEqual(priv.map((r) => r.conv).sort(), ["Alex", "Jordan"], "Alex 的私聊、被标成群的 Jordan 私聊");
    assert.ok(priv.every((r) => r.text === null && r.gist === null && r.why === null && r.do === null));
    const sys = gate.rows.find((r) => r.text?.startsWith("Phone just turned on"))!;
    assert.deepEqual([sys.private, typeof sys.do], [false, "string"], "带标记的系统提示照常显示，做法另给");
    assert.ok(gate.rows.some((r) => r.conv === "Weekend Crew" && r.sender === "Jordan" && !r.private && r.text), "访客在群里说话照常显示");
    assert.ok(gate.rows.some((r) => r.text?.includes("@Mira") && !r.private), "群里 @ 她的照常显示");
    for (const r of ["fixed-main", "hands", "rule", "judge", "fallback", "pending"]) assert.ok(gate.stats.byRoute[r]! > 0, r);
    await get(`/api/gate?day=${info.sample.yesterday}`);
    await get("/api/learn");
    await get("/api/workers");
    await get("/api/log");
    // 原话里几成有向量：英文演示里事件和经过也有向量，拿总数除以原话数会超过 100%（11-14 页面上写过 168%）
    const mem = await get<{ counts: { quotes: number; vectors: number; quoteVectors: number } }>("/api/mem");
    assert.ok(mem.counts.vectors > mem.counts.quotes && mem.counts.quoteVectors <= mem.counts.quotes && mem.counts.quoteVectors > 0, JSON.stringify(mem.counts));
    // 顺不顺：英文演示也有请求和那几次被停；卡顿不放（日志栏里不出告警）
    const inc = await get<{ hours: Array<{ requests: number; stops: number; refusals: number; blocks: number }> }>("/api/incidents");
    assert.deepEqual([inc.hours.reduce((n, h) => n + h.stops, 0), inc.hours.reduce((n, h) => n + h.refusals, 0), inc.hours.reduce((n, h) => n + h.blocks, 0)], [5, 1, 0]);
    assert.ok(inc.hours.reduce((n, h) => n + h.requests, 0) >= 676);
    await get("/api/activity");
    const mid = await get<{ text: string }>("/api/mem/midterm");
    assert.match(mid.text, /^# Recently/);
    const people = await get<{ people: Array<{ id: string; name: string; relation: string }> }>("/api/mem/people");
    assert.ok(people.people.some((p) => p.name === "Sam" && p.relation.startsWith("owner | ")), "关系那一行按英文模板取到了");
    for (const p of people.people) await get(`/api/mem/person?id=${q(p.id)}`);
    await get(`/api/mem/batch?id=${q(info.sample.batch)}`);
    const events = await get<{ total: number; items: unknown[] }>("/api/mem/events");
    assert.ok(events.total >= 10 && events.items.length >= 10);
    await get(`/api/mem/event?id=${info.sample.entry}`);
    await get("/api/mem/quotes");
    await get(`/api/memory/block?id=${info.sample.block}`);
    for (const region of REGIONS) await get(`/api/prompt?region=${region}`);
    await get(`/api/prompt?session=${info.sample.session}`);
    for (const [path, body] of bodies) {
      if (/^\/api\/mem\/(person|people|batch)/.test(path)) assert.ok(!body.includes(SECRETS_EN.card), `${path} 漏了访客私下说的`);
      if (path.startsWith("/api/gate")) assert.ok(!body.includes(SECRETS_EN.gate), `${path} 漏了访客私聊`);
      assert.doesNotMatch(body, REAL_NAMES, `${path} 里有真名`);
      assert.doesNotMatch(body, /小满|阿树|访客甲|访客乙|测试群/, `${path} 里混进了中文那份的人名`);
    }
    assert.ok(bodies.get("/api/mem/quotes")!.includes(SECRETS_EN.card), "原话层照常有那句（遮的只是人物卡）");
  } finally { await demo.close(); }
});
