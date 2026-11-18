// 记忆文字的钉子（Task 0）：两条没有函数入口的话——它们由大脑取用（记忆体检的角色说明和每道题的问法），
// 所以清单里直接调到它们。文字已经搬进语言包（M.exam），这里在调用时从当前的包里读（不在模块顶层存一份），调用和指纹不动。
import { M } from "../../src/lang/index.ts";
import type { ExamQuestion } from "../../src/memory/events/exam.ts";

export const examRole = (): string => M.exam.role;
export const examQuestion = (q: ExamQuestion): string => M.exam.question(q.q);
