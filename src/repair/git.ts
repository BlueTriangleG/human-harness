// 用 git 命令行读提交：改了哪些文件、加删了哪些行、说明尾巴上的 Fix / Verified-by 这些。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { CommitInfo, FileChange } from "./gate.ts";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(dir: string, args: string[], input?: string, env?: NodeJS.ProcessEnv): string {
  try {
    const out = execFileSync("git", ["-C", dir, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"], ...(input !== undefined ? { input } : {}), ...(env ? { env: { ...process.env, ...env } } : {}) });
    return out.replace(/\n$/, "");
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new Error(`git ${args.join(" ")}: ${(err.stderr || err.message).trim().slice(0, 500)}`);
  }
}

export function parseTrailers(message: string): Record<string, string> {
  const paras = message.trim().split(/\n\s*\n/);
  const last = paras.length > 1 ? paras[paras.length - 1] ?? "" : "";
  const out: Record<string, string> = {};
  for (const line of last.split("\n")) {
    const m = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(line.trim());
    if (m?.[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

export function commitInfo(dir: string, sha: string): CommitInfo {
  const full = git(dir, ["rev-parse", `${sha}^{commit}`]);
  const subject = git(dir, ["log", "-1", "--format=%s", full]);
  const message = git(dir, ["log", "-1", "--format=%B", full]);
  let parent = EMPTY_TREE;
  try { parent = git(dir, ["rev-parse", `${full}^`]); } catch { /* 第一个提交 */ }
  const files = new Map<string, FileChange>();
  // -z：路径原样（中文名不被转义）；属性里的 -diff / textconv 也藏不住改动
  const ns = git(dir, ["diff", "-M", "-z", "--no-ext-diff", "--no-textconv", "--name-status", parent, full]).split("\0");
  for (let i = 0; i < ns.length - 1;) {
    const st = ns[i++] ?? "";
    const status = st[0] ?? "M";
    if (status === "R" || status === "C") {
      const a = ns[i++] ?? "", b = ns[i++] ?? "";
      files.set(b, { path: b, oldPath: a, status: "R", added: 0, deleted: 0, addedLines: [], removedLines: [] });
    } else {
      const a = ns[i++] ?? "";
      if (a) files.set(a, { path: a, status: status === "A" || status === "D" ? status : "M", added: 0, deleted: 0, addedLines: [], removedLines: [] });
    }
  }
  let current: FileChange | undefined;
  let minus: string | null = null;
  let inHunk = false;
  for (const line of git(dir, ["diff", "-M", "-U0", "-a", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", parent, full]).split("\n")) {
    if (line.startsWith("diff --git ")) { current = undefined; minus = null; inHunk = false; continue; }
    if (!inHunk) {
      if (line.startsWith("--- a/")) minus = line.slice(6);
      else if (line.startsWith("+++ b/")) current = files.get(line.slice(6));
      else if (line === "+++ /dev/null" && minus) current = files.get(minus);
      else if (line.startsWith("@@")) inHunk = true;
      continue;
    }
    if (line.startsWith("@@")) continue;
    if (!current) continue;
    if (line.startsWith("+")) { current.addedLines.push(line.slice(1)); current.added += 1; }
    else if (line.startsWith("-")) { current.removedLines.push(line.slice(1)); current.deleted += 1; }
  }
  return { sha: full, subject, trailers: parseTrailers(message), files: [...files.values()] };
}

/** from..to 之间的提交，老的在前（只走第一父链：共享 master 只快进） */
export function revList(dir: string, from: string, to: string): string[] {
  const out = git(dir, ["rev-list", "--reverse", "--first-parent", `${from}..${to}`]);
  return out ? out.split("\n") : [];
}

export function isAncestor(dir: string, a: string, b: string): boolean {
  try { git(dir, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; }
}

/** 一个提交里所有文件：路径 → blob hash */
export function lsTree(dir: string, sha: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(dir, ["ls-tree", "-r", "-z", sha]).split("\0").filter(Boolean)) {
    const tab = line.indexOf("\t");
    const meta = line.slice(0, tab).split(" ");
    if (meta[1] === "blob" && meta[2]) out.set(line.slice(tab + 1), meta[2]);
  }
  return out;
}

/** 和 git hash-object 一样的 blob hash */
export function blobSha(content: Buffer): string {
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
}
