// 书架目录：她的笔记本按大类列出来，进纪元前缀（开关 learning.shelf）。只列本和页数，页的内容不进前缀。
import { relative, sep } from "node:path";
import { L } from "../lang/index.ts";
import { cleanPractice, type Shelf } from "./notebook.ts";

/** 没有未归档的页（空书架、读不了、全归档）返回空串，前缀里就不放这一节 */
export function renderShelf(shelf: Shelf): string {
  if (!shelf.pages.some((p) => !p.archived)) return "";

  // 大类和本都照 scanShelf 排好的顺序；通用大类挪到最前
  const byCategory = new Map<string, string[]>();
  for (const b of shelf.books) {
    const lines = byCategory.get(b.category) ?? [];
    lines.push(L.shelf.bookLine(b.book, b.description, b.pages));
    byCategory.set(b.category, lines);
  }
  const general = shelf.pages.find((p) => p.general)?.category;
  const categories = [...byCategory.keys()].sort((a, b) => Number(b === general) - Number(a === general));

  return [L.shelf.header, ...categories.map((c) => `## ${c}\n${byCategory.get(c)!.join("\n")}`)].join("\n\n");
}

const RESIDENT_CHARS = 120;
const clipLine = (s: string): string => ([...s].length > RESIDENT_CHARS ? `${[...s].slice(0, RESIDENT_CHARS).join("")}…` : s);

/**
 * 常驻单子：
 * 角色自己的单子（书架根目录下的 learning.residentFile，「- 」开头的行，编号注释去掉）取前 max 条；没有单子或单子是空的，按强度 5 的教训列
 * （「什么时候 → 下次」，最近犯的在前）。都没有、或 max 是 0：不放。
 * o.shelfDir：书架目录相对工作区的路径，o.residentFile：单子的文件名（开头那句里写单子在哪）；o.keep：教训出处里要留下的记号（见 cleanPractice）
 */
export function renderResident(mine: string | null, shelf: Shelf, max: number, o: { shelfDir: string; residentFile: string; keep?: readonly string[] }): string {
  const lines = residentLines(mine, shelf, max, o.keep ?? []);
  return lines.length ? [L.residentHeader(`${o.shelfDir}/${o.residentFile}`), ...lines.map((l) => clipLine(`- ${l.text}`))].join("\n") : "";
}

/** 书架目录相对工作区的路径，写成正斜杠（给她看的页路径的前缀；学习的运行时、前缀里的常驻单子、夜里的工作单用同一个算法） */
export function shelfDirOf(workspace: string, root: string): string {
  return relative(workspace, root).split(sep).join("/");
}

/** 前缀里真放的那几条常驻的教训编号（夜里工作单拿它判断哪条在常驻） */
export function residentIds(mine: string | null, shelf: Shelf, max: number): Set<string> {
  // 只要编号：出处里留哪些记号不影响编号，不用传
  return new Set(residentLines(mine, shelf, max, []).flatMap((l) => l.ids));
}

/** 常驻那几条：她的单子（列表项：「- 」「* 」「1. 」都算；注释里的不算）前 max 条，没有就按强度 5 的教训；带每条指着的教训编号 */
function residentLines(mine: string | null, shelf: Shelf, max: number, keep: readonly string[]): Array<{ text: string; ids: string[] }> {
  if (!(max >= 1)) return [];
  const own = (mine ?? "").replace(/^\uFEFF/, "").replace(/<!--(?![^\n]*?l:\d)[\s\S]*?-->/g, "").split(/\r?\n/)
    .map((l) => /^(?:[-*+]|\d+[.)、])\s+(.*)$/.exec(l)?.[1] ?? null).filter((l): l is string => l !== null)
    .map((l) => ({ text: l.replace(/<!--.*?-->/g, "").trim(), ids: [...l.matchAll(/l:(\d{4,})/g)].map((m) => m[1]!) }))
    .filter((l) => l.text.length > 0);
  if (own.length) return own.slice(0, Math.floor(max));
  return shelf.pages.filter((p) => !p.archived).flatMap((p) => p.lessons)
    .filter((l) => (l.strength ?? 3) >= 5)
    .sort((a, b) => (b.days.at(-1) ?? "").localeCompare(a.days.at(-1) ?? ""))
    .slice(0, Math.floor(max))
    .map((l) => { const when = cleanPractice(l.when, keep); const what = cleanPractice(l.next || l.text, keep); return { text: `${when ? `${when} → ` : ""}${what}`, ids: l.ids.slice(0, 1) }; });
}
