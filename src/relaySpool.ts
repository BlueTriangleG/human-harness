// relay-spool（CEO 11-12，b）：hhd 连不上时（没起来、正在重启），hh-relay 把消息先存进 <stateDir>/relay-spool/，
// 不再交给 OpenClaw 自己的 agent（「两个她」）。hhd 起来时、以后每次 tick 把它们按存的先后补交，交完就删。
// 文件里是消息原文：relay 写的时候是 600；这里不把原文写进日志；读不了、交不进去的改名成 .failed 留着（不无限重试）
import { readdirSync, readFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { InboundMessage } from "./channels/types.ts";
import type { Logger } from "./log.ts";

export const spoolDirOf = (stateDir: string): string => join(stateDir, "relay-spool");

/** 交不进去的改名成 .failed 留着（不无限重试；人来看） */
function keepFailed(p: string): void {
  try { renameSync(p, `${p}.failed`); } catch { /* 改不了名就留着，下次还会试 */ }
}

/** 按文件名（开头是存的时刻）的先后补交；返回交了几条、几条没交进去 */
export function drainSpool(o: { dir: string; deliver: (m: InboundMessage) => unknown; log: Pick<Logger, "info" | "warn"> }): { delivered: number; failed: number } {
  if (!existsSync(o.dir)) return { delivered: 0, failed: 0 };
  const files = readdirSync(o.dir).filter((f) => f.endsWith(".json") && !f.startsWith(".")).sort();
  let delivered = 0;
  let failed = 0;
  for (const f of files) {
    const p = join(o.dir, f);
    let rec: { v?: unknown; at?: unknown; message?: InboundMessage };
    try {
      rec = JSON.parse(readFileSync(p, "utf8")) as typeof rec;
      if (!rec.message || typeof rec.message.text !== "string") throw new Error("not a spooled relay message");
    } catch (e) {
      // 读不了：只记错误类型（解析错误的报错会带出文件内容，也就是消息原文）
      failed += 1;
      keepFailed(p);
      o.log.warn("relay spool: unreadable, kept as .failed", { file: f, error: e instanceof Error ? e.name : "error" });
      continue;
    }
    try {
      o.deliver({ ...rec.message, ...(typeof rec.at === "number" ? { spooledAt: rec.at } : {}) });
    } catch (e) {
      failed += 1;
      keepFailed(p);
      o.log.warn("relay spool: couldn't be handed in, kept as .failed", { file: f, error: String(e).slice(0, 160) });
      continue;
    }
    try { unlinkSync(p); } catch (e) { o.log.warn("relay spool: handed in but couldn't delete", { file: f, error: String(e).slice(0, 120) }); }
    delivered += 1;
  }
  if (delivered || failed) o.log.info("relay spool: drained", { delivered, failed });
  return { delivered, failed };
}
