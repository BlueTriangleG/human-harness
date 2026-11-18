// 专员 + 领导：领导看的「这个专员实际改了什么」——文件的 diff（两份快照之间）和事件库这一批的每一行变化。
// 跟 engineMaterial("tonight-events") 不一样：那份只看已经提交的批、只挑几种 op；这里批还开着也看，每一行都列，不认识的 op 也照样列出来。
import type { EventStore, OpRow } from "../memory/events/store.ts";
import type { MiniFs, Snapshot } from "./record.ts";
import { diff } from "./record.ts";
import { snapDiff } from "./review.ts";
import { calendarDay, hhmm } from "../brainstem/clock.ts";
import { S } from "../lang/index.ts";

/** 事件库那一份默认最多这么多字（再长的截在一条 op 的边上，说一共几条、列了几条） */
export const OPS_CAP = 30000;
/** 文件 diff 那一份默认最多这么多字 */
export const FILES_CAP = 30000;

type Row = Record<string, unknown>;

const OP_LABEL: Record<string, string> = {
  get event_create() { return S.opsdiff.opLabel.event_create; }, get event_update() { return S.opsdiff.opLabel.event_update; }, get entry_add() { return S.opsdiff.opLabel.entry_add; }, get entry_correct() { return S.opsdiff.opLabel.entry_correct; }, get link() { return S.opsdiff.opLabel.link; }, get unlink() { return S.opsdiff.opLabel.unlink; },
  get merge() { return S.opsdiff.opLabel.merge; }, get split() { return S.opsdiff.opLabel.split; }, get supersede() { return S.opsdiff.opLabel.supersede; }, get retire() { return S.opsdiff.opLabel.retire; }, get range() { return S.opsdiff.opLabel.range; },
  get entity_upsert() { return S.opsdiff.opLabel.entity_upsert; }, get entity_merge() { return S.opsdiff.opLabel.entity_merge; }, get entity_tag() { return S.opsdiff.opLabel.entity_tag; }, get entity_drop() { return S.opsdiff.opLabel.entity_drop; },
  get impression_set() { return S.opsdiff.opLabel.impression_set; }, get impression_pin() { return S.opsdiff.opLabel.impression_pin; }, get impression_approve() { return S.opsdiff.opLabel.impression_approve; }, get impression_reject() { return S.opsdiff.opLabel.impression_reject; },
  get revert_conflict() { return S.opsdiff.opLabel.revert_conflict; },
};
const FIELD: Record<string, string> = {
  get title() { return S.opsdiff.field.title; }, get summary() { return S.opsdiff.field.summary; }, get gist() { return S.opsdiff.field.gist; }, get why() { return S.opsdiff.field.why; }, get importance() { return S.opsdiff.field.importance; }, get status() { return S.opsdiff.field.status; }, get pinned() { return S.opsdiff.field.pinned; }, get superseded_by() { return S.opsdiff.field.superseded_by; },
  get thread_path() { return S.opsdiff.field.thread_path; }, get next_at() { return S.opsdiff.field.next_at; }, get parent() { return S.opsdiff.field.parent; }, get stance() { return S.opsdiff.field.stance; }, get started_at() { return S.opsdiff.field.started_at; }, get ended_at() { return S.opsdiff.field.ended_at; },
  get event_id() { return S.opsdiff.field.event_id; }, get at() { return S.opsdiff.field.at; }, get until() { return S.opsdiff.field.until; }, get kind() { return S.opsdiff.field.kind; }, get full() { return S.opsdiff.field.full; }, get source() { return S.opsdiff.field.source; }, get corrects() { return S.opsdiff.field.corrects; },
  get name() { return S.opsdiff.field.name; }, get aliases() { return S.opsdiff.field.aliases; }, get person_key() { return S.opsdiff.field.person_key; }, get note() { return S.opsdiff.field.note; },
  get about() { return S.opsdiff.field.about; }, get section() { return S.opsdiff.field.section; }, get text() { return S.opsdiff.field.text; }, get quote_id() { return S.opsdiff.field.quote_id; }, get visibility() { return S.opsdiff.field.visibility; }, get supersedes() { return S.opsdiff.field.supersedes; }, get sources() { return S.opsdiff.field.sources; },
  get rel() { return S.opsdiff.field.rel; }, get role() { return S.opsdiff.field.role; }, get entity_id() { return S.opsdiff.field.entity_id; }, get entry_id() { return S.opsdiff.field.entry_id; }, get created_by() { return S.opsdiff.field.created_by; },
};
/** 只是记账的列：不算改动 */
const QUIET = new Set(["created_at", "updated_at"]);
const TIMES = new Set(["at", "until", "started_at", "ended_at", "next_at"]);

const json = (t: string | null): Row | null => { try { const v = t ? (JSON.parse(t) as unknown) : null; return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : null; } catch { return null; } };
/** 存成 JSON 数组的列：拼成一行（别的列是什么样就什么样） */
const LISTS = new Set(["source", "sources", "aliases"]);
/** 一行最多多少字（再长的截掉，说一句；后面的行照列）：至少 400，不超过整份上限的八分之一 */
const rowCap = (cap: number): number => Math.max(400, Math.floor(cap / 8));
const empty = (v: unknown): boolean => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0) || v === "[]";
const show = (k: string, v: unknown, tz: string): string => {
  if (empty(v)) return S.marks.nothing;
  // 时间照她当地的钟点写（跟她看的对话材料同一个时区）
  if (TIMES.has(k) && typeof v === "number") return `${calendarDay(v, tz)} ${hhmm(v, tz)}`;
  if (typeof v === "string") {
    if (LISTS.has(k) && v.startsWith("[")) { try { const a = JSON.parse(v) as unknown; if (Array.isArray(a)) return a.map(String).join(S.marks.listSep); } catch { /* 原样 */ } }
    return v;
  }
  return Array.isArray(v) ? v.map(String).join(S.marks.listSep) : String(v);
};
const label = (k: string): string => FIELD[k] ?? k;
/** 多行的值：后面几行缩进，一条 op 还是一块 */
const block = (s: string): string => s.replace(/\n/g, "\n  ");

/**
 * 事件库一批里的每一行变化（批还开着也照样读）：一条 op 一块，「- 【做了什么】对象：内容」。
 * 新写的行列出不空的列，改的行列「列：旧 → 新」，删的行说删了什么；不认识的 op、表照通用的样子列，一条都不丢。
 * 超过 cap：截在一条的边上，最后说一共几条、列了几条
 */
export function batchDiff(
  store: Pick<EventStore, "ops" | "event" | "entry" | "entryPeople"> & Partial<Pick<EventStore, "entityById">>,
  batch: string, cap: number = OPS_CAP, tz = "UTC", skip = 0,
): string {
  // skip：前面这么多行不列（上一轮已经给领导看过的）；名字照整批认
  const every = store.ops(batch);
  const ops = skip > 0 ? every.slice(skip) : every;
  if (!ops.length) return skip > 0 && every.length ? S.opsdiff.noMoreChanges : S.opsdiff.noChanges;
  /** 这一批里见过的人和东西的名字（表里只有编号的那几行用） */
  const names = new Map<string, string>();
  for (const op of every) if (op.tbl === "mem_entity") { const r = json(op.after) ?? json(op.before); if (r?.id && r.name) names.set(String(r.id), String(r.name)); }
  const ev = (id: unknown): string => { const s = String(id ?? ""); const t = s ? store.event(s)?.title : undefined; return t ? S.opsdiff.titled(s, t) : s || S.marks.none; };
  // 这一批没动过的人和东西：到库里查名字（人物卡、挂的标签多半是早就有的人）
  const ent = (id: unknown): string => {
    const s = String(id ?? "");
    let n = names.get(s);
    if (n === undefined && s) { try { n = store.entityById?.(s)?.name; } catch { /* 查不到就只写编号 */ } }
    return n ? `${s} ${n}` : s;
  };
  const fields = (r: Row, skip: string[]): string => Object.keys(r).filter((k) => !QUIET.has(k) && !skip.includes(k) && !empty(r[k])).map((k) => S.opsdiff.fieldValue(label(k), show(k, r[k], tz))).join(S.marks.clauseSep);
  const changed = (bf: Row, af: Row, skip: string[] = []): string => {
    const ks = [...new Set([...Object.keys(bf), ...Object.keys(af)])].filter((k) => !QUIET.has(k) && !skip.includes(k) && JSON.stringify(bf[k] ?? null) !== JSON.stringify(af[k] ?? null));
    return ks.length ? ks.map((k) => S.opsdiff.fieldChanged(label(k), show(k, bf[k], tz), show(k, af[k], tz))).join(S.marks.clauseSep) : S.opsdiff.onlyBookkeeping;
  };
  const one = (op: OpRow): string => {
    const bf = json(op.before), af = json(op.after);
    const key = json(op.key) ?? {};
    const row = af ?? bf ?? key;
    const how = af && !bf ? "add" : af && bf ? "change" : bf ? "remove" : "none";
    let subject: string;
    let body: string;
    switch (op.tbl) {
      case "mem_event": {
        subject = S.opsdiff.event(row.id ? S.opsdiff.titled(String(row.id), String(row.title ?? store.event(String(row.id))?.title ?? "")) : JSON.stringify(key));
        body = how === "add" ? fields(af!, ["id", "title"]) : how === "change" ? changed(bf!, af!, ["id"]) : how === "remove" ? S.opsdiff.deleted : "";
        if (how === "change" && af!.superseded_by && af!.superseded_by !== bf!.superseded_by) body += S.opsdiff.mergedInto(ev(af!.superseded_by));
        if (how === "change" && af!.parent !== bf!.parent && af!.parent) body += S.opsdiff.nowUnder(ev(af!.parent));
        break;
      }
      case "mem_entry": {
        const id = String(row.id ?? "");
        subject = S.opsdiff.entry(id);
        if (how === "add") {
          const who = id ? store.entryPeople(id).join(S.marks.listSep) : "";
          body = S.opsdiff.entryAdded(ev(af!.event_id), fields(af!, ["id", "event_id"]), who ? S.opsdiff.entryWho(who) : "");
        } else if (how === "change") {
          body = bf!.event_id !== af!.event_id ? S.opsdiff.movedEntry(ev(bf!.event_id), ev(af!.event_id)) : "";
          const rest = changed(bf!, af!, ["id", "event_id"]);
          if (!body || rest !== S.opsdiff.onlyBookkeeping) body = [body, rest].filter(Boolean).join(S.marks.clauseSep);
        } else body = how === "remove" ? S.opsdiff.entryDeleted(ev(bf!.event_id), show("title", bf!.title, tz)) : "";
        break;
      }
      case "mem_link": {
        subject = `${ev(row.a)} —${String(row.rel ?? "")}→ ${ev(row.b)}`;
        body = how === "add" ? (empty(af!.note) ? S.opsdiff.linked : S.opsdiff.linkedNote(show("note", af!.note, tz))) : how === "change" ? changed(bf!, af!, ["a", "b", "rel"]) : how === "remove" ? S.opsdiff.unlinked : "";
        break;
      }
      case "mem_entity": {
        subject = S.opsdiff.entity(String(row.id ?? ""), String(row.name ?? "")).trimEnd();
        body = how === "add" ? fields(af!, ["id", "name"]) || S.opsdiff.created : how === "change" ? changed(bf!, af!, ["id"]) : how === "remove" ? S.opsdiff.deleted : "";
        break;
      }
      case "mem_event_entity": {
        subject = `${ent(row.entity_id)} ↔ ${ev(row.event_id)}${row.role ? S.opsdiff.role(String(row.role)) : ""}`;
        body = how === "add" ? S.opsdiff.tagged : how === "remove" ? S.opsdiff.untagged : how === "change" ? changed(bf!, af!) : "";
        break;
      }
      case "mem_entry_entity": {
        subject = S.opsdiff.entityEntry(ent(row.entity_id), String(row.entry_id ?? ""));
        body = how === "add" ? S.opsdiff.tagged : how === "remove" ? S.opsdiff.untagged : how === "change" ? changed(bf!, af!) : "";
        break;
      }
      case "mem_impression": {
        subject = S.opsdiff.card(String(row.id ?? ""), ent(row.about), row.kind === "quote" ? S.opsdiff.cardQuote : S.opsdiff.cardSection, String(row.section ?? ""));
        body = how === "add" ? fields(af!, ["id", "about", "kind", "section"]) : how === "change" ? changed(bf!, af!, ["id"]) : how === "remove" ? S.opsdiff.deleted : "";
        break;
      }
      default: {
        // 不认识的表：照通用的样子列，不丢
        subject = `${op.tbl} ${op.key}`;
        body = how === "add" ? fields(af!, []) : how === "change" ? changed(bf!, af!) : how === "remove" ? S.opsdiff.deletedFields(fields(bf!, [])) : "";
      }
    }
    const why = op.reason?.trim() ? S.opsdiff.reason(op.reason.trim()) : "";
    return block(S.opsdiff.opLine(OP_LABEL[op.op] ?? op.op, subject, body ? S.opsdiff.opBody(body) : "", why));
  };
  const head = S.opsdiff.batchHead(batch, ops.length);
  const out: string[] = [head];
  let size = head.length;
  for (let i = 0; i < ops.length; i++) {
    let line = one(ops[i]!);
    if (line.length > rowCap(cap)) line = line.slice(0, rowCap(cap)) + S.opsdiff.rowCut;
    if (size + 1 + line.length > cap) {
      out.push(P_CUT(ops.length, i));
      return out.join("\n");
    }
    out.push(line);
    size += 1 + line.length;
  }
  return out.join("\n");
}
const P_CUT = (total: number, shown: number): string => S.opsdiff.cut(total, shown);

/** 领导拿到的一个专员这一轮的改动 */
export interface SpecialistDiff {
  /** 文件的 diff（太长的截掉，最后一行说全文在哪个文件） */
  files: string;
  /** 事件库这一批的变化（同上） */
  ops: string;
  fileCount: number;
  opCount: number;
  /** 引擎对账看出来的（没写进记录的改动之类），给领导当提示 */
  hints: string[];
}

/** 这个专员这一轮改动的全文放哪（相对工作区）：领导那份截掉了就 Read 它 */
export const leadDiffPath = (day: string, stage: string, round: number): string => `sleep/${day}/flow/lead/${stage}.${round}.diff`;

/**
 * 拼领导看的那一份：before / after 是这个专员动手前、交差时整个 proposed/ 的快照（只比这两份，前面专员的改动不会混进来）；
 * ops(cap) 给事件库那一批的变化。全文（不截）总是写到 leadDiffPath；给领导的两份各不超过 cap，截了就在最后说全文在哪
 */
export function specialistDiff(o: {
  /** 路径相对工作区（StageHost.fs） */
  fs: Pick<MiniFs, "write">;
  day: string; stage: string; round: number;
  before: Snapshot; after: Snapshot;
  ops(cap: number): string; opCount: number;
  hints?: string[];
  filesCap?: number; opsCap?: number;
}): SpecialistDiff {
  const path = leadDiffPath(o.day, o.stage, o.round);
  const fullFiles = snapDiff(o.before, o.after, Infinity);
  const fullOps = o.ops(Infinity);
  o.fs.write(path, S.opsdiff.specialist(fullFiles.trimEnd(), fullOps.trimEnd()));
  const filesCap = o.filesCap ?? FILES_CAP;
  const opsCap = o.opsCap ?? OPS_CAP;
  const where = S.opsdiff.fullAt(path);
  const files = fullFiles.length > filesCap ? snapDiff(o.before, o.after, filesCap) + where : fullFiles;
  const ops = fullOps.length > opsCap ? o.ops(opsCap) + where : fullOps;
  return { files, ops, fileCount: diff(o.before, o.after).length, opCount: o.opCount, hints: [...(o.hints ?? [])] };
}
