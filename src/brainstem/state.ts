import { B } from "../lang/index.ts";
// 脑干：清醒 / 困 / 睡着 的状态机。纯逻辑，输入是"现在的情况"，输出是该做什么。
// 规则（初值，实测再调）：
//   压缩块 ≥ sleepyAt → 困；困了以后闲下来 idleMinutes → 去睡
//   压缩块 ≥ mustSleepAt → 立刻去睡
//   夜里固定睡一次（闲下来 1 分钟就睡，不打断正在做的事）
//   专注时段里困了也先撑着、夜里那一觉也等专注完再睡，除非到了必须睡

export type Alertness = "awake" | "sleepy" | "asleep";

export interface Situation {
  now: number;
  compactedTokens: number;
  busy: boolean;              // 有脑区正在跑、或者有待回的消息
  lastActivity: number;       // 最近一次有事发生的时间
  inFocus: boolean;
  nightDue: boolean;
}

export interface Thresholds { sleepyAt: number; mustSleepAt: number; idleMinutes: number }

export type SleepKind = "must" | "night" | "sleepy";
export type Decision = { state: Alertness; sleepNow: false } | { state: "asleep"; sleepNow: true; kind: SleepKind; reason: string };

export function decide(current: Alertness, s: Situation, t: Thresholds): Decision {
  if (current === "asleep") return { state: "asleep", sleepNow: false };
  const idleMs = s.busy ? 0 : s.now - s.lastActivity;
  if (s.compactedTokens >= t.mustSleepAt) return { state: "asleep", sleepNow: true, kind: "must", reason: B.state.sleepReasonMustSleep };
  if (s.nightDue && !s.inFocus && !s.busy && idleMs >= 60_000) return { state: "asleep", sleepNow: true, kind: "night", reason: B.state.sleepReasonNight };
  if (s.compactedTokens >= t.sleepyAt) {
    if (!s.inFocus && idleMs >= t.idleMinutes * 60_000) return { state: "asleep", sleepNow: true, kind: "sleepy", reason: B.state.sleepReasonSleepy };
    return { state: "sleepy", sleepNow: false };
  }
  return { state: "awake", sleepNow: false };
}
