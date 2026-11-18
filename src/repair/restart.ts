// 部署后的重启：hhd 自己挑她闲着的时候退出（launchd 的 KeepAlive 马上拉起新版本），不在她回话时把自己杀掉。
// 起来以后记 boot、跑稳了记 healthy，给看守看。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localTime, parseHM } from "../brainstem/clock.ts";
import { DatabaseSync } from "node:sqlite";
import { alive } from "./lock.ts";
import type { BrainStatus } from "../brain.ts";
import { appendEvent, readDeployed, repairDir } from "./log.ts";
import { liveDrift } from "./audit.ts";
import type { RepairRules } from "./rules.ts";
import { R } from "../lang/index.ts";

/** 平静 = 没睡、没在翻页、没有脑区在忙、前台没在准备或压着消息、不在专注时段、不在夜里整理那一段（和以前手工重启的规矩一样） */
export function calmNow(s: Pick<BrainStatus, "alertness" | "turning" | "regions" | "focusSlot" | "frontIdle">, now: number, tz: string, quiet: [string, string]): boolean {
  if (s.alertness === "asleep" || s.turning || !s.frontIdle || s.focusSlot !== null || s.regions.some((r) => r.busy)) return false;
  const m = localTime(now, tz).minutes;
  return !(m >= parseHM(quiet[0]) && m < parseHM(quiet[1]));
}

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}

/** 重启那一刻的数据库备份：hhd 停下大脑之后、关库之前做，带迁移的版本起不来时看守用它恢复 */
export function snapshotDb(db: DatabaseSync, path: string): void {
  if (existsSync(path)) unlinkSync(path);
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`);
}

/**
 * 带迁移的部署没经过「闲下来重启」就起来了（崩了、重启电脑、手工重启）：hhd 开库迁移之前先备份，记进 restarting.json 给看守。
 * 只在这个进程跑的就是那次部署的提交时做；返回备份路径。
 */
export function snapshotAtBoot(stateDir: string, dbPath: string, bootCommit: string | null): string | null {
  const dir = join(stateDir, "repair");
  const req = readJson<{ commit: string; migration?: boolean }>(join(dir, "restart-request.json"));
  if (!req?.migration || !bootCommit || req.commit !== bootCommit || !existsSync(dbPath)) return null;
  const path = join(dir, `hh.db.before-${req.commit.slice(0, 7)}`);
  const db = new DatabaseSync(dbPath);
  try { snapshotDb(db, path); } finally { db.close(); }
  const t = new Date().toISOString();
  writeFileSync(join(repairDir(stateDir), "restarting.json"), JSON.stringify({ commit: req.commit, t, snapshot: path }) + "\n");
  appendEvent(stateDir, { kind: "restart", to: req.commit, text: R.restart.snapshotAtBoot, t });
  return path;
}

export class RestartGate {
  private calmTicks = 0;
  /** 这次重启要做的数据库备份（部署带迁移时才有） */
  snapshot: string | null = null;
  private readonly o: { stateDir: string; rules: RepairRules; tz: string; now: () => number; restartConsole?: () => void; bootCommit?: string | null };
  /** bootCommit：这个进程起来时线上的提交（markBoot 的返回值）；请求的就是它，说明已经是新版本了，不用再重启 */
  constructor(o: { stateDir: string; rules: RepairRules; tz: string; now: () => number; restartConsole?: () => void; bootCommit?: string | null }) { this.o = o; }

  /** s: her status, or how to get it; only a deploy waiting for her to be calm reads it (hhd ticks every 30 s) */
  tick(s: BrainStatus | (() => BrainStatus)): "restart" | null {
    const dir = join(this.o.stateDir, "repair");
    const req = readJson<{ commit: string; migration?: boolean }>(join(dir, "restart-request.json"));
    if (req && this.o.bootCommit && req.commit === this.o.bootCommit) {
      unlinkSync(join(dir, "restart-request.json"));
      appendEvent(this.o.stateDir, { kind: "restart", to: req.commit, text: R.restart.restartAlreadyRunning });
      this.consoleRestart();
      this.calmTicks = 0;
      return null;
    }
    if (!req || req.commit !== readDeployed(this.o.stateDir)?.commit) { this.calmTicks = 0; return null; }
    this.calmTicks = calmNow(typeof s === "function" ? s() : s, this.o.now(), this.o.tz, this.o.rules.restart.quiet) ? this.calmTicks + 1 : 0;
    if (this.calmTicks < this.o.rules.restart.calmChecks) return null;
    const t = new Date(this.o.now()).toISOString();
    unlinkSync(join(dir, "restart-request.json"));
    this.snapshot = req.migration ? join(dir, `hh.db.before-${req.commit.slice(0, 7)}`) : null;
    writeFileSync(join(repairDir(this.o.stateDir), "restarting.json"), JSON.stringify({ commit: req.commit, t, ...(this.snapshot ? { snapshot: this.snapshot } : {}) }) + "\n");
    appendEvent(this.o.stateDir, { kind: "restart", to: req.commit, text: R.restart.restartWhenIdle, t });
    this.consoleRestart();
    return "restart";
  }

  private consoleRestart(): void {
    const p = join(this.o.stateDir, "repair", "console-restart.json");
    if (!existsSync(p)) return;
    unlinkSync(p);
    try { this.o.restartConsole?.(); } catch { /* 控制台起不来不影响她 */ }
  }
}

/** 记下这个进程起来了；返回起来时线上的提交（之后部署了别的，这个进程跑的还是它） */
/**
 * root: the code hhd is running from — the repair commands treat it as the live copy (see liveRoot in cli.ts). With gitDir, also
 * whether that copy is the deployed commit as it was: tree { head, dirty } — dirty counts the files `git status` would list (liveDrift);
 * the role may edit its own copy, so this is only a record. tree: null when it could not be checked
 */
export function markBoot(stateDir: string, pid: number, root?: string, gitDir?: string): string | null {
  const commit = readDeployed(stateDir)?.commit ?? null;
  const t = new Date().toISOString();
  let tree: { head: string; dirty: number } | null | undefined;
  if (commit && root && gitDir) try { tree = { head: commit, dirty: liveDrift(gitDir, root, commit).length }; } catch { tree = null; }
  writeFileSync(join(repairDir(stateDir), "boot.json"), JSON.stringify({ commit, pid, t, ...(root ? { root } : {}), ...(tree !== undefined ? { tree } : {}) }) + "\n");
  appendEvent(stateDir, { kind: "boot", ...(commit ? { to: commit } : {}), text: R.restart.markBoot(pid), t });
  return commit;
}

/** A process this role runs beside hhd records itself the way hhd does, once it is up — it is stopped by this record (stopRecorded) */
export type ProcRecord = "console.json" | `module-${string}.json` | `bridge-${string}.json`;
export function markRecord(stateDir: string, name: ProcRecord, pid: number): void {
  writeFileSync(join(repairDir(stateDir), name), JSON.stringify({ pid, t: new Date().toISOString() }) + "\n");
}
/** The console, once it listens: <stateDir>/repair/console.json { pid, t } — a deploy stops it by this record */
export const markConsole = (stateDir: string, pid: number): void => markRecord(stateDir, "console.json", pid);
/** A module's long-running process (src/modules/timers.ts): <stateDir>/repair/module-<module>-<process>.json { pid, t } */
export const moduleRecord = (module: string, proc: string): ProcRecord => `module-${module}-${proc}.json`;
/** A channel's bridge (src/channels/bridge.ts): <stateDir>/repair/bridge-<channel>.json { pid, t } */
export const bridgeRecord = (channel: string): ProcRecord => `bridge-${channel}.json`;
/** The bridges this role has recorded: a deploy and a rollback stop them all (the watchdog keeps its own copy of this line) */
export const bridgeRecords = (stateDir: string): ProcRecord[] =>
  readdirSync(repairDir(stateDir)).filter((f): f is `bridge-${string}.json` => /^bridge-[\w-]+\.json$/.test(f));

/** A record's t is taken just after its process started, so that start is a little earlier; a pid reused after it died starts later. One second of slack: ps reports whole seconds (the watchdog's copy uses the same) */
const START_SLACK_MS = 1_000;
const MONTHS = "JanFebMarAprMayJunJulAugSepOctNovDec";

/**
 * SIGTERM to the process this role recorded in <stateDir>/repair/<name> ({ pid, t }): found by the role's state directory, never by
 * OS user or command line, so another role under the same OS user is left alone. The one check: that pid's process started no later
 * than t (+ START_SLACK_MS) — a later start is a reused pid. No record, or no such process: nothing to stop. Node built-ins only
 * (the watchdog mirrors it). Returns whether it signalled; null when ps could not be run, so whether that process is still
 * there is not known.
 */
export function stopRecorded(stateDir: string, name: "boot.json" | ProcRecord): boolean | null {
  const rec = readJson<{ pid: number; t: string }>(join(stateDir, "repair", name));
  if (!rec) return false;
  let lstart: string;
  // LC_ALL=C: the start prints as local time like "Tue Nov  3 20:00:57 2026" whatever the machine's locale; no such process exits 1
  try { lstart = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(rec.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }); }
  catch (e) { return typeof (e as { status?: unknown }).status === "number" ? false : null; }
  const m = /(\w{3}) +(\d+) (\d+):(\d+):(\d+) (\d+)/.exec(lstart);
  const started = m ? new Date(Number(m[6]), MONTHS.indexOf(m[1]!) / 3, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])).getTime() : NaN;
  if (!(started <= Date.parse(rec.t) + START_SLACK_MS)) return false;
  process.kill(rec.pid, "SIGTERM");
  return true;
}

export interface TurnCount { ok: number; broken: number }

/** 额度用完、网络、过载、API 那边报错、被打断：不怪代码，不算坏的一轮 */
const NOT_CODE = /^api_error|interrupt|abort|rate.?limit|usage limit|quota|overload|\b429\b|\b529\b|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network/i;

export function countTurns(outcomes: Array<{ ok: boolean; error?: string }>): TurnCount {
  let ok = 0, broken = 0;
  for (const o of outcomes) {
    if (o.ok) ok += 1;
    else if (!NOT_CODE.test(o.error ?? "")) broken += 1;
  }
  return { ok, broken };
}

/** 开头几轮都坏了、一轮没成：算这一版病了 */
const SICK_TURNS = 3;

/**
 * 起来后跑够 healthyMs、连着 healthyTicks 次 tick 都没出错、也不是「坏了几轮、一轮没成」，算这一版健康（healthy.json）；
 * 之后第一轮跑完记 proven.json，开头 SICK_TURNS 轮都坏了记 sick.json（看守看这两个决定退不退）。commit 是这个进程起来时的提交。
 */
export class HealthMark {
  private okTicks = 0;
  private healthy = false;
  private settled = false;
  private readonly o: { stateDir: string; rules: RepairRules["watch"]; started: number; now: () => number; commit: string | null };
  constructor(o: { stateDir: string; rules: RepairRules["watch"]; started: number; now: () => number; commit: string | null }) { this.o = o; }

  tick(ok: boolean, turns: TurnCount): void {
    if (!this.settled && turns.ok === 0 && turns.broken >= SICK_TURNS) { this.settled = true; this.write("sick.json", R.restart.restartTurnsFailed(turns.broken), "rollback"); return; }
    if (!this.healthy) {
      this.okTicks = ok ? this.okTicks + 1 : 0;
      if (this.okTicks < this.o.rules.healthyTicks || this.o.now() - this.o.started < this.o.rules.healthyMs) return;
      if (turns.broken > 0 && turns.ok === 0) return;
      this.healthy = true;
      this.write("healthy.json", R.restart.restartProvenStable, "healthy");
    }
    if (!this.settled && turns.ok > 0) { this.settled = true; this.write("proven.json", R.restart.restartFirstTurnDone, "healthy"); }
  }

  private write(name: string, text: string, kind: "healthy" | "rollback"): void {
    const commit = this.o.commit;
    const t = new Date(this.o.now()).toISOString();
    writeFileSync(join(repairDir(this.o.stateDir), name), JSON.stringify({ commit, pid: process.pid, t }) + "\n");
    if (kind === "healthy") appendEvent(this.o.stateDir, { kind: "healthy", ...(commit ? { to: commit } : {}), text, t });
    else appendEvent(this.o.stateDir, { kind: "watch", ...(commit ? { to: commit } : {}), text: R.restart.restartHandedToWatchdog(text), t });
  }
}

/**
 * 部署留下的看守参数还在（这次部署还没看完），看守进程却不在了（重启过电脑、等重启等太久走了）：再叫一个。
 * 用部署时拷出来的旧版看守。返回叫了没有。
 */
export function ensureWatchdog(stateDir: string, spawn: (script: string, arg: string) => void): boolean {
  const dir = join(stateDir, "repair");
  const w = readJson<{ target: string }>(join(dir, "watch.json"));
  if (!w || readDeployed(stateDir)?.commit !== w.target) return false;
  const p = readJson<{ pid: number; target: string }>(join(dir, "watchdog.pid"));
  if (p && p.target === w.target && alive(p.pid)) return false;
  const script = join(dir, "watchdog.ts");
  if (!existsSync(script)) return false;
  spawn(script, readFileSync(join(dir, "watch.json"), "utf8").trim());
  appendEvent(stateDir, { kind: "watch", to: w.target, text: R.restart.ensureWatchdog });
  return true;
}
