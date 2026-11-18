// 夜里整理的多人模式（第 3 份 B）：不同性格的她做、交叉审、换人修，前额叶协调；各段挂在脑区上，记账、报告写谁做谁审、怎么定、各花多少。
// 没写 personasFile / coordinator 的流程：跟第 1、2 份一字不差。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import { FakeDriver } from "../src/kernel/fake.ts";
import { Logger } from "../src/log.ts";
import { loadConfig } from "../src/config.ts";
import * as P from "../src/lang/zh/prompts.ts";
import { parseFlow, parsePersonas, personaProblems, FlowError, type FlowConfig, type Personas } from "../src/sleep/flow.ts";

// the night's text here is asserted in Chinese, the pack it was written against
setLang("zh");
import { Budget } from "../src/sleep/budget.ts";
import { SleepRunner, type StageHost } from "../src/sleep/runner.ts";
import type { MiniFs, StageRecord, Change } from "../src/sleep/record.ts";
import type { StageDone, ReviewDone, AuditDone, CoordinateIn } from "../src/sleep/tools.ts";
import { auditValidator, type AuditHost, type StageValidator } from "../src/sleep/validate.ts";
import { reviewValidator, pickReviewer, pickFixer, type ReviewHost } from "../src/sleep/review.ts";
import { Coordinator, ruled, teamParts, type CoordHost, type CoordinatorLike } from "../src/sleep/coordinator.ts";
import { nightHosts, readNight, sleepWeights, type NightBrain } from "../src/sleep/host.ts";
import { languageLine } from "../src/persona/persona.ts";
import { openDb, all, MIGRATIONS, type Db } from "../src/store/db.ts";

const known = { tools: new Set(["mem_write", "note"]), builtins: new Set(["apply"]), memWriters: new Set(["mem_write"]) };
const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "agent", skill: `${id}.md`, ...extra });
const script = (id: string, command: string[], extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "script", command, ...extra });
const mk = (stages: unknown[], extra: Record<string, unknown> = {}) => parseFlow({ stages, ...extra }, known);
const problemsOf = (f: () => unknown): string[] => { try { f(); return []; } catch (e) { return (e as FlowError).problems; } };

const PS: Personas = {
  a: { name: "阿甲", text: "细心的那个你，先把原话对清楚" },
  b: { name: "阿乙", text: "挑剔的那个你，看哪里写虚了" },
  c: { name: "阿丙", text: "爱讲故事的那个你，看前后连不连得上" },
};
const D = "2026-11-06";
const root = `sleep/${D}/proposed`;
const USAGE = { calls: 1, input: 100, cacheRead: 1000, cacheWrite: 0, output: 10, maxCtx: 5000 }; // opus：250 单位

/** prepare → people（海马，阿甲做）→ finish；team = 全局多人的那几个键 */
const teamFlow = (team: Record<string, unknown> = { personasFile: "personas.json" }, people: Record<string, unknown> = {}) => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("people", { after: ["prepare"], writes: ["memory/people/**"], ...(team.personasFile ? { persona: "a" } : {}), region: "海马", ...people }),
  script("finish", ["finish", "{day}", "{partial}"], { after: ["people"] }),
], team);
const plainFlow = () => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("people", { after: ["prepare"], writes: ["memory/people/**"] }),
  script("finish", ["finish", "{day}", "{partial}"], { after: ["people"] }),
]);

function memFs(init: Record<string, string> = {}): MiniFs & { files: Map<string, string> } {
  const files = new Map(Object.entries(init));
  return {
    files,
    read: (p) => files.get(p) ?? null,
    write: (p, s) => void files.set(p, s),
    remove: (p) => void files.delete(p),
    isDir: (p) => [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    list: (dir) => [...new Set([...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1).split("/")[0]!))],
  };
}
const chg = (target: string): Change => ({ target, op: "change", before: "a", after: "b", evidence: ["e0001「原话」"], why: "因为" });

interface Ctx { n: number; text: string; write(p: string, s: string): void; done(o?: Partial<StageDone>): void; end(ok?: boolean): void }
type Act = (c: Ctx) => void;
/** 写这些提案、交 stage_done、这一轮结束 */
const pass = (files: Record<string, string> = {}, extra: Partial<StageDone> = {}): Act => (c) => {
  for (const [p, s] of Object.entries(files)) c.write(p, s);
  c.done({ changes: Object.keys(files).map(chg), ...extra });
  c.end(true);
};
const edit: Act = (c) => pass({ "memory/people/x.md": `第 ${c.n} 次` })(c);

/** 段的会话是假的：照 acts 演；记下开了哪些会话、每个会话收到的话 */
function nightHost(acts: Act[] = [edit]) {
  const opened: string[] = [];
  const wakes: Record<string, string[]> = {};
  const log: string[] = [];
  const fs = memFs();
  const db = openDb(":memory:");
  let k = 0;
  const host: StageHost = {
    flowHash: "h", prefix: "P",
    open(x) {
      k += 1;
      const n = k;
      opened.push(x.id);
      const ws: string[] = [];
      wakes[x.id] = ws;
      let onDone: (d: StageDone) => string = () => "";
      let onEnd: (ok: boolean, e?: string, u?: typeof USAGE) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise((r) => { settle = r; });
      let closed = false;
      const act = acts[n - 1] ?? acts[acts.length - 1]!;
      return {
        id: x.id, settled,
        wake(t: string) {
          if (closed) return;
          ws.push(t);
          const c: Ctx = {
            n, text: t, write: (p, s) => fs.write(`${root}/${p}`, s),
            done: (d = {}) => { onDone({ status: "done", changes: [], report: `第 ${n} 次的报告`, uncertain: [], proposals: [], bugs: [], ...d }); },
            end: (ok = true) => onEnd(ok),
          };
          queueMicrotask(() => act(c));
        },
        onTurnEnd(fn: typeof onEnd) { onEnd = fn; },
        onDone(fn: typeof onDone) { onDone = fn; },
        async close() { if (closed) return; closed = true; settle({ how: "ok", turns: ws.length, usage: { ...USAGE } }); },
      } as never;
    },
    async run(argv) { log.push(argv.join(" ")); return { code: 0, out: "" }; },
    fs, mem: null, db,
    skillText: (s) => `skill 页 ${s.skill}\n## 审的时候看什么\n人物卡的原话要对得上`,
    materialText: () => "材料",
    now: () => 1000,
    later: () => () => {},
    log: new Logger("t", () => {}),
  };
  return { host, opened, wakes, log, fs, db };
}
const bigBudget = () => new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
const runnerFor = (h: ReturnType<typeof nightHost>, flow: FlowConfig, o: Partial<ConstructorParameters<typeof SleepRunner>[2]> = {}) =>
  new SleepRunner(h.host, flow, { validators: [], budget: bigBudget(), watchdogMs: 5 * 3600_000, maxDays: Infinity, ...o });
const once = (d: string) => { let used = false; return async () => (used ? null : (used = true, d)); };
const rows = (db: Db) => all<{ stage: string; attempt: number; status: string; region: string | null; persona: string | null; reviewer: string | null; decision: string | null; cost: string | null; units: number | null }>(
  db, "SELECT stage, attempt, status, region, persona, reviewer, decision, cost, units FROM sleep_stage WHERE stage = 'people' ORDER BY id");

/** 假的段外会话（核依据 / 交叉审）：按开的先后照 acts 演 */
type SideAct = (s: { wakes: string[]; answer(x: unknown): string; turnEnd(ok: boolean): void; settle(how: string): void }) => void;
function sideHost(acts: SideAct[]) {
  const opened: Array<{ id: string; model: string; allowed: string[] }> = [];
  const wakesAll: string[][] = [];
  const open = (o: { id: string; model: string; allowed: string[] }) => {
    opened.push(o);
    const act = acts[opened.length - 1] ?? acts[acts.length - 1]!;
    const wakes: string[] = []; wakesAll.push(wakes);
    let on: (x: unknown) => string = () => ""; let onEnd: (ok: boolean) => void = () => {};
    let settle!: (v: unknown) => void;
    const settled = new Promise<unknown>((r) => { settle = r; });
    return {
      id: o.id, settled,
      wake(t: string) { wakes.push(t); queueMicrotask(() => act({ wakes, answer: (x) => on(x), turnEnd: (ok) => onEnd(ok), settle: (how) => settle({ how, turns: 1, usage: {} }) })); },
      onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
      onAudit(fn: (a: AuditDone) => string) { on = fn as never; },
      onReview(fn: (r: ReviewDone) => string) { on = fn as never; },
      async close() { settle({ how: "ok", turns: 1, usage: {} }); },
    } as never;
  };
  const host: AuditHost & ReviewHost = { open, read: () => null, page: (s) => `skill 页 ${s.skill}\n## 审的时候看什么\n人物卡的原话要对得上` };
  return { host, opened, wakesAll };
}
const said = (verdict: "pass" | "redo", problems: ReviewDone["problems"] = []): SideAct => (s) => { s.answer({ verdict, problems }); s.turnEnd(true); };
const RV = (h: ReturnType<typeof sideHost>) => reviewValidator(h.host, { model: "sonnet", personas: PS });

/** 假的前额叶：照 answers 一份一份回（Error 就抛） */
function fakeCoord(answers: Array<CoordinateIn | null | Error>, onAsk?: (brief: string) => void): CoordinatorLike & { briefs: string[]; closed: number } {
  const c = {
    briefs: [] as string[], closed: 0,
    async decide(b: string) {
      c.briefs.push(b);
      onAsk?.(b);
      const a = answers[c.briefs.length - 1] ?? answers[answers.length - 1] ?? null;
      if (a instanceof Error) throw a;
      return a;
    },
    async close() { c.closed += 1; },
  };
  return c;
}
const coordSays = (decision: CoordinateIn["decision"], why = "", notes: string[] = []): CoordinateIn => ({ decision, why, notes });
const verdicts = (list: Array<{ pass: boolean; problems: string[] }>, calls?: string[]): StageValidator => ({
  name: "fake",
  async validate(stage, _day, rec) { calls?.push(`${stage.id}:${rec.attempt}`); return list[rec.attempt - 1] ?? list[list.length - 1] ?? { pass: true, problems: [] }; },
});

// ---------- 配置 ----------

test("team: personas parse and validate", () => {
  assert.deepEqual(parsePersonas({ a: { name: "甲", text: "说明" }, b: { name: " 乙 ", text: "说明二" } }), { personas: { a: { name: "甲", text: "说明" }, b: { name: "乙", text: "说明二" } }, problems: [] });
  assert.match(parsePersonas({ a: { name: "甲", text: "说明" } }).problems[0]!, /至少要两个/);
  assert.match(parsePersonas({ a: { name: "甲" }, b: { name: "乙", text: "x" } }).problems[0]!, /persona a/);
  assert.match(parsePersonas([1]).problems[0]!, /不是一个对象/);

  const f = teamFlow({ personasFile: "personas.json", maxFixRounds: 1, reviewModel: "haiku", coordinator: { model: "sonnet" } }, { reviewers: ["b"], fixers: ["c", "b"] });
  assert.equal(f.personasFile, "personas.json");
  assert.equal(f.maxFixRounds, 1, "能配到 1");
  assert.equal(f.reviewModel, "haiku");
  assert.deepEqual(f.coordinator, { model: "sonnet" });
  const s = f.stages[1]!;
  assert.deepEqual([s.region, s.persona, s.reviewers, s.fixers], ["海马", "a", ["b"], ["c", "b"]]);
  assert.deepEqual(personaProblems(f, PS), []);
  assert.match(personaProblems(teamFlow(undefined, { reviewers: ["zz"] }), PS)[0]!, /「zz」在 personas 里没有/);
  assert.match(personaProblems(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet", persona: "q" } }), PS)[0]!, /coordinator 的 persona「q」/);

  const p = (stages: unknown[], extra: Record<string, unknown>) => problemsOf(() => mk(stages, extra)).join("|");
  assert.match(p([agent("x", { persona: "a", reviewers: ["a", "b"] })], { personasFile: "p.json" }), /自己不审自己/);
  assert.match(p([agent("x")], { personasFile: "p.json" }), /得写 persona/);
  assert.match(p([agent("x", { persona: "a" })], {}), /没写 personasFile/);
  assert.match(p([agent("x", { persona: "a" })], { personasFile: "../p.json" }), /personasFile 取值不对/);
  assert.match(p([agent("x", { persona: "a" })], { personasFile: "p.json", maxFixRounds: -1 }), /maxFixRounds/);
  assert.match(p([agent("x", { persona: "a" })], { personasFile: "p.json", coordinator: { model: "gpt" } }), /coordinator 取值不对/);
});

test("team: no personasFile — the parsed flow has no new keys, so its JSON and hash are what plan 1/2 gave", () => {
  const f = plainFlow();
  for (const k of ["personasFile", "maxFixRounds", "reviewModel", "coordinator"]) assert.ok(!(k in f), k);
  for (const s of f.stages) for (const k of ["region", "persona", "reviewers", "fixers"]) assert.ok(!(k in s), `${s.id}.${k}`);
  // region 不靠 personas 也能写（只是标签）
  assert.equal(mk([agent("x", { region: "海马" })]).stages[0]!.region, "海马");
});

test("team: readNight reads personas next to flow.json; missing or invalid means the legacy night with the reason", () => {
  const W = "/ws";
  const cfg = loadConfig({ workspace: W, stateDir: tmpDir("hh-team-read-") });
  const flow = (extra: Record<string, unknown>) => JSON.stringify({
    engine: "flow",
    stages: [agent("people", { persona: "a", writes: ["memory/**"] }), script("finish", ["finish"], { after: ["people"] })], ...extra,
  });
  const files = (f: string, personas?: string): Map<string, string> => new Map([
    [`${W}/scripts/sleep_flow/flow.json`, f], [`${W}/SOUL.md`, "SOUL"], [`${W}/scripts/sleep_flow/common.md`, "COMMON"],
    [`${W}/scripts/sleep_flow/people.md`, "页"], ...(personas !== undefined ? [[`${W}/scripts/sleep_flow/personas.json`, personas] as [string, string]] : []),
  ]);
  const read = (m: Map<string, string>) => readNight({ cfg, read: (p) => m.get(p) ?? null, write: () => {} });

  const missing = read(files(flow({ personasFile: "personas.json" })));
  assert.equal(missing.plan, null);
  assert.ok(!missing.plan && !missing.quiet && /没有 scripts\/sleep_flow\/personas\.json/.test(missing.why));
  const bad = read(files(flow({ personasFile: "personas.json" }), "{坏的"));
  assert.ok(!bad.plan && /不是合法的 JSON/.test(bad.why));
  const unknown = read(files(flow({ personasFile: "personas.json" }), JSON.stringify({ b: PS.b, c: PS.c })));
  assert.ok(!unknown.plan && unknown.problems.some((x) => /「a」在 personas 里没有/.test(x)));

  const ok = read(files(flow({ personasFile: "personas.json" }), JSON.stringify(PS)));
  assert.ok(ok.plan);
  assert.deepEqual(ok.plan.personas, PS);

  // 不是多人模式：plan 里没有 personas，哈希只算流程（跟以前一样）
  const plain = JSON.stringify({ engine: "flow", stages: [agent("people", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["people"] })] });
  const before = read(files(plain));
  assert.ok(before.plan && !("personas" in before.plan));
  const parsed = parseFlow(JSON.parse(plain), { tools: new Set(), builtins: new Set(), memWriters: new Set() });
  assert.equal(before.plan.hash, createHash("sha256").update(JSON.stringify(parsed)).digest("hex").slice(0, 16));
});

test("readNight: the night stages' prefix (soul + common) ends with the same language line as the runtime note; none when language is empty or not a string (final-review F-5)", () => {
  const W = "/ws";
  const plain = JSON.stringify({ engine: "flow", stages: [agent("people", { writes: ["memory/**"] }), script("finish", ["finish"], { after: ["people"] })] });
  const files = new Map([[`${W}/scripts/sleep_flow/flow.json`, plain], [`${W}/SOUL.md`, "SOUL\n"], [`${W}/scripts/sleep_flow/common.md`, "COMMON\n"], [`${W}/scripts/sleep_flow/people.md`, "页"]]);
  const prefixWith = (language: unknown) => {
    const r = readNight({ cfg: loadConfig({ workspace: W, stateDir: tmpDir("hh-night-lang-"), writingLanguage: language }), read: (p) => files.get(p) ?? null, write: () => {} });
    assert.ok(r.plan, JSON.stringify(language));
    return r.plan.prefix;
  };
  assert.equal(prefixWith("X语"), `SOUL\n\nCOMMON\n\n${languageLine("X语")}`);
  for (const language of ["", null, 7]) assert.equal(prefixWith(language), "SOUL\n\nCOMMON", JSON.stringify(language));
});

// ---------- 谁审、谁修 ----------

test("team: the reviewer is never the doer and rotates by attempt; the fixer is never the previous doer", () => {
  const s = teamFlow().stages[1]!;   // 阿甲做，reviewers 默认 b、c
  assert.equal(pickReviewer(s, PS, "a", 1), "b");
  assert.equal(pickReviewer(s, PS, "a", 2), "c", "第 2 次转到下一个");
  assert.equal(pickReviewer(s, PS, "b", 1), "c", "修的人是 b：跳过 b");
  for (const doer of ["a", "b", "c"]) for (const n of [1, 2, 3, 4]) assert.notEqual(pickReviewer(s, PS, doer, n), doer);
  const only = teamFlow(undefined, { reviewers: ["b"] }).stages[1]!;
  assert.equal(pickReviewer(only, PS, "b", 2), "a", "名单里只剩修的人：找段本来那个做的人");
  assert.equal(pickFixer(s, PS, "a", 1), "b");
  assert.equal(pickFixer(s, PS, "b", 2), "c");
  assert.equal(pickFixer(teamFlow(undefined, { fixers: ["a"] }).stages[1]!, PS, "a", 1), "b", "fixers 里只有上一次做的：换别人");
});

test("team: review validator opens a fresh review- session with the reviewer's preamble, the page, the record and the diff", async () => {
  const st = teamFlow().stages[1]!;
  const rec: StageRecord = {
    day: D, stage: "people", attempt: 1, status: "done", changes: [chg("memory/people/x.md")], report: "改了人物卡", uncertain: ["拿不准"], proposals: [], bugs: [],
    actual: { files: [{ path: "memory/people/x.md", op: "change" }], memOps: 0 },
  };
  const ok = sideHost([said("pass")]);
  assert.deepEqual(await RV(ok).validate(st, D, rec, { before: new Map(), after: new Map(), material: "", storeBefore: "live", doer: "a" }), { pass: true, problems: [], by: "b" });
  assert.deepEqual(ok.opened[0], { id: `review-${D}-people-1-1`, model: "sonnet", allowed: ["recall", "recall_event", "review_done"] });
  const w = ok.wakesAll[0]![0]!;
  assert.ok(w.startsWith(`这一段由阿乙来审：${PS.b!.text}`));
  assert.match(w, /## 审的时候看什么\n人物卡的原话要对得上/);
  assert.match(w, /阿甲做的/);
  assert.match(w, /改了人物卡/);
  assert.match(w, /=== memory\/people\/x\.md（change）===/);
  assert.match(w, /review_done/);

  const redo = sideHost([said("redo", [{ what: "原话不对", change: "memory/people/x.md", fix: "换成 11-06 那句" }])]);
  assert.deepEqual(await RV(redo).validate(st, D, rec), { pass: false, problems: ["原话不对（memory/people/x.md）；该怎么改：换成 11-06 那句"], by: "b" });

  // 没交催一次；两次都坏了：照过，但说没审
  const dead = sideHost([(s) => s.turnEnd(true), (s) => s.settle("timeout")]);
  assert.deepEqual(await RV(dead).validate(st, D, rec), { pass: true, problems: [S.review.notReviewed], by: "b" });
  assert.equal(dead.wakesAll[0]![1], P.SLEEP_REVIEW_NUDGE);
  assert.deepEqual(dead.opened.map((x) => x.id), [`review-${D}-people-1-1`, `review-${D}-people-1-2`]);
});

// ---------- host：工具清单、记账 ----------

function hostsFor(flow: FlowConfig, personas: Personas | undefined, driver: FakeDriver, charged: Array<[string, number]> = []) {
  const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-team-hosts-") });
  const fs: MiniFs = { read: () => null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const b: NightBrain = {
    cfg, driver, db: openDb(":memory:"), log: new Logger("t", () => {}), mem: null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => "页", now: () => 1000, later: () => () => {},
    hhTools: () => [],
  };
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const hosts = nightHosts(b, { flow, prefix: "P", hash: "h", ...(personas ? { personas } : {}) }, { budget, weights: sleepWeights(undefined), auditMs: 60_000, charge: (id, u) => charged.push([id, u]) });
  return { hosts, budget };
}

const toolNames = (flow: FlowConfig, personas?: Personas) => {
  const driver = new FakeDriver();
  const { hosts } = hostsFor(flow, personas, driver);
  hosts.stage.open({ id: `sleep-${D}-people-1`, stage: flow.stages[1]!, day: D, allowed: new Set(["stage_done"]) }).wake("开始");
  return { tools: driver.sessions[0]!.spec.tools.map((t) => t.name), hosts };
};

test("team: review_done joins every session's tools only on persona nights; the plain night's list is unchanged", () => {
  const plain = toolNames(plainFlow());
  assert.deepEqual(plain.tools, ["stage_done", "audit_done"]);
  assert.equal(plain.hosts.review, null);
  const team = toolNames(teamFlow(), PS);
  assert.deepEqual(team.tools, ["stage_done", "audit_done", "review_done"]);
  assert.ok(team.hosts.review);
});

// ---------- 换人修 ----------

test("team: a review redo makes a different persona fix it in a new session with the problems", async () => {
  const h = nightHost();
  const rv = sideHost([said("redo", [{ what: "原话不对", fix: "换成那句" }]), said("pass")]);
  const r = await runnerFor(h, teamFlow(), { validators: [RV(rv)], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(h.opened, [`sleep-${D}-people-1`, `sleep-${D}-people-2`], "修的那一次是新会话");
  const w1 = h.wakes[`sleep-${D}-people-1`]![0]!;
  const w2 = h.wakes[`sleep-${D}-people-2`]![0]!;
  assert.ok(w1.startsWith(`这一段由阿甲来做：${PS.a!.text}`), "叫醒的话最前面是谁来做（不进开头）");
  assert.ok(w2.startsWith(`这一段由阿乙来做：${PS.b!.text}`), "换了一个她");
  assert.match(w2, /上一次是阿甲做的，这次由你来修，不要整份重写，照问题改/);
  assert.match(w2, /- 原话不对；该怎么改：换成那句/);
  assert.match(w2, /\+ 第 1 次/, "带着上一次的 diff（它已经撤回了）");
  assert.deepEqual(rv.opened.map((x) => x.id), [`review-${D}-people-1-1`, `review-${D}-people-2-1`]);
  assert.match(rv.wakesAll[1]![0]!, /^这一段由阿丙来审/, "第 2 次修的是阿乙，审的换成阿丙");
  assert.deepEqual(rows(h.db).map((x) => [x.attempt, x.status, x.region, x.persona, x.reviewer, x.decision]), [
    [1, "redo", "海马", "a", "b", "rule:redo"],
    [2, "passed", "海马", "b", "c", "rule:pass"],
  ]);
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.match(report, /- people（海马）：过了（2 次/);
  assert.match(report, /## 谁做的、谁审的\n### people（海马）\n- 第 1 次：阿甲做，阿乙审；没过：原话不对；该怎么改：换成那句；定：重做（规矩）\n- 第 2 次：阿乙修，阿丙审；过了；定：过（规矩）/);
});

test("team: failed fix rounds lead to defer — maxFixRounds 1 gives two tries, 2 gives three, each by someone new", async () => {
  const fail = verdicts([{ pass: false, problems: ["不对"] }]);
  const one = nightHost();
  await runnerFor(one, teamFlow({ personasFile: "p.json", maxFixRounds: 1 }), { validators: [fail], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(one.db).map((x) => [x.status, x.persona]), [["redo", "a"], ["deferred", "b"]]);
  assert.match(one.fs.read(`sleep/${D}/report.md`)!, /- people（海马）：推迟了（2 次/);

  const two = nightHost();
  await runnerFor(two, teamFlow(), { validators: [fail], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(two.db).map((x) => [x.status, x.persona]), [["redo", "a"], ["redo", "b"], ["deferred", "c"]]);
  assert.match(two.wakes[`sleep-${D}-people-3`]![0]!, /上一次是阿乙做的，这次由你来修/);
  assert.ok(two.fs.read(`sleep/${D}/deferred/people/memory/people/x.md`), "最后一次的提案抄到 deferred/");

  // required 的段：三次都没过，这一天不落地
  const req = nightHost();
  const r = await runnerFor(req, teamFlow(undefined, { required: true }), { validators: [fail], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.deferredDays, [D]);
  assert.match(req.fs.read(`sleep/${D}/report.md`)!, /people 段 3 次都没过/);
});

// ---------- 前额叶 ----------

test("team: the coordinator cannot pass over a failed validator — its pass counts as redo", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("pass", "看着还行"), coordSays("pass", "好了", ["人物卡今晚改得细"])]);
  const r = await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), {
    validators: [verdicts([{ pass: false, problems: ["原话不对"] }, { pass: true, problems: [] }])], personas: PS, coordinator: coord,
  }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.landed, [D]);
  assert.equal(coord.briefs.length, 2);
  assert.match(coord.briefs[0]!, /【简报】2026-11-06「people」（海马）第 1 次，阿甲做的；还能重做 2 轮/);
  assert.match(coord.briefs[0]!, /- 机械检查：过了\n- fake：没过：原话不对/);
  assert.match(coord.briefs[1]!, /第 2 次，阿乙做的；还能重做 1 轮/);
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["redo", "coord:redo"], ["passed", "coord:pass"]]);
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.match(report, /前额叶想让「people」过，但有验证没过，按重做算/);
  assert.match(report, /前额叶（people）：人物卡今晚改得细/, "notes 进报告最上面");
  assert.match(h.wakes[`sleep-${D}-people-2`]![0]!, /- 前额叶：看着还行/);
  assert.equal(coord.closed, 1, "一夜完了关掉它的会话");
});

test("team: a coordinator redo on an all-pass attempt hands its why to the fixer; it cannot defer a passed stage", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("redo", "人物卡漏了 11-06 那句")]);
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  // 修正第 1 轮：都过了的重做 = 这一次照样提交，再让另一个你在它上面修一次（keep，不问前额叶）
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.persona, x.decision]), [["passed", "a", "coord:polish"], ["passed", "b", "rule:pass"]]);
  assert.match(h.wakes[`sleep-${D}-people-2`]![0]!, /- 前额叶：人物卡漏了 11-06 那句/);
  const h2 = nightHost();
  await runnerFor(h2, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("defer", "算了")]) })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h2.db).map((x) => [x.status, x.decision]), [["passed", "coord:pass"]]);
  assert.match(h2.fs.read(`sleep/${D}/report.md`)!, /前额叶要推迟「people」，但验证都过了，不能推迟，照过/);

  // redo 没写为什么：照过；没轮数了的 redo：照过
  assert.deepEqual(ruled({ title: "t", failed: false, left: 2, problems: [], answer: coordSays("redo", " ") }).decision, "pass");
  assert.deepEqual(ruled({ title: "t", failed: false, left: 0, problems: [], answer: coordSays("redo", "再改改") }).decision, "pass");
  // 有验证没过：defer 照收；redo 没轮数了就是 defer
  assert.equal(ruled({ title: "t", failed: true, left: 2, problems: ["x"], answer: coordSays("defer", "今晚不值得") }).decision, "defer");
  assert.equal(ruled({ title: "t", failed: true, left: 0, problems: ["x"], answer: coordSays("redo", "再来") }).decision, "defer");
});

test("team: a coordinator defer on a failed attempt stops the fix rounds early", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("defer", "材料不够，修不好")]);
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([{ pass: false, problems: ["不对"] }])], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["deferred", "coord:defer"]]);
  assert.ok(h.fs.read(`sleep/${D}/deferred/people/memory/people/x.md`));
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /- people（海马）：推迟了（1 次.*不对；前额叶：材料不够，修不好/);
});

test("team: a coordinator failure falls back to the rules with a note on top", async () => {
  for (const silent of [null, new Error("会话挂了")]) {
    const h = nightHost();
    const coord = fakeCoord([silent]);
    await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), {
      validators: [verdicts([{ pass: false, problems: ["不对"] }, { pass: true, problems: [] }])], personas: PS, coordinator: coord,
    }).runNight({ night: "n", pending: once(D) });
    assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["redo", "rule:redo"], ["passed", "rule:pass"]]);
    const report = h.fs.read(`sleep/${D}/report.md`)!;
    assert.ok(report.split("## 记账")[0]!.includes(S.coordinator.silent));
  }
});

/** 假的前额叶会话：answer 交 coordinate；turnEnd 结束一轮 */
function coordHost(act: (s: { wake: string; n: number; answer(c: CoordinateIn): string; turnEnd(ok: boolean): void }) => void) {
  const opened: string[] = [];
  const wakes: string[][] = [];
  const closed: string[] = [];
  const host: CoordHost = {
    open(o) {
      opened.push(o.id);
      const ws: string[] = []; wakes.push(ws);
      let on: (c: CoordinateIn) => string = () => ""; let onEnd: (ok: boolean) => void = () => {};
      let settle!: (v: unknown) => void;
      const settled = new Promise<unknown>((r) => { settle = r; });
      return {
        id: o.id, settled,
        wake(t: string) { ws.push(t); queueMicrotask(() => act({ wake: t, n: ws.length, answer: (c) => on(c), turnEnd: (ok) => onEnd(ok) })); },
        onTurnEnd(fn: (ok: boolean) => void) { onEnd = fn; },
        onCoordinate(fn: (c: CoordinateIn) => string) { on = fn; },
        async close() { closed.push(o.id); settle({ how: "ok", turns: 1, usage: {} }); },
      } as never;
    },
  };
  return { host, opened, wakes, closed };
}
const coordOpts = (timers: Array<() => void> = []) => ({
  id: "coord-2026-11-07", model: "sonnet", nightMs: 5 * 3600_000, turnMs: 60_000, role: P.SLEEP_COORD_ROLE(null),
  later: (fn: () => void) => { timers.push(fn); return () => {}; }, log: new Logger("t", () => {}),
});

test("team: the coordinator is one session for the night; no answer after a nudge, or a timeout, gives null and the next brief reopens", async () => {
  const ok = coordHost((s) => { s.answer(coordSays(s.n === 1 ? "pass" : "redo", "因为")); s.turnEnd(true); });
  const c = new Coordinator(ok.host, coordOpts());
  assert.deepEqual(await c.decide("简报一"), coordSays("pass", "因为"));
  assert.deepEqual(await c.decide("简报二"), coordSays("redo", "因为"));
  assert.deepEqual(ok.opened, ["coord-2026-11-07"], "一夜一个会话");
  assert.ok(ok.wakes[0]![0]!.startsWith("这一夜由你来协调，你是前额叶。") && ok.wakes[0]![0]!.endsWith("简报一"));
  assert.equal(ok.wakes[0]![1], "简报二", "后面的简报不再带说明");
  await c.close();
  assert.deepEqual(ok.closed, ["coord-2026-11-07"]);
  assert.equal(await c.decide("关了以后"), null);

  const mute = coordHost((s) => s.turnEnd(true));
  const m = new Coordinator(mute.host, coordOpts());
  assert.equal(await m.decide("简报"), null);
  assert.deepEqual(mute.wakes[0]!.slice(1), [P.SLEEP_COORD_NUDGE], "没交催一次");

  const timers: Array<() => void> = [];
  const stuck = coordHost(() => {});
  const t = new Coordinator(stuck.host, coordOpts(timers));
  const pending = t.decide("简报");
  await new Promise((r) => setImmediate(r));
  timers[0]!();
  assert.equal(await pending, null);
  assert.deepEqual(stuck.closed, ["coord-2026-11-07"], "卡住的会话关掉");
  void t.decide("下一份");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(stuck.opened, ["coord-2026-11-07", "coord-2026-11-07-2"], "下一份重开一个");
});

// ---------- 没改东西不验 ----------

test("team: a stage that changed nothing opens no audit, review or exam session and the coordinator is not woken", async () => {
  const h = nightHost([pass({}, { status: "nothing" })]);
  const au = sideHost([(s) => { s.answer({ verdict: "pass", problems: [] }); s.turnEnd(true); }]);
  const rv = sideHost([said("pass")]);
  const exams: string[] = [];
  const coord = fakeCoord([coordSays("pass", "")]);
  const r = await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), {
    validators: [auditValidator(au.host, { model: "opus", timeoutMs: 1000 }), RV(rv), verdicts([], exams)], personas: PS, coordinator: coord,
  }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual([au.opened.length, rv.opened.length, exams.length, coord.briefs.length], [0, 0, 0, 0]);
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["passed", "rule:pass"]]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /第 1 次：阿甲做，没改东西，没请人审；过了/);

  // 说 nothing 却真改了文件：照常验
  const sneaky = nightHost([pass({ "memory/people/x.md": "偷偷改" }, { status: "nothing" })]);
  const calls: string[] = [];
  await runnerFor(sneaky, teamFlow(), { validators: [verdicts([], calls)], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(calls, ["people:1"]);
});

// ---------- 没写 personasFile / coordinator：照旧 ----------

test("team: no personasFile and no coordinator — plan-1/2 behavior is identical (two tries, no preamble, no new columns or report lines, unchanged stages still validated)", async () => {
  const h = nightHost([pass({}), edit]);
  const calls: string[] = [];
  const r = await runnerFor(h, plainFlow(), { validators: [verdicts([{ pass: false, problems: ["不对"] }, { pass: true, problems: [] }], calls)] }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(calls, ["people:1", "people:2"], "没改东西的那次照样请验证器");
  const w1 = h.wakes[`sleep-${D}-people-1`]![0]!;
  const w2 = h.wakes[`sleep-${D}-people-2`]![0]!;
  assert.ok(w1.startsWith("【夜里整理·这一段】"));
  assert.ok(w2.startsWith(P.SLEEP_STAGE_REDO(["不对"])), "重做的话跟以前一样");
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.region, x.persona, x.reviewer, x.decision, x.cost]), [["redo", null, null, null, null, null], ["passed", null, null, null, null, null]]);
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.doesNotMatch(report, /谁做的|花费：做/);
  assert.match(report, /- people：过了（2 次，500 单位）/);

  const fail = nightHost();
  await runnerFor(fail, plainFlow(), { validators: [verdicts([{ pass: false, problems: ["不对"] }])] }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(fail.db).map((x) => x.status), ["redo", "deferred"], "照旧一共两次");
});

// ---------- 花费 ----------

test("team: side sessions are charged to their stage and attempt — report line 做 / 审 / 核 / 考 / 协调 and the ledger's cost", async () => {
  const h = nightHost();
  const box: { r: SleepRunner | null } = { r: null };
  const charging: StageValidator = {
    name: "fake",
    async validate(stage, day, rec) {
      box.r!.charge(`audit-${day}-${stage.id}-${rec.attempt}-1`, 40);
      box.r!.charge(`review-${day}-${stage.id}-${rec.attempt}-1`, 30);
      box.r!.charge(`exam-${day}-${stage.id}-${rec.attempt}-after-resident`, 20);
      box.r!.charge(`exam-${day}-final-after-resident`, 7);
      box.r!.charge("someone-else", 99);
      return { pass: true, problems: [] };
    },
  };
  const coord = fakeCoord([coordSays("pass", "")], () => box.r!.charge("coord-n", 10));
  box.r = runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [charging], personas: PS, coordinator: coord });
  await box.r.runNight({ night: "n", pending: once(D) });
  assert.deepEqual(JSON.parse(rows(h.db)[0]!.cost!), { do: 250, review: 30, audit: 40, exam: 20, coord: 10 });
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.match(report, /- 花费：做 250 \/ 审 30 \/ 核 40 \/ 考 20 \/ 协调 10/);
  assert.match(report, /- 不归哪一段的（全天考试）：做 0 \/ 审 0 \/ 核 0 \/ 考 7 \/ 协调 0/);

  // 段名带 - 的也认得出（按最长的段名对）
  const f = mk([agent("a", { persona: "a" }), agent("a-b", { persona: "a" })], { personasFile: "p.json" });
  const hh = nightHost();
  const rr = runnerFor(hh, f, { personas: PS });
  rr.charge(`audit-${D}-a-b-2-1`, 5);
  rr.charge(`review-${D}-a-3-1`, 6);
  const costs = (rr as unknown as { costs: Map<string, Record<string, number>> }).costs;
  assert.equal(costs.get(`${D}/a-b/2`)!.audit, 5);
  assert.equal(costs.get(`${D}/a/3`)!.review, 6);
});

test("team: the host's review and coordinator sessions: what they spend goes to the budget (the coordinator's every turn) and to charge", async () => {
  const driver = new FakeDriver();
  const charged: Array<[string, number]> = [];
  const { hosts, budget } = hostsFor(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), PS, driver, charged);
  const rv = hosts.review!.open({ id: `review-${D}-people-1-1`, model: "sonnet", allowed: ["recall", "recall_event", "review_done"] });
  rv.wake("审");
  assert.equal(hosts.review!.page(teamFlow().stages[1]!), "页");
  const co = hosts.coord!.open({ id: "coord-n", model: "sonnet", timeoutMs: 3600_000 });
  co.wake("简报");
  const sess = driver.sessions.map((s) => s.id);
  assert.deepEqual(sess, [`review-${D}-people-1-1`, "coord-n"]);
  // 前额叶：每一轮结束就记上这一轮的（不等一夜完）
  driver.latest("coord-n").emitRaw({ type: "turn-end", ok: true, usage: { contextTokens: 10 }, total: { calls: 1, input: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } as never);
  assert.ok(budget.spent > 0, "前额叶这一轮的花费马上算进去");
  const first = budget.spent;
  await co.close();
  await rv.close();
  assert.equal(budget.spent, first, "结算时不重复记");
  assert.deepEqual(charged.map(([id]) => id), ["coord-n"]);
});

test("team: db migration 17 adds region, persona, reviewer, decision and cost to sleep_stage", () => {
  assert.equal(MIGRATIONS.length, 18);
  const db = openDb(":memory:");
  const cols = all<{ name: string }>(db, "PRAGMA table_info(sleep_stage)").map((c) => c.name);
  for (const c of ["region", "persona", "reviewer", "decision", "cost"]) assert.ok(cols.includes(c), c);
});

test("team: a day-end exam redo of a passed stage goes to another persona, fixing the kept proposals in place", async () => {
  const h = nightHost();
  let asked = 0;
  await runnerFor(h, teamFlow(), {
    validators: [verdicts([])], personas: PS,
    finalCheck: async () => (asked++ === 0 ? { redo: [{ stage: "people", problems: ["答错了：11-06 谁来过"] }] } : { redo: [] }),
  }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.persona, x.decision]), [["passed", "a", "rule:pass"], ["passed", "b", "rule:pass"]]);
  const w = h.wakes[`sleep-${D}-people-2`]![0]!;
  assert.ok(w.startsWith("这一段由阿乙来做"));
  assert.match(w, /上一次是阿甲做的，这次由你来修，不要整份重写，照问题改。上一次没过的地方：\n- 答错了：11-06 谁来过/);
  assert.match(w, /上一次的改动还在提案目录和事件库里，就在它上面照问题改。/);
});

test("team: coordinate joins every session's tools only on coordinator nights", () => {
  assert.equal(toolNames(teamFlow(), PS).hosts.coord, null);
  const c = toolNames(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), PS);
  assert.deepEqual(c.tools, ["stage_done", "audit_done", "review_done", "coordinate"]);
  assert.ok(c.hosts.coord);
});

test("team: stopping the night while the coordinator is thinking closes it, so the stage doesn't wait for its timeout", { timeout: 5000 }, async () => {
  const h = nightHost();
  const box: { r: SleepRunner | null } = { r: null };
  let release: (c: CoordinateIn | null) => void = () => {};
  const coord: CoordinatorLike & { closed: number } = {
    closed: 0,
    decide: () => { queueMicrotask(() => box.r!.abort("hhd 停了")); return new Promise((r) => { release = r; }); },
    async close() { this.closed += 1; release(null); },
  };
  box.r = runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: coord });
  const r = await box.r.runNight({ night: "n", pending: once(D) });
  assert.equal(r.stoppedBy, "aborted");
  assert.ok(coord.closed >= 1);
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["failed", "rule:abort"]], "等前额叶的时候中止了：过了也不算");
});

test("team: teamParts wires the review validator with reviewModel (default sonnet) and the coordinator; a plain night gets nothing", async () => {
  const o = { night: "2026-11-07", auditMs: 1000, nightMs: 5000, later: () => () => {}, log: new Logger("t", () => {}) };
  const rec: StageRecord = { day: D, stage: "people", attempt: 1, status: "done", changes: [chg("memory/people/x.md")], report: "", uncertain: [], proposals: [], bugs: [], actual: { files: [{ path: "memory/people/x.md", op: "change" }], memOps: 0 } };
  for (const [extra, model] of [[{}, "sonnet"], [{ reviewModel: "haiku" }, "haiku"]] as const) {
    const rv = sideHost([said("pass")]);
    const t = teamParts({ review: rv.host, coord: null }, { flow: teamFlow({ personasFile: "p.json", ...extra }), personas: PS }, o);
    await t.review!.validate(teamFlow().stages[1]!, D, rec);
    assert.equal(rv.opened[0]!.model, model);
    assert.deepEqual(Object.keys(t.runner), ["personas"]);
  }
  const ch = coordHost((s) => { s.answer(coordSays("pass", "")); s.turnEnd(true); });
  const withCoord = teamParts({ review: sideHost([]).host, coord: ch.host }, { flow: teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet", persona: "c" } }), personas: PS }, o);
  assert.ok(withCoord.runner.coordinator instanceof Coordinator);
  await withCoord.runner.coordinator!.decide("简报");
  assert.deepEqual(ch.opened, ["coord-2026-11-07"]);
  assert.ok(ch.wakes[0]![0]!.startsWith(`这一夜由阿丙来协调：${PS.c!.text}`));
  assert.deepEqual(teamParts({ review: null, coord: null }, { flow: plainFlow() }, o), { review: null, runner: {} });
});

// ---------- 修正第 1 轮（opus 审）----------

test("fix1: a coordinator redo on an all-pass attempt commits it first; the fix is a keep-mode redo, so a failed fix never loses the passed stage (required: the day still lands)", async () => {
  // 评审的探针：第 1 次全过、前额叶要重做，修的那次没过 → 以前整段推迟、required 的整天不落地
  const h = nightHost();
  const coord = fakeCoord([coordSays("redo", "可以更好"), coordSays("redo", "还是不行"), coordSays("defer", "x")]);
  const v = verdicts([{ pass: true, problems: [] }, { pass: false, problems: ["审的人挑了别的毛病"] }, { pass: false, problems: ["还是不对"] }]);
  const r = await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }, { required: true }), { validators: [v], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r.landed, [D]);
  assert.deepEqual(r.deferredDays, []);
  assert.deepEqual(rows(h.db).map((x) => [x.attempt, x.status, x.persona, x.decision]), [[1, "passed", "a", "coord:polish"], [2, "failed", "b", "rule:keep"]]);
  assert.equal(coord.briefs.length, 1, "修的那次（keep）不问前额叶");
  const w2 = h.wakes[`sleep-${D}-people-2`]![0]!;
  assert.match(w2, /^这一段由阿乙来做/);
  assert.match(w2, /- 前额叶：可以更好/);
  assert.match(w2, /上一次的改动还在提案目录和事件库里，就在它上面照问题改。/);
  assert.equal(h.fs.read(`${root}/memory/people/x.md`), "第 1 次", "修没过：留着第 1 次过了的提案");
  const report = h.fs.read(`sleep/${D}/report.md`)!;
  assert.match(report, /- people（海马）：过了（2 次/);
  assert.match(report, /第 1 次：阿甲做，没人审；过了；定：过了，再修一次（前额叶）/);
  assert.match(report, /第 2 次：阿乙修，没人审；没过：审的人挑了别的毛病；定：留着上一次过了的（规矩）/);
});

test("fix1: a passing polish adds to the first report; over the hard line the coordinator's polish is skipped with a note", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("redo", "补一句 11-06 的原话")]);
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["passed", "coord:polish"], ["passed", "rule:pass"]]);
  assert.equal(h.fs.read(`${root}/memory/people/x.md`), "第 2 次");
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /### people\n第 1 次的报告\n\n（前额叶叫再修一次）第 2 次的报告/);

  // 过了绝对线：前额叶要再修一次也不修
  const over = nightHost();
  const tight = new Budget({ unitsPerPct: 1, targetPct: 1, hardPct: 2 });
  await runnerFor(over, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]), budget: tight })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(over.db).map((x) => [x.status, x.decision]), [["passed", "coord:polish（没做：绝对线）"]]);
  assert.match(over.fs.read(`sleep/${D}/report.md`)!, /前额叶要「people」再修一次，花费到了绝对线，没修：再改改/);
});

test("fix1: over the hard line a stage gets at most two tries, whatever maxFixRounds says", async () => {
  const h = nightHost();
  const tight = new Budget({ unitsPerPct: 1, targetPct: 1, hardPct: 2 });
  await runnerFor(h, teamFlow({ personasFile: "p.json", maxFixRounds: 3 }), { validators: [verdicts([{ pass: false, problems: ["不对"] }])], personas: PS, budget: tight })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => x.status), ["redo", "deferred"]);
});

test("fix1: a failed attempt with no rounds left doesn't wake the coordinator (the outcome is defer anyway); a note says so", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("redo", "再来")]);
  await runnerFor(h, teamFlow({ personasFile: "p.json", maxFixRounds: 1, coordinator: { model: "sonnet" } }), { validators: [verdicts([{ pass: false, problems: ["不对"] }])], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  assert.equal(coord.briefs.length, 1, "只问了第 1 次");
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["redo", "coord:redo"], ["deferred", "rule:defer"]]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /people 第 2 次没过、没有轮数了，按规矩推迟（没问前额叶）/);
});

test("fix1: an attempt that changed no file or event but took exam questions or ops (a revise only) is still examined", async () => {
  // runner：host 说这一段有待定的题或 op，就照常请验证器
  const pending = { n: 0 };
  const h = nightHost([(c) => { pending.n = 1; pass({})(c); }]);
  h.host.examPending = () => pending.n;
  const calls: string[] = [];
  await runnerFor(h, teamFlow(), { validators: [verdicts([], calls)], personas: PS }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(calls, ["people:1"]);
  assert.deepEqual(rows(h.db).map((x) => x.decision), ["rule:pass"]);
  assert.doesNotMatch(h.fs.read(`sleep/${D}/report.md`)!, /没改东西，没请人审/);

  // host：这一段这一天的待定题和 op（真的题库）
  const fx = mk([agent("people", { persona: "a", writes: ["memory/**"], exam: {} })], { personasFile: "p.json", exam: { baseBlocks: ["SOUL.md"] } });
  const { hosts } = hostsFor(fx, PS, new FakeDriver());
  assert.equal(hosts.stage.examPending!(D, "people"), 0);
  const [id] = hosts.bank.addPending(D, "other", [{ q: "问", gold: "答", accept: "", sources: ["#1"], tags: { who: ["x"], events: [], files: [], lessons: [] }, importance: 3, kind: "fact", layer: "searchable", isNew: true }]);
  hosts.bank.addOp(D, "people", { kind: "revise", q: id!, gold: "新答", why: "记错了" }, 1);
  assert.equal(hosts.stage.examPending!(D, "people"), 1, "改题的 op 也算");
  assert.equal(hosts.stage.examPending!(D, "other"), 1, "交的题");
});

test("fix1: the coordinator's role text promises personas only on persona nights", () => {
  assert.match(P.SLEEP_COORD_ROLE(null, true), /由一个你做、另一个你审/);
  assert.doesNotMatch(P.SLEEP_COORD_ROLE(null, false), /另一个你/);
  const o = { night: "n", auditMs: 1000, nightMs: 5000, later: () => () => {}, log: new Logger("t", () => {}) };
  const ch = coordHost((s) => { s.answer(coordSays("pass", "")); s.turnEnd(true); });
  const solo = teamParts({ review: null, coord: ch.host }, { flow: mk([agent("people")], { coordinator: { model: "sonnet" } }) }, o);
  return solo.runner.coordinator!.decide("简报").then(() => {
    assert.doesNotMatch(ch.wakes[0]![0]!, /另一个你/);
  });
});

// ---------- 最终评审修正（final review I2 / M3 / M2 / M6）----------

/** 三段连着（people → notebook → soul），都是阿甲做、都写 memory/**（每次改一下 x.md） */
const threeFlow = (coordinator: Record<string, unknown> = { model: "sonnet" }) => mk([
  script("prepare", ["prepare", "{day}"]),
  agent("people", { after: ["prepare"], writes: ["memory/**"], persona: "a" }),
  agent("notebook", { after: ["people"], writes: ["memory/**"], persona: "a" }),
  agent("soul", { after: ["notebook"], writes: ["memory/**"], persona: "a" }),
  script("finish", ["finish", "{day}", "{partial}"], { after: ["soul"] }),
], { personasFile: "p.json", coordinator });
const allRows = (db: Db) => all<{ stage: string; attempt: number; status: string; decision: string | null }>(db, "SELECT stage, attempt, status, decision FROM sleep_stage WHERE stage NOT IN ('prepare', 'finish') ORDER BY id")
  .map((r) => [r.stage, r.attempt, r.status, r.decision]);

test("final I2: over the target line (not the hard line) the coordinator's polish is skipped with a note", async () => {
  const h = nightHost();
  // 一次 250 单位 = 2.5%：第 1 次以后过了目标线（1%），没到绝对线（100%）
  const target = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 100 });
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]), budget: target })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["passed", "coord:polish（没做：目标线）"]], "没有第 2 次");
  assert.equal(h.fs.read(`${root}/memory/people/x.md`), "第 1 次");
  const top = h.fs.read(`sleep/${D}/report.md`)!.split("## 记账")[0]!;
  assert.match(top, /花费到了目标线，前额叶要的打磨没做：people/);
});

test("final I2: polishes per night are capped by coordinator.maxPolish (default 2); one over the cap is skipped with a note", async () => {
  const h = nightHost();
  await runnerFor(h, threeFlow(), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]) })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(allRows(h.db), [
    ["people", 1, "passed", "coord:polish"], ["people", 2, "passed", "rule:pass"],
    ["notebook", 1, "passed", "coord:polish"], ["notebook", 2, "passed", "rule:pass"],
    ["soul", 1, "passed", "coord:polish（没做：上限）"],
  ]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!.split("## 记账")[0]!, /前额叶要「soul」再修一次，今晚已经打磨了 2 次（上限 2），没修：再改改/);

  // maxPolish: 0：一次都不打磨
  const z = nightHost();
  await runnerFor(z, threeFlow({ model: "sonnet", maxPolish: 0 }), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]) })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(allRows(z.db).map((r) => r[3]), ["coord:polish（没做：上限）", "coord:polish（没做：上限）", "coord:polish（没做：上限）"]);
});

test("final I2: coordinator.maxPolish parses as an integer 0..5; anything else is a problem", () => {
  assert.deepEqual(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet", maxPolish: 3 } }).coordinator, { model: "sonnet", maxPolish: 3 });
  assert.deepEqual(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet", maxPolish: 0 } }).coordinator, { model: "sonnet", maxPolish: 0 });
  assert.deepEqual(teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }).coordinator, { model: "sonnet" }, "没写就没有这个键");
  for (const bad of [6, -1, 1.5, "2", null]) {
    assert.match(problemsOf(() => teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet", maxPolish: bad } })).join("|"), /coordinator 取值不对/, String(bad));
  }
});

test("final I2: the coordinator's brief says what the night has spent against the target", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("pass", "")]);
  const b = new Budget({ unitsPerPct: 1000, targetPct: 1, hardPct: 2 });
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: coord, budget: b })
    .runNight({ night: "n", pending: once(D) });
  assert.match(coord.briefs[0]!, /花费：约 0\.25%（目标 1%）/);
});

test("final M3: maxFixRounds accepts 0 to 3 only", () => {
  for (const ok of [0, 1, 2, 3]) assert.equal(teamFlow({ personasFile: "p.json", maxFixRounds: ok }).maxFixRounds, ok);
  for (const bad of [4, 20, -1, 1.5, "2"]) {
    assert.match(problemsOf(() => teamFlow({ personasFile: "p.json", maxFixRounds: bad })).join("|"), /maxFixRounds/, String(bad));
  }
});

test("final M2: the coordinator's brief caps each validator result at 400 chars and each problem list at 8 items, saying how much is left", async () => {
  const h = nightHost();
  const coord = fakeCoord([coordSays("pass", "")]);
  const many = Array.from({ length: 12 }, (_, i) => `问题${i}`);
  const long = "长".repeat(1000);
  const v: StageValidator = { name: "fake", async validate() { return { pass: true, problems: many }; } };
  const w: StageValidator = { name: "fake2", async validate() { return { pass: true, problems: [long] }; } };
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [v, w], personas: PS, coordinator: coord })
    .runNight({ night: "n", pending: once(D) });
  const brief = coord.briefs[0]!;
  const line = (name: string) => brief.split("\n").find((l) => l.startsWith(`- ${name}：`))!;
  assert.match(line("fake"), /问题7…（还有 4 条）/);
  assert.doesNotMatch(line("fake"), /问题8/);
  const l2 = line("fake2");
  assert.ok(l2.length <= `- fake2：`.length + 400 + 20, String(l2.length));
  assert.match(l2, /…（还有 \d+ 字）/);
});

test("final M4: a polish attempt that changes nothing opens no audit, review or exam session — only this attempt's questions and ops count", async () => {
  // host 照尝试数：第 1 次交了题（2 道），打磨的第 2 次什么都没交；不给尝试数时是以前那样（整段的待定，2）
  const seen: Array<number | undefined> = [];
  const h = nightHost([edit, pass({})]);
  h.host.examPending = (_d, _s, attempt) => { seen.push(attempt); return attempt === undefined || attempt === 1 ? 2 : 0; };
  const au = sideHost([(s) => { s.answer({ verdict: "pass", problems: [] }); s.turnEnd(true); }]);
  const rv = sideHost([said("pass")]);
  const exams: string[] = [];
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), {
    validators: [auditValidator(au.host, { model: "opus", timeoutMs: 1000 }), RV(rv), verdicts([], exams)], personas: PS, coordinator: fakeCoord([coordSays("redo", "再看看")]),
  }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.attempt, x.status, x.decision]), [[1, "passed", "coord:polish"], [2, "passed", "rule:pass"]]);
  assert.deepEqual([au.opened.length, rv.opened.length, exams], [1, 1, ["people:1"]], "打磨的那次没开核依据、交叉审、考试");
  assert.ok(seen.includes(2), "问 host 时带上第几次");

  // host：只算这一次记的 op，和还没在过了的一次里考过的题
  const fx = mk([agent("people", { persona: "a", writes: ["memory/**"], exam: {} })], { personasFile: "p.json", exam: { baseBlocks: ["SOUL.md"] } });
  const q = { q: "问", gold: "答", accept: "", sources: ["#1"], tags: { who: ["x"], events: [], files: [], lessons: [] }, importance: 3, kind: "fact" as const, layer: "searchable" as const, isNew: true };
  const first = (passed: boolean) => {
    const { hosts } = hostsFor(fx, PS, new FakeDriver());
    const [id] = hosts.bank.addPending(D, "people", [q]);
    hosts.bank.addOp(D, "people", { kind: "revise", q: id!, gold: "新答", why: "记错了" }, 1);
    assert.equal(hosts.stage.examPending!(D, "people", 1), 2, "第 1 次：一道题、一条改题");
    hosts.stage.attemptEnded!(D, "people", passed, 1);
    return { hosts, id: id! };
  };
  const ok = first(true);
  assert.equal(ok.hosts.stage.examPending!(D, "people", 2), 0, "第 1 次过了（考过了）、打磨的第 2 次什么都没交：不算");
  assert.equal(ok.hosts.stage.examPending!(D, "people"), 2, "不给第几次：照旧整段的");
  ok.hosts.bank.addPending(D, "people", [{ ...q, q: "问二" }]);
  ok.hosts.bank.addOp(D, "people", { kind: "retire", q: ok.id, why: "不要了" }, 2);
  assert.equal(ok.hosts.stage.examPending!(D, "people", 2), 2, "第 2 次交的题、记的 op");
  const failed = first(false);
  assert.equal(failed.hosts.stage.examPending!(D, "people", 2), 1, "第 1 次没过：它的改题丢了，它交的题还没考过，重做的第 2 次照样要考");
});

test("final M6: a required stage deferred by the coordinator aborts the day with 前额叶定了推迟; a rule defer on the last attempt keeps N 次都没过", async () => {
  // 前额叶在第 1 次（还有轮数）定了推迟
  const h = nightHost();
  const r1 = await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }, { required: true }), {
    validators: [verdicts([{ pass: false, problems: ["不对"] }])], personas: PS, coordinator: fakeCoord([coordSays("defer", "今晚不值得")]),
  }).runNight({ night: "n", pending: once(D) });
  assert.deepEqual(r1.deferredDays, [D]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /people 段前额叶定了推迟/);
  // 最后一次没过：规矩推迟（修正第 1 轮起不叫醒前额叶），照旧写几次没过
  const g = nightHost();
  await runnerFor(g, teamFlow({ personasFile: "p.json", maxFixRounds: 0, coordinator: { model: "sonnet" } }, { required: true }), {
    validators: [verdicts([{ pass: false, problems: ["不对"] }])], personas: PS, coordinator: fakeCoord([coordSays("defer", "x")]),
  }).runNight({ night: "n", pending: once(D) });
  assert.match(g.fs.read(`sleep/${D}/report.md`)!, /people 段 1 次都没过/, "规矩推迟的照旧写几次没过");
});

// ---------- 修正第 2 轮（re-review m2）----------

test("fix2 m2: a polish skipped for the target line or the cap is recorded as not done — ledger decision and report — so compare.md's 协调 column doesn't count it", async () => {
  // 目标线
  const h = nightHost();
  const target = new Budget({ unitsPerPct: 100, targetPct: 1, hardPct: 100 });
  await runnerFor(h, teamFlow({ personasFile: "p.json", coordinator: { model: "sonnet" } }), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]), budget: target })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(rows(h.db).map((x) => [x.status, x.decision]), [["passed", "coord:polish（没做：目标线）"]]);
  assert.match(h.fs.read(`sleep/${D}/report.md`)!, /第 1 次：阿甲做，没人审；过了；定：过了，前额叶要再修一次、没做（目标线）（前额叶）/);
  // 上限：第三段的打磨没做；前两段照常
  const c = nightHost();
  await runnerFor(c, threeFlow(), { validators: [verdicts([])], personas: PS, coordinator: fakeCoord([coordSays("redo", "再改改")]) })
    .runNight({ night: "n", pending: once(D) });
  assert.deepEqual(allRows(c.db).map((r) => r[3]), ["coord:polish", "rule:pass", "coord:polish", "rule:pass", "coord:polish（没做：上限）"]);
});

// ---------- 回放第 1 次的修正（replay1 F2）：没过的那一次交的待定题撤掉 ----------
import { memorySink, type LogRecord } from "../src/log.ts";
import { S, setLang } from "../src/lang/index.ts";

/** 跟 hostsFor 一样，只是工作区里的文件都读得到（「路径:行」的出处查得到），日志收下来 */
function examHosts(flow: FlowConfig) {
  const logs: LogRecord[] = [];
  const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-team-hosts-") });
  const fs: MiniFs = { read: () => "一\n二\n三\n", write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const driver = new FakeDriver();
  const b: NightBrain = {
    cfg, driver, db: openDb(":memory:"), log: new Logger("t", memorySink(logs)), mem: null, fs,
    run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => "页", now: () => 1000, later: () => () => {},
    hhTools: () => [],
  };
  const budget = new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 });
  const hosts = nightHosts(b, { flow, prefix: "P", hash: "h", personas: PS }, { budget, weights: sleepWeights(undefined), auditMs: 60_000, charge: () => {} });
  return { hosts, driver, logs };
}
const examQs = (n: number, tag: string) => ({
  questions: Array.from({ length: n }, (_, i) => ({ q: `${tag} ${i}`, gold: "答", accept: "", sources: ["memory/a.md:1"], tags: { who: [], events: [], files: ["memory/a.md"], lessons: [] }, importance: 3, kind: "fact", layer: "searchable", isNew: true })),
  revise: [], retire: [],
});
async function submit(x: ReturnType<typeof examHosts>, n: number, attempt: number, qs: ReturnType<typeof examQs>): Promise<string> {
  x.hosts.stage.open({ id: `sleep-${D}-people-${attempt}`, stage: F2FLOW.stages[0]!, day: D, allowed: new Set(["stage_done"]) }).wake("开始");
  const s = x.driver.sessions[n]!;
  const def = s.spec.tools.find((t) => t.name === "exam_questions")!;
  return String(await def.handler(qs as never));
}
const F2FLOW = mk([agent("people", { persona: "a", writes: ["memory/**"], exam: { max: 30 } })], { personasFile: "p.json", exam: { baseBlocks: ["SOUL.md"] } });

test("replay1 F2: a failed attempt's pending questions are dropped, so the fixer gets the full cap; they never land", async () => {
  const x = examHosts(F2FLOW);
  assert.match(await submit(x, 0, 1, examQs(17, "第一次")), /收下 17 道/);
  const first = x.hosts.bank.pending(D, "people").map((q) => q.id);
  assert.equal(first.length, 17);
  x.hosts.stage.attemptEnded!(D, "people", false, 1);
  assert.equal(x.hosts.bank.pending(D, "people").length, 0, "没过的那一次的题撤了");
  const line = x.logs.find((l) => l.msg === "sleep: a failed attempt's pending questions dropped");
  assert.ok(line && line.questions === 17, JSON.stringify(line));
  // 修的人：照满额 30 道交
  assert.match(await submit(x, 1, 2, examQs(30, "第二次")), /收下 30 道/);
  x.hosts.stage.attemptEnded!(D, "people", true, 2);
  x.hosts.stage.landed!(D, ["people"]);
  for (const id of first) assert.equal(x.hosts.bank.get(id)!.status, "dropped", id);
  assert.equal(x.hosts.bank.pending(D).length, 0);
  const qs = [...first, ...Array.from({ length: 30 }, (_, i) => `q:${D}/people/${18 + i}`)].map((id) => x.hosts.bank.get(id)!.status);
  assert.deepEqual([qs.filter((v) => v === "dropped").length, qs.filter((v) => v === "active").length], [17, 30], "只有第二次的 30 道生效");
});

test("replay1 F2: a polish after a PASS that fails drops only its own questions; the passed attempt's stay (and M4's no-change skip still ignores them)", async () => {
  const x = examHosts(mk([agent("people", { persona: "a", writes: ["memory/**"], exam: {} })], { personasFile: "p.json", exam: { baseBlocks: ["SOUL.md"] } }));
  assert.match(await submit(x, 0, 1, examQs(3, "过了的")), /收下 3 道/);
  x.hosts.stage.attemptEnded!(D, "people", true, 1);
  assert.equal(x.hosts.stage.examPending!(D, "people", 2), 0, "打磨什么都没交：不考");
  assert.match(await submit(x, 1, 2, examQs(2, "打磨的")), /收下 2 道/);
  assert.equal(x.hosts.stage.examPending!(D, "people", 2), 2);
  x.hosts.stage.attemptEnded!(D, "people", false, 2);
  assert.deepEqual(x.hosts.bank.pending(D, "people").map((q) => q.q), ["过了的 0", "过了的 1", "过了的 2"]);
});

test("P8: a stage's reviewModel overrides the global one for its review session", async () => {
  const rec: StageRecord = {
    day: D, stage: "people", attempt: 1, status: "done", changes: [chg("memory/people/x.md")], report: "改了人物卡", uncertain: [], proposals: [], bugs: [],
    actual: { files: [{ path: "memory/people/x.md", op: "change" }], memOps: 0 },
  };
  const h = sideHost([said("pass")]);
  await RV(h).validate(teamFlow({ personasFile: "personas.json" }, { reviewModel: "opus" }).stages[1]!, D, rec);
  await RV(h).validate(teamFlow().stages[1]!, D, rec);
  assert.deepEqual(h.opened.map((x) => x.model), ["opus", "sonnet"]);
});

test("pre2 M7: on an exam night the ladder's cheap step caps the review model at sonnet (haiku stays haiku)", () => {
  const cfg = loadConfig({ workspace: "/tmp/hh-test-ws", stateDir: tmpDir("hh-team-cheap-") });
  const fs: MiniFs = { read: () => null, write: () => {}, remove: () => {}, list: () => [], isDir: () => false };
  const flow = mk([agent("people", { persona: "a", writes: ["memory/**"], exam: {} }), script("finish", ["finish"], { after: ["people"] })], { personasFile: "p.json", exam: { baseBlocks: ["SOUL.md"] } });
  const models = (cheap: boolean) => {
    const driver = new FakeDriver();
    const b: NightBrain = {
      cfg, driver, db: openDb(":memory:"), log: new Logger("t", () => {}), mem: null, fs,
      run: async () => ({ code: 0, stdout: "", stderr: "" }), readText: () => "页", now: () => 1000, later: () => () => {}, hhTools: () => [],
    };
    const hosts = nightHosts(b, { flow, prefix: "P", hash: "h", personas: PS }, {
      budget: new Budget({ unitsPerPct: 1e9, targetPct: 1, hardPct: 2 }), weights: sleepWeights(undefined), auditMs: 60_000,
      ladder: () => ({ level: cheap ? 3 : 0, hidden: !cheap, oldScale: 1, cheap, finalOldOnly: false }),
    });
    for (const m of ["opus", "sonnet", "haiku"]) hosts.review!.open({ id: `review-${D}-people-1-${m}`, model: m, allowed: ["review_done"] }).wake("审");
    return driver.sessions.map((s) => s.spec.model);
  };
  assert.deepEqual(models(true), [cfg.models.sonnet, cfg.models.sonnet, cfg.models.haiku]);
  assert.deepEqual(models(false), [cfg.models.opus, cfg.models.sonnet, cfg.models.haiku]);
});
