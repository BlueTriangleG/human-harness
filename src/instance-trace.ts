// 入口漏带实例配置的留痕：入口（hh 命令行、hhd、控制台）在 requireInstance 失败时，往一个和角色、配置都无关的固定位置追加一行 JSON，
// hhd 定期读新行、按 error 记一条并带上父进程命令行，hh status 多一行摘要——谁新写了个漏带 HH_CONFIG 的入口，会被点名而不是静悄悄失败。
//   位置：/tmp/hh-misconfig-<uid>.jsonl。不用 os.tmpdir()（跟着 TMPDIR 走，漏带环境的入口正是环境不全的那种），不用家目录（框架不认家目录）。
//   测试：跑测试的进程（underTest）默认不写；要验证的测试用环境变量 HH_MISCONFIG_TRACE_FILE 指一个临时文件。平常跑不认这个变量。
//   生命周期：写的一边超过 256 KiB 就停；读的一边（hhd）读完发现文件大过 128 KiB 就截空，所以它不会写满以后悄悄失灵。截空时这一批已经读进内存、紧接着记进 hhd 的日志；
//   例外：一小时内已经报过的来源，新来的次数攒在内存里等下一次报告（hhd 重启就没了）。
// 写这一行的代码走在「本来就要退出 1」的路上：任何失败一律吞掉，不能让它换一种死法；
// 所有 open 都带 O_NONBLOCK：路径上被人放了命名管道，阻塞的 open 会把失败的入口和 hhd 的启动一起卡死（open 之后再核对是普通文件）。
import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { underTest } from "./testGuard.ts";
import type { Logger } from "./log.ts";

export const TRACE_ENV = "HH_MISCONFIG_TRACE_FILE";
const MAX_FILE_BYTES = 256 * 1024;
export const TRIM_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 1024;
const PARENT_CHARS = 200;
const SUB_CHARS = 40;
const FIELD_CHARS = 300;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const NB = constants.O_NONBLOCK;

export interface MisconfigRecord { t: number; what: string; sub: string; parent: string; cwd: string }

export function tracePath(uid: number): string { return `/tmp/hh-misconfig-${uid}.jsonl`; }

/** 入口算默认路径的唯一一处：测试里是 null（不写），除非测试用 HH_MISCONFIG_TRACE_FILE 指了一个临时文件；取不到 uid 也是 null */
export function traceTarget(env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): string | null {
  if (underTest(env)) return env[TRACE_ENV] || null;
  return uid === undefined ? null : tracePath(uid);
}

const myUid = (): number => process.getuid?.() ?? -1;

type St = { isFile(): boolean; uid: number; nlink: number };
/** 不能用的原因；能用就是 null：要是普通文件、归自己、只有一个链接 */
function whyUnusable(st: St): string | null {
  if (!st.isFile()) return "not a regular file";
  if (st.uid !== myUid()) return "owned by another user";
  if (st.nlink !== 1) return "link count is not 1";
  return null;
}

/** 打开留痕文件准备追加：不跟符号链接、不阻塞、核对是自己的普通文件、没超过 256 KiB。不行就是 -1（fd 已关） */
function openForAppend(path: string): number {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | NB, 0o600);
    const st = fstatSync(fd);
    if (whyUnusable(st) === null && st.size <= MAX_FILE_BYTES) return fd;
  } catch { /* 下面关掉 */ }
  if (fd >= 0) try { closeSync(fd); } catch { /* 同上 */ }
  return -1;
}

/**
 * 追加一行（唯一的写路径）：先打开并核对文件，核对过了才调 make 造这一行——所以文件写不了时不会去问 ps；超过 1 KB 就缩短。
 * 所有失败（包括 make 抛）都吞掉
 */
export function noteMisconfig(path: string, make: () => MisconfigRecord): void {
  const fd = openForAppend(path);
  if (fd < 0) return;
  try { writeSync(fd, fit(make())); } catch { /* 留痕不能让本来就要退出的程序换一种死法 */ }
  finally { try { closeSync(fd); } catch { /* 同上 */ } }
}

/** 一行不超过 1 KB 且仍是合法 JSON：先缩 what 和 cwd（最长的两个，也最没用），再一起缩，父进程命令行尽量留全 */
function fit(rec: MisconfigRecord): Buffer {
  const sub = rec.sub.slice(0, SUB_CHARS);
  for (const n of [Infinity, 300, 150, 60, 20, 0]) {
    const cut = (s: string, m: number): string => (s.length > m ? s.slice(0, m) : s);
    const b = Buffer.from(JSON.stringify({ t: rec.t, what: cut(rec.what, n), sub, parent: cut(rec.parent, Math.max(n, 100)), cwd: cut(rec.cwd, n) }) + "\n");
    if (b.length <= MAX_LINE_BYTES + 1) return b;
  }
  return Buffer.from(JSON.stringify({ t: rec.t, what: "", sub: "", parent: "", cwd: "" }) + "\n");
}

/** 父进程的命令行：绝对路径的 ps、-ww 不截断、UTF-8 locale（launchd 起的进程没有 LANG，非 ASCII 会被打成 M-xx），短超时；任何失败是空串。跟 browser/chrome.ts 同一个调法 */
export function parentCommand(ppid: number = process.ppid): string {
  try {
    return execFileSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(ppid)], {
      encoding: "utf8", timeout: 1000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "en_US.UTF-8" },
    }).trim();
  } catch { return ""; }
}

export interface NoteDeps { path?: string | null; parent?: () => string; now?: () => number }

/** 入口在 requireInstance 失败时调：sub 是这次调用的第一个参数（或 "hhd" / "console"）。没有目标路径（测试里）就什么都不做。文件写不了就不去问 ps（那要花最多一秒） */
export function noteEntryFailure(err: unknown, sub: string, deps: NoteDeps = {}): void {
  try {
    const path = deps.path === undefined ? traceTarget() : deps.path;
    if (!path) return;
    noteMisconfig(path, () => {
      const parent = (deps.parent ?? parentCommand)().slice(0, PARENT_CHARS);
      let cwd = "";
      try { cwd = process.cwd(); } catch { /* 当前目录被删了 */ }
      return { t: (deps.now ?? Date.now)(), what: err instanceof Error ? err.message : String(err), sub, parent, cwd };
    });
  } catch { /* 同上 */ }
}

export interface MisconfigRead {
  records: MisconfigRecord[];
  nextOffset: number;
  /** missing：没有这个文件；ok：读了；unusable：在，但不能用（reason 说为什么） */
  state: "missing" | "ok" | "unusable";
  reason: string;
  size: number;
  ino: number;
  /** 这一次读到了文件末尾（按 fstat 的大小）。一次最多读一个窗口（512 KiB），没到末尾时后面还有没读的整行 */
  atEnd: boolean;
}

/**
 * 读偏移以后的新行。文件变小、或者换了一个文件（ino 和上次不一样）就从头读；坏行跳过；只认以换行结尾的整行（没写完的留到下次），
 * 但一整个窗口都没有换行就跳过这一窗口（不然偏移钉在原地）；字段按长度截；符号链接、管道、别人的文件、多链接的都是 unusable。从不抛、不阻塞
 */
export function readMisconfig(path: string, fromOffset: number, knownIno?: number): MisconfigRead {
  const out = (state: MisconfigRead["state"], reason: string, extra: Partial<MisconfigRead> = {}): MisconfigRead =>
    ({ records: [], nextOffset: fromOffset, state, reason, size: 0, ino: knownIno ?? 0, atEnd: false, ...extra });
  let fd = -1;
  try {
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | NB); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "error";
      return code === "ENOENT" ? out("missing", "") : out("unusable", `open failed: ${code}`);
    }
    const st = fstatSync(fd);
    const bad = whyUnusable(st);
    if (bad) return out("unusable", bad);
    const start = st.size < fromOffset || (knownIno !== undefined && knownIno !== 0 && st.ino !== knownIno) ? 0 : fromOffset;
    const len = Math.min(st.size - start, 2 * MAX_FILE_BYTES);
    if (len <= 0) return out("ok", "", { nextOffset: start, size: st.size, ino: st.ino, atEnd: true });
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, start + got);
      if (n <= 0) break;
      got += n;
    }
    let end = buf.subarray(0, got).lastIndexOf(0x0a) + 1;
    if (end === 0 && got === len && len === 2 * MAX_FILE_BYTES) end = got;   // 一整个窗口没有换行：跳过
    const records: MisconfigRecord[] = [];
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      if (!line) continue;
      try {
        const o: unknown = JSON.parse(line);
        if (typeof o !== "object" || o === null || Array.isArray(o)) continue;
        const r = o as Record<string, unknown>;
        const s = (v: unknown, m: number): string => (typeof v === "string" ? v.slice(0, m) : "");
        records.push({ t: typeof r.t === "number" && Number.isFinite(r.t) ? r.t : 0, what: s(r.what, FIELD_CHARS), sub: s(r.sub, SUB_CHARS), parent: s(r.parent, PARENT_CHARS), cwd: s(r.cwd, FIELD_CHARS) });
      } catch { /* 不是 JSON 的行跳过 */ }
    }
    return { records, nextOffset: start + end, state: "ok", reason: "", size: st.size, ino: st.ino, atEnd: start + got >= st.size };
  } catch (e) { return out("unusable", `read failed: ${String((e as Error)?.message ?? e).slice(0, 100)}`); }
  finally { if (fd >= 0) try { closeSync(fd); } catch { /* 同上 */ } }
}

/**
 * 读完以后把文件截空——只在这一刻文件大小还正好等于刚读到的偏移、并且大过 minSize 时（同一个描述符上 fstat 再 ftruncate）。
 * 窗口：fstat 和 ftruncate 之间一个写入者追加一行（微秒级）会丢这一行：只发生在一个仍在失败的入口身上，不会损坏别的行，接受
 */
export function trimTrace(path: string, readUpTo: number, minSize: number = TRIM_BYTES): boolean {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW | NB);
    const st = fstatSync(fd);
    if (whyUnusable(st) !== null || st.size !== readUpTo || st.size <= minSize) return false;
    ftruncateSync(fd, 0);
    return true;
  } catch { return false; }
  finally { if (fd >= 0) try { closeSync(fd); } catch { /* 同上 */ } }
}

/** lastAt：这个父进程最新那条记录的时间（ISO）——hhd 重启后最近 24 小时的会再报一遍，看时间才分得出是不是还在出 */
export interface MisconfigReport { parent: string; sub: string; what: string; cwd: string; count: number; lastAt: string }

// 最近 24 小时的记录最多留这么多条（最新的）：一个失控的调用方一天能写几十万条，不能全攒在 hhd 里
const RECENT_MAX = 5000;

/**
 * hhd 这边：记住读到哪、最近 24 小时的记录。poll 读新行，返回这次该报的——同一个父进程命令行一小时只报一次，
 * 一小时里又来的次数攒着，下次报的时候一起带上（所以 count 是「自上次报告以来」；hhd 刚起来时是最近 24 小时里的）。
 * 一天以前的记录不报也不数；记录的时间比现在还晚的按现在算（不然永远过不了期）。读完发现文件大过 128 KiB 就截空
 */
export class MisconfigWatch {
  private offset = 0;
  private ino: number | undefined;
  private recent: MisconfigRecord[] = [];
  // 因为超过 RECENT_MAX 丢掉的记录里最新的时间：它还在 24 小时以内，摘要里的数就只是下限
  private droppedUpTo = -Infinity;
  private pending = new Map<string, { last: MisconfigRecord; count: number; lastT: number }>();
  private reportedAt = new Map<string, number>();
  private problem: string | null = null;
  private problemAt = -Infinity;
  private resetSize: number | null = null;
  private readonly path: string;
  constructor(path: string) { this.path = path; }

  poll(now: number): MisconfigReport[] {
    const read = readMisconfig(this.path, this.offset, this.ino);
    this.problem = read.state === "unusable" ? read.reason : null;
    if (read.state === "ok") {
      this.ino = read.ino;
      this.offset = read.nextOffset;
      for (const r0 of read.records) {
        const r = r0.t > now ? { ...r0, t: now } : r0;
        if (r.t < now - DAY_MS) continue;
        this.recent.push(r);
        const p = this.pending.get(r.parent);
        this.pending.set(r.parent, { last: r, count: (p?.count ?? 0) + 1, lastT: Math.max(p?.lastT ?? -Infinity, r.t) });
      }
      if (read.nextOffset >= read.size && trimTrace(this.path, read.size)) this.offset = 0;
      // 超过写的一边的上限（256 KiB）、这次读到了末尾、剩下没读的尾巴里没有换行（读到末尾时 nextOffset 停在最后一个换行后面）：
      // 写的一边已经停了，这样的文件自己恢复不了——也截空。没读到末尾的（一个窗口以外还有整行）不动，下一次接着读
      else if (read.size > MAX_FILE_BYTES && read.atEnd && read.nextOffset < read.size && trimTrace(this.path, read.size, MAX_FILE_BYTES)) {
        this.offset = 0;
        this.resetSize = read.size;
      }
    }
    this.recent = this.recent.filter((r) => r.t >= now - DAY_MS);
    if (this.recent.length > RECENT_MAX) {
      for (const r of this.recent.splice(0, this.recent.length - RECENT_MAX)) this.droppedUpTo = Math.max(this.droppedUpTo, r.t);
    }
    for (const [parent, p] of this.pending) if (p.last.t < now - DAY_MS) this.pending.delete(parent);
    for (const [parent, at] of this.reportedAt) if (now - at >= DAY_MS && !this.pending.has(parent)) this.reportedAt.delete(parent);
    const out: MisconfigReport[] = [];
    for (const [parent, p] of this.pending) {
      const at = this.reportedAt.get(parent);
      if (at !== undefined && now - at < HOUR_MS) continue;
      this.reportedAt.set(parent, now);
      this.pending.delete(parent);
      out.push({ parent, sub: p.last.sub, what: p.last.what, cwd: p.last.cwd, count: p.count, lastAt: new Date(p.lastT).toISOString() });
    }
    return out;
  }

  /** 最近一次 poll 发现文件不能用的原因（一小时里只给一次），没有就是 null */
  takeProblem(now: number): string | null {
    if (this.problem === null || now - this.problemAt < HOUR_MS) return null;
    this.problemAt = now;
    return this.problem;
  }

  /** 最近一次 poll 把一个卡死的文件（超过上限、尾巴没有换行）重置了的话，重置前的大小（只给一次） */
  takeReset(): number | null {
    const r = this.resetSize;
    this.resetSize = null;
    return r;
  }

  /** 记着的东西有多少（测试看清理用；只数，不 poll） */
  memorySize(): number {
    return this.recent.length + this.pending.size + this.reportedAt.size;
  }

  /** 最近 24 小时：几次、来自哪些父进程（次数多的在前，最多 5 个）；capped = 有超过上限丢掉的还在 24 小时以内，count 只是下限。没有就是 null */
  summary(now: number): { count: number; capped: boolean; parents: { parent: string; count: number }[] } | null {
    const recent = this.recent.filter((r) => r.t >= now - DAY_MS);
    if (recent.length === 0) return null;
    const by = new Map<string, number>();
    for (const r of recent) by.set(r.parent, (by.get(r.parent) ?? 0) + 1);
    const parents = [...by].map(([parent, count]) => ({ parent, count })).sort((a, b) => b.count - a.count).slice(0, 5);
    return { count: recent.length, capped: this.droppedUpTo >= now - DAY_MS, parents };
  }

  /** hh status 的那一行；最近 24 小时没有就是 null。丢掉过的时候写「5000+」，不写一个错的准数 */
  line(now: number): string | null {
    const s = this.summary(now);
    if (!s) return null;
    const n = s.capped ? `${s.count}+ entries` : `${s.count} ${s.count === 1 ? "entry" : "entries"}`;
    return `instance: ${n} failed the instance check in the last 24h — ${s.parents.map((p) => `${p.parent || "(unknown parent)"} (${p.count})`).join(", ")}`;
  }
}

/** hhd 起来时和之后每 10 分钟调一次：读新行，每个来源记一条 error；文件不能用就记一条（一小时一次）。从不抛 */
export function reportMisconfigTrace(watch: MisconfigWatch | null, log: Logger, now: number = Date.now()): void {
  if (!watch) return;
  try {
    // 日志消息沿用设计里的原话；对一个来源有一半是「实例配置设了但不完整」，细节在 what 里
    for (const r of watch.poll(now)) log.error("instance: an entry started without its config", { parent: r.parent, sub: r.sub, what: r.what, cwd: r.cwd, count: r.count, lastAt: r.lastAt });
    const bad = watch.takeProblem(now);
    if (bad) log.error("instance: the trace file is unusable", { reason: bad });
    const reset = watch.takeReset();
    if (reset !== null) log.error("instance: the trace file was reset", { size: reset });
  } catch (e) { log.warn("instance: reading the misconfig trace failed", { error: String(e).slice(0, 200) }); }
}

/** 给 hh status 合进去的字段：最近 24 小时有记录才有；出什么错都不影响 status */
export function statusExtraOf(watch: MisconfigWatch | null, now: () => number = Date.now): () => Record<string, unknown> {
  return () => {
    try {
      const l = watch?.line(now());
      return l ? { entriesWithoutConfig: l } : {};
    } catch { return {}; }
  };
}
