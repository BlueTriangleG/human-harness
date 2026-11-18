// 表情包工具：挑图交给 sticker.py prepare，发图走常连的网关，不再起 openclaw 命令行。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { buildTools } from "../src/tools/hhtools.ts";
import { gatewayChannel } from "../src/channels/gateway.ts";
import { openChannels } from "../src/channels/send.ts";
import { GatewayClient, GatewayError, GatewayUnsure } from "../src/gateway/client.ts";
import type { ToolContext } from "../src/tools/hhtools.ts";
import { stickerDestination } from "../src/tools/stickers.ts";
import { regionSpecs } from "../src/regions/specs.ts";
import { loadConfig } from "../src/config.ts";
import { testConfig } from "./helpers.ts";

const T0 = Date.UTC(2026, 9, 31, 5, 0);
const ADA_WA = "+6155500010";
const ADA_QQ = "qqbot:c2c:AAAAAAAAAAAAAAAAAAAAAAAAAAAA0000";
const XIAOBEI_WA = "+6155500011";
const BOOK: Record<string, Record<string, string>> = {
  ada: { whatsapp: ADA_WA, qqbot: ADA_QQ },
  小贝: { whatsapp: XIAOBEI_WA },
};
const NAMES: Record<string, string> = { [ADA_WA]: "ada", [ADA_QQ]: "ada", [XIAOBEI_WA]: "小贝" };

type Chat = { channel: string; target: string; name?: string } | null;

function makeCtx(opts: {
  chat?: Chat; heard?: number | null; dryRun?: boolean; stdout?: string;
  gateway?: (method: string, params: Record<string, unknown>) => unknown;
} = {}) {
  const runs: string[][] = [];
  const calls: Array<{ method: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  const sends: Array<{ to: string; text: string }> = [];
  const prepared = opts.stdout ?? JSON.stringify({ ok: true, items: [{ id: "s028", name: "爱音拿手机笑", path: "/ws/stickers/mp4/8ede.mp4", gifPlayback: true }], errors: [] });
  const gateway = {
    connected: true,
    request: async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number) => {
      calls.push({ method, params, ...(timeoutMs ? { timeoutMs } : {}) });
      return (opts.gateway ? opts.gateway(method, params) : { messageId: "3EB0X" }) as T;
    },
  };
  const ctx: ToolContext = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: opts.dryRun ?? false, timezone: "UTC", sideThreads: 3,
    run: async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stdout: args.includes("prepare") ? prepared : "{\"ok\": true}", stderr: "" }; },
    // the stickers module's sticker.py, as Brain's moduleRun runs it
    moduleRun: async (module: string, script: string, args: readonly string[]) => { runs.push([module, script, ...args]); return { code: 0, stdout: args.includes("prepare") ? prepared : "{\"ok\": true}", stderr: "" }; },
    send: openChannels(testConfig({ tools: { sendDryRun: opts.dryRun ?? false } }), { gateway }).send,
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1,
    recordSend: (to, text) => { sends.push({ to, text }); }, recallLocal: () => "",
    resolveTarget: (ch, t) => BOOK[t]?.[ch] ?? t,
    currentChat: () => (opts.chat === undefined ? { channel: "whatsapp", target: ADA_WA, name: "ada" } : opts.chat),
    lastHeardFrom: () => (opts.heard === undefined ? T0 - 60_000 : opts.heard),
    nameOf: (t) => NAMES[t] ?? null,
  };
  return { ctx, runs, calls, sends };
}

const sticker = (ctx: ToolContext) => buildTools(ctx, ["sticker"])[0]!;

test("表情包：默认发给正在聊的人——sticker.py 只挑图，图经网关发出去（带 GIF 动图标记），发成了才记次数、记进中央记忆", async () => {
  const { ctx, runs, calls, sends } = makeCtx();
  const out = await sticker(ctx).handler({ mood: "开心 得意" });
  assert.deepEqual(runs[0], ["stickers", "sticker.py", "prepare", "--mood", "开心", "得意", "--channel", "whatsapp"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "send");
  assert.equal(calls[0]!.params.to, ADA_WA);
  assert.equal(calls[0]!.params.mediaUrl, "/ws/stickers/mp4/8ede.mp4");
  assert.equal(calls[0]!.params.gifPlayback, true);
  assert.equal(calls[0]!.params.message, undefined);
  assert.equal(calls[0]!.timeoutMs, 150_000);
  assert.deepEqual(sends, [{ to: ADA_WA, text: "[表情包：爱音拿手机笑]" }]);
  assert.deepEqual(runs[1], ["stickers", "sticker.py", "used", "s028"]);
  assert.equal(runs.length, 2);
  assert.ok(!runs.some((r) => r[0] === "oc"), "不起 openclaw 命令行");
  assert.match(out, /发出去了：「爱音拿手机笑」→ ada（WhatsApp）/);
});

test("表情包：指定 ref、逗号分隔的情绪都行；没写情绪也没写 ref 就不挑", async () => {
  const a = makeCtx();
  await sticker(a.ctx).handler({ ref: ["s012", "stickers/inbox/x.gif"] });
  assert.deepEqual(a.runs[0]!.slice(2), ["prepare", "--ref", "s012", "stickers/inbox/x.gif", "--channel", "whatsapp"]);
  const b = makeCtx();
  await sticker(b.ctx).handler({ mood: "开心,得意、累" });
  assert.deepEqual(b.runs[0]!.slice(3, 7), ["--mood", "开心", "得意", "累"]);
  const c = makeCtx();
  assert.match(await sticker(c.ctx).handler({}), /情绪词/);
  assert.equal(c.runs.length, 0);
});

test("表情包：库里没有这种情绪就不发，告诉她接近的有哪些", async () => {
  const { ctx, calls, sends, runs } = makeCtx({ stdout: JSON.stringify({ ok: true, items: [], note: "没有匹配", nearest_moods: ["开心", "得意"] }) });
  const out = await sticker(ctx).handler({ mood: "zzz" });
  assert.match(out, /没有「zzz」.*接近的有：开心、得意/);
  assert.equal(calls.length, 0);
  assert.equal(sends.length, 0);
  assert.equal(runs.length, 1);
});

test("表情包：网关拒了（比如过滤拦下）就说没发出去，不记次数、不记成发过、也不退回命令行再试", async () => {
  const { ctx, runs, sends } = makeCtx({ gateway: () => { throw new GatewayError("UNAVAILABLE", "Error: No delivery result"); } });
  const out = await sticker(ctx).handler({ mood: "开心" });
  assert.match(out, /没发出去：「爱音拿手机笑」.*No delivery result/);
  assert.equal(sends.length, 0);
  assert.deepEqual(runs.map((r) => r[2]), ["prepare"]);
});

test("表情包：一张超时、再问一次也没回音：后面几张先不发，说清哪几张没发；连接断了的不算卡住，后面的照发", async () => {
  const three = JSON.stringify({ ok: true, items: ["甲图", "乙图", "丙图"].map((name, i) => ({ id: `s${i}`, name, path: `/ws/stickers/${i}.mp4`, gifPlayback: true })), errors: [] });
  const stuck = makeCtx({ stdout: three, gateway: () => { throw new GatewayUnsure("gateway send timeout", "timeout"); } });
  const out = await sticker(stuck.ctx).handler({ ref: ["s0", "s1", "s2"] });
  assert.equal(stuck.calls.length, 2, "第一张发一次、再问一次，后面的不发");
  assert.equal(stuck.sends.length, 0);
  assert.match(out, /「甲图」不确定发出去没有/);
  assert.match(out, /「乙图」「丙图」先没发（前一张还没确认发出去）/);
  assert.deepEqual(stuck.runs.map((r) => r[2]), ["prepare"], "一张都没确定发出去：不记次数");

  let n = 0;
  const dropped = makeCtx({ stdout: three, gateway: () => { if (n++ === 0) throw new GatewayUnsure("gateway closed（请求已经发出去了）", "dropped"); return { messageId: "M" }; } });
  const out2 = await sticker(dropped.ctx).handler({ ref: ["s0", "s1", "s2"] });
  assert.equal(dropped.calls.length, 3);
  assert.deepEqual(dropped.sends.map((x) => x.text), ["[表情包：乙图]", "[表情包：丙图]"]);
  assert.doesNotMatch(out2, /先没发/);
});

test("表情包：模拟发送模式下不碰网关，也不记使用次数", async () => {
  const { ctx, calls, runs } = makeCtx({ dryRun: true });
  assert.match(await sticker(ctx).handler({ mood: "开心" }), /模拟发送/);
  assert.equal(calls.length, 0);
  assert.deepEqual(runs.map((r) => r[2]), ["prepare"]);
});

test("表情包发给谁：默认正在聊的人；写人名 / 号码也行；对不上、不认识、不在聊天时说清楚", () => {
  assert.deepEqual(stickerDestination(makeCtx().ctx, undefined, undefined), { channel: "whatsapp", target: ADA_WA, name: "ada", rerouted: false });
  assert.deepEqual(stickerDestination(makeCtx().ctx, "小贝", undefined), { channel: "whatsapp", target: XIAOBEI_WA, name: "小贝", rerouted: false });
  assert.equal((stickerDestination(makeCtx().ctx, XIAOBEI_WA, undefined) as { target: string }).target, XIAOBEI_WA);
  assert.match((stickerDestination(makeCtx().ctx, XIAOBEI_WA, "qqbot") as { error: string }).error, /对不上/);
  assert.match((stickerDestination(makeCtx().ctx, "路人甲", undefined) as { error: string }).error, /不知道路人甲的 WhatsApp 号/);
  assert.match((stickerDestination(makeCtx({ chat: null }).ctx, undefined, undefined) as { error: string }).error, /没在 QQ \/ WhatsApp 上跟谁聊/);
  assert.match((stickerDestination(makeCtx({ chat: { channel: "telegram", target: "tg:7f3a", name: "ada" } }).ctx, undefined, undefined) as { error: string }).error, /没在/);
  // 写的就是正在聊的人：跟着对话走（QQ 上聊就发 QQ）
  const qq = makeCtx({ chat: { channel: "qqbot", target: ADA_QQ, name: "ada" } });
  assert.deepEqual(stickerDestination(qq.ctx, "ada", undefined), { channel: "qqbot", target: ADA_QQ, name: "ada", rerouted: false });
  assert.deepEqual(stickerDestination(qq.ctx, "Ada", undefined), { channel: "qqbot", target: ADA_QQ, name: "ada", rerouted: false });
  // 在 QQ 上聊，但点名发 WhatsApp
  assert.equal((stickerDestination(qq.ctx, undefined, "whatsapp") as { target: string }).target, ADA_WA);
});

test("表情包发给谁：写的是正在聊的那个 QQ 号、只差大小写：就是正在聊的人（带上聊天里的称呼）", () => {
  const lower = "qqbot:c2c:aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001";
  const chat = { channel: "qqbot", target: lower, name: "陌生人（aaaaaaaaaaaaaaaaaaaaaaaaaaaa0001）" };
  assert.deepEqual(stickerDestination(makeCtx({ chat }).ctx, "qqbot:c2c:AAAAAAAAAAAAAAAAAAAAAAAAAAAA0001", undefined), { channel: "qqbot", target: lower, name: chat.name, rerouted: false });
});

test("表情包发给谁：QQ 回复窗口（对方来消息后 55 分钟）过了，有 WhatsApp 就改发 WhatsApp；没有就照发 QQ", () => {
  const chat = { channel: "qqbot", target: ADA_QQ, name: "ada" };
  assert.deepEqual(stickerDestination(makeCtx({ chat, heard: T0 - 10 * 60_000 }).ctx, undefined, undefined), { channel: "qqbot", target: ADA_QQ, name: "ada", rerouted: false });
  assert.deepEqual(stickerDestination(makeCtx({ chat, heard: T0 - 70 * 60_000 }).ctx, undefined, undefined), { channel: "whatsapp", target: ADA_WA, name: "ada", rerouted: true });
  assert.deepEqual(stickerDestination(makeCtx({ chat, heard: null }).ctx, undefined, undefined), { channel: "whatsapp", target: ADA_WA, name: "ada", rerouted: true });
  const stranger = "qqbot:c2c:FFFF";
  assert.deepEqual(stickerDestination(makeCtx({ chat: { channel: "qqbot", target: stranger }, heard: null }).ctx, undefined, undefined), { channel: "qqbot", target: stranger, name: null, rerouted: false });
});

test("表情包：只有主线能发（一边做着的事、下意识都不能对外发）", () => {
  const specs = regionSpecs(loadConfig({}));
  const withSticker = specs.filter((s) => s.tools.includes("sticker")).map((s) => s.id);
  assert.deepEqual(withSticker, ["main"]);
});

test("中央记忆：某人在某个渠道最后一次来消息的时间（只看真来的消息，不看她发出去的）", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  assert.equal(c.lastHeardFrom("qqbot", ADA_QQ), null);
  c.append(1, "外界", "input", "在吗", { from: "ada", channel: "qqbot", human: true, replyTo: { channel: "qqbot", target: ADA_QQ, name: "ada" } }, T0 - 90 * 60_000);
  c.append(1, "外界", "input", "hi", { from: "ada", channel: "whatsapp", human: true, replyTo: { channel: "whatsapp", target: ADA_WA, name: "ada" } }, T0 - 5 * 60_000);
  c.append(1, "main", "note", "（发给 ada）嗯", { sent: true, to: ADA_QQ, name: "ada" }, T0 - 60_000);
  assert.equal(c.lastHeardFrom("qqbot", ADA_QQ), T0 - 90 * 60_000);
  assert.equal(c.lastHeardFrom("whatsapp", ADA_WA), T0 - 5 * 60_000);
});

test("发送：网关回了错、连不上网关都直接报错，不起 openclaw 命令行（ada 11-01：不要走 OpenClaw）；GIF 动图标记带上", async () => {
  const refused = { connected: true, request: async () => { throw new GatewayError("UNAVAILABLE", "Error: No delivery result"); } };
  const r1 = await gatewayChannel(refused as never).send({ channel: "whatsapp", target: ADA_WA, text: "I said that…" });
  assert.equal(r1.ok, false);
  assert.match(r1.out, /UNAVAILABLE.*No delivery result/);
  const down = { connected: false, request: async () => { throw new Error("gateway socket error"); } };
  const r2 = await gatewayChannel(down as never, { retryMs: 0 }).send({ channel: "whatsapp", target: ADA_WA, text: "", media: "/a.mp4", gifPlayback: true });
  assert.equal(r2.ok, false);
  assert.match(r2.out, /连不上网关.*gateway socket error/);
  assert.equal((await gatewayChannel(undefined).send({ channel: "whatsapp", target: ADA_WA, text: "x" })).ok, false);
  const calls: Array<Record<string, unknown>> = [];
  const ok = { connected: true, request: async (_m: string, p: Record<string, unknown>) => { calls.push(p); return {}; } };
  await gatewayChannel(ok as never).send({ channel: "whatsapp", target: ADA_WA, text: "", media: "/a.mp4", gifPlayback: true });
  assert.equal(calls[0]!.gifPlayback, true);
});

test("发送：确定没发出去（连不上）重试一次；发出去了但连接断了说不确定、不重试，免得重复（超时的再问一次见 send.test.ts）", async () => {
  const keys: unknown[] = [];
  let n = 0;
  const flaky = { connected: false, request: async (_m: string, p: Record<string, unknown>) => { keys.push(p.idempotencyKey); if (n++ === 0) throw new Error("gateway connect timeout"); return {}; } };
  const r1 = await gatewayChannel(flaky as never, { retryMs: 0 }).send({ channel: "whatsapp", target: ADA_WA, text: "在的" });
  assert.equal(r1.ok, true);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);                                    // 重试用同一个 key
  let m = 0;
  const unsure = { connected: true, request: async () => { m++; throw new GatewayUnsure("gateway closed（请求已经发出去了）", "dropped"); } };
  const r2 = await gatewayChannel(unsure as never, { retryMs: 0 }).send({ channel: "whatsapp", target: ADA_WA, text: "在的" });
  assert.equal(r2.ok, false);
  assert.equal(m, 1);
  assert.match(r2.out, /不确定发出去没有/);
});

test("网关：握手迟迟不来不会一直等（以前连接卡住，后面所有回复都堵死）", async () => {
  const { createServer } = await import("node:net");
  const silent = createServer(() => { /* 接了不说话 */ });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const port = (silent.address() as { port: number }).port;
  const g = new GatewayClient({ url: `ws://127.0.0.1:${port}`, token: "t", log: { info() {}, warn() {}, error() {}, child() { return this; } } as never, connectTimeoutMs: 200 });
  const t0 = Date.now();
  await assert.rejects(g.request("send", {}), /connect timeout|closed|socket error/);
  assert.ok(Date.now() - t0 < 5_000);
  g.close();
  silent.close();
});

test("stickers module: the weekly hunt reminds once a week — not on the first run, not within the week, once after it", async () => {
  const { default: stickers } = await import("../modules/stickers/module.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpDir } = await import("./tmp.ts");
  const state = join(tmpDir("hh-hunt-"), "modules", "stickers");
  const said: string[] = [];
  const m = { stateDir: state, config: {}, remind: (text: string) => { said.push(text); } } as unknown as Parameters<NonNullable<typeof stickers.check>>[0];
  const hunt = stickers.timers!.find((t) => t.name === "hunt")!.run;
  await hunt.run(m);
  assert.deepEqual(said, [], "first run: only starts the week");
  await hunt.run(m);
  assert.deepEqual(said, [], "within the week");
  writeFileSync(join(state, "hunt.json"), JSON.stringify({ at: Date.now() - 8 * 24 * 3600_000 }));
  await hunt.run(m);
  await hunt.run(m);
  assert.equal(said.length, 1, "a week later: once");
  assert.ok((JSON.parse(readFileSync(join(state, "hunt.json"), "utf8")) as { at: number }).at > Date.now() - 60_000, "the week starts again");
});

test("表情包跟着角色的通道走：只有 QQ 的角色只能发 QQ、不在聊天时说 QQ、不改道 WhatsApp；没有能发表情包的通道就没有 sticker 工具", () => {
  const qqOnly = { ...makeCtx({ chat: null }).ctx, channels: ["qqbot"] };
  assert.match((stickerDestination(qqOnly, undefined, undefined) as { error: string }).error, /没在 QQ 上跟谁聊/);
  const shape = buildTools(qqOnly, ["sticker"]).find((t) => t.name === "sticker")!.shape as unknown as { channel: { unwrap(): { options: string[] } } };
  assert.deepEqual(shape.channel.unwrap().options, ["qqbot"]);
  assert.deepEqual(buildTools({ ...makeCtx().ctx, channels: [] }, ["sticker", "message"]).map((t) => t.name), [], "no channel: neither tool");
  assert.deepEqual(buildTools({ ...makeCtx().ctx, channels: ["telegram"] }, ["sticker"]).map((t) => t.name), [], "a channel stickers cannot go out on");
});
