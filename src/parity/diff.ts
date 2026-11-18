// 对照工具的 diff 命令：逐条比较两次 dump 的记录（和两份 census），说清楚哪里不一样。
//   diff <out A> <out B> [--census <file A> <file B>] [--all] [--brief]
//   diff --census <file A> <file B> [--brief]                   只比两份 census
// 输出是纯文本、稳定（不带时间、不带临时目录的绝对路径）；最后一行是结论：一样退出 0，不一样退出 1，用法 / 读文件出错退出 2。
// 比两次 dump 时第一行是两边 meta.json 里的 label（dump --label 给的，包装脚本给的是提交号）：比的是哪两版写在报告里。
// A、B 是同一个目录不比（自己比自己永远一样），退出 2；两边的 label 一样照比，stderr 上说一句（同一版跑两遍证明的是工具稳定，不是两版一样）。
// 两边的 meta.json 都写了 snapshot 而且不一样：不是同一份数据跑的，比了也没意义，stderr 说一句、退出 2。
// 两边一个场景都没有也退出 2（不能报「一样」）；meta.json 列了却没有 transcript.jsonl 的场景报成那一边少了。
// meta.json 里 ok: false 的场景（挂了、超时）不拿来比：哪一边挂了就报哪一边，挂了的场景永远不算一样；
// 没写 ok 的（早先的 dump）有 transcript 才当 ok。有 transcript 却没有 meta.json 的 dump、有 meta.json 没列的 transcript 的 dump
// （半路断了、不是 dump 写的、混进了别的一次的记录）不比，退出 2。
// meta.json 里没写 sandbox: true 的一边（dump --no-sandbox：场景子进程没套内核沙箱；或者早先的 dump、来历不明：没写这一项）照比，stderr 上说一句。
// 每个场景底下把工具自己记的 info 级 parity: 日志打出来（各入口走了几条、工具调了几个、这一天没走到哪几种：只有数，没有原文）：
// 两边一样打一遍，不一样两边各打（那本身也是一条不一样的记录）；--brief 也打。
// 比记录之前先把两边的记录列表对齐（整条记录当一行，做最长公共子序列）：中间多了或少了一条，后面的记录照样一一对上，
// 不会因为错位全报成「不一样」。对不上的一段（A 里 k 条、B 里 l 条）按顺序两两配对报成 changed，多出来的报成 added / removed；
// 对齐的表太大时（LCS_CELLS_MAX）退回按位置配对，并且说一句。
// 记录器给每条记录盖的位置戳（顶层的 n = 这条在文件里是第几条）不算内容：前面插了或删了一条，后面每条的戳都跟着变，
// 拿带戳的整行去对齐就一条都对不上（11-13 真的 dump 上就是这样：插了两条，报成 230 条 changed）。对齐和比字段都先把戳拿掉；
// 位置照旧写在 n= 里（两边不一样写 a→b）。只认「顶层、等于自己位置」的 n，嵌在里面的、对不上位置的照常算内容。
// 默认每个场景只展开前 5 条不一样的记录（--all 全展开），字符串字段给按行的 unified diff（上下文 2 行）。
// --brief：记录里都是私人文字，要拿出本机私人目录的报告不能引用原文——只给长度、sha256 前 12 位；改动的那一小段
// （去掉相同的头尾后剩下的中间）只有两边都不超过 20 字、两条记录又是同一种时才引：一段对不上的记录里按顺序配成一对的两条
// 可能互不相干，两段不相干的话没有相同的头尾，「改动的那一段」就是整句原文。census 也只给种类、长度和 sha256 前缀。
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** dumps 为 null 时只比 census */
export interface DiffOptions { dumps: [string, string] | null; census: [string, string] | null; all: boolean; brief: boolean }

interface FieldDiff { path: string; a: Json | undefined; b: Json | undefined }

type Tag = " " | "-" | "+";
/** 一行编辑；ai / bi 是这一行之前 A / B 各已经过了几行（算 @@ 行号用） */
interface Op { tag: Tag; line: string; ai: number; bi: number }

const SHOWN = 5;
const CONTEXT = 2;
/** --brief 里改动的那一段最多引这么多字（两边都不超过才引） */
const SPAN_QUOTE_MAX = 20;
const PREVIEW_MAX = 200;
// LCS 表的格子上限：中间几千行对几千行时不求最小编辑，免得一张表吃掉几百 MB
const LCS_CELLS_MAX = 4_000_000;

const USAGE = "usage: diff <out A> <out B> [--census <file A> <file B>] [--all] [--brief]\n       diff --census <file A> <file B> [--brief]";

/** 两次 dump 不能比（不是同一份快照）：原话打到 stderr，不加 diff: 前缀 */
class NotComparable extends Error {}

// 和 census 文件一样按 UTF-8 字节序排（不是 JS 默认的 UTF-16 码元序）。
// census.ts 里有一份一样的，故意抄一份：从那边 import 会让 diff 也去加载 typescript
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function isObject(v: Json | undefined): v is { [key: string]: Json } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// 按码点算：截断不会把一个 emoji 劈成两半
function chars(s: string): string[] {
  return Array.from(s);
}

function sha12(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

/** 截到 max 个字，截了就在后面加 … */
function cap(s: string, max: number): string {
  const cs = chars(s);
  return cs.length > max ? `${cs.slice(0, max).join("")}…` : s;
}

function parseDiffArgs(argv: string[]): DiffOptions {
  const dirs: string[] = [];
  let census: [string, string] | null = null;
  let all = false;
  let brief = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--all") all = true;
    else if (arg === "--brief") brief = true;
    else if (arg === "--census") {
      const fa = argv[i + 1];
      const fb = argv[i + 2];
      if (fa === undefined || fb === undefined) throw new Error(`--census needs two files\n${USAGE}`);
      census = [fa, fb];
      i += 2;
    } else if (arg.startsWith("--")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else dirs.push(arg);
  }
  if (dirs.length === 2) return { dumps: [dirs[0]!, dirs[1]!], census, all, brief };
  if (dirs.length === 0 && census) return { dumps: null, census, all, brief };
  throw new Error(USAGE);
}

// ---------- 按行的 unified diff ----------

/**
 * 按行的最小编辑（LCS）：先去掉相同的头尾，只对中间做动态规划。
 * 中间的格子数超过 cellsMax 就退回整段删、整段加，并用 fellBack 说明（调用方不能从 ops 里猜：正好全删全加也是一种合法的结果）
 */
function alignLines(a: readonly string[], b: readonly string[], cellsMax: number): { ops: Op[]; fellBack: boolean } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const ma = a.slice(p, a.length - s);
  const mb = b.slice(p, b.length - s);
  const m = ma.length;
  const n = mb.length;
  const tags: Tag[] = [];
  const fits = (m + 1) * (n + 1) <= cellsMax;
  if (fits) {
    // lcs[i*w+j] = ma[i..] 和 mb[j..] 的最长公共子序列长度
    const w = n + 1;
    const lcs = new Uint32Array((m + 1) * w);
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        lcs[i * w + j] = ma[i] === mb[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m || j < n) {
      if (i < m && j < n && ma[i] === mb[j]) { tags.push(" "); i++; j++; }
      else if (j >= n || (i < m && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) { tags.push("-"); i++; }
      else { tags.push("+"); j++; }
    }
  } else {
    // 太大就整段删、整段加：不是最小的，但仍然是对的 diff
    for (let i = 0; i < m; i++) tags.push("-");
    for (let j = 0; j < n; j++) tags.push("+");
  }
  const ops: Op[] = [];
  let ai = 0;
  let bi = 0;
  const emit = (tag: Tag): void => {
    ops.push({ tag, line: tag === "+" ? b[bi]! : a[ai]!, ai, bi });
    if (tag !== "+") ai++;
    if (tag !== "-") bi++;
  };
  for (let k = 0; k < p; k++) emit(" ");
  for (const t of tags) emit(t);
  for (let k = 0; k < s; k++) emit(" ");
  return { ops, fellBack: !fits };
}

function lineOps(a: readonly string[], b: readonly string[]): Op[] {
  return alignLines(a, b, LCS_CELLS_MAX).ops;
}

/** 两段文字按行比，给 unified diff 的块（@@ 行 + 带 " "/"-"/"+" 前缀的行），上下文 context 行 */
export function unifiedHunks(a: string, b: string, context = CONTEXT): string[] {
  const ops = lineOps(a.split("\n"), b.split("\n"));
  const changes = ops.flatMap((o, k) => (o.tag === " " ? [] : [k]));
  const out: string[] = [];
  for (let k = 0; k < changes.length; k++) {
    const start = Math.max(0, changes[k]! - context);
    // 两处改动之间相同的行不超过 2×context 就并成一块
    while (k + 1 < changes.length && changes[k + 1]! - changes[k]! <= 2 * context + 1) k++;
    const block = ops.slice(start, Math.min(ops.length, changes[k]! + context + 1));
    const aLen = block.filter((o) => o.tag !== "+").length;
    const bLen = block.filter((o) => o.tag !== "-").length;
    const first = block[0]!;
    out.push(`@@ -${aLen ? first.ai + 1 : first.ai},${aLen} +${bLen ? first.bi + 1 : first.bi},${bLen} @@`);
    for (const o of block) out.push(`${o.tag}${o.line}`);
  }
  return out;
}

/** 去掉相同的头尾，两边各剩下的中间那段（按码点，免得劈开 emoji） */
export function changedSpan(a: string, b: string): [string, string] {
  const ca = chars(a);
  const cb = chars(b);
  let p = 0;
  while (p < ca.length && p < cb.length && ca[p] === cb[p]) p++;
  let s = 0;
  while (s < ca.length - p && s < cb.length - p && ca[ca.length - 1 - s] === cb[cb.length - 1 - s]) s++;
  return [ca.slice(p, ca.length - s).join(""), cb.slice(p, cb.length - s).join("")];
}

/**
 * --brief 里一个字符串字段怎么说：长度、sha 前缀；改动的那一段只在引得起的时候引（quotable：两条记录是同一种，
 * 而且两边那一段都不超过 SPAN_QUOTE_MAX 字），不然只说那一段各有多长
 */
function briefField(a: string, b: string, quotable: boolean): string {
  const [sa, sb] = changedSpan(a, b);
  const [la, lb] = [chars(sa).length, chars(sb).length];
  const span = quotable && la <= SPAN_QUOTE_MAX && lb <= SPAN_QUOTE_MAX
    ? `changed ${JSON.stringify(sa)} → ${JSON.stringify(sb)}`
    : `changed span len ${la} → ${lb} (not quoted)`;
  return `len ${chars(a).length} → ${chars(b).length}, sha ${sha12(a)} → ${sha12(b)}, ${span}`;
}

// ---------- 记录 ----------

function keyPath(path: string, key: string): string {
  if (!/^[A-Za-z_$][\w$]*$/.test(key)) return `${path}[${JSON.stringify(key)}]`;
  return path ? `${path}.${key}` : key;
}

/** 两条记录哪些字段不一样：对象按键、数组按位置往下走，到值不一样的地方停（少了的一边是 undefined） */
function fieldDiffs(a: Json | undefined, b: Json | undefined, path = "", out: FieldDiff[] = []): FieldDiff[] {
  if (isObject(a) && isObject(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) fieldDiffs(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined, keyPath(path, k), out);
  } else if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) fieldDiffs(a[i], b[i], `${path}[${i}]`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push({ path: path || "(record)", a, b });
  }
  return out;
}

function kindOf(rec: Json): string {
  return isObject(rec) && typeof rec.kind === "string" ? rec.kind : "?";
}

function preview(v: Json | undefined): string {
  return v === undefined ? "(absent)" : cap(JSON.stringify(v), PREVIEW_MAX);
}

function parseLine(line: string, where: string): Json {
  try {
    return JSON.parse(line) as Json;
  } catch {
    throw new Error(`${where}: not a JSON record`);
  }
}

/** 记录器盖的位置戳：顶层的 n，等于这条记录在文件里的位置（src/parity/recorder.ts）。是戳就拿掉，不是就原样 */
function withoutStamp(rec: Json, index: number): Json {
  if (!isObject(rec) || rec.n !== index) return rec;
  const rest: { [key: string]: Json } = {};
  for (const [k, v] of Object.entries(rec)) if (k !== "n") rest[k] = v;
  return rest;
}

/**
 * 对齐用的那一行：位置戳拿掉以后的记录（键的先后照原样，两边用的是同一个办法，能比）。
 * 这一行里根本没有 "n":<位置> 这几个字的不用解析；不是 JSON 的原样留着，后面比到它的时候照旧报错
 */
function alignKey(line: string, index: number): string {
  if (!line.includes(`"n":${index}`)) return line;
  let rec: Json;
  try {
    rec = JSON.parse(line) as Json;
  } catch {
    return line;
  }
  const rest = withoutStamp(rec, index);
  return rest === rec ? line : JSON.stringify(rest);
}

/** na / nb 是这条记录在 A / B 里的位置；两边一样只写一个，不一样写 na→nb（前面插了或删了记录）。位置戳不算字段 */
function recordDiff(scenario: string, na: number, nb: number, la: string, lb: string, brief: boolean): string[] {
  const a = withoutStamp(parseLine(la, `A ${scenario} record ${na}`), na);
  const b = withoutStamp(parseLine(lb, `B ${scenario} record ${nb}`), nb);
  const fields = fieldDiffs(a, b);
  const ka = kindOf(a);
  const kb = kindOf(b);
  const paths = fields.length ? fields.map((f) => f.path).join(", ") : "(same values, different bytes)";
  const lines = [`  n=${na === nb ? na : `${na}→${nb}`} kind=${ka === kb ? ka : `${ka}→${kb}`}: ${paths}`];
  for (const f of fields) {
    if (typeof f.a === "string" && typeof f.b === "string") {
      if (brief) {
        lines.push(`    ${f.path}: ${briefField(f.a, f.b, ka === kb)}`);
      } else {
        lines.push(`    ${f.path}:`, ...unifiedHunks(f.a, f.b).map((l) => `      ${l}`));
      }
    } else if (!brief) {
      lines.push(`    ${f.path}: ${preview(f.a)} → ${preview(f.b)}`);
    }
  }
  return lines;
}

function readRecords(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/** 真有 transcript.jsonl 的场景目录 */
function scenarioDirs(out: string): string[] {
  return readdirSync(out, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(out, d.name, "transcript.jsonl")))
    .map((d) => d.name);
}

interface Meta { present: boolean; snapshot: string | null; sandbox: boolean | null; label: string | null; scenarios: string[]; failed: Set<string> }

/**
 * <out>/meta.json 的 snapshot、sandbox、列出的场景名、挂了的场景（ok: false；没写 ok 又没有 transcript 的也算）；
 * 没有 meta.json、没写 snapshot 都当不知道；没写 sandbox（早先的 dump）记成 null，跟 false 一样要说一句
 */
function readMeta(dir: string, side: string): Meta {
  const p = join(dir, "meta.json");
  if (!existsSync(p)) return { present: false, snapshot: null, sandbox: null, label: null, scenarios: [], failed: new Set() };
  let meta: unknown;
  try { meta = JSON.parse(readFileSync(p, "utf8")); } catch { throw new Error(`${side} meta.json is not JSON`); }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) throw new Error(`${side} meta.json is not an object`);
  const { snapshot, sandbox, label, scenarios = [] } = meta as { snapshot?: unknown; sandbox?: unknown; label?: unknown; scenarios?: unknown };
  if (sandbox !== undefined && typeof sandbox !== "boolean") throw new Error(`${side} meta.json: sandbox is not true or false`);
  if (label !== undefined && label !== null && typeof label !== "string") throw new Error(`${side} meta.json: label is not a string`);
  if (!Array.isArray(scenarios) || !scenarios.every((e) => typeof e === "object" && e !== null && typeof (e as { name?: unknown }).name === "string")) {
    throw new Error(`${side} meta.json: scenarios is not a list of {name}`);
  }
  const entries = scenarios as Array<{ name: string; ok?: unknown }>;
  const bad = entries.find((e) => e.ok !== undefined && typeof e.ok !== "boolean");
  if (bad) throw new Error(`${side} meta.json: scenario ${bad.name}: ok is not true or false`);
  const okOf = (e: { name: string; ok?: unknown }): boolean => (typeof e.ok === "boolean" ? e.ok : existsSync(join(dir, e.name, "transcript.jsonl")));
  return {
    present: true,
    snapshot: snapshot === undefined || snapshot === null ? null : typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
    sandbox: sandbox ?? null,
    label: label ?? null,
    scenarios: entries.map((e) => e.name),
    failed: new Set(entries.filter((e) => !okOf(e)).map((e) => e.name)),
  };
}

/**
 * 一份记录里工具自己的 info 级 parity: 日志（msg）。先按字面筛一遍再解析：规范 JSON 里键排好了序、没有空白，
 * 字符串里的引号都转义了，所以 "kind":"log" 这几个字只会出现在 log 记录上
 */
function summaryLines(records: readonly string[], where: string): string[] {
  const out: string[] = [];
  records.forEach((line, i) => {
    if (!line.includes('"kind":"log"') || !line.includes('"level":"info"')) return;
    const rec = parseLine(line, `${where} record ${i}`);
    if (isObject(rec) && rec.kind === "log" && rec.level === "info" && typeof rec.msg === "string" && rec.msg.startsWith("parity:")) out.push(rec.msg);
  });
  return out;
}

/** 记录里的 name 字段，只在它是个代码里的标识符时才给（一个函数名、工具名），不给内容；没有就是空串 */
function codeName(rec: Json): string {
  if (!isObject(rec)) return "";
  const name = rec.name;
  return typeof name === "string" && name.length <= 64 && /^[A-Za-z_$][\w$.]*$/.test(name) ? ` name=${name}` : "";
}

/** 只在一边有的记录：一行（位置、种类、可能有的 name、长度、sha），不带 --brief 时下面再给截短的原文 */
function oneSided(sign: "+" | "-", side: string, scenario: string, n: number, line: string, brief: boolean): string[] {
  const rec = parseLine(line, `${side} ${scenario} record ${n}`);
  const head = `  ${sign} n=${n} kind=${kindOf(rec)}${codeName(rec)}: len ${chars(line).length}, sha ${sha12(line)}`;
  return brief ? [head] : [head, `    ${cap(line, PREVIEW_MAX)}`];
}

/**
 * 一个场景两边的记录先对齐再比（见文件头）；对齐看的是去掉位置戳的记录，报出来的长度、sha、原文还是整条记录的。
 * cellsMax 只有测试会改（造一张超限的表不用真的堆几百万条记录）。
 * 对不上的一段里 A 有 k 条、B 有 l 条：前 min(k, l) 条按顺序配对（changed），剩下的是 removed / added。
 */
export function diffScenario(name: string, ra: string[], rb: string[], opts: { all: boolean; brief: boolean }, cellsMax = LCS_CELLS_MAX): { lines: string[]; differs: boolean } {
  const [sa, sb] = [summaryLines(ra, `A ${name}`), summaryLines(rb, `B ${name}`)];
  const summary = sa.join("\n") === sb.join("\n") ? sa.map((l) => `  log: ${l}`) : [...sa.map((l) => `  A log: ${l}`), ...sb.map((l) => `  B log: ${l}`)];
  const { ops, fellBack } = alignLines(ra.map(alignKey), rb.map(alignKey), cellsMax);
  if (ops.every((o) => o.tag === " ")) return { lines: [`scenario ${name}: identical, ${ra.length} records`, ...summary], differs: false };
  const pairs: Array<[number, number]> = [];
  const removed: number[] = [];
  const added: number[] = [];
  for (let k = 0; k < ops.length;) {
    if (ops[k]!.tag === " ") { k++; continue; }
    // 一段连续的不相同的操作：A 里只有的、B 里只有的各收起来（不用 push(...大数组)：退回按位置的时候一段可能有几十万条）
    const gone: number[] = [];
    const fresh: number[] = [];
    for (; k < ops.length && ops[k]!.tag !== " "; k++) {
      const o = ops[k]!;
      if (o.tag === "-") gone.push(o.ai);
      else fresh.push(o.bi);
    }
    const both = Math.min(gone.length, fresh.length);
    for (let i = 0; i < both; i++) pairs.push([gone[i]!, fresh[i]!]);
    for (const i of gone.slice(both)) removed.push(i);
    for (const i of fresh.slice(both)) added.push(i);
  }
  const lines = [`scenario ${name}: ${pairs.length} changed, ${added.length} added, ${removed.length} removed (A ${ra.length} records, B ${rb.length})`, ...summary];
  if (fellBack) lines.push("  (too many differing records to align: compared by position)");
  const upTo = <T>(xs: T[]): T[] => (opts.all ? xs : xs.slice(0, SHOWN));
  const shownPairs = upTo(pairs);
  for (const [i, j] of shownPairs) lines.push(...recordDiff(name, i, j, ra[i]!, rb[j]!, opts.brief));
  if (shownPairs.length < pairs.length) lines.push(`  … ${pairs.length - shownPairs.length} more changed records (--all to show)`);
  const shownAdded = upTo(added);
  for (const j of shownAdded) lines.push(...oneSided("+", "B", name, j, rb[j]!, opts.brief));
  if (shownAdded.length < added.length) lines.push(`  … ${added.length - shownAdded.length} more added records (--all to show)`);
  const shownRemoved = upTo(removed);
  for (const i of shownRemoved) lines.push(...oneSided("-", "A", name, i, ra[i]!, opts.brief));
  if (shownRemoved.length < removed.length) lines.push(`  … ${removed.length - shownRemoved.length} more removed records (--all to show)`);
  return { lines, differs: true };
}

/** 两次 dump 逐个场景比：一边没有的场景、每个场景里不一样的记录；warnings 是照比、但要在 stderr 上说一句的 */
function diffDumps(dirA: string, dirB: string, opts: { all: boolean; brief: boolean }): { lines: string[]; differing: number; warnings: string[] } {
  const real = (d: string): string => { try { return realpathSync(d); } catch { return resolve(d); } };
  if (real(dirA) === real(dirB)) throw new Error("A and B are the same directory — a dump compared with itself is always identical");
  const metaA = readMeta(dirA, "A");
  const metaB = readMeta(dirB, "B");
  // 没有 meta.json、meta.json 没列的记录：不知道它是哪一次跑的、挂没挂，半截的或者旧的记录可能比出「一样」
  for (const [dir, meta, side] of [[dirA, metaA, "A"], [dirB, metaB, "B"]] as const) {
    const have = scenarioDirs(dir);
    if (!meta.present && have.length) throw new Error(`${side} has transcripts but no meta.json — an interrupted or foreign dump`);
    const unlisted = have.filter((n) => !meta.scenarios.includes(n)).sort(compareBytes);
    if (unlisted.length) throw new Error(`${side} has a transcript meta.json does not list (${unlisted.join(", ")}) — an interrupted or foreign dump`);
  }
  if (metaA.snapshot !== null && metaB.snapshot !== null && metaA.snapshot !== metaB.snapshot) {
    throw new NotComparable(`parity: the two dumps come from different snapshots (${metaA.snapshot} vs ${metaB.snapshot}) — not comparable`);
  }
  const inA = new Set(scenarioDirs(dirA));
  const inB = new Set(scenarioDirs(dirB));
  // meta.json 列了、目录里却没有 transcript 的也算进来：报成那一边少了，不能悄悄跳过
  const names = [...new Set([...inA, ...inB, ...metaA.scenarios, ...metaB.scenarios])].sort(compareBytes);
  // 两边一个场景都没有（dump 什么都没写出来，或者目录给错了）：比出来「一样」是假的
  if (!names.length) throw new Error("neither dump has any scenario (no <scenario>/transcript.jsonl, none listed in meta.json)");
  const shown = (m: Meta): string => m.label ?? "(no label)";
  const lines: string[] = [`dumps: A=${shown(metaA)} B=${shown(metaB)}`];
  let differing = 0;
  for (const name of names) {
    if (!inA.has(name) && !inB.has(name)) {
      lines.push(`scenario ${name}: in neither A nor B (listed in meta.json, no transcript.jsonl)`);
      differing++;
      continue;
    }
    if (!inA.has(name) || !inB.has(name)) {
      const [has, lacks] = inA.has(name) ? ["A", metaB] : ["B", metaA];
      const missing = has === "A" ? "B" : "A";
      const why = lacks.scenarios.includes(name) ? ` (${missing}'s meta.json lists it, but ${missing} has no transcript.jsonl)` : "";
      lines.push(`scenario ${name}: only in ${has}${why}`);
      differing++;
      continue;
    }
    const failedIn = [metaA.failed.has(name) ? "A" : "", metaB.failed.has(name) ? "B" : ""].filter(Boolean);
    if (failedIn.length) {
      lines.push(`scenario ${name}: failed in ${failedIn.length === 2 ? "both" : failedIn[0]}`);
      differing++;
      continue;
    }
    const r = diffScenario(name, readRecords(join(dirA, name, "transcript.jsonl")), readRecords(join(dirB, name, "transcript.jsonl")), opts);
    lines.push(...r.lines);
    if (r.differs) differing++;
  }
  // 有 meta.json 却没写 sandbox: true：明说了没套（false），或者没写这一项（早先的 dump、来历不明）——都当没套
  const unconfined = ([[metaA, "A"], [metaB, "B"]] as const).filter(([m]) => m.present && m.sandbox !== true).map(([, side]) => side);
  const warnings = unconfined.length
    ? [`warning: ${unconfined.join(" and ")}: meta.json does not say sandbox: true (dumped with --no-sandbox, or of unknown origin) — the scenario processes were not confined by the kernel sandbox`]
    : [];
  if (metaA.label !== null && metaA.label === metaB.label) {
    warnings.push(`warning: A and B carry the same label (${metaA.label}) — the same tree dumped twice shows that the replay is deterministic, not that two trees agree`);
  }
  return { lines, differing, warnings };
}

// ---------- census ----------

interface CensusEntry { count: number; kind: string; text: string; json: string }

function parseCensus(text: string, side: string): Map<string, CensusEntry> {
  const entries = new Map<string, CensusEntry>();
  text.split("\n").forEach((line, i) => {
    if (line === "") return;
    // 按前两个 tab 切，不用带 . 的正则：JSON.stringify 不转义 U+2028 / U+2029，而 . 不匹配它们
    // （JSON 文字里的 tab 和换行都被转义了，所以第三段就是整个 JSON）
    const t1 = line.indexOf("\t");
    const t2 = t1 < 0 ? -1 : line.indexOf("\t", t1 + 1);
    const count = line.slice(0, t1);
    const kind = line.slice(t1 + 1, t2);
    const json = line.slice(t2 + 1);
    let value: unknown;
    try { value = JSON.parse(json); } catch { /* 下面报错 */ }
    if (t2 < 0 || !/^\d+$/.test(count) || !/^[a-z]+$/.test(kind) || typeof value !== "string") {
      throw new Error(`census ${side} line ${i + 1}: not a census line`);
    }
    entries.set(`${kind}\t${json}`, { count: Number(count), kind, text: value, json });
  });
  return entries;
}

/**
 * 两份 census 按行比：只在 A 的行算 removed，只在 B 的行算 added。
 * 同一句话只是次数变了，两边各有一行不一样（+1 −1），合在一起显示成 `次数A → 次数B`。
 */
export function diffCensus(textA: string, textB: string, brief: boolean): { lines: string[]; added: number; removed: number } {
  const ca = parseCensus(textA, "A");
  const cb = parseCensus(textB, "B");
  const keys = [...new Set([...ca.keys(), ...cb.keys()])];
  const entryOf = (k: string): CensusEntry => (ca.get(k) ?? cb.get(k))!;
  keys.sort((x, y) => compareBytes(entryOf(x).kind, entryOf(y).kind) || compareBytes(entryOf(x).text, entryOf(y).text));
  const show = (e: CensusEntry): string => (brief ? `len ${chars(e.text).length} sha ${sha12(e.text)}` : e.json);
  const entries: string[] = [];
  let added = 0;
  let removed = 0;
  for (const k of keys) {
    const ea = ca.get(k);
    const eb = cb.get(k);
    if (ea && eb) {
      if (ea.count === eb.count) continue;
      added++;
      removed++;
      entries.push(`  count    ${ea.count} → ${eb.count}  ${ea.kind}  ${show(ea)}`);
    } else if (ea) {
      removed++;
      entries.push(`  removed  ×${ea.count}  ${ea.kind}  ${show(ea)}`);
    } else if (eb) {
      added++;
      entries.push(`  added    ×${eb.count}  ${eb.kind}  ${show(eb)}`);
    }
  }
  return { lines: entries.length ? [`census: +${added} −${removed}`, ...entries] : ["census: identical"], added, removed };
}

// ---------- 命令 ----------

/** text 是 stdout 上的报告，warnings 是该打到 stderr 的（不影响结论和退出码） */
export function diffReport(opts: DiffOptions): { text: string; code: number; warnings: string[] } {
  const dumps = opts.dumps ? diffDumps(opts.dumps[0], opts.dumps[1], opts) : null;
  const census = opts.census
    ? diffCensus(readFileSync(opts.census[0], "utf8"), readFileSync(opts.census[1], "utf8"), opts.brief)
    : null;
  const differing = dumps?.differing ?? 0;
  const added = census?.added ?? 0;
  const removed = census?.removed ?? 0;
  const same = differing === 0 && added === 0 && removed === 0;
  const verdict = same ? "parity: identical"
    : dumps ? `parity: ${differing} scenario(s) differ, census +${added} −${removed}`
    : `parity: census +${added} −${removed}`;
  return { text: [...(dumps?.lines ?? []), ...(census?.lines ?? []), verdict].map((l) => `${l}\n`).join(""), code: same ? 0 : 1, warnings: dumps?.warnings ?? [] };
}

export async function runDiff(argv: string[]): Promise<number> {
  try {
    const r = diffReport(parseDiffArgs(argv));
    for (const w of r.warnings) process.stderr.write(`diff: ${w}\n`);
    process.stdout.write(r.text);
    return r.code;
  } catch (e) {
    process.stderr.write(e instanceof NotComparable ? `${e.message}\n` : `diff: ${(e as Error).message}\n`);
    return 2;
  }
}
