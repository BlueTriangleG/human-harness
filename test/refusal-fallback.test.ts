// #0045：Opus 被安全分类器误拦时，区会话要能退到 fallback 模型（Sonnet），而不是直接报 api_error:invalid_request。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SdkSession, refusalFallbackNote } from "../src/kernel/sdk.ts";
import type { SessionSpec } from "../src/kernel/types.ts";
import { makeBrain } from "./helpers.ts";
import { FakeDriver } from "../src/kernel/fake.ts";
import { fallbackFor, regionSpecs } from "../src/regions/specs.ts";
import { loadConfig } from "../src/config.ts";

const optionsOf = (spec: Partial<SessionSpec>): Record<string, unknown> =>
  (SdkSession.prototype as unknown as { options(this: unknown, s: unknown): Record<string, unknown> })
    .options.call({ spec: { model: "opus-x", permissionMode: "default", tools: [], systemAppend: "", cwd: "/tmp", ...spec } }, {});

test("sdk options: spec.fallbackModel 有值就带 fallbackModel，没值不带这个键", () => {
  assert.equal(optionsOf({ fallbackModel: "sonnet-x" }).fallbackModel, "sonnet-x");
  assert.ok(!("fallbackModel" in optionsOf({})));
});

test("region spec: 只有不对外说话的 opus 区（side/deep/海马）带 sonnet 当 fallback；main 和其它 tier 不带", async () => {
  const t = makeBrain({ gate: { enabled: false }, regions: { perception: ["messages"] } });
  t.brain.wakeRegion("main", "回一下");
  assert.equal(t.driver.latest("main").spec.fallbackModel, undefined);
  t.brain.wakeRegion("side-1", "看一下");
  assert.equal(t.driver.latest("side-1").spec.fallbackModel, t.cfg.models.sonnet);
  t.brain.fromSenses("B站 有人回复了你");
  const glance = t.driver.latest("perception-messages");
  assert.equal(glance.spec.model, t.cfg.models.haiku);
  assert.equal(glance.spec.fallbackModel, undefined);
});

// 11-13 换 Fable：opus 档和 sonnet 档都配成 claude-fable-5-2，SDK 见到退路和主模型相同就拒绝开会话，
// 她派的支线没起来、翻页退到海马整理时卡住。两档相同就不带退路；假内核也照真 SDK 查这一条。
test("假内核跟真 SDK 一样：退路模型和主模型相同，开会话当场抛错", () => {
  const d = new FakeDriver();
  const spec = { id: "side-1", model: "fable-x", fallbackModel: "fable-x", systemAppend: "", cwd: "/tmp", permissionMode: "default", tools: [], onEvent: () => {} };
  assert.throws(() => d.open(spec as never), /Fallback model cannot be the same as the main model/);
  assert.equal(d.open({ ...spec, fallbackModel: "sonnet-x" } as never).spec.fallbackModel, "sonnet-x");
});

test("fallbackFor：不对外说话的 opus 区才带；sonnet 档和 opus 档同一个模型就不带", () => {
  const two = loadConfig({ models: { opus: "opus-x", sonnet: "sonnet-x", haiku: "haiku-x" } });
  const same = loadConfig({ models: { opus: "fable-x", sonnet: "fable-x", haiku: "haiku-x" } });
  const silent = (cfg: typeof two) => regionSpecs(cfg).filter((x) => x.tier === "opus" && x.outlet === "none").map((x) => x.id);
  assert.deepEqual(silent(two), ["side-1", "side-2", "deep", "hippocampus"]);
  for (const x of regionSpecs(two)) assert.equal(fallbackFor(two, x), silent(two).includes(x.id) ? "sonnet-x" : undefined, x.id);
  for (const x of regionSpecs(same)) assert.equal(fallbackFor(same, x), undefined, x.id);
  assert.equal(fallbackFor(two, { tier: "sonnet", outlet: "none" }), undefined);
});

test("两档都是 Fable：side、deep、海马都开得起来，不带退路，启动时记一笔；两档不同不记", () => {
  const t = makeBrain({ gate: { enabled: false }, models: { opus: "fable-x", sonnet: "fable-x", haiku: "haiku-x" } });
  for (const id of ["side-1", "side-2", "deep", "hippocampus"]) {
    t.brain.wakeRegion(id, "看一下");
    const spec = t.driver.latest(id).spec;
    assert.equal(spec.model, "fable-x", id);
    assert.equal(spec.fallbackModel, undefined, id);
  }
  const noted = t.logs.filter((l) => l.msg === "regions: no fallback model");
  assert.equal(noted.length, 1);
  assert.equal(noted[0]!.model, "fable-x");
  assert.ok(!makeBrain({ gate: { enabled: false } }).logs.some((l) => l.msg === "regions: no fallback model"));
});

test("model_refusal_fallback 是 info 级的记录，带原模型、fallback 模型、拒绝类别；别的消息不是", () => {
  const note = refusalFallbackNote({ type: "system", subtype: "model_refusal_fallback", trigger: "refusal", direction: "retry", original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", api_refusal_category: "reasoning_extraction", scope: "session", retracted_message_uuids: ["a", "b"] });
  assert.deepEqual(note, { original_model: "claude-opus-5-5", fallback_model: "claude-sonnet-5-5", api_refusal_category: "reasoning_extraction", scope: "session", direction: "retry", retracted: 2 });
  const bare = refusalFallbackNote({ type: "system", subtype: "model_refusal_fallback", original_model: "o", fallback_model: "f" });
  assert.deepEqual(bare, { original_model: "o", fallback_model: "f", api_refusal_category: null, scope: null, direction: null, retracted: 0 });
  assert.equal(refusalFallbackNote({ type: "system", subtype: "init" }), null);
  assert.equal(refusalFallbackNote({ type: "assistant" }), null);
});
