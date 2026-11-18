// 页的封面向量和粗筛：每页的封面（coverText）算一个向量存在 learn_cover，封面没变就不重算；
// 联想时拿话题的向量按余弦先筛一批候选，再交给 Decisions 逐页判断。
import { createHash } from "node:crypto";
import type { Db } from "../store/db.ts";
import { all } from "../store/db.ts";
import type { Embedder } from "../memory/events/embed.ts";
import { EMBED_DIMS } from "../memory/events/embed.ts";
import { coverText, pageItems, type ItemRole } from "./notebook.ts";
import type { Item, Page, Shelf } from "./notebook.ts";
import { sharedWords, wordsOf } from "./words.ts";

/** 前 k 加通用类补进的总数超过这个，通用类就只补余弦最高的 EXTRA_WHEN_OVER 页 */
const MAX_CANDIDATES = 60;
const EXTRA_WHEN_OVER = 10;
/** 批量重算封面的超时；默认 60 秒（整本书架一次算，不能用回复路径的 800 毫秒：超时会算进向量服务共用的熔断，连累回复路径） */
const REFRESH_TIMEOUT_MS = 60_000;

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

export class CoverIndex {
  private readonly db: Db;
  private readonly embedder: Embedder | null;

  constructor(db: Db, embedder: Embedder | null) {
    this.db = db;
    this.embedder = embedder;
  }

  /**
   * 封面 hash 变了或还没存的页，一批算向量写进 learn_cover；归档的不算，没有编号的存不进去（跳过）。
   * 向量服务不可用就留着旧的，返回 0。超时默认 60 秒，同 backfillVectors。书架上已经没有的页，行留着不删（不碍事；页回来 hash 没变就不用重算）。
   */
  async refresh(shelf: Shelf, o: { timeoutMs?: number } = {}): Promise<{ embedded: number }> {
    if (!this.embedder) return { embedded: 0 };
    const have = new Map(all<{ page_id: string; hash: string }>(this.db, "SELECT page_id, hash FROM learn_cover").map((r) => [r.page_id, r.hash]));
    const todo: Array<{ id: string; hash: string; text: string }> = [];
    for (const p of shelf.pages) {
      const id = p.ids[0];
      if (p.archived || !id) continue;
      const text = coverText(p);
      const hash = sha1(text);
      if (have.get(id) !== hash) todo.push({ id, hash, text });
    }
    if (!todo.length) return { embedded: 0 };
    const vecs = await this.embedder.embed(todo.map((t) => t.text), { timeoutMs: o.timeoutMs ?? REFRESH_TIMEOUT_MS });
    if (!vecs || vecs.length !== todo.length) return { embedded: 0 };
    const ins = this.db.prepare("INSERT OR REPLACE INTO learn_cover (page_id, hash, vec) VALUES (?, ?, ?)");
    this.db.exec("BEGIN");
    try {
      todo.forEach((t, i) => {
        const v = vecs[i]!;
        ins.run(t.id, t.hash, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { embedded: todo.length };
  }

  /**
   * 粗筛候选：没归档、存了向量的页里按余弦取前 k；再把没进前 k 的通用类补进来，
   * 前 k 加这些总数超过 60 时通用类只补余弦最高的 10 页。返回前 k（按分）在前，通用类补的（按分）在后。
   * 向量每次从库里读（书架不大）。
   */
  shortlist(v: Float32Array, shelf: Shelf, k: number, generalCategory: string, extraMax?: number): Page[] {
    const vecs = new Map<string, Float32Array>();
    for (const r of all<{ page_id: string; vec: Uint8Array }>(this.db, "SELECT page_id, vec FROM learn_cover")) {
      // 从库里读出来的字节不保证 4 字节对齐，拷一份再当 Float32 用；长度不对的（换过维数的旧行）不用
      if (r.vec.byteLength === EMBED_DIMS * 4) vecs.set(r.page_id, new Float32Array(r.vec.buffer.slice(r.vec.byteOffset, r.vec.byteOffset + r.vec.byteLength)));
    }
    const scored: Array<{ page: Page; cos: number }> = [];
    for (const page of shelf.pages) {
      const vec = page.ids[0] ? vecs.get(page.ids[0]) : undefined;
      if (page.archived || !vec) continue;
      let cos = 0;
      for (let d = 0; d < EMBED_DIMS; d++) cos += vec[d]! * (v[d] ?? 0);
      scored.push({ page, cos });
    }
    scored.sort((a, b) => b.cos - a.cos);
    const top = scored.slice(0, k);
    let extra = scored.slice(k).filter((s) => s.page.category === generalCategory);
    // 给了 extraMax（assoc.generalExtra）就最多补这么多页；没给照旧：总数超过 MAX_CANDIDATES 才只补 EXTRA_WHEN_OVER 页
    if (extraMax !== undefined) extra = extra.slice(0, extraMax);
    else if (top.length + extra.length > MAX_CANDIDATES) extra = extra.slice(0, EXTRA_WHEN_OVER);
    return [...top, ...extra].map((s) => s.page);
  }

  /** The same shortlist with no vectors (no OpenAI key): by the words the topic shares with each page's cover; pages sharing none are left out */
  shortlistByWords(topic: string, shelf: Shelf, k: number, generalCategory: string, extraMax?: number): Page[] {
    const w = wordsOf(topic);
    const scored = shelf.pages.filter((p) => !p.archived && p.ids[0]).map((page) => ({ page, n: sharedWords(w, wordsOf(coverText(page))) }))
      .filter((s) => s.n > 0).sort((a, b) => b.n - a.n);
    const top = scored.slice(0, k);
    const extra = scored.slice(k).filter((s) => s.page.category === generalCategory).slice(0, extraMax ?? EXTRA_WHEN_OVER);
    return [...top, ...extra].map((s) => s.page);
  }
}

/**
 * 页里每条教训、做法的向量（11-03 教训级别联想）：联想时拿话题按余弦直接挑最像的几条，和页一起交给判断，
 * 不靠封面先排进前几（又犯的那些多半是封面对不上、页里某一条对得上）。
 * 只放在内存里：一整书架几百条，hhd 起来算一批（一两秒），书架变了只重算变了的；还没算好时联想照旧只看页
 */
export class ItemIndex {
  private readonly embedder: Embedder | null;
  private readonly read: (rel: string) => string | null;
  private readonly role: () => ItemRole;
  private readonly vecs = new Map<string, { item: Item; hash: string; vec: Float32Array }>();
  /** 刷新一个接一个（慢的旧那次不会在新的之后才写回、把新条目删掉） */
  private queue: Promise<unknown> = Promise.resolve();

  /** role：主人的名字、书架目录、出处里要留下的记号——每次刷新时现取（记号跟着书架重扫会变） */
  constructor(embedder: Embedder | null, read: (rel: string) => string | null, role: () => ItemRole) {
    this.embedder = embedder;
    this.read = read;
    this.role = role;
  }

  /** 书架上现在的条目：新的、改过的算向量，不在了的去掉。向量没算成（embed 出错不抛、给 null）报 failed，留着旧的 */
  refresh(shelf: Shelf, o: { timeoutMs?: number } = {}): Promise<{ embedded: number; failed?: true }> {
    const run = this.queue.then(() => this.refreshNow(shelf, o));
    this.queue = run.catch(() => {});
    return run;
  }

  private async refreshNow(shelf: Shelf, o: { timeoutMs?: number }): Promise<{ embedded: number; failed?: true }> {
    if (!this.embedder) return { embedded: 0 };
    const role = this.role();
    const now = shelf.pages.flatMap((p) => {
      let text: string | null = null;
      try { text = this.read(p.rel); } catch { text = null; }
      return pageItems(p, text, role);
    });
    const todo = now.filter((it) => this.vecs.get(it.id)?.hash !== sha1(it.ask));
    if (todo.length) {
      const vecs = await this.embedder.embed(todo.map((t) => t.ask), { timeoutMs: o.timeoutMs ?? REFRESH_TIMEOUT_MS });
      if (!vecs || vecs.length !== todo.length) return { embedded: 0, failed: true };
      todo.forEach((it, i) => this.vecs.set(it.id, { item: it, hash: sha1(it.ask), vec: vecs[i]! }));
    }
    const ids = new Set(now.map((it) => it.id));
    for (const id of [...this.vecs.keys()]) if (!ids.has(id)) this.vecs.delete(id);
    // 没重算的也换成这次读到的那份（显示的那行、原文可能变了，问的那句没变）
    for (const it of now) { const v = this.vecs.get(it.id); if (v) v.item = it; }
    return { embedded: todo.length };
  }

  /**
   * 强度到 min 的教训（强联想：不管像不像都问判断）；skip 里的（已经按向量挑上的）先去掉，再按强度、和话题像不像排，最多 k 条；只在这些页里挑。
   * keep：只要这样的（发给主人之前只要标了「提醒：发之前」的），在取前 k 条之前筛，别让别的强教训占满了名额
   */
  strong(v: Float32Array, pages: ReadonlySet<string>, min: number, k: number, skip: ReadonlySet<string> = new Set(), keep?: (it: Item) => boolean): Item[] {
    const cos = (vec: Float32Array): number => { let s = 0; for (let d = 0; d < vec.length && d < v.length; d++) s += vec[d]! * v[d]!; return s; };
    return [...this.vecs.values()]
      .filter(({ item }) => item.kind === "lesson" && item.strength >= min && pages.has(item.pageId) && !skip.has(item.id) && (!keep || keep(item)))
      .map(({ item, vec }) => ({ item, cos: cos(vec) }))
      .sort((a, b) => b.item.strength - a.item.strength || b.cos - a.cos)
      .slice(0, k)
      .map((x) => x.item);
  }

  /** 余弦前 k 条；只在这些页里挑（书架上的、没归档的、这次没挡掉的） */
  shortlist(v: Float32Array, pages: ReadonlySet<string>, k: number): Item[] {
    const scored: Array<{ item: Item; cos: number }> = [];
    for (const { item, vec } of this.vecs.values()) {
      if (!pages.has(item.pageId) || vec.length !== v.length) continue;
      let cos = 0;
      for (let d = 0; d < vec.length; d++) cos += vec[d]! * v[d]!;
      scored.push({ item, cos });
    }
    return scored.sort((a, b) => b.cos - a.cos).slice(0, k).map((s) => s.item);
  }
}
