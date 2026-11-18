// hh learn …：给主人和 Claude Code 看学习的记分、手动跑回测、加种子题（经 hhd，她的工具碰不到这里）。
//   scan          补编号、重扫书架、刷完封面向量，报页数、教训数和书架的问题
//   stats [天数]   最近几天的联想：各绑定点几次、跳过的原因、耗时、花费、每次挂几页、接住率；主人的话问了几次纠正、过线几次、差一点的
//   week          每周数字（和夜里写进 learn/weekly.md 的一样）
//   replay        按今天的日子跑一遍回测（同一天已经有结果的题不重判）
//   ids           所有认得的编号（含别名），一行一个：sleep_apply 的编号闸门用
//   case add <页编号> <话题…> | case ls   加一道种子题 / 列出全部题
//   migrate-check <lessons.md 路径> <归档目录>   搬家核对：每条教训都进了某页；手册的哪些行只留在归档里（相对路径从工作区算）
//   helper <帮手名> <活…>   cc.py 派活时问：这件活该附给帮手哪几页（回的那段接在派给它的话后面；没有就是空的）
//   param [名字 [值|默认] [谁] [为什么…]]   学习的参数：不带名字列出全部；带值改（当场生效，记一行日志）；「默认」清掉覆盖
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { LearningCfg } from "../config.ts";
import { all, kvGet, one, type Db } from "../store/db.ts";
import { CentralMemory } from "../memory/central.ts";
import { knownIds, resolveId } from "./ids.ts";
import { linksOf, neighbors, pageIndex, type LinkKind } from "./graph.ts";
import { graphData } from "./curator.ts";
import { listParams, param, PARAMS, setParam } from "./params.ts";
import { LESSON_ID, PAGE_ID, pageFormat, pageRe, scanShelf } from "./notebook.ts";
import type { LearningRuntime } from "./runtime.ts";
import { addSeedCase, caught, localDay, NOT_MOUNTS, renderWeekly, runReplay, weekly, type AssocRow } from "./score.ts";
import { B, L } from "../lang/index.ts";

export interface LearnCliEnv {
  cfg: LearningCfg;
  /** 她的时区 */
  tz: string;
  now: () => number;
}

const DAY_MS = 86_400_000;
const USD_PER_TOKEN = 0.1 / 1e6; // Decisions 输入 $0.10 / 百万 token
/** 纠正题门槛下这么多以内算"差一点" */
const NEAR_MISS = 0.3;

export async function learnCommand(rt: LearningRuntime, action: string, args: string[], o: LearnCliEnv): Promise<unknown> {
  const db = rt.db;
  switch (action) {
    case "scan": {
      const { shelf, embedded } = await rt.rescan();
      const live = shelf.pages.filter((p) => !p.archived);
      const lessons = live.reduce((n, p) => n + p.lessons.length, 0);
      const lines = [L.cli.scanSummary(shelf.books.length, live.length, shelf.pages.length - live.length, lessons, embedded)];
      if (shelf.problems.length) lines.push(L.cli.problemsHeader(shelf.problems.length), ...shelf.problems.map((p) => `- ${p}`));
      return lines.join("\n");
    }
    case "stats": return stats(rt, args[0] === undefined ? 7 : Number(args[0]), o);
    case "week": return renderWeekly(weekly(db, { now: o.now(), tz: o.tz, shelf: rt.shelf(), central: new CentralMemory(db), root: o.cfg.root }), rt.owner);
    case "replay": {
      if (!o.cfg.enabled) return L.cli.replayDisabled;
      const night = localDay(o.now(), o.tz);
      const r = await runReplay(db, rt.notes, night);
      return L.cli.replaySummary(night, r.total, r.passed, r.skipped ? L.cli.replayUnjudged(r.skipped) : "", r.prevPassed ?? L.cli.replayNeverRan);
    }
    case "ids": return [...knownIds(db)].sort().join("\n");
    case "format": return JSON.stringify(pageFormat(o.cfg.archiveDir));
    case "case": return caseCommand(db, args, o);
    case "migrate-check": return migrateCheck(args, o.cfg);
    case "helper": {
      const [worker, ...task] = args;
      if (!worker || !task.length) throw new Error(L.cli.helperUsage);
      return (await rt.notes.forHelper(task.join(" "), worker)).text;
    }
    case "param": return paramCommand(rt, args, o);
    case "links": case "near": case "graph": return graphCommand(rt, action, args, o);
    default: throw new Error(L.cli.unknownAction(action));
  }
}

/**
 * 笔记的连线和分层（graph.ts、layers.ts）：
 *   hh learn links <页>        这一页连着哪些页（它提到的、提到它的、一起翻过的、同一件事里写到的）
 *   hh learn near <页> [-n 5]  最近的几页
 *   hh learn graph [--json]    整张图：点（层、重要度、分数）和线
 * 页可以写编号、文件名、标题或路径。graph 里的层是按现在的书架现算的（不记；夜里记下的那份在 kv learn.layers）
 */
function graphCommand(rt: LearningRuntime, action: string, args: string[], o: LearnCliEnv): string {
  const db = rt.db;
  const shelf = rt.shelf();
  const ix = pageIndex(shelf);
  const byId = new Map(shelf.pages.filter((p) => !p.archived && p.ids[0]).map((p) => [p.ids[0]!, p]));
  const name = (id: string): string => { const p = byId.get(id); return p ? L.cli.pageName(p.title, id, p.rel) : id; };
  const find = (q: string | undefined): string => {
    if (!q) throw new Error(L.cli.pageArgUsage(action));
    const bare = resolveId(db, q.replace(/^p:/, ""));   // 旧编号（合并、改号以前的）也认
    const id = byId.has(bare) ? bare : ix.resolve(q)?.ids[0];
    if (!id) throw new Error(L.cli.pageNotFound(q));
    return id;
  };
  const KIND: Record<LinkKind, string> = { ref: L.cli.linkKindRef, co: L.cli.linkKindCo, event: L.cli.linkKindEvent };
  if (action === "links") {
    const id = find(args[0]);
    const ls = linksOf(db, id);
    if (!ls.length) return L.cli.noLinks(name(id));
    return [name(id), ...ls.map((l) => {
      const other = l.a === id ? l.b : l.a;
      const dir = l.kind !== "ref" ? "—" : l.a === id ? "→" : "←";
      return L.cli.linkLine(dir, name(other), KIND[l.kind], l.kind === "ref" ? "" : L.cli.linkCount(l.n));
    })].join("\n");
  }
  if (action === "near") {
    const id = find(args[0]);
    const i = args.indexOf("-n");
    const n = i >= 0 ? Number(args[i + 1]) : 5;
    const ns = neighbors(db, id, Number.isFinite(n) && n > 0 ? n : 5);
    if (!ns.length) return L.cli.noNeighbours(name(id));
    return [name(id), ...ns.map((x) => L.cli.neighbourLine(name(x.id), x.kinds.map((k) => KIND[k]).join(L.cli.kindSeparator)))].join("\n");
  }
  const { nodes, links } = graphData(db, shelf, o.cfg.root, o.now(), { residentFile: o.cfg.residentFile, ...(o.cfg.shelfFile ? { shelfFile: o.cfg.shelfFile } : {}) });
  if (args.includes("--json")) return JSON.stringify({ nodes, links });
  const count = (l: string): number => nodes.filter((x) => x.layer === l).length;
  const deg = new Map<string, number>();
  for (const l of links) for (const x of [l.a, l.b]) deg.set(x, (deg.get(x) ?? 0) + 1);
  return [
    L.cli.graphSummary(nodes.length, count("shallow"), count("mid"), count("deep"), links.length, nodes.filter((x) => !deg.get(x.id)).length),
    ...nodes.filter((x) => x.layer === "deep").map((x) => L.cli.deepPageLine(x.rel, x.never ? L.cli.neverOpened : L.cli.daysUnopened(x.days))),
    L.cli.graphJsonHint,
  ].join("\n");
}

/** hh learn param：列出、改、清；跟着配置的参数显示配置里的值 */
function paramCommand(rt: LearningRuntime, args: string[], o: LearnCliEnv): string {
  const fromCfg: Record<string, number | undefined> = { "assoc.threshold": o.cfg.threshold, "assoc.remountTokens": o.cfg.remountTokens ?? 50_000, "assoc.kWake": o.cfg.kWake, "assoc.kTask": o.cfg.kTask };
  const [name, raw, by, ...why] = args;
  if (!name) {
    return listParams(rt.db).map((p) => {
      const now = p.value ?? fromCfg[p.name];
      const base = p.def ?? fromCfg[p.name];
      const how = p.overridden ? L.cli.paramOverridden(base) : p.def === null ? L.cli.paramFollowsConfig : L.cli.paramIsDefault;
      return L.cli.paramLine(p.name, now, how, p.min, p.max, p.step, p.desc());
    }).join("\n");
  }
  if (!Object.hasOwn(PARAMS, name)) throw new Error(L.cli.paramUnknown(name, Object.keys(PARAMS).join(" ")));
  if (raw === undefined) return `${name} = ${param(rt.db, name, fromCfg[name])}`;
  if (raw.trim() === "") throw new Error(L.cli.paramNeedsNumber(name));
  const value = raw === B.forms.paramDefault ? null : Number(raw);
  const r = setParam(rt.db, name, value, { by: by ?? "hh learn", why: why.join(" ") || L.cli.paramManualReason, now: o.now() });
  const shown = (v: number | null): string => (v === null ? L.cli.paramDefaultValue(PARAMS[name]!.def ?? fromCfg[name]) : String(v));
  return L.cli.paramChanged(name, shown(r.old), shown(r.value));
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number): string => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);
/** 比内容用的样子：去掉编号注释、开头一层列表记号或序号（勾选框也算），空白合并 */
const lineCore = (s: string): string =>
  squash(s.replace(new RegExp(PAGE_ID.source, "g"), "").replace(new RegExp(LESSON_ID.source, "g"), ""))
    .replace(/^(?:[-*+]\s+|\d+[.)、]\s*)(?:\[[ xX]\]\s*)?/, "");

/** 一条教训的正文：去掉开头的日期钟点（旧写法，如 2026-10-25 22:5x）和「教训：」，到第一个 ｜ 或「下次：」为止，去掉结尾的标点 */
function lessonBody(item: string): string {
  let s = item.trim().replace(/^\d{4}-\d\d-\d\d(?:\s+\d{1,2}:\d[\dxX])?\s*/, "").replace(pageRe.lessonLabelGap(), "");
  const cut = s.search(pageRe.lessonBodyEnd());
  if (cut >= 0) s = s.slice(0, cut);
  return squash(s).replace(/[\s。．.，,；;、]+$/, "");
}

/** 手册的内容行：不算空行、标题、开头的 frontmatter、代码块的围栏、注释行和太短的（代码块里的命令照算） */
function manualLines(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let front = lines[0]?.trim() === "---";
  const out: string[] = [];
  for (let i = front ? 1 : 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (front) { front = line.trim() !== "---"; continue; }
    const s = lineCore(line);
    if (s.length < 4 || /^(#|```|~~~|<!--)/.test(s)) continue;
    out.push(s);
  }
  return out;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * 归档目录下的手册文件（相对路径）：各本原名目录里的 .md；最上层的文件（lessons.md 的原样）、CHANGELOG.md、隐藏的不算。
 * 读不了的那一层记成 { rel, error }（rel 为空 = 归档目录本身），别的照样往下走
 */
function archivedManuals(dir: string, prefix = ""): Array<{ rel: string; error?: string }> {
  let entries;
  try {
    entries = readdirSync(join(dir, prefix), { withFileTypes: true });
  } catch (e) {
    return [{ rel: prefix, error: errMsg(e) }];
  }
  const out: Array<{ rel: string; error?: string }> = [];
  for (const d of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory()) out.push(...archivedManuals(dir, rel));
    else if (prefix && d.isFile() && d.name.endsWith(".md") && d.name !== "CHANGELOG.md") out.push({ rel });
  }
  return out;
}

/**
 * 搬家核对（spec 第 8 节第 2 步）：lessons.md 每条教训的正文要在书架上某个没归档的页的教训行里找得到（按包含比，空白不计）；
 * 书架的问题（缺 SKILL.md 的本不算、缺封面字段……）跟在后面，缺的教训多半能从这里看出为什么；
 * 归档里搬家前的每本手册，按文件报还有几行没搬进新页（原文在归档里，只是告诉，不算缺）。缺教训也是一份报告，不报错。
 */
function migrateCheck(args: string[], cfg: LearningCfg): string {
  if (args.length < 2) throw new Error(L.cli.migrateUsage);
  const ws = dirname(cfg.root);
  const lessonsPath = resolve(ws, args[0]!);
  const archive = resolve(ws, args[1]!);
  let lessonsText: string;
  try {
    lessonsText = readFileSync(lessonsPath, "utf8");
  } catch (e) {
    throw new Error(L.cli.migrateUnreadable(lessonsPath, errMsg(e)));
  }

  const shelf = scanShelf(cfg.root, cfg.generalCategory, cfg.archiveDir);
  const live = shelf.pages.filter((p) => !p.archived);
  const lessonTexts = live.flatMap((p) => p.lessons.map((l) => squash(l.text)));
  // 最外一层的 - 条目是一条教训（接着的缩进行是它的细节，正文在第一行）
  const bodies = lessonsText.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.startsWith("- ")).map((l) => lessonBody(l.slice(2))).filter(Boolean);
  const missing = bodies.filter((b) => !lessonTexts.some((t) => t.includes(b)));
  const out = missing.length
    ? [L.cli.migrateMissingHeader(missing.length, bodies.length), ...missing.map((b) => `- ${clip(b, 60)}`)]
    : [L.cli.migrateAllPresent];
  if (shelf.problems.length) out.push(L.cli.migrateShelfProblems(shelf.problems.length), ...shelf.problems.map((p) => `- ${p}`));

  // 按行比：一行的核心是新页里某一行核心的一部分就算搬过去了（换了列表记号、编号、带了编号注释都算）
  const pageText = live.map((p) => {
    try { return readFileSync(join(cfg.root, p.rel), "utf8"); } catch { return ""; }
  }).join("\n");
  const hay = pageText.split(/\r?\n/).map(lineCore).join("\n");
  for (const { rel, error } of archivedManuals(archive)) {
    if (error !== undefined) {
      out.push(rel ? L.cli.migrateDirUnreadable(rel, error) : L.cli.migrateArchiveUnreadable(archive, error));
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(archive, rel), "utf8");
    } catch {
      out.push(L.cli.migrateFileUnreadable(rel));
      continue;
    }
    const left = manualLines(text).filter((s) => !hay.includes(s)).length;
    if (left) out.push(L.cli.migrateLinesLeft(rel, left));
  }
  return out.join("\n");
}

function caseCommand(db: Db, args: string[], o: LearnCliEnv): string {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const [id, ...words] = rest;
    const topic = words.join(" ").trim();
    if (!id || !topic) throw new Error(L.cli.caseAddUsage);
    const cur = resolveId(db, id);
    const item = one<{ kind: string }>(db, "SELECT kind FROM learn_item WHERE id = ? AND gone IS NULL", cur);
    if (!item) throw new Error(L.cli.caseUnknownId(id));
    if (item.kind !== "page") throw new Error(L.cli.caseNotPage(id));
    const n = addSeedCase(db, topic, cur, o.now());
    return L.cli.caseAdded(n, topic, cur);
  }
  if (sub === "ls") {
    const rows = all<{ id: number; topic: string; expect: string; source: string }>(db, "SELECT id, topic, expect, source FROM learn_case ORDER BY id");
    return rows.map((r) => `${r.id} ${r.source} ${r.expect} ${r.topic}`).join("\n") || L.cli.caseNone;
  }
  throw new Error(L.cli.caseUnknownAction(sub ?? ""));
}

function stats(rt: LearningRuntime, days: number, o: LearnCliEnv) {
  if (!Number.isFinite(days) || days <= 0) throw new Error(L.cli.statsUsage);
  const now = o.now();
  const rows = all<AssocRow & { skipped: string | null; candidates: number; ms: number; tokens: number }>(
    rt.db, "SELECT at, binding, mounted, shadow, skipped, candidates, ms, tokens FROM learn_assoc WHERE at >= ? AND at <= ? ORDER BY at", now - days * DAY_MS, now,
  );
  const tally = (keys: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const k of keys) out[k] = (out[k] ?? 0) + 1;
    return out;
  };
  // 耗时只看真去算了的（没内容、同一个话题是直接跳过的）；派活给帮手的不算（它给 4 秒、不在回复路径上，会把中位数拉高）
  const ms = rows.filter((r) => r.skipped !== "lowinfo" && r.skipped !== "same" && r.skipped !== "budget" && r.binding !== "helper").map((r) => Number(r.ms)).sort((a, b) => a - b);
  const mid = ms.length >> 1;
  const median = !ms.length ? 0 : ms.length % 2 ? ms[mid]! : (ms[mid - 1]! + ms[mid]!) / 2;
  const tokens = rows.reduce((n, r) => n + Number(r.tokens), 0);
  // 每次挂几页：判过的叫醒和开始做事（她自己找的一次列很多页，不算）
  const judged = rows.filter((r) => !NOT_MOUNTS.has(r.binding ?? "") && (r.skipped === null || (r.skipped === "nothing" && Number(r.candidates) > 0)));
  const pagesPerMount = tally(judged.map((r) => {
    try { return String((JSON.parse(r.mounted) as unknown[]).length); } catch { return "?"; }
  }));
  const { mounts, opened } = caught(rt.db, rt.shelf(), rows);
  // 纠正题问到的概率（情境每次都记，kv 里一个列表）：过门槛几次，差一点的列出来看是不是漏了
  let asked: Array<{ at: number; seq: number | null; p: number }> = [];
  try { asked = (JSON.parse(kvGet(rt.db, "learn.correction.asked") ?? "[]") as typeof asked).filter((x) => x.at >= now - days * DAY_MS && x.at <= now); } catch { /* 坏了当没有 */ }
  const line = o.cfg.threshold;
  return {
    days,
    calls: rows.length,
    byBinding: tally(rows.map((r) => r.binding ?? "?")),
    skipped: tally(rows.flatMap((r) => (r.skipped ? [r.skipped] : []))),
    ms: { median, max: ms.at(-1) ?? 0 },
    tokens,
    usd: Math.round(tokens * USD_PER_TOKEN * 1e4) / 1e4,
    pagesPerMount,
    mounts,
    opened,
    catchRate: mounts ? Math.round((opened / mounts) * 100) / 100 : null,
    corrections: {
      asked: asked.length,
      over: asked.filter((x) => x.p >= line).length,
      near: asked.filter((x) => x.p < line && x.p >= line - NEAR_MISS).map((x) => ({ seq: x.seq, p: x.p })),
    },
  };
}
