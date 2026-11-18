// Linux: systemd's user units in ~/.config/systemd/user, run with `systemctl --user`. A service is a unit systemd restarts;
// a standalone timer is a oneshot unit and a .timer that runs it at load and then every so often.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../util/run.ts";
import type { Installed, Job, Result, ServiceManager } from "./index.ts";

export interface SystemdDeps {
  /** The user's unit directory */
  dir: string;
  /** systemctl --user with these arguments */
  systemctl(args: readonly string[]): Promise<Result>;
}

export const systemdDeps = (): SystemdDeps => ({
  dir: join(homedir(), ".config", "systemd", "user"),
  systemctl: (args) => runProcess("systemctl", ["--user", ...args], { timeoutMs: 30_000 }),
});

/** One Environment= word of a unit as word() wrote it, back to NAME=value */
const unword = (w: string): string => w.slice(1, -1).replace(/\\(.)/g, "$1").replace(/\$\$/g, "$").replace(/%%/g, "%");

/** A path in a unit: systemd's specifiers (%) escaped */
const path = (s: string): string => s.replace(/%/g, "%%");
/** One word of ExecStart= or Environment=: quoted, with specifiers and $ variables escaped */
const word = (s: string): string => `"${path(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "$$$$")}"`;

function unit(label: string, o: { program: readonly string[]; env: Record<string, string>; out: string; err: string; cwd?: string; keep: boolean }): string {
  return [
    "[Unit]", `Description=${label}`, "",
    "[Service]", `Type=${o.keep ? "simple" : "oneshot"}`, `ExecStart=${o.program.map(word).join(" ")}`,
    ...(o.cwd ? [`WorkingDirectory=${path(o.cwd)}`] : []),
    ...Object.entries(o.env).map(([k, v]) => `Environment=${word(`${k}=${v}`)}`),
    `StandardOutput=append:${path(o.out)}`, `StandardError=append:${path(o.err)}`,
    ...(o.keep ? ["Restart=always", "RestartSec=30", "", "[Install]", "WantedBy=default.target"] : []),
    "",
  ].join("\n");
}

/** What `hh new` fills in for hhd and the console, by job */
const KERNEL = {
  hhd: { main: "src/hhd.ts", need: ["NODE", "CODE", "HH_CONFIG", "PATH", "HOME", "LOG_DIR"], env: { HH_CONFIG: "HH_CONFIG", PATH: "PATH", HOME: "HOME" } },
  console: { main: "src/console/main.ts", need: ["NODE", "CODE", "HH_CONFIG", "HOME", "CONSOLE_PORT", "LOG_DIR"], env: { HH_CONFIG: "HH_CONFIG", HOME: "HOME", HH_CONSOLE_PORT: "CONSOLE_PORT" } },
} as const;

/** Unit files' paths and texts: the jobs they install, a timer beside its service, each service's program and environment */
export function unitJobs(files: ReadonlyArray<{ file: string; text: string }>): Installed[] {
  const out = new Map<string, Installed>();
  for (const { file, text } of files) {
    const m = /([^/]*)\.(service|timer)$/.exec(file);
    if (!m) continue;
    const job = out.get(m[1]!) ?? { label: m[1]!, files: [], program: [], env: {} };
    job.files.push(file);
    if (m[2] === "service") {
      for (const l of text.split("\n")) {
        const exec = /^ExecStart=(.*)$/.exec(l);
        if (exec) job.program = (exec[1]!.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map(unword);
        const w = /^Environment=(".*")$/.exec(l);
        if (!w) continue;
        const kv = unword(w[1]!), i = kv.indexOf("=");
        if (i > 0) job.env[kv.slice(0, i)] = kv.slice(i + 1);
      }
    }
    out.set(m[1]!, job);
  }
  return [...out.values()];
}

/** A shell line that prints the user's unit files, run as that user: each path and text after a NUL (unitJobs reads it) */
export const UNITS_OF_USER = String.raw`cd && for f in .config/systemd/user/*.service .config/systemd/user/*.timer; do [ -f "$f" ] || continue; printf '%s\0' "$HOME/$f"; cat "$f"; printf '\0'; done`;

export function systemd(d: SystemdDeps): ServiceManager {
  /** the unit that starts a job: its timer when it has one */
  const unitOf = (job: Job): string => (`${job.label}.timer` in job.files ? `${job.label}.timer` : `${job.label}.service`);
  return {
    kind: "systemd", dir: d.dir,
    kernelJobs: (labels, fill) => (["hhd", "console"] as const).map((job) => {
      const k = KERNEL[job];
      const v = (key: string): string => fill[key] ?? `{{${key}}}`;
      const label = labels[job];
      const text = unit(label, {
        program: [v("NODE"), `${v("CODE")}/${k.main}`], env: Object.fromEntries(Object.entries(k.env).map(([name, key]) => [name, v(key)])),
        out: `${v("LOG_DIR")}/${job}.out`, err: `${v("LOG_DIR")}/${job}.err`, cwd: v("CODE"), keep: true,
      });
      return { label, files: { [`${label}.service`]: text }, unfilled: k.need.filter((key) => fill[key] === undefined) };
    }),
    timerJob: (label, program, everyMs, env, logFile) => ({
      label,
      files: {
        [`${label}.service`]: unit(label, { program, env, out: logFile, err: logFile, keep: false }),
        [`${label}.timer`]: ["[Unit]", `Description=${label}`, "", "[Timer]", "OnActiveSec=0", `OnUnitActiveSec=${Math.max(1, Math.round(everyMs / 1000))}s`, "", "[Install]", "WantedBy=timers.target", ""].join("\n"),
      },
    }),
    serviceJob: (label, program, env, logFile, cwd) => ({ label, service: true, files: { [`${label}.service`]: unit(label, { program, env, out: logFile, err: logFile, cwd, keep: true }) } }),
    running: async (label) => (await d.systemctl(["is-active", "--quiet", `${label}.service`])).code === 0,
    start: async (job) => {
      const reload = await d.systemctl(["daemon-reload"]);
      return reload.code === 0 ? d.systemctl(["enable", "--now", unitOf(job)]) : reload;
    },
    stop: async (label) => {
      // a timer first: stopping only its service leaves the timer to start it again
      if (existsSync(join(d.dir, `${label}.timer`))) await d.systemctl(["disable", "--now", `${label}.timer`]);
      return d.systemctl(["disable", "--now", `${label}.service`]);
    },
    list: async (prefix) => unitJobs((existsSync(d.dir) ? readdirSync(d.dir).sort() : [])
      .filter((f) => f.startsWith(prefix) && /\.(service|timer)$/.test(f))
      .map((f) => ({ file: join(d.dir, f), text: readFileSync(join(d.dir, f), "utf8") }))),
    uninstall: async (label) => {
      const files = [`${label}.timer`, `${label}.service`].map((f) => join(d.dir, f)).filter((f) => existsSync(f));
      let r: Result = { code: 0, stderr: "" };
      for (const f of files) { const x = await d.systemctl(["disable", "--now", f.slice(d.dir.length + 1)]); if (x.code) r = x; }
      for (const f of files) rmSync(f, { force: true });
      await d.systemctl(["daemon-reload"]);   // so it is not left loaded as a unit whose file is gone
      // nor listed as failed until the next boot: a timer's oneshot that was running when it was stopped ends failed
      if (files.length) await d.systemctl(["reset-failed", ...files.map((f) => f.slice(d.dir.length + 1))]);
      return { ...r, removed: files };
    },
    startCommand: (job) => `systemctl --user daemon-reload && systemctl --user enable --now ${unitOf(job)}`,
  };
}
