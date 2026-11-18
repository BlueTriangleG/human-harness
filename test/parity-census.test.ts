// 对照工具的 census：只收带非 ASCII 字符的字面量（和协议哨兵），注释不收，结果跟位置无关；
// 回放从不执行的那几个文件里每个字面量另收一条 unrun（ASCII 的也收）；源码里用转义写的正则也收；测试文件不走。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { UNRUN, censusText, collectTree, runCensus } from "../src/parity/census.ts";
import { tmpDir } from "./tmp.ts";

function writeTree(files: Record<string, string>): string {
  const root = tmpDir("hh-parity-census-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const MAIN_TS = [
  "// 这是一段注释，里面的中文不算字面量",
  "/** 文档注释里的“引号”也不算 */",
  "export const greet = \"你好，阿青\";",
  "export const plain = \"plain ascii\";",
  "export const short = \"ABC\";",
  "export const quiet = \"NO_REPLY\";",
  "export function line(name: string, day: string): string {",
  "  return `早上好${name}，今天是${day}。`;",
  "}",
  "export const owner = /^老林[:：]/u;",
  "export const ascii = /^[a-z]+$/;",
  "",
].join("\n");

const FIXTURE: Record<string, string> = {
  "src/main.ts": MAIN_TS,
  "src/sub/other.ts": "export const again = \"你好，阿青\";\nexport const tpl = `只有一段`;\n",
  "relay/logic.mjs": "export const ack = \"收到\";\n",
  "relay/notes.md": "这个文件不在 census 的范围里\n",
  "relay/test.mjs": "export const notWalked = \"relay 的测试不走\";\n",
  "src/sub/other.test.ts": "export const notWalked = \"src 里的测试文件也不走\";\n",
  "config/default.json": JSON.stringify({ 称呼: "小禾", plain: "ascii", list: ["阿青"], nested: { NO_REPLY: "NO_REPLY" } }, null, 2),
  "test/skip.test.ts": "export const notWalked = \"测试目录不走\";\n",
};

test("census: 字符串、模板两处插值的三段、正则、哨兵、JSON 的键和值；注释和 ASCII 不收", () => {
  const { occurrences, files } = collectTree(writeTree(FIXTURE));
  assert.equal(files, 4);
  assert.equal(censusText(occurrences), [
    "1\tjson\t\"小禾\"",
    "1\tjson\t\"称呼\"",
    "1\tjson\t\"阿青\"",
    "1\tregex\t\"/^老林[:：]/u\"",
    "1\tsentinel\t\"NO_REPLY\"",
    "2\tstring\t\"你好，阿青\"",
    "1\tstring\t\"收到\"",
    "1\ttemplate\t\"。\"",
    "1\ttemplate\t\"只有一段\"",
    "1\ttemplate\t\"早上好\"",
    "1\ttemplate\t\"，今天是\"",
    // relay/ 回放从不执行：里面的字面量另收一条 unrun
    "1\tunrun\t\"收到\"",
    "",
  ].join("\n"));
  assert.ok(!occurrences.some((o) => o.text.includes("注释") || o.text.includes("引号") || o.text.includes("不走")));
});

test("census: 回放从不执行的文件里每个字符串、模板的每一段、正则都另收一条 unrun（ASCII 的、空的也收），别处的 ASCII 照旧不收", () => {
  const source = [
    "import { join } from \"node:path\";",
    "// 注释里的 preset 不算",
    "export const options = { preset: \"claude_code\", name: \"self\", empty: \"\" };",
    "export const sock = (dir: string, n: number): string => `${dir}/hh-${n}.sock`;",
    "export const ok = /^ok:\\s*(\\d+)$/i;",
    "export const greet = \"阿青在\";",
    "",
  ].join("\n");
  const { occurrences, files } = collectTree(writeTree({
    "src/hhd.ts": source,
    "src/repair/deploy.ts": "export const step = \"restart\";\n",
    "src/browser/chrome.ts": "export const flag = \"--headless\";\n",
    "src/kernel/sdk.ts": "export const prefix = \"mcp__self__\";\n",
    "relay/index.js": "export const mode = 'native';\n",
    "src/kernel/fake.ts": "export const same = \"mcp__self__\";\n",   // 回放会执行的文件：ASCII 照旧不收
    "src/repairs.ts": "export const near = \"restart\";\n",          // 名字只是像：不在表上
  }));
  assert.equal(files, 7);
  assert.equal(censusText(occurrences), [
    "1\tstring\t\"阿青在\"",
    // 两个空的：empty 那个字符串，和模板开头（${dir} 前面）那一段
    "2\tunrun\t\"\"",
    "1\tunrun\t\"--headless\"",
    "1\tunrun\t\".sock\"",
    "1\tunrun\t\"/^ok:\\\\s*(\\\\d+)$/i\"",
    "1\tunrun\t\"/hh-\"",
    "1\tunrun\t\"claude_code\"",
    "1\tunrun\t\"mcp__self__\"",
    "1\tunrun\t\"native\"",
    "1\tunrun\t\"node:path\"",
    "1\tunrun\t\"restart\"",
    "1\tunrun\t\"self\"",
    "1\tunrun\t\"阿青在\"",
    "",
  ].join("\n"));
});

test("census: UNRUN 就是回放从不执行的那张表，表上的每一项在这棵树里都还在", () => {
  assert.deepEqual([...UNRUN], [
    "src/hhd.ts", "src/control.ts", "src/cli.ts", "src/cli-direct.ts", "src/kernel/sdk.ts", "src/gateway/client.ts",
    "src/repair/", "src/browser/", "relay/",
  ]);
  const tree = resolve(fileURLToPath(import.meta.url), "../..");
  for (const entry of UNRUN) {
    const p = join(tree, entry);
    assert.ok(existsSync(p) && statSync(p).isDirectory() === entry.endsWith("/"), `${entry} is gone or changed kind: a file the replay never runs moved — update UNRUN in src/parity/census.ts`);
  }
  // 真树上：这几个文件里的 ASCII 字面量在普查里了（真内核驱动交给 Claude Code 的预设名、控制面的命令名）
  const unrun = new Set(collectTree(tree).occurrences.filter((o) => o.kind === "unrun").map((o) => `${o.path.split("/").slice(0, 3).join("/")}\t${o.text}`));
  assert.ok(unrun.has("src/kernel/sdk.ts\tclaude_code") && unrun.has("src/control.ts\trelay") && unrun.has("src/hhd.ts\thh.sock"), "the never-run files' ASCII literals are collected");
  assert.ok(![...unrun].some((x) => x.startsWith("relay/test.mjs\t") || x.startsWith("src/parity/")), "test files and the tool itself are not walked");
});

test("census: 正则的源码里用 \\u、\\x 转义写的，源码是纯 ASCII 也收", () => {
  const { occurrences } = collectTree(writeTree({
    "src/a.ts": "export const han = /[\\u4e00-\\u9fff]+/u;\nexport const high = /[\\x80-\\xff]/;\nexport const plain = /^[a-z]+\\d$/;\n",
  }));
  assert.equal(censusText(occurrences), "1\tregex\t\"/[\\\\u4e00-\\\\u9fff]+/u\"\n1\tregex\t\"/[\\\\x80-\\\\xff]/\"\n");
});

test("census: 一句话挪到别的文件，census 一个字节都不变，.where 跟着变", async () => {
  const before = writeTree({
    "src/a.ts": "export const x = \"阿青说：早\";\nexport const y = 1;\n",
    "src/b.ts": "export const z = `老林${1}来了`;\n",
  });
  const after = writeTree({
    "src/a.ts": "export const y = 1;\n",
    "src/b.ts": "export const z = `老林${1}来了`;\n\n\nexport const x = \"阿青说：早\";\n",
  });
  const out = tmpDir("hh-parity-census-out-");
  const write = mock.method(process.stdout, "write", () => true);
  try {
    assert.equal(await runCensus(["--tree", before, "--out", join(out, "before.txt")]), 0);
    assert.equal(await runCensus(["--tree", after, "--out", join(out, "after.txt")]), 0);
    assert.equal(String(write.mock.calls[0]?.arguments[0]), "census: 3 distinct literals, 3 occurrences in 2 files\n");
  } finally {
    write.mock.restore();
  }
  const census = readFileSync(join(out, "before.txt"));
  assert.ok(census.equals(readFileSync(join(out, "after.txt"))));
  assert.equal(census.toString(), "1\tstring\t\"阿青说：早\"\n1\ttemplate\t\"来了\"\n1\ttemplate\t\"老林\"\n");
  assert.equal(readFileSync(join(out, "before.txt.where"), "utf8").split("\n")[0], "string\t\"阿青说：早\"\tsrc/a.ts:1");
  assert.equal(readFileSync(join(out, "after.txt.where"), "utf8").split("\n")[0], "string\t\"阿青说：早\"\tsrc/b.ts:4");
});

test("census: 只跳过 src/parity/（对照工具自己），别处叫 parity 的目录照收", () => {
  const { occurrences, files } = collectTree(writeTree({
    "src/parity/x.ts": "export const own = \"→ 工具自己的字\";\n",
    "src/other.ts": "export const kept = \"阿青的字\";\n",
    "src/sub/parity/y.ts": "export const deeper = \"老林的字\";\n",
    "src/parity2/z.ts": "export const sibling = \"小禾的字\";\n",
  }));
  assert.equal(files, 3);
  assert.equal(censusText(occurrences), "1\tstring\t\"小禾的字\"\n1\tstring\t\"老林的字\"\n1\tstring\t\"阿青的字\"\n");
});

test("census: 缺参数、多余的参数、树里没有 src/、坏 JSON 退出 2，stderr 说清楚", async () => {
  let err = "";
  const write = mock.method(process.stderr, "write", (chunk: unknown) => { err += String(chunk); return true; });
  const run = async (argv: string[]): Promise<[number, string]> => {
    err = "";
    const code = await runCensus(argv);
    return [code, err];
  };
  const out = (): string => join(tmpDir("hh-parity-census-out-"), "c.txt");
  const usage = "usage: census --tree <repo dir> --out <file>\n";
  try {
    assert.deepEqual(await run(["--tree", "x"]), [2, usage]);
    assert.deepEqual(await run(["--tree", "x", "--out", "y", "--nope"]), [2, `census: unexpected argument --nope\n${usage}`]);
    const noSrc = writeTree({ "config/a.json": "{}" });
    assert.deepEqual(await run(["--tree", noSrc, "--out", out()]), [2, `census: no src/ under ${noSrc}\n`]);
    const badJson = writeTree({ "src/a.ts": "", "config/bad.json": "{ \"阿青\": " });
    assert.deepEqual(await run(["--tree", badJson, "--out", out()]), [2, "census: config/bad.json is not JSON\n"]);
    // 跟 dump 一样：不往跑它的用户自己的 home 里写（查的时候什么都还没建）
    const inHome = join(userInfo().homedir, "parity-no-such-dir", "c.txt");
    assert.deepEqual(await run(["--tree", writeTree({ "src/a.ts": "" }), "--out", inHome]), [2, `parity: refusing to touch the live home (${inHome})\n`]);
    assert.equal(existsSync(join(userInfo().homedir, "parity-no-such-dir")), false);
  } finally {
    write.mock.restore();
  }
});
