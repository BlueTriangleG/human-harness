// 用量当量按文件接着读（src/metrics/usage.ts）：口径要和 numbers() 整份重读的一样，状态存盘后重启接着读。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, cpSync, lutimesSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { numbers, numbersCommand, projectDirOf, DESTS } from "../src/metrics/numbers.ts";
import type { Dest, NumbersDay } from "../src/metrics/numbers.ts";
import { UsageScanner, UsageTally, weigh } from "../src/metrics/usage.ts";
import { tmpDir } from "./tmp.ts";

const TZ = "Australia/Melbourne";
const NOW = Date.UTC(2026, 10, 12, 10, 0);          // 枫湾 11-12 21:00
const L = (d: number, h: number, mi = 0): number => Date.UTC(2026, 10, d, h - 11, mi);   // 枫湾 11 月 d 日 h 点 → 毫秒
const DIRS = { workspace: "/demo/ws", replay: ["/demo/state/replay"] };
const WS = projectDirOf(DIRS.workspace);
const usageLine = (t: number, id: string, u: Record<string, number>, rid = `req-${id}`): string =>
  JSON.stringify({ type: "assistant", timestamp: new Date(t).toISOString(), ...(rid ? { requestId: rid } : {}), message: { ...(id ? { id } : {}), model: "m", usage: u } });

const TRANSCRIPTS: Array<{ dir: string; lines: string[] }> = [
  { dir: WS, lines: [
    usageLine(L(12, 9), "m1", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 }),
    usageLine(L(12, 9), "m1", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 }),   // 同一次回复的第二段：去重
    usageLine(L(11, 9), "m2", { output_tokens: 200_000 }),
    usageLine(L(12, 23, 59), "m3", { input_tokens: 30_000, cache_creation_input_tokens: 40_000 }),
    usageLine(L(13, 0, 1), "m4", { input_tokens: 7 }),                                         // 过了半夜：下一天
    usageLine(L(12, 10), "", { input_tokens: 500_000 }, ""), usageLine(L(12, 10), "", { input_tokens: 500_000 }, ""),   // 两样编号都没有：不去重，各算各的
    JSON.stringify({ type: "user", timestamp: new Date(L(12, 9)).toISOString(), message: { role: "user", content: "别人的话里提到 \"usage\" 这个词" } }),
    JSON.stringify({ type: "assistant", timestamp: "不是时间", requestId: "x", message: { id: "x", usage: { input_tokens: 9_000_000 } } }),
    "{ 坏的一行 \"usage\"",
  ] },
  { dir: "-demo-helpers-picnic", lines: [usageLine(L(12, 12), "h1", { cache_creation_input_tokens: 800_000 }), usageLine(L(12, 12), "m1", { input_tokens: 5 })] },   // m1 这个请求在主会话里数过了
  { dir: projectDirOf("/demo/state/replay/2026-11-12T02-35"), lines: [usageLine(L(12, 13), "r1", { output_tokens: 100_000 })] },
  { dir: "-private-var-folders-y6-abc", lines: [usageLine(L(12, 13), "o1", { input_tokens: 2_000_000 })] },
];
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

test("usage: fed line by line it gives the same numbers as numbers() reading everything at once, for every day and destination", () => {
  const whole = numbers({ days: 3, now: NOW + 86_400_000, tz: TZ, db: null, logLines: [], transcripts: TRANSCRIPTS, dirs: DIRS });
  const t = new UsageTally({ tz: TZ });
  t.advance(NOW + 86_400_000);
  // 一行一行喂、文件之间穿插着喂，结果也一样（去重是所有文件合起来的；numbers() 是按上面的次序读的）
  for (const tr of TRANSCRIPTS) for (const line of tr.lines) t.feed(`${tr.dir}/s.jsonl`, tr.dir === WS ? "hh" : tr.dir.startsWith("-demo-helpers") ? "helpers" : tr.dir.startsWith("-private") ? "other" : "replay", [line]);
  assert.deepEqual(whole.map((d) => d.day), ["2026-11-11", "2026-11-12", "2026-11-13"]);
  for (const d of whole) for (const k of DESTS) assert.ok(close(t.usage(d.day)[k], d.usage[k]), `${d.day} ${k}: ${t.usage(d.day)[k]} 对 ${d.usage[k]}`);
  // 手算几个：11-12 主工作区 = 缓存读 1M×0.1 + 写 40k×1.25 + 入 30k + 入 1M（两条没编号的）
  assert.ok(close(t.usage("2026-11-12").hh, 0.1 + 0.05 + 0.03 + 1));
  assert.ok(close(t.usage("2026-11-11").hh, 1));
  assert.ok(close(t.usage("2026-11-12").helpers, 1));
  assert.ok(close(t.usage("2026-11-13").hh, 7e-6));
  assert.deepEqual(t.tokens("2026-11-12").hh, { cacheRead: 1_000_000, cacheWrite: 40_000, input: 1_030_000, output: 0 });
  assert.deepEqual(t.tokens("2026-10-01").hh, { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 });
  // 存的是没折算的数：换权重不用重读
  const flat = { cacheRead: 1, cacheWrite: 1, input: 1, output: 1 };
  assert.ok(close(t.usage("2026-11-12", flat).hh, 2.07));
  assert.equal(weigh({ cacheRead: 10, cacheWrite: 4, input: 2, output: 1 }), (10 * 0.1 + 4 * 1.25 + 2 + 5) / 1e6);
});

test("usage: days older than the window are dropped, and so are rows that old; a dumped state restores to the same sums", () => {
  const t = new UsageTally({ tz: TZ, keepDays: 2 });
  t.feed("a", "hh", [usageLine(L(12, 9), "a1", { input_tokens: 1_000_000 }), usageLine(L(9, 9), "a0", { input_tokens: 1_000_000 })]);
  t.advance(NOW);                                   // 窗口：11-10 21:00 起
  assert.equal(t.usage("2026-11-09").hh, 0);
  assert.equal(t.usage("2026-11-12").hh, 1);
  t.feed("a", "hh", [usageLine(L(10, 9), "a2", { input_tokens: 1_000_000 }), usageLine(L(10, 22), "a3", { input_tokens: 2_000_000 })]);   // 第一条比窗口早
  assert.equal(t.usage("2026-11-10").hh, 2);
  const saved = JSON.parse(JSON.stringify(t.dump())) as ReturnType<UsageTally["dump"]>;
  assert.deepEqual(saved.lastKey, { a: "a3\u0000req-a3" });
  const u = new UsageTally({ tz: TZ, keepDays: 2 });
  u.restore(saved, NOW);
  for (const day of ["2026-11-10", "2026-11-11", "2026-11-12"]) assert.deepEqual(u.tokens(day), t.tokens(day), day);
  // 重启前最后那条消息的后半截：不再数
  u.feed("a", "hh", [usageLine(L(10, 22), "a3", { input_tokens: 2_000_000 }), usageLine(L(12, 20), "a4", { input_tokens: 1_000_000 })]);
  assert.equal(u.usage("2026-11-10").hh, 2);
  assert.equal(u.usage("2026-11-12").hh, 2);
  // 存盘的样子不对的那几项不要，别的照用
  const odd = new UsageTally({ tz: TZ });
  odd.restore({ days: { "2026-11-12": { hh: { input: 5, output: "x", cacheRead: -1 }, helpers: 3 }, bad: { hh: { input: 9 } } }, lastKey: { a: 7, b: "" } }, NOW);
  assert.deepEqual(odd.tokens("2026-11-12").hh, { cacheRead: 0, cacheWrite: 0, input: 5, output: 0 });
  assert.deepEqual(odd.dump().lastKey, {});
  odd.restore({}, NOW);
  assert.deepEqual(odd.dump(), { days: {}, lastKey: {} });
});

function projects(): { root: string; projectsDir: string; cacheFile: string; put: (rel: string, lines: string[]) => string } {
  const root = tmpDir("hh-usage-");
  const projectsDir = join(root, "projects");
  const put = (rel: string, lines: string[]): string => {
    const p = join(projectsDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, lines.map((l) => l + "\n").join(""));
    utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
    return p;
  };
  return { root, projectsDir, cacheFile: join(root, "cache", "usage.json"), put };
}
const sums = (s: UsageScanner, day: string): Record<Dest, number> => s.tally.usage(day);

test("usage scanner: walks every project and its sub-agent folders, reads only what was appended, and matches numbers() on the same files", async () => {
  const f = projects();
  const main = f.put(`${WS}/sess-1.jsonl`, TRANSCRIPTS[0]!.lines);
  f.put(`${WS}/sess-1/subagents/agent-a.jsonl`, [usageLine(L(12, 15), "sub1", { input_tokens: 400_000 })]);            // 子代理：算在主工作区上
  f.put(`${WS}/a/b/c/d/deep.jsonl`, [usageLine(L(12, 15), "deep4", { input_tokens: 100_000 })]);                       // 往下第四层：还算
  f.put(`${WS}/a/b/c/d/e/too-deep.jsonl`, [usageLine(L(12, 15), "deep5", { input_tokens: 9_000_000 })]);               // 第五层：不找了
  f.put("-demo-helpers-picnic/h.jsonl", [TRANSCRIPTS[1]!.lines[0]!]);   // 不带那条和主会话重的：目录是按名字的次序读的，谁先读到算谁的
  f.put(`${projectDirOf("/demo/state/replay/2026-11-12T02-35")}/r.jsonl`, TRANSCRIPTS[2]!.lines);
  f.put("-private-var-folders-y6-abc/o.jsonl", TRANSCRIPTS[3]!.lines);
  const old = f.put("-demo-helpers-old/old.jsonl", [usageLine(L(12, 8), "would-count-if-read", { input_tokens: 9_000_000 })]);
  utimesSync(old, new Date(NOW - 40 * 86_400_000), new Date(NOW - 40 * 86_400_000));                                   // 窗口以前就没再动过：不读
  writeFileSync(join(f.projectsDir, "stray.jsonl"), usageLine(L(12, 8), "stray", { input_tokens: 9_000_000 }) + "\n"); // 不在哪个工作目录下：不算（numbers() 也不算）
  writeFileSync(join(f.projectsDir, WS, "notes.txt"), usageLine(L(12, 8), "txt", { input_tokens: 9_000_000 }) + "\n");

  const s = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ, minIntervalMs: 60_000, chunkBytes: 128 });
  const first = await s.scan(NOW);
  assert.equal(first.files, 6);
  assert.ok(close(sums(s, "2026-11-12").hh, 0.1 + 0.05 + 0.03 + 1 + 0.4 + 0.1));
  assert.deepEqual([sums(s, "2026-11-12").helpers, sums(s, "2026-11-12").replay, sums(s, "2026-11-12").other], [1, 0.5, 2]);
  assert.ok(close(sums(s, "2026-11-11").hh, 1));
  assert.equal(s.latest, first);
  assert.equal(s.progress, null);

  // 没到间隔：给上一次的；同时来的两次是同一次；只读了新加的那一行
  const more = usageLine(L(12, 20), "m9", { output_tokens: 20_000 });
  appendFileSync(main, more + "\n");
  assert.equal(await s.scan(NOW + 30_000), first);
  const [x, y] = await Promise.all([s.scan(NOW + 2 * 60_000), s.scan(NOW + 2 * 60_000)]);
  assert.equal(x, y);
  assert.deepEqual([x.files, x.readBytes], [1, Buffer.byteLength(more + "\n")]);
  assert.ok(close(sums(s, "2026-11-12").hh, 1.68 + 0.1));
  // 文件没了：数过的还在（那些用量确实发生过）；变短了：不重数，从新的结尾接着读
  rmSync(join(f.projectsDir, "-demo-helpers-picnic"), { recursive: true });
  f.put("-private-var-folders-y6-abc/o.jsonl", []);
  await s.scan(NOW + 4 * 60_000);
  assert.deepEqual([sums(s, "2026-11-12").helpers, sums(s, "2026-11-12").other], [1, 2]);
  appendFileSync(join(f.projectsDir, "-private-var-folders-y6-abc/o.jsonl"), usageLine(L(12, 21), "o2", { input_tokens: 1_000_000 }) + "\n");
  await s.scan(NOW + 6 * 60_000);
  assert.deepEqual([sums(s, "2026-11-12").helpers, sums(s, "2026-11-12").other], [1, 3]);
});

test("usage scanner: with a cache file a new process picks up where the last one stopped — nothing is read again, nothing is counted twice", async () => {
  const f = projects();
  const main = f.put(`${WS}/sess-1.jsonl`, [usageLine(L(12, 9), "m1", { input_tokens: 1_000_000 }), usageLine(L(12, 9, 30), "m2", { input_tokens: 2_000_000 })]);
  f.put("-demo-helpers-picnic/h.jsonl", [usageLine(L(12, 12), "h1", { input_tokens: 4_000_000 })]);
  const half = usageLine(L(12, 10), "m3", { input_tokens: 8_000_000 });
  appendFileSync(main, half.slice(0, 50));                                           // 存盘时最后一行只写了一半
  const opts = { projectsDir: f.projectsDir, dirs: DIRS, tz: TZ, cacheFile: f.cacheFile, minIntervalMs: 0 };
  mkdirSync(dirname(f.cacheFile), { recursive: true });
  const a = new UsageScanner(opts);
  await a.scan(NOW);
  assert.deepEqual([sums(a, "2026-11-12").hh, sums(a, "2026-11-12").helpers], [3, 4]);
  const saved = JSON.parse(readFileSync(f.cacheFile, "utf8")) as { v: number; tz: string; files: Record<string, number>; days: Record<string, unknown>; lastKey: Record<string, string> };
  assert.deepEqual([saved.v, saved.tz], [3, TZ]);
  assert.equal(statSync(f.cacheFile).mode & 0o777, 0o600, "缓存文件只有自己能读写");
  assert.equal((saved as unknown as { dir: string }).dir, f.projectsDir);
  assert.equal(saved.files[`${WS}/sess-1.jsonl`], readFileSync(main).length - 50, "记的是读完整行的地方：那半行不算读过");
  assert.equal(saved.lastKey[`${WS}/sess-1.jsonl`], "m2\u0000req-m2");

  // 「重启」：新的一个，读同一个缓存
  appendFileSync(main, half.slice(50) + "\n" + usageLine(L(12, 9, 30), "m2", { input_tokens: 2_000_000 }) + "\n");   // 半行补完；m2 又来了一段（同一条消息的后半截）
  const b = new UsageScanner(opts);
  const r = await b.scan(NOW + 60_000);
  assert.deepEqual([r.files, r.readBytes], [1, readFileSync(main).length - saved.files[`${WS}/sess-1.jsonl`]!]);
  assert.deepEqual([sums(b, "2026-11-12").hh, sums(b, "2026-11-12").helpers], [11, 4]);
  // 什么都没变：一个字节都不读，缓存也不重写
  const c = new UsageScanner(opts);
  assert.deepEqual([(await c.scan(NOW + 120_000)).readBytes, sums(c, "2026-11-12").hh], [0, 11]);
  // 换了时区、坏的缓存：不用它，从头读
  const d = new UsageScanner({ ...opts, tz: "UTC" });
  assert.ok((await d.scan(NOW + 180_000)).readBytes > 0);
  assert.equal(sums(d, "2026-11-12").hh + sums(d, "2026-11-11").hh, 11);
  // 另一个会话记录目录拿到这份缓存：不用（位置对不上）
  const elsewhere = join(f.root, "projects-copy");
  cpSync(f.projectsDir, elsewhere, { recursive: true });
  const h = new UsageScanner({ ...opts, projectsDir: elsewhere });
  assert.ok((await h.scan(NOW + 200_000)).readBytes > 0);
  assert.equal(sums(h, "2026-11-12").hh, 11);
  writeFileSync(f.cacheFile, "{ 坏的");
  const e = new UsageScanner(opts);
  assert.ok((await e.scan(NOW + 240_000)).readBytes > 0);
  assert.equal(sums(e, "2026-11-12").hh, 11);
  // 没有工作目录、缓存存不了：不报错
  const g = new UsageScanner({ projectsDir: join(f.root, "none"), dirs: DIRS, tz: TZ, cacheFile: join(f.root, "no-such-dir", "x.json") });
  assert.deepEqual([(await g.scan(NOW)).files, sums(g, "2026-11-12").hh], [0, 0]);
});

// ---------- 符号链接：旧的会话记录归档到别的盘，原地留一个链接 ----------

const DAY = 86_400_000;
/** 「另一个盘上的归档」里放一份记录 */
function archived(root: string, rel: string, lines: string[]): string {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.map((l) => l + "\n").join(""));
  utimesSync(p, new Date(NOW - 60_000), new Date(NOW - 60_000));
  return p;
}
/** 留在原地的链接；at 是它哪一刻放在这里的（归档的那一刻） */
function linkAt(target: string, path: string, at: number): string {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
  lutimesSync(path, new Date(at), new Date(at));
  return path;
}

test("usage scanner: archived records behind symbolic links count exactly as hh numbers counts them, for every day and destination", async () => {
  const f = projects();
  const archive = join(f.root, "archive");
  f.put(`${WS}/now.jsonl`, [usageLine(L(12, 9), "n1", { input_tokens: 1_000_000 })]);
  // 整个工作目录归档走了；主工作区里一份旧会话也归档走了（只这一个文件是链接）
  archived(archive, "-demo-helpers-old/a.jsonl", [usageLine(L(8, 9), "a1", { input_tokens: 2_000_000 }), usageLine(L(6, 9), "a0", { cache_creation_input_tokens: 800_000 })]);
  archived(archive, "-demo-helpers-old/a/subagents/s.jsonl", [usageLine(L(8, 11), "a2", { input_tokens: 250_000 })]);
  linkAt(join(archive, "-demo-helpers-old"), join(f.projectsDir, "-demo-helpers-old"), NOW - 2 * DAY);
  linkAt(archived(archive, "ws-old-sess.jsonl", [usageLine(L(7, 9), "w1", { output_tokens: 200_000 })]), join(f.projectsDir, WS, "old-sess.jsonl"), NOW - 2 * DAY);

  const s = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ });
  const r = await s.scan(NOW);
  assert.deepEqual([r.files, r.unread], [4, null]);
  assert.deepEqual([sums(s, "2026-11-12").hh, sums(s, "2026-11-07").hh, sums(s, "2026-11-08").helpers, sums(s, "2026-11-06").helpers], [1, 1, 2.25, 1]);
  // 同一个目录交给 hh numbers 那段代码整份重读：14 天、四个去向，一样
  const whole = (JSON.parse(numbersCommand({ stateDir: join(f.root, "state"), workspace: DIRS.workspace, schedule: { timezone: TZ } }, ["14", "--json"], { now: NOW, projectsDir: f.projectsDir })) as { days: NumbersDay[] }).days;
  assert.equal(whole.length, 14);
  for (const d of whole) for (const k of DESTS) assert.ok(close(sums(s, d.day)[k], d.usage[k]), `${d.day} ${k}：接着读 ${sums(s, d.day)[k]}，整份重读 ${d.usage[k]}`);
});

test("usage scanner: two links to one folder are read once, a link back up the tree does not go round, and a link that leads nowhere neither crashes nor passes for nothing", async () => {
  const f = projects();
  const archive = join(f.root, "archive");
  f.put(`${WS}/now.jsonl`, [usageLine(L(12, 9), "n1", { input_tokens: 1_000_000 })]);
  writeFileSync(join(f.projectsDir, "stray.jsonl"), usageLine(L(12, 8), "stray", { input_tokens: 9_000_000 }) + "\n");   // 不在哪个工作目录下：不算（绕回来的链接也不能把它带进来）
  // 第二行两样编号都没有，不去重：这个文件读两遍就会算两遍
  archived(archive, "-demo-helpers-old/a.jsonl", [usageLine(L(8, 9), "a1", { input_tokens: 2_000_000 }), usageLine(L(8, 10), "", { input_tokens: 500_000 }, "")]);
  linkAt(join(archive, "-demo-helpers-old"), join(f.projectsDir, "-demo-helpers-old"), NOW - 2 * DAY);
  linkAt(join(archive, "-demo-helpers-old"), join(f.projectsDir, "-demo-helpers-old-again"), NOW - 2 * DAY);   // 两个链接指同一个目录
  linkAt(join(archive, "-demo-helpers-old", "a.jsonl"), join(f.projectsDir, WS, "same-file.jsonl"), NOW - 2 * DAY);   // 又一个链接直接指那个文件
  linkAt(join(f.projectsDir, WS), join(f.projectsDir, WS, "loop"), NOW - DAY);                                // 绕回自己这一层
  linkAt(f.projectsDir, join(f.projectsDir, WS, "up"), NOW - DAY);                                            // 绕回最上面
  linkAt(join(f.projectsDir, WS, "self"), join(f.projectsDir, WS, "self"), NOW - 40 * DAY);                   // 自己指自己（很早以前放的）

  const s = new UsageScanner({ projectsDir: f.projectsDir, dirs: DIRS, tz: TZ, minIntervalMs: 0 });
  const r = await s.scan(NOW);
  assert.equal(r.files, 2, "now 和 a 各读一遍");
  assert.equal(r.readBytes, statSync(join(f.projectsDir, WS, "now.jsonl")).size + statSync(join(archive, "-demo-helpers-old", "a.jsonl")).size);
  assert.deepEqual([sums(s, "2026-11-12").hh, sums(s, "2026-11-08").helpers, sums(s, "2026-11-08").hh], [1, 2.5, 0]);
  assert.equal(r.unread, null, "窗口以前就放在那里的断链不算：它后面的记录也比窗口早");

  // 断链：整个目录的、一份记录的、别的文件的（不算）、窗口以前就归档走的（不算）
  linkAt(join(f.root, "not-mounted", "-demo-helpers-gone"), join(f.projectsDir, "-demo-helpers-gone"), NOW - 3 * DAY);
  linkAt(join(f.root, "not-mounted", "gone.jsonl"), join(f.projectsDir, WS, "gone.jsonl"), NOW - 5 * DAY);
  linkAt(join(f.root, "not-mounted", "notes.md"), join(f.projectsDir, WS, "notes.md"), NOW - DAY);
  linkAt(join(f.root, "not-mounted", "-demo-helpers-ancient"), join(f.projectsDir, "-demo-helpers-ancient"), NOW - 40 * DAY);
  const r2 = await s.scan(NOW + 60_000);
  assert.deepEqual(r2.unread, { links: 2, upTo: NOW - 3 * DAY });
  assert.deepEqual([r2.files, sums(s, "2026-11-12").hh, sums(s, "2026-11-08").helpers], [0, 1, 2.5]);
  // 够得着了（盘挂上了）：补上，那个目录不再报
  archived(join(f.root, "not-mounted"), "-demo-helpers-gone/g.jsonl", [usageLine(L(9, 9), "g1", { input_tokens: 4_000_000 })]);
  const r3 = await s.scan(NOW + 120_000);
  assert.deepEqual([r3.files, sums(s, "2026-11-09").helpers], [1, 4]);
  assert.deepEqual(r3.unread, { links: 1, upTo: NOW - 5 * DAY });
});

test("usage scanner: while the archive cannot be reached, what was read stays counted, and it is not read or counted again when the archive is back — across a restart too", async () => {
  const f = projects();
  const archive = join(f.root, "archive"), away = join(f.root, "archive-not-mounted");
  f.put(`${WS}/now.jsonl`, [usageLine(L(12, 9), "n1", { input_tokens: 1_000_000 })]);
  archived(archive, "-demo-helpers-old/a.jsonl", [usageLine(L(8, 9), "a1", { input_tokens: 2_000_000 }), usageLine(L(8, 10), "a2", { input_tokens: 500_000 })]);
  archived(archive, "-demo-helpers-old/a/subagents/s.jsonl", [usageLine(L(8, 11), "a3", { input_tokens: 250_000 })]);
  linkAt(join(archive, "-demo-helpers-old"), join(f.projectsDir, "-demo-helpers-old"), NOW - 2 * DAY);
  mkdirSync(dirname(f.cacheFile), { recursive: true });
  const opts = { projectsDir: f.projectsDir, dirs: DIRS, tz: TZ, cacheFile: f.cacheFile, minIntervalMs: 0 };
  const a = new UsageScanner(opts);
  assert.deepEqual([(await a.scan(NOW)).files, sums(a, "2026-11-08").helpers], [3, 2.75]);

  // 盘卸了：读过的那些合计不动，也不报「读不到」（这些天的数是全的）
  renameSync(archive, away);
  const r2 = await a.scan(NOW + 60_000);
  assert.deepEqual([r2.files, r2.unread, sums(a, "2026-11-08").helpers], [0, null, 2.75]);
  const saved = JSON.parse(readFileSync(f.cacheFile, "utf8")) as { files: Record<string, number> };
  assert.ok(saved.files["-demo-helpers-old/a.jsonl"]! > 0 && saved.files["-demo-helpers-old/a/subagents/s.jsonl"]! > 0, "读到哪了还记着");
  // 盘还没回来就重启了；之后盘回来：一个字节都不重读，没有哪条再数一遍
  const b = new UsageScanner(opts);
  const r3 = await b.scan(NOW + 120_000);
  assert.deepEqual([r3.files, r3.unread, sums(b, "2026-11-08").helpers], [0, null, 2.75]);
  renameSync(away, archive);
  const r4 = await b.scan(NOW + 180_000);
  assert.deepEqual([r4.files, r4.readBytes, r4.unread, sums(b, "2026-11-08").helpers], [0, 0, null, 2.75]);
  // 归档里又多了一行（不该有，但有了也只读新的那一行）
  appendFileSync(join(archive, "-demo-helpers-old", "a.jsonl"), usageLine(L(8, 12), "a4", { input_tokens: 1_000_000 }) + "\n");
  assert.deepEqual([(await b.scan(NOW + 240_000)).files, sums(b, "2026-11-08").helpers], [1, 3.75]);

  // 从没读过的进程（没有缓存）碰上盘没挂：不崩，那几天是 0，但报出来有 1 个读不到、归档的那一刻是哪一刻
  renameSync(archive, away);
  const c = new UsageScanner({ ...opts, cacheFile: join(f.root, "cache", "fresh.json") });
  const r5 = await c.scan(NOW + 300_000);
  assert.deepEqual([r5.unread, sums(c, "2026-11-08").helpers, sums(c, "2026-11-12").hh], [{ links: 1, upTo: NOW - 2 * DAY }, 0, 1]);
  renameSync(away, archive);
  const r6 = await c.scan(NOW + 360_000);
  assert.deepEqual([r6.unread, sums(c, "2026-11-08").helpers], [null, 3.75]);
});

// ---------- 团队：团队借她的额度干活，在配置里给的目录下跑，用量单列一栏 ----------

test("usage scanner: sessions under a configured team folder are summed under team; a cache written under other folder settings is not reused", async () => {
  const f = projects();
  const TEAM = "/srv/hh-team";
  f.put(`${WS}/s.jsonl`, [usageLine(L(12, 9), "m1", { input_tokens: 2_000_000 })]);
  f.put(`${projectDirOf(TEAM + "/tuning")}/t.jsonl`, [usageLine(L(12, 9), "t1", { input_tokens: 3_000_000 })]);
  f.put(`${projectDirOf(TEAM + "/tuning")}/t/subagents/a.jsonl`, [usageLine(L(12, 10), "t2", { input_tokens: 500_000 })]);   // 团队会话的子代理：也算团队
  f.put(`${projectDirOf("/srv/hh-teamwork")}/x.jsonl`, [usageLine(L(12, 9), "x1", { input_tokens: 1_000_000 })]);            // 名字只是开头一样：不算团队
  mkdirSync(dirname(f.cacheFile), { recursive: true });
  const base = { projectsDir: f.projectsDir, tz: TZ, cacheFile: f.cacheFile, minIntervalMs: 0 };
  // 还没配团队目录：都算帮手，和以前一样
  const a = new UsageScanner({ ...base, dirs: DIRS });
  await a.scan(NOW);
  assert.deepEqual(sums(a, "2026-11-12"), { hh: 2, helpers: 4.5, team: 0, replay: 0, other: 0 });
  // 配上了：缓存里每天的合计是按旧认法分的栏，不能接着用——从头读，重新分
  const withTeam = { ...DIRS, team: [TEAM] };
  const b = new UsageScanner({ ...base, dirs: withTeam });
  const r = await b.scan(NOW + 60_000);
  assert.equal(r.files, 4, "四个文件都重读了");
  assert.deepEqual(sums(b, "2026-11-12"), { hh: 2, helpers: 1, team: 3.5, replay: 0, other: 0 });
  // 同样的配置再起一个（重启）：接着缓存，一个字节不重读
  const c = new UsageScanner({ ...base, dirs: { ...DIRS, team: [TEAM] } });
  assert.deepEqual([(await c.scan(NOW + 120_000)).readBytes, sums(c, "2026-11-12").team], [0, 3.5]);
  // 团队目录又撤了：再从头读，回到帮手
  const d = new UsageScanner({ ...base, dirs: DIRS });
  await d.scan(NOW + 180_000);
  assert.deepEqual([sums(d, "2026-11-12").helpers, sums(d, "2026-11-12").team], [4.5, 0]);
});
