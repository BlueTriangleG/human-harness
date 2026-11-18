// 「想干等」那句提示要用得上：以前要连着空转超过 3 轮才出现；11-13 09:00–09:25 她空一轮、动一下，
// 连着空转的计数一直清零，143 个专注轮里那句一次都没出来（那时她以为一边做的那头在读史记，其实没起来）。
// 现在最近 6 个专注轮里有 3 个空轮、又不是一口气连着空的（空一轮动一下），也给带「想干等」的那句。只改提示什么时候出现，叫醒的节奏不变：一停就叫。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeBrain, flush } from "./helpers.ts";
import * as P from "../src/lang/zh/prompts.ts";

// 11-13 09:00:07 起那一段专注轮，照 hh.jsonl 原样：A = 那一轮调了工具，I = 只调了一次就收尾（空轮）。取前 40 轮
const RHYTHM_0900 = "AIAIAIAIAIAIAIAIAIAIAIAIAAAAAAAIAAIAAIAA";

async function focusBrain() {
  const t = makeBrain({}, Date.UTC(2026, 9, 29, 10, 0));
  t.brain.addWork("now", 120, "写周报");
  await t.brain.tick();
  return { t, main: t.driver.latest("main") };
}

test("想干等：照 11-13 09:00 那段「动一下、空一轮」的节奏回放，带「想干等」的那句在前十轮内出现；每一轮之后照旧几秒就叫", async () => {
  const { t, main } = await focusBrain();
  const texts: string[] = [];
  for (const [i, turn] of [...RHYTHM_0900].entries()) {
    const before = main.sent.length;
    if (turn === "A") await main.play({ tool: { name: "jot_down", args: { text: `第 ${i + 1} 轮做了一点` } }, say: "NO_REPLY" });
    else await main.play({ say: "NO_REPLY" });
    await flush();
    t.clock.advance(2_000); await flush();
    assert.equal(main.sent.length, before + 1, `第 ${i + 1} 轮之后几秒就叫（节奏不变）`);
    texts.push(main.sent.at(-1)!.text);
  }
  const first = texts.findIndex((x) => x.includes("就想干等"));
  assert.ok(first >= 0 && first < 10, `前十轮内出现（第 ${first + 1} 轮之后）`);
  assert.equal(texts[first], `${P.FOCUS_CONTINUE}\n${P.FOCUS_IDLE_OFTEN}`);
  assert.doesNotMatch(texts[first]!, /连着好几轮/, "不是连着空转：不说「连着」");
  for (const [i, turn] of [...RHYTHM_0900].entries()) {
    if (turn === "A") assert.equal(texts[i], P.FOCUS_CONTINUE, `第 ${i + 1} 轮动了手：照旧只说接着专注`);
  }
  // 说了想干等：走原来那条，一分钟叫一次
  const before = main.sent.length;
  await main.play({ say: "最近没事，不想找别的事干，就想干等" });
  await flush();
  t.clock.advance(2_000); await flush();
  assert.equal(main.sent.length, before, "说了想干等：不再几秒就叫");
  t.clock.advance(60_000); await flush();
  assert.equal(main.sent.length, before + 1, "一分钟叫一次");
  assert.equal(main.sent.at(-1)!.text, P.FOCUS_WAITING);
});

test("想干等：连着空转的照旧——前三轮找事做，第四轮才给「连着好几轮」那句；先动一下手再连着空也一样，不按比例给", async () => {
  const { t, main } = await focusBrain();
  await main.play({ tool: { name: "jot_down", args: { text: "先做了一点" } }, say: "NO_REPLY" });
  await flush();
  t.clock.advance(2_000); await flush();
  for (let i = 0; i < 4; i++) {
    await main.play({ say: "NO_REPLY" });
    await flush();
    t.clock.advance(2_000); await flush();
    assert.equal(main.sent.at(-1)!.text, `${P.FOCUS_CONTINUE}\n${i < 3 ? P.FOCUS_FIND_WORK : P.FOCUS_IDLE_LONG}`, `连着第 ${i + 1} 轮空转`);
  }
});

test("想干等：专注一段结束就清零，下一段不带上一段的空轮", async () => {
  const { t, main } = await focusBrain();
  for (const turn of "AIAI") {
    if (turn === "A") await main.play({ tool: { name: "jot_down", args: { text: "做了一点" } }, say: "NO_REPLY" });
    else await main.play({ say: "NO_REPLY" });
    await flush();
    t.clock.advance(2_000); await flush();
  }
  t.brain.stopWork();
  await main.play({ say: "NO_REPLY" });   // 专注外的一轮：清零
  await flush();
  t.brain.addWork("now", 60, "写周报");
  await t.brain.tick();
  await main.play({ say: "NO_REPLY" });
  await flush();
  t.clock.advance(2_000); await flush();
  assert.equal(main.sent.at(-1)!.text, `${P.FOCUS_CONTINUE}\n${P.FOCUS_FIND_WORK}`, "新一段第一个空轮：照旧找事做");
});
