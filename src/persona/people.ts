// 认人：按她现有的 memory/people/registry.json（渠道号码 / 会话 → 是谁）。
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { applyApproved, ownersOf, REGISTRY_FILE } from "./registry.ts";
import { B } from "../lang/index.ts";

export interface Person { key: string; name: string; privacy: string; trust?: string; profile?: string }

/** 各平台上的显示名（微信备注、小红书/B站昵称） */
export interface Handles { wx?: string[]; xhs?: string[]; bili?: string[] }

interface RegistryEntry { name?: string; privacy?: string; trust?: string; profile?: string; senders?: string[]; sessionKeys?: string[]; handles?: Handles }

/** 名单文件的 mtime 和内容（Brain 靠它在她手改后重载）；文件不在 mtime 为 null */
export function registryFileOf(workspace: string): { mtime(): number | null; read(): Record<string, unknown> } {
  const p = join(workspace, REGISTRY_FILE);
  return {
    mtime: () => (existsSync(p) ? statSync(p).mtimeMs : null),
    read: () => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>,
  };
}

/** 这个人和她是什么关系（她每次收到消息都会看到这一句） */
export function relationOf(p: Person | null): string {
  if (!p) return B.personaPeople.relationLineStranger;
  if (p.privacy === "owner") return B.personaPeople.relationLineOwner;
  return p.trust === "trusted" ? B.personaPeople.relationLineTrustedFriend : B.personaPeople.relationLineFriend;
}

/** 名字 → 名单 key（事件库里那个人的名字、别名；认不出、拿不准是 null）。只用在聊天显示名上：分流和遮，不算核实，也认不出主人 */
export type AliasKey = (name: string) => string | null;

/** 号的查找键：不分大小写，带不带 + 算同一个（一张表里比，主人后填就总能赢，不会被「不带 +」的那一格抢先） */
const senderKey = (s: string): string => s.trim().toLowerCase().replace(/^\+/, "");

export class People {
  /** 名单原样（事件库同步别名用） */
  readonly registry: Record<string, unknown>;
  private readonly byName = new Map<string, string[]>();
  private readonly bySender = new Map<string, Person>();
  private readonly bySession = new Map<string, Person>();
  private readonly byHandle = new Map<string, Person>();   // "平台:名字"
  private readonly byKey = new Map<string, Person>();
  /** 名单 handles 认不出的显示名再问它（Brain 接事件库：库里那个人的名字、别名）；没给就不问 */
  private readonly aliasKey: AliasKey | undefined;
  /** 按库里的名字一律不认的 key：名单（原样的）里或批准底子里写着 owner 的，不管裁过以后是什么（宁可多护一个，final-review N1） */
  private readonly aliasNever: ReadonlySet<string>;
  /** load 时被权限上限裁掉的字段 */
  dropped: Array<{ key: string; field: string }> = [];
  /** load 时升过权的人身上多出来的、没批过的号 / 会话 / 显示名（这些人的权限按访客上限） */
  unapproved: Array<{ key: string; ids: string[] }> = [];

  /** 构造时发现的坏字段（类型不对的被忽略），Brain 会记日志 */
  readonly issues: string[] = [];

  /** owners：另外算主人的 key（People.from 给：原样的名单和底子里的主人；裁过的名单里主人可能成了访客） */
  constructor(registry: Record<string, unknown>, aliasKey?: AliasKey, owners: Iterable<string> = []) {
    this.registry = registry;
    this.aliasKey = aliasKey;
    this.aliasNever = new Set([...ownersOf(registry), ...owners]);
    const strs = (key: string, field: string, v: unknown): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) this.issues.push(B.personaPeople.issueNotStringArray(key, field));
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    };
    const entries = Object.entries(registry).filter((kv): kv is [string, Record<string, unknown>] =>
      !kv[0].startsWith("_") && typeof kv[1] === "object" && kv[1] !== null && !Array.isArray(kv[1]));
    // 主人的放最后填：别的条目写了同一个号、会话、名字、显示名，也抢不走主人的（后填的覆盖先填的）
    const isOwner = (e: Record<string, unknown>) => e.privacy === "owner";
    for (const [key, e] of [...entries.filter(([, e]) => !isOwner(e)), ...entries.filter(([, e]) => isOwner(e))]) {
      const str = (x: unknown): string | undefined => (typeof x === "string" && x ? x : undefined);
      const name = str(e.name) ?? key;
      const p: Person = {
        key, name, privacy: str(e.privacy) ?? "guest",
        ...(str(e.trust) ? { trust: str(e.trust)! } : {}), ...(str(e.profile) ? { profile: str(e.profile)! } : {}),
      };
      const senders = strs(key, "senders", e.senders);
      const sessionKeys = strs(key, "sessionKeys", e.sessionKeys);
      this.byKey.set(key, p);
      this.byName.set(key.toLowerCase(), senders);
      this.byName.set(name.toLowerCase(), senders);
      for (const s of senders) this.bySender.set(senderKey(s), p);
      for (const s of sessionKeys) this.bySession.set(s.toLowerCase(), p);
      const handles = typeof e.handles === "object" && e.handles !== null && !Array.isArray(e.handles) ? (e.handles as Record<string, unknown>) : {};
      if (e.handles !== undefined && handles !== e.handles) this.issues.push(B.personaPeople.issueHandlesNotObject(key));
      for (const plat of ["wx", "xhs", "bili"] as const) {
        for (const h of strs(key, `handles.${plat}`, handles[plat]).filter((x) => x.trim())) this.byHandle.set(`${plat}:${h.trim().toLowerCase()}`, p);
      }
    }
  }

  static load(workspace: string, approved?: Record<string, Record<string, unknown>>): People {
    const p = join(workspace, REGISTRY_FILE);
    const raw = existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>) : {};
    return People.from(raw, approved);
  }

  /** hhd 启动时用：名单 JSON 写坏了不能让 hhd 起不来、反复重启。给空名单，Brain.start() 的保底（按底子认主人）接手 */
  static loadOr(workspace: string, onError: (e: unknown) => void): People {
    try { return People.load(workspace); } catch (e) { onError(e); return new People({}); }
  }

  /** 名单文件内容 → People；给了底子就先过权限上限。aliasKey 见构造 */
  static from(raw: Record<string, unknown>, approved?: Record<string, Record<string, unknown>>, aliasKey?: AliasKey): People {
    if (!approved) return new People(raw, aliasKey);
    const r = applyApproved(raw, approved);
    // 底子读不到（空的）时主人会被裁成访客：按原样的名单和底子认主人，库里的名字照样认不出他
    const people = new People(r.registry, aliasKey, [...ownersOf(raw), ...ownersOf(approved)]);
    people.dropped = r.dropped;
    people.unapproved = r.unapproved;
    return people;
  }

  /**
   * 渠道上的显示名 → 是谁。显示名谁都能改，所以 byDisplayName 的命中只能用来分流，不能当主人；微信备注是主人自己设的，不算。
   * 名单 handles 认不出再问 aliasKey（事件库里那个人的名字、别名，#0042）：问出来的一律 byDisplayName，微信也是（库里的名字不是备注）。
   * 问出来是主人的不算：主人只认名单和批准底子里的（库里的名字不用批，review I1）。主人看的是原样的名单和底子，
   * 不是裁过的（读不动底子时主人被裁成访客，也不能按库里的名字认成访客，final-review N1）。
   * ownersToo：库里的名字一个都不排除（只给控制台遮行用：认出谁都算他，主人也是按显示名没核实的，一对一就遮；
   * 文件里写成主人、底子里是访客的按访客遮，final-review R-2）。闸门和 Brain 不给
   */
  identifyHandle(src: string, name: string, o: { ownersToo?: boolean } = {}): { person: Person; byDisplayName: boolean } | null {
    const plat = src === "bili_dm" ? "bili" : src;
    if (plat !== "wx" && plat !== "xhs" && plat !== "bili") return null;
    const trimmed = name.trim();
    const n = trimmed.toLowerCase();
    if (!n) return null;   // 空名字不查（空备注不能认成人）
    const person = this.byHandle.get(`${plat}:${n}`);
    if (person) return { person, byDisplayName: plat !== "wx" };
    const key = this.aliasKey?.(trimmed);
    const byAlias = key ? this.byKey.get(key) : undefined;
    if (!byAlias) return null;
    return o.ownersToo || (byAlias.privacy !== "owner" && !this.aliasNever.has(byAlias.key)) ? { person: byAlias, byDisplayName: true } : null;
  }

  /** 人名 → 某个渠道上的发送目标（她只知道"发给阿青"，不用记号码）；认不出就 null */
  targetFor(name: string, channel: string): string | null {
    const senders = this.byName.get(name.trim().toLowerCase());
    if (!senders) return null;
    if (channel === "whatsapp") return senders.find((x) => x.startsWith("+")) ?? null;
    if (channel === "qqbot") {
      const openid = senders.find((x) => /^[0-9A-F]{32}$/.test(x)) ?? senders.find((x) => /^[0-9a-f]{32}$/i.test(x));
      return openid ? `qqbot:c2c:${openid}` : null;
    }
    return null;
  }

  identify(senderId: string | undefined, sessionKey: string | undefined): Person | null {
    const s = senderKey(senderId ?? "");
    if (s) {
      const hit = this.bySender.get(s);
      if (hit) return hit;
    }
    return sessionKey ? this.bySession.get(sessionKey.toLowerCase()) ?? null : null;
  }
}

/** 记忆里的简短称呼：主人不加，朋友、陌生人标出来 */
export function relationTag(p: Person | null): string | null {
  if (!p) return B.personaPeople.relationTagStranger;
  return p.privacy === "owner" ? null : B.personaPeople.relationTagFriend;
}

/** 发送目标（qqbot:c2c:xxx / 号码 / App 会话键）→ 是谁；认不出就 null */
export function personOfTarget(people: People, target: string): Person | null {
  const id = target.replace(/^qqbot:(c2c|group):/i, "");
  return people.identify(id, target);
}

/**
 * 比较发送目标用的键：QQ 的私聊、群聊号去掉 qqbot:c2c: / qqbot:group: 前缀、不分大小写（名单里同一个 openid 大小写两种都登记着，
 * 工具发的用名单里的大写，回复用的是渠道送来的，两边对不上「最近说过的」就漏了）；别的只去掉首尾空白
 */
export function targetKey(t: string): string {
  const s = t.trim();
  const m = /^qqbot:(?:c2c|group):/i.exec(s);
  return m ? s.slice(m[0].length).toLowerCase() : s;
}

/** 从渠道消息推出回复目标（网关 send 的 to） */
export function replyTarget(channel: string, senderId: string, opts: { isGroup?: boolean; conversationId?: string }): string {
  if (channel === "qqbot") {
    return opts.isGroup && opts.conversationId ? `qqbot:group:${opts.conversationId}` : `qqbot:c2c:${senderId}`;
  }
  if (opts.isGroup && opts.conversationId) return opts.conversationId;
  return senderId;
}
