// macOS: launchd's per-user agents, files in ~/Library/LaunchAgents loaded with launchctl into gui/<uid>. hhd's and the
// console's jobs are filled from ops/launchd/*.plist.template.
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess } from "../util/run.ts";
import type { Installed, Job, Result, ServiceManager } from "./index.ts";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The role's app's launcher (config launchd.app): what each of the role's jobs runs first, the program after "--" */
export const launcherOf = (cfg: { launchd?: { app?: string } }): string[] => (cfg.launchd?.app ? [join(cfg.launchd.app, "Contents", "MacOS", "HH"), "--"] : []);

/**
 * The first directory on the real path from / down to `path` (as far as it exists) that someone other than root or uid
 * could change, or null: another owner, or writable by group or others (a sticky directory excepted, whose entries only
 * their owners can move). The launcher makes the same check on itself before it starts anything (apps/macos/Sources/launcher.c).
 */
export function unsafePath(path: string, uid: number): string | null {
  let p = resolve(path);
  while (!existsSync(p)) p = dirname(p);
  for (p = realpathSync(p); ; p = dirname(p)) {
    const st = statSync(p);
    if ((st.uid !== 0 && st.uid !== uid) || ((st.mode & 0o022) !== 0 && !(st.isDirectory() && (st.mode & 0o1000) !== 0))) return p;
    if (p === "/") return null;
  }
}

function kernelJobs(labels: { hhd: string; console: string }, fill: Record<string, string | undefined>): Array<Job & { unfilled: string[] }> {
  return (["hhd", "console"] as const).map((job) => {
    const unfilled = new Set<string>();
    const text = readFileSync(join(REPO, "ops", "launchd", `${job}.plist.template`), "utf8").replace(/\{\{(\w+)\}\}/g, (hole, key: string) => {
      // LAUNCHER: the role's app's launcher (a path), put before the program as two strings; none = nothing
      if (key === "LAUNCHER") return fill.LAUNCHER ? `<string>${xml(fill.LAUNCHER)}</string>\n    <string>--</string>\n    ` : "";
      const value = key === "LABEL" ? labels[job] : fill[key];
      if (value === undefined) unfilled.add(key);
      return value ?? hole;
    });
    return { label: labels[job], files: { [`${labels[job]}.plist`]: text }, unfilled: [...unfilled] };
  });
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function timerJob(label: string, program: readonly string[], everyMs: number, env: Record<string, string>, logFile: string): Job {
  const strings = (xs: readonly string[]) => xs.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return {
    label,
    files: { [`${label}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(program)}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>StartInterval</key><integer>${Math.max(1, Math.round(everyMs / 1000))}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
` },
  };
}

function serviceJob(label: string, program: readonly string[], env: Record<string, string>, logFile: string, cwd: string): Job {
  const strings = (xs: readonly string[]) => xs.map((x) => `    <string>${xml(x)}</string>`).join("\n");
  const vars = Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return {
    label, service: true,
    files: { [`${label}.plist`]: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${strings(program)}
  </array>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
` },
  };
}

/** A job file's path and the JSON plutil gives for it (none: it would not read): the job it installs */
export function plistJob(file: string, json: string): Installed {
  let j: { Label?: string; ProgramArguments?: string[]; EnvironmentVariables?: Record<string, string> } = {};
  try { j = JSON.parse(json); } catch { /* not a plist plutil reads: known by its file name */ }
  return { label: j.Label ?? basename(file, ".plist"), files: [file], program: j.ProgramArguments ?? [], env: j.EnvironmentVariables ?? {} };
}

/** A shell line that prints the user's job files, run as that user: each path and its JSON after a NUL (plistJob reads it) */
export const PLISTS_OF_USER = String.raw`cd && for f in Library/LaunchAgents/*.plist; do [ -f "$f" ] || continue; printf '%s\0' "$HOME/$f"; /usr/bin/plutil -convert json -o - "$f" 2>/dev/null; printf '\0'; done`;

export interface LaunchDeps {
  /** The user's LaunchAgents directory */
  dir: string;
  uid: number;
  launchctl(args: readonly string[]): Promise<Result>;
}

/** launchd as this user really has it */
export const launchDeps = (): LaunchDeps => ({
  dir: join(homedir(), "Library", "LaunchAgents"), uid: process.getuid?.() ?? 0,
  launchctl: (args) => runProcess("launchctl", args, { timeoutMs: 30_000 }),
});

export function launchd(d: LaunchDeps): ServiceManager {
  const file = (label: string) => join(d.dir, `${label}.plist`);
  return {
    kind: "launchd", dir: d.dir, kernelJobs, timerJob, serviceJob,
    running: async (label) => (await d.launchctl(["print", `gui/${d.uid}/${label}`])).code === 0,
    start: (job) => d.launchctl(["bootstrap", `gui/${d.uid}`, file(job.label)]),
    stop: (label) => d.launchctl(["bootout", `gui/${d.uid}/${label}`]),
    list: async (prefix) => {
      const out: Installed[] = [];
      for (const f of existsSync(d.dir) ? readdirSync(d.dir).sort() : []) {
        if (!f.startsWith(prefix) || !f.endsWith(".plist")) continue;
        const r = await runProcess("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(d.dir, f)]);
        out.push(plistJob(join(d.dir, f), r.code === 0 ? r.stdout : ""));
      }
      return out;
    },
    uninstall: async (label) => {
      const r = await d.launchctl(["bootout", `gui/${d.uid}/${label}`]);
      const removed = [file(label)].filter((f) => existsSync(f));
      for (const f of removed) rmSync(f, { force: true });
      return { ...r, removed };
    },
    startCommand: (job) => `launchctl bootstrap gui/${d.uid} ${file(job.label)}`,
  };
}
