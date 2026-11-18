// 人物卡 = 通用印象表 mem_impression 的一种：一个字段一行，钉住的原话也是一行。
// 卡是固定大小的：只放抽象的关系和感觉，字段都小、有上限，写的时候超了就拒；
// 发生过的事不进卡——现算段渲染时从事件库现算，不存。
// 这里只有通用的机制（R17：HH 是框架，一个角色是它的一个实现）：模板的结构和校验、写法和大小的检查、可见性，
// 还有卡和近况的渲染、导出（ledger/people/）。哪些字段、什么类型、上限多少、哪个私密，都在模板里——
// 模板放 HH 配置（memory.people.template），不在夜里能改的文件里：HH 按字段的类型决定要不要等人批、按上限拒写。
// 主人（名单上 privacy 是 owner 的人）由调用的一方认了传进来。
// 渲染只用库里的绝对时间和她的一天（04:00 起）：同样的库、同一个「她的一天」里同样的字节。
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, one } from "../../store/db.ts";
import { localToUtc } from "./schema.ts";
import type { EntityRow, ImpressionRow } from "./schema.ts";
import type { EventStore } from "./store.ts";
import { B } from "../../lang/index.ts";
import { LAYOUT } from "../../persona/layout.ts";

// ---------- 模板 ----------
/** setting: a change to a current one always waits for approval; summary: losing lines, or changing over half in a batch,
 * waits; detail: never waits. A template writes the key or its name in the role's pack (a Chinese one: 设定 / 总结 / 详情) */
export type FieldType = "setting" | "summary" | "detail";
/** A field's type as its template wrote it (shown as written); kind() says which it is */
export type FieldTypeWritten = string;
/** 主人的卡用的上限（修订 C）：有的键盖掉字段上的同名上限；只收这个字段的写法收的数字键 */
export interface OwnerLimits { maxChars?: number; maxSentences?: number; maxItems?: number; itemMaxChars?: number }
/** 一个能写的字段（mem_person_set） */
export interface FieldSpec {
  name: string;
  type: FieldTypeWritten;
  shape: "text" | "list" | "line";
  /** text：整段；line：整行 */
  maxChars?: number;
  /** text：按 。！？!? 切的非空句子数 */
  maxSentences?: number;
  /** list：条数（每个非空行以「- 」开头） */
  maxItems?: number;
  /** list：每条字数（不算「- 」） */
  itemMaxChars?: number;
  /** list：每条必须含的字（比如「〔推断〕」） */
  itemMustContain?: string;
  /** line：整行要匹配的正则源（用 u 标志） */
  pattern?: string;
  /** line：格式不对时回话里说的写法 */
  patternHint?: string;
  /** 总是 private:<key>；只有名单上、不是主人的人能写 */
  private?: boolean;
  /** 主人的卡用这些上限（盖掉上面同名的）；别人照上面的 */
  owner?: OwnerLimits;
  /** 只有主人的卡有：别人写拒。可以和现算段同名——主人的卡用存着的这一段、不现算，别人的照旧现算 */
  ownerOnly?: boolean;
  /** 只对主人：会删掉内容的改动（旧文的任何一个非空行 trim 后在新文里找不到，含清掉）一律等批；纯添加照类型的规矩 */
  protect?: boolean;
  /** list：每条都要带事件编号「（e0123）」，编号库里要有 */
  requireEvent?: boolean;
}
/** 原话段：只能钉原话层里有的原话（mem_quote_pin），不能写 */
export interface QuoteSpec {
  name: string;
  max: number;
  countsTowardTotal: boolean;
  /** 满了能不能用 replaces 换；不能换的只加不删（并人时也不挤掉） */
  replaceable: boolean;
  /** 主人的卡用的句数上限（没有就也是 max） */
  ownerMax?: number;
  /** self：只能钉这个人自己说的；selfOrMe：这个人说的或「我」说给他的 */
  speaker: "self" | "selfOrMe";
  /**
   * 满了时回话里加的一句（比如人格自己的规矩），可以没有。有 fullHintOthers 时只给主人用；
   * fullHintOthers：给别人（不是主人的人和群）用的那一句（R36：访客的原话不往主人的提案里写），没有就别人也用 fullHint。
   * 两句里的「<名字>」回话时换成这个人的名字
   */
  fullHint?: string;
  fullHintOthers?: string;
}
export interface PeopleTemplate {
  /** 卡里的顺序：字段、原话段、现算段的名字混排（主人专有的字段和现算段同名时只出现一次） */
  order: string[];
  fields: FieldSpec[];
  quotes: QuoteSpec[];
  computed: {
    bigEvents: { name: string; minImportance: number; max: number };
    near: { name: string; days: number; max: number };
  };
  totalCap: number;
  ownerTotalCap: number;
  /** 没有存着的字段时，重要度到这个数、又有现算内容才出卡 */
  computedOnlyMinImportance: number;
  /**
   * 工作单第 8 节「最近常打交道」那一行（群友天天聊熟了，重要度该升、该有卡）：最近 days 天（她的一天）里
   * 出现在 ≥ minDays 天的经过里、重要度还不到 computedOnlyMinImportance 的人和群列出来，夜里照人的尺子看要不要升。没配就不列
   */
  promote?: { days: number; minDays: number };
}

const FIELD_TYPES: readonly FieldType[] = ["setting", "summary", "detail"];
/** a field's type as its template wrote it: the key, or its name in the role's pack */
const typeOf = (v: unknown): FieldType | undefined => FIELD_TYPES.find((t) => v === t || v === B.eventsPeople.fieldTypeName[t]);
const typeName = (t: FieldType): string => B.eventsPeople.fieldTypeName[t];
/** which type a field is, whichever way its template wrote it (parseTemplate has checked it is one) */
export const kind = (f: Pick<FieldSpec, "type">): FieldType => typeOf(f.type)!;
const SHAPES: ReadonlyArray<FieldSpec["shape"]> = ["text", "list", "line"];
/** 每种写法要哪些参数、还收哪些；line 至少要 maxChars、pattern 里的一个 */
const SHAPE_KEYS: Record<FieldSpec["shape"], { need: string[]; may: string[] }> = {
  text: { need: ["maxChars"], may: ["maxSentences"] },
  list: { need: ["maxItems", "itemMaxChars"], may: ["itemMustContain"] },
  line: { need: [], may: ["maxChars", "pattern", "patternHint"] },
};
const NUMBER_KEYS = new Set(["maxChars", "maxSentences", "maxItems", "itemMaxChars"]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** 读一个对象：类型不对、多了不认识的键就抛错（where 说是哪一项） */
function reader(v: unknown, where: string, keys: readonly string[]) {
  const fail = (what: string): never => { throw new Error(B.eventsPeople.templateInvalid(where, what)); };
  if (!isObj(v)) fail(B.eventsPeople.templateNotObject);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!keys.includes(k)) fail(B.eventsPeople.templateUnknownKey(k));
  const has = (k: string): boolean => o[k] !== undefined;
  const str = (k: string): string => {
    const x = o[k];
    return typeof x === "string" && x.trim() && !/[\r\n]/.test(x) ? x : fail(B.eventsPeople.templateNeedLine(k, JSON.stringify(x)));
  };
  const int = (k: string): number => {
    const x = o[k];
    return typeof x === "number" && Number.isInteger(x) && x > 0 ? x : fail(B.eventsPeople.templateNeedPositiveInt(k, JSON.stringify(x)));
  };
  const bool = (k: string): boolean => (typeof o[k] === "boolean" ? (o[k] as boolean) : fail(B.eventsPeople.templateNeedBool(k, JSON.stringify(o[k]))));
  const oneOf = <T extends string>(k: string, xs: readonly T[]): T => (xs.includes(o[k] as T) ? (o[k] as T) : fail(B.eventsPeople.templateNeedOneOf(k, xs.join(" / "), JSON.stringify(o[k]))));
  const list = (k: string): unknown[] => (Array.isArray(o[k]) ? (o[k] as unknown[]) : fail(B.eventsPeople.templateNeedArray(k)));
  /** 名字：写的时候段名会 trim，前后带空白的段永远写不进 */
  const name = (): string => { const x = str("name"); return x === x.trim() ? x : fail(B.eventsPeople.templateNameWhitespace(JSON.stringify(x))); };
  return { o, fail, has, str, int, bool, oneOf, list, name };
}
/** 数组里第 i 项的名字（报错时说是哪一个） */
const label = (what: string, i: number, v: unknown): string => B.eventsPeople.templateWhereItem(what, i, isObj(v) && typeof v.name === "string" ? B.eventsPeople.templateWhereNameTag(v.name) : "");

function parseField(v: unknown, i: number): FieldSpec {
  const keysOf = (s: FieldSpec["shape"]): string[] => [...SHAPE_KEYS[s].need, ...SHAPE_KEYS[s].may];
  const all = SHAPES.flatMap(keysOf);
  const r = reader(v, label("fields", i, v), ["name", "type", "shape", "private", "owner", "ownerOnly", "protect", "requireEvent", ...all]);
  const shape = r.oneOf("shape", SHAPES);
  const mine = keysOf(shape);
  for (const k of all) if (r.has(k) && !mine.includes(k)) r.fail(B.eventsPeople.templateFieldKeyWrongShape(shape, k, SHAPES.filter((s) => keysOf(s).includes(k)).join(" / ")));
  const f: FieldSpec = { name: r.name(), type: typeOf(r.o.type) ? r.o.type as string : r.fail(B.eventsPeople.templateNeedOneOf("type", FIELD_TYPES.map(typeName).join(" / "), JSON.stringify(r.o.type))), shape };
  for (const k of mine) {
    if (!r.has(k)) {
      if (SHAPE_KEYS[shape].need.includes(k)) r.fail(B.eventsPeople.templateFieldKeyMissing(shape, k));
      continue;
    }
    (f as unknown as Record<string, unknown>)[k] = NUMBER_KEYS.has(k) ? r.int(k) : r.str(k);
  }
  if (shape === "line" && f.maxChars === undefined && f.pattern === undefined) r.fail(B.eventsPeople.templateLineNeedsLimit);
  if (f.pattern !== undefined) {
    try { new RegExp(f.pattern, "u"); } catch (e) { r.fail(B.eventsPeople.templatePatternInvalid(e instanceof Error ? e.message : String(e))); }
    // 写法不对时回话里只能说「要整行对上 /正则/」，写的一方看不懂：要有一句人话
    if (f.patternHint === undefined) r.fail(B.eventsPeople.templatePatternNeedsHint);
  }
  if (r.has("private")) f.private = r.bool("private");
  if (r.has("owner")) {
    // 主人的放宽：只收这个写法的数字键（list：maxItems、itemMaxChars；text：maxChars、maxSentences；line：maxChars）
    const nums = mine.filter((k) => NUMBER_KEYS.has(k));
    const o = reader(r.o.owner, B.eventsPeople.templateOwnerWhere(label("fields", i, v)), nums);
    const keys = nums.filter((k) => o.has(k));
    if (!keys.length) o.fail(B.eventsPeople.templateOwnerNeedsLimit(nums.join(" / ")));
    f.owner = Object.fromEntries(keys.map((k) => [k, o.int(k)])) as OwnerLimits;
  }
  if (r.has("ownerOnly")) f.ownerOnly = r.bool("ownerOnly");
  if (r.has("protect")) f.protect = r.bool("protect");
  if (r.has("requireEvent")) {
    f.requireEvent = r.bool("requireEvent");
    if (f.requireEvent && shape !== "list") r.fail(B.eventsPeople.templateRequireEventListOnly);
  }
  // 主人没有私密字段；私密、详情的字段永远不等批（R24），protect 在它们上面没用
  if (f.ownerOnly && f.private) r.fail(B.eventsPeople.templateOwnerOnlyNotPrivate);
  if (f.protect && (f.private || kind(f) === "detail")) r.fail(B.eventsPeople.templateProtectNotPrivateOrDetail);
  return f;
}

function parseQuote(v: unknown, i: number): QuoteSpec {
  const r = reader(v, label("quotes", i, v), ["name", "max", "countsTowardTotal", "replaceable", "speaker", "ownerMax", "fullHint", "fullHintOthers"]);
  const q: QuoteSpec = { name: r.name(), max: r.int("max"), countsTowardTotal: r.bool("countsTowardTotal"), replaceable: r.bool("replaceable"), speaker: r.oneOf("speaker", ["self", "selfOrMe"] as const) };
  if (r.has("ownerMax")) q.ownerMax = r.int("ownerMax");
  if (r.has("fullHint")) q.fullHint = r.str("fullHint");
  if (r.has("fullHintOthers")) q.fullHintOthers = r.str("fullHintOthers");
  return q;
}

/** 这个原话段满了时回话里加的那一句：主人用 fullHint，别人用 fullHintOthers（没有就也用 fullHint）；「<名字>」换成 name。没有是空字符串 */
export function fullHintFor(q: QuoteSpec, owner: boolean, name: string): string {
  const hint = owner ? q.fullHint : q.fullHintOthers ?? q.fullHint;
  return hint ? hint.replaceAll(B.eventsPeople.namePlaceholder, name) : "";
}

/**
 * 配置里的模板 → PeopleTemplate：校验名字不重复（只有主人专有的字段可以和现算段同名）、order 正好覆盖全部字段 / 原话段 / 两个现算段、
 * 每个名字只出现一次、数字是正整数、pattern 能编译、shape 和它的参数对得上、没有不认识的键；不合格就抛错，说是哪一项。
 * 返回的是一份新的（只有认得的键）。
 */
export function parseTemplate(raw: unknown): PeopleTemplate {
  const r = reader(raw, "", ["order", "fields", "quotes", "computed", "totalCap", "ownerTotalCap", "computedOnlyMinImportance", "promote"]);
  const fields = r.list("fields").map(parseField);
  const quotes = r.list("quotes").map(parseQuote);
  const c = reader(r.o.computed, B.eventsPeople.templateComputedWhere, ["bigEvents", "near"]);
  const b = reader(c.o.bigEvents, B.eventsPeople.templateBigEventsWhere(isObj(c.o.bigEvents) && typeof c.o.bigEvents.name === "string" ? B.eventsPeople.templateWhereNameTag(c.o.bigEvents.name) : ""), ["name", "minImportance", "max"]);
  const n = reader(c.o.near, B.eventsPeople.templateNearWhere(isObj(c.o.near) && typeof c.o.near.name === "string" ? B.eventsPeople.templateWhereNameTag(c.o.near.name) : ""), ["name", "days", "max"]);
  const comp = { bigEvents: { name: b.name(), minImportance: b.int("minImportance"), max: b.int("max") }, near: { name: n.name(), days: n.int("days"), max: n.int("max") } };
  const compNames = [comp.bigEvents.name, comp.near.name];
  const names = [...fields.map((f) => f.name), ...quotes.map((q) => q.name), ...compNames];
  // 主人专有的字段和一个现算段同名（正好这两个）：主人的卡用存着的，别人的照旧现算——不算重复
  const shared = (x: string): boolean => names.filter((y) => y === x).length === 2 && compNames.includes(x) && fields.some((f) => f.name === x && f.ownerOnly);
  const dup = names.find((x, i) => names.indexOf(x) !== i && !shared(x));
  if (dup !== undefined) r.fail(B.eventsPeople.templateNameDuplicate(dup));
  const order = r.list("order").map((x, i) => (typeof x === "string" ? x : r.fail(B.eventsPeople.templateOrderItemNotString(i))));
  for (const [i, x] of order.entries()) {
    if (!names.includes(x)) r.fail(B.eventsPeople.templateOrderUnknownName(x));
    if (order.indexOf(x) !== i) r.fail(B.eventsPeople.templateOrderDuplicate(x));
  }
  const missing = names.filter((x) => !order.includes(x));
  if (missing.length) r.fail(B.eventsPeople.templateOrderMissing(missing.join(B.eventsPeople.templateOrderNamesJoiner)));
  let promote: PeopleTemplate["promote"];
  if (r.o.promote !== undefined) {
    const p = reader(r.o.promote, B.eventsPeople.templatePromoteWhere, ["days", "minDays"]);
    promote = { days: p.int("days"), minDays: p.int("minDays") };
    if (promote.minDays > promote.days) p.fail(B.eventsPeople.templatePromoteMinDaysTooBig(promote.minDays, promote.days));
  }
  return {
    order, fields, quotes, computed: comp, totalCap: r.int("totalCap"), ownerTotalCap: r.int("ownerTotalCap"), computedOnlyMinImportance: r.int("computedOnlyMinImportance"),
    ...(promote ? { promote } : {}),
  };
}

/** hhd 启动用：没配是 null；配坏了交给 onError（记日志）、也是 null——人物卡不开，hhd 照常起来 */
export function templateOr(raw: unknown, onError: (e: Error) => void): PeopleTemplate | null {
  if (raw === undefined) return null;
  try { return parseTemplate(raw); } catch (e) { onError(e instanceof Error ? e : new Error(String(e))); return null; }
}

/** 字段名 → 模板里的那个字段；不认识（含原话段、现算段、「X（私聊）」）是 null */
export function fieldSpec(t: PeopleTemplate, name: string): FieldSpec | null {
  return t.fields.find((f) => f.name === name) ?? null;
}
/** 原话段名 → 模板里的那一段；不认识是 null */
export function quoteSpec(t: PeopleTemplate, name: string): QuoteSpec | null {
  return t.quotes.find((q) => q.name === name) ?? null;
}
const isComputed = (t: PeopleTemplate, name: string): boolean => name === t.computed.bigEvents.name || name === t.computed.near.name;
/** 这一段在这个人的卡上存着、不现算：主人有同名的主人专有字段（ownerOnly）。别人的照旧现算 */
const storedHere = (t: PeopleTemplate, name: string, owner: boolean): boolean => owner && fieldSpec(t, name)?.ownerOnly === true;
/** 这个人的卡上用的字段上限：主人用 owner 覆盖的（修订 C），别人原样 */
export function specFor(f: FieldSpec, owner: boolean): FieldSpec {
  return owner && f.owner ? { ...f, ...f.owner } : f;
}
/** 这个人的卡上一个原话段最多钉几句：主人用 ownerMax（有的话） */
export const quoteMax = (q: QuoteSpec, owner: boolean): number => (owner && q.ownerMax !== undefined ? q.ownerMax : q.max);
/**
 * 主人专有的字段（ownerOnly）别人写：抛错，说只有谁的卡有（owners：拿主人的名字，要抛错时才叫；没有主人就说现在没有）；
 * 和现算段同名的再说一句别人的那一段是现算的。别的字段、主人自己写都不管
 */
export function mustOwnerOnly(t: PeopleTemplate, f: FieldSpec, owner: boolean, owners: () => readonly string[]): void {
  if (!f.ownerOnly || owner) return;
  const names = owners();
  const who = names.length ? B.eventsPeople.ownerOnlyWho(names.join(B.eventsPeople.ownerOnlyNamesJoiner)) : B.eventsPeople.ownerOnlyNoOwner;
  const comp = isComputed(t, f.name) ? B.eventsPeople.ownerOnlyComputedNote(f.name) : "";
  throw new Error(B.eventsPeople.ownerOnlyRejected(f.name, who, comp));
}
/** 「A」「B」 */
const quoted = (xs: readonly string[]): string => xs.map((x) => B.eventsPeople.describeQuotedName(x)).join("");
const privateNames = (t: PeopleTemplate): string[] => t.fields.filter((f) => f.private).map((f) => f.name);

/** 一个字段的上限（不带写法）：「≤120 字、≤2 句」「≤5 条 ×40 字」「≤60 字」 */
function limits(f: FieldSpec): string {
  if (f.shape === "text") return B.eventsPeople.describeLimitText(f.maxChars, f.maxSentences ? B.eventsPeople.describeLimitSentences(f.maxSentences) : "");
  if (f.shape === "list") return B.eventsPeople.describeLimitList(f.maxItems, f.itemMaxChars);
  return f.maxChars ? B.eventsPeople.describeLimitLine(f.maxChars) : "";
}
/** 一个字段怎么写（工具说明、报错时列给她看）；有主人的放宽就在上限后面写「（主人 …）」 */
function howTo(f: FieldSpec): string {
  const own = f.owner ? B.eventsPeople.describeOwnerRelax(limits(specFor(f, true))) : "";
  if (f.shape === "text") return B.eventsPeople.describeTextHowTo(limits(f), own);
  if (f.shape === "list") {
    return B.eventsPeople.describeListHowTo(limits(f), own, f.itemMustContain ? B.eventsPeople.describeListItemMarker(f.itemMustContain) : "")
      + (f.requireEvent ? B.eventsPeople.describeListNeedsEventId : "");
  }
  return B.eventsPeople.describeLineHowTo(f.maxChars ? B.eventsPeople.describeLineMaxChars(f.maxChars) : "", own, f.patternHint ? B.eventsPeople.describeLinePatternHint(f.patternHint) : "");
}
/** 一个原话段怎么钉 */
function howToPin(q: QuoteSpec): string {
  const who = q.speaker === "self" ? B.eventsPeople.describePinSpeakerSelf : B.eventsPeople.describePinSpeakerEither;
  const full = q.replaceable ? B.eventsPeople.describePinFullReplace : B.eventsPeople.describePinFullKeep;
  // 主人和别人满了怎么办不一样（fullHintOthers）就两句都说
  const hint = q.fullHintOthers !== undefined
    ? B.eventsPeople.describePinFullHintSplit(q.fullHint !== undefined ? B.eventsPeople.describePinFullHintOwner(q.fullHint) : "", q.fullHintOthers)
    : q.fullHint !== undefined ? B.eventsPeople.describePinFullHint(q.fullHint) : "";
  return B.eventsPeople.describePinHowTo(q.name, q.max, q.ownerMax !== undefined ? B.eventsPeople.describePinOwnerMax(q.ownerMax) : "", who, q.countsTowardTotal ? B.eventsPeople.describePinCounted : B.eventsPeople.describePinNotCounted, full, hint);
}

/**
 * 给工具说明用的一段话（mem_person_set / mem_quote_pin 的 description 用它，工具里不再写一遍字段表）：
 * 照卡里的顺序（order）列每一段——字段（类型、写法和上限、哪个总是私密）、原话段（上限、谁说的、算不算合计、能不能换）、现算段（不能写）；
 * 再说类型的意思（什么时候等人批）、依据、合计上限。only: "quotes" 只要原话段和合计（钉原话的工具用）。
 */
export function describeTemplate(t: PeopleTemplate, o: { only?: "quotes" } = {}): string {
  const counted = t.quotes.filter((q) => q.countsTowardTotal).map((q) => q.name);
  const { bigEvents: big, near } = t.computed;
  const total = B.eventsPeople.describeTotalCaps(counted.length ? B.eventsPeople.totalPinnedNote(quoted(counted)) : "", t.totalCap, t.ownerTotalCap);
  const pin = (q: QuoteSpec): string => B.eventsPeople.describePinLine(howToPin(q));
  if (o.only === "quotes") {
    const qs = t.order.map((n) => quoteSpec(t, n)).filter((q): q is QuoteSpec => q !== null);
    return qs.length ? [B.eventsPeople.describePinHeading, ...qs.map(pin), total].join("\n") : B.eventsPeople.describePinNone;
  }
  const computedLine = (n: string): string => n === big.name
    ? B.eventsPeople.describeComputedBigEvents(big.minImportance, big.max)
    : B.eventsPeople.describeComputedNear(near.days, near.max);
  const line = (n: string): string => {
    const f = fieldSpec(t, n);
    if (f) {
      return B.eventsPeople.describeFieldLine(f.name, f.type, howTo(f), f.private ? B.eventsPeople.describeFieldPrivateNote : "")
        + (f.ownerOnly ? B.eventsPeople.describeFieldOwnerOnlyNote : "")
        + (f.protect ? B.eventsPeople.describeProtectNeedsApproval(kind(f) === "summary" ? B.eventsPeople.describeProtectOnlyAddReplaces : "") : "")
        + (isComputed(t, n) ? B.eventsPeople.describeFieldComputedForOthers(n, computedLine(n)) : "");
    }
    const q = quoteSpec(t, n);
    if (q) return pin(q);
    return B.eventsPeople.describeComputedLine(n, computedLine(n));
  };
  // 现算段的名字；主人有同名的存着字段的，说一句主人的是存着的
  const comps = [big.name, near.name].map((n) => (fieldSpec(t, n)?.ownerOnly ? B.eventsPeople.describeComputedOwnerStored(n) : n));
  return [
    B.eventsPeople.describeHeading,
    ...t.order.map(line),
    B.eventsPeople.describeTypesExplained,
    B.eventsPeople.describeSourcesRule,
    B.eventsPeople.describeComputedSections(comps.join(B.eventsPeople.describeNamesJoiner)),
    total,
  ].join("\n");
}

/** 认得的字段，不然抛错（说清为什么不能写、能写的有哪些） */
export function mustField(t: PeopleTemplate, name: string): FieldSpec {
  const spec = fieldSpec(t, name);
  if (spec) return spec;
  if (quoteSpec(t, name)) throw new Error(B.eventsPeople.unknownFieldIsQuote(name));
  if (isComputed(t, name)) throw new Error(B.eventsPeople.unknownFieldIsComputed(name));
  const priv = privateNames(t);
  if (name.endsWith(B.eventsPeople.cardPrivateMark.trim())) throw new Error(B.eventsPeople.unknownFieldPrivateCopy(name, priv.length ? B.eventsPeople.unknownFieldPrivateList(quoted(priv)) : B.eventsPeople.allFieldsPublic));
  // 主人专有、又和现算段同名的（修订 C）：主人的能写（上面列着），别人的现算
  const comps = [t.computed.bigEvents.name, t.computed.near.name].map((n) => (fieldSpec(t, n)?.ownerOnly ? B.eventsPeople.unknownFieldComputedOwnerStored(n) : n));
  throw new Error(B.eventsPeople.unknownField(name, t.fields.map((f) => B.eventsPeople.unknownFieldEntry(f.name, f.type, howTo(f), f.private ? B.eventsPeople.unknownFieldPrivateMark : "", f.ownerOnly ? B.eventsPeople.unknownFieldOwnerOnlyMark : "")).join("；"))
    + B.eventsPeople.unknownFieldComputedTail(t.quotes.length ? B.eventsPeople.unknownFieldQuoteNote(t.quotes.map((q) => q.name).join(B.eventsPeople.unknownFieldQuoteJoiner)) : "", comps.join(B.eventsPeople.unknownFieldComputedJoiner)));
}

/** 认得的原话段，不然抛错 */
export function mustQuote(t: PeopleTemplate, name: string): QuoteSpec {
  const spec = quoteSpec(t, name);
  if (spec) return spec;
  if (fieldSpec(t, name)) throw new Error(B.eventsPeople.unknownQuoteIsField(name));
  if (isComputed(t, name)) throw new Error(B.eventsPeople.unknownQuoteIsComputed(name));
  throw new Error(B.eventsPeople.unknownQuote(name, t.quotes.length ? B.eventsPeople.unknownQuoteList(t.quotes.map(howToPin).join(B.common.listSep)) : B.eventsPeople.unknownQuoteNone));
}

/**
 * 这个字段（或钉在这个原话段里的原话）谁看得到：all，或 private:<这个人的 person_key>（只在他自己那一面）。
 * 写的字段由模板决定（private 的那几个）；原话默认名单上非主人的人私聊，priv 可以改。
 * 只有名单上（有 person_key）、又不是主人的人能有私密的。owner：这个人是不是主人（调用的一方从名单认）。
 */
export function visibilityOf(t: PeopleTemplate, entity: EntityRow, owner: boolean, section: string, priv?: boolean): string {
  const key = entity.person_key;
  const canPrivate = Boolean(key) && !owner;
  const quote = quoteSpec(t, section) !== null;
  let wants: boolean;
  if (quote) wants = priv ?? canPrivate;
  else {
    const spec = mustField(t, section);
    const isPrivate = spec.private === true;
    if (priv !== undefined && priv !== isPrivate) {
      const names = privateNames(t);
      throw new Error(B.eventsPeople.visibilityFieldDecides(section, names.length ? B.eventsPeople.visibilityPrivateOnly(quoted(names)) : B.eventsPeople.allFieldsPublic));
    }
    wants = isPrivate;
  }
  if (!wants) return "all";
  if (!canPrivate) {
    const what = quote ? B.eventsPeople.visibilityQuoteNotPrivate : B.eventsPeople.visibilityNoSection(section);
    throw new Error(key && owner ? B.eventsPeople.visibilityOwnerPublic(entity.name, what) : B.eventsPeople.visibilityNotOnRoster(entity.name, what));
  }
  return `private:${key}`;
}

/** 改一个字段丢了旧文的几行：旧文的非空行 trim 后在新文里一字不差出现就不算丢；of = 旧文非空行数 */
export function lostLines(old: string, next: string): { lost: number; of: number } {
  const rows = old.split("\n").map((l) => l.trim()).filter(Boolean);
  return { lost: rows.filter((l) => !next.includes(l)).length, of: rows.length };
}

// ---------- 写法和大小（P21、P22） ----------
/** 字数：一个字算 1（[...s].length，表情、生僻字不算 2） */
export const chars = (s: string): number => [...s].length;
/** 非空的行（trim 过） */
const rowsOf = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter(Boolean);
/** 列表的一条：去掉「- 」 */
const itemOf = (row: string): string => row.replace(/^- /, "").trim();

/**
 * 主人的 protect 字段（修订 C，关系不遗忘）满了时回话里说的：不收短，写进给主人的提案（owners：拿主人的名字，用到时才叫）；
 * 别人的、不 protect 的字段是 undefined（照旧说往抽象里收）
 */
export function keepHint(spec: FieldSpec, owner: boolean, owners: () => readonly string[]): string | undefined {
  return owner && spec.protect ? B.eventsPeople.limitOwnerKeepProposal(owners().join(B.eventsPeople.limitOwnerKeepJoiner) || B.eventsPeople.limitOwnerKeepFallback) : undefined;
}

/** 列表一条里的事件编号「（e0123）」（全角括号） */
const EVENT_REF = /（(e\d{4,})）/g;

/**
 * 写法和上限对不上就抛错：说清是哪个字段、哪一条、现在多少、上限多少、怎么改。text 是 trim 过的非空文本。
 * spec 是这个人用的（主人的放宽用 specFor 盖过）。requireEvent 的列表每条要带「（e0123）」；给了 eventExists 还查编号在不在库里。
 * keep（keepHint）：超了大小时不叫她往抽象里收，换成这一句（主人的 protect 字段）
 */
export function checkField(spec: FieldSpec, text: string, o: { eventExists?: (id: string) => boolean; keep?: string } = {}): void {
  const { name } = spec;
  const { eventExists, keep } = o;
  if (spec.shape === "line") {
    const hint = spec.patternHint ? B.eventsPeople.limitPatternHint(spec.patternHint) : "";
    const rows = rowsOf(text);
    if (rows.length !== 1) throw new Error(B.eventsPeople.limitLineRowCount(name, rows.length, hint));
    const line = rows[0]!;
    if (spec.maxChars !== undefined && chars(line) > spec.maxChars) throw new Error(B.eventsPeople.limitLineOverChars(name, chars(line), spec.maxChars, keep ?? B.eventsPeople.limitLineKeepDefault));
    if (spec.pattern !== undefined && !new RegExp(spec.pattern, "u").test(line)) throw new Error(B.eventsPeople.limitPatternMismatch(name, line, hint || B.eventsPeople.limitPatternWholeLine(spec.pattern)));
    return;
  }
  if (spec.shape === "text") {
    if (spec.maxChars !== undefined && chars(text) > spec.maxChars) throw new Error(B.eventsPeople.limitTextOverChars(name, chars(text), spec.maxChars, keep ?? B.eventsPeople.limitTextKeepDefault));
    const n = text.split(/[。！？!?]/).filter((x) => x.trim()).length;
    if (spec.maxSentences && n > spec.maxSentences) throw new Error(B.eventsPeople.limitTextOverSentences(name, n, spec.maxSentences, keep ?? B.eventsPeople.limitSentencesKeepDefault(spec.maxSentences)));
    return;
  }
  const rows = rowsOf(text);
  const bad = rows.findIndex((l) => !l.startsWith("- "));
  if (bad >= 0) throw new Error(B.eventsPeople.limitListRowNoDash(name, bad + 1));
  if (spec.maxItems !== undefined && rows.length > spec.maxItems) throw new Error(B.eventsPeople.limitListOverItems(name, rows.length, spec.maxItems, keep ?? B.eventsPeople.limitListKeepDefault));
  rows.map(itemOf).forEach((x, i) => {
    if (spec.itemMaxChars !== undefined && chars(x) > spec.itemMaxChars) throw new Error(B.eventsPeople.limitItemOverChars(name, i + 1, chars(x), spec.itemMaxChars, keep ?? B.eventsPeople.limitItemKeepDefault));
    if (spec.itemMustContain && !x.includes(spec.itemMustContain)) throw new Error(B.eventsPeople.limitItemMissingMarker(name, i + 1, spec.itemMustContain, spec.itemMustContain));
    if (spec.requireEvent) {
      const ids = [...x.matchAll(EVENT_REF)].map((m) => m[1]!);
      if (!ids.length) throw new Error(B.eventsPeople.limitItemMissingEventId(name, i + 1));
      const missing = eventExists ? ids.find((id) => !eventExists(id)) : undefined;
      if (missing) throw new Error(B.eventsPeople.limitItemEventNotFound(name, i + 1, missing));
    }
  });
}

/** 一个字段的字数（算合计用）：列表是每条的字数相加（不算「- 」），别的是整段的字数 */
export function fieldSize(spec: FieldSpec, text: string): number {
  return spec.shape === "list" ? rowsOf(text).reduce((n, r) => n + chars(itemOf(r)), 0) : chars(text);
}

/**
 * 卡现在有多大（P22）：字段 → 字数。每个字段取现行的和能批的待批里大的那个（批不批都不会超）；
 * 算进合计的原话段（countsTowardTotal）是现行的钉的句子相加；别的原话段不算；模板里没有的段（模板改过）不在卡上、也不算。
 * rows 是这个人现行和待批的印象。
 */
export function cardSizes(t: PeopleTemplate, rows: readonly ImpressionRow[]): Map<string, number> {
  const cur = new Map(rows.filter((r) => r.kind === "section" && r.status === "current").map((r) => [r.section, r.id]));
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.kind === "quote") {
      if (r.status === "current" && quoteSpec(t, r.section)?.countsTowardTotal) out.set(r.section, (out.get(r.section) ?? 0) + chars(r.text));
      continue;
    }
    const spec = fieldSpec(t, r.section);
    if (!spec) continue;
    // 过时的待批（它要换的那行已经不是现行的了）批不了，不算
    const live = r.status === "current" || (r.status === "pending" && r.supersedes === (cur.get(r.section) ?? null));
    if (live) out.set(r.section, Math.max(out.get(r.section) ?? 0, fieldSize(spec, r.text)));
  }
  return out;
}

/** 卡的大小上限（P22）：主人 ownerTotalCap，别人 totalCap */
export const cardCap = (t: PeopleTemplate, owner: boolean): number => (owner ? t.ownerTotalCap : t.totalCap);

/** 卡现在合计多大、上限多少（回话、工作单用；算法同 overCap：cardSizes 相加）。rows 是这个人现行和待批的印象 */
export function cardTotal(t: PeopleTemplate, owner: boolean, rows: readonly ImpressionRow[]): { total: number; cap: number } {
  return { total: [...cardSizes(t, rows).values()].reduce((a, b) => a + b, 0), cap: cardCap(t, owner) };
}

/**
 * 一个字段现在多大（回话、工作单用）：列表「4/5 条」，一段「120/150 字」，一行「12/60 字」（没有字数上限就「12 字」）。
 * over：不合模板了（条数、字数、写法——模板后来改小了的那种；写的时候超了直接拒，所以平时不会有）
 */
export function fieldUsage(spec: FieldSpec, text: string): { text: string; over: boolean; unit: "items" | "chars"; n: number; max?: number } {
  let over = false;
  try { checkField(spec, text); } catch { over = true; }
  // text is the role's wording; unit, n and max are the same figures for a reader who words them otherwise (the console)
  const list = spec.shape === "list";
  const n = list ? rowsOf(text).length : chars(text), max = list ? spec.maxItems : spec.maxChars;
  const said = list ? B.eventsPeople.fieldUsageItems(n, max) : max !== undefined ? B.eventsPeople.fieldUsageChars(n, max) : B.eventsPeople.fieldUsageCharsOnly(n);
  return { text: said, over, unit: list ? "items" : "chars", n, ...(max !== undefined ? { max } : {}) };
}

/**
 * 合计（P22）：sizes 是写之前的（cardSizes），field 变成 size 字以后超了上限、又比写之前大，返回拒的话；不然 null。
 * 已经超了的卡（并人并出来的）往小里改照样能写。keep（keepHint）：主人的 protect 字段不叫她收别的字段，换成这一句。
 */
export function overCap(t: PeopleTemplate, owner: boolean, sizes: ReadonlyMap<string, number>, field: string, size: number, verb: "write" | "pin", keep?: string): string | null {
  const sum = (m: ReadonlyMap<string, number>): number => [...m.values()].reduce((a, b) => a + b, 0);
  const after = new Map(sizes).set(field, size);
  const total = sum(after), cap = cardCap(t, owner);
  if (total <= cap || total <= sum(sizes)) return null;
  const big = [...after].filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || t.order.indexOf(a[0]) - t.order.indexOf(b[0]))
    .map(([k, n]) => `${k} ${n}`).join(B.eventsPeople.limitTotalSizesJoiner);
  const counted = t.quotes.filter((q) => q.countsTowardTotal).map((q) => q.name);
  return B.eventsPeople.limitTotalOver(B.eventsPeople.capVerb[verb], total, cap, counted.length ? B.eventsPeople.totalPinnedNote(quoted(counted)) : "", keep ?? B.eventsPeople.limitTotalKeepDefault, big);
}

// ---------- 渲染、导出 ----------
const NEAR_FILE = "near.md";
/** 人物卡导出到工作区的哪个目录（hhd 的 peopleDir；指路的话里也用这个相对路径） */
export const CARD_DIR = LAYOUT.peopleCards;
/** 她的一天从几点起 */
const DAY_HOUR = 4;

/** 不靠区域设置的比较（localeCompare 在不同机器上可能不一样） */
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** 编号（t0002、i0013）按数排：位数多的在后，同位数按字 */
export const byId = (a: string, b: string): number => a.length - b.length || cmp(a, b);
/** 按时间排，没有时间的排最后；dir 1 早的在前，-1 新的在前 */
const byTime = (a: number | null, b: number | null, dir: 1 | -1): number =>
  a === null || b === null ? (a === null ? 1 : 0) - (b === null ? 1 : 0) : (a - b) * dir;

const clocks = new Map<string, Intl.DateTimeFormat>();
/** 她的时区里的年月日时分（精确到分钟） */
function clock(t: number, tz: string): Record<string, string> {
  let f = clocks.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    clocks.set(tz, f);
  }
  return Object.fromEntries(f.formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
}

/** 她的一天从 04:00 起：now 所在那一天的 04:00（不到 04:00 算前一天）；back 天以前那一天的 04:00 */
export function dayStart(now: number, tz: string, back = 0): number {
  const c = clock(now, tz);
  return localToUtc(Number(c.year), Number(c.month), Number(c.day) - (Number(c.hour) < DAY_HOUR ? 1 : 0) - back, DAY_HOUR, 0, tz);
}

/** 原话是谁说的：「我→阿青」是我、「阿青（qq）」是阿青 */
const speakerOf = (who: string): string => who.split("→")[0]!.replace(/（.*$/, "").trim();

/** 私密的印象行在操作日志里显示成这个（R24：批的人不该看到访客私聊里的东西） */
// Data: maskImpressionOp writes it over a private row's values in the change log it hands out; the console page finds and replaces it (its twin, SECRET_SHOWN in src/console/web/js/events.js, must stay equal)
export const SECRET_SHOWN = "（私密，不显示）";

/**
 * 操作日志（mem_op）里印象表的一步，给人看之前遮掉私密的：改之前、改之后哪一边是私密的行（visibility 不是 all），
 * 两边的原文、why、出处、原话编号和这一步的理由都遮掉（mem_op 存整行 JSON，理由就是写的时候的 why）。
 * 把旧行标成 superseded 的那一步，理由是替换它的新行的 why：replacedByPrivate(旧行编号) 说替换它的是私密的，也遮理由。
 * 印象表的行解析不了：一律遮（宁可多遮）。不是印象表的原样。
 */
export function maskImpressionOp(tbl: string, before: string | null, after: string | null, reason: string, replacedByPrivate?: (id: string) => boolean): { before: string | null; after: string | null; reason: string } {
  if (tbl !== "mem_impression") return { before, after, reason };
  const parse = (v: string | null): Record<string, unknown> | null | undefined => {
    if (v === null) return null;
    try { const j = JSON.parse(v) as unknown; return j && typeof j === "object" && !Array.isArray(j) ? j as Record<string, unknown> : undefined; } catch { return undefined; }
  };
  const b = parse(before), a = parse(after);
  const priv = (r: Record<string, unknown> | null | undefined): boolean => r === undefined || (r !== null && r.visibility !== "all");
  if (priv(b) || priv(a)) {
    const hide = (r: Record<string, unknown> | null | undefined): string | null => r === null ? null : r === undefined ? SECRET_SHOWN
      : JSON.stringify({ ...r, text: SECRET_SHOWN, why: SECRET_SHOWN, sources: SECRET_SHOWN, quote_id: null });
    return { before: hide(b), after: hide(a), reason: SECRET_SHOWN };
  }
  const id = typeof a?.id === "string" ? a.id : null;
  if (a?.status === "superseded" && id && replacedByPrivate?.(id)) return { before, after, reason: SECRET_SHOWN };
  return { before, after, reason };
}

/**
 * 一批操作里被私密行顶掉的那些行的编号：哪一步写进去的行（after）是私密的，它的 supersedes 就在里面
 * （解析不了的跳过：那一步本身 maskImpressionOp 会整个遮掉）。
 * 顶掉旧行的那一步和写新行的那一步同一批（撤回时也一起挪进 <批>~reverted@…），所以这批撤回了、新行删了也认得出。
 */
export function privateReplaced(ops: ReadonlyArray<{ tbl: string; after: string | null }>): Set<string> {
  const out = new Set<string>();
  for (const o of ops) {
    if (o.tbl !== "mem_impression" || o.after === null) continue;
    let r: unknown;
    try { r = JSON.parse(o.after); } catch { continue; }
    if (!r || typeof r !== "object" || Array.isArray(r)) continue;
    const row = r as Record<string, unknown>;
    if (typeof row.supersedes === "string" && row.visibility !== "all") out.add(row.supersedes);
  }
  return out;
}

/** 这一行谁看得到：all 谁都看得到；private:<key> 只有 viewer 正好是 key 才看得到 */
export const visibleTo = (r: ImpressionRow, viewer: string | null): boolean => r.visibility === "all" || (viewer !== null && r.visibility === `private:${viewer}`);

/** 钉住的原话一行：- MM-DD HH:MM〔说话的人〕（私聊）「text」—— why（原话层里那句没了，就用钉的时间、不写说话的人） */
function quoteLines(store: EventStore, rows: ImpressionRow[], tz: string): string[] {
  const xs = rows.map((r) => {
    const q = r.quote_id === null ? undefined : one<{ at: number; who: string }>(store.db, "SELECT at, who FROM mem_quote WHERE id = ?", r.quote_id);
    return { r, at: q?.at ?? r.created_at, who: q ? speakerOf(q.who) : "" };
  }).sort((a, b) => a.at - b.at || byId(a.r.id, b.r.id));
  return xs.map(({ r, at, who }) => {
    const c = clock(at, tz);
    const why = r.why.replace(/\s+/g, " ").trim();
    return B.eventsPeople.cardPinnedQuoteLine(c.month, c.day, c.hour, c.minute, who ? B.eventsPeople.cardQuoteSpeaker(who) : "", r.visibility === "all" ? "" : B.eventsPeople.cardPrivateMark, r.text, why ? `—— ${why}` : "");
  });
}

/** 现算的两段，一段一个行数组 */
interface Computed { big: string[]; near: string[] }

/**
 * 现算的两段（P25；主人有同名的主人专有字段的那一段不算，是空的，修订 C），都只看挂着这个人的事（store.eventsOf）、没被替换或作废、不是喜欢 / 烦的事（门槛和件数照模板的 computed）：
 * 大事（bigEvents）= 重要度 ≥minImportance 里最重要的 max 件（同分开始得晚的在前、再按编号），按开始时间从早到晚显示（没开始时间的在最后）；
 * 近况（near）= 最近一次进展（经过里最大的 at，没有经过就用 updated_at）在 [她 days−1 天前那一天的 04:00, 她这一天结束（第二天 04:00）) 里的，
 * 最近的在前，最多 max 件——上界取这一天的结束、不取 now：记着今天晚些时候的经过也算，同一天里内容只跟着库变、不跟着钟变。
 */
function computed(store: EventStore, t: PeopleTemplate, entity: EntityRow, now: number, tz: string): Computed {
  const { bigEvents: bigSpec, near: nearSpec } = t.computed;
  const owner = store.isOwner(entity);
  const evs = store.eventsOf(entity.id).filter((e) => e.status !== "superseded" && e.status !== "retired" && !e.stance);
  // 主人有同名的存着字段（修订 C）：那一段用存着的，不现算
  const big = storedHere(t, bigSpec.name, owner) ? [] : evs.filter((e) => e.importance >= bigSpec.minImportance)
    .sort((a, b) => b.importance - a.importance || byTime(a.started_at, b.started_at, -1) || byId(a.id, b.id))
    .slice(0, bigSpec.max)
    .sort((a, b) => byTime(a.started_at, b.started_at, 1) || byId(a.id, b.id))
    .map((e) => { const c = clock(e.started_at ?? e.created_at, tz); return B.eventsPeople.cardBigEventLine(c.month, c.day, e.title, e.id); });
  const from = dayStart(now, tz, nearSpec.days - 1);
  const end = dayStart(now, tz, -1);
  const last = lastProgress(store, entity.id);
  const near = storedHere(t, nearSpec.name, owner) ? [] : evs.map((e) => ({ e, at: last.get(e.id) ?? e.updated_at }))
    .filter((x) => x.at >= from && x.at < end)
    .sort((a, b) => b.at - a.at || byId(a.e.id, b.e.id))
    .slice(0, nearSpec.max)
    .map(({ e }) => B.eventsPeople.nearEventLine(e.title, e.gist, e.id));
  return { big, near };
}

/** 挂着这个人的每件事最近一次进展（经过里最大的 at）：一条 GROUP BY 查完（事件集合同 store.eventsOf）；没有经过的事不在里面 */
function lastProgress(store: EventStore, entityId: string): Map<string, number> {
  return new Map(all<{ event_id: string; m: number }>(store.db, `
    SELECT event_id, max(at) m FROM mem_entry WHERE event_id IN (
      SELECT event_id FROM mem_event_entity WHERE entity_id = ?
      UNION SELECT n.event_id FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id WHERE ne.entity_id = ?)
    GROUP BY event_id`, entityId, entityId).map((r) => [r.event_id, r.m]));
}

/** 人物卡只给人和群 */
const carded = (t: EntityRow): boolean => t.kind === "person" || t.kind === "group";
/**
 * 出不出卡（导出、card()、near.md 同一条规则，R18）：有现行的字段或钉的原话；
 * 或者重要度到模板的 computedOnlyMinImportance、现算的两段至少一段有内容。
 * 没存东西、重要度又不够的，现算都不用算（导出时大多数人是这样）：返回 null。
 */
function cardOf(store: EventStore, t: PeopleTemplate, e: EntityRow, now: number, tz: string): Computed | null {
  const stored = store.impressions(e.id).length > 0;
  if (!stored && (e.importance ?? 0) < t.computedOnlyMinImportance) return null;
  const comp = computed(store, t, e, now, tz);
  return stored || comp.big.length > 0 || comp.near.length > 0 ? comp : null;
}

/** 出卡的人和群，按编号，带上现算的两段 */
function cardHolders(store: EventStore, t: PeopleTemplate, now: number, tz: string): Array<{ t: EntityRow; comp: Computed }> {
  const out: Array<{ t: EntityRow; comp: Computed }> = [];
  for (const e of store.entities().filter(carded).sort((a, b) => byId(a.id, b.id))) {
    const comp = cardOf(store, t, e, now, tz);
    if (comp) out.push({ t: e, comp });
  }
  return out;
}

/** 卡的各段（`## 段名\n正文`）：照模板的 order，没有看得到的内容的段不出；主人的卡上和现算段同名的主人专有字段用存着的 */
function cardBlocks(store: EventStore, t: PeopleTemplate, entity: EntityRow, viewer: string | null, tz: string, comp: Computed): string[] {
  const rows = store.impressions(entity.id).filter((r) => visibleTo(r, viewer));
  // 主人有同名的存着字段的现算段：用存着的（修订 C）
  const stored = (name: string): boolean => storedHere(t, name, store.isOwner(entity));
  const blocks: string[] = [];
  for (const name of t.order) {
    const body = quoteSpec(t, name) ? quoteLines(store, rows.filter((r) => r.kind === "quote" && r.section === name), tz).join("\n")
      : name === t.computed.bigEvents.name && !stored(name) ? comp.big.join("\n")
        : name === t.computed.near.name && !stored(name) ? comp.near.join("\n")
          // 一个字段只有一行现行的（唯一索引）
          : rows.find((r) => r.kind === "section" && r.section === name)?.text ?? "";
    if (body) blocks.push(`## ${name}\n${body}`);
  }
  return blocks;
}

/** 卡的正文（导出的文件）：名字、导出说明两行，再是各段；没有段就是空字符串 */
const cardText = (entity: EntityRow, blocks: readonly string[]): string =>
  blocks.length ? `# ${entity.name}\n${B.eventsPeople.cardFileNote}\n\n${blocks.join("\n\n")}\n` : "";

/**
 * 一个人或群的卡：viewer 是 person_key（看得到 all + private:<viewer>），null 只看 all；现算的两段对谁都一样（事件没有可见性，P26）。
 * now 只用来定近况的窗口。没配模板、不是人或群、不出卡（规则同导出，R18）、没有看得到的内容，返回空字符串。
 */
export function renderCard(store: EventStore, entity: EntityRow, o: { viewer: string | null; now: number; tz: string }): string {
  return cardText(entity, cardSections(store, entity, o));
}

/**
 * 卡的各段（`## 段名\n正文`，照模板的顺序），不带导出文件头上的名字和说明那两行——附进别的话里用（recall_person、访客卡）。
 * 谁看得到、出不出卡和 renderCard 一样；不出卡、没有看得到的内容是空数组。
 */
export function cardSections(store: EventStore, entity: EntityRow, o: { viewer: string | null; now: number; tz: string }): string[] {
  const t = store.peopleTemplate;
  if (!t || !carded(entity)) return [];
  const comp = cardOf(store, t, entity, o.now, o.tz);
  return comp ? cardBlocks(store, t, entity, o.viewer, o.tz, comp) : [];
}

/** near.md 的正文：写于 = 她这一天的 04:00；近况非空的人一块，按重要度从高到低（没打分的最后）、同分按编号 */
function nearText(xs: ReadonlyArray<{ t: EntityRow; near: string[] }>, now: number, tz: string): string {
  const c = clock(dayStart(now, tz), tz);
  const people = xs.filter((x) => x.near.length).sort((a, b) => (b.t.importance ?? -1) - (a.t.importance ?? -1) || byId(a.t.id, b.t.id));
  return B.eventsPeople.nearFileText(c.year, c.month, c.day, c.hour, c.minute, people.map((x) => `\n#### ${x.t.name}\n${x.near.join("\n")}\n`).join(""));
}

/** 人物近况（P25）：出卡的人和群（R18）现算的近况；没有人就只有头两行；没配模板是空字符串 */
export function renderNear(store: EventStore, o: { now: number; tz: string }): string {
  const t = store.peopleTemplate;
  return t ? nearText(cardHolders(store, t, o.now, o.tz).map(({ t: e, comp }) => ({ t: e, near: comp.near })), o.now, o.tz) : "";
}

/**
 * 工作单第 8 节「最近常打交道」那一行：模板 promote 配了才有。窗口是整理的这一天往前 days 天（她的一天，04:00 起；w.to 是这一天的最后一刻，含），
 * 人和群（重要度还不到 computedOnlyMinImportance，没打的也算）出现在经过里（不算不作数了的事，retired）的不同天数 ≥ minDays 的列出来：
 * 天数多的在前、同样按条数、再按编号。没人够数是空字符串。
 */
export function promoteLine(store: EventStore, w: { to: number }, tz: string): string {
  const t = store.peopleTemplate;
  const p = t?.promote;
  if (!t || !p) return "";
  const from = dayStart(w.to, tz, p.days - 1);
  const rows = all<{ id: string; at: number }>(store.db, `
    SELECT ne.entity_id id, n.at FROM mem_entry_entity ne JOIN mem_entry n ON n.id = ne.entry_id JOIN mem_entity e ON e.id = ne.entity_id
      JOIN mem_event ev ON ev.id = n.event_id
    WHERE e.kind IN ('person', 'group') AND (e.importance IS NULL OR e.importance < ?) AND ev.status != 'retired' AND n.at >= ? AND n.at <= ?`, t.computedOnlyMinImportance, from, w.to);
  const seen = new Map<string, { days: Set<number>; n: number }>();
  for (const r of rows) {
    const x = seen.get(r.id) ?? { days: new Set<number>(), n: 0 };
    x.days.add(dayStart(r.at, tz));
    x.n += 1;
    seen.set(r.id, x);
  }
  const hits = [...seen].filter(([, x]) => x.days.size >= p.minDays)
    .sort(([a, x], [b, y]) => y.days.size - x.days.size || y.n - x.n || byId(a, b));
  if (!hits.length) return "";
  const lvl = t.computedOnlyMinImportance;
  const ents = new Map(store.entities().map((e) => [e.id, e]));
  const names = hits.map(([id, x]) => { const e = ents.get(id)!; return B.eventsPeople.promoteCandidate(e.name, e.importance ?? "?", x.days.size, x.n); });
  return B.eventsPeople.promoteCandidates(p.days, lvl, p.minDays, names.join(B.eventsPeople.promoteCandidatesJoiner)) +
    B.eventsPeople.promoteAdvice(lvl);
}

// ---------- 工作单第 8 节末尾的「人物卡」（P30：给只看人物材料的小 agent） ----------
/** 这一段最多这么多字 */
const DIGEST_MAX = 3000;
/** 每人「今天的新经过」最多列几条 */
const DIGEST_ENTRIES = 10;
/** 名字列表（还没列的、还没有卡的）最多这么多字 */
const NAMES_MAX = 400;
/** 「A、B、C」，太长了截在整名、写「等 N 个」 */
function nameList(xs: readonly string[], max: number): string {
  let out = "";
  for (const [i, x] of xs.entries()) {
    const next = out ? B.eventsPeople.digestNameListJoined(out, x) : x;
    if (chars(next) > max) return B.eventsPeople.digestNameListMore(out, xs.length - i);
    out = next;
  }
  return out;
}
/** 重要度从高到低（没打分的最后），同分按编号 */
const byImportance = (a: EntityRow, b: EntityRow): number => (b.importance ?? -1) - (a.importance ?? -1) || byId(a.id, b.id);

/** 一个人那一块：存着的字段和大小、钉了几句、待批、合计、这一天的经过里有他的（rows：现行和待批的印象） */
function digestBlock(store: EventStore, t: PeopleTemplate, e: EntityRow, rows: readonly ImpressionRow[], w: { from: number; to: number }): string {
  const tag = e.person_key ? B.eventsPeople.digestPersonTagKey(e.person_key) : e.kind === "group" ? B.eventsPeople.digestPersonTagGroup : "";
  const out = [B.eventsPeople.digestPersonHeading(e.name, e.id, tag)];
  const owner = store.isOwner(e);
  const cur = rows.filter((r) => r.status === "current");
  for (const f of t.order.map((n) => fieldSpec(t, n)).filter((x): x is FieldSpec => x !== null)) {
    const r = cur.find((x) => x.kind === "section" && x.section === f.name);
    if (!r) continue;
    const u = fieldUsage(specFor(f, owner), r.text);
    out.push(`- ${f.name} ${u.text}${u.over ? B.eventsPeople.digestFieldOver : ""}${r.visibility === "all" ? "" : B.eventsPeople.digestFieldPrivate}`);
  }
  if (t.quotes.length) out.push(B.eventsPeople.digestPinnedQuotes(t.quotes.map((q) => `${q.name} ${cur.filter((r) => r.kind === "quote" && r.section === q.name).length}/${quoteMax(q, owner)}`).join(B.eventsPeople.digestPinnedJoiner)));
  const pend = rows.filter((r) => r.status === "pending");
  if (pend.length) {
    out.push(B.eventsPeople.digestPendingLine(pend.map((p) => {
      const now = cur.find((x) => x.kind === "section" && x.section === p.section)?.id ?? null;
      return B.eventsPeople.digestPendingItem(p.id, p.section, p.text ? "" : B.eventsPeople.digestPendingCleared, p.supersedes === now ? "" : B.eventsPeople.digestPendingStale);
    }).join(B.eventsPeople.digestPendingJoiner)));
  }
  const { total, cap } = cardTotal(t, owner, rows);
  out.push(B.eventsPeople.digestTotalLine(total, cap, total > cap ? B.eventsPeople.digestTotalOver(total - cap) : ""));
  const ns = all<{ id: string; title: string }>(store.db, `
    SELECT n.id, n.title FROM mem_entry n JOIN mem_entry_entity ne ON ne.entry_id = n.id
    WHERE ne.entity_id = ? AND n.at BETWEEN ? AND ? ORDER BY n.at, n.id`, e.id, w.from, w.to);
  const listed = ns.slice(0, DIGEST_ENTRIES).map((n) => B.eventsPeople.digestTodayItem(n.id, [...n.title].slice(0, 20).join(""))).join(B.eventsPeople.digestTodayJoiner);
  out.push(B.eventsPeople.digestTodayLine(ns.length ? `${listed}${ns.length > DIGEST_ENTRIES ? B.eventsPeople.digestTodayMore(ns.length - DIGEST_ENTRIES) : ""}` : B.eventsPeople.digestTodayNone));
  return out.join("\n");
}

/**
 * 工作单第 8 节末尾的「人物卡」：每个有卡（存着字段或钉了原话，含待批的）的人和群一块，按重要度从高到低；
 * 放不下 DIGEST_MAX 字就停，剩下的列名字；最后一行是重要度到出卡门槛（computedOnlyMinImportance）、还没有卡的人和群。
 * 只有大小和编号，没有卡的内容（私密的也不漏）。w 是工作单那一天的窗口（她的一天）。没配模板是空字符串
 */
export function cardDigest(store: EventStore, w: { from: number; to: number }): string {
  const t = store.peopleTemplate;
  if (!t) return "";
  const head = B.eventsPeople.digestHeading;
  const blocks: Array<{ name: string; text: string }> = [];
  const bare: EntityRow[] = [];
  for (const e of store.entities().filter(carded).sort(byImportance)) {
    const rows = store.impressions(e.id, { status: ["current", "pending"] });
    if (rows.length) blocks.push({ name: e.name, text: digestBlock(store, t, e, rows, w) });
    else if ((e.importance ?? -1) >= t.computedOnlyMinImportance) bare.push(e);
  }
  const tail = bare.length ? B.eventsPeople.digestBareLine(t.computedOnlyMinImportance, nameList(bare.map((e) => B.eventsPeople.digestBareItem(e.name, e.importance)), NAMES_MAX)) : "";
  // 留给「还有 N 个没列」那一行的地方
  const room = DIGEST_MAX - chars(head) - chars(tail) - NAMES_MAX - 40;
  const out = [head];
  const left: string[] = [];
  let used = 0;
  for (const b of blocks) {
    if (!left.length && used + chars(b.text) + 1 <= room) { out.push(b.text); used += chars(b.text) + 1; } else left.push(b.name);
  }
  if (left.length) out.push(B.eventsPeople.digestUnlisted(left.length, nameList(left, NAMES_MAX)));
  if (tail) out.push(tail);
  return out.join("\n");
}

/** 卡的文件名：名单上的用 person_key，别的（群、不在名单上的人）用实体编号；key 当不了文件名（带路径符号、点开头、和 near.md 撞）也用编号 */
export function cardFile(entity: EntityRow): string {
  const k = entity.person_key;
  const ok = Boolean(k) && !/[/\\\0]/.test(k!) && !k!.startsWith(".") && `${k!.toLowerCase()}.md` !== NEAR_FILE;
  return `${ok ? k : entity.id}.md`;
}

/** 卡导出在工作区里的哪个文件（指路用）：CARD_DIR/cardFile（两个 key 只差大小写这种撞名，导出会改用编号，这里不管） */
export const cardPath = (entity: EntityRow): string => `${CARD_DIR}/${cardFile(entity)}`;

/** 内容和磁盘上一样就不写；写用临时文件 + rename（读的人不会读到写了一半的） */
function writeIfChanged(dir: string, name: string, text: string): boolean {
  const path = join(dir, name);
  let old: string | null = null;
  try { old = readFileSync(path, "utf8"); } catch { /* 没有就写 */ }
  if (old === text) return false;
  const tmp = join(dir, `.${name}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return true;
}

/**
 * 导出（P4、P25）：出卡的人和群（规则见 cardHolders）一张卡（viewer = 他自己的 person_key，没有就 null），加 near.md（也只有出卡的）。
 * 现算的两段（我们的大事、近况；主人有同名的存着字段的那一段用存着的，修订 C）只进主人的卡文件和 near.md（R35）：别人（访客、群）的卡文件只有存着的字段和钉的原话——
 * 访客那边能读到这些文件（访客会话的快照、leak-guard），现算段里是主人那边的事的标题；只有现算段的人和群就没有卡文件。
 * 在上下文里给的（recall_person、叫醒她时附的访客卡）照旧带现算段。
 * 内容一样的不写；目录里不在这次名单上的 *.md（near.md 除外）删掉。一张写不成不耽误别的，最后把错一起抛出来。
 * 没配模板（人物卡没开）：什么都不写、不删。
 */
export function exportPeople(store: EventStore, dir: string, o: { now: number; tz: string }): { written: string[]; removed: string[] } {
  const tpl = store.peopleTemplate;
  if (!tpl) return { written: [], removed: [] };
  mkdirSync(dir, { recursive: true });
  const ents = cardHolders(store, tpl, o.now, o.tz);
  const out: Array<[string, string]> = [];
  const taken = new Set<string>([NEAR_FILE]);   // 文件系统不分大小写：按小写去重
  const NO_COMPUTED: Computed = { big: [], near: [] };
  for (const { t, comp } of ents) {
    const card = cardText(t, cardBlocks(store, tpl, t, t.person_key ?? null, o.tz, store.isOwner(t) ? comp : NO_COMPUTED));
    if (!card) continue;
    let name = cardFile(t);
    if (taken.has(name.toLowerCase())) name = `${t.id}.md`;
    if (taken.has(name.toLowerCase())) continue;
    taken.add(name.toLowerCase());
    out.push([name, card]);
  }
  out.push([NEAR_FILE, nearText(ents.map(({ t, comp }) => ({ t, near: comp.near })), o.now, o.tz)]);
  const written: string[] = [], removed: string[] = [], errors: string[] = [];
  for (const [name, text] of out) {
    try { if (writeIfChanged(dir, name, text)) written.push(name); } catch (e) { errors.push(B.eventsPeople.exportWriteFailed(name, e instanceof Error ? e.message : String(e))); }
  }
  for (const f of readdirSync(dir).sort(cmp)) {
    if (!f.endsWith(".md") || taken.has(f.toLowerCase())) continue;
    try {
      if (!lstatSync(join(dir, f)).isFile()) continue;
      unlinkSync(join(dir, f));
      removed.push(f);
    } catch (e) { errors.push(B.eventsPeople.exportDeleteFailed(f, e instanceof Error ? e.message : String(e))); }
  }
  if (errors.length) throw new Error(B.eventsPeople.exportIncomplete(errors.join(B.common.listSep)));
  return { written, removed };
}
