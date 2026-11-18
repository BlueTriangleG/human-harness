// 对照工具的 inbound、senses 两个场景（存着的消息和感官事件再喂一遍）：在小快照上跑两次一个字节不差；
// 喂进去的话到了内核、回复经网关发给了那个人、陌生人的称呼是树自己算的、小判断问到了；存着的行怎么变成入口调用；挑行时每一种都留一条；
// 假小判断的回答合格、不随题目措辞变；演完又冒出来的接着演、演不完就挂；闸门关着时 senses 只记一条为什么跳过。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildLine } from "../src/gate/parse.ts";
import { judgeBatch } from "../src/gate/judge.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import { FakeDriver } from "../src/kernel/fake.ts";
import type { SessionSpec } from "../src/kernel/types.ts";
import { People, relationOf } from "../src/persona/people.ts";
import { openDb } from "../src/store/db.ts";
import { JUDGE_CHOICES, PLAIN_ANSWER, judgeAnswer, judgeIds } from "../src/parity/judge.ts";
import { ANSWER_ROUNDS, answerUntilQuiet, feed, forgetSenses } from "../src/parity/drive.ts";
import { BUSY_REPLY, HOLD_WAIT_MS } from "../src/parity/scenarios/inbound.ts";
import { Recorder } from "../src/parity/recorder.ts";
import { allowEmpty, messageBack, messageEntry, pickRecent, requireStored, senseEntry, storedMessages, storedSenses } from "../src/parity/stored.ts";
import type { StoredMessage } from "../src/parity/stored.ts";
import type { World } from "../src/parity/world.ts";
import { buildSnapshot, TAKEN_AT, upToState, type CentralRow, type GateRow } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";
import { setLang } from "../src/lang/index.ts";

// this file asserts the Chinese pack's text
setLang("zh");

const MAIN = resolve(fileURLToPath(import.meta.url), "../../src/parity/main.ts");
const dump = (...args: string[]) => spawnSync(process.execPath, [MAIN, "dump", ...args], { encoding: "utf8" });

interface Rec { n: number; t: number; kind: string; [k: string]: unknown }
const transcript = (out: string, scenario: string): { raw: string; recs: Rec[] } => {
  const raw = readFileSync(join(out, scenario, "transcript.jsonl"), "utf8");
  return { raw, recs: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) };
};

// —— 小快照里的人和号（都是编的） ——
const OWNER_WA = "+1055500001";
const GUEST_WA = "+1055500002";
const OWNER_QQ = "0000000000000000000000000000A001";
const STRANGER = "+1955500008";
/** 木料店：以前在名单上（存着的 from 是它的名字、标着朋友），现在名单上没有了 */
const SHOP_WA = "+1055500003";
const GROUP = "1255500006@g.us";
const REGISTRY = {
  laolin: { name: "老林", privacy: "owner", senders: [OWNER_QQ, OWNER_WA], sessionKeys: ["agent:main:main"] },
  xiaohe: { name: "小禾", privacy: "guest", senders: [GUEST_WA] },
};
const people = (): People => new People(REGISTRY);

const min = (k: number): number => TAKEN_AT - k * 60_000;
const wa = (target: string, name: string, extra: Record<string, unknown> = {}) => ({ channel: "whatsapp", target, name, ...extra });

/** 存着的外来消息（照 deliverInbound 记的样子），外加不该再喂的：感官的、导入的、她自己说的 */
const MESSAGES: CentralRow[] = [
  { src: "外界", kind: "input", text: "（引用：「下周三去集市」）几点出发？", meta: { from: "老林", channel: "whatsapp", human: true, replyTo: wa(OWNER_WA, "老林") }, at: min(60) },
  { src: "外界", kind: "input", text: "阿青，周三集市几点开？", meta: { from: "小禾", channel: "whatsapp", human: true, replyTo: wa(GUEST_WA, "小禾", { messageId: "wamid-0001" }), tag: "朋友" }, at: min(55) },
  { src: "外界", kind: "input", text: "木料收好了吗", meta: { from: "老林", channel: "qqbot", human: true, replyTo: { channel: "qqbot", target: `qqbot:c2c:${OWNER_QQ}`, messageId: "qqmsg-0001", name: "老林" } }, at: min(50) },
  { src: "外界", kind: "input", text: "给院子里的花浇水", meta: { from: "你自己排的提醒", channel: "internal", human: false, replyTo: null }, at: min(45) },
  { src: "外界", kind: "input", text: "帮我记一下明天买钉子", meta: { from: "老林", channel: "app", human: true, replyTo: null }, at: min(40) },
  { src: "外界", kind: "input", text: "刨子放哪了", meta: { from: "老林", channel: "app", human: true, replyTo: { channel: "app", target: "agent:main:main", name: "老林" } }, at: min(35) },
  { src: "外界", kind: "input", text: "你好，请问是木工店吗", meta: { from: `陌生人（${STRANGER}）`, channel: "whatsapp", human: true, replyTo: wa(STRANGER, `陌生人（${STRANGER}）`), tag: "陌生人" }, at: min(30) },
  { src: "外界", kind: "input", text: "晚上谁带面条", meta: { from: "小禾", channel: "whatsapp", human: true, replyTo: wa(GROUP, "小禾", { messageId: "wamid-0002", group: true }), tag: "朋友" }, at: min(25) },
  { src: "外界", kind: "input", text: "松木板周四到", meta: { from: "木料店", channel: "whatsapp", human: true, replyTo: wa(SHOP_WA, "木料店"), tag: "朋友" }, at: min(22) },
  { src: "外界", kind: "input", text: "[感官] 有新动静：\n- [wx id=5a5a5a5a9999] 不该再喂的感官原文", meta: { from: "感官", channel: "senses", senseIds: ["5a5a5a5a9999"] }, at: min(20) },
  { src: "外界", kind: "input", text: "导入的旧话", meta: { from: "老林", imported: true, sessionKey: "agent:main:main" }, at: min(15) },
  { src: "main", kind: "say", text: "收好了，顺手盖了块布", at: min(10) },
];
const FED = MESSAGES.filter((r) => r.kind === "input" && r.meta?.channel !== "senses" && !r.meta?.imported);

const sense = (src: string, id: string, text: string, extra: Record<string, unknown> = {}): GateRow["ev"] =>
  ({ src, id, text, line: buildLine(src, id, text, typeof extra.do === "string" ? extra.do : undefined), ...extra });
const PLAIN_TEXT = "（对照用的系统通知）电脑风扇有点响";
const SENSES: GateRow["ev"][] = [
  sense("wx", "5a5a5a5a0001", "木料店：松木板到货了，周四来拿", { do: "回复用 wx_reply 木料店", conv: "木料店", sender: "木料店", isGroup: false, mentionsMe: false, unread: 2 }),
  sense("wx", "5a5a5a5a0002", "院子群：小禾：@阿青 晚上一起吃面吗", { do: "回复用 wx_reply 院子群", conv: "院子群", sender: "小禾", isGroup: true, mentionsMe: true, unread: 1 }),
  sense("xhs", "5a5a5a5a0003", "有人赞了你的笔记《刨花收纳》", { do: "打开小红书看" }),
  { src: "plain", id: createHash("sha1").update(PLAIN_TEXT).digest("hex").slice(0, 16), text: PLAIN_TEXT, line: PLAIN_TEXT },
  { src: "hh-quota", id: "5a5a5a5a0005", text: "这周额度快见底了", line: "这周额度快见底了", urgent: true },
  sense("bili", "5a5a5a5a0006", "B站 有人回复了你：刨得真平", { do: "打开 B站 看" }),
];
const GATE_LOG: GateRow[] = SENSES.map((ev, i) => ({ at: min(40 - i * 5), ev }));
/** senses/events.jsonl：最后一条闸门行往前 24 小时里的几条（ts 是秒） */
const EVENTS_JSONL = [SENSES[0]!, SENSES[2]!, SENSES[5]!].map((ev, i) => {
  const { line: _line, ...fields } = ev;
  const ms = min(300 - i * 30);
  return JSON.stringify({ ts: ms / 1000, t: new Date(ms).toISOString(), ...fields });
}).join("\n") + "\n";

const snapshot = (root: string) => buildSnapshot(root, {
  config: { tools: { sendDryRun: false }, senses: { logFile: "senses/events.jsonl" } }, central: MESSAGES, registry: REGISTRY, gateLog: GATE_LOG, files: { "senses/events.jsonl": EVENTS_JSONL },
});

test("parity dump inbound + senses on the fixture: two runs are byte-identical; the message reaches the kernel, the reply goes back through the gateway, the judge is asked", () => {
  const root = tmpDir("hh-parity-replay-");
  const snap = snapshot(root);
  const work = join(root, "work");
  const runs = ["out1", "out2"].map((o) => {
    const r = dump("--data", snap.data, "--work", work, "--out", join(root, o), "--scenario", "inbound", "--scenario", "senses");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return { inbound: transcript(join(root, o), "inbound"), senses: transcript(join(root, o), "senses") };
  });
  assert.equal(runs[0]!.inbound.raw, runs[1]!.inbound.raw, "inbound is deterministic");
  assert.equal(runs[0]!.senses.raw, runs[1]!.senses.raw, "senses is deterministic");

  // —— inbound ——
  const ib = runs[0]!.inbound.recs;
  assert.ok(!ib.some((r) => r.kind === "log" && r.level === "error"), JSON.stringify(ib.filter((r) => r.kind === "log")));
  const calls = ib.filter((r) => r.kind === "call" && (r.name === "fromChannel" || r.name === "inbound"));
  assert.equal(calls.length, FED.length, "every stored message once; senses, imported and her own words are not fed");
  assert.deepEqual(calls.map((c) => c.returned), FED.map(() => "delivered"));
  const names = ["fromChannel", "fromChannel", "fromChannel", "inbound", "inbound", "inbound", "fromChannel", "fromChannel", "fromChannel"];
  assert.deepEqual(calls.map((c) => c.name), names);
  assert.deepEqual(ib.find((r) => r.kind === "call" && r.name === "inbound-paths")!.returned, { fromChannel: 6, inbound: 3 });
  assert.ok(ib.some((r) => r.kind === "log" && r.level === "info" && r.msg === "parity: inbound paths fromChannel=6 inbound=3"), "the path counts are also a log line the dump prints");
  const args = calls.map((c) => c.args as Record<string, unknown>);
  assert.deepEqual(args[0], { channel: "whatsapp", text: "几点出发？", senderId: OWNER_WA, isGroup: false, replyToBody: "下周三去集市" });
  assert.deepEqual(args[1], { channel: "whatsapp", text: "阿青，周三集市几点开？", senderId: GUEST_WA, messageId: "wamid-0001", isGroup: false });
  assert.deepEqual(args[2], { channel: "qqbot", text: "木料收好了吗", senderId: OWNER_QQ, messageId: "qqmsg-0001", isGroup: false });
  assert.deepEqual(args[3], { from: "你自己排的提醒", channel: "internal", text: "给院子里的花浇水", human: false });
  // stored before the App chat went: a tell and an App-chat message, both labelled "app", replay as a tell enters now
  assert.deepEqual(args[4], { from: "老林", channel: "local", text: "帮我记一下明天买钉子", human: true });
  assert.deepEqual(args[5], { from: "老林", channel: "local", text: "刨子放哪了", human: true });
  assert.deepEqual(args[6], { channel: "whatsapp", text: "你好，请问是木工店吗", senderId: STRANGER, isGroup: false }, "a stranger goes through fromChannel with the stored sender id");
  assert.deepEqual(args[7], { channel: "whatsapp", text: "晚上谁带面条", senderId: GUEST_WA, messageId: "wamid-0002", isGroup: true, conversationId: GROUP });
  assert.deepEqual(args[8], { channel: "whatsapp", text: "松木板周四到", senderId: SHOP_WA, isGroup: false }, "someone no longer in the registry too");
  // 每条喂进去以后 main 拿到的第一段话里有那条原话，一字不差（fromChannel 拼回来的跟存着的一样）
  const mainSends = ib.filter((r) => r.kind === "send" && r.region === "main");
  const firstSendAfter = (n: number): string => String(mainSends.find((s) => s.n > n)?.text ?? "");
  calls.forEach((c, k) => assert.ok(firstSendAfter(c.n).includes(FED[k]!.text), `main was handed: ${FED[k]!.text}`));
  // 陌生人、名单上已经没有的：称呼和关系那句是这棵树自己算的，不是存着的 from
  for (const [k, id] of [[6, STRANGER], [8, SHOP_WA]] as const) {
    const text = firstSendAfter(calls[k]!.n);
    assert.ok(text.includes(`陌生人（${id}）`) && text.includes(relationOf(null)), text);
  }
  assert.ok(!firstSendAfter(calls[8]!.n).includes("木料店"), "the stored name of someone no longer known is not what she is told");
  const gw = ib.filter((r) => r.kind === "gateway").map((r) => r.params as Record<string, unknown>);
  assert.ok(gw.some((p) => p.to === SHOP_WA && p.message === "（对照：收到）"), "the reply to someone no longer known goes to the stored number");
  assert.ok(gw.some((p) => p.to === OWNER_WA && p.message === "（对照：收到）"), "the plain reply goes back to the sender");
  assert.ok(gw.some((p) => p.to === `qqbot:c2c:${OWNER_QQ}` && p.message === "（对照：记下了）" && p.replyToId === "qqmsg-0001"), "the reply after jot_down goes back on QQ, replying to that message");
  assert.ok(gw.some((p) => p.to === GUEST_WA && p.message === "（对照：另发一条）"), "the message tool resolves the name to the sender");
  const scripts = ib.filter((r) => r.kind === "script").map((r) => r.script as { say?: string; tool?: { name: string } });
  for (const [say, tool] of [["（对照：收到）", undefined], ["NO_REPLY", undefined], ["（对照：记下了）", "jot_down"], ["NO_REPLY", "message"]] as const) {
    assert.ok(scripts.some((s) => s.say === say && s.tool?.name === tool), `played ${say} ${tool ?? ""}`);
  }
  assert.deepEqual(upToState(ib).slice(-3).map((r) => [r.kind, r.name]), [["state", "status"], ["state", "db"], ["state", "files"]]);

  // —— inbound，主线正演着一轮时进来的那一条（第 2 条，小禾的）：压着等 → 提醒她有人在等 → 等了 20 秒打断 → 这才送到 → 回复发给小禾 ——
  const busy = ib.find((r) => r.kind === "call" && r.name === "busy-turn")!;
  assert.deepEqual([busy.args, busy.returned], [{ message: 1, region: "main", holdWaitMs: HOLD_WAIT_MS }, "main marked busy"]);
  const fed = calls[1]!;
  const interrupt = ib.find((r) => r.kind === "interrupt")!;
  const end = ib.find((r) => r.kind === "call" && r.name === "busy-turn-end")!;
  assert.ok(busy.n < fed.n && fed.n < interrupt.n && interrupt.n < end.n, "marked busy, fed, interrupted, ended — in that order");
  assert.deepEqual([interrupt.region, interrupt.t - fed.t], ["main", 20_000], "the tree interrupts main when the hold limit is up");
  assert.ok(!mainSends.some((s) => s.n > fed.n && s.n < interrupt.n), "nothing reaches main while the message is held");
  const nudge = ib.find((r) => r.kind === "inject" && r.n > fed.n && r.n < interrupt.n)!;
  assert.ok(nudge.region === "main" && String(nudge.text).includes("小禾 刚来消息，在等你回"), "the after-tool hook of the running turn says who is waiting");
  assert.ok(ib.some((r) => r.kind === "log" && r.level === "warn" && r.msg === "turn failed" && r.error === "error_during_execution" && r.n > interrupt.n && r.n < end.n), "the interrupted turn ends failed, as the kernel reports it");
  const handed = mainSends.find((s) => s.n > interrupt.n)!;
  assert.ok(handed.n < end.n && String(handed.text).includes(FED[1]!.text), "the held message's text reaches main after the interrupt");
  assert.deepEqual(end.returned, { joined: false, interrupted: true, endedBy: "interrupt" });
  const reply = ib.find((r) => r.kind === "gateway" && (r.params as { message?: string }).message === BUSY_REPLY.say)!;
  assert.ok(reply.n > end.n && (reply.params as { to?: string }).to === GUEST_WA, "and the reply goes to its sender");
  assert.equal(ib.filter((r) => r.kind === "interrupt").length, 1, "one busy turn on nine messages");
  assert.ok(ib.some((r) => r.kind === "log" && r.level === "info" && r.msg === "parity: inbound fed while main was busy interrupted=1"), "and how the busy turns ended is a log line diff prints");

  // —— senses ——
  const sn = runs[0]!.senses.recs;
  assert.ok(!sn.some((r) => r.kind === "log" && r.level === "error"), JSON.stringify(sn.filter((r) => r.kind === "log")));
  const replay = sn.find((r) => r.kind === "call" && r.name === "gateReplay")!;
  assert.deepEqual(replay.args, { from: new Date(GATE_LOG.at(-1)!.at - 86_400_000).toISOString(), to: new Date(GATE_LOG.at(-1)!.at).toISOString() });
  const replayed = replay.returned as Array<{ src: string; route: string; verdict?: string }>;
  assert.deepEqual(replayed.map((r) => r.src), ["wx", "xhs", "bili"]);
  assert.ok(replayed.every((r) => r.route === "judge" && typeof r.verdict === "string"), JSON.stringify(replayed));
  const feeds = sn.filter((r) => r.kind === "call" && r.name !== "gateReplay");
  assert.deepEqual(feeds.map((c) => [c.name, c.returned]), SENSES.map((ev) => [ev.src === "hh-quota" ? "inbound" : "fromSenses", "delivered"]));
  assert.deepEqual(feeds[3]!.args, { text: PLAIN_TEXT });
  const { line: _l, ...raw0 } = SENSES[0]!;
  assert.deepEqual(feeds[0]!.args, { text: `[感官] 有新动静：\n${SENSES[0]!.line}`, events: [raw0] });
  assert.deepEqual((feeds[4]!.args as { events: unknown[] }).events, [SENSES[4]]);
  const asks = sn.filter((r) => r.kind === "ask");
  assert.ok(asks.some((a) => a.n < replay.n && String(a.prompt).includes("[5a5a5a5a0001] ")), "the replay asks the judge about the logged event");
  assert.ok(asks.some((a) => a.n > replay.n && String(a.prompt).includes("[5a5a5a5a0001] ")), "the re-fed event reaches the judge too");
  assert.ok(sn.some((r) => r.kind === "send" && r.region === "main" && String(r.text).includes("晚上一起吃面吗")), "the @-mention goes straight to her");
  assert.ok(sn.some((r) => r.kind === "script" && (r.script as { say?: string }).say === "（对照）"));
  assert.ok(sn.some((r) => r.kind === "log" && r.level === "info" && r.msg === "parity: senses fed fromSenses=5 inbound=1"), "how many events went through which entry point is a log line diff prints");
  assert.deepEqual(upToState(sn).slice(-3).map((r) => [r.kind, r.name]), [["state", "status"], ["state", "db"], ["state", "files"]]);
});

test("parity dump on a snapshot with nothing stored: inbound, senses and tools fail instead of replaying nothing; parity.allowEmpty: true in the snapshot's config says an empty snapshot is intended", () => {
  const root = tmpDir("hh-parity-replay-");
  const empty = buildSnapshot(root, { central: [] });
  const out = join(root, "out");
  const r = dump("--data", empty.data, "--work", join(root, "work"), "--out", out, "--scenario", "inbound", "--scenario", "senses", "--scenario", "tools");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^inbound\t1\tFAILED \(exit 1\)\nsenses\t1\tFAILED \(exit 1\)\ntools\t1\tFAILED \(exit 1\)\n$/);
  const hint = "two empty replays would compare identical (set parity.allowEmpty: true in the snapshot's config if an empty snapshot is intended)";
  assert.deepEqual(r.stderr.split("\n").filter(Boolean), [
    `parity: scenario inbound failed: parity: inbound: the snapshot has no stored messages (central rows of kind input) to replay — ${hint}`,
    `parity: scenario senses failed: parity: senses: the snapshot has no stored sense events (gate_log rows) to replay — ${hint}`,
    `parity: scenario tools failed: parity: tools: the snapshot has no stored tool calls (central rows of kind act for a tool of today's regions) to replay — ${hint}`,
  ]);
  const failed = transcript(out, "inbound").recs;
  assert.deepEqual([failed.length, failed[0]!.kind, failed[0]!.level], [1, "log", "error"], "nothing was fed before the scenario failed");

  // 明说了可以是空的：照跑，小结那句说一条都没有
  const root2 = tmpDir("hh-parity-replay-");
  const allowed = buildSnapshot(root2, { central: [], config: { parity: { allowEmpty: true } } });
  const ok = dump("--data", allowed.data, "--work", join(root2, "work"), "--out", join(root2, "out"), "--scenario", "inbound");
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);
  const recs = transcript(join(root2, "out"), "inbound").recs;
  assert.ok(recs.some((x) => x.kind === "log" && x.msg === "parity: inbound paths none") && !recs.some((x) => x.kind === "call" && x.name === "fromChannel"));

  assert.deepEqual([allowEmpty({}), allowEmpty({ parity: {} }), allowEmpty({ parity: { allowEmpty: false } }), allowEmpty({ parity: { allowEmpty: true } })], [false, false, false, true]);
  assert.throws(() => allowEmpty({ parity: { allowEmpty: "yes" } }), /parity\.allowEmpty must be true or false/);
  requireStored({}, "senses", "stored sense events", 1);
  requireStored({ parity: { allowEmpty: true } }, "tools", "stored tool calls", 0);
  assert.throws(() => requireStored({}, "tools", "stored tool calls", 0), /^Error: parity: tools: the snapshot has no stored tool calls to replay/);
});

test("parity stored: reads the stored messages and sense events oldest first, skips senses, imported history and her own words; forgetSenses takes them off the gate log", () => {
  const db = openDb(":memory:");
  const epoch = new Epochs(db, () => min(100)).begin("boot", 1);
  const central = new CentralMemory(db);
  for (const r of MESSAGES) central.append(epoch.id, r.src, r.kind, r.text, r.meta ?? null, r.at);
  const ms = storedMessages(db, 100);
  assert.deepEqual(ms.map((m) => m.text), FED.map((r) => r.text));
  assert.deepEqual(ms[1], { seq: 2, ts: min(55), text: "阿青，周三集市几点开？", from: "小禾", channel: "whatsapp", human: true, replyTo: wa(GUEST_WA, "小禾", { messageId: "wamid-0001" }), tag: "朋友" });
  assert.equal(ms[3]!.replyTo, null);
  // 只要 7 条：最近的 7 条里没有（老林, whatsapp），它最近的那条换掉挑中的里最老的、那一种不止一条的（老林 app 里 hh tell 的那条）；
  // 小禾 whatsapp 那条没挑上，但（小禾, whatsapp）已经有群里那条了
  assert.deepEqual(storedMessages(db, 7).map((m) => m.text), FED.filter((r) => r.text !== "阿青，周三集市几点开？" && r.text !== "帮我记一下明天买钉子").map((r) => r.text));
  // 种类比条数多：最近的两条留着
  assert.deepEqual(storedMessages(db, 2).map((m) => m.text), ["晚上谁带面条", "松木板周四到"]);

  const ins = db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'done')");
  for (const g of GATE_LOG) ins.run(g.at, g.ev.id, g.ev.src, g.ev.conv ?? null, g.ev.sender ?? null, g.ev.line, JSON.stringify(g.ev));
  ins.run(min(1), "broken0001", "xhs", null, null, "- [xhs id=broken0001] 坏了的那行", "{not json");
  const ss = storedSenses(db, 100);
  assert.deepEqual(ss.map((s) => s.src), [...SENSES.map((e) => e.src), "xhs"]);
  assert.deepEqual(ss[0]!.ev, SENSES[0]);
  assert.deepEqual(ss.at(-1)!.ev, { src: "xhs", id: "broken0001", text: "- [xhs id=broken0001] 坏了的那行", line: "- [xhs id=broken0001] 坏了的那行" });
  // 只要 3 条：最近的 3 条来源各不相同，没有可换的，别的来源就没有
  assert.deepEqual(storedSenses(db, 3).map((s) => s.ev.id), ["5a5a5a5a0005", "5a5a5a5a0006", "broken0001"]);
  assert.equal(forgetSenses(db, ss.slice(0, 2)), 2);
  assert.deepEqual(storedSenses(db, 100).map((s) => s.ev.id), [...SENSES.slice(2).map((e) => e.id), "broken0001"]);
  db.close();
});

test("parity pickRecent: the most recent n, but every kind keeps one (the oldest pick of a kind with more than one makes room)", () => {
  const key = (x: string) => x[0]!;
  // c5 挤掉 a6、d3 挤掉 a8（a 还剩 a9 一条）；a4 那种已经有了，不换
  assert.deepEqual(pickRecent(["a9", "a8", "b7", "a6", "c5", "a4", "d3"], 4, key).sort(), ["a9", "b7", "c5", "d3"]);
  assert.deepEqual(pickRecent(["a9", "b8", "c7", "d6"], 2, key).sort(), ["a9", "b8"], "more kinds than room: the newest stay");
  assert.deepEqual(pickRecent(["a1"], 5, key), ["a1"]);
  assert.deepEqual(pickRecent([], 5, key), []);
});

test("parity messageEntry: the stored reply address gives the sender (strangers and people no longer known always), else the registry's number by name, else the stored fields go to inbound", () => {
  const p = people();
  const m = (o: Partial<StoredMessage>): StoredMessage => ({ seq: 1, ts: 0, text: "木料收好了吗", from: "老林", channel: "whatsapp", human: true, replyTo: wa(OWNER_WA, "老林"), tag: null, ...o });
  assert.deepEqual(messageEntry(m({}), p), { name: "fromChannel", args: { channel: "whatsapp", text: "木料收好了吗", senderId: OWNER_WA, isGroup: false } });
  // 小禾在 QQ 上没有号：存着什么喂什么
  const guestQQ = m({ from: "小禾", channel: "qqbot", replyTo: { channel: "qqbot", target: "qqbot:c2c:FFFF", name: "小禾" }, tag: "朋友" });
  assert.deepEqual(messageEntry(guestQQ, p), { name: "inbound", args: { from: "小禾", channel: "qqbot", text: "木料收好了吗", human: true, replyTo: { channel: "qqbot", target: "qqbot:c2c:FFFF", name: "小禾" }, tag: "朋友" } });
  // 存着的名字名单上没有（陌生人的称呼、改了名、拿掉了）：一律用存着的号走 fromChannel，是谁让这棵树自己认
  assert.deepEqual(messageEntry(m({ from: "周师傅" }), p), { name: "fromChannel", args: { channel: "whatsapp", text: "木料收好了吗", senderId: OWNER_WA, isGroup: false } });
  const stranger = m({ from: `陌生人（${STRANGER}）`, replyTo: wa(STRANGER, `陌生人（${STRANGER}）`), tag: "陌生人" });
  assert.deepEqual(messageEntry(stranger, p).args, { channel: "whatsapp", text: "木料收好了吗", senderId: STRANGER, isGroup: false });
  // 名单上的名字、存着的号和名单按名字给的号都认出来是别人：不拼渠道消息
  const shared = new People({ ...REGISTRY, shop: { name: "小禾的店", privacy: "guest", senders: [GUEST_WA] } });
  assert.equal(messageEntry(m({ from: "小禾", replyTo: wa(GUEST_WA, "小禾") }), shared).name, "inbound");
  // 名单上的人、存着的号名单上已经没有了：退回名单按名字给的号
  assert.deepEqual(messageEntry(m({ replyTo: wa("+1055500004", "老林") }), p).args, { channel: "whatsapp", text: "木料收好了吗", senderId: OWNER_WA, isGroup: false });
  // 引用：拆在第一个「」）」上，fromChannel 拼回来的跟存着的一字不差；超过 200 字的整段当原话
  const quoted = "（引用：「甲」）乙」）丙";
  const q = messageEntry(m({ text: quoted }), p).args as { text: string; replyToBody: string };
  assert.deepEqual([q.replyToBody, q.text], ["甲", "乙」）丙"]);
  assert.equal(`（引用：「${q.replyToBody.slice(0, 200)}」）${q.text}`, quoted);
  const long = `（引用：「${"木".repeat(201)}」）好`;
  assert.deepEqual(messageEntry(m({ text: long }), p).args, { channel: "whatsapp", text: long, senderId: OWNER_WA, isGroup: false });
  // QQ 群：会话号从存着的目标里取，发送者按名字找名单
  const qqGroup = messageEntry(m({ channel: "qqbot", replyTo: { channel: "qqbot", target: "qqbot:group:G0001", messageId: "q2", name: "老林", group: true } }), p);
  assert.deepEqual(qqGroup.args, { channel: "qqbot", text: "木料收好了吗", senderId: OWNER_QQ, messageId: "q2", isGroup: true, conversationId: "G0001" });
  // 群里没带会话号的（存着的目标就是发送者）：不编会话号，照样是群里的话
  assert.deepEqual(messageEntry(m({ channel: "qqbot", replyTo: { channel: "qqbot", target: `qqbot:c2c:${OWNER_QQ}`, name: "老林", group: true } }), p).args,
    { channel: "qqbot", text: "木料收好了吗", senderId: OWNER_QQ, isGroup: true });
  assert.deepEqual(messageEntry(m({ replyTo: wa(OWNER_WA, "老林", { group: true }) }), p).args, { channel: "whatsapp", text: "木料收好了吗", senderId: OWNER_WA, isGroup: true });
  // 群里的陌生人（只存着会话号）：走 inbound，群的那个标带上
  const groupStranger = m({ from: "陌生人（+1955500007）", replyTo: wa(GROUP, "陌生人（+1955500007）", { group: true }), tag: "陌生人" });
  assert.deepEqual(messageEntry(groupStranger, p), { name: "inbound", args: { from: "陌生人（+1955500007）", channel: "whatsapp", text: "木料收好了吗", human: true, replyTo: wa(GROUP, "陌生人（+1955500007）", { group: true }), tag: "陌生人", group: true } });
  // message 工具：名单上的人写名字，陌生人和走 inbound 的写存着的目标
  assert.deepEqual(messageBack(m({}), messageEntry(m({}), p), "嗯", p), { action: "send", channel: "whatsapp", target: "老林", message: "嗯" });
  assert.deepEqual(messageBack(stranger, messageEntry(stranger, p), "嗯", p), { action: "send", channel: "whatsapp", target: STRANGER, message: "嗯" });
  assert.deepEqual(messageBack(guestQQ, messageEntry(guestQQ, p), "嗯", p), { action: "send", channel: "qqbot", target: "qqbot:c2c:FFFF", message: "嗯" });
});

test("parity senseEntry: senses.py events go to fromSenses with their fields, plain text as text, quota notices to inbound as HH sends them", () => {
  const at = (ev: GateRow["ev"]) => senseEntry({ id: 1, ts: 0, src: ev.src, line: ev.line, ev });
  const { line: _l, ...fields } = SENSES[1]!;
  assert.deepEqual(at(SENSES[1]!), { name: "fromSenses", args: { text: `[感官] 有新动静：\n${SENSES[1]!.line}`, events: [fields] } });
  assert.deepEqual(at(SENSES[3]!), { name: "fromSenses", args: { text: PLAIN_TEXT } });
  assert.deepEqual(at(SENSES[4]!), { name: "inbound", args: { from: "感官", channel: "senses", text: "这周额度快见底了", human: false, events: [SENSES[4]] } });
});

test("parity judge fake: one well-formed verdict per item judgeBatch accepts, every choice occurs, and an item keeps its verdict whatever the prompt's wording, order or batch", async () => {
  const items = Array.from({ length: 40 }, (_, i) => ({
    ev: { src: "wx", id: `abc${String(i).padStart(4, "0")}`, text: `第 ${i} 条`, line: `- [wx id=abc${String(i).padStart(4, "0")}] 第 ${i} 条`, conv: "院子群" },
    hit: { ruleId: null, action: "judge" as const, when: "now" as const, want: "有人找我" }, floor: false,
  }));
  let prompt = "";
  const r = await judgeBatch({
    ask: async (o) => { prompt = o.prompt; return { text: judgeAnswer(o), usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }; },
    card: "我是阿青", nowDoing: "", items, context: () => ["- [wx id=ffff0001] 群里刚才的一句"], base: { model: "m", cwd: "/", timeoutMs: 1000 },
  });
  assert.equal(r.verdicts.size, items.length, "every item got a verdict judgeBatch accepted");
  assert.deepEqual(judgeIds(prompt), items.map((it) => it.ev.id), "context lines are not mistaken for items");
  const seen = new Set([...r.verdicts.values()].map((v) => `${v.verdict}/${v.when}/${v.unsure}`));
  for (const c of JUDGE_CHOICES) assert.ok(seen.has(`${c.verdict}/${c.when}/${c.unsure}`), JSON.stringify(c));
  for (const [id, v] of r.verdicts) assert.equal(v.gist, items.find((it) => it.ev.id === id)!.ev.text, "an empty gist falls back to the event text");
  const o = { model: "m", system: "s", prompt, cwd: "/", timeoutMs: 1 };
  assert.equal(judgeAnswer(o), judgeAnswer({ ...o }));
  assert.equal(judgeAnswer({ ...o, prompt: "只回一个字。" }), PLAIN_ANSWER);

  // 题目的措辞、顺序、分批、群聊语境都换了：每条的结论不动（只看这一条自己的编号和原文）
  const again = await judgeBatch({
    ask: async (a) => ({ text: judgeAnswer(a), usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }),
    card: "我是阿青", nowDoing: "现在在做：刨一块松木板", items: [...items].reverse().slice(0, 25).map((it) => ({ ...it, hit: { ...it.hit, want: "换了说法的标准" } })),
    context: () => [], base: { model: "m", cwd: "/", timeoutMs: 1000 },
  });
  for (const [id, v] of again.verdicts) assert.deepEqual(v, r.verdicts.get(id), id);
  // 多行原文（带正文块）的也认得出整段：正文变了结论可以变，换说法不变
  const body = { ...items[0]!, ev: { ...items[0]!.ev, body: "第一行\n第二行", line: buildLine("wx", items[0]!.ev.id, items[0]!.ev.text, undefined, "第一行\n第二行") } };
  const one = async (nowDoing: string) => (await judgeBatch({ ask: async (a) => ({ text: judgeAnswer(a), usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } }), card: "c", nowDoing, items: [body], context: () => [], base: { model: "m", cwd: "/", timeoutMs: 1000 } })).verdicts.get(body.ev.id);
  assert.deepEqual(await one(""), await one("现在在做：别的"));
});

test("parity answerUntilQuiet: sends that show up after a scripted turn are played too; still unanswered after the bound fails loudly", async () => {
  const world = (follow: number): { w: World; driver: FakeDriver } => {
    const driver = new FakeDriver();
    let left = follow;
    const s = driver.open({ id: "main", tools: [], hooks: { beforeTool: () => undefined, afterTool: () => undefined },
      onEvent: (ev: { type: string }) => { if (ev.type === "turn-end" && left-- > 0) s.send("又来一条"); } } as unknown as SessionSpec);
    s.send("第一条");
    const w = { driver, play: (region: string, script: Parameters<World["play"]>[1]) => driver.latest(region).play(script), drain: async () => {} } as unknown as World;
    return { w, driver };
  };
  const a = world(2);
  await answerUntilQuiet(a.w, new WeakMap(), { say: "（对照）" });
  assert.equal(a.driver.latest("main").sent.length, 3, "the two follow-ups were answered as well");
  const b = world(Infinity);
  await assert.rejects(answerUntilQuiet(b.w, new WeakMap(), { say: "（对照）" }), new RegExp(`after ${ANSWER_ROUNDS} rounds \\(main\\)`));
});

test("parity feed mirrors the control socket: a channel message drains the relay spool first (the relay command), sense and tell entries go straight in; each leaves a call record", () => {
  const order: string[] = [];
  const brain = {
    drainRelaySpool: () => { order.push("drain"); },
    fromChannel: () => { order.push("fromChannel"); return "delivered"; },
    inbound: () => { order.push("inbound"); return "queued"; },
    fromSenses: () => { order.push("fromSenses"); throw new Error("闸门坏了"); },
  };
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const w = { rec, brain } as unknown as World;
  feed(w, { name: "fromChannel", args: { channel: "whatsapp", text: "木料收好了吗", senderId: OWNER_WA, isGroup: false } });
  feed(w, { name: "inbound", args: { from: "老林", channel: "local", text: "帮我记一下明天买钉子", human: true } });
  feed(w, { name: "fromSenses", args: { text: PLAIN_TEXT } });
  assert.deepEqual(order, ["drain", "fromChannel", "inbound", "fromSenses"]);
  const file = join(tmpDir("hh-parity-replay-"), "t.jsonl");
  rec.write(file);
  const recs = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  assert.deepEqual(recs.map((r) => [r.kind, r.name, r.returned ?? null, r.threw ?? null]), [
    ["call", "fromChannel", "delivered", null], ["call", "inbound", "queued", null], ["call", "fromSenses", null, "Error: 闸门坏了"],
  ]);
});

test("parity dump senses with the gate off: one senses-skipped record saying why, nothing re-fed", () => {
  const root = tmpDir("hh-parity-replay-");
  const snap = buildSnapshot(root, { config: { gate: { enabled: false } }, gateLog: GATE_LOG });
  const out = join(root, "out");
  const r = dump("--data", snap.data, "--work", join(root, "work"), "--out", out, "--scenario", "senses");
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const recs = transcript(out, "senses").recs;
  assert.deepEqual(recs.map((x) => [x.kind, x.name ?? x.msg]), [["call", "senses-skipped"], ["log", "parity: senses skipped (the gate is off)"]]);
  assert.match(String((recs[0]!.args as { reason: string }).reason), /gate is off \(gate\.enabled=false/);
});
