// 事件记忆：类型、校验、建表 SQL。事件 = 一条长期追踪的线（总结 + 只增不改的时间线）。
import { z } from "zod";
import { B, N, fromEveryPack } from "../../lang/index.ts";

export const KINDS = ["happened", "said", "decided", "result", "feeling", "correction"] as const;
export const STATUSES = ["ongoing", "done", "paused", "superseded", "retired"] as const;
export const RELS = ["cause", "followup", "same_thread", "contrast", "supersedes", "related"] as const;
/** 喜欢 / 烦的事；没标的是 null */
export const STANCES = ["like", "dislike"] as const;
export const ROLES = ["with", "about", "by", "where"] as const;
/** 人和东西的种类（事和东西分开，项目、话题是事，记在事件里，不再登记成东西）：人、群、作品、东西、地方 */
export const ENTITY_KINDS = ["person", "group", "work", "thing", "place"] as const;
/** 她自己：不登记成人（每条经过里都有她，挂上只是噪音） */
export const isSelfName = (n: string): boolean => { const x = n.trim().toLowerCase(); return B.common.selfWords.includes(x) || (N.me !== "" && x === N.me.toLowerCase()); };
/** What an entity's kind is called in the role's language */
export const kindLabel = (kind: string): string => ({ person: B.schema.kindLabelPerson, group: B.schema.kindLabelGroup, work: B.schema.kindLabelWork, thing: B.schema.kindLabelThing, place: B.schema.kindLabelPlace, project: B.schema.kindLabelProject, topic: B.schema.kindLabelTopic } as Record<string, string>)[kind]!;

export type Kind = (typeof KINDS)[number];
export type Status = (typeof STATUSES)[number];
export type Rel = (typeof RELS)[number];
export type Stance = (typeof STANCES)[number];
export type Role = (typeof ROLES)[number];
/** 11-02 以前登记的还有 project / topic（清理时改成事或东西） */
export type EntityKind = (typeof ENTITY_KINDS)[number] | "project" | "topic";
/** 碰过的方式：只有 open / cite / new 让记忆变清楚（15.5） */
export type TouchHow = "auto" | "recall" | "open" | "cite" | "new";
export const CLEARING: readonly TouchHow[] = ["open", "cite", "new"];

export interface EventRow {
  id: string; title: string; summary: string; gist: string; why: string; importance: number; status: Status;
  started_at: number | null; ended_at: number | null; pinned: number; superseded_by: string | null; thread_path: string | null;
  created_at: number; updated_at: number;
  /** 下次的日子（考试、截止、约好的那天），那天的零点；没有就 null */
  next_at: number | null;
  /** 属于哪件大事（父事件编号）；顶层的事是 null */
  parent: string | null;
  /** 喜欢（like）/ 烦（dislike）；没标就 null */
  stance: Stance | null;
}
export interface EntryRow {
  id: string; event_id: string; at: number; until: number | null; kind: Kind; full: string; gist: string; title: string;
  /** JSON 数组：出处，如 ["c:123","q:45","thread:做脸.md"] */
  source: string; corrects: string | null; created_at: number;
}
export interface EntityRow {
  id: string; kind: EntityKind; name: string; aliases: string[]; person_key: string | null; note: string;
  /** 重要度 0–5（和事件同一把尺子，以后的遗忘曲线按它算）；还没打分是 null */
  importance: number | null; why: string;
}
export interface LinkRow { a: string; b: string; rel: Rel; note: string; created_by: string; created_at: number }

/** 印象的状态：现行、等人批、被替换（或清掉了）、驳回 */
export type ImpressionStatus = "current" | "pending" | "superseded" | "rejected";
/** 印象（人物卡 = 通用印象表的一种）：人物卡的一段（section），或钉住的一句原话（quote） */
export interface ImpressionRow {
  id: string;
  /** 关于谁：实体编号（t0002） */
  about: string; kind: "section" | "quote"; section: string;
  /** 段的正文；原话是钉的那一段（空白归一过） */
  text: string; quote_id: number | null;
  /** all，或 private:<person_key>（只在这个人自己那一面） */
  visibility: string; status: ImpressionStatus;
  /** 替换的是哪一行（待批的：批了要替换的那行） */
  supersedes: string | null; why: string;
  /** JSON 数组：出处，如 ["c:123","q45"] */
  sources: string; created_at: number; updated_at: number;
}
/** 喜欢 / 烦的事现在怎么样：喜欢中 / 腻了 / 烦着 / 不烦了（my_likes、like 的返回、认出东西都用这一套叫法） */
export const likeLabel = (e: Pick<EventRow, "stance" | "status">): string => (e.stance === "dislike" ? (e.status === "ongoing" ? B.schema.likeLabelDislikeOngoing : B.schema.likeLabelDislikeEnded) : (e.status === "ongoing" ? B.schema.likeLabelLikeOngoing : B.schema.likeLabelLikeEnded));
/** The word like (events/memory.ts) writes at the head of a like / dislike title (the role's pack's B.forms.stance); likeName and the prefix regexes of events/memory.ts read a stored title in every pack's */
export const stanceWord = (stance: Stance): string => B.forms.stance[stance];
/** 喜欢 / 烦的事的标题去掉自己那边的「喜欢」「烦」（后面跟不跟空格都算），剩下不到 2 个字的（「喜欢你」）原样：说给她听时不把「喜欢」说两遍 */
export function likeName(title: string, stance: Stance): string {
  const t = title.trim();
  const word = fromEveryPack((p) => p.brain.forms.stance[stance]).find((w) => t.startsWith(w));
  if (word === undefined) return t;
  const rest = t.slice(word.length).trim();
  return [...normName(rest)].length >= 2 ? rest : t;
}
/** 名字比较用：去掉括号引号和空白，转小写 */
export const normName = (x: string): string => x.replace(/[《》〈〉「」『』“”‘’"'()（）【】[\]\s]/g, "").toLowerCase();
/** 括号引号（去掉以后拿去全文里找） */
export const BRACKETS = /[《》〈〉「」『』“”‘’"'()（）【】[\]]/g;

export const GIST_MAX = 80;
export const TITLE_MAX = 24;

const time = z.union([z.number(), z.string().min(1)]);
const entityRef = z.object({ name: z.string().min(1), kind: z.enum(ENTITY_KINDS).default("thing"), role: z.enum(ROLES).default("about") });

export const EventCreate = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  summary: z.string().min(1),
  gist: z.string().min(1).max(GIST_MAX),
  why: z.string().default(""),
  importance: z.number().int().min(0, { error: () => B.schema.importanceRange }).max(5, { error: () => B.schema.importanceRange }),
  status: z.enum(STATUSES).default("ongoing"),
  pinned: z.boolean().optional(),
  thread_path: z.string().optional(),
  /** 下次的日子 YYYY-MM-DD */
  next: time.optional(),
  /** 属于哪件大事（父事件编号） */
  parent: z.string().regex(/^e\d{4,}$/, { error: () => B.schema.parentFormat }).optional(),
  /** 喜欢 / 烦的事 */
  stance: z.enum(STANCES).optional(),
  entities: z.array(entityRef).default([]),
}).refine((e) => e.importance < 4 || e.why.trim().length > 0, { error: () => B.schema.createWhyForHighImportance, path: ["why"] });

export const EventUpdate = z.strictObject({
  title: z.string().min(1).max(TITLE_MAX).optional(),
  summary: z.string().min(1).optional(),
  gist: z.string().min(1).max(GIST_MAX).optional(),
  why: z.string().optional(),
  importance: z.number().int().min(0, { error: () => B.schema.importanceRange }).max(5, { error: () => B.schema.importanceRange }).optional(),
  status: z.enum(STATUSES).optional(),
  pinned: z.boolean().optional(),
  thread_path: z.string().optional(),
  /** 下次的日子 YYYY-MM-DD；空字符串或 null 清掉 */
  next: z.union([time, z.literal("")]).nullable().optional(),
  /** 挂到哪件大事下面；空字符串或 null：不再属于哪件，单独算一件 */
  parent: z.union([z.string().regex(/^e\d{4,}$/, { error: () => B.schema.parentFormat }), z.literal("")]).nullable().optional(),
  /** 喜欢 / 烦；空字符串或 null 清掉 */
  stance: z.union([z.enum(STANCES), z.literal("")]).nullable().optional(),
});

export const EntryAdd = z.object({
  event: z.string().regex(/^e\d{4,}$/),
  at: time,
  until: time.optional(),
  kind: z.enum(KINDS).default("happened"),
  full: z.string().min(1, { error: () => B.schema.entryFullRequired }),
  gist: z.string().min(1).max(GIST_MAX, { error: () => B.schema.entryGistTooLong(GIST_MAX) }),
  title: z.string().min(1).max(TITLE_MAX),
  people: z.array(z.string().min(1)).default([]),
  source: z.array(z.string().min(1)).default([]),
}).refine((e) => e.gist.length <= e.full.length, { error: () => B.schema.entryGistNotShorter, path: ["gist"] })
  .refine((e) => e.kind !== "said" || e.source.length > 0, { error: () => B.schema.entrySaidNeedsSource, path: ["source"] })
  .refine((e) => e.kind !== "correction", { error: () => B.schema.entryCorrectionViaTool, path: ["kind"] });

export const EntryCorrect = z.object({
  full: z.string().min(1), gist: z.string().min(1).max(GIST_MAX), title: z.string().min(1).max(TITLE_MAX), why: z.string().min(1, { error: () => B.schema.entryCorrectNeedsWhy }),
});

export const EntityUpsert = z.object({
  /** 不写就是新建时按 thing、已有的不改 */
  name: z.string().min(1), kind: z.enum(ENTITY_KINDS).optional(), aliases: z.array(z.string().min(1)).default([]),
  person_key: z.string().optional(), note: z.string().optional(),
  importance: z.number().int().min(0, { error: () => B.schema.importanceRange }).max(5, { error: () => B.schema.importanceRange }).optional(), why: z.string().optional(),
  /** 去掉这些别名（比如群友被写成了群的别名，要单独登记成人） */
  remove_aliases: z.array(z.string().min(1)).default([]),
});

export const EntityTag = z.object({ role: z.enum(ROLES).default("with") });

/**
 * 写人物卡的一个字段；text 为空 = 清掉这个字段（要写 why）。
 * sources 是依据：非空的 text 至少要有一个库里真有的事件 e…、经过 n…、原话 q… / #… / c:… 编号（别的编号可以一起写，不算依据）
 */
export const PersonSet = z.object({
  who: z.string().min(1), section: z.string().min(1), text: z.string(), why: z.string().optional(), sources: z.array(z.string()).default([]),
});

/**
 * 钉一句原话：section 是人物卡模板里的原话段（store 照模板认）；quote 是原话编号 q123，或中央记忆序号 #123 / c:123；text 是钉的那一段（不写就整句）。
 * replaces：能换的原话段满了时换掉的那一行（i0013）
 */
export const QuotePin = z.object({
  who: z.string().min(1),
  section: z.string().min(1),
  quote: z.string().regex(/^(q\d+|#\d+|c:\d+)$/, { error: () => B.schema.pinQuoteRefFormat }),
  text: z.string().optional(), why: z.string().optional(), private: z.boolean().optional(), sources: z.array(z.string()).default([]),
  replaces: z.string().regex(/^i\d+$/, { error: () => B.schema.pinReplacesFormat }).optional(),
});

/** zod 错误 → 一行中文 */
export function explain(e: z.ZodError): string {
  return e.issues.map((i) => B.schema.issueLine(i.path.join(".") || B.schema.issuePathFallback, i.message)).join(B.common.listSep);
}

export function parse<T extends z.ZodType>(schema: T, v: unknown): z.output<T> {
  const r = schema.safeParse(v);
  if (!r.success) throw new Error(explain(r.error));
  return r.data;
}

/**
 * 时间：毫秒数，或字符串（ISO 带时区、"2026-10-29 21:30"、"2026-10-29"——没写时区的按她的时区）。
 */
export function parseTime(v: number | string, tz: string): number {
  if (typeof v === "number") return v;
  const s = v.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return t;
  }
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/.exec(s);
  if (!m) throw new Error(B.schema.timeUnparseable(v));
  return localToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), tz);
}

/** 某时区的本地时间 → UTC 毫秒（夏令时两次逼近） */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = tzOffset(guess, tz);
  const t = guess - off1;
  const off2 = tzOffset(t, tz);
  return guess - off2;
}

export function tzOffset(t: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(t / 1000) * 1000;
}

export const MIGRATION_EVENTS = `
  CREATE TABLE mem_event (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, summary TEXT NOT NULL, gist TEXT NOT NULL, why TEXT NOT NULL DEFAULT '',
    importance INTEGER NOT NULL, status TEXT NOT NULL, started_at INTEGER, ended_at INTEGER, pinned INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT, thread_path TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE mem_entry (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL, at INTEGER NOT NULL, until INTEGER, kind TEXT NOT NULL,
    full TEXT NOT NULL, gist TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL DEFAULT '[]', corrects TEXT, created_at INTEGER NOT NULL
  );
  CREATE INDEX mem_entry_event ON mem_entry(event_id, at);
  CREATE INDEX mem_entry_at ON mem_entry(at);
  CREATE TABLE mem_entity (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL UNIQUE, aliases TEXT NOT NULL DEFAULT '[]', person_key TEXT, note TEXT NOT NULL DEFAULT '');
  CREATE TABLE mem_event_entity (event_id TEXT NOT NULL, entity_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (event_id, entity_id, role));
  CREATE INDEX mem_event_entity_e ON mem_event_entity(entity_id);
  CREATE TABLE mem_entry_entity (entry_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY (entry_id, entity_id));
  CREATE INDEX mem_entry_entity_e ON mem_entry_entity(entity_id);
  CREATE TABLE mem_link (a TEXT NOT NULL, b TEXT NOT NULL, rel TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (a, b, rel));
  CREATE INDEX mem_link_b ON mem_link(b);
  CREATE TABLE mem_touch (ref TEXT NOT NULL, at INTEGER NOT NULL, how TEXT NOT NULL, region TEXT NOT NULL DEFAULT '');
  CREATE INDEX mem_touch_ref ON mem_touch(ref, at);
  CREATE TABLE mem_op (id INTEGER PRIMARY KEY AUTOINCREMENT, batch TEXT NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, before TEXT, after TEXT, reason TEXT NOT NULL DEFAULT '');
  CREATE INDEX mem_op_batch ON mem_op(batch, id);
  CREATE TABLE mem_batch (id TEXT PRIMARY KEY, state TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER);
  CREATE TABLE mem_day (day TEXT PRIMARY KEY, done_at INTEGER NOT NULL);
  CREATE TABLE mem_quote (id INTEGER PRIMARY KEY AUTOINCREMENT, src TEXT NOT NULL, ref TEXT NOT NULL, at INTEGER NOT NULL, who TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, UNIQUE (src, ref));
  CREATE INDEX mem_quote_at ON mem_quote(at);
  CREATE TABLE mem_vec (ref TEXT PRIMARY KEY, hash TEXT NOT NULL, vec BLOB NOT NULL);
  CREATE VIRTUAL TABLE mem_fts USING fts5(ref UNINDEXED, text, tokenize = 'trigram');
`;
