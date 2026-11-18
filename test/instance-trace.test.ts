// 入口漏带实例配置的留痕（src/instance-trace.ts）：追加一行、不跟符号链接、超限不写、写失败吞掉；读偏移；hhd 的报告规矩和 status 摘要。
// 所有路径都是临时目录里的文件，不碰真的 /tmp/hh-misconfig-*
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, linkSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  tracePath, traceTarget, noteMisconfig, trimTrace, noteEntryFailure, readMisconfig, MisconfigWatch, TRACE_ENV, TRIM_BYTES,
  reportMisconfigTrace, statusExtraOf,
  type MisconfigRecord,
} from "../src/instance-trace.ts";
import { handle } from "../src/control.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import { tmpDir } from "./tmp.ts";

const rec = (over: Partial<MisconfigRecord> = {}): MisconfigRecord => ({ t: 1_000, what: "config: stateDir is not set", sub: "status", parent: "python3 senses.py", cwd: "/work", ...over });
const lines = (p: string): string[] => readFileSync(p, "utf8").split("\n").filter(Boolean);

test("固定位置按 uid 分文件，不跟 TMPDIR", () => {
  assert.equal(tracePath(1234), "/tmp/hh-misconfig-1234.jsonl");
});

test("测试里默认不写：没给测试用的路径变量就是 null；给了用它；平常跑用固定位置", () => {
  assert.equal(traceTarget({ HH_TEST: "1" }, 7), null);
  assert.equal(traceTarget({ NODE_TEST_CONTEXT: "child" }, 7), null);
  assert.equal(traceTarget({ HH_TEST: "1", [TRACE_ENV]: "/x/y.jsonl" }, 7), "/x/y.jsonl");
  assert.equal(traceTarget({ [TRACE_ENV]: "/x/y.jsonl" }, 7), "/tmp/hh-misconfig-7.jsonl", "平常跑不认这个变量");
});

test("note：追加一行五个字段，权限 0600；再来一次追加第二行", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  noteMisconfig(p, () => rec());
  const one = lines(p);
  assert.equal(one.length, 1);
  assert.deepEqual(JSON.parse(one[0]!), rec());
  assert.equal(statSync(p).mode & 0o777, 0o600);
  noteMisconfig(p, () => rec({ t: 2_000, sub: "hhd" }));
  assert.equal(lines(p).length, 2);
});

test("note：路径是符号链接不跟，什么都不写", () => {
  const d = tmpDir("hh-trace-");
  const target = join(d, "target");
  writeFileSync(target, "");
  const link = join(d, "link.jsonl");
  symlinkSync(target, link);
  noteMisconfig(link, () => rec());
  assert.equal(readFileSync(target, "utf8"), "");
});

test("note：文件已经超过 256 KiB 不再长；过长的一行被截短（仍是一行合法 JSON，不超过 1 KB）", () => {
  const d = tmpDir("hh-trace-");
  const big = join(d, "big.jsonl");
  writeFileSync(big, "");
  truncateSync(big, 256 * 1024 + 1);
  noteMisconfig(big, () => rec());
  assert.equal(statSync(big).size, 256 * 1024 + 1);
  const p = join(d, "long.jsonl");
  noteMisconfig(p, () => rec({ what: "x".repeat(5000), parent: "y".repeat(5000), cwd: "z".repeat(5000) }));
  const raw = readFileSync(p);
  assert.ok(raw.length <= 1025, String(raw.length));
  const l = lines(p);
  assert.equal(l.length, 1);
  assert.equal((JSON.parse(l[0]!) as MisconfigRecord).sub, "status");
});

test("note：写不成（目录不存在、路径是目录、文件不可写）都不抛", () => {
  const d = tmpDir("hh-trace-");
  assert.doesNotThrow(() => noteMisconfig(join(d, "no", "such", "t.jsonl"), () => rec()));
  assert.doesNotThrow(() => noteMisconfig(d, () => rec()));
  const ro = join(d, "ro.jsonl");
  writeFileSync(ro, "");
  chmodSync(ro, 0o400);
  assert.doesNotThrow(() => noteMisconfig(ro, () => rec()));
});

test("noteEntryFailure：没有目标路径什么都不做；有就记一行，sub 只取给的那个，父进程命令行截到 200 字", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  noteEntryFailure(new Error("config: nope"), "status", { path: null, parent: () => "never" });
  noteEntryFailure(new Error("config: nope"), "status", { path: p, parent: () => "q".repeat(500), now: () => 42 });
  const l = lines(p);
  assert.equal(l.length, 1);
  const r = JSON.parse(l[0]!) as MisconfigRecord;
  assert.equal(r.what, "config: nope");
  assert.equal(r.sub, "status");
  assert.equal(r.t, 42);
  assert.equal(r.parent.length, 200);
  assert.equal(r.cwd, process.cwd());
  assert.doesNotThrow(() => noteEntryFailure("not an error", "x", { path: join(p, "x", "y"), parent: () => { throw new Error("ps broke"); } }));
});

test("read：从偏移读新的行；文件变小从头读；坏行跳过；缺文件、符号链接没有记录", () => {
  const d = tmpDir("hh-trace-");
  const p = join(d, "t.jsonl");
  const miss = readMisconfig(p, 0);
  assert.deepEqual([miss.records, miss.nextOffset, miss.state], [[], 0, "missing"]);
  noteMisconfig(p, () => rec({ t: 1 }));
  const a = readMisconfig(p, 0);
  assert.equal(a.records.length, 1);
  assert.equal(a.nextOffset, statSync(p).size);
  noteMisconfig(p, () => rec({ t: 2 }));
  const b = readMisconfig(p, a.nextOffset);
  assert.deepEqual(b.records.map((r) => r.t), [2]);
  // 变小了：从头
  writeFileSync(p, JSON.stringify(rec({ t: 9 })) + "\n");
  assert.deepEqual(readMisconfig(p, b.nextOffset + 1000).records.map((r) => r.t), [9]);
  // 坏行：不是 JSON、不是对象、数组
  appendFileSync(p, "garbage\n[1,2]\n42\n\n" + JSON.stringify(rec({ t: 10 })) + "\n");
  assert.deepEqual(readMisconfig(p, 0).records.map((r) => r.t), [9, 10]);
  // 没写完的最后一行（没有换行）留到下次
  appendFileSync(p, '{"t":11');
  const c = readMisconfig(p, 0);
  assert.deepEqual(c.records.map((r) => r.t), [9, 10]);
  appendFileSync(p, ',"what":"w","sub":"s","parent":"p","cwd":"c"}\n');
  assert.deepEqual(readMisconfig(p, c.nextOffset).records.map((r) => r.t), [11]);
  // 符号链接
  const link = join(d, "link.jsonl");
  symlinkSync(p, link);
  const viaLink = readMisconfig(link, 0);
  assert.deepEqual([viaLink.records, viaLink.state], [[], "unusable"]);
  // 路径是目录
  mkdirSync(join(d, "dir"));
  assert.doesNotThrow(() => readMisconfig(join(d, "dir"), 0));
});

test("报告：同一个父进程一小时只报一次（期间的次数攒着一起报）；不同父进程各报各的；一天以前的不报", () => {
  const d = tmpDir("hh-trace-");
  const p = join(d, "t.jsonl");
  const H = 3_600_000;
  const T0 = 100 * H;
  const w = new MisconfigWatch(p);
  assert.deepEqual(w.poll(T0), []);
  noteMisconfig(p, () => rec({ t: T0 - 10, parent: "A" }));
  noteMisconfig(p, () => rec({ t: T0 - 5, parent: "A" }));
  noteMisconfig(p, () => rec({ t: T0 - 1, parent: "B", sub: "hhd" }));
  noteMisconfig(p, () => rec({ t: T0 - 30 * H, parent: "OLD" }));
  const r1 = w.poll(T0);
  assert.deepEqual(r1.map((r) => [r.parent, r.count]).sort(), [["A", 2], ["B", 1]]);
  assert.equal(r1.find((r) => r.parent === "B")?.sub, "hhd");
  assert.deepEqual(w.poll(T0 + 1000), [], "没有新行");
  noteMisconfig(p, () => rec({ t: T0 + 2000, parent: "A" }));
  assert.deepEqual(w.poll(T0 + 10 * 60_000), [], "一小时内不再报 A");
  noteMisconfig(p, () => rec({ t: T0 + 3000, parent: "A" }));
  const r2 = w.poll(T0 + H + 1);
  assert.deepEqual(r2.map((r) => [r.parent, r.count]), [["A", 2]]);
});

test("status 摘要：最近 24 小时几次、来自哪些父进程，次数多的在前，最多 5 个；没有就是 null", () => {
  const d = tmpDir("hh-trace-");
  const p = join(d, "t.jsonl");
  const H = 3_600_000;
  const T0 = 100 * H;
  const w = new MisconfigWatch(p);
  w.poll(T0);
  assert.equal(w.summary(T0), null);
  noteMisconfig(p, () => rec({ t: T0 - 30 * H, parent: "OLD" }));
  for (const [par, n] of [["a", 1], ["b", 3], ["c", 2], ["d", 1], ["e", 1], ["f", 1]] as const) for (let i = 0; i < n; i++) noteMisconfig(p, () => rec({ t: T0 - H, parent: par }));
  w.poll(T0);
  const s = w.summary(T0)!;
  assert.equal(s.count, 9);
  assert.equal(s.parents.length, 5);
  assert.deepEqual(s.parents.slice(0, 2), [{ parent: "b", count: 3 }, { parent: "c", count: 2 }]);
  assert.equal(w.summary(T0 + 24 * H), null, "过了 24 小时都不算了");
  assert.match(w.line(T0)!, /^instance: 9 entries? failed the instance check in the last 24h — b \(3\), c \(2\)/);
});

// ---- 复核之后加的 ----

const HERE = fileURLToPath(new URL("../src/instance-trace.ts", import.meta.url));

// 同进程里卡住的同步 open 没法被超时打断（事件循环也卡着），所以这两条在子进程里跑，spawn 带超时：卡住 = 失败，不是整个测试卡死
const PROBE = (path: string): string => `import { noteMisconfig, noteEntryFailure, readMisconfig, MisconfigWatch, reportMisconfigTrace } from ${JSON.stringify(HERE)};
import { Logger } from ${JSON.stringify(fileURLToPath(new URL("../src/log.ts", import.meta.url)))};
const path = ${JSON.stringify(path)};
noteMisconfig(path, () => ({ t: 1, what: "w", sub: "s", parent: "p", cwd: "c" }));
noteEntryFailure(new Error("x"), "s", { path, parent: () => "p" });
const r = readMisconfig(path, 0);
const seen = [];
reportMisconfigTrace(new MisconfigWatch(path), new Logger("hhd", (x) => seen.push(x)), Date.now());
console.log(JSON.stringify({ state: r.state, records: r.records.length, errors: seen.filter((x) => x.level === "error").map((x) => x.msg) }));
`;
const probeAt = (d: string, path: string): { out: { state: string; records: number; errors: string[] }; timedOut: boolean; status: number | null; stderr: string } => {
  const script = join(d, "probe.mjs");
  writeFileSync(script, PROBE(path));
  // 卡住的 open 永远不回来，所以上限只用来分「卡住」和「慢」：给足 20 秒（部署时整套测试并行、机器很忙，慢启动不能被当成卡住）
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL" });
  return { out: r.stdout ? JSON.parse(r.stdout) as { state: string; records: number; errors: string[] } : { state: "", records: -1, errors: [] }, timedOut: r.error !== undefined, status: r.status, stderr: r.stderr };
};

test("C1：路径上真放一个没人读写的命名管道：写、读、hhd 的轮询都不卡，记一条「不能用」的 error", { timeout: 30_000 }, (t) => {
  const d = tmpDir("hh-trace-");
  const f = join(d, "fifo.jsonl");
  if (spawnSync("/usr/bin/mkfifo", [f]).status !== 0) { t.skip("mkfifo is not available on this machine"); return; }
  const r = probeAt(d, f);
  assert.equal(r.timedOut, false, "子进程被超时杀掉：对管道的 open 阻塞了");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { state: "unusable", records: 0, errors: ["instance: the trace file is unusable"] });
});

test("路径上是一个目录：不卡、什么都没写、「不能用」", { timeout: 30_000 }, () => {
  const d = tmpDir("hh-trace-");
  const dir = join(d, "adir.jsonl");
  mkdirSync(dir);
  const r = probeAt(d, dir);
  assert.equal(r.timedOut, false);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { state: "unusable", records: 0, errors: ["instance: the trace file is unusable"] });
  assert.deepEqual(readdirSync(dir), []);
});

test("note：硬链接（链接数不是 1）的文件不写", () => {
  const d = tmpDir("hh-trace-");
  const a = join(d, "a");
  writeFileSync(a, "");
  linkSync(a, join(d, "b.jsonl"));
  noteMisconfig(join(d, "b.jsonl"), () => rec());
  assert.equal(readFileSync(a, "utf8"), "");
});

test("note：sub 最多 40 个字；过长时先缩 what 和 cwd，父进程命令行尽量留全", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  noteMisconfig(p, () => rec({ sub: "s".repeat(500), parent: "P".repeat(200), what: "w".repeat(3000), cwd: "c".repeat(3000) }));
  const r = JSON.parse(lines(p)[0]!) as MisconfigRecord;
  assert.equal(r.sub.length, 40);
  assert.equal(r.parent.length, 200);
  assert.ok(Buffer.byteLength(lines(p)[0]!) <= 1024);
});

test("read：未来日期、过长的字段、没有换行的整段窗口、换了文件", () => {
  const d = tmpDir("hh-trace-");
  const p = join(d, "t.jsonl");
  writeFileSync(p, JSON.stringify(rec({ parent: "p".repeat(900), what: "w".repeat(900) })) + "\n");
  const a = readMisconfig(p, 0);
  assert.equal(a.records[0]!.parent.length, 200);
  assert.equal(a.records[0]!.what.length, 300);
  // 一整个窗口都没有换行：跳过这一段，不卡在原地
  const big = join(d, "nonl.jsonl");
  writeFileSync(big, "x".repeat(600 * 1024));
  const b = readMisconfig(big, 0);
  assert.deepEqual(b.records, []);
  assert.ok(b.nextOffset > 0);
  // 换了一个文件（inode 变了）比旧偏移还大：从头读
  const first = readMisconfig(p, 0);
  const q = join(d, "t2.jsonl");
  writeFileSync(q, (JSON.stringify(rec({ t: 5 })) + "\n").repeat(20));
  const c = readMisconfig(q, 3, first.ino);
  assert.equal(c.records.length, 20);
});

test("报告：未来日期的记录按现在算（会过期）；各父进程各自的一小时；一天以前的记忆被清掉", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const H = 3_600_000;
  const T0 = 500 * H;
  const w = new MisconfigWatch(p);
  w.poll(T0);
  noteMisconfig(p, () => rec({ t: T0 + 100 * H, parent: "F" }));
  assert.equal(w.poll(T0).length, 1);
  assert.equal(w.summary(T0 + 25 * H), null, "未来的那条也在 24 小时后过期");
  noteMisconfig(p, () => rec({ t: T0 + 25 * H, parent: "A" }));
  assert.equal(w.poll(T0 + 25 * H).length, 1);
  noteMisconfig(p, () => rec({ t: T0 + 25 * H + 1, parent: "B" }));
  noteMisconfig(p, () => rec({ t: T0 + 25 * H + 2, parent: "A" }));
  const r = w.poll(T0 + 25 * H + 10);
  assert.deepEqual(r.map((x) => x.parent), ["B"], "A 的一小时没过，B 是头一次");
  w.poll(T0 + 60 * H);
  assert.equal(w.memorySize(), 0, "超过一天的记忆清掉了（memorySize 自己不 poll）");
});

test("I2 守护进程这边：读完、文件大过 128 KiB 就截空；之后新写的行照常读到", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const w = new MisconfigWatch(p);
  const T = 1_000_000_000_000;
  writeFileSync(p, (JSON.stringify(rec({ t: T, parent: "z".repeat(150) })) + "\n").repeat(Math.ceil(TRIM_BYTES / 200) + 100));
  assert.ok(statSync(p).size > TRIM_BYTES);
  w.poll(T);
  assert.equal(statSync(p).size, 0, "读完以后截空了");
  noteMisconfig(p, () => rec({ t: T + 1, parent: "after" }));
  assert.deepEqual(w.poll(T + 2).map((r) => r.parent), ["after"]);
  // 没超过 128 KiB 不动
  assert.ok(statSync(p).size > 0);
});

test("I2：文件在但不能用：一个小时里只记一次 error；好了以后不再记", () => {
  const d = tmpDir("hh-trace-");
  const real = join(d, "real");
  writeFileSync(real, "");
  const p = join(d, "t.jsonl");
  symlinkSync(real, p);
  const into: LogRecord[] = [];
  const log = new Logger("hhd", memorySink(into));
  const w = new MisconfigWatch(p);
  const T = 1_000_000_000_000;
  reportMisconfigTrace(w, log, T);
  reportMisconfigTrace(w, log, T + 600_000);
  const bad = into.filter((r) => r.msg === "instance: the trace file is unusable");
  assert.equal(bad.length, 1);
  assert.equal(bad[0]!.level, "error");
  assert.equal(typeof bad[0]!.reason, "string");
  reportMisconfigTrace(w, log, T + 3_700_000);
  assert.equal(into.filter((r) => r.msg === "instance: the trace file is unusable").length, 2);
});

test("hhd 的接线：文件里的行 → 每个父进程记一条 error → status 多一个字段；下一个小时里没有新的报告；字段在 handle 里合进 status 且出错不坏 status", async () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const into: LogRecord[] = [];
  const log = new Logger("hhd", memorySink(into));
  const w = new MisconfigWatch(p);
  const T = 1_000_000_000_000;
  noteMisconfig(p, () => rec({ t: T - 5, parent: "job one", sub: "status" }));
  noteMisconfig(p, () => rec({ t: T - 4, parent: "job one", sub: "status" }));
  noteMisconfig(p, () => rec({ t: T - 3, parent: "job two", sub: "tell" }));
  reportMisconfigTrace(w, log, T);
  const errs = into.filter((r) => r.level === "error");
  assert.equal(errs.length, 2);
  assert.ok(errs.every((r) => r.msg === "instance: an entry started without its config"));
  const one = errs.find((r) => r.parent === "job one")!;
  assert.deepEqual([one.sub, one.count, one.what, one.cwd], ["status", 2, "config: stateDir is not set", "/work"]);
  const extra = statusExtraOf(w, () => T)();
  assert.match(String(extra.entriesWithoutConfig), /3 entries/);
  // 下一个小时里同一批来源再来：不再报
  noteMisconfig(p, () => rec({ t: T + 10, parent: "job one" }));
  reportMisconfigTrace(w, log, T + 600_000);
  assert.equal(into.filter((r) => r.level === "error").length, 2);
  // 没有记录：没有字段
  assert.deepEqual(statusExtraOf(new MisconfigWatch(join(tmpDir("hh-trace-"), "none")), () => T)(), {});
  // handle：合进去；默认和 brain.status() 一样；回调抛了 status 照样回
  const brain = { status: () => ({ alertness: "awake" }) } as never;
  assert.deepEqual(await handle(brain, { cmd: "status" }), { alertness: "awake" });
  assert.deepEqual(await handle(brain, { cmd: "status" }, () => ({ extra: 1 })), { alertness: "awake", extra: 1 });
  assert.deepEqual(await handle(brain, { cmd: "status" }, () => { throw new Error("boom"); }), { alertness: "awake" });
});

// ---- 第二轮 ----

test("T2：唯一的写路径：文件不能写时 make 不会被调（不去问 ps）；能写时才调一次；make 抛了也不抛出来", () => {
  const d = tmpDir("hh-trace-");
  const real = join(d, "real");
  writeFileSync(real, "");
  const link = join(d, "link.jsonl");
  symlinkSync(real, link);
  let called = 0;
  noteMisconfig(link, () => { called++; return rec(); });
  assert.equal(called, 0);
  let parentAsked = 0;
  noteEntryFailure(new Error("x"), "s", { path: link, parent: () => { parentAsked++; return "p"; } });
  assert.equal(parentAsked, 0, "写不了的文件，noteEntryFailure 也不去问父进程");
  const p = join(d, "ok.jsonl");
  noteMisconfig(p, () => { called++; return rec(); });
  assert.equal(called, 1);
  assert.doesNotThrow(() => noteMisconfig(p, () => { throw new Error("boom"); }));
});

const bigLines = (n: number, t: number): string => (JSON.stringify(rec({ t, parent: "z".repeat(150) })) + "\n").repeat(n);

test("T3a：文件大过 128 KiB、最后一行还没写完（没有换行）：不截；补完以后那一行照常报一次", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const T = 1_000_000_000_000;
  const w = new MisconfigWatch(p);
  const partial = JSON.stringify(rec({ t: T, parent: "late" }));
  writeFileSync(p, bigLines(Math.ceil(TRIM_BYTES / 200) + 100, T) + partial.slice(0, 20));
  const size = statSync(p).size;
  assert.ok(size > TRIM_BYTES);
  w.poll(T);
  assert.equal(statSync(p).size, size, "没读完（尾巴没有换行），不能截");
  appendFileSync(p, partial.slice(20) + "\n");
  const r = w.poll(T + 1);
  assert.deepEqual(r.map((x) => x.parent), ["late"]);
});

test("T3b：截的那一步只在文件大小还正好等于刚读到的偏移时才做（直接测 trimTrace：读完以后文件又长了就不截）", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  writeFileSync(p, bigLines(Math.ceil(TRIM_BYTES / 200) + 100, 1));
  const readUpTo = statSync(p).size;
  appendFileSync(p, JSON.stringify(rec({ t: 2 })) + "\n");   // 读完和截之间又来了一行
  assert.equal(trimTrace(p, readUpTo), false);
  assert.ok(statSync(p).size > readUpTo, "文件没动");
  assert.equal(trimTrace(p, statSync(p).size), true);
  assert.equal(statSync(p).size, 0);
  // 不大于下限的不截
  writeFileSync(p, "x\n");
  assert.equal(trimTrace(p, 2), false);
});

test("T4：超过写的一边的上限（256 KiB）、尾巴没有换行的文件自己恢复不了：hhd 截空它，记一条「重置」的 error，之后的行照常读", () => {
  const d = tmpDir("hh-trace-");
  const p = join(d, "t.jsonl");
  const T = 1_000_000_000_000;
  writeFileSync(p, bigLines(2000, T) + "x".repeat(1000));
  const size = statSync(p).size;
  assert.ok(size > 256 * 1024);
  const into: LogRecord[] = [];
  const log = new Logger("hhd", memorySink(into));
  const w = new MisconfigWatch(p);
  reportMisconfigTrace(w, log, T);
  assert.equal(statSync(p).size, 0);
  const reset = into.filter((r) => r.msg === "instance: the trace file was reset");
  assert.equal(reset.length, 1);
  assert.equal(reset[0]!.size, size);
  noteMisconfig(p, () => rec({ t: T + 5, parent: "after reset" }));
  reportMisconfigTrace(w, log, T + 6);
  assert.ok(into.some((r) => r.parent === "after reset"));
});

// ---- 第三轮 ----

test("C1：比读的窗口（512 KiB）还大、通篇都是整行的文件：不当成卡死的文件重置，几次轮询读到底、一行不丢；读到底以后照常截空", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const T = 1_000_000_000_000;
  const n = 5000;
  writeFileSync(p, bigLines(n, T));
  const size = statSync(p).size;
  assert.ok(size > 2 * 512 * 1024, `夹具要比两个窗口还大：${size}`);
  const into: LogRecord[] = [];
  const log = new Logger("hhd", memorySink(into));
  const w = new MisconfigWatch(p);
  let polls = 0;
  while (polls < 10) {
    reportMisconfigTrace(w, log, T + polls);
    polls++;
    if (statSync(p).size === 0) break;
    assert.equal(statSync(p).size, size, `第 ${polls} 次轮询还没读到底，不能动文件`);
  }
  assert.ok(polls >= 3, `一个窗口读不完，得好几次：${polls}`);
  assert.equal(statSync(p).size, 0, "读到底以后截空（平常那条路）");
  assert.equal(into.filter((r) => r.msg === "instance: the trace file was reset").length, 0, "不是「重置」");
  assert.equal(w.summary(T + polls)!.count, n, "每一行都读到了");
});

test("一天以前的记录不报也不数：同一个父进程一条 25 小时前、一条 5 分钟前 → 报告里 count 是 1，24 小时摘要也是 1", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const H = 3_600_000;
  const now = 1_000 * H;
  noteMisconfig(p, () => rec({ t: now - 25 * H, parent: "same job" }));
  noteMisconfig(p, () => rec({ t: now - 5 * 60_000, parent: "same job" }));
  const w = new MisconfigWatch(p);
  assert.deepEqual(w.poll(now).map((r) => [r.parent, r.count]), [["same job", 1]]);
  assert.equal(w.summary(now)!.count, 1);
});

// ---- 整段审阅后的收尾 ----

test("最近 24 小时的记录最多留 5000 条（最新的）：多出来的丢掉，摘要和 status 那一行说 5000+、不说一个错的准数；丢的那些也过了 24 小时就又是准数", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const T = 1_000_000_000_000;
  const DAY = 24 * 3_600_000;
  // 5001 行短记录（不到一个读的窗口）；最老的那条换个父进程名，看丢的是不是它
  writeFileSync(p, Array.from({ length: 5001 }, (_, i) => JSON.stringify(rec({ t: T - 5001 + i, parent: i === 0 ? "oldest" : "p" })) + "\n").join(""));
  const w = new MisconfigWatch(p);
  for (let i = 0; i < 5 && statSync(p).size > 0; i++) w.poll(T);
  assert.equal(statSync(p).size, 0, "读到底了");
  const s = w.summary(T)!;
  assert.equal(s.count, 5000);
  assert.equal(s.capped, true);
  assert.ok(!s.parents.some((x) => x.parent === "oldest"), "丢的是最老的");
  assert.match(w.line(T)!, /^instance: 5000\+ entries failed the instance check in the last 24h — p \(5000\)$/);
  const later = T - 5001 + DAY + 1;
  assert.equal(w.summary(later)!.capped, false);
  assert.match(w.line(later)!, /^instance: 5000 entries failed/);
});

test("报给 hhd 日志的那条 error 带着这个父进程最新那条记录的时间（lastAt，ISO），紧挨着 count；记录的先后乱了也取最新的", () => {
  const p = join(tmpDir("hh-trace-"), "t.jsonl");
  const T = 1_000_000_000_000;
  noteMisconfig(p, () => rec({ t: T - 50, parent: "job" }));
  noteMisconfig(p, () => rec({ t: T - 7, parent: "job" }));
  noteMisconfig(p, () => rec({ t: T - 20, parent: "job" }));
  const into: LogRecord[] = [];
  reportMisconfigTrace(new MisconfigWatch(p), new Logger("hhd", memorySink(into)), T);
  const e = into.find((r) => r.msg === "instance: an entry started without its config");
  assert.ok(e, JSON.stringify(into));
  assert.equal(e.count, 3);
  assert.equal(e.lastAt, new Date(T - 7).toISOString());
  const keys = Object.keys(e);
  assert.equal(keys.indexOf("lastAt"), keys.indexOf("count") + 1, keys.join(","));
});
