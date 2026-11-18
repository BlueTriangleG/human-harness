// 用量当量按天、按去向累计：numbers.ts 里「会话记录」那一段的口径，做成能一行行喂、按文件接着读的。
// 为什么另做：会话记录整个目录有好几个 G，周表放进控制台这个常驻进程里，不能每次把几天的记录整份重读一遍（运维 11-13）。
// 口径和 numbers() 一样：带 usage 的行，按消息（message.id + requestId）去重，四种 token 各自累计，要看时再按权重折成当量（百万）。
// 存的是没折算的 token 数，所以换权重不用重读。只读会话记录；状态（每个文件读到哪、每天的合计）可以存成一个文件，进程重启接着读。
//
// 和整份重读相比，接着读有两处做不到一模一样，都往少算的方向偏、不会多算：
// - 一个文件变短了（被重写）：从它新的结尾接着读，重写掉的那部分不重数
// - 进程重启以后，「这条消息数过没有」只记得每个文件最后那一条和重启后新读到的；重启前数过的消息要是被带进另一个新文件，会再数一次
//   （11-13 的数据里没有哪个请求同时出现在两份记录里）
//
// 符号链接跟着走（和整份重读一样）：旧的会话记录会被归档到别的盘、原地留一个链接，不跟就把归档走的那些天少算了（11-14 真数据上查出来的）。
// 同一个真实的目录、真实的文件一遍只走一次，所以链接绕回上层不会转圈，两个链接指到同一处也不会读两遍。
// 链接指的地方这会儿够不着（盘没挂上、链接断了）：不崩，也不当它没有——读过的，记号留着、合计不动，够得着了从原来的地方接着读；
// 从没读过的，报出来有几个、最晚是哪一刻归档的（UsageReport.unread），那一刻以前的日子可能少算，页面上要标出来。
import { lstat, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { localDay } from "../learning/score.ts";
import { DEFAULT_WEIGHTS, DESTS, destOf } from "./numbers.ts";
import type { Dest, NumbersInput, Weights } from "./numbers.ts";
import { freshTail, readAppended } from "./incidents.ts";
import type { Tail } from "./incidents.ts";

const DAY_MS = 86_400_000;

/** 四种 token 各多少（没折算） */
export interface Tokens { cacheRead: number; cacheWrite: number; input: number; output: number }
const noTokens = (): Tokens => ({ cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
const emptyDay = (): Record<Dest, Tokens> => Object.fromEntries(DESTS.map((k) => [k, noTokens()])) as Record<Dest, Tokens>;   // 按 DESTS 生成：去向加一类不用再改这里

/** 当量（百万）：按 API 价格的比例折算，和 numbers() 里那一行算式一样 */
export function weigh(t: Tokens, w: Weights = DEFAULT_WEIGHTS): number {
  return (t.cacheRead * w.cacheRead + t.cacheWrite * w.cacheWrite + t.input * w.input + t.output * w.output) / 1e6;
}

/** 数数的那一半：喂进来的是行，不碰文件 */
export class UsageTally {
  /** 日子 → 去向 → token 数 */
  private readonly days = new Map<string, Record<Dest, Tokens>>();
  /** 数过的消息 → 那一行的时刻（去重用；只留窗口里的） */
  private readonly seen = new Map<string, number>();
  /** 每个文件最后数的那条消息（存盘用：重启后同一条消息的后半截不再数一遍） */
  private readonly lastKey = new Map<string, string>();
  readonly tz: string;
  readonly keepDays: number;
  /** 比这早的行不要 */
  private floor = -Infinity;

  constructor(o: { tz: string; keepDays?: number }) {
    this.tz = o.tz;
    this.keepDays = o.keepDays ?? 21;
  }

  /** 一份会话记录新读到的几行；dest 是它的去向（按最上面那层目录认，见 numbers.ts 的 destOf） */
  feed(file: string, dest: Dest, lines: Iterable<string>): void {
    for (const line of lines) {
      if (!line.includes("\"usage\"")) continue;
      let r: { timestamp?: string; requestId?: string; message?: { id?: string; usage?: Record<string, unknown> } };
      try { r = JSON.parse(line) as typeof r; } catch { continue; }
      const u = r.message?.usage;
      const t = Date.parse(r.timestamp ?? "");
      if (!u || typeof u !== "object" || !Number.isFinite(t)) continue;
      const key = `${r.message?.id ?? ""}\u0000${r.requestId ?? ""}`;
      if (key !== "\u0000") {
        if (this.seen.has(key)) continue;
        this.seen.set(key, t);
        this.lastKey.set(file, key);
      }
      if (t < this.floor) continue;
      const day = localDay(t, this.tz);
      let d = this.days.get(day);
      if (!d) { d = emptyDay(); this.days.set(day, d); }
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      const into = d[dest];
      into.cacheRead += n("cache_read_input_tokens"); into.cacheWrite += n("cache_creation_input_tokens");
      into.input += n("input_tokens"); into.output += n("output_tokens");
    }
  }

  /** 窗口挪到 now：太早的日子和去重记号不留。读文件之前叫一次 */
  advance(now: number): void {
    this.floor = now - this.keepDays * DAY_MS;
    const first = localDay(this.floor, this.tz);
    for (const day of this.days.keys()) if (day < first) this.days.delete(day);
    for (const [k, t] of this.seen) if (t < this.floor) this.seen.delete(k);
  }

  /** 这个文件没了：它的记号不留（数过的合计还在，那些用量确实发生过） */
  forget(file: string): void { this.lastKey.delete(file); }

  /** 某一天各去向的 token 数；没有就是 0 */
  tokens(day: string): Record<Dest, Tokens> {
    const d = this.days.get(day);
    return Object.fromEntries(DESTS.map((k) => [k, { ...(d?.[k] ?? noTokens()) }])) as Record<Dest, Tokens>;
  }

  /** 某一天各去向的当量（百万）：就是 NumbersDay.usage */
  usage(day: string, w: Weights = DEFAULT_WEIGHTS): Record<Dest, number> {
    const d = this.tokens(day);
    return Object.fromEntries(DESTS.map((k) => [k, weigh(d[k], w)])) as Record<Dest, number>;
  }

  /** 存盘的样子：每天的合计、每个文件最后数的那条消息 */
  dump(): { days: Record<string, Record<Dest, Tokens>>; lastKey: Record<string, string> } {
    return { days: Object.fromEntries([...this.days].map(([day]) => [day, this.tokens(day)])), lastKey: Object.fromEntries(this.lastKey) };
  }

  /** 从存盘的样子接着数（样子不对的那一项不要） */
  restore(saved: { days?: unknown; lastKey?: unknown }, now: number): void {
    this.days.clear(); this.seen.clear(); this.lastKey.clear();
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
    if (saved.days && typeof saved.days === "object") {
      for (const [day, v] of Object.entries(saved.days as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v || typeof v !== "object") continue;
        const d = emptyDay();
        for (const k of DESTS) {
          const x = (v as Record<string, unknown>)[k] as Record<string, unknown> | undefined;
          if (x && typeof x === "object") d[k] = { cacheRead: num(x.cacheRead), cacheWrite: num(x.cacheWrite), input: num(x.input), output: num(x.output) };
        }
        this.days.set(day, d);
      }
    }
    if (saved.lastKey && typeof saved.lastKey === "object") {
      for (const [file, key] of Object.entries(saved.lastKey as Record<string, unknown>)) {
        if (typeof key !== "string" || !key) continue;
        this.lastKey.set(file, key);
        this.seen.set(key, now);   // 那条消息的后半截再读到时不重数
      }
    }
    this.advance(now);
  }
}

// ---------- 读文件：每次只读新加的那一截，状态可以存盘 ----------

export interface UsageScanOptions {
  /** Claude Code 的会话记录目录（~/.claude/projects）：下面每个目录是一个工作目录的记录，子代理的在更下面几层 */
  projectsDir: string;
  /** HH 自己的工作区、回放的目录：去向按它们认（同 numbers()） */
  dirs: NumbersInput["dirs"];
  tz: string;
  /** 留多少天的合计（默认 21：两周对比再多留几天） */
  keepDays?: number;
  /** 状态存到哪个文件（每个文件读到哪、每天的合计）；不给就只记在内存里，进程重启要重读 */
  cacheFile?: string;
  chunkBytes?: number;
  /** 两次读文件至少隔多久 */
  minIntervalMs?: number;
}

export interface UsageReport {
  /** 这份数是什么时候算的 */
  at: number;
  /** 这次读了多少字节、多少个文件有新内容、用了多久 */
  readBytes: number;
  files: number;
  tookMs: number;
  /**
   * 够不着、又从没读过的归档：有几个链接，最晚的一个是哪一刻归档走的（链接自己的修改时间）。
   * 那一刻以前的日子，用量可能比真的少。都够得着（或者够不着的那些以前读过、比窗口还早归档的）就是 null
   */
  unread: { links: number; upTo: number } | null;
}

/** 存盘的样子变了就加一：旧的不用，从头读（2：开始跟符号链接，1 存的合计少了归档走的那些；3：多了「团队」这个去向，存盘里记下按哪些目录认去向） */
const CACHE_VERSION = 3;
/** 往下找几层（同 numbers.ts 的 transcriptsSince：<会话>/subagents/*.jsonl 在下面几层） */
const MAX_DEPTH = 4;

/** 跟着符号链接看这一项。是个链接、它指的地方这会儿够不着（盘没挂上、链接断了、自己绕自己）：记进 broken，返回 null */
async function reach(path: string, rel: string, broken: Array<{ rel: string; at: number }> | null): Promise<Stats | null> {
  try { return await stat(path); } catch {
    if (broken) try { const l = await lstat(path); if (l.isSymbolicLink()) broken.push({ rel, at: l.mtimeMs }); } catch { /* 刚好没了 */ }
    return null;
  }
}
/** 这个真实的目录 / 文件这一遍走过没有；没走过就记上 */
function seenBefore(walked: Set<string>, st: Stats): boolean {
  const id = `${st.dev}:${st.ino}`;
  if (walked.has(id)) return true;
  walked.add(id);
  return false;
}
/** 一个相对路径和它上面的每一层："a/b/c.jsonl" → ["a", "a/b", "a/b/c.jsonl"] */
function uppers(rel: string): string[] {
  const parts = rel.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export class UsageScanner {
  readonly tally: UsageTally;
  private readonly tails = new Map<string, Tail>();
  private running: Promise<UsageReport> | null = null;
  private last: UsageReport | null = null;
  private loaded = false;
  private readonly o: UsageScanOptions;
  /** 正在读的这一遍读到哪了（页面上显示「还在读」用） */
  progress: { files: number; readBytes: number } | null = null;

  constructor(o: UsageScanOptions) {
    this.o = o;
    this.tally = new UsageTally({ tz: o.tz, ...(o.keepDays !== undefined ? { keepDays: o.keepDays } : {}) });
  }

  /** 最近一次读完的结果（还没读完过就是 null） */
  get latest(): UsageReport | null { return this.last; }

  /** 读一遍新加的。正在读就等那一次；离上一次不到 minIntervalMs 就给上一次的 */
  scan(now: number): Promise<UsageReport> {
    if (this.running) return this.running;
    if (this.last && now >= this.last.at && now - this.last.at < (this.o.minIntervalMs ?? 10 * 60_000)) return Promise.resolve(this.last);
    this.running = this.run(now).then((r) => { this.last = r; return r; }).finally(() => { this.running = null; this.progress = null; });
    return this.running;
  }

  private async run(now: number): Promise<UsageReport> {
    const began = performance.now();
    if (!this.loaded) { this.loaded = true; await this.load(now); }
    this.tally.advance(now);
    const since = now - (this.tally.keepDays + 1) * DAY_MS;
    const chunk = this.o.chunkBytes ?? 1024 * 1024;
    const progress = { files: 0, readBytes: 0 };
    this.progress = progress;
    const live = new Set<string>();
    const walked = new Set<string>();                         // 这一遍走过的真实目录、真实文件（设备号:inode）
    const broken: Array<{ rel: string; at: number }> = [];    // 够不着的链接，和它是哪一刻放在这里的
    let tops: string[] = [];
    try { seenBefore(walked, await stat(this.o.projectsDir)); tops = (await readdir(this.o.projectsDir)).sort(); } catch { /* 目录还没有 */ }   // 会话记录目录自己也记上：下面有链接绕回它，不再走一遍
    for (const top of tops) {
      const dest = destOf(top, this.o.dirs);
      await this.walk(top, join(this.o.projectsDir, top), 0, walked, broken, async (rel, path, st) => {
        live.add(rel);
        let tail = this.tails.get(rel);
        if (!tail) {
          // 第一次见到：窗口开始以前就没再动过的，里面不会有窗口里的行，不读
          tail = freshTail(st.mtimeMs < since ? st.size : 0);
          this.tails.set(rel, tail);
        }
        if (st.size < tail.offset) { tail = freshTail(st.size); this.tails.set(rel, tail); }   // 变短了：从新的结尾接着读，不重数
        if (st.size === tail.offset) return;
        try {
          const n = await readAppended(path, tail, st.size, chunk, (lines) => this.tally.feed(rel, dest, lines));
          progress.files += 1; progress.readBytes += n;
        } catch { /* 读到一半没了：下次再说 */ }
      });
    }
    // 够不着的链接下面那些文件不是没了：记号留着，够得着了从原来的地方接着读（不留的话，回来以后会从头再数一遍）
    const gone = new Set(broken.map((b) => b.rel));
    const have = new Set<string>();   // 读过的文件，和它上面每一层
    for (const rel of [...this.tails.keys()]) {
      const above = uppers(rel);
      if (!live.has(rel) && !above.some((a) => gone.has(a))) { this.tails.delete(rel); this.tally.forget(rel); continue; }
      for (const a of above) have.add(a);
    }
    // 从没读过的那几个里，窗口开始以后才归档走的才可能少算（更早归档的，里面的记录也比窗口早）
    const never = broken.filter((b) => b.at >= since && !have.has(b.rel));
    const unread = never.length ? { links: never.length, upTo: Math.max(...never.map((b) => b.at)) } : null;
    const report: UsageReport = { at: now, readBytes: progress.readBytes, files: progress.files, tookMs: Math.round(performance.now() - began), unread };
    if (report.readBytes > 0 || !this.last) await this.save();
    return report;
  }

  /**
   * 一个工作目录下所有的 .jsonl（往下最多 MAX_DEPTH 层），一个个交出去。符号链接跟着走；
   * walked 里有的真实目录、真实文件不再走（绕回上层的链接、指到同一处的两个链接）；够不着的链接记进 broken
   */
  private async walk(
    top: string, path: string, depth: number, walked: Set<string>, broken: Array<{ rel: string; at: number }>,
    each: (rel: string, path: string, st: Stats) => Promise<void>, rel = top, known?: Stats,
  ): Promise<void> {
    const st = known ?? await reach(path, rel, broken);
    if (!st?.isDirectory() || seenBefore(walked, st)) return;
    let names: string[];
    try { names = (await readdir(path)).sort(); } catch { return; }
    for (const f of names) {
      const p = join(path, f), r = `${rel}/${f}`;
      // 够不着的链接里，名字一看就是别的文件的（.md、.json…）不算：它后面不会是记录
      const s = await reach(p, r, f.endsWith(".jsonl") || !/\.[A-Za-z0-9]{1,8}$/.test(f) ? broken : null);
      if (!s) continue;
      if (s.isDirectory()) { if (depth < MAX_DEPTH) await this.walk(top, p, depth + 1, walked, broken, each, r, s); continue; }
      if (s.isFile() && f.endsWith(".jsonl") && !seenBefore(walked, s)) await each(r, p, s);
    }
  }

  /** 按哪些目录认去向，拼成一串：存进缓存，对不上就不用那份缓存 */
  private dirsKey(): string {
    const d = this.o.dirs;
    return JSON.stringify([d.workspace, [...d.replay].sort(), [...(d.team ?? [])].sort()]);
  }

  private async load(now: number): Promise<void> {
    if (!this.o.cacheFile) return;
    try {
      const j = JSON.parse(await readFile(this.o.cacheFile, "utf8")) as { v?: unknown; tz?: unknown; dir?: unknown; dirs?: unknown; files?: unknown; days?: unknown; lastKey?: unknown };
      // 换了时区、换了会话记录目录、或者样子变了：不用，从头读
      // 认去向用的目录变了（配上、改了团队目录，换了工作区）：缓存里每天的合计是按旧认法分的栏，也不用，从头读、重新分
      if (j.v !== CACHE_VERSION || j.tz !== this.o.tz || j.dir !== this.o.projectsDir || j.dirs !== this.dirsKey() || !j.files || typeof j.files !== "object") return;
      this.tally.restore(j, now);
      for (const [rel, offset] of Object.entries(j.files as Record<string, unknown>)) {
        if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) this.tails.set(rel, freshTail(offset));
      }
    } catch { /* 没有、读不了、不是 JSON：从头读 */ }
  }

  /** 存的位置是「读完整行」的地方：最后那半行不算读过，下次从它开头再读 */
  private async save(): Promise<void> {
    if (!this.o.cacheFile) return;
    const files = Object.fromEntries([...this.tails].map(([rel, t]) => [rel, t.skipping ? t.offset : t.offset - t.carry.length]));
    const body = JSON.stringify({ v: CACHE_VERSION, tz: this.o.tz, dir: this.o.projectsDir, dirs: this.dirsKey(), files, ...this.tally.dump() });
    try {
      const tmp = `${this.o.cacheFile}.tmp-${process.pid}`;
      await writeFile(tmp, body, { mode: 0o600 });   // 只有自己能读写
      await rename(tmp, this.o.cacheFile);
    } catch { /* 存不了就只在内存里：页面照常出数，只是进程重启要重读一遍 */ }
  }
}
