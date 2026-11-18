// 事件记忆模块：store、淡忘、渲染、检索、取法。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { memTools } from "../src/tools/memtools.ts";
import { openDb } from "../src/store/db.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { clarity, eventClarity, staysClear } from "../src/memory/events/fade.ts";
import { renderEvents } from "../src/memory/events/render.ts";
import { MemIndex, terms } from "../src/memory/events/index.ts";
import { OpenAIEmbedder } from "../src/memory/events/embed.ts";
import type { Embedder } from "../src/memory/events/embed.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { EventRecall, parseRange } from "../src/memory/events/recall.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import type { RenderEvent } from "../src/memory/events/render.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 30, 3, 0);

function mk(now = () => T0) {
  const db = openDb(":memory:");
  return { db, s: new EventStore(db, now) };
}

const ev = (over: Record<string, unknown> = {}) => ({
  title: "做脸", summary: "照官方分层重做才过审，他说过简直没法看。", gist: "照官方分层重做才过", why: "第一次自己做出能用的形象",
  importance: 4, status: "done", entities: [{ name: "ada", kind: "person", role: "with" }], ...over,
});
const en = (eventId: string, over: Record<string, unknown> = {}) => ({
  event: eventId, at: T0 - DAY, kind: "happened", full: "10-29 下午照官方分层重做了脸，提交后过审。ada：「这次可以」", gist: "重做的脸过审了", title: "过审",
  people: ["ada"], source: ["c:12"], ...over,
});

test("store: 建事件和条目，编号 e0001 / n00001，新条目按发生时间碰事件", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b1");
  assert.equal(e.id, "e0001");
  const { entry, existed } = s.addEntry(en(e.id), "b1");
  assert.equal(entry.id, "n00001");
  assert.equal(existed, false);
  assert.equal(s.createEvent(ev({ title: "第二件" }), "b1").id, "e0002");
  assert.equal(s.lastTouched(e.id), T0 - DAY, "新条目让事件变清楚，按条目发生的时间");
  assert.equal(s.lastTouched(entry.id), null);
  s.touch(e.id, "auto", "main");
  s.touch("n00001", "recall", "main");
  assert.equal(s.lastTouched(e.id), T0 - DAY, "auto 不算碰过");
  s.touch("n00001", "open", "main");
  assert.equal(s.lastTouched("n00001"), T0);
  assert.deepEqual(s.entries(e.id).map((x) => x.id), ["n00001"]);
  assert.deepEqual(s.peopleOf(e.id), ["ada"]);
});

test("store: 校验——full 必填、gist 比 full 短、重要度 4–5 要 why、said 要出处、重要度只能 0–5", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b1");
  assert.throws(() => s.addEntry(en(e.id, { full: "" }), "b1"), /full/);
  assert.throws(() => s.addEntry(en(e.id, { gist: "一".repeat(200) }), "b1"), /gist/);
  assert.throws(() => s.createEvent(ev({ importance: 5, why: "" }), "b1"), /why/);
  assert.throws(() => s.createEvent(ev({ importance: 6 }), "b1"), /importance|重要度/);
  assert.throws(() => s.addEntry(en(e.id, { kind: "said", source: [] }), "b1"), /出处/);
  assert.throws(() => s.addEntry(en("e9999"), "b1"), /e9999/);
  assert.ok(s.createEvent(ev({ importance: 0, why: "" }), "b1"));
});

test("store: 只增不改——没有改 full 的方法；correctEntry 加一条 correction 指向原条目，原条目不变", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b1");
  const { entry } = s.addEntry(en(e.id), "b1");
  const fix = s.correctEntry(entry.id, { full: "其实是 10-29 晚上过审的", gist: "晚上过审", title: "过审（更正）", why: "核了原话" }, "b2");
  assert.equal(fix.kind, "correction");
  assert.equal(fix.corrects, entry.id);
  assert.equal(fix.event_id, e.id);
  assert.equal(s.entry(entry.id)!.full, en(e.id).full);
  assert.equal((s as unknown as Record<string, unknown>).updateEntry, undefined);
  assert.throws(() => s.updateEvent(e.id, { full: "x" } as never, "改", "b2"), /full|不认识/);
});

test("store: addEntry 幂等——同事件、同出处集合、同 at 返回已有条目（existed=true）", () => {
  const { s, db } = mk();
  const e = s.createEvent(ev(), "b1");
  s.addEntry(en(e.id, { source: ["c:1", "c:2"] }), "b1");
  const again = s.addEntry(en(e.id, { source: ["c:2", "c:1"], full: "换了说法也算同一条" }), "b1");
  assert.equal(again.existed, true);
  assert.equal(again.entry.id, "n00001");
  const n = (db.prepare("SELECT count(*) n FROM mem_entry").get() as { n: number }).n;
  assert.equal(n, 1);
});

test("store: merge 把条目挪到保留的事件、其他标 superseded；split 挪出一段并留 same_thread；条目编号不变", () => {
  const { s } = mk();
  const a = s.createEvent(ev({ title: "做脸" }), "b1");
  const b = s.createEvent(ev({ title: "做脸二" }), "b1");
  s.addEntry(en(a.id, { source: ["c:1"] }), "b1");
  const { entry: nb } = s.addEntry(en(b.id, { source: ["c:2"], at: T0 - 2 * DAY }), "b1");
  s.merge(a.id, [b.id], "其实是一件事", "b2");
  assert.equal(s.entry(nb.id)!.event_id, a.id);
  assert.equal(s.event(b.id)!.status, "superseded");
  assert.equal(s.event(b.id)!.superseded_by, a.id);
  const c = s.split(a.id, [nb.id], ev({ title: "做表情包", importance: 2, why: "" }), "b3");
  assert.equal(s.entry(nb.id)!.event_id, c.id);
  assert.ok(s.links(a.id).some((l) => l.rel === "same_thread" && (l.a === c.id || l.b === c.id)));
  assert.equal(s.event(a.id)!.started_at, T0 - DAY, "时间范围跟着时间线重算");
});

test("store: 子事件——建的时候挂在大事下面、改 parent、清掉；不能挂自己、不能成环、最多三层、挂不到不存在或被替换的事上", () => {
  const { s } = mk();
  const big = s.createEvent(ev({ title: "B站30天挑战", importance: 5 }), "b1");
  const kid = s.createEvent(ev({ title: "祥子那期", parent: big.id }), "b1");
  assert.equal(kid.parent, big.id);
  assert.deepEqual(s.children(big.id).map((e) => e.id), [kid.id]);
  assert.deepEqual(s.ancestors(kid.id).map((e) => e.id), [big.id]);
  const grand = s.createEvent(ev({ title: "祥子配音", parent: kid.id }), "b1");
  assert.deepEqual(s.ancestors(grand.id).map((e) => e.id), [kid.id, big.id], "近的在前");
  assert.throws(() => s.createEvent(ev({ title: "第四层", parent: grand.id }), "b1"), /最多三层/);
  assert.throws(() => s.createEvent(ev({ title: "x", parent: "e9999" }), "b1"), /没有事件 e9999/);
  assert.throws(() => s.updateEvent(big.id, { parent: grand.id }, "试成环", "b2"), /成环/);
  assert.throws(() => s.updateEvent(big.id, { parent: big.id }, "挂自己", "b2"), /自己/);
  // 挪一棵：连同下面那层一起算深度
  const other = s.createEvent(ev({ title: "另一件大事" }), "b1");
  const mid = s.createEvent(ev({ title: "中间", parent: other.id }), "b1");
  assert.throws(() => s.updateEvent(kid.id, { parent: mid.id }, "挪过去", "b2"), /最多三层/);
  s.updateEvent(grand.id, { parent: big.id }, "其实直接属于挑战", "b2");
  assert.equal(s.event(grand.id)!.parent, big.id);
  s.updateEvent(grand.id, { parent: "" }, "单独算一件", "b2");
  assert.equal(s.event(grand.id)!.parent, null);
  s.supersede(other.id, big.id, "并掉", "b3");
  assert.throws(() => s.createEvent(ev({ title: "y", parent: other.id }), "b3"), /被替换/);
});

test("store: split under=true 拆出来的是子事件（不加同一件事的关联）；merge 把被并掉那件的子事件挂到留下的那件下面；撤回整批 parent 也回去", () => {
  const { s } = mk();
  const big = s.createEvent(ev({ title: "B站30天挑战" }), "b1");
  const { entry: n1 } = s.addEntry(en(big.id, { source: ["c:1"] }), "b1");
  const { entry: n2 } = s.addEntry(en(big.id, { source: ["c:2"], at: T0 - 2 * DAY }), "b1");
  const kid = s.split(big.id, [n1.id, n2.id], ev({ title: "祥子那期", importance: 3, why: "" }), "b2", "拆成子事件", { under: true });
  assert.equal(kid.parent, big.id);
  assert.equal(s.entry(n1.id)!.event_id, kid.id);
  assert.ok(!s.links(big.id).some((l) => l.rel === "same_thread"), "子事件不另加同一件事的关联");
  // merge：被并掉那件下面的子事件挂到留下那件下面
  const dup = s.createEvent(ev({ title: "B站挑战（重复）" }), "b3");
  const dkid = s.createEvent(ev({ title: "冲热评", parent: dup.id }), "b3");
  s.merge(big.id, [dup.id], "同一件", "b4");
  assert.equal(s.event(dkid.id)!.parent, big.id);
  s.revertBatch("b4");
  assert.equal(s.event(dkid.id)!.parent, dup.id, "撤回后回到原来那件下面");
  s.revertBatch("b2");
  assert.equal(s.event(kid.id), undefined);
  assert.equal(s.entry(n1.id)!.event_id, big.id);
});

test("store: 撤回建大事的那一批时，别的批次挂在它下面的子事件还在：大事留着，列成冲突（不留孤儿）", () => {
  const { s } = mk();
  const big = s.createEvent(ev({ title: "大事" }), "b1");
  const kid = s.createEvent(ev({ title: "子事件", parent: big.id }), "b2");
  const r = s.revertBatch("b1");
  assert.ok(s.event(big.id), "大事还在");
  assert.equal(s.event(kid.id)!.parent, big.id);
  assert.ok(r.conflicts.some((c) => c.includes(big.id)), JSON.stringify(r.conflicts));
});

test("store: merge 不成环、不超过三层——留下的那件本来在被并掉那件下面：它顶上来接替位置；挂过去会超过三层就不并", () => {
  const { s } = mk();
  const top = s.createEvent(ev({ title: "大事" }), "b1");
  const mid = s.createEvent(ev({ title: "中间", parent: top.id }), "b1");
  const keep = s.createEvent(ev({ title: "其实就是大事", parent: mid.id }), "b1");
  s.merge(keep.id, [top.id], "同一件", "b2");
  assert.equal(s.event(keep.id)!.parent, null, "接替被并掉那件的位置");
  assert.equal(s.event(mid.id)!.parent, keep.id);
  assert.ok(!s.ancestors(keep.id).some((a) => a.id === keep.id) && !s.ancestors(mid.id).some((a) => a.id === mid.id), "没有环");
  s.revertBatch("b2");
  assert.equal(s.event(keep.id)!.parent, mid.id, "撤回后都回去");
  // 留下的那件已经在第三层，被并掉那件下面还有两层：挂过去超过三层，整个不并
  const g = s.createEvent(ev({ title: "甲" }), "b3");
  const g2 = s.createEvent(ev({ title: "乙", parent: g.id }), "b3");
  const deep = s.createEvent(ev({ title: "丙", parent: g2.id }), "b3");
  const o = s.createEvent(ev({ title: "丁" }), "b3");
  const oc = s.createEvent(ev({ title: "丁下面", parent: o.id }), "b3");
  assert.throws(() => s.merge(deep.id, [o.id], "同一件", "b4"), /最多三层/);
  assert.equal(s.event(o.id)!.status, "done", "没并");
  assert.equal(s.event(oc.id)!.parent, o.id);
});

test("store: supersede 把子事件挂到替换它的那件下面；retire 把子事件挂到它上一层（作废的是这一件，下面的事还在）", () => {
  const { s } = mk();
  const up = s.createEvent(ev({ title: "上一层" }), "b1");
  const old = s.createEvent(ev({ title: "旧的", parent: up.id }), "b1");
  const kid = s.createEvent(ev({ title: "旧的下面", parent: old.id }), "b1");
  const neu = s.createEvent(ev({ title: "新的" }), "b1");
  s.supersede(old.id, neu.id, "后来变了", "b2");
  assert.equal(s.event(kid.id)!.parent, neu.id);
  // 替换它的是它自己下面的一件：顶上来接替位置，不挂在作废的那件下面
  const o2 = s.createEvent(ev({ title: "旧计划", parent: up.id }), "b2");
  const by2 = s.createEvent(ev({ title: "改成的新计划", parent: o2.id }), "b2");
  s.supersede(o2.id, by2.id, "改了", "b2");
  assert.equal(s.event(by2.id)!.parent, up.id);
  const p = s.createEvent(ev({ title: "要作废的", parent: up.id }), "b3");
  const k2 = s.createEvent(ev({ title: "它下面的", parent: p.id }), "b3");
  s.retire(p.id, "记错了", "b4");
  assert.equal(s.event(k2.id)!.parent, up.id);
  s.revertBatch("b4");
  assert.equal(s.event(k2.id)!.parent, p.id, "撤回后回去");
});

test("store: 被替换、不算数了的子事件不算层数（merge 照样能并）；mem_event_update 改成 retired 也把子事件挂到上一层", () => {
  const { s } = mk();
  const g = s.createEvent(ev({ title: "甲" }), "b1");
  const g2 = s.createEvent(ev({ title: "乙", parent: g.id }), "b1");
  const deep = s.createEvent(ev({ title: "丙", parent: g2.id }), "b1");
  const o = s.createEvent(ev({ title: "丁" }), "b1");
  const oc = s.createEvent(ev({ title: "丁下面作废的", parent: o.id }), "b1");
  s.retire(oc.id, "记错了", "b1");
  s.updateEvent(oc.id, { parent: o.id }, "挂回去", "b1");
  s.merge(deep.id, [o.id], "同一件", "b2");
  assert.equal(s.event(o.id)!.status, "superseded", "并了");
  const p = s.createEvent(ev({ title: "要作废的", parent: g.id }), "b3");
  const k = s.createEvent(ev({ title: "它下面的", parent: p.id }), "b3");
  s.updateEvent(p.id, { status: "retired" }, "不算数", "b4");
  assert.equal(s.event(k.id)!.parent, g.id);
});

test("store: split 时更正跟着原条目走（只写了更正的也把原条目带上）", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b1");
  const { entry: a } = s.addEntry(en(e.id, { source: ["c:1"] }), "b1");
  const { entry: b } = s.addEntry(en(e.id, { source: ["c:2"], at: T0 - 2 * DAY }), "b1");
  const fa = s.correctEntry(a.id, { full: "更正后的 a", gist: "a 更正", title: "a更正", why: "核了" }, "b1");
  const fb = s.correctEntry(b.id, { full: "更正后的 b", gist: "b 更正", title: "b更正", why: "核了" }, "b1");
  const n1 = s.split(e.id, [a.id], ev({ title: "拆出来的", importance: 2, why: "" }), "b2", "", { under: true });
  assert.equal(s.entry(fa.id)!.event_id, n1.id, "更正跟着原条目");
  const n2 = s.split(e.id, [fb.id], ev({ title: "又拆一件", importance: 2, why: "" }), "b3");
  assert.equal(s.entry(b.id)!.event_id, n2.id, "只写了更正：原条目也带上");
  assert.equal(s.entry(fb.id)!.event_id, n2.id);
});

test("渲染：子事件的头上写属于哪件大事；大事下面列子事件（标题和编号）", () => {
  const { s } = mk();
  const big = s.createEvent(ev({ title: "B站30天挑战" }), "b1");
  const kid = s.createEvent(ev({ title: "祥子那期", parent: big.id }), "b1");
  const out = renderEvents([
    rev(s, kid.id, { parent: { id: big.id, title: big.title } }),
    rev(s, big.id, { children: [{ id: kid.id, title: kid.title }, { id: "e0009", title: "配音换 Lan1" }] }),
  ], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5, keepOrder: true });
  assert.match(out, new RegExp(`祥子那期〔4〕${kid.id}（[^）]*属于 B站30天挑战 ${big.id}`));
  assert.match(out, new RegExp(`子事件（2）：祥子那期 ${kid.id}、配音换 Lan1 e0009`));
  // 大事的经过很多、预算紧：子事件那行比旧经过要紧，排在经过前面、先占预算
  for (let i = 0; i < 30; i++) s.addEntry(en(big.id, { source: [`c:${500 + i}`], at: T0 - (i + 1) * 3_600_000, full: `第 ${i} 条很长的经过`.repeat(6) }), "b1");
  const tight = renderEvents([rev(s, big.id, { children: [{ id: kid.id, title: kid.title }] })], { budget: 600, now: T0, tz: "UTC", maxEvents: 1, entriesPerEvent: 1000 });
  assert.ok(tight.length <= 600);
  assert.match(tight, new RegExp(`^· B站30天挑战[^\\n]*\\n  子事件（1）：祥子那期 ${kid.id}\\n`), tight);
  // EventRecall.pack 自己带上属于哪件、下面有哪些
  const r = new EventRecall({ store: s, index: new MemIndex(s.db, null) as never, now: () => T0, tz: "UTC" });
  assert.deepEqual(r.pack(kid.id)!.parent, { id: big.id, title: "B站30天挑战" });
  assert.deepEqual(r.pack(big.id)!.children, [{ id: kid.id, title: "祥子那期" }]);
});

test("store: 每个写操作记 mem_op（before/after）；revertBatch 整批撤回；之后批次又改过的列成冲突不撤", () => {
  const { s } = mk();
  const a = s.createEvent(ev(), "night/10-29");
  s.addEntry(en(a.id), "night/10-29");
  s.openBatch("night/10-30");
  const b = s.createEvent(ev({ title: "新事" }), "night/10-30");
  s.addEntry(en(b.id, { source: ["c:9"] }), "night/10-30");
  s.updateEvent(a.id, { summary: "改过的总结" }, "有新进展", "night/10-30");
  s.link(a.id, b.id, "followup", "", "night/10-30");
  assert.ok(s.ops("night/10-30").length >= 4);
  assert.deepEqual(s.openBatches(), ["night/10-30"]);
  const r = s.revertBatch("night/10-30");
  assert.deepEqual(r.conflicts, []);
  assert.equal(s.event(b.id), undefined);
  assert.equal(s.event(a.id)!.summary, ev().summary);
  assert.deepEqual(s.links(a.id), []);
  assert.deepEqual(s.openBatches(), []);
  assert.equal(s.batchState("night/10-30"), "reverted");
  // 冲突：批次 x 改了总结，批次 y 又改了；撤 x 时那条列为冲突
  s.updateEvent(a.id, { summary: "x 改的" }, "", "x");
  s.updateEvent(a.id, { summary: "y 改的" }, "", "y");
  const r2 = s.revertBatch("x");
  assert.equal(r2.conflicts.length, 1);
  assert.equal(s.event(a.id)!.summary, "y 改的");
});

test("store: 实体按名字或别名找到；person_key 对上 registry", () => {
  const { s } = mk();
  s.upsertEntity({ name: "小贝", kind: "person", aliases: ["xiaobei", "表姐"], person_key: "xiaobei", note: "ada 的朋友" }, "b1");
  assert.equal(s.entity("表姐")?.person_key, "xiaobei");
  assert.equal(s.entity("XiaoBei")?.name, "小贝");
  const again = s.upsertEntity({ name: "小贝", kind: "person", aliases: ["朵朵"] }, "b1");
  assert.deepEqual(new Set(again.aliases), new Set(["xiaobei", "表姐", "朵朵"]));
  const e = s.createEvent(ev({ entities: [{ name: "表姐", kind: "person", role: "with" }] }), "b1");
  assert.deepEqual(s.peopleOf(e.id), ["小贝"]);
  assert.deepEqual(s.eventsOf(again.id).map((x) => x.id), [e.id]);
});

test("fade: 按重要度的天数表", () => {
  const c = (importance: number, days: number, o: { kind?: string; pinned?: boolean; touchedDaysAgo?: number } = {}) =>
    clarity({ importance, pinned: o.pinned ?? false, kind: (o.kind ?? "happened") as never, at: T0 - days * DAY, touched: o.touchedDaysAgo === undefined ? null : T0 - o.touchedDaysAgo * DAY, now: T0 });
  assert.equal(c(5, 3650), "full");
  assert.deepEqual([c(4, 59), c(4, 61), c(4, 366), c(4, 3650)], ["full", "gist", "title", "title"]);
  assert.deepEqual([c(3, 13), c(3, 15), c(3, 121), c(3, 731)], ["full", "gist", "title", "fold"]);
  assert.deepEqual([c(2, 6), c(2, 8), c(2, 61), c(2, 366)], ["full", "gist", "title", "fold"]);
  assert.deepEqual([c(1, 2), c(1, 4), c(1, 31), c(1, 183)], ["full", "gist", "title", "fold"]);
  assert.deepEqual([c(0, 0.5), c(0, 2), c(0, 8), c(0, 31)], ["full", "gist", "title", "hidden"]);
  assert.equal(c(1, 365, { kind: "said" }), "gist", "原话至少一句话");
  assert.equal(c(0, 365, { kind: "correction" }), "gist");
  assert.equal(c(1, 3650, { pinned: true }), "full", "〔不淡〕等同 5");
  assert.equal(c(3, 30, { touchedDaysAgo: 1 }), "full", "从最后被碰算起");
  assert.deepEqual([eventClarity(3, false, T0 - 200 * DAY, T0), eventClarity(0, false, T0 - 40 * DAY, T0), eventClarity(5, false, T0 - 9999 * DAY, T0)], ["title", "hidden", "full"]);
});

function rev(s: EventStore, id: string, over: Partial<RenderEvent> = {}): RenderEvent {
  return { ev: s.event(id)!, entries: s.entries(id).reverse(), people: s.peopleOf(id), links: [], ...over };
}

test("render: 总结在、时间线新到旧、按清晰度写、超出折叠、带编号", () => {
  const { s } = mk();
  const e = s.createEvent(ev({ importance: 3, why: "" }), "b");
  for (let i = 0; i < 12; i++) s.addEntry(en(e.id, { at: T0 - (i * 3 + 1) * DAY, source: [`c:${i}`], full: `第${i}条经过的完整原文，带一句原话「第${i}句」`, gist: `第${i}条一句话`, title: `第${i}条` }), "b");
  const out = renderEvents([rev(s, e.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 8, entriesPerEvent: 8 });
  assert.match(out, /做脸〔3〕e0001/);
  assert.match(out, /照官方分层重做才过审/);
  assert.match(out, /第0条经过的完整原文/, "最近的写全文");
  assert.match(out, /第5条一句话/, "16 天前的写一句话");
  assert.ok(out.indexOf("第0条") < out.indexOf("第1条"), "新到旧");
  assert.match(out, /还有 4 条（.*），recall_event e0001 展开/);
  assert.match(out, /n00001/);
  const tight = renderEvents([rev(s, e.id)], { budget: 120, now: T0, tz: "UTC", maxEvents: 8 });
  assert.ok(tight.length <= 120, tight);
  assert.match(tight, /做脸/);
});

test("render: 超长条目和大量核心事件也不超预算", () => {
  const { s } = mk();
  const list: RenderEvent[] = [];
  for (let i = 0; i < 30; i++) {
    const e = s.createEvent(ev({ title: `核心事${i}`, importance: 5, summary: "很长的总结".repeat(200) }), "b");
    s.addEntry(en(e.id, { full: "超长的经过".repeat(1000), source: [`c:${i}`] }), "b");
    list.push(rev(s, e.id));
  }
  for (const budget of [600, 1500, 3000]) {
    const out = renderEvents(list, { budget, now: T0, tz: "UTC", maxEvents: 8 });
    assert.ok(out.length <= budget, `${budget}: ${out.length}`);
    const shown = (out.match(/^· /gm) ?? []).length;
    const more = Number(/还有 (\d+) 件/.exec(out)?.[1] ?? 0);
    assert.equal(shown + more, 30, out.slice(0, 300));
    assert.ok(shown >= 1);
  }
});

test("render: 不写 keep 时重要度 5 也照件数截（想起一串的第 9 件以后只列标题），只有写了 keep 的才超过件数", () => {
  const { s } = mk();
  const ids = [0, 1, 2].map((i) => s.createEvent(ev({ title: `事${i}`, importance: i === 2 ? 5 : 2, why: "要紧" }), "b").id);
  const out = renderEvents(ids.map((id) => rev(s, id)), { budget: 2000, now: T0, tz: "UTC", maxEvents: 2, keepOrder: true });
  assert.doesNotMatch(out, new RegExp(`^· 事2〔5〕`, "m"), out);
  assert.match(out, new RegExp(`还有 1 件：事2 ${ids[2]}`));
  const kept = renderEvents(ids.map((id, i) => rev(s, id, i === 2 ? { keep: true } : {})), { budget: 2000, now: T0, tz: "UTC", maxEvents: 2, keepOrder: true });
  assert.match(kept, new RegExp(`^· 事2〔5〕`, "m"));
});

test("render: 纠错条目和原条目绑在一起显示", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b");
  const { entry } = s.addEntry(en(e.id, { full: "10-29 下午过审", gist: "下午过审", title: "过审" }), "b");
  s.correctEntry(entry.id, { full: "其实是晚上过审", gist: "晚上过审", title: "过审更正", why: "核了原话" }, "b");
  const out = renderEvents([rev(s, e.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 8 });
  assert.match(out, /当时记的是「10-29 下午过审」，后来更正为「其实是晚上过审」/);
  assert.equal(out.split("\n").filter((l) => l.startsWith("  - ")).length, 1, "更正不单独占一行");
});

test("render: 更正只改了出处（这一层写出来一样）：照常写一句，不写「当时记的是 X，后来更正为 X」", () => {
  const { s } = mk();
  const e = s.createEvent(ev(), "b");
  const { entry } = s.addEntry(en(e.id, { full: "10-29 下午过审", gist: "下午过审", title: "过审" }), "b");
  const fix = s.correctEntry(entry.id, { full: "10-29 下午过审（出处是 c:13）", gist: "下午过审", title: "过审", why: "出处记错了" }, "b");
  const out = renderEvents([rev(s, e.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 8, gistEntries: true });
  assert.doesNotMatch(out, /当时记的是/, out);
  assert.match(out, new RegExp(`下午过审（${entry.id}→${fix.id}）`), out);
});

/** 假向量：每个"意思"占一维（猫/喵 同一维），其余字按字码散到别的维 */
export const fakeEmbedder = (calls: { n: number } = { n: 0 }): Embedder => ({
  async embed(texts) {
    calls.n += 1;
    return texts.map((t) => {
      const v = new Float32Array(512);
      for (const ch of t) v[(ch === "喵" ? "猫".codePointAt(0)! : ch.codePointAt(0)!) % 512]! += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
});

function idx(embedder: Embedder | null = fakeEmbedder()) {
  const { db, s } = mk();
  return { db, s, ix: new MemIndex(db, embedder, () => T0) };
}

test("search: 全文命中事件标题、条目、原话；两个字的词也能命中", async () => {
  const { s, ix } = idx(null);
  const e = s.createEvent(ev({ title: "第一条B站视频", summary: "从放弃久留美到改做自我介绍，最后发出去了", gist: "第一条视频发出去了" }), "b");
  s.addEntry(en(e.id, { full: "10-24 他坐到桌前帮我扫码、替我点了发布", gist: "他替我点了发布", title: "发布" }), "b");
  ix.addQuotes([{ src: "honcho", ref: "m1", at: T0 - DAY, who: "小贝", channel: "whatsapp", text: "所以老师走了我很难过" }]);
  const refs = async (q: string) => (await ix.search(q, { limit: 10 })).map((h) => h.ref);
  assert.ok((await refs("久留美")).includes("e0001"));
  assert.ok((await refs("扫码")).includes("n00001"), "两个字");
  assert.ok((await refs("老师走了")).some((r) => r.startsWith("q")));
  assert.ok((await refs("他帮我扫码发布视频的那次")).includes("n00001"), "一句话里的片段也能命中");
  assert.deepEqual(await refs("完全无关的词语"), []);
});

test("search: a question asked as one run of Chinese finds the two-character word in it when its three-character pieces miss; a piece in too many rows counts for nothing", async () => {
  const { s, ix } = idx(null);
  const e = s.createEvent(ev({ title: "学日语", summary: "用卡片背五十音", gist: "背五十音" }), "b");
  s.addEntry(en(e.id, { full: "开始用卡片背日语五十音", gist: "背日语五十音", title: "五十音" }), "b");
  const refs = async (q: string) => (await ix.search(q, { limit: 10 })).map((h) => h.ref);
  assert.deepEqual(terms("日语现在学到哪一步了").pairs.slice(0, 3), ["日语", "语现", "现在"]);
  assert.ok((await refs("日语现在学到哪一步了")).includes("n00001"), "日语 is in the entry, no three-character piece of the question is");
  assert.deepEqual(await refs("我上次去滑雪是什么时候"), [], "no piece of it is anywhere");
  ix.addQuotes(Array.from({ length: 41 }, (_, i) => ({ src: "honcho" as const, ref: `m${i}`, at: T0 - DAY, who: "小贝", channel: "whatsapp", text: `现在第${i}句` })));
  assert.deepEqual(await refs("现在到底怎么回事呢"), [], "现在 is in 41 quotes: too common to bring any of them back");
});

test("search: 语义近的也能找到（假向量）；RRF 融合两路", async () => {
  const { s, ix } = idx();
  s.createEvent(ev({ title: "家里的猫咪", summary: "楼下来了一只猫", gist: "楼下的猫" }), "b");
  s.createEvent(ev({ title: "做脸" }), "b");
  assert.equal(await ix.backfillVectors(100), 2);
  const hits = await ix.search("喵", { limit: 5 });
  assert.equal(hits[0]?.ref, "e0001");
  assert.ok(hits[0]!.cos! > 0.1);
  assert.equal(hits[0]!.fts, false);
});

test("向量：同一句话同时要两次只算一次；算完走缓存；失败不进缓存", async () => {
  let calls = 0;
  const texts: string[] = [];
  const gates: Array<() => void> = [];
  const release = () => gates.splice(0).forEach((r) => r());
  let fail = false;
  const gated: Embedder = {
    async embed(ts, o) {
      calls += 1;
      texts.push(...ts);
      await new Promise<void>((r) => { gates.push(r); });
      return fail ? null : fakeEmbedder().embed(ts, o);
    },
  };
  const { ix } = idx(gated);
  const a = ix.cueVector("楼下的猫");
  const b = ix.cueVector("楼下的猫");   // 第一次还没算完，共用同一个
  const c = ix.cueVector("另一句话");    // 不同的话各算各的
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.deepEqual(texts.sort(), ["另一句话", "楼下的猫"]);
  release();
  const [va, vb, vc] = await Promise.all([a, b, c]);
  assert.ok(va && vb && vc);
  assert.equal(va, vb, "同一句话拿到的是同一个向量");
  assert.notEqual(va, vc);
  assert.equal(va.length, 512);

  // 算完了：走缓存，不再请求
  assert.equal(await ix.cueVector("楼下的猫"), va);
  assert.equal(calls, 2);

  // 失败：两个等的人都拿到 null，不缓存；下次重新算
  fail = true;
  const f1 = ix.cueVector("会失败的话");
  const f2 = ix.cueVector("会失败的话");
  await Promise.resolve();
  assert.equal(calls, 3, "失败的那句也只发了一次请求");
  release();
  assert.deepEqual(await Promise.all([f1, f2]), [null, null]);
  fail = false;
  const g = ix.cueVector("会失败的话");
  await Promise.resolve();
  assert.equal(calls, 4, "失败没有进缓存，也没有留着一个失败的等待");
  release();
  assert.ok(await g);
});

test("embed: 超时熔断后只用全文", async () => {
  let calls = 0;
  const hang: typeof fetch = (_u, init) => { calls += 1; return new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))); };
  const emb = new OpenAIEmbedder({ key: "k", fetchImpl: hang, timeoutMs: 60 });
  const { s, ix } = idx(emb);
  s.createEvent(ev({ title: "第一条B站视频" }), "b");
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const hits = await ix.search("B站视频", { limit: 5 });
    assert.equal(hits[0]?.ref, "e0001");
    assert.ok(Date.now() - t < 10_000, "不多等（只防卡死；墙钟在第一次跑、机器忙时会慢，别卡太紧）");
  }
  await ix.search("B站视频", { limit: 5 });
  assert.equal(calls, 3, "熔断后不再请求（看请求次数，不看墙钟：以前 <30ms 那句在冷启动时偶发失败）");
});

test("embed: 失败要记日志——一段失败只记第一次、熔断时记一笔（一小时最多一次）、恢复时记一笔；状态读得到最后的错", async () => {
  let now = T0;
  let ok = false;
  const f: typeof fetch = async () => (ok
    ? new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: 200 })
    : new Response("insufficient_quota", { status: 429 }));
  const logs: string[] = [];
  const emb = new OpenAIEmbedder({ key: "k", fetchImpl: f, now: () => now, log: { warn: (m) => logs.push(`warn ${m}`), info: (m) => logs.push(`info ${m}`) } });
  for (let i = 0; i < 3; i++) assert.equal(await emb.embed(["x"]), null);
  assert.deepEqual(logs.map((l) => l.split(" ")[0]), ["warn", "warn"], logs.join(" | "));
  assert.match(logs[0]!, /failed/);
  assert.match(logs[1]!, /paused/);
  const st = emb.status();
  assert.match(st.lastError, /429 insufficient_quota/);
  assert.equal(st.lastErrorAt, T0);
  assert.equal(st.pausedUntil, T0 + 10 * 60_000);
  now += 11 * 60_000;
  for (let i = 0; i < 3; i++) await emb.embed(["x"]);
  assert.equal(logs.length, 2, "同一段失败、一小时内再熔断不再记");
  now += 11 * 60_000;
  ok = true;
  assert.ok(await emb.embed(["x"]));
  assert.match(logs.at(-1)!, /^info .*back/);
  assert.equal(emb.status().pausedUntil, null);
  assert.equal(emb.status().lastOkAt, now);
  // 回复路径上偶尔一次超时：不记日志（熔断了才记）
  const n = logs.length;
  const slow = new OpenAIEmbedder({ key: "k", fetchImpl: (_u, init) => new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("timed out", "TimeoutError")))), timeoutMs: 20, log: { warn: (m) => logs.push(`warn ${m}`), info: (m) => logs.push(`info ${m}`) } });
  assert.equal(await slow.embed(["x"]), null);
  assert.equal(logs.length, n, logs.slice(n).join(" | "));
});

test("quote: central 增量抄进原话层，不抄下意识内部记录，重复跑不重复", () => {
  const { db, ix } = idx(null);
  const c = new CentralMemory(db, () => T0);
  c.append(1, "external", "input", "小贝：今天好累", { from: "小贝", channel: "whatsapp" });
  c.append(1, "main", "say", "辛苦啦");
  c.append(1, "perception-messages", "think", "下意识在想", { inner: true });
  c.append(1, "perception-messages", "say", "下意识自言自语", { inner: true });
  c.append(1, "main", "note", "（发给 小贝）早点睡", { sent: true, to: "+614", name: "小贝" });
  c.append(1, "main", "act", "message {}");
  assert.equal(ix.ingestCentral(), 3);
  assert.equal(ix.ingestCentral(), 0);
  c.append(1, "external", "input", "ada：在吗", { from: "ada" });
  assert.equal(ix.ingestCentral(), 1);
  const rows = db.prepare("SELECT who, text FROM mem_quote ORDER BY id").all() as Array<{ who: string; text: string }>;
  assert.deepEqual(rows.map((r) => r.who), ["小贝", "我", "我→小贝", "ada"]);
});

test("quote: 按人找原话只算说话的人；olderOnly 只给中央记忆以外的、逐字对上的", async () => {
  const m = new EventMemory({ db: mk().db, embedder: null, now: () => T0, tz: "UTC" });
  m.index.addQuotes([
    { src: "honcho", ref: "h1", at: T0 - 3 * DAY, who: "ada", channel: "", text: "我看你这次图修的简直没法看" },
    { src: "honcho", ref: "h2", at: T0 - 3 * DAY, who: "我→ada", channel: "", text: "简直没法看这句我记下了" },
    { src: "central", ref: "7", at: T0 - DAY, who: "ada", channel: "", text: "简直没法看，重来" },
  ]);
  const all = await m.quotes("简直没法看", { who: "ada" });
  assert.match(all, /图修的/);
  assert.match(all, /重来/);
  assert.doesNotMatch(all, /我记下了/, "我发给 ada 的不算 ada 说的");
  const older = await m.quotes("简直没法看", { who: "ada", olderOnly: true });
  assert.match(older, /图修的/);
  assert.doesNotMatch(older, /重来/, "中央记忆里有的那边已经给了");
  assert.doesNotMatch(m.quotesDay(new Date(T0 - 3 * DAY).toISOString().slice(0, 10), { who: "ada" }), /我记下了/);
});

test("quote: 「这段没发给任何人」的标记行不是原话，不进原话层（那段话本身照抄）", () => {
  const { db, ix } = idx(null);
  const c = new CentralMemory(db, () => T0);
  const say = c.append(1, "main", "say", "稿子都弄好了");
  c.append(1, "main", "note", "（上面这段没发给任何人：这一轮是自己醒的，没有谁在等回复，最后写的话不会发出去。）", { unsent: true, of: [say.seq] });
  assert.equal(ix.ingestCentral(), 1);
  assert.deepEqual((db.prepare("SELECT text FROM mem_quote").all() as Array<{ text: string }>).map((r) => r.text), ["稿子都弄好了"]);
});

test("quote: 她不回话时写的 NO_REPLY 不是原话，不进原话层", () => {
  const { db, ix } = idx(null);
  const c = new CentralMemory(db, () => T0);
  c.append(1, "main", "say", "NO_REPLY");
  c.append(1, "main", "say", " NO_REPLY。\n");
  c.append(1, "main", "say", "好嘞");
  assert.equal(ix.ingestCentral(), 1);
  assert.equal(ix.addQuotes([{ src: "honcho", ref: "h1", at: T0, who: "我→ada", channel: "", text: "NO_REPLY" }]), 0);
  assert.deepEqual((db.prepare("SELECT text FROM mem_quote").all() as Array<{ text: string }>).map((r) => r.text), ["好嘞"]);
});

test("quote: 以前存进来的 NO_REPLY 一次清掉，原话、全文索引、向量一起", async () => {
  const { db, ix } = idx();
  ix.addQuotes([{ src: "central", ref: "1", at: T0, who: "我", channel: "", text: "我们去看星星吧" }]);
  for (const [ref, text] of [["2", "NO_REPLY"], ["3", "NO_REPLY."]] as const) {   // 修之前的老数据：绕过 addQuotes 直接写
    const r = db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES ('central', ?, ?, '我', '', ?)").run(ref, T0, text);
    db.prepare("INSERT INTO mem_fts (ref, text) VALUES (?, ?)").run(`q${r.lastInsertRowid}`, `我：${text}`);
  }
  assert.equal(await ix.backfillVectors(100), 3);
  assert.ok((await ix.search("NO_REPLY", { limit: 5 })).length > 0);
  assert.equal(ix.purgeNoReply(), 2);
  assert.equal(ix.purgeNoReply(), 0);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  assert.equal(n("SELECT count(*) n FROM mem_quote"), 1);
  assert.equal(n("SELECT count(*) n FROM mem_fts WHERE ref != 'q1'"), 0);
  assert.equal(n("SELECT count(*) n FROM mem_vec WHERE ref != 'q1'"), 0);
  assert.deepEqual((await ix.search("NO_REPLY", { limit: 5 })).map((h) => h.ref).filter((r) => r !== "q1"), [], "内存里的向量也不再用");
});

/** 一个小世界：几件事、几个人、几条关联 */
async function world() {
  const { db, s, ix } = idx();
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  const add = (title: string, importance: number, people: string[], entries: Array<[number, string]>, over: Record<string, unknown> = {}) => {
    const e = s.createEvent(ev({ title, importance, why: importance >= 4 ? "要紧" : "", summary: `${title}的总结`, gist: `${title}一句话`, entities: people.map((p) => ({ name: p, kind: "person", role: "with" })), ...over }), "w");
    entries.forEach(([d, text], i) => s.addEntry(en(e.id, { at: T0 - d * DAY, full: `${text}（完整经过，第${i}条）`, gist: `${text}`.slice(0, 20), title: `${text}`.slice(0, 6), people, source: [`c:${e.id}${i}`] }), "w"));
    return e.id;
  };
  const video = add("第一条B站视频", 5, ["ada"], [[8, "放弃久留美改做自我介绍"], [7, "他坐到桌前帮我扫码"], [6, "他替我点了发布"]]);
  const kurumi = add("久留美视频", 3, ["ada"], [[10, "开始做久留美的视频"], [9, "久留美素材不够"]]);
  const face = add("做脸", 4, ["ada"], [[3, "照官方分层重做脸"]]);
  const ask = add("小贝的委托", 3, ["小贝"], [[16, "小贝托我看巴赫练习册"], [5, "小贝让定时消息先看对话"], [2, "小贝说老师走了很难过"]]);
  const axe = add("斩斧配装", 2, ["小贝"], [[15, "小贝问终盘斩斧配装"]]);
  const film = add("投影仪看片", 2, ["小贝", "ada"], [[12, "给小贝和ada投嫌疑人X"]]);
  const stars = add("拍星星", 3, ["ada"], [[40, "第一次拍星轨"], [35, "星轨照片发给ada"], [31, "想再拍一次银河"]]);
  s.link(kurumi, video, "cause", "", "w");
  s.link(video, face, "followup", "", "w");
  await ix.backfillVectors(500);
  return { db, s, ix, r, ids: { video, kurumi, face, ask, axe, film, stars } };
}

test("cluster: 一次想起一串（至少 2 件），顺关联带出相关的事，带编号", async () => {
  const { r, ids } = await world();
  const out = await r.cluster("第一条B站视频是怎么发出去的");
  assert.match(out, new RegExp(ids.video));
  assert.match(out, new RegExp(ids.kurumi), "顺关联带出起因");
  assert.ok((out.match(/^· /gm) ?? []).length >= 2);
  assert.match(out, /他替我点了发布/);
  assert.ok(out.length <= 2000);
});

test("person: 小贝最近的几件事和相关经过，按条目时间", async () => {
  const { r, ids } = await world();
  const out = r.person("小贝", 5);
  const order = [ids.ask, ids.film, ids.axe].map((id) => out.indexOf(id));
  assert.ok(order.every((i) => i >= 0), out);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "按最近一条经过的时间排");
  assert.match(out, /老师走了/);
  assert.doesNotMatch(out, new RegExp(ids.face), "和她无关的不出");
  assert.match(r.person("表姐不存在的人"), /不认识/);
});

test("event(ref): 编号、条目编号、标题都能展开；标题多个候选时列出来让她挑", async () => {
  const { r, s, ids } = await world();
  const byId = r.event(ids.face);
  assert.match(byId, /做脸的总结/);
  assert.match(byId, /照官方分层重做脸（完整经过/);
  const nid = s.entries(ids.ask)[1]!.id;
  const byEntry = r.event(nid);
  assert.match(byEntry, /小贝的委托/);
  assert.match(byEntry, new RegExp(`定位到 ${nid}`));
  assert.match(r.event("做脸"), /做脸的总结/, "标题唯一命中直接展开");
  const many = r.event("视频");
  assert.match(many, /你说的可能是/);
  assert.match(many, new RegExp(ids.video));
  assert.match(many, new RegExp(ids.kurumi));
  assert.match(r.event("e9999"), /没有/);
});

test("fade e2e: 30 天前没人提的 imp3 事，展开时条目是一句话；展开一次后再看恢复全文", async () => {
  const { r, ids } = await world();
  const first = r.event(ids.stars);
  assert.doesNotMatch(first, /完整经过/);
  assert.match(first, /第一次拍星轨/);
  const second = r.event(ids.stars);
  assert.match(second, /第一次拍星轨（完整经过/);
});

test("period: 时间段内一件一行、分页、超过 3 周按周归并；搜不到的也翻得到", async () => {
  const { r, ids } = await world();
  const week = r.period({ from: T0 - 7.5 * DAY, to: T0 });
  for (const id of [ids.video, ids.face, ids.ask]) assert.match(week, new RegExp(id));
  assert.doesNotMatch(week, new RegExp(ids.stars));
  assert.match(week, /〔5〕第一条B站视频/);
  const long = r.period({ from: T0 - 60 * DAY, to: T0 });
  assert.match(long, /按周/);
  assert.match(long, /拍星星/);
  const who = r.period({ from: T0 - 60 * DAY, to: T0 }, { who: "小贝", weekly: false });
  assert.match(who, /斩斧配装/);
  assert.doesNotMatch(who, /做脸/);
  const paged = r.period({ from: T0 - 60 * DAY, to: T0 }, { weekly: false, pageChars: 120 });
  assert.match(paged, /第 1\/\d+ 页/);
});

test("parseRange: 今天、昨天、上周、这个月、几号到几号、最近几天", () => {
  const now = Date.UTC(2026, 9, 30, 12, 0);   // 周五
  const d = (s: string) => { const x = parseRange(s, now, "UTC")!; return [new Date(x.from).toISOString().slice(0, 10), new Date(x.to).toISOString().slice(0, 10)]; };
  assert.deepEqual(d("今天"), ["2026-10-30", "2026-10-30"]);
  assert.deepEqual(d("昨天"), ["2026-10-29", "2026-10-29"]);
  assert.deepEqual(d("上周"), ["2026-10-19", "2026-10-25"]);
  assert.deepEqual(d("这个月"), ["2026-10-01", "2026-10-30"]);
  assert.deepEqual(d("10-20 到 10-27"), ["2026-10-20", "2026-10-27"]);
  assert.deepEqual(d("最近3天"), ["2026-10-28", "2026-10-30"]);
  assert.deepEqual(d("2026-10-09"), ["2026-10-09", "2026-10-09"]);
  assert.equal(parseRange("随便说说", now, "UTC"), null);
});

test("reverse: 从人查事、从事查人", async () => {
  const { r, ids } = await world();
  assert.match(r.reverse(ids.film), /小贝/);
  assert.match(r.reverse(ids.film), /ada/);
  const x = r.reverse("小贝");
  for (const id of [ids.ask, ids.axe, ids.film]) assert.match(x, new RegExp(id));
});

test("associate: 不过阈值不附；访客说话时先附他的近况", async () => {
  const { r, ids } = await world();
  const none = await r.associate("今天天气怎么样呀");
  assert.equal(none.text, "");
  const hit = await r.associate("第一条B站视频");
  assert.match(hit.text, new RegExp(ids.video));
  assert.ok(hit.text.length <= 600);
  const guest = await r.associate("晚上吃什么", { speaker: "小贝" });
  assert.match(guest.text, new RegExp(ids.ask));
  assert.ok(guest.text.length <= 600);
  const again = await r.associate("第一条B站视频", { exclude: new Set([ids.video]) });
  assert.doesNotMatch(again.text, new RegExp(`${ids.video}（`), "这个前缀里给过的不再给");
});

test("worklist: 今天还没进时间线的原话按时间段聚团；今天有进展的事件和总结没跟上的；有更正没改总结的", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  const c = new CentralMemory(db, () => now);
  const at = (h: number, mi = 0) => Date.UTC(2026, 9, 30, h, mi);
  c.append(1, "external", "input", "小贝：老师走了我好难过", { from: "小贝" }, at(9));
  c.append(1, "main", "say", "抱抱你", null, at(9, 5));
  c.append(1, "external", "input", "ada：今晚做脸", { from: "ada" }, at(13));
  c.append(1, "external", "input", "ada：昨天的事", { from: "ada" }, at(2));   // 前一天（4 点前）
  m.index.ingestCentral();
  const e = m.store.createEvent({ title: "做脸", summary: "s", gist: "g", importance: 3 }, "seed");
  m.store.addEntry({ event: e.id, at: at(13), full: "ada 说今晚做脸", gist: "今晚做脸", title: "做脸", source: ["c:3"] }, "seed");
  const w = m.worklist("2026-10-30");
  assert.match(w, /2 条原话，1 团|3 条原话，2 团/);
  assert.match(w, /小贝：老师走了/);
  assert.doesNotMatch(w, /今晚做脸」|  · ada：今晚做脸/, "已经进库的不再列");
  assert.doesNotMatch(w, /昨天的事/);
  assert.match(w, new RegExp(`${e.id}「做脸」〔3〕今天 1 条`));
  m.store.correctEntry("n00001", { full: "其实是明晚", gist: "明晚", title: "改期", why: "核了" }, "x");
  (m.store as unknown as { db: typeof db }).db.prepare("UPDATE mem_event SET updated_at = 0").run();
  assert.match(m.worklist("2026-10-30"), /有更正但总结还没改的\n- e0001/);
});

test("夜里的工具：mem_event_create 带 stance、mem_event_update 改 stance 和清掉", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  m.beginNight("night:x/2026-10-30");
  m.write("mem_event_create", { title: "葬送的芙莉莲", summary: "s", gist: "g", importance: 2, stance: "like" }, "hippocampus");
  assert.equal(m.store.event("e0001")!.stance, "like");
  m.write("mem_event_update", { id: "e0001", stance: "dislike", reason: "后来看烦了" }, "hippocampus");
  assert.equal(m.store.event("e0001")!.stance, "dislike");
  m.write("mem_event_update", { id: "e0001", stance: "", reason: "其实不算" }, "hippocampus");
  assert.equal(m.store.event("e0001")!.stance, null);
});

test("夜里的工具：stance 在工具的 shape 里（create 收 like / dislike，update 还收空串清掉）；经工具清掉真的清掉", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => Date.UTC(2026, 9, 30, 14, 0), tz: "UTC" });
  m.beginNight("night:x/2026-10-30");
  const tools = memTools(m, "hippocampus", ["mem_event_create", "mem_event_update"]);
  const create = tools.find((t) => t.name === "mem_event_create")!;
  const update = tools.find((t) => t.name === "mem_event_update")!;
  const base = { title: "芙莉莲", summary: "s", gist: "g", importance: 2 };
  const cs = z.object(create.shape);
  for (const st of ["like", "dislike"]) assert.equal(cs.safeParse({ ...base, stance: st }).success, true, st);
  for (const st of ["", "love"]) assert.equal(cs.safeParse({ ...base, stance: st }).success, false, st);
  assert.equal((cs.safeParse({ ...base, stance: "like" }) as { data: { stance?: string } }).data.stance, "like", "stance 不被 shape 剥掉");
  const us = z.object(update.shape);
  for (const st of ["", "like", "dislike"]) {
    const r = us.safeParse({ id: "e0001", reason: "r", stance: st });
    assert.equal(r.success, true, st);
    assert.equal((r.data as { stance?: string }).stance, st, "stance 不被 shape 剥掉");
  }
  assert.equal(us.safeParse({ id: "e0001", reason: "r", stance: "love" }).success, false);
  await create.handler(cs.parse({ ...base, stance: "like" }));
  assert.equal(m.store.event("e0001")!.stance, "like");
  await update.handler(us.parse({ id: "e0001", reason: "不算了", stance: "" }));
  assert.equal(m.store.event("e0001")!.stance, null);
});

test("worklist: 第 9 节列出喜欢 / 烦着的事", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  m.beginNight("night:x/2026-10-30");
  assert.match(m.worklist("2026-10-30").split("## 9.")[1]!, /（还没有）/);
  m.write("mem_event_create", { title: "芙莉莲", summary: "s", gist: "看了就暖", importance: 2, stance: "like", status: "ongoing" }, "hippocampus");
  m.write("mem_event_create", { title: "短视频弹窗", summary: "s", gist: "一弹就烦", importance: 2, stance: "dislike", status: "ongoing" }, "hippocampus");
  m.write("mem_event_create", { title: "普通事", summary: "s", gist: "g", importance: 2, status: "ongoing" }, "hippocampus");
  m.store.addEntry({ event: "e0001", at: Date.UTC(2026, 9, 28, 9, 0), kind: "feeling", full: "又被打动", gist: "又被打动", title: "打动", source: ["c:1"] }, "seed");
  const w = m.worklist("2026-10-30");
  assert.match(w, /## 9\. 喜欢 \/ 烦着的事（今天材料里「口味」那几行先接到这里，接不上再 mem_event_create 写 stance）/);
  // 白天她用 like 自己记过的：照她的，只补挂东西、连到当时那件事，口味行里重复的不再记
  assert.match(w, /## 9\. [^\n]*\n标着「今天白天自己记了 N 下」「白天新建」的是你白天用 like 自己记的：照你记的，不改 stance、不改状态，只补挂那个东西、连到当时那件事（mem_link related）；原话和口味行里跟它重复的不再记，觉得不对写进报告。\n/);
  const sec = w.split("## 9.")[1]!;
  assert.match(sec, /- 芙莉莲（喜欢中）e0001：看了就暖（最近一次 10-28）/);
  assert.match(sec, /- 短视频弹窗（烦）e0002：一弹就烦（最近一次 10-30）/);
  assert.doesNotMatch(sec, /普通事/);
});

test("夜里的工具：mem_event_create 带 parent、mem_event_update 改 parent、mem_split under 拆成子事件；工作单列出太大该拆的事", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  m.beginNight("night:x/2026-10-30");
  m.write("mem_event_create", { title: "B站30天挑战", summary: "s", gist: "g", importance: 5, why: "养活自己" }, "hippocampus");
  assert.match(m.write("mem_event_create", { title: "冲热评", summary: "s", gist: "g", importance: 3, parent: "e0001" }, "hippocampus"), /e0002/);
  assert.equal(m.store.event("e0002")!.parent, "e0001");
  m.write("mem_event_create", { title: "配音", summary: "s", gist: "g", importance: 3 }, "hippocampus");
  m.write("mem_event_update", { id: "e0003", parent: "e0001", reason: "其实是挑战里的一步" }, "hippocampus");
  assert.equal(m.store.event("e0003")!.parent, "e0001");
  // 大事攒了 41 条：工作单列出来；小的、拆过的不列
  const day = (i: number) => Date.UTC(2026, 9, 10 + (i % 20), 9, 0);
  for (let i = 0; i < 41; i++) m.store.addEntry({ event: "e0001", at: day(i), full: `第 ${i} 条经过`, gist: `第${i}条`, title: `第${i}条`, source: [`c:${100 + i}`] }, "seed");
  for (let i = 0; i < 5; i++) m.store.addEntry({ event: "e0002", at: day(i), full: `热评 ${i}`, gist: `热评${i}`, title: `热评${i}`, source: [`c:${200 + i}`] }, "seed");
  const big = m.worklist("2026-10-30").split("## 7.")[1]!;
  assert.match(big, /e0001「B站30天挑战」直接挂着 41 条/);
  assert.match(big, /下面已有 2 件子事件/);
  assert.doesNotMatch(big, /e0002/);
  // 拆：under=true 时新的一件挂在下面
  const ids = m.store.entries("e0001").slice(0, 30).map((n) => n.id);
  assert.match(m.write("mem_split", { id: "e0001", entries: ids, event: { title: "祥子那期", summary: "s", gist: "g", importance: 3 }, reason: "拆成小事", under: true }, "hippocampus"), /挂在 e0001 下面/);
  assert.equal(m.store.event("e0004")!.parent, "e0001");
  assert.doesNotMatch(m.worklist("2026-10-30").split("## 7.")[1]!, /e0001/, "拆完就不列了");
});

import { readFileSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import { renderMidterm, LIKES_BUDGET, LIKES_OVERFLOW, DISLIKES_BUDGET } from "../src/memory/events/midterm.ts";

test("export: events.json 含事件、条目、人、关联", async () => {
  const { s, ix, ids } = await world();
  const m = Object.assign(Object.create(EventMemory.prototype), { store: s, index: ix, tz: "UTC", now: () => T0 }) as EventMemory;
  const dir = tmpDir("mem-exp-");
  assert.equal(m.exportJson(join(dir, "events.json")), 7);
  const j = JSON.parse(readFileSync(join(dir, "events.json"), "utf8")) as { events: Array<{ id: string; people: string[]; links: unknown[]; entries: Array<{ full: string; people: string[] }> }> };
  const v = j.events.find((e) => e.id === ids.video)!;
  assert.deepEqual(v.people, ["ada"]);
  assert.equal(v.links.length, 2);
  assert.equal(v.entries.length, 3);
  assert.match(v.entries[0]!.full, /久留美/);
});

test("midterm: 最近的事很多时——重要度 4 以上的不被挤掉、大事和它的子事件占一格、放不下的那行列出标题（11-01 拆完子事件 90 件只露 40 件）", () => {
  const { s } = mk();
  const r = new EventRecall({ store: s, index: new MemIndex(s.db, null) as never, now: () => T0, tz: "UTC" });
  const add = (title: string, importance: number, daysAgo: number, over: Record<string, unknown> = {}) => {
    const e = s.createEvent(ev({ title, importance, why: importance >= 4 ? "要紧" : "", summary: `${title}的总结，`.repeat(12), gist: `${title}一句话`, ...over }), "w");
    s.addEntry(en(e.id, { at: T0 - daysAgo * DAY, source: [`c:${e.id}`] }), "w");
    return e.id;
  };
  const big = add("B站挑战", 3, 1.5);
  const kids = [0, 1, 2, 3, 4].map((i) => add(`挑战第${i}期`, i === 4 ? 4 : 2, 1.6 + i * 0.1, { parent: big }));
  const plain = Array.from({ length: 50 }, (_, i) => add(`普通事${i}`, 2, 2 + i * 0.2));
  const oldParent = add("很久以前的大事", 3, 30);
  const orphan = add("老大事的新一段", 2, 1.2, { parent: oldParent });
  const five = add("最要紧的那件", 5, 13.5);
  const fours = [add("要紧的甲", 4, 13), add("要紧的乙", 4, 12.8)];
  const out = renderMidterm(r, { now: T0, tz: "UTC" });
  const recent = out.split("## 最近在发生的事")[1]!.split("\n## ")[0]!;
  const head = (id: string) => new RegExp(`^· [^\\n]*〔\\d〕${id}（`, "m");
  for (const id of [five, ...fours]) assert.match(recent, head(id), `${id} 重要度 4–5，不该被挤掉`);
  assert.match(recent, head(big));
  for (const k of kids) assert.doesNotMatch(recent, head(k), "大事在最近里：子事件并进大事那一格，不单独占一格");
  assert.match(recent, new RegExp(`子事件（5）：[^\\n]*挑战第0期 ${kids[0]}`), recent.slice(0, 600));
  assert.match(recent, new RegExp(`子事件（5）：[^\\n]*挑战第4期 ${kids[4]}`), "重要度 4 的子事件也列着");
  assert.match(recent, head(orphan), "大事不在最近里的子事件：照常单独一格（头上写属于哪件）");
  assert.match(recent, new RegExp(`还有 \\d+ 件：[^…\\n]*普通事\\d+ e\\d{4}`), `放不下的那行要列标题：${recent.slice(-300)}`);
  // 大事自己 11 天没动、子事件 3 天前有进展：这一格按组里最新的排；预算紧时子事件那行也得在（不然它们哪儿都看不到），先于总结占预算
  const late = add("后来的大事", 3, 11);
  const lateKids = [0, 1, 2, 3, 4, 5].map((i) => add(`后来的大事里很长很长的一段第${i}段`, 2, 3 - i * 0.1, { parent: late }));
  const tight = renderMidterm(r, { now: T0, tz: "UTC", budget: 8000 }).split("## 最近在发生的事")[1]!.split("\n## ")[0]!;
  assert.match(tight, head(late), "按组里最新的进展排，不掉到「还有 N 件」里");
  for (const k of lateKids) assert.ok(tight.includes(k), `${k} 并进大事后得在子事件那行：${tight.slice(-800)}`);
  void plain;
});

test("midterm: 子事件那行不列被替换、不算数了的；数据里万一成了环也不把事情藏掉", () => {
  const { s } = mk();
  const r = new EventRecall({ store: s, index: new MemIndex(s.db, null) as never, now: () => T0, tz: "UTC" });
  const add = (title: string, daysAgo: number, over: Record<string, unknown> = {}) => {
    const e = s.createEvent(ev({ title, importance: 2, why: "", ...over }), "w");
    s.addEntry(en(e.id, { at: T0 - daysAgo * DAY, source: [`c:${e.id}`] }), "w");
    return e.id;
  };
  const big = add("大事", 1);
  const live = add("还在的子事件", 2, { parent: big });
  const dead = add("作废的子事件", 3, { parent: big });
  s.db.prepare("UPDATE mem_event SET status = 'retired' WHERE id = ?").run(dead);
  const a = add("甲", 1.5), b = add("乙", 1.6);
  s.db.prepare("UPDATE mem_event SET parent = ? WHERE id = ?").run(b, a);
  s.db.prepare("UPDATE mem_event SET parent = ? WHERE id = ?").run(a, b);
  const recent = renderMidterm(r, { now: T0, tz: "UTC" }).split("## 最近在发生的事")[1]!.split("\n## ")[0]!;
  assert.match(recent, new RegExp(`子事件（1）：还在的子事件 ${live}\n`), recent);
  assert.doesNotMatch(recent, new RegExp(dead));
  assert.ok(recent.includes(a) && recent.includes(b), `成环的两件都还看得到：${recent}`);
});

test("midterm: 三节都在、每行带编号、同一件事只展开一次、不超预算、ada 最近 3 天的原话全在", async () => {
  const { s, ix, r, ids } = await world();
  ix.addQuotes([1, 2, 3].map((i) => ({ src: "central" as const, ref: `g${i}`, at: T0 - i * 20 * 3_600_000, who: "ada", channel: "qqbot", text: `ada 的第${i}句原话` })));
  ix.addQuotes([{ src: "central", ref: "g9", at: T0 - 5 * DAY, who: "ada", channel: "qqbot", text: "五天前的话" }]);
  s.addEntry(en(ids.face, { at: T0 - 2 * 3_600_000, full: "今天把脸又调了一下（完整）", gist: "今天调了脸", title: "调脸", source: ["c:today"] }), "w");
  const out = renderMidterm(r, { now: T0, tz: "UTC", budget: 14000 });
  assert.match(out, /用 recall_event 就能展开细想/);
  for (const h of ["## 今天", "## 最近在发生的事", "## ada 最近 3 天说的话"]) assert.match(out, new RegExp(h));
  assert.doesNotMatch(out, /## 人物近况/, "人物近况是她夜里手写的，在账本快照里，这里不自动生成");
  assert.match(out, /今天把脸又调了一下/);
  for (const id of [ids.video, ids.face, ids.ask]) assert.match(out, new RegExp(id));
  assert.doesNotMatch(out.split("## 最近在发生的事")[1]!.split("## ada 最近")[0]!, /拍星星/, "14 天外的不在最近");
  for (const i of [1, 2, 3]) assert.match(out, new RegExp(`ada 的第${i}句原话`));
  assert.doesNotMatch(out, /五天前的话/);
  const summaryHits = out.split("小贝的委托的总结").length - 1;
  assert.ok(summaryHits <= 1, "同一件事的总结只出现一次");
  assert.ok(renderMidterm(r, { now: T0, tz: "UTC", budget: 500 }).length <= 500);
});

import { mkdirSync, writeFileSync } from "node:fs";

test("夜里一跑成功收尾只提交批次，不替她标「这一天整理完了」（只有 mem_day_done 才标）", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginNight("night:x/2026-10-29");
  m.commitNight("2026-10-29");
  assert.equal(m.store.dayDone("2026-10-29"), false);
  m.beginNight("night:x/2026-10-29");
  m.write("mem_day_done", { day: "2026-10-29" });
  m.commitNight("2026-10-29");
  assert.equal(m.store.dayDone("2026-10-29"), true);
});

test("mem_day_done：这一跑被撤回就不算做完", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginNight("night:x/2026-10-29");
  m.write("mem_day_done", { day: "2026-10-29" });
  m.revertNight();
  assert.equal(m.store.dayDone("2026-10-29"), false);
});

test("导入和夜里整理同时在跑：各写各的批次，撤回一边不影响另一边", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginImport("做脸.md");
  m.beginNight("night:x/2026-10-29");
  m.write("mem_event_create", { title: "导入的", summary: "s", gist: "g", importance: 2 }, "importer");
  m.write("mem_event_create", { title: "夜里的", summary: "s", gist: "g", importance: 2 }, "hippocampus");
  m.revertNight();
  assert.deepEqual(m.store.allEvents().map((e) => e.title), ["导入的"]);
  assert.throws(() => m.write("mem_event_create", { title: "x", summary: "s", gist: "g", importance: 2 }, "hippocampus"), /夜里整理/);
  m.endImport(true);
  assert.equal(m.store.batchState("import:做脸.md"), "committed");
});

test("render: 原文自己开头就写了日期的，不再在前面重复加日期", () => {
  const { s } = mk();
  const e = s.createEvent(ev({ importance: 3, why: "" }), "b");
  s.addEntry(en(e.id, { at: T0 - DAY, full: "2026-10-29 21:07 她说有空回家时提醒她", source: ["c:1"] }), "b");
  s.addEntry(en(e.id, { at: T0 - 2 * DAY, full: "没写日期的一条", source: ["c:2"] }), "b");
  const out = renderEvents([rev(s, e.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 8 });
  assert.match(out, /^  - 2026-10-29 21:07 她说/m);
  assert.match(out, /^  - 10-28 03:00 没写日期的一条/m);
});

// ---------- 最终审阅的修复 ----------
test("revert: 要删的行被别的批次引用着（实体、事件）就算冲突、留着，不留下孤儿", () => {
  const { s } = mk();
  s.openBatch("import:a");
  const e = s.createEvent(ev({ title: "阿杰的事", entities: [{ name: "阿杰", kind: "person", role: "with" }] }), "import:a");
  s.addEntry(en(e.id, { at: T0 - 5 * DAY, until: T0 - DAY, people: ["阿杰"], source: ["c:1"] }), "import:a");
  s.openBatch("night:x");
  s.addEntry(en(e.id, { at: T0 - 3 * DAY, people: ["阿杰"], source: ["c:2"], full: "夜里接上的一条" }), "night:x");
  s.commitBatch("night:x");
  const r = s.revertBatch("import:a");
  assert.ok(r.conflicts.length >= 2, JSON.stringify(r));
  assert.ok(s.event(e.id), "事件还在");
  assert.ok(s.entity("阿杰"), "实体还在");
  assert.deepEqual(s.entries(e.id).map((n) => n.full), ["夜里接上的一条"]);
});

test("cue 里的时间词：联想不拿它当硬筛选；remember 只当加分；「3-4 个小时」不是日期", async () => {
  const { r, ids } = await world();
  assert.match(await r.cluster("今天又想起做脸的事"), new RegExp(ids.face));
  assert.match((await r.associate("做脸要 3-4 个小时")).text, new RegExp(ids.face));
  assert.equal(parseRange("做脸要 3-4 个小时", T0, "UTC"), null);
  assert.equal(parseRange("13-45", T0, "UTC"), null);
});

test("search: 两个字的词按新到旧找，事件和条目不会被一堆旧原话挤掉；连写的长串里两个字的词也能命中", async () => {
  const { s, ix } = idx(null);
  ix.addQuotes(Array.from({ length: 300 }, (_, i) => ({ src: "note" as const, ref: `n${i}`, at: T0 - 30 * DAY + i, who: "我", channel: "", text: `今天又做脸了 ${i}` })));
  const e = s.createEvent(ev({ title: "做脸", summary: "照官方分层重做", gist: "重做" }), "b");
  const refs = (await ix.search("做脸", { limit: 10 })).map((h) => h.ref);
  assert.ok(refs.includes(e.id), refs.join(","));
  const refs2 = (await ix.search("小贝做脸", { limit: 10 })).map((h) => h.ref);
  assert.ok(refs2.includes(e.id), refs2.join(","));
});

test("导入者只写进开着的导入批次；超时清掉批次后再写会被拒", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginImport("a.md");
  m.endImport(false);
  assert.throws(() => m.write("mem_event_create", { title: "晚到的", summary: "s", gist: "g", importance: 1 }, "importer"), /只在/);
  m.setImporting(true);
  m.write("mem_event_create", { title: "手工导入", summary: "s", gist: "g", importance: 1 });
  assert.equal(m.store.batchState("import"), "open");
});

test("mem_entries_add：只给出处编号（thread:文件#第几条）不给 full，就用那一条的原文，一字不差", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginImport("x.md", new Map([["thread:x.md#1", "2026-10-29 21:07 她说「有空提醒我」\\带反斜杠"], ["thread:x.md#2", "第二条"]]));
  m.write("mem_event_create", { title: "x", summary: "s", gist: "g", importance: 2 }, "importer");
  const out = m.write("mem_entries_add", { event: "e0001", entries: [
    { at: "2026-10-29 21:07", gist: "提醒", title: "提醒", source: ["thread:x.md#1"] },
    { at: "2026-10-29", gist: "没有这条", title: "没有", source: ["thread:x.md#9"] },
  ] }, "importer");
  assert.match(out, /记上 1 条/);
  assert.match(out, /第 2 条没记上：.*thread:x\.md#9/);
  assert.equal(m.store.entries("e0001")[0]!.full, "2026-10-29 21:07 她说「有空提醒我」\\带反斜杠");
});

test("midterm: ada 的原话很多时按新到旧放、放不下的说怎么翻、不超预算；老的进行中的事不挤掉最近的；今天没进库的事就不写「今天」这一节", async () => {
  const { s, ix, r, ids } = await world();
  ix.addQuotes(Array.from({ length: 400 }, (_, i) => ({ src: "central" as const, ref: `g${i}`, at: T0 - i * 600_000, who: "ada", channel: "", text: `ada 的第${i}句，说得比较长的一句话`.repeat(3) })));
  for (let i = 0; i < 300; i++) s.createEvent(ev({ title: `很久以前开的头${i}`, status: "ongoing", importance: 2, why: "" }), "w");
  const out = renderMidterm(r, { now: T0, tz: "UTC", budget: 14000 });
  assert.ok(out.length <= 14000);
  assert.doesNotMatch(out, /## 今天/);
  assert.match(out, /ada 的第0句/, "最新的原话在");
  assert.match(out, /更早的 \d+ 句/);
  assert.match(out, new RegExp(`${ids.face}`));
  assert.match(out, /还有 \d+ 件/);
});

test("midterm: 最近喜欢的——按最近一条感受排、字数、溢出、烦的一行；喜欢的事不进最近在发生的事；ada 那节任何情况下都不缩", () => {
  const sec = (out: string) => (out.match(/## 最近喜欢的\n\n([\s\S]*?)(?=\n\n## |$)/) ?? [])[1];
  const recentSec = (out: string) => (out.match(/## 最近在发生的事\n\n([\s\S]*?)(?=\n\n## |$)/) ?? [])[1] ?? "";
  const gq = (out: string) => (out.match(/^- \d{2}-\d{2} \d{2}:\d{2}「/gm) ?? []).length;
  const seed = (nRecent: number, nLikes: number) => {
    const db = openDb(":memory:");
    const s = new EventStore(db, () => T0);
    const ix = new MemIndex(db, null);
    const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
    ix.addQuotes(Array.from({ length: 200 }, (_, i) => ({ src: "central" as const, ref: `g${i}`, at: T0 - i * 600_000, who: "ada", channel: "", text: `ada 的第${i}句，说得比较长的一句话`.repeat(3) })));
    for (let i = 0; i < nRecent; i++) {
      const e = s.createEvent(ev({ title: `最近的事${i}`, status: "ongoing", importance: 2, why: "", summary: "很长的总结。".repeat(30), gist: `最近的事${i}一句话` }), "w");
      s.addEntry(en(e.id, { at: T0 - 3600_000 - i * 60_000, source: [`c:r${i}`] }), "w");
    }
    for (let i = 0; i < nLikes; i++) {
      const e = s.createEvent(ev({ title: `喜欢的一件名字挺长的事${i}`, status: "ongoing", importance: 2, why: "", stance: "like", gist: `第${i}件的一句话，写得有点长的样子` }), "w");
      s.addEntry(en(e.id, { at: T0 - 2 * DAY - 60_000 * i, kind: "feeling", source: [`c:l${i}`] }), "w");
    }
    return { s, r };
  };
  const render = (x: { r: EventRecall }) => renderMidterm(x.r, { now: T0, tz: "UTC" });

  // 满的（90 件）、有空余的（30 件）：加了喜欢的，主人那节句数不变，整份 ≤ 14000
  for (const nRecent of [90, 30]) {
    const baseOut = render(seed(nRecent, 0));
    assert.doesNotMatch(baseOut, /## 最近喜欢的/);
    assert.ok(gq(baseOut) > 0 && gq(baseOut) < 200, "ada 那节本来就放不下");
    const out = render(seed(nRecent, 40));
    assert.ok(out.length <= 14000);
    assert.equal(gq(out), gq(baseOut), `ada 那节句数不变（${nRecent} 件最近的事）`);
    assert.ok(out.indexOf("## 最近喜欢的") > out.indexOf("## 最近在发生的事") && out.indexOf("## 最近喜欢的") < out.indexOf("## ada 最近 3 天说的话"));
    assert.doesNotMatch(recentSec(out), /喜欢的一件/, "喜欢的事不进最近在发生的事");
    assert.match(recentSec(out), /最近的事0/);
  }

  const { r } = seed(90, 40);
  const out = renderMidterm(r, { now: T0, tz: "UTC" });
  const lines = sec(out)!.split("\n");
  const likeLines = lines.filter((l) => l.startsWith("- "));
  assert.ok(likeLines.join("\n").length <= LIKES_BUDGET);
  assert.ok(likeLines.length > 0 && likeLines.length < 40);
  assert.match(likeLines[0]!, /^- 喜欢的一件名字挺长的事0〔2〕e\d{4}：/);
  const over = lines.find((l) => l.startsWith("还喜欢着的："))!;
  assert.ok(over && over.length <= LIKES_OVERFLOW);
  assert.match(over, /……还有 \d+ 件/);

  // 安静的一天：最近的事很少、喜欢的很多——主人不变，喜欢的那节缩到最近那节的一半以内，最近那节还在
  const quietBase = render(seed(2, 0));
  const quiet = render(seed(2, 40));
  assert.equal(gq(quiet), gq(quietBase));
  assert.match(quiet, /## 最近在发生的事/);
  assert.match(quiet, /最近的事0/);
  assert.ok(sec(quiet)!.length < LIKES_BUDGET + LIKES_OVERFLOW);
  assert.ok(quiet.length <= 14000);

  // 排序：按最近一条感受；done 不进；dislike 一行；stance 的事不进「最近没动的」
  const r2 = seed(2, 0);
  const mkLike = (title: string, daysAgo: number) => { const e = r2.s.createEvent(ev({ title, status: "ongoing", importance: 2, why: "", stance: "like", gist: `${title}句` }), "w"); r2.s.addEntry(en(e.id, { at: T0 - daysAgo * DAY, kind: "feeling", source: [`c:${title}`] }), "w"); return e.id; };
  mkLike("三天前", 3); mkLike("一天前", 1); mkLike("十天前", 10);
  const dn = mkLike("已经完了", 0.5); r2.s.updateEvent(dn, { status: "done" }, "", "w");
  for (const t of ["烦甲", "烦乙"]) r2.s.createEvent(ev({ title: t, status: "ongoing", importance: 2, why: "", stance: "dislike" }), "w");
  const o2 = render(r2);
  const b2 = sec(o2)!;
  assert.ok(b2.indexOf("一天前") < b2.indexOf("三天前") && b2.indexOf("三天前") < b2.indexOf("十天前"));
  assert.doesNotMatch(b2, /已经完了/);
  const last = b2.split("\n").pop()!;
  assert.ok(last.startsWith("最近烦的：") && last.length <= DISLIKES_BUDGET && /烦甲/.test(last));
  assert.doesNotMatch(o2, /最近没动的：[^\n]*烦/);

  // 普通事件下面的喜欢的子事件，不出现在它那格的「子事件」里
  const r3 = seed(1, 0);
  const top = r3.s.createEvent(ev({ title: "大事甲", status: "ongoing", importance: 2, why: "" }), "w");
  r3.s.addEntry(en(top.id, { at: T0 - 3600_000, source: ["c:top"] }), "w");
  r3.s.createEvent(ev({ title: "爱的子事", status: "ongoing", importance: 2, why: "", stance: "like", parent: top.id }), "w");
  assert.doesNotMatch(recentSec(render(r3)), /爱的子事/);
});

test("worklist: 笔记、时间轴的副本不算材料；连着聊一整天也按 90 分钟切成小团；疑似重复要标题真的像", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 23, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  const at = (h: number, mi = 0) => Date.UTC(2026, 9, 30, h, mi);
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push({ src: "honcho" as const, ref: `h${i}`, at: at(8) + i * 10 * 60_000, who: "ada", channel: "", text: `第${i}句` });
  rows.push({ src: "note" as const, ref: "n1", at: at(9), who: "我（笔记）", channel: "note", text: "笔记里的一条" });
  m.index.addQuotes(rows);
  const w = m.worklist("2026-10-30");
  assert.match(w, /60 条原话/);
  assert.doesNotMatch(w, /笔记里的一条/);
  const groups = (w.split("## 2.")[0]!.match(/^- \d{2}-\d{2} /gm) ?? []).length;
  assert.ok(groups >= 6, `${groups} 团`);
  m.setImporting(true);
  for (const t of ["ada 找工作", "ada 改简历", "做脸", "做脸（第二版）"]) m.write("mem_event_create", { title: t, summary: "s", gist: "g", importance: 2 });
  m.store.db.prepare("UPDATE mem_event SET updated_at = ?").run(now);
  const dup = m.worklist("2026-10-30").split("## 3.")[1]!.split("## 4.")[0]!;
  assert.match(dup, /做脸/);
  assert.doesNotMatch(dup, /找工作/);
});

test("render: keepOrder 时按给的顺序（相关的先），重要度 5 不插队但也不被砍", () => {
  const { s } = mk();
  const a = s.createEvent(ev({ title: "相关的事", importance: 2, why: "" }), "b");
  const hub = s.createEvent(ev({ title: "核心大事", importance: 5, summary: "很长".repeat(300) }), "b");
  const out = renderEvents([rev(s, a.id), rev(s, hub.id)], { budget: 300, now: T0, tz: "UTC", maxEvents: 8, keepOrder: true });
  assert.ok(out.indexOf("相关的事") < out.indexOf("核心大事"), out);
  assert.match(out, /核心大事/);
  assert.ok(out.length <= 300);
});

test("associate: 「可以」「OK」「好的」「哈哈哈哈」「咋样了」这种短句不联想大事件，也不翻出同样的短句", async () => {
  const { r, ix } = await world();
  ix.addQuotes(["可以", "OK", "好的", "哈哈哈哈", "咋样了"].map((t, i) => ({ src: "central" as const, ref: `s${i}`, at: T0 - DAY, who: "ada", channel: "", text: t })));
  for (const cue of ["可以", "OK", "好的！", "哈哈哈哈哈", "咋样了", "嗯嗯", "👍"]) {
    assert.equal((await r.associate(cue)).text, "", cue);
  }
});

test("associate: 访客说短句时只附他的近况，不附别的事；没内容的（好的）什么都不附", async () => {
  const { r, ids } = await world();
  const out = await r.associate("晚上吃什么", { speaker: "小贝" });
  assert.match(out.text, new RegExp(ids.ask));
  assert.doesNotMatch(out.text, new RegExp(ids.video));
  assert.equal((await r.associate("好的", { speaker: "小贝" })).text, "");
});

test("associate: 原话和这句话一模一样（就是这句自己）的不翻出来", async () => {
  const { r, ix } = await world();
  ix.addQuotes([{ src: "central", ref: "echo", at: T0 - 60_000, who: "ada", channel: "", text: "前面的铺垫有点冗长，第一条B站视频" }]);
  const out = await r.associate("前面的铺垫有点冗长，第一条B站视频");
  assert.doesNotMatch(out.text, /原话.*前面的铺垫有点冗长/);
});

test("associate: 话里点名问到某个人（不是说话的人），先附那个人的近况，不被大事件挤掉", async () => {
  const { r, s, ids } = await world();
  for (let i = 0; i < 6; i++) s.createEvent(ev({ title: `大事${i}`, importance: 5, why: "要紧", summary: "小贝和ada都在的一件大事".repeat(20), entities: [{ name: "小贝", kind: "person", role: "with" }, { name: "ada", kind: "person", role: "with" }] }), "w");
  const out = await r.associate("小贝最近在忙什么", { speaker: "ada" });
  assert.match(out.text, new RegExp(ids.ask));
  assert.ok(out.text.length <= 600);
});

test("associate: 这次已经给过的事，访客近况里也不再给；原话文字一样的只翻一条", async () => {
  const { r, ix, ids } = await world();
  const first = await r.associate("晚上吃什么", { speaker: "小贝" });
  assert.match(first.text, new RegExp(ids.ask));
  const again = await r.associate("晚上吃什么", { speaker: "小贝", exclude: new Set(first.events) });
  assert.doesNotMatch(again.text, new RegExp(`${ids.ask}（`));
  ix.addQuotes([1, 2].map((i) => ({ src: "central" as const, ref: `dup${i}`, at: T0 - i * DAY, who: "我", channel: "note", text: "斩斧配装要看终盘的属性表" })));
  const d = await r.cluster("斩斧配装的属性表");
  assert.equal(d.split("斩斧配装要看终盘的属性表").length - 1, 1, d);
});

test("associate: 线索转向量最多等 1.5 秒（新联想不再陪旧的 Honcho 一起等，0.8 秒太紧会退成只有全文）", async () => {
  const seen: Array<number | undefined> = [];
  const base = fakeEmbedder();
  const spy: Embedder = { ...base, embed: (texts, o) => { seen.push(o?.timeoutMs); return base.embed(texts, o); } };
  const { s, ix } = idx(spy);
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  await r.associate("第一条B站视频怎么发出去的");
  assert.deepEqual(seen, [1500]);
});

// ---------- 10-31 修小问题（M1–M11） ----------

test("store: merge 不能把保留的那件也写进 others（自己并进自己）", () => {
  const { s } = mk();
  const a = s.createEvent(ev(), "b1");
  assert.throws(() => s.merge(a.id, [a.id], "手滑", "b2"), /自己/);
  assert.equal(s.event(a.id)!.status, "done");
  assert.equal(s.event(a.id)!.superseded_by, null);
});

test("store: stance——建喜欢的事、改成烦、清掉；merge 不同 stance 拒绝；split 继承；撤回整批恢复", () => {
  const { s } = mk();
  const a = s.createEvent(ev({ stance: "like" }), "b1");
  assert.equal(s.event(a.id)!.stance, "like");
  assert.equal(s.createEvent(ev({ title: "普通" }), "b1").stance, null);
  assert.equal(s.updateEvent(a.id, { stance: "dislike" }, "", "b1").stance, "dislike");
  assert.equal(s.updateEvent(a.id, { stance: "" }, "", "b1").stance, null);
  assert.throws(() => s.updateEvent(a.id, { stance: "love" }, "", "b1"));
  assert.throws(() => s.updateEvent(a.id, { foo: 1 }, "", "b1"), /stance/);
  // merge：stance 不同拒绝，相同能并
  const plain = s.createEvent(ev({ title: "平常" }), "b1");
  const l1 = s.createEvent(ev({ title: "爱一", stance: "like" }), "b1");
  const l2 = s.createEvent(ev({ title: "爱二", stance: "like" }), "b1");
  assert.throws(() => s.merge(plain.id, [l1.id], "", "b2"), /喜欢 \/ 烦的事只能和同样的并/);
  s.merge(l1.id, [l2.id], "", "b2");
  assert.equal(s.event(l2.id)!.superseded_by, l1.id);
  // split：继承，写了就用写的
  const n1 = s.addEntry(en(l1.id, { source: ["c:1"] }), "b3").entry;
  const n2 = s.addEntry(en(l1.id, { source: ["c:2"], at: T0 - 2 * DAY }), "b3").entry;
  const inh = s.split(l1.id, [n1.id], { ...ev({ title: "拆一" }) }, "b3");
  assert.equal(inh.stance, "like");
  const own = s.split(l1.id, [n2.id], { ...ev({ title: "拆二", stance: "dislike" }) }, "b3");
  assert.equal(own.stance, "dislike");
  // 撤回整批
  const c = s.createEvent(ev({ title: "撤回用", stance: "like" }), "seed");
  s.openBatch("b4");
  s.updateEvent(c.id, { stance: "dislike" }, "", "b4");
  assert.equal(s.event(c.id)!.stance, "dislike");
  assert.deepEqual(s.revertBatch("b4").conflicts, []);
  assert.equal(s.event(c.id)!.stance, "like");
});

test("store: 撤回后留档——写过什么、撤回时哪些冲突都还查得到；同名批次重开是干净的", () => {
  const { s } = mk();
  const a = s.createEvent(ev(), "seed");
  s.openBatch("night/x");
  s.createEvent(ev({ title: "夜里写的" }), "night/x");
  s.updateEvent(a.id, { summary: "夜里改的" }, "有进展", "night/x");
  s.updateEvent(a.id, { summary: "白天又改了" }, "", "other");
  const r = s.revertBatch("night/x");
  assert.equal(r.conflicts.length, 1);
  assert.equal(s.batchState("night/x"), "reverted");
  assert.deepEqual(s.ops("night/x"), [], "批次名空出来，重开同一天不会撤到上一跑的");
  const archived = s.batches().find((b) => b.batch.startsWith("night/x~reverted"));
  assert.ok(archived, "撤回的那一批留档");
  assert.equal(archived!.state, "reverted");
  const ops = s.ops(archived!.batch);
  assert.ok(ops.some((o) => o.op === "event_create"));
  assert.ok(ops.some((o) => o.op === "revert_conflict" && /之后又被改过/.test(o.reason)));
  assert.throws(() => s.revertBatch(archived!.batch), /撤回过/);
});

test("store: 人的别名改了，带这个人的事件重建索引（用新别名也搜得到）", async () => {
  const { s, ix } = idx(null);
  s.createEvent(ev({ title: "拿电脑打字", entities: [{ name: "砚", kind: "person", role: "with" }] }), "b");
  assert.ok(!(await ix.search("Tavo")).some((h) => h.ref === "e0001"));
  s.upsertEntity({ name: "砚", kind: "person", aliases: ["Tavo"] }, "b");
  assert.ok((await ix.search("Tavo")).some((h) => h.ref === "e0001"));
});

test("memory: mem_day_done 只收真实的日期 YYYY-MM-DD", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginNight("night:t/2026-10-29");
  for (const bad of ["10-29", "2026-13-01", "2026-02-30", "昨天", ""]) assert.throws(() => m.write("mem_day_done", { day: bad }, "hippocampus"), /日期/, bad);
  assert.match(m.write("mem_day_done", { day: "2026-10-29" }, "hippocampus"), /2026-10-29/);
});

test("event(ref): 标题有好几个候选时，最像的排前面（不是最新的）", () => {
  const { db, s } = mk();
  const r = new EventRecall({ store: s, index: new MemIndex(db, null, () => T0), now: () => T0, tz: "UTC" });
  const a = s.createEvent(ev({ title: "形象和表情包" }), "b");
  s.addEntry(en(a.id, { at: T0 - 10 * DAY }), "b");
  const b = s.createEvent(ev({ title: "给自己做会动的形象" }), "b");
  s.addEntry(en(b.id, { at: T0 - DAY, source: ["c:2"] }), "b");
  const out = r.event("形象");
  assert.match(out, /你说的可能是/);
  assert.ok(out.indexOf(a.id) < out.indexOf(b.id), out);
  assert.match(out, new RegExp(`recall_event ${a.id}`));
});

test("cluster: 沾边的事超过一次能列的，末尾说还有几件（不悄悄丢掉）", async () => {
  const { s, ix } = idx(null);
  for (let i = 0; i < 14; i++) {
    const e = s.createEvent(ev({ title: `配音第${i}版`, summary: `配音第${i}版的总结`, gist: `配音第${i}版`, importance: 2, why: "" }), "b");
    s.addEntry(en(e.id, { at: T0 - DAY - i * 60_000, full: `配音第${i}版录好了`, gist: `第${i}版录好`, title: "录好", source: [`c:${i}`] }), "b");
  }
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  const out = await r.cluster("配音", { budget: 4000 });
  const shown = (out.match(/^· /gm) ?? []).length;
  const more = Number(/还有 (\d+) 件/.exec(out)?.[1] ?? 0);
  assert.equal(shown + more, 14, out);
});

test("remember: who 写了不认识的人，说一声（按没限定人想）", async () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.store.createEvent(ev({ title: "做脸" }), "b");
  const out = await m.remember("做脸", { who: "路人甲" });
  assert.match(out, /不认识「路人甲」/);
  assert.match(out, /e0001/);
});

test("index: 事件改了内容，旧向量马上不用；别的进程补的向量这边也认", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: fakeEmbedder(), now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "家里的猫咪", summary: "楼下来了一只猫", gist: "楼下的猫" }), "b");
  await m.index.backfillVectors(10);
  assert.equal((await m.index.vector("喵", 5))?.[0]?.ref, e.id);
  m.store.updateEvent(e.id, { title: "做脸", summary: "照官方分层重做", gist: "重做脸" }, "改", "b");
  assert.ok(!(await m.index.vector("喵", 5))!.some((h) => h.ref === e.id), "改了内容，旧向量不再算");
  const other = new MemIndex(db, fakeEmbedder(), () => T0);   // 另一个进程（命令行脚本）
  const e2 = m.store.createEvent(ev({ title: "小猫打架", summary: "两只猫打起来了", gist: "猫打架" }), "b");
  await other.backfillVectors(10);
  assert.equal(m.index.missingVectors(), 0);
  await m.index.backfillVectors(10);
  assert.ok((await m.index.vector("喵", 5))!.some((h) => h.ref === e2.id), "别处补的向量也认");
});

test("midterm: 最近在发生的事按最近有进展排，老一点的核心记忆不挤在最前面", () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const old = m.store.createEvent(ev({ title: "为什么造我", importance: 5, why: "核心" }), "b");
  m.store.addEntry(en(old.id, { at: T0 - 12 * DAY }), "b");
  const fresh = m.store.createEvent(ev({ title: "新视频", importance: 3, why: "", status: "ongoing" }), "b");
  m.store.addEntry(en(fresh.id, { at: T0 - DAY, source: ["c:2"] }), "b");
  const out = renderMidterm(m.recall, { now: T0, tz: "UTC" });
  assert.ok(out.indexOf("新视频") >= 0 && out.indexOf("新视频") < out.indexOf("为什么造我"), out);
});

test("memory: 名单里的人同步进事件库——别名、person_key；registry 的 key 只当 person_key 不当别名；没变化就不写", async () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "拿电脑打字", importance: 2, why: "", status: "ongoing", entities: [{ name: "砚", kind: "person", role: "with" }] }), "b");
  m.store.addEntry(en(e.id, { at: T0 - DAY, people: ["砚"], full: "砚拿 ada 的电脑打字", gist: "砚拿电脑打字", title: "打字" }), "b");
  const reg = { _说明: "x", gua: { name: "砚", aliases: ["头号对手", "Tavo", "tavo"] }, xiaobei: { name: "小贝", aliases: ["表姐", "Vorn"] } };
  assert.deepEqual(m.syncPeople(reg).sort(), ["砚", "小贝"].sort());
  assert.equal(m.store.entity("Tavo")?.name, "砚");
  assert.equal(m.store.entity("gua")?.name, "砚", "按 person_key 也找得到");
  assert.ok(!m.store.entity("砚")!.aliases.some((a) => a.toLowerCase() === "gua"), "两个字母的 key 不当别名（会误认）");
  assert.equal(m.store.entity("Vorn")?.person_key, "xiaobei");
  const n = m.store.batches().length;
  assert.deepEqual(m.syncPeople(reg), []);
  assert.equal(m.store.batches().length, n, "第二次没变化，不写");
  assert.match((await m.recall.associate("Tavo 最近怎么样", { speaker: "ada" })).text, new RegExp(e.id), "用别名点名也先附他的近况");
});

import { logAssociation, assocStats } from "../src/memory/events/assoc.ts";

test("assoc: 每次附给她的联想记一行；统计她接住了多少（之后一小时内展开或引用了那件事）", () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const a = m.store.createEvent(ev({ title: "做脸" }), "b");
  const b = m.store.createEvent(ev({ title: "拍星星" }), "b");
  const dir = tmpDir("assoc-");
  logAssociation(dir, { at: T0 - 3 * 3600_000, region: "main", speaker: "ada", cue: "还记得做脸吗", events: [a.id], chars: 200, ms: 120 }, "UTC");
  logAssociation(dir, { at: T0 - 2 * 3600_000, region: "main", speaker: "ada", cue: "星星", events: [b.id], chars: 150, ms: 300 }, "UTC");
  logAssociation(dir, { at: T0 - 3600_000, region: "main", speaker: "小贝", cue: "好的", events: [], chars: 0, ms: 2 }, "UTC");
  m.store.touch(a.id, "open", "main", T0 - 3 * 3600_000 + 5 * 60_000);    // 5 分钟后展开了
  m.store.touch(b.id, "open", "main", T0 - 2 * 3600_000 - 60_000);        // 联想之前碰的不算
  const s = assocStats(db, dir, { now: T0, days: 7 });
  assert.equal(s.associations, 3);
  assert.equal(s.empty, 1);
  assert.equal(s.eventsGiven, 2);
  assert.equal(s.eventsAdopted, 1);
  assert.equal(s.maxMs, 300);
});

import { MemChores } from "../src/memory/events/chores.ts";

test("chores: 补算向量在后台跑，OpenAI 卡住也不拖住定时检查；同一时间只跑一个；等的时候内容又改了就不写旧向量", async () => {
  let release: (() => void) | null = null;
  let calls = 0;
  const slow: Embedder = {
    async embed(texts, o) {
      calls += 1;
      await new Promise<void>((r) => { release = r; });
      return fakeEmbedder().embed(texts, o);
    },
  };
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: slow, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "家里的猫咪", summary: "楼下来了一只猫", gist: "楼下的猫" }), "b");
  const dir = tmpDir("chores-");
  const c = new MemChores({ mem: m, exportsDir: dir, tz: "UTC", now: () => T0, asleep: () => false, log: () => {} });
  const t = Date.now();
  c.tick();
  c.tick();
  assert.ok(Date.now() - t < 10_000, "不等向量（向量那头永远不回，等了就会卡死；墙钟界只防卡死，机器忙时会慢）");
  assert.equal(calls, 1, "上一轮还没完，不再开一轮");
  m.store.updateEvent(e.id, { summary: "改成了别的内容" }, "改", "b");
  release!();
  await c.idle();
  assert.equal(m.index.missingVectors(), 1, "等的时候改过的那条不写旧向量，下一轮重算");
});

test("chores: 导出时写 vectors.json（还差多少条向量、最后一次出错、暂停到什么时候），给控制台看", () => {
  const db = openDb(":memory:");
  const failing: Embedder = { embed: async () => null, status: () => ({ lastError: "HTTP 429 insufficient_quota", lastErrorAt: T0 - 60_000, lastOkAt: null, pausedUntil: T0 + 540_000 }) };
  const m = new EventMemory({ db, embedder: failing, now: () => T0, tz: "UTC" });
  m.store.createEvent(ev({ title: "家里的猫咪" }), "b");
  const dir = tmpDir("chores-v-");
  new MemChores({ mem: m, exportsDir: dir, tz: "UTC", now: () => T0, asleep: () => true, log: () => {} }).tick();
  const v = JSON.parse(readFileSync(join(dir, "vectors.json"), "utf8")) as Record<string, unknown>;
  assert.equal(v.missing, 1);
  assert.equal(v.lastError, "HTTP 429 insufficient_quota");
  assert.equal(v.lastErrorAt, T0 - 60_000);
  assert.equal(v.pausedUntil, T0 + 540_000);
});

test("index: 改了内容重算的向量回到内存里（SQLite 删掉最大 rowid 后会复用同一个 rowid）", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: fakeEmbedder(), now: () => T0, tz: "UTC" });
  m.store.createEvent(ev({ title: "做脸", summary: "照官方分层重做", gist: "重做脸" }), "b");
  const e2 = m.store.createEvent(ev({ title: "小猫打架", summary: "两只猫打起来了", gist: "猫打架" }), "b");
  await m.index.backfillVectors(10);
  m.store.updateEvent(e2.id, { summary: "两只猫又打起来了，一只是楼下的" }, "补", "b");
  await m.index.backfillVectors(10);
  assert.equal(m.index.missingVectors(), 0);
  assert.ok((await m.index.vector("喵", 5))!.some((h) => h.ref === e2.id), "重算以后还能按意思找到");
});

// ---------- 10-31 事件库成为唯一的事件记录 ----------

test("store: 事件可以带「下次的日子」（考试、截止、约好的那天），能改、能清掉", () => {
  const { s } = mk();
  const e = s.createEvent(ev({ title: "爸妈签证", next: "2026-11-25" }), "b");
  assert.equal(new Date(s.event(e.id)!.next_at!).toISOString().slice(0, 10), "2026-11-24", "按她的时区（枫湾）那天的零点");
  s.updateEvent(e.id, { next: "2026-12-01" }, "改期", "b");
  assert.equal(new Date(s.event(e.id)!.next_at! + 11 * 3600_000).toISOString().slice(0, 10), "2026-12-01");
  s.updateEvent(e.id, { next: "" }, "办完了", "b");
  assert.equal(s.event(e.id)!.next_at, null);
});

test("midterm: 有日子的事单列一节（按日子排，过了的不列），很久没进展的也在", () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const visa = m.store.createEvent(ev({ title: "爸妈签证", gist: "等签证结果", importance: 3, why: "", status: "ongoing", next: "2026-11-25" }), "b");
  m.store.addEntry(en(visa.id, { at: T0 - 40 * DAY }), "b");
  const exam = m.store.createEvent(ev({ title: "PTE 考试", gist: "考 PTE", importance: 3, why: "", status: "ongoing", next: "2026-11-03" }), "b");
  m.store.addEntry(en(exam.id, { at: T0 - 30 * DAY, source: ["c:2"] }), "b");
  const past = m.store.createEvent(ev({ title: "过期的约", importance: 2, why: "", status: "ongoing", next: "2026-10-20" }), "b");
  m.store.addEntry(en(past.id, { at: T0 - 20 * DAY, source: ["c:3"] }), "b");
  const out = renderMidterm(m.recall, { now: T0, tz: "UTC" });
  assert.match(out, /## 有日子的事/);
  const sec = out.split("## 有日子的事")[1]!.split("\n## ")[0]!;
  assert.ok(sec.indexOf(exam.id) >= 0 && sec.indexOf(exam.id) < sec.indexOf(visa.id), sec);
  assert.match(sec, /11-03/);
  assert.doesNotMatch(sec, new RegExp(past.id));
});

test("worklist: 列出今天滑出中期视图的事（最后一次进展正好 14 天前），夜里给它们在周记里留一句", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  const out1 = m.store.createEvent({ title: "选耳机", summary: "s", gist: "买了耳机", importance: 2, status: "done" }, "seed");
  m.store.addEntry({ event: out1.id, at: Date.UTC(2026, 9, 16, 12, 0), full: "买到耳机了", gist: "买到了", title: "买到", source: ["c:1"] }, "seed");
  const still = m.store.createEvent({ title: "做脸", summary: "s", gist: "做脸", importance: 3 }, "seed");
  m.store.addEntry({ event: still.id, at: Date.UTC(2026, 9, 20, 12, 0), full: "重做了脸", gist: "重做", title: "重做", source: ["c:2"] }, "seed");
  const w = m.worklist("2026-10-30");
  assert.match(w, /今天滑出中期视图的事/);
  const sec = w.split("今天滑出中期视图的事")[1]!.split("\n## ")[0]!;
  assert.match(sec, new RegExp(out1.id));
  assert.doesNotMatch(sec, new RegExp(still.id));
});

test("midterm: 有日子的事在那一天整天都列着（她的一天到第二天 04:00），过了才不列", () => {
  const tz = "Australia/Melbourne";
  const db = openDb(":memory:");
  let now = Date.parse("2026-10-30T09:00:00Z");   // 枫湾 10-30 20:00
  const m = new EventMemory({ db, embedder: null, now: () => now, tz });
  const e = m.store.createEvent({ title: "脑洞学生会补番", summary: "s", gist: "补番", importance: 3, next: "2026-10-31" }, "b");
  const has = () => (renderMidterm(m.recall, { now, tz }).split("## 有日子的事")[1]?.split("\n## ")[0] ?? "").includes(e.id);
  assert.ok(has(), "前一天");
  now = Date.parse("2026-10-30T22:00:00Z");   // 枫湾 10-31 09:00
  assert.ok(has(), "当天上午");
  now = Date.parse("2026-10-31T15:00:00Z");   // 枫湾 11-01 02:00（还算 10-31 那天）
  assert.ok(has(), "当天夜里");
  now = Date.parse("2026-10-31T18:00:00Z");   // 枫湾 11-01 05:00
  assert.ok(!has(), "过了那一天");
});

test("store: 撤回 10-31 以前写的批次（记录里还没有 next_at 这一列）不会全成冲突", () => {
  const { s, db } = mk();
  const e = s.createEvent(ev({ title: "老批次写的" }), "old");
  for (const r of db.prepare("SELECT id, after FROM mem_op WHERE batch = 'old' AND tbl = 'mem_event'").all() as Array<{ id: number; after: string }>) {
    const a = JSON.parse(r.after) as Record<string, unknown>;
    delete a.next_at;
    db.prepare("UPDATE mem_op SET after = ? WHERE id = ?").run(JSON.stringify(a), r.id);
  }
  const res = s.revertBatch("old");
  assert.deepEqual(res.conflicts, []);
  assert.equal(s.event(e.id), undefined);
});

test("render: 已经过去的「下次」日子不再写在事件头上", () => {
  const { s } = mk();
  const past = s.createEvent(ev({ title: "过期的约", next: "2026-10-20" }), "b");
  const soon = s.createEvent(ev({ title: "快到的约", next: "2026-11-25" }), "b");
  const out = renderEvents([rev(s, past.id), rev(s, soon.id)], { budget: 2000, now: T0, tz: "Australia/Melbourne", maxEvents: 8 });
  assert.match(out, /快到的约[^\n]*下次 11-25/);
  assert.doesNotMatch(out, /过期的约[^\n]*下次/);
});

// ---------- 10-31 并行大脑的记忆侧配合（和 sess-ed 对过） ----------

test("quote: 感官原文标了 inner（只存档、不同步给主意识）也照样抄进原话层，记成「感官」；别的 inner 照旧不抄", () => {
  const { db, ix } = idx(null);
  const c = new CentralMemory(db, () => T0);
  c.append(1, "外界", "input", "[感官] 有新动静：\n- [bili id=b86a] 芊姐评论：这期好看", { from: "感官", channel: "senses", inner: true });
  c.append(1, "perception-messages", "think", "下意识在想", { inner: true });
  c.append(1, "perception-messages", "note", "芊姐评论说这期好看，看一眼就过了（#1）");
  assert.equal(ix.ingestCentral(), 2);
  const rows = db.prepare("SELECT who, text FROM mem_quote ORDER BY id").all() as Array<{ who: string; text: string }>;
  assert.deepEqual(rows.map((r) => r.who), ["感官", "我"]);
});

test("associate: 感官原文不进联想（太吵），她自己回想时照样翻得到", async () => {
  const { s, ix } = idx(null);
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  ix.addQuotes([{ src: "central", ref: "1", at: T0 - 3600_000, who: "感官", channel: "senses", text: "[感官] 芊姐评论：祥子那期剪得真好" }]);
  assert.doesNotMatch((await r.associate("祥子那期剪得真好")).text, /芊姐评论/);
  assert.match(await r.cluster("祥子那期剪得真好"), /芊姐评论/);
});

test("memory: 出处写 #N（压缩块、折叠行里的编号）就记成 c:N；recall_event 也能翻 #N", () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const c = new CentralMemory(db, () => T0);
  const seq = c.append(1, "外界", "input", "ada：今晚做脸", { from: "ada", human: true }).seq;
  m.index.ingestCentral();
  m.beginNight("night:t/2026-10-29");
  const e = m.store.createEvent({ title: "做脸", summary: "s", gist: "g", importance: 2 }, "seed");
  m.write("mem_entries_add", { event: e.id, entries: [{ at: "2026-10-29 20:00", full: "ada 说今晚做脸", gist: "今晚做脸", title: "做脸", kind: "said", source: [`#${seq}`] }] }, "hippocampus");
  assert.deepEqual(JSON.parse(m.store.entries(e.id)[0]!.source), [`c:${seq}`]);
  const out = m.recallEvent(`#${seq}`);
  assert.match(out, /今晚做脸/);
  assert.match(out, new RegExp(`记在：${e.id}`));
  assert.match(m.recallEvent("#999999"), /没有/);
});


test("memtools: 潜意识（deep）展开一件事不算碰过（不让它变清楚、变热）；主意识展开照算", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "做脸" }), "seed");
  const how = () => (db.prepare("SELECT how FROM mem_touch WHERE ref = ? ORDER BY rowid DESC LIMIT 1").get(e.id) as { how: string }).how;
  const tool = (region: string) => memTools(m, region, ["recall_event"]).find((t) => t.name === "recall_event")!;
  await tool("deep").handler({ ref: e.id });
  assert.equal(how(), "recall");
  await tool("main").handler({ ref: e.id });
  assert.equal(how(), "open");
});

// ---------- 11-01 联想以事件为主（主人：事件在人脑里远比一句话要紧，大部分话是记不得的） ----------

test("associate: 联想给的是事件里对得上的片段，带事件名；这件事别的经过、关联不跟着列", async () => {
  const { r, ids } = await world();
  const out = await r.associate("他替我点了发布那天");
  assert.match(out.text, new RegExp(`${ids.video}（`));
  assert.match(out.text, /他替我点了发布/);
  assert.doesNotMatch(out.text, /放弃久留美改做自我介绍|帮我扫码/, out.text);
  assert.doesNotMatch(out.text, /关联：/);
  assert.ok(out.entries.length >= 1);
});

test("associate: 一大堆像这句话的原话也挤不掉对得上的片段（事件和片段单独搜，不跟原话抢名额）", async () => {
  const { r, ix, ids } = await world();
  ix.addQuotes(Array.from({ length: 80 }, (_, i) => ({ src: "central" as const, ref: `crowd${i}`, at: T0 - 2 * DAY, who: "ada", channel: "", text: `他替我点了发布吗${i}` })));
  await ix.backfillVectors(500);
  const out = await r.associate("他替我点了发布那天");
  assert.match(out.text, new RegExp(`${ids.video}（`), out.text);
  assert.match(out.text, /他替我点了发布/);
  assert.doesNotMatch(out.text, /原话/, "不知道是谁在说话：一句原话都不给");
});

test("associate: 给过的事里别的片段照样能想起来（不再给的是片段，事件名一行带过）", async () => {
  const { r, ids } = await world();
  const first = await r.associate("他坐到桌前帮我扫码的时候");
  assert.match(first.text, /帮我扫码/);
  const given = new Set([...first.events, ...first.entries]);
  const second = await r.associate("他替我点了发布那天", { exclude: given });
  assert.match(second.text, /他替我点了发布/, second.text);
  assert.match(second.text, new RegExp(`${ids.video}（`));
  assert.doesNotMatch(second.text, /帮我扫码/);
  assert.doesNotMatch(second.text, /第一条B站视频一句话/, "给过的事只带标题");
  for (const id of [...second.events, ...second.entries]) given.add(id);
  const third = await r.associate("他坐到桌前帮我扫码的时候", { exclude: given });
  assert.doesNotMatch(third.text, /帮我扫码/);
});

test("associate: 原话只陪着片段出现，最多一句，只给正在跟她说话的人一天以前说的；她自己说的、别人说的、刚说的都不给", async () => {
  const { r, ix, ids } = await world();
  ix.addQuotes([
    { src: "central", ref: "mine", at: T0 - 3 * DAY, who: "我", channel: "", text: "终盘斩斧配装要看属性表才行" },
    { src: "central", ref: "his", at: T0 - 3 * DAY, who: "ada", channel: "", text: "终盘斩斧配装记得看属性表" },
    { src: "central", ref: "hers", at: T0 - 3 * DAY, who: "小贝", channel: "", text: "终盘斩斧配装要看属性表吗" },
    { src: "central", ref: "fresh", at: T0 - 2 * 3600_000, who: "ada", channel: "", text: "终盘斩斧配装看属性表呀" },
  ]);
  await ix.backfillVectors(500);
  const out = await r.associate("终盘斩斧配装要看属性表", { speaker: "ada" });
  assert.match(out.text, new RegExp(`${ids.axe}（`), out.text);
  assert.equal((out.text.match(/原话/g) ?? []).length, 1, out.text);
  assert.match(out.text, /记得看属性表/);
  assert.doesNotMatch(out.text, /才行|属性表吗|属性表呀/);
  const anon = await r.associate("终盘斩斧配装要看属性表");
  assert.doesNotMatch(anon.text, /原话/);
});

test("associate: 附说话的人当时那句原话时，她紧接着回他的那句也带上（她 11-02：要是能顺手把我自己当时怎么说的也带出来就好了）", async () => {
  const { r, ix, ids } = await world();
  const at = T0 - 3 * DAY;
  ix.addQuotes([
    { src: "central", ref: "his", at, who: "ada", channel: "", text: "终盘斩斧配装记得看属性表" },
    { src: "central", ref: "ok", at: at + 60_000, who: "我→ada", channel: "", text: "好的" },
    { src: "central", ref: "toher", at: at + 2 * 60_000, who: "我→小贝", channel: "", text: "给小贝的另一句话" },
    { src: "central", ref: "reply", at: at + 3 * 60_000, who: "我→ada", channel: "", text: "嗯，我配装前先翻一遍属性表" },
    { src: "central", ref: "later", at: at + 2 * 3600_000, who: "我→ada", channel: "", text: "两个小时后聊的别的事" },
  ]);
  await ix.backfillVectors(500);
  const out = await r.associate("终盘斩斧配装要看属性表", { speaker: "ada" });
  assert.match(out.text, new RegExp(`${ids.axe}（`), out.text);
  assert.equal((out.text.match(/原话/g) ?? []).length, 2, out.text);
  const his = out.text.indexOf("记得看属性表");
  const mine = out.text.indexOf("配装前先翻一遍属性表");
  assert.ok(his >= 0 && mine > his, out.text);
  assert.doesNotMatch(out.text, /另一句话|两个小时后|「好的」/);
  const refs = out.entries.map((e) => ix.quote(e)?.ref).filter(Boolean);
  assert.ok(refs.includes("his") && refs.includes("reply"), "两句都记成给过");
});

test("associate: 这句话自己一件事都对不上时，带上她刚跟这个人说的最后一句再找一次；对得上、或者是「好的」这种短句时不用", async () => {
  const { r, ids } = await world();
  const vague = "这几个都不够好，你再找找更现代的";
  assert.equal((await r.associate(vague)).text, "", "单看这句对不上任何事");
  const out = await r.associate(vague, { context: "我照官方分层重做脸，先拿官方的样板对比" });
  assert.match(out.text, new RegExp(`${ids.face}（`), out.text);
  const own = await r.associate("他坐到桌前帮我扫码的时候", { context: "我照官方分层重做脸，先拿官方的样板对比" });
  assert.match(own.text, new RegExp(`${ids.video}（`));
  assert.doesNotMatch(own.text, new RegExp(`${ids.face}（`), "这句话自己对得上，就不掺她说的");
  assert.equal((await r.associate("好的", { context: "我照官方分层重做脸，先拿官方的样板对比" })).text, "");
});

test("associate: 什么事都没对上就什么都不给，不拿原话凑数（哪怕是说话的人自己以前说的）", async () => {
  const { r, ix } = await world();
  ix.addQuotes([{ src: "central", ref: "sky", at: T0 - 3 * DAY, who: "ada", channel: "", text: "今天的晚霞特别好看呀" }]);
  await ix.backfillVectors(500);
  assert.equal((await r.associate("今天的晚霞好看吗", { speaker: "ada" })).text, "");
});

test("associate: 只是碰巧有个一样的词（「嗯嗯」）、意思不沾边的片段不算想起来；没有向量时才只认词", async () => {
  const { r, s, ix } = await world();
  const e = s.createEvent(ev({ title: "评论区", summary: "B站评论区的规矩", gist: "评论的规矩" }), "w");
  s.addEntry(en(e.id, { at: T0 - DAY, full: "嗯嗯，评论除了观点也给鼓励和建议，下午混着看，挑新发的、涨得快的、标题有意思的", gist: "评论多给鼓励建议", title: "评论给鼓励" }), "w");
  await ix.backfillVectors(500);
  assert.doesNotMatch((await r.associate("嗯嗯，干嘛我不能心疼吗")).text, /鼓励/);
});

test("associate: 片段写大意（人记得的是大意），原样细节留给展开", async () => {
  const { r, s, ix } = await world();
  const e = s.createEvent(ev({ title: "看我的B站", summary: "他要看我的B站主页", gist: "给他看了主页", importance: 4, why: "要紧" }), "w");
  s.addEntry(en(e.id, { at: T0 - DAY, full: "09:01–09:07 ada（WhatsApp原话）「能不能打开你的chrome，我看看你的b站」，我在自己的浏览器里开了主页，他看完回「好」（对账补记，原话 hh 09:01）", gist: "他要看我的B站，我开了主页给他看", title: "开主页给他看" }), "w");
  await ix.backfillVectors(500);
  const out = await r.associate("你打开你的b站主页给我看看");
  assert.match(out.text, /他要看我的B站，我开了主页给他看/, out.text);
  assert.doesNotMatch(out.text, /对账补记/);
});

test("associate: 只剩 WhatsApp 信封头的消息（只发了图）不联想，信封头那种原话也不翻", async () => {
  const { r, s, ix } = await world();
  const bare = "[WhatsApp +6155500009 +20s Sat 2026-10-31 13:16:09 GMT+11] +6155500009: ";
  const e = s.createEvent(ev({ title: "WhatsApp 权限", summary: "谁能加我 WhatsApp", gist: "WhatsApp 权限" }), "w");
  s.addEntry(en(e.id, { at: T0 - DAY, full: "[WhatsApp +6155500009] ada 准砚加 WhatsApp +6155500009 Sat GMT+11，只给普通聊天权限", gist: "WhatsApp +6155500009 Sat GMT+11 准砚加", title: "准砚加" }), "w");
  ix.addQuotes([{ src: "central", ref: "env", at: T0 - 3 * DAY, who: "小贝", channel: "whatsapp", text: bare }]);
  await ix.backfillVectors(500);
  const guest = await r.associate(bare, { speaker: "小贝" });
  assert.doesNotMatch(guest.text, /原话|准砚加/, "访客照附近况，但不拿信封头去联想");
  assert.equal((await r.associate("[WhatsApp +6155500009 Sat 2026-10-31 13:16:38 GMT+11] +6155500009: ")).text, "");
});

test("associate: 片段多、写得长时，加上「想起来的」那行也不超 600 字，不把最后一行切半", async () => {
  const { r, s, ix } = await world();
  for (let i = 0; i < 3; i++) {
    const e = s.createEvent(ev({ title: `配音第${i}版`, summary: "配音".repeat(80), gist: `配音第${i}版换了声音`.repeat(4), importance: 4, why: "要紧" }), "w");
    for (let j = 0; j < 2; j++) s.addEntry(en(e.id, { at: T0 - (j + 1) * DAY, full: "配音".repeat(60), gist: `配音换声音带情绪第${j}次`.repeat(5), title: `配音换声音${i}${j}` }), "w");
  }
  await ix.backfillVectors(500);
  const out = await r.associate("配音换声音带情绪");
  assert.ok(out.entries.length >= 2, out.text);
  assert.ok(out.text.length <= 600, String(out.text.length));
  assert.ok(!out.text.endsWith("…"), out.text.slice(-80));
});

test("associate: 被更正过的片段给过一次就不再给（原条目和更正都算给过）", async () => {
  const { r, s, ids } = await world();
  const n = s.entries(ids.video).find((x) => x.gist.startsWith("他替我点了发布"))!;
  s.correctEntry(n.id, { full: "其实是他替我点了发布、我自己按的确认", gist: "他替我点了发布，我按的确认", title: "点发布（更正）", why: "核了原话" }, "fix");
  const first = await r.associate("他替我点了发布那天");
  assert.match(first.text, /后来更正为/, first.text);
  const again = await r.associate("他替我点了发布那天", { exclude: new Set([...first.events, ...first.entries]) });
  assert.doesNotMatch(again.text, /后来更正为|他替我点了发布/, again.text);
});

test("associate: 访客的近况一个前缀只附一次；没内容的话（表情、好的好的）不附（11-01 小贝 8 条表情翻出 24 件旧事）", async () => {
  const { r, s, ids } = await world();
  for (let i = 0; i < 6; i++) s.createEvent(ev({ title: `小贝的旧事${i}`, importance: 3, why: "", entities: [{ name: "小贝", kind: "person", role: "with" }] }), "w");
  assert.equal((await r.associate("🥹", { speaker: "小贝" })).text, "", "只发了表情：什么都不附");
  assert.equal((await r.associate("好的好的", { speaker: "小贝" })).text, "");
  const given = new Set<string>();
  const first = await r.associate("准备玩游戏", { speaker: "小贝", exclude: given });
  assert.match(first.text, /和小贝有关的最近几件事/, first.text);
  for (const id of [...first.events, ...first.entries]) given.add(id);
  const second = await r.associate("在玩hades", { speaker: "小贝", exclude: given });
  assert.doesNotMatch(second.text, /和小贝有关的最近几件事/, "这个前缀已经附过：不换下一批旧事");
  assert.ok(!second.events.some((id) => id.startsWith("e") && !first.events.includes(id) && s.peopleOf(id).includes("小贝") && !/hades/i.test(s.event(id)!.title)), JSON.stringify(second.events));
  // 换了前缀（给过的清空）：再附一次
  assert.match((await r.associate("在玩hades", { speaker: "小贝", exclude: new Set() })).text, /和小贝有关的最近几件事/);
  // 别人的话里想起过一件有小贝的事（没附过她的近况）：她来说话时照样附
  assert.match((await r.associate("晚上吃什么", { speaker: "小贝", exclude: new Set([ids.ask]) })).text, /和小贝有关的最近几件事/);
});

test("associate: 不算数了的事（retired）不再自己冒出来——片段和访客近况里都没有；她主动翻还能翻到", async () => {
  const { r, s, ids } = await world();
  s.retire(ids.video, "记错了", "fix");
  s.retire(ids.ask, "记错了", "fix");
  const out = await r.associate("他替我点了发布");
  assert.doesNotMatch(out.text, new RegExp(ids.video), out.text);
  const guest = await r.associate("晚上吃什么", { speaker: "小贝" });
  assert.doesNotMatch(guest.text, new RegExp(ids.ask), guest.text);
  assert.match(r.person("小贝"), new RegExp(ids.ask), "主动翻人的时候照样列（带「不算数了」）");
});

test("associate: 原条目和它的更正都被搜到时，更正只记一次给过", async () => {
  const { r, s, ids } = await world();
  const n = s.entries(ids.video).find((x) => x.gist.startsWith("他替我点了发布"))!;
  const fix = s.correctEntry(n.id, { full: "其实是他替我点了发布、我自己按的确认", gist: "他替我点了发布，我按的确认", title: "点发布（更正）", why: "核了原话" }, "fix");
  const out = await r.associate("他替我点了发布，我按的确认");
  assert.ok(out.entries.includes(fix.id) && out.entries.includes(n.id), JSON.stringify(out.entries));
  assert.equal(out.entries.length, new Set(out.entries).size, JSON.stringify(out.entries));
});

test("associate: 访客近况里已经有的事，同一次联想的片段里不再重复列；近况里给的经过也记成给过", async () => {
  const { r, s, ids } = await world();
  const out = await r.associate("小贝说老师走了很难过的那天", { speaker: "小贝" });
  assert.equal(out.text.split(`${ids.ask}（`).length - 1, 1, out.text);
  const sad = s.entries(ids.ask).find((x) => x.gist.startsWith("小贝说老师走了"))!;
  if (out.text.includes(`（${sad.id}）`)) assert.ok(out.entries.includes(sad.id), JSON.stringify(out.entries));
});

test("associate: 没有向量时，WhatsApp 信封头里的「WhatsApp」「10」「31」不拿去认词", async () => {
  const { s, ix } = idx(null);
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  const e = s.createEvent(ev({ title: "WhatsApp 权限", summary: "10-31 谁能加我 WhatsApp", gist: "WhatsApp 权限" }), "w");
  s.addEntry(en(e.id, { at: T0 - DAY, full: "10-31 13:16 ada 准砚加 WhatsApp", gist: "准砚加 WhatsApp", title: "准砚加" }), "w");
  assert.equal((await r.associate("[WhatsApp +6155500009 +20s Sat 2026-10-31 13:16:09 GMT+11] +6155500009: 今天天气真不错啊")).text, "");
});

test("associate: 刚写进库、还没算向量的片段，词对上了照样想得起来（没向量不当成不像）", async () => {
  const { r, s, ids } = await world();
  s.addEntry(en(ids.video, { at: T0 - 3600_000, full: "他教我用剪映给视频加字幕", gist: "他教我用剪映加字幕", title: "字幕教学" }), "w");
  const out = await r.associate("剪映，加字幕");
  assert.match(out.text, /他教我用剪映加字幕/, out.text);
});

test("associate: 片段在子事件里时，头上写属于哪件大事；大事下面的「子事件」那行不列（不占片段的篇幅）", async () => {
  const { r, s, ix, ids } = await world();
  const kid = s.createEvent(ev({ title: "发布那天", summary: "点发布的那天", gist: "那天点了发布", parent: ids.video }), "w");
  s.addEntry(en(kid.id, { at: T0 - DAY, full: "他坐在旁边看我改封面标题", gist: "他看我改封面标题", title: "改封面标题" }), "w");
  s.addEntry(en(ids.video, { at: T0 - 2 * DAY, full: "封面标题又改了一版", gist: "封面标题又改了一版", title: "封面又改" }), "w");
  await ix.backfillVectors(500);
  const out = await r.associate("改封面标题的时候");
  assert.match(out.text, new RegExp(`属于 第一条B站视频 ${ids.video}`), out.text);
  assert.doesNotMatch(out.text, /子事件（/);
});

test("associate: 子事件里有片段时，大事本身（没有自己的片段）不单独列，靠子事件头上的「属于」带出；排在前面的是子事件", async () => {
  const { r, s, ix } = await world();
  const big = s.createEvent(ev({ title: "做形象", summary: "给自己做会动的形象，转头、眨眼、脸型", gist: "做会动的形象", importance: 5, why: "要紧" }), "w");
  for (let i = 0; i < 50; i++) s.touch(big.id, "auto");
  const kid = s.createEvent(ev({ title: "转头翻车", summary: "转头时脸歪了", gist: "转头连着翻车", importance: 3, parent: big.id }), "w");
  s.addEntry(en(kid.id, { at: T0 - DAY, full: "他看转头截图说整张脸歪了", gist: "他看转头截图说整张脸歪了", title: "脸歪了" }), "w");
  await ix.backfillVectors(500);
  const out = await r.associate("做形象时转头脸歪了");
  const heads = out.text.split("\n").filter((l) => l.startsWith("· "));
  assert.match(heads[0] ?? "", /转头翻车/, out.text);
  assert.ok(!heads.some((l) => l.startsWith("· 做形象〔")), out.text);
  assert.match(out.text, new RegExp(`属于 做形象 ${big.id}`));
});

test("associate: 越像这句话的越靠前；重要度只是小加分，被想起过多少次不算", async () => {
  const { r, s, ix } = await world();
  const hot = s.createEvent(ev({ title: "新嗓子", summary: "祥子配音开头有额，换了新嗓子", gist: "祥子配音换了新嗓子有额", importance: 5, why: "要紧" }), "w");
  for (let i = 0; i < 300; i++) s.touch(hot.id, "auto");
  const exact = s.createEvent(ev({ title: "配音去额", summary: "祥子配音开头老有额，拆句重配压住了", gist: "祥子配音开头老有额", importance: 3 }), "w");
  await ix.backfillVectors(500);
  const out = await r.associate("祥子配音开头老有额");
  const heads = out.text.split("\n").filter((l) => l.startsWith("· "));
  assert.match(heads[0] ?? "", new RegExp(exact.id), out.text);
  void hot;
});

test("associate: 话里提到某人、也说了具体的事：先给对上的片段；片段里已经有跟她有关的事，就不再列她最近的几件", async () => {
  const { r, ids } = await world();
  const out = await r.associate("小贝想用投影仪看片，帮她投嫌疑人X", { speaker: "ada" });
  const heads = out.text.split("\n").filter((l) => l.startsWith("· "));
  assert.match(heads[0] ?? "", new RegExp(ids.film), out.text);
  assert.doesNotMatch(out.text, /和小贝有关的最近几件事/);
});

test("人和东西：她自己不登记；群友是群的别名时不能悄悄并到群上，先拿掉别名再单独登记；新别名是别人的就不收", () => {
  const { s } = mk();
  assert.throws(() => s.upsertEntity({ name: "我", kind: "person" }, "b"), /就是你自己/);
  const e = s.createEvent(ev({ entities: [{ name: "ada", kind: "person", role: "with" }, { name: "米拉", kind: "person", role: "with" }] }), "b");
  s.addEntry(en(e.id, { people: ["ada", "我"] }), "b");
  assert.equal(s.entity("我"), undefined, "经过里写了「我」也不登记");
  assert.equal(s.entity("米拉"), undefined);
  assert.deepEqual(s.peopleOf(e.id), ["ada"]);

  s.upsertEntity({ name: "枫湾之家", kind: "group", aliases: ["朋友群", "Eddy"], importance: 3 }, "b");
  assert.throws(() => s.upsertEntity({ name: "Eddy", kind: "person" }, "b"), /是「枫湾之家」（群）的别名.*remove_aliases/);
  s.upsertEntity({ name: "枫湾之家", remove_aliases: ["Eddy"] }, "b");
  const ed = s.upsertEntity({ name: "Eddy", kind: "person", note: "枫湾之家群友", importance: 2 }, "b");
  assert.equal(ed.kind, "person");
  assert.deepEqual(s.entity("枫湾之家")!.aliases, ["朋友群"]);
  assert.throws(() => s.upsertEntity({ name: "Max", kind: "person", aliases: ["朋友群"] }, "b"), /已经是「枫湾之家」的别名/);
  assert.throws(() => s.upsertEntity({ name: "姑妈", kind: "person", importance: 4 }, "b"), /why/);
  const ayu = s.upsertEntity({ name: "姑妈", kind: "person", importance: 4, why: "ada 的妈妈" }, "b");
  assert.equal(ayu.importance, 4);
  assert.equal(s.upsertEntity({ name: "姑妈", note: "微信叫贾美丽" }, "b").importance, 4, "不写重要度就不改");
  assert.throws(() => s.upsertEntity({ name: "B站30天挑战", kind: "project" as never }, "b"), /kind/, "项目是事件，不登记成东西");
});

test("人和东西：merge 把事件和经过上的挂法挪到留下的那个（重复的去掉），名字变别名，重要度取最高；整批撤回能复原", async () => {
  const { s, ix } = idx(null);
  const e = s.createEvent(ev({ title: "微信陪姑妈", entities: [{ name: "姑妈", kind: "person", role: "with" }, { name: "柚子茶茶", kind: "person", role: "with" }] }), "b0");
  const n = s.addEntry(en(e.id, { people: ["柚子茶茶", "姑妈"] }), "b0").entry;
  s.upsertEntity({ name: "姑妈", importance: 4, why: "ada 的妈妈" }, "b0");
  s.upsertEntity({ name: "柚子茶茶", importance: 2, note: "小红书上的姑妈" }, "b0");
  const before = s.entities().map((t) => JSON.stringify(t)).sort();

  const kept = s.mergeEntities("姑妈", ["柚子茶茶"], "小红书的柚子茶茶就是姑妈", "tidy");
  assert.deepEqual(kept.aliases, ["柚子茶茶"]);
  assert.equal(kept.importance, 4);
  assert.equal(kept.note, "小红书上的姑妈", "留下的那个没备注就用被并的");
  assert.equal(s.entityById("t0002"), undefined, "被并的那一行没了");
  assert.equal(s.entity("柚子茶茶")!.name, "姑妈");
  assert.deepEqual(s.peopleOf(e.id), ["姑妈"]);
  assert.deepEqual(s.entryPeople(n.id), ["姑妈"]);
  assert.equal(s.entitiesOf(e.id).length, 1, "同一件事上重复的挂法去掉了");
  assert.ok((await ix.search("柚子茶茶")).some((h) => h.ref === e.id), "事件的搜索文字带上了新别名");
  assert.throws(() => s.mergeEntities("姑妈", ["姑妈"], "x", "tidy"), /没有要并进来的/);

  const r = s.revertBatch("tidy");
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(s.entities().map((t) => JSON.stringify(t)).sort(), before);
  assert.deepEqual(new Set(s.entryPeople(n.id)), new Set(["姑妈", "柚子茶茶"]));
});

test("人和东西：drop 去掉登记和挂法（事件、经过不动），名单上的人去不掉；tag 给已有的事件、经过补挂", () => {
  const { s } = mk();
  const e = s.createEvent(ev({ entities: [{ name: "ada", kind: "person", role: "with" }, { name: "load.py", kind: "thing", role: "about" }] }), "b");
  const n = s.addEntry(en(e.id), "b").entry;
  s.upsertEntity({ name: "ada", person_key: "ada", importance: 5, why: "最重要的人" }, "b");
  s.dropEntity("load.py", "系统零件，不是她会再提起的东西", "tidy");
  assert.equal(s.entity("load.py"), undefined);
  assert.deepEqual(s.entitiesOf(e.id).map((t) => t.name), ["ada"]);
  assert.ok(s.event(e.id));
  assert.throws(() => s.dropEntity("ada", "x", "tidy"), /在名单上/);

  s.upsertEntity({ name: "Max", kind: "person", importance: 2 }, "tidy");
  s.tagEntity("Max", n.id, "with", "tidy");
  s.tagEntity("Max", n.id, "with", "tidy");
  s.tagEntity("Max", e.id, "with", "tidy");
  assert.deepEqual(s.entryPeople(n.id).sort(), ["Max", "ada"]);
  assert.ok(s.peopleOf(e.id).includes("Max"));
  assert.throws(() => s.tagEntity("Max", "x1", "with", "tidy"), /事件编号/);
  assert.equal(s.entry(n.id)!.full, en(e.id).full, "经过原文不动");
});

test("memory: 夜里这一跑登记、挂上的人和东西没打重要度，mem_day_done 不收；补上就收；工作单第 8 节列名单", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.store.upsertEntity({ name: "ada", kind: "person", importance: 5, why: "最重要的人" }, "sync");
  m.beginNight("night:t/2026-10-29");
  m.write("mem_event_create", ev({ title: "进朋友群", entities: [{ name: "ada", kind: "person", role: "with" }, { name: "枫湾之家", kind: "group", role: "where" }] }), "hippocampus");
  m.write("mem_entry_add", en("e0001", { people: ["ada", "Eddy", "我"] }), "hippocampus");
  assert.throws(() => m.write("mem_day_done", { day: "2026-10-29" }, "hippocampus"), /还没有重要度：.*枫湾之家（群）.*Eddy（人）|还没有重要度：.*Eddy（人）.*枫湾之家（群）/);
  const w = m.worklist("2026-10-29").split("## 8.")[1]!;
  assert.match(w, /- 人：ada〔5〕、Eddy〔\?〕/);
  assert.match(w, /- 群：枫湾之家〔\?〕/);
  assert.match(w, /还没打重要度/);
  assert.match(m.write("mem_entity_upsert", { name: "枫湾之家", importance: 3 }, "hippocampus"), /重要度 3/);
  m.write("mem_entity_upsert", { name: "Eddy", importance: 2, note: "枫湾之家群友" }, "hippocampus");
  assert.match(m.write("mem_day_done", { day: "2026-10-29" }, "hippocampus"), /2026-10-29/);
  assert.equal(m.store.entity("我"), undefined);
});

test("memory: 名单同步不把别人的名字收成别名（不然整个人都同步不上）", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.store.upsertEntity({ name: "姑妈", kind: "person", importance: 4, why: "ada 的妈妈" }, "b");
  m.store.upsertEntity({ name: "柚子茶茶", kind: "person", importance: 2 }, "b");
  const changed = m.syncPeople({ ayu: { name: "姑妈", aliases: ["柚子茶茶", "贾美丽"] } });
  assert.deepEqual(changed, ["姑妈"]);
  assert.deepEqual(m.store.entity("姑妈")!.aliases, ["贾美丽"]);
  assert.equal(m.store.entity("姑妈")!.person_key, "ayu");
  assert.equal(m.store.entity("柚子茶茶")!.name, "柚子茶茶", "是同一个人的话夜里用 mem_entity_merge 并");
});

test("hh mem entity-plan：--dry 跑完全部退掉；出错的一步让整份不算；成功的是一个能撤回的批次", async () => {
  const { memCommand } = await import("../src/memory/events/cli.ts");
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  const s = m.store;
  s.createEvent(ev({ entities: [{ name: "ada", kind: "person", role: "with" }, { name: "枫湾之家", kind: "place", role: "where" }] }), "night");
  s.upsertEntity({ name: "枫湾之家", aliases: ["Eddy"] }, "night");
  const snap = () => JSON.stringify([s.entities(), s.db.prepare("SELECT count(*) n FROM mem_op").get(), s.db.prepare("SELECT count(*) n FROM mem_batch").get()]);
  const before = snap();
  const dir = tmpDir("plan-");
  const plan = (steps: unknown[]) => { const f = join(dir, `${Math.random()}.json`); writeFileSync(f, JSON.stringify(steps)); return f; };
  const good = plan([
    { op: "upsert", name: "枫湾之家", kind: "group", importance: 3, remove_aliases: ["Eddy"] },
    { op: "upsert", name: "Eddy", kind: "person", importance: 2 },
    { op: "tag", name: "Eddy", to: "e0001" },
    { op: "upsert", name: "ada", importance: 5, why: "最重要的人" },
  ]);
  const dry = await memCommand(m, "entity-plan", [good, "--dry"], { exportsDir: dir }) as { ok: boolean; list: string[]; unrated: string[] };
  assert.equal(dry.ok, true);
  assert.ok(dry.list.includes("person〔2〕Eddy：1 件事"));
  assert.deepEqual(dry.unrated, []);
  assert.equal(snap(), before, "--dry 不留痕迹");

  const bad = await memCommand(m, "entity-plan", [plan([{ op: "upsert", name: "枫湾之家", importance: 3 }, { op: "drop", name: "没这个人", reason: "x" }])], { exportsDir: dir }) as { ok: boolean; step: number; error: string };
  assert.deepEqual([bad.ok, bad.step], [false, 2]);
  assert.match(bad.error, /没有登记过/);
  assert.equal(snap(), before, "出错整份不算");

  const r = await memCommand(m, "entity-plan", [good], { exportsDir: dir }) as { ok: boolean; batch: string };
  assert.equal(r.ok, true);
  assert.equal(s.entity("枫湾之家")!.kind, "group");
  assert.ok(s.peopleOf("e0001").includes("Eddy"));
  s.revertBatch(r.batch);
  assert.equal(s.entity("Eddy")!.name, "枫湾之家", "撤回后回到原来的样子");
});

test("人和东西：经过里写的人只是群的别名时报错（不挂到群上）；名单同步不把群、地方改成人；撤回改别名的那一批，事件的搜索文字也回去", async () => {
  const { s, ix } = idx(null);
  const e = s.createEvent(ev({ title: "进群", entities: [{ name: "枫湾之家", kind: "group", role: "where" }] }), "b");
  s.upsertEntity({ name: "枫湾之家", aliases: ["阿杰"] }, "b");
  assert.throws(() => s.addEntry(en(e.id, { people: ["ada", "阿杰"] }), "b"), /是「枫湾之家」（群）的别名，挂不成人.*remove_aliases/);
  assert.equal(s.entries(e.id).length, 0, "整条没记上");
  const n = s.addEntry(en(e.id, { people: ["枫湾之家"] }), "b").entry;
  assert.deepEqual(s.entryPeople(n.id), ["枫湾之家"], "直接写群名可以");

  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.store.upsertEntity({ name: "枫湾之家", kind: "group", aliases: ["Max的群"] }, "b");
  assert.deepEqual(m.syncPeople({ max: { name: "Max的群", aliases: [] } }), []);
  assert.equal(m.store.entity("枫湾之家")!.kind, "group");
  assert.equal(m.store.entity("枫湾之家")!.person_key, null);

  s.upsertEntity({ name: "Eddy", kind: "person", importance: 2 }, "b");
  s.mergeEntities("枫湾之家", ["Eddy"], "测试", "tidy");
  assert.ok((await ix.search("Eddy")).some((h) => h.ref === e.id));
  s.revertBatch("tidy");
  assert.ok(!(await ix.search("Eddy")).some((h) => h.ref === e.id), "撤回后事件的搜索文字不再带 Eddy");
});

test("fade: 喜欢中的事不淡、腻了按重要度淡、pinned 照旧", () => {
  const { s } = mk(() => T0 - 200 * DAY);
  const mkEv = (over: Record<string, unknown>) => s.createEvent(ev({ importance: 2, why: "", summary: "老事的总结全文SUMMARY", ...over }), "b");
  const like = mkEv({ title: "喜欢的老事", stance: "like", status: "ongoing" });
  s.addEntry(en(like.id, { at: T0 - 200 * DAY, full: "老事的完整经过FULLTEXT", gist: "老事一句话", title: "老事" }), "b");
  const out = (id: string) => renderEvents([rev(s, id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5 });
  assert.match(out(like.id), /老事的总结全文SUMMARY/);
  assert.match(out(like.id), /FULLTEXT/);
  s.updateEvent(like.id, { status: "done" }, "", "b");
  const cooled = out(like.id);
  assert.doesNotMatch(cooled, /SUMMARY/, cooled);
  assert.doesNotMatch(cooled, /FULLTEXT/, cooled);
  const pin = mkEv({ title: "钉住的老事", status: "done", pinned: true });
  s.addEntry(en(pin.id, { at: T0 - 200 * DAY, full: "钉住的完整经过FULLTEXT", gist: "钉住一句话", title: "钉住" }), "b");
  assert.match(out(pin.id), /SUMMARY/);
  assert.match(out(pin.id), /FULLTEXT/);
  assert.equal(staysClear({ pinned: 0, stance: "like", status: "ongoing" }), true);
  assert.equal(staysClear({ pinned: 0, stance: "like", status: "done" }), false);
  assert.equal(staysClear({ pinned: 1, stance: null, status: "done" }), true);
});

test("render: 喜欢 / 烦的事标题后有标记", () => {
  const { s } = mk();
  const mkEv = (title: string, stance: string | null, status: string) => s.createEvent(ev({ title, ...(stance ? { stance } : {}), status, importance: 3, why: "" }), "b");
  const cases: Array<[string, string | null, string, string]> = [
    ["甲事", "like", "ongoing", "（喜欢中）"], ["乙事", "dislike", "ongoing", "（烦）"],
    ["丙事", "like", "done", "（以前喜欢）"], ["丁事", "dislike", "done", "（以前烦）"],
  ];
  for (const [t, st, status, mark] of cases) {
    const e = mkEv(t, st, status);
    const out = renderEvents([rev(s, e.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5 });
    assert.ok(out.includes(`${t}${mark}`) || out.includes(`· ${t}〔3〕`) && out.includes(mark), `${t}: ${out}`);
    assert.ok(out.indexOf(mark) > out.indexOf(t), out);
  }
  const plain = mkEv("普通事", null, "ongoing");
  assert.doesNotMatch(renderEvents([rev(s, plain.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5 }), /喜欢|烦/);
  // 撤掉的（retired）：记错了，不是以前喜欢过——只标「不算数了」
  for (const [t, st] of [["戊事", "like"], ["己事", "dislike"]] as const) {
    const out = renderEvents([rev(s, mkEv(t, st, "retired").id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5 });
    assert.match(out, /不算数了/, out);
    assert.doesNotMatch(out, /以前喜欢|以前烦|（喜欢中）|（烦）/, out);
  }
});

test("cluster: 喜欢中的事不因 stance 排到前面", async () => {
  const { s, ix } = idx();
  const text = { summary: "楼下来了一只猫", gist: "楼下的猫" };
  const like = s.createEvent(ev({ title: "猫咪甲", importance: 2, stance: "like", status: "ongoing", why: "", ...text }), "b");
  const plain = s.createEvent(ev({ title: "猫咪乙", importance: 3, status: "ongoing", why: "", ...text }), "b");
  for (const e of [like, plain]) s.addEntry(en(e.id, { full: "楼下的猫又来了", gist: "猫来了", title: "猫", source: [`c:${e.id}`] }), "b");
  assert.ok(await ix.backfillVectors(100) >= 2);
  const r = new EventRecall({ store: s, index: ix, now: () => T0, tz: "UTC" });
  const out = await r.cluster("楼下的猫");
  assert.ok(out.includes(like.id) && out.includes(plain.id), out);
  assert.ok(out.indexOf(plain.id) < out.indexOf(like.id), out);
});

test("render: 重要度 5 优先只看重要度和 pinned", () => {
  const { s } = mk();
  const five = s.createEvent(ev({ title: "核心大事", importance: 5, summary: "核心".repeat(20), why: "核心" }), "b");
  const like = s.createEvent(ev({ title: "喜欢的小事", importance: 2, stance: "like", status: "ongoing", summary: "小事".repeat(20), why: "" }), "b");
  const out = renderEvents([rev(s, like.id), rev(s, five.id)], { budget: 2000, now: T0, tz: "UTC", maxEvents: 5 });
  assert.ok(out.indexOf("核心大事") < out.indexOf("喜欢的小事"), out);
});

// ---- 口味日记搬进事件库（hh mem import taste / taste-check）----
test("final R17: 口味搬家（importer）的 remember / recall_event 不留碰过的痕迹", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "做脸" }), "seed");
  m.store.addEntry(en(e.id), "seed");
  m.index.ingestCentral();
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const before = touches();
  const tools = memTools(m, "importer", ["remember", "recall_event"]);
  await tools.find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  await tools.find((t) => t.name === "remember")!.handler({ cue: "做脸" });
  assert.equal(touches(), before, "importer 不留 mem_touch");
  await memTools(m, "main", ["recall_event"]).find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  assert.ok(touches() > before, "主意识照常留");
});

test("memtools: the night's audit sessions (audit-*) read her memory as checkers — no touch, nothing clears; stage sessions (sleep-*) keep the hippocampus behavior", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "做脸" }), "seed");
  m.store.addEntry(en(e.id), "seed");
  m.index.ingestCentral();
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const how = () => (db.prepare("SELECT how FROM mem_touch WHERE ref = ? ORDER BY rowid DESC LIMIT 1").get(e.id) as { how: string } | undefined)?.how;
  const before = touches();
  const audit = memTools(m, "audit-2026-11-04-people-1-1", ["remember", "recall_event", "recall_person"]);
  await audit.find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  await audit.find((t) => t.name === "remember")!.handler({ cue: "做脸" });
  await audit.find((t) => t.name === "recall_person")!.handler({ who: "ada" });
  assert.equal(touches(), before, "核依据不留 mem_touch");
  const h0 = touches();
  await memTools(m, "hippocampus", ["recall_event"]).find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  const hippoHow = how();
  assert.ok(touches() > h0, "海马照常留");
  const s0 = touches();
  await memTools(m, "sleep-2026-10-28-people-1", ["recall_event"]).find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  assert.ok(touches() > s0, "分段整理的段和海马一样留");
  assert.equal(how(), hippoHow);
});

function nightMem() {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 30, 14, 0);
  const m = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  m.beginNight("night:x/2026-10-30");
  return m;
}

test("final R18: worklist 第 3 节不推 喜欢 vs 普通 的相似标题，也不推已经连过的；supersede 不能让一件普通事取代喜欢", () => {
  const m = nightMem();
  m.write("mem_event_create", { title: "喜欢《史记》", summary: "s", gist: "g", importance: 2, stance: "like", status: "ongoing" }, "hippocampus");
  m.write("mem_event_create", { title: "读《史记》", summary: "s", gist: "g", importance: 2, status: "ongoing" }, "hippocampus");
  m.write("mem_event_create", { title: "整理书架上的旧书", summary: "s", gist: "g", importance: 2, status: "ongoing" }, "hippocampus");
  m.write("mem_event_create", { title: "整理书架上的旧书籍", summary: "s", gist: "g", importance: 2, status: "ongoing" }, "hippocampus");
  const sec3 = (): string => m.worklist("2026-10-30").split("## 3.")[1]!.split("## 4.")[0]!;
  assert.match(sec3(), /e0003「整理书架上的旧书」和 e0004|e0004「整理书架上的旧书籍」和 e0003/, `控制组该出现：${sec3()}`);
  assert.doesNotMatch(sec3(), /史记/, "stance 不同的不推");
  m.write("mem_link", { a: "e0003", b: "e0004", rel: "related", note: "x" }, "hippocampus");
  assert.doesNotMatch(sec3(), /整理书架/, "已经连过的不推");
  assert.throws(() => m.store.supersede("e0001", "e0002", "r", "b"), /喜欢 \/ 烦的事只能被同样的取代/);
  assert.throws(() => m.store.merge("e0002", ["e0001"], "r", "b"), /喜欢 \/ 烦的事只能和同样的并（stance 不同）；喜欢 \/ 烦的事和当时那件事用 mem_link related 连，不并/);
});

test("final minor3: worklist 第 6 节、第 7 节不列喜欢 / 烦的事", () => {
  const m = nightMem();
  const d = (n: number) => Date.UTC(2026, 9, 30, 14, 0) - n * DAY;
  m.store.createEvent(ev({ title: "普通旧事", status: "ongoing" }), "seed");
  m.store.createEvent(ev({ title: "旧喜欢", status: "ongoing", stance: "like" }), "seed");
  for (const id of ["e0001", "e0002"]) {
    m.store.addEntry(en(id, { at: d(14), source: ["c:a"] }), "seed");
    for (let i = 0; i < 41; i++) m.store.addEntry(en(id, { at: d(40 + (i % 3)), source: [`c:${id}${i}`], full: `经过${i}`, gist: `g${i}`, title: `t${i}` }), "seed");
  }
  const w = m.worklist("2026-10-30");
  const sec = (n: number) => w.split(`## ${n}.`)[1]!.split("\n## ")[0]!;
  assert.match(sec(7), /e0001/, "控制组：普通事太大会列");
  assert.doesNotMatch(sec(7), /e0002/);
  assert.doesNotMatch(sec(6), /e0002/);
});

test("final minor4: worklist 第 9 节最多列 40 件，按最近感受倒序，其余写「还有 N 件」", () => {
  const m = nightMem();
  for (let i = 0; i < 43; i++) m.store.createEvent(ev({ title: `喜欢第${i}号`, status: "ongoing", stance: "like" }), "seed");
  for (const id of ["e0041", "e0042", "e0043"]) m.store.addEntry({ event: id, at: Date.UTC(2026, 9, 1, 9, 0), kind: "feeling", full: "老感受", gist: "老感受", title: "老", source: [`c:${id}`] }, "seed");
  const sec = m.worklist("2026-10-30").split("## 9.")[1]!;
  assert.equal((sec.match(/^- 喜欢第/gm) ?? []).length, 40);
  assert.match(sec, /……还有 3 件（remember 找）/);
  assert.match(sec, /e0001：/);
  for (const id of ["e0041", "e0042", "e0043"]) assert.doesNotMatch(sec, new RegExp(`${id}：`), "最近一次感受最老的 3 件被略去");
});

test("final minor5a: 撤回记录里没有 stance 这一列的老批次：没有冲突，stance 仍是空", () => {
  const { s, db } = mk();
  const e = s.createEvent(ev({ title: "老批次写的" }), "old");
  for (const r of db.prepare("SELECT id, after FROM mem_op WHERE batch = 'old' AND tbl = 'mem_event'").all() as Array<{ id: number; after: string }>) {
    const a = JSON.parse(r.after) as Record<string, unknown>;
    delete a.stance;
    db.prepare("UPDATE mem_op SET after = ? WHERE id = ?").run(JSON.stringify(a), r.id);
  }
  assert.equal(s.event(e.id)!.stance, null);
  const res = s.revertBatch("old");
  assert.deepEqual(res.conflicts, []);
  assert.equal(s.event(e.id), undefined);
});

test("final minor5b: retire（含 mem_event_update 改成 retired）保留 stance", () => {
  const { s } = mk();
  const a = s.createEvent(ev({ title: "喜欢甲", status: "ongoing", stance: "like" }), "b");
  const b = s.createEvent(ev({ title: "烦乙", status: "ongoing", stance: "dislike" }), "b");
  s.retire(a.id, "记错了", "b2");
  assert.equal(s.event(a.id)!.status, "retired");
  assert.equal(s.event(a.id)!.stance, "like");
  s.updateEvent(b.id, { status: "retired" }, "不算数", "b3");
  assert.equal(s.event(b.id)!.status, "retired");
  assert.equal(s.event(b.id)!.stance, "dislike");
});

test("final minor8: 中期里只有「烦」没有「喜欢」时，节标题是「最近烦的」", () => {
  const { s } = mk();
  s.createEvent(ev({ title: "短视频弹窗", status: "ongoing", stance: "dislike" }), "b");
  for (let i = 0; i < 6; i++) { const p = s.createEvent(ev({ title: `普通事${i}`, status: "ongoing", importance: 2, why: "" }), "b"); s.addEntry(en(p.id, { at: T0 - DAY, source: [`c:p${i}`] }), "b"); }
  const r = new EventRecall({ store: s, index: new MemIndex(s.db, null) as never, now: () => T0, tz: "UTC" });
  const out = renderMidterm(r, { now: T0, tz: "UTC" });
  assert.match(out, /## 最近烦的\n\n最近烦的：短视频弹窗 e0001/);
  assert.doesNotMatch(out, /## 最近喜欢的/);
  s.createEvent(ev({ title: "芙莉莲", status: "ongoing", stance: "like" }), "b");
  assert.match(renderMidterm(r, { now: T0, tz: "UTC" }), /## 最近喜欢的/);
});

// ---- 白天自己记喜好（like / my_likes）----
function dayMem(start = T0) {
  const db = openDb(":memory:");
  let t = start;
  const m = new EventMemory({ db, embedder: null, now: () => t, tz: "UTC" });
  const n = (sql: string, ...args: string[]) => Number((db.prepare(sql).get(...args) as { n: number }).n);
  return {
    m, db,
    tick: (ms = 60_000) => { t += ms; },
    counts: () => ({ events: n("SELECT count(*) n FROM mem_event"), entries: n("SELECT count(*) n FROM mem_entry"), batches: n("SELECT count(*) n FROM mem_batch"), ops: n("SELECT count(*) n FROM mem_op") }),
    dayOps: (op: string) => db.prepare("SELECT reason FROM mem_op WHERE batch LIKE 'day-like:%' AND op = ? ORDER BY id").all(op) as Array<{ reason: string }>,
  };
}
const likeEv = (title: string, stance: "like" | "dislike", over: Record<string, unknown> = {}) =>
  ({ title, summary: "s", gist: `${title}的一句话`, importance: 3, stance, status: "ongoing", ...over });

test("like: 第一次喜欢上——新建「喜欢 X」（喜欢中、重要度默认 3、不挂人和东西），记一条感受（不写出处、时间是当下），自己一批、已提交", () => {
  const { m, counts } = dayMem();
  const feeling = "读到项羽本纪垓下那段，一个人唱完歌就去死，".repeat(5);
  const out = m.like({ what: "《史记》", how: "like", feeling });
  const e = m.store.event("e0001")!;
  assert.equal(e.title, "喜欢 《史记》");
  assert.equal(e.stance, "like");
  assert.equal(e.status, "ongoing");
  assert.equal(e.importance, 3);
  assert.equal(e.summary, feeling);
  assert.equal(e.gist.length, 80);
  assert.ok(e.gist.endsWith("…") && feeling.startsWith(e.gist.slice(0, 79)));
  assert.deepEqual(m.store.entitiesOf(e.id), []);
  const ns = m.store.entries(e.id);
  assert.equal(ns.length, 1);
  assert.equal(ns[0]!.kind, "feeling");
  assert.equal(ns[0]!.full, feeling);
  assert.equal(ns[0]!.gist, e.gist);
  assert.equal(ns[0]!.title, "喜欢上了");
  assert.equal(ns[0]!.source, "[]", "不写 c:N（会把对方原话误标成已进库）；夜里靠时间和批次认");
  assert.equal(ns[0]!.at, T0);
  assert.deepEqual(m.store.entryPeople(ns[0]!.id), []);
  assert.equal(out, "建好了 e0001「喜欢 《史记》」（喜欢中，重要度 3），记了这一下 n00001。");
  assert.doesNotMatch(out, /批次|stance/);
  const day = m.store.batches().filter((b) => b.batch.startsWith("day-like:"));
  assert.equal(day.length, 1);
  assert.equal(day[0]!.state, "committed");
  assert.deepEqual(m.store.openBatches(), []);

  // 烦：标题「烦 X」、感受标题「烦上了」；重要度写了就用写的
  m.like({ what: "短视频弹窗", how: "dislike", feeling: "一弹就烦", importance: 1 });
  const d = m.store.event("e0002")!;
  assert.equal(d.title, "烦 短视频弹窗");
  assert.equal(d.stance, "dislike");
  assert.equal(d.importance, 1);
  assert.equal(d.gist, "一弹就烦");
  assert.equal(m.store.entries(d.id)[0]!.title, "烦上了");
  assert.equal(m.store.entries(d.id)[0]!.source, "[]");
  // 重要度 4–5：why 就用这一下的感受（不然建不成）
  m.like({ what: "会长", how: "like", feeling: "每次想起都会笑", importance: 4 });
  assert.equal(m.store.event("e0003")!.importance, 4);
  assert.equal(m.store.event("e0003")!.why, "每次想起都会笑");
  // 同一时刻记了三次：三批各自提交，名字不撞
  const all3 = m.store.batches().filter((b) => b.batch.startsWith("day-like:"));
  assert.equal(all3.length, 3);
  assert.equal(new Set(all3.map((b) => b.batch)).size, 3);
  assert.ok(all3.every((b) => b.state === "committed"));
  assert.deepEqual(counts().events, 3);
  // 参数不对：什么都不写
  const before = counts();
  assert.throws(() => m.like({ what: "会长", how: "feel", feeling: "  " }), /feeling/);
  assert.throws(() => m.like({ what: " 》《 ", how: "like", feeling: "x" }), /what/);
  assert.throws(() => m.like({ what: "一".repeat(30), how: "like", feeling: "x" }), /what/);
  assert.deepEqual(counts(), before);
});

test("an English role stores its own words — Like X, me→X — and reads a Chinese role's as well (喜欢 X, 我→X)", async () => {
  const { setLang } = await import("../src/lang/index.ts");
  const { TEST_LANG, TEST_NAMES } = await import("./names.ts");
  setLang("en", TEST_NAMES);
  try {
    const { m, counts } = dayMem();
    m.like({ what: "coffee", how: "like", feeling: "x" });
    assert.equal(m.store.event("e0001")!.title, "Like coffee");
    m.like({ what: "Coffee", how: "like", feeling: "y" });
    assert.equal(counts().events, 1, "the same thing again: no second event");
    m.store.createEvent(likeEv("喜欢《史记》", "like"), "seed");
    m.like({ what: "史记", how: "like", feeling: "z" });
    assert.equal(counts().events, 2, "a title a Chinese role stored is found too");
    m.index.addQuotes([
      { src: "central", ref: "1", at: T0 + 1000, who: "我→阿青", channel: "", text: "早上好，今天去哪儿" },
      { src: "central", ref: "2", at: T0 + 2000, who: "me→阿青", channel: "", text: "good morning, where to today" },
    ]);
    assert.deepEqual(m.index.repliesTo("阿青", T0, 60_000).map((q) => q.text), ["早上好，今天去哪儿", "good morning, where to today"]);
  } finally { setLang(TEST_LANG, TEST_NAMES); }
});

test("like: 已经有「喜欢《史记》」——what 写《史记》、史记、史 记 都接上它：不新建，只多一条感受；腻了的那件改回喜欢中", () => {
  const { m, tick, counts, dayOps } = dayMem();
  const e = m.store.createEvent(likeEv("喜欢《史记》", "like"), "seed");
  const out = m.like({ what: "《史记》", how: "like", feeling: "又读了一篇列传" });
  assert.equal(counts().events, 1);
  assert.equal(out, "记上了：「喜欢《史记》」e0001（喜欢中）多了一下 n00001。");
  tick();
  m.like({ what: "史记", how: "like", feeling: "太史公自序好看" });
  assert.equal(m.store.entries(e.id).length, 2);
  // 腻了的：改回喜欢中，理由写「又喜欢上了」
  m.store.updateEvent(e.id, { status: "done" }, "腻了", "seed");
  tick();
  const back = m.like({ what: "史 记", how: "like", feeling: "重读又被打动" });
  assert.equal(counts().events, 1);
  assert.equal(m.store.entries(e.id).length, 3);
  assert.equal(m.store.event(e.id)!.status, "ongoing");
  assert.equal(m.store.event(e.id)!.stance, "like");
  assert.match(back, /「喜欢《史记》」e0001 改回喜欢中，多了一下 n00003/);
  assert.deepEqual(dayOps("event_update").map((o) => o.reason), ["又喜欢上了"]);
  // 烦的也一样：「烦 X」接 dislike，不烦了的改回烦着，理由「又烦上了」
  const d = m.store.createEvent(likeEv("烦 弹窗广告", "dislike", { status: "done" }), "seed");
  tick();
  assert.match(m.like({ what: "弹窗广告", how: "dislike", feeling: "又弹出来了" }), /改回烦着/);
  assert.equal(m.store.event(d.id)!.status, "ongoing");
  assert.deepEqual(dayOps("event_update").map((o) => o.reason), ["又喜欢上了", "又烦上了"]);
  // 被并掉、不算数了的不算
  m.store.createEvent(likeEv("喜欢 芙莉莲", "like", { status: "retired" }), "seed");
  tick();
  assert.match(m.like({ what: "芙莉莲", how: "like", feeling: "x" }), /建好了 e0004「喜欢 芙莉莲」/);
});

test("like: 完全一样的有好几件——什么都不写，列出候选（标题、编号、状态），用 event 指定就接上那一件", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢《史记》", "like"), "seed");
  m.store.createEvent(likeEv("喜欢 「史记」", "like", { status: "done" }), "seed");
  m.store.createEvent(likeEv("喜欢《史记》里的项羽", "like"), "seed");
  const before = counts();
  const out = m.like({ what: "史记", how: "like", feeling: "x" });
  assert.deepEqual(counts(), before, "事件、经过、批次都没多");
  assert.match(out, /「喜欢《史记》」e0001（喜欢中）/);
  assert.match(out, /「喜欢 「史记」」e0002（腻了）/);
  assert.doesNotMatch(out, /e0003/, "只是包含的不算候选");
  assert.match(out, /event/);
  m.like({ what: "史记", how: "like", feeling: "项羽那段", event: "e0002" });
  assert.equal(m.store.entries("e0002").length, 1);
  assert.equal(m.store.event("e0002")!.status, "ongoing");
  assert.equal(m.store.entries("e0001").length, 0);
});

test("like: 只认完全一样——只是包含的（史记·淮阴侯列传 对 史记、社会长期主义 对 会长）什么都不写，列最像的让她选；new=true 单独新建", () => {
  const { m, tick, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢《史记》", "like"), "seed");
  m.store.createEvent(likeEv("喜欢《史记》里的项羽", "like", { status: "done" }), "seed");
  m.store.createEvent(likeEv("喜欢 会长", "like"), "seed");
  m.store.createEvent(likeEv("喜欢 史", "like"), "seed");
  const before = counts();
  const out = m.like({ what: "史记·淮阴侯列传", how: "like", feeling: "韩信那段" });
  assert.deepEqual(counts(), before);
  assert.equal(out, "没有完全一样的。最像的是：「喜欢《史记》」e0001（喜欢中）。接在它上面就用 event=e0001 再记一次；要单独记一件就加 new=true。");
  const two = m.like({ what: "史记", how: "feel", feeling: "x" });
  assert.match(two, /^记上了：「喜欢《史记》」e0001/, "完全一样的那件优先，包含它的不抢");
  tick();
  const near2 = m.like({ what: "《史记》里的项羽本纪", how: "feel", feeling: "y" });
  assert.match(near2, /^没有完全一样的。最像的是：「喜欢《史记》里的项羽」e0002（腻了）、「喜欢《史记》」e0001（喜欢中）。/, "长短最接近的排前面");
  assert.match(near2, /用 event=<编号> 再记一次。$/, "feel 不提 new");
  assert.match(m.like({ what: "社会长期主义", how: "like", feeling: "z" }), /^没有完全一样的。最像的是：「喜欢 会长」e0003/);
  assert.equal(m.store.entries("e0003").length, 0);
  // new=true：不找了，直接新建；之后同名的就是完全一样
  tick();
  assert.match(m.like({ what: "史记·淮阴侯列传", how: "like", feeling: "韩信那段", new: true }), /^建好了 e0005「喜欢 史记·淮阴侯列传」/);
  tick();
  assert.match(m.like({ what: "史记·淮阴侯列传", how: "feel", feeling: "又读了一遍" }), /^记上了：「喜欢 史记·淮阴侯列传」e0005/);
  // 一个字的只认完全一样
  tick();
  m.like({ what: "史", how: "feel", feeling: "y" });
  assert.equal(m.store.entries("e0004").length, 1);
  // new 只在 like / dislike 时用；和 event 只写一个
  const c = counts();
  assert.throws(() => m.like({ what: "史记", how: "feel", feeling: "x", new: true }), /new 只在 how=like 或 dislike/);
  assert.throws(() => m.like({ what: "史记", how: "like", feeling: "x", new: true, event: "e0001" }), /new 和 event/);
  assert.deepEqual(counts(), c);
});

test("like: 名字本身以「喜欢」「烦」开头的（喜欢你、烦恼）对得上自己；what 带了「喜欢 」或「喜欢《」前缀的，新建时标题不重复前缀", () => {
  const { m, tick, counts } = dayMem();
  m.like({ what: "喜欢你", how: "like", feeling: "副歌一响就想哭" });
  tick();
  assert.match(m.like({ what: "喜欢你", how: "like", feeling: "又听了一遍" }), /^记上了：「喜欢 喜欢你」e0001/);
  tick();
  assert.match(m.like({ what: "喜欢你", how: "feel", feeling: "又一下" }), /^记上了：「喜欢 喜欢你」e0001/);
  tick();
  m.like({ what: "烦恼", how: "dislike", feeling: "想太多" });
  tick();
  assert.match(m.like({ what: "烦恼", how: "dislike", feeling: "又想太多" }), /^记上了：「烦 烦恼」e0002/);
  tick();
  assert.match(m.like({ what: "烦恼", how: "over", feeling: "想通了" }), /e0002 改成不烦了/);
  assert.equal(counts().events, 2);
  // 前缀：「喜欢 」「烦 」（带空格）、「喜欢」紧跟开括号的去掉；别的原样
  tick();
  assert.match(m.like({ what: "喜欢《三体》", how: "like", feeling: "黑暗森林" }), /^建好了 e0003「喜欢 《三体》」/);
  tick();
  assert.match(m.like({ what: "《三体》", how: "feel", feeling: "又想起来" }), /^记上了：「喜欢 《三体》」e0003/);
  tick();
  assert.match(m.like({ what: "烦 弹窗广告", how: "dislike", feeling: "一弹就烦" }), /^建好了 e0004「烦 弹窗广告」/);
  tick();
  assert.match(m.like({ what: "喜欢 会长", how: "like", feeling: "笑死" }), /^建好了 e0005「喜欢 会长」/);
  tick();
  assert.match(m.like({ what: "会长", how: "feel", feeling: "又笑" }), /^记上了：「喜欢 会长」e0005/);
});

test("like: feel 没找到报错、什么都没写；over → 腻了、again → 又喜欢上；烦的 over 是「不烦了」、again 是「又烦上了」", () => {
  const { m, tick, counts, dayOps } = dayMem();
  assert.throws(() => m.like({ what: "芙莉莲", how: "feel", feeling: "x" }), /没找到「芙莉莲」，第一次喜欢 \/ 烦用 how=like 或 dislike/);
  assert.throws(() => m.like({ what: "芙莉莲", how: "over", feeling: "x" }), /没找到「芙莉莲」/);
  assert.deepEqual(counts(), { events: 0, entries: 0, batches: 0, ops: 0 });
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  const id = "e0001";
  const titles = () => m.store.entries(id).map((n) => n.title);
  tick();
  assert.match(m.like({ what: "芙莉莲", how: "feel", feeling: "又看了一集" }), /记上了：「喜欢 芙莉莲」e0001（喜欢中）多了一下 n00002。/);
  assert.equal(m.store.event(id)!.status, "ongoing");
  tick();
  const tired = "看太多遍，每一集的套路都知道了，".repeat(8);
  assert.match(m.like({ what: "芙莉莲", how: "over", feeling: tired }), /e0001 改成腻了/);
  assert.equal(m.store.event(id)!.status, "done");
  assert.equal(m.store.event(id)!.stance, "like");
  const r = dayOps("event_update").map((o) => o.reason);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.length, 80);
  assert.ok(r[0]!.endsWith("…"));
  tick();
  assert.match(m.like({ what: "芙莉莲", how: "over", feeling: "还是腻" }), /（腻了）多了一下/, "已经腻了的只加感受");
  assert.equal(dayOps("event_update").length, 1);
  tick();
  assert.match(m.like({ what: "芙莉莲", how: "again", feeling: "新一季又喜欢上了" }), /改回喜欢中/);
  assert.equal(m.store.event(id)!.status, "ongoing");
  assert.deepEqual(titles(), ["喜欢上了", "又一下", "腻了", "腻了", "又喜欢上了"]);
  // 烦的
  tick();
  m.like({ what: "弹窗", how: "dislike", feeling: "烦" });
  tick();
  assert.match(m.like({ what: "弹窗", how: "over", feeling: "关掉了就不烦了" }), /改成不烦了/);
  tick();
  m.like({ what: "弹窗", how: "again", feeling: "又开始弹" });
  tick();
  m.like({ what: "弹窗", how: "feel", feeling: "还在弹" });
  assert.deepEqual(m.store.entries("e0002").map((n) => n.title), ["烦上了", "不烦了", "又烦上了", "又一下"]);
  assert.equal(m.store.event("e0002")!.status, "ongoing");
  assert.ok(m.store.entries("e0002").every((n) => n.kind === "feeling"));
});

test("like: 反过来——只有「烦 X」时说喜欢 X：新建「喜欢 X」，原来那件不动，返回里提到它", () => {
  const { m, tick } = dayMem();
  m.like({ what: "香菜", how: "dislike", feeling: "一股肥皂味" });
  tick();
  const out = m.like({ what: "香菜", how: "like", feeling: "居然吃出香味了" });
  const e = m.store.event("e0002")!;
  assert.equal(e.title, "喜欢 香菜");
  assert.equal(e.stance, "like");
  const old = m.store.event("e0001")!;
  assert.equal(old.stance, "dislike");
  assert.equal(old.status, "ongoing");
  assert.equal(m.store.entries(old.id).length, 1);
  assert.match(out, /建好了 e0002「喜欢 香菜」/);
  assert.match(out, /另外「烦 香菜」e0001 还在烦着，不烦了可以用 how=over（event 写 e0001）/);
  // 再反过来：烦上喜欢着的
  tick();
  const out2 = m.like({ what: "香菜", how: "dislike", feeling: "又觉得是肥皂味" });
  assert.match(out2, /记上了：「烦 香菜」e0001/);
  assert.match(out2, /另外「喜欢 香菜」e0002 还标着喜欢中，不喜欢了可以用 how=over/);
  assert.equal(m.store.event("e0002")!.status, "ongoing");
  // 另一件已经不喜欢了：不提
  m.store.updateEvent("e0002", { status: "done" }, "", "seed");
  tick();
  assert.doesNotMatch(m.like({ what: "香菜", how: "dislike", feeling: "z" }), /另外/);
});

test("like: event 指向的不是喜欢 / 烦的事、不存在、被并掉、stance 对不上 → 报错，什么都没写", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(ev({ title: "做脸" }), "seed");
  m.store.createEvent(likeEv("烦 弹窗", "dislike"), "seed");
  m.store.createEvent(likeEv("喜欢 旧番", "like", { status: "superseded" }), "seed");
  const before = counts();
  assert.throws(() => m.like({ what: "做脸", how: "feel", feeling: "x", event: "e0001" }), /e0001.*不是喜欢 \/ 烦的事/);
  assert.throws(() => m.like({ what: "x", how: "feel", feeling: "x", event: "e9999" }), /e9999/);
  assert.throws(() => m.like({ what: "x", how: "feel", feeling: "x", event: "e0003" }), /e0003/);
  assert.throws(() => m.like({ what: "弹窗", how: "like", feeling: "x", event: "e0002" }), /e0002/);
  assert.deepEqual(counts(), before);
  // stance 对得上就接
  m.like({ what: "弹窗", how: "feel", feeling: "又弹", event: "e0002" });
  assert.equal(m.store.entries("e0002").length, 1);
});

test("like: 夜里那一批开着也能记（自己一批，不进夜里那批）；夜里那批撤回、hhd 启动撤回没收尾的，都不撤白天记的", () => {
  const { m, tick } = dayMem();
  m.beginNight("night:x/2026-10-30");
  m.write("mem_event_create", likeEv("喜欢 会长", "like"), "hippocampus");
  const nightOps = m.store.ops("night:x/2026-10-30").length;
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  tick();
  m.like({ what: "会长", how: "feel", feeling: "又想起会长那句话" });
  assert.equal(m.store.ops("night:x/2026-10-30").length, nightOps, "白天写的不进夜里那批");
  assert.equal(m.currentBatch, "night:x/2026-10-30");
  assert.deepEqual(m.store.openBatches(), ["night:x/2026-10-30"]);
  m.revertNight();
  assert.equal(m.store.event("e0002")!.title, "喜欢 芙莉莲");
  assert.equal(m.store.entries("e0002").length, 1);
  assert.ok(m.store.entry("n00002"), "接在夜里那件上的感受还在");
  assert.ok(m.store.event("e0001"), "夜里建的那件被白天的感受用着：留着，不留孤儿");
  m.beginNight("night:y/2026-10-31");
  tick();
  m.like({ what: "芙莉莲", how: "over", feeling: "看腻了" });
  assert.deepEqual(m.recoverOpenBatches(), ["night:y/2026-10-31"]);
  assert.equal(m.store.event("e0002")!.status, "done");
  assert.equal(m.store.entries("e0002").length, 2);
});

test("like: 中途出错整批撤回、错误照抛；write() 白天照旧拒绝，并指路用 like", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢 会长", "like"), "seed");
  // 构造一个中途才会失败的：重要度 4 却没 why 的老事件，先记上感受、再改状态时 updateEvent 拒绝（先记的感受要跟着撤掉）
  m.store.db.prepare("UPDATE mem_event SET status = 'done', importance = 4, why = '' WHERE id = 'e0001'").run();
  const before = counts();
  assert.throws(() => m.like({ what: "会长", how: "again", feeling: "又想起来了" }), /why/);
  const after = counts();
  assert.equal(after.events, before.events);
  assert.equal(after.entries, before.entries, "这次调用什么都不留");
  assert.deepEqual(m.store.openBatches(), []);
  assert.equal(m.store.event("e0001")!.status, "done");
  assert.throws(() => m.write("mem_event_create", { title: "x", summary: "s", gist: "g", importance: 2 }), /夜里整理[\s\S]*喜欢 \/ 烦的东西用 like/);
});

test("myLikes: 分四组（喜欢中、烦着的、以前喜欢、以前烦），组里按最近一次感受倒序（没感受的按改动时间）；不列被并掉、不算数的；只读；空组不写、全空有一句", () => {
  const { m, db, counts } = dayMem();
  assert.equal(m.myLikes(), "还没有记过喜欢或烦的东西。");
  const s = m.store;
  const felt = (id: string, daysAgo: number, gist: string) => s.addEntry({ event: id, at: T0 - daysAgo * DAY, kind: "feeling", full: `${gist}，原话`, gist, title: "又一下", source: [`c:${id}${daysAgo}`] }, "seed");
  const a = s.createEvent(likeEv("喜欢 甲", "like", { importance: 2 }), "seed"); felt(a.id, 3, "甲的感受");
  const b = s.createEvent(likeEv("喜欢 乙", "like"), "seed"); felt(b.id, 10, "乙的旧感受"); felt(b.id, 1, "乙的新感受");
  s.addEntry({ event: b.id, at: T0 - 0.5 * DAY, kind: "happened", full: "不是感受的经过", gist: "不是感受", title: "经过", source: ["c:x"] }, "seed");
  const c = s.createEvent(likeEv("喜欢 丙", "like", { importance: 4, why: "w" }), "seed");   // 没感受：按改动时间（T0），排最前
  const d = s.createEvent(likeEv("喜欢 丁", "like", { status: "done" }), "seed"); felt(d.id, 5, "丁腻了");
  const e = s.createEvent(likeEv("烦 戊", "dislike"), "seed"); felt(e.id, 2, "戊烦人");
  const f = s.createEvent(likeEv("烦 己", "dislike", { status: "done" }), "seed"); felt(f.id, 7, "己不烦了");
  s.createEvent(likeEv("喜欢 庚", "like", { status: "superseded" }), "seed");
  s.createEvent(likeEv("喜欢 辛", "like", { status: "retired" }), "seed");
  s.createEvent(ev({ title: "普通事壬", status: "ongoing" }), "seed");
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const t0 = touches(), c0 = counts();
  const out = m.myLikes();
  assert.equal(touches(), t0, "不 touch");
  assert.deepEqual(counts(), c0, "不写");
  const heads = out.split("\n").filter((l) => l.startsWith("## "));
  assert.deepEqual(heads, ["## 喜欢中", "## 烦着的", "## 以前喜欢（腻了）", "## 以前烦"]);
  const group = (h: string) => out.split(`${h}\n`)[1]!.split("\n\n")[0]!.split("\n");
  assert.deepEqual(group("## 喜欢中"), [
    `- 喜欢 丙〔4〕${c.id}：喜欢 丙的一句话`,
    `- 喜欢 乙〔3〕${b.id}：喜欢 乙的一句话（最近一下 10-29：乙的新感受）`,
    `- 喜欢 甲〔2〕${a.id}：喜欢 甲的一句话（最近一下 10-27：甲的感受）`,
  ]);
  assert.deepEqual(group("## 烦着的"), [`- 烦 戊〔3〕${e.id}：烦 戊的一句话（最近一下 10-28：戊烦人）`]);
  assert.deepEqual(group("## 以前喜欢（腻了）"), [`- 喜欢 丁〔3〕${d.id}：喜欢 丁的一句话（最近一下 10-25：丁腻了）`]);
  assert.deepEqual(group("## 以前烦"), [`- 烦 己〔3〕${f.id}：烦 己的一句话（最近一下 10-23：己不烦了）`]);
  assert.doesNotMatch(out, /庚|辛|壬/);
  // 空组不写
  const only = dayMem();
  only.m.like({ what: "弹窗", how: "dislike", feeling: "一弹就烦" });
  assert.equal(only.m.myLikes(), "## 烦着的\n- 烦 弹窗〔3〕e0001：一弹就烦", "一句话和最近那一下一样时不重复写");
});

test("工具 like / my_likes：主线、一心多用那头能用（感受不写出处）；海马、体检、导入、潜意识、随口、下意识就算塞进名单也记不了", async () => {
  const { MEM_LIKE_TOOLS } = await import("../src/tools/memtools.ts");
  assert.deepEqual([...MEM_LIKE_TOOLS], ["like", "my_likes"]);
  const { m, tick, counts } = dayMem();
  m.beginNight("night:x/2026-10-30");   // 夜里那一批开着，海马照样不能用 like
  for (const r of ["hippocampus", "exam", "importer", "deep", "speech", "perception-messages"]) {
    const like = memTools(m, r, [...MEM_LIKE_TOOLS]).find((t) => t.name === "like");
    if (like) assert.match(await like.handler({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" }), /这会儿不能记喜好/, r);
  }
  assert.equal(counts().events, 0);
  const tools = memTools(m, "main", [...MEM_LIKE_TOOLS]);
  assert.deepEqual(tools.map((t) => t.name), ["like", "my_likes"]);
  const like = tools.find((t) => t.name === "like")!;
  assert.ok(like.description.split("\n").length <= 6);
  assert.match(like.description, /当场记进记忆/);
  assert.match(like.description, /知道编号就直接写 event（「最近这一段」里的「最近喜欢的」和 my_likes 里都有编号）/);
  assert.doesNotMatch(like.description, /中期/, "她前缀里叫「最近这一段」");
  // 框架原则：说明只讲机制，怎么记的规矩写在她自己的技能书里
  assert.doesNotMatch(like.description, /同一部作品|写法、气质|一次性的反应|\.md|notes\//);
  assert.match(like.description, /fix/);
  assert.match(like.description, /drop/);
  assert.match(like.description, /完全一样才自动接上/);
  const shape = z.object(like.shape);
  assert.equal(shape.safeParse({ what: "芙莉莲", how: "fix", title: "x", why: "w" }).success, true, "fix 不用 feeling");
  assert.equal(shape.safeParse({ what: "芙莉莲", how: "drop", event: "e0001", why: "w" }).success, true);
  assert.equal(shape.safeParse({ what: "芙莉莲", how: "love", feeling: "x" }).success, false);
  assert.equal(shape.safeParse({ what: "芙莉莲", how: "like", feeling: "x", importance: 6 }).success, false);
  assert.equal(shape.safeParse({ what: "芙莉莲", how: "again", feeling: "x", event: "e0001", importance: 2 }).success, true);
  assert.equal((shape.parse({ what: "芙莉莲", how: "like", feeling: "x", new: true }) as { new?: boolean }).new, true, "new 不被 shape 剥掉");
  assert.match(await like.handler(shape.parse({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" })), /^建好了 e0001「喜欢 芙莉莲」/);
  assert.equal(m.store.entries("e0001")[0]!.source, "[]");
  tick();
  await like.handler(shape.parse({ what: "芙莉莲", how: "feel", feeling: "又看了一集" }));
  assert.equal(m.store.entries("e0001")[1]!.source, "[]");
  assert.match(await like.handler({ what: "会长", how: "feel", feeling: "x" }), /^没做成：没找到「会长」/);
  assert.match(await like.handler({ what: "芙莉莲", how: "feel" }), /^没做成：feeling/, "fix、drop 以外 feeling 照旧必填");
  tick();
  assert.match(await like.handler(shape.parse({ what: "芙莉莲", how: "like", feeling: "另一部同名的", new: true })), /^没做成：已经有「喜欢 芙莉莲」e0001/, "new 传得进去");
  assert.match(await like.handler(shape.parse({ what: "芙莉莲 第二季", how: "like", feeling: "第二季也好看", new: true })), /^建好了 e0002「喜欢 芙莉莲 第二季」/);
  // 一心多用那头也能用
  tick();
  await memTools(m, "side-1", ["like"]).find((t) => t.name === "like")!.handler({ what: "会长", how: "like", feeling: "每次都笑" });
  assert.equal(m.store.event("e0003")!.title, "喜欢 会长");
  assert.equal(m.store.entries("e0003")[0]!.source, "[]");
  const mine = tools.find((t) => t.name === "my_likes")!;
  assert.equal(mine.description, "看我喜欢 / 烦的全部，包括腻了的。");
  assert.deepEqual(Object.keys(mine.shape), ["page"]);
  assert.equal(z.object(mine.shape).safeParse({ page: 0 }).success, false);
  assert.match(await mine.handler({}), /## 喜欢中\n- 喜欢 会长〔3〕e0003[\s\S]*- 喜欢 芙莉莲〔3〕e0001/);
  tick();
  assert.match(await like.handler(shape.parse({ what: "会长", how: "fix", title: "会长大人", gist: "笑点低", why: "改个叫法" })), /^改好了 e0003（喜欢中）：标题「喜欢 会长」→「喜欢 会长大人」；一句话改成「笑点低」。$/);
  tick();
  assert.match(await like.handler(shape.parse({ what: "x", how: "drop", event: "e0003", why: "记错了" })), /^e0003「喜欢 会长大人」标成不算数了/);
  assert.doesNotMatch(await mine.handler({}), /会长/);
  assert.equal(await mine.handler({ page: 2 }), "没有第 2 页（一共 1 页）。");
});

test("worklist: 第 9 节标出今天白天自己用 like 记了几下、白天新建还没挂东西的（腻了的今天记过也列）；第 2 节不让夜里改喜欢 / 烦的状态", () => {
  const { m, tick } = dayMem(Date.UTC(2026, 9, 29, 14, 0));
  m.like({ what: "旧番", how: "like", feeling: "前天看的" });                          // e0001：10-29 白天新建，没挂东西
  tick(DAY);
  m.beginNight("night:x/2026-10-30");
  m.write("mem_event_create", { ...likeEv("喜欢 会长", "like"), entities: [{ name: "会长", kind: "thing", role: "about" }] }, "hippocampus");   // e0002：夜里建的、挂了东西
  m.write("mem_entry_add", { event: "e0002", at: "2026-10-30 09:00", kind: "feeling", full: "夜里从口味行接上的", gist: "口味行", title: "口味行" }, "hippocampus");
  m.write("mem_event_create", likeEv("喜欢 旧歌", "like", { status: "done" }), "hippocampus");   // e0003：腻了、今天没记过
  m.like({ what: "会长", how: "feel", feeling: "又笑了" });
  m.like({ what: "会长", how: "feel", feeling: "又笑了一次" });
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });                     // e0004
  m.like({ what: "弹窗", how: "dislike", feeling: "一弹就烦" });                          // e0005
  m.like({ what: "弹窗", how: "over", feeling: "关掉通知就不烦了" });
  const sec9 = () => m.worklist("2026-10-30").split("## 9.")[1]!.split("\n\n做完这一天")[0]!;
  const line = (id: string) => sec9().split("\n").find((l) => l.includes(`）${id}：`)) ?? "";
  const NEW = "（白天新建，还没挂那个东西：没登记过的先 mem_entity_upsert（带重要度）再 mem_entity_tag（role about））";
  assert.equal(line("e0002"), "- 喜欢 会长（喜欢中）e0002：喜欢 会长的一句话（最近一次 10-30）（今天白天自己记了 2 下）", "夜里写的那条不算");
  assert.equal(line("e0004"), `- 喜欢 芙莉莲（喜欢中）e0004：第一集就哭了（最近一次 10-30）（今天白天自己记了 1 下）${NEW}`);
  assert.equal(line("e0005"), `- 烦 弹窗（不烦了）e0005：一弹就烦（最近一次 10-30）（今天白天自己记了 2 下）${NEW}`, "今天白天改成不烦了的也列");
  assert.equal(line("e0001"), `- 喜欢 旧番（喜欢中）e0001：前天看的（最近一次 10-29）${NEW}`, "以前白天新建、还没挂的一直标着");
  assert.equal(line("e0003"), "", "腻了、今天没记过的不列");
  m.write("mem_entity_upsert", { name: "芙莉莲", kind: "work", importance: 3 }, "hippocampus");
  m.write("mem_entity_tag", { name: "芙莉莲", to: "e0004", role: "about" }, "hippocampus");
  assert.ok(!line("e0004").includes(NEW), "挂上了就不标");
  // 撤回的白天批次不算（直接造一个撤回的 day-like 批次，往 e0002 上记过一下又撤掉）
  m.store.openBatch("day-like:fake");
  m.store.addEntry({ event: "e0002", at: Date.UTC(2026, 9, 30, 15, 0), kind: "feeling", full: "撤回的那下", gist: "撤回的那下", title: "又一下" }, "day-like:fake");
  m.store.revertBatch("day-like:fake");
  assert.match(line("e0002"), /今天白天自己记了 2 下/);
  const sec2 = m.worklist("2026-10-30").split("## 2.")[1]!.split("\n")[0]!;
  assert.equal(sec2, " 今天有进展的事（核一下重要度、状态；喜欢 / 烦的事白天自己记过的不改状态，见第 9 节）");
});

test("myLikes: 整份最多约 4000 字，按组的顺序往下列、停在整行，末尾说还有几件、page=N 看下一页；各页接起来一件不少不重", () => {
  const { m } = dayMem();
  const s = m.store;
  const N = 110;
  for (let i = 0; i < N; i++) {
    const st = i % 3 === 0 ? "dislike" : "like";
    const e = s.createEvent(likeEv(`${st === "like" ? "喜欢" : "烦"} 第${i}个东西`, st, { status: i % 5 === 0 ? "done" : "ongoing", gist: `第${i}个的一句话，写得稍微长一点的样子，大概有三十来个字吧` }), "seed");
    s.addEntry({ event: e.id, at: T0 - i * 3600_000, kind: "feeling", full: `第${i}个最近那一下的感受，也写得稍微长一点`, gist: `第${i}个最近那一下的感受，也写得稍微长一点`, title: "又一下" }, "seed");
  }
  const pages: string[] = [];
  for (let p = 1; p < 20; p++) {
    const out = m.myLikes(p);
    if (out.startsWith("没有第")) { assert.equal(out, `没有第 ${p} 页（一共 ${p - 1} 页）。`); break; }
    pages.push(out);
  }
  assert.ok(pages.length >= 3, `分了 ${pages.length} 页`);
  const items = (t: string) => t.split("\n").filter((l) => l.startsWith("- "));
  let listed = 0;
  pages.forEach((t, i) => {
    assert.ok(t.length <= 4000, `第 ${i + 1} 页 ${t.length} 字`);
    assert.ok(t.split("\n").every((l) => l === "" || l.startsWith("- ") || l.startsWith("## ") || l.startsWith("……还有")), "停在整行");
    listed += items(t).length;
    if (i < pages.length - 1) assert.match(t, new RegExp(`\\n……还有 ${N - listed} 件没列，page=${i + 2} 看下一页$`));
    else assert.doesNotMatch(t, /……还有/);
  });
  const all = pages.flatMap(items);
  assert.equal(all.length, N);
  assert.equal(new Set(all).size, N);
  // 跟不分页时的顺序一样：喜欢中 → 烦着的 → 以前喜欢 → 以前烦，组里按最近一下
  const heads = pages.join("\n").split("\n").filter((l) => l.startsWith("## "));
  const order = ["## 喜欢中", "## 烦着的", "## 以前喜欢（腻了）", "## 以前烦"];
  assert.deepEqual([...new Set(heads)], order);
  for (let i = 1; i < heads.length; i++) assert.ok(order.indexOf(heads[i]!) >= order.indexOf(heads[i - 1]!), "组不往回跳");
  assert.equal(m.myLikes(), pages[0]);
});

test("like: 线上老标题「喜欢X」「烦X」（不带空格、后面不是括号）也按名字自动接上：标题和 what 一样拿两种形式比", () => {
  const { m, tick, counts } = dayMem();
  const huizhang = m.store.createEvent(likeEv("喜欢会长", "like"), "seed");
  const jitang = m.store.createEvent(likeEv("烦鸡汤结尾和煽情旁白", "dislike"), "seed");
  const kat = m.store.createEvent(likeEv("喜欢卡图卢斯", "like"), "seed");
  const shi = m.store.createEvent(likeEv("喜欢 史", "like"), "seed");   // 去掉「喜欢」只剩一个字：标题不用第二种形式
  assert.match(m.like({ what: "会长", how: "feel", feeling: "又笑了" }), /^记上了：「喜欢会长」e0001（喜欢中）多了一下/);
  tick();
  assert.match(m.like({ what: "会长", how: "like", feeling: "还是喜欢" }), /^记上了：「喜欢会长」e0001/, "like 也接上，不新建「喜欢 会长」");
  tick();
  assert.match(m.like({ what: "鸡汤结尾和煽情旁白", how: "feel", feeling: "又看到一个" }), /^记上了：「烦鸡汤结尾和煽情旁白」e0002（烦着）/);
  tick();
  assert.match(m.like({ what: "卡图卢斯", how: "over", feeling: "读完了，没那么上头了" }), /^记上了：「喜欢卡图卢斯」e0003 改成腻了/);
  tick();
  assert.match(m.like({ what: "喜欢 卡图卢斯", how: "again", feeling: "又翻出来读" }), /^记上了：「喜欢卡图卢斯」e0003 改回喜欢中/);
  assert.equal(counts().events, 4, "一件都没多建");
  assert.equal(m.store.entries(huizhang.id).length, 2);
  assert.equal(m.store.entries(jitang.id).length, 1);
  assert.equal(m.store.entries(kat.id).length, 2);
  // 「喜欢 史」去前缀只剩一个字：what=史 还是完全一样（照第一种），「欢史」这种不会冒出来
  tick();
  assert.match(m.like({ what: "史", how: "feel", feeling: "y" }), /^记上了：「喜欢 史」e0004/);
  assert.equal(m.store.entries(shi.id).length, 1);
});

test("like: new=true 但同一边已经有完全一样的——拒绝，一行不写，告诉她那件的编号，要接用 event", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢 芙莉莲", "like"), "seed");
  m.store.createEvent(likeEv("烦会长", "dislike"), "seed");
  const before = counts();
  assert.throws(() => m.like({ what: "芙莉莲", how: "like", feeling: "x", new: true }), /已经有「喜欢 芙莉莲」e0001.*event=e0001/);
  assert.throws(() => m.like({ what: "会长", how: "dislike", feeling: "x", new: true }), /已经有「烦会长」e0002/, "老标题写法也认");
  assert.deepEqual(counts(), before);
  // 另一边有同名的不拦（喜欢和烦本来就各建各的）；只是像的也不拦
  assert.match(m.like({ what: "会长", how: "like", feeling: "其实也挺喜欢", new: true }), /^建好了 e0003「喜欢 会长」/);
  assert.match(m.like({ what: "芙莉莲 第二季", how: "like", feeling: "y", new: true }), /^建好了 e0004「喜欢 芙莉莲 第二季」/);
});

// ---- 修订 3：白天改错（fix）、撤掉记错的（drop）——主人：她以前用旧文件能做的事现在都能做 ----
test("like fix: 改标题（没带前缀按 stance 补上）、改一句话（超 80 字截断）；按名字完全一样或 event 找；不加感受经过；理由写进改动；自己一批", () => {
  const { m, tick, counts, dayOps } = dayMem();
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  m.store.createEvent(likeEv("烦会长", "dislike"), "seed");
  const entries0 = counts().entries;
  tick();
  const out = m.like({ what: "芙莉莲", how: "fix", title: "《葬送的芙莉莲》", why: "写全名" });
  assert.equal(m.store.event("e0001")!.title, "喜欢 《葬送的芙莉莲》", "没带前缀：按喜欢补上");
  assert.match(out, /^改好了 e0001（喜欢中）：标题「喜欢 芙莉莲」→「喜欢 《葬送的芙莉莲》」。$/);
  assert.doesNotMatch(out, /批次|stance/);
  tick();
  m.like({ what: "葬送的芙莉莲", how: "fix", title: "喜欢 芙莉莲（动画）", why: "只喜欢动画版" });
  assert.equal(m.store.event("e0001")!.title, "喜欢 芙莉莲（动画）", "带了前缀的照写");
  tick();
  const long = "看到辛美尔的那些回忆就会想到要珍惜身边的人，".repeat(5);
  assert.match(m.like({ what: "x", how: "fix", event: "e0002", gist: long, why: "一句话写得更准" }), /^改好了 e0002（烦着）：一句话改成「/);
  assert.equal(m.store.event("e0002")!.gist.length, 80);
  assert.ok(m.store.event("e0002")!.gist.endsWith("…"));
  assert.equal(m.store.event("e0002")!.title, "烦会长", "只给 gist 就只改 gist");
  tick();
  m.like({ what: "会长", how: "fix", title: "会长的段子", gist: "老一套", why: "说清楚烦的是什么" });
  assert.equal(m.store.event("e0002")!.title, "烦 会长的段子", "烦的那边补「烦 」");
  assert.equal(m.store.event("e0002")!.gist, "老一套");
  assert.equal(counts().entries, entries0, "fix 不加感受经过");
  assert.deepEqual(dayOps("event_update").map((o) => o.reason), ["写全名", "只喜欢动画版", "一句话写得更准", "说清楚烦的是什么"]);
  assert.deepEqual(m.store.openBatches(), []);
  // 一样的不写
  const c0 = counts();
  assert.match(m.like({ what: "x", how: "fix", event: "e0002", gist: "老一套", why: "w" }), /没改/);
  assert.deepEqual(counts(), c0);
});

test("like fix: 两样都没给、没给 why、对上好几件、只是像、标题前缀是另一边的、标题太长、配 new——都拒绝或只列候选，一行不写", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢《史记》", "like"), "seed");
  m.store.createEvent(likeEv("喜欢 「史记」", "like"), "seed");
  m.store.createEvent(likeEv("喜欢 会长", "like"), "seed");
  const before = counts();
  assert.throws(() => m.like({ what: "会长", how: "fix", why: "w" }), /title 或 gist/);
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "  ", gist: "", why: "w" }), /title 或 gist/);
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "会长大人" }), /why/);
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "会长大人", why: "  " }), /why/);
  const multi = m.like({ what: "史记", how: "fix", title: "史记全本", why: "w" });
  assert.match(multi, /对上了好几件[\s\S]*e0001[\s\S]*e0002/);
  assert.match(m.like({ what: "会长大人", how: "fix", title: "x", why: "w" }), /^没有完全一样的。最像的是：「喜欢 会长」e0003（喜欢中）。要改的是它就写 event=e0003。$/);
  assert.match(m.like({ what: "会长大人", how: "drop", why: "w" }), /。要撤的是它就写 event=e0003。$/);
  assert.match(m.like({ what: "史记全", how: "fix", title: "x", why: "w" }), /。要改的是哪件就写 event=<编号>。$/);
  assert.throws(() => m.like({ what: "芙莉莲", how: "fix", title: "x", why: "w" }), /没找到「芙莉莲」/);
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "烦 会长", why: "w" }), /e0003.*喜欢/, "前缀是另一边的：不悄悄改成喜欢，也不改 stance");
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "一".repeat(30), why: "w" }), /标题/);
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "x", why: "w", new: true }), /new 只在 how=like 或 dislike/);
  assert.deepEqual(counts(), before);
  assert.equal(m.store.event("e0003")!.title, "喜欢 会长");
});

test("like drop: 记错了、不算数——标成 retired（不加感受经过，理由写进改动）；my_likes 和「最近喜欢的」里都没了；再 drop 报「已经撤掉了」；不给 why 拒绝", () => {
  const { m, tick, counts, dayOps } = dayMem();
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  tick();
  m.like({ what: "会长", how: "like", feeling: "笑死" });
  const before = counts();
  assert.throws(() => m.like({ what: "会长", how: "drop" }), /why/);
  assert.throws(() => m.like({ what: "会长", how: "drop", why: "" }), /why/);
  assert.deepEqual(counts(), before);
  tick();
  const out = m.like({ what: "会长", how: "drop", why: "记错了，是别人喜欢的" });
  assert.match(out, /^e0002「喜欢 会长」标成不算数了/);
  assert.doesNotMatch(out, /批次|stance|retired/);
  const e = m.store.event("e0002")!;
  assert.equal(e.status, "retired");
  assert.equal(e.stance, "like");
  assert.equal(counts().entries, before.entries, "drop 不加感受经过");
  assert.deepEqual(m.store.openBatches(), []);
  assert.ok(m.store.batches().filter((b) => b.batch.startsWith("day-like:")).every((b) => b.state === "committed"));
  assert.deepEqual(dayOps("retire").map((o) => o.reason), ["记错了，是别人喜欢的"]);
  assert.doesNotMatch(m.myLikes(), /会长/);
  assert.match(m.myLikes(), /芙莉莲/);
  // 中期「最近喜欢的」要有最近在发生的事撑出篇幅才出现：放几件普通事
  for (let i = 0; i < 6; i++) { const p = m.store.createEvent(ev({ title: `普通事${i}`, status: "ongoing", importance: 2, why: "" }), "seed"); m.store.addEntry(en(p.id, { at: T0 - DAY, source: [`c:p${i}`] }), "seed"); }
  const likesSec = (renderMidterm(m.recall, { now: T0 + 3 * 60_000, tz: "UTC" }).split("## 最近喜欢的")[1] ?? "");
  assert.match(likesSec, /芙莉莲/);
  assert.doesNotMatch(likesSec, /会长/);
  // 再 drop：按编号报「已经不算数了」，按名字找不到
  const c1 = counts();
  assert.throws(() => m.like({ what: "会长", how: "drop", event: "e0002", why: "w" }), /e0002「喜欢 会长」已经撤掉了（不算数）/);
  assert.throws(() => m.like({ what: "会长", how: "drop", why: "w" }), /「会长」e0002 已经撤掉了（不算数）/);
  assert.throws(() => m.like({ what: "芙莉莲", how: "drop", why: "w", new: true }), /new 只在 how=like 或 dislike/);
  assert.deepEqual(counts(), c1);
  // 撤掉以后同名的可以重新记一件
  tick();
  assert.match(m.like({ what: "会长", how: "like", feeling: "这回是真的喜欢" }), /^建好了 e\d{4}「喜欢 会长」/);
});

test("midterm: 「今天」那一节不列不算数了的事——白天 drop 掉的那件，它今天记的感受也不再冒出来", () => {
  const { m, tick } = dayMem();
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  tick();
  m.like({ what: "会长", how: "like", feeling: "笑死" });
  const today = () => (renderMidterm(m.recall, { now: T0 + 5 * 60_000, tz: "UTC" }).split("## 今天\n\n")[1] ?? "").split("\n\n## ")[0]!;
  assert.match(today(), /会长/, "控制组：drop 之前在");
  tick();
  m.like({ what: "会长", how: "drop", why: "记错了" });
  assert.match(today(), /芙莉莲/);
  assert.doesNotMatch(today(), /会长/);
});

test("like fix: 新标题开头是自己那边的词（带不带空格）、后面还有 2 个字以上就原样用；是另一边的词就拒绝（方向变了用 over 加 like / dislike）；「烦恼」「喜欢你」当名字补前缀", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢 会长", "like"), "seed");                       // e0001
  m.store.createEvent(likeEv("烦 鸡汤结尾", "dislike"), "seed");                  // e0002
  m.store.createEvent(likeEv("喜欢 歌", "like"), "seed");                         // e0003
  m.like({ what: "x", how: "fix", event: "e0001", title: "喜欢会长大人", why: "照线上的写法" });
  assert.equal(m.store.event("e0001")!.title, "喜欢会长大人", "线上写法原样用，不变成「喜欢 喜欢会长大人」");
  assert.match(m.like({ what: "会长大人", how: "feel", feeling: "又笑了" }), /^记上了：「喜欢会长大人」e0001/, "改完按名字接得上");
  m.like({ what: "x", how: "fix", event: "e0002", title: "烦鸡汤结尾和煽情旁白", why: "写全" });
  assert.equal(m.store.event("e0002")!.title, "烦鸡汤结尾和煽情旁白");
  const before = counts();
  assert.throws(() => m.like({ what: "x", how: "fix", event: "e0001", title: "烦会长", why: "w" }), /e0001.*喜欢的事.*how=over.*dislike.*不要用 fix/);
  assert.throws(() => m.like({ what: "x", how: "fix", event: "e0002", title: "喜欢鸡汤", why: "w" }), /e0002.*烦的事.*how=over.*like.*不要用 fix/);
  assert.throws(() => m.like({ what: "x", how: "fix", event: "e0003", title: "烦 歌", why: "w" }), /how=over/, "带空格的另一边前缀也拒绝");
  assert.deepEqual(counts(), before);
  m.like({ what: "x", how: "fix", event: "e0003", title: "烦恼", why: "其实是这首歌" });
  assert.equal(m.store.event("e0003")!.title, "喜欢 烦恼", "「烦」后面只剩一个字：是名字，补前缀");
  m.like({ what: "x", how: "fix", event: "e0003", title: "喜欢你", why: "记错歌名了" });
  assert.equal(m.store.event("e0003")!.title, "喜欢 喜欢你", "「喜欢」后面只剩一个字：是名字，补前缀");
  m.like({ what: "x", how: "fix", event: "e0002", title: "喜欢你", why: "是烦这首" });
  assert.equal(m.store.event("e0002")!.title, "烦 喜欢你");
});

test("like fix: 改出来的标题和同一边另一件名字完全一样——拒绝，告诉她那件的编号；另一边同名不拦", () => {
  const { m, counts } = dayMem();
  m.store.createEvent(likeEv("喜欢 芙莉莲", "like"), "seed");                     // e0001
  m.store.createEvent(likeEv("喜欢 葬送的芙莉莲", "like"), "seed");               // e0002
  m.store.createEvent(likeEv("喜欢会长", "like"), "seed");                        // e0003（线上写法）
  m.store.createEvent(likeEv("烦 弹窗", "dislike"), "seed");                      // e0004
  const before = counts();
  assert.throws(() => m.like({ what: "x", how: "fix", event: "e0002", title: "芙莉莲", why: "w" }), /e0001/);
  assert.throws(() => m.like({ what: "x", how: "fix", event: "e0002", title: "喜欢 会长", why: "w" }), /e0003/, "老标题写法也认");
  assert.deepEqual(counts(), before);
  assert.equal(m.store.event("e0002")!.title, "喜欢 葬送的芙莉莲");
  m.like({ what: "x", how: "fix", event: "e0004", title: "芙莉莲", why: "烦的是另一回事" });
  assert.equal(m.store.event("e0004")!.title, "烦 芙莉莲");
  m.like({ what: "x", how: "fix", event: "e0002", title: "葬送的芙莉莲（漫画）", why: "w" });
  assert.equal(m.store.event("e0002")!.title, "喜欢 葬送的芙莉莲（漫画）");
});

test("like: 撤掉以后按名字再记——feel / again / over / fix / drop 说「已经撤掉了（不算数）」、指路新记一件；按编号也一样；like 新建时提一句以前那件", () => {
  const { m, tick, counts } = dayMem();
  m.like({ what: "会长", how: "like", feeling: "笑死" });                       // e0001
  tick();
  m.like({ what: "会长", how: "drop", why: "记错了，是别人喜欢的" });
  tick();
  m.like({ what: "弹窗", how: "dislike", feeling: "一弹就烦" });                // e0002
  tick();
  m.like({ what: "弹窗", how: "drop", why: "其实不烦" });
  const before = counts();
  for (const how of ["feel", "again", "over"] as const) {
    assert.throws(() => m.like({ what: "会长", how, feeling: "x" }), /^Error: 「会长」e0001 已经撤掉了（不算数）；要重新记就 how=like 新记一件$/, how);
  }
  assert.throws(() => m.like({ what: "会长", how: "fix", title: "会长大人", why: "w" }), /「会长」e0001 已经撤掉了（不算数）/);
  assert.throws(() => m.like({ what: "会长", how: "drop", why: "w" }), /^Error: 「会长」e0001 已经撤掉了（不算数）$/);
  assert.throws(() => m.like({ what: "弹窗", how: "feel", feeling: "x" }), /e0002 已经撤掉了（不算数）；要重新记就 how=dislike 新记一件/);
  assert.throws(() => m.like({ what: "x", how: "feel", feeling: "x", event: "e0001" }), /e0001「喜欢 会长」已经撤掉了（不算数）；要重新记就 how=like 新记一件/);
  assert.deepEqual(counts(), before);
  // 按名字 like 新建：提以前那件；之后按名字接的是新的那件
  tick();
  const out = m.like({ what: "会长", how: "like", feeling: "这回是真的喜欢" });
  assert.match(out, /^建好了 e0003「喜欢 会长」/);
  assert.match(out, /\n以前那件「喜欢 会长」e0001 撤掉了（不算数），这是新记的一件。$/);
  tick();
  assert.match(m.like({ what: "会长", how: "feel", feeling: "又笑" }), /^记上了：「喜欢 会长」e0003/);
  // 另一边撤掉的同名不提
  tick();
  assert.doesNotMatch(m.like({ what: "会长", how: "dislike", feeling: "有时候也烦" }), /以前那件/);
});

test("worklist: 第 9 节列出今天白天撤掉的（不算数）——标题、编号、她写的理由，夜里别记回来、别另建同名的；第 2 节不列不算数的事", () => {
  const { m, tick } = dayMem(Date.UTC(2026, 9, 29, 10, 0));
  m.like({ what: "旧番", how: "like", feeling: "前天看的" });                    // e0001：10-29 撤的，不算今天
  tick();
  m.like({ what: "旧番", how: "drop", why: "昨天就撤了" });
  tick(DAY);
  const sec = (n: number) => m.worklist("2026-10-30").split(`## ${n}.`)[1]!.split("\n\n## ")[0]!.split("\n\n做完这一天")[0]!;
  m.like({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });             // e0002：还算数
  assert.doesNotMatch(sec(9), /今天白天撤掉的/, "没撤过就没有这一小节");
  tick();
  m.like({ what: "会长", how: "like", feeling: "笑死" });                       // e0003
  tick();
  m.like({ what: "会长", how: "feel", feeling: "又笑" });
  tick();
  m.like({ what: "会长", how: "drop", why: "记错了，是别人喜欢的" });
  tick();
  m.like({ what: "弹窗", how: "dislike", feeling: "一弹就烦" });                // e0004
  tick();
  m.like({ what: "弹窗", how: "drop", why: "其实不烦" });
  m.beginNight("night:x/2026-10-30");
  m.write("mem_event_create", likeEv("喜欢 夜里撤的", "like"), "hippocampus");  // e0005：夜里 retire 的不进这一小节
  m.write("mem_retire", { id: "e0005", reason: "夜里觉得不算" }, "hippocampus");
  const s9 = sec(9);
  assert.match(s9, /\n今天白天撤掉的（不算数）：\n- 「喜欢 会长」e0003：你写的理由「记错了，是别人喜欢的」\n- 「烦 弹窗」e0004：你写的理由「其实不烦」\n照你的，别记回来，也别另建同名的；你当天说到这个东西的话照常当材料，但不再为它建喜欢 \/ 烦的事。$/);
  assert.doesNotMatch(s9, /旧番|夜里撤的/);
  assert.doesNotMatch(s9.split("今天白天撤掉的")[0]!, /会长|弹窗/, "上面的喜欢 / 烦着的事里不列");
  const s2 = sec(2);
  assert.match(s2, /e0002「喜欢 芙莉莲」/, "控制组：还算数的照列");
  assert.doesNotMatch(s2, /e0003|e0004/, "第 2 节不列不算数的事");
});

// ---- 修订 5：名字对不上时，按东西的别名、按意思找以前喜欢过的；新建时说以前在哪提过 ----
function meaningMem(embedder: Embedder | null = fakeEmbedder(), start = Date.UTC(2026, 9, 30, 10, 0)) {
  const db = openDb(":memory:");
  let t = start;
  const warns: string[] = [];
  const infos: Array<Record<string, unknown>> = [];
  const m = new EventMemory({ db, embedder, now: () => t, tz: "UTC", log: { warn: (msg: string) => { warns.push(msg); }, info: (msg: string, data?: Record<string, unknown>) => { infos.push({ msg, ...data }); } } });
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return { m, db, warns, infos, tick: (ms = 60_000) => { t += ms; }, counts: () => ({ events: n("SELECT count(*) n FROM mem_event"), entries: n("SELECT count(*) n FROM mem_entry"), batches: n("SELECT count(*) n FROM mem_batch"), touches: n("SELECT count(*) n FROM mem_touch") }) };
}

test("like: 名字对不上、但挂着的东西的名字或别名对得上（新世纪福音战士 → 喜欢 EVA）——只列候选（带「叫 X 的那个」），不自动接、不写；腻了的也算", async () => {
  const { m, counts } = meaningMem(null);
  const eva = m.store.createEvent({ ...likeEv("喜欢 EVA", "like", { status: "done" }), entities: [{ name: "新世纪福音战士", kind: "work", role: "about" }] }, "seed");
  m.store.upsertEntity({ name: "新世纪福音战士", aliases: ["EVA"], importance: 3 }, "seed");
  const ubw = m.store.createEvent({ ...likeEv("喜欢 UBW 和远坂凛", "like"), entities: [{ name: "Fate/stay night UBW", kind: "work", role: "about" }] }, "seed");
  m.store.upsertEntity({ name: "Fate/stay night UBW", aliases: ["Fate UBW"], importance: 3 }, "seed");
  const before = counts();
  const out = await m.likeWithMeaning({ what: "新世纪福音战士", how: "like", feeling: "重看了一遍" });
  assert.equal(out, `没有完全一样的。最像的是：「喜欢 EVA」${eva.id}（腻了）（叫「新世纪福音战士」的那个）。接在它上面就用 event=${eva.id} 再记一次；要单独记一件就加 new=true。`);
  assert.match(await m.likeWithMeaning({ what: "Fate UBW", how: "feel", feeling: "又想起凛" }), new RegExp(`^没有完全一样的。最像的是：「喜欢 UBW 和远坂凛」${ubw.id}（喜欢中）（叫「Fate UBW」的那个）。接在它上面就用 event=${ubw.id} 再记一次。$`));
  assert.match(m.like({ what: "新世纪福音战士", how: "fix", title: "EVA 新剧场版", why: "w" }), new RegExp(`要改的是它就写 event=${eva.id}。$`), "同步的 like 也认别名");
  assert.deepEqual(counts(), before, "一行不写");
  // 另一边挂着同名东西的不算（like 只在喜欢的里找）
  m.store.createEvent({ ...likeEv("烦 剧场版拖档", "dislike"), entities: [{ name: "新剧场版", kind: "work", role: "about" }] }, "seed");
  assert.match(await m.likeWithMeaning({ what: "新剧场版", how: "like", feeling: "终于上了" }), /^建好了 e\d{4}「喜欢 新剧场版」/);
});

test("like: 名字不沾边、意思像的（评论区里跟陌生人聊原文 → 喜欢评论区里的一人一句）——用向量找，过门槛的列候选、不写；不留碰过的痕迹；工具走这条", async () => {
  const calls = { n: 0 };
  const { m, counts, infos } = meaningMem(fakeEmbedder(calls));
  const e1 = m.store.createEvent(likeEv("喜欢评论区里的一人一句", "like", { gist: "评论区里陌生人一人一句接梗", summary: "刷到评论区里大家一人一句地接梗，跟陌生人聊得很开心" }), "seed");
  m.store.createEvent(likeEv("喜欢 做饭", "like", { gist: "周末自己做饭", summary: "周末在家做饭，炒了两个菜" }), "seed");
  m.store.createEvent(likeEv("烦 弹窗广告", "dislike", { gist: "一弹就烦", summary: "打开应用就弹广告" }), "seed");
  m.store.createEvent(ev({ title: "评论区里一人一句", summary: "刷到评论区里大家一人一句地接梗，跟陌生人聊得很开心", gist: "评论区里陌生人一人一句接梗", status: "ongoing" }), "seed");   // 不是喜欢的事：不算
  await m.index.backfillVectors(50);
  const before = counts();
  const a = { what: "评论区里跟陌生人聊原文", how: "like" as const, feeling: "在评论区里跟陌生人一人一句聊原文，很开心" };
  const out = await m.likeWithMeaning(a);
  assert.equal(out, `没有完全一样的。最像的是：「喜欢评论区里的一人一句」${e1.id}（喜欢中）。接在它上面就用 event=${e1.id} 再记一次；要单独记一件就加 new=true。`);
  assert.deepEqual(counts(), before, "不写，也不留碰过的痕迹");
  // 每个意思像的候选记一条 info（余弦值，以后调门槛用）
  const cand = infos.filter((x) => x.msg === "like: meaning candidate");
  assert.equal(cand.length, 1, JSON.stringify(infos));
  assert.equal(cand[0]!.event, e1.id);
  assert.ok(Math.abs(Number(cand[0]!.cos) - 0.761) < 0.01, String(cand[0]!.cos));
  assert.equal(cand[0]!.what, "评论区里跟陌生人聊原文");
  // 工具走同一条
  const tool = memTools(m, "main", ["like"]).find((t) => t.name === "like")!;
  assert.equal(await tool.handler(a), out);
  // 不沾边的：照常新建；完全一样的：不去算向量
  assert.match(await m.likeWithMeaning({ what: "红烧肉", how: "like", feeling: "今天学会了做红烧肉" }), /^建好了 e\d{4}「喜欢 红烧肉」/);
  const n0 = calls.n;
  assert.match(await m.likeWithMeaning({ what: "做饭", how: "feel", feeling: "又做了一顿" }), /^记上了：「喜欢 做饭」/);
  assert.equal(calls.n, n0, "名字完全一样就不查意思");
  // new=true 不查意思，照建
  assert.match(await m.likeWithMeaning({ ...a, new: true }), /^建好了 e\d{4}「喜欢 评论区里跟陌生人聊原文」/);
  assert.equal(calls.n, n0);
});

test("like: 向量出错、超时——退回只比名字，返回里说一句「这次没法按意思找，只比了名字」，记 warn；没配向量就不说", async () => {
  const fail: Embedder = { async embed() { return null; } };
  const boom: Embedder = { async embed() { throw new Error("boom"); } };
  const hang: Embedder = { embed: () => new Promise(() => {}) };
  for (const [name, emb] of [["null", fail], ["throw", boom], ["hang", hang]] as const) {
    const { m, warns } = meaningMem(emb);
    m.store.createEvent(likeEv("喜欢 会长的段子", "like"), "seed");
    const t0 = Date.now();
    const made = await m.likeWithMeaning({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" }, { timeoutMs: 50 });
    assert.ok(Date.now() - t0 < 10_000, `${name}: 不久等（hang 那个永远不回；只防卡死；墙钟在机器忙时会慢，11-14 部署前检查里 1 秒的界挂过（1.3 秒），别卡太紧）`);
    assert.match(made, /^建好了 e0002「喜欢 芙莉莲」[\s\S]*\n这次没法按意思找，只比了名字。$/, name);
    assert.match(await m.likeWithMeaning({ what: "会长", how: "like", feeling: "x" }, { timeoutMs: 50 }), /^没有完全一样的。最像的是：「喜欢 会长的段子」e0001[\s\S]*\n这次没法按意思找，只比了名字。$/, `${name}：名字沾边的照样列`);
    await assert.rejects(m.likeWithMeaning({ what: "三体", how: "feel", feeling: "x" }, { timeoutMs: 50 }), /没找到「三体」[\s\S]*这次没法按意思找，只比了名字/);
    assert.equal(warns.length, 3, `${name}: ${warns.join("|")}`);
  }
  const plain = meaningMem(null);
  assert.doesNotMatch(await plain.m.likeWithMeaning({ what: "芙莉莲", how: "like", feeling: "x" }), /没法按意思找/, "没配向量（只有全文）不算出错");
  assert.equal(plain.warns.length, 0);
});

test("like: 新建时查以前零碎提到过的（不是喜欢 / 烦的事里，经过挂着同名东西或全文对得上），最多 3 件，不拦照建，返回里说在哪提过几次；new=true 也查；工作单「白天新建」那行带编号", async () => {
  const { m, tick } = meaningMem(null);
  const s = m.store;
  const surf = s.createEvent(ev({ title: "10 月冲浪零碎", summary: "刷到的零碎", gist: "零碎", status: "ongoing", importance: 2, why: "" }), "seed");   // e0001
  s.addEntry(en(surf.id, { at: Date.UTC(2026, 9, 20, 9, 0), full: "刷到芙莉莲的剪辑，辛美尔那段", gist: "芙莉莲剪辑", title: "剪辑", source: ["c:a"] }), "seed");
  s.addEntry(en(surf.id, { at: Date.UTC(2026, 9, 21, 9, 0), full: "又刷到芙莉莲", gist: "又刷到", title: "又刷", source: ["c:b"] }), "seed");
  const tagged = s.addEntry(en(surf.id, { at: Date.UTC(2026, 9, 22, 9, 0), full: "看了那部番的新一集", gist: "新一集", title: "新一集", source: ["c:c"] }), "seed").entry;
  s.upsertEntity({ name: "葬送的芙莉莲", kind: "work", aliases: ["芙莉莲"], importance: 3 }, "seed");
  s.tagEntity("葬送的芙莉莲", tagged.id, "about", "seed");
  const week = s.createEvent(ev({ title: "周记 10-27", summary: "这一周", gist: "这一周", status: "done", importance: 2, why: "" }), "seed");   // e0002
  s.addEntry(en(week.id, { at: Date.UTC(2026, 9, 27, 9, 0), full: "这周追完了芙莉莲", gist: "追完", title: "追完", source: ["c:d"] }), "seed");
  const liked = s.createEvent(likeEv("喜欢 辛美尔", "like", { summary: "芙莉莲里的辛美尔" }), "seed");   // e0003：喜欢的事不算「零碎」
  const gone = s.createEvent(ev({ title: "记错的", summary: "芙莉莲", gist: "芙莉莲", status: "retired", importance: 2, why: "" }), "seed");   // e0004：不算数的不算
  const out = await m.likeWithMeaning({ what: "芙莉莲", how: "like", feeling: "第一集就哭了" });
  assert.match(out, /^建好了 e0005「喜欢 芙莉莲」/);
  assert.match(out, new RegExp(`\\n以前在「10 月冲浪零碎」${surf.id} 里提过 3 次，在「周记 10-27」${week.id} 里提过 1 次。$`));
  assert.doesNotMatch(out, new RegExp(`${liked.id}|${gone.id}`));
  // 工作单：白天新建、还没挂东西的那行带上编号
  const line = m.worklist("2026-10-30").split("## 9.")[1]!.split("\n").find((l) => l.includes("）e0005："))!;
  assert.match(line, new RegExp(`（白天新建，还没挂那个东西：[^\\n]*）（以前提过：${surf.id}、${week.id}）$`));
  // new=true（有名字沾边的候选，照建）：也查
  tick();
  assert.match(await m.likeWithMeaning({ what: "芙莉莲的剪辑", how: "like", feeling: "剪得好的都爱看" }), /^没有完全一样的。最像的是：「喜欢 芙莉莲」e0005/);
  tick();
  const out2 = await m.likeWithMeaning({ what: "芙莉莲的剪辑", how: "like", feeling: "剪得好的都爱看", new: true });
  assert.match(out2, /^建好了 e0006「喜欢 芙莉莲的剪辑」/);
  assert.match(out2, new RegExp(`\\n以前在「10 月冲浪零碎」${surf.id} 里提过 1 次。$`));
  // 接上已有的、没提过的：不说
  tick();
  assert.doesNotMatch(await m.likeWithMeaning({ what: "芙莉莲", how: "feel", feeling: "又哭了" }), /以前在/);
  tick();
  assert.doesNotMatch(await m.likeWithMeaning({ what: "红烧肉", how: "like", feeling: "好吃" }), /以前在/);
  // 最多说 3 件，提得多的在前
  for (let i = 0; i < 4; i++) {
    const z = s.createEvent(ev({ title: `零碎${i}`, summary: "零碎", gist: "零碎", status: "ongoing", importance: 2, why: "" }), "seed");
    for (let k = 0; k <= i; k++) s.addEntry(en(z.id, { at: Date.UTC(2026, 9, 10 + k, 9, 0), full: `读了三体问题第${k}章`, gist: `三体问题${k}`, title: "读书", source: [`c:z${i}${k}`] }), "seed");
  }
  tick();
  const three = await m.likeWithMeaning({ what: "三体问题", how: "like", feeling: "黑暗森林" });
  assert.match(three, /\n以前在「零碎3」e\d{4} 里提过 4 次，在「零碎2」e\d{4} 里提过 3 次，在「零碎1」e\d{4} 里提过 2 次。$/);
});

test("like: 「以前提过」的全文检索只在 what 有 3 个字以上时查（「会长」这种两个字的会把「社会长期主义」也算进来）；挂着同名东西的照样算", async () => {
  const { m } = meaningMem(null);
  const s = m.store;
  const misc = s.createEvent(ev({ title: "读书零碎", summary: "零碎", gist: "零碎", status: "ongoing", importance: 2, why: "" }), "seed");
  s.addEntry(en(misc.id, { at: Date.UTC(2026, 9, 20, 9, 0), full: "读到社会长期主义的文章", gist: "社会长期主义", title: "读文章", source: ["c:a"] }), "seed");
  assert.doesNotMatch(await m.likeWithMeaning({ what: "会长", how: "like", feeling: "笑死" }), /以前在/, "两个字不走全文");
  const club = s.createEvent(ev({ title: "学生会番", summary: "看番", gist: "看番", status: "ongoing", importance: 2, why: "" }), "seed");
  const n = s.addEntry(en(club.id, { at: Date.UTC(2026, 9, 21, 9, 0), full: "看了那部番的第三集", gist: "第三集", title: "第三集", source: ["c:b"] }), "seed").entry;
  s.upsertEntity({ name: "脑洞学生会", kind: "work", aliases: ["学生会"], importance: 3 }, "seed");
  s.tagEntity("脑洞学生会", n.id, "about", "seed");
  const out = await m.likeWithMeaning({ what: "学生会", how: "like", feeling: "好笑" });
  assert.match(out, new RegExp(`\\n以前在「学生会番」${club.id} 里提过 1 次。$`), "挂着同名东西的照样算");
  assert.match(await m.likeWithMeaning({ what: "社会长期主义", how: "dislike", feeling: "太空" }), new RegExp(`以前在「读书零碎」${misc.id} 里提过 1 次`), "三个字以上照常走全文");
});

// ---- 认出东西：名字表（brain 那边的接法在 brain.test.ts） ----
import { Recognizer } from "../src/memory/events/recognize.ts";

test("recognize: 名字表是喜欢 / 烦的事挂着的东西的名字和别名；字之间可以有空白、不分大小写；英文要整词；一个字的、名单上的人、撤掉的不算；库有写就重建；最近一下新的在前", () => {
  const { m, tick } = dayMem();
  const s = m.store;
  const r = new Recognizer(s.db, "UTC");
  assert.deepEqual(r.find("什么都没有"), []);
  const ubw = s.createEvent({ ...likeEv("喜欢 UBW", "like", { status: "done" }), entities: [{ name: "Fate UBW", kind: "work", role: "about" }] }, "seed");
  s.addEntry({ event: ubw.id, at: Date.UTC(2026, 9, 3, 9, 0), kind: "feeling", full: "凛好看", gist: "凛好看", title: "又一下" }, "seed");
  const got = r.find("昨晚补了 fate  ubw 第三集");
  assert.deepEqual(got.map((x) => [x.name, x.id, x.state, x.last?.day, x.last?.gist]), [["Fate UBW", ubw.id, "腻了", "10-03", "凛好看"]]);
  assert.equal(r.find("FATEUBW 联动").length, 1, "没空白、大写也认");
  assert.equal(r.find("xfateubw2").length, 0, "英文要整词");
  tick();
  const soup = s.createEvent({ ...likeEv("烦 鸡汤", "dislike"), entities: [{ name: "鸡汤文", kind: "thing", role: "about" }, { name: "汤", kind: "thing", role: "about" }] }, "seed");
  s.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "主人" }, "seed");
  s.tagEntity("ada", soup.id, "with", "seed");
  assert.deepEqual(r.find("ada 转来一篇鸡汤文，汤很淡").map((x) => [x.name, x.id, x.state]), [["鸡汤文", soup.id, "烦着"]], "库有写就重建；一个字的「汤」、名单上的 ada 不算");
  assert.deepEqual(r.find("鸡汤文和 Fate UBW").map((x) => x.id), [soup.id, ubw.id], "最近一下（没感受的按改动时间）新的在前");
  assert.deepEqual(r.find("鸡汤文和 Fate UBW", new Set([soup.id])).map((x) => x.id), [ubw.id], "skip 里的不要");
  s.retire(soup.id, "记错了", "seed");
  assert.equal(r.find("鸡汤文").length, 0, "撤掉的不算");
  assert.equal(r.find("普通事").length, 0);
});

test("recognize: 少于 3 个字的名字只在紧挨书名号、引号时认（「历史记录」里不认史记、「学生会长」里不认会长）；全大写 4 个字母以内的（EVA）只认全大写（Eva Green 不认）；其余英文不分大小写、要整词", () => {
  const { m } = dayMem();
  const s = m.store;
  const r = new Recognizer(s.db, "UTC");
  const mk = (title: string, name: string, aliases: string[] = []) => {
    const e = s.createEvent({ ...likeEv(title, "like"), entities: [{ name, kind: "work", role: "about" }] }, "seed");
    if (aliases.length) s.upsertEntity({ name, aliases, importance: 3 }, "seed");
    return e.id;
  };
  const shiji = mk("喜欢《史记》", "史记");
  const hz = mk("喜欢会长", "脑洞学生会", ["会长"]);
  const eva = mk("喜欢 EVA", "新世纪福音战士", ["EVA"]);
  const ai = mk("喜欢 AI 绘画", "AI");
  const ids = (t: string) => r.find(t).map((x) => x.id);
  assert.deepEqual(ids("打开浏览器的历史记录看看"), []);
  assert.deepEqual(ids("学生会长选举"), []);
  assert.deepEqual(ids("Eva Green 的新片"), []);
  assert.deepEqual(ids("eva 和 Eva"), []);
  assert.deepEqual(ids("AI 绘画大赛"), [], "两个字母的也要带书名号、引号");
  assert.deepEqual(ids("读《史记》"), [shiji]);
  for (const t of ["「史记」", "『史记』", "“史记”", "\"史记\""]) assert.deepEqual(ids(`又翻了${t}`), [shiji], t);
  assert.deepEqual(ids("他说「会长」好可爱"), [hz]);
  assert.deepEqual(ids("新世纪福音战士"), [eva], "名字本身够长：照认");
  assert.deepEqual(ids("今天重看 EVA 第一集"), [eva]);
  assert.deepEqual(ids("《EVA》"), [eva]);
  assert.deepEqual(ids("「AI」画的"), [ai]);
  assert.deepEqual(ids("「ai」画的"), [], "全大写的只认全大写");
});

test("recognize: 名字表只取挂成 about 或 by 的东西（一起的人、群不算，不管在不在名单上）；撤回以后名字表跟着重建", () => {
  const { m } = dayMem();
  const s = m.store;
  const r = new Recognizer(s.db, "UTC");
  const e = s.createEvent({ ...likeEv("喜欢 三体", "like"), entities: [
    { name: "三体问题", kind: "work", role: "about" }, { name: "刘慈欣", kind: "person", role: "by" },
    { name: "小王同学", kind: "person", role: "with" }, { name: "科幻读书群", kind: "group", role: "with" },
  ] }, "seed");
  assert.deepEqual(r.find("三体问题").map((x) => x.id), [e.id]);
  assert.deepEqual(r.find("刘慈欣的新书").map((x) => x.id), [e.id], "by 算");
  assert.deepEqual(r.find("小王同学在科幻读书群里说").map((x) => x.id), [], "with 的人和群不算");
  // 夜里撤回：retire 的那件回来以后照样认得出（撤回只改批次名，不加 mem_op 新行）
  m.beginNight("night:x/2026-10-30");
  m.write("mem_retire", { id: e.id, reason: "夜里觉得不算" }, "hippocampus");
  assert.deepEqual(r.find("三体问题"), [], "retire 以后不认");
  m.revertNight();
  assert.equal(s.event(e.id)!.status, "ongoing");
  assert.deepEqual(r.find("三体问题").map((x) => x.id), [e.id], "撤回以后名字表重建");
  // hhd 启动撤回没收尾的批次也一样
  m.beginNight("night:y/2026-10-31");
  m.write("mem_retire", { id: e.id, reason: "又觉得不算" }, "hippocampus");
  assert.deepEqual(r.find("三体问题"), []);
  m.recoverOpenBatches();
  assert.deepEqual(r.find("三体问题").map((x) => x.id), [e.id]);
});

test("stage batches: two stages write in their own batch; reverting one keeps the other", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginStage("sleep-a", "b1");
  m.beginStage("sleep-b", "b2");
  const a = m.write("mem_event_create", ev({ title: "甲段的事" }), "sleep-a");
  const b = m.write("mem_event_create", ev({ title: "乙段的事" }), "sleep-b");
  const idA = /e\d{4,5}/.exec(a)![0];
  const idB = /e\d{4,5}/.exec(b)![0];
  const r = m.revertStage("sleep-b");
  assert.ok(r);
  assert.equal(m.store.event(idB), undefined);
  assert.ok(m.store.event(idA));
  assert.ok(m.store.openBatches().includes("b1"));
  m.commitStage("sleep-a");
  assert.ok(!m.store.openBatches().includes("b1"));
  assert.ok(m.store.event(idA));
  assert.equal(m.commitStage("sleep-a"), null);
});

test("stage batches: mem_day_done inside a stage is only remembered", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginStage("sleep-a", "b1");
  const out = m.write("mem_day_done", { day: "2026-11-04" }, "sleep-a");
  assert.match(out, /落地时生效/);
  assert.equal(m.store.dayDone("2026-11-04"), false);
  assert.deepEqual(m.commitStage("sleep-a"), { days: ["2026-11-04"] });
  assert.equal(m.store.dayDone("2026-11-04"), false);
  m.markDays(["2026-11-04"]);
  assert.equal(m.store.dayDone("2026-11-04"), true);
});

test("stage batches: mem_day_done in a stage still requires rated entities", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  m.beginStage("sleep-a", "b1");
  m.write("mem_event_create", ev({ entities: [{ name: "新朋友", kind: "person", role: "with" }] }), "sleep-a");
  assert.throws(() => m.write("mem_day_done", { day: "2026-11-04" }, "sleep-a"), /重要度/);
});

test("stage batches: the night batch and day-time writes are unchanged", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  assert.equal(m.batchFor("sleep-a"), null);
  m.beginNight("night:x/1");
  assert.equal(m.batchFor("hippocampus"), "night:x/1");
  assert.equal(m.batchFor("sleep-a"), "night:x/1");
  m.beginStage("sleep-a", "b1");
  assert.equal(m.batchFor("sleep-a"), "b1");
  assert.equal(m.batchFor("hippocampus"), "night:x/1");
  assert.equal(m.batchFor(), "night:x/1");
});

test("stage batches: stageOps counts the open stage batch's writes", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: "UTC" });
  assert.equal(m.stageOps("sleep-a"), 0);
  m.beginStage("sleep-a", "b1");
  assert.equal(m.stageOps("sleep-a"), 0);
  m.write("mem_event_create", ev({ title: "甲段的事" }), "sleep-a");
  assert.ok(m.stageOps("sleep-a") > 0);
  m.commitStage("sleep-a");
  assert.equal(m.stageOps("sleep-a"), 0, "提交了就不算这一段开着的批");
});

test("stage batches: revertDayStages reverts the day's committed and open stage batches since a time, newest first", () => {
  let t = T0 - DAY;
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => t, tz: "UTC" });
  const D = "2026-11-04";
  // 上一夜（材料不完整）整理过这一天、提交了：这一跑撤的时候不动它
  m.beginStage(`sleep-${D}-events-1`, `sleep:${D}/events/1`);
  const idPrev = /e\d{4,5}/.exec(m.write("mem_event_create", ev({ title: "上一夜的事", entities: [{ name: "老张", kind: "person", role: "with" }] }), `sleep-${D}-events-1`))![0];
  m.commitStage(`sleep-${D}-events-1`);
  // 这一跑（since = T0）：事件段建了一件事、提交了
  t = T0;
  m.beginStage(`sleep-${D}-events-2`, `sleep:${D}/events/2`);
  const idA = /e\d{4,5}/.exec(m.write("mem_event_create", ev({ title: "事件段的事" }), `sleep-${D}-events-2`))![0];
  m.commitStage(`sleep-${D}-events-2`);
  // 别的一天的批次：不动
  t += 1000;
  m.beginStage("sleep-2026-11-03-events-1", "sleep:2026-11-03/events/1");
  const idOther = /e\d{4,5}/.exec(m.write("mem_event_create", ev({ title: "前一天的事", entities: [{ name: "小李", kind: "person", role: "with" }] }), "sleep-2026-11-03-events-1"))![0];
  m.commitStage("sleep-2026-11-03-events-1");
  // 这一天撤回过的一段：留档的那份不能再撤
  t += 1000;
  m.beginStage(`sleep-${D}-self-1`, `sleep:${D}/self/1`);
  m.write("mem_event_create", ev({ title: "撤掉的事" }), `sleep-${D}-self-1`);
  m.revertStage(`sleep-${D}-self-1`);
  // 人物段在事件段那件事上改了总结、还开着（重启前做到一半）：得先撤它，事件段那件才撤得干净
  t += 1000;
  m.beginStage(`sleep-${D}-people-1`, `sleep:${D}/people/1`);
  m.write("mem_event_update", { id: idA, summary: "人物段改过的总结", reason: "补人" }, `sleep-${D}-people-1`);

  const r = m.revertDayStages(D, T0);
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.reverted >= 2, true);
  assert.equal(m.store.event(idA), undefined);
  assert.ok(m.store.event(idOther));
  assert.ok(m.store.event(idPrev), "上一夜的批次在 since 以前，不撤");
  assert.equal(m.store.batchState(`sleep:${D}/events/1`), "committed");
  assert.deepEqual(m.store.openBatches(), []);
  assert.equal(m.stageOps(`sleep-${D}-people-1`), 0, "撤掉的段不再算开着");
  assert.equal(m.store.batchState("sleep:2026-11-03/events/1"), "committed");
  assert.deepEqual(m.revertDayStages(D, T0), { reverted: 0, conflicts: [] }, "撤过的不再撤");
});

test("memtools: exam sessions (exam-*) read her memory as examinees — no touch, nothing clears", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent(ev({ title: "做脸" }), "seed");
  m.store.addEntry(en(e.id), "seed");
  m.index.ingestCentral();
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const before = touches();
  const exam = memTools(m, "exam-2026-11-05-events-after-resident-1", ["remember", "recall_event", "recall_person"]);
  await exam.find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  await exam.find((t) => t.name === "remember")!.handler({ cue: "做脸" });
  await exam.find((t) => t.name === "recall_person")!.handler({ who: "ada" });
  assert.equal(touches(), before, "考试不留 mem_touch");
});

test("切换前 P7：recall_event 翻 c:N 跟 #N 一样（整理时出处写的就是 c:N）", () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const c = new CentralMemory(db, () => T0);
  const seq = c.append(1, "外界", "input", "ada：今晚吃面", { from: "ada", human: true }).seq;
  m.index.ingestCentral();
  assert.equal(m.recallEvent(`c:${seq}`), m.recallEvent(`#${seq}`));
  assert.match(m.recallEvent(`c:${seq}`), /今晚吃面/);
  assert.match(m.recallEvent("c:999999"), /没有/);
});
