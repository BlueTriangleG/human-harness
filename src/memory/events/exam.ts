// 记忆体检：拿一套关于她自己过去的题，用她的人格前缀和只读的记忆工具单开会话一道道答，
// 记下回答、用了哪些工具、花了多少 token 和时间。判分在外面做（题目里带着标准答案和出处）。
import { writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TurnTotal } from "../../kernel/types.ts";
import { B } from "../../lang/index.ts";

export interface ExamQuestion { id: string; q: string; [k: string]: unknown }

export interface ExamAnswer {
  id: string; q: string; answer: string; ok: boolean; ms: number;
  /** 这道题用了哪些工具（按先后） */
  tools: string[];
  total: TurnTotal | null;
}

export function parseExam(raw: unknown): ExamQuestion[] {
  if (!Array.isArray(raw)) throw new Error(B.eventsOwner.examNotArray);
  const out = raw.map((x, i) => {
    const o = x as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id || typeof o.q !== "string" || !o.q.trim()) throw new Error(B.eventsOwner.examNeedsIdAndQ(i + 1));
    return o as ExamQuestion;
  });
  const dup = out.map((x) => x.id).find((id, i, a) => a.indexOf(id) !== i);
  if (dup) throw new Error(B.eventsOwner.examDuplicateId(dup));
  return out;
}

/** 每答完一道就整份重写一次（中途断了也留着已经答的） */
export function saveExam(path: string, meta: Record<string, unknown>, answers: ExamAnswer[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...meta, answered: answers.length, answers }, null, 1));
  renameSync(tmp, path);
}
