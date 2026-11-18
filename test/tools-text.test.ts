// 工具文字的钉子（Task 0）：test/tooltext/calls.ts 的每条调用今天说的话，和 test/tools-text.pins.json 里存的指纹一个字节不差
// （每条两个指纹：回复本身、回复后面接的踪迹 / 文件；文件开头的 env 记着钉的时候的 node / icu / zod 版本）；
// 再证明这张清单没有漏：src/tools/ 里每个文件（NOT_TEXT 除外），每一个带文字的行都被调用跑到、行上的每个分支都走到、起在这些行上的函数都被调用过。
// 以后把文字挪出 src/tools/，这两个测试不改：指纹对不上就是挪错了。
// 逻辑都在 test/textpins/lib.ts（别的范围也用）；这里只有这一个范围的名字：文件、绑定、命令。
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindingReads, checkPins, fileProblems, markLeaves, markerOf, packLeaves, parseLcov, reach, runtimeImports, splitRest, textLines } from "./textpins/lib.ts";
import type { Exempt } from "./textpins/lib.ts";
import { renderAll } from "./tooltext/calls.ts";

const TREE = resolve(fileURLToPath(import.meta.url), "../..");
const PINS_FILE = join(TREE, "test/tools-text.pins.json");
const REPIN = "hh-fw node test/tooltext/pin.ts > <a scratch file>, then move the scratch file to test/tools-text.pins.json (on the tree before the moves, in the pin commit)";
/** 覆盖检查在本进程里渲染整张清单的那个文件（相对树根；不叫 *.test.ts） */
const COVERAGE_RUN = "test/tooltext/coverage.run.ts";
/** 文字读语言包用的绑定名 */
const BINDINGS = ["T"] as const;
const TOOLS_DIR = "src/tools";
/** 清单已经管全了的文件 = src/tools/ 里所有的 .ts 减去 NOT_TEXT：新加的工具文件默认就要被管 */
/** 每条写明这个文件已知的带文字的行（按字面量文字，textLines 找到的整套）；有测试断言这套就是现在的全部——以后往里加 T. 或中文字符串会让测试失败 */
const NOT_TEXT: ReadonlyArray<{ file: string; texts: readonly string[]; reason: string }> = [
  // 控制器已批：只有 brain 引用它，没有工具调用够得着；第 17 行带全角「｜」的正则是一行「词｜理由」的分隔规则（一个记号），不是任何工具说的话
  { file: "src/tools/wordlist.ts", texts: ["/[｜|]/"], reason: "its only non-ASCII literal is the separator regex of a parser (a token), not text any tool says; only the brain imports it, no tool call reaches it" },
];
/** The built-in modules' declarations (modules/<name>/module.ts): built-in modules read their words from the core pack */
const moduleFiles = (): string[] => readdirSync(join(TREE, "modules")).filter((d) => existsSync(join(TREE, "modules", d, "module.ts"))).map((d) => `modules/${d}/module.ts`).sort();
const toolFiles = (): string[] => readdirSync(join(TREE, TOOLS_DIR)).filter((f) => f.endsWith(".ts")).map((f) => `${TOOLS_DIR}/${f}`).sort();
const COMPLETE = (): string[] => toolFiles().filter((f) => !NOT_TEXT.some((n) => n.file === f));
/** 清单够不着的文字行（按字面量文字匹配，每条写 reason） */
const EXEMPT: readonly Exempt[] = [];
/** 挪完以后文字都在这个文件里：它存在时，整个文件的行、分支、函数都要跑到 */
const LANG_TOOLS = "src/lang/zh/tools.ts";

test("tool text: every call renders to the pins in test/tools-text.pins.json, reply and rest separately (a mismatch names the id and prints the text now; an environment mismatch is one line)", async () => {
  if (!existsSync(PINS_FILE)) {
    assert.fail(`test/tools-text.pins.json is missing — generate it: ${REPIN}`);
  }
  const pins: unknown = JSON.parse(readFileSync(PINS_FILE, "utf8"));
  const message = checkPins(pins, await renderAll(), { command: REPIN });
  if (message !== null) assert.fail(message);
});

test("tool text: the call list reaches every text line of src/tools/*.ts (NOT_TEXT excepted), with every branch on that line taken and every function that starts on it called (V8 coverage)", () => {
  for (const n of NOT_TEXT) {
    assert.ok(toolFiles().includes(n.file), `NOT_TEXT names ${n.file}, which is not in ${TOOLS_DIR}/ any more`);
    const found = textLines(readFileSync(join(TREE, n.file), "utf8"), BINDINGS, n.file).flatMap((l) => l.texts).sort();
    assert.deepEqual(found, [...n.texts].sort(), `${n.file} is excluded as not-text but its text lines changed — cover it (remove it from NOT_TEXT) or update the listed texts (${n.reason})`);
  }
  const problems = reach({
    tree: TREE, files: COMPLETE(), exempt: EXEMPT, packFile: LANG_TOOLS, bindings: BINDINGS,
    include: [`${TOOLS_DIR}/*.ts`, LANG_TOOLS], run: COVERAGE_RUN,
  });
  assert.deepEqual(problems, [], `the call list in test/tooltext/calls.ts misses text (add a call, or an EXEMPT entry with a reason):\n${problems.join("\n")}`);
});

test("tool text: textLines finds string, template-part, regex and binding-read lines", () => {
  const src = [
    "const a = \"plain\";",
    "const b = \"中文\";",
    "const c = `x${a}乙${b}丙`;",
    "const d = /[，、]+/;",
    "const e = T.hello;",
    "const f = [",
    "  \"丁\" +",
    "  \"ascii\",",
    "];",
    "const g = M.world;",
  ].join("\n");
  assert.deepEqual(textLines(src, ["T"]).map((l) => l.line), [2, 3, 4, 5, 7]);
  assert.deepEqual(textLines(src, ["T", "M"]).map((l) => l.line), [2, 3, 4, 5, 7, 10]);
});

test("tool text: a one-line arrow on a text line is reported when its FNDA is 0 and not when it was called (functions are paired with FNDA by position, not by name)", () => {
  const source = [
    "export const a = () => \"甲\";",
    "export const b = () => \"乙\";",
    "export const c = () => 1;",
  ].join("\n");
  const lcov = (counts: [number, number, number]): string => [
    "SF:/repo/src/x.ts",
    "FN:1,failed", "FN:2,failed", "FN:3,plain",
    `FNDA:${counts[0]},failed`, `FNDA:${counts[1]},failed`, `FNDA:${counts[2]},plain`,
    "DA:1,1", "DA:2,1", "DA:3,1",
    "end_of_record",
  ].join("\n");
  const check = (counts: [number, number, number], exempt: readonly Exempt[] = []): string[] =>
    fileProblems({ file: "src/x.ts", rec: parseLcov(lcov(counts))[0] ?? null, source, bindings: ["T"], exempt });
  assert.deepEqual(check([1, 1, 0]), [], "a function on a line without text may stay uncalled; called ones are fine");
  const one = check([0, 7, 1]);
  assert.equal(one.length, 1, one.join("\n"));
  assert.match(one[0] ?? "", /^src\/x\.ts:1 function failed is never called/);
  const other = check([7, 0, 1]);
  assert.equal(other.length, 1, other.join("\n"));
  assert.match(other[0] ?? "", /^src\/x\.ts:2 function failed is never called/);
  assert.deepEqual(check([0, 0, 0], [{ file: "src/x.ts", text: "甲", reason: "fixture" }, { file: "src/x.ts", text: "乙", reason: "fixture" }]), [], "exempt text lines are not checked");
  assert.deepEqual(check([4, 5, 6]), []);
  // 按源码认一行的豁免（code）：恰好落在一行上才算数；落空、落在两行上都当场报出来；text 和 code 都没写也报
  const firstLine = source.split("\n")[0]!;
  assert.deepEqual(check([0, 7, 1], [{ file: "src/x.ts", code: firstLine, reason: "fixture" }]), [], "a line exempted by its source text is not checked");
  assert.deepEqual(check([7, 7, 1], [{ file: "src/x.ts", code: "no such code anywhere", reason: "fixture" }]), [`src/x.ts: the exemption's code "no such code anywhere" is on 0 lines — it must be on exactly one`]);
  const twice = check([7, 7, 1], [{ file: "src/x.ts", code: "= () => \"", reason: "fixture" }]);
  assert.equal(twice.length, 1, twice.join("\n"));
  assert.match(twice[0] ?? "", /is on 2 lines — it must be on exactly one$/);
  assert.deepEqual(check([7, 7, 1], [{ file: "src/x.ts", reason: "fixture without a matcher" }]), ["src/x.ts: an exemption names neither text nor code (fixture without a matcher)"]);
  const never = fileProblems({ file: "src/x.ts", rec: parseLcov(lcov([0, 1, 1]).replace("DA:1,1", "DA:1,0"))[0] ?? null, source, bindings: ["T"], exempt: [] });
  assert.deepEqual(never, ["src/x.ts:1 never runs (甲)"], "a line reported as never run is not reported again as a function");
});

test("tool text: parseLcov reads the record of a file and refuses an FN / FNDA mismatch; a text line that never runs or has a branch never taken is a problem", () => {
  const recs = parseLcov(["TN:", "SF:/repo/src/a.ts", "FN:2,f", "FNDA:3,f", "FNF:1", "FNH:1", "DA:1,1", "DA:2,0", "BRDA:2,0,0,1", "BRDA:2,0,1,-", "end_of_record", ""].join("\n"));
  assert.equal(recs.length, 1);
  assert.deepEqual(recs[0]?.fns, [{ line: 2, name: "f", count: 3 }]);
  const problems = fileProblems({ file: "src/a.ts", rec: recs[0] ?? null, source: "const a = 1;\nconst b = \"乙\";", bindings: ["T"], exempt: [] });
  assert.deepEqual(problems, ["src/a.ts:2 never runs (乙)", "src/a.ts:2 has 1 branch(es) never taken (乙)"]);
  assert.throws(() => parseLcov("SF:/x.ts\nFN:1,f\nend_of_record"), /FN lines/);
});

test("tool text: splitRest cuts a text into the reply and the rest at the first trace / file marker", () => {
  assert.deepEqual(splitRest("plain reply"), { reply: "plain reply", rest: "" });
  assert.deepEqual(splitRest("said\n--- trace ---\nrun [\"a\"]"), { reply: "said", rest: "\n--- trace ---\nrun [\"a\"]" });
  assert.deepEqual(splitRest("said\n--- file ---\n{}"), { reply: "said", rest: "\n--- file ---\n{}" });
  assert.deepEqual(splitRest("said\n--- file ---\nx\n--- trace ---\ny"), { reply: "said", rest: "\n--- file ---\nx\n--- trace ---\ny" }, "the first marker wins");
  assert.deepEqual(splitRest("said\n--- trace ---"), { reply: "said", rest: "\n--- trace ---" }, "an empty trace leaves the marker at the very end");
  assert.deepEqual(splitRest("a --- trace --- b"), { reply: "a --- trace --- b", rest: "" }, "the marker is a line of its own");
  for (const t of ["x", "x\n--- trace ---\ny", "\n--- file ---\n"]) { const r = splitRest(t); assert.equal(r.reply + r.rest, t); }
});

// ---------- Task 11：收口的四个测试（挪完以后才有东西可查：语言包文件不在时，每个都跳过并说明原因） ----------

const PACK_PATH = join(TREE, LANG_TOOLS);
/** 语言包文件不在 = 挪之前的树（钉子是在那棵树上生成的）：跳过，不是通过也不是失败 */
const skipWithoutPack = (t: TestContext): boolean => {
  if (existsSync(PACK_PATH)) return false;
  t.skip(`${LANG_TOOLS} does not exist (the tree before the moves): nothing to check yet`);
  return true;
};
/** 按路径动态引入（不是静态 import：挪之前的树上没有这个文件；URL 跟 src/ 里静态引入解析出的是同一个，所以拿到的是同一个模块实例） */
const importFrom = async (rel: string): Promise<Record<string, unknown>> => (await import(pathToFileURL(join(TREE, rel)).href)) as Record<string, unknown>;
const NON_ASCII = /[^\x00-\x7f]/;
const source = (rel: string): string => readFileSync(join(TREE, rel), "utf8");

test("tool text: left — the non-ASCII literals still in src/tools/*.ts are exactly the three of the inventory (by text)", (t) => {
  if (skipWithoutPack(t)) return;
  // The values and heads code recognises (done_with's states, learn_check's kinds, the head of a reminder the owner set) are in the pack: brain.forms
  const expected = [
    // 电脑收尾失败时给管机器的人看的日志行（破折号是 U+2014，只有它让这行不是 ASCII）
    "src/tools/computer.ts: computer: closing the execution failed \u2014 if computer keeps failing with the same error, OpenClaw on the Mac needs a restart",
    // 两个正则：表情包的情绪词分隔、词表文件的分隔
    "src/tools/stickers.ts: /[\\s,，、]+/",
    "src/tools/wordlist.ts: /[｜|]/",
  ].sort();
  const found = toolFiles().flatMap((f) => textLines(source(f), [], f).flatMap((l) => l.texts.map((x) => `${f}: ${x}`))).sort();
  assert.deepEqual(found, expected, "a non-ASCII literal is left in src/tools/ that is not one of the three (text goes into src/lang/zh/tools.ts, a form code recognises into brain.forms), or one of the three changed");
});

test("tool text: no dead leaf (every leaf of zh.tools is read as T.<path> in src/tools/*.ts, src/channels/*.ts, src/brain.ts or a built-in module's module.ts) and the pack file has no runtime import", async (t) => {
  if (skipWithoutPack(t)) return;
  const leaves = packLeaves(await importFrom(LANG_TOOLS));
  assert.ok(leaves.length > 0, "the pack has no leaf");
  const reads = new Set<string>();
  for (const f of [...toolFiles(), "src/channels/gateway.ts", "src/channels/send.ts", "src/channels/bridge.ts", "src/brain.ts", ...moduleFiles()]) for (const r of bindingReads(source(f), "T", f)) reads.add(r);
  const dead = leaves.filter((l) => !reads.has(l.path)).map((l) => l.path);
  assert.deepEqual(dead, [], `${dead.length} leaf(s) of zh.tools are never read as T.<path> — delete them, or the call site reads another key:\n${dead.join("\n")}`);
  const imports = runtimeImports(source(LANG_TOOLS), LANG_TOOLS);
  assert.deepEqual(imports, [], `${LANG_TOOLS} may only import types (import type), found:\n${imports.join("\n")}`);
});

/** 标记包登记的语言代码（随便取，只要不跟真的包重名） */
const MARKER_LANG = "tools-marker";
interface LangApi { registerLang(pack: unknown): void; setLang(code?: string | null): void; langCode(): string }

test("tool text: marker pack — with every leaf of zh.tools marked and set as the language, every marker shows up in some rendered text (a module-level copy of pack text, a dead leaf or a call site reading the wrong key leaves its marker out)", async (t) => {
  if (skipWithoutPack(t)) return;
  const pack = await importFrom(LANG_TOOLS);
  const lang = (await importFrom("src/lang/index.ts")) as unknown as LangApi;
  const zh = (await importFrom("src/lang/zh/index.ts")).zh as { prompts: unknown; defaults: unknown };
  const leaves = packLeaves(pack);
  assert.ok(leaves.length > 250, `only ${leaves.length} leaves found in the pack — the walk is broken or the pack is not the finished one`);
  // 别的部分（提示、记忆层的字、默认值）原样带上：包以后再长出新的部分，这里不用跟着改（少带一部分，读它的代码会读到 undefined）
  lang.registerLang({ ...zh, code: MARKER_LANG, tools: markLeaves(pack) });
  let rendered: Awaited<ReturnType<typeof renderAll>>;
  try {
    lang.setLang(MARKER_LANG);
    assert.equal(lang.langCode(), MARKER_LANG);
    rendered = await renderAll();
  } finally {
    lang.setLang("zh");
  }
  assert.equal(lang.langCode(), "zh", "the default pack is back");
  const all = Object.values(rendered).map((r) => `${r.reply}\n${r.rest}`).join("\n");
  const missing = leaves.filter((l) => !all.includes(markerOf(l.path))).map((l) => l.path);
  assert.deepEqual(missing, [], `${missing.length} of ${leaves.length} leaves never show up in any rendered text (marked pack):\n${missing.join("\n")}`);
});

/** 描述是纯 ASCII、留在代码里没进包的工具（每条写原因）。查过 buildTools / memTools 建的全部和大脑的两个：今天没有 */
const DESCRIPTION_IN_CODE: ReadonlyArray<{ tool: string; reason: string }> = [];
/** 参数说明在嵌套的对象里（不在顶层 shape 上）的工具：参数键要在这个顶层属性的元素对象里找 */
const NESTED_PARAMS: Readonly<Record<string, string>> = { learn_check: "candidates", mem_entries_add: "entries", checked: "verdicts" };
/** 大脑自己建的两个工具定义（不是 buildTools / memTools 建的），在 def scratch/… 里 */
const BRAIN_TOOLS = ["checked", "looked_again"];
/** 包里不是工具名的导出：几个工具共用的、或者不属于哪个工具的字 */
const NOT_TOOL_EXPORTS = ["deliver", "mem", "newEvent", "schedule", "workspaceGit"];

test("tool text: structure — every built tool has T[name].description, the non-tool exports of the pack are the five, every params key is a key of the tool's zod shape", async (t) => {
  if (skipWithoutPack(t)) return;
  const pack = await importFrom(LANG_TOOLS);
  const rendered = await renderAll();
  // 每个 def <变体>/<工具> 的回复是 defText 的 JSON：[名字, 说明, 三份 schema, shape 的键]
  interface Built { variants: Set<string>; description: string; keys: Set<string>; nested: Map<string, Set<string>> }
  const built = new Map<string, Built>();
  for (const [id, r] of Object.entries(rendered)) {
    const m = /^def ([^/]+)\/(.+)$/.exec(id);
    if (!m) continue;
    const [name, description, , , sdk, keys] = JSON.parse(r.reply) as [string, string, unknown, unknown, { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> }, string[]];
    const b = built.get(name) ?? { variants: new Set<string>(), description, keys: new Set<string>(), nested: new Map<string, Set<string>>() };
    b.variants.add(m[1] ?? "");
    for (const k of keys) b.keys.add(k);
    for (const [prop, def] of Object.entries(sdk.properties ?? {})) {
      const inner = def.items?.properties;
      if (inner) b.nested.set(prop, new Set([...(b.nested.get(prop) ?? []), ...Object.keys(inner)]));
    }
    built.set(name, b);
  }
  assert.ok(built.size > 40, `only ${built.size} built tools found in the def entries`);
  // 大脑的两个：恰好是 def scratch/ 里的那两个，别的变体里没有
  const scratch = [...built].filter(([, b]) => b.variants.has("scratch")).map(([n]) => n).sort();
  assert.deepEqual(scratch, BRAIN_TOOLS, "the tools of def scratch/… are the two the brain builds");
  assert.ok([...built].every(([n, b]) => !BRAIN_TOOLS.includes(n) || (b.variants.size === 1 && b.variants.has("scratch"))), "the brain's two are built only in the scratch variant");

  // 包里不是工具名的导出恰好是那五个
  assert.deepEqual(Object.keys(pack).filter((k) => !built.has(k)).sort(), NOT_TOOL_EXPORTS, "the exports of the pack that are not tool names");

  const problems: string[] = [];
  for (const [name, b] of built) {
    const entry = pack[name] as { description?: unknown; params?: unknown } | undefined;
    const inCode = DESCRIPTION_IN_CODE.find((d) => d.tool === name);
    if (inCode) {
      if (NON_ASCII.test(b.description)) problems.push(`${name}: listed as ASCII-only in code (${inCode.reason}) but its description has non-ASCII text`);
      if (typeof entry?.description === "string") problems.push(`${name}: listed as staying in code but the pack has its description`);
    } else if (typeof entry?.description !== "string") problems.push(`${name}: no string at T.${name}.description`);
    // params：每个键是这个工具 zod shape 的键（嵌套的在元素对象里找）
    if (entry?.params !== undefined) {
      if (typeof entry.params !== "object" || entry.params === null) { problems.push(`${name}: params is not an object`); continue; }
      const nestedProp = NESTED_PARAMS[name];
      const allowed = nestedProp ? (b.nested.get(nestedProp) ?? new Set<string>()) : b.keys;
      for (const k of Object.keys(entry.params)) if (!allowed.has(k)) problems.push(`${name}: params.${k} is not a key of ${nestedProp ? `the elements of ${nestedProp} in ` : ""}the zod shape (${[...allowed].join(", ")})`);
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
  for (const d of DESCRIPTION_IN_CODE) assert.ok(built.has(d.tool), `DESCRIPTION_IN_CODE names ${d.tool}, which no variant builds`);
});
