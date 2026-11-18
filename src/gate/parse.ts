// 感官事件解析：senses.py 给了带字段的 JSON 就按它，否则按旧文字拆。
import { createHash } from "node:crypto";
import type { SenseEvent } from "./types.ts";
import { G, fromEveryPack } from "../lang/index.ts";

const HEAD = /^- \[(\S+) id=([^\]\s]+)\] ?(.*)$/;
const BODY_CLOSE = /^\s*┄{6,}\s*$/;
// What a senses script writes in the role's language and the gate reads in any (G.parse): a body's opening line, the
// line after the events that asks for the acknowledgement, the end of a probe's tag that asks for the role itself
const bodyOpen = (raw: string): boolean => fromEveryPack((p) => p.gate.parse.bodyOpen).includes(raw.trim());
const ackLine = (raw: string): boolean => fromEveryPack((p) => p.gate.parse.ackHead).some((h) => raw.startsWith(h));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 拼给主意识看的原文，版式跟 senses.py 一致 */
export function buildLine(src: string, id: string, text: string, d?: string, body?: string): string {
  let line = `- [${src} id=${id}] ${text}${d ? G.parse.eventDetailSuffix(d) : ""}`;
  if (body) line += G.parse.eventBodyBlock(body.split("\n").map((l) => `  ${l}`).join("\n"));
  return line;
}

/** 旧文字：`- [src id=…]` 起一条，后面缩进的正文块并进 body；整段没有事件行就是一条 plain */
function parseLegacy(text: string): SenseEvent[] {
  const out: SenseEvent[] = [];
  let cur: { src: string; id: string; text: string; body: string[] } | null = null;
  let inBody = false;
  const flush = () => {
    if (!cur) return;
    const body = cur.body.join("\n");
    out.push({ src: cur.src, id: cur.id, text: cur.text, line: buildLine(cur.src, cur.id, cur.text, undefined, body || undefined), ...(body ? { body } : {}) });
    cur = null;
  };
  for (const raw of text.split("\n")) {
    const m = HEAD.exec(raw);
    if (m && !inBody) { flush(); cur = { src: m[1]!, id: m[2]!, text: m[3]!, body: [] }; continue; }
    if (!cur) continue;
    if (ackLine(raw)) { flush(); continue; }
    if (inBody) {
      if (BODY_CLOSE.test(raw)) inBody = false;
      else cur.body.push(raw.replace(/^ {2}/, ""));
    } else if (bodyOpen(raw)) inBody = true;
    else if (raw.trim()) cur.text += `\n${raw}`;   // 事件行的续行
  }
  flush();
  if (out.length) return out;
  const t = text.trim();
  if (!t) return [];
  const id = createHash("sha1").update(text).digest("hex").slice(0, 16);
  return [{ src: "plain", id, text, line: text }];
}

const str = (v: unknown): v is string => typeof v === "string";

function fromJson(o: unknown): SenseEvent[] {
  if (!o || typeof o !== "object") return [];
  const r = o as Record<string, unknown>;
  if (!str(r.src) || !str(r.id) || !str(r.text)) return str(r.text) ? parseLegacy(r.text) : [];
  const d = str(r.do) && r.do ? r.do : undefined;
  const body = str(r.body) && r.body ? r.body : undefined;
  // 字段类型不对就丢掉那一个字段，其余照用
  const ev: SenseEvent = { src: r.src, id: r.id, text: r.text, line: buildLine(r.src, r.id, r.text, d, body) };
  if (body) ev.body = body;
  if (d) ev.do = d;
  if (str(r.conv)) ev.conv = r.conv;
  if (str(r.sender)) ev.sender = r.sender;
  if (typeof r.isGroup === "boolean") ev.isGroup = r.isGroup;
  if (typeof r.mentionsMe === "boolean") ev.mentionsMe = r.mentionsMe;
  if (typeof r.unread === "number" && Number.isFinite(r.unread)) ev.unread = r.unread;
  if (typeof r.alarm === "boolean") ev.alarm = r.alarm;
  if (r.system === true) ev.system = true;   // 只认布尔 true（写成字符串、数字的不算）
  return [ev];
}

/** B站私信来自命令源、没有字段：从「B站 xx 私信你：」里补出会话名/发话人，且一定是私聊 */
function withBiliDm(ev: SenseEvent): SenseEvent {
  if (ev.src !== "bili_dm" || ev.conv) return ev;
  const m = /^B站 (.+?) 私信你：/.exec(ev.text);
  return m ? { ...ev, conv: m[1]!, sender: m[1]!, isGroup: false } : ev;
}

/**
 * 小红书私信的通知标题是「某某 私信你」：senses.py 早先把整个标题当会话名/发话人，闸门认不出人（主人的私信也进了判断）。
 * 去掉结尾的「私信你」；没有会话名的从「某某 私信你：」里补出来（11-03 final review C1）
 */
const XHS_DM_TAIL = / ?私信你$/;
function withXhsDm(ev: SenseEvent): SenseEvent {
  if (ev.src !== "xhs") return ev;
  const strip = (v: string | undefined): string | undefined => {
    if (v === undefined) return v;
    const s = v.replace(XHS_DM_TAIL, "").trim();
    return s ? s : v;   // 只有「私信你」三个字就别剥成空名字
  };
  if (ev.conv !== undefined) {
    const conv = strip(ev.conv);
    const sender = strip(ev.sender);
    return conv === ev.conv && sender === ev.sender ? ev : { ...ev, conv, ...(sender !== undefined ? { sender } : {}) };
  }
  const m = /^(.+?) ?私信你：/.exec(ev.text);
  return m && m[1]!.trim() ? { ...ev, conv: m[1]!.trim(), sender: ev.sender === undefined ? m[1]!.trim() : strip(ev.sender)!, isGroup: false } : ev;
}

const normalize = (ev: SenseEvent): SenseEvent => withXhsDm(withBiliDm(ev));

export function parseSenses(text: string, events?: unknown): SenseEvent[] {
  if (Array.isArray(events) && events.length) {
    const out = events.flatMap(fromJson);
    if (out.length) return out.map(normalize);
  }
  return parseLegacy(text).map(normalize);
}

/** 群里有人 @她：微信、QQ、小红书的那条通知里有「@她的名字」或「[有人@我]」（B站「回复 @某某」是评论回复，不算） */
export function mentionsMe(text: string, n: { me: string; notMe: string[] }): boolean {
  const me = n.me.trim();
  const at = `@${me}`;
  const notMe = n.notMe.map((x) => x.trim()).filter((x) => x !== "");   // 空白项会让 startsWith 恒真，全拦
  // 「@名字」出现的位置上，从名字起的文字不是以 notMe 里任何一个开头才算（比如她叫阿青时，「@阿青在补番」是别人的名字）
  const atMe = (l: string): boolean => {
    if (me === "") return false;   // 没有名字就没有「@名字」可认（不然 at 只是一个「@」，任何 @ 都算）；下面的「[有人@我]」标记与名字无关，照认
    for (let i = l.indexOf(at); i >= 0; i = l.indexOf(at, i + 1)) {
      const rest = l.slice(i + 1);
      if (!notMe.some((x) => rest.startsWith(x))) return true;
    }
    return false;
  };
  // 「[有人@我]」只认通知自己加的那个位置（会话名：[N条]后面），群里有人打出这几个字不算（review 5f8dd13）
  return text.split("\n").some((l) => /^- \[(?:wx|qq|xhs)[\w-]* id=/.test(l) && (atMe(l) || /^- \[[\w-]+ id=[0-9a-f]+\] [^：\n]*：(?:\[\d+条\])?\[有人@我\]/.test(l)));
}

/**
 * 感官层标了要她本人处理的条目：「- [探针 id=…] [某某·要你处理] …」（标签以「·要你处理」结尾）。
 * 能标的只有 probes（通道表里的探针，sources.ts）：聊天来源 id 后面跟的是会话名，群名谁都能改成「[…·要你处理]」（review 5f8dd13）
 */
export function asksForMe(text: string, probes: ReadonlySet<string>): boolean {
  const tag = new RegExp(`^- \\[([\\w-]+) id=[0-9a-f]{6,}\\] \\[[^\\]]*(?:${fromEveryPack((p) => escapeRe(p.gate.parse.asksTail)).join("|")})\\]`);
  return text.split("\n").some((l) => {
    const m = tag.exec(l);
    return !!m && probes.has(m[1]!);
  });
}

/** 感官消息里的事件 id：[bili id=…]、[cc id=…] 这类 */
export function senseIds(text: string): string[] {
  return [...text.matchAll(/\[[\w-]+ id=([0-9a-f]{6,})\]/g)].map((m) => m[1]!);
}

/** 帮手回报里的帮手名字：Claude Code「x」 */
export function helperOf(text: string): string | null {
  return /Claude Code「([^」]+)」/.exec(text)?.[1] ?? null;
}
