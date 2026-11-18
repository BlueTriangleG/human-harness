// 醒来那一刻（夜里那一觉整理好、开了醒来那一页以后）：
// - refreshBeforeWake：换前缀以前跑一次配好的命令（sleep.wakeRefresh），人格自己的脚本按「已经醒了」重新生成要进前缀的文件。
//   HH 不认识是什么文件、什么脚本：命令由配置给，在工作区里以 hhd 自己的身份跑，有上限；跑不成、超时只记 warn，照旧醒来。
// - saveOpening：醒来那一页里主线的开场（这个会话的前缀 + 第一条消息）原样存一份，只留最新的几份，不用再猜她早上看到了什么。
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Runner, RunResult } from "../util/run.ts";
import type { Logger } from "../log.ts";
import { S } from "../lang/index.ts";

/** A refresh HH runs itself rather than a configured command */
export interface OwnRun { name: string; run(ms: number): Promise<RunResult> }
const isOwnRun = (x: unknown): x is OwnRun => typeof x === "object" && x !== null && !Array.isArray(x) && typeof (x as OwnRun).run === "function";

export const WAKE_REFRESH_SEC = 60;          // 不写秒数最多等多久
const WAKE_REFRESH_MAX_SEC = 600;

export interface RefreshDeps {
  cwd: string;
  run: Runner;
  later: (fn: () => void, ms: number) => void | (() => void);
  now: () => number;
  log: Logger;
}

/**
 * 跑一次配好的命令，等它跑完或到点（两头都有上限：命令自己的超时，和这里的计时，免得子进程的子进程拖住输出）。
 * 没配（undefined / null）什么都不做；配坏了（不是不空的字符串数组）记 warn 不跑。从不抛错。
 * Or what is a run HH starts itself, given its time limit (the night module's script, when the config names none)
 */
export async function refreshBeforeWake(what: unknown, sec: unknown, d: RefreshDeps): Promise<void> {
  if (what === undefined || what === null) return;
  let cmd: string;
  let go: (ms: number) => Promise<RunResult>;
  if (isOwnRun(what)) {
    cmd = what.name;
    go = what.run;
  } else if (!Array.isArray(what) || !what.length || !what.every((a) => typeof a === "string" && a.length > 0)) {
    d.log.warn("wake refresh: sleep.wakeRefresh must be a non-empty list of non-empty strings (argv), not run", { got: JSON.stringify(what).slice(0, 200) });
    return;
  } else {
    const [c, ...args] = what as string[];
    cmd = c!;
    go = (ms) => d.run(c!, args, { cwd: d.cwd, timeoutMs: ms });
  }
  const limit = typeof sec === "number" && sec > 0 ? Math.min(sec, WAKE_REFRESH_MAX_SEC) : WAKE_REFRESH_SEC;
  const ms = Math.round(limit * 1000);
  const started = d.now();
  const timer: { cancel?: () => void } = {};
  const timeout = new Promise<"timeout">((resolve) => {
    const c = d.later(() => resolve("timeout"), ms);
    if (typeof c === "function") timer.cancel = c;
  });
  try {
    const r: RunResult | "timeout" = await Promise.race([go(ms), timeout]);
    if (r === "timeout") d.log.warn("wake refresh: timed out, waking with the old files", { cmd, timeoutSec: limit });
    else if (r.code !== 0) d.log.warn("wake refresh: failed, waking with the old files", { cmd, code: r.code, stderr: r.stderr.trim().slice(-500) });
    else d.log.info("wake refresh: done", { cmd, ms: d.now() - started });
  } catch (e) {
    d.log.warn("wake refresh: could not run, waking with the old files", { cmd, error: String(e).slice(0, 300) });
  } finally {
    timer.cancel?.();
  }
}

export const OPENINGS_DIR = "wake";          // stateDir 下
export const OPENINGS_KEEP = 14;
const OPENING_FILE = /^\d{4}-\d{2}-\d{2}-\d{6}\.md$/;

/** 文件名用的本地时刻：YYYY-MM-DD-HHMMSS（tz 是她的时区） */
function stamp(at: number, tz: string): { file: string; shown: string } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
    .formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  return { file: `${p.year}-${p.month}-${p.day}-${p.hour}${p.minute}${p.second}`, shown: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${tz}` };
}

/**
 * 醒来那一页里主线的一次开场原样存下来：<dir>/<本地日期>-<时分秒>.md，前缀在前、第一条消息在后；只留最新的 keep 份
 * （只数这样命名的文件，别的不碰）。存不了只记 warn，不挡开场；返回存到哪（没存成是 null）
 */
export function saveOpening(o: { dir: string; at: number; tz: string; prefix: string; text: string; epoch: number; keep?: number; log: Logger }): string | null {
  try {
    const t = stamp(o.at, o.tz);
    mkdirSync(o.dir, { recursive: true });
    const file = join(o.dir, `${t.file}.md`);
    writeFileSync(file, [
      S.wake.pageHeader(t.shown, o.epoch),
      S.wake.prefixDivider,
      o.prefix,
      S.wake.openingDivider,
      o.text,
      "",
    ].join("\n"));
    const all = readdirSync(o.dir).filter((f) => OPENING_FILE.test(f)).sort();
    for (const f of all.slice(0, Math.max(0, all.length - (o.keep ?? OPENINGS_KEEP)))) rmSync(join(o.dir, f), { force: true });
    o.log.info("wake opening archived", { file, prefixChars: o.prefix.length, openingChars: o.text.length });
    return file;
  } catch (e) {
    o.log.warn("wake opening: not archived", { dir: o.dir, error: String(e).slice(0, 200) });
    return null;
  }
}
