// 「顺不顺」那一页的数据：按小时的数（src/metrics/incidents.ts 数的），加上「每次上线之后」那几段。
// hhd 每起来一次是一段的开头；这一段上线了什么，从修理的留痕里读（<stateDir>/repair/log.jsonl：hh-guard 部署、看守退回、hhd 起来时各记一行）。
// 11-13 她不顺的那个下午，运维就是这样按每次上线切开、一段一段数的。全部只读。
import { statSync } from "node:fs";
import { readEvents } from "../repair/log.ts";
import type { RepairEvent } from "../repair/log.ts";
import type { IncidentCounts, IncidentReport } from "../metrics/incidents.ts";

/** 一次部署 / 退回里每个提交那一行最多给多少字、最多给几行（那一行里有批准时写的原话，可以很长） */
const ITEM_CHARS = 600, ITEM_MAX = 40;

export interface Change {
  /** deploy = 部署；rollback = 看守退回 */
  kind: "deploy" | "rollback";
  at: number;
  by: string;
  /** 留痕里那一行说明（部署了哪到哪、几个提交） */
  text: string;
  /** How each commit of a deploy was let through (approved by a session, reviewed by a helper, or the owner's own words of approval) */
  items: string[];
}

export interface Stretch extends IncidentCounts {
  /** 这一段从哪一刻起（hhd 起来的那一刻；第一段是窗口的开头）、到哪一刻（下一次起来；最后一段到现在） */
  from: number;
  to: number;
  /** hhd 是哪一刻起来的。第一段的可能在窗口以前；留痕里找不到就是 null */
  bootAt: number | null;
  /** 这一段跑的是哪个提交 */
  commit: string | null;
  /** 这一次起来之前、上一次起来之后的部署和退回：就是这一段新上线的东西。空的 = 只是重启，代码没换 */
  changes: Change[];
  /** 这一段的请求是哪几个内核（CLI）版本发的（11-13：出事率差得最多的就是版本） */
  versions: string[];
  /** 她的线上配置是在上一次起来之后、这一次起来之前改的：这次重启让它生效了。配置不走部署，留痕里没有，只能看文件的修改时间；改了什么这里不知道 */
  configChanged: boolean;
}

/** 分段时另外要知道的：某一段里见过的内核版本、配置文件最后一次修改的时刻（不知道就不给） */
export interface StretchExtra {
  versions?: (from: number, to: number) => string[];
  configMtime?: number | null;
}

const clipItem = (s: string): string => (s.length > ITEM_CHARS ? `${s.slice(0, ITEM_CHARS)}…` : s);

/** 一段里最多列几次部署 / 退回（留最新的） */
const CHANGES_MAX = 20;

export interface Stretches {
  /** 从早到晚 */
  stretches: Stretch[];
  /** 已经部署（或退回）了、hhd 还没重启的：还没生效 */
  pending: Change[];
  /** 配置在最近一次起来之后改过：也还没生效 */
  configPending: boolean;
}

/**
 * 把 [from, now] 按 hhd 每次起来切成几段，从早到晚；每段的数由 count(起, 止) 给。
 * 留痕里一次起来都没有：整个窗口就是一段，什么也不知道（commit null、没有 changes）。
 */
export function stretches(events: readonly RepairEvent[], from: number, now: number, count: (from: number, to: number) => IncidentCounts, extra: StretchExtra = {}): Stretches {
  const m = extra.configMtime ?? null;
  const at = (e: RepairEvent): number => Date.parse(e.t);
  const timed = events.filter((e) => Number.isFinite(at(e)) && at(e) <= now).sort((a, b) => at(a) - at(b));
  const boots = timed.filter((e) => e.kind === "boot");
  // A rollback by the watchdog is only the line that carries from-where-to-where (its "could not tell the owner" afterwards is also logged as rollback and is not one; same as rolledBackRanges in repair/log.ts)
  const changes = timed.filter((e) => e.kind === "deploy" || (e.kind === "rollback" && e.by === "watchdog" && !!e.from && !!e.to));
  const changesIn = (after: number, upTo: number): Change[] => changes.filter((e) => at(e) > after && at(e) <= upTo).slice(-CHANGES_MAX).map((e) => ({
    kind: e.kind as Change["kind"], at: at(e), by: e.by ?? "", text: e.text, items: (e.items ?? []).slice(0, ITEM_MAX).map(clipItem),
  }));
  // 窗口开头时正在跑的那一次（窗口以前最后一次起来；没有就是 -1），从它开始，往后每起来一次是一段
  const before = boots.filter((e) => at(e) <= from).length - 1;
  const out: Stretch[] = [];
  for (let i = before; i < boots.length; i++) {
    const boot = i >= 0 ? boots[i]! : null;
    const start = boot ? Math.max(at(boot), from) : from;
    const end = i + 1 < boots.length ? at(boots[i + 1]!) : now;
    if (end <= start) continue;   // 同一刻起来了两回：前一回不占一段
    out.push({
      from: start, to: end,
      bootAt: boot ? at(boot) : null,
      commit: boot?.to ?? null,
      changes: boot ? changesIn(i > 0 ? at(boots[i - 1]!) : -Infinity, at(boot)) : [],
      versions: extra.versions ? extra.versions(start, end) : [],
      // 留痕里最早的那一次起来不标：它之前什么时候起来过不知道，配置可能是很久以前改的
      configChanged: m !== null && !!boot && i > 0 && m > at(boots[i - 1]!) && m <= at(boot),
      ...count(start, end),
    });
  }
  const last = boots.length ? at(boots[boots.length - 1]!) : -Infinity;
  return { stretches: out, pending: boots.length ? changesIn(last, now) : [], configPending: m !== null && boots.length > 0 && m > last && m <= now };
}

export interface HealthView extends IncidentReport, Stretches {}

/** 小时的数加上每次上线之后的那几段。窗口的开头就是小时表第一行的开头。configPath 是她线上配置文件在哪（只看它的修改时间，不读内容） */
export function healthView(report: IncidentReport, o: { stateDir?: string | undefined; configPath?: string | undefined }, scanner: { between: (from: number, to: number) => IncidentCounts; versions: (from: number, to: number) => string[] }): HealthView {
  const from = report.hours[0]?.start ?? report.at;
  let events: RepairEvent[] = [];
  if (o.stateDir) { try { events = readEvents(o.stateDir); } catch { /* 留痕读不了：只给一整段 */ } }
  let configMtime: number | null = null;
  if (o.configPath) { try { configMtime = statSync(o.configPath).mtimeMs; } catch { /* 没有这个文件：不标 */ } }
  return { ...report, ...stretches(events, from, report.at, (a, b) => scanner.between(a, b), { versions: (a, b) => scanner.versions(a, b), configMtime }) };
}
