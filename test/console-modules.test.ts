// 控制台的页面脚本是 ES 模块，入口 js/start.js。测试不开浏览器，所以有三类错别的测试看不出来、要到页面上才炸：
//   1. 名字：用了没声明也没 import 的名字（点到那一下才报错）；import 了对方没给的名字、不存在的文件（整页的脚本都不跑）；给 import 来的名字赋值。
//   2. 图：名单里有文件没被 import 到（白取一趟、里面的代码不跑）。
//   3. 加载时：文件互相 import 成了圈，谁先求值由 import 的先后推出来，不写在哪里。一个文件加载时（顶层语句）要是用了
//      排在它后面求值的文件里的变量，页面一打开就报「还没初始化」。规矩：加载时只许用最底下几个文件（BASE）的东西，
//      别的文件的东西只在函数里用（函数要等 start() 之后、所有文件都求值完了才会被调到）。
// 这里用 TypeScript 的检查器静态地查。只解析，不执行页面脚本。
import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import { WEB_FILES } from "../src/console/web.ts";
import { WEB_DIR } from "./console-web.ts";
import { tmpDir } from "./tmp.ts";

// the page's own modules (js/); app/chat.js is the talk pane's bundle, a separate entry built from console-ui/
const SCRIPTS = WEB_FILES.filter((f) => f.startsWith("js/") && f.endsWith(".js")).map((f) => basename(f, ".js"));
const ENTRY = "start";
/** 最底下的几个文件，按谁可以用谁排：每个只 import 排在它前面的，所以总是最先求值 */
const BASE = ["i18n", "core", "sent", "sides"];

interface Loaded { program: ts.Program; checker: ts.TypeChecker; sources: Map<string, ts.SourceFile> }

function load(dir: string, names: readonly string[]): Loaded {
  const program = ts.createProgram(names.map((n) => join(dir, n + ".js")), {
    allowJs: true, checkJs: true, noEmit: true, types: [], target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Bundler, moduleDetection: ts.ModuleDetectionKind.Force, lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  });
  const sources = new Map(program.getSourceFiles().filter((sf) => !sf.isDeclarationFile).map((sf) => [basename(sf.fileName, ".js"), sf]));
  return { program, checker: program.getTypeChecker(), sources };
}
const nameOf = (n: ts.Node): string => basename(n.getSourceFile().fileName, ".js");
const lineOf = (n: ts.Node): string => `${basename(n.getSourceFile().fileName)}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
const importsOf = (sf: ts.SourceFile): string[] => sf.statements.filter(ts.isImportDeclaration).map((d) => basename((d.moduleSpecifier as ts.StringLiteral).text, ".js"));

/**
 * 第 1 类。检查器对没写类型的脚本会报很多别的（某个属性它不认识之类），只留这几种：
 * 2304 / 2552 没有这个名字；2305 / 2724 / 2459 / 2460 对方没 export 这个名字；2307 没有这个文件；2588 / 2632 给常量、给 import 来的名字赋值
 */
const NAME_CODES = new Set([2304, 2552, 2305, 2724, 2459, 2460, 2307, 2588, 2632]);
function nameProblems(l: Loaded): string[] {
  return [...l.sources.values()].flatMap((sf) => l.program.getSemanticDiagnostics(sf)).filter((d) => NAME_CODES.has(d.code))
    .map((d) => `${d.file && d.start !== undefined ? `${basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1}` : "?"} [${d.code}] ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** 第 2 类：从入口顺着 import 够得着的文件 */
function reachable(l: Loaded, entry: string): string[] {
  const seen = new Set<string>();
  const visit = (n: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of importsOf(l.sources.get(n) ?? assert.fail(`${n}.js 不在名单里，却被 import 了`))) visit(d);
  };
  visit(entry);
  return [...seen].sort();
}

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
const isFn = (n: ts.Node): n is Fn => ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);
/** 交给这些的函数以后才调（加载完了、所有文件都求值了以后） */
const LATER = /(^|\.)(addEventListener|setTimeout|setInterval|requestAnimationFrame|then|catch|finally)$/;
/** n 要是直接交给某个调用当参数，给出被调的那个的写法（a.b.forEach 这样）；不是就给 null */
function calleeOfArgument(n: ts.Node): string | null {
  const p = n.parent;
  if (!ts.isCallExpression(p) && !ts.isNewExpression(p)) return null;
  const args: readonly ts.Node[] = p.arguments ?? [];
  return args.includes(n) ? p.expression.getText() : null;
}
const handedToLater = (n: ts.Node): boolean => LATER.test(calleeOfArgument(n) ?? "");
/** 写在原地的函数加载时就跑的两种情形：写完当场调（(() => …)()），或者直接交给一个当场就调它的（forEach、map、sort 这类） */
function runsInPlace(fn: Fn): boolean {
  if (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) return false;
  const outer = ts.isParenthesizedExpression(fn.parent) ? fn.parent : fn;
  if (ts.isCallExpression(outer.parent) && outer.parent.expression === outer) return true;
  return calleeOfArgument(fn) !== null && !handedToLater(fn);
}

/**
 * 第 3 类：这个文件加载时会碰到别的文件的哪些名字（「文件.名字 ← 怎么碰到的」）。
 * 加载时跑的是顶层语句；函数的定义不跑，除非：写在原地当场就跑的（runsInPlace），或者有名字、而且这个名字在加载时跑的代码里出现了
 * （当成会被调到：宁可多报）。这样一路跟下去，跟进别的文件的函数里也算。表里放着的函数（对象、数组里的）当成以后才调。
 */
function touchedAtLoad(l: Loaded, name: string): string[] {
  const touched = new Map<string, string>(), walked = new Set<ts.Node>(), via: string[] = [];
  const walk = (n: ts.Node): void => {
    if (isFn(n) && !runsInPlace(n)) return;
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isOwnName = (ts.isVariableDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) && p.name === n;
      if (!isOwnName && !ts.isImportSpecifier(p) && !ts.isExportSpecifier(p) && !handedToLater(n)) {
        let sym = ts.isShorthandPropertyAssignment(p) ? l.checker.getShorthandAssignmentValueSymbol(p) : l.checker.getSymbolAtLocation(n);
        if (sym && sym.flags & ts.SymbolFlags.Alias) sym = l.checker.getAliasedSymbol(sym);
        const decl = sym?.declarations?.[0];
        // 只管声明在某个页面脚本顶层的名字（浏览器自带的、函数里的局部变量都不是）
        const top = decl && ts.isVariableDeclaration(decl) ? decl.parent.parent : decl;
        if (decl && top && ts.isSourceFile(top.parent) && l.sources.get(nameOf(top)) === top.parent) {
          const home = nameOf(top);
          if (home !== name && !touched.has(`${home}.${n.text}`)) touched.set(`${home}.${n.text}`, `${lineOf(n)}${via.length ? "，经 " + via.join(" → ") : ""}`);
          const body = ts.isFunctionDeclaration(decl) ? decl.body : ts.isVariableDeclaration(decl) && decl.initializer && isFn(decl.initializer) ? decl.initializer.body : undefined;
          if (body && !walked.has(body)) { walked.add(body); via.push(n.text); walk(body); via.pop(); }
        }
      }
    }
    ts.forEachChild(n, walk);
  };
  walk(l.sources.get(name) ?? assert.fail(`没有 ${name}.js`));
  return [...touched].map(([what, how]) => `${what} ← ${how}`).sort();
}
/** 其中不在底下那几个文件里的 */
const beyond = (l: Loaded, name: string, base: readonly string[]): string[] => touchedAtLoad(l, name).filter((t) => !base.includes(t.slice(0, t.indexOf("."))));

const pages = load(join(WEB_DIR, "js"), SCRIPTS);

test("web modules: every name a page script uses is its own, imported from a file that exports it, or the browser's", () => {
  assert.deepEqual(nameProblems(pages), []);
});

test("web modules: start.js reaches every script on the list, and nothing imports the entry", () => {
  assert.deepEqual(reachable(pages, ENTRY), [...SCRIPTS].sort());
  for (const [n, sf] of pages.sources) assert.ok(!importsOf(sf).includes(ENTRY), `${n}.js import 了入口 start.js：入口要最后求值`);
});

test("web modules: at load time a script touches only the base files; the base files import only each other, in order", () => {
  for (const [i, b] of BASE.entries()) assert.deepEqual(importsOf(pages.sources.get(b)!).filter((d) => !BASE.slice(0, i).includes(d)), [], `${b}.js 只能 import 排在它前面的底层文件`);
  // 入口不查：没有谁 import 它，它最后求值，那时别的文件都求值完了
  for (const n of SCRIPTS.filter((s) => s !== ENTRY)) {
    assert.deepEqual(beyond(pages, n, BASE), [], `${n}.js 加载时用到了不在 ${BASE.join(" / ")} 里的东西：挪进函数里，由 start() 之后的代码来调`);
  }
});

test("web modules: the checks catch each kind of mistake (made-up scripts)", () => {
  const dir = tmpDir("hh-web-modules-");
  const files: Record<string, string> = {
    low: `let n = 0;\nconst K = 1;\nexport { K, n };\n`,
    late: [
      `import { early } from "./early.js";`,
      `let r1 = 1, r2 = 2, r3 = 3, r4 = 4, r5 = 5, r6 = 6, r7 = 7, r8 = 8, r9 = 9, inner = 0, hidden = 0;`,
      `function f1() { return inner + early; }`,
      `export { r1, r2, r3, r4, r5, r6, r7, r8, r9, f1 };`,
    ].join("\n") + "\n",
    early: [
      `import { K, n } from "./low.js";`,
      `import { r1, r2, r3, r4, r5, r6, r7, r8, r9, f1 } from "./late.js";`,
      `const early = K + n;`,                                    // 底层文件的：可以
      `const a = r1;`,                                           // 顶层直接读
      `const viaLocal = () => r2;`,
      `const b = viaLocal();`,                                   // 顶层调本文件的函数，它里面读
      `[1].forEach(() => r3);`,                                  // 当场就调的回调
      `(() => r4)();`,                                           // 写完当场调
      `const c = f1();`,                                         // 顶层调那个文件的函数，它里面读它自己的变量
      `document.addEventListener("click", () => r5);`,           // 以下都是以后才跑：不算
      `function onClick() { return r6; }`,
      `document.addEventListener("click", onClick);`,
      `const table = { show: () => r7 };`,
      `const unused = () => r8;`,
      `setTimeout(() => r9, 0);`,
      `export { early, a, b, c, table, unused };`,
    ].join("\n") + "\n",
    names: [
      `import { r1, nope } from "./late.js";`,                   // 对方没有这个名字
      `import { hidden } from "./late.js";`,                     // 对方有、但没 export
      `import { x } from "./nowhere.js";`,                       // 没有这个文件
      `r1 = 2;`,                                                 // 给 import 来的名字赋值
      `console.log(undeclared, nope, hidden, x);`,               // 没声明也没 import
    ].join("\n") + "\n",
    orphan: `export const alone = 1;\n`,
  };
  try {
    for (const [n, text] of Object.entries(files)) writeFileSync(join(dir, n + ".js"), text);
    const l = load(dir, Object.keys(files));
    assert.deepEqual(nameProblems(l).map((p) => p.replace(/\] .*$/, "]")), ["names.js:1 [2305]", "names.js:2 [2459]", "names.js:3 [2307]", "names.js:4 [2632]", "names.js:5 [2304]"]);
    assert.deepEqual(reachable(l, "early"), ["early", "late", "low"], "orphan 和 names 没人 import");
    assert.deepEqual(beyond(l, "early", ["low"]).map((t) => t.slice(0, t.indexOf(" "))), ["late.f1", "late.inner", "late.r1", "late.r2", "late.r3", "late.r4"]);
    assert.match(beyond(l, "early", ["low"]).find((t) => t.startsWith("late.r2"))!, /early\.js:5，经 viaLocal$/, "报出在哪一行、经哪个函数碰到的");
    assert.deepEqual(beyond(l, "low", []), []);
  } finally { rmSync(dir, { recursive: true }); }
});
