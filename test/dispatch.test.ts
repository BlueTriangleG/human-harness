import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decideDispatch, chatActivity, helperSessionsDir } from "../src/basal/dispatch.ts";
import type { Entry } from "../src/memory/central.ts";

const base = { caller: "front" as const, pri: "T2" as const, busyChat: false, doingTopics: ["A", "B"], thresholdMin: 5 };

test("分派：5 分钟以内自己做；超过且有空的交出去；都占着时聊得少自己做、聊得多进记事本", () => {
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 5, freeBackground: "side-1" }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 30, freeBackground: "side-1" }), { kind: "background", region: "side-1" });
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 30, freeBackground: null }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 30, freeBackground: null, busyChat: true }), { kind: "notebook", doing: ["A", "B"] });
});

test("分派：没填 about 当 5 分钟以内", () => {
  assert.deepEqual(decideDispatch({ ...base, aboutMin: null, freeBackground: "side-1" }), { kind: "self" });
});

test("分派：T0 后台都忙时前台做，不管聊得多不多", () => {
  assert.deepEqual(decideDispatch({ ...base, pri: "T0", aboutMin: 120, freeBackground: null, busyChat: true }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, pri: "T0", aboutMin: 120, freeBackground: "side-1", busyChat: true }), { kind: "background", region: "side-1" });
});

test("分派：后台自己 on_it 不再往外分", () => {
  assert.deepEqual(decideDispatch({ ...base, caller: "background", aboutMin: 120, freeBackground: "side-2" }), { kind: "self" });
});

const T = Date.UTC(2026, 9, 31, 1, 0);
let seq = 0;
const input = (min: number, from: string): Entry => ({ seq: ++seq, ts: T - min * 60_000, epoch: 1, src: "外界", kind: "input", text: "hi", tokens: 1, meta: { from, human: true } });
const sent = (min: number): Entry => ({ seq: ++seq, ts: T - min * 60_000, epoch: 1, src: "main", kind: "note", text: "（发给 ada）嗯", tokens: 1, meta: { sent: true, to: "x" } });
const cfg = { windowMin: 15, count: 3, exchangeMin: 5 };

test("聊得多不多：15 分钟内 3 条算多；5 分钟内一来一回算多；20 分钟前的不算", () => {
  const a = chatActivity([input(12, "ada"), input(10, "ada"), input(8, "ada")], T, cfg);
  assert.equal(a.busy, true);
  assert.deepEqual(a.counts, [{ who: "ada", n: 3 }]);
  assert.equal(chatActivity([input(4, "小贝"), sent(3)], T, cfg).busy, true);
  assert.equal(chatActivity([input(20, "ada"), input(19, "ada"), input(18, "ada")], T, cfg).busy, false);
  assert.equal(chatActivity([input(10, "ada")], T, cfg).busy, false);
});

import { readLoadTight } from "../src/basal/dispatch.ts";
import { writeFileSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
test("负载门槛跟 load.py gate cc 一样：偏紧照样放行，只在危险、剩余不够 1.2GB、冷却中时拦", () => {
  const dir = tmpDir("hh-load-");
  const f = join(dir, "status.json");
  const now = 1_793_407_707_000;
  const w = (o: object) => writeFileSync(f, JSON.stringify({ t: now / 1000, level: "tight", headroom_mb: 10_588, cooldown: {}, ...o }));
  w({}); assert.equal(readLoadTight(f, now), false);
  w({ level: "danger" }); assert.equal(readLoadTight(f, now), true);
  w({ headroom_mb: 900 }); assert.equal(readLoadTight(f, now), true);
  w({ cooldown: { cc: now / 1000 + 600 } }); assert.equal(readLoadTight(f, now), true);
  w({ cooldown: { cc: now / 1000 - 600 } }); assert.equal(readLoadTight(f, now), false);
  w({ level: "danger", t: now / 1000 - 3600 }); assert.equal(readLoadTight(f, now), false);   // 太旧不算
});

test("分派：额度或电脑紧的时候，长活不往外分、她自己做（ada 11-03：不拦她），聊得多也一样；T0 照样前台做", () => {
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 30, freeBackground: null, gated: true }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 30, freeBackground: null, gated: true, busyChat: true }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, pri: "T0", aboutMin: 30, freeBackground: null, gated: true }), { kind: "self" });
  assert.deepEqual(decideDispatch({ ...base, aboutMin: 3, freeBackground: null, gated: true }), { kind: "self" });
});

test("helper sessions are where the helpers module keeps them: its sessionsDir, else its own state; module off: nowhere", () => {
  const stateDir = "/s";
  assert.equal(helperSessionsDir({ stateDir, modules: { helpers: { enabled: true } } }), "/s/modules/helpers/sessions");
  assert.equal(helperSessionsDir({ stateDir, modules: { helpers: { enabled: true, sessionsDir: "/cc" } } }), "/cc");
  assert.equal(helperSessionsDir({ stateDir, modules: { helpers: { sessionsDir: "/cc" } } }), null);
  assert.equal(helperSessionsDir({ stateDir }), null);
});
