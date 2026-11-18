import { test } from "node:test";
import assert from "node:assert/strict";
import { attachHelperTo } from "../src/basal/lifecycle.ts";
import type { TaskRow } from "../src/basal/tasks.ts";

test("#0052 前台派的帮手挂不挂到前台那件事上：那件事还新鲜、帮手是在这件事里出生的才挂", () => {
  const T = Date.UTC(2026, 10, 9, 1, 0);
  const task: TaskRow = { id: 296, topic: "史记荆轲那期：亲笔口播 v1", owner: "main", aboutMin: 60, pri: "T1", askedBy: null, state: "doing", started: T, ended: null, tookMin: null, helpers: [], waitingFor: null, idleWakes: 0, bar: null, ask: null, looks: 0, missing: null, pages: null };
  assert.equal(attachHelperTo({ task, helper: "jk-vo", now: T + 10 * 60_000, seenElsewhere: false }), true, "刚开始、新帮手：挂");
  assert.equal(attachHelperTo({ task, helper: "jk-vo", now: T + 120 * 60_000, seenElsewhere: false }), true, "正好 2 倍估时：还算新鲜");
  assert.equal(attachHelperTo({ task, helper: "jk-vo", now: T + 121 * 60_000, seenElsewhere: false }), false, "超过 2 倍估时：不挂");
  assert.equal(attachHelperTo({ task, helper: "walker-anim", now: T + 10 * 60_000, seenElsewhere: true }), false, "挂在别的事上过的帮手：不挂");
  assert.equal(attachHelperTo({ task: { ...task, helpers: ["walker-anim"] }, helper: "walker-anim", now: T + 10 * 60_000, seenElsewhere: true }), true, "已经挂在这件事上：照旧算它的");
  assert.equal(attachHelperTo({ task: { ...task, aboutMin: null }, helper: "x", now: T + 60 * 60_000, seenElsewhere: false }), true, "没估时按 30 分钟：60 分钟还新鲜");
  assert.equal(attachHelperTo({ task: { ...task, aboutMin: null }, helper: "x", now: T + 61 * 60_000, seenElsewhere: false }), false, "没估时按 30 分钟：61 分钟不新鲜");
});
