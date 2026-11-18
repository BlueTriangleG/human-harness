// The outbound filter (src/gate/outbound.ts): which lines are refused, which are tidied, and that every rule is off
// unless the instance turns it on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { latinLine, outboundFilter, tidyLine } from "../src/gate/outbound.ts";
import { B, G } from "../src/lang/index.ts";
import { outboundCommand } from "../src/cli-direct.ts";
import type { Config } from "../src/config.ts";
import { tmpDir } from "./tmp.ts";

const to = (text: string, target = "+6155500015") => ({ channel: "whatsapp", target, text });

test("outbound: a short line of three Latin words or more counts; Chinese, kana, a link, a second line, over 150 characters or two words do not", () => {
  for (const t of ["Let me check the schedule", "  I'll look it up now  ", "Reading the file again", "ok so then"]) assert.equal(latinLine(t), true, t);
  for (const t of ["", "Sounds good", "我看看 the schedule now", "スケジュール check it now", "see https://example.com now", "see www.example.com now",
    "Line one here\nline two here", "word ".repeat(31).trim(), "👍👍👍", "안녕하세요 반가워요 정말"]) assert.equal(latinLine(t), false, t);
  assert.equal(latinLine("abc ".repeat(37) + "ab"), true, "150 characters still counts");
});

test("outbound: one line loses a leading list mark and trailing 。; several lines are left alone", () => {
  assert.equal(tidyLine("1. 先去买票。"), "先去买票");
  assert.equal(tidyLine("2、 好的。。 "), "好的");
  assert.equal(tidyLine("2、好的"), "2、好的", "a mark needs a space after it");
  assert.equal(tidyLine("- 明天见"), "明天见");
  assert.equal(tidyLine("• 明天见"), "明天见");
  assert.equal(tidyLine("1.5 公里"), "1.5 公里", "a number is not a list mark");
  assert.equal(tidyLine("第一行。\n第二行。"), "第一行。\n第二行。");
});

test("outbound: no rule on, no filter", () => {
  assert.equal(outboundFilter(undefined), undefined);
  assert.equal(outboundFilter({ refuseLatinLines: false, tidyLines: false, latinLinesTo: ["x"], latinLinesFile: "/x" }), undefined);
});

test("outbound: a Latin line is refused, except to a listed target or while the file unlocks it; the rest goes as it is", async () => {
  const dir = tmpDir("hh-outbound-");
  const file = join(dir, "latin-ok.json");
  let now = 1_000_000;
  const f = outboundFilter({ refuseLatinLines: true, latinLinesTo: ["+6155500013"], latinLinesFile: file }, () => now)!;
  assert.deepEqual(await f(to("Let me check the schedule")), { refuse: G.outbound.latinLineRefused });
  assert.equal(await f(to("Let me check the schedule", "+6155500013@s.whatsapp.net")), undefined, "the list matches part of the target");
  assert.equal(await f(to("好，我去查车次")), undefined);
  assert.equal(await f(to("")), undefined, "a picture alone has no text");
  assert.equal(await f(to("⚠️ deploy failed, rolling back now")), undefined, "a notice goes untouched");
  writeFileSync(file, JSON.stringify({ until: now + 60_000 }));
  assert.equal(await f(to("Let me check the schedule")), undefined, "unlocked");
  now += 60_000;
  assert.ok(await f(to("Let me check the schedule")), "the unlock ran out");
  writeFileSync(file, "{ broken");
  assert.ok(await f(to("Let me check the schedule")), "a broken file does not unlock");
  assert.equal(await f(to("1. 先去买票。")), undefined, "tidying is its own rule");
});

test("outbound: tidying sends the tidied line; nothing to tidy, several lines, or a line that would be empty go as they are", async () => {
  const f = outboundFilter({ tidyLines: true })!;
  assert.deepEqual(await f(to("1. 先去买票。")), { text: "先去买票" });
  assert.equal(await f(to("先去买票")), undefined);
  assert.equal(await f(to("第一行。\n第二行。")), undefined);
  assert.equal(await f(to("。")), undefined);
  assert.equal(await f(to("✅ 部署好了。")), undefined, "a notice is not tidied");
  assert.equal(await f(to("Let me check the schedule")), undefined, "refusing is its own rule");
});

test("hh outbound latin: on writes the switch the filter reads, for --minutes; off removes it; no file in the config says so", async () => {
  const file = join(tmpDir("hh-latin-"), "sub", "latin.json");
  const cfg = { outbound: { refuseLatinLines: true, latinLinesFile: file }, schedule: { timezone: "UTC" } } as Config;
  const now = Date.UTC(2026, 10, 14, 9, 0);
  const f = outboundFilter(cfg.outbound, () => now + 59 * 60_000)!;
  assert.equal(outboundCommand(cfg, ["latin"], now), B.cliDirect.latinOff);
  assert.equal(outboundCommand(cfg, ["latin", "on", "--minutes", "60"], now), B.cliDirect.latinOn("11-14 10:00"));
  assert.equal(await f(to("Let me check the schedule")), undefined, "on: a Latin line goes out");
  assert.equal(outboundCommand(cfg, ["latin", "off"], now), B.cliDirect.latinOff);
  assert.ok(await f(to("Let me check the schedule")), "off: refused again");
  assert.throws(() => outboundCommand(cfg, ["latin", "maybe"], now), { message: B.cliDirect.latinUsage });
  assert.throws(() => outboundCommand({ ...cfg, outbound: {} }, ["latin", "on"], now), { message: B.cliDirect.latinNoFile });
});
