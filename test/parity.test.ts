// 对照工具（src/parity/）：boot 场景两次跑出来一个字节不差、每个脑区的 open 都在；起来时每一种该拒的都拒、什么都不建；
// 假 fetch、断网断进程；虚拟时钟和在跑的一轮；记录器记全接口给的字段、场景给命令的回答；状态摘要；围栏守住真 home 和草稿区；
// 克隆快照时链接怎么处理；census、diff 分派得到。内核沙箱那一层在 test/parity-sandbox.test.ts。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { copyFileSync, cpSync, createWriteStream, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { userInfo } from "node:os";
import { Worker } from "node:worker_threads";
import ts from "typescript";
import { z } from "zod";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../src/config.ts";
import type { SessionSpec } from "../src/kernel/types.ts";
import { regionSpecs } from "../src/regions/specs.ts";
import { openDb } from "../src/store/db.ts";
import { summarize } from "../src/util/run.ts";
import { cloneSnapshot } from "../src/parity/clone.ts";
import { PARITY_PID, VirtualClock, installDeterminism } from "../src/parity/determinism.ts";
import { changedFiles, dbDigest, scanFiles } from "../src/parity/digest.ts";
import { UNFENCED_FS, UNFENCED_PROMISES, assertNoLiveMention, assertOffLive, fencedHomes, fencedNames, installFence } from "../src/parity/fence.ts";
import { installOffline } from "../src/parity/offline.ts";
import { Recorder } from "../src/parity/recorder.ts";
import { RecordingDriver, offlineOpenAI, recordingBridge, recordingGateway, recordingRunner } from "../src/parity/fakes.ts";
import { buildSnapshot, STATE_REL, TAKEN_AT, upToState, WORKSPACE_REL } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";
import { setLang } from "../src/lang/index.ts";

// this file asserts the Chinese pack's text
setLang("zh");

const MAIN = resolve(fileURLToPath(import.meta.url), "../../src/parity/main.ts");
/** 真拷一次库的那个小脚本（要一个 node:sqlite 还没被 import 过的新进程） */
const BACKUP_RUN = resolve(fileURLToPath(import.meta.url), "../parity/backup.run.ts");

const main = (args: string[], env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [MAIN, ...args], { encoding: "utf8", env });
const dump = (...args: string[]) => main(["dump", ...args]);
const REFUSED = /parity: refusing to touch the live home/;
const mode = (p: string): number => statSync(p).mode & 0o777;

interface Rec { n: number; t: number; kind: string; [k: string]: unknown }
const parse = (raw: string): Rec[] => raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
const readTranscript = (out: string, scenario: string): { raw: string; recs: Rec[] } => {
  const raw = readFileSync(join(out, scenario, "transcript.jsonl"), "utf8");
  return { raw, recs: parse(raw) };
};
/** 测试里直接看记录器记了什么：写到临时文件再读回来 */
const recordsOf = (rec: Recorder): Rec[] => {
  const f = join(tmpDir("hh-parity-rec-"), "t.jsonl");
  rec.write(f);
  return parse(readFileSync(f, "utf8"));
};

test("parity dump boot: two runs with the same --work are byte-identical; every region's open, the config pair and the state are on record; modes are private", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const work = join(root, "work");
  // 第一次带 --label（包装脚本给的是提交号）：只进 meta.json，记录不变
  const runs = ["out1", "out2"].map((o) => {
    const r = dump("--data", snap.data, "--work", work, "--out", join(root, o), "--scenario", "boot", ...(o === "out1" ? ["--label", "tree-1a2b3c"] : []));
    assert.equal(r.status, 0, r.stderr);
    return { r, ...readTranscript(join(root, o), "boot") };
  });
  const [a, b] = runs as [typeof runs[0], typeof runs[0]];
  assert.equal(a.raw, b.raw);
  assert.equal(a.r.stdout, `boot\t${a.recs.length}\n`);
  const metaOf = (o: string): unknown => JSON.parse(readFileSync(join(root, o, "meta.json"), "utf8"));
  assert.deepEqual(metaOf("out1"), { snapshot: "fixture-1", sandbox: true, label: "tree-1a2b3c", scenarios: [{ name: "boot", records: a.recs.length, ok: true }] });
  assert.deepEqual(metaOf("out2"), { snapshot: "fixture-1", sandbox: true, label: null, scenarios: [{ name: "boot", records: a.recs.length, ok: true }] });
  assert.equal(existsSync(snap.home), false, "nothing is written into the snapshot's live home");
  for (const d of [join(root, "out1"), join(root, "out1", "boot"), work, join(work, "home"), join(work, "tmp")]) assert.equal(mode(d), 0o700, d);
  for (const f of [join(root, "out1", "boot", "transcript.jsonl"), join(root, "out1", "meta.json")]) assert.equal(mode(f), 0o600, f);

  const recs = a.recs;
  assert.deepEqual(recs.map((r) => r.n), recs.map((_, i) => i));
  assert.deepEqual(recs.filter((r) => r.kind === "config").map((r) => r.name), ["as-loaded", "effective"]);
  for (const c of recs.filter((r) => r.kind === "config")) assert.match(String(c.orderSha256), /^[0-9a-f]{64}$/, "each config record carries the digest of its own key order");
  const effective = recs.find((r) => r.kind === "config" && r.name === "effective")!.value as Config;
  assert.ok(effective.workspace.startsWith("<WORK>/home/"), effective.workspace);
  const opens = recs.filter((r) => r.kind === "open");
  const regions = regionSpecs(effective).map((s) => s.id);
  assert.deepEqual(opens.map((o) => o.region).sort(), [...regions].sort());
  for (const o of opens) {
    assert.ok(typeof o.systemAppend === "string" && o.systemAppend.includes("我是阿青"), `${String(o.region)} systemAppend`);
    const tools = o.tools as Array<{ name: string; schema: { type?: string } }>;
    assert.ok(tools.length > 0 && tools.every((t) => t.name && t.schema.type === "object"), `${String(o.region)} tools`);
    assert.ok("claudeExecutable" in o && !("hooks" in o) && !("onEvent" in o) && !("log" in o), `${String(o.region)} open fields`);
  }
  for (const id of regions) assert.ok(recs.some((r) => r.kind === "send" && r.region === id), `${id} got a send`);
  assert.ok(recs.some((r) => r.kind === "run" && r.opts && typeof r.opts === "object"), "run records carry the runner options");
  // 情境每次叫醒主线要跑的那条命令由世界自带的回答接住（起来这一段只跑了它；别的命令照默认的回，记 null），回的话到了主线面前
  const goals = recs.filter((r) => r.kind === "run" && r.answered !== null);
  assert.ok(goals.length > 0 && goals.every((r) => (r.args as string[]).join(" ").endsWith("scripts/goals.py brief main")), JSON.stringify(goals.map((r) => r.args)));
  assert.deepEqual(goals[0]!.answered, { code: 0, stdout: "目标：把工具墙整理完 g30（40 分钟前）\n", stderr: "" });
  assert.ok(recs.some((r) => r.kind === "send" && r.region === "main" && String(r.text).includes("目标：把工具墙整理完 g30（40 分钟前）")), "the per-turn context carries the answered output");
  assert.deepEqual(recs.filter((r) => r.kind === "state").map((r) => r.name), ["status", "db", "files"]);
  assert.deepEqual(upToState(recs).slice(-3).map((r) => r.kind), ["state", "state", "state"]);
  // 状态之后只有收尾时关掉每个脑区的会话
  const shutdown = recs.slice(upToState(recs).length);
  assert.deepEqual([shutdown.map((r) => r.kind), shutdown.map((r) => r.region).sort()], [regions.map(() => "close"), [...regions].sort()]);
  const db = recs.find((r) => r.kind === "state" && r.name === "db")!.value as { userVersion: number; schema: Array<{ type: string; name: string }>; tables: Record<string, { rows: number }> };
  assert.equal(db.tables.central?.rows, 4);
  assert.equal(typeof db.userVersion, "number");
  assert.ok(db.schema.some((s) => s.type === "table" && s.name === "central") && db.schema.some((s) => s.type === "index"));
  const files = upToState(recs).at(-1)!.value as Array<{ path: string; dir?: boolean; mode?: string }>;
  assert.ok(files.some((f) => f.dir && f.path.endsWith("skills-plugin") && f.mode === "0755"), "created directories are listed with their mode");
  assert.ok(!recs.some((r) => r.kind === "refused"), "booting needs nothing the fence refuses");
  // 文件时间：克隆照抄快照的；这一跑自己写的是虚拟的那一刻（这里是世界建起来时写的假 key，时钟还在 T0）
  const identity = join("home", WORKSPACE_REL, "IDENTITY.md");
  assert.ok(Math.abs(statSync(join(work, identity)).mtimeMs - statSync(join(snap.data, identity)).mtimeMs) <= 1, "a cloned file keeps the snapshot's mtime (to the millisecond)");
  assert.equal(statSync(join(work, "home", STATE_REL, "secrets.json")).mtimeMs, TAKEN_AT, "a file written during the run carries the virtual time");
  assert.ok(!a.raw.includes(work), "absolute work paths are normalized");
  assert.ok(!a.raw.includes("存下来现在才交给你"), "no spooled message in this snapshot: the start drain hands nothing in");
});

test("parity dump boot mirrors the daemon's start: a message hh-relay stored while hhd was away is handed in at start with the tree's own late note, its file is gone, and the stateDir warning is on record", () => {
  const root = tmpDir("hh-parity-");
  const text = "松木板到了，先放在门口";
  const snap = buildSnapshot(root, { relaySpool: [{ at: TAKEN_AT - 10 * 60_000, message: { channel: "qqbot", senderId: "qq:guest-0002", text, messageId: "spooled-0001", isGroup: false } }] });
  const out = join(root, "out");
  const r = dump("--data", snap.data, "--work", join(root, "work"), "--out", out, "--scenario", "boot");
  assert.equal(r.status, 0, r.stderr);
  const { recs } = readTranscript(out, "boot");
  const late = `（这条是 10 分钟前发来的，你那时不在，存下来现在才交给你）${text}`;
  const handed = recs.find((x) => x.kind === "send" && x.region === "main" && String(x.text).includes(late));
  assert.ok(handed, "main was handed the spooled message with the late note the tree renders");
  assert.ok(String(handed.text).includes("小禾"), "and the tree named its sender from the registry");
  const files = recs.find((x) => x.kind === "state" && x.name === "files")!.value as Array<{ path: string; deleted?: boolean }>;
  assert.deepEqual(files.filter((f) => f.path.includes("/relay-spool/")).map((f) => f.deleted), [true], "handed in, so the spool file was deleted");
  // 小快照的状态目录不叫 .hh：hhd 起来时说的那句也照说
  const warned = recs.find((x) => x.kind === "log" && x.level === "warn" && String(x.msg).startsWith("relay spool: stateDir is not ~/.hh"));
  assert.deepEqual([warned?.mod, warned?.error], ["hhd", null], "a tree log line carries its module; this one has no error");
});

test("parity dump: a scenario that runs past its time limit is reported failed and still listed in meta.json with ok: false", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const out = join(root, "out");
  // 1 毫秒：进程都起不来就到点了，哪台机器上都一样
  const r = dump("--data", snap.data, "--work", join(root, "work"), "--out", out, "--scenario", "boot", "--timeout-ms", "1");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^boot\t(\d+)\tFAILED \(timed out after 1 ms\)\n$/);
  const records = Number(/^boot\t(\d+)/.exec(r.stdout)![1]);
  assert.deepEqual(JSON.parse(readFileSync(join(out, "meta.json"), "utf8")), { snapshot: "fixture-1", sandbox: true, label: null, scenarios: [{ name: "boot", records, ok: false }] });
  const file = join(out, "boot", "transcript.jsonl");
  if (existsSync(file)) assert.match(String(readTranscript(out, "boot").recs.at(-1)!.msg), /timed out/);
});

test("parity dump: --work, --out, --data or --config under the manifest's home is refused before anything is created", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const work = join(root, "work");
  const out = join(root, "out");
  const refused = (r: ReturnType<typeof dump>, what: string): void => {
    assert.notEqual(r.status, 0, what);
    assert.match(r.stderr, REFUSED, what);
    assert.equal(existsSync(work), false, `${what}: no work dir`);
    assert.equal(existsSync(out), false, `${what}: no out dir`);
  };
  refused(dump("--data", snap.data, "--work", join(snap.home, "work"), "--out", out), "--work");
  refused(dump("--data", snap.data, "--work", work, "--out", join(snap.home, "out")), "--out");
  assert.equal(existsSync(snap.home), false);
  mkdirSync(snap.home);
  writeFileSync(join(snap.home, "cfg.json"), "{}");
  refused(dump("--data", snap.data, "--work", work, "--out", out, "--config", join(snap.home, "cfg.json")), "--config");
  cpSync(snap.data, join(snap.home, "snap"), { recursive: true });
  refused(dump("--data", join(snap.home, "snap"), "--work", work, "--out", out), "--data");
});

test("parity dump: --data, --work and --out must be pairwise disjoint (a snapshot inside --out would be wiped)", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const out = join(root, "out");
  mkdirSync(out);
  renameSync(snap.data, join(out, "boot"));
  const r = dump("--data", join(out, "boot"), "--work", join(root, "work"), "--out", out, "--scenario", "boot");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--data and --out must not overlap/);
  assert.ok(existsSync(join(out, "boot", "manifest.json")), "the snapshot is untouched");
  assert.match(dump("--data", join(out, "boot"), "--work", join(out, "boot", "w"), "--out", join(root, "o2")).stderr, /--data and --work must not overlap/);
  assert.match(dump("--data", join(out, "boot"), "--work", join(root, "w"), "--out", join(root, "w", "o")).stderr, /--work and --out must not overlap/);
});

test("parity dump --child: started by hand it refuses to run (it is not inside the kernel sandbox); with the parent's --no-sandbox marker, HOME under the manifest's home is refused before anything is created", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const work = join(root, "work");
  const out = join(root, "out");
  const args = ["dump", "--child", "--scenario", "boot", "--data", snap.data, "--work", work, "--out", out];
  // 环境照 dump 给的来：没有沙箱那一关，它就真跑起来了
  const env = { ...process.env, HOME: join(work, "home"), TMPDIR: join(work, "tmp") };
  const byHand = main(args, env);
  assert.deepEqual([byHand.status, byHand.stdout, byHand.stderr], [2, "", "parity: scenario child is not inside the kernel sandbox\n"]);
  // 手工带上 --parent 也一样：给的是自己真的父进程（这个测试进程，问得到，不是 EPERM）；给的是 launchd（问不到，但不是它的父进程）
  for (const parent of [String(process.pid), "1"]) {
    const forged = main([...args, "--parent", parent], env);
    assert.deepEqual([forged.status, forged.stderr], [2, "parity: scenario child is not inside the kernel sandbox\n"], `--parent ${parent}`);
  }
  for (const p of [work, out, snap.home]) assert.equal(existsSync(p), false, p);
  // 没套沙箱、明着放行的：--work 不是 dump 认过的草稿区（没有记号）也不跑——克隆要删它里面的 home 和 tmp
  mkdirSync(join(work, "home"), { recursive: true });
  writeFileSync(join(work, "home", "keep.txt"), "别人的东西");
  const unprepared = main([...args, "--no-sandbox"], env);
  assert.deepEqual([unprepared.status, unprepared.stderr], [2, `parity: --child needs a --work that dump prepared (no .parity-work marker in ${work})\n`]);
  assert.equal(readFileSync(join(work, "home", "keep.txt"), "utf8"), "别人的东西", "nothing in it was wiped");
  rmSync(work, { recursive: true });

  const r = main([...args, "--no-sandbox"],
    { ...process.env, HOME: join(snap.home, "x"), TMPDIR: join(work, "tmp"), HH_CONFIG: join(snap.data, "home", STATE_REL, "config.json") });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, REFUSED);
  for (const p of [work, out, snap.home]) assert.equal(existsSync(p), false, p);
});

test("parity dump: an effective-config path that reaches the live home through a dangling symlink, a string that mentions the home, or a path in the running user's own home stops the world before the db or secrets.json is touched", () => {
  for (const [what, config] of [
    ["dangling symlink", (root: string) => ({ modules: { helpers: { sessionsDir: join(root, "alias", "x") } } })],
    ["mentioned mid-string", (root: string) => ({ kernel: { env: { EXTRA_PATH: `/usr/bin:${join(root, "live-home")}/bin` } } })],
    // 子进程守的 home 里有跑它的系统用户自己的 home（fencedHomes），不只是快照写的那个
    ["the running user's home", () => ({ modules: { helpers: { sessionsDir: join(userInfo().homedir, "parity-no-such-dir", "x") } } })],
  ] as const) {
    const root = tmpDir("hh-parity-");
    const snap = buildSnapshot(root, { config: config(root) });
    symlinkSync(snap.home, join(root, "alias"));
    const work = join(root, "work");
    const r = dump("--data", snap.data, "--work", work, "--out", join(root, "out"), "--scenario", "boot");
    assert.equal(r.status, 1, what);
    assert.match(r.stderr, /parity: scenario boot failed: parity: refusing to touch the live home \(/, what);
    const state = join(work, "home", STATE_REL);
    assert.equal(existsSync(join(state, "secrets.json")), false, `${what}: no secrets.json`);
    assert.equal(existsSync(join(state, "hh.db-wal")), false, `${what}: the db was never opened`);
    assert.equal(existsSync(snap.home), false, `${what}: the live home was not created`);
  }
});

test("parity dump: a snapshot without a database is refused before one is created (an empty replay on both sides would compare identical)", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  for (const f of readdirSync(join(snap.data, "home", STATE_REL))) if (f.startsWith("hh.db")) rmSync(join(snap.data, "home", STATE_REL, f));
  const work = join(root, "work");
  const r = dump("--data", snap.data, "--work", work, "--out", join(root, "out"), "--scenario", "boot");
  assert.equal(r.status, 1);
  assert.equal(r.stderr, `parity: scenario boot failed: parity: the snapshot has no database at <WORK>/home/${STATE_REL}/hh.db\n`);
  assert.deepEqual(readdirSync(join(work, "home", STATE_REL)), ["config.json"], "no database and no secrets.json were created in the clone");
});

test("parity main dispatches census and diff", () => {
  const root = tmpDir("hh-parity-");
  mkdirSync(join(root, "tree", "src"), { recursive: true });
  writeFileSync(join(root, "tree", "src", "a.ts"), 'export const s = "你好";\n');
  const c = main(["census", "--tree", join(root, "tree"), "--out", join(root, "c.txt")]);
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stdout, /^census: 1 distinct literals/);
  const d = main(["diff", "--census", join(root, "c.txt"), join(root, "c.txt")]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /parity: identical\n$/);
  const u = main(["census"]);
  assert.equal(u.status, 2);
  assert.match(u.stderr, /usage: census/);
});

test("parity fake fetch: answers the two OpenAI endpoints deterministically, refuses everything else, and records method, headers (no authorization value) and any body", async () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const f = rec.fetch(offlineOpenAI);
  await assert.rejects(f("https://example.com/x", { method: "POST", body: "{}" }), /^Error: parity: network is off \(https:\/\/example\.com\/x\)$/);

  const embed = async (input: string[]) =>
    ((await (await f("https://api.openai.com/v1/embeddings", { method: "POST", headers: { Authorization: "Bearer k", "Content-Type": "application/json" }, body: JSON.stringify({ model: "m", input, dimensions: 8 }) })).json()) as { data: Array<{ index: number; embedding: number[] }> }).data;
  const [x, y] = await embed(["木料", "集市"]);
  assert.equal(x!.embedding.length, 8);
  assert.ok(Math.abs(Math.hypot(...x!.embedding) - 1) < 1e-9);
  assert.notDeepEqual(x!.embedding, y!.embedding);
  assert.deepEqual((await embed(["木料"]))[0]!.embedding, x!.embedding);

  const questions = Array.from({ length: 40 }, (_, i) => ({ type: "predicate", name: `q${i}`, instructions: `第 ${i} 题` }));
  const d = (await (await f("https://api.openai.com/v1/decisions", { method: "POST", body: JSON.stringify({ model: "m", input: "话题", questions }) })).json()) as { answers: Array<{ name: string; probability: number }>; usage: { input_tokens: number } };
  assert.deepEqual(d.answers.map((a) => a.name), questions.map((q) => q.name));
  assert.ok(d.answers.some((a) => a.probability >= 0.7) && d.answers.some((a) => a.probability < 0.5), "both branches occur");
  assert.equal(typeof d.usage.input_tokens, "number");

  for (const body of [new URLSearchParams({ a: "1" }), new Uint8Array([1, 2, 3]), null]) await assert.rejects(f("https://example.com/b", { method: "put", body }));
  const recs = recordsOf(rec);
  assert.equal(recs.length, 7, "every fetch is on record, the refused ones too");
  assert.deepEqual(recs[1]!.headers, { authorization: "<present>", "content-type": "application/json" });
  assert.equal(recs[1]!.method, "POST");
  assert.deepEqual(recs.slice(4).map((r) => [r.method, r.body]), [["PUT", "a=1"], ["PUT", { $blob: "AQID" }], ["PUT", null]]);
});

test("parity recorder: open records every non-function SessionSpec key (claudeExecutable, fields added later), ask every AskOpts key, run its options, gateway its timeout; quota and fork are calls", async () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const driver = new RecordingDriver(rec);
  const spec = {
    id: "main", model: "m", systemAppend: "前缀", cwd: "/w", permissionMode: "default", claudeExecutable: "/x/claude", future: { a: 1 }, builtinTools: [],
    tools: [{ name: "t", description: "d", shape: {}, handler: async () => "" }],
    hooks: { beforeTool: () => undefined, afterTool: () => undefined }, onEvent: () => {}, log: () => {},
  } as SessionSpec;
  const s = driver.open(spec);
  await driver.ask({ model: "h", system: "sys", prompt: "p", cwd: "/w", timeoutMs: 5 });
  assert.deepEqual(await driver.quota({ model: "h", cwd: "/w" }), { fiveHour: { used: 20, resetsAt: null }, sevenDay: { used: 30, resetsAt: null } });
  driver.quotaReading = null;
  assert.equal(await driver.quota({ model: "h", cwd: "/w" }), null);
  const forked = await s.fork!("压一下", { timeoutMs: 1 });
  assert.equal(forked.ok, true);
  await recordingRunner(rec)("python3", ["x.py"], { cwd: "/w", timeoutMs: 9 });
  await recordingGateway(rec).request("send", { to: "t" }, 1234);
  const bridged = recordingBridge(rec)("whatsapp");
  assert.deepEqual([bridged.connected, await bridged.send({ channel: "whatsapp", target: "t", text: "好" })], [true, { ok: true, out: '{"messageId":"b1"}' }]);

  const [open, ask, q1, q2, fork, run, gw, br] = recordsOf(rec);
  assert.deepEqual([br!.kind, br!.channel, br!.m], ["bridge", "whatsapp", { channel: "whatsapp", target: "t", text: "好" }], "a send through a bridge is recorded, nothing is connected");
  assert.equal(open!.claudeExecutable, "/x/claude");
  assert.deepEqual(open!.future, { a: 1 });
  assert.ok(!("hooks" in open!) && !("onEvent" in open!) && !("log" in open!) && !("id" in open!) && open!.region === "main");
  assert.deepEqual((open!.tools as Array<Record<string, unknown>>).map((t) => Object.keys(t).sort()), [["description", "name", "paramOrder", "schema"]]);
  assert.deepEqual([ask!.cwd, ask!.timeoutMs, ask!.env, ask!.claudeExecutable], ["/w", 5, null, null]);
  assert.deepEqual([q1!.kind, q1!.name, q2!.returned], ["call", "quota", null]);
  assert.deepEqual([fork!.name, fork!.args], ["fork", { region: "main", text: "压一下" }]);
  assert.deepEqual(run!.opts, { cwd: "/w", timeoutMs: 9 });
  assert.deepEqual([gw!.method, gw!.timeoutMs], ["send", 1234]);
});

test("parity recorder: where key order is content it is on record — two tool shapes with the same parameters in another order, mcpServers and env in another order, a config in another order", () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const driver = new RecordingDriver(rec);
  const spec = (shape: SessionSpec["tools"][number]["shape"], mcpServers: Record<string, unknown>, env: Record<string, string>) => ({
    id: "main", model: "m", systemAppend: "", cwd: "/w", permissionMode: "default", mcpServers, env,
    tools: [{ name: "note", description: "记一笔", shape, handler: async () => "" }],
    hooks: { beforeTool: () => undefined, afterTool: () => undefined }, onEvent: () => {},
  }) as unknown as SessionSpec;
  const [text, urgent] = [z.string().optional(), z.boolean().optional()];
  driver.open(spec({ text, urgent }, { a: { type: "stdio" }, b: { type: "stdio" } }, { X: "1", Y: "2" }));
  driver.open(spec({ urgent, text }, { a: { type: "stdio" }, b: { type: "stdio" } }, { X: "1", Y: "2" }));
  driver.open(spec({ text, urgent }, { b: { type: "stdio" }, a: { type: "stdio" } }, { Y: "2", X: "1" }));
  const strip = ({ n: _n, ...r }: Rec) => r;
  const [first, swappedParams, swappedMaps] = recordsOf(rec).map(strip);
  type Tool = { schema: unknown; paramOrder: string[] };
  const tool = (r: Record<string, unknown>): Tool => (r.tools as Tool[])[0]!;
  assert.deepEqual(tool(first!).schema, tool(swappedParams!).schema, "the canonical schema cannot tell the two shapes apart");
  assert.deepEqual([tool(first!).paramOrder, tool(swappedParams!).paramOrder], [["text", "urgent"], ["urgent", "text"]]);
  assert.notDeepEqual(first, swappedParams, "so the two open records differ");
  assert.deepEqual([first!.mcpServers, first!.env], [swappedMaps!.mcpServers, swappedMaps!.env]);
  assert.deepEqual([first!.mcpServersOrder, first!.envOrder, swappedMaps!.mcpServersOrder, swappedMaps!.envOrder], [["a", "b"], ["X", "Y"], ["b", "a"], ["Y", "X"]]);
  assert.notDeepEqual(first, swappedMaps);
  // 没给 mcpServers、env 的会话：两个先后都是 null
  driver.open({ ...spec({}, {}, {}), mcpServers: undefined, env: undefined } as unknown as SessionSpec);
  const bare = recordsOf(rec).at(-1)!;
  assert.deepEqual([bare.mcpServersOrder, bare.envOrder], [null, null]);

  // 配置的摘要：键的先后不同就不同，值一样、先后一样就一样；路径照样换成记号（换个工作目录不变）
  const at = (work: string) => new Recorder({ t0: 0, now: () => 0, roots: { "<WORK>": work } });
  const cfg = (work: string) => ({ id: "aqing", workspace: `${work}/home/ws`, limits: { a: 1, b: 2 } });
  assert.equal(at("/x/w1").orderDigest(cfg("/x/w1")), at("/y/w2").orderDigest(cfg("/y/w2")));
  assert.notEqual(rec.orderDigest({ a: 1, b: { c: 2, d: 3 } }), rec.orderDigest({ a: 1, b: { d: 3, c: 2 } }));
  assert.notEqual(rec.orderDigest({ a: 1, b: 2 }), rec.orderDigest({ a: 1, b: 3 }));
});

test("parity recorder: a session's close and interrupt are on record (a dropped close would otherwise compare identical)", async () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const s = new RecordingDriver(rec).open({
    id: "sleep-tidy", model: "m", systemAppend: "", cwd: "/w", permissionMode: "default", tools: [], builtinTools: [],
    hooks: { beforeTool: () => undefined, afterTool: () => undefined }, onEvent: () => {},
  });
  s.busy = true;
  await s.interrupt();
  await s.close();
  assert.deepEqual([s.interrupted, s.closed], [1, true], "the fake session still does what it did");
  assert.deepEqual(recordsOf(rec).slice(1).map((r) => [r.kind, r.region]), [["interrupt", "sleep-tidy"], ["close", "sleep-tidy"]]);
});

test("parity recorder strictness: Map, Set, RegExp and Error are encoded, not flattened to {}; an undefined field is null; a field named n, t or kind is refused", () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: { "<WORK>": "/x/work" } });
  rec.add("call", {
    name: "shapes", args: { map: new Map<string, unknown>([["老林", { at: "/x/work/home" }], ["小禾", undefined]]), set: new Set(["b", "a"]), re: /^老林[:：]/gu, err: new RangeError("没有 /x/work/home/这一页") },
    returned: undefined, missing: { inner: undefined, fn: () => 1 },
  });
  const [r] = recordsOf(rec);
  assert.deepEqual(r!.args, {
    map: { $map: [["老林", { at: "<WORK>/home" }], ["小禾", null]] }, set: { $set: ["b", "a"] }, re: { $regex: "/^老林[:：]/gu" },
    err: { $error: "RangeError: 没有 <WORK>/home/这一页" },
  });
  assert.deepEqual([r!.returned, r!.missing], [null, { inner: null }], "undefined is written as null; functions are left out");
  for (const k of ["n", "t", "kind"]) {
    assert.throws(() => rec.add("call", { name: "x", [k]: 1 }), new RegExp(`a record field may not be named "${k}"`));
  }
  assert.equal(recordsOf(rec).length, 1, "a refused record is not written");
});

test("parity recorder: a log record carries the module and the first line of the error — no stack, no path that is not a <WORK> / <TREE> token", () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: { "<WORK>": "/x/work" } });
  const e = new Error("ENOENT: no such file or directory, open '/x/work/home/notes.md'");
  e.stack = `${e.name}: ${e.message}\n    at read (/somewhere/else/src/a.ts:1:2)`;
  rec.log("warn", "people: card unreadable", { mod: "hhd.people", error: e.stack });
  rec.log("warn", "people: card unreadable", { mod: "hhd.people", error: "EACCES: permission denied, open '/private/var/folders/zz/T/card.md' (file:///opt/tool/x.js)" });
  rec.log("error", "tick failed", { mod: "hhd", error: e });
  rec.log("warn", "读/写/改 都试过了", { mod: "hhd.situation" });
  rec.log("info", "parity: tools called=3 stored-calls=1 skipped=");
  assert.deepEqual(recordsOf(rec).map((r) => [r.level, r.mod, r.msg, r.error]), [
    ["warn", "hhd.people", "people: card unreadable", "Error: ENOENT: no such file or directory, open '<WORK>/home/notes.md'"],
    ["warn", "hhd.people", "people: card unreadable", "EACCES: permission denied, open '<path>' (file://<path>)"],
    ["error", "hhd", "tick failed", "Error: ENOENT: no such file or directory, open '<WORK>/home/notes.md'"],
    ["warn", "hhd.situation", "读/写/改 都试过了", null],
    ["info", "parity", "parity: tools called=3 stored-calls=1 skipped=", null],
  ]);
});

test("parity network and process fences: http, dns, dgram, WebSocket, child_process and process.execve throw and leave a net / spawn record", async () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installOffline(rec);
  try {
    assert.throws(() => http.request("http://example.com/x"), /^Error: parity: network is off \(http:\/\/example\.com\/x\)$/);
    assert.throws(() => spawnSync("ls", ["-l"]), /^Error: parity: processes are off \(ls\)$/);
    assert.throws(() => new WebSocket("ws://example.com/"), /network is off/);
    assert.throws(() => dns.lookup("example.com", () => {}), /network is off \(example\.com\)/);
    await assert.rejects(dns.promises.resolve4("example.org"), /network is off \(example\.org\)/);
    await assert.rejects(new dns.promises.Resolver().resolveTxt("example.net"), /network is off \(example\.net\)/);
    assert.throws(() => new dgram.Socket("udp4" as never), /network is off \(udp4\)/);
    // 没拦住的话这个测试进程就被换成 /usr/bin/true 了
    assert.throws(() => process.execve!("/usr/bin/true", ["true", "x"]), /^Error: parity: processes are off \(\/usr\/bin\/true\)$/);
  } finally {
    uninstall();
  }
  const recs = recordsOf(rec);
  assert.deepEqual(recs.map((r) => [r.kind, r.api, r.target ?? r.cmd]), [
    ["net", "http.request", "http://example.com/x"], ["spawn", "child_process.spawnSync", "ls"], ["net", "WebSocket", "ws://example.com/"],
    ["net", "dns.lookup", "example.com"], ["net", "dns.promises.resolve4", "example.org"], ["net", "dns.promises.Resolver.resolveTxt", "example.net"],
    ["net", "dgram.Socket", "udp4"], ["spawn", "process.execve", "/usr/bin/true"],
  ]);
  assert.deepEqual([recs[1]!.args, recs[7]!.args], [["-l"], ["true", "x"]]);
  assert.equal(spawnSync(process.execPath, ["-e", ""]).status, 0, "restored");
});

test("parity virtual clock: timers fire in (time, insertion) order, Date follows the clock, a world that never settles throws", async () => {
  const c = new VirtualClock(1_000);
  const seen: string[] = [];
  c.setTimeout(() => seen.push(`b@${c.now}`), 200);
  c.setTimeout(() => seen.push(`a@${c.now}`), 100);
  c.setTimeout(() => seen.push(`a2@${c.now}`), 100);
  const gone = c.setTimeout(() => seen.push("cleared"), 50);
  c.clearTimeout(gone);
  const every = c.setInterval(() => seen.push(`i@${c.now}`), 150);
  await c.advanceTo(1_400);
  c.clearInterval(every);
  assert.deepEqual(seen, ["a@1100", "a2@1100", "i@1150", "b@1200", "i@1300"]);
  assert.equal(c.now, 1_400);
  assert.equal(c.pending, 0);

  const det = installDeterminism(TAKEN_AT);
  try {
    assert.equal(Date.now(), TAKEN_AT);
    assert.equal(new Date().getTime(), TAKEN_AT);
    assert.equal(new Date(5).getTime(), 5);
    assert.equal(Date.UTC(2026, 0, 1), new Date("2026-01-01T00:00:00Z").getTime());
    const fired: number[] = [];
    setTimeout(() => fired.push(Date.now()), 60_000);
    await det.clock.advanceTo(TAKEN_AT + 120_000);
    assert.deepEqual(fired, [TAKEN_AT + 60_000]);
    assert.equal(Date.now(), TAKEN_AT + 120_000);
    assert.equal(crypto.randomUUID(), "00000000-0000-4000-8000-000000000001");
    const r1 = Math.random();
    det.clock.setQuiet(() => false);
    await assert.rejects(det.clock.drain(), /did not settle within 2000 turns/);
    det.restore();
    const again = installDeterminism(TAKEN_AT);
    assert.equal(Math.random(), r1, "the random stream is seeded");
    again.restore();
  } finally {
    det.restore();
  }
  assert.ok(Math.abs(Date.now() - new Date().getTime()) < 1_000 && Date.now() > TAKEN_AT, "restored to the real clock");
});

test("parity virtual clock: a real sqlite backup in flight holds virtual time — the drain waits for the copy instead of firing the next timer", () => {
  const root = tmpDir("hh-parity-backup-");
  const r = spawnSync(process.execPath, [BACKUP_RUN, root], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {
    // 拷完的那一刻虚拟时间还在它开始的地方，然后计时器才到点
    order: ["backup@0", "timer@1000"], now: 5000, rows: 2000, wrapped: true,
    // 拷坏了的不卡住时钟：错照样交给调用的一方
    failed: "rejected",
  });
});

test("parity fence with a virtual clock: a file the tree writes inside the scratch area gets the virtual now as its mtime (writeFile, appendFile, copyFile, rename, cp, truncate — sync, callback and promise); directories are left alone", async () => {
  const root = tmpDir("hh-parity-fence-");
  const scratch = join(root, "work");
  mkdirSync(scratch);
  const at = (f: string): string => join(scratch, f);
  const mtime = (f: string): number => statSync(at(f)).mtimeMs;
  const det = installDeterminism(TAKEN_AT);
  const uninstall = installFence(join(root, "home"), { scratch: [scratch], now: () => det.clock.now });
  const LATER = TAKEN_AT + 3_600_000;
  try {
    writeFileSync(at("a.txt"), "甲");
    assert.equal(mtime("a.txt"), TAKEN_AT);
    await det.clock.advanceTo(LATER);
    fs.appendFileSync(at("a.txt"), "乙");
    await writeFile(at("b.txt"), "x");
    await new Promise<void>((done, fail) => { fs.writeFile(at("c.txt"), "x", (e) => (e ? fail(e) : done())); });
    await new Promise<void>((done, fail) => { fs.appendFile(at("c2.txt"), "x", (e) => (e ? fail(e) : done())); });
    copyFileSync(at("a.txt"), at("d.txt"));
    await fs.promises.copyFile(at("a.txt"), at("d2.txt"));
    writeFileSync(at("tmp-e"), "写完改名的那种");
    fs.utimesSync(at("tmp-e"), 1, 1);
    renameSync(at("tmp-e"), at("e.txt"));
    cpSync(at("a.txt"), at("f.txt"));
    writeFileSync(at("g.txt"), "长一点的");
    fs.utimesSync(at("g.txt"), 1, 1);
    fs.truncateSync(at("g.txt"), 3);
    for (const f of ["a.txt", "b.txt", "c.txt", "c2.txt", "d.txt", "d2.txt", "e.txt", "f.txt", "g.txt"]) assert.equal(mtime(f), LATER, f);
    mkdirSync(at("dir"));
    assert.ok(mtime("dir") > LATER + 86_400_000, "a directory keeps its real time");
    // 回调报错的不改（也没有可改的文件）
    await new Promise<void>((done) => { fs.writeFile(at("no-such-dir/x.txt"), "x", () => done()); });
  } finally {
    uninstall();
    det.restore();
  }
  writeFileSync(at("after.txt"), "x");
  assert.ok(mtime("after.txt") > LATER + 86_400_000, "restored: real mtimes again");
});

test("parity play: a scripted tool call whose handler waits on a 0 ms and a 50 ms timer completes, and the clock moves exactly 50 ms", async () => {
  const det = installDeterminism(TAKEN_AT);
  try {
    const rec = new Recorder({ t0: TAKEN_AT, now: () => det.clock.now, roots: {} });
    let seen = rec.count;
    det.clock.setQuiet(() => { const q = rec.count === seen; seen = rec.count; return q; });
    const driver = new RecordingDriver(rec);
    const wait = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
    driver.open({
      id: "main", model: "m", systemAppend: "", cwd: "/", permissionMode: "default", builtinTools: [],
      tools: [{ name: "wait", description: "等一下", shape: {}, handler: async () => { await wait(0); await wait(50); return "等完了"; } }],
      hooks: { beforeTool: () => undefined, afterTool: () => undefined }, onEvent: () => {},
    });
    await det.clock.run(driver.latest("main").play({ tool: { name: "wait", args: {} } }));
    assert.equal(det.clock.now, TAKEN_AT + 50);
    const result = recordsOf(rec).find((r) => r.kind === "result")!;
    assert.deepEqual([result.text, result.isError, result.t], ["等完了", false, 50]);
  } finally {
    det.restore();
  }
});

test("parity runner: a scenario's answer to a command comes back in the tool's reply; every run record says what was answered (null = the default empty success)", async () => {
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const asked: unknown[][] = [];
  const run = recordingRunner(rec, (cmd, args, opts) => {
    asked.push([cmd, args, opts]);
    return args[1] === "pending" ? { code: 0, stdout: "10-30\n10-31\n", stderr: "" } : args[1] === "broken" ? { code: 3, stdout: "", stderr: "没有这一天" } : undefined;
  });
  const driver = new RecordingDriver(rec);
  driver.open({
    id: "main", model: "m", systemAppend: "", cwd: "/", permissionMode: "default", builtinTools: [],
    tools: [{ name: "days", description: "列出等着整理的日子", shape: { what: z.string() }, handler: async (a) => summarize(await run("python3", ["sleep.py", String(a.what)], { cwd: "/w" })) }],
    hooks: { beforeTool: () => undefined, afterTool: () => undefined }, onEvent: () => {},
  });
  for (const what of ["pending", "broken", "other"]) await driver.latest("main").play({ tool: { name: "days", args: { what } } });
  const recs = recordsOf(rec);
  assert.deepEqual(recs.filter((r) => r.kind === "result").map((r) => r.text), ["10-30\n10-31", "退出码 3\n[stderr]\n没有这一天", "（完成，没有输出）"]);
  assert.deepEqual(recs.filter((r) => r.kind === "run").map((r) => [r.cmd, r.args, r.opts, r.answered]), [
    ["python3", ["sleep.py", "pending"], { cwd: "/w" }, { code: 0, stdout: "10-30\n10-31\n", stderr: "" }],
    ["python3", ["sleep.py", "broken"], { cwd: "/w" }, { code: 3, stdout: "", stderr: "没有这一天" }],
    ["python3", ["sleep.py", "other"], { cwd: "/w" }, null],
  ]);
  assert.deepEqual(asked[0], ["python3", ["sleep.py", "pending"], { cwd: "/w" }], "the scenario is asked with what the tree ran");
  // 回答的函数抛了错：这条 run 照记（answered: null），错交给调用的一方
  await assert.rejects(recordingRunner(rec, () => { throw new Error("场景写错了"); })("git", ["status"]), /场景写错了/);
  assert.deepEqual([recordsOf(rec).at(-1)!.cmd, recordsOf(rec).at(-1)!.answered], ["git", null]);
});

test("parity digests: the db digest carries user_version and the schema; the files digest lists created directories and mode changes", () => {
  const db = openDb(":memory:");
  const d1 = dbDigest(db, (v) => v);
  db.exec("ALTER TABLE central ADD COLUMN extra TEXT; PRAGMA user_version = 7;");
  const d2 = dbDigest(db, (v) => v);
  assert.equal(d2.userVersion, 7);
  assert.notDeepEqual(d1.schema.find((s) => s.name === "central"), d2.schema.find((s) => s.name === "central"));
  assert.match(String(d2.schema.find((s) => s.name === "central")!.sql), /extra TEXT/);
  db.close();

  const root = tmpDir("hh-parity-digest-");
  writeFileSync(join(root, "a.txt"), "a");
  const before = scanFiles(root);
  fs.chmodSync(join(root, "a.txt"), 0o600);
  mkdirSync(join(root, "d"));
  assert.deepEqual(changedFiles(root, before).map((e) => [e.path, e.mode, "dir" in e]), [["a.txt", "0600", false], ["d", "0755", true]]);
});

test("parity fence: assertOffLive refuses the live home, paths under it and symlinks into it, and allows a sibling with a common prefix", () => {
  const root = tmpDir("hh-parity-fence-");
  const live = join(root, "home");
  mkdirSync(join(live, "sub"), { recursive: true });
  symlinkSync(join(live, "sub"), join(root, "link"));
  symlinkSync(join(root, "nowhere", "home"), join(root, "dangling"));
  for (const p of [live, `${live}/`, join(live, "sub", "x.txt"), join(live, "not", "yet"), join(root, "link"), join(root, "link", "new.txt")]) {
    assert.throws(() => assertOffLive([p], live), (e: Error) => e.message === `parity: refusing to touch the live home (${p})`, p);
  }
  assertOffLive([join(root, "home2"), join(root, "home2", "x"), root], live);
  assertOffLive([join(root, "other")], [join(root, "a"), join(root, "b")]);
  assert.throws(() => assertOffLive([join(root, "b", "c")], [join(root, "a"), join(root, "b")]), /refusing/);
  assert.throws(() => assertOffLive([join(root, "dangling", "x")], join(root, "nowhere", "home")), /refusing/, "through a dangling symlink");
  if (process.platform === "darwin") assert.throws(() => assertOffLive([join(root, "HOME", "x")], live), /refusing/, "case-insensitive on darwin");

  assert.throws(() => assertNoLiveMention([`--dir=${live}/x`], live), REFUSED);
  assert.throws(() => assertNoLiveMention([`/usr/bin:${live}:/bin`], live), REFUSED);
  assertNoLiveMention([`${live}2/x`, `/x${live}`, "plain"], live);
});

test("parity fence: writes under the live home, any open / read / listing there (even read-only), and copying or hard-linking out of it all throw; nothing is created", async () => {
  const root = tmpDir("hh-parity-fence-");
  const live = join(root, "home");
  mkdirSync(join(live, "x"), { recursive: true });
  writeFileSync(join(live, "x", "secrets.json"), "{}");
  writeFileSync(join(live, "x", "notes.md"), "不许读");
  symlinkSync(join(live, "x", "secrets.json"), join(root, "peek"));
  const noteBefore = statSync(join(live, "x", "notes.md"));
  writeFileSync(join(root, "src.txt"), "外面的");
  const uninstall = installFence(live);
  try {
    assert.throws(() => writeFileSync(join(live, "a.txt"), "x"), REFUSED);
    await assert.rejects(writeFile(join(live, "b.txt"), "x"), REFUSED);
    assert.throws(() => mkdirSync(join(live, "new"), { recursive: true }), REFUSED);
    assert.throws(() => rmSync(root, { recursive: true, force: true }), REFUSED, "removing a directory that holds the live home");
    assert.throws(() => renameSync(join(root, "src.txt"), join(live, "moved.txt")), REFUSED, "rename into");
    assert.throws(() => renameSync(join(live, "x", "notes.md"), join(root, "out.md")), REFUSED, "rename out of");
    assert.throws(() => copyFileSync(join(root, "src.txt"), join(live, "c.txt")), REFUSED, "copyFile into");
    assert.throws(() => cpSync(join(root, "src.txt"), join(live, "cp.txt")), REFUSED, "cp into");
    assert.throws(() => openSync(join(live, "o.txt"), "w"), REFUSED, "open for writing");
    assert.throws(() => createWriteStream(join(live, "s.txt")), REFUSED, "createWriteStream");
    assert.throws(() => symlinkSync(join(root, "src.txt"), join(live, "l")), REFUSED, "symlink into");
    assert.throws(() => linkSync(join(root, "src.txt"), join(live, "h")), REFUSED, "link into");
    assert.throws(() => fs.writeFile(join(live, "cb.txt"), "x", () => {}), REFUSED, "callback style");
    assert.throws(() => readFileSync(join(live, "x", "secrets.json"), "utf8"), REFUSED);
    assert.throws(() => readFileSync(join(root, "peek"), "utf8"), REFUSED, "a live secrets.json under another name");
    assert.throws(() => symlinkSync(join(live, "x", "secrets.json"), join(root, "s2")), REFUSED, "symlink to a live secrets.json");
    assert.throws(() => linkSync(join(live, "x", "secrets.json"), join(root, "h2")), REFUSED, "hard link to a live secrets.json");
    assert.throws(() => cpSync(join(live, "x"), join(root, "copy"), { recursive: true }), REFUSED, "cp of a live directory");
    assert.throws(() => copyFileSync(join(live, "x", "notes.md"), join(root, "n.md")), REFUSED, "copyFile out of the live home");
    assert.throws(() => linkSync(join(live, "x", "notes.md"), join(root, "h3")), REFUSED, "hard link out of the live home (later writes would go through)");
    // 只读的描述符也能改权限、属主、时间：真 home 里什么都不让打开
    assert.throws(() => openSync(join(live, "x", "notes.md"), "r"), REFUSED, "open read-only");
    await assert.rejects(fs.promises.open(join(live, "x", "notes.md"), "r"), REFUSED, "promises.open read-only");
    assert.throws(() => readFileSync(join(live, "x", "notes.md"), "utf8"), REFUSED, "readFile");
    assert.throws(() => readdirSync(live), REFUSED, "readdir");
    assert.throws(() => fs.opendirSync(live), REFUSED, "opendir");
    assert.throws(() => fs.createReadStream(join(live, "x", "notes.md")), REFUSED, "createReadStream");
    assert.equal(readFileSync(join(root, "src.txt"), "utf8"), "外面的", "reading outside the live home still works");
    writeFileSync(join(root, "outside.txt"), "ok");
  } finally {
    uninstall();
  }
  for (const f of ["a.txt", "b.txt", "new", "moved.txt", "c.txt", "cp.txt", "o.txt", "s.txt", "l", "h", "cb.txt"]) assert.equal(existsSync(join(live, f)), false, f);
  for (const f of ["s2", "h2", "h3", "copy", "n.md", "out.md"]) assert.equal(existsSync(join(root, f)), false, f);
  const noteAfter = statSync(join(live, "x", "notes.md"));
  assert.deepEqual([noteAfter.mode, noteAfter.mtimeMs], [noteBefore.mode, noteBefore.mtimeMs], "mode and mtime unchanged");
  assert.equal(existsSync(join(live, "x", "secrets.json")), true);
  assert.equal(readFileSync(join(root, "outside.txt"), "utf8"), "ok");
});

test("parity fence: with a scratch area, a write outside --work / --out that is not under the home throws its own refusal", () => {
  const root = tmpDir("hh-parity-fence-");
  const scratch = join(root, "work");
  mkdirSync(scratch);
  const uninstall = installFence(join(root, "home"), { scratch: [scratch] });
  try {
    assert.throws(() => writeFileSync(join(root, "elsewhere.txt"), "x"), /^Error: parity: refusing to write outside the scratch area \(/);
    assert.throws(() => writeFileSync(join(root, "home", "x"), "x"), REFUSED, "the live-home refusal comes first");
    writeFileSync(join(scratch, "ok.txt"), "ok");
  } finally {
    uninstall();
  }
  assert.equal(existsSync(join(root, "elsewhere.txt")), false);
  assert.equal(readFileSync(join(scratch, "ok.txt"), "utf8"), "ok");
});

test("parity fence covers every write-side function node:fs and node:fs/promises export (a new one fails here until it is classified)", () => {
  const names = fencedNames();
  const fnsOf = (o: object): string[] => Object.keys(o).filter((k) => typeof (o as Record<string, unknown>)[k] === "function");
  for (const n of fnsOf(fs)) assert.ok(names.fs.includes(n) || UNFENCED_FS.includes(n), `fs.${n} is neither fenced nor listed as not a write`);
  for (const n of fnsOf(fs.promises)) assert.ok(names.promises.includes(n) || UNFENCED_PROMISES.includes(n), `fs.promises.${n} is neither fenced nor listed as not a write`);
  for (const n of ["lchmod", "lchmodSync", "mkdtempDisposableSync", "WriteStream", "Utf8Stream"]) assert.ok(names.fs.includes(n), n);
  assert.ok(names.promises.includes("mkdtempDisposable"));
  const f = fs as unknown as Record<string, unknown>;
  const fp = fs.promises as unknown as Record<string, unknown>;
  const before = [names.fs.map((n) => f[n]), names.promises.map((n) => fp[n])] as const;
  const uninstall = installFence(join(tmpDir("hh-parity-fence-"), "home"));
  try {
    names.fs.forEach((n, i) => assert.notEqual(f[n], before[0][i], `fs.${n} is wrapped`));
    names.promises.forEach((n, i) => assert.notEqual(fp[n], before[1][i], `fs.promises.${n} is wrapped`));
  } finally {
    uninstall();
  }
  names.fs.forEach((n, i) => assert.equal(f[n], before[0][i], `fs.${n} is restored`));
});

test("parity fence: every refusal is recorded (refused {api, path}) before it throws, so a write the tree swallows still shows", async () => {
  const root = tmpDir("hh-parity-fence-");
  const live = join(root, "home");
  const scratch = join(root, "work");
  mkdirSync(live);
  mkdirSync(scratch);
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(live, { scratch: [scratch], sink: rec });
  try {
    try { writeFileSync(join(root, "elsewhere.txt"), "x"); } catch { /* 树里吞掉的那种 */ }
    await fs.promises.readFile(join(live, "a")).catch(() => {});
    writeFileSync(join(scratch, "fine.txt"), "x");
  } finally {
    uninstall();
  }
  assert.deepEqual(recordsOf(rec).map((r) => [r.kind, r.api, r.path]), [
    ["refused", "fs.writeFileSync", join(root, "elsewhere.txt")], ["refused", "fs.promises.readFile", join(live, "a")],
  ]);
});

test("parity fence: callback-style fs.open(path, cb) is a plain read (the callback is not read as flags)", async () => {
  const root = tmpDir("hh-parity-fence-");
  const scratch = join(root, "work");
  mkdirSync(scratch);
  writeFileSync(join(root, "outside.txt"), "x");
  const uninstall = installFence(join(root, "home"), { scratch: [scratch] });
  try {
    // 回调的源码里有 a 和 w：以前当成 flags 看就被当成写
    const fd = await new Promise<number>((done, fail) => { fs.open(join(root, "outside.txt"), (awaitedError, fdWanted) => { if (awaitedError) fail(awaitedError); else done(fdWanted); }); });
    fs.closeSync(fd);
    assert.throws(() => fs.open(join(root, "outside.txt"), "w", () => {}), /outside the scratch area/);
    assert.throws(() => fs.open(join(root, "outside.txt"), fs.constants.O_WRONLY, () => {}), /outside the scratch area/);
  } finally {
    uninstall();
  }
});

test("parity determinism: temp dirs get counter names and process.pid is fixed, so what the tree writes under TMPDIR compares", async () => {
  const root = tmpDir("hh-parity-tmp-");
  const realPid = process.pid;
  const det = installDeterminism(TAKEN_AT);
  try {
    assert.equal(process.pid, PARITY_PID);
    const a = mkdtempSync(join(root, "x-"));
    assert.equal(a, join(root, "x-000001"));
    assert.equal(mode(a), 0o700);
    mkdirSync(join(root, "x-000002"));
    assert.equal(mkdtempSync(join(root, "x-")), join(root, "x-000003"), "a name already taken is skipped");
    assert.equal(await fs.promises.mkdtemp(join(root, "y-")), join(root, "y-000004"));
    assert.equal(await new Promise((done, fail) => { fs.mkdtemp(join(root, "z-"), (e, p) => (e ? fail(e) : done(p))); }), join(root, "z-000005"));
    const d = (fs as unknown as { mkdtempDisposableSync(p: string): { path: string; remove(): void } }).mkdtempDisposableSync(join(root, "d-"));
    assert.equal(d.path, join(root, "d-000006"));
    d.remove();
    assert.equal(existsSync(d.path), false);
  } finally {
    det.restore();
  }
  assert.equal(process.pid, realPid);
  assert.notEqual(mkdtempSync(join(root, "x-")), join(root, "x-000007"), "random names again after restore");
});

/**
 * 一个文件运行时的静态 import（用 TypeScript 解析，什么写法都算：import x / import {…} / import * as / import "x" / export … from / import x = require）；
 * import type、export type 编译后就没了，不算；import { type X } 还在（verbatimModuleSyntax 留着这一句），算
 */
function runtimeImports(file: string): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly) out.push((st.moduleSpecifier as ts.StringLiteral).text);
    else if (ts.isExportDeclaration(st) && st.moduleSpecifier && !st.isTypeOnly) out.push((st.moduleSpecifier as ts.StringLiteral).text);
    else if (ts.isImportEqualsDeclaration(st) && !st.isTypeOnly && ts.isExternalModuleReference(st.moduleReference)) out.push((st.moduleReference.expression as ts.StringLiteral).text);
  }
  return out;
}

/**
 * 一个文件里路径写死了的动态 import("…")，在哪儿都算（函数里的、箭头函数里的）。skipIn：不看的顶层声明（函数名、const 的名字）——
 * 那几处的 import 只有场景子进程走得到
 */
function dynamicImports(file: string, skipIn: readonly string[] = []): string[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const namesOf = (st: ts.Statement): string[] => (ts.isFunctionDeclaration(st) && st.name ? [st.name.text]
    : ts.isVariableStatement(st) ? st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : [])) : []);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [spec] = node.arguments;
      if (spec && ts.isStringLiteralLike(spec)) out.push(spec.text);
    }
    ts.forEachChild(node, visit);
  };
  for (const st of sf.statements) if (!namesOf(st).some((n) => skipIn.includes(n))) visit(st);
  return out;
}

test("parity import-graph reader: every static import / export-from form counts, type-only ones do not; dynamic imports with a literal specifier are found wherever they are, except in the declarations it is told to skip", () => {
  const f = join(tmpDir("hh-parity-graph-"), "x.ts");
  writeFileSync(f, [
    "import a from './a.ts'", "import { b } from \"./b.ts\"", "import * as c from './c.ts';", "import './d.ts'",
    "export { e } from './e.ts'", "export * from './f.ts'", "import { type G } from './g.ts'", "import h = require('./h.ts')",
    "import type { T } from './t.ts'", "export type { U } from './u.ts'", "const lazy = () => import('./lazy.ts')",
    "  import   spaced   from   './i.ts'",
    "async function parent(name: string) { if (name) { const { x } = await import(\"./deep.ts\"); return x; } return import(name); }",
    "async function child() { return (await import('./tree.ts')).y; }",
    "export const LOADERS = [{ load: async () => (await import(`./scenarios/one.ts`)).one }];",
  ].join("\n"));
  assert.deepEqual(runtimeImports(f), ["./a.ts", "./b.ts", "./c.ts", "./d.ts", "./e.ts", "./f.ts", "./g.ts", "./h.ts", "./i.ts"]);
  assert.deepEqual(dynamicImports(f), ["./lazy.ts", "./deep.ts", "./tree.ts", "./scenarios/one.ts"], "a computed specifier (import(name)) cannot be followed and is not listed");
  assert.deepEqual(dynamicImports(f, ["child", "LOADERS"]), ["./lazy.ts", "./deep.ts"]);
});

test("parity parent process loads no tree code: main.ts reaches — statically, and through every dynamic import outside the scenario child's own functions and the scenario loaders — only node:*, the typescript parser and tree-free parity files", () => {
  const dir = dirname(MAIN);
  // 只有场景子进程走得到的那几处：main.ts 里子进程的身子和它找配置的函数、scenario.ts 里各场景的加载函数
  const CHILD_ONLY: Record<string, readonly string[]> = { "main.ts": ["child", "stateConfigRel"], "scenario.ts": ["SCENARIOS"] };
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of [...runtimeImports(file), ...dynamicImports(file, CHILD_ONLY[relative(dir, file)] ?? [])]) {
      // determinism.ts 要赶在 node:sqlite 第一次被当 ES 模块 import 之前包它的 backup：场景子进程一起来就加载的这几个文件不能 import 它
      assert.notEqual(spec, "node:sqlite", `${relative(dir, file)} imports node:sqlite before determinism can wrap its backup`);
      // typescript：census 用的解析器，是依赖，不是树里的代码
      if (spec.startsWith("node:") || spec === "typescript") continue;
      assert.ok(spec.startsWith("./"), `${relative(dir, file)} imports ${spec}: the parent process would load code outside src/parity`);
      visit(resolve(dirname(file), spec));
    }
  };
  visit(MAIN);
  assert.deepEqual([...seen].map((f) => relative(dir, f)).sort(), ["census.ts", "clone.ts", "determinism.ts", "diff.ts", "fence.ts", "main.ts", "offline.ts", "recorder.ts", "sandbox.ts", "scenario.ts"]);
  // 跳过的那几处确实通到树里（不跳这个测试就该挂），而且只有它们
  assert.deepEqual(dynamicImports(MAIN).filter((s) => !dynamicImports(MAIN, CHILD_ONLY["main.ts"]).includes(s)).sort(), ["../config.ts", "./fakes.ts", "./world.ts"]);
  const loaders = dynamicImports(join(dir, "scenario.ts"));
  assert.ok(loaders.length >= 6 && loaders.every((s) => s.startsWith("./scenarios/")), loaders.join(", "));
});

test("parity fence, guarded tier: reads work; writes, hard links and copies out of it, and its secrets.json are refused and recorded", () => {
  const root = tmpDir("hh-parity-fence-");
  const g = join(root, "guarded");
  mkdirSync(join(g, "x"), { recursive: true });
  writeFileSync(join(g, "notes.md"), "可以读");
  writeFileSync(join(g, "x", "secrets.json"), "{}");
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(join(root, "live"), { guarded: [g], sink: rec });
  try {
    assert.equal(readFileSync(join(g, "notes.md"), "utf8"), "可以读");
    assert.deepEqual(readdirSync(g).sort(), ["notes.md", "x"]);
    assert.throws(() => writeFileSync(join(g, "new.txt"), "x"), REFUSED);
    assert.throws(() => linkSync(join(g, "notes.md"), join(root, "h")), REFUSED);
    assert.throws(() => copyFileSync(join(g, "notes.md"), join(root, "c")), REFUSED);
    assert.throws(() => readFileSync(join(g, "x", "secrets.json"), "utf8"), REFUSED);
  } finally {
    uninstall();
  }
  assert.deepEqual(recordsOf(rec).map((r) => [r.api, r.path]), [
    ["fs.writeFileSync", join(g, "new.txt")], ["fs.linkSync", join(g, "notes.md")], ["fs.copyFileSync", join(g, "notes.md")], ["fs.readFileSync", join(g, "x", "secrets.json")],
  ]);
  for (const f of [join(g, "new.txt"), join(root, "h"), join(root, "c")]) assert.equal(existsSync(f), false, f);
});

test("parity fencedHomes: the dump child guards the running user's own home next to the snapshot's", () => {
  assert.deepEqual(fencedHomes("/snapshot/home"), ["/snapshot/home", userInfo().homedir]);
});

test("parity fence: descriptor and FileHandle metadata changes are refused outright (a read-only fd in a guarded home could otherwise chmod / utimes)", async () => {
  const root = tmpDir("hh-parity-fence-");
  const g = join(root, "guarded");
  mkdirSync(g);
  writeFileSync(join(g, "x"), "可以读");
  const before = statSync(join(g, "x"));
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(join(root, "live"), { guarded: [g], sink: rec });
  let fd = -1;
  let fh: fs.promises.FileHandle | undefined;
  try {
    fd = openSync(join(g, "x"), "r");
    assert.throws(() => fs.fchmodSync(fd, 0o600), /^Error: parity: refusing to change file metadata through a descriptor \(fs\.fchmodSync\)$/);
    assert.throws(() => fs.futimesSync(fd, 1, 1), /fs\.futimesSync/);
    assert.throws(() => fs.fchown(fd, 0, 0, () => {}), /fs\.fchown/);
    fh = await fs.promises.open(join(g, "x"), "r");
    await assert.rejects(fh.utimes(1, 1), /FileHandle\.utimes/);
    await assert.rejects(fh.chmod(0o600), /FileHandle\.chmod/);
    assert.equal(readFileSync(join(g, "x"), "utf8"), "可以读");
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    await fh?.close();
    uninstall();
  }
  const after = statSync(join(g, "x"));
  assert.deepEqual([after.mode, after.mtimeMs], [before.mode, before.mtimeMs], "mode and mtime unchanged");
  assert.deepEqual(recordsOf(rec).map((r) => [r.kind, r.api, r.path]), [
    ["refused", "fs.fchmodSync", "<fd>"], ["refused", "fs.futimesSync", "<fd>"], ["refused", "fs.fchown", "<fd>"],
    ["refused", "FileHandle.utimes", "<fd>"], ["refused", "FileHandle.chmod", "<fd>"],
  ]);
  // 拆了以后都回来了
  writeFileSync(join(root, "y"), "y");
  const h = await fs.promises.open(join(root, "y"), "r");
  await h.chmod(0o600);
  await h.close();
  const fd2 = openSync(join(root, "y"), "r");
  fs.fchmodSync(fd2, 0o640);
  fs.closeSync(fd2);
  assert.equal(mode(join(root, "y")), 0o640);
});

test("parity fence: a read call with a writing flag is checked like a write (readFile flag w / a, createReadStream flags w)", async () => {
  const root = tmpDir("hh-parity-fence-");
  const scratch = join(root, "work");
  const g = join(root, "guarded");
  mkdirSync(scratch);
  mkdirSync(g);
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "原样");
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(join(root, "live"), { scratch: [scratch], guarded: [g], sink: rec });
  try {
    assert.throws(() => readFileSync(outside, { encoding: "utf8", flag: "w" }), /outside the scratch area/);
    await assert.rejects(fs.promises.readFile(join(g, "x"), { flag: "a" }), REFUSED);
    assert.throws(() => fs.readFile(outside, { flag: "w" }, () => {}), /outside the scratch area/);
    assert.throws(() => fs.createReadStream(outside, { flags: "w" }), /outside the scratch area/);
    assert.equal(readFileSync(outside, "utf8"), "原样", "a plain read outside the scratch area still works");
  } finally {
    uninstall();
  }
  assert.equal(readFileSync(outside, "utf8"), "原样", "not truncated");
  assert.equal(existsSync(join(g, "x")), false, "not created");
  assert.deepEqual(recordsOf(rec).map((r) => [r.api, r.path]), [
    ["fs.readFileSync", outside], ["fs.promises.readFile", join(g, "x")], ["fs.readFile", outside], ["fs.createReadStream", outside],
  ]);
});

test("parity fence, with a scratch area: a hard link must come from inside it and a symlink must point inside it (after resolving links)", () => {
  const root = tmpDir("hh-parity-fence-");
  const scratch = join(root, "work");
  mkdirSync(scratch);
  mkdirSync(join(root, "elsewhere"));
  writeFileSync(join(root, "elsewhere", "victim.txt"), "原样");
  writeFileSync(join(scratch, "a.txt"), "里面的");
  symlinkSync(join(root, "elsewhere"), join(scratch, "door"));   // 草稿区里一个指到外面的目录链接（装围栏之前就有）
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(join(root, "home"), { scratch: [scratch], sink: rec });
  const LINK = /^Error: parity: refusing to hard-link a file from outside the scratch area \(/;
  const SYMLINK = /^Error: parity: refusing to symlink to a target outside the scratch area \(/;
  try {
    assert.throws(() => linkSync(join(root, "elsewhere", "victim.txt"), join(scratch, "alias")), LINK);
    assert.throws(() => linkSync(join(scratch, "door", "victim.txt"), join(scratch, "alias2")), LINK, "a source that only looks inside");
    assert.throws(() => symlinkSync(join(root, "elsewhere", "victim.txt"), join(scratch, "s1")), SYMLINK);
    assert.throws(() => symlinkSync("../elsewhere/victim.txt", join(scratch, "s2")), SYMLINK, "a relative target counts from the link's directory");
    assert.throws(() => symlinkSync(join(scratch, "door", "new.txt"), join(scratch, "s3")), SYMLINK, "a target that only looks inside");
    assert.throws(() => symlinkSync(join(root, "home", "x"), join(scratch, "s4")), REFUSED, "into the live home keeps the live-home refusal");
    linkSync(join(scratch, "a.txt"), join(scratch, "b.txt"));
    symlinkSync("a.txt", join(scratch, "rel"));
    // 树会拿 realpath 过的路径当目标（materializeSkillsPlugin）：字面上不以 --work 开头也算在里面
    symlinkSync(realpathSync(join(scratch, "a.txt")), join(scratch, "real"));
  } finally {
    uninstall();
  }
  for (const f of ["alias", "alias2", "s1", "s2", "s3", "s4"]) assert.throws(() => fs.lstatSync(join(scratch, f)), /ENOENT/, f);
  assert.deepEqual([statSync(join(root, "elsewhere", "victim.txt")).nlink, readFileSync(join(root, "elsewhere", "victim.txt"), "utf8")], [1, "原样"]);
  assert.deepEqual(["b.txt", "rel", "real"].map((f) => readFileSync(join(scratch, f), "utf8")), ["里面的", "里面的", "里面的"]);
  assert.deepEqual(recordsOf(rec).map((r) => [r.api, r.path]), [
    ["fs.linkSync", join(root, "elsewhere", "victim.txt")], ["fs.linkSync", join(scratch, "door", "victim.txt")],
    ["fs.symlinkSync", join(root, "elsewhere", "victim.txt")], ["fs.symlinkSync", "../elsewhere/victim.txt"], ["fs.symlinkSync", join(scratch, "door", "new.txt")],
    ["fs.symlinkSync", join(root, "home", "x")],
  ]);
});

test("parity fence: chdir, a signal to another process, a Worker and module.register are refused and recorded; the process may still signal itself (also under its fixed pid)", () => {
  const root = tmpDir("hh-parity-fence-");
  const cwd = process.cwd();
  const originals = [process.chdir, process.kill, Worker, register];
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(join(root, "home"), { sink: rec });
  try {
    assert.throws(() => process.chdir(root), /^Error: parity: refusing to change the working directory \(/);
    // 信号 0 只是问一声在不在：就算没拦住也什么都不会发生
    assert.throws(() => process.kill(process.ppid, 0), /^Error: parity: refusing to signal another process \(\d+\)$/);
    assert.throws(() => process.kill(0, 0), /refusing to signal another process \(0\)/, "the process group is not the process itself");
    assert.equal(process.kill(process.pid, 0), true);
    assert.throws(() => new Worker("process.exit(0)", { eval: true }), /^Error: parity: refusing to start a worker thread \(process\.exit\(0\)\)$/);
    assert.throws(() => register("./hooks.mjs", import.meta.url), /^Error: parity: refusing to register module hooks \(\.\/hooks\.mjs\)$/);
    // 场景子进程里 process.pid 是换过的固定号：发给它就是发给自己
    const det = installDeterminism(TAKEN_AT);
    try {
      assert.equal(process.kill(PARITY_PID, 0), true);
    } finally {
      det.restore();
    }
  } finally {
    uninstall();
  }
  assert.equal(process.cwd(), cwd);
  assert.deepEqual(recordsOf(rec).map((r) => [r.kind, r.api, r.path]), [
    ["refused", "process.chdir", root], ["refused", "process.kill", `<pid ${process.ppid}>`], ["refused", "process.kill", "<pid 0>"],
    ["refused", "worker_threads.Worker", "process.exit(0)"], ["refused", "module.register", "./hooks.mjs"],
  ]);
  assert.deepEqual([process.chdir, process.kill, Worker, register], originals, "restored");
});

test("parity clone: snapshot symlinks are created as input, past the scratch-tier rule — one into the manifest's home is re-pointed into the clone (dangling when its target is not there), the others stay verbatim; nothing is recorded; a link inside a read-only directory is cloned and the clone can be repeated; a link the tree makes afterwards is still refused", () => {
  const root = tmpDir("hh-parity-clone-");
  const live = join(root, "live-home");
  const src = join(root, "snapshot", "home");
  const work = join(root, "work");
  mkdirSync(join(src, "ws", "dir"), { recursive: true });
  mkdirSync(work);
  writeFileSync(join(src, "ws", "a.txt"), "甲");
  writeFileSync(join(src, "ws", "secrets.json"), "{}");
  const links: Record<string, string> = {
    "ws/system": "/usr/bin/true",
    "ws/relative": "a.txt",
    "ws/dir/up": "../a.txt",
    "ws/home-file": join(live, "ws", "a.txt"),
    "ws/home-dir": join(live, "ws", "dir"),
    "ws/home-missing": join(live, "not", "in", "the", "snapshot"),
    // 字面上以真 home 开头、其实指到它外面的；名字只是跟真 home 同一个开头的：都不是「在真 home 里」
    "ws/home-dotdot": `${live}/ws/../../elsewhere`,
    "ws/sibling": `${live}2/x`,
  };
  for (const [rel, target] of Object.entries(links)) symlinkSync(target, join(src, rel));
  symlinkSync("a.txt", join(src, "ws", "dir", "secrets.json"));   // 叫 secrets.json 的，是链接也不拷
  // 只读的目录（0555）里也有链接和文件：克隆得建得进去，下一次克隆还得删得掉上一次的
  mkdirSync(join(src, "ws", "readonly", "deeper"), { recursive: true });
  writeFileSync(join(src, "ws", "readonly", "deeper", "b.txt"), "乙");
  symlinkSync("../a.txt", join(src, "ws", "readonly", "up"));
  for (const d of ["ws/readonly/deeper", "ws/readonly"]) fs.chmodSync(join(src, d), 0o555);
  const rec = new Recorder({ t0: 0, now: () => 0, roots: {} });
  const uninstall = installFence(live, { scratch: [work], sink: rec });
  const cloned = join(work, "home");
  try {
    cloneSnapshot(join(root, "snapshot"), work, live);
    assert.deepEqual([readlinkSync(join(cloned, "ws", "readonly", "up")), readFileSync(join(cloned, "ws", "readonly", "up"), "utf8"), mode(join(cloned, "ws", "readonly")), mode(join(cloned, "ws", "readonly", "deeper"))],
      ["../a.txt", "甲", 0o555, 0o555], "a link inside a read-only directory is cloned, and the directory keeps its mode");
    writeFileSync(join(cloned, "ws", "left-over.txt"), "上一次留下的");
    cloneSnapshot(join(root, "snapshot"), work, live);   // 同一个 --work 再克隆一次（dump 每个场景都这样）
    assert.equal(existsSync(join(cloned, "ws", "left-over.txt")), false, "the previous clone, read-only directories and all, was removed first");
    assert.equal(readFileSync(join(cloned, "ws", "readonly", "deeper", "b.txt"), "utf8"), "乙");
    assert.throws(() => symlinkSync("/usr/bin/true", join(work, "home", "ws", "mine")), /refusing to symlink to a target outside the scratch area/);
  } finally {
    uninstall();
    // 测试的临时目录退出时要删得掉
    for (const base of [src, cloned]) for (const d of ["ws/readonly", "ws/readonly/deeper"]) { try { fs.chmodSync(join(base, d), 0o755); } catch { /* 没建出来 */ } }
  }
  assert.deepEqual(Object.fromEntries(Object.keys(links).map((rel) => [rel, readlinkSync(join(cloned, rel))])), {
    ...links,
    "ws/home-file": join(cloned, "ws", "a.txt"), "ws/home-dir": join(cloned, "ws", "dir"), "ws/home-missing": join(cloned, "not", "in", "the", "snapshot"),
  });
  assert.equal(readFileSync(join(cloned, "ws", "home-file"), "utf8"), "甲", "the re-pointed link reads the clone's file");
  assert.deepEqual(readdirSync(join(cloned, "ws", "home-dir")), ["up"], "and the re-pointed directory link lists the clone's directory");
  assert.equal(existsSync(join(cloned, "ws", "home-missing")), false, "dangling, as in the snapshot");
  for (const f of ["ws/secrets.json", "ws/dir/secrets.json", "ws/mine"]) assert.throws(() => fs.lstatSync(join(cloned, f)), /ENOENT/, f);
  assert.deepEqual([mode(cloned), mode(join(work, "tmp"))], [0o700, 0o700]);
  assert.deepEqual(recordsOf(rec).map((r) => [r.kind, r.api, r.path]), [["refused", "fs.symlinkSync", "/usr/bin/true"]], "the clone's own links leave no record");
});

test("parity dump: --work must be absent, empty or carry the tool's own marker — any other directory is refused (exit 2) and left as it was; the marker is written on first use", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const out = join(root, "out");
  // 路径给错了：一个别人的目录，里面正好有 home
  const theirs = join(root, "theirs");
  mkdirSync(join(theirs, "home"), { recursive: true });
  writeFileSync(join(theirs, "home", "notes.md"), "别人的东西");
  const r = dump("--data", snap.data, "--work", theirs, "--out", out, "--scenario", "boot");
  assert.deepEqual([r.status, r.stdout, r.stderr], [2, "", `parity: --work must be absent, empty, or a scratch directory of this tool (${theirs} has 1 entries and no .parity-work marker)\n`]);
  assert.equal(readFileSync(join(theirs, "home", "notes.md"), "utf8"), "别人的东西");
  assert.equal(existsSync(out), false, "nothing was created");
  writeFileSync(join(root, "file"), "x");
  assert.equal(dump("--data", snap.data, "--work", join(root, "file"), "--out", out, "--scenario", "boot").stderr,
    `parity: --work must be absent, empty, or a scratch directory of this tool (${join(root, "file")} is not a directory)\n`);
  // 记号得是个普通文件：一个叫这名字的链接不算
  symlinkSync(join(theirs, "home", "notes.md"), join(theirs, ".parity-work"));
  assert.equal(dump("--data", snap.data, "--work", theirs, "--out", out, "--scenario", "boot").status, 2);

  // 空目录照用，第一次用时写下记号；有记号的目录以后接着用（1 毫秒的时限：只看它过了这一关）
  const mine = join(root, "mine");
  mkdirSync(mine);
  for (const o of ["out1", "out2"]) {
    const ok = dump("--data", snap.data, "--work", mine, "--out", join(root, o), "--scenario", "boot", "--timeout-ms", "1");
    assert.equal(ok.status, 1, ok.stderr);
    assert.match(ok.stdout, /FAILED \(timed out after 1 ms\)/);
    assert.ok(statSync(join(mine, ".parity-work")).isFile() && mode(join(mine, ".parity-work")) === 0o600);
  }
});

test("parity dump: --out must be empty or absent — a directory with anything in it is refused (exit 2) and left exactly as it was; an empty one is used", () => {
  const root = tmpDir("hh-parity-");
  const snap = buildSnapshot(root);
  const work = join(root, "work");
  const out = join(root, "out");
  // 上一次留下的：一份都 ok 的 meta.json 和它的记录
  const stale: Record<string, string> = {
    "meta.json": JSON.stringify({ snapshot: "fixture-1", scenarios: [{ name: "boot", records: 1, ok: true }] }),
    "boot/transcript.jsonl": "{\"kind\":\"log\",\"n\":0,\"t\":0}\n",
  };
  mkdirSync(join(out, "boot"), { recursive: true });
  for (const [rel, text] of Object.entries(stale)) writeFileSync(join(out, rel), text);
  const r = dump("--data", snap.data, "--work", work, "--out", out, "--scenario", "boot");
  assert.equal(r.status, 2);
  assert.equal(r.stderr, `parity: --out must be empty or absent (${out} has 2 entries)\n`);
  assert.equal(r.stdout, "");
  assert.deepEqual(readdirSync(out).sort(), ["boot", "meta.json"]);
  for (const [rel, text] of Object.entries(stale)) assert.equal(readFileSync(join(out, rel), "utf8"), text, `${rel} is untouched`);
  assert.equal(existsSync(work), false, "nothing was created");

  writeFileSync(join(root, "file"), "x");
  const f = dump("--data", snap.data, "--work", work, "--out", join(root, "file"), "--scenario", "boot");
  assert.deepEqual([f.status, f.stderr], [2, `parity: --out must be empty or absent (${join(root, "file")} is not a directory)\n`]);

  // 空目录照用（1 毫秒的时限：只看它过了这一关、往里写了 meta.json）
  mkdirSync(join(root, "empty"));
  const e = dump("--data", snap.data, "--work", work, "--out", join(root, "empty"), "--scenario", "boot", "--timeout-ms", "1");
  assert.equal(e.status, 1, e.stderr);
  assert.ok(existsSync(join(root, "empty", "meta.json")));
});
