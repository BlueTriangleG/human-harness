// 语言包：她读到的字都在包里（src/lang/<code>/），代码经这里的活绑定 P（给脑区的提示）、T（工具的描述、参数说明、回话）和 M（记忆层的字）读当前这个包；启动时 hhd 按配置的 lang 选包。
// Four more parts, one per area of the code, exist with their bindings and stay empty until that area's text moves in:
// G (gate), L (learning), S (sleep), R (repair), and B for everything else the framework says (the brain, the memory store,
// the persona, the regions, the small modules). Their entries were moved by a tool, literal by literal, so some are
// read at module level: a process picks its pack once, when it starts.
// 包里还带一份跟语言有关的配置默认值（defaults），loadConfig 把它垫在 config/default.json 下面。
import { zh } from "./zh/index.ts";
import { en } from "./en/index.ts";
import { gaps } from "./overlay.ts";
// 只取类型：config.ts 运行时要 import 这里（langDefaults），这里运行时不能反过来 import 它
import type { Config, DeepPartial } from "../config.ts";

/**
 * 一个包的形状：键和函数签名照中文包，字符串常量只要求是字符串（不然别的语言的字过不了类型）；数、真假也只要求类型。
 * 数组、元组逐个元素放宽（同构映射：数组还是数组，元组还是元组、长度不变，readonly 留着），以后 as const 的一串话也不钉死原文
 */
export type Widen<T> =
  T extends string ? string :
  T extends number ? number :
  T extends boolean ? boolean :
  T extends (...args: infer A) => infer R ? (...args: A) => Widen<R> :
  T extends RegExp ? RegExp :
  T extends object ? { [K in keyof T]: Widen<T[K]> } :
  T;

/**
 * A language pack: the Chinese pack is the reference; any other pack must have the same shape (tsc checks it).
 * A pack that is being translated (en) is an overlay on the reference: overlay() in src/lang/overlay.ts builds each part.
 * defaults: the config fragment that depends on the language (the lowest layer under config/default.json) — typed by the framework's Config, not widened
 */
export interface LangPack {
  code: string;
  /** The Intl locale HH writes the role's dates in (weekday and month names, the order of the parts) */
  locale: string;
  prompts: Widen<typeof zh.prompts>; tools: Widen<typeof zh.tools>; memory: Widen<typeof zh.memory>;
  gate: Widen<typeof zh.gate>; learning: Widen<typeof zh.learning>; sleep: Widen<typeof zh.sleep>; repair: Widen<typeof zh.repair>;
  brain: Widen<typeof zh.brain>;
  defaults: DeepPartial<Config>;
  /** A pack filled entry by entry (src/lang/overlay.ts): its own parts as written, before the reference filled the gaps — what langGaps reads */
  own?: Readonly<Record<PartName, object>>;
}
export type { CheckCase, CheckEntry, CheckPage, WakeKind } from "./zh/prompts.ts";

/** The parts of a pack that hold text */
const PARTS = ["prompts", "tools", "memory", "gate", "learning", "sleep", "repair", "brain"] as const;
export type PartName = (typeof PARTS)[number];

export const DEFAULT_LANG = "en";

/**
 * The names a pack's text is filled with. Pack text never names a role: where a sentence addresses the role or its owner it
 * carries a placeholder — {{me}}, {{owner}} ({{Owner}} with a capital first letter), {{ta}} (the third-person word for the
 * role), {{place}} (where the role lives, as its clock is announced), {{ordinary}} (an ordinary person on the role's list, as
 * the role calls one; unset, the pack's common.ordinary) — and the process that speaks as a role binds them once,
 * when it picks its pack: setLang(cfg.lang, roleNames(cfg)). id is the role's id (the id of its config); code that
 * has to recognise the role's or the owner's name reads N.
 */
export interface PackNames { me: string; owner: string; ta: string; place: string; id: string; ordinary?: string }
const NO_NAMES: PackNames = { me: "", owner: "", ta: "", place: "", id: "" };
const HOLE = /\{\{(me|owner|Owner|ta|place|ordinary)\}\}/g;
const fill = (s: string, n: PackNames): string =>
  s.includes("{{") ? s.replace(HOLE, (_, k: "me" | "owner" | "Owner" | "ta" | "place" | "ordinary") => k === "Owner" ? n.owner.charAt(0).toUpperCase() + n.owner.slice(1) : n[k] ?? "") : s;
/** A copy of a pack part with every string filled in — the strings themselves, and whatever its functions return */
function bound<V>(v: V, n: PackNames): V {
  if (typeof v === "string") return fill(v, n) as V;
  if (typeof v === "function") return ((...a: unknown[]) => bound((v as (...a: unknown[]) => unknown)(...a), n)) as V;
  if (Array.isArray(v)) return v.map((x) => bound(x, n)) as V;
  if (v !== null && typeof v === "object" && !(v instanceof RegExp)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bound(x, n)])) as V;
  return v;
}
const packs = new Map<string, LangPack>([[zh.code, zh], [en.code, en]]);
let current: LangPack = packs.get(DEFAULT_LANG)!;
/** The names this process speaks with (all empty until setLang is given a role's names) */
export let N: PackNames = NO_NAMES;
let named = false;

/** The current pack's prompts. A live binding: after setLang every importer reads the new pack — so never copy P.x into a module-level constant */
export let P: LangPack["prompts"] = current.prompts;
/** The current pack's tool text: descriptions, parameter descriptions, replies. A live binding like P — read T.x.y where it is used, never at module level */
export let T: LangPack["tools"] = current.tools;
/** The current pack's memory text: her own record as she is shown it, the event views, the recall replies, the wake-up note, and the event memory's façade (the replies of the memory writers, like, my_likes, the night's worklist). A live binding like P and T — read M.x.y where it is used, never at module level */
export let M: LangPack["memory"] = current.memory;
/** The current pack's gate text (read by src/gate/). A live binding like P, T and M — read G.x.y where it is used, never at module level. Empty until the gate's text moves in */
export let G: LangPack["gate"] = current.gate;
/** The current pack's learning text (read by src/learning/). A live binding; empty until the learning text moves in */
export let L: LangPack["learning"] = current.learning;
/** The current pack's sleep text (read by src/sleep/). A live binding; empty until the sleep text moves in */
export let S: LangPack["sleep"] = current.sleep;
/** The current pack's repair text (read by src/repair/). A live binding; empty until the repair text moves in */
export let R: LangPack["repair"] = current.repair;
/** The current pack's text of everything else: the brain, the memory store, the persona, the regions, the small modules */
export let B: LangPack["brain"] = current.brain;

/**
 * Register a pack (a later language; tests).
 * A pack built without the LangPack type (tests) must spread a whole pack, or code reading a missing part reads undefined.
 */
export function registerLang(pack: LangPack): void { packs.set(pack.code, pack); }

/**
 * The pack a code names; undefined, null or empty (after trim) = the default, like an absent config key.
 * A non-empty unknown code throws (a missing pack must be seen, not silently replaced by the default)
 */
function packOf(code?: string | null): LangPack {
  // 配置里写成 "lang": "" 也当没写：hhd 在有日志之前就调这里，抛了只剩一行控制台报错，进程起不来、被反复拉起
  const want = (typeof code === "string" ? code.trim() : code) || DEFAULT_LANG;
  const pack = packs.get(want);
  if (!pack) throw new Error(`no language pack "${code}" (have: ${[...packs.keys()].join(", ")})`);
  return pack;
}

/**
 * Choose the pack by code (the rules of packOf: empty = the default, unknown throws and leaves the pack in use) and,
 * when names are given, the role the text speaks as. Names stay bound across later calls that give none; null unbinds.
 * Unbound, the bindings are the pack's own objects and the placeholders are left as written.
 */
export function setLang(code?: string | null, names?: PackNames | null): void {
  const pack = packOf(code);
  current = pack;
  if (names !== undefined) { named = names !== null; N = names ?? NO_NAMES; }
  const filled: PackNames = { ...N, ordinary: N.ordinary || pack.brain.common?.ordinary || "" };
  const part = <V>(v: V): V => named ? bound(v, filled) : v;
  P = part(pack.prompts);
  T = part(pack.tools);
  M = part(pack.memory);
  G = part(pack.gate);
  L = part(pack.learning);
  S = part(pack.sleep);
  R = part(pack.repair);
  B = part(pack.brain);
}

/**
 * The config defaults of the pack setLang(code) would choose (same empty / unknown rules). The pack's own object, not a copy:
 * loadConfig clones it before merging, so the merged config never shares objects with the pack
 */
export function langDefaults(code?: string | null): DeepPartial<Config> { return packOf(code).defaults; }

/** One part of a pack against the reference's: total entries in the reference, the paths the pack lacks of its own, the paths it has that the reference does not */
export interface PartGaps { part: PartName; total: number; missing: string[]; extra: string[] }

/**
 * What the pack code names lacks of its own, per part: the entries it reads from the reference pack instead (dotted
 * paths, part first: tools.deliver.noChannel), and the ones it has that the reference does not (never read: a misspelled
 * name). A pack that is not an overlay has every entry of its own. Same code rules as setLang.
 */
export function langGaps(code?: string | null): PartGaps[] {
  const pack = packOf(code);
  return PARTS.map((part) => ({ part, ...gaps(zh[part], (pack.own ?? pack)[part], part) }));
}

/** The codes of the registered packs that are overlays */
export const overlayPacks = (): string[] => [...packs.values()].filter((p) => p.own).map((p) => p.code);

/** Code of the pack in use ("zh", "en", …) — for callers that pick their own resources by language */
export function langCode(): string { return current.code; }

/**
 * One value of every registered pack, with the role's names filled in as the bindings have them: for reading a form any
 * language may have stored (a role writes its own pack's, reads every pack's)
 */
export const fromEveryPack = <T>(pick: (pack: LangPack) => T): T[] => [...packs.values()].map((p) => (named ? bound(pick(p), N) : pick(p)));

/** The locale of the pack in use, for Intl date formats the role reads */
export function dateLocale(): string { return current.locale; }
