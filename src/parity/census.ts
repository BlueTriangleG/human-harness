// 对照工具的 census 命令：静态列出一棵代码树里所有带非 ASCII 字符的字面量（和协议哨兵），按 (kind, text) 计数。
//   census --tree <仓库目录> --out <文件>
// 只读文件、只用 typescript 解析（createSourceFile，不建 program、不做类型检查），树里的代码一行都不执行。
// 结果跟位置无关：一句话从一个文件挪到另一个文件，census 文件一个字节都不变；改了一个字才会变。
// 回放从不执行的那几个文件（UNRUN）另算一类 unrun：里面的每一个字面量都再收一遍，ASCII 的也收——
// 回放的记录看不到它们，别处只收非 ASCII 的普查在这里对 ASCII 是瞎的（选项名、命令名、socket 上的字都是 ASCII）。
// <out>.where 另外列出每一处在哪（给人看，diff 不比它）。
// 不走 src/parity/（对照工具自己）：那里的字她读不到；没有这个工具的版本和加了它的版本必须比出来一样。
// 测试文件（*.test.*、relay/test.mjs）也不走：它们不是系统的一部分。
import ts from "typescript";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertOffLive, userHome } from "./fence.ts";

export type CensusKind = "string" | "template" | "regex" | "json" | "sentinel" | "unrun";

export interface Occurrence { kind: CensusKind; text: string; path: string; line: number }

const NON_ASCII = /[^\x00-\x7f]/;
// 协议哨兵（NO_REPLY 这种）：全是 ASCII，但改一个字母行为就变了，所以不管 ASCII 也收
const SENTINEL = /^[A-Z][A-Z0-9_]{3,}$/;
// 正则的源码里用转义写的字（\u4e00、\x80 这种）：源码是纯 ASCII，匹配的却不是，照非 ASCII 的收
const ESCAPED_CHAR = /\\[ux]/;
// 测试文件：x.test.ts、test.mjs 这种名字
const TEST_FILE = /(^|\.)test\.[^.]+$/;

/**
 * 回放从不执行的文件（相对树根；以 / 结尾的是整个目录）：常驻进程的入口、控制 socket、命令行、真内核驱动、真网关的客户端、
 * 自己修系统的那一套（部署、重启、看守、启动时的备份）、浏览器、relay 插件。world.ts 拿假的顶替了它们，或者根本不经过它们，
 * 所以回放的记录里没有它们的任何痕迹。这些文件里的每个字符串、模板的每一段、正则都再收一遍（kind 是 unrun，ASCII 的也收，
 * 模块路径、属性名这些也在内）：别的 kind 照旧，一句非 ASCII 的话在这里会出现两次（它原来的 kind 和 unrun）。
 * 这些文件挪了位置、改了名，这张表要跟着改（test/parity-census.test.ts 查表上的每一项在树里还在）
 */
export const UNRUN: readonly string[] = [
  "src/hhd.ts", "src/control.ts", "src/cli.ts", "src/cli-direct.ts", "src/kernel/sdk.ts", "src/gateway/client.ts",
  "src/repair/", "src/browser/", "relay/",
];
const isUnrun = (path: string): boolean => UNRUN.some((u) => (u.endsWith("/") ? path.startsWith(u) : path === u));

/** 按 UTF-8 字节比较：JS 默认按 UTF-16 码元排，补充平面的字（emoji）会和 U+E000 以上的字排反 */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function compareOccurrences(x: Occurrence, y: Occurrence): number {
  return compareBytes(x.kind, y.kind) || compareBytes(x.text, y.text) || compareBytes(x.path, y.path) || x.line - y.line;
}

/**
 * TS / JS 源码里的字面量。注释不在语法树的子节点里（forEachChild 不走 JSDoc），天然不收。
 * 回放从不执行的文件（UNRUN）里，每个字面量另收一条 unrun，不管是不是 ASCII、是不是空的
 */
function collectSource(text: string, path: string, kind: ts.ScriptKind): Occurrence[] {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, kind);
  const out: Occurrence[] = [];
  const unrun = isUnrun(path);
  const add = (k: CensusKind, value: string, node: ts.Node): void => {
    out.push({ kind: k, text: value, path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (NON_ASCII.test(node.text)) add(ts.isStringLiteral(node) ? "string" : "template", node.text, node);
      else if (SENTINEL.test(node.text)) add("sentinel", node.text, node);
      if (unrun) add("unrun", node.text, node);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // 模板的每一段静态文字单独算（取转义解开后的文字）；插进去的表达式里的字面量照常往下走
      if (NON_ASCII.test(node.text)) add("template", node.text, node);
      if (unrun) add("unrun", node.text, node);
    } else if (ts.isRegularExpressionLiteral(node)) {
      // 正则取整个字面量 /…/flags：标志变了也是行为变了。源码里用 \u、\x 转义写的也收
      if (NON_ASCII.test(node.text) || ESCAPED_CHAR.test(node.text)) add("regex", node.text, node);
      if (unrun) add("unrun", node.text, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** JSON 里的字符串值和对象的键：在 JSON 的语法树里两者都是 StringLiteral */
function collectJson(text: string, path: string): Occurrence[] {
  // 先按标准 JSON 校验：坏文件要报错，不能让宽松的解析器补出半截结果
  try { JSON.parse(text); } catch { throw new Error(`${path} is not JSON`); }
  const sf = ts.parseJsonText(path, text);
  const out: Occurrence[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) && NON_ASCII.test(node.text)) {
      out.push({ kind: "json", text: node.text, path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 目录里的文件（相对 tree 的路径，用 /），按名字排好；recursive 时往下走子目录 */
function listFiles(tree: string, rel: string, recursive: boolean, keep: (name: string) => boolean): string[] {
  if (!existsSync(join(tree, rel))) return [];   // 树里没有 relay/ 或 config/ 就是没有
  const out: string[] = [];
  for (const d of readdirSync(join(tree, rel), { withFileTypes: true }).sort((x, y) => compareBytes(x.name, y.name))) {
    const p = `${rel}/${d.name}`;
    if (d.isDirectory()) { if (recursive) out.push(...listFiles(tree, p, true, keep)); }
    else if (d.isFile() && keep(d.name)) out.push(p);
  }
  return out;
}

// 整棵树：src/**/*.ts（src/parity/ 除外）、relay/*.{js,mjs}、config/*.json；测试文件不算
export function collectTree(tree: string): { occurrences: Occurrence[]; files: number } {
  // 没有 src/ 多半是 --tree 给错了：空的 census 和空的 census 一比就是「一样」，不能悄悄过
  if (!existsSync(join(tree, "src"))) throw new Error(`no src/ under ${tree}`);
  const tsFiles = listFiles(tree, "src", true, (n) => n.endsWith(".ts") && !TEST_FILE.test(n)).filter((p) => !p.startsWith("src/parity/"));
  const jsFiles = listFiles(tree, "relay", false, (n) => (n.endsWith(".js") || n.endsWith(".mjs")) && !TEST_FILE.test(n));
  const jsonFiles = listFiles(tree, "config", false, (n) => n.endsWith(".json"));
  const read = (p: string): string => readFileSync(join(tree, p), "utf8");
  const occurrences = [
    ...tsFiles.flatMap((p) => collectSource(read(p), p, ts.ScriptKind.TS)),
    ...jsFiles.flatMap((p) => collectSource(read(p), p, ts.ScriptKind.JS)),
    ...jsonFiles.flatMap((p) => collectJson(read(p), p)),
  ];
  return { occurrences, files: tsFiles.length + jsFiles.length + jsonFiles.length };
}

/** census 文件：每个不同的 (kind, text) 一行 `<count>\t<kind>\t<JSON 文字>`，按 (kind, text) 字节序 */
export function censusText(occurrences: readonly Occurrence[]): string {
  const sorted = [...occurrences].sort(compareOccurrences);
  const lines: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    const first = sorted[i]!;
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.kind === first.kind && sorted[j]!.text === first.text) j++;
    lines.push(`${j - i}\t${first.kind}\t${JSON.stringify(first.text)}`);
    i = j;
  }
  return lines.map((l) => `${l}\n`).join("");
}

/** .where 文件：每一处一行 `<kind>\t<JSON 文字>\t<路径>:<行>` */
function whereText(occurrences: readonly Occurrence[]): string {
  return [...occurrences].sort(compareOccurrences)
    .map((o) => `${o.kind}\t${JSON.stringify(o.text)}\t${o.path}:${o.line}\n`).join("");
}

const USAGE = "usage: census --tree <repo dir> --out <file>";

export async function runCensus(argv: string[]): Promise<number> {
  let tree: string | undefined;
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tree") tree = argv[++i];
    else if (a === "--out") out = argv[++i];
    else { process.stderr.write(`census: unexpected argument ${a}\n${USAGE}\n`); return 2; }
  }
  if (!tree || !out) { process.stderr.write(`${USAGE}\n`); return 2; }
  // 跟 dump 一样：不往跑这个进程的系统用户自己的 home 里写（那是线上数据所在的地方；产物该落在草稿盘上）
  const home = userHome();
  try {
    if (home) assertOffLive([resolve(out), `${resolve(out)}.where`], home);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  try {
    const { occurrences, files } = collectTree(tree);
    const census = censusText(occurrences);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, census);
    writeFileSync(`${out}.where`, whereText(occurrences));
    const distinct = census.split("\n").length - 1;
    process.stdout.write(`census: ${distinct} distinct literals, ${occurrences.length} occurrences in ${files} files\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`census: ${(e as Error).message}\n`);
    return 2;
  }
}
