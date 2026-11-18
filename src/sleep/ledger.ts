// 新睡眠的记账：一晚一行、每段每次尝试一行、欠着没补的段。时间都由调用方传进来（毫秒）。
import { all, one, type Db } from "../store/db.ts";

export interface StageRowEnd {
  status: "running" | "passed" | "redo" | "deferred" | "failed" | "skipped";
  calls: number;
  maxCtx: number;
  cacheRead: number;
  cacheWrite: number;
  input: number;
  output: number;
  units: number;
  changes: number;
  verdict: string;
  error: string;
  /** 多人模式才写（db 17）：脑区、谁做的、谁审的、怎么定的、各花了多少（JSON） */
  region: string;
  persona: string;
  reviewer: string;
  decision: string;
  cost: string;
}

export interface OwedRow {
  day: string;
  stage: string;
  nights: number;
  problems: string[];
  created: number;
  updated: number;
  status: "owed" | "done" | "escalated";
}

const STAGE_COLS: Record<keyof StageRowEnd, string> = {
  status: "status", calls: "calls", maxCtx: "max_ctx", cacheRead: "cache_read", cacheWrite: "cache_write",
  input: "input", output: "output", units: "units", changes: "changes", verdict: "verdict", error: "error",
  region: "region", persona: "persona", reviewer: "reviewer", decision: "decision", cost: "cost",
};

export function startRun(db: Db, night: string, flowHash: string, now: number): number {
  const r = db.prepare("INSERT INTO sleep_run (night, started, status, flow_hash) VALUES (?, ?, 'running', ?)").run(night, now, flowHash);
  return Number(r.lastInsertRowid);
}

export function endRun(db: Db, id: number, o: { status: string; days: string[]; spentUnits: number; notes?: string }, now: number): void {
  db.prepare("UPDATE sleep_run SET ended = ?, status = ?, days = ?, spent_units = ?, notes = ? WHERE id = ?")
    .run(now, o.status, JSON.stringify(o.days), o.spentUnits, o.notes ?? null, id);
}

/**
 * 崩了的那一跑（最近一个没收尾、ended 空着的 sleep_run，不算 exclude 这一跑自己）开始的时刻；没有给 null。
 * prepared.json 读不出来时，撤回这一天的批次从这一刻起算（不从 0：以前几夜提交过的不动）
 */
export function crashedRunStart(db: Db, exclude: number): number | null {
  return one<{ started: number }>(db, "SELECT started FROM sleep_run WHERE ended IS NULL AND id != ? ORDER BY started DESC, id DESC LIMIT 1", exclude)?.started ?? null;
}

/** 一晚里到过的最高一级省钱阶梯 */
export function setRunSaveLevel(db: Db, id: number, level: number): void {
  db.prepare("UPDATE sleep_run SET save_level = ? WHERE id = ?").run(level, id);
}

/** 睡前、睡后的周额度读数（百分比，额度把关看的那个；读不到给 null）：跟估算的花费对账、校准系数用（spec §10.1） */
export function setRunQuota(db: Db, id: number, before: number | null, after: number | null): void {
  db.prepare("UPDATE sleep_run SET quota_before = ?, quota_after = ? WHERE id = ?").run(before, after, id);
}

export function startStage(db: Db, o: { runId: number; day: string; stage: string; attempt: number; model: string }, now: number): number {
  const r = db.prepare("INSERT INTO sleep_stage (run_id, day, stage, attempt, model, started, status) VALUES (?, ?, ?, ?, ?, ?, 'running')")
    .run(o.runId, o.day, o.stage, o.attempt, o.model, now);
  return Number(r.lastInsertRowid);
}

export function endStage(db: Db, id: number, o: Partial<StageRowEnd>, now: number): void {
  const sets = ["ended = ?"];
  const vals: Array<string | number | null> = [now];
  for (const k of Object.keys(STAGE_COLS) as Array<keyof StageRowEnd>) {
    const v = o[k];
    if (v === undefined) continue;
    sets.push(`${STAGE_COLS[k]} = ?`);
    vals.push(v);
  }
  db.prepare(`UPDATE sleep_stage SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
}

/** 这一行的 decision 后面接一句（比如前额叶要的打磨没做：「（没做：目标线）」） */
export function noteStageDecision(db: Db, id: number, note: string): void {
  db.prepare("UPDATE sleep_stage SET decision = COALESCE(decision, '') || ? WHERE id = ?").run(note, id);
}

export interface StageExamRow {
  day: string; stage: string; attempt: number;
  questions: number; scoreBefore: number | null; scoreAfter: number | null;
  regressions: number | null; hiddenScore: number | null;
  /** 1 考了；0 没考完（考试会话两次都坏了） */
  examined: 0 | 1;
}

/** 这一段这一次的考试分数：记在这一天这一段这一次尝试最新的那行 sleep_stage 上 */
export function setStageExam(db: Db, o: StageExamRow): void {
  db.prepare(
    `UPDATE sleep_stage SET questions = ?, score_before = ?, score_after = ?, regressions = ?, hidden_score = ?, examined = ?
     WHERE id = (SELECT id FROM sleep_stage WHERE day = ? AND stage = ? AND attempt = ? ORDER BY id DESC LIMIT 1)`,
  ).run(o.questions, o.scoreBefore, o.scoreAfter, o.regressions, o.hiddenScore, o.examined, o.day, o.stage, o.attempt);
}

/** 欠着：已有就 nights += 1、problems 换成新的、重新标成 owed。 */
export function owe(db: Db, day: string, stage: string, problems: string[], now: number): void {
  db.prepare(
    `INSERT INTO sleep_owed (day, stage, nights, problems, created, updated, status) VALUES (?, ?, 1, ?, ?, ?, 'owed')
     ON CONFLICT(day, stage) DO UPDATE SET nights = nights + 1, problems = excluded.problems, updated = excluded.updated, status = 'owed'`,
  ).run(day, stage, JSON.stringify(problems), now, now);
}

export function owed(db: Db): OwedRow[] {
  return all<Omit<OwedRow, "problems"> & { problems: string }>(db, "SELECT * FROM sleep_owed WHERE status = 'owed' ORDER BY day, stage")
    .map((r) => ({ ...r, problems: JSON.parse(r.problems) as string[] }));
}

export function settleOwed(db: Db, day: string, stage: string, status: "done" | "escalated", now: number): void {
  db.prepare("UPDATE sleep_owed SET status = ?, updated = ? WHERE day = ? AND stage = ?").run(status, now, day, stage);
}
