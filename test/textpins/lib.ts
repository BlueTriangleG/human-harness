// 文字钉子的公共库（给「把文字挪进语言包」这类改动用）：
//   · 一张有名字的调用清单（createRegistry），每条调用返回「今天这个东西在这种情况下说的原话」；
//   · 把每条的文字拆成两半各钉一个指纹（splitRest / pinsOf / checkPins）：回复本身，和回复后面接的踪迹 / 文件；
//   · 一道「覆盖闸」（reach）：用 V8 覆盖证明清单没有漏——被管的文件里每个带文字的行都被跑到、行上的每个分支都走到、
//     起在带文字的行上的函数都被调用过。
// 这个库跟具体的文字无关：绑定名（T、M……）、被管的文件、临时根、要不要换掉的内容，都由调用的一方传进来。
// 导入这个文件没有任何副作用：不改环境变量和时区、不建临时目录、不建任何工具、不注册任何钩子。要这些的函数（withEnv、reach）
// 自己在被调用时做、做完还原。
// 以后的范围（记忆、大脑）只导入这个库，在自己的目录（test/memtext/ 之类）里放夹具、清单、pin.ts、coverage.run.ts。
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { z } from "zod";
import type { ToolDef } from "../../src/kernel/types.ts";
import { callTool } from "../../src/kernel/fake.ts";

// ---------- 指纹和拆分 ----------

/** 文字的指纹：sha256 前 16 位 + 字节数（字节数让「只差一个字」之外的长度变化也看得见） */
export const pinOf = (text: string): string => `${createHash("sha256").update(text).digest("hex").slice(0, 16)}/${Buffer.byteLength(text)}`;

export interface Rendered { reply: string; rest: string }
export interface Pin { reply: string; rest?: string }

/** 夹具里接在回复后面的两种记号：踪迹（假对象被问了什么）、文件（调用后某个文件的样子） */
const REST_MARKER = /\n--- (?:trace|file) ---(?:\n|$)/;

/**
 * 把一条的文字拆成「回复」和「其余」：其余是第一个 `\n--- trace ---` 或 `\n--- file ---` 记号起的全部（没有记号 = 空），
 * 回复是记号前面的。reply + rest 恒等于原文。
 * 做法上的决定：记号后面是换行或正好是文字的结尾都算（踪迹为空时文字就停在记号那一行）。
 */
export function splitRest(text: string): Rendered {
  const m = REST_MARKER.exec(text);
  if (!m) return { reply: text, rest: "" };
  return { reply: text.slice(0, m.index), rest: text.slice(m.index) };
}

/**
 * 把临时根换成 <TMP>（JSON 转义过的写法也换），再依次做 extra 里的替换（每次运行都不同的东西，比如带时间戳的文件名）。
 * 临时根是参数，不在这里建
 */
export function makeNorm(root: string, extra: ReadonlyArray<readonly [RegExp, string]> = []): (text: string) => string {
  const rootJson = JSON.stringify(root).slice(1, -1);
  return (text) => extra.reduce((t, [re, to]) => t.replace(re, to), text.split(root).join("<TMP>").split(rootJson).join("<TMP>"));
}

// ---------- 夹具的错 ----------

/** 夹具自己坏了（缺工具、参数没写全、名单对不上……）：不是工具说的话，必须让整张清单大声失败 */
export class FixtureError extends Error {
  override name = "FixtureError";
}

/** TypeError / ReferenceError / FixtureError 是夹具的毛病（调了不存在的东西、拼错了名字），不是工具的话 */
export const isHarnessError = (e: unknown): boolean => e instanceof TypeError || e instanceof ReferenceError || e instanceof FixtureError;

/** 捕到的东西记成 `threw: 原因`；夹具的错原样再抛。夹具里自己写 try/catch 记「抛了」的地方都走这个 */
export function caught(e: unknown): string {
  if (isHarnessError(e)) throw e;
  return `threw: ${e instanceof Error ? e.message : String(e)}`;
}

// ---------- 清单 ----------

export interface Call { id: string; run(): string | Promise<string> }

/** 一张清单：add 登记（id 不许重复，也不许叫 env——pins 文件里那个名字归环境），calls 是登记的顺序 */
export function createRegistry(): { add(id: string, run: () => string | Promise<string>): void; calls: readonly Call[] } {
  const calls: Call[] = [];
  const ids = new Set<string>();
  return {
    calls,
    add(id, run) {
      if (id === "env") throw new FixtureError("call id \"env\" is reserved for the environment entry of the pins file");
      if (ids.has(id)) throw new FixtureError(`duplicate call id: ${id}`);
      ids.add(id);
      calls.push({ id, run });
    },
  };
}

/** 按顺序一条一条跑（一次一条）；每条的文字过 norm 再拆成两半。夹具的错（isHarnessError）带上 id 再抛，其余抛出来的记成 threw: 原因 */
export async function renderAll(calls: readonly Call[], norm: (text: string) => string): Promise<Record<string, Rendered>> {
  const out: Record<string, Rendered> = {};
  for (const c of calls) {
    let text: string;
    try {
      text = await c.run();
    } catch (e) {
      if (isHarnessError(e)) throw new FixtureError(`call "${c.id}" is a broken fixture: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`, { cause: e });
      text = `threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    out[c.id] = splitRest(norm(text));
  }
  return out;
}

/**
 * 在改过的环境里跑 fn，跑完（不管成不成）还原：deletePrefixes 里每个前缀开头的变量先删掉（手跑时 shell 里的变量不能漏进来），
 * set 再设。库不在导入时做这些，调用的一方在渲染前后包一层
 */
export async function withEnv<T>(o: { deletePrefixes?: readonly string[]; set?: Readonly<Record<string, string>> }, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  const touch = (k: string): void => { if (!saved.has(k)) saved.set(k, process.env[k]); };
  for (const k of Object.keys(process.env)) {
    if ((o.deletePrefixes ?? []).some((p) => k.startsWith(p))) { touch(k); delete process.env[k]; }
  }
  for (const [k, v] of Object.entries(o.set ?? {})) { touch(k); process.env[k] = v; }
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ---------- 经工具调用 ----------

/** 经内核自己的 zod 解析再调 handler（跟真的一样）；handler 抛了记成 threw: 原因（夹具的错除外，见 caught）；参数不合格的结果前面写 isError: */
export async function viaTool(def: ToolDef, args: Record<string, unknown>): Promise<string> {
  try {
    const r = await callTool(def, args);
    return r.isError ? `isError: ${r.text}` : r.text;
  } catch (e) {
    return caught(e);
  }
}
/** 绕过 zod 直接调 handler（zod 会拒的参数 handler 仍有话说时用） */
export async function viaHandler(def: ToolDef, args: Record<string, unknown>): Promise<string> {
  try { return await def.handler(args); } catch (e) { return caught(e); }
}
/** 从一串工具里按名字取；没有就是夹具的错 */
export function need(tools: readonly ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new FixtureError(`no tool ${name} in [${tools.map((x) => x.name).join(", ")}]`);
  return t;
}

/**
 * 工具的定义：名字、说明、三种方式导出的 JSON Schema、参数顺序。
 * 第三种是内核的 SDK 真正交给模型的那一份。读法：node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs（打包好的一个文件）里，
 * 进程内 MCP 服务（createSdkMcpServer）的 tools/list 处理函数对每个工具调
 *   qd(Ns(inputSchema), { strictUnions: true, pipeStrategy: "input" })
 * Ns 把原始 shape 包成 zod 对象（等于 z.object(shape)），qd 对 zod v4 的对象走打包进去的那份 zod 的 toJSONSchema：
 *   toJSONSchema(schema, { target: "draft-7", io: "input" })
 * （target 缺省时 qd 的 nke 也归到 "draft-7"；pipeStrategy → io）。src/kernel/sdk.ts 的 mcpServer() 把 spec.tools 的 shape 原样交给 tool()，
 * 所以这里用同一个调用。SDK 带的 zod 不一定跟这个仓库装的是同一个小版本：差别在 pins 的 env 里的 zod 版本管不到 SDK 那份，
 * 升 SDK 以后这一份的指纹变了就要重钉
 */
export function defText(d: ToolDef, variant = "?"): string {
  // 转换抛了（不管是什么错）就是夹具 / 工具定义坏了：不能把定义钉成 threw: …
  const render = (which: string, f: () => unknown): unknown => {
    try { return f(); } catch (e) { throw new FixtureError(`def ${variant}/${d.name}: the ${which} schema rendering failed: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
  };
  return JSON.stringify([
    d.name, d.description,
    render("default (z.toJSONSchema(obj))", () => z.toJSONSchema(z.object(d.shape))),
    render("reused:ref", () => z.toJSONSchema(z.object(d.shape), { reused: "ref" })),
    render("SDK (target draft-7, io input)", () => z.toJSONSchema(z.object(d.shape), { target: "draft-7", io: "input" })),
    Object.keys(d.shape),
  ]);
}

// ---------- 钉子文件 ----------

export interface Env { node: string; icu: string; zod: string }

/** 钉子是在哪个环境里生成的：zod 的拒绝文字、ICU 的排序 / 格式只对这几个版本成立 */
export function envOf(): Env {
  const zod = (createRequire(import.meta.url)("zod/package.json") as { version: string }).version;
  return { node: process.versions.node, icu: process.versions.icu ?? "none", zod };
}

/** 钉子文件的内容：先是 env，再是每个 id（排序）的 { reply, rest? }（rest 为空就不写） */
export function pinsOf(rendered: Readonly<Record<string, Rendered>>, env: Env = envOf()): Record<string, unknown> {
  const pins: Record<string, unknown> = { env };
  for (const id of Object.keys(rendered).sort()) {
    const r = rendered[id];
    if (!r) continue;
    const pin: Pin = { reply: pinOf(r.reply) };
    if (r.rest) pin.rest = pinOf(r.rest);
    pins[id] = pin;
  }
  return pins;
}

/** 可读的全文：{ id: { reply, rest } }（id 排序）。给人读、放在仓库外，不提交——里面有工具自己的措辞 */
export function textsOf(rendered: Readonly<Record<string, Rendered>>): Record<string, Rendered> {
  const out: Record<string, Rendered> = {};
  for (const id of Object.keys(rendered).sort()) { const r = rendered[id]; if (r) out[id] = r; }
  return out;
}

/**
 * 拿现在渲染出来的跟钉子文件比。一切都对 = null；否则回一条说明：
 *  · env 对不上：只回一行（三个版本，钉的时候 → 现在），在比任何钉子之前；
 *  · id 的集合对不上，或有钉子对不上：每条写 id、钉的和现在的指纹、现在的全文，最后两行教人怎么办（什么时候对不上是该有的、重钉的命令）。
 * command：重新生成钉子的命令（调用的一方知道自己的路径）
 */
export function checkPins(file: unknown, rendered: Readonly<Record<string, Rendered>>, o: { command: string; env?: Env }): string | null {
  if (typeof file !== "object" || file === null || Array.isArray(file)) return "the pins file is not an object";
  const pins = file as Record<string, unknown>;
  const then = (pins.env ?? {}) as Partial<Env>;
  const now = o.env ?? envOf();
  if (then.node !== now.node || then.icu !== now.icu || then.zod !== now.zod) {
    return `the environment differs from the one the pins were made in — node ${then.node} -> ${now.node}, icu ${then.icu} -> ${now.icu}, zod ${then.zod} -> ${now.zod} (pinned -> now)`;
  }
  const pinned = Object.keys(pins).filter((k) => k !== "env").sort();
  const ids = Object.keys(rendered).sort();
  const problems: string[] = [];
  const onlyNow = ids.filter((i) => !(i in pins));
  const onlyPinned = pinned.filter((i) => !(i in rendered));
  if (onlyNow.length || onlyPinned.length) problems.push(`the ids of the call list and of the pins file differ:\n  only in the call list: ${onlyNow.join(" | ") || "-"}\n  only in the pins file: ${onlyPinned.join(" | ") || "-"}`);
  for (const id of ids) {
    const r = rendered[id];
    const p = pins[id] as Pin | undefined;
    if (!r || !p) continue;
    const parts: string[] = [];
    const replyNow = pinOf(r.reply);
    if (p.reply !== replyNow) parts.push(`  reply pinned ${p.reply}\n  reply now    ${replyNow}`);
    const restNow = r.rest ? pinOf(r.rest) : undefined;
    if (p.rest !== restNow) parts.push(`  rest pinned ${p.rest ?? "(none)"}\n  rest now    ${restNow ?? "(none)"}`);
    if (parts.length) problems.push(`${id}\n${parts.join("\n")}\n  reply text now:\n${r.reply}${r.rest ? `\n  rest text now:\n${r.rest}` : ""}`);
  }
  if (!problems.length) return null;
  return [
    `${problems.length} problem(s) between the call list and the pins:\n`,
    problems.join("\n\n"),
    "\nA failing pin is expected only when the base moved underneath: pins are regenerated on the tree BEFORE the moves, in the pin commit, never in a move commit.",
    `To regenerate them: ${o.command}`,
  ].join("\n");
}

// ---------- 覆盖闸 ----------

export interface TextLine { line: number; texts: string[] }

const NON_ASCII = /[^\x00-\x7f]/;
const ESCAPED_CHAR = /\\[ux]/;

/**
 * 一个文件里带文字的行：带非 ASCII 的字符串 / 模板（每一段静态文字在它自己的行上算）/ 正则字面量，再加每一处「绑定名.」的读取
 * （bindings，如 ["T"]）。找法跟 src/parity/census.ts 一样用 typescript 解析，只是这里要的是行号
 */
export function textLines(source: string, bindings: readonly string[], path = "source.ts"): TextLine[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const byLine = new Map<number, string[]>();
  const add = (node: ts.Node, text: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    byLine.set(line, [...(byLine.get(line) ?? []), text]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (NON_ASCII.test(node.text)) add(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (NON_ASCII.test(node.text)) add(node, node.text);
    } else if (ts.isRegularExpressionLiteral(node)) {
      if (NON_ASCII.test(node.text) || ESCAPED_CHAR.test(node.text)) add(node, node.text);
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && bindings.includes(node.expression.text)) {
      add(node, node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([line, texts]) => ({ line, texts }));
}

export interface LcovFn { line: number; name: string; count: number }
export interface LcovRec { path: string; da: Map<number, number>; brda: Array<{ line: number; taken: string }>; fns: LcovFn[] }

/**
 * Node 24 的 lcov 报告：每个文件一段 SF: …… end_of_record。
 * FN:<起始行>,<名字> 一串，之后 FNDA:<次数>,<名字> 一串，两串一一对应——按下标配对，不按名字（名字会重：failed、unknownAction、notWritten）。
 * DA:<行>,<次数>；BRDA:<行>,<块>,<分支>,<次数 或 ->。两串数目对不上就是报告的格式变了，大声失败
 */
export function parseLcov(text: string): LcovRec[] {
  const recs: LcovRec[] = [];
  let cur: LcovRec | null = null;
  let names: Array<{ line: number; name: string }> = [];
  let counts: number[] = [];
  for (const l of text.split("\n")) {
    let m: RegExpExecArray | null;
    if (l.startsWith("SF:")) {
      cur = { path: l.slice(3), da: new Map(), brda: [], fns: [] };
      names = []; counts = [];
    } else if (!cur) {
      continue;
    } else if (l === "end_of_record") {
      if (names.length !== counts.length) throw new FixtureError(`lcov record of ${cur.path}: ${names.length} FN lines but ${counts.length} FNDA lines`);
      cur.fns = names.map((n, i) => ({ line: n.line, name: n.name, count: counts[i] ?? 0 }));
      recs.push(cur);
      cur = null;
    } else if ((m = /^DA:(\d+),(\d+)/.exec(l))) cur.da.set(Number(m[1]), Number(m[2]));
    else if ((m = /^BRDA:(\d+),\d+,\d+,(\d+|-)$/.exec(l))) cur.brda.push({ line: Number(m[1]), taken: m[2] ?? "-" });
    else if ((m = /^FN:(\d+),(.*)$/.exec(l))) names.push({ line: Number(m[1]), name: m[2] ?? "" });
    else if ((m = /^FNDA:(\d+),(.*)$/.exec(l))) counts.push(Number(m[1]));
  }
  return recs;
}

/** 报告里某个文件（路径等于 file，或以 /file 结尾）的那一段 */
export const lcovOf = (recs: readonly LcovRec[], file: string): LcovRec | null => recs.find((r) => r.path === file || r.path.endsWith(`/${file}`)) ?? null;

/**
 * 清单够不着的文字行，豁免一行（reason 说为什么留着）：text 是这一行上某段文字（字面量，或绑定的读取 M.<组名>）的一部分；
 * code 是这一行源码的一部分，在整个文件里必须恰好落在一行上——行上的文字只有「M.<组名>」、单凭 text 会把同组的行全放过去时用它。两样至少写一样；两样都写时任一样对上就算。
 * 豁免没有「不再需要」的自查：那一行后来走到了，条目要手工删
 */
export interface Exempt { file: string; text?: string; code?: string; reason: string }

/**
 * 一个被管的文件的问题：每个带文字的行要跑到（DA > 0）、行上没有没走到的分支（BRDA 是 0 或 -）、
 * 起在这一行的函数要被调用过（FNDA > 0——一行写完的箭头函数从没被调用，行上的 DA 照样是正数、也没有 BRDA，只有 FNDA 看得见）
 */
export function fileProblems(o: { file: string; rec: LcovRec | null; source: string; bindings: readonly string[]; exempt: readonly Exempt[] }): string[] {
  const { file, rec } = o;
  if (!rec) return [`${file}: not in the coverage report`];
  const lines = textLines(o.source, o.bindings, file);
  if (lines.length === 0) return [`${file}: no text line found (if the file holds no text, list it as not-text in the caller)`];
  if (rec.da.size === 0) return [`${file}: no DA entry in the coverage record`];
  const exempt = o.exempt.filter((e) => e.file === file);
  const problems: string[] = [];
  const src = o.source.split("\n");
  for (const e of exempt) {
    if (e.text === undefined && e.code === undefined) problems.push(`${file}: an exemption names neither text nor code (${e.reason.slice(0, 40)})`);
    if (e.code !== undefined) {
      const n = src.filter((l) => l.includes(e.code!)).length;
      if (n !== 1) problems.push(`${file}: the exemption's code ${JSON.stringify(e.code)} is on ${n} lines — it must be on exactly one`);
    }
  }
  const exempted = (line: number, texts: readonly string[]): boolean =>
    exempt.some((e) => (e.text !== undefined && texts.some((t) => t.includes(e.text!))) || (e.code !== undefined && (src[line - 1] ?? "").includes(e.code)));
  const textAt = new Map<number, string[]>();
  for (const { line, texts } of lines) {
    if (exempted(line, texts)) continue;
    textAt.set(line, texts);
    const shown = (texts[0] ?? "").slice(0, 40);
    const count = rec.da.get(line);
    if (count === undefined) problems.push(`${file}:${line} has no coverage entry (${shown})`);
    else if (count === 0) problems.push(`${file}:${line} never runs (${shown})`);
    const open = rec.brda.filter((b) => b.line === line && (b.taken === "0" || b.taken === "-"));
    if (open.length) problems.push(`${file}:${line} has ${open.length} branch(es) never taken (${shown})`);
  }
  for (const f of rec.fns) {
    const texts = textAt.get(f.line);
    // 这一行已经报过「never runs」的，不再报函数（一个问题一条消息）
    if (texts && f.count === 0 && rec.da.get(f.line) !== 0) problems.push(`${file}:${f.line} function ${f.name} is never called (${(texts[0] ?? "").slice(0, 40)})`);
  }
  return problems;
}

/** 语言包文件：整个文件的行、分支、函数都要跑到 */
export function packProblems(file: string, rec: LcovRec | null): string[] {
  if (!rec) return [`${file}: not in the coverage report`];
  const problems: string[] = [];
  for (const [line, count] of rec.da) if (count === 0) problems.push(`${file}:${line} never runs`);
  for (const b of rec.brda) if (b.taken === "0" || b.taken === "-") problems.push(`${file}:${b.line} has a branch never taken`);
  for (const f of rec.fns) if (f.count === 0) problems.push(`${file}:${f.line} function ${f.name} never called`);
  return problems;
}

export interface ReachOpts {
  /** 树根（子进程的工作目录；files、packFile、run 都相对它） */
  tree: string;
  /** 清单已经管全了的文件（相对树根） */
  files: readonly string[];
  exempt: readonly Exempt[];
  /** 文字挪完以后都在这个文件里：它存在时，整个文件的行、分支、函数都要跑到 */
  packFile?: string;
  /** 读语言包的绑定名，如 ["T"] */
  bindings: readonly string[];
  /** --test-coverage-include 的各项 */
  include: readonly string[];
  /** 在本进程里把整张清单渲染一遍的那个文件（相对树根；不叫 *.test.ts） */
  run: string;
}

/**
 * 起一个子进程在 V8 覆盖下跑 run，读 lcov，回问题的清单（空 = 没有漏）。
 * 照 test/parity-prompts.test.ts 的做法：外层 node --test 给测试进程设的 NODE_TEST_CONTEXT 要去掉，不然里面的 --test 不出覆盖报告
 */
export function reach(o: ReachOpts): string[] {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const dir = mkdtempSync(join(tmpdir(), "hh-textpins-cov-"));
  try {
    const lcovFile = join(dir, "lcov.info");
    const r = spawnSync(process.execPath, [
      "--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=lcov", `--test-reporter-destination=${lcovFile}`,
      "--experimental-test-coverage", ...o.include.map((g) => `--test-coverage-include=${g}`),
      o.run,
    ], { cwd: o.tree, env, encoding: "utf8" });
    if (r.status !== 0) return [`the coverage child failed (status ${r.status}):\n${r.stdout}\n${r.stderr}`];
    if (!existsSync(lcovFile)) return [`the coverage child wrote no lcov file:\n${r.stdout}\n${r.stderr}`];
    const recs = parseLcov(readFileSync(lcovFile, "utf8"));
    const problems: string[] = [];
    for (const file of o.files) {
      problems.push(...fileProblems({ file, rec: lcovOf(recs, file), source: readFileSync(join(o.tree, file), "utf8"), bindings: o.bindings, exempt: o.exempt }));
    }
    if (o.packFile && existsSync(join(o.tree, o.packFile))) problems.push(...packProblems(o.packFile, lcovOf(recs, o.packFile)));
    return problems;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- 语言包的结构（给「包里的字都被读到了、读的是调用时的包」这类检查用） ----------

/** 包里的一个叶子：字符串或函数（带参数的回话）；路径是点分的键 */
export interface Leaf { path: string; value: string | ((...args: never[]) => unknown) }

/**
 * 包（或它的模块命名空间）里所有的叶子，按键的顺序、点分路径：字符串和函数是叶子，对象往下走。
 * 数组、正则、数、真假在包里不该有（形状上只认这三样）：遇到就是夹具的错，大声失败
 */
export function packLeaves(tree: object, prefix = ""): Leaf[] {
  const out: Leaf[] = [];
  for (const key of Object.keys(tree)) {
    const v = (tree as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof v === "string" || typeof v === "function") out.push({ path, value: v as Leaf["value"] });
    else if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RegExp)) out.push(...packLeaves(v, path));
    else throw new FixtureError(`${path}: a ${Array.isArray(v) ? "array" : v instanceof RegExp ? "regex" : typeof v} in the pack — only strings, functions and nested objects are leaves`);
  }
  return out;
}

/** 标记的写法：叶子路径夹在 ⟦ ⟧ 里 */
export const markerOf = (path: string): string => `⟦${path}⟧`;

/**
 * 同形状的一棵新树，每个叶子前面加上自己的标记：字符串 s 变 ⟦路径⟧ + s，函数 f 变 (...a) => ⟦路径⟧ + f(...a)。
 * 新树是普通对象（不是模块命名空间），可以直接当一个包的 tools 登记
 */
export function markLeaves(tree: object, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(tree)) {
    const v = (tree as Record<string, unknown>)[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof v === "string") out[key] = markerOf(path) + v;
    else if (typeof v === "function") { const f = v as (...a: unknown[]) => unknown; out[key] = (...a: unknown[]) => { const r = f(...a); if (typeof r !== "string") throw new FixtureError(`${path}: a pack function returned a ${typeof r}, not a string`); return markerOf(path) + r; }; }
    else if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RegExp)) out[key] = markLeaves(v, path);
    else throw new FixtureError(`${path}: a ${typeof v} in the pack — only strings, functions and nested objects are leaves`);
  }
  return out;
}

/**
 * 源码里对绑定名的读取：每一处「绑定.a.b.c」（含它的各级前缀 a、a.b）记成去掉绑定名的路径 "a.b.c"。
 * 用 typescript 解析，所以注释里、字符串里提到的不算；点链断了（括号、下标）就在断处停
 */
export function bindingReads(source: string, binding: string, path = "source.ts"): Set<string> {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out = new Set<string>();
  const chain = (n: ts.Expression): string | null => {
    if (ts.isIdentifier(n)) return n.text === binding ? "" : null;
    if (ts.isPropertyAccessExpression(n)) {
      const base = chain(n.expression);
      return base === null ? null : base ? `${base}.${n.name.text}` : n.name.text;
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      const c = chain(node);
      if (c) out.add(c);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 文件里不是 `import type` 的引入（运行时会去加载的）：import、export … from、import = require、import() 和 require()，各回一段原文。空 = 只有类型引入 */
export function runtimeImports(source: string, path = "source.ts"): string[] {
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) out.push(node.getText(sf));
    else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly) out.push(node.getText(sf));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) out.push(node.getText(sf));
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) out.push(node.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
