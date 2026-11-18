// 潜意识门：小判断用的人格卡 + 「现在在做」。
import { join } from "node:path";
import { P } from "../lang/index.ts";
import type { TaskRow } from "../basal/tasks.ts";
import { G } from "../lang/index.ts";

/** 说明 + 性格文件 + 中期记忆；同样的内容出同样的字节（为了缓存命中）。读不到的跳过。 */
export function buildCard(o: { workspace: string; stateDir: string; files: string[]; midterm: string; midtermMaxChars?: number; names: { me: string; owner: string }; readFile: (p: string) => string | null }): string {
  const parts = [P.judgeSystem(o.names)];
  for (const f of o.files) {
    const t = o.readFile(join(o.workspace, f));
    if (t) parts.push(t);
  }
  let mid = o.readFile(join(o.stateDir, o.midterm));
  // 中期记忆太长就只留开头，别把小判断的成本撑大
  if (mid && o.midtermMaxChars && o.midtermMaxChars > 0) mid = mid.slice(0, o.midtermMaxChars);
  if (mid) parts.push(mid);
  return parts.join("\n\n");
}

export function nowDoing(doing: TaskRow[], goals: string): string {
  if (doing.length === 0 && !goals) return "";
  return [G.card.nowDoing, ...doing.map((t) => t.topic), ...(goals ? [goals] : [])].join("\n");
}
