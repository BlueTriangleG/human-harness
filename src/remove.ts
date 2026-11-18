// hh remove <id> [--yes]: a role off this computer, for good. Its jobs (ai.hh.<id>.*: launchd's, or systemd's user units and
// timers on Linux) stopped and their files gone, through the service manager;
// its app and the folder named as its id that holds it; its directory (the config's: workspace and state, and with the
// state its signing keychain and its console's token); its short command; its token file in the shared token folder; its
// Claude Code session records (~/.claude/projects, under its directory); its privacy grants (tccutil). Asks once (the id
// typed again) unless --yes. Only what is the role's: a workspace or state its config puts outside its directory is left
// and said. A role whose jobs carry no id of their own (the first role's ai.hh.hhd) is not found by it.
import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { commandRecord, MARK } from "./console/command.ts";
import { consoleUsageCache } from "./config.ts";
import { ROLE_MARK } from "./new.ts";
import { B, setLang } from "./lang/index.ts";
import { services, type ServiceManager } from "./services/index.ts";

/** the mark on the line ./setup adds to the shell's startup file (~/.local/bin on PATH); the same words as there */
export const PATH_LINE_MARK = "# added by HH setup (Human Harness)";

export interface RemoveDeps {
  /** this user's service manager (its jobs), and its home */
  services: ServiceManager;
  home: string;
  /** run a command (ps, tccutil); its exit code and output */
  run: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
  /** ask whether to go on, the id typed again; null when nobody can be asked */
  confirm: ((question: string) => Promise<string>) | null;
  /** the shared token folder (another account's role) */
  tokens: string;
  /** how long its stopped processes get to finish writing (a Claude Code session writes its record as it ends) */
  settleMs?: number;
  /** the system temp dir (the app's and the console's caches); the user's own when absent */
  tmp?: string;
}

const system = (): RemoveDeps => ({
  services: services(),
  home: homedir(),
  run: async (cmd, args) => {
    try { return { code: 0, out: (await promisify(execFile)(cmd, args, { encoding: "utf8" })).stdout }; }
    catch (e) { return { code: (e as { code?: number }).code ?? 1, out: String((e as { stderr?: string }).stderr ?? e) }; }
  },
  confirm: process.stdin.isTTY ? async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return (await rl.question(question)).trim(); } finally { rl.close(); }
  } : null,
  tokens: "/Users/Shared/hh-console",
});

const inside = (p: string, dir: string): boolean => resolve(p) === resolve(dir) || resolve(p).startsWith(`${resolve(dir)}/`);

/** Claude Code's name for a project folder: the path with everything but letters and digits as "-" (not reversible) */
const encode = (p: string): string => resolve(p).replace(/[^A-Za-z0-9]/g, "-");

/**
 * The Claude Code session records of the sessions that ran in `dir` or a folder under it: a folder in `projects` whose
 * name is one of theirs, encoded, and whose records say they ran there (cwd). The encoding is not reversible, so a name
 * alone could be a neighbour's: trial-2 next to trial, or a folder named trial-workspace next to trial/workspace.
 */
export function sessionsOf(dir: string, projects: string): string[] {
  if (!existsSync(projects)) return [];
  const names = new Set<string>();
  const walk = (d: string): void => {
    names.add(encode(d));
    for (const e of readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink()) walk(join(d, e.name));
  };
  walk(dir);
  const ranIn = (folder: string): boolean => {
    for (const f of readdirSync(folder).filter((n) => n.endsWith(".jsonl"))) {
      const cwd = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(readFileSync(join(folder, f), "utf8"))?.[1];
      if (cwd) return inside(JSON.parse(`"${cwd}"`) as string, dir);
    }
    return false;
  };
  return readdirSync(projects).filter((n) => names.has(n)).map((n) => join(projects, n)).filter(ranIn);
}

/** hh remove <id> [--yes]: what was done, line by line; throws with why nothing was */
export async function removeCommand(argv: readonly string[], deps: RemoveDeps = system()): Promise<string> {
  const [id, ...rest] = argv;
  if (!id || !/^[a-z][a-z0-9-]*$/.test(id) || rest.some((a) => a !== "--yes")) throw new Error(B.remove.usage);
  // the role's jobs, and from them its config
  const jobs = await deps.services.list(`ai.hh.${id}.`);
  const config = jobs.find((j) => j.env.HH_CONFIG)?.env.HH_CONFIG ?? [join(deps.home, "HH", id, "instance.json")].find(existsSync);
  if (!config && !jobs.length) throw new Error(B.remove.none(id));
  const c = config && existsSync(config) ? JSON.parse(readFileSync(config, "utf8")) as { id?: string; lang?: string; workspace?: string; stateDir?: string; launchd?: { app?: string } } : {};
  if (c.lang) try { setLang(c.lang); } catch { /* an unknown pack: the default's words */ }
  if (config && c.id !== undefined && c.id !== id) throw new Error(B.remove.notIt(config, String(c.id), id));
  // its directory goes whole only when it is one hh new made: its mark there naming this id, instance.json, the workspace
  // and the state in it, and never home (a hand-written config put in a folder of other things must not take the folder)
  const mark = config ? join(dirname(config), ROLE_MARK) : "";
  const marked = existsSync(mark) && readFileSync(mark, "utf8").trim() === id;
  const made = !!config && basename(config) === "instance.json" && resolve(dirname(config)) !== resolve(deps.home) && marked
    && !!c.workspace && !!c.stateDir && inside(c.workspace, dirname(config)) && inside(c.stateDir, dirname(config));
  const dir = made ? dirname(config!) : undefined;
  const app = c.launchd?.app;
  const appDir = app && basename(dirname(app)) === id ? dirname(app) : app;
  const left = made ? [] : [config, c.workspace, c.stateDir].filter((p): p is string => !!p && existsSync(p));
  const why = !made && config && existsSync(config) && !marked ? [B.remove.notMarked(dirname(config), id)] : [];
  // its short command where setup put it (the record in its state directory), else, for a role made before the record,
  // ~/.local/bin; either only while it still carries HH's mark for this id
  let recorded: string | undefined;
  try { recorded = c.stateDir ? (JSON.parse(readFileSync(commandRecord(c.stateDir), "utf8")) as { file?: string }).file : undefined; } catch { /* none kept */ }
  const own = [recorded, join(deps.home, ".local", "bin", id)]
    .filter((f, i, all): f is string => !!f && all.indexOf(f) === i && existsSync(f) && readFileSync(f, "utf8").includes(`${MARK} ${id}:`));
  const token = [join(deps.tokens, `${id}.owner`)].filter(existsSync);
  const sessions = dir ? sessionsOf(dir, join(deps.home, ".claude", "projects")) : [];
  // what its app and its console kept outside its folders: the window's web data (its pairing), caches, preferences, the usage cache
  const bundle = `ai.hh.role.${id}`, tmp = deps.tmp ?? tmpdir();
  const traces = [...(app ? [join(deps.home, "Library", "WebKit", bundle), join(deps.home, "Library", "Caches", bundle), join(deps.home, "Library", "Preferences", `${bundle}.plist`), join(tmp, bundle)] : []),
    ...(c.stateDir ? [consoleUsageCache(c.stateDir, tmp)] : [])].filter(existsSync);
  const files = [...(appDir && existsSync(appDir) ? [appDir] : []), ...(dir && existsSync(dir) ? [dir] : []), ...own, ...token, ...traces];

  const plan = [...jobs.map((j) => B.remove.planJob(j.label)), ...[...files, ...sessions].map((f) => B.remove.planFile(f)),
    ...(app ? [B.remove.planGrants(`ai.hh.role.${id}`)] : []), ...why, ...left.map((p) => B.remove.planLeft(p))];
  if (!rest.includes("--yes")) {
    if (!deps.confirm) throw new Error(`${B.remove.plan(plan.join("\n"))}\n${B.remove.needYes}`);
    if ((await deps.confirm(`${B.remove.plan(plan.join("\n"))}\n${B.remove.confirm(id)}`)) !== id) return B.remove.cancelled;
  }

  const lines: string[] = [];
  for (const j of jobs) {
    const r = await deps.services.uninstall(j.label);
    lines.push(r.code === 0 ? B.remove.stopped(j.label) : B.remove.notLoaded(j.label), ...r.removed.map((f) => B.remove.gone(f)));
  }
  // its app's windows and pages, which launchd did not start: closed before the app goes
  if (app) {
    const ps = await deps.run("/bin/ps", ["-A", "-o", "pid=,command="]);
    for (const m of ps.out.matchAll(/^\s*(\d+) (.*)$/gm)) {
      if (!m[2]!.startsWith(join(app, "Contents", "MacOS", "HH"))) continue;
      try { process.kill(Number(m[1]), "SIGTERM"); lines.push(B.remove.closed(m[1]!, m[2]!.slice(0, 120))); } catch { /* gone already */ }
    }
  }
  const rm = (f: string) => { if (!existsSync(f)) return; rmSync(f, { recursive: statSync(f).isDirectory(), force: true }); lines.push(B.remove.gone(f)); };
  files.forEach(rm);
  // the folders hh setup made for it, when nothing else is in them now
  for (const d of [join(deps.home, "HH"), ...(appDir ? [dirname(appDir)] : [])]) try { if (!readdirSync(d).length) { rmSync(d, { recursive: true }); lines.push(B.remove.gone(d)); } } catch { /* not there */ }
  // its session records last: a stopped session writes its record as it ends, after its job is gone
  if (jobs.length && sessions.length) await new Promise((r) => setTimeout(r, deps.settleMs ?? 3000));
  sessions.forEach(rm);
  // its app's grants: those of the system's list need an administrator; the rest the user's own
  if (app) {
    const tcc = await deps.run("/usr/bin/tccutil", ["reset", "All", `ai.hh.role.${id}`]);
    lines.push(tcc.code === 0 ? B.remove.grantsReset(`ai.hh.role.${id}`) : B.remove.grantsLeft(`ai.hh.role.${id}`));
  }
  lines.push(...why, ...left.map((p) => B.remove.left(p)), B.remove.done(id));
  // the last role gone: the PATH line ./setup added stays (Claude Code's own claude may be in that folder too), and is named
  if (!(await deps.services.list("ai.hh.")).length) {
    for (const f of [".zshrc", ".bash_profile", ".profile"].map((n) => join(deps.home, n))) {
      try { if (readFileSync(f, "utf8").includes(PATH_LINE_MARK)) lines.push(B.remove.pathLineLeft(f)); } catch { /* none there */ }
    }
  }
  return lines.join("\n");
}
