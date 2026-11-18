// ④ 被停过的会话换掉（11-13 CEO：被停换新会话、带上限，主线被停过也换）。
// 起因：11-13 16:25 一边做的那头同一个会话连撞 8 次、两件事被当成空转放下；21:04–21:36 主线同一个会话半小时被停 10 次——被停的那段留在会话历史里，接着用就容易连着停。
// 一边做的：这件事第一次被停（没做成，或者 CLI 接着跑成了）就换个新会话接着做；换过还没做成就放下，当场告诉她别再原样交。
// 主线：这一轮被停过就在安静时换新会话（下一次叫醒先换再送），两小时最多三次，再停留给翻页。只是别让坏掉的会话白烧轮次。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeBrain, flush } from "./helpers.ts";
import { refusalNoFallbackOf, stopSignalOf, STOP_NOTICE } from "../src/kernel/sdk.ts";
import * as P from "../src/lang/zh/prompts.ts";

const sides = (t: ReturnType<typeof makeBrain>) => t.driver.sessions.filter((s) => s.id === "side-1");
const mains = (t: ReturnType<typeof makeBrain>) => t.driver.sessions.filter((s) => s.id === "main");

async function handOff(topic: string, cfg: unknown = {}) {
  const t = makeBrain(cfg, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "on_it", args: { topic, about: "一小时" } } });
  await flush();
  assert.equal(sides(t).length, 1);
  return t;
}

test("内核：model_refusal_no_fallback 读出拦的类别（两种写法都认，没写算 unknown）；别的消息不算", () => {
  assert.equal(refusalNoFallbackOf({ type: "system", subtype: "model_refusal_no_fallback", api_refusal_category: "reasoning_extraction" }), "reasoning_extraction");
  assert.equal(refusalNoFallbackOf({ type: "system", subtype: "model_refusal_no_fallback", apiRefusalCategory: "cyber" }), "cyber");
  assert.equal(refusalNoFallbackOf({ type: "system", subtype: "model_refusal_no_fallback" }), "unknown");
  assert.equal(refusalNoFallbackOf({ type: "system", subtype: "model_refusal_fallback", api_refusal_category: "reasoning_extraction" }), null);
  assert.equal(refusalNoFallbackOf({ type: "assistant" }), null);
  assert.equal(refusalNoFallbackOf(null), null);
});

test("内核：认出这一轮被停过的三样信号（CLI 那句提示、refusal 收尾、没换模型的拒绝），别的不算；那句提示的原文不进仓库代码", () => {
  assert.equal(stopSignalOf({ type: "system", subtype: "informational", content: `${STOP_NOTICE} above · continuing once`, level: "notice" }), true);
  assert.equal(stopSignalOf({ type: "system", subtype: "informational", content: `Note: ${STOP_NOTICE.toUpperCase()}` }), false, "跟 CLI 原样的写法比（大小写不同就不是那句）");
  assert.equal(stopSignalOf({ type: "assistant", message: { stop_reason: "refusal" } }), true);
  assert.equal(stopSignalOf({ type: "system", subtype: "model_refusal_no_fallback" }), true);
  assert.equal(stopSignalOf({ type: "system", subtype: "informational", content: "Compacting conversation" }), false);
  assert.equal(stopSignalOf({ type: "assistant", message: { stop_reason: null } }), false);
  assert.equal(stopSignalOf({ type: "assistant", message: null }), false);
  assert.equal(stopSignalOf({ type: "system", subtype: "model_refusal_fallback" }), false, "换了模型重试的不算（会话历史里被拒的那条已经撤回）");
  assert.equal(stopSignalOf({ type: "result", subtype: "success" }), false);
  assert.equal(stopSignalOf(null), false);
  for (const f of ["src/kernel/sdk.ts", "src/brain.ts", "src/lang/zh/prompts.ts"]) {
    assert.ok(!readFileSync(new URL(`../${f}`, import.meta.url), "utf8").toLowerCase().includes(STOP_NOTICE), `${f} 里没有原文`);
  }
});

test("一边做的那头第一次被拦：换个新会话接着做这件事，不算一轮空转、不放下", async () => {
  const t = await handOff("黄仁勋那期：验成片");
  await sides(t)[0]!.play({ refused: "reasoning_extraction" });
  await flush();
  assert.ok(t.logs.some((l) => l.msg === "side: refused by the safety classifier, continuing in a fresh session" && l.category === "reasoning_extraction"));
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2, "开了新会话");
  assert.equal(sides(t)[0]!.closed, true, "被拦的那个会话关掉了");
  assert.match(sides(t)[1]!.sent.at(-1)!.text, /【接着做】黄仁勋那期：验成片/);
  assert.equal(sides(t)[1]!.sent.filter((m) => /接着做/.test(m.text)).length, 1, "只叫一遍");
  assert.equal(t.brain.tasks.doing("side-1")[0]!.topic, "黄仁勋那期：验成片", "还在做");
});

test("换了新会话还被拦：这件放下、认领放掉，当场叫醒她说清楚、别再原样交；她读到的话里不带类别，主人的名字从配置取", async () => {
  const t = await handOff("黄仁勋那期：验成片", { names: { owner: "阿树" } });
  await sides(t)[0]!.play({ refused: "reasoning_extraction" });
  await flush();
  t.clock.advance(60_000); await flush(); await flush();
  const main = t.driver.latest("main");
  const before = main.sent.length;
  await sides(t)[1]!.play({ refused: "reasoning_extraction" });
  await flush(); await flush();
  assert.equal(t.brain.tasks.doing("side-1").length, 0, "放下了");
  assert.ok(t.logs.some((l) => l.msg === "side: refused again in a fresh session, task put down" && l.category === "reasoning_extraction"), "类别进日志");
  assert.equal(main.sent.length, before + 1, "当场叫醒她");
  const said = main.sent.at(-1)!.text;
  assert.ok(said.includes(P.sideRefused("黄仁勋那期：验成片", "阿树")));
  assert.match(said, /问阿树/, "名字是配置里的主人");
  assert.doesNotMatch(said, /reasoning_extraction/, "类别不进她读到的话");
  assert.ok(t.brain.central.since(0).some((e) => e.text === P.sideRefusedNote("黄仁勋那期：验成片")), "那一头名下记一笔");
  assert.ok(!t.brain.central.since(0).some((e) => /reasoning_extraction/.test(e.text)), "记忆里也没有类别");
  t.clock.advance(10 * 60_000); await flush();
  assert.equal(sides(t).length, 2, "不再开第三个会话绕着撞");
  // 认领放掉了：她换个做法再交，照常交得出去（新的一件，又有一次换会话的机会）
  await main.play({ tool: { name: "on_it", args: { topic: "黄仁勋那期：验成片", about: "一小时" } } });
  await flush();
  assert.equal(t.brain.tasks.doing("side-1")[0]!.topic, "黄仁勋那期：验成片");
});

test("换过还被拦、配置里没写主人的名字：说「问主人」", async () => {
  const t = await handOff("整理素材", { names: { owner: "" } });
  await sides(t)[0]!.play({ refused: "reasoning_extraction" });
  await flush();
  t.clock.advance(60_000); await flush(); await flush();
  await sides(t)[1]!.play({ refused: "reasoning_extraction" });
  await flush(); await flush();
  const said = t.driver.latest("main").sent.at(-1)!.text;
  assert.ok(said.includes(P.sideRefused("整理素材", "主人")));
  assert.match(said, /问主人。/);
});

test("一边做的那头被停了、以失败收尾但内核没报类别：跟被拦一样，换新会话接着做", async () => {
  const t = await handOff("整理素材");
  await sides(t)[0]!.play({ fail: "api_error:invalid_request", stopped: true });
  await flush();
  assert.ok(t.logs.some((l) => l.msg === "side: refused by the safety classifier, continuing in a fresh session" && l.category === "unknown"));
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2);
  assert.match(sides(t)[1]!.sent.at(-1)!.text, /【接着做】整理素材/);
});

test("一边做的那头这一轮被停过、但接着跑成了：下一轮换新会话接着做；同一件事只换一次，换过再停照常接着做", async () => {
  const t = await handOff("整理素材");
  await sides(t)[0]!.play({ tool: { name: "jot_down", args: { text: "找到三段" } }, stopped: true });
  await flush();
  assert.ok(t.logs.some((l) => l.msg === "side: stopped this turn, next round in a fresh session"));
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2, "换了新会话");
  assert.equal(sides(t)[0]!.closed, true);
  assert.match(sides(t)[1]!.sent.at(-1)!.text, /【接着做】整理素材/);
  await sides(t)[1]!.play({ tool: { name: "jot_down", args: { text: "又找到两段" } }, stopped: true });
  await flush();
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2, "这件事已经换过一次，不再换");
  assert.match(sides(t)[1]!.sent.at(-1)!.text, /^接着做整理素材/);
  assert.equal(t.brain.tasks.doing("side-1")[0]!.topic, "整理素材", "没放下");
});

test("被拦后还没来得及换，内核自己又开了一轮（帮手交回之类）：不叫它；那一轮又被拦也不算「换过还拦」，换了新会话接着做", async () => {
  const t = await handOff("整理素材");
  const s1 = sides(t)[0]!;
  await s1.play({ refused: "reasoning_extraction" });
  await flush();
  const sentBefore = s1.sent.length;
  s1.busy = true;                       // 内核自己开的一轮
  t.clock.advance(10_000); await flush(); await flush();
  assert.equal(sides(t).length, 1, "它在忙：先不换");
  assert.equal(s1.sent.length, sentBefore, "也不叫它接着做");
  await s1.play({ refused: "reasoning_extraction" });   // 那一轮也被拦了
  await flush();
  assert.equal(t.brain.tasks.doing("side-1")[0]?.topic, "整理素材", "没放下：还没换过会话");
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2, "换了新会话");
  assert.match(sides(t)[1]!.sent.at(-1)!.text, /【接着做】整理素材/);
  assert.equal(sides(t)[1]!.sent.filter((m) => /接着做/.test(m.text)).length, 1, "只叫一遍");
});

test("一边做的那头紧接着两轮都被拦（还没来得及换）：只换一次、只叫一遍接着做", async () => {
  const t = await handOff("整理素材");
  await sides(t)[0]!.play({ refused: "reasoning_extraction" });
  await sides(t)[0]!.play({ refused: "reasoning_extraction" });
  await flush();
  t.clock.advance(60_000); await flush(); await flush();
  assert.equal(sides(t).length, 2);
  assert.equal(sides(t)[1]!.sent.filter((m) => /接着做/.test(m.text)).length, 1, "只叫一遍");
  assert.equal(t.brain.tasks.doing("side-1")[0]?.topic, "整理素材");
});

test("主线被停过、这一轮又正好要翻页：翻页中不单独换（翻页收尾整体换），翻完主线是新会话", async () => {
  const t = makeBrain({ limits: { pageTokens: 50 } }, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ tool: { name: "jot_down", args: { text: "上午写稿" } }, say: "很多很多的经历".repeat(20), stopped: true });
  await flush(); await flush();
  const hippo = t.driver.latest("hippocampus");
  assert.ok(hippo, "开始翻页（海马压缩）");
  t.clock.advance(10_000); await flush(); await flush();
  assert.equal(m1.closed, false, "翻页中主线不单独换");
  await hippo.play({ say: "- 上午写稿（#1）" });
  await flush(); await flush();
  assert.equal(m1.closed, true, "翻页收尾换掉了");
  t.clock.advance(10_000); await flush(); await flush();
  t.brain.wakeRegion("main", "接着");
  assert.equal(mains(t).length, 2, "只换了一次");
});

test("主线这一轮被停过（接着跑成了也算）：安静了就换新会话，下一次叫醒在新会话里", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ say: "NO_REPLY", stopped: true });
  await flush();
  assert.ok(t.logs.some((l) => l.msg === "main: stopped this turn, switching to a fresh session when quiet" && l.ok === true));
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(m1.closed, true, "被停过的会话关掉了");
  t.brain.wakeRegion("main", "接着");
  assert.equal(mains(t).length, 2);
  assert.match(mains(t)[1]!.sent.at(-1)!.text, /接着/);
});

test("主线换了新会话：下一轮开场带着最近这一段，她知道自己刚才在做什么", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ tool: { name: "jot_down", args: { text: "正在改第三段的开头，改到一半" } }, say: "第三段先这样，下一轮接着改结尾", stopped: true });
  await flush();
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(m1.closed, true);
  t.brain.wakeRegion("main", "接着");
  const m2 = t.driver.latest("main");
  assert.notEqual(m2, m1);
  const seen = `${m2.spec.systemAppend}\n${m2.sent.map((m) => m.text).join("\n")}`;
  assert.match(seen, /正在改第三段的开头，改到一半/, "她记下的那笔在新会话里");
  assert.match(seen, /下一轮接着改结尾/, "她刚说的话也在");
});

test("主线这一轮被拦、以失败收尾：一样换新会话", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ refused: "reasoning_extraction" });
  await flush();
  assert.ok(t.logs.some((l) => l.msg === "turn failed" && l.region === "main"));
  assert.ok(t.logs.some((l) => l.msg === "main: stopped this turn, switching to a fresh session when quiet" && l.ok === false && l.category === "reasoning_extraction"));
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(m1.closed, true);
});

test("主线被停过、还没到安静就来了人：先换新会话再送，这条不进被停过的会话", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ say: "NO_REPLY", stopped: true });
  await flush();
  const before = m1.sent.length;
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗，帮我看个东西", senderId: "+6155500010" });
  await flush(); await flush();
  assert.equal(m1.sent.length, before, "没送进旧会话");
  assert.equal(m1.closed, true);
  assert.equal(mains(t).length, 2);
  assert.match(mains(t)[1]!.sent.at(-1)!.text, /在吗，帮我看个东西/);
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(mains(t).length, 2, "不会再多换一次");
  assert.equal(mains(t)[1]!.closed, false);
});

test("主线没被停：照旧，不换会话", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ say: "NO_REPLY" });
  await flush();
  t.clock.advance(60_000); await flush();
  assert.equal(mains(t).length, 1);
  assert.equal(mains(t)[0]!.closed, false);
  assert.ok(!t.logs.some((l) => /^main: stopped/.test(l.msg)));
});

test("主线换新会话有上限：两小时里最多三次，第四次只记一笔、留给翻页；过了两小时又能换", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  for (let i = 1; i <= 3; i++) {
    t.brain.wakeRegion("main", `第${i}次`);
    const m = t.driver.latest("main");
    await m.play({ say: "NO_REPLY", stopped: true });
    await flush();
    t.clock.advance(5_000); await flush(); await flush();
    assert.equal(m.closed, true, `第 ${i} 次换了`);
  }
  t.brain.wakeRegion("main", "第4次");
  const m4 = t.driver.latest("main");
  await m4.play({ say: "NO_REPLY", stopped: true });
  await flush();
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(m4.closed, false, "到上限不换");
  assert.ok(t.logs.some((l) => l.msg === "main: stopped again, fresh-session cap reached; leaving it to the page turn" && l.rotations === 3));
  t.clock.advance(2 * 3_600_000); await flush();
  t.brain.wakeRegion("main", "第5次");
  const m5 = t.driver.latest("main");
  assert.equal(m5, m4, "还是那个会话");
  await m5.play({ say: "NO_REPLY", stopped: true });
  await flush();
  t.clock.advance(5_000); await flush(); await flush();
  assert.equal(m5.closed, true, "过了两小时又能换");
});

test("主线回人的这一轮被拦、什么都没发出去：换新会话以后把那条消息再交给她一次（开头说上一轮那段没发给对方），不再记一遍", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.fromChannel({ channel: "whatsapp", text: "帮我看看这个合同", senderId: "+6155500010" });
  await flush(); await flush();
  const m1 = t.driver.latest("main");
  const inputs = () => t.brain.central.since(0).filter((e) => e.kind === "input").length;
  const before = inputs();
  await m1.play({ refused: "reasoning_extraction" });
  await flush(); await flush();
  assert.equal(m1.closed, true, "被拦的会话换掉了");
  const m2 = mains(t).at(-1)!;
  assert.notEqual(m2, m1);
  assert.match(m2.sent.at(-1)!.text, /你上一轮最后写的那段没发给/);
  assert.equal(inputs(), before, "那条消息没有再记一遍");
  assert.ok(t.logs.some((l) => l.msg === "main: stopped while answering someone, message handed over again"));
});

test("主线不是在回人的那一轮被拦：照旧安静了再换，不交任何消息", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  const m1 = t.driver.latest("main");
  await m1.play({ refused: "reasoning_extraction" });
  await flush(); await flush();
  assert.ok(!t.logs.some((l) => l.msg === "main: stopped while answering someone, message handed over again"));
  assert.equal(mains(t).length, 1, "没有叫醒新会话");
});

test("主线回人时被拦、两小时里已经换满三次：不再换，也不再交，记一条 warn", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  for (let i = 0; i < 4; i++) {
    t.brain.fromChannel({ channel: "whatsapp", text: `第 ${i + 1} 句`, senderId: "+6155500010" });
    await flush(); await flush();
    await t.driver.latest("main").play({ refused: "reasoning_extraction" });
    await flush(); await flush();
  }
  assert.equal(t.logs.filter((l) => l.msg === "main: stopped while answering someone, message handed over again").length, 3);
  assert.ok(t.logs.some((l) => l.msg === "main: stopped again, fresh-session cap reached; leaving it to the page turn"));
});
