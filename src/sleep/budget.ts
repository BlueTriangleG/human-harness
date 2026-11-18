// 花费表（spec §10.1）：每次调用按输入、读缓存、写缓存、输出和模型换算成「单位」，再用一个系数换成周额度的百分比。
// 系数从历史里校准（配置里能改）；目标线 = 现在几晚的平均，绝对线碰到就停。
export type Model = "opus" | "sonnet" | "haiku";

export interface Weights {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** 模型倍数 */
  model: Record<Model, number>;
}

export const DEFAULT_WEIGHTS: Weights = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5, model: { opus: 1, sonnet: 0.6, haiku: 0.2 } };

/** 11-04 量的：一晚约周额度的 1%，约 540 万单位 */
export const UNITS_PER_PCT = 5_400_000;

export function units(t: { input: number; cacheRead: number; cacheWrite: number; output: number }, model: Model, w: Weights = DEFAULT_WEIGHTS): number {
  return (t.input * w.input + t.cacheRead * w.cacheRead + t.cacheWrite * w.cacheWrite + t.output * w.output) * w.model[model];
}

export class Budget {
  readonly unitsPerPct: number;
  readonly targetPct: number;
  readonly hardPct: number;
  private used = 0;

  constructor(o: { unitsPerPct?: number; targetPct: number; hardPct: number }) {
    this.unitsPerPct = o.unitsPerPct ?? UNITS_PER_PCT;
    this.targetPct = o.targetPct;
    this.hardPct = o.hardPct;
  }

  add(u: number): void { if (Number.isFinite(u) && u > 0) this.used += u; }
  /** 到现在花了多少单位 */
  get spent(): number { return this.used; }
  /** 到现在约占周额度的百分之几 */
  get pct(): number { return this.used / this.unitsPerPct; }
  get overTarget(): boolean { return this.pct >= this.targetPct; }
  get overHard(): boolean { return this.pct >= this.hardPct; }
}
