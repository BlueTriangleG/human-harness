// 对照工具的 tools 场景（每个工具都经真的 handler 调一遍）：在小快照上跑两次一个字节不差；主线每个该调的工具都有回话；
// 存着的调用照原样的参数再调（重复的、拆不开的、别的脑区的、内核自带的、不调的都不再调）；存着的调用怎么挑（不一样的优先、其次最近的）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CentralMemory } from "../src/memory/central.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import { openDb } from "../src/store/db.ts";
import { callKind, parseAct, pickCalls, storedCalls } from "../src/parity/stored.ts";
import { SKIPPED_TOOLS } from "../src/parity/scenarios/tools.ts";
import { buildSnapshot, TAKEN_AT, upToState, type CentralRow } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";

const MAIN = resolve(fileURLToPath(import.meta.url), "../../src/parity/main.ts");
const dump = (...args: string[]) => spawnSync(process.execPath, [MAIN, "dump", ...args], { encoding: "utf8" });

interface Rec { n: number; t: number; kind: string; [k: string]: unknown }
const transcript = (out: string): { raw: string; recs: Rec[] } => {
  const raw = readFileSync(join(out, "tools", "transcript.jsonl"), "utf8");
  return { raw, recs: raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec) };
};

const min = (k: number): number => TAKEN_AT - k * 60_000;
let toolUse = 0;
/** 一行 act，照 Brain 记的样子：「<工具> <参数 JSON>」，meta 是 {tool, id} */
const act = (src: string, tool: string, args: unknown, at: number, text?: string): CentralRow =>
  ({ src, kind: "act", text: text ?? `${tool} ${JSON.stringify(args)}`, meta: { tool, id: `toolu_${String(++toolUse).padStart(4, "0")}` }, at });

/** 小快照的配置下有的脑区（两个一心多用、没有下意识） */
const REGIONS = ["main", "side-1", "side-2", "deep", "speech", "hippocampus"];
const NOTE = { text: "老林的刨子在工作台左边的抽屉里" };
const ACTS: CentralRow[] = [
  act("main", "jot_down", NOTE, min(40)),
  act("main", "message", { action: "send", channel: "whatsapp", target: "老林", message: "木料收好了，盖了布" }, min(39)),
  act("main", "reminders", { action: "ls" }, min(38)),
  act("main", "jot_down", { text: "小禾问集市几点开", urgent: true }, min(37)),
  act("main", "jot_down", { ...NOTE }, min(36)),                                        // 跟第一条一样：只再调一次
  act("main", "jot_down", null, min(35), "jot_down {\"text\":\"没写完的"),                // 拆不开：不调
  act("main", "Bash", { command: "ls" }, min(34)),                                     // 内核自带的：不调
  act("main", "browser", { action: "open", url: "https://example.com" }, min(33)),     // 不调的
  act("perception-messages", "jot_down", { text: "已经不在的脑区记的" }, min(32)),         // 脑区已经不在：不调
  act("side-1", "on_it", { topic: "整理木料清单", about: "半小时", pri: "T2" }, min(31)),
  act("hippocampus", "mem_event_create", { title: "集市", summary: "下周三去集市", gist: "下周三去集市", importance: 2 }, min(30)),
  act("speech", "jot_down", NOTE, min(29)),                                             // 随口那头自己的那次：在它那里再调
  // 下面这些让小快照上也走到各个 handler 的身子（不只是参数检查）
  act("main", "my_likes", {}, min(28)),                                                 // 跟 {} 那次一样：不再调
  act("main", "goals", { args: ["ls"] }, min(27)),
  act("main", "recall", { args: ["search", "刨子"] }, min(26)),
  act("main", "remember", { cue: "集市" }, min(25)),
  act("main", "recall_period", { when: "今天" }, min(24)),
  act("main", "like", { what: "刨花", how: "like", feeling: "闻着香" }, min(23)),
  act("main", "what_reaches_me", { action: "list" }, min(22)),
  act("main", "people_i_know", { action: "list" }, min(21)),
  act("main", "sticker", { mood: "开心", to: "+1055500001" }, min(20)),                 // 编的号：名单上老林没有 WhatsApp 号
  act("main", "remind", { when: "+40m", text: "把木料翻个面" }, min(19)),
  act("main", "hands", { action: "ls" }, min(18)),
  act("main", "on_it", { topic: "给小禾回集市时间", about: "3分钟" }, min(17)),
  act("main", "done_with", { topic: "给小禾回集市时间", state: "做完了" }, min(16)),
  act("hippocampus", "mem_worklist", { day: "2026-10-31" }, min(15)),
];

test("parity dump tools on the fixture: two runs are byte-identical; every main tool answered; stored calls replayed with their stored arguments", () => {
  const root = tmpDir("hh-parity-tools-");
  const snap = buildSnapshot(root, { config: { tools: { sendDryRun: false } }, extraCentral: ACTS });
  const runs = ["1", "2"].map((k) => {
    const out = join(root, `out${k}`);
    const r = dump("--data", snap.data, "--work", join(root, `work${k}`), "--out", out, "--scenario", "tools");
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return transcript(out);
  });
  assert.equal(runs[0]!.raw, runs[1]!.raw, "deterministic across two processes and two work dirs");
  const recs = runs[0]!.recs;
  assert.ok(!recs.some((r) => r.kind === "log" && r.level === "error"), JSON.stringify(recs.filter((r) => r.kind === "log")));
  assert.ok(!recs.some((r) => r.kind === "refused" || r.kind === "net" || r.kind === "spawn"), "nothing reached outside the fences");

  // 每个脑区、会话工具表里每个该调的工具：先一次 {}；browser、computer 一次都不调
  const opens = recs.filter((r) => r.kind === "open");
  const scripts = recs.filter((r) => r.kind === "script").map((r) => ({ region: String(r.region), script: r.script as { tool?: { name: string; args: Record<string, unknown> }; say?: string } }));
  const called = scripts.filter((s) => s.script.tool);
  for (const region of REGIONS) {
    const o = opens.find((x) => x.region === region)!;
    for (const t of o.tools as Array<{ name: string }>) {
      if (SKIPPED_TOOLS.has(t.name)) continue;
      assert.ok(called.some((s) => s.region === region && s.script.tool!.name === t.name && Object.keys(s.script.tool!.args).length === 0), `${region} ${t.name} {}`);
    }
  }
  assert.ok(!called.some((s) => SKIPPED_TOOLS.has(s.script.tool!.name)), "browser and computer are never called");

  // 主线每个该调的工具都有回话（参数检查的话也算）
  const mainTools = (opens.find((o) => o.region === "main")!.tools as Array<{ name: string }>).map((t) => t.name).filter((n) => !SKIPPED_TOOLS.has(n));
  assert.ok(mainTools.includes("jot_down") && mainTools.includes("remember") && mainTools.includes("people_i_know"), mainTools.join(","));
  const results = recs.filter((r) => r.kind === "result");
  for (const name of mainTools) assert.ok(results.some((r) => r.region === "main" && r.tool === name), `main ${name} has a result`);
  // {} 拿到的是参数检查的话
  const jotEmpty = results.find((r) => r.region === "main" && r.tool === "jot_down" && r.isError === true)!;
  assert.match(String(jotEmpty.text), /^Input validation error: Invalid arguments for tool jot_down: text: /);

  // 存着的调用照原样再调：主线的 jot_down 两种（一样的那条只调一次），message、reminders 各一次；别的都不调
  const replayed = (region: string, name: string) => called.filter((s) => s.region === region && s.script.tool!.name === name && Object.keys(s.script.tool!.args).length > 0).map((s) => s.script.tool!.args);
  assert.deepEqual(replayed("main", "jot_down"), [{ text: "小禾问集市几点开", urgent: true }, NOTE], "oldest first; of the two identical calls the newer one counts");
  assert.deepEqual(replayed("main", "message"), [{ action: "send", channel: "whatsapp", target: "老林", message: "木料收好了，盖了布" }]);
  assert.deepEqual(replayed("main", "reminders"), [{ action: "ls" }]);
  assert.deepEqual(replayed("side-1", "on_it"), [{ topic: "整理木料清单", about: "半小时", pri: "T2" }]);
  const MARKET = { title: "集市", summary: "下周三去集市", gist: "下周三去集市", importance: 2 };
  assert.deepEqual(replayed("hippocampus", "mem_event_create"), [MARKET, MARKET], "once in the day, once inside the night batch");
  assert.deepEqual(replayed("speech", "jot_down"), [NOTE]);
  assert.deepEqual(replayed("side-1", "jot_down"), [], "a call made by one region is not replayed in another");
  assert.ok(!called.some((s) => s.script.tool!.name === "Bash"));
  assert.ok(!called.some((s) => s.region.startsWith("perception")));
  assert.equal(called.filter((s) => s.region === "main" && s.script.tool!.name === "my_likes").length, 1, "a stored {} is the {} call already made");
  // 要跑的命令照记（goals.py、贴纸的 sticker.py），没真跑
  const runs0 = recs.filter((r) => r.kind === "run").map((r) => (r.args as string[]).join(" "));
  assert.ok(runs0.some((a) => a.endsWith("scripts/goals.py ls")), runs0.join("\n"));
  assert.ok(runs0.some((a) => a.includes("sticker.py prepare --mood 开心")), runs0.join("\n"));
  // 照原样再调的 jot_down 记下了、记进了中央记忆（那一轮的 result 跟在它的 script 后面）
  const i = recs.findIndex((r) => r.kind === "script" && r.region === "main" && JSON.stringify((r.script as { tool?: { args: unknown } }).tool?.args) === JSON.stringify(NOTE));
  const after = recs.slice(i).find((r) => r.kind === "result" && r.region === "main")!;
  assert.deepEqual([after.tool, after.text, after.isError], ["jot_down", "记下了。", false]);
  // 存着的 message 经网关发给了老林（名单上的名字换成号）
  assert.ok(recs.some((r) => r.kind === "gateway" && r.method === "send" && (r.params as { message?: string }).message === "木料收好了，盖了布"));
  // 白天调整理记忆的写工具被拒，拒的话照记
  assert.ok(results.some((r) => r.region === "hippocampus" && r.tool === "mem_event_create" && String(r.text).startsWith("没做成：")), "a night-only write is refused in the day");
  // 每个演的工具名在它那个会话的工具表里都有（假内核找不到工具时回的那句一次都没有）
  assert.ok(!results.some((r) => r.text === "(no such tool)"), "every scripted tool name matched a tool of its session");
  // 夜里那一跑：照 Brain 的样子开、收；写工具在这一跑里写成了，回的是写成了的话
  const mems = recs.filter((r) => r.kind === "call" && ["revertNight", "beginNight", "commitNight"].includes(String(r.name)));
  assert.deepEqual(mems.map((r) => [r.name, r.args, r.returned]), [
    ["revertNight", {}, null], ["beginNight", { id: "night:2026-10-31/today" }, null], ["commitNight", { day: null }, null],
  ]);
  const inNight = recs.slice(mems[1]!.n + 1, mems[2]!.n).filter((r) => r.kind === "result");
  assert.ok(inNight.length > 0 && inNight.every((r) => r.region === "hippocampus" && String(r.tool).startsWith("mem_")));
  assert.ok(inNight.some((r) => r.tool === "mem_event_create" && /^建好了 e\d+「集市」。$/.test(String(r.text))), JSON.stringify(inNight.filter((r) => r.tool === "mem_event_create")));
  assert.ok(!inNight.some((r) => r.tool === "mem_worklist"), "the read-only worklist is not repeated at night");
  // 没回的 send 回的都是「（对照）」
  assert.ok(scripts.some((s) => s.script.say === "（对照）"));
  // 最后：调了哪些、各再调了几次存着的、按设计不调的；总数一行；再是状态
  const end = upToState(recs);
  const cov = end.at(-5)!;
  assert.equal(cov.name, "tools-coverage");
  const covered = cov.returned as { regions: Array<{ region: string; tools: Array<{ name: string; stored: number }>; skipped: string[] }>; night: { region: string; tools: Array<{ name: string; stored: number }> } };
  assert.deepEqual(covered.regions.map((r) => r.region), REGIONS);
  const main = covered.regions[0]!;
  assert.deepEqual(main.tools.map((t) => t.name), mainTools);
  assert.deepEqual(main.skipped, ["computer", "browser"]);
  assert.deepEqual(Object.fromEntries(main.tools.filter((t) => t.stored).map((t) => [t.name, t.stored])), {
    message: 1, jot_down: 2, on_it: 1, done_with: 1, remind: 1, reminders: 1, goals: 1, hands: 1, recall: 1,
    what_reaches_me: 1, people_i_know: 1, sticker: 1, remember: 1, recall_period: 1, like: 1,
  });
  assert.equal(covered.night.region, "hippocampus");
  assert.deepEqual(covered.night.tools.filter((t) => t.stored).map((t) => [t.name, t.stored]), [["mem_event_create", 1]]);
  // 总数：白天那一遍、夜里那一遍分开数，两边数的是同一样东西（调了几个工具、另外再调了几次存着的）
  const count = (xs: Array<{ stored: number }>) => ({ called: xs.length, storedCalls: xs.reduce((n, t) => n + t.stored, 0) });
  const totals = (cov.returned as { totals: unknown }).totals;
  const nightTools = covered.night.tools.length;
  assert.deepEqual(totals, { day: count(covered.regions.flatMap((r) => r.tools)), night: count(covered.night.tools), skipped: ["browser", "computer"] });
  assert.deepEqual(totals, { day: { called: 83, storedCalls: 20 }, night: { called: nightTools, storedCalls: 1 }, skipped: ["browser", "computer"] });
  assert.ok(nightTools > 1 && nightTools === inNight.filter((r) => r.isError === true || r.isError === false).length - 1, "one {} call per night tool, plus the one stored call");
  assert.deepEqual([end.at(-4)!.kind, end.at(-4)!.level, end.at(-4)!.msg], ["log", "info", `parity: tools called=83(day)+${nightTools}(night) stored-calls=20(day)+1(night) skipped=browser,computer`]);
  assert.deepEqual(end.slice(-3).map((r) => [r.kind, r.name]), [["state", "status"], ["state", "db"], ["state", "files"]]);
});

test("parity stored calls: act rows parse back to tool and arguments; newest first, one per distinct call, only wanted (region, tool); broken rows skipped", () => {
  assert.deepEqual(parseAct("jot_down {\"text\":\"嗯\"}"), { tool: "jot_down", args: { text: "嗯" } });
  assert.deepEqual(parseAct("goals {\"args\":[\"ls\"]}"), { tool: "goals", args: { args: ["ls"] } });
  for (const bad of ["jot_down", " {\"text\":\"嗯\"}", "jot_down {\"text\":", "jot_down undefined", "jot_down [1]", "jot_down null", "jot_down \"嗯\""]) assert.equal(parseAct(bad), null, bad);

  const db = openDb(":memory:");
  const epoch = new Epochs(db, () => min(100)).begin("boot", 1);
  const central = new CentralMemory(db);
  for (const r of ACTS) central.append(epoch.id, r.src, r.kind, r.text, r.meta ?? null, r.at);
  central.append(epoch.id, "main", "result", "记下了。", { id: "toolu_0001" }, min(28));
  const wanted = new Map([["main", new Set(["jot_down", "message", "reminders"])], ["side-1", new Set(["on_it", "jot_down"])]]);
  const calls = storedCalls(db, (region, tool) => wanted.get(region)?.has(tool) === true);
  assert.deepEqual(calls.map((c) => [c.region, c.tool, c.args]), [
    ["side-1", "on_it", { topic: "整理木料清单", about: "半小时", pri: "T2" }],
    ["main", "jot_down", NOTE],
    ["main", "jot_down", { text: "小禾问集市几点开", urgent: true }],
    ["main", "reminders", { action: "ls" }],
    ["main", "message", { action: "send", channel: "whatsapp", target: "老林", message: "木料收好了，盖了布" }],
  ]);
  assert.equal(calls[1]!.seq, 5, "of two identical calls the newest stays");
  // 给了范围：库里先按脑区、工具名筛（wanted 什么都要也只回范围里的），筛完结果跟不给范围一样
  const scoped = storedCalls(db, () => true, { regions: ["main", "side-1"], tools: ["jot_down", "message", "reminders", "on_it"] });
  assert.deepEqual(scoped.map((c) => [c.region, c.tool]), [
    ["main", "on_it"], ["side-1", "on_it"], ["main", "jot_down"], ["main", "jot_down"], ["main", "reminders"], ["main", "message"],
  ]);
  assert.deepEqual(storedCalls(db, (region, tool) => wanted.get(region)?.has(tool) === true, { regions: ["main", "side-1"], tools: ["jot_down", "message", "reminders", "on_it"] }), calls);
  central.append(epoch.id, "main", "act", "jot_down", { tool: "jot_down" }, min(27));
  assert.equal(storedCalls(db, () => true, { regions: ["main"], tools: ["jot_down"] }).length, 2, "a row with no arguments at all is skipped");
  // 键的先后不算不一样
  central.append(epoch.id, "main", "act", "jot_down {\"urgent\":true,\"text\":\"小禾问集市几点开\"}", { tool: "jot_down" }, min(27));
  assert.equal(storedCalls(db, (region, tool) => region === "main" && tool === "jot_down").length, 2);
  db.close();
});

test("parity pickCalls: the last n distinct calls, oldest first, but every argument shape and every value of the first choice keeps one", () => {
  const shape = { action: z.enum(["send", "show", "ls", "stop"]), name: z.string().optional(), text: z.string().optional() };
  assert.equal(callKind({ shape }, { action: "ls" }), callKind({ shape }, { action: "ls" }));
  assert.notEqual(callKind({ shape }, { action: "ls" }), callKind({ shape }, { action: "stop" }), "the first choice's value counts");
  assert.notEqual(callKind({ shape }, { action: "show", name: "a" }), callKind({ shape }, { action: "show" }), "the keys given count");
  assert.equal(callKind({ shape }, { action: "show", name: "a" }), callKind({ shape }, { name: "b", action: "show" }), "values other than the choice do not");
  // 只有一个值的可选项不算；照命令行给参数的工具按子命令分
  const message = { action: z.enum(["send"]).default("send"), channel: z.string(), target: z.string() };
  assert.equal(callKind({ shape: message }, { action: "send", channel: "a", target: "x" }), callKind({ shape: message }, { action: "send", channel: "b", target: "y" }));
  const cli = { args: z.array(z.string()) };
  assert.notEqual(callKind({ shape: cli }, { args: ["ls"] }), callKind({ shape: cli }, { args: ["log", "g1", "推进了"] }));
  assert.equal(callKind({ shape: cli }, { args: ["log", "g1", "推进了"] }), callKind({ shape: cli }, { args: ["log", "g2", "又推进了"] }));

  // 新的在前：八次 ls 里夹着一次 stop、一次带 name 的 show；挑 4 次 → 最近的 ls 两次 + stop + show，老的在前
  const at = (seq: number, args: Record<string, unknown>) => ({ seq, region: "main", tool: "hands", args });
  const newestFirst = [at(10, { action: "ls" }), at(9, { action: "ls" }), at(8, { action: "ls" }), at(7, { action: "ls" }), at(6, { action: "show", name: "a" }), at(5, { action: "ls" }), at(4, { action: "stop", name: "a" }), at(3, { action: "ls" })];
  assert.deepEqual(pickCalls(newestFirst, 4, (c) => callKind({ shape }, c.args)).map((c) => c.seq), [4, 6, 9, 10]);
  assert.deepEqual(pickCalls(newestFirst.slice(0, 2), 6, (c) => callKind({ shape }, c.args)).map((c) => c.seq), [9, 10], "fewer than n: all of them");
});
