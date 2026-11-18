// 「这一周」：五个数按她的日子一天一行（又犯、被纠正、笔记翻开率、被叫醒、周额度），外加用量当量。
// 口径都不在这里：库和日志那几样是 src/metrics/numbers.ts 的 numbers()（很轻，每次现算）；
// 用量当量要读会话记录（整个目录几个 G），用 src/metrics/usage.ts 按文件接着读的那一套，在后台读，读完之前这一栏先空着。全部只读。
import { readFileSync } from "node:fs";
import { localDay } from "../learning/score.ts";
import { numbers } from "../metrics/numbers.ts";
import type { NumbersDay, NumbersInput, ReadDb } from "../metrics/numbers.ts";
import type { UsageScanner } from "../metrics/usage.ts";

export interface WeeklyOptions {
  /** HH 日志（被叫醒、额度读数从这里数） */
  logPath: string;
  tz: string;
  /** HH 自己的工作区、回放的目录：用量按它们分去向 */
  dirs: NumbersInput["dirs"];
}

export interface WeeklyView {
  tz: string;
  /** 她的今天（当天的又犯要等夜里整理才记，页面上不当 0 显示） */
  today: string;
  /** 最近 days 天，从早到晚；prev 是再往前同样多天（对比用） */
  days: NumbersDay[];
  prev: NumbersDay[];
  /** 用量当量读好了没有：没读完时 days / prev 里的 usage 都是 0，页面不能当真 */
  usage: {
    ready: boolean; at: number | null; reading: { files: number; readBytes: number } | null;
    /** 有归档走的会话记录这会儿读不到、以前也没读过：links 个；upTo 这一天（她的日子）和更早的用量可能比真的少，页面上标「记录不全」。都读得到是 null */
    unread: { links: number; upTo: string } | null;
  };
}

function logLines(path: string): string[] {
  try { return readFileSync(path, "utf8").split("\n"); } catch { return []; }
}

/** usage 给 null：这个控制台没配会话记录目录，用量那一栏一直空着 */
export function weeklyView(db: ReadDb | null, o: WeeklyOptions, usage: UsageScanner | null, now: number, days = 7): WeeklyView {
  const rows = numbers({ days: days * 2, now, tz: o.tz, db, logLines: logLines(o.logPath), transcripts: [], dirs: o.dirs });
  const done = usage?.latest ?? null;
  if (usage && done) for (const r of rows) r.usage = usage.tally.usage(r.day);
  return {
    tz: o.tz, today: localDay(now, o.tz),
    days: rows.slice(-days), prev: rows.slice(0, rows.length - days),
    usage: {
      ready: !!done, at: done?.at ?? null, reading: usage?.progress ? { ...usage.progress } : null,
      unread: done?.unread ? { links: done.unread.links, upTo: localDay(done.unread.upTo, o.tz) } : null,
    },
  };
}
