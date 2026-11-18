// 暗题（spec §8.5）：另开一个出题人会话，照这一段整理的人见过的材料和整理前的样子再出几道题。
// 整理的人没见过这些题；它们只记分，stage.exam.hiddenGates 打开时才拦这一段。
import type { Bank, QuestionIn } from "./bank.ts";
import { setQuestions, type ExamHost } from "./exam.ts";
import type { StageSpec } from "./flow.ts";
import { P } from "../lang/index.ts";

/**
 * 出 n 道暗题存成待定题，返回题号；两次都没交（或出错）返回 null，不往外抛。
 * check：跟段交的题一样查（exam.ts 的 questionProblem，出处照整理前看）；不合格的不收
 */
export async function setHidden(host: ExamHost, bank: Bank, o: {
  id: string; day: string; stage: StageSpec; material: string; before: string; n: number; model: string; opening: string;
  check?: (q: QuestionIn) => string | null;
}): Promise<string[] | null> {
  try {
    const qs = await setQuestions(host, { id: o.id, model: o.model, opening: o.opening, wake: P.EXAM_HIDDEN_SETTER(o.material, o.before, o.n), ...(o.check ? { check: o.check } : {}) });
    if (!qs) return null;
    // 今天的新要点不能直接放进只在仓库（跟段交的题一样）
    return bank.addPending(o.day, o.stage.id, qs.filter((q) => !(q.isNew && q.layer === "archive")).slice(0, o.n), { hidden: true });
  } catch {
    return null;
  }
}
