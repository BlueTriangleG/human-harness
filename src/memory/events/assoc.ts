// 联想日志：每次真的附给她看的联想记一行（<stateDir>/mem-assoc/<她的日子>.jsonl），
// 之后统计她接住了多少（联想之后一小时内展开了那件事、或在回复里引用了编号），按这个调门槛。
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../store/db.ts";
import { one } from "../../store/db.ts";

const DAY = 86_400_000;
const WINDOW_MS = 3600_000;

export interface AssocLine { at: number; region: string; speaker?: string; cue: string; events: string[]; /** 给了的片段（n…）和原话（q…）；11-01 以前的行没有 */ entries?: string[]; chars: number; ms: number }

export interface AssocStats {
  days: number;
  associations: number;
  /** 什么都没附的次数 */
  empty: number;
  eventsGiven: number;
  /** 给了之后一小时内她展开（open）或引用（cite）了的 */
  eventsAdopted: number;
  avgMs: number;
  maxMs: number;
  avgChars: number;
  /** 给得最多的几件：编号、给了几次、接住几次 */
  top: Array<{ id: string; given: number; adopted: number }>;
}

function localDay(t: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
}

export function logAssociation(dir: string, line: AssocLine, tz: string): void {
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${localDay(line.at, tz)}.jsonl`), JSON.stringify({ ...line, cue: line.cue.slice(0, 300) }) + "\n");
}

export function assocStats(db: Db, dir: string, o: { now: number; days?: number; windowMs?: number }): AssocStats {
  const days = o.days ?? 7;
  const from = o.now - days * DAY;
  const win = o.windowMs ?? WINDOW_MS;
  const lines: AssocLine[] = [];
  let files: string[] = [];
  try { files = readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)); } catch { /* 还没有日志 */ }
  for (const f of files) {
    // 文件按她的日子分；多读前一天的，按 at 再筛
    if (Date.parse(f.slice(0, 10)) < from - 2 * DAY) continue;
    for (const raw of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try { const l = JSON.parse(raw) as AssocLine; if (l.at >= from && l.at <= o.now) lines.push(l); } catch { /* 坏行跳过 */ }
    }
  }
  const adopted = (id: string, at: number) => Boolean(one(db, "SELECT 1 FROM mem_touch WHERE ref = ? AND how IN ('open','cite') AND at BETWEEN ? AND ? LIMIT 1", id, at, at + win));
  const per = new Map<string, { given: number; adopted: number }>();
  let given = 0, took = 0;
  for (const l of lines) {
    for (const id of l.events) {
      const ok = adopted(id, l.at);
      given += 1;
      if (ok) took += 1;
      const p = per.get(id) ?? { given: 0, adopted: 0 };
      p.given += 1;
      if (ok) p.adopted += 1;
      per.set(id, p);
    }
  }
  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  return {
    days, associations: lines.length, empty: lines.filter((l) => !l.events.length).length,
    eventsGiven: given, eventsAdopted: took,
    avgMs: avg(lines.map((l) => l.ms)), maxMs: lines.reduce((m, l) => Math.max(m, l.ms), 0), avgChars: avg(lines.map((l) => l.chars)),
    top: [...per.entries()].sort((a, b) => b[1].given - a[1].given).slice(0, 10).map(([id, p]) => ({ id, ...p })),
  };
}
