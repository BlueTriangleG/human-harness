// 潜意识门：小判断——一批动静一次问完。
import type { AskOpts, AskResult } from "../kernel/types.ts";
import type { RuleHit } from "./rules.ts";
import type { SenseEvent, When } from "./types.ts";
import { G } from "../lang/index.ts";

export interface JudgeItem { ev: SenseEvent; hit: RuleHit; floor: boolean }
export interface Verdict { verdict: "main" | "digest" | "drop"; when: When; gist: string; why: string; unsure: boolean }

const VERDICTS = ["main", "digest", "drop"];
const WHENS = ["now", "work", "leisure"];

function block(it: JudgeItem, context: (conv: string, src: string) => string[]): string {
  const { ev, hit } = it;
  const lines: string[] = [];
  const ctx = ev.conv ? context(ev.conv, ev.src) : [];   // 同名的会话在别的平台上不算
  if (ctx.length) lines.push(G.judge.contextHeading, ...ctx.map((l) => `  ${l}`));
  const who = ev.sender && ev.sender !== ev.conv ? G.judge.itemSenderSuffix(ev.sender) : "";
  lines.push(G.judge.itemHeader(ev.id, ev.conv ?? ev.src, who));
  lines.push(G.judge.itemWant(hit.want));
  if (ev.unread && ev.unread > 1) lines.push(G.judge.itemUnreadMore(ev.unread - 1));
  lines.push(ev.line);
  return lines.join("\n");
}

// 模型可能在 JSON 前后说废话：从每个 { 到最后一个 } 试，取第一个带 items 数组的
function findItems(text: string): unknown[] | null {
  const end = text.lastIndexOf("}");
  for (let i = text.indexOf("{"); i >= 0 && i < end; i = text.indexOf("{", i + 1)) {
    try {
      const o = JSON.parse(text.slice(i, end + 1)) as { items?: unknown };
      if (o && Array.isArray(o.items)) return o.items;
    } catch { /* 换下一个 { */ }
  }
  return null;
}

export async function judgeBatch(o: {
  ask: (a: AskOpts) => Promise<AskResult>; card: string; nowDoing: string; items: JudgeItem[];
  context: (conv: string, src: string) => string[]; base: Omit<AskOpts, "system" | "prompt">;
}): Promise<{ verdicts: Map<string, Verdict>; usage: AskResult["usage"] }> {
  const prompt = [...(o.nowDoing ? [o.nowDoing] : []), ...o.items.map((it) => block(it, o.context))].join("\n\n");
  const r = await o.ask({ ...o.base, system: o.card, prompt }); // 抛错就整批抛出，调用方退回
  const byId = new Map(o.items.map((it) => [it.ev.id, it]));
  const verdicts = new Map<string, Verdict>();
  for (const raw of findItems(r.text) ?? []) {
    if (typeof raw !== "object" || raw === null) continue;
    const x = raw as Record<string, unknown>;
    const it = typeof x.id === "string" ? byId.get(x.id) : undefined;
    if (!it || verdicts.has(it.ev.id)) continue; // 不认识的忽略，重复的先到先得
    if (typeof x.verdict !== "string" || !VERDICTS.includes(x.verdict)) continue;
    if (x.when !== undefined && (typeof x.when !== "string" || !WHENS.includes(x.when))) continue;
    if (typeof x.gist !== "string" || typeof x.why !== "string") continue;
    if (x.unsure !== undefined && typeof x.unsure !== "boolean") continue;
    let verdict = x.verdict as Verdict["verdict"];
    if (it.floor && verdict === "drop") verdict = "digest"; // 底线条目不许丢
    verdicts.set(it.ev.id, { verdict, when: (x.when as When | undefined) ?? it.hit.when, gist: x.gist || it.ev.text, why: x.why, unsure: x.unsure === true });
  }
  return { verdicts, usage: r.usage };
}
