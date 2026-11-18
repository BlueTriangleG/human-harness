// 对照工具的接线看守。src/parity/world.ts 是照 src/hhd.ts 的 main() 手抄的，src/parity/drive.ts 的 feed 是照 src/control.ts 里
// relay、sense、tell 三条命令手抄的：那边改了，这边没人提醒就不会跟着改，回放出来的就不是真系统的样子。
// 所以把那两段源码各钉一个 sha256（用 TypeScript 解析取出来，除了换行符什么都不规范化）：它们一改这个测试就挂，
// 挂了先去改镜像，再回来更新哈希。钉着的哈希都在 PINNED 里。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TREE = resolve(fileURLToPath(import.meta.url), "../..");

/** 钉着的哈希，只在这一处。改之前先照 CHANGED 说的做 */
const PINNED = {
  /** src/hhd.ts 里 main() 整个函数的源码 */
  hhdMain: "232c09dea7220fb2b8c5e8454c3539380c972ce859b5407b1d0455abc1f21999",
  /** src/control.ts 里 handle() 的 relay、sense、tell 三个 case 的源码（按这个先后，中间隔一个换行） */
  controlRelaySenseTell: "03ae0ce77aa1514a64cfbb585cfd3ec5d307fdb00677ea5be85d20fc1f7afd5b",
};

const CHANGED = "the daemon's wiring changed — update src/parity/world.ts (and drive.ts feed) to mirror it, "
  + "re-read the header of world.ts for what is deliberately not mirrored, then update this hash";

const parse = (file: string): ts.SourceFile => ts.createSourceFile(file, readFileSync(join(TREE, file), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const sha256 = (source: string): string => createHash("sha256").update(source.replace(/\r\n?/g, "\n")).digest("hex");

/** 文件顶层叫这个名字的函数声明 */
function functionNamed(sf: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const fn = sf.statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(fn, `${sf.fileName} has no top-level function ${name}() any more — ${CHANGED}`);
  return fn;
}

/** 函数体顶层那个 switch 里，这几个字符串 case 的源码（按给的先后） */
function casesOf(sf: ts.SourceFile, fn: ts.FunctionDeclaration, labels: readonly string[]): string {
  const sw = fn.body?.statements.find(ts.isSwitchStatement);
  assert.ok(sw, `${sf.fileName}: ${fn.name?.text}() has no top-level switch any more — ${CHANGED}`);
  return labels.map((label) => {
    const clause = sw.caseBlock.clauses.find((c) => ts.isCaseClause(c) && ts.isStringLiteral(c.expression) && c.expression.text === label);
    assert.ok(clause, `${sf.fileName}: ${fn.name?.text}() has no case "${label}" any more — ${CHANGED}`);
    return clause.getText(sf);
  }).join("\n");
}

test("the daemon's wiring is pinned: main() of src/hhd.ts and the relay / sense / tell cases of handle() in src/control.ts are what src/parity mirrors", () => {
  const hhd = parse("src/hhd.ts");
  const control = parse("src/control.ts");
  const now = {
    hhdMain: sha256(functionNamed(hhd, "main").getText(hhd)),
    controlRelaySenseTell: sha256(casesOf(control, functionNamed(control, "handle"), ["relay", "sense", "tell"])),
  };
  for (const key of Object.keys(PINNED) as Array<keyof typeof PINNED>) {
    assert.equal(now[key], PINNED[key], `${CHANGED} (${key} is now ${now[key]})`);
  }
});

test("the wiring pin reads source text as written: a changed line changes the hash, a different line ending does not, and a missing function or case is named", () => {
  const sf = (text: string): ts.SourceFile => ts.createSourceFile("x.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const source = "// 前面的注释不算\nexport async function handle(req: { cmd: string }): Promise<unknown> {\n  switch (req.cmd) {\n    case \"relay\": drain(); /* 先补交 */ return take(req);\n    case \"sense\": return { status: \"ok\" };\n    case \"tell\": return tell(req);\n    case \"ping\": return 1;\n  }\n}\n";
  const pinned = (text: string): string => { const f = sf(text); return sha256(casesOf(f, functionNamed(f, "handle"), ["relay", "sense", "tell"])); };
  assert.equal(pinned(source), pinned(source.replaceAll("\n", "\r\n")), "CRLF and LF are the same source");
  assert.equal(pinned(source), pinned(source.replace("return 1", "return 2")), "a case that is not pinned may change");
  assert.notEqual(pinned(source), pinned(source.replace("drain(); ", "")), "dropping the drain before the relay hand-in changes the hash");
  assert.notEqual(pinned(source), pinned(source.replace("先补交", "先交存着的")), "so does a comment inside a pinned case: nothing but line endings is normalized");
  assert.throws(() => pinned(source.replace("case \"tell\": return tell(req);\n", "")), /has no case "tell" any more — the daemon's wiring changed/);
  assert.throws(() => functionNamed(sf(source), "main"), /has no top-level function main\(\) any more/);
  const whole = (text: string): string => { const f = sf(text); return sha256(functionNamed(f, "handle").getText(f)); };
  assert.notEqual(whole(source), whole(source.replace("return 1", "return 2")), "the whole-function pin sees every line");
});
