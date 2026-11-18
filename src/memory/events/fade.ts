// 淡忘：只决定"怎么写出来"，记录本身永远完整（重要度 0–5，5 是核心记忆，永远不忘）。
// 天数从 max(发生时间, 最后一次被碰) 算起；被碰 = 她展开过、引用过、有了新进展。
import type { Kind } from "./schema.ts";

export type Clarity = "full" | "gist" | "title" | "fold" | "hidden";

const DAY = 86_400_000;
/** 重要度 → [全文到第几天, 一句话到第几天, 标题到第几天]；之后 0 级不再被想起，其余折叠 */
export const FADE_DAYS: Record<number, readonly [number, number, number]> = {
  5: [Infinity, Infinity, Infinity],
  4: [60, 365, Infinity],
  3: [14, 120, 730],
  2: [7, 60, 365],
  1: [3, 30, 182],
  0: [1, 7, 30],
};

function byAge(importance: number, ageDays: number): Clarity {
  const [full, gist, title] = FADE_DAYS[Math.max(0, Math.min(5, Math.round(importance)))]!;
  if (ageDays <= full) return "full";
  if (ageDays <= gist) return "gist";
  if (ageDays <= title) return "title";
  return importance <= 0 ? "hidden" : "fold";
}

/** 不淡：钉住的，或还在喜欢 / 烦着的（stance 且 ongoing）。只管清晰度，不影响排序 */
export function staysClear(ev: { pinned: number | boolean; stance?: string | null; status: string }): boolean {
  return Boolean(ev.pinned) || (ev.stance != null && ev.status === "ongoing");
}

/** 时间线上一条经过现在多清楚 */
export function clarity(o: { importance: number; pinned: boolean; kind: Kind; at: number; touched: number | null; now: number }): Clarity {
  const imp = o.pinned ? 5 : o.importance;
  const age = (o.now - Math.max(o.at, o.touched ?? 0)) / DAY;
  const c = byAge(imp, age);
  // 原话和纠错至少留一句话
  if ((o.kind === "said" || o.kind === "correction") && c !== "full") return "gist";
  return c;
}

/** 一件事本身多清楚：full = 总结，gist = 一句话，title = 只剩名字；hidden = 不再被想起（只在按时间段翻、搜原话时出现） */
export function eventClarity(importance: number, pinned: boolean, lastActive: number, now: number): Clarity {
  return byAge(pinned ? 5 : importance, (now - lastActive) / DAY);
}
