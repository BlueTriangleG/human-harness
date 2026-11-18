// 夜里整理的「专员 + 领导」模式（engine: "team"，跟 "flow" 并排）：几个专员一个个做，领导出题、看改动、判前后一致。
// 没写 engine: "team" 的流程：JSON、哈希跟以前一字不差。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { parseFlow, FlowError, type FlowConfig, type TeamConfig } from "../src/sleep/flow.ts";
import { readNight, type NightBrain, type NightPlan } from "../src/sleep/host.ts";
import { assembleNight } from "../src/sleep/night.ts";
import { Budget, DEFAULT_WEIGHTS } from "../src/sleep/budget.ts";
import { readFileSync } from "node:fs";
import { openDb } from "../src/store/db.ts";
import { openStageSession } from "../src/sleep/session.ts";
import { EventStore, type OpRow } from "../src/memory/events/store.ts";
import { parseTemplate } from "../src/memory/events/people.ts";
import { batchDiff, specialistDiff, leadDiffPath } from "../src/sleep/opsdiff.ts";
import { snapDiff } from "../src/sleep/review.ts";
import type { MiniFs, Snapshot } from "../src/sleep/record.ts";
import { FakeDriver } from "../src/kernel/fake.ts";
import { Logger } from "../src/log.ts";
import { nightHosts, sleepWeights } from "../src/sleep/host.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { existsSync } from "node:fs";
import { memTools } from "../src/tools/memtools.ts";
import * as LP from "../src/sleep/leadprompts.ts";
import { Lead, leadRuled, leadQuestionProblem, goldRevisionProblem, withdrawProblem, type LeadLike } from "../src/sleep/lead.ts";
import type { LeadHost } from "../src/sleep/host.ts";
import type { LeadQuestion, LeadReview, LeadVerdict, StageDone } from "../src/sleep/tools.ts";
import type { ConsistencyResult } from "../src/sleep/consistency.ts";
import type { SpecialistDiff } from "../src/sleep/opsdiff.ts";
import type { StageSpec } from "../src/sleep/flow.ts";
import * as P from "../src/lang/zh/prompts.ts";
import { consistencyExam, continuityExam } from "../src/sleep/consistency.ts";
import { TeamRunner } from "../src/sleep/teamrun.ts";
import { Bank, type Question, type Verdict } from "../src/sleep/bank.ts";
import type { ExamHost } from "../src/sleep/exam.ts";
import type { ExamAnswers, ExamGrades } from "../src/sleep/tools.ts";
import { SLEEP_BUILTINS, SLEEP_HH_TOOLS } from "../src/sleep/host.ts";
import { MEM_STORE_WRITERS } from "../src/tools/memtools.ts";
import { memorySink, type LogRecord } from "../src/log.ts";
import type { FakeSession } from "../src/kernel/fake.ts";
import { all, type Db } from "../src/store/db.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { runProcess } from "../src/util/run.ts";
import { ReplayManager, nightWindow, type ReplayDeps } from "../src/sleep/replay.ts";
import * as Ledger from "../src/sleep/ledger.ts";
import { restartStatus, dbEnv } from "../src/sleep/replay.ts";
import { replayArgs } from "../src/sleep/host.ts";
import { nextDayStart } from "../src/brainstem/clock.ts";
import { RestartGate } from "../src/repair/restart.ts";
import { writeDeployed } from "../src/repair/log.ts";
import { loadRules } from "../src/repair/rules.ts";
import type { BrainStatus } from "../src/brain.ts";
import { UsageTally } from "../src/kernel/sdk.ts";
import { cacheKeyOf } from "../src/sleep/cachekey.ts";

const known = { tools: new Set(["mem_write", "note"]), builtins: new Set(["apply"]), memWriters: new Set(["mem_write"]) };
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "agent", skill: `${id}.md`, ...extra });
const script = (id: string, command: string[], extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "script", command, ...extra });
const problemsOf = (f: () => unknown): string[] => { try { f(); return []; } catch (e) { return (e as FlowError).problems; } };

const STAGES = [agent("events", { writes: ["memory/**"] }), agent("people", { after: ["events"], writes: ["people/**"] }), script("finish", ["finish"], { after: ["people"] })];
/** 一份能过的 team 配置（raw）；over 盖全局的键，team 盖 team 块里的键（null = 整块不写） */
const teamRaw = (over: Record<string, unknown> = {}, team: Record<string, unknown> | null = {}): Record<string, unknown> => ({
  engine: "team", maxParallel: 1, exam: { baseBlocks: ["SOUL.md"] }, stages: STAGES,
  ...(team ? { team: { lead: { model: "opus", skill: "lead.md", turnMinutes: 15 }, ...team } } : {}),
  ...over,
});
const parseTeam = (over?: Record<string, unknown>, team?: Record<string, unknown> | null): FlowConfig => parseFlow(teamRaw(over, team), known);

// ---------- T1：配置 ----------

test("lead config: engine team parses; the team block carries the lead and the defaults", () => {
  const f = parseTeam();
  assert.equal(f.engine, "team");
  const want: TeamConfig = { lead: { model: "opus", skill: "lead.md", turnMinutes: 15 }, maxFixRounds: 2, continuity: [], tolerance: 0.85 };
  assert.deepEqual(f.team, want);

  const full = parseTeam({}, { lead: { model: "sonnet", skill: "pages/lead.md", turnMinutes: 8 }, maxFixRounds: 0, continuity: ["问一", "问二"], tolerance: 1 });
  assert.deepEqual(full.team, { lead: { model: "sonnet", skill: "pages/lead.md", turnMinutes: 8 }, maxFixRounds: 0, continuity: ["问一", "问二"], tolerance: 1 });

  // lead 的 model、turnMinutes 可以不写
  const short = parseTeam({}, { lead: { skill: "lead.md" } });
  assert.equal(short.team!.lead.model, "opus");
  assert.ok(short.team!.lead.turnMinutes > 0);
  assert.equal(parseTeam({}, { tolerance: 0 }).team!.tolerance, 0);
});

test("lead config: a team engine without a usable team block is refused", () => {
  assert.ok(problemsOf(() => parseTeam({}, null)).some((p) => /team/.test(p) && /没写/.test(p)), "没有 team 块");
  assert.ok(problemsOf(() => parseTeam({ team: "x" })).some((p) => /team/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ team: {} })).some((p) => /lead/.test(p)), "没有 lead");
  for (const lead of [{ model: "opus" }, { skill: "" }, { skill: "/abs/lead.md" }, { skill: "../lead.md" }, { skill: "lead.md", model: "gpt" },
    { skill: "lead.md", turnMinutes: 0 }, { skill: "lead.md", turnMinutes: "5" }]) {
    assert.ok(problemsOf(() => parseTeam({}, { lead })).some((p) => /lead/.test(p)), JSON.stringify(lead));
  }
  for (const v of [3, -1, 1.5, "2"]) assert.ok(problemsOf(() => parseTeam({}, { maxFixRounds: v })).some((p) => /maxFixRounds/.test(p)), `maxFixRounds ${v}`);
  for (const v of [1.1, -0.1, "0.9", { keepWrong: 0, newWrong: 0, missedWrong: 0 }]) {
    assert.ok(problemsOf(() => parseTeam({}, { tolerance: v })).some((p) => /tolerance/.test(p)), `tolerance ${JSON.stringify(v)}`);
  }
  for (const v of ["问", [1], [""]]) assert.ok(problemsOf(() => parseTeam({}, { continuity: v })).some((p) => /continuity/.test(p)), `continuity ${JSON.stringify(v)}`);
});

test("lead config: team rules — one at a time, no stage exam, no personas or coordinator, base blocks, finish", () => {
  assert.ok(problemsOf(() => parseTeam({ maxParallel: 2 })).some((p) => /maxParallel/.test(p)));
  // 没写 maxParallel（默认 2）也不行：得明写 1
  const noPar = teamRaw(); delete noPar.maxParallel;
  assert.ok(problemsOf(() => parseFlow(noPar, known)).some((p) => /maxParallel/.test(p)));

  const withExam = [agent("events", { writes: ["memory/**"], exam: { min: 1 } }), script("finish", ["finish"], { after: ["events"] })];
  assert.ok(problemsOf(() => parseTeam({ stages: withExam })).some((p) => /events/.test(p) && /exam/.test(p)));

  const withPersona = [agent("events", { writes: ["memory/**"], persona: "a" }), script("finish", ["finish"], { after: ["events"] })];
  assert.ok(problemsOf(() => parseTeam({ stages: withPersona, personasFile: "personas.json" })).some((p) => /personasFile/.test(p) && /team/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ coordinator: { model: "opus" } })).some((p) => /coordinator/.test(p) && /team/.test(p)));

  assert.ok(problemsOf(() => parseTeam({ exam: {} })).some((p) => /baseBlocks/.test(p)));
  const noExamKey = teamRaw(); delete noExamKey.exam;
  assert.ok(problemsOf(() => parseFlow(noExamKey, known)).some((p) => /baseBlocks/.test(p)));

  assert.ok(problemsOf(() => parseTeam({ stages: [agent("events", { writes: ["memory/**"] })] })).some((p) => /finish/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ stages: [agent("events", { writes: ["memory/**"] }), script("finish", ["finish"], { enabled: false })] })).some((p) => /finish/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ stages: [script("finish", ["finish"])] })).some((p) => /agent/.test(p)));
});

test("lead config: without engine team nothing changes — no team key, same JSON and hash as before", () => {
  const stages = [agent("people", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["people"] })];
  for (const engine of ["flow", "legacy", undefined]) {
    const raw = { ...(engine ? { engine } : {}), stages };
    const f = parseFlow(raw, known);
    assert.ok(!("team" in f), `engine ${engine}: 没有 team 键`);
    // 写了 team 块但 engine 不是 team：不看它，结果里也没有（把 engine 改回去就是回滚）
    const kept = parseFlow({ ...raw, team: { lead: { skill: "lead.md" } } }, known);
    assert.equal(JSON.stringify(kept), JSON.stringify(f));
  }
  // 跟这次改动以前的结果一字不差（键的顺序也算）：这一串是改动前 parseFlow 给的
  const flow = parseFlow({ engine: "flow", stages }, known);
  assert.deepEqual(Object.keys(flow), ["engine", "maxParallel", "budget", "saveMode", "auditModel", "checks", "exam", "stages"]);
  assert.equal(createHash("sha256").update(JSON.stringify(flow)).digest("hex").slice(0, 16), FLOW_HASH_BEFORE);
});
/** 上面那份 flow 配置在加 engine team 以前的哈希（在 ef67aeb 上算的） */
const FLOW_HASH_BEFORE = "1ebf4989676e7546";

// ---------- T1：readNight ----------

const W = "/ws";
const D = `${W}/scripts/sleep_flow`;
const nightFiles = (flow: Record<string, unknown>, drop: string[] = []): Map<string, string> => {
  const m = new Map([
    [`${D}/flow.json`, JSON.stringify(flow)], [`${W}/SOUL.md`, "SOUL"], [`${D}/common.md`, "COMMON"],
    [`${D}/events.md`, "页"], [`${D}/people.md`, "页"], [`${D}/lead.md`, "领导的页"],
  ]);
  for (const d of drop) m.delete(d);
  return m;
};
const readWith = (m: Map<string, string>) => {
  const cfg = loadConfig({ workspace: W, stateDir: mkdtempSync(join(tmpdir(), "hh-lead-read-")) });
  return readNight({ cfg, read: (p) => m.get(p) ?? null, write: () => {} });
};

test("lead readNight: a team flow is checked like a flow night, plus the lead's skill page and the base blocks", () => {
  const noLead = readWith(nightFiles(teamRaw(), [`${D}/lead.md`]));
  assert.ok(!noLead.plan && !noLead.quiet && /没有 skill 页/.test(noLead.why) && /lead\.md/.test(noLead.why), JSON.stringify(noLead));
  const noStagePage = readWith(nightFiles(teamRaw(), [`${D}/people.md`]));
  assert.ok(!noStagePage.plan && /people\.md/.test(noStagePage.why));
  const noSoul = readWith(nightFiles(teamRaw(), [`${W}/SOUL.md`]));
  assert.ok(!noSoul.plan && !noSoul.quiet && /SOUL/.test(noSoul.why));
  // team 没有哪段配 exam，但考生一样要「醒着的她」：基础块一块都读不到就不跑
  const noBase = readWith(nightFiles(teamRaw({ exam: { baseBlocks: ["missing.md"] } })));
  assert.ok(!noBase.plan && !noBase.quiet && /exam base blocks missing/.test(noBase.why));
  // 配置本身不对：跟 flow 一样说问题
  const bad = readWith(nightFiles(teamRaw({ maxParallel: 3 })));
  assert.ok(!bad.plan && bad.problems.some((p) => /maxParallel/.test(p)));
});

// （T6 换掉了 T1 的两条临时测试：team 的夜里接上了，readNight 给 plan，assembleNight 拼 team 的一夜）
test("lead readNight: a valid team flow gives a plan that carries common; a flow plan has no common", () => {
  const r = readWith(nightFiles(teamRaw()));
  assert.ok(r.plan, JSON.stringify(r));
  assert.equal(r.plan.flow.engine, "team");
  // 前缀和 common 末尾都跟着「她用的语言」那一句（配了才有；毛病本那批加的），所以只比开头，再比两边的尾巴一样
  assert.ok(r.plan.common?.startsWith("COMMON"), r.plan.common);
  assert.ok(r.plan.prefix.startsWith("SOUL\n\nCOMMON"), r.plan.prefix);
  assert.equal(r.plan.prefix, `SOUL\n\n${r.plan.common}`);
  const flow = readWith(nightFiles({ engine: "flow", stages: STAGES }));
  assert.ok(flow.plan && flow.plan.flow.engine === "flow" && !("common" in flow.plan));
});

test("lead assembleNight: a team plan is assembled as a team night (TeamRunner, lead host); a team plan without common is refused", () => {
  const n = teamRig();
  assert.ok(n.runner instanceof TeamRunner);
  assert.ok(n.hosts.lead && n.hosts.exam);
  assert.equal(n.hosts.review, null);
  const budget = new Budget({ unitsPerPct: 1000, targetPct: 1, hardPct: 2 });
  assert.throws(() => assembleNight(n.b, { flow: n.flow, prefix: "P", hash: "h" }, { night: "n", budget, weights: DEFAULT_WEIGHTS, auditMs: 1, watchdogMs: 1, maxDays: 1 }), /common/);
  // flow 的 plan 照旧是 SleepRunner
  const flow = parseFlow({ engine: "flow", stages: [agent("events", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["events"] })] }, known);
  const f = assembleNight(n.b, { flow, prefix: "P", hash: "h" }, { night: "n", budget, weights: DEFAULT_WEIGHTS, auditMs: 1, watchdogMs: 1, maxDays: 1 });
  assert.ok(!(f.runner instanceof TeamRunner));
});

// ---------- T3：领导看的改动 ----------

const T0 = Date.UTC(2026, 10, 4, 3, 0);
import { TEST_ROLE } from "./helpers.ts";
const TEMPLATE = parseTemplate(TEST_ROLE.memory.people.template);
const B = "sleep:2026-11-04/events/1";
/** 一个开着的批（没提交）里把每种写都做一遍 */
function busyStore() {
  const db = openDb(":memory:");
  const s = new EventStore(db, () => T0, "UTC", { peopleTemplate: TEMPLATE, owners: new Set(["jia"]) });
  s.upsertEntity({ name: "阿甲", kind: "person", person_key: "jia", importance: 5, why: "测试" }, "b0");
  s.upsertEntity({ name: "阿乙", kind: "person", person_key: "yi" }, "b0");
  const old = s.createEvent({ title: "旧事", summary: "以前的一件事", gist: "以前的事", importance: 2 }, "b0");
  const oldEntry = s.addEntry({ event: old.id, at: T0 - 86_400_000, kind: "happened", full: "旧的经过全文", gist: "旧的经过", title: "旧经过", source: ["c:1"] }, "b0").entry;
  const gone = s.createEvent({ title: "要退休的事", summary: "x", gist: "x", importance: 1 }, "b0");
  const dup = s.createEvent({ title: "重复的事", summary: "y", gist: "y", importance: 1 }, "b0");
  const dupEntry = s.addEntry({ event: dup.id, at: T0 - 86_400_000, kind: "happened", full: "重复那件的经过", gist: "重复的经过", title: "重复经过", source: ["c:2"] }, "b0").entry;
  const stale = s.createEvent({ title: "过时的说法", summary: "z", gist: "z", importance: 1 }, "b0");
  s.link(old.id, gone.id, "related", "要断开的", "b0");
  db.prepare("INSERT INTO mem_quote (src, ref, at, who, channel, text) VALUES ('central', 'c:9', ?, '阿甲', 'qq', '这句要记着')").run(T0 - 3600_000);
  s.commitBatch("b0");

  s.openBatch(B);
  const made = s.createEvent({ title: "新的事", summary: "今晚新建的", gist: "新建", why: "值得记", importance: 4, entities: [{ name: "阿甲", kind: "person", role: "with" }] }, B, "今天聊到的");
  s.updateEvent(old.id, { summary: "改过的摘要", importance: 3 }, "补上今天的", B);
  const added = s.addEntry({ event: made.id, at: T0, kind: "happened", full: "第一行\n第二行", gist: "新的经过", title: "新经过", people: ["阿甲"], source: ["c:120", "c:121"] }, B).entry;
  const fixed = s.correctEntry(oldEntry.id, { full: "更正后的全文", gist: "更正后的", title: "更正", why: "原来写错了" }, B);
  s.link(made.id, old.id, "related", "有关系", B);
  s.unlink(old.id, gone.id, "related", "其实没关系", B);
  s.merge(old.id, [dup.id], "是同一件", B);
  const part = s.split(made.id, [added.id], { title: "拆出来的事", summary: "拆的", gist: "拆", importance: 2 }, B, "是另一件");
  s.supersede(stale.id, made.id, "有了新的说法", B);
  s.retire(gone.id, "不用记了", B);
  s.upsertEntity({ name: "小店", kind: "thing", note: "楼下那家" }, B);
  s.upsertEntity({ name: "阿丙", kind: "person" }, B);
  s.mergeEntities("阿乙", ["阿丙"], "同一个人", B);
  s.tagEntity("小店", made.id, "about", B, "这件事在那里");
  s.upsertEntity({ name: "多余的", kind: "thing" }, B);
  s.dropEntity("多余的", "建错了", B);
  s.setSection({ who: "阿甲", section: "是谁", text: "一起做事的人", sources: [made.id], why: "今天说的" }, B);
  s.pinQuote({ who: "阿甲", section: "记着的原话", quote: "q1", why: "他特意说的" }, B);
  return { s, ids: { old: old.id, made: made.id, added: added.id, fixed: fixed.id, dup: dup.id, dupEntry: dupEntry.id, part: part.id, stale: stale.id, gone: gone.id, oldEntry: oldEntry.id } };
}

test("lead diff: batchDiff renders every row of an open batch — one block per op row, each op kind named", () => {
  const { s, ids } = busyStore();
  assert.equal(s.batchState(B), "open", "批还开着（没提交）");
  const ops = s.ops(B);
  const text = batchDiff(s, B, Infinity);
  assert.match(text, new RegExp(`^事件库这一批（${B.replace("/", "\\/")}.*）一共 ${ops.length} 行变化：`));
  // 一条都不丢：每一行 op 一块
  assert.equal(text.split("\n").filter((l) => l.startsWith("- 【")).length, ops.length);
  // 这一批里出现过的每种 op 都有名字（不是原样的英文）
  for (const kind of new Set(ops.map((o) => o.op))) assert.ok(!text.includes(`【${kind}】`), `${kind} 有中文的名字`);
  const kinds = new Set(ops.map((o) => o.op));
  for (const k of ["event_create", "event_update", "entry_add", "entry_correct", "link", "unlink", "merge", "split", "supersede", "retire",
    "entity_upsert", "entity_merge", "entity_tag", "entity_drop", "impression_set", "impression_pin"]) assert.ok(kinds.has(k), `夹具里有 ${k}`);

  const has = (re: RegExp, what: string) => assert.match(text, re, what);
  has(new RegExp(`【新建事件】事件 ${ids.made}「新的事」：.*摘要：今晚新建的.*重要度：4.*（理由：今天聊到的）`), "create");
  has(new RegExp(`【更新事件】事件 ${ids.old}「旧事」：.*摘要：以前的一件事 → 改过的摘要.*重要度：2 → 3.*（理由：补上今天的）`), "update");
  has(new RegExp(`【加经过】经过 ${ids.added}：在 ${ids.made}「新的事」.*全文：第一行\\n  第二行.*出处：c:120、c:121.*谁：阿甲`), "entry add（多行的全文缩进）");
  has(new RegExp(`【更正经过】经过 ${ids.fixed}：.*全文：更正后的全文.*更正的是：${ids.oldEntry}.*（理由：原来写错了）`), "correct");
  has(new RegExp(`【连上】${ids.made}「新的事」 —related→ ${ids.old}「旧事」：连上了：有关系`), "link");
  has(new RegExp(`【断开】${ids.old}「旧事」 —related→ ${ids.gone}「要退休的事」：断开了（理由：其实没关系）`), "unlink");
  has(new RegExp(`【合并】经过 ${ids.dupEntry}：从 ${ids.dup}「重复的事」 挪到 ${ids.old}「旧事」`), "merge 挪经过");
  has(new RegExp(`【合并】事件 ${ids.dup}「重复的事」：.*状态：ongoing → superseded.*${ids.old}「旧事」`), "merge 被并的那件");
  has(new RegExp(`【拆分】经过 ${ids.added}：从 ${ids.made}「新的事」 挪到 ${ids.part}「拆出来的事」`), "split");
  has(new RegExp(`【取代】事件 ${ids.stale}「过时的说法」：.*状态：ongoing → superseded`), "supersede");
  has(new RegExp(`【退休】事件 ${ids.gone}「要退休的事」：.*状态：ongoing → retired.*（理由：不用记了）`), "retire");
  has(/【人和东西】人和东西 t\d+ 小店：.*备注：楼下那家/, "entity upsert");
  has(/【合并人和东西】人和东西 t\d+ 阿丙：删掉了（理由：同一个人）/, "entity merge");
  has(new RegExp(`【挂上】t\\d+ 小店 ↔ ${ids.made}「新的事」（about）：挂上了`), "entity tag");
  has(/【删掉人和东西】人和东西 t\d+ 多余的：删掉了（理由：建错了）/, "entity drop");
  has(/【人物卡】人物卡 i\d+（关于 t\d+ 阿甲，段「是谁」）：.*正文：一起做事的人/, "person card");
  has(/【钉原话】人物卡 i\d+（关于 t\d+ 阿甲，原话「记着的原话」）：.*正文：这句要记着/, "quote pin");
});

test("lead diff: an empty batch says so; unknown ops and tables are listed generically, never dropped", () => {
  const { s } = busyStore();
  assert.equal(batchDiff(s, "sleep:none/x/1"), "（这一批没有动事件库）");
  const row = (over: Partial<OpRow>): OpRow => ({ id: 1, batch: "b", at: 0, op: "x", tbl: "t", key: "{}", before: null, after: null, reason: "", ...over });
  const fake = {
    ops: () => [
      row({ op: "future_op", tbl: "mem_future", key: '{"id":"z1"}', after: '{"id":"z1","color":"红"}' }),
      row({ op: "future_op", tbl: "mem_future", key: '{"id":"z1"}', before: '{"id":"z1","color":"红"}', after: '{"id":"z1","color":"蓝"}' }),
      row({ op: "revert_conflict", tbl: "mem_entry", key: '{"id":"n00009"}', reason: "之后又被改过" }),
      row({ op: "range", tbl: "mem_event", key: '{"id":"e0009"}', before: '{"id":"e0009","title":"某事","started_at":null}', after: `{"id":"e0009","title":"某事","started_at":${T0}}` }),
      row({ op: "odd", tbl: "mem_event", key: '{"id":"e0009"}', before: "{坏的", after: null }),
    ],
    event: () => undefined, entry: () => undefined, entryPeople: () => [],
  };
  const lines = batchDiff(fake, "b").split("\n");
  assert.equal(lines.length, 6);
  assert.equal(lines[1], '- 【future_op】mem_future {"id":"z1"}：id：z1；color：红');
  assert.equal(lines[2], '- 【future_op】mem_future {"id":"z1"}：color：红 → 蓝');
  assert.equal(lines[3], "- 【撤回冲突】经过 n00009（理由：之后又被改过）");
  assert.equal(lines[4], "- 【时间范围】事件 e0009「某事」：开始：无 → 2026-11-04 03:00");
  assert.match(lines[5]!, /^- 【odd】事件 /, "读不出来的行也占一条");
});

test("lead diff: over the cap batchDiff stops at an op boundary and says how many rows were listed", () => {
  const { s } = busyStore();
  const total = s.ops(B).length;
  const full = batchDiff(s, B, Infinity);
  const cut = batchDiff(s, B, 600);
  assert.ok(cut.length < full.length && cut.length <= 600 + 80);
  const lines = cut.split("\n");
  const shown = cut.split("\n").filter((l) => l.startsWith("- 【")).length;
  assert.ok(shown > 0 && shown < total);
  assert.equal(lines.at(-1), `…（太长：一共 ${total} 行变化，这里只列了前 ${shown} 行）`);
  // 截掉的那份是全文的开头（截在一条的边上）
  assert.ok(full.startsWith(lines.slice(0, -1).join("\n")));
  // 默认也有上限
  assert.ok(batchDiff(s, B).length <= 30000 + 80);
});

const snapOf = (files: Record<string, string>): Snapshot => new Map(Object.entries(files).map(([p, text]) => [p, { sha: text, text }]));

test("lead diff: snapDiff takes a cap; without it the 20000 default stays", () => {
  const before = snapOf({ "a.md": "一\n二\n三", "big.md": "x" });
  const after = snapOf({ "a.md": "一\n贰\n三", "big.md": Array.from({ length: 5000 }, (_, i) => `第 ${i} 行`).join("\n") });
  const dflt = snapDiff(before, after);
  assert.ok(dflt.startsWith("=== a.md ===\n- 二\n+ 贰\n=== big.md ===\n"));
  assert.ok(dflt.endsWith("…（diff 太长，后面截掉了）") && dflt.length === 20000 + "…（diff 太长，后面截掉了）".length, "默认照旧");
  const all = snapDiff(before, after, Infinity);
  assert.ok(!all.includes("截掉了") && all.includes("+ 第 4999 行"));
  const small = snapDiff(before, after, 100);
  assert.equal(small.length, 100 + "…（diff 太长，后面截掉了）".length);
});

test("lead diff: specialistDiff writes the full diff under the day dir and points at it when the lead's copy is cut", () => {
  const written = new Map<string, string>();
  const fs = { write: (p: string, t: string) => { written.set(p, t); } };
  const before = snapOf({ "memory/a.md": "一\n二", "keep.md": "不动" });
  const after = snapOf({ "memory/a.md": "一\n贰", "keep.md": "不动", "memory/new.md": Array.from({ length: 300 }, (_, i) => `新的第 ${i} 行`).join("\n") });
  const opsFull = ["事件库这一批（b）一共 2 行变化：", "- 【新建事件】事件 e1「甲」", "- 【退休】事件 e2「乙」"].join("\n");
  const ops = (cap: number): string => (cap >= opsFull.length ? opsFull : "事件库这一批（b）一共 2 行变化：\n…（太长：一共 2 行变化，这里只列了前 0 行）");

  const path = leadDiffPath("2026-11-04", "events", 2);
  assert.equal(path, "sleep/2026-11-04/flow/lead/events.2.diff");
  const small = specialistDiff({ fs, day: "2026-11-04", stage: "events", round: 2, before, after, ops, opCount: 2, hints: ["memory/new.md 没写进记录"] });
  assert.equal(small.fileCount, 2);
  assert.equal(small.opCount, 2);
  assert.deepEqual(small.hints, ["memory/new.md 没写进记录"]);
  assert.equal(small.ops, opsFull);
  assert.ok(small.files.includes("=== memory/a.md ===\n- 二\n+ 贰") && small.files.includes("+ 新的第 299 行") && !small.files.includes("全文在"));
  assert.equal(written.get(path), `# 文件\n${small.files.trimEnd()}\n\n# 事件库\n${opsFull}\n`);

  const cut = specialistDiff({ fs, day: "2026-11-04", stage: "events", round: 3, before, after, ops, opCount: 2, filesCap: 200, opsCap: 30 });
  const where = "\n（全文在 sleep/2026-11-04/flow/lead/events.3.diff，要看用 Read）";
  assert.ok(cut.files.endsWith("…（diff 太长，后面截掉了）" + where) && cut.files.length < 320);
  assert.ok(cut.ops.endsWith("只列了前 0 行）" + where));
  assert.deepEqual(cut.hints, []);
  // 文件里的是全文，不截
  const full = written.get("sleep/2026-11-04/flow/lead/events.3.diff")!;
  assert.ok(full.includes("+ 新的第 299 行") && full.includes("【退休】事件 e2「乙」") && !full.includes("截掉了"));
  // 没改文件、没动事件库也写得出来
  const none = specialistDiff({ fs, day: "2026-11-04", stage: "people", round: 1, before, after: before, ops: () => "（这一批没有动事件库）", opCount: 0 });
  assert.deepEqual([none.files, none.ops, none.fileCount], ["（没改文件）", "（这一批没有动事件库）", 0]);
});

/** 一夜的 host（假内核）：files 是工作区里读得到的文件（相对工作区），没列的读不到 */
function hostsFor(flow: FlowConfig, o: { driver?: FakeDriver; mem?: EventMemory | null; files?: Map<string, string>; prefix?: string } = {}) {
  const WS = "/tmp/hh-lead-ws";
  const cfg = loadConfig({ workspace: WS, stateDir: mkdtempSync(join(tmpdir(), "hh-lead-hosts-")) });
  const files = o.files ?? new Map<string, string>();
  const rel = (p: string): string => (p.startsWith(`${WS}/`) ? p.slice(WS.length + 1) : p);
  const fs: MiniFs = { read: (p) => files.get(rel(p)) ?? null, write: (p, t) => { files.set(rel(p), t); }, remove: (p) => { files.delete(rel(p)); }, list: () => [], isDir: () => false };
  const driver = o.driver ?? new FakeDriver();
  const b: NightBrain = {
    cfg, driver, db: openDb(":memory:"), log: new Logger("t", () => {}), mem: o.mem ?? null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: (p) => files.get(rel(p)) ?? null, now: () => 1000, later: () => () => {},
    hhTools: (_id, names) => names.map((name) => ({ name, description: name, shape: {}, handler: async () => "ok" })),
  };
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const charged: Array<[string, number]> = [];
  const hosts = nightHosts(b, { flow, prefix: o.prefix ?? "SOUL\n\nCOMMON", hash: "h" }, { budget, weights: sleepWeights(undefined), auditMs: 60_000, charge: (id, u) => charged.push([id, u]) });
  return { hosts, budget, driver, files, charged, cfg };
}

test("lead diff: the stage host's opsText renders the attempt's batch from the live store, open or not", () => {
  const { s } = busyStore();
  const flow = parseFlow({ engine: "flow", stages: STAGES }, known);
  const { hosts, cfg } = hostsFor(flow, { mem: { store: s } as unknown as EventMemory });
  assert.equal(hosts.stage.opsText!("2026-11-04", "events", 1), batchDiff(s, B, undefined, cfg.schedule.timezone));
  assert.ok(hosts.stage.opsText!("2026-11-04", "events", 1, 500).includes("这里只列了前"));
  assert.equal(hosts.stage.opsText!("2026-11-04", "events", 2), "（这一批没有动事件库）");
  assert.equal(hostsFor(flow).hosts.stage.opsText!("2026-11-04", "events", 1), "（今晚没有事件库）");
});

// ---------- T4：host —— 核心开头、领导的会话、动手前的事件库拷贝 ----------

const DAY1 = "2026-11-04";
const COMMON = "夜里整理的约定";
/** team 的一夜：baseBlocks 两块（工作区里的），plan 带 common */
function teamNight(o: { mem?: EventMemory | null; stages?: unknown[] } = {}) {
  const flow = parseTeam({ exam: { baseBlocks: ["SOUL.md", "MEMORY.md", "missing.md"] }, stages: o.stages ?? [
    agent("events", { writes: ["**"], tools: ["mem_write", "note"], memWrite: true }), agent("people", { model: "sonnet", after: ["events"], writes: ["**"] }), script("finish", ["finish"], { after: ["people"] }),
  ] });
  const files = new Map([["SOUL.md", "我是谁\n"], ["MEMORY.md", "记得的事"]]);
  const driver = new FakeDriver();
  const cfg0 = loadConfig({ workspace: "/tmp/hh-lead-ws", stateDir: mkdtempSync(join(tmpdir(), "hh-lead-hosts-")) });
  const fs: MiniFs = { read: (p) => files.get(p) ?? null, write: (p, t) => { files.set(p, t); }, remove: (p) => { files.delete(p); }, list: () => [], isDir: () => false };
  const b: NightBrain = {
    cfg: cfg0, driver, db: openDb(":memory:"), log: new Logger("t", () => {}), mem: o.mem ?? null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: (p) => files.get(p.replace("/tmp/hh-lead-ws/", "")) ?? null, now: () => 1000, later: () => () => {},
    hhTools: (_id, names) => names.map((name) => ({ name, description: `说明 ${name}`, shape: {}, handler: async () => "ok" })),
  };
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const charged: Array<[string, number]> = [];
  const hosts = nightHosts(b, { flow, prefix: `SOUL\n\n${COMMON}`, hash: "h", common: COMMON }, { budget, weights: sleepWeights(undefined), auditMs: 60_000, charge: (id, u) => charged.push([id, u]) });
  return { hosts, flow, files, driver, budget, charged, cfg: cfg0 };
}
const toolsOf = (s: { spec: { tools: Array<{ name: string; description: string }> } }) => s.spec.tools.map((t) => [t.name, t.description]);

test("lead host: coreOpening is the given head plus the base blocks as they are in the workspace, the same text all day", () => {
  const n = teamNight();
  const core = n.hosts.exam!.coreOpening("开头一句");
  assert.equal(core, "开头一句\n\n## SOUL.md\n我是谁\n\n## MEMORY.md\n记得的事", "配置的顺序；读不到的那块不放");
  // 今晚的提案改了基础块、甚至原文件半路变了：这一天里开头不变（提案在 proposed/，落地前不算）
  n.files.set(`sleep/${DAY1}/proposed/SOUL.md`, "提案里的新样子");
  n.files.set("SOUL.md", "半路变了");
  assert.equal(n.hosts.exam!.coreOpening("开头一句"), core);
  assert.ok(!n.hosts.exam!.coreOpening("另一句").includes("提案里的新样子"));
  // 考场的开头照旧（另一句头）
  assert.ok(n.hosts.exam!.opening([]).startsWith("这是你醒着的时候的样子\n\n## SOUL.md\n我是谁"));
  // 这一天落地了：下一天用落地后的
  n.hosts.stage.landed!(DAY1, []);
  assert.equal(n.hosts.exam!.coreOpening("开头一句"), "开头一句\n\n## SOUL.md\n半路变了\n\n## MEMORY.md\n记得的事");
});

test("lead host: team stage sessions and the lead open on the same prefix and tool list, byte for byte; the role is not in the prefix", () => {
  const n = teamNight();
  assert.ok(n.hosts.lead, "team 的夜里有领导的 host");
  const want = `${n.hosts.exam!.coreOpening(S.leadprompts.coreHead)}\n\n${COMMON}`;
  assert.equal(n.hosts.stage.prefix, want);
  n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["mem_write", "note", "stage_done"]) }).wake("做事");
  n.hosts.lead!.open({ id: `lead-${DAY1}`, model: "opus", timeoutMs: 60_000 }).wake("你是领导");
  n.hosts.stage.open({ id: `sleep-${DAY1}-people-1`, stage: n.flow.stages[1]!, day: DAY1, allowed: new Set(["stage_done"]) }).wake("做事");
  const [spec, lead, sonnet] = n.driver.sessions;
  assert.equal(spec!.spec.systemAppend, want);
  assert.equal(lead!.spec.systemAppend, spec!.spec.systemAppend, "开头一字不差");
  assert.deepEqual(toolsOf(lead!), toolsOf(spec!), "工具清单一字不差");
  assert.deepEqual(lead!.spec.builtinTools, spec!.spec.builtinTools);
  assert.equal(lead!.spec.model, spec!.spec.model, "opus 的专员和领导同一个模型");
  // sonnet 的专员：开头、清单也一样（缓存按模型分，共用不了）
  assert.equal(sonnet!.spec.systemAppend, want);
  assert.deepEqual(toolsOf(sonnet!), toolsOf(spec!));
  assert.notEqual(sonnet!.spec.model, spec!.spec.model);
  // 角色不在开头里：领导是谁写在叫醒它的第一条消息里
  assert.ok(!want.includes("领导"));
  assert.ok(LP.LEAD_ROLE("页上写的").includes("页上写的"));
  assert.equal(n.hosts.review, null);
  assert.equal(n.hosts.coord, null);
});

test("lead host: the lead reads and recalls but cannot write files, run commands or write the event store", async () => {
  const n = teamNight();
  const s = n.hosts.lead!.open({ id: `lead-${DAY1}`, model: "opus", timeoutMs: 60_000 });
  s.wake("你是领导");
  const k = n.driver.sessions[0]!;
  const tryTool = async (name: string, args: Record<string, unknown>): Promise<string | undefined> => { const before = k.denied.length; await k.play({ tool: { name, args } }); return k.denied[before]; };
  for (const [name, args] of [
    ["Write", { file_path: `/tmp/hh-lead-ws/sleep/${DAY1}/proposed/SOUL.md`, content: "x" }], ["Write", { file_path: "/tmp/hh-lead-ws/SOUL.md", content: "x" }],
    ["Edit", { file_path: `/tmp/hh-lead-ws/sleep/${DAY1}/flow/lead/events.1.diff`, old_string: "a", new_string: "b" }],
    ["Bash", { command: "python3 scripts/finish" }], ["Bash", { command: "ls" }], ["mem_write", {}], ["note", {}], ["stage_done", {}],
  ] as Array<[string, Record<string, unknown>]>) assert.ok(await tryTool(name, args), `${name} ${JSON.stringify(args)} 不行`);
  for (const [name, args] of [
    ["Read", { file_path: `/tmp/hh-lead-ws/sleep/${DAY1}/flow/lead/events.1.diff` }], ["Read", { file_path: `/tmp/hh-lead-ws/sleep/${DAY1}/proposed/SOUL.md` }],
    ["Grep", { pattern: "x" }], ["Glob", { pattern: "**" }], ["recall", {}], ["recall_event", {}],
  ] as Array<[string, Record<string, unknown>]>) assert.equal(await tryTool(name, args), undefined, `${name} 可以`);
  // 每一轮结束就把这一轮花的记上（不等一天完了才算）
  const spent0 = n.budget.spent;
  await k.play({ say: "看完了", total: { calls: 2, input: 1000, cacheRead: 0, cacheWrite: 0, output: 100 } });
  assert.ok(n.budget.spent > spent0);
  assert.deepEqual(n.charged.map(([id]) => id), [`lead-${DAY1}`]);
});

test("lead host: a flow night is untouched — same prefix, same tool list, no lead, no copyBefore", () => {
  const flow = parseFlow({ engine: "flow", stages: [agent("events", { writes: ["memory/**"], tools: ["note"] }), script("finish", ["finish"], { after: ["events"] })] }, known);
  const h = hostsFor(flow, { prefix: "SOUL\n\nCOMMON" });
  assert.equal(h.hosts.lead, null);
  assert.equal(h.hosts.exam, null);
  assert.equal(h.hosts.stage.copyBefore, undefined);
  assert.equal(h.hosts.stage.prefix, "SOUL\n\nCOMMON");
  h.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: flow.stages[0]!, day: DAY1, allowed: new Set(["note", "stage_done"]) }).wake("开始");
  const k = h.driver.sessions[0]!;
  assert.equal(k.spec.systemAppend, "SOUL\n\nCOMMON");
  assert.deepEqual(k.spec.tools.map((t) => t.name), ["note", "recall", "recall_event", "stage_done", "audit_done"]);
});

test("lead host: copyBefore copies the event store when the specialist opens and keeps the copy until the specialist is settled", async () => {
  const { s } = busyStore();
  const n = teamNight({ mem: { store: s } as unknown as EventMemory });
  assert.equal(n.hosts.stage.storeBefore!(DAY1, "events"), "live");
  await n.hosts.stage.copyBefore!(DAY1, "events", 1);
  const copy = n.hosts.stage.storeBefore!(DAY1, "events");
  assert.ok(copy !== "live" && existsSync(copy), copy);
  assert.ok(copy.startsWith(join(n.cfg.stateDir, n.cfg.sleep.examScratch)));
  // 开会话、交差被退回（原地修）都不丢这份拷贝
  const sess = n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["mem_write", "stage_done"]) });
  sess.bounced?.({ questionsFor: [] });
  assert.equal(n.hosts.stage.storeBefore!(DAY1, "events"), copy);
  assert.ok(existsSync(copy));
  // 不写事件库的专员不拷
  await n.hosts.stage.copyBefore!(DAY1, "people", 1);
  assert.equal(n.hosts.stage.storeBefore!(DAY1, "people"), "live");
  // 这个专员定了（过了、或者整份不要）才删
  n.hosts.stage.attemptEnded!(DAY1, "events", true, 1);
  assert.equal(n.hosts.stage.storeBefore!(DAY1, "events"), "live");
  assert.ok(!existsSync(copy));
  await n.hosts.shut();
});

test("lead host: the lead's recalls leave no trace in the event store", async () => {
  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  const e = m.store.createEvent({ title: "一件事", summary: "摘要", gist: "要点", importance: 2 }, "seed");
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const before = touches();
  await memTools(m, `lead-${DAY1}`, ["recall_event"]).find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  assert.equal(touches(), before, "领导翻事情不留痕迹");
  await memTools(m, `sleep-${DAY1}-events-1`, ["recall_event"]).find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  assert.ok(touches() > before, "专员照常留");
});

// ---------- T5：领导的两个交差工具、Lead ----------

const lq = (over: Partial<LeadQuestion> = {}): LeadQuestion => ({
  q: "今天定了什么", gold: "定了周五交", accept: "周五", sources: ["c:120"], tags: { who: [], events: ["e0005"], files: [], lessons: [] },
  importance: 3, kind: "fact", layer: "searchable", isNew: true, probe: "new", ...over,
});
const DONE: StageDone = { status: "done", changes: [{ target: "memory/a.md", op: "change", before: "旧", after: "新", evidence: ["c:120"], why: "今天说的" }], report: "改了一处", uncertain: [], proposals: [], bugs: [] };
const DIFF: SpecialistDiff = { files: "=== memory/a.md ===\n- 旧\n+ 新\n", ops: "（这一批没有动事件库）", fileCount: 1, opCount: 0, hints: ["memory/b.md 改了但没写进记录"] };
const EXAM_OK: ConsistencyResult = { examined: true, pass: true, failed: [], notes: [], scoreAfter: 1, scoreBefore: null };
const EXAM_BAD: ConsistencyResult = {
  examined: true, pass: false, notes: ["有一道两次都答不出"], scoreAfter: 0.5, scoreBefore: 1,
  failed: [{ id: "q:2026-11-04/events/1", probe: "keep", q: "他住哪", gold: "城北", after: "不记得", before: "城北", why: "整理前答得出，整理后答不出" }],
};

test("lead tools: on a team night lead_review and lead_verdict are in every session's list; only the lead may call them", async () => {
  const n = teamNight();
  const stage = n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["mem_write", "stage_done"]) });
  stage.wake("做事");
  const lead = n.hosts.lead!.open({ id: `lead-${DAY1}`, model: "opus", timeoutMs: 60_000 });
  lead.wake("你是领导");
  const [ks, kl] = n.driver.sessions;
  const names = ks!.spec.tools.map((t) => t.name);
  assert.deepEqual(names.slice(-2), ["lead_review", "lead_verdict"]);
  assert.deepEqual(toolsOf(kl!), toolsOf(ks!), "清单还是一字不差");
  // 专员的会话调不了
  await ks!.play({ tool: { name: "lead_review", args: { intent: [], questions: [] } } });
  await ks!.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } } });
  assert.equal(ks!.denied.length, 2);
  // 领导的会话：交上来的照 shape 解析好交给 onReview / onVerdict
  const got: Array<LeadReview | LeadVerdict> = [];
  lead.onReview((r) => { got.push(r); return "收到。"; });
  lead.onVerdict((v) => { got.push(v); return "收到。"; });
  await kl!.play({ tool: { name: "lead_review", args: { intent: [{ target: "memory/a.md", what: "补今天定的事", fix: "" }], questions: [lq()] } } });
  await kl!.play({ tool: { name: "lead_verdict", args: { pass: false, fixes: [{ what: "漏了一句", fix: "补上" }] } } });
  assert.equal(kl!.denied.length, 0);
  assert.deepEqual(got[0], { intent: [{ target: "memory/a.md", what: "补今天定的事", fix: "" }], questions: [lq()] });
  assert.deepEqual(got[1], { pass: false, fixes: [{ what: "漏了一句", fix: "补上" }], notes: [] });
  // probe、layer 写错的过不了 shape
  let called = 0;
  lead.onReview(() => { called += 1; return "收到。"; });
  await kl!.play({ tool: { name: "lead_review", args: { intent: [], questions: [{ ...lq(), probe: "other" }] } } });
  await kl!.play({ tool: { name: "lead_review", args: { intent: [], questions: [{ ...lq(), layer: "archive" }] } } });
  assert.equal(called, 0);
  // flow 的夜里没有这两个工具
  const flow = parseFlow({ engine: "flow", stages: [agent("events", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["events"] })] }, known);
  const h = hostsFor(flow);
  h.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: flow.stages[0]!, day: DAY1, allowed: new Set(["stage_done"]) }).wake("开始");
  assert.ok(!h.driver.sessions[0]!.spec.tools.some((t) => t.name.startsWith("lead_")));
});

type LeadAct = (s: { id: string; wake: string; n: number; review(r: LeadReview): string; verdict(v: LeadVerdict): string; turnEnd(ok: boolean): void }) => void;
function leadHost(act: LeadAct) {
  const opened: string[] = [];
  const wakes: string[][] = [];
  const closed: string[] = [];
  const host: LeadHost = {
    open(o) {
      opened.push(o.id);
      const ws: string[] = []; wakes.push(ws);
      let onR: (r: LeadReview) => string = () => ""; let onV: (v: LeadVerdict) => string = () => ""; let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<unknown>((r) => { settle = r; });
      return {
        id: o.id, settled,
        wake(t: string) { ws.push(t); queueMicrotask(() => act({ id: o.id, wake: t, n: ws.length, review: (r) => onR(r), verdict: (v) => onV(v), turnEnd: (ok) => onEnd(ok) })); },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onReview(fn: (r: LeadReview) => string) { onR = fn; },
        onVerdict(fn: (v: LeadVerdict) => string) { onV = fn; },
        async close() { closed.push(o.id); settle({ how: "ok", turns: 1, usage: {} }); },
      } as never;
    },
  };
  return { host, opened, wakes, closed };
}
const EVENTS: StageSpec = parseTeam().stages[0]!;
function leadFor(h: ReturnType<typeof leadHost>, o: { check?: (q: LeadQuestion) => string | null; maxQuestions?: number; excerpt?: (q: LeadQuestion) => { ref: string; text: string } | null } = {}) {
  const timers: Array<() => void> = [];
  const warns: string[] = [];
  const lead = new Lead(h.host, {
    id: `lead-${DAY1}`, model: "opus", nightMs: 3_600_000, turnMs: 60_000, role: "【你是领导】", later: (fn) => { timers.push(fn); return () => { const i = timers.indexOf(fn); if (i >= 0) timers.splice(i, 1); }; },
    log: { warn: (m: string) => { warns.push(m); } }, ...o,
  });
  return { lead, timers, warns };
}
const reviewOf = (lead: LeadLike, round = 1) => lead.review({ day: DAY1, stage: EVENTS, round, done: DONE, diff: DIFF });
const verdictOf = (lead: LeadLike, exam = EXAM_OK) => lead.verdict({ day: DAY1, stage: EVENTS, round: 1, exam, intent: [] });

test("lead: one session for the day; asks are queued; the role is only in the first message; the brief carries the diff", async () => {
  const h = leadHost((s) => {
    if (s.wake.includes("lead_review")) s.review({ intent: [{ target: "memory/a.md", what: "补", fix: "" }], questions: [lq()] });
    else s.verdict({ pass: true, fixes: [], notes: ["留意一下"] });
    s.turnEnd(true);
  });
  const { lead } = leadFor(h);
  const [r, v] = await Promise.all([reviewOf(lead), verdictOf(lead)]);
  assert.deepEqual(r, { intent: [{ target: "memory/a.md", what: "补", fix: "" }], questions: [lq()] });
  assert.deepEqual(v, { pass: true, fixes: [], notes: ["留意一下"] });
  assert.deepEqual(h.opened, [`lead-${DAY1}`], "一天一个会话");
  const [w1, w2] = h.wakes[0]!;
  assert.ok(w1!.startsWith("【你是领导】\n\n"), "角色在第一条消息最前面");
  assert.ok(!w2!.includes("【你是领导】"));
  for (const part of [EVENTS.title, "改了一处", "=== memory/a.md ===\n- 旧\n+ 新", "（这一批没有动事件库）", "memory/b.md 改了但没写进记录", "keep", "new", "missed", "resident", "searchable", `sleep/${DAY1}/`]) assert.ok(w1!.includes(part), part);
  assert.ok(w2!.includes("lead_verdict"));
  await lead.close();
  assert.deepEqual(h.closed, [`lead-${DAY1}`]);
  assert.equal(await reviewOf(lead), null, "关了以后不再问");
});

test("lead: no hand-in gets one nudge, then null; a timeout closes the session and the next ask reopens it, three sessions at most", async () => {
  const mute = leadHost((s) => s.turnEnd(true));
  const m = leadFor(mute);
  assert.equal(await reviewOf(m.lead), null);
  assert.equal(mute.wakes[0]!.length, 2);
  assert.equal(mute.wakes[0]![1], LP.LEAD_NUDGE("review"));
  assert.equal(await verdictOf(m.lead), null);
  assert.equal(mute.wakes[0]![3], LP.LEAD_NUDGE("verdict"));
  // 这一轮出错：不催，null
  const broken = leadHost((s) => s.turnEnd(false));
  assert.equal(await reviewOf(leadFor(broken).lead), null);
  assert.equal(broken.wakes[0]!.length, 1);

  const stuck = leadHost(() => {});
  const st = leadFor(stuck);
  for (let i = 1; i <= 4; i++) {
    const p = reviewOf(st.lead);
    await new Promise((r) => setTimeout(r, 0));
    st.timers.shift()?.();
    assert.equal(await p, null, `第 ${i} 份没回`);
  }
  assert.deepEqual(stuck.opened, [`lead-${DAY1}`, `lead-${DAY1}-2`, `lead-${DAY1}-3`], "最多开 3 个");
  assert.deepEqual(stuck.closed, stuck.opened);
  assert.ok(stuck.wakes[1]![0]!.startsWith("【你是领导】"), "重开的会话第一条也带角色");
  assert.ok(st.warns.length >= 3);
});

test("lead: questions are checked one by one; refused ones come back with the reason and can be handed in again in the same turn", async () => {
  const replies: string[] = [];
  const h = leadHost((s) => {
    if (s.n === 1) {
      replies.push(s.review({ intent: [{ target: "x", what: "y", fix: "" }], questions: [lq({ q: "好的", sources: ["c:1"] }), lq({ q: "没出处的", sources: ["c:999"] }), lq({ q: "私密的", sources: ["i0009"] })] }));
      replies.push(s.review({ intent: [], questions: [lq({ q: "补交的", sources: ["c:2"], probe: "keep", isNew: true })] }));
      s.turnEnd(true);
    }
  });
  const check = (q: LeadQuestion): string | null => leadQuestionProblem(q, (ref) => ref === "c:1" || ref === "c:2", (ref) => ref === "i0009");
  const { lead } = leadFor(h, { check });
  const r = await reviewOf(lead);
  assert.deepEqual(r!.questions.map((q) => [q.q, q.probe, q.isNew]), [["好的", "new", true], ["补交的", "keep", false]], "收下的合在一起；isNew 照 probe 定");
  assert.deepEqual(r!.intent, [{ target: "x", what: "y", fix: "" }], "后一次没写 intent：留着前一次的");
  assert.match(replies[0]!, /收下 1 道/);
  assert.ok(replies[0]!.includes(P.QUESTION_REFUSED.noSource(["c:999"])) && replies[0]!.includes(P.QUESTION_REFUSED.private));
  assert.equal(replies[1], "收到。");

  // 一道都没收：不算交了，催一次
  const none = leadHost((s) => { if (s.n === 1) s.review({ intent: [], questions: [lq({ sources: ["c:999"] })] }); s.turnEnd(true); });
  assert.equal(await reviewOf(leadFor(none, { check }).lead), null);
  assert.equal(none.wakes[0]![1], LP.LEAD_NUDGE("review"));
  // 没出题、只写了 intent（专员没改什么）：算交了
  const bare = leadHost((s) => { s.review({ intent: [{ target: "x", what: "没什么可考的", fix: "" }], questions: [] }); s.turnEnd(true); });
  assert.deepEqual((await reviewOf(leadFor(bare, { check }).lead))!.questions, []);
  // 上限
  const many = leadHost((s) => { replies.push(s.review({ intent: [], questions: [lq({ q: "一" }), lq({ q: "二" }), lq({ q: "三" })] })); s.turnEnd(true); });
  assert.deepEqual((await reviewOf(leadFor(many, { maxQuestions: 2 }).lead))!.questions.map((q) => q.q), ["一", "二"]);
  assert.match(replies.at(-1)!, /最多收 2 道/);
});

test("lead: leadQuestionProblem — a source must resolve, private sources are refused, archive is not a layer the lead may use", () => {
  const yes = (): boolean => true;
  assert.equal(leadQuestionProblem(lq(), yes), null);
  assert.equal(leadQuestionProblem(lq({ sources: [] }), yes), P.QUESTION_REFUSED.noSource([]), "标准答案不能没有出处（照着专员交的改动抄的不算）");
  assert.equal(leadQuestionProblem(lq({ probe: "missed", sources: ["c:5"] }), () => false), P.QUESTION_REFUSED.noSource(["c:5"]));
  assert.equal(leadQuestionProblem(lq({ sources: ["c:1", "i0003「段」"] }), yes, (r) => r === "i0003"), P.QUESTION_REFUSED.private);
  assert.equal(leadQuestionProblem(lq({ layer: "archive" as never }), yes), LP.LEAD_REFUSED.layer);
  assert.equal(leadQuestionProblem(lq({ probe: "x" as never }), yes), LP.LEAD_REFUSED.probe);
  assert.equal(leadQuestionProblem(lq({ importance: 9 }), yes), P.QUESTION_REFUSED.importance);
});

test("lead: the hard rule — a lead pass never overrides a failed consistency exam; a silent lead follows the exam", () => {
  const pass: LeadVerdict = { pass: true, fixes: [], notes: ["我觉得可以"] };
  const fail: LeadVerdict = { pass: false, fixes: [{ what: "漏了约定", fix: "补进 a.md" }], notes: [] };
  const T = "事件";
  const over = leadRuled({ title: T, exam: EXAM_BAD, answer: pass });
  assert.equal(over.pass, false);
  assert.equal(over.by, "lead");
  assert.ok(over.notes.some((x) => x.includes("没过") && x.includes(T)), "写一句它想放过");
  assert.ok(over.problems.some((x) => x.includes("他住哪") && x.includes("整理前答得出")));
  assert.deepEqual(leadRuled({ title: T, exam: EXAM_BAD, answer: fail }).problems.slice(-1), ["漏了约定；该怎么改：补进 a.md"]);
  // 考过了：领导可以过，也可以不过（要写哪里要改；没写就照过）
  assert.deepEqual(leadRuled({ title: T, exam: EXAM_OK, answer: pass }), { pass: true, problems: [], notes: [`领导（${T}）：我觉得可以`], by: "lead" });
  const no = leadRuled({ title: T, exam: EXAM_OK, answer: fail });
  assert.deepEqual([no.pass, no.problems, no.by], [false, ["漏了约定；该怎么改：补进 a.md"], "lead"]);
  const bare = leadRuled({ title: T, exam: EXAM_OK, answer: { pass: false, fixes: [], notes: [] } });
  assert.equal(bare.pass, true);
  assert.ok(bare.notes.some((x) => x.includes("没写哪里要改")));
  // 没回：照考试的结果
  assert.deepEqual(leadRuled({ title: T, exam: EXAM_OK, answer: null }), { pass: true, problems: [], notes: [`${S.lead.silent}（${T}）`], by: "rule" });
  assert.equal(leadRuled({ title: T, exam: EXAM_BAD, answer: null }).pass, false);
});

// ---------- 评审修正轮 T1–T4 ----------

test("review T1: team messages say the range; unused personas-mode keys and odd paths are refused under team; team is the last key", () => {
  assert.ok(problemsOf(() => parseTeam({}, { maxFixRounds: 3 })).some((p) => /maxFixRounds/.test(p) && /0 到 2 的整数/.test(p)));
  assert.ok(problemsOf(() => parseTeam({}, { tolerance: { keepWrong: 0 } })).some((p) => /tolerance/.test(p) && /0 到 1 之间的一个数/.test(p)));
  for (const [k, v] of [["maxFixRounds", 2], ["reviewModel", "sonnet"]] as const) assert.ok(problemsOf(() => parseTeam({ [k]: v })).some((p) => p.includes(k) && /team/.test(p)), k);
  for (const k of ["auditModel", "reviewModel"]) {
    const stages = [agent("events", { writes: ["**"], [k]: "sonnet" }), script("finish", ["finish"], { after: ["events"] })];
    assert.ok(problemsOf(() => parseTeam({ stages })).some((p) => p.includes(k) && /events/.test(p) && /team/.test(p)), `段的 ${k}`);
  }
  assert.ok(problemsOf(() => parseTeam({}, { continuity: ["  "] })).some((p) => /continuity/.test(p)));
  for (const skill of ["./lead.md", "pages/"]) assert.ok(problemsOf(() => parseTeam({}, { lead: { skill } })).some((p) => /lead/.test(p)), skill);
  // team 是最后一个键（回放的两个键写了也排在它前面）
  assert.equal(Object.keys(parseTeam({ replayPrep: [["x"]] })).at(-1), "team");
  // 新加的两个可以不写的键：没写就没有
  assert.deepEqual(Object.keys(parseTeam().team!), ["lead", "maxFixRounds", "continuity", "tolerance"]);
  const more = parseTeam({}, { old: 12, continuityAt: "events" }).team!;
  assert.deepEqual([more.old, more.continuityAt], [12, "events"]);
  assert.ok(problemsOf(() => parseTeam({}, { old: -1 })).some((p) => /old/.test(p)));
  assert.ok(problemsOf(() => parseTeam({}, { continuityAt: "finish" })).some((p) => /continuityAt/.test(p)), "要是 agent 段");
});

test("review T1: a flow config with personas, coordinator and replay keys keeps its key order and hash", () => {
  const raw = {
    engine: "flow", personasFile: "personas.json", maxFixRounds: 1, reviewModel: "haiku", coordinator: { model: "opus", maxPolish: 1 },
    replayPrep: [["python3", "scripts/x.py", "{day}"]], replayOverlay: ["scripts/x.py"],
    stages: [agent("people", { writes: ["memory/**"], persona: "a", region: "海马" }), script("finish", ["finish"], { after: ["people"] })],
  };
  const f = parseFlow(raw, known);
  assert.deepEqual(Object.keys(f), ["engine", "maxParallel", "budget", "saveMode", "auditModel", "checks", "exam", "stages", "personasFile", "maxFixRounds", "reviewModel", "coordinator", "replayPrep", "replayOverlay"]);
  // 在 ef67aeb 的 parseFlow 上算的
  assert.equal(createHash("sha256").update(JSON.stringify(f)).digest("hex").slice(0, 16), "c27ab814a4a526a6");
});

test("review T3: batchDiff names people who already existed, prints local time, and a long row is cut without hiding the rows after it", () => {
  const db = openDb(":memory:");
  const s = new EventStore(db, () => T0, "Australia/Melbourne", { peopleTemplate: TEMPLATE, owners: new Set(["jia"]) });
  s.upsertEntity({ name: "阿甲", kind: "person", person_key: "jia", importance: 5, why: "测试" }, "b0");
  const e = s.createEvent({ title: "旧事", summary: "x", gist: "x", importance: 2, entities: [{ name: "阿甲", kind: "person", role: "with" }] }, "b0");
  s.commitBatch("b0");
  const b = "sleep:2026-11-04/people/1";
  s.openBatch(b);
  s.setSection({ who: "阿甲", section: "是谁", text: "一起做事的人", sources: [e.id], why: "今天说的" }, b);
  s.addEntry({ event: e.id, at: T0, kind: "happened", full: "长".repeat(5000), gist: "很长的一条", title: "长", people: ["阿甲"], source: ["c:1"] }, b);
  for (let i = 0; i < 5; i++) s.addEntry({ event: e.id, at: T0 + 60_000 * (i + 1), kind: "happened", full: `短的第 ${i} 条`, gist: `短 ${i}`, title: `短 ${i}`, source: [`c:${i + 2}`] }, b);
  const text = batchDiff(s, b, 4000, "Australia/Melbourne");
  // 这一批没动过阿甲这个人，照样写得出是谁的卡、谁挂在经过上
  assert.match(text, /人物卡 i\d+（关于 t\d+ 阿甲，段「是谁」）/);
  assert.match(text, /t\d+ 阿甲 ↔ 经过 n\d+：挂上了/);
  // 时间是她当地的（枫湾夏令时 +11）：UTC 03:00 = 14:00，不带 Z
  assert.ok(text.includes("时间：2026-11-04 14:00") && !/\dZ/.test(text), text.slice(0, 600));
  // 长的那一行截掉，后面短的照列
  assert.ok(text.includes("…（这一行太长，截掉了）"));
  for (let i = 0; i < 5; i++) assert.ok(text.includes(`短的第 ${i} 条`), `短的第 ${i} 条`);
  assert.ok(!text.includes("这里只列了前"));
  // 不给时区照 UTC（也不带 Z）
  assert.ok(batchDiff(s, b, Infinity).includes("时间：2026-11-04 03:00"));
  // 全文是 JSON 数组样子的不当成列表改写
  s.addEntry({ event: e.id, at: T0 + 3_600_000, kind: "happened", full: '["甲","乙"]', gist: "g", title: "t", source: ["c:9"] }, b);
  assert.ok(batchDiff(s, b, Infinity).includes('全文：["甲","乙"]'));
});

test("review T4: the role line is the same for the lead and a specialist; a lead opened after a base block changed still gets the pre-night text; no recall tool leaves a trace", async () => {
  const n = teamNight();
  n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["stage_done"]) }).wake("专员的活");
  n.files.set("SOUL.md", "被改过了");
  n.files.set(`sleep/${DAY1}/proposed/SOUL.md`, "提案");
  n.hosts.lead!.open({ id: `lead-${DAY1}`, model: "opus", timeoutMs: 60_000 }).wake("领导的活");
  const [ks, kl] = n.driver.sessions;
  assert.equal(kl!.spec.systemAppend, ks!.spec.systemAppend);
  assert.ok(kl!.spec.systemAppend.includes("我是谁") && !kl!.spec.systemAppend.includes("被改过了"));
  // 第一条消息：角色那一句一样，后面才是各自的活
  const head = (t: string, tail: string): string => { assert.ok(t.endsWith(tail), t); return t.slice(0, t.length - tail.length); };
  assert.equal(head(kl!.sent[0]!.text, "领导的活"), head(ks!.sent[0]!.text, "专员的活"));

  const db = openDb(":memory:");
  const m = new EventMemory({ db, embedder: null, now: () => T0, tz: "UTC" });
  m.store.upsertEntity({ name: "阿甲", kind: "person" }, "seed");
  const e = m.store.createEvent({ title: "一件事", summary: "摘要", gist: "要点", importance: 2, entities: [{ name: "阿甲", kind: "person", role: "with" }] }, "seed");
  const touches = () => Number((db.prepare("SELECT count(*) n FROM mem_touch").get() as { n: number }).n);
  const before = touches();
  const tools = memTools(m, `lead-${DAY1}`, ["remember", "recall_event", "recall_person"]);
  await tools.find((t) => t.name === "recall_event")!.handler({ ref: e.id });
  await tools.find((t) => t.name === "remember")!.handler({ cue: "一件事" });
  await tools.find((t) => t.name === "recall_person")!.handler({ who: "阿甲" });
  assert.equal(touches(), before);
});

// ---------- T6：前后一致的考试 ----------

type Sit = { id: string; store: string; opening: string; wake: string };
/** 考场的假 host：考生照 answer(会话 id, 题号) 答；判分的看「她的回答」，「对」开头判对、「半」开头判部分对，别的判错；dead 里的会话不交 */
function consistHost(answer: (sid: string, qid: string) => string, o: { dead?: RegExp; before?: Record<string, string>; memory?: boolean } = {}) {
  const sits: Sit[] = [];
  const previews: string[] = [];
  const host: ExamHost = {
    open(op) {
      const sit: Sit = { id: op.id, store: op.store, opening: op.opening, wake: "" };
      sits.push(sit);
      let onA: (a: ExamAnswers) => string = () => ""; let onG: (g: ExamGrades) => string = () => "";
      let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<unknown>((r) => { settle = r; });
      return {
        id: op.id, settled,
        wake(t: string) {
          sit.wake = t;
          queueMicrotask(() => {
            if (o.dead?.test(op.id)) { onEnd(false); return; }
            if (op.id.includes("-grade-")) {
              const grades = [...t.matchAll(/^(q:\S+)（[^\n]*\n问题：[^\n]*\n标准答案：[^\n]*\n也算对的说法：[^\n]*\n她的回答：([^\n]*)/gm)]
                .map((m) => ({ id: m[1]!, verdict: (m[2]!.startsWith("对") ? "right" : m[2]!.startsWith("半") ? "partial" : "wrong") as Verdict, reason: "判的" }));
              onG({ grades, layers: [] });
            } else {
              onA({ answers: [...t.matchAll(/^(q:\S+)　/gm)].map((m) => ({ id: m[1]!, answer: answer(op.id, m[1]!) })) });
            }
            onEnd(true);
          });
        },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onAnswers(fn: (a: ExamAnswers) => string) { onA = fn; },
        onGrades(fn: (g: ExamGrades) => string) { onG = fn; },
        onQuestions() {},
        async close() { settle({ how: "ok", turns: 1, usage: {} }); },
      } as never;
    },
    opening: (exclude, tonight) => `OPEN 不放[${exclude.join(",")}] 今晚[${[...(tonight ?? [])].map(([k, v]) => `${k}=${v}`).join(",")}]`,
    preview: async (x) => { previews.push(`${x.state}:${[...x.files].map(([k, v]) => `${k}=${v}`).join(",")}`); return `预览(${x.state})`; },
    sourceExists: () => true,
    beforeText: (_day, path) => o.before?.[path] ?? null,
    ...(o.memory ? { memory: (x: { state: string; store: string }) => `中期视图(${x.state},${x.store})` } : {}),
    spent() {},
    timeoutMs: 1000,
  };
  return { host, sits, previews };
}
const cq = (n: number, over: Partial<Question> = {}): Question => ({
  id: `q:${DAY1}/events/${n}`, q: `问题${n}`, gold: `标准${n}`, accept: "", sources: ["c:1"], tags: { who: [], events: ["e0001"], files: [], lessons: [] },
  importance: 3, kind: "fact", layer: "searchable", isNew: false, day: DAY1, stage: "events", hidden: false, status: "pending", created: 0, lastExamined: null, ...over,
});
const CFLOW = parseTeam({ exam: { baseBlocks: ["SOUL.md", "MEMORY.md"], inject: ["notes/**"] } }, { tolerance: 0.75 });
function consist(h: ReturnType<typeof consistHost>, questions: Question[], probes: Record<number, LeadQuestion["probe"]>, o: { storeBefore?: string; stage?: StageSpec; flow?: FlowConfig; before?: Snapshot; after?: Snapshot; round?: number } = {}) {
  const db = openDb(":memory:");
  const bank = new Bank(db, () => 1000);
  const flow = o.flow ?? CFLOW;
  return consistencyExam({ host: h.host, bank, flow }, {
    day: DAY1, stage: o.stage ?? flow.stages[0]!, attempt: 1, round: o.round ?? 1, questions,
    probes: new Map(Object.entries(probes).map(([n, p]) => [`q:${DAY1}/events/${n}`, p])),
    before: o.before ?? snapOf({ "memory/a.md": "旧" }), after: o.after ?? snapOf({ "memory/a.md": "新" }), storeBefore: o.storeBefore ?? "/copies/before.db",
  }).then((r) => ({ r, results: all<{ q: string; phase: string; verdict: string }>(db, "SELECT q, phase, verdict FROM exam_result ORDER BY id") }));
}
const sitIds = (h: ReturnType<typeof consistHost>): string[] => h.sits.map((x) => x.id.replace(`exam-${DAY1}-events-1-`, ""));

test("consistency: a keep-question wrong after (and on the one retake) but right before is an inconsistency — the specialist fails", async () => {
  const h = consistHost((sid, qid) => (qid.endsWith("/1") && !sid.includes("-before-") ? "不记得" : "对的"));
  const { r, results } = await consist(h, [cq(1), cq(2)], { 1: "keep", 2: "keep" });
  assert.equal(r.examined, true);
  assert.equal(r.pass, false);
  assert.deepEqual(r.failed, [{ id: `q:${DAY1}/events/1`, probe: "keep", q: "问题1", gold: "标准1", after: "不记得", before: "对的", why: LP.CONSIST.lost }]);
  assert.deepEqual([r.scoreAfter, r.scoreBefore], [0.5, 1]);
  assert.deepEqual(sitIds(h), ["after-searchable", "grade-all", "retake-searchable", "before-searchable", "grade-before"]);   // 整理后、重考一个判分会话；整理前那一场另开一个
  // 重考、整理前那一场只考该考的那一道；整理前那一场读的是拷贝
  assert.ok(!h.sits[2]!.wake.includes("问题2") && !h.sits[3]!.wake.includes("问题2"));
  assert.deepEqual(h.sits.map((x) => x.store), ["live", "live", "live", "/copies/before.db", "live"]);
  assert.deepEqual(results.map((x) => `${x.q.slice(-1)}:${x.phase}:${x.verdict}`), ["1:after:wrong", "2:after:right", "1:retake:wrong", "1:before:right"]);
});

test("consistency: wrong both before and after is only a note; a retake that comes out right clears the question", async () => {
  const both = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const a = await consist(both, [cq(1), cq(2)], { 1: "keep", 2: "keep" });
  assert.deepEqual([a.r.pass, a.r.failed.length], [true, 0]);
  assert.deepEqual(a.r.notes, [LP.CONSIST.bothWrong("问题1")]);
  assert.deepEqual([a.r.scoreAfter, a.r.scoreBefore], [0.5, 0]);

  const noisy = consistHost((sid, qid) => (qid.endsWith("/1") && sid.includes("-after-") ? "不记得" : "对的"));
  const b = await consist(noisy, [cq(1), cq(2)], { 1: "keep", 2: "keep" });
  assert.deepEqual([b.r.pass, b.r.failed.length, b.r.notes.length, b.r.scoreAfter, b.r.scoreBefore], [true, 0, 0, 1, null]);
  assert.deepEqual(sitIds(noisy), ["after-searchable", "grade-all", "retake-searchable"], "重考对了：不考整理前");
});

test("consistency: new and missed questions sit after only and must reach team.tolerance together", async () => {
  // 4 道 new / missed，错 1 道：0.75 ≥ 0.75 过，写一句；错 2 道：没过，列出答错的
  const one = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const qs = [cq(1, { isNew: true }), cq(2, { isNew: true }), cq(3, { isNew: true }), cq(4, { isNew: true })];
  const pr = { 1: "new", 2: "new", 3: "missed", 4: "missed" } as const;
  const a = await consist(one, qs, pr);
  assert.deepEqual([a.r.pass, a.r.failed.length], [true, 0]);
  assert.deepEqual(a.r.notes, [LP.CONSIST.newWrong("问题1", "new")]);
  assert.ok(!sitIds(one).some((x) => x.startsWith("before-")), "new / missed 不考整理前");
  assert.equal(a.r.scoreBefore, null);

  const two = consistHost((_sid, qid) => (qid.endsWith("/1") || qid.endsWith("/3") ? "不记得" : "对的"));
  const b = await consist(two, qs, pr);
  assert.equal(b.r.pass, false);
  assert.deepEqual(b.r.failed.map((f) => [f.id.slice(-1), f.probe, f.why, f.before]), [["1", "new", LP.CONSIST.belowRate(0.5, 0.75), undefined], ["3", "missed", LP.CONSIST.belowRate(0.5, 0.75), undefined]]);
  // 部分对算半道
  const half = consistHost((_sid, qid) => (qid.endsWith("/1") ? "半对" : "对的"));
  assert.equal((await consist(half, qs, pr)).r.pass, true);
});

test("consistency: layers — resident questions get no tools and the previewed injection; the before sitting sees the before files; changed base blocks leave the opening", async () => {
  const h = consistHost((sid) => (sid.includes("-before-") ? "对的" : "不记得"), { before: { "SOUL.md": "旧的我", "notes/x.md": "旧笔记", "memory/a.md": "旧" }, memory: true });
  const flow = parseTeam({ exam: { baseBlocks: ["SOUL.md", "MEMORY.md"], inject: ["notes/**"], residentMemory: true } });
  const before = snapOf({ "MEMORY.md": "前面的专员改过的", "memory/a.md": "旧" });
  const after = snapOf({ "MEMORY.md": "前面的专员改过的", "memory/a.md": "新", "SOUL.md": "新的我", "notes/x.md": "新笔记" });
  const { r } = await consist(h, [cq(1, { layer: "resident" }), cq(2)], { 1: "keep", 2: "keep" }, { flow, before, after });
  assert.equal(r.pass, false);
  assert.equal(r.failed.length, 2);
  assert.deepEqual(sitIds(h), ["after-resident", "after-searchable", "grade-all", "retake-resident", "retake-searchable", "before-resident", "before-searchable", "grade-before"]);
  // 开头：这个专员改过的基础块不放（在注入里）；前面的专员改过的用今晚的
  assert.equal(h.sits[0]!.opening, "OPEN 不放[SOUL.md] 今晚[MEMORY.md=前面的专员改过的]");
  assert.deepEqual(h.previews, ["after:SOUL.md=新的我,notes/x.md=新笔记", "before:SOUL.md=旧的我,notes/x.md=旧笔记"]);
  const [res, sea] = [h.sits[0]!.wake, h.sits[1]!.wake];
  assert.ok(res.includes("预览(after)\n\n中期视图(after,live)") && res.includes("不能查") && !res.includes("问题2"));
  assert.ok(sea.includes("=== memory/a.md ===\n新") && sea.includes("问题2"), "不注入的改动进查得到那层的附录");
  assert.ok(h.sits[5]!.wake.includes("预览(before)\n\n中期视图(before,/copies/before.db)"));
  assert.ok(h.sits[6]!.wake.includes("=== memory/a.md ===\n旧"));
});

test("consistency: no store copy for a specialist that writes the store — cannot judge, so a wrong keep-question counts as broken, with a note; the live store is never read as 'before'", async () => {
  const h = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const writer = { ...CFLOW.stages[0]!, memWrite: true };
  const { r } = await consist(h, [cq(1), cq(2)], { 1: "keep", 2: "keep" }, { storeBefore: "live", stage: writer });
  assert.equal(r.pass, false);
  assert.deepEqual(r.failed.map((f) => [f.id.slice(-1), f.why, f.before]), [["1", LP.CONSIST.noCopy, undefined]]);
  assert.ok(r.notes.includes(LP.CONSIST.noCopyNote));
  assert.ok(!sitIds(h).some((x) => x.startsWith("before-")));
  // 不写事件库的专员：整理前就是现在的库，照常考
  const plain = consistHost((sid, qid) => (qid.endsWith("/1") && !sid.includes("-before-") ? "不记得" : "对的"));
  const p = await consist(plain, [cq(1)], { 1: "keep" }, { storeBefore: "live" });
  assert.equal(p.r.failed[0]!.why, LP.CONSIST.lost);
  assert.ok(sitIds(plain).includes("before-searchable"));
});

test("consistency: sessions that never hand in — not examined, no verdict either way, said in a note; no questions — nothing to examine; round 2 gets its own session ids", async () => {
  const dead = consistHost(() => "对的", { dead: /after-searchable/ });
  const { r } = await consist(dead, [cq(1)], { 1: "keep" });
  assert.deepEqual([r.examined, r.pass, r.failed.length], [false, false, 0]);
  assert.ok(r.notes[0]!.startsWith(LP.CONSIST.broken("")));
  const none = consistHost(() => "对的");
  const n = await consist(none, [], {});
  assert.deepEqual([n.r.examined, n.r.pass, n.r.notes], [false, false, [LP.CONSIST.noQuestions]]);
  assert.equal(none.sits.length, 0);
  const two = consistHost(() => "对的");
  await consist(two, [cq(1)], { 1: "keep" }, { round: 2 });
  assert.deepEqual(two.sits.map((x) => x.id), [`exam-${DAY1}-events-1-r2-after-searchable`, `exam-${DAY1}-events-1-r2-grade-all`]);
});

// ---------- T6：team 的一夜（真的 host + 假内核） ----------

const sleepMs = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms); });
const REAL_KNOWN = { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) };
const FLOW_DIR = "scripts/sleep_flow";
/** 一夜：两个专员（events 写事件库、people 不写）+ finish；文件系统在内存里（路径相对工作区） */
function teamRig(o: { stages?: unknown[]; team?: Record<string, unknown>; seed?: (bank: Bank, m: EventMemory) => void; replay?: boolean; flow?: Record<string, unknown>; onRun?: (args: string[], files: Map<string, string>) => void | number; rawLead?: boolean } = {}) {
  const WS = "/tmp/hh-lead-rig";
  const stages = o.stages ?? [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", after: ["events"], tools: ["recall"], material: ["tonight-events"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  const flow = parseFlow({ engine: "team", maxParallel: 1, exam: { baseBlocks: ["SOUL.md"] }, stages, team: { lead: { model: "opus", skill: "lead.md", turnMinutes: 5 }, maxFixRounds: 0, ...o.team }, ...o.flow }, REAL_KNOWN);
  const files = new Map<string, string>([
    ["SOUL.md", "我是谁\n"], [`${FLOW_DIR}/events.md`, "事件专员的页"], [`${FLOW_DIR}/people.md`, "人的专员的页"], [`${FLOW_DIR}/lead.md`, "领导的页"],
    [`sleep/${DAY1}/input.md`, "这一天的对话"], ["memory/a.md", "原来的一行\n"],
  ]);
  const rel = (p: string): string => (p.startsWith(`${WS}/`) ? p.slice(WS.length + 1) : p);
  const fs: MiniFs = {
    read: (p) => files.get(rel(p)) ?? null, write: (p, t) => void files.set(rel(p), t), remove: (p) => void files.delete(rel(p)),
    isDir: (p) => [...files.keys()].some((k) => k.startsWith(`${rel(p)}/`)),
    list: (dir) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${rel(dir)}/`)).map((k) => k.slice(rel(dir).length + 1).split("/")[0]!))],
  };
  const cfg = loadConfig({ workspace: WS, stateDir: mkdtempSync(join(tmpdir(), "hh-lead-rig-")) });
  const db = openDb(":memory:");
  let t = 1_000_000;
  const now = (): number => (t += 1000);
  const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now, tz: "UTC" });
  const logs: LogRecord[] = [];
  const driver = o.rawLead ? new FakeDriver() : confirming(new FakeDriver());
  const runs: string[][] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const b: NightBrain = {
    cfg, driver, db, log: new Logger("t", memorySink(logs)), mem: m, fs,
    run: async (_cmd, args) => { runs.push([...args]); const code = o.onRun?.([...args], files) ?? 0; return { code, stdout: "", stderr: code ? "坏了" : "" }; },
    readText: (p) => files.get(rel(p)) ?? null, now,
    later: (fn, ms) => { const t = { fn, ms }; timers.push(t); return () => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); }; },
    hhTools: (id, names, mem) => memTools(mem ?? m, id, names),
    memAt: () => ({ mem: m, close: () => {} }),
  };
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const plan: NightPlan = { flow, prefix: "SOUL\n\nCOMMON", hash: "h", common: "COMMON" };
  const { hosts, runner } = assembleNight(b, plan, { night: "n", budget, weights: sleepWeights(undefined), auditMs: 60_000, watchdogMs: 3_600_000, maxDays: 1, ...(o.replay ? { replay: true } : {}) });
  o.seed?.(hosts.bank, m);
  const run = () => { let given = false; return runner.runNight({ night: "n", pending: async () => (given ? null : ((given = true), DAY1)), backlog: async () => 1 }); };
  return { b, flow, files, db, m, logs, driver, runs, hosts, runner, budget, run, cfg, timers };
}
/**
 * 假领导照规矩交两次：play 一个 lead_review 时，先照原样调一次工具（引擎把出处贴回来、不收），再带 checked: true 演这一轮。
 * 自己已经写了 checked 的不管（要看那两步的测试自己来）
 */
function confirming(driver: FakeDriver): FakeDriver {
  const open0 = driver.open.bind(driver);
  driver.open = (spec) => {
    const s = open0(spec) as FakeSession;
    const play0 = s.play.bind(s);
    s.play = async (script) => {
      const t = script.tool;
      if (t?.name === "lead_review" && t.args.checked === undefined && s.id.startsWith("lead-")) {
        await spec.tools.find((x) => x.name === "lead_review")!.handler(t.args);
        return play0({ ...script, tool: { name: t.name, args: { ...t.args, checked: true } } });
      }
      return play0(script);
    };
    return s;
  };
  return driver;
}

/** 假内核的导演：哪个会话收到新消息就叫 on（一条一条来） */
function autopilot(driver: FakeDriver, on: (s: FakeSession, text: string, nth: number) => Promise<void> | void) {
  const seen = new Map<FakeSession, number>();
  let stop = false;
  const errors: unknown[] = [];
  const loop = (async () => {
    while (!stop) {
      for (const s of [...driver.sessions]) {
        const n = seen.get(s) ?? 0;
        if (s.closed || s.sent.length <= n) continue;
        seen.set(s, s.sent.length);
        try { await on(s, s.sent.slice(n).map((x) => x.text).join("\n"), n + 1); } catch (e) { errors.push(e); }
      }
      // 不拖住进程：演砸了（哪个会话没人接）测试自己会超时、进程照样能退出，不把整套测试挂住
      await new Promise<void>((r) => { setTimeout(r, 1).unref(); });
    }
  })();
  return { errors, stop: async () => { stop = true; await loop; } };
}
const USE = { calls: 3, input: 100, cacheRead: 5000, cacheWrite: 200, output: 300 };
const answerAll = (text: string, ans: (qid: string, q: string) => string) => ({ tool: { name: "exam_answers", args: { answers: [...text.matchAll(/^((?:q|seed):\S+)　(.*)$/gm)].map((m) => ({ id: m[1]!, answer: ans(m[1]!, m[2]!) })) } }, total: USE });
/** 假判分的：她的回答「对」开头、或者就是标准答案那句（原样包含）判对，别的判错 */
const gradeAll = (text: string) => ({ tool: { name: "exam_grades", args: { layers: [], grades: [...text.matchAll(/^((?:q|seed):\S+)（[^\n]*\n问题：[^\n]*\n标准答案：([^\n]*)\n也算对的说法：[^\n]*\n她的回答：([^\n]*)/gm)].map((m) => ({ id: m[1]!, verdict: m[3]!.startsWith("对") || (m[2]!.length > 0 && m[3]!.includes(m[2]!)) ? "right" : "wrong", reason: "判的" })) } }, total: USE });
const tq = (q: string, probe: string, over: Record<string, unknown> = {}) => ({ q, gold: `${q}的答案`, accept: "", sources: ["memory/a.md:1"], tags: { who: [], events: [], files: ["memory/a.md"], lessons: [] }, importance: 3, kind: "fact", layer: "searchable", probe, ...over });
const stageRows = (db: Db) => all<{ stage: string; attempt: number; status: string; decision: string | null; cost: string | null; units: number; questions: number | null; score_after: number | null; verdict: string }>(db, "SELECT * FROM sleep_stage ORDER BY id");
/** 两个专员照常做完的一夜；ans 定考生怎么答，verdict 定领导最后说过不过 */
function playNight(n: ReturnType<typeof teamRig>, o: { ans?: (sid: string, qid: string, q: string) => string; verdict?: (stage: string) => boolean; events?: (s: FakeSession) => Promise<void> } = {}) {
  const leadWakes: string[] = [];
  const stageWakes: Record<string, string> = {};
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      stageWakes.events = text;
      if (o.events) return o.events(s);
      await s.play({ tool: { name: "mem_event_create", args: { title: "今天定的事", summary: "定了周五交", gist: "周五交", importance: 3 } } });
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "记了一件事、补了一行", changes: [
        { target: "memory/a.md", op: "add", before: "", after: "今天定了周五交", evidence: ["c:1"], why: "今天说的" },
        { target: "e0001", op: "add", before: "", after: "今天定的事", evidence: ["c:1"], why: "今天说的" }] } }, total: USE });
    } else if (s.id === `sleep-${DAY1}-people-1`) {
      stageWakes.people = text;
      n.files.set(`sleep/${DAY1}/proposed/people/x.md`, "他周五要交东西\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "人的卡补了一句（2026-11-02、2026-11-03 欠着的也补了）", changes: [{ target: "people/x.md", op: "add", before: "", after: "他周五要交东西", evidence: ["c:1"], why: "今天说的" }] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      leadWakes.push(text);
      const stage = s.id.endsWith("-events") ? "events" : "people";
      if (text.includes("lead_review")) {
        await s.play({ tool: { name: "lead_review", args: { intent: [{ target: "memory/a.md", what: "补今天定的事", fix: "" }], questions: [
          tq(`${stage}原来记着什么`, "keep"), tq(`${stage}今天定了什么`, "new"),
          ...(text.includes("你现在最挂心的是什么") ? [tq("你现在最挂心的是什么", "new", { layer: "searchable" })] : []),
        ] } }, total: USE, first: { input: 10, cacheRead: 4000, cacheWrite: 90 } });
      } else await s.play({ tool: { name: "lead_verdict", args: { pass: o.verdict ? o.verdict(stage) : true, fixes: [{ what: "漏了一句", fix: "补上" }], notes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, (qid, q) => (o.ans ? o.ans(s.id, qid, q) : "对的")));
  });
  return { pilot, leadWakes, stageWakes };
}

test("team night: both specialists pass — lead review, consistency exam, lead verdict; batches committed, records written, questions activated on landing; no audit, review or coordinator session", { timeout: 30_000 }, async () => {
  const n = teamRig({
    team: { continuity: ["你现在最挂心的是什么"] },
    seed: (bank) => { bank.importSeed([{ id: "old1", q: "以前的旧题", gold: "旧答案", evidence: ["memory/a.md:1"] }, { id: "old2", q: "不相干的旧题", gold: "x", evidence: ["other.md:1"] }], { tag: "t", layer: "searchable", day: "2026-11-01" }); },
  });
  const p = playNight(n);
  const res = await n.run();
  await p.pilot.stop();
  assert.deepEqual(p.pilot.errors, []);
  assert.deepEqual([res.landed, res.stoppedBy, res.owed], [[DAY1], "done", []]);
  const ids = n.driver.sessions.map((s) => s.id);
  assert.ok(!ids.some((id) => /^(audit|review|coord)-/.test(id)), ids.join(" "));
  assert.deepEqual(ids.filter((id) => id.startsWith("sleep-") || id.startsWith("lead-")), [`sleep-${DAY1}-events-1`, `lead-${DAY1}-events`, `sleep-${DAY1}-people-1`, `lead-${DAY1}-people`], "照配置里的顺序，一个专员一个领导的会话");
  // 领导：两个专员各问两次；固定要问的题只在最后一个专员那里给
  assert.equal(p.leadWakes.length, 4);
  assert.ok(p.leadWakes[0]!.includes("领导的页") && p.leadWakes[0]!.includes("今天定了周五交") && p.leadWakes[0]!.includes("【新建事件】事件 e0001「今天定的事」"));
  assert.ok(!p.leadWakes[0]!.includes("你现在最挂心的是什么") && p.leadWakes[2]!.includes("你现在最挂心的是什么"));
  assert.ok(p.leadWakes[1]!.includes("前后一致，过了"), p.leadWakes[1]);
  // 考试：领导的题 + 引擎加的挂在改过的东西上的旧题（keep）
  const exam1 = n.driver.sessions.find((s) => s.id === `exam-${DAY1}-events-1-after-searchable`)!;
  const paper = exam1.sent.map((x) => x.text).join("\n");
  assert.ok(paper.includes("events原来记着什么") && paper.includes("events今天定了什么") && paper.includes("以前的旧题") && !paper.includes("不相干的旧题"));
  // 固定要问的题：常驻那层
  assert.ok(ids.includes(`exam-${DAY1}-people-1-continuity-resident`), "单独一场");
  // 事件库：两批都提交了；第二个专员的材料里有第一个今晚写的
  assert.equal(n.m.store.batchState(`sleep:${DAY1}/events/1`), "committed");
  assert.ok(n.m.store.event("e0001"));
  assert.ok(p.stageWakes.people!.includes("今天定的事"), "tonight-events 看得到前一个专员提交的");
  assert.ok(n.files.has(`sleep/${DAY1}/flow/events.json`) && n.files.has(`sleep/${DAY1}/flow/people.json`));
  assert.ok(n.files.get(`sleep/${DAY1}/flow/lead/events.1.diff`)!.includes("+ 今天定了周五交"));
  const leadFile = JSON.parse(n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { questions: Array<{ id: string; probe: string }>; old: string[] };
  assert.deepEqual(leadFile.questions.map((q) => q.probe), ["keep", "new"]);
  assert.deepEqual(leadFile.old, ["seed:t/old1"]);
  // 落地：finish 跑了；领导的题生效
  assert.deepEqual(n.runs.at(-1), ["scripts/finish.py", DAY1]);
  assert.equal(n.hosts.bank.get(`q:${DAY1}/events/1`)!.status, "active");
  assert.equal(n.hosts.bank.get(`q:${DAY1}/people/3`)!.layer, "resident", "固定要问的题引擎定成常驻");
  // 记账：decision lead:pass，花费按角色；整夜的花费 = 各角色加起来
  const rows = stageRows(n.db).filter((r) => r.stage !== "finish");
  assert.deepEqual(rows.map((r) => [r.stage, r.status, r.decision]), [["events", "passed", "lead:pass"], ["people", "passed", "lead:pass"]]);
  let sum = 0;
  for (const r of rows) {
    const c = JSON.parse(r.cost!) as Record<string, number>;
    assert.deepEqual(Object.keys(c), ["do", "lead", "exam"]);
    assert.ok(c.do! > 0 && c.lead! > 0 && c.exam! > 0, r.cost!);
    assert.equal(c.do, r.units);
    sum += c.do! + c.lead! + c.exam!;
  }
  assert.ok(Math.abs(sum - n.budget.spent) < 1e-6, `${sum} vs ${n.budget.spent}`);
  assert.deepEqual(rows.map((r) => [r.questions, r.score_after]), [[3, 1], [2, 1]]);   // 固定要问的那道不在它自己的卷子里（单独一场）
  assert.ok(n.files.get(`sleep/${DAY1}/report.md`));
});

test("team night: a dropped specialist — its files, batch and questions go, the next specialist still runs on what was there before, an owed row is written and the day lands", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", after: ["events"], tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  const n = teamRig({ stages });
  n.files.set(`sleep/${DAY1}/proposed/keep.md`, "准备脚本放的\n");
  // events 的 keep 题：整理后答不出、整理前答得出
  const p = playNight(n, { ans: (sid, _qid, q) => (q.includes("events原来记着什么") && !sid.includes("-before-") ? "不记得" : "对的"), verdict: () => true });
  const res = await n.run();
  await p.pilot.stop();
  assert.deepEqual(p.pilot.errors, []);
  assert.deepEqual([res.landed, res.owed], [[DAY1], [{ day: DAY1, stage: "events" }]]);
  // events 的东西都撤了：文件恢复、批撤回、题丢掉；别人的文件没动
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/memory/a.md`), undefined);
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/keep.md`), "准备脚本放的\n");
  assert.equal(n.m.store.event("e0001"), undefined);
  assert.notEqual(n.m.store.batchState(`sleep:${DAY1}/events/1`), "committed");
  assert.deepEqual([1, 2].map((i) => n.hosts.bank.get(`q:${DAY1}/events/${i}`)!.status), ["dropped", "dropped"]);
  assert.equal(n.files.get(`sleep/${DAY1}/deferred/events/memory/a.md`), "原来的一行\n今天定了周五交\n", "留一份给人看");
  // 下一个专员照常做、照常过，它的东西留着
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/people/x.md`), "他周五要交东西\n");
  const rows = stageRows(n.db).filter((r) => r.stage !== "finish");
  assert.deepEqual(rows.map((r) => [r.stage, r.status, r.decision]), [["events", "deferred", "lead:drop"], ["people", "passed", "lead:pass"]]);
  assert.match(rows[0]!.verdict, /整理前答得出/);
  assert.equal(n.hosts.bank.get(`q:${DAY1}/people/1`)!.status, "active");
  // 领导说过也没用：考试没过
  assert.ok(n.files.get(`sleep/${DAY1}/report.md`)!.includes("前后一致的考试没过"));
  // 下一个专员的领导（新的会话）开头知道前一个没落地、为什么
  assert.ok(p.leadWakes[2]!.includes(S.leadprompts.digest.head) && p.leadWakes[2]!.includes("「事件」没过，它的改动整份没落地") && p.leadWakes[2]!.includes("整理前答得出"), p.leadWakes[2]!.slice(0, 600));
  assert.deepEqual(n.runs.at(-1), ["scripts/finish.py", DAY1]);
});

test("team night: a required specialist that is dropped aborts the day — nothing lands, the later specialist never opens; a lead that says no on a passing exam also drops", { timeout: 30_000 }, async () => {
  const n = teamRig();
  const p = playNight(n, { verdict: (stage) => stage !== "events" });
  const res = await n.run();
  await p.pilot.stop();
  assert.deepEqual([res.landed, res.deferredDays], [[], [DAY1]]);
  assert.ok(!n.driver.sessions.some((s) => s.id.startsWith(`sleep-${DAY1}-people`)));
  assert.ok(!n.runs.some((r) => r[0] === "scripts/finish.py"));
  assert.equal(n.m.store.event("e0001"), undefined);
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/memory/a.md`), undefined);
  const row = stageRows(n.db).find((r) => r.stage === "events")!;
  assert.deepEqual([row.status, row.decision], ["deferred", "lead:drop"]);
  assert.match(row.verdict, /漏了一句；该怎么改：补上/);
  assert.ok(n.driver.sessions.find((s) => s.id === `lead-${DAY1}-events`)!.closed, "这个专员定了，它的领导会话关掉");
});

test("team night: a specialist that changes nothing passes without the lead; one that never hands in is dropped without the lead; M1's per-turn cache line is logged", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "extra", title: "别的", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["extra"] },
  ];
  const n = teamRig({ stages });
  const pilot = autopilot(n.driver, async (s, _text, nth) => {
    if (s.id === `sleep-${DAY1}-events-1`) await s.play({ tool: { name: "stage_done", args: { status: "nothing", report: "没什么要改", changes: [] } }, total: USE, first: { input: 7, cacheRead: 0, cacheWrite: 4321 } });
    else if (s.id === `sleep-${DAY1}-people-1`) await s.play({ say: nth === 1 ? "我想想" : "还在想", total: USE });
    else if (s.id === `sleep-${DAY1}-extra-1`) {
      n.files.set(`sleep/${DAY1}/proposed/x.md`, "一行\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "加了一行", changes: [{ target: "x.md", op: "add", before: "", after: "一行", evidence: ["c:1"], why: "说过" }] } }, total: USE });
    } else if (s.id.startsWith("lead-")) await s.play({ say: "（领导没交）", total: USE });
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(res.landed, [DAY1]);
  const rows = stageRows(n.db).filter((r) => r.stage !== "finish");
  assert.deepEqual(rows.map((r) => [r.stage, r.status, r.decision]), [["events", "passed", "rule:pass"], ["people", "deferred", "rule:drop"], ["extra", "deferred", "rule:drop"]]);
  assert.match(rows[2]!.verdict, /没考成/, "改了东西却没考成：不落地，原因写在这一行");
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/x.md`), undefined);
  assert.match(rows[1]!.verdict, /没交 stage_done/);
  // 没改东西的、没交的都不叫领导；领导没回的：没题可考，照规矩过，报告里写一句
  const lead = n.driver.sessions.filter((s) => s.id.startsWith("lead-"));
  assert.equal(lead.length, 1);
  assert.ok(lead[0]!.sent.every((x) => !/【专员交差】[^\n]*「(事件|人)」/.test(x.text)));
  const report = n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(S.lead.silent) && report.includes(LP.CONSIST.noQuestions), report.slice(0, 400));
  // M1：每一轮一行，第一次调用读写缓存多少、之前闲了多久
  const lines = n.logs.filter((r) => r.msg === "sleep: turn cache").map((r) => r as Record<string, unknown>);
  const ev = lines.find((x) => x.id === `sleep-${DAY1}-events-1`)!;
  assert.deepEqual([ev.role, ev.turn, ev.firstCacheRead, ev.firstCacheWrite, ev.firstInput, ev.calls, ev.cacheRead, ev.cacheWrite], ["specialist", 1, 0, 4321, 7, 3, 5000, 200]);
  assert.equal(typeof ev.idleSec, "number");
  const ld = lines.filter((x) => x.role === "lead");
  assert.ok(ld.length >= 2 && ld[1]!.turn === 2 && (ld[1]!.idleSec as number) >= 0);
});

test("kernel: UsageTally remembers the first call of a turn; a fake script's first reaches the stage session's turn info", () => {
  const t = new UsageTally();
  assert.equal(t.first(), null);
  t.add("m1", { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 1 });
  t.add("m1", { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 900, output_tokens: 9 });
  t.add("m2", { input_tokens: 1, cache_read_input_tokens: 905, cache_creation_input_tokens: 20, output_tokens: 3 });
  assert.deepEqual(t.first(), { input: 5, cacheRead: 0, cacheWrite: 900 });
  assert.deepEqual(t.take(), { calls: 2, input: 6, cacheRead: 905, cacheWrite: 920, output: 12 }, "合计照旧，不多一个键");
  assert.equal(t.first(), null, "下一轮重新记");
});

// ---------- T6：回放（M1）——一天、team、假内核 ----------

const put = (root: string, relPath: string, text: string): void => { mkdirSync(dirname(join(root, relPath)), { recursive: true }); writeFileSync(join(root, relPath), text); };
async function gitIn(cwd: string, ...args: string[]): Promise<string> {
  const r = await runProcess("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}
async function replayRig(flow: Record<string, unknown>, sleepCfg: Record<string, unknown> = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "hh-lead-replay-"));
  const W = join(tmp, "W");
  mkdirSync(W);
  await gitIn(W, "init", "-q");
  put(W, "SOUL.md", "我是谁\n");
  put(W, "memory/a.md", "原来的一行\n");
  put(W, ".gitignore", "sleep/*/input.md\n");
  await gitIn(W, "add", "-A");
  await gitIn(W, "commit", "-q", "-m", "白天");
  const base = await gitIn(W, "rev-parse", "HEAD");
  put(W, `sleep/${DAY1}/input.md`, "这一天的对话\n");
  const flowDir = join(tmp, "flow");
  put(flowDir, "flow.json", JSON.stringify(flow));
  put(flowDir, "common.md", "COMMON\n");
  put(flowDir, "events.md", "事件专员的页\n");
  put(flowDir, "lead.md", "领导的页\n");
  const cfg = loadConfig({ workspace: W, stateDir: join(tmp, "state"), schedule: { timezone: "UTC", focusSlots: ["07:30"], focusMinutes: 30, nightSleep: "03:00", wanderEveryMinutes: 45 }, learning: { root: join(W, "skills") }, sleep: { workspaceEnv: ["OPENCLAW_WORKSPACE"], ...sleepCfg } });
  const live = openDb(join(tmp, "live", "hh.db"));
  const win = nightWindow(DAY1, "UTC", "03:00");
  const liveMem = new EventMemory({ db: live, embedder: null, now: () => win.from - 3_600_000, tz: "UTC" });
  liveMem.store.createEvent({ title: "以前的事", summary: "x", gist: "x", importance: 2 }, "seed");
  liveMem.store.commitBatch("seed");
  const driver = confirming(new FakeDriver());
  const logs: LogRecord[] = [];
  const deps: ReplayDeps = {
    cfg, driver, db: live, log: new Logger("t", memorySink(logs)), run: runProcess, now: Date.now,
    later: (fn, ms) => { const h = setTimeout(fn, ms); h.unref(); return () => clearTimeout(h); },
    openMem: (db, x) => new EventMemory({ db, embedder: null, tz: "UTC", ...(x.peopleDir ? { peopleDir: x.peopleDir } : {}), ...(x.peopleActive ? { peopleActive: x.peopleActive } : {}) }),
    tools: (id, names, x) => memTools(x.mem, id, names, x.learn),
  };
  return { tmp, W, base, flowDir, cfg, live, driver, logs, deps };
}
const REPLAY_FLOW = {
  engine: "legacy", maxParallel: 1, exam: { baseBlocks: ["SOUL.md"] },
  team: { lead: { model: "opus", skill: "lead.md", turnMinutes: 5 } },
  stages: [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/sleep_apply.py", "finish", "{day}"], after: ["events"] },
  ],
};

test("M1 replay: one day in team mode on the fake kernel — a flow.json with a team block replays as team (engine team or legacy), ends done, and compare.md has a cost row per role", { timeout: 60_000 }, async () => {
  const r = await replayRig(REPLAY_FLOW);
  const mgr = new ReplayManager();
  const { dir, done } = mgr.start(r.deps, { day: DAY1, flowDir: r.flowDir, base: r.base });
  const ws = join(dir, "ws");
  const pilot = autopilot(r.driver, async (s, text) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      await s.play({ tool: { name: "mem_event_create", args: { title: "今天定的事", summary: "定了周五交", gist: "周五交", importance: 3 } } });
      put(ws, `sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "记了一件事", changes: [{ target: "memory/a.md", op: "add", before: "", after: "今天定了周五交", evidence: ["c:1"], why: "今天说的" }] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("原来记着什么", "keep"), tq("今天定了什么", "new")] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  // 回放卡住（比如开了没人演的会话）：15 秒就停下、算没过，不拖到整个测试超时
  const stuck = setTimeout(() => { void mgr.stop("测试：回放卡住了"); }, 15_000);
  await done;
  clearTimeout(stuck);
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
  assert.equal(st.phase, "done", st.error ?? "");
  assert.equal((JSON.parse(readFileSync(join(ws, r.cfg.sleep.flowFile), "utf8")) as { engine: string }).engine, "team", "写的 legacy、有 team 块：回放照 team 跑");
  const ids = r.driver.sessions.map((s) => s.id);
  assert.ok(ids.includes(`lead-${DAY1}-events`) && ids.includes(`exam-${DAY1}-events-1-after-searchable`) && !ids.some((id) => id.startsWith("audit-")), ids.join(" "));
  const ledger = JSON.parse(readFileSync(join(dir, "out", "ledger.json"), "utf8")) as { sleep_stage: Array<Record<string, unknown>> };
  const ev = ledger.sleep_stage.find((x) => x.stage === "events")!;
  assert.deepEqual([ev.status, ev.decision], ["passed", "lead:pass"]);
  const cmp = readFileSync(join(dir, "out", "compare.md"), "utf8");
  assert.match(cmp, /## 花费（按角色，单位）\n\| 段 \| 做 \| 领导 \| 考试 \|/);
  assert.match(cmp, /## 各会话的开头（第一次调用的输入 token）\n\| 会话 \| 角色 \| 开头 \|/);
  assert.ok(cmp.includes(`| lead-${DAY1}-events | 领导 |`) && cmp.includes(`| sleep-${DAY1}-events-1 | 专员 |`));
  assert.match(cmp, /\| events \| \d+ \| \d+ \| \d+ \|/);
  assert.match(cmp, /\| 合计 \| \d+ \| \d+ \| \d+ \|/);
  // 考了没有、各种题几道（keep / new / missed / continuity）
  assert.match(cmp, /\| 段 \| 做 \| 领导 \| 考试 \| 考了没有 \| 题（keep \/ new \/ missed \/ continuity） \|/);
  assert.match(cmp, /\| events \| \d+ \| \d+ \| \d+ \| 考了 \| 1 \/ 1 \/ 0 \/ 0 \|/);
  assert.ok(existsSync(join(dir, "out", "records", "lead", "events.1.diff")));
  // W 没动
  assert.equal(readFileSync(join(r.W, "memory/a.md"), "utf8"), "原来的一行\n");
});

test("M1 replay: without a team block a legacy flow.json still replays as flow; a team block under engine flow stays flow", { timeout: 60_000 }, async () => {
  for (const [flow, want] of [[{ ...REPLAY_FLOW, team: undefined, exam: undefined }, "flow"], [{ ...REPLAY_FLOW, engine: "flow" }, "flow"], [{ ...REPLAY_FLOW, engine: "team" }, "team"]] as const) {
    const r = await replayRig(JSON.parse(JSON.stringify(flow)) as Record<string, unknown>);
    const m = new ReplayManager();
    const { dir, done } = m.start(r.deps, { day: DAY1, flowDir: r.flowDir, base: r.base });
    for (let i = 0; i < 500 && r.driver.sessions.length === 0; i++) await sleepMs(10);
    assert.equal((JSON.parse(readFileSync(join(dir, "ws", r.cfg.sleep.flowFile), "utf8")) as { engine: string }).engine, want);
    await m.stop("测试完了");
    await done;
  }
});

// ---------- 上线前评审修正轮 ----------

test("pre-deploy I1: not examined is never a pass — leadRuled drops it whatever the lead says; consistencyExam says pass false", () => {
  const off: ConsistencyResult = { examined: false, pass: false, failed: [], notes: [LP.CONSIST.broken("考生 after-searchable 两次都没交卷")], scoreAfter: null, scoreBefore: null };
  for (const answer of [{ pass: true, fixes: [], notes: [] }, null]) {
    const r = leadRuled({ title: "事件", exam: off, answer });
    assert.equal(r.pass, false);
    assert.deepEqual(r.problems, [LP.CONSIST.notExamined(off.notes[0]!)]);
  }
  // 老的调用方就算把 pass 写成 true，没考成也不算过
  assert.equal(leadRuled({ title: "事件", exam: { ...off, pass: true }, answer: { pass: true, fixes: [], notes: [] } }).pass, false);
});

test("pre-deploy I1: exam sessions that never hand in drop a specialist that changed something; the row says why; configured continuity questions the lead never hands in fail the owner closed", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  // 固定要问的题在 people 那里问：领导没回、题没交上来 → 这道关没考成，不算过
  const n = teamRig({ stages, team: { continuity: ["你现在最挂心的是什么"] } });
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      n.files.set(`sleep/${DAY1}/proposed/x.md`, "一行\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "加了一行", changes: [{ target: "x.md", op: "add", before: "", after: "一行", evidence: ["c:1"], why: "说过" }] } }, total: USE });
    } else if (s.id === `sleep-${DAY1}-people-1`) await s.play({ tool: { name: "stage_done", args: { status: "nothing", report: "没什么要改", changes: [] } }, total: USE });
    else if (s.id.startsWith("lead-")) {
      if (text.includes("「事件」") && text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("原来记着什么", "keep")] } }, total: USE });
      else if (text.includes("「事件」")) await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
      else await s.play({ say: "（没交）", total: USE });
    } else if (s.id.startsWith("exam-")) await s.play({ say: "（考生没交卷）", total: USE });
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(res.landed, [DAY1]);
  const rows = stageRows(n.db).filter((r) => r.stage !== "finish") as Array<ReturnType<typeof stageRows>[number] & { examined: number | null }>;
  assert.deepEqual(rows.map((r) => [r.stage, r.status, r.decision, r.examined]), [["events", "deferred", "rule:drop", 0], ["people", "deferred", "rule:drop", 0]]);
  assert.ok(rows[1]!.verdict.includes(LP.CONT.notHandedIn(["你现在最挂心的是什么"])), "固定要问的题领导没交：不算过");
  assert.ok(!n.driver.sessions.find((s) => s.id.startsWith("lead-"))!.sent.some((x) => x.text.includes("lead_verdict") && x.text.includes("「事件」")), "没考成就不问领导过不过");
  assert.match(rows[0]!.verdict, /没考成.*两次都没交卷/);
  assert.equal(n.files.get(`sleep/${DAY1}/proposed/x.md`), undefined, "没考成的改动不落地");
  assert.deepEqual(res.owed, [{ day: DAY1, stage: "events" }, { day: DAY1, stage: "people" }]);
});

test("pre-deploy I2+I3: continuity questions have their own probe — after sitting only, counted with new and missed, never sent to the before sitting; they can fail a specialist and never enter the bank", { timeout: 30_000 }, async () => {
  // 考试：continuity 错了不考整理前，跟 new / missed 一起算得分率
  const h = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const { r } = await consist(h, [cq(1, { layer: "resident" }), cq(2)], { 1: "continuity", 2: "new" });
  assert.equal(r.pass, false);
  assert.deepEqual(r.failed.map((f) => [f.probe, f.why, f.before]), [["continuity", LP.CONSIST.continuity, undefined]]);
  assert.ok(!sitIds(h).some((x) => x.startsWith("before-")));

  // 一夜：固定要问的题答不出 → 那个专员没过；这些题不管过没过都不进题库
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  for (const fails of [true, false]) {
    const n = teamRig({ stages, team: { continuity: ["你现在最挂心的是什么"], tolerance: 1 } });
    const p = playNight(n, { ans: (_sid, _qid, q) => (fails && q.includes("最挂心") ? "不记得" : "对的") });
    const res = await n.run();
    await p.pilot.stop();
    assert.deepEqual(res.landed, [DAY1]);
    assert.ok(p.leadWakes[2]!.includes("probe 写 continuity"));
    const people = stageRows(n.db).find((x) => x.stage === "people")!;
    assert.deepEqual([people.status, people.decision], fails ? ["deferred", "rule:drop"] : ["passed", "lead:pass"]);
    const file = JSON.parse(n.files.get(`sleep/${DAY1}/flow/lead/people.json`)!) as { questions: Array<{ probe: string; layer: string }>; counts: Record<string, number> };
    assert.deepEqual(file.questions.map((q) => [q.probe, q.layer]), [["keep", "searchable"], ["new", "searchable"], ["continuity", "resident"]]);
    assert.deepEqual(file.counts, { keep: 1, new: 1, missed: 0, continuity: 1 });
    assert.ok(!n.driver.sessions.some((s) => s.id.includes("people-1-before-resident")), "固定要问的题不考整理前");
    // 不进题库：过了的那一夜，别的题生效，它丢掉
    assert.equal(n.hosts.bank.get(`q:${DAY1}/people/3`)!.status, "dropped");
    if (!fails) assert.equal(n.hosts.bank.get(`q:${DAY1}/people/1`)!.status, "active");
    assert.equal(n.hosts.bank.touching({ files: ["memory/a.md"] }, 50).some((q) => q.q.includes("最挂心")), false);
  }
});

test("pre-deploy I4: a new / missed question needs a source from outside the specialist's own change — a raw row, or something that was there before", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["events"] },
  ];
  const n = teamRig({ stages, seed: (_bank, m) => { m.store.createEvent({ title: "以前的事", summary: "x", gist: "x", importance: 2 }, "seed"); m.store.commitBatch("seed"); } });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '今天说周五交', 5)").run();
  const replies: string[] = [];
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      await s.play({ tool: { name: "mem_event_create", args: { title: "今天定的事", summary: "定了周五交", gist: "周五交", importance: 3 } } });
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n");
      n.files.set(`sleep/${DAY1}/proposed/memory/new.md`, "它新建的文件\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "记了", changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-") && text.includes("lead_review")) {
      const src = (sources: string[], probe = "new") => tq(`题 ${sources.join("+")}（${probe}）`, probe, { sources });
      const def = s.spec.tools.find((t) => t.name === "lead_review")!;
      const args = { intent: [], questions: [
        src(["e0002"]),                       // 它这一批新建的事件
        src(["memory/a.md:2"]),               // 它提案里新加的那一行
        src(["memory/new.md:1"], "missed"),   // 它新建的文件
        src(["e0002"], "keep"),               // keep 不管这一条（照旧只要查得到）
        src(["c:7"]),                         // 原话
        src(["e0001"]),                       // 以前就有的事件
        src(["memory/a.md:1"], "missed"),     // 原来就有的那一行
        src(["e0002", "#7"]),                 // 有一条是外面的就行
      ] };
      await def.handler(args);                                  // 头一次：引擎把出处贴回来，不收
      replies.push(await def.handler({ ...args, checked: true }));
      await s.play({ say: "交了", total: USE });
    } else if (s.id.startsWith("lead-")) await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  const reply = replies[0]!;
  assert.match(reply, /收下 5 道/);
  assert.equal(reply.split(LP.LEAD_REFUSED.ownChange).length - 1, 3, reply);
  for (const part of ["第 1 道", "第 2 道", "第 3 道"]) assert.ok(reply.includes(part), part);
  const file = JSON.parse(n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { questions: Array<{ q: string }> };
  assert.deepEqual(file.questions.map((q) => q.q), ["题 e0002（keep）", "题 c:7（new）", "题 e0001（new）", "题 memory/a.md:1（missed）", "题 e0002+#7（new）"]);
});

test("pre-deploy I5: engine team without a usable team block does not replay as flow — the replay fails with the reason", { timeout: 60_000 }, async () => {
  for (const team of [undefined, "x"]) {
    const r = await replayRig({ ...REPLAY_FLOW, engine: "team", team });
    const { dir, done } = new ReplayManager().start(r.deps, { day: DAY1, flowDir: r.flowDir, base: r.base });
    await done;
    const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { phase: string; error: string | null };
    assert.equal(st.phase, "failed");
    assert.match(st.error ?? "", /流程用不了/);
    assert.match(st.error ?? "", /team/);
    assert.equal(r.driver.sessions.length, 0, "一个会话都没开");
    assert.equal((JSON.parse(readFileSync(join(dir, "ws", r.cfg.sleep.flowFile), "utf8")) as { engine: string }).engine, "team");
  }
});

test("pre-deploy minors: an unmarked before answer and a resident before view that cannot be built are 'cannot judge' — never read as 'wrong both times'", async () => {
  // 判分没给整理前那道题判定：没法判，照碰坏了算
  const unmarked = consistHost((sid) => (sid.includes("-before-") ? "对的" : "不记得"));
  const inner = unmarked.host.open.bind(unmarked.host);
  unmarked.host.open = (op) => {
    const s = inner(op);
    if (!op.id.includes("-grade-before")) return s;
    // 整理前那一场的判分会话：漏判一道
    return { ...s, onGrades: (fn: (g: ExamGrades) => string) => s.onGrades((g) => fn({ grades: g.grades.filter((x) => !x.id.endsWith("/2")), layers: g.layers })) } as never;
  };
  const a = await consist(unmarked, [cq(1), cq(2)], { 1: "keep", 2: "keep" });
  assert.equal(a.r.examined, false, "整理前那一场有一道没判：不当成整理前也答不出，算没考成");
  assert.equal(a.r.pass, false);
  assert.ok(a.r.notes.at(-1)!.includes("没给") && a.r.notes.at(-1)!.includes("/2"));

  // 常驻那层整理前的样子拼不出来：那道 keep 题照碰坏了算
  const h = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"), { before: { "SOUL.md": "旧的我" } });
  const preview = h.host.preview.bind(h.host);
  h.host.preview = async (x) => { if (x.state === "before") throw new Error("预览脚本坏了"); return preview(x); };
  const b = await consist(h, [cq(1, { layer: "resident" })], { 1: "keep" }, { before: snapOf({}), after: snapOf({ "SOUL.md": "新的我" }) });
  assert.equal(b.r.pass, false);
  assert.deepEqual(b.r.failed.map((f) => f.why), [LP.CONSIST.noBeforeView]);
});

// ---------- 11-10 回放以后：领导第一次调用没读到缓存 ----------

test("prefix cache: every spec field that feeds the SDK request is equal for an opus specialist and the lead (real tool definitions); only the model differs for a sonnet specialist; the open is logged with the key", async () => {
  const n = teamRig({ stages: [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["mem_event_create", "mem_person_set", "recall_event", "remember"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", model: "sonnet", tools: ["recall_person"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ] });
  n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["mem_event_create", "stage_done"]) }).wake("专员的活：很长的一段材料");
  n.hosts.lead!.open({ id: `lead-${DAY1}`, model: "opus", timeoutMs: 60_000 }).wake("【夜里整理·把关】领导的活");
  n.hosts.stage.open({ id: `sleep-${DAY1}-people-1`, stage: n.flow.stages[1]!, day: DAY1, allowed: new Set(["stage_done"]) }).wake("另一个专员的活");
  const [spec, lead, sonnet] = n.driver.sessions.map((s) => cacheKeyOf(s.spec));
  assert.ok(n.driver.sessions[0]!.spec.tools.length > 8, "真的工具定义（事件库的、交差的）");
  assert.deepEqual(lead, spec, "模型、系统提示、工具（名字、说明、参数的 schema）、内置工具、目录、权限、环境、插件：全一样");
  assert.deepEqual(Object.keys(spec!).sort(), ["allowedTools", "builtinTools", "claudeExecutable", "cwd", "env", "fallbackModel", "mcpServers", "model", "permissionMode", "plugins", "systemAppend", "tools"]);
  assert.deepEqual(Object.keys(sonnet!).filter((k) => sonnet![k] !== spec![k]), ["model"]);
  // 内核（Claude Code 2.1.312）拿第一条用户消息的第 4、7、20 个字算一个指纹，写在系统提示最前面那一行里：前 21 个字得一样
  const first = n.driver.sessions.map((s) => s.sent[0]!.text.slice(0, 21));
  assert.equal(first[1], first[0]);
  assert.equal(first[0]!.length, 21);
  // 真内核上对不对得上，看这一行（每个会话开的时候记一次）
  const lines = n.logs.filter((r) => r.msg === "sleep: session spec");
  assert.deepEqual(lines.map((r) => r.id), [`sleep-${DAY1}-events-1`, `lead-${DAY1}`, `sleep-${DAY1}-people-1`]);
  assert.deepEqual(lines[1]!.key, lines[0]!.key);
  assert.notDeepEqual(lines[2]!.key, lines[0]!.key);
  assert.equal(typeof lines[0]!.systemChars, "number");
  // flow 的夜里不记这一行
  const flow = parseFlow({ engine: "flow", stages: [agent("events", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["events"] })] }, known);
  const logs: LogRecord[] = [];
  const cfg = loadConfig({ workspace: "/tmp/hh-lead-ws", stateDir: mkdtempSync(join(tmpdir(), "hh-lead-hosts-")) });
  const fs: MiniFs = { read: () => null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const b: NightBrain = { cfg, driver: new FakeDriver(), db: openDb(":memory:"), log: new Logger("t", memorySink(logs)), mem: null, fs, run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => "页", now: () => 1, later: () => () => {}, hhTools: () => [] };
  const h = nightHosts(b, { flow, prefix: "P", hash: "h" }, { budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), weights: sleepWeights(undefined), auditMs: 1000 });
  h.stage.open({ id: `sleep-${DAY1}-events-1`, stage: flow.stages[0]!, day: DAY1, allowed: new Set(["stage_done"]) }).wake("开始");
  assert.equal(logs.filter((r) => r.msg === "sleep: session spec").length, 0);
});

// ---------- T7：没过就在同一个专员的会话里改 ----------

const FIX_STAGES = [
  { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["mem_event_create", "mem_retire", "recall"], material: ["dialogue"], writes: ["**"], budget: { calls: 4, minutes: 7 } },
  { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["events"] },
];
/**
 * 一个专员、能改 rounds 轮的一夜。第 1 轮：建一件事、a.md 加一行；之后每轮：a.md 再补一行「为什么」。
 * 领导第 1 轮出三道（a.md 上的 keep、SOUL 上的 keep、new「为什么」），之后每轮再出一道；考生答不答得出「为什么」看 knows(第几轮)
 */
function fixNight(o: { maxFixRounds: number; knows: (round: number) => boolean; fixChanges?: boolean; leadSays?: (round: number) => boolean; round1Extra?: unknown[]; round1Questions?: unknown[]; team?: Record<string, unknown>; round2Questions?: unknown[]; verdict?: (round: number, text: string) => Record<string, unknown>; ans?: (sid: string, q: string, round: number) => string | undefined; onLead?: (s: FakeSession, text: string, round: number) => void | Promise<void>; onFix?: (s: FakeSession, round: number) => void | Promise<void> }) {
  const n = teamRig({ stages: FIX_STAGES, team: { maxFixRounds: o.maxFixRounds, ...o.team } });
  const leadWakes: string[] = [];
  const fixWakes: string[] = [];
  const papers: Record<string, string> = {};
  let round = 0;
  const pilot = autopilot(n.driver, async (s, text, nth) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      round = nth;
      if (nth === 1) {
        // 不结束这一轮就写事件库（这一轮里只交一次差）
        await s.spec.tools.find((t) => t.name === "mem_event_create")!.handler({ title: "今天定的事", summary: "定了周五交", gist: "周五交", importance: 3 });
        n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n");
        await s.play({ tool: { name: "stage_done", args: { status: "done", report: "记了一件事、补了一行", changes: [{ target: "memory/a.md", op: "add", before: "", after: "今天定了周五交", evidence: ["c:1"], why: "今天说的" }] } }, total: USE });
      } else {
        if (text.includes("你还没调 stage_done")) return;   // 催交的那一句：这一轮的活已经在上一条里做了
        fixWakes.push(text);
        if (o.onFix) { await o.onFix(s, nth); if (s.closed) return; }
        if (o.fixChanges === false) { await s.play({ tool: { name: "stage_done", args: { status: "done", report: "看过了，没什么要改", changes: [] } }, total: USE }); return; }
        n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, `${n.files.get(`sleep/${DAY1}/proposed/memory/a.md`)!}第 ${nth} 轮补的：因为他要出差\n`);
        await s.play({ tool: { name: "stage_done", args: { status: "done", report: `第 ${nth} 轮补了为什么`, changes: [{ target: "memory/a.md", op: "add", before: "", after: "因为他要出差", evidence: ["c:1"], why: "漏了" }] } }, total: USE });
      }
    } else if (s.id.startsWith("lead-")) {
      leadWakes.push(text);
      if (o.onLead) await o.onLead(s, text, round);
      if (s.closed) return;
      if (text.includes("lead_review")) {
        await s.play({ tool: { name: "lead_review", args: { intent: [{ target: "memory/a.md", what: "补今天定的事", fix: round === 1 ? "没写为什么" : "" }], questions: round === 1
          ? o.round1Questions ?? [tq("a 上原来记着什么", "keep"), tq("我是谁", "keep", { sources: ["SOUL.md:1"], tags: { who: [], events: [], files: ["SOUL.md"], lessons: [] } }), tq("为什么周五交", "new", { sources: ["c:7"], gold: "周五交，因为他要出差" }), ...(o.round1Extra ?? [])]
          : o.round2Questions ?? [tq(`第 ${round} 轮新出的题`, "new", { sources: ["c:7"] })] } }, total: USE });
      } else await s.play({ tool: { name: "lead_verdict", args: o.verdict ? o.verdict(round, text) : { pass: o.leadSays ? o.leadSays(round) : true, fixes: [{ what: "写法不对", fix: "照原话改" }] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) {
      papers[s.id] = text;
      await s.play(answerAll(text, (_qid, q) => o.ans?.(s.id, q, round) ?? (q.includes("为什么周五交") && !o.knows(round) ? "不记得" : "对的")));
    }
  });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '周五交，因为他要出差', 5)").run();
  return { n, pilot, leadWakes, fixWakes, papers };
}

test("T7: a failed exam sends the fixes into the same specialist session; the lead reviews only the new diff; the re-exam asks the failed question, the lead's new one and passed ones the round touched; ids survive", { timeout: 30_000 }, async () => {
  const f = fixNight({ maxFixRounds: 2, knows: (round) => round >= 2 });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  // 同一个会话：只开了一个，第二条消息就是退回修改
  const spec = f.n.driver.sessions.filter((s) => s.id.startsWith("sleep-"));
  assert.deepEqual(spec.map((s) => s.id), [`sleep-${DAY1}-events-1`]);
  assert.equal(spec[0]!.sent.length, 2);
  const fix = f.fixWakes[0]!;
  for (const part of ["为什么周五交", "不记得", "c:7", "没写为什么", "stage_done"]) assert.ok(fix.includes(part), `${part}\n${fix}`);
  assert.ok(!fix.includes("周五交，因为他要出差"), "标准答案那句话不给它：给题、它答的、出处，它得自己回去看原话");
  assert.ok(f.leadWakes[2]!.includes(S.leadprompts.fix.noPaste));
  // 定了以后留着的会话关掉、不剩开着的会话
  assert.ok(spec[0]!.closed);
  assert.equal(f.n.hosts.sessions.size, 0);
  assert.ok(!fix.includes("我是谁"), "过了的题不带回去");
  // 领导第 2 次看：只有这一轮新改的，说了是改过以后
  const review2 = f.leadWakes[2]!;
  assert.ok(review2.includes("第 2 次交") && review2.includes("+ 第 2 轮补的：因为他要出差") && !review2.includes("+ 今天定了周五交"), review2);
  assert.ok(review2.includes(S.leadprompts.fix.roundNote(S.leadprompts.fix.noPaste)));
  assert.ok(!review2.includes("【新建事件】"), "上一轮写进事件库的不再列");
  assert.equal(f.n.files.get(`sleep/${DAY1}/flow/lead/events.2.diff`)!.includes("今天定了周五交\n+ 第 2 轮"), false);
  // 重考：没过的那道、领导新出的、这一轮碰过的（a.md 上的 keep）；没碰过又过了的（SOUL 上的）不再考
  const paper2 = f.papers[`exam-${DAY1}-events-1-r2-after-searchable`]!;
  assert.ok(paper2.includes("为什么周五交") && paper2.includes("第 2 轮新出的题") && paper2.includes("a 上原来记着什么") && !paper2.includes("我是谁"), paper2);
  // 第 1 轮建的编号还在：批没撤、一夜只提交一次；整理前的事件库只拷了一次
  assert.ok(f.n.m.store.event("e0001"));
  assert.equal(f.n.m.store.batchState(`sleep:${DAY1}/events/1`), "committed");
  assert.equal(f.n.logs.filter((r) => r.msg === "sleep: event store copied for the before exam").length, 1);
  // 记账：一轮一行；退回去改的那一轮 lead:fix
  const rows = stageRows(f.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rows.map((r) => [r.attempt, r.status, r.decision]), [[1, "redo", "lead:fix"], [2, "passed", "lead:pass"]]);
  assert.match(rows[0]!.verdict, /得分率/);
  let sum = 0;
  for (const r of rows) { const c = JSON.parse(r.cost!) as Record<string, number>; assert.ok(c.do! > 0 && c.lead! > 0 && c.exam! > 0, r.cost!); assert.equal(c.do, r.units); sum += c.do! + c.lead! + c.exam!; }
  assert.ok(Math.abs(sum - f.n.budget.spent) < 1e-6, `${sum} vs ${f.n.budget.spent}`);
  assert.deepEqual(rows.map((r) => r.questions), [3, 3]);
  // 每一轮各有自己的调用次数（上限 4：两轮各 3 次，合起来 6 次也不算超）
  assert.ok(!rows.some((r) => /上限/.test(r.verdict)));
  // 题：过了的都生效（两轮出的）
  assert.deepEqual([1, 2, 3, 4].map((i) => f.n.hosts.bank.get(`q:${DAY1}/events/${i}`)!.status), ["active", "active", "active", "active"]);
  const leadFile = JSON.parse(f.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { round: number; counts: Record<string, number> };
  assert.deepEqual([leadFile.round, leadFile.counts], [2, { keep: 2, new: 2, missed: 0, continuity: 0 }]);
  // 改的那一轮也记缓存那一行：第 2 轮、之前闲了多久
  const turn2 = f.n.logs.find((r) => r.msg === "sleep: turn cache" && r.id === `sleep-${DAY1}-events-1` && r.turn === 2)!;
  assert.ok(turn2 && (turn2.idleSec as number) > 0, JSON.stringify(turn2));
});

test("T7: at most team.maxFixRounds rounds — still failing after the last one, the specialist is dropped with everything from every round", { timeout: 30_000 }, async () => {
  const f = fixNight({ maxFixRounds: 1, knows: () => false });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual([res.landed, res.deferredDays], [[], [DAY1]]);
  const spec = f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!;
  assert.equal(spec.sent.length, 2, "第 3 轮没开");
  assert.ok(spec.closed);
  const rows = stageRows(f.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rows.map((r) => [r.attempt, r.status, r.decision]), [[1, "redo", "lead:fix"], [2, "deferred", "lead:drop"]]);
  assert.equal(f.n.files.get(`sleep/${DAY1}/proposed/memory/a.md`), undefined);
  assert.equal(f.n.m.store.event("e0001"), undefined);
  assert.ok([1, 2, 3, 4].every((i) => f.n.hosts.bank.get(`q:${DAY1}/events/${i}`)!.status === "dropped"));
  // 一轮都不许改：照旧一次就丢
  const none = fixNight({ maxFixRounds: 0, knows: () => false });
  await none.n.run();
  await none.pilot.stop();
  assert.deepEqual(stageRows(none.n.db).filter((r) => r.stage === "events").map((r) => [r.attempt, r.status, r.decision]), [[1, "deferred", "lead:drop"]]);
});

test("T7: a dead kernel session is a drop with a note — never a fresh session with no memory of the work; a round that runs out of time or calls is dropped too", { timeout: 30_000 }, async () => {
  // 领导看第 1 轮的时候专员的内核会话死了
  const dead = fixNight({ maxFixRounds: 2, knows: () => false, onLead: (_s, text) => { if (text.includes("lead_verdict")) dead.n.driver.sessions.find((x) => x.id === `sleep-${DAY1}-events-1`)!.closed = true; } });
  const res = await dead.n.run();
  await dead.pilot.stop();
  assert.deepEqual(res.landed, []);
  assert.equal(dead.n.driver.sessions.filter((s) => s.id === `sleep-${DAY1}-events-1`).length, 1, "没有悄悄重开一个");
  assert.equal(dead.fixWakes.length, 0);
  const rows = stageRows(dead.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rows.map((r) => [r.status, r.decision]), [["deferred", "lead:drop"]]);
  assert.ok(dead.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.FIX_SESSION_GONE("事件")));

  // 改的那一轮到点了还没交
  const slow = fixNight({ maxFixRounds: 2, knows: () => false, onFix: async (s) => {
    const t = slow.n.timers.filter((x) => x.ms === 7 * 60_000).at(-1)!;   // 这一轮的时限（段的 budget.minutes = 7）
    t.fn();
    await sleepMs(5);
    assert.ok(s.closed);
  } });
  await slow.n.run();
  await slow.pilot.stop();
  const srows = stageRows(slow.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(srows.map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "rule:drop"]]);
  assert.match(srows[1]!.verdict, /超时了/);

  // 改的那一轮调用次数超了它自己的上限（4 次）
  const busy = fixNight({ maxFixRounds: 2, knows: () => false, onFix: async (s) => { await s.play({ say: "还在改", total: { ...USE, calls: 5 } }); } });
  await busy.n.run();
  await busy.pilot.stop();
  const brows = stageRows(busy.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(brows.map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "rule:drop"]]);
  assert.match(brows[1]!.verdict, /调用次数到了上限/);
});

test("T7: an abort while the lead is looking closes the held specialist session and nothing lands", { timeout: 30_000 }, async () => {
  const f = fixNight({ maxFixRounds: 2, knows: () => false, onLead: (s, text) => { if (text.includes("lead_review")) { f.n.runner.abort("停机"); s.closed = true; } } });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual([res.landed, res.stoppedBy], [[], "aborted"]);
  assert.ok(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.closed, "留着的专员会话关了");
  assert.equal(f.n.m.store.event("e0001"), undefined);
  assert.equal(f.n.files.get(`sleep/${DAY1}/proposed/memory/a.md`), undefined);
  assert.equal(f.n.hosts.sessions.size, 0);
});

test("T7: StageSession.alive — true until the kernel session dies; a silent reopen does not make it alive again", async () => {
  const driver = new FakeDriver();
  const cfg = loadConfig({ workspace: "/tmp/hh-lead-ws", stateDir: mkdtempSync(join(tmpdir(), "hh-lead-alive-")) });
  const s = openStageSession({
    driver, cwd: "/tmp/hh-lead-ws", permissionMode: cfg.kernel.permissionMode, env: {}, claudeExecutable: null,
    render: { maxItemChars: 1000, timezone: "UTC" }, now: () => 1, later: () => () => {}, log: new Logger("t", () => {}),
  }, { id: "sleep-x", model: "m", prefix: "P", tools: [], allowed: new Set(), proposedRoot: "/tmp/hh-lead-ws/sleep/d/proposed", writes: [], bash: [], workspace: "/tmp/hh-lead-ws", timeoutMs: 1000 });
  assert.equal(s.alive(), true, "还没叫醒过也算活着");
  s.wake("第一条");
  assert.equal(s.alive(), true);
  driver.sessions[0]!.closed = true;
  assert.equal(s.alive(), false);
  s.wake("第二条");   // Region 会悄悄重开一个空的会话
  assert.equal(driver.sessions.length, 2);
  assert.equal(s.alive(), false, "重开的那个不记得前面做的：不算活着");
  await s.close();
  assert.equal(s.alive(), false);
});

// ---------- 固定要问的题单独判 ----------

test("continuity is judged on its own: each one must be right after the retake, whatever the tolerance; it neither lifts nor lowers the new / missed rate", async () => {
  const lax = parseTeam({ exam: { baseBlocks: ["SOUL.md"] } }, { tolerance: 0 });
  // 得分率的线是 0（new / missed 怎么都过）：固定要问的题错一道照样没过
  const wrong = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const a = await consist(wrong, [cq(1, { layer: "resident" }), cq(2), cq(3)], { 1: "continuity", 2: "new", 3: "missed" }, { flow: lax });
  assert.equal(a.r.pass, false);
  assert.deepEqual(a.r.failed.map((f) => [f.id.slice(-1), f.probe, f.why]), [["1", "continuity", LP.CONSIST.continuity]]);
  assert.deepEqual(sitIds(wrong), ["after-resident", "after-searchable", "grade-all", "retake-resident"], "重考一次，不考整理前");
  // 只答对一部分也不算
  const half = consistHost((_sid, qid) => (qid.endsWith("/1") ? "半对" : "对的"));
  assert.equal((await consist(half, [cq(1, { layer: "resident" })], { 1: "continuity" }, { flow: lax })).r.pass, false);
  // 重考答对了就算对
  const noisy = consistHost((sid, qid) => (qid.endsWith("/1") && sid.includes("-after-") ? "不记得" : "对的"));
  assert.equal((await consist(noisy, [cq(1, { layer: "resident" })], { 1: "continuity" }, { flow: lax })).r.pass, true);
  // 不进得分率：两道固定的都对、一道 new 错了，new 的得分率是 0（不是 2/3）
  const strict = consistHost((_sid, qid) => (qid.endsWith("/3") ? "不记得" : "对的"));
  const b = await consist(strict, [cq(1, { layer: "resident" }), cq(2, { layer: "resident" }), cq(3)], { 1: "continuity", 2: "continuity", 3: "new" }, { flow: parseTeam({ exam: { baseBlocks: ["SOUL.md"] } }, { tolerance: 0.6 }) });
  assert.deepEqual(b.r.failed.map((f) => [f.id.slice(-1), f.why]), [["3", LP.CONSIST.belowRate(0, 0.6)]]);
  // 反过来：固定的错了，new 的得分率不受它拖累，只列固定的那道
  const c = await consist(consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的")), [cq(1, { layer: "resident" }), cq(2)], { 1: "continuity", 2: "new" }, { flow: parseTeam({ exam: { baseBlocks: ["SOUL.md"] } }, { tolerance: 1 }) });
  assert.deepEqual(c.r.failed.map((f) => f.probe), ["continuity"]);
});

// ---------- 欠着的补上（T7b，最小的一版） ----------

test("owed make-up: a specialist with an owed earlier day is told to redo that day's part first; the lead is told too; passing settles the owed row, a drop leaves it", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  for (const passes of [true, false]) {
    const n = teamRig({ stages });
    Ledger.owe(n.db, "2026-11-02", "people", ["那天没过"], 1);
    Ledger.owe(n.db, "2026-11-03", "people", ["那天也没过"], 2);
    Ledger.owe(n.db, DAY1, "people", ["今天的不算欠着的"], 3);
    Ledger.owe(n.db, "2026-11-03", "other", ["别的段的"], 4);
    const p = playNight(n, { ans: (_sid, _qid, q) => (!passes && q.includes("people今天定了什么") ? "不记得" : "对的") });
    const res = await n.run();
    await p.pilot.stop();
    assert.deepEqual(p.pilot.errors, []);
    assert.deepEqual(res.landed, [DAY1]);
    const line = LP.OWED_FIRST(["2026-11-02", "2026-11-03"]);
    assert.ok(p.stageWakes.people!.includes(line) && p.stageWakes.people!.indexOf(line) < p.stageWakes.people!.indexOf("人的专员的页"), "欠着的那几天写在最前面");
    assert.ok(line.includes("sleep/2026-11-02/") && line.includes("sleep/2026-11-03/"));
    assert.ok(!p.stageWakes.events!.includes("欠着"));
    assert.ok(p.leadWakes[2]!.includes(LP.OWED_HINT(["2026-11-02", "2026-11-03"])), "领导看它的改动时也知道");
    assert.ok(!p.leadWakes[0]!.includes("2026-11-02"));
    const left = Ledger.owed(n.db).map((r) => `${r.day}/${r.stage}`);
    // 过了：以前欠的两天划掉（今天这一行本来就在，别的段的不动）；没过：都留着
    assert.deepEqual(left, passes ? [`2026-11-03/other`, `${DAY1}/people`] : ["2026-11-02/people", "2026-11-03/other", "2026-11-03/people", `${DAY1}/people`]);
  }
});

// ---------- T7 评审修正轮 ----------

test("T7 review I1: a lead 'no' on a passing exam, then a fix round with no new question — the passed questions the round could affect are sat again; the specialist is not dropped as 'not examined'", { timeout: 30_000 }, async () => {
  // 考试第 1 轮就过了，领导说不行；第 2 轮领导没出新题
  const f = fixNight({ maxFixRounds: 2, knows: () => true, leadSays: (round) => round >= 2, round2Questions: [] });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  const rows = stageRows(f.n.db).filter((r) => r.stage === "events") as Array<ReturnType<typeof stageRows>[number] & { examined: number | null }>;
  assert.deepEqual(rows.map((r) => [r.attempt, r.status, r.decision, r.examined]), [[1, "redo", "lead:fix", 1], [2, "passed", "lead:pass", 1]]);
  // 第 2 轮：没有没过的题、没有新题——这一轮碰到的（a.md 上的）过了的题再考一遍
  const paper2 = f.papers[`exam-${DAY1}-events-1-r2-after-searchable`]!;
  assert.ok(paper2.includes("a 上原来记着什么") && paper2.includes("为什么周五交") && !paper2.includes("我是谁"), paper2);
  assert.ok(f.fixWakes[0]!.includes("写法不对；该怎么改：照原话改"));
});

test("T7 review I1: a fix round that changes nothing — the previous exam stands, nothing is sat again, and the lead rules on that with a note", { timeout: 30_000 }, async () => {
  const f = fixNight({ maxFixRounds: 1, knows: () => true, leadSays: (round) => round >= 2, fixChanges: false });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.ok(!Object.keys(f.papers).some((id) => id.includes("-r2-")), "没改东西：不再考");
  assert.equal(f.leadWakes.length, 3, "第 2 轮不再叫领导看改动（没有改动），只问它定不定");
  assert.ok(f.leadWakes[2]!.includes(S.leadprompts.fix.nothingChanged) && f.leadWakes[2]!.includes("lead_verdict"));
  const rows = stageRows(f.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rows.map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["passed", "lead:pass"]]);
  // 上一轮没过的考试、这一轮什么都没改：还是没过
  const bad = fixNight({ maxFixRounds: 1, knows: () => false, fixChanges: false });
  await bad.n.run();
  await bad.pilot.stop();
  assert.deepEqual(stageRows(bad.n.db).filter((r) => r.stage === "events").map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "lead:drop"]]);
});

test("T7 review I2: what a fix round touched comes from its real op rows and file diff — an unlisted retire in the fix re-examines the passed question on that event", { timeout: 30_000 }, async () => {
  const f = fixNight({
    maxFixRounds: 2, knows: (round) => round >= 2,
    round2Questions: [], round1Extra: [tq("以前那件事还记得吗", "keep", { sources: ["e0001"], tags: { who: [], events: ["e0001"], files: [], lessons: [] } })],
    // 第 2 轮：悄悄把以前的一件事退休了，交差时不列
    onFix: async (s) => { await s.spec.tools.find((t) => t.name === "mem_retire")!.handler({ id: "e0001", reason: "顺手" }); },
  });
  // 以前就有的一件事，领导第 1 轮在它上面出了一道 keep（过了）
  const old = f.n.m.store.createEvent({ title: "以前的事", summary: "x", gist: "x", importance: 2 }, "seed");
  f.n.m.store.commitBatch("seed");
  assert.equal(old.id, "e0001");
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  const paper2 = f.papers[`exam-${DAY1}-events-1-r2-after-searchable`]!;
  assert.ok(paper2.includes("以前那件事还记得吗"), `没列进 changes 的退休也要重考挂在那件事上的题\n${paper2}`);
});

test("T7 review: the before state of every round is the one from before the specialist started; a hand-in from a silently reopened session is refused; an abort during a fix round ends it; each round counts its own calls", { timeout: 30_000 }, async () => {
  // 第 2 轮 keep 题答不出：整理前那一场看到的是专员动手以前的 a.md（工作区里的原文），不是它第 1 轮写的
  const lost = { n: teamRig({ stages: FIX_STAGES, team: { maxFixRounds: 1 } }) };
  lost.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '周五交，因为他要出差', 5)").run();
  const beforePapers: string[] = [];
  const pilot = autopilot(lost.n.driver, async (s, text, nth) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      if (text.includes("你还没调 stage_done")) return;
      if (nth === 1) n1(lost.n);
      else lost.n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n第 2 轮补的\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: `第 ${nth} 次`, changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      const second = s.sent.filter((x) => x.text.includes("lead_review")).length >= 2;
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [second ? tq("第二轮问的旧事", "keep") : tq("为什么周五交", "new", { sources: ["c:7"] })] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) {
      if (s.id.includes("-before-")) beforePapers.push(text);
      const second = s.id.includes("-r2-");
      await s.play(answerAll(text, (_qid, q) => (q.includes("为什么周五交") ? (second ? "对的" : "不记得") : q.includes("第二轮问的旧事") && !s.id.includes("-before-") ? "不记得" : "对的")));
    }
  });
  await lost.n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.equal(beforePapers.length, 1);
  assert.ok(beforePapers[0]!.includes("=== memory/a.md ===\n原来的一行\n") && !beforePapers[0]!.includes("今天定了周五交"), beforePapers[0]);
  assert.deepEqual(stageRows(lost.n.db).filter((r) => r.stage === "events").map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "lead:drop"]]);

  // 改的那一轮中间内核会话死了、Region 悄悄重开了一个：重开的那个交的不算
  const reopened = fixNight({ maxFixRounds: 2, knows: () => false, onFix: async (s) => {
    if (reopened.n.driver.sessions.filter((x) => x.id === s.id).length > 1) return;   // 重开的那个：照常往下交
    s.closed = true;   // 内核会话死了；这一轮结束时引擎催它，Region 发现死了就悄悄重开一个
    await s.play({ say: "想一下", total: USE });
  } });
  await reopened.n.run();
  await reopened.pilot.stop();
  assert.equal(reopened.n.driver.sessions.filter((x) => x.id === `sleep-${DAY1}-events-1`).length, 2, "Region 重开了一个");
  const rrows = stageRows(reopened.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rrows.map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "rule:drop"]]);
  assert.ok(rrows[1]!.verdict.includes(LP.FIX_SESSION_GONE("事件")));

  // 改的那一轮正做着的时候叫停：留着的会话关掉，这一夜收得了尾
  const stopped = fixNight({ maxFixRounds: 2, knows: () => false, onFix: (s) => { stopped.n.runner.abort("停机"); assert.ok(s.closed, "叫停就关了"); } });
  const sres = await stopped.n.run();
  await stopped.pilot.stop();
  assert.deepEqual([sres.landed, sres.stoppedBy], [[], "aborted"]);

  // 每一轮自己数调用次数（上限 4）：第 1 轮 3 次；第 2 轮头一轮 3 次没交（会话合计 6 次，这一轮自己才 3 次）
  const over = fixNight({ maxFixRounds: 2, knows: () => false, onFix: async (s) => { await s.play({ say: "想一下", total: USE }); } });
  await over.n.run();
  await over.pilot.stop();
  // 第 2 轮头一轮结束时这一轮才 3 次（合计 6 次）：不算超，只催收尾；交上来照收
  const orows = stageRows(over.n.db).filter((r) => r.stage === "events");
  assert.ok(!/调用次数到了上限/.test(orows[1]!.verdict), orows[1]!.verdict);
  assert.ok(over.n.driver.sessions.find((x) => x.id === `sleep-${DAY1}-events-1`)!.sent.some((x) => x.text === P.SLEEP_STAGE_CONTINUE), "这一轮才 3 次：只是催它接着做");
});
function n1(n: ReturnType<typeof teamRig>): void { n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n今天定了周五交\n"); }

test("T7 review I3: owed make-up is off in a replay; on a real night a pass settles only the owed days the hand-in says it made up", { timeout: 30_000 }, async () => {
  const stages = [
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["people"] },
  ];
  const night = async (replay: boolean, report: string) => {
    const n = teamRig({ stages, replay });
    Ledger.owe(n.db, "2026-11-02", "people", ["那天没过"], 1);
    Ledger.owe(n.db, "2026-11-03", "people", ["那天也没过"], 2);
    let wake = "";
    const pilot = autopilot(n.driver, async (s, text) => {
      if (s.id === `sleep-${DAY1}-people-1`) {
        wake = text;
        n.files.set(`sleep/${DAY1}/proposed/people/x.md`, "一行\n");
        await s.play({ tool: { name: "stage_done", args: { status: "done", report, changes: [] } }, total: USE });
      } else if (s.id.startsWith("lead-")) {
        if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("记着什么", "keep")] } }, total: USE });
        else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
      } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
      else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
    });
    const res = await n.run();
    await pilot.stop();
    assert.deepEqual(res.landed, [DAY1]);
    return { wake, left: Ledger.owed(n.db).map((r) => r.day) };
  };
  // 回放（只跑定死的一天）：不提欠着的、也不划
  const replay = await night(true, "做了今天的，也补了 2026-11-02");
  assert.ok(!replay.wake.includes("欠着"));
  assert.deepEqual(replay.left, ["2026-11-02", "2026-11-03"]);
  // 真的夜里：说了补哪天就划哪天
  const real = await night(false, "做了今天的；补了 2026-11-02 那天的");
  assert.ok(real.wake.includes(LP.OWED_FIRST(["2026-11-02", "2026-11-03"])) && real.wake.includes("report"));
  assert.deepEqual(real.left, ["2026-11-03"]);
  const none = await night(false, "只做了今天的");
  assert.deepEqual(none.left, ["2026-11-02", "2026-11-03"]);
});

test("T7 review minors: the tolerance rate in a fix round counts the questions already right; the proposal must not change between hand-in and commit; the spec key is hashed from the spec the kernel gets", { timeout: 30_000 }, async () => {
  // 得分率：前面答对、这一轮没再考的 new / missed 也算进去（3 道对的带过来，这一轮 1 对 1 错 → 4/5 = 0.8 ≥ 0.75）
  const h = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const db = openDb(":memory:");
  const r = await consistencyExam({ host: h.host, bank: new Bank(db, () => 1), flow: CFLOW }, {
    day: DAY1, stage: CFLOW.stages[0]!, attempt: 1, round: 2, questions: [cq(1, { isNew: true }), cq(2, { isNew: true })],
    probes: new Map([[`q:${DAY1}/events/1`, "new"], [`q:${DAY1}/events/2`, "missed"]]), before: snapOf({}), after: snapOf({ "memory/a.md": "新" }), storeBefore: "live", carried: [1, 1, 1],
  });
  assert.equal(r.pass, true);
  assert.deepEqual(r.marks, { [`q:${DAY1}/events/1`]: "wrong", [`q:${DAY1}/events/2`]: "right" });
  const strict = await consistencyExam({ host: consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的")).host, bank: new Bank(db, () => 1), flow: CFLOW }, {
    day: DAY1, stage: CFLOW.stages[0]!, attempt: 1, round: 2, questions: [cq(1, { isNew: true }), cq(2, { isNew: true })],
    probes: new Map([[`q:${DAY1}/events/1`, "new"], [`q:${DAY1}/events/2`, "missed"]]), before: snapOf({}), after: snapOf({ "memory/a.md": "新" }), storeBefore: "live",
  });
  assert.equal(strict.pass, false, "不带前面的：1/2 不到线");

  // 交差以后、提交以前提案又变了：不提交
  const f = fixNight({ maxFixRounds: 0, knows: () => true, onLead: (_s, text) => { if (text.includes("lead_verdict")) f.n.files.set(`sleep/${DAY1}/proposed/memory/late.md`, "交差以后才写的\n"); } });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(res.landed, []);
  const row = stageRows(f.n.db).find((x) => x.stage === "events")!;
  assert.equal(row.status, "deferred");
  assert.ok(row.verdict.includes(LP.CHANGED_AFTER_HANDIN(["memory/late.md"])), row.verdict);
  assert.equal(f.n.files.get(`sleep/${DAY1}/proposed/memory/late.md`), undefined);

  // 记日志的那份哈希是照内核真拿到的 spec 算的（会话真开的时候记）
  const n = teamRig();
  const stage = n.hosts.stage.open({ id: `sleep-${DAY1}-events-1`, stage: n.flow.stages[0]!, day: DAY1, allowed: new Set(["stage_done"]) });
  assert.equal(n.logs.filter((x) => x.msg === "sleep: session spec").length, 0, "还没叫醒：内核会话还没开");
  stage.wake("开始");
  const line = n.logs.find((x) => x.msg === "sleep: session spec")!;
  assert.deepEqual(line.key, cacheKeyOf(n.driver.sessions[0]!.spec));
});

// ---------- 第 3 批 B5：部署的重启等回放跑完 ----------

test("B5: a deploy restart waits for a running replay — the gate sees a busy front while one runs and restarts once it is over", () => {
  const st = mkdtempSync(join(tmpdir(), "hh-lead-restart-"));
  mkdirSync(join(st, "repair"), { recursive: true });
  writeDeployed(st, { commit: "X", prev: "W", t: "t", by: "test" });
  writeFileSync(join(st, "repair", "restart-request.json"), JSON.stringify({ commit: "X", t: "t" }));
  const DEFAULT_RULES = loadRules(join(import.meta.dirname, ".."));
  const gate = new RestartGate({ stateDir: st, rules: DEFAULT_RULES, tz: "Australia/Melbourne", now: () => Date.UTC(2026, 10, 1, 23, 0) });
  const idle = { alertness: "awake", turning: false, focusSlot: null, frontIdle: true, regions: [{ id: "main", open: true, busy: false, contextTokens: 0, generation: 0, sessionId: null }] } as unknown as BrainStatus;
  // 回放在跑：怎么 tick 都不重启
  for (let i = 0; i < 10; i++) assert.equal(gate.tick(restartStatus(idle, true)), null);
  assert.ok(existsSync(join(st, "repair", "restart-request.json")), "请求还在，等着");
  // 回放完了：照旧连着几次平静就重启
  const ticks = Array.from({ length: DEFAULT_RULES.restart.calmChecks }, () => gate.tick(restartStatus(idle, false)));
  assert.equal(ticks.at(-1), "restart");
  assert.ok(ticks.slice(0, -1).every((x) => x === null), "回放那会儿不算平静，重新数");
  assert.equal(restartStatus(idle, false), idle, "没有回放：原样");
});

// ---------- 第 3 批 B1：固定要问的题——一个要点必须对，细节只记比例；回放里先把醒来的样子拼出来再考 ----------

test("B1 config: replayFinish is a list of commands, absent unless written; with continuity questions, continuityAt must be the last specialist; a continuity question needs its one must-have", () => {
  const f = parseTeam({ replayFinish: [["python3", "scripts/build.py", "{day}"]] });
  assert.deepEqual(f.replayFinish, [["python3", "scripts/build.py", "{day}"]]);
  assert.ok(!("replayFinish" in parseTeam()));
  assert.ok(!("replayFinish" in parseFlow({ engine: "flow", stages: STAGES }, known)));
  assert.ok(problemsOf(() => parseTeam({ replayFinish: [[]] })).some((p) => /replayFinish/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ replayFinish: "x" })).some((p) => /replayFinish/.test(p)));
  // 固定要问的题在最后一个专员那里问（那时候今晚的改动才全）
  assert.ok(problemsOf(() => parseTeam({}, { continuity: ["问"], continuityAt: "events" })).some((p) => /continuityAt/.test(p) && /最后/.test(p)));
  assert.equal(parseTeam({}, { continuity: ["问"], continuityAt: "people" }).team!.continuityAt, "people");
  assert.equal(parseTeam({}, { continuityAt: "events" }).team!.continuityAt, "events", "没有固定要问的题：不管");
  // 题：continuity 要写 must（一件事）
  const yes = (): boolean => true;
  assert.equal(leadQuestionProblem(lq({ probe: "continuity", layer: "resident" }), yes), LP.LEAD_REFUSED.must);
  assert.equal(leadQuestionProblem(lq({ probe: "continuity", layer: "resident", must: "  " }), yes), LP.LEAD_REFUSED.must);
  assert.equal(leadQuestionProblem(lq({ probe: "continuity", layer: "resident", must: "睡前在跟他说周五的事", extras: ["说到一半", "他先睡了"] }), yes), null);
  assert.equal(leadQuestionProblem(lq({ probe: "new" }), yes), null, "别的题不用写");
});

test("B1 continuityExam: the must-have decides (right after one retake, partial is not enough); extras only give a ratio; the sitting uses the opening it is given", async () => {
  const flow = parseTeam({ exam: { baseBlocks: ["SOUL.md"] } });
  const qs = [
    { ...cq(1, { layer: "resident", q: "睡前最后在做什么", gold: "在跟他说周五的事" }), must: "在跟他说周五的事", extras: ["说到一半", "他先睡了"] },
    { ...cq(2, { layer: "resident", q: "最想接着做什么", gold: "把那封信写完" }), must: "把那封信写完", extras: [] },
  ];
  const run = (h: ReturnType<typeof consistHost>) => continuityExam({ host: h.host, bank: new Bank(openDb(":memory:"), () => 1), flow }, { day: DAY1, stage: flow.stages[1]!, attempt: 1, round: 1, questions: qs, opening: "醒来的样子", injection: "注入" });
  // 都答对：过；细节按判分来（这个假判分的看「她的回答」，都算对）
  const ok = consistHost(() => "对的");
  const a = await run(ok);
  assert.deepEqual([a.examined, a.pass, a.failed.length, a.must, a.extras], [true, true, 0, { right: 2, total: 2 }, { right: 2, total: 2 }]);
  assert.deepEqual(ok.sits.map((x) => x.id), [`exam-${DAY1}-people-1-continuity-resident`, `exam-${DAY1}-people-1-continuity-grade-all`]);
  assert.equal(ok.sits[0]!.opening, "醒来的样子");
  assert.ok(ok.sits[0]!.wake.includes("注入") && ok.sits[0]!.wake.includes("不能查"));
  // 判分的卷子上：要点一条、每个细节一条（标准答案分别是 must 和那条细节）
  const paper = ok.sits[1]!.wake;
  for (const part of ["标准答案：在跟他说周五的事", "标准答案：说到一半", "标准答案：他先睡了", "标准答案：把那封信写完"]) assert.ok(paper.includes(part), part);
  // 要点错了：重考一次还错 → 没过，列出那一道；细节不影响过不过
  const wrong = consistHost((_sid, qid) => (qid.endsWith("/1") ? "不记得" : "对的"));
  const b = await run(wrong);
  assert.equal(b.pass, false);
  assert.deepEqual(b.failed.map((f) => [f.id.slice(-1), f.q, f.must, f.answer]), [["1", "睡前最后在做什么", "在跟他说周五的事", "不记得"]]);
  assert.deepEqual(wrong.sits.map((x) => x.id.replace(`exam-${DAY1}-people-1-continuity-`, "")), ["resident", "grade-all", "retake-resident"]);
  assert.deepEqual([b.must, b.extras], [{ right: 1, total: 2 }, { right: 0, total: 2 }]);
  // 重考答对就算对；只答对一部分不算
  const noisy = consistHost((sid, qid) => (qid.endsWith("/1") && !sid.includes("retake") ? "不记得" : "对的"));
  assert.equal((await run(noisy)).pass, true);
  const half = consistHost((_sid, qid) => (qid.endsWith("/1") ? "半对" : "对的"));
  assert.equal((await run(half)).pass, false);
  // 考生两次都没交：没考成，不算过
  const dead = consistHost(() => "对的", { dead: /continuity-resident/ });
  const d = await run(dead);
  assert.deepEqual([d.examined, d.pass], [false, false]);
});

const CONT_STAGES = [
  { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
  { id: "self", title: "自己", kind: "agent", skill: "people.md", required: true, tools: ["recall"], material: ["dialogue"], writes: ["**"] },
  { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["self"] },
];
/** 两个专员，固定要问的题在最后一个（self）那里：它自己的题都答对，固定的题答不答得出看 knows(第几轮) */
function contNight(o: { knows: (round: number) => boolean; selfFile?: string; selfLayer?: string; must?: string; verdict?: (text: string) => Record<string, unknown>; ans?: (sid: string) => string | undefined; maxFixRounds?: number; replay?: boolean; flow?: Record<string, unknown>; onRun?: (args: string[], files: Map<string, string>) => void | number }) {
  const n = teamRig({ stages: CONT_STAGES, team: { continuity: ["睡前最后在做什么"], maxFixRounds: o.maxFixRounds ?? 2 }, ...(o.replay ? { replay: true } : {}), ...(o.flow ? { flow: o.flow } : {}), ...(o.onRun ? { onRun: o.onRun } : {}) });
  const leadWakes: string[] = [];
  const selfWakes: string[] = [];
  const papers: Record<string, string> = {};
  let round = 0;
  const pilot = autopilot(n.driver, async (s, text, nth) => {
    if (s.id.startsWith("sleep-")) {
      if (text.includes("你还没调 stage_done")) return;
      const self = s.id.includes("-self-");
      if (self) { round = nth; selfWakes.push(text); }
      n.files.set(`sleep/${DAY1}/proposed/${self ? o.selfFile ?? "SOUL.md" : "memory/a.md"}`, `${self ? "我是谁" : "原来的一行"}\n第 ${nth} 次写的\n`);
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: `第 ${nth} 次交`, changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      leadWakes.push(text);
      if (text.includes("lead_review")) {
        const fixed = text.includes("睡前最后在做什么") ? [tq("睡前最后在做什么", "continuity", { layer: "resident", sources: ["c:7"], must: o.must ?? "在跟他说周五的事", extras: ["说到一半", "他先睡了"] })] : [];
        await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq(`${s.sent.length} 记着什么`, "keep", { sources: ["SOUL.md:1"], layer: o.selfLayer ?? "searchable", tags: { who: [], events: [], files: ["SOUL.md", ...(o.selfFile ? [o.selfFile] : [])], lessons: [] } }), ...fixed] } }, total: USE });
      } else await s.play({ tool: { name: "lead_verdict", args: o.verdict?.(text) ?? { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) {
      papers[s.id] = text;
      await s.play(answerAll(text, (_qid, q) => o.ans?.(s.id) ?? (q.includes("睡前最后在做什么") && !o.knows(round) ? "不记得" : "对的")));
    }
  });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '睡前在说周五的事', 5)").run();
  return { n, pilot, leadWakes, selfWakes, papers };
}

test("B1 night: continuity is sat on its own after the owning specialist's exam passes; a wrong must-have sends that specialist back in its session; the row and the report carry the ratios", { timeout: 30_000 }, async () => {
  const f = contNight({ knows: (round) => round >= 2 });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  // 领导的简报：一个要点、细节另算
  const brief = f.leadWakes.find((t) => t.includes("睡前最后在做什么"))!;
  assert.ok(brief.includes("must") && brief.includes("extras") && brief.includes("一件事"), brief);
  // 它自己的卷子上没有固定的题；固定的题单独一场（常驻）
  const own = Object.entries(f.papers).filter(([id]) => id.includes("-self-") && !id.includes("continuity"));
  assert.ok(own.length > 0 && own.every(([, t]) => !t.includes("睡前最后在做什么")));
  const sat = Object.keys(f.papers).filter((id) => id.includes("continuity")).map((id) => id.replace(`exam-${DAY1}-self-1-`, ""));
  assert.deepEqual(sat, ["continuity-resident", "continuity-retake-resident", "r2-continuity-resident"]);
  // 要点错了：发回同一个会话，给题、它答的、出处，不给标准答案
  assert.equal(f.selfWakes.length, 2);
  for (const part of ["睡前最后在做什么", "不记得", "c:7"]) assert.ok(f.selfWakes[1]!.includes(part), part);
  assert.ok(!f.selfWakes[1]!.includes("在跟他说周五的事"));
  const rows = stageRows(f.n.db).filter((r) => r.stage === "self");
  assert.deepEqual(rows.map((r) => [r.attempt, r.status, r.decision]), [[1, "redo", "rule:fix"], [2, "passed", "lead:pass"]]);
  assert.match(rows[0]!.verdict, /固定要问的题/);
  assert.match(rows[1]!.verdict, /固定要问的题：要点 1\/1，细节 2\/2/);
  assert.ok(f.n.files.get(`sleep/${DAY1}/report.md`)!.includes("固定要问的题：要点 1/1，细节 2/2"));
  // 还是不进题库
  assert.ok(f.n.hosts.bank.pending(DAY1).every((q) => !q.q.includes("睡前最后")));
  const all = [1, 2, 3, 4].map((i) => f.n.hosts.bank.get(`q:${DAY1}/self/${i}`)).filter((q) => q && q.q.includes("睡前最后"));
  assert.ok(all.length === 1 && all[0]!.status === "dropped");
  // 轮数用完还错：这个专员没过（required：这一天不落地）
  const bad = contNight({ knows: () => false, maxFixRounds: 1 });
  const bres = await bad.n.run();
  await bad.pilot.stop();
  assert.deepEqual(bres.landed, []);
  assert.deepEqual(stageRows(bad.n.db).filter((r) => r.stage === "self").map((r) => [r.status, r.decision]), [["redo", "rule:fix"], ["deferred", "rule:drop"]]);
});

test("B1 replay: the finish-side build runs in the replay workspace after the last specialist and before the continuity sitting, and the sitting opens on the rebuilt files; a real night does not run it; a build that fails is not a pass", { timeout: 30_000 }, async () => {
  const order: string[] = [];
  const build = { replayFinish: [["python3", "scripts/build.py", "{day}"]] };
  const onRun = (args: string[], files: Map<string, string>): void => {
    if (args[0] !== "scripts/build.py") return;
    order.push(`build ${args[1]}`);
    files.set("SOUL.md", "我是谁\n（落地时拼的）睡前最后那一段：在跟他说周五的事\n");
  };
  const f = contNight({ knows: () => true, replay: true, flow: build, onRun });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.deepEqual(order, [`build ${DAY1}`]);
  const ids = f.n.driver.sessions.map((s) => s.id);
  const sitting = f.n.driver.sessions.find((s) => s.id === `exam-${DAY1}-self-1-continuity-resident`)!;
  assert.ok(sitting.spec.systemAppend.includes("（落地时拼的）睡前最后那一段：在跟他说周五的事"), "考生看到的是拼出来以后的样子");
  assert.ok(sitting.spec.systemAppend.startsWith("这是你醒着的时候的样子"));
  // 先拼、再考；拼在最后一个专员自己的考试之后
  assert.ok(f.n.runs.findIndex((r) => r[0] === "scripts/build.py") < f.n.runs.findIndex((r) => r[0] === "scripts/finish.py"));
  assert.ok(ids.indexOf(`exam-${DAY1}-self-1-after-searchable`) < ids.indexOf(`exam-${DAY1}-self-1-continuity-resident`));
  // 领导、专员的开头不受它影响（一天里不变）
  assert.ok(!f.n.driver.sessions.find((s) => s.id === `lead-${DAY1}-self`)!.spec.systemAppend.includes("落地时拼的"));

  // 真的夜里：不跑这几条命令，考生看的是提案里的样子
  const real = contNight({ knows: () => true, flow: build, onRun });
  await real.n.run();
  await real.pilot.stop();
  assert.ok(!real.n.runs.some((r) => r[0] === "scripts/build.py"));
  const realSit = real.n.driver.sessions.find((s) => s.id === `exam-${DAY1}-self-1-continuity-resident`)!;
  assert.ok(realSit.spec.systemAppend.includes("第 1 次写的") && !realSit.spec.systemAppend.includes("落地时拼的"), "今晚的提案（self 改了 SOUL.md）算进去");

  // 回放里拼不出来：不考、不算过
  const broken = contNight({ knows: () => true, replay: true, flow: build, onRun: (args) => (args[0] === "scripts/build.py" ? 3 : undefined) });
  const bres = await broken.n.run();
  await broken.pilot.stop();
  assert.deepEqual(bres.landed, []);
  const brow = stageRows(broken.n.db).filter((r) => r.stage === "self");
  assert.deepEqual(brow.map((r) => [r.status, r.decision]), [["deferred", "rule:drop"]]);
  assert.match(brow[0]!.verdict, /拼不出/);
  assert.ok(!broken.n.driver.sessions.some((x) => x.id.includes("continuity")));
});

// ---------- 第 3 批 B2：一道题连着两轮没过先问是题的毛病还是答的毛病；改的那几轮省一点 ----------

test("B2 stop-loss: a question that fails two rounds running is put to the lead — a faulty question is revised and sat again alone, and the specialist is not sent back for it", { timeout: 30_000 }, async () => {
  const QID = `q:${DAY1}/events/3`;
  const f = fixNight({
    maxFixRounds: 2, knows: () => false, round2Questions: [],
    // 第 2 轮领导说：是题的毛病，标准答案改成只问一件事
    verdict: (round, text) => (round >= 2 && text.includes(S.leadprompts.twice.head)
      ? { pass: false, fixes: [], faults: [{ id: QID, fault: "question", gold: "因为他要出差", why: "原来把两件事并成一句" }] }
      : { pass: true, fixes: [] }),
    ans: (sid) => (sid.includes("requiz") ? "对的" : undefined),
  });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  // 第 1 轮的定夺里不问这个；第 2 轮（同一道题又没过）才问，列出那道题和它两次怎么答的
  const verdicts = f.leadWakes.filter((t) => t.includes("lead_verdict"));
  assert.ok(!verdicts[0]!.includes(S.leadprompts.twice.head) && verdicts[1]!.includes(S.leadprompts.twice.head) && verdicts[1]!.includes(QID) && verdicts[1]!.includes("faults"), verdicts[1]);
  // 改了标准答案的那道单独再考一场；专员没有为它被发回去第 3 次
  const requiz = Object.keys(f.papers).filter((id) => id.includes("requiz"));
  assert.deepEqual(requiz, [`exam-${DAY1}-events-1-r2-requiz-after-searchable`]);
  assert.ok(f.papers[requiz[0]!]!.includes("为什么周五交") && !f.papers[requiz[0]!]!.includes("a 上原来记着什么"));
  assert.equal(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 2);
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "events").map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["passed", "lead:pass"]]);
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "因为他要出差");
  assert.ok(f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.QUESTION_REVISED({ q: "为什么周五交", from: "周五交，因为他要出差", to: "因为他要出差", answers: ["不记得", "不记得"], why: "原来把两件事并成一句" })));

  // 领导说是答的毛病：照旧发回去改
  const ans = fixNight({ maxFixRounds: 2, knows: () => false, round2Questions: [], verdict: (round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: QID, fault: "answer", why: "整理没写为什么" }] } : { pass: true, fixes: [] }) });
  await ans.n.run();
  await ans.pilot.stop();
  assert.equal(ans.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 3);
  assert.ok(!Object.keys(ans.papers).some((id) => id.includes("requiz")));
  // 改了题再考还是不对：不算过，照没过的走
  const still = fixNight({ maxFixRounds: 1, knows: () => false, round2Questions: [], ans: (sid) => (sid.includes("requiz") ? "不记得" : undefined), verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: true, fixes: [], faults: [{ id: QID, fault: "question", gold: "因为他要出差", why: "太长" }] } : { pass: true, fixes: [] }) });
  await still.n.run();
  await still.pilot.stop();
  assert.deepEqual(stageRows(still.n.db).filter((r) => r.stage === "events").map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["deferred", "lead:drop"]]);
  assert.ok(Object.keys(still.papers).some((id) => id.includes("requiz")), "单独再考了一场，没答对照样算没过");
});

test("B2 cost: the lead's copy of the diff is capped by team.diffCap with the full text on file; the grader opens on one line, not the persona; each session's opening size is recorded for compare.md", { timeout: 30_000 }, async () => {
  assert.equal(parseTeam({}, { diffCap: 5000 }).team!.diffCap, 5000);
  assert.ok(!("diffCap" in parseTeam().team!));
  assert.ok(problemsOf(() => parseTeam({}, { diffCap: 10 })).some((p) => /diffCap/.test(p)));
  const n = teamRig({ team: { diffCap: 600 } });
  const big = Array.from({ length: 400 }, (_, i) => `今天的第 ${i} 行`).join("\n");
  const leadWakes: string[] = [];
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id === `sleep-${DAY1}-events-1`) {
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, `原来的一行\n${big}\n`);
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "加了很多", changes: Array.from({ length: 60 }, (_, i) => ({ target: "memory/a.md", op: "add", before: "", after: `今天的第 ${i} 行`, evidence: ["c:1"], why: "说过" })) } }, total: USE, first: { input: 100, cacheRead: 0, cacheWrite: 50_000 } });
    } else if (s.id === `sleep-${DAY1}-people-1`) await s.play({ tool: { name: "stage_done", args: { status: "nothing", report: "没什么", changes: [] } }, total: USE });
    else if (s.id.startsWith("lead-")) {
      leadWakes.push(text);
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("原来记着什么", "keep")] } }, total: USE, first: { input: 10, cacheRead: 0, cacheWrite: 9000 } });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play({ ...gradeAll(text), first: { input: 5, cacheRead: 0, cacheWrite: 300 } });
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  // 领导那一份：文件 diff、它列的改动都照上限截，说了全文在哪、材料按题去翻
  const brief = leadWakes[0]!;
  assert.ok(brief.length < 4000, `简报 ${brief.length} 字`);
  assert.ok(brief.includes(`sleep/${DAY1}/flow/lead/events.1.diff`) && brief.includes(LP.READ_ON_DEMAND(DAY1)));
  assert.ok(n.files.get(`sleep/${DAY1}/flow/lead/events.1.diff`)!.includes("今天的第 399 行"));
  const line = n.logs.find((r) => r.msg === "sleep: lead brief")!;
  assert.deepEqual([line.stage, line.round, typeof line.chars, (line.parts as Record<string, number>).files! <= 800], ["events", 1, "number", true]);
  // 判分的会话不带她的整份开头（考生的照旧带）
  const grader = n.driver.sessions.find((s) => s.id === `exam-${DAY1}-events-1-grade-all`)!;
  const sitter = n.driver.sessions.find((s) => s.id === `exam-${DAY1}-events-1-after-searchable`)!;
  assert.equal(grader.spec.systemAppend, S.leadprompts.graderOpening);
  assert.ok(sitter.spec.systemAppend.includes("我是谁"));
  // 每个会话开头多大（第一次调用的输入）：记到这一天的记录里，回放的 compare.md 列出来
  const sizes = JSON.parse(n.files.get(`sleep/${DAY1}/flow/lead/sessions.json`)!) as Array<{ id: string; role: string; opening: number | null }>;
  assert.deepEqual(sizes.find((x) => x.id === `sleep-${DAY1}-events-1`), { id: `sleep-${DAY1}-events-1`, role: "specialist", opening: 50_100 });
  assert.deepEqual(sizes.find((x) => x.id === `lead-${DAY1}-events`), { id: `lead-${DAY1}-events`, role: "lead", opening: 9010 });
  assert.equal(sizes.find((x) => x.id === `exam-${DAY1}-events-1-grade-all`)!.opening, 305);
  assert.equal(sizes.find((x) => x.id === `exam-${DAY1}-events-1-after-searchable`)!.opening, null, "内核没报第一次调用的：空着");
});

test("B2 stop-loss on continuity: a must-have missed two rounds running goes to the lead; a revised must-have is sat again alone and the specialist is not sent back a third time", { timeout: 30_000 }, async () => {
  const f = contNight({
    knows: () => false, maxFixRounds: 2, must: "在跟他说周五的事，他先睡了",
    verdict: (text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/self/2`, fault: "question", gold: "在跟他说周五的事", why: "原来的要点带了两件事" }] } : { pass: true, fixes: [] }),
    ans: (sid) => (sid.includes("requiz") ? "对的" : undefined),
  });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.equal(f.selfWakes.length, 2, "第 3 次没发回去");
  assert.ok(Object.keys(f.papers).includes(`exam-${DAY1}-self-1-r2-continuity-requiz-resident`));
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "self").map((r) => [r.status, r.decision]), [["redo", "rule:fix"], ["passed", "lead:pass"]]);
  assert.ok(f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.QUESTION_REVISED({ q: "睡前最后在做什么", from: "在跟他说周五的事，他先睡了", to: "在跟他说周五的事", answers: ["不记得", "不记得"], why: "原来的要点带了两件事" })));
  assert.ok(f.leadWakes.some((t) => t.includes(S.leadprompts.twice.head) && t.includes("在跟他说周五的事")));
});

// ---------- 第 3 批 B3：该管的文件没动要说一声 ----------

test("B3 duty files: a hand-in that leaves a duty file untouched without saying why is bounced once in the session; the lead's brief lists what was left and the stated reason", { timeout: 30_000 }, async () => {
  const flow = parseTeam({ stages: [agent("events", { writes: ["**"], duty: ["notes/todo.md", "skills/**"] }), script("finish", ["finish"], { after: ["events"] })] });
  assert.deepEqual(flow.stages[0]!.duty, ["notes/todo.md", "skills/**"]);
  assert.ok(!("duty" in parseTeam().stages[0]!), "没写就没有这个键");
  assert.ok(problemsOf(() => parseTeam({ stages: [agent("events", { writes: ["**"], duty: ["/abs"] }), script("finish", ["finish"], { after: ["events"] })] })).some((p) => /duty/.test(p)));
  assert.ok(problemsOf(() => parseTeam({ stages: [agent("events", { writes: ["**"], duty: "x" }), script("finish", ["finish"], { after: ["events"] })] })).some((p) => /duty/.test(p)));

  const stages = [
    { id: "learn", title: "学习", kind: "agent", skill: "events.md", required: true, tools: ["recall"], material: ["dialogue"], writes: ["**"], duty: ["notes/todo.md", "skills/**", "memory/a.md"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["learn"] },
  ];
  const night = async (second: string) => {
    const n = teamRig({ stages });
    const replies: string[] = [];
    let brief = "";
    const pilot = autopilot(n.driver, async (s, text) => {
      if (s.id === `sleep-${DAY1}-learn-1`) {
        if (text.includes("你还没调 stage_done")) return;
        n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n加了一行\n");
        const done = s.spec.tools.find((t) => t.name === "stage_done")!;
        // 第一次交：skills/ 下面动了一个，notes/todo.md 没动也没说
        n.files.set(`sleep/${DAY1}/proposed/skills/x/page.md`, "新的一页\n");
        replies.push(await done.handler({ status: "done", report: "改了 a.md 和一页技能", changes: [] }));
        await s.play({ tool: { name: "stage_done", args: { status: "done", report: second, changes: [] } }, total: USE });
      } else if (s.id.startsWith("lead-")) {
        if (text.includes("lead_review")) { brief = text; await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("记着什么", "keep")] } }, total: USE }); }
        else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
      } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
      else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
    });
    const res = await n.run();
    await pilot.stop();
    assert.deepEqual(pilot.errors, []);
    assert.deepEqual(res.landed, [DAY1]);
    return { replies, brief, n };
  };
  // 退回一次：点名没动的那个，说怎么办；补了一句理由就收，领导的简报里列出来
  const a = await night("改了 a.md 和一页技能。\n看过、不用改：notes/todo.md——今天没有新的待办");
  assert.equal(a.replies[0], LP.DUTY_BOUNCE(["notes/todo.md"]));
  assert.ok(!a.replies[0]!.includes("skills/**") && !a.replies[0]!.includes("memory/a.md"), "动过的不点名");
  assert.ok(a.brief.includes(LP.DUTY_LEFT("notes/todo.md", "看过、不用改：notes/todo.md——今天没有新的待办")), a.brief);
  // 只退回一次：第二次还不说，照收，简报里写它没说
  const b = await night("改了 a.md 和一页技能");
  assert.ok(b.brief.includes(LP.DUTY_LEFT("notes/todo.md", null)));
  assert.deepEqual(stageRows(b.n.db).filter((r) => r.stage === "learn").map((r) => r.status), ["passed"]);
});

// ---------- 第 3 批 B4：开头小一点 ----------

test("B4 openings: a material slice over team.sliceCap is named, not pasted; each part's size is in the session-spec line; a flow night pastes as before", { timeout: 30_000 }, async () => {
  assert.equal(parseTeam({}, { sliceCap: 5000 }).team!.sliceCap, 5000);
  assert.ok(!("sliceCap" in parseTeam().team!));
  assert.ok(problemsOf(() => parseTeam({}, { sliceCap: -1 })).some((p) => /sliceCap/.test(p)));
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["recall"], material: ["dialogue", "own-day", "tonight-events"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["events"] },
  ];
  const big = "很长的对话。".repeat(200);   // 1200 字
  const n = teamRig({ stages, team: { sliceCap: 1000 } });
  n.files.set(`sleep/${DAY1}/slices/dialogue.md`, big);
  n.files.set(`sleep/${DAY1}/slices/own-day.md`, "她自己的一天（短的）");
  const text = n.hosts.stage.materialText(DAY1, ["dialogue", "own-day", "tonight-events"], n.flow.stages[0]);
  assert.ok(text.includes(`【dialogue】\n${LP.SLICE_TOO_LONG(`sleep/${DAY1}/slices/dialogue.md`, 1200)}`), text.slice(0, 200));
  assert.ok(!text.includes("很长的对话。很长的对话。"));
  assert.ok(text.includes("【own-day】\n她自己的一天（短的）") && text.includes("【tonight-events】"));
  // 没写 sliceCap：默认 20000
  const dflt = teamRig({ stages });
  dflt.files.set(`sleep/${DAY1}/slices/dialogue.md`, "字".repeat(20_001));
  dflt.files.set(`sleep/${DAY1}/slices/own-day.md`, "字".repeat(20_000));
  const t2 = dflt.hosts.stage.materialText(DAY1, ["dialogue", "own-day"], dflt.flow.stages[0]);
  assert.ok(t2.includes(LP.SLICE_TOO_LONG(`sleep/${DAY1}/slices/dialogue.md`, 20_001)) && t2.includes("字".repeat(20_000)));
  // 还没切片（整份 input.md）也一样
  const whole = teamRig({ stages, team: { sliceCap: 1000 } });
  whole.files.set(`sleep/${DAY1}/input.md`, big);
  assert.equal(whole.hosts.stage.materialText(DAY1, ["dialogue"], whole.flow.stages[0]), LP.SLICE_TOO_LONG(`sleep/${DAY1}/input.md`, 1200));

  // 开头各部分多大：记在会话真开的那一行里
  const pilot = autopilot(n.driver, async (s) => { if (s.id.startsWith("sleep-")) await s.play({ tool: { name: "stage_done", args: { status: "nothing", report: "没什么", changes: [] } }, total: USE }); });
  await n.run();
  await pilot.stop();
  const line = n.logs.find((r) => r.msg === "sleep: session spec" && r.id === `sleep-${DAY1}-events-1`)!;
  const parts = line.parts as { core: number; common: number; page: number; slices: Record<string, number> };
  assert.deepEqual([parts.common, parts.page], ["COMMON".length, "事件专员的页".length]);
  assert.ok(parts.core > 0 && parts.core + 2 + parts.common === line.systemChars);
  assert.deepEqual(Object.keys(parts.slices), ["dialogue", "own-day", "tonight-events"]);
  assert.equal(parts.slices.dialogue, LP.SLICE_TOO_LONG(`sleep/${DAY1}/slices/dialogue.md`, 1200).length, "没贴进去的只算那一句");
  assert.equal(parts.slices["own-day"], "她自己的一天（短的）".length);

  // flow 的夜里：多长都照贴
  const flow = parseFlow({ engine: "flow", stages: [agent("events", { writes: ["memory/**"], material: ["dialogue"] }), script("finish", ["finish"], { after: ["events"] })] }, known);
  const files = new Map([[`sleep/${DAY1}/slices/dialogue.md`, "字".repeat(50_000)]]);
  const h = hostsFor(flow, { files });
  assert.ok(h.hosts.stage.materialText(DAY1, ["dialogue"], flow.stages[0]).includes("字".repeat(50_000)));
});

// ---------- 第 3 批 B1 补充：回放的子进程读回放的库；命令里能写那一夜睡下、醒来的时刻 ----------

test("B1 follow-up: replay commands take {sleepAt} and {wakeAt} besides {day}; sleep.dbEnv names point child processes at the replay's copy db", { timeout: 60_000 }, async () => {
  // 占位符：那一夜睡下的时刻（nightWindow 的 from）、她第二天一开始的那一刻（nextDayStart），ISO
  const at = { day: DAY1, tz: "Australia/Melbourne", nightSleep: "03:00" };
  const sleepAt = new Date(nightWindow(DAY1, at.tz, at.nightSleep).from).toISOString();
  const wakeAt = new Date(nextDayStart(DAY1, at.tz, at.nightSleep)).toISOString();
  assert.deepEqual(replayArgs(["python3", "x.py", "{day}", "--from={sleepAt}", "{wakeAt}", "{other}"], at), ["python3", "x.py", DAY1, `--from=${sleepAt}`, wakeAt, "{other}"]);
  assert.match(sleepAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  // dbEnv：配置里点名的环境变量指到回放的库；没写就没有；名字不像环境变量的不要
  const base = loadConfig({ workspace: "/tmp/hh-lead-ws", stateDir: mkdtempSync(join(tmpdir(), "hh-lead-dbenv-")) });
  assert.deepEqual(dbEnv(base, "/copy/hh.db"), {});
  assert.deepEqual(dbEnv({ ...base, sleep: { ...base.sleep, dbEnv: ["MY_DB", "bad name", "OTHER_DB"] } }, "/copy/hh.db"), { MY_DB: "/copy/hh.db", OTHER_DB: "/copy/hh.db" });

  // 回放里的落地那几步（team 的夜里）：命令里的时刻照这一天、配置的时区填
  const order: string[][] = [];
  const f = contNight({ knows: () => true, replay: true, flow: { replayFinish: [["python3", "scripts/build.py", "{day}", "{sleepAt}", "{wakeAt}"]] }, onRun: (args) => { if (args[0] === "scripts/build.py") order.push(args); } });
  await f.n.run();
  await f.pilot.stop();
  const tz = f.n.cfg.schedule.timezone, ns = f.n.cfg.schedule.nightSleep;
  assert.deepEqual(order, [["scripts/build.py", DAY1, new Date(nightWindow(DAY1, tz, ns).from).toISOString(), new Date(nextDayStart(DAY1, tz, ns)).toISOString()]]);

  // 真的回放：准备命令的子进程、段的会话拿到的环境变量指到回放的库（不是线上的），命令里的时刻填好了
  const r = await replayRig({ ...REPLAY_FLOW, replayPrep: [["/usr/bin/python3", "scripts/sleep_flow/cut.py", "{day}", "{sleepAt}", "{wakeAt}"]] }, { dbEnv: ["MY_DB"] });
  put(r.flowDir, "cut.py", [
    "import os, sys, pathlib",
    "d = pathlib.Path('sleep') / sys.argv[1] / 'slices'",
    "d.mkdir(parents=True, exist_ok=True)",
    "(d / 'dialogue.md').write_text('|'.join([os.environ.get('MY_DB', ''), sys.argv[2], sys.argv[3]]))",
  ].join("\n"));
  const mgr = new ReplayManager();
  const { dir, done } = mgr.start(r.deps, { day: DAY1, flowDir: r.flowDir, base: r.base });
  for (let i = 0; i < 1000 && r.driver.sessions.length === 0; i++) await sleepMs(10);
  const [db, s1, s2] = readFileSync(join(dir, "ws", "sleep", DAY1, "slices", "dialogue.md"), "utf8").split("|");
  assert.ok(db && db.startsWith(dir) && db !== r.live.location(), `回放的库：${db}`);
  assert.ok(existsSync(db!));
  assert.equal(s1, new Date(nightWindow(DAY1, "UTC", "03:00").from).toISOString());
  assert.equal(s2, new Date(nextDayStart(DAY1, "UTC", "03:00")).toISOString());
  assert.equal(r.driver.sessions[0]!.spec.env?.MY_DB, db, "段的会话（它的 Bash）也是这个库");
  await mgr.stop("测试完了");
  await done;
});

test("B1 follow-up: after the replay's finish build, the continuity examinee also sees rebuilt files that match exam.inject even when no specialist proposed them; files outside baseBlocks and inject are not in its view", { timeout: 30_000 }, async () => {
  const flow = { exam: { baseBlocks: ["SOUL.md"], inject: ["notes/**", "state/wake.md"] }, replayFinish: [["python3", "scripts/build.py", "{day}"]] };
  const onRun = (args: string[], files: Map<string, string>): void => {
    if (args[0] !== "scripts/build.py") return;
    files.set("notes/snapshot.md", "落地时拼的快照：睡前在说周五的事\n");   // 没有哪个专员提议过
    files.set("state/wake.md", "醒来第一眼看到的\n");
    files.set("other/elsewhere.md", "不在基础块、也不在 inject 里\n");
  };
  const f = contNight({ knows: () => true, replay: true, flow, onRun });
  await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  const paper = f.papers[`exam-${DAY1}-self-1-continuity-resident`]!;
  assert.ok(paper.includes("=== notes/snapshot.md ===\n落地时拼的快照：睡前在说周五的事"), paper.slice(0, 400));
  assert.ok(paper.includes("=== state/wake.md ===\n醒来第一眼看到的"));
  assert.ok(!paper.includes("不在基础块、也不在 inject 里"));
  // 真的夜里（没拼过）：只有今晚有提案的
  const real = contNight({ knows: () => true, flow: { exam: flow.exam } });
  real.n.files.set("notes/snapshot.md", "工作区里旧的快照\n");
  await real.n.run();
  await real.pilot.stop();
  assert.ok(!real.papers[`exam-${DAY1}-self-1-continuity-resident`]!.includes("工作区里旧的快照"));
});

// ---------- 第 3 批评审修正轮 ----------

test("batch 3 review I1: a replay holds a deploy restart only while it is really running — not once a stop was asked, not past its own watchdog limit", { timeout: 60_000 }, async () => {
  const r = await replayRig(REPLAY_FLOW);
  const mgr = new ReplayManager();
  assert.equal(mgr.holdsRestart(Date.now(), 3_600_000), false, "没有回放");
  const { done } = mgr.start(r.deps, { day: DAY1, flowDir: r.flowDir, base: r.base });
  assert.equal(mgr.holdsRestart(Date.now(), 3_600_000), true);
  assert.equal(mgr.holdsRestart(Date.now() + 3_600_001, 3_600_000), false, "过了它自己的时限：不再拦重启");
  assert.equal(mgr.running, true, "还算在跑（不让开第二个）");
  const stopping = mgr.stop("测试");
  assert.equal(mgr.holdsRestart(Date.now(), 3_600_000), false, "叫停了：不再拦");
  await stopping;
  await done;
  assert.equal(mgr.holdsRestart(Date.now(), 3_600_000), false);
});

test("batch 3 review I2: a gold rewritten through the stop-loss must be a strict textual narrowing of the old one", () => {
  const old = "周五交，因为他要出差";
  assert.equal(goldRevisionProblem(old, "因为他要出差"), null);
  assert.equal(goldRevisionProblem(old, " 因为他要出差。"), null, "空白、标点不算");
  assert.equal(goldRevisionProblem(old, "周五交；他要出差"), LP.REVISION.notNarrower, "「他要出差」只是原来一句里的一截");
  assert.equal(goldRevisionProblem(old, "因为他要搬家"), LP.REVISION.notNarrower);
  assert.equal(goldRevisionProblem(old, "因为他要出差，还要开会"), LP.REVISION.notNarrower);
  assert.equal(goldRevisionProblem(old, "周五交，因为他要出差，周五交"), LP.REVISION.notNarrower, "每一件都在，但没变短：不算收窄");
  assert.equal(goldRevisionProblem(old, old), LP.REVISION.same);
  assert.equal(goldRevisionProblem(old, "周五交、因为他要出差"), LP.REVISION.same, "只换了标点");
  assert.equal(goldRevisionProblem(old, "  "), LP.REVISION.same);
});

test("batch 3 review I2: stop-loss bounds — only a question that failed twice, only tonight's pending questions, one revision per question, a refused rewrite sends the specialist back, a revised question never enters the bank", { timeout: 60_000 }, async () => {
  const QID = `q:${DAY1}/events/3`;
  const faults = (gold: string) => ({ pass: false, fixes: [], faults: [{ id: QID, fault: "question", gold, why: "并了两件事" }] });
  // 第 1 轮（只没过一次）就说是题的毛病：不理
  const early = fixNight({ maxFixRounds: 1, knows: () => false, round2Questions: [], verdict: (round) => (round === 1 ? faults("因为他要出差") : { pass: true, fixes: [] }) });
  await early.n.run();
  await early.pilot.stop();
  assert.ok(!Object.keys(early.papers).some((id) => id.includes("requiz")));
  assert.equal(early.n.hosts.bank.get(QID)!.gold, "周五交，因为他要出差");
  // 改成她答的那句、改成原来没有的：不收，照答的毛病发回去；报告里写为什么
  for (const [gold, why] of [["不记得", LP.REVISION.notNarrower], ["因为他要搬家", LP.REVISION.notNarrower], ["周五交、因为他要出差", LP.REVISION.same]] as const) {
    const f = fixNight({ maxFixRounds: 2, knows: () => false, round2Questions: [], verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? faults(gold) : { pass: true, fixes: [] }) });
    await f.n.run();
    await f.pilot.stop();
    assert.ok(!Object.keys(f.papers).some((id) => id.includes("requiz")), gold);
    assert.equal(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 3, "照旧发回去改第 3 次");
    assert.ok(f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.REVISION.refused("为什么周五交", why)), gold);
  }
  // 改过一次、单独再考还是不对、下一轮又没过：不再改第二次
  const again = fixNight({ maxFixRounds: 2, knows: () => false, round2Questions: [], verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? faults(again.n.hosts.bank.get(QID)!.gold === "周五交，因为他要出差" ? "因为他要出差" : "出差") : { pass: true, fixes: [] }), ans: (sid) => (sid.includes("requiz") ? "不记得" : undefined) });
  await again.n.run();
  await again.pilot.stop();
  assert.equal(Object.keys(again.papers).filter((id) => id.includes("requiz-after")).length, 1, "只单独再考了一回（它自己那次重考不算）");
  assert.equal(again.n.hosts.bank.get(QID)!.gold, "因为他要出差", "只改了一次");
  // 改过标准答案的题过了也不进题库（今晚出的别的题照常生效）；compare 用的记录里列着
  const ok = fixNight({ maxFixRounds: 2, knows: () => false, round2Questions: [], verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? faults("因为他要出差") : { pass: true, fixes: [] }), ans: (sid) => (sid.includes("requiz") ? "对的" : undefined) });
  const res = await ok.n.run();
  await ok.pilot.stop();
  assert.deepEqual(res.landed, [DAY1]);
  assert.equal(ok.n.hosts.bank.get(QID)!.status, "dropped");
  assert.equal(ok.n.hosts.bank.get(`q:${DAY1}/events/1`)!.status, "active");
  const leadFile = JSON.parse(ok.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { revised: Array<{ id: string; q: string; from: string; to: string; answers: string[]; why: string }> };
  assert.deepEqual(leadFile.revised, [{ id: QID, q: "为什么周五交", from: "周五交，因为他要出差", to: "因为他要出差", answers: ["不记得", "不记得"], why: "并了两件事" }]);
  // 题库里的旧题（不是今晚待定的）连着两轮没过：改不了
  const seeded = fixNight({ maxFixRounds: 2, knows: () => true, round2Questions: [], ans: (_sid, q) => (q.includes("以前的旧题") ? "不记得" : undefined), verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: "seed:t/old1", fault: "question", gold: "旧", why: "x" }] } : { pass: true, fixes: [] }) });
  seeded.n.hosts.bank.importSeed([{ id: "old1", q: "以前的旧题", gold: "旧答案", evidence: ["memory/a.md:1"] }], { tag: "t", layer: "searchable", day: "2026-11-01" });
  await seeded.n.run();
  await seeded.pilot.stop();
  assert.equal(seeded.n.hosts.bank.get("seed:t/old1")!.gold, "旧答案");
  assert.ok(!Object.keys(seeded.papers).some((id) => id.includes("requiz")));
});

test("batch 3 review I3+I4: a finish build that writes under proposed/ stops the replay naming the command; a fix round after a rebuild is marked in its row; continuity questions the lead does not hand in fail the owner closed", { timeout: 60_000 }, async () => {
  const flow = { replayFinish: [["python3", "scripts/ok.py", "{day}"], ["python3", "scripts/bad.py", "{day}"]] };
  const bad = contNight({ knows: () => true, replay: true, flow, onRun: (args, files) => { if (args[0] === "scripts/bad.py") files.set(`sleep/${DAY1}/proposed/SOUL.md`, "落地的脚本改了提案\n"); } });
  const res = await bad.n.run();
  await bad.pilot.stop();
  assert.equal(res.stoppedBy, "error");
  assert.ok(res.error!.startsWith(S.leadprompts.finishTouchedHead) && res.error!.includes("scripts/bad.py") && res.error!.includes("SOUL.md") && !res.error!.includes("scripts/ok.py"), res.error);
  assert.ok(!stageRows(bad.n.db).some((r) => r.verdict.includes("交差以后提案又变了")), "不是当成专员交差以后又改了");
  assert.ok(!bad.n.driver.sessions.some((s) => s.id.includes("continuity")));

  // 要点没答对、发回去改：这一轮是在回放里拼过的工作区上改的，行里注一句
  const fix = contNight({ knows: (round) => round >= 2, replay: true, flow: { replayFinish: [["python3", "scripts/ok.py", "{day}"]] } });
  await fix.n.run();
  await fix.pilot.stop();
  const rows = stageRows(fix.n.db).filter((r) => r.stage === "self");
  assert.deepEqual(rows.map((r) => r.status), ["redo", "passed"]);
  assert.ok(!rows[0]!.verdict.includes(S.leadprompts.roundOnRebuilt) && rows[1]!.verdict.includes(S.leadprompts.roundOnRebuilt), rows[1]!.verdict);

  // 领导没把固定要问的题交上来：这道关没考成，owner 不算过（不是写一句就放过去）
  const n = teamRig({ stages: CONT_STAGES, team: { continuity: ["睡前最后在做什么"], maxFixRounds: 2 } });
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id.startsWith("sleep-")) {
      n.files.set(`sleep/${DAY1}/proposed/${s.id.includes("-self-") ? "SOUL.md" : "memory/a.md"}`, "改了\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "交", changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("记着什么", "keep", { sources: ["SOUL.md:1"] })] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const r2 = await n.run();
  await pilot.stop();
  assert.deepEqual(r2.landed, [], "self 是 required：这一天不落地");
  const self = stageRows(n.db).filter((r) => r.stage === "self");
  assert.deepEqual(self.map((r) => [r.status, r.decision]), [["deferred", "rule:drop"]]);
  assert.ok(self[0]!.verdict.includes(LP.CONT.notHandedIn(["睡前最后在做什么"])));
});

test("batch 3 review minors: extras never fail the gate; a duty entry explained in round 1 is not bounced again in a fix round; a stage can set its own sliceCap", { timeout: 60_000 }, async () => {
  // 细节全错、要点对：过，只是比例是 0
  const flow = parseTeam({ exam: { baseBlocks: ["SOUL.md"] } });
  const h = consistHost(() => "对的");
  const inner = h.host.open.bind(h.host);
  h.host.open = (op) => {
    const s = inner(op);
    if (!op.id.includes("-grade-")) return s;
    return { ...s, onGrades: (fn: (g: ExamGrades) => string) => s.onGrades((g) => fn({ grades: g.grades.map((x) => (x.id.includes("#细节") ? { ...x, verdict: "wrong" as const } : x)), layers: g.layers })) } as never;
  };
  const qs = [{ ...cq(1, { layer: "resident" }), must: "要点", extras: ["细节一", "细节二"] }];
  const r = await continuityExam({ host: h.host, bank: new Bank(openDb(":memory:"), () => 1), flow }, { day: DAY1, stage: flow.stages[1]!, attempt: 1, round: 1, questions: qs, opening: "O", injection: "I" });
  assert.deepEqual([r.pass, r.must, r.extras], [true, { right: 1, total: 1 }, { right: 0, total: 2 }]);

  // 第 1 轮说过不用改的那一处，改的那一轮不再退回
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", required: true, tools: ["recall"], material: ["dialogue"], writes: ["**"], duty: ["notes/todo.md"], sliceCap: 5 },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["events"] },
  ];
  const n = teamRig({ stages, team: { maxFixRounds: 1, sliceCap: 100_000 } });
  const replies: string[] = [];
  const wakes: string[] = [];
  const pilot = autopilot(n.driver, async (s, text, nth) => {
    if (s.id.startsWith("sleep-")) {
      if (text.includes("你还没调 stage_done")) return;
      wakes.push(text);
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, `原来的一行\n第 ${nth} 次\n`);
      const done = s.spec.tools.find((t) => t.name === "stage_done")!;
      const report = nth === 1 ? "改了 a.md\n看过、不用改：notes/todo.md——没有新的待办" : "照说的改了";
      const first = await done.handler({ status: "done", report, changes: [] });
      replies.push(first);
      await s.play({ say: "交了", total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq(`${s.sent.length} 题`, "keep")] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: s.sent.length > 3, fixes: [{ what: "再改一下", fix: "照原话" }] } }, total: USE });
    } else if (s.id.includes("-grade")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.deepEqual(replies, ["收到，这一段交了。", "收到，这一段交了。"], "两轮都没退回");
  // 这一段自己的 sliceCap（5 个字）盖过全局的：材料只给路径
  assert.ok(wakes[0]!.includes(LP.SLICE_TOO_LONG(`sleep/${DAY1}/input.md`, "这一天的对话".length)), wakes[0]!.slice(0, 300));
  assert.ok(problemsOf(() => parseTeam({ stages: [agent("events", { writes: ["**"], sliceCap: -2 }), script("finish", ["finish"], { after: ["events"] })] })).some((p) => /sliceCap/.test(p)));
});

test("stop-loss ruling: a narrowing is accepted even when her failing answers already held the part that is kept; the revision is listed with old gold, new gold and both answers; the brief says how to narrow", { timeout: 30_000 }, async () => {
  const QID = `q:${DAY1}/events/3`;
  // 她两轮都答出了「他要出差」，没答出「周五交」那一半：原来的标准答案把两件事并成了一句
  const f = fixNight({
    maxFixRounds: 2, knows: () => true, round2Questions: [],
    ans: (sid, q) => (q.includes("为什么周五交") ? (sid.includes("requiz") ? "对的，他要出差" : "他要出差") : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: QID, fault: "question", gold: "因为他要出差", why: "明天的她只要记得原因" }] } : { pass: true, fixes: [] }),
  });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "因为他要出差");
  assert.ok(Object.keys(f.papers).some((id) => id.includes("requiz-after")));
  const line = LP.QUESTION_REVISED({ q: "为什么周五交", from: "周五交，因为他要出差", to: "因为他要出差", answers: ["他要出差", "他要出差"], why: "明天的她只要记得原因" });
  for (const part of ["周五交，因为他要出差", "他要出差", "明天的她只要记得原因", "两轮答的"]) assert.ok(line.includes(part), part);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(line) && report.indexOf(line) < report.indexOf("## "), "写在报告最上面");
  const verdict = f.leadWakes.find((t) => t.includes(S.leadprompts.twice.head))!;
  assert.ok(verdict.includes(S.leadprompts.twice.how), verdict);
});

test("stop-loss narrowing keeps whole clauses only: a fragment inside a clause can flip the meaning and is refused", () => {
  // 复审点名的三个：都是原来一句里的一截
  assert.equal(goldRevisionProblem("他没有答应周五交", "答应周五交"), LP.REVISION.notNarrower);
  assert.equal(goldRevisionProblem("不是在跟小王说，是在跟老李说周五的事", "在跟小王说"), LP.REVISION.notNarrower);
  assert.equal(goldRevisionProblem("周五交，因为他要出差", "交"), LP.REVISION.notNarrower);
  // 留下整句的才收
  assert.equal(goldRevisionProblem("周五交，因为他要出差", "周五交"), null);
  assert.equal(goldRevisionProblem("周五交，因为他要出差。", " 因为他要出差 "), null);
  assert.equal(goldRevisionProblem("甲来了；乙没来！丙呢？丁、戊都在", "乙没来，丁"), null, "分句的标点中英文都认");
  assert.equal(goldRevisionProblem("a, b. c; d!e?f\ng", "b;g"), null);
  assert.equal(goldRevisionProblem("不是在跟小王说，是在跟老李说周五的事", "是在跟老李说周五的事"), null);
  // 整句都留着（只是换了顺序、标点）：不算收窄
  assert.equal(goldRevisionProblem("周五交，因为他要出差", "因为他要出差，周五交"), LP.REVISION.notNarrower);
  assert.equal(goldRevisionProblem("周五交，因为他要出差", "周五交、因为他要出差"), LP.REVISION.same);
});

test("continuity view on a real night: no finish build, so the workspace is not scanned for inject files — only files proposed tonight are injected", { timeout: 30_000 }, async () => {
  const real = contNight({ knows: () => true, flow: { exam: { baseBlocks: ["SOUL.md"], inject: ["notes/**", "state/wake.md"] } } });
  real.n.files.set("notes/snapshot.md", "工作区里的快照（没有哪个专员提议过）\n");
  real.n.files.set("state/wake.md", "工作区里的那一页\n");
  real.n.files.set(`sleep/${DAY1}/proposed/notes/tonight.md`, "今晚提议的一页\n");
  const res = await real.n.run();
  await real.pilot.stop();
  assert.deepEqual(real.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.ok(!real.n.runs.some((r) => r[0] === "scripts/build.py"));
  const paper = real.papers[`exam-${DAY1}-self-1-continuity-resident`]!;
  assert.ok(paper.includes("=== notes/tonight.md ===\n今晚提议的一页"), paper.slice(0, 300));
  assert.ok(!paper.includes("工作区里的快照") && !paper.includes("工作区里的那一页"));
});

// ---------- 第 4 批 C1：一个专员一个领导的会话，开头带前面几个专员定了什么 ----------

test("C1: a fresh lead session per specialist, opened at its first hand-in and closed when it is settled; its first message carries a capped digest of what earlier specialists settled tonight", { timeout: 30_000 }, async () => {
  assert.equal(parseTeam({}, { digestCap: 800 }).team!.digestCap, 800);
  assert.ok(!("digestCap" in parseTeam().team!));
  assert.ok(problemsOf(() => parseTeam({}, { digestCap: 50 })).some((p) => /digestCap/.test(p)));
  const stages = [
    { id: "events", title: "事件", kind: "agent", skill: "events.md", tools: ["mem_event_create", "recall"], material: ["dialogue"], writes: ["**"] },
    { id: "people", title: "人", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "self", title: "自己", kind: "agent", skill: "people.md", tools: ["recall"], material: ["dialogue"], writes: ["**"] },
    { id: "finish", title: "落地", kind: "script", command: ["python3", "scripts/finish.py", "{day}"], after: ["self"] },
  ];
  const n = teamRig({ stages, team: { digestCap: 400 } });
  const first: Record<string, string> = {};
  const closedAt: string[] = [];
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id.startsWith("sleep-")) {
      const who = s.id.split("-").at(-2)!;
      // 下一个专员开工时，上一个的领导会话已经关了
      closedAt.push(`${who}:${n.driver.sessions.filter((x) => x.id.startsWith("lead-")).map((x) => `${x.id.split("-").at(-1)}${x.closed ? "关" : "开"}`).join(",")}`);
      if (who === "events") await s.spec.tools.find((t) => t.name === "mem_event_create")!.handler({ title: "今天定的事", summary: "定了周五交", gist: "周五交", importance: 3 });
      n.files.set(`sleep/${DAY1}/proposed/memory/${who}.md`, `${who} 写的\n${"很长的一行。".repeat(who === "events" ? 1 : 200)}\n`);
      for (let i = 0; who === "people" && i < 40; i++) n.files.set(`sleep/${DAY1}/proposed/people/p${i}.md`, "一张卡\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: `${who} 交`, changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      first[s.id] ??= text;
      const who = s.id.split("-").at(-1)!;
      if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq(`${who} 记着什么`, "keep")] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [], notes: [`${who} 这里定了：周五的事记在事件里，别处不重复`] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  const leads = n.driver.sessions.filter((s) => s.id.startsWith("lead-"));
  assert.deepEqual(leads.map((s) => s.id), [`lead-${DAY1}-events`, `lead-${DAY1}-people`, `lead-${DAY1}-self`]);
  assert.ok(leads.every((s) => s.closed));
  assert.deepEqual(closedAt, ["events:", "people:events关", "self:events关,people关"]);
  // 开头、工具清单还是跟专员一字不差（共用缓存）
  const spec = n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!;
  for (const l of leads) { assert.equal(l.spec.systemAppend, spec.spec.systemAppend); assert.deepEqual(toolsOf(l), toolsOf(spec)); }
  // 第一个：没有前面的；每个的第一条消息都带角色
  assert.ok(first[`lead-${DAY1}-events`]!.includes("领导的页") && !first[`lead-${DAY1}-events`]!.includes(S.leadprompts.digest.head));
  // 第二个：带第一个定了什么——过了、改了哪些（文件、事件库的编号带标题）、领导那一次留的话
  const second = first[`lead-${DAY1}-people`]!;
  assert.ok(second.includes("领导的页") && second.includes(S.leadprompts.digest.head));
  for (const part of ["「事件」过了", "memory/events.md", "e0001 今天定的事", "events 这里定了：周五的事记在事件里，别处不重复"]) assert.ok(second.includes(part), `${part}\n${second.slice(0, 900)}`);
  assert.ok(second.indexOf(S.leadprompts.digest.head) < second.indexOf("【专员交差】"), "排在这一个专员的交差前面");
  // 第三个：前两个各一块；每一块不超过 digestCap（人那一块改了 41 个文件，截掉）
  const third = first[`lead-${DAY1}-self`]!;
  assert.ok(third.includes("「事件」过了") && third.includes("「人」过了"));
  const blocks = third.slice(third.indexOf(S.leadprompts.digest.head), third.indexOf("【专员交差】")).split("\n\n").filter((b) => b.startsWith("「"));
  assert.equal(blocks.length, 2);
  assert.ok(blocks.every((b) => b.length <= 400 + 30), blocks.map((b) => b.length).join(","));
  assert.ok(blocks[1]!.includes("…（太长，后面截掉了）"));
  // 截的是改了哪些那一长串：把关留的话排在前面，截不掉
  assert.ok(blocks[1]!.includes("people 这里定了：周五的事记在事件里，别处不重复") && blocks[1]!.indexOf("把关留的话") < blocks[1]!.indexOf("改了："), blocks[1]);
  // 记账的样子没变：领导的花费还是记在各专员自己的行上
  for (const r of stageRows(n.db).filter((x) => x.stage !== "finish")) {
    const c = JSON.parse(r.cost!) as Record<string, number>;
    assert.deepEqual(Object.keys(c), ["do", "lead", "exam"]);
    assert.ok(c.lead! > 0, `${r.stage} ${r.cost}`);
  }
});

test("C1: an abort closes whichever lead session is open; a continuity must-have missed twice is put to the last specialist's own lead session", { timeout: 30_000 }, async () => {
  const f = fixNight({ maxFixRounds: 2, knows: () => false, onLead: (s, text) => { if (text.includes("lead_verdict")) { f.n.runner.abort("停机"); assert.ok(s.closed, "叫停就把开着的领导会话关了"); } } });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.equal(res.stoppedBy, "aborted");
  assert.ok(f.n.driver.sessions.filter((s) => s.id.startsWith("lead-")).every((s) => s.closed));
  assert.equal(f.n.hosts.sessions.size, 0);

  const c = contNight({ knows: () => false, maxFixRounds: 2, must: "在跟他说周五的事，他先睡了", verdict: (text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/self/2`, fault: "question", gold: "在跟他说周五的事", why: "带了两件事" }] } : { pass: true, fixes: [] }), ans: (sid) => (sid.includes("requiz") ? "对的" : undefined) });
  await c.n.run();
  await c.pilot.stop();
  const asked = c.n.driver.sessions.filter((s) => s.sent.some((x) => x.text.includes(S.leadprompts.twice.head))).map((s) => s.id);
  assert.deepEqual(asked, [`lead-${DAY1}-self`]);
});

// ---------- 第 4 批 C2：领导交题前先对着出处核一遍标准答案 ----------

test("C2 Lead: a hand-in with new / missed / continuity questions is first answered with each gold next to its source excerpt and not taken; the second hand-in is taken; keep-only hand-ins are taken at once", async () => {
  const replies: string[] = [];
  const excerpt = (q: LeadQuestion): { ref: string; text: string } | null => (q.sources[0] === "c:9" ? null : { ref: q.sources[0]!, text: `出处原文：这个字是「怯」，出现了三次（${q.sources[0]}）` });
  const h = leadHost((s) => {
    if (s.n === 1) {
      replies.push(s.review({ intent: [{ target: "x", what: "y", fix: "" }], questions: [lq({ q: "那个字出现几次", gold: "「怖」出现三次", probe: "new", sources: ["c:120"] }), lq({ q: "原来记着的", probe: "keep", sources: ["c:1"] }), lq({ q: "读不出来的", probe: "missed", sources: ["c:9"] })] }));
      // 核过、把字改对了，再交
      replies.push(s.review({ checked: true, intent: [], questions: [lq({ q: "那个字出现几次", gold: "「怯」出现三次", probe: "new", sources: ["c:120"] }), lq({ q: "原来记着的", probe: "keep", sources: ["c:1"] })] }));
      s.turnEnd(true);
    }
  });
  const { lead } = leadFor(h, { excerpt });
  const r = await reviewOf(lead);
  // 头一次没收：回的是「核一遍出处」，每道 new / missed 的标准答案旁边是出处原文；keep 的不列
  assert.ok(replies[0]!.startsWith(S.leadprompts.checkGold.head), replies[0]);
  assert.ok(replies[0]!.includes("标准答案：「怖」出现三次") && replies[0]!.includes("出处原文：这个字是「怯」，出现了三次（c:120）"));
  assert.ok(replies[0]!.includes("读不出来的") && replies[0]!.includes(LP.CHECK_GOLD_NO_TEXT("c:9")) && !replies[0]!.includes("原来记着的"));
  assert.equal(replies[1], "收到。");
  assert.deepEqual(r!.questions.map((q) => [q.q, q.gold]), [["那个字出现几次", "「怯」出现三次"], ["原来记着的", lq().gold]], "收的是第二次交的");
  assert.deepEqual(r!.intent, [{ target: "x", what: "y", fix: "" }], "第一次写的 intent 留着");

  // 只有 keep 的题：不用核，一次就收
  const keep = leadHost((s) => { replies.push(s.review({ intent: [], questions: [lq({ probe: "keep" })] })); s.turnEnd(true); });
  assert.equal((await reviewOf(leadFor(keep, { excerpt }).lead))!.questions.length, 1);
  assert.equal(replies.at(-1), "收到。");
  // 只交了一次就不交了：不算交（催一次）；催了以后再交的那一次就收，不再来回
  const once = leadHost((s) => { s.review({ intent: [{ target: "x", what: "y", fix: "" }], questions: [lq({ probe: "new" })] }); s.turnEnd(true); });
  const o = leadFor(once, { excerpt });
  assert.equal((await reviewOf(o.lead))!.questions.length, 1, "催了以后第二次交的收下");
  assert.equal(once.wakes[0]![1], S.leadprompts.nudge.check, "催的话说的是真的：交过了、出处贴回去了、还没收");
  // 没配 excerpt（不核）：照旧一次就收
  const plain = leadHost((s) => { s.review({ intent: [], questions: [lq({ probe: "new" })] }); s.turnEnd(true); });
  assert.equal((await reviewOf(leadFor(plain).lead))!.questions.length, 1);
  assert.equal(plain.wakes[0]!.length, 1);
});

test("C2 night: the excerpt is the resolved text of the question's first raw source; the brief tells the lead to compare every name, number and character", { timeout: 30_000 }, async () => {
  const n = teamRig({ rawLead: true, stages: FIX_STAGES });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', ?, 5)").run(`这个字是「怯」，出现了三次。${"后面还有很长的话。".repeat(60)}`);
  const replies: string[] = [];
  let brief = "";
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id.startsWith("sleep-")) {
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n加了一行\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "交", changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text.includes("lead_review")) {
        brief = text;
        const def = s.spec.tools.find((t) => t.name === "lead_review")!;
        const qs = (gold: string) => [tq("那个字出现几次", "new", { gold, sources: ["e0009", "c:7"] }), tq("原来那一行", "missed", { sources: ["memory/a.md:1"] })];
        replies.push(await def.handler({ intent: [], questions: qs("「怖」出现三次") }));
        await s.play({ tool: { name: "lead_review", args: { intent: [], questions: qs("「怯」出现三次"), checked: true } }, total: USE });
      } else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.ok(brief.includes(S.leadprompts.checkGold.brief));
  const reply = replies[0]!;
  assert.ok(reply.startsWith(S.leadprompts.checkGold.head));
  // 头一条能读出原文的出处（e0009 不是原话，跳过；c:7 是），截到 300 字
  assert.ok(reply.includes("c:7：这个字是「怯」，出现了三次。") && !reply.includes("后面还有很长的话。".repeat(40)), reply);
  assert.ok(reply.includes("memory/a.md:1：原来的一行"));
  assert.equal(n.hosts.bank.get(`q:${DAY1}/events/1`)!.gold, "「怯」出现三次");
});

// ---------- 第 4 批 C3（修正轮 1 重写）：标准答案里一个词写错了——核过就改标准答案、让判分的重判，不是把题撤掉 ----------

const SRC = "那天她写的字帖里，「怯」出现三次，她记得很清楚。";
type WdIn = Parameters<typeof withdrawProblem>[0];
const wd = (over: Partial<WdIn> = {}) => withdrawProblem({
  gold: "「怖」出现三次", stem: "那个字出现几次", otherGolds: ["别的题的标准答案"], answers: ["不记得", "「怯」出现三次"],
  sources: ["c:8", "memory/a.md:1"], own: [SRC, "原来的一行"], probe: "new", twoAnswers: false,
  evidence: { kind: "gold-wrong", refs: ["#8"], wrongToken: "怖", rightToken: "怯" }, texts: [SRC], ...over,
});
const gw = (wrongToken: string, rightToken: string, refs = ["c:8"]) => ({ kind: "gold-wrong" as const, refs, wrongToken, rightToken });

test("C3 withdrawProblem: the mechanical conditions for correcting a wrong token in the gold", () => {
  assert.equal(wd(), null, "「怖 / 怯」：标准答案里的字出处里没有，出处里的字她答出来了");
  // 证据
  assert.equal(wd({ evidence: undefined }), LP.WITHDRAW.noEvidence);
  assert.equal(wd({ evidence: gw("怖", "怯", []), texts: [] }), LP.WITHDRAW.noEvidence);
  assert.equal(wd({ evidence: gw("怖", "怯", ["c:99"]) }), LP.WITHDRAW.refNotSource, "只能拿这道题自己的出处当证据");
  assert.equal(wd({ texts: [null] }), LP.WITHDRAW.refUnreadable);
  // 两个词
  assert.equal(wd({ evidence: gw(" ", "怯") }), LP.WITHDRAW.tokens);
  assert.equal(wd({ evidence: gw("怯", "怯") }), LP.WITHDRAW.tokens);
  assert.equal(wd({ evidence: gw("怖", "怯字") }), LP.WITHDRAW.tokens, "一个单字、一个两个字：不收");
  assert.equal(wd({ gold: "出现三次了", evidence: gw("三次了", "三次") }), LP.WITHDRAW.tokens, "一个词包着另一个");
  assert.equal(wd({ evidence: gw("五回", "六回") }), LP.WITHDRAW.wrongNotInGold);
  assert.equal(wd({ texts: [`${SRC}（也有人写成「怖」）`], own: [`${SRC}（也有人写成「怖」）`, "原来的一行"] }), LP.WITHDRAW.wrongInSource);
  assert.equal(wd({ gold: "「怖字」出现三次", evidence: gw("怖字", "三次") }), LP.WITHDRAW.rightInGold);
  assert.equal(wd({ evidence: gw("怖", "惧") }), LP.WITHDRAW.rightNotInSource);
  assert.equal(wd({ answers: ["不记得", "不知道"] }), LP.WITHDRAW.rightNotInAnswer, "她没答出出处里的那个：是答的毛病");
  // 复审的表
  const fri = { gold: "周五交报告", stem: "什么时候交报告", sources: ["c:8"], own: ["我周五得把报告交了，老板催了两回"], texts: ["我周五得把报告交了，老板催了两回"] };
  assert.equal(wd({ ...fri, answers: ["不记得了", "想不起来了"], evidence: gw("交报告", "了") }), LP.WITHDRAW.tokens, "a：虚词（单个字对一个词）");
  assert.equal(wd({ ...fri, stem: "老板是不是催了两回", answers: ["催了两回", "两回"], evidence: gw("交报告", "两回") }), LP.WITHDRAW.rightCommon, "a：对的那个词题目里就有");
  assert.equal(wd({ ...fri, otherGolds: ["老板催了两回"], answers: ["催了两回", "两回"], evidence: gw("交报告", "两回") }), LP.WITHDRAW.rightCommon, "a：对的那个词是别的题的标准答案里的");
  assert.equal(wd({ ...fri, own: ["我周五得把报告交了，还没答复"], texts: ["我周五得把报告交了，还没答复"], answers: ["（没答）", "（没答）"], evidence: gw("交报告", "没答") }), LP.WITHDRAW.rightNotInAnswer, "b：没答的那个占位不算她答的");
  assert.equal(wd({ gold: "去了 3 次", stem: "去了几次", sources: ["c:8"], own: ["这个月去了三次北京"], texts: ["这个月去了三次北京"], answers: ["三次，在上海", "三次"], evidence: gw("3", "三") }), LP.WITHDRAW.tokens, "c：数字写法不同不算两个词");
  assert.equal(wd({ gold: "去了３次", stem: "去了几次", sources: ["c:8"], own: ["这个月去了三次北京"], texts: ["这个月去了三次北京"], answers: ["三次"], evidence: gw("3次", "四次") }), LP.WITHDRAW.wrongInSource, "全角、汉字数字都归一了再比");
  assert.equal(wd({ gold: "王明说周五交", stem: "谁说的哪天交", sources: ["c:8"], own: ["王明：周五交吧。老板催了两回"], texts: ["王明：周五交吧。老板催了两回"], answers: ["老板催过", "老板在催"], evidence: gw("王明说", "老板") }), null, "d：机械的这几条挡不住——靠改了标准答案以后让判分的重判（夜里那条测试）");
  assert.equal(wd({ gold: "吵架了", stem: "他们怎么了", sources: ["c:8"], own: ["吵了一架，后来和好了"], texts: ["吵了一架，后来和好了"], answers: ["和好了", "和好了"], evidence: gw("吵架了", "和好了") }), LP.WITHDRAW.noContext, "e：整句都是那个词，没法对位置");
  // 只查了引的那一条：别的自己的出处里有标准答案的那个词（复审 Important 2）
  assert.equal(wd({ gold: "周五交", stem: "哪天交", answers: ["他要出差", "出差"], sources: ["#12", "#40"], own: ["他说周五交", "他说下周要出差"], evidence: gw("周五", "出差", ["#40"]), texts: ["他说下周要出差"] }), LP.WITHDRAW.wrongInOwnSource);
  // keep 的题：整理前的回答里带着那个错的词（旧的记忆本来就是错的，专员改对了）才行
  assert.equal(wd({ probe: "keep" }), LP.WITHDRAW.keepNotCarried);
  assert.equal(wd({ probe: "keep", before: "是「怯」" }), LP.WITHDRAW.keepNotCarried);
  assert.equal(wd({ probe: "keep", before: "「怖」出现三次" }), null);
  // 两种说法：默认关着；开了还得一条出处、两个说法互不包着、B 不在标准答案里、A 不在她答的里
  const two = (over: Partial<WdIn> = {}) => withdrawProblem({
    gold: "周五交", stem: "哪天交", otherGolds: [], answers: ["不记得", "他说下周一交"], sources: ["c:8"], own: ["先说周五交，后来又说下周一交"], probe: "new", twoAnswers: true,
    evidence: { kind: "two-answers", refs: ["c:8"], answerA: "周五交", answerB: "下周一交" }, texts: ["先说周五交，后来又说下周一交"], ...over,
  });
  assert.equal(two({ twoAnswers: false }), LP.WITHDRAW.twoAnswersOff);
  assert.equal(two(), null);
  assert.equal(two({ texts: ["先说周五交，后来又说别的"] }), LP.WITHDRAW.notBoth);
  assert.equal(two({ gold: "周三交" }), LP.WITHDRAW.aNotInGold);
  assert.equal(two({ answers: ["不记得", "忘了"] }), LP.WITHDRAW.bNotInAnswer);
  assert.equal(two({ answers: ["周五交", "下周一交"] }), LP.WITHDRAW.aInAnswer);
  assert.equal(two({ gold: "周五交，下周一交" }), LP.WITHDRAW.rightInGold);
  assert.equal(two({ sources: ["c:8", "c:9"], evidence: { kind: "two-answers", refs: ["c:8", "c:9"], answerA: "周五交", answerB: "下周一交" }, texts: ["先说周五交", "后来又说下周一交"] }), LP.WITHDRAW.noEvidence, "只收一条出处");
});

/** 一个专员、一道标准答案里一个字写错了的 new 题（出处 c:8 说的是「怯」），她两轮都照出处答；领导第 2 轮定夺时要改 */
function wrongGoldNight(o: { faults: (id: string) => unknown[]; extra?: unknown[]; team?: Record<string, unknown>; answer?: string; maxFixRounds?: number; round2?: unknown[] }) {
  const QID = `q:${DAY1}/events/1`;
  const f = fixNight({
    maxFixRounds: o.maxFixRounds ?? 2, knows: () => true, round2Questions: o.round2 ?? [], team: o.team ?? {},
    round1Questions: [tq("那个字出现几次", "new", { gold: "「怖」出现三次", sources: ["c:8"] }), tq("a 上原来记着什么", "keep"), ...(o.extra ?? [])],
    ans: (_sid, q) => (q.includes("那个字出现几次") || q.includes("也写错了") ? o.answer ?? "「怯」出现三次" : q.includes("答不出") ? "不记得" : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: o.faults(QID) } : { pass: true, fixes: [] }),
  });
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', ?, 5)").run(SRC);
  return { f, QID };
}
const withdrawFault = (id: string, over: Record<string, unknown> = {}) => ({ id, fault: "question", action: "correct", why: "标准答案的字写错了", evidence: { kind: "gold-wrong", refs: ["c:8"], wrongToken: "怖", rightToken: "怯" }, ...over });

test("C3 night: a twice-failed question whose gold has a wrong token is corrected, not deleted — the open grader re-marks her latest answer against the corrected gold; right counts as right, never banked, listed at the report top", { timeout: 30_000 }, async () => {
  const { f, QID } = wrongGoldNight({ faults: (id) => [withdrawFault(id)] });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.equal(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 2, "第 3 次没发回去");
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "events").map((r) => [r.status, r.decision]), [["redo", "lead:fix"], ["passed", "lead:pass"]]);
  // 没有为重判另开一场、另开会话：第 2 轮还是一个考生（加它自己那次重考）、一个判分的；判分的那个会话多判了一次
  const r2 = f.n.driver.sessions.filter((s) => s.id.includes("-r2-")).map((s) => s.id.replace(`exam-${DAY1}-events-1-r2-`, ""));
  assert.deepEqual(r2, ["after-searchable", "grade-all", "retake-searchable"]);
  const grader = f.n.driver.sessions.find((s) => s.id === `exam-${DAY1}-events-1-r2-grade-all`)!;
  assert.equal(grader.sent.length, 3, "整理后、重考、照改过的标准答案重判");
  assert.ok(grader.sent[2]!.text.includes("标准答案：「怯」出现三次") && grader.sent[2]!.text.includes("她的回答：「怯」出现三次"));
  assert.ok(grader.closed, "定完就关");
  assert.equal(f.n.hosts.bank.get(QID)!.status, "dropped", "改过标准答案的题不进题库");
  assert.equal(f.n.hosts.bank.get(`q:${DAY1}/events/2`)!.status, "active");
  // 定夺那一份：连着两轮没过的题带着它自己的出处和原文（动手前的样子），说了怎么改
  const verdict = f.leadWakes.find((t) => t.includes(S.leadprompts.twice.head))!;
  assert.ok(verdict.includes(S.leadprompts.withdraw.how) && verdict.includes(`c:8：${SRC}`), verdict);
  // 报告最上面、这一段的记录里：题、原来的标准答案、改成的、她两次答的、两个词、出处和原文
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  const top = report.slice(0, report.indexOf("## "));
  for (const part of [S.leadprompts.correctedHead, "那个字出现几次", "「怖」出现三次", "「怯」出现三次", "怖", "怯", "c:8", SRC, "标准答案的字写错了"]) assert.ok(top.includes(part), `${part}\n${top}`);
  const rec = JSON.parse(f.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { corrected: Array<Record<string, unknown>> };
  assert.deepEqual(rec.corrected, [{ id: QID, q: "那个字出现几次", gold: "「怖」出现三次", newGold: "「怯」出现三次", answers: ["「怯」出现三次", "「怯」出现三次"], tokens: ["怖", "怯"], refs: ["c:8"], excerpts: [SRC], unreadable: [], why: "标准答案的字写错了" }]);
});

test("C3 night: refusals — her answer does not match the corrected gold, bad evidence, a first-time failure, a continuity question, two-answers off by default; each sends the specialist back with the reason in the report", { timeout: 60_000 }, async () => {
  // 机械的几条都过了，但照改过的标准答案她还是没答对（复审的 d）：不改，照答的毛病
  const d = fixNight({
    maxFixRounds: 1, knows: () => true, round2Questions: [],
    round1Questions: [tq("谁说的哪天交", "new", { gold: "王明说周五交", sources: ["c:8"] }), tq("a 上原来记着什么", "keep")],
    ans: (_sid, q) => (q.includes("谁说的") ? "老板在催" : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/events/1`, fault: "question", action: "correct", why: "x", evidence: gw("王明说", "老板") }] } : { pass: true, fixes: [] }),
  });
  d.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', '王明：周五交吧。老板催了两回', 5)").run();
  const dres = await d.n.run();
  await d.pilot.stop();
  assert.deepEqual(dres.landed, []);
  const drep = d.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(drep.includes(LP.WITHDRAW.refused("谁说的哪天交", LP.WITHDRAW.stillWrong("老板周五交"))) && !drep.includes(S.leadprompts.correctedHead), drep.slice(0, 500));
  assert.equal(d.n.hosts.bank.get(`q:${DAY1}/events/1`)!.gold, "王明说周五交", "标准答案没动");
  // 证据对不上
  const bad = wrongGoldNight({ faults: (id) => [withdrawFault(id, { evidence: gw("出现", "写了") })] });
  await bad.f.n.run();
  await bad.f.pilot.stop();
  assert.equal(bad.f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 3, "照旧发回去改");
  assert.ok(bad.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("那个字出现几次", LP.WITHDRAW.wrongInSource)));
  // 她没答出出处里的那个字
  const miss = wrongGoldNight({ faults: (id) => [withdrawFault(id)], answer: "不记得" });
  await miss.f.n.run();
  await miss.f.pilot.stop();
  assert.ok(miss.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("那个字出现几次", LP.WITHDRAW.rightNotInAnswer)));
  // 只没过一轮就要改：不理
  const early = wrongGoldNight({ maxFixRounds: 0, faults: (id) => [withdrawFault(id)] });
  await early.f.n.run();
  await early.f.pilot.stop();
  assert.ok(!early.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(S.leadprompts.correctedHead));
  // 两种说法：默认关着
  const two = wrongGoldNight({ faults: (id) => [withdrawFault(id, { action: "withdraw", evidence: { kind: "two-answers", refs: ["c:8"], answerA: "三次", answerB: "怯" } })] });
  await two.f.n.run();
  await two.f.pilot.stop();
  assert.ok(two.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("那个字出现几次", LP.WITHDRAW.twoAnswersOff)));
  assert.equal(parseTeam({}, { withdrawTwoAnswers: true }).team!.withdrawTwoAnswers, true);
  assert.ok(!("withdrawTwoAnswers" in parseTeam().team!));
  assert.ok(problemsOf(() => parseTeam({}, { withdrawTwoAnswers: "yes" })).some((p) => /withdrawTwoAnswers/.test(p)));
  // 固定要问的题：不能改、不能撤
  const c = contNight({ knows: () => false, maxFixRounds: 2, verdict: (text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/self/2`, fault: "question", action: "correct", why: "撤掉", evidence: gw("周五", "睡前", ["c:7"]) }] } : { pass: true, fixes: [] }) });
  const cres = await c.n.run();
  await c.pilot.stop();
  assert.deepEqual(cres.landed, [], "要点还是没答对：self（required）没过");
  assert.ok(c.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("睡前最后在做什么", LP.WITHDRAW.continuity)));
});

test("C3 night: caps and the rate — at most one fifth of this specialist's new and missed questions (minimum 1, at most 2), team.withdrawCap per night; questions added in a fix round cannot lift the rate over the round-1 set", { timeout: 60_000 }, async () => {
  assert.equal(parseTeam({}, { withdrawCap: 1 }).team!.withdrawCap, 1);
  assert.ok(problemsOf(() => parseTeam({}, { withdrawCap: -1 })).some((p) => /withdrawCap/.test(p)));
  // 3 道 new：五分之一向下取整是 0，最少 1——两道都合条件，只改一道
  const more = [tq("也写错了一", "new", { gold: "「怖」出现三次", sources: ["c:8"] })];
  const one = wrongGoldNight({ extra: more, faults: () => [1, 3].map((i) => withdrawFault(`q:${DAY1}/events/${i}`)) });
  await one.f.n.run();
  await one.f.pilot.stop();
  const rec = JSON.parse(one.f.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { corrected: Array<{ id: string }> };
  assert.deepEqual(rec.corrected.map((x) => x.id), [`q:${DAY1}/events/1`]);
  assert.ok(one.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("也写错了一", LP.WITHDRAW.capStage(1))));
  // 10 道 new / missed：上限 2；一夜的上限 1 的话只改一道
  const ten = Array.from({ length: 8 }, (_, i) => tq(`凑数的题 ${i}`, "new", { sources: ["c:7"] }));
  const capped = wrongGoldNight({ extra: [...more, ...ten], team: { withdrawCap: 1 }, faults: () => [1, 3].map((i) => withdrawFault(`q:${DAY1}/events/${i}`)) });
  await capped.f.n.run();
  await capped.f.pilot.stop();
  assert.ok(capped.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.WITHDRAW.refused("也写错了一", LP.WITHDRAW.capNight(1))));
  const both = wrongGoldNight({ extra: [...more, ...ten], faults: () => [1, 3].map((i) => withdrawFault(`q:${DAY1}/events/${i}`)) });
  const bres = await both.f.n.run();
  await both.f.pilot.stop();
  assert.deepEqual(bres.landed, [DAY1]);
  assert.equal((JSON.parse(both.f.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { corrected: unknown[] }).corrected.length, 2);

  // 复审的例子：第 1 轮 6 道 new，4 对 2 错（0.67）；第 2 轮领导加 3 道容易的、改对一道——全部算是 8/9，第 1 轮那 6 道只有 5/6（0.83 < 0.85）：不算过
  const six = [tq("答不出的一道", "new", { sources: ["c:7"] }), ...Array.from({ length: 4 }, (_, i) => tq(`对的题 ${i}`, "new", { sources: ["c:7"] }))];
  const easy = Array.from({ length: 3 }, (_, i) => tq(`后加的容易题 ${i}`, "new", { sources: ["c:7"] }));
  const dil = wrongGoldNight({ maxFixRounds: 1, extra: six, round2: easy, faults: (id) => [withdrawFault(id)] });
  const dres = await dil.f.n.run();
  await dil.f.pilot.stop();
  assert.deepEqual(dres.landed, []);
  const rows = stageRows(dil.f.n.db).filter((r) => r.stage === "events");
  assert.deepEqual(rows.map((r) => r.status), ["redo", "deferred"]);
  assert.ok(rows[1]!.verdict.includes(LP.CONSIST.belowRoundOne(5 / 6, 0.85)), rows[1]!.verdict);
  assert.ok(dil.f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(S.leadprompts.correctedHead), "那一道确实改了，但第 1 轮的题的得分率还是不到线");
});

// ---------- 第 4 批 C4：改的那一轮少开会话 ----------

test("C4: a fix round with only searchable failures opens exactly one examinee session and one grader — a passed resident question is not sat again unless the round changed what the resident examinee sees", { timeout: 60_000 }, async () => {
  const resident = tq("开头里记着什么", "keep", { layer: "resident", sources: ["SOUL.md:1"], tags: { who: [], events: [], files: ["SOUL.md", "memory/a.md"], lessons: [] } });
  const round1 = [resident, tq("为什么周五交", "new", { sources: ["c:7"], gold: "周五交，因为他要出差" })];
  // 改的那一轮只动了 memory/a.md（不注入）：常驻那层看到的没变
  const f = fixNight({ maxFixRounds: 2, knows: (round) => round >= 2, round1Questions: round1, round2Questions: [] });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  const r1 = f.n.driver.sessions.filter((s) => s.id.startsWith(`exam-${DAY1}-events-1-`) && !s.id.includes("-r2-")).map((s) => s.id.replace(`exam-${DAY1}-events-1-`, ""));
  assert.deepEqual(r1, ["after-resident", "after-searchable", "grade-all", "retake-searchable"], "第 1 轮：两层各一场，判分的一个会话判两轮");
  const r2 = f.n.driver.sessions.filter((s) => s.id.includes("-r2-")).map((s) => s.id.replace(`exam-${DAY1}-events-1-r2-`, ""));
  assert.deepEqual(r2, ["after-searchable", "grade-all"], "第 2 轮：一个考生、一个判分的");
  assert.ok(!f.papers[`exam-${DAY1}-events-1-r2-after-searchable`]!.includes("开头里记着什么"), "常驻的题不放进能查的那一场");
  // 判分的会话一场考试只开一个：整理后、重考都在它里面判
  assert.equal(f.n.driver.sessions.find((s) => s.id === `exam-${DAY1}-events-1-grade-all`)!.sent.length, 2);

  // 改的那一轮动了基础块（常驻那层看到的变了）：过了的常驻题要再考，单独一场、不许查
  const g = fixNight({ maxFixRounds: 2, knows: (round) => round >= 2, round1Questions: round1, round2Questions: [], onFix: () => { g.n.files.set(`sleep/${DAY1}/proposed/SOUL.md`, "我是谁\n这一轮改了开头\n"); } });
  await g.n.run();
  await g.pilot.stop();
  const g2 = g.n.driver.sessions.filter((s) => s.id.includes("-r2-")).map((s) => s.id.replace(`exam-${DAY1}-events-1-r2-`, ""));
  assert.deepEqual(g2, ["after-resident", "after-searchable", "grade-all"]);
  assert.ok(g.papers[`exam-${DAY1}-events-1-r2-after-resident`]!.includes("开头里记着什么") && g.papers[`exam-${DAY1}-events-1-r2-after-resident`]!.includes("不能查"));
  // 上一轮常驻的题没过：这一轮照样单独考（不看这一轮动没动开头）
  const h = fixNight({ maxFixRounds: 1, knows: () => true, round1Questions: round1, round2Questions: [], ans: (sid, q) => (q.includes("开头里记着什么") && !sid.includes("-before-") ? "不记得" : undefined) });
  await h.n.run();
  await h.pilot.stop();
  assert.ok(h.n.driver.sessions.some((s) => s.id === `exam-${DAY1}-events-1-r2-after-resident`));
});

// ---------- 第 4 批修正轮 1：A 组——出处只认原话、动手前的文件、当天的材料 ----------

test("fix1 A: rawSource — a central row, a quote, a workspace path as it was before, or the day's material; everything else under sleep/, absolute paths and .. are refused", () => {
  const n = teamRig();
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', '他说周四交', 5)").run();
  n.files.set(`sleep/${DAY1}/slices/dialogue.md`, "切片第一行\n切片第二行\n");
  n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n专员今晚加的一行\n");
  n.files.set(`sleep/${DAY1}/flow/lead/events.1.diff`, "# 文件\n=== memory/a.md ===\n+ 专员今晚加的一行\n");
  const before = snapOf({});   // 这个专员动手前 proposed/ 里没有 memory/a.md
  const read = (ref: string) => n.hosts.exam!.rawSource(ref, { day: DAY1, before, writes: ["**"] });
  assert.deepEqual(read("c:8"), { kind: "central", text: "他说周四交" });
  assert.deepEqual(read("#8"), { kind: "central", text: "他说周四交" });
  assert.equal(read("c:99"), null);
  assert.deepEqual(read("memory/a.md:1"), { kind: "path", text: "原来的一行" }, "照动手前的样子：工作区里的原文");
  assert.equal(read("memory/a.md:2"), null, "它今晚加的那一行动手前没有");
  assert.deepEqual(read(`sleep/${DAY1}/input.md:1`), { kind: "path", text: "这一天的对话" });
  assert.deepEqual(read(`sleep/${DAY1}/slices/dialogue.md:2`), { kind: "path", text: "切片第二行" });
  // sleep/ 下面别的都不认：引擎抄的那份改动、提案目录、别的日子
  assert.equal(read(`sleep/${DAY1}/flow/lead/events.1.diff:3`), null);
  assert.equal(read(`sleep/${DAY1}/proposed/memory/a.md:2`), null);
  assert.equal(read(`sleep/2026-11-03/input.md:1`), null);
  assert.equal(read("/tmp/hh-lead-rig/memory/a.md:1"), null);
  assert.equal(read("memory/../memory/a.md:1"), null);
  assert.equal(read("e0001"), null);
  // 动手前快照里有的（前面的专员改过的）：照快照
  assert.deepEqual(n.hosts.exam!.rawSource("memory/a.md:2", { day: DAY1, before: snapOf({ "memory/a.md": "原来的一行\n前面的专员加的\n" }), writes: ["**"] }), { kind: "path", text: "前面的专员加的" });
});

test("fix1 Critical 1: the specialist's own change is not evidence and not an outside source — the engine's copy of its diff and the proposed/ path are refused at intake and at withdraw", { timeout: 60_000 }, async () => {
  const diffRef = `sleep/${DAY1}/flow/lead/events.1.diff:3`;
  const propRef = `sleep/${DAY1}/proposed/memory/a.md:2`;
  const replies: string[] = [];
  const f = fixNight({
    maxFixRounds: 1, knows: () => true, round2Questions: [],
    round1Questions: [tq("哪天交", "new", { gold: "周四交", sources: ["c:8", diffRef] }), tq("a 上原来记着什么", "keep")],
    ans: (_sid, q) => (q.includes("哪天交") ? "周五交" : undefined),
    // 领导照它刚读过的那份改动撤题
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/events/1`, fault: "question", action: "withdraw", why: "照改动看是周五", evidence: { kind: "gold-wrong", refs: [diffRef], wrongToken: "周四", rightToken: "周五" } }] } : { pass: true, fixes: [] }),
    onLead: async (s, text) => {
      // 第 1 轮交题时顺便试一道出处只有它自己改动的题：不收
      if (text.includes("lead_review") && !replies.length) {
        const def = s.spec.tools.find((t) => t.name === "lead_review")!;
        replies.push(await def.handler({ intent: [], questions: [tq("只有改动当出处", "new", { sources: [diffRef, propRef] })], checked: true }));
      }
    },
  });
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', '他说周四交', 5)").run();
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.ok(replies[0]!.includes(LP.LEAD_REFUSED.ownChange), replies[0]);
  // 没撤成：她答的周五交是专员写错的，考试抓对了——专员没过（required：这一天不落地）
  assert.deepEqual(res.landed, []);
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "events").map((r) => r.status), ["redo", "deferred"]);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("哪天交", LP.WITHDRAW.refUnreadable)), report.slice(0, 600));
});

test("fix1 Important 7 + minor 7: the excerpt shown to the lead is the first source from outside the change, read as it was before; an old bank question cannot be withdrawn", { timeout: 60_000 }, async () => {
  const n = teamRig({ rawLead: true, stages: FIX_STAGES });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '原话：周五交', 5)").run();
  const replies: string[] = [];
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id.startsWith("sleep-")) {
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "专员把第一行改了\n专员加的第二行\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "交", changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text.includes("lead_review")) {
        const def = s.spec.tools.find((t) => t.name === "lead_review")!;
        const qs = [tq("第二行说什么", "new", { sources: ["memory/a.md:2", "c:7"] }), tq("第一行原来是什么", "missed", { sources: ["memory/a.md:1"] })];
        replies.push(await def.handler({ intent: [], questions: qs }));
        await s.play({ tool: { name: "lead_review", args: { intent: [], questions: qs, checked: true } }, total: USE });
      } else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  const reply = replies[0]!;
  assert.ok(reply.includes("c:7：原话：周五交") && !reply.includes("专员加的第二行"), `头一条是它自己写的那一行：跳过，给原话\n${reply}`);
  assert.ok(reply.includes("memory/a.md:1：原来的一行") && !reply.includes("专员把第一行改了"), "路径照动手前的样子读");

  // 题库里的旧题连着两轮没过：不是今晚出的，不能撤、不能改
  const seeded = fixNight({ maxFixRounds: 2, knows: () => true, round2Questions: [], ans: (_sid, q) => (q.includes("以前的旧题") ? "原来的一行" : undefined), verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: "seed:t/old1", fault: "question", action: "withdraw", why: "x", evidence: { kind: "gold-wrong", refs: ["memory/a.md:1"], wrongToken: "旧答", rightToken: "原来" } }] } : { pass: true, fixes: [] }) });
  seeded.n.hosts.bank.importSeed([{ id: "old1", q: "以前的旧题", gold: "旧答案", evidence: ["memory/a.md:1"] }], { tag: "t", layer: "searchable", day: "2026-11-01" });
  await seeded.n.run();
  await seeded.pilot.stop();
  const rep = seeded.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(!rep.includes(S.leadprompts.withdrawnHead) && !rep.includes("改了标准答案"), rep.slice(0, 500));
  assert.ok(!rep.includes("领导要撤「以前的旧题」"), "不是今晚出的题：连核都不核");
  assert.equal(seeded.n.hosts.bank.get("seed:t/old1")!.status, "active");
});

// ---------- 第 4 批修正轮 1：C 组——领导交了题、没交第二次，题不能丢 ----------

test("fix1 Important 6: the first hand-in's accepted questions are kept; with no second hand-in the lead is nudged with a true sentence and then they are taken, marked as not checked against the source", async () => {
  const excerpt = (q: LeadQuestion): { ref: string; text: string } | null => ({ ref: q.sources[0]!, text: "出处原文" });
  // 交了一次就再也不交：催一次（话是真的），还不交就收下第一次的，标上没核过
  const once = leadHost((s) => { if (s.n === 1) s.review({ intent: [{ target: "x", what: "y", fix: "" }], questions: [lq({ q: "新的一道", probe: "new" }), lq({ q: "旧的一道", probe: "keep" })] }); s.turnEnd(true); });
  const r = await reviewOf(leadFor(once, { excerpt }).lead);
  assert.deepEqual(once.wakes[0]!.slice(1), [S.leadprompts.nudge.check]);
  assert.deepEqual(r!.questions.map((q) => q.q), ["新的一道", "旧的一道"]);
  assert.equal(r!.unchecked, true);
  assert.deepEqual(r!.intent, [{ target: "x", what: "y", fix: "" }]);
  // 先交 keep 的（当场收）、再交 new 的（出处贴回去、没收），这一轮就结束了：new 的不能悄悄丢
  const silent = leadHost((s) => {
    if (s.n === 1) { s.review({ intent: [], questions: [lq({ q: "旧的一道", probe: "keep" })] }); s.review({ intent: [], questions: [lq({ q: "新的一道", probe: "missed" })] }); }
    s.turnEnd(true);
  });
  const r2 = await reviewOf(leadFor(silent, { excerpt }).lead);
  assert.deepEqual(silent.wakes[0]!.slice(1), [S.leadprompts.nudge.check], "手上有收下的题也照样催一次");
  assert.deepEqual(r2!.questions.map((q) => [q.q, q.probe]), [["旧的一道", "keep"], ["新的一道", "missed"]]);
  assert.equal(r2!.unchecked, true);
  // 这一份等到时限也没交第二次：收下第一次的
  const stuck = leadHost((s) => { if (s.n === 1) s.review({ intent: [], questions: [lq({ q: "新的一道", probe: "new" })] }); });
  const st = leadFor(stuck, { excerpt });
  const p = reviewOf(st.lead);
  await new Promise((res) => setTimeout(res, 0));
  st.timers.shift()?.();
  const r3 = await p;
  assert.deepEqual([r3!.questions.map((q) => q.q), r3!.unchecked], [["新的一道"], true]);
  // 照规矩交了两次的：没有这个标记
  const good = leadHost((s) => { if (s.n === 1) { s.review({ intent: [], questions: [lq({ probe: "new" })] }); s.review({ intent: [], questions: [lq({ probe: "new" })], checked: true }); } s.turnEnd(true); });
  const r4 = await reviewOf(leadFor(good, { excerpt }).lead);
  assert.ok(r4 && !("unchecked" in r4) && r4.questions.length === 1);
  // 催了以后交的那一次照常收（那就是第二次），不标
  const late = leadHost((s) => { s.review({ intent: [], questions: [lq({ probe: "new" })] }); s.turnEnd(true); });
  const r5 = await reviewOf(leadFor(late, { excerpt }).lead);
  assert.ok(r5 && !("unchecked" in r5));
});

test("fix1 Important 6 night: questions taken without the second hand-in are examined and the report says they were not checked against the source", { timeout: 30_000 }, async () => {
  const n = teamRig({ rawLead: true, stages: FIX_STAGES });
  n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'main', 'input', '原话', 5)").run();
  const pilot = autopilot(n.driver, async (s, text) => {
    if (s.id.startsWith("sleep-")) {
      n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n加了一行\n");
      await s.play({ tool: { name: "stage_done", args: { status: "done", report: "交", changes: [] } }, total: USE });
    } else if (s.id.startsWith("lead-")) {
      if (text === S.leadprompts.nudge.check) await s.play({ say: "（没再交）", total: USE });
      else if (text.includes("lead_review")) await s.play({ tool: { name: "lead_review", args: { intent: [], questions: [tq("今天定了什么", "new", { sources: ["c:7"] })] } }, total: USE });
      else await s.play({ tool: { name: "lead_verdict", args: { pass: true, fixes: [] } }, total: USE });
    } else if (s.id.includes("-grade-")) await s.play(gradeAll(text));
    else if (s.id.startsWith("exam-")) await s.play(answerAll(text, () => "对的"));
  });
  const res = await n.run();
  await pilot.stop();
  assert.deepEqual(pilot.errors, []);
  assert.deepEqual(res.landed, [DAY1]);
  assert.ok(n.driver.sessions.some((s) => s.id === `exam-${DAY1}-events-1-after-searchable`), "题照样考了");
  assert.ok(n.files.get(`sleep/${DAY1}/report.md`)!.includes(LP.UNCHECKED("事件")));
});

// ---------- 第 4 批修正轮 1：D 组 ----------

test("fix1 minor 8: a finish-side rebuild since the last sitting counts as a changed resident view — passed resident questions the round touched are sat again", { timeout: 60_000 }, async () => {
  const build = { replayFinish: [["python3", "scripts/build.py", "{day}"]] };
  // self 每轮只改一个不注入的文件；它那道过了的常驻题挂在这个文件上
  const withBuild = contNight({ knows: (round) => round >= 2, replay: true, flow: build, selfFile: "memory/self.md", selfLayer: "resident" });
  await withBuild.n.run();
  await withBuild.pilot.stop();
  assert.deepEqual(withBuild.pilot.errors, []);
  const paper = (f: ReturnType<typeof contNight>): string => f.papers[`exam-${DAY1}-self-1-r2-after-resident`] ?? "";
  assert.ok(paper(withBuild).includes("1 记着什么"), `回放里落地那几步拼过工作区了：常驻那层看到的可能变了，第 1 轮过了的那道再考\n${paper(withBuild)}`);
  // 真的夜里（没拼过）：这一轮没动常驻那层看得到的，第 1 轮过了的那道不再考（领导第 2 轮新出的那道照考）
  const real = contNight({ knows: (round) => round >= 2, selfFile: "memory/self.md", selfLayer: "resident" });
  await real.n.run();
  await real.pilot.stop();
  assert.ok(paper(real).length > 0 && !paper(real).includes("1 记着什么"), paper(real));
});

// ---------- 第 4 批修正轮 2：出处的路径照实际落在哪儿认；改标准答案得拴在读得出的出处上 ----------
import { mkdirSync as mkdirFix2, symlinkSync as symlinkFix2, writeFileSync as writeFix2, realpathSync as realFix2 } from "node:fs";
import { posix as posixFix2 } from "node:path";
import { outsidePath } from "../src/sleep/host.ts";
import { S } from "../src/lang/index.ts";

test("fix2 N1 outsidePath: a ref path is judged by where it lands — other spellings, another case and symlinks cannot reach the proposal, the engine's records or another day", () => {
  const W = realFix2(mkdtempSync(join(tmpdir(), "hh-fix2-ws-")));
  for (const d of [`sleep/${DAY1}/flow/lead`, `sleep/${DAY1}/proposed/memory`, `sleep/${DAY1}/slices`, "sleep/2026-11-03", "memory"]) mkdirFix2(join(W, d), { recursive: true });
  writeFix2(join(W, `sleep/${DAY1}/flow/lead/events.1.diff`), "+ 今晚加的\n");
  writeFix2(join(W, `sleep/${DAY1}/proposed/memory/a.md`), "原来的一行\n今晚加的\n");
  writeFix2(join(W, `sleep/${DAY1}/input.md`), "这一天的对话\n");
  writeFix2(join(W, `sleep/${DAY1}/slices/dialogue.md`), "切片\n");
  writeFix2(join(W, "sleep/2026-11-03/input.md"), "别的日子\n");
  writeFix2(join(W, "memory/a.md"), "原来的一行\n");
  // 软链：工作区里一个指到引擎记录的、一个指到提案里那个文件的；提案目录里一个指出去的
  symlinkFix2(join(W, `sleep/${DAY1}/flow`), join(W, "memory/peek"));
  symlinkFix2(join(W, `sleep/${DAY1}/proposed/memory/a.md`), join(W, "link.md"));
  symlinkFix2(join(W, `sleep/${DAY1}/flow/lead/events.1.diff`), join(W, `sleep/${DAY1}/proposed/memory/own.md`));
  symlinkFix2(join(W, `sleep/${DAY1}/proposed`), join(W, `sleep/${DAY1}/slices/p`));
  const at = (p: string) => outsidePath(p, DAY1, W);
  // 认的：给回理顺过的写法
  assert.equal(at("memory/a.md"), "memory/a.md");
  assert.equal(at("./memory/a.md"), "memory/a.md");
  assert.equal(at("memory//a.md"), "memory/a.md");
  assert.equal(at("memory/./a.md"), "memory/a.md");
  assert.equal(at("memory/new.md"), "memory/new.md", "盘上没有的：读不出来是读的事");
  assert.equal(at(`sleep/${DAY1}/input.md`), `sleep/${DAY1}/input.md`);
  assert.equal(at(`./sleep//${DAY1}/slices/dialogue.md`), `sleep/${DAY1}/slices/dialogue.md`);
  // 不认的：sleep/ 下面别的，怎么写都一样
  const diff = `${DAY1}/flow/lead/events.1.diff`, prop = `${DAY1}/proposed/memory/a.md`;
  for (const p of [`sleep/${diff}`, `./sleep/${diff}`, `Sleep/${diff}`, `SLEEP/${diff}`, `sleep//${diff}`, `sleep/./${diff}`, `a/../sleep/${diff}`, `memory/../sleep/${diff}`,
    `sleep/${prop}`, `./sleep/${prop}`, `Sleep/${prop}`, `.//SLEEP/${prop}`, `sleep/${DAY1}//proposed/memory/a.md`, `sleep/2026-11-03/input.md`, `./Sleep/2026-11-03/input.md`,
    `Sleep/${DAY1}/input.md`, `sleep/${DAY1}/slices/../flow/lead/events.1.diff`, `sleep/${DAY1}/slices/p/memory/a.md`, "sleep", "./", "", "/etc/hosts", join(W, "memory/a.md"), "../x.md"]) assert.equal(at(p), null, p);
  // 绕软链落到那里的不认
  assert.equal(at("memory/peek/lead/events.1.diff"), null, "工作区里的软链指到引擎的记录");
  assert.equal(at("link.md"), null, "工作区里的软链指到提案");
  assert.equal(at("memory/own.md"), null, "提案目录里那个位置是个指出去的软链");
  // 盘上有、大小写写得不一样的不认（不然「动手以前的样子」会照错的写法找到今晚写的）
  assert.equal(at("Memory/a.md"), null);
  assert.equal(at("memory/A.md"), null);
});

/** 像不分大小写的盘那样读：路径理顺、不分大小写（内存里的假文件系统本来只认一字不差的键） */
function looseFs(n: ReturnType<typeof teamRig>): void {
  const find = (p: string): string | null => {
    const want = posixFix2.normalize(p.startsWith("/tmp/hh-lead-rig/") ? p.slice("/tmp/hh-lead-rig/".length) : p).toLowerCase();
    for (const [k, v] of n.files) if (k.toLowerCase() === want) return v;
    return null;
  };
  (n.b.fs as { read: (p: string) => string | null }).read = find;
  (n.b as { readText: (p: string) => string | null }).readText = find;
}

test("fix2 N1 rawSource: ./sleep/…, Sleep/…, a/../sleep/…, sleep//… do not read the specialist's own change; a normalised workspace path is still read as it was before", () => {
  const n = teamRig();
  looseFs(n);
  n.files.set(`sleep/${DAY1}/slices/dialogue.md`, "切片第一行\n切片第二行\n");
  n.files.set(`sleep/${DAY1}/proposed/memory/a.md`, "原来的一行\n专员今晚加的一行\n");
  n.files.set(`sleep/${DAY1}/flow/lead/events.1.diff`, "# 文件\n=== memory/a.md ===\n+ 专员今晚加的一行\n");
  // 这个专员只能写 memory/ 下面：写法不对的路径以前会被当成「不在它范围里」，去读提案里它今晚写的
  const read = (ref: string) => n.hosts.exam!.rawSource(ref, { day: DAY1, before: snapOf({}), writes: ["memory/**"] });
  const diff = `${DAY1}/flow/lead/events.1.diff:3`, prop = `${DAY1}/proposed/memory/a.md:2`;
  for (const ref of [`./sleep/${diff}`, `Sleep/${diff}`, `SLEEP/${diff}`, `a/../sleep/${diff}`, `sleep//${diff}`, `sleep/./${diff}`, `./sleep/${prop}`, `SLEEP/${prop}`, `sleep//${prop}`, `Sleep/${DAY1}/input.md:1`]) assert.equal(read(ref), null, ref);
  for (const ref of ["./memory/a.md:2", "memory//a.md:2", "memory/./a.md:2"]) assert.equal(read(ref), null, `它今晚加的那一行：${ref}`);
  for (const ref of ["./memory/a.md:1", "memory//a.md:1"]) assert.deepEqual(read(ref), { kind: "path", text: "原来的一行" }, ref);
  assert.deepEqual(read(`./sleep/${DAY1}/slices//dialogue.md:2`), { kind: "path", text: "切片第二行" });
  assert.deepEqual(read(`./sleep/${DAY1}/input.md:1`), { kind: "path", text: "这一天的对话" });
});

test("fix2 N1 night: the diff and the proposal under another spelling are refused at intake, are not shown to the lead as the excerpt, and are not evidence for a correction", { timeout: 60_000 }, async () => {
  const spellings = [`./sleep/${DAY1}/flow/lead/events.1.diff:3`, `Sleep/${DAY1}/flow/lead/events.1.diff:3`, `a/../sleep/${DAY1}/flow/lead/events.1.diff:3`, `sleep//${DAY1}/flow/lead/events.1.diff:3`, `./sleep/${DAY1}/proposed/memory/a.md:2`, `SLEEP/${DAY1}/proposed/memory/a.md:2`];
  const diffRef = spellings[0]!;
  const replies: string[] = [];
  const f = fixNight({
    maxFixRounds: 1, knows: () => true, round2Questions: [],
    round1Questions: [tq("哪天交", "new", { gold: "周四交", sources: ["c:8", diffRef] }), tq("a 上原来记着什么", "keep")],
    ans: (_sid, q) => (q.includes("哪天交") ? "周五交" : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: `q:${DAY1}/events/1`, fault: "question", action: "correct", why: "照改动看是周五", evidence: { kind: "gold-wrong", refs: [diffRef], wrongToken: "周四", rightToken: "周五" } }] } : { pass: true, fixes: [] }),
    onLead: async (s, text) => {
      if (text.includes("lead_review") && !replies.length) {
        const def = s.spec.tools.find((t) => t.name === "lead_review")!;
        for (const ref of spellings) replies.push(await def.handler({ intent: [], questions: [tq("只有改动当出处", "new", { gold: "周五交", sources: [ref] })], checked: true }));
        // 头一条出处是它自己的改动（换了写法）：贴给领导看的原文得跳过它
        replies.push(await def.handler({ intent: [], questions: [tq("两条出处", "new", { gold: "周四交", sources: [diffRef, "c:8"] })] }));
      }
    },
  });
  looseFs(f.n);
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', '他说周四交', 5)").run();
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.equal(replies.length, spellings.length + 1);
  // 带 .. 的那一种在更前面就被当成查不到的出处退了；别的都是「只有它自己的改动当出处」
  spellings.forEach((ref, i) => assert.ok(replies[i]!.startsWith("一道都没收") && (replies[i]!.includes(LP.LEAD_REFUSED.ownChange) || (ref.includes("..") && replies[i]!.includes("出处都查不到"))), `${ref}\n${replies[i]}`));
  assert.ok(replies.at(-1)!.includes("c:8：他说周四交") && !replies.at(-1)!.includes("今天定了周五交"), replies.at(-1));
  assert.deepEqual(res.landed, []);
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "events").map((r) => r.status), ["redo", "deferred"]);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("哪天交", LP.WITHDRAW.refUnreadable)) && !report.includes(S.leadprompts.correctedHead), report.slice(0, 600));
  assert.equal(f.n.hosts.bank.get(`q:${DAY1}/events/1`)!.gold, "周四交");
});

test("fix2 N2 withdrawProblem: an own source the engine cannot read refuses the correction; the right token must stand where the evidence talks about the same thing", () => {
  assert.equal(wd(), null, "「怖 / 怯」照旧收");
  // 自己的出处里有读不出原文的（事件编号这类）：不动
  assert.equal(wd({ sources: ["c:8", "e0001"], own: [SRC, null] }), LP.WITHDRAW.ownUnreadable(["e0001"]));
  assert.equal(wd({ sources: ["c:8", "e0001", "q12"], own: [SRC, null, null] }), LP.WITHDRAW.ownUnreadable(["e0001", "q12"]));
  assert.equal(wd({ sources: ["c:8", "e0001"], own: [SRC] }), LP.WITHDRAW.ownUnreadable(["e0001"]), "少给了一条：照读不出算");
  const both = { gold: "出现三次", texts: ["有人说三次，有人说两次"], evidence: { kind: "two-answers" as const, refs: ["c:8"], answerA: "三次", answerB: "两次" }, twoAnswers: true, answers: ["两次", "两次"] };
  assert.equal(wd({ ...both, sources: ["c:8"], own: ["有人说三次，有人说两次"] }), null);
  assert.equal(wd({ ...both, sources: ["c:8", "e0001"], own: ["有人说三次，有人说两次", null] }), LP.WITHDRAW.ownUnreadable(["e0001"]), "两种说法那一种也一样");
  // 复审的那一例，就算出处都读得出：c:9 说的是周五开会，不是报告哪天交
  const meeting = { gold: "周四交报告", stem: "报告哪天交", answers: ["周五交报告", "周五交报告"], sources: ["c:9"], own: ["周五要开会"], texts: ["周五要开会"], evidence: gw("周四", "周五", ["c:9"]) };
  assert.equal(wd(meeting), LP.WITHDRAW.rightElsewhere);
  assert.equal(wd({ ...meeting, own: ["周五要交报告"], texts: ["周五要交报告"] }), null, "同一件事：收");
  // 两条证据：对的那个词在一条里，标准答案别的字在另一条里——不算
  assert.equal(wd({ ...meeting, sources: ["c:9", "c:10"], own: ["周五要开会", "报告还没写"], texts: ["周五要开会", "报告还没写"], evidence: gw("周四", "周五", ["c:9", "c:10"]) }), LP.WITHDRAW.rightElsewhere);
});

/** 复审重现的那一夜：旧事件说周四交，今天的一行说周五开会，专员写成周五交报告；领导照 c:9 要把标准答案的周四改成周五 */
function conflationNight(o: { support: "event" | "row" }) {
  const QID = `q:${DAY1}/events/1`;
  const f = fixNight({
    maxFixRounds: 2, knows: () => true, round2Questions: [],
    round1Questions: [tq("报告哪天交", "new", { gold: "周四交报告", sources: ["SUPPORT", "c:9"] }), tq("a 上原来记着什么", "keep")],
    ans: (_sid, q) => (q.includes("报告哪天交") ? "周五交报告" : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: QID, fault: "question", action: "correct", why: "出处 c:9 说的是周五", evidence: gw("周四", "周五", ["c:9"]) }] } : { pass: true, fixes: [] }),
  });
  const e = f.n.m.store.createEvent({ title: "交报告", summary: "老板定了报告周四交", gist: "报告周四交", importance: 3 }, "seed");
  f.n.m.store.commitBatch("seed");
  const support = o.support === "event" ? e.id : "c:6";
  const bank = f.n.hosts.bank;
  const add0 = bank.addPending.bind(bank);
  bank.addPending = ((day: string, stage: string, qs: Question[]) => add0(day, stage, qs.map((q) => ({ ...q, sources: q.sources.map((s) => (s === "SUPPORT" ? support : s)) })))) as typeof bank.addPending;
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (6, 1, 1, 'main', 'input', '老板：报告周四交', 5)").run();
  // 这一行里对的那个词和标准答案别的字都有（「周五」「报告」）：机械的那几条它都过得去，拦它的只有自己的出处那两条
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (9, 1, 1, 'main', 'input', '周五要开会，报告的事会上说', 5)").run();
  return { f, QID, support };
}

test("fix2 N2 night: the gold's support is an event id the engine cannot read — the correction is refused, the answer fault stands, the specialist is sent back and dropped, and the record says why", { timeout: 60_000 }, async () => {
  const { f, QID, support } = conflationNight({ support: "event" });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.match(support, /^e\d+$/);
  assert.deepEqual(res.landed, [], "专员把两件事并成了一件，考试抓对了：不落地");
  assert.deepEqual(stageRows(f.n.db).filter((r) => r.stage === "events").map((r) => r.status), ["redo", "redo", "deferred"]);
  assert.equal(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 3, "照答的毛病发回去改");
  const why = LP.WITHDRAW.ownUnreadable([support]);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("报告哪天交", why)) && !report.includes(S.leadprompts.correctedHead), report.slice(0, 800));
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "周四交报告", "标准答案没动");
  const rec = JSON.parse(f.n.files.get(`sleep/${DAY1}/flow/lead/events.json`)!) as { corrected?: unknown; refused: Array<{ id: string; q: string; why: string }> };
  assert.equal(rec.corrected, undefined);
  assert.ok(rec.refused.length >= 1 && rec.refused.every((r) => r.id === QID && r.q === "报告哪天交" && r.why === why), JSON.stringify(rec.refused));
  // 定夺那一份里领导看得见哪条读不出、也说了这样的不能改
  const brief = f.leadWakes.find((t) => t.includes(S.leadprompts.twice.head))!;
  assert.ok(brief.includes(`出处 ${support}：（读不出原文）`) && brief.includes("读不出原文的"), brief);
});

test("fix2 N2 night: the same case with the support readable — the wrong token stands in another own source, so the gold is supported and stays", { timeout: 60_000 }, async () => {
  const { f, QID } = conflationNight({ support: "row" });
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.deepEqual(res.landed, []);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("报告哪天交", LP.WITHDRAW.wrongInOwnSource)) && !report.includes(S.leadprompts.correctedHead), report.slice(0, 800));
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "周四交报告");
});

// ---------- 第 4 批修正轮 2：补钉子 ----------

test("fix2 pin: an old bank question that was right before and fails twice after reaches the lead's verdict, and a correction asked for it is not even checked — only tonight's own questions can be touched", { timeout: 60_000 }, async () => {
  const OLD = "seed:t/old1";
  const f = fixNight({
    maxFixRounds: 2, knows: () => true, round2Questions: [],
    // 整理前答得对（标准答案那个字），整理后两轮都答成出处里的那个字：机械的几条全过得去，拦它的只有「不是今晚出的题」
    ans: (sid, q) => (q.includes("以前的旧题") ? (sid.includes("-before-") ? "「怖」出现三次" : "「怯」出现三次") : undefined),
    verdict: (_round, text) => (text.includes(S.leadprompts.twice.head) ? { pass: false, fixes: [], faults: [{ id: OLD, fault: "question", action: "correct", why: "字写错了", evidence: gw("怖", "怯") }] } : { pass: true, fixes: [] }),
  });
  f.n.hosts.bank.importSeed([{ id: "old1", q: "以前的旧题", gold: "「怖」出现三次", evidence: ["memory/a.md:1", "c:8"] }], { tag: "t", layer: "searchable", day: "2026-11-01" });
  f.n.db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (8, 1, 1, 'main', 'input', ?, 5)").run(SRC);
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  const brief = f.leadWakes.find((t) => t.includes(S.leadprompts.twice.head));
  assert.ok(brief && brief.slice(brief.indexOf(S.leadprompts.twice.head)).includes(`- ${OLD}　以前的旧题`), "这道旧题真的连着两轮没过、到了领导手里");
  assert.deepEqual(res.landed, []);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(!report.includes(S.leadprompts.correctedHead) && !report.includes(S.leadprompts.withdrawnHead), report.slice(0, 600));
  assert.ok(!report.includes("领导要撤「以前的旧题」"), "连核都不核");
  assert.equal(f.n.hosts.bank.get(OLD)!.gold, "「怖」出现三次");
  assert.equal(f.n.hosts.bank.get(OLD)!.status, "active");
  assert.equal(f.n.driver.sessions.filter((s) => s.id.includes("-grade-all")).every((s) => !s.sent.some((m) => m.text.includes("标准答案：「怯」出现三次"))), true, "没有照改过的标准答案重判");
});

/** 照改过的标准答案重判的那一轮（判分会话收到「标准答案：「怯」出现三次」）换一个演法；which 挑哪些判分会话 */
function onRegrade(driver: FakeDriver, which: (id: string) => boolean, script: (text: string) => Record<string, unknown>): string[] {
  const hit: string[] = [];
  const open0 = driver.open.bind(driver);
  driver.open = (spec) => {
    const s = open0(spec) as FakeSession;
    if (s.id.includes("-grade-") && which(s.id)) {
      const play0 = s.play.bind(s);
      s.play = async (sc) => {
        const text = s.sent.at(-1)?.text ?? "";
        if (!text.includes("标准答案：「怯」出现三次")) return play0(sc);
        hit.push(s.id);
        return play0(script(text) as never);
      };
    }
    return s;
  };
  return hit;
}

test("fix2 pin: a re-mark that is only partly right is not a correction — the gold stays, the specialist is sent back", { timeout: 60_000 }, async () => {
  const { f, QID } = wrongGoldNight({ faults: (id) => [withdrawFault(id)] });
  const hit = onRegrade(f.n.driver, () => true, () => ({ tool: { name: "exam_grades", args: { layers: [], grades: [{ id: QID, verdict: "partial", reason: "只对了一半" }] } }, total: USE }));
  const res = await f.n.run();
  await f.pilot.stop();
  assert.deepEqual(f.pilot.errors, []);
  assert.ok(hit.length >= 1, "重判那一轮真的演到了");
  assert.deepEqual(res.landed, []);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("那个字出现几次", LP.WITHDRAW.stillWrong("「怯」出现三次"))) && !report.includes(S.leadprompts.correctedHead), report.slice(0, 600));
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "「怖」出现三次");
  assert.equal(f.n.driver.sessions.find((s) => s.id === `sleep-${DAY1}-events-1`)!.sent.length, 3, "照答的毛病发回去改");
  assert.equal(f.n.hosts.sessions.size, 0);
});

test("fix2 pin: the grader dies on the re-mark and so does its replacement — no correction, fail closed, no session left open", { timeout: 60_000 }, async () => {
  const { f, QID } = wrongGoldNight({ faults: (id) => [withdrawFault(id)] });
  const hit = onRegrade(f.n.driver, () => true, () => ({ fail: "grader died" }));
  const res = await f.n.run();
  await f.pilot.stop();
  assert.ok(new Set(hit).size >= 2, `原来的和顶替的都演到了：${hit.join(" ")}`);
  assert.deepEqual(res.landed, []);
  const report = f.n.files.get(`sleep/${DAY1}/report.md`)!;
  assert.ok(report.includes(LP.WITHDRAW.refused("那个字出现几次", LP.WITHDRAW.noGrader)) && !report.includes(S.leadprompts.correctedHead), report.slice(0, 600));
  assert.equal(f.n.hosts.bank.get(QID)!.gold, "「怖」出现三次");
  assert.equal(f.n.driver.sessions.filter((s) => s.id.includes("-grade-")).every((s) => s.closed), true, "判分的会话都关了");
  assert.equal(f.n.hosts.sessions.size, 0);
});

test("fix2 pin: the grader dies on the re-mark but its replacement marks it — the correction stands", { timeout: 60_000 }, async () => {
  const { f, QID } = wrongGoldNight({ faults: (id) => [withdrawFault(id)] });
  const hit = onRegrade(f.n.driver, (id) => id.endsWith("-grade-all"), () => ({ fail: "grader died" }));
  const res = await f.n.run();
  await f.pilot.stop();
  assert.ok(hit.length >= 1);
  assert.deepEqual(res.landed, [DAY1]);
  assert.ok(f.n.files.get(`sleep/${DAY1}/report.md`)!.includes(S.leadprompts.correctedHead));
  assert.equal(f.n.hosts.bank.get(QID)!.status, "dropped");
  assert.equal(f.n.driver.sessions.filter((s) => s.id.includes("-grade-")).every((s) => s.closed), true);
  assert.equal(f.n.hosts.sessions.size, 0);
});
