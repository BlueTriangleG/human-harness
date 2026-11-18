// 回放（spec §12）：hh sleep replay <日> 在 hhd 里（以工作区那个用户）后台把那一天用新的流程重新整理一遍，全隔离：
// - 工作区：<stateDir>/replay/<ts>/ws，W 的共享克隆（git clone --shared，只读 W，不往 W/.git 里登记），checkout 到基准提交，
//   盖上新的流程目录（scripts/sleep_flow/**）和那一天的材料（sleep/<日>/ 里的 input.md、sources.json、slices/）；
// - 事件库：<stateDir>/replay/<ts>/hh.db，主库的异步备份，撤掉旧的整理那一夜写的批次（撤了什么、冲突写进 out/reverted.json）；
// - 跑：照 flow.json（engine 强制 flow，只这一天），引擎跟真的夜里同一份（sleep/night.ts）；准备、落地的脚本不跑（材料现成、决不落地）；
//   learn_check 直接回「回放：不送把关」，什么都不记；核依据、考试、性格、协调照真的跑，花费和看门狗照算；记账、题库都写在拷贝里；
// - 出来的东西在 out/：report.md、各段记录、记账行（JSON）、compare.md（机械地比旧的整理和回放）、no-openai.txt。
// W 和主库都只读不写。临时的东西都在 <stateDir>/replay/<ts>/ 下面。
// 不调 OpenAI（主人 11-07：「禁止！以后不能用我的 apikey 测试啊。」）：事件记忆一律 embedder: null，学习不建判断、不读 key；
// 再加一道闸：回放里（AsyncLocalStorage 认的）去 api.openai.com 的 fetch / https 请求一律抛错、记日志、计数，写进 no-openai.txt。
import { AsyncLocalStorage } from "node:async_hooks";
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import * as sqlite from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { remapConfig, roleNames, type Config } from "../config.ts";
import type { KernelDriver, ToolDef } from "../kernel/types.ts";
import { scanShelf } from "../learning/notebook.ts";
import { shelfDirOf } from "../learning/shelf.ts";
import { worklist } from "../learning/score.ts";
import type { Logger } from "../log.ts";
import type { EventMemory } from "../memory/events/memory.ts";
import { CARD_DIR } from "../memory/events/people.ts";
import { nightWindow } from "../brainstem/clock.ts";
import { all, one, openDb, type Db } from "../store/db.ts";
import type { LearnNight } from "../tools/memtools.ts";
import type { Runner, RunResult } from "../util/run.ts";
import { Budget } from "./budget.ts";
import type { FlowConfig, StageSpec } from "./flow.ts";
import { replayArgs, nodeFs, readNight, sleepWeights, type NightBrain, type NightHosts, type NightPlan } from "./host.ts";
import { assembleNight } from "./night.ts";

import type { NightResult, SleepRunner } from "./runner.ts";
import { S, fromEveryPack } from "../lang/index.ts";

/** 回放里 learn_check 的回话（不开把关会话、不记任何东西） */
/** 回放里用不上的（会碰到 OpenAI 的路） */
/** 跳过的脚本段：命令换成这个，回放的 run 认出来直接回退出码 0 */
export const SKIP_CMD = "hh-replay-skip";
export const BLOCKED_LOG = "replay: blocked openai request";
/**
 * 回放起的子进程（段的会话里的 Bash、核对脚本）：没有 OpenAI 的 key，OpenAI 的地址指到本机一个没人听的端口
 * （进程里的闸管不到子进程，这一道管用 openai 库的脚本）
 */
export const NO_OPENAI_ENV: Readonly<Record<string, string>> = { OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:9/v1" };
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 回放这一夜叫什么（sleep_run.night、前额叶的会话 id coord-<night>）：不跟真的夜里撞 */
export const replayNight = (day: string): string => `replay-${day}`;
const GIT_MS = 15 * 60_000;
/** 回放的准备命令（flow.json 的 replayPrep）一条最多跑多久 */
const PREP_MS = 10 * 60_000;
const STOP_WAIT_MS = 30_000;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const PYTHONS = new Set(["python3", "python"]);

// ---------- 不调 OpenAI 的闸 ----------

const inReplay = new AsyncLocalStorage<OpenAIGuard>();

/** 请求去哪个主机（url 字符串、URL、Request、https.request 的选项）；认不出给 null */
export function hostOf(x: unknown): string | null {
  try {
    if (typeof x === "string") return new URL(x).hostname;
    if (x instanceof URL) return x.hostname;
    if (x && typeof x === "object") {
      const o = x as { url?: unknown; hostname?: unknown; host?: unknown };
      if (typeof o.url === "string") return new URL(o.url).hostname;
      if (typeof o.hostname === "string") return o.hostname;
      if (typeof o.host === "string") return o.host.replace(/:\d+$/, "");
    }
  } catch { /* 认不出 */ }
  return null;
}
const isOpenAI = (h: string | null): boolean => h !== null && (h === "api.openai.com" || h.endsWith(".openai.com"));

/**
 * 一次回放的闸：run(fn) 里引出的一切（会话、工具、定时、子进程的回调）都算这一次回放的；
 * 装上以后（installOpenAIGuard）回放里去 api.openai.com 的请求抛错、记 replay: blocked openai request、计数。回放外面的照常放行
 */
export class OpenAIGuard {
  /** 拦下的次数（= 回放发出的 OpenAI 请求数） */
  blocked = 0;
  private readonly log: (m: string, data?: Record<string, unknown>) => void;
  constructor(log: (m: string, data?: Record<string, unknown>) => void) { this.log = log; }
  run<T>(fn: () => T): T { return inReplay.run(this, fn); }
  /** 现在这一刻在不在某个回放里 */
  static current(): OpenAIGuard | undefined { return inReplay.getStore(); }
  /** 回放里要去 OpenAI：计数、记日志、抛错 */
  check(where: string, target: unknown): void {
    const host = hostOf(target);
    if (!isOpenAI(host)) return;
    this.blocked += 1;
    this.log(BLOCKED_LOG, { where, host });
    throw new Error(S.replay.openaiBlocked(S.replay.notHere, BLOCKED_LOG));
  }
}

type AnyFn = (...args: unknown[]) => unknown;
let installed: { users: number; restore(): void } | null = null;

/**
 * 包住这个进程的 fetch 和 https.request / https.get：在某个回放里（OpenAIGuard.run）去 OpenAI 的就由那个回放的闸拦下；
 * 不在回放里的原样放行（她白天的系统不受影响）。可以装多次，最后一个卸了才还原；返回卸下
 */
export function installOpenAIGuard(): () => void {
  if (!installed) {
    const https = createRequire(import.meta.url)("node:https") as Record<string, AnyFn>;
    const g = globalThis as unknown as { fetch: AnyFn };
    const orig = { fetch: g.fetch, request: https.request!, get: https.get! };
    const wrapFetch = function (this: unknown, ...args: unknown[]): unknown {
      try { OpenAIGuard.current()?.check("fetch", args[0]); } catch (e) { return Promise.reject(e); }
      return orig.fetch.apply(this ?? globalThis, args);
    };
    const wrapHttps = (name: "request" | "get", f: AnyFn): AnyFn => function (this: unknown, ...args: unknown[]): unknown {
      OpenAIGuard.current()?.check(`https.${name}`, args[0]);
      return f.apply(this, args);
    };
    g.fetch = wrapFetch;
    https.request = wrapHttps("request", orig.request);
    https.get = wrapHttps("get", orig.get);
    syncBuiltinESMExports();
    installed = {
      users: 0,
      restore: () => {
        if (g.fetch === wrapFetch) g.fetch = orig.fetch;
        https.request = orig.request;
        https.get = orig.get;
        syncBuiltinESMExports();
      },
    };
  }
  const me = installed;
  me.users += 1;
  let off = false;
  return () => {
    if (off) return;
    off = true;
    me.users -= 1;
    if (me.users === 0 && installed === me) { me.restore(); installed = null; }
  };
}

// ---------- 旧的整理那一夜写的批次 ----------

// 那一天的夜里从几点算起到几点：搬到 brainstem/clock.ts（考场渲染中期视图也要用），这里照旧导出
export { nightWindow };

export interface LegacyBatch { id: string; state: string; startedAt: number; ops: number }

const BATCH_COLS = "SELECT b.id, b.state, b.started_at, (SELECT count(*) FROM mem_op o WHERE o.batch = b.id) AS ops FROM mem_batch b ";
const LIVE_BATCH = "b.state IN ('open', 'committed') AND instr(b.id, '~reverted@') = 0";
const batchRow = (r: { id: string; state: string; started_at: number; ops: number }): LegacyBatch => ({ id: r.id, state: r.state, startedAt: r.started_at, ops: r.ops });

/**
 * 旧的整理整理这一天写的批次，就是要撤的（新的在前）：Brain 的旧整理开批用 night:<哪一夜>/<整理的那天>
 * （没有积压、整理当天是 night:<那一夜>/today，那一夜就是这一天），提交了的、开着的；撤回过的留档不算
 */
export function legacyBatches(db: Db, day: string): LegacyBatch[] {
  return all<{ id: string; state: string; started_at: number; ops: number }>(db,
    BATCH_COLS + `WHERE ${LIVE_BATCH} AND substr(b.id, 1, 6) = 'night:' AND (substr(b.id, -length(?)) = ? OR b.id = ?) ORDER BY b.started_at DESC, b.rowid DESC`,
    `/${day}`, `/${day}`, `night:${day}/today`).map(batchRow);
}

/** since 以后开的别的批次（不是旧的整理的、不是导入、不是新睡眠的段）：夜里以后事件库又动过的，不撤，只列出来 */
export function laterBatches(db: Db, since: number, skip: ReadonlySet<string>): LegacyBatch[] {
  return all<{ id: string; state: string; started_at: number; ops: number }>(db,
    BATCH_COLS + `WHERE ${LIVE_BATCH} AND b.started_at >= ? AND b.id NOT LIKE 'import%' AND b.id NOT LIKE 'sleep:%' ORDER BY b.started_at, b.rowid`, since)
    .map(batchRow).filter((b) => !skip.has(b.id));
}

// ---------- 学习的花费账（kv learn.spend.<日>） ----------

export interface Spend { keys: number; tokens: number; rows: Array<{ k: string; v: string }> }
export function spendOf(db: Db): Spend {
  const rows = all<{ k: string; v: string }>(db, "SELECT k, v FROM kv WHERE k LIKE 'learn.spend.%' ORDER BY k").map((r) => ({ k: r.k, v: String(r.v) }));
  return { keys: rows.length, tokens: rows.reduce((a, r) => a + (Number(r.v) || 0), 0), rows };
}
const sameSpend = (a: Spend, b: Spend): boolean => JSON.stringify(a.rows) === JSON.stringify(b.rows);

// ---------- 跳过准备和落地 ----------

/**
 * 回放的流程：准备的脚本段（不在 agent 段后面的）、finish 和 finish 后面的脚本段，命令换成 SKIP_CMD（回放的 run 直接回 0）；
 * finish 前面的核对脚本照跑（在回放的工作区里）。返回新的 plan 和跳过的段
 */
export function skipScripts(plan: NightPlan): { plan: NightPlan; skipped: string[] } {
  const byId = new Map(plan.flow.stages.map((s) => [s.id, s]));
  // 跟 runner 认落地的段一模一样：finish，和排在 agent 段（或别的落地脚本）后面的脚本段
  const landing = (s: StageSpec): boolean => s.kind === "script" && (s.id === "finish" ||
    s.after.some((a) => { const u = byId.get(a); return u !== undefined && (u.kind === "agent" || landing(u)); }));
  const afterFinish = (s: StageSpec, seen = new Set<string>()): boolean => s.after.some((a) => {
    if (a === "finish") return true;
    const u = byId.get(a);
    if (!u || seen.has(a)) return false;
    seen.add(a);
    return afterFinish(u, seen);
  });
  const skip = (s: StageSpec): boolean => s.kind === "script" && (!landing(s) || s.id === "finish" || afterFinish(s));
  const skipped = plan.flow.stages.filter(skip).map((s) => s.id);
  const flow: FlowConfig = { ...plan.flow, stages: plan.flow.stages.map((s) => (skip(s) ? { ...s, command: [SKIP_CMD, s.id] } : s)) };
  return { plan: { ...plan, flow }, skipped };
}

// ---------- 回放要 Brain 给的 ----------

export interface ReplayDeps {
  cfg: Config;
  driver: KernelDriver;
  /** 主库：只拷（异步备份）、只读学习的花费账；决不写 */
  db: Db;
  log: Logger;
  /** 跑 git 和脚本（hhd 里是 runProcess） */
  run: Runner;
  now(): number;
  later(fn: () => void, ms: number): () => void;
  /** 在一个库上开事件记忆：一定 embedder: null；时区、人物卡模板、主人照 Brain 的 */
  openMem(db: Db, o: { peopleDir?: string; peopleActive?: () => boolean }): EventMemory;
  /** 一个会话的 HH 工具（回放版）：事件库、库、工作区都是回放的，learn 是回放的工作单和把关 */
  tools(id: string, names: readonly string[], x: { mem: EventMemory; db: Db; workspace: string; learn: LearnNight }): ToolDef[];
  /** 工作区里这个文件在 = 人物卡切过去了（相对工作区；不给就当切过去了） */
  peopleSwitch?: string;
}

export interface ReplayOpts { day: string; base?: string; flowDir?: string }

type Phase = "workspace" | "store" | "run" | "output" | "done" | "failed" | "aborted";

interface ReplayState {
  ts: string;
  dir: string;
  day: string;
  base: string | null;
  flowDir: string;
  phase: Phase;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
  blocked: number;
  landing: string[];
  reverted: Array<{ batch: string; ops: number; reverted: number; conflicts: string[] }>;
  /** 旧的整理那一夜以后事件库又动过的批次（没撤） */
  after: Array<{ batch: string; ops: number; startedAt: number }>;
  skipped: string[];
  /** 准备工作区时的几句（切片脚本跑没跑成、新版的脚本盖没盖上） */
  notes: string[];
  /** 从流程目录所在的仓库盖到回放工作区的文件（flow.json 的 replayOverlay；只是工具，不算回放的改动） */
  overlaid?: string[];
  runId: number | null;
  result: NightResult | null;
}

/** 一次回放 */
class ReplayRun {
  readonly st: ReplayState;
  readonly guard: OpenAIGuard;
  runner: SleepRunner | null = null;
  hosts: NightHosts | null = null;
  budget: Budget | null = null;
  copy: Db | null = null;
  /** 拷贝刚打开时（撤之前）它的学习花费账 */
  copySpend: Spend | null = null;
  aborted: string | null = null;
  done: Promise<void> = Promise.resolve();
  /** 写 status.json、收摊出错时记一句 warn（一次回放各记一次，不刷屏） */
  private readonly log: Logger | null;
  private warned = new Set<string>();
  constructor(st: ReplayState, guard: OpenAIGuard, log: Logger | null = null) { this.st = st; this.guard = guard; this.log = log; }
  warnOnce(what: string, m: string, e: unknown): void {
    if (this.warned.has(what)) return;
    this.warned.add(what);
    this.log?.warn(m, { dir: this.st.dir, error: msg(e).slice(0, 300) });
  }
  save(): void {
    try { writeFileSync(join(this.st.dir, "status.json"), JSON.stringify({ ...this.st, blocked: this.guard.blocked }, null, 2)); } catch (e) {
      // 下次再写；replay-status 会显示旧的进度，记一句
      this.warnOnce("save", "replay: writing status.json failed", e);
    }
  }
}

const git = async (deps: ReplayDeps, cwd: string, args: string[], ok: number[] = [0]): Promise<RunResult> => {
  const r = await deps.run("git", ["-c", "core.quotePath=false", ...args], { cwd, timeoutMs: GIT_MS });
  if (!ok.includes(r.code)) throw new Error(S.replay.gitFailed(args.slice(0, 3).join(" "), r.code, (r.stderr || r.stdout).trim().slice(0, 300)));
  return r;
};

/** 那一天旧的整理落地的提交（主题以「睡眠整理 <日>」开头，每个语言包的 landingHead 都认），旧的在前 */
async function landingCommits(deps: ReplayDeps, W: string, day: string): Promise<Array<{ sha: string; subject: string }>> {
  const heads = fromEveryPack((p) => `${p.sleep.replay.landingHead} ${day}`);
  const r = await git(deps, W, ["log", "--format=%H%x09%s", "--fixed-strings", ...heads.map((h) => `--grep=${h}`), "HEAD"]);
  return r.stdout.split("\n").filter(Boolean).map((l) => { const i = l.indexOf("\t"); return { sha: l.slice(0, i), subject: l.slice(i + 1) }; })
    .filter((c) => heads.some((h) => c.subject.startsWith(h))).reverse();
}

const filesUnder = (root: string, rel = ""): string[] => {
  let names: string[];
  try { names = readdirSync(join(root, rel)); } catch { return []; }
  return names.flatMap((n) => {
    const p = rel ? `${rel}/${n}` : n;
    try { return statSync(join(root, p)).isDirectory() ? filesUnder(root, p) : [p]; } catch { return []; }
  }).sort();
};

const readOr = (p: string): string | null => { try { return readFileSync(p, "utf8"); } catch { return null; } };

// ---------- 一次回放从头到尾 ----------

async function workspace(deps: ReplayDeps, r: ReplayRun, o: ReplayOpts): Promise<string> {
  const W = resolve(deps.cfg.workspace);
  const ws = join(r.st.dir, "ws");
  const landing = await landingCommits(deps, W, o.day);
  r.st.landing = landing.map((c) => c.sha);
  const baseRef = o.base ?? (landing[0] ? `${landing[0].sha}^` : null);
  if (!baseRef) throw new Error(S.replay.noLandingCommit(o.day));
  const base = (await git(deps, W, ["rev-parse", "--verify", `${baseRef}^{commit}`])).stdout.trim();
  r.st.base = base;
  r.save();
  // 共享克隆：只读 W（对象借 W 的），不像 git worktree add 那样往 W/.git 里登记
  await git(deps, r.st.dir, ["clone", "--quiet", "--shared", "--no-checkout", W, ws]);
  await git(deps, ws, ["checkout", "--quiet", "--detach", base]);
  // 新的流程目录整个换上
  const flowRel = dirname(deps.cfg.sleep.flowFile);
  const src = resolve(o.flowDir ?? join(W, flowRel));
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(S.replay.noFlowDir(src));
  const dst = join(ws, flowRel);
  // 基准提交里提交了的目录链接不能把删、拷带到工作区外面去（修正第 2 轮 m1 顺带：rmSync 会顺着链接删外面的）
  staysInWs(ws, dst, S.replay.flowDir);
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true, filter: (p) => !p.split("/").includes(".git") });
  // 引擎：flow.json 写 legacy 也照跑新的。有 team 块、engine 写的 team 或 legacy（没写）：照 team 跑；别的一律 flow
  const flowFile = join(ws, deps.cfg.sleep.flowFile);
  const text = readOr(flowFile);
  if (text === null) throw new Error(S.replay.noFlowFile(deps.cfg.sleep.flowFile));
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const hasTeam = typeof j.team === "object" && j.team !== null && !Array.isArray(j.team);
    // 写了 engine: team 的一律照 team（team 块没写、写坏了交给 readNight 报，不改成 flow 悄悄跑）
    const want = j.engine === "team" || (hasTeam && (j.engine === "legacy" || j.engine === undefined)) ? "team" : "flow";
    if (j.engine !== want) { j.engine = want; writeFileSync(flowFile, JSON.stringify(j, null, 2)); }
  } catch { /* 坏的交给 readNight 报 */ }
  // 那一天的材料（不在 git 里）；那一天以前留下的整理结果（提案、报告、记录）不要
  const from = join(W, "sleep", o.day);
  const to = join(ws, "sleep", o.day);
  staysInWs(ws, to, S.replay.dayMaterial);
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  let got = 0;
  for (const n of ["input.md", "sources.json", "slices"]) {
    if (!existsSync(join(from, n))) continue;
    cpSync(join(from, n), join(to, n), { recursive: true });
    got += 1;
  }
  if (!existsSync(join(to, "input.md")) && !existsSync(join(to, "slices"))) throw new Error(S.replay.noMaterial(from));
  deps.log.info("replay: workspace ready", { ws, base, flow: src, material: got, notes: r.st.notes });
  return ws;
}

/** 主库异步备份到回放目录，撤掉旧的整理那一夜的批次 */
async function store(deps: ReplayDeps, r: ReplayRun, ws: string): Promise<{ db: Db; mem: EventMemory; legacyOps: number }> {
  const path = join(r.st.dir, "hh.db");
  if (typeof sqlite.backup === "function") await sqlite.backup(deps.db, path);
  else deps.db.prepare("VACUUM INTO ?").run(path);
  const db = openDb(path);
  r.copy = db;
  r.copySpend = spendOf(db);
  const sw = deps.peopleSwitch;
  const mem = deps.openMem(db, { peopleDir: join(ws, CARD_DIR), peopleActive: () => (sw ? existsSync(join(ws, sw)) : true) });
  // 硬规矩：回放的事件记忆不带向量服务（想起事情只用关键词）
  if (mem.index.embedder !== null) throw new Error(S.replay.noEmbedder(S.replay.notHere));
  // 只撤旧的整理那一夜的批次；那以后事件库又动过的（早上的、白天的）不撤，列出来
  const legacy = legacyBatches(db, r.st.day);
  let legacyOps = 0;
  for (const b of legacy) {
    const x = mem.store.revertBatch(b.id);
    legacyOps += b.ops;
    r.st.reverted.push({ batch: b.id, ops: b.ops, reverted: x.reverted, conflicts: x.conflicts });
  }
  const since = legacy.length ? Math.min(...legacy.map((b) => b.startedAt)) : nightWindow(r.st.day, deps.cfg.schedule.timezone, deps.cfg.schedule.nightSleep).from;
  r.st.after = laterBatches(db, since, new Set(legacy.map((b) => b.id))).map((b) => ({ batch: b.id, ops: b.ops, startedAt: b.startedAt }));
  if (!legacy.length) deps.log.warn("replay: no legacy night batch for the day in the event store", { day: r.st.day });
  // 旧的整理标过「这一天整理完了」：拷贝里拿掉
  const marked = db.prepare("DELETE FROM mem_day WHERE day = ?").run(r.st.day).changes;
  writeFileSync(join(r.st.dir, "out", "reverted.json"), JSON.stringify({
    batches: r.st.reverted, dayMarkRemoved: Number(marked) > 0,
    afterTheNightNotReverted: r.st.after.map((x) => ({ ...x, startedAt: new Date(x.startedAt).toISOString() })),
  }, null, 2));
  deps.log.info("replay: legacy night reverted in the copy", { copy: path, batches: r.st.reverted.map((x) => x.batch), ops: legacyOps, conflicts: r.st.reverted.reduce((a, x) => a + x.conflicts.length, 0), afterNotReverted: r.st.after.length });
  for (const x of r.st.reverted) if (x.conflicts.length) deps.log.warn("replay: revert conflicts", { batch: x.batch, conflicts: x.conflicts.slice(0, 20) });
  r.save();
  return { db, mem, legacyOps };
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** workspaceEnv 一个都没有：回放不开跑（子进程会找到真的 W） */

/**
 * 回放的子进程（段的会话、核对脚本、准备命令）里指到工作区的环境变量，都换成回放的工作区（不然她白名单里的脚本会找到真的 W）：
 * kernel.env 里值（路径规范化以后）就是工作区的；sleep.workspaceEnv 点名的（她的平台用哪个名字写在配置里，HH 代码里不写）
 */
export function workspaceEnv(cfg: Config, ws: string): Record<string, string> {
  const W = resolve(cfg.workspace);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.kernel.env ?? {})) if (typeof v === "string" && isAbsolute(v) && resolve(v) === W) out[k] = ws;
  for (const k of cfg.sleep.workspaceEnv ?? []) if (typeof k === "string" && ENV_NAME.test(k)) out[k] = ws;
  return out;
}

/**
 * 回放的子进程（段的会话里的 hh 命令、核对脚本、准备命令）读的 HH 配置：从母配置（deps.cfg，合完的）来的一份完整的，不再是三个键加默认值——
 * 名字、语言、时区、闸门这些照母配置带着，hh 起来时的 requireInstance 才过得去。顺序：
 * 1. 拷一份母配置；里面指到真工作区、真 state 的路径（技能目录、学习根、人格文件、argv 里的脚本……）都换成回放这份拷贝里的（remapConfig）；
 * 2. 盖上：工作区、state 是回放的；hh send 只演习；学习的联想关掉（向量和判断是 hh 这边 OpenAI 的唯一用处，以前只靠回放的 state 里没有
 *    放 key 的文件才没拿到 key）；浏览器没有程序、没有调试端口、用户资料在回放的 state 下
 *    （以前继承默认值 = 真的 Chrome 的端口和资料，子进程里的 hh browser 会连上她正开着的浏览器）；
 * 3. 清空：kernel.env、kernel.mcpServers（子进程里的 hh 命令不起会话；段的会话的环境另由 replayBrain 给）。
 *    注意写成空对象并不会清掉默认值里的键：hh 读它时照常 deepMerge（对象逐键合），空只在默认值本来也是空的时候才是空
 * 其余一概照母配置。回放里没有的东西（hhd 的 socket）：state 是回放自己的，连不上真的 hhd。
 */
export function replayChildConfig(cfg: Config, ws: string, state: string): Config {
  const child = remapConfig(cfg, [[resolve(cfg.workspace), ws], [resolve(cfg.stateDir), state]]);
  child.workspace = ws;
  child.stateDir = state;
  child.tools = { ...child.tools, sendDryRun: true };
  child.learning = { ...child.learning, enabled: false, inject: false };
  child.browser = { chrome: "", userDataDir: join(state, "browser"), port: 0 };
  child.kernel = { ...child.kernel, env: {}, mcpServers: {} };
  return child;
}

/** 回放自己的 HH 配置文件（<回放>/state/config.json，内容见 replayChildConfig），子进程的 HH_CONFIG 指到它 */
function replayConfigFile(r: ReplayRun, ws: string, parent: Config): string {
  const state = join(r.st.dir, "state");
  mkdirSync(state, { recursive: true });
  const file = join(state, "config.json");
  writeFileSync(file, JSON.stringify(replayChildConfig(parent, ws, state), null, 2));
  return file;
}

/** 回放的子进程里指到库的环境变量（sleep.dbEnv 点名的；她的脚本用哪个名字写在配置里，HH 代码里不写）：都指到回放那份拷贝 */
export function dbEnv(cfg: Config, dbPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of cfg.sleep.dbEnv ?? []) if (typeof k === "string" && ENV_NAME.test(k)) out[k] = dbPath;
  return out;
}

/** 回放的子进程的环境：指到工作区的换成 ws、指到库的换成回放的拷贝、HH_CONFIG 指到回放自己的配置、没有 OpenAI */
const childEnv = (deps: ReplayDeps, ws: string, hhConfig: string, dbPath: string | null): Record<string, string> =>
  ({ ...workspaceEnv(deps.cfg, ws), ...(dbPath ? dbEnv(deps.cfg, dbPath) : {}), HH_CONFIG: hhConfig, ...NO_OPENAI_ENV });
const envArgs = (env: Record<string, string>): string[] => Object.entries(env).map(([k, v]) => `${k}=${v}`);

/** 回放的夜里 Brain：工作区、库、事件库都是回放的；读写真文件；跳过的脚本直接回 0；脚本按回放的工作区找自己 */
function replayBrain(deps: ReplayDeps, r: ReplayRun, ws: string, db: Db, mem: EventMemory): NightBrain {
  const child = childEnv(deps, ws, replayConfigFile(r, ws, deps.cfg), join(r.st.dir, "hh.db"));
  const cfg: Config = {
    ...deps.cfg, workspace: ws, stateDir: join(r.st.dir, "state"),
    // 段的会话（和它的 Bash）：指到工作区的环境变量指到回放的工作区，HH_CONFIG 指到回放的配置，没有 OpenAI
    kernel: { ...deps.cfg.kernel, env: { ...deps.cfg.kernel.env, ...child } },
  };
  const learnRoot = (): string => {
    const root = resolve(deps.cfg.learning.root);
    const rel = relative(resolve(deps.cfg.workspace), root);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? join(ws, rel) : root;
  };
  const learn: LearnNight = {
    // 学习工作单：只读，在拷贝上算、不带向量服务（教训那一半写「今晚算不了」）
    worklist: (day) => worklist(db, scanShelf(learnRoot(), deps.cfg.learning.generalCategory, deps.cfg.learning.archiveDir), day, { now: deps.now(), tz: deps.cfg.schedule.timezone, embedder: null, root: learnRoot(), owner: roleNames(deps.cfg).owner, shelfDir: shelfDirOf(deps.cfg.workspace, deps.cfg.learning.root), residentFile: deps.cfg.learning.residentFile }),
    check: () => S.replay.noCheck,
  };
  const run: Runner = async (cmd, args, o) => {
    if (cmd === SKIP_CMD) return { code: 0, stdout: S.replay.skippedOut, stderr: "" };
    return deps.run("/usr/bin/env", [...envArgs(child), cmd, ...args], { ...o, cwd: ws });
  };
  return {
    cfg, driver: deps.driver, db, log: deps.log.child("replay"), mem, fs: nodeFs(ws), run,
    readText: readOr,
    now: deps.now, later: deps.later,
    hhTools: (id, names, m) => deps.tools(id, names, { mem: m ?? mem, db, workspace: ws, learn }),
    memAt: (path) => {
      const ro = new DatabaseSync(path, { readOnly: true });
      try {
        const m = deps.openMem(ro, {});
        if (m.index.embedder !== null) throw new Error(S.replay.vectorService(S.replay.notHere));
        return { mem: m, close: () => ro.close() };
      } catch (e) { ro.close(); throw e; }
    },
  };
}

/** p 自己或离它最近的一个已经有的上一级（lstat 看得见的，链接也算；坏的链接留给 realpath 抛错） */
const nearestExisting = (p: string): string => {
  for (let a = p; ; a = dirname(a)) {
    try { lstatSync(a); return a; } catch { if (dirname(a) === a) return a; }
  }
};

/** p 在 root 里面（或就是 root） */
const inside = (root: string, p: string): boolean => { const rel = relative(root, p); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };

/** 回放要在 ws 里删、建、拷的 p：离它最近的已经有的那一级解开链接以后得在 ws 里，不然抛错（这一次回放不跑） */
function staysInWs(ws: string, p: string, what: string): void {
  const wsReal = realpathSync(ws);
  let real: string;
  try { real = realpathSync(nearestExisting(p)); } catch (e) { throw new Error(S.replay.cannotResolve(what, relative(ws, p), msg(e).slice(0, 200))); }
  if (!inside(wsReal, real)) throw new Error(S.replay.linksOut(what, relative(ws, p), real));
}

/**
 * 新版的脚本（flow.json 的 replayOverlay）：从流程目录所在的仓库（git rev-parse --show-toplevel）照原路径拷进回放的工作区，
 * 在基准提交和新的流程目录之后、准备命令之前。链接不拷、拷到工作区外面的不拷；仓库找不到、文件没有：记一句、warn，照跑。
 * 只读那个仓库；拷进来的只是工具，不在提案里，不算回放的改动（compare.md 单列一行）
 */
async function overlay(deps: ReplayDeps, r: ReplayRun, ws: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  let root: string;
  try { root = realpathSync((await git(deps, r.st.flowDir, ["rev-parse", "--show-toplevel"])).stdout.trim()); } catch (e) {
    r.st.notes.push(S.replay.overlayNoGit(r.st.flowDir, msg(e).slice(0, 200)));
    deps.log.warn("replay: the flow dir is not in a git checkout, replayOverlay skipped", { flowDir: r.st.flowDir, error: msg(e).slice(0, 200) });
    return;
  }
  const wsReal = realpathSync(ws);
  const done: string[] = [];
  for (const p of paths) {
    const src = join(root, p);
    const dst = join(wsReal, p);
    const skip = (why: string): void => {
      r.st.notes.push(S.replay.overlaySkipped(p, why));
      deps.log.warn("replay: an overlay file was not copied", { path: p, why });
    };
    let st: ReturnType<typeof lstatSync>;
    try { st = lstatSync(src); } catch { skip(S.replay.overlayMissing(root)); continue; }
    if (st.isSymbolicLink()) { skip(S.replay.overlayLink); continue; }
    if (!st.isFile()) { skip(S.replay.overlayNotFile); continue; }
    try {
      if (!inside(root, realpathSync(src))) { skip(S.replay.overlayOutside(root)); continue; }
      if (!inside(wsReal, dst)) { skip(S.replay.overlayEscapes); continue; }
      // 建目录之前：离它最近的已经有的上一级（工作区里提交了的目录链接也算）解开以后要在工作区里，不然 mkdir 会顺着链接建到外面去
      if (!inside(wsReal, realpathSync(nearestExisting(dirname(dst))))) { skip(S.replay.overlayEscapes); continue; }
      mkdirSync(dirname(dst), { recursive: true });
      if (!inside(wsReal, realpathSync(dirname(dst)))) { skip(S.replay.overlayEscapes); continue; }
      let old: ReturnType<typeof lstatSync> | null = null;
      try { old = lstatSync(dst); } catch { /* 基准里没有 */ }
      if (old && !old.isFile()) { skip(S.replay.overlayTargetLink); continue; }
      copyFileSync(src, dst);
      chmodSync(dst, st.mode & 0o777);
      done.push(p);
    } catch (e) { skip(S.replay.overlayCopyFailed(msg(e).slice(0, 200))); }
  }
  r.st.overlaid = done;
  deps.log.info("replay: overlay files copied", { root, files: done });
}

/**
 * 回放的准备（flow.json 的 replayPrep）：那一天还没有 sleep/<日>/slices/ 时，在回放的工作区里按顺序跑这几条命令（{day} 换成日子；
 * 子进程没有 OpenAI）。哪一条没跑成：记 warn、在 compare.md 写一句、后面的不跑，各段的材料给整份 input.md
 */
async function prep(deps: ReplayDeps, r: ReplayRun, ws: string, cmds: string[][]): Promise<void> {
  const slices = join(ws, "sleep", r.st.day, "slices");
  if (!cmds.length || existsSync(slices)) return;
  const env = envArgs(childEnv(deps, ws, join(r.st.dir, "state", "config.json"), join(r.st.dir, "hh.db")));
  for (const c of cmds) {
    const [cmd = "", ...args] = replayArgs(c, { day: r.st.day, tz: deps.cfg.schedule.timezone, nightSleep: deps.cfg.schedule.nightSleep });
    const line = [cmd, ...args].join(" ");
    let x: RunResult;
    try { x = await deps.run("/usr/bin/env", [...env, PYTHONS.has(cmd) ? deps.cfg.tools.python : cmd, ...args], { cwd: ws, timeoutMs: PREP_MS }); } catch (e) { x = { code: -1, stdout: "", stderr: msg(e) }; }
    if (x.code !== 0) {
      const out = (x.stderr || x.stdout).trim().slice(0, 200);
      r.st.notes.push(S.replay.prepFailed(line, x.code, out));
      deps.log.warn("replay: a replayPrep command failed, stages get the whole input.md", { command: line, code: x.code, out });
      return;
    }
    r.st.notes.push(S.replay.prepLine(line));
  }
  const n = existsSync(slices) ? readdirSync(slices).length : 0;
  r.st.notes.push(S.replay.slices(n));
  deps.log.info("replay: prep done", { commands: cmds.length, slices: n });
}

async function runIt(deps: ReplayDeps, r: ReplayRun, nb: NightBrain): Promise<void> {
  const read = readNight({ cfg: nb.cfg, read: nb.readText, write: (p, s) => nb.fs.write(p, s) });
  if (!read.plan) throw new Error(S.replay.flowUnusable(read.why, read.problems.length ? S.replay.problemsNote(read.problems.slice(0, 5).join(S.marks.clauseSep)) : ""));
  const { plan, skipped } = skipScripts(read.plan);
  r.st.skipped = skipped;
  await overlay(deps, r, nb.cfg.workspace, plan.flow.replayOverlay ?? []);
  await prep(deps, r, nb.cfg.workspace, plan.flow.replayPrep ?? []);
  const sc = deps.cfg.sleep;
  const weights = sleepWeights(sc.weights);
  const budget = new Budget({ unitsPerPct: sc.unitsPerPct, targetPct: plan.flow.budget.targetPct, hardPct: plan.flow.budget.hardPct });
  r.budget = budget;
  const night = replayNight(r.st.day);
  const { hosts, runner } = assembleNight(nb, plan, { night, budget, weights, auditMs: sc.auditMinutes * 60_000, watchdogMs: sc.watchdogHours * 3_600_000, maxDays: 1, replay: true });
  r.hosts = hosts;
  r.runner = runner;
  if (r.aborted) runner.abort(r.aborted);
  deps.log.info("replay: night starts", { day: r.st.day, flow: plan.hash, stages: plan.flow.stages.length, skipped });
  let given = false;
  const res = await runner.runNight({
    night,
    pending: async () => (given ? null : ((given = true), r.st.day)),
    backlog: async () => 1,
  });
  r.st.result = res;
  r.st.runId = res.runId;
  deps.log.info("replay: night done", { day: r.st.day, ...res });
  // 落地那几步（replayFinish）动了提案：这次回放不能信，算没跑成（说是哪条命令）
  if (res.stoppedBy === "error" && res.error?.startsWith(S.leadprompts.finishTouchedHead)) throw new Error(res.error);
}

// ---------- 出来的东西 ----------

/** 没跑完（出错、中止）时各个结果文件最上面那一句 */
const unfinishedMark = (r: ReplayRun): string => S.replay.unfinished(r.st.phase === "aborted" ? S.replay.phase.aborted : S.replay.phase.failed, (r.st.error ?? "").slice(0, 300));

/** 这一次回放在拷贝里记账的那一夜（runNight 还没回来时按夜名找） */
function runIdOf(r: ReplayRun, db: Db): number | null {
  if (r.st.runId !== null) return r.st.runId;
  return one<{ id: number }>(db, "SELECT id FROM sleep_run WHERE night = ? ORDER BY id DESC LIMIT 1", replayNight(r.st.day))?.id ?? null;
}

/**
 * 结果文件：报告、各段记录、提案、记账行、对比。没跑完（unfinished）也写：有什么写什么，每个文件最上面标「回放没跑完」；
 * 工作区、拷贝还没有的那部分就空着
 */
async function outputs(deps: ReplayDeps, r: ReplayRun, ws: string, db: Db | null, legacyOps: number, unfinished: boolean): Promise<void> {
  const out = join(r.st.dir, "out");
  const day = r.st.day;
  const mark = unfinished ? unfinishedMark(r) : null;
  const dayDir = ws ? join(ws, "sleep", day) : null;
  const report = dayDir ? readOr(join(dayDir, "report.md")) : null;
  if (report !== null || mark) writeFileSync(join(out, "report.md"), mark ? `${mark}\n\n${report ?? S.replay.noReportYet}` : report!);
  for (const [sub, dst] of [["flow", "records"], ["proposed", "proposed"], ["deferred", "deferred"]] as const) {
    if (dayDir && existsSync(join(dayDir, sub))) cpSync(join(dayDir, sub), join(out, dst), { recursive: true });
  }
  mkdirSync(join(out, "records"), { recursive: true });
  const runId = db ? runIdOf(r, db) : null;
  const runRow = db && runId !== null ? one<Record<string, unknown>>(db, "SELECT * FROM sleep_run WHERE id = ?", runId) ?? null : null;
  const stages = db && runId !== null ? all<Record<string, unknown>>(db, "SELECT * FROM sleep_stage WHERE run_id = ? ORDER BY id", runId) : [];
  const exams = db ? all<Record<string, unknown>>(db, "SELECT * FROM exam_result WHERE day = ? ORDER BY id", day) : [];
  writeFileSync(join(out, "ledger.json"), JSON.stringify({ ...(mark ? { note: mark } : {}), sleep_run: runRow, sleep_stage: stages, exam_result: exams }, null, 2));
  let cmp: string;
  try { cmp = await compareText(deps, r, ws, db, stages, legacyOps); } catch (e) {
    cmp = S.replay.compareFailed(day, msg(e).slice(0, 300));
  }
  writeFileSync(join(out, "compare.md"), mark ? `${mark}\n\n${cmp}` : cmp);
}

/** 一个文件的 +/- 行数（git diff --no-index --numstat）；a 是 null = 新文件 */
async function numstat(deps: ReplayDeps, cwd: string, a: string | null, b: string): Promise<{ add: number; del: number; patch: string }> {
  const args = ["diff", "--no-index", "--numstat", "--", a ?? "/dev/null", b];
  const n = await git(deps, cwd, args, [0, 1]);
  const [add = "0", del = "0"] = (n.stdout.split("\n")[0] ?? "").split("\t");
  const p = await git(deps, cwd, ["diff", "--no-index", "--", a ?? "/dev/null", b], [0, 1]);
  return { add: Number(add) || 0, del: Number(del) || 0, patch: p.stdout };
}

const pm = (x: { add: number; del: number } | undefined): string => (x ? `+${x.add} −${x.del}` : "—");

async function compareText(deps: ReplayDeps, r: ReplayRun, ws: string, db: Db | null, stages: Array<Record<string, unknown>>, legacyOps: number): Promise<string> {
  const W = resolve(deps.cfg.workspace);
  const day = r.st.day;
  const base = r.st.base ?? S.replay.notSet;
  const out = join(r.st.dir, "out");
  // 旧的整理：每个落地提交自己改的（不算 sleep/ 下面的整理工作文件）
  const legacy = new Map<string, { add: number; del: number }>();
  const legacyPatch: string[] = [];
  for (const c of r.st.landing) {
    const n = await git(deps, W, ["show", "--numstat", "--format=", c]);
    for (const line of n.stdout.split("\n").filter(Boolean)) {
      const [a = "0", d = "0", ...rest] = line.split("\t");
      const p = rest.join("\t");
      if (!p || p.startsWith("sleep/")) continue;
      const cur = legacy.get(p) ?? { add: 0, del: 0 };
      legacy.set(p, { add: cur.add + (Number(a) || 0), del: cur.del + (Number(d) || 0) });
    }
    legacyPatch.push((await git(deps, W, ["show", "--format=commit %H%n%s%n", c, "--", ".", ":(exclude)sleep"])).stdout);
  }
  writeFileSync(join(out, "legacy.patch"), legacyPatch.join("\n"));
  // 回放：提案（sleep/<日>/proposed/<路径>）对基准提交里的样子
  const proposedRoot = ws ? join(ws, "sleep", day, "proposed") : join(r.st.dir, "ws-missing");
  const replay = new Map<string, { add: number; del: number }>();
  const replayPatch: string[] = [];
  // 基准提交里的样子写在这儿给 git diff 比，是草稿：比完（比出错也）删掉，不留在回放目录里（#0055）
  const scratch = join(r.st.dir, "tmp");
  const tmp = join(scratch, "base");
  try {
    for (const p of filesUnder(proposedRoot)) {
      const show = await deps.run("git", ["show", `${base}:${p}`], { cwd: ws, timeoutMs: GIT_MS });
      let a: string | null = null;
      if (show.code === 0) {
        a = join(tmp, p);
        mkdirSync(dirname(a), { recursive: true });
        writeFileSync(a, show.stdout);
      }
      const s = await numstat(deps, ws, a, join(proposedRoot, p));
      replay.set(p, { add: s.add, del: s.del });
      replayPatch.push(`### ${p}\n${s.patch}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  writeFileSync(join(out, "replay.patch"), replayPatch.join("\n"));

  const lines: string[] = [S.replay.compare.title(day), ""];
  const res = r.st.result;
  lines.push(
    S.replay.compare.base(base),
    S.replay.compare.landing(r.st.landing.length ? r.st.landing.join(S.marks.listSep) : S.replay.compare.noneParen),
    S.replay.compare.dir(r.st.dir, r.st.flowDir),
    S.replay.compare.result(res ? S.replay.compare.resultLine(res.stoppedBy, res.error ? S.replay.errorNote(res.error.slice(0, 200)) : "", res.landed.join(S.marks.listSep) || S.replay.compare.none, res.deferredDays.join(S.marks.listSep) || S.replay.compare.none) : S.replay.compare.notFinished),
    S.replay.compare.skipped(r.st.skipped.join(S.marks.listSep) || S.replay.compare.none),
    ...(r.st.overlaid?.length ? [S.replay.compare.overlaid(r.st.overlaid.join(S.marks.listSep))] : []),
    ...r.st.notes.map((n) => `- ${n}`),
    "",
    S.replay.compare.filesHead,
    S.replay.compare.filesCols,
    "|---|---|---|---|",
  );
  const files = [...new Set([...legacy.keys(), ...replay.keys()])].sort();
  for (const f of files) {
    const both = legacy.has(f) && replay.has(f) ? S.replay.compare.both : legacy.has(f) ? S.replay.compare.legacyOnly : S.replay.compare.replayOnly;
    lines.push(`| ${f} | ${pm(legacy.get(f))} | ${pm(replay.get(f))} | ${both} |`);
  }
  if (!files.length) lines.push(S.replay.compare.noFiles);
  lines.push("", S.replay.compare.patches, "");

  // 事件库：旧的整理那一夜写的行数（撤掉的批次） vs 回放里过了的段提交的行数
  const replayOps = !db ? [] : all<{ id: string; n: number }>(db,
    "SELECT b.id AS id, (SELECT count(*) FROM mem_op o WHERE o.batch = b.id) AS n FROM mem_batch b WHERE substr(b.id, 1, length(?)) = ? AND b.state = 'committed' ORDER BY b.started_at",
    `sleep:${day}/`, `sleep:${day}/`);
  const after = r.st.after;
  lines.push(S.replay.compare.storeHead,
    !db ? S.replay.compare.storeNotCopied
      : r.st.reverted.length ? S.replay.compare.legacyOps(legacyOps, r.st.reverted.map((x) => `${x.batch} ${x.ops}`).join(S.marks.listSep))
      : S.replay.compare.noLegacyBatch,
    S.replay.compare.replayOps(replayOps.reduce((a, x) => a + x.n, 0), replayOps.map((x) => `${x.id} ${x.n}`).join(S.marks.listSep) || S.replay.compare.noBatches),
    ...(after.length ? [S.replay.compare.after(after.length, after.reduce((a, x) => a + x.ops, 0), after.slice(0, 60).map((x) => `${x.batch} ${x.ops}`).join(S.marks.listSep), after.length > 60 ? S.replay.compare.moreInFile : "")] : []),
    ...(r.st.reverted.some((x) => x.conflicts.length) ? [S.replay.compare.conflicts(r.st.reverted.reduce((a, x) => a + x.conflicts.length, 0))] : []),
    "");

  // 各段：过了 / 重做几轮 / 推迟；审的、协调的、考试的分数、单位（这几列账上有才写）
  lines.push(S.replay.compare.stagesHead, S.replay.compare.stagesCols, "|---|---|---|---|---|---|---|---|---|");
  const byStage = new Map<string, Array<Record<string, unknown>>>();
  for (const s of stages) byStage.set(String(s.stage), [...(byStage.get(String(s.stage)) ?? []), s]);
  const col = (rows: Array<Record<string, unknown>>, k: string): string => [...new Set(rows.map((x) => x[k]).filter((v) => v !== null && v !== undefined && v !== "").map(String))].join(S.marks.listSep) || "—";
  const num = (v: unknown): string => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : "—");
  for (const [id, rows] of byStage) {
    const last = rows[rows.length - 1]!;
    const status = String(last.status);
    const what = rows[0]!.model === "script" ? (String(last.verdict ?? "").startsWith(S.replay.skipPrefix) ? S.replay.compare.skippedWord : S.replay.compare.script(status)) : status;
    const tries = rows.length;
    const exam = rows.filter((x) => x.questions !== null && x.questions !== undefined).map((x) => S.replay.compare.exam(num(x.score_before), num(x.score_after), num(x.hidden_score), num(x.questions))).join(S.marks.clauseSep) || "—";
    const units = rows.reduce((a, x) => a + (Number(x.units) || 0), 0);
    lines.push(`| ${id} | ${col(rows, "region")} | ${col(rows, "persona")} | ${what} | ${tries}${tries > 1 ? S.replay.compare.redone(tries - 1) : ""} | ${col(rows, "reviewer")} | ${col(rows, "decision")} | ${exam} | ${Math.round(units)} |`);
  }
  if (!byStage.size) lines.push(S.replay.compare.noStages);
  // 花费按角色（记账的 cost 那一列有 lead 才写：专员 + 领导的夜里）：做的、领导、考试，各段一行，最后合计
  const roles = [["do", S.replay.role.do], ["lead", S.replay.role.lead], ["exam", S.replay.role.exam]] as const;
  // 每个专员考了没有（记账的 examined）、各种题几道（records/lead/<段>.json 里记的）
  const PROBES = ["keep", "new", "missed", "continuity"] as const;
  const examinedOf = (rows: Array<Record<string, unknown>>): string => {
    const xs = rows.map((x) => x.examined).filter((v) => v === 0 || v === 1);
    return !xs.length ? S.replay.examined.no : xs.every((v) => v === 1) ? S.replay.examined.yes : S.replay.examined.failed;
  };
  const countsOf = (id: string): string => {
    try {
      const c = (JSON.parse(readFileSync(join(out, "records", "lead", `${id}.json`), "utf8")) as { counts?: Record<string, number> }).counts;
      return c ? PROBES.map((p) => Number(c[p]) || 0).join(" / ") : "—";
    } catch { return "—"; }
  };
  const costOf = (row: Record<string, unknown>): Record<string, number> | null => {
    try { const c = typeof row.cost === "string" && row.cost ? (JSON.parse(row.cost) as Record<string, number>) : null; return c && typeof c.lead === "number" ? c : null; } catch { return null; }
  };
  const costs = [...byStage].flatMap(([id, rows]) => {
    const cs = rows.map(costOf).filter((c): c is Record<string, number> => c !== null);
    return cs.length ? [{ id, sum: roles.map(([k]) => cs.reduce((a, c) => a + (Number(c[k]) || 0), 0)), examined: examinedOf(rows), counts: countsOf(id) }] : [];
  });
  if (costs.length) {
    lines.push("", S.replay.compare.costHead, S.replay.compare.costCols(roles.map(([, n]) => n).join(" | "), PROBES.join(" / ")), `|---|${roles.map(() => "---").join("|")}|---|---|`);
    for (const c of costs) lines.push(`| ${c.id} | ${c.sum.map((v) => Math.round(v)).join(" | ")} | ${c.examined} | ${c.counts} |`);
    lines.push(S.replay.compare.costSum(roles.map((_, i) => Math.round(costs.reduce((a, c) => a + c.sum[i]!, 0))).join(" | ")));
    // 领导判是题的毛病、改过标准答案的题（records/lead/<段>.json 的 revised）：列出来，原来的和改成的
    const revised = costs.flatMap((c) => {
      try { return ((JSON.parse(readFileSync(join(out, "records", "lead", `${c.id}.json`), "utf8")) as { revised?: Array<{ id: string; q?: string; from: string; to: string; answers?: string[]; why?: string }> }).revised ?? [])
        .map((x) => S.replay.compare.revised(c.id, x.id, x.q ? S.replay.quoted(x.q) : "", x.from, x.to, (x.answers ?? []).map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep) || S.replay.notNoted, x.why || S.runner.report.notWritten)); } catch { return []; }
    });
    if (revised.length) lines.push("", S.replay.compare.revisedHead, ...revised);
    // 撤掉的题（records/lead/<段>.json 的 withdrawn）：题、标准答案、她两轮答的、哪一种、两个词、出处和原文
    const withdrawn = costs.flatMap((c) => {
      try {
        return ((JSON.parse(readFileSync(join(out, "records", "lead", `${c.id}.json`), "utf8")) as { withdrawn?: Array<{ id: string; q: string; gold: string; answers: string[]; kind: string; tokens: string[]; refs: string[]; excerpts: string[]; why: string }> }).withdrawn ?? [])
          .map((x) => S.replay.compare.withdrawn(c.id, x.id, x.q, x.gold, x.answers.map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep), x.kind, x.tokens.map((k) => S.replay.quoted(k)).join(S.replay.answerSep), x.refs.map((r, i) => S.marks.labeled(r, x.excerpts[i] ?? "")).join(S.replay.refSep), x.why || S.runner.report.notWritten));
      } catch { return []; }
    });
    if (withdrawn.length) lines.push("", S.replay.compare.withdrawnHead, ...withdrawn);
    // 改了标准答案的题（records/lead/<段>.json 的 corrected）：原来的、改成的、她两轮答的、出处和原文
    const corrected = costs.flatMap((c) => {
      try {
        return ((JSON.parse(readFileSync(join(out, "records", "lead", `${c.id}.json`), "utf8")) as { corrected?: Array<{ id: string; q: string; gold: string; newGold: string; answers: string[]; refs: string[]; excerpts: string[]; unreadable?: string[]; why: string }> }).corrected ?? [])
          .map((x) => S.replay.compare.corrected(c.id, x.id, x.q, x.gold, x.newGold, x.answers.map((a) => S.replay.quoted(a || S.marks.noAnswer)).join(S.replay.answerSep), x.refs.map((r, i) => S.marks.labeled(r, x.excerpts[i] ?? "")).join(S.replay.refSep), x.unreadable?.length ? S.replay.compare.unchecked(x.unreadable.join(S.marks.listSep)) : "", x.why || S.runner.report.notWritten));
      } catch { return []; }
    });
    if (corrected.length) lines.push("", S.replay.compare.correctedHead, ...corrected);
    // 每个会话的开头多大（第一次调用的输入 token；records/lead/sessions.json）：专员、领导、考试的会话各一行
    try {
      const sizes = JSON.parse(readFileSync(join(out, "records", "lead", "sessions.json"), "utf8")) as Array<{ id: string; role: string; opening: number | null }>;
      const ROLE: Record<string, string> = { specialist: S.replay.sessionRole.specialist, lead: S.replay.sessionRole.lead, exam: S.replay.sessionRole.exam };
      lines.push("", S.replay.compare.openingHead, S.replay.compare.openingCols, "|---|---|---|");
      for (const x of sizes) lines.push(`| ${x.id} | ${ROLE[x.role] ?? x.role} | ${typeof x.opening === "number" ? x.opening : "—"} |`);
    } catch { /* 没有这份记录（老的回放、flow 的夜里）：不列 */ }
  }
  return `${lines.join("\n")}\n`;
}

/**
 * no-openai.txt：只写它证明得了的。结论只看闸的计数（拦下几次，0 才 PASS）；拷贝里的学习花费账照构造不会变（回放不建判断），
 * 前后照写；主库的账只是参考（她醒着，白天的系统可能在花）
 */
function noOpenAIText(r: ReplayRun, live: { before: Spend; after: Spend | null }, copyAfter: Spend | null): string {
  const s = (x: Spend | null): string => (x ? S.replay.keysRead(x.keys, x.tokens) : S.replay.notRead);
  const copy = r.copySpend;
  return [
    S.replay.noOpenai.head(r.st.dir, r.st.day),
    `api.openai.com requests from the replay (counted by the guard): ${r.guard.blocked}`,
    "how it is kept at 0: event memory embedder null (keyword recall only); no learning judge; worklist without vectors; OpenAI key never read; the guard checks fetch / https at call time",
    `child processes (session Bash, check scripts, prep): ${Object.entries(NO_OPENAI_ENV).map(([k, v]) => `${k}=${v || "(empty)"}`).join(", ")}`,
    S.replay.noOpenai.children(join(r.st.dir, "state", "config.json")),
    copy === null
      ? "learn.spend, replay copy db: (no copy made — the replay stopped before the event-store phase, nothing of the replay was built)"
      : `learn.spend, replay copy db (the replay's own ledger): unchanged by construction (the replay builds no judge) — before ${s(copy)}; after ${s(copyAfter)}; equal: ${copyAfter !== null && sameSpend(copy, copyAfter) ? "yes" : "NO"}`,
    `learn.spend, live db: informational (her live system may spend while awake): before ${s(live.before)}; after ${s(live.after)}`,
    `verdict: ${r.guard.blocked === 0 ? "PASS" : "FAIL"} — the guard blocked ${r.guard.blocked} api.openai.com requests from the replay (PASS only if 0)`,
    "",
  ].join("\n");
}

async function pipeline(deps: ReplayDeps, r: ReplayRun, o: ReplayOpts): Promise<void> {
  const liveBefore = spendOf(deps.db);
  let ws = "";
  let legacyOps = 0;
  const phase = (p: Phase): void => {
    if (r.aborted) throw new Error(S.teamrun.aborted(r.aborted));
    r.st.phase = p;
    r.save();
  };
  try {
    // 不知道子进程按哪个环境变量找工作区：她的脚本会找到真的 W，不跑（准备命令、段的会话都不开；库也不拷）
    if (!Object.keys(workspaceEnv(deps.cfg, join(r.st.dir, "ws"))).length) throw new Error(S.replay.noWorkspaceEnv);
    phase("workspace");
    ws = await workspace(deps, r, o);
    phase("store");
    const s = await store(deps, r, ws);
    legacyOps = s.legacyOps;
    phase("run");
    await runIt(deps, r, replayBrain(deps, r, ws, s.db, s.mem));
    if (r.aborted) throw new Error(S.teamrun.aborted(r.aborted));
    phase("output");
    await outputs(deps, r, ws, s.db, legacyOps, false);
    r.st.phase = "done";
  } catch (e) {
    r.st.error = msg(e).slice(0, 1000);
    r.st.phase = r.aborted ? "aborted" : "failed";
    deps.log.error("replay: failed", { dir: r.st.dir, error: e instanceof Error ? e.stack ?? e.message : String(e) });
  } finally {
    try { await r.hosts?.shut(); } catch (e) { r.warnOnce("shut", "replay: shutting the replay's sessions failed", e); }
    // 没跑完：有什么写什么，标「回放没跑完」
    if (r.st.phase !== "done") {
      try { await outputs(deps, r, ws, r.copy, legacyOps, true); } catch (e) { deps.log.warn("replay: writing the unfinished outputs failed", { error: msg(e).slice(0, 300) }); }
    }
    let copyAfter: Spend | null = null;
    try { if (r.copy) copyAfter = spendOf(r.copy); } catch { /* 下面写没读到 */ }
    let liveAfter: Spend | null = null;
    try { liveAfter = spendOf(deps.db); } catch { /* 下面写没读到 */ }
    try { writeFileSync(join(r.st.dir, "out", "no-openai.txt"), noOpenAIText(r, { before: liveBefore, after: liveAfter }, copyAfter)); } catch (e) {
      deps.log.error("replay: writing no-openai.txt failed", { error: msg(e) });
    }
    try { r.copy?.close(); } catch { /* 关过了 */ }
    r.st.endedAt = deps.now();
    r.save();
    deps.log.info("replay: over", { dir: r.st.dir, phase: r.st.phase, blocked: r.guard.blocked, error: r.st.error });
  }
}

// ---------- 一个 hhd 里同时只有一个 ----------

const stamp = (t: number): string => new Date(t).toISOString().replace(/[:.]/g, "-");

export class ReplayManager {
  private cur: ReplayRun | null = null;
  private last: ReplayRun | null = null;

  /** 开一个回放：马上返回回放目录，后台跑；正在跑一个就抛错（不开第二个） */
  start(deps: ReplayDeps, o: ReplayOpts): { dir: string; done: Promise<void> } {
    if (!DAY.test(o.day)) throw new Error(S.replay.badDay(o.day));
    if (this.cur) throw new Error(S.replay.busy(this.cur.st.day, this.cur.st.dir));
    const root = join(deps.cfg.stateDir, "replay");
    let ts = stamp(deps.now());
    for (let i = 2; existsSync(join(root, ts)); i++) ts = `${stamp(deps.now())}-${i}`;
    const dir = join(root, ts);
    mkdirSync(join(dir, "out"), { recursive: true });
    const flowDir = resolve(o.flowDir ?? join(deps.cfg.workspace, dirname(deps.cfg.sleep.flowFile)));
    const guard = new OpenAIGuard((m, data) => deps.log.warn(m, data));
    const r = new ReplayRun({
      ts, dir, day: o.day, base: o.base ?? null, flowDir, phase: "workspace", startedAt: deps.now(), endedAt: null, error: null,
      blocked: 0, landing: [], reverted: [], after: [], skipped: [], runId: null, result: null, notes: [],
    }, guard, deps.log);
    r.save();
    this.cur = r;
    const uninstall = installOpenAIGuard();
    deps.log.info("replay: starting", { day: o.day, dir, base: o.base ?? null, flowDir });
    r.done = guard.run(() => pipeline(deps, r, { ...o, flowDir }))
      .finally(() => {
        uninstall();
        this.last = r;
        if (this.cur === r) this.cur = null;
      });
    return { dir, done: r.done };
  }

  /** hh sleep replay-status：跑着的那一个；没在跑就是最近一个（读它的 status.json） */
  status(stateDir: string, now: number): string {
    const r = this.cur ?? this.last;
    if (r) return statusText(r.st, r.guard.blocked, now, this.cur === r ? r : null);
    const root = join(stateDir, "replay");
    const latest = (() => { try { return readdirSync(root).filter((n) => existsSync(join(root, n, "status.json"))).sort().at(-1) ?? null; } catch { return null; } })();
    if (!latest) return S.replay.neverRun;
    try {
      const st = JSON.parse(readFileSync(join(root, latest, "status.json"), "utf8")) as ReplayState;
      const over = st.phase === "done" || st.phase === "failed" || st.phase === "aborted";
      return statusText(st, st.blocked, now, null) + (over ? "" : S.replay.restarted);
    } catch (e) { return S.replay.statusUnreadable(latest, msg(e)); }
  }

  /** 有没有回放在跑 */
  get running(): boolean { return this.cur !== null; }

  /**
   * 手上的回放还该不该让部署的重启等一等：真的在跑才等——已经叫停了的不等，开跑超过 limitMs（它自己整夜的看门狗时长加一点余量）的也不等
   * （收不了尾的回放不能把重启一直拦着）
   */
  holdsRestart(now: number, limitMs: number): boolean {
    const r = this.cur;
    return r !== null && !r.aborted && now - r.st.startedAt <= limitMs;
  }

  /**
   * 叫停手上的回放（hh sleep replay-stop、真的夜里要开始、hhd 停机）：runner 叫停、开着的会话全关，等它收尾（有上限）；
   * 为什么停记进它的状态。没有在跑的就这么说
   */
  async stop(why: string): Promise<string> {
    const r = this.cur;
    if (!r) return S.replay.notRunning;
    if (!r.aborted) {
      r.aborted = why;
      r.st.notes.push(S.replay.stoppedWhy(why));
      r.save();
    }
    r.runner?.abort(why);
    await Promise.race([Promise.resolve().then(() => r.hosts?.shut()).catch((e: unknown) => r.warnOnce("shut", "replay: shutting the replay's sessions failed", e)).then(() => r.done), new Promise<void>((ok) => { setTimeout(ok, STOP_WAIT_MS).unref(); })]);
    return S.replay.stopped(why, r.st.dir);
  }
}

function statusText(st: ReplayState, blocked: number, now: number, live: ReplayRun | null): string {
  const mins = (ms: number): string => S.replay.minutes(Math.round(ms / 60_000));
  const word: Record<Phase, string> = { workspace: S.replay.phaseWord.workspace, store: S.replay.phaseWord.store, run: S.replay.phaseWord.run, output: S.replay.phaseWord.output, done: S.replay.phaseWord.done, failed: S.replay.phase.failed, aborted: S.replay.phase.aborted };
  const lines = [
    S.replay.status.head(st.day, word[st.phase], st.error ? S.replay.errorNote(st.error.slice(0, 300)) : ""),
    S.replay.status.dir(st.dir),
    S.replay.status.base(st.base ?? S.replay.notSet, st.flowDir),
    S.replay.status.started(new Date(st.startedAt).toISOString(), st.endedAt ? S.replay.status.took(mins(st.endedAt - st.startedAt)) : S.replay.status.running(mins(now - st.startedAt))),
    S.replay.status.blocked(blocked),
  ];
  if (st.reverted.length) lines.push(S.replay.status.reverted(st.reverted.map((x) => S.replay.status.batch(x.batch, x.ops, x.conflicts.length)).join(S.marks.listSep)));
  if (st.skipped.length) lines.push(S.replay.status.skipped(st.skipped.join(S.marks.listSep)));
  if (st.after?.length) lines.push(S.replay.status.after(st.after.length));
  for (const n of st.notes ?? []) lines.push(n);
  if (live?.budget) lines.push(S.replay.status.spending(live.budget.pct.toFixed(2), live.budget.targetPct, live.budget.hardPct));
  if (live?.copy && st.runId === null) {
    try {
      const run = one<{ id: number }>(live.copy, "SELECT id FROM sleep_run WHERE night = ? ORDER BY id DESC LIMIT 1", replayNight(st.day));
      const rows = run ? all<{ stage: string; attempt: number; status: string; units: number | null }>(live.copy, "SELECT stage, attempt, status, units FROM sleep_stage WHERE run_id = ? ORDER BY id", run.id) : [];
      if (rows.length) lines.push(S.replay.status.stagesHead, ...rows.map((x) => S.replay.status.stage(x.stage, x.attempt, x.status, x.units ? S.replay.status.units(Math.round(x.units)) : "")));
    } catch { /* 读不到就不列 */ }
  }
  if (live?.hosts?.sessions.size) lines.push(S.replay.status.sessions([...live.hosts.sessions.keys()].join(S.marks.listSep)));
  if (st.result) lines.push(S.replay.status.result(st.result.stoppedBy, st.result.landed.join(S.marks.listSep) || S.replay.compare.none));
  if (st.phase === "done" || st.phase === "failed" || st.phase === "aborted") lines.push(S.replay.status.see(join(st.dir, "out")));
  return lines.join("\n");
}

/**
 * 部署后的重启看的那份状态（hhd 每次 tick 交给 repair 的 RestartGate）：回放在跑时把「前台闲着」说成没闲着——
 * 重启会把跑到一半的回放打断（11-06 那次回放就是这样断的），等它跑完再重启。没有回放原样给
 */
export function restartStatus<T extends { frontIdle: boolean }>(s: T, replayRunning: boolean): T {
  return replayRunning ? { ...s, frontIdle: false } : s;
}
