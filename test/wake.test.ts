// 醒来那一刻（夜里那一觉整理好、开了醒来那一页以后）：
// A 换前缀以前跑一次配好的命令（sleep.wakeRefresh）——人格自己的脚本要「睡下」和「醒来那一页」都在库里，才生成醒来那几节；
// B 醒来那一页里、第一次翻页以前 hhd 重启：整页带上的开场也接上睡前那段（#0054 漏洞）；
// C 醒来那一页里主线的开场（前缀 + 第一条消息）原样存一份，不用再猜她早上看到了什么。
// D 最早那天推迟到下一晚（额度紧时照指南只写提案）：醒来不清压缩块、说法照实；整理好、没整理好的一夜一个字不变。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { makeBrain, flush, testConfig } from "./helpers.ts";
import { loadModules } from "../src/modules/load.ts";
import type { TestBrain } from "./helpers.ts";
import { openDb, kvGet } from "../src/store/db.ts";
import { Persona } from "../src/persona/persona.ts";
import type { RunResult } from "../src/util/run.ts";
import type { LearningRuntime } from "../src/learning/runtime.ts";
import type { LogRecord } from "../src/log.ts";
import * as P from "../src/lang/zh/prompts.ts";
import { tmpDir } from "./tmp.ts";

const NIGHT = { schedule: { timezone: "UTC", focusSlots: ["07:30", "09:00"], focusMinutes: 30, nightSleep: "03:00", wanderEveryMinutes: 45 } };
const WAKE_TAIL = { limits: { rotationTailTokens: 300 } };
const NIGHT_WORK = "整理的人在写提案。".repeat(200);
const AT = Date.UTC(2026, 9, 29, 3, 1);
const OK: RunResult = { code: 0, stdout: "", stderr: "" };
/** 配给 sleep.wakeRefresh 的命令（HH 不认识它是什么，照 argv 跑） */
const REFRESH = ["/usr/bin/env", "regen-memory", "--after-wake"];
const isRefresh = (cmd: string, args: readonly string[]): boolean => cmd === REFRESH[0] && args.join(" ") === REFRESH.slice(1).join(" ");
const reEsc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const beforeSleepHead = new RegExp(`下面是我最近的经历：\\n${reEsc(P.BEFORE_SLEEP_NOTE)}\\n`);
/** 每个测试自己的 stateDir（醒来的开场存档写在 <stateDir>/wake） */
const state = (): string => tmpDir("hh-wake-state-");
const persona = (snapshot: string): Persona => new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }, { path: "SNAPSHOT.md", text: snapshot }]);

/** 睡前记两句（直接写进中央记忆），直接睡下夜里那一觉（旧整理） */
async function sleepNow(t: TestBrain, talk = "那我先想想怎么花"): Promise<void> {
  t.brain.central.append(t.brain.status().epoch, "外界", "input", "老板今天说要发奖金", { from: "ada", human: true });
  t.brain.central.append(t.brain.status().epoch, "main", "say", talk);
  await t.brain.sleep("夜里", "night");
  await flush();
  assert.equal(t.brain.alertness, "asleep");
}
/** 旧整理一个会话整理完（之后醒来、夜里放空；命令还在跑的话还睡着） */
async function organize(t: TestBrain): Promise<void> {
  await t.driver.latest("hippocampus").play({ say: NIGHT_WORK });
  await flush(); await flush();
}
const wakeNotes = (t: TestBrain): number => t.brain.central.since(0).filter((e) => e.src === "system" && /夜里的睡眠整理/.test(e.text)).length;

// ---------- A：醒来换前缀以前跑一次配好的命令 ----------

test("A 醒来：配了 sleep.wakeRefresh，整理好、开了醒来那一页以后、换前缀以前在工作区里跑一次；新会话的前缀是跑完以后的文件", async () => {
  const db = openDb(":memory:");
  let snapshot = "（睡前生成的快照，还没有睡着前那几句）";
  let reloads = 0;
  const atRun: Array<{ cwd?: string; timeoutMs?: number; slept: boolean; wakePage: boolean; reloads: number }> = [];
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state(), sleep: { wakeRefresh: REFRESH } }, AT, {
    db,
    reloadPersona: () => { reloads += 1; return persona(snapshot); },
    run: async (cmd, args, o) => {
      if (isRefresh(cmd, args)) {
        // 跑的那一刻库里要已经有：睡下的那条记录，和它以后开的醒来那一页（人格的脚本靠这两样判断醒了没有）
        const slept = db.prepare("SELECT ts FROM central WHERE kind = 'system' AND text LIKE '去睡觉了%' ORDER BY seq DESC LIMIT 1").get() as { ts: number } | undefined;
        const wake = slept ? db.prepare("SELECT 1 AS x FROM epochs WHERE reason = 'wake' AND started >= ?").get(slept.ts) : undefined;
        atRun.push({ cwd: o?.cwd, timeoutMs: o?.timeoutMs, slept: slept !== undefined, wakePage: wake !== undefined, reloads });
        snapshot = "（醒来以后重新生成的快照：睡着前那几句）";
      }
      return OK;
    },
  });
  await sleepNow(t);
  assert.equal(atRun.length, 0, "睡下时不跑");
  await organize(t);
  assert.equal(t.brain.alertness, "awake");
  assert.equal(atRun.length, 1, "醒来跑一次");
  assert.equal(atRun[0]!.cwd, t.cfg.workspace, "在工作区里跑");
  assert.equal(atRun[0]!.timeoutMs, 60_000, "不写秒数最多等 60 秒");
  assert.ok(atRun[0]!.slept, "睡下的记录在");
  assert.ok(atRun[0]!.wakePage, "醒来那一页已经开了");
  assert.equal(reloads, atRun[0]!.reloads + 1, "跑完以后才换前缀，只换一次");
  assert.ok(t.logs.some((l) => l.msg === "wake refresh: done"));
  t.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  const sys = t.driver.latest("main").spec.systemAppend;
  assert.match(sys, /醒来以后重新生成的快照/, "新会话用的是跑完以后的文件");
  assert.doesNotMatch(sys, /睡前生成的快照/);
});

test("A 不配 sleep.wakeRefresh：醒来不多跑任何命令；配了，小睡醒来也不跑（只在夜里那一觉）", async () => {
  const t = makeBrain({ ...NIGHT, stateDir: state() }, AT);
  await sleepNow(t);
  const before = t.runs.length;
  await organize(t);
  assert.equal(t.brain.alertness, "awake");
  assert.deepEqual(t.runs.slice(before).filter((r) => !r.args.includes("pending")), [], "只有查没整理的日子那一下");

  const n = makeBrain({ stateDir: state(), limits: { mustSleepAtTokens: 1, sleepyAtTokens: 1 }, sleep: { wakeRefresh: REFRESH } });
  n.brain.epochs.addBlock(1, "一段压缩记忆");
  await n.brain.tick();
  await flush();
  assert.equal(n.brain.alertness, "awake", "小睡醒了");
  assert.ok(!n.runs.some((r) => isRefresh(r.cmd, r.args)), "小睡不跑");
});

test("A no command configured and the night module on (it is required): the pending days come from its sleep_digest.py pending, waking runs its ledger_snapshot.py", async () => {
  const st = state();
  const ran: string[] = [];
  const modules = await loadModules(testConfig({ stateDir: st }), {
    run: async (file, argv) => { ran.push([basename(file), ...argv].join(" ")); return { code: 0, stdout: "", stderr: "", timedOut: false }; },
  });
  // the test config names a pendingDays command of its own: unset here
  const t = makeBrain({ ...NIGHT, stateDir: st, sleep: { pendingDays: null } }, AT, { modules });
  await sleepNow(t);
  await organize(t);
  assert.equal(t.brain.alertness, "awake");
  assert.ok(ran.includes("sleep_digest.py pending"), ran.join(" | "));
  assert.equal(ran.filter((r) => r === "ledger_snapshot.py").length, 1, "once, on waking");
  assert.ok(!t.runs.some((r) => r.args.includes("pending")), "nothing of the role's own");
});

test("A 命令跑不成（退出码不是 0、根本起不来）：记 warn，照旧醒来，前缀照原来的文件换", async () => {
  const fails: Array<() => Promise<RunResult>> = [
    async () => ({ code: 2, stdout: "", stderr: "Traceback: boom" }),
    async () => { throw new Error("spawn EACCES"); },
  ];
  for (const fail of fails) {
    const t = makeBrain({ ...NIGHT, stateDir: state(), sleep: { wakeRefresh: REFRESH } }, AT, {
      reloadPersona: () => persona("（原来的快照）"),
      run: async (cmd, args) => (isRefresh(cmd, args) ? fail() : OK),
    });
    await sleepNow(t);
    await organize(t);
    assert.equal(t.brain.alertness, "awake", "醒来不被挡");
    assert.ok(t.logs.some((l) => l.level === "warn" && l.msg.startsWith("wake refresh:")), JSON.stringify(t.logs.filter((l) => l.level !== "info").map((l) => l.msg)));
    assert.equal(wakeNotes(t), 1, "照常记了醒来");
    assert.equal(JSON.parse(kvGet(t.db, "nightGap") ?? "{}").done, true, "那一夜照样算整理好了");
    t.brain.inbound({ from: "ada", text: "早", human: true });
    await flush();
    assert.match(t.driver.latest("main").spec.systemAppend, /原来的快照/);
  }
});

test("A 命令超时：最多等配的秒数（wakeRefreshSec），到点记 warn、照旧醒来", async () => {
  let asked: number | undefined;
  const t = makeBrain({ ...NIGHT, stateDir: state(), sleep: { wakeRefresh: REFRESH, wakeRefreshSec: 5 } }, AT, {
    run: (cmd, args, o) => {
      if (!isRefresh(cmd, args)) return Promise.resolve(OK);
      asked = o?.timeoutMs;
      return new Promise<RunResult>(() => {});   // 一直不回
    },
  });
  await sleepNow(t);
  await organize(t);
  assert.equal(asked, 5_000, "命令自己的上限也是这么多");
  assert.equal(t.brain.alertness, "asleep", "还在等命令");
  t.clock.advance(4_000); await flush();
  assert.equal(t.brain.alertness, "asleep");
  t.clock.advance(1_000); await flush(); await flush();
  assert.equal(t.brain.alertness, "awake", "到点就醒");
  assert.ok(t.logs.some((l) => l.level === "warn" && l.msg === "wake refresh: timed out, waking with the old files"));
  assert.equal(wakeNotes(t), 1);
});

test("A 配坏了（不是字符串数组、空的）：记 warn、不跑，照旧醒来", async () => {
  for (const bad of ["regen-memory --after-wake", [], ["regen", 3]]) {
    const t = makeBrain({ ...NIGHT, stateDir: state(), sleep: { wakeRefresh: bad } }, AT);
    await sleepNow(t);
    const before = t.runs.length;
    await organize(t);
    assert.equal(t.brain.alertness, "awake");
    assert.deepEqual(t.runs.slice(before).filter((r) => !r.args.includes("pending")), [], JSON.stringify(bad));
    assert.ok(t.logs.some((l) => l.level === "warn" && l.msg.startsWith("wake refresh:")), JSON.stringify(bad));
  }
});

test("A 等命令的时候看门狗从头算：整理拖到看门狗的线边上才做完，等命令时 tick 不会再叫醒一次", async () => {
  const t = makeBrain({ ...NIGHT, stateDir: state(), sleep: { wakeRefresh: REFRESH, wakeRefreshSec: 120 } }, AT, {
    run: (cmd, args) => (isRefresh(cmd, args) ? new Promise<RunResult>(() => {}) : Promise.resolve(OK)),
  });
  await sleepNow(t);
  t.clock.advance(99 * 60_000);
  await organize(t);
  assert.equal(t.brain.alertness, "asleep", "在等命令");
  t.clock.advance(90_000);   // 离开始整理过了 100 分钟以上
  await t.brain.tick(); await flush();
  assert.ok(!t.logs.some((l) => l.msg === "sleep watchdog: stuck, waking up"), "看门狗没插一脚");
  assert.equal(t.brain.alertness, "asleep");
  t.clock.advance(30_000); await flush(); await flush();
  assert.equal(t.brain.alertness, "awake");
  assert.equal(JSON.parse(kvGet(t.db, "nightGap") ?? "{}").done, true, "那一夜还算整理好了");
  assert.equal(wakeNotes(t), 1, "只醒一次");
});

// ---------- B：醒来那一页里重启，整页带上的开场也接上睡前那段（#0054 漏洞） ----------

/** 夜里那一觉（睡前有一大段早先的话装不进「最近一段」），整理好醒来；早上这一页记了 6 件事（比最近一段长） */
async function nightThenMorning(sd: string): Promise<TestBrain> {
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, AT);
  t.brain.central.append(t.brain.status().epoch, "main", "say", "很早以前说的、睡前那段装不下的话。".repeat(40));
  await sleepNow(t);
  await organize(t);
  assert.equal(t.brain.alertness, "awake");
  t.clock.advance(4 * 3_600_000);
  const ep = t.brain.status().epoch;
  for (let i = 0; i < 6; i++) t.brain.central.append(ep, "main", "say", `早上做完了第${i}件，结果写在笔记里。`.repeat(6));
  return t;
}

test("B #0054 漏洞：醒来以后、第一次翻页以前 hhd 重启，这一页已经比最近一段长——整页前面照样接上睡前那段和那句说明；夜里的记录不带", async () => {
  const sd = state();
  const t = await nightThenMorning(sd);
  const second = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, t.clock.now() + 60_000, { db: t.db });
  second.brain.wakeRegion("main", "回来了");
  const first = second.driver.latest("main").sent[0]!.text;
  assert.match(first, beforeSleepHead, "那句说明在最前面");
  assert.match(first, /老板今天说要发奖金[\s\S]*那我先想想怎么花[\s\S]*去睡觉了/, "睡前那段");
  assert.doesNotMatch(first, /整理的人/, "夜里整理的记录不带");
  assert.match(first, /夜里的睡眠整理做完了[\s\S]*早上做完了第0件[\s\S]*早上做完了第5件/, "这一页整页都在");
  assert.ok(first.indexOf("去睡觉了") < first.indexOf("夜里的睡眠整理做完了"), "睡前那段在这一页前面");
  assert.doesNotMatch(first, /很早以前说的/, "睡前那段最多「最近一段」那么多");
  assert.equal(first.split(P.BEFORE_SLEEP_NOTE).length, 2, "说明只有一句");
});

test("B 醒来那一页大到要从前面舍：睡前那段照样接上；翻页分叉时舍掉的那截照样补进去，这一页从眼前带到的第一条算起", async () => {
  const sd = state();
  const t = await nightThenMorning(sd);
  const second = makeBrain({ ...NIGHT, stateDir: sd, limits: { rotationTailTokens: 300, restartPageTokens: 400, pageTokens: 50 } }, t.clock.now() + 60_000, { db: t.db });
  second.driver.forkReply = () => ({ ok: false, text: "", error: "api_error:test", total: { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  second.brain.wakeRegion("main", "回来了");
  const main = second.driver.latest("main");
  const first = main.sent[0]!.text;
  assert.match(first, beforeSleepHead);
  assert.match(first, /那我先想想怎么花[\s\S]*去睡觉了/, "睡前那段");
  assert.match(first, /早上做完了第5件/, "这一页最近的在");
  assert.doesNotMatch(first, /早上做完了第0件/, "这一页最早的舍了（restartPageTokens）");
  await main.play({ say: "接着做" });
  await flush(); await flush(); await flush();
  assert.equal(main.forked.length, 1, "分叉压缩了");
  const msg = main.forked[0]!;
  assert.ok(msg.startsWith(P.FORK_GAP_HEAD), "开场里舍掉的那截补在最前面");
  const gap = msg.slice(0, msg.indexOf("【翻页压缩】"));
  assert.match(gap, /早上做完了第0件/, "舍掉的早上那截交给分叉");
  assert.doesNotMatch(gap, /那我先想想怎么花/, "睡前那段不算这一页");
  const b = msg.match(/这一页从「(.+?)」那一条算起/);
  assert.ok(b, "点明这一页从哪条算起");
  assert.match(b![1]!, /早上做完了第[1-5]件/, "从眼前带到的这一页第一条算起（睡前那段在它前面，不再压）");
});

test("B 第一次翻页以后重启：开场照旧只有这一页，不接睡前那段", async () => {
  const sd = state();
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, AT);
  await sleepNow(t);
  await organize(t);
  t.clock.advance(6 * 3_600_000);
  const turned = t.brain.epochs.begin("page-turn", t.brain.central.lastSeq() + 1);   // 早上翻过一页
  for (let i = 0; i < 6; i++) t.brain.central.append(turned.id, "main", "say", `翻页以后做完了第${i}件，结果写在笔记里。`.repeat(6));
  const second = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, t.clock.now() + 60_000, { db: t.db });
  second.brain.wakeRegion("main", "回来了");
  const first = second.driver.latest("main").sent[0]!.text;
  assert.match(first, /翻页以后做完了第0件[\s\S]*翻页以后做完了第5件/);
  assert.doesNotMatch(first, /那我先想想怎么花|去睡觉了/);
  assert.ok(!first.includes(P.BEFORE_SLEEP_NOTE));
});

// ---------- C：醒来那一页主线的开场原样存一份 ----------

const archived = (sd: string): string[] => (existsSync(join(sd, "wake")) ? readdirSync(join(sd, "wake")).filter((f) => f.endsWith(".md")).sort() : []);

test("C 醒来那一页主线的开场原样存一份（stateDir/wake/<日期>-<时分秒>.md：这个会话的前缀和第一条消息，一字不差）；同一个会话后面的不存，重启后的开场再存一份", async () => {
  const sd = state();
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, AT);
  await sleepNow(t);
  await organize(t);
  assert.deepEqual(archived(sd), [], "开场以前不存");
  t.clock.advance(3 * 3_600_000 + 2_000);
  t.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  const main = t.driver.latest("main");
  const files = archived(sd);
  assert.deepEqual(files, ["2026-10-29-060102.md"], "按她的时区记日期和时分秒");
  const body = readFileSync(join(sd, "wake", files[0]!), "utf8");
  assert.ok(body.includes(main.spec.systemAppend), "前缀原样");
  assert.ok(body.includes(main.sent[0]!.text), "第一条消息原样");
  assert.ok(body.indexOf(main.spec.systemAppend) < body.indexOf(main.sent[0]!.text));
  await main.play({ say: "早呀" }); await flush();
  t.brain.inbound({ from: "ada", text: "吃了吗", human: true });
  await flush();
  assert.equal(archived(sd).length, 1, "同一个会话后面的消息不存");
  const second = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, t.clock.now() + 600_000, { db: t.db });
  second.brain.wakeRegion("main", "回来了");
  assert.equal(archived(sd).length, 2, "醒来那一页里重启：她又开了一次场，也存");
  assert.ok(readFileSync(join(sd, "wake", archived(sd)[1]!), "utf8").includes(second.driver.latest("main").sent[0]!.text));
});

test("C 不是醒来那一页的开场不存：平常的一天、小睡醒来、第一次翻页以后", async () => {
  const day = state();
  makeBrain({ stateDir: day }).brain.wakeRegion("main", "开始");
  assert.deepEqual(archived(day), [], "平常的一天");
  const nap = state();
  const n = makeBrain({ stateDir: nap, limits: { mustSleepAtTokens: 1, sleepyAtTokens: 1 } });
  n.brain.epochs.addBlock(1, "一段压缩记忆");
  await n.brain.tick();
  await flush();
  assert.ok(n.driver.latest("main").sent.length > 0, "小睡醒来开了场");
  assert.deepEqual(archived(nap), [], "小睡醒来");
  const sd = state();
  const t = makeBrain({ ...NIGHT, stateDir: sd }, AT);
  await sleepNow(t);
  await organize(t);
  t.brain.epochs.begin("page-turn", t.brain.central.lastSeq() + 1);
  const second = makeBrain({ ...NIGHT, stateDir: sd }, t.clock.now() + 60_000, { db: t.db });
  second.brain.wakeRegion("main", "回来了");
  assert.deepEqual(archived(sd), [], "翻过页了");
});

test("C 存档只留最新的 14 份，别的文件不碰；存不了只记 warn，开场照常", async () => {
  const sd = state();
  const dir = join(sd, "wake");
  mkdirSync(dir, { recursive: true });
  for (let d = 1; d <= 15; d++) writeFileSync(join(dir, `2026-10-${String(d).padStart(2, "0")}-073000.md`), "旧的");
  writeFileSync(join(dir, "notes.txt"), "不是存档");
  const t = makeBrain({ ...NIGHT, stateDir: sd }, AT);
  await sleepNow(t);
  await organize(t);
  t.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  const left = archived(sd);
  assert.equal(left.length, 14);
  assert.equal(left[0], "2026-10-03-073000.md", "最旧的两份删了");
  assert.match(left.at(-1)!, /^2026-10-29-/, "新的那份在");
  assert.ok(existsSync(join(dir, "notes.txt")), "别的文件不碰");

  const bad = state();
  writeFileSync(join(bad, "wake"), "挡路的文件");
  const b = makeBrain({ ...NIGHT, stateDir: bad }, AT);
  await sleepNow(b);
  await organize(b);
  b.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  assert.equal(b.driver.latest("main").sent.length, 1, "开场照常");
  assert.ok(b.logs.some((l) => l.level === "warn" && l.msg === "wake opening: not archived"));
});

// ---------- D：最早那天推迟到下一晚（照指南只写了提案、什么都没应用）：醒来不清压缩块，说法照实；整理好、没整理好的一夜一个字不变 ----------

const D0 = "2026-10-26";
const D1 = "2026-10-27";
const D2 = "2026-10-28";
/** 白天翻页压成的一段（睡前就在前缀里） */
const BLOCK = "白天压的一段：下午把卷尺的弹簧换了，放在左边第二个抽屉。";
/** 夜里放空那条路上记的那一句（一字不差：整理好、没整理好的一夜都不许变） */
const REST = "现在到早上 07:30 是夜里放空：不主动做事；有人找你、感官层报事情，照常处理。";
/** 查没整理的日子那一下（最后一个参数是 pending）照 days 回，每行一个；整理完一天由测试从 days 里拿掉；别的命令都成 */
const pendingIs = (days: string[]) => async (_c: string, args: readonly string[]): Promise<RunResult> =>
  (args.at(-1) === "pending" ? { code: 0, stdout: days.join("\n"), stderr: "" } : OK);
/** 旧整理的这一轮结束（海马说完这一句） */
async function turnEnds(t: TestBrain, say = "NO_REPLY"): Promise<void> {
  await t.driver.latest("hippocampus").play({ say });
  for (let i = 0; i < 4; i++) await flush();
}
/** 「去睡觉了」那一条以后记进中央记忆的 system 那几句（含它） */
const sysFromSleep = (t: TestBrain): string[] => {
  const all = t.brain.central.since(0).filter((e) => e.src === "system").map((e) => e.text);
  return all.slice(all.findIndex((x) => x.startsWith("去睡觉了")));
};
/** 一条日志除了 t / level / mod / msg 的那几个键，照原样的先后（日志行一个字节不差） */
const extra = (l: LogRecord | undefined): string =>
  JSON.stringify(Object.fromEntries(Object.entries(l ?? {}).filter(([k]) => !["t", "level", "mod", "msg"].includes(k))));
const logOf = (t: TestBrain, msg: string): LogRecord | undefined => t.logs.find((l) => l.msg === msg);
const DEFERRED_LOG = "sleep: the same day is still pending (deferred), leaving it for the next night";
const learningLog = (calls: Array<[string, boolean]>): LearningRuntime => ({
  notes: { prefixRebuilt: () => {} }, shelf: () => ({ pages: [], books: [], problems: [] }), scan: () => ({ pages: [], books: [], problems: [] }),
  afterNight: async (day: string, o?: { final?: boolean }) => { calls.push([day, o?.final ?? true]); },
} as unknown as LearningRuntime);

test("D 最早那天推迟到下一晚（叫她接着做一次以后还是那天）：压缩块不清、新前缀里还在；醒来那一页、换前缀、配好的命令照旧；那一句照实说；日志 consolidated false + deferred true", async () => {
  const days = [D1];
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state(), sleep: { wakeRefresh: REFRESH } }, AT, { run: pendingIs(days) });
  t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
  const before = t.brain.status().epoch;
  await sleepNow(t);
  const h = t.driver.latest("hippocampus");
  await turnEnds(t);
  assert.equal(t.brain.alertness, "asleep", "先叫她接着做一次");
  assert.match(h.sent.at(-1)!.text, /【接着整理】[\s\S]*2026-10-27/);
  await turnEnds(t);   // 照指南留到下一晚（额度紧的省电模式：只写了提案），那天还列着
  assert.equal(t.brain.alertness, "awake");
  assert.equal(logOf(t, DEFERRED_LOG)?.day, D1);
  assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK], "压缩块原样留着");
  assert.ok(t.brain.status().compactedTokens > 0);
  assert.ok(t.brain.status().epoch > before, "开了醒来那一页");
  assert.equal(t.brain.epochs.current()!.reason, "wake");
  assert.equal(t.runs.filter((r) => isRefresh(r.cmd, r.args)).length, 1, "配好的命令照样跑一次（快照也要按醒了重新生成）");
  assert.deepEqual(sysFromSleep(t), [
    "去睡觉了（夜里）。",
    `夜里的睡眠整理没做完，剩下的留到下一晚；压缩过的记忆先原样留着。${REST}`,
  ]);
  assert.equal(extra(logOf(t, "night sleep done: resting until morning")), JSON.stringify({ epoch: t.brain.status().epoch, consolidated: false, deferred: true, engine: "legacy" }));
  t.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  const sys = t.driver.latest("main").spec.systemAppend;
  assert.ok(sys.includes(BLOCK), "新会话的前缀里还有白天压的那段");
});

test("D 一夜整理完前面一天、最后那天推迟了：压缩块照样整份留着（推迟那天白天压的块也在里面，分不开）；学习的收尾照旧", async () => {
  const days = [D1, D2];
  const calls: Array<[string, boolean]> = [];
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state() }, AT, { run: pendingIs(days), learning: learningLog(calls) });
  t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
  await sleepNow(t);
  days.shift();                           // 10-27 整理完、落地了
  await turnEnds(t);
  assert.equal(t.brain.alertness, "asleep", "接着整理 10-28");
  assert.equal(t.driver.sessions.filter((s) => s.id === "hippocampus").length, 2);
  await turnEnds(t);                      // 10-28 还列着：叫她接着做一次
  assert.equal(t.brain.alertness, "asleep");
  await turnEnds(t);                      // 还列着：推迟到下一晚
  assert.equal(t.brain.alertness, "awake");
  assert.equal(logOf(t, DEFERRED_LOG)?.day, D2);
  assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK], "只要最后停在推迟上，就整份留着");
  assert.equal(t.brain.epochs.current()!.reason, "wake");
  assert.deepEqual(calls, [[D1, false], [D2, true]], "学习的收尾照旧：前一天只记又犯，最后这天 final");
  assert.match(sysFromSleep(t).at(-1)!, /^夜里的睡眠整理没做完/);
  assert.equal(extra(logOf(t, "night sleep done: resting until morning")), JSON.stringify({ epoch: t.brain.status().epoch, consolidated: false, deferred: true, engine: "legacy" }));
});

test("D 一夜最多那几天的最后一天推迟了：也算推迟（不清压缩块）；睡过了早上才醒，记的那一句也照实说，叫她起来的那句照旧", async () => {
  const days = [D0, D1, D2];
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state() }, AT, { run: pendingIs(days) });
  t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
  await sleepNow(t);
  days.shift(); await turnEnds(t);        // 10-26 整理完
  days.shift(); await turnEnds(t);        // 10-27 整理完
  assert.equal(t.brain.alertness, "asleep");
  await turnEnds(t);                      // 10-28（这一夜第三天）还列着：叫她接着做一次
  assert.equal(t.brain.alertness, "asleep");
  t.clock.advance(4.5 * 3_600_000);       // 做到了早上 07:31 以后
  await turnEnds(t);                      // 还列着
  assert.equal(t.brain.alertness, "awake");
  assert.equal(JSON.parse(kvGet(t.db, "nightGap") ?? "{}").deferred, true, "算推迟（「同一天还列着」那条日志照旧只在没到最多那几天时打）");
  assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK]);
  assert.deepEqual(sysFromSleep(t), ["去睡觉了（夜里）。", "睡醒了（夜里的整理没做完，留到下一晚；压缩过的记忆先原样留着）。"]);
  assert.equal(extra(logOf(t, "woke up")), JSON.stringify({ epoch: t.brain.status().epoch, consolidated: false, deferred: true, engine: "legacy" }));
  await flush(); await flush(); await flush();
  const main = t.driver.latest("main");
  assert.ok(main.sent.at(-1)!.text.includes(`${P.WOKE_UP_AFTER_NIGHT}\n\n${P.FOCUS_PLAN}`), "叫主线起来的那句照旧（补上早上的规划）");
  assert.ok(main.spec.systemAppend.includes(BLOCK), "前缀里还有白天压的那段");
});

test("D 正常整理好的一夜一个字不变：清空压缩块；记的那几句、那一截、日志都照旧（夜里放空、睡过了早上两条路）", async () => {
  for (const late of [false, true]) {
    const days = [D1];
    const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state() }, AT, { run: pendingIs(days) });
    t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
    await sleepNow(t);
    days.shift();                         // 这一跑把那天整理完了
    if (late) t.clock.advance(4.5 * 3_600_000);
    await turnEnds(t, NIGHT_WORK);
    assert.equal(t.brain.alertness, "awake");
    assert.deepEqual(t.brain.epochs.blocks(), [], "清空了压缩块");
    assert.equal(t.brain.epochs.current()!.reason, "wake");
    assert.ok(!logOf(t, DEFERRED_LOG));
    assert.deepEqual(sysFromSleep(t), ["去睡觉了（夜里）。", late ? "睡醒了。" : `夜里的睡眠整理做完了。${REST}`]);
    assert.match(kvGet(t.db, "nightGap")!, /^\{"after":\d+,"upTo":\d+,"done":true\}$/);
    const msg = late ? "woke up" : "night sleep done: resting until morning";
    assert.equal(extra(logOf(t, msg)), JSON.stringify({ epoch: t.brain.status().epoch, consolidated: true, engine: "legacy" }));
    t.brain.inbound({ from: "ada", text: "早", human: true });
    await flush();
    const main = t.driver.latest("main");
    assert.ok(!main.spec.systemAppend.includes(BLOCK), "新前缀里没有白天的块了");
    if (!late) assert.match(main.sent[0]!.text, beforeSleepHead, "睡前那段前面还是原来那句");
  }
});

test("D 没整理好（两次 AUTOMATION_FAILED）的一夜一个字不变：关海马、不开新页、压缩块留着；记的那几句、那一截、日志照旧", async () => {
  for (const late of [false, true]) {
    const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state() }, AT, { run: pendingIs([D1]) });
    t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
    const page = t.brain.status().epoch;
    await sleepNow(t);
    await turnEnds(t, "AUTOMATION_FAILED\n10-27 卡在第 10 步");
    assert.equal(t.brain.alertness, "asleep");
    t.clock.advance(late ? 4.5 * 3_600_000 : 61_000);
    await flush(); await flush();
    assert.equal(t.driver.sessions.filter((s) => s.id === "hippocampus").length, 2, "换个新会话重试");
    const h = t.driver.latest("hippocampus");
    await turnEnds(t, "AUTOMATION_FAILED\n10-27 又卡住了");
    assert.equal(t.brain.alertness, "awake");
    assert.equal(h.closed, true, "放弃时关掉海马");
    assert.equal(t.brain.status().epoch, page, "不开新页");
    assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK], "压缩块留着");
    assert.ok(!logOf(t, DEFERRED_LOG));
    assert.deepEqual(sysFromSleep(t), ["去睡觉了（夜里）。", late ? "睡醒了（这次没整理好，记忆先原样留着）。" : `夜里的睡眠整理这次没做好，记忆先原样留着。${REST}`]);
    assert.match(kvGet(t.db, "nightGap")!, /^\{"after":\d+,"upTo":\d+,"done":false\}$/);
    const msg = late ? "woke up" : "night sleep done: resting until morning";
    assert.equal(extra(logOf(t, msg)), JSON.stringify({ epoch: page, consolidated: false, engine: "legacy" }));
  }
});

test("D 推迟了的一夜醒来：开场照样带睡着以前那段，前面那句照实说（不说夜里整理做完了）；醒来那一页里重启，整页前面也接上", async () => {
  const sd = state();
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, AT, { run: pendingIs([D1]) });
  t.brain.central.append(t.brain.status().epoch, "main", "say", "很早以前说的、睡前那段装不下的话。".repeat(40));
  await sleepNow(t);
  await turnEnds(t, NIGHT_WORK);
  await turnEnds(t);
  assert.equal(t.brain.alertness, "awake");
  const gap = JSON.parse(kvGet(t.db, "nightGap") ?? "{}") as { done?: boolean; deferred?: boolean; upTo?: number };
  assert.equal(gap.done, false, "不算整理好");
  assert.equal(gap.deferred, true);
  assert.equal(P.BEFORE_SLEEP_DEFERRED_NOTE, "（开头这一段是我睡着以前的最后一段；夜里的整理在这之后，没做完，留到下一晚。从上次翻页到这一段之间的事不在眼前，要用就翻原话。）");
  const deferredHead = new RegExp(`下面是我最近的经历：\\n${reEsc(P.BEFORE_SLEEP_DEFERRED_NOTE)}\\n`);

  t.brain.inbound({ from: "ada", text: "早", human: true });
  await flush();
  const first = t.driver.latest("main").sent[0]!.text;
  assert.match(first, deferredHead, "那段前面那句照实说");
  assert.ok(!first.includes(P.BEFORE_SLEEP_NOTE), "不说「夜里的整理是在这之后做的」");
  assert.match(first, /老板今天说要发奖金[\s\S]*那我先想想怎么花[\s\S]*去睡觉了/, "睡前那段带着");
  assert.doesNotMatch(first, /整理的人/, "夜里整理的记录不带");
  assert.equal(first.split(P.BEFORE_SLEEP_DEFERRED_NOTE).length, 2, "说明只有一句");

  // 醒来那一页里、第一次翻页以前重启（这一页已经比最近一段长）：整页前面照样接上睡前那段和那句
  await t.driver.latest("main").play({ say: "早" }); await flush();
  t.clock.advance(4 * 3_600_000);
  const ep = t.brain.status().epoch;
  for (let i = 0; i < 6; i++) t.brain.central.append(ep, "main", "say", `早上做完了第${i}件，结果写在笔记里。`.repeat(6));
  const second = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: sd }, t.clock.now() + 60_000, { db: t.db, run: pendingIs([D1]) });
  second.brain.wakeRegion("main", "回来了");
  const again = second.driver.latest("main").sent[0]!.text;
  assert.match(again, deferredHead);
  assert.match(again, /那我先想想怎么花[\s\S]*去睡觉了[\s\S]*夜里的睡眠整理没做完[\s\S]*早上做完了第0件[\s\S]*早上做完了第5件/);
  assert.doesNotMatch(again, /整理的人|很早以前说的/);
  assert.ok(!again.includes(P.BEFORE_SLEEP_NOTE));
});

test("D 推迟了的一夜醒来、夜里放空时压缩块还在困的线以上：闲过 20 分钟也不小睡（小睡会清掉留着的块、再记一句「做完了」），到了必须睡的线照睡", async () => {
  const limits = { rotationTailTokens: 300, sleepyAtTokens: 10, mustSleepAtTokens: 1_000_000 };
  const t = makeBrain({ ...NIGHT, stateDir: state(), limits }, AT, { run: pendingIs([D1]) });
  t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
  assert.ok(t.brain.status().compactedTokens >= limits.sleepyAtTokens, "块在困的线以上");
  await sleepNow(t);
  await turnEnds(t);
  await turnEnds(t);                      // 推迟到下一晚
  assert.equal(t.brain.alertness, "awake");
  assert.equal(t.brain.status().nightRest, true);
  t.clock.advance(25 * 60_000);
  await t.brain.tick(); await flush(); await flush();
  assert.notEqual(t.brain.alertness, "asleep", "夜里放空不小睡");
  assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK], "留着的块还在");
  assert.ok(!sysFromSleep(t).some((x) => x.startsWith("去睡觉了（困了")), "没有小睡");
  assert.match(sysFromSleep(t).at(-1)!, /^夜里的睡眠整理没做完/, "最后那一句还是照实的那句，没有「做完了」");

  // 必须睡（块到上限）不受夜里放空挡：照旧马上小睡
  const m = makeBrain({ ...NIGHT, stateDir: state(), limits: { ...limits, mustSleepAtTokens: 10 } }, AT, { run: pendingIs([D1]) });
  m.brain.epochs.addBlock(m.brain.status().epoch, BLOCK);
  await sleepNow(m);
  await turnEnds(m);
  await turnEnds(m);
  assert.equal(m.brain.status().nightRest, true);
  await m.brain.tick(); await flush(); await flush();
  assert.ok(sysFromSleep(m).some((x) => x.startsWith("去睡觉了（压缩块到上限")), "到了上限照睡");
});

test("D 一夜整理完最多那几天、后面还有日子列着：也算推迟——压缩块留着、说法照实、日志 consolidated false + deferred true（原来这一夜算整理好，清空了块、说「做完了」）", async () => {
  const days = ["2026-10-25", D0, D1, D2];
  const t = makeBrain({ ...NIGHT, ...WAKE_TAIL, stateDir: state() }, AT, { run: pendingIs(days) });
  t.brain.epochs.addBlock(t.brain.status().epoch, BLOCK);
  await sleepNow(t);
  for (let i = 0; i < 3; i++) {
    assert.equal(t.brain.alertness, "asleep");
    days.shift();                         // 这一跑把最早那天整理完了
    await turnEnds(t);
  }
  assert.equal(t.brain.alertness, "awake", "最多 3 天，10-28 留到下一晚");
  assert.deepEqual(days, [D2]);
  assert.deepEqual(t.brain.epochs.blocks().map((b) => b.text), [BLOCK], "压缩块留着（10-28 白天压的块就在里面）");
  assert.equal(t.brain.epochs.current()!.reason, "wake", "醒来那一页照开");
  assert.ok(!logOf(t, DEFERRED_LOG), "不是同一天还列着，不打那条");
  assert.deepEqual(sysFromSleep(t), ["去睡觉了（夜里）。", P.nightRestNote("07:30", "deferred")]);
  assert.equal(JSON.parse(kvGet(t.db, "nightGap") ?? "{}").deferred, true);
  assert.equal(extra(logOf(t, "night sleep done: resting until morning")), JSON.stringify({ epoch: t.brain.status().epoch, consolidated: false, deferred: true, engine: "legacy" }));
});

test("organizerOf: the config's organizer when it names one; none named and the night module on, the module's general guide (steps 0 to 10, progress in sleep/state.json, the night command's sleep_apply)", async () => {
  const { organizerOf } = await import("../src/sleep/guide.ts");
  const own = { guide: "notes/night-guide.md", firstStep: "1", lastStep: "7" };
  assert.deepEqual(organizerOf({ sleep: { organizer: own } } as never, "/m/night"), own);
  assert.deepEqual(organizerOf({ sleep: {} } as never, "/m/night"), { guide: "/m/night/scripts/sleep_organize.md", firstStep: "0", lastStep: "10", state: "sleep/state.json", apply: "night sleep_apply" });
  assert.deepEqual(organizerOf({ sleep: {} } as never, null), {});
  // the guide in the role's language when the module has one, else the English one
  const night = tmpDir("hh-night-guide-");
  mkdirSync(join(night, "scripts"));
  writeFileSync(join(night, "scripts", "sleep_organize.md"), "# Night organizing\n");
  writeFileSync(join(night, "scripts", "sleep_organize.zh.md"), "# 夜里整理\n");
  assert.equal(organizerOf({ sleep: {}, lang: "zh" } as never, night).guide, join(night, "scripts", "sleep_organize.zh.md"));
  assert.equal(organizerOf({ sleep: {}, lang: "en" } as never, night).guide, join(night, "scripts", "sleep_organize.md"));
  assert.equal(organizerOf({ sleep: {}, lang: "fr" } as never, night).guide, join(night, "scripts", "sleep_organize.md"));
  assert.equal(organizerOf({ sleep: {} } as never, night).guide, join(night, "scripts", "sleep_organize.md"));
});
