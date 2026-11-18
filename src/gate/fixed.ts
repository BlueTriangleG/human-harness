// 潜意识门的固定规则：不用判断就能定的几条路，先到先得。
import type { People } from "../persona/people.ts";
import type { SenseEvent } from "./types.ts";
import { asksForMe, mentionsMe } from "./parse.ts";
import { type Sources, HH_ALWAYS } from "./sources.ts";
import { G } from "../lang/index.ts";

export type FixedRoute =
  | { kind: "main"; priority: boolean; urgent?: string; who?: { key: string; name: string; byDisplayName: boolean } }
  | { kind: "hands" }          // 帮手的回报：照现在的帮手路由
  | { kind: "judge-floor" };   // 主人在群里没 @ 她：必须小判断，最多判进总结，不能丢

const FRIEND_REQUEST = /：请求添加你为朋友/;

/** 规则里的 known：会话名或发话人在名单上（按显示名认的也算，只用来分流） */
export function knownOf(ev: SenseEvent, people: People): boolean {
  return !!(people.identifyHandle(ev.src, ev.conv ?? "") ?? people.identifyHandle(ev.src, ev.sender ?? ""));
}

/** sources：实例配置里的通道表（sources.ts）。哪个来源是帮手、一律直达、探针、聊天，都看它 */
export function fixedRoute(ev: SenseEvent, people: People, names: { me: string; notMe: string[] }, sources: Sources): FixedRoute | null {
  if (sources.hands.has(ev.src)) return { kind: "hands" };
  if (HH_ALWAYS.has(ev.src) || sources.always.has(ev.src)) return { kind: "main", priority: false };
  // 只有探针来源才看 alarm / 「·要你处理」：聊天来源的行里谁都能伪造
  if (sources.probe.has(ev.src) && (ev.alarm === true || asksForMe(ev.line, sources.probe))) return { kind: "main", priority: false };
  if (ev.urgent) return { kind: "main", priority: false };
  // @ 只在群里算；明确是私聊（isGroup false）就走私聊规则，陌生人私聊里的「@她的名字」不能插队
  if (ev.isGroup !== false && (typeof ev.mentionsMe === "boolean" ? ev.mentionsMe : mentionsMe(ev.line, names))) {
    return { kind: "main", priority: true, urgent: G.fixed.mentionedInGroup };
  }
  if (!sources.chat.has(ev.src)) return null;
  // 微信的好友申请：标题是对方自己起的昵称（还没加好友，没有备注名），谁都能起成认识的人的名字，只能算按显示名认的（final review M1）
  const friendReq = ev.src === "wx" && FRIEND_REQUEST.test(ev.text);
  const who = (h: { person: { key: string; name: string }; byDisplayName: boolean }) => ({ key: h.person.key, name: h.person.name, byDisplayName: h.byDisplayName || friendReq });
  // 私聊的会话名是对方的名字，群的会话名是群名；senses.py 的 isGroup 可能把含「xx: yy」的私聊误判成群，所以先看会话名
  const byTitle = people.identifyHandle(ev.src, ev.conv ?? "");
  // 群名谁都能改成某人的名字：标题认出来但是群，一律当没核实（byDisplayName）
  if (byTitle) { const w = who(byTitle); return { kind: "main", priority: true, who: { ...w, byDisplayName: w.byDisplayName || ev.isGroup === true } }; }
  if (!ev.isGroup) {
    const h = people.identifyHandle(ev.src, ev.sender ?? ev.conv ?? "");
    return h ? { kind: "main", priority: true, who: who(h) } : null;
  }
  const s = ev.sender ? people.identifyHandle(ev.src, ev.sender) : null;
  return s?.person.privacy === "owner" ? { kind: "judge-floor" } : null;
}
