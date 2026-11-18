// 名单的权限上限：她自己能加人，但只能给到访客上限；主人批过的底子保留。
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "../util/atomic.ts";
import { B } from "../lang/index.ts";
import { LAYOUT } from "./layout.ts";

/** 名单文件（工作区里的相对路径） */
export const REGISTRY_FILE = LAYOUT.registry;
export const GUEST_CAP_SCRIPTS: Record<string, string[]> = { "scripts/relay.py": ["send"] };
export const PERMISSION_FIELDS = ["privacy", "trust", "shared", "shareTag", "sharedThreads", "allowedScripts"] as const;

type Entry = Record<string, unknown>;
const isObj = (v: unknown): v is Entry => typeof v === "object" && v !== null && !Array.isArray(v);

/** 和键顺序无关的深比较（名单文件被她改写后键顺序可能变） */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v as Entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canon(x)]));
  }
  return v;
}
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

/** 这个脚本允许哪些动作：访客上限 + 这个人批过的（按 (脚本, 动作) 算） */
function allowedActions(script: string, approvedScripts: unknown): string[] | undefined {
  const out: string[] = [];
  if (Object.hasOwn(GUEST_CAP_SCRIPTS, script)) out.push(...GUEST_CAP_SCRIPTS[script]!);
  if (isObj(approvedScripts) && Object.hasOwn(approvedScripts, script) && Array.isArray(approvedScripts[script])) {
    out.push(...(approvedScripts[script] as unknown[]).filter((a): a is string => typeof a === "string"));
  }
  return out.length ? out : undefined;
}

/** 单个权限字段过上限：value 为 undefined 表示这个字段被去掉；dropped 为是否裁了东西 */
function capField(field: string, value: unknown, extraScripts?: unknown): { value: unknown; dropped: boolean } {
  if (field === "privacy") return value === "guest" ? { value, dropped: false } : { value: "guest", dropped: true };
  if (field === "allowedScripts") {
    const kept: Record<string, string[]> = {};
    let cut = false;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [script, actions] of Object.entries(value as Entry)) {
        // 用 hasOwn：脚本名叫 constructor / toString 时不能摸到原型上的东西
        const allow = allowedActions(script, extraScripts);
        const acts = Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string") : [];
        const ok = allow ? acts.filter((a) => allow.includes(a)) : [];
        if (!allow || !Array.isArray(actions) || ok.length !== acts.length) cut = true;
        if (ok.length) kept[script] = ok;
      }
    } else cut = true;
    return { value: Object.keys(kept).length ? kept : undefined, dropped: cut };
  }
  if (Array.isArray(value) && value.length === 0) return { value, dropped: false };   // 空的没给任何东西，不算越权
  return { value: undefined, dropped: true };
}

/**
 * 把一条超出上限的权限裁到访客上限；非权限字段（身份、lens 等）原样不动。
 * 给了这个人批过的底子：和底子一样的字段留着，allowedScripts 里批过的（脚本, 动作）也留着
 */
export function capEntry(entry: Entry, approved?: Entry): { entry: Entry; dropped: string[] } {
  const out: Entry = { ...entry };
  const dropped: string[] = [];
  for (const f of PERMISSION_FIELDS) {
    if (!(f in out)) continue;
    if (approved && f in approved && sameValue(out[f], approved[f])) continue;
    const r = capField(f, out[f], f === "allowedScripts" ? approved?.allowedScripts : undefined);
    if (r.value === undefined) delete out[f]; else out[f] = r.value;
    if (r.dropped) dropped.push(f);
  }
  return { entry: out, dropped };
}

/** 底子里这个 key 的那条（只认自己的键：constructor 之类的名字不能摸到原型） */
export function baseOf(approved: Record<string, unknown>, key: string): Entry | undefined {
  return Object.hasOwn(approved, key) && isObj(approved[key]) ? approved[key] : undefined;
}

/** 升过权的人：底子里批过的权限超出访客上限（如 trusted、共享文件、别的脚本） */
export function isElevated(base: unknown): boolean {
  return isObj(base) && base.privacy !== "owner" && capEntry(base).dropped.length > 0;
}

const strsOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
export const HANDLE_PLATFORMS = ["wx", "xhs", "bili"] as const;

/** 认人用的字段（号、会话、各平台显示名）：升过权的人批准时连这些一起记进底子 */
export function identityOf(e: Entry): Entry {
  const h = isObj(e.handles) ? e.handles : {};
  const handles: Entry = {};
  for (const p of HANDLE_PLATFORMS) if (strsOf(h[p]).length) handles[p] = strsOf(h[p]);
  return { senders: strsOf(e.senders), sessionKeys: strsOf(e.sessionKeys), handles };
}

/**
 * 认人字段按 People 查找时的比法摊平（要一模一样，不然这里算批过、那边认的却是另一个）：
 * 号去空白、不分大小写、带不带 + 算同一个；会话只不分大小写；显示名按平台、去空白、不分大小写。
 * 值是给人看的样子（senders +614…、handles.wx 阿青）
 */
export function idKeys(e: Entry): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of strsOf(e.senders)) if (s.trim()) out.set(`s:${s.trim().toLowerCase().replace(/^\+/, "")}`, `senders ${s}`);
  for (const s of strsOf(e.sessionKeys)) if (s) out.set(`k:${s.toLowerCase()}`, `sessionKeys ${s}`);
  const h = isObj(e.handles) ? e.handles : {};
  for (const p of HANDLE_PLATFORMS) for (const x of strsOf(h[p])) if (x.trim()) out.set(`h:${p}:${x.trim().toLowerCase()}`, `handles.${p} ${x}`);
  return out;
}

/** e 里有、approvedIds 里没有的认人字段（给人看的样子） */
export function newIdentifiers(e: Entry, approvedIds: Entry): string[] {
  const ok = idKeys(approvedIds);
  return [...idKeys(e)].filter(([k]) => !ok.has(k)).map(([, d]) => d);
}

/** 批准底子：owner 整条存（身份字段也钉住）；其他人存权限字段，升过权的连认人字段一起存（ruling 38） */
export function approvedFrom(registry: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, v] of Object.entries(registry)) {
    if (key.startsWith("_") || !isObj(v)) continue;
    if (v.privacy === "owner") { out[key] = { ...v }; continue; }
    const f: Record<string, unknown> = {};
    for (const p of PERMISSION_FIELDS) if (p in v) f[p] = v[p];
    if (isElevated(f)) f.identity = identityOf(v);
    out[key] = f;
  }
  return out;
}

/**
 * 上线后第一次装名单：底子里升过权、但还没记认人字段的人，按现在的文件记一次（文件里没有这个人就记空的）。
 * 改的是 base 本身；返回记了哪些 key
 */
export function storeMissingIdentity(base: Record<string, Record<string, unknown>>, registry: Record<string, unknown>): string[] {
  const done: string[] = [];
  for (const [key, b] of Object.entries(base)) {
    if (!isElevated(b) || isObj(b.identity)) continue;
    const cur = Object.hasOwn(registry, key) && isObj(registry[key]) ? registry[key] : {};
    b.identity = identityOf(cur);
    done.push(key);
  }
  return done;
}

/** 底子里的主人（整条存着的那几个 key） */
export function ownersOf(approved: Record<string, unknown>): string[] {
  return Object.entries(approved).filter(([, v]) => isObj(v) && v.privacy === "owner").map(([k]) => k);
}

/**
 * 逐个权限字段：和底子一样就留，不一样（或底子里没有）只那一个字段过上限。
 * 升过权的人：文件里多了底子里没有的号 / 会话 / 显示名，整条权限按访客上限（宁可错关，等主人 approve；删掉的不算）。
 * 底子里的 owner 整条用底子的：文件里改了、写成别的类型、删了、改了名，都按底子补回来（只有 approve 能改它，R11）
 */
export function applyApproved(
  registry: Record<string, unknown>, approved: Record<string, Record<string, unknown>>,
): { registry: Record<string, unknown>; dropped: Array<{ key: string; field: string }>; unapproved: Array<{ key: string; ids: string[] }> } {
  const out: Record<string, unknown> = {};
  const dropped: Array<{ key: string; field: string }> = [];
  const unapproved: Array<{ key: string; ids: string[] }> = [];
  const owners = new Set(ownersOf(approved));
  for (const [key, v] of Object.entries(registry)) {
    if (owners.has(key)) { out[key] = { ...approved[key] }; continue; }
    if (key.startsWith("_") || !isObj(v)) { out[key] = v; continue; }
    const base = baseOf(approved, key);
    // 底子里没记认人字段（还没迁移、坏了）就当什么都没批过：有号就关
    const extra = isElevated(base) ? newIdentifiers(v, isObj(base!.identity) ? base!.identity : {}) : [];
    if (extra.length) unapproved.push({ key, ids: extra });
    const r = capEntry(v, extra.length ? undefined : base);
    out[key] = r.entry;
    for (const field of r.dropped) dropped.push({ key, field });
  }
  for (const key of owners) if (!Object.hasOwn(out, key)) out[key] = { ...approved[key] };
  return { registry: out, dropped, unapproved };
}

/** 名字 / key 比较的样子：小写去空白，和起 key 的样子（A Qing → aqing） */
const nameForms = (x: string): string[] => [x.trim().toLowerCase(), keyFor(x)];

/**
 * 工具加人 / 改人前查撞没撞（ruling 40）：新带来的名字或 key、号、会话、显示名已经是名单里别人的，就说是谁的；没撞返回 null
 */
export function clashOf(others: Array<[string, Entry]>, mine: { names: string[]; ids: Map<string, string> }): string | null {
  for (const [k, e] of others) {
    const who = B.registry.personLabel(typeof e.name === "string" && e.name.trim() ? e.name : k, k);
    const theirs = new Set([...nameForms(k), ...(typeof e.name === "string" && e.name.trim() ? nameForms(e.name) : [])]);
    const n = mine.names.find((x) => nameForms(x).some((f) => theirs.has(f)));
    if (n !== undefined) return B.registry.nameClash(n, who);
    const theirIds = idKeys(e);
    for (const [id, d] of mine.ids) if (theirIds.has(id)) return B.registry.idClash(d, who);
  }
  return null;
}

/** 改了什么（每日总结里主人看的）：号、会话、显示名写出加了哪个、删了哪个，别的字段写新值 */
export function changeText(old: Entry, next: Entry): string[] {
  const out: string[] = [];
  const list = (label: string, a: string[], b: string[]) => {
    const add = b.filter((x) => !a.includes(x));
    const del = a.filter((x) => !b.includes(x));
    if (add.length || del.length) out.push(`${label} ${[...add.map((x) => B.registry.changeAdded(x)), ...del.map((x) => B.registry.changeRemoved(x))].join(" ")}`);
  };
  for (const k of [...new Set([...Object.keys(old), ...Object.keys(next)])]) {
    if (sameValue(old[k], next[k])) continue;
    if (k === "senders" || k === "sessionKeys" || k === "aliases") list(k, strsOf(old[k]), strsOf(next[k]));
    else if (k === "handles") {
      const a = isObj(old.handles) ? old.handles : {};
      const b = isObj(next.handles) ? next.handles : {};
      for (const p of [...new Set([...Object.keys(a), ...Object.keys(b)])]) list(`handles.${p}`, strsOf(a[p]), strsOf(b[p]));
    } else if (!Object.hasOwn(next, k)) out.push(B.registry.changeRemoved(k));
    else {
      const v = typeof next[k] === "string" ? (next[k] as string) : JSON.stringify(next[k]);
      out.push(`${k} ${v.length > 40 ? `${v.slice(0, 39)}…` : v}`);
    }
  }
  return out;
}

// ---------- 她的工具（people_i_know）改名单文件 ----------

/** 名单文件原样（_说明 之类的键也留着）；文件不在 → 空的；读不了、顶层不是对象 → error */
export function readRegistryFile(path: string): { reg: Entry } | { error: string } {
  if (!existsSync(path)) return { reg: {} };
  let v: unknown;
  try { v = JSON.parse(readFileSync(path, "utf8")); } catch (e) { return { error: (e as Error).message }; }
  return isObj(v) ? { reg: v } : { error: B.registry.fileNotObject };
}

/** 原子写回，照她文件原来的样子（两格缩进、结尾不加换行） */
export function writeRegistryFile(path: string, reg: Entry): void {
  writeFileAtomic(path, JSON.stringify(reg, null, 2));
}

/** add 没给 key：名字是英文字母数字就用它（小写、去掉空格和连字符），不然用名字的 sha1 前 6 位 */
export function keyFor(name: string): string {
  const s = name.trim().toLowerCase().replace(/[\s_-]+/g, "");
  return /^[a-z0-9]+$/.test(s) ? s : `p${createHash("sha1").update(name.trim()).digest("hex").slice(0, 6)}`;
}

const isStrs = (v: unknown): boolean => Array.isArray(v) && v.every((x) => typeof x === "string");

/** 工具要写的条目里认人字段的类型：错了不写（手改文件时 People 会忽略坏字段，工具这里直接说清楚） */
export function entryProblem(e: Entry): string | null {
  if (e.name !== undefined && (typeof e.name !== "string" || !e.name.trim())) return B.registry.entryNameInvalid;
  for (const f of ["senders", "sessionKeys", "aliases"]) {
    if (e[f] !== undefined && e[f] !== null && !isStrs(e[f])) return B.registry.entryFieldNotStrings(f);
  }
  if (e.handles !== undefined && e.handles !== null) {
    if (!isObj(e.handles)) return B.registry.entryHandlesNotObject;
    for (const [k, v] of Object.entries(e.handles)) {
      if (!(HANDLE_PLATFORMS as readonly string[]).includes(k)) return B.registry.entryHandlesUnknownPlatform(k);
      if (v !== null && !isStrs(v)) return B.registry.entryHandlesNotStrings(k);
    }
  }
  return null;
}

/**
 * 她用工具加 / 改一个人：patch 合进原来的条目（null 删掉那个字段；handles 按平台合并）。
 * 这次写的权限字段过 capEntry（和这个人批过的底子一样的不算越权）；被裁掉的字段保持原样
 */
export function mergePerson(existing: Entry | undefined, patch: Entry, approved: Entry | undefined): { entry: Entry; dropped: string[] } {
  const sets: Entry = {};
  const dels: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__") continue;   // 不能借这个改原型
    if (v === null) dels.push(k); else sets[k] = v;
  }
  const { entry: capped, dropped } = capEntry(sets, approved);
  const next: Entry = { ...(existing ?? {}) };
  for (const [k, v] of Object.entries(capped)) {
    if (k === "handles" && isObj(v)) {
      const h: Entry = isObj(next.handles) ? { ...next.handles } : {};
      for (const [p, x] of Object.entries(v)) { if (x === null) delete h[p]; else h[p] = x; }
      next.handles = h;
    } else next[k] = v;
  }
  for (const k of dels) delete next[k];
  return { entry: next, dropped };
}

/** 各平台叫什么、什么号（list 和变动记录用，号照写，主人看总结时要看得见）：微信：a、b；小红书：c；号：+614… */
export function handlesText(e: Entry): string {
  const parts: string[] = [];
  const h = isObj(e.handles) ? e.handles : {};
  for (const p of HANDLE_PLATFORMS) {
    const xs = strsOf(h[p]).filter((x) => x.trim());
    if (xs.length) parts.push(B.registry.handlesPlatformLine(({ wx: B.registry.platformNameWx, xhs: B.registry.platformNameXhs, bili: B.registry.platformNameBili } as Record<string, string>)[p]!, xs.join(B.registry.listSeparator)));
  }
  if (strsOf(e.senders).length) parts.push(B.registry.sendersLine(strsOf(e.senders).join(B.registry.listSeparator)));
  if (strsOf(e.sessionKeys).length) parts.push(B.registry.sessionsLine(strsOf(e.sessionKeys).join(B.registry.listSeparator)));
  return parts.join(B.common.listSep);
}
