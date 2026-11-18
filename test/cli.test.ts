// hh 命令行：认 --help 只打用法、tell 要写清是谁、空消息不发（CEO 11-13：hh tell 不带 --from 记成主人说的，--help 被当成一条消息发给她）
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse, wantsHelp, usage, ownerNameOf } from "../src/cli-parse.ts";
import { UsageError } from "../src/control.ts";
import { loadConfig } from "../src/config.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { setLang } from "../src/lang/index.ts";

// this file asserts the Chinese pack's text
setLang("zh");

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// 真跑的子进程一律用临时的状态目录和工作区：当时默认配置的 stateDir 就是她线上的 ~/.hh，以 mira 跑测试时 socket 就是线上 hhd 的
// （配置分层以后默认配置里没有 stateDir 了，没带实例配置的 hh 一启动就报错退出；临时配置照样留着）。
// 11-13 08:30 变异检查拿掉了保护，这条测试用默认配置真连上了线上 hhd，以主人的名义给她发了「在吗」、又发了一条空的（CEO 发现）
const SANDBOX = tmpDir("hh-cli-");
const SANDBOX_CFG = join(SANDBOX, "config.json");
// 名字也给上：默认配置里没有名字了，闸门默认开着，没名字 hh 一启动就停在 requireInstance（退出码 1），走不到下面要测的用法错误（退出码 2）
writeFileSync(SANDBOX_CFG, JSON.stringify({ lang: "zh", stateDir: join(SANDBOX, "state"), workspace: join(SANDBOX, "ws"), names: { me: "阿青", owner: "老林", notMe: [] } }));
const env = (): NodeJS.ProcessEnv => { const e: NodeJS.ProcessEnv = { ...process.env, HH_CONFIG: SANDBOX_CFG }; delete e.HH_SESSION; return e; };
const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: env(), timeout: 20_000 });

test("--help / -h 在哪个位置都只打用法；help 只认头一个；话里带着这几个字不算", () => {
  for (const a of [["--help"], ["-h"], ["help"], ["tell", "--help"], ["tell", "--from", "运维", "--help"], ["tell", "-h"], ["send", "某人", "--help"], ["wake", "main", "--help"], ["sense", "-h"], ["deploy", "--help"], ["fix", "check", "-h"], ["numbers", "--help"], ["modules", "run", "--help"], ["modules", "run", "goals", "-h"]]) {
    assert.ok(wantsHelp(a), a.join(" "));
  }
  for (const a of [[], ["status"], ["tell", "--from", "运维", "教她 --help 是什么意思"], ["tell", "--from", "运维", "help"], ["mem", "stats"], ["modules", "run", "goals", "goals.py", "--help"]]) {
    assert.ok(!wantsHelp(a), a.join(" "));
  }
  const u = usage();
  assert.match(u, /^hh：控制台命令。/);
  assert.match(u, /hh tell --from <是谁> "话"/);
  assert.doesNotMatch(u, /^import /m, "只到注释为止");
});

test("tell：写了 --from 照发；不写 --from 不是终端就拒绝（不再默认记成主人）；是终端按名单里的主人发", () => {
  assert.deepEqual(parse(["tell", "--from", "运维（Claude Code）", "跟你说", "一件事"]), { cmd: "tell", from: "运维（Claude Code）", text: "跟你说 一件事" });
  assert.throws(() => parse(["tell", "在吗"]), (e: unknown) => e instanceof UsageError && /要写 --from <是谁>/.test(e.message));
  assert.throws(() => parse(["tell", "在吗"], { interactive: false, owner: () => "某主人" }), UsageError, "会话、脚本里跑：有主人也不替它署名");
  assert.deepEqual(parse(["tell", "在吗"], { interactive: true, owner: () => "某主人" }), { cmd: "tell", from: "某主人", text: "在吗" });
  assert.throws(() => parse(["tell", "在吗"], { interactive: true, owner: () => null }), /认不出主人/);
});

test("tell：空消息、--from 后面没写人都拒绝，不发", () => {
  for (const a of [["tell"], ["tell", "--from", "运维"], ["tell", "--from", "运维", "   "], ["tell", "--from", "运维", ""]]) {
    assert.throws(() => parse(a), (e: unknown) => e instanceof UsageError && /空消息不发/.test(e.message), a.join("|"));
  }
  assert.throws(() => parse(["tell", "--from"], { interactive: true, owner: () => "某主人" }), /--from 后面要写是谁/);
  assert.throws(() => parse(["tell", "--from", "--x", "话"]), /--from 后面要写是谁/);
  assert.throws(() => parse(["tell"], { interactive: true, owner: () => "某主人" }), /空消息不发/, "终端里也不发空的");
});

test("名单里的主人：privacy 是 owner 的那一条，name 没写用 key；没有主人是 null", () => {
  assert.equal(ownerNameOf({ _meta: { privacy: "owner" }, a: { privacy: "guest", name: "访客甲" }, boss: { privacy: "owner", name: "某主人" } }), "某主人");
  assert.equal(ownerNameOf({ boss: { privacy: "owner" } }), "boss");
  assert.equal(ownerNameOf({ a: { privacy: "guest" }, b: "坏的一条" }), null);
});

test("真跑 hh 的子进程碰不到线上：配置指到临时目录，连 hhd 时连的是不存在的 socket（保护坏了也只是退出码 1，不会发给她）", () => {
  const live = loadConfig().stateDir;
  const prev = process.env.HH_CONFIG;
  process.env.HH_CONFIG = SANDBOX_CFG;
  try { assert.equal(loadConfig().stateDir, join(SANDBOX, "state")); } finally { if (prev === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = prev; }
  assert.notEqual(join(SANDBOX, "state"), live);
  const s = run("status");
  assert.equal(s.status, 1, "状态目录是空的：连不上，退出码 1");
  assert.match(s.stderr, /ENOENT|ECONNREFUSED|hh\.sock/);
  assert.ok(s.stderr.includes(SANDBOX), `连的是临时目录里的 socket：${s.stderr.slice(0, 200)}`);
});

test("真跑 hh：--help 打用法、退出码 0、不连 hhd；tell 不写 --from（不是终端）退出码 2、说清要写是谁", () => {
  const h = run("tell", "--help");
  assert.equal(h.status, 0, h.stderr);
  assert.match(h.stdout, /hh tell --from <是谁>/);
  const t = run("tell", "在吗");
  assert.equal(t.status, 2, t.stdout + t.stderr);
  assert.match(t.stderr, /要写 --from <是谁>/);
  const e = run("tell", "--from", "运维");
  assert.equal(e.status, 2);
  assert.match(e.stderr, /空消息不发/);
});

test("真跑 hh 没带实例配置：退出码 1、报的话和以前一样，并且在给定的留痕文件里留下一行（只记第一个参数）", () => {
  const trace = join(SANDBOX, "misconfig.jsonl");
  const e = env();
  delete e.HH_CONFIG;
  e.HH_TEST = "1";   // 不靠继承来的 NODE_TEST_CONTEXT：不管这个文件怎么起，子进程都不会写真的留痕位置
  e.HH_MISCONFIG_TRACE_FILE = trace;
  const r = spawnSync(process.execPath, [CLI, "status", "--secret-looking-arg"], { encoding: "utf8", env: e, timeout: 20_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /^config: (workspace|stateDir) is not set .*\(HH_CONFIG is not set\)\n$/);
  const lines = readFileSync(trace, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]!) as { sub: string; what: string; cwd: string; parent: string; t: number };
  assert.equal(rec.sub, "status");
  assert.match(rec.what, /is not set/);
  assert.ok(!lines[0]!.includes("secret-looking"));
  // 没给测试用的路径变量：什么都不写（测试进程里绝不碰真的 /tmp/hh-misconfig-*）
  delete e.HH_MISCONFIG_TRACE_FILE;
  const r2 = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8", env: e, timeout: 20_000 });
  assert.equal(r2.status, 1);
  assert.equal(readFileSync(trace, "utf8").split("\n").filter(Boolean).length, 1);
});

test("真跑 hh：留痕路径是个命名管道也不卡：照样先打出报错、退出码 1", (t) => {
  const fifo = join(SANDBOX, "fifo.jsonl");
  if (spawnSync("/usr/bin/mkfifo", [fifo]).status !== 0) { t.skip("mkfifo is not available on this machine"); return; }
  const e = env();
  delete e.HH_CONFIG;
  e.HH_TEST = "1";
  e.HH_MISCONFIG_TRACE_FILE = fifo;
  const r = spawnSync(process.execPath, [CLI, "status"], { encoding: "utf8", env: e, timeout: 20_000 });
  assert.equal(r.error, undefined, "卡住被超时杀掉了");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not set/);
});

test("hh tell with no channel: waits for the turn on it and prints what the main region said (the local way back)", async () => {
  const { createServer } = await import("node:net");
  const { spawn } = await import("node:child_process");
  const dir = tmpDir("hh-cli-local-");
  const cfgFile = join(dir, "config.json");
  writeFileSync(cfgFile, JSON.stringify({ stateDir: join(dir, "state"), workspace: join(dir, "ws"), names: { me: "阿青", owner: "老林", notMe: [] } }));
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(dir, "state"), { recursive: true });
  // a fake hhd: the turn is under way at the first look, done at the second
  let looks = 0;
  const answer = (req: { cmd: string; n?: number }): unknown => {
    if (req.cmd === "tell") return { result: "delivered" };
    if (req.cmd === "status") return { regions: [{ id: "main", busy: looks < 2 }] };
    if (req.n === 1) return [{ seq: 5, src: "外界", kind: "input", text: "早先的话" }];
    looks += 1;
    return looks < 2 ? [] : [{ seq: 5, src: "main", kind: "say", text: "早先说的" }, { seq: 6, src: "main", kind: "say", text: "收到，这就去" }, { seq: 7, src: "main", kind: "act", text: "x" }];
  };
  const server = createServer((s) => s.on("data", (c) => s.end(`${JSON.stringify({ ok: true, data: answer(JSON.parse(c.toString())) })}\n`)));
  await new Promise<void>((r) => server.listen(join(dir, "state", "hh.sock"), r));
  const out = await new Promise<string>((resolve) => {
    let text = "";
    const p = spawn(process.execPath, [CLI, "tell", "--from", "老林", "在吗"], { env: { ...process.env, HH_CONFIG: cfgFile } });
    p.stdout.on("data", (c) => { text += c.toString(); });
    p.on("close", () => resolve(text));
  });
  server.close();
  assert.equal(out.trim(), "收到，这就去");
});

test("operator commands in a role's own session (CLAUDECODE=1): refused with the owner's name; HH_OPERATOR=1 or no session lets them through; read-only ones are not held", () => {
  const REFUSED = "这是操作员的命令，请 老林 来跑。\n";
  const go = (extra: Record<string, string>, ...args: string[]) => {
    const e = env();
    delete e.CLAUDECODE; delete e.HH_OPERATOR;
    return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...e, ...extra }, timeout: 20_000 });
  };
  for (const args of [["channels", "add", "qq"], ["channels", "link", "whatsapp"], ["channels", "remove", "qqbot"], ["modules", "install"], ["new", "x", "--owner", "y"], ["console"]]) {
    const r = go({ CLAUDECODE: "1" }, ...args);
    assert.equal(r.stderr, REFUSED, args.join(" "));
    assert.notEqual(r.status, 0);
  }
  // let through: each of these then stops on its own complaint about what it was given (nothing is installed by this test)
  for (const extra of [{ CLAUDECODE: "1", HH_OPERATOR: "1" }, {}] as Array<Record<string, string>>) {
    for (const args of [["channels", "add", "nope"], ["channels", "link", "nope"], ["channels", "remove"], ["new"]]) {
      const r = go(extra, ...args);
      assert.match(r.stderr, /usage: /, args.join(" "));
      assert.ok(!r.stderr.includes("操作员"));
    }
  }
  const look = go({ CLAUDECODE: "1" }, "channels");
  assert.equal(look.status, 0, look.stderr);
  assert.ok(!go({ CLAUDECODE: "1" }, "modules", "doctor").stderr.includes("操作员"));
});
