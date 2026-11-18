// 按预算渲染：任何一次读取都不超过字数预算，每件事至少有标题（15.4）。
// 先给每件事最短的样子（标题），再按顺序往上加：总结或一句话 → 时间线（新到旧、按清晰度、放不下就降级）→ 关联。
// 重要度 5（和〔不淡〕）的事排最前；放不下的事归进「还有 N 件」。
import type { EventRow, EntryRow } from "./schema.ts";
import { clarity, eventClarity, staysClear } from "./fade.ts";
import type { Clarity } from "./fade.ts";
import { M } from "../../lang/index.ts";

export interface RenderEvent {
  ev: EventRow;
  /** 时间线，新的在前（可以含纠错条目，会和原条目绑在一起） */
  entries: EntryRow[];
  people: string[];
  links: Array<{ rel: string; id: string; title: string }>;
  /** 在哪聊的（「在阿青私聊里」） */
  origin?: string;
  /** 被线索命中的条目，优先放 */
  hits?: Set<string>;
  /** 属于哪件大事（父事件） */
  parent?: { id: string; title: string };
  /** 挂在下面的子事件 */
  children?: Array<{ id: string; title: string }>;
  /** 只写标题（这次已经给过的事，再提只为带出新的片段） */
  brief?: boolean;
  /** 不被挤掉（放不下时最后才挪走）；不写 = 重要度 5 的才这样 */
  keep?: boolean;
}

export interface RenderOpts {
  budget: number;
  now: number;
  tz: string;
  maxEvents: number;
  entriesPerEvent?: number;
  /** 最后一次让它变清楚的时间（展开、引用、新条目） */
  touched?: (ref: string) => number | null;
  /** 第一行（比如「想起来的（编号可以展开）：」），也算在预算里 */
  header?: string;
  /** 按给的顺序排（想起一串：相关的先）；不写 = 重要度 5 的排最前 */
  keepOrder?: boolean;
  /** 总是用一句话写事件（period、人物近况这类一行一件的） */
  compact?: boolean;
  /** 经过最多写到大意（联想：人记得的是大意，原样留给展开） */
  gistEntries?: boolean;
  /** 子事件那行最多列几件（默认 12） */
  maxChildren?: number;
  /** 子事件那行跟标题一起算一格，先于总结占预算（中期视图：子事件并进了大事那一格，那行没了它们就哪儿都看不到） */
  childrenFirst?: boolean;
  /** 放不下的事归进「还有 N 件」时，给那一行留这么多字列标题（不写 = 有多少剩多少，常常只剩「还有 N 件：…」） */
  overflowRoom?: number;
}

type Level = "title" | "gist" | "summary";
interface Line { id: string; text: string; levels: string[]; li: number; at: number }
interface Part {
  r: RenderEvent; tz: string; now: number; level: Level; maxLevel: Level;
  lines: Line[]; candidates: Line[]; linksLine: string | null; folded: { n: number; from: number; to: number } | null;
  /** 大事下面的子事件（一行）：比旧经过要紧，排在经过前面 */
  kidsLine: string | null;
}

export function fmtDay(t: number, tz: string): string {
  const p = parts(t, tz);
  return `${p.month}-${p.day}`;
}

/** 精确到半小时 */
export function fmtTime(t: number, tz: string): string {
  const p = parts(t, tz);
  const m = Number(p.minute) < 30 ? "00" : "30";
  return `${p.month}-${p.day} ${p.hour}:${m}`;
}

function parts(t: number, tz: string): Record<string, string> {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
}

function imp(ev: EventRow): number { return ev.pinned ? 5 : ev.importance; }
function kept(r: RenderEvent): boolean { return r.keep ?? imp(r.ev) >= 5; }

function stanceMark(e: EventRow): string {
  // 撤掉的（retired）是记错了、不算数，不是以前喜欢过：只留状态里的「不算数了」
  if (!e.stance || e.status === "retired") return "";
  const now = e.status === "ongoing";
  return e.stance === "like" ? (now ? M.render.likeNow : M.render.likedBefore) : now ? M.render.dislikeNow : M.render.dislikedBefore;
}

function headOf(p: Part, level: Level): string {
  const e = p.r.ev;
  const status: Record<string, string> = M.render.status;
  const meta = [status[e.status] ?? e.status, e.next_at && e.next_at > p.now - 86_400_000 ? M.render.next(fmtDay(e.next_at, p.tz)) : "", e.superseded_by ? M.render.supersededBy(e.superseded_by) : "", p.r.parent ? M.render.under(p.r.parent.title, p.r.parent.id) : "", p.r.people.length ? M.render.withPeople(p.r.people.slice(0, 4)) : "", p.r.origin ?? ""].filter(Boolean).join(M.render.metaSep);
  const base = `· ${e.title}${stanceMark(e)}〔${imp(e)}〕${e.id}（${meta}）`;
  if (level === "title") return base;
  return M.render.headWith(base, level === "summary" ? e.summary : e.gist);
}

/** 一条经过在某个清晰度下的写法；被纠正的和更正绑在一起 */
function entryText(n: EntryRow, c: Clarity, tz: string, fix?: EntryRow): string {
  const pick = (x: EntryRow) => (c === "full" ? x.full : c === "gist" ? x.gist : x.title);
  const datedSelf = c === "full" && /^(\d{4}-)?\d{1,2}-\d{1,2}\b/.test(n.full);   // 原文自己带日期就不重复
  const when = datedSelf ? "" : c === "full" ? fmtTime(n.at, tz) : fmtDay(n.at, tz);
  // 更正只改了出处、或这一层写出来一样：照常写一句（编号还是两个都带）
  if (fix && pick(n) === pick(fix)) return `  - ${when ? `${when} ` : ""}${pick(fix)}（${n.id}→${fix.id}）`;
  if (fix) return M.render.correctedLine(when || fmtDay(n.at, tz), pick(n), pick(fix), n.id, fix.id);
  return `  - ${when ? `${when} ` : ""}${pick(n)}（${n.id}）`;
}

const DOWN: Record<string, Clarity[]> = { full: ["full", "gist", "title"], gist: ["gist", "title"], title: ["title"] };

function total(header: string | undefined, ps: Part[], overflow: string): number {
  let n = header ? header.length + 1 : 0;
  for (const p of ps) {
    n += headOf(p, p.level).length + 1;
    for (const l of p.lines) n += l.levels[l.li]!.length + 1;
    if (p.folded) n += foldLine(p).length + 1;
    if (p.linksLine) n += p.linksLine.length + 1;
    if (p.kidsLine) n += p.kidsLine.length + 1;
  }
  return n + (overflow ? overflow.length + 1 : 0);
}

function foldLine(p: Part): string {
  const f = p.folded!;
  const x = fmtDay(f.from, p.tz), y = fmtDay(f.to, p.tz);
  return M.render.folded(f.n, x, y, p.r.ev.id);
}

function overflowLine(rest: Part[], room: number): string {
  if (!rest.length) return "";
  const head = M.render.overflowHead(rest.length);
  let s = head;
  for (const [i, p] of rest.entries()) {
    const item = `${i ? M.render.overflowSep : ""}${p.r.ev.title} ${p.r.ev.id}`;
    if (s.length + item.length + 1 > room) return M.render.overflowCut(s);
    s += item;
  }
  return s;
}

export function renderEvents(list: RenderEvent[], o: RenderOpts): string {
  const touched = o.touched ?? (() => null);
  const ordered = o.keepOrder ? [...list] : [...list.filter((r) => imp(r.ev) >= 5), ...list.filter((r) => imp(r.ev) < 5)];
  const per = o.entriesPerEvent ?? 3;
  const all: Part[] = ordered.map((r) => {
    const lastActive = Math.max(r.ev.ended_at ?? r.ev.created_at, touched(r.ev.id) ?? 0);
    const ec = eventClarity(r.ev.importance, staysClear(r.ev), lastActive, o.now);
    const maxLevel: Level = r.brief ? "title" : o.compact ? "gist" : ec === "full" ? "summary" : ec === "gist" ? "gist" : "title";
    // 时间线候选：命中的先，其余新到旧；纠错条目绑到原条目上
    const fixes = new Map<string, EntryRow>();
    for (const n of r.entries) if (n.kind === "correction" && n.corrects) {
      const prev = fixes.get(n.corrects);
      if (!prev || prev.created_at < n.created_at) fixes.set(n.corrects, n);
    }
    const ids = new Set(r.entries.map((n) => n.id));
    const base = r.entries.filter((n) => !(n.kind === "correction" && n.corrects && ids.has(n.corrects)));
    const visible = base.filter((n) => {
      const fix = fixes.get(n.id);
      const c = clarity({ importance: r.ev.importance, pinned: staysClear(r.ev), kind: fix ? "correction" : n.kind, at: n.at, touched: touched(n.id), now: o.now });
      return c !== "fold" && c !== "hidden";
    });
    const hits = r.hits ?? new Set<string>();
    const sorted = [...visible.filter((n) => hits.has(n.id)), ...visible.filter((n) => !hits.has(n.id))];
    const candidates: Line[] = sorted.map((n) => {
      const fix = fixes.get(n.id);
      const c0 = clarity({ importance: r.ev.importance, pinned: staysClear(r.ev), kind: fix ? "correction" : n.kind, at: n.at, touched: touched(n.id), now: o.now });
      const c = o.gistEntries && c0 === "full" ? "gist" : c0;
      return { id: n.id, at: n.at, levels: DOWN[c]!.map((cc) => entryText(n, cc as Clarity, o.tz, fix)), li: 0, text: "" };
    });
    const kids = r.children ?? [];
    const maxKids = o.maxChildren ?? 12;
    const kidsLine = kids.length ? M.render.children(kids.length, kids.slice(0, maxKids).map((c) => `${c.title} ${c.id}`), kids.length > maxKids) : null;
    const rel: Record<string, string> = M.render.rel;
    const relLine = r.links.length ? M.render.links(r.links.slice(0, 4).map((l) => `${rel[l.rel] ?? l.rel} ${l.id} ${l.title}`)) : null;
    return { r, tz: o.tz, now: o.now, level: "title", maxLevel, lines: [], candidates, linksLine: null, kidsLine: o.childrenFirst ? kidsLine : null, folded: null, _links: relLine, _kids: kidsLine } as Part & { _links: string | null; _kids: string | null };
  });

  // 1) 每件事先给标题；放不下的事归进「还有 N 件」（写了 keep 的超过件数也留着）
  let shown = all.filter((p, i) => i < o.maxEvents || p.r.keep === true);
  let rest = all.filter((p, i) => !(i < o.maxEvents || p.r.keep === true));
  const reserve = (n: number) => (o.overflowRoom ? (n ? "还".repeat(o.overflowRoom) : "") : M.render.overflowReserve(n + 1));
  while (shown.length > 1 && total(o.header, shown, reserve(rest.length)) > o.budget) {
    // 放不下时先挪走排在后面的非核心事（重要度 5 尽量留着）
    let i = shown.length - 1;
    while (i > 0 && kept(shown[i]!.r)) i -= 1;
    if (i === 0 && kept(shown[0]!.r)) i = shown.length - 1;
    rest = [shown.splice(i, 1)[0]!, ...rest];
    if (o.overflowRoom) rest.sort((a, b) => all.indexOf(a) - all.indexOf(b));
  }
  const room = () => Math.max(0, o.budget - total(o.header, shown, "") - 1);
  // 留了位置：「还有 N 件」那行现在定下来，后面加总结、经过都不挤它
  const fixedOver = o.overflowRoom && rest.length ? overflowLine(rest, Math.min(o.overflowRoom, room())) : null;
  const over = () => fixedOver ?? overflowLine(rest, room());
  const ok = () => total(o.header, shown, over()) <= o.budget;

  // 2) 总结或一句话
  for (const p of shown) {
    for (const lv of (p.maxLevel === "summary" ? ["summary", "gist"] : p.maxLevel === "gist" ? ["gist"] : []) as Level[]) {
      const prev = p.level;
      p.level = lv;
      if (ok()) break;
      p.level = prev;
    }
  }
  // 2b) 子事件：大事拆成了哪几段，比旧经过要紧，先占预算
  if (!o.childrenFirst) for (const p of shown) {
    p.kidsLine = (p as Part & { _kids: string | null })._kids;
    if (p.kidsLine && !ok()) p.kidsLine = null;
  }
  // 3) 时间线：每件事轮流加一条（重要的先），放不下就降级，最后把剩下的折叠
  for (let round = 0; round < per; round++) {
    for (const p of shown) {
      const c = p.candidates[round];
      if (!c) continue;
      p.lines.push(c);
      const restAfter = p.candidates.slice(round + 1);
      p.folded = restAfter.length ? { n: restAfter.length, from: Math.min(...restAfter.map((x) => x.at)), to: Math.max(...restAfter.map((x) => x.at)) } : null;
      let placed = false;
      for (let li = 0; li < c.levels.length; li++) {
        c.li = li;
        if (ok()) { placed = true; break; }
      }
      if (!placed) {
        p.lines.pop();
        const remain = p.candidates.slice(round);
        p.folded = { n: remain.length, from: Math.min(...remain.map((x) => x.at)), to: Math.max(...remain.map((x) => x.at)) };
        if (!ok()) p.folded = null;
        p.candidates = p.candidates.slice(0, round);   // 这件事不再往下加
      }
    }
  }
  for (const p of shown) {
    if (!p.lines.length && p.candidates.length && !p.folded) {
      p.folded = { n: p.candidates.length, from: Math.min(...p.candidates.map((x) => x.at)), to: Math.max(...p.candidates.map((x) => x.at)) };
      if (!ok()) p.folded = null;
    }
    if (p.lines.length >= per && p.candidates.length > per && !p.folded) {
      const remain = p.candidates.slice(per);
      p.folded = { n: remain.length, from: Math.min(...remain.map((x) => x.at)), to: Math.max(...remain.map((x) => x.at)) };
      if (!ok()) p.folded = null;
    }
  }
  // 4) 关联
  for (const p of shown) {
    p.linksLine = (p as Part & { _links: string | null })._links;
    if (p.linksLine && !ok()) p.linksLine = null;
  }

  const out: string[] = [];
  if (o.header) out.push(o.header);
  for (const p of shown) {
    out.push(headOf(p, p.level));
    if (p.kidsLine) out.push(p.kidsLine);
    for (const l of p.lines) out.push(l.levels[l.li]!);
    if (p.folded) out.push(foldLine(p));
    if (p.linksLine) out.push(p.linksLine);
  }
  const ov = over();
  if (ov) out.push(ov);
  let text = out.join("\n");
  if (text.length > o.budget) text = text.slice(0, Math.max(0, o.budget - 1)) + M.render.cut;   // 兜底（标题本身就超长时）
  return text;
}
