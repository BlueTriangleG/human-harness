// 「她顺不顺」按小时的三样数：内核请求数、被安全检查停掉 / 被模型拒绝的次数、hhd 的事件循环被卡住多久。
// 口径只在这一处；控制台的那一页调这里，周表以后也调这里。
// 只读本地文件：她工作区那个项目目录下第一层的会话记录（一个文件一个会话；subagents/ 下她开的子代理不算），和 HH 日志。
// 不调模型、不写任何东西，也不留被拦的正文：只数数。
//
// 怎么数（和运维 11-13 手工数的脚本逐条一致）：
// - 请求：type=assistant 的行，model 是 <synthetic> 的不算；按 requestId（没有就用 message.id）去重，所有文件合起来一个请求只算一次，
//   算在最先读到的那一行的时刻上（一个请求常被写成好几行）
// - 被停，两种记号：「被拒停」= 那个请求有一行 stop_reason=refusal（哪一行都看，一个请求只算一次）；
//   「提示」= type=system、subtype=informational、内容里有 CLI 那句固定的话（STOP_NOTICE）。
//   同一份记录里把两种按时间排好，从最早一条没用过的开始，往后 10 秒内有一条另一种的就和它并成一次（最多并一条）；
//   同一种连着出现不合并，各算各的。并成的那一次算在前一条的时刻上
// - 被拒：type=system、subtype=model_refusal_no_fallback 的行，一行一次，不参与合并
// - 这两种 system 行带 uuid 的按 uuid 去重（同一行被带进另一份记录时只算一次；11-13 的数据里没有这种，是给 CLI 以后改写法留的保险），没有 uuid 的照旧一行一次
// - 卡住：日志里 msg=event loop blocked 的行，ms 是卡了多久。t 是恢复以后才记的，就按 t 归小时（最长的也不到一分钟）；回放里记的（replay=true）不算
// - 小时按她的时区切
//
// 会话记录一天有一两百兆，页面开着时隔几分钟就要一次数：所以按文件记着读到哪了，每次只读新加的那一截（记录只往后追加；变短了就当新文件从头读）。
import { lstat, open, readdir } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import { B } from "../lang/index.ts";

/**
 * CLI 那句提示里固定的一截。故意用 \u 转义写，别改回原文：她修系统时会读 HH 的代码，11-13 的教训是这句话被反复喂回她的上下文、越喂越多（运维）。
 * 测试和演示数据要用到它时引用这个常量，原文不进仓库。
 * 和 src/kernel/sdk.ts 的 STOP_NOTICE 是同一句（那边认活着的会话里的消息，这里认会话记录里的行）。这里不引那一个：
 * 引了就要把内核的 SDK 一起装进控制台进程。两处一字不差由 test/incidents.test.ts 看着。
 */
export const STOP_NOTICE = "\u0073\u0061\u0066\u0065\u0067\u0075\u0061\u0072\u0064\u0073\u0020\u0073\u0074\u006f\u0070\u0070\u0065\u0064\u0020\u0074\u0068\u0065\u0020\u0072\u0065\u0073\u0070\u006f\u006e\u0073\u0065";

const HOUR_MS = 3_600_000;
/** 两种「被停」的记号隔多久以内算同一次 */
export const MERGE_MS = 10_000;

export interface IncidentCounts {
  /** 内核请求数 */
  requests: number;
  /** 被安全检查停掉的次数（被拒停和提示并过以后） */
  stops: number;
  /** 模型拒绝、又没有可退的模型的次数 */
  refusals: number;
  /** hhd 的事件循环被卡住：几次、一共多少毫秒、最长的一次 */
  blocks: number;
  blockedMs: number;
  longestMs: number;
}

export interface IncidentHour extends IncidentCounts {
  /** 这个小时开头的时刻（毫秒）；day、hour 是它在她的时区里的日子和几点 */
  start: number;
  day: string;
  hour: number;
}

const zero = (): IncidentCounts => ({ requests: 0, stops: 0, refusals: 0, blocks: 0, blockedMs: 0, longestMs: 0 });

// ---------- 小时：按她的时区切 ----------

/** 一个时刻落在哪个小时（按 tz 的整点）。时区的偏移按一刻钟一格记着，不用每行都问一遍 Intl */
export class HourClock {
  private readonly fmt: Intl.DateTimeFormat;
  private readonly offsets = new Map<number, number>();
  readonly tz: string;
  constructor(tz: string) {
    this.tz = tz;
    this.fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  /** 当地的钟比 UTC 快多少毫秒 */
  offset(t: number): number {
    const slot = Math.floor(t / 900_000);
    let off = this.offsets.get(slot);
    if (off === undefined) {
      const p = Object.fromEntries(this.fmt.formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
      off = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(t / 1000) * 1000;
      if (this.offsets.size > 4000) this.offsets.clear();
      this.offsets.set(slot, off);
    }
    return off;
  }
  /** t 所在的那个小时开头的时刻 */
  startOf(t: number): number {
    const off = this.offset(t);
    return Math.floor((t + off) / HOUR_MS) * HOUR_MS - off;
  }
  /** 一个小时开头的时刻 → 当地的日子和几点 */
  label(start: number): { day: string; hour: number } {
    const d = new Date(start + this.offset(start));
    return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
  }
}

// ---------- 数 ----------

type Kind = "refusal" | "info";
interface Signal { t: number; kind: Kind }

/** 一份记录里的两种记号并成几次「被停」：返回每一次算在哪个时刻上 */
export function mergeStops(signals: readonly Signal[]): number[] {
  const ev = [...signals].sort((a, b) => a.t - b.t || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  const used = new Array<boolean>(ev.length).fill(false);
  const out: number[] = [];
  for (let i = 0; i < ev.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    for (let j = i + 1; j < ev.length; j++) {
      if (ev[j]!.t - ev[i]!.t > MERGE_MS) break;
      if (!used[j] && ev[j]!.kind !== ev[i]!.kind) { used[j] = true; break; }
    }
    out.push(ev[i]!.t);
  }
  return out;
}

/** 一份会话记录里认出来的（只留窗口里的） */
interface Session {
  /** 请求 → 最先读到的那一行的时刻 */
  requests: Map<string, number>;
  /** 请求 → 那一行记的内核（CLI）版本；没记的不在里面 */
  versions: Map<string, string>;
  /** 被拒停的请求 → 第一次见到 stop_reason=refusal 那一行的时刻 */
  refusedAt: Map<string, number>;
  /** CLI 那句提示：出现的时刻，和那一行的 uuid（没有就是空的） */
  notices: SystemRow[];
  /** model_refusal_no_fallback 的行 */
  refusals: SystemRow[];
}
interface SystemRow { t: number; uuid: string }

/** 只有这两种行要看；别的行（工具结果动辄几兆）不解析 */
const WANTED_ROW = /"type":\s?"(?:assistant|system)"/;
const BLOCKED_MSG = "event loop blocked";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 数数的那一半：喂进来的是行，不碰文件。同一份记录的行按原来的次序喂 */
export class Incidents {
  private readonly sessions = new Map<string, Session>();
  private readonly blocked = new Map<string, { t: number; ms: number }>();
  /** 比这早的行不要（上一次出数时窗口的开头） */
  private floor = -Infinity;
  readonly clock: HourClock;
  readonly windowMs: number;

  constructor(o: { tz: string; windowMs?: number }) {
    this.clock = new HourClock(o.tz);
    this.windowMs = o.windowMs ?? 24 * HOUR_MS;
  }

  /** 一份会话记录新读到的几行 */
  feedTranscript(file: string, lines: Iterable<string>): void {
    let s = this.sessions.get(file);
    for (const line of lines) {
      if (!WANTED_ROW.test(line)) continue;
      let d: Record<string, unknown>;
      try { d = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const t = Date.parse(str(d.timestamp));
      if (!Number.isFinite(t) || t < this.floor) continue;
      if (d.type === "assistant") {
        const m = (d.message ?? {}) as Record<string, unknown>;
        if (m.model === "<synthetic>") continue;
        const rid = str(d.requestId) || str(m.id);
        if (!rid) continue;
        s ??= this.session(file);
        if (!s.requests.has(rid)) {
          s.requests.set(rid, t);
          const v = str(d.version);
          if (v) s.versions.set(rid, v);
        }
        if (m.stop_reason === "refusal" && !s.refusedAt.has(rid)) s.refusedAt.set(rid, t);
      } else if (d.type === "system") {
        if (d.subtype === "model_refusal_no_fallback") (s ??= this.session(file)).refusals.push({ t, uuid: str(d.uuid) });
        else if (d.subtype === "informational" && (typeof d.content === "string" ? d.content : JSON.stringify(d.content ?? "")).includes(STOP_NOTICE)) (s ??= this.session(file)).notices.push({ t, uuid: str(d.uuid) });
      }
    }
  }

  /** HH 日志新读到的几行 */
  feedLog(lines: Iterable<string>): void {
    for (const line of lines) {
      if (!line.includes(BLOCKED_MSG)) continue;
      let r: Record<string, unknown>;
      try { r = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (r.msg !== BLOCKED_MSG || r.replay === true) continue;
      const t = Date.parse(str(r.t)), ms = Number(r.ms);
      if (!Number.isFinite(t) || !Number.isFinite(ms) || ms <= 0 || t < this.floor) continue;
      this.blocked.set(`${t}:${ms}`, { t, ms });   // 日志被重写过、同一行又读到一遍：只算一次
    }
  }

  /** 这份记录没了，或者要从头再读：先把从它那里数的都拿掉 */
  forget(file: string): void { this.sessions.delete(file); }

  /** 窗口里每个小时的数，从早到晚，没动静的小时也在（都是 0）。窗口从 now − windowMs 所在的那个整点起，到 now 所在的小时 */
  hours(now: number): IncidentHour[] {
    const from = this.advance(now);
    const rows = new Map<number, IncidentHour>();
    for (let s = from; s <= now;) {
      rows.set(s, { start: s, ...this.clock.label(s), ...zero() });
      const next = this.clock.startOf(s + HOUR_MS);
      s = next > s ? next : s + HOUR_MS;
    }
    this.tally((t) => rows.get(this.clock.startOf(t)));
    return [...rows.values()];
  }

  /** 一段时间里（from 起、to 以前）的合计。只数得到窗口里的：要先 hours() 或 advance() 过，窗口也得盖住这一段 */
  between(from: number, to: number): IncidentCounts {
    const sum = zero();
    this.tally((t) => (t >= from && t < to ? sum : undefined));
    return sum;
  }

  /** 一段时间里（from 起、to 以前）的请求是哪几个内核（CLI）版本发的：会话记录每行都记着版本。从小到大 */
  versions(from: number, to: number): string[] {
    const seen = new Set<string>(), out = new Set<string>();
    for (const [, s] of [...this.sessions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (const [rid, t] of s.requests) {
        if (seen.has(rid)) continue;
        seen.add(rid);
        const v = s.versions.get(rid);
        if (v && t >= from && t < to) out.add(v);
      }
    }
    return [...out].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  }

  /** 把认出来的每一样记到 at(时刻) 给的那一格里（没给格子的不记） */
  private tally(at: (t: number) => IncidentCounts | undefined): void {
    // 一个请求在几份记录里都有（接着上一个会话开的新会话会把前面的行带过来）：只算在文件名排前面的那一份上，它的被拒停也只在那一份里算
    const seen = new Set<string>();
    // system 行带 uuid 的：同一行只算一次
    const seenRow = new Set<string>();
    const fresh = (r: SystemRow): boolean => { if (!r.uuid) return true; if (seenRow.has(r.uuid)) return false; seenRow.add(r.uuid); return true; };
    for (const [, s] of [...this.sessions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const signals: Signal[] = s.notices.filter(fresh).map((r) => ({ t: r.t, kind: "info" as const }));
      for (const [rid, t] of s.requests) {
        if (seen.has(rid)) continue;
        seen.add(rid);
        const h = at(t);
        if (h) h.requests += 1;
        const refused = s.refusedAt.get(rid);
        if (refused !== undefined) signals.push({ t: refused, kind: "refusal" });
      }
      for (const t of mergeStops(signals)) { const h = at(t); if (h) h.stops += 1; }
      for (const r of s.refusals.filter(fresh)) { const h = at(r.t); if (h) h.refusals += 1; }
    }
    for (const b of this.blocked.values()) {
      const h = at(b.t);
      if (!h) continue;
      h.blocks += 1; h.blockedMs += b.ms; h.longestMs = Math.max(h.longestMs, b.ms);
    }
  }

  private session(file: string): Session {
    let s = this.sessions.get(file);
    if (!s) { s = { requests: new Map(), versions: new Map(), refusedAt: new Map(), notices: [], refusals: [] }; this.sessions.set(file, s); }
    return s;
  }

  /** 窗口挪到 now：比窗口开头早的不留，之后喂进来的也不要。返回窗口的开头。读文件之前先叫一次，旧的行就不会先攒着 */
  advance(now: number): number {
    const from = this.clock.startOf(now - this.windowMs);
    this.floor = from;
    for (const s of this.sessions.values()) {
      for (const [rid, t] of s.requests) if (t < from) { s.requests.delete(rid); s.refusedAt.delete(rid); s.versions.delete(rid); }
      s.notices = s.notices.filter((r) => r.t >= from);
      s.refusals = s.refusals.filter((r) => r.t >= from);
    }
    for (const [k, b] of this.blocked) if (b.t < from) this.blocked.delete(k);
    return from;
  }
}

/** 给人看的一张表（核对口径用）：一小时一行 */
export function renderIncidents(hours: readonly IncidentHour[]): string {
  const sec = (ms: number): string => (ms / 1000).toFixed(1);
  const lines = hours.map((h) => {
    const bad = h.stops + h.refusals;
    return B.incidents.hourRow(h.day.slice(5), String(h.hour).padStart(2, "0"), String(h.requests).padStart(4), String(h.stops).padStart(3), String(h.refusals).padStart(3), String(bad).padStart(3), h.requests ? B.incidents.badPercentSuffix((bad / h.requests * 100).toFixed(1)) : "", h.blocks, sec(h.blockedMs), h.blocks ? B.incidents.longestBlockSuffix(sec(h.longestMs)) : "");
  });
  const sum = (f: (h: IncidentHour) => number): number => hours.reduce((n, h) => n + f(h), 0);
  lines.push(B.incidents.totalRow(sum((h) => h.requests), sum((h) => h.stops), sum((h) => h.refusals), sum((h) => h.blocks), sec(sum((h) => h.blockedMs))));
  return lines.join("\n");
}

// ---------- 读文件：每次只读新加的那一截 ----------

const EMPTY = Buffer.alloc(0);
/** 一行最长留多少字节（等它的换行）；再长的整行丢掉。要看的那两种行没这么长，这么长的是带图的工具结果 */
const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface Tail {
  /** 读到第几个字节了 */
  offset: number;
  /** 最后那半行（还没等到换行） */
  carry: Buffer;
  /** 正在丢一行太长的：到下一个换行为止 */
  skipping: boolean;
}
export const freshTail = (offset = 0): Tail => ({ offset, carry: EMPTY, skipping: false });

/** 从 tail.offset 读到 size，整行整行地交出去；返回读了多少字节。块之间让出事件循环 */
export async function readAppended(path: string, tail: Tail, size: number, chunkBytes: number, onLines: (lines: string[]) => void, maxLineBytes = MAX_LINE_BYTES): Promise<number> {
  const fh = await open(path, "r");
  let read = 0;
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, size - tail.offset)));
    while (tail.offset < size) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - tail.offset), tail.offset);
      if (!bytesRead) break;
      tail.offset += bytesRead; read += bytesRead;
      let data: Buffer = buf.subarray(0, bytesRead);
      if (tail.skipping) {
        const nl = data.indexOf(0x0a);
        if (nl < 0) continue;
        tail.skipping = false;
        data = data.subarray(nl + 1);
      }
      if (tail.carry.length) data = Buffer.concat([tail.carry, data]);
      const end = data.lastIndexOf(0x0a);
      if (end >= 0) onLines(data.toString("utf8", 0, end).split("\n"));
      const rest = data.subarray(end + 1);
      if (rest.length > maxLineBytes) { tail.carry = EMPTY; tail.skipping = true; }
      else tail.carry = Buffer.from(rest);   // 拷一份：buf 下一轮要重用
    }
  } finally {
    await fh.close();
  }
  return read;
}

export interface ScanOptions {
  /** 她工作区那个项目目录（~/.claude/projects/<工作区路径换成 ->）：只看第一层的 *.jsonl */
  dir: string;
  /** HH 日志（<stateDir>/logs/hh.jsonl） */
  logPath: string;
  tz: string;
  windowMs?: number;
  /** 两次读文件至少隔多久；没到就给上一次的数 */
  minIntervalMs?: number;
  chunkBytes?: number;
}

export interface IncidentReport {
  /** 这份数是什么时候算的 */
  at: number;
  tz: string;
  hours: IncidentHour[];
  /** 这次读了多少字节、用了多久（第一次要把窗口里动过的记录从头读一遍，之后只读新加的） */
  readBytes: number;
  tookMs: number;
}

/** 读文件的那一半：记着每个文件读到哪了 */
export class IncidentScanner {
  private readonly core: Incidents;
  private readonly tails = new Map<string, Tail>();
  private logTail = freshTail();
  private running: Promise<IncidentReport> | null = null;
  private last: IncidentReport | null = null;
  private readonly o: ScanOptions;

  constructor(o: ScanOptions) {
    this.o = o;
    this.core = new Incidents({ tz: o.tz, ...(o.windowMs !== undefined ? { windowMs: o.windowMs } : {}) });
  }

  /** 一段时间里的合计（核对口径用）：按最近一次 scan 读到的算，那一段要在窗口里 */
  between(from: number, to: number): IncidentCounts { return this.core.between(from, to); }

  /** 一段时间里的请求是哪几个内核（CLI）版本发的：也按最近一次 scan 读到的算 */
  versions(from: number, to: number): string[] { return this.core.versions(from, to); }

  /** 现在的数。正在读就等那一次；离上一次不到 minIntervalMs 就给上一次的 */
  scan(now: number): Promise<IncidentReport> {
    if (this.running) return this.running;
    if (this.last && now >= this.last.at && now - this.last.at < (this.o.minIntervalMs ?? 5 * 60_000)) return Promise.resolve(this.last);
    this.running = this.run(now).then((r) => { this.last = r; return r; }).finally(() => { this.running = null; });
    return this.running;
  }

  private async run(now: number): Promise<IncidentReport> {
    const began = performance.now();
    const chunk = this.o.chunkBytes ?? 1024 * 1024;
    // 窗口从整点起，多留一个小时
    const from = now - this.core.windowMs - HOUR_MS;
    this.core.advance(now);
    let readBytes = 0;
    let names: string[] = [];
    try { names = (await readdir(this.o.dir)).filter((n) => n.endsWith(".jsonl")).sort(); } catch { /* 目录还没有 */ }
    const live = new Set(names);
    for (const n of [...this.tails.keys()]) if (!live.has(n)) { this.tails.delete(n); this.core.forget(n); }
    for (const n of names) {
      const path = join(this.o.dir, n);
      let st: Stats;
      try { st = await lstat(path); } catch { continue; }
      if (!st.isFile()) continue;   // 目录、符号链接都不读
      let tail = this.tails.get(n);
      if (!tail) {
        // 第一次见到：窗口开始以前就没再动过的，里面不会有窗口里的行，不读
        tail = freshTail(st.mtimeMs < from ? st.size : 0);
        this.tails.set(n, tail);
      }
      if (st.size < tail.offset) { tail = freshTail(); this.tails.set(n, tail); this.core.forget(n); }   // 变短了：当成新文件从头读
      if (st.size === tail.offset) continue;
      try { readBytes += await readAppended(path, tail, st.size, chunk, (lines) => this.core.feedTranscript(n, lines)); } catch { /* 读到一半没了：下次再说 */ }
    }
    try {
      const st = await lstat(this.o.logPath);
      if (st.isFile()) {
        if (st.size < this.logTail.offset) this.logTail = freshTail();   // 日志换了一份：从头读（已经数过的卡顿留着）
        if (st.size > this.logTail.offset) readBytes += await readAppended(this.o.logPath, this.logTail, st.size, chunk, (lines) => this.core.feedLog(lines));
      }
    } catch { /* 还没有日志 */ }
    return { at: now, tz: this.o.tz, hours: this.core.hours(now), readBytes, tookMs: Math.round(performance.now() - began) };
  }
}
