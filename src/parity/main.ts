// 对照工具（parity）的入口：node src/parity/main.ts dump|census|diff …。
// dump 每个场景开一个子进程（同一个文件加 --child）：场景之间不串状态。子进程套在内核沙箱里起（sandbox.ts：只写得了 --work、--out，没有网），
// 环境从头列、不带外面的；进去以后先看自己是不是真在沙箱里，再查路径、装确定性和围栏、克隆快照（clone.ts）、断网断进程，
// 然后才动态 import 树里的模块。父进程一行树里的代码都不加载：它只 import Node 自带的和 parity 里不碰树的几个文件
// （scenario.ts 只登记名字，找状态目录的 config.json 也挪到了子进程里），test/parity.test.ts 查它的 import 图。
// census、diff 各在自己的分支里动态加载（diff 不加载 typescript，两个都不加载场景那一套）。
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { cloneSnapshot } from "./clone.ts";
import { installDeterminism } from "./determinism.ts";
import { assertOffLive, fencedHomes, installFence, overlap } from "./fence.ts";
import { installOffline } from "./offline.ts";
import { Recorder, TREE, canonical } from "./recorder.ts";
import { insideSandbox, sandboxProblem, sandboxProfile, sandboxed } from "./sandbox.ts";
import type { Manifest } from "./world.ts";

const SELF = fileURLToPath(import.meta.url);
const USAGE = [
  "usage: node src/parity/main.ts <command> …",
  "  dump --data <snapshot dir> --work <scratch dir> --out <empty or absent dir> [--config <file>] [--scenario <name>]… [--label <text>] [--timeout-min <n>] [--no-sandbox]",
  "  census --tree <repo dir> --out <file>",
  "  diff <out A> <out B> [--census <file A> <file B>] [--all] [--brief]",
  "  diff --census <file A> <file B> [--brief]",
].join("\n");
/** 一个场景最多跑多久（分钟）；到点先 SIGTERM（子进程把记录写到哪算哪），再等这么久还不走就 SIGKILL */
const DEFAULT_TIMEOUT_MIN = 30;
const KILL_GRACE_MS = 5_000;

const NO_SANDBOX = "parity: no kernel sandbox on this machine — scenario children would run unconfined; pass --no-sandbox to run anyway";
/** --work 里的记号文件：dump 第一次用这个目录时写下，以后凭它认「这是这个工具自己的草稿区」（克隆每次都把里面的 home、tmp 整个删掉重建） */
const WORK_MARKER = ".parity-work";

class UsageError extends Error {}
/** dump 不肯跑（--out 里有东西、套不上沙箱、子进程不在沙箱里）：只说原因、不打用法，退出 2 */
class Refusal extends Error {}

interface DumpArgs {
  data: string; work: string; out: string; config: string | null; scenarios: string[]; child: boolean;
  /** 这次 dump 的是什么（包装脚本给提交号）：原样记进 meta.json，diff 第一行打出来；不给就是 null */
  label: string | null;
  /** 场景子进程不套内核沙箱（只剩 JS 围栏）；meta.json 里记 sandbox: false。父进程也把它传给子进程：子进程见了才肯不在沙箱里跑 */
  noSandbox: boolean;
  /** 只在 --child 上：起它的 dump 的 pid。子进程自查「在不在沙箱里」时要它的父进程就是这个号（sandbox.ts insideSandbox） */
  parent: number | null;
  /** 一个场景的时限（毫秒）和报出来怎么说（「30 min」） */
  timeoutMs: number; timeoutLabel: string;
}

const DUMP_OPTIONS = {
  data: { type: "string" }, work: { type: "string" }, out: { type: "string" }, config: { type: "string" },
  scenario: { type: "string", multiple: true }, child: { type: "boolean" }, "timeout-min": { type: "string" }, "no-sandbox": { type: "boolean" },
  label: { type: "string" }, parent: { type: "string" },
  // 只给测试用（不写进用法）：时限短到哪台机器都跑不完，超时那条路才测得稳
  "timeout-ms": { type: "string" },
} as const;

function parseDump(argv: string[]): DumpArgs {
  const parse = () => parseArgs({ args: argv, strict: true, allowPositionals: false, options: DUMP_OPTIONS }).values;
  let v: ReturnType<typeof parse>;
  try { v = parse(); } catch (e) { throw new UsageError(e instanceof Error ? e.message : String(e)); }
  if (!v.data || !v.work || !v.out) throw new UsageError("dump needs --data, --work and --out");
  const [raw, unit, scale] = v["timeout-ms"] !== undefined ? [v["timeout-ms"], "ms", 1] as const : [v["timeout-min"] ?? String(DEFAULT_TIMEOUT_MIN), "min", 60_000] as const;
  const amount = Number(raw);
  if (!(amount > 0) || !Number.isFinite(amount)) throw new UsageError(`--timeout-${unit} needs a positive number`);
  return {
    data: resolve(v.data), work: resolve(v.work), out: resolve(v.out), config: v.config ? resolve(v.config) : null,
    scenarios: [...new Set(v.scenario ?? [])], child: v.child === true, noSandbox: v["no-sandbox"] === true, label: v.label ?? null,
    parent: v.parent !== undefined && /^\d+$/.test(v.parent) ? Number(v.parent) : null,
    timeoutMs: amount * scale, timeoutLabel: `${amount} ${unit}`,
  };
}

function readManifest(data: string): Manifest {
  const m = JSON.parse(readFileSync(join(data, "manifest.json"), "utf8")) as Partial<Manifest>;
  if (typeof m.id !== "string" || typeof m.takenAt !== "number" || typeof m.home !== "string" || !isAbsolute(m.home) || typeof m.tz !== "string") {
    throw new Error("parity: manifest.json needs id, takenAt (ms), an absolute home and tz");
  }
  return { id: m.id, takenAt: m.takenAt, home: resolve(m.home), tz: m.tz };
}

/** 快照只读、工作副本整个删掉重建、记录只往空的 --out 里写：三个目录两两不相交（谁也不在谁里面，也不是同一个） */
function assertApart(a: DumpArgs): void {
  for (const [x, y] of [["data", "work"], ["data", "out"], ["work", "out"]] as const) {
    if (overlap(a[x], a[y])) throw new Error(`parity: --${x} and --${y} must not overlap (${a[x]}, ${a[y]})`);
  }
}

/**
 * 工作副本里状态目录的 config.json（相对 <work>/home；在子进程里、围栏装好以后找）：不写死目录名，按配置自己的 stateDir 认——
 * home 下面一层目录里的 config.json，和树的默认配置合并后 stateDir 正好指着 <manifest.home>/<这个目录> 的那个
 */
async function stateConfigRel(cloneHome: string, liveHome: string): Promise<string> {
  const { loadConfig } = await import("../config.ts");
  const found: string[] = [];
  for (const d of readdirSync(cloneHome).sort()) {
    const f = join(cloneHome, d, "config.json");
    if (!existsSync(f) || !statSync(f).isFile()) continue;
    let over: unknown;
    try { over = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    const sd = loadConfig(over).stateDir;
    if (typeof sd === "string" && resolve(sd) === join(liveHome, d)) found.push(join(d, "config.json"));
  }
  if (found.length === 1) return found[0]!;
  throw new Error(found.length
    ? `parity: more than one state dir config.json in the snapshot (${found.join(", ")}); pass --config`
    : "parity: no state dir config.json in the snapshot (its stateDir must be <home>/<that dir>); pass --config");
}

/** dump 建的目录一律 0700（记录里是她的原话）；已经在的不动 */
function mkdirPrivate(p: string): void {
  if (!existsSync(p)) mkdirSync(p, { recursive: true, mode: 0o700 });
}

/** --out 得是空的或者还没有：dump 不删、不接着用里面的任何东西（上一次留下的记录、meta.json 混进这一次，diff 就可能拿旧的当新的比） */
function assertEmptyOut(out: string): void {
  if (!existsSync(out)) return;
  if (!statSync(out).isDirectory()) throw new Refusal(`parity: --out must be empty or absent (${out} is not a directory)`);
  const n = readdirSync(out).length;
  if (n > 0) throw new Refusal(`parity: --out must be empty or absent (${out} has ${n} entries)`);
}

/** <work> 里有这个工具的记号（一个普通文件，不是链接） */
function hasWorkMarker(work: string): boolean {
  try { return lstatSync(join(work, WORK_MARKER)).isFile(); } catch { return false; }
}

/**
 * --work 得是这个工具自己的草稿区：还没有（dump 来建）、空的、或者里面有它以前写下的记号。别的目录不碰——
 * 克隆要把 <work>/home、<work>/tmp 整个删掉，路径给错一个，删的就是别人的 home 目录
 */
function assertOwnWork(work: string): void {
  if (!existsSync(work)) return;
  if (!statSync(work).isDirectory()) throw new Refusal(`parity: --work must be absent, empty, or a scratch directory of this tool (${work} is not a directory)`);
  const n = readdirSync(work).length;
  if (n > 0 && !hasWorkMarker(work)) throw new Refusal(`parity: --work must be absent, empty, or a scratch directory of this tool (${work} has ${n} entries and no ${WORK_MARKER} marker)`);
}

/**
 * 场景子进程的环境从头列，不是「外面的减掉几样」：只带 PATH 和语言区域（LANG、LC_*），加 dump 自己定的 HOME、TMPDIR、TZ
 * （HH_CONFIG 子进程找到配置以后自己设）。外面的 NODE_OPTIONS、NODE_V8_COVERAGE、NODE_COMPILE_CACHE 会让子进程往草稿区外面写，
 * HH_* 会换掉配置：一个都不带。NODE_V8_COVERAGE 要明着写成 undefined：给的 env 里没有这个键，Node 起子进程时会自己把它补上
 */
function childEnv(a: DumpArgs, m: Manifest): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(([k]) => k === "PATH" || k === "LANG" || k.startsWith("LC_"));
  const probe = probeOf(process.env);
  return { ...Object.fromEntries(kept), HOME: join(a.work, "home"), TMPDIR: join(a.work, "tmp"), TZ: m.tz, NODE_V8_COVERAGE: undefined, ...(probe ? { HH_TEST: "1", HH_PARITY_PROBE: probe } : {}) };
}

/**
 * For the sandbox tests only (HH_TEST=1): HH_PARITY_PROBE names a script the scenario child loads inside the sandbox,
 * once the world is built and before the scenario runs, to show that nothing the tree runs can write outside. Unset: nothing.
 */
function probeOf(env: NodeJS.ProcessEnv): string | undefined {
  return env.HH_TEST === "1" && env.HH_PARITY_PROBE ? env.HH_PARITY_PROBE : undefined;
}

interface ChildExit { code: number | null; signal: string | null; timedOut: boolean }

/** 起一个场景子进程，等它退出；到了时限先 SIGTERM，宽限期过了还在就 SIGKILL */
function runChild(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<ChildExit> {
  return new Promise((done) => {
    const c = spawn(cmd, args, { env, cwd, stdio: ["ignore", "inherit", "inherit"] });
    let timedOut = false;
    let hard: ReturnType<typeof setTimeout> | undefined;
    const soft = setTimeout(() => {
      timedOut = true;
      c.kill("SIGTERM");
      hard = setTimeout(() => c.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    const finish = (r: ChildExit): void => { clearTimeout(soft); if (hard) clearTimeout(hard); done(r); };
    c.on("error", (e) => { console.error(`parity: cannot start the scenario process: ${e.message}`); finish({ code: null, signal: null, timedOut }); });
    c.on("exit", (code, signal) => finish({ code, signal, timedOut }));
  });
}

async function dump(a: DumpArgs): Promise<number> {
  const m = readManifest(a.data);
  const homes = fencedHomes(m.home);
  assertOffLive([a.data, a.work, join(a.work, "home"), a.out, ...(a.config ? [a.config] : [])], homes);
  assertApart(a);
  installFence(m.home, { guarded: homes });
  const { SCENARIOS } = await import("./scenario.ts");
  const known = SCENARIOS.map((s) => s.name);
  const names = a.scenarios.length ? a.scenarios : known;
  const unknown = names.filter((n) => !known.includes(n));
  if (unknown.length) throw new UsageError(`unknown scenario: ${unknown.join(", ")} (known: ${known.join(", ")})`);
  assertEmptyOut(a.out);
  assertOwnWork(a.work);
  // 套不上沙箱就不跑（什么都还没建）；--no-sandbox 是明说了不套，照跑、说一句、meta.json 里记下
  const profile = sandboxProfile(a.work, a.out);
  if (a.noSandbox) console.error("parity: --no-sandbox: scenario children run without the kernel sandbox (JS fences only)");
  else {
    const why = sandboxProblem(profile);
    if (why) throw new Refusal(`${NO_SANDBOX}\nparity: (${why})`);
  }
  mkdirPrivate(a.out);
  mkdirPrivate(a.work);
  if (!hasWorkMarker(a.work)) writeFileSync(join(a.work, WORK_MARKER), "scratch area of the parity tool: dump wipes home/ and tmp/ in here\n", { mode: 0o600, flag: "wx" });
  // 子进程：HOME 指到工作副本，临时目录在 <work>/tmp，当前目录是 <work>（相对路径、os.tmpdir() 都落在草稿区里）
  const env = childEnv(a, m);
  const results: Array<{ name: string; records: number; ok: boolean }> = [];
  let failed = 0;
  for (const name of names) {
    const file = join(a.out, name, "transcript.jsonl");
    // 父进程的 execArgv 不带：Node 24 自己就跑得了 .ts（去类型），子进程不需要别的开关
    const args = [SELF, "dump", "--child", "--parent", String(process.pid), "--scenario", name, "--data", a.data, "--work", a.work, "--out", a.out, ...(a.config ? ["--config", a.config] : [])];
    const run = a.noSandbox ? { cmd: process.execPath, args: [...args, "--no-sandbox"] } : sandboxed(profile, process.execPath, args);
    const r = await runChild(run.cmd, run.args, env, a.work, a.timeoutMs);
    const records = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
    // 子进程没写出记录就退出了（排着的 promise 永远等不到、进程自己空了）也算挂；挂了的照样列进 meta.json（带半截记录的条数、ok: false），
    // diff 见到 ok: false 就不算一样
    const ok = r.code === 0 && !r.timedOut && existsSync(file);
    if (!ok) failed += 1;
    results.push({ name, records, ok });
    const why = r.timedOut ? `timed out after ${a.timeoutLabel}` : `exit ${r.code ?? r.signal}`;
    console.log(`${name}\t${records}${ok ? "" : `\tFAILED (${why})`}`);
  }
  // meta.json 最后才写：半路断了的 dump 没有它，diff 见了不比。--out 子进程也写得了，所以只新建（wx）：
  // 那里已经有一个 meta.json（哪怕是个链接）就不写、不顺着它写，这次 dump 算挂
  const meta = join(a.out, "meta.json");
  try {
    writeFileSync(meta, `${canonical({ snapshot: m.id, sandbox: !a.noSandbox, label: a.label, scenarios: results })}\n`, { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw new Error(`parity: ${meta} appeared during the dump (--out was empty at the start) — not overwriting it; this dump has no valid meta.json`);
  }
  return failed ? 1 : 0;
}

/**
 * 一个场景的子进程：看自己在不在沙箱里 → 查路径 → 装确定性、围栏 → 克隆 → 断网断进程 → 建世界 → 跑场景 → 写记录
 * （挂了、超时也写，最后一条是出错的 log）
 */
async function child(a: DumpArgs): Promise<number> {
  // 手工起的 --child、父进程哪天改漏了没套沙箱：不在沙箱里就不跑（什么都还没碰）。只有父进程明着传了 --no-sandbox 才放行
  if (!a.noSandbox && !(a.parent !== null && insideSandbox(a.parent))) throw new Refusal("parity: scenario child is not inside the kernel sandbox");
  const name = a.scenarios[0];
  if (!name || a.scenarios.length !== 1) throw new UsageError("--child runs exactly one --scenario");
  const m = readManifest(a.data);
  const homes = fencedHomes(m.home);
  const { HOME, TMPDIR } = process.env;
  assertOffLive([HOME, TMPDIR, a.data, a.work, a.out, a.config].filter((p): p is string => typeof p === "string"), homes);
  if (HOME !== join(a.work, "home") || TMPDIR !== join(a.work, "tmp")) {
    throw new Error("parity: --child runs with HOME=<work>/home and TMPDIR=<work>/tmp (dump starts it)");
  }
  // 克隆要删 <work>/home、<work>/tmp：只在 dump 认过、写了记号的草稿区里删
  if (!hasWorkMarker(a.work)) throw new Refusal(`parity: --child needs a --work that dump prepared (no ${WORK_MARKER} marker in ${a.work})`);
  const probe = probeOf(process.env);
  // 外面带进来的 HH_*（直接起 --child 的时候）不算：HH_CONFIG 下面自己定
  for (const k of Object.keys(process.env)) if (k.startsWith("HH_")) delete process.env[k];
  const det = installDeterminism(m.takenAt);
  const rec = new Recorder({ t0: m.takenAt, now: () => det.clock.now, roots: { "<WORK>": a.work, "<TREE>": TREE } });
  // 从这里起只许写 --work、--out；快照的 home 里什么都不读；拦下的都记一条 refused；树写成的文件，时间改成虚拟的现在
  installFence(m.home, { guarded: homes, scratch: [a.work, a.out], sink: rec, now: () => det.clock.now });
  cloneSnapshot(a.data, a.work, m.home);
  installOffline(rec);
  const transcript = join(a.out, name, "transcript.jsonl");
  // dump 到了时限发 SIGTERM：记录写到哪算哪
  process.on("SIGTERM", () => {
    rec.log("error", `parity: scenario ${name} timed out`);
    rec.write(transcript);
    process.exit(1);
  });
  try {
    const config = a.config ?? join(a.work, "home", await stateConfigRel(join(a.work, "home"), m.home));
    assertOffLive([config], homes);
    process.env.HH_CONFIG = config;
    const { buildWorld } = await import("./world.ts");
    const { offlineOpenAI } = await import("./fakes.ts");
    const { SCENARIOS, loadScenario } = await import("./scenario.ts");
    const entry = SCENARIOS.find((s) => s.name === name);
    if (!entry) throw new Error(`parity: unknown scenario ${name}`);
    const scenario = await loadScenario(entry);
    det.setFetch(rec.fetch(offlineOpenAI));
    const w = await buildWorld({ manifest: m, work: a.work, rec, clock: det.clock, liveHomes: homes });
    if (probe) await import(pathToFileURL(probe).href);
    await scenario.run(w);
    await w.close();
    rec.write(transcript);
    return 0;
  } catch (e) {
    rec.log("error", `parity: scenario ${name} failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    rec.write(transcript);
    console.error(`parity: scenario ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "dump") {
    const a = parseDump(rest);
    return a.child ? child(a) : dump(a);
  }
  // 这两个自己写 stdout / stderr、不抛错，返回退出码
  if (cmd === "census") { const { runCensus } = await import("./census.ts"); return runCensus(rest); }
  if (cmd === "diff") { const { runDiff } = await import("./diff.ts"); return runDiff(rest); }
  throw new UsageError(cmd ? `unknown command: ${cmd}` : "no command given");
}

main(process.argv.slice(2)).then(
  // 显式退出：排在虚拟时间线上没到点的计时器、真的 AbortSignal 计时器都不能拖住进程
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    if (e instanceof UsageError) console.error(USAGE);
    process.exit(e instanceof UsageError || e instanceof Refusal ? 2 : 1);
  },
);
