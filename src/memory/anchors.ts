// 翻页压缩从主线会话分叉做的时候，主线眼前的记录每行没有编号：压缩稿每条末尾抄两小段原话当锚点
// 〔锚：A｜B〕（A 是这件事最早那条记录里的原话，B 是最晚那条的），这里拿去跟这一页的原始记录逐条比对，
// 找到是哪几条，换成连续的编号范围（#lo–#hi），她看到的压缩记忆和以前一样带编号（缩小的记忆都要能翻出原样）。
import type { Entry } from "./central.ts";
import { SELF_TOOLS, SYNC_ACT_CHARS } from "./central.ts";
import { B } from "../lang/index.ts";

// The anchor as the compaction writes it is B.forms.anchor (either kind of bracket, closed by its own kind, never across
// lines: a missing right bracket does not swallow the items below); B.forms.anchorBroken is one left unfinished
/** The head of a resolved anchor (as B.anchors.anchorResolved… write it): the last cut finds it, drops the spaces before it and puts it back */
const ANCHOR_HEAD = "（#";
/** 去掉空白：原话跨行、她抄的时候换了空格都不影响 */
const squash = (s: string): string => s.replace(/\s+/gu, "");
/** 再去掉标点和符号：第二轮宽一点的比对（引号、逗号抄得不一样） */
const bare = (s: string): string => s.replace(/[\s\p{P}\p{S}]+/gu, "");
/** 锚点去掉标点以后至少这么长才比（太短的会到处命中；要求她抄 8–20 字） */
const MIN_ANCHOR = 6;
/** 只写了一段、在好几条里出现：都挨在一起（发出去的消息和「发给主人」那条笔记）才算数，隔得远就是对不上 */
const NEAR = 20;
/** 删掉这一行的记号（整条落在上一页的条目） */
const DROP = "\u0000DROP\u0000";

/**
 * 一条记录里她当时看得到、可能抄到的字。viewer 自己的记录原样（工具调用把参数里的字符串拼起来：发出去的消息、记下的笔记都在参数里）；
 * 别人的工具结果她只看到折起来的一行（不比），别人的工具调用只看到前 SYNC_ACT_CHARS 字
 */
function searchable(e: Entry, viewer: string | undefined): string {
  const own = viewer === undefined || e.src === viewer;
  if (!own && e.kind === "result") return "";
  let t = e.text;
  if (e.kind === "act") {
    const sp = e.text.indexOf(" ");
    if (sp >= 0) {
      try {
        const vals: string[] = [];
        const walk = (x: unknown): void => {
          if (typeof x === "string") vals.push(x);
          else if (Array.isArray(x)) x.forEach(walk);
          else if (x && typeof x === "object") Object.values(x).forEach(walk);
        };
        walk(JSON.parse(e.text.slice(sp + 1)));
        t = `${e.text.slice(0, sp)} ${vals.join(" ")}`;
      } catch { /* 不是 JSON 参数：用原文 */ }
    }
    // 别人的工具调用：说话、记笔记这类她自己的工具按条数上限给她看，别的只看前 SYNC_ACT_CHARS 字（照 renderMemory 的 sync 视角，复核 #4）
    if (!own) t = t.slice(0, SELF_TOOLS.has(String(e.meta?.tool ?? "")) ? SELF_ACT_CHARS : SYNC_ACT_CHARS);
  }
  return t;
}
/** 别人的说话、记笔记这类工具，她眼前最多看到多少字（主线 maxItemChars 的默认值） */
const SELF_ACT_CHARS = 1_500;

export interface AnchorStats {
  /** 写了锚点的条目数 */
  anchored: number;
  /** 换出编号的条目数 */
  resolved: number;
  /** 只有一段、在好几处隔得很远地出现，或者范围大得不像一件事：当成对不上 */
  ambiguous: number;
  /** 整条落在上一页（已经压过）的条目，删掉了 */
  dropped: number;
  /** 锚点没找到的那几段（日志用，最多 10 段） */
  missing: string[];
  /** 当成对不上的那几段和为什么（日志用，最多 10 段：查覆盖率为什么掉） */
  ambiguousWhy: string[];
}

export interface AnchorOpts {
  /** 她是谁：别人的记录只按她当时看到的样子比（见 searchable）；不写 = 全文比 */
  viewer?: string;
  /** 这一页从哪条开始：整条落在它之前的（会话开头带着的上一页的尾巴，已经压过了）删掉 */
  pageFrom?: number;
}

/**
 * 把压缩稿里的锚点换成编号范围。entries 是比对的范围（这一页她看得到的记录，按 seq 排好；可以带着上一页的尾巴，配合 pageFrom 删掉重复压的）。
 * 两段都找到：取挨得最近的一对（A 在前、B 在后，B − A 最小）。只找到一段：只出现一次，或者几次都挨在一起，才算。
 * 范围里的工具调用把结果也带上。范围大到超过这一页的四成（至少 300 条）也当成对不上。
 * 找不到、对不上的锚点直接去掉，那条就不带编号（交给调用方按比例判断）。
 */
export function resolveAnchors(text: string, entries: readonly Entry[], opts: AnchorOpts = {}): { text: string; stats: AnchorStats } {
  const rows = entries.map((e) => { const s = searchable(e, opts.viewer); return { e, sq: squash(s), bare: bare(s) }; });
  const resultOf = new Map<string, number>();
  for (const e of entries) if (e.kind === "result" && typeof e.meta?.id === "string") resultOf.set(e.meta.id, e.seq);
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  const span = entries.length ? entries[entries.length - 1]!.seq - entries[0]!.seq + 1 : 0;
  const cap = Math.max(300, Math.floor(span * 0.4));

  const find = (anchor: string): number[] => {
    const a1 = squash(anchor), a2 = bare(anchor);
    if (a2.length < MIN_ANCHOR) return [];
    const exact = rows.filter((r) => r.sq && r.sq.includes(a1)).map((r) => r.e.seq);
    return exact.length ? exact : rows.filter((r) => r.bare && r.bare.includes(a2)).map((r) => r.e.seq);
  };
  /** 两组命中里挨得最近的一对 x ≤ y（x 取自 xs、y 取自 ys）；x 前面紧挨着的同一段原话（发出去的消息和「发给主人」的笔记）也算进来 */
  const closest = (xs: number[], ys: number[]): [number, number] | null => {
    let best: [number, number] | null = null;
    for (const y of ys) {
      const x = Math.max(...xs.filter((v) => v <= y));
      if (Number.isFinite(x) && (!best || y - x < best[1] - best[0])) best = [x, y];
    }
    if (!best) return null;
    const [x, y] = best;
    return [Math.min(...xs.filter((v) => v >= x - NEAR && v <= x)), y];
  };

  const stats: AnchorStats = { anchored: 0, resolved: 0, ambiguous: 0, dropped: 0, missing: [], ambiguousWhy: [] };
  const replaced = text.replace(B.forms.anchor, (_m, a1: string | undefined, b1: string | undefined, a2: string | undefined, b2: string | undefined) => {
    const a = (a1 ?? a2 ?? "").trim();
    const b = (b1 ?? b2)?.trim();
    stats.anchored += 1;
    const ha = find(a);
    const hb = b ? find(b) : [];
    if (!ha.length && !hb.length) {
      if (stats.missing.length < 10) stats.missing.push(b ? B.anchors.anchorLabel(a, b) : a);
      return "";
    }
    let range: [number, number] | null;
    if (ha.length && hb.length) {
      range = closest(ha, hb) ?? closest(hb, ha);   // B 写在了 A 前面：对调着找
    } else {
      const h = ha.length ? ha : hb;
      range = Math.max(...h) - Math.min(...h) <= NEAR ? [Math.min(...h), Math.max(...h)] : null;
    }
    if (!range || range[1] - range[0] > cap) {
      stats.ambiguous += 1;
      if (stats.ambiguousWhy.length < 10) {
        const hits = (h: number[]): string => (h.length ? B.anchors.anchorHits(h.length, Math.min(...h), Math.max(...h)) : B.anchors.anchorHitsNone);
        stats.ambiguousWhy.push(B.anchors.ambiguousReason(b ? B.anchors.anchorLabelAtAmbiguous(a, b) : a, range ? B.anchors.ambiguousRangeTooWide(range[1] - range[0], cap) : B.anchors.ambiguousNoNearPair(hits(ha), hits(hb))));
      }
      return "";
    }
    const lo = range[0];
    let hi = range[1];
    // 范围里的工具调用，它的结果也带上（结果一般紧跟着；隔太远的不带）
    for (let s = lo; s <= range[1]; s++) {
      const x = bySeq.get(s);
      const rid = x?.kind === "act" && typeof x.meta?.id === "string" ? resultOf.get(x.meta.id) : undefined;
      if (rid !== undefined && rid > hi && rid <= range[1] + NEAR) hi = rid;
    }
    if (opts.pageFrom !== undefined && hi < opts.pageFrom) { stats.dropped += 1; return DROP; }
    stats.resolved += 1;
    return lo === hi ? B.anchors.anchorResolved(lo) : B.anchors.anchorResolvedRange(lo, hi);
  });
  // 删掉落在上一页的条目时，缩进在它下面的小条目一起删
  const kept: string[] = [];
  let dropIndent: number | null = null;
  for (const l of replaced.split("\n")) {
    const indent = l.length - l.trimStart().length;
    if (dropIndent !== null && l.trim() && indent > dropIndent) continue;
    dropIndent = null;
    if (l.includes(DROP)) { dropIndent = indent; continue; }
    kept.push(l);
  }
  const out = kept.join("\n")
    .replace(B.forms.anchorBroken, "")
    .replace(new RegExp(`[ \\t]+${ANCHOR_HEAD}`, "gu"), ANCHOR_HEAD)      // 锚点前面的空格
    .replace(/[ \t]+$/gmu, "");
  return { text: out, stats };
}
