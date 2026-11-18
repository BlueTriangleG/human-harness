// hh fix / hh deploy：她修 HH 用的命令（不经 hhd，hhd 挂了也能用）。照 skills/我自己/self/修系统.md 用。
//   hh fix check <分支> [--fix 0007 --verified "<帮手> 通过" …]   压成一个提交，看守门怎么说、测试过不过（不合并）
//   hh fix merge <分支> --fix 0007 --verified "<帮手> 通过" [--asked <编号> --owner-ok <编号> --ask-reasons k1,k2] [--test-change "<为什么>"] [--subject "<一句话>"]
//   hh deploy [<提交>]                                            部署共享 master（默认最新的），等她闲下来自己重启
//   hh fix audit [--json]                                         线上代码和部署的提交比（她本地改了什么）、仓库外敏感文件有没有在流程外变过
//   hh fix log [--days N]  /  hh fix summary
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Config } from "../config.ts";
import { GUARD_DIR, SHARED_REPO } from "./machine.ts";
import { roleEntry } from "./instances.ts";
import type { RoleEntry } from "./instances.ts";
import { localTime } from "../brainstem/clock.ts";
import { loadRules } from "./rules.ts";
import { judge } from "./gate.ts";
import { commitInfo, git } from "./git.ts";
import { evaluateRange } from "./range.ts";
import { execRunner, runChecks, squashFix } from "./check.ts";
import { underTest } from "../testGuard.ts";
import { dropLocksOf, heavyLockFrom } from "./lock.ts";
import { request } from "../control.ts";
import type { RepairRules } from "./rules.ts";
import type { HeavyLock } from "./lock.ts";
/** 全公司共用的重活锁（和 hh-guard、hh-fw、hh-parity 同一把，CEO 11-14）：放在哪、等多久照修理规则的 heavyLock，没配就不拿。
 *  测试里不拿：跑测试的工具自己就拿着这把锁，再拿只会干等（测试里的锁一律给临时目录） */
const heavyLock = (rules: RepairRules, who: string): HeavyLock | undefined => (underTest() ? undefined : heavyLockFrom(rules.heavyLock, who));
import type { Runner } from "./check.ts";
import { deploy } from "./deploy.ts";
import type { WatchArgs } from "./deploy.ts";
import { appendEvent, readDeployed, readEvents, repairDir, rolledBackRanges, summarize, waitingIds } from "./log.ts";
import { appFaults, liveDrift, sensitiveDrift, sensitivePaths, stamp } from "./audit.ts";
import type { Stamp } from "./audit.ts";
import { trusted } from "./approvals.ts";
import { B, R } from "../lang/index.ts";

export interface RepairEnv { cfg: Config; live: string; gitDir: string; checkDir: string; clone: string; guardDir: string; selfUid: number; role: RoleEntry; run?: Runner }

const RUNNING_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The live copy is the code this role's hhd runs (recorded in boot.json at start); until hhd has recorded it, the copy running this command. No path to configure: the framework code is one copy per machine */
export function liveRoot(stateDir: string): string {
  try {
    const root = (JSON.parse(readFileSync(join(repairDir(stateDir), "boot.json"), "utf8")) as { root?: unknown }).root;
    if (typeof root === "string" && root) return root;
  } catch { /* not booted with a recorded root yet */ }
  return RUNNING_ROOT;
}

export function defaultEnv(cfg: Config): RepairEnv {
  const selfUid = process.getuid?.() ?? 0;
  const role = roleEntry(GUARD_DIR, cfg.stateDir, selfUid);
  return {
    cfg, live: liveRoot(cfg.stateDir), gitDir: SHARED_REPO, guardDir: GUARD_DIR, selfUid, role,
    checkDir: role.checkDir ?? join(repairDir(cfg.stateDir), "check"), clone: role.clone ?? join(repairDir(cfg.stateDir), "src"),
  };
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function openChat(cfg: Config): DatabaseSync | null {
  const p = join(cfg.stateDir, "hh.db");
  return existsSync(p) ? new DatabaseSync(p, { readOnly: true }) : null;
}

/** 共享 master 的最新提交，取进她的克隆 */
function fetchBase(env: RepairEnv): string {
  git(env.clone, ["fetch", "-q", env.gitDir, "refs/heads/master"]);
  return git(env.clone, ["rev-parse", "FETCH_HEAD"]);
}

function fixMessage(env: RepairEnv, branch: string, args: string[]): { message: string; fix: string | null; subject: string } {
  const fixNo = option(args, "--fix");
  const fix = fixNo ? `#${fixNo.replace(/^#/, "").padStart(4, "0")}` : null;
  const subject = option(args, "--subject") ?? git(env.clone, ["log", "-1", "--format=%s", branch]);
  const trailers: Array<[string, string | undefined]> = [
    ["Fix", fix ?? undefined], ["Verified-by", option(args, "--verified")], ["Asked", option(args, "--asked")],
    // the older flag named the owner (--<name>-ok)
    ["Owner-OK", option(args, "--owner-ok") ?? option(args, args.find((a) => /^--[a-z]+-ok$/.test(a)) ?? "--owner-ok")], ["Ask-reasons", option(args, "--ask-reasons")], ["Test-change", option(args, "--test-change")],
  ];
  const tail = trailers.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join("\n");
  return { message: `fix: ${subject.replace(/^fix:\s*/, "")}${tail ? `\n\n${tail}` : ""}`, fix, subject };
}

function verdictLines(sha: string, env: RepairEnv, rules: ReturnType<typeof loadRules>): string[] {
  const v = judge(commitInfo(env.clone, sha), rules);
  if (v.outcome === "pass") return [R.cli.verdictPass];
  const head = v.outcome === "ask" ? R.cli.verdictAskOwner : R.cli.verdictFail;
  return [head, ...v.reasons.map((r) => R.cli.verdictReason(r.key, r.detail))];
}

/** Which part of a background hh fix this process is: unset, the command the role typed; "keep", the keeper; "work", the worker */
const FIX_RUN = "HH_FIX_RUN";

/**
 * hh fix check / merge run in the background (#0091, 11-18: a turn interrupted for a waiting message killed a merge in
 * the middle of the full suite; a Bash timeout would too). The command starts a keeper in a session of its own and
 * answers at once. The keeper starts the worker — this same command, doing the work as before (repairCommand) — in a
 * process group of its own. The other repair commands, and hh deploy, run in the foreground as before.
 */
export async function fixCommand(argv: string[], env: RepairEnv): Promise<string> {
  const [cmd, branch] = argv;
  const part = process.env[FIX_RUN];
  if ((cmd !== "check" && cmd !== "merge") || part === "work") return repairCommand(argv, env);
  if (!branch) throw new Error(R.cli.usageFix(cmd));
  const self = [...process.execArgv, process.argv[1]!, "fix", ...argv];
  if (part !== "keep") {
    const keeper = spawn(process.execPath, self, { detached: true, stdio: "ignore", env: { ...process.env, [FIX_RUN]: "keep" } });
    keeper.unref();
    return R.cli.fixStarted(cmd, branch, keeper.pid);
  }
  const k = keepFix({
    cmd, branch, worker: [process.execPath, self], env: { ...process.env, [FIX_RUN]: "work" }, stateDir: env.cfg.stateDir,
    locks: { heavy: heavyLockFrom(loadRules(env.live).heavyLock, "")?.path, file: join(env.checkDir, ".check.lock") },
    remind: (text) => request(join(env.cfg.stateDir, "hh.sock"), { cmd: "remind", text }),
  });
  for (const s of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(s, k.stop);
  await k.done;
  return "";
}

export interface KeepFix {
  cmd: string; branch: string; worker: [string, string[]]; env: NodeJS.ProcessEnv; stateDir: string;
  /** what the worker may be holding when it dies: the heavy lock (a takeHeavy directory) and the clone's .check.lock */
  locks: { heavy?: string; file: string };
  remind: (text: string) => Promise<unknown>;
}

/**
 * The keeper: stop() (TERM, INT or HUP to it) kills the worker's whole group at once — tsc and the tests with it,
 * nothing pushed. However the worker ends, the locks it still holds go, a line in the repair log says it ended without a
 * result if it did, and the role gets the result as her own reminder (control "remind": from nobody)
 */
export function keepFix(o: KeepFix): { done: Promise<void>; stop: (sig: NodeJS.Signals) => void } {
  const w = spawn(o.worker[0], o.worker[1], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: o.env });
  let out = "", stopped: NodeJS.Signals | undefined;
  w.stdout!.on("data", (c: Buffer) => { out += c; });
  w.stderr!.on("data", (c: Buffer) => { out += c; });
  const stop = (sig: NodeJS.Signals): void => { stopped ??= sig; try { process.kill(-w.pid!, "SIGKILL"); } catch { /* the group is gone */ } };
  const done = new Promise<void>((resolve) => w.on("close", (code, signal) => {
    const how = stopped ?? signal ?? (code === 0 ? null : `exit ${code}`);
    if (how) {
      dropLocksOf(w.pid!, o.locks);
      appendEvent(o.stateDir, { kind: "check", text: R.cli.fixEndedEvent(o.cmd, o.branch, how) });
    }
    const text = stopped ? R.cli.fixStopped(o.cmd, o.branch, stopped)
      : how ? R.cli.fixDied(o.cmd, o.branch, how, out.trim().slice(-2000)) : R.cli.fixFinished(o.cmd, o.branch, out.trim());
    o.remind(text).catch(() => { /* hhd is not up: the repair log has the end */ }).finally(resolve);
  }));
  return { done, stop };
}

export async function repairCommand(argv: string[], env: RepairEnv): Promise<string> {
  const [cmd, ...rest] = argv;
  const args = [...rest];
  // 从克隆里跑（~/hh-src/src/cli.ts）会用克隆里的守门规则、往克隆里部署：只认线上那份
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  if (real(env.live) !== real(RUNNING_ROOT)) throw new Error(R.cli.repairCommandNotLive(env.live, RUNNING_ROOT));
  const rules = loadRules(env.live);
  const run = env.run ?? execRunner;
  switch (cmd) {
    case "check":
    case "merge": {
      const branch = args.shift();
      if (!branch) throw new Error(R.cli.usageFix(cmd));
      const base = fetchBase(env);
      const m = fixMessage(env, branch, args);
      const sha = squashFix({ clone: env.clone, branch, base, message: m.message });
      const out = [R.cli.checkSquashedCommit(sha.slice(0, 7), base.slice(0, 7)), ...verdictLines(sha, env, rules)];
      const checks = runChecks(env.checkDir, env.clone, sha, run, heavyLock(rules, R.cli.checkHeavyLockLabel(cmd, branch)));
      out.push(R.cli.checkResultLine(checks.tsc.ok ? R.cli.checkTscPassed : R.cli.checkTscFailed, checks.tests.ok ? R.cli.checkTestsPassed(Math.round(checks.tests.ms / 1000)) : R.cli.checkTestsFailed));
      if (!checks.tsc.ok) out.push(checks.tsc.tail);
      if (!checks.tests.ok) out.push(checks.tests.tail);
      const db = openChat(env.cfg);
      let range;
      try { range = evaluateRange({ dir: env.clone, from: base, to: sha, rules, guardDir: env.guardDir, selfUid: env.selfUid, db, owner: env.role.owner, rollbacks: rolledBackRanges(env.cfg.stateDir) }); } finally { db?.close(); }
      const item = range.items[0];
      const ready = range.ok && checks.tsc.ok && checks.tests.ok;
      if (cmd === "check") {
        out.push(ready ? R.cli.checkMergeReady : R.cli.checkMergeMissing(item?.why ?? R.cli.checkBlockerFallback));
        appendEvent(env.cfg.stateDir, { kind: "check", ...(m.fix ? { fix: m.fix } : {}), to: sha, text: R.cli.checkEventText(m.subject, ready ? R.cli.checkEventCanMerge : R.cli.checkEventCannotMerge) });
        return out.join("\n");
      }
      if (!ready) { out.push(R.cli.mergeRefused(item?.via === "blocked" ? item.why : R.cli.mergeBlockedFallback)); return out.join("\n"); }
      try { git(env.clone, ["push", "-q", env.gitDir, `${sha}:refs/heads/master`]); } catch (e) {
        out.push(R.cli.mergePushFailed(String(e).slice(0, 200)));
        return out.join("\n");
      }
      appendEvent(env.cfg.stateDir, { kind: "merge", by: R.cli.mergeEventBy, ...(m.fix ? { fix: m.fix } : {}), from: base, to: sha, text: m.subject });
      out.push(R.cli.mergeDone(sha.slice(0, 7)));
      return out.join("\n");
    }
    case "deploy": {
      const target = args[0] ?? git(env.gitDir, ["rev-parse", "refs/heads/master"]);
      const by = process.env.HH_DEPLOY_BY ?? R.cli.deployByDefault;
      const heavy = heavyLock(rules, R.cli.deployHeavyLockLabel(target.slice(0, 7), by));
      const res = deploy({
        live: env.live, stateDir: env.cfg.stateDir, gitDir: env.gitDir, checkDir: env.checkDir, guardDir: env.guardDir, target,
        by, selfUid: env.selfUid, dbPath: join(env.cfg.stateDir, "hh.db"), rules, owner: env.role.owner, authorEmail: env.role.author.email, user: env.role.user, ...(heavy ? { heavy } : {}),
      }, { run, now: Date.now, spawnWatchdog: (a) => spawnWatchdog(a) });
      return res.text;
    }
    case "audit": {
      const json = args.includes("--json");
      const deployed = readDeployed(env.cfg.stateDir);
      const live = deployed ? liveDrift(env.gitDir, env.live, deployed.commit) : [];
      const basePath = join(env.guardDir, "baseline", "sensitive.json");
      const now = stamp(sensitivePaths(env.cfg.workspace, env.cfg.stateDir, env.role.owner.name));
      let sensitive: Array<{ path: string; was: string; now: string }> = [];
      let note = "";
      if (trusted(env.guardDir, env.selfUid) && trusted(join(env.guardDir, "baseline"), env.selfUid) && trusted(basePath, env.selfUid)) {
        sensitive = sensitiveDrift(JSON.parse(readFileSync(basePath, "utf8")) as Stamp[], now);
      } else note = R.cli.auditNoTrustedBaseline;
      // the role's app (macOS): still the one built and signed for it; a role with no app has nothing to check
      const appAt = env.cfg.launchd?.app;
      const app = appAt ? appFaults(appAt, env.cfg.id, env.cfg.stateDir, env.selfUid) : [];
      const FAULT = { missing: R.cli.auditAppMissing, unsigned: R.cli.auditAppUnsigned, identity: R.cli.auditAppIdentity, signer: R.cli.auditAppSigner, bundle: R.cli.auditAppBundle, launcher: R.cli.auditAppLauncher };
      const appNote = app.length ? R.cli.auditAppFaults(`ai.hh.role.${env.cfg.id}`, app.map((x) => FAULT[x]).join(B.common.listSep)) : "";
      const parts = [
        ...(deployed ? [] : [R.cli.auditNoDeployRecord]),
        // the role's own edits: not a fault — listed once with where they stand, the next deploy keeps them on a branch
        ...(live.length && deployed ? [R.cli.auditLocalEdits(live.length, deployed.commit.slice(0, 7), live.slice(0, 10).map((d) => R.cli.auditLiveFile(d.path, d.how === "changed" ? R.cli.auditFileChanged : d.how === "missing" ? R.cli.auditFileMissing : R.cli.auditFileExtra)).join(B.common.listSep) + (live.length > 10 ? B.common.listSep + "…" : ""))] : []),
        ...sensitive.map((s) => R.cli.auditSensitiveChanged(s.path, s.was, s.now)),
        ...(appNote ? [appNote] : []),
      ];
      if (parts.length) appendEvent(env.cfg.stateDir, { kind: "audit", text: parts.join(B.common.listSep) });
      if (json) return JSON.stringify({ deployed: deployed?.commit ?? null, live, sensitive, note, app, appNote }, null, 2);
      return [parts.length ? parts.join("\n") : R.cli.auditClean, note].filter(Boolean).join("\n");
    }
    case "log": {
      const days = Number(option(args, "--days") ?? 3);
      return readEvents(env.cfg.stateDir, Date.now() - days * 86_400_000).map((e) => `${e.t.slice(0, 16)} ${e.kind}${e.fix ? ` ${e.fix}` : ""} ${e.text}`).join("\n") || R.cli.logEmpty;
    }
    case "summary": {
      const today = localTime(Date.now(), env.cfg.schedule.timezone).day;
      const ev = readEvents(env.cfg.stateDir, Date.now() - 2 * 86_400_000).filter((e) => localTime(Date.parse(e.t), env.cfg.schedule.timezone).day < today);
      return summarize(ev, waitingIds(env.cfg.workspace)) || R.cli.summaryEmpty;
    }
    default: throw new Error(R.cli.usageUnknownCommand(cmd ?? ""));
  }
}

/** 看守用部署前拷出来的那份（旧版本），单独跑、不跟着命令行退出。起完等它写下 watchdog.pid（最多 15 秒：机器忙时 node 起一个脚本就要好几秒，等短了会误报）：没写下就是没起来，当场报，不等她重启才发现 */
function spawnWatchdog(a: WatchArgs): string | void {
  const script = join(repairDir(a.stateDir), "watchdog.ts");
  if (!existsSync(script)) { appendEvent(a.stateDir, { kind: "watch", to: a.target, text: R.cli.spawnWatchdog }); return; }
  const child = spawn(process.execPath, [script, JSON.stringify(a)], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  const pidFile = join(repairDir(a.stateDir), "watchdog.pid");
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 60; i++) {
    try { if ((JSON.parse(readFileSync(pidFile, "utf8")) as { pid?: number; target?: string }).pid === child.pid) return; } catch { /* not yet */ }
    Atomics.wait(nap, 0, 0, 250);
  }
  appendEvent(a.stateDir, { kind: "watch", to: a.target, text: R.cli.watchdogDown });
  return R.cli.watchdogDown;
}
