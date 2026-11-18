// The check: in the role's own checking clone, the commit to look at is checked out, type-checked and fully tested; the
// role's repair branch is squashed into one commit. The shared repository's code always runs as the role's account (the
// owner's account never runs code the role wrote).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { takeHeavy, takeLock } from "./lock.ts";
import type { HeavyLock } from "./lock.ts";
import { repairDir } from "./log.ts";
import type { RepairRules } from "./rules.ts";
import { R } from "../lang/index.ts";

export type Runner = (cmd: string, args: string[], cwd: string) => { code: number; out: string; ms: number };
/** mode：全套是怎么跑的（testCommand 给的）；类型检查和没跑成的没有 */
export interface TestRun { ok: boolean; ms: number; tail: string; mode?: string }

export const execRunner: Runner = (cmd, args, cwd) => {
  const t0 = Date.now();
  // 测试跑在干净的环境里：她的 HH_CONFIG（真配置、真发消息）不能漏进去；npm/npx 用跑 hh 的这个 node（sudo 过来的 PATH 是主人账号的）
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("HH_")));
  env.PATH = `${dirname(process.execPath)}:${env.PATH ?? "/usr/bin:/bin"}`;
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 20 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`, ms: Date.now() - t0 };
};

const tail = (s: string) => s.trimEnd().split("\n").slice(-30).join("\n");

function lockHash(dir: string): string {
  try { return createHash("sha256").update(readFileSync(join(dir, "package-lock.json"))).digest("hex"); } catch { return "none"; }
}

/**
 * 检查时怎么跑全套（11-14：部署时 npm test 同时开 9 个子进程，1.2 GB 挤进交换区，hhd 卡了 10 秒）：
 * 要看的那个提交的 package.json 有 "test:quiet"（少开并发）就跑它；老提交没有这个脚本就照旧 npm test。
 * 不套 macOS 的后台优先级（taskpolicy -b）：11-14 实测它把每条测试拖慢约 7 倍（全套 403 秒），带超时的测试（5 秒、20 秒那些）会被拖超时，部署又被拒。
 * mode 记进部署基准：「测试明显变慢」只跟同一种跑法比（脚本一改 mode 就变）
 */
export function testCommand(checkDir: string): { cmd: string; args: string[]; mode: string } {
  let script: unknown;
  try { script = (JSON.parse(readFileSync(join(checkDir, "package.json"), "utf8")) as { scripts?: Record<string, unknown> }).scripts?.["test:quiet"]; } catch { /* 没有 package.json */ }
  if (typeof script !== "string" || !script.trim()) return { cmd: "npm", args: ["test"], mode: "npm test" };
  return { cmd: "npm", args: ["run", "test:quiet"], mode: `test:quiet ${createHash("sha256").update(script).digest("hex").slice(0, 12)}` };
}

/** source = 提交所在的仓库（她的克隆或共享仓库）；sha 可以是没挂在分支上的提交。检查用的克隆同一时间只给一个检查用 */
/** busy：没跑成，因为在等别人（检查克隆、重活锁），照实说在等谁 */
export interface Checks { tsc: TestRun; tests: TestRun; busy?: string }

/** heavy：跑类型检查和全套前先拿全公司的重活锁（hh deploy、hh fix check 给；测试不给，不碰线上那把锁） */
export function runChecks(checkDir: string, source: string, sha: string, run: Runner, heavy?: HeavyLock): Checks {
  const bad = (out: string): TestRun => ({ ok: false, ms: 0, tail: tail(out) });
  const release = takeLock(join(checkDir, ".check.lock"), 60 * 60_000);
  if (!release) { const why = R.check.checkCloneBusy; const busy = bad(why); return { tsc: busy, tests: busy, busy: why }; }
  try { return checkLocked(checkDir, source, sha, run, bad, heavy); } finally { release(); }
}

function checkLocked(checkDir: string, source: string, sha: string, run: Runner, bad: (out: string) => TestRun, heavy?: HeavyLock): Checks {
  const f = run("git", ["fetch", source, sha], checkDir);
  if (f.code !== 0) return { tsc: bad(f.out), tests: bad(f.out) };
  const c = run("git", ["checkout", "--detach", sha], checkDir);
  if (c.code !== 0) return { tsc: bad(c.out), tests: bad(c.out) };
  const lock = lockHash(checkDir);
  let stamp = "";
  try { stamp = readFileSync(join(checkDir, ".lock-stamp"), "utf8").trim(); } catch { /* 第一次 */ }
  if (stamp !== lock) {
    const i = run("npm", ["ci"], checkDir);
    if (i.code !== 0) return { tsc: bad(i.out), tests: bad(i.out) };
    writeFileSync(join(checkDir, ".lock-stamp"), lock + "\n");
  }
  const hv = heavy ? takeHeavy(heavy) : null;
  if (hv && "waitingFor" in hv) {
    const w = heavy!.waitMs >= 60_000 ? R.check.checkWaitMinutes(Math.round(heavy!.waitMs / 60_000)) : R.check.checkWaitSeconds(Math.round(heavy!.waitMs / 1000));
    const why = R.check.checkHeavyLockTimedOut(w, hv.waitingFor);
    return { tsc: bad(why), tests: bad(why), busy: why };
  }
  try {
    const t = run("npx", ["tsc", "--noEmit"], checkDir);
    const how = testCommand(checkDir);
    const n = run(how.cmd, how.args, checkDir);
    return { tsc: { ok: t.code === 0, ms: t.ms, tail: tail(t.out) }, tests: { ok: n.code === 0, ms: n.ms, tail: tail(n.out), mode: how.mode } };
  } finally {
    if (hv) hv.release();
  }
}

export function testsSlower(ms: number, baseMs: number | null, r: RepairRules["tests"]): boolean {
  return baseMs !== null && ms > baseMs * r.slowerRatio && ms - baseMs > r.slowerMinMs;
}

export interface Bench { sha: string; ms: number; /** 那次全套是怎么跑的（testCommand 的 mode）；11-14 以前的记录没有，算 npm test */ mode?: string }

/** 上一次部署时测试跑了多久（拿来比「明显变慢」）。给了 mode 就只要同一种跑法的：换了跑法，时长没法比，当作没有基准 */
export function readBench(stateDir: string, mode?: string): Bench | null {
  let b: Bench;
  try { b = JSON.parse(readFileSync(join(stateDir, "repair", "bench.json"), "utf8")) as Bench; } catch { return null; }
  if (mode !== undefined && (b.mode ?? "npm test") !== mode) return null;
  return b;
}
export function writeBench(stateDir: string, b: Bench): void {
  writeFileSync(join(repairDir(stateDir), "bench.json"), JSON.stringify(b) + "\n");
}

/** 她的修理分支在 base 上压成一个提交（共享 master 上一条毛病一个提交），返回新提交。在临时工作区里做，不动她克隆里正在改的东西 */
export function squashFix(o: { clone: string; branch: string; base: string; message: string }): string {
  const tmp = mkdtempSync(join(tmpdir(), "hh-squash-"));
  const wt = join(tmp, "wt");
  try {
    git(o.clone, ["worktree", "add", "-q", "--detach", wt, o.base]);
    try {
      git(wt, ["merge", "--squash", o.branch]);
      git(wt, ["commit", "-q", "--allow-empty", "-F", "-"], o.message);
      return git(wt, ["rev-parse", "HEAD"]);
    } finally {
      git(o.clone, ["worktree", "remove", "--force", wt]);
    }
  } finally {
    // worktree remove 只删 wt，外面 mkdtemp 建的这层也删掉（工作区没建成时也删，#0055）
    rmSync(tmp, { recursive: true, force: true });
  }
}
