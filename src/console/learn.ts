// 控制台的「学习」：最近 7 天的每周数字、最近 20 次联想、今天的花费、告警。只读查 hh.db，不经 hhd。
// 每周数字要书架（页在哪本、做法里的 ✓ 日期）：只读地扫一遍书架目录，不发号、不写她的文件。
import type { DatabaseSync } from "node:sqlite";
import { kvGet } from "../store/db.ts";
import { CentralMemory } from "../memory/central.ts";
import { shelfOf } from "./shelf.ts";
import { localDay, weekly, type WeeklyNumbers } from "../learning/score.ts";

export interface LearnOptions {
  /** 书架根目录、通用大类的名字（config learning） */
  root: string;
  generalCategory: string;
  /** name of the archive directory in the shelf (config learning.archiveDir) */
  archiveDir: string;
  /** 她的时区：今天的花费、每周数字按她的日子 */
  tz: string;
  /** 每天的花费上限（美元） */
  dailyUsd: number;
}

export interface LearnAssoc {
  at: number; region: string; binding: string | null; topic: string | null; candidates: number;
  mounted: Array<{ id: string; p: number }>; shadow: boolean; skipped: string | null; ms: number; tokens: number;
}

export interface LearnView {
  /** kv learn.alert：判断出问题时 hhd 写的告警，有就在区块顶上标红（hhd 写的超过 24 小时就不标了） */
  alert: string | null;
  /** 告警是什么时候写的；旧的纯文字告警没有时间，是 null */
  alertAt: number | null;
  spend: { day: string; tokens: number; usd: number; limit: number };
  weekly: WeeklyNumbers;
  /** 最近 20 次联想，新的在前 */
  recent: LearnAssoc[];
}

const USD_PER_TOKEN = 0.1 / 1e6;
const ALERT_MS = 24 * 3_600_000;

/** hhd 写的是 JSON {at, msg}：24 小时内的给 msg 和时间，更早的当没有。不是这个样子的（旧的、手写的纯文字）原样给，没有时间 */
function alertOf(raw: string | undefined, now: number): { alert: string | null; alertAt: number | null } {
  if (!raw) return { alert: null, alertAt: null };
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* 纯文字 */ }
  const v = parsed as { at?: unknown; msg?: unknown } | null;
  if (!v || typeof v !== "object" || typeof v.at !== "number" || typeof v.msg !== "string") return { alert: raw, alertAt: null };
  return now - v.at < ALERT_MS ? { alert: v.msg, alertAt: v.at } : { alert: null, alertAt: null };
}

export function learnView(db: DatabaseSync, now: number, o: LearnOptions): LearnView {
  const day = localDay(now, o.tz);
  const tokens = Number(kvGet(db, `learn.spend.${day}`)) || 0;
  const recent = (db.prepare("SELECT at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens FROM learn_assoc ORDER BY at DESC, id DESC LIMIT 20").all() as Array<{
    at: number; region: string; binding: string | null; topic: string | null; candidates: number; mounted: string; shadow: number; skipped: string | null; ms: number; tokens: number;
  }>).map((r) => {
    let mounted: LearnAssoc["mounted"] = [];
    try { mounted = JSON.parse(r.mounted) as LearnAssoc["mounted"]; } catch { /* 坏行当没挂 */ }
    return {
      at: Number(r.at), region: r.region, binding: r.binding, topic: r.topic, candidates: Number(r.candidates),
      mounted, shadow: Number(r.shadow) === 1, skipped: r.skipped, ms: Number(r.ms), tokens: Number(r.tokens),
    };
  });
  return {
    ...alertOf(kvGet(db, "learn.alert"), now),
    spend: { day, tokens, usd: Math.round(tokens * USD_PER_TOKEN * 1e4) / 1e4, limit: o.dailyUsd },
    weekly: weekly(db, { now, tz: o.tz, shelf: shelfOf(o.root, o.generalCategory, o.archiveDir), central: new CentralMemory(db), root: o.root }),
    recent,
  };
}
