// 控制台的记忆数据：全部只读。
// - 一页一页：epochs + central 的统计 + 每页压成的那段（blocks）
// - 前缀：每个脑区都带着的（运行说明 + 人格文件 + 这次醒来以后的压缩记忆）
// - 长期记忆：她 workspace 里的记忆文件（每晚 02:30 整理进去的）
// - 回想：她翻原话的记录
import type { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { estimateTokens } from "../memory/tokens.ts";
import { OPENINGS_DIR, OPENINGS_KEEP } from "../sleep/wake.ts";
import { say } from "./lang/index.ts";
import type { Key } from "./lang/index.ts";
import type { MemoryPageConfig } from "../config.ts";
import { notFoundShapes } from "./packtext.ts";

export interface Limits { pageTokens: number; maxContextTokens: number; sleepyAtTokens: number; mustSleepAtTokens: number }

export type PageEnd = "page-turn" | "sleep" | "restart" | "current";

export interface Page {
  id: number;
  started: number;
  reason: string;
  firstSeq: number;
  rows: number;
  tokens: number;           // 和 hhd 算翻页一样：下意识自己的过程不算
  firstTs: number | null;
  lastTs: number | null;
  end: PageEnd;
  block: { id: number; tokens: number; created: number; cleared: number | null } | null;
}

const NOT_INNER = `(meta IS NULL OR meta NOT LIKE '%"inner":true%')`;

/** 最近 limit 页，从早到晚 */
export function pages(db: DatabaseSync, limit = 60, now = Date.now()): Page[] {
  const eps = (db.prepare("SELECT id, started, reason, first_seq FROM epochs ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; started: number; reason: string; first_seq: number }>).reverse();
  const stats = pageStats(db, now);
  const blocks = new Map<number, { id: number; tokens: number; created: number; cleared: number | null }>();
  for (const b of db.prepare("SELECT id, epoch, created, tokens, cleared FROM blocks ORDER BY id").all() as Array<{ id: number; epoch: number; created: number; tokens: number; cleared: number | null }>) {
    if (!blocks.has(Number(b.epoch))) blocks.set(Number(b.epoch), { id: Number(b.id), tokens: Number(b.tokens), created: Number(b.created), cleared: b.cleared === null ? null : Number(b.cleared) });
  }
  return eps.map((e, i) => {
    const next = eps[i + 1];
    const s = stats.get(Number(e.id));
    const end: PageEnd = !next ? "current" : next.reason === "page-turn" ? "page-turn" : next.reason === "wake" ? "sleep" : "restart";
    return {
      id: Number(e.id), started: Number(e.started), reason: e.reason, firstSeq: Number(e.first_seq),
      rows: Number(s?.n ?? 0), tokens: Number(s?.t ?? 0), firstTs: s ? Number(s.a) : null, lastTs: s ? Number(s.b) : null,
      end, block: blocks.get(Number(e.id)) ?? null,
    };
  });
}

/*
 * 中央记忆几百兆、十几万行。每一行写下以后 tokens、ts、meta 都不再变，也不删；只有翻页时最后那一小截的行会改页号
 * （central.ts 的 UPDATE central SET epoch … WHERE seq > …）。所以这两个统计不用每次把整张表读一遍：
 * 读一遍在机器忙的时候要十来秒，控制台是单线程的，这十来秒里别的请求全等着。
 * 做法：同一个连接上记着上次数到哪；老的页（比最新的页早三页以上）数过就不再数，最近三页每次重数；
 * 总数按 seq 接着往后数。每 10 分钟整张重数一次兜底。数出来的和整张现数的一样（测试对过）。
 */
const FULL_RECOUNT_MS = 10 * 60_000;
/** 最近几页每次重数（翻页改页号只动最新那一页尾巴上的行，留三页的余量） */
const RECENT_PAGES = 3;
interface PageStat { n: number; t: number; a: number; b: number }
const pageStatsCache = new WeakMap<DatabaseSync, { full: number; frozenBelow: number; stats: Map<number, PageStat> }>();
function pageStats(db: DatabaseSync, now: number): Map<number, PageStat> {
  const top = Number((db.prepare("SELECT COALESCE(MAX(epoch), 0) AS e FROM central").get() as { e: number }).e);
  let c = pageStatsCache.get(db);
  if (!c || now - c.full >= FULL_RECOUNT_MS || now < c.full) { c = { full: now, frozenBelow: -Infinity, stats: new Map() }; pageStatsCache.set(db, c); }
  const from = c.frozenBelow === -Infinity ? null : c.frozenBelow;
  const rows = db.prepare(
    `SELECT epoch, COUNT(*) AS n, COALESCE(SUM(CASE WHEN ${NOT_INNER} THEN tokens ELSE 0 END), 0) AS t, MIN(ts) AS a, MAX(ts) AS b FROM central${from === null ? "" : " WHERE epoch >= ?"} GROUP BY epoch`,
  ).all(...(from === null ? [] : [from])) as Array<{ epoch: number; n: number; t: number; a: number; b: number }>;
  // 这次重数的那几页：先把旧的数拿掉（一页的行全挪走了，就不该再留着它的数），再放新的
  for (const e of [...c.stats.keys()]) if (from === null || e >= from) c.stats.delete(e);
  for (const r of rows) c.stats.set(Number(r.epoch), { n: Number(r.n), t: Number(r.t), a: Number(r.a), b: Number(r.b) });
  c.frozenBelow = top - RECENT_PAGES + 1;
  return c.stats;
}

export interface BlockInfo { id: number; epoch: number; created: number; tokens: number; cleared: number | null; chars: number; preview: string }

/** 全部压缩记忆，最新的在前；cleared 不为空 = 睡觉整理过、已经不在前缀里了 */
export function blockList(db: DatabaseSync, limit = 40): BlockInfo[] {
  const rows = db.prepare("SELECT id, epoch, created, tokens, cleared, text FROM blocks ORDER BY id DESC LIMIT ?").all(limit) as Array<{ id: number; epoch: number; created: number; tokens: number; cleared: number | null; text: string }>;
  return rows.map((r) => ({
    id: Number(r.id), epoch: Number(r.epoch), created: Number(r.created), tokens: Number(r.tokens),
    cleared: r.cleared === null ? null : Number(r.cleared), chars: r.text.length,
    preview: r.text.replace(/\s+/g, " ").trim().slice(0, 140),
  }));
}

export function blockText(db: DatabaseSync, id: number): string | null {
  const r = db.prepare("SELECT text FROM blocks WHERE id = ?").get(id) as { text: string } | undefined;
  return r ? r.text : null;
}

export interface CentralTotals { rows: number; tokens: number; firstTs: number | null; lastTs: number | null; imported: number }

const totalsCache = new WeakMap<DatabaseSync, { full: number; seq: number; v: CentralTotals }>();
/** 中央记忆一共多少：从上次数到的 seq 接着往后数（道理见上面 pageStats 那段说明） */
export function centralTotals(db: DatabaseSync, now = Date.now()): CentralTotals {
  let c = totalsCache.get(db);
  if (!c || now - c.full >= FULL_RECOUNT_MS || now < c.full) { c = { full: now, seq: 0, v: { rows: 0, tokens: 0, firstTs: null, lastTs: null, imported: 0 } }; totalsCache.set(db, c); }
  const r = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(tokens), 0) AS t, MIN(ts) AS a, MAX(ts) AS b, COALESCE(SUM(CASE WHEN meta LIKE '%"imported":true%' THEN 1 ELSE 0 END), 0) AS i, MAX(seq) AS s FROM central WHERE seq > ?`,
  ).get(c.seq) as { n: number; t: number; a: number | null; b: number | null; i: number; s: number | null };
  if (Number(r.n) > 0) {
    const a = Number(r.a), b = Number(r.b);
    c.v = {
      rows: c.v.rows + Number(r.n), tokens: c.v.tokens + Number(r.t),
      firstTs: c.v.firstTs === null ? a : Math.min(c.v.firstTs, a), lastTs: c.v.lastTs === null ? b : Math.max(c.v.lastTs, b),
      imported: c.v.imported + Number(r.i),
    };
    c.seq = Number(r.s);
  }
  return { ...c.v };
}

export interface RecallCall { seq: number; ts: number; src: string; tool: string; query: string; found: boolean | null }

/** 她自己去想的工具：翻原话（recall），和事件库的四种回想 */
export const RECALL_TOOLS = ["recall", "remember", "recall_person", "recall_event", "recall_period"] as const;
/**
 * 各个回想工具「没想起来」时的回话：都从语言包里取来认（notFoundShapes）。
 * 这里另留着旧数据里的写法（中文包改过字以前记下的回话）
 */
const NOT_FOUND_OLD = /^(自己的记忆里没找到|没有 #|没想起和|不认识「|没有「|没有事件|没有原话|时间段看不懂)|记忆里还没有和.*有关的事|没有记下的事。$|还没有出现在哪件事里/;

/** 她最近自己去想的几次，以及想没想起来 */
export function recallCalls(db: DatabaseSync, limit = 12): RecallCall[] {
  const shapes = notFoundShapes();
  const notFound = (text: string): boolean => NOT_FOUND_OLD.test(text) || shapes.some((s) => s.test(text));
  const byMeta = RECALL_TOOLS.map((t) => `meta LIKE '%"tool":"${t}"%'`).join(" OR ");
  const byText = RECALL_TOOLS.map((t) => `text LIKE '${t} %'`).join(" OR ");
  const acts = db.prepare(
    `SELECT seq, ts, src, text, meta FROM central WHERE kind = 'act' AND (${byMeta} OR ${byText}) ORDER BY seq DESC LIMIT ?`,
  ).all(limit) as Array<{ seq: number; ts: number; src: string; text: string; meta: string | null }>;
  const findResult = db.prepare(`SELECT text FROM central WHERE kind = 'result' AND seq > ? AND meta LIKE ? ORDER BY seq LIMIT 1`);
  return acts.map((a) => {
    let id: string | null = null, tool: string | null = null;
    try {
      const m = a.meta ? (JSON.parse(a.meta) as { id?: unknown; tool?: unknown }) : null;
      id = typeof m?.id === "string" ? m.id : null;
      tool = typeof m?.tool === "string" ? m.tool : null;
    } catch { /* 坏的 meta 不管 */ }
    const name = tool ?? a.text.split(" ")[0] ?? "recall";
    const res = id ? (findResult.get(a.seq, `%"id":"${id.replace(/[%_"\\]/g, "")}"%`) as { text: string } | undefined) : undefined;
    const found = res ? !notFound(res.text.trim()) && res.text.trim() !== "" : null;
    return { seq: Number(a.seq), ts: Number(a.ts), src: a.src, tool: name, query: a.text.startsWith(name + " ") ? a.text.slice(name.length + 1) : a.text, found };
  });
}

// ---------- 文件 ----------

/** 前缀的一段。不是文件的那几段带一个代号 id（页面按它认是哪一段），name 只管显示（按看的人的语言）；block 的 n 是第几段 */
export interface PrefixPart { name: string; kind: "note" | "file" | "block"; id?: "runtime" | "shelf" | "frame" | "midterm" | "block"; n?: number; chars: number; tokens: number; key?: string; mtime?: number; missing?: boolean; blockId?: number }

/**
 * 前缀的组成（按现在磁盘上的文件算；她要等下次换班 / 翻页才读到新版本）。
 * 顺序照 buildPrefix：运行说明 → 人格文件 → 书架目录（learning.shelf 开了才有）→ 过渡句「你的人生」→ 记忆文件 → 中期视图（开了才有）→ 压缩记忆。
 */
export function prefixParts(
  workspace: string, files: readonly string[], runtimeNote: string, active: ReadonlyArray<{ id: number; tokens: number; chars: number }>,
  memory: { frame?: string; files?: ReadonlySet<string>; midterm?: string | null; shelf?: string | null } = {},
): PrefixPart[] {
  const parts: PrefixPart[] = [{ name: say("memory.prefixPart.runtime"), kind: "note", id: "runtime", chars: runtimeNote.length, tokens: estimateTokens(runtimeNote) }];
  const memFiles = memory.files ?? new Set<string>();
  const shelf = memory.shelf?.trim() ?? "";
  const ordered = [
    ...files.filter((f) => !memFiles.has(f)), ...(shelf ? ["\0shelf"] : []), ...(memory.frame ? ["\0frame"] : []), ...files.filter((f) => memFiles.has(f)),
  ];
  for (const f of ordered) {
    if (f === "\0shelf") { parts.push({ name: say("memory.prefixPart.shelf"), kind: "note", id: "shelf", chars: shelf.length, tokens: estimateTokens(shelf) }); continue; }
    if (f === "\0frame") { parts.push({ name: say("memory.prefixPart.frame"), kind: "note", id: "frame", chars: memory.frame!.length, tokens: estimateTokens(memory.frame!) }); continue; }
    const p = join(workspace, f);
    if (!existsSync(p)) { parts.push({ name: f, kind: "file", chars: 0, tokens: 0, key: `ws:${f}`, missing: true }); continue; }
    const text = readFileSync(p, "utf8");
    parts.push({ name: f, kind: "file", chars: text.length, tokens: estimateTokens(text), key: `ws:${f}`, mtime: statSync(p).mtimeMs });
  }
  // 中期视图（memory.events.midterm 开着才有）：排在记忆文件后面、压缩记忆前面，和 buildPrefix 一样
  if (memory.midterm?.trim()) parts.push({ name: say("memory.prefixPart.midterm"), kind: "note", id: "midterm", chars: memory.midterm.length, tokens: estimateTokens(memory.midterm) });
  active.forEach((b, i) => parts.push({ name: say("memory.prefixPart.block", { n: i + 1 }), kind: "block", id: "block", n: i + 1, chars: b.chars, tokens: b.tokens, blockId: b.id }));
  return parts;
}

export interface FileEntry { key: string; name: string; bytes: number; mtime: number }
export interface Area { key: string; label: string; dir: string; files: number; bytes: number; latest: number | null; list: FileEntry[] }

/** an area's label: the pack's name for that code, or the code itself when the pack has none */
function areaLabel(code: string): string {
  const key = `memory.area.${code}`;
  const text = say(key as Key);
  return text === key ? code : text;
}
/** hidden whatever the instance says */
const ALWAYS_HIDDEN = [".git", "node_modules"];

/** Not listed and not opened: what the instance's layout hides (guests' private files and the like), compared without case (APFS opens ledger/People/x.md as the same file). */
function excluded(relIn: string, l: MemoryPageConfig): boolean {
  const rel = relIn.toLowerCase();
  if ([...ALWAYS_HIDDEN, ...(l.hidden ?? [])].some((x) => rel === x.toLowerCase() || rel.startsWith(x.toLowerCase() + "/"))) return true;
  if ((l.only ?? []).some(([dir, keep]) => rel.startsWith(dir.toLowerCase()) && rel !== keep.toLowerCase())) return true;
  return (l.hiddenPatterns ?? []).some((re) => new RegExp(re).test(rel));
}

function walk(root: string, rel: string, depth: number, out: FileEntry[], l: MemoryPageConfig): void {
  const abs = join(root, rel);
  let names: string[];
  try { names = readdirSync(abs); } catch { return; }
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const r = rel ? `${rel}/${n}` : n;
    if (excluded(r, l)) continue;
    let st;
    try { st = lstatSync(join(root, r)); } catch { continue; }
    if (st.isSymbolicLink()) continue;          // 符号链接不跟（可能指到外面）
    if (st.isDirectory()) { if (depth > 0) walk(root, r, depth - 1, out, l); continue; }
    if (n.endsWith(".md")) out.push({ key: `ws:${r}`, name: r, bytes: st.size, mtime: st.mtimeMs });
  }
}

/** 长期记忆的各个区：几个文件、多大、最近什么时候改的 */
export function areas(workspace: string, l: MemoryPageConfig = {}): Area[] {
  const dirs: Array<[string, string]> = (l.areas ?? []).map(([dir, code]) => [dir, areaLabel(code)]);
  // the other sub-folders of l.restOf are listed too, under their own names
  if (l.restOf) {
    try {
      for (const n of readdirSync(join(workspace, l.restOf)).sort()) {
        if (n.startsWith(".")) continue;
        const r = `${l.restOf}/${n}`;
        if (excluded(r, l) || dirs.some(([d]) => d === r)) continue;
        try { if (statSync(join(workspace, r)).isDirectory()) dirs.push([r, n]); } catch { /* 跳过 */ }
      }
    } catch { /* no such folder */ }
  }
  const out: Area[] = [];
  for (const [dir, label] of dirs) {
    if (!existsSync(join(workspace, dir))) continue;
    const list: FileEntry[] = [];
    walk(workspace, dir, dir === l.restOf ? 0 : 3, list, l);
    list.sort((a, b) => b.mtime - a.mtime);
    if (!list.length) continue;               // 空目录不列
    out.push({
      key: dir, label, dir, files: list.length,
      bytes: list.reduce((s, f) => s + f.bytes, 0),
      latest: list.length ? list[0]!.mtime : null,
      list: list.slice(0, 200),
    });
  }
  return out;
}

/** 最近 sinceMs 以来改过的记忆文件（看昨晚整理动了哪些） */
export function recentlyChanged(all: Area[], files: readonly string[], workspace: string, sinceMs: number, limit = 40): FileEntry[] {
  const seen = new Map<string, FileEntry>();
  for (const a of all) for (const f of a.list) if (f.mtime >= sinceMs) seen.set(f.key, f);
  for (const f of files) {
    const p = join(workspace, f);
    try { const st = statSync(p); if (st.mtimeMs >= sinceMs) seen.set(`ws:${f}`, { key: `ws:${f}`, name: f, bytes: st.size, mtime: st.mtimeMs }); } catch { /* 没有就算了 */ }
  }
  return [...seen.values()].sort((a, b) => b.mtime - a.mtime).slice(0, limit);
}

export interface Organizer { lastDone: string | null; lastAppliedAt: string | null; runs: Array<{ day: string; report: string | null; mtime: number }> }

/** The nightly organizing (sleepDir = the instance's sleep.workDir): how far it got, the last few nights' reports */
export function organizer(workspace: string, sleepDir?: string): Organizer {
  if (!sleepDir) return { lastDone: null, lastAppliedAt: null, runs: [] };
  const dir = join(workspace, sleepDir);
  let lastDone: string | null = null, lastAppliedAt: string | null = null;
  try {
    const s = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { last_done?: unknown; last_applied_at?: unknown };
    lastDone = typeof s.last_done === "string" ? s.last_done : null;
    lastAppliedAt = typeof s.last_applied_at === "string" ? s.last_applied_at : null;
  } catch { /* 没有 state */ }
  const runs: Organizer["runs"] = [];
  try {
    for (const n of readdirSync(dir)) {
      if (!/^\d{4}-\d{2}-\d{2}/.test(n)) continue;
      const p = join(dir, n);
      try {
        const st = statSync(p);
        if (!st.isDirectory()) continue;
        runs.push({ day: n, report: existsSync(join(p, "report.md")) ? `ws:${sleepDir}/${n}/report.md` : null, mtime: st.mtimeMs });
      } catch { /* 跳过 */ }
    }
  } catch { /* 没有 sleep 目录 */ }
  runs.sort((a, b) => b.day.localeCompare(a.day));
  return { lastDone, lastAppliedAt, runs: runs.slice(0, 10) };
}

/** The skill manuals: the files under dir (the instance's skills.discover, relative to the workspace) */
export function skillsArea(workspace: string, dir: string | undefined, l: MemoryPageConfig = {}): Area | null {
  if (!dir || !existsSync(join(workspace, dir))) return null;
  const list: FileEntry[] = [];
  walk(workspace, dir, 3, list, l);
  list.sort((a, b) => b.mtime - a.mtime);
  return { key: dir, label: say("memory.area.skills"), dir, files: list.length, bytes: list.reduce((n, f) => n + f.bytes, 0), latest: list.length ? list[0]!.mtime : null, list: list.slice(0, 200) };
}

// ---------- 早上的开头：醒来那一页主线的开场存档 ----------
/** hhd 存的文件名：<她当地的日期>-<时分秒>.md（同 src/sleep/wake.ts 的 OPENING_FILE）。只认这样命名的，那个目录里别的一概不给 */
const OPENING_FILE = /^(\d{4}-\d{2}-\d{2})-(\d{2})(\d{2})(\d{2})\.md$/;

export interface WakeOpening { key: string; day: string; time: string; bytes: number; mtime: number }

/** 醒来那一页主线每次开场的存档（<stateDir>/wake，hhd 存的，留最新 14 份）：新的在前。day、time 是文件名里她当地的日子和时分 */
export function wakeOpenings(stateDir: string): WakeOpening[] {
  const dir = join(stateDir, OPENINGS_DIR);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: WakeOpening[] = [];
  for (const n of names) {
    const m = OPENING_FILE.exec(n);
    if (!m) continue;
    try {
      const st = lstatSync(join(dir, n));
      if (st.isFile()) out.push({ key: `wake:${n}`, day: m[1]!, time: `${m[2]}:${m[3]}`, bytes: st.size, mtime: st.mtimeMs });
    } catch { /* 跳过 */ }
  }
  return out.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0)).slice(0, OPENINGS_KEEP);
}

/**
 * 只给看记忆文件：ws: 下的人格文件和记忆目录里的 .md；wake: 下 hhd 存的早上的开头（状态目录里只给这一样，文件名对不上的不给）。
 * 不出根目录、不跟符号链接出去。
 */
export function readMemoryFile(key: string, roots: { workspace: string; stateDir?: string; files: readonly string[]; layout?: MemoryPageConfig }, maxBytes = 800_000): { text: string; bytes: number; mtime: number; clipped: boolean } | null {
  const m = /^(ws|wake):(.+)$/.exec(key);
  if (!m) return null;
  const ws = m[1] === "ws";
  const rel = m[2]!;
  if (rel.startsWith("/") || rel.split("/").some((p) => p === ".." || p === "" || p.startsWith(".")) || !rel.endsWith(".md")) return null;
  const l = roots.layout ?? {};
  if (ws && (excluded(rel, l) || !(roots.files.includes(rel) || (l.readable ?? []).some((d) => rel.startsWith(d))))) return null;
  if (!ws && (!roots.stateDir || !OPENING_FILE.test(rel))) return null;
  const root = ws ? roots.workspace : join(roots.stateDir!, OPENINGS_DIR);
  let realRoot: string, real: string;
  try { realRoot = realpathSync(root); real = realpathSync(join(root, rel)); } catch { return null; }
  if (!real.startsWith(realRoot + sep)) return null;
  // 符号链接指进不给看的地方：按真实路径再查一次
  if (ws && excluded(real.slice(realRoot.length + 1), l)) return null;
  const st = statSync(real);
  if (!st.isFile()) return null;
  const buf = readFileSync(real);
  const clipped = buf.length > maxBytes;
  return { text: buf.subarray(0, maxBytes).toString("utf8"), bytes: st.size, mtime: st.mtimeMs, clipped };
}
