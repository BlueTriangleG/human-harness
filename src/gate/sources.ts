// 通道表：角色的感官脚本送来的每个来源算哪一类。表在实例配置 senses.sources 里，框架的默认全空。
// 闸门、每日总结、主脑、控制台都经这里读，别处不再各写一份来源名单（11-14 以前三处各写一份，已经不一致过）。
import type { Config } from "../config.ts";

export const SOURCE_KINDS = ["chat", "public", "probe", "always", "hands"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
/**
 * chat：聊天——按名单认人、陌生人私聊走规则、控制台遮访客原文、每日总结提名进名单。
 * public：公开场合别人对角色说的——交规则判，控制台不遮，送去时带上怎么回。
 * probe：角色自己的探针——只有它们带的 alarm、「要你处理」算数（聊天来源里谁都能打出这几个字）。
 * always：一律直达。hands：帮手的回报。一个来源可以在几类里；表里没有的交规则判。
 */
export type Sources = Readonly<Record<SourceKind, ReadonlySet<string>>>;

/** HH 自己生成、不经感官脚本的来源：plain（没有事件行的一整段文字）一律直达 */
export const HH_ALWAYS: ReadonlySet<string> = new Set(["plain"]);
/** HH 自己的来源（plain；hh-quota 是 hhd 自己的额度提醒，交规则）：不在任何角色的表里，控制台不当聊天遮 */
const HH_OWN: ReadonlySet<string> = new Set(["plain", "hh-quota"]);

/** 配置里的一张表 → 集合。缺的类、不是数组的类当空的；数组里不是字符串的、空字符串跳过（写坏了宁可少认：认不出人走规则，控制台照遮） */
export function sourcesFrom(raw: unknown): Sources {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const set = (k: SourceKind): ReadonlySet<string> => {
    const v = Object.hasOwn(o, k) ? o[k] : undefined;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x !== "") : []);
  };
  return { chat: set("chat"), public: set("public"), probe: set("probe"), always: set("always"), hands: set("hands") };
}

/**
 * The instance table (senses.sources) with the kinds the modules declare (ModuleSpec.senseKinds) added: a source the
 * instance table names anywhere keeps only its kinds there; the others get what their module declares (hhd at start)
 */
export function withDeclared(raw: unknown, declared: ReadonlyArray<Partial<Record<SourceKind, readonly string[]>>>): Record<SourceKind, string[]> {
  const own = sourcesFrom(raw);
  const named = new Set(SOURCE_KINDS.flatMap((k) => [...own[k]]));
  return Object.fromEntries(SOURCE_KINDS.map((k) => [k, [...own[k], ...new Set(declared.flatMap((d) => (d[k] ?? []).filter((s) => !named.has(s))))]])) as Record<SourceKind, string[]>;
}

/** 实例配置里的通道表 */
export function sourcesOf(cfg: Pick<Config, "senses">): Sources {
  return sourcesFrom(cfg.senses?.sources);
}

/** 只走固定路的来源（帮手、一律直达的、HH 自己的 plain）：角色的规则管不到它们 */
export function fixedSrcs(sources: Sources): ReadonlySet<string> {
  return new Set([...sources.hands, ...sources.always, ...HH_ALWAYS]);
}

/**
 * 控制台：这个来源的行要不要按聊天来遮访客的原文。在 chat 里的遮；HH 自己的不遮；
 * 表里明确标成别的类（public / probe / always / hands）的不遮；表里没有的（新角色的新来源还没标、表读不到）当聊天遮——宁可多遮
 */
export function maskAsChat(sources: Sources, src: string): boolean {
  if (sources.chat.has(src)) return true;
  if (HH_OWN.has(src)) return false;
  return !SOURCE_KINDS.some((k) => k !== "chat" && sources[k].has(src));
}
