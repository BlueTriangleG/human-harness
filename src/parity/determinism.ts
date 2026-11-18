// 对照工具的确定性：时间、计时器、随机数、编号、临时目录名、pid、网络全换成虚拟的。场景子进程里最先装（main.ts 装好以后才动态 import 树里的模块），
// 这样模块一加载抓住的 Date、setTimeout 也是虚拟的。同一棵树、同一份快照，分两个进程跑出来的记录一个字节都不差。
// 树里唯一真的异步 I/O 是 node:sqlite 的 backup（线程池里一步步拷库）：包一层登记给时钟，它没拷完虚拟时间不走。
// 这个文件自己不 import node:sqlite（见 installBackup）。
import nodeCrypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

/** 排空用真的 setImmediate（不换）：虚拟时间不走，进程里排着的事照样一圈圈做完 */
const realSetImmediate = setImmediate;
const nextTurn = (): Promise<void> => new Promise((r) => { realSetImmediate(r); });

/** 连着这么多圈没动静才算排空 */
const QUIET_TURNS = 10;
/** 最多等这么多圈：一直停不下来的场景是要报的毛病，不是要盖住的 */
const MAX_TURNS = 2000;
/** Node 的上限（超过它 Node 按 1 毫秒算） */
const TIMEOUT_MAX = 2 ** 31 - 1;
const SEED = 0x5eed_0c1d;
/** 场景子进程里的 process.pid：macOS 发出的 pid 都小于 99999（PID_MAX），这个号不会是哪个真进程 */
export const PARITY_PID = 99_999;

/** 地址的字符串形式（fetch 的第一个参数可以是字符串、URL、Request） */
export function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** mulberry32：种子固定，同一串数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Timer { id: number; at: number; seq: number; delay: number; repeat: boolean; fn: (...args: unknown[]) => void; args: unknown[] }

/** 虚拟计时器的句柄：跟 Node 的 Timeout 一样能 unref / ref / refresh、能当数字用（虚拟的本来就不拖住进程） */
export class VirtualTimeout {
  readonly id: number;
  private readonly clock: VirtualClock;
  constructor(clock: VirtualClock, id: number) {
    this.clock = clock;
    this.id = id;
  }
  ref(): this { return this; }
  unref(): this { return this; }
  hasRef(): boolean { return false; }
  refresh(): this { this.clock.refresh(this.id); return this; }
  [Symbol.toPrimitive](): number { return this.id; }
}

/**
 * 虚拟时钟：now 归它管；计时器排在虚拟时间线上，只有 drain / advanceTo / run 才让它们到点。
 * quiet 由世界给（世界建好以前没有它，默认一直安静）：从上次问到现在没有新记录。
 * run(p) 登记一件在跑的事（剧本里的一轮、一次 tick）：它没完 drain 就不返回，要等的计时器到点为止。
 * io(p) 登记一件真的异步 I/O（等的是磁盘，不是计时器）：它没完 drain 就停在原地等，计时器不响、时间不走。
 */
export class VirtualClock {
  now: number;
  private readonly timers = new Map<number, Timer>();
  private nextId = 1;
  private nextSeq = 0;
  private quiet: () => boolean = () => true;
  private running = 0;
  /** 还在路上的真异步 I/O（每个都是不会拒掉的那一份） */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(t0: number) { this.now = t0; }

  /** 世界接上：每圈问一次「从上次问到现在，没有新记录吧」 */
  setQuiet(pred: () => boolean): void { this.quiet = pred; }

  /** 让 p 跑完：跑着的时候排空，它在等的虚拟计时器照时间顺序响（时间只走到它们需要的那一刻），完了再排空一次返回它的结果 */
  async run<T>(p: Promise<T>): Promise<T> {
    this.running += 1;
    const done = p.finally(() => { this.running -= 1; });
    done.catch(() => { /* 结果在下面 await 时抛给调用的一方；排空先抛的话这里不算没接住 */ });
    await this.drain();
    return done;
  }

  /**
   * 登记一件真的异步 I/O（线程池里做的，什么时候完看磁盘快慢），原样返回它。它没完，排空不数安静的圈、不让计时器响、不走时间，就等它。
   * 不能拿 run 来登记：run 着的事等的是虚拟计时器，排空安静下来会把时间走到下一个计时器去——拷库拷得慢一点，
   * 中间响过的计时器就多几个，记录跟着磁盘快慢变
   */
  io<T>(p: Promise<T>): Promise<T> {
    const settled: Promise<void> = p.then(() => {}, () => {}).finally(() => { this.inFlight.delete(settled); });
    this.inFlight.add(settled);
    return p;
  }

  setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): VirtualTimeout => this.add(fn, ms, args, false);
  setInterval = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]): VirtualTimeout => this.add(fn, ms, args, true);
  clearTimeout = (h: unknown): void => {
    const id = h instanceof VirtualTimeout ? h.id : typeof h === "number" ? h : null;
    if (id !== null) this.timers.delete(id);
  };
  clearInterval = this.clearTimeout;

  /** 排着还没到点的计时器有几个 */
  get pending(): number { return this.timers.size; }

  refresh(id: number): void {
    const t = this.timers.get(id);
    if (t) this.timers.set(id, { ...t, at: this.now + t.delay, seq: this.nextSeq++ });
  }

  /**
   * 排空：一圈圈地等（真的 setImmediate），直到连着 10 圈没有新记录。这时：有到点的计时器（时间 ≤ now）就按（时间、先后）响一个、接着排空；
   * 没有到点的、也没有 run 着的事就返回；有 run 着的事在等，就把时间走到下一个计时器、让它响（真时间也会这样过去）。
   * 有真的异步 I/O 在路上（io 登记的）：先等它完，再从头数安静的圈。
   * 2000 圈还停不下来就抛错：一直停不下来的场景是要报的毛病，不是要盖住的。
   */
  async drain(): Promise<void> {
    let quiet = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      await nextTurn();
      if (this.inFlight.size) { await Promise.all([...this.inFlight]); quiet = 0; continue; }
      quiet = this.quiet() ? quiet + 1 : 0;
      if (quiet < QUIET_TURNS) continue;
      const next = this.earliest();
      if (next && next.at <= this.now) { this.fire(next); quiet = 0; continue; }
      if (this.running === 0) return;
      if (next) { this.now = next.at; this.fire(next); quiet = 0; }
    }
    throw new Error(`parity: the world did not settle within ${MAX_TURNS} turns`);
  }

  /** 时间走到 t：到点的计时器按（时间、先后）一个个响，每个响之前 now 设成它的时间，响完排空 */
  async advanceTo(t: number): Promise<void> {
    await this.drain();
    for (;;) {
      const next = this.earliest();
      if (!next || next.at > t) break;
      this.now = Math.max(this.now, next.at);
      await this.drain();
    }
    this.now = Math.max(this.now, t);
  }

  private add(fn: (...args: unknown[]) => void, ms: number | undefined, args: unknown[], repeat: boolean): VirtualTimeout {
    if (typeof fn !== "function") throw new TypeError("parity: timer callback must be a function");
    const d = Number(ms);
    // 跟 Node 一样：不是正数、超过上限的按最短算；延时 0 就是「现在」（排空时响），循环的至少隔 1 毫秒，不然一直响
    const delay = d > 0 && d <= TIMEOUT_MAX ? d : repeat ? 1 : 0;
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.now + delay, seq: this.nextSeq++, delay, repeat, fn, args });
    return new VirtualTimeout(this, id);
  }

  private earliest(): Timer | undefined {
    let best: Timer | undefined;
    for (const t of this.timers.values()) if (!best || t.at < best.at || (t.at === best.at && t.seq < best.seq)) best = t;
    return best;
  }

  private fire(t: Timer): void {
    if (t.repeat) this.timers.set(t.id, { ...t, at: t.at + t.delay, seq: this.nextSeq++ });
    else this.timers.delete(t.id);
    t.fn(...t.args);
  }
}

export interface Determinism {
  clock: VirtualClock;
  /** 换上记录用的假 fetch（装的时候是一律抛错的那个） */
  setFetch(f: typeof fetch): void;
  /** 换回真的（只给测试用：场景子进程装上就不再拆） */
  restore(): void;
}

/**
 * 临时目录的名字不再随机：mkdtemp 一族（回调、同步、promise、disposable）建 <prefix><6 位计数>（建过的跳过），
 * 跟 Node 一样是 0700 的目录。返回拆掉的函数
 */
function installTempNames(): () => void {
  const f = fs as unknown as Record<string, unknown>;
  const fp = fs.promises as unknown as Record<string, unknown>;
  const saved = ([[f, "mkdtemp"], [f, "mkdtempSync"], [f, "mkdtempDisposableSync"], [fp, "mkdtemp"], [fp, "mkdtempDisposable"]] as const)
    .map(([o, k]) => [o, k, Object.getOwnPropertyDescriptor(o, k)] as const);
  let count = 0;
  const make = (prefix: unknown, options: unknown): string | Buffer => {
    const base = prefix instanceof URL ? fileURLToPath(prefix) : String(prefix);
    for (;;) {
      const p = `${base}${String(++count).padStart(6, "0")}`;
      try { fs.mkdirSync(p, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") continue; throw e; }
      const enc = typeof options === "string" ? options : (options as { encoding?: unknown } | null | undefined)?.encoding;
      return enc === "buffer" ? Buffer.from(p) : p;
    }
  };
  const set = (o: object, k: string, v: unknown): void => { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: true }); };
  set(f, "mkdtempSync", make);
  set(f, "mkdtemp", (prefix: unknown, a: unknown, b: unknown) => {
    const cb = (typeof a === "function" ? a : b) as (e: unknown, p?: unknown) => void;
    let p: string | Buffer;
    try { p = make(prefix, typeof a === "function" ? undefined : a); } catch (e) { process.nextTick(cb, e); return; }
    process.nextTick(cb, null, p);
  });
  set(fp, "mkdtemp", async (prefix: unknown, options: unknown) => make(prefix, options));
  set(f, "mkdtempDisposableSync", (prefix: unknown, options: unknown) => {
    const path = make(prefix, options);
    const remove = (): void => { fs.rmSync(path, { recursive: true, force: true }); };
    return { path, remove, [Symbol.dispose]: remove };
  });
  set(fp, "mkdtempDisposable", async (prefix: unknown, options: unknown) => {
    const path = make(prefix, options);
    const remove = async (): Promise<void> => { await fs.promises.rm(path, { recursive: true, force: true }); };
    return { path, remove, [Symbol.asyncDispose]: remove };
  });
  return () => { for (const [o, k, d] of saved) if (d) Object.defineProperty(o, k, d); };
}

/** installDeterminism 装着的那个时钟：包过的 backup 往它登记；没装着（测试里拆了以后）包过的 backup 就跟原来的一样 */
let ioClock: VirtualClock | null = null;

/**
 * node:sqlite 的 backup 包一层：拷库的 promise 登记给时钟（VirtualClock.io）。返回拆掉的函数。
 * 要赶在这个进程第一次把 node:sqlite 当 ES 模块 import 之前包：只能带 node: 前缀引的内置模块，Node 不给重新同步 ES 导出
 * （syncBuiltinESMExports 跳过它们），树里 import * as sqlite 拿到的是第一次 import 那一刻的 backup。所以这里从
 * process.getBuiltinModule 拿它的导出对象来改，不 import 它；场景子进程里树的模块都是装好以后才加载的（main.ts）
 */
function installBackup(): () => void {
  const mod = process.getBuiltinModule("node:sqlite");
  const real = mod.backup;
  if (typeof real !== "function") return () => {};
  mod.backup = ((...args: Parameters<typeof real>) => { const p = real(...args); return ioClock ? ioClock.io(p) : p; }) as typeof real;
  return () => { mod.backup = real; };
}

/**
 * 装上：Date、四个计时器函数、Math.random、crypto.randomUUID（全局的和 node:crypto 的）、fetch、临时目录的名字、process.pid、
 * node:sqlite 的 backup（登记给时钟的 io：拷库的时候虚拟时间不走）。
 * 树会把 pid 写进临时文件名（写完改名的那种、临时目录里的预览目录）：换成固定的 PARITY_PID
 */
export function installDeterminism(t0: number): Determinism {
  const clock = new VirtualClock(t0);
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = (["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "fetch"] as const).map((k) => [k, g[k]] as const);
  const realRandom = Math.random;
  const realUUID = nodeCrypto.randomUUID;
  const realPid = Object.getOwnPropertyDescriptor(process, "pid");

  const RealDate = Date;
  // 不带参数的 new Date() 和 Date.now() 读虚拟时钟；带参数的、Date.UTC、Date.parse 原样
  class VirtualDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(clock.now);
      else super(...(args as [number]));   // 运行时几个参数原样转交（年月日时分秒也一样）
    }
    static override now(): number { return clock.now; }
  }
  g.Date = VirtualDate;
  g.setTimeout = clock.setTimeout;
  g.clearTimeout = clock.clearTimeout;
  g.setInterval = clock.setInterval;
  g.clearInterval = clock.clearInterval;

  Math.random = mulberry32(SEED);

  let n = 0;
  const uuid = (): `${string}-${string}-${string}-${string}-${string}` => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: uuid, configurable: true, writable: true });
  nodeCrypto.randomUUID = uuid as typeof nodeCrypto.randomUUID;
  const restoreTemps = installTempNames();
  Object.defineProperty(process, "pid", { value: PARITY_PID, writable: false, enumerable: true, configurable: true });
  ioClock = clock;
  const restoreBackup = installBackup();
  syncBuiltinESMExports();   // import { randomUUID } from "node:crypto"、具名 import 的 mkdtemp 也换上

  // 记录器建好以前就有的 fetch：一律抛错（不出网）；之后换成记录器的
  const offline: typeof fetch = async (input) => { throw new Error(`parity: network is off (${urlOf(input)})`); };
  let handler = offline;
  g.fetch = ((input, init) => handler(input, init)) as typeof fetch;

  return {
    clock,
    setFetch: (f) => { handler = f; },
    restore: () => {
      for (const [k, v] of saved) g[k] = v;
      Math.random = realRandom;
      delete (globalThis.crypto as unknown as Record<string, unknown>).randomUUID;
      nodeCrypto.randomUUID = realUUID;
      restoreTemps();
      if (realPid) Object.defineProperty(process, "pid", realPid);
      restoreBackup();
      ioClock = null;
      syncBuiltinESMExports();
    },
  };
}
