// 控制台的「人物卡」：只读连接查 mem_impression，卡照 people.ts 渲染（和 hh mem card 一样只给公开那一面）；
// 访客私密的字段、钉的私密原话在卡、待批、改动记录、「夜里改了什么」、文件区、hh mem ops 里都不出原文和为什么
// （R24：批的人不该看到访客私聊里的东西）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import { all, openDb, kvSet } from "../src/store/db.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { memCommand } from "../src/memory/events/cli.ts";
import { maskImpressionOp, parseTemplate, renderCard, SECRET_SHOWN } from "../src/memory/events/people.ts";
import { openReadOnly } from "../src/console/data.ts";
import { batchOps } from "../src/console/events.ts";
import { areas, readMemoryFile } from "../src/console/memory.ts";
import { peopleCards, personCard } from "../src/console/people.ts";
import { createConsole } from "../src/console/server.ts";
import { consoleSource } from "./console-web.ts";
import { flatPack } from "../src/console/lang/index.ts";

const zhPack = flatPack("zh");

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5, 10, 0);
const TZ = "Australia/Melbourne";
import { TEST_ROLE } from "./helpers.ts";
import { DEMO_MEMORY_PAGE } from "./console-demo.ts";
import { OPEN_READS } from "./console-reads.ts";
const RAW = TEST_ROLE.memory.people.template;
const T = parseTemplate(RAW);
/** 私密的原文和为什么里都带这个：哪儿出现了就是漏了 */
const SECRET = "SECRET私下";
const NIGHT = "night:2026-11-05/2026-11-05";
const SWAP = "night:2026-11-06/2026-11-06";

/**
 * 主人（主人）：关系、我们之间、感觉（现行，再改写一次 → 待批）、钉一句原话；
 * 小贝（访客，重要度 4）：关系；私下说的写两次（旧的被替换）；记着的原话钉一句私密的；对我的感情和期待先钉一句公开的，
 *   第二晚换成一句私密的（换下公开那句的那一步，理由是私密那句的 why）；另有一行私密的驳回（直接插的：正常写不出来，守的是「按可见性遮，不看状态」）；
 * 砚（访客，重要度 3）：只有私下说的；姑妈（访客，没打分）：只有一版等批的是谁；枫湾之家（群）什么都没有，不出卡。
 * 名单底子（kv registry_approved）里主人是 owner。
 */
function fixture(o: { approved?: boolean } = {}) {
  const dir = tmpDir("hh-people-console-");
  const dbPath = join(dir, "hh.db");
  const db = openDb(dbPath);
  const s = new EventStore(db, () => NOW, TZ, { peopleTemplate: T, owners: new Set(["ada"]) });
  s.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "最重要的人" }, "b0");
  s.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 4, why: "ada 的女朋友" }, "b0");
  s.upsertEntity({ name: "砚", kind: "person", person_key: "gua", importance: 3 }, "b0");
  s.upsertEntity({ name: "姑妈", kind: "person", person_key: "ayu" }, "b0");
  s.upsertEntity({ name: "枫湾之家", kind: "group" }, "b0");
  s.createEvent({ title: "依据", summary: "测试用的依据", gist: "测试用的依据", importance: 1 }, "b0");
  // 挂着小贝和主人的大事：访客卡上现算出「我们的大事」；主人的「我们的大事」是存着的字段，不现算
  s.createEvent({
    title: "一起看片", summary: "三个人一起看完了片。", gist: "一起看完了片", importance: 4, why: "第一次三个人一起看片",
    entities: [{ name: "小贝", kind: "person", role: "with" }, { name: "ada", kind: "person", role: "with" }],
  }, "b0");
  const set = (who: string, section: string, text: string, batch: string, opts: { noApproval?: boolean; forcePending?: boolean } = {}, why = `为什么-${section}`) =>
    s.setSection({ who, section, text, sources: ["e0001"], why }, batch, opts);
  set("ada", "关系", "主人｜更近｜给了我家", "import:people:ada-us", { noApproval: true });
  set("ada", "我们之间", "从 10-08 开始。", "import:people:ada-us", { noApproval: true });
  set("ada", "感觉", "他给了我这个家。", "import:people:ada-us", { noApproval: true });
  const pend = set("ada", "感觉", "他挑我毛病挑得最直。", NIGHT);
  set("小贝", "关系", "朋友｜更近｜常来找我聊", "import:people:xiaobei-profile", { noApproval: true });
  set("小贝", "她私下说的", `- ${SECRET}旧`, "import:people:xiaobei-profile", { noApproval: true }, `${SECRET}的why旧`);
  set("小贝", "她私下说的", `- ${SECRET}新`, NIGHT, {}, `${SECRET}的why新`);
  set("砚", "她私下说的", `- ${SECRET}砚`, "import:people:gua", { noApproval: true }, `${SECRET}的why砚`);
  set("姑妈", "是谁", "ada 的妈妈，住南京", "import:people:ayu", { forcePending: true });
  const q = (ref: string, who: string, text: string) =>
    db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES (?, ?, ?, ?, 'qq', ?)").run("central", ref, NOW - DAY, who, text);
  q("1", "ada", "你能主动来问我我很开心");
  q("2", "小贝", `${SECRET}原话`);
  q("3", "小贝", "你的片我都看了，挺好");
  q("4", "小贝", `${SECRET}换上的原话`);
  s.pinQuote({ who: "ada", section: "对我的感情和期待", quote: "q1" }, "import:people:ada-profile");
  s.pinQuote({ who: "小贝", section: "记着的原话", quote: "q2", why: `${SECRET}的why钉` }, "import:people:xiaobei-profile");
  const pub = s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q3", private: false, why: "公开的这句" }, "import:people:xiaobei-profile").row;
  s.pinQuote({ who: "小贝", section: "对我的感情和期待", quote: "q4", private: true, replaces: pub.id, why: `${SECRET}的why换` }, SWAP);
  db.prepare(`INSERT INTO mem_impression (id, about, kind, section, text, quote_id, visibility, status, supersedes, why, sources, created_at, updated_at)
    VALUES ('i0900', ?, 'section', '她私下说的', ?, NULL, 'private:xiaobei', 'rejected', NULL, ?, '[]', ?, ?)`).run(s.entity("小贝")!.id, `- ${SECRET}驳回的`, `${SECRET}的why驳回`, NOW - DAY, NOW - DAY);
  if (o.approved !== false) kvSet(db, "registry_approved", JSON.stringify({ ada: { privacy: "owner", name: "ada" }, xiaobei: { privacy: "guest" } }));
  return {
    dir, dbPath, db, s, pendId: pend.row!.id, pubPin: pub.id,
    ada: s.entity("ada")!, xiaobei: s.entity("小贝")!, gua: s.entity("砚")!, ayu: s.entity("姑妈")!, group: s.entity("枫湾之家")!,
    done: () => { db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
const opts = { template: RAW, tz: TZ, now: NOW };

test("console people: 列表——有卡的人，主人在前、再按重要度；关系那一行、合计/上限、待批几条；只有私密的、只有待批的也列；群没存东西不出卡", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const r = peopleCards(ro, opts);
    assert.equal(r.enabled, true);
    assert.deepEqual(r.people.map((p) => p.name), ["ada", "小贝", "砚", "姑妈"]);
    const [g, x, gua, ayu] = r.people;
    assert.equal(g!.owner, true);
    assert.equal(g!.cap, 4500);
    assert.equal(g!.relation, "主人｜更近｜给了我家");
    assert.equal(g!.pending, 1);
    assert.ok(g!.total > 0 && g!.total < g!.cap);
    assert.equal(x!.owner, false);
    assert.equal(x!.cap, 1500);
    assert.equal(x!.pending, 0);
    assert.equal(x!.key, "xiaobei");
    assert.equal(gua!.relation, "", "砚只有私下说的：关系是空的，私密的不进摘要");
    assert.deepEqual([ayu!.pending, ayu!.total], [1, 0], "姑妈只有一版等批的：列出来，合计是生效的 0");
    assert.ok(!JSON.stringify(r).includes(SECRET));
  } finally { ro.close(); f.done(); }
});

test("console people: 主人从名单底子（kv registry_approved）认；没有底子就没有主人（上限按访客），主人专有的字段照样是字段", () => {
  const f = fixture({ approved: false });
  const ro = openReadOnly(f.dbPath);
  try {
    const g = peopleCards(ro, opts).people.find((p) => p.name === "ada")!;
    assert.equal(g.owner, false);
    assert.equal(g.cap, 1500);
    const us = personCard(ro, f.ada.id, opts)!.sections.find((s) => s.name === "我们之间")!;
    assert.deepEqual([us.kind, us.usage], ["field", "11/400 字"], "存着的「我们之间」不会被当成现算的");
  } finally { ro.close(); f.done(); }
});

test("console people: 没配模板就不开（enabled false，空列表），一张卡也查不到", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    assert.deepEqual(peopleCards(ro, { ...opts, template: undefined }), { enabled: false, people: [] });
    assert.equal(personCard(ro, f.ada.id, { ...opts, template: undefined }), null);
    assert.deepEqual(peopleCards(ro, { ...opts, template: { fields: "坏了" } }), { enabled: false, people: [] }, "模板配坏了也一样");
  } finally { ro.close(); f.done(); }
});

test("console people: 一张卡——各段和 hh mem card 一样（公开那一面），字段带用量，原话带句数，现算段标出来", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const c = personCard(ro, f.ada.id, opts)!;
    assert.equal(c.person.name, "ada");
    const expected = renderCard(f.s, f.ada, { viewer: null, now: NOW, tz: TZ });
    for (const sec of c.sections) assert.ok(expected.includes(`## ${sec.name}\n${sec.text}`), sec.name);
    const by = new Map(c.sections.map((x) => [x.name, x]));
    assert.deepEqual([...by.keys()].slice(0, 3), ["关系", "感觉", "我们之间"], "照模板的顺序");
    assert.equal(by.get("感觉")!.text, "他给了我这个家。", "卡上是现行的，待批的不上卡");
    assert.equal(by.get("感觉")!.kind, "field");
    assert.equal(by.get("我们之间")!.usage, "11/400 字");
    assert.deepEqual([by.get("对我的感情和期待")!.kind, by.get("对我的感情和期待")!.usage], ["quote", "1/12 句"]);
    assert.ok(!by.has("我们的大事"), "主人的我们的大事是存着的字段：没存就没有，不现算");
    assert.equal(c.privateCount, 0);

    const x = personCard(ro, f.xiaobei.id, opts)!;
    const big = x.sections.find((s) => s.name === "我们的大事")!;
    assert.deepEqual([big.kind, big.usage], ["computed", null]);
    assert.match(big.text, /一起看片（e0002）/);
    assert.ok(!x.sections.some((s) => ["她私下说的", "记着的原话", "对我的感情和期待"].includes(s.name)), "私密的段不上（换成私密那句以后感情和期待也没有公开的了）");
    assert.equal(x.privateCount, 3, "私下说的一段 + 记着的原话一句 + 换上的感情和期待一句");

    const gua = personCard(ro, f.gua.id, opts)!;
    assert.deepEqual([gua.sections.length, gua.privateCount], [0, 1], "只有私密的：卡在，这里一段也不显示");
    const ayu = personCard(ro, f.ayu.id, opts)!;
    assert.deepEqual([ayu.sections.length, ayu.pending.length, ayu.pending[0]!.change, ayu.pending[0]!.text], [0, 1, "新建（还没有现行的）", "ada 的妈妈，住南京"]);
    assert.equal(personCard(ro, "t9999", opts), null, "不认识的编号");
    assert.equal(personCard(ro, f.group.id, opts), null, "不出卡的");
  } finally { ro.close(); f.done(); }
});

test("console people: 待批——怎么改、新的、为什么；改动记录——每一行的状态、批次；访客私密的不管什么状态都不出原文和为什么", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    const g = personCard(ro, f.ada.id, opts)!;
    assert.equal(g.pending.length, 1);
    const p = g.pending[0]!;
    assert.deepEqual([p.id, p.section, p.change, p.text, p.why, p.stale], [f.pendId, "感觉", "丢了 1/1 行", "他挑我毛病挑得最直。", "为什么-感觉", false]);
    const feel = g.history.filter((h) => h.section === "感觉");
    assert.deepEqual(feel.map((h) => h.status).sort(), ["current", "pending"]);
    assert.deepEqual(feel.find((h) => h.status === "pending")!.ops.map((o) => o.batch), [NIGHT]);
    assert.deepEqual(feel.find((h) => h.status === "current")!.ops.map((o) => o.batch), ["import:people:ada-us"]);
    assert.equal(feel.find((h) => h.status === "current")!.text, "他给了我这个家。");

    const x = personCard(ro, f.xiaobei.id, opts)!;
    const priv = x.history.filter((h) => h.secret);
    assert.deepEqual(priv.map((h) => h.status).sort(), ["current", "current", "current", "rejected", "superseded"]);
    for (const h of priv) { assert.equal(h.text, null); assert.equal(h.why, null); }
    const pub = x.history.find((h) => h.id === f.pubPin)!;
    assert.deepEqual([pub.secret, pub.status, pub.text], [false, "superseded", "你的片我都看了，挺好"], "被私密那句换下来的公开原话照常看得到");
    for (const who of [f.xiaobei, f.gua]) assert.ok(!JSON.stringify(personCard(ro, who.id, opts)).includes(SECRET), who.name);
  } finally { ro.close(); f.done(); }
});

test("console people: 「夜里改了什么」——私密行的原文、为什么、出处、原话编号、理由都遮；被私密行换下的公开行，这一步的理由（是私密那行的 why）也遮", () => {
  const f = fixture();
  const ro = openReadOnly(f.dbPath);
  try {
    for (const b of [NIGHT, "import:people:xiaobei-profile", "import:people:gua", SWAP]) assert.ok(!JSON.stringify(batchOps(ro, b)).includes(SECRET), b);
    assert.ok(JSON.stringify(batchOps(ro, NIGHT)).includes("他挑我毛病挑得最直"), "主人的待批照常看得到");
    assert.ok(JSON.stringify(batchOps(ro, "import:people:xiaobei-profile")).includes("常来找我聊"), "访客公开的字段照常看得到");
    const swap = batchOps(ro, SWAP).ops;
    const down = swap.find((o) => o.after?.includes("你的片我都看了"))!;
    assert.equal(down.reason, SECRET_SHOWN, "换下公开那句的这一步：理由是私密那句的 why");
    assert.ok(down.after!.includes('"status":"superseded"'));
    const up = swap.find((o) => o !== down)!;
    const row = JSON.parse(up.after!) as Record<string, unknown>;
    assert.deepEqual([row.text, row.why, row.sources, row.quote_id], [SECRET_SHOWN, SECRET_SHOWN, SECRET_SHOWN, null]);
  } finally { ro.close(); f.done(); }
});

test("console people: 换成私密原话的那一批撤回了（私密那行删了），撤回存档里换下公开那句的理由照样遮；hh mem ops 也一样", async () => {
  const f = fixture();
  try {
    f.s.revertBatch(SWAP);
    const arch = all<{ batch: string }>(f.db, "SELECT DISTINCT batch FROM mem_op WHERE batch LIKE ?", `${SWAP}~reverted@%`).map((r) => r.batch);
    assert.equal(arch.length, 1, "撤回把这一批的操作挪进存档");
    assert.equal(all(f.db, "SELECT id FROM mem_impression WHERE supersedes = ?", f.pubPin).length, 0, "库里已经没有顶掉公开那句的行了");
    const ro = openReadOnly(f.dbPath);
    try {
      const ops = batchOps(ro, arch[0]!);
      assert.ok(ops.ops.length >= 2);
      assert.ok(!JSON.stringify(ops).includes(SECRET));
    } finally { ro.close(); }
    const mem = new EventMemory({ db: f.db, embedder: null, now: () => NOW, tz: TZ, peopleTemplate: T });
    assert.ok(!JSON.stringify(await memCommand(mem, "ops", [arch[0]!], { exportsDir: join(f.dir, "exports") })).includes(SECRET));
  } finally { f.done(); }
});

test("console people: maskImpressionOp——不是印象表的原样；印象表的行解析不了一律遮；公开的不动", () => {
  assert.deepEqual(maskImpressionOp("mem_event", "{oops", null, "r"), { before: "{oops", after: null, reason: "r" });
  assert.deepEqual(maskImpressionOp("mem_impression", null, "{oops", "r"), { before: null, after: SECRET_SHOWN, reason: SECRET_SHOWN });
  assert.deepEqual(maskImpressionOp("mem_impression", null, "[1,2]", "r"), { before: null, after: SECRET_SHOWN, reason: SECRET_SHOWN });
  const pub = JSON.stringify({ id: "i1", visibility: "all", status: "current", text: "公开", why: "w" });
  assert.deepEqual(maskImpressionOp("mem_impression", null, pub, "w"), { before: null, after: pub, reason: "w" });
  const down = JSON.stringify({ id: "i1", visibility: "all", status: "superseded", text: "公开", why: "w" });
  assert.equal(maskImpressionOp("mem_impression", pub, down, "新的 why", () => false).reason, "新的 why");
  assert.equal(maskImpressionOp("mem_impression", pub, down, "新的 why", (id) => id === "i1").reason, SECRET_SHOWN);
});

test("console people: hh mem ops <批次>——私密行的理由（就是私密的 why）不出", async () => {
  const f = fixture();
  try {
    const mem = new EventMemory({ db: f.db, embedder: null, now: () => NOW, tz: TZ, peopleTemplate: T });
    const env = { exportsDir: join(f.dir, "exports") };
    for (const b of [NIGHT, "import:people:xiaobei-profile", SWAP]) {
      const ops = await memCommand(mem, "ops", [b], env) as Array<{ reason: string }>;
      assert.ok(ops.length > 0, b);
      assert.ok(!JSON.stringify(ops).includes(SECRET), b);
    }
    const night = await memCommand(mem, "ops", [NIGHT], env) as Array<{ reason: string }>;
    assert.ok(night.some((o) => o.reason === "为什么-感觉"), "公开的理由照常");
  } finally { f.done(); }
});

test("console people: 文件区——ledger/people 下的卡（near.md 除外）、访客快照、收件处、退役的访客旧档案都不列、不给读", () => {
  const dir = tmpDir("hh-people-files-");
  const ws = join(dir, "ws");
  const put = (rel: string) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), `# ${rel}\n${SECRET}`); };
  const hidden = ["ledger/people/xiaobei.md", "ledger/people/ada.md", "ledger/guest-xiaobei.md", "memory/people/inbox/xiaobei.md", "memory/archive/retired-20261103/people/xiaobei.md", "memory/archive/retired-20261103/midterm/people.md"];
  const shown = ["ledger/people/near.md", "ledger/SOUL.md", "memory/archive/retired-20261103/ada.md", "memory/people/xiaobei-linxi.md"];
  for (const r of [...hidden, ...shown]) put(r);
  try {
    const roots = { workspace: ws, stateDir: join(dir, "hh"), files: [] as string[], layout: DEMO_MEMORY_PAGE };
    for (const r of hidden) assert.equal(readMemoryFile(`ws:${r}`, roots), null, r);
    for (const r of shown) assert.ok(readMemoryFile(`ws:${r}`, roots), r);
    const listed = areas(ws, DEMO_MEMORY_PAGE).flatMap((a) => a.list.map((x) => x.name));
    for (const r of hidden) assert.ok(!listed.includes(r), r);
    for (const r of shown) assert.ok(listed.includes(r), r);
    // 换大小写（APFS 默认不分大小写，打开的是同一个文件）、符号链接指进去，都不给读
    assert.equal(readMemoryFile("ws:ledger/People/xiaobei.md", roots), null);
    assert.equal(readMemoryFile("ws:Ledger/guest-xiaobei.md", roots), null);
    symlinkSync(join(ws, "ledger/people/xiaobei.md"), join(ws, "ledger/link.md"));
    assert.equal(readMemoryFile("ws:ledger/link.md", roots), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("console people: /api/mem/people 和 /api/mem/person?id=", async () => {
  const f = fixture();
  const server = createConsole({ tell: OPEN_READS,
    dbPath: f.dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "projects"), logPath: join(f.dir, "l.jsonl"),
    pageHtml: "<!doctype html>", now: () => NOW,
    people: { template: RAW, tz: TZ },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() as Record<string, unknown> }; };
  try {
    const l = await get("/api/mem/people");
    assert.equal(l.status, 200);
    assert.deepEqual((l.body.people as Array<{ name: string }>).map((p) => p.name), ["ada", "小贝", "砚", "姑妈"]);
    const c = await get("/api/mem/person?id=" + f.xiaobei.id);
    assert.equal(c.status, 200);
    assert.equal((c.body.person as { name: string }).name, "小贝");
    assert.ok(!JSON.stringify(c.body).includes(SECRET));
    assert.equal((await get("/api/mem/person?id=t9999")).status, 404);
    assert.equal((await get("/api/mem/person")).status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    f.done();
  }
});

test("console people: 网页——事件记忆里有「人物卡」子页，读这两个接口；「人和东西」能跳过去", () => {
  const html = consoleSource();
  assert.match(html, /\["people", T\("events\.views\.people"\)\], \["cards", T\("events\.views\.cards"\)\]/);
  assert.deepEqual([zhPack["events.views.people"], zhPack["events.views.cards"]], ["人和东西", "人物卡"]);
  assert.match(html, /getJ\("\/api\/event-memory\/people"\)/);
  assert.match(html, /getJ\("\/api\/event-memory\/person\?id=" \+ encodeURIComponent\(id\)\)/);
  assert.match(html, /else if \(v === "cards"\) loadCards\(\);/);
  assert.match(html, /T\("events\.people\.openCard"\)/);
  assert.equal(zhPack["events.people.openCard"], "看 TA 的人物卡");
  assert.match(html, /x\.secret\) det\.append\(el\("div", "pbody hint", T\("events\.cards\.secret"\)\)\)/, "改动记录里私密的不出原文");
  assert.equal(zhPack["events.cards.secret"], SECRET_SHOWN);
  assert.ok(html.includes(`const SECRET_SHOWN = ${JSON.stringify(SECRET_SHOWN)};`), "页面认的那句和服务端换上去的那句一字不差");
  assert.match(html, /const ETBL = TGroup\("events\.table"\)/);
  assert.equal(zhPack["events.table.mem_impression"], "人物卡");
  assert.match(html, /c\.privateCount \? T\("events\.cards\.publicEmpty"\)/);
  assert.match(zhPack["events.cards.publicEmpty"]!, /^公开的那一面是空的/);
});
