// 控制台认她那边的字（src/console/packtext.ts）：「没想起来」的回话、中期记忆的标题、「只给你看」。
// 这几句在她的语言包里；这里看两件事：包里现在的每一句都认得出，换一个包认的跟着变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { openDb } from "../src/store/db.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import { M, T, registerLang, setLang, type LangPack } from "../src/lang/index.ts";
import { zh } from "../src/lang/zh/index.ts";
import { openReadOnly } from "../src/console/data.ts";
import { recallCalls } from "../src/console/memory.ts";
import { forYouHead, midtermHead, notFoundShapes } from "../src/console/packtext.ts";
import { parsePrompt, splitPrefix } from "../src/console/prompt.ts";

/** 一个换了说法的包：「没想起来」的十七句、中期记忆的标题、「只给你看」的开头都和中文包不一样，旧的写法也认不出它们 */
const OTHER: LangPack = {
  ...zh,
  code: "packtext-test",
  tools: { ...zh.tools, recall: { ...zh.tools.recall, dayNone: "No quotes that day.", searchNone: "Found nothing. Try other words.", none: "Found nothing.", honchoDown: (summary) => `Found nothing of my own; the old store is down (${summary}).` } },
  memory: {
    ...zh.memory,
    recall: {
      ...zh.memory.recall,
      noSuchEvent: (ref) => `Nothing called "${ref}" here.`, noQuote: (ref) => `Quote ${ref} is not on record.`, noCentral: (seq) => `Record ${seq} is not there.`,
      periodUnknown: (who) => `Who is "${who}"?`, periodEmpty: (span) => `Nothing was written down for ${span}.`, reverseNoEvent: (ref) => `Event ${ref} is not there.`,
      reverseUnknown: (ref) => `Who is "${ref}"?`, reverseNone: (name) => `${name} has not come up in anything yet.`,
      personUnknown: (who) => `Nobody called "${who}" is known here.`, personNothing: (name) => `About ${name} nothing is on record so far.`,
    },
    remember: { ...zh.memory.remember, nothing: (cue) => `Nothing surfaced for "${cue}".` },
    recallPeriod: { ...zh.memory.recallPeriod, badRange: (when) => `That period is unreadable: "${when}".` },
    recallCentral: { ...zh.memory.recallCentral, noSuch: (seq) => `Line ${seq} is not there.` },
    midterm: { ...zh.memory.midterm, head: "# Lately\n\nAsk recall_event for more." },
    situation: { ...zh.memory.situation, forYouOnly: (body) => `[Between us]\n${body}` },
  },
};
registerLang(OTHER);
/** 一个写坏了的包：两句「没想起来」几乎全是空，中期记忆的标题是空行，「只给你看」的开头只有一个括号 */
const THIN: LangPack = {
  ...zh,
  code: "packtext-thin",
  memory: {
    ...zh.memory,
    recall: { ...zh.memory.recall, reverseNone: (name) => `${name}。`, periodEmpty: (span) => `${span} —` },
    midterm: { ...zh.memory.midterm, head: "\n# 最近\n\n正文" },
    situation: { ...zh.memory.situation, forYouOnly: (body) => `【\n${body}` },
  },
};
registerLang(THIN);

/** 包里那十七句，带空的各填上一个像样的值 */
const replies = (): string[] => [
  M.recall.noSuchEvent("搬家"), M.recall.noQuote("q12"), M.recall.noCentral("88"), M.recall.periodUnknown("阿树"), M.recall.periodEmpty("上周"),
  M.recall.reverseNoEvent("e0042"), M.recall.reverseUnknown("阿树"), M.recall.reverseNone("阿树"), M.recallCentral.noSuch(88),
  T.recall.dayNone, T.recall.searchNone, T.recall.none, T.recall.honchoDown("连不上"),
  M.recall.personUnknown("阿树"), M.recall.personNothing("阿树"), M.remember.nothing("搬家"), M.recallPeriod.badRange("后天"),
];
const recognised = (text: string): boolean => notFoundShapes().some((s) => s.test(text));

/** 在另一个包下跑一段，跑完换回来 */
function withPack<R>(pack: LangPack, fn: () => R): R {
  setLang(pack.code);
  try { return fn(); } finally { setLang("zh"); }
}
const withOther = <R>(fn: () => R): R => withPack(OTHER, fn);
/** 正常翻到东西时回的话，几种样子（都是编的） */
const FOUND = [
  "#12 [10-29 07:00] 阿树说：视频剪完了吗",
  "想起来的事：\ne0042 搬家（10-20 到 10-27）：定了周六，阿树借了车。",
  "e0042 搬家\n经过：先看了三处，定了靠河那套。\n原话 q12：「就这套吧。」",
  "上周：\n- 搬家（e0042）\n- 学做饭（e0043）没有记下别的。",
  "阿树：最近在学做饭，第一道是番茄炒蛋。",
];

test("packtext: each not-found reply of the pack is recognised, and a reply that found something is not", () => {
  const shapes = notFoundShapes();
  assert.equal(shapes.length, 17);
  assert.equal(replies().length, 17);
  for (const said of replies()) assert.ok(recognised(said), said);
  // 正常翻到的回话，十七个正则一个都不认
  for (const reply of FOUND) for (const s of shapes) assert.equal(s.test(reply), false, `${s} 认了一句翻到了的回话：${reply}`);
  assert.equal(recognised(""), false);
  // 空里只认一行以内的值：一段好几行的回话，结尾碰巧是「… 没有记下的事。」，不算没想起来
  assert.equal(recognised("上周：\n- 搬家（e0042）\n再往前 没有记下的事。"), false);
  assert.equal(recognised("阿树这个人：\n最近在学做饭。\n阿树：还没有出现在哪件事里。"), false);
  // 只有 Honcho 那一句的空是一段摘要，好几行也认
  assert.ok(recognised(T.recall.honchoDown("连不上\n重试了两次")));
});

test("packtext: under another pack the recognisers are that pack's sentences", () => {
  const before = replies();
  withOther(() => {
    for (const said of replies()) assert.ok(recognised(said), said);
    for (const said of before) assert.equal(recognised(said), false, "换了包，就不再从包里认原来那一句：" + said);
    assert.equal(midtermHead(), "# Lately");
    assert.equal(forYouHead(), "[Between us]");
  });
  assert.equal(midtermHead(), "# 最近这一段");
  assert.equal(forYouHead(), "【只给你看，不用在回复里提到】");
});

test("packtext: recallCalls marks a recall as not found when the reply is the pack's sentence — in whichever pack", () => {
  const dir = tmpDir("hh-packtext-");
  const dbPath = join(dir, "state", "hh.db");
  const db = openDb(dbPath);
  const central = new CentralMemory(db, () => Date.UTC(2026, 10, 14, 1, 0, 0));
  new Epochs(db, () => Date.UTC(2026, 10, 14, 1, 0, 0)).begin("boot", 1);
  const ask = (id: string, reply: string): void => {
    central.append(1, "main", "act", `recall_event {"ref":"${id}"}`, { tool: "recall_event", id });
    central.append(1, "main", "result", reply, { id });
  };
  try {
    withOther(() => {
      ask("a", M.recall.noSuchEvent("搬家"));
      ask("b", M.recall.reverseNone("阿树"));
      ask("c", T.recall.searchNone);
      ask("d", "e0042 搬家：定了周六");
      const ro = openReadOnly(dbPath);
      try { assert.deepEqual(recallCalls(ro).map((r) => r.found).reverse(), [false, false, false, true]); } finally { ro.close(); }
    });
    // 换回中文包：那三句不是这个包的话，也不是旧写法，就当想起来了（认的确实是包里的话，不是碰巧）
    const ro = openReadOnly(dbPath);
    try { assert.deepEqual(recallCalls(ro).map((r) => r.found).reverse(), [true, true, true, true]); } finally { ro.close(); }
    // 中文包自己的：翻原话没找到的那两句，旧写法里没有（以前会被当成想起来了）
    ask("e", T.recall.searchNone);
    ask("f", T.recall.dayNone);
    const again = openReadOnly(dbPath);
    try { assert.deepEqual(recallCalls(again).map((r) => r.found).reverse().slice(4), [false, false]); } finally { again.close(); }
  } finally { db.close(); rmSync(dir, { recursive: true }); }
});

test("packtext: the midterm part of the prefix and the for-you-only note are found by the pack's own heading", () => {
  const prefix = (head: string): string => `# 你现在的运行方式\n\n你是小满。\n\n---\n\n# 你的人生\n\n下面是你自己的记忆。\n\n<file path="ledger/SOUL.md">\n账本\n</file>\n\n${head}\n\n## 今天\n\n（今天还没有）`;
  const kinds = (head: string): string[] => splitPrefix(prefix(head)).map((s) => s.kind);
  assert.deepEqual(kinds(M.midterm.head), ["runtime", "frame", "memoryFile", "midterm"]);
  assert.deepEqual(kinds("# Recently"), ["runtime", "frame", "memoryFile", "midterm"], "演示库的英文写法照旧认");
  assert.deepEqual(kinds(OTHER.memory.midterm.head), ["runtime", "frame", "memoryFile"], "别的包的标题，在中文包下不认：并在前一段里");
  withOther(() => assert.deepEqual(kinds(M.midterm.head), ["runtime", "frame", "memoryFile", "midterm"]));

  const dir = tmpDir("hh-packtext-");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "s.jsonl");
  const session = (...said: string[]): void => writeFileSync(file, said.map((content, i) => JSON.stringify({ type: "user", timestamp: `2026-11-14T01:00:0${i}Z`, message: { role: "user", content } })).join("\n") + "\n");
  const flags = (): boolean[] => parsePrompt(file).messages.map((m) => m.forYou === true);
  try {
    session("开场", M.situation.forYouOnly("现在是傍晚") + "\n阿树：在吗", "【只给你看：旧的写法】\n阿树：在吗", "[For you only: the demo's wording]\nhello", OTHER.memory.situation.forYouOnly("x") + "\nhello", "阿树：在吗");
    assert.deepEqual(flags(), [false, true, true, true, false, false]);
    // 换了包：新包的开头也认了；中文那句的开头本来就在旧写法里，照旧认
    withOther(() => assert.deepEqual(flags(), [false, true, true, true, true, false]));
  } finally { rmSync(dir, { recursive: true }); }
});

test("packtext: a pack sentence that is almost all blank is not used — the rest still recognise, and it is reported once", () => {
  const warns: string[] = [];
  const warn = (line: string): void => { warns.push(line); };
  withPack(THIN, () => {
    const shapes = notFoundShapes(warn);
    assert.equal(shapes.length, 15, "那两句被跳过，别的十五句照旧");
    // 要是没跳过，「名字。」那一句会把任何以句号结尾的回话都认成没想起来
    for (const reply of FOUND) for (const s of shapes) assert.equal(s.test(reply), false, `${s} 认了一句翻到了的回话：${reply}`);
    assert.equal(shapes.some((s) => s.test(M.recall.reverseNone("阿树"))), false);
    for (const said of [M.recall.noSuchEvent("搬家"), M.recall.noQuote("q12"), M.recallCentral.noSuch(88), T.recall.none]) assert.ok(shapes.some((s) => s.test(said)), said);
    assert.equal(midtermHead(warn), null, "标题那一行是空的：不认，也不拿空行去切前缀");
    assert.equal(forYouHead(warn), null, "开头只有一个括号：不认");
    notFoundShapes(warn); midtermHead(warn); forYouHead(warn);
    assert.equal(warns.length, 4, "四个条目各报一次，再问不重复报");
    // the warning is in the console's language, which for a pack it has no interface for is the default one: read the
    // entry and the pack out of it, not its wording
    assert.deepEqual(warns.map((w) => /\b(M\.[\w.]*\w)/.exec(w)?.[1]).sort(), ["M.midterm.head", "M.recall.periodEmpty", "M.recall.reverseNone", "M.situation.forYouOnly"]);
    for (const w of warns) assert.match(w, /^\[console\] .*\bpacktext-thin\b/);

    // 写坏的标题和开头不会让页面认错：前缀照旧拆（不在每个空行处切开），带「【」的普通消息不算「只给你看」
    const prefix = "# 你现在的运行方式\n\n你是小满。\n\n第二段。\n\n---\n\n# 你的人生\n\n下面是你自己的记忆。";
    assert.deepEqual(splitPrefix(prefix).map((s) => s.kind), ["runtime", "frame"]);
    const dir = tmpDir("hh-packtext-");
    const file = join(dir, "s.jsonl");
    try {
      writeFileSync(file, ["开场", "【这是你此刻最专心的那头】阿树：在吗"].map((content, i) => JSON.stringify({ type: "user", timestamp: `2026-11-14T01:00:0${i}Z`, message: { role: "user", content } })).join("\n") + "\n");
      assert.deepEqual(parsePrompt(file).messages.map((m) => m.forYou === true), [false, false]);
    } finally { rmSync(dir, { recursive: true }); }
  });
  assert.equal(notFoundShapes(warn).length, 17);
  assert.equal(warns.length, 4, "换回正常的包：不报");
});
