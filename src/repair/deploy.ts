// 部署：人人都用这一个（她、Claude Code 会话），只从共享 master、只往前、过守门、过这个提交的入口检查、核对线上没被手改过。
// 部署完不直接重启：留一个重启请求，hhd 在她闲着的时候自己重启；再交给看守，起不来就退回。
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { git, isAncestor, lsTree, blobSha, parseTrailers } from "./git.ts";
import { appendEvent, lastHealthy, readDeployed, readHeld, repairDir, rolledBackRanges, writeDeployed, writeHeld } from "./log.ts";
import type { Held } from "./log.ts";
import { takeLock } from "./lock.ts";
import { swapModules } from "./watchdog.ts";
import { keepLocal, liveDrift } from "./audit.ts";
import { evaluateRange } from "./range.ts";
import { readBench, runChecks, testsSlower, writeBench } from "./check.ts";
import type { HeavyLock } from "./lock.ts";
import type { Runner } from "./check.ts";
import { entryCheck } from "./entries.ts";
import type { RepairRules } from "./rules.ts";
import { B, N, R } from "../lang/index.ts";

/** prev = 最近一个跑稳的提交（退回就退到它）；数据库要不要备份由 hhd 重启那一刻决定（见 restart.ts） */
/** text: the watchdog's sentences rendered here (watchdogText), since the watchdog runs from a copy and imports nothing local */
/** authorEmail: marks the watchdog's revert as the role's own commit; notify: whom a rollback tells (both from the machine's role table, carried here since the watchdog runs standalone) */
export interface WatchArgs { live: string; stateDir: string; gitDir: string; prev: string; target: string; deployedAt: number; rules: RepairRules["watch"]; text: Record<string, string>; authorEmail: string; notify: string }
/** spawnWatchdog returns a line for the reply when the watchdog did not come up */
export interface DeployDeps { run: Runner; spawnWatchdog: (a: WatchArgs) => string | void; now: () => number }
export interface DeployOpts { live: string; stateDir: string; gitDir: string; checkDir: string; guardDir: string; target: string; by: string; selfUid: number; dbPath: string; rules: RepairRules; /** from the machine's role table */ owner: { name: string; channels: string[] }; authorEmail: string; /** the role's system account: the branch its own edits are kept on is <user>-local/<time> */ user: string; /** 跑检查前拿的重活锁（命令行给；测试不给） */ heavy?: HeavyLock }
export interface DeployResult { ok: boolean; from: string | null; to: string; text: string }

const LOCK_STALE_MS = 30 * 60_000;

/** 把一个提交解到线上：解包、删掉新版本里没有的旧文件、逐个核对 hash */
export function extractTree(gitDir: string, sha: string, live: string, prevTree: Map<string, string> | null): void {
  const tar = execFileSync("git", ["-C", gitDir, "archive", sha], { maxBuffer: 512 * 1024 * 1024 });
  const x = spawnSync("tar", ["-x", "-C", live], { input: tar });
  if (x.status !== 0) throw new Error(R.deploy.deployExtractFailed(String(x.stderr).slice(0, 300)));
  const tree = lsTree(gitDir, sha);
  for (const p of prevTree?.keys() ?? []) if (!tree.has(p) && existsSync(join(live, p))) unlinkSync(join(live, p));
  for (const [p, want] of tree) {
    if (blobSha(readFileSync(join(live, p))) !== want) throw new Error(R.deploy.deployTreeMismatch(p));
  }
}

export function deploy(o: DeployOpts, d: DeployDeps): DeployResult {
  const dir = repairDir(o.stateDir);
  const lock = join(dir, "deploy.lock");
  const refuse = (from: string | null, text: string): DeployResult => {
    appendEvent(o.stateDir, { kind: "refused", by: o.by, ...(from ? { from } : {}), to: o.target, text });
    return { ok: false, from, to: o.target, text };
  };
  // 锁里记进程号：上一次部署被掐掉（她的 Bash 两分钟超时）就直接接手
  const release = takeLock(lock, LOCK_STALE_MS, d.now());
  if (!release) return refuse(null, R.deploy.deployLockBusy);
  try { return deployLocked(o, d, refuse); } finally { release(); }
}

/** 看守退回的那段，后来有没有还原提交（Rollback-range 一样）进了 master */
function reverted(gitDir: string, h: Held, target: string): boolean {
  if (!isAncestor(gitDir, h.target, target)) return false;
  return git(gitDir, ["log", "--format=%B%x00", `${h.target}..${target}`]).split("\0").some((m) => parseTrailers(m)["Rollback-range"] === `${h.prev}..${h.target}`);
}

function deployLocked(o: DeployOpts, d: DeployDeps, refuse: (from: string | null, text: string) => DeployResult): DeployResult {
  let target: string;
  try { target = git(o.gitDir, ["rev-parse", `${o.target}^{commit}`]); } catch { return refuse(null, R.deploy.deployCommitNotFound(o.target)); }
  if (!isAncestor(o.gitDir, target, "refs/heads/master")) return refuse(null, R.deploy.deployNotOnMaster);
  const deployed = readDeployed(o.stateDir);
  if (!deployed) return refuse(null, R.deploy.deployNoRecord);
  const from = deployed.commit;
  if (target === from) return { ok: true, from, to: target, text: R.deploy.deployAlreadyCurrent };
  if (!isAncestor(o.gitDir, from, target)) return refuse(from, R.deploy.deployNotDescendant(target.slice(0, 7), from.slice(0, 7)));

  const prevTree = lsTree(o.gitDir, from);
  // the role may change its own live copy: not a reason to refuse — the edits are kept on a branch just before the new code goes in
  const drift = liveDrift(o.gitDir, o.live, from);

  const db = existsSync(o.dbPath) ? new DatabaseSync(o.dbPath, { readOnly: true }) : null;
  let range;
  try { range = evaluateRange({ dir: o.gitDir, from, to: target, rules: o.rules, guardDir: o.guardDir, selfUid: o.selfUid, db, owner: o.owner, rollbacks: rolledBackRanges(o.stateDir) }); } finally { db?.close(); }
  const blocked = range.items.filter((i) => i.via === "blocked");
  if (blocked.length) return refuse(from, R.deploy.deployBlockedCommits(blocked.map((i) => R.deploy.deployBlockedItem(i.sha.slice(0, 7), i.subject, i.why)).join(B.common.listSep)));
  const held = readHeld(o.stateDir);
  const stuck = held.filter((h) => isAncestor(o.gitDir, h.target, target) && !isAncestor(o.gitDir, h.target, from) && !reverted(o.gitDir, h, target));
  if (stuck.length) {
    return refuse(from, R.deploy.deployRollbackNotReverted(stuck.map((h) => `${h.prev.slice(0, 7)}..${h.target.slice(0, 7)}`).join(R.deploy.deployRollbackRangeSeparator)));
  }

  const checks = runChecks(o.checkDir, o.gitDir, target, d.run, o.heavy);
  if (checks.busy) return refuse(from, checks.busy);
  if (!checks.tsc.ok) return refuse(from, R.deploy.deployTscFailed(checks.tsc.tail));
  if (!checks.tests.ok) return refuse(from, R.deploy.deployTestsFailed(checks.tests.tail));
  const bench = readBench(o.stateDir, checks.tests.mode);   // 只跟同一种跑法比（换了跑法的第一次没有基准，不拒）
  if (range.items.some((i) => i.via === "gate") && testsSlower(checks.tests.ms, bench?.ms ?? null, o.rules.tests)) {
    return refuse(from, R.deploy.deployTestsSlower(Math.round((bench?.ms ?? 0) / 1000), Math.round(checks.tests.ms / 1000)));
  }
  // 入口检查跑要部署的那个提交里的脚本（从共享仓库的 git 对象取，不读检查克隆、不读线上）；放在最后一道门：线上、部署记录到这里都还没动
  const entries = entryCheck({ gitDir: o.gitDir, guardDir: o.guardDir, selfUid: o.selfUid, target }, d.run);
  if (!entries.ok) return refuse(from, entries.text);

  const dir = repairDir(o.stateDir);
  // 带数据库迁移：备份留到 hhd 重启那一刻做（部署到重启之间她还在写记忆，现在备份会丢掉这段）
  const migration = range.items.some((i) => i.verdict.reasons.some((r) => r.key === "migration"));
  const healthy = lastHealthy(o.stateDir, deployed);
  // 看守用旧版本的：新代码坏了它也得能跑（从部署的那个提交取，线上那份可能被她改过）
  const watchBlob = prevTree.get("src/repair/watchdog.ts");
  if (watchBlob) writeFileSync(join(dir, "watchdog.ts"), execFileSync("git", ["-C", o.gitDir, "cat-file", "blob", watchBlob], { maxBuffer: 64 * 1024 * 1024 }));
  // her edits, kept as they are before anything in the live copy changes; what she added goes, so the live copy is exactly the new commit after
  let kept = "";
  if (drift.length) {
    kept = `${o.user}-local/${new Date(d.now()).toISOString().slice(0, 19).replace(/:/g, "")}Z`;
    try { keepLocal(o.gitDir, o.live, from, kept, { name: N.me, email: o.authorEmail }, R.deploy.localCommitMessage(from.slice(0, 7), target.slice(0, 7), drift.length)); } catch (e) {
      return refuse(from, R.deploy.deployLocalNotKept(String(e).slice(0, 300)));
    }
    for (const x of drift) if (x.how === "extra") rmSync(join(o.live, x.path), { force: true });
  }

  const lockBefore = prevTree.get("package-lock.json");
  const newTree = lsTree(o.gitDir, target);
  // 依赖变了：先在线上旁边的目录里装好，解包以后再换进去（不在跑着的 hhd 底下清空 node_modules）；换下来的留给看守退回用
  const next = `${o.live}.npm-next`;
  const depsChanged = newTree.get("package-lock.json") !== lockBefore;
  if (depsChanged) {
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });
    for (const f of ["package.json", "package-lock.json"]) {
      if (newTree.has(f)) writeFileSync(join(next, f), execFileSync("git", ["-C", o.gitDir, "cat-file", "blob", newTree.get(f)!], { maxBuffer: 64 * 1024 * 1024 }));
    }
    const i = d.run("npm", ["ci", "--omit=dev"], next);
    if (i.code !== 0) {
      rmSync(next, { recursive: true, force: true });
      return refuse(from, R.deploy.deployInstallFailed(i.out.slice(-300)));
    }
  }
  try { extractTree(o.gitDir, target, o.live, prevTree); } catch (e) {
    try { extractTree(o.gitDir, from, o.live, newTree); } catch { /* 尽力了，看守和核对会发现 */ }
    rmSync(next, { recursive: true, force: true });
    return refuse(from, R.deploy.deployExtractRolledBack(String(e).slice(0, 300)) + (kept ? `\n${R.deploy.deployLocalKept(drift.length, kept)}` : ""));
  }
  if (depsChanged) {
    const keep = `${o.live}.npm-prev`;
    swapModules(o.live, next, keep);
    writeFileSync(join(keep, "lock"), (lockBefore ?? "none") + "\n");
    rmSync(next, { recursive: true, force: true });
  }
  const t = new Date(d.now()).toISOString();
  writeDeployed(o.stateDir, { commit: target, prev: from, t, by: o.by, lastHealthy: healthy });
  writeBench(o.stateDir, { sha: target, ms: checks.tests.ms, ...(checks.tests.mode ? { mode: checks.tests.mode } : {}) });
  const counts = { session: 0, gate: 0, owner: 0, rollback: 0 };
  for (const i of range.items) if (i.via !== "blocked") counts[i.via] += 1;
  const text = R.deploy.deployDone(from.slice(0, 7), target.slice(0, 7), range.items.length, counts.session, counts.gate, counts.owner, counts.rollback ? R.deploy.deployRollbackNote(counts.rollback) : "") + (kept ? `\n${R.deploy.deployLocalKept(drift.length, kept)}` : "");
  // an item the owner approved is written with the owner's name, as the morning summary looks for it (log.ts)
  const items = range.items.map((i) => R.deploy.deployItemLine(i.sha.slice(0, 7), i.via === "owner" ? N.owner : i.via, i.why));
  if (entries.note) items.push(entries.note);
  // 按跳过记录放过去的：谁、为什么单独记一个字段，事后在修理日志里查得到
  appendEvent(o.stateDir, { kind: "deploy", by: o.by, from, to: target, text, t, items, ...(entries.skip ? { entrySkip: entries.skip } : {}) });
  writeFileSync(join(dir, "restart-request.json"), JSON.stringify({ commit: target, t, ...(migration ? { migration: true } : {}) }) + "\n");
  // 控制台（ai.hh.console）每次都跟着重启：它只读、重启很便宜，又引用了 src/console/ 以外的很多模块（只看 src/console/ 会漏）
  writeFileSync(join(dir, "console-restart.json"), JSON.stringify({ commit: target, t }) + "\n");
  if (held.length) writeHeld(o.stateDir, held.filter((h) => !reverted(o.gitDir, h, target)));
  // 留一份看守的参数：重启电脑、看守等太久走了，hhd 起来时照这个再叫一个（restart.ts ensureWatchdog）
  const watchArgs: WatchArgs = { live: o.live, stateDir: o.stateDir, gitDir: o.gitDir, prev: healthy, target, deployedAt: d.now(), rules: o.rules.watch, text: watchdogText(), authorEmail: o.authorEmail, notify: o.owner.name };
  writeFileSync(join(dir, "watch.json"), JSON.stringify(watchArgs) + "\n");
  const watchNote = d.spawnWatchdog(watchArgs);
  const reply = [text, entries.note, watchNote].filter(Boolean).join("\n");
  return { ok: true, from, to: target, text: reply };
}

/** Every sentence the watchdog may say, rendered from the language pack now: a function's holes become \u0001<n>, which the watchdog fills */
export function watchdogText(): Record<string, string> {
  // nine holes for every function: the pack's bound wrappers report length 0, and extra arguments are ignored
  const holes = Array.from({ length: 9 }, (_, i) => `\u0001${i}`);
  return Object.fromEntries(Object.entries(R.watchdog as Record<string, unknown>).map(([k, v]) => [k, typeof v === "function" ? String((v as (...a: unknown[]) => unknown)(...holes)) : String(v)]));
}
