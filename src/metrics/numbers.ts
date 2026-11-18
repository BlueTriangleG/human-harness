// hh numbers：周表的五个数（CEO 11-12）——又犯、纠正、笔记翻开率、被叫醒、额度，按她的日子（schedule.timezone 的日历日）切天。
// 只读本地数据：hh.db（只读打开）、HH 日志（<stateDir>/logs/hh.jsonl）、Claude 会话记录（~/.claude/projects）。不调模型、不写任何东西。
// 口径：又犯、纠正、翻开率照定好的 SQL；被叫醒数 main wake 日志（没有的日子退回数主线 turn end）；额度数 quota reading 日志。
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { localDay } from "../learning/score.ts";
import { B } from "../lang/index.ts";

/** 用量的去向：她自己（HH 的工作区）、帮手、团队（11-14 起团队用她账号剩下的额度做优化活，cwd 放在实例配置 metrics.teamDirs 下）、她的回放、其他（临时目录、缓存） */
export type Dest = "hh" | "helpers" | "team" | "replay" | "other";
export const DESTS: readonly Dest[] = ["hh", "helpers", "team", "replay", "other"];

export interface NumbersDay {
  day: string;
  /** 又犯：learn_recur 里一条教训一天一行 */
  recur: number;
  /** 被纠正：learn_correction 的条数（叫醒时由判断认出来的） */
  corrections: number;
  /** 笔记：挂上的页数、挂上后 openWindowMs 内同一个脑区翻开了的页数 */
  mounted: number;
  opened: number;
  /** 有挂载的联想次数（mounted ÷ mounts = 每次平均挂几页，看普通联想有没有掉） */
  mounts: number;
  /** 强教训按老毛病贴了几次：挂上的强教训页（strong）的 loud 条数，老的行没有 loud 就数 hits（学习 11-12 的口径，不算 handover） */
  strongPastes: number;
  /** 被叫醒的次数；wakeCauses 是按原因分的（那天还没有 main wake 日志时为 null，次数退回数主线的 turn end） */
  wakes: number;
  wakeCauses: Record<string, number> | null;
  /** 这周额度（seven_day）这一天涨了几个百分点；那天没有读数为 null */
  quotaPct: number | null;
  /** 用量当量（百万），按去向：HH 自己的工作区、帮手、回放、其他（临时目录、缓存） */
  usage: Record<Dest, number>;
}

export interface Weights { cacheRead: number; cacheWrite: number; input: number; output: number }
/** 按 API 价格的比例折算（缓存读 0.1、缓存写 1.25、输入 1、输出 5）：只是当量，和订阅额度的百分比不是一回事 */
export const DEFAULT_WEIGHTS: Weights = { cacheRead: 0.1, cacheWrite: 1.25, input: 1, output: 5 };

/** 只要用到的那点 sqlite 接口（node:sqlite 的 DatabaseSync 满足） */
export interface ReadDb { prepare(sql: string): { all(...params: Array<string | number>): unknown[] } }

export interface NumbersInput {
  /** 算哪几天：以 now 所在的那天结尾，往前共 days 天 */
  days: number;
  now: number;
  tz: string;
  db: ReadDb | null;
  logLines: Iterable<string>;
  /** 会话记录：dir 是 ~/.claude/projects 下的目录名（Claude Code 把工作目录的非字母数字都换成 -） */
  transcripts: Iterable<{ dir: string; lines: Iterable<string> }>;
  /** HH 自己的工作区、回放的目录（按开头认）；别的都算帮手，临时目录和缓存算其他 */
  /** team：团队干活的目录（实例配置 metrics.teamDirs）；不给就没有团队这一类，和以前一样 */
  dirs: { workspace: string; replay: string[]; team?: string[] };
  weights?: Weights;
  openWindowMs?: number;
}

const DAY_MS = 86_400_000;

/** 以 now 所在的那天结尾的 days 个日子（按 tz） */
export function dayList(now: number, days: number, tz: string): string[] {
  const out: string[] = [];
  for (let k = days * 2; k >= 0 && out.length < days * 3; k -= 1) {
    const d = localDay(now - k * (DAY_MS / 2), tz);
    if (!out.includes(d)) out.push(d);
  }
  return out.slice(-days);
}

/** Claude Code 的会话目录名：工作目录里不是字母数字的都换成 - */
export const projectDirOf = (path: string): string => path.replace(/[^A-Za-z0-9]/g, "-");

export function destOf(dir: string, dirs: NumbersInput["dirs"]): Dest {
  if (dir === projectDirOf(dirs.workspace)) return "hh";
  // 团队：那个目录本身或下面的子目录（会话记录目录名是路径把非字母数字换成 -，所以要么完全一样，要么后面紧跟一个 -）
  if ((dirs.team ?? []).some((p) => { const pre = projectDirOf(p); return dir === pre || dir.startsWith(`${pre}-`); })) return "team";
  if (dirs.replay.some((p) => dir.startsWith(projectDirOf(p)))) return "replay";
  if (/^-(private-)?(var-folders|tmp)(-|$)/.test(dir) || dir.includes("-cache-")) return "other";
  return "helpers";
}

function emptyDay(day: string): NumbersDay {
  return { day, recur: 0, corrections: 0, mounted: 0, opened: 0, mounts: 0, strongPastes: 0, wakes: 0, wakeCauses: null, quotaPct: null, usage: { hh: 0, helpers: 0, team: 0, replay: 0, other: 0 } };
}

const tableExists = (db: ReadDb, name: string): boolean => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").all(name).length > 0;

export function numbers(i: NumbersInput): NumbersDay[] {
  const days = dayList(i.now, i.days, i.tz);
  const rows = new Map(days.map((d) => [d, emptyDay(d)] as const));
  const since = i.now - (i.days + 1) * DAY_MS;            // 多取一天，按日子过滤
  const at = (t: number): NumbersDay | undefined => (t >= since ? rows.get(localDay(t, i.tz)) : undefined);
  const w = i.weights ?? DEFAULT_WEIGHTS;
  const windowMs = i.openWindowMs ?? 30 * 60_000;

  if (i.db) {
    const db = i.db;
    if (tableExists(db, "learn_recur")) {
      for (const r of db.prepare("SELECT day, COUNT(*) AS n FROM learn_recur WHERE day >= ? GROUP BY day").all(days[0]!) as Array<{ day: string; n: number }>) {
        const row = rows.get(r.day);
        if (row) row.recur = Number(r.n);
      }
    }
    if (tableExists(db, "learn_correction")) {
      for (const r of db.prepare("SELECT at FROM learn_correction WHERE at >= ?").all(since) as Array<{ at: number }>) {
        const row = at(Number(r.at));
        if (row) row.corrections += 1;
      }
    }
    if (tableExists(db, "learn_assoc") && tableExists(db, "learn_open")) {
      // 学习的口径：真挂上的（shadow = 0）、不是回放 / 帮手 / 问答挂的；带 carry 的（上一次挂着带过来的）不算
      const opens = new Map<string, number[]>();
      for (const o of db.prepare("SELECT at, region, page_id FROM learn_open WHERE at >= ? AND page_id IS NOT NULL").all(since) as Array<{ at: number; region: string; page_id: string }>) {
        const k = `${o.region}\u0000${o.page_id}`;
        opens.set(k, [...(opens.get(k) ?? []), Number(o.at)]);
      }
      const assoc = db.prepare("SELECT at, region, binding, mounted FROM learn_assoc WHERE at >= ? AND shadow = 0 AND mounted != '[]' AND binding NOT IN ('replay', 'helper', 'ask')").all(since) as Array<{ at: number; region: string; binding: string; mounted: string }>;
      for (const a of assoc) {
        const row = at(Number(a.at));
        if (!row) continue;
        let pages: Array<{ id?: unknown; carry?: unknown; strong?: unknown; loud?: unknown; hits?: unknown }>;
        try { pages = JSON.parse(a.mounted) as typeof pages; } catch { continue; }
        if (!Array.isArray(pages)) continue;
        row.mounts += 1;
        for (const p of pages) {
          if (p && p.strong === true && a.binding !== "handover") row.strongPastes += Array.isArray(p.loud) ? p.loud.length : Array.isArray(p.hits) ? p.hits.length : 0;
        }
        for (const p of pages) {
          if (!p || typeof p.id !== "string" || p.carry === true) continue;
          row.mounted += 1;
          const t = opens.get(`${a.region}\u0000${p.id}`) ?? [];
          if (t.some((x) => x >= Number(a.at) && x <= Number(a.at) + windowMs)) row.opened += 1;
        }
      }
    }
  }

  // 日志：被叫醒、额度读数
  const turnEnds = new Map<string, number>();
  const readings: Array<{ t: number; used: number }> = [];
  for (const line of i.logLines) {
    if (!line.includes("\"main wake\"") && !line.includes("\"turn end\"") && !line.includes("\"quota reading\"")) continue;
    let r: { t?: string; msg?: string; cause?: unknown; region?: unknown; sevenDay?: { used?: unknown } };
    try { r = JSON.parse(line) as typeof r; } catch { continue; }
    const t = Date.parse(r.t ?? "");
    if (!Number.isFinite(t)) continue;
    if (r.msg === "quota reading") {
      if (typeof r.sevenDay?.used === "number") readings.push({ t, used: r.sevenDay.used });
      continue;
    }
    const row = at(t);
    if (!row) continue;
    if (r.msg === "main wake") {
      const c = typeof r.cause === "string" ? r.cause : "other";
      row.wakeCauses = { ...(row.wakeCauses ?? {}), [c]: (row.wakeCauses?.[c] ?? 0) + 1 };
    } else if (r.msg === "turn end" && r.region === "main") turnEnds.set(row.day, (turnEnds.get(row.day) ?? 0) + 1);
  }
  for (const row of rows.values()) row.wakes = row.wakeCauses ? Object.values(row.wakeCauses).reduce((a, b) => a + b, 0) : turnEnds.get(row.day) ?? 0;
  // Quota: the rise between two readings goes to the later one's day. A reset drops the reading below half (resetsAt stays
  // the same), and the new reading is all new-week use. A one-point dip (98→97, seen live most days) counts 0: before,
  // each one counted the whole reading again, 249 points too many over 11-13..11-15.
  readings.sort((a, b) => a.t - b.t);
  for (let k = 1; k < readings.length; k += 1) {
    const row = at(readings[k]!.t);
    if (!row) continue;
    const now = readings[k]!.used, before = readings[k - 1]!.used;
    const d = now >= before ? now - before : now < before / 2 ? now : 0;
    row.quotaPct = (row.quotaPct ?? 0) + d;
  }

  // 会话记录：一次回复会分成好几行、每行带同一份用量，按消息去重（11-12 第一版没去重，多算了一倍）
  const seen = new Set<string>();
  for (const tr of i.transcripts) {
    const dest = destOf(tr.dir, i.dirs);
    for (const line of tr.lines) {
      if (!line.includes("\"usage\"")) continue;
      let r: { timestamp?: string; requestId?: string; message?: { id?: string; usage?: Record<string, unknown> } };
      try { r = JSON.parse(line) as typeof r; } catch { continue; }
      const u = r.message?.usage;
      const t = Date.parse(r.timestamp ?? "");
      if (!u || !Number.isFinite(t)) continue;
      const key = `${r.message?.id ?? ""}\u0000${r.requestId ?? ""}`;
      if (key !== "\u0000") { if (seen.has(key)) continue; seen.add(key); }
      const row = at(t);
      if (!row) continue;
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      row.usage[dest] += (n("cache_read_input_tokens") * w.cacheRead + n("cache_creation_input_tokens") * w.cacheWrite + n("input_tokens") * w.input + n("output_tokens") * w.output) / 1e6;
    }
  }
  return days.map((d) => rows.get(d)!);
}

const causeName = (k: string): string | undefined => ({
  human: B.numbers.causeHuman, message: B.numbers.causeMessage, gate: B.numbers.causeGate, senses: B.numbers.causeSenses, helper: B.numbers.causeHelperReport, reminder: B.numbers.causeReminder, focus: B.numbers.causeFocus, wander: B.numbers.causeWander,
  side: B.numbers.causeSideWork, insight: B.numbers.causeInsight, subconscious: B.numbers.causeSubconscious, "wake-up": B.numbers.causeWakeUp, resume: B.numbers.causeResume, manual: B.numbers.causeManual, other: B.numbers.causeOther,
} as Record<string, string>)[k];
const pct = (a: number, b: number): string => (b ? `${Math.round((100 * a) / b)}%` : "-");
const sum = (rows: NumbersDay[], f: (r: NumbersDay) => number): number => rows.reduce((n, r) => n + f(r), 0);
const usageOf = (r: NumbersDay): number => DESTS.reduce((n, d) => n + r.usage[d], 0);
const r0 = (x: number): string => String(Math.round(x));

function causesText(c: Record<string, number> | null): string {
  if (!c) return B.numbers.causesNone;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${causeName(k) ?? k} ${n}`).join(B.numbers.causesSeparator);
}

/** 一张表：每天一行加合计；给了 prev（前一段同样天数）再加一行对比 */
export function renderNumbers(rows: NumbersDay[], o: { tz: string; prev?: NumbersDay[]; today?: string }): string {
  const head = B.numbers.tableHeading(rows[0]?.day ?? "", rows.at(-1)?.day ?? "", o.tz);
  const lines = [
    head,
    "",
    B.numbers.tableHeaderRow,
    "|---|---|---|---|---|---|---|---|---|",
    // 当天的又犯要等夜里整理才记，白天永远是 0：写「—」（学习 11-12）
    ...rows.map((r) => B.numbers.tableDayRow(r.day, r.day === o.today ? "—" : r.recur, r.corrections, pct(r.opened, r.mounted), r.opened, r.mounted, r.mounts ? (r.mounted / r.mounts).toFixed(1) : "-", r.strongPastes, r.wakes, causesText(r.wakeCauses), r.quotaPct === null ? "-" : `${r0(r.quotaPct)}%`, r0(usageOf(r)), DESTS.map((d) => r0(r.usage[d])).join(" / "))),
  ];
  const tot = (rs: NumbersDay[]): { recur: number; corr: number; opened: number; mounted: number; mounts: number; strong: number; wakes: number; quota: number | null; usage: number } => ({
    recur: sum(rs, (r) => r.recur), corr: sum(rs, (r) => r.corrections), opened: sum(rs, (r) => r.opened), mounted: sum(rs, (r) => r.mounted),
    mounts: sum(rs, (r) => r.mounts), strong: sum(rs, (r) => r.strongPastes),
    wakes: sum(rs, (r) => r.wakes), quota: rs.some((r) => r.quotaPct !== null) ? sum(rs, (r) => r.quotaPct ?? 0) : null, usage: sum(rs, usageOf),
  });
  const a = tot(rows);
  lines.push(B.numbers.tableTotalRow(a.recur, a.corr, pct(a.opened, a.mounted), a.opened, a.mounted, a.mounts ? (a.mounted / a.mounts).toFixed(1) : "-", a.strong, a.wakes, a.quota === null ? "-" : `${r0(a.quota)}%`, r0(a.usage)));
  if (o.prev?.length) {
    const b = tot(o.prev);
    lines.push("", B.numbers.tableCompareLine(o.prev.length, o.prev[0]!.day, o.prev.at(-1)!.day, b.recur, a.recur, b.corr, a.corr, pct(b.opened, b.mounted), pct(a.opened, a.mounted), b.strong, a.strong, b.wakes, a.wakes, b.quota === null ? "-" : `${r0(b.quota)}%`, a.quota === null ? "-" : `${r0(a.quota)}%`, r0(b.usage), r0(a.usage)));
  }
  lines.push("", B.numbers.tableFootnote);
  return lines.join("\n");
}

// ---------- 命令：hh numbers [天数=7] [--compare] [--json] [--weights 读,写,入,出] [--projects 目录] ----------

export interface NumbersCfg { stateDir: string; workspace: string; schedule: { timezone: string }; metrics?: { teamDirs?: string[] } }

function* fileLines(path: string): Generator<string> {
  for (const l of readFileSync(path, "utf8").split("\n")) if (l) yield l;
}

/** 会话目录下的记录，连子代理的（<会话>/subagents/*.jsonl，在下面几层）一起；去向按最上面那层目录认 */
function* transcriptsSince(dir: string, since: number): Generator<{ dir: string; lines: Iterable<string> }> {
  if (!existsSync(dir)) return;
  function* walk(top: string, path: string, depth: number): Generator<{ dir: string; lines: Iterable<string> }> {
    let names: string[];
    try { names = readdirSync(path); } catch { return; }
    for (const f of names) {
      const p = join(path, f);
      let st: ReturnType<typeof statSync>;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) { if (depth < 4) yield* walk(top, p, depth + 1); continue; }
      if (f.endsWith(".jsonl") && st.mtimeMs >= since) yield { dir: top, lines: fileLines(p) };
    }
  }
  for (const d of readdirSync(dir)) {
    try { if (!statSync(join(dir, d)).isDirectory()) continue; } catch { continue; }
    yield* walk(d, join(dir, d), 0);
  }
}

/** 实例配置 metrics.teamDirs：只认非空字符串的数组，写错了（不是数组、混了别的）就当没配那几项，不让周表崩 */
export const teamDirsOf = (cfg: NumbersCfg): string[] => (Array.isArray(cfg.metrics?.teamDirs) ? cfg.metrics.teamDirs.filter((p): p is string => typeof p === "string" && p.trim() !== "") : []);

export function numbersCommand(cfg: NumbersCfg, argv: string[], o: { now?: number; projectsDir?: string } = {}): string {
  const args = [...argv];
  const flag = (f: string): boolean => { const i = args.indexOf(f); if (i < 0) return false; args.splice(i, 1); return true; };
  const option = (f: string): string | undefined => { const i = args.indexOf(f); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const compare = flag("--compare");
  const json = flag("--json");
  const w = option("--weights");
  const projects = option("--projects") ?? o.projectsDir ?? join(homedir(), ".claude", "projects");
  const days = args[0] ? Number(args[0]) : 7;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error(B.numbers.numbersUsage);
  let weights: Weights | undefined;
  if (w) {
    const v = w.split(",").map(Number);
    if (v.length !== 4 || v.some((x) => !Number.isFinite(x) || x < 0)) throw new Error(B.numbers.weightsInvalid);
    weights = { cacheRead: v[0]!, cacheWrite: v[1]!, input: v[2]!, output: v[3]! };
  }
  const now = o.now ?? Date.now();
  const span = compare ? days * 2 : days;
  const dbPath = join(cfg.stateDir, "hh.db");
  const db = existsSync(dbPath) ? new DatabaseSync(dbPath, { readOnly: true }) : null;
  const logPath = join(cfg.stateDir, "logs", "hh.jsonl");
  try {
    const rows = numbers({
      days: span, now, tz: cfg.schedule.timezone, db,
      logLines: existsSync(logPath) ? fileLines(logPath) : [],
      transcripts: transcriptsSince(projects, now - (span + 1) * DAY_MS),
      dirs: { workspace: cfg.workspace, replay: [join(cfg.stateDir, "replay")], team: teamDirsOf(cfg) },
      ...(weights ? { weights } : {}),
    });
    const cur = rows.slice(-days);
    const prev = compare ? rows.slice(0, rows.length - days) : undefined;
    if (json) return JSON.stringify({ days: cur, ...(prev ? { prev } : {}) }, null, 2);
    return renderNumbers(cur, { tz: cfg.schedule.timezone, today: localDay(now, cfg.schedule.timezone), ...(prev ? { prev } : {}) });
  } finally {
    db?.close();
  }
}
