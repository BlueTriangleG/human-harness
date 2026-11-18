// 控制台的「事件记忆」：直接只读查 hh.db 的 mem_* 表。
// Not through hhd's {cmd:"mem"}: a recall there writes mem_touch (touched = clearer), and a person browsing must not change what the role is forgetting.
// 清晰度照 fade.ts 算：最后一次让它变清楚的碰只算 open / cite / new。
import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { clarity, eventClarity, staysClear } from "../memory/events/fade.ts";
import type { Clarity } from "../memory/events/fade.ts";
import { CLEARING } from "../memory/events/schema.ts";
import type { Kind } from "../memory/events/schema.ts";
import { clip } from "./data.ts";
import { maskImpressionOp, privateReplaced } from "../memory/events/people.ts";

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const str = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const CLEAR_SQL = `how IN (${CLEARING.map((h) => `'${h}'`).join(",")})`;
const like = (q: string): string => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
function jsonArray(v: unknown): string[] {
  try { const a = JSON.parse(str(v) || "[]") as unknown; return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export function hasEventTables(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mem_event'").get());
}

/** 每个 ref 最后一次变清楚的时间 */
function touchedMap(db: DatabaseSync, prefix: "e" | "n"): Map<string, number> {
  const rows = db.prepare(`SELECT ref, max(at) t FROM mem_touch WHERE ref LIKE ? AND ${CLEAR_SQL} GROUP BY ref`).all(`${prefix}%`) as Row[];
  return new Map(rows.map((r) => [str(r.ref), Number(r.t)]));
}

/** 原始行 → staysClear 要的三个字段 */
function rowStay(e: Row): { pinned: boolean; stance: string | null; status: string } {
  return { pinned: Boolean(e.pinned), stance: e.stance ? str(e.stance) : null, status: str(e.status) };
}

function lastActive(ev: Row, touched: number | null): number {
  return Math.max(num(ev.ended_at) ?? Number(ev.created_at), touched ?? 0);
}

// ---------- 总览 ----------

export interface MemOverview {
  ready: boolean;
  counts: Record<string, number>;
  status: Record<string, number>;
  importance: number[];
  clarity: Record<string, number>;
  quotes: Array<{ src: string; n: number; first: number | null; last: number | null }>;
  days: Array<{ day: string; doneAt: number }>;
  batches: Array<{ id: string; state: string; started: number; ended: number | null; ops: number }>;
  /** 白天记喜好（like）记成了几次：每次一批（day-like:），不进 batches，不然会把夜里那几批挤掉 */
  dayLikes: number;
  lastWrite: number | null;
}

/**
 * 总览里从库里读出来的那一半：十来张表各数一遍、把每件事过一遍。清晰度不在这里（它随时间退，要按「现在」算），
 * 只留算它要用的三样：重要度、是不是一直清楚、最后一次动是什么时候。
 */
interface OverviewData {
  base: Omit<MemOverview, "clarity">;
  events: Array<{ importance: number; staysClear: boolean; lastActive: number }>;
}

/**
 * 为什么记着上一次的：库在盘上的缓存是热的时候读一遍 0.03 秒，冷的时候（11-14 线上：一遍十几 G 的读盘之后）4.9 秒，
 * 控制台是单线程的，这几秒别的请求都排在它后面。事件记忆开着时页面每 30 秒问一次，记忆页也要这几个数，
 * 而库多数时候没人在写。所以按连接记下读到的那一半，库没被别的连接改过（PRAGMA data_version 没变）就不再读库，
 * 清晰度拿记下的那三样按现在的时间重算。库一有人写（哪张表都算），下一次就重读。
 */
const overviewData = new WeakMap<DatabaseSync, { version: number; data: OverviewData | null }>();
const dataVersion = (db: DatabaseSync): number => Number((db.prepare("PRAGMA data_version").get() as Row | undefined)?.data_version ?? NaN);

export function overview(db: DatabaseSync, now: number): MemOverview {
  const version = dataVersion(db);
  let had = overviewData.get(db);
  if (!had || had.version !== version || Number.isNaN(version)) {
    had = { version, data: readOverview(db) };
    overviewData.set(db, had);
  }
  if (!had.data) return { ready: false, counts: {}, status: {}, importance: [0, 0, 0, 0, 0, 0], clarity: {}, quotes: [], days: [], batches: [], dayLikes: 0, lastWrite: null };
  const clar: Record<string, number> = {};
  for (const e of had.data.events) {
    const c = eventClarity(e.importance, e.staysClear, e.lastActive, now);
    clar[c] = (clar[c] ?? 0) + 1;
  }
  // 给出去的是一份新的：拿到的人改了它，不会改到记着的那一份
  const d = had.data.base;
  return { ...d, counts: { ...d.counts }, status: { ...d.status }, importance: [...d.importance], clarity: clar, quotes: d.quotes.map((q) => ({ ...q })), days: d.days.map((x) => ({ ...x })), batches: d.batches.map((x) => ({ ...x })) };
}

/** 读库的那一半；没有事件表是 null */
function readOverview(db: DatabaseSync): OverviewData | null {
  if (!hasEventTables(db)) return null;
  const n = (sql: string): number => Number((db.prepare(sql).get() as Row | undefined)?.n ?? 0);
  const counts = {
    events: n("SELECT count(*) n FROM mem_event"),
    entries: n("SELECT count(*) n FROM mem_entry"),
    corrections: n("SELECT count(*) n FROM mem_entry WHERE kind = 'correction'"),
    entities: n("SELECT count(*) n FROM mem_entity"),
    people: n("SELECT count(*) n FROM mem_entity WHERE kind = 'person'"),
    links: n("SELECT count(*) n FROM mem_link"),
    quotes: n("SELECT count(*) n FROM mem_quote"),
    vectors: n("SELECT count(*) n FROM mem_vec"),
    // 向量表里事件、经过、原话的都有（编号 e… / n… 开头的是事件和经过，同 memory/events/index.ts 的 refKind）；页面上「原话里几成有向量」只能拿原话的那部分算
    quoteVectors: n("SELECT count(*) n FROM mem_vec WHERE ref NOT LIKE 'e%' AND ref NOT LIKE 'n%'"),
    touches: n("SELECT count(*) n FROM mem_touch"),
  };
  const status: Record<string, number> = {};
  const importance = [0, 0, 0, 0, 0, 0];
  const events: OverviewData["events"] = [];
  const touched = touchedMap(db, "e");
  for (const e of db.prepare("SELECT * FROM mem_event").all() as Row[]) {
    status[str(e.status)] = (status[str(e.status)] ?? 0) + 1;
    const imp = Math.max(0, Math.min(5, Number(e.importance)));
    importance[imp] = (importance[imp] ?? 0) + 1;
    events.push({ importance: imp, staysClear: staysClear(rowStay(e)), lastActive: lastActive(e, touched.get(str(e.id)) ?? null) });
  }
  const quotes = (db.prepare("SELECT src, count(*) n, min(at) a, max(at) b FROM mem_quote GROUP BY src ORDER BY n DESC").all() as Row[])
    .map((r) => ({ src: str(r.src), n: Number(r.n), first: num(r.a), last: num(r.b) }));
  const days = (db.prepare("SELECT day, done_at FROM mem_day ORDER BY day DESC LIMIT 14").all() as Row[]).map((r) => ({ day: str(r.day), doneAt: Number(r.done_at) }));
  const batches = (db.prepare(`
    SELECT b.id, b.state, b.started_at, b.ended_at, (SELECT count(*) FROM mem_op o WHERE o.batch = b.id) ops
    FROM mem_batch b WHERE b.id NOT LIKE 'day-like:%' ORDER BY b.started_at DESC LIMIT 60`).all() as Row[])
    .map((r) => ({ id: str(r.id), state: str(r.state), started: Number(r.started_at), ended: num(r.ended_at), ops: Number(r.ops) }));
  return {
    base: {
      ready: true, counts, status, importance, quotes, days, batches,
      dayLikes: n("SELECT count(*) n FROM mem_batch WHERE id LIKE 'day-like:%' AND state = 'committed'"),
      lastWrite: num((db.prepare("SELECT max(at) t FROM mem_op").get() as Row | undefined)?.t),
    },
    events,
  };
}

// ---------- 事件列表 ----------

export interface EventItem {
  id: string; title: string; gist: string; importance: number; status: string; pinned: boolean;
  started: number | null; ended: number | null; created: number; updated: number;
  entries: number; people: string[]; touched: number | null; clarity: Clarity; supersededBy: string | null;
  /** 属于哪件大事（子事件才有） */
  parent: string | null;
}

export interface EventQuery { q?: string; status?: string; who?: string; min?: number; limit?: number }

export function eventList(db: DatabaseSync, now: number, o: EventQuery = {}): { total: number; items: EventItem[] } {
  if (!hasEventTables(db)) return { total: 0, items: [] };
  let evs = db.prepare("SELECT * FROM mem_event ORDER BY COALESCE(ended_at, started_at, created_at) DESC, id DESC").all() as Row[];
  if (o.status) evs = evs.filter((e) => e.status === o.status);
  if (o.min !== undefined) evs = evs.filter((e) => Number(e.importance) >= o.min!);
  if (o.who) {
    const ids = new Set((db.prepare(`
      SELECT event_id id FROM mem_event_entity WHERE entity_id = ?
      UNION SELECT n.event_id FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id WHERE ne.entity_id = ?`).all(o.who, o.who) as Row[]).map((r) => str(r.id)));
    evs = evs.filter((e) => ids.has(str(e.id)));
  }
  const q = o.q?.trim();
  if (q) {
    const p = like(q);
    const L = "LIKE ? ESCAPE '\\'";
    const ids = new Set((db.prepare(`
      SELECT id FROM mem_event WHERE id = ? OR title ${L} OR gist ${L} OR summary ${L} OR why ${L}
      UNION SELECT event_id FROM mem_entry WHERE id = ? OR title ${L} OR gist ${L} OR full ${L}
      UNION SELECT ee.event_id FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE t.name ${L} OR t.aliases ${L}`)
      .all(q, p, p, p, p, q, p, p, p, p, p) as Row[]).map((r) => str(r.id)));
    evs = evs.filter((e) => ids.has(str(e.id)));
  }
  const total = evs.length;
  evs = evs.slice(0, Math.max(1, Math.min(o.limit ?? 3000, 5000)));
  const counts = new Map((db.prepare("SELECT event_id, count(*) n FROM mem_entry GROUP BY event_id").all() as Row[]).map((r) => [str(r.event_id), Number(r.n)]));
  const people = new Map<string, string[]>();
  for (const r of db.prepare(`
    SELECT ee.event_id ev, t.name FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE t.kind = 'person'
    UNION SELECT n.event_id ev, t.name FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id JOIN mem_entity t ON t.id = ne.entity_id WHERE t.kind = 'person'`).all() as Row[]) {
    const k = str(r.ev);
    const l = people.get(k) ?? [];
    if (!l.includes(str(r.name))) l.push(str(r.name));
    people.set(k, l);
  }
  const touched = touchedMap(db, "e");
  return {
    total,
    items: evs.map((e) => {
      const id = str(e.id);
      const t = touched.get(id) ?? null;
      return {
        id, title: str(e.title), gist: str(e.gist), importance: Number(e.importance), status: str(e.status), pinned: Boolean(e.pinned),
        started: num(e.started_at), ended: num(e.ended_at), created: Number(e.created_at), updated: Number(e.updated_at),
        entries: counts.get(id) ?? 0, people: people.get(id) ?? [], touched: t,
        clarity: eventClarity(Number(e.importance), staysClear(rowStay(e)), lastActive(e, t), now), supersededBy: e.superseded_by ? str(e.superseded_by) : null,
        parent: e.parent ? str(e.parent) : null,
      };
    }),
  };
}

// ---------- 一件事的全部 ----------

export interface EntryView {
  id: string; at: number; until: number | null; kind: string; title: string; gist: string; full: string;
  source: string[]; corrects: string | null; correctedBy: string | null; people: string[]; touched: number | null; clarity: Clarity; created: number;
}
export interface EventDetail {
  focus: string | null;
  event: EventItem & { summary: string; why: string; threadPath: string | null };
  entities: Array<{ id: string; name: string; kind: string; role: string; personKey: string | null }>;
  links: Array<{ rel: string; id: string; title: string; note: string; by: string; at: number }>;
  supersedes: Array<{ id: string; title: string }>;
  supersededTitle: string | null;
  /** 属于哪件大事 */
  parent: { id: string; title: string } | null;
  /** 挂在下面的子事件，按开始的先后 */
  children: Array<{ id: string; title: string; gist: string; status: string; entries: number }>;
  entries: EntryView[];
  touches: Array<{ ref: string; at: number; how: string; region: string }>;
  ops: Array<{ id: number; batch: string; at: number; op: string; tbl: string; key: string; reason: string }>;
}

export function eventDetail(db: DatabaseSync, ref: string, now: number): EventDetail | null {
  if (!hasEventTables(db) || !/^[en]\d{4,6}$/.test(ref)) return null;
  let id = ref, focus: string | null = null;
  if (ref.startsWith("n")) {
    const n = db.prepare("SELECT event_id FROM mem_entry WHERE id = ?").get(ref) as Row | undefined;
    if (!n) return null;
    id = str(n.event_id); focus = ref;
  }
  const e = db.prepare("SELECT * FROM mem_event WHERE id = ?").get(id) as Row | undefined;
  if (!e) return null;
  const title = (x: string): string => str((db.prepare("SELECT title FROM mem_event WHERE id = ?").get(x) as Row | undefined)?.title);
  const entities = (db.prepare("SELECT t.id, t.name, t.kind, t.person_key, ee.role FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE ee.event_id = ? ORDER BY t.kind, t.name").all(id) as Row[])
    .map((r) => ({ id: str(r.id), name: str(r.name), kind: str(r.kind), role: str(r.role), personKey: r.person_key ? str(r.person_key) : null }));
  // 关联的方向照 recall.pack：从这件事看过去，对方是起因还是后续
  const links = (db.prepare("SELECT * FROM mem_link WHERE a = ? OR b = ? ORDER BY created_at").all(id, id) as Row[]).map((l) => {
    const other = l.a === id ? str(l.b) : str(l.a);
    const r = str(l.rel);
    const rel = r === "cause" && l.b === id ? "cause" : r === "cause" ? "followup" : r === "followup" && l.b === id ? "cause" : r;
    return { rel, id: other, title: title(other), note: str(l.note), by: str(l.created_by), at: Number(l.created_at) };
  });
  const raw = db.prepare("SELECT * FROM mem_entry WHERE event_id = ? ORDER BY at, id").all(id) as Row[];
  const ids = raw.map((n) => str(n.id));
  const touchedN = touchedMap(db, "n");
  const peopleOf = db.prepare("SELECT t.name FROM mem_entry_entity ne JOIN mem_entity t ON t.id = ne.entity_id WHERE ne.entry_id = ?");
  const correctedBy = new Map<string, string>();
  for (const n of raw) if (n.corrects) correctedBy.set(str(n.corrects), str(n.id));
  const imp = Number(e.importance), pinned = Boolean(e.pinned);
  const entries: EntryView[] = raw.map((n) => {
    const nid = str(n.id);
    const t = touchedN.get(nid) ?? null;
    const fixed = correctedBy.has(nid) || n.kind === "correction";
    return {
      id: nid, at: Number(n.at), until: num(n.until), kind: str(n.kind), title: str(n.title), gist: str(n.gist), full: clip(str(n.full)),
      source: jsonArray(n.source), corrects: n.corrects ? str(n.corrects) : null, correctedBy: correctedBy.get(nid) ?? null,
      people: (peopleOf.all(nid) as Row[]).map((r) => str(r.name)), touched: t, created: Number(n.created_at),
      clarity: clarity({ importance: imp, pinned: staysClear(rowStay(e)), kind: (fixed ? "correction" : str(n.kind)) as Kind, at: Number(n.at), touched: t, now }),
    };
  });
  const refs = [id, ...ids];
  const marks = refs.map(() => "?").join(",");
  const touches = (db.prepare(`SELECT ref, at, how, region FROM mem_touch WHERE ref IN (${marks}) ORDER BY at DESC LIMIT 80`).all(...refs) as Row[])
    .map((r) => ({ ref: str(r.ref), at: Number(r.at), how: str(r.how), region: str(r.region) }));
  // mem_op.key 是主键的 JSON：事件和条目是 {"id":…}，关联、事件上的人是带着事件编号的组合键
  const ops = (db.prepare(`SELECT id, batch, at, op, tbl, key, reason FROM mem_op WHERE key IN (${marks}) OR key LIKE ? ORDER BY id DESC LIMIT 150`)
    .all(...refs.map((r) => JSON.stringify({ id: r })), `%"${id}"%`) as Row[])
    .map((r) => ({ id: Number(r.id), batch: str(r.batch), at: Number(r.at), op: str(r.op), tbl: str(r.tbl), key: str(r.key), reason: str(r.reason) }));
  const t = touchedMap(db, "e").get(id) ?? null;
  const people = [...new Set([...entities.filter((x) => x.kind === "person").map((x) => x.name), ...entries.flatMap((x) => x.people)])];
  return {
    focus,
    event: {
      id, title: str(e.title), gist: str(e.gist), importance: imp, status: str(e.status), pinned,
      started: num(e.started_at), ended: num(e.ended_at), created: Number(e.created_at), updated: Number(e.updated_at),
      entries: entries.length, people, touched: t, clarity: eventClarity(imp, staysClear(rowStay(e)), lastActive(e, t), now),
      supersededBy: e.superseded_by ? str(e.superseded_by) : null, summary: str(e.summary), why: str(e.why), threadPath: e.thread_path ? str(e.thread_path) : null,
      parent: e.parent ? str(e.parent) : null,
    },
    entities, links,
    supersedes: (db.prepare("SELECT id, title FROM mem_event WHERE superseded_by = ?").all(id) as Row[]).map((r) => ({ id: str(r.id), title: str(r.title) })),
    supersededTitle: e.superseded_by ? title(str(e.superseded_by)) : null,
    parent: e.parent ? { id: str(e.parent), title: title(str(e.parent)) } : null,
    children: (db.prepare(`SELECT e.id, e.title, e.gist, e.status, (SELECT count(*) FROM mem_entry n WHERE n.event_id = e.id) n
      FROM mem_event e WHERE e.parent = ? ORDER BY e.started_at IS NULL, e.started_at, e.id`).all(id) as Row[])
      .map((r) => ({ id: str(r.id), title: str(r.title), gist: str(r.gist), status: str(r.status), entries: Number(r.n) })),
    entries, touches, ops,
  };
}

// ---------- 人和东西 ----------

export interface EntityItem { id: string; kind: string; name: string; aliases: string[]; personKey: string | null; note: string; importance: number | null; why: string; events: number; entries: number; last: number | null }

export function entityList(db: DatabaseSync): EntityItem[] {
  if (!hasEventTables(db)) return [];
  const evs = new Map((db.prepare(`
    SELECT entity_id, count(DISTINCT event_id) n FROM (
      SELECT entity_id, event_id FROM mem_event_entity
      UNION SELECT ne.entity_id, n.event_id FROM mem_entry_entity ne JOIN mem_entry n ON n.id = ne.entry_id)
    GROUP BY entity_id`).all() as Row[]).map((r) => [str(r.entity_id), Number(r.n)]));
  const ents = new Map((db.prepare("SELECT ne.entity_id, count(*) n, max(n.at) last FROM mem_entry_entity ne JOIN mem_entry n ON n.id = ne.entry_id GROUP BY ne.entity_id").all() as Row[])
    .map((r) => [str(r.entity_id), { n: Number(r.n), last: num(r.last) }]));
  return (db.prepare("SELECT * FROM mem_entity ORDER BY kind, name").all() as Row[]).map((t) => {
    const id = str(t.id);
    return {
      id, kind: str(t.kind), name: str(t.name), aliases: jsonArray(t.aliases), personKey: t.person_key ? str(t.person_key) : null, note: str(t.note),
      importance: t.importance === null || t.importance === undefined ? null : Number(t.importance), why: str(t.why ?? ""),
      events: evs.get(id) ?? 0, entries: ents.get(id)?.n ?? 0, last: ents.get(id)?.last ?? null,
    };
  }).sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || b.events - a.events);
}

// ---------- 原话层 ----------

export interface QuoteItem { id: number; src: string; ref: string; at: number; who: string; channel: string; text: string; chars: number }

export function quoteList(db: DatabaseSync, o: { q?: string; src?: string; who?: string; offset?: number; limit?: number } = {}): { total: number; items: QuoteItem[] } {
  if (!hasEventTables(db)) return { total: 0, items: [] };
  const where: string[] = [], args: string[] = [];
  if (o.src) { where.push("src = ?"); args.push(o.src); }
  if (o.who) { where.push("who LIKE ? ESCAPE '\\'"); args.push(like(o.who)); }
  const qid = /^q(\d+)$/.exec(o.q?.trim() ?? "");
  if (qid) { where.push("id = ?"); args.push(qid[1]!); }
  else if (o.q?.trim()) { where.push("text LIKE ? ESCAPE '\\'"); args.push(like(o.q.trim())); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT count(*) n FROM mem_quote ${w}`).get(...args) as Row).n);
  const limit = Math.max(1, Math.min(o.limit ?? 100, 500));
  const offset = Math.max(0, o.offset ?? 0);
  const items = (db.prepare(`SELECT * FROM mem_quote ${w} ORDER BY at DESC, id DESC LIMIT ${limit} OFFSET ${offset}`).all(...args) as Row[]).map((r) => ({
    id: Number(r.id), src: str(r.src), ref: str(r.ref), at: Number(r.at), who: str(r.who), channel: str(r.channel), text: clip(str(r.text)), chars: str(r.text).length,
  }));
  return { total, items };
}

// ---------- 夜里改了什么（批次） ----------

export function batchOps(db: DatabaseSync, id: string, limit = 3000): { batch: { id: string; state: string; started: number; ended: number | null } | null; ops: Array<{ id: number; at: number; op: string; tbl: string; key: string; reason: string; before: string | null; after: string | null }> } {
  if (!hasEventTables(db)) return { batch: null, ops: [] };
  const b = db.prepare("SELECT * FROM mem_batch WHERE id = ?").get(id) as Row | undefined;
  const rows = db.prepare("SELECT * FROM mem_op WHERE batch = ? ORDER BY id LIMIT ?").all(id, limit) as Row[];
  // 被私密行顶掉的旧行：先看这一批自己（撤回了也在），再看库里现在的
  // 这一批里印象表的每一步都看（不受上面显示条数的限制：顶掉旧行和写新行那两步不会被截在两边）
  const impOps = db.prepare("SELECT tbl, after FROM mem_op WHERE batch = ? AND tbl = 'mem_impression'").all(id) as Row[];
  const inBatch = privateReplaced(impOps.map((r) => ({ tbl: str(r.tbl), after: r.after === null ? null : str(r.after) })));
  const hasImp = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mem_impression'").get());
  const replacedByPrivate = (rid: string): boolean => inBatch.has(rid) || (hasImp && Boolean(db.prepare("SELECT 1 FROM mem_impression WHERE supersedes = ? AND visibility != 'all' LIMIT 1").get(rid)));
  const ops = rows.map((r) => {
    // 人物卡（印象表）里访客私密的行：原文、为什么都不给看（R24）
    const m = maskImpressionOp(str(r.tbl), r.before === null ? null : str(r.before), r.after === null ? null : str(r.after), str(r.reason), replacedByPrivate);
    return {
      id: Number(r.id), at: Number(r.at), op: str(r.op), tbl: str(r.tbl), key: str(r.key), reason: m.reason,
      before: m.before === null ? null : clip(m.before, 6000), after: m.after === null ? null : clip(m.after, 6000),
    };
  });
  return { batch: b ? { id: str(b.id), state: str(b.state), started: Number(b.started_at), ended: num(b.ended_at) } : null, ops };
}

// ---------- 文件：中期视图、联想对比 ----------

/** hhd 每 10 分钟导出的中期视图（打开 memory.events.midterm 以后，她前缀里就是这一段） */
export function midtermView(stateDir: string): { text: string; mtime: number; chars: number } | null {
  const p = join(stateDir, "exports", "midterm.md");
  if (!existsSync(p)) return null;
  const text = readFileSync(p, "utf8");
  return { text: clip(text, 400_000), mtime: statSync(p).mtimeMs, chars: text.length };
}

/** hhd 每 10 分钟导出的向量情况：还差多少条、最后一次出错、暂停到什么时候（断了只会悄悄退成全文检索） */
export function vectorStatus(stateDir: string): { at: number; missing: number; lastError: string; lastErrorAt: number | null; lastOkAt: number | null; pausedUntil: number | null } | null {
  const p = join(stateDir, "exports", "vectors.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    return { at: Number(j.at), missing: Number(j.missing ?? 0), lastError: str(j.lastError ?? ""), lastErrorAt: num(j.lastErrorAt), lastOkAt: num(j.lastOkAt), pausedUntil: num(j.pausedUntil) };
  } catch {
    return null;
  }
}
