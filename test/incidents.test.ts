// 「她顺不顺」按小时的三样数（src/metrics/incidents.ts）：请求数、被停 / 被拒、hhd 被卡住。口径是运维 11-13 定的。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  HourClock, IncidentScanner, Incidents, MERGE_MS, STOP_NOTICE, freshTail, mergeStops, readAppended, renderIncidents,
} from "../src/metrics/incidents.ts";
import type { IncidentHour } from "../src/metrics/incidents.ts";
import { STOP_NOTICE as KERNEL_STOP_NOTICE } from "../src/kernel/sdk.ts";
import { tmpDir } from "./tmp.ts";

const TZ = "Australia/Melbourne";
const H = 3_600_000;
/** 枫湾时间（11 月是 UTC+11）→ 毫秒 */
const L = (d: number, h: number, mi = 0, s = 0): number => Date.UTC(2026, 10, d, h - 11, mi, s);
const NOW = L(13, 20, 30);   // 枫湾 11-13 20:30
const iso = (t: number): string => new Date(t).toISOString();

// 会话记录里的行（只带数数要看的字段，正文是编的）
const asst = (t: number, rid: string | null, extra: { stop?: string; model?: string; id?: string; text?: string } = {}): string => JSON.stringify({
  parentUuid: "p", type: "assistant", timestamp: iso(t), ...(rid ? { requestId: rid } : {}),
  message: { ...(extra.id ? { id: extra.id } : {}), model: extra.model ?? "claude-test", role: "assistant", stop_reason: extra.stop ?? null, content: [{ type: "text", text: extra.text ?? "好的" }] },
});
const notice = (t: number, content: unknown = `上面那条回复：${STOP_NOTICE}。`, uuid?: string): string => JSON.stringify({ type: "system", subtype: "informational", timestamp: iso(t), content, ...(uuid ? { uuid } : {}) });
const noFallback = (t: number, uuid?: string): string => JSON.stringify({ type: "system", subtype: "model_refusal_no_fallback", timestamp: iso(t), ...(uuid ? { uuid } : {}) });
const user = (t: number, text = "你好"): string => JSON.stringify({ type: "user", timestamp: iso(t), message: { role: "user", content: text } });
const blockedLine = (t: number, ms: number, extra: Record<string, unknown> = {}): string => JSON.stringify({ t: iso(t), level: "warn", mod: "hhd", msg: "event loop blocked", ms, ...extra });

const at = (hours: IncidentHour[], day: number, hour: number): IncidentHour => {
  const h = hours.find((x) => x.day === `2026-11-${String(day).padStart(2, "0")}` && x.hour === hour);
  assert.ok(h, `没有 ${day} 日 ${hour} 点这一行`);
  return h;
};
const total = (hours: IncidentHour[], k: keyof IncidentHour): number => hours.reduce((n, h) => n + (h[k] as number), 0);

test("incidents: the notice text is not written out anywhere in the repo's source — only as escapes", () => {
  assert.equal(STOP_NOTICE.length, 31);
  assert.equal(STOP_NOTICE, KERNEL_STOP_NOTICE, "和内核那边认的是同一句（src/kernel/sdk.ts）");
  assert.match(STOP_NOTICE, /^[a-z ]+$/);
  for (const f of ["../src/metrics/incidents.ts", "./incidents.test.ts"]) {
    assert.equal(readFileSync(join(import.meta.dirname, f), "utf8").includes(STOP_NOTICE), false, `${f} 里有那句提示的原文`);
  }
});

test("incidents: requests are assistant rows deduped by request id, counted in her local hour; synthetic rows and rows without an id do not count", () => {
  const c = new Incidents({ tz: TZ });
  c.advance(NOW);
  c.feedTranscript("a.jsonl", [
    user(L(13, 16, 1)),
    asst(L(13, 16, 1, 5), "req_1"), asst(L(13, 16, 1, 6), "req_1"), asst(L(13, 16, 1, 7), "req_1"),   // 一个请求写成三行
    asst(L(13, 16, 59, 59), "req_2"),
    asst(L(13, 17, 0, 0), "req_3"),
    asst(L(13, 17, 5), null, { id: "msg_4" }), asst(L(13, 17, 5, 1), null, { id: "msg_4" }),           // 没有 requestId：用 message.id
    asst(L(13, 17, 6), "req_5", { model: "<synthetic>" }),                                           // 合成的不算
    asst(L(13, 17, 7), null),                                                                        // 两样都没有：不算
    "{ 坏的一行", "",
    JSON.stringify({ type: "assistant", timestamp: "不是时间", requestId: "req_6", message: {} }),
    user(L(13, 17, 8), `别人的话里带着 "type":"assistant" 也不算`),
  ]);
  const hours = c.hours(NOW);
  assert.equal(at(hours, 13, 16).requests, 2);
  assert.equal(at(hours, 13, 17).requests, 2);
  assert.equal(total(hours, "requests"), 4);
  assert.equal(total(hours, "stops") + total(hours, "refusals"), 0);
});

test("incidents: the window is 24 hours back to the full hour, every hour is listed, older rows are dropped", () => {
  const c = new Incidents({ tz: TZ });
  c.feedTranscript("a.jsonl", [asst(L(12, 19, 59), "old"), asst(L(12, 20, 0), "edge"), asst(L(13, 20, 29), "new"), asst(L(11, 9), "ancient")]);
  const hours = c.hours(NOW);
  assert.equal(hours.length, 25);
  assert.deepEqual([hours[0]!.day, hours[0]!.hour, hours[0]!.start], ["2026-11-12", 20, L(12, 20)]);
  assert.deepEqual([hours[24]!.day, hours[24]!.hour], ["2026-11-13", 20]);
  for (let i = 1; i < hours.length; i++) assert.equal(hours[i]!.start - hours[i - 1]!.start, H);
  assert.equal(total(hours, "requests"), 2);
  assert.equal(at(hours, 12, 20).requests, 1);
  // 窗口往后挪：先前在窗口里的也不留；喂进来的旧行不要
  const later = c.hours(NOW + 2 * H);
  assert.equal(total(later, "requests"), 1);
  c.feedTranscript("a.jsonl", [asst(L(12, 21, 0), "too-old-now")]);
  assert.equal(total(c.hours(NOW + 2 * H), "requests"), 1);
});

test("incidents: mergeStops — a refusal and a notice within 10 s are one stop, at most one partner, same kinds never merge", () => {
  const s = (t: number, kind: "refusal" | "info") => ({ t, kind });
  assert.deepEqual(mergeStops([]), []);
  assert.deepEqual(mergeStops([s(0, "refusal"), s(4000, "info")]), [0]);
  assert.deepEqual(mergeStops([s(4000, "refusal"), s(0, "info")]), [0], "先后都行，算在前一条的时刻上");
  assert.deepEqual(mergeStops([s(0, "refusal"), s(MERGE_MS, "info")]), [0], "正好 10 秒也并");
  assert.deepEqual(mergeStops([s(0, "refusal"), s(MERGE_MS + 1, "info")]), [0, MERGE_MS + 1]);
  assert.deepEqual(mergeStops([s(0, "refusal"), s(3000, "refusal")]), [0, 3000], "同一种连着出现各算各的");
  assert.deepEqual(mergeStops([s(0, "info"), s(1, "info"), s(2, "info")]), [0, 1, 2]);
  assert.deepEqual(mergeStops([s(0, "refusal"), s(5000, "info"), s(8000, "info")]), [0, 8000], "最多并一条");
  assert.deepEqual(mergeStops([s(0, "refusal"), s(3000, "refusal"), s(5000, "info")]), [0, 3000], "跳过同一种的，并后面那条另一种的");
  assert.deepEqual(mergeStops([s(0, "refusal"), s(3000, "refusal"), s(5000, "info"), s(6000, "info")]), [0, 3000]);
  assert.deepEqual(mergeStops([s(0, "refusal"), s(0, "info")]), [0], "同一刻");
});

test("incidents: stops are counted per session file; a refusal on any row of a request counts once; no-fallback refusals are counted on their own", () => {
  const c = new Incidents({ tz: TZ });
  c.advance(NOW);
  c.feedTranscript("a.jsonl", [
    asst(L(13, 16, 12, 10), "r1", { stop: "refusal" }), notice(L(13, 16, 12, 13)),                   // 并成一次
    asst(L(13, 16, 20, 0), "r2"), asst(L(13, 16, 20, 1), "r2", { stop: "refusal" }), asst(L(13, 16, 20, 2), "r2", { stop: "refusal" }),   // 第二行才写上被拒停：算一次
    notice(L(13, 16, 40, 0)),                                                                         // 只有提示：一次
    notice(L(13, 16, 50, 0), "别的提示，不是那一句"),                                                    // 不是那句话：不算
    notice(L(13, 16, 55, 0), [{ type: "text", text: `包在一层里：${STOP_NOTICE}` }]),                  // 内容不是字符串也认
    noFallback(L(13, 17, 1)), noFallback(L(13, 17, 1, 2)),                                             // 各算一次，不和别的并
    asst(L(13, 17, 1, 3), "r3", { stop: "refusal" }),
    asst(L(13, 17, 30), "r4", { stop: "end_turn" }),
  ]);
  // 另一份记录里 10 秒内的提示：不和上面那份的并
  c.feedTranscript("b.jsonl", [notice(L(13, 17, 1, 5)), asst(L(13, 17, 2), "r9")]);
  const hours = c.hours(NOW);
  assert.deepEqual([at(hours, 13, 16).requests, at(hours, 13, 16).stops, at(hours, 13, 16).refusals], [2, 4, 0]);
  assert.deepEqual([at(hours, 13, 17).requests, at(hours, 13, 17).stops, at(hours, 13, 17).refusals], [3, 2, 2]);
});

test("incidents: a request copied into a second session file counts once, and so does its refusal", () => {
  const c = new Incidents({ tz: TZ });
  c.advance(NOW);
  const rows = [asst(L(13, 15, 0), "r1", { stop: "refusal" }), asst(L(13, 15, 5), "r2")];
  c.feedTranscript("b-later.jsonl", [...rows, asst(L(13, 15, 30), "r3")]);   // 接着上一个会话开的：前面的行带过来了
  c.feedTranscript("a-first.jsonl", rows);
  const h = at(c.hours(NOW), 13, 15);
  assert.deepEqual([h.requests, h.stops], [3, 1]);
  // 那一份没了：它独有的不再算，带过来的那两条现在算在剩下的那份上
  c.forget("a-first.jsonl");
  assert.deepEqual([at(c.hours(NOW), 13, 15).requests, at(c.hours(NOW), 13, 15).stops], [3, 1]);
  c.forget("b-later.jsonl");
  assert.equal(total(c.hours(NOW), "requests"), 0);
});

test("incidents: system rows that carry a uuid count once, also when another session file carries the same row; rows without one count each time", () => {
  const c = new Incidents({ tz: TZ });
  c.advance(NOW);
  const carried = [notice(L(13, 15, 0), undefined, "u-1"), noFallback(L(13, 15, 10), "u-2")];
  c.feedTranscript("a.jsonl", [...carried, notice(L(13, 15, 20)), notice(L(13, 15, 20)), noFallback(L(13, 15, 30)), noFallback(L(13, 15, 30))]);
  c.feedTranscript("b.jsonl", [...carried, notice(L(13, 15, 40), undefined, "u-3"), notice(L(13, 15, 40), undefined, "u-3")]);
  const h = at(c.hours(NOW), 13, 15);
  assert.deepEqual([h.stops, h.refusals], [4, 3]);   // 提示：u-1、两条没有 uuid 的、u-3；被拒：u-2、两条没有 uuid 的
});

test("incidents: between() sums any stretch inside the window, cut to the second", () => {
  const c = new Incidents({ tz: TZ });
  c.feedTranscript("a.jsonl", [asst(L(13, 15, 0, 54), "r1"), asst(L(13, 15, 0, 55), "r2", { stop: "refusal" }), asst(L(13, 16, 12, 9), "r3"), noFallback(L(13, 16, 12, 10))]);
  c.feedLog([blockedLine(L(13, 15, 0, 55), 3000), blockedLine(L(13, 16, 12, 10), 2000)]);
  c.hours(NOW);
  assert.deepEqual(c.between(L(13, 7), L(13, 15, 0, 55)), { requests: 1, stops: 0, refusals: 0, blocks: 0, blockedMs: 0, longestMs: 0 });
  assert.deepEqual(c.between(L(13, 15, 0, 55), L(13, 16, 12, 10)), { requests: 2, stops: 1, refusals: 0, blocks: 1, blockedMs: 3000, longestMs: 3000 });
  assert.deepEqual(c.between(L(13, 16, 12, 10), NOW), { requests: 0, stops: 0, refusals: 1, blocks: 1, blockedMs: 2000, longestMs: 2000 });
});

test("incidents: versions() lists the kernel versions the requests of a stretch were made with", () => {
  const c = new Incidents({ tz: TZ });
  const v = (t: number, rid: string, version?: string): string => JSON.stringify({ type: "assistant", timestamp: iso(t), requestId: rid, ...(version ? { version } : {}), message: { model: "m" } });
  c.feedTranscript("a.jsonl", [v(L(13, 15, 0), "r1", "2.1.312"), v(L(13, 15, 1), "r1", "9.9.9"), v(L(13, 15, 30), "r2", "2.1.312"), v(L(13, 16, 0), "r3", "2.1.322"), v(L(13, 16, 5), "r4"), v(L(13, 16, 10), "r5", "2.1.99")]);
  c.feedTranscript("b.jsonl", [v(L(13, 15, 0), "r1", "0.0.1"), v(L(13, 17, 0), "r6", "2.1.322")]);   // r1 在前一份里算过了：这一份带的版本不算
  c.hours(NOW);
  assert.deepEqual(c.versions(L(13, 15), L(13, 16)), ["2.1.312"], "一个请求的版本是它最先读到的那一行的");
  assert.deepEqual(c.versions(L(13, 16), L(13, 17)), ["2.1.99", "2.1.322"], "按版本号从小到大，不是按字");
  assert.deepEqual(c.versions(L(13, 15), NOW), ["2.1.99", "2.1.312", "2.1.322"]);
  assert.deepEqual(c.versions(L(13, 16, 5), L(13, 16, 6)), [], "没记版本的行不出东西");
  assert.deepEqual(c.versions(L(13, 18), NOW), []);
});

test("incidents: blocked seconds come from the hhd log — by the time logged, replay rows left out, the same line read twice counts once", () => {
  const c = new Incidents({ tz: TZ });
  c.advance(NOW);
  const lines = [
    blockedLine(L(13, 16, 5), 2100, { lastControl: { cmd: "status", agoMs: 900 }, alertness: "awake", busy: ["main"], replay: false }),
    blockedLine(L(13, 16, 59, 59), 48_800),
    blockedLine(L(13, 17, 0, 1), 3000),
    blockedLine(L(13, 17, 10), 9000, { replay: true }),
    JSON.stringify({ t: iso(L(13, 17, 11)), level: "warn", mod: "hhd", msg: "control slow", cmd: "status", ms: 5000 }),
    JSON.stringify({ t: iso(L(13, 17, 12)), level: "info", mod: "hhd", msg: "note", text: "有人提到 event loop blocked 这几个字", ms: 7000 }),
    blockedLine(L(13, 17, 13), 0), blockedLine(L(13, 17, 14), Number.NaN), "坏的一行 event loop blocked",
    blockedLine(L(12, 10, 0), 5000),   // 窗口以前
  ];
  c.feedLog(lines);
  c.feedLog(lines);
  const hours = c.hours(NOW);
  assert.deepEqual([at(hours, 13, 16).blocks, at(hours, 13, 16).blockedMs, at(hours, 13, 16).longestMs], [2, 50_900, 48_800]);
  assert.deepEqual([at(hours, 13, 17).blocks, at(hours, 13, 17).blockedMs, at(hours, 13, 17).longestMs], [1, 3000, 3000]);
  assert.equal(total(hours, "blocks"), 3);
});

test("incidents: hours follow her time zone — half-hour offsets, and the hour that happens twice when the clocks go back", () => {
  const mel = new HourClock(TZ);
  assert.equal(mel.offset(NOW), 11 * H);
  assert.equal(mel.startOf(L(13, 16, 59, 59)), L(13, 16));
  assert.deepEqual(mel.label(L(13, 0)), { day: "2026-11-13", hour: 0 });
  assert.deepEqual(mel.label(L(13, 23)), { day: "2026-11-13", hour: 23 });
  const india = new HourClock("Asia/Kolkata");
  assert.equal(india.offset(NOW), 5.5 * H);
  assert.equal(india.startOf(Date.UTC(2026, 10, 13, 9, 45)), Date.UTC(2026, 10, 13, 9, 30));
  assert.deepEqual(india.label(Date.UTC(2026, 10, 13, 9, 30)), { day: "2026-11-13", hour: 15 });
  // 枫湾 2026-04-05 03:00 拨回 02:00（UTC 04-04 16:00）：02 点这一个小时过两遍，是两行
  const before = Date.UTC(2026, 3, 4, 15, 30), after = Date.UTC(2026, 3, 4, 16, 30);
  assert.equal(mel.startOf(before), Date.UTC(2026, 3, 4, 15));
  assert.equal(mel.startOf(after), Date.UTC(2026, 3, 4, 16));
  assert.deepEqual([mel.label(mel.startOf(before)).hour, mel.label(mel.startOf(after)).hour], [2, 2]);
  const c = new Incidents({ tz: TZ, windowMs: 3 * H });
  const hours = c.hours(Date.UTC(2026, 3, 4, 17, 10));
  assert.deepEqual(hours.map((h) => h.hour), [1, 2, 2, 3]);
  assert.deepEqual(hours.map((h) => h.start), [14, 15, 16, 17].map((h) => Date.UTC(2026, 3, 4, h)));
});

test("incidents: readAppended hands over whole lines only, across chunk borders that cut a character in half, and drops a line that is too long", async () => {
  const dir = tmpDir("hh-incidents-read-");
  const p = join(dir, "x.jsonl");
  const got: string[] = [];
  const start = "第一行，中文\nsecond 行\n半";
  writeFileSync(p, start);
  const tail = freshTail();
  assert.equal(await readAppended(p, tail, Buffer.byteLength(start), 4, (l) => got.push(...l)), Buffer.byteLength(start));
  assert.deepEqual(got, ["第一行，中文", "second 行"]);
  appendFileSync(p, "行补完了\n");
  const size = readFileSync(p).length;
  assert.equal(await readAppended(p, tail, size, 5, (l) => got.push(...l)), size - Buffer.byteLength(start));
  assert.deepEqual(got, ["第一行，中文", "second 行", "半行补完了"]);
  assert.equal(tail.offset, size);
  // 一行超过上限：整行丢掉，后面的照常
  const q = join(dir, "y.jsonl");
  writeFileSync(q, `短的\n${"长".repeat(200)}\n后面的\n没完`);
  const lines: string[] = [];
  const t2 = freshTail();
  await readAppended(q, t2, readFileSync(q).length, 16, (l) => lines.push(...l), 64);
  assert.deepEqual(lines, ["短的", "后面的"]);
  appendFileSync(q, "的也接上\n");
  await readAppended(q, t2, readFileSync(q).length, 16, (l) => lines.push(...l), 64);
  assert.deepEqual(lines, ["短的", "后面的", "没完的也接上"]);
});

test("incidents: the scanner reads only what was appended; old files, sub-agent folders and symlinks are not read; a file that shrank is read again; a deleted one stops counting", async () => {
  const root = tmpDir("hh-incidents-");
  const dir = join(root, "projects", "-ws");
  const logPath = join(root, "logs", "hh.jsonl");
  mkdirSync(join(dir, "sess-a", "subagents"), { recursive: true });
  mkdirSync(join(root, "logs"));
  const a = join(dir, "sess-a.jsonl"), b = join(dir, "sess-b.jsonl"), old = join(dir, "sess-old.jsonl");
  const put = (p: string, lines: string[]): void => writeFileSync(p, lines.map((l) => l + "\n").join(""));
  put(a, [asst(L(13, 16, 0), "a1"), asst(L(13, 16, 1), "a2", { stop: "refusal" }), notice(L(13, 16, 1, 4))]);
  put(b, [asst(L(13, 18, 0), "b1"), user(L(13, 18, 1), "很长的工具结果 ".repeat(500))]);
  put(old, [asst(L(13, 16, 30), "would-count-if-read")]);
  for (const f of [a, b]) utimesSync(f, new Date(NOW - 60_000), new Date(NOW - 60_000));
  utimesSync(old, new Date(NOW - 30 * H), new Date(NOW - 30 * H));   // 窗口开始以前就没再动过：不读
  put(join(dir, "sess-a", "subagents", "agent-1.jsonl"), [asst(L(13, 16, 2), "sub1")]);   // 子代理：不算
  put(join(root, "elsewhere.jsonl"), [asst(L(13, 16, 3), "outside")]);
  symlinkSync(join(root, "elsewhere.jsonl"), join(dir, "link.jsonl"));                    // 符号链接：不读
  writeFileSync(join(dir, "notes.txt"), asst(L(13, 16, 4), "not-jsonl") + "\n");
  put(logPath, [blockedLine(L(13, 16, 10), 4000)]);

  const s = new IncidentScanner({ dir, logPath, tz: TZ, minIntervalMs: 60_000, chunkBytes: 64 });
  const first = await s.scan(NOW);
  assert.deepEqual([total(first.hours, "requests"), total(first.hours, "stops"), total(first.hours, "blocks"), total(first.hours, "blockedMs")], [3, 1, 1, 4000]);
  assert.equal(first.readBytes, readFileSync(a).length + readFileSync(b).length + readFileSync(logPath).length);
  assert.equal(first.tz, TZ);

  // 没到间隔：给上一次的，不读文件；同时来的两次是同一次
  appendFileSync(a, asst(L(13, 20, 31), "a3") + "\n");
  assert.equal(await s.scan(NOW + 30_000), first);
  const [x, y] = await Promise.all([s.scan(NOW + 2 * 60_000), s.scan(NOW + 2 * 60_000)]);
  assert.equal(x, y);
  // 只读了新加的那一行
  assert.equal(x.readBytes, Buffer.byteLength(asst(L(13, 20, 31), "a3") + "\n"));
  assert.equal(total(x.hours, "requests"), 4);

  // 写到一半的一行：等它写完才算
  const half = asst(L(13, 20, 33), "a4");
  appendFileSync(a, half.slice(0, 40));
  assert.equal(total((await s.scan(NOW + 4 * 60_000)).hours, "requests"), 4);
  appendFileSync(a, half.slice(40) + "\n");
  appendFileSync(logPath, blockedLine(L(13, 20, 34), 2500) + "\n");
  const done = await s.scan(NOW + 6 * 60_000);
  assert.deepEqual([total(done.hours, "requests"), total(done.hours, "blocks"), total(done.hours, "blockedMs")], [5, 2, 6500]);

  // 变短了（被重写）：从头再读，不重复算
  put(b, [asst(L(13, 18, 0), "b1")]);
  assert.equal(total((await s.scan(NOW + 8 * 60_000)).hours, "requests"), 5);
  truncateSync(logPath, 0);
  appendFileSync(logPath, blockedLine(L(13, 20, 36), 1000) + "\n");
  assert.deepEqual([total((await s.scan(NOW + 10 * 60_000)).hours, "blocks")], [3], "日志换了一份：数过的留着，新的接着数");
  // 文件没了：不再算
  rmSync(a);
  const gone = await s.scan(NOW + 12 * 60_000);
  assert.deepEqual([total(gone.hours, "requests"), total(gone.hours, "stops")], [1, 0]);
  // 旧文件又被写了：从它上次的结尾接着读
  appendFileSync(old, asst(L(13, 20, 40), "old-new-row") + "\n");
  assert.equal(total((await s.scan(NOW + 14 * 60_000)).hours, "requests"), 2);
});

test("incidents: no directory and no log is not an error — every hour is zero", async () => {
  const root = tmpDir("hh-incidents-none-");
  const r = await new IncidentScanner({ dir: join(root, "none"), logPath: join(root, "none.jsonl"), tz: TZ }).scan(NOW);
  assert.equal(r.hours.length, 25);
  assert.equal(total(r.hours, "requests") + total(r.hours, "blocks"), 0);
  assert.equal(r.readBytes, 0);
});

test("incidents: the plain table shows each hour and the totals, and none of the stopped text", () => {
  const c = new Incidents({ tz: TZ, windowMs: H });
  c.feedTranscript("a.jsonl", [asst(L(13, 20, 1), "r1", { stop: "refusal", text: "被拦的正文" }), notice(L(13, 20, 1, 2)), asst(L(13, 20, 5), "r2"), noFallback(L(13, 20, 6))]);
  c.feedLog([blockedLine(L(13, 20, 7), 2500)]);
  const text = renderIncidents(c.hours(NOW));
  assert.match(text, /11-13 20:00 +请求 +2 +被停 +1 +被拒 +1 +出事 +2（100\.0%） +卡住 1 次 2\.5 秒（最长 2\.5）/);
  assert.match(text, /合计 +请求 2 +被停 1 +被拒 1 +卡住 1 次 2\.5 秒/);
  assert.equal(text.includes("被拦的正文") || text.includes(STOP_NOTICE), false);
});
