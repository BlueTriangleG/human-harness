// 向量：OpenAI text-embedding-3-small（512 维，省内存）。回复路径上硬超时 800ms；连续失败 3 次熔断 10 分钟，
// 熔断期间直接返回 null（调用方只用全文检索），不让她等。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Embedder {
  /** 失败、超时、熔断中都返回 null */
  embed(texts: string[], o?: { timeoutMs?: number }): Promise<Float32Array[] | null>;
  /** 最后一次出错、熔断到什么时候（给控制台看） */
  status?(): EmbedStatus;
}

export interface EmbedStatus { lastError: string; lastErrorAt: number | null; lastOkAt: number | null; pausedUntil: number | null }

export const EMBED_DIMS = 512;
export const EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBED_MODEL = "text-embedding-3-small";
const BREAK_AFTER = 3;
const BREAK_MS = 10 * 60_000;
/** 一直断着时，熔断的那笔日志一小时最多记一次 */
const PAUSE_LOG_EVERY = 60 * 60_000;

export class OpenAIEmbedder implements Embedder {
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly log: { warn(msg: string, data?: Record<string, unknown>): void; info(msg: string, data?: Record<string, unknown>): void } | undefined;
  private failures = 0;
  private openUntil = 0;
  /** 这一段失败已经记过日志（成功一次才清掉）：一直断着不刷屏 */
  private down = false;
  private pauseLoggedAt = Number.NEGATIVE_INFINITY;

  constructor(o: { key: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number; log?: OpenAIEmbedder["log"] }) {
    this.key = o.key;
    // 每次调用时才找 fetch（不在建的时候抓住）：回放装的闸（sleep/replay.ts）才拦得到 hhd 启动时就建好的这个
    this.fetchImpl = o.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 800;
    this.log = o.log;
  }

  get broken(): boolean { return this.now() < this.openUntil; }

  async embed(texts: string[], o: { timeoutMs?: number } = {}): Promise<Float32Array[] | null> {
    if (!texts.length) return [];
    if (this.broken) return null;
    const out: Float32Array[] = [];
    try {
      for (let i = 0; i < texts.length; i += 100) {
        const chunk = texts.slice(i, i + 100).map((t) => t.slice(0, 6000) || " ");
        const r = await this.fetchImpl(EMBEDDINGS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
          body: JSON.stringify({ model: EMBED_MODEL, input: chunk, dimensions: EMBED_DIMS }),
          signal: AbortSignal.timeout(o.timeoutMs ?? this.timeoutMs),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
        const j = (await r.json()) as { data: Array<{ embedding: number[]; index: number }> };
        for (const d of [...j.data].sort((a, b) => a.index - b.index)) out.push(unit(Float32Array.from(d.embedding)));
      }
      this.failures = 0;
      this.lastOkAt = this.now();
      if (this.down) { this.down = false; this.log?.info("embedding back", {}); }
      return out;
    } catch (e) {
      this.failures += 1;
      this.lastError = redactKey(String(e), this.key).slice(0, 200);
      this.lastErrorAt = this.now();
      // 回复路径上偶尔一次超时不记（连着三次熔断了才记）；别的错（没额度、key 失效）一段只记第一次
      const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (!this.down && !timeout) { this.down = true; this.log?.warn("embedding failed (search falls back to keywords)", { error: this.lastError }); }
      if (this.failures >= BREAK_AFTER) {
        this.openUntil = this.now() + BREAK_MS;
        this.failures = 0;
        this.down = true;
        if (this.now() - this.pauseLoggedAt >= PAUSE_LOG_EVERY) {
          this.pauseLoggedAt = this.now();
          this.log?.warn("embedding paused 10 min after 3 failures in a row", { error: this.lastError });
        }
      }
      return null;
    }
  }

  lastError = "";
  lastErrorAt: number | null = null;
  lastOkAt: number | null = null;

  status(): EmbedStatus {
    return { lastError: this.lastError, lastErrorAt: this.lastErrorAt, lastOkAt: this.lastOkAt, pausedUntil: this.broken ? this.openUntil : null };
  }
}

export function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

/**
 * An error text with no piece of a key left in it: the key itself, and what OpenAI's error bodies echo of one (sk-…, masked
 * but for its last characters). Before any cut to length, so a key across the cut cannot survive in part.
 */
export const redactKey = (text: string, key?: string | null): string =>
  (key ? text.split(key).join("***") : text).replace(/sk-[A-Za-z0-9_*-]{4,}/g, "sk-***");

/** ~/.hh/secrets.json 里的 openaiKey（0600）；没有就 null */
export function loadOpenAIKey(stateDir: string): string | null {
  try {
    const j = JSON.parse(readFileSync(join(stateDir, "secrets.json"), "utf8")) as { openaiKey?: string };
    return j.openaiKey?.trim() || null;
  } catch {
    return null;
  }
}
