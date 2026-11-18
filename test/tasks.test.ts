import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/store/db.ts";
import { TaskBook, parseDuration } from "../src/basal/tasks.ts";

test("时长：中文和区间都能解析，看不懂的当 null", () => {
  assert.equal(parseDuration("3分钟"), 3);
  assert.equal(parseDuration("半小时"), 30);
  assert.equal(parseDuration("两小时"), 120);
  assert.equal(parseDuration("一两个小时"), 120);
  assert.equal(parseDuration("1-2h"), 120);
  assert.equal(parseDuration("90m"), 90);
  assert.equal(parseDuration("1.5小时"), 90);
  assert.equal(parseDuration("一个半小时"), 90);
  assert.equal(parseDuration("二十分钟"), 20);
  assert.equal(parseDuration("十五分钟"), 15);
  assert.equal(parseDuration("一刻钟"), 15);
  assert.equal(parseDuration("看情况"), null);
  assert.equal(parseDuration(undefined), null);
});

test("tasks：开始、做完、钟表时间、帮手归属、等人", () => {
  let now = Date.UTC(2026, 9, 31, 1, 0);
  const book = new TaskBook(openDb(":memory:"), () => now);
  const t = book.start({ topic: "剪祥子", owner: "side-1", aboutMin: 30, pri: "T1", askedBy: "ada" });
  assert.equal(book.doing("side-1").length, 1);
  assert.equal(book.byTopic("剪祥子")?.id, t.id);
  book.addHelper(t.id, "sakiko");
  assert.equal(book.ownerOfHelper("sakiko")?.owner, "side-1");
  book.setWaiting(t.id, "ada");
  assert.equal(book.doing()[0]!.waitingFor, "ada");
  assert.equal(book.bumpIdle(t.id), 1);
  book.resetIdle(t.id);
  now += 40 * 60_000;
  const done = book.finish(t.id, "done", 35);
  assert.equal(done.state, "done");
  assert.equal(done.ended, now);
  assert.equal(done.tookMin, 35);
  assert.equal(book.doing().length, 0);
  assert.equal(book.ownerOfHelper("sakiko"), undefined);
});

test("tasks：挂过的页记在任务上，没记过是 null，记空数组读回来是空数组，再记一次整个换掉", () => {
  const book = new TaskBook(openDb(":memory:"), () => Date.UTC(2026, 10, 1, 1, 0));
  const t = book.start({ topic: "剪祥子", owner: "side-1", aboutMin: 30, pri: "T1", askedBy: "ada" });
  assert.equal(t.pages, null);
  book.setPages(t.id, []);
  assert.deepEqual(book.byId(t.id).pages, []);
  book.setPages(t.id, ["0012", "0020"]);
  assert.deepEqual(book.byId(t.id).pages, ["0012", "0020"]);
  assert.deepEqual(book.doing("side-1")[0]!.pages, ["0012", "0020"]);
  book.setPages(t.id, ["0012", "0020", "0031"]);
  assert.deepEqual(book.byId(t.id).pages, ["0012", "0020", "0031"]);
});

test("tasks：暂停、换人、按时间找暂停的", () => {
  let now = Date.UTC(2026, 9, 31, 1, 0);
  const book = new TaskBook(openDb(":memory:"), () => now);
  const t = book.start({ topic: "核论文", owner: "side-2", aboutMin: 20, pri: "T2", askedBy: null });
  book.reassign(t.id, "main");
  assert.equal(book.doing("main")[0]!.topic, "核论文");
  now += 60_000;
  book.pause(t.id);
  assert.equal(book.doing().length, 0);
  assert.deepEqual(book.pausedSince(now - 120_000).map((x) => x.topic), ["核论文"]);
  assert.deepEqual(book.pausedSince(now + 1), []);
});

test("准头：钟表时间对估计的平均比；不足 3 件不给", () => {
  let now = Date.UTC(2026, 9, 31, 1, 0);
  const book = new TaskBook(openDb(":memory:"), () => now);
  for (const took of [15, 20]) {
    const t = book.start({ topic: `a${took}`, owner: "side-1", aboutMin: 10, pri: "T2", askedBy: null });
    now += took * 60_000; book.finish(t.id, "done", null);
  }
  assert.equal(book.calibration(), null);
  const t = book.start({ topic: "a10", owner: "side-1", aboutMin: 10, pri: "T2", askedBy: null });
  now += 10 * 60_000; book.finish(t.id, "follow", null);
  assert.deepEqual(book.calibration(), { n: 3, ratio: 1.5 });
});

test("时长：口语里常见的说法", () => {
  assert.equal(parseDuration("大概半小时"), 30);
  assert.equal(parseDuration("半小时左右"), 30);
  assert.equal(parseDuration("约半小时"), 30);
  assert.equal(parseDuration("一个多小时"), 90);
  assert.equal(parseDuration("几个小时"), 180);
  assert.equal(parseDuration("十几分钟"), 15);
  assert.equal(parseDuration("三四十分钟"), 40);
  assert.equal(parseDuration("二三十分钟"), 30);
  assert.equal(parseDuration("10来分钟"), 10);
  assert.equal(parseDuration("半天"), 240);
  assert.equal(parseDuration("一天"), 480);
  assert.equal(parseDuration("15分钟到半小时"), 30);
  assert.equal(parseDuration("1h30m"), 90);
  assert.equal(parseDuration("1小时30分钟"), 90);
  assert.equal(parseDuration("3 months"), null);
});

test("准头：用总实际 / 总估计（一件忘了关的不会把平均拉飞）", () => {
  let now = Date.UTC(2026, 9, 31, 1, 0);
  const book = new TaskBook(openDb(":memory:"), () => now);
  for (const [about, took] of [[2, 600], [10, 10], [10, 10]] as const) {
    const t = book.start({ topic: `x${about}${took}`, owner: "side-1", aboutMin: about, pri: "T2", askedBy: null });
    now += took * 60_000; book.finish(t.id, "done", null);
  }
  assert.deepEqual(book.calibration(), { n: 3, ratio: 28.2 });
});

test("tasks：做完以后紧接着的收尾话还算那件事；新开一件以后就算新的（10-31 线上看到收尾那句没标）", () => {
  let now = Date.UTC(2026, 9, 31, 3, 32);
  const book = new TaskBook(openDb(":memory:"), () => now);
  const a = book.start({ topic: "看v15", owner: "side-1", aboutMin: 20, pri: "T1", askedBy: null });
  now += 60_000; book.finish(a.id, "done", null);
  assert.equal(book.atTime("side-1", now + 4_000)?.topic, "看v15");
  now += 10 * 60_000;
  book.start({ topic: "剪祥子", owner: "side-1", aboutMin: 30, pri: "T2", askedBy: null });
  assert.equal(book.atTime("side-1", now + 1_000)?.topic, "剪祥子");
  assert.equal(book.atTime("side-1", now - 9 * 60_000)?.topic, "看v15");
  assert.equal(book.atTime("side-2", now), undefined);
});

test("标准：开头记下当初要的原话；定标准、改标准；回头看几次、上次还差什么都记在那件事上（ada 10-31）", () => {
  const now = Date.UTC(2026, 9, 31, 5, 14);
  const book = new TaskBook(openDb(":memory:"), () => now);
  const t = book.start({ topic: "拆同类视频", owner: "side-1", aboutMin: 60, pri: "T1", askedBy: "ada", ask: "今天有空多分析一下别人的视频火的理由" });
  assert.equal(t.ask, "今天有空多分析一下别人的视频火的理由");
  assert.equal(t.bar, null);
  assert.equal(t.looks, 0);
  book.setBar(t.id, "至少看完三条爆款的内容");
  assert.equal(book.byId(t.id).bar, "至少看完三条爆款的内容");
  assert.equal(book.noteLook(t.id, "没看任何一条爆款的内容"), 1);
  assert.equal(book.noteLook(t.id, "封面还没比"), 2);
  assert.equal(book.byId(t.id).missing, "封面还没比");
  assert.equal(book.start({ topic: "自己的事", owner: "main", aboutMin: 3, pri: "T2", askedBy: null }).ask, null);
});

test("#0052 帮手挂到过别的事上没有：不论那件事什么状态，名字要整个对上", () => {
  const book = new TaskBook(openDb(":memory:"), () => Date.UTC(2026, 10, 9, 1, 0));
  const a = book.start({ topic: "英国人那期", owner: "side-1", aboutMin: 30, pri: "T1", askedBy: null });
  const b = book.start({ topic: "荆轲那期", owner: "main", aboutMin: 60, pri: "T1", askedBy: null });
  book.addHelper(a.id, "walker-anim");
  book.finish(a.id, "done", 20);
  assert.equal(book.helperSeenElsewhere("walker-anim", b.id), true, "做完的事上挂过也算");
  assert.equal(book.helperSeenElsewhere("walker-anim", a.id), false, "只挂在自己身上不算别处");
  assert.equal(book.helperSeenElsewhere("walker", b.id), false, "名字的一截不算");
  assert.equal(book.helperSeenElsewhere("crab-edit", b.id), false);
});
