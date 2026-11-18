// 对照工具的假小判断：闸门一批问过来（src/gate/judge.ts 的 judgeBatch），每条都回一个合格的结论。
// 挑哪一个只按这一条自己的编号和原文的哈希定，不看整道题：题目的措辞改了（ask 那条记录自然看得出来），每条的结论不动，
// 后面送到哪、送了什么也就不跟着连锁变，差别能落到改的那一处。事件一多，三种结论、main 的三种时候、拿不准的都会出现。
// 场景用 driver.answerAsk(judgeAnswer) 接上；不是闸门那种题（题里认不出编号）回一句固定的话。
import { createHash } from "node:crypto";
import type { AskOpts } from "../kernel/types.ts";

/** 轮着给的结论（judgeBatch 认的样子：verdict 是 main / digest / drop，when 是 now / work / leisure，unsure 是布尔） */
export const JUDGE_CHOICES: ReadonlyArray<{ verdict: "main" | "digest" | "drop"; when: "now" | "work" | "leisure"; unsure: boolean }> = [
  { verdict: "main", when: "now", unsure: false },
  { verdict: "main", when: "work", unsure: false },
  { verdict: "main", when: "leisure", unsure: false },
  { verdict: "digest", when: "now", unsure: false },
  { verdict: "drop", when: "now", unsure: false },
  { verdict: "main", when: "now", unsure: true },
];

/** 不是闸门那种题时的回答 */
export const PLAIN_ANSWER = "（对照）一次性调用的固定回答。";

/** 每一条的开头一行：「[编号] …」（群聊语境那几行缩进了、原文以「- [」开头，都不算） */
const HEAD = /^\[([^\]\s]+)\] /gm;

/** 题里每一条的编号：judgeBatch 每条一段，开头一行是「[编号] …」 */
export function judgeIds(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(HEAD)].map((m) => m[1]!))];
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 这一条的原文（judgeBatch 每段最后放的 ev.line）：段与段之间空一行，在编号那一段里，从「- [来源 id=编号]」那一行起到段尾（正文块也算）；
 * 没有这种开头的（plain、额度提醒，原文就是那句话）取段的最后一行。说明、规则想看的、前面还有几条这些题目的措辞都不算进来
 */
function eventLine(prompt: string, id: string): string {
  const head = new RegExp(`^\\[${escape(id)}\\] `, "m");
  const block = prompt.split("\n\n").find((b) => head.test(b)) ?? "";
  const at = block.search(new RegExp(`^- \\[[^\\]\\s]+ id=${escape(id)}\\]`, "m"));
  return at >= 0 ? block.slice(at) : block.split("\n").at(-1) ?? "";
}

const pick = (id: string, line: string): number => createHash("sha256").update(`${id}\n${line}`).digest().readUInt32BE(0) % JUDGE_CHOICES.length;

/**
 * 假小判断的回答：题里的每个编号一条，{"items":[{id, verdict, when, gist, why, unsure}]}。
 * gist 留空：闸门照它的规矩拿原文顶上（跟真判断写了要点一样往下走）
 */
export function judgeAnswer(o: AskOpts): string {
  const ids = judgeIds(o.prompt);
  if (!ids.length) return PLAIN_ANSWER;
  return JSON.stringify({
    items: ids.map((id) => {
      const c = JUDGE_CHOICES[pick(id, eventLine(o.prompt, id))]!;
      return { id, verdict: c.verdict, when: c.when, gist: "", why: `（对照）按这一条的哈希判成 ${c.verdict}`, unsure: c.unsure };
    }),
  });
}
