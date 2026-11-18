// A role's jobs under the machine's service manager: hhd and the console (`hh new` writes them into the role's
// directory) and each on module's standalone timer and services (`hh modules install` puts all of them where the manager
// reads them and loads them). launchd on macOS (./launchd.ts), systemd's user units on Linux (./systemd.ts); the rest of
// HH writes, installs and stops jobs only through this interface. A job file already there with other content is left
// alone and reported: the first role's live jobs carry the default labels.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchd, launchDeps, plistJob, PLISTS_OF_USER } from "./launchd.ts";
import { systemd, systemdDeps, unitJobs, UNITS_OF_USER } from "./systemd.ts";

export { REPO } from "./launchd.ts";

/** A job's files by name; service: one the manager keeps alive, never touched while it runs under its label */
export interface Job { label: string; files: Record<string, string>; service?: boolean }

/** A job as it is installed: its label, its files (full paths), the program and environment it runs with */
export interface Installed { label: string; files: string[]; program: string[]; env: Record<string, string> }

export interface Result { code: number; stderr: string }

export interface ServiceManager {
  /** launchd or systemd: also the directory under a new role's own where its first jobs are written */
  readonly kind: string;
  /** where this user's job files go */
  readonly dir: string;
  /** hhd's and the console's jobs; a placeholder with no value in fill stays as written and is listed per job */
  kernelJobs(labels: { hhd: string; console: string }, fill: Record<string, string | undefined>): Array<Job & { unfilled: string[] }>;
  /** A standalone timer: the program run every everyMs, and once at load */
  timerJob(label: string, program: readonly string[], everyMs: number, env: Record<string, string>, logFile: string): Job;
  /** A service: the manager keeps the program running (and starts it at login); it is nobody's child */
  serviceJob(label: string, program: readonly string[], env: Record<string, string>, logFile: string, cwd: string): Job;
  /** Whether a service runs under this label now */
  running(label: string): Promise<boolean>;
  /** Load a job whose files are written, and start it */
  start(job: Job): Promise<Result>;
  /** Stop a service (and the timer that starts it, if it has one) and unload it */
  stop(label: string): Promise<Result>;
  /** The jobs of this user whose label starts with prefix, as installed: their files and the environment they run with */
  list(prefix: string): Promise<Installed[]>;
  /** Stop a job and unload it, and delete its files: the files deleted */
  uninstall(label: string): Promise<Result & { removed: string[] }>;
  /** What a person runs to load a written job by hand */
  startCommand(job: Job): string;
}

/** This machine's service manager, as this user has it */
export const services = (): ServiceManager => (process.platform === "linux" ? systemd(systemdDeps()) : launchd(launchDeps()));

/** The program a job runs, without the role's app's launcher before it (launchd's [HH, "--", …]) */
/**
 * The PATH a role's jobs get: the one setup runs with, without its folders on an external disk (under /Volumes), with the
 * role's launchd.extraPath at the end. A process of the role's app looking along PATH into such a folder makes macOS ask
 * the owner for access to a removable volume (the npx walk of 11-18 met it). left: the folders taken out, for setup and
 * hh modules doctor to say.
 */
export function jobPath(path: string | undefined, extra: readonly string[] = []): { path: string; left: string[] } {
  const dirs = (path || "/usr/bin:/bin").split(":").filter(Boolean);
  const left = dirs.filter((d) => d === "/Volumes" || d.startsWith("/Volumes/"));
  return { path: [...dirs.filter((d) => !left.includes(d)), ...extra].join(":"), left };
}

export const programOf = (j: Installed): string[] => (j.program[1] === "--" ? j.program.slice(2) : j.program);

/**
 * Another account's jobs, as list("") would give them there: its job files read by that account itself (as: a command
 * run as it, through sudo), since its home is not the owner's to read
 */
export async function jobsAs(as: (cmd: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>, platform: string = process.platform): Promise<Installed[]> {
  const linux = platform === "linux";
  const r = await as(["/bin/sh", "-c", linux ? UNITS_OF_USER : PLISTS_OF_USER]);
  if (r.code) throw new Error(r.stderr.trim() || `/bin/sh: exit ${r.code}`);
  const parts = r.stdout.split("\0"), files: Array<{ file: string; text: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) files.push({ file: parts[i]!, text: parts[i + 1]! });
  return linux ? unitJobs(files) : files.map((f) => plistJob(f.file, f.text));
}

export type JobState = "installed" | "written" | "same" | "kept" | "running" | "failed";

/**
 * Write each job's files and (start, the default) load it; files already there with the same text are left as they are,
 * with other text not touched. A service already running under its label is left exactly as it is, whatever files it was
 * loaded from: the process behind it holds a connection that must not be dropped, and may have been set up by hand.
 * A job that cannot be written is reported as failed and the others still go ahead
 */
export async function installJobs(jobs: readonly Job[], svc: ServiceManager, start = true): Promise<Array<{ label: string; state: JobState; error?: string; command?: string }>> {
  const out: Array<{ label: string; state: JobState; error?: string; command?: string }> = [];
  for (const j of jobs) {
    const files = Object.entries(j.files).map(([name, text]) => ({ file: join(svc.dir, name), text }));
    try {
      if (j.service && (await svc.running(j.label))) { out.push({ label: j.label, state: "running" }); continue; }
      const there = files.filter((f) => existsSync(f.file));
      if (there.length) { out.push({ label: j.label, state: there.length === files.length && there.every((f) => readFileSync(f.file, "utf8") === f.text) ? "same" : "kept" }); continue; }
      mkdirSync(svc.dir, { recursive: true });
      for (const f of files) writeFileSync(f.file, f.text);
    } catch (e) { out.push({ label: j.label, state: "failed", error: e instanceof Error ? e.message : String(e) }); continue; }
    if (!start) { out.push({ label: j.label, state: "written", command: svc.startCommand(j) }); continue; }
    const r = await svc.start(j);
    out.push(r.code === 0 ? { label: j.label, state: "installed" } : { label: j.label, state: "failed", error: r.stderr.trim().slice(-300) });
  }
  return out;
}
