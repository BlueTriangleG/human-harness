// 分派：她开始做一件事时自己估了多久，超过阈值就交给空着的那部分（靠她估的时间，不靠代码猜）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Entry } from "../memory/central.ts";
import type { Pri } from "./tasks.ts";

export type Dispatch = { kind: "self" } | { kind: "background"; region: string } | { kind: "notebook"; doing: string[] };

export function decideDispatch(a: {
  caller: "front" | "background";
  aboutMin: number | null;
  pri: Pri;
  freeBackground: string | null;
  busyChat: boolean;
  doingTopics: string[];
  thresholdMin: number;
  /** 额度快用完或电脑吃紧：不往外分，她自己做（不拦她，只提醒省着点；原来是进待办账本，她照样做，任务没建、没标准没人看） */
  gated?: boolean;
}): Dispatch {
  if (a.caller === "background") return { kind: "self" };                       // 后台自己的事不再往外分
  if (a.aboutMin === null || a.aboutMin <= a.thresholdMin) return { kind: "self" };
  if (a.freeBackground) return { kind: "background", region: a.freeBackground };
  if (a.pri === "T0" || a.gated) return { kind: "self" };
  if (!a.busyChat) return { kind: "self" };                                       // 聊得少：她可以同时做两件大事
  return { kind: "notebook", doing: a.doingTopics };
}

export interface BusyChatCfg { windowMin: number; count: number; exchangeMin: number }

/** 最近聊得多不多：窗口里某个人发了 count 条以上，或者最近 exchangeMin 分钟里有一来一回 */
export function chatActivity(entries: Entry[], now: number, cfg: BusyChatCfg): { busy: boolean; counts: Array<{ who: string; n: number }> } {
  const since = now - cfg.windowMin * 60_000;
  const recent = now - cfg.exchangeMin * 60_000;
  const counts = new Map<string, number>();
  let lastHuman = 0;
  let lastSent = 0;
  for (const e of entries) {
    if (e.ts < since) continue;
    if (e.kind === "input" && e.src === "外界" && e.meta?.human === true) {
      const who = typeof e.meta.from === "string" ? e.meta.from : "?";
      counts.set(who, (counts.get(who) ?? 0) + 1);
      lastHuman = Math.max(lastHuman, e.ts);
    } else if (e.kind === "note" && e.meta?.sent === true) lastSent = Math.max(lastSent, e.ts);
  }
  const list = [...counts.entries()].map(([who, n]) => ({ who, n })).sort((a, b) => b.n - a.n);
  const exchange = lastHuman >= recent && lastSent >= lastHuman;
  return { busy: exchange || list.some((c) => c.n >= cfg.count), counts: list };
}

/** Where the load guard's status is: the instance's load.statusFile, else the load-guard module's own state */
export function loadStatusFile(cfg: Pick<Config, "load" | "stateDir">): string {
  return cfg.load?.statusFile || join(cfg.stateDir, "modules", "load-guard", "status.json");
}

/**
 * Where the helpers module keeps its session records, decided as its script decides it (modules/helpers/scripts/cc.py):
 * the module's own sessionsDir, else its state directory. null: the module is off, this role has no helpers
 */
export function helperSessionsDir(cfg: Pick<Config, "modules" | "stateDir">): string | null {
  const m = cfg.modules?.helpers;
  if (!m?.enabled) return null;
  return (m.sessionsDir as string | undefined) || join(cfg.stateDir, "modules", "helpers", "sessions");
}

/**
 * 电脑吃紧没有：跟 load.py gate cc 一样判断（偏紧照样放行）——
 * 危险、剩余不到 1.2GB、cc 刚被自动关过还在冷却，才算紧。状态文件 10 分钟没更新、读不到，当不紧。
 */
export function readLoadTight(statusPath: string, nowMs: number): boolean {
  try {
    const s = JSON.parse(readFileSync(statusPath, "utf8")) as { t: number; level: string; headroom_mb?: number; cooldown?: Record<string, number> };
    const now = nowMs / 1000;
    if (now - s.t > 600) return false;
    const cool = s.cooldown?.cc;
    return s.level === "danger" || (s.headroom_mb ?? Infinity) < CC_HEADROOM_MB || (typeof cool === "number" && cool > now);
  } catch {
    return false;
  }
}

/** load.py KINDS["cc"]：开一个 Claude Code 至少要留这么多（MB） */
const CC_HEADROOM_MB = 1200;
