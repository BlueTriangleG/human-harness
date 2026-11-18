// 笔记分层的夜里那一步（#0058：页不挪、不删、不标旧，重要度低的放到更深的层级而不是消失）。
// 每晚按书架现在的样子分一遍层（layers.ts），记进 kv learn.layers，往夜里报告里写一节：今晚沉到深层的页（方便抽查有没有沉错）、
// （联想现在还不看层：照旧按说的话带页。等联想接上以后，报告里那句说明再改。）
// 重要但很久没翻的页（重要的不沉，只列出来让她自己看）。以前那版挪进 归档/ 的做法停了。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { all, kvGet, kvSet, type Db } from "../store/db.ts";
import type { Link } from "./graph.ts";
import { computeLayers, readShelfRules, SHELF_FILE, type Layer, type PageLayer } from "./layers.ts";
import { scanShelf, type Shelf } from "./notebook.ts";
import { param } from "./params.ts";
import { residentIds } from "./shelf.ts";
import { L } from "../lang/index.ts";

export const LAYERS_KEY = "learn.layers";   // {at, pages: {页编号: 层}}：上一次分的层（控制台、联想、和今晚比）

/** 上一次分的层；没有、坏了给空的 */
export function savedLayers(db: Db): Map<string, Layer> {
  try {
    const v = JSON.parse(kvGet(db, LAYERS_KEY) ?? "{}") as { pages?: Record<string, Layer> };
    return new Map(Object.entries(v.pages ?? {}));
  } catch {
    return new Map();
  }
}

/**
 * 读书架和 hh.db 分一遍层、记下来，返回各页的层和报告里的一节（没什么可说的给空串）。只读角色的文件，不改。
 * o.archiveDir、o.residentFile：归档目录的名字、常驻单子的文件名（配置 learning 里的）
 */
export function curateShelf(db: Db, root: string, generalCategory: string, now: number, o: { archiveDir: string; residentFile: string; shelfFile?: string }): { pages: PageLayer[]; text: string; problem: string | null } {
  const shelf = scanShelf(root, generalCategory, o.archiveDir);
  const read = (rel: string): string | null => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };
  const { rules, problem } = readShelfRules(root, o.shelfFile ?? SHELF_FILE);
  const resident = residentIds(read(o.residentFile), shelf, param(db, "strength.residentMax"));
  const before = savedLayers(db);
  const pages = computeLayers(db, shelf, { rules, resident, read, now });
  kvSet(db, LAYERS_KEY, JSON.stringify({ at: now, pages: Object.fromEntries(pages.map((p) => [p.id, p.layer])) }));
  const deepDays = param(db, "layers.deepDays");
  const sunk = pages.filter((p) => p.layer === "deep" && before.get(p.id) !== "deep").sort((a, b) => b.days - a.days);
  const quiet = pages.filter((p) => p.important && p.days >= deepDays).sort((a, b) => b.days - a.days);
  const line = (p: PageLayer): string => L.curator.pageLine(p.rel, p.never ? L.curator.neverOpened(p.days) : L.curator.daysUnopened(p.days), p.importance);
  const count = (l: Layer): number => pages.filter((p) => p.layer === l).length;
  const parts: string[] = [];
  if (sunk.length) parts.push(L.curator.sunkHeader, ...sunk.map(line));
  if (quiet.length) parts.push(...(parts.length ? [""] : []), L.curator.quietImportantHeader, ...quiet.map(line));
  if (problem) parts.push(...(parts.length ? [""] : []), `- ${problem}`);
  const text = parts.length ? [L.curator.sectionTitle(count("shallow"), count("mid"), count("deep")), ...parts].join("\n") : "";
  return { pages, text, problem };
}

export interface GraphNode extends PageLayer { category: string; book: string }
/**
 * 整张图的数据（hh learn graph --json、控制台的关系图）：点是书架上的页（层、重要度、分数现算，带大类和本），线是 learn_link 里存着的。
 * 只读：不调模型、不发号、不写库；层是按 now 现算的，和夜里存的 learn.layers 可能差一天
 */
export function graphData(db: Db, shelf: Shelf, root: string, now: number, o: { residentFile: string; shelfFile?: string }): { nodes: GraphNode[]; links: Link[] } {
  const read = (rel: string): string | null => { try { return readFileSync(join(root, rel), "utf8"); } catch { return null; } };
  const { rules } = readShelfRules(root, o.shelfFile ?? SHELF_FILE);
  const resident = residentIds(read(o.residentFile), shelf, param(db, "strength.residentMax"));
  const byId = new Map(shelf.pages.map((p) => [p.ids[0], p] as const));
  const nodes = computeLayers(db, shelf, { rules, resident, read, now }).map((n) => ({ ...n, category: byId.get(n.id)?.category ?? "", book: byId.get(n.id)?.book ?? "" }));
  const links = all<Link>(db, "SELECT a, b, kind, weight, n FROM learn_link ORDER BY kind, a, b");
  return { nodes, links };
}
