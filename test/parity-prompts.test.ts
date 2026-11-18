// 对照工具的 prompts 场景：src/lang/zh/prompts.ts 的每个函数、常量导出都有着落（运行时列模块的导出，新加的函数没夹具就点名报错）；
// 同一份快照跑两次一个字节不差；记录按导出名排，常量记值、函数一组参数一条，人格前缀和脑区定义跟在后面。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as promptsModule from "../src/lang/zh/prompts.ts";
import { P, setLang } from "../src/lang/index.ts";
import { relationOf } from "../src/persona/people.ts";
import { promptEntries } from "../src/parity/scenarios/prompts.ts";
import { LANGUAGES, PREFIX_CALLS, PROMPT_FIXTURES } from "../src/parity/scenarios/prompts.fixtures.ts";
import { buildSnapshot } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";

// The replay binds the names of the snapshot's config; this process binds the fixture's, so that what it computes itself
// (relationOf, the prompts it calls) carries the same names as the records it reads
setLang("zh", { me: "阿青", owner: "老林", ta: "阿青", place: "", id: "aqing" });

const TREE = resolve(fileURLToPath(import.meta.url), "../..");
const MAIN = join(TREE, "src/parity/main.ts");
/** 覆盖检查在本进程里渲染夹具的那个文件（相对树根；不叫 *.test.ts，全套不单独跑它） */
const COVERAGE_RUN = "test/parity/prompts-coverage.run.ts";

interface Rec { n: number; t: number; kind: string; name?: string; args?: unknown[]; returned?: unknown; threw?: string }

test("parity prompts: every function / const export of src/lang/zh/prompts.ts is covered (a function without a fixture is named)", () => {
  const { entries, missing, stale } = promptEntries(promptsModule, PROMPT_FIXTURES);
  assert.deepEqual(missing, [], `src/lang/zh/prompts.ts exports without a fixture in src/parity/scenarios/prompts.fixtures.ts: ${missing.join(", ")}`);
  assert.deepEqual(stale, [], `fixtures for names src/lang/zh/prompts.ts does not export as functions: ${stale.join(", ")}`);
  // 每个运行时导出都在要记的项里（对象导出拆成了 名字.键）
  const covered = new Set(entries.map((e) => e.name.split(".")[0]));
  for (const name of Object.keys(promptsModule)) assert.ok(covered.has(name), `${name} is not rendered`);
  assert.ok(entries.some((e) => e.name === "QUESTION_REFUSED.noTags" && e.calls === null), "object exports are flattened as Name.key");
});

test("promptEntries names an export that has no fixture and a fixture whose export is gone", () => {
  const mod = { A_TEXT: "甲", aFn: (x: string) => x, OBJ: { s: "乙", f: (n: number) => String(n) }, zFn: () => "丙" };
  const r = promptEntries(mod, { aFn: [["一"], () => ["二"]], OBJ: { f: [[1], [2]] }, gone: [[]], OBJ2: { g: [[]] } });
  assert.deepEqual(r.missing, ["zFn"]);
  assert.deepEqual(r.stale, ["OBJ2.g", "gone"]);
  assert.deepEqual(r.entries.map((e) => [e.name, e.calls?.length ?? null]), [["A_TEXT", null], ["OBJ.f", 2], ["OBJ.s", null], ["aFn", 2]]);
});

test("parity prompts: the literal fixtures reach every line, branch and function of src/lang/zh/prompts.ts (V8 coverage at 100%)", () => {
  const env = { ...process.env };
  // 外层 node --test 给测试进程设的：留着的话，里面那个 --test 会把结果按「子进程」的格式交回，不出覆盖报告
  delete env.NODE_TEST_CONTEXT;
  // 文字报告只列没跑到的行；分支没走到、那一行却跑过的（?: 的一头）只在 lcov 里有行号，所以另写一份 lcov
  const lcov = join(tmpDir("hh-parity-prompts-cov-"), "lcov.info");
  const r = spawnSync(process.execPath, [
    "--test", "--test-reporter=spec", "--test-reporter-destination=stdout", "--test-reporter=lcov", `--test-reporter-destination=${lcov}`,
    "--experimental-test-coverage", "--test-coverage-include=src/lang/zh/prompts.ts",
    "--test-coverage-branches=100", "--test-coverage-lines=100", "--test-coverage-functions=100", COVERAGE_RUN,
  ], { cwd: TREE, env, encoding: "utf8" });
  const lines = `${r.stdout}\n${r.stderr}`.split("\n");
  const row = lines.find((l) => /\bprompts\.ts\s*\|/.test(l));
  let record: string[] = [];
  try {
    const all = readFileSync(lcov, "utf8").split("\n");
    const from = all.findIndex((l) => l.startsWith("SF:") && l.endsWith("src/lang/zh/prompts.ts"));
    if (from >= 0) record = all.slice(from, all.indexOf("end_of_record", from));
  } catch { /* 没写出 lcov：下面的说明里就只有文字报告 */ }
  const pick = (re: RegExp): string => [...new Set(record.map((l) => re.exec(l)?.[1]).filter(Boolean))].join(", ") || "none";
  const detail = [
    `lines not run: ${pick(/^DA:(\d+),0$/)}`,
    `branches not taken on lines: ${pick(/^BRDA:(\d+),\d+,\d+,(?:0|-)$/)}`,
    `functions never called: ${pick(/^FNDA:0,(.+)$/)}`,
    ...lines.filter((l) => /does not meet threshold/.test(l)).map((l) => l.replace(/^\s*ℹ\s*/, "").trim()),
    ...(row ? [] : [`no coverage row for src/lang/zh/prompts.ts:\n${lines.slice(-25).join("\n")}`]),
  ].join("; ");
  assert.equal(r.status, 0, `a branch of src/lang/zh/prompts.ts is not reached by any fixture — add an argument list in src/parity/scenarios/prompts.fixtures.ts (${detail})`);
  assert.match(row ?? "", /\|\s*100\.00\s*\|\s*100\.00\s*\|\s*100\.00\s*\|/, `the coverage report did not cover src/lang/zh/prompts.ts: ${row ?? "no row"}`);
});

test("parity dump prompts: two runs (different --work) are byte-identical; constants as their value, one call per fixture, in export-name order, then the persona prefix and the region specs", () => {
  const root = tmpDir("hh-parity-prompts-");
  const snap = buildSnapshot(root);
  // 两次用不同的 --work：记下的东西里哪儿漏换了 <WORK>，两份就对不上
  const raws = ["1", "2"].map((k) => {
    const out = join(root, `out${k}`);
    const r = spawnSync(process.execPath, [MAIN, "dump", "--data", snap.data, "--work", join(root, `work-${k}`), "--out", out, "--scenario", "prompts"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return readFileSync(join(out, "prompts", "transcript.jsonl"), "utf8");
  });
  assert.equal(raws[0], raws[1]);

  const recs = raws[0]!.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  assert.deepEqual(recs.map((r) => r.n), recs.map((_, i) => i));
  const calls = recs.filter((r) => r.kind === "call");
  assert.equal(calls.length, recs.length, "the scenario records only calls");
  assert.deepEqual(calls.filter((c) => "threw" in c).map((c) => c.name), []);

  const { entries } = promptEntries(promptsModule, PROMPT_FIXTURES);
  const expected = [
    ...entries.flatMap((e) => (e.calls ? e.calls.map(() => e.name) : [e.name])),
    ...LANGUAGES.map(() => "runtimeNote"), ...LANGUAGES.map(() => "languageLine"),
    ...PREFIX_CALLS.map(() => "buildPrefix"), "dropThreadTiers", "regionSpecs",
  ];
  assert.deepEqual(calls.map((c) => c.name), expected);
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, [...names].sort(), "export-name order");

  const byName = (name: string): Rec[] => calls.filter((c) => c.name === name);
  // 常量：只有值，没有 args
  const [focus] = byName("FOCUS_CONTINUE");
  assert.deepEqual(Object.keys(focus!).sort(), ["kind", "n", "name", "returned", "t"]);
  assert.equal(focus!.returned, promptsModule.FOCUS_CONTINUE);
  assert.equal(byName("QUESTION_REFUSED.noTags")[0]!.returned, promptsModule.QUESTION_REFUSED.noTags);
  // 函数：参数和渲染出来的字
  assert.deepEqual(byName("senseSeen").map((c) => [c.args, c.returned]), [[[1], promptsModule.senseSeen(1)], [[3], promptsModule.senseSeen(3)]]);
  assert.deepEqual(byName("QUESTION_REFUSED.full").map((c) => c.args), [[12]]);
  // 不返回字符串的照 JSON 记
  assert.deepEqual(byName("refCoverage").map((c) => c.returned), [0, 0.75, 2 / 3]);
  assert.deepEqual(byName("blockHasRefs").map((c) => c.returned), [true, false, false]);
  // 把关那一问：只写了页号（带 p: 的、不带的各一条）而书架上没有这页
  const ask = String(byName("checkAsk")[0]!.returned);
  assert.ok(ask.includes("书架上没找到这页（p:20481）。") && ask.includes("书架上没找到这页（20517）。"), "both forms of a bare page id");
  // 渲染字符串的函数，每组参数给出的字都不一样（同一个函数两组参数出一样的字，多半是夹具没走到新分支）
  for (const e of entries) {
    if (!e.calls) continue;
    const outs = byName(e.name).map((c) => c.returned);
    if (outs.some((x) => typeof x !== "string")) continue;
    assert.equal(new Set(outs).size, outs.length, `${e.name}: two fixtures render the same text`);
  }

  assert.deepEqual(byName("languageLine").map((c) => c.returned), ["", "- 你自己想的、说的、记下的都用中文；跟别人说话时，对方用什么语言就用什么语言。"]);
  const prefixes = byName("buildPrefix").map((c) => c.returned as string);
  assert.ok(prefixes[1]!.includes("最近这一段（事件库）") && !prefixes[1]!.includes("### 最近 7 天有进展的"), "midterm drops the thread tiers from the ledger");
  assert.ok(prefixes[0]!.includes("### 最近 7 天有进展的") && !prefixes[3]!.includes("# 你的人生"));
  const dropped = byName("dropThreadTiers")[0]!.returned as string;
  assert.ok(!/最近 7 天有进展|天前动过的|只记个名|最近\s*3\s*天|10-29|没有事件线有进展|memory\/threads/.test(dropped), dropped);
  assert.ok(dropped.includes("- 10-31 这条不跟在那句后面，留着。") && !dropped.includes("\n\n\n"));
  // 脑区定义：配置不当参数记（boot 里有），只记整份返回
  const [spec] = byName("regionSpecs");
  assert.deepEqual(spec!.args, []);
  const specs = spec!.returned as Array<{ id: string; roleText: string; tools: string[] }>;
  assert.deepEqual([specs[0]!.id, specs.at(-1)!.id], ["main", "hippocampus"]);
  assert.ok(specs.some((s) => s.id === "deep") && specs.every((s) => s.roleText.length > 0 && s.tools.length > 0), "whole spec objects");

  // 从名单算的两组 inboundTrigger（最后两条）：主人老林、第一个访客小禾，关系是树自己的 relationOf 给的，记的是算出来的参数
  const inbound = byName("inboundTrigger");
  const [owner, guest] = inbound.slice(-2) as [Rec, Rec];
  const ownerWho = owner.args![2] as { relation: string };
  const guestWho = guest.args![2] as { relation: string };
  assert.deepEqual(owner.args, ["老林", { channel: "qqbot", target: "qqbot:c2c:0000000000000000000000000000A001" }, { relation: relationOf({ key: "laolin", name: "老林", privacy: "owner" }), owner: true }]);
  assert.deepEqual(guest.args, ["小禾", null, { relation: relationOf({ key: "xiaohe", name: "小禾", privacy: "guest" }), owner: false }]);
  assert.equal(owner.returned, P.inboundTrigger("老林", { channel: "qqbot", target: "qqbot:c2c:0000000000000000000000000000A001" }, ownerWho));
  assert.equal(guest.returned, P.inboundTrigger("小禾", undefined, guestWho));
  assert.ok(!(owner.returned as string).includes("说话前想清楚对面是谁"), "relationOf's owner text takes the owner arm");
  assert.ok((guest.returned as string).includes(`小禾是${guestWho.relation}`) && (guest.returned as string).includes("说话前想清楚对面是谁"));
  // relationOf 的四种关系（主人、信任的访客、访客、陌生人）都拼进过 inboundTrigger，跟快照上的名单无关
  const relationIn = (c: Rec): string | undefined => (c.args?.[2] as { relation?: string } | undefined)?.relation;
  const relations = new Set(inbound.map(relationIn));
  for (const p of [{ key: "k", name: "老林", privacy: "owner" }, { key: "k", name: "小禾", privacy: "guest", trust: "trusted" }, { key: "k", name: "小禾", privacy: "guest" }, null]) {
    assert.ok(relations.has(relationOf(p)), `relationOf(${JSON.stringify(p)}) is rendered`);
  }
  const stranger = inbound.find((c) => relationIn(c) === relationOf(null))!;
  assert.ok((stranger.returned as string).includes(`${String(stranger.args![0])}是${relationOf(null)}`));
});

/** 名单换成 registry 跑一次 prompts，给回 inboundTrigger 的那几条 */
let unresolved: Array<Record<string, unknown>> = [];
const inboundWithRegistry = (registry: Record<string, unknown>): Rec[] => {
  const root = tmpDir("hh-parity-prompts-");
  const snap = buildSnapshot(root, { files: { "memory/people/registry.json": `${JSON.stringify(registry)}\n` } });
  const out = join(root, "out");
  const r = spawnSync(process.execPath, [MAIN, "dump", "--data", snap.data, "--work", join(root, "work"), "--out", out, "--scenario", "prompts"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const recs = readFileSync(join(out, "prompts", "transcript.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  assert.equal(recs.at(-1)!.name, "regionSpecs", "the scenario goes on after a fixture that cannot be resolved");
  unresolved = recs.filter((r) => r.kind === "log") as unknown as Array<Record<string, unknown>>;
  return recs.filter((c) => c.name === "inboundTrigger");
};

test("parity dump prompts: the registry lists fall through to the first record that identifies as itself; none at all is recorded as threw (args null)", () => {
  const owner = { name: "老林", privacy: "owner", senders: ["qq:owner-0001"], sessionKeys: ["agent:main:main"] };
  // 前两个访客认不出自己：一个没写号，一个的号跟主人撞了（认出来是主人）；第三个才认得出
  const through = inboundWithRegistry({ laolin: owner, noids: { privacy: "guest" }, shadow: { privacy: "guest", senders: ["qq:owner-0001"] }, xiaohe: { name: "小禾", privacy: "guest", senders: ["qq:guest-0002"] } });
  assert.deepEqual(through.at(-1)!.args, ["小禾", null, { relation: relationOf({ key: "xiaohe", name: "小禾", privacy: "guest" }), owner: false }]);
  assert.equal((through.at(-2)!.args as unknown[])[0], "老林");

  const none = inboundWithRegistry({ laolin: owner, noids: { privacy: "guest" }, shadow: { privacy: "guest", senders: ["qq:owner-0001"] } });
  const last = none.at(-1)!;
  assert.deepEqual(last, { n: last.n, t: last.t, kind: "call", name: "inboundTrigger", args: null, threw: "parity fixture: Error: no non-owner record of the registry is identified by its own senders / sessionKeys" });
  assert.equal((none.at(-2)!.args as unknown[])[0], "老林");
  // 没渲染的那一组另有一句 warn 的日志：dump 打日志的地方看得到，不会当它比过了
  assert.deepEqual(unresolved.map((r) => [r.level, r.mod, r.msg, r.error]), [[
    "warn", "parity", "parity: prompts: a fixture of inboundTrigger could not be computed from this snapshot and was not rendered",
    "Error: no non-owner record of the registry is identified by its own senders / sessionKeys",
  ]]);
});
