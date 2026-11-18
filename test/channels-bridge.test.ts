// The bridge (src/channels/bridge.ts) with a fake channel behind a real socket, and the WhatsApp and QQ bridges'
// mappings (bridge/whatsapp/map.ts, bridge/qq/map.ts) on messages shaped like their SDKs'.
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeChannel, bridgeDirect, bridgeInbox, bridgeSocket, bridgeStatus, fromOwner, isOwnerCommand, quietConsole, serveBridge, withAttachments } from "../src/channels/bridge.ts";
import { channelsCommand, sendCommand } from "../src/cli-direct.ts";
import { ownerSenders, ownerSendersFile } from "../src/repair/instances.ts";
import type { Channel, InboundMessage, OutboundMessage } from "../src/channels/types.ts";
import { openChannels } from "../src/channels/send.ts";
import { usesGateway } from "../src/channels/gateway.ts";
import { B, T } from "../src/lang/index.ts";
import { testConfig } from "./helpers.ts";
import { inbound, mediaContent, phoneOf, quoteOf, toJid, toWhatsAppText, unwrap, allowed, fresh } from "../bridge/whatsapp/map.ts";
import { downReason, inbound as qqInbound, Passive, qqTarget, Quotes } from "../bridge/qq/map.ts";
import { QQ_REPLY_WINDOW_MS } from "../src/channels/qq.ts";

const QING = "+6155500019";

/**
 * A fake channel behind a real bridge in a fresh state directory: hand it messages with arrive(), see what it was asked to send.
 * owners: the sender ids whose /cc is the owner's command; state: what the fake channel says of itself.
 */
async function bridge(t: { after(fn: () => unknown): void }, o: { owners?: string[]; state?: { connected: boolean; down?: string } } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "hhb-"));
  const sent: OutboundMessage[] = [];
  const logged: Array<{ msg: string; extra?: Record<string, unknown> }> = [];
  const note = (msg: string, extra?: Record<string, unknown>): void => { logged.push({ msg, ...(extra ? { extra } : {}) }); };
  let arrive: (m: InboundMessage) => void = () => { throw new Error("not started"); };
  const fake: Channel = {
    ...(o.state ?? { connected: true }),
    start: async (on) => { arrive = on; },
    send: async (m) => { sent.push(m); return { ok: true, out: "sent" }; },
    stop: async () => {},
  };
  const direct = bridgeDirect(stateDir, "whatsapp");
  const served = await serveBridge({
    socket: bridgeSocket(stateDir, "whatsapp"), inbox: bridgeInbox(stateDir, "whatsapp"), channel: fake, log: { info: note, warn: note },
    ...(o.owners ? { direct: { dir: direct, is: (m: InboundMessage) => isOwnerCommand(m, o.owners!) }, owner: (m: InboundMessage) => fromOwner(m, o.owners!) } : {}),
  });
  t.after(async () => { await served.close(); rmSync(stateDir, { recursive: true, force: true }); });
  return { stateDir, sent, logged, arrive: (m: InboundMessage) => arrive(m), inbox: () => readdirSync(bridgeInbox(stateDir, "whatsapp")), direct: () => readdirSync(direct) };
}
const until = async (ok: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10)); assert.ok(ok()); };
const hello = (id: string): InboundMessage => ({ channel: "whatsapp", text: `hello ${id}`, senderId: QING, messageId: id, isGroup: false });

test("bridge: a channel with via bridge sends to the bridge in the role's state directory, and its answer comes back", async (t) => {
  const b = await bridge(t);
  const { send } = openChannels(testConfig({ stateDir: b.stateDir, channels: { whatsapp: { via: "bridge" } }, tools: { sendDryRun: false } }));
  assert.deepEqual(await send({ channel: "whatsapp", target: QING, text: "台灯修好了" }), { ok: true, out: "sent" });
  assert.deepEqual(b.sent, [{ channel: "whatsapp", target: QING, text: "台灯修好了" }]);
});

test("bridge: its log has one line for every message kept and every send asked, without who or what", async (t) => {
  const b = await bridge(t, { owners: [QING] });
  b.arrive(hello("A"));
  b.arrive({ channel: "whatsapp", text: "/cc 看看", senderId: QING, isGroup: false });
  b.arrive({ channel: "whatsapp", text: "群里一句", senderId: QING, isGroup: true });
  const { send } = openChannels(testConfig({ stateDir: b.stateDir, channels: { whatsapp: { via: "bridge" } }, tools: { sendDryRun: false } }));
  await send({ channel: "whatsapp", target: QING, text: "台灯修好了" });
  const lines = b.logged.filter((l) => l.msg === "bridge: in" || l.msg === "bridge: out");
  assert.deepEqual(lines.slice(0, 3).map((l) => l.extra), [{ group: false, kept: "inbox" }, { group: false, kept: "direct" }, { group: true, kept: "inbox" }]);
  assert.deepEqual({ ...lines[3]!.extra, ms: 0 }, { ok: true, media: false, ms: 0 });
  assert.doesNotMatch(JSON.stringify(b.logged), /6155500019|hello|看看|群里|台灯/, "neither the sender, the target nor the words");
});

test("bridge: what a library prints to the console does not reach the log as it is — sessions and keys never, a warning's own words only", (t) => {
  const mine = { log: console.log, info: console.info, debug: console.debug, warn: console.warn, error: console.error };
  t.after(() => { Object.assign(console, mine); });
  const logged: Array<[string, Record<string, unknown> | undefined]> = [];
  quietConsole({ warn: (msg, extra) => { logged.push([msg, extra]); } });
  const session = { registrationId: 7, currentRatchet: { ephemeralKeyPair: { privKey: "PRIVATE" } } };
  console.info("Closing session:", session);
  console.log("Opening session:", session);
  console.debug(session);
  console.warn("Session already closed", session);
  console.error(session);
  console.error("Session error:Error: Bad MAC", "at stack…");
  assert.deepEqual(logged, [["library", { said: "Session already closed" }], ["library", { said: "Session error:Error: Bad MAC" }]]);
  assert.doesNotMatch(JSON.stringify(logged), /PRIVATE|registrationId|stack/);
});

test("bridge: an error a library leaves uncaught is logged by its kind and code, never its words, and the bridge keeps running", () => {
  // what ended the WhatsApp bridge on 11-16: a stream's 'error' nobody listened to (TypeError: terminated, cause UND_ERR_SOCKET)
  const child = `
    import { Readable } from "node:stream";
    import { keepRunning } from ${JSON.stringify(new URL("../src/channels/bridge.ts", import.meta.url).href)};
    keepRunning({ warn: (msg, extra) => process.stdout.write(JSON.stringify([msg, extra]) + "\\n") });
    const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    new Readable({ read() {} }).destroy(new TypeError("terminated: the words of a message", { cause }));
    void Promise.reject(Object.assign(new Error("send to someone failed"), { code: "ECONNRESET" }));
    setTimeout(() => process.stdout.write("still running\\n"), 50);
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", child], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split("\n").sort(), [
    JSON.stringify(["uncaught error, kept running", { kind: "TypeError", cause: "UND_ERR_SOCKET" }]),
    JSON.stringify(["unhandled rejection, kept running", { kind: "Error", code: "ECONNRESET" }]),
    "still running",
  ].sort());
});

test("bridge: what arrives while nobody listens waits in the inbox, goes out in order on listen, and is deleted once taken", async (t) => {
  const b = await bridge(t);
  b.arrive(hello("A"));
  b.arrive(hello("B"));
  assert.equal(b.inbox().length, 2);
  const got: InboundMessage[] = [];
  const c = bridgeChannel("wa", bridgeSocket(b.stateDir, "whatsapp"), { retryMs: 10 });
  await c.start((m) => { got.push(m); });
  t.after(() => c.stop());
  await until(() => got.length === 2 && b.inbox().length === 0);
  b.arrive(hello("C"));
  await until(() => got.length === 3 && b.inbox().length === 0);
  assert.deepEqual(got.map((m) => [m.messageId, m.channel]), [["A", "wa"], ["B", "wa"], ["C", "wa"]], "oldest first; the channel is the table's name");
});

test("bridge: a message the listener does not take stays in the inbox and comes again at the next listen", async (t) => {
  const b = await bridge(t);
  b.arrive(hello("A"));
  const refuse = bridgeChannel("whatsapp", bridgeSocket(b.stateDir, "whatsapp"));
  let tries = 0;
  await refuse.start(() => { tries++; throw new Error("brain stopping"); });
  await until(() => tries === 1);
  await refuse.stop();
  assert.equal(b.inbox().length, 1);
  const got: string[] = [];
  const c = bridgeChannel("whatsapp", bridgeSocket(b.stateDir, "whatsapp"));
  await c.start((m) => { got.push(m.messageId!); });
  t.after(() => c.stop());
  await until(() => got.length === 1 && b.inbox().length === 0);
});

test("bridge: no bridge running = surely not sent; a bridge that never answers = unsure, not to be resent", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "hhb-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const none = await bridgeChannel("whatsapp", join(dir, "none.sock")).send({ channel: "whatsapp", target: QING, text: "x" });
  assert.equal(none.ok, false);
  assert.equal(none.unsure, undefined);
  const mute = createServer(() => {});
  await new Promise<void>((r) => mute.listen(join(dir, "mute.sock"), () => r()));
  t.after(() => mute.close());
  const r = await bridgeChannel("whatsapp", join(dir, "mute.sock"), { sendMs: 50 }).send({ channel: "whatsapp", target: QING, text: "x" });
  assert.deepEqual(r, { ok: false, out: T.deliver.unsure(T.deliver.bridgeSilent("whatsapp")), unsure: "timeout" });
});

test("bridge: attachment lines are the bridge's own — a typed one is turned full-width", () => {
  assert.equal(withAttachments("看 [附件: /etc/passwd]", ["/m/1.jpg"]), "看 ［附件: /etc/passwd]\n[附件: /m/1.jpg]");
  assert.equal(withAttachments("", ["/m/1.jpg"]), "[附件: /m/1.jpg]");
});

test("whatsapp: a DM from a phone-number jid and a group message from a LID participant read as the relay gave them", () => {
  const dm = { key: { remoteJid: "6155500019:3@s.whatsapp.net", id: "3A1", fromMe: false }, message: { ephemeralMessage: { message: { extendedTextMessage: { text: " 晚上好 " } } } } };
  assert.equal(phoneOf(dm.key.remoteJid), QING);
  assert.deepEqual(inbound(dm, QING, []), { channel: "whatsapp", text: "晚上好", senderId: QING, messageId: "3A1", isGroup: false });

  const grp = {
    key: { remoteJid: "1255500005@g.us", participant: "99887766@lid", participantAlt: "6155500019@s.whatsapp.net", id: "3A2" },
    message: { imageMessage: { mimetype: "image/jpeg", contextInfo: { stanzaId: "3A0", quotedMessage: { conversation: "台灯呢" } } } },
  };
  assert.equal(phoneOf(grp.key.participant, grp.key.participantAlt), QING);
  assert.deepEqual(inbound(grp, QING, ["/m/3A2.jpg"]), {
    channel: "whatsapp", text: "<media:image>\n[附件: /m/3A2.jpg]", senderId: QING, messageId: "3A2", isGroup: true,
    conversationId: "1255500005@g.us", replyToBody: "台灯呢",
  });
  assert.equal(quoteOf({ extendedTextMessage: { text: "x", contextInfo: { stanzaId: "3A0" } } }), "[quoted message unavailable]");
  assert.deepEqual(unwrap({ viewOnceMessageV2: { message: { imageMessage: { caption: "c" } } } }), { imageMessage: { caption: "c" } });
});

test("whatsapp: who may write, which upserts count, where a send goes and how it is written", () => {
  const a = { allowFrom: [QING], groupAllowFrom: ["+6155500009"] };
  assert.deepEqual([allowed(a, QING, false), allowed(a, QING, true), allowed(a, "+6155500009", true), allowed({ ...a, allowFrom: ["*"] }, "+1", false)], [true, false, true, true]);
  const now = 1_800_000_000_000;
  assert.deepEqual([fresh({ key: {} }, "notify", now), fresh({ key: {}, messageTimestamp: now / 1000 - 30 }, "append", now), fresh({ key: {}, messageTimestamp: now / 1000 - 600 }, "append", now)], [true, true, false]);
  assert.deepEqual([toJid(QING), toJid("whatsapp:+61 555 000 19"), toJid("1255500005@g.us"), toJid("阿青")], ["6155500019@s.whatsapp.net", "6155500019@s.whatsapp.net", "1255500005@g.us", null]);
  assert.equal(toWhatsAppText("**好** ~~不~~"), "*好* ~不~");
  const voice = mediaContent("/x/a.ogg", Buffer.from("x"), "听这个");
  assert.deepEqual([voice.content.ptt, voice.content.mimetype, voice.textAfter], [true, "audio/ogg; codecs=opus", "听这个"]);
  assert.equal(mediaContent("/x/b.mp4", Buffer.from("x"), "", { gifPlayback: true }).content.gifPlayback, true);
  assert.equal(mediaContent("/x/c.zip", Buffer.from("x"), "").content.fileName, "c.zip");
});

test("qq: targets, a voice message's transcript, a group message's fields, and when a send may answer passively", () => {
  assert.deepEqual([qqTarget("qqbot:c2c:8ABD"), qqTarget("qqbot:group:G1"), qqTarget("+6155500019")], [{ scope: "c2c", targetId: "8ABD" }, { scope: "group", targetId: "G1" }, null]);
  const voice = { kind: "c2c", senderId: "8ABD", content: "", messageId: "m1", attachments: [{ content_type: "voice", url: "https://x/v.silk", asr_refer_text: "晚上吃什么" }] };
  assert.deepEqual(qqInbound(voice, [], undefined), { channel: "qqbot", text: "晚上吃什么", senderId: "8ABD", messageId: "m1", isGroup: false });
  const pic = { kind: "group", senderId: "U2", content: " 看 ", messageId: "m2", groupOpenid: "G1", attachments: [{ content_type: "image/png", url: "https://x/p.png" }] };
  assert.deepEqual(qqInbound(pic, ["/m/m2-0.png"], "台灯呢"), {
    channel: "qqbot", text: "看\n[附件: /m/m2-0.png]", senderId: "U2", messageId: "m2", isGroup: true, conversationId: "G1", replyToBody: "台灯呢",
  });
  assert.equal(qqInbound({ ...pic, content: "" }, [], undefined).text, "<media:image>");

  const p = new Passive();
  const dm = { scope: "c2c" as const, targetId: "8ABD" };
  const grp = { scope: "group" as const, targetId: "G1" };
  p.heard(dm, "m1", 0);
  p.heard(grp, "m2", 0);
  assert.deepEqual([1, 2, 3, 4, 5].map(() => p.take(dm, 60_000)), ["m1", "m1", "m1", "m1", undefined], "four answers per message");
  assert.equal(p.take(grp, 5 * 60_000), undefined, "a group message can be answered for five minutes");
  p.heard(dm, "m3", 0);
  assert.equal(p.take(dm, 30 * 60_000), "m3", "a private one past the half hour the plugin gave it");
  assert.equal(p.take(dm, QQ_REPLY_WINDOW_MS), undefined, "until the window the sticker tool also goes by");
  assert.equal(new Passive().take(dm, 0), undefined, "never heard from: proactive");
});

test("bridge status: times only tell a watchdog that messages wait untaken and that the owner is not answered", async (t) => {
  const b = await bridge(t, { owners: [QING] });
  const sock = bridgeSocket(b.stateDir, "whatsapp");
  const before = Math.floor(Date.now() / 1000);
  b.arrive(hello("A"));                                                                    // the owner, privately
  b.arrive({ channel: "whatsapp", text: "/cc 看看", senderId: QING, isGroup: false });      // the owner's command: not a message the role owes an answer to
  b.arrive({ channel: "whatsapp", text: "群里一句", senderId: QING, isGroup: true });       // a group: not the owner's private message
  b.arrive({ channel: "whatsapp", text: "别人", senderId: "+6155500020", isGroup: false });
  const s1 = (await bridgeStatus(sock))!;
  assert.equal(s1.ownerIn.length, 1);
  assert.ok(s1.ownerIn[0]! >= before && s1.lastOut === null && s1.waiting >= 0 && s1.waiting < 5 && s1.inbox === 3);
  for (let i = 0; i < 7; i++) b.arrive(hello(`B${i}`));
  assert.equal((await bridgeStatus(sock))!.ownerIn.length, 5, "the last five");
  const { send } = openChannels(testConfig({ stateDir: b.stateDir, channels: { whatsapp: { via: "bridge" } }, tools: { sendDryRun: false } }));
  await send({ channel: "whatsapp", target: QING, text: "好" });
  assert.ok((await bridgeStatus(sock))!.lastOut! >= before, "a send that went through");
  assert.doesNotMatch(JSON.stringify(await bridgeStatus(sock)), /61491570|hello|看看|群里/, "no sender, no words");
});

test("bridge status: a bridge says whether its channel is connected, why it will not come back, and how many messages wait; no bridge is no answer", async (t) => {
  const b = await bridge(t);
  b.arrive(hello("A"));
  const up = await bridgeStatus(bridgeSocket(b.stateDir, "whatsapp"));
  assert.deepEqual({ ...up, since: "t", waiting: 0 }, { connected: true, since: "t", inbox: 1, direct: 0, waiting: 0, ownerIn: [], lastOut: null });
  assert.ok(Date.parse(up!.since) <= Date.now());
  const out = await bridge(t, { state: { connected: false, down: "logged out" } });
  assert.deepEqual({ ...(await bridgeStatus(bridgeSocket(out.stateDir, "whatsapp"))), since: "t" }, { connected: false, down: "logged out", since: "t", inbox: 0, direct: 0, waiting: 0, ownerIn: [], lastOut: null });
  assert.equal(await bridgeStatus(join(b.stateDir, "channels", "nobody.sock")), null, "nothing listens there");
  const silent = join(b.stateDir, "channels", "silent.sock");
  const hung = createServer(() => { /* accepts and never answers */ }).listen(silent);
  t.after(() => hung.close());
  assert.equal(await bridgeStatus(silent, 50), null, "a bridge that accepts and says nothing is stuck");
});

test("the owner's command: a private /cc from the owner goes beside the inbox and no listener gets it; anyone else's, a group's, and the owner's other words go to the role", async (t) => {
  const ZHOU = "+6155500020";
  const from = (senderId: string, text: string, isGroup = false): InboundMessage => ({ channel: "whatsapp", text, senderId, isGroup, ...(isGroup ? { conversationId: "5550006@g.us" } : {}) });
  assert.deepEqual(
    [from(QING, "/cc 看看她怎么了"), from(QING, "  ／CC"), from(QING, "/cc\n照诊断修"), from(QING, "/ccx"), from(QING, "说到 /cc"), from(ZHOU, "/cc 看看"), from(QING, "/cc 看看", true), { channel: "whatsapp", text: "/cc" }]
      .map((m) => isOwnerCommand(m, [QING])),
    [true, true, true, false, false, false, false, false], "half- and full-width slash, any case, leading blanks; not a longer word, not mid-sentence, not another sender, not a group, not a message with no sender");
  assert.equal(isOwnerCommand(from(QING, "/cc 看看"), []), false, "no owner ids on the machine's side: nobody's command");

  const b = await bridge(t, { owners: [QING] });
  const got: string[] = [];
  const c = bridgeChannel("whatsapp", bridgeSocket(b.stateDir, "whatsapp"));
  await c.start((m) => { got.push(m.text); });
  t.after(() => c.stop());
  b.arrive(from(QING, "/cc 看看她怎么了"));
  b.arrive(from(ZHOU, "/cc 看看"));
  b.arrive(from(QING, "/cc 看看", true));
  b.arrive(from(QING, "台灯修好了吗"));
  await until(() => got.length === 3 && b.inbox().length === 0);
  assert.deepEqual(got, ["/cc 看看", "/cc 看看", "台灯修好了吗"], "the role gets the three that are not the owner's command");
  assert.equal(b.direct().length, 1);
  assert.deepEqual((await bridgeStatus(bridgeSocket(b.stateDir, "whatsapp")))?.direct, 1);
});

test("the owner's sender ids come from the machine's side: a file the role could not have written, made for this state directory", () => {
  const guard = mkdtempSync(join(tmpdir(), "hhg-")), stateDir = "/home/xiaohe/.hh", me = process.getuid!(), role = me + 1;
  const file = ownerSendersFile(guard, stateDir);
  assert.equal(file, join(guard, "owner-senders", "home-xiaohe-hh.json"));
  assert.deepEqual(ownerSenders(guard, stateDir, role), {}, "no file: nobody is the owner");
  mkdirSync(join(guard, "owner-senders"), { mode: 0o755 });
  const write = (o: unknown): void => writeFileSync(file, JSON.stringify(o), { mode: 0o644 });
  write({ stateDir, senders: { whatsapp: [QING] } });
  chmodSync(guard, 0o755);
  assert.deepEqual(ownerSenders(guard, stateDir, role), { whatsapp: [QING] });
  assert.deepEqual(ownerSenders(guard, stateDir, me), {}, "the role owns the file: it could have written it");
  chmodSync(file, 0o664);
  assert.deepEqual(ownerSenders(guard, stateDir, role), {}, "writable by the group");
  chmodSync(file, 0o644);
  write({ stateDir: "/home/laolin/.hh", senders: { whatsapp: [QING] } });
  assert.deepEqual(ownerSenders(guard, stateDir, role), {}, "made for another role's state directory");
  rmSync(guard, { recursive: true, force: true });
});

test("gateway: hhd connects to it when a channel goes through it or the config names its auth file — with every channel bridged, the computer tool still needs it", () => {
  const bridged = { whatsapp: { via: "bridge" }, qqbot: { via: "bridge" } } as const;
  assert.equal(usesGateway(testConfig({ channels: bridged, gateway: { authFile: "/x/openclaw.json" } })), true, "every channel bridged, the auth file named");
  assert.equal(usesGateway(testConfig({ channels: bridged })), false, "every channel bridged, no auth file: a new role");
  assert.equal(usesGateway(testConfig({ channels: { ...bridged, qqbot: { via: "gateway" } } })), true, "a channel through the gateway");
});

test("hh channels: each channel's way and its bridge's status; restart is for a bridged channel; hh send to a bridged channel needs no gateway", async (t) => {
  const b = await bridge(t);
  const cfg = testConfig({ stateDir: b.stateDir, channels: { whatsapp: { via: "bridge" }, qqbot: { via: "gateway" }, line: { via: "bridge" } }, tools: { sendDryRun: false } });
  const all = await channelsCommand(cfg, []) as Record<string, { via: string; status?: { connected: boolean } | null }>;
  assert.deepEqual([all.whatsapp!.via, all.whatsapp!.status!.connected, all.qqbot, all.line], ["bridge", true, { via: "gateway" }, { via: "bridge", status: null }]);
  assert.deepEqual(await channelsCommand(cfg, ["restart", "whatsapp"]), { restarted: false }, "this bridge recorded no pid: nothing to stop");
  for (const bad of [["restart"], ["restart", "qqbot"], ["restart", "whatsapp", "now"], ["stop", "whatsapp"]]) {
    await assert.rejects(channelsCommand(cfg, bad), new Error(B.cliDirect.channelsUsage));
  }
  assert.equal(await sendCommand(cfg, [QING, "台灯修好了", "--channel", "whatsapp"]), B.cliDirect.sendDone("whatsapp", QING), "no gateway credentials in this role, and none asked for");
  assert.deepEqual(b.sent, [{ channel: "whatsapp", target: QING, text: "台灯修好了" }]);
});

test("qq: what a reply may quote survives a restart of the bridge; refused credentials are told apart from a network error", () => {
  const dir = mkdtempSync(join(tmpdir(), "hh-qq-quotes-"));
  try {
    const file = join(dir, "qqbot.quotes.json");
    const q = new Quotes(file);
    assert.equal(q.get("i1"), undefined);
    q.add("i1", "台灯呢");
    q.add(undefined, "no index, not kept");
    assert.equal(new Quotes(file).get("i1"), "台灯呢", "a new process reads it back");
    assert.equal(statSync(file).mode & 0o777, 0o600, "it holds message text");
    for (let i = 0; i < 500; i++) q.add(`n${i}`, "x");
    const again = new Quotes(file);
    assert.deepEqual([again.get("i1"), again.get("n0"), again.get("n499")], [undefined, "x", "x"], "the newest 500");
    writeFileSync(file, "not json");
    assert.equal(new Quotes(file).get("n0"), undefined, "a broken file is an empty memory, not a crash");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.equal(downReason(new Error('Token fetch failed: HTTP 401 — {"message":"invalid appid or secret"}')), "bad credentials");
  assert.equal(downReason(new Error('Failed to get access_token: {"code":100016}')), "bad credentials");
  assert.equal(downReason(new Error("Network error getting access_token: fetch failed")), undefined);
  assert.equal(downReason(new Error("Token fetch failed: HTTP 502")), undefined, "the platform's own trouble passes");
});
