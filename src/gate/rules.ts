// 潜意识门：她自己的规则（工作区里，配置 gate.rulesFile 指的那份）。从上往下第一条命中的生效。
import { existsSync, readFileSync } from "node:fs";
import type { Logger } from "../log.ts";
import type { People } from "../persona/people.ts";
import { writeFileAtomic } from "../util/atomic.ts";
import { fixedRoute, knownOf } from "./fixed.ts";
import type { Sources } from "./sources.ts";
import type { Action, SenseEvent, When } from "./types.ts";
import { G } from "../lang/index.ts";

export interface RuleMatch { src?: string | string[]; conv?: string; sender?: string; known?: boolean; isGroup?: boolean; mentionsMe?: boolean; keywords?: string[]; regex?: string }
/** 小判断说「值得看」但拿不准时怎么办（只对 action judge 有用）：main 照样直达（不写就是这样），digest 进总结 */
export type IfUnsure = "main" | "digest";
export interface Rule { id: string; match: RuleMatch; action: Action; when?: When; want?: string; ifUnsure?: IfUnsure; note?: string }
export interface RuleHit { ruleId: string | null; action: Action; when: When; want: string; ifUnsure?: IfUnsure }

/** What a rule wants seen when it says nothing, in the role's language (read when asked: the pack is chosen after load) */
export const defaultWant = (): string => G.rules.defaultWant;

/** HH 不带人格规则：她自己的规则在她工作区里（配置 gate.rulesFile） */
export const INITIAL_RULES: Rule[] = [];

const ACTIONS = ["main", "judge", "digest", "drop"];
const WHENS = ["now", "work", "leisure"];
const IF_UNSURE = ["main", "digest"];

export function validateRule(r: unknown): { rule: Rule } | { error: string } {
  if (typeof r !== "object" || r === null || Array.isArray(r)) return { error: G.rules.invalidRuleNotObject };
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return { error: G.rules.invalidRuleId };
  if (typeof o.match !== "object" || o.match === null || Array.isArray(o.match)) return { error: G.rules.invalidMatchNotObject(o.id) };
  if (typeof o.action !== "string" || !ACTIONS.includes(o.action)) return { error: G.rules.invalidAction(o.id) };
  if (o.when !== undefined && (typeof o.when !== "string" || !WHENS.includes(o.when))) return { error: G.rules.invalidWhen(o.id) };
  if (o.want !== undefined && typeof o.want !== "string") return { error: G.rules.invalidWant(o.id) };
  if (o.ifUnsure !== undefined && (typeof o.ifUnsure !== "string" || !IF_UNSURE.includes(o.ifUnsure))) return { error: G.rules.invalidIfUnsure(o.id) };
  if (o.note !== undefined && typeof o.note !== "string") return { error: G.rules.invalidNote(o.id) };
  const bad = badMatch(o.match as Record<string, unknown>);
  if (bad) return { error: G.rules.invalidMatchField(o.id, bad) };
  return { rule: o as unknown as Rule };
}

// match 里每个字段的类型：手改文件写错了（比如 keywords 写成字符串）要在加载时拦下，不能到匹配时才炸
const isStr = (v: unknown) => typeof v === "string";
const isStrs = (v: unknown) => Array.isArray(v) && v.every(isStr);
const MATCH_TYPES: Record<string, [(v: unknown) => boolean, () => string]> = {
  src: [(v) => isStr(v) || isStrs(v), () => G.rules.matchSrcType],
  conv: [isStr, () => G.rules.matchConvType], sender: [isStr, () => G.rules.matchSenderType], regex: [isStr, () => G.rules.matchRegexType],
  keywords: [isStrs, () => G.rules.matchKeywordsType],
  known: [(v) => typeof v === "boolean", () => G.rules.matchKnownType], isGroup: [(v) => typeof v === "boolean", () => G.rules.matchIsGroupType],
  mentionsMe: [(v) => typeof v === "boolean", () => G.rules.matchMentionsMeType],
};
function badMatch(m: Record<string, unknown>): string | null {
  for (const [k, v] of Object.entries(m)) {
    // hasOwn：字段名叫 constructor / __proto__ 时不能摸到原型上的东西（不然这里会抛）
    const t = Object.hasOwn(MATCH_TYPES, k) ? MATCH_TYPES[k] : undefined;
    if (!t) return G.rules.matchFieldUnknown(k);
    if (!t[0](v)) return t[1]();
  }
  if (typeof m.regex === "string" && tooComplex(m.regex)) return G.rules.matchRegexTooComplex;
  return null;
}

/**
 * 会卡死匹配的正则（灾难性回溯）的粗查：太长，或者一个组里有 + / * / {、组后面又跟着 + / * / {。
 * 转义的字符和 [...] 里的不算
 */
export function tooComplex(re: string): boolean {
  if (re.length > 200) return true;
  const groups: boolean[] = [];   // 每个还没关的组里有没有重复（+ / * / {）
  for (let i = 0; i < re.length; i++) {
    const c = re[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") {   // 字符类：跳到没转义的 ]
      for (i++; i < re.length && re[i] !== "]"; i++) if (re[i] === "\\") i++;
      continue;
    }
    if (c === "(") { groups.push(false); continue; }
    // 组里的 {n,m} 也是重复：(a{1,})+ 和 (a+)+ 一样会卡死
    if (c === "+" || c === "*" || c === "{") { if (groups.length) groups[groups.length - 1] = true; continue; }
    if (c === ")") {
      const inner = groups.pop() ?? false;
      const next = re[i + 1];
      if (inner && (next === "+" || next === "*" || next === "{")) return true;
      if (inner && groups.length) groups[groups.length - 1] = true;   // 套着的组：里面的重复也算外面的
    }
  }
  return false;
}

// 命中判断。regex 每条规则只编一次（缓存），编不过的规则由加载时先筛掉
const reCache = new WeakMap<Rule, RegExp | null>();
function ruleRegex(rule: Rule): RegExp | null {
  if (reCache.has(rule)) return reCache.get(rule)!;
  let re: RegExp | null = null;
  try { if (typeof rule.match.regex === "string") re = new RegExp(rule.match.regex); } catch { re = null; }
  reCache.set(rule, re);
  return re;
}

function ruleMatches(rule: Rule, ev: SenseEvent, known: boolean): boolean {
  const m = rule.match;
  if (m.src !== undefined && !(Array.isArray(m.src) ? m.src.includes(ev.src) : m.src === ev.src)) return false;
  if (m.conv !== undefined && m.conv !== ev.conv) return false;
  if (m.sender !== undefined && m.sender !== ev.sender) return false;
  if (m.known !== undefined && m.known !== known) return false;
  if (m.isGroup !== undefined && m.isGroup !== (ev.isGroup ?? false)) return false;
  if (m.mentionsMe !== undefined && m.mentionsMe !== (ev.mentionsMe ?? false)) return false;
  if (m.keywords !== undefined && !m.keywords.some((k) => ev.text.includes(k))) return false;
  if (m.regex !== undefined) {
    const re = ruleRegex(rule);
    if (!re || !re.test(ev.text)) return false;
  }
  return true;
}

export function matchRules(rules: Rule[], ev: SenseEvent, known: boolean, defaultWant = G.rules.defaultWant): RuleHit {
  for (const r of rules) {
    // 一条规则判断时出错（比如内存里塞了坏规则）就跳过它，不能让异常冒出去
    let hit = false;
    try { hit = ruleMatches(r, ev, known); } catch { hit = false; }
    if (hit) return { ruleId: r.id, action: r.action, when: r.when ?? "now", want: r.want ?? defaultWant, ...(r.ifUnsure ? { ifUnsure: r.ifUnsure } : {}) };
  }
  return { ruleId: null, action: "judge", when: "now", want: defaultWant };
}

export class Rules {
  private readonly path: string;
  private readonly readFile: (p: string) => string | null;
  private readonly mtime: (p: string) => number | null;
  private readonly log: Logger;
  private readonly defaultWant: string;
  private warnedMissing = false;
  private rules: Rule[] = INITIAL_RULES;
  private errs: string[] = [];
  private loaded = false;   // 是否成功读过一份文件
  private seen: number | null | undefined = undefined;   // undefined：还没读过

  constructor(o: { path: string; readFile: (p: string) => string | null; mtime: (p: string) => number | null; log: Logger; defaultWant?: string }) {
    this.defaultWant = (o.defaultWant?.trim() ? o.defaultWant : G.rules.defaultWant);   // 空串、空白也用自带的（?? 拦不住空串）
    this.path = o.path; this.readFile = o.readFile; this.mtime = o.mtime; this.log = o.log;
  }

  current(): Rule[] {
    let mt: number | null = null;
    try { mt = this.mtime(this.path); } catch { mt = null; }
    if (mt === this.seen) return this.rules;
    this.seen = mt;
    this.load(mt);
    return this.rules;
  }

  errors(): string[] { return this.errs; }

  /** 工具刚写过文件：下次 current() 一定重读（不只靠 mtime，同一毫秒里写两次也不漏） */
  reread(): void { this.seen = undefined; }

  match(ev: SenseEvent, known: boolean): RuleHit { return matchRules(this.current(), ev, known, this.defaultWant); }

  private noFile() {
    this.rules = INITIAL_RULES;
    this.errs = [G.rules.fileMissingNoRules];
    if (!this.warnedMissing) { this.warnedMissing = true; this.log.warn(G.rules.fileMissingLog); }
  }

  private load(mt: number | null) {
    // 没文件：从没读过 → 没有规则（都交给下意识判断，记一笔）；读过 → 留上一份并记一笔
    if (mt === null) {
      if (this.loaded) return this.keepLast(G.rules.fileVanished);
      return this.noFile();
    }
    let top: unknown;
    try {
      const raw = this.readFile(this.path);
      if (raw === null) {
        if (this.loaded) return this.keepLast(G.rules.fileUnreadable);
        return this.noFile();
      }
      top = JSON.parse(raw);
    } catch (e) {
      return this.keepLast(G.rules.fileReadFailed((e as Error).message));
    }
    const list = (top as { rules?: unknown } | null)?.rules;
    if (!Array.isArray(list)) return this.keepLast(G.rules.fileNoRulesArray);
    const good: Rule[] = [];
    const errs: string[] = [];
    for (const item of list) {
      const v = validateRule(item);
      if ("error" in v) { errs.push(v.error); continue; }
      if (typeof v.rule.match.regex === "string") {
        try { new RegExp(v.rule.match.regex); } catch { errs.push(G.rules.fileRegexInvalid(v.rule.id)); continue; }
      }
      good.push(v.rule);
    }
    this.rules = good;
    this.loaded = true;
    this.errs = errs;
    if (errs.length) this.log.warn(G.rules.fileRulesSkippedLog, { errors: errs });
  }

  // 坏了留上一份能用的；从没成功过 → 空规则集，全落到默认小判断（spec §4.3）
  private keepLast(err: string) {
    if (!this.loaded) this.rules = [];
    this.errs = [err];
    this.log.warn(G.rules.fileKeepingLastLog, { error: err });
  }
}

// ---------- 她的工具（what_reaches_me）改规则文件 ----------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const idOf = (x: unknown): unknown => (isObj(x) ? x.id : undefined);

/** 工具写进文件之前的检查：validateRule + regex 编得过 + 不是只管固定来源的（那种规则永远轮不到，等于没写；fixed 是 sources.ts 的 fixedSrcs） */
export function checkRule(r: unknown, fixed: ReadonlySet<string>): { rule: Rule } | { error: string } {
  const v = validateRule(r);
  if ("error" in v) return v;
  const { rule } = v;
  if (typeof rule.match.regex === "string") {
    try { new RegExp(rule.match.regex); } catch (e) { return { error: G.rules.toolRegexInvalid(rule.id, (e as Error).message) }; }
  }
  const srcs = rule.match.src === undefined ? [] : [rule.match.src].flat();
  if (srcs.length && srcs.every((x) => fixed.has(x))) {
    return { error: G.rules.toolRuleOnlyFixedSources(rule.id, srcs.join(G.rules.toolSourceSeparator)) };
  }
  return { rule };
}

/** 规则文件原样（坏条目也留着，写回去不丢；顶层别的键也留着）。文件不在 → 空规则集（和闸门一样）；读不了 → error */
export function readRuleFile(path: string): { top: Obj; list: unknown[]; fresh: boolean } | { error: string } {
  if (!existsSync(path)) return { top: {}, list: structuredClone(INITIAL_RULES), fresh: true };
  let top: unknown;
  try { top = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { error: (e as Error).message }; }
  if (!isObj(top) || !Array.isArray(top.rules)) return { error: G.rules.toolFileNoRulesArray };
  return { top, list: top.rules, fresh: false };
}

/** 原子写回 */
export function writeRuleFile(path: string, top: Obj, list: unknown[]): void {
  writeFileAtomic(path, JSON.stringify({ ...top, rules: list }, null, 2) + "\n");
}

/** edit 的合并：只写要改的字段；match 按字段合并；null 删掉那个字段 */
export function mergeRule(old: unknown, patch: Obj): Obj {
  const out: Obj = isObj(old) ? { ...old } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__") continue;   // 不能借这个改原型
    if (k === "match" && isObj(v)) {
      const m: Obj = isObj(out.match) ? { ...out.match } : {};
      for (const [mk, mv] of Object.entries(v)) {
        if (mk === "__proto__") continue;
        if (mv === null) delete m[mk]; else m[mk] = mv;
      }
      out.match = m;
    } else if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

export type RuleChange =
  | { kind: "add"; rule: unknown; to?: number }
  | { kind: "edit"; id: string; patch: Obj }
  | { kind: "remove"; id: string }
  | { kind: "move"; id: string; to: number };

/** 在一份规则列表上做一个改动（不碰文件，try 也用它）；at：改动后那条在第几条 */
export function changeRules(list: readonly unknown[], c: RuleChange, fixed: ReadonlySet<string>): { list: unknown[]; id: string; at: number } | { error: string } {
  const next = [...list];
  const has = (id: string, except = -1) => next.some((x, i) => i !== except && idOf(x) === id);
  if (c.kind === "add") {
    const v = checkRule(c.rule, fixed);
    if ("error" in v) return v;
    if (has(v.rule.id)) return { error: G.rules.toolRuleIdExists(v.rule.id) };
    const at = c.to ?? 0;   // 默认放最前面：新加的通常是想让它先生效的例外
    if (at > next.length) return { error: G.rules.toolPositionOutOfRange(next.length) };
    next.splice(at, 0, v.rule);
    return { list: next, id: v.rule.id, at };
  }
  const i = next.findIndex((x) => idOf(x) === c.id);
  if (i < 0) return { error: G.rules.toolRuleNotFound(c.id) };
  if (c.kind === "remove") {
    next.splice(i, 1);
    return { list: next, id: c.id, at: i };
  }
  if (c.kind === "move") {
    if (c.to > next.length - 1) return { error: G.rules.toolPositionOutOfRangeAtMove(next.length - 1) };
    const [x] = next.splice(i, 1);
    next.splice(c.to, 0, x);
    return { list: next, id: c.id, at: c.to };
  }
  const v = checkRule(mergeRule(next[i], c.patch), fixed);
  if ("error" in v) return v;
  if (has(v.rule.id, i)) return { error: G.rules.toolRuleIdTaken(v.rule.id) };
  next[i] = v.rule;
  return { list: next, id: v.rule.id, at: i };
}

const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** list 里的一行：编号 id：动作 when｜match｜拿不准怎么办（写了才有）｜want（最多 60 字） */
export function ruleLine(r: Rule, i: number): string {
  const m = Object.entries(r.match).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`).join(" ") || G.rules.listMatchAll;
  const unsure = r.ifUnsure ? G.rules.listIfUnsure(G.rules.outcomeName[r.ifUnsure === "digest" ? "digest" : "main"], r.action === "judge" ? "" : G.rules.listUnsureJudgeOnly) : "";
  return G.rules.listRuleLine(i, r.id, r.action, r.when ?? "now", m, unsure, r.want ? G.rules.listWant(cut(r.want, 60)) : "");
}

/** How a sense event goes, in the order the check lists them (the actions' own names; G.rules.outcomeName says them) */
export const OUTCOMES = ["main", "judge", "digest", "drop"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** try：这批动静按这套规则会怎么走。和闸门同一个顺序：先固定规则，再她的规则；只算，不判断、不送、不记账 */
export function tryRules(evs: readonly SenseEvent[], rules: Rule[], people: People, names: { me: string; notMe: string[] }, sources: Sources): Array<{ ev: SenseEvent; outcome: Outcome; ruleId: string | null }> {
  return evs.map((ev) => {
    const f = fixedRoute(ev, people, names, sources);
    if (f?.kind === "main" || f?.kind === "hands") return { ev, outcome: "main" as Outcome, ruleId: null };
    if (f?.kind === "judge-floor") return { ev, outcome: "judge" as Outcome, ruleId: null };   // 主人在群里没 @：必判
    const hit = matchRules(rules, ev, knownOf(ev, people));
    return { ev, outcome: hit.action, ruleId: hit.ruleId };
  });
}
