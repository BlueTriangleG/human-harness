// 判断：OpenAI Decisions（gpt-6-luna，只用 predicate 题）。一个话题 + 一批问题 → 每题一个 0–1 的概率。
// 回复路径上有硬超时（一轮的几批共用一个）；只是超时的（机器忙时常见，#0047）换个新的超时再试一次，一次调用只算一次失败；
// 连续失败 3 次熔断 10 分钟（照 OpenAIEmbedder）；
// 花费按 input_tokens 记进 kv `learn.spend.<她的日子>`，到当天上限就不再请求。
// 失败、熔断打开、熔断后恢复都记日志（失败一分钟最多一条），不然熔断和上一次的错误只在内存里，出了事没人看得到。
import type { Logger } from "../log.ts";
import { kvGet, kvSet, type Db } from "../store/db.ts";
import { L } from "../lang/index.ts";
import { sharedWords, wordsOf } from "./words.ts";
import { redactKey } from "../memory/events/embed.ts";

export interface Judge {
  /**
   * 失败、超时、熔断中、当天到上限都返回 null；p 里每个 name 都有（拒答按 0）。
   * background：不在回复路径上的判断（夜里回测）——失败只记 lastError，不算进熔断、不告警；花费照记，上限照管。
   * 超时了换一个新的超时再试一次，再试那次至少 RETRY_MIN_MS（最坏等 timeoutMs + max(timeoutMs, RETRY_MIN_MS)）；once：调用的一方只等这一轮（Brain 开始做事那几处），超时也不再试
   */
  judge(
    input: string,
    qs: Array<{ name: string; text: string }>,
    o?: { timeoutMs?: number; background?: boolean; once?: boolean },
  ): Promise<{ p: Map<string, number>; tokens: number; ms: number } | null>;
  /** 今天花到每日上限的几成（1 = 到上限）；不记账的判断（测试）不给 */
  spentRate?(): number;
}

export const DECISIONS_URL = "https://api.openai.com/v1/decisions";
export const DECISIONS_MODEL = "gpt-6-luna";
const BATCH = 400; // 一次请求最多 400 题，多了分批并发
const BREAK_AFTER = 3;
const BREAK_MS = 10 * 60_000;
const ALERT_OPENS = 3; // 熔断连开 3 次（约 30 分钟一直没通）才告警
export const USD_PER_TOKEN = 0.1 / 1e6; // 输入 $0.10 / 百万 token，输出不收钱
const LOG_EVERY_MS = 60_000; // 失败的日志一分钟最多一条
/**
 * The retry after a timeout waits at least this long instead of copying the first limit (what an association has left after
 * its vector can be tens of milliseconds): measured 11-02, a judge within 30s of the last one takes a median 0.4s, and the
 * retry comes right after a request, so the connection is warm.
 */
const RETRY_MIN_MS = 400;

/** 是这一轮自己的超时到了（AbortSignal.timeout 拒掉 fetch、读正文都是 TimeoutError）；别的错不算 */
const isTimeout = (e: unknown): boolean => e instanceof Error && e.name === "TimeoutError";

// 她的日子（和 memory/events/assoc.ts 里的 localDay 同一个写法）
function localDay(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

export class OpenAIDecisions implements Judge {
  private readonly key: string;
  private readonly db: Db;
  private readonly tz: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly dailyUsd: number;
  private readonly onAlert?: (msg: string) => void;
  private failures = 0;
  private openUntil = 0;
  private opens = 0; // 熔断连着开了几次，成功一次清零
  private alertedDay = "";
  private err = "";
  private readonly log?: Logger;
  private loggedAt = -Infinity;
  /** the judge that answers once this key turns out not to be allowed decisions (HTTP 403 or 404), till hhd starts again */
  private readonly instead?: Judge;
  private denied = false;

  constructor(o: {
    key: string; db: Db; tz: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number;
    dailyUsd: number; onAlert?: (msg: string) => void; log?: Logger; instead?: Judge;
  }) {
    this.key = o.key;
    this.db = o.db;
    this.tz = o.tz;
    // 每次调用时才找 fetch（不在建的时候抓住）：回放装的闸（sleep/replay.ts）才拦得到 hhd 启动时就建好的这个
    this.fetchImpl = o.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 800;
    this.dailyUsd = o.dailyUsd;
    this.onAlert = o.onAlert;
    this.log = o.log;
    this.instead = o.instead;
  }

  get broken(): boolean { return this.now() < this.openUntil; }
  get lastError(): string { return this.err; }

  async judge(
    input: string,
    qs: Array<{ name: string; text: string }>,
    o: { timeoutMs?: number; background?: boolean; once?: boolean } = {},
  ): Promise<{ p: Map<string, number>; tokens: number; ms: number } | null> {
    if (!qs.length) return { p: new Map(), tokens: 0, ms: 0 };
    if (this.denied) return this.instead!.judge(input, qs, o);
    if (this.broken) return null;

    const t0 = this.now();
    const day = localDay(t0, this.tz);
    if (this.spentTokens(day) * USD_PER_TOKEN >= this.dailyUsd) {
      this.err = L.decisions.dailyCapReached;
      if (this.alertedDay !== day) {
        this.alertedDay = day;
        this.alert(L.decisions.dailyCapAlert(+(this.spentTokens(day) * USD_PER_TOKEN).toFixed(4), this.dailyUsd));
      }
      return null;
    }

    const ms = o.timeoutMs ?? this.timeoutMs;
    let todo: Array<typeof qs> = [];
    for (let i = 0; i < qs.length; i += BATCH) todo.push(qs.slice(i, i + BATCH));
    const done: Array<{ p: Map<string, number>; tokens: number }> = [];
    let tokens = 0;
    for (let attempt = 0; ; attempt++) {
      // 一轮里所有批共用一个超时：一起发、一起等
      const signal = AbortSignal.timeout(attempt ? Math.max(ms, RETRY_MIN_MS) : ms);
      const results = await Promise.allSettled(todo.map((b) => this.ask(input, b, signal)));

      // 成功的批已经收了钱，哪怕别的批失败也照记（await 之后重读，别盖掉同时进来的别的调用）
      const got = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const n = got.reduce((s, r) => s + r.tokens, 0);
      if (n) kvSet(this.db, `learn.spend.${day}`, String(this.spentTokens(day) + n));
      tokens += n;
      done.push(...got);

      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [{ batch: todo[i]!, reason: r.reason as unknown }] : []));
      if (!failed.length) break;
      // 全是超时（#0047：机器忙的时候一天几次）：没回来的那几批换一个新的超时再发一次，只再试这一次。
      // once、有别的错、这期间熔断开了、到了当天上限都不再试；再试也不行才记失败，一次调用只算一次
      if (attempt === 0 && !o.once && failed.every((x) => isTimeout(x.reason)) && !this.broken
        && this.spentTokens(day) * USD_PER_TOKEN < this.dailyUsd) {
        this.log?.info("learning: judge timed out, retrying once", { ms, batches: failed.length, ...(o.background ? { background: true } : {}) });
        todo = failed.map((x) => x.batch);
        continue;
      }
      // A key that may not use decisions (403, 404) will not come to: from here on the words judge answers; said once
      if (this.instead && failed.some((x) => x.reason instanceof Error && /^HTTP 40[34]\b/.test(x.reason.message))) {
        this.denied = true;
        this.log?.warn("learning: this OpenAI key may not use decisions; judging by words from now on", {});
        return this.instead.judge(input, qs, o);
      }
      // 后台的判断不碰熔断的计数（失败不凑数，成功也不清零）：熔断只看回复路径自己
      if (o.background) this.noteError(failed[0]!.reason, true);
      else this.fail(failed[0]!.reason);
      return null;
    }
    if (!o.background) {
      if (this.opens > 0) this.log?.info("learning: judge recovered", { opens: this.opens });
      this.failures = 0;
      this.opens = 0;
    }
    const p = new Map<string, number>();
    for (const r of done) for (const [name, v] of r.p) p.set(name, v);
    return { p, tokens, ms: this.now() - t0 };
  }

  private async ask(
    input: string,
    qs: Array<{ name: string; text: string }>,
    signal: AbortSignal,
  ): Promise<{ p: Map<string, number>; tokens: number }> {
    const r = await this.fetchImpl(DECISIONS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: DECISIONS_MODEL,
        input,
        questions: qs.map((q) => ({ type: "predicate", name: q.name, instructions: q.text })),
      }),
      signal,
    });
    // 正文只在这里按 4000 字封顶（防内存）；截到 200 字放在抹 key 之后（fail），否则跨过截断点的 key 抹不干净
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 4000)}`);
    const j = (await r.json()) as {
      answers?: Array<{ name?: string; type?: string; probability?: number }>;
      usage?: { input_tokens?: number };
    };
    // 记账靠 usage：没有就当失败，别让预算悄悄失灵
    const tokens = j.usage?.input_tokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) throw new Error("decisions: response has no usage.input_tokens");
    if (!Array.isArray(j.answers)) throw new Error("decisions: response has no answers");
    const got = new Map<string, number>();
    for (const a of j.answers) {
      if (typeof a.name !== "string") continue;
      if (a.type === "refusal") got.set(a.name, 0);
      else if (typeof a.probability === "number") got.set(a.name, a.probability);
    }
    for (const q of qs) if (!got.has(q.name)) throw new Error(`decisions: no answer for ${q.name}`);
    return { p: got, tokens };
  }

  private spentTokens(day: string): number {
    return Number(kvGet(this.db, `learn.spend.${day}`)) || 0;
  }

  /** 今天（她的日子）花到上限的几成：0 起，到上限是 1（上限 0 当作没上限，给 0） */
  spentRate(): number {
    return this.dailyUsd > 0 ? (this.spentTokens(localDay(this.now(), this.tz)) * USD_PER_TOKEN) / this.dailyUsd : 0;
  }

  private noteError(e: unknown, background = false): void {
    // key 只在请求头里，但服务端的错误正文可能回显它：先整段抹掉，最后才截到 200 字
    this.err = redactKey(String(e), this.key).slice(0, 200);
    if (this.now() - this.loggedAt < LOG_EVERY_MS) return;
    this.loggedAt = this.now();
    this.log?.warn("learning: judge failed", { error: this.err, ...(background ? { background: true } : {}) });
  }

  private fail(e: unknown): void {
    this.noteError(e);
    this.failures += 1;
    if (this.failures < BREAK_AFTER) return;
    this.openUntil = this.now() + BREAK_MS;
    this.failures = 0;
    this.opens += 1;
    this.log?.warn("learning: judge breaker open", { until: new Date(this.openUntil).toISOString(), opens: this.opens, error: this.err });
    if (this.opens === ALERT_OPENS) {
      this.alert(L.decisions.breakerAlert(ALERT_OPENS, this.err));
    }
  }

  private alert(msg: string): void {
    try { this.onAlert?.(msg); } catch { /* 告警出错不能拖垮判断 */ }
  }
}

/**
 * The judge when there is no OpenAI key: a question's chance is how many words it shares with what is being done,
 * leaving out the words of the questions' and the input's own wording. Three or more shared words pass the line
 * (assoc.threshold, 0.9 as tuned), two are a maybe, one is not enough. Nothing is spent, nothing fails.
 */
export class KeywordDecisions implements Judge {
  async judge(input: string, qs: Array<{ name: string; text: string }>): Promise<{ p: Map<string, number>; tokens: number; ms: number }> {
    const wording = wordsOf(`${L.associate.judgeInput("")}\n${L.associate.pageQuestion("")}`);
    const w = new Set([...wordsOf(input)].filter((x) => !wording.has(x)));
    const chance = (n: number): number => (n >= 3 ? 0.95 : n === 2 ? 0.6 : n === 1 ? 0.3 : 0);
    return { p: new Map(qs.map((q) => [q.name, chance(sharedWords(w, wordsOf(q.text)))])), tokens: 0, ms: 0 };
  }
}
