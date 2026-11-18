// hh modules: list what is there, check each module (its declaration, its config, what it requires, its own check), and
// install the role: its Python environment and the on modules' Python packages, their manuals on the role's shelf, and
// the service manager's jobs (hhd, the console, each standalone timer). Runs in the CLI process: no hhd needed.
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { launchdLabels, nodeBin, type Config } from "../config.ts";
import { openAfterInstall, placeOwnCommand } from "../console/open.ts";
import { B } from "../lang/index.ts";
import { askGrants, buildApp, GRANTS, type GrantState } from "../services/app.ts";
import { installJobs, jobPath, REPO, services, type Job, type ServiceManager } from "../services/index.ts";
import { launcherOf, unsafePath } from "../services/launchd.ts";
import { runProcess, type Runner } from "../util/run.ts";
import type { CheckItem, CheckStatus, ModuleContext, ModuleService } from "./api.ts";
import { configOf, contextOf, inLang, isOn, loadModules, type Found, type Modules } from "./load.ts";

const CHECK_TIMEOUT_MS = 30_000;
const RANK: Record<CheckStatus, number> = { ok: 0, setup: 1, broken: 2 };

export interface Report { found: Found; state: string; status: CheckStatus; items: CheckItem[] }

const onPath = (bin: string, dirs: readonly string[]): boolean => dirs.some((d) => { try { return statSync(join(d, bin)).isFile(); } catch { return false; } });

/** Check one module: unreadable or misconfigured is broken; a missing program or module needs setup; then its own check */
async function checkOne(cfg: Config, mods: Modules, f: Found): Promise<CheckItem[]> {
  if (!f.spec) return [{ status: "broken", text: f.error ?? "" }];
  const spec = f.spec;
  let config: Record<string, unknown>;
  try { config = configOf(cfg, spec); } catch (e) { return [{ status: "broken", text: B.modules.badConfig(e instanceof Error ? e.message : String(e)) }]; }
  const items: CheckItem[] = [];
  const path = [...mods.binDirs, ...(process.env.PATH ?? "").split(delimiter)];
  for (const bin of spec.requires?.bins ?? []) if (!onPath(bin, path)) items.push({ status: "setup", text: B.modules.needsBin(bin) });
  for (const m of spec.requires?.modules ?? []) {
    const other = mods.found.find((x) => x.name === m);
    if (!other?.spec || !isOn(cfg, other.spec)) items.push({ status: "setup", text: B.modules.needsModule(m) });
  }
  if (spec.requires?.npm && isOn(cfg, spec) && npmStale(resolve(f.dir, spec.requires.npm))) items.push({ status: "setup", text: B.modules.needsNpm(relative(REPO, resolve(f.dir, spec.requires.npm))) });
  if (spec.requires?.python && !existsSync(join(f.dir, spec.requires.python))) items.push({ status: "broken", text: B.modules.noRequirements(spec.requires.python) });
  if (isOn(cfg, spec)) items.push(...skillLinks(cfg, f).filter((l) => l.clash).map((l): CheckItem => ({ status: "setup", text: B.modules.skillClash(l.page) })));
  if (spec.check) {
    const ctx = contextOf(cfg, spec, f.dir, config, () => mods.binDirs);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(B.modules.timedOut(CHECK_TIMEOUT_MS / 1000))), CHECK_TIMEOUT_MS); });
    try { items.push(...await Promise.race([spec.check(ctx), late])); }
    catch (e) { items.push({ status: "broken", text: B.modules.checkFailed(e instanceof Error ? e.message : String(e)) }); }
    finally { clearTimeout(timer); }
  }
  return items;
}

export async function doctor(cfg: Config, mods: Modules, only?: string): Promise<Report[]> {
  const out: Report[] = [];
  for (const f of mods.found.filter((x) => !only || x.name === only)) {
    const items = await checkOne(cfg, mods, f);
    const status = items.reduce<CheckStatus>((w, i) => RANK[i.status] > RANK[w] ? i.status : w, "ok");
    out.push({ found: f, state: stateOf(cfg, f), status, items });
  }
  return out;
}

const stateOf = (cfg: Config, f: Found): string =>
  f.spec?.required ? B.modules.stateRequired : cfg.modules?.[f.name]?.enabled ? B.modules.stateOn : B.modules.stateOff;
const statusText = (s: CheckStatus): string => s === "ok" ? B.modules.statusOk : s === "setup" ? B.modules.statusSetup : B.modules.statusBroken;
const rootText = (f: Found): string => f.trusted ? B.modules.rootBuiltin : B.modules.rootRole;

/** A module's manuals (skills/<category>/<book>) and where each goes on the shelf; clash = something else is already there */
function skillLinks(cfg: Config, f: Found): Array<{ from: string; to: string; page: string; clash: boolean; done: boolean }> {
  const root = inLang(cfg, f.dir, "skills");
  if (!existsSync(root)) return [];
  const shelf = cfg.learning.root;
  return readdirSync(root).filter((c) => statSync(join(root, c)).isDirectory()).flatMap((cat) =>
    readdirSync(join(root, cat)).filter((b) => statSync(join(root, cat, b)).isDirectory()).map((book) => {
      const from = join(root, cat, book), to = join(shelf, cat, book);
      let mine = false, there = false;
      try { const l = lstatSync(to); there = true; mine = l.isSymbolicLink() && resolve(join(shelf, cat), readlinkSync(to)) === from; } catch { /* nothing there */ }
      return { from, to, page: relative(cfg.workspace, to), clash: there && !mine, done: mine };
    }));
}

/** The packages of a directory are not installed, or its lockfile changed since they were */
function npmStale(dir: string): boolean {
  try { return statSync(join(dir, "package-lock.json")).mtimeMs > statSync(join(dir, "node_modules", ".package-lock.json")).mtimeMs; } catch { return true; }
}

/** The job label of a module's service under a role's label prefix */
export const serviceLabel = (base: string, module: string, s: ModuleService, ctx: ModuleContext): string => `${base}.${s.label ? s.label(ctx) : `${module}.${s.name}`}`;

/** app, grants: what builds the role's app and asks the owner for its permissions (buildApp, askGrants unless given; see makeApp) */
export interface InstallDeps { run: Runner; services: ServiceManager; app?: AppBuilder; grants?: (app: string) => Promise<GrantState | null> }
type AppBuilder = (cfg: Config, rebuild?: boolean) => Promise<{ built: boolean; human?: string }>;

const defaultDeps = (): InstallDeps => ({ run: runProcess, services: services() });

/**
 * Set the role up. The Python environment <stateDir>/venv is made when tools.python is its python (as hh new writes);
 * each on module's requirements go into tools.python. Manuals are linked onto the shelf; a page already there that is
 * not this module's link is left alone and reported. An on module's npm directory is installed when its lockfile is newer
 * than what is installed. The service manager's jobs: hhd and the console (only with HH_CONFIG set, which they start with), each on
 * module's standalone timer and each of its services, under the role's labels.
 */
/** What install did, step by step; failed: some step did not go through (the others still ran). start false: job files written, not loaded */
export async function install(cfg: Config, mods: Modules, deps: InstallDeps = defaultDeps(), o: { start?: boolean } = {}): Promise<{ lines: string[]; failed: boolean; started: string[] }> {
  let failed = false;
  const lines: string[] = [];
  const venv = join(cfg.stateDir, "venv");
  if (resolve(cfg.tools.python) === join(venv, "bin", "python") && !existsSync(cfg.tools.python)) {
    const r = await deps.run("python3", ["-m", "venv", venv], { timeoutMs: 120_000 });
    if (r.code !== 0) failed = true;
    lines.push(r.code === 0 ? B.modules.venvMade(venv) : B.modules.venvFailed(venv, r.stderr.trim().slice(-300)));
  }
  for (const { spec, ctx } of mods.loaded) {
    if (!spec.requires?.python) continue;
    const r = await deps.run(cfg.tools.python, ["-m", "pip", "install", "-q", "-r", join(ctx.dir, spec.requires.python)], { timeoutMs: 600_000 });
    if (r.code !== 0) failed = true;
    lines.push(r.code === 0 ? B.modules.pipDone(spec.name) : B.modules.pipFailed(spec.name, r.stderr.trim().slice(-300)));
  }
  for (const { spec, ctx } of mods.loaded) {
    if (!spec.requires?.npm) continue;
    const dir = resolve(ctx.dir, spec.requires.npm);
    if (!npmStale(dir)) continue;
    const r = await deps.run("npm", ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], { cwd: dir, timeoutMs: 600_000 });
    if (r.code !== 0) failed = true;
    lines.push(r.code === 0 ? B.modules.npmDone(spec.name) : B.modules.npmFailed(spec.name, r.stderr.trim().slice(-300)));
  }
  for (const { spec } of mods.loaded) {
    for (const l of skillLinks(cfg, mods.found.find((x) => x.name === spec.name)!)) {
      if (l.clash) { lines.push(`${spec.name}: ${B.modules.skillClash(l.page)}`); continue; }
      if (l.done) continue;
      try {
        mkdirSync(join(l.to, ".."), { recursive: true });
        symlinkSync(l.from, l.to);
        lines.push(`${spec.name}: ${B.modules.skillLinked(l.page)}`);
      } catch (e) { failed = true; lines.push(`${spec.name}: ${B.modules.skillFailed(l.page, e instanceof Error ? e.message : String(e))}`); }
    }
  }
  const labels = launchdLabels(cfg);
  const base = labels.hhd.replace(/\.hhd$/, "");
  const config = process.env.HH_CONFIG;
  const jp = jobPath(process.env.PATH, cfg.launchd?.extraPath);
  if (jp.left.length) lines.push(B.modules.pathLeftOut(jp.left.join(", ")));
  const env = { ...(config ? { HH_CONFIG: config } : {}), PATH: jp.path, HOME: homedir() };
  const logs = join(cfg.stateDir, "logs");
  // the role's app starts every job (launchd.app): built and signed afresh, so a new name or avatar is in it
  if (cfg.launchd?.app) {
    const r = await makeApp(cfg, { build: deps.app, ask: deps.grants });
    lines.push(r.line);
    if (!r.ok) { lines.push(B.modules.appNoJobs); return { lines, failed: true, started: [] }; }
  }
  const first = launcherOf(cfg);
  try { mkdirSync(logs, { recursive: true }); } catch (e) { failed = true; lines.push(B.modules.logsFailed(logs, e instanceof Error ? e.message : String(e))); }
  const jobs: Job[] = mods.loaded.flatMap(({ spec }) => (spec.timers ?? []).filter((t) => t.standalone).map((t) => {
    const label = `${base}.${spec.name}.${t.name}`;
    return deps.services.timerJob(label, [...first, nodeBin(cfg), join(REPO, "src", "cli.ts"), "modules", "timer", spec.name, t.name], t.everyMs, env, join(logs, `${label}.log`));
  }));
  for (const { spec, ctx } of mods.loaded) for (const s of spec.services ?? []) {
    if (s.when && !s.when(ctx)) continue;
    const label = serviceLabel(base, spec.name, s, ctx);
    jobs.push(deps.services.serviceJob(label, [...first, nodeBin(cfg), resolve(ctx.dir, s.script), ...(s.argv?.(ctx) ?? [])], env, join(logs, `${label}.log`), REPO));
  }
  const port = cfg.launchd?.consolePort;
  for (const j of deps.services.kernelJobs(labels, { LAUNCHER: first[0], NODE: nodeBin(cfg), CODE: REPO, HH_CONFIG: config, HOME: homedir(), PATH: jp.path, LOG_DIR: logs, ...(port ? { CONSOLE_PORT: String(port) } : {}) })) {
    if (j.unfilled.length) lines.push(B.modules.jobUnfilled(j.label, j.unfilled.join(", ")));
    else jobs.push(j);
  }
  const started: string[] = [];
  for (const r of await installJobs(jobs, deps.services, o.start !== false)) {
    if (r.state === "installed") started.push(r.label);
    if (r.state === "failed") failed = true;
    lines.push(r.state === "installed" ? B.modules.jobInstalled(r.label) : r.state === "written" ? B.modules.jobWritten(r.label, r.command ?? "")
      : r.state === "same" ? B.modules.jobSame(r.label) : r.state === "running" ? B.modules.jobRunning(r.label) : r.state === "kept" ? B.modules.jobKept(r.label, deps.services.dir) : B.modules.jobFailed(r.label, r.error ?? ""));
  }
  return { lines, failed, started };
}

const within = (p: string, root: string): boolean => p.startsWith(root.endsWith("/") ? root : `${root}/`);

/**
 * The role's app (launchd.app), by buildApp or `build`: built and signed when it is not there yet (or `rebuild`), kept when
 * it is; then its permission page for the owner, when the owner is at the screen (askGrants or `ask`; whatever he turns
 * on, the jobs are installed). What happened, and whether the app is there to start the role's jobs. Nothing is built
 * while its path could be changed by someone else, nor before the owner makes its folder.
 */
export async function makeApp(cfg: Config, o: { build?: AppBuilder; ask?: (app: string) => Promise<GrantState | null>; rebuild?: boolean } = {}): Promise<{ line: string; ok: boolean }> {
  const app = cfg.launchd!.app!;
  const unsafe = unsafePath(app, process.getuid?.() ?? 0);
  if (unsafe) return { line: B.modules.appUnsafe(app, unsafe), ok: false };
  // a folder in the user's own home is made here; one elsewhere (another account's role) is the owner's to make
  if (!existsSync(dirname(app)) && within(dirname(app), homedir())) mkdirSync(dirname(app), { recursive: true, mode: 0o755 });
  if (!existsSync(dirname(app))) return { line: B.modules.appNoFolder(dirname(app), userInfo().username), ok: false };
  let r: { built: boolean; human?: string };
  try { r = await (o.build ?? buildApp)(cfg, o.rebuild); } catch (e) { return { line: B.modules.appFailed(app, (e instanceof Error ? e.message : String(e)).trim().slice(-300)), ok: false }; }
  const g = await (o.ask ?? askGrants)(app);
  const off = g ? GRANTS.filter((k) => !g[k]).map((k) => B.modules.grantName[k]) : [];
  return { line: [r.built ? B.modules.appBuilt(app) : B.modules.appKept(app), ...(r.human ? [B.modules.humanBuilt(r.human)] : []),
    !g ? B.modules.grantsAsk(app) : off.length ? B.modules.grantsOff(app, off) : B.modules.grantsOn].join("\n"), ok: true };
}

/** One run of a module's timer, for the service manager's job of a standalone one; a throw is a failure */
export async function runTimer(cfg: Config, mods: Modules, name?: string, timer?: string): Promise<{ text: string; code: number; err?: string }> {
  const l = mods.loaded.find((x) => x.spec.name === name);
  const t = l?.spec.timers?.find((x) => x.name === timer);
  if (!l || !t) return { text: B.modules.timerUnknown(name ?? "", timer ?? ""), code: 2 };
  try { return { text: await t.run.run(l.ctx), code: 0 }; }
  catch (e) { return { text: "", code: 1, err: e instanceof Error ? e.message : String(e) }; }
}

/**
 * hh modules list | doctor | check <name> | install | run <module> <script> [args…] — what to print and the exit code
 * (doctor, check: 1 when something is broken; run: the script's own). run is what a module's bin/ wrapper calls: the
 * script under the module's environment, with no time limit.
 */
export async function modulesCommand(cfg: Config, argv: readonly string[]): Promise<{ text: string; code: number; err?: string }> {
  const [action = "list", name, script, ...rest] = argv;
  const mods = await loadModules(cfg);
  if (action === "list") {
    if (!mods.found.length) return { text: B.modules.none, code: 0 };
    return { text: mods.found.map((f) => [f.name, stateOf(cfg, f), rootText(f), f.spec?.summary ?? f.error ?? ""].join("\t")).join("\n"), code: 0 };
  }
  if (action === "doctor" || action === "check") {
    if (action === "check" && !name) return { text: B.modules.usage, code: 2 };
    const reports = await doctor(cfg, mods, name);
    if (name && !reports.length) return { text: B.modules.unknown(name), code: 1 };
    if (!reports.length) return { text: B.modules.none, code: 0 };
    const left = jobPath(process.env.PATH, cfg.launchd?.extraPath).left;
    const text = [...reports.map((r) => [`${r.found.name}\t${r.state}\t${rootText(r.found)}\t${statusText(r.status)}`, ...r.items.map((i) => `  - ${statusText(i.status)}: ${i.text}`)].join("\n")),
      ...(left.length && !name ? [B.modules.pathLeftOut(left.join(", "))] : [])].join("\n");
    return { text, code: reports.some((r) => r.status === "broken") ? 1 : 0 };
  }
  if (action === "install") {
    const flags = new Set([name, script, ...rest]);
    const r = await install(cfg, mods, undefined, { start: !flags.has("--no-start") });
    // the console just came up for the first time: pair the installer's browser and open it on the talk page
    const opened = r.started.includes(launchdLabels(cfg).console) && !flags.has("--no-open") ? await openAfterInstall(cfg) : B.modules.openConsole(cfg.id);
    return { text: [...r.lines, placeOwnCommand(cfg), opened].filter(Boolean).join("\n"), code: r.failed ? 1 : 0 };
  }
  if (action === "app") {
    if (!cfg.launchd?.app) return { text: B.modules.appUnset, code: 2 };
    const r = await makeApp(cfg, { rebuild: name === "--rebuild" });
    return { text: r.line, code: r.ok ? 0 : 1 };
  }
  if (action === "timer") return runTimer(cfg, mods, name, script);
  if (action === "env") {
    mods.writeEnv(cfg);
    return { text: mods.loaded.map((l) => `${l.spec.name}\t${l.ctx.stateDir}`).join("\n"), code: 0 };
  }
  if (action === "run") {
    const f = mods.found.find((x) => x.name === name);
    if (!f?.spec || !script) return { text: f ? f.error ?? B.modules.usage : B.modules.unknown(name), code: 2 };
    const r = await contextOf(cfg, f.spec, f.dir, configOf(cfg, f.spec), () => mods.binDirs).run(join("scripts", script), rest, { timeoutMs: 0 });
    return { text: r.stdout.replace(/\n$/, ""), code: r.code, err: r.stderr };
  }
  return { text: B.modules.usage, code: 2 };
}
