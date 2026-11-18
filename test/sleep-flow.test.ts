// 夜里整理的流程配置：解析、核对、排序、上一份能用的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { FakeDriver } from "../src/kernel/fake.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import type { ToolDef } from "../src/kernel/types.ts";
import { guardFor, openStageSession, type StageSessionOpts } from "../src/sleep/session.ts";
import { parseFlow, conflict, runnable, loadFlow, FlowError, type FlowConfig, type StageSpec } from "../src/sleep/flow.ts";
import { setLang } from "../src/lang/index.ts";

// the night's text here is asserted in Chinese, the pack it was written against
setLang("zh");

const known = { tools: new Set(["mem_write", "note"]), builtins: new Set(["apply"]), memWriters: new Set(["mem_write"]) };
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "agent", skill: `${id}.md`, ...extra });
const mk = (stages: unknown[], extra: Record<string, unknown> = {}) => parseFlow({ stages, ...extra }, known);
const spec = (writes: string[], memWrite = false): StageSpec => mk([agent("x", { writes, memWrite })]).stages[0]!;
const ids = (l: StageSpec[]) => l.map((s) => s.id);

test("parseFlow fills defaults", () => {
  const f = mk([{ id: "a", title: "甲", kind: "agent", skill: "a.md" }]);
  assert.equal(f.engine, "legacy");
  assert.equal(f.maxParallel, 2);
  assert.deepEqual(f.budget, { targetPct: 1, hardPct: 2 });
  assert.equal(f.auditModel, "opus");
  const s = f.stages[0]!;
  assert.deepEqual(s.after, []);
  assert.deepEqual(s.when, ["always"]);
  assert.equal(s.enabled, true);
  assert.equal(s.required, false);
  assert.equal(s.model, "opus");
  assert.equal(s.carry, "redo");
  assert.equal(s.checkpoint, false);
  assert.equal(s.needsDialogue, false);
  assert.deepEqual(s.budget, { minutes: 30, calls: 120 });
});

test("parseFlow rejects: 所有问题一次报出来", () => {
  let err: FlowError | null = null;
  try {
    mk([
      agent("a", { after: ["b"] }),
      agent("b", { after: ["a"] }),
      agent("a"),
      agent("c", { after: ["nope"], tools: ["mystery"] }),
      { id: "d", title: "d", kind: "agent" },
      { id: "e", title: "e", kind: "script" },
      { id: "f", title: "f", kind: "builtin", builtin: "ghost" },
    ]);
  } catch (e) { err = e as FlowError; }
  assert.ok(err instanceof FlowError);
  const p = err.problems;
  for (const k of ["重名", "不存在的段", "环", "不认识的工具", "没写 skill", "没写 command", "不认识"]) {
    assert.ok(p.some((x) => x.includes(k)), `缺少「${k}」：${p.join("|")}`);
  }
});

test("conflict", () => {
  assert.equal(conflict(spec(["memory/midterm/self.md"]), spec(["memory/**"])), true);
  assert.equal(conflict(spec(["soul/**", "!soul/30-喜好.md"]), spec(["soul/30-喜好.md"])), false);
  assert.equal(conflict(spec(["skills/**"]), spec(["soul/**"])), false);
  assert.equal(conflict(spec([], true), spec([], true)), true);
  assert.equal(conflict(spec([], true), spec([], false)), false);
});

test("runnable", () => {
  const f: FlowConfig = mk([
    agent("a", { writes: ["x.md"] }),
    agent("b", { after: ["a"] }),
    agent("c", { writes: ["x.md"] }),
    agent("d"),
  ], { maxParallel: 2 });
  const st = (o: Partial<Record<"done" | "failed" | "running" | "skipped", string[]>>) => ({
    done: new Set(o.done ?? []), failed: new Set(o.failed ?? []), running: new Set(o.running ?? []), skipped: new Set(o.skipped ?? []),
  });
  assert.deepEqual(ids(runnable(f, st({}))), ["a", "d"]);
  assert.deepEqual(ids(runnable(f, st({ running: ["a"] }))), ["d"]);
  assert.deepEqual(ids(runnable(f, st({ done: ["a"] }))), ["b", "c"]);
  assert.deepEqual(ids(runnable(f, st({ done: ["a"], running: ["d"] }))), ["b"]);
  assert.deepEqual(ids(runnable(f, st({ failed: ["a"] }))), ["c", "d"]);
  assert.deepEqual(ids(runnable(f, st({ skipped: ["a"] }))), ["c", "d"]);
});

test("loadFlow falls back to last good", () => {
  const good = JSON.stringify({ stages: [agent("a")] });
  const files = new Map<string, string>();
  const io = { file: "flow.json", lastGood: "last.json", known, read: (p: string) => files.get(p) ?? null, write: (p: string, s: string) => void files.set(p, s) };

  let r = loadFlow(io);
  assert.equal(r.flow, null);
  assert.equal(r.source, "none");

  files.set("flow.json", good);
  r = loadFlow(io);
  assert.equal(r.source, "file");
  assert.equal(files.get("last.json"), good);

  files.set("flow.json", "{ 坏了");
  r = loadFlow(io);
  assert.equal(r.source, "last-good");
  assert.ok(r.flow);
  assert.ok(r.problems.length > 0);

  files.set("flow.json", JSON.stringify({ stages: [agent("a", { after: ["zz"] })] }));
  r = loadFlow(io);
  assert.equal(r.source, "last-good");
  assert.equal(files.get("last.json"), good);
});

test("loadFlow keeps a valid file when saving last good fails", () => {
  const good = JSON.stringify({ stages: [agent("a")] });
  const r = loadFlow({ file: "f", lastGood: "l", known, read: (p) => (p === "f" ? good : "{}"), write: () => { throw new Error("磁盘满"); } });
  assert.equal(r.source, "file");
  assert.ok(r.flow);
  assert.equal(r.problems.length, 1);
});

test("loadFlow treats a throwing read as unreadable", () => {
  const good = JSON.stringify({ stages: [agent("a")] });
  const boom = () => { throw new Error("EACCES"); };
  let r = loadFlow({ file: "f", lastGood: "l", known, read: (p) => (p === "f" ? boom() : good), write: () => {} });
  assert.equal(r.source, "last-good");
  assert.ok(r.problems.length > 0);
  r = loadFlow({ file: "f", lastGood: "l", known, read: boom, write: () => {} });
  assert.equal(r.flow, null);
  assert.equal(r.source, "none");
  r = loadFlow({ file: "f", lastGood: "l", known, read: (p) => (p === "f" ? "{坏" : boom()), write: () => {} });
  assert.equal(r.source, "none");
});

test("loadFlow: a missing file means legacy even with a last good", () => {
  const good = JSON.stringify({ stages: [agent("a")] });
  const r = loadFlow({ file: "f", lastGood: "l", known, read: (p) => (p === "l" ? good : null), write: () => {} });
  assert.deepEqual(r, { flow: null, source: "none", problems: [] });
});

test("ledger: a run, two attempts of a stage, and the owed list", async () => {
  const { openDb, all, one } = await import("../src/store/db.ts");
  const L = await import("../src/sleep/ledger.ts");
  const db = openDb(":memory:");
  const names = all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  for (const t of ["sleep_run", "sleep_stage", "sleep_owed"]) assert.ok(names.includes(t), t);

  const run = L.startRun(db, "2026-11-05", "abc123", 1000);
  const s1 = L.startStage(db, { runId: run, day: "2026-11-04", stage: "digest", attempt: 1, model: "opus" }, 1100);
  L.endStage(db, s1, { status: "redo", calls: 3, units: 1.5, verdict: "thin" }, 1200);
  const s2 = L.startStage(db, { runId: run, day: "2026-11-04", stage: "digest", attempt: 2, model: "opus" }, 1300);
  L.endStage(db, s2, { status: "passed", calls: 4, changes: 7, input: 10, output: 20 }, 1400);
  L.endRun(db, run, { status: "done", days: ["2026-11-04"], spentUnits: 2.5, notes: "ok" }, 2000);

  const r = one<any>(db, "SELECT * FROM sleep_run WHERE id = ?", run)!;
  assert.equal(r.night, "2026-11-05");
  assert.equal(r.flow_hash, "abc123");
  assert.equal(r.started, 1000);
  assert.equal(r.ended, 2000);
  assert.equal(r.status, "done");
  assert.deepEqual(JSON.parse(r.days), ["2026-11-04"]);
  assert.equal(r.spent_units, 2.5);
  assert.equal(r.notes, "ok");
  const st = all<any>(db, "SELECT * FROM sleep_stage WHERE run_id = ? ORDER BY attempt", run);
  assert.equal(st.length, 2);
  assert.deepEqual(st.map((x) => x.status), ["redo", "passed"]);
  assert.equal(st[0].verdict, "thin");
  assert.equal(st[0].started, 1100);
  assert.equal(st[0].ended, 1200);
  assert.equal(st[1].changes, 7);
  assert.equal(st[1].model, "opus");

  L.owe(db, "2026-11-03", "digest", ["a"], 100);
  L.owe(db, "2026-11-03", "digest", ["b", "c"], 200);
  L.owe(db, "2026-11-02", "people", [], 150);
  let o = L.owed(db);
  assert.deepEqual(o.map((x) => x.day), ["2026-11-02", "2026-11-03"]);
  const d = o[1]!;
  assert.equal(d.nights, 2);
  assert.deepEqual(d.problems, ["b", "c"]);
  assert.equal(d.created, 100);
  assert.equal(d.updated, 200);
  L.settleOwed(db, "2026-11-03", "digest", "done", 300);
  L.settleOwed(db, "2026-11-02", "people", "escalated", 300);
  assert.deepEqual(L.owed(db), []);
});

test("ledger: the week quota read before and after the night goes on the run's row", async () => {
  const { openDb, one } = await import("../src/store/db.ts");
  const L = await import("../src/sleep/ledger.ts");
  const db = openDb(":memory:");
  const run = L.startRun(db, "2026-11-05", "h", 1000);
  L.setRunQuota(db, run, 41, 42.5);
  assert.deepEqual({ ...one<any>(db, "SELECT quota_before, quota_after FROM sleep_run WHERE id = ?", run) }, { quota_before: 41, quota_after: 42.5 });
  L.setRunQuota(db, run, null, null);
  assert.deepEqual({ ...one<any>(db, "SELECT quota_before, quota_after FROM sleep_run WHERE id = ?", run) }, { quota_before: null, quota_after: null }, "读不到就空着");
});

// ---- record.ts: 提案快照 / 实际改动 / 恢复 / 记录文件 ----
import { matchWrites } from "../src/sleep/flow.ts";
import { snapshot, proposedFiles, diff, restore, recordPath, type MiniFs } from "../src/sleep/record.ts";

function memFs(init: Record<string, string> = {}): MiniFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(init));
  return {
    files,
    read: (p) => files.get(p) ?? null,
    write: (p, s) => void files.set(p, s),
    remove: (p) => void files.delete(p),
    isDir: (p) => [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    list: (dir) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]!))],
  };
}

test("snapshot/diff: add, change, remove", () => {
  const R = "/w/sleep/d/proposed";
  const fs = memFs({ [`${R}/a.md`]: "a1", [`${R}/b.md`]: "b1", [`${R}/sub/c.md`]: "c1" });
  assert.deepEqual(proposedFiles(R, fs).sort(), ["a.md", "b.md", "sub/c.md"]);
  const all = () => true;
  const before = snapshot(R, all, fs);
  fs.write(`${R}/a.md`, "a2");
  fs.remove(`${R}/b.md`);
  fs.write(`${R}/new.md`, "n");
  const d = diff(before, snapshot(R, all, fs)).sort((x, y) => x.path.localeCompare(y.path));
  assert.deepEqual(d, [
    { path: "a.md", op: "change" },
    { path: "b.md", op: "remove" },
    { path: "new.md", op: "add" },
  ]);
  assert.deepEqual(diff(before, before), []);
});

test("diff over the union of keys", () => {
  const R = "/w/p";
  const fs = memFs({ [`${R}/memory/x.md`]: "1" });
  const scope = (p: string) => matchWrites(["memory/**"], p);
  const before = snapshot(R, scope, fs);
  fs.write(`${R}/memory/new.md`, "n");
  fs.write(`${R}/skills/o.md`, "o");
  assert.deepEqual(diff(before, snapshot(R, scope, fs)), [{ path: "memory/new.md", op: "add" }]);
});

test("restore keeps the earlier stage's edits", () => {
  const R = "/w/sleep/d/proposed";
  const fs = memFs({ [`${R}/memory/x.md`]: "v1" });
  fs.write(`${R}/memory/x.md`, "v2");
  const scope = (p: string) => matchWrites(["memory/**"], p);
  const S = snapshot(R, scope, fs);
  fs.write(`${R}/memory/x.md`, "v3");
  fs.write(`${R}/memory/y.md`, "new");
  restore(R, S, scope, fs);
  assert.equal(fs.read(`${R}/memory/x.md`), "v2");
  assert.equal(fs.read(`${R}/memory/y.md`), null);
});

test("restore never touches files outside the scope", () => {
  const R = "/w/p";
  const fs = memFs({ [`${R}/memory/x.md`]: "v1", [`${R}/skills/old.md`]: "s" });
  const scope = (p: string) => matchWrites(["memory/**"], p);
  const S = snapshot(R, scope, fs);
  S.set("memory/gone.md", null);
  fs.write(`${R}/skills/a.md`, "parallel");
  fs.write(`${R}/skills/old.md`, "s2");
  fs.write(`${R}/memory/x.md`, "v2");
  fs.write(`${R}/memory/gone.md`, "z");
  restore(R, S, scope, fs);
  assert.equal(fs.read(`${R}/skills/a.md`), "parallel");
  assert.equal(fs.read(`${R}/skills/old.md`), "s2");
  assert.equal(fs.read(`${R}/memory/x.md`), "v1");
  assert.equal(fs.read(`${R}/memory/gone.md`), null);
});

test("matchWrites: concrete, **, exclusion", () => {
  assert.equal(matchWrites(["notes/a.md"], "notes/a.md"), true);
  assert.equal(matchWrites(["notes/a.md"], "notes/b.md"), false);
  assert.equal(matchWrites(["memory/**"], "memory/deep/x.md"), true);
  assert.equal(matchWrites(["memory/*"], "memory/deep/x.md"), false);
  assert.equal(matchWrites(["memory/**", "!memory/keep.md"], "memory/keep.md"), false);
  assert.equal(matchWrites(["memory/**", "!memory/keep.md"], "memory/o.md"), true);
});

test("recordPath", () => {
  assert.equal(recordPath("2026-11-04", "people", 1), "sleep/2026-11-04/flow/people.json");
  assert.equal(recordPath("2026-11-04", "people", 2), "sleep/2026-11-04/flow/people.2.json");
});

// ---- 一段的会话 ----
const W = "/ws";
const R = "/ws/sleep/2026-11-04/proposed";
const g = (extra: Record<string, unknown> = {}) => guardFor({ allowed: new Set(["recall", "stage_done"]), proposedRoot: R, writes: ["memory/midterm/self.md", "memory/story/**"], bash: ["sleep_apply.py"], workspace: W, ...extra } as never);

test("guard: writes outside proposed/<writes> and unlisted Bash are refused", () => {
  const guard = g();
  assert.equal(guard("Write", { file_path: `${R}/memory/story/2026-11.md` }), undefined);
  const orig = guard("Write", { file_path: `${W}/memory/story/2026-11.md` });
  assert.match(orig!, /proposed/);
  assert.ok(orig!.includes(`${R}/memory/story/2026-11.md`));
  const out = guard("Write", { file_path: `${R}/soul/20-性格.md` });
  assert.ok(out!.includes("memory/story/**") && out!.includes("memory/midterm/self.md"));
  assert.match(guard("Edit", { file_path: `${W}/memory/story/a.md` })!, /proposed/);
  assert.ok(guard("Edit", { file_path: `${R}/soul/x.md` }));
  assert.equal(guard("MultiEdit", { file_path: `${R}/memory/midterm/self.md` }), undefined);
  assert.equal(guard("Write", { file_path: "memory/story/a.md" })!.includes(`${R}/memory/story/a.md`), true);
  assert.ok(guard("Write", { file_path: `${R}/memory/story/../../../x.md` }));
  assert.ok(guard("Write", { file_path: `${R}/../../../etc/x` }));
  assert.equal(guard("Bash", { command: "python3 scripts/sleep_apply.py step 2026-11-04 2" }), undefined);
  for (const c of ["echo x > memory/a.md", "python3 scripts/other.py", "python3 scripts/sleep_apply.py a; rm -rf x", "python3 scripts/sleep_apply.py a && ls", "python3 scripts/sleep_apply.py $(id)", "python3 scripts/sleep_apply.py a\nls", "python3 scripts/sleep_apply.py `id`", "python3 scripts/sleep_apply.py a | cat"]) {
    assert.ok(guard("Bash", { command: c.replace("\\n", "\n") }), c);
  }
  assert.ok(guard("mem_event_create", {}));
  assert.equal(guard("recall", {}), undefined);
  assert.equal(guard("Read", { file_path: "/anything" }), undefined);
  assert.equal(guard("Grep", {}), undefined);
});

const tool = (name: string): ToolDef => ({ name, description: name, shape: {}, handler: async () => "ok" });
const stageDeps = (driver: FakeDriver, later: (fn: () => void, ms: number) => void = () => {}) => ({
  driver, cwd: W, permissionMode: "default", env: {}, claudeExecutable: null,
  render: { maxItemChars: 1000, timezone: "UTC" }, now: () => 0, later, log: new Logger("t", () => {}),
});
const stageOpts = (id: string, allowed: string[], extra: Partial<StageSessionOpts> = {}): StageSessionOpts => ({
  id, model: "m", prefix: "PREFIX", tools: [tool("recall"), tool("mem_event_create"), tool("stage_done")], allowed: new Set(allowed),
  proposedRoot: R, writes: ["memory/**"], bash: [], workspace: W, timeoutMs: 1000, ...extra,
});

test("stage session: same tools and prefix for every stage", async () => {
  const driver = new FakeDriver();
  const a = openStageSession(stageDeps(driver), stageOpts("st-a", ["recall"]));
  const b = openStageSession(stageDeps(driver), stageOpts("st-b", ["mem_event_create", "stage_done"]));
  a.wake("甲段"); b.wake("乙段");
  const sa = driver.latest("st-a"), sb = driver.latest("st-b");
  assert.deepEqual(sa.spec.tools.map((t) => t.name), sb.spec.tools.map((t) => t.name));
  assert.equal(sa.spec.systemAppend, sb.spec.systemAppend);
  assert.deepEqual(sa.spec.builtinTools, sb.spec.builtinTools);
  assert.ok(sa.spec.hooks.beforeTool("mem_event_create", {}));
  assert.equal(sb.spec.hooks.beforeTool("mem_event_create", {}), undefined);
  assert.equal(sa.sent[0]!.text.endsWith("甲段"), true);
  await a.close(); await b.close();
});

test("stage session: usage adds up over turns and timeout settles", async () => {
  const driver = new FakeDriver();
  const s = openStageSession(stageDeps(driver), stageOpts("st-u", ["recall"]));
  const ends: Array<[boolean, string | undefined]> = [];
  s.onTurnEnd((ok, error) => ends.push([ok, error]));
  s.wake("开始");
  const fs = driver.latest("st-u");
  await fs.play({ say: "x", contextTokens: 5000, total: { calls: 2, input: 10, cacheRead: 100, cacheWrite: 20, output: 5 } });
  await fs.play({ say: "y", contextTokens: 3000, total: { calls: 3, input: 1, cacheRead: 200, cacheWrite: 0, output: 7 } });
  await fs.play({ fail: "boom" });
  assert.deepEqual(ends, [[true, undefined], [true, undefined], [false, "boom"]]);
  await s.close();
  assert.equal(fs.closed, true);
  const r = await s.settled;
  assert.equal(r.how, "ok");
  assert.equal(r.turns, 3);
  assert.deepEqual(r.usage, { calls: 5, input: 11, cacheRead: 300, cacheWrite: 20, output: 12, maxCtx: 5000 });

  let fire: (() => void) | null = null;
  const t = openStageSession(stageDeps(driver, (fn) => { fire = fn; }), stageOpts("st-t", ["recall"]));
  t.wake("开始");
  await driver.latest("st-t").play({ say: "x" });
  fire!();
  const r2 = await t.settled;
  assert.equal(r2.how, "timeout");
  assert.equal(r2.turns, 1);
  assert.equal(driver.latest("st-t").closed, true);
});

test("stage session: finishing cancels its own timeout timer when later hands back a cancel", async () => {
  const driver = new FakeDriver();
  let cancelled = 0;
  const later = (_fn: () => void, _ms: number) => () => { cancelled++; };
  const s = openStageSession({ ...stageDeps(driver), later }, stageOpts("st-c", ["recall"]));
  s.wake("开始");
  await s.close();
  assert.equal(cancelled, 1, "关了就取消超时");
  await s.close();
  assert.equal(cancelled, 1, "只取消一次");
  // 超时先到：那个定时器已经跑过了，也只取消一次（取消一个跑过的定时器什么都不做）
  let fire: (() => void) | null = null;
  let c2 = 0;
  const t = openStageSession({ ...stageDeps(driver), later: (fn: () => void) => { fire = fn; return () => { c2++; }; } }, stageOpts("st-c2", ["recall"]));
  t.wake("开始");
  fire!();
  assert.equal((await t.settled).how, "timeout");
  await t.close();
  assert.ok(c2 <= 1);
});

test("guard: Bash must be a bare script call", () => {
  const guard = g({ bash: ["sleep_apply.py", "sleep_digest.py"] });
  for (const c of ["rm -rf memory soul scripts/sleep_apply.py", "cp scripts/sleep_apply.py memory/midterm/self.md", "sed -i '' 's/a/b/' scripts/sleep_apply.py",
    `python3 -c "__import__('os').remove('memory/a.md')" scripts/sleep_apply.py`, "python3 /tmp/evil/scripts/sleep_apply.py", "python3 -m scripts/sleep_apply.py", "python3 -c x scripts/sleep_apply.py", "scripts/sleep_apply.py\r"]) {
    assert.ok(guard("Bash", { command: c }), c);
  }
  assert.ok(guard("Bash", { command: "python3 scripts/sleep_apply.py a\nrm x" }));
  for (const c of ["python3 scripts/sleep_apply.py step 2026-11-04 2", "/usr/bin/python3 scripts/sleep_digest.py pending", "./scripts/sleep_apply.py gate", `python3 ${W}/scripts/sleep_apply.py finish 2026-11-04`, "scripts/sleep_apply.py x"]) {
    assert.equal(guard("Bash", { command: c }), undefined, c);
  }
});

test("stage session: wake after close is a no-op; cwd must equal workspace", async () => {
  const driver = new FakeDriver();
  const s = openStageSession(stageDeps(driver), stageOpts("st-w", ["recall"]));
  s.wake("a");
  await s.close();
  const n = driver.sessions.length;
  s.wake("x");
  assert.equal(driver.sessions.length, n);
  assert.equal(driver.latest("st-w").sent.length, 1);
  assert.throws(() => openStageSession({ ...stageDeps(driver), cwd: "/other" }, stageOpts("st-x", [])), /workspace/);
});

test("guard: Bash args cannot carry shell expansions", () => {
  const guard = g({ bash: ["sleep_apply.py", "sleep_digest.py"] });
  for (const c of ["python3 scripts/sleep_apply.py *(e:'touch PWN':)", "python3 scripts/sleep_apply.py ${x::=$'\\x24\\x28touch PWN\\x29'} ${(e)x}",
    "python3 scripts/sleep_apply.py ${x:=$'a[\\x24\\x28touch PWN\\x29]'} ${y[x]}", "python3 scripts/sleep_apply.py *.md", "python3 scripts/sleep_apply.py a?", "python3 scripts/sleep_apply.py ~/x", "python3 scripts/sleep_apply.py !!", "python3 scripts/sleep_apply.py a\\b", "python3 scripts/sleep_apply.py a #b"]) {
    assert.ok(guard("Bash", { command: c }), c);
  }
  assert.match(guard("Bash", { command: "python3 scripts/sleep_apply.py *.md" })!, /不能出现这些字符/);
  for (const c of ["python3 scripts/sleep_digest.py defer 2026-11-04 '省电模式（只做了 1–4 步）'", "python3 scripts/sleep_apply.py step 2026-11-04 10-report"]) {
    assert.equal(guard("Bash", { command: c }), undefined, c);
  }
});

// ---- Task 6: 交差工具和机械检查 ----
import { mechanical } from "../src/sleep/validate.ts";
import { stageDoneTool, auditDoneTool, ENGINE_TOOLS } from "../src/sleep/tools.ts";
import type { StageRecord, Change } from "../src/sleep/record.ts";

const chg = (target: string): Change => ({ target, op: "change", before: "a", after: "b", evidence: ["e0001「原话」"], why: "因为" });
const rec = (o: Partial<StageRecord> & { files?: string[] }): StageRecord => ({
  day: "2026-11-04", stage: "people", attempt: 1, status: "done", changes: [], report: "", uncertain: [], proposals: [], bugs: [],
  actual: { files: (o.files ?? []).map((path) => ({ path, op: "change" as const })), memOps: 0 }, ...o,
});
const noRun = async () => ({ code: 0, out: "" });
const peopleStage = (extra: Record<string, unknown> = {}) => mk([agent("people", { writes: ["memory/midterm/*.md"], ...extra })]).stages[0]!;

test("mechanical: a changed file outside writes is a problem", async () => {
  const r = rec({ files: ["memory/soul/00.md"], changes: [chg("memory/soul/00.md")] });
  const p = await mechanical({ stage: peopleStage(), record: r, checks: {}, run: noRun, day: "2026-11-04" });
  assert.equal(p.length, 1);
  assert.match(p[0]!, /memory\/soul\/00\.md/);
});

test("mechanical: changed but not declared, declared but unchanged", async () => {
  const r = rec({ files: ["memory/midterm/self.md"], changes: [chg("memory/midterm/other.md「小节」")] });
  const p = await mechanical({ stage: peopleStage(), record: r, checks: {}, run: noRun, day: "d" });
  assert.equal(p.length, 2);
  assert.ok(p.some((x) => x.includes("memory/midterm/self.md")));
  assert.ok(p.some((x) => x.includes("memory/midterm/other.md")));
  const ok = rec({ files: ["memory/midterm/self.md"], changes: [chg("memory/midterm/self.md「某一节」")] });
  assert.deepEqual(await mechanical({ stage: peopleStage(), record: ok, checks: {}, run: noRun, day: "d" }), []);
});

test("mechanical: event store ops and ids must match; blocked counts", async () => {
  const a = rec({ actual: { files: [], memOps: 2 }, changes: [] });
  assert.equal((await mechanical({ stage: peopleStage(), record: a, checks: {}, run: noRun, day: "d" })).length, 1);
  const b = rec({ changes: [chg("e0013")] });
  const pb = await mechanical({ stage: peopleStage(), record: b, checks: {}, run: noRun, day: "d" });
  assert.equal(pb.length, 1); assert.match(pb[0]!, /e0013/);
  const c = rec({ actual: { files: [], memOps: 1 }, changes: [chg("e0013")] });
  assert.deepEqual(await mechanical({ stage: peopleStage(), record: c, checks: {}, run: noRun, day: "d" }), []);
  const d = rec({ status: "blocked", blockedWhy: "材料没了" });
  const pd = await mechanical({ stage: peopleStage(), record: d, checks: {}, run: noRun, day: "d" });
  assert.equal(pd.length, 1); assert.match(pd[0]!, /材料没了/);
});

test("mechanical: a named check that exits non-zero", async () => {
  const seen: string[][] = [];
  const run = async (argv: string[]) => { seen.push(argv); return { code: 1, out: "炸了" }; };
  const st = peopleStage({ validate: ["lint", "ghost"] });
  const p = await mechanical({ stage: st, record: rec({}), checks: { lint: ["echo", "{day}", "{stage}"] }, run, day: "2026-11-04" });
  assert.deepEqual(seen, [["echo", "2026-11-04", "people"]]);
  assert.equal(p.length, 2);
  assert.ok(p.some((x) => x.includes("炸了") && x.includes("lint")));
  assert.ok(p.some((x) => x.includes("没有这个检查") && x.includes("ghost")));
});

test("stage_done tool: the payload reaches onDone and its reply goes back", async () => {
  let got: any;
  const t = stageDoneTool((d) => { got = d; return "收到"; });
  assert.equal(t.name, "stage_done");
  const c = chg("e0001");
  const reply = await t.handler({ status: "done", changes: [c], report: "r" });
  assert.equal(reply, "收到");
  assert.deepEqual(got.changes[0].evidence, c.evidence);
  assert.deepEqual(got.uncertain, []);
  const a = auditDoneTool((x) => `裁:${x.verdict}`);
  assert.equal(await a.handler({ verdict: "redo", problems: [{ what: "x" }] }), "裁:redo");
  assert.deepEqual([...ENGINE_TOOLS], ["stage_done", "audit_done", "exam_questions", "exam_answers", "exam_grades"]);
});

test("mechanical: a check that throws becomes a problem and the others still run", async () => {
  const st = peopleStage({ validate: ["a", "b"] });
  const run = async (argv: string[]) => { if (argv[0] === "boom") throw new Error("spawn ENOENT"); return { code: 1, out: "坏了" }; };
  const p = await mechanical({ stage: st, record: rec({ status: "blocked", blockedWhy: "x" }), checks: { a: ["boom"], b: ["ok"] }, run, day: "d" });
  assert.equal(p.length, 3);
  assert.ok(p.some((x) => x.includes("检查 a 跑不起来：spawn ENOENT")));
  assert.ok(p.some((x) => x.includes("检查 b") && x.includes("坏了")));
});

test("stage_done: an onDone that throws replies 没做成", async () => {
  const t = stageDoneTool(() => { throw new Error("炸"); });
  assert.equal(await t.handler({ status: "nothing", changes: [], report: "" }), "没做成：炸");
  const a = auditDoneTool(() => { throw new Error("崩"); });
  assert.equal(await a.handler({ verdict: "pass", problems: [] }), "没做成：崩");
});

test("mechanical: memory/a.md2 is not covered by a target memory/a.md", async () => {
  const st = peopleStage({ writes: ["memory/*"] });
  const r = rec({ files: ["memory/a.md2"], changes: [chg("memory/a.md")] });
  const p = await mechanical({ stage: st, record: r, checks: {}, run: noRun, day: "d" });
  assert.equal(p.length, 2);
  assert.ok(p.some((x) => x.includes("memory/a.md2")));
  assert.ok(p.some((x) => x.includes("changes 说改了 memory/a.md，")));
  const ok = rec({ files: ["memory/a.md"], changes: [chg("memory/a.md#top")] });
  assert.deepEqual(await mechanical({ stage: st, record: ok, checks: {}, run: noRun, day: "d" }), []);
});

test("mechanical: memory/a.md is not covered by a target memory/a.md2", async () => {
  const st = peopleStage({ writes: ["memory/*"] });
  const r = rec({ files: ["memory/a.md"], changes: [chg("memory/a.md2")] });
  const p = await mechanical({ stage: st, record: r, checks: {}, run: noRun, day: "d" });
  assert.equal(p.length, 2);
});

// ---- Task 7: 核依据会话 ----
import { auditValidator, auditDiff, type AuditHost } from "../src/sleep/validate.ts";
import type { AuditDone } from "../src/sleep/tools.ts";
import * as P from "../src/lang/zh/prompts.ts";

type Script = (s: { wakes: string[]; audit(a: AuditDone): string; turnEnd(ok: boolean, e?: string): void; settle(how: string): void }) => void;
function fakeHost(scripts: Script[], files: Record<string, string> = {}) {
  const opened: Array<{ id: string; model: string; allowed: string[] }> = [];
  const wakesAll: string[][] = [];
  const host: AuditHost = {
    open(o) {
      opened.push(o);
      const script = scripts[opened.length - 1]!;
      const wakes: string[] = []; wakesAll.push(wakes);
      let onAudit: (a: AuditDone) => string = () => ""; let onEnd: (ok: boolean, e?: string) => void = () => {};
      let settle!: (v: any) => void;
      const settled = new Promise<any>((r) => { settle = r; });
      return {
        id: o.id, settled,
        wake(t: string) { wakes.push(t); queueMicrotask(() => script({ wakes, audit: (a) => onAudit(a), turnEnd: (ok, e) => onEnd(ok, e), settle: (how) => settle({ how, turns: 1, usage: {} }) })); },
        onTurnEnd(fn: (ok: boolean, e?: string) => void) { onEnd = fn; }, onAudit(fn: (a: AuditDone) => string) { onAudit = fn; },
        async close() { settle({ how: "ok", turns: 1, usage: {} }); },
      } as any;
    },
    read: (p) => files[p] ?? null,
  };
  return { host, opened, wakesAll };
}
const aStage = () => peopleStage();
const aRec = () => rec({ files: ["memory/midterm/self.md"], changes: [chg("memory/midterm/self.md")] });
const O = { model: "m", timeoutMs: 1000 };

test("audit: pass, redo with problems, and two failures mean not audited", async () => {
  const pass = fakeHost([(s) => { s.audit({ verdict: "pass", problems: [] }); s.turnEnd(true); }]);
  assert.deepEqual(await auditValidator(pass.host, O).validate(aStage(), "2026-11-04", aRec()), { pass: true, problems: [] });
  assert.equal(pass.opened[0]!.id, "audit-2026-11-04-people-1-1", "核依据会话的 id 带上日子（final #11）");
  assert.deepEqual(pass.opened[0]!.allowed, ["recall", "recall_event", "audit_done"]);
  assert.match(pass.wakesAll[0]![0]!, /audit_done/);

  const redo = fakeHost([(s) => { s.audit({ verdict: "redo", problems: [{ what: "说话人错了", change: "c1", evidence: "e0001" }, { what: "没标记" }] }); s.turnEnd(true); }]);
  const r = await auditValidator(redo.host, O).validate(aStage(), "d", aRec());
  assert.equal(r.pass, false); assert.equal(r.problems.length, 2);
  assert.equal(r.problems[0], "说话人错了（c1 / e0001）"); assert.equal(r.problems[1], "没标记");

  const dead = fakeHost([(s) => s.settle("timeout"), (s) => s.settle("timeout")]);
  const d = await auditValidator(dead.host, O).validate(aStage(), "d", aRec());
  assert.deepEqual(d, { pass: true, problems: ["核依据没做完"] });
  assert.deepEqual(dead.opened.map((x) => x.id), ["audit-d-people-1-1", "audit-d-people-1-2"]);
});

test("audit: a turn without audit_done gets one nudge, then the try fails", async () => {
  const h = fakeHost([
    (s) => { s.turnEnd(true); },
    (s) => { s.audit({ verdict: "redo", problems: [] }); s.turnEnd(true); },
  ]);
  // try 1: wake, turn end, nudge wake, turn end -> fail; try 2 redo with no problems
  const r = await auditValidator(h.host, O).validate(aStage(), "d", aRec());
  assert.equal(h.wakesAll[0]!.length, 2);
  assert.equal(h.wakesAll[0]![1], P.SLEEP_AUDIT_NUDGE);
  assert.deepEqual(r, { pass: false, problems: ["核依据打回了，但没写是哪几条"] });
});

test("audit: a failed turn, or open throwing, fails the try at once", async () => {
  const h = fakeHost([(s) => s.turnEnd(false, "boom"), (s) => s.turnEnd(false, "boom")]);
  assert.deepEqual(await auditValidator(h.host, O).validate(aStage(), "d", aRec()), { pass: true, problems: ["核依据没做完"] });
  assert.equal(h.wakesAll[0]!.length, 1);
  const bad: AuditHost = { open() { throw new Error("no"); }, read: () => null };
  assert.deepEqual(await auditValidator(bad, O).validate(aStage(), "d", aRec()), { pass: true, problems: ["核依据没做完"] });
});

test("audit diff: change, add, and the 20k cap", () => {
  const files: Record<string, string> = {
    "a.md": "头\n旧\n尾", "sleep/d/proposed/a.md": "头\n新\n尾",
    "sleep/d/proposed/b.md": "x\ny",
  };
  const host = fakeHost([], files).host;
  const r = rec({ actual: { files: [{ path: "a.md", op: "change" }, { path: "b.md", op: "add" }], memOps: 0 } });
  assert.equal(auditDiff(host, "d", r), "=== a.md（change）===\n- 旧\n+ 新\n=== b.md（add）===\n+ x\n+ y\n");
  assert.equal(auditDiff(host, "d", rec({})), "（这一段没改文件）");
  const big = { "sleep/d/proposed/c.md": Array.from({ length: 5000 }, (_, i) => `行${i}`).join("\n") };
  const t = auditDiff(fakeHost([], big).host, "d", rec({ actual: { files: [{ path: "c.md", op: "add" }], memOps: 0 } }));
  assert.ok(t.endsWith("…（diff 太长，后面截掉了）"));
  assert.ok(t.length <= 20000 + 20);
});

// ---- Task 8: 花费表和一夜怎么跑 ----
import { units, Budget, DEFAULT_WEIGHTS } from "../src/sleep/budget.ts";
import { SleepRunner, type NightResult, type StageHost } from "../src/sleep/runner.ts";
import type { StageDone } from "../src/sleep/tools.ts";
import type { StageValidator } from "../src/sleep/validate.ts";
import { openDb, all, type Db } from "../src/store/db.ts";
import { EventMemory } from "../src/memory/events/memory.ts";

const D = "2026-11-04";
const rootOf = (day: string) => `sleep/${day}/proposed`;
const USAGE = { calls: 1, input: 100, cacheRead: 1000, cacheWrite: 0, output: 10, maxCtx: 5000 }; // opus：100 + 100 + 50 = 250 单位

interface Ctx { id: string; stage: string; day: string; attempt: number; wake: number; text: string; read(p: string): string | null; write(p: string, s: string): void; done(o?: Partial<StageDone>): string; end(ok?: boolean, err?: string, usage?: typeof USAGE): void }
type Act = (c: Ctx) => void | Promise<void>;
/** 写这些提案、交 stage_done（changes 照实列）、这一轮结束 */
const pass = (files: Record<string, string> = {}, extra: Partial<StageDone> = {}): Act => (c) => {
  for (const [p, s] of Object.entries(files)) c.write(p, s);
  c.done({ changes: Object.keys(files).map((p) => chg(p)), ...extra });
  c.end(true);
};
const silent: Act = (c) => c.end(true);
const failV = (p = "没过") => ({ pass: false, problems: [p] });

function fakeMem(log: string[], o: { conflicts?: string[] } = {}) {
  const calls: unknown[][] = [];
  const conflicts = o.conflicts ?? [];
  const note = (...a: unknown[]) => { calls.push(a); log.push(a.map((x) => (Array.isArray(x) ? x.join(",") : String(x))).join(":")); };
  return {
    calls,
    beginStage(r: string, b: string) { note("begin", r, b); },
    /** 事件段的批里记下了这一天的 mem_day_done */
    commitStage(r: string) { note("commit", r); return { days: r.includes("-events-") ? [r.slice(6, 16)] : [] }; },
    revertStage(r: string) { note("revert", r); return { reverted: 0, conflicts }; },
    markDays(d: string[]) { note("mark", d); },
    stageOps: (_r: string) => 0,
    revertDayStages(day: string, since: number) { note("revertDay", day); calls[calls.length - 1]!.push(since); return { reverted: 0, conflicts }; },
  };
}

function nightHost(o: {
  acts?: Record<string, Act | Act[]>;
  run?: (argv: string[], fs: ReturnType<typeof memFs>) => { code: number; out: string } | void | Promise<{ code: number; out: string } | void>;
  skill?: (s: StageSpec) => string | null;
  fs?: ReturnType<typeof memFs>; db?: Db; mem?: ReturnType<typeof fakeMem> | EventMemory; log?: string[]; now?: () => number; logs?: LogRecord[];
} = {}) {
  const log = o.log ?? [];
  const opened: Array<{ id: string; stage: string; day: string; allowed: string[] }> = [];
  const wakes: Record<string, string[]> = {};
  const argvs: string[][] = [];
  const timers: Array<() => void> = [];
  const cancelled = { n: 0 };
  const fs = o.fs ?? memFs();
  const db = o.db ?? openDb(":memory:");
  const mem = o.mem ?? fakeMem(log);
  const count = new Map<string, number>();
  const host: StageHost = {
    flowHash: "h1", prefix: "SOUL + common",
    open(x) {
      const n = (count.get(`${x.day}/${x.stage.id}`) ?? 0) + 1;
      count.set(`${x.day}/${x.stage.id}`, n);
      opened.push({ id: x.id, stage: x.stage.id, day: x.day, allowed: [...x.allowed] });
      log.push(`open:${x.stage.id}:${n}`);
      const ws: string[] = [];
      wakes[x.id] = ws;
      let onDone: (d: StageDone) => string = () => "";
      let onEnd: (ok: boolean, e?: string, u?: typeof USAGE) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise((r) => { settle = r; });
      let closed = false;
      const a = o.acts?.[x.stage.id];
      const act: Act = Array.isArray(a) ? (a[n - 1] ?? a[a.length - 1]!) : (a ?? pass());
      return {
        id: x.id, settled,
        wake(t: string) {
          if (closed) return;
          ws.push(t);
          const root = rootOf(x.day);
          const c: Ctx = {
            id: x.id, stage: x.stage.id, day: x.day, attempt: n, wake: ws.length, text: t,
            read: (p) => fs.read(`${root}/${p}`), write: (p, s) => fs.write(`${root}/${p}`, s),
            done: (d = {}) => onDone({ status: "done", changes: [], report: `${x.stage.id} 的报告`, uncertain: [], proposals: [], bugs: [], ...d }),
            end: (ok = true, e, u) => onEnd(ok, e, u),
          };
          queueMicrotask(() => void act(c));
        },
        onTurnEnd(fn: (ok: boolean, e?: string, u?: typeof USAGE) => void) { onEnd = fn; },
        onDone(fn: (d: StageDone) => string) { onDone = fn; },
        async close() {
          if (closed) return;
          closed = true;
          log.push(`close:${x.stage.id}:${n}`);
          settle({ how: "ok", turns: ws.length, usage: { ...USAGE } });
        },
      } as never;
    },
    async run(argv) {
      argvs.push(argv);
      log.push(`run:${argv.join(" ")}`);
      return (await o.run?.(argv, fs)) ?? { code: 0, out: "" };
    },
    fs, mem: mem as never, db,
    skillText: o.skill ?? ((s) => `skill 页 ${s.skill}`),
    materialText: (day, names) => `材料 ${day}：${names.join("、") || "无"}`,
    now: o.now ?? (() => 1000),
    later: (fn) => { timers.push(fn); return () => { cancelled.n++; }; },
    log: new Logger("test", o.logs ? memorySink(o.logs) : () => {}),
  };
  return { host, log, opened, wakes, argvs, timers, cancelled, fs, db, mem: mem as ReturnType<typeof fakeMem> };
}

const verdicts = (m: Record<string, Array<{ pass: boolean; problems: string[] }>>, log?: string[]): StageValidator => ({
  name: "fake",
  async validate(stage, _day, rec) {
    log?.push(`validate:${stage.id}:${rec.attempt}`);
    return m[stage.id]?.[rec.attempt - 1] ?? { pass: true, problems: [] };
  },
});
const bigBudget = () => new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
const runnerFor = (h: ReturnType<typeof nightHost>, flow: FlowConfig, o: Partial<ConstructorParameters<typeof SleepRunner>[2]> = {}) =>
  new SleepRunner(h.host, flow, { validators: [], budget: bigBudget(), watchdogMs: 5 * 3600_000, maxDays: Infinity, ...o });
const daysOf = (...ds: string[]) => { let i = 0; return async () => ds[i++] ?? null; };
/** 结果里除了这一晚记账那一行的编号（runId 单独测） */
const noId = ({ runId: _id, ...r }: NightResult): Omit<NightResult, "runId"> => r;
const script = (id: string, command: string[], extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "script", command, ...extra });
/** prepare → events（required）→ people → finish */
const baseFlow = (people: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("events", { after: ["prepare"], required: true, checkpoint: true, writes: ["memory/open-loops.md"], memWrite: true }),
  agent("people", { after: ["events"], writes: ["memory/people/**"], ...people }),
  script("finish", ["finish", "{day}", "{partial}"], { after: ["people"] }),
], extra);
const stageRows = (db: Db) => all<{ stage: string; attempt: number; status: string; error: string | null; verdict: string | null; units: number | null }>(db, "SELECT stage, attempt, status, error, verdict, units FROM sleep_stage ORDER BY id");

test("budget: units and the target / hard lines", () => {
  const t = { input: 10, cacheRead: 100, cacheWrite: 8, output: 2 };
  assert.equal(units(t, "opus", DEFAULT_WEIGHTS), 10 + 10 + 10 + 10);
  assert.equal(units(t, "sonnet", DEFAULT_WEIGHTS), 40 * 0.6);
  assert.equal(units(t, "haiku", DEFAULT_WEIGHTS), 40 * 0.2);
  const b = new Budget({ unitsPerPct: 5_400_000, targetPct: 1, hardPct: 2 });
  assert.equal(b.pct, 0);
  b.add(5_400_000);
  assert.equal(b.pct, 1);
  assert.equal(b.overTarget, true);
  assert.equal(b.overHard, false);
  b.add(5_400_000);
  assert.equal(b.overHard, true);
});

test("runner: prepare, two stages in order, finish, day marked", async () => {
  const h = nightHost({ acts: { events: pass({ "memory/open-loops.md": "E" }, { report: "事件段做完了" }), people: pass({ "memory/people/a.md": "P" }) } });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "2026-11-05", pending: daysOf(D) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "done" });
  assert.deepEqual(h.opened.map((x) => x.id), [`sleep-${D}-events-1`, `sleep-${D}-people-1`]);
  assert.ok(h.opened[0]!.allowed.includes("stage_done"));
  assert.deepEqual(h.argvs, [["prepare", D], ["finish", D]]);
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "begin").map((c) => c[2]), [`sleep:${D}/events/1`, `sleep:${D}/people/1`]);
  const at = (s: string) => h.log.indexOf(s);
  assert.ok(at(`commit:sleep-${D}-events-1`) < at("open:people:1"));
  assert.ok(at(`run:finish ${D}`) < at(`mark:${D}`));
  assert.ok(at(`mark:${D}`) > 0);
  // 叫醒的话：skill 页 + 材料，最后一句交差；下游带上游的报告
  const w1 = h.wakes[`sleep-${D}-events-1`]![0]!;
  assert.ok(w1.includes("skill 页 events.md") && w1.includes(`材料 ${D}`));
  assert.ok(w1.endsWith("做完用 stage_done 交。"));
  assert.ok(h.wakes[`sleep-${D}-people-1`]![0]!.includes("事件段做完了"));
  // 提案留着、变更记录写了、prepared.json 用完删了
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "E");
  const rec = JSON.parse(h.fs.read(`sleep/${D}/flow/events.json`)!);
  assert.deepEqual(rec.actual, { files: [{ path: "memory/open-loops.md", op: "add" }], memOps: 0 });
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
  // 记账
  assert.deepEqual(stageRows(h.db).map((x) => `${x.stage}:${x.attempt}:${x.status}`), ["prepare:1:passed", "events:1:passed", "people:1:passed", "finish:1:passed"]);
  assert.equal(stageRows(h.db)[1]!.units, 250);
  const run = all<{ status: string; days: string; spent_units: number }>(h.db, "SELECT status, days, spent_units FROM sleep_run")[0]!;
  assert.equal(run.status, "done");
  assert.deepEqual(JSON.parse(run.days), [D]);
  assert.equal(run.spent_units, 500);
});

test("runner: the result names its sleep_run row (Brain writes the quota readings there)", async () => {
  const db = openDb(":memory:");
  const first = await runnerFor(nightHost({ db }), baseFlow()).runNight({ night: "n1", pending: daysOf(D) });
  const second = await runnerFor(nightHost({ db }), baseFlow()).runNight({ night: "n2", pending: daysOf() });
  const rows = all<{ id: number; night: string }>(db, "SELECT id, night FROM sleep_run ORDER BY id");
  assert.deepEqual([first.runId, second.runId], rows.map((x) => x.id));
  assert.deepEqual(rows.map((x) => x.night), ["n1", "n2"]);
});

test("runner: abort (hhd stopping) mid-stage or mid-landing — the day is abandoned, finish never runs, stoppedBy aborted", { timeout: 5000 }, async () => {
  // 段的会话开着时停：那一段算中止（不重做、不推迟），整天撤回，不落地
  const runner: { r: SleepRunner | null } = { r: null };
  const h = nightHost({ acts: { events: pass({ "memory/open-loops.md": "E" }), people: (c) => { c.write("memory/people/a.md", "半截"); runner.r!.abort("hhd 停了"); } } });
  runner.r = runnerFor(h, baseFlow());
  const r = await runner.r.runNight({ night: "n", pending: daysOf(D, "2026-11-05") });
  assert.deepEqual(noId(r), { landed: [], deferredDays: [D], owed: [], stoppedBy: "aborted" });
  assert.ok(!h.argvs.some((a) => a[0] === "finish"), "不落地");
  assert.ok(h.log.includes("close:people:1"));
  assert.equal(h.opened.filter((x) => x.stage === "people").length, 1, "中止了不重做");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/people/a.md`), null, "提案恢复成准备完那份");
  assert.ok(h.mem.calls.some((c) => c[0] === "revertDay"), "今晚的批次撤回");
  assert.equal(all<{ status: string }>(h.db, "SELECT status FROM sleep_run")[0]!.status, "aborted");
  assert.equal(h.cancelled.n, 1, "看门狗取消了");

  // 落地的核对脚本跑着时停：后面的 finish 不跑
  const flow = mk([
    script("prepare", ["prepare", "{day}"]),
    agent("events", { after: ["prepare"], writes: ["memory/open-loops.md"] }),
    script("check", ["check", "{day}"], { after: ["events"] }),
    script("finish", ["finish", "{day}"], { after: ["check"] }),
  ]);
  const h2 = nightHost({ acts: { events: pass({ "memory/open-loops.md": "E" }) }, run: (argv) => { if (argv[0] === "check") runner.r!.abort("hhd 停了"); } });
  runner.r = runnerFor(h2, flow);
  const r2 = await runner.r.runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r2.landed, []);
  assert.deepEqual(h2.argvs.map((a) => a[0]), ["prepare", "check"]);
  assert.ok(!h2.mem.calls.some((c) => c[0] === "mark"));
});

test("runner: the host's day notes go at the top of that day's report", async () => {
  const h = nightHost();
  const notes: Record<string, string[]> = { [D]: ["把关结论回来时那一段已经关了，2 条没写进提案"] };
  h.host.dayNotes = (day) => notes[day] ?? [];
  await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D) });
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.ok(report.startsWith(`# ${D} 夜里整理\n\n把关结论回来时那一段已经关了，2 条没写进提案\n`), report);
});

test("runner: sleep_run.spent_units is the whole budget (audit sessions add to it from outside the runner)", async () => {
  const h = nightHost();
  const budget = bigBudget();
  const audit: StageValidator = { name: "audit", async validate() { budget.add(30); return { pass: true, problems: [] }; } };
  await runnerFor(h, baseFlow(), { budget, validators: [audit] }).runNight({ night: "n", pending: daysOf(D) });
  const run = all<{ spent_units: number }>(h.db, "SELECT spent_units FROM sleep_run")[0]!;
  assert.equal(run.spent_units, 500 + 60, "两段各 250 + 两次核依据各 30");
});

const chainFlow = () => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("events", { after: ["prepare"], required: true, writes: ["memory/open-loops.md"] }),
  agent("self", { after: ["events"], writes: ["memory/midterm/self.md"] }),
  agent("soul", { after: ["self"], writes: ["soul/**"] }),
  script("finish", ["finish", "{day}"], { after: ["soul"] }),
]);

test("runner: a stage that fails twice is deferred, its dependents too, the day still lands", async () => {
  const selfAct: Act = (c) => pass({ "memory/midterm/self.md": `self v${c.attempt}` })(c);
  const h = nightHost({ acts: { self: selfAct } });
  const r = await runnerFor(h, chainFlow(), { validators: [verdicts({ self: [failV("说话人错了"), failV("还是错")] })] })
    .runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(r.deferredDays, []);
  assert.deepEqual(r.owed, [{ day: D, stage: "self" }, { day: D, stage: "soul" }]);
  assert.deepEqual(h.opened.map((x) => x.stage), ["events", "self", "self"]);
  // 重做那次带着问题
  const redo = h.wakes[`sleep-${D}-self-2`]![0]!;
  assert.ok(redo.startsWith(P.SLEEP_STAGE_REDO(["说话人错了"])));
  assert.ok(redo.endsWith("做完用 stage_done 交。"));
  // 推迟的提案挪到 deferred/，proposed/ 恢复
  assert.equal(h.fs.read(`sleep/${D}/deferred/self/memory/midterm/self.md`), "self v2");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/midterm/self.md`), null);
  assert.ok(h.log.includes(`revert:sleep-${D}-self-1`) && h.log.includes(`revert:sleep-${D}-self-2`));
  assert.ok(h.argvs.some((a) => a[0] === "finish"));
  assert.ok(h.log.includes(`mark:${D}`));
  const L = await import("../src/sleep/ledger.ts");
  const owed = L.owed(h.db);
  assert.deepEqual(owed.map((x) => x.stage), ["self", "soul"]);
  assert.deepEqual(owed[0]!.problems, ["还是错"]);
  assert.deepEqual(stageRows(h.db).filter((x) => x.stage === "self").map((x) => x.status), ["redo", "deferred"]);
});

test("runner: carry drop stages are deferred but not owed", async () => {
  const flow = mk([
    agent("events", { required: true }),
    agent("self", { after: ["events"], carry: "drop" }),
    script("finish", ["finish"], { after: ["self"] }),
  ]);
  const h = nightHost();
  const r = await runnerFor(h, flow, { validators: [verdicts({ self: [failV(), failV()] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(r.owed, []);
});

test("runner: required stage fails twice → whole day deferred", async () => {
  const h = nightHost();
  const r = await runnerFor(h, baseFlow(), { validators: [verdicts({ events: [failV(), failV()] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(noId(r), { landed: [], deferredDays: [D], owed: [], stoppedBy: "done" });
  assert.deepEqual(h.opened.map((x) => x.stage), ["events", "events"]);
  assert.deepEqual(h.argvs, [["prepare", D]]);
  assert.ok(!h.log.some((l) => l.startsWith("mark:")));
  assert.ok(h.log.includes(`revertDay:${D}`), "这一天做过的段都撤回，下一晚从头来");
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
  const L = await import("../src/sleep/ledger.ts");
  assert.deepEqual(L.owed(h.db), []);
});

test("stage ends its turn without stage_done: nudged once, then counted as failed", async () => {
  const h = nightHost({ acts: { people: silent } });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(h.wakes[`sleep-${D}-people-1`]!.slice(1), [P.SLEEP_STAGE_CONTINUE]);
  assert.deepEqual(h.wakes[`sleep-${D}-people-2`]!.slice(1), [P.SLEEP_STAGE_CONTINUE]);
  assert.equal(h.opened.filter((x) => x.stage === "people").length, 2);
  const rows = stageRows(h.db).filter((x) => x.stage === "people");
  assert.deepEqual(rows.map((x) => x.status), ["redo", "deferred"]);
  assert.match(rows[0]!.error ?? "", /stage_done/);
  assert.deepEqual(r.owed, [{ day: D, stage: "people" }]);
  assert.deepEqual(r.landed, [D]);
});

test("runner: a failed turn is nudged once like a turn without stage_done; a missing skill page fails the attempt", async () => {
  const h = nightHost({ acts: { events: (c) => c.end(false, "API 出错") }, skill: (s) => (s.id === "people" ? null : `skill ${s.id}`) });
  const r = await runnerFor(h, mk([
    script("prepare", ["prepare"]),
    agent("events", { after: ["prepare"] }),
    agent("people", { after: ["prepare"] }),
    script("finish", ["finish"], { after: ["events", "people"] }),
  ])).runNight({ night: "n", pending: daysOf(D) });
  assert.equal(h.opened.filter((x) => x.stage === "people").length, 0, "找不到 skill 页就不开会话");
  assert.deepEqual(h.wakes[`sleep-${D}-events-1`]!.slice(1), [P.SLEEP_STAGE_CONTINUE], "出错的一轮也催一次（跟没交共用这一次）");
  const rows = stageRows(h.db);
  assert.deepEqual(rows.filter((x) => x.stage === "people").map((x) => x.status), ["redo", "deferred"]);
  assert.match(rows.find((x) => x.stage === "people")!.error ?? "", /找不到 skill 页 people\.md/);
  assert.match(rows.find((x) => x.stage === "events")!.error ?? "", /API 出错/);
  assert.deepEqual(r.owed.map((x) => x.stage).sort(), ["events", "people"]);
  assert.deepEqual(r.landed, [D]);
});

test("redo of a later stage on a shared file starts from the earlier stage's version", async () => {
  const flow = mk([
    script("prepare", ["prepare"]),
    agent("a", { after: ["prepare"], writes: ["memory/open-loops.md"] }),
    agent("b", { after: ["prepare"], writes: ["memory/open-loops.md"] }),
    script("finish", ["finish"], { after: ["a", "b"] }),
  ]);
  const seen: Array<string | null> = [];
  const h = nightHost({
    run: (argv, fs) => { if (argv[0] === "prepare") fs.write(`${rootOf(D)}/memory/open-loops.md`, "0"); },
    acts: {
      a: (c) => pass({ "memory/open-loops.md": `${c.read("memory/open-loops.md")}+A` })(c),
      b: (c) => { seen.push(c.read("memory/open-loops.md")); pass({ "memory/open-loops.md": `${c.read("memory/open-loops.md")}+B${c.attempt}` })(c); },
    },
  });
  const r = await runnerFor(h, flow, { validators: [verdicts({ b: [failV("b 丢了一条")] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(h.opened.map((x) => x.stage), ["a", "b", "b"], "改同一个文件的不同时跑，按配置先后");
  assert.deepEqual(seen, ["0+A", "0+A"]);
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "0+A+B2");
});

test("restart mid-stage: the day is redone from prepare and half-done proposals are discarded", async () => {
  const flow = mk([
    script("prepare", ["prepare", "{day}"]),
    agent("a", { after: ["prepare"], writes: ["memory/a.md"] }),
    agent("b", { after: ["a"], writes: ["memory/b.md"] }),
    script("finish", ["finish", "{day}"], { after: ["b"] }),
  ]);
  const fs = memFs();
  let crash = true;
  const write0 = fs.write;
  fs.write = (p, s) => { if (crash && p === `sleep/${D}/flow/b.json`) throw new Error("hhd 重启了"); write0(p, s); };
  const db = openDb(":memory:");
  const log: string[] = [];
  const mem = fakeMem(log);
  // 「重启」：抛错以后撤回也撤不成（final #2：撤成了就不留 prepared.json，撤不成才留着给下一次从头来）
  const revertDay0 = mem.revertDayStages;
  mem.revertDayStages = (day: string, since: number) => { if (crash) throw new Error("事件库也坏了"); return revertDay0(day, since); };
  const prep = (argv: string[], f: typeof fs) => { if (argv[0] === "prepare") f.write(`${rootOf(D)}/memory/x.md`, "0"); };
  const acts = { a: pass({ "memory/a.md": "A" }), b: (c: Ctx) => pass({ "memory/b.md": crash ? "半截" : "B" })(c) };

  const h1 = nightHost({ fs, db, mem, log, run: prep, acts });
  const r1 = await runnerFor(h1, flow).runNight({ night: "n1", pending: daysOf(D) });
  assert.deepEqual(noId(r1), { landed: [], deferredDays: [D], owed: [], stoppedBy: "error", error: "hhd 重启了" }, "抛错不往外抛，这一夜停下");
  assert.ok(fs.read(`sleep/${D}/flow/prepared.json`), "准备完的快照还在");
  assert.equal(fs.read(`${rootOf(D)}/memory/b.md`), "半截");
  assert.equal(all<{ status: string }>(db, "SELECT status FROM sleep_run")[0]!.status, "error");
  assert.equal(h1.cancelled.n, 1, "抛错也取消看门狗");

  crash = false;
  log.length = 0;
  let atPrepare: Record<string, string> | null = null;
  const h2 = nightHost({
    fs, db, mem, log, acts,
    run: (argv, f) => {
      if (argv[0] === "prepare" && !atPrepare) atPrepare = Object.fromEntries(proposedFiles(rootOf(D), f).map((p) => [p, f.read(`${rootOf(D)}/${p}`)!]));
      prep(argv, f);
    },
  });
  const r = await runnerFor(h2, flow).runNight({ night: "n2", pending: daysOf(D) });
  assert.deepEqual(atPrepare, { "memory/x.md": "0" }, "从准备重来之前，proposed/ 恢复成准备完那份");
  assert.ok(log.indexOf(`revertDay:${D}`) >= 0 && log.indexOf(`revertDay:${D}`) < log.indexOf(`run:prepare ${D}`));
  assert.deepEqual(mem.calls.find((c) => c[0] === "revertDay"), ["revertDay", D, 1000], "只撤上一跑准备完以后开的批次");
  assert.deepEqual(r.landed, [D]);
  assert.equal(fs.read(`${rootOf(D)}/memory/b.md`), "B");
  assert.equal(fs.read(`${rootOf(D)}/memory/a.md`), "A");
  assert.equal(fs.read(`sleep/${D}/flow/prepared.json`), null);
});

test("budget: over the hard line, no new day and no new non-required stage; required stage in progress finishes", async () => {
  const flow = mk([
    script("prepare", ["prepare", "{day}"]),
    agent("events", { after: ["prepare"], required: true, writes: ["memory/open-loops.md"] }),
    agent("people", { after: ["events"], writes: ["memory/people/**"] }),
    agent("keep", { after: ["events"], required: true, writes: ["memory/keep.md"] }),
    script("finish", ["finish", "{day}"], { after: ["people", "keep"] }),
  ]);
  const h = nightHost();
  // 一段 250 单位；绝对线 2% × 100 = 200：events 做到一半越线，照样做完
  const budget = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 2 });
  const pending = daysOf(D, "2026-11-05");
  const r = await runnerFor(h, flow, { budget }).runNight({ night: "n", pending });
  assert.deepEqual(h.opened.map((x) => x.stage), ["events", "keep"], "过线以后 required 的段照开，别的不开");
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [{ day: D, stage: "people" }], stoppedBy: "budget" });
  assert.deepEqual(h.argvs, [["prepare", D], ["finish", D]], "不开新的一天");
  assert.equal(budget.overHard, true);
});

test("gate output: defer skips the day, save runs only saveMode stages and lands unmarked, partial skips needsDialogue stages and finishes with --partial", async () => {
  const gate = (word: string) => (argv: string[]) => (argv[0] === "prepare" ? { code: 0, out: `${word}\n说明` } : undefined);

  const hd = nightHost({ run: gate("defer") });
  const rd = await runnerFor(hd, baseFlow()).runNight({ night: "n", pending: async () => D });
  assert.deepEqual(noId(rd), { landed: [], deferredDays: [D], owed: [], stoppedBy: "done" });
  assert.deepEqual(hd.opened, []);
  assert.deepEqual(hd.argvs, [["prepare", D]], "同一天这一夜只试一次");
  assert.deepEqual(stageRows(hd.db).map((x) => x.status), ["passed"], "不算失败");

  const hs = nightHost({ run: gate("save") });
  const rs = await runnerFor(hs, baseFlow({}, { saveMode: ["events"] })).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(hs.opened.map((x) => x.stage), ["events"]);
  assert.deepEqual(hs.argvs, [["prepare", D], ["finish", D, "--partial"]], "省电模式照样落地（spec §10.1），带 --partial：不标这一天做完（final #6）");
  assert.ok(!hs.log.some((l) => l.startsWith("mark:")), "省电模式：落地但不标完成");
  assert.deepEqual(noId(rs), { landed: [D], deferredDays: [], owed: [], stoppedBy: "done" });
  assert.match(hs.fs.read(`sleep/${D}/report.md`)!, /people：今天不跑/);

  const hp = nightHost({ run: gate("partial") });
  const rp = await runnerFor(hp, baseFlow({ needsDialogue: true })).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(hp.opened.map((x) => x.stage), ["events"]);
  assert.deepEqual(hp.argvs, [["prepare", D], ["finish", D, "--partial"]]);
  assert.ok(!hp.log.some((l) => l.startsWith("mark:")), "材料不完整：落地但不标完成");
  assert.deepEqual(noId(rp), { landed: [D], deferredDays: [], owed: [], stoppedBy: "done" });
});

test("runner: pending returning a day already tried this night ends the loop", async () => {
  const h = nightHost();
  let asked = 0;
  const r = await runnerFor(h, baseFlow(), { validators: [verdicts({ events: [failV(), failV()] })] })
    .runNight({ night: "n", pending: async () => { asked++; return D; } });
  assert.deepEqual(noId(r), { landed: [], deferredDays: [D], owed: [], stoppedBy: "done" });
  assert.equal(asked, 2);
  assert.equal(h.argvs.filter((a) => a[0] === "prepare").length, 1);
});

test("report: assembled from stage reports with the ledger numbers on top, before finish runs", async () => {
  let report: string | null = null;
  const h = nightHost({
    run: (argv, fs) => { if (argv[0] === "finish") report = fs.read(`sleep/${D}/report.md`); },
    acts: {
      events: pass({ "memory/open-loops.md": "E" }, { report: "事件段：记了三件事", uncertain: ["拿不准 U"], proposals: ["提案 P"], bugs: ["毛病 B"] }),
      people: pass({ "memory/people/a.md": "P" }, { report: "人物段：改了一张卡" }),
    },
  });
  const audit: StageValidator = { name: "audit", validate: async (s) => (s.id === "people" ? { pass: true, problems: ["核依据没做完"] } : { pass: true, problems: [] }) };
  await runnerFor(h, baseFlow(), { validators: [audit] }).runNight({ night: "n", pending: daysOf(D) });
  assert.ok(report, "finish 跑的时候报告已经在了");
  const t = report as unknown as string;
  const lines = t.split("\n").filter(Boolean);
  assert.equal(lines[1], "people 段没核依据", "没核依据写在最上面");
  const i = (s: string) => { const k = t.indexOf(s); assert.ok(k >= 0, `报告里没有「${s}」：\n${t}`); return k; };
  assert.ok(i("## 记账") < i("## 各段"));
  assert.ok(i("events：过了（1 次，250 单位）") < i("## 各段"));
  assert.ok(i("事件段：记了三件事") < i("人物段：改了一张卡"));
  assert.ok(i("## 拿不准") < i("events：拿不准 U"));
  assert.ok(i("## 给主人的提案") < i("events：提案 P"));
  assert.ok(i("## 毛病") < i("events：毛病 B"));
});

test("when: sunday stage only runs on Sunday's day; disabled stage never runs", async () => {
  const flow = mk([
    script("prepare", ["prepare", "{day}"]),
    agent("events", { after: ["prepare"], required: true }),
    agent("weekly", { after: ["events"], when: ["sunday"] }),
    agent("off", { after: ["events"], enabled: false }),
    agent("later", { after: ["off"] }),
    agent("light", { after: ["events"], when: ["always", "backlog<=1"] }),
    script("finish", ["finish", "{day}"], { after: ["weekly", "later", "light"] }),
  ]);
  const h = nightHost();
  const r = await runnerFor(h, flow).runNight({ night: "n", pending: daysOf("2026-10-31", "2026-11-01"), backlog: async () => 2 });
  const opened = (day: string) => h.opened.filter((x) => x.day === day).map((x) => x.stage).sort();
  assert.deepEqual(opened("2026-10-31"), ["events", "later"], "10-31 是周六");
  assert.deepEqual(opened("2026-11-01"), ["events", "later", "weekly"], "11-01 是周日");
  assert.deepEqual(r.landed, ["2026-10-31", "2026-11-01"]);
  assert.deepEqual(r.owed, [], "今天不跑的不欠");
  const rep = h.fs.read("sleep/2026-10-31/report.md")!;
  assert.match(rep, /weekly：今天不跑/);
  assert.match(rep, /off：今天不跑/);
  assert.match(rep, /light：今天不跑/);
});

test("checkpoint: a checkpoint stage is validated before anything after it starts", async () => {
  const h = nightHost();
  const peopleOpenAtValidate: boolean[] = [];
  const v: StageValidator = {
    name: "slow",
    async validate(s) {
      if (s.id === "events") {
        await new Promise((r) => setTimeout(r, 5));
        peopleOpenAtValidate.push(h.opened.some((x) => x.stage === "people"));
      }
      return { pass: true, problems: [] };
    },
  };
  const r = await runnerFor(h, baseFlow(), { validators: [v] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(peopleOpenAtValidate, [false]);
  assert.deepEqual(h.opened.map((x) => x.stage), ["events", "people"]);
  assert.deepEqual(r.landed, [D]);
});

test("runner: watchdog closes the running stage, reverts it and stops", async () => {
  let h!: ReturnType<typeof nightHost>;
  h = nightHost({ acts: { people: () => { queueMicrotask(() => h.timers[0]!()); } } });
  let asked = 0;
  const r = await runnerFor(h, baseFlow(), { watchdogMs: 1000 }).runNight({ night: "n", pending: async () => { asked++; return asked === 1 ? D : "2026-11-05"; } });
  assert.deepEqual(noId(r), { landed: [], deferredDays: [D], owed: [], stoppedBy: "watchdog" });
  assert.equal(asked, 1, "看门狗到点以后不再开新的一天");
  assert.ok(h.log.includes("close:people:1"));
  assert.ok(h.log.includes(`revert:sleep-${D}-people-1`));
  assert.equal(h.opened.filter((x) => x.stage === "people").length, 1, "关掉的段不重做");
  assert.ok(!h.argvs.some((a) => a[0] === "finish"));
  assert.ok(h.log.includes(`revertDay:${D}`));
  assert.equal(stageRows(h.db).find((x) => x.stage === "people")!.status, "failed");
});

test("finalCheck: a named stage is redone once on the current proposals; still wrong goes into the report", async () => {
  const seen: Array<string | null> = [];
  const h = nightHost({
    acts: {
      events: pass({ "memory/open-loops.md": "E" }),
      people: (c) => { seen.push(c.read("memory/people/a.md")); pass({ "memory/people/a.md": `P${c.attempt}` })(c); },
    },
  });
  let checks = 0;
  const finalCheck = async () => { checks++; return { redo: [{ stage: "people", problems: [`第 ${checks} 次全天考试：答错了 q1`] }] }; };
  const r = await runnerFor(h, baseFlow(), { finalCheck }).runNight({ night: "n", pending: daysOf(D) });
  assert.equal(checks, 2);
  assert.deepEqual(seen, [null, "P1"], "重做在现在的提案上接着改");
  assert.ok(h.wakes[`sleep-${D}-people-2`]![0]!.includes("第 1 次全天考试：答错了 q1"));
  assert.equal(h.fs.read(`${rootOf(D)}/memory/people/a.md`), "P2");
  assert.deepEqual(r.landed, [D]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /第 2 次全天考试：答错了 q1/);
});

test("runner: a day that comes back on a later night keeps counting attempts, so batch ids never repeat", async () => {
  const db = openDb(":memory:");
  const fs = memFs();
  const log: string[] = [];
  const mem = fakeMem(log);
  // 第一夜材料不完整：落地但不标完成，这一天第二夜还会来
  const h1 = nightHost({ db, fs, mem, log, run: (argv) => (argv[0] === "prepare" ? { code: 0, out: "partial" } : undefined) });
  assert.deepEqual((await runnerFor(h1, baseFlow()).runNight({ night: "n1", pending: daysOf(D) })).landed, [D]);
  const h2 = nightHost({ db, fs, mem, log });
  assert.deepEqual((await runnerFor(h2, baseFlow()).runNight({ night: "n2", pending: daysOf(D) })).landed, [D]);
  assert.deepEqual(mem.calls.filter((c) => c[0] === "begin").map((c) => c[2]),
    [`sleep:${D}/events/1`, `sleep:${D}/people/1`, `sleep:${D}/events/2`, `sleep:${D}/people/2`]);
  assert.deepEqual(h2.opened.map((x) => x.id), [`sleep-${D}-events-2`, `sleep-${D}-people-2`]);
  assert.ok(fs.read(`sleep/${D}/flow/events.2.json`), "第二夜的记录另存，不盖第一夜的");
  assert.match(fs.read(`sleep/${D}/report.md`)!, /events：过了（1 次，250 单位）/, "报告里数的是今晚的次数");
});

// ---- Task 8 修正第 1 轮 ----

test("runner: the watchdog firing between days (inside pending or backlog) opens no new day", async () => {
  for (const where of ["pending", "backlog"] as const) {
    const h = nightHost();
    let n = 0;
    const fire = async () => { await new Promise((r) => setTimeout(r, 1)); h.timers[0]!(); };
    const pending = async () => { n++; if (n === 2 && where === "pending") await fire(); return n === 1 ? "2026-11-03" : "2026-11-04"; };
    let asked = 0;
    const backlog = async () => { asked++; if (n === 2 && where === "backlog") await fire(); return 0; };
    const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending, backlog });
    assert.equal(asked, where === "pending" ? 1 : 2, `${where}：看门狗到点以后不再问积压`);
    assert.deepEqual(noId(r), { landed: ["2026-11-03"], deferredDays: [], owed: [], stoppedBy: "watchdog" }, where);
    assert.ok(!h.opened.some((x) => x.day === "2026-11-04"), where);
    assert.ok(!h.argvs.some((a) => a.includes("2026-11-04")), where);
  }
});

test("runner: a failing finish abandons the day — batches reverted, proposals restored, not marked", async () => {
  const h = nightHost({
    run: (argv, fs) => {
      if (argv[0] === "prepare") fs.write(`${rootOf(D)}/memory/open-loops.md`, "0");
      if (argv[0] === "finish") return { code: 1, out: "hash 对不上" };
    },
    acts: { events: pass({ "memory/open-loops.md": "E" }), people: pass({ "memory/people/a.md": "P" }) },
  });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(noId(r), { landed: [], deferredDays: [D], owed: [], stoppedBy: "done" });
  assert.ok(h.log.indexOf(`revertDay:${D}`) > h.log.indexOf(`run:finish ${D}`));
  assert.deepEqual(h.mem.calls.find((c) => c[0] === "revertDay"), ["revertDay", D, 1000]);
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "0", "proposed/ 恢复成准备完那份");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/people/a.md`), null);
  assert.ok(!h.log.some((l) => l.startsWith("mark:")));
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
  const rep = h.fs.read(`sleep/${D}/report.md`)!;
  assert.ok(rep.startsWith("这一天没落地，下一晚从头来：落地的「finish」没过（退出码 1）：hash 对不上"), rep);
  assert.match(rep, /# 2026-11-04 夜里整理/, "原来的报告还在下面");
});

test("runner: abandoning a day leaves an earlier night's batches of the same day alone", async () => {
  let t = 1_000_000;
  const db = openDb(":memory:");
  const fs = memFs();
  const mem = new EventMemory({ db, embedder: null, now: () => t, tz: "UTC" });
  const event = (title: string, who: string) => ({ title, summary: `${title}的经过`, gist: title, why: "测试", importance: 3, status: "done", entities: [{ name: who, kind: "person", role: "with" }] });
  const flow = mk([
    script("prepare", ["prepare"]),
    agent("events", { after: ["prepare"] }),
    agent("req", { after: ["prepare"], required: true }),
    script("finish", ["finish"], { after: ["events", "req"] }),
  ]);
  const writeEvent = (title: string, who: string): Act => (c) => {
    const id = /e\d{4,5}/.exec(mem.write("mem_event_create", event(title, who), c.id))![0];
    c.done({ changes: [chg(id)] });
    c.end(true);
  };
  // 第一夜：材料不完整，落地但不标完成——事件段那一批提交了
  const h1 = nightHost({ db, fs, mem, now: () => t, run: (argv) => (argv[0] === "prepare" ? { code: 0, out: "partial" } : undefined), acts: { events: writeEvent("第一夜的事", "老张") } });
  assert.deepEqual((await runnerFor(h1, flow).runNight({ night: "n1", pending: daysOf(D) })).landed, [D]);
  const first = mem.store.batches().find((b) => b.batch === `sleep:${D}/events/1`);
  assert.equal(first?.state, "committed");
  // 第二夜：required 的段两次没过 → 这一天撤回；只撤今晚的
  t += 86_400_000;
  const h2 = nightHost({ db, fs, mem, now: () => t, acts: { events: writeEvent("第二夜的事", "小李") } });
  // 第几次接着第一夜往下数（2、3），这里按段名打回
  const reqFails: StageValidator = { name: "v", validate: async (s) => (s.id === "req" ? failV() : { pass: true, problems: [] }) };
  const r = await runnerFor(h2, flow, { validators: [reqFails] }).runNight({ night: "n2", pending: daysOf(D) });
  assert.deepEqual(r.deferredDays, [D]);
  assert.equal(mem.store.batchState(`sleep:${D}/events/2`), "reverted", "今晚的批次撤了");
  assert.equal(mem.store.batchState(`sleep:${D}/events/1`), "committed", "上一夜的批次不动");
  assert.ok(mem.store.batches().some((b) => b.batch === `sleep:${D}/events/1` && b.ops > 0), "第一夜写的还在");
  assert.ok(!mem.store.batches().some((b) => b.batch === `sleep:${D}/events/2` && b.ops > 0), "第二夜写的挪进了撤回留档");
});

test("runner: on a complete landing the engine marks the day itself, even if no stage called mem_day_done", async () => {
  const h = nightHost();
  await runnerFor(h, mk([agent("a"), script("finish", ["finish"], { after: ["a"] })])).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "mark"), [["mark", [D]]]);
});

test("budget: a non-required stage that crosses the hard line mid-run finishes; the next one is owed; the day-end exam is skipped", async () => {
  const flow = mk([
    script("prepare", ["prepare"]),
    agent("events", { after: ["prepare"], required: true }),
    agent("a", { after: ["events"] }),
    agent("b", { after: ["a"] }),
    script("finish", ["finish"], { after: ["b"] }),
  ]);
  const h = nightHost();
  // 绝对线 4% × 100 = 400：events 后 250，a 开的时候没过线、做完 500
  const budget = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 4 });
  let checks = 0;
  const r = await runnerFor(h, flow, { budget, finalCheck: async () => { checks++; return { redo: [] }; } }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(h.opened.map((x) => x.stage), ["events", "a"]);
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [{ day: D, stage: "b" }], stoppedBy: "done" });
  assert.equal(checks, 0, "过了绝对线不考全天考试");
  const rep = h.fs.read(`sleep/${D}/report.md`)!;
  assert.ok(rep.indexOf("花费到了绝对线，全天考试没考") < rep.indexOf("## 记账"));
  assert.match(rep, /- a：过了（1 次，250 单位）/);
  assert.match(rep, /- b：花费到了绝对线，没开/);
});

test("stage session: close() after a timeout waits until the region is really closed", async () => {
  const driver = new FakeDriver();
  let fire: (() => void) | null = null;
  const t = openStageSession(stageDeps(driver, (fn) => { fire = fn; }), stageOpts("st-c", ["recall"]));
  t.wake("开始");
  const ks = driver.latest("st-c");
  let release!: () => void;
  const slow = new Promise<void>((r) => { release = r; });
  ks.close = async () => { await slow; ks.closed = true; };
  fire!();
  assert.equal((await t.settled).how, "timeout");
  let back = false;
  const c = t.close().then(() => { back = true; });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(back, false, "超时那一下还没关完，close() 不能先回来");
  release();
  await c;
  assert.equal(ks.closed, true);
});

test("runner: the watchdog is cancelled when the night ends; a runner runs one night only", async () => {
  const h = nightHost();
  const runner = runnerFor(h, baseFlow());
  await runner.runNight({ night: "n", pending: daysOf(D) });
  assert.equal(h.cancelled.n, 1);
  await assert.rejects(runner.runNight({ night: "n2", pending: daysOf(D) }), /只跑一夜/);
});

test("report: a deferred stage's own notes and revert conflicts are listed; the wake names the day and the proposed path", async () => {
  const log: string[] = [];
  const mem = fakeMem(log, { conflicts: ["entry_add mem_entry n00001（之后又被改过）"] });
  const h = nightHost({ mem, log, acts: { people: pass({}, { uncertain: ["拿不准 X"], proposals: ["提案 Y"], bugs: ["毛病 Z"] }) } });
  await runnerFor(h, baseFlow(), { validators: [verdicts({ people: [failV(), failV()] })] }).runNight({ night: "n", pending: daysOf(D) });
  const rep = h.fs.read(`sleep/${D}/report.md`)!;
  const top = rep.slice(0, rep.indexOf("## 记账"));
  assert.match(top, /撤回「people」第 1 次的事件库批次时有 1 处没撤动：entry_add mem_entry n00001/);
  assert.match(rep, /- people（推迟了）：拿不准 X/);
  assert.match(rep, /- people（推迟了）：提案 Y/);
  assert.match(rep, /- people（推迟了）：毛病 Z/);
  const w = h.wakes[`sleep-${D}-events-1`]![0]!;
  assert.ok(w.includes(`整理自己 ${D} 这一天`) && w.includes(`sleep/${D}/proposed/`), w);
  assert.ok(!w.includes("<日>"));
});

// 评审的并行用例（conc.test.ts）：两段同时跑、各管各的文件和记录；required 推迟时并行那段被关掉，不卡住
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("parallel: two non-conflicting stages run at once; one fails twice; the other's files and record stay its own", async () => {
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], writes: ["memory/a.md"] }), agent("b", { after: ["prepare"], writes: ["memory/b.md"] }), script("finish", ["finish"], { after: ["a", "b"] })]);
  const h = nightHost({
    acts: {
      a: async (c) => { c.write("memory/a.md", "A"); await sleepMs(20); c.done({ changes: [chg("memory/a.md")] }); c.end(true); },
      b: async (c) => { await sleepMs(5); c.write("memory/b.md", `B${c.attempt}`); c.done({ changes: [chg("memory/b.md")] }); c.end(true); },
    },
  });
  const r = await runnerFor(h, flow, { validators: [verdicts({ b: [failV("bad"), failV("bad")] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.ok(h.log.indexOf("open:b:1") < h.log.indexOf(`commit:sleep-${D}-a-1`), "a 还在跑时 b 就开了");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/a.md`), "A");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/b.md`), null);
  assert.deepEqual(JSON.parse(h.fs.read(`sleep/${D}/flow/a.json`)!).actual.files, [{ path: "memory/a.md", op: "add" }]);
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(r.owed, [{ day: D, stage: "b" }]);
});

test("parallel: a required stage deferred while a parallel stage is mid-session closes it, no hang, day abandoned", async () => {
  const flow = mk([script("prepare", ["prepare"]), agent("req", { after: ["prepare"], required: true, writes: ["memory/r.md"] }), agent("slow", { after: ["prepare"], writes: ["memory/s.md"] }), script("finish", ["finish"], { after: ["req", "slow"] })]);
  const h = nightHost({
    acts: {
      req: async (c) => { c.write("memory/r.md", "R"); c.done({ changes: [chg("memory/r.md")] }); c.end(true); },
      slow: async (c) => { c.write("memory/s.md", "S"); /* 这一轮一直不结束 */ },
    },
  });
  const r = await runnerFor(h, flow, { validators: [verdicts({ req: [failV("bad"), failV("bad")] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.deferredDays, [D]);
  assert.ok(h.log.includes("close:slow:1"));
  assert.equal(h.fs.read(`${rootOf(D)}/memory/s.md`), null);
  assert.ok(!h.argvs.some((a) => a[0] === "finish"));
});

// ---- Task 9: Brain 那一头的小零件 ----
import { nodeFs } from "../src/sleep/host.ts";
import { tmpDir } from "./tmp.ts";

test("nodeFs: real files, paths relative to the workspace (absolute ones as they are); writes make the folders", async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = tmpDir("hh-nodefs-");
  const fs = nodeFs(root);
  assert.equal(fs.read("sleep/d/proposed/a.md"), null);
  assert.deepEqual(fs.list("sleep/d/proposed"), []);
  fs.write("sleep/d/proposed/memory/a.md", "A");
  assert.equal(readFileSync(join(root, "sleep/d/proposed/memory/a.md"), "utf8"), "A");
  assert.equal(fs.read("sleep/d/proposed/memory/a.md"), "A");
  assert.deepEqual(fs.list("sleep/d/proposed"), ["memory"]);
  assert.equal(fs.isDir("sleep/d/proposed/memory"), true);
  assert.equal(fs.isDir("sleep/d/proposed/memory/a.md"), false);
  assert.equal(fs.isDir("sleep/d/none"), false);
  assert.deepEqual(proposedFiles("sleep/d/proposed", fs), ["memory/a.md"]);
  const other = tmpDir("hh-nodefs-abs-");
  fs.write(join(other, "x/last-good.json"), "{}");
  assert.equal(readFileSync(join(other, "x/last-good.json"), "utf8"), "{}");
  fs.remove("sleep/d/proposed/memory/a.md");
  fs.remove("sleep/d/proposed/memory/a.md");
  assert.equal(existsSync(join(root, "sleep/d/proposed/memory/a.md")), false);
});

// ---- 终审修正（final-fixes）：落地和出错的路径 ----
const D2 = "2026-11-05";
/** prepare → events → finish → 落地以后的脚本（export，required）→ tidy */
const afterFinishFlow = () => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("events", { after: ["prepare"], writes: ["memory/open-loops.md"] }),
  script("finish", ["finish", "{day}"], { after: ["events"] }),
  script("export", ["export", "{day}"], { after: ["finish"], required: true }),
  script("tidy", ["tidy", "{day}"], { after: ["export"] }),
]);

test("final #1: a required script after finish fails → the day has landed, nothing reverted, a note on top of the report", async () => {
  const h = nightHost({ acts: { events: pass({ "memory/open-loops.md": "E" }) }, run: (argv) => (argv[0] === "export" ? { code: 1, out: "导出坏了" } : undefined) });
  const r = await runnerFor(h, afterFinishFlow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "done" });
  assert.ok(!h.mem.calls.some((c) => c[0] === "revertDay"), "落地了，不撤回");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "E", "提案留着");
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "mark"), [["mark", [D]]]);
  assert.deepEqual(h.argvs.map((a) => a[0]), ["prepare", "finish", "export", "tidy"], "后面的照跑");
  const rep = h.fs.read(`sleep/${D}/report.md`)!;
  assert.ok(rep.startsWith("落地以后的「export」没过（退出码 1）：导出坏了"), rep);
  assert.match(rep, /# 2026-11-04 夜里整理/);
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
});

test("final #1: an abort while a script after finish runs → landed, nothing reverted, later scripts don't run", async () => {
  const runner: { r: SleepRunner | null } = { r: null };
  const h = nightHost({ acts: { events: pass({ "memory/open-loops.md": "E" }) }, run: (argv) => { if (argv[0] === "export") runner.r!.abort("hhd 停了"); } });
  runner.r = runnerFor(h, afterFinishFlow());
  const r = await runner.r.runNight({ night: "n", pending: daysOf(D, D2) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "aborted" });
  assert.ok(!h.mem.calls.some((c) => c[0] === "revertDay"), "落地了，不撤回");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "E");
  assert.deepEqual(h.argvs.map((a) => a[0]), ["prepare", "finish", "export"], "叫停以后后面的不跑，也不开新的一天");
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "mark"), [["mark", [D]]]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /^落地以后叫停了（hhd 停了），后面的「tidy」等没跑/);
});

test("final #2: writeReport throws on day 2 → day 1 stays landed, day 2 undone, the night stops with error (no rethrow)", async () => {
  const fs = memFs();
  const write0 = fs.write;
  fs.write = (p, s) => { if (p === `sleep/${D2}/report.md`) throw new Error("磁盘满了"); write0(p, s); };
  const logs: LogRecord[] = [];
  const h = nightHost({ fs, logs, acts: { events: pass({ "memory/open-loops.md": "E" }), people: pass({ "memory/people/a.md": "P" }) } });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D, D2, "2026-11-06") });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [D2], owed: [], stoppedBy: "error", error: "磁盘满了" });
  assert.ok(!h.mem.calls.some((c) => c[0] === "revertDay" && c[1] === D), "第一天不动");
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "revertDay"), [["revertDay", D2, 1000]], "第二天准备完以后开的批次撤回");
  assert.equal(h.fs.read(`${rootOf(D2)}/memory/people/a.md`), null, "第二天的提案恢复成准备完那份");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/people/a.md`), "P");
  assert.equal(h.fs.read(`sleep/${D2}/flow/prepared.json`), null, "撤成了就不留 prepared.json");
  assert.ok(!h.argvs.some((a) => a.includes("2026-11-06")), "这一夜停在出错那天");
  assert.ok(!h.argvs.some((a) => a[0] === "finish" && a[1] === D2));
  const run = all<{ status: string; days: string; notes: string }>(h.db, "SELECT status, days, notes FROM sleep_run")[0]!;
  assert.equal(run.status, "error");
  assert.deepEqual(JSON.parse(run.days), [D]);
  assert.match(run.notes, /磁盘满了/);
  assert.ok(logs.some((l) => l.msg === "sleep: night stopped by an error" && l.level === "error"));
  assert.equal(h.cancelled.n, 1);
});

test("final #2: pending() throws on the second lookup → day 1 still counts as landed", async () => {
  const h = nightHost();
  let n = 0;
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: async () => { n++; if (n === 2) throw new Error("sleep_digest.py pending 没跑成"); return D; } });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "error", error: "sleep_digest.py pending 没跑成" });
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "mark"), [["mark", [D]]]);
  assert.equal(all<{ status: string }>(h.db, "SELECT status FROM sleep_run")[0]!.status, "error");
});

test("final #2: a throw after finish keeps the day landed (never undone)", async () => {
  const log: string[] = [];
  const mem = fakeMem(log);
  mem.markDays = () => { throw new Error("标不上"); };
  const h = nightHost({ mem, log });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D, D2) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "error", error: "标不上" });
  assert.ok(!h.mem.calls.some((c) => c[0] === "revertDay"));
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
});

test("final #6: {partial} becomes --partial on a save or partial day; a complete day drops it", async () => {
  const gate = (word: string) => (argv: string[]) => (argv[0] === "prepare" ? { code: 0, out: `${word}\n说明` } : undefined);
  const finishOf = async (word: string | null) => {
    const h = nightHost(word ? { run: gate(word) } : {});
    await runnerFor(h, baseFlow({}, { saveMode: ["events"] })).runNight({ night: "n", pending: daysOf(D) });
    return h.argvs.find((a) => a[0] === "finish");
  };
  assert.deepEqual(await finishOf("save"), ["finish", D, "--partial"], "省电：落地、提交，但不标这一天做完");
  assert.deepEqual(await finishOf("partial"), ["finish", D, "--partial"]);
  assert.deepEqual(await finishOf(null), ["finish", D]);
});

test("final #6: a stage's mem_day_done for another day doesn't get that day marked; only the day itself is", async () => {
  const db = openDb(":memory:");
  const mem = new EventMemory({ db, embedder: null, now: () => 1000, tz: "UTC" });
  const h = nightHost({ db, mem, acts: {
    events: (c) => { mem.write("mem_day_done", { day: "2026-11-03" }, c.id); mem.write("mem_day_done", { day: c.day }, c.id); c.done(); c.end(true); },
  } });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.equal(mem.store.dayDone(D), true);
  assert.equal(mem.store.dayDone("2026-11-03"), false, "别的日子不跟着标");
});

test("final #10: an unreadable prepared.json reverts since the start of the crashed run (the latest one never ended); with none, nothing is reverted and an error is logged", async () => {
  const L = await import("../src/sleep/ledger.ts");
  const db = openDb(":memory:");
  const old = L.startRun(db, "n0", "h", 500);
  L.startStage(db, { runId: old, day: D, stage: "prepare", attempt: 1, model: "script" }, 510);
  L.endRun(db, old, { status: "done", days: [D], spentUnits: 0 }, 600);
  L.startRun(db, "n1", "h", 700);   // 崩了的那一跑：没收尾（ended 空着），这一天也还没记过账
  const fs = memFs({ [`sleep/${D}/flow/prepared.json`]: "{ 坏了" });
  const logs: LogRecord[] = [];
  const h = nightHost({ db, fs, logs });
  assert.deepEqual((await runnerFor(h, baseFlow()).runNight({ night: "n2", pending: daysOf(D) })).landed, [D]);
  assert.deepEqual(h.mem.calls.find((c) => c[0] === "revertDay"), ["revertDay", D, 700], "从崩了的那一跑开始时撤：以前几夜的不动，这一跑自己不算");
  assert.ok(logs.some((l) => l.msg.startsWith("sleep: prepared.json unreadable") && l.level === "error"));

  const logs2: LogRecord[] = [];
  const h2 = nightHost({ fs: memFs({ [`sleep/${D}/flow/prepared.json`]: "{ 坏了" }), logs: logs2 });
  assert.deepEqual((await runnerFor(h2, baseFlow()).runNight({ night: "n", pending: daysOf(D) })).landed, [D]);
  assert.ok(!h2.mem.calls.some((c) => c[0] === "revertDay"), "账上没有崩了的那一跑：不撤");
  assert.ok(logs2.some((l) => /no crashed run/.test(l.msg) && l.level === "error"));
});

// ---- 终审修正：流程配置的核对 ----
test("final #3: memWrite is derived — a stage listing an event-store writer is memWrite; two such stages conflict and never run together", async () => {
  const flow = mk([
    script("prepare", ["prepare"]),
    agent("a", { after: ["prepare"], tools: ["mem_write"], writes: ["memory/a.md"] }),
    agent("b", { after: ["prepare"], tools: ["note", "mem_write"], writes: ["memory/b.md"] }),
    agent("c", { after: ["prepare"], tools: ["note"], writes: ["memory/c.md"] }),
    script("finish", ["finish"], { after: ["a", "b", "c"] }),
  ], { maxParallel: 3 });
  const st = (id: string) => flow.stages.find((x) => x.id === id)!;
  assert.deepEqual(["a", "b", "c"].map((id) => st(id).memWrite), [true, true, false], "没写 memWrite 也按工具算");
  assert.equal(conflict(st("a"), st("b")), true);
  assert.equal(conflict(st("a"), st("c")), false);
  const slow: Act = async (c) => { await sleepMs(10); c.done(); c.end(true); };
  const h = nightHost({ acts: { a: slow, b: slow, c: slow } });
  assert.deepEqual((await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) })).landed, [D]);
  const at = (x: string) => h.log.indexOf(x);
  assert.ok(at("open:c:1") < at("close:a:1"), "不写事件库的照样并行");
  assert.ok(at("open:b:1") > at("close:a:1"), `两个写事件库的不同时跑：${h.log.join(" ")}`);
});

test("final #4: engine flow needs an enabled agent stage and an enabled script stage finish; stage ids must be safe file names", () => {
  const fails = (stages: unknown[], extra: Record<string, unknown>, word: string) => {
    let err: FlowError | null = null;
    try { mk(stages, extra); } catch (e) { err = e as FlowError; }
    assert.ok(err instanceof FlowError, `应该不过：${word}`);
    assert.ok(err.problems.some((x) => x.includes(word)), `缺少「${word}」：${err.problems.join("|")}`);
  };
  const flow = { engine: "flow" };
  const fin = script("finish", ["finish", "{day}"], { after: ["a"] });
  assert.equal(mk([agent("a"), fin], flow).engine, "flow");
  fails([script("prepare", ["p"]), script("finish", ["finish"])], flow, "agent 段");
  fails([agent("a", { enabled: false }), fin], flow, "agent 段");
  fails([agent("a")], flow, "finish");
  fails([agent("a"), agent("finish", { after: ["a"] })], flow, "finish");
  fails([agent("a"), script("finish", ["finish"], { after: ["a"], enabled: false })], flow, "finish");
  // legacy 不要求（旧的整理不跑这些段）
  assert.equal(mk([script("prepare", ["p"])]).engine, "legacy");
  for (const bad of ["../x", "a/b", "a b", "-a", "_a", ".a", "段一"]) fails([agent(bad)], {}, "id");
  assert.deepEqual(mk([agent("a-1_B2")]).stages.map((x) => x.id), ["a-1_B2"]);
});

// ---- 终审修正：会话的守门 ----
test("final #7: a bash entry can pin a subcommand: \"<script> <arg>…\" only allows calls whose words start with exactly those args", () => {
  const guard = g({ bash: ["sleep_apply.py step", "sleep_digest.py", "sleep_check.py run 2026-11-04"] });
  for (const c of ["python3 scripts/sleep_apply.py step 2026-11-04 x done", "scripts/sleep_apply.py step", "./scripts/sleep_apply.py step 2026-11-04",
    `python3 ${W}/scripts/sleep_apply.py step a`, "/usr/bin/python3 scripts/sleep_apply.py step 2026-11-04 2", "python3 scripts/sleep_digest.py anything at all",
    "python3 scripts/sleep_check.py run 2026-11-04 --x"]) {
    assert.equal(guard("Bash", { command: c }), undefined, c);
  }
  for (const c of ["python3 scripts/sleep_apply.py finish 2026-11-04", "python3 scripts/sleep_apply.py", "python3 scripts/sleep_apply.py stepx 2026-11-04",
    "python3 scripts/sleep_apply.py 2026-11-04 step", "/usr/bin/python3 scripts/sleep_apply.py finish 2026-11-04", "python3 scripts/sleep_check.py run 2026-11-05",
    "python3 scripts/sleep_check.py run", "python3 scripts/sleep_apply.py step a; rm x"]) {
    assert.ok(guard("Bash", { command: c }), c);
  }
  assert.match(guard("Bash", { command: "python3 scripts/sleep_apply.py finish 2026-11-04" })!, /scripts\/sleep_apply\.py step/, "说清楚能用哪几条");
  assert.deepEqual(mk([agent("a", { bash: ["sleep_apply.py step", "sleep_digest.py"] })]).stages[0]!.bash, ["sleep_apply.py step", "sleep_digest.py"], "流程配置收这种写法");
});

test("final #13: budget.calls is enforced — a turn end past the limit without a hand-in fails the attempt; a hand-in in that turn still counts", async () => {
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], budget: { calls: 3 } }), script("finish", ["finish"], { after: ["a"] })]);
  // 第 1 次：没交、调用超了 → 没过，不催；回放第 1 次 F3 起直接推迟、不重做
  const h = nightHost({ acts: { a: (c) => c.end(true, undefined, { ...USAGE, calls: 4 }) } });
  const r = await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  const rows = stageRows(h.db).filter((x) => x.stage === "a");
  assert.deepEqual(rows.map((x) => x.status), ["deferred"]);
  assert.equal(rows[0]!.verdict, "调用次数到了上限（3 次），推迟，不重做");
  assert.equal(h.wakes[`sleep-${D}-a-1`]!.length, 1, "超了不再催");
  assert.ok(!h.wakes[`sleep-${D}-a-2`], "不重做");
  // 这一轮交了，调用也超了 → 照样收下（residual c）
  const h3 = nightHost({ acts: { a: (c) => { c.done(); c.end(true, undefined, { ...USAGE, calls: 4 }); } } });
  await runnerFor(h3, flow).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(stageRows(h3.db).filter((x) => x.stage === "a").map((x) => x.status), ["passed"]);
  // 正好到上限、没交：照常催一次
  const h2 = nightHost({ acts: { a: (c) => { if (c.wake === 2) c.done(); c.end(true, undefined, { ...USAGE, calls: 3 }); } } });
  assert.deepEqual((await runnerFor(h2, flow).runNight({ night: "n", pending: daysOf(D) })).landed, [D]);
  assert.deepEqual(stageRows(h2.db).filter((x) => x.stage === "a").map((x) => x.status), ["passed"], "正好到上限不算超");
});

test("final #13: a stage session reports its running usage with every turn end", async () => {
  const driver = new FakeDriver();
  const s = openStageSession(stageDeps(driver), stageOpts("st-calls", ["recall"]));
  const seen: number[] = [];
  s.onTurnEnd((_ok, _e, u) => seen.push(u?.calls ?? -1));
  s.wake("开始");
  const fs = driver.latest("st-calls");
  await fs.play({ say: "x", total: { calls: 2, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } });
  await fs.play({ say: "y", total: { calls: 3, input: 1, cacheRead: 0, cacheWrite: 0, output: 1 } });
  assert.deepEqual(seen, [2, 5]);
  await s.close();
});

// ---- 终审修正：花费 ----
test("final #5b: a stage session closed mid-turn (timeout or close) adds the turn's usage so far", async () => {
  const driver = new FakeDriver();
  let fire: (() => void) | null = null;
  const s = openStageSession(stageDeps(driver, (fn) => { fire = fn; }), stageOpts("st-mid", ["recall"]));
  s.wake("开始");
  const ks = driver.latest("st-mid");
  await ks.play({ say: "x", contextTokens: 100, total: { calls: 2, input: 10, cacheRead: 100, cacheWrite: 20, output: 5 } });
  ks.inFlightTotal = { calls: 1, input: 3, cacheRead: 50, cacheWrite: 0, output: 9 };
  fire!();
  const r = await s.settled;
  assert.equal(r.how, "timeout");
  assert.deepEqual(r.usage, { calls: 3, input: 13, cacheRead: 150, cacheWrite: 20, output: 14, maxCtx: 100 });

  const c = openStageSession(stageDeps(driver), stageOpts("st-mid2", ["recall"]));
  c.wake("开始");
  driver.latest("st-mid2").inFlightTotal = { calls: 1, input: 7, cacheRead: 0, cacheWrite: 0, output: 1 };
  await c.close();
  assert.deepEqual((await c.settled).usage, { calls: 1, input: 7, cacheRead: 0, cacheWrite: 0, output: 1, maxCtx: 0 });
});

// ---- 终审修正第二轮（residual pass） ----
test("residual (b): finish exit 0 lands the day before anything else — a ledger UPDATE throwing right after it doesn't un-land it", async () => {
  const db = openDb(":memory:");
  const prep = db.prepare.bind(db);
  let boom = false;
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (boom && sql.startsWith("UPDATE sleep_stage")) throw new Error("账写不进去");
    return prep(sql);
  };
  const h = nightHost({ db, acts: { events: pass({ "memory/open-loops.md": "E" }) }, run: (argv) => { if (argv[0] === "finish") boom = true; } });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D, D2) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "error", error: "账写不进去" });
  assert.ok(!h.mem.calls.some((c) => c[0] === "revertDay"), "落地了，不撤回");
  assert.equal(h.fs.read(`${rootOf(D)}/memory/open-loops.md`), "E");
  assert.deepEqual(h.mem.calls.filter((c) => c[0] === "mark"), [["mark", [D]]], "落地的完整一天照样标");
  assert.equal(h.fs.read(`sleep/${D}/flow/prepared.json`), null);
});

test("residual (b): hhd dying during a script after finish — prepared.json is already gone, so the next night doesn't start the landed day over", async () => {
  const fs = memFs();
  const db = openDb(":memory:");
  const log: string[] = [];
  const mem = fakeMem(log);
  const flow = afterFinishFlow();
  const partial = (argv: string[]) => (argv[0] === "prepare" ? { code: 0, out: "partial" } : undefined);
  let reached = false;
  const h1 = nightHost({ fs, db, mem, log, acts: { events: pass({ "memory/open-loops.md": "E" }) },
    run: (argv) => (argv[0] === "export" ? (reached = true, new Promise<never>(() => {})) : partial(argv)) });
  void runnerFor(h1, flow).runNight({ night: "n1", pending: daysOf(D) });
  for (let i = 0; i < 50 && !reached; i++) await sleepMs(1);
  assert.ok(reached, "停在 finish 后面的脚本里（hhd 在这时退出）");
  assert.equal(fs.read(`sleep/${D}/flow/prepared.json`), null, "finish 过了就删 prepared.json");
  // 材料不完整的那天下一晚还会来：不能当成没收尾从头来（撤掉已经落地的批次）
  const h2 = nightHost({ fs, db, mem, log, run: partial });
  assert.deepEqual((await runnerFor(h2, flow).runNight({ night: "n2", pending: daysOf(D) })).landed, [D]);
  assert.ok(!mem.calls.some((c) => c[0] === "revertDay"), "没有撤回落地了的那天");
});

test("residual (d): the normal-path endRun throwing is logged and the night's result still comes back", async () => {
  const db = openDb(":memory:");
  const prep = db.prepare.bind(db);
  (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (sql.startsWith("UPDATE sleep_run SET ended")) throw new Error("账写不进去");
    return prep(sql);
  };
  const logs: LogRecord[] = [];
  const h = nightHost({ db, logs });
  const r = await runnerFor(h, baseFlow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(noId(r), { landed: [D], deferredDays: [], owed: [], stoppedBy: "done" });
  assert.ok(logs.some((l) => l.msg === "sleep: writing the night's ledger row failed" && l.level === "error"));
});

test("residual (e): the bash guard splits words like the shell (space and tab only); an empty bash entry is rejected", () => {
  const guard = g({ bash: ["sleep_apply.py step"] });
  assert.equal(guard("Bash", { command: "python3 scripts/sleep_apply.py step\t2026-11-04" }), undefined, "tab 照样分词");
  for (const c of ["python3 scripts/sleep_apply.py step\u00a0finish 2026-11-04", "python3 scripts/sleep_apply.py step\u2003finish", "python3\u00a0scripts/sleep_apply.py step x",
    "python3 scripts/sleep_apply.py step\vfinish", "python3 scripts/sleep_apply.py step\ffinish"]) {
    assert.ok(guard("Bash", { command: c }), JSON.stringify(c));
  }
  for (const bad of [[""], ["  "], ["sleep_apply.py", ""]]) {
    let err: FlowError | null = null;
    try { mk([agent("a", { bash: bad })]); } catch (e) { err = e as FlowError; }
    assert.ok(err instanceof FlowError && err.problems.some((x) => x.includes("bash")), JSON.stringify(bad));
  }
});

test("residual (f): an unreadable prepared.json after a crash leaves an earlier partial night's committed batch of the same day alone", async () => {
  const L = await import("../src/sleep/ledger.ts");
  let t = 1_000_000;
  const db = openDb(":memory:");
  const fs = memFs();
  const mem = new EventMemory({ db, embedder: null, now: () => t, tz: "UTC" });
  const event = (title: string) => ({ title, summary: `${title}的经过`, gist: title, why: "测试", importance: 3, status: "done", entities: [{ name: "老张", kind: "person", role: "with" }] });
  // 没有准备脚本的流程：崩了的那一跑准备完就崩，这一天在账上一行都没有
  const flow = mk([agent("events"), script("finish", ["finish", "{day}", "{partial}"], { after: ["events"] })]);
  const writeEvent: Act = (c) => {
    const id = /e\d{4,5}/.exec(mem.write("mem_event_create", event("第一夜的事"), c.id))![0];
    mem.write("mem_entity_upsert", { name: "老张", importance: 2 }, c.id);
    c.done({ changes: [chg(id)] });
    c.end(true);
  };
  const h1 = nightHost({ db, fs, mem, now: () => t, acts: { events: writeEvent } });
  assert.deepEqual((await runnerFor(h1, flow).runNight({ night: "n1", pending: daysOf(D) })).landed, [D]);
  assert.equal(mem.store.batchState(`sleep:${D}/events/1`), "committed");
  t += 86_400_000;
  L.startRun(db, "n2", "h", t);           // 崩了的那一跑（没收尾）
  fs.write(`sleep/${D}/flow/prepared.json`, "{ 写到一半");
  t += 60_000;
  const h3 = nightHost({ db, fs, mem, now: () => t, acts: { events: (c) => { c.done(); c.end(true); } } });
  assert.deepEqual((await runnerFor(h3, flow).runNight({ night: "n3", pending: daysOf(D) })).landed, [D]);
  assert.equal(mem.store.batchState(`sleep:${D}/events/1`), "committed", "上一夜提交的批次不动");
  assert.ok(mem.store.batches().some((b) => b.batch === `sleep:${D}/events/1` && b.ops > 0));
});

// ---- engine-built materials (tonight-events, handoff) ----
import { engineMaterial } from "../src/sleep/host.ts";
import { openDb as openMatDb } from "../src/store/db.ts";
import { EventStore as MatStore } from "../src/memory/events/store.ts";
import type { StageRecord as MatRecord } from "../src/sleep/record.ts";

const matRec = (stage: string, attempt: number, x: Partial<MatRecord> = {}): MatRecord => ({
  day: "2026-11-06", stage, attempt, status: "done", changes: [], report: "", uncertain: [], proposals: [], bugs: [],
  actual: { files: [], memOps: 0 } as never, ...x,
});

test("tonight-events lists entries committed by passed stages", () => {
  const db = openMatDb(":memory:");
  const s = new MatStore(db, () => Date.UTC(2026, 10, 6, 20));
  const b1 = "sleep:2026-11-06/events/1", b2 = "sleep:2026-11-06/people/1", b3 = "sleep:2026-11-06/later/1";
  s.openBatch(b1);
  const ev = s.createEvent({ title: "做脸", summary: "s", gist: "g", importance: 3, status: "ongoing", entities: [] }, b1);
  s.addEntry({ event: ev.id, at: Date.UTC(2026, 10, 6, 10), kind: "happened", full: "全文甲", gist: "要点甲", title: "甲", people: ["小贝"], source: ["c:12"] }, b1);
  s.commitBatch(b1);
  // 没提交（还开着）的批、没过的段写的，都不进
  s.openBatch(b2);
  s.addEntry({ event: ev.id, at: Date.UTC(2026, 10, 6, 11), kind: "happened", full: "全文乙", gist: "要点乙", title: "乙", people: [], source: [] }, b2);
  s.openBatch(b3);
  s.addEntry({ event: ev.id, at: Date.UTC(2026, 10, 6, 12), kind: "happened", full: "全文丙", gist: "要点丙", title: "丙", people: [], source: [] }, b3);
  s.commitBatch(b3);
  const passed = [{ stage: "events", record: matRec("events", 1) }, { stage: "people", record: matRec("people", 1) }];
  const out = engineMaterial("tonight-events", { day: "2026-11-06", passed, store: s })!;
  assert.match(out, new RegExp(`## ${ev.id} 做脸`));
  assert.match(out, /全文：全文甲/);
  assert.match(out, /要点：要点甲/);
  assert.match(out, /谁：小贝/);
  assert.match(out, /来源：c:12/);
  assert.doesNotMatch(out, /全文乙/, "open batch not listed");
  assert.doesNotMatch(out, /全文丙/, "stage that did not pass not listed");
  assert.equal(engineMaterial("slices-name", { day: "2026-11-06", passed, store: s }), null);
});

test("handoff lists earlier stages' bugs", () => {
  const passed = [
    { stage: "events", record: matRec("events", 1, { bugs: ["脚本漏了一行"], uncertain: ["他是谁"], proposals: ["加个检查"] }) },
    { stage: "quiet", record: matRec("quiet", 1) },
    { stage: "people", record: matRec("people", 1, { bugs: ["自己的毛病"] }) },
  ];
  const out = engineMaterial("handoff", { day: "2026-11-06", stage: "people", passed, store: null })!;
  assert.match(out, /## events\n- 毛病：脚本漏了一行\n- 拿不准：他是谁\n- 提案：加个检查/);
  assert.doesNotMatch(out, /## quiet/);
  assert.doesNotMatch(out, /自己的毛病/, "the current stage's own notes are not handed to itself");
});

test("tonight-events also lists event-level changes and corrections", () => {
  const db = openMatDb(":memory:");
  const s = new MatStore(db, () => Date.UTC(2026, 10, 6, 20));
  const b = "sleep:2026-11-06/events/1";
  s.openBatch(b);
  const ev = s.createEvent({ title: "追剧", summary: "s", gist: "g", importance: 2, status: "ongoing", entities: [] }, b);
  const en = s.addEntry({ event: ev.id, at: Date.UTC(2026, 10, 6, 10), kind: "happened", full: "旧文", gist: "旧", title: "t", people: [], source: [] }, b).entry;
  s.correctEntry(en.id, { full: "新文", gist: "新", title: "t", why: "看了原话" }, b);
  s.updateEvent(ev.id, { stance: "like", importance: 3 }, "喜欢上了", b);
  s.commitBatch(b);
  const out = engineMaterial("tonight-events", { day: "2026-11-06", passed: [{ stage: "events", record: matRec("events", 1) }], store: s })!;
  assert.match(out, /## 今晚动过的事/);
  assert.match(out, new RegExp(`- 创建 ${ev.id} 追剧`));
  assert.match(out, new RegExp(`- 更新 ${ev.id} 追剧：重要度：2→3；态度：无→like`));
  assert.match(out, new RegExp(`更正 ${en.id}`));
});

test("handoff merges a redone stage into one deduped section", () => {
  const passed = [
    { stage: "events", record: matRec("events", 1, { bugs: ["漏行"], uncertain: ["他是谁"] }) },
    { stage: "events", record: matRec("events", 2, { bugs: ["漏行", "新毛病"] }) },
  ];
  const out = engineMaterial("handoff", { day: "2026-11-06", stage: "x", passed, store: null })!;
  assert.equal(out.match(/## events/g)?.length, 1);
  assert.equal(out.match(/漏行/g)?.length, 1);
  assert.match(out, /新毛病/);
});

// ---------- 回放第 1 次的修正（replay1 F3）：调用次数到了上限就推迟，不重做；到 80% 催它收尾 ----------

test("replay1 F3: over budget.calls without a hand-in the stage is deferred at once — no attempt 2, the coordinator is not asked; a required stage aborts the day", async () => {
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], budget: { calls: 10 } }), script("finish", ["finish"], { after: ["a"] })]);
  const why = "调用次数到了上限（10 次），推迟，不重做";
  const h = nightHost({ acts: { a: (c) => c.end(true, undefined, { ...USAGE, calls: 11 }) } });
  const briefs: string[] = [];
  const coordinator = { async decide(b: string) { briefs.push(b); return { decision: "redo" as const, why: "再来", notes: [] }; }, async close() {} };
  const r = await runnerFor(h, flow, { coordinator }).runNight({ night: "n", pending: daysOf(D) });
  const rows = stageRows(h.db).filter((x) => x.stage === "a");
  assert.deepEqual(rows.map((x) => [x.attempt, x.status, x.verdict]), [[1, "deferred", why]]);
  assert.ok(!h.wakes[`sleep-${D}-a-2`], "没有第 2 次");
  assert.deepEqual(briefs, [], "不问前额叶");
  assert.deepEqual(r.landed, [D], "不是 required：这一天照样落地");
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /调用次数到了上限（10 次），推迟，不重做/);
  // required：整天推迟，报告写这个原因
  const req = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], budget: { calls: 10 }, required: true }), script("finish", ["finish"], { after: ["a"] })]);
  const h2 = nightHost({ acts: { a: (c) => c.end(true, undefined, { ...USAGE, calls: 11 }) } });
  const r2 = await runnerFor(h2, req).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r2.deferredDays, [D]);
  assert.deepEqual(stageRows(h2.db).filter((x) => x.stage === "a").map((x) => x.status), ["deferred"]);
  assert.match(h2.fs.read(`sleep/${D}/report.md`)!, /a 段调用次数到了上限（10 次），推迟，不重做/);
});

test("replay1 F3: at 80% of budget.calls without a hand-in the stage is told once to wrap up, with X / N", async () => {
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], budget: { calls: 10 } }), script("finish", ["finish"], { after: ["a"] })]);
  const near = "这一段的调用次数快到上限了（已经用了 8 / 10 次）：现在就收尾，交 stage_done；没做完的写进 report「明天补」，别再开新的活";
  // 第 1 轮 8 次没交 → 催收尾；第 2 轮 9 次还没交 → 照旧催一次（不再说快到上限）；第 3 轮交了
  const h = nightHost({ acts: { a: (c) => { if (c.wake === 3) c.done(); c.end(true, undefined, { ...USAGE, calls: 7 + c.wake }); } } });
  const r = await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  const w = h.wakes[`sleep-${D}-a-1`]!;
  assert.equal(w[1], near);
  assert.equal(w.filter((x) => x.includes("快到上限")).length, 1, "只催一次收尾");
  assert.equal(w[2], P.SLEEP_STAGE_CONTINUE);
  // 不到 80% 就交了：不催
  const ok = nightHost({ acts: { a: (c) => { c.done(); c.end(true, undefined, { ...USAGE, calls: 7 }); } } });
  await runnerFor(ok, flow).runNight({ night: "n", pending: daysOf(D) });
  assert.equal(ok.wakes[`sleep-${D}-a-1`]!.length, 1, "一次都没催");
});

test("replay #2/#4: a target written as 「路径 空格 小节」 covers the file (the page allows a section after the path)", async () => {
  const r = rec({ files: ["memory/midterm/self.md"], changes: [chg("memory/midterm/self.md 某一节"), chg("memory/midterm/self.md　全角空格的小节")] });
  assert.deepEqual(await mechanical({ stage: peopleStage(), record: r, checks: {}, run: noRun, day: "d" }), []);
  // 只是前缀相同的别的文件不算
  const other = rec({ files: ["memory/midterm/self.md"], changes: [chg("memory/midterm/self.mdx 小节")] });
  const p = await mechanical({ stage: peopleStage(), record: other, checks: {}, run: noRun, day: "d" });
  assert.ok(p.some((x) => x.includes("文件 memory/midterm/self.md 实际改了")), p.join("；"));
});

// ---------- 切换前 P2：交 stage_done 时当场核对，对不上就在同一个会话里退回（每次尝试最多 2 次） ----------

const p2Flow = (a: Record<string, unknown> = {}) => mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], writes: ["memory/**"], ...a }), script("finish", ["finish"], { after: ["a"] })]);
const seenBy = (seen: string[]): StageValidator => ({
  name: "fake",
  async validate(_s, _d, r) { seen.push(`${r.attempt}:${r.changes.map((c) => c.target).join(",")}`); return { pass: true, problems: [] }; },
});

test("P2: an undeclared file is bounced in the same session; declared and handed in again it passes — no attempt 2, no new session", async () => {
  const replies: string[] = [];
  const h = nightHost({ acts: { a: (c) => {
    c.write("memory/a.md", "A");
    c.write("memory/b.md", "B");
    replies.push(c.done({ changes: [chg("memory/a.md")] }));
    replies.push(c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] }));
    c.end(true);
  } } });
  const seen: string[] = [];
  const r = await runnerFor(h, p2Flow(), { validators: [seenBy(seen)] }).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.match(replies[0]!, /文件 memory\/b\.md 实际改了，但 changes 里没有说到/);
  assert.match(replies[0]!, /stage_done/);
  assert.equal(replies[1], "收到，这一段交了。");
  assert.deepEqual(h.opened.filter((x) => x.stage === "a").map((x) => x.id), [`sleep-${D}-a-1`], "没开新会话");
  assert.deepEqual(stageRows(h.db).filter((x) => x.stage === "a").map((x) => `${x.attempt}:${x.status}`), ["1:passed"], "没有第 2 次");
  assert.deepEqual(seen, ["1:memory/a.md,memory/b.md"], "验证器拿到的是收下的那一次");
  assert.equal(h.wakes[`sleep-${D}-a-1`]!.length, 1, "同一轮里补交了：不用再叫醒");
});

test("P2: bounced and the turn ends without handing in again → woken once with the problems; handed in on that wake it passes", async () => {
  const h = nightHost({ acts: { a: (c) => {
    if (c.wake === 1) { c.write("memory/a.md", "A"); c.write("memory/b.md", "B"); c.done({ changes: [chg("memory/a.md")] }); }
    else c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] });
    c.end(true);
  } } });
  const r = await runnerFor(h, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  const w = h.wakes[`sleep-${D}-a-1`]!;
  assert.equal(w.length, 2);
  assert.match(w[1]!, /文件 memory\/b\.md 实际改了，但 changes 里没有说到/, "再叫醒时带上退回的问题");
  assert.notEqual(w[1], P.SLEEP_STAGE_CONTINUE);
  assert.deepEqual(stageRows(h.db).filter((x) => x.stage === "a").map((x) => `${x.attempt}:${x.status}`), ["1:passed"]);
});

test("P2: declared but not changed, and event-store ops with no ids, are bounced too; the named validate scripts are not run in-session", async () => {
  const log: string[] = [];
  const mem = { ...fakeMem(log), stageOps: (_r: string) => 2 };
  const replies: string[] = [];
  const h = nightHost({ mem: mem as never, log, acts: { a: (c) => {
    c.write("memory/a.md", "A");
    replies.push(c.done({ changes: [chg("memory/a.md"), chg("memory/z.md")] }));
    replies.push(c.done({ changes: [chg("memory/a.md"), chg("e0042")] }));
    c.end(true);
  } } });
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], writes: ["memory/**"], memWrite: true, validate: ["lint"] }), script("finish", ["finish"], { after: ["a"] })], { checks: { lint: ["lint", "{day}"] } });
  const r = await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(r.landed, [D]);
  assert.match(replies[0]!, /changes 说改了 memory\/z\.md，但实际没有改这个文件/);
  assert.match(replies[0]!, /事件库实际动了 2 次，但 changes 里没有说到任何事件/);
  assert.equal(replies[1], "收到，这一段交了。");
  assert.deepEqual(h.argvs.filter((a) => a[0] === "lint"), [["lint", D]], "点名的检查只在收下以后跑一次");
});

test("P2: after 2 bounces the 3rd hand-in is taken and fails the mechanical check as before (attempt 2 as today)", async () => {
  const replies: string[] = [];
  const h = nightHost({ acts: { a: [(c) => {
    c.write("memory/a.md", "A");
    c.write("memory/b.md", "B");
    for (let i = 0; i < 3; i++) replies.push(c.done({ changes: [chg("memory/a.md")] }));
    c.end(true);
  }, pass({ "memory/a.md": "A" })] } });
  await runnerFor(h, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.match(replies[0]!, /实际改了，但 changes 里没有说到/);
  assert.match(replies[1]!, /实际改了，但 changes 里没有说到/);
  assert.match(replies[0]!, /最多还能退回 1 次/);
  assert.match(replies[1]!, /不再退回/);
  assert.equal(replies[2], "收到，这一段交了。", "第 3 次照交的收下");
  const rows = stageRows(h.db).filter((x) => x.stage === "a");
  assert.deepEqual(rows.map((x) => `${x.attempt}:${x.status}`), ["1:redo", "2:passed"], "收下以后照旧没过机械检查、重做");
  assert.match(rows[0]!.verdict!, /文件 memory\/b\.md 实际改了，但 changes 里没有说到/);
});

test("P2: a bounced stage that never hands in again keeps its last hand-in — over the call cap it is taken and checked as before, not deferred as 'no hand-in'", async () => {
  const flow = p2Flow({ budget: { calls: 10 } });
  const h = nightHost({ acts: { a: [(c) => {
    c.write("memory/a.md", "A");
    c.write("memory/b.md", "B");
    c.done({ changes: [chg("memory/a.md")] });
    c.end(true, undefined, { ...USAGE, calls: 11 });
  }, pass({ "memory/a.md": "A" })] } });
  await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) });
  const rows = stageRows(h.db).filter((x) => x.stage === "a");
  assert.equal(rows[0]!.status, "redo", "照旧：交了的收下、机械检查没过、重做");
  assert.match(rows[0]!.verdict!, /文件 memory\/b\.md 实际改了/);
});

test("P2: a clean hand-in is taken at once with the same reply; blocked is never bounced", async () => {
  const replies: string[] = [];
  const h = nightHost({ acts: { a: (c) => { c.write("memory/a.md", "A"); replies.push(c.done({ changes: [chg("memory/a.md")] })); c.end(true); } } });
  await runnerFor(h, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(replies, ["收到，这一段交了。"]);
  assert.equal(h.wakes[`sleep-${D}-a-1`]!.length, 1);
  const blocked: string[] = [];
  const h2 = nightHost({ acts: { a: (c) => { c.write("memory/a.md", "A"); blocked.push(c.done({ status: "blocked", blockedWhy: "材料缺了", changes: [] })); c.end(true); } } });
  await runnerFor(h2, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.equal(blocked[0], "收到，这一段交了。", "做不下去的不退回：照旧交给后面");
});

test("P2: the runner tells the host what a bounce names for exam_questions (validators' precheck targets)", async () => {
  const told: string[][] = [];
  const replies: string[] = [];
  let checks = 0;
  const h = nightHost({ acts: { a: (c) => {
    c.write("memory/a.md", "A");
    replies.push(c.done({ changes: [chg("memory/a.md")] }));
    replies.push(c.done({ changes: [chg("memory/a.md")] }));
    c.end(true);
  } } });
  const open = h.host.open.bind(h.host);
  h.host.open = (x) => Object.assign(open(x), { bounced: (o: { questionsFor: string[] }) => { told.push(o.questionsFor); } });
  const v: StageValidator = {
    name: "exam",
    async validate() { return { pass: true, problems: [] }; },
    precheck(_s, _d, rec) {
      checks += 1;
      assert.deepEqual(rec.actual.files, [{ path: "memory/a.md", op: "add" }], "当场核对看的是现在的提案");
      return checks === 1 ? { problems: ["memory/a.md 要压缩，但没有出题"], targets: ["memory/a.md"] } : { problems: [], targets: [] };
    },
  };
  await runnerFor(h, p2Flow(), { validators: [v] }).runNight({ night: "n", pending: daysOf(D) });
  assert.match(replies[0]!, /memory\/a\.md 要压缩，但没有出题/);
  assert.match(replies[0]!, /exam_questions/);
  assert.match(replies[0]!, /memory\/a\.md/);
  assert.equal(replies[1], "收到，这一段交了。");
  assert.deepEqual(told, [["memory/a.md"]]);
});

test("P3: a change on an entity (t…) counts as an event-store id in the mechanical check", async () => {
  const r = rec({ files: [], changes: [chg("t0128")] });
  r.actual.memOps = 2;
  assert.deepEqual(await mechanical({ stage: peopleStage(), record: r, checks: {}, run: noRun, day: "d" }), []);
});

// ---------- 切换前 P9：没过的那一次写过事件库（批撤了），重做时编号会变：简报和交给修的人的问题都写明 ----------

test("P9: a failed attempt that wrote to the event store — the coordinator's brief and the fixer's first message say the ids will change; none when it wrote nothing", async () => {
  const IDS = "上一次写进事件库的已经撤了，重做时新建的编号会变；别按旧编号出题，按这一次新建的出";
  const run = async (ops: number) => {
    const log: string[] = [];
    const mem = { ...fakeMem(log), stageOps: (r: string) => (r.endsWith("-a-1") ? ops : 0) };
    const h = nightHost({ mem: mem as never, log, acts: { a: [(c) => { c.write("memory/a.md", "A"); c.done({ changes: [chg("memory/a.md"), ...(ops ? [chg("e0042")] : [])] }); c.end(true); }, pass()] } });
    const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], writes: ["memory/**"], memWrite: true }), script("finish", ["finish"], { after: ["a"] })]);
    const briefs: string[] = [];
    const coordinator = { async decide(b: string) { briefs.push(b); return { decision: "redo" as const, why: "按原来的编号出题", notes: [] }; }, async close() {} };
    await runnerFor(h, flow, { coordinator, validators: [verdicts({ a: [failV("出题挂不上")] })] }).runNight({ night: "n", pending: daysOf(D) });
    return { brief: briefs[0]!, fix: h.wakes[`sleep-${D}-a-2`]![0]! };
  };
  const wrote = await run(3);
  assert.ok(wrote.brief.includes(IDS), wrote.brief);
  assert.ok(wrote.fix.includes(IDS), wrote.fix);
  assert.ok(wrote.fix.includes("出题挂不上") && wrote.fix.includes("前额叶：按原来的编号出题"), "原来的问题照旧在");
  const none = await run(0);
  assert.ok(!none.brief.includes(IDS), none.brief);
  assert.ok(!none.fix.includes(IDS), none.fix);
  assert.ok(none.fix.includes("出题挂不上"));
});

test("P9: without a coordinator the redo's problems say it too", async () => {
  const log: string[] = [];
  const mem = { ...fakeMem(log), stageOps: (r: string) => (r.endsWith("-a-1") ? 2 : 0) };
  const h = nightHost({ mem: mem as never, log, acts: { a: [(c) => { c.done({ changes: [chg("e0042")] }); c.end(true); }, pass()] } });
  const flow = mk([script("prepare", ["prepare"]), agent("a", { after: ["prepare"], writes: ["memory/**"], memWrite: true }), script("finish", ["finish"], { after: ["a"] })]);
  await runnerFor(h, flow, { validators: [verdicts({ a: [failV("没过")] })] }).runNight({ night: "n", pending: daysOf(D) });
  assert.match(h.wakes[`sleep-${D}-a-2`]![0]!, /上一次写进事件库的已经撤了，重做时新建的编号会变；别按旧编号出题，按这一次新建的出/);
});

// ---------- 切换前 P10b：到 80% 的催收尾每次尝试最多一次（退回、催交、催收尾哪条路都算） ----------

test("P10b: the 80% wrap-up is said at most once per attempt — with it going out along with a bounce reminder, or before a bounce", async () => {
  const flow = p2Flow({ budget: { calls: 10 } });
  const near = (n: number) => `这一段的调用次数快到上限了（已经用了 ${n} / 10 次）`;
  // 退回 → 这一轮结束在 8 次：再说一遍退回的问题，跟催收尾一起说；第 2 轮 9 次还没交：照旧催交（不再说快到上限）；第 3 轮交对了
  const h = nightHost({ acts: { a: (c) => {
    if (c.wake === 1) { c.write("memory/a.md", "A"); c.write("memory/b.md", "B"); c.done({ changes: [chg("memory/a.md")] }); }
    if (c.wake === 3) c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] });
    c.end(true, undefined, { ...USAGE, calls: 7 + c.wake });
  } } });
  await runnerFor(h, flow).runNight({ night: "n", pending: daysOf(D) });
  const w = h.wakes[`sleep-${D}-a-1`]!;
  assert.equal(w.length, 3);
  assert.ok(w[1]!.includes("退回来了") && w[1]!.includes(near(8)), w[1]);
  assert.equal(w[2], P.SLEEP_STAGE_CONTINUE);
  assert.equal(w.filter((x) => x.includes("快到上限")).length, 1);
  // 先催收尾（8 次），再退回、这一轮结束在 9 次：只再说退回的问题
  const h2 = nightHost({ acts: { a: (c) => {
    if (c.wake === 2) { c.write("memory/a.md", "A"); c.write("memory/b.md", "B"); c.done({ changes: [chg("memory/a.md")] }); }
    if (c.wake === 3) c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] });
    c.end(true, undefined, { ...USAGE, calls: 7 + c.wake });
  } } });
  await runnerFor(h2, flow).runNight({ night: "n", pending: daysOf(D) });
  const w2 = h2.wakes[`sleep-${D}-a-1`]!;
  assert.equal(w2.length, 3);
  assert.ok(w2[1]!.startsWith(near(8)), w2[1]);
  assert.ok(w2[2]!.includes("退回来了") && !w2[2]!.includes("快到上限"), w2[2]);
  assert.deepEqual(stageRows(h2.db).filter((x) => x.stage === "a").map((x) => `${x.attempt}:${x.status}`), ["1:passed"]);
});

// ---------- 切换前 P8：核依据看上下文，核心段可以配更强的核依据 / 交叉审模型 ----------

test("P8: the audit prompt no longer says spot-checking is enough — every quote attributed to a decision, approval or reply is checked with the lines around it", () => {
  const t = P.SLEEP_AUDIT(aRec(), "diff");
  assert.doesNotMatch(t, /抽查就行/);
  for (const w of ["谁批了", "谁定了", "谁说的", "回的是哪件事", "前后", "recall"]) assert.ok(t.includes(w), w);
  assert.match(t, /逐条/);
  assert.match(t, /别的改动可以抽查/);
});

test("P8: a stage's auditModel overrides the global one for its audit session", async () => {
  const play = (s: { audit(a: AuditDone): string; turnEnd(ok: boolean): void }) => { s.audit({ verdict: "pass", problems: [] }); s.turnEnd(true); };
  const h = fakeHost([play, play]);
  const v = auditValidator(h.host, { model: "sonnet", timeoutMs: 1000 });
  await v.validate(peopleStage({ auditModel: "opus" }), "d", aRec());
  await v.validate(peopleStage(), "d", aRec());
  assert.deepEqual(h.opened.map((x) => x.model), ["opus", "sonnet"]);
});

test("P8: parseFlow takes per-stage auditModel / reviewModel and reports bad ones", () => {
  const s = mk([agent("a", { auditModel: "opus", reviewModel: "opus" }), agent("b")]).stages;
  assert.equal(s[0]!.auditModel, "opus");
  assert.equal(s[0]!.reviewModel, "opus");
  assert.equal(s[1]!.auditModel, undefined);
  assert.equal(s[1]!.reviewModel, undefined);
  let problems: string[] = [];
  try { mk([agent("a", { auditModel: "gpt", reviewModel: 3 })]); } catch (e) { problems = (e as FlowError).problems; }
  assert.ok(problems.some((p) => p.includes("auditModel")), problems.join("|"));
  assert.ok(problems.some((p) => p.includes("reviewModel")), problems.join("|"));
});

// ---------- Batch 1 修正轮（review-pre1）：退回的话、退回以后再叫醒、记账 ----------

const examPre = (problems: string[], targets: string[], times = 1): StageValidator => {
  let n = 0;
  return { name: "exam", async validate() { return { pass: true, problems: [] }; }, precheck() { n += 1; return n <= times ? { problems, targets } : { problems: [], targets: [] }; } };
};

test("pre1 M2: the bounce says the engine checked, not 我", async () => {
  const replies: string[] = [];
  const h = nightHost({ acts: { a: (c) => { c.write("memory/a.md", "A"); c.write("memory/b.md", "B"); replies.push(c.done({ changes: [chg("memory/a.md")] })); c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] }); c.end(true); } } });
  await runnerFor(h, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.match(replies[0]!, /引擎当场核对了一下/);
  assert.doesNotMatch(replies[0]!, /我当场/);
});

test("pre1 M3: the wake after a bounced turn names the targets and the exam_questions line again", async () => {
  const h = nightHost({ acts: { a: (c) => { if (c.wake === 1) c.write("memory/a.md", "A"); c.done({ changes: [chg("memory/a.md")] }); c.end(true); } } });
  await runnerFor(h, p2Flow(), { validators: [examPre(["memory/a.md 要压缩，但没有出题"], ["memory/a.md"])] }).runNight({ night: "n", pending: daysOf(D) });
  const w = h.wakes[`sleep-${D}-a-1`]!;
  assert.equal(w.length, 2);
  assert.match(w[1]!, /退回来了/);
  assert.match(w[1]!, /exam_questions/);
  assert.match(w[1]!, /只收挂在这几处上的：memory\/a\.md/);
});

test("pre1 M4: the bounce count goes into the row's verdict; a bounced hand-in taken at the session's end keeps the end reason in the row's error", async () => {
  // 退回 1 次、补交过了：verdict「过了（当场退回 1 次）」
  const h = nightHost({ acts: { a: (c) => { c.write("memory/a.md", "A"); c.write("memory/b.md", "B"); c.done({ changes: [chg("memory/a.md")] }); c.done({ changes: [chg("memory/a.md"), chg("memory/b.md")] }); c.end(true); } } });
  await runnerFor(h, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  assert.deepEqual(stageRows(h.db).filter((x) => x.stage === "a").map((x) => [x.status, x.verdict]), [["passed", "过了（当场退回 1 次）"]]);
  // 退回以后会话自己结束了（超时）：照最后交的那一次收，error 里留着为什么结束；没过的 verdict 前面写退回了几次
  const timeouts = new Map<string, { timeout(): void }>();
  const h2 = nightHost({ acts: { a: [(c) => {
    c.write("memory/a.md", "A"); c.write("memory/b.md", "B");
    c.done({ changes: [chg("memory/a.md")] });
    timeouts.get(c.id)!.timeout();
  }, pass({ "memory/a.md": "A" })] } });
  const open = h2.host.open.bind(h2.host);
  h2.host.open = (x) => {
    const s = open(x);
    let settleTimeout!: () => void;
    const settled = new Promise((r) => { settleTimeout = () => r({ how: "timeout", turns: 1, usage: { ...USAGE } }); });
    timeouts.set(x.id, { timeout: settleTimeout });
    return Object.assign(s, { settled: Promise.race([s.settled, settled]) }) as never;
  };
  await runnerFor(h2, p2Flow()).runNight({ night: "n", pending: daysOf(D) });
  const rows = all<{ attempt: number; status: string; verdict: string; error: string }>(h2.db, "SELECT attempt, status, verdict, error FROM sleep_stage WHERE stage = 'a' ORDER BY id");
  assert.equal(rows[0]!.status, "redo");
  assert.match(rows[0]!.verdict, /^当场退回 1 次；文件 memory\/b\.md 实际改了/);
  assert.match(rows[0]!.error, /超时了/);
  assert.equal(rows[1]!.verdict, "过了");
});

test("pre2 M4: the audit prompt names the recall modes that give the lines around a quote", () => {
  const t = P.SLEEP_AUDIT(aRec(), "diff");
  assert.ok(t.includes('recall ["around","<序号>"]'), t);
  assert.ok(t.includes('["day","<日期>"]'), t);
  assert.match(t, /q…/);
});
