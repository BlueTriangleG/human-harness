// What hhd runs for the loaded modules besides their tools. Timers: each on its own interval (hhd's 30-second tick is
// too coarse), one run at a time, bounded by its time limit; a standalone timer is a launchd job (hh modules install)
// and is left alone here. Processes: started with hhd, recorded under the role's state directory like the console, and
// stopped by that record — when hhd shuts down, and at the next start if an earlier hhd left one running.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { markRecord, moduleRecord, stopRecorded, type ProcRecord } from "../repair/restart.ts";
import { commandLine } from "./command.ts";
import { commandEnv, runHook, type Modules } from "./load.ts";

/** Start every timer; the returned function stops them all */
export function startTimers(mods: Modules): () => void {
  const handles: NodeJS.Timeout[] = [];
  for (const { spec, ctx } of mods.loaded) {
    for (const t of spec.timers ?? []) {
      if (t.standalone) continue;
      let running = false;
      handles.push(setInterval(() => {
        if (running) return;
        running = true;
        void runHook(t.run, ctx, `timer ${t.name}`).finally(() => { running = false; });
      }, t.everyMs));
    }
  }
  return () => { for (const h of handles) clearInterval(h); };
}

/**
 * Start every module process (after stopping the one an earlier hhd recorded); one that ends is started again restartMs
 * later, as launchd's KeepAlive would; its output goes to <name>.log in its state dir. The returned function stops them for good
 */
export function startProcesses(cfg: Config, mods: Modules, restartMs = 10_000): () => void {
  let stopped = false;
  const records: ProcRecord[] = [];
  const waits = new Set<NodeJS.Timeout>();
  for (const { spec, ctx } of mods.loaded) {
    for (const p of spec.processes ?? []) {
      const record = moduleRecord(spec.name, p.name);
      // the one an earlier hhd started may still be up: not knowing, start no second one
      if (stopRecorded(cfg.stateDir, record) === null) {
        ctx.log("error", "modules: cannot check whether the process an earlier hhd started is still up (ps did not run); not starting another", { process: p.name });
        continue;
      }
      mkdirSync(ctx.stateDir, { recursive: true });
      const [cmd, args] = commandLine(join(ctx.dir, p.script), p.argv ?? [], cfg.tools.python);
      const start = (): void => {
        const out = openSync(join(ctx.stateDir, `${p.name}.log`), "a");
        const child = spawn(cmd, args, { cwd: cfg.workspace, env: { ...process.env, ...commandEnv(ctx, mods.binDirs) }, detached: true, stdio: ["ignore", out, out] });
        closeSync(out);
        child.on("error", (e) => ctx.log("error", "modules: process did not start", { process: p.name, error: e.message }));
        child.on("exit", (code, signal) => {
          if (stopped) return;
          ctx.log("warn", "modules: process ended, starting it again", { process: p.name, code, signal });
          const w = setTimeout(() => { waits.delete(w); if (!stopped) start(); }, restartMs);
          waits.add(w);
        });
        if (child.pid) markRecord(cfg.stateDir, record, child.pid);
        child.unref();
      };
      start();
      records.push(record);
    }
  }
  return () => {
    stopped = true;
    for (const w of waits) clearTimeout(w);
    for (const r of records) stopRecorded(cfg.stateDir, r);
  };
}
