// 语言包：默认是中文包；登记一个包、setLang 换过去以后，各模块调用时读到的 P 都是新包的（活绑定），大脑发出去的话也跟着换；
// 没写、null、空着的代号都是中文包，不认识的代号直接报错、列出有的包。包的类型只要求键和函数签名跟中文包一样，字可以不一样
// （缺键、签名不对的 tsc 不收；数组、元组逐个元素放宽，长度和 readonly 照旧）。
// 换过包的测试都在 finally 里换回中文包，不影响这个文件里别的测试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LANG, M, P, T, langCode, registerLang, setLang, type LangPack, type Widen } from "../src/lang/index.ts";
import { zh } from "../src/lang/zh/index.ts";
import * as zhPrompts from "../src/lang/zh/prompts.ts";
import * as zhTools from "../src/lang/zh/tools.ts";
import * as zhMemory from "../src/lang/zh/memory.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { recallCentral } from "../src/memory/recall.ts";
import { openDb } from "../src/store/db.ts";
import { buildTools, type ToolContext } from "../src/tools/hhtools.ts";
import { focusRegularNow, jotDownNotedNow, recallUnsentNow } from "./lang-reader.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { makeBrain, flush } from "./helpers.ts";
import { TEST_LANG } from "./names.ts";
import { en } from "../src/lang/en/index.ts";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";

// This file checks the pack objects themselves (identity, live bindings), against the Chinese pack the suite runs in:
// unbind the names the helper bound on import
setLang(TEST_LANG, null);

/**
 * 测试包：中文包整个摊开，换三样——大脑在专注时段一开头就发的那句（拼起来的字）、一个写死的字符串常量（中文包里它的类型是那句话本身）、
 * 一个函数（签名照旧）。不用 as，类型就收
 */
const REPLACED = "【专注·测试包】这句只在测试包里。";
const CONTINUE_REPLACED = "【测试包】还在专注。";
const JOT_DESC_REPLACED = "【测试包】随手记一下。";
const JOT_NOTED_REPLACED = "【测试包】记下了。";
const UNSENT_REPLACED = "（【测试包】没发出去）";
const EXAM_ROLE_REPLACED = "【测试包】这是体检的角色说明。";
const EXAM_QUESTION = (q: string): string => `【测试包】题：${q}`;
const NO_SUCH_REPLACED = (seq: number): string => `【测试包】没有第 ${seq} 条。`;
const TEST_PACK: LangPack = {
  ...zh,
  code: "test",
  prompts: { ...zh.prompts, FOCUS_REGULAR: REPLACED, FOCUS_CONTINUE: CONTINUE_REPLACED, focusQuotaTight: (used, mins) => `test pack: ${used}% / ${mins} min` },
  tools: { ...zh.tools, jot_down: { ...zh.tools.jot_down, description: JOT_DESC_REPLACED, noted: JOT_NOTED_REPLACED } },
  memory: { ...zh.memory, recallCentral: { ...zh.memory.recallCentral, unsent: UNSENT_REPLACED, noSuch: NO_SUCH_REPLACED }, exam: { role: EXAM_ROLE_REPLACED, question: EXAM_QUESTION } },
};
registerLang(TEST_PACK);

/** 只给 tsc 看、从来不调：缺一个键、函数签名不对、字符串常量换成别的类型的包，registerLang 都不收 */
function packsTscRejects(): void {
  const { FOCUS_CONTINUE: _gone, ...withoutOne } = zh.prompts;
  const { jot_down: _noJot, ...toolsWithoutJot } = zh.tools;
  const { recallCentral: _noRecall, ...memoryWithoutRecall } = zh.memory;
  // @ts-expect-error 少了 FOCUS_CONTINUE
  registerLang({ ...zh, code: "missing-key", prompts: withoutOne });
  // @ts-expect-error focusQuotaTight 收的是 (used: number, mins: number)
  registerLang({ ...zh, code: "wrong-params", prompts: { ...zh.prompts, focusQuotaTight: (used: string): string => used } });
  // @ts-expect-error focusQuotaTight 要回字符串
  registerLang({ ...zh, code: "wrong-return", prompts: { ...zh.prompts, focusQuotaTight: (used: number): number => used } });
  // @ts-expect-error 对象导出里的函数也照签名：QUESTION_REFUSED.full 收一个数
  registerLang({ ...zh, code: "wrong-nested", prompts: { ...zh.prompts, QUESTION_REFUSED: { ...zh.prompts.QUESTION_REFUSED, full: (max: string) => max } } });
  // @ts-expect-error 字符串常量只能换成别的字符串
  registerLang({ ...zh, code: "not-a-string", prompts: { ...zh.prompts, FOCUS_CONTINUE: 1 } });
  // @ts-expect-error 少了 jot_down 这个工具的字
  registerLang({ ...zh, code: "missing-tool", tools: toolsWithoutJot });
  // @ts-expect-error jot_down 少了 params
  registerLang({ ...zh, code: "missing-params", tools: { ...zh.tools, jot_down: { description: "x", noted: "y" } } });
  // @ts-expect-error jot_down.noted 只能是字符串
  registerLang({ ...zh, code: "noted-number", tools: { ...zh.tools, jot_down: { ...zh.tools.jot_down, noted: 1 } } });
  // @ts-expect-error 少了 recallCentral 这一组记忆的字
  registerLang({ ...zh, code: "missing-memory-group", memory: memoryWithoutRecall });
  // @ts-expect-error recallCentral.noSuch 收的是 (seq: number)
  registerLang({ ...zh, code: "memory-wrong-params", memory: { ...zh.memory, recallCentral: { ...zh.memory.recallCentral, noSuch: (seq: string): string => seq } } });
  const { think: _noThink, ...verbWithoutThink } = zh.memory.recallCentral.verb;
  // @ts-expect-error recallCentral.verb 是带明确键的标签表，少一个键（think）不收
  registerLang({ ...zh, code: "memory-verb-missing-key", memory: { ...zh.memory, recallCentral: { ...zh.memory.recallCentral, verb: verbWithoutThink } } });
  // @ts-expect-error recallCentral.unsent 只能是字符串
  registerLang({ ...zh, code: "memory-not-a-string", memory: { ...zh.memory, recallCentral: { ...zh.memory.recallCentral, unsent: 1 } } });
}

/** 放宽的规矩用一个本地类型看（不是包里真有的导出）：as const 的一串话、数字常量 */
type Phrases = Widen<{ a: readonly ["甲", "乙"]; n: 3 }>;
/** 只给 tsc 看、从来不调：别的字、别的数都收；元素类型不对、长度不对的不收；readonly 留着 */
function widenTscChecks(): void {
  const ok: Phrases = { a: ["x", "y"], n: 4 };
  // @ts-expect-error 元组的元素要是字符串
  const wrongElement: Phrases = { a: ["x", 1], n: 4 };
  // @ts-expect-error 元组长度照原来的两个
  const wrongLength: Phrases = { a: ["x", "y", "z"], n: 4 };
  // @ts-expect-error 原来是 readonly 的，放宽以后还是
  ok.a[0] = "z";
}

test("lang: with no code the pack is English; with zh, P is the Chinese pack's prompts and langCode() is zh", () => {
  assert.equal(DEFAULT_LANG, "en");
  setLang();
  try { assert.equal(langCode(), "en"); assert.equal(P, en.prompts); } finally { setLang(TEST_LANG, null); }
  assert.equal(langCode(), "zh");
  assert.equal(P, zh.prompts);
  assert.equal(P, zhPrompts, "the pack's prompts are the module namespace of src/lang/zh/prompts.ts");
  assert.equal(focusRegularNow(), zhPrompts.FOCUS_REGULAR);
  assert.equal(T, zh.tools);
  assert.equal(T, zhTools, "the pack's tools are the module namespace of src/lang/zh/tools.ts");
  assert.equal(jotDownNotedNow(), zhTools.jot_down.noted);
  assert.equal(M, zh.memory);
  assert.equal(M, zhMemory, "the pack's memory is the module namespace of src/lang/zh/memory.ts");
  assert.equal(recallUnsentNow(), zhMemory.recallCentral.unsent);
});

test("lang: after setLang every importer reads the new pack at call time (a live binding across modules); setLang(TEST_LANG) goes back to zh", () => {
  assert.notEqual(zhPrompts.FOCUS_REGULAR, REPLACED);
  assert.notEqual(zhPrompts.FOCUS_CONTINUE, CONTINUE_REPLACED);
  try {
    setLang("test");
    assert.equal(langCode(), "test");
    assert.equal(P, TEST_PACK.prompts);
    assert.equal(P.FOCUS_REGULAR, REPLACED, "this module's binding follows");
    assert.equal(focusRegularNow(), REPLACED, "another module's binding follows");
    assert.equal(P.FOCUS_CONTINUE, CONTINUE_REPLACED, "a plain string constant with different text");
    assert.equal(P.focusQuotaTight(96, 15), "test pack: 96% / 15 min", "a function");
    assert.equal(P.UNSENT_REPLY, zhPrompts.UNSENT_REPLY, "the prompts not replaced are the Chinese pack's");
    assert.equal(P.QUESTION_REFUSED, zhPrompts.QUESTION_REFUSED);
    assert.equal(T, TEST_PACK.tools);
    assert.equal(T.jot_down.description, JOT_DESC_REPLACED, "this module's T follows");
    assert.equal(T.jot_down.noted, JOT_NOTED_REPLACED);
    assert.equal(jotDownNotedNow(), JOT_NOTED_REPLACED, "another module's T follows");
    assert.equal(T.jot_down.params, zhTools.jot_down.params, "the tool text not replaced is the Chinese pack's");
    assert.equal(M, TEST_PACK.memory);
    assert.equal(M.recallCentral.unsent, UNSENT_REPLACED, "this module's M follows");
    assert.equal(recallUnsentNow(), UNSENT_REPLACED, "another module's M follows");
    assert.equal(M.recallCentral.said("阿青"), zhMemory.recallCentral.said("阿青"), "the memory text not replaced is the Chinese pack's");
    // recallCentral 在别的模块里：没有的那条答测试包的话，找到的那条还是中文包的行
    const db = openDb(":memory:");
    const central = new CentralMemory(db, () => 0);
    central.append(1, "外界", "input", "明天老林来", { from: "阿青" }, Date.UTC(2026, 9, 28, 5, 0));
    const o = { timezone: "UTC", labels: (s: string) => s };
    assert.equal(recallCentral(db, ["show", "#999"], o), NO_SUCH_REPLACED(999));
    const found = recallCentral(db, ["show", "#1"], o);
    assert.ok(found.startsWith("#1 ["), found);
    assert.ok(found.endsWith("] 阿青说：明天老林来"), found);
    setLang(TEST_LANG);
    assert.equal(langCode(), "zh");
    assert.equal(P, zh.prompts);
    assert.equal(T, zh.tools);
    assert.equal(focusRegularNow(), zhPrompts.FOCUS_REGULAR);
    assert.equal(jotDownNotedNow(), zhTools.jot_down.noted);
    assert.equal(M, zh.memory);
    assert.equal(recallUnsentNow(), zhMemory.recallCentral.unsent);
  } finally {
    setLang(TEST_LANG);
  }
});

test("lang: an unknown code throws, names the packs it has, and leaves the current pack as it was", () => {
  assert.throws(() => setLang("nope"), (e: unknown) => e instanceof Error && e.message === 'no language pack "nope" (have: zh, en, test)');
  assert.equal(langCode(), "zh");
  assert.equal(P, zh.prompts);
});

test("lang: absent, null or empty (after trim) means the default pack, like an absent config key; a non-empty code is looked up trimmed and an unknown one still throws", () => {
  try {
    for (const code of [undefined, null, "", "   "]) {
      setLang("test");
      setLang(code);
      assert.equal(langCode(), DEFAULT_LANG, `setLang(${JSON.stringify(code)}) is the default`);
      assert.equal(P, en.prompts);
    }
    setLang(" test ");
    assert.equal(langCode(), "test");
    assert.throws(() => setLang(" nope "), (e: unknown) => e instanceof Error && e.message === 'no language pack " nope " (have: zh, en, test)');
    assert.equal(langCode(), "test", "a failed setLang leaves the pack in use");
  } finally {
    setLang(TEST_LANG);
  }
});

test("lang: a Brain built after setLang sends the test pack's text for the replaced prompt (focus slot opening)", async () => {
  try {
    setLang("test");
    const { brain, driver } = makeBrain({}, Date.UTC(2026, 9, 29, 9, 0));   // UTC 09:00 = 第二个专注时段的开头
    await brain.tick();
    const text = driver.latest("main").sent.at(-1)!.text;
    assert.ok(text.includes(REPLACED), `the test pack's FOCUS_REGULAR is sent: ${text.slice(0, 200)}`);
    assert.ok(!text.includes(zhPrompts.FOCUS_REGULAR), "the Chinese FOCUS_REGULAR is not");
  } finally {
    setLang(TEST_LANG);
  }
  assert.equal(langCode(), "zh");
});

test("lang: the memory checkup's session role text and the question sent come from the test pack (the two M.exam reads in brain.ts, which no pin reaches)", async () => {
  try {
    setLang("test");
    const db = openDb(":memory:");
    const start = Date.UTC(2026, 9, 30, 12, 0);
    const mem = new EventMemory({ db, embedder: null, now: () => start, tz: "UTC" });
    const t = makeBrain({}, start, { db, mem });
    (mem as unknown as { now: () => number }).now = t.clock.now;
    const out = join(tmpDir("exam-"), "exam.json");
    const run = t.brain.runExam([{ id: "q1", q: "阿青上次来是哪天？" }, { id: "q2", q: "老林带了什么？" }], out);
    await flush();
    const s1 = t.driver.latest("exam");
    assert.equal(s1.sent[0]!.text, `${EXAM_ROLE_REPLACED}\n\n${EXAM_QUESTION("阿青上次来是哪天？")}`, "the first message is the test pack's role text whole, then exactly its question(q)");
    await s1.play({ say: "不记得" });
    await flush();
    const s2 = t.driver.latest("exam");
    assert.notEqual(s2, s1);
    assert.equal(s2.sent[0]!.text, `${EXAM_ROLE_REPLACED}\n\n${EXAM_QUESTION("老林带了什么？")}`);
    await s2.play({ say: "没有这回事" });
    await run;
  } finally {
    setLang(TEST_LANG);
  }
  assert.equal(langCode(), "zh");
});

test("lang: buildTools called after setLang gives the test pack's jot_down text; the other tools keep the Chinese pack's", async () => {
  const ctx: ToolContext = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 3,
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }), send: async () => assert.fail("nothing is sent here"),
    now: () => 0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
  };
  try {
    const before = buildTools(ctx, ["jot_down", "on_it"]);
    assert.equal(before[0]!.description, zhTools.jot_down.description);
    setLang("test");
    const tools = buildTools(ctx, ["jot_down", "on_it"]);
    const jot = tools.find((t) => t.name === "jot_down")!;
    const onIt = tools.find((t) => t.name === "on_it")!;
    assert.equal(jot.description, JOT_DESC_REPLACED);
    assert.equal(await jot.handler({ text: "阿青说明天来" }), JOT_NOTED_REPLACED);
    assert.ok(onIt.description.startsWith("开始做一件事前说一声"), "a tool the test pack does not replace keeps the Chinese pack's text");
    assert.equal(zhTools.jot_down.description, "随手记一下：想法、发现、做出来的结果、想跟别人说的话。记下的你都会记得。", "the Chinese pack itself is untouched");
  } finally {
    setLang(TEST_LANG);
  }
  assert.equal(langCode(), "zh");
  assert.equal(buildTools(ctx, ["jot_down"])[0]!.description, zhTools.jot_down.description);
});
