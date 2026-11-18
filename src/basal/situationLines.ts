// 前台每轮情境里关于「同时在做的事」的几句（她知道自己同时在做几件事，但不知道大脑怎么分的）。
import type { TaskRow } from "./tasks.ts";
import { B } from "../lang/index.ts";

export function parallelLines(a: {
  doing: TaskRow[];
  /** 还在跑的帮手：名字、派出去的时间、在帮哪件事；ask：派出去一天多还没交回、这一次要问她清不清 */
  helpers?: Array<{ name: string; since: number; topic?: string; ask?: boolean }>;
  chat: { busy: boolean; counts: Array<{ who: string; n: number }> };
  windowMin: number;
  calibration: { n: number; ratio: number } | null;
  showCalibration: boolean;
  now: number;
}): string[] {
  const out: string[] = [];
  if (a.doing.length) {
    const items = a.doing.map((t) => {
      const mins = Math.max(0, Math.round((a.now - t.started) / 60_000));
      if (t.aboutMin === null) return B.situationLines.doingItemNoEstimate(t.topic, mins);
      const left = t.aboutMin - mins;
      return left > 0 ? B.situationLines.doingItemTimeLeft(t.topic, mins, left) : B.situationLines.doingItemOverEstimate(t.topic, mins, -left);
    });
    out.push(B.situationLines.doingLine(items.join(B.situationLines.listSeparator)));
  }
  const item = (h: { name: string; since: number; topic?: string }, verb: string): string => B.situationLines.helperItem(h.name, h.topic ? B.situationLines.helperTopicSuffix(h.topic) : "", verb, howLong(a.now - h.since));
  const running = a.helpers?.filter((h) => !h.ask) ?? [];
  const ask = a.helpers?.filter((h) => h.ask) ?? [];
  if (running.length) out.push(B.situationLines.helpersRunningLine(running.map((h) => item(h, B.situationLines.helperVerbRunning)).join(B.situationLines.listSeparator)));
  // 只问一次（问过的回到上面那行，照常列着）
  if (ask.length) {
    out.push(B.situationLines.helpersOverdueQuestion(ask.map((h) => item(h, B.situationLines.helperVerbAsk)).join(B.situationLines.listSeparator)) +
      B.situationLines.helpersOverdueHowToClear);
  }
  if (a.chat.counts.length) out.push(a.chat.counts.map((c) => B.situationLines.chatCountItem(a.windowMin, c.who, c.n)).join(B.situationLines.chatCountSeparator));
  if (a.showCalibration && a.calibration) out.push(B.situationLines.estimateCalibrationLine(a.calibration.n, a.calibration.ratio));
  return out;
}

/** 帮手跑了多久：一天以内按分钟（和以前一样），再久按小时、按天 */
function howLong(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 24 * 60) return B.situationLines.durationMinutes(min);
  return min < 48 * 60 ? B.situationLines.durationHours(Math.floor(min / 60)) : B.situationLines.durationDays(Math.floor(min / 1440));
}

/**
 * 叫醒附带的东西「变没变」按这个比（11-02：负载、目标、同时在做里的数字和「N 分钟前」每次都不一样，
 * 按原文比等于每次都给，一页里光这些就占四成多的附带）：数字和相对时间不算变化，状态、事情、人变了才算。
 */
export function withoutVolatile(text: string): string {
  return text.replace(B.forms.ago, "").replace(/\d+(?:\.\d+)?/g, "#");
}
