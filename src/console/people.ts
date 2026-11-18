// 控制台的「人物卡」：只读查 hh.db 的 mem_impression，卡照 people.ts 渲染——和 `hh mem card <谁>` 一样只给公开那一面。
// 主人照 hhd 认：名单的批准底子（kv registry_approved）里 privacy 是 owner 的 key。
// 访客私密的字段、钉的私密原话（visibility 不是 all）不出原文和为什么，只数有几条（R24：批的人不该看到访客私聊里的东西）。
import type { DatabaseSync } from "node:sqlite";
import { EventStore } from "../memory/events/store.ts";
import { byId, cardSections, cardTotal, fieldSpec, fieldUsage, lostLines, quoteMax, quoteSpec, specFor, templateOr } from "../memory/events/people.ts";
import type { PeopleTemplate } from "../memory/events/people.ts";
import type { EntityRow, ImpressionRow } from "../memory/events/schema.ts";
import { ownersOf } from "../persona/registry.ts";
import { kvGet } from "../store/db.ts";
import { say } from "./lang/index.ts";

export interface PeopleOptions {
  /** config memory.people.template 原样（没配、配坏了就不开） */
  template: unknown;
  tz: string;
  /** 现算段（近况）的窗口按这个时刻 */
  now: number;
}

export interface PersonSummary {
  id: string; name: string; key: string | null; kind: string; importance: number | null;
  owner: boolean;
  /** 「关系」那一行（类型｜走向｜一句话）；没有是空字符串 */
  relation: string;
  /** 卡上现行的合计字数和上限 */
  total: number; cap: number;
  /** 等人批的几条 */
  pending: number;
  /** 卡上最后一次改动（mem_impression.updated_at 最大的）；没存过东西是 null */
  updated: number | null;
}

export interface CardSection {
  name: string; text: string;
  /** field：存着的字段；quote：钉的原话；computed：现算的（近况、访客的我们的大事），不存、没有用量 */
  kind: "field" | "quote" | "computed";
  /** 「11/400 字」「3/5 条」「1/12 句」；现算段是 null */
  usage: string | null;
  over: boolean;
}

export interface PendingItem {
  id: string; section: string;
  /** 清掉 / 新建（还没有现行的）/ 丢了 x/y 行 */
  change: string;
  /** 私密的是 null */
  text: string | null; why: string | null;
  secret: boolean;
  /** 要替换的那一行已经不是现行的：批不了，只能驳回 */
  stale: boolean;
  created: number;
}

export interface HistoryItem {
  id: string; kind: "section" | "quote"; section: string; status: ImpressionRow["status"];
  /** 私密的是 null */
  text: string | null; why: string | null;
  secret: boolean;
  supersedes: string | null;
  created: number; updated: number;
  /** 动过这一行的批次（导入、夜里、批准、驳回），按时间 */
  ops: Array<{ op: string; batch: string; at: number }>;
}

export interface PersonCard {
  person: PersonSummary;
  sections: CardSection[];
  /** 不在这里显示的私密内容有几条（字段 + 钉的原话） */
  privateCount: number;
  pending: PendingItem[];
  /** 这个人卡上的每一行（现行、待批、被替换、驳回），新的在前 */
  history: HistoryItem[];
}

const isSecret = (r: Pick<ImpressionRow, "visibility">): boolean => r.visibility !== "all";
const carded = (e: EntityRow): boolean => e.kind === "person" || e.kind === "group";

function hasImpressions(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mem_impression'").get());
}

/** 名单批准底子里的主人；读不到、坏了就没有主人 */
function owners(db: DatabaseSync): Set<string> {
  try {
    const v = kvGet(db, "registry_approved");
    return new Set(v ? ownersOf(JSON.parse(v) as Record<string, unknown>) : []);
  } catch {
    return new Set();
  }
}

/** 只读连接上的 EventStore（people.ts 的渲染只读）；没配模板、没有印象表是 null */
function storeOf(db: DatabaseSync, o: PeopleOptions): { s: EventStore; t: PeopleTemplate } | null {
  const t = templateOr(o.template, () => { /* 配坏了：和 hhd 一样不开人物卡 */ });
  if (!t || !hasImpressions(db)) return null;
  return { s: new EventStore(db, () => o.now, o.tz, { peopleTemplate: t, owners: owners(db) }), t };
}

/**
 * 列不列：存着东西（现行的，私密的也算——卡是有的，只是这里不显示）、有待批的，或者公开那一面有段（现算的）。
 * 和 people.ts 出卡的规则一样，只是多了「只有待批的第一版」。
 */
function listed(s: EventStore, e: EntityRow, o: PeopleOptions, pendingAbout: ReadonlySet<string>): boolean {
  return carded(e) && (pendingAbout.has(e.id) || s.impressions(e.id).length > 0 || cardSections(s, e, { viewer: null, now: o.now, tz: o.tz }).length > 0);
}

/** 列表里每个人后面那一行「关系」取哪个字段：模板里形状是 line 的那一个（它叫什么随模板，不写死成中文的「关系」） */
const relationField = (t: PeopleTemplate): string | undefined => t.fields.find((f) => f.shape === "line")?.name;

function summary(s: EventStore, t: PeopleTemplate, e: EntityRow, pending: readonly ImpressionRow[]): PersonSummary {
  const owner = s.isOwner(e);
  const rows = s.impressions(e.id);
  const { total, cap } = cardTotal(t, owner, rows);
  const all = s.impressions(e.id, { status: ["current", "pending", "superseded", "rejected"] });
  return {
    id: e.id, name: e.name, key: e.person_key, kind: e.kind, importance: e.importance, owner,
    relation: rows.find((r) => r.kind === "section" && r.section === relationField(t) && !isSecret(r))?.text ?? "",
    total, cap,
    pending: pending.filter((p) => p.about === e.id).length,
    updated: all.length ? Math.max(...all.map((r) => r.updated_at)) : null,
  };
}

/** 有卡的人和群：主人在前，再按重要度从高到低（没打分的最后），同分按编号 */
export function peopleCards(db: DatabaseSync, o: PeopleOptions): { enabled: boolean; people: PersonSummary[] } {
  const st = storeOf(db, o);
  if (!st) return { enabled: false, people: [] };
  const { s, t } = st;
  const pending = s.pendingImpressions();
  const about = new Set(pending.map((p) => p.about));
  const people = s.entities().filter((e) => listed(s, e, o, about)).map((e) => summary(s, t, e, pending));
  people.sort((a, b) => Number(b.owner) - Number(a.owner) || (b.importance ?? -1) - (a.importance ?? -1) || byId(a.id, b.id));
  return { enabled: true, people };
}

function sectionOf(t: PeopleTemplate, owner: boolean, block: string): CardSection {
  const nl = block.indexOf("\n");
  const name = block.slice(3, nl);
  const text = block.slice(nl + 1);
  const q = quoteSpec(t, name);
  if (q) {
    const n = text.split("\n").filter((l) => l.trim()).length;
    const max = quoteMax(q, owner);
    return { name, text, kind: "quote", usage: say("events.cards.usage.quotesOf", { n, max }), over: n > max };
  }
  const f = fieldSpec(t, name);
  // 现算的只有模板里那两段（近况、我们的大事）；和现算段同名的主人专有字段（我们的大事）在主人的卡上是存着的。
  // 别的字段都是存着的——主人专有的（我们之间）认不出主人时也照样是字段
  const computedName = name === t.computed.near.name || name === t.computed.bigEvents.name;
  if (f && (!computedName || (f.ownerOnly === true && owner))) {
    const u = fieldUsage(specFor(f, owner), text);
    // worded for the person looking, from the figures: the role's own wording of them (u.text) is not parsed
    const usage = u.max === undefined ? say(`events.cards.usage.${u.unit}`, { n: u.n }) : say(`events.cards.usage.${u.unit}Of`, { n: u.n, max: u.max });
    return { name, text, kind: "field", usage, over: u.over };
  }
  return { name, text, kind: "computed", usage: null, over: false };
}

function pendingItem(s: EventStore, p: ImpressionRow): PendingItem {
  const cur = p.supersedes ? s.impression(p.supersedes) : undefined;
  const now = s.impressions(p.about).find((x) => x.kind === "section" && x.section === p.section)?.id ?? null;
  const change = !p.text ? say("events.cards.change.cleared") : !cur ? say("events.cards.change.created") : say("events.cards.change.lost", lostLines(cur.text, p.text));
  const secret = isSecret(p);
  return {
    id: p.id, section: p.section, change,
    text: secret ? null : p.text, why: secret ? null : p.why, secret,
    stale: p.supersedes !== now, created: p.created_at,
  };
}

/** 动过这些行的操作（mem_op 的 key 是 {"id":"i…"}） */
function opsOf(db: DatabaseSync, ids: readonly string[]): Map<string, Array<{ op: string; batch: string; at: number }>> {
  const out = new Map<string, Array<{ op: string; batch: string; at: number }>>();
  if (!ids.length) return out;
  const rows = db.prepare(`SELECT json_extract(key, '$.id') AS rid, op, batch, at FROM mem_op
    WHERE tbl = 'mem_impression' AND json_valid(key) AND json_extract(key, '$.id') IN (${ids.map(() => "?").join(",")}) ORDER BY at, id`).all(...ids) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const id = String(r.rid);
    const list = out.get(id) ?? [];
    list.push({ op: String(r.op), batch: String(r.batch), at: Number(r.at) });
    out.set(id, list);
  }
  return out;
}

/** 一个人或群的卡（id 是实体编号）；没开人物卡、不认识、不出卡又没有待批的，是 null */
export function personCard(db: DatabaseSync, id: string, o: PeopleOptions): PersonCard | null {
  const st = storeOf(db, o);
  if (!st) return null;
  const { s, t } = st;
  const e = s.entities().find((x) => x.id === id);
  const pending = s.pendingImpressions();
  if (!e || !listed(s, e, o, new Set(pending.map((p) => p.about)))) return null;
  const owner = s.isOwner(e);
  const all = s.impressions(e.id, { status: ["current", "pending", "superseded", "rejected"] });
  const ops = opsOf(db, all.map((r) => r.id));
  return {
    person: summary(s, t, e, pending),
    sections: cardSections(s, e, { viewer: null, now: o.now, tz: o.tz }).map((b) => sectionOf(t, owner, b)),
    privateCount: s.impressions(e.id).filter(isSecret).length,
    pending: pending.filter((p) => p.about === e.id).map((p) => pendingItem(s, p)),
    history: all
      .map((r): HistoryItem => {
        const secret = isSecret(r);
        return {
          id: r.id, kind: r.kind, section: r.section, status: r.status,
          text: secret ? null : r.text, why: secret ? null : r.why, secret,
          supersedes: r.supersedes, created: r.created_at, updated: r.updated_at, ops: ops.get(r.id) ?? [],
        };
      })
      .sort((a, b) => b.updated - a.updated || byId(b.id, a.id)),
  };
}
