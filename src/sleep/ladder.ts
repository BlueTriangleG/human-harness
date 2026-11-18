// 省钱阶梯（spec §10.1）：花费过了目标线以后，考试一级级省。saveLevel 算现在到第几级，ladderPlan 说这一级怎么省，
// examCacheCheck 看考试会话有没有吃到缓存。
import type { Budget } from "./budget.ts";
import type { FlowConfig } from "./flow.ts";
import type { StageUsage } from "./session.ts";
import { S } from "../lang/index.ts";

export interface LadderPlan {
  /** 第几级，0 = 不省 */
  level: number;
  /** 出不出暗题 */
  hidden: boolean;
  /** 旧题、抽题的上限乘这个数（向下取整，至少 1） */
  oldScale: number;
  /** 判分、核依据用便宜的模型 */
  cheap: boolean;
  /** 全天考试只考旧题 */
  finalOldOnly: boolean;
}

export const NO_SAVING: LadderPlan = { level: 0, hidden: true, oldScale: 1, cheap: false, finalOldOnly: false };

/** 现在到第几级：低于目标线 0；第 k 级（1..4）在 pct ≥ 目标线 + (k − 1) × (绝对线 − 目标线) / 4 时生效 */
export function saveLevel(b: Budget): 0 | 1 | 2 | 3 | 4 {
  if (b.pct < b.targetPct) return 0;
  const step = (b.hardPct - b.targetPct) / 4;
  let k = 1;
  while (k < 4 && b.pct >= b.targetPct + k * step) k += 1;
  return k as 1 | 2 | 3 | 4;
}

/** 按配置里的顺序，前 level 个词生效 */
export function ladderPlan(flow: FlowConfig, level: number): LadderPlan {
  const plan: LadderPlan = { ...NO_SAVING, level };
  for (const step of flow.exam.saveLadder.slice(0, Math.max(0, level))) {
    if (step === "hidden") plan.hidden = false;
    else if (step === "old") plan.oldScale = 0.5;
    else if (step === "cheap") plan.cheap = true;
    else if (step === "final-old") plan.finalOldOnly = true;
  }
  return plan;
}

/**
 * 一晚里第一个考试会话不管；之后的考试会话调用过、写进缓存的比读到的多（spec §10.1 拿读和写比），
 * 或者一点缓存都没读到的，返回一句话
 */
export function examCacheCheck(): { seen(id: string, u: StageUsage): string | null } {
  let first = true;
  return {
    seen(id, u) {
      if (first) { first = false; return null; }
      return u.calls > 0 && (u.cacheWrite > u.cacheRead || u.cacheRead === 0) ? S.ladder.cacheMissed(id) : null;
    },
  };
}
