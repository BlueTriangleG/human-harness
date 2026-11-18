// 事件记忆的读写：所有写都经过这里。每个写操作拆成"行级变化"记进 mem_op（before / after），
// 所以任何一批都能整批撤回；撤的时候某一行已经被后面的批次改过，就列成冲突、不动它。
// 时间线条目的 full / gist / title 没有修改的路径：纠错只能加一条 correction。
import type { Db } from "../../store/db.ts";
import { all, one, kvGet, kvSet } from "../../store/db.ts";
import type { EventRow, EntryRow, EntityRow, ImpressionRow, LinkRow, Rel, TouchHow, Status } from "./schema.ts";
import { CLEARING, EventCreate, EventUpdate, EntryAdd, EntryCorrect, EntityTag, EntityUpsert, kindLabel, PersonSet, QuotePin, isSelfName, parse, parseTime, RELS } from "./schema.ts";
import { cardSizes, chars, checkField, fieldSize, fieldSpec, fullHintFor, keepHint, kind, lostLines, mustField, mustOwnerOnly, mustQuote, overCap, quoteMax, quoteSpec, specFor, visibilityOf } from "./people.ts";
import type { PeopleTemplate } from "./people.ts";
import { B } from "../../lang/index.ts";

type Row = Record<string, unknown>;
/** 撤回后留档的批次名：<原批次>~reverted@<毫秒> */
const REVERTED = "~reverted@";
const KEYS: Record<string, string[]> = {
  mem_event: ["id"], mem_entry: ["id"], mem_entity: ["id"],
  mem_event_entity: ["event_id", "entity_id", "role"], mem_entry_entity: ["entry_id", "entity_id"], mem_link: ["a", "b", "rel"],
  mem_impression: ["id"],
};

export interface OpRow { id: number; batch: string; at: number; op: string; tbl: string; key: string; before: string | null; after: string | null; reason: string }

/**
 * 为什么存成待批：forced 要求等批（迁移时的第一版卡）；first 这个字段的第一版还在等批；setting 设定字段改了或清掉；
 * protect 主人的 protect 字段丢了旧文的行（删掉、改写、清掉，修订 C）；
 * cleared 清掉总结字段；lost 丢了旧文很多行；sweep 这一批改了这个人一半以上的设定 / 总结字段
 */
export type PendingWhy = "forced" | "first" | "setting" | "protect" | "cleared" | "lost" | "sweep";
/** setSection 的结果：row 是写进去的那行（清掉是 null；没变是现在那行或一样的待批）；rejected 是这一下顺带驳回的待批（被新的待批取代、被直接改过了） */
export interface SectionWrite {
  row: ImpressionRow | null; pending: boolean; lost: number; of: number; cleared: boolean; unchanged: boolean;
  because: PendingWhy | null; rejected: string[];
}

const dead = (e: EventRow): boolean => e.status === "superseded" || e.status === "retired";

export class EventStore {
  readonly db: Db;
  readonly tz: string;
  private readonly now: () => number;
  private depth = 0;
  /** 某条的内容重建了（向量已删）：内存里的向量索引跟着丢掉旧的 */
  onReindex: ((ref: string) => void) | null = null;
  /** 人物卡模板（HH 配置 memory.people.template，parseTemplate 校验过）；null = 不开人物卡：写字段、钉原话都拒，导出不写 */
  readonly peopleTemplate: PeopleTemplate | null;
  /** 名单上的主人（privacy 是 owner 的 person_key，EventMemory.syncPeople 从名单认）：没有私密字段、合计上限用 ownerTotalCap、钉的原话默认公开 */
  owners: ReadonlySet<string>;

  constructor(db: Db, now: () => number = Date.now, tz = "Australia/Melbourne", o: { peopleTemplate?: PeopleTemplate | null; owners?: ReadonlySet<string> } = {}) {
    this.db = db;
    this.now = now;
    this.tz = tz;
    this.peopleTemplate = o.peopleTemplate ?? null;
    this.owners = o.owners ?? new Set();
  }

  /** 这个人是不是名单上的主人 */
  isOwner(t: EntityRow): boolean { return t.person_key !== null && this.owners.has(t.person_key); }
  /** 主人的名字（库里登记的名字，没登记就是名单 key），按 key 排；回话里说「只有谁的卡有」用 */
  ownerNames(): string[] { return [...this.owners].sort().map((k) => this.entity(k)?.name ?? k); }

  // ---------- 读 ----------
  event(id: string): EventRow | undefined { return one<EventRow>(this.db, "SELECT * FROM mem_event WHERE id = ?", id); }
  entry(id: string): EntryRow | undefined { return one<EntryRow>(this.db, "SELECT * FROM mem_entry WHERE id = ?", id); }
  /** 一件事的时间线，按时间从早到晚 */
  entries(eventId: string): EntryRow[] { return all<EntryRow>(this.db, "SELECT * FROM mem_entry WHERE event_id = ? ORDER BY at, id", eventId); }
  allEvents(): EventRow[] { return all<EventRow>(this.db, "SELECT * FROM mem_event ORDER BY id"); }
  links(id: string): LinkRow[] { return all<LinkRow>(this.db, "SELECT * FROM mem_link WHERE a = ? OR b = ? ORDER BY created_at", id, id); }
  /** 挂在这件事下面的子事件，按开始的先后（还没有时间线的排在后面） */
  children(id: string): EventRow[] {
    return all<EventRow>(this.db, "SELECT * FROM mem_event WHERE parent = ? ORDER BY started_at IS NULL, started_at, id", id);
  }
  /** 往上的大事：近的在前（父、祖父） */
  ancestors(id: string): EventRow[] {
    const out: EventRow[] = [];
    let cur = this.event(id)?.parent ?? null;
    while (cur && out.length < 8 && !out.some((e) => e.id === cur)) {
      const e = this.event(cur);
      if (!e) break;
      out.push(e);
      cur = e.parent;
    }
    return out;
  }

  entities(): EntityRow[] {
    return all<Row>(this.db, "SELECT * FROM mem_entity ORDER BY id").map(toEntity);
  }

  /** 按名字、别名、person_key 找（不分大小写） */
  entity(name: string): EntityRow | undefined {
    const k = name.trim().toLowerCase();
    if (!k) return undefined;
    return this.entities().find((e) => e.id === name || e.name.toLowerCase() === k || e.person_key?.toLowerCase() === k || e.aliases.some((a) => a.toLowerCase() === k));
  }

  entityById(id: string): EntityRow | undefined {
    const r = one<Row>(this.db, "SELECT * FROM mem_entity WHERE id = ?", id);
    return r ? toEntity(r) : undefined;
  }

  /** 这件事里有哪些人（事件上标的 + 时间线条目里出现的），按出现先后 */
  peopleOf(eventId: string): string[] {
    const rows = all<{ name: string }>(this.db, `
      SELECT t.name FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE ee.event_id = ? AND t.kind = 'person'
      UNION ALL
      SELECT t.name FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id JOIN mem_entity t ON t.id = ne.entity_id WHERE n.event_id = ? AND t.kind = 'person'`, eventId, eventId);
    return [...new Set(rows.map((r) => r.name))];
  }

  /** 这件事关联的人和东西（带角色） */
  entitiesOf(eventId: string): Array<EntityRow & { role: string }> {
    return all<Row>(this.db, "SELECT t.*, ee.role FROM mem_event_entity ee JOIN mem_entity t ON t.id = ee.entity_id WHERE ee.event_id = ?", eventId)
      .map((r) => ({ ...toEntity(r), role: String(r.role) }));
  }

  /** 某个人或东西出现在哪些事里（事件上标的，或时间线里出现的），最近的在前 */
  eventsOf(entityId: string): EventRow[] {
    return all<EventRow>(this.db, `
      SELECT DISTINCT e.* FROM mem_event e WHERE e.id IN (
        SELECT event_id FROM mem_event_entity WHERE entity_id = ?
        UNION SELECT n.event_id FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id WHERE ne.entity_id = ?)
      ORDER BY COALESCE(e.ended_at, e.created_at) DESC`, entityId, entityId);
  }

  /** 这条经过里有谁 */
  entryPeople(entryId: string): string[] {
    return all<{ name: string }>(this.db, "SELECT t.name FROM mem_entry_entity ne JOIN mem_entity t ON t.id = ne.entity_id WHERE ne.entry_id = ?", entryId).map((r) => r.name);
  }

  /** 和某个实体有关的条目，最近的在前 */
  entriesOf(entityId: string, limit = 50): EntryRow[] {
    return all<EntryRow>(this.db, `
      SELECT n.* FROM mem_entry n WHERE n.id IN (SELECT entry_id FROM mem_entry_entity WHERE entity_id = ?)
      ORDER BY n.at DESC LIMIT ?`, entityId, limit);
  }

  /** 纠正了这条的更正（最新的一条） */
  correctionOf(entryId: string): EntryRow | undefined {
    return one<EntryRow>(this.db, "SELECT * FROM mem_entry WHERE corrects = ? ORDER BY created_at DESC LIMIT 1", entryId);
  }

  impression(id: string): ImpressionRow | undefined { return one<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE id = ?", id); }
  /** 关于某个人或群（实体编号）的印象：段和钉住的原话，按编号；默认只要现行的 */
  impressions(about: string, o: { status?: string[] } = {}): ImpressionRow[] {
    const st = o.status ?? ["current"];
    if (!st.length) return [];
    return all<ImpressionRow>(this.db, `SELECT * FROM mem_impression WHERE about = ? AND status IN (${st.map(() => "?").join(",")}) ORDER BY id`, about, ...st);
  }
  /** 等人批的大改，按编号 */
  pendingImpressions(): ImpressionRow[] { return all<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE status = 'pending' ORDER BY id"); }

  // ---------- 碰过 ----------
  touch(ref: string, how: TouchHow, region = "", at = this.now()): void {
    this.db.prepare("INSERT INTO mem_touch (ref, at, how, region) VALUES (?, ?, ?, ?)").run(ref, at, how, region);
  }

  /** 最后一次让它变清楚的碰（展开、引用、新条目）；自动联想和工具命中不算 */
  lastTouched(ref: string): number | null {
    const r = one<{ t: number | null }>(this.db, `SELECT max(at) t FROM mem_touch WHERE ref = ? AND how IN (${CLEARING.map(() => "?").join(",")})`, ref, ...CLEARING);
    return r?.t ?? null;
  }

  touchCount(ref: string): number {
    return one<{ n: number }>(this.db, "SELECT count(*) n FROM mem_touch WHERE ref = ?", ref)?.n ?? 0;
  }

  // ---------- 写 ----------
  createEvent(input: unknown, batch: string, reason = ""): EventRow {
    const a = parse(EventCreate, input);
    if (a.parent) this.checkParent(null, a.parent);
    return this.tx(() => {
      const id = this.nextId("e", 4);
      const t = this.now();
      this.put("event_create", "mem_event", {
        id, title: a.title, summary: a.summary, gist: a.gist, why: a.why, importance: a.importance, status: a.status,
        started_at: null, ended_at: null, pinned: a.pinned ? 1 : 0, superseded_by: null, thread_path: a.thread_path ?? null, created_at: t, updated_at: t,
        next_at: a.next === undefined ? null : parseTime(a.next, this.tz), parent: a.parent ?? null, stance: a.stance ?? null,
      }, batch, reason);
      for (const ent of a.entities) {
        const e = this.ensureEntity(ent.name, ent.kind, batch);
        if (e) this.put("event_create", "mem_event_entity", { event_id: id, entity_id: e.id, role: ent.role }, batch, reason);
      }
      this.reindex(id);
      return this.event(id)!;
    });
  }

  updateEvent(id: string, patch: unknown, reason: string, batch: string): EventRow {
    const r = EventUpdate.safeParse(patch);
    if (!r.success) {
      const unknown = r.error.issues.find((i) => i.code === "unrecognized_keys") as { keys?: string[] } | undefined;
      if (unknown?.keys) throw new Error(B.store.eventUpdateUnknownField(unknown.keys.join(B.store.eventUpdateFieldSeparator)));
      throw new Error(r.error.issues.map((i) => B.store.eventUpdateInvalidField(i.path.join("."), i.message)).join(B.common.listSep));
    }
    const ev = this.mustEvent(id);
    return this.tx(() => {
      const p = r.data;
      const next: Row = { ...ev, updated_at: this.now() };
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined) continue;
        if (k === "next") next.next_at = v === null || v === "" ? null : parseTime(v as string | number, this.tz);
        else if (k === "parent") {
          if (v) this.checkParent(id, String(v));
          next.parent = v || null;
        } else if (k === "stance") next.stance = v || null;
        else next[k] = k === "pinned" ? (v ? 1 : 0) : v;
      }
      if (Number(next.importance) >= 4 && !String(next.why ?? "").trim()) throw new Error(B.store.importanceNeedsWhy);
      this.put("event_update", "mem_event", next, batch, reason);
      if (next.status === "retired" && ev.status !== "retired") this.liftChildren(next as unknown as EventRow, "event_update", batch, reason);
      this.reindex(id);
      return this.event(id)!;
    });
  }

  addEntry(input: unknown, batch: string, reason = ""): { entry: EntryRow; existed: boolean } {
    const a = parse(EntryAdd, input);
    this.mustEvent(a.event);
    const at = parseTime(a.at, this.tz);
    // #N（压缩块、折叠行里的编号）就是中央记忆第 N 条：记成 c:N
    const source = JSON.stringify(a.source.map((s) => (/^#\d+$/.test(s) ? `c:${s.slice(1)}` : s)).sort());
    const dup = all<EntryRow>(this.db, "SELECT * FROM mem_entry WHERE event_id = ? AND at = ?", a.event, at)
      .find((x) => (a.source.length ? x.source === source : x.full === a.full));
    if (dup) return { entry: dup, existed: true };
    return this.tx(() => {
      const id = this.nextId("n", 5);
      this.put("entry_add", "mem_entry", {
        id, event_id: a.event, at, until: a.until === undefined ? null : parseTime(a.until, this.tz), kind: a.kind,
        full: a.full, gist: a.gist, title: a.title, source, corrects: null, created_at: this.now(),
      }, batch, reason);
      for (const name of a.people) {
        const e = this.ensureEntity(name, "person", batch);
        if (e) this.put("entry_add", "mem_entry_entity", { entry_id: id, entity_id: e.id }, batch, reason);
      }
      this.recomputeRange(a.event, batch);
      // 有了新进展：这件事变清楚（按这条发生的时间算，导入的旧经过不会被当成刚碰过）
      this.touch(a.event, "new", "", at);
      this.reindex(id);
      return { entry: this.entry(id)!, existed: false };
    });
  }

  correctEntry(entryId: string, input: unknown, batch: string): EntryRow {
    const a = parse(EntryCorrect, input);
    const orig = this.entry(entryId);
    if (!orig) throw new Error(B.store.entryNotFound(entryId));
    return this.tx(() => {
      const id = this.nextId("n", 5);
      this.put("entry_correct", "mem_entry", {
        id, event_id: orig.event_id, at: orig.at, until: orig.until, kind: "correction", full: a.full, gist: a.gist, title: a.title,
        source: JSON.stringify([`why:${a.why}`]), corrects: entryId, created_at: this.now(),
      }, batch, a.why);
      this.reindex(id);
      return this.entry(id)!;
    });
  }

  link(a: string, b: string, rel: Rel, note: string, batch: string, by = "hippocampus"): void {
    if (!RELS.includes(rel)) throw new Error(B.store.linkRelInvalid(RELS.join(B.store.linkRelSeparator)));
    if (a === b) throw new Error(B.store.linkToSelf);
    this.mustEvent(a); this.mustEvent(b);
    if (rel === "related" && !note.trim()) throw new Error(B.store.linkRelatedNoteMissing);
    this.tx(() => this.put("link", "mem_link", { a, b, rel, note, created_by: by, created_at: this.now() }, batch, note));
  }

  unlink(a: string, b: string, rel: Rel, reason: string, batch: string): boolean {
    const k = { a, b, rel };
    if (!this.get("mem_link", k)) return false;
    this.tx(() => this.put("unlink", "mem_link", null, batch, reason, k));
    return true;
  }

  /** 几件其实是一件事：时间线并到 keep 上，其余标 superseded 指向它 */
  merge(keep: string, othersIn: string[], reason: string, batch: string): void {
    this.mustEvent(keep);
    const others = [...new Set(othersIn)];
    if (others.includes(keep)) throw new Error(B.store.eventMergeIntoSelf(keep));
    for (const o of others) this.mustEvent(o);
    const st = this.event(keep)!.stance;
    if (others.some((o) => this.event(o)!.stance !== st)) throw new Error(B.store.eventMergeStanceMismatch);
    this.tx(() => {
      for (const o of others) {
        // 留下的那件本来就在被并掉那件下面：顶上来接替它的位置（不然下面挂回来会成环）
        if (this.ancestors(keep).some((a) => a.id === o)) this.put("merge", "mem_event", { ...this.event(keep)!, parent: this.event(o)!.parent, updated_at: this.now() }, batch, reason);
        for (const n of this.entries(o)) this.put("merge", "mem_entry", { ...n, event_id: keep }, batch, reason);
        for (const ee of all<Row>(this.db, "SELECT * FROM mem_event_entity WHERE event_id = ?", o)) {
          if (!this.get("mem_event_entity", { event_id: keep, entity_id: ee.entity_id, role: ee.role })) this.put("merge", "mem_event_entity", { ...ee, event_id: keep }, batch, reason);
        }
        this.put("merge", "mem_event", { ...this.event(o)!, status: "superseded", superseded_by: keep, updated_at: this.now() }, batch, reason);
        // 被并掉那件下面的子事件挂到留下的那件下面（超过三层就整个不并）
        for (const c of this.children(o)) if (c.id !== keep) this.reparent(c, keep, "merge", batch, reason);
        this.recomputeRange(o, batch);
        this.reindex(o);
      }
      this.recomputeRange(keep, batch);
      this.reindex(keep);
    });
  }

  /**
   * 一件事里其实是两件：把一段条目挪到新事件。under：新的一件挂在原来那件下面当子事件（大事拆成小事）；
   * 不然两件平级，原处留 same_thread（同一件事的不同阶段）
   */
  split(id: string, entryIds: string[], newEvent: unknown, batch: string, reason = "", o: { under?: boolean } = {}): EventRow {
    this.mustEvent(id);
    for (const n of entryIds) if (this.entry(n)?.event_id !== id) throw new Error(B.store.eventSplitEntryNotInEvent(n, id));
    // 更正和原条目绑在一起：挪哪个都把另一个带上
    const moving = new Set(entryIds);
    const here = this.entries(id);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of here) {
        if (!n.corrects) continue;
        const fix = moving.has(n.id), orig = moving.has(n.corrects);
        if (orig && !fix) { moving.add(n.id); grew = true; }
        else if (fix && !orig && here.some((x) => x.id === n.corrects)) { moving.add(n.corrects); grew = true; }
      }
    }
    return this.tx(() => {
      const base = { ...(newEvent as Record<string, unknown>) };
      if (base.stance === undefined) { const st = this.event(id)!.stance; if (st) base.stance = st; }
      const ne = this.createEvent(o.under ? { ...base, parent: id } : base, batch, reason);
      for (const n of moving) this.put("split", "mem_entry", { ...this.entry(n)!, event_id: ne.id }, batch, reason);
      if (!o.under) this.put("split", "mem_link", { a: id, b: ne.id, rel: "same_thread", note: reason, created_by: "hippocampus", created_at: this.now() }, batch, reason);
      this.recomputeRange(id, batch);
      this.recomputeRange(ne.id, batch);
      this.reindex(id);
      return this.event(ne.id)!;
    });
  }

  supersede(old: string, by: string, reason: string, batch: string): void {
    this.mustEvent(old); this.mustEvent(by);
    if ((this.event(old)!.stance ?? null) !== (this.event(by)!.stance ?? null)) throw new Error(B.store.eventSupersedeStanceMismatch);
    this.tx(() => {
      this.put("supersede", "mem_event", { ...this.event(old)!, status: "superseded", superseded_by: by, updated_at: this.now() }, batch, reason);
      this.put("supersede", "mem_link", { a: old, b: by, rel: "supersedes", note: reason, created_by: "hippocampus", created_at: this.now() }, batch, reason);
      // 下面的子事件挂到替换它的那件下面（跟 merge 一样；替换它的那件本来在它下面就顶上来）
      if (this.ancestors(by).some((a) => a.id === old)) this.put("supersede", "mem_event", { ...this.event(by)!, parent: this.event(old)!.parent, updated_at: this.now() }, batch, reason);
      for (const c of this.children(old)) if (c.id !== by) this.reparent(c, by, "supersede", batch, reason);
    });
  }

  retire(id: string, reason: string, batch: string): void {
    this.tx(() => {
      const e = this.mustEvent(id);
      this.put("retire", "mem_event", { ...e, status: "retired" satisfies Status, updated_at: this.now() }, batch, reason);
      this.liftChildren(e, "retire", batch, reason);
    });
  }

  /** 不算数的是这一件，下面的事还在：挂到它上一层 */
  private liftChildren(e: EventRow, op: string, batch: string, reason: string): void {
    for (const c of this.children(e.id)) this.put(op, "mem_event", { ...c, parent: e.parent, updated_at: this.now() }, batch, reason);
  }

  /**
   * 登记或补充一个人/东西。按名字找已有的那一行（找不到再按别名、person_key）：
   * 名字只是另一行的别名、种类又不同（群友被写成了群的别名），不并到那一行上，让她先把别名拿掉；
   * 新别名已经是别人的名字或别名，也不收（同一个的话该用 mergeEntities）。
   */
  upsertEntity(input: unknown, batch: string): EntityRow {
    const a = parse(EntityUpsert, input);
    if (isSelfName(a.name)) throw new Error(B.store.entityIsSelf(a.name));
    return this.tx(() => {
      const byName = this.entities().find((e) => e.name.toLowerCase() === a.name.trim().toLowerCase());
      const cur = byName ?? this.entity(a.name) ?? (a.person_key ? this.entity(a.person_key) : undefined);
      if (cur && !byName && a.kind && a.kind !== cur.kind && cur.aliases.some((x) => x.toLowerCase() === a.name.trim().toLowerCase())) {
        throw new Error(B.store.entityAliasOfOtherKind(a.name, cur.name, kindLabel(cur.kind), kindLabel(a.kind), cur.name, a.name));
      }
      const removed = new Set(a.remove_aliases.map((x) => x.toLowerCase()));
      const known = new Set(cur ? [cur.name, ...cur.aliases].map((x) => x.toLowerCase()) : [a.name.toLowerCase()]);
      const added = [...new Set([...a.aliases, ...(cur && a.name !== cur.name ? [a.name] : [])])].filter((x) => !known.has(x.toLowerCase()) && !removed.has(x.toLowerCase()));
      this.checkAliases(cur ?? null, added);
      const importance = a.importance ?? cur?.importance ?? null;
      const why = a.why ?? cur?.why ?? "";
      if (importance !== null && importance >= 4 && !why.trim()) throw new Error(B.store.importanceNeedsWhy);
      if (!cur) {
        const id = this.nextId("t", 4);
        this.put("entity_upsert", "mem_entity", {
          id, kind: a.kind ?? "thing", name: a.name, aliases: JSON.stringify(added), person_key: a.person_key ?? null, note: a.note ?? "", importance, why: why.trim() ? why : null,
        }, batch, "");
        return this.entityById(id)!;
      }
      const aliases = [...cur.aliases.filter((x) => !removed.has(x.toLowerCase())), ...added];
      this.put("entity_upsert", "mem_entity", {
        id: cur.id, kind: a.kind ?? cur.kind, name: cur.name, aliases: JSON.stringify(aliases),
        person_key: a.person_key ?? cur.person_key, note: a.note ?? cur.note, importance, why: why.trim() ? why : null,
      }, batch, "");
      // 事件的搜索文字里有这个人的名字和别名：别名变了就重建
      if (aliases.join("\n") !== cur.aliases.join("\n")) {
        for (const r of all<{ event_id: string }>(this.db, "SELECT DISTINCT event_id FROM mem_event_entity WHERE entity_id = ?", cur.id)) this.reindex(r.event_id);
      }
      return this.entityById(cur.id)!;
    });
  }

  /**
   * 几个其实是同一个人/东西：事件和经过上的挂法都挪到 keep 上（重复的去掉），名字和别名并成 keep 的别名，
   * 名单 key、备注、why 缺的从被并的那几个补，重要度取最高；被并的那几行删掉。每一行都记进 mem_op，整批能撤回。
   * 人物卡的字段和钉住的原话也挪到 keep 上：两边都有同名的现行字段就不并（先并好一边），同一句原话只留 keep 的；
   * 能换的原话段（模板里 replaceable）超了上限，keep 的在前、被并的按编号补满，多的标 superseded（R21）；只加不删的原话段全留。
   * 合计超了不拦，以后往小里改（overCap 只拒变大的）。
   */
  mergeEntities(keepRef: string, othersIn: string[], reason: string, batch: string): EntityRow {
    const keep = this.mustEntity(keepRef);
    const others = [...new Map(othersIn.map((o) => this.mustEntity(o)).filter((o) => o.id !== keep.id).map((o) => [o.id, o])).values()];
    if (!others.length) throw new Error(B.store.entityMergeNothingToMerge);
    if (!reason.trim()) throw new Error(B.store.entityMergeReasonMissing);
    const keys = new Set([keep, ...others].map((t) => t.person_key).filter(Boolean));
    if (keys.size > 1) throw new Error(B.store.entityMergeDifferentPeople([...keys].join(B.store.entityMergeKeySeparator)));
    const both = [keep, ...others];
    const owner = new Map<string, string>();
    for (const r of all<{ about: string; section: string }>(this.db, `SELECT about, section FROM mem_impression WHERE kind = 'section' AND status = 'current' AND about IN (${both.map(() => "?").join(",")}) ORDER BY id`, ...both.map((t) => t.id))) {
      const prev = owner.get(r.section);
      if (prev && prev !== r.about) {
        const name = (id: string) => both.find((t) => t.id === id)!.name;
        throw new Error(B.store.entityMergeSectionBothFilled(name(prev), name(r.about), r.section, keep.name));
      }
      owner.set(r.section, r.about);
    }
    return this.tx(() => {
      const touched = new Set<string>();
      for (const o of others) {
        for (const r of all<Row>(this.db, "SELECT * FROM mem_event_entity WHERE entity_id = ?", o.id)) {
          const moved = { ...r, entity_id: keep.id };
          if (!this.get("mem_event_entity", moved)) this.put("entity_merge", "mem_event_entity", moved, batch, reason);
          this.put("entity_merge", "mem_event_entity", null, batch, reason, r);
          touched.add(String(r.event_id));
        }
        for (const r of all<Row>(this.db, "SELECT * FROM mem_entry_entity WHERE entity_id = ?", o.id)) {
          const moved = { ...r, entity_id: keep.id };
          if (!this.get("mem_entry_entity", moved)) this.put("entity_merge", "mem_entry_entity", moved, batch, reason);
          this.put("entity_merge", "mem_entry_entity", null, batch, reason, r);
          touched.add(String(r.entry_id));
        }
        // 同一句原话两边都钉过：留 keep 的，这边的标 superseded（唯一索引不让它挂到 keep 上，about 留原来的编号）
        // 能换的原话段并过来超了上限（R21）：keep 的在前，被并的按编号补满，多的挂过来但标 superseded（原话层里那句还在）
        for (const r of all<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE about = ? ORDER BY id", o.id)) {
          const dup = r.kind === "quote" && one(this.db, "SELECT 1 FROM mem_impression WHERE kind = 'quote' AND about = ? AND section = ? AND quote_id = ?", keep.id, r.section, r.quote_id);
          const spec = r.kind === "quote" && r.status === "current" && this.peopleTemplate ? quoteSpec(this.peopleTemplate, r.section) : null;
          const full = spec?.replaceable === true
            && (one<{ n: number }>(this.db, "SELECT count(*) n FROM mem_impression WHERE kind = 'quote' AND about = ? AND section = ? AND status = 'current'", keep.id, r.section)?.n ?? 0) >= quoteMax(spec, this.isOwner(keep));
          if (dup) { if (r.status !== "superseded") this.put("entity_merge", "mem_impression", { ...r, status: "superseded", updated_at: this.now() }, batch, reason); }
          else if (full) this.put("entity_merge", "mem_impression", { ...r, about: keep.id, status: "superseded", why: B.store.entityMergeOverCapNote, updated_at: this.now() }, batch, reason);
          else this.put("entity_merge", "mem_impression", { ...r, about: keep.id }, batch, reason);
        }
        this.put("entity_merge", "mem_entity", null, batch, reason, { id: o.id });
      }
      const seen = new Set([keep.name.toLowerCase()]);
      const aliases = [...keep.aliases, ...others.flatMap((o) => [o.name, ...o.aliases])].filter((x) => !seen.has(x.toLowerCase()) && Boolean(seen.add(x.toLowerCase())));
      const imps = [keep, ...others].map((t) => t.importance).filter((x): x is number => x !== null);
      const why = keep.why || others.find((o) => o.why)?.why || "";
      this.put("entity_merge", "mem_entity", {
        id: keep.id, kind: keep.kind, name: keep.name, aliases: JSON.stringify(aliases),
        person_key: keep.person_key ?? others.find((o) => o.person_key)?.person_key ?? null, note: keep.note || others.find((o) => o.note)?.note || "",
        importance: imps.length ? Math.max(...imps) : null, why: why || null,
      }, batch, reason);
      for (const r of all<{ event_id: string }>(this.db, "SELECT DISTINCT event_id FROM mem_event_entity WHERE entity_id = ?", keep.id)) touched.add(r.event_id);
      for (const ref of touched) this.reindex(ref);
      return this.entityById(keep.id)!;
    });
  }

  /** 已有的事件或经过上漏了谁：挂上（经过的原文不动）。已经挂着就不重复 */
  tagEntity(ref: string, target: string, role: string, batch: string, reason = ""): EntityRow {
    const t = this.mustEntity(ref);
    if (/^e\d+$/.test(target)) {
      this.mustEvent(target);
      const r = parse(EntityTag, { role });
      const row = { event_id: target, entity_id: t.id, role: r.role };
      if (!this.get("mem_event_entity", row)) this.tx(() => { this.put("entity_tag", "mem_event_entity", row, batch, reason); this.reindex(target); });
    } else if (/^n\d+$/.test(target)) {
      if (!this.entry(target)) throw new Error(B.store.entityTagEntryMissing(target));
      const row = { entry_id: target, entity_id: t.id };
      if (!this.get("mem_entry_entity", row)) this.tx(() => { this.put("entity_tag", "mem_entry_entity", row, batch, reason); this.reindex(target); });
    } else throw new Error(B.store.entityTagTargetInvalid(target));
    return t;
  }

  /**
   * 不该登记的（她自己、其实是一件事、系统零件）：去掉这一行和它在事件、经过上的挂法；事件和经过本身不动。
   * 名单上的人不能去掉；有任何人物卡的行（现行、待批、换下来的、驳回的）也不能：去掉以后再撤回别的批次，旧字段会挂回一个已经没有的人身上
   */
  dropEntity(ref: string, reason: string, batch: string): EntityRow {
    const t = this.mustEntity(ref);
    if (t.person_key) throw new Error(B.store.entityDropOnRoster(t.name, t.person_key));
    const n = one<{ n: number }>(this.db, "SELECT count(*) n FROM mem_impression WHERE about = ?", t.id)?.n ?? 0;
    if (n) throw new Error(B.store.entityDropHasCard(t.name, n));
    if (!reason.trim()) throw new Error(B.store.entityDropReasonMissing);
    return this.tx(() => {
      const touched = new Set<string>();
      for (const r of all<Row>(this.db, "SELECT * FROM mem_event_entity WHERE entity_id = ?", t.id)) { this.put("entity_drop", "mem_event_entity", null, batch, reason, r); touched.add(String(r.event_id)); }
      for (const r of all<Row>(this.db, "SELECT * FROM mem_entry_entity WHERE entity_id = ?", t.id)) { this.put("entity_drop", "mem_entry_entity", null, batch, reason, r); touched.add(String(r.entry_id)); }
      this.put("entity_drop", "mem_entity", null, batch, reason, { id: t.id });
      for (const x of touched) this.reindex(x);
      return t;
    });
  }

  // ---------- 人物卡（印象） ----------
  /**
   * 写人物卡的一个字段：新行替换旧行（旧行标 superseded，新行的 supersedes 指着它）；text 为空 = 清掉（旧行 superseded，不建新行）。
   * 写之前查（修订 A）：写法和上限（P21、P22，超了就拒）、依据（P23：sources 里至少一个库里有的事件 / 经过 / 原话编号）、
   * 卡的合计（P22）；清掉不要依据，要 why。
   * 字段、写法、上限、类型都照模板（store.peopleTemplate）；没配模板就拒。主人（修订 C）：上限用字段的 owner 覆盖、合计用 ownerTotalCap；
   * 主人专有的字段（ownerOnly）别人写就拒；requireEvent 的列表每条要带库里有的事件编号。
   * 等人批（P24）存成 pending，人批了才换：设定字段有现行的时候改（含清掉）；总结字段清掉、丢了旧文超过四分之一的非空行（至少 5 行）、
   * 或这一批里这个人改过的设定 / 总结字段连这个超过他现行设定 / 总结字段的一半（至少 3 个）。
   * 主人的 protect 字段（修订 C，关系不遗忘）：总结的丢了旧文任何一行（删掉、改写、清掉）就等批，只往上加（旧的每一行都还在）的照总结的规矩；
   * 设定的照旧改了就等批（protect 只多拦，不少拦）。这样的字段第一版还在等批时（迁移那几份写的），夜里再写会删掉第一版内容的直接拒
   * （不然没批过的那些就从待批里没了），只往上加的照旧顶成新的待批；forcePending（迁移那几份自己改）不拦。主人的 protect 字段超了大小时，
   * 回话不叫她收短，叫她写进给主人的提案（keepHint）。
   * 新建、详情字段、导入（noApproval）不用批；forcePending 一律等批（新建也是，迁移时的第一版卡），和 noApproval 一起给时它赢——
   * 私密字段（模板 private、详情）除外，永远不等批：批的人（主人）不该看到访客私聊里的东西（R24）；
   * 这样的第一版还没批（没有现行的），再写这个字段也等批（noApproval 也一样），不然夜里一写就绕过批的人上去了。
   * 同一个字段只留一个待批：新的待批把前一个驳回；直接改（不等批）的时候，这个字段上开着的待批都批不了了，同一个事务里驳回（被直接改过了）。
   */
  setSection(input: unknown, batch: string, o: { noApproval?: boolean; forcePending?: boolean } = {}): SectionWrite {
    const tpl = this.mustTemplate();
    const a = parse(PersonSet, input);
    const t = this.mustAbout(a.who);
    const owner = this.isOwner(t);
    const section = a.section.trim();
    const base = mustField(tpl, section);
    mustOwnerOnly(tpl, base, owner, () => this.ownerNames());
    const spec = specFor(base, owner);
    const visibility = visibilityOf(tpl, t, owner, section);
    const text = a.text.trim();
    const cur = this.currentSection(t.id, section);
    const { lost, of } = cur ? lostLines(cur.text, text) : { lost: 0, of: 0 };
    const res: SectionWrite = { row: cur ?? null, pending: false, lost, of, cleared: false, unchanged: false, because: null, rejected: [] };
    if ((cur?.text ?? "") === text) return { ...res, unchanged: true };
    const why = a.why ?? "";
    // 第一版还在等人批（forcePending 新建的：没有现行的，待批的 supersedes 为空）：再写这个字段也等批、顶掉那个待批，不能当成新建直接上
    const first = cur ? undefined : one<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE about = ? AND section = ? AND kind = 'section' AND status = 'pending' AND supersedes IS NULL", t.id, section);
    const firstWaiting = Boolean(first);
    // 主人的 protect 字段（修订 C）：第一版还在等批时，删了它内容的再写不能顶掉它（不然没批过的那些就从待批里悄悄没了）；
    // 只往上加的照旧成了新的待批。迁移那几份（forcePending）自己改第一版不拦——批的人看的是最后那一版
    if (first && spec.protect && owner && o.forcePending !== true && lostLines(first.text, text).lost > 0) {
      const who = this.ownerNames().join(B.store.sectionOwnerSeparator) || B.store.sectionOwnerFallback;
      throw new Error(B.store.sectionFirstVersionPending(section, who, who));
    }
    const judged = Boolean(cur) && !o.noApproval;
    // 私密字段（R24）：forcePending、第一版等批都不管，直接写成现行的（这个字段上要是有开着的待批，下面直接写时会驳回）
    const secret = spec.private === true || kind(spec) === "detail";
    const because: PendingWhy | null = secret ? null : o.forcePending === true ? "forced" : firstWaiting ? "first" : !judged ? null
      : kind(spec) === "setting" ? "setting"
        : kind(spec) !== "summary" ? null
          : spec.protect && owner && lost > 0 ? "protect"
            : !text ? "cleared" : lost >= 5 && lost * 4 > of ? "lost" : this.sweeping(tpl, t.id, section, batch) ? "sweep" : null;
    const pending = because !== null;
    if (text) {
      const keep = keepHint(spec, owner, () => this.ownerNames());
      checkField(spec, text, { eventExists: (id) => Boolean(this.event(id)), keep });
      this.mustEvidence(section, a.sources);
      // 存成待批时现行的还在：按大的那个算（批不批都不会超）
      const size = Math.max(fieldSize(spec, text), pending && cur ? fieldSize(spec, cur.text) : 0);
      const over = overCap(tpl, owner, cardSizes(tpl, this.impressions(t.id, { status: ["current", "pending"] })), section, size, "write", keep);
      if (over) throw new Error(over);
    } else if (!why.trim()) throw new Error(B.store.sectionClearNeedsWhy(section));
    const row = (id: string, status: string, at: number): Row => ({
      id, about: t.id, kind: "section", section, text, quote_id: null, visibility, status, supersedes: cur?.id ?? null, why,
      sources: sourcesJson(a.sources), created_at: at, updated_at: at,
    });
    if (pending) {
      const prev = one<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE about = ? AND section = ? AND kind = 'section' AND status = 'pending'", t.id, section);
      // 一样的待批不重复提（它替换的还是现在这行才算；过时的就换成新的）
      if (prev && prev.text === text && prev.supersedes === (cur?.id ?? null)) return { ...res, row: prev, pending: true, unchanged: true, because };
      return this.tx(() => {
        const rejected = prev ? [this.rejectImpression(prev.id, B.store.sectionRejectReasonReplaced, batch).id] : [];
        const id = this.nextId("i", 4);
        this.put("impression_set", "mem_impression", row(id, "pending", this.now()), batch, why);
        return { ...res, row: this.impression(id)!, pending: true, because, rejected };
      });
    }
    return this.tx(() => {
      const at = this.now();
      // 直接改了：这个字段上开着的待批（要替换的是被改掉的那行，或者本来就过时了）都批不了了，先驳回（Task 1 留下的，11-04）
      const rejected = all<{ id: string }>(this.db, "SELECT id FROM mem_impression WHERE about = ? AND section = ? AND kind = 'section' AND status = 'pending' ORDER BY id", t.id, section)
        .map((p) => this.rejectImpression(p.id, B.store.sectionRejectReasonEdited, batch).id);
      // 先把旧行标 superseded 再建新行：撤回倒着来，先删新行、再把旧行恢复成现行，不撞「一个字段只有一行现行」
      if (cur) this.put("impression_set", "mem_impression", { ...cur, status: "superseded", updated_at: at }, batch, why);
      if (!text) return { ...res, row: null, cleared: true, rejected };
      const id = this.nextId("i", 4);
      this.put("impression_set", "mem_impression", row(id, "current", at), batch, why);
      return { ...res, row: this.impression(id)!, rejected };
    });
  }

  /**
   * 钉一句原话：原话段照模板（store.peopleTemplate）；speaker 是 self 的只能是这个人自己说的，selfOrMe 的可以是他说的或我说给他的（我→他）。
   * 只能钉原话层里有的；text 是钉的那一段，空白归一后要是原话的一部分（不写就整句）。同一句钉着就返回那一行（existed）。
   * 上限（P21、P22）：每段最多 max 句（主人有 ownerMax 用它，修订 C）；countsTowardTotal 的算进卡的合计；replaceable 的满了用 replaces（这一段现行的一行）换——
   * 旧的标 superseded，原话层里那句还在；不能换的只加不删（不收 replaces），满了回话里带上模板的那一句（fullHintFor：主人和别人可以不一样，R36）。
   * 换下来的那句再钉回来：还是原来那一行，重新现行。没配模板就拒。
   */
  pinQuote(input: unknown, batch: string): { row: ImpressionRow; existed: boolean; replaced: ImpressionRow | null } {
    const tpl = this.mustTemplate();
    const a = parse(QuotePin, input);
    const section = a.section.trim();
    const spec = mustQuote(tpl, section);
    const t = this.mustAbout(a.who);
    const q = this.quoteOf(a.quote);
    const [from = "", to = ""] = q.who.split("→").map((x) => x.replace(/（.*$/, "").trim());
    const his = (name: string): boolean => !isSelfName(name) && this.entity(name)?.id === t.id;
    if (spec.speaker === "self" && !his(from)) throw new Error(B.store.pinSpeakerNotSelf(q.id, q.who, section, t.name));
    if (spec.speaker === "selfOrMe" && !(isSelfName(from) ? his(to) : his(from))) throw new Error(B.store.pinSpeakerNotSelfOrMe(q.id, q.who, section, t.name, t.name));
    const whole = squash(q.text);
    const text = a.text?.trim() ? squash(a.text) : whole;
    if (!whole.includes(text)) throw new Error(B.store.pinTextNotInQuote(q.id, whole.slice(0, 200)));
    const owner = this.isOwner(t);
    const visibility = visibilityOf(tpl, t, owner, section, a.private);
    const fullHint = fullHintFor(spec, owner, t.name);
    const max = quoteMax(spec, owner);
    const dup = one<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE kind = 'quote' AND about = ? AND section = ? AND quote_id = ?", t.id, section, q.id);
    if (a.replaces !== undefined && !spec.replaceable) {
      const can = tpl.quotes.filter((x) => x.replaceable).map((x) => B.store.pinReplaceableSectionName(x.name)).join("");
      throw new Error(B.store.pinSectionNotReplaceable(section, can ? B.store.pinReplacesOnlyFor(can) : "", fullHint ? B.store.pinHintSuffix(fullHint) : ""));
    }
    if (dup?.status === "current") {
      // 要换却已经钉着：说清什么都没换（不然回话会当成换好了）
      if (a.replaces !== undefined) throw new Error(B.store.pinAlreadyPinned(q.id, section, dup.id, a.replaces));
      return { row: dup, existed: true, replaced: null };
    }
    const pins = this.impressions(t.id).filter((r) => r.kind === "quote" && r.section === section);
    const listed = pins.map((r) => B.store.pinListItem(r.id, [...r.text].slice(0, 15).join(""), chars(r.text) > 15 ? "…" : "")).join(B.store.pinListSeparator);
    let old: ImpressionRow | null = null;
    if (a.replaces !== undefined) {
      old = pins.find((r) => r.id === a.replaces) ?? null;
      if (!old) throw new Error(B.store.pinReplacesNotPinned(a.replaces, t.name, section, listed || B.store.pinListEmpty));
    } else if (pins.length >= max) {
      const hint = fullHint ? B.store.pinHintSuffix(fullHint) : "";
      throw new Error(spec.replaceable
        ? B.store.pinSectionFullReplaceable(section, pins.length, max, listed, hint)
        : B.store.pinSectionFullAppendOnly(section, pins.length, max, hint || B.store.pinFullNoReplaceNote));
    }
    if (spec.countsTowardTotal) {
      const sizes = cardSizes(tpl, this.impressions(t.id, { status: ["current", "pending"] }));
      const over = overCap(tpl, owner, sizes, section, (sizes.get(section) ?? 0) - (old ? chars(old.text) : 0) + chars(text), "pin");
      if (over) throw new Error(over);
    }
    return this.tx(() => {
      const at = this.now(), why = a.why ?? "";
      // 先把换下来的标 superseded 再钉新的（撤回倒着来：先撤新的、再把旧的恢复成现行）
      if (old) this.put("impression_pin", "mem_impression", { ...old, status: "superseded", updated_at: at }, batch, why);
      // 同一句只有一行（唯一索引）：以前钉过、被换下来的，就用原来那一行
      const id = dup?.id ?? this.nextId("i", 4);
      this.put("impression_pin", "mem_impression", {
        id, about: t.id, kind: "quote", section, text, quote_id: q.id, visibility, status: "current", supersedes: old?.id ?? null, why,
        sources: sourcesJson(a.sources), created_at: dup?.created_at ?? at, updated_at: at,
      }, batch, why);
      return { row: this.impression(id)!, existed: false, replaced: old ? this.impression(old.id)! : null };
    });
  }

  /**
   * 人批了：待批的换上去，原来的现行行标 superseded；supersedes 为空的（forcePending 新建的）之前没有现行的，直接上。
   * 待批的是「清掉」：这个字段就没了（这一行也标 superseded）
   */
  approveImpression(id: string, batch: string): ImpressionRow {
    const p = this.mustPending(id);
    const cur = this.currentSection(p.about, p.section);
    if ((cur?.id ?? null) !== p.supersedes) throw new Error(B.store.approvePendingOutdated(id, p.supersedes ?? B.store.approveSupersedesNone, cur?.id ?? B.store.approveCurrentNone));
    return this.tx(() => {
      const at = this.now();
      // 先把原来的标 superseded 再换上新的（撤回倒着来不撞唯一索引）
      if (cur) this.put("impression_approve", "mem_impression", { ...cur, status: "superseded", updated_at: at }, batch, B.store.approveReasonCurrent(id));
      this.put("impression_approve", "mem_impression", { ...p, status: p.text ? "current" : "superseded", updated_at: at }, batch, B.store.approveReasonPending);
      return this.impression(id)!;
    });
  }

  /** 驳回待批的：现行的不变；why 记在这一行上 */
  rejectImpression(id: string, why: string, batch: string): ImpressionRow {
    const p = this.mustPending(id);
    const reason = why.trim() || B.store.rejectReasonDefault;
    return this.tx(() => {
      this.put("impression_reject", "mem_impression", { ...p, status: "rejected", why: reason, updated_at: this.now() }, batch, reason);
      return this.impression(id)!;
    });
  }

  // ---------- 批次 ----------
  openBatch(id: string): void {
    this.db.prepare("INSERT INTO mem_batch (id, state, started_at) VALUES (?, 'open', ?) ON CONFLICT(id) DO UPDATE SET state = 'open', started_at = excluded.started_at, ended_at = NULL").run(id, this.now());
  }
  commitBatch(id: string): void {
    this.db.prepare("UPDATE mem_batch SET state = 'committed', ended_at = ? WHERE id = ?").run(this.now(), id);
  }
  batchState(id: string): string | null { return one<{ state: string }>(this.db, "SELECT state FROM mem_batch WHERE id = ?", id)?.state ?? null; }
  openBatches(): string[] { return all<{ id: string }>(this.db, "SELECT id FROM mem_batch WHERE state = 'open' ORDER BY started_at").map((r) => r.id); }
  /** 名字以 prefix 开头、since（毫秒）以后开的、还算数的批次（开着的、提交了的；不含撤回过的和 ~reverted@ 留档），新的在前 */
  liveBatches(prefix: string, since = 0): string[] {
    return all<{ id: string }>(this.db,
      "SELECT id FROM mem_batch WHERE substr(id, 1, length(?)) = ? AND started_at >= ? AND state IN ('open', 'committed') AND instr(id, ?) = 0 ORDER BY started_at DESC, rowid DESC",
      prefix, prefix, since, REVERTED).map((r) => r.id);
  }
  ops(batch: string): OpRow[] { return all<OpRow>(this.db, "SELECT * FROM mem_op WHERE batch = ? ORDER BY id", batch); }
  /** 这一批记了几条 op（只数，不读出来） */
  opCount(batch: string): number { return one<{ n: number }>(this.db, "SELECT count(*) AS n FROM mem_op WHERE batch = ?", batch)?.n ?? 0; }
  /** 有哪些批次（新的在前） */
  batches(limit = 30): Array<{ batch: string; ops: number; first: number; state: string | null }> {
    return all<{ batch: string; ops: number; first: number; state: string | null }>(this.db,
      "SELECT o.batch, count(*) ops, min(o.at) first, b.state FROM mem_op o LEFT JOIN mem_batch b ON b.id = o.batch GROUP BY o.batch ORDER BY first DESC LIMIT ?", limit);
  }

  /**
   * 整批撤回：倒着把每一行恢复成写之前的样子；后面又被改过的行列成冲突、不动。
   * 这一批的记录挪到留档批次 <批次>~reverted@<时间>（连同冲突），原批次名空出来，重开同一天是干净的。
   */
  revertBatch(batch: string): { reverted: number; conflicts: string[] } {
    if (batch.includes(REVERTED)) throw new Error(B.store.revertAlreadyReverted(batch));
    const ops = this.ops(batch).reverse();
    const conflicts: Array<{ op: OpRow; why: string }> = [];
    let reverted = 0;
    this.tx(() => {
      const ents = new Set<string>();
      for (const op of ops) {
        const key = JSON.parse(op.key) as Row;
        const cur = this.get(op.tbl, key);
        if (canon(cur ?? null) !== canon(op.after ? (JSON.parse(op.after) as Row) : null)) {
          conflicts.push({ op, why: B.store.revertConflictChangedLater(op.op, op.tbl, Object.values(key).join("/")) });
          continue;
        }
        // 要删掉的行还被别的批次的东西引用着（别处的条目指向这件事、这个人）：留着，不留孤儿
        if (!op.before && this.referenced(op.tbl, key)) {
          conflicts.push({ op, why: B.store.revertConflictStillReferenced(op.op, op.tbl, Object.values(key).join("/")) });
          continue;
        }
        const back = op.before ? (JSON.parse(op.before) as Row) : null;
        // 恢复回去会和别的批次后来建的行撞唯一索引（一段两行现行）：不动，不然那行会被 INSERT OR REPLACE 悄悄顶掉
        const clash = op.tbl === "mem_impression" && back ? this.impressionClash(back) : null;
        if (clash) {
          conflicts.push({ op, why: B.store.revertConflictSectionClash(op.op, op.tbl, Object.values(key).join("/"), clash) });
          continue;
        }
        this.write(op.tbl, key, back);
        const ref = String(key.id ?? key.event_id ?? key.entry_id ?? "");
        if (/^[en]\d+$/.test(ref)) this.reindex(ref);
        if (op.tbl === "mem_entity") ents.add(String(key.id));
        reverted += 1;
      }
      // 名字、别名回到了原样：挂着这些人和东西的事件，搜索文字跟着重建
      for (const id of ents) for (const r of all<{ event_id: string }>(this.db, "SELECT DISTINCT event_id FROM mem_event_entity WHERE entity_id = ?", id)) this.reindex(r.event_id);
      const t = this.now();
      if (ops.length) {
        const archive = `${batch}${REVERTED}${t}`;
        this.db.prepare("UPDATE mem_op SET batch = ? WHERE batch = ?").run(archive, batch);
        const ins = this.db.prepare("INSERT INTO mem_op (batch, at, op, tbl, key, before, after, reason) VALUES (?, ?, 'revert_conflict', ?, ?, NULL, NULL, ?)");
        for (const c of conflicts) ins.run(archive, t, c.op.tbl, c.op.key, c.why);
        const started = one<{ s: number }>(this.db, "SELECT started_at s FROM mem_batch WHERE id = ?", batch)?.s ?? ops[ops.length - 1]!.at;
        this.db.prepare("INSERT OR REPLACE INTO mem_batch (id, state, started_at, ended_at) VALUES (?, 'reverted', ?, ?)").run(archive, started, t);
      }
      this.db.prepare("INSERT INTO mem_batch (id, state, started_at, ended_at) VALUES (?, 'reverted', ?, ?) ON CONFLICT(id) DO UPDATE SET state = 'reverted', ended_at = excluded.ended_at").run(batch, t, t);
    });
    return { reverted, conflicts: conflicts.map((c) => c.why) };
  }

  markDay(day: string): void { this.db.prepare("INSERT OR REPLACE INTO mem_day (day, done_at) VALUES (?, ?)").run(day, this.now()); }
  dayDone(day: string): boolean { return Boolean(one(this.db, "SELECT 1 FROM mem_day WHERE day = ?", day)); }

  // ---------- 内部 ----------
  /** 这一行现在还被别的行引用吗（撤回时倒着撤，这一批里后建的引用已经先撤掉了，剩下的都是别的批次的） */
  private referenced(tbl: string, key: Row): boolean {
    const q = (sql: string, ...args: string[]) => Boolean(one(this.db, sql, ...args));
    if (tbl === "mem_event") {
      const id = String(key.id);
      return q("SELECT 1 FROM mem_entry WHERE event_id = ? LIMIT 1", id) || q("SELECT 1 FROM mem_link WHERE a = ? OR b = ? LIMIT 1", id, id)
        || q("SELECT 1 FROM mem_event WHERE superseded_by = ? LIMIT 1", id) || q("SELECT 1 FROM mem_event WHERE parent = ? LIMIT 1", id);
    }
    if (tbl === "mem_entity") {
      const id = String(key.id);
      return q("SELECT 1 FROM mem_entry_entity WHERE entity_id = ? LIMIT 1", id) || q("SELECT 1 FROM mem_event_entity WHERE entity_id = ? LIMIT 1", id)
        || q("SELECT 1 FROM mem_impression WHERE about = ? LIMIT 1", id);
    }
    if (tbl === "mem_entry") {
      const id = String(key.id);
      return q("SELECT 1 FROM mem_entry WHERE corrects = ? LIMIT 1", id);
    }
    if (tbl === "mem_impression") return q("SELECT 1 FROM mem_impression WHERE supersedes = ? LIMIT 1", String(key.id));
    return false;
  }

  /**
   * 这一行写进去会不会和别的行撞唯一索引（一个人的一段只有一行现行、同一句原话只钉一次）：撞上的那行编号。
   * INSERT OR REPLACE 撞上会把那行悄悄删掉（也不进 mem_op），所以写之前先查
   */
  private impressionClash(r: Row): string | null {
    const hit = r.kind === "section" && r.status === "current"
      ? one<{ id: string }>(this.db, "SELECT id FROM mem_impression WHERE about = ? AND section = ? AND kind = 'section' AND status = 'current' AND id != ?", String(r.about), String(r.section), String(r.id))
      : r.kind === "quote"
        ? one<{ id: string }>(this.db, "SELECT id FROM mem_impression WHERE about = ? AND section = ? AND quote_id = ? AND kind = 'quote' AND id != ?", String(r.about), String(r.section), Number(r.quote_id), String(r.id))
        : undefined;
    return hit?.id ?? null;
  }

  /**
   * 依据（P23）：sources 里至少一个库里真有的编号——事件 e…、经过 n…、原话 q…（原话层的编号）、#… / c:…（中央记忆序号）。
   * 别的编号（迁移用的旧文件行号，如 aqing#12）可以一起写着，但不算依据
   */
  private mustEvidence(section: string, sources: string[]): void {
    const real = (x: string): boolean => {
      if (/^e\d{4,}$/.test(x)) return Boolean(this.event(x));
      if (/^n\d{5,}$/.test(x)) return Boolean(this.entry(x));
      if (/^q\d+$/.test(x)) return Boolean(one(this.db, "SELECT 1 FROM mem_quote WHERE id = ?", Number(x.slice(1))));
      const c = /^(?:#|c:)(\d+)$/.exec(x);
      return Boolean(c && one(this.db, "SELECT 1 FROM mem_quote WHERE src = 'central' AND ref = ?", c[1]!));
    };
    if (sources.some(real)) return;
    const shaped = (x: string): boolean => /^(e\d{4,}|n\d{5,}|q\d+|#\d+|c:\d+)$/.test(x);
    const missing = sources.filter(shaped), other = sources.filter((x) => !shaped(x));
    throw new Error(B.store.evidenceMissing(section)
      + (missing.length ? B.store.evidenceNotInStore(missing.join(B.store.evidenceShapedSeparator)) : "")
      + (other.length ? B.store.evidenceNotCounted(other.join(B.store.evidenceOtherSeparator)) : ""));
  }

  /** 这一批里这个人改过（或清掉）的设定 / 总结字段连这一个，超过他现行设定 / 总结字段的一半（至少 3 个）：一次改太多，要批。新建的不算 */
  private sweeping(tpl: PeopleTemplate, about: string, section: string, batch: string): boolean {
    const judged = (name: string): boolean => { const f = fieldSpec(tpl, name); return f !== null && kind(f) !== "detail"; };
    const changed = new Set([section]);
    for (const op of all<{ before: string; after: string }>(this.db, "SELECT before, after FROM mem_op WHERE batch = ? AND tbl = 'mem_impression' AND before IS NOT NULL AND after IS NOT NULL", batch)) {
      const b = JSON.parse(op.before) as ImpressionRow, a = JSON.parse(op.after) as ImpressionRow;
      if (b.about === about && b.kind === "section" && b.status === "current" && a.status === "superseded" && judged(b.section)) changed.add(b.section);
    }
    const total = this.impressions(about).filter((r) => r.kind === "section" && judged(r.section)).length;
    return changed.size >= 3 && changed.size * 2 > total;
  }

  private currentSection(about: string, section: string): ImpressionRow | undefined {
    return one<ImpressionRow>(this.db, "SELECT * FROM mem_impression WHERE about = ? AND section = ? AND kind = 'section' AND status = 'current'", about, section);
  }

  /** 人物卡模板；没配就拒（人物卡没开） */
  private mustTemplate(): PeopleTemplate {
    if (!this.peopleTemplate) throw new Error(B.store.cardTemplateNotConfigured);
    return this.peopleTemplate;
  }

  private mustPending(id: string): ImpressionRow {
    const p = this.impression(id);
    if (!p) throw new Error(B.store.pendingNotFound(id));
    if (p.status !== "pending") throw new Error(B.store.pendingNotPending(id, p.status));
    return p;
  }

  /** 人物卡只给人和群 */
  private mustAbout(ref: string): EntityRow {
    const t = this.mustEntity(ref);
    if (t.kind !== "person" && t.kind !== "group") throw new Error(B.store.cardAboutNotPersonOrGroup(t.name, kindLabel(t.kind)));
    return t;
  }

  /** 原话层里的一句：q123 是编号，#123 / c:123 是中央记忆第 123 条那句 */
  private quoteOf(ref: string): { id: number; who: string; text: string } {
    const q = /^q\d+$/.test(ref)
      ? one<{ id: number; who: string; text: string }>(this.db, "SELECT id, who, text FROM mem_quote WHERE id = ?", Number(ref.slice(1)))
      : one<{ id: number; who: string; text: string }>(this.db, "SELECT id, who, text FROM mem_quote WHERE src = 'central' AND ref = ?", ref.replace(/^(#|c:)/, ""));
    if (!q) throw new Error(B.store.pinQuoteNotFound(ref));
    return q;
  }

  /** child（新建时是 null）挂到 parent 下面行不行：parent 在、没被替换或作废、不是自己、不成环，连同 child 下面的层一起不超过三层 */
  private checkParent(child: string | null, parent: string): void {
    const p = this.mustEvent(parent);
    if (p.status === "superseded" || p.status === "retired") throw new Error(B.store.eventParentReplaced(parent));
    if (child === parent) throw new Error(B.store.eventParentIsSelf);
    const up = [p, ...this.ancestors(parent)];
    if (child && up.some((e) => e.id === child)) throw new Error(B.store.eventParentCycle(parent, child));
    // 被替换、不算数了的子事件不算层数（merge、supersede、retire 都把它们留在原处）
    const height = (id: string, d = 0): number => (d > 8 ? d : 1 + Math.max(0, ...this.children(id).filter((c) => !dead(c)).map((c) => height(c.id, d + 1))));
    if (up.length + (child ? height(child) : 1) > 3) throw new Error(B.store.eventParentTooDeep);
  }

  /** 把 child 挂到 parent 下面：还算数的照 checkParent 查（不成环、不超过三层）；被替换、不算数了的照旧直接挂（不算层数） */
  private reparent(child: EventRow, parent: string, op: string, batch: string, reason: string): void {
    if (!dead(child)) this.checkParent(child.id, parent);
    this.put(op, "mem_event", { ...this.event(child.id)!, parent, updated_at: this.now() }, batch, reason);
  }

  private mustEvent(id: string): EventRow {
    const e = this.event(id);
    if (!e) throw new Error(B.store.eventNotFound(id));
    return e;
  }

  /** 没登记过的先登记；她自己不登记（返回 null，不挂） */
  private ensureEntity(name: string, kind: string, batch: string): EntityRow | null {
    if (isSelfName(name)) return null;
    const t = this.entity(name);
    // 写的是人，对上的却是群、地方的别名（群友被写进了群的别名）：不挂到群上
    if (t && kind === "person" && t.kind !== "person" && t.name.toLowerCase() !== name.trim().toLowerCase()) {
      throw new Error(B.store.entityAliasBlocksPerson(name, t.name, kindLabel(t.kind), t.name, name, name));
    }
    return t ?? this.upsertEntity({ name, kind }, batch);
  }

  private mustEntity(ref: string): EntityRow {
    const t = this.entityById(ref) ?? this.entity(ref);
    if (!t) throw new Error(B.store.entityNotRegistered(ref));
    return t;
  }

  /** 这些别名已经是别的人/东西的名字或别名了：不收 */
  private checkAliases(self: EntityRow | null, names: string[]): void {
    for (const x of names) {
      if (isSelfName(x)) throw new Error(B.store.entityAliasIsSelf(x));
      const o = this.entity(x);
      if (o && o.id !== self?.id) throw new Error(B.store.entityAliasTaken(x, o.name, o.name.toLowerCase() === x.toLowerCase() ? "" : B.store.entityAliasOfSuffix, kindLabel(o.kind)));
    }
  }

  /** 编号只增不重用（撤回后也不会把旧编号发给别的事） */
  private nextId(prefix: string, width: number): string {
    const k = `memSeq:${prefix}`;
    const n = Number(kvGet(this.db, k) ?? "0") + 1;
    kvSet(this.db, k, String(n));
    return `${prefix}${String(n).padStart(width, "0")}`;
  }

  private recomputeRange(eventId: string, batch: string): void {
    const ev = this.event(eventId);
    if (!ev) return;
    const r = one<{ s: number | null; e: number | null }>(this.db, "SELECT min(at) s, max(COALESCE(until, at)) e FROM mem_entry WHERE event_id = ? AND kind != 'correction'", eventId);
    const s = r?.s ?? null, e = r?.e ?? null;
    if (s === ev.started_at && e === ev.ended_at) return;
    this.put("range", "mem_event", { ...ev, started_at: s, ended_at: e }, batch, "");
  }

  /** 全文索引：事件 = 标题 + 一句话 + 总结 + 人和东西；条目 = 标题 + 一句话 + 原文 + 人 */
  reindex(ref: string): void {
    this.db.prepare("DELETE FROM mem_fts WHERE ref = ?").run(ref);
    this.db.prepare("DELETE FROM mem_vec WHERE ref = ?").run(ref);   // 内容变了，向量重算
    this.onReindex?.(ref);
    let text = "";
    if (ref.startsWith("e")) {
      const e = this.event(ref);
      if (e) text = [e.title, e.gist, e.summary, ...this.entitiesOf(ref).flatMap((t) => [t.name, ...t.aliases])].join("\n");
    } else {
      const n = this.entry(ref);
      if (n) text = [n.title, n.gist, n.full, ...this.entryPeople(ref)].join("\n");
    }
    if (text) this.db.prepare("INSERT INTO mem_fts (ref, text) VALUES (?, ?)").run(ref, text);
  }

  private get(tbl: string, key: Row): Row | undefined {
    const cols = KEYS[tbl]!;
    return one<Row>(this.db, `SELECT * FROM ${tbl} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`, ...cols.map((c) => key[c] as string));
  }

  private write(tbl: string, key: Row, row: Row | null): void {
    const cols = KEYS[tbl]!;
    if (!row) {
      this.db.prepare(`DELETE FROM ${tbl} WHERE ${cols.map((c) => `${c} = ?`).join(" AND ")}`).run(...cols.map((c) => key[c] as string));
      return;
    }
    const names = Object.keys(row);
    this.db.prepare(`INSERT OR REPLACE INTO ${tbl} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
      .run(...names.map((n) => row[n] as string | number | null));
  }

  /** 一行变化：写进去，并把写前写后记进 mem_op */
  private put(op: string, tbl: string, row: Row | null, batch: string, reason: string, keyIn?: Row): void {
    const key = Object.fromEntries(KEYS[tbl]!.map((c) => [c, (keyIn ?? row)![c]]));
    if (tbl === "mem_impression" && row) {
      const c = this.impressionClash(row);
      if (c) throw new Error(B.store.impressionKeyClash(String(row.id), c));
    }
    const before = this.get(tbl, key) ?? null;
    this.write(tbl, key, row);
    const after = this.get(tbl, key) ?? null;
    this.db.prepare("INSERT INTO mem_op (batch, at, op, tbl, key, before, after, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(batch, this.now(), op, tbl, JSON.stringify(key), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason);
  }

  private tx<T>(fn: () => T): T {
    const sp = `sp${this.depth++}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      const r = fn();
      this.db.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${sp}`);
      this.db.exec(`RELEASE ${sp}`);
      throw e;
    } finally {
      this.depth -= 1;
    }
  }
}

/** 名字 → person_key 索引的缓存时长：她新加的别名最多一分钟后认得出 */
export const ALIAS_INDEX_TTL_MS = 60_000;
/** 每个库句柄一份索引（规则工具 try、gate replay 一次要查成千上万次，不能每次扫表） */
const aliasIndexes = new WeakMap<Db, { builtAt: number; index: Map<string, Set<string>> }>();
/** 和名单 handles 一样的比法：去首尾空白（含全角）、不分大小写（含非 ASCII） */
const aliasNorm = (s: string): string => s.trim().toLowerCase();

/** 读 mem_entity 里有 person_key 的人，建 名字 → person_key 集合。没有这张表（老库、测试库）→ 空索引；别的错（库坏了、表结构不对）抛出 */
function buildAliasIndex(db: Db): Map<string, Set<string>> {
  type R = { name: unknown; aliases: unknown; person_key: unknown };
  let rows: R[];
  try {
    rows = all<R>(db, "SELECT name, aliases, person_key FROM mem_entity WHERE kind = 'person' AND person_key IS NOT NULL AND person_key != ''");
  } catch (e) {
    if (/no such table: mem_entity\b/.test(e instanceof Error ? e.message : String(e))) return new Map();
    throw e;
  }
  const index = new Map<string, Set<string>>();
  for (const r of rows) {
    let aliases: unknown = [];
    try { aliases = JSON.parse(String(r.aliases ?? "[]")); } catch { aliases = []; }   // 别名坏了：这一行只比名字
    for (const x of [r.name, ...(Array.isArray(aliases) ? aliases : [])]) {
      if (typeof x !== "string") continue;
      const k = aliasNorm(x);
      if (!k) continue;
      const keys = index.get(k) ?? new Set<string>();
      keys.add(String(r.person_key));
      index.set(k, keys);
    }
  }
  return index;
}

/**
 * 名字 → 名单上哪个人（person_key）的查找：库里 kind 是 person、有 person_key 的行，名字或任一别名等于它（比法同名单 handles）。
 * 只认唯一的一个 person_key：没有、几个人共用这个名字都是 null（拿不准的名字不认人）。只比名字和别名，不比编号和 person_key。
 * 索引按库句柄缓存 ALIAS_INDEX_TTL_MS（她新加的别名一分钟内生效）。没有 mem_entity 表 → 谁都认不出；
 * 查库出别的错就抛出：控制台据此把聊天全遮（多遮不少遮）；Brain 接住它记一次 warn、当认不出（分流不能断）
 */
export function aliasLookup(db: Db, now: number = Date.now()): (name: string) => string | null {
  let c = aliasIndexes.get(db);
  if (!c || now - c.builtAt >= ALIAS_INDEX_TTL_MS || now < c.builtAt) {
    c = { builtAt: now, index: buildAliasIndex(db) };
    aliasIndexes.set(db, c);
  }
  const index = c.index;
  return (name) => {
    const keys = index.get(aliasNorm(name));
    return keys?.size === 1 ? [...keys][0]! : null;
  };
}

/** 名字 → person_key（见 aliasLookup）；空名字、认不出、拿不准、查库出任何错都是 null，不抛。now 给测试和 Brain 的钟用 */
export function personKeyByName(db: Db, name: string, now: number = Date.now()): string | null {
  if (!aliasNorm(name)) return null;
  try { return aliasLookup(db, now)(name); } catch { return null; }
}

function toEntity(r: Row): EntityRow {
  return {
    id: String(r.id), kind: r.kind as EntityRow["kind"], name: String(r.name), aliases: JSON.parse(String(r.aliases ?? "[]")) as string[],
    person_key: (r.person_key as string | null) ?? null, note: String(r.note ?? ""),
    importance: r.importance === null || r.importance === undefined ? null : Number(r.importance), why: String(r.why ?? ""),
  };
}

/** 出处：#N（压缩块、折叠行里的编号）就是中央记忆第 N 条，记成 c:N */
const sourcesJson = (xs: string[]): string => JSON.stringify(xs.map((s) => (/^#\d+$/.test(s) ? `c:${s.slice(1)}` : s)).sort());
/** 空白归一：连续的空白（含换行）算一个空格 */
const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 比较两行：键排序后的 JSON；值是 null 的键和没有这个键一样（后来加的列，老记录里没有） */
function canon(r: Row | null): string {
  if (!r) return "null";
  return JSON.stringify(Object.keys(r).filter((k) => r[k] !== null && r[k] !== undefined).sort().map((k) => [k, r[k]]));
}
