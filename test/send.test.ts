// 从「发出去」到「记忆里记着发过」这一路（11-11 毛病本）：QQ 号只差大小写也认得、发给群名时记下网关认出的会话号、
// 超时了用同一个去重编号再问网关一次（#0063）、发之前对一遍她自己记下的词表（#0015）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { CentralMemory, sentBody } from "../src/memory/central.ts";
import { B } from "../src/lang/index.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { MemIndex } from "../src/memory/events/index.ts";
import { join } from "node:path";
import { targetKey } from "../src/persona/people.ts";
import { buildTools } from "../src/tools/hhtools.ts";
import { gatewayChannel } from "../src/channels/gateway.ts";
import { GatewayClient, GatewayError, GatewayUnsure } from "../src/gateway/client.ts";
import { parseWordList, WordList } from "../src/tools/wordlist.ts";
import type { ToolContext } from "../src/tools/hhtools.ts";
import { makeBrain, flush } from "./helpers.ts";
import { consoleSource } from "./console-web.ts";
import { pageMarks } from "../src/console/packtext.ts";

const T0 = Date.UTC(2026, 10, 11, 3, 0);
const OPENID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAA0001";
const QQ_UP = `qqbot:c2c:${OPENID}`;
const QQ_LO = `qqbot:c2c:${OPENID.toLowerCase()}`;
const QQ_OTHER = "qqbot:c2c:FFFF0000FFFF0000FFFF0000FFFF0000";
const STRANGER_WA = "+6155500015";

type Call = { method: string; params: Record<string, unknown>; timeoutMs: number | undefined };

/** 假网关：每次调用都记下；answer 决定回什么 */
function spyGateway(answer: (method: string, params: Record<string, unknown>) => unknown = () => ({ messageId: "M1" })) {
  const calls: Call[] = [];
  const gateway = {
    connected: true,
    request: async (method: string, params: Record<string, unknown>, timeoutMs?: number) => { calls.push({ method, params, timeoutMs }); return answer(method, params); },
  };
  return { calls, gateway: gateway as never, sends: () => calls.filter((c) => c.method === "send").map((c) => c.params.message) };
}

/** 网关先卡着（像发气泡要几秒），release 以后才算发出去 */
function slowGateway() {
  const sends: unknown[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const gateway = { connected: true, request: async (method: string, params: Record<string, unknown>) => { await gate; if (method === "send") sends.push(params.message); return {}; } };
  return { gateway: gateway as never, sends, release: () => open() };
}

const sentNotes = (t: ReturnType<typeof makeBrain>) => t.brain.central.since(0).filter((e) => e.kind === "note" && e.meta?.sent === true);

test("targetKey：QQ 的私聊、群聊号去掉前缀、不分大小写；别的只去掉首尾空白", () => {
  assert.equal(targetKey(QQ_UP), OPENID.toLowerCase());
  assert.equal(targetKey(` ${QQ_LO} `), OPENID.toLowerCase());
  assert.equal(targetKey("QQBot:Group:G1abc"), "g1abc");
  assert.equal(targetKey(" +6155500015 "), STRANGER_WA);
  assert.equal(targetKey("Some Group"), "Some Group");
});

test("A：「最近说过的」认 QQ 号不分大小写：工具记的是名单里的大写号，回复用的是小写的，两边都找得到", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  c.append(1, "main", "note", "（发给 某人）在的", { sent: true, to: QQ_UP, name: "某人" }, T0 - 60_000);
  c.append(1, "main", "note", "（发给 别人）不是他", { sent: true, to: QQ_OTHER }, T0 - 30_000);
  assert.deepEqual(c.recentSent(QQ_LO, T0 - 3_600_000).map((x) => x.text), ["在的"]);
  assert.deepEqual(c.recentSent(QQ_UP, T0 - 3_600_000).map((x) => x.text), ["在的"]);
  // 陌生人记成「陌生人（号码）」：开头的「（发给 …）」整个去掉，不留半截括号
  c.append(1, "main", "note", `（发给 陌生人（${STRANGER_WA}））你好`, { sent: true, to: STRANGER_WA }, T0 - 10_000);
  assert.deepEqual(c.recentSent(STRANGER_WA, T0 - 3_600_000).map((x) => x.text), ["你好"]);
});

test("A：最后一次来消息的时间认 QQ 号不分大小写（QQ 一小时的回复窗口）", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  c.append(1, "外界", "input", "早", { channel: "qqbot", human: true, replyTo: { channel: "qqbot", target: QQ_UP } }, T0 - 20 * 60_000);
  c.append(1, "外界", "input", "在吗", { channel: "qqbot", human: true, replyTo: { channel: "qqbot", target: QQ_LO } }, T0 - 5 * 60_000);
  c.append(1, "外界", "input", "别人", { channel: "qqbot", human: true, replyTo: { channel: "qqbot", target: QQ_OTHER } }, T0 - 60_000);
  assert.equal(c.lastHeardFrom("qqbot", QQ_UP), T0 - 5 * 60_000);
  assert.equal(c.lastHeardFrom("qqbot", QQ_LO), T0 - 5 * 60_000);
  assert.equal(c.lastHeardFrom("whatsapp", QQ_UP), null);
});

test("A：最终回复还在路上时，换个大小写问「最近对他说过的」也看得到（标正在发）；发出去以后也一样", async () => {
  const g = slowGateway();
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: g.gateway });
  const saidTo = (x: string) => (t.brain as unknown as { saidTo(x: string): Array<{ text: string; pending?: boolean }> }).saidTo(x).map((s) => [s.text, s.pending === true]);
  t.brain.fromChannel({ channel: "qqbot", text: "在吗", senderId: OPENID });
  await t.driver.latest("main").play({ say: "在的" });
  await flush();
  assert.deepEqual(saidTo(QQ_LO), [["在的", true]], "还在路上");
  g.release(); await flush(); await flush(); await flush();
  assert.deepEqual(g.sends, ["在的"]);
  assert.deepEqual(saidTo(QQ_LO), [["在的", false]], "发出去了：中央记忆里那条");
});

test("B：message 发给群名，网关回了它认出的会话号：记下 toId，按会话号问「最近说过的」也找得到；跟她写的一样就不另记", async () => {
  let payload: Record<string, unknown> = { messageId: "M1", conversationId: "G1" };
  const g = spyGateway(() => payload);
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: g.gateway });
  t.brain.wakeRegion("main", "跟群里说一声");
  const main = t.driver.latest("main");
  const send = (channel: string, target: string, message: string) => main.play({ tool: { name: "message", args: { channel, target, message } } });

  await send("whatsapp", "some group name", "大家好");
  assert.equal(g.calls[0]!.params.to, "some group name", "怎么称呼群照旧：网关自己认");
  assert.equal(sentNotes(t)[0]!.meta!.to, "some group name");
  assert.equal(sentNotes(t)[0]!.meta!.toId, "G1");
  assert.deepEqual(t.brain.central.recentSent("G1", 0).map((x) => x.text), ["大家好"]);
  assert.deepEqual(t.brain.central.recentSent("some group name", 0).map((x) => x.text), ["大家好"]);

  payload = { messageId: "M2", conversationId: "some group name" };
  await send("whatsapp", "some group name", "第二句");
  payload = { messageId: "M3", chatId: QQ_LO };
  await send("qqbot", QQ_UP, "第三句");
  assert.equal(sentNotes(t).length, 3);
  assert.deepEqual(sentNotes(t).slice(1).map((e) => "toId" in e.meta!), [false, false], "网关回的就是她写的（QQ 号只差大小写也算）：不另记");
});

test("B：网关回的会话号取 conversationId、chatId、toJid 里第一个非空的字符串，交给 recordSend", async () => {
  const got: Array<string | undefined> = [];
  let payload: unknown = {};
  const ctx: ToolContext = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: false, timezone: "UTC", sideThreads: 2,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    send: gatewayChannel({ connected: true, request: async <T>() => payload as T }).send,
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recallLocal: () => "",
    recordSend: (_to, _text, resolved) => { got.push(resolved); },
  };
  const message = buildTools(ctx, ["message"])[0]!;
  for (const p of [{ conversationId: "", chatId: "C1", toJid: "J1" }, { toJid: "J2" }, { conversationId: 5, chatId: "  " }, null]) {
    payload = p;
    await message.handler({ channel: "whatsapp", target: "某个群", message: "hi" });
  }
  assert.deepEqual(got, ["C1", "J2", undefined, undefined]);
});

/** 网关按顺序回：timeout 每个请求自己的时限到了、dropped 连接断了、refused 网关说没发出去、down 连不上、ok 发出去了 */
type Answer = "timeout" | "dropped" | "refused" | "down" | "ok";
function scripted(...answers: Answer[]) {
  return spyGateway((method) => {
    const a = answers.shift() ?? "ok";
    if (a === "timeout") throw new GatewayUnsure(`gateway ${method} timeout`, "timeout");
    if (a === "dropped") throw new GatewayUnsure("gateway closed（请求已经发出去了）", "dropped");
    if (a === "refused") throw new GatewayError("UNAVAILABLE", "No delivery result");
    if (a === "down") throw new Error("gateway not open");
    return { messageId: "M1" };
  });
}
const text = { channel: "whatsapp", target: STRANGER_WA, text: "在的" };
/** Records what the gateway channel's send logs (level, message, fields) */
function logSpy() {
  const lines: Array<{ level: string; msg: string; extra: Record<string, unknown> }> = [];
  const at = (level: string) => (msg: string, extra: Record<string, unknown> = {}) => { lines.push({ level, msg, extra }); };
  return { lines, log: { info: at("info"), warn: at("warn") } };
}
const UNSURE_TODAY = "不确定发出去没有（gateway closed（请求已经发出去了））：先别重发，过一会儿看看对方收没收到";

test("C #0063：发出去了没等到回音（超时）：同样的请求、同一个去重编号再问网关一次；这次回了就算发出去了", async () => {
  const s = scripted("timeout", "ok");
  const l = logSpy();
  const r = await gatewayChannel(s.gateway, { retryMs: 0, log: l.log }).send(text);
  assert.equal(r.ok, true);
  assert.equal(s.calls.length, 2, "只再问一次");
  assert.equal(s.calls[1]!.method, "send");
  assert.deepEqual(s.calls[1]!.params, s.calls[0]!.params, "一模一样的请求");
  assert.equal(s.calls[1]!.params.idempotencyKey, s.calls[0]!.params.idempotencyKey);
  assert.equal(s.calls[1]!.timeoutMs, 60_000, "文字等一分钟");
  assert.equal(r.out, JSON.stringify({ messageId: "M1" }), "跟平常发成了一样");
  assert.deepEqual(l.lines, [{ level: "info", msg: "send confirmed after timeout", extra: { channel: "whatsapp", to: STRANGER_WA } }]);
  const m = scripted("timeout", "ok");
  assert.equal((await gatewayChannel(m.gateway).send({ ...text, text: "", media: "/a.png" })).ok, true);
  assert.deepEqual(m.calls.map((c) => c.timeoutMs), [150_000, 150_000], "带图的等两分半");
});

test("C：再问一次，网关说没发出去（它把上一次的结果留着）：没发出去，说明超时后查过一次", async () => {
  const s = scripted("timeout", "refused");
  const l = logSpy();
  const r = await gatewayChannel(s.gateway, { retryMs: 0, log: l.log }).send(text);
  assert.equal(r.ok, false);
  assert.equal(s.calls.length, 2);
  assert.equal(r.out, "网关没发出去：UNAVAILABLE No delivery result（超时后查过一次）");
  assert.deepEqual(l.lines, [{ level: "warn", msg: "send refused on re-ask", extra: { channel: "whatsapp", to: STRANGER_WA, code: "UNAVAILABLE" } }], "只记渠道、目标和错误码，不记话");
});

test("C：再问一次还是没回音（又超时、断了、连不上）：仍说不确定、先别重发，并说已经又查了一次", async () => {
  for (const second of ["timeout", "dropped", "down"] as const) {
    const s = scripted("timeout", second);
    const l = logSpy();
    const r = await gatewayChannel(s.gateway, { retryMs: 0, log: l.log }).send(text);
    assert.equal(r.ok, false, second);
    assert.deepEqual(l.lines, [{ level: "warn", msg: "send still unsure after re-ask", extra: { channel: "whatsapp", to: STRANGER_WA } }], second);
    assert.equal(s.calls.length, 2, `${second}：只再问一次`);
    assert.match(r.out, /^不确定发出去没有（gateway send timeout；.*查了一次.*）：先别重发，过一会儿看看对方收没收到$/, second);
  }
});

test("C：连接断了（可能是网关重启了、去重的记录跟着没了）不再问，照旧说不确定", async () => {
  const d = scripted("dropped");
  const r1 = await gatewayChannel(d.gateway, { retryMs: 0 }).send(text);
  assert.equal(d.calls.length, 1);
  assert.equal(r1.ok, false);
  assert.equal(r1.out, UNSURE_TODAY);
});

test("C：最终回复超时、再问一次网关说没发出去：记成这句没发、带上「超时后查过一次」，不记成发过", async () => {
  const s = scripted("timeout", "refused");
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: s.gateway });
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: "在的" });
  await flush(); await flush(); await flush();
  const failed = t.brain.central.since(0).filter((e) => e.meta?.sendFailed === true);
  assert.equal(failed.length, 1);
  assert.ok(failed[0]!.text.includes("（超时后查过一次）"), failed[0]!.text);
  assert.equal(sentNotes(t).length, 0);
});

test("B+C：message 发给群名超时、再问一次网关回了它认出的会话号：照样记下 toId", async () => {
  let n = 0;
  const g = spyGateway(() => { if (n++ === 0) throw new GatewayUnsure("gateway send timeout", "timeout"); return { messageId: "M1", conversationId: "G1" }; });
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: g.gateway });
  t.brain.wakeRegion("main", "跟群里说一声");
  await t.driver.latest("main").play({ tool: { name: "message", args: { channel: "whatsapp", target: "some group name", message: "大家好" } } });
  assert.equal(g.calls.length, 2);
  assert.equal(sentNotes(t).length, 1);
  assert.equal(sentNotes(t)[0]!.meta!.toId, "G1");
});

/** 这几句没全发出去时，下一次叫醒她附的那一行 */
/** 不是回那个人的这一轮（自己醒的、回别人的）：要补得用 message 发，写清渠道和发送目标（照着就能发，final-review R-1） */
const missLine = (who: string, parts: string, target = STRANGER_WA, channel = "whatsapp") =>
  `（刚才回 ${who} 的话没有全发出去：${parts}。要补就用 message 发（channel ${channel}，target ${target}），这一轮最后写的话不会发给那边；拿不准的先别重发。）`;
/** 又是回那个人的这一轮：这一轮最后写的话就发给他 */
const missHere = (who: string, parts: string) => `（刚才回 ${who} 的话没有全发出去：${parts}。要补就在这次回复里补，拿不准的先别重发。）`;
const WHO = `陌生人（${STRANGER_WA}）`;
/** 陌生人发来一句，她回三个气泡；网关照 s 回。words：顺带配上词表（甲 有理由） */
async function threeBubbles(s: ReturnType<typeof scripted>, o: { words?: boolean; say?: string } = {}) {
  const files: Record<string, string> = o.words ? { [WORDS]: "- 甲｜太生硬\n" } : {};
  const t = makeBrain({ tools: { sendDryRun: false, wordListFile: "memory/words.md" } }, undefined, {
    gateway: s.gateway, readText: (p) => files[p] ?? null, mtime: (p) => (p in files ? 1 : null),
  });
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: o.say ?? "第一句\n\n第二句\n\n第三句" });
  await flush(); await flush(); await flush(); await flush();
  return t;
}
const failedTexts = (t: ReturnType<typeof makeBrain>) => t.brain.central.since(0).filter((e) => e.meta?.sendFailed === true).map((e) => e.text);
const inflightSize = (t: ReturnType<typeof makeBrain>) => (t.brain as unknown as { inflight: Map<string, unknown> }).inflight.size;
/** 叫醒她一次，返回这次叫醒的全文 */
const nextWake = (t: ReturnType<typeof makeBrain>, text = "接着做") => { t.brain.wakeRegion("main", text); return t.driver.latest("main").sent.at(-1)!.text; };

test("I-1 / N-1：网关卡住了：第一句再问一次还没回音，后面几句先不发、记成没发；下一次叫醒她时说清哪句拿不准、哪几句先没发，只说一次", async () => {
  const stuck = scripted("timeout", "timeout", "timeout", "timeout", "timeout", "timeout");
  const t = await threeBubbles(stuck);
  assert.equal(stuck.calls.length, 2, "整轮只再问了一次");
  const failed = failedTexts(t);
  assert.equal(failed.length, 3);
  assert.match(failed[0]!, new RegExp(`^（这句没发给 ${WHO.replace(/[()+（）]/g, "\\$&")}：不确定发出去没有（gateway send timeout；.*查了一次.*）第一句$`));
  assert.deepEqual(failed.slice(1), [`（这句没发给 ${WHO}：前一句还没确认发出去，后面几句先没发）第二句`, `（这句没发给 ${WHO}：前一句还没确认发出去，后面几句先没发）第三句`]);
  assert.equal(sentNotes(t).length, 0);
  assert.equal(inflightSize(t), 0, "都从「在路上」划掉了");
  const line = missLine(WHO, "「第一句」不确定发出去没有；后面「第二句」「第三句」先没发");
  assert.equal(nextWake(t).split(line).length - 1, 1, "下一次叫醒：一行，只一次");
  assert.ok(!nextWake(t, "再接着").includes("没有全发出去"), "给过就清掉");
});

test("N-1：中间一句网关明确拒了：那句没发出去，别的照发；下一次叫醒先说没发出去的，再说用了的词", async () => {
  const s = scripted("ok", "refused", "ok");
  const t = await threeBubbles(s, { words: true, say: "有点甲\n\n第二句\n\n第三句" });
  assert.equal(s.calls.length, 3);
  assert.deepEqual(sentNotes(t).map((e) => e.text), [`（发给 ${WHO}）有点甲`, `（发给 ${WHO}）第三句`]);
  const text = nextWake(t);
  assert.ok(text.includes(`${missLine(WHO, "「第二句」没发出去")}\n（刚才发出去的话里用了「甲」太生硬：下次换个说法。）`), text);
});

test("N-1：第一句连接断了（可能是网关重启）：不再问，后面几句照发（重连了）；第一句说不确定", async () => {
  const s = scripted("dropped", "ok", "ok");
  const t = await threeBubbles(s);
  assert.equal(s.calls.length, 3, "后面的照发");
  assert.equal(failedTexts(t).length, 1);
  assert.deepEqual(sentNotes(t).map((e) => e.text), [`（发给 ${WHO}）第二句`, `（发给 ${WHO}）第三句`]);
  assert.equal(inflightSize(t), 0);
  assert.ok(nextWake(t).includes(missLine(WHO, "「第一句」不确定发出去没有")));
});

test("N-1：下一次叫醒之前有两个人的回复都没全发出去：各一行；长的气泡截短", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const gateway = { connected: true, request: async () => { await gate; throw new GatewayError("UNAVAILABLE", "No delivery result"); } };
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: gateway as never });
  const main = () => t.driver.latest("main");
  const other = "+6155500014";
  const long = "这是一句很长的话".repeat(8);
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await main().play({ say: "给第一个人的话" });
  await flush();
  t.brain.fromChannel({ channel: "whatsapp", text: "你好", senderId: other });
  assert.ok(!main().sent.at(-1)!.text.includes("没有全发出去"), "前一个回复还卡在网关上：还没有可说的");
  await main().play({ say: long });
  open(); await flush(); await flush(); await flush(); await flush();
  const text = nextWake(t);
  const clipped = `「${[...long].slice(0, 40).join("")}…」`;
  assert.ok(text.includes(`${missLine(WHO, "「给第一个人的话」没发出去")}\n${missLine(`陌生人（${other}）`, `${clipped}没发出去`, other)}`), text);
});

test("F-1：A 的回复没全发出去，下一次叫醒是回 B 的：那一行点名 A、叫她用 message 补（最后写的话会发给 B）；又是回 A 的：就在这次回复里补", async () => {
  const other = "+6155500014";
  const toA = scripted("refused");
  const a = await threeBubbles(toA, { say: "第一句" });
  a.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: other });
  const forB = a.driver.latest("main").sent.at(-1)!.text;
  assert.ok(forB.includes(missLine(WHO, "「第一句」没发出去")), forB);
  assert.ok(!forB.includes("要补就在这次回复里补"));

  const toA2 = scripted("refused");
  const b = await threeBubbles(toA2, { say: "第一句" });
  b.brain.fromChannel({ channel: "whatsapp", text: "还在吗", senderId: STRANGER_WA });
  const forA = b.driver.latest("main").sent.at(-1)!.text;
  assert.ok(forA.includes(missHere(WHO, "「第一句」没发出去")), forA);
  assert.ok(!forA.includes("要补就用 message"));
});

test("R-1：回群的那几句没全发出去：下一次（不是回这个群的）叫醒说的是那个群的会话，照着 channel、target 就能补，不点名群里说话的人", async () => {
  const s = scripted("refused");
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: s.gateway });
  const member = "+6155500013";
  t.brain.fromChannel({ channel: "whatsapp", text: "大家好", senderId: member, isGroup: true, conversationId: "G1@g.us" });
  await t.driver.latest("main").play({ say: "大家好呀" });
  await flush(); await flush(); await flush(); await flush();
  assert.equal(s.calls[0]!.params.to, "G1@g.us", "回的是群");
  const line = nextWake(t).split("\n").find((l) => l.includes("没有全发出去"))!;
  assert.equal(line, "（刚才在 G1@g.us 的回复没有全发出去：「大家好呀」没发出去。要补就用 message 发（channel whatsapp，target G1@g.us），这一轮最后写的话不会发到那边；拿不准的先别重发。）");
  assert.ok(!line.includes(member), "不点名说话的那个人");
});

test("N-4：叫醒抛错了：取走的提醒放回去，下一次叫醒照样附", async () => {
  const { t } = wordBrain();
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: "有点甲" });
  await flush(); await flush(); await flush();
  const r = t.brain.regions.get("main")!;
  const orig = r.wake.bind(r);
  let fail = true;
  r.wake = (text, o) => { if (fail) { fail = false; throw new Error("内核挂了"); } return orig(text, o); };
  assert.throws(() => t.brain.wakeRegion("main", "开始"), /内核挂了/);
  assert.ok(nextWake(t, "再来").includes("（刚才发出去的话里用了「甲」太生硬：下次换个说法。）"));
});

test("C：网关客户端分得清一个请求自己超时（timeout）和连接断了、在等的都没了回音（dropped）", async () => {
  const g = new GatewayClient({ url: "ws://127.0.0.1:1", token: "t", log: { info() {}, warn() {}, error() {}, child() { return this; } } as never });
  const inner = g as unknown as { ws: unknown; send(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown>; reset(e: Error): void };
  inner.ws = { readyState: WebSocket.OPEN, send: () => {}, close: () => {} };
  await assert.rejects(inner.send("send", {}, 5), (e: unknown) => e instanceof GatewayUnsure && e.kind === "timeout");
  const waiting = inner.send("send", {}, 60_000);
  inner.reset(new Error("gateway closed"));
  await assert.rejects(waiting, (e: unknown) => e instanceof GatewayUnsure && e.kind === "dropped");
});

test("C：最终回复超时、再问一次网关说发出去了：记成发过，不记「没发出去」", async () => {
  const s = scripted("timeout", "ok");
  const t = makeBrain({ tools: { sendDryRun: false } }, undefined, { gateway: s.gateway });
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: "在的" });
  await flush(); await flush(); await flush();
  assert.equal(s.calls.length, 2);
  assert.deepEqual(sentNotes(t).map((e) => e.text), [`（发给 陌生人（${STRANGER_WA}））在的`]);
  assert.ok(!t.brain.central.since(0).some((e) => e.meta?.sendFailed === true));
  assert.ok(t.logs.some((l) => l.level === "info" && l.msg === "send confirmed after timeout"));
});

test("F #0015 词表：只认「- 」开头的行，第一个「｜」或「|」前是词、后是理由（可以空）；标题、空行、空词、别的行跳过", () => {
  assert.deepEqual(parseWordList("# 标题\n\n- 甲｜理由\n- 乙|\n- ｜x\n说明文字\n  - 戊｜缩进的不算\n- 丙\r\n- 丁|理由｜还有\n- 甲｜重复的只留第一条\n"), [
    { word: "甲", reason: "理由" },
    { word: "乙", reason: "" },
    { word: "丙", reason: "" },
    { word: "丁", reason: "理由｜还有" },
  ]);
});

test("F：词表文件 mtime 变了才重读；没有、读不了就不查，同一个 mtime 最多记一次 warn；没配路径不查", () => {
  let mt: number | null = null;
  let body: string | null = "- 甲｜理由";
  let reads = 0;
  const warns: string[] = [];
  const w = new WordList({ path: "/ws/memory/words.md", read: () => { reads++; return body; }, mtime: () => mt, log: { warn: (m: string) => { warns.push(m); } } });
  assert.deepEqual(w.current(), []);
  assert.deepEqual(w.current(), []);
  assert.equal(warns.length, 1, "没有文件：只记一次");
  mt = 1;
  assert.deepEqual(w.current().map((x) => x.word), ["甲"]);
  w.current();
  assert.equal(reads, 1, "mtime 没变不重读");
  body = "- 乙"; mt = 2;
  assert.deepEqual(w.current().map((x) => x.word), ["乙"]);
  body = null; mt = 3;
  assert.deepEqual(w.current(), [], "读不了：不查");
  w.current();
  assert.equal(warns.length, 2, "这个 mtime 只记一次");
  assert.deepEqual(new WordList({ path: null, read: () => "- 甲", mtime: () => 1, log: { warn() {} } }).current(), []);
});

const WORDS = "/tmp/hh-test-ws/memory/words.md";
/** 词表在 memory/words.md（甲 有理由、乙 没写理由）；text: null = 没有这个文件；file 改 wordListFile；refuse = 网关一律说没发出去 */
function wordBrain(o: { file?: string; text?: string | null; refuse?: boolean } = {}) {
  const files: Record<string, string> = o.text === null ? {} : { [WORDS]: o.text ?? "# 别这么说\n- 甲｜太生硬\n- 乙\n" };
  const reads: string[] = [];
  const g = spyGateway(() => { if (o.refuse) throw new GatewayError("UNAVAILABLE", "No delivery result"); return { messageId: "M1" }; });
  const t = makeBrain({ tools: { sendDryRun: false, wordListFile: o.file ?? "memory/words.md" } }, undefined, {
    gateway: g.gateway, readText: (p) => { reads.push(p); return files[p] ?? null; }, mtime: (p) => (p in files ? 1 : null),
  });
  return { t, sends: g.sends, reads };
}
const lastResult = (t: ReturnType<typeof makeBrain>) => t.brain.central.since(0).filter((e) => e.kind === "result").at(-1)!.text;
const HELD = "这条还没发出去：「甲」太生硬。换个说法再发；要是就想这么说，原样再发一次会照发。";

test("F：message 要发的话里有她记下的词：先不发，告诉她哪个词、为什么；十分钟里原样再发给同一个人照发，换了说法的再对一遍", async () => {
  const { t, sends } = wordBrain();
  t.brain.wakeRegion("main", "回消息");
  const main = t.driver.latest("main");
  const send = (message: string, channel = "whatsapp", target = STRANGER_WA) => main.play({ tool: { name: "message", args: { channel, target, message } } });

  await send("这样有点甲");
  assert.deepEqual(sends(), [], "先不发");
  assert.equal(lastResult(t), HELD);
  assert.equal(sentNotes(t).length, 0, "没发的不记成发过");
  await send("这样有点甲");
  assert.deepEqual(sends(), ["这样有点甲"], "原样再发：照发（她说了算）");
  await send("甲和乙都在");
  assert.deepEqual(sends(), ["这样有点甲"], "换了一句：再对一遍");
  assert.equal(lastResult(t), "这条还没发出去：「甲」太生硬；「乙」在你记下的不自然的词里。换个说法再发；要是就想这么说，原样再发一次会照发。");
  await send("没有那些词");
  assert.deepEqual(sends(), ["这样有点甲", "没有那些词"], "没对上的照发");

  await send("乙在这", "qqbot", QQ_UP);
  assert.equal(sends().length, 2);
  await send("乙在这", "qqbot", QQ_LO);
  assert.deepEqual(sends().at(-1), "乙在这", "QQ 号只差大小写：算同一个人，原样再发照发");
  await send("甲和乙都在", "whatsapp", "+6155500014");
  assert.equal(sends().length, 3, "同一句发给别人：那边没拦过，先不发");

  t.clock.advance(11 * 60_000);
  await send("这样有点甲");
  assert.equal(sends().length, 3, "过了十分钟再原样发：又先不发");
  assert.equal(lastResult(t), HELD);
  assert.ok(t.logs.some((l) => l.msg === "word list: held a message"));
});

test("F：没有词表文件、wordListFile 写空：不查，照发", async () => {
  for (const o of [{ text: null }, { file: "" }]) {
    const { t, sends, reads } = wordBrain(o);
    t.brain.wakeRegion("main", "回消息");
    await t.driver.latest("main").play({ tool: { name: "message", args: { channel: "whatsapp", target: STRANGER_WA, message: "这样有点甲" } } });
    assert.deepEqual(sends(), ["这样有点甲"], JSON.stringify(o));
    if (o.file === "") assert.ok(!reads.some((p) => p.includes("words")), "写空：不读文件");
  }
});

test("F：最终回复拦不下：照发；发出去的气泡里有词表里的词，这一轮记一笔提醒她（不算发过的话）", async () => {
  const { t, sends } = wordBrain();
  const hints = () => t.brain.central.since(0).filter((e) => e.meta?.wordHint === true);
  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: "在的，有点甲\n\n乙也在\n\n甲又来了" });
  await flush(); await flush(); await flush();
  assert.deepEqual(sends(), ["在的，有点甲", "乙也在", "甲又来了"], "照发");
  assert.equal(hints().length, 1, "一轮一笔");
  assert.equal(hints()[0]!.src, "main");
  assert.equal(hints()[0]!.kind, "note");
  assert.deepEqual(hints()[0]!.meta, { wordHint: true });
  assert.equal(hints()[0]!.text, `（刚才发给 陌生人（${STRANGER_WA}） 的话里用了「甲」：太生硬；「乙」。下次换个说法。）`);
  assert.deepEqual(t.brain.central.recentSent(STRANGER_WA, 0).map((x) => x.text), ["在的，有点甲", "乙也在", "甲又来了"], "提醒不算说过的话");

  t.brain.fromChannel({ channel: "whatsapp", text: "好", senderId: STRANGER_WA });
  await t.driver.latest("main").play({ say: "嗯嗯" });
  await flush(); await flush(); await flush();
  assert.equal(hints().length, 1, "没用到的不记");

  const r = wordBrain({ refuse: true });
  r.t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await r.t.driver.latest("main").play({ say: "在的，有点甲" });
  await flush(); await flush(); await flush();
  assert.equal(r.t.brain.central.since(0).filter((e) => e.meta?.wordHint === true).length, 0, "没发出去的不提醒");
});

test("M-1：拦过的那句原样再发照发，并且从这一次重新算十分钟（发之前的另一道检查叫她核完再发，核九分钟也不会再被词表拦）", async () => {
  const { t, sends } = wordBrain();
  t.brain.wakeRegion("main", "回消息");
  const main = t.driver.latest("main");
  const send = () => main.play({ tool: { name: "message", args: { channel: "whatsapp", target: STRANGER_WA, message: "这样有点甲" } } });
  await send();
  assert.equal(sends().length, 0);
  t.clock.advance(60_000);
  await send();
  assert.equal(sends().length, 1, "原样再发：照发");
  t.clock.advance(9 * 60_000);
  await send();
  assert.equal(sends().length, 2, "离上一次照发九分钟：还算她坚持这么说");
  t.clock.advance(21 * 60_000);
  await send();
  assert.equal(sends().length, 2, "隔久了：又先不发");
  assert.equal(lastResult(t), HELD);
});

test("C1：最终回复里用了词表里的词：下一次叫醒她（回人的那一轮也算）附一句提醒，只给一次；几轮攒下的并成一行", async () => {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const files: Record<string, string> = { [WORDS]: "- 甲｜太生硬。\n- 乙\n" };
  const gateway = { connected: true, request: async () => { await gate; return { messageId: "M1" }; } };
  const t = makeBrain({ tools: { sendDryRun: false, wordListFile: "memory/words.md" } }, undefined, {
    gateway: gateway as never, readText: (p) => files[p] ?? null, mtime: (p) => (p in files ? 1 : null),
  });
  const main = () => t.driver.latest("main");
  const HINT = "（刚才发出去的话里用了「甲」太生硬；「乙」：下次换个说法。）";
  const hinted = () => main().sent.at(-1)!.text.split(HINT).length - 1;

  t.brain.fromChannel({ channel: "whatsapp", text: "在吗", senderId: STRANGER_WA });
  await main().play({ say: "有点甲" });
  await flush();
  t.brain.fromChannel({ channel: "whatsapp", text: "你好", senderId: "+6155500014" });
  assert.equal(hinted(), 0, "上一句还卡在网关上，没发出去：还没有可提醒的");
  await main().play({ say: "甲和乙" });
  open(); await flush(); await flush(); await flush(); await flush();
  assert.equal(t.brain.central.since(0).filter((e) => e.meta?.wordHint === true).length, 2, "存档照旧一轮一笔");

  t.brain.fromChannel({ channel: "whatsapp", text: "还在吗", senderId: STRANGER_WA });
  assert.equal(hinted(), 1, "回人的那一轮也附，两轮的词并成一行，同一个词只说一次");
  await main().play({ say: "NO_REPLY" });
  await flush();
  t.brain.wakeRegion("main", "接着做");
  assert.equal(hinted(), 0, "给过就清掉");
});

test("C2：「（发给 陌生人（号码））」整个去掉：中央记忆的「最近说过的」、原话层、回头看带的聊天、控制台用的是同一个写法", async () => {
  const head = `（发给 陌生人（${STRANGER_WA}））`;
  assert.equal(sentBody(`${head}你好`), "你好");
  assert.equal(sentBody("（发给 某人）你好"), "你好");
  assert.equal(sentBody("没有开头（发给 某人）"), "没有开头（发给 某人）");

  // 原话层：发出去的话抄进来时去掉开头
  const db = openDb(":memory:");
  new EventStore(db, () => T0);
  const c = new CentralMemory(db, () => T0);
  c.append(1, "main", "note", `${head}你好`, { sent: true, to: STRANGER_WA });
  const ix = new MemIndex(db, null, () => T0);
  assert.equal(ix.ingestCentral(), 1);
  assert.deepEqual((db.prepare("SELECT text FROM mem_quote").all() as Array<{ text: string }>).map((r) => r.text), ["你好"]);

  // 回头看带的最近聊天（只带主人和要她做事的人；名字里带括号也整个去掉）
  const t = makeBrain();
  const owner = "+6155500010";
  t.brain.central.append(1, "main", "note", "（发给 某人（备注））晚点到", { sent: true, to: owner });
  const lines = (t.brain as unknown as { lookChat(askedBy: string | null): Array<{ line: string }> }).lookChat(null).map((x) => x.line);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /：晚点到$/);

  // the console: the page carries no copy of the head — it gets the same definition with the page data
  assert.ok(!consoleSource().includes("（发给"), "no copy of the head in the page files");
  assert.equal(pageMarks().sentHead, B.forms.sentHead.source);
});

test("N-3：词表提醒那一笔不是她说的话，不进原话层", () => {
  const db = openDb(":memory:");
  new EventStore(db, () => T0);
  const c = new CentralMemory(db, () => T0);
  c.append(1, "main", "note", `（发给 ${WHO}）有点甲`, { sent: true, to: STRANGER_WA });
  c.append(1, "main", "note", `（刚才发给 ${WHO} 的话里用了「甲」：太生硬。下次换个说法。）`, { wordHint: true });
  const ix = new MemIndex(db, null, () => T0);
  assert.equal(ix.ingestCentral(), 1);
  assert.deepEqual((db.prepare("SELECT text FROM mem_quote").all() as Array<{ text: string }>).map((r) => r.text), ["有点甲"]);
});
