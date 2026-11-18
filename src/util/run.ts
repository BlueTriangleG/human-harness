// 跑外部脚本：参数用数组传（不经过 shell），有超时，输出截断。
import { execFile } from "node:child_process";
import { B } from "../lang/index.ts";

export interface RunResult { code: number; stdout: string; stderr: string }

export type Runner = (cmd: string, args: readonly string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<RunResult>;

export const runProcess: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, [...args], { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });

export function summarize(r: RunResult, max = 6000): string {
  const out = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : "")).trim();
  const body = out.length > max ? B.run.outputTruncated(out.slice(0, max), out.length) : out;
  return r.code === 0 ? body || B.run.doneNoOutput : B.run.exitedWithCode(r.code, body);
}
