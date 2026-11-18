// 入口检查：部署前跑要部署的那个提交里的 ops/check-instance-entries.sh——有入口没带 HH_CONFIG（上线后在启动检查处直接退出）就不部署。
// 看守只看 hhd 起没起来，漏掉一个入口 hhd 照样起，所以要在部署这一步拦。
// 脚本取自共享仓库里要部署的那个提交的 git 对象，当 bash -c 的文本跑：不读检查克隆（runChecks 放了锁以后，别的检查随时可能把它切到别的提交），
// 不读线上（那是旧提交的），也不写文件。守门工具那边也这么跑。
// 放过它只有一条路：守门工具在另一个账号下写的跳过记录（<守门目录>/entry-skips/<完整提交>.json），她写不了；没有开关、没有环境变量。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trusted } from "./approvals.ts";
import type { Runner } from "./check.ts";
import { git, lsTree } from "./git.ts";
import { R } from "../lang/index.ts";

/** 提交里的路径（git 的写法） */
export const ENTRY_SCRIPT = "ops/check-instance-entries.sh";
// 当文本跑时脚本的 $0（脚本本来就能不靠文件路径跑：bash -s 也是这样）
const ARGV0 = "check-instance-entries";
// 脚本只读、路径全从 HOME 和绝对路径来，用不着工作目录：放在 / 下跑——不是谁的仓库、谁也不往里写，相对路径和 PATH 里的空项都捡不到东西
const CWD = "/";

export interface EntrySkip { by: string; why: string }
export type EntryResult = { ok: true; note?: string; skip?: EntrySkip } | { ok: false; text: string };

/** 脚本输出里某一种标记（红 / 看 / 绿 / 跳）的行：每一项是那一行，加上紧跟在它下面、四个空格开头的凭据行 */
export function entryRows(out: string, mark: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] | null = null;
  for (const line of out.split("\n")) {
    if (cur && line.startsWith("    ")) { cur.push(line); continue; }
    cur = null;
    if (line.startsWith(`${mark}  `)) { cur = [line]; rows.push(cur); }
  }
  return rows;
}

// 回复里列太多没人看得完：列到 max 行，说一声后面还剩几行
function clip(lines: string[], max: number): string {
  if (lines.length <= max) return lines.join("\n");
  return [...lines.slice(0, max), R.entries.entriesClipped(lines.length - max)].join("\n");
}

// 没判成时给她看的最后几行，原样（脚本只往一个流里写，同一句话不会出现两遍）
function tail(out: string, n: number): string {
  return out.trimEnd().split("\n").slice(-n).join("\n");
}

// 脚本判完（0 或 1）时最后一行印的标记。空的脚本、什么都没执行的 shell、跑到一半被截断的输出也会是 0 或 1，只是没有它
const DONE = /^entry-check: done red=(\d+) look=(\d+)$/;
function doneLine(out: string): { red: number; look: number } | null {
  const m = DONE.exec(out.trimEnd().split("\n").at(-1) ?? "");
  return m ? { red: Number(m[1]), look: Number(m[2]) } : null;
}

// 有红时脚本结论里的出路（怎么修、认得哪些写法、只是提到路径的文件怎么办）：她自己过不了红，出路只在这几行里，跟着红的行一起给她。
// 从最后一个「不能部署」开头的行到跑完的标记之前（判成红的输出，最后一行一定是那个标记）
function advice(out: string): string {
  const lines = out.trimEnd().split("\n");
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]?.startsWith("不能部署")) { at = i; break; }
  return at < 0 ? R.entries.entriesDefaultAdvice : lines.slice(at, -1).filter((l) => l.trim()).join("\n");
}

/** 守门工具留的跳过记录：守门目录、entry-skips、文件三层都得是她改不了的；写的就是这个完整提交，说了是谁、为什么。别的样子一律当没有 */
function skipRecord(guardDir: string, target: string, selfUid: number): EntrySkip | null {
  const dir = join(guardDir, "entry-skips");
  const file = join(dir, `${target}.json`);
  if (!trusted(guardDir, selfUid) || !trusted(dir, selfUid) || !trusted(file, selfUid)) return null;
  try {
    const rec = JSON.parse(readFileSync(file, "utf8")) as { sha?: unknown; by?: unknown; why?: unknown };
    if (rec.sha !== target || typeof rec.by !== "string" || !rec.by.trim() || typeof rec.why !== "string" || !rec.why.trim()) return null;
    return { by: rec.by, why: rec.why };
  } catch { return null; }
}

/** gitDir = 共享仓库，target 是完整的提交号。ok 带的 note 要进部署的回复和部署事件（「看」的几处不能只进日志没人看） */
export function entryCheck(o: { gitDir: string; guardDir: string; selfUid: number; target: string }, run: Runner): EntryResult {
  const skip = skipRecord(o.guardDir, o.target, o.selfUid);
  if (skip) return { ok: true, note: R.entries.entriesSkippedByWaiver(skip.by, skip.why), skip };
  let text: string | null;
  try {
    const blob = lsTree(o.gitDir, o.target).get(ENTRY_SCRIPT);
    // helper 只去掉最后一个换行，对脚本没影响
    text = blob ? git(o.gitDir, ["cat-file", "blob", blob]) : null;
  } catch (e) {
    // 读不出来也是拦下、记一条 refused，和别的结果一样留痕（不往外抛）
    return { ok: false, text: R.entries.entriesNotRun(String(e).slice(0, 300)) };
  }
  // 脚本进仓库以前的提交（或者删了它的）：没有可跑的
  if (text === null) return { ok: true, note: R.entries.entriesNoScript };
  const script = text;
  // -p：不读 BASH_ENV / ENV 指的文件，也不认环境里的 SHELLOPTS。不带的话，她环境里要是有个会往外写字的 BASH_ENV，bash 在脚本开始之前就先执行它——
  // 它写的字排在「跑完的标记」后面（或者它自己印一行标记就退出），每次部署不是被拒就是没判就放行
  const once = () => run("/bin/bash", ["-p", "-c", script, ARGV0], CWD);
  // 判出来的只有两种：0，最后一行是 red=0 的标记、也没有红的行；1，标记说 red ≥ 1、也真列出了红的行。
  // 别的（2、3；1 却没有红的行——被杀、超时、bash 自己死了，execRunner 都给 1；没有标记的 0，比如链接、空文本）可能只是一时的：再跑一次，第二次说了算
  const verdict = (r: { code: number; out: string }): "pass" | "red" | null => {
    const done = doneLine(r.out);
    const red = entryRows(r.out, R.entries.entriesRowMarkRed).length;
    if (r.code === 0 && done?.red === 0 && red === 0) return "pass";
    if (r.code === 1 && done && done.red >= 1 && red > 0) return "red";
    return null;
  };
  let r = once();
  let v = verdict(r);
  if (!v) { r = once(); v = verdict(r); }
  if (v === "pass") {
    const look = entryRows(r.out, R.entries.entriesRowMarkLook);
    return look.length ? { ok: true, note: R.entries.entriesNeedLook(look.length, clip(look.flat(), 30)) } : { ok: true };
  }
  if (v === "red") {
    const red = entryRows(r.out, R.entries.entriesRowMarkRedAtRejection);
    return { ok: false, text: R.entries.entriesRedRejected(red.length, clip(red.flat(), 20), advice(r.out)) };
  }
  return { ok: false, text: R.entries.entriesUndecided(r.code, tail(r.out, 10)) };
}
