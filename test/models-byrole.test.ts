// models.byRole（11-14 CEO）：按脑区角色指定模型，没写的照旧按档。
// 要钉住的：没配 byRole 时每个脑区挑到的主模型和退路跟以前逐个一样；配了以后退路按这个脑区真正用的模型比，相同就不带（11-13 就栽在这）；
// 角色名写错了起来时当场报，不悄悄忽略。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrain, flush } from "./helpers.ts";
import { regionSpecs, modelFor, modelOf, fallbackFor } from "../src/regions/specs.ts";
import type { RegionSpec } from "../src/regions/specs.ts";
import { loadConfig, requireInstance, MODEL_ROLES } from "../src/config.ts";
import type { Config } from "../src/config.ts";

/** 六种脑区都建出来：下意识要配了感官流才有（线上闸门开着时没有它），这里配上一路好全钉住 */
const ALL = { gate: { enabled: false }, regions: { perception: ["messages"] } };
/** 11-14 线上的 models 原样（opus 档 Fable、sonnet 档 Sonnet、haiku 档 Haiku） */
const LIVE = { opus: "claude-fable-5-2", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };

/** 改之前的算法，原样抄下来对照：主模型按档；退路只给不对外说话的 opus 区，和 opus 档同一个模型就不带 */
const before = (cfg: Config, s: RegionSpec): { model: string; fallback?: string } => {
  const model = cfg.models[s.tier];
  const fb = s.tier === "opus" && s.outlet === "none" && cfg.models.sonnet && cfg.models.sonnet !== cfg.models.opus ? cfg.models.sonnet : undefined;
  return fb ? { model, fallback: fb } : { model };
};
const after = (cfg: Config, s: RegionSpec): { model: string; fallback?: string } => {
  const fb = fallbackFor(cfg, s);
  return fb ? { model: modelOf(cfg, s), fallback: fb } : { model: modelOf(cfg, s) };
};

test("没配 byRole：线上那份 models、两档相同的 models，每个脑区的主模型和退路都跟改之前一样", () => {
  for (const models of [LIVE, { ...LIVE, sonnet: LIVE.opus }, { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" }]) {
    const cfg = loadConfig({ ...ALL, models });
    const specs = regionSpecs(cfg);
    assert.deepEqual(new Set(specs.map((s) => s.role)), new Set(["main", "side", "deep", "hippocampus", "speech", "perception"]), "六种脑区都在");
    for (const s of specs) assert.deepEqual(after(cfg, s), before(cfg, s), `${JSON.stringify(models)} ${s.id}`);
  }
});

test("没配 byRole：大脑开的会话用的模型和退路，跟线上一样", async () => {
  const t = makeBrain({ models: LIVE }, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "on_it", args: { topic: "整理素材", about: "一小时" } } });
  await flush();
  const main = t.driver.latest("main").spec;
  const side = t.driver.latest("side-1").spec;
  assert.equal(main.model, "claude-fable-5-2");
  assert.equal(main.fallbackModel, undefined, "主线不带退路");
  assert.equal(side.model, "claude-fable-5-2");
  assert.equal(side.fallbackModel, "claude-sonnet-5-5");
});

test("配了 byRole：主线留 Fable、opus 档换成 Opus——主线用 Fable 不带退路，支线、深想、海马用 Opus、退到 Sonnet，说话和下意识照旧 Haiku", () => {
  const cfg = loadConfig({ ...ALL, models: { ...LIVE, opus: "claude-opus-5-5", byRole: { main: "claude-fable-5-2" } } });
  const got = Object.fromEntries(regionSpecs(cfg).map((s) => [s.role, after(cfg, s)]));
  assert.deepEqual(got.main, { model: "claude-fable-5-2" });
  for (const r of ["side", "deep", "hippocampus"]) assert.deepEqual(got[r], { model: "claude-opus-5-5", fallback: "claude-sonnet-5-5" }, r);
  for (const r of ["speech", "perception"]) assert.deepEqual(got[r], { model: "claude-haiku-5-5" }, r);
  // 一次性的会话（导入、体检这些）不归 byRole：照旧按档
  assert.equal(modelFor(cfg, "opus"), "claude-opus-5-5");
});

test("配了 byRole、某个脑区指定的模型正好就是退路那个：这个脑区不带退路（不然 SDK 开会话当场抛错），别的照带；会话开得起来", async () => {
  const models = { ...LIVE, opus: "claude-opus-5-5", byRole: { side: "claude-sonnet-5-5" } };
  const cfg = loadConfig({ models });
  const side = regionSpecs(cfg).find((s) => s.role === "side")!;
  const deep = regionSpecs(cfg).find((s) => s.role === "deep")!;
  assert.deepEqual(after(cfg, side), { model: "claude-sonnet-5-5" }, "退路和主模型相同：不带");
  assert.deepEqual(after(cfg, deep), { model: "claude-opus-5-5", fallback: "claude-sonnet-5-5" });
  // 大脑里真开一次（假内核跟真的 SDK 一样：退路和主模型相同就抛错）
  const t = makeBrain({ models }, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "on_it", args: { topic: "整理素材", about: "一小时" } } });
  await flush();
  const s = t.driver.latest("side-1").spec;
  assert.equal(s.model, "claude-sonnet-5-5");
  assert.equal(s.fallbackModel, undefined);
  const noted = t.logs.find((l) => l.msg === "regions: no fallback model");
  assert.ok(noted, "启动时记下哪几个脑区没有退路");
  assert.deepEqual(noted!.regions, regionSpecs(cfg).filter((x) => x.role === "side").map((x) => x.id), "只有支线那几个");
});

test("requireInstance：byRole 里写错角色名、模型名是空的、不是对象，起来时当场报；写对了不报", () => {
  const base = { workspace: "/tmp/hh-test-ws", stateDir: "/tmp/hh-test-state", gate: { enabled: false } };
  const check = (byRole: unknown): void => requireInstance(loadConfig({ ...base, models: { ...LIVE, byRole } }));
  assert.doesNotThrow(() => check({ main: "claude-fable-5-2" }));
  assert.doesNotThrow(() => requireInstance(loadConfig({ ...base, models: LIVE })), "不写 byRole");
  assert.throws(() => check({ mian: "claude-fable-5-2" }), /models\.byRole has an unknown role "mian" — known roles: main, side, deep, hippocampus, speech, perception/);
  assert.throws(() => check({ main: "" }), /models\.byRole\.main must be a model name/);
  assert.throws(() => check({ main: 5 }), /models\.byRole\.main must be a model name/);
  assert.throws(() => check({ main: " claude-fable-5-2" }), /models\.byRole\.main has spaces around the model name/);
  assert.throws(() => check(["main"]), /models\.byRole must be an object/);
  assert.throws(() => check("claude-fable-5-2"), /models\.byRole must be an object/);
});

test("byRole 认得的角色名和脑区定义里的角色一样（以后加了新角色，这里会提醒补上）", () => {
  const roles = new Set(regionSpecs(loadConfig({ ...ALL, models: LIVE })).map((s) => s.role));
  assert.deepEqual(new Set(MODEL_ROLES), roles);
});

test("byRole 写了、却没有这个角色的脑区（闸门开着时没有下意识）：起来时记一条警告，不悄悄忽略；都有脑区时不记", () => {
  const t = makeBrain({ models: { ...LIVE, byRole: { perception: "claude-haiku-5-5", main: "claude-fable-5-2" } } });
  const w = t.logs.find((l) => l.msg === "regions: models.byRole names roles with no region");
  assert.ok(w, "默认配置闸门开着，没有下意识");
  assert.deepEqual(w!.roles, ["perception"]);
  const ok = makeBrain({ ...ALL, models: { ...LIVE, byRole: { perception: "claude-haiku-5-5" } } });
  assert.ok(!ok.logs.some((l) => l.msg === "regions: models.byRole names roles with no region"));
});

test("起来时记一行每个脑区实际用的模型和退路（改了配置、或者代码被退回去以后，一眼看得出主线在用哪个）", () => {
  const t = makeBrain({ ...ALL, models: { ...LIVE, opus: "claude-opus-5-5", byRole: { main: "claude-fable-5-2" } } });
  const line = t.logs.find((l) => l.msg === "regions: models");
  assert.ok(line, "记了");
  assert.equal(line!.main, "claude-fable-5-2", "主线：按角色指定的，不带退路");
  assert.equal(line!["side-1"], "claude-opus-5-5 → claude-sonnet-5-5", "支线：opus 档，退到 sonnet");
  assert.equal(line!.hippocampus, "claude-opus-5-5 → claude-sonnet-5-5");
  assert.equal(line!["perception-messages"], "claude-haiku-5-5");
  const plain = makeBrain({ models: LIVE }).logs.find((l) => l.msg === "regions: models");
  assert.equal(plain!.main, "claude-fable-5-2");
  assert.equal(plain!["side-1"], "claude-fable-5-2 → claude-sonnet-5-5", "没配 byRole：跟线上一样");
});
