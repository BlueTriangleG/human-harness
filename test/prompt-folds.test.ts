// memory.promptFolds：进提示前折成一句（11-13 止血带）。库里照原样，进提示时换：真人的话只换那几个字，别的种类命中就整条 / 整行换。
// 测试用的说法都是编的（「红灯拦下」之类），跟线上那张表无关。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrain, flush } from "./helpers.ts";
import { PromptFolds } from "../src/memory/folds.ts";
import { renderMemory, type Entry } from "../src/memory/central.ts";

const TABLE = [
  { find: "红灯拦下", say: "（那一步没做成，换个做法）", word: "那件事", note: "测试" },
  { find: "Stopped By A Lamp", say: "（那一步没做成，换个做法）", word: "那件事" },
];
const FOLDS = new PromptFolds(TABLE);
const SAY = TABLE[0]!.say;

test("PromptFolds：子串、不分大小写；整条换、只换字、按行换；坏条目跳过；空表原样", () => {
  assert.equal(FOLDS.hit("刚才被 stopped by a lamp 了")?.say, SAY, "不分大小写");
  assert.equal(FOLDS.hit("一切正常"), null);
  assert.equal(FOLDS.whole("又被红灯拦下了，烦"), SAY);
  assert.equal(FOLDS.whole("一切正常"), "一切正常");
  assert.equal(FOLDS.words("红灯拦下的事修好了吗？上次也是红灯拦下"), "那件事的事修好了吗？上次也是那件事", "每处都换，别的字留着");
  assert.equal(FOLDS.words("STOPPED BY A LAMP again"), "那件事 again");
  assert.equal(FOLDS.lines("- 上午写稿（#1）\n- 下午被红灯拦下（#2）\n收尾"), `- 上午写稿（#1）\n- ${SAY}\n收尾`, "命中的行整行换，留着行首的「- 」");
  const bad = new PromptFolds([null, { find: "" , say: "x" }, { find: "a" }, "str", { find: "红灯拦下", say: "ok" }]);
  assert.equal(bad.whole("红灯拦下"), "ok", "只留合规的那条");
  const none = new PromptFolds([]);
  assert.equal(none.empty, true);
  assert.equal(none.words("红灯拦下"), "红灯拦下");
  assert.equal(none.lines("红灯拦下"), "红灯拦下");
});

const E = (seq: number, src: string, kind: Entry["kind"], text: string, meta: Record<string, unknown> | null = null): Entry =>
  ({ seq, ts: Date.UTC(2026, 10, 13, 6, 0) + seq * 1000, epoch: 1, src, kind, text, tokens: 10, meta }) as Entry;

test("renderMemory：真人的话只换字，工具结果、动作、思考、说的记的命中就整条换；空表跟不给一样", () => {
  const entries = [
    E(1, "外界", "input", "红灯拦下的事修好了，你接着写稿", { from: "ada", human: true }),
    E(2, "side-1", "result", "Error: stopped by a lamp, tool calls did not run", { id: "t1" }),
    E(3, "side-1", "think", "想想被红灯拦下以后怎么办"),
    E(4, "main", "say", "刚才被红灯拦下了"),
    E(5, "main", "note", "记一笔：红灯拦下三次"),
    E(6, "side-1", "say", "稿子写完了"),
  ];
  const opts = { maxItemChars: 2000, timezone: "UTC", mode: "full" as const, viewer: "main" };
  const plain = renderMemory(entries, (s) => (s === "main" ? "" : "那一头"), opts);
  const folded = renderMemory(entries, (s) => (s === "main" ? "" : "那一头"), { ...opts, folds: FOLDS });
  assert.match(plain, /红灯拦下/);
  assert.doesNotMatch(folded, /红灯拦下|stopped by a lamp/i, "命中的说法都不进提示");
  assert.match(folded, /那件事的事修好了，你接着写稿/, "真人的话只换那几个字，别的原样");
  assert.equal(folded.split(SAY).length - 1, 4, "工具结果、思考、说的、记的各整条换成一句");
  assert.match(folded, /稿子写完了/, "没命中的照旧");
  assert.equal(renderMemory(entries, () => "", { ...opts, folds: new PromptFolds([]) }), renderMemory(entries, () => "", opts), "空表跟不给一样");
});

const CFG = { memory: { promptFolds: TABLE } };

test("脑子里：别的脑区的工具结果进主线的记忆增量时折掉；真人消息只换字；库里照原样", async () => {
  const t = makeBrain(CFG, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const main = t.driver.latest("main");
  await main.play({ say: "NO_REPLY" });
  await flush();
  t.brain.wakeRegion("side-1", "看一下");
  await t.driver.latest("side-1").play({ tool: { name: "jot_down", args: { text: "刚才被红灯拦下了，换个路子" } }, say: "NO_REPLY" });
  await flush();
  t.brain.fromChannel({ channel: "whatsapp", text: "红灯拦下的事修好了，你接着写稿", senderId: "+6155500010" });
  await flush(); await flush();
  const wake = main.sent.at(-1)!.text;
  assert.doesNotMatch(wake, /红灯拦下/, "增量和这条消息里都不带那个说法");
  assert.match(wake, /那件事的事修好了，你接着写稿/, "ada 的话只换那几个字");
  assert.match(wake, new RegExp(SAY.replace(/[()（）]/g, ".")), "那一头记的整条换成一句");
  assert.ok(t.brain.central.since(0).some((e) => e.text.includes("红灯拦下")), "库里照原样存");
});

test("脑子里：recall 的结果、前缀里的压缩块也过折叠表", async () => {
  const t = makeBrain({ ...CFG, limits: { pageTokens: 50 } }, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "jot_down", args: { text: "上午被红灯拦下一次" } }, say: "很多很多的经历".repeat(20) });
  await flush(); await flush();
  const hippo = t.driver.latest("hippocampus");
  await hippo.play({ say: "- 上午写稿（#1）\n- 被红灯拦下一次（#2）" });
  await flush(); await flush();
  t.brain.wakeRegion("main", "接着");
  const main = t.driver.latest("main");
  assert.doesNotMatch(main.spec.systemAppend, /红灯拦下/, "前缀里的压缩块折掉了");
  assert.match(main.spec.systemAppend, /上午写稿/, "没命中的行照旧");
  await main.play({ tool: { name: "recall", args: { args: ["search", "上午"] } }, say: "NO_REPLY" });
  await flush();
  const res = t.brain.central.since(0).filter((e) => e.kind === "result").at(-1)!.text;
  assert.doesNotMatch(res, /红灯拦下/, "recall 的结果里折掉了");
});

test("脑子里：「最近说过的话」里她自己说过的那句也折掉", async () => {
  const saids: string[][] = [];
  const situation = { prefixRebuilt: () => {}, newMainSession: () => {}, forMain: async (h?: { said?: Array<{ text: string }> }) => { if (h?.said) saids.push(h.said.map((x) => x.text)); return ""; } };
  const t = makeBrain(CFG, Date.UTC(2026, 9, 29, 10, 0), { situation: situation as never });
  t.brain.fromChannel({ channel: "whatsapp", text: "还写不了吗", senderId: "+6155500010" });
  await flush(); await flush();
  await t.driver.latest("main").play({ say: "刚才被红灯拦下了，现在好了" });
  await flush(); await flush();
  t.brain.fromChannel({ channel: "whatsapp", text: "好的", senderId: "+6155500010" });
  await flush(); await flush();
  const last = saids.at(-1)!;
  assert.ok(last.length > 0);
  assert.ok(!last.some((x) => x.includes("红灯拦下")));
  assert.ok(last.includes(SAY));
});

// 限时间段的条目（11-13 CEO：通用的词只管出事那一段）：段内的才认，段外原样；压缩块按那一页的起止判
const WIN = [{ find: "红灯", say: "（那一步没做成，先放着）", word: "那件事", from: "2026-10-29 10:00", until: "2026-10-29 23:59" }];

test("限时间段：段内认、段外原样；真人的话段内只换字；思考段内整条换；压缩块按页的起止判；时间写坏的那条不用", () => {
  const f = new PromptFolds(WIN, "UTC");
  const inT = Date.UTC(2026, 9, 29, 12, 0);
  const outT = Date.UTC(2026, 9, 29, 9, 0);
  assert.equal(f.whole("又碰到红灯了", inT), WIN[0]!.say, "段内整条换");
  assert.equal(f.whole("又碰到红灯了", outT), "又碰到红灯了", "段外原样");
  assert.equal(f.whole("又碰到红灯了"), "又碰到红灯了", "不知道时间：限时间段的不用");
  assert.equal(f.words("红灯的事好了吗", inT), "那件事的事好了吗");
  assert.equal(f.entry(E(1, "main", "think", "想想红灯以后怎么办")).text, "想想红灯以后怎么办", "E() 的时间在 11-13，段外");
  const think = { ...E(2, "main", "think", "想想红灯以后怎么办"), ts: inT } as Entry;
  assert.equal(f.entry(think).text, WIN[0]!.say, "思考段内整条换");
  const human = { ...E(3, "外界", "input", "红灯的事好了，接着写", { from: "ada", human: true }), ts: inT } as Entry;
  assert.equal(f.entry(human).text, "那件事的事好了，接着写", "真人的话段内只换字");
  assert.equal(f.lines("- 写稿\n- 碰到红灯", [Date.UTC(2026, 9, 29, 8, 0), Date.UTC(2026, 9, 29, 11, 0)]), `- 写稿\n- ${WIN[0]!.say}`, "那一页跨进段里：按行换");
  assert.equal(f.lines("- 碰到红灯", [Date.UTC(2026, 9, 28, 8, 0), Date.UTC(2026, 9, 28, 20, 0)]), "- 碰到红灯", "那一页整个在段外：原样");
  assert.equal(new PromptFolds([{ find: "红灯", say: "x", from: "看不懂的时间" }], "UTC").empty, true, "时间写坏的那条不用");
  const mixed = new PromptFolds([...WIN, { find: "绿灯", say: "（绿）" }], "UTC");
  assert.equal(mixed.whole("绿灯亮了", outT), "（绿）", "不限时间的照常认");
});

test("脑子里：限时间段的条目只折段内的记录，段外的原样进提示", async () => {
  const t = makeBrain({ memory: { promptFolds: [{ find: "红灯", say: "（那一步没做成，先放着）", word: "那件事", from: "2026-10-29 10:00", until: "2026-10-29 23:59" }] } }, Date.UTC(2026, 9, 29, 9, 0));
  t.brain.wakeRegion("side-1", "看一下");
  await t.driver.latest("side-1").play({ tool: { name: "jot_down", args: { text: "九点碰到红灯一次" } }, say: "NO_REPLY" });
  await flush();
  t.clock.advance(90 * 60_000);
  await t.driver.latest("side-1").play({ tool: { name: "jot_down", args: { text: "十点半又碰到红灯" } }, say: "NO_REPLY" });
  await flush();
  t.brain.wakeRegion("main", "开始");
  const text = t.driver.latest("main").sent.at(-1)!.text;
  assert.match(text, /九点碰到红灯一次/, "段外的原样");
  assert.doesNotMatch(text, /十点半又碰到红灯/, "段内的折掉");
  assert.match(text, /那一步没做成，先放着/);
});

