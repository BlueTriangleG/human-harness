// "One command": a tool or hook that runs a script of its module. The arguments become argv (or the whole argument
// object goes to stdin as JSON); the environment carries the HH_* facts; stdout is what the role reads, cut when too
// long; a non-zero exit is a failure and reports the last lines of stderr; every run has a time limit.
import { execFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { ZodRawShape } from "zod";
import type { CommandResult, ModuleHook, ModuleTool, RegionRole } from "./api.ts";
import { B } from "../lang/index.ts";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CHARS = 6000;
const TAIL_LINES = 20;

export interface CommandTool {
  name: string;
  description: string | (() => string);
  shape: ZodRawShape | (() => ZodRawShape);
  /** Relative to the module's directory; a .py file runs under the role's python */
  script: string;
  argv?: (args: Record<string, unknown>) => string[];
  /** Give the whole argument object on stdin as JSON */
  stdin?: boolean;
  regions?: readonly RegionRole[];
  timeoutMs?: number;
}

export interface CommandHook { script: string; argv?: () => string[]; timeoutMs: number }

export function command(o: CommandTool): ModuleTool;
export function command(o: CommandHook): ModuleHook;
export function command(o: CommandTool | CommandHook): ModuleTool | ModuleHook {
  if (!("name" in o)) {
    return {
      timeoutMs: o.timeoutMs,
      run: async (m) => {
        const r = await m.run(o.script, o.argv?.() ?? [], { timeoutMs: o.timeoutMs });
        if (r.code !== 0 || r.timedOut) throw new Error(failureText(r, o.timeoutMs));
        return r.stdout.trim();
      },
    };
  }
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    name: o.name, description: o.description, shape: o.shape, ...(o.regions ? { regions: o.regions } : {}),
    handler: async (args, m) => toolText(await m.run(o.script, o.argv?.(args) ?? [], { timeoutMs, ...(o.stdin ? { stdin: JSON.stringify(args) } : {}) }), timeoutMs),
  };
}

/** What the role reads from a run */
export function toolText(r: CommandResult, timeoutMs: number): string {
  if (r.code !== 0 || r.timedOut) return failureText(r, timeoutMs);
  const out = r.stdout.trim();
  if (!out) return B.run.doneNoOutput;
  return out.length > MAX_CHARS ? B.run.outputTruncated(out.slice(0, MAX_CHARS), out.length) : out;
}

function failureText(r: CommandResult, timeoutMs: number): string {
  if (r.timedOut) return B.modules.timedOut(Math.round(timeoutMs / 1000));
  const tail = (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-TAIL_LINES).join("\n");
  return B.run.exitedWithCode(r.code, tail);
}

/** A .py script runs under the role's python, anything else as an executable */
export const commandLine = (file: string, argv: readonly string[], python: string): [string, string[]] =>
  file.endsWith(".py") ? [python, [file, ...argv]] : [file, [...argv]];

/** Run a script: no shell, the given environment, stdin closed after the given text, killed at the time limit */
export function runScript(file: string, argv: readonly string[], o: { python: string; cwd: string; env: NodeJS.ProcessEnv; stateDir: string; stdin?: string; timeoutMs?: number }): Promise<CommandResult> {
  mkdirSync(o.stateDir, { recursive: true });
  const [cmd, args] = commandLine(file, argv, o.python);
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { cwd: o.cwd, env: o.env, timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (Error & { code?: unknown; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), timedOut: Boolean(e?.killed) });
    });
    child.stdin?.on("error", () => { /* the script did not read its stdin */ });
    child.stdin?.end(o.stdin ?? "");
  });
}
