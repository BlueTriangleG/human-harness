// 对照工具的「存着的输入」：只读——从快照的库里取回最近进来过的东西，说清每一条当年走的是哪个入口（怎么喂、怎么回在 drive.ts 和各场景里）。
// 中央记忆里 kind=input 的外来消息（人发来的、她排的提醒、hh tell 的）→ brain.fromChannel（能照 relay 的样子拼回一条渠道消息时）或 brain.inbound；
// 闸门账（gate_log）里的感官事件 → brain.fromSenses（和控制面 {cmd:"sense"} 一样的样子），额度提醒照 HH 自己送的样子走 brain.inbound。
// 挑的时候最近的优先，但库里出现过的每一种（人, 渠道）、每一个来源都至少留一条（挤掉挑中的里最老的、那一种不止一条的）。
// 渠道消息能从存着的回复地址拆出发送者的，就让这棵树自己认人、起陌生人的称呼、写关系那句（这些正是以后要从代码里搬走的字）。
// 中央记忆里 kind=act 的工具调用（Brain 记的「<工具> <参数 JSON>」）→ 照原样的参数再调一遍那个工具（tools 场景）；
// 每个（脑区, 工具）挑最后几次不同的，参数的样子不一样的优先（顶层写了哪些、第一个能枚举的参数是什么值），其次最近的。
import { z } from "zod";
import type { InboundMessage } from "../channels/types.ts";
import type { SenseEvent } from "../gate/types.ts";
import type { ToolDef } from "../kernel/types.ts";
import type { People } from "../persona/people.ts";
import { all } from "../store/db.ts";
import type { Db } from "../store/db.ts";
import type { Inbound } from "../thalamus/router.ts";
import { TELL_CHANNEL } from "../control.ts";
import { canonical } from "./recorder.ts";

type ReplyTo = NonNullable<Inbound["replyTo"]>;

/** 中央记忆里存着的一条外来消息（deliverInbound 记的：原文、谁、渠道、是不是真人、回给谁、简短称呼） */
export interface StoredMessage { seq: number; ts: number; text: string; from: string; channel: string; human: boolean; replyTo: ReplyTo | null; tag: string | null }

/** 闸门账上的一条感官事件（ev 是落库时的样子，line 是她看的原文） */
export interface StoredSense { id: number; ts: number; src: string; line: string; ev: Record<string, unknown> }

/** 喂给哪个入口、喂什么 */
export type Entry =
  | { name: "fromChannel"; args: InboundMessage }
  | { name: "inbound"; args: Inbound }
  | { name: "fromSenses"; args: { text: string; events?: unknown[] } };

/**
 * 最近的 n 条（newestFirst 是新的在前），但 key 出现过的每一种都至少留一条：没挑上的那一种拿它最近的一条，
 * 换掉挑中的里最老的、它那一种不止一条的那条；没得换了（种类比 n 多）就停。返回挑中的这一组（顺序不保证，调用的自己排）
 */
export function pickRecent<T>(newestFirst: readonly T[], n: number, key: (x: T) => string): T[] {
  const picks = newestFirst.slice(0, Math.max(0, n));
  const count = new Map<string, number>();
  for (const x of picks) count.set(key(x), (count.get(key(x)) ?? 0) + 1);
  for (const x of newestFirst.slice(picks.length)) {
    const k = key(x);
    if (count.has(k)) continue;
    let j = picks.length - 1;
    while (j >= 0 && count.get(key(picks[j]!))! < 2) j--;
    if (j < 0) break;
    const old = key(picks[j]!);
    count.set(old, count.get(old)! - 1);
    picks.splice(j, 1);
    picks.push(x);
    count.set(k, 1);
  }
  return picks;
}

const str = (v: unknown): v is string => typeof v === "string";

/**
 * 快照配置里的 parity.allowEmpty（读法照 day 场景的 parity.dayHours：场景子进程只拿到快照和配置）：
 * 明说了「这份快照就是没有存着的输入」才是 true；不写就是 false
 */
export function allowEmpty(cfg: unknown): boolean {
  const raw = (cfg as { parity?: { allowEmpty?: unknown } } | null)?.parity?.allowEmpty;
  if (raw === undefined) return false;
  if (typeof raw !== "boolean") throw new Error(`parity: config parity.allowEmpty must be true or false (got ${JSON.stringify(raw)})`);
  return raw;
}

/**
 * 一条存着的输入都没找到就不往下跑：两棵树都什么也不回放，比出来的「一样」是假的。场景算挂（抛错），
 * 除非快照的配置明说了可以是空的（parity.allowEmpty: true）
 */
export function requireStored(cfg: unknown, scenario: string, what: string, count: number): void {
  if (count > 0 || allowEmpty(cfg)) return;
  throw new Error(`parity: ${scenario}: the snapshot has no ${what} to replay — two empty replays would compare identical (set parity.allowEmpty: true in the snapshot's config if an empty snapshot is intended)`);
}

const parseMeta = (raw: unknown): Record<string, unknown> | null => {
  if (!str(raw)) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
};

/** 存着的 replyTo：要有渠道和目标（字符串），别的字段类型对才留 */
function replyToOf(v: unknown): ReplyTo | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (!str(r.channel) || !str(r.target)) return null;
  return {
    channel: r.channel, target: r.target,
    ...(str(r.messageId) ? { messageId: r.messageId } : {}), ...(str(r.name) ? { name: r.name } : {}), ...(r.group === true ? { group: true } : {}),
  };
}

/**
 * 中央记忆里最近的 n 条外来消息，老的在前。感官的（渠道 senses）、导入的历史（meta.imported）、没有渠道的不算。
 * （外来消息记在「外界」名下，没有哪个脑区的；脑区已经不在的那种行这里遇不到）
 */
export function storedMessages(db: Db, n: number): StoredMessage[] {
  const rows = all<{ seq: number; ts: number; text: string; meta: string | null }>(db, "SELECT seq, ts, text, meta FROM central WHERE kind = 'input' ORDER BY seq DESC");
  const out: StoredMessage[] = [];
  for (const r of rows) {
    const m = parseMeta(r.meta);
    if (!m || m.imported || !str(m.from) || !str(m.channel) || m.channel === "senses") continue;
    out.push({
      seq: Number(r.seq), ts: Number(r.ts), text: r.text, from: m.from, channel: m.channel, human: m.human === true,
      replyTo: replyToOf(m.replyTo), tag: str(m.tag) ? m.tag : null,
    });
  }
  return pickRecent(out, n, (x) => JSON.stringify([x.from, x.channel])).sort((a, b) => a.seq - b.seq);
}

/** 库里的 ev 坏了：照闸门自己的办法（gate.ts evOf）从列里拼一个 */
function senseOf(r: { ev_id: string; src: string; conv: string | null; sender: string | null; line: string; ev: string }): Record<string, unknown> {
  const e = parseMeta(r.ev);
  if (e) return e;
  return { src: r.src, id: r.ev_id, text: r.line, line: r.line, ...(r.conv ? { conv: r.conv } : {}), ...(r.sender ? { sender: r.sender } : {}) };
}

/** 闸门账上最近的 n 条感官事件，老的在前 */
export function storedSenses(db: Db, n: number): StoredSense[] {
  const rows = all<{ id: number; ts: number; ev_id: string; src: string; conv: string | null; sender: string | null; line: string; ev: string }>(
    db, "SELECT id, ts, ev_id, src, conv, sender, line, ev FROM gate_log ORDER BY id DESC");
  const out = rows.map((r) => ({ id: Number(r.id), ts: Number(r.ts), src: r.src, line: r.line, ev: senseOf(r) }));
  return pickRecent(out, n, (x) => x.src).sort((a, b) => a.id - b.id);
}

/** 闸门账上最后一条（编号最大的）的时间；账是空的给 null */
export function lastGateTs(db: Db): number | null {
  const r = all<{ ts: number }>(db, "SELECT ts FROM gate_log ORDER BY id DESC LIMIT 1")[0];
  return r ? Number(r.ts) : null;
}

/**
 * 引用的那段。fromChannel 拼的是「（引用：「」+ 引用的前 200 字 +「」）」+ 原话：开头是这个样子、引用不超过 200 字的，拆成 replyToBody 和原话，
 * fromChannel 拼回来的就跟存着的一字不差（引用里自己带「」）」的，拆在第一个上，拼回来还是同一串，只是 replyToBody 短了）。
 * 超过 200 字的不拆（截过的拼不回原样），整段当原话，拼回来也一样
 */
const QUOTE = /^（引用：「([\s\S]*?)」）/;
function splitQuote(text: string): { body: string; rest: string } | null {
  const m = QUOTE.exec(text);
  if (!m || m[1]!.length > 200) return null;
  return { body: m[1]!, rest: text.slice(m[0].length) };
}

/** 名单上有这个名字（key 或 name，不分大小写，跟 People 按名字找人一样）：存着的 from 是名单上的人，不是陌生人的称呼 */
function knownName(people: People, name: string): boolean {
  const n = name.trim().toLowerCase();
  return Object.entries(people.registry).some(([key, e]) => {
    if (key.startsWith("_") || !e || typeof e !== "object" || Array.isArray(e)) return false;
    const own = (e as { name?: unknown }).name;
    return key.toLowerCase() === n || (str(own) && own !== "" && own.toLowerCase() === n);
  });
}

/**
 * 存着的回复地址里拆出来的：私聊的回复目标就是发送者（whatsapp 原样、qqbot 是 qqbot:c2c:<号>），群的是会话号。
 * 群里没带会话号的消息，目标也是发送者（replyTarget 退回发送者）：whatsapp 的发送者号码以 + 开头（名单的 targetFor 也这么认），qqbot 是 c2c 那种
 */
function addressOf(m: StoredMessage): { senderId?: string; conversationId?: string } | null {
  const r = m.replyTo;
  if (!r || r.channel !== m.channel || !r.target) return null;
  if (m.channel === "qqbot") {
    const group = /^qqbot:group:(.+)$/.exec(r.target);
    if (group) return { conversationId: group[1]! };
    const c2c = /^qqbot:c2c:(.+)$/.exec(r.target);
    return c2c ? { senderId: c2c[1]! } : null;
  }
  if (m.channel === "whatsapp") return r.group === true && !r.target.startsWith("+") ? { conversationId: r.target } : { senderId: r.target };
  return null;
}

/** 名单上这个人在这个渠道上的号（whatsapp、qqbot 是发送者号码）；名单给不出就 null */
function senderFor(people: People, name: string, channel: string): { senderId: string } | null {
  if (channel === "whatsapp") {
    const t = people.targetFor(name, "whatsapp");
    return t ? { senderId: t } : null;
  }
  if (channel === "qqbot") {
    const t = people.targetFor(name, "qqbot");
    return t ? { senderId: t.replace(/^qqbot:c2c:/, "") } : null;
  }
  return null;
}

/** 照 relay（relay/logic.mjs toRelayMessage）拼的渠道消息：消息编号来自存着的 replyTo，引用拆回 replyToBody；isGroup 跟 relay 一样总给布尔 */
function relayEntry(m: StoredMessage, id: { senderId: string }, conversationId: string | undefined): Entry {
  const quote = splitQuote(m.text);
  return {
    name: "fromChannel",
    args: {
      channel: m.channel, text: quote ? quote.rest : m.text, ...id,
      ...(m.replyTo?.messageId ? { messageId: m.replyTo.messageId } : {}),
      isGroup: m.replyTo?.group === true, ...(conversationId ? { conversationId } : {}), ...(quote ? { replyToBody: quote.body } : {}),
    },
  };
}

/**
 * 一条存着的消息怎么再喂（认人、陌生人的称呼、关系那句、简短称呼、人物卡都让这棵树自己从渠道消息算）：
 * 1. 存着的回复地址里有发送者号码（私聊，或群里没带会话号的）：存着的 from 不是名单上的名字（陌生人、后来从名单上拿掉的）一律用它走 fromChannel；
 *    是名单上的名字，那个号认出来也还是这个人才用它
 * 2. 不然（群里只存着会话号；名单上的人、存着的号却认不出是他）：名单按名字给这个渠道上的号，认出来还是这个人，就用它走 fromChannel（群的会话号照存着的）
 * 3. 都不行（没有回复地址的：她排的提醒、hh tell 的；群里的陌生人）→ 存着什么喂什么走 inbound（跟提醒、tell 自己调的样子一样，群的那个标也带上）
 */
export function messageEntry(m: StoredMessage, people: People): Entry {
  // Stored before the App chat went: "app" labelled both a tell and a message from the App's chat; both replay as a tell enters now
  if (m.channel === "app") return { name: "inbound", args: { from: m.from, channel: TELL_CHANNEL, text: m.text, human: m.human } };
  const same = (id: { senderId: string }): boolean => people.identify(id.senderId, undefined)?.name === m.from;
  const a = addressOf(m);
  if (a?.senderId) {
    const id = { senderId: a.senderId };
    if (!knownName(people, m.from) || same(id)) return relayEntry(m, id, undefined);
  }
  const byName = m.replyTo ? senderFor(people, m.from, m.channel) : null;
  if (byName && same(byName)) return relayEntry(m, byName, a?.conversationId);
  return {
    name: "inbound",
    args: {
      from: m.from, channel: m.channel, text: m.text, human: m.human, ...(m.replyTo ? { replyTo: m.replyTo } : {}), ...(m.tag ? { tag: m.tag } : {}),
      ...(m.replyTo?.group ? { group: true } : {}),
    },
  };
}

/** 回给这个人的 message 工具参数：走 fromChannel、from 是名单上的名字的写名字（让名单去认），别的写存着的目标 */
export function messageBack(m: StoredMessage, e: Entry, text: string, people: People): Record<string, unknown> {
  const byName = e.name === "fromChannel" && knownName(people, m.from);
  return { action: "send", channel: m.replyTo?.channel ?? m.channel, target: byName ? m.from : m.replyTo?.target ?? m.from, message: text };
}

/**
 * 一条感官事件怎么再喂：额度提醒（hh-quota）是 HH 自己送的（Brain.observeQuota：inbound，events 带着原样的事件，见底的带 urgent）；
 * 没有字段的（plain）当年是 senses.py 送来的一段文字，照文字送（解析出来的编号、原文跟当年一样）；
 * 别的是 senses.py 带字段送的：events 给事件的字段（去掉 HH 自己拼的 line），文字照 HH 拼帮手回报的那个样子（闸门开着时不看文字）
 */
export function senseEntry(s: StoredSense): Entry {
  const ev = s.ev;
  const text = str(ev.text) ? ev.text : s.line;
  if (ev.src === "hh-quota") return { name: "inbound", args: { from: "感官", channel: "senses", text, human: false, events: [ev as unknown as SenseEvent] } };
  if (ev.src === "plain") return { name: "fromSenses", args: { text } };
  const { line: _line, urgent: _urgent, ...fields } = ev;
  return { name: "fromSenses", args: { text: `[感官] 有新动静：\n${str(ev.line) ? ev.line : s.line}`, events: [fields] } };
}

/** 中央记忆里存着的一次工具调用（Brain 记的 act 行）：哪个脑区调的、哪个工具、当时给的参数 */
export interface StoredCall { seq: number; region: string; tool: string; args: Record<string, unknown> }

/**
 * act 行的文字拆回工具名和参数。Brain 记的是「<工具> <参数 JSON>」（brain.ts onRegionEvent；工具名是内核报上来的、
 * 去掉了 mcp__self__ 的那个，工具名里没有空格）。拆不开、JSON 坏了、参数不是对象（内核给工具的参数总是对象）的给 null
 */
export function parseAct(text: string): { tool: string; args: Record<string, unknown> } | null {
  const i = text.indexOf(" ");
  if (i <= 0) return null;
  const args = parseMeta(text.slice(i + 1));
  return args ? { tool: text.slice(0, i), args } : null;
}

/** storedCalls 在 SQL 里先筛的范围：只读这些脑区的、文字以这些工具名开头的 act 行 */
export interface CallScope { regions: readonly string[]; tools: readonly string[] }

/**
 * 中央记忆里存着的工具调用，新的在前。wanted 说要哪些（脑区, 工具）：脑区已经不在的、不是这个脑区工具表里的
 * （Bash、mcp__bili__* 这些内核自带的）调用方不要。同一个脑区、同一个工具、参数一样（键的先后不算）的只留最新那次；
 * 文字拆不开的行跳过。给了 scope 就在库里先筛一遍（真库里 act 行几万条，大多是 Bash，要的只有几千条），wanted 照样再看
 */
export function storedCalls(db: Db, wanted: (region: string, tool: string) => boolean, scope?: CallScope): StoredCall[] {
  const marks = (xs: readonly string[]): string => xs.map(() => "?").join(",");
  const rows = scope
    ? all<{ seq: number; src: string; text: string }>(db,
      `SELECT seq, src, text FROM central WHERE kind = 'act' AND src IN (${marks(scope.regions)}) AND substr(text, 1, instr(text, ' ') - 1) IN (${marks(scope.tools)}) ORDER BY seq DESC`,
      ...scope.regions, ...scope.tools)
    : all<{ seq: number; src: string; text: string }>(db, "SELECT seq, src, text FROM central WHERE kind = 'act' ORDER BY seq DESC");
  const seen = new Set<string>();
  const out: StoredCall[] = [];
  for (const r of rows) {
    // 先只看工具名：不要的（大多是 Bash）不解析参数
    const i = r.text.indexOf(" ");
    if (i <= 0 || !wanted(r.src, r.text.slice(0, i))) continue;
    const a = parseAct(r.text);
    if (!a) continue;
    const key = canonical([r.src, a.tool, a.args]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ seq: Number(r.seq), region: r.src, tool: a.tool, args: a.args });
  }
  return out;
}

/** 每个工具的参数表照 zod 渲成 JSON Schema 后的各个参数（工具定义不变，算一次） */
const propsCache = new WeakMap<object, Array<[string, Record<string, unknown>]>>();
function propsOf(def: Pick<ToolDef, "shape">): Array<[string, Record<string, unknown>]> {
  let p = propsCache.get(def.shape);
  if (!p) {
    const js = z.toJSONSchema(z.object(def.shape)) as { properties?: Record<string, Record<string, unknown>> };
    p = Object.entries(js.properties ?? {});
    propsCache.set(def.shape, p);
  }
  return p;
}

/**
 * 挑存着的调用时按什么分「种」：顶层写了哪些参数，加上第一个能枚举的参数（参数表里第一个有两个以上可选值的，action、state、kind、how 这种）的值；
 * 只有一个参数、是一串字符串的工具（goals、recall 这种照命令行给参数的）第一个字符串就是子命令，算它
 */
export function callKind(def: Pick<ToolDef, "shape">, args: Record<string, unknown>): string {
  const props = propsOf(def);
  const choice = props.find(([, s]) => Array.isArray(s.enum) && s.enum.length > 1);
  const only = props.length === 1 ? props[0]! : null;
  const words = only && only[1].type === "array" && (only[1].items as { type?: unknown } | undefined)?.type === "string" ? args[only[0]] : undefined;
  const sub = choice ? args[choice[0]] : Array.isArray(words) ? words[0] : undefined;
  return canonical([Object.keys(args).sort(), sub ?? null]);
}

/**
 * 一个（脑区, 工具）存着的调用（新的在前，已去重）里挑 n 次：最近的 n 次，但出现过的每一种（kind 分的）都至少留一次
 * （pickRecent：没挑上的那一种拿它最近的一次，换掉挑中的里最老的、那一种不止一次的）。老的在前
 */
export function pickCalls(newestFirst: readonly StoredCall[], n: number, kind: (c: StoredCall) => string): StoredCall[] {
  return pickRecent(newestFirst, n, kind).sort((a, b) => a.seq - b.seq);
}
