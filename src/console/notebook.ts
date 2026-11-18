// 控制台的「笔记」页：她书架上每一页在哪一层、多重要、多久没翻，和页与页之间的线。
// 全部只读：书架只扫不发号，层是按打开页面那一刻现算的（学习的 graphData），不写库、不调模型。
import type { DatabaseSync } from "node:sqlite";
import { graphData } from "../learning/curator.ts";
import type { LinkKind } from "../learning/graph.ts";
import type { Layer } from "../learning/layers.ts";
import { shelfOf } from "./shelf.ts";
import { param } from "../learning/params.ts";

export interface NotebookOptions {
  /** 书架根目录、通用大类的名字（config learning） */
  root: string;
  generalCategory: string;
  /** name of the archive directory in the shelf (config learning.archiveDir) */
  archiveDir: string;
  /** file name of the resident list at the shelf root (config learning.residentFile) */
  residentFile: string;
  /** 书架根目录下她自己的规矩文件（哪些记号算重要）；不给用学习那边的默认名 */
  shelfFile?: string;
}

export interface NotebookPage {
  id: string;
  title: string;
  /** 相对书架根目录的路径 */
  rel: string;
  /** 大类、哪一本；不在任何一本里的页 book 是空串 */
  category: string;
  book: string;
  layer: Layer;
  /** 重要度 0–5；important = 到了「重要」那条线，重要的页不进深层 */
  importance: number;
  important: boolean;
  /** 最近 deepDays 天里有几天翻开过 */
  opens: number;
  /** 多少天没翻。never 为真是从没翻过，这时 days 从第一次扫到、过了宽限那天起算 */
  days: number;
  never: boolean;
  /** 学习排先后用的分：同一本里按它排，页面上不显示 */
  score: number;
  /** 重要、但 deepDays 天以上没翻：重要的不沉，所以单独标出来让人看（封面可能写得对不上） */
  stale: boolean;
  /** 连着几条线 */
  links: number;
}

export interface NotebookLink { a: string; b: string; kind: LinkKind; weight: number }

export interface NotebookView {
  at: number;
  /** 不重要的页多少天没翻就进深层（学习的参数 layers.deepDays）；「很久没翻」也按它算 */
  deepDays: number;
  pages: NotebookPage[];
  links: NotebookLink[];
}

export function notebookView(db: DatabaseSync, now: number, o: NotebookOptions): NotebookView {
  const shelf = shelfOf(o.root, o.generalCategory, o.archiveDir);   // 书架上的文件没变就不重读（shelf.ts）
  const { nodes, links } = graphData(db, shelf, o.root, now, { residentFile: o.residentFile, ...(o.shelfFile ? { shelfFile: o.shelfFile } : {}) });
  const deepDays = param(db, "layers.deepDays");
  // 线的两头都得是书架上现在有的页：归档了的、合并后换了号的页留下的线不画
  const on = new Set(nodes.map((n) => n.id));
  const kept = links.filter((l) => l.a !== l.b && on.has(l.a) && on.has(l.b)).map((l) => ({ a: l.a, b: l.b, kind: l.kind, weight: Number(l.weight) }));
  const degree = new Map<string, number>();
  for (const l of kept) for (const id of [l.a, l.b]) degree.set(id, (degree.get(id) ?? 0) + 1);
  return {
    at: now,
    deepDays,
    pages: nodes.map((n) => ({
      id: n.id, title: n.title, rel: n.rel, category: n.category, book: n.book, layer: n.layer, importance: n.importance, important: n.important,
      opens: n.opens, days: n.days, never: n.never, score: n.score, stale: n.important && n.days >= deepDays, links: degree.get(n.id) ?? 0,
    })),
    links: kept,
  };
}
