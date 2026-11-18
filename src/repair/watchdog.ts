// 看守：部署时从旧版本拷出来、单独跑（只用 node 自带的东西，新代码坏了它也得能跑）。
// 等 hhd 为这次部署重启；重启后起不来、或者起来了跑不稳，就退回上一版：线上放回旧代码、共享 master 上加一个还原提交、告诉主人。
// 用法（部署脚本起的）：node watchdog.ts '<WatchArgs 的 JSON>'
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface WatchArgs {
  live: string; stateDir: string; gitDir: string; prev: string; target: string; deployedAt: number;
  /** what the watchdog says, rendered by the deploy from the language pack (a hole is \u0001<n>): this copy runs on its own and imports nothing local */
  text: Record<string, string>;
  /** the revert's author email (marks the role's own commits) and whom a rollback tells: from the machine's role table, via the deploy */
  authorEmail: string;
  notify: string;
  /** turnWaitMs：跑稳以后再等多久看第一轮真跑完（没有就不等，旧配置） */
  rules: { restartWaitMs: number; bootTimeoutMs: number; healthyMs: number; healthyTicks: number; turnWaitMs?: number };
}
/** One of the watchdog's sentences with its holes filled */
const say = (a: WatchArgs, key: string, ...args: unknown[]): string => (a.text[key] ?? key).replace(/\u0001(\d)/g, (_, i: string) => String(args[Number(i)]));

export interface WatchIO { read: (p: string) => string | null; now: () => number; sleep: (ms: number) => Promise<void>; rollback: (a: WatchArgs, why: string) => void }

const POLL_MS = 10_000;
const TURN_POLL_MS = 60_000;

function json<T>(io: WatchIO, p: string): T | null {
  const s = io.read(p);
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

export async function watch(a: WatchArgs, io: WatchIO): Promise<"healthy" | "rolled-back" | "gave-up"> {
  const dir = join(a.stateDir, "repair");
  const mark = (name: string, since: number) => {
    const m = json<{ commit: string | null; t: string }>(io, join(dir, name));
    return m && m.commit === a.target && Date.parse(m.t) >= since ? m : null;
  };
  const superseded = () => json<{ commit: string }>(io, join(dir, "deployed.json"))?.commit !== a.target;
  // 第一段：等 hhd 为这次部署重启（她可能忙很久）。崩了、重启电脑、别人手工重启，新代码直接起来了也算；被更新的部署接手了就不管了
  let restartAt: number | null = null;
  while (restartAt === null) {
    if (superseded()) return "gave-up";
    const r = mark("restarting.json", a.deployedAt - 60_000) ?? mark("boot.json", a.deployedAt - 60_000);
    if (r) { restartAt = Date.parse(r.t); break; }
    if (io.now() - a.deployedAt > a.rules.restartWaitMs) return "gave-up";
    await io.sleep(POLL_MS);
  }
  // 第二段：重启后要起来、要跑稳
  while (!mark("boot.json", restartAt)) {
    if (superseded()) return "gave-up";
    if (io.now() - restartAt > a.rules.bootTimeoutMs) {
      io.rollback(a, say(a, "rollbackBootTimedOut", Math.round(a.rules.bootTimeoutMs / 60_000)));
      return "rolled-back";
    }
    await io.sleep(POLL_MS);
  }
  const sick = () => mark("sick.json", restartAt);
  while (!mark("healthy.json", restartAt)) {
    if (superseded()) return "gave-up";
    if (sick()) { io.rollback(a, say(a, "rollbackFailingFromStart")); return "rolled-back"; }
    if (io.now() - restartAt > a.rules.bootTimeoutMs + a.rules.healthyMs + 60_000) {
      io.rollback(a, say(a, "rollbackNeverSettled"));
      return "rolled-back";
    }
    await io.sleep(POLL_MS);
  }
  // 第三段：她闲着才重启，第一轮可能要等很久；等到一轮真跑完才算数，开头几轮都坏了就退回，一直没人说话等够了也算
  if (!a.rules.turnWaitMs) return "healthy";
  while (!mark("proven.json", restartAt)) {
    if (superseded()) return "gave-up";
    if (sick()) { io.rollback(a, say(a, "rollbackStableThenFailing")); return "rolled-back"; }
    if (io.now() - restartAt > a.rules.turnWaitMs) return "healthy";
    await io.sleep(TURN_POLL_MS);
  }
  return "healthy";
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).replace(/\n$/, "");
}

function treePaths(gitDir: string, sha: string): Set<string> {
  return new Set(git(gitDir, ["ls-tree", "-r", "--name-only", "-z", sha]).split("\0").filter(Boolean));
}

function event(stateDir: string, e: Record<string, unknown>): void {
  mkdirSync(join(stateDir, "repair"), { recursive: true });
  appendFileSync(join(stateDir, "repair", "log.jsonl"), JSON.stringify({ t: new Date().toISOString(), ...e }) + "\n");
}

/** 共享 master 上还原 prev..target（别人之后推的保留）；成功返回还原提交，做不了返回原因 */
function revertOnMaster(a: WatchArgs, why: string): string {
  const wt = mkdtempSync(join(tmpdir(), "hh-revert-"));
  rmSync(wt, { recursive: true, force: true });
  const id = ["-c", say(a, "revertGitName"), "-c", `user.email=${a.authorEmail}`];
  try {
    for (let i = 0; i < 3; i++) {
      const head = git(a.gitDir, ["rev-parse", "refs/heads/master"]);
      git(a.gitDir, ["worktree", "add", "-q", "--detach", wt, head]);
      try {
        const r = spawnSync("git", ["-C", wt, ...id, "revert", "--no-commit", `${a.prev}..${a.target}`], { encoding: "utf8" });
        if (r.status !== 0) return say(a, "revertConflict", (r.stderr || r.stdout).slice(0, 200));
        if (!git(wt, ["status", "--porcelain"])) return "master 上已经还原过了";
        const msg = say(a, "revertCommitMessage", a.prev.slice(0, 7), a.target.slice(0, 7), why, a.target, a.prev, a.target);
        execFileSync("git", ["-C", wt, ...id, "commit", "-q", "-F", "-"], { input: msg });
        const sha = git(wt, ["rev-parse", "HEAD"]);
        try { git(a.gitDir, ["update-ref", "refs/heads/master", sha, head]); return sha; } catch { /* 刚好有人推了：重来 */ }
      } finally {
        try { git(a.gitDir, ["worktree", "remove", "--force", wt]); } catch { rmSync(wt, { recursive: true, force: true }); }
      }
    }
    return say(a, "revertMasterMoving");
  } catch (e) { return say(a, "revertError", String(e).slice(0, 200)); }
}

/** 停掉某个线上进程（launchd KeepAlive 会用线上现在的代码拉起来） */
/**
 * Stop this role's hhd or console (launchd brings it back on the code now live). The process is found by the pid its own state
 * directory records — repair/boot.json for hhd, repair/console.json for the console — never by user and script path, which another
 * role under the same account shares. The signal goes only if that pid's process started no later than the record was written
 * (a pid reused by a newer process started later). No record, nothing to stop.
 */
function stop(a: WatchArgs, which: "hhd" | "console" | "bridges"): void {
  if (which !== "bridges") return stopByRecord(a.stateDir, which);
  // every channel bridge this role recorded (restart.ts bridgeRecords; copied here, the watchdog imports nothing of HH)
  for (const f of readdirSync(join(a.stateDir, "repair")).filter((f) => /^bridge-[\w-]+\.json$/.test(f))) stopByRecord(a.stateDir, f as `bridge-${string}.json`);
}

export function stopByRecord(stateDir: string, which: "hhd" | "console" | `bridge-${string}.json`): void {
  const rec = readJsonFile<{ pid?: number; t?: string }>(join(stateDir, "repair", which === "hhd" ? "boot.json" : which === "console" ? "console.json" : which));
  if (!rec?.pid || !rec.t) return;
  try {
    const started = Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(rec.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim());
    // ps gives whole seconds: allow the second the record was written in
    if (Number.isFinite(started) && started <= Date.parse(rec.t) + 1000) process.kill(rec.pid, "SIGTERM");
  } catch { /* not running */ }
}

/** 换 node_modules：线上的挪进 keep（keep 先清空），from 里的挪进线上。只是两次改名，hhd 已经载入的模块不受影响 */
export function swapModules(live: string, from: string, keep: string): void {
  rmSync(keep, { recursive: true, force: true });
  mkdirSync(keep, { recursive: true });
  if (existsSync(join(live, "node_modules"))) renameSync(join(live, "node_modules"), join(keep, "node_modules"));
  renameSync(join(from, "node_modules"), join(live, "node_modules"));
}

function readJsonFile<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

/** 还原没推上 master：记下来，还原提交进 master 之前部署会拦着这些提交 */
function hold(a: WatchArgs, why: string): void {
  const p = join(a.stateDir, "repair", "held.json");
  const held = readJsonFile<Array<{ prev: string; target: string; t: string; why: string }>>(p) ?? [];
  held.push({ prev: a.prev, target: a.target, t: new Date().toISOString(), why });
  writeFileSync(p, JSON.stringify(held, null, 2) + "\n");
}

function tell(a: WatchArgs, text: string): void {
  if (process.env.HH_REPAIR_NO_SEND === "1") return;
  try {
    execFileSync(process.execPath, [join(a.live, "src", "cli.ts"), "send", a.notify, say(a, "notifyOwnerRollback", text)], { cwd: a.live, timeout: 60_000, stdio: "ignore" });
  } catch { event(a.stateDir, { kind: "rollback", by: "watchdog", text: say(a, "notifySendFailed") }); }
}

function realNpm(dir: string): boolean {
  return spawnSync("npm", ["ci", "--omit=dev"], { cwd: dir, stdio: "ignore", timeout: 20 * 60_000 }).status === 0;
}

/** npm：装依赖；stop：停掉线上某个进程（测试里换成记下来） */
export interface RollbackDeps { npm: (dir: string) => boolean; stop?: (which: "hhd" | "console" | "bridges") => void }

export function realRollback(a: WatchArgs, why: string, deps: RollbackDeps = { npm: realNpm }): void {
  try { rollbackSteps(a, why, deps); } catch (e) {
    const text = say(a, "rollbackFailed", a.prev.slice(0, 7), a.target.slice(0, 7), why, String(e).slice(0, 300));
    try { event(a.stateDir, { kind: "rollback", by: "watchdog", from: a.target, to: a.prev, text }); } catch { /* 连日志都写不了 */ }
    tell(a, text);
  }
}

function rollbackSteps(a: WatchArgs, why: string, deps: RollbackDeps): void {
  const notes: string[] = [];
  const halt = deps.stop ?? ((which: "hhd" | "console" | "bridges") => stop(a, which));
  const blob = (sha: string, p: string) => { try { return git(a.gitDir, ["rev-parse", `${sha}:${p}`]); } catch { return null; } };
  // 线上放回旧版本
  const tar = execFileSync("git", ["-C", a.gitDir, "archive", a.prev], { maxBuffer: 512 * 1024 * 1024 });
  const x = spawnSync("tar", ["-x", "-C", a.live], { input: tar });
  if (x.status !== 0) notes.push(say(a, "rollbackExtractFailed", String(x.stderr).slice(0, 200)));
  const old = treePaths(a.gitDir, a.prev);
  const fresh = treePaths(a.gitDir, a.target);
  for (const p of fresh) if (!old.has(p) && existsSync(join(a.live, p))) unlinkSync(join(a.live, p));
  const prevLock = blob(a.prev, "package-lock.json");
  if (prevLock !== blob(a.target, "package-lock.json")) {
    // 部署时换下来的旧依赖还在、正好是 prev 的：换回来，不用重装
    const keep = `${a.live}.npm-prev`;
    const kept = (() => { try { return readFileSync(join(keep, "lock"), "utf8").trim(); } catch { return null; } })();
    if (existsSync(join(keep, "node_modules")) && kept === (prevLock ?? "none")) { swapModules(a.live, keep, `${a.live}.npm-next`); notes.push(say(a, "rollbackDepsSwapped")); }
    else notes.push(deps.npm(a.live) ? say(a, "rollbackDepsReinstalled") : say(a, "rollbackDepsNotRestored"));
  }
  const repair = join(a.stateDir, "repair");
  const restarting = readJsonFile<{ commit: string; snapshot?: string }>(join(repair, "restarting.json"));
  const neverBooted = readJsonFile<{ commit: string }>(join(repair, "boot.json"))?.commit !== a.target;
  const wasHealthy = readJsonFile<{ commit: string }>(join(repair, "healthy.json"))?.commit === a.target;
  writeFileSync(join(a.stateDir, "repair", "deployed.json"), JSON.stringify({ commit: a.prev, prev: a.target, t: new Date().toISOString(), by: "watchdog" }, null, 2) + "\n");
  // 带迁移、新版本还没跑稳：数据库换回重启那一刻的备份（新版本写过的那份挪到旁边留着）。跑稳过的不换：她已经在新库里记了东西。
  // 先停 hhd，换好再停一次（换的时候 launchd 可能已经拉起了一个）
  const snap = restarting?.commit === a.target ? restarting.snapshot : undefined;
  if (snap && !wasHealthy && existsSync(snap)) {
    halt("hhd");
    const db = join(a.stateDir, "hh.db");
    const aside = `${db}.rolled-back-${a.target.slice(0, 7)}`;
    copyFileSync(snap, `${db}.restore`);
    if (!neverBooted) for (const s of ["", "-wal", "-shm"]) if (existsSync(db + s)) renameSync(db + s, aside + s);
    renameSync(`${db}.restore`, db);
    for (const s of ["-wal", "-shm"]) if (existsSync(db + s)) unlinkSync(db + s);
    notes.push(neverBooted ? say(a, "rollbackDbRestored") : say(a, "rollbackDbRestoredKeepNew", basename(aside)));
  } else if (snap && wasHealthy) notes.push(say(a, "rollbackDbNotRestored"));
  halt("hhd");
  // 控制台每次都跟着停（launchd 用放回去的代码拉起来）：它引用了 src/console/ 以外的很多模块，和部署时一样不只看 src/console/
  halt("console");
  // the channel bridges too: they run HH's channel code (src/channels/, the language pack)
  halt("bridges");
  const rev = revertOnMaster(a, why);
  if (/^[0-9a-f]{40}$/.test(rev)) notes.push(say(a, "rollbackRevertCommitted", rev.slice(0, 7)));
  else {
    notes.push(rev);
    if (rev !== "master 上已经还原过了") { hold(a, rev); notes.push(say(a, "rollbackRangeHeld")); }
  }
  const text = say(a, "rollbackDone", a.prev.slice(0, 7), a.target.slice(0, 7), why, notes.join("；"));
  event(a.stateDir, { kind: "rollback", from: a.target, to: a.prev, by: "watchdog", text });
  tell(a, text);
}

const realIO: WatchIO = {
  read: (p) => { try { return readFileSync(p, "utf8"); } catch { return null; } },
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rollback: realRollback,
};

// Started as the program (not imported by the deploy or a test). node names the program by its real path, so a copy
// reached through a symlink (a state dir on another disk, under /tmp) is compared by its real path too: compared as
// given, it took itself for an import and exited without watching anything.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const a = JSON.parse(process.argv[2] ?? "{}") as WatchArgs;
  const dir = join(a.stateDir, "repair");
  // 进程号留给 hhd 看：起来时看守不在了（重启过电脑）就再叫一个
  writeFileSync(join(dir, "watchdog.pid"), JSON.stringify({ pid: process.pid, target: a.target }) + "\n");
  let outcome: Awaited<ReturnType<typeof watch>> | "error" = "error";
  try {
    outcome = await watch(a, realIO);
    // 跑稳了 hhd 自己记、退回了 realRollback 记；这里只记「没等到」
    if (outcome === "gave-up") event(a.stateDir, { kind: "watch", to: a.target, by: "watchdog", text: say(a, "watchGaveUp") });
  } catch (e) {
    event(a.stateDir, { kind: "watch", to: a.target, by: "watchdog", text: say(a, "watchFailed", String(e).slice(0, 300)) });
  } finally {
    // 有了结果（跑稳、退回）就不用再叫看守；等太久走的留着 watch.json，hhd 下次起来再叫
    if (outcome === "healthy" || outcome === "rolled-back") {
      if (readJsonFile<{ target: string }>(join(dir, "watch.json"))?.target === a.target) rmSync(join(dir, "watch.json"), { force: true });
    }
    if (readJsonFile<{ pid: number }>(join(dir, "watchdog.pid"))?.pid === process.pid) rmSync(join(dir, "watchdog.pid"), { force: true });
  }
}
