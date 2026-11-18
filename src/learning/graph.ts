// 笔记之间的连线（像 Obsidian 的关系图）。
// 不改她的页，从已有的记录算三种线，存进 learn_link（夜里收尾时整张重算；白天书架改了只重算 ref）：
// - ref：页里提到另一页（[[链接]]、[文字](路径.md)、反引号里的路径、正文里写的「某某.md」）。有方向：a 提到 b
// - co：同一件事（tasks）做的期间，那个脑区一起翻开过的两页（两次翻开相隔不超过 links.coGapMin 分钟）。越久以前的越轻（半衰期 CO_HALF_DAYS 天），没方向（a < b）
// - event：事件库里同一件事的经过写到的几页。没方向
// 页按编号认（第一个编号）；归档的页、书架上没有的不连。文件名重了又没写路径的不猜。
import { all, type Db } from "../store/db.ts";
import { resolveId } from "./ids.ts";
import { param } from "./params.ts";
import type { Page, Shelf } from "./notebook.ts";

export type LinkKind = "ref" | "co" | "event";
export interface Link { a: string; b: string; kind: LinkKind; weight: number; n: number }

const DAY_MS = 86_400_000;
/** 一起翻过的线，过这么多天权重减半 */
export const CO_HALF_DAYS = 30;
/** 过了这么多个半衰期的事不再算 */
const CO_MAX_HALVES = 10;
/** 一件事的经过里写到的页多过这么多，是在列清单（搬家、整理），不算这几页有关 */
const EVENT_MAX_PAGES = 6;
/** 一件事没写完（ended 空）的，做的期间按开始以后这么久算 */
const OPEN_TASK_MS = 3 * 3600_000;

/** 文字里提到的页：[[名]]、[[名|别名]]、](路径.md)、`路径.md`、「某某.md」这种写法；返回原样的那一截（路径或名字） */
function mentions(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\[\[([^\]|#\n]+)(?:[#|][^\]\n]*)?\]\]/g)) out.push(m[1]!.trim());
  const MD_LINK = /\]\(([^)\s]+?\.md)(?:#[^)]*)?\)/g;
  for (const m of text.matchAll(MD_LINK)) out.push(decodeURIComponentSafe(m[1]!));
  // 剩下的：反引号里的路径、正文里直接写的文件名（markdown 链接那几处已经算过，先抹掉）
  // 前面那个往回看：一串连着的字只从头起一次（不然一长串没有 .md 的字，比如图片的 base64，会按长度的平方算）
  for (const m of text.replace(MD_LINK, "] ").matchAll(/(?<![^\s`「」（）()\[\]<>"'，。、：；|])[^\s`「」（）()\[\]<>"'，。、：；|]+?\.md\b/g)) out.push(m[0]);
  return out;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** 书架上的页怎么认：路径、文件名（去掉 .md）、标题都能认；同名的不止一页就只认路径 */
export function pageIndex(shelf: Shelf): { byRel: Map<string, Page>; resolve: (mention: string) => Page | null } {
  const live = shelf.pages.filter((p) => !p.archived && p.ids[0]);
  const byRel = new Map(live.map((p) => [p.rel.normalize("NFC"), p]));
  const byName = new Map<string, Page[]>();
  const put = (k: string, p: Page): void => { const key = k.normalize("NFC").toLowerCase(); const l = byName.get(key) ?? []; if (!l.includes(p)) l.push(p); byName.set(key, l); };
  for (const p of live) {
    put(p.rel.split("/").at(-1)!.replace(/\.md$/, ""), p);
    if (p.title) put(p.title, p);
  }
  const resolve = (mention: string): Page | null => {
    const m = mention.normalize("NFC").replace(/^\.?\/+/, "").replace(/^(?:\.\.\/)+/, "").replace(/\.md$/, "");
    // 写了路径：按结尾对得上的那一页（前面带 skills/ 这类前缀也行，写不写 .md 都行）；路径对不上书架上的页就不认，不再按文件名猜
    // （别处的同名文件，比如 notes/、sleep/ 下面的，不是书架上的页）
    if (m.includes("/")) {
      const hit = live.filter((p) => { const rel = p.rel.replace(/\.md$/, ""); return m === rel || m.endsWith(`/${rel}`) || rel.endsWith(`/${m}`); });
      return hit.length === 1 ? hit[0]! : null;
    }
    const name = m.toLowerCase();
    const l = byName.get(name) ?? [];
    return l.length === 1 ? l[0]! : null;
  };
  return { byRel, resolve };
}

/** ref：每页正文里提到的别的页（同一对只算一条，次数记在 n） */
export function refLinks(shelf: Shelf, read: (rel: string) => string | null): Link[] {
  const ix = pageIndex(shelf);
  const out = new Map<string, Link>();
  for (const p of ix.byRel.values()) {
    const text = read(p.rel);
    if (!text) continue;
    for (const m of mentions(text)) {
      const q = ix.resolve(m);
      if (!q || q === p) continue;
      const key = `${p.ids[0]}>${q.ids[0]}`;
      const l = out.get(key) ?? { a: p.ids[0]!, b: q.ids[0]!, kind: "ref" as const, weight: 1, n: 0 };
      l.n += 1;
      out.set(key, l);
    }
  }
  return [...out.values()];
}

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** co：每件事做的期间，那个脑区相隔不超过 links.coGapMin 分钟翻开的页两两连；权重 = 每件事 0.5^(多少天以前 / CO_HALF_DAYS) 加起来 */
export function coLinks(db: Db, shelf: Shelf, now: number): Link[] {
  const live = new Set(shelf.pages.filter((p) => !p.archived && p.ids[0]).map((p) => p.ids[0]!));
  const out = new Map<string, Link>();
  // 太久以前的不算（权重不到千分之一）；翻开记录一次读出来按脑区分好，不是每件事查一遍
  const since = now - CO_MAX_HALVES * CO_HALF_DAYS * DAY_MS;
  const tasks = all<{ owner: string; started: number; ended: number | null }>(db, "SELECT owner, started, ended FROM tasks WHERE started >= ?", since);
  const alias = new Map<string, string>();
  const idOf = (raw: string): string => { let v = alias.get(raw); if (v === undefined) { v = resolveId(db, raw); alias.set(raw, v); } return v; };
  const opens = new Map<string, Array<{ at: number; id: string }>>();
  for (const r of all<{ region: string; at: number; page_id: string }>(db, "SELECT region, at, page_id FROM learn_open WHERE page_id IS NOT NULL AND at >= ? ORDER BY at", since)) {
    const id = idOf(r.page_id);
    if (!live.has(id)) continue;
    const l = opens.get(r.region) ?? [];
    l.push({ at: Number(r.at), id });
    opens.set(r.region, l);
  }
  /** 按时刻排好的一串里，第一个不早于 t 的位置 */
  const from = (l: Array<{ at: number }>, t: number): number => { let lo = 0, hi = l.length; while (lo < hi) { const mid = (lo + hi) >> 1; if (l[mid]!.at < t) lo = mid + 1; else hi = mid; } return lo; };
  const gap = param(db, "links.coGapMin") * 60_000;
  for (const t of tasks) {
    const end = t.ended ?? Number(t.started) + OPEN_TASK_MS;
    const l = opens.get(t.owner) ?? [];
    // 这件事里相隔不超过 gap 的两次翻开才连（事开了一整天时，早上翻的和夜里翻的不算一起翻）；一对页一件事只算一次
    const pairs = new Set<string>();
    for (let i = from(l, Number(t.started)); i < l.length && l[i]!.at <= end; i++) {
      for (let j = i + 1; j < l.length && l[j]!.at <= end && l[j]!.at - l[i]!.at <= gap; j++) {
        if (l[i]!.id === l[j]!.id) continue;
        const [a, b] = pair(l[i]!.id, l[j]!.id);
        pairs.add(`${a}~${b}`);
      }
    }
    const w = 0.5 ** (Math.max(0, now - Number(t.started)) / (CO_HALF_DAYS * DAY_MS));
    for (const key of [...pairs].sort()) {
      const [a, b] = key.split("~") as [string, string];
      const l = out.get(key) ?? { a, b, kind: "co" as const, weight: 0, n: 0 };
      l.weight += w;
      l.n += 1;
      out.set(key, l);
    }
  }
  return [...out.values()].map((l) => ({ ...l, weight: Math.round(l.weight * 1000) / 1000 }));
}

/** event：事件库同一件事的经过（正文和出处）里写到的页两两连；没有事件库（表不在）就没有 */
export function eventLinks(db: Db, shelf: Shelf): Link[] {
  const ix = pageIndex(shelf);
  let rows: Array<{ event_id: string; full: string; source: string }>;
  try {
    rows = all(db, "SELECT event_id, full, source FROM mem_entry WHERE full LIKE '%.md%' OR source LIKE '%.md%' OR full LIKE '%[[%'");
  } catch {
    return [];
  }
  const byEvent = new Map<string, Set<string>>();
  for (const r of rows) {
    const s = byEvent.get(r.event_id) ?? new Set<string>();
    for (const m of mentions(`${r.full}\n${r.source}`)) { const p = ix.resolve(m); if (p) s.add(p.ids[0]!); }
    byEvent.set(r.event_id, s);
  }
  const out = new Map<string, Link>();
  for (const s of byEvent.values()) {
    if (s.size > EVENT_MAX_PAGES) continue;
    const ids = [...s].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]}~${ids[j]}`;
        const l = out.get(key) ?? { a: ids[i]!, b: ids[j]!, kind: "event" as const, weight: 0, n: 0 };
        l.weight += 1;
        l.n += 1;
        out.set(key, l);
      }
    }
  }
  return [...out.values()];
}

/** 整张换掉这几种线（一个事务里：删了再写）；返回各种写了几条 */
export function saveLinks(db: Db, kinds: readonly LinkKind[], links: readonly Link[], now: number): Record<LinkKind, number> {
  const count: Record<LinkKind, number> = { ref: 0, co: 0, event: 0 };
  const del = db.prepare("DELETE FROM learn_link WHERE kind = ?");
  const ins = db.prepare("INSERT OR REPLACE INTO learn_link (a, b, kind, weight, n, updated) VALUES (?, ?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const k of kinds) del.run(k);
    for (const l of links) {
      if (!kinds.includes(l.kind)) continue;
      ins.run(l.a, l.b, l.kind, l.weight, l.n, now);
      count[l.kind] += 1;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return count;
}

/** 三种都重算（夜里收尾时）；refOnly 只重算页里提到的（白天书架改了） */
export function rebuildLinks(db: Db, shelf: Shelf, read: (rel: string) => string | null, now: number, o: { refOnly?: boolean } = {}): Record<LinkKind, number> {
  if (o.refOnly) return saveLinks(db, ["ref"], refLinks(shelf, read), now);
  return saveLinks(db, ["ref", "co", "event"], [...refLinks(shelf, read), ...coLinks(db, shelf, now), ...eventLinks(db, shelf)], now);
}

/** 一页连着的线：出（它提到的）、入（提到它的）、co 和 event（没方向） */
export function linksOf(db: Db, id: string): Link[] {
  return all<Link>(db, "SELECT a, b, kind, weight, n FROM learn_link WHERE a = ? OR b = ? ORDER BY kind, weight DESC", id, id)
    .map((l) => ({ ...l, weight: Number(l.weight), n: Number(l.n) }));
}

/** 每种线各占多少分量：页里写明的最重，一起翻过的其次（按次数），同一件事的经过里写到的再次 */
export const KIND_WEIGHT: Record<LinkKind, number> = { ref: 1, co: 0.8, event: 0.6 };

/** 一页最近的几页：几种线的分量加起来（ref 两个方向都算），从大到小；skip 里的不要 */
export function neighbors(db: Db, id: string, n: number, skip: ReadonlySet<string> = new Set()): Array<{ id: string; score: number; kinds: LinkKind[] }> {
  const acc = new Map<string, { score: number; kinds: Set<LinkKind> }>();
  for (const l of linksOf(db, id)) {
    const other = l.a === id ? l.b : l.a;
    if (other === id || skip.has(other)) continue;
    const e = acc.get(other) ?? { score: 0, kinds: new Set<LinkKind>() };
    e.score += KIND_WEIGHT[l.kind] * (l.kind === "co" ? Math.min(3, l.weight) : l.kind === "event" ? Math.min(3, l.weight) : 1);
    e.kinds.add(l.kind);
    acc.set(other, e);
  }
  return [...acc].map(([k, v]) => ({ id: k, score: Math.round(v.score * 1000) / 1000, kinds: [...v.kinds].sort() }))
    .sort((x, y) => y.score - x.score || x.id.localeCompare(y.id)).slice(0, Math.max(0, n));
}
