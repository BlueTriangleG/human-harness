// 开会话当场抛错没人接住（11-13：退路模型和主模型相同，SDK 开会话就抛）：
// 09:00 她派 side-1 读史记卷110，支线没起来，她以为在读，空等了 25 分钟、挂了 140 分钟才被当成做太久放下；
// 09:28、10:33 翻页退到海马，海马开不起来，两次都卡到 20 分钟看门狗。
// 现在：派活前先把会话开起来，开不起来当场告诉她；接着做的、慢慢想的开不起来就放下或排着；翻页、夜里整理照失败处理，不等看门狗。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrain, flush } from "./helpers.ts";
import { FakeDriver } from "../src/kernel/fake.ts";
import { openDb, kvGet } from "../src/store/db.ts";
import * as P from "../src/lang/zh/prompts.ts";

const WHY = "Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.";
const lastResult = (t: ReturnType<typeof makeBrain>) => t.brain.central.since(0).filter((e) => e.kind === "result").at(-1)!.text;
const opened = (t: ReturnType<typeof makeBrain>, id: string) => t.driver.sessions.filter((s) => s.id === id).length;

test("派支线：那头当场开不起来——这一轮就告诉她没交出去，任务表里不挂、认领放掉；那头好了再派照常交出去", async () => {
  const t = makeBrain();
  let broken = true;
  t.driver.openError = (s) => (broken && s.id.startsWith("side-") ? WHY : null);
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "on_it", args: { topic: "读史记卷110", about: "20分钟" } } });
  assert.equal(lastResult(t), P.sideNotStarted("读史记卷110"), "当轮就收到没交出去");
  assert.match(lastResult(t), /没交出去/);
  assert.equal(t.brain.tasks.doing().length, 0, "任务表里不挂着在做");
  assert.equal(opened(t, "side-1"), 0);
  assert.ok(t.logs.some((l) => l.msg === "dispatch: side session would not open, not handed off" && l.level === "error"));
  assert.ok(t.logs.some((l) => l.msg === "session open failed" && l.region === "side-1"));
  broken = false;
  await t.driver.latest("main").play({ tool: { name: "on_it", args: { topic: "读史记卷110", about: "20分钟" } } });
  await flush();
  assert.equal(lastResult(t), P.HANDED_OFF, "认领放掉了：同一件再派不说「已经在弄了」");
  assert.equal(t.brain.tasks.doing("side-1")[0]!.topic, "读史记卷110");
  assert.match(t.driver.latest("side-1").sent.at(-1)!.text, /【接着做】读史记卷110/);
});

test("重启时接着做的事，那头开不起来：hhd 照常起来，这件放下、认领放掉，给她记一笔看得到的", () => {
  const db = openDb(":memory:");
  const first = makeBrain({}, undefined, { db });
  first.brain.tasks.start({ topic: "剪片子的第二段", owner: "side-1", aboutMin: 30, pri: "T2", askedBy: null });
  const driver = new FakeDriver();
  driver.openError = (s) => (s.id === "side-1" ? WHY : null);
  const t = makeBrain({}, undefined, { db, driver });   // 不抛：启动时 resumeBackgrounds 接住了
  assert.equal(t.brain.tasks.doing("side-1").length, 0);
  assert.ok(t.brain.central.since(0).some((e) => e.src === "side-1" && e.kind === "note" && e.text === P.sideNotOpened("剪片子的第二段")));
  assert.ok(t.logs.some((l) => l.msg === "side: session would not open, task put down" && l.topic === "剪片子的第二段"));
});

test("慢慢想：那头开不起来——当场说还没开始想，不算在想，还排着；十分钟里不反复试，过了再试、好了就开始想", async () => {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));   // 白天（测试配置 01:30 睡，03:00 一 tick 就去睡了）
  let broken = true;
  t.driver.openError = (s) => (broken && s.id === "deep" ? WHY : null);
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ tool: { name: "mull_over", args: { what: "查清黄仁勋那封信的原文出处" } } });
  assert.equal(lastResult(t), P.MULL_NOT_STARTED);
  assert.equal(kvGet(t.db, "deep-current") ?? "", "", "手上不算在想");
  assert.deepEqual(JSON.parse(kvGet(t.db, "deep-queue") ?? "[]"), ["查清黄仁勋那封信的原文出处"], "还排着");
  const fails = () => t.logs.filter((l) => l.msg === "deep: session would not open, kept in the queue").length;
  assert.equal(fails(), 1);
  t.clock.advance(5 * 60_000);
  await t.brain.tick(); await flush();
  assert.equal(fails(), 1, "十分钟里不再试");
  await t.driver.latest("main").play({ tool: { name: "mull_over", args: { what: "再想一件" } } });
  assert.equal(lastResult(t), P.MULL_NOT_STARTED, "那头还没好：这件也说没开始想");
  broken = false;
  t.clock.advance(6 * 60_000);
  await t.brain.tick(); await flush();
  assert.equal(opened(t, "deep"), 1, "过了十分钟再试，开起来了");
  assert.match(t.driver.latest("deep").sent.at(-1)!.text, /查清黄仁勋那封信的原文出处/);
  assert.equal(kvGet(t.db, "deep-current"), "查清黄仁勋那封信的原文出处");
  assert.deepEqual(JSON.parse(kvGet(t.db, "deep-queue") ?? "[]"), ["再想一件"]);
});

test("翻页退到海马、海马开不起来：这一次马上放弃（不等 20 分钟看门狗），页留着，隔一阵再试", async () => {
  const t = makeBrain({ limits: { pageTokens: 50 } });
  t.driver.openError = (s) => (s.id === "hippocampus" ? WHY : null);
  t.brain.wakeRegion("main", "开始");
  await t.driver.latest("main").play({ say: "很多很多的经历".repeat(20) });
  await flush(); await flush();
  assert.ok(t.logs.some((l) => l.msg === "page turn: hippocampus would not open, giving up this time" && l.level === "error"));
  assert.equal(t.brain.status().turning, false, "当场就不在翻页了");
  assert.ok(!t.logs.some((l) => /page turn watchdog/.test(l.msg)));
  t.brain.wakeRegion("main", "接着");
  assert.match(t.driver.latest("main").sent.at(-1)!.text, /接着/, "主线照常叫得醒");
});

test("夜里整理、海马开不起来：照整理失败处理——过一会儿再试一次，还不行就带着压缩块醒来，不等整夜看门狗", async () => {
  const t = makeBrain();
  t.driver.openError = (s) => (s.id === "hippocampus" ? WHY : null);
  await t.brain.sleep("夜里", "night");
  await flush(); await flush();
  assert.ok(t.logs.some((l) => l.msg === "sleep: hippocampus would not open"));
  assert.ok(t.logs.some((l) => l.msg === "sleep: organizing failed"));
  assert.equal(t.brain.alertness, "asleep", "先不醒：过一会儿再试一次");
  t.clock.advance(60_000); await flush(); await flush(); await flush();
  assert.equal(t.logs.filter((l) => l.msg === "sleep: hippocampus would not open").length, 2);
  assert.ok(t.logs.some((l) => l.msg === "sleep: organizing failed, waking up with blocks kept"));
  assert.equal(t.brain.alertness, "awake");
});
