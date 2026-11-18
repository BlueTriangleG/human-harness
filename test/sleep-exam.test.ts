// 夜里考试：题库（表和 Bank）。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb, MIGRATIONS, all, one } from "../src/store/db.ts";
import { Bank, SCORE, type QuestionIn, type Tags } from "../src/sleep/bank.ts";

const noTags = (t: Partial<Tags> = {}): Tags => ({ who: [], events: [], files: [], lessons: [], ...t });
const qin = (q: string, o: Partial<QuestionIn> = {}): QuestionIn => ({
  q, gold: `${q}-gold`, accept: `${q}-accept`, sources: [], tags: noTags(), importance: 3,
  kind: "fact", layer: "searchable", isNew: true, ...o,
});
const mkBank = (t = { v: 1000 }) => {
  const db = openDb(":memory:");
  return { db, t, bank: new Bank(db, () => t.v) };
};

test("bank: pending → active, numbering continues across attempts", () => {
  const { bank } = mkBank();
  const day = "2026-11-05";
  assert.deepEqual(bank.addPending(day, "events", [qin("a"), qin("b"), qin("c")]),
    [1, 2, 3].map((n) => `q:${day}/events/${n}`));
  assert.deepEqual(bank.addPending(day, "events", [qin("d"), qin("e")]),
    [4, 5].map((n) => `q:${day}/events/${n}`));
  assert.equal(bank.pending(day, "events").length, 5);
  assert.equal(bank.activate(day, ["events"]), 5);
  assert.equal(bank.pending(day).length, 0);
  for (let n = 1; n <= 5; n++) assert.equal(bank.get(`q:${day}/events/${n}`)!.status, "active");
  assert.equal(bank.get("nope"), null);
});

test("bank: dropPending keeps the deferred stages", () => {
  const { bank, db } = mkBank();
  const day = "2026-11-05";
  bank.addPending(day, "events", [qin("a"), qin("b")]);
  bank.addPending(day, "soul", [qin("c")]);
  assert.equal(bank.dropPending(day, ["soul"]), 2);
  const left = bank.pending(day);
  assert.equal(left.length, 1);
  assert.equal(left[0]!.stage, "soul");
  const rows = all<{ stage: string; status: string }>(db, "SELECT stage, status FROM exam_q ORDER BY rowid");
  assert.deepEqual(rows.map((r) => r.status), ["dropped", "dropped", "pending"]);
});

test("bank: numbering continues after a full dropPending", () => {
  const { bank } = mkBank();
  const day = "2026-11-05";
  bank.addPending(day, "events", [qin("a"), qin("b")]);
  bank.dropPending(day, []);
  assert.deepEqual(bank.addPending(day, "events", [qin("c")]), [`q:${day}/events/3`]);
  assert.equal(bank.pending(day).length, 1);
});

test("bank: addOp needs a reason", () => {
  const { bank } = mkBank();
  const day = "2026-11-05";
  for (const why of ["", "   \n"]) {
    assert.throws(() => bank.addOp(day, "s", { kind: "retire", q: "x", why }));
    assert.throws(() => bank.addOp(day, "s", { kind: "revise", q: "x", gold: "g", why }));
    assert.throws(() => bank.addOp(day, "s", { kind: "layer", q: "x", layer: "archive", why }));
  }
});

test("bank: revise op keeps the old gold; op on a missing question is dropped", () => {
  const { bank, db } = mkBank();
  const day = "2026-11-05";
  const [id] = bank.addPending("2026-11-01", "e", [qin("a")]);
  bank.activate("2026-11-01", ["e"]);
  bank.addOp(day, "e", { kind: "revise", q: id!, gold: "new", why: "w" });
  bank.addOp(day, "e", { kind: "retire", q: "q:missing/1", why: "w" });
  bank.activate(day, ["e"]);
  const ops = all<{ status: string; value: string }>(db, "SELECT status, value FROM exam_op ORDER BY id");
  assert.deepEqual(ops.map((o) => o.status), ["applied", "dropped"]);
  assert.equal(JSON.parse(ops[0]!.value).from, "a-gold");
});

test("bank: touching() caps by importance then staleness", () => {
  const { bank, t } = mkBank();
  const day = "2026-11-05";
  const file = "soul/80-x.md";
  const ids = bank.addPending(day, "soul", [5, 5, 3, 3, 2, 1].map((imp, i) =>
    qin(`q${i}`, { importance: imp, tags: noTags({ files: [file] }) })));
  bank.addPending(day, "soul", [qin("other", { importance: 5, tags: noTags({ files: ["other.md"] }) })]);
  bank.activate(day, ["soul"]);
  t.v = 5000;
  bank.record({ q: ids[0]!, day, stage: "soul", phase: "after", layer: "searchable", verdict: "right", reason: "", answer: "" });
  const got = bank.touching({ files: [file] }, 3);
  assert.deepEqual(got.map((q) => q.id), [ids[1], ids[0], ids[2]]);
  assert.equal(bank.get(ids[0]!)!.lastExamined, 5000);
  assert.equal(bank.touching({ files: ["nothing"] }, 3).length, 0);
  assert.equal(bank.touching({}, 3).length, 0);
});

test("bank: ops apply on activate", () => {
  const { bank, db } = mkBank();
  const day = "2026-11-05";
  const old = bank.addPending("2026-11-01", "events", [qin("a"), qin("b"), qin("c")]);
  bank.activate("2026-11-01", ["events"]);
  bank.addOp(day, "events", { kind: "revise", q: old[0]!, gold: "new gold", why: "changed" });
  bank.addOp(day, "events", { kind: "retire", q: old[1]!, why: "obsolete" });
  bank.addOp(day, "events", { kind: "layer", q: old[2]!, layer: "archive", why: "cold" });
  bank.addOp(day, "soul", { kind: "retire", q: old[2]!, why: "dropped one" });
  // 改了以后还没落地：旧题不变
  assert.equal(bank.get(old[0]!)!.gold, "a-gold");
  bank.activate(day, ["events"]);
  assert.equal(bank.get(old[0]!)!.gold, "new gold");
  assert.equal(bank.get(old[1]!)!.status, "retired");
  assert.ok(one<{ retired_why: string }>(db, "SELECT retired_why FROM exam_q WHERE id = ?", old[1]!)!.retired_why.length > 0);
  assert.equal(bank.get(old[2]!)!.layer, "archive");
  assert.equal(bank.get(old[2]!)!.status, "active");
  bank.dropPending(day, []);
  const st = all<{ stage: string; status: string }>(db, "SELECT stage, status FROM exam_op ORDER BY id");
  assert.deepEqual(st.map((r) => r.status), ["applied", "applied", "applied", "dropped"]);
});

test("bank: importSeed maps the checkup format", () => {
  const { bank } = mkBank();
  const raw = [
    { id: "q01", type: "abstain", q: "Q1", gold: "G1", accept: "A1", evidence: ["e0017"], importance: 3 },
    { id: "q02", type: "people", q: "Q2", gold: "G2", accept: "A2", evidence: [], importance: 2, factDate: "2026-10-01" },
    { id: "q03", type: "temporal", q: "Q3", gold: "G3", accept: "A3", evidence: ["e1"], importance: 4 },
    { id: "q04", type: "weird", q: "Q4", gold: "G4", accept: "A4", evidence: [], importance: 1 },
    { id: "q05", type: "taste", q: "Q5", gold: "G5", accept: "A5", evidence: [], importance: 1 },
    { id: "q06", type: "update", q: "Q6", gold: "G6", accept: "A6", evidence: [], importance: 1 },
  ];
  assert.equal(bank.importSeed(raw, { tag: "t1", layer: "resident", day: "2026-11-06" }), 6);
  const a = bank.get("seed:t1/q01")!;
  assert.equal(a.kind, "unsure");
  assert.deepEqual(a.sources, ["e0017"]);
  assert.equal(a.status, "active");
  assert.equal(a.layer, "resident");
  assert.equal(a.importance, 3);
  assert.equal(bank.get("seed:t1/q02")!.kind, "feeling");
  assert.deepEqual(["q03", "q04", "q05", "q06"].map((k) => bank.get(`seed:t1/${k}`)!.kind), ["fact", "fact", "taste", "update"]);
  // 重复导入不重复
  assert.equal(bank.importSeed(raw, { tag: "t1", layer: "resident", day: "2026-11-06" }), 0);
  assert.throws(() => bank.importSeed({ not: "array" }, { tag: "t", layer: "resident", day: "d" }));
});

test("bank: sample and stats", () => {
  const { bank } = mkBank();
  const day = "2026-11-05";
  const ids = bank.addPending(day, "x", [qin("a", { layer: "resident" }), qin("b"), qin("c"), qin("d", { layer: "archive" })]);
  bank.addPending(day, "y", [qin("pend")]);
  bank.activate(day, ["x"]);
  const s = bank.sample(2, () => 0, new Set([ids[0]!]));
  assert.equal(s.length, 2);
  assert.ok(!s.some((q) => q.id === ids[0]));
  assert.equal(bank.sample(10, Math.random, new Set()).length, 4);
  const rec = (q: string, verdict: "right" | "wrong", layer: "resident" | "searchable") =>
    bank.record({ q, day, stage: "x", phase: "after", layer, verdict, reason: "", answer: "" });
  rec(ids[0]!, "right", "resident");
  rec(ids[1]!, "right", "searchable");
  rec(ids[2]!, "wrong", "searchable");
  const st = bank.stats();
  assert.deepEqual(
    { a: st.active, p: st.pending, r: st.retired, l: st.byLayer },
    { a: 4, p: 1, r: 0, l: { resident: 1, searchable: 2, archive: 1 } });
  assert.deepEqual(st.passRate, { resident: 1, searchable: 0.5, archive: null });
  assert.deepEqual(SCORE, { right: 1, partial: 0.5, wrong: 0 });
});

test("bank: partial counts half in passRate", () => {
  const { bank } = mkBank();
  const day = "2026-11-05";
  const [a, b] = bank.addPending(day, "x", [qin("a"), qin("b")]);
  bank.activate(day, ["x"]);
  bank.record({ q: a!, day, stage: "x", phase: "after", layer: "searchable", verdict: "partial", reason: "", answer: "" });
  bank.record({ q: b!, day, stage: "x", phase: "after", layer: "searchable", verdict: "right", reason: "", answer: "" });
  assert.equal(bank.stats().passRate.searchable, 0.75);
});

test("migration 15 applies on a v14 db", () => {
  const dir = tmpDir("hh-mig-");
  const path = join(dir, "hh.db");
  const raw = new DatabaseSync(path);
  raw.exec("CREATE TABLE schema_version (v INTEGER NOT NULL)");
  for (const m of MIGRATIONS.slice(0, 14)) raw.exec(m);
  raw.prepare("INSERT INTO schema_version (v) VALUES (14)").run();
  raw.close();
  const db = openDb(path);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
  for (const t of ["exam_q", "exam_result", "exam_op"]) assert.ok(cols(t).length > 0, t);
  assert.ok(cols("sleep_stage").includes("regressions"));
  assert.ok(cols("sleep_run").includes("save_level"));
  assert.equal((db.prepare("SELECT v FROM schema_version").get() as { v: number }).v, MIGRATIONS.length);
});

// ---- 考试配置 ----
import { parseFlow, FlowError } from "../src/sleep/flow.ts";
import { guardFor } from "../src/sleep/session.ts";
import { examQuestionsTool, examAnswersTool, examGradesTool, ENGINE_TOOLS, type QuestionsIn } from "../src/sleep/tools.ts";
import { SLEEP_LOCKED, SLEEP_QUESTIONS_TAKEN } from "../src/lang/zh/prompts.ts";

const fknown = { tools: new Set<string>(), builtins: new Set<string>(), memWriters: new Set<string>() };
const fagent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "agent", skill: `${id}.md`, ...extra });
const fmk = (stages: unknown[], extra: Record<string, unknown> = {}) => parseFlow({ stages, ...extra }, fknown);
const flowErr = (f: () => unknown): FlowError => {
  try { f(); } catch (e) { assert.ok(e instanceof FlowError); return e; }
  assert.fail("没有报错");
};

test("exam config: absent means no exam, {} means defaults", () => {
  const f = fmk([fagent("a"), fagent("b", { exam: {} })], { exam: { baseBlocks: ["x.md"] } });
  assert.equal(f.stages[0]!.exam, null);
  assert.deepEqual(f.stages[1]!.exam, {
    min: 1, max: 40, old: 30, sample: 5, hidden: 3,
    newRate: { resident: 0.9, searchable: 0.9 }, regressions: 0, highAllRight: true, hiddenGates: false,
  });
});

test("exam config: bad values are all reported", () => {
  const e = flowErr(() => fmk(
    [fagent("a", { exam: { newRate: { resident: 1.5 }, min: 5, max: 2 } })],
    { exam: { saveLadder: ["hidden", "hidden"], baseBlocks: ["../x.md"] } },
  ));
  for (const k of ["newRate.resident", "min", "saveLadder", "baseBlocks"]) {
    assert.ok(e.problems.some((x) => x.includes(k)), `缺少「${k}」：${e.problems.join("|")}`);
  }
  assert.equal(e.problems.length, 4, e.problems.join("|"));
});

test("exam config: global defaults", () => {
  const f = fmk([fagent("a")]);
  assert.deepEqual(f.exam, {
    baseBlocks: [], examineeModel: "opus", graderModel: "opus", preview: null,
    saveLadder: ["hidden", "old", "cheap", "final-old"], finalOld: 20, finalSample: 5, finalShared: 40, hide: [],
    inject: [], appendixChars: 40000, residentMemory: false, ignoreMarks: [],
  });
});

test("exam config: a stage with exam but no baseBlocks is an error", () => {
  const e = flowErr(() => fmk([fagent("a", { exam: {} })]));
  assert.ok(e.problems.some((x) => x.includes("exam.baseBlocks")), e.problems.join("|"));
});

const W = "/ws";
const R = "/ws/sleep/2026-11-04/proposed";

test("lock: writes are refused until exam_questions, then allowed", () => {
  let locked: string | undefined = SLEEP_LOCKED;
  const guard = guardFor({
    allowed: new Set(["recall_event", "exam_questions", "mem_entry_add"]), proposedRoot: R,
    writes: ["memory/**"], bash: ["sleep_apply.py"], workspace: W, writeLock: () => locked,
  });
  assert.equal(guard("Write", { file_path: `${R}/memory/a.md` }), SLEEP_LOCKED);
  assert.equal(guard("Edit", { file_path: `${R}/memory/a.md` }), SLEEP_LOCKED);
  assert.equal(guard("MultiEdit", { file_path: `${R}/memory/a.md` }), SLEEP_LOCKED);
  assert.equal(guard("NotebookEdit", { notebook_path: `${R}/memory/a.ipynb` }), SLEEP_LOCKED);
  assert.equal(guard("Bash", { command: "python3 scripts/sleep_apply.py step D x" }), SLEEP_LOCKED);
  assert.equal(guard("mem_entry_add", {}), SLEEP_LOCKED);
  assert.equal(guard("mem_event_create", {}), SLEEP_LOCKED);
  assert.equal(guard("learn_check", {}), SLEEP_LOCKED);
  assert.equal(guard("Read", { file_path: "/ws/x" }), undefined);
  assert.equal(guard("recall_event", {}), undefined);
  assert.equal(guard("exam_questions", {}), undefined);
  locked = undefined;
  assert.equal(guard("Write", { file_path: `${R}/memory/a.md` }), undefined);
  assert.ok(guard("Write", { file_path: `${R}/soul/a.md` }));
  assert.equal(guard("Bash", { command: "python3 scripts/sleep_apply.py step D x" }), undefined);
});

const good: QuestionsIn = {
  questions: [{
    q: "上次说的那个 bug 是啥？", gold: "竞态", accept: "race", sources: ["e0001"],
    tags: { who: ["ada"], events: ["e0001"], files: [], lessons: [] }, importance: 3, kind: "fact", layer: "searchable", isNew: true,
  }],
  revise: [{ q: "q1", gold: "g", why: "w" }], retire: [{ q: "q2", why: "记错了" }],
};

test("exam_questions: a valid batch reaches onQuestions; schema rejects bad layer", async () => {
  let got: QuestionsIn | undefined;
  const t = examQuestionsTool((x) => { got = x; return "收下"; });
  assert.equal(t.name, "exam_questions");
  assert.equal(await t.handler(good as never), "收下");
  assert.deepEqual(got, good);
  const { z } = await import("zod");
  const schema = z.object(t.shape);
  assert.equal(schema.safeParse(good).success, true);
  const bad = { ...good, questions: [{ ...good.questions[0], layer: "deep" }] };
  assert.equal(schema.safeParse(bad).success, false);
  assert.equal(schema.safeParse({ ...good, questions: [{ ...good.questions[0], importance: 6 }] }).success, false);
  const thrower = examQuestionsTool(() => { throw new Error("炸"); });
  assert.equal(await thrower.handler(good as never), "没做成：炸");
});

test("exam_answers / exam_grades: payload reaches the callback; a throw replies 没做成", async () => {
  let a: unknown, g: unknown;
  const at = examAnswersTool((x) => { a = x; return "ok-a"; });
  assert.equal(await at.handler({ answers: [{ id: "q1", answer: "x" }] }), "ok-a");
  assert.deepEqual(a, { answers: [{ id: "q1", answer: "x" }] });
  const gt = examGradesTool((x) => { g = x; return "ok-g"; });
  const payload = { grades: [{ id: "q1", verdict: "right", reason: "r" }], layers: [{ id: "q1", layer: "archive" }] };
  assert.equal(await gt.handler(payload), "ok-g");
  assert.deepEqual(g, payload);
  assert.equal(await examAnswersTool(() => { throw new Error("a坏"); }).handler({ answers: [] }), "没做成：a坏");
  assert.equal(await examGradesTool(() => { throw new Error("g坏"); }).handler({ grades: [], layers: [] }), "没做成：g坏");
  assert.deepEqual([...ENGINE_TOOLS], ["stage_done", "audit_done", "exam_questions", "exam_answers", "exam_grades"]);
  assert.match(SLEEP_QUESTIONS_TAKEN(2, ["q1", "q2"], ["q3（没出处）"]), /2/);
});

// ---- Task 4: 考场开头、考一层、判分 ----
import { examineLayer, grade, checkArchive, SEARCH_TOOLS, type ExamHost } from "../src/sleep/exam.ts";
import type { ExamAnswers, ExamGrades } from "../src/sleep/tools.ts";
import type { Question } from "../src/sleep/bank.ts";
import * as XP from "../src/lang/zh/prompts.ts";

type XScript = (s: { wakes: string[]; answers(a: ExamAnswers): string; grades(g: ExamGrades): string; turnEnd(ok: boolean, e?: string): void; settle(how: string): void }) => void;
function examHost(scripts: XScript[], o: { blocks?: Record<string, string>; exists?: (ref: string) => boolean } = {}) {
  const opened: Array<{ id: string; model: string; opening: string; allowed: string[]; store: string }> = [];
  const wakesAll: string[][] = [];
  const blocks = o.blocks ?? {};
  const host: ExamHost = {
    open(op) {
      opened.push(op);
      const script = scripts[opened.length - 1]!;
      const wakes: string[] = []; wakesAll.push(wakes);
      let onA: (a: ExamAnswers) => string = () => ""; let onG: (g: ExamGrades) => string = () => "";
      let onEnd: (ok: boolean, e?: string) => void = () => {};
      let settle!: (v: any) => void;
      const settled = new Promise<any>((r) => { settle = r; });
      return {
        id: op.id, settled,
        wake(t: string) { wakes.push(t); queueMicrotask(() => script({ wakes, answers: (a) => onA(a), grades: (g) => onG(g), turnEnd: (ok, e) => onEnd(ok, e), settle: (how) => settle({ how, turns: 1, usage: {} }) })); },
        onTurnEnd(fn: (ok: boolean, e?: string) => void) { onEnd = fn; },
        onAnswers(fn: (a: ExamAnswers) => string) { onA = fn; },
        onGrades(fn: (g: ExamGrades) => string) { onG = fn; },
        onQuestions() {},
        async close() { settle({ how: "ok", turns: 1, usage: {} }); },
      } as any;
    },
    opening: (exclude) => Object.keys(blocks).filter((k) => !exclude.includes(k)).map((k) => blocks[k]).join("\n"),
    preview: async () => "",
    sourceExists: (ref) => (o.exists ? o.exists(ref) : true),
    beforeText: () => null,
    spent() {},
    timeoutMs: 1000,
  };
  return { host, opened, wakesAll };
}
const xq = (id: string, o: Partial<Question> = {}): Question => ({
  id, q: `问题${id}`, gold: `标准${id}`, accept: `也行${id}`, sources: [], tags: { who: [], events: [], files: [], lessons: [] },
  importance: 3, kind: "fact", layer: "searchable", isNew: true, day: "2026-11-05", stage: "events", hidden: false,
  status: "active", created: 0, lastExamined: null, ...o,
});
const EX = { id: "exam-d-1", model: "m", opening: "OPEN", injection: "INJ", store: "live" };

test("opening leaves out the base blocks the stage changed", () => {
  const blocks = { "soul/10.md": "十的内容", "soul/20.md": "二十的内容", "soul/50.md": "五十的内容" };
  const { host } = examHost([], { blocks });
  const o = host.opening(["soul/20.md"]);
  assert.ok(!o.includes("二十的内容")); assert.ok(o.includes("十的内容")); assert.ok(o.includes("五十的内容"));
  const all = host.opening([]);
  for (const v of Object.values(blocks)) assert.ok(all.includes(v));
  assert.equal(host.opening([]), all, "同样的输入一字不差");
});

test("examineLayer: resident gets no tools, one batch, answers mapped by id", async () => {
  const h = examHost([(s) => { s.answers({ answers: [{ id: "q1", answer: "甲" }, { id: "q2", answer: "乙" }] }); s.turnEnd(true); }]);
  const r = await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1"), xq("q2")] });
  assert.deepEqual(h.opened[0]!.allowed, ["exam_answers"]);
  assert.equal(h.opened[0]!.opening, "OPEN"); assert.equal(h.opened[0]!.store, "live");
  assert.match(h.wakesAll[0]![0]!, /q1/); assert.match(h.wakesAll[0]![0]!, /q2/);
  assert.deepEqual([...r!], [["q1", "甲"], ["q2", "乙"]]);
});

test("examineLayer: searchable gets the memory read tools", async () => {
  const h = examHost([(s) => { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); }]);
  await examineLayer(h.host, { ...EX, layer: "searchable", questions: [xq("q1")] });
  const a = h.opened[0]!.allowed;
  for (const t of [...SEARCH_TOOLS, "exam_answers"]) assert.ok(a.includes(t), t);
  assert.ok(!a.some((t) => t.startsWith("mem_")));
});

test("examineLayer: a timeout reopens once, then null", async () => {
  const h = examHost([(s) => s.settle("timeout"), (s) => s.settle("timeout")]);
  assert.equal(await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1")] }), null);
  assert.equal(h.opened.length, 2);
  assert.equal(h.opened[0]!.id, "exam-d-1"); assert.equal(h.opened[1]!.id, "exam-d-1-r");
  const ok = examHost([(s) => s.settle("timeout"), (s) => { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); }]);
  assert.equal((await examineLayer(ok.host, { ...EX, layer: "resident", questions: [xq("q1")] }))!.get("q1"), "甲");
});

test("examineLayer: a turn without exam_answers gets one nudge", async () => {
  const h = examHost([(s) => s.turnEnd(true), (s) => s.turnEnd(true)]);
  assert.equal(await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1")] }), null);
  assert.equal(h.wakesAll[0]!.length, 2); assert.equal(h.wakesAll[0]![1], XP.EXAM_NUDGE);
});

test("grade: verdicts and layer calls come back; unsure answered as fact is wrong", async () => {
  const h = examHost([(s) => {
    s.grades({ grades: [{ id: "q1", verdict: "partial", reason: "差一点" }], layers: [{ id: "q9", layer: "archive" }] });
    s.turnEnd(true);
  }]);
  const q1 = xq("q1", { kind: "unsure" });
  const r = await grade(h.host, { id: "exam-d-g", model: "m", opening: "OPEN", items: [{ q: q1, answer: "是三号" }], askLayers: [xq("q9")] });
  assert.deepEqual(h.opened[0]!.allowed, ["exam_grades"]);
  assert.deepEqual(r!.grades.get("q1"), { verdict: "partial", reason: "差一点" });
  assert.equal(r!.layers.get("q9"), "archive");
  const p = XP.EXAM_GRADER([{ q: q1, answer: "是三号" }], [xq("q9")]);
  assert.match(p, /拿不准/); assert.match(p, /确定的事实/); assert.match(p, /q9/); assert.match(p, /exam_grades/);
  assert.ok(!/米拉/.test(XP.EXAM_SITTER("resident", "INJ", [xq("q1")])));
  const dead = examHost([(s) => s.settle("timeout"), (s) => s.settle("timeout")]);
  assert.equal(await grade(dead.host, { id: "g", model: "m", opening: "O", items: [], askLayers: [] }), null);
  assert.equal(dead.opened[1]!.id, "g-r");
});

test("checkArchive: all sources resolve → right, one missing → wrong", () => {
  const h = examHost([], { exists: (r) => r !== "e999" });
  const o = { day: "d", state: "after" as const };
  assert.equal(checkArchive(h.host, xq("q1", { sources: ["e1", "#3"] }), o), "right");
  assert.equal(checkArchive(h.host, xq("q1", { sources: ["e1", "e999"] }), o), "wrong");
});

// ---- Task 4 fix round 1 ----
test("exam sessions report usage once per session, at settle (retry is its own session)", async () => {
  const calls: string[] = [];
  const h = examHost([
    (s) => { if (s.wakes.length === 1) s.turnEnd(true); else { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); } },
  ]);
  h.host.spent = (id) => { calls.push(id); };
  await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1")] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls, ["exam-d-1"], "两轮，只报一次");

  const calls2: string[] = [];
  const d = examHost([(s) => s.settle("timeout"), (s) => s.settle("timeout")]);
  d.host.spent = (id) => { calls2.push(id); };
  await examineLayer(d.host, { ...EX, layer: "resident", questions: [xq("q1")] });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(calls2.sort(), ["exam-d-1", "exam-d-1-r"]);
});

test("an empty exam_answers / exam_grades does not count as submitted", async () => {
  let reply = "";
  const h = examHost([(s) => {
    if (s.wakes.length === 1) { reply = s.answers({ answers: [] }); s.turnEnd(true); }
    else { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); }
  }]);
  const r = await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1")] });
  assert.match(reply, /空/);
  assert.equal(h.wakesAll[0]![1], XP.EXAM_NUDGE);
  assert.equal(r!.get("q1"), "甲");

  const g = examHost([(s) => {
    if (s.wakes.length === 1) { s.grades({ grades: [], layers: [] }); s.turnEnd(true); }
    else { s.grades({ grades: [{ id: "q1", verdict: "right", reason: "对" }], layers: [] }); s.turnEnd(true); }
  }]);
  const gr = await grade(g.host, { id: "g", model: "m", opening: "O", items: [{ q: xq("q1"), answer: "a" }], askLayers: [] });
  assert.equal(gr!.grades.get("q1")!.verdict, "right");
});

// ---- Task 5: 一段的考试验证器 ----
import { examValidator } from "../src/sleep/examiner.ts";
import { NO_SAVING, type LadderPlan } from "../src/sleep/ladder.ts";
import * as SL from "../src/sleep/ledger.ts";
import type { Change, MiniFs, Snapshot, StageRecord } from "../src/sleep/record.ts";
import type { StageValidator, ValidateCtx } from "../src/sleep/validate.ts";
import type { Layer, Verdict } from "../src/sleep/bank.ts";
import { SleepRunner, type StageHost } from "../src/sleep/runner.ts";
import { Budget } from "../src/sleep/budget.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import type { StageDone } from "../src/sleep/tools.ts";

type Phase = "after" | "retake" | "before";
interface Sat { id: string; model: string; opening: string; allowed: string[]; store: string; wake: string; wakes: string[] }
const SD = "2026-11-05";
const BASE = ["soul/10-来历.md", "soul/20-性格.md"];
const ZERO = { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, maxCtx: 0 };

/** 考生按题目一行一道（题号　问题）交答案；判分人按 判分的阶段 + 问题 判，问到层的照 layers 回 */
function sitHost(o: {
  verdict?: (phase: Phase, q: string) => Verdict; layers?: (q: string) => Layer | undefined; dead?: (id: string) => boolean;
  setter?: (id: string) => QuestionIn[] | null;
  blocks?: Record<string, string>; exists?: (ref: string, state: "before" | "after") => boolean; preview?: ExamHost["preview"];
} = {}) {
  const opened: Sat[] = [];
  const excludes: string[][] = [];
  const previews: Array<{ state: string; files: string[] }> = [];
  const blocks = o.blocks ?? {};
  const host: ExamHost = {
    open(op) {
      const me: Sat = { ...op, allowed: [...op.allowed], wake: "", wakes: [] };
      opened.push(me);
      let gradings = 0;
      let onA: (a: ExamAnswers) => string = () => "";
      let onG: (g: ExamGrades) => string = () => "";
      let onQ: (q: QuestionsIn) => string = () => "";
      let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<any>((r) => { settle = r; });
      const end = (how: string) => settle({ how, turns: 1, usage: ZERO });
      return {
        id: op.id, settled,
        wake(t: string) {
          if (!me.wake) me.wake = t;
          me.wakes.push(t);
          // final fix M3：重考和整理前同一个判分会话判：重考那个会话第二次判分是整理前那轮
          if (t.startsWith("【判分】")) gradings += 1;
          queueMicrotask(() => {
            if (o.dead?.(op.id)) return end("timeout");
            if (op.allowed.includes("exam_questions")) {
              const qs = o.setter?.(op.id);
              if (qs) onQ({ questions: qs, revise: [], retire: [] });
            } else if (op.allowed.includes("exam_grades")) {
              const named = /-grade-(after|retake|before)/.exec(op.id)![1] as Phase;
              const phase: Phase = named === "retake" && gradings > 1 ? "before" : named;
              const items = [...t.matchAll(/^(\S+)（\w+）\n问题：(.*)$/gm)].map((m) => ({ id: m[1]!, q: m[2]! }));
              const asks = [...t.matchAll(/^(\S+)　(.*?)（标准答案：/gm)].map((m) => ({ id: m[1]!, q: m[2]! }));
              onG({
                grades: items.map((x) => ({ id: x.id, verdict: o.verdict?.(phase, x.q) ?? "right", reason: `判${phase}` })),
                layers: asks.flatMap((x) => { const l = o.layers?.(x.q); return l ? [{ id: x.id, layer: l }] : []; }),
              });
            } else {
              const qs = t.slice(t.lastIndexOf("题目：\n") + 4).split("\n\n")[0]!.split("\n").filter(Boolean)
                .map((l) => ({ id: l.slice(0, l.indexOf("　")), q: l.slice(l.indexOf("　") + 1) }));
              onA({ answers: qs.map((x) => ({ id: x.id, answer: `答：${x.q}` })) });
            }
            onEnd(true);
          });
        },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onAnswers(fn: (a: ExamAnswers) => string) { onA = fn; },
        onGrades(fn: (g: ExamGrades) => string) { onG = fn; },
        onQuestions(fn: (q: QuestionsIn) => string) { onQ = fn; },
        async close() { end("ok"); },
      } as any;
    },
    opening: (exclude) => {
      excludes.push([...exclude]);
      return Object.keys(blocks).filter((k) => !exclude.includes(k)).map((k) => blocks[k]).join("\n");
    },
    preview: o.preview ?? (async ({ state, files }) => {
      previews.push({ state, files: [...files.keys()] });
      return [...files.keys()].map((f) => `「${state}:${f}」`).join("\n");
    }),
    sourceExists: (ref, x) => (o.exists ? o.exists(ref, x.state) : true),
    beforeText: (_day, p, v) => v.files.get(p)?.text ?? null,
    spent() {},
    timeoutMs: 1000,
  };
  return { host, opened, excludes, previews };
}

// final fix I2 以后改过的文件默认不进注入（exam.inject 是 []）：这里的旧测试照旧当它们都进注入
const examFlow = (exam: Record<string, unknown> | null = {}, global: Record<string, unknown> = {}) =>
  fmk([fagent("soul", { title: "灵魂", writes: ["soul/**"], ...(exam ? { exam: { hidden: 0, ...exam } } : {}) })], { exam: { baseBlocks: BASE, inject: ["**"], ...global } });
const xrec = (files: string[], changes: Array<Partial<Change> & { target: string }> = []): StageRecord => ({
  day: SD, stage: "soul", attempt: 1, status: "done",
  // final fix I4 以后 change 也算压缩的标签：这里默认 add（旧测试不是在测覆盖）
  changes: changes.map((c) => ({ op: "add", before: "", after: "", evidence: [], why: "w", ...c })),
  report: "", uncertain: [], proposals: [], bugs: [],
  actual: { files: files.map((path) => ({ path, op: "change" as const })), memOps: 0 },
});
const snapOf = (m: Record<string, string>): Snapshot => new Map(Object.entries(m).map(([p, text]) => [p, { sha: text, text }]));
const xctx = (files: string[], storeBefore = "live"): ValidateCtx => ({
  before: snapOf(Object.fromEntries(files.map((f) => [f, `旧 ${f}`]))),
  // final fix I4 以后压缩照实际的 diff 算：整理后只多一行，没删东西
  after: snapOf(Object.fromEntries(files.map((f) => [f, `旧 ${f}\n新 ${f}`]))),
  material: "材料", storeBefore,
});
/** 以前几夜的题：出在 11-01、已经生效 */
const oldQs = (bank: Bank, qs: QuestionIn[]): string[] => {
  const ids = bank.addPending("2026-11-01", "old", qs);
  bank.activate("2026-11-01", ["old"]);
  return ids;
};
const on80 = (q: string, o: Partial<QuestionIn> = {}) => qin(q, { isNew: false, tags: noTags({ files: ["soul/80.md"] }), ...o });

function sitting(o: { exam?: Record<string, unknown> | null; global?: Record<string, unknown>; host?: Parameters<typeof sitHost>[0]; ladder?: LadderPlan; logs?: LogRecord[]; opts?: Partial<Parameters<typeof examValidator>[0]> } = {}) {
  const { db, bank } = mkBank();
  const flow = examFlow(o.exam === undefined ? {} : o.exam, o.global);
  const h = sitHost(o.host);
  SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
  const v = examValidator({
    host: h.host, bank, flow, db, rnd: () => 0, ladder: () => o.ladder ?? NO_SAVING,
    ...(o.logs ? { log: new Logger("t", memorySink(o.logs)) } : {}),
    ...o.opts,
  });
  const row = () => ({ ...one<Record<string, unknown>>(db,
    "SELECT questions, score_before, score_after, regressions, hidden_score, examined FROM sleep_stage ORDER BY id DESC LIMIT 1")! });
  const results = () => all<{ q: string; phase: string; layer: string; verdict: string }>(db, "SELECT q, phase, layer, verdict FROM exam_result ORDER BY id").map((r) => ({ ...r }));
  return { db, bank, flow, stage: flow.stages[0]!, v, row, results, ...h };
}
const sid = (rest: string) => `exam-${SD}-soul-1-${rest}`;

// ---- 第 1 份的假 host 的小版本：一段 people（写 memory/people/**）+ finish ----
const DN = "2026-11-04";
interface TinyCtx { write(p: string, s: string): void; done(d?: Partial<StageDone>): void }
// final fix I4 以后 change 也算压缩的标签：这里用 add（旧测试不是在测覆盖）
const chg5 = (target: string): Change => ({ target, op: "add", before: "a", after: "b", evidence: ["e0001"], why: "因为" });
const nightFlow = (people: Record<string, unknown> = {}) => fmk([
  fagent("people", { title: "人物", writes: ["memory/people/**"], ...people }),
  { id: "finish", title: "finish", kind: "script", command: ["finish", "{day}"], after: ["people"] },
], { exam: { baseBlocks: BASE, inject: ["**"] } });

function tinyNight(o: { act: (c: TinyCtx) => void; seed?: Record<string, string>; storeBefore?: (day: string, stage: string) => string }) {
  const files = new Map<string, string>(Object.entries(o.seed ?? {}).map(([p, s]) => [`sleep/${DN}/proposed/${p}`, s]));
  const fs: MiniFs = {
    read: (p) => files.get(p) ?? null,
    write: (p, s) => void files.set(p, s),
    remove: (p) => void files.delete(p),
    isDir: (p) => [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    list: (dir) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]!))],
  };
  const db = openDb(":memory:");
  const host: StageHost = {
    flowHash: "h", prefix: "P",
    open(x) {
      let onDone: (d: StageDone) => string = () => "";
      let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<any>((r) => { settle = r; });
      return {
        id: x.id, settled,
        wake() {
          queueMicrotask(() => {
            o.act({
              write: (p, s) => fs.write(`sleep/${x.day}/proposed/${p}`, s),
              done: (d = {}) => { onDone({ status: "done", changes: [], report: "报告", uncertain: [], proposals: [], bugs: [], ...d }); },
            });
            onEnd(true);
          });
        },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onDone(fn: (d: StageDone) => string) { onDone = fn; },
        async close() { settle({ how: "ok", turns: 1, usage: ZERO }); },
      } as never;
    },
    async run() { return { code: 0, out: "" }; },
    fs, mem: null, db,
    skillText: (s) => `skill ${s.id}`,
    materialText: (day, names) => `材料 ${day}：${names.join("、")}`,
    now: () => 1000,
    later: () => () => {},
    log: new Logger("t", () => {}),
    ...(o.storeBefore ? { storeBefore: o.storeBefore } : {}),
  };
  return { host, fs, db };
}

const runNightWith = (n: ReturnType<typeof tinyNight>, flow: ReturnType<typeof nightFlow>, validators: StageValidator[]) => {
  let given = false;
  return new SleepRunner(n.host, flow, { validators, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity })
    .runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
};

test("stage exam: all right → pass, scores recorded", async () => {
  const x = sitting({ global: { examineeModel: "sonnet", graderModel: "haiku" } });
  const own = x.bank.addPending(SD, "soul", [qin("常1", { layer: "resident" }), qin("查1")]);
  const [old] = oldQs(x.bank, [on80("旧1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md「十月」" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual(x.opened.map((s) => s.id), [sid("after-resident"), sid("after-searchable"), sid("grade-after")]);
  assert.deepEqual(x.opened.map((s) => s.model), ["sonnet", "sonnet", "haiku"]);
  assert.ok(x.opened.every((s) => s.store === "live"));
  assert.deepEqual(x.opened[0]!.allowed, ["exam_answers"]);
  for (const t of SEARCH_TOOLS) assert.ok(x.opened[1]!.allowed.includes(t), t);
  assert.match(x.opened[1]!.wake, /旧1/);
  assert.deepEqual(x.row(), { questions: 3, score_before: null, score_after: 1, regressions: 0, hidden_score: null, examined: 1 });
  assert.deepEqual(x.results().map((r) => [r.q, r.phase, r.verdict]).sort(),
    [[own[0], "after", "right"], [own[1], "after", "right"], [old, "after", "right"]].sort());
});

test("stage exam: a regression sends the stage back with the gold answer", async () => {
  const x = sitting({ host: { verdict: (p, q) => (q === "旧1" && p !== "before" ? "wrong" : "right") } });
  oldQs(x.bank, [on80("旧1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], "/scratch/store-before"));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith("倒退：") && p.includes("旧1") && p.includes("旧1-gold")), r.problems.join("|"));
  assert.deepEqual(x.opened.map((s) => s.id),
    // final fix M3：重考和整理前同一个判分会话（grade-retake 判两轮）
    [sid("after-searchable"), sid("grade-after"), sid("retake-searchable"), sid("grade-retake"), sid("before-searchable")]);
  const before = x.opened.find((s) => s.id === sid("before-searchable"))!;
  assert.equal(before.store, "/scratch/store-before");
  assert.match(before.wake, /「before:soul\/80\.md」/);
  assert.ok(!before.wake.includes("「after:"));
  assert.equal(x.opened.find((s) => s.id === sid("retake-searchable"))!.store, "live");
  assert.deepEqual(x.row(), { questions: 1, score_before: 1, score_after: 0, regressions: 1, hidden_score: null, examined: 1 });
  assert.deepEqual(x.results().map((r) => `${r.phase}:${r.verdict}`), ["after:wrong", "retake:wrong", "before:right"]);
});

test("stage exam: wrong both before and after is not this stage's loss", async () => {
  const x = sitting({ host: { verdict: (_p, q) => (q === "旧1" ? "wrong" : "right") } });
  oldQs(x.bank, [on80("旧1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: ["整理前也答不出：旧1，题可能出得不好"] });
  assert.equal(x.row().regressions, 0);
});

test("stage exam: retake right counts as right", async () => {
  const x = sitting({ host: { verdict: (p, q) => (q === "旧1" && p === "after" ? "wrong" : "right") } });
  oldQs(x.bank, [on80("旧1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.ok(!x.opened.some((s) => s.id.includes("-before")), x.opened.map((s) => s.id).join("|"));
  assert.match(x.opened.find((s) => s.id === sid("retake-searchable"))!.wake, /旧1/);
  assert.equal(x.row().score_after, 1);
  assert.deepEqual(x.results().map((r) => `${r.phase}:${r.verdict}`), ["after:wrong", "retake:right"]);
});

test("stage exam: new points below 0.9 fail per layer", async () => {
  const wrong = new Set(["常9", "常10", "查10"]);
  const x = sitting({ host: { verdict: (_p, q) => (wrong.has(q) ? "wrong" : "right") } });
  const ten = (p: string, layer: Layer) => Array.from({ length: 10 }, (_, i) => qin(`${p}${i + 1}`, { layer }));
  x.bank.addPending(SD, "soul", [...ten("常", "resident"), ...ten("查", "searchable")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  assert.equal(r.problems.length, 1, r.problems.join("|"));
  assert.match(r.problems[0]!, /常驻/);
  assert.match(r.problems[0]!, /0\.8/);
  assert.ok(!x.opened.some((s) => s.id.includes("-before")), "今天新要点的题不补考整理前");
});

test("stage exam: importance 4 must be right", async () => {
  const run = async (exam: Record<string, unknown>) => {
    // 整理前答对、整理后部分对：重要的旧题整理后比整理前差（fix round 1 的裁定）
    const x = sitting({ exam, host: { verdict: (p, q) => (q === "要紧的" && p !== "before" ? "partial" : "right") } });
    oldQs(x.bank, [on80("要紧的", { importance: 4 })]);
    return x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  };
  const strict = await run({});
  assert.equal(strict.pass, false);
  assert.ok(strict.problems.some((p) => p.includes("要紧的")), strict.problems.join("|"));
  assert.deepEqual(await run({ highAllRight: false }), { pass: true, problems: ["部分对：要紧的"] });
});

test("coverage: a compression with no question sends the stage back", async () => {
  const x = sitting();
  x.bank.addPending(SD, "soul", [qin("别的", { tags: noTags({ files: ["soul/10-来历.md"] }) })]);
  const rec = xrec(["soul/80-我的经历.md"], [
    { target: "soul/80-我的经历.md「十月」", op: "compress" },
    { target: "soul/80-我的经历.md「九月」", op: "Fade-out", affects: [{ q: "q:none/1", layer: "archive" }] },
    { target: "soul/80-我的经历.md「八月」", op: "add" },
  ]);
  const ctx = xctx(["soul/80-我的经历.md"]);
  assert.deepEqual(await x.v.validate(x.stage, SD, rec, ctx), { pass: false, problems: [
    "soul/80-我的经历.md「十月」 要压缩，但没有出题",
    "soul/80-我的经历.md「九月」 的 affects 点名的题不存在",
  ] });
  assert.equal(x.opened.length, 0, "覆盖没过就不开考生");
  x.bank.addPending(SD, "soul", [qin("十月做了什么", { tags: noTags({ files: ["soul/80-我的经历.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, rec, ctx);
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.ok(x.opened.length > 0);
});

test("grader times out twice: stage passes on mechanical + audit, report says not examined", async () => {
  const x = sitting({ host: { dead: (id) => id.includes("-grade-") } });
  x.bank.addPending(SD, "soul", [qin("人1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [S.examiner.notExamined] });
  assert.deepEqual(x.opened.filter((s) => s.id.includes("-grade-")).map((s) => s.id), [sid("grade-after"), `${sid("grade-after")}-r`]);
  assert.equal(x.row().examined, 0);

  // 接在 runner 上：这一段照样过、这一天落地，报告最上面写「人物 段没考完」
  const night = tinyNight({ act: (c) => { c.write("memory/people/a.md", "P"); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const bank = new Bank(night.db, () => 1000);
  bank.addPending(DN, "people", [qin("人1")]);
  const dead = sitHost({ dead: (id) => id.includes("-grade-") });
  const flow = nightFlow({ exam: {} });
  const v = examValidator({ host: dead.host, bank, flow, db: night.db, rnd: () => 0, ladder: () => NO_SAVING });
  const res = await runNightWith(night, flow, [v]);
  assert.deepEqual(res.landed, [DN]);
  const lines = night.fs.read(`sleep/${DN}/report.md`)!.split("\n").filter(Boolean);
  assert.equal(lines[1], "人物 段没考完");
  assert.equal(one<{ examined: number }>(night.db, "SELECT examined FROM sleep_stage WHERE stage = 'people'")!.examined, 0);
});

test("first night: empty bank, only the stage's own questions", async () => {
  const x = sitting();
  const own = x.bank.addPending(SD, "soul", [qin("一"), qin("二"), qin("三")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual([...new Set(x.results().map((r) => r.q))].sort(), [...own].sort());
  assert.equal(x.row().questions, 3);
  const sat = x.opened.filter((s) => !s.allowed.includes("exam_grades")).map((s) => s.wake).join("\n");
  assert.deepEqual([...sat.matchAll(/^(\S+)　/gm)].map((m) => m[1]).sort(), [...own].sort());
});

test("opening excludes changed base blocks", async () => {
  const x = sitting({ host: { blocks: { "soul/10-来历.md": "十的内容", "soul/20-性格.md": "二十的旧内容" } } });
  x.bank.addPending(SD, "soul", [qin("性格", { layer: "resident" })]);
  const files = ["soul/20-性格.md", "soul/80.md"];
  await x.v.validate(x.stage, SD, xrec(files, files.map((f) => ({ target: f }))), xctx(files));
  assert.ok(x.excludes.length > 0);
  for (const e of x.excludes) assert.deepEqual(e, ["soul/20-性格.md"]);
  assert.ok(x.opened.length > 0);
  for (const s of x.opened) assert.equal(s.opening, "十的内容");
  const sitter = x.opened.find((s) => s.id === sid("after-resident"))!;
  assert.match(sitter.wake, /「after:soul\/20-性格\.md」/);
  assert.match(sitter.wake, /「after:soul\/80\.md」/);
  assert.deepEqual(x.previews.find((p) => p.state === "after")!.files, files);
});

test("runner: validators get the attempt's snapshots, the material and storeBefore", async () => {
  const seen: Array<ValidateCtx | undefined> = [];
  const spy: StageValidator = { name: "spy", async validate(_s, _d, _r, ctx) { seen.push(ctx); return { pass: true, problems: [] }; } };
  const act = (c: TinyCtx) => { c.write("memory/people/a.md", "新"); c.done({ changes: [chg5("memory/people/a.md")] }); };
  const flow = nightFlow({ material: ["m1"] });
  const a = tinyNight({ act, seed: { "memory/people/a.md": "旧" }, storeBefore: (day, stage) => `/copy/${day}/${stage}` });
  await runNightWith(a, flow, [spy]);
  const b = tinyNight({ act });
  await runNightWith(b, flow, [spy]);
  assert.equal(seen.length, 2);
  const ca = seen[0]!;
  const cb = seen[1]!;
  assert.equal(ca.before.get("memory/people/a.md")!.text, "旧");
  assert.equal(ca.after.get("memory/people/a.md")!.text, "新");
  assert.equal(ca.material, `材料 ${DN}：m1`);
  assert.equal(ca.storeBefore, `/copy/${DN}/people`);
  assert.equal(cb.storeBefore, "live");
  assert.equal(cb.before.get("memory/people/a.md") ?? null, null);
});

test("stage exam: affects moves the exam layer; the grader's layer calls wait for landing", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { layers: (q) => (q === "挂着的" ? "archive" : undefined) } });
  // 挪走的标签不挂在 soul/80.md 上、也不抽题：只靠 affects 点名被挑中（final fix I3：出处说到 soul/80.md 才算挂在它上面；一次只挪一层）
  const [moved, hanging] = oldQs(x.bank, [on80("挪走的", { sources: ["soul/80.md:1", "e0001"], tags: noTags({ files: ["soul/90.md"] }) }), on80("挂着的", { sources: ["soul/80.md:1"] })]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "fade", affects: [{ q: moved!, layer: "archive" }] }]);
  const r = await x.v.validate(x.stage, SD, rec, xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual(x.opened.map((s) => s.id), [sid("after-searchable"), sid("grade-after")], "挪进仓库的题不开考生");
  const g = x.opened[1]!.wake;
  assert.match(g, new RegExp(`${hanging}　挂着的`));
  assert.ok(!g.includes(`${moved}　`), "写了 affects 的不问层");
  assert.deepEqual(x.results().map((r) => [r.q, r.layer, r.verdict]).sort(),
    [[moved, "archive", "right"], [hanging, "searchable", "right"]].sort());
  assert.equal(x.bank.get(hanging!)!.layer, "searchable", "今晚不改层");
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(hanging!)!.layer, "archive");
  assert.equal(x.bank.get(moved!)!.layer, "archive");
});

test("stage exam: no exam block passes untouched; a throw inside is not examined, never thrown", async () => {
  const none = sitting({ exam: null });
  assert.deepEqual(await none.v.validate(none.stage, SD, xrec(["soul/80.md"]), xctx(["soul/80.md"])), { pass: true, problems: [] });
  assert.equal(none.opened.length, 0);
  assert.equal(none.row().examined, null);

  const logs: LogRecord[] = [];
  const x = sitting({ logs, host: { preview: async () => { throw new Error("预览坏了"); } } });
  x.bank.addPending(SD, "soul", [qin("一")]);
  // final fix I2：预览没拼成，常驻那层不考、写一句、examined 记 0；查得到那层照考
  assert.deepEqual(await x.v.validate(x.stage, SD, xrec(["soul/80.md"]), xctx(["soul/80.md"])), { pass: true, problems: ["注入预览失败，常驻层没考：预览坏了"] });
  assert.equal(x.row().examined, 0);
  assert.ok(logs.some((l) => l.level === "warn" && JSON.stringify(l).includes("预览坏了")), JSON.stringify(logs));
  assert.deepEqual(await x.v.validate(x.stage, SD, xrec(["soul/80.md"])), { pass: true, problems: [S.examiner.notExamined] }, "没给 ctx");
});

test("old questions: capped by exam.old, halved by the ladder; the sample adds from the rest", async () => {
  const count = async (ladder: LadderPlan) => {
    const x = sitting({ exam: { old: 4, sample: 2 }, ladder });
    oldQs(x.bank, [...[5, 5, 4, 4, 3, 3].map((imp, i) => on80(`挂${i}`, { importance: imp })), qin("散1"), qin("散2"), qin("散3")]);
    await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    return x.row().questions;
  };
  assert.equal(await count(NO_SAVING), 6);
  assert.equal(await count({ ...NO_SAVING, level: 2, oldScale: 0.5 }), 3);
  assert.equal(await count({ ...NO_SAVING, level: 2, oldScale: 0.1 }), 2, "向下取整，至少 1");
});

test("stage exam: a question written as new on an earlier night is old tonight", async () => {
  const x = sitting({ host: { verdict: (p, q) => (q === "那天新的" && p !== "before" ? "wrong" : "right") } });
  oldQs(x.bank, [qin("那天新的", { isNew: true, tags: noTags({ files: ["soul/80.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith("倒退：那天新的")), r.problems.join("|"));
});

// ---- Task 5 fix round 1 ----
test("coverage: affects only count when they name a real question", async () => {
  const x = sitting();
  // final fix I3：affects 点名的题得挂在那一处上（这里靠出处）
  const [real] = oldQs(x.bank, [qin("别处的", { isNew: false, sources: ["soul/80.md:1"], tags: noTags({ files: ["soul/90.md"] }) })]);
  const [hid] = x.bank.addPending(SD, "soul", [qin("暗的", { tags: noTags({ files: ["soul/90.md"] }) })], { hidden: true });
  const fade = (affects: Array<{ q: string; layer: Layer }>) => xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "fade", affects }]);
  const ctx = xctx(["soul/80.md"]);
  const missing = { pass: false, problems: ["soul/80.md「十月」 的 affects 点名的题不存在"] };
  assert.deepEqual(await x.v.validate(x.stage, SD, fade([{ q: "q:none/1", layer: "archive" }]), ctx), missing);
  assert.deepEqual(await x.v.validate(x.stage, SD, fade([{ q: hid!, layer: "archive" }]), ctx), missing, "暗题不算");
  assert.equal(x.opened.length, 0, "覆盖没过就不开考生");
  const r = await x.v.validate(x.stage, SD, fade([{ q: "q:none/1", layer: "archive" }, { q: real!, layer: "archive" }]), ctx);
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual(x.results().map((r) => [r.q, r.layer]), [[real, "archive"]]);
});

test("important old questions: after must not be worse than before", async () => {
  const cases: Array<{ name: string; after: Verdict; before: Verdict; want: { pass: boolean; problems?: string[] } }> = [
    { name: "partial before + wrong after", after: "wrong", before: "partial", want: { pass: false } },
    { name: "right before + partial after", after: "partial", before: "right", want: { pass: false } },
    { name: "partial before + partial after", after: "partial", before: "partial", want: { pass: true, problems: ["部分对：要紧的"] } },
    { name: "wrong before + wrong after", after: "wrong", before: "wrong", want: { pass: true, problems: ["整理前也答不出：要紧的，题可能出得不好"] } },
  ];
  for (const c of cases) {
    const x = sitting({ host: { verdict: (p) => (p === "before" ? c.before : c.after) } });
    oldQs(x.bank, [on80("要紧的", { importance: 4 })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    assert.equal(r.pass, c.want.pass, `${c.name}：${r.problems.join("|")}`);
    if (c.want.problems) assert.deepEqual(r.problems, c.want.problems, c.name);
    else assert.ok(r.problems.length === 1 && r.problems[0]!.includes("要紧的") && r.problems[0]!.includes("要紧的-gold"), `${c.name}：${r.problems.join("|")}`);
    assert.equal(x.opened.filter((s) => s.id === sid("before-searchable")).length, 1, `${c.name}：补考整理前开一次`);
    assert.equal(x.row().regressions, 0, c.name);
  }
});

test("important partial questions join the one before round, one examinee per layer", async () => {
  const table: Record<string, Partial<Record<Phase, Verdict>>> = {
    甲: { after: "partial", before: "right" },
    乙: { after: "wrong", retake: "wrong", before: "wrong" },
    丙: { after: "partial", before: "partial" },
    丁: { after: "wrong", retake: "wrong", before: "wrong" },
  };
  const setup = async (exam: Record<string, unknown>) => {
    const x = sitting({ exam, host: { verdict: (p, q) => table[q]?.[p] ?? "right" } });
    oldQs(x.bank, [
      on80("甲", { importance: 5 }), on80("乙"),
      on80("丙", { importance: 4, layer: "resident" }), on80("丁", { layer: "resident" }),
    ]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    return { x, r };
  };
  const { x, r } = await setup({});
  const before = x.opened.filter((s) => s.id.includes("-before-"));
  assert.deepEqual(before.map((s) => s.id).sort(), [sid("before-resident"), sid("before-searchable")]);
  const wake = (id: string) => before.find((s) => s.id === id)!.wake;
  for (const q of ["甲", "乙"]) assert.match(wake(sid("before-searchable")), new RegExp(`　${q}$`, "m"));
  for (const q of ["丙", "丁"]) assert.match(wake(sid("before-resident")), new RegExp(`　${q}$`, "m"));
  // final fix M3：重考和整理前同一个判分会话判完
  assert.deepEqual(x.opened.filter((s) => s.id.includes("-grade-") && s.id !== sid("grade-after")).map((s) => s.id), [sid("grade-retake")], "整理前一次判完");
  assert.equal(r.pass, false);
  assert.equal(r.problems.length, 1, r.problems.join("|"));
  assert.match(r.problems[0]!, /甲/);

  const loose = await setup({ highAllRight: false });
  assert.doesNotMatch(loose.x.opened.find((s) => s.id === sid("before-searchable"))!.wake, /　甲$/m, "不管重要的题时，部分对的不补考");
  assert.equal(loose.r.pass, true, loose.r.problems.join("|"));
});

test("not examined keeps the scores it already has", async () => {
  const run = async (dead: string) => {
    const x = sitting({ host: { dead: (id) => id.includes(dead), verdict: (_p, q) => (q === "错的" ? "wrong" : "right") } });
    oldQs(x.bank, [on80("对的"), on80("错的")]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    assert.deepEqual(r, { pass: true, problems: [S.examiner.notExamined] }, dead);
    return x.row();
  };
  assert.deepEqual(await run("-grade-retake"), { questions: 2, score_before: null, score_after: 0.5, regressions: null, hidden_score: null, examined: 0 });
  assert.deepEqual(await run("-before-"), { questions: 2, score_before: null, score_after: 0.5, regressions: null, hidden_score: null, examined: 0 });
  assert.equal((await run("-grade-after")).score_after, null, "整理后那轮没判完就没有分");
});

test("nothing to examine: no preview, no sessions, passes", async () => {
  const x = sitting({ host: { preview: async () => { throw new Error("不该拼注入"); } } });
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.equal(x.opened.length, 0);
  assert.equal(x.excludes.length, 0, "不拼开头");
  assert.deepEqual(x.row(), { questions: 0, score_before: null, score_after: null, regressions: 0, hidden_score: null, examined: 1 });
});

test("important fresh questions must be right", async () => {
  const run = async (exam: Record<string, unknown>) => {
    const x = sitting({ exam, host: { verdict: (_p, q) => (q === "新要紧" ? "partial" : "right") } });
    x.bank.addPending(SD, "soul", [qin("新要紧", { importance: 4 }), ...Array.from({ length: 9 }, (_, i) => qin(`新${i}`))]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    assert.ok(!x.opened.some((s) => s.id.includes("-before-")), "今天新的不补考整理前");
    return r;
  };
  const strict = await run({});
  assert.equal(strict.pass, false);
  assert.equal(strict.problems.length, 1, strict.problems.join("|"));
  assert.match(strict.problems[0]!, /新要紧.*新要紧-gold/);
  assert.deepEqual(await run({ highAllRight: false }), { pass: true, problems: [] }, "得分率 0.95 够了");
});

// ---- Task 6: 暗题 ----
// final fix M10 以后暗题也要查得到的出处
const hq = (q: string, o: Partial<QuestionIn> = {}) => qin(q, { sources: ["e0001"], tags: noTags({ files: ["soul/80.md"] }), ...o });
const ownQ = (x: ReturnType<typeof sitting>) => x.bank.addPending(SD, "soul", [hq("自己的")]);
const hidRows = (x: ReturnType<typeof sitting>) => x.bank.pending(SD, "soul").filter((q) => q.hidden);
const runHid = (x: ReturnType<typeof sitting>) =>
  x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));

test("hidden: setter sees material and before, not the stage's after", async () => {
  const x = sitting({ exam: { hidden: 2 }, host: { setter: () => [hq("暗1"), hq("暗2")] } });
  ownQ(x);
  const r = await runHid(x);
  assert.deepEqual(r, { pass: true, problems: [] });
  const setters = x.opened.filter((s) => s.id.endsWith("-hidden"));
  assert.deepEqual(setters.map((s) => s.id), [sid("hidden")]);
  const s = setters[0]!;
  assert.deepEqual(s.allowed, ["exam_questions"]);
  assert.equal(s.model, x.flow.exam.graderModel);
  assert.match(s.wake, /材料/);
  assert.match(s.wake, /「before:soul\/80\.md」/);
  assert.doesNotMatch(s.wake, /「after:/);
  assert.match(s.wake, /2 道/);
  assert.equal(hidRows(x).length, 2);
  // 暗题记 hidden 阶段，不进整理前那轮
  assert.deepEqual([...new Set(x.results().filter((r) => r.q.endsWith("/2") || r.q.endsWith("/3")).map((r) => r.phase))], ["hidden"]);
  assert.ok(!x.opened.some((o) => o.id.includes("-before-")));
});

test("hidden: scored only — all wrong still passes, hidden_score 0", async () => {
  const x = sitting({ exam: { hidden: 2 }, host: { setter: () => [hq("暗1"), hq("暗2")], verdict: (_p, q) => (q.startsWith("暗") ? "wrong" : "right") } });
  ownQ(x);
  const r = await runHid(x);
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual(x.row(), { questions: 1, score_before: null, score_after: 1, regressions: 0, hidden_score: 0, examined: 1 });
});

test("hidden: hiddenGates on → hidden below newRate fails", async () => {
  const run = async (gates: boolean) => {
    const x = sitting({ exam: { hidden: 2, hiddenGates: gates }, host: { setter: () => [hq("暗1"), hq("暗2")], verdict: (_p, q) => (q.startsWith("暗") ? "wrong" : "right") } });
    ownQ(x);
    return runHid(x);
  };
  assert.equal((await run(false)).pass, true);
  const r = await run(true);
  assert.equal(r.pass, false);
  assert.equal(r.problems.length, 1, r.problems.join("|"));
  assert.match(r.problems[0]!, /暗题/);
});

test("hidden: setter fails twice → stage still examined, note 暗题没出成", async () => {
  const x = sitting({ exam: { hidden: 2 }, host: { setter: () => null } });
  ownQ(x);
  const r = await runHid(x);
  assert.deepEqual(r, { pass: true, problems: ["暗题没出成"] });
  assert.deepEqual(x.opened.filter((s) => s.id.includes("hidden")).map((s) => s.id), [sid("hidden"), sid("hidden-r")]);
  assert.deepEqual(x.row(), { questions: 1, score_before: null, score_after: 1, regressions: 0, hidden_score: null, examined: 1 });
  assert.equal(hidRows(x).length, 0);
});

test("hidden: skipped when hidden is 0 or the ladder drops it; reused on a redo", async () => {
  const none = sitting({ exam: { hidden: 0 }, host: { setter: () => [hq("暗")] } });
  ownQ(none);
  await runHid(none);
  assert.ok(!none.opened.some((s) => s.id.endsWith("-hidden")));
  const cut = sitting({ exam: { hidden: 2 }, ladder: { ...NO_SAVING, hidden: false }, host: { setter: () => [hq("暗")] } });
  ownQ(cut);
  await runHid(cut);
  assert.ok(!cut.opened.some((s) => s.id.endsWith("-hidden")));
  assert.equal(hidRows(cut).length, 0);
  const redo = sitting({ exam: { hidden: 2 }, host: { setter: () => [hq("暗")] } });
  ownQ(redo);
  redo.bank.addPending(SD, "soul", [hq("旧暗")], { hidden: true });
  const r = await runHid(redo);
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.ok(!redo.opened.some((s) => s.id.endsWith("-hidden")), "不重出");
  assert.equal(hidRows(redo).length, 1);
  assert.ok(redo.results().some((r) => r.phase === "hidden"), "旧暗题照考");
});

// ---- Task 7: 全天考试 ----
import { finalExam } from "../src/sleep/final.ts";

const OL = "memory/open-loops.md";
type Passed = Array<{ stage: string; record: StageRecord }>;
/** 一段过了的那次记录：实际改了的文件、changes 的 target（默认就是那几个文件） */
const prec = (stage: string, files: string[], targets: Array<string | (Partial<Change> & { target: string })> = files) =>
  ({ stage, record: { ...xrec(files, targets.map((t) => (typeof t === "string" ? { target: t } : t))), stage } });
const onFile = (file: string, q: string, o: Partial<QuestionIn> = {}) => qin(q, { isNew: false, tags: noTags({ files: [file] }), ...o });

/** 全天考试的场地：两段 events、people；finalOld、finalSample 默认 0（只看第 1 条挑题），测试里按需打开 */
function finalRig(o: {
  passed: Passed | (() => Passed); global?: Record<string, unknown>; host?: Parameters<typeof sitHost>[0];
  ladder?: LadderPlan; proposed?: Record<string, string>; logs?: LogRecord[];
  /** 这一夜开始的时刻（final fix M8：今晚考过的、今晚以前的判定按结果的时刻算）；默认 1000，就是题库的钟 */
  since?: number;
}) {
  const { db, bank, t } = mkBank();
  const flow = fmk([fagent("events", { title: "事件库" }), fagent("people", { title: "人物" })],
    { exam: { baseBlocks: BASE, inject: ["**"], finalOld: 0, finalSample: 0, ...o.global } });
  const h = sitHost(o.host);
  const files = new Map(Object.entries(o.proposed ?? {}).map(([p, s]): [string, string] => [`sleep/${SD}/proposed/${p}`, s]));
  const fs: MiniFs = {
    read: (p) => files.get(p) ?? null, write: (p, s) => void files.set(p, s), remove: (p) => void files.delete(p),
    list: () => [], isDir: () => false,
  };
  const passed = typeof o.passed === "function" ? o.passed : () => o.passed as Passed;
  const check = finalExam({
    host: h.host, bank, flow, fs, rnd: () => 0, ladder: () => o.ladder ?? NO_SAVING, passed, nightStart: () => o.since ?? 1000,
    ...(o.logs ? { log: new Logger("t", memorySink(o.logs)) } : {}),
  });
  const finals = () => all<{ q: string; stage: string; layer: string; verdict: string }>(db,
    "SELECT q, stage, layer, verdict FROM exam_result WHERE phase = 'final' ORDER BY id").map((r) => ({ ...r }));
  const ops = () => all<{ stage: string; kind: string; status: string }>(db, "SELECT stage, kind, status FROM exam_op ORDER BY id").map((r) => ({ ...r }));
  return { db, bank, flow, check, finals, ops, t, ...h };
}
const fid = (rest: string, n = "") => `exam-${SD}-final${n}-${rest}`;

test("final: questions on content touched by two stages are examined", async () => {
  const setup = async (global: Record<string, unknown> = {}) => {
    const seen: Array<{ day: string; stage: string; state: string; files: Array<[string, string | null]> }> = [];
    const x = finalRig({
      global,
      passed: [prec("events", [OL, "memory/events-only.md", "soul/20-性格.md"]), prec("people", [OL, "memory/people/a.md"])],
      host: {
        blocks: { "soul/10-来历.md": "十", "soul/20-性格.md": "二十旧" },
        preview: async (p) => { seen.push({ day: p.day, stage: p.stage, state: p.state, files: [...p.files] }); return "明天的样子"; },
      },
      proposed: { [OL]: "待办新", "memory/events-only.md": "事件新", "soul/20-性格.md": "二十新" },
    });
    const [both, single] = oldQs(x.bank, [onFile(OL, "两段都碰的"), onFile("memory/people/a.md", "只一段碰的")]);
    // 只一段碰的那道，人物那一段今晚考过了
    x.bank.record({ q: single!, day: SD, stage: "people", phase: "after", layer: "searchable", verdict: "right", reason: "", answer: "" });
    const [mine] = x.bank.addPending(SD, "events", [onFile(OL, "今天两段都碰的", { isNew: true })]);
    x.bank.addPending(SD, "people", [onFile("memory/people/a.md", "今天只一段碰的", { isNew: true })]);
    const r = await x.check(SD);
    return { x, r, seen, both, single, mine };
  };
  const { x, r, seen, both, mine } = await setup();
  assert.deepEqual(r, { redo: [] });
  assert.deepEqual(x.finals().map((f) => f.q).sort(), [both, mine].sort());
  assert.ok(x.finals().every((f) => f.stage === "final" && f.verdict === "right"));
  assert.deepEqual(x.opened.map((s) => s.id), [fid("after-searchable"), fid("grade-after")]);
  assert.ok(x.excludes.length > 0);
  for (const e of x.excludes) assert.deepEqual(e, ["soul/20-性格.md"], "开头去掉今晚改过的基础块");
  for (const s of x.opened) { assert.equal(s.opening, "十"); assert.equal(s.store, "live"); }
  assert.deepEqual(seen, [{ day: SD, stage: "final", state: "after", files: [
    [OL, "待办新"], ["memory/events-only.md", "事件新"], ["soul/20-性格.md", "二十新"], ["memory/people/a.md", null],
  ] }]);
  assert.match(x.opened[0]!.wake, /明天的样子/);
  assert.deepEqual(x.opened.map((s) => s.model), [x.flow.exam.examineeModel, x.flow.exam.graderModel]);
  // 抽题也不抽今晚一段已经考过的（fix round 1 裁定 1）
  const drawn = await setup({ finalSample: 1 });
  assert.ok(!drawn.x.finals().some((f) => f.q === drawn.single), "今晚考过的不抽");
});

test("final: a wrong answer is traced to the last stage that touched it", async () => {
  const x = finalRig({
    host: { verdict: (_p, q) => (q === "e0013 的事" ? "wrong" : "right") },
    passed: [
      prec("events", ["memory/a.md"], ["memory/a.md", "e0013「经过」"]),
      prec("people", ["memory/people/b.md"], ["memory/people/b.md", "e0013"]),
    ],
  });
  const [q13, ok13] = oldQs(x.bank, [
    qin("e0013 的事", { isNew: false, tags: noTags({ events: ["e0013"] }) }),
    qin("e0013 答得出的", { isNew: false, tags: noTags({ events: ["e0013"] }) }),
  ]);
  // plan 3 A5：全天考试照改层 op 考（不管重要度）；这里只看 op 不动，改层的 op 挂在退休的那道上
  x.bank.addOp(SD, "people", { kind: "layer", q: ok13!, layer: "archive", why: "挪" });
  x.bank.addOp(SD, "people", { kind: "retire", q: ok13!, why: "退" });
  x.bank.addOp(SD, "events", { kind: "layer", q: ok13!, layer: "archive", why: "挪" });
  const r = await x.check(SD);
  // final fix C2：人物申请了退休的那道今晚不考，只记一句
  assert.deepEqual(r, { redo: [{ stage: "people", problems: ["全天考试答错：e0013 的事（标准答案：e0013 的事-gold）"] }], notes: ["已申请退休：e0013 答得出的"] });
  assert.deepEqual(x.opened.map((s) => s.id), [fid("after-searchable"), fid("grade-after"), fid("retake-searchable"), fid("grade-retake")]);
  assert.match(x.opened[2]!.wake, /e0013 的事/);
  assert.doesNotMatch(x.opened[2]!.wake, /e0013 答得出的/, "只重考错的");
  assert.deepEqual(x.finals().map((f) => [f.q, f.verdict]), [[q13, "wrong"], [q13, "wrong"]]);
  // 全天考试不动 op：重做过了的那次考试自己换掉改层 op（fix round 1 裁定 2）
  assert.deepEqual(x.ops(), [
    { stage: "people", kind: "layer", status: "pending" },
    { stage: "people", kind: "retire", status: "pending" },
    { stage: "events", kind: "layer", status: "pending" },
  ]);
});

test("final: an untraced wrong answer goes to the stage that set it, or only to the log", async () => {
  const logs: LogRecord[] = [];
  const x = finalRig({
    logs, global: { finalSample: 1 },
    host: { verdict: (_p, q) => (["出处在人物的", "什么都没挂的", "没人碰的旧题"].includes(q) ? "wrong" : "right") },
    passed: [prec("events", [OL, "memory/a.md"]), prec("people", [OL, "memory/people/b.md"])],
  });
  oldQs(x.bank, [qin("没人碰的旧题", { isNew: false })]);
  x.bank.addPending(SD, "events", [qin("出处在人物的", { sources: ["memory/people/b.md:3"] }), qin("什么都没挂的")], { hidden: true });
  const r = await x.check(SD);
  assert.deepEqual(r, { redo: [
    { stage: "events", problems: ["全天考试答错：什么都没挂的（标准答案：什么都没挂的-gold）"] },
    { stage: "people", problems: ["全天考试答错：出处在人物的（标准答案：出处在人物的-gold）"] },
  ], notes: ["全天考试答错，追不到今晚哪一段：没人碰的旧题（标准答案：没人碰的旧题-gold）"] });
  assert.ok(logs.some((l) => l.level === "warn" && JSON.stringify(l).includes("没人碰的旧题")), JSON.stringify(logs));
});

test("final: all right → no redo", async () => {
  const x = finalRig({
    global: { finalOld: 5 },
    passed: [prec("events", [OL]), prec("people", [OL])],
  });
  const ids = oldQs(x.bank, [onFile(OL, "一"), onFile(OL, "二", { layer: "resident" }), onFile(OL, "三", { layer: "archive", sources: ["e0001"] })]);
  // plan 3 A5：重要度 3 的也照改层 op 考
  x.bank.addOp(SD, "people", { kind: "layer", q: ids[0]!, layer: "resident", why: "挪" });
  assert.deepEqual(await x.check(SD), { redo: [] });
  assert.deepEqual(x.finals().map((f) => [f.q, f.layer, f.verdict]).sort(),
    [[ids[0], "resident", "right"], [ids[1], "resident", "right"], [ids[2], "archive", "right"]].sort());
  assert.deepEqual(x.opened.map((s) => s.id), [fid("after-resident"), fid("grade-after")]);
  assert.deepEqual(x.ops().map((o) => o.status), ["pending"], "没点名重做，op 不动");
});

test("final: affects in tonight's records set the layer the question is examined in", async () => {
  let moved = "";
  const x = finalRig({
    passed: () => [
      prec("events", [OL], [{ target: OL, affects: [{ q: moved, layer: "resident" }] }]),
      prec("people", [OL], [{ target: OL, op: "fade", affects: [{ q: moved, layer: "archive" }] }]),
    ],
  });
  // final fix I3：一次只挪一层（查得到 → 只在仓库），只在仓库那层要有出处
  const ids = oldQs(x.bank, [onFile(OL, "挪走的", { sources: ["e0001", `${OL}:1`] }) /* plan 3 A7：挪进只在仓库的题要有 路径:行 出处 */, onFile(OL, "留着的", { layer: "resident" })]);
  moved = ids[0]!;
  assert.deepEqual(await x.check(SD), { redo: [] });
  assert.deepEqual(x.finals().map((f) => [f.q, f.layer]).sort(), [[moved, "archive"], [ids[1], "resident"]].sort(), "后过的段写的层算");
  assert.deepEqual(x.opened.map((s) => s.id), [fid("after-resident"), fid("grade-after")], "挪进仓库的不开考生");
});

test("final: final-old level examines only old questions", async () => {
  const run = async (ladder: LadderPlan) => {
    const x = finalRig({ ladder, global: { finalOld: 5, finalSample: 1 }, passed: [prec("events", [OL, "memory/x.md"]), prec("people", [OL])] });
    const [multi, touched, sampled] = oldQs(x.bank, [onFile(OL, "两段碰的旧题"), onFile("memory/x.md", "一段碰的旧题"), qin("抽到的旧题", { isNew: false })]);
    const [today] = x.bank.addPending(SD, "events", [onFile(OL, "今天的", { isNew: true })]);
    const [hid] = x.bank.addPending(SD, "people", [qin("暗的")], { hidden: true });
    await x.check(SD);
    return { got: x.finals().map((f) => f.q).sort(), want: { multi, touched, sampled, today, hid } };
  };
  const full = await run(NO_SAVING);
  const w = full.want;
  assert.deepEqual(full.got, [w.multi, w.touched, w.sampled, w.today, w.hid].sort());
  const old = await run({ ...NO_SAVING, level: 4, finalOldOnly: true });
  const o = old.want;
  assert.deepEqual(old.got, [o.multi, o.touched, o.sampled].sort(), "跳过今天的待定题和暗题");
});

test("final: never throws — a dead grader or broken input gives no redo and a warning", async () => {
  const logs: LogRecord[] = [];
  const x = finalRig({ logs, host: { dead: (id) => id.includes("-grade-"), verdict: () => "wrong" }, passed: [prec("events", [OL]), prec("people", [OL])] });
  oldQs(x.bank, [onFile(OL, "一")]);
  assert.deepEqual(await x.check(SD), { redo: [], notes: ["全天考试没考完：判分 after 两次都没交"] });
  assert.deepEqual(x.opened.filter((s) => s.id.includes("-grade-")).map((s) => s.id), [fid("grade-after"), `${fid("grade-after")}-r`]);
  assert.ok(logs.some((l) => l.level === "warn"), JSON.stringify(logs));

  const y = finalRig({ logs, passed: () => { throw new Error("记录坏了"); } });
  assert.deepEqual(await y.check(SD), { redo: [], notes: ["全天考试没考完：记录坏了"] });
  assert.ok(logs.some((l) => l.level === "warn" && JSON.stringify(l).includes("记录坏了")), JSON.stringify(logs));

  // 没有要考的：不拼注入、不开会话
  const z = finalRig({ passed: [prec("events", [OL])], host: { preview: async () => { throw new Error("不该拼注入"); } } });
  oldQs(z.bank, [onFile("memory/elsewhere.md", "不相干")]);
  assert.deepEqual(await z.check(SD), { redo: [] });
  assert.equal(z.opened.length, 0);
  assert.equal(z.excludes.length, 0);
});

test("bank: dropOps drops one stage's pending ops of the given kinds", () => {
  const { bank, db } = mkBank();
  const [a, b] = oldQs(bank, [qin("a"), qin("b")]);
  bank.addOp(SD, "people", { kind: "layer", q: a!, layer: "archive", why: "w" });
  bank.addOp(SD, "people", { kind: "retire", q: b!, why: "w" });
  bank.addOp(SD, "events", { kind: "layer", q: b!, layer: "resident", why: "w" });
  bank.addOp("2026-11-04", "people", { kind: "layer", q: b!, layer: "archive", why: "w" });
  assert.equal(bank.dropOps(SD, "people", ["layer"]), 1);
  assert.equal(bank.dropOps(SD, "people", ["layer"]), 0, "丢过的不再算");
  assert.equal(bank.dropOps(SD, "people", []), 0);
  assert.deepEqual(all<{ status: string }>(db, "SELECT status FROM exam_op ORDER BY id").map((r) => r.status), ["dropped", "pending", "pending", "pending"]);
  bank.activate(SD, ["people", "events"]);
  assert.equal(bank.get(a!)!.layer, "searchable", "丢掉的 op 落地时不执行");
  assert.equal(bank.get(b!)!.status, "retired");
  assert.equal(bank.get(b!)!.layer, "resident");
});

test("runner: passed(day) lists the day's passed stages in pass order with the passing attempt's record", async () => {
  const flow = fmk([
    fagent("events", { title: "事件库", writes: ["memory/events/**"] }),
    fagent("people", { title: "人物", writes: ["memory/people/**"], after: ["events"] }),
    { id: "finish", title: "finish", kind: "script", command: ["finish", "{day}"], after: ["people"] },
  ], { exam: { baseBlocks: BASE } });
  // 一个接一个开：事件库、人物，全天考试叫两段都重做：事件库重做过了、人物重做没过（changes 没说到改的文件）
  const plan: Array<[string, boolean]> = [["events", true], ["people", true], ["events", true], ["people", false]];
  let k = 0;
  const night = tinyNight({ act: (c) => {
    const [stage, ok] = plan[k++]!;
    const f = `memory/${stage}/a.md`;
    c.write(f, `${stage} ${k}`);
    // 切换前 P2：没说到改的文件，交 stage_done 时当场退回两次，第 3 次照交的收下（照旧没过）
    for (let i = 0; i < (ok ? 1 : 3); i++) c.done({ changes: ok ? [chg5(f)] : [] });
  } });
  const seen: Array<Array<[string, number, string[]]>> = [];
  let runner!: SleepRunner;
  const check = async (day: string) => {
    seen.push(runner.passed(day).map((p): [string, number, string[]] => [p.stage, p.record.attempt, p.record.actual.files.map((f) => f.path)]));
    return { redo: seen.length === 1 ? [{ stage: "events", problems: ["甲"] }, { stage: "people", problems: ["乙"] }] : [] };
  };
  runner = new SleepRunner(night.host, flow, { validators: [], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(k, 4);
  assert.deepEqual(seen, [
    [["events", 1, ["memory/events/a.md"]], ["people", 1, ["memory/people/a.md"]]],
    // 每次过了的都在，按过的先后：重做又过了的再记一条；重做没过的不记
    [["events", 1, ["memory/events/a.md"]], ["people", 1, ["memory/people/a.md"]], ["events", 2, ["memory/events/a.md"]]],
  ]);
  assert.deepEqual(runner.passed("2026-01-01"), [], "不是手上这一天");
});

test("runner + final: redo once, still wrong → lands with the question in 拿不准", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const bank = new Bank(night.db, () => 1000);
  const [q] = oldQs(bank, [onFile("memory/people/a.md", "阿甲是谁")]);
  const flow = nightFlow();
  const h = sitHost({ verdict: () => "wrong", preview: async ({ files }) => [...files].map(([p, t]) => `${p}=${t}`).join("\n") });
  const seen: Array<Array<[string, number]>> = [];
  let runner!: SleepRunner;
  const check = finalExam({
    host: h.host, bank, flow, fs: night.fs, rnd: () => 0, ladder: () => NO_SAVING,
    passed: (d) => { const p = runner.passed(d); seen.push(p.map((x): [string, number] => [x.stage, x.record.attempt])); return p; },
  });
  runner = new SleepRunner(night.host, flow, { validators: [], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.deepEqual(seen, [[["people", 1]], [["people", 1], ["people", 2]]], "第二次考的看得到第一次和重做的那一份");
  const base = `exam-${DN}-final`;
  assert.deepEqual(h.opened.map((s) => s.id), [
    `${base}-after-searchable`, `${base}-grade-after`, `${base}-retake-searchable`, `${base}-grade-retake`,
    `${base}2-after-searchable`, `${base}2-grade-after`, `${base}2-retake-searchable`, `${base}2-grade-retake`,
  ]);
  assert.match(h.opened[0]!.wake, /memory\/people\/a\.md=P1/);
  assert.match(h.opened[4]!.wake, /memory\/people\/a\.md=P2/, "第二次考的是重做后的提案");
  assert.equal(one<{ n: number }>(night.db, "SELECT count(*) AS n FROM sleep_stage WHERE stage = 'people'")!.n, 2, "只重做一次");
  const report = night.fs.read(`sleep/${DN}/report.md`)!;
  const unsure = report.slice(report.indexOf("## 拿不准"));
  assert.ok(report.includes("## 拿不准"), report);
  assert.match(unsure, /- 人物：全天考试还没过：全天考试答错：阿甲是谁（标准答案：阿甲是谁-gold）/);
  assert.equal(all(night.db, "SELECT 1 FROM exam_result WHERE q = ? AND phase = 'final'", q!).length, 4);
});

// ---- Task 7 fix round 1 ----
const pastResult = (bank: Bank, q: string, day: string, verdict: Verdict, phase: "after" | "retake" | "before" | "final" | "hidden" = "after") =>
  bank.record({ q, day, stage: phase === "final" ? "final" : "people", phase, layer: "searchable", verdict, reason: "", answer: "" });

// final fix M8：按结果记下的时刻（at）跟这一夜开始的时刻比，不按材料的日子
test("bank: examinedOn(day, since) and lastVerdictBefore(q, before) go by when the result was recorded", () => {
  const { bank, t } = mkBank();
  const [a, b, c, d] = oldQs(bank, [qin("a"), qin("b"), qin("c"), qin("d")]);
  pastResult(bank, a!, SD, "right", "after");
  pastResult(bank, b!, SD, "wrong", "hidden");
  pastResult(bank, c!, SD, "wrong", "final");
  pastResult(bank, d!, "2026-11-04", "right", "retake");
  assert.deepEqual([...bank.examinedOn(SD, 1000)].sort(), [a, b].sort(), "全天考试的不算，别的日子的不算");
  assert.deepEqual([...bank.examinedOn("2026-11-01", 0)], []);
  assert.deepEqual([...bank.examinedOn(SD, 1001)], [], "这一夜开始以前记的不算今晚考过");
  t.v = 2000;
  pastResult(bank, a!, "2026-11-02", "right");
  t.v = 3000;
  pastResult(bank, a!, "2026-11-03", "partial");
  assert.equal(bank.lastVerdictBefore(a!, 5000), "partial", "最后记的那次");
  assert.equal(bank.lastVerdictBefore(a!, 3000), "right", "那一刻和以后的不算");
  assert.equal(bank.lastVerdictBefore(a!, 1000), null);
  // 推迟的日子换一夜再整理：日子早、记得晚，按记下的先后算；同一刻记的，后记的算
  t.v = 4000;
  pastResult(bank, a!, "2026-11-02", "partial");
  pastResult(bank, a!, "2026-11-01", "wrong");
  assert.equal(bank.lastVerdictBefore(a!, 5000), "wrong");
  assert.equal(bank.lastVerdictBefore(d!, 5000), "right");
  assert.equal(bank.lastVerdictBefore("q:none", 5000), null);
});

test("final: a question one stage touched and examined tonight is not re-examined, even with the default finalOld", async () => {
  const x = finalRig({
    global: { finalOld: undefined, finalSample: undefined },
    passed: [prec("events", [OL]), prec("people", [OL, "memory/people/a.md"])],
  });
  assert.equal(x.flow.exam.finalOld, 20);
  assert.equal(x.flow.exam.finalSample, 5);
  const [shared, examined, notYet, byFinal, yesterday] = oldQs(x.bank, [
    onFile(OL, "两段碰的"), onFile("memory/people/a.md", "人物考过的"), onFile("memory/people/a.md", "人物没考的"),
    qin("只被全天考试考过的", { isNew: false }), qin("昨天考过的", { isNew: false }),
  ]);
  const [hid] = x.bank.addPending(SD, "people", [qin("暗的")], { hidden: true });
  pastResult(x.bank, shared!, SD, "right");
  pastResult(x.bank, examined!, SD, "right", "retake");
  pastResult(x.bank, hid!, SD, "right", "hidden");
  pastResult(x.bank, byFinal!, SD, "right", "final");
  pastResult(x.bank, yesterday!, "2026-11-04", "right");
  const before = x.finals().length;
  await x.check(SD);
  assert.deepEqual(x.finals().slice(before).map((f) => f.q).sort(), [shared, notYet, byFinal, yesterday, hid].sort(),
    "两段碰过的、暗题照考；一段碰过、今晚考过的不考，也不抽");
});

test("stage exam: a stage passing twice keeps only the second pass's layer ops", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [a, b] = oldQs(x.bank, [on80("甲", { sources: ["soul/80.md:1"] }), on80("乙")]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  x.bank.addOp(SD, "soul", { kind: "retire", q: b!, why: "退" });
  const rec = (attempt: number, layer: Layer): StageRecord =>
    ({ ...xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "fade", affects: [{ q: a!, layer }] }]), attempt });
  assert.equal((await x.v.validate(x.stage, SD, rec(1, "archive"), xctx(["soul/80.md"]))).pass, true);
  assert.equal((await x.v.validate(x.stage, SD, rec(2, "resident"), xctx(["soul/80.md"]))).pass, true);
  const ops = all<{ kind: string; value: string; status: string }>(x.db, "SELECT kind, value, status FROM exam_op ORDER BY id");
  assert.deepEqual(ops.map((o) => [o.kind, (JSON.parse(o.value) as { layer?: string }).layer ?? null, o.status]), [
    ["retire", null, "pending"], ["layer", "archive", "dropped"], ["layer", "resident", "pending"],
  ]);
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(a!)!.layer, "resident");
  assert.equal(x.bank.get(b!)!.status, "retired");
});

test("runner + final: a redo that never runs keeps the stage's original layer ops", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const bank = new Bank(night.db, () => 1000);
  const [q] = oldQs(bank, [onFile("memory/people/a.md", "阿甲是谁")]);
  bank.addOp(DN, "people", { kind: "layer", q: q!, layer: "archive", why: "人物这一段写的" });
  const flow = nightFlow();
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const h = sitHost({ verdict: () => "wrong" });
  let runner!: SleepRunner;
  const exam = finalExam({ host: h.host, bank, flow, fs: night.fs, rnd: () => 0, ladder: () => NO_SAVING, passed: (d) => runner.passed(d) });
  // 第一次考完花费到了绝对线：点名的段不重做
  const check = async (d: string) => { const r = await exam(d); budget.add(1e10); return r; };
  runner = new SleepRunner(night.host, flow, { validators: [], finalCheck: check, budget, watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(n, 1, "没重做");
  assert.match(night.fs.read(`sleep/${DN}/report.md`)!, /人物：全天考试要它重做，花费到了绝对线，没重做/);
  assert.deepEqual(all<{ status: string }>(night.db, "SELECT status FROM exam_op").map((r) => r.status), ["pending"]);
});

test("exam config: finalShared defaults to 40 and is checked like finalOld", () => {
  assert.equal(fmk([fagent("a")]).exam.finalShared, 40);
  assert.equal(fmk([fagent("a")], { exam: { finalShared: 0 } }).exam.finalShared, 0);
  for (const bad of [-1, Infinity, "10"]) {
    const e = flowErr(() => fmk([fagent("a")], { exam: { finalShared: bad } }));
    assert.deepEqual(e.problems.length, 1, e.problems.join("|"));
    assert.ok(e.problems[0]!.includes("finalShared"), e.problems.join("|"));
  }
});

test("final: shared-content questions are capped by finalShared — importance, then the stalest — and scaled by the ladder", async () => {
  const run = async (finalShared: number, ladder: LadderPlan = NO_SAVING) => {
    const x = finalRig({ ladder, global: { finalShared }, passed: [prec("events", [OL]), prec("people", [OL])] });
    const [top, seen500, never, seen900] = oldQs(x.bank, [
      onFile(OL, "甲", { importance: 5 }), onFile(OL, "乙"), onFile(OL, "丙"), onFile(OL, "戊"),
    ]);
    const [today] = x.bank.addPending(SD, "events", [onFile(OL, "丁", { importance: 4, isNew: true })]);
    const at = x.db.prepare("UPDATE exam_q SET last_examined = ? WHERE id = ?");
    at.run(500, seen500!);
    at.run(900, seen900!);
    await x.check(SD);
    return { got: x.finals().map((f) => f.q), ids: { top, today, never, seen500, seen900 } };
  };
  const all5 = await run(40);
  assert.equal(all5.got.length, 5);
  const three = await run(3);
  assert.deepEqual(three.got.slice().sort(), [three.ids.top, three.ids.today, three.ids.never].sort(), "重要的先，同样重要的没考过的先");
  const four = await run(4);
  assert.ok(four.got.includes(four.ids.seen500!) && !four.got.includes(four.ids.seen900!), "上次考得早的先");
  const halved = await run(6, { ...NO_SAVING, level: 2, oldScale: 0.5 });
  assert.equal(halved.got.length, 3);
  const floor = await run(1, { ...NO_SAVING, level: 2, oldScale: 0.5 });
  assert.deepEqual(floor.got, [floor.ids.top], "向下取整，至少 1");
});

test("final: an old question that was already shaky before tonight names no stage, only a note", async () => {
  const logs: LogRecord[] = [];
  const x = finalRig({
    logs, host: { verdict: (_p, q) => (q === "今天对的" ? "right" : "wrong") },
    passed: [prec("events", [OL]), prec("people", [OL])],
  });
  const [shaky, solid, half, fine] = oldQs(x.bank, [onFile(OL, "早就答不好的"), onFile(OL, "一直答得好的"), onFile(OL, "上次部分对的"), onFile(OL, "今天对的")]);
  // final fix M8：今晚以前 = 这一夜开始（1000）以前记的
  x.t.v = 500;
  pastResult(x.bank, shaky!, "2026-11-02", "right");
  pastResult(x.bank, shaky!, "2026-11-03", "wrong");
  pastResult(x.bank, solid!, "2026-11-02", "wrong");
  pastResult(x.bank, solid!, "2026-11-03", "right");
  pastResult(x.bank, half!, "2026-11-03", "partial");
  pastResult(x.bank, fine!, "2026-11-03", "wrong");
  x.t.v = 1000;
  pastResult(x.bank, solid!, SD, "wrong", "retake");
  const r = await x.check(SD);
  assert.deepEqual(r, {
    redo: [{ stage: "people", problems: ["全天考试答错：一直答得好的（标准答案：一直答得好的-gold）"] }],
    notes: ["整理前就答不好：早就答不好的", "整理前就答不好：上次部分对的"],
  });
  for (const q of ["早就答不好的", "上次部分对的"]) {
    assert.ok(logs.some((l) => l.level === "warn" && JSON.stringify(l).includes(q)), `${q}：${JSON.stringify(logs)}`);
  }
});

test("runner: notes from the whole-day exam go to the top of the day's report, once", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  let calls = 0;
  const check = async () => {
    calls += 1;
    return { redo: calls === 1 ? [{ stage: "people", problems: ["甲"] }] : [], notes: ["整理前就答不好：阿甲是谁"] };
  };
  const runner = new SleepRunner(night.host, nightFlow(), { validators: [], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(calls, 2);
  const lines = night.fs.read(`sleep/${DN}/report.md`)!.split("\n").filter(Boolean);
  assert.equal(lines[1], "整理前就答不好：阿甲是谁");
  assert.equal(lines.filter((l) => l.includes("整理前就答不好")).length, 1);
});

// ---- Task 7 fix round 2 ----
test("bank: dropOps can be limited to some questions", () => {
  const { bank, db } = mkBank();
  const [a, b] = oldQs(bank, [qin("a"), qin("b")]);
  bank.addOp(SD, "people", { kind: "layer", q: a!, layer: "archive", why: "w" });
  bank.addOp(SD, "people", { kind: "layer", q: b!, layer: "archive", why: "w" });
  assert.equal(bank.dropOps(SD, "people", ["layer"], new Set()), 0, "一道都没给就什么都不丢");
  assert.equal(bank.dropOps(SD, "people", ["layer"], new Set([b!, "q:none"])), 1);
  assert.deepEqual(all<{ status: string }>(db, "SELECT status FROM exam_op ORDER BY id").map((r) => r.status), ["pending", "dropped"]);
});

test("stage exam: a passing redo replaces only the layer ops of the questions it re-decided", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [q1, q2] = oldQs(x.bank, [on80("一", { sources: ["soul/80.md:1"] }), qin("二", { isNew: false, sources: ["soul/90.md:1"], tags: noTags({ files: ["soul/90.md"] }) })]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  const both = ["soul/80.md", "soul/90.md"];
  const first = xrec(both, [
    { target: "soul/80.md", op: "fade", affects: [{ q: q1!, layer: "archive" }] },
    { target: "soul/90.md", op: "fade", affects: [{ q: q2!, layer: "archive" }] },
  ]);
  assert.equal((await x.v.validate(x.stage, SD, first, xctx(both))).pass, true);
  const seen = x.results().length;
  // 全天考试后重做：只改了 soul/90.md，只考到二
  const redo: StageRecord = { ...xrec(["soul/90.md"], [{ target: "soul/90.md", op: "fade", affects: [{ q: q2!, layer: "resident" }] }]), attempt: 2 };
  assert.equal((await x.v.validate(x.stage, SD, redo, xctx(["soul/90.md"]))).pass, true);
  assert.deepEqual([...new Set(x.results().slice(seen).map((r) => r.q))], [q2], "重做只考到二");
  const ops = all<{ q: string; value: string; status: string }>(x.db, "SELECT q, value, status FROM exam_op ORDER BY id");
  assert.deepEqual(ops.map((o) => [o.q, (JSON.parse(o.value) as { layer: string }).layer, o.status]), [
    [q1, "archive", "pending"], [q2, "archive", "dropped"], [q2, "resident", "pending"],
  ]);
});

test("runner + final: the second exam still sees what attempt 1 changed when the redo fixed only part of it", async () => {
  let k = 0;
  let moved = "";
  const night = tinyNight({ act: (c) => {
    k += 1;
    if (k === 1) {
      c.write("memory/people/a.md", "A1");
      c.write("memory/people/b.md", "B1");
      c.done({ changes: [{ ...chg5("memory/people/a.md"), op: "archive", affects: [{ q: moved, layer: "archive" }] }, chg5("memory/people/b.md")] });
    } else {
      c.write("memory/people/b.md", `B${k}`);
      c.done({ changes: [chg5("memory/people/b.md")] });
    }
  } });
  const bank = new Bank(night.db, () => 1000);
  const [arch] = oldQs(bank, [onFile("memory/people/a.md", "挪进仓库的", { sources: ["e0001", "memory/people/a.md:1"] }) /* plan 3 A7：挪进只在仓库的题要有 路径:行 出处 */, onFile("memory/people/b.md", "乙文件里的")]);
  moved = arch!;
  const flow = nightFlow();
  const previews: string[][] = [];
  const h = sitHost({
    verdict: (_p, q) => (q === "乙文件里的" ? "wrong" : "right"),
    preview: async ({ files }) => { previews.push([...files.keys()].sort()); return [...files].map(([p, t]) => `${p}=${t}`).join("\n"); },
  });
  let runner!: SleepRunner;
  const check = finalExam({ host: h.host, bank, flow, fs: night.fs, rnd: () => 0, ladder: () => NO_SAVING, passed: (d) => runner.passed(d) });
  runner = new SleepRunner(night.host, flow, { validators: [], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(k, 2, "重做了一次");
  assert.deepEqual(previews, [["memory/people/a.md", "memory/people/b.md"], ["memory/people/a.md", "memory/people/b.md"]]);
  assert.match(h.opened.find((s) => s.id === `exam-${DN}-final2-after-searchable`)!.wake, /memory\/people\/a\.md=A1/);
  assert.deepEqual(all<{ layer: string }>(night.db, "SELECT layer FROM exam_result WHERE q = ? AND phase = 'final' ORDER BY id", arch!).map((r) => r.layer),
    ["archive", "archive"], "第一次挪进仓库的，第二次照样在仓库那层考");
});

test("runner: a final-exam redo that passes keeps the first report and adds the redo's", async () => {
  let k = 0;
  const night = tinyNight({ act: (c) => {
    k += 1;
    c.write("memory/people/a.md", `P${k}`);
    c.done(k === 1
      ? { changes: [chg5("memory/people/a.md")], report: "第一次的报告", uncertain: ["拿不准甲"], proposals: ["提案甲"], bugs: ["毛病甲"] }
      : { changes: [chg5("memory/people/a.md")], report: "重做的报告", uncertain: ["拿不准甲", "拿不准乙"], proposals: ["提案乙"], bugs: [] });
  } });
  let calls = 0;
  const check = async () => { calls += 1; return { redo: calls === 1 ? [{ stage: "people", problems: ["甲"] }] : [] }; };
  const runner = new SleepRunner(night.host, nightFlow(), { validators: [], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(k, 2);
  const report = night.fs.read(`sleep/${DN}/report.md`)!;
  assert.ok(report.includes("### 人物\n第一次的报告\n\n（全天考试后重做）重做的报告\n"), report);
  const lines = report.split("\n");
  for (const l of ["- 人物：拿不准甲", "- 人物：拿不准乙", "- 人物：提案甲", "- 人物：提案乙", "- 人物：毛病甲"]) {
    assert.equal(lines.filter((x) => x === l).length, 1, `${l}\n${report}`);
  }
});

test("final: an old question untouched tonight is not pinned on today's stage of the same name", async () => {
  const x = finalRig({ global: { finalSample: 1 }, host: { verdict: () => "wrong" }, passed: [prec("events", [OL]), prec("people", [OL])] });
  const [old] = x.bank.addPending("2026-11-01", "events", [qin("事件库以前出的", { isNew: false })]);
  x.bank.activate("2026-11-01", ["events"]);
  pastResult(x.bank, old!, "2026-11-03", "right");
  assert.deepEqual(await x.check(SD), { redo: [], notes: ["全天考试答错，追不到今晚哪一段：事件库以前出的（标准答案：事件库以前出的-gold）"] });
});

test("final: a broken final exam says so in a note", async () => {
  const run = async (dead: string) => {
    const x = finalRig({ host: { dead: (id) => id.includes(dead) }, passed: [prec("events", [OL]), prec("people", [OL])] });
    oldQs(x.bank, [onFile(OL, "一")]);
    return x.check(SD);
  };
  assert.deepEqual(await run("-grade-"), { redo: [], notes: ["全天考试没考完：判分 after 两次都没交"] });
  assert.deepEqual(await run("-after-searchable"), { redo: [], notes: ["全天考试没考完：考生 after-searchable 两次都没交卷"] });
});

test("runner: no second whole-day exam once the budget is over the hard line", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  let calls = 0;
  // 重做那一次花费到了绝对线
  const spend: StageValidator = { name: "spend", async validate() { if (calls === 1) budget.add(1e10); return { pass: true, problems: [] }; } };
  const check = async () => { calls += 1; return { redo: [{ stage: "people", problems: ["甲"] }] }; };
  const runner = new SleepRunner(night.host, nightFlow(), { validators: [spend], finalCheck: check, budget, watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(n, 2, "重做了");
  assert.equal(calls, 1, "没再考第二次");
  const report = night.fs.read(`sleep/${DN}/report.md`)!;
  assert.ok(report.split("\n").includes("花费到了绝对线，重做以后的全天考试没考"), report);
});

test("stage exam: a passing redo that only samples a question keeps that question's earlier layer op", async () => {
  const x = sitting({ exam: { sample: 1 } });
  const [q1] = oldQs(x.bank, [qin("七十里的", { isNew: false, sources: ["soul/70.md:1"], tags: noTags({ files: ["soul/70.md"] }) })]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  const first = xrec(["soul/70.md"], [{ target: "soul/70.md", op: "fade", affects: [{ q: q1!, layer: "archive" }] }]);
  assert.equal((await x.v.validate(x.stage, SD, first, xctx(["soul/70.md"]))).pass, true);
  const seen = x.results().length;
  // 重做只改了 soul/90.md：七十里的只是被抽到考了一次，这一次没给它新的层
  const redo: StageRecord = { ...xrec(["soul/90.md"], [{ target: "soul/90.md" }]), attempt: 2 };
  assert.equal((await x.v.validate(x.stage, SD, redo, xctx(["soul/90.md"]))).pass, true);
  assert.deepEqual([...new Set(x.results().slice(seen).map((r) => r.q))], [q1], "重做抽到了它");
  assert.deepEqual(all<{ q: string; status: string }>(x.db, "SELECT q, status FROM exam_op ORDER BY id").map((o) => [o.q, o.status]),
    [[q1, "pending"]]);
});

test("stage exam: a passing redo declaring a question back to its current layer cancels the earlier move", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [q] = oldQs(x.bank, [on80("挪来挪去的", { sources: ["soul/80.md:1"] })]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  const decl = (attempt: number, layer: Layer): StageRecord =>
    ({ ...xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer }] }]), attempt });
  assert.equal((await x.v.validate(x.stage, SD, decl(1, "archive"), xctx(["soul/80.md"]))).pass, true);
  assert.deepEqual(all<{ status: string }>(x.db, "SELECT status FROM exam_op").map((o) => o.status), ["pending"]);
  // 重做说它还在查得到（就是现在的层）：上一次的挪层撤掉，不写新的
  assert.equal((await x.v.validate(x.stage, SD, decl(2, "searchable"), xctx(["soul/80.md"]))).pass, true);
  assert.deepEqual(all<{ status: string }>(x.db, "SELECT status FROM exam_op WHERE q = ? ORDER BY id", q!).map((o) => o.status), ["dropped"]);
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(q!)!.layer, "searchable");
});

// ---- Task 8：省钱阶梯和缓存核实 ----
import { saveLevel, ladderPlan, examCacheCheck } from "../src/sleep/ladder.ts";

test("ladder: levels by pct", () => {
  const b = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 2 });
  const at = (pct: number) => { const x = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 2 }); x.add(pct * 100); return saveLevel(x); };
  assert.equal(saveLevel(b), 0);
  assert.deepEqual([0.9, 1.0, 1.25, 1.5, 1.75, 3].map(at), [0, 1, 2, 3, 4, 4]);
});

test("ladder: plan follows the configured order", () => {
  const flow = fmk([fagent("soul")], { exam: { saveLadder: ["old", "hidden", "cheap", "final-old"] } });
  assert.deepEqual(ladderPlan(flow, 0), NO_SAVING);
  assert.deepEqual(ladderPlan(flow, 1), { ...NO_SAVING, level: 1, oldScale: 0.5 });
  assert.deepEqual(ladderPlan(flow, 2), { ...NO_SAVING, level: 2, oldScale: 0.5, hidden: false });
  assert.deepEqual(ladderPlan(flow, 4), { level: 4, hidden: false, oldScale: 0.5, cheap: true, finalOldOnly: true });
  const dflt = fmk([fagent("soul")]);
  assert.deepEqual(ladderPlan(dflt, 3), { level: 3, hidden: false, oldScale: 0.5, cheap: true, finalOldOnly: false });
});

test("stage exam under level 2: no hidden setter, old cap halved", async () => {
  const x = sitting({ exam: { hidden: 2, old: 4, sample: 0 }, host: { setter: () => [hq("暗")] } });
  const plan = ladderPlan(x.flow, 2);
  const y = sitting({ exam: { hidden: 2, old: 4, sample: 0 }, ladder: plan, host: { setter: () => [hq("暗")] } });
  for (const s of [x, y]) {
    ownQ(s);
    oldQs(s.bank, [on80("一"), on80("二"), on80("三"), on80("四")]);
    await runHid(s);
  }
  assert.ok(x.opened.some((s) => s.id.endsWith("-hidden")), "不省时出暗题");
  assert.ok(!y.opened.some((s) => s.id.endsWith("-hidden")), "第 2 级不出暗题");
  const olds = (s: typeof x) => new Set(s.results().filter((r) => r.phase === "after").map((r) => r.q)).size;
  assert.equal(olds(y), olds(x) - 2, "旧题上限减半");
});

test("ladder cheap: the stage grader and the hidden setter use sonnet, examinees keep their model", async () => {
  const x = sitting({ exam: { hidden: 1, old: 2, sample: 0 }, global: { graderModel: "opus", examineeModel: "opus" },
    ladder: { ...NO_SAVING, level: 3, cheap: true }, host: { setter: () => [hq("暗")] } });
  ownQ(x);
  oldQs(x.bank, [on80("一")]);
  await runHid(x);
  assert.ok(x.opened.some((s) => s.id.endsWith("-hidden")));
  assert.deepEqual([...new Set(x.opened.filter((s) => s.id.endsWith("-hidden") || s.id.includes("-grade-")).map((s) => s.model))], ["sonnet"]);
  assert.ok(x.opened.filter((s) => !s.id.endsWith("-hidden") && !s.id.includes("-grade-")).every((s) => s.model === "opus"));
});

test("ladder cheap: the final exam grader uses sonnet", async () => {
  const x = finalRig({ global: { graderModel: "opus" }, ladder: { ...NO_SAVING, level: 3, cheap: true },
    passed: [prec("events", [OL]), prec("people", [OL])] });
  oldQs(x.bank, [onFile(OL, "一")]);
  await x.check(SD);
  const g = x.opened.filter((s) => s.id.includes("-grade-"));
  assert.ok(g.length > 0);
  assert.ok(g.every((s) => s.model === "sonnet"), JSON.stringify(g.map((s) => s.model)));
});

test("cache check: second exam session with zero cacheRead is flagged", () => {
  const c = examCacheCheck();
  const u = (cacheRead: number, calls = 3) => ({ calls, input: 1, cacheRead, cacheWrite: 1, output: 1, maxCtx: 1 });
  assert.equal(c.seen("a", u(0)), null, "第一个不管");
  assert.equal(c.seen("b", u(500)), null);
  assert.equal(c.seen("c", u(0, 0)), null, "没调用过的不算");
  assert.equal(c.seen("d", u(0)), "考试会话 d 没吃到缓存");
});

test("save_level: the highest level of the night is recorded", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const budget = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 2 });
  // 验证时花到第 3 级，后面又不再涨：记到的是到过的最高一级
  const spend: StageValidator = { name: "spend", async validate() { budget.add(150); return { pass: true, problems: [] }; } };
  const runner = new SleepRunner(night.host, nightFlow(), { validators: [spend], budget, watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  const row = one<{ save_level: number }>(night.db, "SELECT save_level FROM sleep_run WHERE id = ?", res.runId)!;
  assert.equal(row.save_level, 3);
});

test("final: an active question dated today (a day revisited) is not pinned on tonight's stage of the same id", async () => {
  const x = finalRig({ global: { finalSample: 1 }, host: { verdict: () => "wrong" }, passed: [prec("events", [OL]), prec("people", [OL])] });
  x.bank.addPending(SD, "events", [qin("重访那天出的", { isNew: false })]);
  x.bank.activate(SD, ["events"]);
  assert.deepEqual(await x.check(SD), { redo: [], notes: ["全天考试答错，追不到今晚哪一段：重访那天出的（标准答案：重访那天出的-gold）"] });
});

// ---- Task 9：runner 告诉 host 一次尝试结束了、落地了、撤回了 ----

/** tinyNight 的 host 上记下 runner 调了哪几个通知、叫醒的话、验证器拿到的材料 */
function hooked(n: ReturnType<typeof tinyNight>) {
  const calls: string[] = [];
  n.host.attemptEnded = (day, stage) => { calls.push(`ended ${day} ${stage}`); };
  n.host.landed = (day, stages) => { calls.push(`landed ${day} ${stages.join(",")}`); };
  n.host.abandoned = (day, keep) => { calls.push(`abandoned ${day} ${keep.join(",")}`); };
  n.host.wakeNotes = (_day, stage) => `【给 ${stage.id} 的旧题】`;
  const wakes: string[] = [];
  const open = n.host.open.bind(n.host);
  n.host.open = (x) => {
    const sess = open(x);
    const wake = sess.wake;
    sess.wake = (t: string) => { wakes.push(t); wake(t); };
    return sess;
  };
  const material: string[] = [];
  const spy: StageValidator = { name: "spy", validate: async (_s, _d, _r, ctx) => { material.push(ctx!.material); return { pass: true, problems: [] }; } };
  return { calls, wakes, material, spy };
}

test("runner hooks: a landed day tells the host which stages passed; the attempt's end is reported; wake notes go into the wake only", async () => {
  const n = tinyNight({ act: (c) => c.done() });
  const h = hooked(n);
  const r = await runNightWith(n, nightFlow(), [h.spy]);
  assert.deepEqual(r.landed, [DN]);
  assert.deepEqual(h.calls, [`ended ${DN} people`, `landed ${DN} people`]);
  assert.match(h.wakes[0]!, /材料 2026-11-04：[\s\S]*【给 people 的旧题】/, "旧题那一节接在材料后面");
  assert.deepEqual(h.material, [`材料 ${DN}：`], "验证器拿到的材料不带它");
});

test("runner hooks: the attempt's end is reported after a mechanical miss too; an abandoned day keeps the deferred stages", async () => {
  // 两次都改了文件却没写进 changes：机械检查不过（验证器都没请）→ 推迟；finish 没过 → 整天撤回
  const n = tinyNight({ act: (c) => { c.write("memory/people/a.md", "x"); c.done(); } });
  n.host.run = async () => ({ code: 1, out: "落地失败" });
  const h = hooked(n);
  const r = await runNightWith(n, nightFlow(), [{ name: "never", validate: async () => { throw new Error("机械检查没过就不该请验证器"); } }]);
  assert.deepEqual(r.deferredDays, [DN]);
  assert.deepEqual(h.calls, [`ended ${DN} people`, `ended ${DN} people`, `abandoned ${DN} people`]);
});

test("runner hooks: the attempt's end is reported when no stage_done came", async () => {
  const n = tinyNight({ act: () => {} });
  const h = hooked(n);
  const r = await runNightWith(n, nightFlow(), [h.spy]);
  assert.deepEqual(r.landed, [DN], "没开成的段不是 required：照样落地");
  assert.deepEqual(h.calls, [`ended ${DN} people`, `ended ${DN} people`, `landed ${DN} `]);
  assert.deepEqual(h.material, [], "没交差就没验");
});

test("stage exam: every exam session hides sleep/ and the files this stage changed", async () => {
  const x = sitting();
  x.bank.addPending(SD, "soul", [qin("常1", { layer: "resident" }), qin("查1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md", "soul/81.md"], [{ target: "soul/80.md" }, { target: "soul/81.md" }]), xctx(["soul/80.md", "soul/81.md"]));
  assert.equal(r.pass, true);
  assert.deepEqual(x.opened.map((s) => s.id), [sid("after-resident"), sid("after-searchable"), sid("grade-after")]);
  for (const s of x.opened) assert.deepEqual((s as Sat & { hide?: string[] }).hide, ["sleep/", "soul/80.md", "soul/81.md"], s.id);
});

test("stage exam: before-state archive checks look at the stage's starting snapshot; after-state ones don't", async () => {
  const x = sitting();
  const seen: Array<{ state: string; files: unknown }> = [];
  x.host.sourceExists = (_ref, o) => { seen.push({ state: o.state, files: o.files }); return o.state === "before"; };
  oldQs(x.bank, [on80("仓库里的", { layer: "archive", sources: ["soul/80.md:3"] })]);
  const ctx = xctx(["soul/80.md"]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), ctx);
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith("倒退：仓库里的")), r.problems.join("|"));
  assert.ok(seen.some((v) => v.state === "before" && v.files === ctx.before));
  assert.ok(seen.filter((v) => v.state === "after").every((v) => v.files === undefined));
});

test("final: exam sessions hide sleep/ and every file changed tonight", async () => {
  const x = finalRig({ passed: [prec("events", [OL, "memory/e.md"]), prec("people", [OL, "memory/people/a.md"])] });
  oldQs(x.bank, [onFile(OL, "两段都碰的")]);
  await x.check(SD);
  assert.ok(x.opened.length > 0);
  for (const s of x.opened) assert.deepEqual([...((s as Sat & { hide?: string[] }).hide ?? [])].sort(), ["memory/e.md", "memory/people/a.md", OL, "sleep/"].sort(), s.id);
});

// ---- Task 9 fix round 1（补）：整理前的出处：这一段开始时的样子 → 今天的提案 → 工作区 ----
import { nightHosts, sleepWeights, type NightBrain } from "../src/sleep/host.ts";
import { loadConfig } from "../src/config.ts";
import { FakeDriver } from "../src/kernel/fake.ts";

test("host sourceExists before-state: start snapshot, then today's proposal (an earlier stage's edit outside this stage's scope), then the workspace", () => {
  const W = "/tmp/hh-test-ws";
  const cfg = loadConfig({ workspace: W, stateDir: tmpDir("hh-exam-src-") });
  const files = new Map<string, string>([
    // 前面一段（不归这一段管的文件）提议删掉了第三行
    ["memory/x.md", "一\n二\n三\n"], [`sleep/${SD}/proposed/memory/x.md`, "一\n二\n"],
    // 只在工作区的
    ["memory/w.md", "一\n二\n三\n"],
    // 这一段管的：开始时三行，现在的提案只剩一行
    ["soul/80.md", "一\n"], [`sleep/${SD}/proposed/soul/80.md`, "一\n"],
  ]);
  const fs: MiniFs = {
    read: (p) => files.get(p) ?? null, write: (p, s) => void files.set(p, s), remove: (p) => void files.delete(p),
    list: () => [], isDir: () => false,
  };
  const b: NightBrain = {
    cfg, driver: new FakeDriver(), db: openDb(":memory:"), log: new Logger("t", () => {}), mem: null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => null, now: () => 1000, later: () => () => {},
    hhTools: () => [],
  };
  const flow = examFlow();
  const hosts = nightHosts(b, { flow, prefix: "P", hash: "h" }, { budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), weights: sleepWeights(undefined), auditMs: 60_000 });
  const exam = hosts.exam!;
  const start: Snapshot = snapOf({ "soul/80.md": "一\n二\n三\n" });
  const before = (ref: string) => exam.sourceExists(ref, { day: SD, state: "before", files: start });
  assert.equal(before("memory/x.md:2"), true);
  assert.equal(before("memory/x.md:3"), false, "不归这一段管的：前面一段的提案就是这一段的整理前，删掉的那行不算");
  assert.equal(before("memory/w.md:3"), true, "提案里没有：看工作区");
  assert.equal(before("soul/80.md:3"), true, "这一段管的：看它开始时的样子，不看它现在的提案");
  assert.equal(exam.sourceExists("soul/80.md:3", { day: SD, state: "after" }), false, "整理后照旧先看提案");
});

// ---- Task 9 fix round 2：整理前的内容按这一段的范围算；考试会话只能读工作区里的，认大小写和链接 ----
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { examReadGuard } from "../src/sleep/readguard.ts";

/** 真的 nightHosts（没有事件库）：files 是相对工作区的路径 → 内容 */
function hostRig(files: Record<string, string>) {
  const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-exam-host-") });
  const all = new Map(Object.entries(files));
  const fs: MiniFs = {
    read: (p) => all.get(p) ?? null, write: (p, s) => void all.set(p, s), remove: (p) => void all.delete(p),
    list: () => [], isDir: () => false,
  };
  const b: NightBrain = {
    cfg, driver: new FakeDriver(), db: openDb(":memory:"), log: new Logger("t", () => {}), mem: null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => null, now: () => 1000, later: () => () => {},
    hhTools: () => [],
  };
  const hosts = nightHosts(b, { flow: examFlow(), prefix: "P", hash: "h" }, { budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), weights: sleepWeights(undefined), auditMs: 60_000 });
  return hosts.exam!;
}

test("host before-state: an in-scope file missing from the start snapshot was first proposed by this stage, so its before is the workspace", () => {
  const exam = hostRig({
    "memory/a.md": "一\n二\n三\n", [`sleep/${SD}/proposed/memory/a.md`]: "一\n二\n",
    "memory/new.md": "", [`sleep/${SD}/proposed/memory/brand-new.md`]: "新\n",
  });
  const mine = { files: new Map() as Snapshot, writes: ["memory/**"] };
  const theirs = { files: new Map() as Snapshot, writes: ["soul/**"] };
  assert.equal(exam.sourceExists("memory/a.md:3", { day: SD, state: "before", ...mine }), true, "这一段管的、开始时提案里没有：看工作区");
  assert.equal(exam.beforeText(SD, "memory/a.md", mine), "一\n二\n三\n");
  assert.equal(exam.sourceExists("memory/a.md:3", { day: SD, state: "before", ...theirs }), false, "不归这一段管：提案是前面几段的，就是整理前");
  assert.equal(exam.beforeText(SD, "memory/a.md", theirs), "一\n二\n");
  assert.equal(exam.beforeText(SD, "memory/brand-new.md", mine), null, "这一段新建的：整理前没有");
  assert.equal(exam.beforeText(SD, "memory/a.md", { files: snapOf({ "memory/a.md": "开始时\n" }), writes: ["memory/**"] }), "开始时\n", "快照里有的照快照");
});

test("exam config: hide patterns parse; none by default; absolute or .. or non-strings are an error", () => {
  assert.deepEqual(fmk([fagent("a")]).exam.hide, []);
  assert.deepEqual(fmk([fagent("a")], { exam: { hide: ["SOUL*.md", "**/*.bak-*"] } }).exam.hide, ["SOUL*.md", "**/*.bak-*"]);
  for (const bad of [["/etc/*"], ["../x"], ["a/../b"], "SOUL.md", [1]]) {
    const e = flowErr(() => fmk([fagent("a")], { exam: { hide: bad } }));
    assert.ok(e.problems.some((x) => x.includes("hide")), `${JSON.stringify(bad)}：${e.problems.join("|")}`);
  }
});

/** 临时工作区：基础块、改过的文件、今晚的提案；patterns 是配置的 exam.hide */
function readRig(o: { hide?: string[]; patterns?: string[] } = {}) {
  const W = tmpDir("hh-exam-read-");
  const files: Array<[string, string]> = [["soul/80-x.md", "旧"], ["soul/10.md", "十"], ["soul/20.md.bak-1", "备份"], ["memory/a.md", "a"], [`sleep/${SD}/proposed/soul/80-x.md`, "新"]];
  for (const [p, text] of files) { mkdirSync(dirname(join(W, p)), { recursive: true }); writeFileSync(join(W, p), text); }
  return { W, guard: examReadGuard({ workspace: W, hide: o.hide ?? ["soul/80-x.md"], patterns: o.patterns ?? [], platform: "darwin" }) };
}

test("exam reads: a case variant of a hidden file is refused", () => {
  const { W, guard } = readRig();
  assert.ok(guard("Read", { file_path: join(W, "Soul/80-X.MD") }));
  assert.ok(guard("Read", { file_path: join(W, `SLEEP/${SD}/proposed/soul/80-x.md`) }));
  assert.equal(guard("Read", { file_path: join(W, "soul/10.md") }), undefined);
  assert.equal(guard("Read", { file_path: "soul/10.md" }), undefined, "相对路径按工作区算");
  assert.ok(guard("Read", { file_path: "Soul/80-x.md" }));
});

test("exam reads: ~ and paths outside the workspace are refused", () => {
  const { W, guard } = readRig();
  assert.equal(guard("Read", { file_path: "~/.zshrc" }), XP.EXAM_READ_OUTSIDE);
  assert.equal(guard("Read", { file_path: "/etc/hosts" }), XP.EXAM_READ_OUTSIDE);
  assert.equal(guard("Read", { file_path: join(W, "../outside.md") }), XP.EXAM_READ_OUTSIDE);
  assert.equal(guard("Grep", { pattern: "x", path: "/etc" }), XP.EXAM_READ_OUTSIDE);
  assert.equal(guard("Glob", { pattern: "../*", path: W }), XP.EXAM_READ_OUTSIDE);
});

test("exam reads: links are followed — into a hidden file or out of the workspace is refused", () => {
  const { W, guard } = readRig();
  symlinkSync(join(W, "soul/80-x.md"), join(W, "alias.md"));
  symlinkSync(join(W, "sleep"), join(W, "night"));
  symlinkSync("/etc", join(W, "etc"));
  assert.ok(guard("Read", { file_path: join(W, "alias.md") }), "链到不让读的文件");
  assert.ok(guard("Read", { file_path: join(W, `night/${SD}/proposed/soul/80-x.md`) }), "链到 sleep/");
  assert.equal(guard("Read", { file_path: join(W, "etc/hosts") }), XP.EXAM_READ_OUTSIDE, "链到工作区外面");
  if (process.platform === "darwin") {
    const real = realpathSync(W);
    assert.ok(guard("Read", { file_path: `/System/Volumes/Data${real}/soul/80-x.md` }), "/System/Volumes/Data 的别名");
    assert.equal(guard("Read", { file_path: `/System/Volumes/Data${real}/soul/10.md` }), undefined);
  }
});

test("exam reads: config hide patterns hide matching files", () => {
  const { W, guard } = readRig({ hide: [], patterns: ["soul/*.bak-*"] });
  assert.ok(guard("Read", { file_path: join(W, "soul/20.md.bak-1") }));
  assert.ok(guard("Read", { file_path: join(W, "SOUL/20.MD.BAK-1") }), "大小写也认");
  assert.equal(guard("Read", { file_path: join(W, "soul/10.md") }), undefined);
  assert.ok(guard("Grep", { pattern: "x", path: join(W, "soul") }), "Grep 装着它的目录会读到它");
  assert.equal(guard("Grep", { pattern: "x", path: join(W, "memory") }), undefined, "不装着 bak 的目录照搜");
});

test("exam reads: Glob may list a folder holding hidden files but not target one; Grep and Read keep their rules", () => {
  const { W, guard } = readRig();
  assert.equal(guard("Glob", { pattern: "*.md", path: join(W, "soul") }), undefined, "只列名字");
  assert.equal(guard("Glob", { pattern: "**/*.md", path: W }), undefined);
  assert.ok(guard("Glob", { pattern: "80-x.md", path: join(W, "soul") }), "直接指着不让读的文件");
  assert.ok(guard("Glob", { pattern: "sleep/**/*.md", path: W }));
  assert.ok(guard("Glob", { pattern: "*", path: join(W, "sleep") }));
  assert.equal(guard("Glob", { pattern: "*.md" }), XP.EXAM_SEARCH_NEEDS_PATH);
  assert.ok(guard("Grep", { pattern: "x", path: join(W, "soul") }), "Grep 会读到内容：装着不让读的目录不行");
  assert.equal(guard("Grep", { pattern: "x", path: join(W, "memory") }), undefined);
  assert.equal(guard("Grep", { pattern: "x" }), XP.EXAM_SEARCH_NEEDS_PATH);
});

test("exam reads: Glob with an absolute pattern is checked as itself, not under the path", () => {
  const { W, guard } = readRig();
  assert.equal(guard("Glob", { pattern: "/etc/*", path: W }), XP.EXAM_READ_OUTSIDE);
  assert.ok(guard("Glob", { pattern: `${W}/sleep/**`, path: W }), "指着不让读的目录里面");
  assert.equal(guard("Glob", { pattern: `${W}/soul/10.md`, path: W }), undefined);
});

// ---- final fix wave（final-fixes.md）----
import { stageDoneTool } from "../src/sleep/tools.ts";
import { callTool } from "../src/kernel/fake.ts";

// C1：评审的复现（strip.test.ts）
test("C1: the stage_done schema keeps affects (the SDK parses tool args through it)", async () => {
  const { z } = await import("zod");
  const t = stageDoneTool(() => "");
  const input = { status: "done", report: "r", changes: [{ target: "soul/80.md", op: "fade", before: "a", after: "b", evidence: [], why: "w", affects: [{ q: "q:x/1", layer: "searchable" }] }] };
  const parsed = await z.object(t.shape).safeParseAsync(input);
  assert.equal(parsed.success, true);
  assert.deepEqual((parsed.data as { changes: Array<Record<string, unknown>> }).changes[0]!.affects, [{ q: "q:x/1", layer: "searchable" }]);
  const bad = await z.object(t.shape).safeParseAsync({ ...input, changes: [{ ...input.changes[0], affects: [{ q: "q:x/1", layer: "deep" }] }] });
  assert.equal(bad.success, false, "层只认三种");
});

test("C1: the fake kernel hands the handler the parsed args, like the SDK — unknown keys dropped, bad args never reach it", async () => {
  let got: StageDone | null = null;
  const t = stageDoneTool((d) => { got = d; return "收到"; });
  const change = { target: "soul/80.md", op: "fade", before: "a", after: "b", evidence: [], why: "w", affects: [{ q: "q:x/1", layer: "archive" }], extra: "没写进 shape 的" };
  const ok = await callTool(t, { status: "done", report: "r", changes: [change] });
  assert.deepEqual(ok, { text: "收到", isError: false });
  assert.deepEqual(got!.changes[0], { target: "soul/80.md", op: "fade", before: "a", after: "b", evidence: [], why: "w", affects: [{ q: "q:x/1", layer: "archive" }] });
  got = null;
  const bad = await callTool(t, { status: "maybe", report: "r", changes: [] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Input validation error: Invalid arguments for tool stage_done/);
  assert.equal(got, null, "没调 handler");
});

/** 判分人照叫醒的话里的标准答案判：answer 跟标准答案里的说法一样就对 */
function goldHost(answer: (id: string, phase: string) => string) {
  const graderWakes: string[] = [];
  const opened: string[] = [];
  const host: ExamHost = {
    open(op) {
      opened.push(op.id);
      let onA: (a: ExamAnswers) => string = () => "";
      let onG: (g: ExamGrades) => string = () => "";
      let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<any>((r) => { settle = r; });
      return {
        id: op.id, settled,
        wake(t: string) {
          queueMicrotask(() => {
            if (op.allowed.includes("exam_grades")) {
              graderWakes.push(t);
              const items = [...t.matchAll(/^(\S+)（\w+）\n问题：.*\n标准答案：(.*)\n也算对的说法：.*\n她的回答：(.*)$/gm)];
              onG({ grades: items.map((m) => ({ id: m[1]!, verdict: m[3]!.includes(m[2]!) ? "right" as const : "wrong" as const, reason: "照标准答案" })), layers: [] });
            } else {
              const ids = [...t.matchAll(/^(q:\S+)　/gm)].map((m) => m[1]!);
              const phase = /-(after|retake|before)-/.exec(op.id)?.[1] ?? "after";
              onA({ answers: ids.map((id) => ({ id, answer: answer(id, phase) })) });
            }
            onEnd(true);
          });
        },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onAnswers(fn: (a: ExamAnswers) => string) { onA = fn; },
        onGrades(fn: (g: ExamGrades) => string) { onG = fn; },
        onQuestions() {},
        async close() { settle({ how: "ok", turns: 1, usage: ZERO }); },
      } as any;
    },
    opening: () => "OPEN", preview: async () => "INJ", sourceExists: () => true, beforeText: (_d, p, v) => v.files.get(p)?.text ?? null, spent() {}, timeoutMs: 1000,
  };
  return { host, graderWakes, opened };
}

// C2：评审的复现（revise.test.ts）：旧的标准答案 X，这一段申请改成 Y；整理后答 Y、整理前答 X → 过
test("C2: a pending revise from this stage is tonight's gold — after answers Y, before answers X → pass", async () => {
  const { db, bank } = mkBank();
  const flow = examFlow({ sample: 0 });
  const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
  bank.addOp(SD, "soul", { kind: "revise", q: old!, gold: "新地址Y", why: "搬家了" });
  SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
  const g = goldHost((_id, phase) => (phase === "before" ? "旧地址X" : "新地址Y"));
  const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING });
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "update", before: "X", after: "Y", affects: [{ q: old!, layer: "searchable" }] }]);
  const r = await v.validate(flow.stages[0]!, SD, rec, { before: snapOf({ "soul/80.md": "住X" }), after: snapOf({ "soul/80.md": "住Y" }), material: "m", storeBefore: "live" });
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.ok(g.graderWakes.length > 0);
  for (const w of g.graderWakes) { assert.match(w, /标准答案：新地址Y/); assert.doesNotMatch(w, /旧地址X/); }
  assert.equal(bank.get(old!)!.gold, "旧地址X", "落地前题库里不改");
});

test("C2: a pending revise from a stage that passed earlier tonight counts too; another day's or an unpassed stage's does not", async () => {
  const run = async (op: { day: string; stage: string }, passed: string[]) => {
    const { db, bank } = mkBank();
    const flow = examFlow({ sample: 0 });
    const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
    bank.addOp(op.day, op.stage, { kind: "revise", q: old!, gold: "新地址Y", why: "搬家了" });
    SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
    const g = goldHost(() => "新地址Y");
    const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => passed });
    await v.validate(flow.stages[0]!, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    return g.graderWakes[0] ?? "";
  };
  assert.match(await run({ day: SD, stage: "people" }, ["people"]), /标准答案：新地址Y/);
  assert.match(await run({ day: SD, stage: "people" }, []), /标准答案：旧地址X/, "没过的段");
  assert.match(await run({ day: "2026-11-04", stage: "soul" }, ["soul"]), /标准答案：旧地址X/, "别的日子");
});

test("C2: a question with a pending retire is left out of every gate, with a note", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { verdict: (_p, q) => (q === "记错了的" ? "wrong" : "right") } });
  const [bad, ok] = oldQs(x.bank, [on80("记错了的"), on80("还对的")]);
  x.bank.addOp(SD, "soul", { kind: "retire", q: bad!, why: "记错了" });
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: ["已申请退休：记错了的"] });
  assert.deepEqual([...new Set(x.results().map((r) => r.q))], [ok], "退休的不考");
});

test("C2: the whole-day exam uses tonight's pending revise golds and leaves out pending retires", async () => {
  const x = finalRig({ passed: [prec("events", [OL]), prec("people", [OL])] });
  const [revised, retired, plain] = oldQs(x.bank, [onFile(OL, "改了答案的", { gold: "旧答案" }), onFile(OL, "退休的"), onFile(OL, "照旧的")]);
  x.bank.addOp(SD, "people", { kind: "revise", q: revised!, gold: "新答案", why: "变了" });
  x.bank.addOp(SD, "events", { kind: "retire", q: retired!, why: "记错了" });
  const r = await x.check(SD);
  assert.deepEqual(r, { redo: [], notes: ["已申请退休：退休的"] });
  const grader = x.opened.find((s) => s.id === fid("grade-after"))!;
  assert.match(grader.wake, /标准答案：新答案/);
  assert.doesNotMatch(grader.wake, /旧答案/);
  assert.deepEqual(x.finals().map((f) => f.q).sort(), [revised, plain].sort());
});

test("C1: the grader says a lower layer than the one examined → a wrong answer there is retaken at the grader's layer, and that counts", async () => {
  const x = sitting({ exam: { sample: 0 }, host: {
    verdict: (p, q) => (q === "挂着的" && p === "after" ? "wrong" : "right"), layers: (q) => (q === "挂着的" ? "searchable" : undefined),
  } });
  const [q] = oldQs(x.bank, [on80("挂着的", { layer: "resident" })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [] });
  assert.deepEqual(x.opened.map((s) => s.id), [sid("after-resident"), sid("grade-after"), sid("retake-searchable"), sid("grade-retake")]);
  assert.deepEqual(x.results().map((r) => [r.phase, r.layer, r.verdict]), [["after", "resident", "wrong"], ["retake", "searchable", "right"]]);
  assert.ok(!x.opened.some((s) => s.id.includes("-before-")), "不算倒退，不补考整理前");
  assert.equal(x.bank.get(q!)!.layer, "resident", "今晚不改层");
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(q!)!.layer, "searchable");

  // 判到只在仓库：重考查出处
  const y = sitting({ exam: { sample: 0 }, host: { verdict: (p) => (p === "after" ? "wrong" : "right"), layers: () => "archive" } });
  oldQs(y.bank, [on80("挂着的", { layer: "searchable", sources: ["e0001", "soul/80.md:1"] })]); // plan 3 A7：挪进只在仓库的题要有 路径:行 出处
  assert.deepEqual(await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"])), { pass: true, problems: [] });
  assert.deepEqual(y.results().map((r) => [r.phase, r.layer, r.verdict]), [["after", "searchable", "wrong"], ["retake", "archive", "right"]]);
});

test("C1: the grader's layer op is still written only when the attempt passes", async () => {
  const x = sitting({ exam: { sample: 0 }, host: {
    verdict: (p, q) => (q === "挂着的" && p === "after" ? "wrong" : q === "新要点" ? "wrong" : "right"), layers: (q) => (q === "挂着的" ? "searchable" : undefined),
  } });
  oldQs(x.bank, [on80("挂着的", { layer: "resident" })]);
  x.bank.addPending(SD, "soul", [qin("新要点", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  assert.equal(all(x.db, "SELECT * FROM exam_op").length, 0);
});

// ---- I1、I2、I7：考生看到什么、能读什么 ----
import { setQuestions, type ExamOpen } from "../src/sleep/exam.ts";

test("I2: exam config — nothing injected by default, appendix capped at 40000 chars; bad values are errors", () => {
  const d = fmk([fagent("a")]).exam;
  assert.deepEqual(d.inject, []);
  assert.equal(d.appendixChars, 40000);
  const set = fmk([fagent("a")], { exam: { inject: ["memory/open-loops.md", "notes/**"], appendixChars: 500 } }).exam;
  assert.deepEqual(set.inject, ["memory/open-loops.md", "notes/**"]);
  assert.equal(set.appendixChars, 500);
  for (const bad of [{ inject: ["/abs/*"] }, { inject: ["../x"] }, { inject: ["!x"] }, { inject: "x" }, { appendixChars: -1 }, { appendixChars: "9" }]) {
    const e = flowErr(() => fmk([fagent("a")], { exam: bad }));
    assert.ok(e.problems.some((p) => /inject|appendixChars/.test(p)), `${JSON.stringify(bad)}：${e.problems.join("|")}`);
  }
});

const twoState = (m: Record<string, [string, string]>): ValidateCtx => ({
  before: snapOf(Object.fromEntries(Object.entries(m).map(([p, [b]]) => [p, b]))),
  after: snapOf(Object.fromEntries(Object.entries(m).map(([p, [, a]]) => [p, a]))),
  material: "材料", storeBefore: "live",
});

test("I2: only changed files in baseBlocks ∪ inject are injected; the rest go into an appendix that only searchable sittings see, in that state's version", async () => {
  const x = sitting({ global: { inject: ["soul/inj/**"] }, host: { verdict: (p, q) => (q === "查的旧题" && p !== "before" ? "wrong" : "right") } });
  x.bank.addPending(SD, "soul", [qin("常的", { layer: "resident" }), qin("查的")]);
  oldQs(x.bank, [on80("查的旧题")]);
  const files = ["soul/10-来历.md", "soul/inj/a.md", "soul/80.md"];
  const ctx = twoState({ "soul/10-来历.md": ["十旧", "十旧\n十新"], "soul/inj/a.md": ["注入旧", "注入旧\n注入新"], "soul/80.md": ["八十旧", "八十旧\n八十新"] });
  const r = await x.v.validate(x.stage, SD, xrec(files, files.map((f) => ({ target: f, op: "add" }))), ctx);
  assert.equal(r.pass, false, "查的旧题倒退了：有整理前那一轮");
  assert.deepEqual(x.previews.map((p) => [p.state, p.files]), [["after", ["soul/10-来历.md", "soul/inj/a.md"]], ["before", ["soul/10-来历.md", "soul/inj/a.md"]]]);
  const wake = (id: string) => x.opened.find((s) => s.id === sid(id))!.wake;
  assert.match(wake("after-resident"), /「after:soul\/10-来历\.md」/);
  assert.doesNotMatch(wake("after-resident"), /查得到）|八十/, "常驻层看不到附录");
  assert.match(wake("after-searchable"), /这几份文件现在的样子（查得到）[\s\S]*=== soul\/80\.md ===\n八十旧\n八十新/);
  assert.doesNotMatch(wake("after-searchable"), /=== soul\/inj\/a\.md ===/, "进了注入的不再进附录");
  assert.match(wake("before-searchable"), /=== soul\/80\.md ===\n八十旧(?!\n八十新)/, "整理前那一轮的附录是整理前的样子");
  for (const s of x.opened) assert.deepEqual((s as Sat & { hide?: string[] }).hide, ["sleep/", ...files], `${s.id}：改过的文件都不让读`);
});

test("I2: the appendix is capped by appendixChars and says so when cut", async () => {
  const x = sitting({ global: { inject: [], appendixChars: 30 } });
  x.bank.addPending(SD, "soul", [qin("查的")]);
  const long = `${"甲".repeat(20)}${"乙".repeat(40)}`;
  await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]), twoState({ "soul/80.md": ["", long] }));
  const w = x.opened.find((s) => s.id === sid("after-searchable"))!.wake;
  assert.match(w, /=== soul\/80\.md ===\n甲/);
  assert.doesNotMatch(w, /乙{40}/);
  assert.match(w, /只放了前 30 字/);
  assert.deepEqual(x.previews, [], "没有要注入的就不跑预览");
});

test("I2: a failing preview → resident questions are not examined, a note says so, examined 0; searchable go on with the plain files", async () => {
  const logs: LogRecord[] = [];
  const x = sitting({ logs, host: { preview: async () => { throw new Error("脚本坏了"); } } });
  const [, srch] = x.bank.addPending(SD, "soul", [qin("常的", { layer: "resident" }), qin("查的")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]), twoState({ "soul/80.md": ["旧", "旧\n新"] }));
  assert.deepEqual(r, { pass: true, problems: ["注入预览失败，常驻层没考：脚本坏了"] });
  assert.deepEqual(x.opened.map((s) => s.id), [sid("after-searchable"), sid("grade-after")]);
  assert.match(x.opened[0]!.wake, /=== soul\/80\.md ===\n旧\n新/, "查得到那层用原样的文件");
  assert.deepEqual(x.results().map((r) => r.q), [srch]);
  assert.equal(x.row().examined, 0);
  assert.ok(logs.some((l) => l.level === "warn" && JSON.stringify(l).includes("脚本坏了")), JSON.stringify(logs));
});

test("I2: the whole-day exam injects the same way, and a failing preview there leaves the resident layer out with a note", async () => {
  const run = async (preview?: ExamHost["preview"]) => {
    const seen: string[][] = [];
    const x = finalRig({
      global: { inject: ["memory/inj/**"] },
      passed: [prec("events", [OL, "memory/inj/x.md"]), prec("people", [OL, "soul/20-性格.md"])],
      proposed: { [OL]: "待办新", "memory/inj/x.md": "注入新", "soul/20-性格.md": "二十新" },
      host: { preview: preview ?? (async (p) => { seen.push([...p.files.keys()]); return "明天的样子"; }) },
    });
    const [res, srch] = oldQs(x.bank, [onFile(OL, "常的", { layer: "resident" }), onFile(OL, "查的")]);
    const r = await x.check(SD);
    return { x, r, seen, res, srch };
  };
  const ok = await run();
  assert.deepEqual(ok.r, { redo: [] });
  assert.deepEqual(ok.seen, [["memory/inj/x.md", "soul/20-性格.md"]]);
  const wake = (x: ReturnType<typeof finalRig>, id: string) => x.opened.find((s) => s.id === fid(id))!.wake;
  assert.doesNotMatch(wake(ok.x, "after-resident"), /待办新/);
  assert.match(wake(ok.x, "after-searchable"), /这几份文件现在的样子（查得到）[\s\S]*=== memory\/open-loops\.md ===\n待办新/);
  const bad = await run(async () => { throw new Error("脚本坏了"); });
  assert.deepEqual(bad.r, { redo: [], notes: ["注入预览失败，常驻层没考：脚本坏了"] });
  assert.ok(!bad.x.opened.some((s) => s.id.includes("-resident")));
  assert.deepEqual(bad.x.finals().map((f) => f.q), [bad.srch]);
});

test("I7: searchable sittings get remember and the recall_* tools but not recall (raw words are the archive layer)", async () => {
  assert.ok(!SEARCH_TOOLS.includes("recall"));
  for (const t of ["remember", "recall_event", "recall_person", "recall_period"]) assert.ok(SEARCH_TOOLS.includes(t), t);
  const h = examHost([(s) => { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); }]);
  await examineLayer(h.host, { ...EX, layer: "searchable", questions: [xq("q1")] });
  assert.ok(!h.opened[0]!.allowed.includes("recall"));
  assert.doesNotMatch(h.wakesAll[0]![0]!, /recall(?!_)/, "说明里也不提 recall");
});

test("I1: resident sittings, graders and the hidden setter open with reads off; searchable sittings keep the read guard", async () => {
  const answer: XScript = (s) => { s.answers({ answers: [{ id: "q1", answer: "甲" }] }); s.turnEnd(true); };
  const h = examHost([answer, answer, (s) => { s.grades({ grades: [{ id: "q1", verdict: "right", reason: "对" }], layers: [] }); s.turnEnd(true); }]);
  await examineLayer(h.host, { ...EX, layer: "resident", questions: [xq("q1")] });
  await examineLayer(h.host, { ...EX, id: "exam-d-2", layer: "searchable", questions: [xq("q1")] });
  await grade(h.host, { id: "g", model: "m", opening: "O", items: [{ q: xq("q1"), answer: "甲" }], askLayers: [] });
  const opened = h.opened as Array<{ id: string; reads?: boolean }>;
  assert.deepEqual(opened.map((o) => [o.id, o.reads]), [["exam-d-1", false], ["exam-d-2", undefined], ["g", false]]);
  let setterOpen: { reads?: boolean } | null = null;
  const setterHost = { ...h.host, open: (op: ExamOpen) => { setterOpen = op; throw new Error("不用真开"); } } as ExamHost;
  assert.equal(await setQuestions(setterHost, { id: "s", model: "m", opening: "O", wake: "出题" }), null);
  assert.equal(setterOpen!.reads, false);
});

// ---- I3：只在仓库那层不再白送；I4：要压缩的从实际的 diff 看 ----
test("I3: an archive question with no sources is wrong", () => {
  const h = examHost([]);
  assert.equal(checkArchive(h.host, xq("q1", { layer: "archive", sources: [] }), { day: "d", state: "after" }), "wrong");
  assert.equal(checkArchive(h.host, xq("q1", { layer: "archive", sources: [] }), { day: "d", state: "before" }), "wrong");
});

test("I3: after the stage, a 路径:行 source counts only if that line's text is still in that file or another file changed tonight", async () => {
  const run = async (after: Record<string, string>, tonight?: Record<string, string>) => {
    const x = sitting({ exam: { sample: 0 }, ...(tonight ? { opts: { tonight: () => ({ before: new Map(), after: new Map(Object.entries(tonight)) }) } } : {}) });
    const [arch] = oldQs(x.bank, [on80("仓库里的", { layer: "archive", sources: ["soul/80.md:2"] })]);
    x.bank.addPending(SD, "soul", [qin("八十里的", { tags: noTags({ files: ["soul/80.md"] }) })]);
    const files = Object.keys(after);
    const ctx: ValidateCtx = { before: snapOf({ "soul/80.md": "一\n  要紧的一行  \n三\n" }), after: snapOf(after), material: "m", storeBefore: "live" };
    const r = await x.v.validate(x.stage, SD, xrec(files, files.map((f) => ({ target: f }))), ctx);
    return { r, verdicts: x.results().filter((v) => v.q === arch).map((v) => `${v.phase}:${v.verdict}`) };
  };
  const gone = await run({ "soul/80.md": "一\n三\n" });
  assert.deepEqual(gone.verdicts, ["after:wrong", "before:right"]);
  assert.equal(gone.r.pass, false);
  assert.ok(gone.r.problems.some((p) => p.startsWith("倒退：仓库里的")), gone.r.problems.join("|"));
  const moved = await run({ "soul/80.md": "一\n三\n", "soul/archive.md": "旧事：要紧的一行（十月）\n" });
  assert.deepEqual(moved.verdicts, ["after:right"], "挪进这一段改的另一个文件：还在");
  assert.deepEqual(moved.r, { pass: true, problems: [] });
  const earlier = await run({ "soul/80.md": "一\n三\n" }, { "memory/archive.md": "要紧的一行\n" });
  assert.deepEqual(earlier.verdicts, ["after:right"], "今晚前面过了的段改的文件里有：还在");
});

test("I4: an op labelled change that removes lines with no question is sent back", async () => {
  const x = sitting();
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "change" }]);
  const r = await x.v.validate(x.stage, SD, rec, twoState({ "soul/80.md": ["一\n二\n", "一\n"] }));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.includes("soul/80.md")), r.problems.join("|"));
  assert.equal(x.opened.length, 0);
});

test("I4: compression is read from the diff whatever the label; extended labels also trigger", async () => {
  const x = sitting();
  const quiet = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]), twoState({ "soul/80.md": ["一\n二\n", "一\n三\n"] }));
  assert.equal(quiet.pass, false, "标的是 add，实际删了一行：照样要出题");
  assert.match(quiet.problems.join("|"), /soul\/80\.md/);
  for (const op of ["改写", "降一级", "挪进档案", "压缩", "合并", "删掉", "缩短", "淡化", "change"]) {
    const y = sitting();
    const r = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op }]), twoState({ "soul/80.md": ["一\n", "一\n二\n"] }));
    assert.equal(r.pass, false, op);
  }
  const z = sitting();
  const added = await z.v.validate(z.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]), twoState({ "soul/80.md": ["一\n", "一\n二\n"] }));
  assert.deepEqual(added, { pass: true, problems: [] }, "只加了东西、标签也不是压缩：不用出题");
});

test("I4: two compressions on one file need two questions on it", async () => {
  const run = async (n: number) => {
    const x = sitting();
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }, { target: "soul/80.md「九月」", op: "compress" }]);
    // 最终评审 C1：还原 master 的样子——十月、九月连着删掉（diff 数一处），但写了两条改动：要两道
    return x.v.validate(x.stage, SD, rec, twoState({ "soul/80.md": ["十月\n九月\n", "十九\n"] }));
  };
  const one = await run(1);
  assert.equal(one.pass, false);
  assert.match(one.problems.join("|"), /soul\/80\.md.*1 道.*2 道/);
  assert.deepEqual(await run(2), { pass: true, problems: [] });
});

test("I3: an affects entry counts only when the question hangs on that change's target", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [elsewhere] = oldQs(x.bank, [qin("九十里的", { isNew: false, sources: ["e0001"], tags: noTags({ files: ["soul/90.md"] }) })]);
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: elsewhere!, layer: "archive" }] }]);
  const r = await x.v.validate(x.stage, SD, rec, xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: false, problems: ["soul/80.md 的 affects 点名的题不挂在它上面"] });
  // 挂在 target 上的（出处说到它也算）：算数，照写的层考
  const y = sitting({ exam: { sample: 0 } });
  const [hangs] = oldQs(y.bank, [qin("出处在八十的", { isNew: false, sources: ["soul/80.md:1", "e0001"], tags: noTags({ files: ["soul/90.md"] }) })]);
  const ok = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: hangs!, layer: "archive" }] }]), xctx(["soul/80.md"]));
  assert.deepEqual(ok, { pass: true, problems: [] });
  assert.deepEqual(y.results().map((v) => [v.q, v.layer]), [[hangs, "archive"]]);
});

test("I3: a declared move of more than one level is clamped to one, with a note", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [q] = oldQs(x.bank, [on80("常驻的", { layer: "resident" })]);
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "archive" }] }]);
  const r = await x.v.validate(x.stage, SD, rec, xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [`常驻的（${q}）的 affects 一次只能挪一层：常驻 → 只在仓库，按查得到算`] });
  assert.deepEqual(x.results().map((v) => [v.phase, v.layer]), [["after", "searchable"]]);
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(q!)!.layer, "searchable");
});

test("I3: for importance ≥ 4 a declared move counts only if the grader agrees; otherwise it is examined at its old layer", async () => {
  const run = async (call: Layer, verdict: (p: Phase) => Verdict = () => "right") => {
    const x = sitting({ exam: { sample: 0 }, host: { layers: (q) => (q === "要紧的" ? call : undefined), verdict: (p, q) => (q === "要紧的" ? verdict(p) : "right") } });
    const [q] = oldQs(x.bank, [on80("要紧的", { layer: "resident", importance: 4 })]);
    const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "searchable" }] }]);
    const r = await x.v.validate(x.stage, SD, rec, xctx(["soul/80.md"]));
    const grader = x.opened.find((s) => s.id === sid("grade-after"))!;
    return { x, q: q!, r, asked: grader.wake.includes(`${q}　要紧的`) };
  };
  const agree = await run("searchable");
  assert.ok(agree.asked, "问判分该在哪层");
  assert.deepEqual(agree.r, { pass: true, problems: [] });
  assert.deepEqual(agree.x.results().map((v) => [v.phase, v.layer]), [["after", "resident"]], "整理后照原来的层考");
  agree.x.bank.activate(SD, ["soul"]);
  assert.equal(agree.x.bank.get(agree.q)!.layer, "searchable", "判分同意：挪");
  const disagree = await run("resident");
  disagree.x.bank.activate(SD, ["soul"]);
  assert.equal(disagree.x.bank.get(disagree.q)!.layer, "resident", "判分不同意：不挪");
  // 判分同意、在原来那层答错：重考在挪到的那层
  const retaken = await run("searchable", (p) => (p === "after" ? "wrong" : "right"));
  assert.deepEqual(retaken.r, { pass: true, problems: [] });
  assert.deepEqual(retaken.x.results().map((v) => [v.phase, v.layer, v.verdict]), [["after", "resident", "wrong"], ["retake", "searchable", "right"]]);
});

// ---- I5、I6 ----
test("I5: migration 15 gives exam_op an attempt column; addOp records it; a failed attempt's revise/retire can be dropped by attempt", () => {
  const { db, bank } = mkBank();
  assert.ok((db.prepare("PRAGMA table_info(exam_op)").all() as Array<{ name: string }>).some((c) => c.name === "attempt"));
  const [a, b, c] = oldQs(bank, [qin("a"), qin("b"), qin("c")]);
  bank.addOp(SD, "soul", { kind: "revise", q: a!, gold: "新", why: "w" }, 1);
  bank.addOp(SD, "soul", { kind: "retire", q: b!, why: "w" }, 1);
  bank.addOp(SD, "soul", { kind: "layer", q: c!, layer: "archive", why: "w" }, 1);
  bank.addOp(SD, "soul", { kind: "revise", q: c!, gold: "新", why: "w" }, 2);
  assert.equal(bank.dropAttemptOps(SD, "soul", 1, ["revise", "retire"]), 2);
  assert.deepEqual(all<{ kind: string; attempt: number; status: string }>(db, "SELECT kind, attempt, status FROM exam_op ORDER BY id").map((r) => [r.kind, r.attempt, r.status]),
    [["revise", 1, "dropped"], ["retire", 1, "dropped"], ["layer", 1, "pending"], ["revise", 2, "pending"]]);
});

test("I5: the runner tells the host whether the attempt passed, and which attempt it was", async () => {
  let k = 0;
  // 切换前 P2：第 1 次没说到改的文件，当场退回两次，第 3 次照交的收下（照旧没过）
  const n = tinyNight({ act: (c) => { k += 1; c.write("memory/people/a.md", `P${k}`); for (let i = 0; i < (k === 1 ? 3 : 1); i++) c.done({ changes: k === 1 ? [] : [chg5("memory/people/a.md")] }); } });
  const calls: string[] = [];
  n.host.attemptEnded = (day, stage, passed, attempt) => { calls.push(`${day} ${stage} ${passed} ${attempt}`); };
  const r = await runNightWith(n, nightFlow(), []);
  assert.deepEqual(r.landed, [DN]);
  assert.deepEqual(calls, [`${DN} people false 1`, `${DN} people true 2`]);
});

test("I6: every gate problem line carries the question's id", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { verdict: (p, q) => (q === "旧1" && p !== "before" ? "wrong" : q === "新要紧" || q.startsWith("常") ? "wrong" : "right") } });
  const [old] = oldQs(x.bank, [on80("旧1")]);
  const own = x.bank.addPending(SD, "soul", [qin("新要紧", { importance: 4 }), qin("常1", { layer: "resident" })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  const line = (re: RegExp) => r.problems.find((p) => re.test(p)) ?? "";
  assert.ok(line(/^倒退：旧1/).includes(old!), r.problems.join("|"));
  assert.ok(line(/重要度 4/).includes(own[0]!), r.problems.join("|"));
  assert.ok(line(/常驻层得分/).includes(own[1]!), r.problems.join("|"));
  for (const p of r.problems) assert.match(p, /q:/, p);
});

// ---- 小的（M1–M11、T9）----
import type { FlowConfig } from "../src/sleep/flow.ts";
import type { EventMemory } from "../src/memory/events/memory.ts";

/** 真的 nightHosts（没有事件库、工作区里什么都没有）：给什么流程就是什么流程 */
function hostsFor(flow: FlowConfig, extra: Partial<NightBrain> = {}) {
  const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-exam-hosts-") });
  const fs: MiniFs = { read: () => null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const b: NightBrain = {
    cfg, driver: new FakeDriver(), db: openDb(":memory:"), log: new Logger("t", () => {}), mem: null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => null, now: () => 1000, later: () => () => {},
    hhTools: () => [], ...extra,
  };
  return nightHosts(b, { flow, prefix: "P", hash: "h" }, { budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), weights: sleepWeights(undefined), auditMs: 60_000 });
}

test("M1: the stage exam's opening shows base blocks an earlier stage changed tonight in tomorrow's version", async () => {
  const tonight = { before: new Map([["soul/10-来历.md", "十旧"], ["memory/x.md", "x旧"]]), after: new Map([["soul/10-来历.md", "十新"], ["memory/x.md", "x新"]]) };
  const x = sitting({ opts: { tonight: () => tonight } });
  const seen: Array<[string[], Array<[string, string | null]>]> = [];
  x.host.opening = (exclude, over) => { seen.push([[...exclude], [...(over ?? [])]]); return "OPEN"; };
  x.bank.addPending(SD, "soul", [qin("一")]);
  await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(seen, [[[], [["soul/10-来历.md", "十新"]]]]);
});

test("M1: the host's opening takes tomorrow's version of a base block over the workspace's", () => {
  const exam = hostRig({});
  const over = new Map([["soul/10-来历.md", "前面那段改的十"]]);
  assert.doesNotMatch(exam.opening([]), /前面那段改的十/);
  const mine = exam.opening([], over);
  assert.match(mine, /## soul\/10-来历\.md\n前面那段改的十/);
  assert.equal(exam.opening([], new Map(over)), mine, "同样的输入一字不差");
  assert.doesNotMatch(exam.opening(["soul/10-来历.md"], over), /前面那段/);
});

test("M2: a question in the paper only because it was sampled gives notes, never failures, and sits no before round", async () => {
  const x = sitting({ exam: { sample: 1 }, host: { verdict: (_p, q) => (q === "抽到的" ? "wrong" : "right") } });
  const [drawn] = oldQs(x.bank, [qin("抽到的", { isNew: false, importance: 5, tags: noTags({ files: ["soul/70.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, true, r.problems.join("|"));
  assert.equal(r.problems.length, 1, r.problems.join("|"));
  assert.ok(r.problems[0]!.includes("抽到的") && r.problems[0]!.includes(drawn!), r.problems[0]);
  assert.ok(!x.opened.some((s) => s.id.includes("-before-")));
});

test("M3: the retake and before rounds are graded in one grader session (two turns)", async () => {
  const x = sitting({ host: { verdict: (p, q) => (q === "旧1" && p !== "before" ? "wrong" : "right") } });
  oldQs(x.bank, [on80("旧1")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  const later = x.opened.find((s) => s.id === sid("grade-retake"))!;
  assert.equal(later.wakes.filter((w) => w.startsWith("【判分】")).length, 2);
  assert.ok(!x.opened.some((s) => s.id === sid("grade-before")));
  assert.deepEqual(x.results().map((v) => `${v.phase}:${v.verdict}`), ["after:wrong", "retake:wrong", "before:right"]);
  // 只有整理前那轮要判：自己开 grade-before
  const y = sitting({ host: { verdict: (p, q) => (q === "要紧的" && p !== "before" ? "partial" : "right") } });
  oldQs(y.bank, [on80("要紧的", { importance: 4 })]);
  await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(y.opened.filter((s) => s.id.includes("-grade-")).map((s) => s.id), [sid("grade-after"), sid("grade-before")]);
});

test("M3: the injection comes before the layer text, so resident and searchable sittings share that prefix", () => {
  const qs = [xq("q1")];
  const a = XP.EXAM_SITTER("resident", "【注入】", qs);
  const b = XP.EXAM_SITTER("searchable", "【注入】", qs, "【附录】");
  const end = a.indexOf("【注入】") + "【注入】".length;
  assert.ok(a.indexOf("【注入】") < a.indexOf("这一次不能查"));
  assert.equal(a.slice(0, end), b.slice(0, end));
  assert.match(a, /^【这是一次记忆体检】/);
  assert.ok(b.indexOf("【附录】") > b.indexOf("可以用 remember"), "附录在说明后面、题目前面");
  assert.ok(b.indexOf("【附录】") < b.indexOf("题目："));
});

test("M4: after the first exam session, one that wrote more cache than it read is flagged", () => {
  const c = examCacheCheck();
  const u = (cacheRead: number, cacheWrite: number, calls = 3) => ({ calls, input: 1, cacheRead, cacheWrite, output: 1, maxCtx: 1 });
  assert.equal(c.seen("a", u(0, 9000)), null, "第一个不管");
  assert.equal(c.seen("b", u(500, 9000)), "考试会话 b 没吃到缓存");
  assert.equal(c.seen("c", u(9000, 500)), null);
  assert.equal(c.seen("d", u(100, 900, 0)), null, "没调用过的不算");
});

test("M6: the second whole-day exam re-examines the first one's still-wrong questions even when the redo examined them; a loss that stays lands in 拿不准", async () => {
  let n = 0;
  const night = tinyNight({ act: (c) => { n += 1; c.write("memory/people/a.md", `P${n}`); c.done({ changes: [chg5("memory/people/a.md")] }); } });
  const bank = new Bank(night.db, () => 1000);
  const [q] = oldQs(bank, [onFile("memory/people/a.md", "阿甲是谁")]);
  const flow = nightFlow();
  const h = sitHost({ verdict: () => "wrong" });
  // 重做那一次的段考试考过这道（用一个记结果的验证器代替）
  const redoExam: StageValidator = { name: "redo-exam", async validate(_s, d, r) {
    if (r.attempt === 2) bank.record({ q: q!, day: d, stage: "people", phase: "after", layer: "searchable", verdict: "right", reason: "", answer: "" });
    return { pass: true, problems: [] };
  } };
  let runner!: SleepRunner;
  const check = finalExam({ host: h.host, bank, flow, fs: night.fs, rnd: () => 0, ladder: () => NO_SAVING, passed: (d) => runner.passed(d), nightStart: () => runner.startedAt() });
  runner = new SleepRunner(night.host, flow, { validators: [redoExam], finalCheck: check, budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), watchdogMs: 1e9, maxDays: Infinity });
  let given = false;
  const res = await runner.runNight({ night: "n", pending: async () => { if (given) return null; given = true; return DN; } });
  assert.deepEqual(res.landed, [DN]);
  assert.equal(runner.startedAt(), 1000);
  assert.equal(n, 2, "重做了一次");
  assert.ok(h.opened.some((s) => s.id === `exam-${DN}-final2-after-searchable`), "第二次照样考它");
  assert.match(night.fs.read(`sleep/${DN}/report.md`)!, /- 人物：全天考试还没过：全天考试答错：阿甲是谁/);
});

test("M7: landing drops the pending questions and ops of carry: drop stages that did not pass; carry: redo ones stay", () => {
  const flow = fmk([
    fagent("kept", { writes: ["a/**"], exam: {} }), fagent("dropme", { writes: ["b/**"], carry: "drop", exam: {} }), fagent("owed", { writes: ["c/**"], exam: {} }),
  ], { exam: { baseBlocks: BASE } });
  const db = openDb(":memory:");
  const hosts = hostsFor(flow, { db });
  const [k] = hosts.bank.addPending(SD, "kept", [qin("k")]);
  const [d] = hosts.bank.addPending(SD, "dropme", [qin("d")]);
  const [o] = hosts.bank.addPending(SD, "owed", [qin("o")]);
  hosts.bank.addOp(SD, "dropme", { kind: "revise", q: d!, gold: "g", why: "w" }, 1);
  hosts.stage.landed!(SD, ["kept"]);
  assert.deepEqual([k, d, o].map((id) => hosts.bank.get(id!)!.status), ["active", "dropped", "pending"]);
  assert.deepEqual(all<{ status: string }>(db, "SELECT status FROM exam_op").map((r) => r.status), ["dropped"]);
});

test("M7: affects naming another day's pending question don't count", async () => {
  const x = sitting();
  const [other] = x.bank.addPending("2026-11-04", "soul", [qin("前一天待定的", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: other!, layer: "archive" }] }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: false, problems: ["soul/80.md 的 affects 点名的题不存在"] });
});

test("M8: a result recorded before the night started counts as before tonight even on the same material day", async () => {
  const x = finalRig({ host: { verdict: () => "wrong" }, passed: [prec("events", [OL]), prec("people", [OL])] });
  const [q] = oldQs(x.bank, [onFile(OL, "重访那天考过的")]);
  x.t.v = 500;
  pastResult(x.bank, q!, SD, "wrong");
  x.t.v = 1000;
  assert.deepEqual(await x.check(SD), { redo: [], notes: ["整理前就答不好：重访那天考过的"] });
});

test("M10: the hidden setter's questions are checked like a stage's — sources resolve before, tags, importance, no new point into archive", async () => {
  const bad = (o: Partial<QuestionIn>) => hq("坏", o);
  const x = sitting({ exam: { hidden: 5 }, host: {
    exists: (ref) => ref !== "e9999",
    setter: () => [hq("好"), bad({ sources: ["e9999"] }), bad({ sources: [] }), bad({ tags: noTags() }), bad({ importance: 9 }), bad({ layer: "archive", isNew: true })],
  } });
  ownQ(x);
  await runHid(x);
  assert.deepEqual(hidRows(x).map((q) => q.q), ["好"]);
  // 一道合格的都没有：不收，催一次再换个会话，还不行就是暗题没出成
  const y = sitting({ exam: { hidden: 2 }, host: { setter: () => [bad({ tags: noTags() })] } });
  ownQ(y);
  assert.deepEqual(await runHid(y), { pass: true, problems: ["暗题没出成"] });
  assert.equal(hidRows(y).length, 0);
});

test("M11: resident (no-tool) exam sessions don't open the before copy of the event store", () => {
  let opened = 0;
  const hosts = hostsFor(examFlow(), { memAt: () => { opened += 1; return { mem: {} as EventMemory, close() {} }; } });
  hosts.exam!.open({ id: `exam-${SD}-soul-1-before-resident`, model: "opus", opening: "O", allowed: ["exam_answers"], store: "/copy.db", reads: false });
  assert.equal(opened, 0);
  hosts.exam!.open({ id: `exam-${SD}-soul-1-before-searchable`, model: "opus", opening: "O", allowed: [...SEARCH_TOOLS, "exam_answers"], store: "/copy.db" });
  assert.equal(opened, 1);
});

test("T9: exam.hide and exam.inject patterns starting with ./ or ending with / are errors that say to write a glob like dir/**", () => {
  for (const k of ["hide", "inject"]) {
    for (const bad of ["./soul/*.md", "soul/"]) {
      const e = flowErr(() => fmk([fagent("a")], { exam: { [k]: [bad] } }));
      assert.ok(e.problems.some((p) => p.includes(k) && p.includes("dir/**")), `${k} ${bad}：${e.problems.join("|")}`);
    }
  }
  assert.deepEqual(fmk([fagent("a")], { exam: { hide: ["soul/**"], inject: ["notes/*.md"] } }).exam.inject, ["notes/*.md"]);
});

test("C1: stage_done carries affects only on exam nights; a no-exam night's tool definitions stay as they were", async () => {
  const { z } = await import("zod");
  const change = (t: ReturnType<typeof stageDoneTool>) => (t.shape.changes as unknown as { element: { shape: Record<string, unknown> } }).element.shape;
  assert.ok("affects" in change(stageDoneTool(() => "")));
  assert.ok("affects" in change(stageDoneTool(() => "", { affects: true })));
  const plain = stageDoneTool(() => "", { affects: false });
  assert.ok(!("affects" in change(plain)));
  assert.deepEqual(Object.keys(change(plain)), ["target", "op", "before", "after", "evidence", "why"]);
  const input = { status: "done", report: "r", changes: [{ target: "a.md", op: "add", before: "", after: "x", evidence: [], why: "w", affects: [{ q: "q:x/1", layer: "archive" }] }] };
  assert.equal((z.object(plain.shape).parse(input) as { changes: Array<Record<string, unknown>> }).changes[0]!.affects, undefined);
  // 真的 host：不考试的夜 stage_done 的定义跟以前一样，考试夜带 affects
  const doneDef = (flow: FlowConfig) => {
    const driver = new FakeDriver();
    const hosts = hostsFor(flow, { driver });
    hosts.stage.open({ id: `sleep-${SD}-a-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done"]) }).wake("开始");
    return driver.sessions[0]!.spec.tools.find((t) => t.name === "stage_done")!;
  };
  assert.ok(!("affects" in change(doneDef(fmk([fagent("a", { writes: ["a/**"] })])))), "不考试的夜");
  assert.ok("affects" in change(doneDef(fmk([fagent("a", { writes: ["a/**"], exam: {} })], { exam: { baseBlocks: BASE } }))), "考试夜");
});

// ==================== plan 3 A：考试的漏洞（评审的攻击复现，改成测试）====================
import { questionProblem } from "../src/sleep/exam.ts";

// 攻击 A2/A3：只在仓库那层的题只写路径、只写编号——出处一直「查得到」，删掉的那一行照样判对
test("A1 archive sources: an archive question with no 路径:行 source is refused at intake — the stage's exam_questions and the hidden setter", async () => {
  const any = () => true;
  const arch = (sources: string[]) => qin("仓库里的那行", { layer: "archive", isNew: false, sources, tags: noTags({ files: ["soul/80.md"] }) });
  for (const s of [["soul/80.md"], ["e0001"], ["#12"], ["e0001", "soul/80.md"]]) {
    assert.equal(questionProblem(arch(s), any), XP.QUESTION_REFUSED.archiveLine, s.join(","));
  }
  assert.equal(questionProblem(arch(["e0001", "soul/80.md:2"]), any), null, "有一条 路径:行 就收");
  assert.equal(questionProblem(arch(["soul/80.md:9", "e0001"]), (r) => r !== "soul/80.md:9"), XP.QUESTION_REFUSED.archiveLine, "路径:行 查不到不算");
  assert.equal(questionProblem(qin("查得到层的", { sources: ["e0001"], tags: noTags({ files: ["soul/80.md"] }) }), any), null, "别的层照旧");

  // 出暗题的交的
  const x = sitting({ exam: { hidden: 5 }, host: {
    setter: () => [hq("好"), hq("编号", { layer: "archive", isNew: false, sources: ["e0001"] }), hq("路径", { layer: "archive", isNew: false, sources: ["soul/80.md"] }),
      hq("行", { layer: "archive", isNew: false, sources: ["soul/80.md:1"] })],
  } });
  ownQ(x);
  await runHid(x);
  assert.deepEqual(hidRows(x).map((q) => q.q), ["好", "行"]);

  // 段交的（真的 host：e0001 在事件库里查得到、soul/80.md 有两行）
  const driver = new FakeDriver();
  const flow = examFlow();
  const ws: Record<string, string> = { "soul/80.md": "第一行\n要紧的一行\n" };
  const fs: MiniFs = { read: (p) => ws[p] ?? null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const mem = { store: { event: (id: string) => (id === "e0001" ? {} : null), entry: () => null }, index: { quote: () => null } } as unknown as EventMemory;
  const db = openDb(":memory:");
  const hosts = hostsFor(flow, { driver, fs, mem, db });
  hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) }).wake("开始");
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const sub = (q: string, layer: string, sources: string[]) =>
    ({ q, gold: `${q}的答案`, accept: "", sources, tags: noTags({ files: ["soul/80.md"] }), importance: 3, kind: "fact", layer, isNew: false });
  const reply = String(await tool.handler({
    questions: [sub("编号", "archive", ["e0001"]), sub("路径", "archive", ["soul/80.md", "e0001"]), sub("行", "archive", ["soul/80.md:2"]), sub("查得到", "searchable", ["e0001"])],
    revise: [], retire: [],
  } as never));
  assert.match(reply, /收下 2 道/, reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.archiveLine), reply);
  assert.deepEqual(all<{ q: string }>(db, "SELECT q FROM exam_q ORDER BY rowid").map((r) => r.q), ["行", "查得到"]);
});

// 攻击 E：一个文件删了两处、只出一道题——写成一条 change、或者 target 用空格带小节，都蒙混过去
test("A2 compression counting: questions needed per file = runs of removed lines in the diff, whatever changes says; targets split on whitespace", async () => {
  // 甲、丙删掉，中间的乙还在：两处
  const ctx = twoState({ "soul/80.md": ["甲\n乙\n丙\n", "乙\n"] });
  const run = async (changes: Array<{ target: string; op: string; affects?: Array<{ q: string; layer: Layer }> }>, n = 1, old = false) => {
    const x = sitting({ exam: { sample: 0 } });
    const [guard] = old ? oldQs(x.bank, [on80("旧的", { sources: ["e0001"] })]) : [];
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`一道 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], changes.map((c) => ({ ...c, affects: c.affects?.map((a) => ({ ...a, q: a.q === "旧" ? guard! : a.q })) }))), ctx);
    return r;
  };
  const short = /soul\/80\.md 删掉或改写了 2 处内容，挂在它上面的题只有 1 道，要 2 道/;
  for (const changes of [[{ target: "soul/80.md", op: "compress" }], [{ target: "soul/80.md", op: "tidy" }], [{ target: "soul/80.md 甲段", op: "tidy" }]]) {
    const r = await run(changes);
    assert.equal(r.pass, false, JSON.stringify(changes));
    assert.match(r.problems.join("|"), short, JSON.stringify(changes));
  }
  assert.deepEqual(await run([{ target: "soul/80.md", op: "compress" }], 2), { pass: true, problems: [] }, "两处两道");
  // target 带空格小节：affects 也挂得上（跟机械检查一样按空格、「、# 切出文件）
  assert.deepEqual(await run([{ target: "soul/80.md 甲段", op: "tidy", affects: [{ q: "旧", layer: "searchable" }] }], 1, true), { pass: true, problems: [] });
  // 连着删掉的几行（中间的空行不隔开）照 diff 算一处，但写了两条 change：要两道（最终评审 C1，跟 master 一样）
  const joinedWith = async (n: number) => {
    const y = sitting({ exam: { sample: 0 } });
    y.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`一道 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    return y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md「甲」", op: "compress" }, { target: "soul/80.md「乙」", op: "compress" }]),
      twoState({ "soul/80.md": ["甲\n\n乙\n丙\n", "丙\n"] }));
  };
  const joined = await joinedWith(1);
  assert.equal(joined.pass, false);
  assert.match(joined.problems.join("|"), /soul\/80\.md 删掉或改写了 2 处内容，挂在它上面的题只有 1 道，要 2 道/);
  assert.deepEqual(await joinedWith(2), { pass: true, problems: [] });
});

// 攻击 F：把挂着的旧题申请退休、再在 affects 里点名它，当成出了题
test("A3 pending retire: a question with a pending retire covers nothing and is dropped from declared", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { verdict: (p, q) => (q === "要紧" ? (p === "before" ? "right" : "wrong") : "right") } });
  const [q] = oldQs(x.bank, [on80("要紧", { sources: ["e0001"] })]);
  x.bank.addOp(SD, "soul", { kind: "retire", q: q!, why: "记错了" }, 1);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "archive" }] }]),
    twoState({ "soul/80.md": ["第一行\n要紧的一行\n", "第一行\n"] }));
  assert.equal(r.pass, false);
  assert.deepEqual(r.problems, ["soul/80.md 的 affects 点名的题已申请退休，不算出了题"]);
  assert.deepEqual(all<{ kind: string }>(x.db, "SELECT kind FROM exam_op ORDER BY id").map((o) => o.kind), ["retire"], "退休的题不写改层的 op");
  const d = (await import("../src/sleep/examiner.ts")).declaredOf(x.bank, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "searchable" }] }]), SD, new Set([q!]));
  assert.deepEqual([d.layers.size, d.important.size, d.valid.size], [0, 0, 0]);
  // 全天考试：退休的题不按 affects 定层
  assert.equal((await import("../src/sleep/examiner.ts")).declaredLayers(xrec(["soul/80.md"], [{ target: "soul/80.md", affects: [{ q: q!, layer: "searchable" }] }]), x.bank, SD, new Set([q!])).size, 0);
});

// 攻击 C2-gap：申请改题（X → Y）却没把 Y 写进记忆：整理后答 X（照 Y 判错），整理前也照 Y 判错——「整理前也答不出」，过了
test("A4 revised questions: the after rounds grade on the new gold, the before round on the old gold — a revise never written into memory is a regression", async () => {
  const run = async (o: { ops: Array<{ stage: string; gold: string }>; passed: string[]; answer: string }) => {
    const { db, bank } = mkBank();
    const flow = examFlow({ sample: 0 });
    const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
    for (const op of o.ops) bank.addOp(SD, op.stage, { kind: "revise", q: old!, gold: op.gold, why: "搬家了" });
    SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
    const g = goldHost(() => o.answer);
    const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => o.passed });
    const r = await v.validate(flow.stages[0]!, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "update", affects: [{ q: old!, layer: "searchable" }] }]), xctx(["soul/80.md"]));
    return { r, wakes: g.graderWakes };
  };
  const lazy = await run({ ops: [{ stage: "soul", gold: "新地址Y" }], passed: [], answer: "旧地址X" });
  assert.equal(lazy.r.pass, false);
  assert.match(lazy.r.problems.join("|"), /^倒退：他住哪/);
  assert.equal(lazy.wakes.length, 3, "整理后、重考、整理前");
  assert.match(lazy.wakes[0]!, /标准答案：新地址Y/);
  assert.match(lazy.wakes[1]!, /标准答案：新地址Y/);
  assert.match(lazy.wakes[2]!, /标准答案：旧地址X/);
  assert.doesNotMatch(lazy.wakes[2]!, /新地址Y/);
  // 今晚前面过了的段改过的（Y）是这一段的整理前；这一段再改成 Z、没写进去：整理前照 Y 判
  const chained = await run({ ops: [{ stage: "people", gold: "新地址Y" }, { stage: "soul", gold: "新地址Z" }], passed: ["people"], answer: "新地址Y" });
  assert.equal(chained.r.pass, false);
  assert.match(chained.wakes.at(-1)!, /标准答案：新地址Y/);
  // 这一段没改题：整理前照前面那段改过的判，跟整理后一样
  const theirs = await run({ ops: [{ stage: "people", gold: "新地址Y" }], passed: ["people"], answer: "旧地址X" });
  assert.equal(theirs.r.pass, true, theirs.r.problems.join("|"));
  for (const w of theirs.wakes) assert.match(w, /标准答案：新地址Y/);
});

// 攻击 FINAL-GRADER：段的考试里判分挪了层（重要度 3）、段过了，全天考试还在原来那层考
test("A5 final exam layers: the whole-day exam follows the grader's pending layer op for every importance", async () => {
  for (const importance of [2, 3, 4, 5]) {
    const x = finalRig({ passed: [prec("events", [OL]), prec("people", [OL])] });
    const [q] = oldQs(x.bank, [onFile(OL, "挪下去的", { layer: "resident", importance, sources: ["e0001"] })]);
    x.bank.addOp(SD, "people", { kind: "layer", q: q!, layer: "searchable", why: "判分" }, 1);
    assert.deepEqual(await x.check(SD), { redo: [] });
    assert.deepEqual(x.finals().map((f) => [f.q, f.layer]), [[q, "searchable"]], `重要度 ${importance}`);
    assert.ok(x.opened.some((s) => s.id === fid("after-searchable")) && !x.opened.some((s) => s.id === fid("after-resident")), `重要度 ${importance}`);
  }
});

// 实现时的决定 2（C1）：部分对也挪层重考，只给重要度 ≥ 4 的；别的部分对不挪、记一句部分对
test("A6 C1 move on partial: a partial answer is moved to the grader's lower layer and retaken only for importance ≥ 4", async () => {
  const run = async (importance: number) => {
    const x = sitting({ exam: { sample: 0 }, host: {
      verdict: (p, q) => (q === "挂着的" && p === "after" ? "partial" : "right"), layers: (q) => (q === "挂着的" ? "searchable" : undefined),
    } });
    const [q] = oldQs(x.bank, [on80("挂着的", { layer: "resident", importance })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
    return { x, q: q!, r };
  };
  const plain = await run(3);
  assert.deepEqual(plain.r, { pass: true, problems: ["部分对：挂着的"] });
  assert.deepEqual(plain.x.results().map((v) => [v.phase, v.layer, v.verdict]), [["after", "resident", "partial"]], "不挪、不重考");
  assert.ok(!plain.x.opened.some((s) => s.id.includes("-retake-")));
  plain.x.bank.activate(SD, ["soul"]);
  assert.equal(plain.x.bank.get(plain.q)!.layer, "searchable", "判分判的层照样落地时改");
  const big = await run(4);
  assert.deepEqual(big.r, { pass: true, problems: [] });
  assert.deepEqual(big.x.results().map((v) => [v.phase, v.layer, v.verdict]), [["after", "resident", "partial"], ["retake", "searchable", "right"]]);
});

// 评审补的（plan 3 A1 的同一类）：只写编号的旧题被 affects 写成挪进只在仓库，checkArchive 照编号判对，删掉的那一行就没人管了
test("A7 no 路径:行, no archive: a move into archive by affects or by the grader is clamped to searchable, so deleting the guarded line is a regression", async () => {
  const NOTE = (id: string) => `要紧（${id}）没有路径:行出处，不能挪进只在仓库，按查得到考`;
  const lost = twoState({ "soul/80.md": [`第一行\n要紧的一行\n`, "第一行\n"] });
  // affects：查得到 → 只在仓库，出处只有编号
  const x = sitting({ exam: { sample: 0 }, host: { verdict: (p, q) => (q === "要紧" ? (p === "before" ? "right" : "wrong") : "right") } });
  const [q] = oldQs(x.bank, [on80("要紧", { layer: "searchable", sources: ["e0001"] })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "archive" }] }]), lost);
  assert.equal(r.pass, false);
  assert.deepEqual(r.problems, [`倒退：要紧（${q}；标准答案：要紧-gold）`]);
  assert.deepEqual(x.results().map((v) => [v.phase, v.layer, v.verdict]), [["after", "searchable", "wrong"], ["retake", "searchable", "wrong"], ["before", "searchable", "right"]]);
  // 记得住的：照查得到考、过了，报告里写一句，不写改层的 op
  const ok = sitting({ exam: { sample: 0 } });
  const [k] = oldQs(ok.bank, [on80("要紧", { layer: "searchable", sources: ["e0001"] })]);
  const passed = await ok.v.validate(ok.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: k!, layer: "archive" }] }]), lost);
  assert.deepEqual(passed, { pass: true, problems: [NOTE(k!)] });
  assert.equal(all(ok.db, "SELECT * FROM exam_op").length, 0);
  // 有 路径:行 的照旧挪
  const line = sitting({ exam: { sample: 0 } });
  const [l] = oldQs(line.bank, [on80("要紧", { layer: "searchable", sources: ["e0001", "soul/80.md:1"] })]);
  await line.v.validate(line.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: l!, layer: "archive" }] }]), xctx(["soul/80.md"]));
  assert.deepEqual(line.results().map((v) => [v.phase, v.layer]), [["after", "archive"]]);

  // 判分判了只在仓库：没有 路径:行 的不挪、不重考在仓库，删掉的那一行照样是倒退
  const g = sitting({ exam: { sample: 0 }, host: { verdict: (p, q) => (q === "要紧" ? (p === "before" ? "right" : "wrong") : "right"), layers: (q) => (q === "要紧" ? "archive" : undefined) } });
  const [gq] = oldQs(g.bank, [on80("要紧", { layer: "searchable", sources: ["e0001"] })]);
  g.bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const gr = await g.v.validate(g.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade" }]), lost);
  assert.equal(gr.pass, false);
  assert.match(gr.problems.join("|"), new RegExp(`^倒退：要紧（${gq}`));
  assert.ok(g.results().every((v) => v.layer !== "archive"), JSON.stringify(g.results()));
  // 判分判了只在仓库、答对了：照查得到记，过了写一句；落地时不挪进只在仓库
  const h = sitting({ exam: { sample: 0 }, host: { layers: (q) => (q === "要紧" ? "archive" : undefined) } });
  const [hq2] = oldQs(h.bank, [on80("要紧", { layer: "resident", sources: ["e0001"] })]);
  const hr = await h.v.validate(h.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(hr, { pass: true, problems: [NOTE(hq2!)] });
  h.bank.activate(SD, ["soul"]);
  assert.equal(h.bank.get(hq2!)!.layer, "searchable");
  // 重要度 ≥ 4 写了 affects、判分同意挪进只在仓库：没有 路径:行 也一样按查得到
  const big = sitting({ exam: { sample: 0 }, host: { layers: (q) => (q === "要紧" ? "archive" : undefined) } });
  const [b] = oldQs(big.bank, [on80("要紧", { layer: "searchable", importance: 5, sources: ["e0001"] })]);
  const br = await big.v.validate(big.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: b!, layer: "archive" }] }]), xctx(["soul/80.md"]));
  assert.deepEqual(br, { pass: true, problems: [NOTE(b!)] });
  assert.equal(all(big.db, "SELECT * FROM exam_op").length, 0);
});

// 人物那一段：私密的印象（visibility 不是 all）不出题——题库和判分主人看得到
test("A8 private impressions: a compress change on a private impression needs no question (note 私密字段，不出题); on a public one it is sent back", async () => {
  const run = async (priv: boolean) => {
    const x = sitting({ exam: { sample: 0 } });
    x.host.isPrivate = (ref) => priv && ref === "i0007";
    return x.v.validate(x.stage, SD, xrec([], [{ target: "i0007", op: "compress" }]), xctx([]));
  };
  assert.deepEqual(await run(true), { pass: true, problems: ["私密字段，不出题：i0007"] });
  assert.deepEqual(await run(false), { pass: false, problems: ["i0007 要压缩，但没有出题"] });
  // 照 diff 的那条不受影响（印象不是文件）：同一段删了文件里的一行，照样要出题
  const y = sitting({ exam: { sample: 0 } });
  y.host.isPrivate = () => true;
  const r = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "i0007", op: "compress" }, { target: "soul/80.md", op: "tidy" }]),
    twoState({ "soul/80.md": ["一\n二\n", "一\n"] }));
  assert.deepEqual(r, { pass: false, problems: ["soul/80.md 删掉或改写了内容，但没有出题"] });
  // 真的 host：照事件库 mem_impression 的 visibility 看
  const rows: Record<string, { visibility: string }> = { i0001: { visibility: "private:ada" }, i0002: { visibility: "all" } };
  const mem = { store: { impression: (id: string) => rows[id] } } as unknown as EventMemory;
  const hosts = hostsFor(examFlow(), { mem });
  assert.deepEqual(["i0001", "i0002", "i0003", "e0001"].map((r) => hosts.exam!.isPrivate!(r)), [true, false, false, false]);
  assert.equal(hostsFor(examFlow()).exam!.isPrivate!("i0001"), false, "没有事件库");
});

// 题库主人看得到：出处里有私密的印象的题，段交的、出暗题的交的都不收
test("A9 private sources: a question citing a private impression is refused at intake — the stage's exam_questions and the hidden setter", async () => {
  const PRIV = "出处是私密字段，不能出题（题库和判分主人看得到）";
  const any = () => true;
  const priv = (r: string) => r === "i0001";
  const q = (sources: string[]) => qin("她私下说的", { sources, tags: noTags({ files: ["soul/80.md"] }) });
  for (const s of [["i0001"], ["e0001", "i0001"], ["i0001「原话」"], [" i0001 "]]) assert.equal(questionProblem(q(s), any, priv), PRIV, s.join(","));
  assert.equal(questionProblem(q(["e0001", "i0002"]), any, priv), null, "公开的印象照收");
  assert.equal(questionProblem(q(["i0001"]), any), null, "不给 isPrivate：照旧");

  // 出暗题的交的
  const x = sitting({ exam: { hidden: 5 }, host: { setter: () => [hq("好"), hq("私密的", { sources: ["e0001", "i0001"] })] } });
  x.host.isPrivate = priv;
  ownQ(x);
  await runHid(x);
  assert.deepEqual(hidRows(x).map((r) => r.q), ["好"]);

  // 段交的（真的 host：i0001 私密、i0002 公开）
  const driver = new FakeDriver();
  const flow = examFlow();
  const ws: Record<string, string> = { "soul/80.md": "第一行\n" };
  const fs: MiniFs = { read: (p) => ws[p] ?? null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const rows: Record<string, { visibility: string }> = { i0001: { visibility: "private:ada" }, i0002: { visibility: "all" } };
  const mem = { store: { event: (id: string) => (id === "e0001" ? {} : null), entry: () => null, impression: (id: string) => rows[id] }, index: { quote: () => null } } as unknown as EventMemory;
  const db = openDb(":memory:");
  const hosts = hostsFor(flow, { driver, fs, mem, db });
  hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) }).wake("开始");
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const sub = (name: string, sources: string[]) =>
    ({ q: name, gold: `${name}的答案`, accept: "", sources, tags: noTags({ files: ["soul/80.md"] }), importance: 3, kind: "fact", layer: "searchable", isNew: false });
  const reply = String(await tool.handler({ questions: [sub("私密", ["e0001", "i0001"]), sub("公开", ["e0001", "i0002"])], revise: [], retire: [] } as never));
  assert.match(reply, /收下 1 道/, reply);
  assert.ok(reply.includes(PRIV), reply);
  assert.deepEqual(all<{ q: string }>(db, "SELECT q FROM exam_q ORDER BY rowid").map((r) => r.q), ["公开"]);
});

// ==================== plan 3 A 评审第 1 轮：评审的攻击（atk.test.ts 的 K1、K1b、K1c、K2、K4、K7、K8），现在都得拦下 ====================
const K_LINE = "要紧的一行";
const kLoss = () => twoState({ "soul/80.md": [`第一行\n${K_LINE}\n`, "第一行\n"] });
const kLosing = (p: Phase, q: string): Verdict => (q === "要紧" ? (p === "before" ? "right" : "wrong") : "right");

test("K1 a stale 路径:行 doesn't open archive: affects → archive on 「id + 行号过了头」, guarded line deleted → clamped to searchable, 倒退", async () => {
  for (const importance of [3, 5]) {
    const x = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9", verdict: kLosing, layers: (q) => (q === "要紧" ? "archive" : undefined) } });
    const [q] = oldQs(x.bank, [on80("要紧", { layer: "searchable", importance, sources: ["e0001", "soul/80.md:9"] })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "archive" }] }]), kLoss());
    assert.equal(r.pass, false, `重要度 ${importance}`);
    assert.match(r.problems.join("|"), new RegExp(`^倒退：要紧（${q}`), `重要度 ${importance}`);
    assert.ok(x.results().every((v) => v.layer === "searchable"), JSON.stringify(x.results()));
    assert.equal(all(x.db, "SELECT * FROM exam_op").length, 0);
  }
});

test("K1b a stale 路径:行 doesn't open archive: the grader says archive, guarded line deleted → not moved, 倒退", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9", verdict: kLosing, layers: (q) => (q === "要紧" ? "archive" : undefined) } });
  const [q] = oldQs(x.bank, [on80("要紧", { layer: "searchable", sources: ["e0001", "soul/80.md:9"] })]);
  x.bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade" }]), kLoss());
  assert.equal(r.pass, false);
  assert.match(r.problems.join("|"), new RegExp(`^倒退：要紧（${q}`));
  assert.ok(x.results().every((v) => v.layer === "searchable"), JSON.stringify(x.results()));
});

test("K1c archive rounds judge only sources that resolve before: a live 路径:行 on the deleted line plus a stale one → 倒退; stale-only archive questions sit at searchable", async () => {
  for (const start of ["searchable", "archive"] as const) {
    const x = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9" } });
    const [q] = oldQs(x.bank, [on80("要紧", { layer: start, sources: ["soul/80.md:2", "soul/80.md:9"] })]);
    x.bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
    const aff = start === "searchable" ? { affects: [{ q: q!, layer: "archive" as const }] } : {};
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", ...aff }]), kLoss());
    assert.equal(r.pass, false, start);
    assert.match(r.problems.join("|"), new RegExp(`^倒退：要紧（${q}`), start);
    assert.deepEqual(x.results().filter((v) => v.q === q).map((v) => [v.phase, v.layer, v.verdict]), [["after", "archive", "wrong"], ["before", "archive", "right"]], start);
  }
  // 已经在只在仓库、路径:行 整理前都查不到：按查得到考，记一句
  const y = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9" } });
  const [s] = oldQs(y.bank, [on80("要紧", { layer: "archive", sources: ["e0001", "soul/80.md:9"] })]);
  const r = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [`要紧（${s}）的路径:行出处整理前都查不到，按查得到考`] });
  assert.deepEqual(y.results().map((v) => [v.phase, v.layer]), [["after", "searchable"]]);
  // 被删的那行是挡着的：照查得到考，倒退
  const z = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9", verdict: kLosing } });
  oldQs(z.bank, [on80("要紧", { layer: "archive", sources: ["e0001", "soul/80.md:9"] })]);
  z.bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
  assert.equal((await z.v.validate(z.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade" }]), kLoss())).pass, false);
});

test("K2 a whole-day-exam redo: the stage's own pending revise from an earlier attempt is this attempt's before gold", async () => {
  for (const selfPassed of [true, false]) {
    const { db, bank } = mkBank();
    const flow = examFlow({ sample: 0 });
    const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
    bank.addOp(SD, "soul", { kind: "revise", q: old!, gold: "新地址Y", why: "搬家了" }, 1);
    SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 2, model: "opus" }, 1);
    // 整理前（第 1 次过了以后）记得 Y；重做把它删了
    const g = goldHost((_id, phase) => (phase === "before" ? "新地址Y" : "不记得了"));
    const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => (selfPassed ? ["soul"] : []) });
    const rec = { ...xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy", affects: [{ q: old!, layer: "searchable" }] }]), attempt: 2 };
    const r = await v.validate(flow.stages[0]!, SD, rec, twoState({ "soul/80.md": ["第一行\n他住新地址Y\n", "第一行\n"] }));
    assert.equal(r.pass, false, `selfPassed=${selfPassed}`);
    assert.match(r.problems.join("|"), /^倒退：他住哪/);
    assert.deepEqual(g.graderWakes.map((w) => [...w.matchAll(/标准答案：(.*)/g)].map((m) => m[1])), [["新地址Y"], ["新地址Y"], ["新地址Y"]]);
  }
});

test("K4 compressions ignore whitespace: a separator with a space inserted (or kept inside a longer line) still splits two runs; a whitespace/punctuation-wrapped copy alone is no compression", async () => {
  // 评审第 2 轮 W1：标点有意思，只去空白、全角换半角——「- 乙，是乙的事！」这种加了标点的不再算没改
  for (const after of ["乙是乙的事\n", "乙 是乙的事\n", "乙是乙的事。\n"]) {
    const x = sitting({ exam: { sample: 0 } });
    x.bank.addPending(SD, "soul", [qin("一道", { tags: noTags({ files: ["soul/80.md"] }) })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": ["甲是甲的事\n乙是乙的事\n丙是丙的事\n", after] }));
    assert.equal(r.pass, false, after);
    assert.match(r.problems.join("|"), /2 处内容，挂在它上面的题只有 1 道，要 2 道/, after);
  }
  const y = sitting({ exam: { sample: 0 } });
  const cosmetic = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]),
    twoState({ "soul/80.md": ["甲是甲的事\n乙是乙的事\n", "甲 是甲的事。\n「乙是乙的事」\n"] }));
  assert.deepEqual(cosmetic, { pass: true, problems: [] });
});

test("K7 a revise on a question the stage doesn't otherwise touch is examined in that stage: a lazy revise is 倒退", async () => {
  const { db, bank } = mkBank();
  const flow = examFlow({ sample: 0 });
  const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
  bank.addOp(SD, "soul", { kind: "revise", q: old!, gold: "随便写的", why: "改了" }, 1);
  SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
  const g = goldHost((id) => (id.includes("/soul/") ? "九十的-gold" : "旧地址X"));
  const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING });
  bank.addPending(SD, "soul", [qin("九十的", { tags: noTags({ files: ["soul/90.md"] }) })]);
  const r = await v.validate(flow.stages[0]!, SD, xrec(["soul/90.md"], [{ target: "soul/90.md", op: "add" }]), xctx(["soul/90.md"]));
  assert.equal(r.pass, false);
  assert.match(r.problems.join("|"), new RegExp(`^倒退：他住哪（${old}`));
  assert.deepEqual(all<{ phase: string }>(db, "SELECT phase FROM exam_result WHERE q = ? ORDER BY id", old!).map((x) => x.phase), ["after", "retake", "before"]);
});

test("K8 an earlier stage's lazy revise can't disarm the guard: the revising stage fails as 倒退 (its revise is dropped), so the later stage's deletion is 倒退 too", async () => {
  const { db, bank } = mkBank();
  const flow = fmk([fagent("people", { title: "人物", writes: ["memory/people/**"], exam: { hidden: 0, sample: 0 } }), fagent("soul", { title: "灵魂", writes: ["soul/**"], exam: { hidden: 0, sample: 0 } })],
    { exam: { baseBlocks: BASE, inject: ["**"] } });
  const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
  const g = goldHost((id, phase) => (id.includes("/people/") || id.includes("/soul/") ? "自己的-gold" : phase === "before" ? "旧地址X" : "不记得了"));
  let passed: string[] = [];
  const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => passed });
  // 人物那一段：没碰 soul/80.md，却申请把它的答案改成「随便写的」（没写进记忆）
  SL.startStage(db, { runId: 1, day: SD, stage: "people", attempt: 1, model: "opus" }, 1);
  bank.addOp(SD, "people", { kind: "revise", q: old!, gold: "随便写的", why: "改了" }, 1);
  bank.addPending(SD, "people", [qin("自己的", { tags: noTags({ files: ["memory/people/a.md"] }) })]);
  const people = await v.validate(flow.stages[0]!, SD, { ...xrec(["memory/people/a.md"], [{ target: "memory/people/a.md" }]), stage: "people" }, xctx(["memory/people/a.md"]));
  assert.equal(people.pass, false);
  assert.match(people.problems.join("|"), new RegExp(`^倒退：他住哪（${old}`));
  // 没过的那一次的改题、退休撤回（runner 的 attemptEnded）
  bank.dropAttemptOps(SD, "people", 1, ["revise", "retire"]);
  // 灵魂那一段删了「他住旧地址X」：整理前照旧答案判，倒退
  passed = [];
  SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 1, model: "opus" }, 1);
  bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const soul = await v.validate(flow.stages[1]!, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": ["第一行\n他住旧地址X\n", "第一行\n"] }));
  assert.equal(soul.pass, false);
  assert.match(soul.problems.join("|"), new RegExp(`^倒退：他住哪（${old}`));
});

// ==================== plan 3 A 评审第 2 轮：再评审的攻击（V3、V4、W1），外加 W2 的说法 ====================
test("V3 a stale-only archive question clamped to searchable can't be re-archived by the grader: not moved, no op, 倒退", async () => {
  for (const sources of [["e0001", "soul/80.md:9"], ["soul/80.md:9"]]) {
    const x = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9", verdict: kLosing, layers: (q) => (q === "要紧" ? "archive" : undefined) } });
    const [q] = oldQs(x.bank, [on80("要紧", { layer: "archive", importance: 5, sources })]);
    x.bank.addPending(SD, "soul", [qin("自己的", { tags: noTags({ files: ["soul/80.md"] }) })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade" }]), kLoss());
    assert.equal(r.pass, false, JSON.stringify(sources));
    assert.match(r.problems.join("|"), new RegExp(`^倒退：要紧（${q}`));
    assert.deepEqual(x.results().filter((v) => v.q === q).map((v) => [v.phase, v.layer, v.verdict]),
      [["after", "searchable", "wrong"], ["retake", "searchable", "wrong"], ["before", "searchable", "right"]], JSON.stringify(sources));
    assert.equal(all(x.db, "SELECT * FROM exam_op").length, 0);
  }
  // 答对了：过，记一句，不写改层的 op（它在题库里还是只在仓库）
  const y = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9", layers: (q) => (q === "要紧" ? "archive" : undefined) } });
  const [s] = oldQs(y.bank, [on80("要紧", { layer: "archive", sources: ["e0001", "soul/80.md:9"] })]);
  assert.deepEqual(await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"])),
    { pass: true, problems: [`要紧（${s}）的路径:行出处整理前都查不到，按查得到考`] });
  assert.equal(all(y.db, "SELECT * FROM exam_op").length, 0);
});

test("V4 a whole-day-exam redo's before gold follows the order of tonight's revises: a later stage's revise after the stage's own earlier attempt wins", async () => {
  const { db, bank } = mkBank();
  const flow = fmk([fagent("soul", { title: "灵魂", writes: ["soul/**"], exam: { hidden: 0, sample: 0 } }), fagent("people", { title: "人物", writes: ["memory/people/**"], exam: { hidden: 0, sample: 0 } })],
    { exam: { baseBlocks: BASE, inject: ["**"] } });
  const [old] = oldQs(bank, [on80("他住哪", { gold: "旧地址X" })]);
  bank.addOp(SD, "soul", { kind: "revise", q: old!, gold: "新地址Y", why: "搬家了" }, 1);
  bank.addOp(SD, "people", { kind: "revise", q: old!, gold: "新地址Z", why: "又搬了" }, 1);
  SL.startStage(db, { runId: 1, day: SD, stage: "soul", attempt: 2, model: "opus" }, 1);
  const g = goldHost((_id, phase) => (phase === "before" ? "新地址Z" : "不记得了"));
  const v = examValidator({ host: g.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => ["soul", "people"] });
  const rec = { ...xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy", affects: [{ q: old!, layer: "searchable" }] }]), attempt: 2 };
  const r = await v.validate(flow.stages[0]!, SD, rec, twoState({ "soul/80.md": ["第一行\n他住新地址Z\n", "第一行\n"] }));
  assert.equal(r.pass, false);
  assert.match(r.problems.join("|"), /^倒退：他住哪/);
  assert.deepEqual(g.graderWakes.map((w) => [...w.matchAll(/标准答案：(.*)/g)].map((m) => m[1])), [["新地址Z"], ["新地址Z"], ["新地址Z"]]);
  // 这一次（第 2 次）自己又改成 W：整理后照 W，整理前照前面那几条按先后叠出来的 Z
  bank.addOp(SD, "soul", { kind: "revise", q: old!, gold: "新地址W", why: "再搬" }, 2);
  const g2 = goldHost((_id, phase) => (phase === "before" ? "新地址Z" : "不记得了"));
  const v2 = examValidator({ host: g2.host, bank, flow, db, rnd: () => 0, ladder: () => NO_SAVING, passed: () => ["soul", "people"] });
  await v2.validate(flow.stages[0]!, SD, rec, twoState({ "soul/80.md": ["第一行\n他住新地址Z\n", "第一行\n"] }));
  assert.deepEqual(g2.graderWakes.map((w) => [...w.matchAll(/标准答案：(.*)/g)].map((m) => m[1])), [["新地址W"], ["新地址W"], ["新地址Z"]]);
});

test("W1 compressions keep meaningful punctuation: a deleted list item, 3.5 → 35 and -5 → 5 are changes; only whitespace and full/half-width variants are ignored", async () => {
  for (const [b, a] of [
    ["# 喜好\n- 不吃香菜\n- 喜欢猫\n", "# 喜好\n- 喜欢猫\n他说「不吃香菜」是骗人的\n"],
    ["体重 3.5 斤\n", "体重 35 斤\n"],
    ["冬天最冷 -5 度\n", "冬天最冷 5 度\n"],
  ] as const) {
    const x = sitting({ exam: { sample: 0 } });
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": [b, a] }));
    assert.deepEqual(r, { pass: false, problems: ["soul/80.md 删掉或改写了内容，但没有出题"] }, a);
  }
  // 只差空白、全角半角：不算改
  const y = sitting({ exam: { sample: 0 } });
  const same = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]),
    twoState({ "soul/80.md": ["体重 3.5 斤，挺好\n- 不吃香菜\n", "体重3.5斤,挺好\n－ 不吃香菜\n"] }));
  assert.deepEqual(same, { pass: true, problems: [] });
});

test("W2 this stage's own archive question citing a line it added tonight is examined at searchable with the note 今天新加的行", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { exists: (ref, st) => !(ref === "soul/90.md:2" && st === "before") } });
  const [id] = x.bank.addPending(SD, "soul", [qin("新挪的", { layer: "archive", isNew: false, sources: ["soul/90.md:2"], tags: noTags({ files: ["soul/90.md"] }) })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/90.md"], [{ target: "soul/90.md", op: "add" }]), twoState({ "soul/90.md": ["旧\n", "旧\n新挪来的一段\n"] }));
  assert.deepEqual(r, { pass: true, problems: [`新挪的（${id}）的路径:行出处是今天新加的行，按查得到考`] });
  assert.deepEqual(x.results().map((v) => [v.phase, v.layer, v.verdict]), [["after", "searchable", "right"]]);
});

// ==================== plan 3 A 评审第 3 轮：W1 以后只改了标点的那行又把两处连成一处（K4 的标点变体）；N2 ====================
test("K4b a punctuation-only edit to the separator line never bridges two runs: it counts as its own run (at least 2 questions)", async () => {
  for (const [b, a] of [
    ["甲是甲的事\n乙是乙的事\n丙是丙的事\n", "乙，是乙的事\n"],
    ["甲是甲的事\n乙是乙的事\n丙是丙的事\n", "- 乙，是乙的事！\n"],
    ["甲是甲的事。\n乙是乙的事。\n丙是丙的事。\n", "乙是乙的事\n"],
  ] as const) {
    const x = sitting({ exam: { sample: 0 } });
    x.bank.addPending(SD, "soul", [qin("一道", { tags: noTags({ files: ["soul/80.md"] }) })]);
    const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": [b, a] }));
    assert.equal(r.pass, false, a);
    const m = /挂在它上面的题只有 1 道，要 (\d+) 道/.exec(r.problems.join("|"));
    assert.ok(m && Number(m[1]) >= 2, `${a}：${r.problems.join("|")}`);
  }
  // 只改了一行的标点、别的没删：这一行算一处，一道题就够
  const y = sitting({ exam: { sample: 0 } });
  y.bank.addPending(SD, "soul", [qin("一道", { tags: noTags({ files: ["soul/80.md"] }) })]);
  assert.deepEqual(await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": ["甲\n乙是乙的事\n", "甲\n乙，是乙的事\n"] })),
    { pass: true, problems: [] });
});

test("N2 affects → archive on a stale-only archive question is clamped to searchable with no layer op (like the grader route), note 不能挪进只在仓库", async () => {
  const x = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9" } });
  const [q] = oldQs(x.bank, [on80("要紧", { layer: "archive", sources: ["e0001", "soul/80.md:9"] })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: q!, layer: "archive" }] }]), xctx(["soul/80.md"]));
  assert.deepEqual(r, { pass: true, problems: [`要紧（${q}）的路径:行出处整理前都查不到，不能挪进只在仓库，按查得到考`] });
  assert.deepEqual(x.results().map((v) => [v.phase, v.layer]), [["after", "searchable"]]);
  assert.equal(all(x.db, "SELECT * FROM exam_op").length, 0, "不写改层的 op：题库里照旧是只在仓库");
  x.bank.activate(SD, ["soul"]);
  assert.equal(x.bank.get(q!)!.layer, "archive");
  // 这一段明说挪到查得到（不是被拦下来的）：照写 op
  const y = sitting({ exam: { sample: 0 }, host: { exists: (ref) => ref !== "soul/80.md:9" } });
  const [u] = oldQs(y.bank, [on80("要紧", { layer: "archive", sources: ["e0001", "soul/80.md:9"] })]);
  await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "fade", affects: [{ q: u!, layer: "searchable" }] }]), xctx(["soul/80.md"]));
  y.bank.activate(SD, ["soul"]);
  assert.equal(y.bank.get(u!)!.layer, "searchable");
});

// ---------- 最终评审修正（final review C1 / I1）----------

test("final C1 (REPRO-A2): master's I4 fixture — two adjacent facts folded into one line, declared as two compress changes — needs two questions", async () => {
  const run = async (n: number) => {
    const x = sitting();
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }, { target: "soul/80.md「九月」", op: "compress" }]);
    return x.v.validate(x.stage, SD, rec, twoState({ "soul/80.md": ["十月\n九月\n", "十九\n"] }));
  };
  const one = await run(1);
  assert.equal(one.pass, false, "连着删掉的算一处，但写了两条改动：要两道");
  assert.deepEqual(one.problems, ["soul/80.md 删掉或改写了 2 处内容，挂在它上面的题只有 1 道，要 2 道（每一处一道）"]);
  assert.deepEqual(await run(2), { pass: true, problems: [] });
});

test("final I1 (REPRO-LIVELOCK): more runs than the stage's exam max requires only max questions, with a 改动太散 note", async () => {
  const before = Array.from({ length: 12 }, (_, i) => `事实${i}\n留着${i}`).join("\n") + "\n";
  const after = Array.from({ length: 12 }, (_, i) => `留着${i}`).join("\n") + "\n";
  const run = async (n: number, max: number | null) => {
    const x = sitting({ exam: { sample: 0, ...(max === null ? {} : { max }) } });
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    return x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": [before, after] }));
  };
  const capped = await run(8, 8);
  assert.equal(capped.pass, true, JSON.stringify(capped));
  assert.ok(capped.problems.includes("soul/80.md 改动太散：12 处，只要求 8 道"), JSON.stringify(capped));
  // 不到上限：照样要上限那么多道，不过的时候不写「太散」（要的就是上限）
  const short = await run(5, 8);
  assert.equal(short.pass, false);
  assert.deepEqual(short.problems, ["soul/80.md 删掉或改写了 12 处内容，挂在它上面的题只有 5 道，要 8 道（每一处一道）"]);
  // 没超过上限：照旧每一处一道，不写「太散」
  const plain = await run(8, 12);
  assert.equal(plain.pass, false);
  assert.match(plain.problems.join("|"), /12 处内容，挂在它上面的题只有 8 道，要 12 道/);
});

test("final C1: changes count raises the requirement but is capped by max too", async () => {
  // 一处连着删掉，却写了 5 条改动、上限 3：要 3 道，带「太散」
  const changes = Array.from({ length: 5 }, (_, i) => ({ target: `soul/80.md「${i}」`, op: "compress" }));
  const run = async (n: number) => {
    const x = sitting({ exam: { sample: 0, max: 3 } });
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    return x.v.validate(x.stage, SD, xrec(["soul/80.md"], changes), twoState({ "soul/80.md": ["零\n一\n二\n三\n四\n", "合起来\n"] }));
  };
  const two = await run(2);
  assert.deepEqual(two, { pass: false, problems: ["soul/80.md 删掉或改写了 5 处内容，挂在它上面的题只有 2 道，要 3 道（每一处一道）"] });
  const three = await run(3);
  assert.equal(three.pass, true, JSON.stringify(three));
  assert.ok(three.problems.includes("soul/80.md 改动太散：5 处，只要求 3 道"));
});

// ---------- 修正第 2 轮（re-review N2）：上限按整段算 ----------

const broad = (tag: string): [string, string] => [
  Array.from({ length: 12 }, (_, i) => `${tag}事实${i}\n${tag}留着${i}`).join("\n") + "\n",
  Array.from({ length: 12 }, (_, i) => `${tag}留着${i}`).join("\n") + "\n",
];
const twoBroad = async (on80: number, on90: number) => {
  const x = sitting({ exam: { sample: 0, max: 8 } });
  x.bank.addPending(SD, "soul", [
    ...Array.from({ length: on80 }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })),
    ...Array.from({ length: on90 }, (_, i) => qin(`九十 ${i}`, { tags: noTags({ files: ["soul/90.md"] }) })),
  ]);
  return x.v.validate(x.stage, SD, xrec(["soul/80.md", "soul/90.md"], [{ target: "soul/80.md", op: "tidy" }, { target: "soul/90.md", op: "tidy" }]),
    twoState({ "soul/80.md": broad("甲"), "soul/90.md": broad("乙") }));
};

test("fix2 N2 (REPRO-I1B): two broad files in one stage — the cap is on the stage total, so max questions split across both files pass, with a note naming the files", async () => {
  const r = await twoBroad(6, 2);
  assert.equal(r.pass, true, JSON.stringify(r));
  assert.ok(r.problems.includes("改动太散：soul/80.md 12 处、soul/90.md 12 处，一共 24 处，只要求 8 道（每个文件至少 1 道）"), JSON.stringify(r));
});

test("fix2 N2: under the stage-total cap every compressed file still needs at least one question, and the total must reach max", async () => {
  const lopsided = await twoBroad(8, 0);
  assert.equal(lopsided.pass, false, "8 道全在一个文件上：另一个文件 0 道");
  // （终审修正轮 M5 改了这一条：8 道已经收满，再出题收不下——叫它改回去或者用 affects 点名旧题）
  assert.deepEqual(lopsided.problems, [XP.EXAM_FULL_CUTS("soul/90.md", 8)]);
  const short = await twoBroad(4, 3);
  assert.equal(short.pass, false);
  assert.deepEqual(short.problems, ["删掉或改写了 soul/80.md 12 处、soul/90.md 12 处，一共 24 处，挂在这些文件上的题只有 7 道，要 8 道（改动太散，一共只要求 8 道）"]);
  // 一道题同时挂在两个文件上：只算一道（要的是不同的题）
  const x = sitting({ exam: { sample: 0, max: 8 } });
  x.bank.addPending(SD, "soul", [
    ...Array.from({ length: 7 }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })),
    qin("两个文件都有", { tags: noTags({ files: ["soul/80.md", "soul/90.md"] }) }),
  ]);
  const both = await x.v.validate(x.stage, SD, xrec(["soul/80.md", "soul/90.md"], [{ target: "soul/80.md", op: "tidy" }, { target: "soul/90.md", op: "tidy" }]),
    twoState({ "soul/80.md": broad("甲"), "soul/90.md": broad("乙") }));
  assert.equal(both.pass, true, JSON.stringify(both));
});

test("fix2 N2: more compressed files than max — no per-file floor, but max distinct questions are still required", async () => {
  const run = async (n: number) => {
    const x = sitting({ exam: { sample: 0, min: 0, max: 1 } });
    x.bank.addPending(SD, "soul", Array.from({ length: n }, (_, i) => qin(`八十 ${i}`, { tags: noTags({ files: ["soul/80.md"] }) })));
    return x.v.validate(x.stage, SD, xrec(["soul/80.md", "soul/90.md"], [{ target: "soul/80.md", op: "tidy" }, { target: "soul/90.md", op: "tidy" }]),
      twoState({ "soul/80.md": ["一\n二\n", "一\n"], "soul/90.md": ["三\n四\n", "三\n"] }));
  };
  const one = await run(1);
  assert.equal(one.pass, true, JSON.stringify(one));
  assert.ok(one.problems.includes("改动太散：soul/80.md 1 处、soul/90.md 1 处，一共 2 处，只要求 1 道"), JSON.stringify(one));
  const zero = await run(0);
  assert.deepEqual(zero, { pass: false, problems: ["删掉或改写了 soul/80.md 1 处、soul/90.md 1 处，一共 2 处，挂在这些文件上的题只有 0 道，要 1 道（改动太散，一共只要求 1 道）"] });
});

// ---------- 回放第 1 次的修正（replay1 F1）：题号带不带 q: 都认 ----------

const QA = "q:2026-11-06/events/1";
const QB = "q:2026-11-06/events/2";
const bare = (id: string) => id.replace(/^q:/, "");

test("replay1 F1: an examinee answering without the q: prefix gets its real answers (either spelling, trimmed)", async () => {
  const h = examHost([(s) => { s.answers({ answers: [{ id: bare(QA), answer: "甲" }, { id: ` ${QB} `, answer: "乙" }] }); s.turnEnd(true); }]);
  const r = await examineLayer(h.host, { ...EX, layer: "searchable", questions: [xq(QA), xq(QB)] });
  assert.deepEqual([...r!], [[QA, "甲"], [QB, "乙"]]);
});

test("replay1 F1: a grader grading without the q: prefix has its verdicts (partial too) and layer calls applied", async () => {
  const h = examHost([(s) => {
    s.grades({ grades: [{ id: bare(QA), verdict: "partial", reason: "差一点" }, { id: QB, verdict: "right", reason: "对" }], layers: [{ id: bare("q:2026-11-06/events/9"), layer: "archive" }] });
    s.turnEnd(true);
  }]);
  const r = await grade(h.host, { id: "g", model: "m", opening: "O", items: [{ q: xq(QA), answer: "a" }, { q: xq(QB), answer: "b" }], askLayers: [xq("q:2026-11-06/events/9")] });
  assert.deepEqual(r!.grades.get(QA), { verdict: "partial", reason: "差一点" });
  assert.deepEqual(r!.grades.get(QB), { verdict: "right", reason: "对" });
  assert.equal(r!.layers.get("q:2026-11-06/events/9"), "archive");
});

test("replay1 F1: an unknown id gets 这几个题号对不上 / 还没答的 back, the session goes on, and a resubmit merges", async () => {
  const replies: string[] = [];
  const h = examHost([(s) => {
    replies.push(s.answers({ answers: [{ id: "q:2026-11-06/events/99", answer: "错号" }, { id: bare(QA), answer: "甲" }] }));
    replies.push(s.answers({ answers: [{ id: bare(QB), answer: "乙" }] }));
    s.turnEnd(true);
  }]);
  const r = await examineLayer(h.host, { ...EX, layer: "searchable", questions: [xq(QA), xq(QB)] });
  assert.match(replies[0]!, /这几个题号对不上：q:2026-11-06\/events\/99；还没答的：q:2026-11-06\/events\/2/);
  assert.equal(replies[1], "收到。");
  assert.deepEqual([...r!].sort(), [[QA, "甲"], [QB, "乙"]]);

  const g: string[] = [];
  const gh = examHost([(s) => {
    g.push(s.grades({ grades: [{ id: "2026-11-06/events/77", verdict: "right", reason: "x" }, { id: bare(QA), verdict: "wrong", reason: "不对" }], layers: [] }));
    g.push(s.grades({ grades: [{ id: QB, verdict: "partial", reason: "一半" }], layers: [] }));
    s.turnEnd(true);
  }]);
  const gr = await grade(gh.host, { id: "g", model: "m", opening: "O", items: [{ q: xq(QA), answer: "a" }, { q: xq(QB), answer: "b" }], askLayers: [] });
  assert.match(g[0]!, /这几个题号对不上：2026-11-06\/events\/77；还没判的：q:2026-11-06\/events\/2/);
  assert.equal(g[1], "收到。");
  assert.deepEqual(gr!.grades.get(QA), { verdict: "wrong", reason: "不对" });
  assert.deepEqual(gr!.grades.get(QB), { verdict: "partial", reason: "一半" });
  assert.ok(!gr!.grades.has("2026-11-06/events/77"));
});

test("replay1 F1: through the examiner, an examinee and graders that drop q: still pass the stage on its real answers", async () => {
  const x = sitting({ exam: { sample: 0 } });
  x.bank.addPending(SD, "soul", [qin("八十 一", { tags: noTags({ files: ["soul/80.md"] }) }), qin("八十 二", { tags: noTags({ files: ["soul/80.md"] }) })]);
  const open = x.host.open.bind(x.host);
  x.host.open = (op) => {
    const s = open(op) as ReturnType<ExamHost["open"]>;
    const onA = s.onAnswers.bind(s);
    const onG = s.onGrades.bind(s);
    s.onAnswers = (fn) => onA((a) => fn({ answers: a.answers.map((y) => ({ ...y, id: bare(y.id) })) }));
    s.onGrades = (fn) => onG((g) => fn({ grades: g.grades.map((y) => ({ ...y, id: bare(y.id) })), layers: g.layers.map((y) => ({ ...y, id: bare(y.id) })) }));
    return s;
  };
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md", op: "tidy" }]), twoState({ "soul/80.md": ["一\n二\n三\n", "一\n"] }));
  assert.deepEqual(r, { pass: true, problems: [] });
  const graderWakes = x.opened.filter((s) => s.allowed.includes("exam_grades")).flatMap((s) => s.wakes);
  assert.ok(graderWakes.length > 0);
  assert.ok(!graderWakes.some((w) => w.includes("（没答）")), "考生交的回答都对上了");
});

// ---- 切换前 P2：考试的当场核对（precheck）跟考试开头的覆盖检查同一份代码，不开会话 ----

test("P2: exam precheck finds a compression with no question and names it; with a question on it nothing; no exam block nothing; no sessions", () => {
  const x = sitting();
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }]);
  const ctx = xctx(["soul/80.md"]);
  // （修正轮 I1 改了这一条：点名的是那样东西，去掉小节）
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, ctx), { problems: ["soul/80.md「十月」 要压缩，但没有出题"], targets: ["soul/80.md"] });
  // 照实际的 diff：删掉了一行、没有题挂在这个文件上
  const cut: ValidateCtx = { ...ctx, after: snapOf({ "soul/80.md": "" }) };
  assert.deepEqual(x.v.precheck!(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), cut), { problems: ["soul/80.md 删掉或改写了内容，但没有出题"], targets: ["soul/80.md"] });
  x.bank.addPending(SD, "soul", [qin("十月做了什么", { tags: noTags({ files: ["soul/80.md"] }) })]);
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, ctx), { problems: [], targets: [] });
  const none = sitting({ exam: null });
  assert.deepEqual(none.v.precheck!(none.stage, SD, rec, ctx), { problems: [], targets: [] });
  assert.equal(x.opened.length + none.opened.length, 0, "当场核对不开会话");
});

// ---- 切换前 P7：出处写 c:N 跟 #N 一样（段的工作单列原话用的就是 c:N） ----
import { pathRef } from "../src/sleep/exam.ts";
import { thing, changedThings, hangsOn } from "../src/sleep/examiner.ts";

test("P7: a source written c:N is taken like #N — sourceExists, intake; it is neither a 路径:行 nor a thing", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (65993, 1, 1, 'x', 'input', '原话', 1)").run();
  const driver = new FakeDriver();
  const flow = examFlow();
  const ws: Record<string, string> = { "soul/80.md": "一\n" };
  const fs: MiniFs = { read: (p) => ws[p] ?? null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const hosts = hostsFor(flow, { driver, fs, db });
  const at = { day: SD, state: "before" as const };
  for (const [ref, ok] of [["c:65993", true], ["#65993", true], ["c:65994", false], ["#65994", false], [" c:65993 ", true]] as const) {
    assert.equal(hosts.exam!.sourceExists(ref, at), ok, ref);
  }
  assert.equal(pathRef("c:65993"), null, "c:N 不是「路径:行」");
  assert.equal(thing("c:65993"), "", "跟 #N 一样说不出是哪样东西");
  assert.equal(thing("#65993"), "");
  hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) }).wake("开始");
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const sub = (q: string, layer: string, sources: string[]) =>
    ({ q, gold: `${q}的答案`, accept: "", sources, tags: noTags({ files: ["soul/80.md"] }), importance: 3, kind: "fact", layer, isNew: false });
  const reply = String(await tool.handler({
    questions: [sub("原话", "searchable", ["c:65993"]), sub("没有的", "searchable", ["c:65994"]), sub("仓库", "archive", ["c:65993"])],
    revise: [], retire: [],
  } as never));
  assert.match(reply, /收下 1 道/, reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.noSource(["c:65994"])), reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.archiveLine), reply);
});

// ---- 切换前 P3：题也能挂在人、东西的登记（t…）和印象（i…）上 ----

test("P3: a change on t0128 / i0002 counts as an event-store thing — old questions tagged with it are examined; a question citing it hangs", async () => {
  const x = sitting({ exam: { sample: 0 } });
  const [old] = oldQs(x.bank, [qin("甲喜欢什么歌", { isNew: false, sources: ["#1"], tags: noTags({ events: ["t0128"] }) })]);
  x.bank.addPending(SD, "soul", [qin("跟甲的约定", { sources: ["t0128"], tags: noTags({ who: ["甲"] }) })]);
  const rec = xrec([], [{ target: "t0128", op: "compress" }, { target: "i0002「关系」", op: "add" }]);
  const r = await x.v.validate(x.stage, SD, rec, xctx([]));
  assert.deepEqual(r, { pass: true, problems: [] }, "t0128 上的压缩有题挂着");
  assert.ok(x.opened.some((s) => s.wake.includes("甲喜欢什么歌")), `挂在 t0128 上的旧题 ${old} 也考了`);
  assert.deepEqual(changedThings(rec), { files: [], events: ["t0128", "i0002"] });
});

test("P3: sources accept existing t… and i… ids at intake; unknown ones are refused; a private impression stays refused", async () => {
  const driver = new FakeDriver();
  const flow = examFlow();
  const ws: Record<string, string> = { "soul/80.md": "一\n" };
  const fs: MiniFs = { read: (p) => ws[p] ?? null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const mem = { store: {
    event: () => null, entry: () => null,
    entityById: (id: string) => (id === "t0128" ? { id } : undefined),
    impression: (id: string) => (id === "i0002" ? { id, visibility: "all" } : id === "i0003" ? { id, visibility: "owner" } : undefined),
  }, index: { quote: () => null } } as unknown as EventMemory;
  const hosts = hostsFor(flow, { driver, fs, mem, db: openDb(":memory:") });
  const at = { day: SD, state: "before" as const };
  for (const [ref, ok] of [["t0128", true], ["t9999", false], ["i0002", true], ["i9999", false]] as const) assert.equal(hosts.exam!.sourceExists(ref, at), ok, ref);
  hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) }).wake("开始");
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const sub = (q: string, sources: string[]) =>
    ({ q, gold: `${q}的答案`, accept: "", sources, tags: noTags({ who: ["甲"] }), importance: 3, kind: "fact", layer: "searchable", isNew: false });
  const reply = String(await tool.handler({
    questions: [sub("登记", ["t0128"]), sub("没登记", ["t9999"]), sub("印象", ["i0002"]), sub("没有的印象", ["i9999"]), sub("私密", ["i0003"])],
    revise: [], retire: [],
  } as never));
  assert.match(reply, /收下 2 道/, reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.noSource(["t9999"])), reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.noSource(["i9999"])), reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.private), reply);
});

// ---- 切换前 P4：顺着更正、合并的链接认原来那条（更正、合并新建的编号动手前不知道，题只能挂原来那条） ----
import { EventMemory as EvMem } from "../src/memory/events/memory.ts";

test("P4: correction n2 of n1 — a question tagged n1 covers the change on n2 (and its affects count); without the link it does not", async () => {
  const rec = xrec([], [{ target: "n01304", op: "change" }, { target: "n01305", op: "change", affects: [{ q: "旧", layer: "searchable" }] }]);
  const run = async (parents: (id: string) => string[]) => {
    const x = sitting({ exam: { sample: 0 } });
    const [old] = oldQs(x.bank, [qin("那天那句话", { isNew: false, layer: "resident", sources: ["#1"], tags: noTags({ events: ["n01017"] }) })]);
    x.bank.addPending(SD, "soul", [qin("更正的是什么", { sources: ["#1"], tags: noTags({ events: ["n01016"] }) })]);
    x.host.parentsOf = parents;
    const r = rec.changes[1]!;
    return x.v.validate(x.stage, SD, { ...rec, changes: [rec.changes[0]!, { ...r, affects: [{ q: old!, layer: "searchable" }] }] }, xctx([]));
  };
  const linked = await run((id) => (id === "n01304" ? ["n01016"] : id === "n01305" ? ["n01017"] : []));
  assert.deepEqual(linked, { pass: true, problems: [] });
  const bare = await run(() => []);
  assert.equal(bare.pass, false);
  assert.deepEqual(bare.problems, ["n01304 要压缩，但没有出题", "n01305 的 affects 点名的题不挂在它上面"]);
});

// （修正轮 M1 改了这一条：只认这一次尝试自己的批里写的更正、合并，不认 supersede、不认以前几夜的）
test("P4: the host's parentsOf follows the event store — a correction to what it corrects, a merge to what was folded in, a chain all the way (this attempt's batch only)", () => {
  const db = openDb(":memory:");
  const mem = new EvMem({ db, embedder: null, now: () => 1000, tz: "UTC" });
  const NIGHT = `sleep:${SD}/soul/1`;
  const at = { day: SD, stage: "soul", attempt: 1 };
  const e1 = mem.store.createEvent({ title: "留下的", summary: "s", gist: "g", importance: 2 }, "seed");
  const e2 = mem.store.createEvent({ title: "并掉的", summary: "s", gist: "g", importance: 2 }, "seed");
  const n1 = mem.store.addEntry({ event: e1.id, at: "2026-11-04 10:00", full: "原来那句话", gist: "原来", title: "原来" }, "seed").entry;
  const n2 = mem.store.correctEntry(n1.id, { full: "更正以后的那句话", gist: "更正", title: "更正", why: "更正" }, NIGHT);
  const n3 = mem.store.correctEntry(n2.id, { full: "再改一次的那句话", gist: "再改", title: "再改", why: "再改" }, NIGHT);
  mem.store.merge(e1.id, [e2.id], "其实是一件事", NIGHT);
  const hosts = hostsFor(examFlow(), { mem, db });
  const of = hosts.exam!.parentsOf!;
  assert.deepEqual(of(n2.id, at), [n1.id]);
  assert.deepEqual(of(n3.id, at), [n2.id, n1.id], "更正的更正：一路认到最早那条");
  assert.deepEqual(of(e1.id, at), [e2.id], "并进来的那件");
  assert.deepEqual(of(n1.id, at), []);
  assert.deepEqual(of("soul/80.md", at), [], "文件没有链接");
  assert.deepEqual(of(n2.id, { ...at, attempt: 2 }), [], "别的尝试（别的批）写的不认");
  assert.deepEqual(hostsFor(examFlow()).exam!.parentsOf!("n00001", at), [], "没有事件库");
});

test("P4: after a bounce, a question tagged with what the named change corrects is taken", async () => {
  const driver = new FakeDriver();
  const flow = examFlow();
  // （修正轮 M1 改了这一条：链接从这一次尝试的批里的 op 认）
  const correction = { op: "entry_correct", tbl: "mem_entry", before: null, after: JSON.stringify({ id: "n01304", corrects: "n01016" }) };
  // （修正轮 2 FR-m1：host 先数批里几条 op 再决定重不重读）
  const mine = (batch: string) => (batch === `sleep:${SD}/soul/1` ? [correction] : []);
  const mem = { store: { event: () => null, entry: () => undefined, ops: mine, opCount: (batch: string) => mine(batch).length }, index: { quote: () => null } } as unknown as EventMemory;
  const db = openDb(":memory:");
  db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'x', 'input', '原话', 1)").run();
  const hosts = hostsFor(flow, { driver, mem, db });
  const opened = hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) });
  opened.wake("开始");
  opened.bounced!({ questionsFor: ["n01304"] });
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const sub = (q: string, events: string[]) =>
    ({ q, gold: `${q}的答案`, accept: "", sources: ["#7"], tags: noTags({ events }), importance: 3, kind: "fact", layer: "searchable", isNew: true });
  const reply = String(await tool.handler({ questions: [sub("原来那条", ["n01016"]), sub("别的", ["n09999"])], revise: [], retire: [] } as never));
  assert.match(reply, /收下 1 道/, reply);
  assert.ok(reply.includes(XP.QUESTION_REFUSED.notNamed(["n01304"])), reply);
});

// ---- 切换前 P10a：exam.max = 0 不能把压缩的覆盖检查关掉；max 要是整数 ----

test("P10a: exam.max 0 does not turn off compression coverage — a cut with no question still fails (the cap counts from 1)", async () => {
  const x = sitting({ exam: { max: 0, min: 0, sample: 0 } });
  const cut: ValidateCtx = { ...xctx(["soul/80.md"]), after: snapOf({ "soul/80.md": "" }) };
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]);
  const r = await x.v.validate(x.stage, SD, rec, cut);
  // （修正轮 M7a 改了这一条：这一段不收题，问题说的是改回去，不是出题）
  assert.deepEqual(r, { pass: false, problems: [XP.EXAM_NO_CUTS("soul/80.md")] });
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, cut).problems, [XP.EXAM_NO_CUTS("soul/80.md")]);
});

test("P10a: parseFlow rejects a non-integer exam.max on a stage", () => {
  const e = flowErr(() => fmk([fagent("a", { exam: { max: 2.5 } })], { exam: { baseBlocks: ["x.md"] } }));
  assert.ok(e.problems.some((p) => p.includes("max")), e.problems.join("|"));
  assert.equal(fmk([fagent("a", { exam: { max: 3, min: 0 } })], { exam: { baseBlocks: ["x.md"] } }).stages[0]!.exam!.max, 3);
});

// ---- 切换前 P6：考场常驻那层也看得到她前缀里从事件库渲染的那一块（中期视图），exam.residentMemory 开着才有 ----

const MID_AFTER = "# 最近这一段\n\n- 说好周末去看海";
const MID_BEFORE = "# 最近这一段\n\n（整理前的样子）";
/** 常驻那层的题「周末去哪」：考生那一轮看到的里有「说好周末去看海」才答得对 */
function midSitting(on: boolean, extra: { old?: boolean } = {}) {
  const calls: Array<{ day: string; state: string; store: string }> = [];
  const box: { x: ReturnType<typeof sitting> | null } = { x: null };
  const saw = (phase: Phase): boolean => box.x!.opened.some((s) => s.id === sid(`${phase}-resident`) && s.wake.includes("说好周末去看海"));
  const x = sitting({
    exam: { sample: 0 }, global: on ? { residentMemory: true } : {},
    host: { verdict: (phase, q) => (q === "周末去哪" ? (saw(phase) ? "right" : "wrong") : q === "旧的" && phase !== "before" ? "wrong" : "right") },
  });
  box.x = x;
  x.host.memory = (o) => { calls.push({ day: o.day, state: o.state, store: o.store }); return o.state === "after" ? MID_AFTER : MID_BEFORE; };
  x.bank.addPending(SD, "soul", [qin("周末去哪", { layer: "resident" })]);
  if (extra.old) oldQs(x.bank, [on80("旧的", { layer: "resident" })]);
  return { x, calls, run: () => x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], "/scratch/before.db")) };
}

test("P6: a resident question answerable only from the mid-term view passes with exam.residentMemory on and fails with it off", async () => {
  const on = midSitting(true);
  assert.deepEqual(await on.run(), { pass: true, problems: [] });
  const w = on.x.opened.find((s) => s.id === sid("after-resident"))!.wake;
  assert.ok(w.includes(MID_AFTER), "整理后的中期视图在常驻那层的考生看到的里");
  assert.ok(w.indexOf(MID_AFTER) < w.indexOf("题目："), "放在题目前面，跟注入在一起");
  // （终审修正轮 M3 改了这一条：查得到那层也看中期视图——她白天的前缀里一直有它，开头的账本也照它裁了）
  assert.ok(on.x.opened.filter((s) => s.id.endsWith("-searchable")).every((s) => s.wake.includes(MID_AFTER)), "查得到那层也加");
  assert.deepEqual(on.calls, [{ day: SD, state: "after", store: "live" }]);
  const off = midSitting(false);
  const r = await off.run();
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.includes("常驻层得分")), r.problems.join("|"));
  assert.deepEqual(off.calls, [], "关着：不渲染");
  assert.ok(off.x.opened.every((s) => !s.wake.includes("说好周末去看海")));
});

test("P6: the before sitting renders the mid-term view from the before-copy of the store", async () => {
  const m = midSitting(true, { old: true });
  await m.run();
  const before = m.x.opened.find((s) => s.id === sid("before-resident"))!;
  assert.ok(before.wake.includes(MID_BEFORE), before.wake);
  assert.ok(!before.wake.includes(MID_AFTER));
  assert.deepEqual(m.calls.find((c) => c.state === "before"), { day: SD, state: "before", store: "/scratch/before.db" });
});

test("P6: exam.residentMemory is a boolean, false by default", () => {
  assert.equal(fmk([fagent("a")], { exam: { baseBlocks: ["x.md"] } }).exam.residentMemory, false);
  assert.equal(fmk([fagent("a")], { exam: { baseBlocks: ["x.md"], residentMemory: true } }).exam.residentMemory, true);
  const e = flowErr(() => fmk([fagent("a")], { exam: { baseBlocks: ["x.md"], residentMemory: "yes" } }));
  assert.ok(e.problems.some((p) => p.includes("residentMemory")), e.problems.join("|"));
});

test("P6: the host renders HH's own mid-term view — live store for after, the copy for before, at the night of the examined day; nothing when the live prefix has none", () => {
  const db = openDb(":memory:");
  const T = Date.UTC(2026, 10, 5, 12);
  const mem = new EvMem({ db, embedder: null, now: () => T, tz: "UTC" });
  const e = mem.store.createEvent({ title: "去看海", summary: "说好周末去看海", gist: "说好周末去看海", importance: 3 }, "seed");
  mem.store.addEntry({ event: e.id, at: "2026-11-05 10:00", full: "和朋友说好周末去看海", gist: "说好去看海", title: "说好" }, "seed");
  const copyDb = openDb(":memory:");
  const copy = new EvMem({ db: copyDb, embedder: null, now: () => T, tz: "UTC" });
  const opened: string[] = [];
  const cfg = (midterm: boolean) => loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-exam-mid-"), schedule: { timezone: "UTC", nightSleep: "03:00" }, memory: { events: { midterm } } });
  const hosts = hostsFor(examFlow(), { mem, db, cfg: cfg(true), now: () => Date.UTC(2026, 10, 8, 9), memAt: (p) => { opened.push(p); return { mem: copy, close() { opened.push(`closed ${p}`); } }; } });
  const after = hosts.exam!.memory!({ day: SD, state: "after", store: "live" });
  assert.ok(after.startsWith("# 最近这一段"), after);
  // （修正轮 2 I1 改了这一条：照她第二天一开始的样子算，11-05 不再是「今天」，只剩事件那一级的概要）
  assert.doesNotMatch(after, /## 今天/, "11-06 04:00 起：11-05 不是「今天」");
  assert.doesNotMatch(after, /和朋友说好周末去看海/, "只在经过全文里的细节看不到");
  assert.match(after, /去看海/, "事件还在「最近在发生的事」里（不是跑的时候的 11-08：那时候照样在 14 天内）");
  const before = hosts.exam!.memory!({ day: SD, state: "before", store: "/scratch/before.db" });
  assert.doesNotMatch(before, /看海/, "整理前：拷贝里没有这件");
  assert.deepEqual(opened, ["/scratch/before.db", "closed /scratch/before.db"], "拷贝开了就关");
  assert.equal(hosts.exam!.memory!({ day: SD, state: "before", store: "live" }), after, "没拷（不写事件库的段）：整理前就是现在的库");
  const plain = hostsFor(examFlow(), { mem, db, cfg: cfg(false) });
  assert.equal(plain.exam!.memory!({ day: SD, state: "after", store: "live" }), "", "她的前缀里没有中期视图：考场也不加");
});

test("P6: the whole-day exam's resident sitting sees the mid-term view of the live store too (only with exam.residentMemory)", async () => {
  const run = async (on: boolean) => {
    const calls: string[] = [];
    const x = finalRig({ global: on ? { residentMemory: true } : {}, passed: [prec("events", [OL]), prec("people", [OL])], proposed: { [OL]: "待办新" } });
    x.host.memory = (o) => { calls.push(`${o.state}:${o.store}`); return MID_AFTER; };
    oldQs(x.bank, [onFile(OL, "常驻的", { layer: "resident" }), onFile(OL, "查得到的")]);
    await x.check(SD);
    return { x, calls };
  };
  const on = await run(true);
  assert.ok(on.x.opened.find((s) => s.id === fid("after-resident"))!.wake.includes(MID_AFTER));
  // （终审修正轮 M3 改了这一条：查得到那层也看中期视图）
  assert.ok(on.x.opened.find((s) => s.id === fid("after-searchable"))!.wake.includes(MID_AFTER));
  assert.deepEqual(on.calls, ["after:live"]);
  const off = await run(false);
  assert.ok(!off.x.opened.find((s) => s.id === fid("after-resident"))!.wake.includes(MID_AFTER));
  assert.deepEqual(off.calls, []);
});

test("P6: a mid-term view that cannot be rendered takes the resident layer out, like a failed preview", async () => {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true } });
  x.host.memory = () => { throw new Error("库打不开"); };
  x.bank.addPending(SD, "soul", [qin("常驻的", { layer: "resident" }), qin("查得到的")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, true);
  assert.ok(r.problems.some((p) => p.includes("中期视图拼不出来：库打不开")), r.problems.join("|"));
  assert.ok(!x.opened.some((s) => s.id.endsWith("-resident")), "常驻那层不考");
  assert.equal(x.row().examined, 0);
});

// ---- 切换前 P5：可以配一组要忽略的标记（exam.ignoreMarks）：比较压缩、挪走的行还在不在之前先去掉 ----
import { lineKept } from "../src/sleep/exam.ts";

const MARK = "（已标）";
test("P5: a line that only gained a configured mark is not a compression; without the config it still is", async () => {
  const ctx = twoState({ "soul/80.md": ["他说会来。\n别的\n", `他说会来${MARK}。\n别的\n`] });
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "add" }]);
  const marked = sitting({ global: { ignoreMarks: [MARK] } });
  assert.deepEqual(marked.v.precheck!(marked.stage, SD, rec, ctx), { problems: [], targets: [] });
  assert.deepEqual(await marked.v.validate(marked.stage, SD, rec, ctx), { pass: true, problems: [] });
  const plain = sitting();
  assert.deepEqual(plain.v.precheck!(plain.stage, SD, rec, ctx).problems, ["soul/80.md 删掉或改写了内容，但没有出题"]);
  // 标记以外的改动照算：去掉标记以后还是不一样
  const changed = twoState({ "soul/80.md": ["他说会来。\n", `他说不来了${MARK}。\n`] });
  assert.deepEqual(marked.v.precheck!(marked.stage, SD, rec, changed).problems, ["soul/80.md 删掉或改写了内容，但没有出题"]);
});

test("P5: lineKept strips the marks from the cited lines and the new text before comparing", () => {
  const o = (strip?: (s: string) => string) => lineKept({
    changed: new Set(["a.md"]), before: () => "他说会来。\n", after: () => `他说会来${MARK}。\n`, exists: () => true, ...(strip ? { strip } : {}),
  });
  assert.equal(o()("a.md:1"), false, "不配：那一行算没了");
  assert.equal(o((s) => s.replaceAll(MARK, ""))("a.md:1"), true);
});

test("P5: exam.ignoreMarks defaults to [] and each one must compile as a regex", () => {
  assert.deepEqual(fmk([fagent("a")]).exam.ignoreMarks, []);
  // （修正轮 2 M1 改了这一条：默认是字面的，正则要写 re: 前缀；只有 re: 的要能编译）
  // （终审修正轮 M6 改了这一条：字面的「(」带着正则符号，现在报出来）
  assert.deepEqual(fmk([fagent("a")], { exam: { ignoreMarks: ["（已标）", "re:\\s*✅$"] } }).exam.ignoreMarks, ["（已标）", "re:\\s*✅$"]);
  for (const bad of [["re:("], "（已标）", [3], [""], ["re:"], ["("]]) {
    const e = flowErr(() => fmk([fagent("a")], { exam: { ignoreMarks: bad } }));
    assert.ok(e.problems.some((p) => p.includes("ignoreMarks")), `${JSON.stringify(bad)}：${e.problems.join("|")}`);
  }
});

// ---- Batch 1 修正轮（review-pre1）：评审的复现写成测试 ----

/** 真 host 上开一段、交题工具；central 里有 #7 */
function intakeRig(extra: Partial<NightBrain> = {}) {
  const driver = new FakeDriver();
  const flow = examFlow();
  const db = openDb(":memory:");
  db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (7, 1, 1, 'x', 'input', '原话', 1)").run();
  const hosts = hostsFor(flow, { driver, db, ...extra });
  const opened = hosts.stage.open({ id: `sleep-${SD}-soul-1`, stage: flow.stages[0]!, day: SD, allowed: new Set(["stage_done", "exam_questions"]) });
  opened.wake("开始");
  const tool = driver.sessions[0]!.spec.tools.find((t) => t.name === "exam_questions")!;
  const give = async (qs: QuestionIn[]) => String(await tool.handler({ questions: qs, revise: [], retire: [] } as never));
  return { opened, give };
}

test("pre1 I1 (REPRO-1): a bounce names thing(target); a question tagging the sectioned target verbatim is taken after the bounce and satisfies coverage", async () => {
  const x = sitting();
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }]);
  const ctx = xctx(["soul/80.md"]);
  const b = x.v.precheck!(x.stage, SD, rec, ctx);
  assert.deepEqual(b.targets, ["soul/80.md"], "退回里点名的是那样东西（去掉小节）");
  const q = qin("十月做了什么", { sources: ["#7"], tags: noTags({ files: ["soul/80.md「十月」"] }) });
  const r = intakeRig();
  r.opened.bounced!({ questionsFor: b.targets });
  assert.match(await r.give([q]), /收下 1 道/);
  x.bank.addPending(SD, "soul", [q]);
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, ctx), { problems: [], targets: [] });
  // 「路径 空格 小节」、编号后面带注的，也一样
  const r2 = intakeRig();
  r2.opened.bounced!({ questionsFor: ["soul/80.md 十月", "n01304（注）"] });
  assert.match(await r2.give([
    qin("一", { sources: ["#7"], tags: noTags({ files: ["soul/80.md 十月"] }) }),
    qin("二", { sources: ["#7"], tags: noTags({ events: ["n01304（注）"] }) }),
    qin("三", { sources: ["#7"], tags: noTags({ files: ["soul/90.md"] }) }),
  ]), /收下 2 道/);
});

test("pre1 I2 (REPRO-2): a lesson target — a question tagged with it in tags.lessons satisfies coverage", () => {
  const x = sitting();
  const rec = xrec([], [{ target: "l0003", op: "merge" }]);
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, xctx([])).problems, ["l0003 要压缩，但没有出题"]);
  x.bank.addPending(SD, "soul", [qin("那条教训说什么", { sources: ["#7"], tags: noTags({ lessons: ["l0003"] }) })]);
  assert.deepEqual(x.v.precheck!(x.stage, SD, rec, xctx([])), { problems: [], targets: [] });
});

test("pre1 I3 (REPRO-4): a bounce that names no targets leaves question intake as it was; a later one that names targets restricts it, and a bookkeeping one after that keeps the restriction", async () => {
  const r = intakeRig();
  const on = (f: string, q: string) => qin(q, { sources: ["#7"], tags: noTags({ files: [f] }) });
  r.opened.bounced!({ questionsFor: [] });
  assert.match(await r.give([on("soul/80.md", "一")]), /收下 1 道/, "只对账的退回：交题照旧");
  r.opened.bounced!({ questionsFor: ["soul/80.md"] });
  assert.match(await r.give([on("soul/90.md", "二"), on("soul/80.md", "三")]), /收下 1 道/);
  r.opened.bounced!({ questionsFor: [] });
  assert.match(await r.give([on("soul/90.md", "四")]), /收下 0 道/, "之前点名的限制还在");
});

test("pre1 M1 (REPRO-3): a supersede is not followed, nor a merge from an earlier night's batch", () => {
  const db = openDb(":memory:");
  const mem = new EvMem({ db, embedder: null, now: () => 1000, tz: "UTC" });
  const at = { day: SD, stage: "soul", attempt: 1 };
  const eOld = mem.store.createEvent({ title: "旧的安排", summary: "s", gist: "g", importance: 2 }, "seed");
  const eNew = mem.store.createEvent({ title: "新的安排", summary: "s", gist: "g", importance: 2 }, "seed");
  mem.store.addEntry({ event: eOld.id, at: "2026-10-01 10:00", full: "旧安排的细节", gist: "旧", title: "旧" }, "seed");
  mem.store.supersede(eOld.id, eNew.id, "事实变了", `sleep:${SD}/soul/1`);
  const k = mem.store.createEvent({ title: "留下的", summary: "s", gist: "g", importance: 2 }, "seed");
  const m = mem.store.createEvent({ title: "以前并掉的", summary: "s", gist: "g", importance: 2 }, "seed");
  mem.store.merge(k.id, [m.id], "以前并的", "sleep:2026-11-01/soul/1");
  const hosts = hostsFor(examFlow(), { mem, db });
  assert.deepEqual(hosts.exam!.parentsOf!(eNew.id, at), [], "supersede 不搬经过：不认");
  assert.deepEqual(hosts.exam!.parentsOf!(k.id, at), [], "以前几夜的合并：不认");
  const q = qin("旧安排是什么", { sources: ["#1"], tags: noTags({ events: [eOld.id] }) });
  assert.equal(hangsOn(q as never, eNew.id, (id) => hosts.exam!.parentsOf!(id, at)), false);
});

test("pre1 M7a: with exam.max 0 a cut is bounced with 'undo it', naming no question targets", () => {
  const x = sitting({ exam: { max: 0, min: 0 } });
  const cut: ValidateCtx = { ...xctx(["soul/80.md"]), after: snapOf({ "soul/80.md": "" }) };
  const r = x.v.precheck!(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }]), cut);
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.problems, [XP.EXAM_NO_CUTS("soul/80.md")]);
  assert.match(r.problems[0]!, /改回去/);
  assert.doesNotMatch(r.problems[0]!, /出题/);
});

test("pre1 M7b: the examiner's ids need 3+ digits, like validate.ts — t1.md and i18n/ paths are files", () => {
  assert.equal(thing("t1.md"), "t1.md");
  assert.equal(thing("i18n/zh.md:3"), "i18n/zh.md");
  assert.equal(thing("e12 小节"), "e12");
  assert.equal(thing("t0128「性格」"), "t0128");
  assert.deepEqual(changedThings(xrec(["t1.md"], [{ target: "t1.md" }, { target: "n01304（注）" }])), { files: ["t1.md"], events: ["n01304"] });
});

// ---- Batch 2 修正轮（review-pre2） ----
import { markStripper } from "../src/sleep/exam.ts";
import { S } from "../src/lang/index.ts";

test("pre2 I1: the resident view is rendered as of her next day — a detail of day D that lives only in an entry's full text is not visible, the event's gist is", () => {
  const db = openDb(":memory:");
  const mem = new EvMem({ db, embedder: null, now: () => Date.UTC(2026, 10, 5, 12), tz: "UTC" });
  const e = mem.store.createEvent({ title: "买伞的事", summary: "挑了一把伞", gist: "挑了一把伞", importance: 3 }, "seed");
  mem.store.addEntry({ event: e.id, at: "2026-11-05 18:12", full: "最后挑的是蓝色那把长柄的", gist: "挑了一把", title: "挑伞" }, "seed");
  for (const nightSleep of ["03:00", "23:30"]) {
    const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-exam-mid-"), schedule: { timezone: "UTC", nightSleep }, memory: { events: { midterm: true } } });
    const view = hostsFor(examFlow(), { mem, db, cfg }).exam!.memory!({ day: SD, state: "after", store: "live" });
    assert.doesNotMatch(view, /蓝色那把长柄的/, `${nightSleep}：经过全文里的细节，第二天的前缀里没有`);
    assert.doesNotMatch(view, /## 今天/, nightSleep);
    assert.match(view, /挑了一把伞/, `${nightSleep}：事件那一级的概要在`);
  }
});

test("pre2 M1: ignore marks are literal unless written re:…; regex marks see at most 4000 chars of a line", () => {
  const lit = markStripper(["[已标]", "(x+x+)+y"])!;
  assert.equal(lit("他已经到了"), "他已经到了", "方括号是字面的，不是字符类");
  assert.equal(lit("a[已标]b(x+x+)+y"), "ab");
  const re = markStripper(["re:\\s*✅$"])!;
  assert.equal(re("做完了 ✅"), "做完了");
  const long = `${"甲".repeat(5000)}✅`;
  assert.equal(re(long), long, "超过 4000 字的部分不喂给正则");
  const head = markStripper(["re:✅"])!;
  assert.equal(head(`✅${"乙".repeat(5000)}✅`), `${"乙".repeat(5000)}✅`, "前 4000 字照样去");
  assert.equal(markStripper([]), undefined);
});

test("pre2 M2: a memWrite stage whose before-copy failed (storeBefore live) gets no resident before sitting, like a failed preview", async () => {
  const run = async (memWrite: boolean) => {
    const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true }, host: { verdict: (phase, q) => (q === "旧的" && phase !== "before" ? "wrong" : "right") } });
    x.host.memory = (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE);
    oldQs(x.bank, [on80("旧的", { layer: "resident" })]);
    const r = await x.v.validate({ ...x.stage, memWrite }, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], "live"));
    return { x, r };
  };
  // （终审修正轮 M1 改了这一条：只跳过整理前那一场，整理后照旧把关，答错的旧题保守地照倒退算）
  const bad = await run(true);
  assert.ok(!bad.x.opened.some((s) => s.id === sid("before-resident")), "整理前那份没拷成：常驻那层的整理前不考");
  assert.equal(bad.r.pass, false);
  assert.ok(bad.r.problems.some((p) => p.startsWith("倒退：旧的") && p.includes("整理前的事件库没拷成")), bad.r.problems.join("|"));
  assert.equal(bad.x.row().examined, 1);
  const ok = await run(false);
  assert.ok(ok.x.opened.some((s) => s.id === sid("before-resident")), "不写事件库的段：现在的库就是整理前，照考");
});

test("pre2 M3: with residentMemory on and a mid-term view, the opening's ledger block is trimmed like her prefix (dropThreadTiers)", () => {
  const LEDGER = "# 账本\n\n### 最近 3 天有进展的\n- 一件事\n\n## 别的\n留着的";
  const db = openDb(":memory:");
  const mem = new EvMem({ db, embedder: null, now: () => 1000, tz: "UTC" });
  const open = (resident: boolean, midterm: boolean) => {
    const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-exam-open-"), memory: { events: { midterm } } });
    const flow = examFlow({}, { baseBlocks: ["ledger/SOUL.md", "soul/10-来历.md"], residentMemory: resident });
    return hostsFor(flow, { mem, db, cfg, readText: (p) => (p.endsWith("ledger/SOUL.md") ? LEDGER : p.endsWith("soul/10-来历.md") ? "### 最近 3 天有进展的\n不是账本，不动" : null) }).exam!.opening([]);
  };
  const trimmed = open(true, true);
  assert.doesNotMatch(trimmed, /一件事/);
  assert.match(trimmed, /留着的/);
  assert.match(trimmed, /不是账本，不动/, "只动账本那一块");
  assert.match(open(false, true), /一件事/, "residentMemory 关着：原样");
  assert.match(open(true, false), /一件事/, "她的前缀里没有中期视图：原样");
});

test("pre2 M5: a compress-labelled change on a file whose diff is empty once the ignore marks are stripped needs no question", () => {
  const ctx = twoState({ "soul/80.md": ["他说会来。\n", `他说会来${MARK}。\n`] });
  const rec = xrec(["soul/80.md"], [{ target: "soul/80.md", op: "change" }]);
  const marked = sitting({ global: { ignoreMarks: [MARK] } });
  assert.deepEqual(marked.v.precheck!(marked.stage, SD, rec, ctx), { problems: [], targets: [] });
  const plain = sitting();
  assert.deepEqual(plain.v.precheck!(plain.stage, SD, rec, ctx).problems, ["soul/80.md 要压缩，但没有出题"]);
  const real = twoState({ "soul/80.md": ["他说会来。\n", `他说不来了${MARK}。\n`] });
  assert.deepEqual(marked.v.precheck!(marked.stage, SD, rec, real).problems, ["soul/80.md 要压缩，但没有出题"], "去掉标记还有别的改动：照旧要题");
});

test("pre1 FR-m1: parentsOf reads and parses an attempt's batch once, and again only when the batch grows", () => {
  let reads = 0;
  const ops: Array<{ op: string; tbl: string; before: string | null; after: string | null }> = [
    { op: "entry_correct", tbl: "mem_entry", before: null, after: JSON.stringify({ id: "n00002", corrects: "n00001" }) },
  ];
  const mem = { store: {
    event: () => null, entry: () => undefined,
    ops: (b: string) => { reads += 1; return b === `sleep:${SD}/soul/1` ? ops : []; },
    opCount: (b: string) => (b === `sleep:${SD}/soul/1` ? ops.length : 0),
  }, index: { quote: () => null } } as unknown as EventMemory;
  const of = hostsFor(examFlow(), { mem, db: openDb(":memory:") }).exam!.parentsOf!;
  const at = { day: SD, stage: "soul", attempt: 1 };
  for (let i = 0; i < 50; i++) assert.deepEqual(of("n00002", at), ["n00001"]);
  assert.equal(reads, 1, "一次尝试的批只读一次");
  ops.push({ op: "entry_correct", tbl: "mem_entry", before: null, after: JSON.stringify({ id: "n00003", corrects: "n00002" }) });
  assert.deepEqual(of("n00003", at), ["n00002", "n00001"], "批里多了 op：重读");
  assert.equal(reads, 2);
});

// ---- 终审修正轮（final-review2） ----

test("final M1 (FINAL4-M2): memWrite + failed copy — only the resident before sitting is skipped; the after-side gates hold and a lost old resident question counts as a regression", async () => {
  const run = async (memWrite: boolean, store: string) => {
    const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true }, host: { verdict: (phase, q) => (q === "旧的" && phase !== "before" ? "wrong" : "right") } });
    x.host.memory = (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE);
    oldQs(x.bank, [on80("旧的", { layer: "resident" })]);
    const r = await x.v.validate({ ...x.stage, memWrite }, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], store));
    return { x, pass: r.pass, problems: r.problems, row: x.row() };
  };
  for (const [memWrite, store] of [[true, "live"], [false, "live"], [true, "/scratch/before.db"]] as const) {
    const r = await run(memWrite, store);
    assert.equal(r.pass, false, `${memWrite} ${store}`);
    assert.ok(r.problems.some((p) => p.startsWith("倒退：旧的")), `${memWrite} ${store}：${r.problems.join("|")}`);
    assert.equal(r.row.examined, 1, `${memWrite} ${store}`);
    assert.equal(r.row.score_after, 0, "记下的分数就是把关用的那几道");
  }
  const skipped = await run(true, "live");
  assert.ok(!skipped.x.opened.some((s) => s.id === sid("before-resident")));
  assert.equal(skipped.row.score_before, null, "没考的整理前不记分");
  assert.ok(!skipped.x.results().some((r) => r.phase === "before"), "照倒退算的那一份不进题库的结果表");
});

test("final M1: with the before view untrusted the resident newRate still applies", async () => {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true }, host: { verdict: (_phase, q) => (q === "新的" ? "wrong" : "right") } });
  x.host.memory = (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE);
  x.bank.addPending(SD, "soul", [qin("新的", { layer: "resident" })]);
  const r = await x.v.validate({ ...x.stage, memWrite: true }, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], "live"));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.includes("常驻层得分")), r.problems.join("|"));
});

// （R1 改了这一条：整理前那一场才发现预览拼不出来，只跳过常驻那层的整理前，整理后照旧把关，答错的旧题照倒退算）
test("final M1 / R1: a preview that fails only at the before sitting skips just the resident before sitting — the after-side gates hold, scores match what was gated", async () => {
  const x = sitting({ exam: { sample: 0 }, host: {
    preview: async ({ state, files }) => { if (state === "before") throw new Error("坏了"); return [...files.keys()].join("\n"); },
    verdict: (phase, q) => (q === "旧的" && phase !== "before" ? "wrong" : "right"),
  } });
  oldQs(x.bank, [on80("旧的", { layer: "resident" })]);
  x.bank.addPending(SD, "soul", [qin("常驻的", { layer: "resident" }), qin("查得到的")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith("倒退：旧的") && p.includes("坏了")), r.problems.join("|"));
  assert.ok(!x.opened.some((s) => s.id === sid("before-resident")), "常驻那层的整理前不考");
  assert.equal(x.row().examined, 1);
  assert.equal(Math.round(Number(x.row().score_after) * 100), 67, "记下的分数是把关用的三道");
  assert.equal(x.row().score_before, null, "照倒退算的那一份不记分");
});

test("final M3: with residentMemory on, the stage exam's searchable sitting gets the mid-term view too", async () => {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true } });
  x.host.memory = (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE);
  x.bank.addPending(SD, "soul", [qin("查得到的")]);
  await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.ok(x.opened.find((s) => s.id === sid("after-searchable"))!.wake.includes(MID_AFTER));
});

test("final M4: Bank.touching matches through thing() — sectioned and annotated tags, and sources", () => {
  const { bank } = mkBank();
  const ids = bank.addPending("2026-11-01", "old", [
    qin("小节标签", { isNew: false, tags: noTags({ files: ["soul/80.md「十月」"] }) }),
    qin("带注的编号", { isNew: false, tags: noTags({ events: ["n01304（注）"] }) }),
    qin("只在出处", { isNew: false, sources: ["t0128"], tags: noTags({ who: ["甲"] }) }),
    qin("行号出处", { isNew: false, sources: ["soul/80.md:3"], tags: noTags({ who: ["甲"] }) }),
    qin("不相干", { isNew: false, tags: noTags({ files: ["soul/90.md"] }) }),
  ]);
  bank.activate("2026-11-01", ["old"]);
  const got = (t: Partial<Tags>) => bank.touching(t, 10).map((q) => q.q).sort();
  assert.deepEqual(got({ files: ["soul/80.md"] }), ["只在出处", "小节标签", "行号出处"].filter((x) => x !== "只在出处").sort());
  assert.deepEqual(got({ events: ["n01304"] }), ["带注的编号"]);
  assert.deepEqual(got({ events: ["t0128"] }), ["只在出处"]);
  assert.deepEqual(got({ who: ["甲"] }).length, 2);
  assert.equal(ids.length, 5);
});

test("final M5: at the question cap a coverage bounce says undo the cut or name an existing question in affects, and names no targets", () => {
  const x = sitting({ exam: { max: 2, sample: 0 } });
  x.bank.addPending(SD, "soul", [qin("一", { tags: noTags({ files: ["soul/10-来历.md"] }) }), qin("二", { tags: noTags({ files: ["soul/10-来历.md"] }) })]);
  const r = x.v.precheck!(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }]), xctx(["soul/80.md"]));
  assert.deepEqual(r.targets, []);
  assert.deepEqual(r.problems, [XP.EXAM_FULL_CUTS("soul/80.md", 2)]);
  assert.match(r.problems[0]!, /affects/);
  assert.match(r.problems[0]!, /改回去/);
  // 没满：照旧叫它出题
  const y = sitting({ exam: { max: 3, sample: 0 } });
  y.bank.addPending(SD, "soul", [qin("一", { tags: noTags({ files: ["soul/10-来历.md"] }) })]);
  assert.deepEqual(y.v.precheck!(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md「十月」", op: "compress" }]), xctx(["soul/80.md"])).targets, ["soul/80.md"]);
});

test("final M6: an ignoreMarks entry without re: that has ASCII regex metacharacters is rejected — 要当正则用就在前面写 re:", () => {
  for (const bad of ["[已标]", "(已标)", "已标*", "a+b", "x?", "{1}", "a|b", "\\d", "^开头", "结尾$"]) {
    const e = flowErr(() => fmk([fagent("a")], { exam: { ignoreMarks: [bad] } }));
    assert.ok(e.problems.some((p) => p.includes("要当正则用就在前面写 re:")), `${bad}：${e.problems.join("|")}`);
  }
  assert.deepEqual(fmk([fagent("a")], { exam: { ignoreMarks: ["（已标）", "【已标】", "已标。", "re:[（(]已标[）)]"] } }).exam.ignoreMarks, ["（已标）", "【已标】", "已标。", "re:[（(]已标[）)]"]);
});

// ---- R1–R3（final-review2 再审）：评审的 FINAL5 探针写成测试 ----

/** 常驻那层一道今天新的（整理后答错）、查得到那层一道旧的（整理后答错；beforeRight：整理前答对） */
function final5(o: { memory: (x: { state: string }) => string; beforeRight?: boolean; store?: string; memWrite?: boolean }) {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true }, host: {
    verdict: (phase, q) => (q === "新的" ? "wrong" : q === "旧的" ? (phase === "before" && o.beforeRight ? "right" : "wrong") : "right"),
  } });
  x.host.memory = o.memory;
  oldQs(x.bank, [on80("旧的", { layer: "searchable" })]);
  x.bank.addPending(SD, "soul", [qin("新的", { layer: "resident" })]);
  const run = async () => {
    const r = await x.v.validate({ ...x.stage, memWrite: o.memWrite ?? false }, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], o.store ?? "/scratch/before.db"));
    return { pass: r.pass, problems: r.problems, examined: x.row().examined };
  };
  return { x, run };
}
const failBefore = (o: { state: string }): string => { if (o.state === "before") throw new Error("拷贝打不开"); return MID_AFTER; };

test("R1 (FINAL5-A / FINAL5-C): a mid-term render failure at the before sitting keeps the resident gates that already failed", async () => {
  for (const beforeRight of [true, false]) {
    const broken = await final5({ memory: failBefore, beforeRight }).run();
    const control = await final5({ memory: (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE), beforeRight }).run();
    for (const r of [broken, control]) {
      assert.equal(r.pass, false, JSON.stringify(r));
      assert.ok(r.problems.some((p) => p.includes("常驻层得分 0")), r.problems.join("|"));
      assert.equal(r.examined, 1);
    }
    assert.ok(!broken.problems.some((p) => p.includes("注入预览失败")));
  }
});

test("R1: a lost old resident question whose before sitting cannot be held (render failed there) counts as a regression, assumed right before", async () => {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true }, host: { verdict: (phase, q) => (q === "旧的" && phase !== "before" ? "wrong" : "right") } });
  x.host.memory = failBefore;
  oldQs(x.bank, [on80("旧的", { layer: "resident" })]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"], "/scratch/before.db"));
  assert.equal(r.pass, false);
  assert.ok(r.problems.some((p) => p.startsWith("倒退：旧的") && p.includes("拷贝打不开")), r.problems.join("|"));
  assert.ok(!x.opened.some((s) => s.id === sid("before-resident")));
  assert.equal(x.row().examined, 1);
  assert.equal(x.row().score_before, null);
});

test("R2 (FINAL5-B): a searchable-only exam whose mid-term view fails to render is recorded as examined, with no 'resident not examined' note", async () => {
  const x = sitting({ exam: { sample: 0 }, global: { residentMemory: true } });
  x.host.memory = () => { throw new Error("坏了"); };
  x.bank.addPending(SD, "soul", [qin("查得到的")]);
  const r = await x.v.validate(x.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(r.pass, true);
  assert.equal(x.row().examined, 1);
  assert.ok(!r.problems.some((p) => p.includes("常驻层没考")), r.problems.join("|"));
  // 有常驻那层的题：照旧不考常驻、记没考完
  const y = sitting({ exam: { sample: 0 }, global: { residentMemory: true } });
  y.host.memory = () => { throw new Error("坏了"); };
  y.bank.addPending(SD, "soul", [qin("常驻的", { layer: "resident" }), qin("查得到的")]);
  const ry = await y.v.validate(y.stage, SD, xrec(["soul/80.md"], [{ target: "soul/80.md" }]), xctx(["soul/80.md"]));
  assert.equal(y.row().examined, 0);
  assert.ok(ry.problems.some((p) => p.includes("中期视图拼不出来：坏了")), ry.problems.join("|"));
});

test("R3: when the before view is untrusted (memWrite, copy failed), the searchable before sitting gets the live view — the same store its search tools read", async () => {
  const { x, run } = final5({ memory: (o) => (o.state === "after" ? MID_AFTER : MID_BEFORE), beforeRight: true, store: "live", memWrite: true });
  await run();
  const before = x.opened.find((s) => s.id === sid("before-searchable"))!;
  assert.ok(before.wake.includes(MID_AFTER), "跟它的查找工具读的同一个库（现在的库）");
  assert.equal(before.store, "live");
  assert.ok(x.opened.find((s) => s.id === sid("after-searchable"))!.wake.includes(MID_AFTER));
});
