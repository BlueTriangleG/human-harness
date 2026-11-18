// 对照工具的 diff：逐条比记录、给可读的 unified diff；--brief 不引用原文；census 的增删和次数变化；一样就退出 0；
// 第一行是两边的 label，同一个目录不比，label 一样说一句；
// 来历不清的 dump（没有 meta.json、有 meta.json 没列的记录）不比；meta.json 没写 sandbox: true 的 dump（没套内核沙箱跑的、早先的）照比、说一句。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { changedSpan, diffCensus, diffReport, diffScenario, runDiff, unifiedHunks } from "../src/parity/diff.ts";
import type { DiffOptions } from "../src/parity/diff.ts";
import { runCensus } from "../src/parity/census.ts";
import { tmpDir } from "./tmp.ts";

type Rec = Record<string, unknown>;

/** 照 transcript 的格式写一个 dump：键排好序、一行一条、\n 结尾，外加 meta.json */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Rec)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** meta 为 null 时不写 meta.json；meta 里不给 snapshot 就是没写 snapshot（不给 sandbox: true 的，diff 会在 stderr 上说一句） */
function writeDump(scenarios: Record<string, Rec[]>, meta: Rec | null = { snapshot: "snap-1", sandbox: true }): string {
  const out = tmpDir("hh-parity-dump-");
  for (const [name, recs] of Object.entries(scenarios)) {
    mkdirSync(join(out, name));
    writeFileSync(join(out, name, "transcript.jsonl"), recs.map((r) => `${canon(r)}\n`).join(""));
  }
  if (meta) writeFileSync(join(out, "meta.json"), canon({ ...meta, scenarios: Object.entries(scenarios).map(([name, r]) => ({ name, records: r.length })) }));
  return out;
}

/** census 用的源码树 */
function writeTree(files: Record<string, string>): string {
  const root = tmpDir("hh-parity-tree-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

/** 没给 label 的两次 dump，报告的第一行 */
const HEAD = "dumps: A=(no label) B=(no label)";

const send = (n: number, text: string): Rec => ({ n, t: n * 1000, kind: "send", region: "main", text, priority: "normal", human: true });
const opts = (a: string, b: string, more: Partial<DiffOptions> = {}): DiffOptions => ({ dumps: [a, b], census: null, all: false, brief: false, ...more });

async function quietly(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = mock.method(process.stdout, "write", (chunk: unknown) => { out += String(chunk); return true; });
  const writeErr = mock.method(process.stderr, "write", (chunk: unknown) => { err += String(chunk); return true; });
  try {
    return { code: await fn(), out, err };
  } finally {
    write.mock.restore();
    writeErr.mock.restore();
  }
}

const TEXT_A = ["第一行", "第二行", "第三行", "第四行：阿青在说话", "第五行", "第六行", "第七行"].join("\n");
const TEXT_B = TEXT_A.replace("阿青在", "阿青再");

test("diff: 多行 text 里改了一个字，报对 n、给带两行上下文的 unified diff", () => {
  const a = writeDump({ chat: [send(0, "早"), send(1, TEXT_A), send(2, "晚")], other: [send(0, "x"), send(1, "y")] });
  const b = writeDump({ chat: [send(0, "早"), send(1, TEXT_B), send(2, "晚")], other: [send(0, "x"), send(1, "y")] });
  const r = diffReport(opts(a, b));
  assert.equal(r.code, 1);
  assert.equal(r.text, [
    HEAD,
    "scenario chat: 1 changed, 0 added, 0 removed (A 3 records, B 3)",
    "  n=1 kind=send: text",
    "    text:",
    "      @@ -2,5 +2,5 @@",
    "       第二行",
    "       第三行",
    "      -第四行：阿青在说话",
    "      +第四行：阿青再说话",
    "       第五行",
    "       第六行",
    "scenario other: identical, 2 records",
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
});

test("diff: 一样的两份退出 0，输出里没有临时目录", async () => {
  const recs = { chat: [send(0, TEXT_A), { n: 1, t: 1500, kind: "state", name: "status", value: { ok: true } }] };
  const a = writeDump(recs);
  const b = writeDump(recs);
  const census = tmpDir("hh-parity-census-");
  writeFileSync(join(census, "a.txt"), "2\tstring\t\"阿青\"\n");
  writeFileSync(join(census, "b.txt"), "2\tstring\t\"阿青\"\n");
  const r = await quietly(() => runDiff([a, b, "--census", join(census, "a.txt"), join(census, "b.txt")]));
  assert.equal(r.code, 0);
  assert.equal(r.out, `${HEAD}\nscenario chat: identical, 2 records\ncensus: identical\nparity: identical\n`);
});

test("diff: 工具自己的 info 级 parity: 日志打在场景底下——两边一样打一遍，不一样两边各打；--brief 也打；别的日志、别的字段里长得像的不打", () => {
  const note = (n: number, msg: string, level = "info"): Rec => ({ n, t: 0, kind: "log", level, mod: "parity", msg, error: null });
  const base = [send(0, "早"), note(1, "parity: inbound paths fromChannel=7 inbound=2"), note(2, "parity: scenario x failed", "error"), send(3, "{\"kind\":\"log\",\"level\":\"info\",\"msg\":\"parity: 不是日志\"}"), note(4, "relay spool: drained")];
  const a = writeDump({ inbound: base });
  const same = diffReport(opts(a, writeDump({ inbound: base }), { brief: true }));
  assert.equal(same.text, `${HEAD}\nscenario inbound: identical, 5 records\n  log: parity: inbound paths fromChannel=7 inbound=2\nparity: identical\n`);
  const other = writeDump({ inbound: base.map((r) => (r.n === 1 ? note(1, "parity: inbound paths fromChannel=6 inbound=3") : r)) });
  for (const brief of [false, true]) {
    assert.deepEqual(diffReport(opts(a, other, { brief })).text.split("\n").slice(1, 5), [
      "scenario inbound: 1 changed, 0 added, 0 removed (A 5 records, B 5)",
      "  A log: parity: inbound paths fromChannel=7 inbound=2",
      "  B log: parity: inbound paths fromChannel=6 inbound=3",
      "  n=1 kind=log: msg",
    ]);
  }
});

test("diff: 一边没有的场景、多出来的记录报成 added、非字符串字段、只展开前 5 条（--all 全展开）", () => {
  const many = (suffix: string): Rec[] => Array.from({ length: 7 }, (_, i) => send(i, `第${i}句${suffix}`));
  const a = writeDump({ gone: [send(0, "x")], long: many(""), short: [send(0, "x")] });
  const b = writeDump({ added: [send(0, "x")], long: many("！"), short: [send(0, "x"), { n: 1, t: 5, kind: "fetch", url: "http://fake/v1", body: null }] });
  const r = diffReport(opts(a, b));
  const lines = r.text.split("\n");
  assert.deepEqual(lines.filter((l) => l.startsWith("scenario")), [
    "scenario added: only in B",
    "scenario gone: only in A",
    "scenario long: 7 changed, 0 added, 0 removed (A 7 records, B 7)",
    "scenario short: 0 changed, 1 added, 0 removed (A 1 records, B 2)",
  ]);
  assert.equal(lines.filter((l) => l.startsWith("  n=")).length, 5);
  assert.ok(lines.includes("  … 2 more changed records (--all to show)"));
  const fetchLine = canon({ n: 1, t: 5, kind: "fetch", url: "http://fake/v1", body: null });
  assert.ok(lines.includes(`  + n=1 kind=fetch: len ${[...fetchLine].length}, sha ${createHash("sha256").update(fetchLine).digest("hex").slice(0, 12)}`));
  assert.ok(lines.includes("    {\"body\":null,\"kind\":\"fetch\",\"n\":1,\"t\":5,\"url\":\"http://fake/v1\"}"));
  assert.equal(lines.at(-2), "parity: 4 scenario(s) differ, census +0 −0");
  const all = diffReport(opts(a, b, { all: true })).text.split("\n");
  assert.equal(all.filter((l) => l.startsWith("  n=")).length, 7);

  const c = writeDump({ s: [{ n: 0, t: 0, kind: "result", region: "main", tool: "x", text: "好", isError: false }] });
  const d = writeDump({ s: [{ n: 0, t: 7, kind: "result", region: "main", tool: "x", text: "好", isError: true }] });
  assert.equal(diffReport(opts(c, d)).text, [
    HEAD,
    "scenario s: 1 changed, 0 added, 0 removed (A 1 records, B 1)",
    "  n=0 kind=result: isError, t",
    "    isError: false → true",
    "    t: 0 → 7",
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
});

test("diff --brief: 长的多行 text 中间改一个字，只给改的那个字，周围的文字一个都不出现", () => {
  const pool = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈";
  const lines = Array.from({ length: 30 }, (_, i) => [...pool].slice(i, i + 20).join(""));
  const middle = (ch: string): string => lines.map((l, i) => (i === 15 ? `${l.slice(0, 10)}${ch}${l.slice(10)}` : l)).join("\n");
  const textA = middle("甲");
  const textB = middle("乙");
  const a = writeDump({ chat: [send(0, textA)] });
  const b = writeDump({ chat: [send(0, textB)] });
  const census = tmpDir("hh-parity-census-");
  writeFileSync(join(census, "a.txt"), "1\tstring\t\"阿青说的话\"\n3\ttemplate\t\"老林\"\n");
  writeFileSync(join(census, "b.txt"), "1\tstring\t\"阿青说的新话\"\n2\ttemplate\t\"老林\"\n");
  const r = diffReport(opts(a, b, { brief: true, census: [join(census, "a.txt"), join(census, "b.txt")] }));
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
  const len = [...textA].length;
  assert.equal(r.text, [
    HEAD,
    "scenario chat: 1 changed, 0 added, 0 removed (A 1 records, B 1)",
    "  n=0 kind=send: text",
    `    text: len ${len} → ${len}, sha ${sha(textA)} → ${sha(textB)}, changed "甲" → "乙"`,
    "census: +2 −2",
    `  added    ×1  string  len 6 sha ${sha("阿青说的新话")}`,
    `  removed  ×1  string  len 5 sha ${sha("阿青说的话")}`,
    `  count    3 → 2  template  len 2 sha ${sha("老林")}`,
    "parity: 1 scenario(s) differ, census +2 −2",
    "",
  ].join("\n"));
  // 原文任意相邻两个字都不出现在输出里（输出里的中文只有改的那两个字）
  for (const text of [textA, textB]) {
    const cs = [...text];
    for (let i = 0; i + 1 < cs.length; i++) assert.ok(!r.text.includes(cs[i]! + cs[i + 1]!), `${cs[i]}${cs[i + 1]} leaked`);
  }
  assert.ok(!r.text.includes("阿青") && !r.text.includes("老林"));
});

test("diff --brief: 只在一边有的那条只给长度和 sha；不是字符串的字段只给路径，不给值", () => {
  const extra: Rec = { n: 1, t: 5, kind: "fetch", url: "http://fake/v1", body: { text: "小禾的私信" } };
  const a = writeDump({ s: [{ n: 0, t: 0, kind: "call", name: "go", args: ["阿青"], returned: { count: 1 } }] });
  const b = writeDump({ s: [{ n: 0, t: 0, kind: "call", name: "go", args: ["阿青", "老林"], returned: { count: 2 } }, extra] });
  const r = diffReport(opts(a, b, { brief: true }));
  const line = canon(extra);
  const sha = createHash("sha256").update(line).digest("hex").slice(0, 12);
  assert.equal(r.text, [
    HEAD,
    "scenario s: 1 changed, 1 added, 0 removed (A 1 records, B 2)",
    "  n=0 kind=call: args[1], returned.count",
    `  + n=1 kind=fetch: len ${[...line].length}, sha ${sha}`,
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
  for (const leak of ["老林", "小禾", "私信", "fake", "1 →", "→ 2"]) assert.ok(!r.text.includes(leak), leak);
});

test("diff --brief: 一段对不上的记录里按顺序配成一对的两段不相干的长话，哪一段都不引；改动的那一段超过 20 字、两条记录不是同一种，也不引", () => {
  // 两段没有相同的头尾、互相没有相同的相邻两个字
  const pool = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜金生丽水玉出昆冈剑号巨阙珠称夜光果珍李柰菜重芥姜";
  const [textA, textB] = [[...pool].slice(0, 40).join(""), [...pool].slice(40).join("")];
  const lenB = [...textB].length;
  assert.ok(lenB > 20, "both texts are longer than the quoting limit");
  const a = writeDump({ chat: [send(0, "早"), send(1, textA), send(2, textB)] });
  const textC = `新${textA}尾`;
  const b = writeDump({ chat: [send(0, "早"), send(1, "多出来的一条"), send(2, textC)] });
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);
  const r = diffReport(opts(a, b, { brief: true }));
  assert.equal(r.text, [
    HEAD,
    "scenario chat: 2 changed, 0 added, 0 removed (A 3 records, B 3)",
    "  n=1 kind=send: text",
    `    text: len 40 → 6, sha ${sha(textA)} → ${sha("多出来的一条")}, changed span len 40 → 6 (not quoted)`,
    "  n=2 kind=send: text",
    `    text: len ${lenB} → 42, sha ${sha(textB)} → ${sha(textC)}, changed span len ${lenB} → 42 (not quoted)`,
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
  for (const text of [textA, textB, textC, "多出来的一条"]) {
    const cs = [...text];
    for (let i = 0; i + 1 < cs.length; i++) assert.ok(!r.text.includes(cs[i]! + cs[i + 1]!), `${cs[i]}${cs[i + 1]} leaked`);
  }

  // 正好 20 字引，21 字不引
  const edge = (n: number): string => diffReport(opts(writeDump({ s: [send(0, `头${"甲".repeat(n)}尾`)] }), writeDump({ s: [send(0, `头${"乙".repeat(n)}尾`)] }), { brief: true })).text;
  assert.ok(edge(20).includes(`changed "${"甲".repeat(20)}" → "${"乙".repeat(20)}"`));
  assert.ok(edge(21).includes("changed span len 21 → 21 (not quoted)") && !edge(21).includes("甲") && !edge(21).includes("乙"));
  // 两条记录不是同一种（错位了）：再短也不引
  const kinds = diffReport(opts(writeDump({ s: [send(0, "阿青的话")] }), writeDump({ s: [{ n: 0, t: 0, kind: "result", region: "main", tool: "x", text: "小禾的话", isError: false }] }), { brief: true })).text;
  assert.ok(kinds.includes("n=0 kind=send→result:") && kinds.includes("changed span len 2 → 2 (not quoted)") && !kinds.includes("阿青") && !kinds.includes("小禾"), kinds);
});

test("diff: 第一行是两边的 label；A、B 是同一个目录不比；两边 label 一样照比、stderr 上说一句；label 不是字符串退出 2", async () => {
  const recs = { chat: [send(0, "早")] };
  const labelled = (label: unknown): string => writeDump(recs, { snapshot: "snap-1", sandbox: true, label });
  assert.deepEqual(await quietly(() => runDiff([labelled("base-1a2b3c"), labelled("head-4d5e6f")])), {
    code: 0, out: "dumps: A=base-1a2b3c B=head-4d5e6f\nscenario chat: identical, 1 records\nparity: identical\n", err: "",
  });
  assert.deepEqual(await quietly(() => runDiff([labelled("base-1a2b3c"), labelled(null)])), {
    code: 0, out: "dumps: A=base-1a2b3c B=(no label)\nscenario chat: identical, 1 records\nparity: identical\n", err: "",
  });
  assert.deepEqual(await quietly(() => runDiff([labelled("same-7a8b9c"), labelled("same-7a8b9c")])), {
    code: 0, out: "dumps: A=same-7a8b9c B=same-7a8b9c\nscenario chat: identical, 1 records\nparity: identical\n",
    err: "diff: warning: A and B carry the same label (same-7a8b9c) — the same tree dumped twice shows that the replay is deterministic, not that two trees agree\n",
  });
  const one = labelled("base-1a2b3c");
  assert.deepEqual(await quietly(() => runDiff([one, join(one, ".")])), {
    code: 2, out: "", err: "diff: A and B are the same directory — a dump compared with itself is always identical\n",
  });
  assert.deepEqual(await quietly(() => runDiff([labelled("base-1a2b3c"), labelled(7)])), { code: 2, out: "", err: "diff: B meta.json: label is not a string\n" });
});

test("diff: census 不带 --brief 给原文和次数", () => {
  const r = diffCensus("1\tjson\t\"小禾\"\n2\tstring\t\"阿青\"\n", "3\tstring\t\"阿青\"\n1\tstring\t\"老林\"\n", false);
  assert.deepEqual(r, {
    lines: ["census: +2 −2", "  removed  ×1  json  \"小禾\"", "  added    ×1  string  \"老林\"", "  count    2 → 3  string  \"阿青\""],
    added: 2,
    removed: 2,
  });
  assert.throws(() => diffCensus("not a census line\n", "", false), /census A line 1/);
});

test("diff --census 不带 dump 目录：只比 census，结论里没有场景", async () => {
  const dir = tmpDir("hh-parity-census-");
  writeFileSync(join(dir, "a.txt"), "2\tstring\t\"阿青\"\n");
  writeFileSync(join(dir, "b.txt"), "2\tstring\t\"阿青\"\n1\ttemplate\t\"老林\"\n");
  const same = await quietly(() => runDiff(["--census", join(dir, "a.txt"), join(dir, "a.txt")]));
  assert.deepEqual(same, { code: 0, out: "census: identical\nparity: identical\n", err: "" });
  const differ = await quietly(() => runDiff(["--brief", "--census", join(dir, "a.txt"), join(dir, "b.txt")]));
  assert.deepEqual(differ, {
    code: 1,
    out: `census: +1 −0\n  added    ×1  template  len 2 sha ${createHash("sha256").update("老林").digest("hex").slice(0, 12)}\nparity: census +1 −0\n`,
    err: "",
  });
});

test("diff --census: 带 U+2028 的字面量，census 写出来的文件 diff 能原样读回", async () => {
  const withSep = writeTree({ "src/a.ts": "export const s = \"阿青\\u2028老林\";\nexport const t = \"小禾\";\n" });
  const without = writeTree({ "src/a.ts": "export const t = \"小禾\";\n" });
  const dir = tmpDir("hh-parity-census-");
  const write = mock.method(process.stdout, "write", () => true);
  try {
    assert.equal(await runCensus(["--tree", withSep, "--out", join(dir, "a.txt")]), 0);
    assert.equal(await runCensus(["--tree", without, "--out", join(dir, "b.txt")]), 0);
  } finally {
    write.mock.restore();
  }
  assert.ok(readFileSync(join(dir, "a.txt"), "utf8").includes("阿青 老林"));   // census 文件里就是没转义的 U+2028
  assert.deepEqual(await quietly(() => runDiff(["--census", join(dir, "a.txt"), join(dir, "a.txt")])), { code: 0, out: "census: identical\nparity: identical\n", err: "" });
  assert.deepEqual(await quietly(() => runDiff(["--census", join(dir, "a.txt"), join(dir, "b.txt")])), {
    code: 1,
    out: "census: +0 −1\n  removed  ×1  string  \"阿青 老林\"\nparity: census +0 −1\n",
    err: "",
  });
});

test("diff: 两边一个场景都没有退出 2；meta.json 列了却没有 transcript 的场景报成那一边少了", async () => {
  const empty = await quietly(() => runDiff([writeDump({}), writeDump({})]));
  assert.deepEqual(empty, { code: 2, out: "", err: "diff: neither dump has any scenario (no <scenario>/transcript.jsonl, none listed in meta.json)\n" });

  const recs = { chat: [send(0, "早")], gone: [send(0, "x")], ghost: [send(0, "y")] };
  const a = writeDump(recs);
  const b = writeDump(recs);
  rmSync(join(a, "gone", "transcript.jsonl"));
  rmSync(join(a, "ghost", "transcript.jsonl"));
  rmSync(join(b, "ghost", "transcript.jsonl"));
  assert.deepEqual(await quietly(() => runDiff([a, b])), {
    code: 1,
    out: [
      HEAD,
      "scenario chat: identical, 1 records",
      "scenario ghost: in neither A nor B (listed in meta.json, no transcript.jsonl)",
      "scenario gone: only in B (A's meta.json lists it, but A has no transcript.jsonl)",
      "parity: 2 scenario(s) differ, census +0 −0",
      "",
    ].join("\n"),
    err: "",
  });
});

test("diff: meta.json 不是对象、不是 JSON、scenarios 不是列表：说清楚是哪一边，退出 2", async () => {
  const recs = { chat: [send(0, "早")] };
  const cases: Array<[string, string]> = [
    ["null", "B meta.json is not an object"],
    ["[]", "B meta.json is not an object"],
    ["{", "B meta.json is not JSON"],
    ["{\"scenarios\":{}}", "B meta.json: scenarios is not a list of {name}"],
  ];
  for (const [content, msg] of cases) {
    const b = writeDump(recs);
    writeFileSync(join(b, "meta.json"), content);
    assert.deepEqual(await quietly(() => runDiff([writeDump(recs), b])), { code: 2, out: "", err: `diff: ${msg}\n` });
  }
});

test("diff: 两边 meta.json 的 snapshot 不一样就不比，退出 2；没写 snapshot 照常比；有 transcript 却没有 meta.json 的不比，退出 2", async () => {
  const recs = { chat: [send(0, "早")] };
  const other = await quietly(() => runDiff([writeDump(recs, { snapshot: "snap-1", sandbox: true }), writeDump(recs, { snapshot: "snap-2", sandbox: true })]));
  assert.deepEqual(other, { code: 2, out: "", err: "parity: the two dumps come from different snapshots (snap-1 vs snap-2) — not comparable\n" });
  for (const meta of [{ sandbox: true }, { snapshot: null, sandbox: true }]) {
    const r = await quietly(() => runDiff([writeDump(recs, { snapshot: "snap-1", sandbox: true }), writeDump(recs, meta)]));
    assert.deepEqual(r, { code: 0, out: `${HEAD}\nscenario chat: identical, 1 records\nparity: identical\n`, err: "" });
  }
  // 半路断了的 dump（meta.json 最后才写）、不是 dump 写的目录：不知道哪个场景挂了，比出「一样」是假的
  assert.deepEqual(await quietly(() => runDiff([writeDump(recs), writeDump(recs, null)])), {
    code: 2, out: "", err: "diff: B has transcripts but no meta.json — an interrupted or foreign dump\n",
  });
  assert.deepEqual(await quietly(() => runDiff([writeDump(recs, null), writeDump(recs)])), {
    code: 2, out: "", err: "diff: A has transcripts but no meta.json — an interrupted or foreign dump\n",
  });
});

test("diff: unified diff 两处改动离得近并成一块、离得远分两块；改动的那段按码点切", () => {
  const a = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"];
  const b = a.map((l) => (l === "2" ? "two" : l === "5" ? "five" : l === "12" ? "twelve" : l));
  assert.deepEqual(unifiedHunks(a.join("\n"), b.join("\n")), [
    "@@ -1,7 +1,7 @@", " 1", "-2", "+two", " 3", " 4", "-5", "+five", " 6", " 7",
    "@@ -10,3 +10,3 @@", " 10", " 11", "-12", "+twelve",
  ]);
  assert.deepEqual(unifiedHunks("a\nb", "a\nx\nb"), ["@@ -1,2 +1,3 @@", " a", "+x", " b"]);
  assert.deepEqual(changedSpan("前😀后", "前😁后"), ["😀", "😁"]);
  assert.deepEqual(changedSpan("ab", "a" + "字".repeat(100) + "b"), ["", "字".repeat(100)]);
});

test("diff: 参数不对退出 2，stderr 给用法", async () => {
  const usage = "usage: diff <out A> <out B> [--census <file A> <file B>] [--all] [--brief]\n       diff --census <file A> <file B> [--brief]\n";
  const cases: Array<[string[], string]> = [
    [["only-one"], `diff: ${usage}`],
    [["a", "b", "--census", "x"], `diff: --census needs two files\n${usage}`],
    [["a", "b", "--nope"], `diff: unknown option --nope\n${usage}`],
    [["--brief"], `diff: ${usage}`],
    [["a", "--census", "x", "y"], `diff: ${usage}`],
  ];
  for (const [argv, err] of cases) assert.deepEqual(await quietly(() => runDiff(argv)), { code: 2, out: "", err });
});

test("diff: meta.json 里 ok: false 的场景永远不算一样——报挂在哪一边；没写 ok 的有 transcript 才算 ok；ok 不是真假值退出 2", async () => {
  const recs = { chat: [send(0, "早")] };
  const setOk = (dir: string, ok: unknown): string => {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { scenarios: Array<Rec> };
    meta.scenarios[0]!.ok = ok;
    writeFileSync(join(dir, "meta.json"), canon(meta));
    return dir;
  };
  const verdict = "parity: 1 scenario(s) differ, census +0 −0";
  for (const [okA, okB, where] of [[false, true, "A"], [true, false, "B"], [false, false, "both"]] as const) {
    assert.deepEqual(await quietly(() => runDiff([setOk(writeDump(recs), okA), setOk(writeDump(recs), okB)])), {
      code: 1, out: `${HEAD}\nscenario chat: failed in ${where}\n${verdict}\n`, err: "",
    }, where);
  }
  assert.deepEqual(await quietly(() => runDiff([setOk(writeDump(recs), true), writeDump(recs)])), {
    code: 0, out: `${HEAD}\nscenario chat: identical, 1 records\nparity: identical\n`, err: "",
  });
  assert.deepEqual(await quietly(() => runDiff([writeDump(recs), setOk(writeDump(recs), "yes")])), {
    code: 2, out: "", err: "diff: B meta.json: scenario chat: ok is not true or false\n",
  });
});

test("diff: 有 meta.json 没列的 transcript 的 dump 不比，退出 2（别的一次留下的记录不能混进来比出「一样」）", async () => {
  const recs = { chat: [send(0, "早")] };
  const withStray = (...names: string[]): string => {
    const dir = writeDump(recs);
    for (const name of names) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, "transcript.jsonl"), `${canon(send(0, "上一次的"))}\n`);
    }
    return dir;
  };
  assert.deepEqual(await quietly(() => runDiff([withStray("old"), writeDump(recs)])), {
    code: 2, out: "", err: "diff: A has a transcript meta.json does not list (old) — an interrupted or foreign dump\n",
  });
  assert.deepEqual(await quietly(() => runDiff([writeDump(recs), withStray("old", "older")])), {
    code: 2, out: "", err: "diff: B has a transcript meta.json does not list (old, older) — an interrupted or foreign dump\n",
  });
  // 两边留着同一份旧记录：以前这样会比出「一样」
  assert.equal((await quietly(() => runDiff([withStray("old"), withStray("old")]))).code, 2);
});

test("diff: meta.json 没写 sandbox: true 的一边（dump --no-sandbox 写的 false，或者早先的 dump 没写这一项）照比，stderr 上说一句；不是真假值退出 2", async () => {
  const recs = { chat: [send(0, "早")] };
  const dumped = (sandbox: unknown, r: Record<string, Rec[]> = recs): string => writeDump(r, sandbox === undefined ? { snapshot: "snap-1" } : { snapshot: "snap-1", sandbox });
  const warning = (who: string): string => `diff: warning: ${who}: meta.json does not say sandbox: true (dumped with --no-sandbox, or of unknown origin) — the scenario processes were not confined by the kernel sandbox\n`;
  const same = `${HEAD}\nscenario chat: identical, 1 records\nparity: identical\n`;
  for (const [a, b, who] of [[false, true, "A"], [true, false, "B"], [false, false, "A and B"], [true, undefined, "B"], [undefined, false, "A and B"]] as const) {
    assert.deepEqual(await quietly(() => runDiff([dumped(a), dumped(b)])), { code: 0, out: same, err: warning(who) }, `${String(a)} / ${String(b)}`);
  }
  assert.deepEqual(await quietly(() => runDiff([dumped(true), dumped(true)])), { code: 0, out: same, err: "" });
  // 说了这一句，不一样的照样报不一样
  const differs = await quietly(() => runDiff([dumped(false), dumped(true, { chat: [send(0, "晚")] })]));
  assert.deepEqual([differs.code, differs.err, differs.out.split("\n")[1]], [1, warning("A"), "scenario chat: 1 changed, 0 added, 0 removed (A 1 records, B 1)"]);
  assert.deepEqual(await quietly(() => runDiff([dumped(true), dumped("no")])), { code: 2, out: "", err: "diff: B meta.json: sandbox is not true or false\n" });
});

// ---------- 先对齐再比 ----------

/** 不带位置戳的记录：前面插了一条以后，后面的记录逐字节还是一样的（带戳的见文件末尾「位置戳」那几条） */
const note = (text: string, more: Rec = {}): Rec => ({ t: 0, kind: "send", region: "main", text, ...more });
const lineOf = (r: Rec): string => canon(r);
/** 只在一边的那一行：位置、种类、（标识符样的 name）、长度、sha */
const oneSide = (sign: "+" | "-", n: number, r: Rec, name = ""): string =>
  `  ${sign} n=${n} kind=${String(r.kind)}${name}: len ${[...lineOf(r)].length}, sha ${createHash("sha256").update(lineOf(r)).digest("hex").slice(0, 12)}`;

test("diff 对齐: B 的最前面插了一条、别的都一样——只报一条 added，别的记录不算不一样", async () => {
  const same = [note("甲"), note("乙"), note("丙")];
  const fresh = note("新");
  const a = writeDump({ chat: same });
  const b = writeDump({ chat: [fresh, ...same] });
  const r = diffReport(opts(a, b));
  assert.equal(r.code, 1);
  assert.equal(r.text, [
    HEAD,
    "scenario chat: 0 changed, 1 added, 0 removed (A 3 records, B 4)",
    oneSide("+", 0, fresh),
    `    ${lineOf(fresh)}`,
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
  const brief = diffReport(opts(a, b, { brief: true }));
  assert.equal(brief.text.split("\n")[2], oneSide("+", 0, fresh));
  assert.ok(!brief.text.includes("新"));
  assert.equal((await quietly(() => runDiff([a, b]))).code, 1);
  // 反过来是 removed，位置按 A 算
  assert.equal(diffReport(opts(b, a, { brief: true })).text.split("\n")[1], "scenario chat: 0 changed, 0 added, 1 removed (A 4 records, B 3)");
});

test("diff 对齐: 中间少了几条——removed 的位置按 A 算，数对", () => {
  const recs = [note("一"), note("二"), note("三"), note("四"), note("五")];
  const a = writeDump({ chat: recs });
  const b = writeDump({ chat: [recs[0]!, recs[4]!] });
  const r = diffReport(opts(a, b, { brief: true }));
  assert.equal(r.text, [
    HEAD,
    "scenario chat: 0 changed, 0 added, 3 removed (A 5 records, B 2)",
    oneSide("-", 1, recs[1]!),
    oneSide("-", 2, recs[2]!),
    oneSide("-", 3, recs[3]!),
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
});

test("diff 对齐: 一条记录改了、前后都一样——报 changed，下标两边一样只写一个，字段 diff 和以前一样", () => {
  const a = writeDump({ chat: [note("甲"), note("乙"), note("丙")] });
  const b = writeDump({ chat: [note("甲"), note("丁"), note("丙")] });
  assert.equal(diffReport(opts(a, b)).text, [
    HEAD,
    "scenario chat: 1 changed, 0 added, 0 removed (A 3 records, B 3)",
    "  n=1 kind=send: text",
    "    text:",
    "      @@ -1,1 +1,1 @@",
    "      -乙",
    "      +丁",
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
});

test("diff 对齐: 改了的那条前面还插了一条——改了的和它自己的另一半配对（n=a→b），不和插进来的配", () => {
  const a = writeDump({ chat: [note("甲"), note("乙"), note("丙")] });
  const b = writeDump({ chat: [note("新"), note("甲"), note("乙"), note("丙！")] });
  const lines = diffReport(opts(a, b)).text.split("\n");
  assert.equal(lines[1], "scenario chat: 1 changed, 1 added, 0 removed (A 3 records, B 4)");
  assert.deepEqual(lines.filter((l) => l.startsWith("  n=")), ["  n=2→3 kind=send: text"]);
  assert.ok(lines.includes("      -丙") && lines.includes("      +丙！"));
  assert.ok(lines.includes(oneSide("+", 0, note("新"))));
  assert.ok(!lines.some((l) => l.startsWith("  n=0")));
});

test("diff 对齐: 一段里 A 有 2 条、B 有 3 条——前 2 条按顺序配对成 changed，多的 1 条是 added", () => {
  const a = writeDump({ chat: [note("头"), note("a1"), note("a2"), note("尾")] });
  const b = writeDump({ chat: [note("头"), note("b1"), note("b2"), note("b3"), note("尾")] });
  const lines = diffReport(opts(a, b, { brief: true })).text.split("\n");
  assert.equal(lines[1], "scenario chat: 2 changed, 1 added, 0 removed (A 4 records, B 5)");
  assert.deepEqual(lines.filter((l) => l.startsWith("  n=")), ["  n=1 kind=send: text", "  n=2 kind=send: text"]);
  assert.ok(lines.includes(oneSide("+", 3, note("b3"))));
});

test("diff 对齐: name= 只给代码里的标识符——focusFindWork 给，阿青、带空格的、太长的不给", () => {
  const call = (name: string): Rec => ({ t: 0, kind: "call", name, args: [] });
  const named = [call("focusFindWork"), call("阿青"), call("has space"), call("x".repeat(65)), call("a.b_c$"), { t: 0, kind: "call", name: 7 }];
  const a = writeDump({ tools: [note("头")] });
  const b = writeDump({ tools: [note("头"), ...named] });
  const lines = diffReport(opts(a, b, { brief: true, all: true })).text.split("\n");
  assert.deepEqual(lines.slice(2, 8), [
    oneSide("+", 1, named[0]!, " name=focusFindWork"),
    oneSide("+", 2, named[1]!),
    oneSide("+", 3, named[2]!),
    oneSide("+", 4, named[3]!),
    oneSide("+", 5, named[4]!, " name=a.b_c$"),
    oneSide("+", 6, named[5]!),
  ]);
  assert.ok(!lines.some((l) => l.includes("阿青") || l.includes("has space")));
});

test("diff 对齐: added / removed 各只展开前 5 条，多的一行说明；--all 全展开", () => {
  const extra = Array.from({ length: 8 }, (_, i) => note(`加${i}`));
  const a = writeDump({ chat: [note("头")] });
  const b = writeDump({ chat: [note("头"), ...extra] });
  for (const [from, to, sign, word] of [[a, b, "+", "added"], [b, a, "-", "removed"]] as const) {
    const cut = diffReport(opts(from, to, { brief: true })).text.split("\n");
    assert.equal(cut.filter((l) => l.startsWith(`  ${sign} n=`)).length, 5);
    assert.ok(cut.includes(`  … 3 more ${word} records (--all to show)`));
    const all = diffReport(opts(from, to, { brief: true, all: true })).text.split("\n");
    assert.equal(all.filter((l) => l.startsWith(`  ${sign} n=`)).length, 8);
    assert.ok(!all.some((l) => l.includes("more")));
  }
});

test("diff 对齐: 对不上的一段超过表的上限就退回按位置配对，并且说一句；没超上限时同样的输入是对齐的", () => {
  const [x, p, q, y, z] = [note("x"), note("p"), note("q"), note("y"), note("z")].map(lineOf) as [string, string, string, string, string];
  const ra = [x, p, q];
  const rb = [y, x, p, z];
  const brief = { all: false, brief: true };
  const aligned = diffScenario("s", ra, rb, brief);
  assert.deepEqual(aligned.lines.slice(0, 2), ["scenario s: 1 changed, 1 added, 0 removed (A 3 records, B 4)", "  n=2→3 kind=send: text"]);
  assert.ok(!aligned.lines.some((l) => l.includes("compared by position")));
  // 3 × 4 的中间要 20 格，上限给 4
  const byPosition = diffScenario("s", ra, rb, brief, 4);
  assert.equal(byPosition.differs, true);
  assert.equal(byPosition.lines[0], "scenario s: 3 changed, 1 added, 0 removed (A 3 records, B 4)");
  assert.equal(byPosition.lines[1], "  (too many differing records to align: compared by position)");
  assert.deepEqual(byPosition.lines.filter((l) => l.startsWith("  n=")), ["  n=0 kind=send: text", "  n=1 kind=send: text", "  n=2 kind=send: text"]);
  assert.ok(byPosition.lines.includes(oneSide("+", 3, note("z"))));
  // 上限卡的是中间那一段：相同的头尾不算格子
  assert.deepEqual(diffScenario("s", [x, ...ra], [x, ...rb], brief, 4).lines.slice(0, 2), [
    "scenario s: 3 changed, 1 added, 0 removed (A 4 records, B 5)",
    "  (too many differing records to align: compared by position)",
  ]);
  assert.deepEqual(diffScenario("s", [x, p], [x, p], brief, 1), { lines: ["scenario s: identical, 2 records"], differs: false });
});

// ---------- 位置戳：记录器给每条记录盖的 n（这条在文件里是第几条），前面插了或删了一条，后面每条的 n 都跟着变 ----------

/** 像记录器那样盖戳（src/parity/recorder.ts：n = 这条的位置） */
const stampAll = (recs: Rec[]): Rec[] => recs.map((r, i) => ({ ...r, n: i }));

test("diff 对齐: 记录器盖的位置戳 n 不算内容——B 中间插了一条、后面每条的 n 都加了一，只报那一条 added", () => {
  const base = [note("甲"), note("乙"), note("丙"), note("丁")];
  const fresh = note("新", { name: "BROWSER_OFF" });
  const a = writeDump({ chat: stampAll(base) });
  const b = writeDump({ chat: stampAll([base[0]!, base[1]!, fresh, base[2]!, base[3]!]) });
  assert.equal(diffReport(opts(a, b, { brief: true })).text, [
    HEAD,
    "scenario chat: 0 changed, 1 added, 0 removed (A 4 records, B 5)",
    oneSide("+", 2, { ...fresh, n: 2 }, " name=BROWSER_OFF"),
    "parity: 1 scenario(s) differ, census +0 −0",
    "",
  ].join("\n"));
  // 反过来是少了一条，位置按 A 算
  assert.deepEqual(diffReport(opts(b, a, { brief: true })).text.split("\n").slice(1, 3), [
    "scenario chat: 0 changed, 0 added, 1 removed (A 5 records, B 4)",
    oneSide("-", 2, { ...fresh, n: 2 }, " name=BROWSER_OFF"),
  ]);
});

test("diff 对齐: 两处各插一条、别的一个字没动（真的 dump 就是这个样子）——0 changed、2 added，戳一样的两份照样是 identical", () => {
  const base = Array.from({ length: 12 }, (_, i) => note(`第 ${i} 句`, { name: `CALL_${i}` }));
  const one = note("新的第一句", { name: "ADDED_EARLY" });
  const two = note("新的第二句", { name: "ADDED_LATE" });
  const a = writeDump({ prompts: stampAll(base) });
  const b = writeDump({ prompts: stampAll([...base.slice(0, 3), one, ...base.slice(3, 9), two, ...base.slice(9)]) });
  const lines = diffReport(opts(a, b, { brief: true })).text.split("\n");
  assert.equal(lines[1], "scenario prompts: 0 changed, 2 added, 0 removed (A 12 records, B 14)");
  assert.deepEqual(lines.slice(2, 4), [oneSide("+", 3, { ...one, n: 3 }, " name=ADDED_EARLY"), oneSide("+", 10, { ...two, n: 10 }, " name=ADDED_LATE")]);
  const same = writeDump({ prompts: stampAll(base) });
  assert.equal(diffReport(opts(a, same, { brief: true })).text.split("\n")[1], "scenario prompts: identical, 12 records");
});

test("diff 对齐: 戳跟着变了、内容也改了的那条——和它自己的另一半配对（n=a→b），字段里不列 n", () => {
  const a = writeDump({ chat: stampAll([note("甲"), note("乙"), note("丙")]) });
  const b = writeDump({ chat: stampAll([note("新"), note("甲"), note("乙"), note("丙！")]) });
  const lines = diffReport(opts(a, b)).text.split("\n");
  assert.equal(lines[1], "scenario chat: 1 changed, 1 added, 0 removed (A 3 records, B 4)");
  assert.deepEqual(lines.filter((l) => l.startsWith("  n=")), ["  n=2→3 kind=send: text"]);
  assert.ok(lines.includes("      -丙") && lines.includes("      +丙！"));
  assert.ok(lines.includes(oneSide("+", 0, { ...note("新"), n: 0 })));
});

test("diff 对齐: 只有顶层、等于自己位置的 n 才是戳——嵌在里面的 n、对不上位置的 n 照常算内容", () => {
  // 嵌在参数里的 n 不一样：是内容
  const a = writeDump({ chat: stampAll([note("甲", { args: { n: 1 } }), note("乙")]) });
  const b = writeDump({ chat: stampAll([note("甲", { args: { n: 2 } }), note("乙")]) });
  assert.deepEqual(diffReport(opts(a, b, { brief: true })).text.split("\n").slice(1, 3), [
    "scenario chat: 1 changed, 0 added, 0 removed (A 2 records, B 2)",
    "  n=0 kind=send: args.n",
  ]);
  // 顶层的 n 不是这条的位置（不是记录器盖的）：两边不一样就是不一样，字段里列出来
  const c = writeDump({ chat: [note("甲", { n: 7 }), note("乙", { n: 1 })] });
  const d = writeDump({ chat: [note("甲", { n: 8 }), note("乙", { n: 1 })] });
  assert.deepEqual(diffReport(opts(c, d, { brief: true })).text.split("\n").slice(1, 3), [
    "scenario chat: 1 changed, 0 added, 0 removed (A 2 records, B 2)",
    "  n=0 kind=send: n",
  ]);
  // 一边是戳、另一边不是：不是同一条
  const e = writeDump({ chat: [note("甲", { n: 0 })] });
  const f = writeDump({ chat: [note("甲", { n: 5 })] });
  assert.deepEqual(diffReport(opts(e, f, { brief: true })).text.split("\n").slice(1, 3), [
    "scenario chat: 1 changed, 0 added, 0 removed (A 1 records, B 1)",
    "  n=0 kind=send: n",
  ]);
});
