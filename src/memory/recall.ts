// 想起原话：从中央记忆里按关键词 / 某一天 / 某一条前后找原话（不需要向量服务，所有原话都在这里）。
// 用法和她以前的 recall.py 一样：["search","一句话","--who","主人"] / ["day","2026-10-28"] / ["around","<序号>"]。
import type { PromptFolds } from "./folds.ts";
import type { Db } from "../store/db.ts";
import { all } from "../store/db.ts";
import { B, M, N, dateLocale } from "../lang/index.ts";

interface Row { seq: number; ts: number; src: string; kind: string; text: string; meta: string | null }

export interface RecallOpts { timezone: string; labels: (src: string) => string; limit?: number; full?: boolean; /** 进提示前折成一句（memory.promptFolds）：真人的话只换字，别的命中就整条换 */ folds?: PromptFolds }

function who(r: Row, label: (s: string) => string, unsent: ReadonlySet<number>): string {
  const meta = r.meta ? (JSON.parse(r.meta) as { from?: string; to?: string; name?: string; sent?: boolean }) : {};
  if (r.kind === "input") return M.recallCentral.said(meta.from);
  if (meta.sent) return M.recallCentral.sentTo(meta.name ?? meta.to);
  const verbs: Record<string, string> = M.recallCentral.verb;
  const verb = verbs[r.kind] ?? r.kind;
  return `${label(r.src)}${verb}${r.kind === "say" && unsent.has(r.seq) ? M.recallCentral.unsent : ""}`;
}

/** 「上面这段没发给任何人」是 HH 记的标记行（brain.ts 回合结束时），不当原话翻出来；它说的那几段话标（没发出去） */
const NOT_MARK = `(meta IS NULL OR meta NOT LIKE '%"unsent":true%')`;
function unsentSays(db: Db, rows: Row[]): Set<number> {
  const out = new Set<number>();
  const says = rows.filter((r) => r.kind === "say").map((r) => r.seq);
  if (!says.length) return out;
  // 标记行记在那一轮结束时，紧跟在那段话后面（中间最多隔着别的脑区同时记的几条）
  const marks = all<{ meta: string }>(db, `SELECT meta FROM central WHERE kind = 'note' AND seq > ? AND seq <= ? AND meta LIKE '%"unsent":true%'`,
    Math.min(...says), Math.max(...says) + 500);
  for (const m of marks) {
    try { for (const s of (JSON.parse(m.meta) as { of?: unknown[] }).of ?? []) out.add(Number(s)); } catch { /* 坏行跳过 */ }
  }
  return out;
}

/** recall 的一行进提示前过折叠表：真人的话（meta.human）只换字，别的命中就整条换 */
function foldRow(r: Row, folds: PromptFolds): Row {
  let human = false;
  try { human = r.kind === "input" && (JSON.parse(r.meta ?? "{}") as { human?: unknown }).human === true; } catch { /* 坏行当不是 */ }
  const text = human ? folds.words(r.text, r.ts) : folds.whole(r.text, r.ts);
  return text === r.text ? r : { ...r, text };
}

function fmt(db: Db, rows: Row[], o: RecallOpts): string {
  if (!rows.length) return "";
  const unsent = unsentSays(db, rows);
  const t = new Intl.DateTimeFormat(dateLocale(), { timeZone: o.timezone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  return rows.map((r0) => {
    const r = o.folds && !o.folds.empty ? foldRow(r0, o.folds) : r0;
    return M.recallCentral.line(r.seq, t.format(r.ts), who(r, o.labels, unsent), !o.full && r.text.length > 600 ? r.text.slice(0, 600) + M.recallCentral.cut : r.text);
  }).join("\n");
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

/** 某人相关：他说的话（input 的 from），和我发给他的（meta.to 里带他的号码/会话不好对，按 from 名字和 to 粗筛） */
const isSelf = (name: string): boolean => [B.common.self, N.me.toLowerCase(), N.id.toLowerCase()].includes(name);

/** --who 只算那个人说的话；问「我」时才算我自己说的、记的、发出去的 */
function whoFilter(r: Row, person: string | undefined): boolean {
  if (!person) return true;
  if (r.kind !== "input") return isSelf(person.toLowerCase());
  const meta = r.meta ? (JSON.parse(r.meta) as { from?: string; sessionKey?: string }) : {};
  return (meta.from ?? "").toLowerCase().includes(person.toLowerCase());
}

/** recall show 一次给多少字，更长的分页（--from） */
const SHOW_PAGE = 30_000;

/** 中央记忆的编号：N、#N，或者 c:N（事件库、夜里整理的出处写的是 c:N）；别的写法给 NaN */
const seqOf = (x: unknown): number => {
  const m = /^(?:#|c:)?(\d+)$/.exec(String(x ?? "").trim());
  return m ? Number(m[1]) : NaN;
};

/** 返回找到的原话；找不到返回空字符串（调用方再去别处找） */
export function recallCentral(db: Db, args: string[], o: RecallOpts): string {
  const mode = args[0];
  const limit = Number(arg(args, "-n") ?? o.limit ?? 12);
  const person = arg(args, "--who");
  if (mode === "search") {
    const q = (args[1] ?? "").trim();
    if (!q) return "";
    const words = q.split(/\s+/).filter(Boolean);
    const where = words.map(() => "text LIKE ?").join(" AND ");
    const rows = all<Row>(db, `SELECT seq, ts, src, kind, text, meta FROM central WHERE kind IN ('input','say','note') AND ${NOT_MARK} AND ${where} ORDER BY seq DESC LIMIT 200`, ...words.map((w) => `%${w}%`))
      .filter((r) => whoFilter(r, person)).slice(0, limit).reverse();
    return fmt(db, rows, o);
  }
  if (mode === "day") {
    const day = args[1] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "";
    // 她的一天从凌晨 4 点算；用 UTC 近似取前后各一天，再按本地日期筛
    const start = Date.parse(`${day}T00:00:00Z`) - 86_400_000;
    const end = start + 3 * 86_400_000;
    const fmtDay = new Intl.DateTimeFormat("en-CA", { timeZone: o.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
    const rows = all<Row>(db, "SELECT seq, ts, src, kind, text, meta FROM central WHERE kind IN ('input','say') AND ts BETWEEN ? AND ? ORDER BY seq", start, end)
      .filter((r) => {
        const p = Object.fromEntries(fmtDay.formatToParts(r.ts).map((x) => [x.type, x.value])) as Record<string, string>;
        const local = new Date(Date.parse(`${p.year}-${p.month}-${p.day}T00:00:00Z`) - (Number(p.hour) < 4 ? 86_400_000 : 0)).toISOString().slice(0, 10);
        return local === day && whoFilter(r, person);
      });
    return fmt(db, rows.slice(-Math.max(limit, 60)), o);
  }
  if (mode === "show") {
    // 单条全文（压缩视角里折起来的工具过程、被截断的长内容，用编号翻出来）
    const seq = seqOf(args[1]);
    if (!Number.isFinite(seq)) return "";
    const rows = all<Row>(db, "SELECT seq, ts, src, kind, text, meta FROM central WHERE seq = ?", seq);
    if (!rows.length) return M.recallCentral.noSuch(seq);
    // 按这一条原文的字数分页（--from 是原文里的第几个字）
    const from = Math.max(0, Number(arg(args, "--from") ?? 0) || 0);
    const row = rows[0]!;
    const total = row.text.length;
    const out = fmt(db, [{ ...row, text: row.text.slice(from, from + SHOW_PAGE) }], { ...o, full: true });
    return from + SHOW_PAGE < total
      ? M.recallCentral.more(out, total, seq, from + SHOW_PAGE)
      : out;
  }
  if (mode === "around") {
    const seq = seqOf(args[1]);
    if (!Number.isFinite(seq)) return "";
    const rows = all<Row>(db, `SELECT seq, ts, src, kind, text, meta FROM central WHERE seq BETWEEN ? AND ? AND kind IN ('input','say','note','act','result') AND ${NOT_MARK} ORDER BY seq`, seq - limit, seq + limit);
    return fmt(db, rows, o);
  }
  return "";
}
