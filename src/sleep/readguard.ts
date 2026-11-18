// 考试会话的读拦截（spec §8.3「考生只带基础人格」）：考生、判分、出暗题的只能读工作区里的东西，
// 而且不能读今晚的整理（sleep/）、答案从注入里给的那几个文件（它们的旧版本）、配置 exam.hide 点名的（比如拼好的人格文件、备份）。
// 路径先弄到底再比：~ 展开、最长的存在的那一截 realpath（链接、/System/Volumes/Data 这类别名都归到真路径），
// macOS 上不分大小写（文件系统也不分）。Glob 只给名字：装着不让读的文件的目录照列，直接指着不让读的才拦；
// Grep 会读到内容：装着不让读的目录也拦。
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { P } from "../lang/index.ts";
import { matchWrites } from "./flow.ts";

const DATA_VOLUME = "/System/Volumes/Data";
const WILD = /[*?[\]{}]/;
const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

/** 最长的存在的那一截 realpath，后面照原样接上 */
function canonical(p: string): string {
  const tail: string[] = [];
  let head = p;
  for (;;) {
    try {
      const real = realpathSync.native(head);
      return tail.length ? join(real, ...tail.reverse()) : real;
    } catch {
      const up = dirname(head);
      if (up === head) return p;
      tail.push(basename(head));
      head = up;
    }
  }
}

/** rel 在 base 里面（或者就是它）；都是相对工作区、用 / 分隔的路径，"" 是工作区本身 */
const inside = (base: string, rel: string): boolean => base === "" || rel === base || rel.startsWith(`${base}/`);

/** 通配前面那一截里的目录（"soul/*.bak-*" → "soul"，"SOUL*.md" → ""） */
const fixedDir = (pattern: string): string => {
  const i = pattern.search(WILD);
  const fixed = i < 0 ? pattern : pattern.slice(0, i);
  const cut = fixed.lastIndexOf("/");
  return cut < 0 ? "" : fixed.slice(0, cut);
};

export interface ReadGuardOpts {
  workspace: string;
  /** 不让读的（相对工作区；文件或目录）：答案从注入里给的那几个文件。sleep/ 总是不让读 */
  hide: string[];
  /** 配置 exam.hide 的通配（相对工作区，matchWrites 的写法） */
  patterns: string[];
  /** 测试用；不给是这台机器的 */
  platform?: string;
  home?: string;
}

/** 考试会话的 Read / Grep / Glob 拦截：返回字符串就拦（字符串是理由） */
export function examReadGuard(o: ReadGuardOpts): (tool: string, input: Record<string, unknown>) => string | undefined {
  const darwin = (o.platform ?? process.platform) === "darwin";
  const home = o.home ?? homedir();
  const fold = (s: string): string => { const n = s.normalize("NFC"); return darwin ? n.toLowerCase() : n; };
  const real = (abs: string): string => {
    let c = canonical(abs);
    if (darwin && c.startsWith(`${DATA_VOLUME}/`)) c = c.slice(DATA_VOLUME.length);
    return fold(c);
  };
  const W = resolve(o.workspace);
  const roots = { real: real(W), plain: fold(W) };
  /** 相对工作区的路径（真路径、字面上的各算一个）；在工作区外面给 null */
  const relTo = (base: string, p: string): string | null => {
    const r = relative(base, p);
    return r === ".." || r.startsWith("../") || isAbsolute(r) ? null : r;
  };
  /** 要读的路径：~ 展开，相对路径按工作区算 */
  const absOf = (raw: string): string => resolve(W, raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw);
  const locate = (raw: string): { real: string | null; plain: string | null } => {
    const abs = absOf(raw);
    return { real: relTo(roots.real, real(abs)), plain: relTo(roots.plain, fold(abs)) };
  };
  const hidden = [...new Set(["sleep/", ...o.hide])].map((h) => ({ name: h, ...locate(h) }));
  const patterns = o.patterns.map((p) => ({ name: p, glob: fold(p), dir: fold(fixedDir(p)), deep: p.includes("**") }));
  const forms = (x: { real: string | null; plain: string | null }): string[] => [...new Set([x.real, x.plain].filter((r): r is string => r !== null))];

  /** x 本身不让读（是不让读的文件、在不让读的目录里、对得上 exam.hide）：给出是哪一条 */
  const hiddenAt = (x: { real: string | null; plain: string | null }): string | null => {
    for (const r of forms(x)) {
      for (const h of hidden) if (forms(h).some((hr) => hr !== "" && inside(hr, r))) return h.name;
      for (const p of patterns) if (r !== "" && matchWrites([p.glob], r)) return p.name;
    }
    return null;
  };
  /** x 是装着不让读的东西的目录（搜它会读到它们） */
  const holding = (x: { real: string | null; plain: string | null }): string | null => {
    for (const r of forms(x)) {
      for (const h of hidden) if (forms(h).some((hr) => inside(r, hr))) return h.name;
      for (const p of patterns) if (inside(r, p.dir) || (p.deep && inside(p.dir, r))) return p.name;
    }
    return null;
  };

  return (tool, input) => {
    if (tool === "Read") {
      const raw = str(input.file_path);
      if (!raw) return undefined;
      const x = locate(raw);
      if (x.real === null) return P.EXAM_READ_OUTSIDE;
      const h = hiddenAt(x);
      return h ? P.EXAM_READ_HIDDEN(h) : undefined;
    }
    const raw = str(input.path);
    if (!raw) return P.EXAM_SEARCH_NEEDS_PATH;
    const x = locate(raw);
    if (x.real === null) return P.EXAM_READ_OUTSIDE;
    const h = hiddenAt(x) ?? (tool === "Grep" ? holding(x) : null);
    if (h) return P.EXAM_READ_HIDDEN(h);
    if (tool !== "Glob") return undefined;
    // Glob 只给名字，装着不让读的照列；通配前面那一截直接指着不让读的（或者指出工作区）才拦
    const pattern = str(input.pattern);
    const parts = pattern.split("/");
    const lead = parts.findIndex((s) => WILD.test(s));
    const fixed = (lead < 0 ? parts : parts.slice(0, lead)).join("/");
    if (!fixed) return undefined;
    const t = locate(resolve(absOf(raw), fixed));
    if (t.real === null) return P.EXAM_READ_OUTSIDE;
    const th = hiddenAt(t);
    return th ? P.EXAM_READ_HIDDEN(th) : undefined;
  };
}
