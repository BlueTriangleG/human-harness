// 给夜里整理者的话里，从实例配置来的那几样（sleep.organizer、工作区怎么写给她看）。语言包里的句子只管拼，不知道任何角色的文件名
import { existsSync } from "node:fs";
import { join } from "node:path";
import { roleNames, type Config, type NightGuideCfg } from "../config.ts";
import type { NightGuide } from "../lang/zh/prompts.ts";

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 工作区写给她看的样子：在 home 里面就写成 ~/…，不然照绝对路径 */
export function shownWorkspace(workspace: string, home: string): string {
  const h = home.endsWith("/") ? home.slice(0, -1) : home;
  return h && workspace.startsWith(`${h}/`) ? `~/${workspace.slice(h.length + 1)}` : workspace;
}

/**
 * The organizer's guide and its marks: the config's (sleep.organizer), else, with the night module on (nightDir: its
 * directory), the module's own general guide in the role's language (scripts/sleep_organize.<lang>.md, else the English
 * scripts/sleep_organize.md) — steps 0 to 10, its progress in sleep/state.json, the last step's check the night
 * command's sleep_apply
 */
export function organizerOf(cfg: Pick<Config, "sleep" | "lang">, nightDir: string | null): NightGuideCfg {
  if (cfg.sleep.organizer || !nightDir) return cfg.sleep.organizer ?? {};
  const own = join(nightDir, "scripts", `sleep_organize.${(cfg.lang ?? "").trim() || "en"}.md`);
  return { guide: existsSync(own) ? own : join(nightDir, "scripts", "sleep_organize.md"), firstStep: "0", lastStep: "10", state: "sleep/state.json", apply: "night sleep_apply" };
}

/** 配置里写错类型的项当没写（话里那一段不出），不抛 */
export function nightGuide(cfg: Config, home: string, nightDir: string | null = null): NightGuide {
  const o = organizerOf(cfg, nightDir) as Record<string, unknown>;
  const { me, ta } = roleNames(cfg);
  return {
    me, ta, workspace: shownWorkspace(cfg.workspace, home),
    guide: str(o.guide), firstStep: str(o.firstStep), lastStep: str(o.lastStep), state: str(o.state), recallNote: str(o.recallNote), eventNote: str(o.eventNote),
  };
}
