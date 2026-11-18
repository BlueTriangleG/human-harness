// 对照工具的 day 场景（她按钟过的一天）：小快照上用短窗口跑；白天的窗口跑两次（两个工作目录、两个新的 --out），一个字节不差。
// 白天的窗口（10:00 到 13:06）：场景自己放的提醒和专注、放空、专注的升级、额度一档档往上和第一次直达的重置、翻页（分叉那条路收下合格的稿）、
// 困了小睡再醒，和 day-coverage 记的哪些到了、哪些没到。夜里的窗口（02:30 起一小时）：最小的分段整理流程开得起第一段，叫醒、催交都在。
// 另测额度表（S 怎么定、各步的先后）、替系统回答的命令、天数的读法、合格压缩稿的样子。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as P from "../src/lang/zh/prompts.ts";
import { loadConfig } from "../src/config.ts";
import {
  DAY_HOURS, FIVE_HOUR, PAGE_TURNS, RUN_ANSWERS, SCHEDULE_INPUTS, STEP_MS, TIGHT_AFTER, VALID_FORK_TEXT, WEEK,
  dayHours, quotaAt, tightSlot, type QuotaStep,
} from "../src/parity/scenarios/day.ts";
import { buildSnapshot, TAKEN_AT, TZ, upToState } from "./parity/fixture.ts";
import { tmpDir } from "./tmp.ts";

const MAIN = resolve(fileURLToPath(import.meta.url), "../../src/parity/main.ts");
const HOUR = 3_600_000;
const MIN = 60_000;
const SLOTS = { focusSlots: ["07:30", "09:00", "13:00", "18:00"], focusMinutes: 30, timezone: TZ };

interface Rec { n: number; t: number; kind: string; [k: string]: unknown }

/** 最小的分段整理流程：一个 agent 段（没有材料），加上引擎要的落地脚本 finish */
const FLOW_FILES = {
  "scripts/sleep_flow/flow.json": `${JSON.stringify({
    engine: "flow",
    stages: [
      { id: "tidy", title: "（对照）理一理这一天", kind: "agent", skill: "tidy.md" },
      { id: "finish", title: "（对照）落地", kind: "script", command: ["python3", "scripts/sleep_finish.py", "{day}"] },
    ],
  })}\n`,
  "scripts/sleep_flow/common.md": "# 整理的共同规矩\n\n（对照）照这一段的 skill 页做。\n",
  "scripts/sleep_flow/tidy.md": "# （对照）理一理这一天\n\n把这一天发生的事理一遍。\n",
};

/** 跑 times 次（各用自己的工作目录、新的 --out），一个字节不差；返回记录 */
function dayRuns(prefix: string, hours: number, times: number, takenAt?: number): Rec[] {
  const root = tmpDir(prefix);
  // 困的线压低：翻页那块压缩稿一进来就困，专注完闲下来小睡、醒来；分段整理的引擎要配置明说开（sleep.newEngine）
  const snap = buildSnapshot(root, { config: { limits: { sleepyAtTokens: 1000 }, parity: { dayHours: hours }, sleep: { newEngine: true, pendingDays: ["list-days", "pending"] } }, files: FLOW_FILES, ...(takenAt ? { takenAt } : {}) });
  const runs = Array.from({ length: times }, (_, k) => String(k + 1)).map((i) => {
    const out = join(root, `out${i}`);
    const r = spawnSync(process.execPath, [MAIN, "dump", "--data", snap.data, "--work", join(root, `work${i}`), "--out", out, "--scenario", "day"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    return readFileSync(join(out, "day", "transcript.jsonl"), "utf8");
  });
  for (const r of runs.slice(1)) assert.equal(r, runs[0], "day is deterministic");
  const recs = runs[0]!.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Rec);
  assert.ok(!recs.some((r) => r.kind === "log" && r.level === "error"), JSON.stringify(recs.filter((r) => r.kind === "log")));
  assert.deepEqual(upToState(recs).slice(-3).map((r) => [r.kind, r.name]), [["state", "status"], ["state", "db"], ["state", "files"]], "ends with the state records");
  return recs;
}

const coverageOf = (recs: Rec[]): Record<string, boolean> => recs.find((r) => r.kind === "call" && r.name === "day-coverage")!.returned as Record<string, boolean>;
const missingLine = (recs: Rec[]): string => String(recs.find((r) => r.kind === "log" && r.level === "info" && String(r.msg).startsWith("parity: day"))!.msg);
const sendsTo = (recs: Rec[], pick: (region: string) => boolean): string[] => recs.filter((r) => r.kind === "send" && pick(String(r.region))).map((r) => String(r.text));

test("parity dump day, daytime window on the fixture: byte-identical; its own reminders and focus block, wander, focus escalation, quota up and the first urgent reset, a fork page turn, a nap — and day-coverage says exactly which", () => {
  const hours = 3.1;
  const recs = dayRuns("hh-parity-day-", hours, 2);
  assert.deepEqual(recs[0], { n: 0, t: 0, kind: "call", name: "day", args: { hours, stepMs: STEP_MS, tightSlot: 8 * HOUR }, returned: null }, "the day's length and S are on record");

  // 场景自己放进排程表的三条：记了一条 call，到点都发了
  const sched = recs.find((r) => r.kind === "call" && r.name === "schedule")!;
  assert.deepEqual(sched.args, SCHEDULE_INPUTS.map((x) => ({ kind: x.kind, due: TAKEN_AT + x.at, text: x.text, everyMs: x.everyMs, minutes: x.minutes })));
  assert.equal((sched.returned as number[]).length, 3);
  const main = sendsTo(recs, (r) => r === "main");
  const [once, daily, block] = SCHEDULE_INPUTS.map((x) => x.text) as [string, string, string];
  assert.ok(main.some((t) => t.includes(P.REMINDER_TRIGGER) && t.includes(once)), "the one-off reminder fires");
  assert.ok(main.some((t) => t.includes(P.REMINDER_TRIGGER) && t.includes(daily)), "the daily reminder fires");
  assert.ok(main.some((t) => t.includes(`${P.FOCUS_REGULAR}\n（这段专注：${block}）`)), "the focus block starts");

  // 额度：每次问都记着，5 小时那格照表往上过每一档，再重置
  const five = recs.filter((r) => r.kind === "call" && r.name === "quota").map((r) => (r.returned as { fiveHour?: { used: number } }).fiveHour?.used);
  assert.deepEqual([...new Set(five)], [20, 55, 72, 88, 96, 4]);

  // 翻页：到点那一轮报满上下文，分叉一次、回的是合格的稿；新开的主线前缀里有换成编号的那段
  const full = recs.filter((r) => r.kind === "script" && (r.script as { contextTokens?: number }).contextTokens !== undefined);
  assert.equal(full.length, 1, "one full-context turn: the page turn started at once");
  assert.ok(full[0]!.t >= PAGE_TURNS[0]!);
  const forks = recs.filter((r) => r.kind === "call" && r.name === "fork");
  assert.equal(forks.length, 1);
  assert.equal((forks[0]!.returned as { text: string }).text, VALID_FORK_TEXT);
  assert.ok(!recs.some((r) => r.kind === "log" && String(r.msg).startsWith("page turn:")), "no fallback to the hippocampus");
  assert.ok(recs.some((r) => r.kind === "open" && r.region === "main" && r.n > forks[0]!.n && /固定的压缩稿第 01 条：[^\n]*（#\d+(–#\d+)?）/.test(String(r.systemAppend))));

  assert.deepEqual(coverageOf(recs), {
    focusPlan: false, focusRegular: true, focusFindWork: true, focusIdleLong: true, focusQuotaTight: false,
    wander: true, reminderTrigger: true, reminderOnce: true, reminderDaily: true, scheduledFocus: true,
    quotaFiveHourUp: true, quotaFiveHourReset: true, quotaWeekUp: false, quotaWeekReset: false, quotaPace: false, quotaRejected: false,
    goingToSleep: true, nightOrganize: false, nightStage: false, nightNudge: false, wokeUp: true, wokeUpAfterNight: false,
    pageTurnFork: true, pageTurnFallback: false,
  });
  assert.equal(missingLine(recs), "parity: day did not reach: focusPlan, focusQuotaTight, quotaWeekUp, quotaWeekReset, quotaPace, quotaRejected, nightOrganize, nightStage, nightNudge, wokeUpAfterNight, pageTurnFallback");
});

test("parity dump day, night window on the fixture: byte-identical; the waiting day is answered, the smallest flow opens its first stage, nudges it, and the coverage says so", () => {
  const takenAt = TAKEN_AT + 16.5 * HOUR;   // 02:30
  // 两次、逐字节比：分段整理的这一夜只有这里比得到（真配置上夜里走的是旧的整理，分段的第一段到不了）
  const recs = dayRuns("hh-parity-day-night-", 1, 2, takenAt);
  const pending = recs.filter((r) => r.kind === "run" && (r.args as string[]).at(-1) === "pending");
  assert.ok(pending.length >= 1);
  for (const r of pending) assert.deepEqual(r.answered, { code: 0, stdout: "2026-11-01\n", stderr: "" }, "exactly one day is listed");
  const night = sendsTo(recs, (r) => r.startsWith("sleep-2026-11-01-tidy-"));
  assert.ok(night.some((t) => t.includes("【夜里整理·这一段】") && t.includes("把这一天发生的事理一遍。")), "the first stage's wake prompt, with its skill page");
  assert.ok(night.some((t) => t.includes(P.SLEEP_STAGE_REDO(["催了一次还是没交 stage_done"]))), "not handed in: the second attempt says why");
  assert.ok(night.some((t) => t === P.SLEEP_STAGE_CONTINUE), "the hand-in nudge");
  const cov = coverageOf(recs);
  for (const k of ["goingToSleep", "nightStage", "nightNudge"]) assert.equal(cov[k], true, k);
  for (const k of ["nightOrganize", "wokeUpAfterNight"]) assert.equal(cov[k], false, k);
});

test("the valid fork text stays above the fork minimum without its anchors, one ref per item", () => {
  const lines = VALID_FORK_TEXT.split("\n");
  assert.ok(lines.every((l) => l.startsWith("- ") && /〔锚：[^｜〕]+｜[^〕]+〕$/.test(l)));
  // brain.ts forkMinChars 最多 1500 字（锚点会换成更短的编号）
  assert.ok(VALID_FORK_TEXT.replace(/〔锚：[^〕]*〕/g, "").length >= 1500);
});

test("S, the tight-week slot: the first focus slot that starts at or after T0 + 7 h, whatever the time of day; T0 + 8 h without slots", () => {
  assert.equal(tightSlot(TAKEN_AT, SLOTS), TAKEN_AT + 8 * HOUR, "10:00 → the 18:00 slot");
  assert.equal(tightSlot(TAKEN_AT + HOUR, SLOTS), TAKEN_AT + 8 * HOUR, "11:00 → the 18:00 slot starts exactly at T0 + 7 h");
  assert.equal(tightSlot(TAKEN_AT + HOUR + MIN, SLOTS), TAKEN_AT + 21.5 * HOUR, "11:01 → already inside the 18:00 slot, so 07:30 next morning");
  assert.equal(tightSlot(TAKEN_AT, { ...SLOTS, focusSlots: [] }), TAKEN_AT + 8 * HOUR, "no slots");
  for (let k = 0; k < 24; k += 2) {
    const t0 = TAKEN_AT + k * HOUR + 7 * MIN;
    const s = tightSlot(t0, SLOTS);
    assert.ok(s >= t0 + TIGHT_AFTER && s <= t0 + 20.5 * HOUR, `T0 + ${k} h 7 min`);
  }
});

test("the quota steps stay in order for any S from T0 + 7 h on, and the reading composes both windows, the outage and the rejection", () => {
  const t0 = TAKEN_AT;
  const abs = (x: QuotaStep, s: number): number => (x.from === "T0" ? t0 : s) + x.at;
  for (const s of [t0 + TIGHT_AFTER, t0 + 8 * HOUR, t0 + 20.5 * HOUR]) {
    for (const steps of [FIVE_HOUR, WEEK]) {
      const at = steps.map((x) => abs(x, s));
      assert.deepEqual(at, [...at].sort((a, b) => a - b), `steps in order for S = T0 + ${(s - t0) / HOUR} h`);
      assert.ok(at.at(-1)! < t0 + DAY_HOURS * HOUR, "the last step falls in the day");
    }
  }
  const s = t0 + 8 * HOUR;
  assert.deepEqual(quotaAt(t0, s, t0), { fiveHour: { used: 20, resetsAt: t0 + 3 * HOUR }, sevenDay: { used: 30, resetsAt: t0 + 5 * 24 * HOUR } });
  assert.equal(quotaAt(t0, s, t0 + 4 * HOUR + 5 * MIN), null, "unreadable");
  assert.deepEqual(quotaAt(t0, s, s - 10 * MIN), { fiveHour: { used: 52, resetsAt: t0 + 8 * HOUR }, sevenDay: { used: 91, resetsAt: t0 + 5 * 24 * HOUR } }, "tight from S - 30 min");
  assert.deepEqual(quotaAt(t0, s, s + 2.5 * HOUR + MIN), { sevenDay: { used: 98, resetsAt: t0 + 5 * 24 * HOUR }, rejected: { window: "seven_day", resetsAt: s + 2.5 * HOUR + 20 * MIN } }, "rejected, no 5-hour window");
  assert.deepEqual(quotaAt(t0, s, t0 + 26 * HOUR), { sevenDay: { used: 2, resetsAt: t0 + 12 * 24 * HOUR } });
});

test("the canned command answers: only the exact pending query, listing the night's day", () => {
  const cfg = loadConfig({ workspace: "/w", sleep: { pendingDays: ["/usr/bin/python3", "/w/scripts/sleep_digest.py", "pending"] }, schedule: { timezone: TZ } });
  const [pending] = RUN_ANSWERS;
  assert.equal(pending!.match("/usr/bin/python3", ["/w/scripts/sleep_digest.py", "pending"], cfg), true);
  assert.equal(pending!.match("/usr/bin/python3", ["/w/scripts/sleep_digest.py", "pending", "--all"], cfg), false);
  assert.equal(pending!.match("/usr/bin/python3", ["/w/scripts/goals.py", "pending"], cfg), false);
  assert.equal(pending!.match("python3", ["/w/scripts/sleep_digest.py", "pending"], cfg), false);
  assert.deepEqual(pending!.answer(TAKEN_AT + 17 * HOUR, cfg), { code: 0, stdout: "2026-11-01\n", stderr: "" }, "03:00 on 11-02 belongs to the night of 11-01");
});

test("the day's length: 26 h unless the fixture's config sets parity.dayHours; a bad value is refused", () => {
  assert.equal(dayHours({}), DAY_HOURS);
  assert.equal(DAY_HOURS, 26);
  assert.equal(dayHours({ parity: { dayHours: 3 } }), 3);
  assert.throws(() => dayHours({ parity: { dayHours: "3" } }), /positive number/);
  assert.throws(() => dayHours({ parity: { dayHours: 0 } }), /positive number/);
});
