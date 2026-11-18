// 提案快照、实际改了什么、恢复、变更记录。纯模块，文件读写由调用方注入。
import { createHash } from "node:crypto";
import type { Layer } from "./bank.ts";

/**
 * 最小文件接口。路径都是绝对路径（root 是 proposed/ 的绝对目录）。
 * - read：不存在返回 null
 * - write：写入（必要时建上级目录）
 * - remove：删除，不存在不报错
 * - list(dir)：只列 dir 直接下面的条目名（不是路径），目录不存在返回 []
 * - isDir(p)：p 是目录返回 true（list 靠它区分文件和目录）
 */
export interface MiniFs {
  read(p: string): string | null;
  write(p: string, s: string): void;
  remove(p: string): void;
  list(dir: string): string[];
  isDir(p: string): boolean;
}

/** key = 相对 proposed/ 的路径（正斜杠）；null = 不存在 */
export type Snapshot = Map<string, { sha: string; text: string } | null>;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 递归列出 root 下所有文件，返回相对路径。 */
export function proposedFiles(root: string, fs: MiniFs): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const dir = rel ? `${root}/${rel}` : root;
    for (const name of fs.list(dir)) {
      const r = rel ? `${rel}/${name}` : name;
      if (fs.isDir(`${root}/${r}`)) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out;
}

/** 抓 root 下所有在 scope 内、现存的文件。不在快照里的 key 等同于不存在。 */
export function snapshot(root: string, scope: (path: string) => boolean, fs: MiniFs): Snapshot {
  const snap: Snapshot = new Map();
  for (const p of proposedFiles(root, fs)) {
    if (!scope(p)) continue;
    const text = fs.read(`${root}/${p}`);
    if (text !== null) snap.set(p, { sha: sha(text), text });
  }
  return snap;
}

/** 按 key 的并集比较（缺的 key 当作不存在），同一个 scope 取的两份快照直接比。 */
export function diff(before: Snapshot, after: Snapshot): Array<{ path: string; op: "add" | "change" | "remove" }> {
  const out: Array<{ path: string; op: "add" | "change" | "remove" }> = [];
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(path) ?? null;
    const a = after.get(path) ?? null;
    if (!b && a) out.push({ path, op: "add" });
    else if (b && !a) out.push({ path, op: "remove" });
    else if (b && a && b.sha !== a.sha) out.push({ path, op: "change" });
  }
  return out;
}

/**
 * 让 scope 内的文件等于快照 to：不同的写回，现存但快照里没有（或为 null）的删掉。
 * scope 外的文件一律不碰（并行阶段、前面阶段的提案）。
 */
export function restore(root: string, to: Snapshot, scope: (path: string) => boolean, fs: MiniFs): void {
  for (const p of proposedFiles(root, fs)) {
    if (scope(p) && !to.get(p)) fs.remove(`${root}/${p}`);
  }
  for (const [p, v] of to) {
    if (!v || !scope(p)) continue;
    if (fs.read(`${root}/${p}`) !== v.text) fs.write(`${root}/${p}`, v.text);
  }
}

export interface Change {
  target: string; op: string; before: string; after: string; evidence: string[]; why: string;
  /** 这条改动会影响哪些题（出题和考试靠它挑题） */
  affects?: Array<{ q: string; layer: Layer }>;
}

export interface StageRecord {
  day: string;
  stage: string;
  attempt: number;
  status: "done" | "nothing" | "blocked";
  blockedWhy?: string;
  changes: Change[];
  report: string;
  uncertain: string[];
  proposals: string[];
  bugs: string[];
  actual: { files: ReturnType<typeof diff>; memOps: number };
}

/** 工作区相对路径；第 1 次 `<stage>.json`，第 n≥2 次 `<stage>.<n>.json`。 */
export function recordPath(day: string, stage: string, attempt: number): string {
  return `sleep/${day}/flow/${stage}${attempt >= 2 ? `.${attempt}` : ""}.json`;
}
