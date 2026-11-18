// 笔记本的编号：页和教训各有一个 HH 发的稳定编号，写在行尾的注释里（格式见 notebook.ts）。
// 她新写的页和教训没有号，扫描时补上；一行带几个号时后面的是并进来的旧号，记成别名。
// 写文件的原则：除了补的那段注释，一个字节也不动；她正在改的文件宁可这次不写；归档里的一律不写（原文原样留着）。
// Pages whose file lies off the shelf (a module's manuals, linked in from the HH code) are never written: their numbers
// are kept in the shelf's KEPT_IDS, and the table's row for the same path gives the number back when that file is lost.
import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { Db } from "../store/db.ts";
import { all, kvGet, kvSet, one } from "../store/db.ts";
import { KEPT_IDS, LESSON_ID, PAGE_ID, parsePage, scanShelf } from "./notebook.ts";
import type { Lesson, Page } from "./notebook.ts";
import { B } from "../lang/index.ts";

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");

/** 页的内容指纹：标题、简介、什么时候翻（不含编号注释） */
const pageHash = (p: Page): string => sha1(`${p.title}\n${p.brief}\n${p.when}`);

/** 教训的内容指纹：按固定写法把各字段拼回一行（不含编号注释，空白写法不同也算同一条） */
const lessonHash = (l: Lesson): string => {
  // Stored and compared (learn_id), never shown: the line is written in the page format itself (the labels of the role's language; the marks between them are fixed)
  const f = B.forms.page.lesson;
  return sha1(`${f.text}：${l.text}｜${f.when}：${l.when}｜${f.next}：${l.next}${l.done ? `｜${f.done}：${l.done}` : ""}${l.strength !== undefined ? `｜${f.strength}：${l.strength}` : ""}｜${f.days}：${l.days.join("、")}｜${f.sources}：${l.sources.map((n) => `#${n}`).join("、")}`);
};

/** 一个现在还在书架上的编号 */
interface Live {
  id: string;
  kind: "page" | "lesson";
  rel: string;
  hash: string;
  /** 行上排在它后面的旧编号 */
  aliases: string[];
  /** 这次因为重号换了号（抄出来的那份）：行上带的旧别名多半是跟着抄过来的 */
  renumbered: boolean;
}

/** 文件里标题行的下标（和 parsePage 认标题的规则一致：代码块外、第一个 ## 之前的第一个 # 行）；没有返回 -1 */
function titleLine(lines: string[]): number {
  let fence = false;
  for (let i = 0; i < lines.length; i += 2) {
    const line = i === 0 ? lines[0]!.replace(/^﻿/, "") : lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    if (line.startsWith("## ")) return -1;
    if (line.startsWith("# ")) return i / 2;
  }
  return -1;
}

/** 行尾补一段编号注释；已经有编号（重号）就只换第一个号，后面带的旧号原样 */
function stamp(line: string, re: RegExp, kind: "p" | "l", id: string, has: boolean): string {
  if (has) return line.replace(re, (whole, inner: string) => whole.replace(inner, inner.replace(/^[pl]:\d+/, `${kind}:${id}`)));
  return `${line}${/\s$/.test(line) ? "" : " "}<!-- ${kind}:${id} -->`;
}

/** 书架读不了的地方：这些路径下的条目这次看不见，不能因此标成没了 */
function blindSpots(problems: string[]): string[] {
  // 消息的写法在 notebook.ts 的 scanShelf 里
  return problems.flatMap((m) => {
    const hit = B.forms.shelfBlind.exec(m);
    return hit ? [hit[1]!] : [];
  });
}

/** 刚改过的文件等这么久再发号（她可能还在写）；白天书架变了，也等最近一次改动过了这么久再重扫 */
export const QUIET_MS = 120_000;

export function assignIds(
  root: string,
  db: Db,
  o: { now: () => number; generalCategory: string; archiveDir: string; quietMs?: number },
): { pages: number; lessons: number; skipped: string[]; aliases: number; renumbered?: string[] } {
  const out = { pages: 0, lessons: 0, skipped: [] as string[], aliases: 0 };
  /** 换过号的重复，如 "通用/验收/b.md p:0007→p:0012"；没有就不带这个字段 */
  const renumbered: string[] = [];
  const quietMs = o.quietMs ?? QUIET_MS;
  const t = o.now();
  // 书架整个读不了（没挂上、没权限）：什么都不动，别把全部条目标成没了
  try { readdirSync(root); } catch { return out; }
  const shelf = scanShelf(root, o.generalCategory, o.archiveDir);

  // 同一个号有几条在用（她拿旧页当模板抄新页，号一起抄过去了）：表里记着这个号的那条留号——同类、同一个文件优先，
  // 其次内容没变（挪了地方的）；表里没记过的按扫描顺序先到先得。活页在前、归档在后，和活页重号的号归活页。
  // 留号以外的都是重复，要换号。页和教训共用一个号码空间。
  // 扫描会跟着链接走，同一个文件可能从几条路径都走得到：只认先到的那条，别的路径既不占号也不改写，条目也只记一份
  const files = new Set<string>();
  const mirror = new Set<Page>();
  const fileOf = (rel: string): string => {
    try { return realpathSync(join(root, rel)); } catch { return join(root, rel); }
  };
  const claims = new Map<string, Array<{ x: Page | Lesson; kind: Live["kind"]; rel: string; hash: string; archived: boolean }>>();
  const claim = (x: Page | Lesson, kind: Live["kind"], p: Page, hash: string): void => {
    const id = x.ids[0];
    if (id !== undefined) claims.set(id, [...(claims.get(id) ?? []), { x, kind, rel: p.rel, hash, archived: p.archived }]);
  };
  for (const p of [...shelf.pages.filter((x) => !x.archived), ...shelf.pages.filter((x) => x.archived)]) {
    const file = fileOf(p.rel);
    if (files.has(file)) { mirror.add(p); continue; }
    files.add(file);
    claim(p, "page", p, pageHash(p));
    for (const l of p.lessons) claim(l, "lesson", p, lessonHash(l));
  }
  const dup = new Set<Page | Lesson>();
  for (const [id, cs] of claims) {
    if (cs.length < 2) continue;
    const was = one<{ kind: string; rel: string; hash: string }>(db, "SELECT kind, rel, hash FROM learn_item WHERE id = ?", id);
    const score = (c: (typeof cs)[number]): number =>
      c.archived ? -1 : !was || c.kind !== was.kind ? 0 : (c.rel === was.rel ? 2 : 0) + (c.hash === was.hash ? 1 : 0);
    const keep = cs.reduce((a, c) => (score(c) > score(a) ? c : a));
    for (const c of cs) if (c !== keep) dup.add(c.x);
  }
  const needs = (x: Page | Lesson): boolean => x.ids.length === 0 || dup.has(x);

  // 下一个号：kv 里记的、文件和表里见过的最大号（含别名）加一，取大的，保证不会发出已经在用的号
  let top = 0;
  const seen = (id: string): void => { const n = Number(id); if (Number.isSafeInteger(n) && n > top) top = n; };
  for (const p of shelf.pages) { p.ids.forEach(seen); p.lessons.forEach((l) => l.ids.forEach(seen)); }
  for (const r of all<{ id: string }>(db, "SELECT id FROM learn_item")) seen(r.id);
  for (const r of all<{ alias: string; id: string }>(db, "SELECT alias, id FROM learn_alias")) { seen(r.alias); seen(r.id); }
  const stored = Number(kvGet(db, "learn.next"));
  let next = Math.max(Number.isSafeInteger(stored) && stored > 0 ? stored : 1, top + 1);
  const issue = (): string => String(next++).padStart(4, "0");

  /** 补号/换号写回一个页文件；成功返回每条拿到的新号，没写返回 undefined（该记 skipped 的已经记了） */
  const rewrite = (p: Page): Map<Page | Lesson, string> | undefined => {
    const file = join(root, p.rel);
    const start = next;
    let tmp: string | undefined;
    try {
      const real = realpathSync(file); // 链接的文件改链接指向的那份，不把链接换成普通文件
      const before = statSync(real);
      const buf = readFileSync(real);
      const text = buf.toString("utf8");
      // 不是合法 UTF-8 的文件，转一道再写回会改别的字节
      if (!Buffer.from(text, "utf8").equals(buf)) { out.skipped.push(p.rel); return undefined; }
      // 扫描之后到现在这个文件又变了：这次不碰
      const cur = parsePage(text, p.rel, o.generalCategory, o.archiveDir);
      const shape = (x: Page): string => JSON.stringify([x.ids, x.lessons.map((l) => [l.line, l.ids])]);
      if (shape(cur) !== shape(p)) { out.skipped.push(p.rel); return undefined; }

      // 偶数下标是行，奇数下标是换行符，join("") 能原样还原
      const parts = text.split(/(\r?\n)/);
      const edits: Array<{ x: Page | Lesson; at: number }> = [];
      if (needs(p)) {
        const at = titleLine(parts);
        if (at >= 0) edits.push({ x: p, at }); // 没有标题行的页放不下页号，只给教训编号
      }
      for (const l of p.lessons) if (needs(l)) edits.push({ x: l, at: l.line - 1 });
      if (edits.length === 0) return undefined;
      // 刚被改过（或时钟在将来）：等安静下来再写
      if (t - before.mtimeMs < quietMs) { out.skipped.push(p.rel); return undefined; }

      const got = new Map<Page | Lesson, string>();
      for (const { x, at } of edits) {
        const id = issue();
        got.set(x, id);
        const isPage = x === p;
        parts[at * 2] = stamp(parts[at * 2]!, isPage ? PAGE_ID : LESSON_ID, isPage ? "p" : "l", id, x.ids.length > 0);
      }
      const text2 = parts.join("");

      // 回头按解析器再读一遍：编号都在该在的地方，别的内容一点没变
      const want = (x: Page | Lesson): string => (got.has(x) ? [got.get(x)!, ...x.ids.slice(1)] : x.ids).join(" ");
      const after = parsePage(text2, p.rel, o.generalCategory, o.archiveDir);
      const same = after.ids.join(" ") === want(p) && pageHash(after) === pageHash(cur)
        && after.lessons.length === cur.lessons.length
        && after.lessons.every((l, i) => l.line === cur.lessons[i]!.line && l.ids.join(" ") === want(p.lessons[i]!) && lessonHash(l) === lessonHash(cur.lessons[i]!));
      if (!same) { next = start; out.skipped.push(p.rel); return undefined; }

      tmp = join(dirname(real), `.${basename(real)}.ids-${process.pid}.tmp`);
      const mode = before.mode & 0o7777;
      writeFileSync(tmp, text2, { mode });
      chmodSync(tmp, mode); // 不受 umask 影响
      try { chownSync(tmp, before.uid, before.gid); } catch { /* 不是同一个用户就算了 */ }
      // 写前再看一眼：读到现在之间她又动了，放弃这个文件
      const now2 = statSync(real);
      if (now2.mtimeMs !== before.mtimeMs || now2.size !== before.size) { next = start; out.skipped.push(p.rel); return undefined; }
      renameSync(tmp, real);
      tmp = undefined;
      for (const [x, id] of got) {
        const kind = x === p ? "p" : "l";
        if (x === p) out.pages += 1; else out.lessons += 1;
        if (x.ids.length > 0) renumbered.push(`${p.rel} ${kind}:${x.ids[0]}→${kind}:${id}`);
      }
      return got;
    } catch {
      next = start;
      out.skipped.push(p.rel);
      return undefined;
    } finally {
      if (tmp) { try { unlinkSync(tmp); } catch { /* 已经没了 */ } }
    }
  };

  /** A page off the shelf gets a number without its file being touched: the one the table had for its path, else a new one. Its lessons get none */
  const shelfDir = realpathSync(root) + sep;
  const keep = (p: Page): Map<Page | Lesson, string> | undefined => {
    if (!needs(p)) return undefined;
    const was = one<{ id: string }>(db, "SELECT id FROM learn_item WHERE kind = 'page' AND rel = ? ORDER BY last_seen DESC LIMIT 1", p.rel)?.id;
    const id = was !== undefined && !claims.has(was) ? was : issue();
    out.pages += 1;
    if (p.ids.length) renumbered.push(`${p.rel} p:${p.ids[0]}→p:${id}`);
    return new Map([[p, id]]);
  };
  const kept: Record<string, string> = {};

  // 逐页处理，攒下现在还在的编号
  const live: Live[] = [];
  for (const p of shelf.pages) {
    if (mirror.has(p)) continue;
    const off = !fileOf(p.rel).startsWith(shelfDir);
    // 归档的不发号、不换号：已有的号照认（整页挪进去的），没号的就没号，和活页重号的号归活页
    const todo = !p.archived && (needs(p) || p.lessons.some(needs));
    const got = !todo ? undefined : off ? keep(p) : rewrite(p);
    // 没写成的：没号的这次还没号，重号的那一份不算它的（号归留号的那条）
    const idOf = (x: Page | Lesson): string | undefined => got?.get(x) ?? (needs(x) ? undefined : x.ids[0]);
    const pid = idOf(p);
    if (pid && off && !p.archived) kept[p.rel] = pid;
    if (pid) live.push({ id: pid, kind: "page", rel: p.rel, hash: pageHash(p), aliases: p.ids.slice(1), renumbered: dup.has(p) });
    for (const l of p.lessons) {
      const id = idOf(l);
      if (id) live.push({ id, kind: "lesson", rel: p.rel, hash: lessonHash(l), aliases: l.ids.slice(1), renumbered: dup.has(l) });
    }
  }

  const blind = blindSpots(shelf.problems);
  const alive = new Set(live.map((x) => x.id));
  /** 这次扫到的页文件；没扫到、文件却还在的（扫描没走到那个目录：大类里多了 SKILL.md、本没了封面……）不能标成没了 */
  const scanned = new Set(shelf.pages.map((p) => p.rel));
  db.exec("BEGIN");
  try {
    const upsert = db.prepare(
      `INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen, gone) VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, rel = excluded.rel, hash = excluded.hash, last_seen = excluded.last_seen, gone = NULL`,
    );
    for (const x of live) upsert.run(x.id, x.kind, x.rel, x.hash, t, t);

    // 不在书架上了：标 gone，行留着。只有两种算没了：文件扫到了但这一条不在里面，或者文件已经不在原处
    const markGone = db.prepare("UPDATE learn_item SET gone = ? WHERE id = ?");
    for (const r of all<{ id: string; rel: string }>(db, "SELECT id, rel FROM learn_item WHERE gone IS NULL")) {
      if (alive.has(r.id) || blind.some((b) => r.rel === b || r.rel.startsWith(`${b}/`))) continue;
      if (!scanned.has(r.rel) && existsSync(join(root, r.rel))) continue;
      markGone.run(t, r.id);
    }

    // 别名：行上排在后面的旧号 → 这一行自己的号。活着的号不当别名；指向被并掉那个号的旧别名跟着改指
    const drop = db.prepare("DELETE FROM learn_alias WHERE alias = ?");
    for (const id of alive) drop.run(id);
    const put = db.prepare("INSERT INTO learn_alias (alias, id, at) VALUES (?, ?, ?) ON CONFLICT(alias) DO UPDATE SET id = excluded.id");
    const follow = db.prepare("UPDATE learn_alias SET id = ? WHERE id = ?");
    const done = new Set<string>();
    // 没换号的先登记：抄出来的那份行上带着原来那页的旧别名，别名还归原来那页
    for (const x of [...live.filter((y) => !y.renumbered), ...live.filter((y) => y.renumbered)]) {
      for (const a of x.aliases) {
        if (a === x.id || alive.has(a) || done.has(a)) continue;
        done.add(a);
        if (one<{ id: string }>(db, "SELECT id FROM learn_alias WHERE alias = ?", a)?.id !== x.id) { put.run(a, x.id, t); out.aliases += 1; }
        out.aliases += Number(follow.run(x.id, a).changes);
      }
    }

    if (kvGet(db, "learn.next") !== String(next)) kvSet(db, "learn.next", String(next));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const keptFile = join(root, KEPT_IDS);
  const keptText = Object.keys(kept).length ? `${JSON.stringify(kept, null, 2)}\n` : "";
  let had = "";
  try { had = readFileSync(keptFile, "utf8"); } catch { /* none yet */ }
  if (keptText !== had) {
    if (!keptText) unlinkSync(keptFile);
    else { writeFileSync(`${keptFile}.tmp`, keptText); renameSync(`${keptFile}.tmp`, keptFile); }
  }
  return renumbered.length > 0 ? { ...out, renumbered } : out;
}

/** 旧编号 → 现在的编号；不是别名原样返回 */
export function resolveId(db: Db, id: string): string {
  return one<{ id: string }>(db, "SELECT id FROM learn_alias WHERE alias = ?", id)?.id ?? id;
}

/**
 * 所有认的编号：还在书架上的，加上指向它们的别名（指向的那条没了，别名也不认，不然闸门会一直拦着已经删掉的东西）。
 * sleep_apply 的编号闸门用它（hh learn ids）
 */
export function knownIds(db: Db): Set<string> {
  const rows = [
    ...all<{ id: string }>(db, "SELECT id FROM learn_item WHERE gone IS NULL"),
    ...all<{ id: string }>(db, "SELECT a.alias AS id FROM learn_alias a JOIN learn_item i ON i.id = a.id WHERE i.gone IS NULL"),
  ];
  return new Set(rows.map((r) => r.id));
}
