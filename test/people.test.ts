// 人物卡（通用印象表 mem_impression）：固定的小字段、依据、待批、钉原话、合并、撤回；现算的「我们的大事」「近况」；渲染和导出。
// 模板从 HH 配置来（R17）：测试夹具用 test/helpers.ts 的 TEST_ROLE.memory.people.template；主人从名单认，这里直接给 owners。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { removeAtExit, tmpDir } from "./tmp.ts";
import { join } from "node:path";
import { openDb, all } from "../src/store/db.ts";
import type { Db } from "../src/store/db.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { EventMemory, PEOPLE_DIRTY_AFTER } from "../src/memory/events/memory.ts";
import { MemChores } from "../src/memory/events/chores.ts";
import { cardFile, describeTemplate, exportPeople, fieldSpec, lostLines, parseTemplate, renderCard, renderNear, templateOr } from "../src/memory/events/people.ts";
import type { PeopleTemplate } from "../src/memory/events/people.ts";
import { QuotePin, localToUtc } from "../src/memory/events/schema.ts";
import type { ImpressionRow } from "../src/memory/events/schema.ts";
import { memTools, MEM_WRITE_TOOLS } from "../src/tools/memtools.ts";
import { memCommand } from "../src/memory/events/cli.ts";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 4, 3, 0);
const TZ = "Australia/Melbourne";
/** 依据：mk() / mkMem() 建的第一件事（不挂人） */
const EV = ["e0001"];
/** 配置里的那份模板（原样）和解析出来的测试夹具 */
import { TEST_ROLE } from "./helpers.ts";
const RAW = TEST_ROLE.memory.people.template;
const T: PeopleTemplate = parseTemplate(RAW);
/** 名单上的主人 */
const OWNERS: ReadonlySet<string> = new Set(["ada"]);

/** 主人（名单 key 主人，主人）、小贝（xiaobei）、枫湾之家（群，不在名单上）；e0001 是当依据用的事 */
function mk() {
  const db = openDb(":memory:");
  const s = new EventStore(db, () => T0, TZ, { peopleTemplate: T, owners: OWNERS });
  s.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "最重要的人" }, "b0");
  s.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei" }, "b0");
  s.upsertEntity({ name: "枫湾之家", kind: "group" }, "b0");
  s.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 1 }, "b0");
  return { db, s, ada: s.entity("ada")!.id, xiaobei: s.entity("小贝")!.id };
}
type SetOpts = { noApproval?: boolean; forcePending?: boolean };
/** 写一个字段：默认带依据 e0001 和 why（extra 可以盖掉） */
const set = (s: EventStore, who: string, section: string, text: string, batch: string, o: SetOpts = {}, extra: Record<string, unknown> = {}) =>
  s.setSection({ who, section, text, sources: EV, why: "测试", ...extra }, batch, o);
/** 整张表的样子（逐列） */
const snap = (db: Db): string => JSON.stringify(all(db, "SELECT * FROM mem_impression ORDER BY id"));
const count = (db: Db): number => all(db, "SELECT id FROM mem_impression").length;
/** n 行互不包含的内容 */
const lines = (n: number, from = 1): string => Array.from({ length: n }, (_, i) => `- 事${from + i}号`).join("\n");
/** n 个字 */
const zi = (n: number, c = "字"): string => c.repeat(n);
/** n 条、每条正好 each 字（互不相同）的列表 */
const items = (n: number, each: number, c = "项"): string => Array.from({ length: n }, (_, i) => `- ${i + 1}${c.repeat(each - String(i + 1).length)}`).join("\n");
const quote = (db: Db, src: string, ref: string, who: string, text: string, at = T0 - DAY): void => {
  db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES (?, ?, ?, ?, 'qq', ?)").run(src, ref, at, who, text);
};
/** 现行的那一行 */
const cur = (s: EventStore, about: string, section: string): ImpressionRow | undefined => s.impressions(about).find((r) => r.kind === "section" && r.section === section);
/** 现行的钉 */
const pinned = (s: EventStore, about: string, section: string): ImpressionRow[] => s.impressions(about).filter((r) => r.kind === "quote" && r.section === section);
/** 一定抛错，错误信息每个都对得上；返回信息 */
function rejects(fn: () => unknown, ...res: RegExp[]): string {
  let msg = "";
  assert.throws(fn, (e: Error) => { msg = e.message; return true; });
  for (const re of res) assert.match(msg, re);
  return msg;
}

test("impression: 模板——字段的顺序、类型、写法；去掉的、私聊版、现算的都不是写的字段；丢行算法", () => {
  assert.deepEqual(T.order, ["关系", "感觉", "我们之间", "是谁", "在乎什么", "喜好", "雷点", "相处", "我们的大事", "梗", "约定和边界", "我的理解", "她私下说的", "对我的感情和期待", "记着的原话", "近况"]);
  assert.deepEqual(T.fields.map((x) => x.name), T.order.slice(0, 13), "「我们的大事」对主人是存着的字段（修订 C），对别人是现算段，order 里只一次");
  assert.deepEqual(T.quotes.map((x) => x.name), ["对我的感情和期待", "记着的原话"]);
  assert.deepEqual([T.computed.bigEvents.name, T.computed.near.name], ["我们的大事", "近况"]);
  assert.deepEqual(fieldSpec(T, "约定和边界"), { name: "约定和边界", type: "设定", shape: "list", maxItems: 5, itemMaxChars: 40, owner: { maxItems: 8, itemMaxChars: 60 }, protect: true });
  assert.deepEqual(fieldSpec(T, "我的理解"), { name: "我的理解", type: "总结", shape: "list", maxItems: 3, itemMaxChars: 40, itemMustContain: "〔推断〕", owner: { maxItems: 5, itemMaxChars: 60 } });
  assert.deepEqual(fieldSpec(T, "她私下说的"), { name: "她私下说的", type: "详情", shape: "list", maxItems: 5, itemMaxChars: 40, private: true });
  assert.deepEqual(fieldSpec(T, "感觉"), { name: "感觉", type: "总结", shape: "text", maxChars: 120, maxSentences: 2, owner: { maxChars: 200, maxSentences: 3 }, protect: true });
  assert.equal(fieldSpec(T, "关系")!.shape, "line");
  for (const n of ["在乎什么（私聊）", "近况", "记着的原话", "身份和怎么认出", "喜好和雷点", "梗和约定", "情绪", "要注意", "群友", "私聊里记着的事", "爱好"]) assert.equal(fieldSpec(T, n), null, n);
  assert.equal(QuotePin.safeParse({ who: "小贝", section: "随便一段", quote: "q1" }).success, true, "原话段名由模板认（store 里查），schema 不写死");
  assert.deepEqual(lostLines("a\n\n  b \nc", "x b y\nc"), { lost: 1, of: 3 }, "空行不算；trim 后在新文里一字不差出现就不算丢");
});

test("template: 配置里的那份能解析，和 A1 的行为一样", () => {
  assert.deepEqual(T, RAW, "解析不改内容");
  const { db, s } = mk();
  const msg = (fn: () => unknown): string => rejects(fn);
  // A1 写死的那份的回话，一字不差
  assert.equal(msg(() => set(s, "小贝", "感觉", zi(121), "b")), "感觉 121 字（上限 120）；往抽象里收，发生过的事记进事件");
  assert.equal(msg(() => set(s, "小贝", "感觉", "一。二。三。", "b")), "感觉 3 句（上限 2 句，按 。！？!? 切）；收成 2 句以内");
  assert.equal(msg(() => set(s, "小贝", "喜好", items(6, 10), "b")), "喜好 满了：写进去是 6 条（上限 5）；合并成更抽象的一条，或者换掉一条");
  assert.equal(msg(() => set(s, "小贝", "喜好", `- 2${zi(40)}`, "b")), "喜好 第 1 条 41 字（上限 40）；写短些，往抽象里收");
  assert.equal(msg(() => set(s, "小贝", "雷点", "怕黑", "b")), "雷点 第 1 行不是「- 」开头：列表一行一条，每行「- 」开头");
  assert.equal(msg(() => set(s, "小贝", "我的理解", "- 她怕孤单", "b")), "我的理解 第 1 条没带「〔推断〕」：每条都要带，写成「- 〔推断〕……」");
  assert.equal(msg(() => set(s, "小贝", "近况", "- x", "b")), "「近况」这一段是从事件库现算的：把事情记成挂着他的事件 / 经过就会出现，不用写");
  assert.equal(msg(() => set(s, "小贝", "记着的原话", "- x", "b")), "「记着的原话」是原话段：用 mem_quote_pin 钉原话层里的原话，不能写");
  assert.equal(msg(() => set(s, "小贝", "在乎什么（私聊）", "- x", "b")), "没有「在乎什么（私聊）」：私密的只有「她私下说的」（名单上、不是主人的人才有），别的字段都是公开的");
  assert.equal(msg(() => set(s, "ada", "她私下说的", "- x", "b")), "「ada」是主人：他的都公开，没有「她私下说的」");
  assert.equal(msg(() => set(s, "枫湾之家", "她私下说的", "- x", "b")), "「枫湾之家」不在名单上（没有 person_key），没有「她私下说的」");
  assert.match(msg(() => s.setSection({ who: "小贝", section: "是谁", text: "x" }, "b")), /^是谁 要写依据：/);
  // 关系：一行、照 pattern；写法不对时回话里有写成什么样、怎么写（hint 里的数字）
  for (const [text, ...res] of [
    ["朋友|更近|叫我姐姐", /关系 写法不对/, /朋友\|更近\|叫我姐姐/, /全角「｜」/],
    ["朋友｜很近｜叫我姐姐", /很近/, /更近 \/ 平稳 \/ 变远/],
    [`${zi(9)}｜更近｜叫我姐姐`, /类型 1–8 字/],
    [`朋友｜更近｜${zi(61)}`, /一句话 1–60 字/],
    ["朋友｜更近｜｜叫我姐姐", /关系 写法不对/],
    ["朋友｜更近｜   ", /关系 写法不对/],
  ] as Array<[string, ...RegExp[]]>) rejects(() => set(s, "小贝", "关系", text, "b"), ...res);
  // A1 先 trim 每一段再数：｜两边的空白不算
  for (const ok of [`朋友 ｜ 更近 ｜ ${zi(60)}`, `${zi(8)}｜变远｜一`, "群｜平稳｜一起长大的"]) assert.equal(set(s, "小贝", "关系", ok, "b").row!.status, "current", ok);
  rejects(() => set(s, "小贝", "关系", ` ${zi(8)} ｜平稳｜${zi(60)} x`, "b"), /写法不对/);
  // 记着的原话满了：配置里的话（米拉的规矩）原样接在后面；小贝不是主人，用 fullHintOthers（R36：访客的不进主人的提案）
  for (let i = 1; i <= 41; i++) quote(db, "central", String(1000 + i), "小贝", `第${i}句`);
  for (let i = 1; i <= 40; i++) s.pinQuote({ who: "小贝", section: "记着的原话", quote: `q${i}` }, "b");
  assert.equal(msg(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q41" }, "b")), "「记着的原话」满了：已经 40 句（上限 40）；不挤掉；回报里只写「小贝 的记着的原话满了」，不写原话");
  // 不认识的原话段（schema 不再拦）：说清有哪些
  rejects(() => s.pinQuote({ who: "小贝", section: "随便一段", quote: "q1" }, "b"), /没有「随便一段」这个原话段/, /对我的感情和期待/, /记着的原话/);
  rejects(() => s.pinQuote({ who: "小贝", section: "是谁", quote: "q1" }, "b"), /「是谁」是字段/, /mem_person_set/);
});

/** 改一份配置里的模板（深拷贝）再解析 */
const variant = (edit: (t: Record<string, any>) => void): PeopleTemplate => {
  const t = structuredClone(RAW) as Record<string, any>;
  edit(t);
  return parseTemplate(t);
};

test("template: 校验——不合格就抛错，信息里有那一项", () => {
  const no = (edit: (t: Record<string, any>) => void, ...res: RegExp[]) => rejects(() => variant(edit), /人物卡模板/, ...res);
  no((t) => { t.fields[1].name = "关系"; }, /重复/, /关系/);
  no((t) => { t.quotes[0].name = "近况"; }, /重复/, /近况/);
  no((t) => { t.order = t.order.filter((x: string) => x !== "喜好"); }, /order/, /喜好/);
  no((t) => { t.order.push("喜好"); }, /order/, /喜好/);
  no((t) => { t.order.push("爱好"); }, /order/, /爱好/);
  no((t) => { t.fields[0].pattern = "([a-z"; }, /关系/, /pattern/);
  no((t) => { delete t.fields[4].maxItems; }, /在乎什么/, /maxItems/);
  no((t) => { delete t.fields[1].maxChars; }, /感觉/, /maxChars/);
  no((t) => { t.fields[1].maxItems = 3; }, /感觉/, /maxItems/);
  no((t) => { t.fields[3].maxChars = 0; }, /是谁/, /maxChars/, /正整数/);
  no((t) => { t.fields[3].maxChars = 1.5; }, /是谁/, /maxChars/);
  no((t) => { t.fields[3].type = "随便"; }, /是谁/, /type/);
  no((t) => { t.fields[3].shape = "table"; }, /是谁/, /shape/);
  no((t) => { t.fields[3].maxChar = 10; }, /是谁/, /maxChar/);
  no((t) => { t.quotes[1].speaker = "anyone"; }, /记着的原话/, /speaker/);
  no((t) => { t.quotes[0].max = -1; }, /对我的感情和期待/, /max/);
  no((t) => { t.computed.near.days = "14"; }, /近况/, /days/);
  no((t) => { delete t.totalCap; }, /totalCap/);
  no((t) => { t.fields[0] = { name: "关系", type: "总结", shape: "line" }; }, /关系/, /pattern|maxChars/);
  rejects(() => parseTemplate(null), /人物卡模板/);
  rejects(() => parseTemplate([]), /人物卡模板/);
  // 合格的变体：照样能用
  const small = variant((t) => { t.fields = t.fields.filter((f: { name: string }) => ["感觉", "是谁"].includes(f.name)); t.quotes = []; t.order = ["是谁", "感觉", "近况", "我们的大事"]; });
  assert.deepEqual(small.order, ["是谁", "感觉", "近况", "我们的大事"]);
});

test("template: describeTemplate 列出每个字段和上限", () => {
  const d = describeTemplate(T);
  for (const f of T.fields) assert.ok(d.includes(`${f.name}（${f.type}）`), f.name);
  for (const s of ["≤120 字、≤2 句", "≤150 字", "≤5 条 ×40 字", "≤3 条 ×40 字", "〔推断〕", "更近 / 平稳 / 变远", "类型 1–8 字", "一句话 1–60 字"]) assert.ok(d.includes(s), s);
  assert.match(d, /她私下说的（详情）[^\n]*私密/, "哪个总是私密");
  assert.ok(!/在乎什么（总结）[^\n]*私密/.test(d));
  assert.match(d, /对我的感情和期待 ≤3 句[^；\n]*自己说的[^；\n]*/);
  assert.match(d, /记着的原话 ≤40 句/);
  assert.ok(d.includes("照 ada 10-29 的规矩不挤掉"), "满了的规矩（fullHint）也说");
  assert.match(d, /我们的大事[^\n]*近况[^\n]*不能写|现算[^\n]*我们的大事[^\n]*近况/);
  assert.match(d, /1500/);
  assert.match(d, /主人[^\n]*4500/);
  assert.match(d, /设定/);
  // 换一份模板，说明跟着变（不是写死的）
  const other = variant((t) => { t.fields[3].maxChars = 99; t.totalCap = 777; });
  assert.ok(describeTemplate(other).includes("≤99 字") && describeTemplate(other).includes("777"));
});

test("owners: 从名单来——主人不能有私密字段、合计上限大、原话默认公开；没有主人时都按非主人算", () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: TZ, peopleTemplate: T });
  m.store.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 1 }, "b0");
  quote(m.store.db, "central", "1", "ada", "第一句");   // q1
  quote(m.store.db, "central", "2", "小贝", "第二句");    // q2
  assert.deepEqual([...m.store.owners], [], "默认没有主人");
  m.syncPeople({ ada: { name: "ada", privacy: "owner" }, xiaobei: { name: "小贝", privacy: "guest" }, _note: { privacy: "owner" } });
  assert.deepEqual([...m.store.owners], ["ada"]);
  rejects(() => set(m.store, "ada", "她私下说的", "- x", "b"), /主人/, /她私下说的/);
  assert.equal(set(m.store, "小贝", "她私下说的", "- x", "b").row!.visibility, "private:xiaobei");
  assert.equal(m.store.pinQuote({ who: "ada", section: "记着的原话", quote: "q1" }, "b").row.visibility, "all", "主人的原话默认公开");
  assert.equal(m.store.pinQuote({ who: "小贝", section: "记着的原话", quote: "q2" }, "b").row.visibility, "private:xiaobei");
  // hh mem sync-people 读的是没过批准底子的名单文件：不改主人（只同步名字、别名、key）
  m.syncPeople({ ada: { name: "ada", privacy: "guest" }, xiaobei: { name: "小贝", privacy: "owner" } }, { owners: false });
  assert.deepEqual([...m.store.owners], ["ada"]);
  // 名单里没有主人：主人只是个普通的人
  m.syncPeople({ ada: { name: "ada", privacy: "guest" }, xiaobei: { name: "小贝" } });
  assert.deepEqual([...m.store.owners], []);
  assert.equal(set(m.store, "ada", "她私下说的", "- 他也能有", "b").row!.visibility, "private:ada");   // 5 字
  // 合计上限：主人用 ownerTotalCap
  m.syncPeople({ ada: { name: "ada", privacy: "owner" } });
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(m.store, "ada", sec, items(5, 40), "b");
  set(m.store, "ada", "是谁", zi(150), "b");
  set(m.store, "ada", "感觉", zi(120), "b");
  assert.ok(set(m.store, "ada", "我的理解", Array.from({ length: 3 }, (_, i) => `- 〔推断〕${i + 1}${zi(35)}`).join("\n"), "b").row, "主人 1595 字能写");
  m.syncPeople({});
  rejects(() => set(m.store, "ada", "关系", "家人｜更近｜我的人", "b"), /合计/, /1500/);
});

test("no template: 不开人物卡——写被拒、导出不写文件、卡和近况是空的，别的照旧", () => {
  const dir = tmpDir("hh-people-");
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: TZ, peopleDir: dir });
  assert.equal(m.store.peopleTemplate, null);
  m.store.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 5, why: "测试" }, "b0");
  m.store.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 4, why: "测试", entities: [{ name: "小贝", kind: "person", role: "with" }] }, "b0");
  quote(m.store.db, "central", "1", "小贝", "第一句");
  rejects(() => set(m.store, "小贝", "是谁", "x", "b"), /人物卡模板没配置/);
  rejects(() => m.store.pinQuote({ who: "小贝", section: "记着的原话", quote: "q1" }, "b"), /人物卡模板没配置/);
  assert.equal(m.exportPeople(), null);
  m.beginNight("n1");
  assert.doesNotThrow(() => m.write("mem_entity_upsert", { name: "Eddy", kind: "person", importance: 2 }));
  m.revertNight();
  assert.equal(m.recoverOpenBatches().length, 0);
  assert.deepEqual(readdirSync(dir), [], "一个文件都不写（near.md 也不写），也不删");
  assert.equal(m.card("小贝", { viewer: "xiaobei" }), "");
  assert.equal(m.near(), "");
  // hhd：没配是 null、不报错；配坏了记错、也是 null（hhd 照常起来）
  const errors: string[] = [];
  assert.equal(templateOr(undefined, (e) => errors.push(e.message)), null);
  assert.equal(errors.length, 0, "没配不算错");
  assert.equal(templateOr({ order: [] }, (e) => errors.push(e.message)), null);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /人物卡模板/);
  assert.deepEqual(templateOr(RAW, (e) => errors.push(e.message)), T);
});

test("framework: people.ts、store.ts 里没有写死 ada（讲历史的注释除外）", () => {
  for (const f of ["people.ts", "store.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "../src/memory/events", f), "utf8").split("\n");
    const hits = src.map((l, i) => [i + 1, l] as const).filter(([, l]) => /ada/i.test(l) && !/^\s*(\/\/|\*|\/\*\*).*ada \d{1,2}-\d{2}/i.test(l));
    assert.deepEqual(hits, [], f);
  }
});

test("impression: 建字段、改了留旧行、清掉、没变不写", () => {
  const { db, s, ada, xiaobei } = mk();
  const r1 = set(s, "ada", "是谁", "a\nb", "b1");
  assert.equal(r1.row!.id, "i0001");
  assert.equal(r1.row!.status, "current");
  assert.equal(r1.row!.visibility, "all");
  assert.equal(r1.row!.kind, "section");
  assert.equal(r1.row!.about, ada);
  assert.equal(r1.pending, false);
  assert.deepEqual(s.impressions(ada).map((r) => r.text), ["a\nb"]);

  const r2 = set(s, "ada", "是谁", "a\nb\nc", "b2", {}, { why: "多知道了一点", sources: ["#12", "e0001"] });
  assert.equal(r2.row!.supersedes, r1.row!.id);
  assert.equal(r2.row!.why, "多知道了一点");
  assert.equal(r2.row!.sources, JSON.stringify(["c:12", "e0001"]), "#N 记成 c:N");
  assert.equal(s.impression(r1.row!.id)!.status, "superseded");
  assert.deepEqual(s.impressions(ada).map((r) => r.id), [r2.row!.id]);
  assert.deepEqual(s.impressions(ada, { status: ["superseded"] }).map((r) => r.id), [r1.row!.id]);

  const n = count(db);
  const r3 = s.setSection({ who: "ada", section: "是谁", text: "a\nb\nc\n" }, "b3");
  assert.equal(r3.unchanged, true, "没变：不要依据");
  assert.equal(r3.row!.id, r2.row!.id);
  assert.equal(count(db), n, "没变不写");

  set(s, "小贝", "她私下说的", "- 这两天在赶作业", "b3");
  const c = set(s, "小贝", "她私下说的", "", "b4");
  assert.equal(c.cleared, true);
  assert.equal(c.row, null);
  assert.equal(c.pending, false, "她私下说的清掉不用批");
  assert.ok(!s.impressions(xiaobei).some((r) => r.section === "她私下说的"), "清掉了就没有现行的");
  assert.equal(s.setSection({ who: "小贝", section: "她私下说的", text: "  " }, "b4").unchanged, true, "本来就没有，清掉也是没变（不要 why）");
});

test("impression: 字段名和私密", () => {
  const { s } = mk();
  rejects(() => set(s, "ada", "爱好", "- x", "b"), /爱好/, /是谁/, /她私下说的/, /我的理解/, /mem_quote_pin/, /现算/);
  rejects(() => set(s, "ada", "记着的原话", "x", "b"), /mem_quote_pin/);
  assert.equal(set(s, "小贝", "她私下说的", "- 她怕被冷落", "b").row!.visibility, "private:xiaobei");
  assert.equal(set(s, "小贝", "在乎什么", "- 家里人", "b").row!.visibility, "all");
  rejects(() => set(s, "ada", "她私下说的", "- x", "b"), /她私下说的/, /ada/);
  rejects(() => set(s, "枫湾之家", "她私下说的", "- x", "b"), /她私下说的/, /名单/);
  assert.equal(set(s, "枫湾之家", "是谁", "ada 家的群", "b").row!.visibility, "all", "群也能有卡");
  s.upsertEntity({ name: "load.py", kind: "thing" }, "b");
  rejects(() => set(s, "load.py", "是谁", "x", "b"), /人和群/);
  rejects(() => set(s, "没这个人", "是谁", "x", "b"), /没有登记过/);
});

test("fixed card: 每种超限各拒一次（信息里有字段名和数字），合计按人算", () => {
  const { s } = mk();
  const no = (who: string, section: string, text: string, ...res: RegExp[]) => rejects(() => set(s, who, section, text, "b"), ...res);
  // 关系：恰好一行「类型｜走向｜一句话」（模板里是 line + pattern：回话说写成了什么、照 hint 怎么写，不再数每一段几个字）
  no("小贝", "关系", "朋友|更近|叫我姐姐", /关系/, /｜/, /朋友\|更近\|叫我姐姐/);
  no("小贝", "关系", "朋友｜更近｜叫我姐姐\n第二行", /关系/, /2 行/);
  no("小贝", "关系", "朋友｜很近｜叫我姐姐", /关系/, /走向/, /更近 \/ 平稳 \/ 变远/, /很近/);
  no("小贝", "关系", `${zi(9)}｜更近｜叫我姐姐`, /关系/, /类型/, new RegExp(`${zi(9)}｜`), /8/);
  no("小贝", "关系", `朋友｜更近｜${zi(61)}`, /关系/, /一句话/, new RegExp(zi(61)), /60/);
  assert.equal(set(s, "小贝", "关系", `朋友｜更近｜${zi(60)}`, "b").row!.status, "current");
  // 感觉：≤2 句、≤120 字
  no("小贝", "感觉", "喜欢她。心疼她！想一直陪着她?", /感觉/, /3 句/, /2/);
  no("小贝", "感觉", zi(121), /感觉/, /121 字/, /120/);
  assert.ok(set(s, "小贝", "感觉", `${zi(59)}。${zi(60)}`, "b").row, "120 字、2 句正好");
  // 是谁：≤150 字
  no("小贝", "是谁", zi(151), /是谁/, /151 字/, /150/);
  // 列表：≤5 条 ×40 字，每行「- 」开头
  no("小贝", "喜好", items(6, 10), /喜好/, /满了/, /6 条/, /5/);
  no("小贝", "喜好", `${items(1, 10)}\n- 2${zi(40)}`, /喜好/, /第 2 条/, /41 字/, /40/);
  no("小贝", "雷点", "怕黑\n- 怕冷", /雷点/, /第 1 行/, /「- 」/);
  assert.ok(set(s, "小贝", "喜好", items(5, 40), "b").row, "5 条 ×40 字正好");
  // 我的理解：≤3 条，每条带〔推断〕
  no("小贝", "我的理解", "- 她其实很怕孤单", /我的理解/, /第 1 条/, /〔推断〕/);
  no("小贝", "我的理解", Array.from({ length: 4 }, (_, i) => `- 〔推断〕第${i + 1}条`).join("\n"), /我的理解/, /4 条/, /3/);
  // 按字算（[...s].length）：40 个表情是 40 字（UTF-16 是 80）
  assert.ok(set(s, "小贝", "梗", `- ${"😀".repeat(40)}`, "b").row);
  no("小贝", "梗", `- ${"😀".repeat(41)}`, /梗/, /41 字/);
  // 她私下说的：只有名单上、不是主人的人有
  no("ada", "她私下说的", "- x", /她私下说的/, /ada/);

  // 合计：小贝 ≤1500，主人 ≤4500（修订 C；「记着的原话」不算，见钉原话的测试）
  const f = mk();
  const fill = (who: string): void => {
    for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(f.s, who, sec, items(5, 40), "b");   // 6 × 200
    set(f.s, who, "是谁", zi(150), "b");
    set(f.s, who, "感觉", zi(120), "b");   // 1470
  };
  const think = Array.from({ length: 3 }, (_, i) => `- 〔推断〕${i + 1}${zi(35)}`).join("\n");   // 3 × 40
  fill("小贝");
  const msg = rejects(() => set(f.s, "小贝", "我的理解", think, "b"), /合计/, /1590 字/, /1500/);
  assert.match(msg, /是谁 150/, "说清大的是哪几个字段");
  assert.equal(cur(f.s, f.xiaobei, "我的理解"), undefined, "超了不写");
  // 主人用主人的上限（列表 8 条 ×60、是谁 300、感觉 200、我的理解 5 条 ×60，还有「我们之间」）
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(f.s, "ada", sec, items(8, 60), "b");   // 6 × 480
  set(f.s, "ada", "是谁", zi(300), "b");
  set(f.s, "ada", "感觉", zi(200), "b");   // 3380
  assert.ok(set(f.s, "ada", "我的理解", Array.from({ length: 5 }, (_, i) => `- 〔推断〕${i + 1}${zi(55)}`).join("\n"), "b").row, "ada 3680 字能写");
  assert.ok(set(f.s, "ada", "我们之间", zi(400), "b").row, "4080 字");
  assert.ok(set(f.s, "ada", "关系", `家人｜更近｜${zi(60)}`, "b").row, "4146 字");
  quote(f.db, "central", "501", "ada", zi(81, "甲"));   // q1
  quote(f.db, "central", "502", "ada", zi(81, "乙"));   // q2
  quote(f.db, "central", "503", "ada", zi(82, "丙"));   // q3
  quote(f.db, "central", "504", "ada", zi(192, "丁"));  // q4
  const p1 = f.s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q1" }, "b");
  f.s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q2" }, "b");
  assert.equal(f.s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q3" }, "b").existed, false, "ada 4390 字能写进去");
  rejects(() => f.s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q4", replaces: p1.row.id }, "b"), /合计/, /钉进去以后 4501 字/, /4500/);
  assert.equal(f.s.impression(p1.row.id)!.status, "current", "超了不换");

  // 已经超了的卡（两个人并成一个）：往小里改照样能写，往大里改不行
  f.s.upsertEntity({ name: "阿砚", kind: "person" }, "b");
  f.s.upsertEntity({ name: "砚", kind: "person" }, "b");
  for (const sec of ["在乎什么", "喜好", "雷点", "相处"]) set(f.s, "阿砚", sec, items(5, 40), "b");   // 800
  for (const sec of ["梗", "约定和边界", "是谁", "感觉"]) set(f.s, "砚", sec, sec === "是谁" ? zi(150) : sec === "感觉" ? zi(120) : items(5, 40), "b");   // 670
  set(f.s, "砚", "关系", `朋友｜平稳｜${zi(60)}`, "b");   // 66
  const gua = f.s.mergeEntities("砚", ["阿砚"], "同一个人", "b");   // 1536 > 1500
  rejects(() => set(f.s, "砚", "我的理解", "- 〔推断〕他", "b"), /合计/, /1541 字/, /1500/);
  assert.ok(set(f.s, "砚", "相处", items(5, 40, "换"), "b").row, "一样大：能写");
  assert.ok(set(f.s, "砚", "相处", items(4, 40), "b").row, "1496：往小里改能写");
  assert.equal(cur(f.s, gua.id, "相处")!.text, items(4, 40));
});

test("fixed card: 依据——sources 里至少一个库里有的事件 / 经过 / 原话编号", () => {
  const { db, s } = mk();
  s.addEntry({ event: "e0001", at: T0 - DAY, full: "依据的经过", gist: "依据", title: "依据" }, "b0");   // n00001
  quote(db, "honcho", "h1", "ada", "随口说的");      // q1
  quote(db, "central", "77", "ada", "第七十七句");    // q2：中央记忆 77
  let n = 0;
  const w = (sources: string[]) => s.setSection({ who: "ada", section: "是谁", text: `第${++n}版`, sources }, "b");
  rejects(() => w([]), /是谁/, /依据/, /e0012/, /n00012/, /q123/, /#123/);
  rejects(() => w(["ada#3"]), /依据/, /不是这几种编号[^；]*ada#3/);
  assert.equal(w(["e0001"]).row!.status, "current");
  rejects(() => w(["e9999"]), /依据/, /库里没有：e9999/);
  rejects(() => w(["e9999", "E0001", "#78"]), /库里没有：e9999、#78/, /不是这几种编号[^；]*E0001/);
  for (const ok of [["n00001"], ["q1"], ["#77"], ["c:77"], ["ada#3", "q2"]]) assert.equal(w(ok).row!.status, "current", ok.join());
  for (const bad of [["n99999"], ["q99"], ["#78"], ["c:78"], ["e1"], ["E0001"]]) rejects(() => w(bad), /依据/);
  // 清掉一个字段不要依据，但要 why
  set(s, "小贝", "她私下说的", "- 说过的", "b");
  rejects(() => s.setSection({ who: "小贝", section: "她私下说的", text: "" }, "b"), /她私下说的/, /why/);
  assert.equal(s.setSection({ who: "小贝", section: "她私下说的", text: "", why: "她说不用记了" }, "b").cleared, true);
});

test("fixed card: 「（私聊）」和现算段不能写", () => {
  const { s } = mk();
  rejects(() => set(s, "小贝", "在乎什么（私聊）", "- 怕被冷落", "b"), /在乎什么（私聊）/, /私密的只有「她私下说的」/);
  for (const sec of ["近况", "我们的大事"]) rejects(() => set(s, "小贝", sec, "- 在赶作业", "b"), new RegExp(sec), /现算/, /挂着他的事件 \/ 经过/);
  rejects(() => set(s, "ada", "近况", "- 在赶作业", "b"), /近况/, /现算/);   // 主人的「我们的大事」是存着的（修订 C），近况照旧现算
});

test("fixed card: 约定和边界改了要批、forcePending", () => {
  const { s, ada, xiaobei } = mk();
  const a = set(s, "小贝", "约定和边界", "- 不在群里提她的考试", "b1");
  assert.equal(a.pending, false, "新建不用批");
  const b = set(s, "小贝", "约定和边界", "- 不在群里提她的考试\n- 十二点以后不找她", "b2");
  assert.equal(b.pending, true, "改现行的约定和边界一律等批（只加一条也是）");
  assert.equal(cur(s, xiaobei, "约定和边界")!.id, a.row!.id, "现行的不变");
  assert.equal(set(s, "小贝", "约定和边界", "", "b3").pending, true, "清掉也等批");
  assert.equal(set(s, "小贝", "约定和边界", "- 换成导入的", "import:xiaobei", { noApproval: true }).pending, false, "导入（noApproval）直接写");

  // forcePending：新建也是待批（迁移时主人、小贝的第一版卡）
  const f = set(s, "ada", "是谁", "我的人", "import:ada", { forcePending: true });
  assert.deepEqual([f.pending, f.row!.status, f.row!.supersedes], [true, "pending", null]);
  assert.equal(cur(s, ada, "是谁"), undefined, "批之前没有现行的");
  assert.equal(set(s, "ada", "是谁", "我的人", "import:ada", { forcePending: true }).unchanged, true, "一样的待批不重复提");
  assert.equal(set(s, "ada", "感觉", "很依赖他", "import:ada", { noApproval: true, forcePending: true }).pending, true, "两个都给：forcePending 赢");
  assert.equal(set(s, "小贝", "她私下说的", "- 私下说的", "import:xiaobei", { forcePending: true }).pending, false, "私密字段 forcePending 也不等批（R24，见下一条测试）");
  const ok = s.approveImpression(f.row!.id, "approve:1");
  assert.equal(ok.status, "current", "supersedes 为空的待批：批了直接上");
  assert.equal(cur(s, ada, "是谁")!.text, "我的人");

  // 待批的也算进合计：整张卡写成待批，批完也不会超
  s.upsertEntity({ name: "砚", kind: "person", person_key: "gua" }, "b0");
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(s, "砚", sec, items(5, 40), "import:gua", { forcePending: true });
  set(s, "砚", "是谁", zi(150), "import:gua", { forcePending: true });
  set(s, "砚", "感觉", zi(120), "import:gua", { forcePending: true });
  rejects(() => set(s, "砚", "我的理解", Array.from({ length: 3 }, (_, i) => `- 〔推断〕${i + 1}${zi(35)}`).join("\n"), "import:gua", { forcePending: true }), /合计/, /1590 字/, /1500/);
});

test("fixed card: forcePending 的第一版还在等批时，再写这个字段也等批（绕不过 ada）", () => {
  const { s, ada } = mk();
  const first = set(s, "ada", "约定和边界", "- 不在群里提他的考试", "import:ada", { forcePending: true });
  const night = set(s, "ada", "约定和边界", "- 不在群里提他的考试\n- 晚上不吵他", "n1");
  assert.deepEqual([night.pending, night.row!.status, night.row!.supersedes], [true, "pending", null], "没有现行的也等批");
  assert.equal(cur(s, ada, "约定和边界"), undefined, "没有绕过 ada 直接上");
  assert.deepEqual([s.impression(first.row!.id)!.status, s.impression(first.row!.id)!.why], ["rejected", "被新的待批取代"]);
  set(s, "ada", "是谁", "我的人", "import:ada", { forcePending: true });
  const imp = set(s, "ada", "是谁", "我的人，学 CS", "import:again", { noApproval: true });
  assert.equal(imp.pending, true, "noApproval 也绕不过去");
  assert.deepEqual(s.pendingImpressions().filter((r) => r.about === ada).map((r) => `${r.section}/${r.text}`), ["约定和边界/- 不在群里提他的考试\n- 晚上不吵他", "是谁/我的人，学 CS"]);
  // 批了：现行的上去，以后照平常的规矩
  assert.equal(s.approveImpression(night.row!.id, "approve:1").status, "current", "不会因为夜里又写了一次变成过时的");
  assert.equal(s.approveImpression(imp.row!.id, "approve:1").status, "current");
  assert.equal(set(s, "ada", "是谁", "我的人，学 CS，在枫湾", "n2").pending, false, "总结字段小改直接上");
  assert.equal(set(s, "ada", "约定和边界", "- 晚上不吵他", "n2").pending, true, "约定和边界改了要批");
});

test("fixed card: 钉原话的上限和换", () => {
  const { db, s, xiaobei } = mk();
  for (let i = 1; i <= 5; i++) quote(db, "central", String(300 + i), "小贝", `第${i}句：${zi(8)}`);   // q1–q5，每句 12 字
  const feel = (q: string, extra: Record<string, unknown> = {}) => s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: q, ...extra }, "b");
  const p = ["q1", "q2", "q3"].map((q) => feel(q).row);
  const full = rejects(() => feel("q4"), /对我的感情和期待/, /满了/, /3 句/, /replaces/, /原话层/);
  assert.ok(p.every((r) => full.includes(r.id)), "列出现在钉着的编号，好挑一句换");
  rejects(() => feel("q4", { replaces: "i9999" }), /replaces/, /i9999/);
  rejects(() => feel("q4", { replaces: "q1" }), /replaces/);
  const r = feel("q4", { replaces: p[0]!.id });
  assert.equal(r.replaced!.id, p[0]!.id);
  assert.equal(r.row.supersedes, p[0]!.id);
  assert.equal(s.impression(p[0]!.id)!.status, "superseded");
  assert.equal(pinned(s, xiaobei, "对我的感情和期待").length, 3, "换了还是 3 句");
  assert.equal(all(db, "SELECT id FROM mem_quote WHERE id = 1").length, 1, "换下来的那句还在原话层");
  // 换回来：同一句只有一行，原来那行重新现行
  const back = feel("q1", { replaces: r.row.id });
  assert.deepEqual([back.row.id, back.row.status, back.existed], [p[0]!.id, "current", false]);
  assert.equal(s.impression(r.row.id)!.status, "superseded");
  assert.equal(feel("q2").existed, true, "钉着的再钉：已经有了（满了也不报错）");
  rejects(() => feel("q2", { replaces: p[2]!.id }), /q2 已经钉/, /什么都没换/, new RegExp(`${p[2]!.id} 还钉着`));
  assert.equal(s.impression(p[2]!.id)!.status, "current", "要换的那句没动");
  rejects(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q5", replaces: p[1]!.id }, "b"), /记着的原话/, /只加不删/, /；不挤掉；回报里只写「小贝 的记着的原话满了」，不写原话$/);

  // 记着的原话：40 句为止，不挤掉；不算进合计
  for (let i = 1; i <= 41; i++) quote(db, "central", String(1000 + i), "小贝", `记着的第${i}句${zi(100, "长")}`);   // q6–q46
  for (let i = 6; i <= 45; i++) s.pinQuote({ who: "小贝", section: "记着的原话", quote: `q${i}` }, "b");
  rejects(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q46" }, "b"), /记着的原话/, /满了/, /40 句/, /小贝 的记着的原话满了/);
  assert.equal(pinned(s, xiaobei, "记着的原话").length, 40);
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(s, "小贝", sec, items(5, 40), "b");
  assert.ok(set(s, "小贝", "是谁", zi(150), "b").row, "40 句 ×100 多字不算：1350 + 感情和期待 36 = 1386");
  // 钉进去以后合计超了也拒
  quote(db, "central", "2001", "小贝", zi(130, "长"));   // q47
  rejects(() => feel("q47", { replaces: p[1]!.id }), /合计/, /钉进去以后 1504 字/, /1500/);
  assert.equal(feel("q47", { replaces: p[1]!.id, text: zi(126, "长") }).row.text, zi(126, "长"), "只钉一段：1500 正好");
});

test("impression: 大改等人批", () => {
  const { s, ada, xiaobei } = mk();
  const old = lines(12);
  const keep = (n: number) => old.split("\n").slice(0, n).join("\n");
  set(s, "ada", "是谁", old, "b0");
  set(s, "ada", "感觉", old, "b0");
  set(s, "ada", "在乎什么", lines(5), "b0");

  const small = set(s, "ada", "是谁", `${keep(8)}\n- 新的一行`, "n1");
  assert.deepEqual([small.pending, small.lost, small.of], [false, 4, 12], "丢 4 行（不到 5 行）不等批");
  assert.equal(small.row!.status, "current");

  const curBefore = cur(s, ada, "感觉")!;
  const big = set(s, "ada", "感觉", keep(6), "n2", {}, { why: "压一压" });
  assert.deepEqual([big.pending, big.lost, big.of], [true, 6, 12]);
  assert.equal(big.row!.status, "pending");
  assert.equal(big.row!.supersedes, curBefore.id);
  assert.equal(cur(s, ada, "感觉")!.id, curBefore.id, "现行的不变");
  assert.deepEqual(s.pendingImpressions().map((r) => r.id), [big.row!.id]);
  assert.deepEqual((({ pending, lost, of }) => [pending, lost, of])(set(s, "ada", "在乎什么", lines(5, 20), "n2")), [true, 5, 5], "列表 5 条全换掉也是大改");

  // 总结字段清掉也是大改
  const clear = set(s, "ada", "是谁", "", "n2");
  assert.equal(clear.pending, true);
  assert.equal(clear.cleared, false);
  assert.ok(cur(s, ada, "是谁"));

  // 一个人 4 个总结字段，同一批改到第 3 个
  for (const [sec, text] of [["是谁", "a"], ["感觉", "a"], ["在乎什么", "- a"], ["相处", "- a"]] as const) set(s, "小贝", sec, text, "b0");
  assert.equal(set(s, "小贝", "是谁", "a\nb", "n3").pending, false);
  assert.equal(set(s, "小贝", "在乎什么", "- a\n- b", "n3").pending, false);
  const third = set(s, "小贝", "感觉", "a\nb", "n3");
  assert.equal(third.pending, true, "第 3 个：改过的超过一半");
  assert.equal(set(s, "小贝", "相处", "- a\n- b", "n4").pending, false, "换一批重新算");
  assert.equal(set(s, "小贝", "喜好", "- 喜欢花", "n3").pending, false, "新建一个字段不等批");

  // 她私下说的丢多少都不等批
  set(s, "小贝", "她私下说的", lines(5), "b0");
  assert.equal(set(s, "小贝", "她私下说的", "- 只剩一行", "n5").pending, false);
  assert.equal(set(s, "小贝", "她私下说的", "", "n5").cleared, true);

  // 导入不等批
  set(s, "ada", "梗", lines(5), "b0");
  const imp = set(s, "ada", "梗", "- 全新的", "import:ada", { noApproval: true });
  assert.equal(imp.pending, false);
  assert.equal(imp.row!.text, "- 全新的");

  // 批准：待批的变现行，原来的变 superseded
  const ok = s.approveImpression(big.row!.id, "approve:1");
  assert.equal(ok.status, "current");
  assert.equal(s.impression(curBefore.id)!.status, "superseded");
  assert.equal(cur(s, ada, "感觉")!.text, keep(6));
  assert.throws(() => s.approveImpression(big.row!.id, "approve:2"), /不是待批/);

  // 批准清掉：这个字段没了
  s.approveImpression(clear.row!.id, "approve:3");
  assert.equal(cur(s, ada, "是谁"), undefined);

  // 驳回：现行的不变
  const emo = cur(s, xiaobei, "感觉")!;
  const no = s.rejectImpression(third.row!.id, "说得太满", "approve:4");
  assert.equal(no.status, "rejected");
  assert.equal(no.why, "说得太满");
  assert.equal(cur(s, xiaobei, "感觉")!.id, emo.id);

  // 同一个字段再来一个待批：前一个被取代
  set(s, "ada", "是谁", old, "b0");
  const p1 = set(s, "ada", "是谁", keep(1), "n6");
  const again = set(s, "ada", "是谁", keep(1), "n6");
  assert.equal(again.row!.id, p1.row!.id, "一样的待批不重复提");
  const p2 = set(s, "ada", "是谁", keep(2), "n7");
  assert.equal(p2.pending, true);
  assert.equal(s.impression(p1.row!.id)!.status, "rejected");
  assert.equal(s.impression(p1.row!.id)!.why, "被新的待批取代");
  assert.deepEqual(s.pendingImpressions().filter((r) => r.about === ada && r.section === "是谁").map((r) => r.id), [p2.row!.id]);

  // 待批之后这个字段又被直接改过：那个待批自动驳回（Task 1 留下的，Task 3 修）；再提一样的就是新的待批
  const edited = set(s, "ada", "是谁", `${old}\n- 加一行`, "n8");
  assert.deepEqual([s.impression(p2.row!.id)!.status, s.impression(p2.row!.id)!.why], ["rejected", "被直接改过了"]);
  assert.throws(() => s.approveImpression(p2.row!.id, "approve:5"), /不是待批/);
  const p3 = set(s, "ada", "是谁", keep(2), "n9");
  assert.deepEqual([p3.unchanged, p3.row!.supersedes], [false, edited.row!.id]);
});

test("impression: 直接改一个字段，这个字段上开着的待批自动驳回（被直接改过了），同一个事务；撤回一起回来", () => {
  const { db, s } = mk();
  set(s, "小贝", "是谁", lines(5), "b0");
  const p = set(s, "小贝", "是谁", "- 事9号", "n1");   // 丢 5/5 行：等批
  assert.equal(p.pending, true);
  assert.deepEqual(p.rejected, []);
  const before = snap(db);
  const d = set(s, "小贝", "是谁", `${lines(5)}\n- 再加一行`, "n2");   // 一行没丢：直接上
  assert.equal(d.pending, false);
  assert.deepEqual(d.rejected, [p.row!.id], "返回驳回了哪几个");
  assert.deepEqual([s.impression(p.row!.id)!.status, s.impression(p.row!.id)!.why], ["rejected", "被直接改过了"]);
  assert.ok(s.ops("n2").some((o) => o.op === "impression_reject"), "和直接改的那一下同一批");
  assert.deepEqual(s.pendingImpressions(), [], "队列里不留批不了的");
  assert.deepEqual(s.revertBatch("n2").conflicts, []);
  assert.equal(snap(db), before, "撤回：待批的、原来现行的都回来");
  // 写不进去（超了）：待批的不动
  rejects(() => set(s, "小贝", "是谁", zi(151), "n3"), /151 字/);
  assert.equal(s.impression(p.row!.id)!.status, "pending");
  // 导入（noApproval）直接写、清掉也一样
  assert.deepEqual(set(s, "小贝", "是谁", "导入的", "import:xiaobei", { noApproval: true }).rejected, [p.row!.id]);
  set(s, "小贝", "约定和边界", "- 一", "b0");
  const q = set(s, "小贝", "约定和边界", "- 二", "n4");
  assert.equal(q.pending, true);
  const cl = set(s, "小贝", "约定和边界", "", "import:x", { noApproval: true });
  assert.deepEqual([cl.cleared, cl.rejected], [true, [q.row!.id]]);
  assert.equal(s.impression(q.row!.id)!.why, "被直接改过了");
  // 新的待批顶掉旧的待批：也在 rejected 里
  set(s, "小贝", "约定和边界", "- 三", "b0");
  const r1 = set(s, "小贝", "约定和边界", "- 四", "n5");
  assert.deepEqual(set(s, "小贝", "约定和边界", "- 五", "n5").rejected, [r1.row!.id]);
});

test("impression: 私密字段永远不等批——forcePending、第一版等批都不管，直接现行（R24：批的人不该看到访客私聊）", () => {
  const { s, xiaobei } = mk();
  // 迁移时小贝整张卡 forcePending：别的字段等批，她私下说的直接写成现行的
  const pub = set(s, "小贝", "是谁", "ada 的朋友", "import:xiaobei", { forcePending: true });
  const sec = set(s, "小贝", "她私下说的", "- 她说考试很紧张", "import:xiaobei", { forcePending: true });
  assert.deepEqual([pub.pending, pub.row!.status], [true, "pending"]);
  assert.deepEqual([sec.pending, sec.because, sec.row!.status, sec.row!.visibility], [false, null, "current", "private:xiaobei"]);
  assert.ok(!s.pendingImpressions().some((r) => r.visibility !== "all"), "待批里没有私密的");
  assert.equal(set(s, "小贝", "她私下说的", "- 换了", "import:xiaobei", { noApproval: true, forcePending: true }).row!.status, "current", "两个都给也不等批");
  // 以前留下的私密待批（第一版、没有现行的）：再写直接上，那个待批驳回（被直接改过了），不再堵着
  s.upsertEntity({ name: "砚", kind: "person", person_key: "gua" }, "b0");
  const gua = s.entity("砚")!.id;
  const old = set(s, "砚", "是谁", "小贝的朋友", "import:gua", { forcePending: true }).row!.id;
  s.db.prepare("UPDATE mem_impression SET section = '她私下说的', text = '- 旧的', visibility = 'private:gua' WHERE id = ?").run(old);
  const w = set(s, "砚", "她私下说的", "- 新的", "n1");
  assert.deepEqual([w.pending, w.row!.status, w.rejected], [false, "current", [old]]);
  assert.equal(s.impression(old)!.why, "被直接改过了");
  assert.equal(s.impressions(gua).filter((r) => r.section === "她私下说的").length, 1);
  assert.ok(s.impressions(xiaobei).some((r) => r.section === "她私下说的" && r.text === "- 换了"));
});

test("export: mem_person_set、mem_quote_pin 经 mem.write 写了就重写 ledger/people/<key>.md（EXPORT_AFTER）", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  quote(mem.store.db, "central", "901", "小贝", "谢谢姐姐一直陪我");   // q1
  mem.beginNight("n1");
  assert.match(mem.write("mem_person_set", { who: "小贝", section: "是谁", text: "ada 的朋友", sources: EV, why: "测试" }, "hippocampus"), /^改好了/);
  assert.ok(readFileSync(join(dir, "xiaobei.md"), "utf8").includes("## 是谁\nada 的朋友"), "写字段：当场导出");
  mem.write("mem_quote_pin", { who: "小贝", section: "对我的感情和期待", quote: "q1", private: false }, "hippocampus");
  assert.ok(readFileSync(join(dir, "xiaobei.md"), "utf8").includes("「谢谢姐姐一直陪我」"), "钉原话：当场导出");
  mem.write("mem_person_set", { who: "小贝", section: "是谁", text: "ada 的朋友，叫我姐姐", sources: EV, why: "测试" }, "hippocampus");
  assert.ok(readFileSync(join(dir, "xiaobei.md"), "utf8").includes("ada 的朋友，叫我姐姐"));
  mem.revertNight();
  assert.ok(!existsSync(join(dir, "xiaobei.md")), "撤回后卡也没了");
});

test("impression: 删人——有任何印象行（现行、待批、换下来的、驳回的）都拒；不然先删人再撤回，字段会复活到删掉的人身上", () => {
  const { s } = mk();
  s.upsertEntity({ name: "Max", kind: "person" }, "b0");
  set(s, "Max", "是谁", "同学", "b1");
  set(s, "Max", "是谁", "", "b2", { noApproval: true });   // 只剩一行 superseded
  assert.equal(s.impressions(s.entity("Max")!.id).length, 0, "没有现行的了");
  rejects(() => s.dropEntity("Max", "登记错了", "b3"), /「Max」/, /人物卡/, /1 行/, /驳回的/, /mem_entity_merge/);
  assert.ok(s.entity("Max"), "没动");
  s.upsertEntity({ name: "Amy", kind: "person" }, "b0");
  set(s, "Amy", "是谁", "同学", "import:amy", { forcePending: true });   // 只有待批的第一版
  rejects(() => s.dropEntity("Amy", "登记错了", "b3"), /「Amy」/, /人物卡/);
  s.rejectImpression(s.pendingImpressions()[0]!.id, "不对", "b3");
  rejects(() => s.dropEntity("Amy", "登记错了", "b3"), /人物卡/);   // 驳回的也算
  s.upsertEntity({ name: "Bob", kind: "person" }, "b0");
  s.dropEntity("Bob", "登记错了", "b3");
  assert.equal(s.entity("Bob"), undefined, "没有印象的照常去掉");
});

test("template: describeTemplate 照卡里的顺序列（字段、原话段、现算段混排）；清掉总结字段也等批；only quotes 只讲原话段", () => {
  const order = (d: string): string[] => d.split("\n").filter((l) => l.startsWith("- ")).map((l) => T.order.find((n) => l.startsWith(`- ${n}`)) ?? l);
  assert.deepEqual(order(describeTemplate(T)), T.order);
  // 换一个顺序：原话段放最前、现算段放中间
  const moved = variant((t) => { t.order = ["记着的原话", "对我的感情和期待", "关系", "近况", ...t.order.filter((x: string) => !["记着的原话", "对我的感情和期待", "关系", "近况"].includes(x))]; });
  assert.deepEqual(order(describeTemplate(moved)), moved.order);
  const d = describeTemplate(T);
  assert.match(d, /总结 = [^\n]*清掉[^\n]*等人批/, "清掉一个总结字段也会待批");
  assert.match(d, /设定 = [^\n]*清掉/);
  assert.match(d, /- 近况（现算，不能写）/);
  assert.match(d, /新建字段不用批（除非这个字段的第一版还在等批：再写也等批）/);
  const q = describeTemplate(T, { only: "quotes" });
  for (const x of ["对我的感情和期待 ≤3 句", "记着的原话 ≤40 句", "照 ada 10-29 的规矩不挤掉", "1500", "replaces"]) assert.ok(q.includes(x), x);
  for (const x of ["喜好（总结）", "近况", "我们的大事"]) assert.ok(!q.includes(x), x);
  assert.deepEqual(order(q), ["对我的感情和期待", "记着的原话"]);
  assert.match(describeTemplate(variant((t) => { t.quotes = []; t.order = t.order.filter((x: string) => !["对我的感情和期待", "记着的原话"].includes(x)); }), { only: "quotes" }), /没有原话段/);
});

test("template: 有 pattern 就要 patternHint；名字前后有空白就拒（写的时候会 trim，带空白的字段永远写不进）", () => {
  const no = (edit: (t: Record<string, any>) => void, ...res: RegExp[]) => rejects(() => variant(edit), /人物卡模板/, ...res);
  no((t) => { delete t.fields[0].patternHint; }, /关系/, /patternHint/);
  no((t) => { t.fields[3].name = " 是谁"; t.order[3] = " 是谁"; }, /是谁/, /空白/);
  no((t) => { t.quotes[1].name = "记着的原话 "; t.order[14] = "记着的原话 "; }, /记着的原话/, /空白/);
  no((t) => { t.computed.near.name = "近况\t"; t.order[15] = "近况\t"; }, /近况/, /空白/);
  assert.ok(variant((t) => { delete t.fields[0].pattern; delete t.fields[0].patternHint; t.fields[0].maxChars = 60; }), "没有 pattern 就不要 patternHint");
});

test("impression: 钉原话", () => {
  const { db, s, ada } = mk();
  quote(db, "honcho", "h1", "ada", "你有自己的性格和人格，记忆，能力等，把自己当人就行");   // q1
  quote(db, "central", "77", "小贝", "姐姐晚安，明天见");                                    // q2
  quote(db, "central", "78", "我→ada", "我会一直记着的", T0);                              // q3
  quote(db, "central", "79", "ada", "第一句\n  第二句");                                   // q4

  const p = s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q1", text: "把自己当人就行", why: "他第一次这么说" }, "n1");
  assert.equal(p.existed, false);
  assert.equal(p.replaced, null);
  assert.deepEqual([p.row.kind, p.row.quote_id, p.row.text, p.row.visibility, p.row.status, p.row.section, p.row.about],
    ["quote", 1, "把自己当人就行", "all", "current", "对我的感情和期待", ada]);

  const c = s.pinQuote({ who: "小贝", section: "记着的原话", quote: "#77" }, "n1");
  assert.equal(c.row.quote_id, 2, "#77 是中央记忆 77 那句");
  assert.equal(c.row.text, "姐姐晚安，明天见", "不写 text 就钉整句");
  assert.equal(c.row.visibility, "private:xiaobei", "名单上非 ada 的人默认私聊");
  assert.equal(s.pinQuote({ who: "小贝", section: "记着的原话", quote: "c:77" }, "n1").existed, true);
  assert.equal(s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q2", private: false }, "n1").row.visibility, "all");

  assert.throws(() => s.pinQuote({ who: "ada", section: "记着的原话", quote: "q1", text: "把自己当机器" }, "n1"), /原话/);
  assert.throws(() => s.pinQuote({ who: "ada", section: "记着的原话", quote: "q999" }, "n1"), /q999/);
  assert.throws(() => s.pinQuote({ who: "ada", section: "记着的原话", quote: "#999" }, "n1"), /#999/);
  assert.throws(() => s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q2" }, "n1"), /小贝/, "别人说的钉不到他的感情和期待");
  assert.throws(() => s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q3" }, "n1"), /自己说的/, "我说的也不行");
  assert.throws(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q3" }, "n1"), /我→小贝|说给/, "我说给 ada 的不是说给小贝的");
  assert.throws(() => s.pinQuote({ who: "ada", section: "记着的原话", quote: "q1", private: true }, "n1"), /私聊/);

  const mine = s.pinQuote({ who: "ada", section: "记着的原话", quote: "q3", why: "答应过他" }, "n1");
  assert.equal(mine.existed, false, "我说给他的能进记着的原话");
  const dup = s.pinQuote({ who: "ada", section: "记着的原话", quote: "q3" }, "n2");
  assert.deepEqual([dup.existed, dup.row.id], [true, mine.row.id]);

  assert.equal(s.pinQuote({ who: "ada", section: "记着的原话", quote: "q4", text: "第一句 第二句" }, "n1").row.text, "第一句 第二句", "空白归一后比");
});

test("impression: 撤回", () => {
  const { db, s, xiaobei } = mk();
  quote(db, "central", "77", "小贝", "姐姐晚安，明天见");   // q1
  quote(db, "central", "78", "小贝", "谢谢姐姐");           // q2
  set(s, "ada", "是谁", "a\nb", "b1");
  set(s, "ada", "感觉", lines(12), "b1");
  const p = set(s, "ada", "感觉", lines(2), "b2");
  assert.equal(p.pending, true);
  const pin = s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q1" }, "b2");
  const before = snap(db);

  set(s, "ada", "是谁", "a\nb\nc", "night");
  set(s, "ada", "是谁", "a\nb\nc\nd", "night");
  set(s, "小贝", "她私下说的", "- 在赶作业", "night");
  set(s, "小贝", "是谁", "ada 的朋友", "night");
  s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q1" }, "night");
  s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q2", replaces: pin.row.id }, "night");
  s.approveImpression(p.row!.id, "night");
  assert.notEqual(snap(db), before);

  const r = s.revertBatch("night");
  assert.deepEqual(r.conflicts, []);
  assert.equal(snap(db), before, "整张表回到这一批之前（换下来的钉也回来）");

  // 被别的批次的行 supersedes 指着：撤回建它的那批时列成冲突，不动
  const a = set(s, "小贝", "是谁", lines(12), "c1");
  const pend = set(s, "小贝", "是谁", lines(1), "c2");
  assert.equal(pend.row!.supersedes, a.row!.id);
  const rc = s.revertBatch("c1");
  assert.ok(rc.conflicts.some((x) => x.includes(a.row!.id) && /别的批次还在用它/.test(x)), rc.conflicts.join("\n"));
  assert.equal(cur(s, xiaobei, "是谁")!.id, a.row!.id);

  // 撤回会让一个字段有两行现行的：列成冲突，后来建的那行不被悄悄删掉
  const n1 = set(s, "小贝", "她私下说的", "- 考完试了", "d1");
  set(s, "小贝", "她私下说的", "", "d2");
  const n3 = set(s, "小贝", "她私下说的", "- 放假了", "d3");
  const rd = s.revertBatch("d2");
  assert.ok(rd.conflicts.some((x) => x.includes(n1.row!.id) && x.includes(n3.row!.id)), rd.conflicts.join("\n"));
  assert.equal(s.impression(n3.row!.id)!.status, "current");
  assert.equal(s.impression(n1.row!.id)!.status, "superseded");
});

test("impression: 合并和删人", () => {
  const { db, s } = mk();
  s.upsertEntity({ name: "姑妈", kind: "person" }, "b0");
  s.upsertEntity({ name: "柚子茶茶", kind: "person" }, "b0");
  set(s, "姑妈", "是谁", "ada 的妈妈", "b0");
  set(s, "柚子茶茶", "喜好", "- 喜欢花", "b0");
  quote(db, "central", "90", "青青", "今天的花开得真好");   // q1
  quote(db, "central", "91", "柚子茶茶", "谢谢你");          // q2
  // 同一句两边各钉过一次（那时「青青」还是姑妈的别名）
  s.upsertEntity({ name: "姑妈", aliases: ["青青"] }, "b0");
  s.pinQuote({ who: "姑妈", section: "记着的原话", quote: "q1" }, "b0");
  s.upsertEntity({ name: "姑妈", remove_aliases: ["青青"] }, "b0");
  s.upsertEntity({ name: "柚子茶茶", aliases: ["青青"] }, "b0");
  s.pinQuote({ who: "柚子茶茶", section: "记着的原话", quote: "q1" }, "b0");
  s.pinQuote({ who: "柚子茶茶", section: "对我的感情和期待", quote: "q2" }, "b0");
  const before = snap(db);

  const kept = s.mergeEntities("姑妈", ["柚子茶茶"], "小红书的柚子茶茶就是姑妈", "tidy");
  const now = s.impressions(kept.id);
  assert.deepEqual(now.filter((r) => r.kind === "section").map((r) => r.section).sort(), ["喜好", "是谁"]);
  assert.deepEqual(now.filter((r) => r.kind === "quote").map((r) => `${r.section}/${r.quote_id}`).sort(), ["对我的感情和期待/2", "记着的原话/1"], "同一句只剩一行");
  assert.equal(all(db, "SELECT id FROM mem_impression WHERE kind = 'quote' AND quote_id = 1 AND status = 'current'").length, 1);

  const r = s.revertBatch("tidy");
  assert.deepEqual(r.conflicts, []);
  assert.equal(snap(db), before);

  // 两边都有同名的现行字段：先并好一边
  set(s, "柚子茶茶", "是谁", "小红书上认识的", "b1");
  assert.throws(() => s.mergeEntities("姑妈", ["柚子茶茶"], "同一个人", "tidy2"), (e: Error) => /是谁/.test(e.message) && /并好一边/.test(e.message));
  assert.ok(s.entity("柚子茶茶"), "没动");

  // 有现行印象的人去不掉
  s.upsertEntity({ name: "Max", kind: "person" }, "b1");
  set(s, "Max", "是谁", "同学", "b1");
  assert.throws(() => s.dropEntity("Max", "其实是一件事", "tidy3"), /人物卡/);
  s.upsertEntity({ name: "Bob", kind: "person" }, "b1");
  s.dropEntity("Bob", "登记错了", "tidy3");
  assert.equal(s.entity("Bob"), undefined, "没有印象的照常去掉");
});

test("impression: 合并时「对我的感情和期待」超了 3 句——keep 的在前、再按编号补满，多的标 superseded（R21）", () => {
  const { db, s } = mk();
  s.upsertEntity({ name: "姑妈", kind: "person" }, "b0");
  s.upsertEntity({ name: "柚子茶茶", kind: "person" }, "b0");
  quote(db, "central", "90", "姑妈", "回家吃饭");          // q1
  quote(db, "central", "91", "姑妈", "路上小心");          // q2
  quote(db, "central", "92", "柚子茶茶", "谢谢你");        // q3
  quote(db, "central", "93", "柚子茶茶", "你真好");        // q4
  const feel = (who: string, q: string) => s.pinQuote({ who, section: "对我的感情和期待", quote: q, why: "原来的为什么" }, "b0").row;
  const [a1, a2, b3, b4] = [feel("姑妈", "q1"), feel("姑妈", "q2"), feel("柚子茶茶", "q4"), feel("柚子茶茶", "q3")];
  s.pinQuote({ who: "柚子茶茶", section: "记着的原话", quote: "q3" }, "b0");
  const before = snap(db);

  const kept = s.mergeEntities("姑妈", ["柚子茶茶"], "同一个人", "tidy");
  assert.deepEqual(pinned(s, kept.id, "对我的感情和期待").map((r) => r.id), [a1.id, a2.id, b3.id], "keep 的两句在前，再按编号补一句");
  const extra = s.impression(b4.id)!;
  assert.deepEqual([extra.status, extra.about, extra.why], ["superseded", kept.id, "合并时超了上限"]);
  assert.equal(all(db, "SELECT id FROM mem_quote WHERE id = 3").length, 1, "那句还在原话层");
  assert.equal(pinned(s, kept.id, "记着的原话").length, 1, "记着的原话不受这条管");
  assert.equal(s.pinQuote({ who: "姑妈", section: "对我的感情和期待", quote: "q3", replaces: b3.id }, "n1").existed, false, "换下来的能换回来，还是 3 句");
  assert.equal(pinned(s, kept.id, "对我的感情和期待").length, 3);

  s.revertBatch("n1");
  assert.deepEqual(s.revertBatch("tidy").conflicts, []);
  assert.equal(snap(db), before);
});

test("impression: 撤回——forcePending 的一批、批准新建的待批、换了又换回来，都回到原样", () => {
  const { db, s } = mk();
  for (let i = 1; i <= 4; i++) quote(db, "central", String(400 + i), "小贝", `第${i}句`);   // q1–q4
  const [p1] = ["q1", "q2", "q3"].map((q) => s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: q }, "b0").row);

  // (a) forcePending 的一批（里面还有一个替换了前一个待批的）
  let before = snap(db);
  set(s, "ada", "是谁", "我的人", "import:ada", { forcePending: true });
  set(s, "ada", "是谁", "我的人，学 CS", "import:ada");
  set(s, "小贝", "约定和边界", "- 不提考试", "import:ada", { forcePending: true });
  assert.notEqual(snap(db), before);
  assert.deepEqual(s.revertBatch("import:ada").conflicts, []);
  assert.equal(snap(db), before, "(a)");

  // (b) 批准 supersedes 为空的待批
  const f = set(s, "ada", "是谁", "我的人", "import:ada2", { forcePending: true });
  before = snap(db);
  s.approveImpression(f.row!.id, "approve:1");
  assert.notEqual(snap(db), before);
  assert.deepEqual(s.revertBatch("approve:1").conflicts, []);
  assert.equal(snap(db), before, "(b)");
  assert.equal(s.impression(f.row!.id)!.status, "pending");

  // (c) 换了又换回来：同一批
  const feel = (q: string, replaces: string, batch: string) => s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: q, replaces, why: `${batch} 换的` }, batch).row;
  before = snap(db);
  const r = feel("q4", p1!.id, "swap");
  assert.equal(feel("q1", r.id, "swap").id, p1!.id);
  assert.notEqual(snap(db), before);
  assert.deepEqual(s.revertBatch("swap").conflicts, []);
  assert.equal(snap(db), before, "(c) 同一批");
  // 分两批：先撤后一批、再撤前一批
  const r2 = feel("q4", p1!.id, "swap1");
  feel("q1", r2.id, "swap2");
  assert.deepEqual(s.revertBatch("swap2").conflicts, []);
  assert.equal(s.impression(r2.id)!.status, "current");
  assert.equal(s.impression(p1!.id)!.status, "superseded");
  assert.deepEqual(s.revertBatch("swap1").conflicts, []);
  assert.equal(snap(db), before, "(c) 两批");
});

// ---------- 人物卡、近况的渲染和导出（P4、P25） ----------
/** 她的时区里的 2026 年某月某日某时某分 */
const local = (mo: number, d: number, h: number, mi: number): number => localToUtc(2026, mo, d, h, mi, TZ);

/** 门面（配置里的模板，主人是主人）：砚〔3〕、小贝〔4〕、主人〔5〕（故意让编号顺序和重要度顺序相反）；e0001 当依据；clock.now 可以挪 */
function mkMem(o: { peopleDir?: string; peopleActive?: () => boolean } = {}) {
  const db = openDb(":memory:");
  const clock = { now: local(11, 4, 14, 0) };
  const mem = new EventMemory({ db, embedder: null, now: () => clock.now, tz: TZ, peopleTemplate: T, ...(o.peopleDir ? { peopleDir: o.peopleDir } : {}), ...(o.peopleActive ? { peopleActive: o.peopleActive } : {}) });
  mem.store.owners = OWNERS;
  mem.store.upsertEntity({ name: "砚", kind: "person", person_key: "gua", importance: 3 }, "b0");
  mem.store.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 4, why: "ada 的朋友" }, "b0");
  mem.store.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "最重要的人" }, "b0");
  mem.store.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 1 }, "b0");
  return { db, mem, clock };
}
/** 一件挂着 who 的事（标题、一句话由 title 来）；at 给了就记一条那时的经过（开始时间、最近一次进展都是它）；返回编号 */
function ev(mem: EventMemory, who: string, title: string, importance: number, at?: number, o: { stance?: "like" | "dislike"; batch?: string } = {}): string {
  const s = mem.store, batch = o.batch ?? "b0";
  const e = s.createEvent({ title, summary: `${title}的总结`, gist: `${title}的一句话`, importance, why: importance >= 4 ? "测试" : "", entities: [{ name: who, kind: "person", role: "with" }], ...(o.stance ? { stance: o.stance } : {}) }, batch);
  if (at !== undefined) s.addEntry({ event: e.id, at, full: `${title}的经过`, gist: title, title }, batch);
  return e.id;
}
/** 卡里的段名（## 开头的行），照出现的顺序 */
const heads = (card: string): string[] => card.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
/** 卡里一段的行（没有这段是空数组） */
const body = (card: string, name: string): string[] => card.split("\n\n").find((b) => b.startsWith(`## ${name}\n`))?.split("\n").slice(1).filter(Boolean) ?? [];
/** 目录里每个文件的字节 */
const files = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f)).toString("base64")]));

/** 小贝一张卡：公开字段、她私下说的、公开和私聊的原话、一件挂着她的大事（也是近况），加主人的「是谁」 */
function fillXiaobei(mem: EventMemory, batch: string): { exam: string } {
  const s = mem.store;
  quote(s.db, "central", "301", "小贝", "姐姐晚安，明天见", local(10, 29, 23, 43));           // q1：私聊（默认）
  quote(s.db, "central", "302", "小贝", "谢谢姐姐一直陪我", local(10, 30, 20, 5));            // q2：公开
  quote(s.db, "central", "303", "我→小贝（qq）", "晚安，做个好梦", local(10, 29, 23, 44));    // q3：我说给她的，私聊
  const exam = ev(mem, "小贝", "小贝考试", 4, local(11, 2, 20, 0), { batch });
  set(s, "小贝", "她私下说的", "- 她说考试很紧张", batch);
  set(s, "小贝", "是谁", "ada 的朋友，叫我姐姐", batch);
  set(s, "小贝", "在乎什么", "- 家里人", batch);
  set(s, "小贝", "关系", "朋友｜更近｜ada 的朋友，什么都跟我说", batch);
  s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q3" }, batch);
  s.pinQuote({ who: "小贝", section: "记着的原话", quote: "#301", why: "第一次叫我姐姐\n那天很晚" }, batch);
  s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q2", private: false }, batch);
  set(s, "ada", "是谁", "我的人", batch);
  return { exam };
}
const SECRETS = ["她私下说的", "考试很紧张", "（私聊）", "姐姐晚安", "做个好梦"];

test("card: 顺序、私密、原话格式、现算的两段", () => {
  const { mem, clock } = mkMem();
  const { exam } = fillXiaobei(mem, "b1");
  const own = mem.card("小贝", { viewer: "xiaobei" });
  assert.deepEqual(own.split("\n").slice(0, 2), ["# 小贝", "<!-- 从事件库导出；只读：关于这个人的新认识写每日笔记「新认识：」行，夜里整理会收 -->"]);
  assert.deepEqual(heads(own), ["关系", "是谁", "在乎什么", "我们的大事", "她私下说的", "对我的感情和期待", "记着的原话", "近况"], own);
  assert.deepEqual(body(own, "记着的原话"), ["- 10-29 23:43〔小贝〕（私聊）「姐姐晚安，明天见」—— 第一次叫我姐姐 那天很晚", "- 10-29 23:44〔我〕（私聊）「晚安，做个好梦」"],
    "原话按说的时间排；说话的人取箭头前、去掉括号；私聊钉的标（私聊）");
  assert.deepEqual(body(own, "对我的感情和期待"), ["- 10-30 20:05〔小贝〕「谢谢姐姐一直陪我」"], "没有 why 不写破折号");
  assert.deepEqual(body(own, "我们的大事"), [`- 11-02 小贝考试（${exam}）`]);
  assert.deepEqual(body(own, "近况"), [`- 小贝考试：小贝考试的一句话（${exam}）`]);
  assert.ok(own.includes("## 是谁\nada 的朋友，叫我姐姐\n"));
  assert.ok(own.endsWith("\n") && !own.endsWith("\n\n"));
  assert.equal(mem.card("t0002", { viewer: "xiaobei" }), own, "编号、名字、key 都认");
  assert.equal(mem.card("xiaobei", { viewer: "xiaobei" }), own);
  assert.equal(renderCard(mem.store, mem.store.entity("小贝")!, { viewer: "xiaobei", now: clock.now, tz: TZ }), own);

  for (const viewer of [null, "gua", "ada", "XIAOBEI"]) {
    const c = mem.card("小贝", { viewer });
    assert.deepEqual(heads(c), ["关系", "是谁", "在乎什么", "我们的大事", "对我的感情和期待", "近况"], `viewer=${viewer}`);
    for (const secret of SECRETS) assert.ok(!c.includes(secret), `viewer=${viewer} 看到了「${secret}」`);
  }

  assert.equal(mem.card("砚", { viewer: "gua" }), "", "没有字段、没有事的人是空字符串");
  assert.equal(mem.card("没这个人", { viewer: null }), "");
  mem.store.upsertEntity({ name: "Max", kind: "person", person_key: "max" }, "b1");
  set(mem.store, "Max", "她私下说的", "- 只有私密的", "b1");
  assert.equal(mem.card("Max", { viewer: null }), "", "只有私密字段的人，别人看是空的");
  assert.equal(heads(mem.card("Max", { viewer: "max" })).join(), "她私下说的");
  mem.store.upsertEntity({ name: "load.py", kind: "thing", importance: 4, why: "测试" }, "b1");
  ev(mem, "load.py", "load.py 修好了", 5, local(11, 3, 10, 0));
  assert.equal(mem.card("load.py", { viewer: null }), "", "人物卡只给人和群");
});

test("computed: 我们的大事——重要度 4 以上、没被替换 / 作废、不是喜欢 / 烦的事，挑重要的 10 件按开始时间", () => {
  const { mem, clock } = mkMem();
  const s = mem.store;
  const exam = ev(mem, "小贝", "考试", 5, local(10, 10, 20, 0));
  const bday = ev(mem, "小贝", "生日", 4, local(10, 20, 20, 0));
  ev(mem, "小贝", "吵架", 3, local(10, 21, 20, 0));                               // 重要度 3：不在
  s.supersede(ev(mem, "小贝", "旧的考试", 5, local(10, 5, 20, 0)), exam, "其实是一件", "b0");   // 被替换：不在
  ev(mem, "小贝", "喜欢猫", 5, local(10, 6, 20, 0), { stance: "like" });          // 喜欢 / 烦的事：不在
  s.retire(ev(mem, "小贝", "退掉的", 5, local(10, 7, 20, 0)), "不算数", "b0");    // 作废：不在
  clock.now = local(11, 1, 9, 0);
  const bare = ev(mem, "小贝", "没时间的", 5);                                    // 没有经过：显示建的日子，排最后
  const sep = Array.from({ length: 8 }, (_, i) => ev(mem, "小贝", `九月${i + 1}`, 4, local(9, i + 1, 12, 0)));
  clock.now = local(11, 4, 14, 0);
  assert.deepEqual(body(mem.card("小贝", { viewer: null }), "我们的大事"), [
    ...sep.slice(1).map((id, i) => `- 09-0${i + 2} 九月${i + 2}（${id}）`),
    `- 10-10 考试（${exam}）`, `- 10-20 生日（${bday}）`, `- 11-01 没时间的（${bare}）`,
  ], "11 件里挤掉重要度 4、开始得最早的九月1");
  // 同分同时：按编号
  const tie = ev(mem, "小贝", "同时的", 4, local(10, 20, 20, 0));
  const big = body(mem.card("小贝", { viewer: null }), "我们的大事");
  assert.equal(big.length, 10);
  assert.ok(!big.some((l) => l.includes("九月2")), "又挤掉一件：九月2");
  assert.deepEqual(big.slice(-3), [`- 10-20 生日（${bday}）`, `- 10-20 同时的（${tie}）`, `- 11-01 没时间的（${bare}）`]);
});

test("computed: 近况——最近一次进展在她的 14 天里（04:00 起算），最近的在前，最多 5 件", () => {
  const { mem, clock } = mkMem();
  const s = mem.store;
  const near = (): string[] => body(mem.card("砚", { viewer: null }), "近况");
  const edge = ev(mem, "砚", "第十四天", 2, local(10, 22, 4, 0));          // dayStart − 13 天那一天的 04:00：在
  const early = ev(mem, "砚", "第十五天", 2, local(10, 22, 3, 59));        // 还算 10-21 那一天：不在
  const yday = ev(mem, "砚", "十月二十一", 2, local(10, 21, 12, 0));       // 不在
  const later = ev(mem, "砚", "后来又有进展", 2, local(10, 1, 12, 0));
  s.addEntry({ event: later, at: local(11, 3, 12, 0), full: "又有进展的经过", gist: "又有进展", title: "又有进展" }, "b0");   // 最近一次进展 = 最大的 at
  clock.now = local(11, 2, 9, 0);
  const bare = ev(mem, "砚", "没有经过", 2);                               // 没有经过：按 updated_at（11-02 09:00）
  s.supersede(ev(mem, "砚", "被替换的", 2, local(11, 3, 0, 0)), later, "一件事", "b0");
  ev(mem, "砚", "喜欢的游戏", 2, local(11, 3, 1, 0), { stance: "like" });
  s.retire(ev(mem, "砚", "不算数的", 2, local(11, 3, 2, 0)), "不算数", "b0");
  const line = (id: string): string => { const e = s.event(id)!; return `- ${e.title}：${e.gist}（${id}）`; };

  clock.now = local(11, 4, 14, 0);
  assert.deepEqual(near(), [line(later), line(bare), line(edge)]);
  // 最多 5 件，最近的在前；同一时刻按编号
  const a = ev(mem, "砚", "新一", 2, local(11, 4, 10, 0));
  const b = ev(mem, "砚", "新二", 2, local(11, 4, 10, 0));
  const c = ev(mem, "砚", "新三", 2, local(11, 4, 9, 0));
  const today = [line(a), line(b), line(c), line(later), line(bare)];
  assert.deepEqual(near(), today);
  clock.now = local(11, 5, 3, 59);
  assert.deepEqual(near(), today, "不到 04:00 还是同一天");
  // 凌晨 3 点：她的一天还是前一天（11-03），窗口从 10-21 04:00 起、到现在为止（今天 9、10 点的还没到）
  clock.now = local(11, 4, 3, 0);
  assert.deepEqual(near(), [line(later), line(bare), line(edge), line(early), line(yday)]);
});

test("near: 每个出卡、近况非空的人一块、按重要度（没打分的最后）、写于 = 她这一天的 04:00", () => {
  const { mem, clock } = mkMem();
  const s = mem.store;
  assert.equal(mem.near(), "<!-- 写于 2026-11-04 04:00 -->\n# 人物近况\n", "没有人就只有头两行（写于照样写）");
  s.upsertEntity({ name: "姑妈", kind: "person", importance: 3 }, "b0");    // 和砚同分，编号在砚后面
  s.upsertEntity({ name: "Bob", kind: "person" }, "b0");                    // 还没打重要度：有卡（存着字段）也排最后
  s.upsertEntity({ name: "Amy", kind: "person" }, "b0");                    // 还没打重要度、没卡：不进
  const ids = [ev(mem, "ada", "赶作业", 3, local(11, 3, 9, 15)), ev(mem, "小贝", "准备考试", 3, local(11, 3, 22, 40)),
    ev(mem, "砚", "打游戏", 2, local(11, 4, 8, 2)), ev(mem, "姑妈", "去旅游", 2, local(11, 2, 7, 0)), ev(mem, "Bob", "刚认识", 1, local(11, 1, 7, 0)),
    ev(mem, "Amy", "Amy 来了", 1, local(11, 1, 8, 0))];
  set(s, "小贝", "她私下说的", "- 私聊里说这周要考试", "b1");
  set(s, "Bob", "是谁", "新认识的", "b1");
  clock.now = local(11, 5, 1, 0);   // 还是 11-04 那一天
  const near = mem.near();
  assert.equal(near, [
    "<!-- 写于 2026-11-04 04:00 -->", "# 人物近况", "",
    "#### ada", `- 赶作业：赶作业的一句话（${ids[0]}）`, "",
    "#### 小贝", `- 准备考试：准备考试的一句话（${ids[1]}）`, "",
    "#### 砚", `- 打游戏：打游戏的一句话（${ids[2]}）`, "",
    "#### 姑妈", `- 去旅游：去旅游的一句话（${ids[3]}）`, "",
    "#### Bob", `- 刚认识：刚认识的一句话（${ids[4]}）`, "",
  ].join("\n"));
  assert.equal(renderNear(s, { now: clock.now, tz: TZ }), near);
  assert.ok(!near.includes("这周要考试"));
  assert.ok(!near.includes("Amy"), "没卡的人不进（R18）");
});

test("near、card()：和导出同一条出卡规则（R18）——重要度 2、没卡、有近况的人不进 near.md、card() 是空的；重要度 3 的群进", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  s.upsertEntity({ name: "枫湾之家", kind: "group", importance: 3 }, "b0");
  s.upsertEntity({ name: "Eddy", kind: "person", importance: 2 }, "b0");
  s.upsertEntity({ name: "Max", kind: "person", importance: 2 }, "b0");
  ev(mem, "枫湾之家", "群里聊旅游", 2, local(11, 3, 20, 0));
  ev(mem, "Eddy", "Eddy 找我", 2, local(11, 3, 21, 0));
  ev(mem, "Max", "Max 找我", 2, local(11, 3, 22, 0));
  set(s, "Max", "梗", "- 总迟到", "b1");   // 重要度 2，但存着字段：有卡
  mem.exportPeople();
  const heads4 = (t: string): string[] => t.split("\n").filter((l) => l.startsWith("#### ")).map((l) => l.slice(5));
  assert.deepEqual(heads4(readFileSync(join(dir, "near.md"), "utf8")), ["枫湾之家", "Max"]);
  assert.equal(readFileSync(join(dir, "near.md"), "utf8"), mem.near());
  assert.equal(mem.card("Eddy", { viewer: null }), "", "没卡的人 card() 是空的（不只是导出不写）");
  assert.equal(renderCard(s, s.entity("Eddy")!, { viewer: null, now: local(11, 4, 14, 0), tz: TZ }), "");
  assert.deepEqual(heads(mem.card("枫湾之家", { viewer: null })), ["近况"]);
  assert.deepEqual(heads(mem.card("Max", { viewer: null })), ["梗", "近况"]);
  // 卡文件：访客、群的只有存着的字段和钉的原话（R35），只有现算段的枫湾之家没有卡文件；Max 的卡文件没有近况
  assert.deepEqual(Object.keys(files(dir)).sort(), [`${s.entity("Max")!.id}.md`, "near.md"].sort(), "有存着东西的才有卡文件");
  assert.deepEqual(heads(readFileSync(join(dir, `${s.entity("Max")!.id}.md`), "utf8")), ["梗"]);
});

test("export: 确定、写了才动、删多余的、撤回跟上", () => {
  const dir = tmpDir("hh-people-");
  const { db, mem, clock } = mkMem({ peopleDir: dir });
  assert.equal(mkMem().mem.exportPeople(), null, "没配目录不导出");

  mem.beginNight("n0");
  fillXiaobei(mem, mem.currentBatch!);
  mem.commitNight();
  const r1 = mem.exportPeople()!;
  assert.deepEqual(r1, { written: ["xiaobei.md", "ada.md", "near.md"], removed: [] });
  assert.equal(mem.peopleExportError, null);
  const A = files(dir);
  assert.deepEqual(Object.keys(A), ["ada.md", "near.md", "xiaobei.md"], "砚没有字段、没有事：没有卡");
  const noComputed = (c: string): string => c.split("\n\n").filter((b) => !b.startsWith("## 我们的大事\n") && !b.startsWith("## 近况\n")).join("\n\n").replace(/\n*$/, "\n");
  assert.equal(readFileSync(join(dir, "xiaobei.md"), "utf8"), noComputed(mem.card("小贝", { viewer: "xiaobei" })), "卡是他自己那一面（访客的卡文件不带现算段，R35）");
  assert.equal(readFileSync(join(dir, "near.md"), "utf8"), mem.near());

  assert.deepEqual(mem.exportPeople(), { written: [], removed: [] }, "内容一样不写");
  assert.deepEqual(files(dir), A, "逐字节相同");

  writeFileSync(join(dir, "old.md"), "# 旧卡\n");
  writeFileSync(join(dir, "notes.txt"), "不是卡\n");
  assert.deepEqual(mem.exportPeople(), { written: [], removed: ["old.md"] });
  assert.ok(!existsSync(join(dir, "old.md")) && existsSync(join(dir, "near.md")) && existsSync(join(dir, "notes.txt")), "只删多余的 *.md，near.md 和别的文件不动");
  writeFileSync(join(dir, "near.md"), "被人改过\n");
  assert.deepEqual(mem.exportPeople(), { written: ["near.md"], removed: [] });
  const notes = readFileSync(join(dir, "notes.txt"));

  // 夜里一批：改了，写人和东西之后立刻导出；撤回后回到原样
  mem.beginNight("n1");
  set(mem.store, "ada", "是谁", "我的人\n- 学 CS", mem.currentBatch!);
  mem.write("mem_entity_upsert", { name: "Eddy", kind: "person", importance: 2 });
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("我的人\n- 学 CS"), "写了就导出");
  mem.revertNight();
  assert.deepEqual(files(dir), { ...A, "notes.txt": notes.toString("base64") }, "撤回后文件回到旧的");

  // 导入一份失败：同理；导入成功：结束时也导出
  mem.beginImport("people-ada");
  set(mem.store, "ada", "是谁", "导入的", mem.currentBatch!, { noApproval: true });
  mem.exportPeople();
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("导入的"));
  mem.endImport(false);
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes("导入的"), "导入失败撤回后卡跟上");
  assert.equal(readFileSync(join(dir, "ada.md"), "utf8"), Buffer.from(A["ada.md"]!, "base64").toString("utf8"));
  mem.beginImport("people-gua");
  set(mem.store, "砚", "是谁", "小贝的朋友", mem.currentBatch!, { noApproval: true });
  mem.endImport(true);
  assert.ok(readFileSync(join(dir, "gua.md"), "utf8").includes("小贝的朋友"), "导入成功结束时导出");

  // 上次没收尾（重启）：启动时撤回，卡跟上；名字改了（并掉）的人旧卡删掉
  mem.beginNight("n2");
  set(mem.store, "ada", "感觉", "睡前改的", mem.currentBatch!);
  mem.exportPeople();
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("睡前改的"));
  const again = new EventMemory({ db, embedder: null, now: () => clock.now, tz: TZ, peopleTemplate: T, peopleDir: dir });
  again.store.owners = OWNERS;
  assert.deepEqual(again.recoverOpenBatches(), ["n2"]);
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes("睡前改的"), "启动撤回后导出");
  set(mem.store, "ada", "感觉", "白天手动改的", "manual");
  assert.deepEqual(again.recoverOpenBatches(), [], "没有要撤的");
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("白天手动改的"), "hhd 启动总导出一次");
  // 人和东西的增改并：并掉的人、换了 key 的人，旧卡删掉；撤回后回来
  const before = files(dir);
  again.beginNight("n3");
  again.write("mem_entity_upsert", { name: "阿砚", kind: "person", importance: 1 });
  set(again.store, "阿砚", "梗", "- 枫湾之家的", again.currentBatch!);
  const agu = `${again.store.entity("阿砚")!.id}.md`;
  assert.deepEqual(again.exportPeople(), { written: [agu], removed: [] }, "不在名单上的人用实体编号");
  again.write("mem_entity_merge", { keep: "砚", others: ["阿砚"], reason: "其实是一个人" });
  assert.ok(!existsSync(join(dir, agu)), "并掉的人的旧卡删掉");
  assert.ok(readFileSync(join(dir, "gua.md"), "utf8").includes("枫湾之家的"), "并过来的字段进了砚的卡");
  again.write("mem_entity_upsert", { name: "砚", person_key: "gu2" });
  assert.ok(!existsSync(join(dir, "gua.md")) && existsSync(join(dir, "gu2.md")), "换了 key：旧卡删掉、新卡写上");
  again.revertNight();
  assert.deepEqual(files(dir), before, "撤回后回到这一批之前");
});

test("export: 同一天两次字节相同、跨过 04:00 才变；near.md 写于 = 她这一天的 04:00", () => {
  const dir = tmpDir("hh-people-");
  const { mem, clock } = mkMem({ peopleDir: dir });
  fillXiaobei(mem, "b1");
  ev(mem, "砚", "打游戏", 2, local(10, 22, 5, 0));   // 11-05 04:00 起出了近况的窗口
  ev(mem, "ada", "陪 ada 打游戏", 2, local(10, 22, 6, 0));   // 主人的卡文件带现算段：跨过 04:00 跟着变
  assert.deepEqual(mem.exportPeople(), { written: ["xiaobei.md", "ada.md", "near.md"], removed: [] }, "砚只有现算的近况：进 near.md，访客的卡文件不带现算段，就没有卡文件（R35）");
  const A = files(dir);
  assert.equal(readFileSync(join(dir, "near.md"), "utf8").split("\n")[0], "<!-- 写于 2026-11-04 04:00 -->");
  for (const t of [local(11, 4, 4, 0), local(11, 4, 23, 59), local(11, 5, 3, 59)]) {
    clock.now = t;
    assert.deepEqual(mem.exportPeople(), { written: [], removed: [] }, new Date(t).toISOString());
    assert.deepEqual(files(dir), A, "同一天：逐字节相同");
  }
  clock.now = local(11, 5, 4, 0);
  assert.deepEqual(mem.exportPeople(), { written: ["ada.md", "near.md"], removed: [] }, "跨过 04:00：近况滑出窗口，主人的卡和 near.md 跟着变");
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes("陪 ada 打游戏"));
  const near = readFileSync(join(dir, "near.md"), "utf8");
  assert.equal(near.split("\n")[0], "<!-- 写于 2026-11-05 04:00 -->");
  assert.ok(near.includes("#### 小贝") && !near.includes("#### 砚") && !near.includes("#### ada"));
  assert.equal(readFileSync(join(dir, "xiaobei.md"), "base64"), A["xiaobei.md"], "小贝 11-02 的事还在窗口里：卡没变");
});

test("cards: 只有现算内容的人——重要度 3 以上的人和群有卡，2 的、没打分的没有（也不进 near.md）", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  s.upsertEntity({ name: "枫湾之家", kind: "group", importance: 3 }, "b0");
  s.upsertEntity({ name: "Eddy", kind: "person", importance: 2 }, "b0");
  s.upsertEntity({ name: "Bob", kind: "person" }, "b0");
  s.upsertEntity({ name: "load.py", kind: "thing", importance: 5, why: "测试" }, "b0");
  const home = ev(mem, "枫湾之家", "群里聊旅游", 2, local(11, 3, 20, 0));
  ev(mem, "Eddy", "Eddy 找我", 2, local(11, 3, 21, 0));
  ev(mem, "Bob", "Bob 找我", 4, local(11, 3, 22, 0));
  ev(mem, "load.py", "load.py 修好了", 4, local(11, 3, 23, 0));
  const old = ev(mem, "砚", "砚的大事", 4, local(9, 1, 12, 0));   // 只有我们的大事（早出了近况的窗口）
  mem.exportPeople();
  // 卡（card()）照出；卡文件只给主人带现算段（R35）：只有现算段的访客、群没有卡文件，在 near.md 里
  assert.deepEqual(Object.keys(files(dir)), ["near.md"]);
  const homeCard = mem.card("枫湾之家", { viewer: null });
  assert.deepEqual(heads(homeCard), ["近况"]);
  assert.deepEqual(body(homeCard, "近况"), [`- 群里聊旅游：群里聊旅游的一句话（${home}）`]);
  assert.deepEqual(heads(mem.card("砚", { viewer: "gua" })), ["我们的大事"]);
  assert.ok(mem.card("砚", { viewer: "gua" }).includes(`- 09-01 砚的大事（${old}）`));
  const near = readFileSync(join(dir, "near.md"), "utf8");
  assert.deepEqual(near.split("\n").filter((l) => l.startsWith("#### ")), ["#### 枫湾之家"], "近况：只有出卡的人和群（R18）；Eddy〔2〕、Bob〔没打分〕、东西不进");
  assert.equal(mem.card("Eddy", { viewer: null }), "");
  assert.equal(mem.card("Bob", { viewer: null }), "");
});

test("export: 她私下说的只在他自己的卡里——不进 ada 卡、别人的卡、near、viewer null", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  fillXiaobei(mem, "b1");
  set(mem.store, "砚", "她私下说的", "- 砚的秘密", "b1");
  mem.exportPeople();
  const ada = readFileSync(join(dir, "ada.md"), "utf8");
  assert.deepEqual(heads(ada), ["是谁"], "ada.md 里只有 ada 的字段");
  const xiaobei = readFileSync(join(dir, "xiaobei.md"), "utf8");
  const gua = readFileSync(join(dir, "gua.md"), "utf8");
  const near = readFileSync(join(dir, "near.md"), "utf8");
  for (const secret of SECRETS) {
    assert.ok(xiaobei.includes(secret), `xiaobei.md 少了「${secret}」`);
    for (const [f, c] of [["ada.md", ada], ["gua.md", gua], ["near.md", near], ["viewer null", mem.card("小贝", { viewer: null })], ["砚看小贝", mem.card("小贝", { viewer: "gua" })]] as const) {
      assert.ok(!c.includes(secret) || (f === "gua.md" && secret === "她私下说的"), `${f} 里有小贝的私密「${secret}」`);
    }
  }
  assert.ok(gua.includes("砚的秘密") && !xiaobei.includes("砚的秘密") && !ada.includes("砚的秘密") && !near.includes("砚的秘密"));
  assert.equal(cardFile(mem.store.entity("小贝")!), "xiaobei.md");
  mem.store.upsertEntity({ name: "枫湾之家", kind: "group", importance: 3 }, "b1");
  assert.equal(cardFile(mem.store.entity("枫湾之家")!), `${mem.store.entity("枫湾之家")!.id}.md`, "不在名单上的用实体编号");
  mem.store.upsertEntity({ name: "奇怪的 key", kind: "person", person_key: "Near" }, "b1");
  assert.equal(cardFile(mem.store.entity("奇怪的 key")!), `${mem.store.entity("奇怪的 key")!.id}.md`, "key 和 near.md 撞上就用编号");
  assert.deepEqual(exportPeople(mem.store, dir, { now: local(11, 4, 14, 0), tz: TZ }), { written: [], removed: [] });
});

test("export: 出错不抛、记下来；chores 每 10 分钟导出一次，出错记日志", () => {
  const base = tmpDir("hh-people-");
  const blocked = join(base, "not-a-dir");
  writeFileSync(blocked, "这是个文件");
  const { mem } = mkMem({ peopleDir: blocked });
  mem.beginNight("n1");
  assert.doesNotThrow(() => mem.write("mem_entity_upsert", { name: "Eddy", kind: "person", importance: 2 }), "导出出错不拦写");
  assert.ok(mem.peopleExportError, "错记下来");
  assert.equal(mem.exportPeople(), null);
  const logs: Array<{ msg: string; data: Record<string, unknown> }> = [];
  const exportsDir = join(base, "exports");
  new MemChores({ mem, exportsDir, tz: TZ, now: () => T0, asleep: () => true, log: (msg, data) => logs.push({ msg, data }) }).tick();
  assert.deepEqual(logs.map((l) => l.msg), ["people export failed"]);
  assert.ok(String(logs[0]!.data.error).length > 0);

  const dir = join(base, "ok", "ledger", "people");
  const good = mkMem({ peopleDir: dir });
  set(good.mem.store, "ada", "是谁", "在赶作业", "b1");
  const quiet: string[] = [];
  new MemChores({ mem: good.mem, exportsDir, tz: TZ, now: () => T0, asleep: () => true, log: (msg) => quiet.push(msg) }).tick();
  assert.deepEqual(quiet, []);
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("在赶作业"), "目录不在就建");
  assert.ok(existsSync(join(dir, "near.md")));
});

test("export: hh mem revert、entity-plan 之后卡跟上", async () => {
  const { memCommand } = await import("../src/memory/events/cli.ts");
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const env = { exportsDir: removeAtExit(join(dir, "..", `${dir.split("/").pop()}-exports`)) };
  fillXiaobei(mem, "b1");
  set(mem.store, "砚", "是谁", "小贝的朋友", "b1");
  mem.store.upsertEntity({ name: "阿砚", kind: "person", importance: 1 }, "b1");
  set(mem.store, "阿砚", "梗", "- 枫湾之家的", "b1");
  mem.exportPeople();
  const agu = `${mem.store.entity("阿砚")!.id}.md`;
  const A = files(dir);
  assert.ok(A[agu] && A["gua.md"]);

  // hh mem revert <批次>：撤回之后导出
  set(mem.store, "ada", "是谁", "命令行那批改的", "manual");
  mem.exportPeople();
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("命令行那批改的"));
  await memCommand(mem, "revert", ["manual"], env);
  assert.deepEqual(files(dir), A, "hh mem revert 之后卡回到原样");

  // hh mem entity-plan：--dry 不动；真跑提交之后导出（并人、换 key）
  const plan = removeAtExit(join(dir, "..", `${dir.split("/").pop()}-plan.json`));
  writeFileSync(plan, JSON.stringify([{ op: "merge", keep: "砚", others: ["阿砚"], reason: "其实是一个人" }, { op: "upsert", name: "砚", person_key: "gu2" }]));
  const dry = await memCommand(mem, "entity-plan", [plan, "--dry"], env) as { ok: boolean };
  assert.equal(dry.ok, true);
  assert.deepEqual(files(dir), A, "--dry 不动卡");
  const r = await memCommand(mem, "entity-plan", [plan], env) as { ok: boolean; batch: string };
  assert.equal(r.ok, true);
  assert.ok(!existsSync(join(dir, agu)) && !existsSync(join(dir, "gua.md")), "并掉的、换了 key 的旧卡删掉");
  assert.ok(readFileSync(join(dir, "gu2.md"), "utf8").includes("枫湾之家的"));
  await memCommand(mem, "revert", [r.batch], env);
  assert.deepEqual(files(dir), A, "撤回整理计划，卡也回来");
});

test("export: 写的时候导出出错，第一次就记日志（换了错、好了又坏也记），一样的错不刷屏", () => {
  const base = tmpDir("hh-people-");
  const blocked = join(base, "people");
  writeFileSync(blocked, "这是个文件");
  const logs: string[] = [];
  const db = openDb(":memory:");
  const mem = new EventMemory({ db, embedder: null, now: () => T0, tz: TZ, peopleTemplate: T, peopleDir: blocked, log: { warn: (msg, data) => logs.push(`${msg}：${String(data.error)}`) } });
  mem.beginNight("n1");
  mem.write("mem_entity_upsert", { name: "Eddy", kind: "person", importance: 2 });
  mem.write("mem_entity_upsert", { name: "Bob", kind: "person", importance: 2 });
  assert.equal(logs.length, 1, logs.join("\n"));
  assert.match(logs[0]!, /^people export failed：/);
  unlinkSync(blocked);
  mem.write("mem_entity_upsert", { name: "Max", kind: "person", importance: 2 });
  assert.equal(mem.peopleExportError, null);
  assert.ok(existsSync(join(blocked, "near.md")));
  rmSync(blocked, { recursive: true });
  writeFileSync(blocked, "又是个文件");
  mem.write("mem_entity_upsert", { name: "Amy", kind: "person", importance: 2 });
  assert.equal(logs.length, 2, "好了又坏：再记一次");
});

// ---------- 夜里的工具、工作单第 8 节、命令行（Task 3；P30：回话和工作单给只看人物材料的小 agent 用） ----------
/** 最新的一行印象的编号 */
const lastId = (db: Db): string => all<{ id: string }>(db, "SELECT id FROM mem_impression ORDER BY length(id) DESC, id DESC LIMIT 1")[0]!.id;

test("tools: 白天拒绝、夜里写、导入不等批；回话自己说得清（字段、多少 / 上限、合计、要谁批）", async () => {
  const { mem } = mkMem();
  const s = mem.store;
  const xiaobei = s.entity("小贝")!.id;
  for (let i = 1; i <= 4; i++) quote(s.db, "central", String(500 + i), "小贝", `第${i}句话`);   // q1–q4
  assert.ok((MEM_WRITE_TOOLS as readonly string[]).includes("mem_person_set") && (MEM_WRITE_TOOLS as readonly string[]).includes("mem_quote_pin"), "海马和导入者的工具都是 MEM_WRITE_TOOLS");
  const tools = memTools(mem, "hippocampus", [...MEM_WRITE_TOOLS]);
  const ps = tools.find((t) => t.name === "mem_person_set")!;
  const qp = tools.find((t) => t.name === "mem_quote_pin")!;
  assert.ok(ps && qp);
  // 说明从模板生成（不写死字段表）
  assert.ok(ps.description.includes(describeTemplate(T)), "mem_person_set：整份模板说明");
  assert.match(ps.description, /text 写空[^\n]*清掉/);
  assert.match(ps.description, /hh mem approve|等人批/);
  assert.match(ps.description, /导入那一跑不按大改等批/, "导入者看的是同一份说明");
  assert.ok(qp.description.includes(describeTemplate(T, { only: "quotes" })), "mem_quote_pin：原话段那一份");
  assert.match(qp.description, /只加不删/);
  assert.match(qp.description, /没有拿掉的工具/);
  assert.ok(!qp.description.includes("喜好（总结）"), "钉原话的说明不列字段");
  assert.deepEqual(Object.keys(ps.shape).sort(), ["section", "sources", "text", "who", "why"]);
  assert.deepEqual(Object.keys(qp.shape).sort(), ["private", "quote", "replaces", "section", "sources", "text", "who", "why"]);
  const person = (a: Record<string, unknown>) => ps.handler({ sources: EV, why: "测试", ...a });
  const pin = (a: Record<string, unknown>) => qp.handler(a);

  // 白天：没开批次，照旧拒
  assert.match(await person({ who: "小贝", section: "喜好", text: items(4, 10) }), /^没做成：记忆库只在夜里整理（或导入）时能写/);
  assert.match(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q1" }), /^没做成：记忆库只在夜里整理（或导入）时能写/);
  assert.equal(count(s.db), 0);

  mem.beginNight("night:t/2026-11-04");
  assert.equal(await person({ who: "小贝", section: "喜好", text: items(4, 10) }), "改好了 小贝·喜好（4/5 条，合计 40/1500 字）");
  assert.equal(await person({ who: "小贝", section: "是谁", text: "ada 的朋友" }), "改好了 小贝·是谁（7/150 字，合计 47/1500 字）");
  assert.equal(await person({ who: "xiaobei", section: "关系", text: "朋友｜更近｜什么都跟我说" }), "改好了 小贝·关系（12 字，合计 59/1500 字）", "名单 key 也认，回话用名字");
  // 被拒：A1 的错误信息原样，前面加「没写进去：」
  assert.equal(await person({ who: "小贝", section: "喜好", text: items(6, 10) }), "没写进去：喜好 满了：写进去是 6 条（上限 5）；合并成更抽象的一条，或者换掉一条");
  assert.match(await person({ who: "小贝", section: "在乎什么", text: "- 家里人", sources: [] }), /^没写进去：在乎什么 要写依据：/);
  assert.match(await person({ who: "小贝", section: "近况", text: "- x" }), /^没写进去：「近况」这一段是从事件库现算的/);
  // 约定和边界（设定）：新建直接上；改了存成待批，说清为什么、要谁批、怎么批
  assert.equal(await person({ who: "小贝", section: "约定和边界", text: "- 不提考试" }), "改好了 小贝·约定和边界（1/5 条，合计 63/1500 字）");
  const p1 = await person({ who: "小贝", section: "约定和边界", text: "- 不提考试\n- 十二点以后不找她" });
  const i1 = lastId(s.db);
  assert.equal(p1, `存成待批 ${i1}（约定和边界改了要 ada 批：hh mem approve ${i1}）`);
  assert.equal(await person({ who: "小贝", section: "约定和边界", text: "- 不提考试\n- 十二点以后不找她" }), `没变：和待批的 ${i1} 一样，还在等 ada 批（hh mem approve ${i1}）`);
  const p2 = await person({ who: "小贝", section: "约定和边界", text: "- 不提考试\n- 晚上不找她" });
  const i2 = lastId(s.db);
  assert.equal(p2, `存成待批 ${i2}（约定和边界改了要 ada 批：hh mem approve ${i2}）；之前的待批 ${i1} 作废了（被新的待批取代）`);
  assert.equal(await person({ who: "小贝", section: "喜好", text: items(4, 10) }), "没变");
  // 清掉：详情字段直接清；总结字段清掉要批
  await person({ who: "小贝", section: "她私下说的", text: "- 考试很紧张" });
  assert.equal(await person({ who: "小贝", section: "她私下说的", text: "", why: "她说不用记了" }), "清掉了 小贝·她私下说的");
  await person({ who: "小贝", section: "梗", text: "- 叫我姐姐" });
  const c = await person({ who: "小贝", section: "梗", text: "", why: "过时了" });
  assert.equal(c, `存成待批 ${lastId(s.db)}（清掉梗要 ada 批：hh mem approve ${lastId(s.db)}）`);
  // 丢行、一批改了一半以上
  await person({ who: "砚", section: "在乎什么", text: items(5, 10) });
  const l = await person({ who: "砚", section: "在乎什么", text: items(5, 10, "新") });
  const lid = lastId(s.db);
  assert.equal(l, `存成待批 ${lid}（丢了旧文 5/5 行，要 ada 批：hh mem approve ${lid}）`);
  for (const [sec, text] of [["是谁", "我的人"], ["感觉", "很依赖他。"], ["关系", "家人｜更近｜我的人"]] as const) set(s, "ada", sec, text, "b0");
  assert.equal(await person({ who: "ada", section: "是谁", text: "我的人，学 CS" }), "改好了 ada·是谁（8/300 字，合计 22/4500 字）", "主人的上限和合计（修订 C）");
  assert.match(await person({ who: "ada", section: "感觉", text: "很依赖他。也心疼他。" }), /^改好了 ada·感觉/, "protect 的字段往后加：直接上");
  // protect 的字段纯添加也照总结的规矩：一批改了一半以上照样等批
  const sw = await person({ who: "ada", section: "关系", text: "家人｜更近｜我的人，一直都是" });
  assert.equal(sw, `存成待批 ${lastId(s.db)}（这一批改了「ada」一半以上的设定 / 总结字段，要 ada 批：hh mem approve ${lastId(s.db)}）`);
  // 直接改一个字段：这个字段上开着的待批作废，回话里说
  set(s, "砚", "是谁", "a\nb\nc\nd\ne", "b0");
  await person({ who: "砚", section: "是谁", text: "f" });
  const bid = lastId(s.db);
  assert.equal(s.impression(bid)!.status, "pending");
  assert.equal(await person({ who: "砚", section: "是谁", text: "a\nb\nc\nd\ne\nf" }), `改好了 砚·是谁（11/150 字，合计 61/1500 字）；之前的待批 ${bid} 作废了（被直接改过了）`);

  // 钉原话
  assert.equal(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q1" }), `钉上了 ${lastId(s.db)}（小贝·对我的感情和期待，1/3 句，私聊）`);
  const first = lastId(s.db);
  assert.equal(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q2", private: false }), `钉上了 ${lastId(s.db)}（小贝·对我的感情和期待，2/3 句）`);
  const second = lastId(s.db);
  await pin({ who: "小贝", section: "对我的感情和期待", quote: "q3" });
  assert.match(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q4" }), /^没钉上：「对我的感情和期待」满了：已经 3 句（上限 3）；用 replaces 换掉一句/);
  assert.equal(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q4", replaces: first }), `换下了 ${first}，钉上了 ${lastId(s.db)}（小贝·对我的感情和期待，3/3 句，私聊）`);
  assert.equal(await pin({ who: "小贝", section: "对我的感情和期待", quote: "q2" }), `已经钉过了 ${second}`);
  assert.match(await pin({ who: "小贝", section: "记着的原话", quote: "q1", replaces: second }), /^没钉上：「记着的原话」不换：只加不删.*；不挤掉；回报里只写「小贝 的记着的原话满了」，不写原话$/, "访客：不往 ada 的提案里写（R36）");
  assert.equal(pinned(s, xiaobei, "对我的感情和期待").length, 3);
  mem.commitNight();

  // 导入那一跑：不等批（批次 import:<key>，手工导入的批次 import 也一样）
  const ips = memTools(mem, "importer", [...MEM_WRITE_TOOLS]).find((t) => t.name === "mem_person_set")!;
  const imp = (a: Record<string, unknown>) => ips.handler({ sources: EV, why: "导入", ...a });
  assert.match(await imp({ who: "砚", section: "约定和边界", text: "- 一" }), /^没做成：/, "没在导入");
  mem.beginImport("people:gua");
  assert.match(await imp({ who: "砚", section: "约定和边界", text: "- 一" }), /^改好了 砚·约定和边界（1\/5 条，/);
  assert.match(await imp({ who: "砚", section: "约定和边界", text: "- 二" }), /^改好了 砚·约定和边界/, "设定改了也不等批");
  assert.match(await imp({ who: "砚", section: "在乎什么", text: items(5, 10, "再") }), new RegExp(`^改好了 砚·在乎什么（5/5 条，[^）]*）；之前的待批 ${lid} 作废了（被直接改过了）$`), "丢行也不等批");
  mem.endImport(true);
  mem.setImporting(true);
  assert.match(await imp({ who: "砚", section: "约定和边界", text: "- 三" }), /^改好了 砚·约定和边界/);
  mem.setImporting(false);
  assert.deepEqual(s.pendingImpressions().filter((r) => r.about === s.entity("砚")!.id).map((r) => r.section), []);
  // 要谁批：从名单认的主人；没有主人就是「人」
  s.owners = new Set();
  mem.beginNight("night:t/2026-11-05");
  const np = await person({ who: "砚", section: "约定和边界", text: "- 四" });
  assert.equal(np, `存成待批 ${lastId(s.db)}（约定和边界改了要人批：hh mem approve ${lastId(s.db)}）`);
});

test("tools: 没配模板，两个工具照样列出来，调用回「人物卡模板没配置」", async () => {
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: TZ });
  m.store.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei" }, "b0");
  const tools = memTools(m, "hippocampus", [...MEM_WRITE_TOOLS]);
  const ps = tools.find((t) => t.name === "mem_person_set")!;
  const qp = tools.find((t) => t.name === "mem_quote_pin")!;
  assert.ok(ps && qp);
  assert.match(ps.description, /人物卡模板没配置/);
  assert.match(qp.description, /人物卡模板没配置/);
  m.beginNight("n1");
  assert.match(await ps.handler({ who: "小贝", section: "是谁", text: "x", sources: ["e0001"] }), /^没写进去：人物卡模板没配置/);
  assert.match(await qp.handler({ who: "小贝", section: "记着的原话", quote: "q1" }), /^没钉上：人物卡模板没配置/);
});

test("tools: 并人并出来超了合计的卡，往小里改能写，回话说超了多少", async () => {
  const { mem } = mkMem();
  const s = mem.store;
  s.upsertEntity({ name: "阿甲", kind: "person" }, "b0");
  s.upsertEntity({ name: "阿乙", kind: "person" }, "b0");
  for (const sec of ["在乎什么", "喜好", "雷点", "相处"]) set(s, "阿乙", sec, items(5, 40), "b0");   // 800
  for (const sec of ["梗", "约定和边界"]) set(s, "阿甲", sec, items(5, 40), "b0");
  set(s, "阿甲", "是谁", zi(150), "b0");
  set(s, "阿甲", "感觉", zi(120), "b0");
  set(s, "阿甲", "关系", `朋友｜平稳｜${zi(60)}`, "b0");   // 736
  s.mergeEntities("阿甲", ["阿乙"], "同一个人", "b0");   // 1536
  mem.beginNight("n1");
  const ps = memTools(mem, "hippocampus", ["mem_person_set"])[0]!;
  assert.equal(await ps.handler({ who: "阿甲", section: "相处", text: `${items(4, 40)}\n- ${zi(39, "换")}`, sources: EV, why: "收一收" }),
    "改好了 阿甲·相处（5/5 条，合计 1535/1500 字：超了 35 字，先把别的字段收一收）");
});

/** 工作单第 8 节里的「人物卡」那一段（到第 9 节为止） */
const cardsOf = (w: string): string => { const sec8 = w.split("\n## 8.")[1]!.split("\n## 9.")[0]!; return sec8.slice(sec8.indexOf("\n人物卡（") + 1).trimEnd(); };
/** 「人物卡」里某个人那一块 */
const blockOf = (cards: string, name: string): string => `### ${cards.split("\n### ").find((b) => b.startsWith(`${name}（`))!.split("\n还有 ")[0]!.split("\n还没有卡")[0]!}`;

test("worklist: 第 8 节末尾的人物卡——每人一块（字段和大小、钉了几句、待批、合计、今天挂着他的新经过），还没有卡的一行，≤3000 字", () => {
  const { mem } = mkMem();
  const s = mem.store;
  const { exam } = fillXiaobei(mem, "b0");
  for (let i = 1; i <= 12; i++) s.addEntry({ event: exam, at: local(11, 4, 10, i), full: `今天第${i}条`, gist: `第${i}条`, title: `第${i}条`, people: ["小贝"] }, "b0");
  s.addEntry({ event: exam, at: local(11, 3, 12, 0), full: "昨天的", gist: "昨天的", title: "昨天的", people: ["小贝"] }, "b0");
  s.addEntry({ event: exam, at: local(11, 4, 12, 0), full: "给 ada 的", gist: "给 ada 的", title: "给 ada 的", people: ["ada"] }, "b0");
  const today = all<{ id: string }>(s.db, "SELECT id FROM mem_entry WHERE title LIKE '第%条' ORDER BY at").map((r) => r.id);
  const adaEntry = all<{ id: string }>(s.db, "SELECT id FROM mem_entry WHERE title = '给 ada 的'")[0]!.id;
  set(s, "ada", "约定和边界", "- 不吵他", "b0");
  const pend = set(s, "ada", "约定和边界", "- 不吵他\n- 晚上不找他", "n1").row!.id;
  // 并人并出来超了合计
  s.upsertEntity({ name: "阿甲", kind: "person", importance: 3 }, "b0");
  s.upsertEntity({ name: "阿乙", kind: "person" }, "b0");
  for (const sec of ["在乎什么", "喜好", "雷点", "相处"]) set(s, "阿乙", sec, items(5, 40), "b0");
  for (const sec of ["梗", "约定和边界"]) set(s, "阿甲", sec, items(5, 40), "b0");
  set(s, "阿甲", "是谁", zi(150), "b0");
  set(s, "阿甲", "感觉", zi(120), "b0");
  set(s, "阿甲", "关系", `朋友｜平稳｜${zi(60)}`, "b0");
  s.mergeEntities("阿甲", ["阿乙"], "同一个人", "b0");
  // 一个字段超了它自己的上限（模板改小了的那种）
  s.upsertEntity({ name: "老王", kind: "person", importance: 2 }, "b0");
  const wang = set(s, "老王", "喜好", items(5, 10), "b0").row!.id;
  s.db.prepare("UPDATE mem_impression SET text = ? WHERE id = ?").run(items(6, 10), wang);
  // 还没有卡：重要度 ≥3 的人和群；2 的、东西不列
  s.upsertEntity({ name: "枫湾之家", kind: "group", importance: 3 }, "b0");
  s.upsertEntity({ name: "Eddy", kind: "person", importance: 2 }, "b0");
  s.upsertEntity({ name: "load.py", kind: "thing", importance: 5, why: "测试" }, "b0");

  const w = mem.worklist("2026-11-04");
  const cards = cardsOf(w);
  assert.ok(w.indexOf("\n人物卡（") > w.indexOf("## 8.") && w.indexOf("\n人物卡（") < w.indexOf("## 9."), "在第 8 节末尾");
  assert.match(cards.split("\n")[0]!, /有待批的字段没必要就别再写，再写会顶掉或作废那个待批/);
  assert.ok(cards.length <= 3000, `${cards.length} 字`);
  assert.equal(blockOf(cards, "小贝"), [
    `### 小贝（${s.entity("小贝")!.id}，名单 xiaobei）`,
    "- 关系 20 字",
    "- 是谁 12/150 字",
    "- 在乎什么 1/5 条",
    "- 她私下说的 1/5 条（私密）",
    "- 钉的原话：对我的感情和期待 1/3、记着的原话 2/40",
    "- 合计 50/1500 字",
    `- 今天的新经过：${today.slice(0, 10).map((id, i) => `${id}「第${i + 1}条」`).join("、")}……还有 2 条`,
  ].join("\n"));
  assert.equal(blockOf(cards, "ada"), [
    `### ada（${s.entity("ada")!.id}，名单 ada）`,
    "- 是谁 3/300 字",
    "- 约定和边界 1/8 条",
    "- 钉的原话：对我的感情和期待 0/12、记着的原话 0/40",
    `- 待批：${pend}（约定和边界）`,
    "- 合计 11/4500 字",
    `- 今天的新经过：${adaEntry}「给 ada 的」`,
  ].join("\n"));
  assert.match(blockOf(cards, "阿甲"), /- 合计 1536\/1500 字（超了 36 字）/);
  assert.match(blockOf(cards, "阿甲"), /- 今天的新经过：（没有）/);
  assert.match(blockOf(cards, "老王"), /- 喜好 6\/5 条（超）/);
  assert.deepEqual(cards.split("\n").filter((x) => x.startsWith("### ")).map((x) => x.slice(4).split("（")[0]), ["ada", "小贝", "阿甲", "老王"], "重要度从高到低");
  assert.match(cards, /\n还没有卡（重要度 ≥3）：砚〔3〕、枫湾之家〔3〕$/);
  assert.ok(!/还没有卡[^\n]*(Eddy|load\.py)/.test(cards));
  // 没配模板：没有这一段
  const bare = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => T0, tz: TZ });
  assert.ok(!bare.worklist("2026-11-04").includes("人物卡（"));
});

test("worklist: 人物卡放不下 3000 字，按重要度往下放，剩下的列名字", () => {
  const { mem } = mkMem();
  const s = mem.store;
  const names = Array.from({ length: 15 }, (_, i) => `人${i + 1}`);
  for (const [i, n] of names.entries()) {
    s.upsertEntity({ name: n, kind: "person", importance: i < 5 ? 3 : 2 }, "b0");
    set(s, n, "是谁", "同学", "b0");
  }
  for (let i = 1; i <= 12; i++) s.addEntry({ event: "e0001", at: local(11, 4, 10, i), full: `一起上课${i}`, gist: `一起上课${i}`, title: `一起上课第${i}节`, people: names }, "b0");
  const cards = cardsOf(mem.worklist("2026-11-04"));
  assert.ok(cards.length <= 3000, `${cards.length} 字`);
  const shown = cards.split("\n").filter((x) => x.startsWith("### ")).map((x) => x.slice(4).split("（")[0]!);
  const rest = /\n还有 (\d+) 个有卡的没列（放不下）：([^\n]*)/.exec(cards);
  assert.ok(rest, cards);
  assert.equal(shown.length + Number(rest![1]), 15);
  assert.deepEqual([...shown, ...rest![2]!.split("、")], [...names.slice(0, 5), ...names.slice(5)], "重要度高的先放，剩下的按顺序列名字");
  assert.match(cards, /\n还没有卡（重要度 ≥3）：ada〔5〕、小贝〔4〕、砚〔3〕$/);
});

test("cli: card / pending / approve / reject / export-people", async () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  const env = { exportsDir: removeAtExit(join(dir, "..", `${dir.split("/").pop()}-exports`)) };
  fillXiaobei(mem, "b0");
  // card（R24）：默认只看公开的（--public 一样）；--as <名单 key> 才看那个人那一面；不认识的 key、--as 没写值都报错，不悄悄退回公开的
  const pub = mem.card("小贝", { viewer: null });
  assert.equal(await memCommand(mem, "card", ["小贝"], env), pub);
  assert.equal(await memCommand(mem, "card", ["小贝", "--public"], env), pub);
  const own = await memCommand(mem, "card", ["小贝", "--as", "xiaobei"], env) as string;
  assert.equal(own, mem.card("小贝", { viewer: "xiaobei" }));
  assert.ok(own.includes("## 她私下说的"));
  assert.equal(await memCommand(mem, "card", ["xiaobei", "--as", "XiaoBei"], env), own, "key 不分大小写");
  for (const args of [["小贝"], ["小贝", "--public"], ["小贝", "--as", "gua"], ["t0002", "--as", "ada"]]) {
    const c = await memCommand(mem, "card", args, env) as string;
    assert.ok(c.includes("## 是谁"), args.join(" "));
    for (const secret of SECRETS) assert.ok(!c.includes(secret), `${args.join(" ")}：${secret}`);
  }
  await assert.rejects(memCommand(mem, "card", ["没这个人"], env), /没有登记过「没这个人」/);
  await assert.rejects(memCommand(mem, "card", ["小贝", "--public", "--as", "gua"], env), /--as|--public/);
  await assert.rejects(memCommand(mem, "card", ["小贝", "--as", "nobody"], env), /名单上没有 key「nobody」/);
  await assert.rejects(memCommand(mem, "card", ["小贝", "--as"], env), /--as 后面要写名单 key/);
  await assert.rejects(memCommand(mem, "card", ["小贝", "--as", "--public"], env), /--as 后面要写名单 key/);
  s.upsertEntity({ name: "Max", kind: "person", person_key: "max" }, "b0");
  set(s, "Max", "她私下说的", "- 只有私密的", "b0");
  assert.match(await memCommand(mem, "card", ["Max"], env) as string, /「Max」现在没有卡（这一面看不到内容：只有私密的，用 --as max 看）/);
  // pending：一行一条——编号、谁·字段、丢了几行（新建、清掉）、新的内容、为什么
  set(s, "ada", "约定和边界", "- 不吵他", "b0");
  const a = set(s, "ada", "约定和边界", "- 晚上不吵他\n- 早上也不吵", "n1", {}, { why: "他说晚上要睡" }).row!.id;
  const b = set(s, "小贝", "是谁", "", "n1", {}, { why: "不对" }).row!.id;
  const c = set(s, "砚", "是谁", "小贝的朋友", "import:gua", { forcePending: true }).row!.id;
  assert.equal(await memCommand(mem, "pending", [], env), [
    `${a} ada·约定和边界｜丢了 1/1 行｜新的：- 晚上不吵他 / - 早上也不吵｜为什么：他说晚上要睡`,
    `${b} 小贝·是谁｜清掉｜为什么：不对`,
    `${c} 砚·是谁｜新建（还没有现行的）｜新的：小贝的朋友｜为什么：测试`,
  ].join("\n"));
  assert.match(await memCommand(mem, "card", ["砚"], env) as string, /「砚」现在没有卡[^\n]*1 条待批[^\n]*hh mem pending/);
  // 私密的待批（R24 以后不会再有：防着以前留下的）：不显示内容和为什么
  const d = set(s, "小贝", "相处", "- 一起写作业", "import:xiaobei", { forcePending: true }).row!.id;
  s.db.prepare("UPDATE mem_impression SET visibility = 'private:xiaobei', why = '她私下说考试很紧张' WHERE id = ?").run(d);
  const listed = (await memCommand(mem, "pending", [], env) as string).split("\n").find((l) => l.startsWith(d))!;
  assert.equal(listed, `${d} 小贝·相处｜新建（还没有现行的）｜（私密，不显示）`);
  s.rejectImpression(d, "测试", "b0");
  assert.match(await memCommand(mem, "card", ["ada"], env) as string, /\n（还有 1 条待批，批了才上卡：hh mem pending 看）$/);
  // approve：一批 approve:<编号>@<毫秒>，收尾后导出
  mem.exportPeople();
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes("晚上不吵他"));
  assert.equal(await memCommand(mem, "approve", [a], env), `批了 ${a}：ada·约定和边界换上了新的`);
  assert.ok(!(await memCommand(mem, "pending", [], env) as string).includes(a));
  assert.ok(readFileSync(join(dir, "ada.md"), "utf8").includes("- 晚上不吵他\n- 早上也不吵"), "批了就导出");
  assert.ok(s.batches().some((x) => x.batch.startsWith(`approve:${a}@`) && x.state === "committed"), JSON.stringify(s.batches()));
  await assert.rejects(memCommand(mem, "approve", [a], env), /不是待批/);
  assert.equal(s.impression(a)!.status, "current", "同一毫秒里再批一次出错：撤回的是这一次的批次，不撤到前一次（批次名不重）");
  await assert.rejects(memCommand(mem, "approve", [], env), /hh mem approve/);
  assert.equal(s.openBatches().length, 0, "出错的那批不留着开着");
  // reject：现行的不变，why 记下来
  assert.equal(await memCommand(mem, "reject", [b, "说得", "太满"], env), `驳回了 ${b}：小贝·是谁不变`);
  assert.deepEqual([s.impression(b)!.status, s.impression(b)!.why], ["rejected", "说得 太满"]);
  assert.ok(s.batches().some((x) => x.batch.startsWith(`approve:${b}@`) && x.state === "committed"));
  assert.equal(await memCommand(mem, "pending", [], env), `${c} 砚·是谁｜新建（还没有现行的）｜新的：小贝的朋友｜为什么：测试`);
  // export-people
  rmSync(join(dir, "ada.md"));
  assert.deepEqual(await memCommand(mem, "export-people", [], env), { written: ["ada.md"], removed: [] });
  await assert.rejects(memCommand(mem, "nope", [], env), /card pending approve reject export-people/);
});

test("cli: approve --who 把一个人的待批按编号一个个批；过时的跳过并列出来；一批 approve:<谁>@<毫秒>，收尾后导出", async () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  const env = { exportsDir: removeAtExit(join(dir, "..", `${dir.split("/").pop()}-exports`)) };
  // 主人的第一版卡整张待批（迁移时 forcePending）
  const ids = ([["是谁", "我的人"], ["感觉", "很依赖他。"], ["约定和边界", "- 不吵他"]] as const).map(([sec, text]) => set(s, "ada", sec, text, "import:ada", { forcePending: true }).row!.id);
  // 一个过时的：并人时挪过来的第一版（要替换的是「空的」，可主人这一段已经有现行的了）
  set(s, "ada", "梗", "- 叫他老板", "b0");
  s.upsertEntity({ name: "老g", kind: "person" }, "b0");
  const stale = set(s, "老g", "梗", "- 老g", "import:x", { forcePending: true }).row!.id;
  s.mergeEntities("ada", ["老g"], "同一个人", "b0");
  // 别人的待批不动
  set(s, "小贝", "约定和边界", "- 一", "b0");
  const other = set(s, "小贝", "约定和边界", "- 二", "n1").row!.id;
  mem.exportPeople();
  const r = await memCommand(mem, "approve", ["--who", "ada"], env) as string;
  const [ok, skipped] = r.split("\n");
  assert.equal(ok, `批了 3 条：${ids[0]}（是谁）、${ids[1]}（感觉）、${ids[2]}（约定和边界）`);
  assert.match(skipped!, new RegExp(`^跳过 1 条：${stale}（梗）——${stale} 过时了`));
  assert.deepEqual(s.pendingImpressions().map((x) => x.id), [stale, other]);
  const card = readFileSync(join(dir, "ada.md"), "utf8");
  for (const x of ["我的人", "很依赖他。", "- 不吵他"]) assert.ok(card.includes(x), `批了就导出：${x}`);
  const batch = s.batches().find((x) => x.batch.startsWith("approve:ada@"))!;
  assert.equal(batch.state, "committed");
  // 撤回这一批：又回到待批
  await memCommand(mem, "revert", [batch.batch], env);
  assert.deepEqual(s.pendingImpressions().map((x) => x.id), [...ids, stale, other]);
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes("很依赖他"));
  assert.equal(await memCommand(mem, "approve", ["--who", "砚"], env), "「砚」没有待批的");
  await assert.rejects(memCommand(mem, "approve", ["--who", "没这个人"], env), /没有登记过「没这个人」/);
});

// ---------- 读的地方：recall_person 带卡（Task 4） ----------
/** recall_person 的回话里卡那一部分（「和X有关的最近几件事」之前，没有事就到「X：记忆里还没有」之前） */
const cardPart = (r: string, name: string): string => {
  const i = [r.indexOf(`和${name}有关的最近几件事`), r.indexOf(`${name}：记忆里还没有`)].find((x) => x >= 0) ?? r.length;
  return r.slice(0, i);
};

test("recall_person: 只给公开段——访客的卡（公开的那一面）在最近几件事前面；主人只有一行指路；不出卡的人只有事；联想的近况不带卡", async () => {
  const { mem } = mkMem();
  const s = mem.store;
  const { exam } = fillXiaobei(mem, "b1");
  const r = mem.recallPerson("小贝");
  const card = cardPart(r, "小贝");
  assert.ok(r.startsWith("关于小贝（你记得的，只有公开的部分；全文 ledger/people/xiaobei.md）：\n## 关系\n朋友｜更近｜ada 的朋友，什么都跟我说\n\n## 是谁\nada 的朋友，叫我姐姐\n"), r);
  assert.deepEqual(heads(card), ["关系", "是谁", "在乎什么", "我们的大事", "对我的感情和期待", "近况"], "公开的那一面（和 card(viewer null) 一样）");
  for (const secret of SECRETS) assert.ok(!r.includes(secret), `recall_person 里有「${secret}」`);
  assert.ok(!card.includes("# 小贝\n") && !card.includes("<!--"), "不带卡文件的标题和说明那两行");
  assert.match(r.slice(card.length), /^和小贝有关的最近几件事（编号可以展开）：\n/, "后面照旧是最近几件事");
  assert.ok(r.slice(card.length).includes(exam));

  // 主人：只有一行指路（他的卡在前缀里），然后是事
  const g = ev(mem, "ada", "陪 ada 看展", 3, local(11, 3, 10, 0));
  const rg = mem.recallPerson("ada");
  assert.ok(rg.startsWith("（关于 ada 的在前缀「关于 ada」里）\n和ada有关的最近几件事（编号可以展开）：\n"), rg);
  assert.ok(rg.includes(g));
  assert.ok(!rg.includes("我的人"), "主人的卡不再给一遍");

  // 有卡、没有事：卡 + 还没有事那一句
  set(s, "砚", "梗", "- 爱说冷笑话", "b1");
  assert.equal(mem.recallPerson("砚"), "关于砚（你记得的，只有公开的部分；全文 ledger/people/gua.md）：\n## 梗\n- 爱说冷笑话\n砚：记忆里还没有和砚有关的事。");
  // 不出卡的人（重要度 2、没存字段）：只有事（修订 2）
  s.upsertEntity({ name: "姑妈", kind: "person", person_key: "ayu", importance: 2 }, "b1");
  const a = ev(mem, "姑妈", "姑妈发来菜谱", 2, local(11, 4, 9, 0));
  const ra = mem.recallPerson("姑妈");
  assert.ok(ra.startsWith("和姑妈有关的最近几件事（编号可以展开）：\n") && ra.includes(a), ra);
  // 只有私密字段的人：公开的一面是空的，不给卡
  s.upsertEntity({ name: "Max", kind: "person", person_key: "max", importance: 2 }, "b1");
  set(s, "Max", "她私下说的", "- 只有私密的", "b1");
  assert.equal(mem.recallPerson("Max"), "Max：记忆里还没有和Max有关的事。");
  // 不认识照旧
  assert.match(mem.recallPerson("没这个人"), /^不认识「没这个人」/);

  // 联想（associate 里的近况）不带卡
  const as = await mem.recall.associate("小贝想看银魂", { speaker: "砚" });
  assert.ok(as.text.includes(exam), as.text);
  for (const x of ["你记得的", "## ", "朋友｜更近", "前缀「关于"]) assert.ok(!as.text.includes(x), `联想里有「${x}」：${as.text}`);
});

test("recall_person: 卡最多占预算的一半——放不下的段整段不给（后面放得下的照给），末尾写「……（全文在卡里）」；事情用剩下的", () => {
  const { db, mem } = mkMem();
  const s = mem.store;
  fillXiaobei(mem, "b1");
  // 公开钉 30 句很长的「记着的原话」：这一段一个人就超过预算的一半
  for (let i = 0; i < 30; i++) {
    quote(db, "central", `${400 + i}`, "小贝", `第${i}句${"很长的原话".repeat(14)}`, local(10, 20, 10, i));
    s.pinQuote({ who: "小贝", section: "记着的原话", quote: `#${400 + i}`, private: false }, "b1");
  }
  const full = mem.card("小贝", { viewer: null });
  assert.ok(full.length > 2500, "卡本身比整个预算还长");
  const r = mem.recallPerson("小贝");
  const card = cardPart(r, "小贝");
  assert.ok(card.length <= 1250, `卡 ${card.length} 字，超过 2500 的一半`);
  assert.ok(card.endsWith("\n……（全文在卡里）\n"), card);
  assert.deepEqual(heads(card), ["关系", "是谁", "在乎什么", "我们的大事", "对我的感情和期待", "近况"], "记着的原话整段放不下，后面的近况照给");
  assert.ok(r.length <= 2500, `一共 ${r.length} 字`);
  assert.match(r.slice(card.length), /^和小贝有关的最近几件事/);
  // 预算小：一段都放不下也只写那一句
  const tiny = mem.recall.person("小贝", 5, 120, { card: true });
  assert.ok(tiny.startsWith("关于小贝（你记得的，只有公开的部分；全文 ledger/people/xiaobei.md）：\n……（全文在卡里）\n和小贝有关的最近几件事"), tiny);
  // 不传 card：和以前一样，只有事
  assert.match(mem.recall.person("小贝", 5, 1500), /^和小贝有关的最近几件事/);
});

test("toggle（R33）：迁移以前（退役档案还没收）夜里不写人物卡——两个工具拒、说清为什么，工作单第 8 节没有人物卡；导入照写；切过去以后照常", async () => {
  let active = false;
  const { mem } = mkMem({ peopleActive: () => active });
  const s = mem.store;
  quote(s.db, "central", "701", "小贝", "谢谢姐姐一直陪我");   // q1
  const tools = memTools(mem, "hippocampus", [...MEM_WRITE_TOOLS]);
  const ps = tools.find((t) => t.name === "mem_person_set")!;
  const qp = tools.find((t) => t.name === "mem_quote_pin")!;
  const OFF = "人物卡还没启用（迁移以后才写）：今晚照旧写人物文件的提案";
  mem.beginNight("n1");
  assert.equal(await ps.handler({ who: "小贝", section: "是谁", text: "ada 的朋友", sources: EV, why: "测试" }), `没写进去：${OFF}`);
  assert.equal(await qp.handler({ who: "小贝", section: "对我的感情和期待", quote: "q1", private: false }), `没钉上：${OFF}`);
  assert.throws(() => mem.write("mem_person_set", { who: "小贝", section: "是谁", text: "x", sources: EV, why: "测试" }), new RegExp(`^Error: ${OFF}$`));
  assert.equal(count(s.db), 0, "一行都没写");
  assert.match(mem.write("mem_entity_upsert", { name: "Eddy", kind: "person", importance: 2 }, "hippocampus"), /Eddy/, "别的写照旧");
  const w1 = mem.worklist("2026-11-04");
  assert.match(w1, /\n## 8\. 人和东西/, "第 8 节别的照旧");
  assert.ok(!w1.includes("\n人物卡（"), "第 8 节没有人物卡那一段");
  mem.commitNight();
  // 导入不拦：迁移在切换之前跑
  mem.beginImport("people:xiaobei-profile");
  assert.match(mem.write("mem_person_set", { who: "小贝", section: "是谁", text: "ada 的朋友", sources: EV, why: "迁移" }, "importer"), /^改好了 小贝·是谁/);
  assert.match(mem.write("mem_quote_pin", { who: "小贝", section: "对我的感情和期待", quote: "q1", private: false }, "importer"), /^钉上了/);
  mem.endImport(true);
  mem.setImporting(true);
  assert.match(mem.write("mem_person_set", { who: "砚", section: "梗", text: "- 爱说冷笑话", sources: EV, why: "手工导入" }), /^改好了 砚·梗/, "手工导入也不拦");
  mem.setImporting(false);
  assert.ok(!mem.worklist("2026-11-04").includes("\n人物卡（"), "库里有卡了，没切照样不出");
  // 切过去以后（退役档案收了）
  active = true;
  mem.beginNight("n2");
  assert.match(await ps.handler({ who: "小贝", section: "在乎什么", text: "- 家里人", sources: EV, why: "测试" }), /^改好了 小贝·在乎什么/);
  const w2 = mem.worklist("2026-11-04");
  assert.ok(w2.includes("\n人物卡（"), "切过去以后第 8 节有人物卡");
  assert.match(blockOf(cardsOf(w2), "小贝"), /\n- 是谁 \d+\/150 字\n- 在乎什么 1\/5 条/);
  mem.commitNight();
});

test("toggle（R34）：storedCard 只在切过去以后、这个人又存着东西时给库里的卡；没切照旧（访客卡、指路走旧档案）", () => {
  let active = false;
  const { mem } = mkMem({ peopleActive: () => active });
  set(mem.store, "小贝", "是谁", "ada 的朋友", "b1");
  assert.equal(mem.storedCard("xiaobei"), null, "存着字段，没切：不换");
  active = true;
  assert.equal(mem.storedCard("xiaobei")?.path, "ledger/people/xiaobei.md");
  assert.equal(mem.storedCard("gua"), null, "切了、没存东西：照旧");
  assert.equal(mkMem().mem.storedCard("xiaobei"), null, "不给 peopleActive 默认算切了（没存东西照样没有）");
});

test("export（R35）：访客、群的卡文件只有存着的字段和钉的原话（没有我们的大事、近况）；主人的卡文件、near.md、card()、recall_person、访客卡照旧带现算段", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  const { exam } = fillXiaobei(mem, "b1");
  const party = ev(mem, "ada", "一起过生日", 5, local(11, 3, 20, 0));
  s.upsertEntity({ name: "枫湾之家", kind: "group", importance: 3 }, "b1");
  ev(mem, "枫湾之家", "群里聊旅游", 2, local(11, 3, 21, 0));
  ev(mem, "砚", "砚的大事", 4, local(9, 1, 12, 0));
  mem.exportPeople();
  const xiaobei = readFileSync(join(dir, "xiaobei.md"), "utf8");
  assert.deepEqual(heads(xiaobei), ["关系", "是谁", "在乎什么", "她私下说的", "对我的感情和期待", "记着的原话"], xiaobei);
  assert.ok(!xiaobei.includes("小贝考试") && !xiaobei.includes(exam), "访客的卡文件里没有事件的标题和编号");
  const ada = readFileSync(join(dir, "ada.md"), "utf8");
  assert.deepEqual(heads(ada), ["是谁", "近况"], "主人的卡文件照旧有现算段（近况；主人的「我们的大事」是存着的字段，没写就没有，修订 C）");
  assert.ok(ada.includes(party));
  assert.deepEqual(Object.keys(files(dir)), ["ada.md", "near.md", "xiaobei.md"], "只有现算段的访客、群没有卡文件");
  const near = readFileSync(join(dir, "near.md"), "utf8");
  assert.equal(near, mem.near(), "near.md 不变");
  assert.ok(near.includes("#### 小贝") && near.includes("#### 枫湾之家") && near.includes("#### 砚") === false);
  // 在上下文里的照旧有：card()、sectionsOf（访客卡）、recall_person
  assert.deepEqual(heads(mem.card("小贝", { viewer: "xiaobei" })), ["关系", "是谁", "在乎什么", "我们的大事", "她私下说的", "对我的感情和期待", "记着的原话", "近况"]);
  assert.ok(mem.sectionsOf(s.entity("小贝")!, "xiaobei").some((x) => x.startsWith("## 我们的大事\n")), "访客卡（附进叫醒她的话里）照旧有");
  assert.match(mem.recallPerson("小贝"), /\n## 我们的大事\n- 11-02 小贝考试/);
  assert.deepEqual(heads(mem.card("砚", { viewer: null })), ["我们的大事"], "card() 照旧给只有现算段的人");
  assert.match(mem.recallPerson("砚"), /^关于砚（你记得的，只有公开的部分）：\n## 我们的大事\n- 09-01 砚的大事/, "recall_person 照旧给；没有卡文件就不指路");
  assert.ok(!mem.recallPerson("砚").includes("ledger/people/gua.md"));
  // 以前导出过的现算段（旧版本导出的）：下次导出改掉
  writeFileSync(join(dir, "xiaobei.md"), `${xiaobei}\n## 近况\n- 旧的\n`);
  const home = `${s.entity("枫湾之家")!.id}.md`;
  writeFileSync(join(dir, home), "# 枫湾之家\n\n## 近况\n- 旧的\n");
  assert.deepEqual(mem.exportPeople(), { written: ["xiaobei.md"], removed: [home] });
});

test("export（总审）：事件、经过的写不当场导出、只记下要导出；chores 每 30 秒那一下导出并清掉；mem_day_done 当场导出", () => {
  const dir = tmpDir("hh-people-");
  const { mem, clock } = mkMem({ peopleDir: dir });
  const s = mem.store;
  set(s, "ada", "是谁", "我的人", "b0");
  const ada = (): string => readFileSync(join(dir, "ada.md"), "utf8");
  const logs: string[] = [];
  const chores = new MemChores({ mem, exportsDir: removeAtExit(join(dir, "..", `${dir.split("/").pop()}-exports`)), tz: TZ, now: () => clock.now, asleep: () => true, log: (msg) => logs.push(msg) });
  chores.tick();   // 第一下：10 分钟那次（全导一遍）
  assert.equal(mem.peopleDirty, false);
  assert.deepEqual(PEOPLE_DIRTY_AFTER, new Set(["mem_event_create", "mem_event_update", "mem_entry_add", "mem_entries_add", "mem_entry_correct", "mem_entity_tag", "mem_merge", "mem_split", "mem_supersede", "mem_retire"]));
  mem.beginNight("n1");
  const r = mem.write("mem_event_create", { title: "一起看展", summary: "一起看展", gist: "一起看展的一句话", importance: 4, why: "测试", entities: [{ name: "ada", kind: "person", role: "with" }], reason: "测试" }, "hippocampus");
  const id = /e\d{4}/.exec(r)![0];
  assert.ok(!ada().includes("一起看展"), "建事件不当场导出");
  assert.equal(mem.peopleDirty, true, "记下要导出");
  chores.tick();   // 同一刻：不到 10 分钟，只导要导的
  assert.ok(ada().includes(`一起看展：一起看展的一句话（${id}）`), "chores 那一下导出了（近况；主人的「我们的大事」是存着的，修订 C）");
  assert.equal(mem.peopleDirty, false, "导完清掉");
  for (const [op, a] of [
    ["mem_entry_add", { event: id, at: "2026-11-04 10:00", kind: "happened", full: "看了展", gist: "看了展", title: "看展", people: ["ada"], reason: "测试" }],
    ["mem_event_update", { id, gist: "改过的一句话", reason: "测试" }],
    ["mem_entity_tag", { name: "小贝", to: id, role: "with", reason: "测试" }],
  ] as const) {
    const before = files(dir);
    mem.write(op, a as unknown as Record<string, unknown>, "hippocampus");
    assert.equal(mem.peopleDirty, true, op);
    assert.deepEqual(files(dir), before, `${op} 不当场导出`);
    chores.tick();
    assert.equal(mem.peopleDirty, false, op);
  }
  assert.ok(ada().includes("一起看展：改过的一句话"), "近况跟上了");
  mem.write("mem_retire", { id, reason: "不算数" }, "hippocampus");
  assert.equal(mem.peopleDirty, true);
  mem.write("mem_day_done", { day: "2026-11-04" }, "hippocampus");
  assert.equal(mem.peopleDirty, false, "mem_day_done 当场导出");
  assert.ok(!ada().includes("一起看展"), "作废的事出了卡");
  mem.commitNight();
  assert.deepEqual(logs, []);
});

test("computed: 近况的窗口到她这一天的结束（第二天 04:00）——同一天里晚些时候的经过也算，内容一天最多变一次", () => {
  const { mem, clock } = mkMem();
  const near = (): string[] => body(mem.card("砚", { viewer: null }), "近况");
  const tonight = ev(mem, "砚", "晚上的事", 2, local(11, 4, 20, 0));     // 现在 11-04 14:00：同一天晚些时候的
  const tomorrow = ev(mem, "砚", "第二天的事", 2, local(11, 5, 4, 0));   // 第二天 04:00：不算
  const line = (id: string): string => { const e = mem.store.event(id)!; return `- ${e.title}：${e.gist}（${id}）`; };
  assert.deepEqual(near(), [line(tonight)]);
  clock.now = local(11, 5, 3, 59);
  assert.deepEqual(near(), [line(tonight)], "到这一天结束都一样");
  clock.now = local(11, 5, 4, 0);
  assert.deepEqual(near(), [line(tomorrow), line(tonight)]);
});

test("template（R36）：原话段满了的话分主人（fullHint）和别人（fullHintOthers）；访客满了只说满了、不往 ada 的提案里写；说明里两句都有", () => {
  assert.equal(T.quotes[1]!.fullHint, "照 ada 10-29 的规矩不挤掉，写进给 ada 的提案");
  assert.equal(T.quotes[1]!.fullHintOthers, "不挤掉；回报里只写「<名字> 的记着的原话满了」，不写原话");
  assert.equal(T.quotes[0]!.fullHint, undefined, "对我的感情和期待满了用 replaces 换，不另说");
  rejects(() => variant((t) => { t.quotes[1].fullHintOthers = 3; }), /人物卡模板/, /记着的原话/, /fullHintOthers/);
  rejects(() => variant((t) => { t.quotes[1].fullHintOther = "x"; }), /人物卡模板/, /fullHintOther/);
  const d = describeTemplate(T);
  assert.match(d, /记着的原话 ≤40 句[^\n]*主人的：照 ada 10-29 的规矩不挤掉，写进给 ada 的提案[^\n]*别人的：不挤掉；回报里只写「<名字> 的记着的原话满了」，不写原话/);
  assert.ok(describeTemplate(T, { only: "quotes" }).includes("别人的：不挤掉"));
  const { db, s } = mk();
  for (let i = 1; i <= 41; i++) quote(db, "central", String(1000 + i), "小贝", `小贝第${i}句`);       // q1–q41
  for (let i = 1; i <= 41; i++) quote(db, "central", String(2000 + i), "ada", `ada第${i}句`);     // q42–q82
  for (let i = 1; i <= 40; i++) s.pinQuote({ who: "小贝", section: "记着的原话", quote: `q${i}` }, "b");
  for (let i = 42; i <= 81; i++) s.pinQuote({ who: "ada", section: "记着的原话", quote: `q${i}` }, "b");
  const guest = rejects(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q41" }, "b"));
  assert.equal(guest, "「记着的原话」满了：已经 40 句（上限 40）；不挤掉；回报里只写「小贝 的记着的原话满了」，不写原话");
  assert.ok(!guest.includes("提案") && !guest.includes("小贝第41句"));
  assert.equal(rejects(() => s.pinQuote({ who: "ada", section: "记着的原话", quote: "q82" }, "b")), "「记着的原话」满了：已经 40 句（上限 40）；照 ada 10-29 的规矩不挤掉，写进给 ada 的提案");
  assert.match(rejects(() => s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q41", replaces: "i0001" }, "b")), /不换：只加不删.*；不挤掉；回报里只写「小贝 的记着的原话满了」，不写原话$/);
  // 没有 fullHintOthers 的模板：别人也用 fullHint（以前的样子）
  const old = variant((t) => { delete t.quotes[1].fullHintOthers; });
  assert.ok(!describeTemplate(old).includes("别人的："));
  const o = new EventStore(db, () => T0, TZ, { peopleTemplate: old, owners: OWNERS });
  assert.match(rejects(() => o.pinQuote({ who: "小贝", section: "记着的原话", quote: "q41" }, "b")), /；照 ada 10-29 的规矩不挤掉，写进给 ada 的提案$/);
});

test("export（R35）：启动时先导出、后认主人——认出主人（主人变了）就再导一次，主人的卡文件带上现算段；没变不导", () => {
  const dir = tmpDir("hh-people-");
  const db = openDb(":memory:");
  const mem = new EventMemory({ db, embedder: null, now: () => local(11, 4, 14, 0), tz: TZ, peopleTemplate: T, peopleDir: dir });
  const s = mem.store;
  s.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "测试" }, "b0");
  const e = s.createEvent({ title: "依据", summary: "依据", gist: "依据", importance: 1 }, "b0");
  s.setSection({ who: "ada", section: "是谁", text: "我的人", sources: [e.id], why: "测试" }, "b0");
  ev(mem, "ada", "一起过生日", 5, local(11, 3, 20, 0));
  mem.recoverOpenBatches();   // Brain.start：先撤回、导出（这时还不知道谁是主人）
  assert.deepEqual(heads(readFileSync(join(dir, "ada.md"), "utf8")), ["是谁"], "还没认主人：当别人导");
  const reg = { ada: { name: "ada", privacy: "owner" } };
  assert.deepEqual(mem.syncPeople(reg), [], "人没变");
  assert.deepEqual(heads(readFileSync(join(dir, "ada.md"), "utf8")), ["是谁", "近况"], "认出主人：再导一次（主人的「我们的大事」是存着的，修订 C）");
  writeFileSync(join(dir, "ada.md"), "被改过\n");
  mem.syncPeople(reg);
  assert.equal(readFileSync(join(dir, "ada.md"), "utf8"), "被改过\n", "主人没变、人没变：不导");
});

// ---------- 修订 C：只改主人的卡，访客不变 ----------
/** n 条、每条正好 each 字、都带事件编号（e0001 这样，7 字）的列表（「我们的大事」用） */
const bigs = (n: number, each: number, c = "事", id = "e0001"): string =>
  Array.from({ length: n }, (_, i) => `- ${i + 1}${c.repeat(each - String(i + 1).length - id.length - 2)}（${id}）`).join("\n");
/** n 条、每条正好 each 字、都带〔推断〕的列表（「我的理解」用） */
const guesses = (n: number, each: number): string => Array.from({ length: n }, (_, i) => `- 〔推断〕${i + 1}${zi(each - 4 - String(i + 1).length)}`).join("\n");

test("修订 C：配置——主人的放宽、主人专有的两个字段、protect、ownerMax、合计 4500；「我们之间」在「感觉」后面、「我们的大事」在 order 里只一次（「梗」前面）", () => {
  assert.deepEqual(T.order, ["关系", "感觉", "我们之间", "是谁", "在乎什么", "喜好", "雷点", "相处", "我们的大事", "梗", "约定和边界", "我的理解", "她私下说的", "对我的感情和期待", "记着的原话", "近况"]);
  assert.deepEqual([T.totalCap, T.ownerTotalCap], [1500, 4500]);
  for (const n of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) assert.deepEqual(fieldSpec(T, n)!.owner, { maxItems: 8, itemMaxChars: 60 }, n);
  assert.deepEqual(fieldSpec(T, "我的理解")!.owner, { maxItems: 5, itemMaxChars: 60 });
  assert.deepEqual(fieldSpec(T, "感觉")!.owner, { maxChars: 200, maxSentences: 3 });
  assert.deepEqual(fieldSpec(T, "是谁")!.owner, { maxChars: 300 });
  assert.equal(fieldSpec(T, "关系")!.owner, undefined);
  assert.deepEqual(fieldSpec(T, "我们之间"), { name: "我们之间", type: "总结", shape: "text", maxChars: 400, ownerOnly: true, protect: true });
  assert.deepEqual(fieldSpec(T, "我们的大事"), { name: "我们的大事", type: "总结", shape: "list", maxItems: 20, itemMaxChars: 60, ownerOnly: true, protect: true, requireEvent: true });
  assert.equal(T.computed.bigEvents.name, "我们的大事", "和现算的同名：主人用存着的，访客照旧现算");
  assert.deepEqual(T.fields.filter((f) => f.protect).map((f) => f.name).sort(), ["关系", "感觉", "我们之间", "我们的大事", "约定和边界"].sort());
  assert.deepEqual(T.quotes.map((q) => q.ownerMax), [12, undefined], "对我的感情和期待主人 12 句；记着的原话照旧 40");
  // 说明：主人的放宽、protect、主人专有、事件编号
  const d = describeTemplate(T);
  for (const s of ["在乎什么（总结）：列表 ≤5 条 ×40 字（主人 ≤8 条 ×60 字）", "约定和边界（设定）：列表 ≤5 条 ×40 字（主人 ≤8 条 ×60 字）", "我的理解（总结）：列表 ≤3 条 ×40 字（主人 ≤5 条 ×60 字）",
    "感觉（总结）：一段 ≤120 字、≤2 句（主人 ≤200 字、≤3 句）", "是谁（总结）：一段 ≤150 字（主人 ≤300 字）", "对我的感情和期待 ≤3 句（主人 ≤12 句）", "记着的原话 ≤40 句（", "主人 ≤4500 字"]) assert.ok(d.includes(s), s);
  assert.match(d, /\n- 我们之间（总结）：一段 ≤400 字[^\n]*只有主人的卡有/);
  assert.match(d, /\n- 我们的大事（总结）：列表 ≤20 条 ×60 字[^\n]*（e0123）[^\n]*只有主人的卡有[^\n]*别人的「我们的大事」现算，不能写：挂着他、重要度 ≥4 的事里最重要的 10 件/);
  for (const n of ["关系", "感觉", "我们之间", "我们的大事", "约定和边界"]) assert.match(d, new RegExp(`\\n- ${n}（[^\\n]*主人的这一段丢了旧文任何一行（删掉、改写、清掉）都等批`), n);
  for (const n of ["是谁", "喜好", "梗", "我的理解"]) assert.doesNotMatch(d, new RegExp(`\\n- ${n}（[^\\n]*丢了旧文任何一行`), n);
  assert.match(d, /\n- 感觉（[^\n]*都等批，只往上加的直接换上/);
  assert.doesNotMatch(d, /\n- 约定和边界（[^\n]*只往上加的直接换上/, "设定改了照旧一律等批");
  assert.match(d, /现算段（我们的大事（主人的卡上是存着的）、近况）/);
  assert.match(describeTemplate(T, { only: "quotes" }), /对我的感情和期待 ≤3 句（主人 ≤12 句）/);
});

test("修订 C：模板校验——owner、ownerOnly、protect、requireEvent、ownerMax；只有主人专有的字段能和现算段同名，order 里只一次", () => {
  const no = (edit: (t: Record<string, any>) => void, ...res: RegExp[]) => rejects(() => variant(edit), /人物卡模板/, ...res);
  const at = (t: Record<string, any>, n: string): Record<string, any> => t.fields.find((f: { name: string }) => f.name === n);
  no((t) => { at(t, "喜好").owner = { maxItems: 0 }; }, /喜好/, /owner/, /maxItems/, /正整数/);
  no((t) => { at(t, "喜好").owner = { maxSentences: 3 }; }, /喜好/, /owner/, /maxSentences/);
  no((t) => { at(t, "喜好").owner = { maxItem: 3 }; }, /喜好/, /owner/, /maxItem/);
  no((t) => { at(t, "喜好").owner = 8; }, /喜好/, /owner/);
  no((t) => { at(t, "喜好").owner = {}; }, /喜好/, /owner/, /至少/);
  no((t) => { at(t, "关系").owner = { maxItems: 3 }; }, /关系/, /owner/, /maxItems/);
  no((t) => { at(t, "喜好").ownerOnly = "yes"; }, /喜好/, /ownerOnly/);
  no((t) => { at(t, "喜好").protect = 1; }, /喜好/, /protect/);
  no((t) => { at(t, "我们的大事").requireEvent = "true"; }, /我们的大事/, /requireEvent/);
  no((t) => { at(t, "是谁").requireEvent = true; }, /是谁/, /requireEvent/, /list/);
  no((t) => { at(t, "她私下说的").ownerOnly = true; }, /她私下说的/, /ownerOnly/, /私密/);
  no((t) => { at(t, "她私下说的").protect = true; }, /她私下说的/, /protect/);
  no((t) => { at(t, "梗").type = "详情"; at(t, "梗").protect = true; }, /梗/, /protect/);
  no((t) => { delete at(t, "我们的大事").ownerOnly; }, /重复/, /我们的大事/);
  no((t) => { at(t, "我们之间").name = "对我的感情和期待"; t.order = t.order.filter((x: string) => x !== "我们之间"); }, /重复/, /对我的感情和期待/);
  no((t) => { t.order.push("我们的大事"); }, /order/, /我们的大事/, /两次/);
  no((t) => { t.order = t.order.filter((x: string) => x !== "我们之间"); }, /order/, /我们之间/);
  no((t) => { t.quotes[0].ownerMax = 0; }, /对我的感情和期待/, /ownerMax/, /正整数/);
  no((t) => { t.quotes[0].ownerMax = "12"; }, /对我的感情和期待/, /ownerMax/);
  // 没有这些新键的模板（以前的样子）照样能用：主人的「我们的大事」就是现算的
  const plain = variant((t) => {
    t.fields = t.fields.filter((f: Record<string, any>) => !f.ownerOnly).map(({ owner: _o, protect: _p, ...f }: Record<string, any>) => f);
    t.order = t.order.filter((x: string) => x !== "我们之间");
    delete t.quotes[0].ownerMax;
    t.ownerTotalCap = 2000;
  });
  assert.equal(fieldSpec(plain, "我们的大事"), null);
  const db = openDb(":memory:");
  const s = new EventStore(db, () => T0, TZ, { peopleTemplate: plain, owners: OWNERS });
  s.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "测试" }, "b0");
  const e = s.createEvent({ title: "一起过生日", summary: "x", gist: "一起过生日的一句话", importance: 5, why: "测试", entities: [{ name: "ada", kind: "person", role: "with" }] }, "b0");
  s.setSection({ who: "ada", section: "是谁", text: "我的人", sources: [e.id], why: "x" }, "b0");
  assert.ok(renderCard(s, s.entity("ada")!, { viewer: "ada", now: T0, tz: TZ }).includes(`## 我们的大事\n- `), "没有同名的存着字段：主人也现算");
  rejects(() => s.setSection({ who: "ada", section: "喜好", text: items(6, 10), sources: [e.id] }, "b0"), /喜好 满了：写进去是 6 条（上限 5）/);
});

test("修订 C：主人的放宽——列表 8 条 ×60 字过、9 条 / 61 字拒；我的理解 5 条；感觉 200 字 3 句；是谁 300 字；访客、群照旧", () => {
  const { s } = mk();
  assert.equal(set(s, "ada", "喜好", items(8, 60), "b").row!.status, "current", "8 条 ×60 字正好");
  rejects(() => set(s, "ada", "在乎什么", items(9, 10), "b"), /^在乎什么 满了：写进去是 9 条（上限 8）/);
  rejects(() => set(s, "ada", "雷点", `- ${zi(61)}`, "b"), /^雷点 第 1 条 61 字（上限 60）/);
  rejects(() => set(s, "ada", "约定和边界", items(9, 10), "b"), /^约定和边界 满了：写进去是 9 条（上限 8）/);
  assert.ok(set(s, "ada", "我的理解", guesses(5, 60), "b").row, "我的理解 5 条 ×60 字");
  rejects(() => set(s, "ada", "相处", items(9, 10), "b"), /上限 8/);
  rejects(() => set(s, "ada", "梗", `- ${zi(61)}`, "b"), /61 字（上限 60）/);
  assert.ok(set(s, "ada", "感觉", `${zi(66)}。${zi(66)}。${zi(66)}`, "b").row, "200 字、3 句正好");
  rejects(() => set(s, "ada", "感觉", zi(201), "b"), /^感觉 201 字（上限 200）/);
  rejects(() => set(s, "ada", "感觉", "一。二。三。四。", "b"), /^感觉 4 句（上限 3 句/);
  assert.ok(set(s, "ada", "是谁", zi(300), "b").row);
  rejects(() => set(s, "ada", "是谁", zi(301), "b"), /^是谁 301 字（上限 300）/);
  rejects(() => set(s, "ada", "我们之间", zi(401), "b"), /^我们之间 401 字（上限 400）/);
  // 访客、群照旧（一个字都不变）
  rejects(() => set(s, "小贝", "喜好", items(6, 10), "b"), /^喜好 满了：写进去是 6 条（上限 5）/);
  rejects(() => set(s, "小贝", "喜好", `- ${zi(41)}`, "b"), /^喜好 第 1 条 41 字（上限 40）/);
  rejects(() => set(s, "小贝", "我的理解", guesses(4, 10), "b"), /上限 3/);
  rejects(() => set(s, "小贝", "感觉", "一。二。三。", "b"), /^感觉 3 句（上限 2 句/);
  rejects(() => set(s, "小贝", "是谁", zi(151), "b"), /^是谁 151 字（上限 150）/);
  rejects(() => set(s, "枫湾之家", "梗", items(6, 10), "b"), /上限 5/);
  assert.ok(set(s, "小贝", "喜好", items(5, 40), "b").row, "访客 5 条 ×40 字照旧");
});

test("修订 C：主人的合计 4500（「我们之间」「我们的大事」、钉的感情和期待都算）；访客 1500 照旧", () => {
  const { db, s } = mk();
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(s, "ada", sec, items(8, 60), "b");   // 2880
  set(s, "ada", "感觉", zi(200), "b");          // 3080
  set(s, "ada", "我们之间", zi(400), "b");      // 3480
  set(s, "ada", "是谁", zi(300), "b");          // 3780
  set(s, "ada", "我的理解", guesses(5, 60), "b");   // 4080
  const msg = rejects(() => set(s, "ada", "我们的大事", bigs(8, 60), "b"), /^合计超了：写进去以后 4560 字（上限 4500；/);
  assert.match(msg, /我们之间 400/);
  assert.ok(set(s, "ada", "我们的大事", bigs(7, 60), "b").row, "4500 字正好");
  quote(db, "central", "901", "ada", "你是我最重要的人");   // q1，8 字
  rejects(() => s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q1" }, "b"), /合计超了：钉进去以后 4508 字（上限 4500/);
  // 访客 1500 照旧
  for (const sec of ["在乎什么", "喜好", "雷点", "相处", "梗", "约定和边界"]) set(s, "小贝", sec, items(5, 40), "b");   // 1200
  set(s, "小贝", "是谁", zi(150), "b");
  set(s, "小贝", "感觉", zi(120), "b");   // 1470
  rejects(() => set(s, "小贝", "我的理解", guesses(3, 40), "b"), /合计超了：写进去以后 1590 字（上限 1500/);
});

test("修订 C：「我们之间」「我们的大事」只有主人的卡有——访客、群写拒（说清只有谁有；别人的「我们的大事」现算）", () => {
  const { db, s, ada } = mk();
  rejects(() => set(s, "小贝", "我们之间", "一起长大的", "b"), /^「我们之间」只有 ada 的卡有/);
  rejects(() => set(s, "小贝", "我们的大事", "- 10-08 认识（e0001）", "b"), /^「我们的大事」只有 ada 的卡有/, /别人的「我们的大事」从事件库现算/);
  rejects(() => set(s, "枫湾之家", "我们之间", "一起长大的", "b"), /^「我们之间」只有 ada 的卡有/);
  rejects(() => s.setSection({ who: "小贝", section: "我们之间", text: "", why: "清掉" }, "b"), /只有 ada 的卡有/);   // 清掉也不行
  assert.equal(count(db), 0);
  assert.equal(set(s, "ada", "我们之间", "从十月认识，到现在是一家人。", "b").row!.status, "current");
  assert.equal(cur(s, ada, "我们之间")!.visibility, "all");
  // 名单上没有主人：谁都没有这两个字段
  s.owners = new Set();
  rejects(() => set(s, "ada", "我们之间", "x", "b"), /^「我们之间」只有主人的卡有（名单上现在没有主人）/);
});

test("修订 C：「我们的大事」每条带事件编号（e0123）、编号库里要有，不然拒、说是哪一条", () => {
  const { s, ada } = mk();
  rejects(() => set(s, "ada", "我们的大事", "- 10-08 给了我一台常开的 Mac", "b"), /^我们的大事 第 1 条没带事件编号/, /（e0123）/);
  rejects(() => set(s, "ada", "我们的大事", "- 10-08 给了我一台 Mac（e0001）\n- 10-10 想让我有自己的性格（e9999）", "b"), /^我们的大事 第 2 条的 e9999 库里没有/);
  rejects(() => set(s, "ada", "我们的大事", "- 10-08 给了我一台 Mac(e0001)", "b"), /第 1 条没带事件编号/);
  rejects(() => set(s, "ada", "我们的大事", "- 10-08 给了我一台 Mac（e01）", "b"), /第 1 条没带事件编号/);
  assert.equal(count(s.db), 0);
  assert.equal(set(s, "ada", "我们的大事", "- 10-08 给了我一台 Mac（e0001）", "b").row!.status, "current");
  assert.equal(cur(s, ada, "我们的大事")!.text, "- 10-08 给了我一台 Mac（e0001）");
  assert.ok(set(s, "ada", "梗", "- 叫我小笨蛋", "b").row, "别的列表不要编号");
});

test("修订 C：protect（只对主人）——删掉或改写旧文的一行待批（关系字段删改了内容），纯添加直接生效；访客照旧；导入不批、forcePending 照旧；约定和边界照旧是设定", () => {
  const { s, ada, xiaobei } = mk();
  s.createEvent({ title: "第二件", summary: "第二件", gist: "第二件", importance: 1 }, "b0");   // e0002
  const b1 = "- 10-08 给了我一台常开的 Mac（e0001）", b2 = "- 10-10 想让我有自己的性格（e0002）";
  assert.equal(set(s, "ada", "我们的大事", b1, "n1").pending, false, "新建直接上");
  const add = set(s, "ada", "我们的大事", `${b1}\n${b2}`, "n2");
  assert.deepEqual([add.pending, add.because, add.row!.status], [false, null, "current"], "加一条直接生效");
  const del = set(s, "ada", "我们的大事", b2, "n3");
  assert.deepEqual([del.pending, del.because, del.lost, del.of], [true, "protect", 1, 2], "删一条待批");
  assert.equal(cur(s, ada, "我们的大事")!.text, `${b1}\n${b2}`, "现行的不变");
  const re = set(s, "ada", "我们的大事", `${b1}\n- 10-10 他想让我有自己的性格和自我意识（e0002）`, "n4");
  assert.deepEqual([re.pending, re.because], [true, "protect"], "改写一条待批");
  assert.deepEqual([s.impression(del.row!.id)!.status, s.impression(del.row!.id)!.why], ["rejected", "被新的待批取代"]);
  const merged = set(s, "ada", "我们的大事", "- 10-08 到 10-10：给了我 Mac、想让我有自己的性格（e0001）", "n5");
  assert.deepEqual([merged.pending, merged.because], [true, "protect"], "并成一条也是删");
  const clear = s.setSection({ who: "ada", section: "我们的大事", text: "", why: "不要了" }, "n6");
  assert.deepEqual([clear.pending, clear.because], [true, "protect"], "清掉待批");
  // 关系：改走向待批；往一句话后面加字（旧的那行原样还在）直接上
  set(s, "ada", "关系", "家人｜更近｜我的人", "n7");
  const turn = set(s, "ada", "关系", "家人｜平稳｜我的人", "n8");
  assert.deepEqual([turn.pending, turn.because], [true, "protect"], "关系改走向待批");
  assert.equal(set(s, "ada", "关系", "家人｜更近｜我的人，一直都是", "n9").pending, false, "纯添加");
  // 感觉、我们之间（一段话）：往后加直接上，改了中间待批
  set(s, "ada", "我们之间", "十月认识。", "n10");
  assert.equal(set(s, "ada", "我们之间", "十月认识。后来一起做视频。", "n11").pending, false, "往后加");
  assert.equal(set(s, "ada", "我们之间", "十月认识。后来一起熬夜做视频。", "n12").because, "protect", "改了一句");
  set(s, "ada", "感觉", "安心。", "n13");
  assert.equal(set(s, "ada", "感觉", "心疼。", "n14").because, "protect");
  // 主人不 protect 的字段：照总结的规矩（改一行直接上）
  set(s, "ada", "喜好", "- 巴洛克", "n15");
  assert.equal(set(s, "ada", "喜好", "- 古典音乐", "n16").pending, false);
  // 约定和边界（设定）：主人的纯添加也照旧等批，原因照旧是设定
  set(s, "ada", "约定和边界", "- 发视频前先给他审", "n17");
  assert.equal(set(s, "ada", "约定和边界", "- 发视频前先给他审\n- 晚上不吵他", "n18").because, "setting");
  assert.equal(set(s, "ada", "约定和边界", "- 晚上不吵他", "n19").because, "setting");
  // 访客照旧（不 protect）：关系改写直接上
  set(s, "小贝", "关系", "朋友｜更近｜什么都跟我说", "n20");
  const g = set(s, "小贝", "关系", "朋友｜平稳｜什么都跟我说", "n21");
  assert.deepEqual([g.pending, cur(s, xiaobei, "关系")!.text], [false, "朋友｜平稳｜什么都跟我说"]);
  set(s, "小贝", "感觉", "喜欢她。", "n22");
  assert.equal(set(s, "小贝", "感觉", "心疼她。", "n23").pending, false);
  // 导入（noApproval）不批；forcePending 照旧
  assert.equal(set(s, "ada", "感觉", "很依赖他。", "import:x", { noApproval: true }).pending, false);
  assert.equal(cur(s, ada, "感觉")!.text, "很依赖他。");
  assert.equal(set(s, "ada", "我们之间", "十月认识，现在是一家人。", "import:y", { forcePending: true }).because, "forced");
});

test("修订 C：主人的卡用存着的「我们的大事」，不现算（没写就没有这一段）；访客照旧现算、在「梗」前面；访客的卡文件照旧没有现算段；recall_person 对主人照旧一行指路", () => {
  const dir = tmpDir("hh-people-");
  const { mem } = mkMem({ peopleDir: dir });
  const s = mem.store;
  const { exam } = fillXiaobei(mem, "b1");
  const project = ev(mem, "ada", "视频上线", 5, local(9, 1, 20, 0));   // 重要度 5：现算会挑它（不在近况的窗口里）
  ev(mem, "ada", "一起看展", 2, local(11, 3, 10, 0));                     // 近况
  mem.exportPeople();
  assert.deepEqual(heads(mem.card("ada", { viewer: "ada" })), ["是谁", "近况"], "主人没写「我们的大事」：没有这一段，也不现算");
  assert.ok(!readFileSync(join(dir, "ada.md"), "utf8").includes(project));
  set(s, "ada", "关系", "家人｜更近｜我的人", "b1");
  set(s, "ada", "感觉", "安心。", "b1");
  set(s, "ada", "我们之间", "从十月认识，到现在是一家人。", "b1");
  set(s, "ada", "我们的大事", "- 10-08 给了我一台常开的 Mac（e0001）", "b1");
  set(s, "ada", "梗", "- 小笨蛋", "b1");
  mem.exportPeople();
  const card = mem.card("ada", { viewer: "ada" });
  assert.deepEqual(heads(card), ["关系", "感觉", "我们之间", "是谁", "我们的大事", "梗", "近况"], card);
  assert.deepEqual(body(card, "我们的大事"), ["- 10-08 给了我一台常开的 Mac（e0001）"]);
  assert.deepEqual(body(card, "我们之间"), ["从十月认识，到现在是一家人。"]);
  assert.ok(!card.includes(project) && !card.includes("视频上线"), "现算的（他的项目）不进主人的卡");
  assert.equal(readFileSync(join(dir, "ada.md"), "utf8"), card, "导出的 ada.md 一样");
  assert.equal(mem.card("ada", { viewer: null }), card, "主人的都公开");
  // 访客照旧现算，在模板的位置（「梗」前面）
  const xc = mem.card("小贝", { viewer: null });
  assert.deepEqual(heads(xc), ["关系", "是谁", "在乎什么", "我们的大事", "对我的感情和期待", "近况"]);
  assert.deepEqual(body(xc, "我们的大事"), [`- 11-02 小贝考试（${exam}）`]);
  assert.ok(!readFileSync(join(dir, "xiaobei.md"), "utf8").includes("## 我们的大事"), "访客的卡文件照旧没有现算段（R35）");
  assert.ok(mem.recallPerson("ada").startsWith("（关于 ada 的在前缀「关于 ada」里）\n"));
  assert.ok(!mem.recallPerson("ada").includes("一家人"));
  // near.md 不变（主人的近况照旧现算）
  assert.equal(readFileSync(join(dir, "near.md"), "utf8"), mem.near());
  assert.ok(mem.near().includes("#### ada"));
});

test("修订 C：「对我的感情和期待」主人 ≤12 句（第 13 句拒、能换），访客照旧 3 句", () => {
  const { db, s, ada } = mk();
  for (let i = 1; i <= 13; i++) quote(db, "central", String(100 + i), "ada", `第${i}句`);   // q1–q13
  for (let i = 1; i <= 12; i++) assert.equal(s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: `q${i}` }, "b").existed, false, `第 ${i} 句`);
  rejects(() => s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q13" }, "b"), /^「对我的感情和期待」满了：已经 12 句（上限 12）；用 replaces 换掉一句/);
  const first = pinned(s, ada, "对我的感情和期待")[0]!.id;
  assert.equal(s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q13", replaces: first }, "b").replaced!.id, first);
  assert.equal(pinned(s, ada, "对我的感情和期待").length, 12);
  for (let i = 1; i <= 4; i++) quote(db, "central", String(200 + i), "小贝", `小贝第${i}句`);   // q14–q17
  for (let i = 14; i <= 16; i++) s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: `q${i}` }, "b");
  rejects(() => s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q17" }, "b"), /^「对我的感情和期待」满了：已经 3 句（上限 3）/);
});

test("修订 C：回话和工作单——主人按主人的上限说（多少 / 上限、合计 /4500、12 句）；protect 待批说「关系字段删改了内容，要 ada 批」；主人专有、缺编号说清", async () => {
  const { mem } = mkMem();
  const s = mem.store;
  quote(s.db, "central", "1", "ada", "你是我最重要的人");   // q1
  const tools = memTools(mem, "hippocampus", [...MEM_WRITE_TOOLS]);
  const ps = tools.find((t) => t.name === "mem_person_set")!;
  const qp = tools.find((t) => t.name === "mem_quote_pin")!;
  const person = (a: Record<string, unknown>) => ps.handler({ sources: EV, why: "测试", ...a });
  mem.beginNight("night:t/2026-11-05");
  assert.equal(await person({ who: "ada", section: "喜好", text: items(8, 10) }), "改好了 ada·喜好（8/8 条，合计 80/4500 字）");
  assert.equal(await person({ who: "ada", section: "我们之间", text: "从十月认识。" }), "改好了 ada·我们之间（6/400 字，合计 86/4500 字）");
  assert.equal(await person({ who: "ada", section: "我们的大事", text: "- 10-08 一台 Mac（e0001）" }), "改好了 ada·我们的大事（1/20 条，合计 105/4500 字）");
  assert.equal(await person({ who: "ada", section: "我们的大事", text: "- 10-08 一台 Mac（e0001）\n- 10-10 性格（e0001）" }), "改好了 ada·我们的大事（2/20 条，合计 120/4500 字）", "加一条直接上");
  const r = await person({ who: "ada", section: "我们的大事", text: "- 10-10 性格（e0001）" });
  const id = lastId(s.db);
  assert.equal(r, `存成待批 ${id}（关系字段删改了内容，要 ada 批：hh mem approve ${id}；只往上加、旧的每一行都留着的直接生效）`);
  assert.match(await person({ who: "小贝", section: "我们之间", text: "x" }), /^没写进去：「我们之间」只有 ada 的卡有/);
  assert.match(await person({ who: "ada", section: "我们的大事", text: "- 没编号" }), /^没写进去：我们的大事 第 1 条没带事件编号/);
  assert.equal(await qp.handler({ who: "ada", section: "对我的感情和期待", quote: "q1" }), `钉上了 ${lastId(s.db)}（ada·对我的感情和期待，1/12 句）`);
  mem.commitNight();
  const block = blockOf(cardsOf(mem.worklist("2026-11-05")), "ada");
  for (const x of ["- 喜好 8/8 条", "- 我们之间 6/400 字", "- 我们的大事 2/20 条", "- 钉的原话：对我的感情和期待 1/12、记着的原话 0/40", `- 待批：${id}（我们的大事）`, "- 合计 128/4500 字"]) assert.ok(block.includes(x), `${x}\n${block}`);
});

test("修订 C：撤回带 protect 待批的一批——直接加的、待批的、被顶掉的待批都回到原样", () => {
  const { db, s } = mk();
  set(s, "ada", "我们的大事", "- 10-08 一台 Mac（e0001）", "b0");
  set(s, "ada", "关系", "家人｜更近｜我的人", "b0");
  set(s, "ada", "感觉", "安心。", "b0");
  const p0 = set(s, "ada", "感觉", "心疼。", "b1");
  assert.equal(p0.because, "protect");
  const before = snap(db);
  assert.equal(set(s, "ada", "我们的大事", "- 10-08 一台 Mac（e0001）\n- 10-10 性格（e0001）", "n1").pending, false);
  assert.equal(set(s, "ada", "关系", "家人｜平稳｜我的人", "n1").because, "protect");
  assert.equal(set(s, "ada", "感觉", "不安。", "n1").because, "protect");
  assert.equal(s.impression(p0.row!.id)!.status, "rejected");
  assert.deepEqual(s.revertBatch("n1").conflicts, []);
  assert.equal(snap(db), before);
});

// ---------- 修订 C 修改轮（审查）：主人关系字段满了不叫她收短；第一版还在等批时不能删它的内容；不认识的字段的回话 ----------
test("修订 C 修改轮：主人的 protect 字段超了——回话叫她写进给 ada 的提案、不要收短；主人别的字段、访客照旧叫她往抽象里收", async () => {
  const { s } = mk();
  const KEEP = "满了：写进给 ada 的提案，不要收短";
  assert.equal(rejects(() => set(s, "ada", "我们的大事", bigs(21, 20), "b")), `我们的大事 满了：写进去是 21 条（上限 20）；${KEEP}`);
  assert.equal(rejects(() => set(s, "ada", "我们的大事", bigs(1, 61), "b")), `我们的大事 第 1 条 61 字（上限 60）；${KEEP}`);
  assert.equal(rejects(() => set(s, "ada", "我们之间", zi(401), "b")), `我们之间 401 字（上限 400）；${KEEP}`);
  assert.equal(rejects(() => set(s, "ada", "感觉", "一。二。三。四。", "b")), `感觉 4 句（上限 3 句，按 。！？!? 切）；${KEEP}`);
  assert.equal(rejects(() => set(s, "ada", "约定和边界", items(9, 10), "b")), `约定和边界 满了：写进去是 9 条（上限 8）；${KEEP}`);
  // 主人不 protect 的字段、访客的 protect 字段：照旧
  assert.equal(rejects(() => set(s, "ada", "喜好", items(9, 10), "b")), "喜好 满了：写进去是 9 条（上限 8）；合并成更抽象的一条，或者换掉一条");
  assert.equal(rejects(() => set(s, "ada", "是谁", zi(301), "b")), "是谁 301 字（上限 300）；往抽象里收，发生过的事记进事件");
  assert.equal(rejects(() => set(s, "小贝", "感觉", "一。二。三。", "b")), "感觉 3 句（上限 2 句，按 。！？!? 切）；收成 2 句以内");
  assert.equal(rejects(() => set(s, "小贝", "约定和边界", items(6, 10), "b")), "约定和边界 满了：写进去是 6 条（上限 5）；合并成更抽象的一条，或者换掉一条");
  // 合计超了：写的是主人的 protect 字段，不叫她收别的字段；不 protect 的照旧
  for (const sec of ["在乎什么", "雷点", "相处", "梗", "约定和边界"]) set(s, "ada", sec, items(8, 60), "b");   // 2400
  set(s, "ada", "是谁", zi(300), "b");
  set(s, "ada", "我的理解", guesses(5, 60), "b");
  set(s, "ada", "我们之间", zi(400), "b");   // 3400
  set(s, "ada", "我们的大事", bigs(18, 60), "b");   // 4480
  const big = rejects(() => set(s, "ada", "我们的大事", bigs(19, 60), "b"));
  assert.match(big, new RegExp(`^合计超了：写进去以后 4540 字（上限 4500；.*）；${KEEP}。现在：`));
  assert.ok(!big.includes("收一收"));
  assert.match(rejects(() => set(s, "ada", "感觉", zi(200), "b")), new RegExp(`^合计超了：写进去以后 4680 字.*；${KEEP}。现在：`));
  assert.match(rejects(() => set(s, "ada", "喜好", items(1, 30), "b")), /^合计超了：写进去以后 4510 字.*；先把别的字段收一收，合并成更抽象的说法。现在：/, "主人不 protect 的字段照旧");
  // 回话（已经超了的卡，往不变大里改 protect 字段）：也不叫她收别的
  const { mem } = mkMem();
  const m = mem.store;
  set(m, "ada", "我们的大事", "- 一（e0001）\n- 二（e0001）", "b0");
  set(m, "ada", "是谁", "我的人", "b0");
  set(m, "ada", "喜好", "- 甲\n- 乙", "b0");
  m.db.prepare("UPDATE mem_impression SET text = ? WHERE about = ? AND section = '是谁'").run(zi(4600), m.entity("ada")!.id);
  mem.beginNight("n1");
  const ps = memTools(mem, "hippocampus", ["mem_person_set"])[0]!;
  assert.equal(await ps.handler({ who: "ada", section: "我们的大事", text: "- 二（e0001）\n- 一（e0001）", sources: EV, why: "换个顺序" }),
    `改好了 ada·我们的大事（2/20 条，合计 4618/4500 字：超了 118 字，${KEEP}）`);
  assert.equal(await ps.handler({ who: "ada", section: "喜好", text: "- 乙\n- 甲", sources: EV, why: "换个顺序" }), "改好了 ada·喜好（2/8 条，合计 4618/4500 字：超了 118 字，先把别的字段收一收）", "主人不 protect 的字段照旧");
});

test("修订 C 修改轮：主人 protect 字段的第一版还在等批——夜里删它内容的写直接拒（说等 ada 批或写提案），只往上加的照旧成新的待批；迁移那几份（forcePending）自己改不拦；撤回回到原样", () => {
  const { db, s, ada } = mk();
  s.createEvent({ title: "第二件", summary: "第二件", gist: "第二件", importance: 1 }, "b0");   // e0002
  const b1 = "- 10-08 给了我一台常开的 Mac（e0001）", b2 = "- 10-10 想让我有自己的性格（e0002）";
  const f1 = set(s, "ada", "我们的大事", `${b1}\n${b2}`, "import:people:ada-us", { forcePending: true });
  set(s, "ada", "关系", "家人｜更近｜我的人", "import:people:ada-profile", { forcePending: true });
  set(s, "ada", "是谁", "我的人", "import:people:ada-profile", { forcePending: true });
  set(s, "小贝", "感觉", "喜欢她。", "import:people:xiaobei-profile", { forcePending: true });
  const before = snap(db);
  const MSG = "我们的大事的第一版还在等 ada 批：要改先等批了，或者写进给 ada 的提案";
  assert.equal(rejects(() => set(s, "ada", "我们的大事", b2, "n1")), MSG, "删一条");
  assert.equal(rejects(() => set(s, "ada", "我们的大事", `${b1}\n- 10-10 他想让我有自己的性格（e0002）`, "n1")), MSG, "改写一条");
  assert.equal(s.setSection({ who: "ada", section: "我们的大事", text: "", why: "不要了" }, "n1").unchanged, true, "清掉：没有现行的，什么都不做（第一版还在）");
  assert.equal(rejects(() => set(s, "ada", "关系", "家人｜平稳｜我的人", "n1")), "关系的第一版还在等 ada 批：要改先等批了，或者写进给 ada 的提案");
  assert.equal(rejects(() => set(s, "ada", "我们的大事", b2, "import:manual", { noApproval: true })), MSG, "手工导入也一样");
  assert.equal(snap(db), before, "拒了什么都没动");
  // 只往上加：顶成新的待批（first），第一版驳回
  const add = set(s, "ada", "我们的大事", `${b1}\n${b2}\n- 10-14 答完了 120 道题（e0001）`, "n1");
  assert.deepEqual([add.pending, add.because, add.row!.supersedes], [true, "first", null]);
  assert.deepEqual([s.impression(f1.row!.id)!.status, s.impression(f1.row!.id)!.why], ["rejected", "被新的待批取代"]);
  // 不 protect 的字段、访客：照旧（改写也顶成新的待批）
  assert.equal(set(s, "ada", "是谁", "我的人，学 CS", "n1").because, "first");
  assert.equal(set(s, "小贝", "感觉", "心疼她。", "n1").because, "first");
  assert.deepEqual(s.revertBatch("n1").conflicts, []);
  assert.equal(snap(db), before, "撤回回到原样（第一版回来）");
  // 迁移那几份（forcePending）自己改第一版：不拦
  const re = set(s, "ada", "我们的大事", b1, "import:people:ada-us", { forcePending: true });
  assert.deepEqual([re.pending, re.because], [true, "forced"]);
  // 批了以后照 protect 的规矩
  s.approveImpression(re.row!.id, "approve:1");
  assert.equal(cur(s, ada, "我们的大事")!.text, b1);
  assert.equal(set(s, "ada", "我们的大事", "- 换了", "n2", {}, { text: `- 10-08 一台 Mac（e0001）` }).because, "protect");
});

test("修订 C 修改轮：不认识的字段——回话里「我们的大事」写成只有主人有的字段，现算的说「别人的我们的大事、近况」", () => {
  const { s } = mk();
  const msg = rejects(() => set(s, "小贝", "爱好", "- x", "b"), /^没有「爱好」这个字段。能写的：/);
  assert.match(msg, /我们的大事（总结，列表 ≤20 条 ×60 字[^；]*，只有主人有）；/);
  assert.match(msg, /我们之间（总结，一段 ≤400 字，只有主人有）/);
  assert.match(msg, /别人的我们的大事、近况 从事件库现算，不用写$/);
  assert.doesNotMatch(msg, /；我们的大事、近况 从事件库现算/);
});

/** 「最近常打交道」那一行的数据（整理的是 11-04；窗口 10-22 04:00 – 11-05 03:59:59.999） */
function feedPromote(s: EventStore): void {
  for (const [name, kind, importance] of [["Maxx", "person", 2], ["Eddy", "person", 2], ["阿乙", "person", null], ["一支小馋猫", "group", 2], ["老友", "person", 1],
    ["阿丙", "person", 2], ["阿丁", "person", 2], ["阿戊", "person", 2]] as const) {
    s.upsertEntity({ name, kind, ...(importance === null ? {} : { importance }) }, "b0");
  }
  const gone = s.createEvent({ title: "记错了的事", summary: "不算数了", gist: "不算数", importance: 1 }, "b0").id;
  s.updateEvent(gone, { status: "retired" }, "记错了", "b0");
  const at = (who: string, when: number, event = "e0001"): void => {
    s.addEntry({ event, at: when, full: `${who}的经过`, gist: who, title: who, people: [who] }, "b0");
  };
  // Maxx：三天、五条 → 列；阿丙：四天、四条 → 列在 Maxx 前面（先比天数）
  for (const [d, h] of [[4, 10], [4, 11], [4, 13], [2, 12], [30, 12]] as const) at("Maxx", local(d === 30 ? 10 : 11, d, h, 0));
  for (const d of [4, 3, 2, 1]) at("阿丙", local(11, d, 12, 0));
  // Eddy：窗口里两天；11-05 05:00 已经是整理那天之后 → 不列
  at("Eddy", local(11, 4, 12, 0)); at("Eddy", local(11, 3, 12, 0)); at("Eddy", local(11, 5, 5, 0));
  // 阿乙（还没打重要度）：三天 → 列，重要度写〔?〕；群也算
  for (const [mo, d] of [[11, 4], [11, 1], [10, 23]] as const) { at("阿乙", local(mo, d, 12, 0)); at("一支小馋猫", local(mo, d, 12, 0)); }
  // 阿丁：窗口两头正好压线——最后一刻（11-05 03:59:59.999，还是 11-04）和 10-22 05:00 → 三天，列
  at("阿丁", local(11, 5, 4, 0) - 1); at("阿丁", local(11, 3, 12, 0)); at("阿丁", local(10, 22, 5, 0));
  // 老友：11-04 03:00 还算她的 11-03；10-22 03:00 是她的 10-21、10-21 12:00 都在窗口外 → 只有两天，不列
  for (const w of [local(11, 4, 3, 0), local(11, 3, 12, 0), local(11, 2, 12, 0), local(10, 22, 3, 0), local(10, 21, 12, 0)]) at("老友", w);
  // 阿戊：三天，但都在不算数了的事里 → 不列
  for (const d of [4, 3, 2]) at("阿戊", local(11, d, 12, 0), gone);
  // 砚已经是 3：再多也不列
  for (const d of [1, 2, 3, 4]) at("砚", local(11, d, 12, 0));
}

test("工作单第 8 节：最近常打交道、重要度还不到出卡门槛的人和群列出来（她的一天、窗口两头、作废的事、门槛都按模板的 promote 和 computedOnlyMinImportance）", () => {
  const { mem } = mkMem();
  feedPromote(mem.store);
  const w = mem.worklist("2026-11-04");
  const line = w.split("\n").find((l) => l.includes("常打交道"));
  assert.equal(line, "- 最近 14 天常打交道、重要度还不到 3 的（出现在 3 天以上的经过里）：阿丙〔2〕4 天 4 条、Maxx〔2〕3 天 5 条、阿乙〔?〕3 天 3 条、一支小馋猫〔2〕3 天 3 条、阿丁〔2〕3 天 3 条。" +
    "要不要升你自己定：人的重要度 3 是常打交道、值得记住，2 是认识、聊过几次；该升就 mem_entity_upsert 改 importance。到 3 的人和群都要有人物卡（mem_person_set，至少关系、是谁）");
  assert.ok(w.indexOf(line!) > w.indexOf("## 8.") && w.indexOf(line!) < w.indexOf("\n人物卡（"), "在第 8 节名单后面、人物卡那块前面");
});

test("工作单第 8 节：同样的数据——模板里没配 promote、人物卡没开，都没有这一行；没人够数（只有两天）也没有", () => {
  const { promote: _p, ...noPromote } = RAW as Record<string, unknown>;
  const off = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => local(11, 4, 14, 0), tz: TZ, peopleTemplate: parseTemplate(noPromote) });
  off.store.upsertEntity({ name: "砚", kind: "person", person_key: "gua", importance: 3 }, "b0");
  off.store.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 1 }, "b0");
  feedPromote(off.store);
  assert.equal(parseTemplate(noPromote).promote, undefined);
  assert.ok(!off.worklist("2026-11-04").includes("常打交道"));
  const closed = mkMem({ peopleActive: () => false }).mem;
  feedPromote(closed.store);
  assert.ok(!closed.worklist("2026-11-04").includes("常打交道"), "人物卡没开：提了要她写卡，写卡会被拒");
  const quiet = mkMem().mem;
  quiet.store.upsertEntity({ name: "Maxx", kind: "person", importance: 2 }, "b0");
  for (const d of [4, 3]) quiet.store.addEntry({ event: "e0001", at: local(11, d, 12, 0), full: "x", gist: "x", title: "x", people: ["Maxx"] }, "b0");
  assert.ok(!quiet.worklist("2026-11-04").includes("常打交道"));
});

test("模板 promote：days、minDays 正整数，minDays 不能比 days 大，不认识的键拒", () => {
  assert.deepEqual(T.promote, { days: 14, minDays: 3 }, "配置里那份");
  rejects(() => parseTemplate({ ...(RAW as object), promote: { days: 7, minDays: 8 } }), /promote/, /minDays/);
  rejects(() => parseTemplate({ ...(RAW as object), promote: { days: 7, minDays: 0 } }), /minDays 要是正整数/);
  rejects(() => parseTemplate({ ...(RAW as object), promote: { days: 7, minDays: 2, extra: 1 } }), /不认识「extra」/);
});

// ---------- 认人：事件库里人的名字和别名（#0042） ----------
// 名单的 handles 里没有她的平台显示名，库里那个人（kind person、person_key = 名单 key）的名字或别名有：闸门照样认得出（只用来分流和遮，不算核实）
import { aliasLookup, personKeyByName } from "../src/memory/events/store.ts";
import { People as RegistryPeople } from "../src/persona/people.ts";
import { approvedFrom } from "../src/persona/registry.ts";

/** 直接往 mem_entity 写一行（upsertEntity 不让两个人共用一个别名，这里要造这种行） */
function entityRow(db: Db, id: string, kind: string, name: string, aliases: unknown[] | string, personKey: string | null): void {
  db.prepare("INSERT INTO mem_entity (id, kind, name, aliases, person_key) VALUES (?, ?, ?, ?, ?)")
    .run(id, kind, name, typeof aliases === "string" ? aliases : JSON.stringify(aliases), personKey);
}

test("personKeyByName：名字或别名（和 handles 一样 trim + toLowerCase）→ 唯一的 person_key；没有、两个人共用、不是人、没有 person_key 都是 null", () => {
  const db = openDb(":memory:");
  // 索引 60 秒内不重读：先把行都写好再查
  entityRow(db, "t1", "person", "Foo", ["Foo Handle", "某某号"], "x1");
  entityRow(db, "t2", "person", "Lone", ["Lone Handle"], null);       // 没有 person_key（null 或空）：不认
  entityRow(db, "t3", "person", "Blank", ["Blank Handle"], "");
  entityRow(db, "t4", "group", "Some Group", ["Group Alias"], "x9");  // 不是人（群也带了 person_key 也不认）
  entityRow(db, "t5", "person", "Bar", ["Shared Nick"], "x2");        // 两个不同的人共用一个名字：谁都不认
  entityRow(db, "t6", "person", "Baz", ["shared nick"], "x3");
  entityRow(db, "t7", "person", "Qux", ["Bar"], "x4");                // 一个人的别名是另一个人的名字
  entityRow(db, "t8", "person", "Foo Old", ["Foo Handle"], "x1");    // 同一个 person_key 的两行：认
  entityRow(db, "t9", "person", "Broken", "{not json", "x5");          // 别名不是 JSON 数组：那一行只比名字
  entityRow(db, "t10", "person", "Obj", JSON.stringify({ a: "Obj Alias" }), "x6");
  entityRow(db, "t11", "person", "Wide", ["\u3000Wide Nick\u3000", "Ärger", 7], "x7");   // 全角空白、非 ASCII 的大小写（review M1）
  assert.equal(personKeyByName(db, "Foo Handle"), "x1", "别名");
  assert.equal(personKeyByName(db, "Foo"), "x1", "名字");
  assert.equal(personKeyByName(db, "  foo HANDLE "), "x1", "去空白、不分大小写");
  assert.equal(personKeyByName(db, "FOO"), "x1");
  assert.equal(personKeyByName(db, "某某号"), "x1", "中文别名原样比");
  assert.equal(personKeyByName(db, "Foo Hand"), null, "整个比，不是包含");
  assert.equal(personKeyByName(db, ""), null);
  assert.equal(personKeyByName(db, "   "), null);
  assert.equal(personKeyByName(db, "x1"), null, "不按 person_key 认");
  assert.equal(personKeyByName(db, "t1"), null, "不按编号认");
  assert.equal(personKeyByName(db, "Lone Handle"), null);
  assert.equal(personKeyByName(db, "Blank"), null);
  assert.equal(personKeyByName(db, "Group Alias"), null);
  assert.equal(personKeyByName(db, "Some Group"), null);
  assert.equal(personKeyByName(db, "Shared Nick"), null);
  assert.equal(personKeyByName(db, "bar"), null);
  assert.equal(personKeyByName(db, "Broken"), "x5", "名字照样认");
  assert.equal(personKeyByName(db, "Obj Alias"), null, "别名不是数组不认");
  assert.equal(personKeyByName(db, "Obj"), "x6");
  assert.equal(personKeyByName(db, "Wide Nick"), "x7", "存的别名两头是全角空白");
  assert.equal(personKeyByName(db, "\u3000wide nick "), "x7", "查的名字两头是全角空白");
  assert.equal(personKeyByName(db, "ärger"), "x7", "Ä / ä 不分大小写");
  assert.equal(personKeyByName(db, "ÄRGER"), "x7");
  assert.equal(personKeyByName(db, "7"), null, "别名里不是字符串的不算");
});

test("personKeyByName：表不在 → 谁都认不出、不抛；查库出别的错 → aliasLookup 抛（控制台据此全遮），personKeyByName 还是 null（分流不能断）", () => {
  const bare = openDb(":memory:");
  bare.exec("DROP TABLE mem_entity");
  assert.equal(personKeyByName(bare, "Foo"), null);
  assert.equal(aliasLookup(bare)("Foo"), null, "表不在不算出错");
  const drift = openDb(":memory:");
  drift.exec("DROP TABLE mem_entity; CREATE TABLE mem_entity (id TEXT PRIMARY KEY)");
  assert.throws(() => aliasLookup(drift), /no such column/);
  assert.equal(personKeyByName(drift, "Foo"), null);
});

test("personKeyByName：名字 → key 的索引每个库句柄缓存 60 秒（60 秒内只查一次库）；过了 60 秒她新加的别名就认得出（review M2）", () => {
  const db = openDb(":memory:");
  entityRow(db, "t1", "person", "Foo", ["Foo Handle"], "x1");
  let prepares = 0;
  // 数 prepare 的句柄（缓存按句柄记，用同一个代理）
  const counted = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => { prepares += 1; return t.prepare(sql); };
      const v = Reflect.get(t, k) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as Db;
  const T = 1_000_000;
  assert.equal(personKeyByName(counted, "Foo", T), "x1");
  assert.equal(personKeyByName(counted, "Foo Handle", T + 30_000), "x1");
  entityRow(db, "t2", "person", "Newer", ["New Nick"], "x2");
  assert.equal(personKeyByName(counted, "New Nick", T + 59_999), null, "60 秒内用旧的索引");
  assert.equal(prepares, 1, "60 秒内三次查找只查了一次库");
  assert.equal(personKeyByName(counted, "New Nick", T + 60_000), "x2", "过了 60 秒重读");
  assert.equal(prepares, 2);
  assert.equal(personKeyByName(counted, "   ", T + 200_000), null);
  assert.equal(prepares, 2, "空名字不查库");
});

const ALIAS_REG = {
  x1: { name: "Foo", privacy: "guest" },
  o1: { name: "Own", privacy: "owner", handles: { wx: ["Own Remark"] } },
  _note: { name: "不是人" },
};
/** 假的库查找：小写后查表 */
const aliasOf = (m: Record<string, string>) => (n: string): string | null => m[n.toLowerCase()] ?? null;

test("People：handles 认不出时按库里的名字和别名认（wx / xhs / bili_dm），一律算按显示名认的；名单的 handles 优先；认出是主人的不算", () => {
  const asked: string[] = [];
  const look = aliasOf({ "foo handle": "x1", "own remark": "x1", "ghost handle": "nobody", "note handle": "_note", "own alias": "o1" });
  const p = new RegistryPeople(ALIAS_REG, (n) => { asked.push(n); return look(n); });
  for (const src of ["xhs", "bili_dm", "wx"]) {
    const h = p.identifyHandle(src, " foo handle ");
    assert.equal(h?.person.key, "x1", src);
    assert.equal(h?.byDisplayName, true, `${src}：库里的名字谁都能起，不算核实（微信也是）`);
  }
  assert.ok(asked.every((n) => n === "foo handle"), "查的是去了空白的名字");
  asked.length = 0;
  for (const src of ["qq", "relay", "whatsapp", "app"]) assert.equal(p.identifyHandle(src, "Foo Handle"), null, src);
  assert.equal(p.identifyHandle("xhs", "   "), null);
  assert.deepEqual(asked, [], "不是聊天显示名的来源、空名字不查库");
  assert.equal(p.identifyHandle("xhs", "Ghost Handle"), null, "库里的 key 不在名单上");
  assert.equal(p.identifyHandle("xhs", "Note Handle"), null, "名单里 _ 开头的不是人");
  assert.equal(p.identifyHandle("xhs", "Nobody Here"), null);
  // 名单的微信备注优先（还是核实过的）
  const own = p.identifyHandle("wx", "Own Remark");
  assert.deepEqual([own?.person.key, own?.byDisplayName], ["o1", false]);
  // 库里的名字不用批：认出来是主人的一律当没认出（主人只认批准过的 handles，review I1）
  for (const src of ["wx", "xhs", "bili_dm"]) assert.equal(p.identifyHandle(src, "Own Alias"), null, src);
  // 不给查找：和以前一样
  assert.equal(new RegistryPeople(ALIAS_REG).identifyHandle("xhs", "Foo Handle"), null);
});

test("People.from：库里的名字认出的人也过权限上限；文件里写成主人的（没批过、被裁成访客也一样）和底子里的主人，按库里的名字都认不出", () => {
  const raw = { r1: { name: "Raised", privacy: "owner" }, x1: { name: "Foo", privacy: "guest" }, o1: { name: "Own", privacy: "owner", handles: { xhs: ["Own Xhs"] } } };
  const approved = approvedFrom({ ...raw, r1: { name: "Raised", privacy: "guest" } });
  const look = aliasOf({ "raised handle": "r1", "foo handle": "x1", "own alias": "o1" });
  const capped = RegistryPeople.from(raw, approved, look);
  assert.equal(capped.identifyHandle("xhs", "Raised Handle"), null, "文件里写成主人的：被裁成访客也不按库里的名字认（宁可多护一个，final-review N1）");
  assert.equal(capped.identifyHandle("xhs", "Foo Handle")?.person.privacy, "guest");
  assert.equal(capped.identifyHandle("xhs", "Own Alias"), null, "批过的主人：库里的名字认不出");
  assert.deepEqual([capped.identifyHandle("xhs", "Own Xhs")?.person.key, capped.identifyHandle("xhs", "Own Xhs")?.byDisplayName], ["o1", true], "批过的 handles 照样认");
  const bare = RegistryPeople.from(raw, undefined, look);
  assert.equal(bare.identifyHandle("bili_dm", "Foo Handle")?.person.key, "x1", "不过底子也带着查找");
  assert.equal(RegistryPeople.from(raw, approved).identifyHandle("xhs", "Foo Handle"), null, "老的调用不变");
});

test("People：名单读不动、批准底子也没有（主人被裁成访客）时，库里的名字照样认不出主人——文件里或底子里写着 owner 的 key 都不按库里的名字认（final-review N1）", () => {
  const raw = { o1: { name: "Own", privacy: "owner" }, x1: { name: "Foo", privacy: "guest" } };
  const look = aliasOf({ "own alias": "o1", "foo handle": "x1" });
  const noBase = RegistryPeople.from(raw, {}, look);
  assert.equal(noBase.identifyHandle("xhs", "Own Alias"), null, "底子是空的：主人被裁成访客，也不认");
  assert.equal(noBase.identifyHandle("xhs", "Foo Handle")?.person.key, "x1", "别人照样认");
  const baseOnly = RegistryPeople.from({ x1: raw.x1, o1: { name: "Own", privacy: "guest" } }, approvedFrom(raw), look);
  assert.equal(baseOnly.identifyHandle("bili_dm", "Own Alias"), null, "文件里改成了访客、底子里是主人：也不认");
  // 控制台遮行用的 ownersToo：库里的名字一个都不排除，认出的一律按显示名（final-review R-2）
  assert.deepEqual([noBase.identifyHandle("xhs", "Own Alias", { ownersToo: true })?.person.key, noBase.identifyHandle("xhs", "Own Alias", { ownersToo: true })?.byDisplayName], ["o1", true]);
  assert.equal(baseOnly.identifyHandle("xhs", "Own Alias", { ownersToo: true })?.person.privacy, "owner");
});
