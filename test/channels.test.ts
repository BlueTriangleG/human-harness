// The one way out (the send of openChannels): what it answers before any channel is asked, and the hook's three outcomes.
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openChannels } from "../src/channels/send.ts";
import type { BeforeSend } from "../src/channels/types.ts";
import { G, T } from "../src/lang/index.ts";
import { testConfig } from "./helpers.ts";

/** The test role's channels over a fake gateway that records every request; the hook records what it was asked, then does what hook says */
function open(o: { dryRun?: boolean; hook?: BeforeSend } = {}) {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const asked: string[] = [];
  const gateway = { connected: true, request: async <R>(method: string, params: Record<string, unknown>) => { requests.push({ method, params }); return { messageId: "M1" } as R; } };
  const beforeSend: BeforeSend = async (m) => { asked.push(m.text); return o.hook?.(m); };
  return { send: openChannels(testConfig({ tools: { sendDryRun: o.dryRun ?? false } }), { gateway, retryMs: 0, beforeSend }).send, requests, asked };
}
const TO_QING = { channel: "whatsapp", target: "+6155500019", text: "台灯修好了" };

test("channels: simulated sending answers first — no channel is looked up, neither the hook nor the gateway is asked", async () => {
  const c = open({ dryRun: true });
  assert.deepEqual(await c.send({ ...TO_QING, channel: "sms" }), { ok: true, out: T.deliver.dryRun("sms", TO_QING.target) });
  assert.deepEqual([c.asked, c.requests], [[], []]);
});

test("channels: a channel that is not in the table is not sent to, and the answer names the channels that are", async () => {
  const c = open();
  const r = await c.send({ ...TO_QING, channel: "sms" });
  assert.equal(r.ok, false);
  for (const name of ["sms", ...Object.keys(testConfig().channels)]) assert.ok(r.out.includes(name), `the answer names ${name}`);
  assert.deepEqual([c.asked, c.requests], [[], []]);
});

test("channels: the hook returns nothing — the message goes out as it was", async () => {
  const c = open({ hook: async () => undefined });
  assert.equal((await c.send(TO_QING)).ok, true);
  assert.deepEqual(c.asked, [TO_QING.text]);
  assert.deepEqual(c.requests.map((r) => [r.method, r.params.to, r.params.message]), [["send", TO_QING.target, TO_QING.text]]);
});

test("channels: the hook returns a text — that text goes out instead", async () => {
  const c = open({ hook: async () => ({ text: "台灯明天修" }) });
  assert.equal((await c.send(TO_QING)).ok, true);
  assert.deepEqual(c.requests.map((r) => r.params.message), ["台灯明天修"]);
});

test("channels: the hook refuses — the reason is the answer, and the channel is not called", async () => {
  const c = open({ hook: async () => ({ refuse: "this one names someone it should not" }) });
  assert.deepEqual(await c.send(TO_QING), { ok: false, out: "this one names someone it should not" });
  assert.deepEqual(c.requests, []);
});

test("channels: with no hook handed in, the instance's outbound filter is the hook (refused and tidied as configured); none configured, none", async () => {
  const requests: string[] = [];
  const gateway = { connected: true, request: async <R>(_m: string, params: Record<string, unknown>) => { requests.push(String(params.message)); return { messageId: "M1" } as R; } };
  const send = (outbound?: object) => openChannels(testConfig({ tools: { sendDryRun: false }, ...(outbound ? { outbound } : {}) }), { gateway, retryMs: 0 }).send;
  const filtered = send({ refuseLatinLines: true, tidyLines: true });
  assert.deepEqual(await filtered({ ...TO_QING, text: "Let me fix the lamp" }), { ok: false, out: G.outbound.latinLineRefused });
  assert.equal((await filtered({ ...TO_QING, text: "1. 台灯修好了。" })).ok, true);
  assert.equal((await send()({ ...TO_QING, text: "Let me fix the lamp" })).ok, true);
  assert.deepEqual(requests, ["台灯修好了", "Let me fix the lamp"]);
});
