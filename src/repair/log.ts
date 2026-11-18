// 修理的留痕：每次检查、合并、部署、重启、退回、核对都记一行（~/.hh/repair/log.jsonl），主人和她都看得到。
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { B, N, R, fromEveryPack } from "../lang/index.ts";

export interface RepairEvent {
  t: string;
  kind: "check" | "merge" | "deploy" | "refused" | "restart" | "boot" | "healthy" | "rollback" | "audit" | "watch";
  by?: string;
  fix?: string;
  from?: string;
  to?: string;
  text: string;
  /** 部署时每个提交怎么放行的（会话批的、帮手审过的、主人批的原话、看守退回） */
  items?: string[];
  /** 这次部署的入口检查是按守门目录里的跳过记录放过去的：谁放的、为什么 */
  entrySkip?: { by: string; why: string };
}

export function repairDir(stateDir: string): string {
  const d = join(stateDir, "repair");
  mkdirSync(d, { recursive: true });
  return d;
}

export function appendEvent(stateDir: string, e: Omit<RepairEvent, "t"> & { t?: string }): void {
  const row: RepairEvent = { ...e, t: e.t ?? new Date().toISOString() };
  appendFileSync(join(repairDir(stateDir), "log.jsonl"), JSON.stringify(row) + "\n");
}

export function readEvents(stateDir: string, sinceMs?: number): RepairEvent[] {
  const p = join(stateDir, "repair", "log.jsonl");
  if (!existsSync(p)) return [];
  const out: RepairEvent[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as RepairEvent;
      if (sinceMs === undefined || Date.parse(e.t) >= sinceMs) out.push(e);
    } catch { /* 半行跳过 */ }
  }
  return out;
}

/** 线上现在是哪个提交（部署脚本写，看守退回时改） */
export interface Deployed { commit: string; prev: string | null; t: string; by: string; lastHealthy?: string }

export function readDeployed(stateDir: string): Deployed | null {
  try { return JSON.parse(readFileSync(join(stateDir, "repair", "deployed.json"), "utf8")) as Deployed; } catch { return null; }
}

export function writeDeployed(stateDir: string, d: Deployed): void {
  writeFileSync(join(repairDir(stateDir), "deployed.json"), JSON.stringify(d, null, 2) + "\n");
}

/** 看守真退回过的部署（prev..target）：只有这些范围的还原提交算「看守退回」 */
export function rolledBackRanges(stateDir: string): string[] {
  return readEvents(stateDir).filter((e) => e.kind === "rollback" && e.by === "watchdog" && e.from && e.to).map((e) => `${e.to}..${e.from}`);
}

/** 看守退回了、共享 master 上却没还原成（有冲突）的部署：还原提交（Rollback-range 一样）进 master 之前不能再部署这些提交 */
export interface Held { prev: string; target: string; t: string; why: string }

export function readHeld(stateDir: string): Held[] {
  try { return JSON.parse(readFileSync(join(stateDir, "repair", "held.json"), "utf8")) as Held[]; } catch { return []; }
}

export function writeHeld(stateDir: string, held: Held[]): void {
  writeFileSync(join(repairDir(stateDir), "held.json"), JSON.stringify(held, null, 2) + "\n");
}

/** 最近一个确认跑稳的提交：现在这版跑稳了就是它；没跑稳就沿用上次记的。bootstrap 和看守退回到的版本本来就在跑，算稳 */
export function lastHealthy(stateDir: string, d: Deployed): string {
  let healthy: string | null = null;
  try { healthy = (JSON.parse(readFileSync(join(stateDir, "repair", "healthy.json"), "utf8")) as { commit: string | null }).commit; } catch { /* 还没有 */ }
  if (healthy === d.commit || d.by === "bootstrap" || d.by === "watchdog") return d.commit;
  return d.lastHealthy ?? d.prev ?? d.commit;
}

/** 早上的小结：修好了什么、退回了什么、核对查出了什么、还在等主人的。什么都没有就是空的 */
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function summarize(events: RepairEvent[], waiting: string[]): string {
  const parts: string[] = [];
  const fixed = events.filter((e) => e.kind === "merge");
  if (fixed.length) parts.push(R.log.summaryFixed(fixed.map((e) => R.log.summaryFixedItem(e.fix ?? "", e.text)).join(R.log.summaryFixedSeparator)));
  // a rollback done or failed midway carries from / to (watchdog.ts); the one that only says telling the owner failed does not
  const back = events.filter((e) => e.kind === "rollback" && e.from !== undefined);
  if (back.length) parts.push(R.log.summaryRollbacks(back.length, back.map((e) => e.text.split("：")[1]?.split("；")[0] ?? e.text).join(R.log.summaryRollbackSeparator)));
  // 只认每个提交的那一条（部署时写的「<7 位提交号> <主人的称呼>：<why>」，deploy.ts）：items 里还有入口检查的说明，why 里也可能碰巧有「 <称呼>：」
  const OWNER_ITEM = new RegExp(`^[0-9a-f]{7}${escapeRe(R.deploy.deployItemLine("", N.owner, ""))}`);
  const asked = events.filter((e) => e.kind === "deploy").flatMap((e) => (e.items ?? []).filter((i) => OWNER_ITEM.test(i)));
  if (asked.length) parts.push(R.log.summaryOwnerApproved(asked.map((i) => i.replace(OWNER_ITEM, "")).join(B.common.listSep)));
  const drift = events.filter((e) => e.kind === "audit");
  if (drift.length) parts.push(R.log.summaryAuditFindings(drift.map((e) => e.text).join(B.common.listSep)));
  if (!parts.length && !waiting.length) return "";
  return R.log.summaryYesterday(parts.length ? parts.join(B.common.listSep) : R.log.summaryNothingFixed, waiting.length ? R.log.summaryWaiting(waiting.join(R.log.summaryWaitingSeparator)) : "");
}

/** 毛病本里「## 问 <主人的称呼>」那一节的编号（文件名、标题在语言包：R.log.summaryWaitingFile、waitingHeading；每个包的都认） */
export function waitingIds(workspace: string): string[] {
  const heads = fromEveryPack((p) => p.repair.log.waitingHeading).map(escapeRe).join("|");
  return [...new Set(fromEveryPack((p) => p.repair.log.summaryWaitingFile))].flatMap((file) => {
    let text: string;
    try { text = readFileSync(join(workspace, "memory", file), "utf8"); } catch { return []; }
    const sec = new RegExp(`^## (?:${heads})[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(text)?.[1] ?? "";
    return [...sec.matchAll(/^- (#\d{4})/gm)].map((m) => m[1] ?? "").filter(Boolean);
  });
}
