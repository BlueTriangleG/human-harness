// 检索：全文（FTS5 trigram，两个字的词补 LIKE）+ 向量（内存里的 int8 矩阵算余弦），RRF 融合。
// 原话层 mem_quote：HH 中央记忆里的原话（增量抄过来）、Honcho 导出的旧原话、笔记，一起建索引。
// 编号：事件 e…、条目 n…、原话 q<id>。
import { createHash } from "node:crypto";
import type { Db } from "../../store/db.ts";
import { all, one, kvGet, kvSet } from "../../store/db.ts";
import type { Embedder } from "./embed.ts";
import { EMBED_DIMS } from "./embed.ts";
import { sentBody } from "../central.ts";
import { B, fromEveryPack } from "../../lang/index.ts";

export interface QuoteIn { src: "central" | "honcho" | "note"; ref: string; at: number; who: string; channel: string; text: string }
export interface Hit { ref: string; score: number; fts: boolean; cos?: number; /** 线索里的某个完整词出现在它的文字里（实体名、标题） */ exact?: boolean }
export type RefKind = "event" | "entry" | "quote";

const RRF_K = 60;
const QUOTE_SEQ = "memQuoteSeq";
/** 她不回话时写的 NO_REPLY 不是原话（跟 brain.ts 拆气泡时一样认） */
const NO_REPLY = /^\s*NO_REPLY\W*$/;

export function refKind(ref: string): RefKind {
  return ref.startsWith("e") ? "event" : ref.startsWith("n") ? "entry" : "quote";
}

/** Two characters of a script written without spaces between words (Chinese, Japanese, Korean) */
const CJK_PAIR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]{2}$/u;
/** At most this many two-character pieces per cue; they are tried only when the rest found fewer than PAIRS_BELOW rows */
const PAIRS_MAX = 16;
const PAIRS_BELOW = 3;
/** A piece in more rows than this (events and entries, or quotes, counted apart) is too common to say anything */
const PAIRS_COMMON = 40;

/**
 * 线索 → 检索词：按标点和空格切；长的中文串切成三字一组（trigram），两个字的单独走 LIKE。
 * pairs: the two-character pieces of a long CJK run, for when its three-character pieces find too little (see fts).
 */
export function terms(q: string): { tri: string[]; short: string[]; words: string[]; pairs: string[] } {
  const words = q.split(/[\s，。！？、；：,.!?;:「」『』“”"'（）()【】\[\]<>《》~～…\-—|/]+/u).map((w) => w.trim()).filter(Boolean);
  const tri = new Set<string>();
  const short = new Set<string>();
  const pairs = new Set<string>();
  for (const w of words) {
    const chars = [...w];
    if (chars.length <= 2) { if (chars.length === 2 || /[^\x00-\x7f]/.test(w)) short.add(w); continue; }
    if (chars.length <= 4 || /^[\x00-\x7f]+$/.test(w)) {
      tri.add(w);
      // 三四个字的中文串里可能藏着两个字的词（「阿青做饭」）：两两补进 LIKE
      if (chars.length >= 3 && /[^\x00-\x7f]/.test(w)) for (let i = 0; i + 2 <= chars.length; i++) short.add(chars.slice(i, i + 2).join(""));
      continue;
    }
    for (let i = 0; i + 3 <= chars.length; i++) tri.add(chars.slice(i, i + 3).join(""));
    for (let i = 0; i + 2 <= chars.length; i++) { const p = chars.slice(i, i + 2).join(""); if (CJK_PAIR.test(p)) pairs.add(p); }
  }
  const shortList = [...short].slice(0, 10);
  for (const s of shortList) pairs.delete(s);
  return { tri: [...tri].slice(0, 60), short: shortList, words, pairs: [...pairs].slice(0, PAIRS_MAX) };
}

export class MemIndex {
  private readonly db: Db;
  readonly embedder: Embedder | null;
  private readonly now: () => number;
  private refs: string[] = [];
  private pos = new Map<string, number>();
  private mat = new Int8Array(0);
  private scale = new Float32Array(0);
  private loaded = false;
  /** 读进内存的 mem_vec 最大 rowid：别处（命令行脚本、另一个进程）新写的向量按它补读 */
  private seenRowid = 0;
  /** 内容变了、旧向量已经丢掉、还没读回新向量的 */
  private readonly forgotten = new Set<string>();
  private readonly cueCache = new Map<string, Float32Array>();
  /** 正在算的线索向量，按内容 hash；算完（成功失败都）就撤掉 */
  private readonly cueInflight = new Map<string, Promise<Float32Array | null>>();

  constructor(db: Db, embedder: Embedder | null, now: () => number = Date.now) {
    this.db = db;
    this.embedder = embedder;
    this.now = now;
  }

  // ---------- 原话层 ----------
  addQuotes(rows: QuoteIn[]): number {
    let n = 0;
    const ins = this.db.prepare("INSERT OR IGNORE INTO mem_quote (src, ref, at, who, channel, text) VALUES (?, ?, ?, ?, ?, ?)");
    const fts = this.db.prepare("INSERT INTO mem_fts (ref, text) VALUES (?, ?)");
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (!r.text.trim() || NO_REPLY.test(r.text)) continue;
        const res = ins.run(r.src, r.ref, r.at, r.who, r.channel, r.text);
        if (res.changes) { fts.run(`q${res.lastInsertRowid}`, `${r.who}：${r.text}`); n += 1; }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  /** 10-31 以前存进来的 NO_REPLY 删掉：原话、全文索引、向量一起，内存里的向量也不再用 */
  purgeNoReply(): number {
    const ids = all<{ id: number; text: string }>(this.db, "SELECT id, text FROM mem_quote WHERE text LIKE '%NO_REPLY%'")
      .filter((r) => NO_REPLY.test(r.text)).map((r) => r.id);
    this.db.exec("BEGIN");
    try {
      for (let i = 0; i < ids.length; i += 500) {
        const part = ids.slice(i, i + 500);
        const marks = part.map(() => "?").join(",");
        const refs = part.map((id) => `q${id}`);
        this.db.prepare(`DELETE FROM mem_quote WHERE id IN (${marks})`).run(...part);
        this.db.prepare(`DELETE FROM mem_fts WHERE ref IN (${marks})`).run(...refs);
        this.db.prepare(`DELETE FROM mem_vec WHERE ref IN (${marks})`).run(...refs);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    for (const id of ids) { this.forget(`q${id}`); this.forgotten.delete(`q${id}`); }   // 没了，不用等补算
    return ids.length;
  }

  /** 中央记忆里新增的原话抄进原话层：别人说的、我说的、我记的、我发出去的；下意识的内部记录不抄 */
  ingestCentral(): number {
    const from = Number(kvGet(this.db, QUOTE_SEQ) ?? "0");
    const rows = all<{ seq: number; ts: number; src: string; kind: string; text: string; meta: string | null }>(this.db,
      "SELECT seq, ts, src, kind, text, meta FROM central WHERE seq > ? AND kind IN ('input','say','note') ORDER BY seq LIMIT 2000", from);
    if (!rows.length) return 0;
    const qs: QuoteIn[] = [];
    for (const r of rows) {
      const m = r.meta ? (JSON.parse(r.meta) as { from?: string; inner?: boolean; sent?: boolean; unsent?: boolean; wordHint?: boolean; name?: string; to?: string; channel?: string }) : {};
      if (m.unsent) continue;   // 「上面这段没发给任何人」是 HH 记的标记，不是原话（那段话本身照抄）
      if (m.wordHint) continue;   // 「刚才发给…的话里用了…」也是 HH 替她记的提醒，不是她说的话
      // 只存档的（inner）不抄（下意识自己的过程）。感官原文例外：它也只存档、不同步给主意识，但夜里整理要靠原话层翻到它
      const sense = r.kind === "input" && r.src === "外界";
      if (m.inner && !sense) continue;
      const who = r.kind === "input" ? (m.inner ? "感官" : (m.from ?? "外界")) : m.sent ? `${B.common.self}→${m.name ?? m.to ?? "对方"}` : B.common.self;
      const text = m.sent ? sentBody(r.text) : r.text;
      qs.push({ src: "central", ref: String(r.seq), at: r.ts, who, channel: m.channel ?? "", text: text.slice(0, 4000) });
    }
    const n = this.addQuotes(qs);
    kvSet(this.db, QUOTE_SEQ, String(rows[rows.length - 1]!.seq));
    return n;
  }

  quote(ref: string): { id: number; src: string; ref: string; at: number; who: string; channel: string; text: string } | undefined {
    return one(this.db, "SELECT * FROM mem_quote WHERE id = ?", Number(ref.replace(/^q/, "")));
  }

  /** 她在 at 之后 withinMs 内发给 who 的话（原话层记成「我→who」，me→who in English: any pack's word for itself），按时间，最多 n 句 */
  repliesTo(who: string, at: number, withinMs: number, n = 3): Array<{ id: number; at: number; text: string }> {
    const as = fromEveryPack((p) => `${p.brain.common.self}→${who}`);
    return all(this.db, `SELECT id, at, text FROM mem_quote WHERE who IN (${as.map(() => "?").join(", ")}) AND at > ? AND at <= ? ORDER BY at LIMIT ?`, ...as, at, at + withinMs, n);
  }

  // ---------- 全文 ----------
  fts(q: string, limit = 30, o: { noQuotes?: boolean } = {}): Array<{ ref: string; rank: number; exact: boolean }> {
    const t = terms(q);
    const score = new Map<string, number>();
    if (t.tri.length) {
      const match = t.tri.map((w) => `"${w.replace(/"/g, '""')}"`).join(" OR ");
      try {
        // 只找事件和条目时连全文也不让原话占名额（原话是它们的十倍）
        const rows = all<{ ref: string; s: number }>(this.db, `SELECT ref, bm25(mem_fts) s FROM mem_fts WHERE mem_fts MATCH ?${o.noQuotes ? " AND ref NOT LIKE 'q%'" : ""} ORDER BY s LIMIT ?`, match, limit * 4);
        for (const r of rows) score.set(r.ref, (score.get(r.ref) ?? 0) - r.s);
      } catch { /* 奇怪的字符：只靠 LIKE */ }
    }
    // 两个字的词：事件、条目和原话分开找，各自新的在前（不然会被一大堆旧原话挤掉）
    for (const w of t.short) {
      for (const sql of ["SELECT ref FROM mem_fts WHERE text LIKE ? AND ref NOT LIKE 'q%' ORDER BY rowid DESC LIMIT ?", ...(o.noQuotes ? [] : ["SELECT ref FROM mem_fts WHERE text LIKE ? AND ref LIKE 'q%' ORDER BY rowid DESC LIMIT ?"])]) {
        for (const r of all<{ ref: string }>(this.db, sql, `%${w}%`, limit * 2)) score.set(r.ref, (score.get(r.ref) ?? 0) + 1);
      }
    }
    // A long CJK run is one word to the splitter, so a question asked in one breath ("日语现在学到哪一步了") can miss
    // with every three-character piece while a two-character word in it is there. When the rest found too little, the
    // run's two-character pieces are tried too: each counts for less the more rows it is in, and one in too many rows
    // ("现在") counts for nothing.
    if (score.size < PAIRS_BELOW) {
      for (const w of t.pairs) {
        for (const sql of ["SELECT ref FROM mem_fts WHERE text LIKE ? AND ref NOT LIKE 'q%' ORDER BY rowid DESC LIMIT ?", ...(o.noQuotes ? [] : ["SELECT ref FROM mem_fts WHERE text LIKE ? AND ref LIKE 'q%' ORDER BY rowid DESC LIMIT ?"])]) {
          const rows = all<{ ref: string }>(this.db, sql, `%${w}%`, PAIRS_COMMON + 1);
          if (!rows.length || rows.length > PAIRS_COMMON) continue;
          const weight = 1 / Math.log2(1 + rows.length);
          for (const r of rows) score.set(r.ref, (score.get(r.ref) ?? 0) + weight);
        }
      }
    }
    if (!score.size) return [];
    const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    // 线索里有完整词（≥2 字）出现在文字里 = 强命中（实体名、标题）
    const words = t.words.filter((w) => [...w].length >= 2);
    const texts = new Map(all<{ ref: string; text: string }>(this.db, `SELECT ref, text FROM mem_fts WHERE ref IN (${ranked.map(() => "?").join(",")})`, ...ranked.map(([r]) => r)).map((r) => [r.ref, r.text]));
    // 也算强命中：它的标题（第一行，≥3 字）整个出现在线索里（线索是一句话、没有空格时）
    const strong = (ref: string) => {
      const text = texts.get(ref) ?? "";
      const title = text.split("\n")[0] ?? "";
      // 事件标题本来就是专名，两个字（「做脸」）也算；条目标题要三个字以上
      return words.some((w) => text.includes(w)) || ([...title].length >= (ref.startsWith("e") ? 2 : 3) && q.includes(title));
    };
    return ranked.map(([ref], i) => ({ ref, rank: i, exact: strong(ref) }));
  }

  // ---------- 向量 ----------
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    const rows = all<{ rowid: number; ref: string; vec: Uint8Array }>(this.db, "SELECT rowid, ref, vec FROM mem_vec");
    this.grow(rows.length + 1024);
    for (const r of rows) {
      this.put(r.ref, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
      this.seenRowid = Math.max(this.seenRowid, r.rowid);
    }
  }

  /**
   * 别处新写的向量读进来：rowid 比读过的大的（新插的行）；加上这边丢掉了、别处已经重算好的
   * （SQLite 删掉最大 rowid 后会复用它，光看 rowid 会漏）。
   */
  private sync(): void {
    if (!this.loaded) return;
    const read = (r: { rowid: number; ref: string; vec: Uint8Array }) => {
      this.put(r.ref, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4));
      this.seenRowid = Math.max(this.seenRowid, r.rowid);
    };
    for (const r of all<{ rowid: number; ref: string; vec: Uint8Array }>(this.db, "SELECT rowid, ref, vec FROM mem_vec WHERE rowid > ? ORDER BY rowid", this.seenRowid)) read(r);
    const lost = [...this.forgotten];
    for (let i = 0; i < lost.length; i += 500) {
      const part = lost.slice(i, i + 500);
      for (const r of all<{ rowid: number; ref: string; vec: Uint8Array }>(this.db, `SELECT rowid, ref, vec FROM mem_vec WHERE ref IN (${part.map(() => "?").join(",")})`, ...part)) read(r);
    }
  }

  /** 这条的内容变了（或没了）：内存里的旧向量先不用，等补算 */
  forget(ref: string): void {
    const i = this.pos.get(ref);
    if (i === undefined) return;
    this.scale[i] = 0;
    this.forgotten.add(ref);
  }

  private grow(n: number): void {
    if (this.scale.length >= n) return;
    const mat = new Int8Array(n * EMBED_DIMS);
    mat.set(this.mat);
    const scale = new Float32Array(n);
    scale.set(this.scale);
    this.mat = mat;
    this.scale = scale;
  }

  private put(ref: string, v: Float32Array): void {
    this.forgotten.delete(ref);
    let i = this.pos.get(ref);
    if (i === undefined) {
      i = this.refs.length;
      this.refs.push(ref);
      this.pos.set(ref, i);
      if (i >= this.scale.length) this.grow(Math.max(1024, this.scale.length * 2));
    }
    let max = 0;
    for (let d = 0; d < EMBED_DIMS; d++) max = Math.max(max, Math.abs(v[d] ?? 0));
    const s = max / 127 || 1;
    this.scale[i] = s;
    const off = i * EMBED_DIMS;
    for (let d = 0; d < EMBED_DIMS; d++) this.mat[off + d] = Math.round((v[d] ?? 0) / s);
  }

  /** 线索的向量（按内容缓存；同一句话正在算时共用同一个 Promise）；向量服务不可用就 null */
  async cueVector(q: string, timeoutMs?: number): Promise<Float32Array | null> {
    const h = hash(q);
    const hit = this.cueCache.get(h);
    if (hit) return hit;
    const pending = this.cueInflight.get(h);
    if (pending) return pending;
    const p = this.embedCue(h, q, timeoutMs).finally(() => this.cueInflight.delete(h));
    this.cueInflight.set(h, p);
    return p;
  }

  private async embedCue(h: string, q: string, timeoutMs?: number): Promise<Float32Array | null> {
    const r = await this.embedder?.embed([q], timeoutMs ? { timeoutMs } : {});
    const v = r?.[0] ?? null;
    if (v) {
      if (this.cueCache.size > 500) this.cueCache.delete(this.cueCache.keys().next().value!);
      this.cueCache.set(h, v);
    }
    return v;
  }

  /** 这一条有没有算好的向量（刚写的、改过的要等补算） */
  hasVector(ref: string): boolean {
    this.load();
    const i = this.pos.get(ref);
    return i !== undefined && Boolean(this.scale[i]);
  }

  async vector(q: string, limit = 30, o: { timeoutMs?: number; kinds?: RefKind[] } = {}): Promise<Array<{ ref: string; cos: number }> | null> {
    if (!this.embedder) return null;
    const v = await this.cueVector(q, o.timeoutMs);
    if (!v) return null;
    this.load();
    const best: Array<{ ref: string; cos: number }> = [];
    let floor = -Infinity;
    for (let i = 0; i < this.refs.length; i++) {
      const ref = this.refs[i]!;
      if (o.kinds && !o.kinds.includes(refKind(ref))) continue;
      const scale = this.scale[i]!;
      if (!scale) continue;   // 内容变了、还没重算
      const off = i * EMBED_DIMS;
      let dot = 0;
      for (let d = 0; d < EMBED_DIMS; d++) dot += this.mat[off + d]! * v[d]!;
      const cos = dot * scale;
      if (best.length < limit || cos > floor) {
        best.push({ ref, cos });
        if (best.length > limit) { best.sort((a, b) => b.cos - a.cos); best.length = limit; floor = best[limit - 1]!.cos; }
      }
    }
    return best.sort((a, b) => b.cos - a.cos);
  }

  /** 缺向量的（新写的、改过的）补算一批；返回补了几条 */
  async backfillVectors(max = 200, o: { timeoutMs?: number } = {}): Promise<number> {
    if (!this.embedder) return 0;
    this.sync();
    const rows = all<{ ref: string; text: string }>(this.db, "SELECT ref, text FROM mem_fts WHERE ref NOT IN (SELECT ref FROM mem_vec) LIMIT ?", max);
    if (!rows.length) return 0;
    const vecs = await this.embedder.embed(rows.map((r) => r.text.slice(0, 4000)), { timeoutMs: o.timeoutMs ?? 60_000 });
    if (!vecs) return 0;
    this.load();
    const ins = this.db.prepare("INSERT OR REPLACE INTO mem_vec (ref, hash, vec) VALUES (?, ?, ?)");
    // 等向量的时候这条又改了（或没了）：不写旧内容的向量，下一轮按新内容重算（一次查完：mem_fts 的 ref 没有索引）
    const cur = new Map(all<{ ref: string; text: string }>(this.db, `SELECT ref, text FROM mem_fts WHERE ref IN (${rows.map(() => "?").join(",")})`, ...rows.map((r) => r.ref)).map((r) => [r.ref, r.text]));
    this.db.exec("BEGIN");
    try {
      rows.forEach((r, i) => {
        if (cur.get(r.ref) !== r.text) return;
        const v = vecs[i]!;
        ins.run(r.ref, hash(r.text), new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
        this.put(r.ref, v);
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.sync();   // 别处同时写的也读进内存
    return rows.length;
  }

  /** 还缺多少向量 */
  missingVectors(): number {
    return one<{ n: number }>(this.db, "SELECT count(*) n FROM mem_fts WHERE ref NOT IN (SELECT ref FROM mem_vec)")?.n ?? 0;
  }

  // ---------- 混合 ----------
  async search(q: string, o: { limit?: number; kinds?: RefKind[]; timeoutMs?: number } = {}): Promise<Hit[]> {
    const limit = o.limit ?? 20;
    const [ft, vec] = await Promise.all([
      Promise.resolve(this.fts(q, limit * 2, { noQuotes: Boolean(o.kinds && !o.kinds.includes("quote")) })),
      this.vector(q, limit * 2, { ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.kinds ? { kinds: o.kinds } : {}) }),
    ]);
    const hits = new Map<string, Hit>();
    for (const f of ft) {
      if (o.kinds && !o.kinds.includes(refKind(f.ref))) continue;
      hits.set(f.ref, { ref: f.ref, score: 1 / (RRF_K + f.rank), fts: true, exact: f.exact });
    }
    (vec ?? []).forEach((v, i) => {
      const h = hits.get(v.ref) ?? { ref: v.ref, score: 0, fts: false };
      h.score += 1 / (RRF_K + i);
      h.cos = v.cos;
      hits.set(v.ref, h);
    });
    return [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  }
}

function hash(s: string): string { return createHash("sha1").update(s).digest("hex"); }
