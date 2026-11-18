// 锁文件：里面记拿锁的进程号。那个进程死了（她的命令被 2 分钟超时掐掉之类）就可以接手，不用干等过期。
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { R } from "../lang/index.ts";

/** 进程还在不在（别的账号的进程 kill 0 会 EPERM：算在） */
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as { code?: string }).code === "EPERM"; }
}

/** 拿到锁返回放锁的函数，别人拿着返回 null。读不懂的旧锁（没有进程号）按修改时间过 staleMs 算过期 */
export function takeLock(path: string, staleMs: number, now = Date.now()): (() => void) | null {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, t: new Date(now).toISOString() }) + "\n");
      closeSync(fd);
      return () => { try { unlinkSync(path); } catch { /* 已经没了 */ } };
    } catch {
      if (!stale(path, staleMs, now)) return null;
      try { unlinkSync(path); } catch { /* 别人刚接手 */ }
    }
  }
  return null;
}

function stale(path: string, staleMs: number, now: number): boolean {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    if (typeof pid === "number") return !alive(pid);
  } catch { /* 不是我们写的格式 */ }
  try { return now - statSync(path).mtimeMs > staleMs; } catch { return true; }
}

/**
 * 全公司共用的重活锁（CEO 11-12：16G 的机器同一时刻只跑一个重活）。跟 hh-guard、hh-fw、hh-parity、hh-heavy 同一个约定：
 * mkdir 一个目录就算拿到，里面写 pid（谁拿着）和 who（在干什么）；拿着的进程没了就可以接手。
 * 11-14 CEO：她的 hh deploy、hh fix check 跑全套前也要拿它（原来不拿，04:19 跟别人的全套撞上，部署被一条真实计时的测试拒了）。
 * 锁放在哪、等多久是这台机器的约定，写在修理规则（config/repair.json 的 heavyLock）里；没配、或者锁所在的目录不存在（别的机器）就不拿（heavyLockFrom）。
 * 两个账号（主人的和角色的）都会拿：锁放在两边都能删的目录里（同组可写、没有粘滞位），锁目录和里面的文件也建成同组可写，
 * 哪边的进程被杀了留下的死锁，另一边都清得掉（/tmp 带粘滞位，别人的死锁删不掉，只能干等）。
 */
export interface HeavyLock {
  /** 锁目录（这台机器上是 /Users/Shared/hh-heavy/lock；测试一律给临时目录，不碰线上那把） */
  path: string;
  /** 拿到以后写进 who：别人等的时候看得到在等谁 */
  who: string;
  /** 最多等多久；等不到就照实说在等谁，不硬跑 */
  waitMs: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => void;
}

/** 修理规则里的 heavyLock 变成这一次要拿的锁：没配、或者锁所在的目录不存在（别的机器、别的角色没有这个约定）就是 undefined，不拿，也不去建那个目录 */
export function heavyLockFrom(conf: { path?: unknown; waitMs?: unknown } | undefined, who: string): HeavyLock | undefined {
  if (!conf || typeof conf.path !== "string" || conf.path === "" || typeof conf.waitMs !== "number") return undefined;
  if (!existsSync(dirname(conf.path))) return undefined;
  return { path: conf.path, who, waitMs: conf.waitMs };
}

/** 锁目录里没有 pid、又放了这么久：拿锁的进程死在 mkdir 和写 pid 之间，当死锁 */
const NO_PID_STALE_MS = 60_000;

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * 拿到给 release；等满 waitMs 还没拿到给 waitingFor（「谁（pid）」）。拿着的进程没了就接手；
 * 死锁删不掉（别的账号用老办法建的、目录权限不对）就照等，并在 waitingFor 里写明删不掉，好让人去清
 */
export function takeHeavy(o: HeavyLock): { release: () => void } | { waitingFor: string } {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? sleepSync;
  const until = now() + o.waitMs;
  for (;;) {
    try {
      mkdirSync(o.path);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST") return { waitingFor: R.lock.lockUnavailable(o.path, code ?? String(e)) };
      const read = (f: string): string => { try { return readFileSync(join(o.path, f), "utf8").trim(); } catch { return ""; } };
      const pid = Number(read("pid"));
      let holder = R.lock.lockHolder(read("who") || "?", pid || "?");
      let dead = pid > 0 && !alive(pid);
      if (!(pid > 0)) { try { dead = now() - statSync(o.path).mtimeMs > NO_PID_STALE_MS; } catch { continue; } }
      if (dead) {
        try { rmSync(o.path, { recursive: true }); continue; } catch { holder = R.lock.lockHolderDead(holder, o.path); }
      }
      if (now() >= until) return { waitingFor: holder };
      sleep(o.pollMs ?? 3_000);
      continue;
    }
    // 同组可写：这一边的进程被杀了，另一个账号也清得掉（macOS 上新建的目录本来就沿用上级目录的组，不用 setgid）
    try { chmodSync(o.path, 0o775); } catch { /* 改不了权限：照拿，只是死了以后另一边清不掉 */ }
    for (const [f, v] of [["pid", `${process.pid}\n`], ["who", `${o.who}\n`]] as const) {
      writeFileSync(join(o.path, f), v);
      try { chmodSync(join(o.path, f), 0o664); } catch { /* 同上 */ }
    }
    return { release: () => { try { rmSync(o.path, { recursive: true, force: true }); } catch { /* 已经没了 */ } } };
  }
}

/**
 * The background hh fix's keeper, once its worker has ended without finishing (killed holding them, or crashed): the
 * locks that worker still holds go now, not at the next taker's look. One someone else has taken since is left alone.
 * heavy: a takeHeavy directory (its pid file); file: a takeLock file ({ pid, t })
 */
export function dropLocksOf(pid: number, locks: { heavy?: string; file: string }): void {
  const holder = (f: string): number | undefined => {
    try { const s = readFileSync(f, "utf8").trim(); return s.startsWith("{") ? (JSON.parse(s) as { pid?: number }).pid : Number(s); } catch { return undefined; }
  };
  if (locks.heavy && holder(join(locks.heavy, "pid")) === pid) rmSync(locks.heavy, { recursive: true, force: true });
  if (holder(locks.file) === pid) rmSync(locks.file, { force: true });
}
