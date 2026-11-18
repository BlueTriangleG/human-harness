// 自己修系统（src/repair）：守门、读提交、批准、核对、部署、重启、看守。
import { TEST_LANG, TEST_NAMES } from "./names.ts";
import { setLang } from "../src/lang/index.ts";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRules, matchesPath } from "../src/repair/rules.ts";
import type { RepairRules } from "../src/repair/rules.ts";
import { judge, combine } from "../src/repair/gate.ts";
import type { CommitInfo, FileChange, Verdict } from "../src/repair/gate.ts";
import { git, commitInfo, revList, isAncestor, blobSha, lsTree } from "../src/repair/git.ts";
import childProcess, { execFileSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { sessionApproval, ownerApproval } from "../src/repair/approvals.ts";
import { openDb } from "../src/store/db.ts";
import type { Db } from "../src/store/db.ts";
import { chmodSync, copyFileSync, statSync } from "node:fs";
import { appendEvent, readEvents, readDeployed, writeDeployed } from "../src/repair/log.ts";
import { appFaults, liveDrift, stamp, sensitiveDrift, type Run } from "../src/repair/audit.ts";
import { evaluateRange } from "../src/repair/range.ts";
import { runChecks, testsSlower, squashFix } from "../src/repair/check.ts";
import type { Runner } from "../src/repair/check.ts";
import { deploy, watchdogText } from "../src/repair/deploy.ts";
import { pathToFileURL } from "node:url";
import type { DeployOpts, WatchArgs } from "../src/repair/deploy.ts";
import { existsSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { verifiedOk } from "../src/repair/range.ts";
import { execRunner } from "../src/repair/check.ts";
import { snapshotDb } from "../src/repair/restart.ts";
import { calmNow, RestartGate, HealthMark, markBoot, markConsole, markRecord, bridgeRecord, bridgeRecords, stopRecorded } from "../src/repair/restart.ts";
import type { BrainStatus } from "../src/brain.ts";
import { watch, realRollback } from "../src/repair/watchdog.ts";
import type { WatchIO } from "../src/repair/watchdog.ts";
import { summarize, waitingIds } from "../src/repair/log.ts";
import { keepFix, repairCommand, liveRoot } from "../src/repair/cli.ts";
import { R } from "../src/lang/index.ts";
import { roleEntry } from "../src/repair/instances.ts";
import { loadConfig } from "../src/config.ts";
import { hhRuntimeNote } from "../src/persona/persona.ts";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { freshTmpdir, removeAtExit, tmpDir } from "./tmp.ts";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES: RepairRules = loadRules(ROOT);

function change(path: string, status: FileChange["status"], added: string[] = [], removed: string[] = [], oldPath?: string): FileChange {
  return { path, status, added: added.length, deleted: removed.length, addedLines: added, removedLines: removed, ...(oldPath ? { oldPath } : {}) };
}
function commit(files: FileChange[], trailers: Record<string, string> = {}): CommitInfo {
  return { sha: "abc1234def", subject: "fix: x", trailers, files };
}
const keys = (v: Verdict) => v.reasons.map((r) => r.key);

test("gate: a small fix in src/memory passes", () => {
  const v = judge(commit([change("src/memory/recall.ts", "M", ["  const n = 3;"], ["  const n = 2;"]), change("test/units.test.ts", "M", ["  assert.equal(n, 3);"])]), RULES);
  assert.deepEqual(v, { outcome: "pass", reasons: [] });
});

test("gate: protected path asks", () => {
  const v = judge(commit([change("src/regions/specs.ts", "M", ['  "reminders",'])]), RULES);
  assert.equal(v.outcome, "ask");
  assert.ok(keys(v).includes("protected:src/regions/specs.ts"));
});

test("gate: new process or network code asks", () => {
  const p = judge(commit([change("src/brain.ts", "M", ['import { spawn } from "node:child_process";'])]), RULES);
  assert.equal(p.outcome, "ask");
  assert.ok(keys(p).includes("capability:process"));
  const n = judge(commit([change("src/memory/recall.ts", "M", ['  await fetch("https://x");'])]), RULES);
  assert.ok(keys(n).includes("capability:network"));
});

test("gate: a new tool asks", () => {
  const v = judge(commit([change("src/tools/hhtools.ts", "M", ['    name: "forget_all",'])]), RULES);
  assert.ok(keys(v).includes("tool"));
  const same = judge(commit([change("src/tools/hhtools.ts", "M", ['    name: "reminders",', '    description: "新的说明",'], ['    name: "reminders",', '    description: "旧的说明",'])]), RULES);
  assert.ok(!keys(same).includes("tool"));
});

test("gate: size and core limits ask", () => {
  const many = judge(commit(Array.from({ length: 7 }, (_, i) => change(`src/memory/f${i}.ts`, "M", ["x"]))), RULES);
  assert.ok(keys(many).includes("big"));
  const core = judge(commit([change("src/brain.ts", "M", Array.from({ length: 61 }, (_, i) => `  const a${i} = ${i};`))]), RULES);
  assert.ok(keys(core).includes("core:src/brain.ts"));
  const del = judge(commit([change("src/x.ts", "D", [], ["export const x = 1;"])]), RULES);
  assert.ok(keys(del).includes("big"));
});

test("gate: migration asks", () => {
  const v = judge(commit([change("src/store/db.ts", "M", ["  ALTER TABLE mem_event ADD COLUMN x TEXT;"])]), RULES);
  assert.ok(keys(v).includes("migration"));
});

test("gate: prefix growth over 800 chars asks", () => {
  const v = judge(commit([change("src/lang/zh/prompts.ts", "M", [`export const X = "${"长".repeat(900)}";`])]), RULES);
  assert.ok(keys(v).includes("prefix"));
  // 她每轮读的字都在语言包里：config/repair.json 点的是整个 src/lang/，别的语言的包长了也问
  const pack = judge(commit([change("src/lang/en/prompts.ts", "A", [`export const X = "${"long ".repeat(200)}";`])]), RULES);
  assert.ok(keys(pack).includes("prefix"));
});

test("gate: weakened tests fail unless explained", () => {
  const gone = judge(commit([change("test/a.test.ts", "D", [], ['test("a", () => { assert.ok(1); });'])]), RULES);
  assert.equal(gone.outcome, "fail");
  assert.ok(keys(gone).includes("tests-weakened"));
  const told = judge(commit([change("test/a.test.ts", "D", [], ['test("a", () => { assert.ok(1); });'])], { "Test-change": "合并进 b" }), RULES);
  assert.ok(!keys(told).includes("tests-weakened"));
  const skip = judge(commit([change("test/b.test.ts", "M", ['test.skip("b", () => {});'])]), RULES);
  assert.equal(skip.outcome, "fail");
});

test("combine: fail beats ask beats pass", () => {
  const pass: Verdict = { outcome: "pass", reasons: [] };
  const ask: Verdict = { outcome: "ask", reasons: [{ key: "tool", detail: "a" }] };
  const fail: Verdict = { outcome: "fail", reasons: [{ key: "tool", detail: "b" }, { key: "tests-weakened", detail: "c" }] };
  const c = combine([pass, ask, fail]);
  assert.equal(c.outcome, "fail");
  assert.deepEqual(c.reasons.map((r) => r.key), ["tool", "tests-weakened"]);
});

test("rules: loadRules reads config/repair.json", () => {
  assert.equal(RULES.size.maxFiles, 6);
  assert.ok(matchesPath("src/tools/", "src/tools/hhtools.ts"));
  assert.ok(matchesPath("test/**", "test/a/b.ts"));
  assert.ok(!matchesPath("config/", "src/config.ts"));
  assert.ok(matchesPath("package.json", "package.json"));
  assert.ok(matchesPath("src/*/x.ts", "src/a/x.ts") && !matchesPath("src/*/x.ts", "src/a/b/x.ts"));
});

// ---- 读提交 ----

/** 临时仓库：put 写文件（null = 删），save 提交并返回 sha */
function tempRepo(): { dir: string; put: (rel: string, text: string | null) => void; mv: (a: string, b: string) => void; save: (msg: string) => string } {
  const dir = tmpDir("hh-repair-");
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "master"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  return {
    dir,
    put: (rel, text) => {
      const p = join(dir, rel);
      if (text === null) rmSync(p);
      else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text); }
    },
    mv: (a, b) => { execFileSync("git", ["-C", dir, "mv", a, b]); },
    save: (msg) => {
      execFileSync("git", ["-C", dir, "add", "-A"]);
      execFileSync("git", ["-C", dir, "commit", "-q", "-m", msg]);
      return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    },
  };
}

/** 临时的线上目录：部署、退回换依赖时在它旁边放 <线上>.npm-next / .npm-prev，跑完一起删 */
function liveDir(): string {
  const live = tmpDir("hh-live-");
  removeAtExit(`${live}.npm-next`);
  removeAtExit(`${live}.npm-prev`);
  return live;
}

test("git: commitInfo reads files, lines and trailers", () => {
  const r = tempRepo();
  r.put("src/a.ts", "const a = 1;\nconst b = 2;\n");
  r.put("src/b.ts", "export const moved = true;\nexport const more = 1;\nexport const evenMore = 2;\n");
  r.save("init");
  r.put("src/a.ts", "const a = 1;\nconst b = 3;\n");
  r.mv("src/b.ts", "src/c.ts");
  const sha = r.save("fix: x\n\nFix: #0007\nVerified-by: opus 通过");
  const c = commitInfo(r.dir, sha);
  assert.equal(c.sha, sha);
  assert.equal(c.subject, "fix: x");
  const a = c.files.find((f) => f.path === "src/a.ts");
  assert.deepEqual({ status: a?.status, added: a?.added, deleted: a?.deleted, addedLines: a?.addedLines, removedLines: a?.removedLines },
    { status: "M", added: 1, deleted: 1, addedLines: ["const b = 3;"], removedLines: ["const b = 2;"] });
  const moved = c.files.find((f) => f.status === "R");
  assert.equal(moved?.path, "src/c.ts");
  assert.equal(moved?.oldPath, "src/b.ts");
  assert.equal(c.trailers.Fix, "#0007");
  assert.equal(c.trailers["Verified-by"], "opus 通过");
});

test("git: revList is oldest first and isAncestor works", () => {
  const r = tempRepo();
  r.put("a", "1"); const A = r.save("A");
  r.put("a", "2"); const B = r.save("B");
  r.put("a", "3"); const C = r.save("C");
  assert.deepEqual(revList(r.dir, A, C), [B, C]);
  assert.equal(isAncestor(r.dir, A, C), true);
  assert.equal(isAncestor(r.dir, C, A), false);
  assert.equal(lsTree(r.dir, C).get("a"), git(r.dir, ["rev-parse", `${C}:a`]));
});

test("git: blobSha matches git hash-object", () => {
  const r = tempRepo();
  r.put("x.txt", "你好\n");
  assert.equal(blobSha(readFileSync(join(r.dir, "x.txt"))), git(r.dir, ["hash-object", "x.txt"]));
});

// ---- 批准 ----

const UID = process.getuid?.() ?? 0;

function guardWith(record: unknown, fileMode = 0o644, dirMode = 0o755): string {
  const g = tmpDir("hh-guard-");
  chmodSync(g, 0o755);
  mkdirSync(join(g, "approvals"));
  writeFileSync(join(g, "approvals", "x.json"), JSON.stringify(record));
  chmodSync(join(g, "approvals", "x.json"), fileMode);
  chmodSync(join(g, "approvals"), dirMode);
  return g;
}
const REC = { shas: ["abc1234"], by: "sess-4c", why: "ada 11-01：做", t: "2026-11-01T12:00:00Z" };

test("approvals: a record from another account approves its shas", () => {
  const g = guardWith(REC);
  assert.deepEqual(sessionApproval(g, "abc1234ffff", UID + 1), REC);
  assert.equal(sessionApproval(g, "fff1234abcd", UID + 1), null);
});

test("approvals: ignores records mira could have written", () => {
  assert.equal(sessionApproval(guardWith(REC), "abc1234ffff", UID), null);              // 文件是 mira 自己的
  assert.equal(sessionApproval(guardWith(REC, 0o664), "abc1234ffff", UID + 1), null);   // 组可写
  assert.equal(sessionApproval(guardWith(REC, 0o644, 0o775), "abc1234ffff", UID + 1), null);   // 目录组可写
  assert.equal(sessionApproval(guardWith({ ...REC, shas: ["abc"] }), "abc1234ffff", UID + 1), null);   // 太短的前缀不算
});

function chatDb(rows: Array<{ seq: number; kind: string; meta: Record<string, unknown>; text?: string }>): Db {
  const db = openDb(":memory:");
  for (const r of rows) db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens, meta) VALUES (?, ?, 1, ?, ?, ?, 1, ?)").run(r.seq, r.seq * 1000, r.kind === "input" ? "外界" : "main", r.kind, r.text ?? "x", JSON.stringify(r.meta));
  return db;
}
const OWNER = { name: "老林", channels: ["whatsapp", "qqbot"] };
const ROLE = { user: "test", author: { name: "看守", email: "role@local" }, owner: OWNER };
const ASK = { seq: 10, kind: "note", meta: { sent: true, to: "+61", name: OWNER.name }, text: "（发给 ada）#0001 提醒删不掉，要加一个工具，可以吗" };
const OK = (seq: number, channel: string) => ({ seq, kind: "input", meta: { from: OWNER.name, channel, human: true }, text: "可以，加吧" });
const TRAILERS = { Fix: "#0001", Asked: "10", "Owner-OK": "12", "Ask-reasons": "protected:src/regions/specs.ts,tool" };
const R2 = [{ key: "protected:src/regions/specs.ts", detail: "" }, { key: "tool", detail: "" }];

test("owner approval: a real whatsapp reply after the ask counts, under Owner-OK or an older <Name>-OK such as Ada-OK", () => {
  assert.deepEqual(ownerApproval(chatDb([ASK, OK(12, "whatsapp")]), TRAILERS, R2, OWNER).ok, true);
  const { "Owner-OK": seq, ...rest } = TRAILERS;
  assert.deepEqual(ownerApproval(chatDb([ASK, OK(12, "whatsapp")]), { ...rest, "Ada-OK": seq }, R2, OWNER).ok, true);
});

test("owner approval: app channel and earlier rows do not count", () => {
  assert.equal(ownerApproval(chatDb([ASK, OK(12, "app")]), TRAILERS, R2, OWNER).ok, false);
  assert.equal(ownerApproval(chatDb([OK(9, "whatsapp"), ASK]), { ...TRAILERS, "Owner-OK": "9" }, R2, OWNER).ok, false);
  assert.equal(ownerApproval(chatDb([ASK, OK(12, "whatsapp")]), { Asked: "10" }, R2, OWNER).ok, false);
});

test("owner approval: a new reason needs a new ask", () => {
  const r = ownerApproval(chatDb([ASK, OK(12, "whatsapp")]), TRAILERS, [...R2, { key: "capability:process", detail: "" }], OWNER);
  assert.equal(r.ok, false);
  assert.match(r.why, /capability:process/);
});

// ---- 日志和核对 ----

test("log: events append and read back since a time", () => {
  const st = tmpDir("hh-state-");
  appendEvent(st, { kind: "deploy", text: "a", t: "2026-11-01T00:00:00.000Z" });
  appendEvent(st, { kind: "rollback", fix: "#0007", text: "b", t: "2026-11-02T00:00:00.000Z" });
  assert.deepEqual(readEvents(st).map((e) => e.text), ["a", "b"]);
  assert.deepEqual(readEvents(st, Date.parse("2026-11-01T12:00:00Z")).map((e) => e.kind), ["rollback"]);
  assert.equal(readDeployed(st), null);
  writeDeployed(st, { commit: "abc", prev: null, t: "x", by: "bootstrap" });
  assert.equal(readDeployed(st)?.commit, "abc");
});

test("audit: the live copy as git status sees it against the deployed commit — clean; edited, gone, added wherever .gitignore does not leave out; another commit's tree", () => {
  const r = tempRepo();
  r.put(".gitignore", "node_modules/\n__pycache__/\n"); r.put("src/a.ts", "a"); r.put("src/b.ts", "b"); r.put("README.md", "r");
  const A = r.save("A");
  r.put("src/a.ts", "a2"); const B = r.save("B");
  const live = liveDir();
  execFileSync("bash", ["-c", `git -C ${r.dir} archive ${A} | tar -x -C ${live}`]);
  for (const p of ["node_modules/x/i.js", "modules/m/__pycache__/s.pyc"]) { mkdirSync(dirname(join(live, p)), { recursive: true }); writeFileSync(join(live, p), "1"); }
  assert.deepEqual(liveDrift(r.dir, live, A), [], "what .gitignore leaves out is not drift, nor that master has moved on");
  assert.deepEqual(liveDrift(r.dir, live, B), [{ path: "src/a.ts", how: "changed" }], "the live copy is another commit's tree, not the deployed one");
  writeFileSync(join(live, "src/a.ts"), "changed");
  rmSync(join(live, "src/b.ts"));
  writeFileSync(join(live, "src/new.ts"), "n");
  writeFileSync(join(live, "modules/m/new.py"), "n");
  assert.deepEqual(liveDrift(r.dir, live, A), [
    { path: "modules/m/new.py", how: "extra" }, { path: "src/a.ts", how: "changed" }, { path: "src/b.ts", how: "missing" }, { path: "src/new.ts", how: "extra" },
  ]);
});

test("audit: the role's app — as built and signed for it, or which of signature, signer, bundle id, launcher is off", () => {
  const st = tmpDir("hh-app-st-"), app = join(tmpDir("hh-app-"), "R.app"), uid = process.getuid!();
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true }); mkdirSync(join(st, "app"));
  writeFileSync(join(app, "Contents", "Info.plist"), "<dict><key>CFBundleIdentifier</key><string>ai.hh.role.t</string></dict>");
  writeFileSync(join(app, "Contents", "MacOS", "HH"), "x", { mode: 0o755 });
  const ran: string[] = [];
  const fake = (o: { verify?: boolean; pem?: boolean; leaf?: string } = {}): Run => (cmd, args) => {
    ran.push(`${cmd} ${args[0]}`);
    if (args[0] === "--verify") return { ok: o.verify ?? true, out: "" };
    if (cmd.endsWith("openssl")) return o.pem === false ? { ok: false, out: "Could not open file" } : { ok: true, out: "SHA1 Fingerprint=AB:CD:EF\n" };
    return { ok: true, out: `designated => certificate leaf = H"${o.leaf ?? "abcdef"}"` };
  };
  assert.deepEqual(appFaults(app, "t", st, uid, fake()), []);
  assert.ok(ran.every((r) => !/security|unlock/.test(r)), "nothing is unlocked to check it");
  assert.deepEqual(appFaults(join(app, "..", "gone.app"), "t", st, uid, fake()), ["missing"]);
  assert.deepEqual(appFaults(app, "t", st, uid, fake({ verify: false })), ["unsigned"]);
  assert.deepEqual(appFaults(app, "t", st, uid, fake({ leaf: "0123456789" })), ["signer"], "signed, but not by the role's own certificate");
  assert.deepEqual(appFaults(app, "t", st, uid, fake({ pem: false })), ["identity"]);
  assert.deepEqual(appFaults(app, "other", st, uid, fake()), ["bundle"]);
  assert.deepEqual(appFaults(app, "t", st, uid + 1, fake()), ["launcher"], "the launcher is another account's");
  chmodSync(join(app, "Contents", "MacOS", "HH"), 0o775);
  assert.deepEqual(appFaults(app, "t", st, uid, fake()), ["launcher"], "others can write the launcher");
});

test("audit: sensitive files report hash or mode changes without content", () => {
  const d = tmpDir("hh-sens-");
  const f = join(d, "secrets.json");
  writeFileSync(f, '{"openaiKey":"sk-very-secret"}');
  chmodSync(f, 0o600);
  const before = stamp([f, join(d, "nope.json")]);
  assert.equal(before[1]?.sha256, null);
  assert.deepEqual(sensitiveDrift(before, stamp([f, join(d, "nope.json")])), []);
  writeFileSync(f, '{"openaiKey":"sk-other-secret"}');
  chmodSync(f, 0o644);
  const drift = sensitiveDrift(before, stamp([f, join(d, "nope.json")]));
  assert.equal(drift.length, 1);
  assert.equal(drift[0]?.path, f);
  for (const v of [drift[0]?.was ?? "", drift[0]?.now ?? ""]) { assert.ok(v.length <= 20); assert.ok(!v.includes("secret")); }
  assert.match(drift[0]?.now ?? "", /644/);
  assert.equal(statSync(f).mode & 0o777, 0o644);
});

// ---- 一段提交、检查、合并 ----

const VERIFIED = "\n\nFix: #0001\nVerified-by: opus 通过";

test("range: our approved commit, her verified fix and her unverified fix", () => {
  const r = tempRepo();
  r.put("src/memory/a.ts", "a"); const A = r.save("A");
  r.put("src/memory/x.ts", "x"); const C1 = r.save("feat: ours");
  r.put("src/memory/y.ts", "y"); const C2 = r.save("fix: hers" + VERIFIED);
  r.put("src/memory/z.ts", "z"); const C3 = r.save("fix: hers, no helper");
  const g = guardWith({ ...REC, shas: [C1.slice(0, 10)] });
  const res = evaluateRange({ owner: OWNER, dir: r.dir, from: A, to: C3, rules: RULES, guardDir: g, selfUid: UID + 1, db: null });
  assert.deepEqual(res.items.map((i) => i.via), ["session", "gate", "blocked"]);
  assert.equal(res.ok, false);
  assert.match(res.items[2]?.why ?? "", /修理单号|帮手/);
  assert.equal(res.items[0]?.sha, C1);
  assert.equal(res.items[1]?.sha, C2);
});

test("range: her ask commit passes only with Ada's reply", () => {
  const r = tempRepo();
  r.put("src/regions/specs.ts", "a"); const A = r.save("A");
  r.put("src/regions/specs.ts", "b");
  const C = r.save("fix: hers" + VERIFIED + "\nAsked: 10\nOwner-OK: 12\nAsk-reasons: protected:src/regions/specs.ts");
  const g = guardWith(REC);
  const none = evaluateRange({ owner: OWNER, dir: r.dir, from: A, to: C, rules: RULES, guardDir: g, selfUid: UID + 1, db: chatDb([]) });
  assert.equal(none.ok, false);
  assert.equal(none.items[0]?.via, "blocked");
  const yes = evaluateRange({ owner: OWNER, dir: r.dir, from: A, to: C, rules: RULES, guardDir: g, selfUid: UID + 1, db: chatDb([ASK, OK(12, "whatsapp")]) });
  assert.equal(yes.ok, true);
  assert.equal(yes.items[0]?.via, "owner");
});

test("checks: a failing test run is reported with its tail", () => {
  const dir = tmpDir("hh-check-");
  writeFileSync(join(dir, "package-lock.json"), "v1");
  const calls: string[] = [];
  const run = (fail: boolean): Runner => (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "npm" && args[0] === "test" && fail) return { code: 1, out: "ok 1\nnot ok 2 - 提醒删不掉\n", ms: 5 };
    return { code: 0, out: "fine", ms: 5 };
  };
  const first = runChecks(dir, "/src/repo", "abc", run(true));
  assert.equal(first.tsc.ok, true);
  assert.equal(first.tests.ok, false);
  assert.match(first.tests.tail, /提醒删不掉/);
  assert.ok(calls.includes("git fetch /src/repo abc") && calls.includes("git checkout --detach abc"));
  assert.ok(calls.some((c) => c.startsWith("npm ci")));
  calls.length = 0;
  runChecks(dir, "/src/repo", "abc", run(false));
  assert.ok(!calls.some((c) => c.startsWith("npm ci")), "锁文件没变就不重装");
});

test("checks: testsSlower uses ratio and minimum", () => {
  assert.equal(testsSlower(41000, 20000, RULES.tests), true);
  assert.equal(testsSlower(40000, 20000, RULES.tests), false, "正好多 20 秒不算");
  assert.equal(testsSlower(25000, 10000, RULES.tests), false);
  assert.equal(testsSlower(1, null, RULES.tests), false);
});

// ---- 检查时怎么跑全套（11-14：部署时 npm test 同时开 9 个子进程，1.2 GB 挤进交换区，hhd 卡了 10 秒） ----
import { testCommand, readBench, writeBench } from "../src/repair/check.ts";

/** package.json 里一条 node --test 脚本拆成：选项（按出现的先后）和文件通配 */
function nodeTestScript(script: string): { flags: string[]; globs: string[]; flagsBeforeGlobs: boolean } {
  const words = script.match(/"[^"]*"|\S+/g) ?? [];
  assert.deepEqual(words.slice(0, 2), ["node", "--test"], script);
  const rest = words.slice(2);
  const firstGlob = rest.findIndex((w) => !w.startsWith("--"));
  return { flags: rest.filter((w) => w.startsWith("--")), globs: rest.filter((w) => !w.startsWith("--")), flagsBeforeGlobs: rest.slice(firstGlob).every((w) => !w.startsWith("--")) };
}

test("checks: test:quiet runs the same files with the same reporter as test, with fewer workers set before the globs", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const full = nodeTestScript(pkg.scripts.test!);
  const quiet = nodeTestScript(pkg.scripts["test:quiet"]!);
  assert.deepEqual(quiet.globs, full.globs, "同一批文件（通配只改一处会被这里拦下）");
  assert.deepEqual(quiet.flags.filter((f) => !f.startsWith("--test-concurrency=")), full.flags, "别的选项一样");
  const n = Number(quiet.flags.find((f) => f.startsWith("--test-concurrency="))?.split("=")[1]);
  assert.ok(Number.isInteger(n) && n >= 1 && n <= 4, `并发 1–4 个：${n}`);
  assert.ok(quiet.flagsBeforeGlobs, "选项要写在文件通配前面：写在后面 node 不认（11-14 实测），也不能放进 NODE_OPTIONS");
});

test("checks: the full run uses test:quiet when the commit has it, plain npm test when it does not; the mode says which", () => {
  const dir = tmpDir("hh-check-");
  assert.deepEqual(testCommand(dir), { cmd: "npm", args: ["test"], mode: "npm test" }, "没有 package.json");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test x" } }));
  assert.equal(testCommand(dir).mode, "npm test", "老提交没有 test:quiet");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test x", "test:quiet": "node --test --test-concurrency=3 x" } }));
  const quiet = testCommand(dir);
  assert.deepEqual([quiet.cmd, ...quiet.args], ["npm", "run", "test:quiet"], "不套后台优先级（会把带超时的测试拖超时）");
  assert.match(quiet.mode, /^test:quiet [0-9a-f]{12}$/);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { "test:quiet": "node --test --test-concurrency=2 x" } }));
  assert.notEqual(testCommand(dir).mode, quiet.mode, "脚本改了，跑法就算换了");
  // runChecks 照这个跑，跑法带在结果里
  const calls: string[] = [];
  const r = runChecks(dir, "/src/repo", "abc", (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, out: "ok", ms: 5 }; });
  assert.ok(calls.some((c) => c.endsWith("npm run test:quiet")), calls.join(" | "));
  assert.ok(!calls.includes("npm test"));
  assert.equal(r.tests.mode, testCommand(dir).mode);
});

test("checks: the bench is only compared with a run of the same mode (old records count as npm test)", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "a", prev: null, t: "x", by: "test" });   // 建好 repair/ 目录
  writeFileSync(join(st, "repair", "bench.json"), JSON.stringify({ sha: "old", ms: 20000 }) + "\n");
  assert.equal(readBench(st)?.ms, 20000, "不给跑法：照旧");
  assert.equal(readBench(st, "npm test")?.ms, 20000, "老记录算 npm test");
  assert.equal(readBench(st, "test:quiet abc bg"), null, "换了跑法：没有基准");
  writeBench(st, { sha: "new", ms: 90000, mode: "test:quiet abc bg" });
  assert.equal(readBench(st, "test:quiet abc bg")?.ms, 90000);
  assert.equal(readBench(st, "npm test"), null);
});

test("deploy: the first deploy with the new test mode is not refused as slower; a slower run of the same mode still is", () => {
  const s = deploySetup();
  s.r.put("src/memory/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/memory/b.ts", "b"); const B = s.r.save("fix: hers" + VERIFIED);
  s.r.put("src/memory/c.ts", "c"); const C = s.r.save("fix: hers again" + VERIFIED.replace("#0001", "#0002"));
  s.at(A);
  const check = s.o(B).checkDir;
  writeFileSync(join(check, "package.json"), JSON.stringify({ scripts: { test: "node --test x", "test:quiet": "node --test --test-concurrency=3 x" } }));
  writeDeployed(s.st, { commit: A, prev: null, t: "x", by: "test" });
  writeFileSync(join(s.st, "repair", "bench.json"), JSON.stringify({ sha: A, ms: 20000 }) + "\n");   // 11-14 以前的记录：npm test、20 秒
  const slow = (ms: number): Runner => (cmd, args) => ({ code: 0, out: "ok", ms: args.includes("test:quiet") || (cmd === "npm" && args[0] === "test") ? ms : 10 });
  const first = deploy(s.o(B), { run: slow(100_000), spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(first.ok, true, `换了跑法的第一次不拒：${first.text}`);
  const bench = JSON.parse(readFileSync(join(s.st, "repair", "bench.json"), "utf8")) as { ms: number; mode?: string };
  assert.equal(bench.ms, 100_000);
  assert.match(bench.mode ?? "", /^test:quiet /, "基准里记下了跑法");
  const second = deploy(s.o(C), { run: slow(300_000), spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(second.ok, false, "同一种跑法明显变慢：照旧拒");
  assert.match(second.text, /测试明显变慢（100 秒 → 300 秒）/);
});

// ---- 重活锁（CEO 11-14：她的 hh deploy、hh fix check 跑全套前也拿；测试一律用临时目录，不碰线上 /tmp/hh-heavy.lock） ----
import { takeHeavy, heavyLockFrom } from "../src/repair/lock.ts";

/** 一个肯定已经退出的进程号 */
function deadPid(): number {
  const p = childProcess.spawnSync("/bin/sh", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(p.stdout.trim());
}

test("heavy lock: free → taken with pid and who, released after; held by a live process → waits, then says who it waited for; held by a dead one → taken over", () => {
  const dir = tmpDir("hh-heavy-");
  const path = join(dir, "hh-heavy.lock");
  const got = takeHeavy({ path, who: "hh deploy abc1234（测试）", waitMs: 0 });
  assert.ok("release" in got);
  assert.equal(readFileSync(join(path, "pid"), "utf8").trim(), String(process.pid));
  assert.equal(readFileSync(join(path, "who"), "utf8").trim(), "hh deploy abc1234（测试）");
  assert.equal(statSync(path).mode & 0o775, 0o775, "锁目录同组可写（另一个账号清得掉）");
  assert.equal(statSync(join(path, "pid")).mode & 0o664, 0o664, "里面的文件也同组可写");
  got.release();
  assert.equal(existsSync(path), false, "放掉了");
  // 别人拿着（活着的进程）：照间隔等，等满了照实说在等谁
  mkdirSync(path); writeFileSync(join(path, "pid"), `${process.pid}\n`); writeFileSync(join(path, "who"), "hh-guard test（hh-quiet）\n");
  let t = 0; const slept: number[] = [];
  const busy = takeHeavy({ path, who: "hh deploy", waitMs: 10_000, pollMs: 3_000, now: () => t, sleep: (ms) => { slept.push(ms); t += ms; } });
  assert.ok("waitingFor" in busy);
  assert.equal(busy.waitingFor, `hh-guard test（hh-quiet）（pid ${process.pid}）`);
  assert.deepEqual(slept, [3_000, 3_000, 3_000, 3_000], "等满 10 秒（每 3 秒看一次）");
  assert.equal(readFileSync(join(path, "who"), "utf8").trim(), "hh-guard test（hh-quiet）", "别人的锁一个字没动");
  // 拿着的进程已经没了：接手
  writeFileSync(join(path, "pid"), `${deadPid()}\n`);
  const took = takeHeavy({ path, who: "hh deploy", waitMs: 0 });
  assert.ok("release" in took, "死锁接手");
  assert.equal(readFileSync(join(path, "who"), "utf8").trim(), "hh deploy");
  took.release();
});

test("heavy lock: a lock dir with no pid that has sat there over a minute is taken over (its holder died between mkdir and writing the pid); a dead holder whose dir can't be removed is reported, not waited on silently", () => {
  const dir = tmpDir("hh-heavy-");
  const path = join(dir, "hh-heavy.lock");
  mkdirSync(path);
  let t = statSync(path).mtimeMs + 30_000;
  const young = takeHeavy({ path, who: "x", waitMs: 0, now: () => t });
  assert.ok("waitingFor" in young, "刚建的（没到一分钟）：当别人正在拿");
  t = statSync(path).mtimeMs + 61_000;
  const old = takeHeavy({ path, who: "x", waitMs: 0, now: () => t });
  assert.ok("release" in old, "放了一分钟还没 pid：接手");
  old.release();
  // 死了的进程留下的锁，所在目录不让删（别的账号用老办法建的）：照等，并且说明白
  mkdirSync(path); writeFileSync(join(path, "pid"), `${deadPid()}\n`); writeFileSync(join(path, "who"), "hh-guard test\n");
  chmodSync(dir, 0o555);
  try {
    const stuck = takeHeavy({ path, who: "x", waitMs: 0 });
    assert.ok("waitingFor" in stuck);
    assert.match(stuck.waitingFor, /hh-guard test（pid \d+）——那个进程已经没了，可锁目录删不掉（.*），要人去清/);
  } finally { chmodSync(dir, 0o755); }
});

test("heavy lock from the repair rules: not configured → no lock; configured but its directory isn't there (another machine) → no lock and nothing created; configured and there → that path and wait", () => {
  const base = tmpDir("hh-heavy-base-");
  assert.equal(heavyLockFrom(undefined, "w"), undefined, "没配");
  assert.equal(heavyLockFrom({ path: "", waitMs: 1 }, "w"), undefined);
  const missing = join(base, "no-such-dir", "lock");
  assert.equal(heavyLockFrom({ path: missing, waitMs: 600_000 }, "w"), undefined, "上级目录不在：不拿");
  assert.equal(existsSync(join(base, "no-such-dir")), false, "也不去建");
  assert.deepEqual(heavyLockFrom({ path: join(base, "lock"), waitMs: 600_000 }, "hh deploy abc1234（测试）"), { path: join(base, "lock"), who: "hh deploy abc1234（测试）", waitMs: 600_000 });
  // 仓库里的修理规则配的是这台机器的约定
  assert.deepEqual(RULES.heavyLock, { path: "/Users/Shared/hh-heavy/lock", waitMs: 600_000 });
});

test("checks: with the heavy lock the type check and full run happen while holding it; when it is busy nothing runs and the result says who it waited for", () => {
  const dir = tmpDir("hh-check-");
  const path = join(tmpDir("hh-heavy-"), "hh-heavy.lock");
  const held: string[] = [];
  const run: Runner = (cmd, args) => { if (cmd === "npx" || args.includes("test")) held.push(`${[cmd, ...args].join(" ")}:${existsSync(path) ? "拿着" : "没拿"}`); return { code: 0, out: "ok", ms: 5 }; };
  const ok = runChecks(dir, "/src/repo", "abc", run, { path, who: "hh fix check", waitMs: 0 });
  assert.equal(ok.busy, undefined);
  assert.deepEqual(held, ["npx tsc --noEmit:拿着", "npm test:拿着"]);
  assert.equal(existsSync(path), false, "跑完放掉");
  mkdirSync(path); writeFileSync(join(path, "pid"), `${process.pid}\n`); writeFileSync(join(path, "who"), "运维的实测\n");
  held.length = 0;
  let t = 0;
  const busy = runChecks(dir, "/src/repo", "abc", run, { path, who: "hh fix check", waitMs: 600_000, now: () => t, sleep: (ms) => { t += ms; } });
  assert.deepEqual(held, [], "没拿到锁：类型检查和全套都不跑");
  assert.match(busy.busy ?? "", /重活锁等了 10 分钟没等到，在等：运维的实测（pid \d+）/);
  let t2 = 0;
  const short = runChecks(dir, "/src/repo", "abc", run, { path, who: "hh fix check", waitMs: 5_000, now: () => t2, sleep: (ms) => { t2 += ms; } });
  assert.match(short.busy ?? "", /重活锁等了 5 秒没等到/, "不到一分钟按秒说");
  assert.equal(busy.tests.ok, false);
  rmSync(path, { recursive: true });
});

test("deploy: refuses, saying who it waited for, when the heavy lock stays busy; live untouched", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); const B = s.r.save("feat: ours");
  s.at(A);
  const path = join(tmpDir("hh-heavy-"), "hh-heavy.lock");
  mkdirSync(path); writeFileSync(join(path, "pid"), `${process.pid}\n`); writeFileSync(join(path, "who"), "hh-guard test（别的会话）\n");
  let t = 0;
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B.slice(0, 12)] }), heavy: { path, who: "hh deploy", waitMs: 60_000, now: () => t, sleep: (ms) => { t += ms; } } }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /在等：hh-guard test（别的会话）/);
  assert.equal(readFileSync(join(s.live, "src/a.ts"), "utf8"), "a", "线上没动");
  rmSync(path, { recursive: true });
});

test("squash: a fix branch becomes one commit on top of master with the message", () => {
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A = r.save("A");
  execFileSync("git", ["-C", r.dir, "checkout", "-q", "-b", "fix/0001-x"]);
  r.put("src/a.ts", "b"); r.save("wip 1");
  r.put("src/b.ts", "c"); r.save("wip 2");
  const sha = squashFix({ clone: r.dir, branch: "fix/0001-x", base: A, message: "fix: x" + VERIFIED });
  assert.deepEqual(revList(r.dir, A, sha), [sha]);
  const c = commitInfo(r.dir, sha);
  assert.deepEqual(c.files.map((f) => f.path).sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal(c.trailers.Fix, "#0001");
});

/** 系统临时目录换成一个新的空目录跑 fn，返回跑完后里面剩下的（#0055：用完的临时目录要删掉） */
function leftInTmp(fn: () => void): string[] {
  const t = freshTmpdir();
  try { fn(); } finally { t.restore(); }
  return readdirSync(t.dir);
}

test("squash: the temp worktree dir is removed after, also when the squash fails (#0055)", () => {
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A = r.save("A");
  execFileSync("git", ["-C", r.dir, "checkout", "-q", "-b", "fix/0001-x"]);
  r.put("src/a.ts", "b"); r.save("wip 1");
  assert.deepEqual(leftInTmp(() => { squashFix({ clone: r.dir, branch: "fix/0001-x", base: A, message: "fix: x" + VERIFIED }); }), [], "压成了");
  assert.deepEqual(leftInTmp(() => assert.throws(() => squashFix({ clone: r.dir, branch: "fix/no-such", base: A, message: "fix: x" }))), [], "合并失败");
  assert.deepEqual(leftInTmp(() => assert.throws(() => squashFix({ clone: r.dir, branch: "fix/0001-x", base: "no-such-base", message: "fix: x" }))), [], "工作区没建成");
  assert.equal(git(r.dir, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree ")).length, 1, "克隆里不留工作区");
});

// ---- 部署 ----

const okRun: Runner = () => ({ code: 0, out: "ok", ms: 10 });

function deploySetup(): { r: ReturnType<typeof tempRepo>; live: string; st: string; o: (target: string, extra?: Partial<DeployOpts>) => DeployOpts; at: (sha: string) => void; watched: WatchArgs[]; spawn: (a: WatchArgs) => void } {
  const r = tempRepo();
  r.put(".gitignore", "node_modules/\n");   // as HH's own: the installed dependencies in the live copy are not drift
  const live = liveDir();
  const st = tmpDir("hh-state-");
  const check = tmpDir("hh-check-");
  const watched: WatchArgs[] = [];
  return {
    r, live, st, watched, spawn: (a) => { watched.push(a); },
    at: (sha) => {
      execFileSync("bash", ["-c", `git -C ${r.dir} archive ${sha} | tar -x -C ${live}`]);
      writeDeployed(st, { commit: sha, prev: null, t: "x", by: "test" });
    },
    o: (target, extra = {}) => ({ live, stateDir: st, gitDir: r.dir, checkDir: check, guardDir: guardWith({ ...REC, shas: [] }), target, by: "test", selfUid: UID + 1, dbPath: join(st, "none.db"), rules: RULES, owner: OWNER, authorEmail: ROLE.author.email, user: ROLE.user, ...extra }),
  };
}

test("deploy: forward deploy extracts, deletes, records and requests a restart", () => {
  const s = deploySetup();
  s.r.put("src/old.ts", "old"); s.r.put("src/memory/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/old.ts", null); s.r.put("src/new.ts", "new"); const B = s.r.save("feat: ours");
  s.at(A);
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B.slice(0, 12)] }) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.equal(readFileSync(join(s.live, "src/new.ts"), "utf8"), "new");
  assert.equal(existsSync(join(s.live, "src/old.ts")), false);
  assert.equal(readDeployed(s.st)?.commit, B);
  assert.equal(readDeployed(s.st)?.prev, A);
  assert.equal(JSON.parse(readFileSync(join(s.st, "repair", "restart-request.json"), "utf8")).commit, B);
  assert.equal(s.watched[0]?.prev, A);
  assert.equal(s.watched[0]?.target, B);
  assert.ok(readEvents(s.st).some((e) => e.kind === "deploy" && e.to === B));
});

test("deploy: asks for a console restart even when no src/console/ file changed", () => {
  const s = deploySetup();
  s.r.put("src/console/server.ts", "c"); s.r.put("src/gate/gate.ts", "a"); const A = s.r.save("A");
  s.r.put("src/gate/gate.ts", "b"); const B = s.r.save("feat: gate only");
  s.at(A);
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B.slice(0, 12)] }) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.equal(JSON.parse(readFileSync(join(s.st, "repair", "console-restart.json"), "utf8")).commit, B, "控制台引用了 src/console/ 以外的模块：每次部署都要它重启");
});

test("deploy: refuses older target", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); const B = s.r.save("B");
  s.at(B);
  const res = deploy(s.o(A), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.equal(readFileSync(join(s.live, "src/a.ts"), "utf8"), "b");
  assert.ok(readEvents(s.st).some((e) => e.kind === "refused"));
});

test("deploy: the role's own edits to the live copy are kept on <user>-local/<time>, its commit on the deployed one, and the deploy goes on", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); s.r.put("src/gone.ts", "g"); const A = s.r.save("A");
  s.r.put("src/b.ts", "b"); const B = s.r.save("feat: ours");
  s.r.put("src/c.ts", "c"); const C = s.r.save("feat: more");
  s.at(A);
  const edit = () => { writeFileSync(join(s.live, "src/a.ts"), "hand edit"); rmSync(join(s.live, "src/gone.ts"), { force: true }); writeFileSync(join(s.live, "src/mine.ts"), "mine"); };
  edit();
  const o = (t: string) => s.o(t, { guardDir: guardWith({ ...REC, shas: [B.slice(0, 12), C.slice(0, 12)] }) });
  const at = Date.UTC(2026, 10, 17, 6, 30, 12);
  assert.equal(deploy(o(B), { run: () => ({ code: 1, out: "boom", ms: 1 }), spawnWatchdog: s.spawn, now: () => at }).ok, false);
  assert.equal(readFileSync(join(s.live, "src/a.ts"), "utf8"), "hand edit", "refused for another reason: her edits stay as they are");
  assert.equal(git(s.r.dir, ["for-each-ref", "refs/heads/test-local/"]), "");
  const res = deploy(o(B), { run: okRun, spawnWatchdog: s.spawn, now: () => at });
  assert.equal(res.ok, true, res.text);
  const kept = "test-local/2026-11-17T063012Z";
  assert.match(res.text, new RegExp(`3 .*${kept}`));
  assert.equal(git(s.r.dir, ["rev-parse", `${kept}^`]), A);
  assert.equal(git(s.r.dir, ["log", "-1", "--format=%ae %ce", kept]), `${ROLE.author.email} ${ROLE.author.email}`);
  assert.deepEqual(git(s.r.dir, ["diff", "--name-status", A, kept]).split("\n"), ["M\tsrc/a.ts", "D\tsrc/gone.ts", "A\tsrc/mine.ts"]);
  assert.equal(git(s.r.dir, ["show", `${kept}:src/a.ts`]), "hand edit");
  assert.deepEqual(liveDrift(s.r.dir, s.live, B), [], "after it, the live copy is exactly the new commit");
  assert.equal(readDeployed(s.st)?.commit, B);
  edit();
  const again = deploy(o(C), { run: okRun, spawnWatchdog: s.spawn, now: () => at });
  assert.equal(again.ok, false, "the edits could not be kept (the branch is there): nothing deployed");
  assert.equal(readFileSync(join(s.live, "src/mine.ts"), "utf8"), "mine");
  assert.equal(readDeployed(s.st)?.commit, B);
});

test("deploy: refuses a blocked range", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/memory/b.ts", "b"); const B = s.r.save("fix: no helper");
  s.at(A);
  const res = deploy(s.o(B), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /帮手|修理单号/);
});

test("deploy: second deploy while locked is refused", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/memory/b.ts", "b"); const B = s.r.save("fix: x" + VERIFIED);
  s.at(A);
  mkdirSync(join(s.st, "repair"), { recursive: true });
  writeFileSync(join(s.st, "repair", "deploy.lock"), "other");
  const res = deploy(s.o(B), { run: okRun, spawnWatchdog: s.spawn, now: () => Date.now() });
  assert.equal(res.ok, false);
  assert.match(res.text, /另一个部署/);
});

test("deploy: migration in range asks for a snapshot at restart time, not now", () => {
  const s = deploySetup();
  s.r.put("src/store/db.ts", "x"); const A = s.r.save("A");
  s.r.put("src/store/db.ts", "x\n  ALTER TABLE mem_event ADD COLUMN y TEXT;\n"); const B = s.r.save("feat: migrate");
  s.at(A);
  const dbPath = join(s.st, "hh.db");
  openDb(dbPath).close();
  const res = deploy(s.o(B, { dbPath, guardDir: guardWith({ ...REC, shas: [B.slice(0, 12)] }) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.equal(JSON.parse(readFileSync(join(s.st, "repair", "restart-request.json"), "utf8")).migration, true);
  assert.deepEqual(readdirSync(join(s.st, "repair")).filter((n) => n.startsWith("hh.db.")), []);
});

// ---- 闲下来再重启、起来、健康 ----

const MEL = "Australia/Melbourne";
const AT_10 = Date.UTC(2026, 10, 1, 23, 0);     // 枫湾 11-02 10:00
const AT_0310 = Date.UTC(2026, 10, 1, 16, 10);  // 枫湾 11-02 03:10
type Calm = Pick<BrainStatus, "alertness" | "turning" | "regions" | "focusSlot" | "frontIdle">;
const IDLE: Calm = { alertness: "awake", turning: false, focusSlot: null, frontIdle: true, regions: [{ id: "main", open: true, busy: false, contextTokens: 0, generation: 0, sessionId: null }] };

test("calm: busy, focus and quiet window all block", () => {
  const q = RULES.restart.quiet;
  assert.equal(calmNow(IDLE, AT_10, MEL, q), true);
  assert.equal(calmNow({ ...IDLE, regions: [{ ...IDLE.regions[0]!, busy: true }] }, AT_10, MEL, q), false);
  assert.equal(calmNow({ ...IDLE, focusSlot: "09:00" }, AT_10, MEL, q), false);
  assert.equal(calmNow(IDLE, AT_0310, MEL, q), false);
  assert.equal(calmNow({ ...IDLE, alertness: "asleep" }, AT_10, MEL, q), false);
  assert.equal(calmNow({ ...IDLE, turning: true }, AT_10, MEL, q), false);
});

test("restart gate: needs the deployed commit and three calm ticks", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X", t: "t" }));
  const g = new RestartGate({ stateDir: st, rules: RULES, tz: MEL, now: () => AT_10 });
  const s = IDLE as BrainStatus;
  assert.equal(g.tick(s), null);
  assert.equal(g.tick({ ...IDLE, turning: true } as BrainStatus), null);   // 不平静：重新数
  assert.equal(g.tick(s), null);
  assert.equal(g.tick(s), null);
  assert.equal(g.tick(s), "restart");
  assert.equal(existsSync(join(st, "repair", "restart-request.json")), false);
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "restarting.json"), "utf8")).commit, "X");
  const other = tmpDir("hh-state-");
  writeDeployed(other, { commit: "X", prev: "W", t: "t", by: "test" });
  writeFileSync(join(other, "repair", "restart-request.json"), JSON.stringify({ commit: "Y", t: "t" }));
  const g2 = new RestartGate({ stateDir: other, rules: RULES, tz: MEL, now: () => AT_10 });
  for (let i = 0; i < 5; i++) assert.equal(g2.tick(s), null);
});

test("restart gate: her status is read only while a deploy waits for her to be calm (hhd ticks every 30 s)", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  const g = new RestartGate({ stateDir: st, rules: RULES, tz: MEL, now: () => AT_10 });
  let read = 0;
  const status = () => { read++; return IDLE as BrainStatus; };
  for (let i = 0; i < 3; i++) assert.equal(g.tick(status), null);
  assert.equal(read, 0, "no deploy waiting: not read");
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X", t: "t" }));
  for (let i = 0; i < 2; i++) assert.equal(g.tick(status), null);
  assert.equal(g.tick(status), "restart", "the same three calm ticks as with the status itself");
  assert.equal(read, 3);
});

test("health: healthy after enough ok ticks and uptime, reset on failure", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  markBoot(st, 4242);
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "boot.json"), "utf8")).commit, "X");
  let t = 0;
  const h = new HealthMark({ stateDir: st, rules: RULES.watch, started: 0, now: () => t, commit: "X" });
  const healthy = () => existsSync(join(st, "repair", "healthy.json"));
  for (const ok of [true, true, false, true, true]) { t += 30_000; h.tick(ok, { ok: 0, broken: 0 }); }
  assert.equal(healthy(), false);   // 失败过一次，只连着 2 次
  t += 30_000; h.tick(true, { ok: 0, broken: 0 });
  assert.equal(healthy(), true);
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "healthy.json"), "utf8")).pid, process.pid);
});

// ---- 看守 ----

/** 假的看守环境：虚拟时钟；schedule 在某个时刻往某个文件写内容 */
function fakeWatch(a: WatchArgs, plan: Array<{ at: number; file: string; body: unknown }>): { io: WatchIO; rolled: string[] } {
  let t = a.deployedAt;
  const files = new Map<string, string>();
  const rolled: string[] = [];
  const apply = () => { for (const p of plan) if (p.at <= t) files.set(join(a.stateDir, "repair", p.file), JSON.stringify(p.body)); };
  return {
    rolled,
    io: {
      read: (p) => { apply(); return files.get(p) ?? null; },
      now: () => t,
      sleep: async (ms) => { t += ms; },
      rollback: (_a, why) => { rolled.push(why); },
    },
  };
}
const WA: WatchArgs = { live: "/live", stateDir: "/st", gitDir: "/g", prev: "P", target: "T", deployedAt: 1_000_000, rules: RULES.watch, text: watchdogText(), authorEmail: ROLE.author.email, notify: OWNER.name };
const iso = (ms: number) => new Date(ms).toISOString();
const DEP = { at: 0, file: "deployed.json", body: { commit: "T", prev: "P", t: "x", by: "test" } };

test("watchdog: healthy restart", async () => {
  const t0 = WA.deployedAt + 3_600_000;
  const f = fakeWatch(WA, [DEP,
    { at: t0, file: "restarting.json", body: { commit: "T", t: iso(t0) } },
    { at: t0 + 40_000, file: "boot.json", body: { commit: "T", pid: 1, t: iso(t0 + 40_000) } },
    { at: t0 + 180_000, file: "healthy.json", body: { commit: "T", pid: 1, t: iso(t0 + 180_000) } }]);
  assert.equal(await watch(WA, f.io), "healthy");
  assert.deepEqual(f.rolled, []);
});

test("watchdog: no boot after restart rolls back", async () => {
  const t0 = WA.deployedAt + 60_000;
  const f = fakeWatch(WA, [DEP, { at: t0, file: "restarting.json", body: { commit: "T", t: iso(t0) } }]);
  assert.equal(await watch(WA, f.io), "rolled-back");
  assert.match(f.rolled[0] ?? "", /没起来/);
  assert.ok(f.io.now() - t0 >= RULES.watch.bootTimeoutMs);
});

test("watchdog: boot but never healthy rolls back", async () => {
  const t0 = WA.deployedAt + 60_000;
  const f = fakeWatch(WA, [DEP, { at: t0, file: "restarting.json", body: { commit: "T", t: iso(t0) } },
    { at: t0 + 30_000, file: "boot.json", body: { commit: "T", pid: 1, t: iso(t0 + 30_000) } }]);
  assert.equal(await watch(WA, f.io), "rolled-back");
  assert.match(f.rolled[0] ?? "", /没跑稳/);
});

test("watchdog: never restarted gives up without rollback", async () => {
  const f = fakeWatch(WA, [DEP]);
  assert.equal(await watch(WA, f.io), "gave-up");
  assert.deepEqual(f.rolled, []);
});

test("rollback: live goes back to prev and master gets a revert", () => {
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A = r.save("A");
  r.put("src/a.ts", "broken"); r.put("src/b.ts", "b"); const B = r.save("fix: x" + VERIFIED);
  const bare = tmpDir("hh-bare-");
  execFileSync("git", ["clone", "-q", "--bare", r.dir, bare]);
  const live = liveDir();
  execFileSync("bash", ["-c", `git -C ${bare} archive ${B} | tar -x -C ${live}`]);
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: B, prev: A, t: "x", by: "test" });
  process.env.HH_REPAIR_NO_SEND = "1";
  const stopped: string[] = [];
  realRollback({ ...WA, live, stateDir: st, gitDir: bare, prev: A, target: B, deployedAt: Date.now() }, "重启后没起来", { npm: () => true, stop: (s) => { stopped.push(s); } });
  assert.deepEqual(stopped, ["hhd", "console", "bridges"], "这次退回没动 src/console/，控制台和通道的桥也要跟着重启");
  assert.deepEqual(liveDrift(bare, live, A), []);
  assert.equal(readDeployed(st)?.commit, A);
  assert.equal(readDeployed(st)?.by, "watchdog");
  assert.match(git(bare, ["log", "-1", "--format=%B", "master"]), new RegExp(`Rollback-of: ${B}`));
  assert.equal(git(bare, ["rev-parse", "master^{tree}"]), git(bare, ["rev-parse", `${A}^{tree}`]));
  assert.ok(readEvents(st).some((e) => e.kind === "rollback"));
});

// ---- 命令行、早上的小结、运行说明 ----

test("summary: lists fixes, rollbacks and waiting items; empty when nothing", () => {
  const ev = (kind: string, extra: Record<string, string>) => ({ t: "2026-11-01T01:00:00.000Z", kind, text: "", ...extra }) as never;
  const s = summarize([ev("merge", { fix: "#0007", text: "提醒删不掉" }), ev("rollback", { from: "b", to: "a", text: "退回了部署 a → b：重启后 3 分钟没起来" }), ev("deploy", { text: "部署了" })], ["#0009"]);
  assert.match(s, /修好 #0007（提醒删不掉）/);
  assert.match(s, /退回/);
  assert.match(s, /还在等 ada：#0009/);
  assert.equal(summarize([ev("deploy", { text: "x" })], []), "");
  // an English role's rollback is found by its fields too, not by how its text begins
  setLang("en", TEST_NAMES);
  try { assert.match(summarize([ev("rollback", { from: "b", to: "a", text: "Rolled back the deploy a → b: did not come up; " })], []), /were rolled back automatically/); }
  finally { setLang(TEST_LANG, TEST_NAMES); }
});

test("the morning summary finds the owner's approvals and waiting list by the owner's name, whoever the owner is", () => {
  const ws = tmpDir("hh-repair-owner-");
  mkdirSync(join(ws, "memory"));
  writeFileSync(join(ws, "memory", "毛病本.md"), "# 毛病本\n\n## 问 ada\n- #0001 a\n\n## 问 老林\n- #0009 b\n");
  try {
    setLang("zh", { me: "衡", owner: "老林", ta: "他", place: "", id: "heng" });
    assert.deepEqual(waitingIds(ws), ["#0009"]);
    const ev = { t: "2026-11-01T01:00:00.000Z", kind: "deploy" as const, text: "部署了", items: ["abc1234 老林：老林 #12「可以」批了 #10 问的事", "def5678 ada：别的角色的"] };
    assert.equal(summarize([ev], []), "昨天的修理：上线了 老林 批过的：老林 #12「可以」批了 #10 问的事。");
  } finally { setLang(TEST_LANG, TEST_NAMES); }
});

test("waitingIds: reads ids under 问 ada only", () => {
  const ws = tmpDir("hh-ws-");
  mkdirSync(join(ws, "memory"));
  writeFileSync(join(ws, "memory", "毛病本.md"), "# 毛病本\n\n## 待修\n- #0003 a\n\n## 问 ada\n- #0009 b\n- #0012 c\n\n## 修好了\n- #0001 d\n");
  assert.deepEqual(waitingIds(ws), ["#0009", "#0012"]);
  assert.deepEqual(waitingIds(join(ws, "nope")), []);
});

test("persona: runtime note points at 毛病本 and 修系统", () => {
  assert.match(hhRuntimeNote(), /毛病本\.md/);
  assert.match(hhRuntimeNote(), /修系统\.md/);
});

test("cli: hh fix check prints reason keys", async () => {
  const r = tempRepo();
  r.put("src/regions/specs.ts", "a"); r.save("A");
  execFileSync("git", ["-C", r.dir, "checkout", "-q", "-b", "fix/0001-x"]);
  r.put("src/regions/specs.ts", "b"); r.save("wip");
  execFileSync("git", ["-C", r.dir, "checkout", "-q", "master"]);
  const st = tmpDir("hh-state-");
  const out = await repairCommand(["check", "fix/0001-x"], {
    cfg: loadConfig({ stateDir: st, workspace: st }), live: ROOT, gitDir: r.dir, checkDir: tmpDir("hh-check-"),
    clone: r.dir, guardDir: guardWith(REC), selfUid: UID + 1, role: ROLE, run: okRun,
  });
  assert.match(out, /protected:src\/regions\/specs\.ts/);
  assert.match(out, /问 ada/);
  assert.equal(git(r.dir, ["rev-parse", "--abbrev-ref", "HEAD"]), "master", "检查不动她克隆里的工作区");
});

// ---- 审阅后的修补（final review 的每一条一个测试）----

test("review #4: Verified-by must end in 通过, not 不通过", () => {
  assert.equal(verifiedOk("opus 通过"), true);
  assert.equal(verifiedOk("通过"), true);
  for (const v of ["opus 不通过", "opus 未通过", "opus 没通过", "opus 通过了一半，要改", "opus 要改"]) assert.equal(verifiedOk(v), false, v);
});

test("review #5: Ada's ask must name the fix; his words come back for the log", () => {
  const ok = ownerApproval(chatDb([ASK, OK(12, "whatsapp")]), TRAILERS, R2, OWNER);
  assert.equal(ok.ok, true);
  assert.match(ok.why, /可以，加吧/);
  const other = ownerApproval(chatDb([{ ...ASK, text: "（发给 ada）#0005 别的事" }, OK(12, "whatsapp")]), TRAILERS, R2, OWNER);
  assert.equal(other.ok, false);
  assert.match(other.why, /#0001/);
});

test("review #5: deploy log keeps each commit's verdict and the morning note shows Ada's words", () => {
  const ev = { t: "2026-11-01T01:00:00.000Z", kind: "deploy" as const, text: "部署了", items: ["abc1234 ada：ada #12「可以，加吧」批了 #10 问的事"] };
  assert.match(summarize([ev], []), /可以，加吧/);
});

test("review #8: the gate's test runs do not see her HH_CONFIG", () => {
  process.env.HH_CONFIG = "/home/role/.hh/config.json";
  try {
    const r = execRunner(process.execPath, ["-e", "console.log(process.env.HH_CONFIG ?? 'none')"], tmpdir());
    assert.equal(r.out.trim(), "none");
  } finally { delete process.env.HH_CONFIG; }
});

test("#0041: every child of a check (git, npm ci, tsc, npm test) gets none of her HH_* (HH_SESSION too, not just HH_CONFIG)", () => {
  // 她的 shell 里带着这些：手跑测试 brain.test.ts 挂 17 个，检查得是干净的环境（spawnSync 换成假的，不真跑一遍全部测试）
  const shell: Record<string, string> = { HH_CONFIG: "/home/role/.hh/config.json", HH_SESSION: "sess-4c", HH_DEPLOY_BY: "米拉", HH_REPAIR_NO_SEND: "1" };
  const saved = Object.fromEntries(Object.keys(shell).map((k) => [k, process.env[k]]));
  Object.assign(process.env, shell);
  const dir = tmpDir("hh-check-env-");
  const spawned: Array<{ cmd: string; hh: string[] }> = [];
  mock.method(childProcess, "spawnSync", (cmd: string, args: string[], o: { env?: NodeJS.ProcessEnv }) => {
    spawned.push({ cmd: [cmd, ...args].join(" "), hh: Object.keys(o.env ?? process.env).filter((k) => k.startsWith("HH_")) });
    return { status: 0, stdout: "", stderr: "" };
  });
  syncBuiltinESMExports();
  try {
    const r = runChecks(dir, "/src/repo", "abc", execRunner);
    assert.equal(r.tests.ok, true);
    const cmds = spawned.map((s) => s.cmd);
    assert.ok(cmds.includes("npm test") && cmds.includes("npx tsc --noEmit") && cmds.includes("npm ci"), cmds.join(" | "));
    for (const s of spawned) assert.deepEqual(s.hh, [], s.cmd);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review #9: HH's own ways of starting a process ask; sqlite run does not", () => {
  const v = judge(commit([change("src/tools/hhtools.ts", "M", ['        const r = await ctx.run("/bin/rm", ["-rf", "x"]);'])]), RULES);
  assert.ok(keys(v).includes("capability:process"));
  const db = judge(commit([change("src/memory/recall.ts", "M", ['  db.prepare("UPDATE t SET a = 1").run();'])]), RULES);
  assert.ok(!keys(db).includes("capability:process"));
});

test("review #10: anything outside src/, test/ and docs/ asks", () => {
  for (const p of [".claude/settings.json", "CLAUDE.md", ".mcp.json", ".gitattributes", ".npmrc", ".husky/pre-commit", "README.md"]) {
    const v = judge(commit([change(p, "A", ["x"])]), RULES);
    assert.equal(v.outcome, "ask", p);
    assert.ok(keys(v).includes(`outside:${p}`), p);
  }
  assert.equal(judge(commit([change("docs/notes.md", "A", ["x"])]), RULES).outcome, "pass");
});

test("review #11: Chinese file names and -diff attributes do not hide a change", () => {
  const r = tempRepo();
  r.put(".gitattributes", "*.ts -diff\n"); r.put("src/a.ts", "a"); r.save("A");
  r.put("src/kernel/新.ts", 'import { spawn } from "node:child_process";\n');
  const sha = r.save("fix: x");
  const c = commitInfo(r.dir, sha);
  assert.deepEqual(c.files.map((f) => f.path), ["src/kernel/新.ts"]);
  const v = judge(c, RULES);
  assert.ok(keys(v).includes("protected:src/kernel/新.ts"));
  assert.ok(keys(v).includes("capability:process"));
});

test("review #12: the repair commands only run from the live install", async () => {
  const st = tmpDir("hh-state-");
  await assert.rejects(repairCommand(["log"], { cfg: loadConfig({ stateDir: st, workspace: st }), live: tmpDir("hh-notlive-"), gitDir: st, checkDir: st, clone: st, guardDir: st, selfUid: UID + 1, role: ROLE }), /线上/);
});

test("review #14: no restart while the front is preparing or holding a message", () => {
  assert.equal(calmNow({ ...IDLE, frontIdle: false }, AT_10, MEL, RULES.restart.quiet), false);
});

test("review #1: the snapshot is taken at restart time and named in restarting.json", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X", t: "t", migration: true }));
  const g = new RestartGate({ stateDir: st, rules: RULES, tz: MEL, now: () => AT_10 });
  for (let i = 0; i < 3; i++) g.tick(IDLE as BrainStatus);
  const snap = g.snapshot;
  assert.ok(snap && snap.startsWith(join(st, "repair")));
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "restarting.json"), "utf8")).snapshot, snap);
  const db = new DatabaseSync(join(st, "hh.db"));
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('latest')");
  snapshotDb(db, snap!);
  db.close();
  const copy = new DatabaseSync(snap!, { readOnly: true });
  assert.deepEqual(copy.prepare("SELECT v FROM t").all().map((r) => (r as { v: string }).v), ["latest"]);
  copy.close();
});

/** 一次完整的「部署 B → 起不来 → 退回」：返回共享仓库、线上目录、状态目录和几个提交 */
function rolledBack(opts: { snapshot?: boolean; lockChange?: boolean; keptModules?: boolean; booted?: boolean; healthy?: boolean; conflict?: boolean } = {}): { bare: string; live: string; st: string; A: string; B: string; npm: string[] } {
  const r = tempRepo();
  r.put("src/a.ts", "a"); r.put("package-lock.json", "v1"); r.put("test/a.test.ts", 'test("a", () => { assert.ok(1); });\n'); const A = r.save("A");
  r.put("src/a.ts", "broken"); r.put("test/a.test.ts", 'test("a", () => { assert.ok(1); });\ntest("b", () => { assert.ok(2); });\n');
  if (opts.lockChange) r.put("package-lock.json", "v2");
  const B = r.save("fix: x" + VERIFIED);
  if (opts.conflict) { r.put("src/a.ts", "later"); r.save("feat: someone else touched a.ts"); }
  const bare = tmpDir("hh-bare-");
  execFileSync("git", ["clone", "-q", "--bare", r.dir, bare]);
  const live = liveDir();
  execFileSync("bash", ["-c", `git -C ${bare} archive ${B} | tar -x -C ${live}`]);
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: B, prev: A, t: "x", by: "test" });
  const t0 = Date.now();
  if (opts.keptModules) {
    mkdirSync(join(live, "node_modules"));
    writeFileSync(join(live, "node_modules", "m"), "B");
    mkdirSync(join(`${live}.npm-prev`, "node_modules"), { recursive: true });
    writeFileSync(join(`${live}.npm-prev`, "node_modules", "m"), "A");
    writeFileSync(join(`${live}.npm-prev`, "lock"), git(bare, ["rev-parse", `${A}:package-lock.json`]));
  }
  if (opts.booted) writeFileSync(join(st, "repair", "boot.json"), JSON.stringify({ commit: B, pid: 1, t: new Date(t0).toISOString() }));
  if (opts.healthy) writeFileSync(join(st, "repair", "healthy.json"), JSON.stringify({ commit: B, pid: 1, t: new Date(t0).toISOString() }));
  if (opts.snapshot) {
    const live2 = new DatabaseSync(join(st, "hh.db"));
    live2.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('migrated-but-broken')");
    live2.close();
    const snap = new DatabaseSync(join(st, "repair", "hh.db.snap"));
    snap.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('before-restart')");
    snap.close();
    writeFileSync(join(st, "repair", "restarting.json"), JSON.stringify({ commit: B, t: new Date(t0).toISOString(), snapshot: join(st, "repair", "hh.db.snap") }));
  }
  process.env.HH_REPAIR_NO_SEND = "1";
  const npm: string[] = [];
  realRollback({ ...WA, live, stateDir: st, gitDir: bare, prev: A, target: B, deployedAt: t0 }, "重启后没起来", { npm: (dir) => { npm.push(dir); return true; } });
  return { bare, live, st, A, B, npm };
}

test("review #1: a never-booted migration rolls the db back to the restart-time snapshot", () => {
  const { st } = rolledBack({ snapshot: true });
  const db = new DatabaseSync(join(st, "hh.db"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT v FROM t").all().map((r) => (r as { v: string }).v), ["before-restart"]);
  db.close();
});

test("review #7: rollback reinstalls dependencies when the lock file changed", () => {
  assert.equal(rolledBack({ lockChange: true }).npm.length, 1);
  assert.equal(rolledBack().npm.length, 0);
});

test("review #2: the watchdog's revert does not block the next deploy", () => {
  const { bare, A, st } = rolledBack();
  const R = git(bare, ["rev-parse", "refs/heads/master"]);
  const res = evaluateRange({ owner: OWNER, dir: bare, from: A, to: R, rules: RULES, guardDir: guardWith({ ...REC, shas: [git(bare, ["rev-parse", `${R}^`])] }), selfUid: UID + 1, db: null, rollbacks: rolledBackRanges(st) });
  assert.equal(res.ok, true, JSON.stringify(res.items.map((i) => i.why)));
  assert.equal(res.items.at(-1)?.via, "rollback");
});

test("review #2: a commit that only claims to be a rollback is not let through", () => {
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A = r.save("A");
  r.put("src/a.ts", "b"); const B = r.save("fix: x" + VERIFIED);
  r.put("src/a.ts", "c"); const F = r.save(`revert: fake\n\nRollback-of: ${B}\nRollback-range: ${A}..${B}`);
  const res = evaluateRange({ owner: OWNER, dir: r.dir, from: B, to: F, rules: RULES, guardDir: guardWith(REC), selfUid: UID + 1, db: null });
  assert.equal(res.items[0]?.via, "blocked");
});

test("range: the rollback check's temp worktree dir is removed after, also when the revert fails (#0055)", () => {
  const { bare, A, st } = rolledBack();
  const R = git(bare, ["rev-parse", "refs/heads/master"]);
  const guard = guardWith({ ...REC, shas: [git(bare, ["rev-parse", `${R}^`])] });
  const rollbacks = rolledBackRanges(st);
  assert.deepEqual(leftInTmp(() => {
    assert.equal(evaluateRange({ owner: OWNER, dir: bare, from: A, to: R, rules: RULES, guardDir: guard, selfUid: UID + 1, db: null, rollbacks }).items.at(-1)?.via, "rollback");
  }), [], "还原对上了");
  // 范围里的提交不存在：revert 出错，照样删
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A2 = r.save("A");
  const bogus = `${"1".repeat(40)}..${"2".repeat(40)}`;
  r.put("src/a.ts", "b"); const F = r.save(`revert: x\n\nRollback-of: ${"2".repeat(40)}\nRollback-range: ${bogus}`);
  const guard2 = guardWith(REC);
  assert.deepEqual(leftInTmp(() => {
    assert.equal(evaluateRange({ owner: OWNER, dir: r.dir, from: A2, to: F, rules: RULES, guardDir: guard2, selfUid: UID + 1, db: null, rollbacks: [bogus] }).items[0]?.via, "blocked");
  }), [], "还原出错");
});

test("review #6: a boot of the new code counts even without restarting.json (crash, reboot)", async () => {
  const t0 = WA.deployedAt + 60_000;
  const f = fakeWatch(WA, [DEP,
    { at: t0, file: "boot.json", body: { commit: "T", pid: 1, t: iso(t0) } },
    { at: t0 + 150_000, file: "healthy.json", body: { commit: "T", pid: 1, t: iso(t0 + 150_000) } }]);
  assert.equal(await watch(WA, f.io), "healthy");
});

test("review #6: a newer deploy takes over while waiting for health", async () => {
  const t0 = WA.deployedAt + 60_000;
  const f = fakeWatch(WA, [DEP, { at: t0, file: "restarting.json", body: { commit: "T", t: iso(t0) } },
    { at: t0 + 30_000, file: "boot.json", body: { commit: "T", pid: 1, t: iso(t0 + 30_000) } },
    { at: t0 + 60_000, file: "deployed.json", body: { commit: "U", prev: "T", t: "x", by: "test" } }]);
  assert.equal(await watch(WA, f.io), "gave-up");
  assert.deepEqual(f.rolled, []);
});

test("review #6: stacking a deploy on one that has not run healthy rolls back to the last healthy commit", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/b.ts", "b"); const B = s.r.save("feat: B");
  s.r.put("src/c.ts", "c"); const C = s.r.save("feat: C");
  s.at(A);
  const g = guardWith({ ...REC, shas: [B, C] });
  assert.equal(deploy(s.o(B, { guardDir: g }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 }).ok, true);
  assert.equal(s.watched[0]?.prev, A);
  assert.equal(deploy(s.o(C, { guardDir: g }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 }).ok, true);
  assert.equal(s.watched[1]?.prev, A, "B 还没跑稳，退回要退到 A");
  writeFileSync(join(s.st, "repair", "healthy.json"), JSON.stringify({ commit: C, pid: 1, t: "x" }));
  s.r.put("src/d.ts", "d"); const D = s.r.save("feat: D");
  assert.equal(deploy(s.o(D, { guardDir: guardWith({ ...REC, shas: [D] }) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 }).ok, true);
  assert.equal(s.watched[2]?.prev, C);
});

test("review #7: a failed npm ci refuses the deploy and puts the old version back", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); s.r.put("package-lock.json", "v1"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); s.r.put("package-lock.json", "v2"); const B = s.r.save("feat: deps");
  s.at(A);
  const failNpm: Runner = (cmd, args) => (cmd === "npm" && args[0] === "ci" && args.includes("--omit=dev") ? { code: 1, out: "ERESOLVE", ms: 1 } : { code: 0, out: "ok", ms: 1 });
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B] }) }), { run: failNpm, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /依赖/);
  assert.equal(readFileSync(join(s.live, "src/a.ts"), "utf8"), "a");
  assert.equal(readDeployed(s.st)?.commit, A);
});

// ---- 11-02 第二轮审阅（sess-62）----

import { takeLock } from "../src/repair/lock.ts";
import { countTurns, snapshotAtBoot, ensureWatchdog } from "../src/repair/restart.ts";
import { rolledBackRanges, readHeld } from "../src/repair/log.ts";

test("review2 #1: new dependencies install beside live and swap in; the old ones are kept for a rollback", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); s.r.put("package.json", "{}"); s.r.put("package-lock.json", "v1"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); s.r.put("package-lock.json", "v2"); const B = s.r.save("feat: deps");
  s.at(A);
  mkdirSync(join(s.live, "node_modules"));
  writeFileSync(join(s.live, "node_modules", "m"), "old");
  const cwds: string[] = [];
  const npm: Runner = (cmd, args, cwd) => {
    if (cmd === "npm" && args.includes("--omit=dev")) {
      cwds.push(cwd);
      assert.equal(readFileSync(join(cwd, "package-lock.json"), "utf8"), "v2");
      mkdirSync(join(cwd, "node_modules"), { recursive: true });
      writeFileSync(join(cwd, "node_modules", "m"), "new");
    }
    return { code: 0, out: "ok", ms: 1 };
  };
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B] }) }), { run: npm, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.equal(cwds.length, 1);
  assert.notEqual(cwds[0], s.live);
  assert.equal(readFileSync(join(s.live, "node_modules", "m"), "utf8"), "new");
  assert.equal(readFileSync(join(`${s.live}.npm-prev`, "node_modules", "m"), "utf8"), "old");
});

test("review2 #1: a failed install leaves live code and node_modules untouched", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); s.r.put("package.json", "{}"); s.r.put("package-lock.json", "v1"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); s.r.put("package-lock.json", "v2"); const B = s.r.save("feat: deps");
  s.at(A);
  mkdirSync(join(s.live, "node_modules"));
  writeFileSync(join(s.live, "node_modules", "m"), "old");
  const ran: string[] = [];
  const failNpm: Runner = (cmd, args, cwd) => { if (cmd === "npm") ran.push(cwd); return cmd === "npm" ? { code: 1, out: "ERESOLVE", ms: 1 } : { code: 0, out: "ok", ms: 1 }; };
  const res = deploy(s.o(B, { guardDir: guardWith({ ...REC, shas: [B] }) }), { run: failNpm, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.ok(!ran.includes(s.live), "不在线上目录里装");
  assert.equal(readFileSync(join(s.live, "src/a.ts"), "utf8"), "a");
  assert.equal(readFileSync(join(s.live, "node_modules", "m"), "utf8"), "old");
});

test("review2 #1: rollback swaps the kept dependencies back instead of reinstalling", () => {
  const { live, npm } = rolledBack({ lockChange: true, keptModules: true });
  assert.equal(npm.length, 0);
  assert.equal(readFileSync(join(live, "node_modules", "m"), "utf8"), "A");
});

test("review2 #2: a check refuses while another check holds the check clone", () => {
  const dir = tmpDir("hh-check-");
  writeFileSync(join(dir, ".check.lock"), JSON.stringify({ pid: process.pid, t: new Date().toISOString() }));
  const calls: string[] = [];
  const r = runChecks(dir, "/src", "abc", (cmd) => { calls.push(cmd); return { code: 0, out: "", ms: 1 }; });
  assert.equal(r.tests.ok, false);
  assert.match(r.tests.tail, /另一个检查/);
  assert.deepEqual(calls, []);
});

test("review2 #2/#8f: a lock left by a dead process is taken over; a live one is not", () => {
  const dir = tmpDir("hh-lock-");
  const p = join(dir, "x.lock");
  writeFileSync(p, JSON.stringify({ pid: 4_194_304, t: "2026-11-01T00:00:00Z" }));
  const release = takeLock(p, 30 * 60_000);
  assert.ok(release, "死掉的进程留下的锁可以接手");
  assert.equal(JSON.parse(readFileSync(p, "utf8")).pid, process.pid);
  assert.equal(takeLock(p, 30 * 60_000), null, "活着的进程拿着就不行");
  release!();
  assert.equal(existsSync(p), false);
});

test("review2 #3: boot and health mark the commit this process booted, even if a deploy lands meanwhile", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  const booted = markBoot(st, 4242);
  assert.equal(booted, "X");
  writeDeployed(st, { commit: "Y", prev: "X", t: "t", by: "test" });
  let t = 0;
  const h = new HealthMark({ stateDir: st, rules: RULES.watch, started: 0, now: () => t, commit: booted });
  for (let i = 0; i < 5; i++) { t += 30_000; h.tick(true, { ok: 0, broken: 0 }); }
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "healthy.json"), "utf8")).commit, "X");
});

test("boot records whether the live copy is the deployed commit as it was — a record only; could not be checked, boot goes on", () => {
  const r = tempRepo();
  r.put(".gitignore", "node_modules/\n"); r.put("src/a.ts", "a"); const A = r.save("A");
  const live = liveDir();
  execFileSync("bash", ["-c", `git -C ${r.dir} archive ${A} | tar -x -C ${live}`]);
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: A, prev: null, t: "t", by: "test" });
  const tree = () => JSON.parse(readFileSync(join(st, "repair", "boot.json"), "utf8")).tree;
  markBoot(st, 4242, live, r.dir);
  assert.deepEqual(tree(), { head: A, dirty: 0 });
  writeFileSync(join(live, "src/a.ts"), "edited"); writeFileSync(join(live, "src/b.ts"), "b");
  assert.equal(markBoot(st, 4242, live, r.dir), A);
  assert.deepEqual(tree(), { head: A, dirty: 2 });
  markBoot(st, 4242, live, join(st, "no-repo"));
  assert.equal(tree(), null);
});

test("the live copy is the code hhd booted from; before a boot records it, the copy running the command", () => {
  const st = tmpDir("hh-state-");
  assert.equal(liveRoot(st), join(import.meta.dirname, ".."));
  markBoot(st, 4242, "/srv/hh-live");
  assert.equal(liveRoot(st), "/srv/hh-live");
});

test("two roles under one OS user: stopping role A's recorded console ends A's alone; a reused pid stops nothing; a bridge is stopped by its record too", async () => {
  const child = () => childProcess.spawn(process.execPath, ["-e", "setTimeout(()=>{}, 30000)"], { stdio: "ignore" });
  const a = child(), b = child();
  try {
    const roleA = tmpDir("hh-state-"), roleB = tmpDir("hh-state-");
    markConsole(roleA, a.pid!);
    markConsole(roleB, b.pid!);
    const aExit = new Promise((done) => a.once("exit", done));
    assert.equal(stopRecorded(roleA, "console.json"), true);
    await aExit;
    assert.equal(a.signalCode, "SIGTERM");
    assert.equal(b.signalCode, null, "role B's console is untouched");
    assert.equal(JSON.parse(readFileSync(join(roleB, "repair", "console.json"), "utf8")).pid, b.pid);
    assert.equal(stopRecorded(roleA, "console.json"), false, "the recorded process is gone: nothing to stop");
    assert.equal(stopRecorded(tmpDir("hh-state-"), "console.json"), false, "no record: nothing to stop");
    writeFileSync(join(roleB, "repair", "console.json"), JSON.stringify({ pid: b.pid, t: new Date(Date.now() - 60_000).toISOString() }));
    assert.equal(stopRecorded(roleB, "console.json"), false, "this pid's process started after the record: a reused pid");
    assert.equal(b.signalCode, null);
    // a channel bridge records itself the same way, and is found among the role's records by its channel
    markRecord(roleB, bridgeRecord("whatsapp"), b.pid!);
    assert.deepEqual([bridgeRecords(roleA), bridgeRecords(roleB)], [[], ["bridge-whatsapp.json"]]);
    const bExit = new Promise((done) => b.once("exit", done));
    assert.equal(stopRecorded(roleB, "bridge-whatsapp.json"), true);
    await bExit;
  } finally { a.kill(); b.kill(); }
});

test("review2 #4: failing turns block health; a finished turn proves it; three broken turns mark it sick", () => {
  const st = tmpDir("hh-state-");
  const file = (n: string) => existsSync(join(st, "repair", n));
  let t = 0;
  const h = new HealthMark({ stateDir: st, rules: RULES.watch, started: 0, now: () => t, commit: "X" });
  for (let i = 0; i < 6; i++) { t += 30_000; h.tick(true, { ok: 0, broken: 1 }); }
  assert.equal(file("healthy.json"), false, "一轮都没成、坏了一轮：不算跑稳");
  t += 30_000; h.tick(true, { ok: 1, broken: 1 });
  assert.equal(file("healthy.json"), true);
  assert.equal(file("proven.json"), true);
  const st2 = tmpDir("hh-state-");
  const h2 = new HealthMark({ stateDir: st2, rules: RULES.watch, started: 0, now: () => t, commit: "X" });
  for (let i = 0; i < 6; i++) { t += 30_000; h2.tick(true, { ok: 0, broken: 0 }); }
  assert.equal(existsSync(join(st2, "repair", "healthy.json")), true, "没人说话：照 tick 算跑稳");
  h2.tick(true, { ok: 0, broken: 3 });
  assert.equal(JSON.parse(readFileSync(join(st2, "repair", "sick.json"), "utf8")).commit, "X");
});

test("review2 #4: quota, network and interrupts do not count as broken turns", () => {
  assert.deepEqual(countTurns([{ ok: true }, { ok: false, error: "error_during_execution" }, { ok: false, error: "interrupted" },
    { ok: false, error: "429 rate_limit_error" }, { ok: false, error: "fetch failed: ECONNRESET" }, { ok: false, error: "Claude AI usage limit reached" },
    { ok: false, error: "api_error:server_error" }, { ok: false, error: "api_error:unknown" }]), { ok: 1, broken: 1 });
});

test("review2 #4: the watchdog waits for a finished turn after health and rolls back if she is sick", async () => {
  const W = { ...WA, rules: { ...RULES.watch, turnWaitMs: 6 * 3_600_000 } };
  const t0 = W.deployedAt + 60_000;
  const base = [DEP, { at: t0, file: "restarting.json", body: { commit: "T", t: iso(t0) } },
    { at: t0 + 30_000, file: "boot.json", body: { commit: "T", pid: 1, t: iso(t0 + 30_000) } },
    { at: t0 + 160_000, file: "healthy.json", body: { commit: "T", pid: 1, t: iso(t0 + 160_000) } }];
  const sick = fakeWatch(W, [...base, { at: t0 + 3_600_000, file: "sick.json", body: { commit: "T", t: iso(t0 + 3_600_000) } }]);
  assert.equal(await watch(W, sick.io), "rolled-back");
  assert.match(sick.rolled[0] ?? "", /失败/);
  const proven = fakeWatch(W, [...base, { at: t0 + 3_600_000, file: "proven.json", body: { commit: "T", t: iso(t0 + 3_600_000) } }]);
  assert.equal(await watch(W, proven.io), "healthy");
  assert.deepEqual(proven.rolled, []);
  const quiet = fakeWatch(W, base);
  assert.equal(await watch(W, quiet.io), "healthy", "一直没人说话：等够了就算");
});

test("review2 #5: a migration deploy that boots without the calm restart is snapshotted before the db opens", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X".repeat(40), prev: "W", t: "t", by: "test" });
  const dbPath = join(st, "hh.db");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('old-schema')");
  db.close();
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X".repeat(40), t: "t", migration: true }));
  const snap = snapshotAtBoot(st, dbPath, "X".repeat(40));
  assert.ok(snap);
  const copy = new DatabaseSync(snap!, { readOnly: true });
  assert.deepEqual(copy.prepare("SELECT v FROM t").all().map((r) => (r as { v: string }).v), ["old-schema"]);
  copy.close();
  assert.equal(JSON.parse(readFileSync(join(st, "repair", "restarting.json"), "utf8")).snapshot, snap);
  assert.equal(snapshotAtBoot(st, dbPath, "Y".repeat(40)), null, "跑的不是这次部署的提交：不备份");
});

test("review2 #5: rollback before health restores the snapshot and keeps the new db aside; after health it keeps the new db", () => {
  const early = rolledBack({ snapshot: true, booted: true });
  const db = new DatabaseSync(join(early.st, "hh.db"), { readOnly: true });
  assert.deepEqual(db.prepare("SELECT v FROM t").all().map((r) => (r as { v: string }).v), ["before-restart"]);
  db.close();
  const aside = readdirSync(early.st).filter((n) => n.startsWith("hh.db.rolled-back-"));
  assert.equal(aside.length, 1, "新版本写过的那份留着");
  const late = rolledBack({ snapshot: true, booted: true, healthy: true });
  const db2 = new DatabaseSync(join(late.st, "hh.db"), { readOnly: true });
  assert.deepEqual(db2.prepare("SELECT v FROM t").all().map((r) => (r as { v: string }).v), ["migrated-but-broken"]);
  db2.close();
});

test("review2 #6: files Claude Code loads by itself ask anywhere, in any case", () => {
  for (const p of ["src/CLAUDE.md", "docs/a/claude.md", "test/.claude/settings.json", "src/AGENTS.md", "docs/CLAUDE.local.md", "src/.mcp.json"]) {
    assert.ok(keys(judge(commit([change(p, "A", ["x"])]), RULES)).includes(`protected:${p}`), p);
  }
  assert.deepEqual(keys(judge(commit([change("docs/claude-notes.md", "A", ["x"])]), RULES)), []);
});

test("review2 #7: commits the watchdog could not revert on master stay held until a revert lands", () => {
  const s = deploySetup();
  s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put("src/a.ts", "b"); const B = s.r.save("feat: B");
  s.r.put("src/c.ts", "c"); const C = s.r.save("feat: C");
  s.at(A);
  writeFileSync(join(s.st, "repair", "held.json"), JSON.stringify([{ prev: A, target: B, t: "x", why: "还原有冲突" }]));
  const g = (shas: string[]) => guardWith({ ...REC, shas });
  const res = deploy(s.o(C, { guardDir: g([B, C]) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /退回过/);
  s.r.put("src/a.ts", "a"); const R = s.r.save(`revert: B by hand\n\nRollback-of: ${B}\nRollback-range: ${A}..${B}`);
  const ok = deploy(s.o(R, { guardDir: g([B, C, R]) }), { run: okRun, spawnWatchdog: s.spawn, now: () => 0 });
  assert.equal(ok.ok, true, ok.text);
  assert.deepEqual(readHeld(s.st), []);
});

test("review2 #7: a revert conflict on master is written down as held", () => {
  const { st, A, B } = rolledBack({ conflict: true });
  assert.deepEqual(readHeld(st).map((h) => `${h.prev}..${h.target}`), [`${A}..${B}`]);
});

test("review2 #8a: only a revert the watchdog actually made passes as a rollback", () => {
  const { bare, A, st } = rolledBack();
  const R = git(bare, ["rev-parse", "refs/heads/master"]);
  const g = guardWith({ ...REC, shas: [git(bare, ["rev-parse", `${R}^`])] });
  const without = evaluateRange({ owner: OWNER, dir: bare, from: A, to: R, rules: RULES, guardDir: g, selfUid: UID + 1, db: null });
  assert.equal(without.items.at(-1)?.via, "blocked");
  const withLog = evaluateRange({ owner: OWNER, dir: bare, from: A, to: R, rules: RULES, guardDir: g, selfUid: UID + 1, db: null, rollbacks: rolledBackRanges(st) });
  assert.equal(withLog.items.at(-1)?.via, "rollback");
});

test("review2 #8c: a restart request for the commit already running is dropped, not acted on", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X", t: "t" }));
  const g = new RestartGate({ stateDir: st, rules: RULES, tz: MEL, now: () => AT_10, bootCommit: "X" });
  for (let i = 0; i < 5; i++) assert.equal(g.tick(IDLE as BrainStatus), null);
  assert.equal(existsSync(join(st, "repair", "restart-request.json")), false);
});

test("review2 #8d: a boot respawns the watchdog when the deploy is still unwatched", () => {
  const st = tmpDir("hh-state-");
  writeDeployed(st, { commit: "T", prev: "P", t: "t", by: "test" });
  writeFileSync(join(st, "repair", "watchdog.ts"), "// copy");
  writeFileSync(join(st, "repair", "watch.json"), JSON.stringify({ ...WA, stateDir: st }));
  const spawned: string[] = [];
  const spawn = (script: string, arg: string) => { spawned.push(`${script} ${JSON.parse(arg).target}`); };
  assert.equal(ensureWatchdog(st, spawn), true);
  assert.deepEqual(spawned, [`${join(st, "repair", "watchdog.ts")} T`]);
  writeFileSync(join(st, "repair", "watchdog.pid"), JSON.stringify({ pid: process.pid, target: "T" }));
  assert.equal(ensureWatchdog(st, spawn), false, "看守还活着");
  writeDeployed(st, { commit: "U", prev: "T", t: "t", by: "test" });
  rmSync(join(st, "repair", "watchdog.pid"));
  assert.equal(ensureWatchdog(st, spawn), false, "线上已经不是这次部署了");
});

test("review2 #8e: an error in the middle of a rollback is logged, not thrown", () => {
  const st = tmpDir("hh-state-");
  process.env.HH_REPAIR_NO_SEND = "1";
  assert.doesNotThrow(() => realRollback({ ...WA, live: liveDir(), stateDir: st, gitDir: join(st, "no-such-repo") }, "测试"));
  assert.ok(readEvents(st).some((e) => e.kind === "rollback" && /出错/.test(e.text)));
});

test("review2 #8g: the gate's test runs use the node that runs hh", () => {
  const r = execRunner("sh", ["-c", "echo $PATH"], tmpdir());
  assert.ok(r.out.startsWith(dirname(process.execPath) + ":"), r.out);
});

test("review2 #8h: the people registry is checked only for who counts as ada", () => {
  const dir = tmpDir("hh-reg-");
  const p = join(dir, "registry.json");
  const put = (ada: Record<string, unknown>) => writeFileSync(p, JSON.stringify({ ada: { name: "G", senders: ["+61 1", "a"], sessionKeys: ["k"], ...ada }, gua: { name: "顾" } }));
  put({});
  const a = stamp([`${p}#ada`])[0];
  put({ profile: "edited", aliases: ["x"] });
  assert.equal(stamp([`${p}#ada`])[0]?.sha256, a?.sha256, "改备注、别名不算");
  put({ senders: ["+61 1", "a", "+1 guest"] });
  assert.notEqual(stamp([`${p}#ada`])[0]?.sha256, a?.sha256, "多了一个算 ada 的号码要报");
  assert.equal(a?.sha256, createHash("sha256").update("senders:+61 1\na\nsessionKeys:k").digest("hex"), "和 hh-guard baseline 算法一样");
});

test("review2 #8j: a commit with neither approval nor fix trailers says what is missing", () => {
  const r = tempRepo();
  r.put("src/a.ts", "a"); const A = r.save("A");
  r.put("src/a.ts", "b"); const B = r.save("feat: unapproved session work");
  const res = evaluateRange({ owner: OWNER, dir: r.dir, from: A, to: B, rules: RULES, guardDir: guardWith(REC), selfUid: UID + 1, db: null });
  assert.match(res.items[0]?.why ?? "", /批准记录/);
});

// ---- 部署前的入口检查（entries.ts）：跑要部署的那个提交里的 ops/check-instance-entries.sh ----

import { entryCheck, entryRows } from "../src/repair/entries.ts";
import { symlinkSync } from "node:fs";

// 脚本输出的样子（路径都是编的）：一行以 绿 / 红 / 看 / 跳 加两个空格开头，紧跟在下面、四个空格开头的是它的凭据
const GREEN_A = ["绿  /w/ws/tools/a.py：自己往环境里放了 HH_CONFIG", "    12:env[\"HH_CONFIG\"] = CFG"];
const RED_B = ["红  /w/ws/tools/b.py：它和起它的 /w/agents/x.b.plist 里都没有 HH_CONFIG 这几个字", "    3:subprocess.run([\"node\", \"/w/hh/src/cli.ts\", \"send\"])", "    起它的：/w/agents/x.b.plist"];
const LOOK_C = ["看  /w/ws/tools/c.sh：自己没有认得的 HH_CONFIG 写法，也没有 launchd 任务点它的名", "    5:node /w/hh/src/hhd.ts", "    起它的：没有 launchd 任务点它的名（谁起它就继承谁的环境）"];
const SKIP_D = ["跳  /w/ws/scripts/test_d.py"];
const LOOK_E = ["看  /w/agents/x.e.plist：读不了，没法看它起什么"];
const RED_F = ["红  /w/agents/x.f.plist：这个 plist 直接起入口，里面没有 HH_CONFIG 这几个字", "    9:<string>/w/hh/src/hhd.ts</string>"];
// 有红时结论里的出路（措辞是编的；钩子只认「不能部署」开头的那一行到跑完的标记之前）
const ADVICE = ["不能部署：红的每一处先带上 HH_CONFIG。", "认得的写法：export HH_CONFIG=…，或者和命令同一行的 HH_CONFIG=… node …。", "要是这个文件只是提到这几个路径、并不起它们：写一行带 HH_CONFIG 的注释，它就会列成「看」，不再拦。"];
const done = (red: number, look: number): string => `entry-check: done red=${red} look=${look}`;
const marks = (rows: string[][], mark: string): number => rows.filter((r) => r[0]?.startsWith(`${mark}  `)).length;
/** 跑完的输出：rows 在第 4 条里；前面一节里缩进的行不跟着任何一行（不能算到别人头上）；有红就带上结论里的出路；最后一行是跑完的标记 */
const entryOut = (...rows: string[][]): string => {
  const red = marks(rows, "红");
  return ["", "== 3. 定时和常驻任务", "    /w/agents/x.g.plist", "", "== 4. 直接起入口的", ...rows.flat(), "", "== 结论", "直接起入口的：几处；红几处。",
    ...(red ? ADVICE : ["没有红的。"]), done(red, marks(rows, "看"))].join("\n") + "\n";
};
const CALM = entryOut();
const DONE_AT_END = /entry-check: done[^\n]*\n$/;
const last10 = (out: string): string => out.trimEnd().split("\n").slice(-10).join("\n");
const refusedRed = (lines: string[], n: number, advice: string[] = ADVICE): string => `有入口没带 HH_CONFIG（${n} 处），上线后它们会直接退出：\n${lines.join("\n")}\n${advice.join("\n")}`;
const notRun = (code: number, tail: string): string => `入口检查自己没跑成（退出码 ${code}），没法判断，先不部署：\n${tail}`;

const SCRIPT = join("ops", "check-instance-entries.sh");
// 钩子把脚本当 bash -c 的文本跑，这是它的 $0
const ARGV0 = "check-instance-entries";
// git 的 helper 去掉输出最后的一个换行：交给 bash 的文本比文件少结尾那个换行，照样跑
const asRun = (script: string): string => script.replace(/\n$/, "");
const SKIP = { by: "某会话", why: "误报：起它的任务已经停了" };
const skipRec = (sha: string) => ({ sha, ...SKIP, t: "2026-11-14T00:00:00Z" });
const SKIP_NOTE = "入口检查按 某会话 的放行跳过：误报：起它的任务已经停了";
const TARGET_SCRIPT = "# 要部署的这个提交里的入口检查\nexit 0\n";

function emptyGuard(): string {
  const g = tmpDir("hh-guard-");
  chmodSync(g, 0o755);
  return g;
}

type EntryOpts = { gitDir: string; guardDir: string; selfUid: number; target: string };
/** 共享仓库里的一个提交（target），带着给的入口检查脚本（null = 这个提交里没有；内容不要紧，/bin/bash 由假的 Runner 答），和一个空的守门目录 */
function entryWorld(script: string | null = TARGET_SCRIPT): { r: ReturnType<typeof tempRepo>; target: string; guard: string; o: (extra?: Partial<EntryOpts>) => EntryOpts } {
  const r = tempRepo();
  r.put("src/a.ts", "a");
  if (script !== null) r.put(SCRIPT, script);
  const target = r.save("A");
  const guard = emptyGuard();
  return { r, target, guard, o: (extra = {}) => ({ gitDir: r.dir, guardDir: guard, selfUid: UID + 1, target, ...extra }) };
}

/** 假的 Runner：/bin/bash 照 plan 一次答一个（多叫一次就算错），别的命令都说 ok；calls 记每一条命令，bash 记参数和目录 */
function bashPlan(plan: Array<{ code: number; out: string }>): { run: Runner; calls: string[]; bash: Array<{ args: string[]; cwd: string }> } {
  const calls: string[] = [];
  const bash: Array<{ args: string[]; cwd: string }> = [];
  const run: Runner = (cmd, args, cwd) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "/bin/bash") return { code: 0, out: "ok", ms: 10 };
    bash.push({ args, cwd });
    const r = plan.shift();
    assert.ok(r, "入口检查脚本被多叫了一次");
    return { ...r, ms: 5 };
  };
  return { run, calls, bash };
}

/** 守门目录里放一条跳过记录（守门工具在另一个账号下写的）；rec 是字符串就原样写进去（坏的 JSON） */
function putEntrySkip(guard: string, name: string, rec: unknown, fileMode = 0o644, dirMode = 0o755): void {
  const dir = join(guard, "entry-skips");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}.json`);
  writeFileSync(p, typeof rec === "string" ? rec : JSON.stringify(rec));
  chmodSync(p, fileMode);
  chmodSync(dir, dirMode);
}

test("entries: entryRows takes the rows of one mark with the indented lines right under each, nothing else", () => {
  const out = entryOut(GREEN_A, RED_B, LOOK_C, SKIP_D, LOOK_E, RED_F);
  assert.deepEqual(entryRows(out, "红"), [RED_B, RED_F]);
  assert.deepEqual(entryRows(out, "看"), [LOOK_C, LOOK_E]);
  assert.deepEqual(entryRows(out, "绿"), [GREEN_A]);
  assert.deepEqual(entryRows(out, "跳"), [SKIP_D]);
  assert.deepEqual(entryRows("没有红的。\n", "红"), []);
});

test("entries: a commit without the script is let through with a note, and nothing runs", () => {
  const w = entryWorld(null);
  const p = bashPlan([]);
  assert.deepEqual(entryCheck(w.o(), p.run), { ok: true, note: "这个提交里没有入口检查脚本，跳过" });
  assert.deepEqual(p.calls, []);
});

test("entries: exit 0 without a 看 row passes with no note; the script is the target commit's blob, run as bash -c text from /", () => {
  const w = entryWorld();
  // 共享仓库后来又改了脚本：跑的还是要部署的那个提交里的
  w.r.put(SCRIPT, "# 后来的\nexit 1\n"); w.r.save("B");
  const p = bashPlan([{ code: 0, out: entryOut(GREEN_A, SKIP_D) }]);
  assert.deepEqual(entryCheck(w.o(), p.run), { ok: true });
  assert.deepEqual(p.bash, [{ args: ["-p", "-c", asRun(TARGET_SCRIPT), ARGV0], cwd: "/" }]);
});

test("entries: the 看 rows of a passing check come back as a note with their details, at most 30 lines", () => {
  const w = entryWorld();
  const ok = entryCheck(w.o(), bashPlan([{ code: 0, out: entryOut(GREEN_A, LOOK_C, SKIP_D, LOOK_E) }]).run);
  assert.deepEqual(ok, { ok: true, note: `入口检查有 2 处要人看：\n${[...LOOK_C, ...LOOK_E].join("\n")}` });
  const many = Array.from({ length: 20 }, (_, i) => [`看  /w/ws/tools/m${i}.sh：自己没有认得的 HH_CONFIG 写法`, `    ${i}:node /w/hh/src/cli.ts`]);
  const cut = entryCheck(w.o(), bashPlan([{ code: 0, out: entryOut(...many) }]).run);
  assert.ok(cut.ok && cut.note);
  const lines = cut.note.split("\n");
  assert.equal(lines[0], "入口检查有 20 处要人看：");
  assert.deepEqual(lines.slice(1, 31), many.flat().slice(0, 30));
  assert.match(lines[31] ?? "", /还有 10 行/);
  assert.equal(lines.length, 32);
});

test("entries: exit 1 refuses with how many, the 红 rows and their details (at most 20 lines), then the script's own way out; 1 with 红 rows is not run again", () => {
  const w = entryWorld();
  const p = bashPlan([{ code: 1, out: entryOut(GREEN_A, RED_B, LOOK_C, RED_F) }]);
  assert.deepEqual(entryCheck(w.o(), p.run), { ok: false, text: refusedRed([...RED_B, ...RED_F], 2) });
  assert.equal(p.bash.length, 1);
  const many = Array.from({ length: 15 }, (_, i) => [`红  /w/ws/tools/r${i}.py：它和起它的都没有 HH_CONFIG 这几个字`, `    ${i}:node /w/hh/src/hhd.ts`]);
  const r = entryCheck(w.o(), bashPlan([{ code: 1, out: entryOut(...many) }]).run);
  assert.ok(!r.ok);
  const lines = r.text.split("\n");
  assert.equal(lines[0], "有入口没带 HH_CONFIG（15 处），上线后它们会直接退出：");
  assert.deepEqual(lines.slice(1, 21), many.flat().slice(0, 20));
  assert.match(lines[21] ?? "", /还有 10 行/);
  assert.deepEqual(lines.slice(22), ADVICE, "她自己过不了红：出路（只是提到路径的文件写一行注释）要跟着到她面前");
  // 结论里没有那几行（老的脚本）：退回到一句话
  const bare = entryCheck(w.o(), bashPlan([{ code: 1, out: entryOut(RED_B).replace(ADVICE.join("\n") + "\n", "") }]).run);
  assert.deepEqual(bare, { ok: false, text: refusedRed(RED_B, 1, ["修好这些脚本（或起它们的定时任务）再部署。"]) });
});

test("entries: exit 2 or 3, or 1 without a 红 row, is run once more and the second run decides", () => {
  const w = entryWorld();
  const twice = (plan: Array<{ code: number; out: string }>) => { const p = bashPlan(plan); return { r: entryCheck(w.o(), p.run), n: p.bash.length }; };
  assert.deepEqual(twice([{ code: 2, out: "找不到工作区" }, { code: 0, out: CALM }]), { r: { ok: true }, n: 2 });
  const tail = Array.from({ length: 12 }, (_, i) => `第二次 ${i}`);
  assert.deepEqual(twice([{ code: 3, out: "第一次" }, { code: 3, out: tail.join("\n") + "\n" }]), { r: { ok: false, text: notRun(3, tail.slice(-10).join("\n")) }, n: 2 });
  const two = twice([{ code: 2, out: "x" }, { code: 2, out: "找不到工作区" }]);
  assert.equal(two.n, 2);
  assert.ok(!two.r.ok && two.r.text.startsWith("入口检查自己没跑成（退出码 2）"), JSON.stringify(two.r));
  const red = twice([{ code: 3, out: "x" }, { code: 1, out: entryOut(RED_B) }]);
  assert.ok(!red.r.ok && red.r.text.startsWith("有入口没带 HH_CONFIG"), JSON.stringify(red.r));
  // 1 却一行红的都没列（被杀、超时、bash 自己死了，execRunner 都给 1）：不是判出来的红
  assert.deepEqual(twice([{ code: 1, out: "Killed" }, { code: 0, out: CALM }]), { r: { ok: true }, n: 2 });
  const died = entryOut(LOOK_E) + "bash: 中途死了\n";
  assert.deepEqual(twice([{ code: 1, out: "第一次" }, { code: 1, out: died }]), { r: { ok: false, text: notRun(1, last10(died)) }, n: 2 });
  // 没判成时给她看的是输出的最后十行，原样（脚本只往一个流里写；看起来重复的两段也照样给）
  const said = "前面的输出\n搜索没跑全：\nfind: /w/x: Permission denied\n搜索没跑全：\nfind: /w/x: Permission denied\n";
  assert.deepEqual(twice([{ code: 3, out: said }, { code: 3, out: said }]), { r: { ok: false, text: notRun(3, last10(said)) }, n: 2 });
});

test("entries: only a run that reached its end counts — the last non-empty line must be the completion line (red=0 for 0, red ≥ 1 with 红 rows for 1)", () => {
  const w = entryWorld();
  const twice = (out: string, code: number) => { const p = bashPlan([{ code, out }, { code, out }]); return { r: entryCheck(w.o(), p.run), n: p.bash.length }; };
  const no = (out: string, code: number, why: string) => assert.deepEqual(twice(out, code), { r: { ok: false, text: notRun(code, last10(out)) }, n: 2 }, why);
  no(CALM.replace(DONE_AT_END, ""), 0, "0 却没有跑完的标记（空的脚本、什么都没执行的 shell、跑到一半）");
  no("", 0, "0、什么都没印");
  no(entryOut(GREEN_A).replace("red=0", "red=1"), 0, "0 却说有红的");
  no(["", ...RED_B, done(0, 0)].join("\n") + "\n", 0, "0、标记说没有红的，输出里却有红的行");
  no(`${CALM}后面还有一行\n`, 0, "标记在中间、后面还有别的：不算跑完（路径或凭据里碰巧有这句也不算）");
  no(entryOut(RED_B).replace(DONE_AT_END, ""), 1, "1、红的行都在，但没有跑完的标记");
  no(entryOut(RED_B).replace("red=1", "red=0"), 1, "1、标记说没有红的");
  assert.deepEqual(twice(`${CALM}`, 0), { r: { ok: true }, n: 1 }, "对照：真跑完的 0 一次就过");
});

test("entries: the shared repository cannot be read → a refusal (logged like the others), not a throw", () => {
  const w = entryWorld();
  const p = bashPlan([]);
  const r = entryCheck(w.o({ gitDir: join(tmpDir("hh-norepo-"), "nope") }), p.run);
  assert.ok(!r.ok && r.text.startsWith("入口检查没跑成（从共享仓库里读不出脚本），先不部署："), JSON.stringify(r));
  assert.deepEqual(p.calls, []);
});

test("entries: a trusted skip record for the target lets it through without running the script, naming who and why", () => {
  const w = entryWorld();
  putEntrySkip(w.guard, w.target, skipRec(w.target));
  const p = bashPlan([]);
  assert.deepEqual(entryCheck(w.o(), p.run), { ok: true, note: SKIP_NOTE, skip: SKIP });
  assert.deepEqual(p.calls, []);
});

test("entries: a skip record she could have written, for another commit, without a why or broken is no record — the script runs", () => {
  const w = entryWorld();
  const T = w.target;
  const other = "b2".repeat(20);
  const { by: _by, ...noBy } = skipRec(T);
  const cases: Array<[string, (g: string) => Partial<EntryOpts>]> = [
    ["文件归她（selfUid）", (g) => { putEntrySkip(g, T, skipRec(T)); return { selfUid: UID }; }],
    ["文件组可写", (g) => { putEntrySkip(g, T, skipRec(T), 0o664); return {}; }],
    ["entry-skips 组可写", (g) => { putEntrySkip(g, T, skipRec(T), 0o644, 0o775); return {}; }],
    ["守门目录组可写", (g) => { putEntrySkip(g, T, skipRec(T)); chmodSync(g, 0o775); return {}; }],
    ["里面写的是别的提交", (g) => { putEntrySkip(g, T, skipRec(other)); return {}; }],
    ["只有别的提交的记录", (g) => { putEntrySkip(g, other, skipRec(other)); return {}; }],
    ["只写了前缀", (g) => { putEntrySkip(g, T, skipRec(T.slice(0, 12))); return {}; }],
    ["why 是空的", (g) => { putEntrySkip(g, T, { ...skipRec(T), why: "" }); return {}; }],
    ["why 只有空白", (g) => { putEntrySkip(g, T, { ...skipRec(T), why: "  " }); return {}; }],
    ["没写是谁", (g) => { putEntrySkip(g, T, noBy); return {}; }],
    ["坏的 JSON", (g) => { putEntrySkip(g, T, "{\"sha\": "); return {}; }],
    ["JSON 是 null", (g) => { putEntrySkip(g, T, "null"); return {}; }],
  ];
  for (const [name, setup] of cases) {
    const g = emptyGuard();
    const extra = setup(g);
    const p = bashPlan([{ code: 0, out: CALM }]);
    assert.deepEqual(entryCheck(w.o({ guardDir: g, ...extra }), p.run), { ok: true }, name);
    assert.equal(p.bash.length, 1, name);
  }
});

test("entries: through the real runner, bash runs the commit's script text from / with its $0 named, and its rows come back", () => {
  const where = `[ "$(pwd)" = / ] && [ "$0" = ${ARGV0} ] || { echo "不在 / 下跑，或者名字不对"; exit 3; }\n`;
  const w = entryWorld(`${where}printf '%s\\n' '${LOOK_E[0]}' '没有红的。' '${done(0, 1)}'\nexit 0\n`);
  assert.deepEqual(entryCheck(w.o(), execRunner), { ok: true, note: `入口检查有 1 处要人看：\n${LOOK_E[0]}` });
  w.r.put(SCRIPT, `${where}printf '%s\\n' '${RED_F[0]}' '${RED_F[1]}' '${ADVICE[0]}' '${ADVICE[1]}' '${ADVICE[2]}' '${done(1, 0)}'\nexit 1\n`);
  const red = w.r.save("红");
  assert.deepEqual(entryCheck(w.o({ target: red }), execRunner), { ok: false, text: refusedRed(RED_F, 1) });
  // 跑完的标记印在中间、后面又印了东西、退出码 0：不算跑完
  w.r.put(SCRIPT, `printf '%s\\n' '${done(0, 0)}' '后面还有一行'\nexit 0\n`);
  const middle = w.r.save("中间");
  assert.deepEqual(entryCheck(w.o({ target: middle }), execRunner), { ok: false, text: notRun(0, `${done(0, 0)}\n后面还有一行`) });
});

test("entries: bash is started with -p — a BASH_ENV file in the environment is not read (it could print the completion line and exit before the script runs, or write after it)", () => {
  // 提交里的脚本是红的；环境里的 BASH_ENV 指着一个「印一行跑完的标记就退出 0」的文件。不带 -p，bash 先执行那个文件，部署就没判就放行了
  const w = entryWorld(`printf '%s\\n' '${RED_F[0]}' '${RED_F[1]}' '${ADVICE[0]}' '${ADVICE[1]}' '${ADVICE[2]}' '${done(1, 0)}'\nexit 1\n`);
  const env = join(tmpDir("hh-bashenv-"), "env.sh");
  writeFileSync(env, `echo '${done(0, 0)}'\nexit 0\n`);
  const before = process.env.BASH_ENV;
  process.env.BASH_ENV = env;
  try {
    assert.deepEqual(entryCheck(w.o(), execRunner), { ok: false, text: refusedRed(RED_F, 1) });
  } finally {
    if (before === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = before;
  }
});

test("entries: a script that is empty, or a symlink in the commit, runs nothing and exits 0 — not finished, refused", () => {
  const w = entryWorld("");
  const empty = entryCheck(w.o(), execRunner);
  assert.ok(!empty.ok && empty.text.startsWith("入口检查自己没跑成（退出码 0）"), JSON.stringify(empty));
  rmSync(join(w.r.dir, SCRIPT));
  symlinkSync("/usr/bin/true", join(w.r.dir, SCRIPT));
  const link = w.r.save("换成链接");
  const linked = entryCheck(w.o({ target: link }), execRunner);
  assert.ok(!linked.ok && linked.text.startsWith("入口检查自己没跑成（退出码 0）"), JSON.stringify(linked));
});

const LIVE_SCRIPT = "# 线上那份（A，旧提交的）\nexit 1\n";
const CLONE_SCRIPT = "# 检查克隆里的（别的检查可能刚把它切走）\nexit 1\n";

/** 部署的世界：线上（A）有一份旧的入口检查脚本，检查克隆里也放了一份——两份都不能用；要部署的 B 里的那份（script；null = B 把它删了）才算。线上还有看守：被拦下时它不能被拷走 */
function entryDeploy(script: string | null = TARGET_SCRIPT) {
  const s = deploySetup();
  s.r.put(SCRIPT, LIVE_SCRIPT); s.r.put("src/repair/watchdog.ts", "// 旧看守"); s.r.put("src/a.ts", "a"); const A = s.r.save("A");
  s.r.put(SCRIPT, script); s.r.put("src/a.ts", "b"); s.r.put("src/new.ts", "new"); const B = s.r.save("feat: ours");
  s.at(A);
  const check = tmpDir("hh-check-");
  mkdirSync(join(check, "ops")); writeFileSync(join(check, SCRIPT), CLONE_SCRIPT);
  const guard = guardWith({ ...REC, shas: [B.slice(0, 12)] });
  return { s, A, B, check, guard, o: () => s.o(B, { checkDir: check, guardDir: guard }) };
}

/** 被拦下以后：线上代码、部署记录、重启请求、看守都和部署前一样 */
function liveUntouched(e: ReturnType<typeof entryDeploy>): void {
  assert.equal(readDeployed(e.s.st)?.commit, e.A);
  assert.equal(readFileSync(join(e.s.live, "src/a.ts"), "utf8"), "a");
  assert.equal(existsSync(join(e.s.live, "src/new.ts")), false);
  for (const f of ["restart-request.json", "console-restart.json", "watch.json", "watchdog.ts", "bench.json"]) assert.equal(existsSync(join(e.s.st, "repair", f)), false, f);
  assert.deepEqual(e.s.watched, []);
}
const deployEvents = (st: string) => readEvents(st).filter((x) => x.kind === "deploy");

test("deploy: a passing entry check (exit 0, no 看 row) leaves the deploy as it was; it runs after the tests, from the deployed commit's blob, not live or the check clone", () => {
  const e = entryDeploy();
  const p = bashPlan([{ code: 0, out: entryOut(GREEN_A) }]);
  const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.match(res.text, /^部署了 [0-9a-f]{7} → [0-9a-f]{7}（1 个提交：[^\n]*）；等她闲下来自己重启$/, "回复和以前一样，只有一行");
  const ev = deployEvents(e.s.st);
  assert.equal(ev.length, 1);
  assert.equal(ev[0]?.text, res.text);
  assert.equal(ev[0]?.items?.length, 1, "items 只有每个提交的那一条");
  assert.equal(ev[0]?.entrySkip, undefined);
  assert.equal(readDeployed(e.s.st)?.commit, e.B);
  assert.deepEqual(p.bash, [{ args: ["-p", "-c", asRun(TARGET_SCRIPT), ARGV0], cwd: "/" }], "跑的是要部署的提交（B）里的那份：不是线上的（A），也不是检查克隆里的");
  const bashAt = p.calls.findIndex((c) => c.startsWith("/bin/bash"));
  const tscAt = p.calls.indexOf("npx tsc --noEmit");
  const testsAt = p.calls.indexOf("npm test");
  assert.ok(tscAt >= 0 && testsAt >= 0 && tscAt < bashAt && testsAt < bashAt, p.calls.join(" | "));
});

test("deploy: the entry check comes after the tests — failing tests refuse before the script runs", () => {
  const e = entryDeploy();
  const calls: string[] = [];
  const failTests: Runner = (cmd, args) => { calls.push(cmd); return cmd === "npm" && args[0] === "test" ? { code: 1, out: "not ok 1", ms: 1 } : { code: 0, out: "ok", ms: 1 }; };
  const res = deploy(e.o(), { run: failTests, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /测试没过/);
  assert.ok(!calls.includes("/bin/bash"), calls.join(" | "));
});

test("deploy: an entry check with 红 rows (exit 1) refuses and names them with their details and the way out; nothing live is touched; the refusal is logged", () => {
  const e = entryDeploy();
  const res = deploy(e.o(), { run: bashPlan([{ code: 1, out: entryOut(GREEN_A, RED_B, LOOK_C, RED_F) }]).run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /^有入口没带 HH_CONFIG（2 处），上线后它们会直接退出：\n/);
  for (const l of [...RED_B, ...RED_F, ...ADVICE]) assert.ok(res.text.includes(l), l);
  assert.ok(!res.text.includes(LOOK_C[0]!) && !res.text.includes(GREEN_A[0]!));
  liveUntouched(e);
  const refused = readEvents(e.s.st).filter((x) => x.kind === "refused");
  assert.equal(refused.length, 1);
  assert.equal(refused[0]?.text, res.text);
  assert.equal(refused[0]?.to, e.B);
  assert.deepEqual(deployEvents(e.s.st), []);
});

test("deploy: an entry check that cannot judge (exit 2 or 3, or 1 without a 红 row) twice refuses with its code; nothing live is touched", () => {
  for (const code of [2, 3, 1]) {
    const e = entryDeploy();
    const p = bashPlan([{ code, out: "第一次" }, { code, out: "检查自己没跑成：搜索没跑完\n" }]);
    const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
    assert.equal(res.ok, false, String(code));
    assert.equal(res.text, notRun(code, "检查自己没跑成：搜索没跑完"));
    assert.equal(p.bash.length, 2, "再跑了一次");
    liveUntouched(e);
    assert.ok(readEvents(e.s.st).some((x) => x.kind === "refused" && x.text === res.text));
  }
});

test("deploy: exit 0 without the completion line twice refuses as not finished; nothing live is touched", () => {
  const e = entryDeploy();
  const p = bashPlan([{ code: 0, out: "" }, { code: 0, out: "" }]);
  const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, false);
  assert.match(res.text, /^入口检查自己没跑成（退出码 0）/);
  liveUntouched(e);
});

test("deploy: exit 2 (or 1 without a 红 row) and then 0 on the second run deploys", () => {
  for (const first of [2, 1]) {
    const e = entryDeploy();
    const p = bashPlan([{ code: first, out: "找不到工作区" }, { code: 0, out: entryOut(GREEN_A) }]);
    const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
    assert.equal(res.ok, true, res.text);
    assert.equal(p.bash.length, 2);
    assert.equal(readDeployed(e.s.st)?.commit, e.B);
  }
});

test("deploy: a commit without the script (B deletes it; live still has the old one) deploys, and says so in the reply and in the deploy event's items", () => {
  const e = entryDeploy(null);
  const p = bashPlan([]);
  const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(p.bash, []);
  const [head, note, ...rest] = res.text.split("\n");
  assert.equal(note, "这个提交里没有入口检查脚本，跳过");
  assert.deepEqual(rest, []);
  const ev = deployEvents(e.s.st)[0];
  assert.equal(ev?.text, head, "事件的 text 照旧，这句进 items");
  assert.equal(ev?.items?.length, 2);
  assert.equal(ev?.items?.at(-1), "这个提交里没有入口检查脚本，跳过");
});

test("deploy: the 看 rows of a passing check go into the deploy reply and the event, not only the log", () => {
  const e = entryDeploy();
  const res = deploy(e.o(), { run: bashPlan([{ code: 0, out: entryOut(GREEN_A, LOOK_C, LOOK_E) }]).run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  const note = `入口检查有 2 处要人看：\n${[...LOOK_C, ...LOOK_E].join("\n")}`;
  assert.ok(res.text.endsWith(`；等她闲下来自己重启\n${note}`), res.text);
  assert.equal(deployEvents(e.s.st)[0]?.items?.at(-1), note);
});

test("deploy: a trusted skip record skips the check; who and why are in the deploy event of the repair log", () => {
  const e = entryDeploy();
  putEntrySkip(e.guard, e.B, skipRec(e.B));
  const p = bashPlan([]);
  const res = deploy(e.o(), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(p.bash, [], "有跳过记录：脚本不跑");
  assert.equal(res.text.split("\n").at(-1), SKIP_NOTE);
  const logged = readFileSync(join(e.s.st, "repair", "log.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as { kind: string; items?: string[]; entrySkip?: unknown }).filter((x) => x.kind === "deploy");
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0]?.entrySkip, SKIP);
  assert.equal(logged[0]?.items?.at(-1), SKIP_NOTE);
});

test("deploy: an abbreviated target is resolved first — the skip record is looked up under the full sha", () => {
  const e = entryDeploy();
  putEntrySkip(e.guard, e.B, skipRec(e.B));
  const p = bashPlan([]);
  const res = deploy(e.s.o(e.B.slice(0, 10), { checkDir: e.check, guardDir: e.guard }), { run: p.run, spawnWatchdog: e.s.spawn, now: () => 0 });
  assert.equal(res.ok, true, res.text);
  assert.deepEqual(p.bash, []);
  assert.deepEqual(deployEvents(e.s.st)[0]?.entrySkip, SKIP);
});

test("summary: only per-commit items count as Ada's approvals — the entry-check note, or a why that happens to contain \" ada：\", does not; his words come back whole", () => {
  const ev = { t: "2026-11-01T01:00:00.000Z", kind: "deploy" as const, text: "部署了", items: [
    "abc1234 ada：ada #12「可以」批了 #10 问的 #0001",
    "def5678 session：某会话：照 ada：说的改了",
    "9abcdef ada：ada #14「好，原话里有 ada：两个字」批了 #13 问的 #0002",
    "入口检查按 某会话 的放行跳过：问过 ada：可以",
    "入口检查有 1 处要人看：\n看  /w/x.sh：提到了 ada：…",
  ] };
  assert.equal(summarize([ev], []), "昨天的修理：上线了 ada 批过的：ada #12「可以」批了 #10 问的 #0001；ada #14「好，原话里有 ada：两个字」批了 #13 问的 #0002。");
});

test("the watchdog runs from a copy on its own: copied into an empty directory it loads, and the deploy hands it every sentence it says", async () => {
  const dir = tmpDir("hh-watchdog-copy-");
  copyFileSync(join(ROOT, "src", "repair", "watchdog.ts"), join(dir, "watchdog.ts"));
  const mod = await import(pathToFileURL(join(dir, "watchdog.ts")).href) as { watch?: unknown };
  assert.equal(typeof mod.watch, "function");
  const used = [...readFileSync(join(ROOT, "src", "repair", "watchdog.ts"), "utf8").matchAll(/say\(a, "([A-Za-z0-9]+)"/g)].map((m) => m[1]!);
  const text = watchdogText();
  assert.deepEqual(used.filter((k) => !(k in text)), [], "every sentence it says is in what the deploy renders");
  assert.deepEqual(Object.entries(text).filter(([, v]) => v.includes("undefined")).map(([k]) => k), [], "the holes are rendered as holes, not as undefined");
  // a lazy import("../x.ts") inside a rollback step would load fine here and fail only at the moment of rolling back
  const src = readFileSync(join(ROOT, "src", "repair", "watchdog.ts"), "utf8");
  assert.deepEqual(src.match(/from ["']\.\.?\/|import\(\s*["']\.\.?\/|require\(/g) ?? [], [], "the watchdog refers to no local file anywhere, not even lazily");
});

test("the watchdog signs a revert with the role's own name, bound when the deploy renders its text", () => {
  try {
    setLang("zh", { me: "衡", owner: "老林", ta: "他", place: "", id: "heng" });
    assert.equal(watchdogText().revertGitName, "user.name=衡的看守");
  } finally { setLang(TEST_LANG, TEST_NAMES); }
});

test("the watchdog started from a state dir that is reached through a symlink still watches (it used to exit at once, taking itself for an import)", () => {
  const real = tmpDir("hh-watchdog-real-");
  mkdirSync(join(real, "repair"));
  copyFileSync(join(ROOT, "src", "repair", "watchdog.ts"), join(real, "repair", "watchdog.ts"));
  writeFileSync(join(real, "repair", "deployed.json"), JSON.stringify({ commit: "a later deploy" }));   // so the watch ends at its first look
  const link = join(tmpDir("hh-watchdog-link-"), "state");
  symlinkSync(real, link);
  const args = { live: "/nowhere", stateDir: link, gitDir: "/nowhere", prev: "P", target: "T", deployedAt: Date.now(), rules: RULES.watch, text: watchdogText(), authorEmail: "x@local", notify: "" };
  const r = childProcess.spawnSync(process.execPath, [join(link, "repair", "watchdog.ts"), JSON.stringify(args)], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 0, r.stderr.slice(-400));
  const log = existsSync(join(real, "repair", "log.jsonl")) ? readFileSync(join(real, "repair", "log.jsonl"), "utf8") : "";
  assert.match(log, /"kind":"watch","to":"T","by":"watchdog"/, "it ran its watch and recorded that it gave up");
  assert.equal(existsSync(join(real, "repair", "watchdog.pid")), false, "and cleared its pid record");
});

test("the role table: an entry per stateDir, held by another account, for the account running the command", () => {
  const g = tmpDir("hh-guard-");
  const me = userInfo().username;
  writeFileSync(join(g, "instances.json"), JSON.stringify({ "/st/a": { ...ROLE, user: me }, "/st/b": { ...ROLE, user: "someone-else" } }));
  chmodSync(join(g, "instances.json"), 0o644);
  assert.deepEqual(roleEntry(g, "/st/a", UID + 1).owner, OWNER);
  assert.throws(() => roleEntry(g, "/st/b", UID + 1), /runs as someone-else/);
  assert.throws(() => roleEntry(g, "/st/c", UID + 1), /no entry/);
  assert.throws(() => roleEntry(g, "/st/a", UID), /held by the machine/, "a table the role owns does not count");
});

test("the watchdog stops only its own role's process: by the pid in that role's state directory, if it started before the record", async () => {
  const { stopByRecord } = await import("../src/repair/watchdog.ts");
  const { spawn } = await import("node:child_process");
  const a = spawn("sleep", ["30"]), b = spawn("sleep", ["30"]);
  await new Promise((r) => setTimeout(r, 1100));
  const now = new Date().toISOString();
  const role = (pid: number | undefined, t: string) => { const st = tmpDir("hh-state-"); mkdirSync(join(st, "repair"), { recursive: true }); writeFileSync(join(st, "repair", "boot.json"), JSON.stringify({ pid, t })); return st; };
  const alive = (pid: number | undefined) => { try { process.kill(pid!, 0); return true; } catch { return false; } };
  stopByRecord(role(b.pid, "2000-01-01T00:00:00.000Z"), "hhd");   // a record older than the process: the pid was reused, leave it
  assert.equal(alive(b.pid), true);
  stopByRecord(role(a.pid, now), "hhd");
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual([alive(a.pid), alive(b.pid)], [false, true], "one role's rollback leaves the other role's process alone");
  stopByRecord(tmpDir("hh-state-"), "console");   // no record: nothing to stop
  b.kill();
});

// ---- hh fix check / merge in the background (#0091): the keeper ----
const gone = async (pid: number): Promise<boolean> => {
  for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch { return true; } await new Promise((r) => setTimeout(r, 50)); }
  return false;
};
const keepIn = (d: string, cmd: string, script: string, said: string[], heavy = join(d, "heavy")) =>
  keepFix({ cmd, branch: "fix/x", worker: [process.execPath, ["-e", script]], env: process.env, stateDir: d, locks: { heavy, file: join(d, ".check.lock") }, remind: async (t) => { said.push(t); } });

test("hh fix in the background: the keeper hands the worker's result back as her reminder, and logs nothing of its own", async () => {
  const d = tmpDir("hh-keep-"), said: string[] = [];
  await keepIn(d, "check", "console.log('squashed abc1234; can merge')", said).done;
  assert.deepEqual(said, [R.cli.fixFinished("check", "fix/x", "squashed abc1234; can merge")]);
  assert.deepEqual(readEvents(d), []);
});

test("hh fix in the background: TERM to the keeper kills the worker's whole group at once; nothing after it runs, both locks go, the log and her reminder say it stopped", async () => {
  const d = tmpDir("hh-keep-"), said: string[] = [];
  const heavy = join(d, "heavy"), file = join(d, ".check.lock"), suitePid = join(d, "suite.pid");
  const script = `const fs = require("node:fs"), cp = require("node:child_process");
fs.mkdirSync(${JSON.stringify(heavy)}); fs.writeFileSync(${JSON.stringify(join(heavy, "pid"))}, process.pid + "\\n");
fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify({ pid: process.pid, t: "" }));
cp.spawnSync("sh", ["-c", "echo $$ > ${suitePid}.new && mv ${suitePid}.new ${suitePid} && exec sleep 30"]);
fs.writeFileSync(${JSON.stringify(join(d, "pushed"))}, "");`;
  const k = keepIn(d, "merge", script, said);
  for (let i = 0; i < 200 && !existsSync(suitePid); i++) await new Promise((r) => setTimeout(r, 50));
  k.stop("SIGTERM");
  await k.done;
  assert.ok(await gone(Number(readFileSync(suitePid, "utf8"))), "the suite went with it");
  assert.deepEqual([existsSync(heavy), existsSync(file), existsSync(join(d, "pushed"))], [false, false, false]);
  assert.deepEqual(readEvents(d).map((e) => [e.kind, e.text]), [["check", R.cli.fixEndedEvent("merge", "fix/x", "SIGTERM")]]);
  assert.deepEqual(said, [R.cli.fixStopped("merge", "fix/x", "SIGTERM")]);
});

test("hh fix in the background: a worker that dies on its own leaves no lock of its own behind; one someone else has taken stays", async () => {
  const d = tmpDir("hh-keep-"), said: string[] = [];
  const heavy = join(d, "heavy");
  mkdirSync(heavy); writeFileSync(join(heavy, "pid"), "1\n");   // someone else's
  await keepIn(d, "check", `require("node:fs").writeFileSync(${JSON.stringify(join(d, ".check.lock"))}, JSON.stringify({ pid: process.pid })); process.kill(process.pid, "SIGKILL");`, said, heavy).done;
  assert.deepEqual([existsSync(join(d, ".check.lock")), existsSync(heavy)], [false, true]);
  assert.deepEqual(readEvents(d).map((e) => e.text), [R.cli.fixEndedEvent("check", "fix/x", "SIGKILL")]);
  assert.deepEqual(said, [R.cli.fixDied("check", "fix/x", "SIGKILL", "")]);
});
