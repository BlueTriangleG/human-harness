// 时间线：她的回复在中央记忆里记两回（「说」和每个气泡的「发给」），页面认成同一段、只列一行。这里测认的那一步（web/js/sent.js，不碰页面）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { WEB_DIR, asPlainScript } from "./console-web.ts";
import { splitBubbles } from "../src/brain.ts";
import { zh } from "../src/lang/zh/index.ts";
import { en as enPack } from "../src/lang/en/index.ts";
import { MARKS_EN } from "./console-demo-en.ts";

interface Row { seq: number; ts: number; src: string; kind: string; text: string; meta: Record<string, unknown> | null }

const SRC = asPlainScript(readFileSync(join(WEB_DIR, "js/sent.js"), "utf8"));

/** 一份干净的脚本：喂记录、问结果 */
const SENT_HEAD = zh.brain.forms.sentHead;

function page(sentHead: string = SENT_HEAD.source) {
  const ctx = vm.createContext({ HH: { marks: { sentHead } } });
  vm.runInContext(SRC, ctx);
  const call = (fn: string, arg: unknown): unknown => { (ctx as Record<string, unknown>).__arg = arg; return vm.runInContext(`${fn}(__arg)`, ctx); };
  return {
    fold: (r: Row): Row | null => call("fold", r) as Row | null,
    refold: (all: Row[]): void => { call("refold", all); },
    /** 这条「发给」并进了哪条「说」（seq），没并是 null */
    into: (seq: number): number | null => vm.runInContext(`sentInto.get(${seq})?.seq ?? null`, ctx) as number | null,
    /** 这条「说」并进来了哪几条「发给」（seq，按次序） */
    of: (seq: number): number[] => [...(vm.runInContext(`(sentOf.get(${seq}) || []).map((r) => r.seq)`, ctx) as number[])],
    text: (s: string): string => call("sentText", s) as string,
  };
}

let seq = 0;
const row = (src: string, kind: string, text: string, meta: Record<string, unknown> | null = null): Row => ({ seq: ++seq, ts: 1_794_000_000_000 + seq * 1000, src, kind, text, meta });
const say = (text: string, src = "main"): Row => row(src, "say", text);
const sent = (text: string, to = "qq:a", batch = "b1", name = "阿树", src = "main"): Row => row(src, "note", `（发给 ${name}）${text}`, { sent: true, to, name, batch });

test("sent: a reply of one bubble folds into the say it came from", () => {
  const p = page();
  const s = say("好的，我看一下。");
  assert.equal(p.fold(s), null);
  const n = sent("好的，我看一下。");
  assert.equal(p.fold(n)?.seq, s.seq);
  assert.equal(p.into(n.seq), s.seq);
  assert.deepEqual(p.of(s.seq), [n.seq]);
});

test("sent: the bubbles are what brain.ts cuts out of the say — every one folds, in order", () => {
  const p = page();
  const text = "  第一段，\n里面有换行。\n\n第二段。\n \n第三段。\n";
  const s = say(text);
  p.fold(s);
  const bubbles = splitBubbles(text);
  assert.deepEqual(bubbles, ["第一段，\n里面有换行。", "第二段。", "第三段。"]);
  const notes = bubbles.map((b) => sent(b));
  for (const n of notes) assert.equal(p.fold(n)?.seq, s.seq);
  assert.deepEqual(p.of(s.seq), notes.map((n) => n.seq));
});

test("sent: two says in one turn — each bubble goes to the say it was cut from, also when the same words appear in both", () => {
  const p = page();
  const a = say("好的");
  const think = row("main", "think", "再补一句");
  const b = say("好的\n\n马上");
  for (const r of [a, think, b]) p.fold(r);
  const [n1, n2, n3] = [sent("好的"), sent("好的"), sent("马上")];
  assert.equal(p.fold(n1)?.seq, a.seq);
  assert.equal(p.fold(n2)?.seq, b.seq);
  assert.equal(p.fold(n3)?.seq, b.seq);
  assert.deepEqual(p.of(a.seq), [n1.seq]);
  assert.deepEqual(p.of(b.seq), [n2.seq, n3.seq]);
});

test("sent: a bubble that failed leaves its own row; the ones after it still fold", () => {
  const p = page();
  const s = say("一\n\n二\n\n三");
  p.fold(s);
  const n1 = sent("一");
  const failed = row("main", "note", "（这句没发给 阿树：网关没回）二", { sendFailed: true, to: "qq:a" });
  const n3 = sent("三");
  assert.equal(p.fold(n1)?.seq, s.seq);
  assert.equal(p.fold(failed), null);
  assert.equal(p.into(failed.seq), null);
  assert.equal(p.fold(n3)?.seq, s.seq);
  assert.deepEqual(p.of(s.seq), [n1.seq, n3.seq]);
});

test("sent: what the message tool sent is not folded, even with the same words — its own act stands in between", () => {
  const p = page();
  const s = say("我去跟他说一声");
  const act = row("main", "act", 'mcp__self__message {"to":"阿树","text":"我去跟他说一声"}', { tool: "mcp__self__message", id: "t1" });
  const n = sent("我去跟他说一声", "qq:a", "b7");
  for (const r of [s, act]) p.fold(r);
  assert.equal(p.fold(n), null);
  assert.deepEqual(p.of(s.seq), []);
  // 之后的最终回复照常认
  const s2 = say("说过了");
  p.fold(s2);
  const n2 = sent("说过了", "qq:a", "b8");
  assert.equal(p.fold(n2)?.seq, s2.seq);
});

test("sent: only the same region, the same recipient and the same batch count as one reply", () => {
  const p = page();
  const s = say("好的\n\n好的");
  p.fold(s);
  const other = sent("好的", "qq:a", "b1", "阿树", "side-1");
  assert.equal(p.fold(other), null, "别的脑区记的不算");
  const n1 = sent("好的", "qq:a", "b1");
  assert.equal(p.fold(n1)?.seq, s.seq);
  assert.equal(p.fold(sent("好的", "qq:b", "b1", "小满")), null, "发给另一个人的不算");
  assert.equal(p.fold(sent("好的", "qq:a", "b2")), null, "另一批的不算");
  const n2 = sent("好的", "qq:a", "b1");
  assert.equal(p.fold(n2)?.seq, s.seq);
  assert.deepEqual(p.of(s.seq), [n1.seq, n2.seq]);
});

test("sent: words that are not in the say, an empty body, and notes that are not sends are left alone", () => {
  const p = page();
  const s = say("今天下雨");
  p.fold(s);
  assert.equal(p.fold(sent("今天晴")), null);
  assert.equal(p.fold(sent("")), null);
  assert.equal(p.fold(row("main", "note", "今天下雨", null)), null);
  assert.equal(p.fold(row("main", "note", "今天下雨", { sent: false })), null);
  assert.equal(p.fold(row("main", "note", "（上面这段没发给任何人）", { unsent: true, of: [s.seq] })), null);
  assert.deepEqual(p.of(s.seq), []);
});

test("sent: the head is taken off the way central.ts does — a name with one level of brackets, and the English form", () => {
  const p = page();
  for (const t of ["（发给 阿树）好的", "（发给 陌生人（000））好的（真的）", "（发给 群（一）的人）（在）", "没有头的一句", "（发给 阿树）"]) {
    assert.equal(p.text(t), t.replace(SENT_HEAD, ""), t);
  }
  assert.equal(MARKS_EN.sentHead, enPack.brain.forms.sentHead.source, "the English demo's head is the English pack's");
  const en = page(MARKS_EN.sentHead);
  assert.equal(en.text("(to Sam) Hello (again)"), "Hello (again)");
  assert.equal(en.text("(to Stranger (000)) Hi"), "Hi");
  const s = say("Hello\n\nBye");
  en.fold(s);
  const n = row("main", "note", "(to Sam) Bye", { sent: true, to: "wa:1", name: "Sam", batch: "b1" });
  assert.equal(en.fold(n)?.seq, s.seq);
});

test("sent: after older records are put in front, everything is recognised again from the start", () => {
  const p = page();
  const s = say("补上了");
  const n = sent("补上了");
  assert.equal(p.fold(n), null, "那段「说」还没读到：单独一行");
  p.refold([s, n]);
  assert.equal(p.into(n.seq), s.seq);
  assert.deepEqual(p.of(s.seq), [n.seq]);
  p.refold([n]);
  assert.equal(p.into(n.seq), null, "最早的一截丢掉以后不留旧的认法");
  assert.deepEqual(p.of(s.seq), []);
});

test("sent: only the last few says since the last act are kept open", () => {
  const p = page();
  const says = Array.from({ length: 10 }, (_, i) => say(`第 ${i} 段`));
  for (const s of says) p.fold(s);
  assert.equal(p.fold(sent("第 0 段")), null);
  assert.equal(p.fold(sent("第 9 段"))?.seq, says[9]!.seq);
});
