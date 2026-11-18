// 记忆工具：白天想起事情（remember / recall_person / recall_event / recall_period），白天当场记喜欢 / 烦的东西（like / my_likes），
// 夜里整理时海马写事件库和人物卡（mem_*，白天调会被拒绝）。
import { z } from "zod";
import type { ToolDef } from "../kernel/types.ts";
import type { EventMemory, LikeHow, WriteOp } from "../memory/events/memory.ts";
import { ENTITY_KINDS, KINDS, RELS, ROLES, STATUSES } from "../memory/events/schema.ts";
import { describeTemplate } from "../memory/events/people.ts";
import { B, T } from "../lang/index.ts";

const entity = z.object({ name: z.string(), kind: z.enum(ENTITY_KINDS).optional(), role: z.enum(ROLES).optional() });

/** 潜意识（deep）、记忆体检（exam）翻事情不算碰过：她自己没有回想，不让这件事因此变清楚、变热 */
const SUBCONSCIOUS = new Set(["deep", "exam", "importer"]);
/** 记忆体检（exam）、口味搬家（importer）翻事情一点痕迹都不留：被想起的次数会影响联想排序，体检不能自己弄脏自己 */
const NO_TRACE = new Set(["exam", "importer"]);
/** 夜里分段整理的核依据会话（audit-<日>-<段>-<次>-<第几次>）是在核对、不是她在回想：和体检一样不留痕迹、不让事情变清楚；各段（sleep-*）照海马 */
/** 夜里考试的会话（exam-*）也一样：考生答题、判分都不该留痕迹 */
/** 多人模式的交叉审（review-*）、前额叶（coord-*）也一样：是在审、在定，不是她在回想 */
/** 专员 + 领导模式的领导（lead-<日>）也一样：是在看、在定，不是她在回想 */
const isAudit = (region: string): boolean => region.startsWith("audit-") || region.startsWith("exam-") || region.startsWith("review-") || region.startsWith("coord-") || region.startsWith("lead-");
const subconscious = (region: string): boolean => SUBCONSCIOUS.has(region) || isAudit(region);
const noTrace = (region: string): boolean => NO_TRACE.has(region) || isAudit(region);

function guard(fn: () => string | Promise<string>): Promise<string> {
  try { return Promise.resolve(fn()).catch((e: unknown) => T.mem.failed(e instanceof Error ? e.message : String(e))); }
  catch (e) { return Promise.resolve(T.mem.threw(e instanceof Error ? e.message : String(e))); }
}

/** 交给把关的一条候选（learn_check） */
const checkCandidate = () => z.object({
  kind: z.enum([B.forms.checkKinds.made, B.forms.checkKinds.practice, B.forms.checkKinds.lesson]),
  page: z.string().describe(T.learn_check.params.page),
  text: z.string(),
  evidence: z.string().describe(T.learn_check.params.evidence),
});
export type CheckCandidate = z.infer<ReturnType<typeof checkCandidate>>;

/** 学习这一块夜里给海马的（没接学习时不传）：工作单是 LearningRuntime 的；把关是 Brain 另开一个会话去判，check 开了就返回 */
export interface LearnNight {
  worklist(day: string): Promise<string>;
  /** requester：调 learn_check 的那个会话（脑区 id）；结论回来叫醒它（夜里分段整理时是那一段的会话，旧的整理是海马） */
  check(day: string, candidates: CheckCandidate[], requester: string): string;
}

export function memTools(mem: EventMemory | undefined, regionId: string, allowed: readonly string[], learn?: LearnNight): ToolDef[] {
  // 学习的工作单、把关都不靠事件库：没有事件库也照样给
  const learnWorklist: ToolDef = {
    name: "learn_worklist",
    description: T.learn_worklist.description,
    shape: { day: z.string() },
    handler: (a) => guard(() => (learn ? learn.worklist(String(a.day)) : T.learn_worklist.off)),
  };
  const learnCheck: ToolDef = {
    name: "learn_check",
    description: T.learn_check.description,
    shape: { day: z.string(), candidates: z.array(checkCandidate()) },
    handler: (a) => guard(() => (learn ? learn.check(String(a.day), a.candidates as CheckCandidate[], regionId) : T.learn_check.off)),
  };
  if (!mem) return [learnWorklist, learnCheck].filter((t) => allowed.includes(t.name));
  const w = (op: WriteOp) => (a: Record<string, unknown>) => guard(() => mem.write(op, a, regionId));
  /** 人物卡两个工具：白天照旧「没做成：…」；能写的时候被拒，回 fail + 原因原样（字段、数字、怎么办；P30 给小 agent 看） */
  const card = (op: WriteOp, fail: string) => (a: Record<string, unknown>) => guard(() => {
    if (!mem.writable(regionId)) return mem.write(op, a, regionId);
    try { return mem.write(op, a, regionId); } catch (e) { return `${fail}${e instanceof Error ? e.message : String(e)}`; }
  });
  const tpl = mem.store.peopleTemplate;
  const time = z.string().describe(T.mem.time);
  const newEvent = {
    title: z.string().describe(T.newEvent.title),
    summary: z.string().describe(T.newEvent.summary),
    gist: z.string().describe(T.newEvent.gist),
    why: z.string().optional().describe(T.newEvent.why),
    importance: z.number().int().min(0).max(5).describe(T.newEvent.importance),
    status: z.enum(STATUSES).optional(),
    pinned: z.boolean().optional().describe(T.newEvent.pinned),
    entities: z.array(entity).optional().describe(T.newEvent.entities),
    next: z.string().optional().describe(T.newEvent.next),
    parent: z.string().optional().describe(T.newEvent.parent),
    stance: z.enum(["like", "dislike"]).optional().describe(T.newEvent.stance),
    thread_path: z.string().optional(),
  };
  const all: ToolDef[] = [
    {
      name: "remember",
      description: T.remember.description,
      shape: { cue: z.string(), who: z.string().optional(), from: z.string().optional(), to: z.string().optional() },
      handler: (a) => guard(() => mem.remember(String(a.cue), { ...(a.who ? { who: String(a.who) } : {}), ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}), region: regionId, ...(noTrace(regionId) ? { touch: false } : {}) })),
    },
    {
      name: "recall_person",
      description: T.recall_person.description,
      shape: { who: z.string().describe(T.recall_person.params.who), n: z.number().int().min(1).max(10).optional() },
      handler: (a) => guard(() => mem.recallPerson(String(a.who), a.n === undefined ? undefined : Number(a.n), noTrace(regionId) ? { touch: false } : {})),
    },
    {
      name: "recall_event",
      description: T.recall_event.description,
      shape: { ref: z.string(), from: z.string().optional(), to: z.string().optional() },
      handler: (a) => guard(() => mem.recallEvent(String(a.ref), { ...(a.from ? { from: String(a.from) } : {}), ...(a.to ? { to: String(a.to) } : {}), region: regionId, ...(subconscious(regionId) ? { clearing: false } : {}), ...(noTrace(regionId) ? { touch: false } : {}) })),
    },
    {
      name: "recall_period",
      description: T.recall_period.description,
      shape: { when: z.string(), who: z.string().optional(), min_importance: z.number().int().min(0).max(5).optional(), page: z.number().int().min(1).optional() },
      handler: (a) => guard(() => mem.recallPeriod(String(a.when), { ...(a.who ? { who: String(a.who) } : {}), ...(a.min_importance !== undefined ? { minImportance: Number(a.min_importance) } : {}), ...(a.page ? { page: Number(a.page) } : {}) })),
    },
    {
      name: "like",
      description: T.like.description,
      shape: {
        what: z.string().describe(T.like.params.what),
        how: z.enum(["like", "dislike", "feel", "over", "again", "fix", "drop"]).describe(T.like.params.how),
        feeling: z.string().optional().describe(T.like.params.feeling),
        title: z.string().optional().describe(T.like.params.title),
        gist: z.string().optional().describe(T.like.params.gist),
        why: z.string().optional().describe(T.like.params.why),
        event: z.string().optional().describe(T.like.params.event),
        importance: z.number().int().min(0).max(5).optional().describe(T.like.params.importance),
        new: z.boolean().optional().describe(T.like.params.new),
      },
      // 海马、导入、体检、潜意识、随口、下意识就算名单里有 like 也记不了：EventMemory.like 按脑区拒绝
      handler: (a) => guard(() => mem.likeWithMeaning({
        what: String(a.what ?? ""), how: a.how as LikeHow,
        ...(typeof a.feeling === "string" ? { feeling: a.feeling } : {}), ...(typeof a.title === "string" ? { title: a.title } : {}),
        ...(typeof a.gist === "string" ? { gist: a.gist } : {}), ...(typeof a.why === "string" ? { why: a.why } : {}),
        ...(a.event ? { event: String(a.event) } : {}), ...(a.importance !== undefined ? { importance: Number(a.importance) } : {}), ...(a.new === true ? { new: true } : {}),
      }, { region: regionId })),
    },
    {
      name: "my_likes",
      description: T.my_likes.description,
      shape: { page: z.number().int().min(1).optional().describe(T.my_likes.params.page) },
      handler: (a) => guard(() => mem.myLikes(a.page === undefined ? 1 : Number(a.page))),
    },
    {
      name: "mem_worklist",
      description: T.mem_worklist.description,
      shape: { day: z.string().describe("YYYY-MM-DD") },
      handler: (a) => guard(() => mem.worklist(String(a.day))),
    },
    learnWorklist,
    learnCheck,
    {
      name: "mem_event_create",
      description: T.mem_event_create.description,
      shape: { ...newEvent, reason: z.string().optional() },
      handler: w("mem_event_create"),
    },
    {
      name: "mem_event_update",
      description: T.mem_event_update.description,
      shape: { id: z.string(), title: z.string().optional(), summary: z.string().optional(), gist: z.string().optional(), why: z.string().optional(), importance: z.number().int().min(0).max(5).optional(), status: z.enum(STATUSES).optional(), pinned: z.boolean().optional(), next: z.string().optional().describe(T.mem_event_update.params.next), parent: z.string().optional().describe(T.mem_event_update.params.parent), stance: z.enum(["like", "dislike", ""]).optional().describe(T.mem_event_update.params.stance), reason: z.string().describe(T.mem_event_update.params.reason) },
      handler: w("mem_event_update"),
    },
    {
      name: "mem_entry_add",
      description: T.mem_entry_add.description,
      shape: { event: z.string(), at: time, until: time.optional(), kind: z.enum(KINDS.filter((k) => k !== "correction") as [string, ...string[]]).optional(), full: z.string().optional().describe(T.mem_entry_add.params.full), gist: z.string(), title: z.string(), people: z.array(z.string()).optional().describe(T.mem.people), source: z.array(z.string()).optional() },
      handler: w("mem_entry_add"),
    },
    {
      name: "mem_entries_add",
      description: T.mem_entries_add.description,
      shape: {
        event: z.string(),
        entries: z.array(z.object({ at: time, until: time.optional(), kind: z.enum(KINDS.filter((k) => k !== "correction") as [string, ...string[]]).optional(), full: z.string().optional().describe(T.mem_entries_add.params.full), gist: z.string(), title: z.string(), people: z.array(z.string()).optional().describe(T.mem.people), source: z.array(z.string()).optional() })),
      },
      handler: w("mem_entries_add"),
    },
    {
      name: "mem_entry_correct",
      description: T.mem_entry_correct.description,
      shape: { id: z.string().describe(T.mem_entry_correct.params.id), full: z.string(), gist: z.string(), title: z.string(), why: z.string().describe(T.mem_entry_correct.params.why) },
      handler: w("mem_entry_correct"),
    },
    {
      name: "mem_link",
      description: T.mem_link.description,
      shape: { a: z.string(), b: z.string(), rel: z.enum(RELS), note: z.string().optional() },
      handler: w("mem_link"),
    },
    { name: "mem_unlink", description: T.mem_unlink.description, shape: { a: z.string(), b: z.string(), rel: z.enum(RELS), reason: z.string() }, handler: w("mem_unlink") },
    { name: "mem_merge", description: T.mem_merge.description, shape: { keep: z.string(), others: z.array(z.string()), reason: z.string() }, handler: w("mem_merge") },
    {
      name: "mem_split", description: T.mem_split.description,
      shape: { id: z.string(), entries: z.array(z.string()), event: z.object(newEvent), reason: z.string(), under: z.boolean().optional().describe(T.mem_split.params.under) }, handler: w("mem_split"),
    },
    { name: "mem_supersede", description: T.mem_supersede.description, shape: { old: z.string(), by: z.string(), reason: z.string() }, handler: w("mem_supersede") },
    { name: "mem_retire", description: T.mem_retire.description, shape: { id: z.string(), reason: z.string() }, handler: w("mem_retire") },
    {
      name: "mem_entity_upsert",
      description: T.mem_entity_upsert.description,
      shape: {
        name: z.string(), kind: z.enum(ENTITY_KINDS).optional().describe(T.mem_entity_upsert.params.kind),
        aliases: z.array(z.string()).optional(), person_key: z.string().optional(), note: z.string().optional(),
        importance: z.number().int().min(0).max(5).optional().describe(T.mem_entity_upsert.params.importance),
        why: z.string().optional().describe(T.mem_entity_upsert.params.why),
        remove_aliases: z.array(z.string()).optional().describe(T.mem_entity_upsert.params.remove_aliases),
      },
      handler: w("mem_entity_upsert"),
    },
    {
      name: "mem_entity_merge", description: T.mem_entity_merge.description,
      shape: { keep: z.string(), others: z.array(z.string()), reason: z.string() }, handler: w("mem_entity_merge"),
    },
    {
      name: "mem_entity_tag", description: T.mem_entity_tag.description,
      shape: { name: z.string(), to: z.string().describe(T.mem_entity_tag.params.to), role: z.enum(ROLES).optional().describe(T.mem_entity_tag.params.role), reason: z.string().optional() },
      handler: w("mem_entity_tag"),
    },
    {
      name: "mem_entity_drop", description: T.mem_entity_drop.description,
      shape: { name: z.string(), reason: z.string() }, handler: w("mem_entity_drop"),
    },
    { name: "mem_day_done", description: T.mem_day_done.description, shape: { day: z.string() }, handler: w("mem_day_done") },
    {
      name: "mem_person_set",
      description: `${T.mem_person_set.description}\n${tpl ? describeTemplate(tpl) : T.mem.noTemplate}`,
      shape: {
        who: z.string().describe(T.mem_person_set.params.who),
        section: z.string().describe(T.mem_person_set.params.section),
        text: z.string().describe(T.mem_person_set.params.text),
        why: z.string().optional().describe(T.mem_person_set.params.why),
        sources: z.array(z.string()).optional().describe(T.mem_person_set.params.sources),
      },
      handler: card("mem_person_set", T.mem_person_set.notWritten),
    },
    {
      name: "mem_quote_pin",
      description: `${T.mem_quote_pin.description}\n${tpl ? describeTemplate(tpl, { only: "quotes" }) : T.mem.noTemplate}`,
      shape: {
        who: z.string().describe(T.mem_quote_pin.params.who),
        section: z.string().describe(T.mem_quote_pin.params.section),
        quote: z.string().describe(T.mem_quote_pin.params.quote),
        text: z.string().optional().describe(T.mem_quote_pin.params.text),
        why: z.string().optional().describe(T.mem_quote_pin.params.why),
        private: z.boolean().optional().describe(T.mem_quote_pin.params.private),
        replaces: z.string().optional().describe(T.mem_quote_pin.params.replaces),
        sources: z.array(z.string()).optional(),
      },
      handler: card("mem_quote_pin", T.mem_quote_pin.notPinned),
    },
  ];
  return all.filter((t) => allowed.includes(t.name));
}

export const MEM_READ_TOOLS = ["remember", "recall_person", "recall_event", "recall_period"] as const;
/** 白天记喜好、看全部：只给白天那几头（主线、一心多用） */
export const MEM_LIKE_TOOLS = ["like", "my_likes"] as const;
/** 夜里整理（海马）和导入者的工具：写事件库，还有人物卡（mem_person_set、mem_quote_pin；白天写一律被拒） */
export const MEM_WRITE_TOOLS = ["mem_worklist", "mem_event_create", "mem_event_update", "mem_entry_add", "mem_entries_add", "mem_entry_correct", "mem_link", "mem_unlink", "mem_merge", "mem_split", "mem_supersede", "mem_retire", "mem_entity_upsert", "mem_entity_merge", "mem_entity_drop", "mem_entity_tag", "mem_day_done", "mem_person_set", "mem_quote_pin"] as const;
/** 真写事件库（人物卡）的：MEM_WRITE_TOOLS 去掉只读的工作单。夜里分段整理按它算一段写不写事件库（两段都写就不同时跑） */
export const MEM_STORE_WRITERS: readonly string[] = MEM_WRITE_TOOLS.filter((t) => t !== "mem_worklist");
