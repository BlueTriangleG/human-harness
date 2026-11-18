// 五种取法（联想和工具共用）：想起一串 cluster、一个人最近的 person、展开一件事 event、按时间段翻 period、反查 reverse；
// 加上自动联想 associate（每次叫醒主线时用，阈值更严、预算 600 字）。
import type { EventStore } from "./store.ts";
import type { MemIndex, Hit } from "./index.ts";
import type { EntityRow, EventRow, EntryRow } from "./schema.ts";
import { localToUtc, tzOffset } from "./schema.ts";
import { renderEvents, fmtDay, fmtTime } from "./render.ts";
import type { RenderEvent } from "./render.ts";
import { eventClarity, staysClear } from "./fade.ts";
import { cardPath, cardSections } from "./people.ts";
import { all, one } from "../../store/db.ts";
import { B, M, N, fromEveryPack } from "../../lang/index.ts";

const DAY = 86_400_000;
const CHAIN = new Set(["same_thread", "followup", "cause"]);
/** 联想时线索转向量最多等多久：超时就只剩全文，联想的门槛又不认单独的全文命中 */
const ASSOCIATE_EMBED_MS = 1500;
/**
 * 联想里片段（条目、事件）要多像这句话才算想起来。11-01 拿 10-31 的真实联想校准：
 * 0.56 以上基本对题；0.48–0.55 一半是擦边（「你说两句话发我试试」→ 派副线 0.55）；0.45 以下多半不沾边。
 */
export const MOMENT_COS = 0.56;
/** 全文也命中（或者话里有它的词）时放宽到这里；只有一个词一样、意思不沾边的不算（「嗯嗯」；11-01 线上「哈哈，好玩…玩俩梗」→ 新嗓子 0.48） */
const MOMENT_WORD_COS = 0.5;
/** 排序：越像越前；重要度只是小加分，被想起过多少次不算（不然常被想起的大事越想越靠前） */
const MOMENT_IMPORTANCE = 0.02;
const MOMENT_NAMED = 0.2;
const MOMENT_EVENTS = 3;
const MOMENTS_PER_EVENT = 2;
/** 陪着片段的那句原话：要很像（原话短，相似度普遍高），而且是一天以前的（一天内的多半还在她眼前） */
const QUOTE_COS = 0.6;
const QUOTE_MIN_AGE = DAY;
/** 他那句原话之后多久以内她回他的话，算「我当时怎么说的」 */
const REPLY_WINDOW_MS = 30 * 60_000;
/** 这些人不参与"沿人扩展"（几乎每件事都有他们） */
const self = (): string[] => [N.owner.toLowerCase(), N.me.toLowerCase(), ...fromEveryPack((p) => p.brain.common.self.toLowerCase())];

export interface Range { from: number; to: number }
export interface ClusterOpts { budget?: number; maxEvents?: number; who?: string; from?: number; to?: number; exclude?: Set<string>; region?: string; header?: string; timeoutMs?: number; /** false = 只是算一算（对比模式），没给她看，不算碰过 */ touch?: boolean }

export class EventRecall {
  readonly store: EventStore;
  readonly index: MemIndex;
  private readonly now: () => number;
  readonly tz: string;

  constructor(o: { store: EventStore; index: MemIndex; now: () => number; tz: string }) {
    this.store = o.store;
    this.index = o.index;
    this.now = o.now;
    this.tz = o.tz;
  }

  private touched = (ref: string): number | null => this.store.lastTouched(ref);

  /** 一件事打包成渲染用的样子；entries 新到旧 */
  pack(id: string, o: { hits?: Set<string>; entries?: EntryRow[] } = {}): RenderEvent | null {
    const ev = this.store.event(id);
    if (!ev) return null;
    const links = this.store.links(id).map((l) => {
      const other = l.a === id ? l.b : l.a;
      const rel = l.rel === "cause" && l.b === id ? "cause" : l.rel === "cause" ? "followup" : l.rel === "followup" && l.b === id ? "cause" : l.rel;
      return { rel, id: other, title: this.store.event(other)?.title ?? "" };
    });
    const parent = ev.parent ? this.store.event(ev.parent) : undefined;
    const children = this.store.children(id).map((c) => ({ id: c.id, title: c.title }));
    return {
      ev, entries: o.entries ?? this.store.entries(id).reverse(), people: this.store.peopleOf(id), links, ...(o.hits ? { hits: o.hits } : {}),
      ...(parent ? { parent: { id: parent.id, title: parent.title } } : {}), ...(children.length ? { children } : {}),
    };
  }

  private lastActive(ev: EventRow): number {
    return Math.max(ev.ended_at ?? ev.created_at, this.touched(ev.id) ?? 0);
  }

  private visible(ev: EventRow): boolean {
    return eventClarity(ev.importance, staysClear(ev), this.lastActive(ev), this.now()) !== "hidden";
  }

  // ---------- 想起一串 ----------
  async cluster(cue: string, o: ClusterOpts = {}): Promise<string> {
    return (await this.clusterRaw(cue, o)).text;
  }

  async clusterRaw(cue: string, o: ClusterOpts = {}): Promise<{ text: string; events: string[] }> {
    const budget = o.budget ?? 2000;
    const maxEvents = o.maxEvents ?? 8;
    const hits = await this.index.search(cue, { limit: 40, ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
    const scores = new Map<string, number>();
    const hitEntries = new Map<string, Set<string>>();
    const matched = new Set<string>();   // 真被搜到的（不只是提到了同一个人）
    const quotes: Hit[] = [];
    for (const h of hits) {
      if (!h.fts && (h.cos ?? 0) < 0.3) continue;
      if (h.ref.startsWith("q")) { quotes.push(h); continue; }
      const eid = h.ref.startsWith("e") ? h.ref : this.store.entry(h.ref)?.event_id;
      if (!eid) continue;
      matched.add(eid);
      scores.set(eid, Math.max(scores.get(eid) ?? 0, h.score * (h.exact ? 1.5 : 1)));
      if (h.ref.startsWith("n")) hitEntries.set(eid, (hitEntries.get(eid) ?? new Set()).add(h.ref));
    }
    // 线索里提到的人和东西（按稀有度加权）
    for (const t of this.mentioned(cue)) {
      const evs = this.store.eventsOf(t.id);
      const w = 0.02 / Math.log2(2 + evs.length);
      for (const e of evs) scores.set(e.id, (scores.get(e.id) ?? 0) + w);
    }
    // 时间线索：「昨天」「10-20」…
    // 明确给的时间段才筛选；线索里的时间词（「今天又想起…」）只加分
    const range = o.from || o.to ? { from: o.from ?? 0, to: o.to ?? this.now() } : null;
    const cueRange = parseRange(cue, this.now(), this.tz);
    const whoEnt = o.who ? this.store.entity(o.who) : undefined;
    const whoEvents = whoEnt ? new Set(this.store.eventsOf(whoEnt.id).map((e) => e.id)) : null;
    if (cueRange) for (const e of this.eventsIn(cueRange)) scores.set(e.id, (scores.get(e.id) ?? 0) + 0.01);

    const ranked = [...scores.entries()]
      .map(([id, rel]) => ({ ev: this.store.event(id)!, rel }))
      .filter((x) => x.ev && this.visible(x.ev) && (!whoEvents || whoEvents.has(x.ev.id)) && !o.exclude?.has(x.ev.id))
      .filter((x) => !range || this.overlaps(x.ev, range))
      .map((x) => ({ ...x, score: this.score(x.ev, x.rel) }))
      .sort((a, b) => b.score - a.score);
    // 顺关联、沿稀有的人扩一步
    const picked = new Map(ranked.slice(0, maxEvents).map((x) => [x.ev.id, x.score]));
    for (const seed of ranked.slice(0, 3)) {
      for (const l of this.store.links(seed.ev.id)) {
        const other = l.a === seed.ev.id ? l.b : l.a;
        const oe = this.store.event(other);
        if (oe && !picked.has(other) && this.visible(oe) && !o.exclude?.has(other)) picked.set(other, seed.score * 0.6);
      }
      for (const t of this.store.entitiesOf(seed.ev.id)) {
        if (self().includes(t.name.toLowerCase()) || self().includes((t.person_key ?? "").toLowerCase())) continue;
        const evs = this.store.eventsOf(t.id);
        if (evs.length > 12) continue;
        for (const oe of evs) {
          const near = Math.abs((oe.ended_at ?? 0) - (seed.ev.ended_at ?? 0)) < 7 * DAY;
          if (!picked.has(oe.id) && (oe.importance >= 3 || near) && this.visible(oe) && !o.exclude?.has(oe.id)) picked.set(oe.id, seed.score * 0.3);
        }
      }
    }
    const order = this.chains([...picked.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)).slice(0, maxEvents + 4);
    // 真搜到了、这次列不下的：进「还有 N 件」（只给标题和编号），不悄悄丢掉
    for (const x of ranked) if (matched.has(x.ev.id) && !order.includes(x.ev.id)) order.push(x.ev.id);
    if (!order.length && !quotes.length) return { text: "", events: [] };

    // 同样的话只翻一条
    const seenText = new Set<string>();
    const usable = quotes.filter((h) => {
      const q = this.index.quote(h.ref);
      if (!q) return false;
      const k = norm(q.text);
      if (seenText.has(k)) return false;
      seenText.add(k);
      return true;
    });
    const quoteLines = usable.slice(0, 3).map((h) => this.quoteLine(h.ref)).filter(Boolean) as string[];
    const quoteChars = quoteLines.reduce((n, l) => n + l.length + 1, 0);
    const evBudget = order.length ? Math.max(budget - Math.min(quoteChars, Math.floor(budget * 0.3)), Math.floor(budget * 0.6)) : 0;
    const packs = order.map((id) => this.pack(id, { hits: hitEntries.get(id) ?? new Set() })).filter(Boolean) as RenderEvent[];
    let text = packs.length ? renderEvents(packs, { budget: evBudget, now: this.now(), tz: this.tz, maxEvents, keepOrder: true, touched: this.touched, ...(o.header ? { header: o.header } : {}) }) : (o.header ?? "");
    for (const l of quoteLines) if (text.length + l.length + 1 <= budget) text += `${text ? "\n" : ""}${l}`;
    const shown = packs.map((p) => p.ev.id).filter((id) => text.includes(`${id}（`));
    if (o.touch !== false) for (const id of shown) this.store.touch(id, "recall", o.region ?? "");
    return { text, events: shown };
  }

  /** 相关度 × (0.6 + 0.1 × 重要度) × 新近度 × 热度；失效、被替换的降权 */
  private score(ev: EventRow, rel: number): number {
    const imp = ev.pinned ? 5 : ev.importance;
    const age = (this.now() - this.lastActive(ev)) / DAY;
    const recency = imp >= 5 ? 1 : 1 / (1 + age / 30);
    const heat = 1 + 0.1 * Math.log(1 + this.store.touchCount(ev.id));
    const dead = ev.status === "superseded" || ev.status === "retired" ? 0.5 : 1;
    return rel * (0.6 + 0.1 * imp) * recency * heat * dead;
  }

  /** 同一串（同一件事、后续、起因）的放在一起，按时间排 */
  private chains(ids: string[]): string[] {
    const set = new Set(ids);
    const seen = new Set<string>();
    const out: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      const group: string[] = [];
      const stack = [id];
      while (stack.length) {
        const x = stack.pop()!;
        if (seen.has(x) || !set.has(x)) continue;
        seen.add(x);
        group.push(x);
        for (const l of this.store.links(x)) if (CHAIN.has(l.rel)) stack.push(l.a === x ? l.b : l.a);
      }
      group.sort((a, b) => (this.store.event(a)?.started_at ?? 0) - (this.store.event(b)?.started_at ?? 0));
      // 一串里最新的放前面（最相关的那串先出）
      out.push(...group.reverse());
    }
    return out;
  }

  private mentioned(cue: string) {
    const c = cue.toLowerCase();
    return this.store.entities().filter((t) => [t.name, ...t.aliases].some((n) => [...n].length >= 2 && c.includes(n.toLowerCase())));
  }

  private overlaps(ev: EventRow, r: Range): boolean {
    if (ev.started_at === null) return ev.created_at >= r.from && ev.created_at <= r.to;
    return ev.started_at <= r.to && (ev.ended_at ?? ev.started_at) >= r.from;
  }

  private eventsIn(r: Range): EventRow[] {
    return all<EventRow>(this.store.db, `
      SELECT * FROM mem_event WHERE (started_at <= ? AND COALESCE(ended_at, started_at) >= ?)
        OR id IN (SELECT event_id FROM mem_entry WHERE at BETWEEN ? AND ?)
      ORDER BY started_at`, r.to, r.from, r.from, r.to);
  }

  quoteLine(ref: string): string | null {
    const q = this.index.quote(ref);
    if (!q) return null;
    const text = q.text.length > 120 ? q.text.slice(0, 120) + M.recall.quoteCut : q.text;
    return M.recall.quoteLine(fmtDay(q.at, this.tz), q.who, q.channel, text, ref);
  }

  // ---------- 一个人最近的 ----------
  /**
   * card：前面先放这个人的卡——只有公开的那一面（recall_person 不知道是谁在看），最多占 budget 的一半，放不下的段整段不给；
   * 主人只给一行指路（他的卡在前缀里）；不出卡、公开的一面是空的就只有事。联想（associate）不带卡。
   */
  person(who: string, n = 5, budget = 1500, o: { exclude?: Set<string>; auto?: boolean; touch?: boolean; card?: boolean } = {}): string {
    const t = this.store.entity(who);
    if (!t) return M.recall.personUnknown(who);
    const head = o.card ? this.cardHead(t, Math.floor(budget / 2)) : "";
    if (head) return `${head}\n${this.person(who, n, budget - head.length - 1, { ...o, card: false })}`;
    const entries = this.store.entriesOf(t.id, 300);
    const byEvent = new Map<string, EntryRow[]>();
    for (const e of entries) byEvent.set(e.event_id, [...(byEvent.get(e.event_id) ?? []), e]);
    // 事件上标了但时间线里没写到他的，排在后面
    for (const ev of this.store.eventsOf(t.id)) if (!byEvent.has(ev.id)) byEvent.set(ev.id, []);
    // 自己冒出来的（auto）不带不算数了的事；她主动翻照样列
    const ids = [...byEvent.keys()].filter((id) => { const e = this.store.event(id); return e && this.visible(e) && !(o.auto && e.status === "retired") && !o.exclude?.has(id); }).slice(0, n);
    if (!ids.length) return M.recall.personNothing(t.name);
    const packs = ids.map((id) => {
      const mine = byEvent.get(id)!;
      return this.pack(id, mine.length ? { entries: mine } : {});
    }).filter(Boolean) as RenderEvent[];
    if (o.touch !== false) for (const id of ids) this.store.touch(id, o.auto ? "auto" : "recall");
    return renderEvents(packs, { budget, now: this.now(), tz: this.tz, maxEvents: n, entriesPerEvent: 3, touched: this.touched, header: M.recall.personHeader(t.name) });
  }

  /**
   * recall_person 开头那一段：主人一行指路；别人是公开的卡，放不下 max 字的段整段跳过（后面放得下的照放），跳过了就在末尾说一声。
   * 卡文件只有存着字段或钉了原话的才有（别人的卡文件不带现算段，R35）：只有现算段的不指文件。
   * 没有卡（不出卡、公开的一面是空的）是空字符串
   */
  private cardHead(t: EntityRow, max: number): string {
    if (this.store.isOwner(t)) return M.recall.ownerCardPointer(t.name);
    const secs = cardSections(this.store, t, { viewer: null, now: this.now(), tz: this.tz });
    if (!secs.length) return "";
    const file = this.store.impressions(t.id).length ? M.recall.cardFile(cardPath(t)) : "";
    const intro = M.recall.cardIntro(t.name, file);
    const whole = `${intro}\n${secs.join("\n\n")}`;
    if (whole.length <= max) return whole;
    const kept: string[] = [];
    let used = intro.length + 1 + M.recall.cardCut.length;
    for (const sec of secs) {
      const add = sec.length + (kept.length ? 2 : 1);
      if (used + add <= max) { kept.push(sec); used += add; }
    }
    return `${intro}\n${kept.length ? `${kept.join("\n\n")}\n` : ""}${M.recall.cardCut}`;
  }

  // ---------- 展开一件事 ----------
  event(ref: string, o: { from?: number; to?: number; budget?: number; quoteBudget?: number; region?: string; touch?: boolean; /** false：展开了也不算让它变清楚（潜意识翻的） */ clearing?: boolean } = {}): string {
    const r = ref.trim();
    let id: string | undefined;
    let focus: string | undefined;
    if (/^e\d{4,}$/.test(r)) id = r;
    else if (/^n\d{5,}$/.test(r)) { focus = r; id = this.store.entry(r)?.event_id; }
    else if (/^q\d+$/.test(r)) return this.quoteContext(r);
    else if (/^(?:#|c:)\d+$/.test(r)) return this.centralContext(r.replace(/^(?:#|c:)/, ""));
    else {
      const cands = this.findByTitle(r);
      if (cands.length === 1) id = cands[0]!.id;
      else if (cands.length > 1) {
        return M.recall.candidates(cands.slice(0, 5).map((e) => M.recall.candidateLine(e.title, e.importance, e.id, e.gist)), cands[0]!.id);
      }
    }
    const ev = id ? this.store.event(id) : undefined;
    if (!ev) return M.recall.noSuchEvent(r);
    const budget = o.budget ?? 3000;
    const quoteBudget = o.quoteBudget ?? 1000;
    let entries = this.store.entries(ev.id).reverse();
    if (o.from !== undefined || o.to !== undefined) entries = entries.filter((e) => e.at >= (o.from ?? 0) && e.at <= (o.to ?? Infinity));
    const pack = this.pack(ev.id, { entries, ...(focus ? { hits: new Set([focus]) } : {}) })!;
    const head = `${focus ? M.recall.focused(focus) : ""}`;
    let text = head + renderEvents([pack], { budget: budget - head.length, now: this.now(), tz: this.tz, maxEvents: 1, entriesPerEvent: 1000, touched: this.touched });
    // 出处原话：显示出来的经过里引用的原话
    const shownIds = entries.filter((e) => text.includes(`（${e.id}`) || text.includes(`${e.id}）`) || text.includes(`→${e.id}`)).map((e) => e.id);
    const srcLines: string[] = [];
    let used = 0;
    for (const e of entries) {
      if (!shownIds.includes(e.id)) continue;
      for (const s of JSON.parse(e.source) as string[]) {
        const line = this.sourceLine(s);
        if (!line || srcLines.includes(line)) continue;
        if (used + line.length + 1 > quoteBudget) break;
        srcLines.push(line);
        used += line.length + 1;
      }
    }
    if (srcLines.length) text += M.recall.sources(srcLines);
    // 展开 = 碰过：这件事和看到的经过都重新变清楚（主人在命令行翻看不算）
    if (o.touch === false) return text;
    const how = o.clearing === false ? "recall" : "open";
    this.store.touch(ev.id, how, o.region ?? "");
    for (const n of shownIds) this.store.touch(n, how, o.region ?? "");
    return text;
  }

  private findByTitle(q: string): EventRow[] {
    const evs = this.store.allEvents();
    const exact = evs.filter((e) => e.title === q);
    if (exact.length) return exact;
    const contains = evs.filter((e) => e.title.includes(q) || q.includes(e.title));
    // 最像的在前：标题和说的这几个字长度越接近越像；一样像的，最近的在前
    const close = (t: string) => { const a = [...t].length, b = [...q].length; return Math.min(a, b) / Math.max(a, b); };
    if (contains.length) return contains.sort((a, b) => close(b.title) - close(a.title) || (b.ended_at ?? 0) - (a.ended_at ?? 0));
    const rows = this.index.fts(q, 20).filter((h) => h.ref.startsWith("e")).map((h) => this.store.event(h.ref)).filter(Boolean) as EventRow[];
    return rows;
  }

  private sourceLine(s: string): string | null {
    const c = /^c:(\d+)$/.exec(s);
    if (c) {
      const q = one<{ id: number }>(this.store.db, "SELECT id FROM mem_quote WHERE src = 'central' AND ref = ?", c[1]!);
      if (q) return this.quoteLine(`q${q.id}`);
      const row = one<{ ts: number; text: string }>(this.store.db, "SELECT ts, text FROM central WHERE seq = ?", Number(c[1]));
      return row ? M.recall.centralLine(fmtTime(row.ts, this.tz), row.text.slice(0, 160), c[1]!) : null;
    }
    if (/^q\d+$/.test(s)) return this.quoteLine(s);
    return null;
  }

  /** #N：中央记忆第 N 条（压缩块、折叠行里的编号）；在原话层里就按原话给，记在哪件事也说 */
  private centralContext(seq: string): string {
    const q = one<{ id: number }>(this.store.db, "SELECT id FROM mem_quote WHERE src = 'central' AND ref = ?", seq);
    const line = q ? this.quoteLine(`q${q.id}`) : this.sourceLine(`c:${seq}`);
    if (!line) return M.recall.noCentral(seq);
    const used = all<{ id: string; event_id: string }>(this.store.db, "SELECT id, event_id FROM mem_entry WHERE source LIKE ? OR source LIKE ?", `%"c:${seq}"%`, q ? `%"q${q.id}"%` : "\u0000");
    return `${line}${used.length ? M.recall.centralUsedIn(used.map((u) => M.recall.centralUsedItem(u.event_id, u.id))) : ""}`;
  }

  private quoteContext(ref: string): string {
    const line = this.quoteLine(ref);
    if (!line) return M.recall.noQuote(ref);
    const used = all<{ id: string; event_id: string }>(this.store.db, "SELECT id, event_id FROM mem_entry WHERE source LIKE ?", `%"${ref}"%`);
    return `${line}${used.length ? M.recall.quoteUsedIn(used.map((u) => M.recall.quoteUsedItem(u.event_id, u.id))) : ""}`;
  }

  // ---------- 按时间段翻 ----------
  period(range: Range, o: { who?: string; minImportance?: number; page?: number; weekly?: boolean; pageChars?: number } = {}): string {
    let evs = this.eventsIn(range);
    if (o.who) {
      const t = this.store.entity(o.who);
      if (!t) return M.recall.periodUnknown(o.who);
      const mine = new Set(this.store.eventsOf(t.id).map((e) => e.id));
      evs = evs.filter((e) => mine.has(e.id));
    }
    if (o.minImportance !== undefined) evs = evs.filter((e) => e.importance >= o.minImportance!);
    const span = M.recall.span(fmtDay(range.from, this.tz), fmtDay(range.to, this.tz));
    if (!evs.length) return M.recall.periodEmpty(span);
    // 每件事在这段时间里的第一条经过的时间
    const firstIn = (e: EventRow) => one<{ t: number | null }>(this.store.db, "SELECT min(at) t FROM mem_entry WHERE event_id = ? AND at BETWEEN ? AND ?", e.id, range.from, range.to)?.t ?? e.started_at ?? e.created_at;
    const items = evs.map((e) => ({ e, t: firstIn(e) })).sort((a, b) => a.t - b.t);
    const weekly = o.weekly ?? range.to - range.from > 21 * DAY;
    let lines: string[];
    if (weekly) {
      const weeks = new Map<number, typeof items>();
      for (const it of items) {
        const k = Math.floor((it.t - range.from) / (7 * DAY));
        weeks.set(k, [...(weeks.get(k) ?? []), it]);
      }
      lines = [M.recall.weeklyHead(span)];
      for (const [k, list] of weeks) {
        const a = range.from + k * 7 * DAY;
        lines.push(M.recall.weekLine(fmtDay(a, this.tz), fmtDay(Math.min(a + 6 * DAY, range.to), this.tz), list.map((x) => M.recall.weekItem(x.e.title, x.e.importance, x.e.id))));
      }
    } else {
      lines = items.map(({ e, t }) => {
        const status: Record<string, string> = M.recall.status;
        const people = this.store.peopleOf(e.id).slice(0, 3);
        return M.recall.periodLine(fmtDay(t, this.tz), e.importance, e.title, e.gist, [status[e.status] ?? e.status, people.length ? M.recall.withPeople(people) : "", e.id].filter(Boolean).join(M.recall.metaSep));
      });
    }
    // 分页
    const limit = o.pageChars ?? 2000;
    const pages: string[][] = [[]];
    let size = 0;
    for (const l of lines) {
      if (size + l.length + 1 > limit - 40 && pages[pages.length - 1]!.length) { pages.push([]); size = 0; }
      pages[pages.length - 1]!.push(l.length > limit - 40 ? l.slice(0, limit - 41) + M.recall.lineCut : l);
      size += l.length + 1;
    }
    const p = Math.min(Math.max(1, o.page ?? 1), pages.length);
    const body = pages[p - 1]!.join("\n");
    return pages.length > 1 ? M.recall.page(p, pages.length, Math.min(p + 1, pages.length), body) : body;
  }

  // ---------- 反查 ----------
  reverse(ref: string): string {
    if (/^e\d{4,}$/.test(ref)) {
      const ev = this.store.event(ref);
      if (!ev) return M.recall.reverseNoEvent(ref);
      const ents = this.store.entitiesOf(ref).map((t) => {
        const role: Record<string, string> = M.recall.role;
        return `${t.name}（${role[t.role] ?? t.role}）`;
      });
      const inEntries = this.store.peopleOf(ref).filter((n) => !ents.some((x) => x.startsWith(n)));
      const links = this.pack(ref)!.links.map((l) => `${l.rel} ${l.id} ${l.title}`);
      return M.recall.reverseEvent(ev.title, ev.id, [...ents, ...inEntries], links);
    }
    const t = this.store.entity(ref);
    if (!t) return M.recall.reverseUnknown(ref);
    const evs = this.store.eventsOf(t.id);
    if (!evs.length) return M.recall.reverseNone(t.name);
    return M.recall.reverseList(t.name, evs.slice(0, 40).map((e) => M.recall.reverseItem(e.ended_at ? fmtDay(e.ended_at, this.tz) : "    ", e.importance, e.title, e.gist, e.id)), evs.length);
  }

  // ---------- 自动联想 ----------
  /**
   * 以事件为主（事件在人脑里远比一句话要紧，大部分话是记不得的）：
   * 想起的是事件里对得上的片段（带事件名）；原话不单独出现，只陪着片段、最多一句、只给正在说话的人一天以前说的。
   * exclude 里是这个前缀里给过的事件、片段、原话：给过的片段不再给，给过的事只在有新片段时用标题带过。
   * 返回的 events 是给了的事件，entries 是给了的片段和原话、附过谁的近况（recap:<名字>）（都该记进 exclude）。
   */
  async associate(cue: string, o: { speaker?: string; budget?: number; exclude?: Set<string>; region?: string; timeoutMs?: number; touch?: boolean; context?: string } = {}): Promise<{ text: string; events: string[]; entries: string[]; ms: number }> {
    const t0 = Date.now();
    const budget = o.budget ?? 600;
    cue = cue.replace(ENVELOPE, "");
    const parts: string[] = [];
    const events: string[] = [];
    const entries: string[] = [];
    // 人的近况（主人、她自己除外，最多两个）：说话的访客先附（知道在跟谁聊）；
    // 话里点名提到的人放在片段后面，片段里已经有跟他有关的事就不再列（11-01：「朋友想看一部动画，帮她投屏」先出了不相干的相册）
    const isSelf = (n: string) => self().includes(n.toLowerCase());
    const sp = o.speaker ? this.store.entity(o.speaker) : undefined;
    const guest = sp && !isSelf(sp.name) && !isSelf(sp.person_key ?? "") ? sp.name : undefined;
    const named: string[] = [];
    for (const t of this.mentioned(cue)) if (t.kind === "person" && !isSelf(t.name) && !isSelf(t.person_key ?? "") && t.name !== guest && !named.includes(t.name)) named.push(t.name);
    // 一个前缀里一个人的近况只附一次（附过记成 recap:<名字>；不然每句话都翻出下一批旧事；11-01 一个朋友 8 条表情翻出 24 件）
    const recapped = (name: string) => Boolean(o.exclude?.has(`recap:${name}`));
    // 没内容的话（表情、「好的好的」）不附
    const guestRecap = guest && !lowInfo(cue) && !recapped(guest) ? guest : undefined;
    const later = named.filter((n) => !recapped(n)).slice(0, 2 - (guestRecap ? 1 : 0));
    const recapCount = (guestRecap ? 1 : 0) + later.length;
    const recapBudget = recapCount > 1 ? 180 : 250;
    const recap = (name: string, room: number): boolean => {
      const p = this.person(name, 3, room, { exclude: new Set([...(o.exclude ?? []), ...events, ...entries]), auto: true, ...(o.touch === false ? { touch: false } : {}) });
      if (B.forms.noRecap.test(p)) return false;
      parts.push(p);
      entries.push(`recap:${name}`);
      for (const m of p.matchAll(/(e\d{4,})（/g)) events.push(m[1]!);
      for (const m of p.matchAll(/（(n\d{4,})(?:→(n\d{4,}))?）/g)) entries.push(...m.slice(1).filter(Boolean) as string[]);
      return true;
    };
    if (guestRecap) recap(guestRecap, recapBudget);
    // 预算里先留出「想起来的」那行，和后面点名的人的近况
    const room = () => budget - M.recall.assocHeader.length - 1 - parts.join("\n").length - (parts.length ? 1 : 0);
    const exclude = new Set([...(o.exclude ?? []), ...events, ...entries]);
    if (!lowInfo(cue) && room() - later.length * (recapBudget + 1) > 80) {
      const timeoutMs = o.timeoutMs ?? ASSOCIATE_EMBED_MS;
      const look = (c: string) => Promise.all([
        // 近况里刚列过的事，这次不再在片段里重复列
        this.moments(c, { budget: room() - later.length * (recapBudget + 1), exclude, skip: new Set(events), timeoutMs }),
        o.speaker ? this.speakerQuote(c, o.speaker, exclude, timeoutMs) : Promise.resolve(null),
      ]);
      let [m, q] = await look(cue);
      // 这句话自己一件事都对不上（「这几个官方模型都不够好」没说在讲 Live2D）：带上她刚跟这个人说的最后一句再找一次（她 11-02：话太短，没对上）。
      // 对得上就不掺，免得她自己的话把联想带偏
      if (!m.text && o.context && !lowInfo(o.context)) [m, q] = await look(`${o.context}\n${cue}`);
      if (m.text) {
        parts.push(m.text);
        events.push(...m.events);
        entries.push(...m.entries);
        const fits = (line: string) => room() - later.length * (recapBudget + 1) >= line.length;
        if (q && fits(q.line)) {
          parts.push(q.line);
          entries.push(q.ref);
          // 他那句后面接上她当时回他的那句（她 11-02：要是能顺手把我自己当时怎么说的也带出来就好了）
          const a = this.replyTo(q.ref, exclude);
          if (a && fits(a.line)) { parts.push(a.line); entries.push(a.ref); }
        }
        if (o.touch !== false) for (const id of m.events) this.store.touch(id, "auto", o.region ?? "");
      }
    }
    for (const name of later) {
      if (events.some((id) => this.store.peopleOf(id).includes(name))) continue;   // 片段里已经想起跟他有关的事
      if (room() > 80) recap(name, Math.min(recapBudget, room()));
    }
    const text = parts.length ? `${M.recall.assocHeader}\n${parts.join("\n")}` : "";
    return { text: text.length > budget ? text.slice(0, budget - 1) + M.recall.assocCut : text, events, entries, ms: Date.now() - t0 };
  }

  /** 事件里对得上这句话的片段：事件和片段单独搜（不跟原话抢名额），每件事最多两条，最多三件 */
  private async moments(cue: string, o: { budget: number; exclude: Set<string>; skip: Set<string>; timeoutMs: number }): Promise<{ text: string; events: string[]; entries: string[] }> {
    const hits = await this.index.search(cue, { limit: 20, kinds: ["event", "entry"], timeoutMs: o.timeoutMs });
    // 没有向量（没 key、转向量超时）时只能认词
    const vectors = hits.some((h) => h.cos !== undefined);
    const groups = new Map<string, { rel: number; best: number; hits: Array<{ n: EntryRow; score: number }> }>();
    for (const h of hits) {
      const n = h.ref.startsWith("n") ? this.store.entry(h.ref) : undefined;
      if (n && o.exclude.has(n.id)) continue;
      const eid = n ? n.event_id : h.ref;
      if (o.skip.has(eid)) continue;
      const ev = this.store.event(eid);
      if (!ev || !this.visible(ev) || ev.status === "retired") continue;
      // 话里直接点了它的名（事件标题、三个字以上的条目标题）= 想起来了；否则要意思够像
      const title = n ? n.title : ev.title;
      const named = [...title].length >= (n ? 3 : 2) && cue.includes(title);
      const cos = h.cos ?? 0;
      // 刚写的还没算向量：跟没有向量时一样只认词
      const wordsOnly = !vectors || (h.cos === undefined && !this.index.hasVector(h.ref));
      const pass = named || (wordsOnly ? Boolean(h.exact) : cos >= MOMENT_COS || ((h.fts || Boolean(h.exact)) && cos >= MOMENT_WORD_COS));
      if (!pass) continue;
      const g = groups.get(eid) ?? { rel: 0, best: 0, hits: [] };
      g.rel = Math.max(g.rel, h.score * (h.exact ? 1.5 : 1));
      g.best = Math.max(g.best, cos + (named ? MOMENT_NAMED : 0));
      if (n) g.hits.push({ n, score: h.score });
      groups.set(eid, g);
    }
    // 大事本身没有对上的片段、它下面的子事件有：不单独列（子事件头上的「属于」会带出它）
    const above = new Set([...groups.keys()].flatMap((id) => this.store.ancestors(id).map((a) => a.id)));
    // 给过的事：没有新片段就不再提
    const ranked = [...groups.entries()]
      .filter(([id, g]) => g.hits.length || (!o.exclude.has(id) && !above.has(id)))
      .map(([id, g]) => { const ev = this.store.event(id)!; return { id, g, score: g.best + MOMENT_IMPORTANCE * (ev.pinned ? 5 : ev.importance) }; })
      .sort((a, b) => b.score - a.score || b.g.rel - a.g.rel)
      .slice(0, MOMENT_EVENTS);
    if (!ranked.length) return { text: "", events: [], entries: [] };
    const packs = ranked.map(({ id, g }) => {
      const picked = g.hits.sort((a, b) => b.score - a.score).slice(0, MOMENTS_PER_EVENT).map((x) => x.n);
      const ids = new Set(picked.map((n) => n.id));
      // 被更正过的片段带上更正（渲染时绑在一起）
      // （更正自己也被搜到时已经在 picked 里，不再加一遍）
      const fixes = this.store.entries(id).filter((n) => n.kind === "correction" && n.corrects && ids.has(n.corrects) && !ids.has(n.id));
      const list = [...picked, ...fixes].sort((a, b) => b.at - a.at);
      // 关联、子事件不列（占片段的篇幅）；「属于哪件大事」留在头上
      return { ...this.pack(id, { entries: list, hits: ids })!, links: [], children: [], ...(o.exclude.has(id) ? { brief: true } : {}) };
    });
    const text = renderEvents(packs, { budget: o.budget, now: this.now(), tz: this.tz, maxEvents: MOMENT_EVENTS, entriesPerEvent: MOMENTS_PER_EVENT, keepOrder: true, compact: true, gistEntries: true, touched: this.touched });
    const events = packs.map((p) => p.ev.id).filter((id) => text.includes(`${id}（`));
    // 更正绑在原条目上显示成「（原→更正）」，两个都算给过
    const entries = packs.flatMap((p) => p.entries.map((n) => n.id)).filter((id) => text.includes(`（${id}）`) || text.includes(`（${id}→`) || text.includes(`→${id}）`));
    return { text, events, entries };
  }

  /** 陪着片段的一句原话：正在跟她说话的那个人一天以前说的、很像这句话的；她自己说的不给 */
  /** 他那句原话之后，她紧接着回他的一句（半小时内、发给他的、不是「好的」这种短句） */
  private replyTo(ref: string, exclude: Set<string>): { line: string; ref: string } | null {
    const q = this.index.quote(ref);
    if (!q) return null;
    for (const r of this.index.repliesTo(q.who, q.at, REPLY_WINDOW_MS)) {
      const rref = `q${r.id}`;
      if (exclude.has(rref) || lowInfo(r.text)) continue;
      const line = this.quoteLine(rref);
      if (line) return { line, ref: rref };
    }
    return null;
  }

  private async speakerQuote(cue: string, speaker: string, exclude: Set<string>, timeoutMs: number): Promise<{ line: string; ref: string } | null> {
    const hits = await this.index.search(cue, { limit: 10, kinds: ["quote"], timeoutMs });
    const who = speaker.toLowerCase();
    for (const h of hits) {
      if ((h.cos ?? 0) < QUOTE_COS || exclude.has(h.ref)) continue;
      const q = this.index.quote(h.ref);
      if (!q || q.who.toLowerCase() !== who || this.now() - q.at < QUOTE_MIN_AGE) continue;
      if (lowInfo(q.text) || norm(q.text) === norm(cue)) continue;
      const line = this.quoteLine(h.ref);
      if (line) return { line, ref: h.ref };
    }
    return null;
  }
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[\p{P}\p{S}\s\u200d\ufe0f]/gu, "");
}

/** 只发了图时，消息只剩信封头（「[WhatsApp +614… Sat 2026-10-31 13:16 GMT+11] +614…: 」） */
const ENVELOPE = /^\s*\[(?:WhatsApp|QQ)[^\]]*\]\s*[^:：\n]{0,40}[:：]\s*/u;

/** 没什么内容的一句：去掉信封头、标点、表情和「可以」「好的」「哈哈」「咋样了」这类应答、语气词以后不到两个字 */
export function lowInfo(cue: string): boolean {
  return norm(cue.replace(ENVELOPE, "")).replace(B.forms.filler, "").length < 2;
}

/**
 * The two regular expressions of parseRange that are put together from the pack's words (B.forms.period). Under the
 * reference pack each has the source of the literal the code used to have (test/lang-forms.test.ts pins them)
 */
export const periodRe = {
  /** A range of two dates: the pack's words between them, or one of the marks */
  range: (): RegExp => new RegExp(`(\\d{4}-)?(\\d{1,2})-(\\d{1,2})\\s*(?:${B.forms.period.to}|~|～|–|—|-{1,2})\\s*(\\d{4}-)?(\\d{1,2})-(\\d{1,2})`),
  /** One date: month 1–12, day 1–31, with no unit after it ("3-4 hours" is not a date) */
  oneDate: (): RegExp => new RegExp(`(?<![\\d-])(\\d{4}-)?(\\d{1,2})-(\\d{1,2})(?![\\d-])(?!\\s*(?:${B.forms.period.units}|%))`),
};

/**
 * 时间段：今天、昨天、前天、这周、上周、这个月、上个月、最近 N 天、MM-DD（到 MM-DD）、YYYY-MM-DD（到 …）。
 * 认不出返回 null。按她的时区算日子。
 */
export function parseRange(s: string, now: number, tz: string): Range | null {
  const t = s.trim();
  const day0 = (ms: number) => { const p = ymd(ms, tz); return localToUtc(p.y, p.m, p.d, 0, 0, tz); };
  const endOf = (start: number) => start + DAY - 1;
  const today = day0(now);
  const dow = (new Date(today + tzOffset(today, tz)).getUTCDay() + 6) % 7;   // 周一 = 0
  const w = B.forms.period;
  const m2 = periodRe.range().exec(t);
  if (m2 && !(okMD(m2[2]!, m2[3]!) && okMD(m2[5]!, m2[6]!))) return null;
  if (m2) {
    const a = dateOf(m2[1], m2[2]!, m2[3]!, now, tz), b = dateOf(m2[4], m2[5]!, m2[6]!, now, tz);
    return { from: a, to: endOf(b) };
  }
  if (w.today.test(t)) return { from: today, to: now };
  if (w.dayBefore.test(t)) return { from: today - 2 * DAY, to: endOf(today - 2 * DAY) };
  if (w.yesterday.test(t)) return { from: today - DAY, to: endOf(today - DAY) };
  if (w.lastWeek.test(t)) return { from: today - (dow + 7) * DAY, to: endOf(today - (dow + 1) * DAY) };
  if (w.thisWeek.test(t)) return { from: today - dow * DAY, to: now };
  const ym = ymd(now, tz);
  if (w.lastMonth.test(t)) {
    const y = ym.m === 1 ? ym.y - 1 : ym.y, m = ym.m === 1 ? 12 : ym.m - 1;
    return { from: localToUtc(y, m, 1, 0, 0, tz), to: localToUtc(ym.y, ym.m, 1, 0, 0, tz) - 1 };
  }
  if (w.thisMonth.test(t)) return { from: localToUtc(ym.y, ym.m, 1, 0, 0, tz), to: now };
  const n = w.lastDays.exec(t);
  if (n) return { from: today - (Number(n[1]) - 1) * DAY, to: now };
  // 单个日期：月 1–12、日 1–31，后面不跟「个、小时、天、次…」（「3-4 个小时」不是日期）
  const one1 = periodRe.oneDate().exec(t);
  if (one1 && okMD(one1[2]!, one1[3]!)) { const a = dateOf(one1[1], one1[2]!, one1[3]!, now, tz); return { from: a, to: endOf(a) }; }
  return null;
}

function okMD(m: string, d: string): boolean {
  const mm = Number(m), dd = Number(d);
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

function ymd(ms: number, tz: string): { y: number; m: number; d: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(ms).map((x) => [x.type, x.value])) as Record<string, string>;
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

/** MM-DD 没写年份：取今年，算出来在未来就是去年 */
function dateOf(year: string | undefined, m: string, d: string, now: number, tz: string): number {
  const y = year ? Number(year.slice(0, 4)) : ymd(now, tz).y;
  const t = localToUtc(y, Number(m), Number(d), 0, 0, tz);
  return !year && t > now + DAY ? localToUtc(y - 1, Number(m), Number(d), 0, 0, tz) : t;
}
