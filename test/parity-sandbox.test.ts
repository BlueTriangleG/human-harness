// 对照工具的内核沙箱（src/parity/sandbox.ts）：profile 的字；套上以后 JS 围栏包不住的那些路都写不出草稿区、连不出去、信号发不给别的进程，
// 草稿区里照常（不套沙箱的对照里它们都成）；dump 起的场景子进程真在沙箱里（测试的探针脚本在子进程里走原生的路往外写，写不出去；
// --no-sandbox 时写得出去）、它的环境是从头列的、围栏守着跑它的用户自己的 home、快照里的链接照规矩克隆而树自己建的照旧拦；
// 子进程往 --out 里放的 meta.json 父进程不盖；套不上沙箱时 dump 不跑、什么都不建。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_EXEC, insideSandbox, sandboxProblem, sandboxProfile, sandboxed } from "../src/parity/sandbox.ts";
import { buildSnapshot, upToState, WORKSPACE_REL } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";

const MAIN = resolve(fileURLToPath(import.meta.url), "../../src/parity/main.ts");
const ESCAPE = resolve(fileURLToPath(import.meta.url), "../parity/sandbox-escape.run.ts");
const NO_SANDBOX = "parity: no kernel sandbox on this machine — scenario children would run unconfined; pass --no-sandbox to run anyway";
/** 名字里带双引号、反斜杠、空格、汉字的草稿目录：profile 里转义错一个，里面就写不进去 */
const AWKWARD = "wo\"rk \\ 草稿";

test("sandbox profile: the real paths of --work and --out (symlinks resolved, a directory not created yet through its parent), quotes and backslashes escaped", () => {
  const root = tmpDir("hh-parity-sbx-");
  mkdirSync(join(root, "real"));
  symlinkSync(join(root, "real"), join(root, "link"));
  const real = join(realpathSync(root), "real");
  assert.equal(sandboxProfile(join(root, "link", AWKWARD), join(root, "link", "out")), [
    "(version 1)(allow default)(deny network*)(deny file-write*)",
    `(allow file-write* (subpath "${real}/wo\\"rk \\\\ 草稿") (subpath "${real}/out") (literal "/dev/null") (literal "/dev/stdout")`,
    "  (literal \"/dev/stderr\") (regex #\"^/dev/fd/\") (literal \"/dev/dtracehelper\"))",
    `(deny file-read* (require-all (regex #"/secrets\\.json$") (require-not (subpath "${real}/wo\\"rk \\\\ 草稿"))))`,
    "(deny signal)(allow signal (target self))",
  ].join("\n"));
  assert.equal(existsSync(join(root, "real", AWKWARD)), false, "building the profile creates nothing");
  assert.equal(sandboxProblem(sandboxProfile(join(root, "work"), join(root, "out"))), null, "this machine can apply it");
  assert.match(String(sandboxProblem("(version 1)(allow default")), /could not apply the profile \(exit \d+\)/, "a profile sandbox-exec rejects is a problem, not a silent pass");
  assert.equal(insideSandbox(process.ppid), false, "this test process is not confined");
  assert.throws(() => process.kill(1, 0), /EPERM/, "launchd cannot be signalled either way");
  assert.equal(insideSandbox(1), false, "and an EPERM from a process that is not the parent does not count as confinement");
});

/** 一个目录里每样东西现在的样子：名字、是什么、内容或链接目标、权限、修改时间、链接数 */
function stateOf(dir: string): unknown[][] {
  return readdirSync(dir).sort().map((name) => {
    const st = lstatSync(join(dir, name));
    return [name, st.isFile() ? readFileSync(join(dir, name), "utf8") : st.isDirectory() ? "dir" : "other", st.mode, st.mtimeMs, st.nlink];
  });
}

/**
 * 摆好草稿区和外面；起本机的监听（TCP 一个、外面的 unix socket 一个）和一个测试自己的闲进程（脚本要去连、去杀的）；
 * 跑一遍 sandbox-escape.run.ts（套或不套沙箱），给回每一条的结果和之后的样子
 */
async function tryEscapes(sandbox: boolean) {
  const root = tmpDir("hh-parity-sbx-");
  const [work, out, outside] = [join(root, AWKWARD), join(root, "out"), join(root, "outside")];
  for (const d of [join(work, "src"), join(work, "dst"), out, outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(outside, "cp-victim.txt"), "原样");
  writeFileSync(join(outside, "linked.txt"), "原样");
  writeFileSync(join(outside, "secrets.json"), "{\"dummy\":\"outside\"}");
  writeFileSync(join(work, "secrets.json"), "{\"dummy\":\"work\"}");
  writeFileSync(join(work, "src", "f.txt"), "从草稿区拷的");
  symlinkSync(join(outside, "cp-victim.txt"), join(work, "dst", "f.txt"));

  const seen = { tcp: 0, unix: 0 };
  const server = http.createServer((_req, res) => { res.end("ok"); });
  server.on("connection", () => { seen.tcp += 1; });
  server.listen(0, "127.0.0.1");
  const unix = net.createServer((c) => { seen.unix += 1; c.destroy(); });
  unix.listen(join(outside, "listen.sock"));
  await Promise.all([once(server, "listening"), once(unix, "listening")]);
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const otherExit = once(other, "exit") as Promise<[number | null, string | null]>;
  const before = stateOf(outside);

  const args = [ESCAPE, work, out, outside, String((server.address() as AddressInfo).port), join(outside, "listen.sock"), String(other.pid)];
  const run = sandbox ? sandboxed(sandboxProfile(work, out), process.execPath, args) : { cmd: process.execPath, args };
  const child = spawn(run.cmd, run.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += String(d); });
  child.stderr.on("data", (d) => { stderr += String(d); });
  await once(child, "close");
  const after = stateOf(outside);   // 关监听之前看：unix 的监听一关，它的 socket 文件就没了
  // 那个闲进程死于什么：脚本的 SIGTERM 到了就是 SIGTERM；没到，它活到现在，死于这里补的 SIGKILL
  other.kill("SIGKILL");
  const [, otherDiedOf] = await otherExit;
  server.closeAllConnections();
  server.close();
  unix.close();
  await Promise.all([once(server, "close"), once(unix, "close")]);
  const [json, sh] = stdout.split("\n");
  assert.ok(json && sh, `the script reports its attempts and the shell its own: ${stdout}${stderr}`);
  return { work, out, outside, before, after, seen, otherDiedOf, tried: JSON.parse(json) as Record<string, unknown>, sh };
}

test("kernel sandbox: sqlite, a Worker, execve, cp through a symlink, a hard link, TCP, fetch and a unix socket cannot write or connect outside --work / --out, and no other process can be signalled; inside both, writes work", async () => {
  const r = await tryEscapes(true);
  assert.deepEqual(r.tried, {
    sqlite: "ERR_SQLITE_ERROR", worker: "EPERM", cp: "EPERM", link: "EPERM", writeAlias: "ok", tcp: "EPERM", fetch: "EPERM", unixSocket: "EPERM",
    signalOther: "EPERM", signalSelf: "ok", readOutsideSecrets: "EPERM", readWorkSecrets: "ok", writeWork: "ok", writeOut: "ok", inside: true, insideWrongParent: false,
  });
  assert.equal(r.sh, "execve: denied", "the program execve switched to is still confined");
  assert.deepEqual(r.after, r.before, "nothing outside was created, changed or linked");
  assert.deepEqual(r.seen, { tcp: 0, unix: 0 }, "neither listener saw a connection");
  assert.equal(r.otherDiedOf, "SIGKILL", "the other process was still alive when the test itself ended it");
  // 硬链接没建成：writeAlias 写的是草稿区里一个新的普通文件
  assert.equal(readFileSync(join(r.work, "alias"), "utf8"), "改了");
  assert.equal(lstatSync(join(r.work, "alias")).nlink, 1);
  assert.equal(readFileSync(join(r.work, "inside.txt"), "utf8"), "x");
  assert.equal(readFileSync(join(r.out, "inside.txt"), "utf8"), "x");
});

test("control, no sandbox: every one of those routes does write, connect or kill outside (so the test above fails for the sandbox's reason, not the script's)", async () => {
  const r = await tryEscapes(false);
  assert.deepEqual(r.tried, {
    sqlite: "ok", worker: "ok", cp: "ok", link: "ok", writeAlias: "ok", tcp: "ok", fetch: "ok", unixSocket: "ok",
    signalOther: "ok", signalSelf: "ok", readOutsideSecrets: "ok", readWorkSecrets: "ok", writeWork: "ok", writeOut: "ok", inside: false, insideWrongParent: false,
  });
  assert.equal(r.sh, "execve: ok");
  assert.deepEqual(r.after.map((e) => e[0]), ["cp-victim.txt", "escape.db", "execve.txt", "linked.txt", "listen.sock", "secrets.json", "worker.txt"]);
  assert.equal(readFileSync(join(r.outside, "cp-victim.txt"), "utf8"), "从草稿区拷的", "cp wrote through the symlink");
  assert.equal(readFileSync(join(r.outside, "linked.txt"), "utf8"), "改了", "the write went through the hard link");
  assert.deepEqual(r.seen, { tcp: 2, unix: 1 });
  assert.equal(r.otherDiedOf, "SIGTERM", "the script's signal killed the other process");
});

/**
 * 探针：dump 在测试状态下（HH_TEST=1）照 HH_PARITY_PROBE 加载的脚本，所以它在场景子进程里、克隆完、围栏和沙箱都装好、世界建好以后、跑场景之前跑。
 * 它走一条 JS 围栏看不见的原生的路（node:sqlite）往 <out>-outside 里写；从跑它的用户自己的 home 往外拷一个（不存在的）文件；
 * 自己建一个指到草稿区外面的符号链接，再让 cpSync 替它建一个（给了 filter，cpSync 就走 JS、用它第一次被调用时抓住的那些 fs 函数）；
 * 删掉克隆带来的一个链接。结果连同它看到的环境变量名、execArgv 写到 <out>/probe.json
 */
const PROBE = `
const fs = require("node:fs");
const { join } = require("node:path");
const arg = (k) => process.argv[process.argv.indexOf(k) + 1];
const links = join(process.env.HOME, ${JSON.stringify(WORKSPACE_REL)}, "links");
const seen = { env: Object.keys(process.env).sort(), execArgv: process.execArgv };
const attempt = (name, f) => { try { f(); seen[name] = "done"; } catch (e) { seen[name] = e.message; } };
attempt("sqlite", () => {
  const db = new (require("node:sqlite").DatabaseSync)(join(arg("--out") + "-outside", "escape.db"));
  db.exec("CREATE TABLE t (x)");
  db.close();
});
attempt("copy", () => fs.copyFileSync(join(require("node:os").userInfo().homedir, "parity-no-such-dir", "x"), join(arg("--work"), "tmp", "copied")));
attempt("symlink", () => fs.symlinkSync("/usr/bin/true", join(arg("--work"), "tmp", "to-system")));
attempt("cpSync", () => fs.cpSync(join(links, "system"), join(arg("--work"), "tmp", "system-copy"), { verbatimSymlinks: true, filter: () => true }));
fs.unlinkSync(join(links, "gone"));
fs.writeFileSync(join(arg("--out"), "probe.json"), JSON.stringify(seen));
`;

interface Probe { env: string[]; execArgv: string[]; sqlite: string; copy: string; symlink: string; cpSync: string }
interface Dumped { stderr: string; meta: { sandbox: boolean }; probe: Probe; transcript: string; links: Record<string, string> }
interface Rec { kind: string; [k: string]: unknown }
const records = (d: Dumped): Rec[] => d.transcript.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);

/** 下面几个测试共用的两次 dump（同一份带脚本、带链接的快照：一次套沙箱 a，一次 --no-sandbox b）：只跑一次，各测各的 */
let shared: { root: string; a: string; b: string; confined: Dumped; open: Dumped } | undefined;
function dumps(): NonNullable<typeof shared> {
  if (shared) return shared;
  const root = tmpDir("hh-parity-sbx-");
  const liveWorkspace = join(root, "live-home", WORKSPACE_REL);
  const snap = buildSnapshot(root);
  const probe = join(root, "probe.cjs");
  writeFileSync(probe, PROBE);
  // 快照里的链接：指到系统文件的、指进真 home 的、相对的，外加一个树（那段脚本）会删掉的
  const at = join(snap.data, "home", WORKSPACE_REL, "links");
  mkdirSync(at);
  for (const [name, target] of [["system", "/usr/bin/true"], ["home", join(liveWorkspace, "IDENTITY.md")], ["relative", "../IDENTITY.md"], ["gone", "../SOUL.md"]] as const) symlinkSync(target, join(at, name));
  // 外面的环境里放上会让子进程往别处写、换配置的几样，父进程自己也带个开关
  const env = {
    PATH: process.env.PATH, LANG: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8", HOME: root, PARITY_STRAY: "1", HH_CONFIG: join(root, "nope.json"), HH_TEST: "1", HH_PARITY_PROBE: probe,
    NODE_OPTIONS: "--no-deprecation", NODE_V8_COVERAGE: join(root, "coverage"), NODE_COMPILE_CACHE: join(root, "compile-cache"),
  };
  const work = join(root, "work");
  const dump = (out: string, ...more: string[]): Dumped => {
    mkdirSync(`${out}-outside`);
    const r = spawnSync(process.execPath, ["--stack-trace-limit=7", MAIN, "dump", "--data", snap.data, "--work", work, "--out", out, "--scenario", "boot", ...more], { encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return {
      stderr: r.stderr,
      meta: JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as { sandbox: boolean },
      probe: JSON.parse(readFileSync(join(out, "probe.json"), "utf8")) as Probe,
      transcript: readFileSync(join(out, "boot", "transcript.jsonl"), "utf8"),
      links: Object.fromEntries(["system", "home", "relative"].map((n) => [n, readlinkSync(join(work, "home", WORKSPACE_REL, "links", n))])),
    };
  };
  const [a, b] = [join(root, "a"), join(root, "b")];
  shared = { root, a, b, confined: dump(a), open: dump(b, "--no-sandbox") };
  return shared;
}

test("parity dump: the scenario child really runs inside the kernel sandbox; --no-sandbox lets the same native write through, is recorded, and diff says so", () => {
  const { a, b, confined, open } = dumps();
  assert.equal(confined.meta.sandbox, true);
  assert.equal(confined.stderr, "");
  assert.equal(confined.probe.sqlite, "unable to open database file", "the native write was stopped by the kernel");
  assert.deepEqual(readdirSync(`${a}-outside`), [], "and nothing was written outside");

  assert.equal(open.meta.sandbox, false);
  assert.equal(open.stderr, "parity: --no-sandbox: scenario children run without the kernel sandbox (JS fences only)\n");
  assert.equal(open.probe.sqlite, "done", "without the sandbox the same script does write outside: the JS fence cannot see it");
  assert.deepEqual(readdirSync(`${b}-outside`), ["escape.db"]);
  assert.equal(open.transcript, confined.transcript, "the sandbox does not change what is recorded");

  const d = spawnSync(process.execPath, [MAIN, "diff", a, b], { encoding: "utf8" });
  assert.equal(d.status, 0, d.stderr);
  assert.equal(d.stderr, "diff: warning: B: meta.json does not say sandbox: true (dumped with --no-sandbox, or of unknown origin) — the scenario processes were not confined by the kernel sandbox\n");
  assert.match(d.stdout, /^dumps: A=\(no label\) B=\(no label\)\nscenario boot: identical, \d+ records\nparity: identical\n$/);
});

test("parity dump: the scenario child's environment is listed from scratch (PATH, LANG / LC_*, and what dump sets) and it gets none of the parent's execArgv", () => {
  const { confined } = dumps();
  // __CF_USER_TEXT_ENCODING 是 macOS 自己给每个进程加的，不是带进来的
  assert.deepEqual(confined.probe.env.filter((k) => k !== "__CF_USER_TEXT_ENCODING"), ["HH_CONFIG", "HOME", "LANG", "LC_CTYPE", "PATH", "TMPDIR", "TZ"]);
  assert.deepEqual(confined.probe.execArgv, []);
});

test("parity dump: the fence in the scenario child guards the running user's own home (copying out of it is refused before any file is touched, and recorded)", () => {
  const { confined } = dumps();
  const stray = join(userInfo().homedir, "parity-no-such-dir", "x");
  assert.equal(confined.probe.copy, `parity: refusing to touch the live home (${stray})`);
  assert.deepEqual(records(confined).filter((r) => r.api === "fs.copyFileSync").map((r) => [r.kind, r.path]), [["refused", stray]]);
});

test("parity dump: snapshot symlinks are cloned as input (to a system file and relative: verbatim; into the manifest's home: re-pointed into the clone) without a record; the tree's own symlink to outside the scratch area is still refused and recorded, also from inside cpSync", () => {
  const { root, confined } = dumps();
  const cloned = join(root, "work", "home", WORKSPACE_REL);
  assert.deepEqual(confined.links, { system: "/usr/bin/true", home: join(cloned, "IDENTITY.md"), relative: "../IDENTITY.md" });
  assert.equal(readFileSync(join(cloned, "links", "home"), "utf8"), readFileSync(join(cloned, "IDENTITY.md"), "utf8"), "the re-pointed link reads the clone's file");
  const SYMLINK = "parity: refusing to symlink to a target outside the scratch area (/usr/bin/true)";
  assert.deepEqual([confined.probe.symlink, confined.probe.cpSync], [SYMLINK, SYMLINK]);
  for (const f of ["to-system", "system-copy"]) assert.throws(() => lstatSync(join(root, "work", "tmp", f)), /ENOENT/, f);
  // 记录里只有树自己那两次（克隆建的三个链接不留记录）；克隆带来的链接跟别的文件一样进 files 那条：树删了一个，就列一个 deleted
  const recs = records(confined);
  assert.deepEqual(recs.filter((r) => r.api === "fs.symlinkSync").map((r) => [r.kind, r.path]), [["refused", "/usr/bin/true"], ["refused", "/usr/bin/true"]]);
  const files = upToState(recs).at(-1)!.value as Array<{ path: string; deleted?: boolean }>;
  assert.deepEqual(files.filter((f) => f.path.includes("/links")), [{ path: `home/${WORKSPACE_REL}/links/gone`, deleted: true }]);
});

test("parity dump: a meta.json a scenario process planted in --out (here a symlink) is neither followed nor overwritten — the dump fails", () => {
  const root = tmpDir("hh-parity-sbx-");
  // 探针在子进程里往 --out 放一个叫 meta.json 的链接，然后就退出
  const plant = `
const fs = require("node:fs");
const { join } = require("node:path");
const out = process.argv[process.argv.indexOf("--out") + 1];
fs.symlinkSync(join(out, "elsewhere.json"), join(out, "meta.json"));
process.exit(0);
`;
  const snap = buildSnapshot(root);
  const probe = join(root, "plant.cjs");
  writeFileSync(probe, plant);
  const out = join(root, "out");
  const r = spawnSync(process.execPath, [MAIN, "dump", "--data", snap.data, "--work", join(root, "work"), "--out", out, "--scenario", "boot"], { encoding: "utf8", env: { ...process.env, HH_TEST: "1", HH_PARITY_PROBE: probe } });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "boot\t0\tFAILED (exit 0)\n");
  assert.equal(r.stderr, `parity: ${join(out, "meta.json")} appeared during the dump (--out was empty at the start) — not overwriting it; this dump has no valid meta.json\n`);
  assert.equal(readlinkSync(join(out, "meta.json")), join(out, "elsewhere.json"), "the planted link is as it was");
  assert.equal(existsSync(join(out, "elsewhere.json")), false, "and nothing was written through it");
});

test("parity dump: where sandbox-exec cannot be started (here an outer sandbox forbids it) dump refuses with exit 2 before creating anything; --no-sandbox gets past", () => {
  const root = tmpDir("hh-parity-sbx-");
  const snap = buildSnapshot(root);
  const [work, out] = [join(root, "work"), join(root, "out")];
  const outer = `(version 1)(allow default)(deny process-exec (literal "${SANDBOX_EXEC}"))`;
  const dump = (...more: string[]) => spawnSync(SANDBOX_EXEC, ["-p", outer, process.execPath, MAIN, "dump", "--data", snap.data, "--work", work, "--out", out, "--scenario", "boot", ...more], { encoding: "utf8" });
  const r = dump();
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr.split("\n")[0], NO_SANDBOX);
  assert.ok(!r.stderr.includes("usage:"), "a refusal, not a usage error");
  for (const p of [work, out]) assert.equal(existsSync(p), false, p);
  // 1 毫秒的时限：场景起不来就到点，只看它过了沙箱那一关、meta.json 里记了没套
  const open = dump("--no-sandbox", "--timeout-ms", "1");
  assert.equal(open.status, 1, open.stderr);
  assert.match(open.stdout, /^boot\t\d+\tFAILED \(timed out after 1 ms\)\n$/);
  assert.equal((JSON.parse(readFileSync(join(out, "meta.json"), "utf8")) as { sandbox: boolean }).sandbox, false);
});
