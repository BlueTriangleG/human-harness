// 笔记分层：页不挪、不删，只分浅、中、深三层。
// 浅：重要的，或者常翻的；深：不重要、很久没翻的；其余是中。重要的页永远不进深层（硬规矩，有测试）。
// 重要不重要看她的数据：页开头写的重要度、有教训在常驻、页里最强那条教训的强度、正文里有她的规矩文件点名的记号。
// 记号和重要度的键名写在书架根目录下她自己的规矩文件里（配置 learning.shelfFile，默认 shelf.json），代码里不带任何名字；
// 文件缺了、读不了：没有记号、键名用 importance，问题带回去让夜里报告和日志看得见。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { all, type Db } from "../store/db.ts";
import { resolveId } from "./ids.ts";
import type { Page, Shelf } from "./notebook.ts";
import { param } from "./params.ts";
import { L } from "../lang/index.ts";

export type Layer = "shallow" | "mid" | "deep";
export const SHELF_FILE = "shelf.json";
const DAY_MS = 86_400_000;
/** 到这个重要度算重要（教训强度到 4 是强联想，同一条线） */
export const IMPORTANT_MIN = 4;
const BASE_IMPORTANCE = 3;

export interface ShelfRules {
  /** 正文里出现哪些记号算重要 */
  importantMarks: string[];
  /** 页开头（frontmatter 或封面那几行）写重要度的键名 */
  importanceKey: string;
}

/** 读她的规矩文件；缺了、坏了给通用的默认，problem 说哪里不对 */
export function readShelfRules(root: string, file = SHELF_FILE): { rules: ShelfRules; problem: string | null } {
  const rules: ShelfRules = { importantMarks: [], importanceKey: "importance" };
  let raw: string;
  try {
    raw = readFileSync(join(root, file), "utf8");
  } catch {
    return { rules, problem: L.layers.rulesMissing(file) };
  }
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(L.layers.rulesNotObject);
    if (Array.isArray(v["importantMarks"])) rules.importantMarks = v["importantMarks"].filter((x): x is string => typeof x === "string" && x.trim().length > 0);
    if (typeof v["importanceKey"] === "string" && v["importanceKey"].trim()) rules.importanceKey = v["importanceKey"].trim();
    return { rules, problem: null };
  } catch (e) {
    return { rules, problem: L.layers.rulesUnreadable(file, String(e).slice(0, 80)) };
  }
}

/** 页开头写的重要度（0–5）：frontmatter 里，或标题下面头几行的「键：N」；没写是 null */
export function statedImportance(text: string, key: string): number | null {
  const k = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = text.replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 12).join("\n");
  const m = new RegExp(`^\\s*(?:[-*]\\s*)?${k}\\s*[:：]\\s*([0-5])(?!\\d)`, "m").exec(head);
  return m ? Number(m[1]) : null;
}

export interface PageUse { opens: number; lastOpen: number | null; firstSeen: number | null }
export interface PageLayer {
  id: string; rel: string; title: string; layer: Layer;
  importance: number; important: boolean;
  /** 最近 layers.deepDays 天里有几天翻开过、多少天没翻（没翻过的从第一次扫到加宽限起算）、是不是从没翻过 */
  opens: number; days: number; never: boolean;
  score: number;
}

/** 一页的重要度：页里写的优先；不然取常驻（5）、最强教训的强度、有记号（4）里最高的，最低 3 */
export function importanceOf(page: Page, text: string | null, rules: ShelfRules, resident: ReadonlySet<string>): number {
  const stated = text ? statedImportance(text, rules.importanceKey) : null;
  if (stated !== null) return stated;
  let v = BASE_IMPORTANCE;
  if (page.lessons.some((l) => l.ids.some((id) => resident.has(id)))) v = 5;
  v = Math.max(v, ...page.lessons.map((l) => l.strength ?? BASE_IMPORTANCE));
  if (text && rules.importantMarks.some((m) => text.includes(m))) v = Math.max(v, IMPORTANT_MIN);
  return v;
}

/** 定一页在哪层（纯函数）。重要的永远不进深层 */
export function layerOf(importance: number, use: PageUse, now: number, c: { deepDays: number; graceDays: number; shallowOpens: number }): { layer: Layer; days: number; never: boolean; important: boolean } {
  const important = importance >= IMPORTANT_MIN;
  const never = use.lastOpen === null;
  const ref = use.lastOpen ?? (use.firstSeen ?? now) + c.graceDays * DAY_MS;
  const days = Math.max(0, Math.floor((now - ref) / DAY_MS));
  let layer: Layer = important || use.opens >= c.shallowOpens ? "shallow" : days >= c.deepDays ? "deep" : "mid";
  if (important && layer === "deep") layer = "shallow";   // 硬规矩，上面的写法变了也守得住
  return { layer, days, never, important };
}

/** 整个书架分一遍层：读页的原文、翻开记录（learn_open）、第一次扫到的时刻（learn_item）；归档的、没编号的不算 */
export function computeLayers(db: Db, shelf: Shelf, o: { rules: ShelfRules; resident: ReadonlySet<string>; read: (rel: string) => string | null; now: number }): PageLayer[] {
  const c = { deepDays: param(db, "layers.deepDays"), graceDays: param(db, "layers.graceDays"), shallowOpens: param(db, "layers.shallowOpens") };
  const since = o.now - c.deepDays * DAY_MS;
  // 翻开次数按天数：一天里分几段读同一页（每次读都记一行）只算一次
  const use = new Map<string, { opens: number; lastOpen: number | null; days: Set<number> }>();
  const alias = new Map<string, string>();
  for (const r of all<{ page_id: string; at: number }>(db, "SELECT page_id, at FROM learn_open WHERE page_id IS NOT NULL")) {
    let id = alias.get(r.page_id);
    if (id === undefined) { id = resolveId(db, r.page_id); alias.set(r.page_id, id); }
    const u = use.get(id) ?? { opens: 0, lastOpen: null, days: new Set<number>() };
    const at = Number(r.at);
    if (at >= since) { u.days.add(Math.floor(at / DAY_MS)); u.opens = u.days.size; }
    if (u.lastOpen === null || at > u.lastOpen) u.lastOpen = at;
    use.set(id, u);
  }
  const firstSeen = new Map(all<{ id: string; first_seen: number }>(db, "SELECT id, first_seen FROM learn_item WHERE kind = 'page'").map((r) => [r.id, Number(r.first_seen)]));
  return shelf.pages.filter((p) => !p.archived && p.ids[0]).map((p) => {
    const id = p.ids[0]!;
    const importance = importanceOf(p, o.read(p.rel), o.rules, o.resident);
    const u = use.get(id) ?? { opens: 0, lastOpen: null };   // opens：最近 deepDays 天里有几天翻过
    const l = layerOf(importance, { ...u, firstSeen: firstSeen.get(id) ?? null }, o.now, c);
    const score = importance * 10 + Math.min(u.opens, 10) * 2 - Math.floor(l.days / 14);
    return { id, rel: p.rel, title: p.title, layer: l.layer, importance, important: l.important, opens: u.opens, days: l.days, never: l.never, score };
  });
}
