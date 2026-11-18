// 控制台的数据层：全部只读。
// - 中央记忆（hh.db 的 central 表）：各脑区收到 / 想 / 说 / 做了 / 结果 / 记下
// - 活动条：最近一段时间每个脑区每分钟有几条
// - 手下：她派出去的 Claude Code 会话（cc.py 的 .cc/<名>.json）和它们的 transcript
// - hhd 自己的日志（logs/hh.jsonl）
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { say } from "./lang/index.ts";

export interface Row {
  seq: number;
  ts: number;
  epoch: number;
  src: string;
  kind: string;
  text: string;
  meta: Record<string, unknown> | null;
}

/** 单条最多给多少字（结果偶尔很长，网页只要看得到开头和结尾） */
export const MAX_TEXT = 20_000;

export function clip(text: string, max = MAX_TEXT): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${text.slice(0, head)}\n${say("common.clipped", { n: text.length - max })}\n${text.slice(-tail)}`;
}

export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

interface RawRow { seq: number; ts: number; epoch: number; src: string; kind: string; text: string; meta: string | null }

function toRow(r: RawRow): Row {
  let meta: Record<string, unknown> | null = null;
  if (r.meta) {
    try { meta = JSON.parse(r.meta) as Record<string, unknown>; } catch { meta = { raw: r.meta }; }
  }
  return { seq: Number(r.seq), ts: Number(r.ts), epoch: Number(r.epoch), src: r.src, kind: r.kind, text: clip(r.text), meta };
}

export interface EventQuery { after?: number; before?: number; limit?: number; src?: string }

/**
 * 中央记忆的一段，按 seq 从小到大。
 * - after：只要这之后的（直播用）
 * - before：只要这之前的最后 limit 条（往上翻用）
 * - 都不给：最后 limit 条
 * - src：只要这一个来源（脑区）的。只看一个脑区时用：最近几百条里可能一条它的都没有（别的脑区一忙就把它挤出去了）
 */
export function events(db: DatabaseSync, q: EventQuery = {}): Row[] {
  const limit = Math.max(1, Math.min(q.limit ?? 300, 2000));
  const only = q.src !== undefined ? [q.src] : [];
  const and = only.length ? " AND src = ?" : "";
  let rows: RawRow[];
  if (q.after !== undefined) {
    rows = db.prepare(`SELECT * FROM central WHERE seq > ?${and} ORDER BY seq LIMIT ?`).all(q.after, ...only, limit) as unknown as RawRow[];
  } else if (q.before !== undefined) {
    rows = (db.prepare(`SELECT * FROM central WHERE seq < ?${and} ORDER BY seq DESC LIMIT ?`).all(q.before, ...only, limit) as unknown as RawRow[]).reverse();
  } else {
    rows = (db.prepare(`SELECT * FROM central${only.length ? " WHERE src = ?" : ""} ORDER BY seq DESC LIMIT ?`).all(...only, limit) as unknown as RawRow[]).reverse();
  }
  return rows.map(toRow);
}

export function maxSeq(db: DatabaseSync): number {
  const r = db.prepare("SELECT MAX(seq) AS m FROM central").get() as { m: number | null } | undefined;
  return Number(r?.m ?? 0);
}

export interface Activity { from: number; minutes: number; lanes: Record<string, number[]> }

/** 最近 minutes 分钟里，每个来源每分钟几条（顶上的活动条用） */
/*
 * central 的 ts 上没有索引，按时间筛就得把整张表过一遍（几百兆，页面每 30 秒要一次）。
 * 行只往后加，窗口只往后挪：上次窗口里最早的那一行之前的行，这次也一定在窗口外。
 * 所以同一个连接上记着那一行的 seq，下次从它往后看。窗口往回挪了（要看更久以前）就整张重看一遍。
 */
const activityStart = new WeakMap<DatabaseSync, { from: number; seq: number }>();
export function activity(db: DatabaseSync, now: number, minutes = 60): Activity {
  const from = Math.floor(now / 60_000) * 60_000 - (minutes - 1) * 60_000;
  const c = activityStart.get(db);
  const start = c && from >= c.from ? c.seq : 0;
  const rows = db.prepare(
    "SELECT src, CAST((ts - ?) / 60000 AS INTEGER) AS b, COUNT(*) AS n, MIN(seq) AS s FROM central WHERE seq >= ? AND ts >= ? GROUP BY src, b",
  ).all(from, start, from) as Array<{ src: string; b: number; n: number; s: number }>;
  const lanes: Record<string, number[]> = {};
  let first = Infinity;
  for (const r of rows) {
    first = Math.min(first, Number(r.s));
    const b = Number(r.b);
    if (b < 0 || b >= minutes) continue;
    (lanes[r.src] ??= new Array<number>(minutes).fill(0))[b] = Number(r.n);
  }
  // 窗口里一行都没有：现在表里的行全在窗口外，下次从它们后面看起
  activityStart.set(db, { from, seq: Number.isFinite(first) ? first : maxSeq(db) + 1 });
  return { from, minutes, lanes };
}

// ---------- 手下（Claude Code 会话） ----------

export interface Worker {
  name: string;
  model: string | null;
  state: string | null;
  turn: number | null;
  dir: string | null;
  created: string | null;
  sessionId: string | null;
  lastActive: number | null;   // transcript 最后修改时间（毫秒）
  transcriptBytes: number | null;
}

// letters and digits of any script: the helpers module takes names in the role's own language
const NAME_OK = /^[\p{L}\p{N}._-]{1,80}$/u;
export function validName(name: string): boolean { return NAME_OK.test(name) && !name.startsWith("."); }

function str(v: unknown): string | null { return typeof v === "string" ? v : null; }

/** 找到过的 transcript 在哪（一个会话的 transcript 不换地方）。不然每列一次帮手，就要把 projects 下每个目录挨个问一遍（一百个帮手 × 一百个目录）；没找到的每次照旧再找（刚派出去的帮手，transcript 晚几秒才有） */
const transcriptAt = new Map<string, string>();
export function findTranscript(projectsDir: string, sessionId: string, dirs?: readonly string[]): string | null {
  if (!/^[0-9a-f-]{8,64}$/i.test(sessionId) || !existsSync(projectsDir)) return null;
  const key = `${projectsDir}\0${sessionId}`;
  const known = transcriptAt.get(key);
  if (known !== undefined) {
    if (existsSync(known)) return known;
    transcriptAt.delete(key);
  }
  for (const d of dirs ?? readdirSync(projectsDir)) {
    const p = join(projectsDir, d, `${sessionId}.jsonl`);
    if (existsSync(p)) { transcriptAt.set(key, p); return p; }
  }
  return null;
}

/** .cc 目录里的会话；口令（token）这类字段一律不往外给 */
export function workers(helperSessionsDir: string, projectsDir: string): Worker[] {
  if (!existsSync(helperSessionsDir)) return [];
  const out: Worker[] = [];
  const dirs = existsSync(projectsDir) ? readdirSync(projectsDir) : [];
  for (const f of readdirSync(helperSessionsDir)) {
    if (!f.endsWith(".json") || f.endsWith(".settings.json")) continue;
    const name = f.slice(0, -".json".length);
    if (!validName(name)) continue;
    let m: Record<string, unknown>;
    try { m = JSON.parse(readFileSync(join(helperSessionsDir, f), "utf8")) as Record<string, unknown>; } catch { continue; }
    const sessionId = str(m.session_id);
    const t = sessionId ? findTranscript(projectsDir, sessionId, dirs) : null;
    const st = t ? statSync(t) : null;
    out.push({
      name,
      model: str(m.bg_model) ?? str(m.model),
      state: str(m.state),
      turn: typeof m.turn === "number" ? m.turn : null,
      dir: str(m.dir),
      created: str(m.created),
      sessionId,
      lastActive: st ? st.mtimeMs : null,
      transcriptBytes: st ? st.size : null,
    });
  }
  return out.sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
}

/** 读文件最后 maxBytes 字节，去掉开头那半行 */
export function tailLines(path: string, maxBytes: number): string[] {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } finally {
    closeSync(fd);
  }
}

export interface Step { ts: string | null; kind: "input" | "think" | "say" | "act" | "result"; text: string; tool?: string; error?: boolean }

function blockText(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      const x = b as Record<string, unknown>;
      if (x.type === "text" && typeof x.text === "string") return x.text;
      if (x.type === "image") return say("common.image");
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** Claude Code transcript → 一步一步（收到 / 想 / 说 / 做了 / 结果） */
export function transcriptSteps(lines: string[], limit = 400): Step[] {
  const steps: Step[] = [];
  const toolName = new Map<string, string>();
  for (const line of lines) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = str(o.timestamp);
    const msg = o.message as { content?: unknown } | undefined;
    if (!msg) continue;
    if (o.type === "assistant" && Array.isArray(msg.content)) {
      for (const b of msg.content as Array<Record<string, unknown>>) {
        if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) steps.push({ ts, kind: "think", text: clip(b.thinking) });
        else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) steps.push({ ts, kind: "say", text: clip(b.text) });
        else if (b.type === "tool_use") {
          const tool = String(b.name ?? "");
          if (typeof b.id === "string") toolName.set(b.id, tool);
          steps.push({ ts, kind: "act", tool, text: clip(JSON.stringify(b.input ?? {}), 6000) });
        }
      }
    } else if (o.type === "user") {
      if (o.isMeta === true) continue;
      if (typeof msg.content === "string") {
        if (msg.content.trim()) steps.push({ ts, kind: "input", text: clip(msg.content) });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content as Array<Record<string, unknown>>) {
          if (b.type === "tool_result") {
            const id = String(b.tool_use_id ?? "");
            steps.push({ ts, kind: "result", ...(toolName.has(id) ? { tool: toolName.get(id)! } : {}), text: clip(blockText(b.content), 8000), ...(b.is_error === true ? { error: true } : {}) });
          } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
            steps.push({ ts, kind: "input", text: clip(b.text) });
          }
        }
      }
    }
  }
  return steps.slice(-limit);
}

/** 每轮思考里有几块其实是空的（显示被关掉时只剩签名） */
export function hiddenThinking(lines: string[]): { shown: number; hidden: number } {
  let shown = 0, hidden = 0;
  for (const line of lines) {
    if (!line.includes('"thinking"')) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const c = (o.message as { content?: unknown } | undefined)?.content;
    if (o.type !== "assistant" || !Array.isArray(c)) continue;
    for (const b of c as Array<Record<string, unknown>>) {
      if (b.type !== "thinking") continue;
      if (typeof b.thinking === "string" && b.thinking.trim()) shown++;
      else hidden++;
    }
  }
  return { shown, hidden };
}

// ---------- hhd 日志 ----------

const LEVELS = ["debug", "info", "warn", "error"];

export function logTail(path: string, n = 200, minLevel = "info"): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  const min = Math.max(0, LEVELS.indexOf(minLevel));
  const out: Array<Record<string, unknown>> = [];
  for (const l of tailLines(path, 2_000_000)) {
    try {
      const r = JSON.parse(l) as Record<string, unknown>;
      if (LEVELS.indexOf(String(r.level)) >= min) out.push(r);
    } catch { /* 坏行不要 */ }
  }
  return out.slice(-n);
}
