// 她的技能手册：OpenClaw 时代的 skills（workspace/skills/* 和 plugin-skills/*）打包成一个 Claude Code 插件给每个脑区加载。
// 格式基本一样（SKILL.md + frontmatter），只有一处要改：OpenClaw 的 {baseDir} 占位符 Claude Code 不认，换成真实路径。
// 其余文件（脚本、子手册）用符号链接指回原处，她改手册就是改原文件。
import { mkdirSync, readdirSync, readFileSync, writeFileSync, symlinkSync, existsSync, rmSync, lstatSync, realpathSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { B } from "../lang/index.ts";

const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/**
 * OpenClaw 的 code mode 写法换成这里的工具名：MCP.bili.homeFeed(...) → mcp__bili__home_feed(...)；
 * 只在 code mode 里成立的说明行（驼峰规则、API.read、$api）去掉。
 */
export function adaptSkillText(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/code mode 里工具名是驼峰|API\.read\("mcp\/|MCP\.\w+\.\$api/.test(line))
    .join("\n")
    .replace(/（code mode 里是 MCP\.(\w+)\.\*）/g, B.skills.toolNameParenthesized)
    .replace(/code mode 里是 `?MCP\.(\w+)\.\*`?/g, B.skills.toolNameInline)
    .replace(/MCP\.(\w+)\.\*/g, "mcp__$1__*")
    .replace(/^code mode 里：\s*$/gm, B.skills.callExampleIntro)
    .replace(/code mode 里 ?/g, B.skills.toolNamePrefix)
    .replace(/MCP\.(\w+)\.([A-Za-z][A-Za-z0-9]*)/g, (_m, server: string, name: string) => `mcp__${server}__${snake(name)}`);
}

export interface SkillSource { name: string; dir: string }

const isDir = (p: string): boolean => { try { return statSync(p).isDirectory(); } catch { return false; } };
/** Directories not entered when looking one level down: hidden ones, and the notebook's archive directory (config learning.archiveDir) */
const skipDir = (n: string, archiveDir?: string): boolean => n.startsWith(".") || (archiveDir !== undefined && n === archiveDir);

/**
 * 在这些目录里找名单上的技能（先找到的算）；discover 给了就把那个目录下所有带 SKILL.md 的也带上（exclude 除外）。
 * 手册可以直接放在 discover 下（d/SKILL.md），也可以放在大类目录下（d/<大类>/<本>/SKILL.md，技能名取本的目录名）；
 * 两种并存时旧放法的留，大类下同名的跳过；不同大类之间重名，留目录名排序在前的。
 * 名单上点名的本，直接放的没找到就由大类下同名的补上。
 */
export function findSkills(roots: readonly string[], names: readonly string[], discover?: string, exclude: readonly string[] = [], archiveDir?: string): SkillSource[] {
  const out: SkillSource[] = [];
  const all = [...names];
  const nested: SkillSource[] = [];
  if (discover && existsSync(discover)) {
    for (const d of readdirSync(discover).sort()) {
      const top = join(discover, d);
      if (existsSync(join(top, "SKILL.md"))) {
        if (!all.includes(d) && !exclude.includes(d)) all.push(d);
      } else if (!skipDir(d, archiveDir) && isDir(top)) {
        // 大类目录：本身不是技能，往下一层找；点名的本不受 exclude 管（和直接放的一样）
        for (const n of readdirSync(top).sort()) {
          const dir = join(top, n);
          if (skipDir(n, archiveDir) || (exclude.includes(n) && !names.includes(n)) || nested.some((s) => s.name === n)) continue;
          if (existsSync(join(dir, "SKILL.md"))) nested.push({ name: n, dir: realpathSync(dir) });
        }
      }
    }
  }
  names = all;
  for (const name of names) {
    for (const root of roots) {
      const dir = join(root, name);
      if (existsSync(join(dir, "SKILL.md"))) {
        out.push({ name, dir: realpathSync(dir) });
        break;
      }
    }
  }
  // 直接放的先算：大类下的本，名字已经有了就不再要
  for (const s of nested) if (!out.some((o) => o.name === s.name)) out.push(s);
  return out;
}

/** The manuals plugin's name: the role's id and "-skills" (a skill is called as <that>:<name>) */
export const skillsPluginName = (roleId: string): string => `${roleId}-skills`;

/** 生成插件目录：<out>/.claude-plugin/plugin.json + <out>/skills/<name>/{SKILL.md 改写版, 其余文件的链接} */
export function materializeSkillsPlugin(skills: readonly SkillSource[], finalOut: string, roleId: string): string {
  // 先在旁边建好再换过去：正在用这些手册的会话不会看到一半
  const out = `${finalOut}.new`;
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, ".claude-plugin"), { recursive: true });
  writeFileSync(join(out, ".claude-plugin", "plugin.json"), JSON.stringify({ name: skillsPluginName(roleId), version: "1.0.0", description: B.skills.pluginDescription }, null, 2));
  for (const s of skills) {
    const dst = join(out, "skills", s.name);
    mkdirSync(dst, { recursive: true });
    for (const entry of readdirSync(s.dir)) {
      const src = join(s.dir, entry);
      if (entry === "SKILL.md") {
        // 不用改写的直接链回原文件：她白天改了手册，马上就能看到
        const raw = readFileSync(src, "utf8");
        const adapted = adaptSkillText(raw.replaceAll("{baseDir}", s.dir));
        if (adapted === raw) symlinkSync(src, join(dst, entry));
        else writeFileSync(join(dst, entry), adapted);
      } else if (!lstatSync(src).isSymbolicLink() || existsSync(src)) {
        symlinkSync(src, join(dst, entry));
      }
    }
  }
  const old = `${finalOut}.old`;
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  if (existsSync(finalOut)) renameSync(finalOut, old);
  renameSync(out, finalOut);
  if (existsSync(old)) rmSync(old, { recursive: true, force: true });
  return finalOut;
}
