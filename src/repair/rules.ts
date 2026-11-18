// 守门的规则（两条线：大重构/大架构/性能风险要问；碰沙盒权限要问）。
// 规则在 config/repair.json，本身在保护名单上；守门永远用线上已部署那份的规则和代码。
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface RepairRules {
  /** 只有这几个目录里的改动可能「通过」；别处（.claude/、CLAUDE.md、.mcp.json、.npmrc……主人账号那边的工具会自动读的）一律问主人 */
  allowedRoots: string[];
  /** Claude Code 自己会读进来当指令的文件（CLAUDE.md、AGENTS.md、.claude/、.mcp.json），在哪个目录、大小写怎么写都算保护（不分大小写的正则） */
  autoload: string;
  /** 碰了就问主人的路径：`dir/` = 这个目录下的全部，`*` = 一段，`**` = 任意深，其余要完全一样 */
  protected: string[];
  /** 新加的这类代码（起进程、连网、写系统路径）要问主人 */
  capability: Array<{ id: string; re: string }>;
  /** src/tools/ 里新出现的工具名 */
  toolDef: string;
  size: { maxFiles: number; maxLines: number; coreFiles: string[]; coreMaxLines: number };
  /** 跑全套前拿的全公司重活锁：放在哪、最多等多久（这台机器上的约定）。没配就不拿；path 的上级目录不存在也不拿 */
  heavyLock?: { path: string; waitMs: number };
  /** db.ts 里加了这些就是数据库迁移 */
  migration: string;
  /** 每轮固定带的东西（运行说明、提示词、工具说明）净增多少字就问 */
  prefix: { files: string[]; maxChars: number };
  tests: { slowerRatio: number; slowerMinMs: number };
  /** quiet：这段时间不重启（夜里整理）；calmChecks：连着几次 tick 都平静才重启 */
  restart: { quiet: [string, string]; calmChecks: number };
  /** 看守：等重启最多多久（她可能忙很久，默认 7 天）；重启后多久内要起来；起来后多久、连着几次 tick 正常算健康；跑稳后最多等多久看第一轮跑完 */
  watch: { restartWaitMs: number; bootTimeoutMs: number; healthyMs: number; healthyTicks: number; turnWaitMs?: number };
}

export function loadRules(root: string): RepairRules {
  return JSON.parse(readFileSync(join(root, "config/repair.json"), "utf8")) as RepairRules;
}

export function matchesPath(pattern: string, path: string): boolean {
  if (pattern.endsWith("/")) return path.startsWith(pattern);
  if (!pattern.includes("*")) return path === pattern;
  const re = pattern.split("/").map((seg) => seg === "**" ? "(?:.*)" : seg.split("*").map(escape).join("[^/]*")).join("/");
  return new RegExp(`^${re.replace("/(?:.*)", "(?:/.*)?")}$`).test(path);
}

function escape(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}
