// 回放（hh sleep replay）：隔离（W 和主库不动、拷贝里旧的整理那一夜撤掉了）、跳过准备和落地、对比、不调 OpenAI 的闸、同时只跑一个。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { deepMerge, loadConfig, requireInstance, type Config } from "../src/config.ts";
import { Chrome } from "../src/browser/chrome.ts";
import { browserCommand, sendCommand } from "../src/cli-direct.ts";
import { P, S } from "../src/lang/index.ts";
import { loadOpenAIKey } from "../src/memory/events/embed.ts";
import { FakeDriver, type FakeSession, type Script } from "../src/kernel/fake.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { OpenAIEmbedder } from "../src/memory/events/embed.ts";
import { all, kvSet, one, openDb, type Db } from "../src/store/db.ts";
import { memTools } from "../src/tools/memtools.ts";
import { runProcess, type Runner } from "../src/util/run.ts";
import { FlowError, parseFlow } from "../src/sleep/flow.ts";
import { MEM_STORE_WRITERS } from "../src/tools/memtools.ts";
import { SLEEP_BUILTINS, SLEEP_HH_TOOLS } from "../src/sleep/host.ts";
import { BLOCKED_LOG, OpenAIGuard, ReplayManager, SKIP_CMD, installOpenAIGuard, laterBatches, legacyBatches, nightWindow, skipScripts, type ReplayDeps } from "../src/sleep/replay.ts";

const D = "2026-11-06";
const sleepMs = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });

async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
const put = (root: string, rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };

/** 整棵树（含 .git）每个文件的路径和内容的 hash */
function treeHash(root: string): string {
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    for (const n of readdirSync(join(root, rel)).sort()) {
      const p = rel ? `${rel}/${n}` : n;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else h.update(p).update("\0").update(readFileSync(join(root, p))).update("\0");
    }
  };
  walk("");
  return h.digest("hex");
}
/** 库里每张表的每一行 */
const dump = (db: Db): string => {
  const rowText = (r: unknown): string => JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v));
  return JSON.stringify(all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .map((t) => [t.name, all(db, `SELECT * FROM "${t.name}"`).map(rowText).sort()]));
};

const event = (title: string) => ({ title, summary: `${title}的经过`, gist: title, why: "测试", importance: 3, status: "done", entities: [{ name: "老张", kind: "person", role: "with" }] });
const handIn = (report: string, extra: Record<string, unknown> = {}): Script => ({ tool: { name: "stage_done", args: { status: "done", changes: [], report, ...extra } } });
const AUDIT_PASS: Script = { tool: { name: "audit_done", args: { verdict: "pass", problems: [] } } };

const byStageOf = (dir: string): Record<string, { stage: string; status: string; verdict: string }> => {
  const ledger = JSON.parse(readFileSync(join(dir, "out", "ledger.json"), "utf8")) as { sleep_stage: Array<{ stage: string; status: string; verdict: string }> };
  return Object.fromEntries(ledger.sleep_stage.map((x) => [x.stage, x]));
};

async function opened(driver: FakeDriver, id: string): Promise<FakeSession> {
  for (let i = 0; i < 500; i++) {
    const s = driver.sessions.find((x) => x.id === id);
    if (s) return s;
    await sleepMs(10);
  }
  throw new Error(`${id} 没开（开了的：${driver.sessions.map((x) => x.id).join("、")}）`);
}
/** 在会话里调一个工具、不结束这一轮：先过 guard，再调 handler */
async function call(s: FakeSession, name: string, args: Record<string, unknown>): Promise<string> {
  const deny = s.spec.hooks.beforeTool(name, args);
  if (deny) return `拦下：${deny}`;
  const def = s.spec.tools.find((x) => x.name === name);
  if (!def) throw new Error(`${s.id} 没有 ${name}`);
  return String(await def.handler(args));
}

/**
 * 一个临时的 W（git 仓库）：基准提交、旧的整理落地的提交（改 memory/a.md，带 sleep/ 下的整理文件）、之后一个不相干的提交；
 * sleep/<日>/input.md 不进 git。新的流程目录在 W 外面（像 mira 的 worktree）：flow.json 写的 engine legacy（回放照样跑 flow）。
 * 主库是真文件：旧的整理那一夜的批次在夜里的窗口里，还有一批导入的（不算）、学习的花费账。
 */
async function rig(o: { run?: Runner } = {}) {
  const tmp = tmpDir("hh-replay-", "/tmp");   // 短路径：回放的子配置里 state/hh.sock 加起来要在 macOS 的 103 字节内，否则 `hh learn ids` 报 EINVAL 不是 ENOENT（#0091）
  const W = join(tmp, "W");
  mkdirSync(W);
  await gitIn(W, "init", "-q");
  put(W, "SOUL.md", "我是她。\n");
  put(W, "memory/a.md", "第一行\n第二行\n");
  put(W, "memory/b.md", "乙\n");
  put(W, ".gitignore", "sleep/*/input.md\n");
  await gitIn(W, "add", "-A");
  await gitIn(W, "commit", "-q", "-m", `白天 ${D}：她的改动`);
  const base = await gitIn(W, "rev-parse", "HEAD");
  put(W, "memory/a.md", "第一行\n第二行\n旧的整理加的一行\n");
  put(W, `sleep/${D}/report.md`, "旧的整理的报告\n");
  await gitIn(W, "add", "-A");
  await gitIn(W, "commit", "-q", "-m", `睡眠整理 ${D}：记忆（1 个文件）`);
  const landing = await gitIn(W, "rev-parse", "HEAD");
  put(W, "memory/b.md", "乙，后来又改了\n");
  await gitIn(W, "commit", "-q", "-am", "日记 11-07");
  put(W, `sleep/${D}/input.md`, "这一天的整份材料\n");
  put(W, `sleep/${D}/sources.json`, "{}\n");

  const flowDir = join(tmp, "flow");
  const flow = {
    engine: "legacy", maxParallel: 1, auditModel: "opus",
    stages: [
      { id: "prepare", title: "准备", kind: "script", command: ["python3", "scripts/sleep_apply.py", "prepare", "{day}"] },
      { id: "a", title: "甲", kind: "agent", skill: "stages/a.md", after: ["prepare"], required: true, tools: ["recall", "mem_event_create"], material: ["dialogue"], writes: ["memory/a.md"] },
      { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/sleep_apply.py", "finish", "{day}"], after: ["a"] },
    ],
  };
  put(flowDir, "flow.json", JSON.stringify(flow));
  put(flowDir, "common.md", "整理时的共同规矩。\n");
  put(flowDir, "stages/a.md", "甲段的 skill 页\n");

  const stateDir = join(tmp, "state");
  const cfg = loadConfig({ workspace: W, stateDir, schedule: { timezone: "UTC", focusSlots: ["07:30"], focusMinutes: 30, nightSleep: "03:00", wanderEveryMinutes: 45 }, learning: { root: join(W, "skills") }, sleep: { workspaceEnv: ["OPENCLAW_WORKSPACE"] } });  // 部署的配置（HH_CONFIG）里写平台的名字
  const live = openDb(join(tmp, "live", "hh.db"));
  const win = nightWindow(D, "UTC", "03:00");
  let t = win.from - 12 * 3_600_000;
  const liveMem = new EventMemory({ db: live, embedder: null, now: () => t, tz: "UTC" });
  liveMem.beginImport("day");
  liveMem.write("mem_event_create", event("白天导入的事"), "importer");
  liveMem.endImport(true);
  t = win.from + 5 * 60_000;
  liveMem.beginNight(`night:${D}/${D}`);
  liveMem.write("mem_event_create", event("旧的整理记的事"), "hippocampus");
  liveMem.commitNight();
  liveMem.markDays([D]);
  t = win.from + 6 * 3_600_000;
  liveMem.store.openBatch("day-like:morning");
  liveMem.store.commitBatch("day-like:morning");
  kvSet(live, `learn.spend.${D}`, "1234");

  const driver = new FakeDriver();
  const logs: LogRecord[] = [];
  const runs: Array<{ cmd: string; args: readonly string[] }> = [];
  const run: Runner = async (cmd, args, opts) => { runs.push({ cmd, args }); return o.run ? o.run(cmd, args, opts) : runProcess(cmd, args, opts); };
  const deps: ReplayDeps = {
    cfg, driver, db: live, log: new Logger("t", memorySink(logs)), run, now: Date.now,
    later: (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return () => clearTimeout(h); },
    openMem: (db, x) => new EventMemory({ db, embedder: null, tz: "UTC", ...(x.peopleDir ? { peopleDir: x.peopleDir } : {}), ...(x.peopleActive ? { peopleActive: x.peopleActive } : {}) }),
    tools: (id, names, x) => memTools(x.mem, id, names, x.learn),
  };
  return { tmp, W, base, landing, flowDir, stateDir, cfg, live, driver, logs, runs, deps };
}

test("replay isolation: W and the main db are untouched; the copy has the legacy night's batch reverted; the replay's writes land only in the copy", { timeout: 60_000 }, async () => {
  const r = await rig();
  const wBefore = treeHash(r.W);
  const dbBefore = dump(r.live);
  const m = new ReplayManager();
  const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir });
  assert.ok(dir.startsWith(join(r.stateDir, "replay") + "/"), "回放目录在 <stateDir>/replay/<ts>/ 下");
  const ws = join(dir, "ws");

  const s = await opened(r.driver, `sleep-${D}-a-1`);
  const made = await call(s, "mem_event_create", event("回放里记的事"));
  const eid = /e\d{3,}/.exec(made)?.[0];
  assert.ok(eid, made);
  put(ws, `sleep/${D}/proposed/memory/a.md`, "第一行改了\n第二行\n");
  await s.play(handIn("甲改了 a", { changes: [
    { target: "memory/a.md", op: "change", before: "第一行", after: "第一行改了", evidence: ["#1"], why: "说过" },
    { target: eid, op: "add", before: "", after: "回放里记的事", evidence: ["#1"], why: "说过" },
  ] }));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;

  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null; base: string };
  assert.equal(st.phase, "done", st.error ?? "");
  assert.equal(st.base, r.base, "基准默认是「睡眠整理 <日>」第一个提交的上一个");
  // W、主库一点没动
  assert.equal(treeHash(r.W), wBefore, "W（连 .git）一个字节都没变");
  assert.equal(dump(r.live), dbBefore, "主库一行都没变");
  assert.ok(!existsSync(join(r.W, "sleep", D, "proposed")), "提案没写进 W");
  // 拷贝：旧的整理那一夜的批次撤了（导入的不动），回放的那一段提交在拷贝里
  const copy = openDb(join(dir, "hh.db"));
  try {
    const state = (id: string) => one<{ state: string }>(copy, "SELECT state FROM mem_batch WHERE id = ?", id)?.state;
    assert.equal(state(`night:${D}/${D}`), "reverted");
    assert.equal(state("import:day"), "committed");
    assert.equal(state("day-like:morning"), "committed", "那一夜以后的批次不撤");
    const titles = all<{ title: string }>(copy, "SELECT title FROM mem_event ORDER BY id").map((x) => x.title);
    assert.deepEqual(titles, ["白天导入的事", "回放里记的事"]);
    assert.equal(state(`sleep:${D}/a/1`), "committed");
    assert.equal(one(r.live, "SELECT 1 AS x FROM mem_event WHERE title = '回放里记的事'"), undefined, "主库里没有回放写的");
    assert.ok(one(copy, "SELECT 1 AS x FROM sleep_run WHERE night = ?", `replay-${D}`), "记账在拷贝里");
  } finally { copy.close(); }
  const reverted = JSON.parse(readFileSync(join(dir, "out", "reverted.json"), "utf8")) as { batches: Array<{ batch: string; conflicts: string[] }>; dayMarkRemoved: boolean; afterTheNightNotReverted: Array<{ batch: string }> };
  assert.deepEqual(reverted.batches.map((b) => b.batch), [`night:${D}/${D}`]);
  assert.equal(reverted.dayMarkRemoved, true);
  assert.deepEqual(reverted.afterTheNightNotReverted.map((b) => b.batch), ["day-like:morning"], "早上的批次不撤，列出来");
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /after the night, not reverted[^\n]*day-like:morning 0/);
  assert.ok(r.logs.some((l) => l.msg === "replay: legacy night reverted in the copy"));
  // 临时的东西都在回放目录下；出来的东西齐了
  for (const p of ["ws", "hh.db", "state", "out/report.md", "out/compare.md", "out/ledger.json", "out/no-openai.txt", "out/records"]) assert.ok(existsSync(join(dir, p)), p);
  assert.ok(existsSync(join(dir, "out", "records", "a.json")), "这一段的记录");
  assert.equal(readFileSync(join(dir, "out", "proposed", "memory", "a.md"), "utf8"), "第一行改了\n第二行\n");
  const noAI = readFileSync(join(dir, "out", "no-openai.txt"), "utf8");
  assert.match(noAI, /api\.openai\.com requests from the replay \(counted by the guard\): 0/);
  assert.match(noAI, /learn\.spend, replay copy db .*1 个 key，共 1234 tokens.*equal: yes/);
  assert.match(noAI, /verdict: PASS/);
  // 状态：跑完了
  assert.match(m.status(r.stateDir, Date.now()), /回放 2026-11-06：跑完了[\s\S]*out/);
  assert.match(new ReplayManager().status(r.stateDir, Date.now()), /跑完了/, "新的 hhd 读最近一个的 status.json");
});

test("replay: prepare and finish are skipped (never run, never land in W); the ledger shows them skipped; the engine runs flow even when flow.json says legacy", { timeout: 60_000 }, async () => {
  const r = await rig();
  // finish 前面加一个核对脚本：照跑，在回放的工作区里、子进程没有 OpenAI 的 key
  const flow = JSON.parse(readFileSync(join(r.flowDir, "flow.json"), "utf8")) as { stages: Array<Record<string, unknown>> };
  flow.stages.splice(2, 0, { id: "check", title: "核对", kind: "script", command: ["true"], after: ["a"] });
  flow.stages[3]!.after = ["check"];
  writeFileSync(join(r.flowDir, "flow.json"), JSON.stringify(flow));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  assert.equal(s.spec.env?.OPENAI_API_KEY, "", "段的会话（和它的 Bash）没有 OpenAI 的 key");
  assert.equal(s.spec.env?.OPENAI_BASE_URL, "http://127.0.0.1:9/v1");
  put(join(dir, "ws"), `sleep/${D}/proposed/memory/a.md`, "第一行\n第二行\n回放加的\n");
  await s.play(handIn("甲加了一行", { changes: [{ target: "memory/a.md", op: "add", before: "", after: "回放加的", evidence: ["#1"], why: "说过" }] }));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  assert.ok(!r.runs.some((x) => x.args.some((a) => String(a).includes("sleep_apply.py"))), "准备、落地的脚本一次都没跑");
  assert.ok(!r.runs.some((x) => x.cmd === SKIP_CMD || x.args.includes(SKIP_CMD)), "跳过的段不起进程");
  const check = r.runs.find((x) => x.cmd === "/usr/bin/env" && x.args.includes("true"));
  assert.ok(check, "核对脚本照跑");
  assert.deepEqual(check.args.slice(0, 4), [`OPENCLAW_WORKSPACE=${join(dir, "ws")}`, `HH_CONFIG=${join(dir, "state", "config.json")}`, "OPENAI_API_KEY=", "OPENAI_BASE_URL=http://127.0.0.1:9/v1"]);
  assert.equal(byStageOf(dir).check!.status, "passed");
  const byStage = byStageOf(dir);
  for (const id of ["prepare", "finish"]) {
    assert.equal(byStage[id]!.status, "passed", id);
    assert.match(byStage[id]!.verdict, /^回放：跳过/, id);
  }
  assert.equal(byStage.a!.status, "passed");
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /跳过的脚本段：prepare、finish/);
  assert.equal(readFileSync(join(r.W, "memory", "a.md"), "utf8"), "第一行\n第二行\n旧的整理加的一行\n", "W 的文件没被落地");
  assert.match(readFileSync(join(dir, "out", "report.md"), "utf8"), /甲：过了/);
});

test("replay: compare.md lists a file changed by both the legacy night and the replay, with the event-store ops on each side", { timeout: 60_000 }, async () => {
  const r = await rig();
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  const eid = /e\d{3,}/.exec(await call(s, "mem_event_create", event("回放里记的事")))![0];
  put(join(dir, "ws"), `sleep/${D}/proposed/memory/a.md`, "第一行改了\n第二行\n");
  await s.play(handIn("甲改了 a", { changes: [
    { target: "memory/a.md", op: "change", before: "第一行", after: "第一行改了", evidence: ["#1"], why: "说过" },
    { target: eid, op: "add", before: "", after: "回放里记的事", evidence: ["#1"], why: "说过" },
  ] }));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
  assert.match(cmp, /\| memory\/a\.md \| \+1 −0 \| \+1 −1 \| 两边都改 \|/, cmp);
  assert.doesNotMatch(cmp, /\| sleep\//, "旧的整理在 sleep/ 下的整理文件不算");
  assert.match(cmp, new RegExp(`旧的整理落地的提交：${r.landing}`));
  assert.match(cmp, new RegExp(`- 旧的整理：\\d+ 行（night:${D}/${D} \\d+；拷贝里撤了）`));
  assert.match(cmp, new RegExp(`- 回放：\\d+ 行（sleep:${D}/a/1 \\d+）`));
  assert.match(cmp, /\| a \| — \| — \| passed \| 1 \|/);
  assert.match(readFileSync(join(dir, "out", "legacy.patch"), "utf8"), /\+旧的整理加的一行/);
  assert.match(readFileSync(join(dir, "out", "replay.patch"), "utf8"), /\+第一行改了/);
});

// #0055：比的时候写出来的基准版本（<回放>/tmp/base/）是草稿，比完删掉，比出错也删；出来的东西（out/、ws、拷贝）照旧留着
test("replay: the base copies written for compare.md are removed after, also when the compare fails", { timeout: 60_000 }, async () => {
  for (const fail of [false, true]) {
    const r = await rig(fail ? { run: (cmd, args, opts) => (cmd === "git" && args.includes("--no-index") ? Promise.resolve({ code: 2, stdout: "", stderr: "坏了" }) : runProcess(cmd, args, opts)) } : {});
    const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
    const s = await opened(r.driver, `sleep-${D}-a-1`);
    put(join(dir, "ws"), `sleep/${D}/proposed/memory/a.md`, "第一行改了\n第二行\n");
    await s.play(handIn("甲改了 a", { changes: [{ target: "memory/a.md", op: "change", before: "第一行", after: "第一行改了", evidence: ["#1"], why: "说过" }] }));
    await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
    await done;
    const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
    if (fail) assert.match(cmp, /对比没做成/, cmp);
    else assert.match(readFileSync(join(dir, "out", "replay.patch"), "utf8"), /\+第一行改了/);
    assert.equal(existsSync(join(dir, "tmp")), false, fail ? "比出错" : "比完");
    for (const p of ["ws", "hh.db", "state", "out/compare.md"]) assert.ok(existsSync(join(dir, p)), p);
  }
});

test("replay guard: inside a replay a request to api.openai.com (fetch, an embedder, https) throws, is logged and counted; outside it goes through", async () => {
  const realFetch = globalThis.fetch;
  const seen: string[] = [];
  const fake = (async (u: unknown) => { seen.push(String(u)); return new Response("{}"); }) as typeof fetch;
  globalThis.fetch = fake;
  const logs: string[] = [];
  const guard = new OpenAIGuard((m) => logs.push(m));
  const off = installOpenAIGuard();
  try {
    await guard.run(async () => {
      await assert.rejects(fetch("https://api.openai.com/v1/embeddings", { method: "POST" }), /blocked openai request/);
      // 回放里建的向量服务（拿到的是包过的 fetch）：请求被拦，embed 回 null（关键词照常）
      assert.equal(await new OpenAIEmbedder({ key: "sk-test" }).embed(["一句话"]), null);
      const https = await import("node:https");
      assert.throws(() => https.request("https://api.openai.com/v1/decisions"), /blocked openai request/);
      await fetch("https://example.com/x");
    });
    assert.equal(guard.blocked, 3);
    assert.equal(logs.filter((m) => m === BLOCKED_LOG).length, 3);
    await fetch("https://api.openai.com/v1/models");
    assert.deepEqual(seen, ["https://example.com/x", "https://api.openai.com/v1/models"], "回放外面的照常放行");
  } finally {
    off();
  }
  assert.equal(globalThis.fetch, fake, "卸下后还原");
  globalThis.fetch = realFetch;
});

test("replay code never builds an OpenAI client or reads the key", () => {
  const src = readFileSync(resolve(import.meta.dirname, "../src/sleep/replay.ts"), "utf8");
  for (const bad of ["OpenAIEmbedder", "OpenAIDecisions", "loadOpenAIKey", "makeLearning", "nightTune", "secrets.json", "learning/decisions", "learning/tuner", "learning/runtime", "events/embed"]) {
    assert.ok(!src.includes(bad), bad);
  }
  assert.equal(S.replay.noCheck, "回放：不送把关");
});

test("replay: learn_check answers 回放：不送把关 at once and records nothing; learn_worklist runs without vectors", { timeout: 60_000 }, async () => {
  const r = await rig();
  const flow = JSON.parse(readFileSync(join(r.flowDir, "flow.json"), "utf8")) as { stages: Array<Record<string, unknown>> };
  flow.stages[1]!.tools = ["recall", "learn_check", "learn_worklist"];
  writeFileSync(join(r.flowDir, "flow.json"), JSON.stringify(flow));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  assert.equal(await call(s, "learn_check", { day: D, candidates: [{ kind: "教训", page: "p:x", text: "一条", evidence: "#1" }] }), S.replay.noCheck);
  assert.match(await call(s, "learn_worklist", { day: D }), /# 学习工作单/);
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  assert.ok(!r.driver.sessions.some((x) => x.id.startsWith("check-")), "没开把关会话");
  assert.ok(!existsSync(join(dir, "ws", "learn")), "没写把关结论");
});

test("replay: a second replay while one is running is refused; a failed replay says so in replay-status", { timeout: 30_000 }, async () => {
  let release: (v: { code: number; stdout: string; stderr: string }) => void = () => {};
  const r = await rig({ run: () => new Promise((ok) => { release = ok; }) });
  const m = new ReplayManager();
  const first = m.start(r.deps, { day: D, flowDir: r.flowDir });
  assert.throws(() => m.start(r.deps, { day: D, flowDir: r.flowDir }), /已经有一个回放在跑/);
  assert.throws(() => new ReplayManager().start(r.deps, { day: "11-06" }), /YYYY-MM-DD/);
  assert.match(m.status(r.stateDir, Date.now()), /回放 2026-11-06：在准备工作区/);
  release({ code: 128, stdout: "", stderr: "不是 git 仓库" });
  await first.done;
  assert.match(m.status(r.stateDir, Date.now()), /出错停了（git log/);
  const noAI = readFileSync(join(first.dir, "out", "no-openai.txt"), "utf8");
  assert.match(noAI, /counted by the guard\): 0/, "出错了也写 no-openai.txt");
  assert.match(noAI, /no copy made[\s\S]*verdict: PASS/);
  // 跑完了可以再开
  const again = m.start({ ...r.deps, run: async () => ({ code: 1, stdout: "", stderr: "x" }) }, { day: D });
  await again.done;
  assert.notEqual(again.dir, first.dir);
});

// ---------- 小件 ----------
test("nightWindow: the night of a day starts at nightSleep (before noon = the next morning) in her time zone and lasts 8 hours", () => {
  const w = nightWindow("2026-11-06", "Australia/Melbourne", "03:00");
  assert.equal(w.from, Date.UTC(2026, 10, 6, 16, 0), "枫湾 11-07 03:00（夏令时 +11）");
  assert.equal(w.to - w.from, 8 * 3_600_000);
  assert.equal(nightWindow("2026-11-06", "UTC", "23:30").from, Date.UTC(2026, 10, 6, 23, 30), "中午以后的睡觉点就在当天");
});

test("legacyBatches: only the legacy night's own batch for that day (night:<night>/<day>, or night:<day>/today); laterBatches lists what moved after it, not reverted", () => {
  const db = openDb(":memory:");
  let t = 1_000_000;
  const mem = new EventMemory({ db, embedder: null, now: () => t, tz: "UTC" });
  const batch = (id: string, state: "committed" | "open" = "committed") => { mem.store.openBatch(id); if (state === "committed") mem.store.commitBatch(id); t += 1000; };
  batch("day-like:before");
  batch("night:2026-11-05/2026-11-05");
  batch("night:2026-11-06/2026-11-06");
  batch("import:people:x");
  batch("sleep:2026-11-06/a/1");
  batch("day-like:morning");
  batch("night:2026-11-07/today");
  batch("night:2026-11-08/2026-11-06x");
  assert.deepEqual(legacyBatches(db, "2026-11-06").map((b) => b.id), ["night:2026-11-06/2026-11-06"]);
  assert.deepEqual(legacyBatches(db, "2026-11-07").map((b) => b.id), ["night:2026-11-07/today"], "没有积压时整理当天：night:<那一夜>/today");
  const since = legacyBatches(db, "2026-11-06")[0]!.startedAt;
  assert.deepEqual(laterBatches(db, since, new Set(["night:2026-11-06/2026-11-06"])).map((b) => b.id),
    ["day-like:morning", "night:2026-11-07/today", "night:2026-11-08/2026-11-06x"], "以后动过的都列，导入和新睡眠的段不列，这一夜自己的不列");
  mem.store.revertBatch("night:2026-11-06/2026-11-06");
  assert.deepEqual(legacyBatches(db, "2026-11-06"), [], "撤回过的（和留档）不再算");
});

test("skipScripts: prepare scripts, finish and anything after finish are skipped; a check before finish still runs", () => {
  const known = { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) };
  const flow = parseFlow({ engine: "flow", stages: [
    { id: "prepare", title: "准备", kind: "script", command: ["prep"] },
    { id: "slice", title: "切片", kind: "script", command: ["slice"], after: ["prepare"] },
    { id: "a", title: "甲", kind: "agent", skill: "a.md", after: ["slice"], writes: ["memory/a.md"] },
    { id: "check", title: "核对", kind: "script", command: ["check"], after: ["a"] },
    { id: "finish", title: "落地", kind: "script", command: ["finish"], after: ["check"] },
    { id: "export", title: "导出", kind: "script", command: ["export"], after: ["finish"] },
  ] }, known);
  const { plan, skipped } = skipScripts({ flow, prefix: "P", hash: "h" });
  assert.deepEqual(skipped, ["prepare", "slice", "finish", "export"]);
  const cmd = Object.fromEntries(plan.flow.stages.map((s) => [s.id, s.command]));
  assert.deepEqual(cmd.check, ["check"]);
  assert.deepEqual(cmd.finish, [SKIP_CMD, "finish"]);
  assert.deepEqual(flow.stages.find((s) => s.id === "finish")!.command, ["finish"], "原来的流程不动");
});

test("sleepRequest: hh sleep replay <day> [--base] [--flow-dir] (made absolute) and replay-status; bad forms get the usage", async () => {
  const { sleepRequest, UsageError } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest(["replay", D]), { cmd: "sleep-replay", day: D });
  assert.deepEqual(sleepRequest(["replay", D, "--base", "366d4635", "--flow-dir", "rel/flow"]), { cmd: "sleep-replay", day: D, base: "366d4635", flowDir: resolve("rel/flow") });
  assert.deepEqual(sleepRequest(["replay-status"]), { cmd: "sleep-replay-status" });
  for (const w of [["replay"], ["replay", "11-06"], ["replay", D, "--base"], ["replay", D, "--wat", "x"], ["replay-status", "x"]]) {
    assert.throws(() => sleepRequest(w), (e: unknown) => e instanceof UsageError && /用法：hh sleep/.test(e.message), w.join(" "));
  }
});

// ---------- Brain 这一头 ----------
import { makeBrain, flush } from "./helpers.ts";
import type { Embedder } from "../src/memory/events/embed.ts";

test("replay tools from Brain: recall / remember / recall_event read the copy with no embedder; the live embedder is never called; no notes association", async () => {
  let calls = 0;
  const embedder: Embedder = { embed: async (texts) => { calls += 1; return texts.map(() => new Float32Array(512)); } };
  const liveDb = openDb(":memory:");
  const liveMem = new EventMemory({ db: liveDb, embedder, tz: "UTC" });
  const t = makeBrain({}, undefined, { db: liveDb, mem: liveMem });
  await liveMem.quotes("看海");
  assert.ok(calls > 0, "对照：主事件记忆想起原话会调向量服务");
  const deps = (t.brain as unknown as { replayDeps(): ReplayDeps }).replayDeps();
  const copyDb = openDb(":memory:");
  const copy = deps.openMem(copyDb, {});
  assert.equal(copy.index.embedder, null, "回放的事件记忆不带向量服务");
  const before = calls;
  const tools = deps.tools("sleep-2026-11-06-a-1", ["recall", "remember", "recall_event", "learn_check"], {
    mem: copy, db: copyDb, workspace: "/tmp/hh-replay-ws", learn: { worklist: async () => "", check: () => S.replay.noCheck },
  });
  const run = (name: string, args: Record<string, unknown>) => tools.find((x) => x.name === name)!.handler(args);
  await run("recall", { args: ["search", "看海"] });
  await run("recall", { args: ["day", D] });
  await run("remember", { cue: "看海" });
  await run("recall_event", { ref: "看海" });
  assert.equal(await run("learn_check", { day: D, candidates: [] }), S.replay.noCheck);
  assert.equal(calls, before, "回放的工具一次都没碰向量服务");
  await t.brain.stop();
});

test("Brain: hh sleep replay is refused while she sleeps the real night; replay-status with nothing yet says so", async () => {
  const t = makeBrain({ stateDir: tmpDir("hh-replay-brain-") }, Date.UTC(2026, 9, 29, 2, 30));
  assert.equal(t.brain.sleepReplayStatus(), "还没回放过");
  await t.brain.sleep("夜里", "night");
  await flush();
  assert.throws(() => t.brain.sleepReplay(D, { iKnowItSpendsQuota: true }), /夜里睡/);
  await t.brain.stop();
});

// 新的睡眠 2026-11-13 停了：回放开的是真的模型会话、花她这周的额度，要明说 --i-know-it-spends-quota 才开；hhd 这边也核
const REFUSED = "没开回放：回放会开真的模型会话、花她这周的额度，新的睡眠项目 2026-11-13 已经停了。真要跑，加上 --i-know-it-spends-quota（hh sleep replay <日> --i-know-it-spends-quota）";

test("sleepRequest: --i-know-it-spends-quota after replay (anywhere) becomes iKnowItSpendsQuota: true; without it the request carries no confirmation; the usage names the flag", async () => {
  const { sleepRequest, UsageError } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest(["replay", D, "--i-know-it-spends-quota"]), { cmd: "sleep-replay", day: D, iKnowItSpendsQuota: true });
  assert.deepEqual(sleepRequest(["replay", "--i-know-it-spends-quota", D, "--flow-dir", "rel/flow"]), { cmd: "sleep-replay", day: D, flowDir: resolve("rel/flow"), iKnowItSpendsQuota: true });
  assert.deepEqual(sleepRequest(["replay", D]), { cmd: "sleep-replay", day: D });
  assert.throws(() => sleepRequest(["replay", D, "--i-know"]), (e: unknown) => e instanceof UsageError && e.message.includes("--i-know-it-spends-quota"));
});

test("hh sleep replay on the command line without --i-know-it-spends-quota stops before hhd: the refusal on stderr, exit code 1; with it the request carries the confirmation; replay-status / replay-stop parse as before", async () => {
  const { parse } = await import("../src/cli-parse.ts");
  const { UsageError } = await import("../src/control.ts");
  const refused = (e: unknown): boolean => e instanceof Error && !(e instanceof UsageError) && e.message === REFUSED;
  assert.throws(() => parse(["sleep", "replay", D]), refused);
  assert.throws(() => parse(["sleep", "replay", D, "--flow-dir", "/tmp/hh-no-such-flow", "--base", "366d4635"]), refused);
  assert.deepEqual(parse(["sleep", "replay", D, "--i-know-it-spends-quota"]), { cmd: "sleep-replay", day: D, iKnowItSpendsQuota: true });
  assert.deepEqual(parse(["sleep", "replay-status"]), { cmd: "sleep-replay-status" });
  assert.deepEqual(parse(["sleep", "replay-stop"]), { cmd: "sleep-replay-stop" });
  // 真跑 hh：配置指到一个空的状态目录（万一没停下，也连不到哪个 hhd）
  const { spawnSync } = await import("node:child_process");
  const dir = tmpDir("hh-replay-cli-");
  const cfgFile = join(dir, "config.json");
  // 名字也给上：默认配置里没有名字了，闸门默认开着，没名字 hh 一启动就停在 requireInstance，走不到下面要测的那句拒绝
  writeFileSync(cfgFile, JSON.stringify({ lang: "zh", stateDir: join(dir, "state"), workspace: join(dir, "ws"), names: { me: "阿青", owner: "老林", notMe: [] } }));
  const env: NodeJS.ProcessEnv = { ...process.env, HH_CONFIG: cfgFile };
  delete env.HH_SESSION;
  const r = spawnSync(process.execPath, [resolve(import.meta.dirname, "../src/cli.ts"), "sleep", "replay", D], { encoding: "utf8", env, timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.ok(r.stderr.includes(REFUSED), r.stderr);
  assert.equal(r.stdout, "");
});

test("hh sleep replay without --i-know-it-spends-quota is refused with the reason: nothing started, no replay directory, no session opened — on the daemon side too (a client that skips the command line)", async () => {
  const { handle } = await import("../src/control.ts");
  const stateDir = tmpDir("hh-replay-refused-");
  const t = makeBrain({ stateDir }, Date.UTC(2026, 10, 7, 12, 0));
  const sessions = t.driver.sessions.length;
  assert.equal(t.brain.sleepReplay(D), REFUSED);
  assert.equal(t.brain.sleepReplay(D, { flowDir: "/tmp/hh-no-such-flow" }), REFUSED);
  assert.equal(await handle(t.brain, { cmd: "sleep-replay", day: D }), REFUSED);
  assert.equal(await handle(t.brain, { cmd: "sleep-replay", day: D, iKnowItSpendsQuota: "yes" } as never), REFUSED, "只认 true");
  assert.equal(existsSync(join(stateDir, "replay")), false, "回放目录都没建");
  assert.equal(t.brain.sleepReplayStatus(), "还没回放过");
  assert.equal(t.brain.replayRunning, false);
  assert.equal(t.driver.sessions.length, sessions, "没开会话");
  await t.brain.stop();
});

test("hh sleep replay with --i-know-it-spends-quota runs with sleep.newEngine off (the replay brings its own flow dir): started from Brain, the stage session opens, the replay finishes", { timeout: 60_000 }, async () => {
  const r = await rig();
  r.cfg.sleep.newEngine = false;   // 开关明说关着：回放不看它
  const t = makeBrain({ stateDir: tmpDir("hh-replay-confirmed-") }, Date.UTC(2026, 10, 7, 12, 0));
  (t.brain as unknown as { replayDeps(): ReplayDeps }).replayDeps = () => r.deps;
  const said = t.brain.sleepReplay(D, { flowDir: r.flowDir, iKnowItSpendsQuota: true });
  const dir = /^回放开始了：(.+?)（后台跑/.exec(said)?.[1];
  assert.ok(dir, said);
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  for (let i = 0; i < 4000 && t.brain.replayRunning; i++) await sleepMs(10);
  assert.equal(t.brain.replayRunning, false);
  assert.match(t.brain.sleepReplayStatus(), /^回放 2026-11-06：跑完了/);
  assert.equal(byStageOf(dir).a!.status, "passed");
  await t.brain.stop();
});

test("replay-status and replay-stop need no confirmation and answer as before (command line and daemon side)", async () => {
  const { sleepRequest, handle } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest(["replay-status"]), { cmd: "sleep-replay-status" });
  assert.deepEqual(sleepRequest(["replay-stop"]), { cmd: "sleep-replay-stop" });
  const t = makeBrain({ stateDir: tmpDir("hh-replay-status-") }, Date.UTC(2026, 10, 7, 12, 0));
  assert.equal(await handle(t.brain, { cmd: "sleep-replay-status" }), "还没回放过");
  assert.equal(await handle(t.brain, { cmd: "sleep-replay-stop" }), "没有在跑的回放");
  await t.brain.stop();
});

/** 在流程目录里放一个切片脚本（名字随便起：HH 只认 flow.json 的 replayPrep），flow.json 写不写 replayPrep 由 prep 定 */
function withSlicer(flowDir: string, prep: string[][] | undefined, exit = 0): void {
  put(flowDir, "cut.py", [
    "import os, sys",
    "d = os.path.join('sleep', sys.argv[1], 'slices')",
    "os.makedirs(d, exist_ok=True)",
    "open(os.path.join(d, 'dialogue.md'), 'w').write('切片里的对话；OPENAI_BASE_URL=' + os.environ.get('OPENAI_BASE_URL', '') + '；KEY=[' + os.environ.get('OPENAI_API_KEY', 'unset') + ']')",
    `sys.exit(${exit})`,
  ].join("\n"));
  const flow = JSON.parse(readFileSync(join(flowDir, "flow.json"), "utf8")) as Record<string, unknown>;
  if (prep) flow.replayPrep = prep; else delete flow.replayPrep;
  writeFileSync(join(flowDir, "flow.json"), JSON.stringify(flow));
}
const CUT = [["/usr/bin/python3", "scripts/sleep_flow/cut.py", "{day}"]];

/** 跑一夜：甲段没改什么就交，返回叫醒甲段的话和回放目录 */
async function replayOnce(r: Awaited<ReturnType<typeof rig>>): Promise<{ wake: string; dir: string }> {
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  const wake = s.sent.map((m) => m.text).join("\n");
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  return { wake, dir };
}

test("replay prep: flow.json's replayPrep runs in the replay workspace before the run when the day has no slices ({day} filled, no OpenAI in its env); the stage gets the slices", { timeout: 60_000 }, async () => {
  const r = await rig();
  withSlicer(r.flowDir, CUT);
  const { wake, dir } = await replayOnce(r);
  assert.match(wake, /切片里的对话；OPENAI_BASE_URL=http:\/\/127\.0\.0\.1:9\/v1；KEY=\[\]/, "材料是切片，准备命令的子进程没有 OpenAI");
  assert.doesNotMatch(wake, /这一天的整份材料/);
  const run = r.runs.find((x) => x.args.includes("scripts/sleep_flow/cut.py"));
  assert.ok(run && run.cmd === "/usr/bin/env" && run.args.at(-1) === D && run.args.includes("/usr/bin/python3"), JSON.stringify(run));
  assert.ok(!existsSync(join(r.W, "sleep", D, "slices")), "切片写在回放的工作区，不在 W");
  const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
  assert.match(cmp, /回放的准备：\/usr\/bin\/python3 scripts\/sleep_flow\/cut\.py 2026-11-06/);
  assert.match(cmp, /切片：1 片/);
});

test("replay prep: without replayPrep nothing runs (HH knows no script names), even with a slicer in the flow dir; the stage gets the whole input.md", { timeout: 60_000 }, async () => {
  const r = await rig();
  withSlicer(r.flowDir, undefined);
  const { wake, dir } = await replayOnce(r);
  assert.match(wake, /这一天的整份材料/);
  assert.ok(!r.runs.some((x) => x.args.includes("scripts/sleep_flow/cut.py")));
  assert.doesNotMatch(readFileSync(join(dir, "out", "compare.md"), "utf8"), /回放的准备|切片：/);
});

test("replay prep: a failing replayPrep command is warned and noted in compare.md, later ones don't run, and the stages get the whole input.md", { timeout: 60_000 }, async () => {
  const r = await rig();
  withSlicer(r.flowDir, [["/usr/bin/false"], ["/usr/bin/python3", "scripts/sleep_flow/cut.py", "{day}"]]);
  const { wake, dir } = await replayOnce(r);
  assert.match(wake, /这一天的整份材料/);
  assert.ok(!r.runs.some((x) => x.args.includes("scripts/sleep_flow/cut.py")), "前一条没跑成，后面的不跑");
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /回放的准备「\/usr\/bin\/false」没跑成（退出码 1），材料给整份 input\.md/);
  assert.ok(r.logs.some((l) => l.msg === "replay: a replayPrep command failed, stages get the whole input.md" && l.level === "warn"));
});

test("parseFlow: replayPrep is a list of non-empty argv string arrays; absent means no key (the flow and its hash unchanged)", () => {
  const known = { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) };
  const stages = [{ id: "a", title: "甲", kind: "agent", skill: "a.md", writes: ["memory/a.md"] }];
  assert.deepEqual(parseFlow({ stages, replayPrep: CUT }, known).replayPrep, CUT);
  assert.deepEqual(parseFlow({ stages, replayPrep: [] }, known).replayPrep, []);
  assert.equal("replayPrep" in parseFlow({ stages }, known), false);
  for (const bad of ["x", [["x", 1]], [[]], [["python3", ""]], [{ cmd: "x" }], ["python3 x.py"]]) {
    assert.throws(() => parseFlow({ stages, replayPrep: bad }, known), (e: unknown) => e instanceof FlowError && e.problems.some((p) => p.includes("replayPrep")), JSON.stringify(bad));
  }
});

test("replay runs the same team as a real night (assembleNight + teamParts): the persona does the stage, another persona reviews, the coordinator is coord-replay-<day>; the ledger has persona/reviewer/decision", { timeout: 60_000 }, async () => {
  const r = await rig();
  const flow = JSON.parse(readFileSync(join(r.flowDir, "flow.json"), "utf8")) as Record<string, unknown> & { stages: Array<Record<string, unknown>> };
  flow.personasFile = "personas.json";
  flow.coordinator = { model: "sonnet" };
  flow.stages[1] = { ...flow.stages[1], persona: "a", region: "海马" };
  writeFileSync(join(r.flowDir, "flow.json"), JSON.stringify(flow));
  put(r.flowDir, "personas.json", JSON.stringify({ a: { name: "阿甲", text: "细心的那个你" }, b: { name: "阿乙", text: "挑剔的那个你" } }));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  assert.match(s.sent.map((m) => m.text).join("\n"), /阿甲/, "做这一段的是阿甲");
  put(join(dir, "ws"), `sleep/${D}/proposed/memory/a.md`, "第一行改了\n第二行\n");
  await s.play(handIn("甲改了 a", { changes: [{ target: "memory/a.md", op: "change", before: "第一行", after: "第一行改了", evidence: ["#1"], why: "说过" }] }));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  const review = await opened(r.driver, `review-${D}-a-1-1`);
  assert.match(review.sent.map((m) => m.text).join("\n"), /阿乙/, "审的是另一个性格");
  await review.play({ tool: { name: "review_done", args: { verdict: "pass", problems: [] } } });
  const coord = await opened(r.driver, `coord-replay-${D}`);
  await coord.play({ tool: { name: "coordinate", args: { decision: "pass", why: "都过了" } } });
  await done;
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st.phase, "done", st.error ?? "");
  const a = (JSON.parse(readFileSync(join(dir, "out", "ledger.json"), "utf8")) as { sleep_stage: Array<Record<string, unknown>> }).sleep_stage.find((x) => x.stage === "a")!;
  assert.equal(a.status, "passed");
  assert.equal(a.persona, "a");
  assert.equal(a.reviewer, "b");
  assert.equal(a.region, "海马");
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /\| a \| 海马 \| a \| passed \| 1 \| b \|/);
});

// ---------- 复审第 1 轮（opus review） ----------
import { OpenAIDecisions } from "../src/learning/decisions.ts";

test("review #1: a stage session's env points OPENCLAW_WORKSPACE at the replay workspace (an allowlisted script never finds her real W) and has no OpenAI", { timeout: 60_000 }, async () => {
  const r = await rig();
  // 最终评审 M1：这个名字不在 HH 代码和默认配置里，在部署自己的配置的 sleep.workspaceEnv 里（她的 config.json 没写 kernel.env）
  assert.deepEqual(r.cfg.sleep.workspaceEnv, ["OPENCLAW_WORKSPACE"]);
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  assert.equal(s.spec.env?.OPENCLAW_WORKSPACE, join(dir, "ws"));
  assert.equal(s.spec.env?.OPENAI_API_KEY, "");
  await s.play(handIn("没改什么"));
  const a = await opened(r.driver, `audit-${D}-a-1-1`);
  assert.equal(a.spec.env?.OPENCLAW_WORKSPACE, join(dir, "ws"), "核依据的会话也是");
  await a.play(AUDIT_PASS);
  await done;
});

test("review #2: OpenAI clients built BEFORE the guard (like hhd's live embedder and judge) are blocked and counted inside a replay; outside they still reach fetch", async () => {
  const seen: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (u: unknown) => { seen.push(String(u)); return new Response(JSON.stringify({ data: [{ embedding: [1], index: 0 }] })); }) as typeof fetch;
  const live = new OpenAIEmbedder({ key: "sk-live" });   // hhd 启动时建的
  const judge = new OpenAIDecisions({ key: "sk-live", db: openDb(":memory:"), tz: "UTC", dailyUsd: 1 });
  const guard = new OpenAIGuard(() => {});
  const off = installOpenAIGuard();
  try {
    await guard.run(async () => {
      assert.equal(await live.embed(["x"]), null);
      assert.equal(await judge.judge("一句话", [{ name: "p1", text: "一页" }]), null);
    });
    assert.equal(guard.blocked, 2, "两个都被拦下、计数");
    assert.deepEqual(seen, [], "一个请求都没出去");
    await live.embed(["y"]);
    assert.deepEqual(seen, ["https://api.openai.com/v1/embeddings"], "回放外面照常");
  } finally { off(); globalThis.fetch = real; }
});

test("review #3: no-openai.txt claims only what it proves — the verdict is the guard count; the copy's learn.spend is unchanged by construction; the live one is informational", { timeout: 60_000 }, async () => {
  const r = await rig();
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  kvSet(r.live, `learn.spend.${D}`, "9999");   // 她白天的系统在回放期间花了
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  const t = readFileSync(join(dir, "out", "no-openai.txt"), "utf8");
  assert.match(t, /^verdict: PASS — the guard blocked 0 api\.openai\.com requests from the replay \(PASS only if 0\)$/m);
  assert.match(t, /learn\.spend, replay copy db .*unchanged by construction/);
  assert.match(t, /learn\.spend, live db: informational \(her live system may spend while awake\): before 1 个 key，共 1234 tokens; after 1 个 key，共 9999 tokens/);
  assert.doesNotMatch(t, /equal: NO|FAIL/, "她白天花的不算回放的");
});

test("review #4: hh sleep replay-stop aborts a running replay and shuts its sessions; with nothing running it says so", { timeout: 60_000 }, async () => {
  const r = await rig();
  const m = new ReplayManager();
  assert.equal(await m.stop("手动停了"), "没有在跑的回放");
  const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  assert.equal(m.running, true);
  assert.match(await m.stop("手动停了"), /停了/);
  await done;
  assert.equal(m.running, false);
  assert.ok(s.closed, "开着的会话关掉了");
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; notes: string[] };
  assert.equal(st.phase, "aborted");
  assert.ok(st.notes.some((n) => n.includes("手动停了")), JSON.stringify(st.notes));
  assert.match(m.status(r.stateDir, Date.now()), /中止了[\s\S]*手动停了/);
  const { sleepRequest } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest(["replay-stop"]), { cmd: "sleep-replay-stop" });
});

test("review #4: the real night starting stops a running replay first, with a log line", async () => {
  const t = makeBrain({ stateDir: tmpDir("hh-replay-night-") }, Date.UTC(2026, 9, 29, 2, 30));
  const calls: string[] = [];
  (t.brain as unknown as { replays: { running: boolean; stop(why: string): Promise<string> } }).replays = {
    running: true,
    stop: async (why: string) => { calls.push(why); return "停了"; },
  } as never;
  await t.brain.sleep("夜里", "night");
  await flush();
  assert.deepEqual(calls, ["真的夜里开始了"]);
  assert.ok(t.logs.some((l) => l.msg === "sleep: the real night starts, stopping the running replay"));
  calls.length = 0;
  await t.brain.stop();
  assert.equal(await t.brain.sleepReplayStop(), "停了");
});

test("review #5: a failed or aborted replay still writes compare.md, report.md, ledger.json and records/ with what exists, marked 回放没跑完", { timeout: 60_000 }, async () => {
  const r = await rig();
  const m = new ReplayManager();
  const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir });
  await opened(r.driver, `sleep-${D}-a-1`);
  await m.stop("手动停了");
  await done;
  for (const f of ["compare.md", "report.md", "ledger.json"]) assert.match(readFileSync(join(dir, "out", f), "utf8"), /回放没跑完/, f);
  assert.ok(existsSync(join(dir, "out", "records")), "records/ 也在（有什么放什么）");
  // 停在拷库之前（git 不成）：也写，照样标
  const r2 = await rig({ run: async () => ({ code: 128, stdout: "", stderr: "不是 git 仓库" }) });
  const two = new ReplayManager().start(r2.deps, { day: D, flowDir: r2.flowDir });
  await two.done;
  for (const f of ["compare.md", "report.md", "ledger.json"]) assert.match(readFileSync(join(two.dir, "out", f), "utf8"), /回放没跑完/, f);
  assert.match(readFileSync(join(two.dir, "out", "no-openai.txt"), "utf8"), /no copy made/);
});

test("review #5: with no legacy batch in the store compare.md says so plainly; a copy made but failing later is not reported as 'no copy made'", { timeout: 60_000 }, async () => {
  const r = await rig();
  r.live.prepare("UPDATE mem_batch SET id = 'something-else' WHERE id = ?").run(`night:${D}/${D}`);
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /没找到老整理那一批，没撤任何东西/);
  // 拷了库、之后出错（流程用不了）：no-openai.txt 不能说没拷
  const r3 = await rig();
  writeFileSync(join(r3.flowDir, "flow.json"), "{ 坏的");
  const three = new ReplayManager().start(r3.deps, { day: D, flowDir: r3.flowDir });
  await three.done;
  const t = readFileSync(join(three.dir, "out", "no-openai.txt"), "utf8");
  assert.doesNotMatch(t, /no copy made/);
  assert.match(t, /learn\.spend, replay copy db .*1 个 key，共 1234 tokens/);
});

// ---------- 最终评审修正（final review I3 / M1）----------

/** 跑一夜：finish 前加一个核对脚本、带切片的准备命令；返回段的会话、核对脚本和准备命令的 env（KEY=VALUE 那几个参数） */
async function replayWithChildren(r: Awaited<ReturnType<typeof rig>>): Promise<{ dir: string; session: Record<string, string>; check: string[]; prep: string[] }> {
  withSlicer(r.flowDir, CUT);
  const flow = JSON.parse(readFileSync(join(r.flowDir, "flow.json"), "utf8")) as { stages: Array<Record<string, unknown>> };
  flow.stages.splice(2, 0, { id: "check", title: "核对", kind: "script", command: ["true"], after: ["a"] });
  flow.stages[3]!.after = ["check"];
  writeFileSync(join(r.flowDir, "flow.json"), JSON.stringify(flow));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  const session = { ...(s.spec.env ?? {}) } as Record<string, string>;
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  const envOf = (x: { args: readonly string[] } | undefined): string[] => (x ? x.args.filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(a))).map(String) : []);
  const check = envOf(r.runs.find((x) => x.cmd === "/usr/bin/env" && x.args.includes("true")));
  const prep = envOf(r.runs.find((x) => x.args.includes("scripts/sleep_flow/cut.py")));
  return { dir, session, check, prep };
}

test("final I3: child processes (stage sessions, check scripts, replayPrep) get HH_CONFIG pointing at a replay-only config whose stateDir is the replay's own; no-openai.txt says child requests are not counted", { timeout: 60_000 }, async () => {
  const r = await rig();
  const { dir, session, check, prep } = await replayWithChildren(r);
  const file = join(dir, "state", "config.json");
  assert.equal(session.HH_CONFIG, file, "段的会话");
  assert.ok(check.includes(`HH_CONFIG=${file}`), JSON.stringify(check));
  assert.ok(prep.includes(`HH_CONFIG=${file}`), JSON.stringify(prep));
  const c = JSON.parse(readFileSync(file, "utf8")) as { stateDir: string; workspace: string; tools?: { sendDryRun?: boolean } };
  assert.equal(c.stateDir, join(dir, "state"));
  assert.notEqual(c.stateDir, r.stateDir, "不是真的 stateDir（hh 连不上真的 hhd）");
  assert.equal(c.workspace, join(dir, "ws"));
  assert.equal(c.tools?.sendDryRun, true, "子进程里的 hh send 只演习");
  const full = c as unknown as Config;
  assert.equal(full.id, r.deps.cfg.id, "名字、语言、时区这些照母配置带着（不是三个键）");
  assert.equal(full.schedule.timezone, r.deps.cfg.schedule.timezone);
  assert.equal(full.learning.enabled, false, "学习的联想关掉");
  assert.equal(full.browser.chrome, "", "没有浏览器程序");
  // 照 HH_CONFIG 读出来（跟 hh 命令行一样 deepMerge 默认值）：socket 在回放目录下
  const prev = process.env.HH_CONFIG;
  process.env.HH_CONFIG = file;
  try { assert.equal(loadConfig().stateDir, join(dir, "state")); } finally { if (prev === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = prev; }
  const noAI = readFileSync(join(dir, "out", "no-openai.txt"), "utf8");
  assert.match(noAI, /^子进程发的请求（段的会话里的 Bash、核对脚本、准备命令）闸不算：它们跑的时候 OpenAI 的环境变量清空、HH_CONFIG 指到回放自己的 state（.+）$/m);
});

test("final M1: no platform env name in replay code — kernel.env entries equal to the workspace, and sleep.workspaceEnv names, point at ws in every child", { timeout: 60_000 }, async () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "sleep", "replay.ts"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.doesNotMatch(code, /OPENCLAW/, "非注释代码里没有平台的环境变量名");
  const r = await rig();
  r.deps.cfg = {
    ...r.cfg,
    kernel: { ...r.cfg.kernel, env: { AGENT_HOME: r.W, AGENT_HOME_SLASH: `${r.W}/`, OTHER: "/elsewhere" } },
    sleep: { ...r.cfg.sleep, workspaceEnv: ["WS_ROOT"] },
  };
  const { dir, session, check, prep } = await replayWithChildren(r);
  const ws = join(dir, "ws");
  assert.equal(session.AGENT_HOME, ws, "kernel.env 里值是工作区的");
  assert.equal(session.AGENT_HOME_SLASH, ws, "路径规范化以后相等的也算");
  assert.equal(session.OTHER, "/elsewhere", "别的不动");
  assert.equal(session.WS_ROOT, ws, "sleep.workspaceEnv 点名的");
  for (const env of [check, prep]) {
    assert.ok(env.includes(`WS_ROOT=${ws}`), JSON.stringify(env));
    assert.ok(env.includes(`AGENT_HOME=${ws}`), JSON.stringify(env));
    assert.ok(!env.some((e) => e.startsWith("OTHER=")), JSON.stringify(env));
  }
  // 没配（两条规则都没东西）：修正第 2 轮 N1 起回放不开跑，见「fix2 N1」
});

// ---------- 最终评审修正（final review I4）----------

test("final I4: a replay stop() that throws still lets the real night proceed, with a warn", async () => {
  const t = makeBrain({ stateDir: tmpDir("hh-replay-night-") }, Date.UTC(2026, 9, 29, 2, 30));
  const calls: string[] = [];
  (t.brain as unknown as { replays: { running: boolean; stop(why: string): Promise<string> } }).replays = {
    running: true,
    stop: async () => { throw new Error("停不下来"); },
  } as never;
  const b = t.brain as unknown as { pauseBackgroundsForNight(): Promise<void> };
  const pause = b.pauseBackgroundsForNight.bind(t.brain);
  b.pauseBackgroundsForNight = async () => { calls.push("paused"); await pause(); };
  await t.brain.sleep("夜里", "night");
  await flush();
  assert.deepEqual(calls, ["paused"], "照样往下走（睡前那几步、整理）");
  const warn = t.logs.find((l) => l.msg === "sleep: stopping the replay failed");
  assert.ok(warn, "记一句 warn");
  assert.match(JSON.stringify(warn), /停不下来/);
  (t.brain as unknown as { replays: { running: boolean; stop(why: string): Promise<string> } }).replays = { running: false, stop: async () => "没有" } as never;
  await t.brain.stop();
});

// ---------- replayOverlay：flow 目录所在的仓库里几个新版的脚本盖到回放的工作区 ----------

/** 她的 worktree 样子的 git 仓库：scripts/sleep_flow/ 是 rig 的流程目录，另加 files；返回仓库根和流程目录 */
async function flowRepo(r: Awaited<ReturnType<typeof rig>>, overlay: string[], files: Record<string, string>): Promise<{ repo: string; flowDir: string }> {
  const repo = join(r.tmp, "mira-wt");
  const flowDir = join(repo, "scripts", "sleep_flow");
  mkdirSync(flowDir, { recursive: true });
  for (const n of ["flow.json", "common.md", "stages/a.md"]) put(flowDir, n, readFileSync(join(r.flowDir, n), "utf8"));
  const flow = JSON.parse(readFileSync(join(flowDir, "flow.json"), "utf8")) as Record<string, unknown>;
  flow.replayOverlay = overlay;
  writeFileSync(join(flowDir, "flow.json"), JSON.stringify(flow));
  for (const [p, t] of Object.entries(files)) put(repo, p, t);
  await gitIn(repo, "init", "-q");
  return { repo, flowDir };
}

test("replayOverlay: a listed file from the flow dir's repo lands in ws (W untouched), is not counted as a replay change, and compare.md lists it", { timeout: 60_000 }, async () => {
  const r = await rig();
  put(r.W, "scripts/tool.py", "print('旧版')\n");
  await gitIn(r.W, "add", "-A");
  await gitIn(r.W, "commit", "-q", "-m", "日记 11-07：工具");
  const wBefore = treeHash(r.W);
  const { flowDir } = await flowRepo(r, ["scripts/tool.py", "scripts/lib/new.py"], { "scripts/tool.py": "print('新版')\n", "scripts/lib/new.py": "X = 1\n" });
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  const ws = join(dir, "ws");
  // 段开始的时候就已经盖好了（在准备命令和段之前）
  assert.equal(readFileSync(join(ws, "scripts", "tool.py"), "utf8"), "print('新版')\n");
  assert.equal(readFileSync(join(ws, "scripts", "lib", "new.py"), "utf8"), "X = 1\n");
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  assert.equal(treeHash(r.W), wBefore, "W 一个字节都没变");
  assert.equal(readFileSync(join(r.W, "scripts", "tool.py"), "utf8"), "print('旧版')\n");
  const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
  assert.match(cmp, /^- 回放用了新版的脚本（不算回放的改动）：scripts\/tool\.py、scripts\/lib\/new\.py$/m);
  assert.doesNotMatch(cmp, /\| scripts\/tool\.py \|/, "不算进文件的改动");
  assert.doesNotMatch(readFileSync(join(dir, "out", "replay.patch"), "utf8"), /tool\.py/);
});

test("replayOverlay: a missing file, a symlink, or a flow dir outside any git repo gives a note and a warn, not an abort", { timeout: 60_000 }, async () => {
  const r = await rig();
  const { repo, flowDir } = await flowRepo(r, ["scripts/gone.py", "scripts/link.py", "scripts/ok.py"], { "scripts/ok.py": "ok\n" });
  put(r.tmp, "outside.py", "外面的\n");
  symlinkSync(join(r.tmp, "outside.py"), join(repo, "scripts", "link.py"));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st.phase, "done", st.error ?? "");
  const ws = join(dir, "ws");
  assert.ok(!existsSync(join(ws, "scripts", "gone.py")));
  assert.ok(!existsSync(join(ws, "scripts", "link.py")), "链接不盖");
  assert.equal(readFileSync(join(ws, "scripts", "ok.py"), "utf8"), "ok\n");
  const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
  assert.match(cmp, /回放要用的新版脚本 scripts\/gone\.py 在 .* 里没有，没盖上/);
  assert.match(cmp, /回放要用的新版脚本 scripts\/link\.py 是链接，没盖上/);
  assert.match(cmp, /^- 回放用了新版的脚本（不算回放的改动）：scripts\/ok\.py$/m);
  assert.equal(r.logs.filter((l) => l.msg === "replay: an overlay file was not copied" && l.level === "warn").length, 2);

  // 流程目录不在 git 仓库里（rig 的流程目录就是）：记一句，照跑
  const r2 = await rig();
  const flow = JSON.parse(readFileSync(join(r2.flowDir, "flow.json"), "utf8")) as Record<string, unknown>;
  flow.replayOverlay = ["scripts/x.py"];
  writeFileSync(join(r2.flowDir, "flow.json"), JSON.stringify(flow));
  const two = await replayOnce(r2);
  const st2 = JSON.parse(readFileSync(join(two.dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st2.phase, "done", st2.error ?? "");
  assert.match(readFileSync(join(two.dir, "out", "compare.md"), "utf8"), /流程目录 .* 不在 git 仓库里，replayOverlay 的文件都没盖上/);
  assert.ok(r2.logs.some((l) => l.msg === "replay: the flow dir is not in a git checkout, replayOverlay skipped" && l.level === "warn"));
});

test("parseFlow: replayOverlay is a list of workspace-relative paths — no absolute, no .., no leading ./ or trailing /; absent means no key", () => {
  const known = { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) };
  const stages = [{ id: "a", title: "甲", kind: "agent", skill: "a.md", writes: ["memory/a.md"] }];
  assert.deepEqual(parseFlow({ stages, replayOverlay: ["scripts/a.py", "scripts/lib/b.py"] }, known).replayOverlay, ["scripts/a.py", "scripts/lib/b.py"]);
  assert.deepEqual(parseFlow({ stages, replayOverlay: [] }, known).replayOverlay, []);
  assert.equal("replayOverlay" in parseFlow({ stages }, known), false);
  for (const bad of ["scripts/a.py", [1], [""], ["/etc/passwd"], ["../x.py"], ["scripts/../../x.py"], ["./scripts/a.py"], ["scripts/"], ["scripts/./a.py"]]) {
    assert.throws(() => parseFlow({ stages, replayOverlay: bad }, known), (e: unknown) => e instanceof FlowError && e.problems.some((p) => p.includes("replayOverlay")), JSON.stringify(bad));
  }
});

// ---------- 最终评审修正（final review M7）----------

test("final M7: a failing status.json write and a failing shut() each log one warn per replay instead of being swallowed", { timeout: 60_000 }, async () => {
  const r = await rig();
  const m = new ReplayManager();
  const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  // status.json 写不了（换成一个目录）；收摊抛错
  rmSync(join(dir, "status.json"));
  mkdirSync(join(dir, "status.json"));
  const run = (m as unknown as { cur: { hosts: { shut(): Promise<void> } | null } }).cur;
  const shut = run.hosts!.shut.bind(run.hosts);
  run.hosts!.shut = async () => { await shut(); throw new Error("收不了摊"); };
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  const warns = (msg: string) => r.logs.filter((l) => l.msg === msg && l.level === "warn");
  assert.equal(warns("replay: writing status.json failed").length, 1, "写了好几次，只记一次");
  assert.equal(warns("replay: shutting the replay's sessions failed").length, 1);
  assert.match(JSON.stringify(warns("replay: shutting the replay's sessions failed")[0]), /收不了摊/);
});

// ---------- 修正第 2 轮（re-review N1 / m1）----------

test("fix2 N1: with no sleep.workspaceEnv and no kernel.env entry equal to the workspace the replay fails closed — no prep, no stage session; replay-status says why", { timeout: 60_000 }, async () => {
  const r = await rig();
  withSlicer(r.flowDir, CUT);
  r.deps.cfg = { ...r.cfg, kernel: { ...r.cfg.kernel, env: { OTHER: "/elsewhere" } }, sleep: { ...r.cfg.sleep, workspaceEnv: [] } };
  const m = new ReplayManager();
  const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir });
  await done;
  const why = "回放不知道子进程按哪个环境变量找工作区：配置里写 sleep.workspaceEnv（或 kernel.env 里写工作区的路径）";
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st.phase, "failed");
  assert.equal(st.error, why);
  assert.ok(m.status(r.stateDir, Date.now()).includes(why), m.status(r.stateDir, Date.now()));
  assert.deepEqual(r.driver.sessions.map((s) => s.id), [], "一个会话都没开");
  assert.ok(!r.runs.some((x) => x.args.includes("scripts/sleep_flow/cut.py")), "准备命令没跑");
  assert.ok(!existsSync(join(dir, "hh.db")), "库都没拷");
  // 没写这个键的 sleep 配置（undefined）也一样
  const r2 = await rig();
  const { workspaceEnv: _drop, ...noKey } = r2.cfg.sleep;
  r2.deps.cfg = { ...r2.cfg, sleep: noKey };
  const two = new ReplayManager().start(r2.deps, { day: D, flowDir: r2.flowDir });
  await two.done;
  assert.equal((JSON.parse(readFileSync(join(two.dir, "status.json"), "utf8")) as { error: string }).error, why);
});

/** W 里提交一个指到外面（r.tmp/outside）的目录链接，返回那个提交（做基准）和外面的目录 */
async function linkOut(r: Awaited<ReturnType<typeof rig>>, name: string): Promise<{ base: string; outside: string }> {
  const outside = join(r.tmp, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(r.W, name));
  await gitIn(r.W, "add", "-A");
  await gitIn(r.W, "commit", "-q", "-m", "日记 11-07：一个目录链接");
  return { base: await gitIn(r.W, "rev-parse", "HEAD"), outside };
}

test("fix2 m1: an overlay path below a directory symlink committed in W (pointing outside ws) is refused before any directory is made outside", { timeout: 60_000 }, async () => {
  const r = await rig();
  // 基准提交里有一个指到外面的目录链接（像 review 的 probe.mjs）
  const { base, outside } = await linkOut(r, "tools");
  const { flowDir } = await flowRepo(r, ["tools/lib/x.py"], { "tools/lib/x.py": "X = 1\n" });
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir, base });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  await s.play(handIn("没改什么"));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await done;
  assert.ok(!existsSync(join(outside, "lib")), "外面一个目录都没建");
  assert.deepEqual(readdirSync(outside), []);
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /回放要用的新版脚本 tools\/lib\/x\.py 要拷到回放的工作区外面，没盖上/);
});

test("fix2 m1: the flow dir under a committed directory symlink pointing outside ws stops the replay before anything is removed or copied there", { timeout: 60_000 }, async () => {
  // 那一天的材料目录（sleep/<日>）用的是同一个检查（staysInWs）；W 里 sleep/ 是真目录，这里只搭流程目录的
  for (const name of ["scripts"]) {
    const r = await rig();
    const { base, outside } = await linkOut(r, name);
    put(outside, "keep.txt", "外面的东西\n");
    if (name === "scripts") put(outside, "sleep_flow/flow.json", "外面的流程\n");
    const before = readdirSync(outside).sort();
    const m = new ReplayManager();
    const { dir, done } = m.start(r.deps, { day: D, flowDir: r.flowDir, base });
    await done;
    const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
    assert.equal(st.phase, "failed", name);
    assert.match(st.error ?? "", /经链接指到工作区外面/, name);
    assert.deepEqual(readdirSync(outside).sort(), before, `${name}：外面的没删、没多`);
    if (name === "scripts") assert.equal(readFileSync(join(outside, "sleep_flow", "flow.json"), "utf8"), "外面的流程\n");
    assert.deepEqual(r.driver.sessions.map((s) => s.id), [], name);
  }
});

test("fix2 m1: parseFlow rejects a .git segment in replayOverlay", () => {
  const known = { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) };
  const stages = [{ id: "a", title: "甲", kind: "agent", skill: "a.md", writes: ["memory/a.md"] }];
  for (const bad of [[".git/hooks/pre-commit"], ["sub/.git/config"], [".GIT/hooks/post-checkout"]]) {
    assert.throws(() => parseFlow({ stages, replayOverlay: bad }, known), (e: unknown) => e instanceof FlowError && e.problems.some((p) => p.includes("replayOverlay")), JSON.stringify(bad));
  }
  assert.deepEqual(parseFlow({ stages, replayOverlay: [".gitignore", "scripts/.github/x.yml"] }, known).replayOverlay, [".gitignore", "scripts/.github/x.yml"]);
});

// ---------- 修正第 2 轮（re-review m2）：compare.md 的协调一栏 ----------

test("fix2 m2: in a replay, a coordinator polish skipped at the cap shows as not done in compare.md's 协调 column", { timeout: 60_000 }, async () => {
  const r = await rig();
  const flow = JSON.parse(readFileSync(join(r.flowDir, "flow.json"), "utf8")) as Record<string, unknown> & { stages: Array<Record<string, unknown>> };
  flow.personasFile = "personas.json";
  flow.coordinator = { model: "sonnet", maxPolish: 0 };   // 一次都不打磨
  flow.stages[1] = { ...flow.stages[1], persona: "a", region: "海马" };
  writeFileSync(join(r.flowDir, "flow.json"), JSON.stringify(flow));
  put(r.flowDir, "personas.json", JSON.stringify({ a: { name: "阿甲", text: "细心的那个你" }, b: { name: "阿乙", text: "挑剔的那个你" } }));
  const { dir, done } = new ReplayManager().start(r.deps, { day: D, flowDir: r.flowDir });
  const s = await opened(r.driver, `sleep-${D}-a-1`);
  put(join(dir, "ws"), `sleep/${D}/proposed/memory/a.md`, "第一行改了\n第二行\n");
  await s.play(handIn("甲改了 a", { changes: [{ target: "memory/a.md", op: "change", before: "第一行", after: "第一行改了", evidence: ["#1"], why: "说过" }] }));
  await (await opened(r.driver, `audit-${D}-a-1-1`)).play(AUDIT_PASS);
  await (await opened(r.driver, `review-${D}-a-1-1`)).play({ tool: { name: "review_done", args: { verdict: "pass", problems: [] } } });
  await (await opened(r.driver, `coord-replay-${D}`)).play({ tool: { name: "coordinate", args: { decision: "redo", why: "再补一句原话" } } });
  await done;
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st.phase, "done", st.error ?? "");
  assert.ok(!r.driver.sessions.some((x) => x.id === `sleep-${D}-a-2`), "打磨没开");
  assert.match(readFileSync(join(dir, "out", "compare.md"), "utf8"), /\| a \| 海马 \| a \| passed \| 1 \| b \| coord:polish（没做：上限） \|/);
});

// ---------- 回放子进程的配置：完整、自己的 state、碰不到活的这一边 ----------

const FAKE_KEY = "sk-fake-0000-replay-child-test";

/** rig 的配置上盖一层：对象逐字段合，数组整个换（跟 loadConfig 一个规矩），再解析一遍路径 */
const resolvedParent = (base: Config, over: unknown): Config => loadConfig(deepMerge(structuredClone(base) as unknown, over));

/** 带满各种路径的母配置：W、S 下面的各种写法、W 和 S 以外的一个、闸门和名字、联想开着、活的浏览器 */
function parentOf(r: Awaited<ReturnType<typeof rig>>): Config {
  const { W, stateDir: S } = r;
  mkdirSync(S, { recursive: true });
  writeFileSync(join(S, "secrets.json"), JSON.stringify({ openaiKey: FAKE_KEY }));
  return resolvedParent(r.cfg, {
    workspace: W, stateDir: S,
    skills: { roots: [join(W, "skills"), join(r.tmp, "elsewhere", "skills")], names: ["木工"], discover: join(W, "skills", "extra") },
    learning: { root: join(W, "skills"), enabled: true, inject: true },
    gate: { enabled: true, card: { soul: [join(W, "SOUL.md")] } },
    names: { me: "阿青", owner: "老林", notMe: ["小禾"] },
    kernel: { env: { AGENT_HOME: W, OTHER: "/elsewhere" }, mcpServers: { x: { type: "stdio", command: join(W, "plugins", "x", "bin", "x-mcp"), args: [join(S, "x.sock")] } } },
    sleep: { wakeRefresh: ["/usr/bin/python3", join(W, "scripts", "wake.py"), "--db", join(S, "hh.db")] },
    tools: { sendDryRun: false },
    modules: { helpers: { sessionsDir: join(r.tmp, "cc") } },
    browser: { chrome: "/opt/live/chrome", userDataDir: join(S, "browser-live"), port: 18999 },
    id: "aqing", writingLanguage: "中文", lang: "zh",
  });
}

/** 字符串树里所有的字符串（键不算） */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}
const within = (p: string, root: string): boolean => p === root || p.startsWith(root + "/");

/** 跑一夜，返回回放目录和写出来的子进程配置 */
async function childConfigOf(r: Awaited<ReturnType<typeof rig>>, parent: Config): Promise<{ dir: string; file: string; child: Config }> {
  r.deps.cfg = parent;
  const { dir } = await replayWithChildren(r);
  const file = join(dir, "state", "config.json");
  return { dir, file, child: JSON.parse(readFileSync(file, "utf8")) as Config };
}

/** 在 HH_CONFIG 指到 file 的环境里做 fn，用完还原 */
async function withHhConfig<T>(file: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = process.env.HH_CONFIG;
  process.env.HH_CONFIG = file;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = prev; }
}

test("child config 1: no string in it points into the live workspace or the live state dir — only into the replay's own; a path outside both is unchanged", { timeout: 60_000 }, async () => {
  const r = await rig();
  const parent = parentOf(r);
  const { dir, child } = await childConfigOf(r, parent);
  const W = resolve(r.W), S = resolve(r.stateDir);
  const all = strings(child);
  assert.ok(all.length > 20, "the walk saw the tree");
  for (const s of all) {
    assert.ok(!within(s, W), `into the live workspace: ${s}`);
    if (within(s, S)) assert.ok(within(s, dir), `into the live state dir, outside the replay: ${s}`);
  }
  assert.deepEqual(child.skills.roots, [join(dir, "ws", "skills"), join(r.tmp, "elsewhere", "skills")]);
  assert.equal(child.skills.discover, join(dir, "ws", "skills", "extra"));
  assert.equal(child.learning.root, join(dir, "ws", "skills"));
  assert.deepEqual(child.gate.card.soul, [join(dir, "ws", "SOUL.md")]);
  assert.equal(child.kernel.mcpServers.x === undefined, true, "mcpServers is emptied (see test 2), nothing left to point anywhere");
  assert.deepEqual(child.sleep.wakeRefresh, ["/usr/bin/python3", join(dir, "ws", "scripts", "wake.py"), "--db", join(dir, "state", "hh.db")]);
  assert.equal(child.modules?.helpers?.sessionsDir, join(r.tmp, "cc"), "outside both roots: unchanged");
  assert.equal(child.workspace, join(dir, "ws"));
  assert.equal(child.stateDir, join(dir, "state"));
  // 母配置没被改（拷了一份）
  assert.equal(parent.workspace, r.W);
  assert.equal(parent.learning.enabled, true);
});

test("child config 2: no OpenAI — learning off, kernel.env empty, no key reachable from the child's stateDir, the key string is not in the file", { timeout: 60_000 }, async () => {
  const r = await rig();
  const parent = parentOf(r);
  assert.equal(loadOpenAIKey(parent.stateDir), FAKE_KEY, "fixture: the live state dir does hold a key");
  const { file, child } = await childConfigOf(r, parent);
  assert.equal(child.learning.enabled, false);
  assert.equal(child.learning.inject, false);
  assert.deepEqual(child.kernel.env, {});
  assert.deepEqual(child.kernel.mcpServers, {});
  assert.equal(loadOpenAIKey(child.stateDir), null);
  assert.ok(!readFileSync(file, "utf8").includes(FAKE_KEY));
  // 照 loadConfig 读出来也一样：空对象不会被默认值的键补回来（默认值里这两个也是空的）
  await withHhConfig(file, () => {
    const back = loadConfig();
    assert.equal(back.learning.enabled, false);
    assert.equal(back.learning.inject, false);
    assert.deepEqual(back.kernel.env, {});
    assert.deepEqual(back.kernel.mcpServers, {});
  });
});

test("child config 3: outward channels — send only rehearses (gateway untouched), the browser has no program, no port, and a profile under the replay's state", { timeout: 60_000 }, async () => {
  const r = await rig();
  const parent = parentOf(r);
  assert.equal(parent.tools.sendDryRun, false);
  const { dir, file } = await childConfigOf(r, parent);
  await withHhConfig(file, async () => {
    const cfg = loadConfig();
    requireInstance(cfg);
    assert.equal(cfg.tools.sendDryRun, true);
    const calls: string[] = [];
    const gateway = { connected: true, request: async (method: string) => { calls.push(method); return {}; } };
    const out = await sendCommand(cfg, ["老林", "在吗"], { gateway: gateway as never });
    assert.match(out, /^（模拟发送）/);
    assert.deepEqual(calls, [], "the gateway received no call");
    assert.equal(cfg.browser.chrome, "");
    assert.equal(cfg.browser.port, 0);
    assert.equal(cfg.browser.userDataDir, join(dir, "state", "browser"));
    const chrome = new Chrome({ ...cfg.browser, shotsDir: join(cfg.stateDir, "shots") });
    await assert.rejects(chrome.connect(), (e: Error) => e.message === P.BROWSER_OFF);
    assert.ok(!existsSync(cfg.browser.userDataDir), "nothing was launched, not even its profile directory");
    assert.deepEqual(await browserCommand(cfg, ["status"]), { running: false });
  });
});

test("child config 4: the start-up check lets the child through (names, timezone, lang kept); `hh learn ids` fails where it fails today — no daemon socket", { timeout: 60_000 }, async () => {
  const r = await rig();
  const parent = parentOf(r);
  assert.equal(parent.lang, "zh");
  const { dir, file } = await childConfigOf(r, parent);
  await withHhConfig(file, () => {
    const cfg = loadConfig();
    assert.equal(cfg.gate.enabled, true);
    assert.doesNotThrow(() => requireInstance(cfg));
    assert.deepEqual(cfg.names, parent.names);
    assert.equal(cfg.schedule.timezone, parent.schedule.timezone);
    assert.equal(cfg.lang, parent.lang);
    assert.equal(cfg.id, "aqing");
  });
  const cli = join(import.meta.dirname, "..", "src", "cli.ts");
  const run = await new Promise<{ code: number | null; stderr: string }>((res) => {
    execFile(process.execPath, [cli, "learn", "ids"], { env: { PATH: process.env.PATH ?? "", HH_CONFIG: file }, timeout: 30_000 }, (err, _o, stderr) => {
      res({ code: err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0, stderr: String(stderr) });
    });
  });
  assert.equal(run.code, 1, run.stderr);
  assert.doesNotMatch(run.stderr, /config:/, "not stopped by requireInstance");
  assert.match(run.stderr, /ENOENT/);
  assert.ok(run.stderr.includes(join(dir, "state", "hh.sock")), run.stderr);
});
