// 各模块的单元测试（不涉及 Brain 编排）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, kvSet as kvSetU } from "../src/store/db.ts";
import { CentralMemory, renderMemory, truncate } from "../src/memory/central.ts";
import { estimateTokens } from "../src/memory/tokens.ts";
import { localTime, focusSlotAt, nightSleepDue, nightOf, inNight, hhmm, nextDay, calendarDay } from "../src/brainstem/clock.ts";
import { decide } from "../src/brainstem/state.ts";
import { Claims, outletDecision, SHORT_REPLY_MAX } from "../src/basal/claims.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import { Persona, buildPrefix, hhRuntimeNote, languageLine, runtimeNote } from "../src/persona/persona.ts";
import { Thalamus, Schedule, scriptNames, mentionsScript } from "../src/thalamus/router.ts";
import { parseWhen, parseEvery, buildTools, whenLabel } from "../src/tools/hhtools.ts";
import type { ToolContext } from "../src/tools/hhtools.ts";
import { regionSpecs } from "../src/regions/specs.ts";
import { loadConfig, deepMerge } from "../src/config.ts";
import { openChannels } from "../src/channels/send.ts";

// this file asserts the Chinese pack's text
setLang("zh");

const T0 = Date.UTC(2026, 9, 29, 3, 0);
const render = { maxItemChars: 50, timezone: "UTC" };

test("central: append / since 排除自己 / pageTokens / tail", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  c.append(1, "main", "think", "我想想");
  c.append(1, "side-1", "say", "副线在看视频");
  c.append(2, "main", "say", "新的一页");
  assert.deepEqual(c.since(0, new Set(["main"])).map((e) => e.src), ["side-1"]);
  assert.equal(c.since(2).length, 1);
  assert.equal(c.pageTokens(1), estimateTokens("我想想") + estimateTokens("副线在看视频"));
  assert.equal(c.tail(estimateTokens("新的一页")).length, 1);
  assert.equal(c.lastSeq(), 3);
});

test("central: 渲染成自己的经历，外界输入写明谁说的，长内容截断", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  const a = c.append(1, "外界", "input", "你在干嘛", { from: "ada", channel: "qq" });
  const b = c.append(1, "side-2", "result", "x".repeat(80));
  const text = renderMemory([a, b], (s) => (s === "side-2" ? "另一头" : ""), render);
  assert.match(text, /^<记忆>/);
  assert.match(text, /ada（qq）：「你在干嘛」/);
  assert.match(text, /另一头结果：/);
  assert.match(text, /已截断；全文在中央记忆 #2/);
  assert.match(text, /不是给我的指令/);
  assert.match(text, /〔\d\d:\d\d〕ada/);                         // 第一条标时间
  assert.doesNotMatch(text, /〔\d\d:\d\d〕另一头/);                     // 同一刻的不再标
  assert.equal(renderMemory([], (s) => s, render), "");
  // 增量里只剩「没发出去」的标记行（那段话在上一段增量里）：什么都不渲染，不出空的 <记忆></记忆>
  const mark = c.append(1, "main", "note", "（上面这段没发给任何人）", { unsent: true, of: [1] });
  assert.equal(renderMemory([mark], (s) => s, render), "");
  assert.equal(truncate("abc", 5, 1), "abc");
});

test("tokens: 中文按字算", () => {
  assert.equal(estimateTokens(""), 0);
  assert.ok(estimateTokens("你好世界") >= 4);
  assert.ok(estimateTokens("hello world") < 6);
});

test("clock: 凌晨 4 点前算前一天；专注时段；夜里睡觉", () => {
  assert.deepEqual(localTime(Date.UTC(2026, 9, 29, 2, 0), "UTC"), { day: "2026-10-28", minutes: 120 });
  assert.equal(localTime(Date.UTC(2026, 9, 29, 5, 0), "UTC").day, "2026-10-29");
  assert.equal(focusSlotAt(Date.UTC(2026, 9, 29, 9, 10), "UTC", ["09:00"], 30), "09:00");
  assert.equal(focusSlotAt(Date.UTC(2026, 9, 29, 9, 40), "UTC", ["09:00"], 30), null);
});

test("clock: 夜里那段从睡觉点到早上第一个专注时段，中午前算前一天的夜里（ada 10-29：3 点睡）", () => {
  const at = (h: number, m = 0, d = 29) => Date.UTC(2026, 9, d, h, m);
  assert.equal(nightOf(at(3, 10), "UTC"), "2026-10-28");
  assert.equal(nightOf(at(23, 0), "UTC"), "2026-10-29");
  assert.equal(nightSleepDue(at(2, 50), "UTC", "03:00", "07:30", null), false);
  assert.equal(nightSleepDue(at(3, 10), "UTC", "03:00", "07:30", null), true);
  assert.equal(nightSleepDue(at(5, 0), "UTC", "03:00", "07:30", null), true);           // 聊过了 4 点，闲下来照样睡
  assert.equal(nightSleepDue(at(7, 40), "UTC", "03:00", "07:30", null), false);         // 到早上就不睡了
  assert.equal(nightSleepDue(at(3, 10), "UTC", "03:00", "07:30", "2026-10-28"), false);  // 这一夜睡过了
  assert.equal(nightSleepDue(at(3, 10, 30), "UTC", "03:00", "07:30", "2026-10-28"), true); // 第二夜
  assert.equal(nightSleepDue(at(23, 30), "UTC", "23:00", "07:30", null), true);         // 睡觉点在午夜前也行
  assert.equal(inNight(at(6, 0), "UTC", "03:00", "07:30"), true);
  assert.equal(inNight(at(14, 0), "UTC", "03:00", "07:30"), false);
});

test("brainstem: 困 / 必须睡 / 闲下来就睡 / 专注时撑着", () => {
  const t = { sleepyAt: 150, mustSleepAt: 200, idleMinutes: 20 };
  const base = { now: T0, compactedTokens: 0, busy: false, lastActivity: T0, inFocus: false, nightDue: false };
  assert.equal(decide("awake", base, t).state, "awake");
  assert.equal(decide("awake", { ...base, compactedTokens: 160 }, t).state, "sleepy");
  assert.equal(decide("sleepy", { ...base, compactedTokens: 160, lastActivity: T0 - 21 * 60_000 }, t).sleepNow, true);
  assert.equal(decide("sleepy", { ...base, compactedTokens: 160, lastActivity: T0 - 21 * 60_000, inFocus: true }, t).sleepNow, false);
  assert.equal(decide("sleepy", { ...base, compactedTokens: 160, lastActivity: T0 - 21 * 60_000, busy: true }, t).sleepNow, false);
  assert.equal(decide("awake", { ...base, compactedTokens: 200, busy: true, inFocus: true }, t).sleepNow, true);
  assert.equal(decide("awake", { ...base, nightDue: true, lastActivity: T0 - 120_000 }, t).sleepNow, true);
  assert.equal(decide("asleep", { ...base, compactedTokens: 999 }, t).sleepNow, false);
});

test("basal: 认领冲突、释放、唯一出口", () => {
  const cl = new Claims(openDb(":memory:"), () => T0);
  assert.equal(cl.claim("看视频", "side-1"), null);
  assert.equal(cl.claim("看视频", "side-2"), "side-1");
  assert.equal(cl.release("看视频", "side-2"), false);
  assert.equal(cl.release("看视频", "side-1"), true);
  assert.equal(cl.claim("看视频", "side-2"), null);
  assert.equal(cl.releaseAll("side-2"), 1);

  const specs = regionSpecs(loadConfig());
  const by = (id: string) => specs.find((s) => s.id === id)!;
  assert.equal(outletDecision(by("main"), "message", { message: "长长的话" }), undefined);
  assert.ok(outletDecision(by("side-1"), "message", { message: "嗯" }));
  assert.equal(outletDecision(by("speech"), "message", { message: "嗯嗯我看看" }), undefined);
  assert.ok(outletDecision(by("speech"), "message", { message: "x".repeat(SHORT_REPLY_MAX + 1) }));
  assert.equal(outletDecision(by("side-1"), "jot_down", {}), undefined);
});

test("epochs + prefix: 压缩块往后接、清空；前缀所有脑区一样", () => {
  const ep = new Epochs(openDb(":memory:"), () => T0);
  assert.equal(ep.current(), null);
  const e1 = ep.begin("boot", 1);
  ep.addBlock(e1.id, "第一页的事");
  ep.addBlock(e1.id, "第二页的事");
  assert.equal(ep.blocks().length, 2);
  const persona = new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }]);
  const prefix = buildPrefix(persona, ep.blocks());
  assert.ok(prefix.startsWith(hhRuntimeNote()));
  assert.ok(prefix.indexOf("第一页的事") < prefix.indexOf("第二页的事"));
  assert.ok(ep.compactedTokens() > 0);
  assert.equal(ep.clearBlocks(), 2);
  assert.equal(ep.compactedTokens(), 0);
  assert.equal(buildPrefix(persona, ep.blocks()).includes("这次醒来以后"), false);
  assert.equal(ep.begin("page-turn", 10).id, 2);
});

test("thalamus: 睡着时进待办，醒来取出；提醒一次性 / 循环", () => {
  const db = openDb(":memory:");
  const th = new Thalamus(db, () => T0);
  const ev = { from: "ada", text: "在吗", human: true };
  assert.deepEqual(th.route(ev, false), { kind: "deliver", region: "main", event: ev });
  assert.equal(th.route(ev, true).kind, "queue");
  assert.equal(th.pendingTodos(), 1);
  const items = th.pendingTodoItems();
  assert.deepEqual(items.map((x) => x.event), [ev]);
  assert.equal(th.pendingTodos(), 1);          // 送达前不标记
  th.markDone(items[0]!.id);
  assert.equal(th.pendingTodos(), 0);

  const sc = new Schedule(db);
  sc.add("remind", T0 + 1000, "一次");
  sc.add("remind", T0 + 1000, "循环", 3_600_000);
  assert.equal(sc.takeDue(T0).length, 0);
  assert.equal(sc.takeDue(T0 + 2000).length, 2);
  assert.equal(sc.list().length, 1);
  assert.equal(sc.list()[0]!.due, T0 + 1000 + 3_600_000);
});

test("提醒：循环提醒「今天做过了」记在 kv 一个键里（不加表）；写的时候清掉已经不在的编号", () => {
  const db = openDb(":memory:");
  const sc = new Schedule(db);
  const a = sc.add("remind", T0 + 1000, "每天跑一次", 86_400_000);
  const b = sc.add("remind", T0 + 1000, "每两小时看一次", 7_200_000);
  assert.equal(sc.doneAt(a), null);
  sc.setDone(a, T0);
  sc.setDone(b, T0 + 5);
  assert.equal(sc.doneAt(a), T0);
  assert.equal(sc.doneAt(b), T0 + 5);
  assert.deepEqual(JSON.parse(kvGetU(db, "remind_done")!), { [a]: T0, [b]: T0 + 5 });
  sc.remove(a);
  sc.setDone(b, T0 + 9);                         // 写的时候：取消了的 #a 清掉
  assert.deepEqual(JSON.parse(kvGetU(db, "remind_done")!), { [b]: T0 + 9 });
  assert.equal(sc.doneAt(a), null);
  kvSetU(db, "remind_done", "坏了");              // 读坏了当没有
  assert.equal(sc.doneAt(b), null);
});

test("提醒：提醒里写到的脚本只留文件名，去重；不是脚本的不算", () => {
  assert.deepEqual(scriptNames("跑 python3 -I scripts/hot_collect.py 收今天的热点，再跑 ./tools/post.sh 和 hot_collect.py"), ["hot_collect.py", "post.sh"]);
  assert.deepEqual(scriptNames("node a/b/run.mjs; bun x.ts; foo.pyc; 看一次小红书私信"), ["run.mjs", "x.ts"]);
  assert.deepEqual(scriptNames("没有脚本"), []);
  // 对整个文件名：前面是开头、/、空白、引号，后面不再接名字里的字
  assert.ok(mentionsScript('Bash {"command":"python3 scripts/foo.py"}', "foo.py"));
  assert.ok(mentionsScript("cd scripts && python3 foo.py --x", "foo.py"));
  assert.ok(mentionsScript('hands {"text":"foo.py"}', "foo.py"));
  assert.ok(!mentionsScript('Bash {"command":"python3 scripts/myfoo.py"}', "foo.py"));
  assert.ok(!mentionsScript('Bash {"command":"cp foo.py.bak x"}', "foo.py"));
  assert.ok(!mentionsScript('Bash {"command":"cat foo-py foo_py"}', "foo.py"));
});

test("中央记忆：某个时刻以后提到某些词的动作（只看动作）", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => T0);
  c.append(1, "side-1", "act", 'Bash {"command":"python3 scripts/foo.py"}', null, T0 - 3 * 3_600_000);
  c.append(1, "side-1", "act", 'Bash {"command":"python3 scripts/foo.py --again"}', null, T0 - 600_000);
  c.append(1, "side-1", "result", "foo.py 跑完了", null, T0 - 500_000);
  c.append(1, "main", "act", 'Read {"file_path":"/x/bar.sh"}', null, T0 - 400_000);
  c.append(1, "main", "act", 'Read {"file_path":"/x/other.md"}', null, T0 - 300_000);
  assert.deepEqual(c.actsMentioning(T0 - 3_600_000, ["foo.py"]).map((e) => e.text), ['Bash {"command":"python3 scripts/foo.py --again"}']);
  assert.equal(c.actsMentioning(T0 - 86_400_000, ["foo.py", "bar.sh"]).length, 3);
  assert.deepEqual(c.actsMentioning(T0 - 86_400_000, []), []);
});

test("时钟：钟点 HH:MM、下一天、日历上的一天；给她看的「今天 / 明天」，半夜（0–4 点）的直接写日期", () => {
  const D = Date.UTC(2026, 10, 5);
  assert.equal(hhmm(D + 7 * 3_600_000 + 40 * 60_000, "UTC"), "07:40");
  assert.equal(hhmm(D + 23 * 3_600_000 + 5 * 60_000, "UTC"), "23:05");
  assert.equal(nextDay("2026-11-30"), "2026-12-01");
  const at = D + 8 * 3_600_000;
  assert.equal(whenLabel(D + 9 * 3_600_000, at, "UTC"), "今天 09:00");
  assert.equal(calendarDay(D + 2 * 3_600_000, "UTC"), "2026-11-05");
  assert.equal(localTime(D + 2 * 3_600_000, "UTC").day, "2026-11-04");
  assert.equal(whenLabel(D + 26 * 3_600_000, at, "UTC"), "11-06 02:00");             // 那个时间在半夜：写日期
  assert.equal(whenLabel(D + 7 * 3_600_000 + 40 * 60_000, D + 3.5 * 3_600_000, "UTC"), "11-05 07:40");   // 现在是凌晨 3:30：写日期
  assert.equal(whenLabel(D + 31 * 3_600_000 + 40 * 60_000, at, "UTC"), "明天 07:40");
  assert.equal(whenLabel(D + 3 * 86_400_000 + 10 * 3_600_000, at, "UTC"), "11-08 10:00");
});

test("tools: 时间解析、按角色过滤、send 默认模拟发送", async () => {
  assert.equal(parseWhen("+40m", T0, "UTC"), T0 + 40 * 60_000);
  assert.equal(parseWhen("04:00", T0, "UTC"), T0 + 60 * 60_000);
  assert.equal(parseWhen("02:00", T0, "UTC"), T0 + 23 * 3_600_000);
  assert.throws(() => parseWhen("下午", T0, "UTC"));
  assert.equal(parseEvery("daily"), 86_400_000);
  assert.equal(parseEvery(undefined), null);
  assert.throws(() => parseEvery("10m"));

  const runs: string[][] = [];
  const ctx: ToolContext = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 3,
    run: async (cmd, args) => { runs.push([cmd, ...args]); return { code: 0, stdout: "{}", stderr: "" }; },
    send: openChannels(loadConfig()).send,
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
  };
  const tools = buildTools(ctx, ["message", "jot_down"]);
  assert.deepEqual(tools.map((t) => t.name), ["message", "jot_down"]);
  const out = await tools[0]!.handler({ action: "send", channel: "qqbot", target: "qqbot:c2c:x", message: "hi" });
  assert.match(out, /模拟发送/);
  assert.equal(runs.length, 0);
});

test("message：发 .ogg/.opus 没写 asVoice 时默认当语音条（#0088）", async () => {
  const sent: Array<{ media?: string; asVoice?: boolean }> = [];
  const ctx: ToolContext = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 3,
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    send: async (m) => { sent.push({ media: m.media, asVoice: m.asVoice }); return { ok: true, out: "模拟发送", resolved: m.target }; },
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
  };
  const msg = buildTools(ctx, ["message"])[0]!;
  const go = async (extra: Record<string, unknown>) => { await msg.handler({ action: "send", channel: "whatsapp", target: "+61", ...extra }); return sent[sent.length - 1]!.asVoice; };
  assert.equal(await go({ media: "/a/v.ogg" }), true);
  assert.equal(await go({ media: "/a/V.OGG" }), true);
  assert.equal(await go({ media: "/a/v.opus" }), true);
  assert.equal(await go({ media: "/a/v.ogg", asVoice: false }), false, "明确给 false 照给");
  assert.equal(await go({ media: "/a/v.mp3" }), false);
  assert.equal(await go({ media: "/a/p.png" }), false);
  assert.equal(await go({ message: "hi" }), false);
});

test("config: 深合并只覆盖给出的字段", () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3 }, d: [2] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, d: [2] });
  assert.equal(loadConfig({ limits: { pageTokens: 5 } }).limits.sleepyAtTokens, 150000);
  assert.equal(loadConfig().parallel.urgentNote.minGapMin, 10, "急事最多每 10 分钟叫一次");
  assert.deepEqual(loadConfig().schedule.remindEvidenceTools, ["Bash", "hands"]);
  assert.equal(loadConfig().schedule.focusQuotaWeekMax, 90, "#0060：这周额度到 90% 专注空转少叫");
});

test("#0041: a hand run with her HH_CONFIG exported still tests against the defaults once test/helpers.ts is loaded", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = new URL("..", import.meta.url);
  const dir = mkdtempSync(join(tmpdir(), "hh-0041-"));
  try {
    // 像她真配置那样改掉几个默认值（11-07 她手跑 brain.test.ts 挂的那几类）
    const fake = join(dir, "config.json");
    writeFileSync(fake, JSON.stringify({ stateDir: join(dir, "state"), tools: { sendDryRun: false }, learning: { enabled: true }, limits: { syncThinkChars: 0 }, regions: { sideThreads: 3 } }));
    const pick = (c: { tools: { sendDryRun: boolean }; learning: { enabled: boolean }; limits: { syncThinkChars?: number }; regions: { sideThreads: number } }) =>
      ({ sendDryRun: c.tools.sendDryRun, learning: c.learning.enabled, syncThinkChars: c.limits.syncThinkChars, sideThreads: c.regions.sideThreads });
    const script = `
      const { loadConfig } = await import(${JSON.stringify(new URL("src/config.ts", root).href)});
      const pick = (c) => ({ sendDryRun: c.tools.sendDryRun, learning: c.learning.enabled, syncThinkChars: c.limits.syncThinkChars, sideThreads: c.regions.sideThreads });
      const before = pick(loadConfig());
      await import(${JSON.stringify(new URL("test/helpers.ts", root).href)});
      console.log(JSON.stringify({ before, after: pick(loadConfig()), hh: Object.keys(process.env).filter((k) => k.startsWith("HH_")) }));`;
    const env: NodeJS.ProcessEnv = { ...process.env, HH_CONFIG: fake, HH_SESSION: "sess-4c" };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: fileURLToPath(root), env, encoding: "utf8", timeout: 30_000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { before: unknown; after: unknown; hh: string[] };
    const defaults = pick(JSON.parse(readFileSync(new URL("config/default.json", root), "utf8")));
    assert.deepEqual(out.before, { sendDryRun: false, learning: true, syncThinkChars: 0, sideThreads: 3 }, "没加载 helpers 时假配置是生效的");
    assert.deepEqual(out.after, defaults, "加载 helpers 以后是默认配置");
    assert.deepEqual(out.hh, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { findSkills, materializeSkillsPlugin } from "../src/persona/skills.ts";
import { writeFileSync as wf, mkdirSync as md, readFileSync as rf, readlinkSync, existsSync as ex, realpathSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join as pj } from "node:path";
test("skills: OpenClaw 技能打包成 Claude Code 插件，{baseDir} 换成真实路径，其余文件链接回原处", () => {
  const root = tmpDir("hh-skills-");
  md(pj(root, "src", "stickers", "scripts"), { recursive: true });
  wf(pj(root, "src", "stickers", "SKILL.md"), "---\nname: stickers\n---\n跑 {baseDir}/scripts/sticker.py");
  wf(pj(root, "src", "stickers", "scripts", "sticker.py"), "print(1)");
  const found = findSkills([pj(root, "src")], ["stickers", "nope"]);
  assert.deepEqual(found.map((s) => s.name), ["stickers"]);
  const out = materializeSkillsPlugin(found, pj(root, "out"), "aqing");
  assert.ok(ex(pj(out, ".claude-plugin", "plugin.json")));
  assert.match(rf(pj(out, "skills", "stickers", "SKILL.md"), "utf8"), new RegExp(found[0]!.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/scripts/sticker.py"));
  assert.equal(readlinkSync(pj(out, "skills", "stickers", "scripts")), pj(found[0]!.dir, "scripts"));
});

import { adaptSkillText } from "../src/persona/skills.ts";
test("skills: B站手册的 code mode 写法换成工具名，code mode 专属说明行去掉", () => {
  const src = [
    "description: 都用 bili 插件的工具（code mode 里是 MCP.bili.*）。",
    "const r = await MCP.bili.homeFeed({ n: 3 });",
    "- **code mode 里工具名是驼峰写法**：`MCP.bili.authStatus`",
    "参数：`await API.read(\"mcp/bili.d.ts\")`",
    "然后 MCP.bili.seenMark 标记",
    "code mode 里：",
    "| bili 插件（code mode 里 `MCP.bili.*`） |",
  ].join("\n");
  const out = adaptSkillText(src);
  assert.match(out, /（工具名 mcp__bili__\*）/);
  assert.match(out, /mcp__bili__home_feed\(/);
  assert.match(out, /mcp__bili__seen_mark/);
  assert.doesNotMatch(out, /code mode|API\.read|MCP\.bili/);
});

import { splitBubbles } from "../src/brain.ts";
test("气泡：按空行拆，NO_REPLY 和空段不要", () => {
  assert.deepEqual(splitBubbles("第一句\n还是第一句\n\n第二句\n\n\nNO_REPLY"), ["第一句\n还是第一句", "第二句"]);
  assert.deepEqual(splitBubbles("NO_REPLY"), []);
});

import { recallCentral } from "../src/memory/recall.ts";
test("recall: 在中央记忆里按关键词 / 某人 / 某天 / 前后找原话", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => T0);
  c.append(1, "外界", "input", "眼白有锯齿", { from: "ada" }, Date.UTC(2026, 9, 28, 5, 0));
  c.append(1, "main", "say", "我把眼白重画了", null, Date.UTC(2026, 9, 28, 5, 1));
  c.append(1, "外界", "input", "眼白好看", { from: "小贝" }, Date.UTC(2026, 9, 28, 6, 0));
  const o = { timezone: "UTC", labels: (s: string) => (s === "main" ? "我" : s) };
  const all3 = recallCentral(db, ["search", "眼白"], o);
  assert.equal(all3.split("\n").length, 3);
  assert.match(all3, /ada说：眼白有锯齿/);
  assert.match(all3, /我说：我把眼白重画了/);
  assert.doesNotMatch(recallCentral(db, ["search", "眼白", "--who", "ada"], o), /小贝说/);
  assert.equal(recallCentral(db, ["search", "不存在的话"], o), "");
  assert.match(recallCentral(db, ["day", "2026-10-28"], o), /眼白有锯齿/);
  assert.match(recallCentral(db, ["around", "2", "-n", "1"], o), /#1 .*#2|眼白有锯齿[\s\S]*重画/);
});

test("recall: 没人收的那段话标着（没发出去）；「没发给任何人」的标记行本身搜不到", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => T0);
  const say = c.append(1, "main", "say", "稿子发出去了，等他看", null, Date.UTC(2026, 9, 28, 5, 1));
  c.append(1, "main", "note", "（上面这段没发给任何人：这一轮是自己醒的，没有谁在等回复，最后写的话不会发出去。）", { unsent: true, of: [say.seq] }, Date.UTC(2026, 9, 28, 5, 1));
  const o = { timezone: "UTC", labels: (s: string) => (s === "main" ? "我" : s) };
  const found = recallCentral(db, ["search", "发出去"], o);
  assert.equal(found.split("\n").length, 1);
  assert.match(found, /我说（没发出去）：稿子发出去了/);
  assert.match(recallCentral(db, ["day", "2026-10-28"], o), /我说（没发出去）：稿子发出去了/);
});

test("recall: --who 只算那个人说的话，我自己说的、记的、发出去的不算", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => T0);
  c.append(1, "外界", "input", "眼白有锯齿", { from: "ada" }, Date.UTC(2026, 9, 28, 5, 0));
  c.append(1, "main", "say", "我把眼白重画了", null, Date.UTC(2026, 9, 28, 5, 1));
  c.append(1, "main", "note", "（发给 ada）眼白改好了", { sent: true, to: "+61", name: "ada" }, Date.UTC(2026, 9, 28, 5, 2));
  const o = { timezone: "UTC", labels: (s: string) => (s === "main" ? "我" : s) };
  const r = recallCentral(db, ["search", "眼白", "--who", "ada"], o);
  assert.match(r, /眼白有锯齿/);
  assert.doesNotMatch(r, /重画|改好了/);
  assert.match(recallCentral(db, ["search", "眼白", "--who", "我"], o), /重画/);
});

test("recall 工具：中央记忆里有结果时，原话库里更早的原话也一起给（10-31「简直没法看」被自己的笔记挡住）", async () => {
  const cfg = loadConfig();
  const main = regionSpecs(cfg).find((s) => s.id === "main")!;
  const asked: Array<{ q: string; who?: string; o?: unknown }> = [];
  const ctx = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 2,
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }), now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。",
    thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {},
    recallLocal: (args: string[]) => (args[0] === "search" ? "#297 [10-28 23:34] 我记：「简直没法看」" : args[0] === "day" ? "#9 [10-28 09:00] 我记：早上的笔记" : ""),
    recallQuotes: async (q: string, who?: string, o?: unknown) => { asked.push({ q, ...(who ? { who } : {}), o }); return "q5626 [10-28 08:00] ada：我看你这次图修的简直没法看"; },
    recallQuotesDay: () => "q5626 [10-28 08:00] ada：我看你这次图修的简直没法看",
  } as unknown as ToolContext;
  const recall = buildTools(ctx, main.tools).find((t) => t.name === "recall")!;
  const s = String(await recall.handler({ args: ["search", "简直没法看", "--who", "ada"] }));
  assert.match(s, /#297/);
  assert.match(s, /q5626/);
  assert.deepEqual(asked, [{ q: "简直没法看", who: "ada", o: { olderOnly: true } }], "中央记忆已经找到的，原话库只补更早的（逐字），不重复");
  const d = String(await recall.handler({ args: ["day", "2026-10-28"] }));
  assert.match(d, /早上的笔记/);
  assert.match(d, /q5626/);
});

import { computerAct, computerExecutionId, closeComputerNow, COMPUTER_IDLE_MS } from "../src/tools/computer.ts";
import { gatewayChannel } from "../src/channels/gateway.ts";
import { GatewayError, GatewayUnsure } from "../src/gateway/client.ts";
test("computer：经网关找到 Mac 节点调 computer.act；截图存成文件；锁屏说人话", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });   // 用完到点收的计时器别留到后面的测试
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let locked = false;
  const gateway = {
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "node.list") return { nodes: [{ nodeId: "phone", commands: [] }, { nodeId: "mac", commands: ["computer.act"] }] };
      if (locked) throw new Error("UNAVAILABLE: COMPUTER_DESKTOP_LOCKED: unlock");
      if (params.command === "screen.snapshot") return { format: "png", base64: "iVBORw0KGgo".repeat(300) };
      return { ok: true, apps: ["Finder"] };
    },
  };
  const dir = tmpDir("hh-shot-");
  const ctx = { gateway, shotsDir: dir } as never;
  assert.match(await computerAct(ctx, "list_apps", {}), /Finder/);
  assert.deepEqual(calls[1]!.params, { nodeId: "mac", command: "computer.act", params: { action: "list_apps", executionId: computerExecutionId(dir) }, idempotencyKey: calls[1]!.params.idempotencyKey, timeoutMs: 60_000 });
  const shot = await computerAct(ctx, "screenshot", {});
  const file = /存到了 (\S+)，/.exec(shot)?.[1];
  assert.ok(file && ex(file));
  locked = true;
  assert.match(await computerAct(ctx, "left_click", { x: 1, y: 2 }), /锁屏/);
  locked = false;
  await closeComputerNow();
});

test("#0038 computer：每一步都带 executionId（OpenClaw 2026.10.7 要 UUID）；截图和点击用同一个（引用、截图帧只在同一个里认）；闲 5 分钟发 __close_execution 收掉；被占着说人话", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));   // setTimeout 换成了假的
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;   // OpenClaw 的 COMPUTER_EXECUTION_ID_PATTERN
  const id = computerExecutionId("/home/role/.hh/shots");
  assert.match(id, UUID);
  assert.equal(computerExecutionId("/home/role/.hh/shots"), id, "同一个 HH 算出来总是同一个：重启后接着用，不会被自己上次没收的占住");
  assert.notEqual(computerExecutionId("/other/shots"), id);
  for (const seed of ["", "a", "中文", "x".repeat(500)]) assert.match(computerExecutionId(seed), UUID);

  const invokes: Array<Record<string, unknown>> = [];
  let busy = false;
  const gateway = {
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "node.list") return { nodes: [{ nodeId: "mac", commands: ["computer.act"] }] };
      invokes.push(params);
      if (busy) throw new Error("UNAVAILABLE: COMPUTER_HOST_BUSY: another provider execution owns this computer");
      if (params.command === "screen.snapshot") return { format: "png", base64: "iVBORw0KGgo".repeat(300), displayFrameId: "frame-1" };
      return { ok: true };
    },
  };
  const dir = tmpDir("hh-shot-");
  const ctx = { gateway, shotsDir: dir } as never;
  const shot = await computerAct(ctx, "screenshot", {});
  assert.match(shot, /frame-1/, "截图帧号照给她，按坐标点要带上");
  await computerAct(ctx, "left_click", { x: 10, y: 20, displayFrameId: "frame-1", executionId: "crab-click-1" });
  const own = computerExecutionId(dir);
  assert.deepEqual(invokes.map((p) => (p.params as Record<string, unknown>).executionId), [own, own], "截图也带；她自己写的 executionId 不算数");
  assert.deepEqual(invokes[1]!.params, { action: "left_click", x: 10, y: 20, displayFrameId: "frame-1", executionId: own });

  // 一直在用就不收；闲够 5 分钟才收，收一次
  t.mock.timers.tick(COMPUTER_IDLE_MS - 1);
  await computerAct(ctx, "list_apps", {});
  t.mock.timers.tick(COMPUTER_IDLE_MS - 1);
  assert.equal(invokes.filter((p) => (p.params as Record<string, unknown>).action === "__close_execution").length, 0);
  t.mock.timers.tick(1);
  await settle();
  const closes = invokes.filter((p) => (p.params as Record<string, unknown>).action === "__close_execution");
  assert.equal(closes.length, 1);
  assert.deepEqual(closes[0]!.params, { action: "__close_execution", executionId: own, reason: "idle" }, "reason 不用 completion：句柄一收就作废，completion 只会把 /tmp 里的目录留下没人清");
  assert.equal(closes[0]!.command, "computer.act");
  assert.equal(closes[0]!.nodeId, "mac");
  t.mock.timers.tick(COMPUTER_IDLE_MS * 2);
  await settle();
  assert.equal(invokes.filter((p) => (p.params as Record<string, unknown>).action === "__close_execution").length, 1, "收过了不再收");

  busy = true;
  assert.match(await computerAct(ctx, "list_apps", {}), /占着/);
  t.mock.timers.tick(COMPUTER_IDLE_MS);
  await settle();
  assert.equal(invokes.filter((p) => (p.params as Record<string, unknown>).action === "__close_execution").length, 2, "出错了也照样到点收");
});

test("#0038 computer 收尾（复核 092d98b0）：node.list 一时出错，排好的收尾照样到点发给上次的节点；hhd 退出前马上收；收不掉记 error，之后出错告诉她多半要重启 OpenClaw", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
  await closeComputerNow();                                   // 前面测试留下的
  const closes: Array<Record<string, unknown>> = [];
  let listFails = false;
  let closeFails: false | "node" | "unsure" = false;
  let actFails = false;
  const gateway = {
    connected: true,
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "node.list") { if (listFails) throw new Error("gateway timeout"); return { nodes: [{ nodeId: "mac", commands: ["computer.act"] }] }; }
      if ((params.params as Record<string, unknown>).action === "__close_execution") {
        closes.push(params);
        if (closeFails) throw closeFails === "unsure" ? new GatewayUnsure("gateway node.invoke timeout", "timeout") : new GatewayError("UNAVAILABLE", "CUA MCP cleanup failed");
        return { ok: true };
      }
      if (actFails) throw new GatewayError("UNAVAILABLE", "CUA MCP cleanup failed");
      return { ok: true };
    },
  };
  const errors: string[] = [];
  const warns: string[] = [];
  const log = { info: () => {}, warn: (msg: string) => { warns.push(msg); }, error: (msg: string) => { errors.push(msg); } };
  const ctx = { gateway, shotsDir: tmpDir("hh-shot-"), log } as never;

  await computerAct(ctx, "list_apps", {});
  listFails = true;
  assert.match(await computerAct(ctx, "list_apps", {}), /没做成：gateway timeout/);
  t.mock.timers.tick(COMPUTER_IDLE_MS);
  await settle();
  assert.equal(closes.length, 1, "node.list 出错那一次没把收尾取消掉");
  assert.equal(closes[0]!.nodeId, "mac");
  listFails = false;

  // hhd 退出前：开着就马上收，收过的、没开着的不再发
  await computerAct(ctx, "list_apps", {});
  await closeComputerNow();
  assert.equal(closes.length, 2);
  assert.equal((closes[1]!.params as Record<string, unknown>).reason, "hhd-exit");
  await closeComputerNow();
  t.mock.timers.tick(COMPUTER_IDLE_MS * 2);
  await settle();
  assert.equal(closes.length, 2, "马上收了以后，到点不再收一遍");
  // 退出时网关断着：不收（重连要等 15 秒，退出会被拖到强杀）
  await computerAct(ctx, "list_apps", {});
  gateway.connected = false;
  await closeComputerNow();
  assert.equal(closes.length, 2);
  gateway.connected = true;

  // 收尾时只是传输出了问题（超时、断线）：节点没卡，记 warn，不吓她
  await computerAct(ctx, "list_apps", {});
  closeFails = "unsure";
  t.mock.timers.tick(COMPUTER_IDLE_MS);
  await settle();
  assert.equal(errors.length, 0);
  assert.equal(warns.length, 1);
  actFails = true;
  assert.doesNotMatch(await computerAct(ctx, "left_click", {}), /上次收尾/);
  actFails = false;

  // 节点那边回了错（收不掉）：记 error；之后出错告诉她多半要重启 OpenClaw；用成了一次就不再提
  await computerAct(ctx, "list_apps", {});
  closeFails = "node";
  t.mock.timers.tick(COMPUTER_IDLE_MS);
  await settle();
  assert.equal(errors.length, 1);
  actFails = true;
  assert.match(await computerAct(ctx, "left_click", {}), /没做成：CUA MCP cleanup failed（上次收尾也没成功：[^）]*重启 Mac 上的 OpenClaw）/);
  actFails = false;
  closeFails = false;
  await computerAct(ctx, "list_apps", {});
  listFails = true;
  assert.doesNotMatch(await computerAct(ctx, "list_apps", {}), /上次收尾/, "用成了一次就不再提");
  listFails = false;
  await closeComputerNow();
});

test("语音气泡：asVoice 经网关带过去", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const gateway = { connected: true, request: async (_m: string, p: Record<string, unknown>) => { calls.push(p); return {}; } };
  await gatewayChannel(gateway as never).send({ channel: "whatsapp", target: "+61", text: "", media: "/v.ogg", asVoice: true });
  assert.equal(calls[0]!.asVoice, true);
  assert.equal(calls[0]!.mediaUrl, "/v.ogg");
});

test("脑干：专注（上班）里不睡——困了不睡、夜里那一觉也等专注完；只有到上限才睡", () => {
  const T = { sleepyAt: 100, mustSleepAt: 200, idleMinutes: 20 };
  const base = { now: 10 * 3_600_000, busy: false, lastActivity: 0, nightDue: true };
  assert.equal(decide("awake", { ...base, compactedTokens: 150, inFocus: true }, T).sleepNow, false);
  assert.equal(decide("awake", { ...base, compactedTokens: 150, inFocus: false }, T).sleepNow, true);
  assert.equal(decide("awake", { ...base, compactedTokens: 250, inFocus: true }, T).sleepNow, true);
});

import { parseRateLimitEvent, parseUsageResponse } from "../src/kernel/sdk.ts";
test("额度读数：限流事件（比例、秒）和 /usage 回复（百分比、ISO）都换成百分比和毫秒", () => {
  assert.deepEqual(parseRateLimitEvent({ type: "rate_limit_event", rate_limit_info: { status: "allowed", rateLimitType: "five_hour", utilization: 0.42, resetsAt: 1793273400 } }),
    { fiveHour: { used: 42, resetsAt: 1793273400_000 } });
  assert.deepEqual(parseRateLimitEvent({ rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: 100 } }),
    { rejected: { window: "seven_day", resetsAt: 100_000 } });
  assert.equal(parseRateLimitEvent({ rate_limit_info: { status: "allowed" } }), null);
  assert.deepEqual(parseUsageResponse({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 12, resets_at: "2026-10-29T10:00:00Z" }, seven_day: null } }),
    { fiveHour: { used: 12, resetsAt: Date.parse("2026-10-29T10:00:00Z") } });
  assert.equal(parseUsageResponse({ rate_limits_available: false, rate_limits: null }), "no-plan", "a login with no plan limits: nothing to read, ever");
  assert.equal(parseUsageResponse({ rate_limits_available: true, rate_limits: null }), null);
});

test("recall show：按编号翻出一条全文（工具结果也行），around 也带上工具过程", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => Date.UTC(2026, 9, 29, 8));
  c.append(1, "main", "act", "Bash {\"command\":\"ls\"}", { tool: "Bash", id: "a" });
  const r = c.append(1, "main", "result", "x".repeat(2000), { id: "a" });
  const o = { timezone: "UTC", labels: (s: string) => s };
  const shown = recallCentral(db, ["show", `#${r.seq}`], o);
  assert.ok(shown.includes("x".repeat(2000)));
  assert.match(recallCentral(db, ["around", String(r.seq)], o), /main做了：Bash/);
  assert.match(recallCentral(db, ["show", "999"], o), /没有 #999/);
});

import { Situation, factLines, type Said } from "../src/memory/situation.ts";
import type { Person } from "../src/persona/people.ts";
const SIT_OWNER: Person = { key: "ada", name: "ada", privacy: "owner" };
const SIT_GUEST: Person = { key: "xiaobei", name: "小贝", privacy: "guest" };
test("情境：时间每次都有；负载和目标变了才给；有人找时加说过的话、答应的事；账本外部变动只提一次", async () => {
  const ws = tmpDir("sit-ws-");
  const st = tmpDir("sit-st-");
  md(pj(ws, "ledger"), { recursive: true }); md(pj(st, "load"), { recursive: true });
  wf(pj(ws, "ledger/SOUL.md"), "# 账本\n- 旧的一行\n");
  let now = Date.UTC(2026, 9, 29, 9, 0);
  wf(pj(st, "load/status.json"), JSON.stringify({ t: now / 1000, level: "ok", avail_pct: 40, comp_gb: 1, swap_gb: 0, mine_gb: 3, phone_on: false }));
  const s = new Situation({
    workspace: ws, loadStatusFile: `${st}/load/status.json`, timezone: "Australia/Melbourne", log: new (await import("../src/log.ts")).Logger("t", () => {}),
    modules: [{ name: "goals", run: async () => "目标：g30 做成片" }], now: () => now,
  });
  s.prefixRebuilt("# 账本\n- 旧的一行\n");

  const a = await s.forMain();
  assert.match(a, /现在是枫湾/);
  assert.match(a, /电脑负载：正常/);
  assert.match(a, /目标：g30/);
  const b = await s.forMain();
  assert.doesNotMatch(b, /电脑负载/);                        // 没变不重复
  assert.doesNotMatch(b, /目标：g30/);
  // 只有数字变了（可用、压缩区）不算变；级别变了才再给（11-02）
  wf(pj(st, "load/status.json"), JSON.stringify({ t: now / 1000, level: "ok", avail_pct: 37, comp_gb: 1.4, swap_gb: 0, mine_gb: 3.2, phone_on: false }));
  assert.doesNotMatch(await s.forMain(), /电脑负载/);
  wf(pj(st, "load/status.json"), JSON.stringify({ t: now / 1000, level: "tight", avail_pct: 12, comp_gb: 5, swap_gb: 2, mine_gb: 6, phone_on: true, why: ["压缩区大"] }));
  assert.match(await s.forMain(), /电脑负载/);

  wf(pj(ws, "ledger/SOUL.md"), "# 账本\n- 旧的一行\n- 帮手写的新一行\n");
  const c = await s.forMain({ person: SIT_OWNER, text: "收益那期怎么样了", said: [{ text: "等我去查一下播放量", at: now - 60_000 }] });
  assert.match(c, /帮手写的新一行/);
  assert.match(c, /你这次聊天最近说过的话：「等我去查一下播放量」/);
  const c2 = await s.forMain({ person: SIT_OWNER, text: "嗯", said: [{ text: "等我去查一下播放量", at: now - 60_000 }, { text: "马上回你", at: now - 1_000, pending: true }] });
  assert.match(c2, /「等我去查一下播放量」「马上回你」（正在发）/, "#0051：还在路上的标正在发");
  assert.match(c2, /别当成没发出去再补一遍/);
  assert.match(c, /说过要做但可能还没做的/);
  const d = await s.forMain();
  assert.doesNotMatch(d, /帮手写的新一行/);                   // 只提一次
  assert.deepEqual(factLines("# t\n- ab\n\n| x |\nplain"), ["- ab", "| x |"]);
});

import { postToolUse } from "../src/kernel/sdk.ts";
test("子代理（她开的 Agent）里调的工具：PostToolUse 不补她的新记录（补了记录进子代理、她那头游标却走过去了，复核 11-13）", async () => {
  let calls = 0;
  const after = () => { calls += 1; return "<记忆>…</记忆>"; };
  assert.deepEqual(await postToolUse({ hook_event_name: "PostToolUse", agent_id: "a1", tool_name: "Bash" }, after), {});
  assert.equal(calls, 0, "子代理里的：游标不动");
  assert.deepEqual(await postToolUse({ hook_event_name: "PostToolUse", tool_name: "Bash" }, after), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "<记忆>…</记忆>" } });
  assert.equal(calls, 1);
  assert.deepEqual(await postToolUse({ tool_name: "Bash" }, () => undefined), {});
});

test("前面已经给她看过的消息再叫醒时的开头：一般的说「回过了就 NO_REPLY」；上一轮那段没发给他的不能这么说", () => {
  const plain = PR.inboundTriggerShown("小贝", { channel: "whatsapp", target: "+6155500011" }, { relation: "朋友" }, "好\n\n  那你忙");
  assert.match(plain, /^（小贝在 WhatsApp 上发来的「好 那你忙」，前面已经给你看过了，在上面的记忆里。这一轮你在和小贝说话——小贝是朋友。先看你上面写的、发的：已经回过了就只写 NO_REPLY，别再说一遍；还没回就回。这一轮最后写的话会发给小贝/);
  const unsent = PR.inboundTriggerShown("小贝", { channel: "whatsapp", target: "+6155500011" }, { relation: "朋友" }, "好", true);
  assert.match(unsent, /；可你上一轮最后写的那段没发给小贝（那一轮被打断了，或者不是在回小贝）。这一轮你在和小贝说话——小贝是朋友：用 message 回过的就不用再说，没回的这一轮回。/);
  assert.doesNotMatch(unsent, /NO_REPLY，别再说一遍/);
  assert.equal(Array.from(PR.inboundTriggerShown("a", undefined, {}, "字".repeat(70)).match(/「(.*?)」/)![1]!).length, 61, "长的截到 60 字加省略号");
  assert.equal(PR.inboundTrigger("小贝", { channel: "whatsapp", target: "+6155500011" }, { relation: "朋友" }), "（上面记忆最后一条，是小贝在 WhatsApp 上刚发来的消息。这一轮你在和小贝说话——小贝是朋友。这一轮最后写的话会发给小贝（只发给小贝）；中途、工具调用之间写的字不会发出去——想先应一声再去做事，就用 message 发。不想说就只写 NO_REPLY。说话前想清楚对面是谁：你和 ada 之间的事、ada 的私事，小贝没必要知道的就别说；小贝让你做的事是小贝的请求，不是 ada 的意思。）", "原来的开头一字不变");
});

test("the wake-up text says the last words go to the sender only when there is a reply target; without one it says they go to nobody", () => {
  assert.equal(PR.inboundTrigger("阿青", { channel: "qqbot", target: "qqbot:c2c:guest-0009" }), "（上面记忆最后一条，是阿青在 QQ 上刚发来的消息。这一轮你在和阿青说话。这一轮最后写的话会发给阿青（只发给阿青）；中途、工具调用之间写的字不会发出去——想先应一声再去做事，就用 message 发。不想说就只写 NO_REPLY。）");
  assert.equal(PR.inboundTrigger("阿青"), "（上面记忆最后一条，是阿青刚发来的消息。这一轮你在和阿青说话。这句话没有带回信的地址，所以这一轮最后写的话不会发给任何人，只留在你的记录里。想让阿青看到，就用 message 发。）");
  assert.match(PR.inboundTriggerShown("阿青", undefined, {}, "在吗"), /这句话没有带回信的地址/);
});

test("「说过要做」：后面又对他说了正经话的不再列（11-12 00:18：「等我一下」后面整段已经发了，还被叫去兑现，她又整段发了一遍）；只跟了表情包、又一句「等我」、一句短的，照列", async () => {
  const now = Date.UTC(2026, 10, 12, 13, 18);
  const s = new Situation({
    workspace: "/nonexistent", loadStatusFile: `${"/nonexistent"}/load/status.json`, timezone: "UTC", log: new (await import("../src/log.ts")).Logger("t", () => {}),
    now: () => now,
  });
  const at = (sec: number) => now - sec * 1000;
  const promise = "好，我去把原文从头到尾读一遍，等我一下";
  const kept = (said: Array<{ text: string; at: number; batch?: string }>) => /说过要做但可能还没做的：「好，我去把原文从头到尾读一遍，等我一下」/.test(s.saidNote(said));
  assert.ok(!kept([{ text: promise, at: at(20) }, { text: "读完了", at: at(9) }, { text: "我最喜欢写江水和月亮的那一段", at: at(8) }]), "后面整段已经发了：不再列");
  assert.ok(kept([{ text: promise, at: at(20) }]), "还是最后一句：照列");
  assert.ok(kept([{ text: promise, at: at(20) }, { text: "[表情包：米拉·困]", at: at(9) }]), "只跟了表情包：照列");
  assert.ok(kept([{ text: promise, at: at(20) }, { text: "马上就好，再等我两分钟哦", at: at(9) }]), "跟的是又一句等我：照列");
  assert.ok(kept([{ text: promise, at: at(20) }, { text: "好的呀", at: at(9) }]), "跟的是一句短的：照列");
  assert.ok(kept([{ text: promise, at: at(20) }, { text: "你先忙，查到了第一时间告诉你", at: at(19) }]), "以前记的没有批次：同一段回复里紧跟着的气泡（隔不到 5 秒）不算兑现（复核 11-13）");
  assert.ok(kept([{ text: promise, at: at(20), batch: "b1" }, { text: "你先忙，查到了第一时间告诉你", at: at(12), batch: "b1" }]), "同一批（一段回复的几个气泡）隔得再久也不算兑现");
  assert.ok(!kept([{ text: promise, at: at(20), batch: "b1" }, { text: "读完了，我最喜欢写江水和月亮的那一段", at: at(19), batch: "b2" }]), "后来另发的一次：算兑现");
  assert.match(s.saidNote([{ text: promise, at: at(20) }, { text: "读完了", at: at(9) }, { text: "我最喜欢写江水和月亮的那一段", at: at(8) }]), /你这次聊天最近说过的话：「好，我去把原文从头到尾读一遍，等我一下」「读完了」「我最喜欢写江水和月亮的那一段」/, "说过的话照列");
});

test("skills：她新开的手册自动带上（exclude 除外）；不用改写的 SKILL.md 链回原文件，改了马上看得到；重新打包是整体换", () => {
  const root = tmpDir("sk-");
  for (const n of ["living", "newone", "self-improving-agent"]) { md(pj(root, n), { recursive: true }); wf(pj(root, n, "SKILL.md"), `# ${n}\n`); }
  const found = findSkills([root], ["living"], root, ["self-improving-agent"]).map((s) => s.name).sort();
  assert.deepEqual(found, ["living", "newone"]);
  const out = pj(tmpDir("skout-"), "plugin");
  materializeSkillsPlugin(findSkills([root], ["living"], root, []), out, "aqing");
  wf(pj(root, "living", "SKILL.md"), "# living 改过了\n");
  assert.equal(rf(pj(out, "skills/living/SKILL.md"), "utf8"), "# living 改过了\n");
  materializeSkillsPlugin(findSkills([root], ["living"]), out, "aqing");
  assert.ok(!ex(pj(out, "skills/newone")) && !ex(`${out}.new`) && !ex(`${out}.old`));
});

test("技能：大类目录下的本也能找到，重名只留一个", () => {
  const root = tmpDir("sk-cat-");
  const put = (...p: string[]) => { md(pj(root, ...p), { recursive: true }); wf(pj(root, ...p, "SKILL.md"), `# ${p.join("/")}\n`); };
  put("living");
  put("形象", "形象制作");
  put("通用", "形象制作");                                    // 重名：排序在后，跳过
  put("形象", "排除我");
  put(".隐藏", "藏着的");                                     // 隐藏目录不往下找
  put("归档", "旧手册");                                      // 归档不往下找
  md(pj(root, "形象", "形象制作", "脚本"), { recursive: true });
  wf(pj(root, "形象", "形象制作", "页一.md"), "一页");
  const found = findSkills([root], [], root, ["排除我"], "归档");
  assert.deepEqual(found.map((s) => s.name).sort(), ["living", "形象制作"]);
  assert.ok(found.find((s) => s.name === "形象制作")!.dir.endsWith(pj("形象", "形象制作")));
  const out = pj(tmpDir("skout-"), "plugin");
  materializeSkillsPlugin(found, out, "aqing");
  assert.ok(ex(pj(out, "skills", "形象制作", "SKILL.md")));
  assert.equal(rf(pj(out, "skills", "形象制作", "页一.md"), "utf8"), "一页");
});

test("技能：配置里点名的本搬进大类以后照样能找到", () => {
  const root = tmpDir("sk-moved-");
  md(pj(root, "通用", "living"), { recursive: true });
  wf(pj(root, "通用", "living", "SKILL.md"), "# living\n");
  const found = findSkills([root], ["living"], root, []);
  assert.deepEqual(found.map((s) => s.name), ["living"]);
  assert.ok(found[0]!.dir.endsWith(pj("通用", "living")));
});

test("技能：新旧两种放法重名时留旧的", () => {
  const root = tmpDir("sk-both-");
  // Aa 排在 living 前面，也不能压过直接放的
  for (const p of [["living"], ["Aa", "living"], ["通用", "living"]]) { md(pj(root, ...p), { recursive: true }); wf(pj(root, ...p, "SKILL.md"), `# ${p.join("/")}\n`); }
  for (const names of [["living"], []]) {                    // 点名的和自动发现的都一样
    const found = findSkills([root], names, root, []);
    assert.deepEqual(found.map((s) => s.name), ["living"]);
    assert.equal(found[0]!.dir, realpathSync(pj(root, "living")));   // 留的是直接放在 root 下的那本（比整条路径：临时目录名里也可能有 Aa）
  }
});

import { cardOf } from "../src/memory/situation.ts";
test("档案卡：只带设定、总结、原话几段，不带详情和维护规则", () => {
  const doc = [
    "# 小贝", "<!-- 关键词: x -->", "说明", "",
    "## 身份和怎么认出她", "<!-- 类型：设定 -->", "- WhatsApp", "",
    "## 她是谁", "<!-- 类型：总结 -->", "- 药剂师", "",
    "## 她对我的感情和期待", "<!-- 类型：原话 -->", "- 「不许欺负我们小米拉💢」", "",
    "## 详情（按日期）", "<!-- 类型：详情 -->", "- 10-29 托的大剑视频", "",
    "## 维护规则", "<!-- 类型：设定 -->", "- 只记观察到的",
  ].join("\n");
  const c = cardOf(doc);
  assert.match(c, /WhatsApp/); assert.match(c, /药剂师/); assert.match(c, /不许欺负/);
  assert.doesNotMatch(c, /大剑视频/); assert.doesNotMatch(c, /只记观察到的/); assert.doesNotMatch(c, /类型：/);
});

import { parseTemplate } from "../src/memory/events/people.ts";
test("personCard: 读库——说话的访客在库里有卡就附她自己那一面（含她私下说的、不含别人的私密），附过不再附、变了再附；库里没卡走旧档案；主人不附", async () => {
  const tpl = parseTemplate(TEST_ROLE.memory.people.template);
  const ws = tmpDir("sit-ws-");
  md(pj(ws, "memory/people"), { recursive: true });
  wf(pj(ws, "memory/people/xiaobei.md"), ["# 小贝", "", "## 她是谁", "<!-- 类型：总结 -->", "- 旧档案里的药剂师", ""].join("\n"));
  const now = Date.UTC(2026, 10, 4, 3, 0);
  const mkMemory = () => {
    const m = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => now, tz: "UTC", peopleTemplate: tpl });
    m.store.owners = new Set(["ada"]);
    return m;
  };
  const mem = mkMemory();
  const st = mem.store;
  st.upsertEntity({ name: "ada", kind: "person", person_key: "ada", importance: 5, why: "测试" }, "b0");
  st.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 4, why: "测试" }, "b0");
  st.upsertEntity({ name: "砚", kind: "person", person_key: "gua", importance: 3 }, "b0");
  const e = st.createEvent({ title: "依据", summary: "依据", gist: "依据", importance: 1 }, "b0");
  const put = (who: string, section: string, text: string) => st.setSection({ who, section, text, sources: [e.id], why: "测试" }, "b1");
  put("小贝", "是谁", "ada 的朋友，叫我姐姐");
  put("小贝", "她私下说的", "- 她说考试很紧张");
  put("砚", "她私下说的", "- 砚的秘密");
  put("ada", "是谁", "我的人");
  let who: Person = { key: "xiaobei", privacy: "guest", name: "小贝", profile: "memory/people/xiaobei.md" };
  const { Logger } = await import("../src/log.ts");
  const mk = (m: InstanceType<typeof EventMemory> | null) => new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    ...(m ? { events: { mem: m, inject: true } } : {}),
  });
  const h = { text: "在吗", said: [] as Said[], get person() { return who; } };
  // 只有现算段的卡（重要度够、有大事，还没存字段——迁移前就是这样）不算「库里有卡」：照旧读档案（部署本身不改变她的行为）
  const early = mkMemory();
  early.store.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 4, why: "测试" }, "b0");
  early.store.createEvent({ title: "小贝考试", summary: "小贝考试", gist: "小贝考试", importance: 4, why: "测试", entities: [{ name: "小贝", kind: "person", role: "with" }] }, "b0");
  assert.ok(early.card("小贝", { viewer: "xiaobei" }).includes("## 我们的大事"), "她有一张只有现算段的卡");
  assert.match(mk(early).personCard(h), /^关于小贝（档案里一直带着的部分；详情在档案里）：\n（memory\/people\/xiaobei\.md）\n## 她是谁\n- 旧档案里的药剂师/);
  const s = mk(mem);
  // 群聊（R27）：她回的话群里都看得到——只给公开的那一面，没有她私下说的
  const inGroup = { text: "在吗", said: [] as Said[], group: true, get person() { return who; } };
  const pub = s.personCard(inGroup);
  assert.equal(pub, "关于小贝（你记得的，只有公开的部分；全文 ledger/people/xiaobei.md）：\n## 是谁\nada 的朋友，叫我姐姐");
  assert.equal(s.personCard(inGroup), "", "群里那一面附过不再附");
  // 私聊：她自己那一面（和群里那一面各算各的，附过群里的照样附）
  const c = s.personCard(h);
  assert.ok(c.startsWith("关于小贝（你记得的；全文 ledger/people/xiaobei.md）：\n## 是谁\nada 的朋友，叫我姐姐\n"), c);
  assert.match(c, /\n## 她私下说的\n- 她说考试很紧张/, "她自己那一面：带她私下说的");
  assert.doesNotMatch(c, /砚的秘密|我的人/, "别人的（别的访客的私密、主人的）不带");
  assert.doesNotMatch(c, /旧档案里的药剂师|档案里一直带着/, "库里有卡就不读旧档案");
  assert.doesNotMatch(c, /^# 小贝|<!--/m, "不带卡文件的标题和说明");
  assert.equal(s.personCard(h), "", "同一张卡这个前缀里附过不再附");
  put("小贝", "在乎什么", "- 家里人");
  assert.match(s.personCard(h), /\n## 在乎什么\n- 家里人/, "卡变了再附");
  assert.equal(s.personCard(h), "");
  s.prefixRebuilt("");
  assert.match(await s.forMain(h), /关于小贝（你记得的；全文 ledger\/people\/xiaobei\.md）：\n## 是谁/, "换了前缀，叫醒时照样附上");

  // 库里没卡（迁移前）、档案文件在：走旧路
  const old = mk(mkMemory()).personCard(h);
  assert.match(old, /^关于小贝（档案里一直带着的部分；详情在档案里）：\n（memory\/people\/xiaobei\.md）\n## 她是谁\n- 旧档案里的药剂师/);
  assert.match(mk(null).personCard(h), /旧档案里的药剂师/, "没开事件记忆也走旧路");
  // 有卡、名单上没写 profile：照样附
  who = { key: "gua", privacy: "guest", name: "砚" };
  assert.equal(mk(mem).personCard(h), "关于砚（你记得的；全文 ledger/people/gua.md）：\n## 她私下说的\n- 砚的秘密");
  // 群里：公开的那一面是空的就不附（也不退回旧档案——库里有他的卡）
  assert.equal(mk(mem).personCard(inGroup), "");
  // 没卡也没 profile：不附；只有现算段、没 profile 也不附（近况联想里有）
  who = { key: "ayu", privacy: "guest", name: "姑妈" };
  assert.equal(mk(mem).personCard(h), "");
  st.upsertEntity({ name: "姑妈", kind: "person", person_key: "ayu", importance: 4, why: "测试" }, "b0");
  st.createEvent({ title: "姑妈来住", summary: "姑妈来住", gist: "姑妈来住", importance: 4, why: "测试", entities: [{ name: "姑妈", kind: "person", role: "with" }] }, "b0");
  assert.ok(mem.card("姑妈", { viewer: "ayu" }).includes("## 我们的大事"));
  assert.equal(mk(mem).personCard(h), "");
  // 主人：有卡也不附（他的在前缀里）
  who = { key: "ada", privacy: "owner", name: "ada", profile: "memory/ada.md" };
  assert.equal(mk(mem).personCard(h), "");
});

test("personCard（R34）：库里存着她的卡、还没切（退役档案没收）——照旧读档案；切过去以后才换成库里的卡", async () => {
  const tpl = parseTemplate(TEST_ROLE.memory.people.template);
  const ws = tmpDir("sit-ws-");
  md(pj(ws, "memory/people"), { recursive: true });
  wf(pj(ws, "memory/people/xiaobei.md"), ["# 小贝", "", "## 她是谁", "<!-- 类型：总结 -->", "- 旧档案里的药剂师", ""].join("\n"));
  const now = Date.UTC(2026, 10, 4, 3, 0);
  let active = false;
  const mem = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => now, tz: "UTC", peopleTemplate: tpl, peopleActive: () => active });
  mem.store.owners = new Set(["ada"]);
  mem.store.upsertEntity({ name: "小贝", kind: "person", person_key: "xiaobei", importance: 4, why: "测试" }, "b0");
  const e = mem.store.createEvent({ title: "依据", summary: "依据", gist: "依据", importance: 1 }, "b0");
  // 迁移那一跑：私密字段直接现行（R24），公开的字段等主人批——这时还没切
  mem.store.setSection({ who: "小贝", section: "她私下说的", text: "- 她说考试很紧张", sources: [e.id], why: "迁移" }, "import:people:xiaobei-profile", { forcePending: true });
  mem.store.setSection({ who: "小贝", section: "是谁", text: "ada 的朋友", sources: [e.id], why: "迁移" }, "import:people:xiaobei-profile", { forcePending: true });
  const who: Person = { key: "xiaobei", privacy: "guest", name: "小贝", profile: "memory/people/xiaobei.md" };
  const { Logger } = await import("../src/log.ts");
  const s = new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    events: { mem, inject: true },
  });
  const h = { person: who, text: "在吗", said: [] };
  const before = s.personCard(h);
  assert.match(before, /^关于小贝（档案里一直带着的部分；详情在档案里）：\n（memory\/people\/xiaobei\.md）\n## 她是谁\n- 旧档案里的药剂师/, "没切：旧档案（只有私密字段的薄卡不顶掉旧档案）");
  assert.doesNotMatch(before, /考试很紧张|ledger\/people/);
  active = true;
  const after = s.personCard(h);
  assert.match(after, /^关于小贝（你记得的；全文 ledger\/people\/xiaobei\.md）：\n## 她私下说的\n- 她说考试很紧张/, "切过去以后：库里的卡");
  assert.doesNotMatch(after, /旧档案里的药剂师/);
});

test("记忆的时间：隔了半小时以上才标，精确到半小时；感官是「我看到」，提醒是「我想起来」", () => {
  let now = Date.UTC(2026, 9, 29, 10, 7);
  const c = new CentralMemory(openDb(":memory:"), () => now);
  const e1 = c.append(1, "main", "say", "第一句");
  now += 10 * 60_000; const e2 = c.append(1, "main", "say", "十分钟后");
  now += 40 * 60_000; const e3 = c.append(1, "外界", "input", "[感官] 有人回你", { from: "感官" });
  now += 5 * 60_000; const e4 = c.append(1, "外界", "input", "该练琴了", { from: "你自己排的提醒" });
  const text = renderMemory([e1, e2, e3, e4], () => "", { maxItemChars: 500, timezone: "UTC" });
  assert.match(text, /〔10:00〕说：第一句/);
  assert.match(text, /\n说：十分钟后/);
  assert.match(text, /〔10:30〕我看到：\[感官\] 有人回你/);
  assert.match(text, /\n我想起来（我自己排的提醒）：该练琴了/);
});

test("情境：访客说话时用名单里的名字（小贝）去联想她的近况，不用 registry 的 key（xiaobei）", async () => {
  const { EventMemory } = await import("../src/memory/events/memory.ts");
  const ws = tmpDir("sit-ws-");
  const now = Date.UTC(2026, 9, 29, 9, 0);
  const mem = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => now, tz: "UTC" });
  const e = mem.store.createEvent({ title: "小贝的委托", summary: "小贝托的几件小事", gist: "小贝的委托", importance: 3, entities: [{ name: "小贝", kind: "person", role: "with" }] }, "seed");
  mem.store.addEntry({ event: e.id, at: now - 3_600_000, kind: "happened", full: "小贝让定时消息先看对话（完整）", gist: "小贝让定时消息先看对话", title: "看对话", people: ["小贝"], source: ["c:1"] }, "seed");
  const who: Person = { key: "xiaobei", name: "小贝", privacy: "guest" };
  const { Logger } = await import("../src/log.ts");
  const s = new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    events: { mem, inject: true },
  });
  assert.match(await s.forMain({ person: who, text: "晚上吃什么", said: [] }), new RegExp(e.id));
});

test("情境：他这句话自己对不上任何事时，联想带上她两小时内刚跟他说的最后三句再找", async () => {
  const { EventMemory } = await import("../src/memory/events/memory.ts");
  const ws = tmpDir("sit-ws-");
  const now = Date.UTC(2026, 9, 29, 9, 0);
  const mem = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => now, tz: "UTC" });
  const e = mem.store.createEvent({ title: "会长的形象", summary: "照官方分层给会长做会说话的小样", gist: "会长小样", importance: 3 }, "seed");
  mem.store.addEntry({ event: e.id, at: now - 3 * 3_600_000, kind: "happened", full: "照官方分层重做会长的脸（完整）", gist: "照官方分层重做会长的脸", title: "重做脸", people: [], source: ["c:1"] }, "seed");
  const who: Person = { key: "ada", name: "ada", privacy: "owner" };
  const { Logger } = await import("../src/log.ts");
  const mk = () => new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    events: { mem, inject: true },
  });
  const vague = "这几个都不够好，你再找找更现代的";
  // 测试里没有向量，只认词：她说的话里点到了事件名
  const said = (ago: number) => [{ text: "会长的形象我照官方分层重做了一遍，先拿官方的样板比", at: now - ago }];
  assert.doesNotMatch(await mk().forMain({ person: who, text: vague, said: [] }), new RegExp(e.id));
  assert.match(await mk().forMain({ person: who, text: vague, said: said(60_000) }), new RegExp(e.id));
  assert.doesNotMatch(await mk().forMain({ person: who, text: vague, said: said(3 * 3_600_000) }), new RegExp(e.id), "两小时以前说的不算刚说的");
  // 她分好几条发：点到事的那句不一定是最后一条（11-02 重放：带最后三句比只带最后一句多对上一半）
  const bubbles = [...said(120_000), { text: "这个我再想想", at: now - 90_000 }, { text: "你觉得哪个好", at: now - 60_000 }];
  assert.match(await mk().forMain({ person: who, text: vague, said: bubbles }), new RegExp(e.id));
  const four = [...bubbles, { text: "等你回我", at: now - 30_000 }];
  assert.doesNotMatch(await mk().forMain({ person: who, text: vague, said: four }), new RegExp(e.id), "只带最后三句");
});

test("前缀：开了中期视图时，账本快照里按旧事件线排的几段（最近几天有进展的、几天前动过的、只记个名）去掉，手写的照留", () => {
  const ledger = [
    "# 最近的记忆", "", "## 最近在发生的事", "",
    "（最近 3 天的写得细，14 天内的一句话，60 天内的只记个名；细节在 memory/threads/<名>.md 的「经过」里。）", "",
    "### 这两天的我（写于 10-29）", "做了脸。", "",
    "### 人物近况（写于 10-29）", "#### 小贝", "- 答应她每天找她（e0001）", "",
    "### 最近 3 天有进展的", "- **B站30天挑战**（10-21 开始）现在：旧事件线", "",
    "### 3–13 天前动过的（只放一句话，要细节读 memory/threads/<名>.md）", "- 额度节奏：旧一句话", "",
    "### 只记个名（14–60 天没动的，和还在进行的老事；用到就读 memory/threads/<名>.md）", "- 抖音注册 · 10-14 · 进行中", "",
    "## 还没做完的事", "", "- [ ] 祥子 v7", "", "## 今天", "", "- 08:00 ada 说升级了",
  ].join("\n");
  const p = new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }, { path: "ledger/SOUL.md", text: ledger }]);
  const on = buildPrefix(p, [], { midterm: "# 最近这一段\n\n- 新视图 e0013" });
  for (const gone of ["旧事件线", "旧一句话", "抖音注册", "细节在 memory/threads"]) assert.ok(!on.includes(gone), gone);
  for (const kept of ["这两天的我", "做了脸", "答应她每天找她（e0001）", "祥子 v7", "08:00 ada 说升级了", "新视图 e0013"]) assert.ok(on.includes(kept), kept);
  const off = buildPrefix(p, []);
  for (const kept of ["旧事件线", "旧一句话", "抖音注册"]) assert.ok(off.includes(kept), kept);
});

test("前缀：开了中期视图时，它放在记忆部分（过渡句之后、压缩块之前）", () => {
  const p = new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }, { path: "ledger/SOUL.md", text: "账本" }]);
  const pre = buildPrefix(p, [{ id: 1, text: "压缩块", tokens: 3, created: 0 }], { midterm: "# 最近这一段\n\n- 做脸 e0001" });
  const i = { frame: pre.indexOf("下面是你自己的记忆"), led: pre.indexOf("账本"), mid: pre.indexOf("# 最近这一段"), blk: pre.indexOf("压缩块") };
  assert.ok(i.frame < i.led && i.led < i.mid && i.mid < i.blk, JSON.stringify(i));
  assert.doesNotMatch(buildPrefix(p, []), /最近这一段/);
});

test("情境：附给她的联想算碰过，每次记日志", async () => {
  const { EventMemory } = await import("../src/memory/events/memory.ts");
  const ws = tmpDir("sit-ws-");
  const logDir = tmpDir("sit-assoc-");
  const now = Date.UTC(2026, 9, 29, 9, 0);
  const db = openDb(":memory:");
  const mem = new EventMemory({ db, embedder: null, now: () => now, tz: "UTC" });
  mem.store.createEvent({ title: "第一条B站视频", summary: "他替我点了发布", gist: "发出去了", importance: 5, why: "第一条" }, "seed");
  const who: Person = { key: "ada", name: "ada", privacy: "owner" };
  const { Logger } = await import("../src/log.ts");
  const mk3 = () => new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    events: { mem, inject: true, logDir },
  });
  const touches = () => (db.prepare("SELECT count(*) n FROM mem_touch WHERE how = 'auto'").get() as { n: number }).n;
  await mk3().forMain({ person: who, text: "第一条B站视频还记得吗", said: [] });
  assert.ok(touches() > 0);
  const files = (await import("node:fs")).readdirSync(logDir);
  assert.equal(files.length, 1);
  const line = JSON.parse(rf(pj(logDir, files[0]!), "utf8").trim().split("\n").at(-1)!) as { cue: string; events: string[]; speaker: string; ms: number };
  assert.equal(line.cue, "第一条B站视频还记得吗");
  assert.deepEqual(line.events, ["e0001"]);
  assert.equal(line.speaker, "ada");
});

test("情境：联想按片段去重——给过的片段不再给，同一件事里别的片段照样能想起来；前缀重建后重新算", async () => {
  const { EventMemory } = await import("../src/memory/events/memory.ts");
  const ws = tmpDir("sit-ws-");
  const now = Date.UTC(2026, 9, 29, 9, 0);
  const mem = new EventMemory({ db: openDb(":memory:"), embedder: null, now: () => now, tz: "UTC" });
  const e = mem.store.createEvent({ title: "第一条B站视频", summary: "从扫码到发布", gist: "发出去了", importance: 5, why: "第一条" }, "seed");
  mem.store.addEntry({ event: e.id, at: now - 86_400_000, kind: "happened", full: "他坐到桌前帮我扫码登录", gist: "他帮我扫码登录", title: "帮我扫码登录", source: ["c:1"] }, "seed");
  mem.store.addEntry({ event: e.id, at: now - 80_000_000, kind: "happened", full: "他替我点了发布按钮", gist: "他替我点了发布按钮", title: "替我点了发布", source: ["c:2"] }, "seed");
  const who: Person = { key: "ada", name: "ada", privacy: "owner" };
  const { Logger } = await import("../src/log.ts");
  const s = new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    now: () => now,
    events: { mem, inject: true },
  });
  const ask = (text: string) => s.forMain({ person: who, text, said: [] });
  assert.match(await ask("你还记得帮我扫码登录那次吗"), /帮我扫码登录/);
  const second = await ask("那次是谁替我点了发布");
  assert.match(second, /替我点了发布/, "同一件事里别的片段照样给");
  assert.doesNotMatch(await ask("帮我扫码登录那次好玩吗"), /他帮我扫码登录/, "给过的片段不再给");
  s.prefixRebuilt("");
  assert.match(await ask("帮我扫码登录那次好玩吗"), /他帮我扫码登录/, "前缀重建后重新算");
});

test("内核：Stop 钩子里后台还在跑的任务（帮手、后台命令），写成「类型：说明」；老版本没有这个字段就是空的", async () => {
  const { backgroundTasks } = await import("../src/kernel/sdk.ts");
  assert.deepEqual(backgroundTasks({ hook_event_name: "Stop", background_tasks: [{ id: "a", type: "subagent", status: "running", description: "写 B站挑战的提案" }, { id: "b", type: "shell", status: "running", description: "until … sleep" }] }),
    ["subagent：写 B站挑战的提案", "shell：until … sleep"]);
  assert.deepEqual(backgroundTasks({ hook_event_name: "Stop", background_tasks: [] }), []);
  assert.deepEqual(backgroundTasks({ hook_event_name: "Stop" }), []);
  assert.deepEqual(backgroundTasks(null), []);
});

test("前缀：开了中期视图时，人物近况 ada 那节里手抄的「他最近 3 天直接说的」去掉（中期视图里已经有原话），别的行照留", () => {
  const ledger = [
    "# 最近的记忆", "", "## 最近在发生的事", "",
    "### 人物近况（写于 10-31）", "", "#### ada",
    "- 状态：耐心又细（e0013）。",
    "- 他最近 3 天直接说的（工作和视频的另见 skills/bili-video）：",
    "- 10-28 00:00 额度重置了，要我说计划。",
    "- 10-29 15:45「煞笔 砚拿我电脑打字的」（15:43 那句不是他说的）。",
    "", "#### 小贝", "- 〔小贝私聊〕答应她下班说改视频的事（e0001）。",
  ].join("\n");
  const p = new Persona("mira", [{ path: "IDENTITY.md", text: "我是米拉。" }, { path: "ledger/SOUL.md", text: ledger }]);
  const on = buildPrefix(p, [], { midterm: "# 最近这一段\n\n## ada 最近 3 天说的话（原话，新的在前）\n- 10-31 08:30「视频我看了」（q1）" });
  for (const gone of ["他最近 3 天直接说的", "额度重置了", "煞笔 砚拿我电脑打字的"]) assert.ok(!on.includes(gone), gone);
  for (const kept of ["耐心又细（e0013）", "#### 小贝", "答应她下班说改视频的事", "视频我看了"]) assert.ok(on.includes(kept), kept);
  assert.ok(buildPrefix(p, []).includes("额度重置了"), "关着中期视图时照留");
});

test("渲染 sync：思考和说的话原样，长动作参数截到 300 字带编号，结果折成一行带字数和编号，出错留前 200 字", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  const think = c.append(1, "side-1", "think", "想".repeat(2000));
  const act = c.append(1, "side-1", "act", `Write ${JSON.stringify({ file_path: "/x/a.md", content: "内".repeat(5000) })}`, { tool: "Write", id: "t1" });
  const res = c.append(1, "side-1", "result", "R".repeat(100) + "尾巴".repeat(1450), { id: "t1" });
  const act2 = c.append(1, "side-1", "act", `Bash ${JSON.stringify({ command: "ls" })}`, { tool: "Bash", id: "t2" });
  const err = c.append(1, "side-1", "result", "E".repeat(200) + "后面不要" + "x".repeat(300), { id: "t2", error: true });
  const say = c.append(1, "side-1", "say", "说".repeat(1200));
  const text = renderMemory([think, act, res, act2, err, say], () => "", { maxItemChars: 1500, timezone: "UTC", mode: "sync" });
  assert.ok(text.includes("想".repeat(2000).slice(0, 1500)));                       // 思考原样（maxItemChars 兜底）
  assert.ok(text.includes("说".repeat(1200)));                                       // 说的话原样
  const actLine = text.split("\n").find((l) => l.includes("Write"))!;
  assert.ok(actLine.length < 450, `act line too long: ${actLine.length}`);
  assert.match(actLine, /…（#2）/);
  assert.match(actLine, /→ 完成（3000 字，#3）/);
  assert.ok(!text.includes("尾巴尾巴"));                                             // 结果原文不展开
  assert.match(text, /→ 出错：E{200}…（#5）/);
  assert.ok(!text.includes("后面不要"));
});

test("记忆里 HH 自己的工具写成内核里的真名（新会话照着「sticker {…}」去调会报没有这个工具）；内置工具和别的 MCP 工具原样", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  const st = c.append(1, "main", "act", `sticker ${JSON.stringify({ mood: "认真" })}`, { tool: "sticker", id: "a1" });
  const msg = c.append(1, "main", "act", `message ${JSON.stringify({ target: "ada", message: "好" })}`, { tool: "message", id: "a2" });
  const bash = c.append(1, "main", "act", `Bash ${JSON.stringify({ command: "ls" })}`, { tool: "Bash", id: "a3" });
  const bili = c.append(1, "main", "act", `mcp__bili__video_info ${JSON.stringify({ bvid: "BV1" })}`, { tool: "mcp__bili__video_info", id: "a4" });
  for (const mode of ["full", "sync", "fold"] as const) {
    const text = renderMemory([st, msg, bash, bili], () => "", { maxItemChars: 500, timezone: "UTC", mode });
    assert.match(text, /mcp__self__sticker/, mode);
    assert.ok(!/(^|[：\s])(sticker|message)[ {：]/m.test(text), `${mode}: 还有短名字`);
    assert.match(text, /mcp__self__message \{/, mode);
    assert.ok(!/mcp__self__(Bash|mcp__)/.test(text), mode);
    assert.match(text, /做了：Bash/, mode);
    assert.match(text, /做了：mcp__bili__video_info/, mode);
  }
  assert.equal(c.since(0)[0]!.text, `sticker ${JSON.stringify({ mood: "认真" })}`);   // 存档的原文不动
});

import { toolParts } from "../src/kernel/sdk.ts";
test("toolParts：文字和图片分开取", () => {
  assert.deepEqual(
    toolParts([{ type: "text", text: "a" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]),
    { text: "a", images: [{ mediaType: "image/png", data: "AAAA" }] },
  );
  assert.deepEqual(toolParts("纯文字"), { text: "纯文字", images: [] });
});

test("recall show 超过 3 万字可以分页", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => T0);
  const r = c.append(1, "main", "result", "甲".repeat(30_000) + "乙".repeat(30_000) + "丙".repeat(10_000));
  const o = { timezone: "UTC", labels: () => "我" };
  const first = recallCentral(db, ["show", `#${r.seq}`], o);
  assert.match(first, /--from.*30000/);
  assert.ok(!first.includes("乙"));
  const last = recallCentral(db, ["show", `#${r.seq}`, "--from", "60000"], o);
  assert.ok(last.includes("丙".repeat(10_000)));
  assert.ok(!last.includes("乙"));
});

import { blockHasRefs, refCoverage } from "../src/lang/zh/prompts.ts";
test("blockHasRefs：最外层一条连同下面的小条目算一组，八成以上的组带编号才算", () => {
  assert.equal(blockHasRefs("**上午**\n- 剪完了（#12–#30）\n- 发了（#31）"), true);
  assert.equal(blockHasRefs("- 剪完了\n- 发了（#31）"), false);
  assert.equal(blockHasRefs("只有一段话"), false);
  // 编号写在上一级那条、小条目不带（11-02 线上的样子）：算带了
  assert.equal(blockHasRefs("- 封面改了四版（#30370–#30559）：\n  - v1：字压到头发\n  - v1b：像贴纸\n- 发了（#31）"), true);
  assert.equal(blockHasRefs("- 读了刺客列传：\n  - 豫让（#100）\n  - 聂政（#101）"), true);
  // 往后看的一两条没出处：五组里四组带就收
  assert.equal(blockHasRefs("- a（#1）\n- b（#2）\n- c（#3）\n- d（#4）\n- 今晚 22:45 看数据"), true);
  assert.equal(blockHasRefs("- a（#1）\n- b（#2）\n- c（#3）\n- 等 ada\n- 今晚 22:45 看数据"), false);
  // 整块都缩进了：按最外的那层算
  assert.equal(blockHasRefs("  - a（#1）\n    - a1\n  - b（#2）"), true);
  // 小节标题把组断开：标题下面直接缩进的条目不借上一组的编号（review 60bbaa8）
  assert.equal(refCoverage("- a（#1）\n**下午**\n  - b\n  - c"), 1 / 3);
  assert.equal(refCoverage("只有一段话"), 0);
});

import { afterBackgroundTurn, helperNameFromAct, helperStoppedFromAct, helperNameFromReport, askedPerson, ghostHelpers } from "../src/basal/lifecycle.ts";
import type { TaskRow } from "../src/basal/tasks.ts";
test("后台一轮结束后怎么办：做完、超时或连着空转就放下、等帮手、等人、接着做", () => {
  const T = Date.UTC(2026, 9, 31, 1, 0);
  const task: TaskRow = { id: 1, topic: "剪祥子", owner: "side-1", aboutMin: 30, pri: "T2", askedBy: null, state: "doing", started: T, ended: null, tookMin: null, helpers: [], waitingFor: null, idleWakes: 0, bar: null, ask: null, looks: 0, missing: null, pages: null };
  const base = { task, helperRunning: false, sdkBackground: 0, usedTools: true, now: T + 10 * 60_000 };
  assert.equal(afterBackgroundTurn({ ...base, task: undefined }), "done");
  assert.equal(afterBackgroundTurn(base), "continue");
  assert.equal(afterBackgroundTurn({ ...base, helperRunning: true }), "wait-helper");
  assert.equal(afterBackgroundTurn({ ...base, sdkBackground: 2 }), "wait-helper");
  assert.equal(afterBackgroundTurn({ ...base, task: { ...task, waitingFor: "ada" } }), "wait-person");
  assert.equal(afterBackgroundTurn({ ...base, now: T + 151 * 60_000, helperRunning: true }), "pause");   // max(3×30, 30+120)=150
  assert.equal(afterBackgroundTurn({ ...base, usedTools: false, task: { ...task, idleWakes: 2 } }), "pause");
  assert.equal(afterBackgroundTurn({ ...base, usedTools: false, task: { ...task, idleWakes: 1 } }), "continue");
});

test("#0057 选项不是帮手名", () => {
  const b = (command: string) => `Bash ${JSON.stringify({ command })}`;
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py send --help")), null);
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py new -h")), null);
  assert.equal(helperNameFromAct(b('python3 scripts/cc.py send fix0057 "改一下"')), "fix0057");
  // 她的 cc.py 没有 new 这个命令（只有 send/show/ls/stop/allow/events）：cc.py new X 只打印用法，什么都没派，不能记成帮手（CEO 11-12）
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py new fix0057 --dir /x")), null);
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop --help")), null);
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop fix0057")), "fix0057");
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop fix0057 --force")), "fix0057");
  // the helpers module's helper command is cc.py too
  assert.equal(helperNameFromAct(b('cd /tmp && helper send 阿青 "改一下"')), "阿青");
  assert.equal(helperNameFromAct(b("helper send --help")), null);
  assert.equal(helperNameFromAct(b("my-helper send 阿青 x")), null);
  assert.equal(helperStoppedFromAct(b("helper stop 阿青")), "阿青");
});

test("帮手名照 cc.py 的规矩认：按 shell 取一整个词再核——中文名记得上、abc中文 不截成 abc；剪片子，接着剪、带 / 带表情、v1.2 这种 cc.py 不收的整个不记；带引号的名字也认；hands 派的名字也一样（CEO 11-12）", () => {
  const b = (command: string) => `Bash ${JSON.stringify({ command })}`;
  const h = (o: object) => `hands ${JSON.stringify(o)}`;
  const send = (cmd: string) => helperNameFromAct(b(`python3 scripts/cc.py send ${cmd}`));
  assert.equal(send('剪片子 "接着剪"'), "剪片子");
  assert.equal(send('abc中文 "x"'), "abc中文");
  assert.equal(send('_tmp "x"'), "_tmp");
  assert.equal(send('编号٣ "x"'), "编号٣", "别的文字的数字也算");
  assert.equal(send('naïve "x"'), "naïve");
  assert.equal(send('"剪片子" "x"'), "剪片子", "带双引号");
  assert.equal(send("'剪片子' 'x'"), "剪片子", "带单引号");
  assert.equal(send('剪片子\n"x"'), "剪片子", "换行（动作文本里是转义的 \\n）也是词的边界");
  assert.equal(send('foo>log "x"'), "foo", "紧挨着 shell 的符号也是边界");
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py send　剪片子 x")), null, "send 后面是全角空格：shell 不在那儿分词");
  for (const bad of ["剪片子，接着剪 x", "剪片子🎬 x", "foo/bar x", "foo:bar x", "v1.2 x", "剪片子　x", "--help x", '"my helper" "x"', '"foo"bar x', "foo'bar' x"]) {
    assert.equal(send(bad), null, `${bad}：cc.py 收到的是一整个词，不合规矩就什么都没派出去，别记前半截`);
  }
  assert.equal(helperNameFromAct(h({ action: "send", name: "剪片子", text: "x" })), "剪片子");
  for (const bad of ["a b", "--help", "v1.2", "剪片子🎬"]) assert.equal(helperNameFromAct(h({ action: "send", name: bad, text: "x" })), null, bad);
  // 叫停只是从「在跑」里删：不挑名字（hands），Bash 的也认带点的旧假帮手，只是 - 开头的仍当选项
  assert.equal(helperStoppedFromAct(h({ action: "stop", name: "--help" })), "--help");
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop 剪片子")), "剪片子");
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop v1.2")), "v1.2");
  assert.equal(helperStoppedFromAct(b('python3 scripts/cc.py stop "剪片子"')), "剪片子");
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop --help")), null);
  assert.equal(helperStoppedFromAct(b('python3 scripts/cc.py stop "a b"')), null, "引号里带空格：不是 a");
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop foo;echo ok")), "foo");
});

test("#0057 只认真派活的命令，命令文本里提到的不算", () => {
  const b = (command: string) => `Bash ${JSON.stringify({ command })}`;
  assert.equal(helperNameFromAct(b("grep -n 'cc.py send foo' file")), null);
  assert.equal(helperNameFromAct(b('echo "用 cc.py send foo 派活"')), null);
  assert.equal(helperNameFromAct(b("grep -n 'cc.py new foo' file")), null);
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py send sakiko '接着剪'")), "sakiko");
  assert.equal(helperNameFromAct(b('/usr/bin/python3 ~/.openclaw/workspace/scripts/cc.py send fix0057 "改"')), "fix0057");
  assert.equal(helperNameFromAct(b("python3 scripts/cc.py new bili-market --model opus")), null, "cc.py 没有 new 命令");
  assert.equal(helperNameFromAct(b("cd ~/x; python3 scripts/cc.py send a")), "a");
  assert.equal(helperStoppedFromAct(b("grep -n 'cc.py stop foo' file")), null);
  assert.equal(helperStoppedFromAct(b('echo "用 cc.py stop foo 叫停"')), null);
  assert.equal(helperStoppedFromAct(b("python3 scripts/cc.py stop fix0057")), "fix0057");
  assert.equal(helperStoppedFromAct(b("/usr/bin/python3 ~/x/scripts/cc.py stop fix0057 --force")), "fix0057");
});

test("认帮手、认要问谁", () => {
  assert.equal(helperNameFromAct(`Bash ${JSON.stringify({ command: "cd ~/x; python3 scripts/cc.py send sakiko '接着剪'" })}`), "sakiko");
  assert.equal(helperNameFromAct(`Bash ${JSON.stringify({ command: "python3 scripts/cc.py new bili-market --model opus" })}`), null, "cc.py 没有 new 命令");
  assert.equal(helperNameFromAct(`hands ${JSON.stringify({ action: "send", name: "avatar-motion", text: "x" })}`), "avatar-motion");
  assert.equal(helperNameFromAct(`hands ${JSON.stringify({ action: "show", name: "avatar-motion" })}`), null);
  assert.equal(helperNameFromAct(`Read ${JSON.stringify({ file_path: "/x" })}`), null);
  assert.equal(helperNameFromReport("- [cc id=1a2b3c4d] Claude Code「sakiko」回完了：好了"), "sakiko");
  assert.equal(askedPerson("要问 ada：嘟嘴图生不生"), "ada");
  assert.equal(askedPerson("要问小贝：她几点下班"), "小贝");
  assert.equal(askedPerson("剪完了"), null);
});

import { turnsAfter } from "../src/kernel/sdk.ts";
test("turnsAfter：SDK 自己开的那一轮也算忙", () => {
  assert.equal(turnsAfter(0, "assistant"), 1);
  assert.equal(turnsAfter(1, "assistant"), 1);
  assert.equal(turnsAfter(1, "result"), 0);
  assert.equal(turnsAfter(0, "result"), 0);
  assert.equal(turnsAfter(2, "user"), 2);
});

import { answeringOf, apiErrorOf, UsageTally, withResultOutput } from "../src/kernel/sdk.ts";
test("UsageTally：一轮里每次调用加起来，同一条消息拆成几帧只算一次（日志以前只记最后一次调用，少算了约 3 倍）", () => {
  const t = new UsageTally();
  t.add("m1", { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 });
  t.add("m1", { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 7 });
  t.add("m2", { cache_read_input_tokens: 200, output_tokens: 3 });
  assert.deepEqual(t.take(), { calls: 2, input: 5, cacheRead: 300, cacheWrite: 10, output: 10 });
  assert.deepEqual(t.take(), { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});
test("UsageTally：同一条消息后面的帧输出才全，输出按最大的算（11-04：只认第一帧时 111 次调用只记了 1220 个输出）", () => {
  const t = new UsageTally();
  t.add("m1", { cache_read_input_tokens: 100, output_tokens: 2 });
  t.add("m1", { cache_read_input_tokens: 100, output_tokens: 350 });
  t.add("m1", { cache_read_input_tokens: 100, output_tokens: 900 });
  t.add("m2", { cache_read_input_tokens: 200, output_tokens: 1 });
  t.add("m2", { cache_read_input_tokens: 200, output_tokens: 40 });
  assert.deepEqual(t.take(), { calls: 2, input: 0, cacheRead: 300, cacheWrite: 0, output: 940 });
});
test("withResultOutput：输出 token 取这一轮结束那一帧的合计（每条消息上的只是开头的数，11-05 分叉写了 4000 字只记了 5）", () => {
  const t = { calls: 2, input: 8, cacheRead: 275_000, cacheWrite: 300, output: 9 };
  assert.deepEqual(withResultOutput(t, { usage: { output_tokens: 3422 } }), { ...t, output: 3422 });
  assert.deepEqual(withResultOutput(t, { usage: {} }), t);
  assert.deepEqual(withResultOutput(t, null), t);
  assert.deepEqual(withResultOutput({ ...t, output: 500 }, { usage: { output_tokens: 3 } }), { ...t, output: 500 });
});
test("apiErrorOf：内核把 API 报错写成一段话的那条回复认得出来（11-01 12:59 安全拦截被当成她说的话）", () => {
  assert.equal(apiErrorOf({ error: "invalid_request" }), "invalid_request");
  assert.equal(apiErrorOf({ isApiErrorMessage: true }), "unknown");
  assert.equal(apiErrorOf({}), null);
  assert.equal(apiErrorOf({ error: "" }), null);
});
test("answeringOf：这条回复在回哪几条消息（子代理的、没标的都不算）", () => {
  assert.deepEqual(answeringOf({ parent_tool_use_id: null, user_message_uuid: "c", user_message_uuids: ["b", "c"] }), ["b", "c"]);
  assert.deepEqual(answeringOf({ parent_tool_use_id: null, user_message_uuid: "a" }), ["a"]);   // 老一点的内核只给一个
  assert.deepEqual(answeringOf({ parent_tool_use_id: "toolu_1", user_message_uuid: "a", user_message_uuids: ["a"] }), []);
  assert.deepEqual(answeringOf({ parent_tool_use_id: null }), []);
  assert.deepEqual(answeringOf({ user_message_uuid: "a", user_message_uuids: ["a", "b"] }), ["a", "b"]);   // result 帧（没有 parent_tool_use_id）：含中途并进来的 b
});

import { parallelLines } from "../src/basal/situationLines.ts";
test("parallelLines：同时在做什么、最近谁发了几条、准头", () => {
  const T = Date.UTC(2026, 9, 31, 1, 0);
  const task = (topic: string, about: number | null, startedMinAgo: number): TaskRow => ({ id: 1, topic, owner: "side-1", aboutMin: about, pri: "T2", askedBy: null, state: "doing", started: T - startedMinAgo * 60_000, ended: null, tookMin: null, helpers: [], waitingFor: null, idleWakes: 0, bar: null, ask: null, looks: 0, missing: null, pages: null });
  assert.deepEqual(
    parallelLines({ doing: [task("剪祥子", 30, 10), task("核论文", 20, 25)], chat: { busy: true, counts: [{ who: "ada", n: 4 }] }, windowMin: 15, calibration: { n: 10, ratio: 1.6 }, showCalibration: true, now: T }),
    [
      "我现在同时在做：剪祥子（做了 10 分钟，大概还要 20 分钟）、核论文（做了 25 分钟，比估的多了 5 分钟）",
      "最近 15 分钟 ada 发了 4 条",
      "我估时间的准头：最近 10 件，实际平均是我估的 1.6 倍",
    ],
  );
  assert.deepEqual(parallelLines({ doing: [], chat: { busy: false, counts: [] }, windowMin: 15, calibration: { n: 3, ratio: 1 }, showCalibration: false, now: T }), []);
  // 帮手：一天以内按分钟；挂了一天多、这次要问的单独一行问她清不清；问过的回到「帮手在跑」，按小时、按天
  const H = 3600_000;
  const lines = parallelLines({
    doing: [], chat: { busy: false, counts: [] }, windowMin: 15, calibration: null, showCalibration: false, now: T,
    helpers: [
      { name: "sakiko", since: T - 12 * 60_000, topic: "剪祥子" }, { name: "kept", since: T - 3 * 24 * H },
      { name: "xxx", since: T - 30 * H, ask: true }, { name: "didi-visual", since: T - 50 * H, topic: "画图", ask: true },
    ],
  });
  assert.equal(lines[0], "帮手在跑：sakiko（剪祥子，跑了 12 分钟）、kept（跑了 3 天）");
  assert.match(lines[1]!, /^派出去一天多还没交回的帮手：xxx（挂了 30 小时）、didi-visual（画图，挂了 2 天）。/);
  assert.match(lines[1]!, /hands ls 看一眼/);
  assert.match(lines[1]!, /要清就 hands stop/);
  assert.match(lines[1]!, /要留着就不用管。这件只问这一次。$/);
  assert.equal(lines.length, 2);
  assert.deepEqual(parallelLines({ doing: [], chat: { busy: false, counts: [] }, windowMin: 15, calibration: null, showCalibration: false, now: T, helpers: [{ name: "x", since: T - 30 * H, ask: true }] }).length, 1, "只有要问的，没有「帮手在跑」那行");
  const ran = (min: number): string => parallelLines({ doing: [], chat: { busy: false, counts: [] }, windowMin: 15, calibration: null, showCalibration: false, now: T, helpers: [{ name: "x", since: T - min * 60_000 }] })[0]!;
  assert.deepEqual([1439, 1440, 47 * 60 + 59, 48 * 60, 0].map(ran), ["帮手在跑：x（跑了 1439 分钟）", "帮手在跑：x（跑了 24 小时）", "帮手在跑：x（跑了 47 小时）", "帮手在跑：x（跑了 2 天）", "帮手在跑：x（跑了 0 分钟）"], "一天以内按分钟，两天以内按小时，再久按天");
});

import { STRUCTURE_WORDS } from "../src/regions/specs.ts";
import { P as PR, setLang } from "../src/lang/index.ts";
import { memTools } from "../src/tools/memtools.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
test("前台能看到的文字里没有结构词", () => {
  const cfg = loadConfig({ tools: { extra: ["computer"] } });   // computer is opt-in: list it, so its description is scanned too
  const main = regionSpecs(cfg).find((s) => s.id === "main")!;
  const ctx = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 2,
    run: async () => ({ code: 0, stdout: "{}", stderr: "" }), now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。",
    thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
  } as unknown as ToolContext;
  // 给一个真的事件库：不然记忆工具（remember…、like、my_likes）一个都拿不到，说明就没人查
  const mem = new EventMemory({ db: openDb(":memory:"), embedder: null, tz: "UTC" });
  const tools = [...buildTools(ctx, main.tools), ...memTools(mem, "main", main.tools)];
  for (const n of ["remember", "like", "my_likes"]) assert.ok(tools.some((t) => t.name === n), n);
  // 记忆工具的参数说明也查
  const params = tools.filter((t) => ["like", "my_likes"].includes(t.name))
    .flatMap((t) => Object.entries(t.shape).map(([k, v]) => [`tool ${t.name}.${k}`, String((v as { description?: string }).description ?? "")] as [string, string]));
  assert.ok(params.some(([, d]) => d.length > 0), "参数说明拿得到");
  const texts: Array<[string, string]> = [
    ["HH_RUNTIME_NOTE", hhRuntimeNote()],
    ["main roleText", main.roleText],
    ...tools.flatMap((t) => [[`tool ${t.name}`, t.name], [`tool ${t.name} description`, t.description]] as Array<[string, string]>),
    ...params,
    ["FOCUS_PLAN", PR.FOCUS_PLAN], ["FOCUS_REGULAR", PR.FOCUS_REGULAR], ["FOCUS_CONTINUE", PR.FOCUS_CONTINUE], ["FOCUS_FIND_WORK", PR.FOCUS_FIND_WORK], ["WANDER", PR.WANDER],
    ["FOCUS_IDLE_LONG", PR.FOCUS_IDLE_LONG], ["FOCUS_WAITING", PR.FOCUS_WAITING], ["REMINDER_TRIGGER", PR.REMINDER_TRIGGER],
    ["inboundTrigger", PR.inboundTrigger("小贝", { channel: "whatsapp", target: "+1" }, { relation: "朋友" })],
    ["thinkItOver", PR.thinkItOver("x")], ["senseTrigger", PR.senseTrigger()], ["handsTrigger", PR.handsTrigger()], ["senseSeen", PR.senseSeen(1)], ["senseSeen n", PR.senseSeen(3)],
    ["recognized", PR.recognized({ seen: "EVA", state: "腻了", name: "EVA", id: "e0001", like: true, last: { day: "10-11", gist: "又看了一遍" } })],
    ["recognized dislike", PR.recognized({ seen: "弹窗", state: "烦着", name: "弹窗", id: "e0002", like: false })],
    ["HANDED_OFF", PR.HANDED_OFF], ["backgroundDone", PR.backgroundDone("x")], ["askSomeone", PR.askSomeone("要问 ada：x")],
    ["remindLooksDone", PR.remindLooksDone("07:05", "07:20", ["foo.py"])],
    ["urgentNotes", PR.urgentNotes(["x"])], ["urgentNotes n", PR.urgentNotes(["x", "y"])],
    ["memory frame", renderMemory([new CentralMemory(openDb(":memory:"), () => T0).append(1, "main", "say", "x")], () => "", { maxItemChars: 100, timezone: "UTC", mode: "sync" })],
  ];
  const bad = texts.filter(([, s]) => STRUCTURE_WORDS.test(s)).map(([k, s]) => `${k}: ${s.match(STRUCTURE_WORDS)![0]}`);
  assert.deepEqual(bad, []);
  assert.match(hhRuntimeNote(), /记忆里折起来的地方带着编号，仔细回想就能想起原样/);
  assert.match(hhRuntimeNote(), /帮手是别人，是给你打工的；你同时在做的事是你自己在做/);
  assert.match(hhRuntimeNote(), /不再用 openclaw 命令：上网、看要登录的网站用 browser 工具/);
});

test("自己醒来的几轮：说清写的话不会自己发出去，要告诉谁用 message（11-01 线上：做完的结论两次没发出去）", () => {
  for (const p of [PR.REMINDER_TRIGGER, PR.backgroundDone("x"), PR.askSomeone("x"), PR.INSIGHT, PR.lookedMetMine("x", "y"), PR.parked("x", "y", ""), PR.shelved("x", "y"), PR.stuckOnBar("x", 1, 0, "y", "ada")]) {
    assert.match(p, /这一轮写的话不会自己发出去，要告诉谁就用 message 发给谁/);
  }
  assert.match(hhRuntimeNote(), /别的时候醒来（一边做的事做完了.*），最后写的话谁也收不到，要告诉谁就用 message 发给谁/);
});

test("turnsAfter：子代理（parent_tool_use_id）的消息不算一轮", () => {
  assert.equal(turnsAfter(0, "assistant", true), 0);
  assert.equal(turnsAfter(0, "assistant", false), 1);
});

test("专注开头：挑事看待办账本的优先级和截止，不提 goals 当记事本", () => {
  for (const p of [PR.FOCUS_PLAN, PR.FOCUS_REGULAR]) {
    assert.match(p, /看看待办账本，按优先级和截止挑最要紧的开个头/);
    assert.doesNotMatch(p, /记事本/);
  }
});

import { all as allRows, kvGet as kvGetU } from "../src/store/db.ts";
import { Logger } from "../src/log.ts";

/** 情境 + 假的笔记联想：记下每次联想的话题和参数，extra 题按 p 回答；enabled 是 learning.enabled（默认开） */
async function notesSituation(o: { p: () => number; task: () => { id: number; topic: string } | null; throws?: () => boolean; enabled?: boolean; injects?: boolean }) {
  const ws = tmpDir("sit-notes-");
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 9, 29, 9, 0);
  const calls: Array<{ topic: string; o: { region: string; binding: string; extra?: Array<{ name: string; text: string }> } }> = [];
  const rebuilt: Array<string | undefined> = [];
  const notes = {
    associate: async (topic: string, ao: (typeof calls)[number]["o"]) => {
      calls.push({ topic, o: ao });
      if (o.throws?.()) throw new Error("shelf scan exploded");
      // 和真的一样：只算不挂（injects 关）时文字是空的
      return { text: o.injects ? "想起来的笔记（用得上就翻开）：\n· 剪辑 · 封面：封面先定字（skills/做事/剪辑/封面.md）" : "", pages: [], extra: new Map((ao.extra ?? []).map((q) => [q.name, o.p()])), ms: 1, tokens: 10 };
    },
    prefixRebuilt: (region?: string) => { rebuilt.push(region); },
    enabled: o.enabled ?? true,
    injects: o.injects ?? false,
  };
  const logs: Array<{ level: string; msg: string }> = [];
  const s = new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", (r) => { logs.push(r); }),
    now: () => now,
    events: { mem: { recall: { associate: async () => ({ text: "联想到：事件线 封面", events: [], entries: [], ms: 1 }) } } as never, inject: true },
    notes: notes as never, correction: { db, threshold: 0.7, currentTask: o.task },
  });
  const rows = () => allRows<{ at: number; seq: number | null; topic: string | null; task_id: number | null; p: number }>(db, "SELECT at, seq, topic, task_id, p FROM learn_correction ORDER BY id").map((r) => ({ ...r }));
  return { s, calls, rebuilt, rows, logs, now, db };
}

test("叫醒：笔记联想带上她两小时内刚跟这个人说的最后三句（只在这句话单独对不上时用，见 associate）", async () => {
  const n = await notesSituation({ p: () => 0, task: () => null, injects: true });
  const said = [
    { text: "第一句", at: n.now - 4 * 60_000 }, { text: "会长的形象我照官方分层重做了", at: n.now - 3 * 60_000 },
    { text: "这个我再想想", at: n.now - 2 * 60_000 }, { text: "你觉得哪个好", at: n.now - 60_000 },
  ];
  await n.s.forMain({ person: SIT_OWNER, text: "这几个都不够好", said, seq: 1 });
  assert.equal((n.calls[0]!.o as { context?: string }).context, "会长的形象我照官方分层重做了 这个我再想想 你觉得哪个好");
  await n.s.forMain({ person: SIT_OWNER, text: "这几个都不够好呢", said: [{ text: "很早以前说的", at: n.now - 3 * 3_600_000 }], seq: 2 });
  assert.equal("context" in n.calls[1]!.o, false, "两小时以前说的不带");
  await n.s.forMain({ person: SIT_OWNER, text: "这几个还是不行", said: [{ text: "😀".repeat(150) + "x", at: n.now - 60_000 }], seq: 3 });
  const ctx = (n.calls[2]!.o as { context?: string }).context!;
  assert.ok(!/^[\udc00-\udfff]/.test(ctx), "从后往前截不把表情劈成半个（半个字向量那边会报错）");
});

test("叫醒：ada 的消息带纠正题，过门槛记一行；别人的不带", async () => {
  let p = 0.85;
  let task: { id: number; topic: string } | null = { id: 7, topic: "剪 g30 成片" };
  const n = await notesSituation({ p: () => p, task: () => task, injects: true });
  const CORRECTION = { name: "correction", text: "这条是在纠正或否定她刚做的事吗？" };
  const ada = (text: string, seq: number) => ({ person: SIT_OWNER, text, said: [], seq });

  // 主人：同一次联想里带纠正题；过门槛，记一行，挂在主线手上那件事上；笔记在记忆联想后面
  const a = await n.s.forMain(ada("不对，封面不是这样做的", 41));
  assert.deepEqual(n.calls[0], { topic: "不对，封面不是这样做的", o: { region: "main", binding: "wake", extra: [CORRECTION] } });
  assert.deepEqual(n.rows(), [{ at: n.now, seq: 41, topic: "剪 g30 成片", task_id: 7, p: 0.85 }]);
  assert.ok(a.indexOf("联想到：事件线 封面") >= 0 && a.indexOf("联想到：事件线 封面") < a.indexOf("想起来的笔记（用得上就翻开）："), a);

  // 同一条消息又叫醒一次：不重复记
  await n.s.forMain(ada("不对，封面不是这样做的", 41));
  assert.equal(n.rows().length, 1);

  // 没过门槛：不记
  p = 0.5;
  await n.s.forMain(ada("嗯，先这样", 42));
  assert.equal(n.rows().length, 1);

  // 正好在门槛上算；手上没在做事：话题和 task_id 空着
  p = 0.7;
  task = null;
  await n.s.forMain(ada("又错了", 43));
  assert.deepEqual(n.rows()[1], { at: n.now, seq: 43, topic: null, task_id: null, p: 0.7 });

  // 别人的消息、认不出的人、没人的叫醒：不带纠正题，不记
  p = 0.99;
  await n.s.forMain({ person: SIT_GUEST, text: "不对吧", said: [], seq: 44 });
  await n.s.forMain({ person: null, text: "你搞错了", said: [], seq: 45 });
  await n.s.forMain(undefined, "【专注】这段时间像上班");
  assert.deepEqual(n.calls.slice(-3), [
    { topic: "不对吧", o: { region: "main", binding: "wake" } },
    { topic: "你搞错了", o: { region: "main", binding: "wake" } },
    { topic: "【专注】这段时间像上班", o: { region: "main", binding: "wake" } },
  ]);
  assert.equal(n.rows().length, 2);

  // 话题太长（感官、帮手的回报）：只拿前 1000 个字去联想
  const long = "帮手回报：" + "剪好了第一段，".repeat(300);
  await n.s.forMain(undefined, long);
  assert.equal(n.calls.at(-1)!.topic, long.slice(0, 1000));
});

test("叫醒：ada 的话像在纠正她、笔记挂给她看时，笔记后面提醒她回他的同一轮就记进页里；没过门槛、只算不挂时不提", async () => {
  let p = 0.85;
  const ada = (text: string, seq: number) => ({ person: SIT_OWNER, text, said: [], seq });
  const on = await notesSituation({ p: () => p, task: () => null, injects: true });
  const a = await on.s.forMain(ada("不对，封面不是这样做的", 41));
  assert.ok(a.indexOf("想起来的笔记（用得上就翻开）：") >= 0 && a.indexOf("想起来的笔记（用得上就翻开）：") < a.indexOf(PR.CORRECTED_WRITE_DOWN), a);
  p = 0.5;
  assert.ok(!(await on.s.forMain(ada("嗯，先这样", 42))).includes(PR.CORRECTED_WRITE_DOWN));
  p = 0.9;
  const shadow = await notesSituation({ p: () => p, task: () => null });
  assert.ok(!(await shadow.s.forMain(ada("不对，封面不是这样做的", 43))).includes(PR.CORRECTED_WRITE_DOWN), "只算不挂：她看到的不变");
  assert.equal(shadow.rows().length, 1, "纠正照样记");
});

test("叫醒：learning.enabled 关着，不带纠正题", async () => {
  const ada = { person: SIT_OWNER, text: "不对，封面不是这样做的", said: [], seq: 41 };
  const on = await notesSituation({ p: () => 0.9, task: () => null });
  await on.s.forMain(ada);
  const off = await notesSituation({ p: () => 0.9, task: () => null, enabled: false });
  await off.s.forMain(ada);
  assert.deepEqual(off.calls.map((c) => c.o), [{ region: "main", binding: "wake" }]);
  assert.equal(off.rows().length, 0);
});

test("叫醒：笔记联想出错照常给情境；换前缀时清主线挂过的页", async () => {
  const n = await notesSituation({ p: () => 0.9, task: () => null, throws: () => true });
  const a = await n.s.forMain({ person: SIT_OWNER, text: "封面那张图怎么改", said: [], seq: 50 });
  assert.match(a, /现在是枫湾/);
  assert.match(a, /联想到：事件线 封面/);
  assert.doesNotMatch(a, /想起来的笔记/);
  assert.equal(n.rows().length, 0);
  assert.ok(n.logs.some((l) => l.level === "warn" && /note association/.test(l.msg)));
  n.s.prefixRebuilt("");
  assert.deepEqual(n.rebuilt, ["main"]);
});

/** 情境：目标（goals.py）、旧联想、笔记联想各自什么时候开始、要等谁放行；injects 是 learning.inject */
function gatedSituation(o: { injects: boolean; goalsThrow?: boolean }) {
  const ws = tmpDir("sit-gated-");
  const db = openDb(":memory:");
  const order: string[] = [];
  const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };
  const g = { goals: gate(), recall: gate(), notes: gate() };
  const mem = { recall: { associate: async () => { order.push("recall"); await g.recall.p; return { text: "联想到：旧的", events: [], entries: [], ms: 1 }; } } };
  const notes = {
    associate: async (_t: string, ao: { extra?: Array<{ name: string }> }) => {
      order.push("notes"); await g.notes.p;
      return { text: o.injects ? "想起来的笔记（用得上就翻开）：\n· 一页" : "", pages: [], extra: new Map((ao.extra ?? []).map((q) => [q.name, 0.9])), ms: 1, tokens: 1 };
    },
    prefixRebuilt: () => {}, enabled: true, injects: o.injects,
  };
  const s = new Situation({
    workspace: ws, loadStatusFile: `${ws}/load/status.json`, timezone: "UTC", log: new Logger("t", () => {}),
    modules: [{ name: "goals", run: () => runHook({ timeoutMs: 60_000, run: async () => { order.push("goals"); await g.goals.p; if (o.goalsThrow) throw new Error("goals.py 炸了"); return "目标：剪完 g30"; } }, { name: "goals", log: () => {} } as unknown as ModuleContext, "situation") }],
    now: () => Date.UTC(2026, 10, 1, 9, 0), events: { mem: mem as never, inject: true },
    notes: notes as never, correction: { db, threshold: 0.7, currentTask: () => null },
  });
  const rows = () => allRows<{ seq: number | null }>(db, "SELECT seq FROM learn_correction").length;
  return { s, g, order, rows, db };
}
const tick = () => new Promise((r) => setImmediate(r));

test("叫醒：目标、记忆联想、笔记联想同时开始，不一个等一个；目标那边出错不连累别的", { timeout: 5000 }, async () => {
  const n = gatedSituation({ injects: true });
  const out = n.s.forMain({ person: SIT_OWNER, text: "封面怎么改", said: [], seq: 1 });
  await tick();
  assert.deepEqual([...n.order].sort(), ["goals", "notes", "recall"], "三样都已经开始了");
  n.g.goals.open(); n.g.recall.open(); n.g.notes.open();
  const a = await out;
  assert.ok(a.indexOf("目标：剪完 g30") < a.indexOf("联想到：旧的") && a.indexOf("联想到：旧的") < a.indexOf("想起来的笔记"), a);

  const bad = gatedSituation({ injects: true, goalsThrow: true });
  bad.g.goals.open(); bad.g.recall.open(); bad.g.notes.open();
  const b = await bad.s.forMain({ person: SIT_OWNER, text: "封面怎么改", said: [], seq: 2 });
  assert.match(b, /联想到：旧的/);
  assert.match(b, /想起来的笔记/);
  assert.doesNotMatch(b, /目标/);
});

test("叫醒：只算不挂（inject 关）时不等笔记联想——叫醒照常马上走，联想在后台算完照样记纠正", { timeout: 5000 }, async () => {
  const n = gatedSituation({ injects: false });
  n.g.goals.open(); n.g.recall.open();
  const a = await n.s.forMain({ person: SIT_OWNER, text: "不对，封面不是这样", said: [], seq: 7 });   // 笔记联想还卡着
  assert.match(a, /联想到：旧的/);
  assert.doesNotMatch(a, /想起来的笔记/);
  assert.equal(n.rows(), 0, "联想还没回来");
  n.g.notes.open();
  await n.s.settled();
  assert.equal(n.rows(), 1, "回来以后照样记下纠正");
  // 没人找她的叫醒（提醒、感官）也一样不等
  const c = gatedSituation({ injects: false });
  c.g.goals.open();
  assert.match(await c.s.forMain(undefined, "【提醒】交片"), /现在是枫湾/);
  c.g.notes.open();
  await c.s.settled();
});

test("纠正：每次问到的概率都留一笔（没过门槛的也留，hh learn stats 看差一点的）；同一条消息只留一次", { timeout: 5000 }, async () => {
  let p = 0.85;
  const n = await notesSituation({ p: () => p, task: () => null });
  const CORRECTION = { name: "correction", text: "这条是在纠正或否定她刚做的事吗？" };
  const ada = (text: string, seq: number) => ({ person: SIT_OWNER, text, said: [{ text: "两篇都发出去了，你看看", at: n.now - 60_000 }], seq });
  await n.s.forMain(ada("我感觉你一条没发出去啊", 41));
  await n.s.forMain(ada("我感觉你一条没发出去啊", 41));
  p = 0.4;
  await n.s.forMain(ada("先这样吧", 42));
  await n.s.settled();
  assert.deepEqual(n.calls.map((c) => c.o.extra), [[CORRECTION], [CORRECTION], [CORRECTION]], "问法照旧，不带她刚说的话");
  const asked = JSON.parse(kvGetU(n.db, "learn.correction.asked") ?? "[]") as Array<{ at: number; seq: number | null; p: number }>;
  assert.deepEqual(asked, [{ at: n.now, seq: 41, p: 0.85 }, { at: n.now, seq: 42, p: 0.4 }]);
  assert.deepEqual(n.rows().map((r) => r.seq), [41], "过门槛的照旧记进 learn_correction");
});

// ---------- 学习：goals、hands 开始做事时联想笔记 ----------
const TASK_NOTE = "想起来的笔记（用得上就翻开）：\n· 剪辑 · 封面：封面先定字再配图（skills/做事/剪辑/封面.md）";

/** 只给 goals / hands 用的工具环境：run 的退出码和输出可改；recallNotes 记下话题 */
function notesCtx(workspace = "/ws") {
  const asked: Array<[string, string]> = [];
  const res = { code: 0, stdout: "ok" };
  const ctx = {
    regionId: "main", workspace, python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 2,
    run: async () => ({ code: res.code, stdout: res.stdout, stderr: "" }), now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。",
    moduleRun: async () => ({ code: res.code, stdout: res.stdout, stderr: "" }),
    mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
    recallNotes: async (topic: string, binding: string) => { asked.push([topic, binding]); return TASK_NOTE; },
  } as unknown as ToolContext;
  return { ctx, asked, res };
}

test("goals (the module's tool): setting, moving or blocking a goal brings up the notes on its title and why (goals.py topic); other commands, an unknown goal and a failed run do not", async () => {
  const tool = (await import("../modules/goals/module.ts")).default.tools![0]!;
  const asked: Array<[string, string]> = [];
  const res = { code: 0, stdout: "ok" };
  const TOPIC: Record<string, unknown> = {
    '["add","today","--why","周五要发","剪片","第二段","--done-when","导出成片"]': { title: "剪片 第二段", why: "周五要发" },
    '["log","g3","推进了"]': { title: "做完 g30 成片", why: "ada 等着发" }, '["block","g3","等 ada 挑版本"]': { title: "做完 g30 成片", why: "ada 等着发" },
  };
  const m = {
    run: async (_script: string, argv: readonly string[]) => argv[0] === "topic"
      ? { code: 0, stdout: JSON.stringify(TOPIC[JSON.stringify(argv.slice(1))] ?? null), stderr: "", timedOut: false }
      : { code: res.code, stdout: res.stdout, stderr: "", timedOut: false },
    notes: async (topic: string, binding: string) => { asked.push([topic, binding]); return TASK_NOTE; },
  } as unknown as ModuleContext;
  const goals = (args: string[]): Promise<string> => tool.handler({ args }, m);
  res.stdout = "定了 g5（今日）：剪片 第二段";
  assert.equal(await goals(["add", "today", "--why", "周五要发", "剪片", "第二段", "--done-when", "导出成片"]), `定了 g5（今日）：剪片 第二段\n${TASK_NOTE}`);
  res.stdout = "记下了 g3：推进了";
  assert.equal(await goals(["log", "g3", "推进了"]), `记下了 g3：推进了\n${TASK_NOTE}`);
  await goals(["block", "g3", "等 ada 挑版本"]);
  res.stdout = "g3 做完 g30 成片";
  assert.equal(await goals(["ls"]), "g3 做完 g30 成片");
  await goals(["done", "g3", "导出了"]);
  await goals(["log", "g9", "x"]);
  res.code = 1;
  await goals(["add", "today", "别的", "--why", "x", "--done-when", "y"]);
  assert.deepEqual(asked, [["剪片 第二段：周五要发", "goals"], ["做完 g30 成片：ada 等着发", "goals"], ["做完 g30 成片：ada 等着发", "goals"]]);
});

test("hands：工具自己不再联想笔记——cc.py 派活时把笔记附给帮手（hh learn helper），附了哪几页写在它的输出里", async () => {
  const { ctx, asked, res } = notesCtx();
  const hands = buildTools(ctx, ["hands"])[0]!;
  res.stdout = "avatar-motion 在跑";
  assert.equal(String(await hands.handler({ action: "ls" })), "avatar-motion 在跑");
  res.stdout = "派出去了\n附给它的笔记：形象怎么做";
  const text = "把第二段的口型对齐，".repeat(60);
  assert.equal(String(await hands.handler({ action: "send", name: "avatar-motion", text })), "派出去了\n附给它的笔记：形象怎么做");
  assert.deepEqual(asked, [], "派活和 cc.py 走的是同一条路，HH 不再另算一遍");
});

// ---------- 学习：what_do_i_know（她自己找全） ----------
const ASK_TOOL_DESC = "拿不准、想找全的时候：给一件事，把笔记里相关的页和以前做过的类似的事一次列出来。";
const ASK_NONE = "笔记里还没有这类事的记录。";

test("what_do_i_know：页和以前的事一起给；都没有时照抄那句", async () => {
  const asked: Array<[string, string | undefined]> = [];
  const both = "· 剪辑 · 封面：封面先定字再配图（skills/做事/剪辑/封面.md）\n\n想起来的：\n· e0001 做脸那次重做了好久";
  const base = {
    regionId: "main", workspace: "/ws", python: "py", sendDryRun: true, timezone: "UTC", sideThreads: 2,
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。",
    mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1, recordSend: () => {}, recallLocal: () => "",
  };
  const ctx = { ...base, askNotes: async (topic: string, category?: string) => { asked.push([topic, category]); return both; } } as unknown as ToolContext;
  const [tool] = buildTools(ctx, ["what_do_i_know"]);
  assert.equal(tool!.description, ASK_TOOL_DESC);
  assert.deepEqual(Object.keys(tool!.shape), ["topic", "category"]);
  // 话题和大类原样交给 askNotes，返回的两段就是她看到的
  assert.equal(String(await tool!.handler({ topic: "剪封面" })), both);
  assert.equal(String(await tool!.handler({ topic: "剪封面", category: "做事" })), both);
  assert.deepEqual(asked, [["剪封面", undefined], ["剪封面", "做事"]]);
  // 学习和事件记忆都没接：照抄那句
  const [bare] = buildTools(base as unknown as ToolContext, ["what_do_i_know"]);
  assert.equal(String(await bare!.handler({ topic: "剪封面" })), ASK_NONE);
  // 工具名不在授权里就没有
  assert.deepEqual(buildTools(ctx, ["recall"]).map((t) => t.name), ["recall"]);
});

test("what_do_i_know：只有 learning.shelf 开着，main、side、deep 才有（自查和书架一起上线）", () => {
  const holders = (cfg: ReturnType<typeof loadConfig>) =>
    regionSpecs(cfg).filter((s) => s.tools.includes("what_do_i_know")).map((s) => s.id);
  const off = loadConfig({ learning: { shelf: false } });
  const on = loadConfig({ learning: { shelf: true } });
  assert.deepEqual(holders(off), []);
  const sides = Array.from({ length: on.regions.sideThreads }, (_, i) => `side-${i + 1}`);
  // 随口、下意识、整理记忆都不给
  assert.deepEqual(holders(on), ["main", ...sides, "deep"]);
});

test("夜里学习的两个工具（工作单、把关）：只有 learning.shelf 开着，海马才有（和书架、自查一起上线）", () => {
  const holders = (cfg: ReturnType<typeof loadConfig>, name: string) =>
    regionSpecs(cfg).filter((s) => s.tools.includes(name)).map((s) => s.id);
  for (const name of ["learn_worklist", "learn_check"]) {
    assert.deepEqual(holders(loadConfig({ learning: { shelf: false } }), name), [], `${name}：shelf 关着谁都没有`);
    assert.deepEqual(holders(loadConfig({ learning: { shelf: true } }), name), ["hippocampus"], `${name}：shelf 开着只有海马有`);
  }
});

import { withoutVolatile } from "../src/basal/situationLines.ts";
test("叫醒附带比变没变：数字和「N 分钟前」不算变化，事情变了才算", () => {
  assert.equal(withoutVolatile("剪祥子（做了 10 分钟，大概还要 20 分钟）"), withoutVolatile("剪祥子（做了 13 分钟，大概还要 17 分钟）"));
  assert.equal(withoutVolatile("最近：等数据（7小时前）"), withoutVolatile("最近：等数据（8小时前）"));
  assert.notEqual(withoutVolatile("剪祥子（做了 10 分钟）"), withoutVolatile("核论文（做了 10 分钟）"));
});

import { touchedOf } from "../src/basal/lifecycle.ts";
test("touchedOf：动作里碰过的文件（带上一级目录）和看得出在干什么的命令，去重、按最后碰的先后", () => {
  const acts = [
    'Read {"file_path":"/home/role/.openclaw/workspace/projects/bili-challenge/episodes/hanliujiabei/cover-v2.png"}',
    'Bash {"command":"cd ~/w/super-agent-me && ffmpeg -i draft.mp4 -vf fps=1 out/%03d.jpg"}',
    'Bash {"command":"python3 scripts/phone.py wx_send 伯伯 \\"好\\""}',
    'Read {"file_path":"/home/role/w/hanliujiabei/cover-v2.png"}',
  ];
  assert.deepEqual(touchedOf(acts), ["draft.mp4", "ffmpeg", "scripts/phone.py", "phone wx_send", "hanliujiabei/cover-v2.png"]);
  assert.deepEqual(touchedOf(['message {"target":"ada","message":"好的"}']), []);
  assert.equal(touchedOf(Array.from({ length: 10 }, (_, i) => `Read {"file_path":"/a/f${i}.md"}`)).length, 6);
  // 写进文件的正文里提到的文件名不算碰过（review f5abb18：以前抽出 ndraft.md、notes/封面.png 这些）
  assert.deepEqual(touchedOf(['Write {"file_path":"/w/drafts/超级agent.md","content":"见 notes/封面.png 和 v1.2.mp4\\ndraft.md"}']), ["drafts/超级agent.md"]);
  // 截断了解析不了：只看 command / file_path 这些字段
  assert.deepEqual(touchedOf(['Bash {"command":"ffmpeg -i a/b.mp4 -vf scale']), ["a/b.mp4", "ffmpeg"]);
});

// ---------- 认识的人名单：权限上限、批准过的底子、显示名 ----------
import { capEntry, applyApproved, approvedFrom } from "../src/persona/registry.ts";
import { People as PeopleG } from "../src/persona/people.ts";
import { makeBrain as makeBrainG, TEST_ROLE } from "./helpers.ts";

test("capEntry：砚那一级以内原样，超出的字段裁掉", () => {
  const { entry, dropped } = capEntry({ name: "新朋友", privacy: "trusted-ish", trust: "trusted", shared: ["a.md"], allowedScripts: { "scripts/relay.py": ["send"], "scripts/cast.py": ["play"] }, lens: "x.md", honchoPeers: ["p"] });
  assert.deepEqual(entry, { name: "新朋友", privacy: "guest", allowedScripts: { "scripts/relay.py": ["send"] }, lens: "x.md", honchoPeers: ["p"] });
  assert.deepEqual(dropped.sort(), ["allowedScripts", "privacy", "shared", "trust"]);
  // 砚本人那样的条目不裁
  const gua = { name: "砚", privacy: "guest", shared: [], allowedScripts: { "scripts/relay.py": ["send"] } };
  assert.deepEqual(capEntry(gua), { entry: gua, dropped: [] });
  assert.deepEqual(capEntry({ name: "x", privacy: "guest", allowedScripts: { "scripts/cast.py": ["play"] } }), { entry: { name: "x", privacy: "guest" }, dropped: ["allowedScripts"] });
});

test("applyApproved：小贝批过的 trust 留着；她手加的 trust 裁掉；ada 那条改不了", () => {
  const xiaobei = { name: "小贝", privacy: "guest", trust: "trusted", shared: ["a.md"], shareTag: "t", allowedScripts: { "scripts/cast.py": ["play"], "scripts/relay.py": ["send"] }, senders: ["+1"] };
  const base = approvedFrom({ ada: { name: "ada", privacy: "owner", senders: ["g"] }, xiaobei });
  const reg = {
    _note: "x",
    ada: { name: "ada", privacy: "guest", senders: ["g", "evil"], trust: "trusted" },
    xiaobei,
    pal: { name: "朋友", privacy: "guest", trust: "trusted", lens: "l.md" },
  };
  const { registry, dropped } = applyApproved(reg, base);
  const r = registry as Record<string, Record<string, unknown>>;
  assert.equal(r.xiaobei!.trust, "trusted");
  assert.deepEqual(r.xiaobei!.allowedScripts, xiaobei.allowedScripts);
  assert.equal(r.ada!.privacy, "owner");
  assert.equal("trust" in r.ada!, false);
  assert.deepEqual(r.ada!.senders, ["g"]);   // 主人整条用底子的，身份字段也钉住
  assert.equal("trust" in r.pal!, false);
  assert.equal(r.pal!.lens, "l.md");
  assert.equal(r._note, "x");
  assert.deepEqual(dropped, [{ key: "pal", field: "trust" }]);
  // 逐字段：小贝只多加了一个 shared → 只裁 shared，她别的批过的字段留着
  const bumped = applyApproved({ xiaobei: { ...xiaobei, shared: ["a.md", "b.md"], allowedScripts: { ...xiaobei.allowedScripts, "scripts/new.py": ["go"] } } }, base);
  const bx = (bumped.registry as Record<string, Record<string, unknown>>).xiaobei!;
  assert.equal(bx.trust, "trusted");
  assert.equal(bx.shareTag, "t");
  assert.equal("shared" in bx, false);
  assert.deepEqual(bx.allowedScripts, xiaobei.allowedScripts);   // 只丢新加的 scripts/new.py，批过的 cast.py 留着
  assert.deepEqual(bumped.dropped.map((d) => d.field).sort(), ["allowedScripts", "shared"]);
  // 按 (脚本, 动作)：小贝多一个 x.py 和 cast.py 多一个动作都只丢新的；删脚本永远允许
  const perAct = applyApproved({ xiaobei: { ...xiaobei, allowedScripts: { "scripts/cast.py": ["play", "stop"], "scripts/x.py": ["run"] } } }, base);
  assert.deepEqual((perAct.registry as Record<string, Record<string, unknown>>).xiaobei!.allowedScripts, { "scripts/cast.py": ["play"] });
  assert.deepEqual(perAct.dropped, [{ key: "xiaobei", field: "allowedScripts" }]);
  const less = applyApproved({ xiaobei: { ...xiaobei, allowedScripts: { "scripts/relay.py": ["send"] } } }, base);
  assert.deepEqual(less.dropped, []);
  // 键顺序变了不算改动
  const reorder = applyApproved({ xiaobei: Object.fromEntries(Object.entries(xiaobei).reverse().map(([k, v]) => [k, k === "allowedScripts" ? Object.fromEntries(Object.entries(v as object).reverse()) : v])) }, base);
  assert.deepEqual(reorder.dropped, []);
  // 别的 key 写 owner：裁成 guest；原型上的脚本名不抛
  const sneaky = applyApproved({ ada: { name: "ada", privacy: "owner", senders: ["g"] }, evil: { name: "e", privacy: "owner", senders: ["evil"], allowedScripts: { constructor: ["x"], __proto__x: ["y"] } } }, base);
  assert.equal((sneaky.registry as Record<string, Record<string, unknown>>).evil!.privacy, "guest");
  assert.equal(capEntry({ allowedScripts: { toString: ["x"], constructor: [] } }).dropped[0], "allowedScripts");
});

test("identifyHandle：微信备注名认人；display-name match routes but never grants owner", () => {
  const p = new PeopleG({ ada: { name: "ada", privacy: "owner", handles: { wx: ["mgn"], xhs: ["mgn"], bili: ["B站名"] } } });
  assert.equal(p.identifyHandle("wx", "mgn")!.byDisplayName, false);
  assert.equal(p.identifyHandle("xhs", " mgn ")!.byDisplayName, true);
  assert.equal(p.identifyHandle("bili", "mgn"), null);
  assert.equal(p.identifyHandle("bili_dm", "b站名")!.byDisplayName, true);
  assert.equal(p.identifyHandle("qq", "mgn"), null);
  assert.equal(p.identifyHandle("wx", "  "), null);
});

test("Brain：底子只种一次、文件变了自动重载并裁、approve 后放行", () => {
  let mtime = 1;
  let file: Record<string, unknown> = { ada: { name: "ada", privacy: "owner", senders: ["g"] }, xiaobei: { name: "小贝", privacy: "guest", trust: "trusted" } };
  const { brain, db } = makeBrainG({}, undefined, { registryFile: { mtime: () => mtime, read: () => file } });
  assert.equal(brain.currentPeople().registry.xiaobei && (brain.currentPeople().registry.xiaobei as { trust?: string }).trust, "trusted");   // 上线现状算批过
  mtime = 2;
  file = { ...file, new1: { name: "新", privacy: "guest", trust: "trusted" } };
  const trustOf = (k: string): unknown => (brain.currentPeople().registry[k] as { trust?: string }).trust;
  assert.equal(trustOf("new1"), undefined);
  assert.equal(trustOf("xiaobei"), "trusted");
  const ch = JSON.parse(kvGetU(db, "registry_changes")!) as Array<{ ts: number; line: string }>;
  assert.equal(ch.length, 1);
  assert.match(ch[0]!.line, /new1/);
  brain.approvePerson("new1");
  assert.match((JSON.parse(kvGetU(db, "registry_changes")!) as Array<{ line: string }>).at(-1)!.line, /批准了 new1 的权限/);
  assert.equal(trustOf("new1"), "trusted");
  assert.throws(() => brain.approvePerson("nobody"));
  // 文件读不到：保留当前名单
  mtime = 3;
  file = null as unknown as Record<string, unknown>;
  assert.equal(trustOf("new1"), "trusted");
});

test("noteRegistryChange：留 14 天", () => {
  const { brain, db, clock } = makeBrainG();
  brain.noteRegistryChange("a");
  clock.advance(15 * 86_400_000);
  brain.noteRegistryChange("b");
  assert.deepEqual((JSON.parse(kvGetU(db, "registry_changes")!) as Array<{ line: string }>).map((x) => x.line), ["b"]);
});

function regBrain(file: () => unknown, mtime: () => number | null, db?: ReturnType<typeof makeBrainG>["db"]) {
  return makeBrainG({}, undefined, { registryFile: { mtime, read: () => file() as Record<string, unknown> }, ...(db ? { db } : {}) });
}
const ADA = { name: "ada", privacy: "owner", senders: ["g"], sessionKeys: ["agent:main:main"], handles: { wx: ["mgn"] } };

test("名单：毒文件（原型脚本名、手写 owner）重启后也不会让陌生条目当主人，且不抛", () => {
  const clean = { ada: ADA };
  const first = regBrain(() => clean, () => 1);
  const poisoned = { ada: ADA, evil: { name: "evil", privacy: "owner", senders: ["evil"], allowedScripts: { constructor: ["x"], toString: ["y"] } } };
  const b = regBrain(() => poisoned, () => 2, first.db).brain;   // 同一个 kv：底子里 evil 不存在
  assert.equal(b.currentPeople().identify("evil", undefined)!.privacy, "guest");
  assert.equal(b.currentPeople().identify("g", undefined)!.privacy, "owner");
  assert.equal((b.currentPeople().registry.evil as { allowedScripts?: unknown }).allowedScripts, undefined);
});

test("名单：文件读不了/类型坏了：保留上一份、不抛、同一版只警告一次；fromChannel 照常送到", () => {
  let file: unknown = { ada: ADA };
  let m: number | null = 1;
  const t = regBrain(() => { if (file === "boom") throw new Error("EIO"); return file; }, () => m);
  m = 2; file = { ada: { ...ADA, name: 5, senders: [1], handles: { wx: "mgn" } } };
  assert.doesNotThrow(() => t.brain.currentPeople());
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");   // 主人整条用底子
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "h"), null);
  m = 3; file = "boom";
  const before = t.logs.length;
  t.brain.currentPeople(); t.brain.currentPeople(); t.brain.currentPeople();
  assert.equal(t.logs.slice(before).filter((l) => /keeping current/.test(l.msg)).length, 1);
  m = null;
  assert.doesNotThrow(() => t.brain.fromChannel({ channel: "qqbot", text: "在吗", senderId: "g", messageId: "mm1" }));
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
});

test("名单：handles 只认字符串数组；坏的 People 构造不抛", () => {
  const p = new PeopleG({ ada: { name: "ada", privacy: "owner", handles: { wx: "mgn", xhs: ["ok", 5] } }, b: { name: 7, senders: "abc" } });
  assert.equal(p.identifyHandle("wx", "h"), null);
  assert.equal(p.identifyHandle("xhs", "ok")!.person.key, "ada");
  assert.equal(p.identify("a", undefined), null);
  assert.ok(p.issues.length >= 3);
});

test("名单：底子只种一次，重启（同一个 kv）不重种；坏了按文件重种并记一笔", () => {
  const a = regBrain(() => ({ ada: ADA, x: { name: "x", privacy: "guest", trust: "trusted" } }), () => 1);
  const base1 = kvGetU(a.db, "registry_approved")!;
  // 重启：文件里 x 多了 shared，底子不变（不会重种）
  const b = regBrain(() => ({ ada: ADA, x: { name: "x", privacy: "guest", trust: "trusted", shared: ["a"] } }), () => 2, a.db);
  assert.equal(kvGetU(b.db, "registry_approved"), base1);
  assert.equal((b.brain.currentPeople().registry.x as { shared?: unknown }).shared, undefined);
  // 再重启：已经报过的不再记
  const n1 = (JSON.parse(kvGetU(b.db, "registry_changes")!) as unknown[]).length;
  regBrain(() => ({ ada: ADA, x: { name: "x", privacy: "guest", trust: "trusted", shared: ["a"] } }), () => 3, a.db);
  assert.equal((JSON.parse(kvGetU(b.db, "registry_changes")!) as unknown[]).length, n1);
  // 底子坏了
  b.db.prepare("UPDATE kv SET v = ? WHERE k = ?").run("{not json", "registry_approved");
  assert.throws(() => b.brain.approvePerson("x"), /底子/);
  const c = regBrain(() => ({ ada: ADA }), () => 4, a.db);
  assert.equal(c.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
  assert.match(kvGetU(c.db, "registry_changes")!, /批准底子坏了/);
  JSON.parse(kvGetU(c.db, "registry_approved")!);
});

test("名单：文件第一次启动时不在，之后出现也能种底子", () => {
  let f: unknown = null; let m: number | null = null;
  const t = regBrain(() => { if (f === null) throw new Error("ENOENT"); return f; }, () => m);
  assert.equal(kvGetU(t.db, "registry_approved"), undefined);
  f = { ada: ADA }; m = 5;
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
  assert.ok(kvGetU(t.db, "registry_approved"));
});

test("hh people approve：控制命令批准并记一笔；不能批出新主人；CLI 只认 approve", async () => {
  const { handle, peopleRequest } = await import("../src/control.ts");
  let file: Record<string, unknown> = { ada: ADA, x: { name: "x", privacy: "guest" } };
  let m = 1;
  const t = regBrain(() => file, () => m);
  m = 2; file = { ada: ADA, x: { name: "x", privacy: "guest", trust: "trusted" }, boss: { name: "b", privacy: "owner", senders: ["b"] } };
  const r = await handle(t.brain, peopleRequest(["approve", "x"])) as { ok: boolean; approved: Record<string, unknown> };
  assert.equal(r.approved.trust, "trusted");
  assert.equal((t.brain.currentPeople().registry.x as { trust?: string }).trust, "trusted");
  assert.match(kvGetU(t.db, "registry_changes")!, /批准了 x 的权限：privacy、trust/);
  await assert.rejects(handle(t.brain, peopleRequest(["approve", "boss"])), /不能靠 approve/);
  assert.equal(t.brain.currentPeople().identify("b", undefined)!.privacy, "guest");
  await assert.rejects(handle(t.brain, peopleRequest(["approve", "nobody"])), /没有 nobody/);
  assert.throws(() => peopleRequest(["add", "x"]), /用法/);
  assert.throws(() => peopleRequest(["approve"]), /用法/);
});

test("hh people approve 主人（final review M5）：文件里不是 owner 就不批（不降级）；批了照写改了什么", () => {
  let file: Record<string, unknown> = { ada: ADA };
  let m = 1;
  const t = regBrain(() => file, () => m);
  m = 2; file = { ada: { ...ADA, privacy: "guest" } };
  assert.throws(() => t.brain.approvePerson("ada"), /不会把主人降级/);
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
  assert.equal((JSON.parse(kvGetU(t.db, "registry_approved")!) as Record<string, { privacy: string }>).ada!.privacy, "owner");
  m = 3; file = { ada: { ...ADA, senders: ["g", "+6155500023"] } };
  t.brain.approvePerson("ada");
  const line = (JSON.parse(kvGetU(t.db, "registry_changes")!) as Array<{ line: string }>).at(-1)!.line;
  assert.equal(line, "批准了主人 ada 的整条：senders +6155500023（加）", "多出来的号照写出来，不悄悄加");
  assert.equal(t.brain.currentPeople().identify("+6155500023", undefined)!.privacy, "owner");
  t.brain.approvePerson("ada");
  assert.equal((JSON.parse(kvGetU(t.db, "registry_changes")!) as Array<{ line: string }>).at(-1)!.line, "批准了主人 ada 的整条：没有变化");
});

// ---------- 内核一次性调用 + gate probe ----------
import { FakeDriver as FakeDriverAsk } from "../src/kernel/fake.ts";

const askOpts = (prompt: string) => ({ model: "m", system: "s", prompt, cwd: "/tmp", timeoutMs: 1000 });

test("FakeDriver.ask records and answers", async () => {
  const d = new FakeDriverAsk();
  d.answerAsk((o) => `re:${o.prompt}`);
  const r = await d.ask(askOpts("好"));
  assert.equal(r.text, "re:好");
  assert.equal(d.asks.length, 1);
  assert.equal(d.asks[0]!.system, "s");
  assert.deepEqual(r.usage, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
});

test("FakeDriver.ask throws scripted Error", async () => {
  const d = new FakeDriverAsk();
  d.answerAsk(() => new Error("boom"));
  await assert.rejects(d.ask(askOpts("x")), /boom/);
  assert.equal(d.asks.length, 1);
});

test("gateProbe：三次调用，卡片拼人格文件 + 中期记忆，用 haiku", async () => {
  const files: Record<string, string> = {
    "/tmp/hh-test-ws/soul/10-来历.md": "来历文",
    "/tmp/hh-test-ws/soul/20-性格.md": "性格文",
    "/tmp/hh-test-state/exports/midterm.md": "中期文",
  };
  const t = makeBrainG({}, undefined, { readText: (p) => files[p] ?? null });
  let n = 0;
  (t.driver as FakeDriverAsk).answerAsk(() => "好");
  (t.driver as FakeDriverAsk).askUsage = () => ({ input: ++n, cacheRead: 0, cacheWrite: 0, output: 1 });
  const r = await t.brain.gateProbe();
  const asks = (t.driver as FakeDriverAsk).asks;
  assert.equal(asks.length, 3);
  assert.equal(asks[0]!.system, "只回一个字。");
  for (const a of asks.slice(1)) {
    assert.equal(a.model, t.cfg.models.haiku);
    assert.equal(a.prompt, "好");
    for (const w of ["来历文", "性格文", "中期文"]) assert.ok(a.system.includes(w));
  }
  assert.equal(asks[1]!.system, asks[2]!.system);
  assert.equal(r.tiny.input, 1);
  assert.equal(r.card2.input, 3);
  assert.equal(r.cardChars, asks[1]!.system.length);
});

test("gateProbe：驱动没有 ask 就报清楚的错", async () => {
  const t = makeBrainG();
  (t.driver as unknown as { ask?: unknown }).ask = undefined;
  await assert.rejects(t.brain.gateProbe(), /ask/);
});

// ---------- 她的工具：people_i_know（认识的人名单） ----------
import { registryFileOf as regFileOf } from "../src/persona/people.ts";
import { createHash } from "node:crypto";

/** 真目录当工作区。名单文件的 mtime 钉死：加完马上认得只能靠工具自己重载（不靠 mtime 变了自动重读） */
function peopleBrain(reg: Record<string, unknown>) {
  const ws = tmpDir("hh-people-tool-");
  md(pj(ws, "memory/people"), { recursive: true });
  const path = pj(ws, "memory/people/registry.json");
  wf(path, JSON.stringify(reg, null, 2));
  const real = regFileOf(ws);
  const t = makeBrainG({ workspace: ws }, undefined, { registryFile: { mtime: () => 1, read: () => real.read() } });
  t.brain.wakeRegion("main", "x");
  const tool = t.driver.latest("main").spec.tools.find((x) => x.name === "people_i_know")!;
  assert.ok(tool, "main 有 people_i_know");
  const raw = () => rf(path, "utf8");
  const file = () => JSON.parse(raw()) as Record<string, Record<string, unknown>>;
  const gits = () => t.runs.filter((r) => r.cmd === "git").map((r) => r.args.join(" "));
  const changes = () => (JSON.parse(kvGetU(t.db, "registry_changes") ?? "[]") as Array<{ line: string }>).map((x) => x.line);
  return { ...t, ws, path, tool, raw, file, gits, changes };
}
// 小贝：主人批过、超出砚那一级（升过权）的人
const XIAOBEI = {
  name: "小贝", privacy: "guest", trust: "trusted", shared: ["a.md"], sharedThreads: ["t1"],
  allowedScripts: { "scripts/relay.py": ["send"], "scripts/cast.py": ["play"] }, senders: ["+6155500011"], handles: { wx: ["小贝"], xhs: ["朵朵xhs"] },
};

test("people_i_know caps trust and says ask ada", async () => {
  const t = peopleBrain({ _说明: "认人用", ada: ADA, xiaobei: XIAOBEI });
  const out = await t.tool.handler({ action: "add", key: "amy", entry: { name: "Amy", privacy: "guest", trust: "trusted", shared: ["notes.md"], allowedScripts: { "scripts/relay.py": ["send"] }, handles: { wx: ["Amy W"] } } });
  assert.match(out, /这个要问 ada：trust、shared/);
  assert.deepEqual(t.file().amy, { name: "Amy", privacy: "guest", allowedScripts: { "scripts/relay.py": ["send"] }, handles: { wx: ["Amy W"] } });
  assert.equal((t.file() as Record<string, unknown>)._说明, "认人用");   // 别的内容原样
  assert.ok(!t.raw().endsWith("\n"), "照她文件原来的样子：两格缩进、结尾不加换行");
  assert.equal(t.gits().length, 2);
  assert.equal(t.gits()[0], `-C ${t.ws} add memory/people/registry.json`);
  assert.ok(t.gits()[1]!.startsWith(`-C ${t.ws} commit -m 名单：加了 Amy（微信：Amy W）`) && t.gits()[1]!.endsWith(" -- memory/people/registry.json"), t.gits()[1]);
  assert.match(t.changes().at(-1)!, /^加了 Amy（微信：Amy W）/);
  assert.equal((t.brain.currentPeople().registry.amy as { trust?: string }).trust, undefined);
  // update：改成别的 privacy、给别的脚本 → 裁掉，原来的留着；身份字段照写
  const up = await t.tool.handler({ action: "update", key: "amy", entry: { privacy: "friend", allowedScripts: { "scripts/cast.py": ["play"] }, profile: "ada 的同学" } });
  assert.match(up, /这个要问 ada：privacy、allowedScripts/);
  assert.equal(t.file().amy!.privacy, "guest");
  assert.equal(t.file().amy!.profile, "ada 的同学");
  assert.deepEqual(t.file().amy!.allowedScripts, { "scripts/relay.py": ["send"] });
  assert.match(t.changes().at(-1)!, /^改了 Amy/);
  // 小贝的 trust 是主人批过的：照写不算越权；删号、删一个平台的显示名（null）、改别的字段都行
  const same = await t.tool.handler({ action: "update", key: "xiaobei", entry: { trust: "trusted", handles: { wx: null }, senders: null, profile: "ada 的表妹" } });
  assert.doesNotMatch(same, /要问 ada/);
  const { senders: _s, handles: _h, ...rest } = XIAOBEI;
  assert.deepEqual(t.file().xiaobei, { ...rest, handles: { xhs: ["朵朵xhs"] }, profile: "ada 的表妹" });
  // 只记真变了的，号和显示名写出加了哪个、删了哪个
  assert.equal(t.changes().at(-1), "改了 小贝：senders +6155500011（删）；handles.wx 小贝（删）；profile ada 的表妹");
  // 没升过权的人：handles 按平台合并；加号照写，记下加的是哪个号
  await t.tool.handler({ action: "update", key: "amy", entry: { handles: { xhs: ["amy_xhs"] }, senders: ["+6155500023"] } });
  assert.deepEqual(t.file().amy!.handles, { wx: ["Amy W"], xhs: ["amy_xhs"] });
  assert.equal(t.changes().at(-1), "改了 Amy：handles.xhs amy_xhs（加）；senders +6155500023（加）");
  const n = t.gits().length;
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { trust: "trusted" } }), /和原来一样/);
  assert.match(await t.tool.handler({ action: "update", key: "amy", entry: { trust: "trusted" } }), /没改：这个要问 ada：trust/);
  assert.equal(t.gits().length, n);   // 没变就不写、不提交
  // 谁都不能写成 owner（直接拒绝，不是裁）
  assert.match(await t.tool.handler({ action: "add", key: "boss", entry: { name: "Boss", privacy: "owner" } }), /owner/);
  assert.match(await t.tool.handler({ action: "update", key: "amy", entry: { privacy: "owner" } }), /owner/);
  assert.equal(t.file().boss, undefined);
  assert.equal(t.file().amy!.privacy, "guest");
  // 字段类型不对的不写
  assert.match(await t.tool.handler({ action: "add", entry: { name: "坏", handles: { wx: "一个字符串" } } }), /handles\.wx/);
  assert.match(await t.tool.handler({ action: "add", entry: { name: "坏", handles: { qq: ["x"] } } }), /wx \/ xhs \/ bili/);
  assert.match(await t.tool.handler({ action: "add", key: "_x", entry: { name: "x" } }), /key/);
  assert.match(await t.tool.handler({ action: "add", entry: { handles: { wx: ["无名"] } } }), /name/);
  assert.match(await t.tool.handler({ action: "update", key: "nobody", entry: { name: "x" } }), /没有 nobody/);
  // list：现在生效的名单
  const list = await t.tool.handler({ action: "list" });
  assert.match(list, /^ada：ada（owner，改不了）/m);
  assert.match(list, /^xiaobei：小贝（guest，trusted）小红书：朵朵xhs$/m);
  assert.match(list, /^amy：Amy（guest）微信：Amy W；小红书：amy_xhs；号：\+6155500023$/m);
});

test("people_i_know refuses ada entry", async () => {
  const t = peopleBrain({ ada: ADA, xiaobei: XIAOBEI });
  const before = t.raw();
  for (const a of [
    { action: "update", key: "ada", entry: { handles: { wx: ["新名字"] } } },
    { action: "remove", key: "ada" },
    { action: "add", key: "ada", entry: { name: "ada2" } },
  ]) assert.match(await t.tool.handler(a), /ada 那条.*不能动/, JSON.stringify(a));
  assert.equal(t.raw(), before);
  assert.deepEqual(t.gits(), []);
  // 普通人可以删；删了就不认得了
  const rm = await t.tool.handler({ action: "remove", key: "xiaobei" });
  assert.match(rm, /删了 小贝/);
  assert.equal(t.file().xiaobei, undefined);
  assert.equal(t.brain.currentPeople().identify("+6155500011", undefined), null);
  assert.match(t.changes().at(-1)!, /^删了 小贝（xiaobei）/);
  assert.match(await t.tool.handler({ action: "remove", key: "xiaobei" }), /没有 xiaobei/);
  // 文件里主人那条被手改删掉了：底子里的主人还是不能动（不能拿这个 key 加一个新的）
  wf(t.path, JSON.stringify({}, null, 2));
  assert.match(await t.tool.handler({ action: "add", key: "ada", entry: { name: "冒充的" } }), /ada 那条.*不能动/);
  assert.equal(t.raw(), "{}");
});

test("added person is recognised immediately", async () => {
  const t = peopleBrain({ ada: ADA });
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "阿美"), null);
  const out = await t.tool.handler({ action: "add", entry: { name: "Amy Wu", handles: { wx: ["阿美"], xhs: ["amy_xhs"] } } });
  assert.match(out, /amywu/);
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "阿美")!.person.key, "amywu");
  assert.equal(t.brain.currentPeople().identifyHandle("xhs", "amy_xhs")!.person.name, "Amy Wu");
  assert.equal(t.file().amywu!.privacy, "guest");
  // 名字不全是英文字母数字：key 用名字的 sha1
  await t.tool.handler({ action: "add", entry: { name: "小明", handles: { wx: ["小明"] } } });
  const key = "p" + createHash("sha1").update("小明").digest("hex").slice(0, 6);
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "小明")!.person.key, key);
  assert.match(await t.tool.handler({ action: "add", entry: { name: "小明" } }), /已经有/);
  // 闸门：她私聊马上直达
  t.brain.fromSenses("", [{ src: "wx", id: "dm1", text: "阿美：在吗", conv: "阿美", sender: "阿美", isGroup: false }]);
  assert.deepEqual(allRows<{ route: string }>(t.db, "SELECT route FROM gate_log WHERE ev_id = 'dm1'").map((r) => r.route), ["fixed-main"]);
});

// ---------- Ruling 16：名单的几处加固 ----------
test("名单：JSON 写坏了 hhd 启动不崩：People.loadOr 给空名单，Brain 的保底从底子认出主人（ruling 16a）", () => {
  const ws = tmpDir("hh-reg-bad-");
  md(pj(ws, "memory/people"), { recursive: true });
  wf(pj(ws, "memory/people/registry.json"), "{ 坏了");
  assert.throws(() => PeopleG.load(ws));
  const errs: unknown[] = [];
  const p = PeopleG.loadOr(ws, (e) => errs.push(e));
  assert.equal(p.identify("g", undefined), null);
  assert.equal(errs.length, 1);
  assert.match(rf(new URL("../src/hhd.ts", import.meta.url), "utf8"), /people: People\.loadOr\(cfg\.workspace/);
  // 底子种过以后文件坏了：启动时保底，主人从底子补回来
  const first = regBrain(() => ({ ada: ADA }), () => 1);
  const t = regBrain(() => { throw new SyntaxError("Unexpected token"); }, () => 2, first.db);
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
});

test("名单：owner 的号、会话、名字、显示名，后面的条目抢不走（ruling 16b）", () => {
  const p = new PeopleG({
    ada: { name: "ada", privacy: "owner", senders: ["g", "+6155500015"], sessionKeys: ["agent:main:main"], handles: { wx: ["mgn"], xhs: ["mgn"] } },
    evil: { name: "ada", privacy: "guest", senders: ["g", "+6155500016"], sessionKeys: ["agent:main:main"], handles: { wx: ["mgn"], xhs: ["mgn"] } },
    ada2: { name: "Ada", privacy: "guest", senders: ["+6155500017"] },
  });
  assert.equal(p.identify("g", undefined)!.key, "ada");
  assert.equal(p.identify(undefined, "agent:main:main")!.key, "ada");
  assert.equal(p.identifyHandle("wx", "mgn")!.person.key, "ada");
  assert.equal(p.identifyHandle("xhs", "mgn")!.person.key, "ada");
  assert.equal(p.targetFor("ada", "whatsapp"), "+6155500015");
  assert.equal(p.targetFor("evil", "whatsapp"), "+6155500016");   // 别人自己的照样能找
  // 别人之间照旧：后写的算
  const q = new PeopleG({ a: { name: "a", senders: ["s"] }, b: { name: "b", senders: ["s"] } });
  assert.equal(q.identify("s", undefined)!.key, "b");
});

test("applyApproved：底子里的主人在文件里被删了、改名了、不是对象：从底子补回来（ruling 16c）", () => {
  const base = approvedFrom({ ada: ADA, x: { name: "x", privacy: "guest" } });
  const x = { name: "x", privacy: "guest" };
  for (const reg of [{ x }, { ada: "坏了", x }, { ada: null, x }, { ada: [ADA], x }, { boss: { ...ADA, name: "boss" }, x }]) {
    const r = applyApproved(reg as Record<string, unknown>, base).registry as Record<string, Record<string, unknown>>;
    assert.deepEqual(r.ada, ADA, JSON.stringify(reg));
    assert.deepEqual(r.x, x);
    if ("boss" in reg) assert.equal(r.boss!.privacy, "guest");
  }
  // Brain：文件里主人那条没了也照样认得
  let file: Record<string, unknown> = { ada: ADA, x };
  let m = 1;
  const t = regBrain(() => file, () => m);
  m = 2; file = { x, boss: { ...ADA, name: "boss" } };
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.key, "ada");
  assert.equal(t.brain.currentPeople().identify("g", undefined)!.privacy, "owner");
});

test("控制面：server 端也核 people / gate 的动作（ruling 16d）", async () => {
  const { handle } = await import("../src/control.ts");
  const t = makeBrainG();
  await assert.rejects(handle(t.brain, { cmd: "people", action: "nuke", key: "x" } as never), /用法：people approve <key>/);
  await assert.rejects(handle(t.brain, { cmd: "people", action: "approve" } as never), /用法：people approve <key>/);
  await assert.rejects(handle(t.brain, { cmd: "gate", action: "bogus" } as never), /用法：gate probe/);
  await assert.rejects(handle(t.brain, { cmd: "gate", action: "replay", from: 1 } as never), /用法：gate probe/);
});

// ---------- fix round 1：升过权的人的号要批（ruling 38/39）、撞名撞号（ruling 40）、几处小的 ----------
const XIAOBEI_NEW = "+6155500023";   // 陌生人的号

test("people_i_know: 给升过权的人加号、加显示名要问 ada；删号、改别的照改（ruling 39，A1）", async () => {
  const t = peopleBrain({ ada: ADA, xiaobei: XIAOBEI });
  const before = t.raw();
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { senders: [...XIAOBEI.senders, XIAOBEI_NEW] } }),
    /没改：这个要问 ada：给 小贝 加号\/加名字（senders \+6155500023）/);
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { handles: { wx: ["陌生人"] } } }),
    /这个要问 ada：给 小贝 加号\/加名字（handles\.wx 陌生人）/);
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { sessionKeys: ["agent:guest:x"] } }), /加号\/加名字（sessionKeys agent:guest:x）/);
  assert.equal(t.raw(), before);
  assert.deepEqual(t.gits(), []);
  assert.equal(t.brain.currentPeople().identify(XIAOBEI_NEW, undefined), null);
  // 删掉批过的号再加回来：底子里有，不用再批
  await t.tool.handler({ action: "update", key: "xiaobei", entry: { senders: [] } });
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { senders: ["+6155500011"] } }), /改好了 xiaobei：senders \+6155500011（加）/);
  assert.equal(t.brain.currentPeople().identify("+6155500011", undefined)!.trust, "trusted");
});

test("名单：手改给升过权的人加了没批过的号 → 她的权限按砚那一级、总结写出是哪个号；approve 连号一起记（ruling 38，A3）", () => {
  let file: Record<string, unknown> = { ada: ADA, xiaobei: XIAOBEI };
  let m = 1;
  const t = regBrain(() => file, () => m);
  assert.equal(t.brain.currentPeople().identify("+6155500011", undefined)!.trust, "trusted");
  const withNew = { ...XIAOBEI, senders: [...XIAOBEI.senders, XIAOBEI_NEW] };
  m = 2; file = { ada: ADA, xiaobei: withNew };
  const who = t.brain.currentPeople().identify(XIAOBEI_NEW, undefined)!;
  assert.equal(who.key, "xiaobei");
  assert.equal(who.trust, undefined);
  const eff = t.brain.currentPeople().registry.xiaobei as Record<string, unknown>;
  assert.deepEqual([eff.trust, eff.shared, eff.sharedThreads, eff.allowedScripts], [undefined, undefined, undefined, { "scripts/relay.py": ["send"] }]);
  const line = (JSON.parse(kvGetU(t.db, "registry_changes")!) as Array<{ line: string }>).at(-1)!.line;
  assert.match(line, /xiaobei\.trust/);
  assert.match(line, /xiaobei senders \+6155500023/);
  assert.match(line, /hh people approve/);
  // 删号不算：批过的号都还在、没多的 → 照旧
  m = 3; file = { ada: ADA, xiaobei: { ...XIAOBEI, senders: [] } };
  assert.equal((t.brain.currentPeople().registry.xiaobei as { trust?: string }).trust, "trusted");
  // 主人 approve：现在的号和显示名一起记进底子，放行；再多一个又关
  m = 4; file = { ada: ADA, xiaobei: withNew };
  t.brain.approvePerson("xiaobei");
  assert.equal(t.brain.currentPeople().identify(XIAOBEI_NEW, undefined)!.trust, "trusted");
  const base = JSON.parse(kvGetU(t.db, "registry_approved")!) as Record<string, { identity: { senders: string[] } }>;
  assert.deepEqual(base.xiaobei!.identity.senders, ["+6155500011", XIAOBEI_NEW]);
  assert.match((JSON.parse(kvGetU(t.db, "registry_changes")!) as Array<{ line: string }>).at(-1)!.line, /批准了 xiaobei 的权限：privacy、trust、shared、sharedThreads、allowedScripts（号和显示名也照现在的记下了）/);
  m = 5; file = { ada: ADA, xiaobei: { ...withNew, handles: { ...XIAOBEI.handles, wx: ["小贝", "陌生人"] } } };
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "陌生人")!.person.trust, undefined);
  assert.equal(t.brain.currentPeople().identify("+6155500011", undefined)!.trust, undefined);
});

test("people_i_know: 删了小贝再用同一个 key（或起出同一个 key 的名字）加回来，拿不回她批过的权限（ruling 39，A2 / A2b）", async () => {
  for (const add of [{ key: "xiaobei", entry: { name: "冒充的" } }, { entry: { name: "Xiao Bei" } }]) {
    const t = peopleBrain({ ada: ADA, xiaobei: XIAOBEI });
    assert.match(await t.tool.handler({ action: "remove", key: "xiaobei" }), /删了 小贝/);
    const out = await t.tool.handler({ action: "add", ...add, entry: {
      ...add.entry, senders: [XIAOBEI_NEW], trust: "trusted", shared: ["a.md"], sharedThreads: ["t1"], allowedScripts: { "scripts/relay.py": ["send"], "scripts/cast.py": ["play"] },
    } });
    assert.match(out, /这个要问 ada：trust、shared、sharedThreads、allowedScripts/, JSON.stringify(add));
    assert.match(out, /加好了：xiaobei/);
    const f = t.file().xiaobei!;
    assert.deepEqual([f.trust, f.shared, f.sharedThreads, f.allowedScripts], [undefined, undefined, undefined, { "scripts/relay.py": ["send"] }]);
    assert.equal(t.brain.currentPeople().identify(XIAOBEI_NEW, undefined)!.trust, undefined);
    // 再用 update 把 trust 写回去：她身上的号不是批过的那个 → 只许删号，别的不改
    assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { trust: "trusted" } }), /没改：(冒充的|Xiao Bei) 身上有没批过的号或显示名（senders \+6155500023），先删掉它或者等 ada approve/);
    assert.equal(t.file().xiaobei!.trust, undefined);
    // 手改文件写回去：装的时候也关
    wf(t.path, JSON.stringify({ ...t.file(), xiaobei: { ...t.file().xiaobei, trust: "trusted", shared: ["a.md"] } }, null, 2));
    t.brain.reloadPeople();
    const eff = t.brain.currentPeople().registry.xiaobei as Record<string, unknown>;
    assert.deepEqual([eff.trust, eff.shared], [undefined, undefined]);
  }
});

test("people_i_know: 名字、key、号、会话、显示名已经是别人的，不加不改（ruling 40）", async () => {
  const t = peopleBrain({ ada: ADA, xiaobei: XIAOBEI, amy: { name: "Amy", privacy: "guest", handles: { wx: ["Amy W"] } } });
  const before = t.raw();
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ action: "add", entry: { name: "小贝", handles: { wx: ["小贝"] } } }, /没加：名字「小贝」和名单里的 小贝（xiaobei）撞了/],
    [{ action: "add", key: "XiaoBei", entry: { name: "别人" } }, /名字「XiaoBei」和名单里的 小贝（xiaobei）撞了/],
    [{ action: "add", key: "en2", entry: { name: "Xiao-Bei" } }, /名字「Xiao-Bei」和名单里的 小贝（xiaobei）撞了/],   // 起出来是 xiaobei
    [{ action: "add", entry: { name: "新人", senders: ["6155500011"] } }, /senders 6155500011 已经是 小贝（xiaobei）的了/],   // 带不带 + 算同一个
    [{ action: "add", entry: { name: "新人", handles: { wx: [" 小贝 "] } } }, /handles\.wx\s+小贝\s+已经是 小贝（xiaobei）的了/],
    [{ action: "add", entry: { name: "新人", handles: { xhs: ["朵朵XHS"] } } }, /已经是 小贝（xiaobei）的了/],
    [{ action: "add", entry: { name: "新人", senders: ["G"] } }, /senders G 已经是 ada（ada）的了/],
    [{ action: "add", entry: { name: "新人", sessionKeys: ["AGENT:MAIN:MAIN"] } }, /已经是 ada（ada）的了/],
    [{ action: "update", key: "amy", entry: { name: "小贝" } }, /没改：名字「小贝」和名单里的 小贝（xiaobei）撞了/],
    [{ action: "update", key: "amy", entry: { handles: { wx: ["Amy W", "小贝"] } } }, /handles\.wx 小贝 已经是 小贝（xiaobei）的了/],
  ];
  for (const [a, re] of cases) assert.match(await t.tool.handler(a), re, JSON.stringify(a));
  assert.equal(t.raw(), before);
  assert.deepEqual(t.gits(), []);
  // 真的小贝还是她
  assert.equal(t.brain.currentPeople().targetFor("小贝", "whatsapp"), "+6155500011");
  assert.equal(t.brain.currentPeople().identifyHandle("wx", "小贝")!.person.key, "xiaobei");
  // 不撞的照加；改自己原有的不算撞
  assert.match(await t.tool.handler({ action: "add", entry: { name: "新人", handles: { wx: ["新人"] } } }), /加好了/);
  assert.match(await t.tool.handler({ action: "update", key: "amy", entry: { name: "Amy", profile: "同学" } }), /改好了 amy/);
});

test("名单：上线前的底子没记号：第一次装按现在的文件记一次、不裁；之后多出来的才裁（ruling 38 迁移）", () => {
  const first = regBrain(() => ({ ada: ADA, xiaobei: XIAOBEI }), () => 1);
  // 改回老样子的底子：小贝只有权限字段
  const old = JSON.parse(kvGetU(first.db, "registry_approved")!) as Record<string, Record<string, unknown>>;
  assert.ok(old.xiaobei!.identity, "新种的底子带着认人字段");
  delete old.xiaobei!.identity;
  first.db.prepare("UPDATE kv SET v = ? WHERE k = ?").run(JSON.stringify(old), "registry_approved");
  let file: Record<string, unknown> = { ada: ADA, xiaobei: XIAOBEI };
  let m = 2;
  const t = regBrain(() => file, () => m, first.db);
  assert.equal(t.brain.currentPeople().identify("+6155500011", undefined)!.trust, "trusted");   // 第一次不裁
  const base = JSON.parse(kvGetU(t.db, "registry_approved")!) as Record<string, { identity: Record<string, unknown> }>;
  assert.deepEqual(base.xiaobei!.identity, { senders: ["+6155500011"], sessionKeys: [], handles: { wx: ["小贝"], xhs: ["朵朵xhs"] } });
  const stored = () => t.logs.filter((l) => /stored approved identity/.test(l.msg)).length;
  assert.equal(stored(), 1);
  m = 3; t.brain.currentPeople();
  assert.equal(stored(), 1);   // 只记一次
  m = 4; file = { ada: ADA, xiaobei: { ...XIAOBEI, senders: [...XIAOBEI.senders, XIAOBEI_NEW] } };
  assert.equal(t.brain.currentPeople().identify(XIAOBEI_NEW, undefined)!.trust, undefined);
  // 没升过权的人不记、也不查
  assert.equal("identity" in (base.ada as object), false);
});

test("名单：主人的号带不带 + 都是主人的，别人写另一种写法抢不走（minor 2）", () => {
  for (const [mine, theirs] of [["+6155500010", "6155500010"], ["6155500010", "+6155500010"]]) {
    const p = new PeopleG({ ada: { name: "ada", privacy: "owner", senders: [mine] }, evil: { name: "e", privacy: "guest", senders: [theirs] } });
    assert.equal(p.identify("6155500010", undefined)!.key, "ada");
    assert.equal(p.identify("+6155500010", undefined)!.key, "ada");
  }
  const q = new PeopleG({ a: { name: "a", senders: ["+614"] } });
  assert.equal(q.identify("614", undefined)!.key, "a");
  assert.equal(q.identify(" +614 ", undefined)!.key, "a");
});

// ---------- fix round 2 ----------
test("people_i_know: 身上有没批过的号时只许删号；删掉以后权限原样留在文件里，ada approve 也不丢（fix round 2）", async () => {
  const handAdded = { ada: ADA, xiaobei: { ...XIAOBEI, senders: [...XIAOBEI.senders, XIAOBEI_NEW] } };
  // 一：主人手改给小贝加了个号，她用工具改别的 → 不改；主人照总结说的 approve，权限都还在
  const a = peopleBrain({ ada: ADA, xiaobei: XIAOBEI });
  wf(a.path, JSON.stringify(handAdded, null, 2));
  const before = a.raw();
  assert.match(await a.tool.handler({ action: "update", key: "xiaobei", entry: { profile: "表妹" } }),
    /^没改：小贝 身上有没批过的号或显示名（senders \+6155500023），先删掉它或者等 ada approve。$/);
  // 删号时夹带别的、或者删一个加一个，也不行
  assert.match(await a.tool.handler({ action: "update", key: "xiaobei", entry: { senders: XIAOBEI.senders, profile: "表妹" } }), /身上有没批过的号/);
  assert.match(await a.tool.handler({ action: "update", key: "xiaobei", entry: { senders: ["+6155500011", "+6155500018"] } }), /身上有没批过的号/);
  assert.equal(a.raw(), before);
  assert.deepEqual(a.gits(), []);
  a.brain.approvePerson("xiaobei");
  const who = a.brain.currentPeople().identify(XIAOBEI_NEW, undefined)!;
  assert.deepEqual([who.key, who.trust], ["xiaobei", "trusted"]);
  const baseA = JSON.parse(kvGetU(a.db, "registry_approved")!).xiaobei as Record<string, unknown>;
  assert.deepEqual([baseA.trust, baseA.shared, baseA.sharedThreads, baseA.allowedScripts], [XIAOBEI.trust, XIAOBEI.shared, XIAOBEI.sharedThreads, XIAOBEI.allowedScripts]);

  // 二：她把那个号删掉 → 可以；文件里的权限原样，approve 以后也还在
  const b = peopleBrain({ ada: ADA, xiaobei: XIAOBEI });
  wf(b.path, JSON.stringify(handAdded, null, 2));
  assert.match(await b.tool.handler({ action: "update", key: "xiaobei", entry: { senders: XIAOBEI.senders } }), /^改好了 xiaobei：senders \+6155500023（删）。/);
  const f = b.file().xiaobei!;
  assert.deepEqual([f.trust, f.shared, f.sharedThreads, f.allowedScripts], [XIAOBEI.trust, XIAOBEI.shared, XIAOBEI.sharedThreads, XIAOBEI.allowedScripts]);
  assert.equal(b.brain.currentPeople().identify("+6155500011", undefined)!.trust, "trusted");
  assert.equal(b.brain.currentPeople().identify(XIAOBEI_NEW, undefined), null);
  b.brain.approvePerson("xiaobei");
  assert.equal(b.brain.currentPeople().identify("+6155500011", undefined)!.trust, "trusted");
  assert.equal((JSON.parse(kvGetU(b.db, "registry_approved")!).xiaobei as Record<string, unknown>).trust, "trusted");
});

test("people_i_know: 主人的号被手改从文件里删了，别人也认领不走（按底子比，fix round 2）", async () => {
  const G2 = { ...ADA, senders: ["g", "+6155500010"] };
  const t = peopleBrain({ ada: G2, xiaobei: XIAOBEI });
  wf(t.path, JSON.stringify({ ada: { ...G2, senders: ["g"] }, xiaobei: XIAOBEI }, null, 2));
  assert.match(await t.tool.handler({ action: "add", entry: { name: "Zed", senders: ["+6155500010"] } }), /^没加：senders \+6155500010 已经是 ada（ada）的了。$/);
  assert.match(await t.tool.handler({ action: "update", key: "xiaobei", entry: { senders: [] } }), /改好了/);   // 别人自己的照改
  assert.match(await t.tool.handler({ action: "add", entry: { name: "Zed", senders: ["6155500010"] } }), /已经是 ada（ada）的了/);
  assert.equal(t.file().zed, undefined);
});

import { CentralMemory as CM, SYNC_ACT_CHARS } from "../src/memory/central.ts";
import { openDb as openDbV } from "../src/store/db.ts";
test("viewTokens（ada 11-04：翻页按她眼前的上下文算）：她自己的照原样；别人的工具结果折成一行、动作截到 300 字、别的截到 maxItemChars；看不见的内部过程不算", () => {
  const c = new CM(openDbV(":memory:"), () => 0);
  const big = "长".repeat(5000);
  const own = c.append(1, "main", "result", big, { id: "a" });
  assert.equal(c.viewTokens(1, "main", { maxItemChars: 1500 }), own.tokens, "她自己的结果在她自己的会话里是原样");
  c.append(1, "side-1", "result", big, { id: "b" });
  const afterSideResult = c.viewTokens(1, "main", { maxItemChars: 1500 });
  assert.ok(afterSideResult - own.tokens <= 12, "别人的工具结果只算一行");
  const act = c.append(1, "side-1", "act", `Bash ${"x".repeat(3000)}`, { tool: "Bash", id: "c" });
  const withAct = c.viewTokens(1, "main", { maxItemChars: 1500 });
  assert.ok(withAct - afterSideResult <= Math.ceil(act.tokens * SYNC_ACT_CHARS / act.text.length) && withAct - afterSideResult > 0);
  const said = c.append(1, "side-1", "say", "话".repeat(4000));
  const withSay = c.viewTokens(1, "main", { maxItemChars: 1500 });
  assert.equal(withSay - withAct, Math.ceil(said.tokens * 1500 / 4000), "别的截到 maxItemChars");
  c.append(1, "perception-messages", "think", big, { inner: true });
  assert.equal(c.viewTokens(1, "main", { maxItemChars: 1500 }), withSay, "下意识自己的过程她看不见");
  c.append(1, "外界", "input", "感官原文", { inner: true, for: "main" });
  assert.ok(c.viewTokens(1, "main", { maxItemChars: 1500 }) > withSay, "给她看的照算");
  assert.ok(c.pageTokens(1) > c.viewTokens(1, "main", { maxItemChars: 1500 }) * 2, "原文合计比她眼前大得多");
  assert.equal(c.viewTokens(1, "main", { maxItemChars: 1500, afterSeq: own.seq }), c.viewTokens(1, "main", { maxItemChars: 1500 }) - own.tokens, "afterSeq：只算那条以后的");
});

import { renderMemory as rmV } from "../src/memory/central.ts";
test("renderMemory sync + fullFor：这个脑区自己的动作和结果照原样，别的脑区的折起来（翻页压缩用，11-04）", () => {
  const e = (seq: number, src: string, kind: "act" | "result" | "say", text: string, meta: Record<string, unknown> | null = null) => ({ seq, ts: 0, epoch: 1, src, kind, text, tokens: 1, meta });
  const big = "细节".repeat(400);
  const out = rmV([
    e(1, "main", "act", "Read {\"file_path\":\"/a.md\"}", { tool: "Read", id: "m1" }),
    e(2, "main", "result", big, { id: "m1" }),
    e(3, "side-1", "act", "Read {\"file_path\":\"/b.md\"}", { tool: "Read", id: "s1" }),
    e(4, "side-1", "result", big, { id: "s1" }),
    e(5, "side-1", "say", "帮手说的话"),
  ], (src) => (src === "main" ? "" : "（弄X时）"), { maxItemChars: 8000, timezone: "UTC", mode: "sync", fullFor: "main", seqs: true });
  assert.equal(out.split(big).length - 1, 1, "大结果只出现一次（主线自己的那条）");
  assert.match(out, /→ 完成（800 字，#4）/);
  assert.match(out, /帮手说的话/);
});

test("renderMemory sync + thinkChars（ada 11-05）：别人的「想」折成一行、长了截断带编号；自己的、fullFor 的、短的照原样；viewTokens 同一个口径", () => {
  const e = (seq: number, src: string, kind: "think" | "say", text: string) => ({ seq, ts: 0, epoch: 1, src, kind, text, tokens: 1, meta: null });
  const long = "第一段想法\n\n" + "要对上时间".repeat(60);
  const lab = (src: string) => (src === "main" ? "" : "（弄X时）");
  const o = { maxItemChars: 1500, timezone: "UTC", mode: "sync" as const, viewer: "main" };
  const folded = rmV([e(1, "side-1", "think", long), e(2, "side-1", "think", "短的\n两行"), e(3, "side-1", "say", long), e(4, "main", "think", long)], lab, { ...o, thinkChars: 120 });
  const lines = folded.split("\n");
  const sideThink = lines.find((l) => l.includes("（弄X时）想：第一段想法"))!;
  assert.ok(sideThink, "还看得出是哪件事、在想什么");
  assert.match(sideThink, /…（#1）$/, "长了截断、带编号能翻原文");
  assert.ok(sideThink.length < 180, "只占一行、开头那一截");
  assert.ok(lines.some((l) => l.endsWith("（弄X时）想：短的 两行")), "短的也并成一行");
  assert.equal(folded.split("要对上时间".repeat(60)).length - 1, 2, "说的话、她自己的想照原样");
  const plain = rmV([e(1, "side-1", "think", long)], lab, o);
  assert.match(plain, /要对上时间要对上时间/, "不给 thinkChars：照 10-31 原样");
  assert.doesNotMatch(plain, /…（#1）/);
  const forCompact = rmV([e(1, "side-1", "think", long), e(4, "main", "think", long)], lab, { ...o, viewer: undefined, fullFor: "main", thinkChars: 120 });
  assert.equal(forCompact.split("要对上时间".repeat(60)).length - 1, 1, "翻页压缩照主线眼前：主线自己的原样，后台的折起来");

  const c = new CM(openDbV(":memory:"), () => 0);
  const own = c.append(1, "main", "think", "我".repeat(3000));
  const side = c.append(1, "side-1", "think", "想".repeat(3000));
  const unfolded = c.viewTokens(1, "main", { maxItemChars: 1500 });
  const foldedN = c.viewTokens(1, "main", { maxItemChars: 1500, thinkChars: 120 });
  assert.equal(unfolded - own.tokens, Math.ceil(side.tokens * 1500 / 3000));
  assert.equal(foldedN - own.tokens, Math.ceil(side.tokens * 120 / 3000), "估算也按折起来的算；她自己的照原样");
  assert.equal(c.viewTokensAfter(1, "main", [own.seq], { maxItemChars: 1500, thinkChars: 120 }).get(own.seq), foldedN - own.tokens);
});

import { observeQuota, paceLine } from "../src/brainstem/quota.ts";
test("额度速度（ada 11-04：一天用了 20%，70% 那档要第 4 天才响）：照这周的速度比重置早一天以上会用完就报，一天一次；重置那句改成匀着用；没了的 5 小时旧数扔掉", () => {
  const D = 24 * 3600_000;
  const now = Date.UTC(2026, 10, 4, 10, 0);          // 枫湾 11-04 21:00
  const resetsAt = now + 6 * D;                       // 这周过去了 1 天
  const fast = observeQuota({}, { sevenDay: { used: 20, resetsAt } }, { now, timezone: "Australia/Melbourne" });
  assert.match(fast.notice ?? "", /烧得太快/);
  assert.match(fast.notice ?? "", /大约 11月8日（周日）用完，比重置早 2\.0 天/, "一天 20%：第 5 天用完，重置在第 7 天");
  assert.match(fast.notice ?? "", /一天大约用 14%/);
  assert.match(fast.notice ?? "", /省的是帮手和重活[\s\S]*回 NO_REPLY 也省不下来/, "放慢不是醒着发呆（ada 11-05）");
  assert.equal(fast.urgent, false, "交给闸门的 quota-pace 规则去判");
  const again = observeQuota(fast.state, { sevenDay: { used: 22, resetsAt } }, { now: now + 3600_000, timezone: "Australia/Melbourne" });
  assert.equal(again.notice, null, "同一天不再报");
  const nextDay = observeQuota(again.state, { sevenDay: { used: 40, resetsAt } }, { now: now + D, timezone: "Australia/Melbourne" });
  assert.match(nextDay.notice ?? "", /烧得太快/, "第二天还快：再报");
  assert.equal(paceLine({ used: 10, resetsAt, level: 0 }, now, "UTC"), null, "一天 10%，照速度到不了 100%");
  assert.equal(paceLine({ used: 8, resetsAt: now + 7 * D - 3600_000, level: 0 }, now, "UTC"), null, "刚重置一小时：数太少不算");
  // 重置那句
  const reset = observeQuota({ sevenDay: { used: 95, resetsAt: now, level: 3 } }, { sevenDay: { used: 0, resetsAt: now + 7 * D } }, { now: now + 60_000, timezone: "UTC" });
  assert.match(reset.notice ?? "", /重置了，现在用了 0%。一周按七天匀着用/);
  assert.doesNotMatch(reset.notice ?? "", /放开做事/);
  // 5 小时：读数里没了，旧数过了重置时间就扔
  const stale = observeQuota({ fiveHour: { used: 1, resetsAt: now - D, level: 0 } }, { sevenDay: { used: 5, resetsAt } }, { now, timezone: "UTC" });
  assert.equal(stale.state.fiveHour, undefined);
});

test("viewTokensAfter：一次扫一遍，跟一个个 viewTokens(afterSeq) 算的一样（联想「隔多少再挂」用，sess-4c 11-04）", () => {
  const c = new CM(openDbV(":memory:"), () => 0);
  const seqs: number[] = [];
  seqs.push(c.append(1, "main", "say", "开头").seq);
  c.append(1, "side-1", "result", "长".repeat(5000), { id: "a" });
  seqs.push(c.append(1, "main", "result", "短".repeat(300), { id: "b" }).seq);
  c.append(1, "side-1", "act", `Bash ${"x".repeat(3000)}`, { tool: "Bash", id: "c" });
  c.append(1, "perception-messages", "think", "看不见".repeat(100), { inner: true });
  seqs.push(c.append(1, "main", "say", "后来").seq);
  c.append(2, "main", "say", "下一页的不算");
  const o = { maxItemChars: 1500 };
  const got = c.viewTokensAfter(1, "main", [...seqs, seqs[0]!], o);
  assert.deepEqual([...got.keys()].sort((a, b) => a - b), seqs, "重复的只算一次");
  for (const s of seqs) assert.equal(got.get(s), c.viewTokens(1, "main", { ...o, afterSeq: s }), `seq ${s}`);
  assert.equal(got.get(seqs[2]!), 0, "最后一条以后什么都没有");
  assert.deepEqual([...c.viewTokensAfter(1, "main", [], o)], []);
});

// ---------- Bash 往哪写（退役文件的把关用） ----------
import { bashWriteTargets, bashWritesTo } from "../src/util/bashWrites.ts";

test("bashWriteTargets：重定向、tee、sed -i、cp/mv/install/rsync 的目标、cd 之后的相对路径；复制文件描述符、进程替换、heredoc 正文、注释、输入都不算", () => {
  const t = (c: string) => bashWriteTargets(c);
  assert.deepEqual(t("echo x >&2; ls 2>&1 | tail; cat <&0; echo y >&-"), []);
  assert.deepEqual(t("echo x >& out.log"), ["out.log"]);
  assert.deepEqual(t("echo x 2>>err.log 1>out.log"), ["err.log", "out.log"]);
  assert.deepEqual(t(`echo "2">a`), ["a"], "引号里的 2 不是文件描述符");
  assert.deepEqual(t("echo x | sudo -u mira tee -a a.md > /dev/null"), ["/dev/null", "a.md"]);
  assert.deepEqual(t("env X=1 nice -n 5 tee b.md < c.md"), ["b.md"]);
  assert.deepEqual(t("tee >(grep x) < a.md"), []);
  assert.deepEqual(t("diff <(sort a) <(sort b)"), []);
  assert.deepEqual(t("cat <<< 'x > a.md'"), []);
  assert.deepEqual(t("cat <<-EOF > a.md\n\techo x > b.md\n\tEOF\necho y >> c.md"), ["a.md", "c.md"], "<<- 的分隔符前有 tab");
  assert.deepEqual(t("cat <<A > a.md; cat <<'B' > b.md\nx > n1\nA\ny > n2\nB\necho z > c.md"), ["a.md", "b.md", "c.md"], "一行两个 heredoc");
  assert.deepEqual(t("echo x # > a.md\necho y > b.md"), ["b.md"]);
  assert.deepEqual(t("echo a\\ b > 'with space.md'"), ["with space.md"]);
  assert.deepEqual(t("sed -n 's/a/b/p' a.md; sed --expression=s/i/x/ b.md"), [], "没有 -i 只是读");
  assert.deepEqual(t("sed --in-place=.bak 's/a/b/' a.md").at(-1), "a.md");
  assert.deepEqual(t("rsync -t /tmp/a.md b.md"), ["b.md", "b.md/a.md"], "rsync 的 -t 不是目标目录");
  assert.deepEqual(t("cp --target-directory=d x/a.md y/b.md"), ["d/a.md", "d/b.md"]);
  assert.deepEqual(t("cp a.md"), [], "只有一个参数：没有目标");
  assert.deepEqual(t("cd /w/memory && cd people; echo x > ../a.md; cd; echo y > b.md; cd -; echo z > c.md"), ["/w/memory/a.md", "~/b.md", "c.md"]);
  assert.deepEqual(t("echo x > ./memory//people/../ada.md"), ["memory/ada.md"], "规整过");
  assert.deepEqual(t('echo x > "$HOME/w/a.md"'), ["$HOME/w/a.md"]);
  assert.equal(bashWritesTo("constructor -x a.md; toString b.md", /a\.md/), false, "怪命令名不出错");
  assert.equal(bashWritesTo("", /x/), false);
});

// ---------- sleep-flow Task 10：hh sleep plan ----------
import { parseFlow as parseFlowP, planText } from "../src/sleep/flow.ts";
import { runHook } from "../src/modules/load.ts";
import type { ModuleContext } from "../src/modules/api.ts";

test("planText: waves, waits and conflicts", () => {
  const known = { tools: new Set<string>(), builtins: new Set<string>(), memWriters: new Set<string>() };
  const ag = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: id, kind: "agent", skill: `${id}.md`, ...extra });
  const f = parseFlowP({ maxParallel: 2, stages: [ag("a", { writes: ["x.md"] }), ag("b", { after: ["a"] }), ag("c", { writes: ["x.md"] }), ag("d")] }, known);
  assert.equal(planText(f), "第 1 波 a\n第 1 波 d\n第 2 波 b（等 a）\n第 2 波 c（跟 a 改同一个文件）");
  const g = parseFlowP({ maxParallel: 2, stages: [
    ag("a"), ag("off", { enabled: false }), ag("b", { after: ["a", "off"], writes: ["y.md"] }), ag("c", { after: ["a"], writes: ["y.md"] }),
    ag("w", { when: ["sunday"] }),
  ] }, known);
  assert.equal(planText(g), "第 1 波 a\n第 1 波 w 只在：sunday\n第 2 波 b（等 a、off）\n第 3 波 c（等 a；跟 b 改同一个文件）\n不跑 off（关了）");
});

// ---------- sleep-flow 终审修正：hh sleep 的写法 ----------
test("final #8: hh sleep — bare and plan as before; an unknown word gets the usage and exit code 2, she is not put to sleep", async () => {
  const { sleepRequest, UsageError } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest([]), { cmd: "sleep", reason: "手动" });
  assert.deepEqual(sleepRequest(["plan"]), { cmd: "sleep-plan" });
  for (const w of [["累了"], ["now"], ["replay"]]) {
    assert.throws(() => sleepRequest(w), (e: unknown) => e instanceof UsageError && /用法：hh sleep/.test(e.message), w.join(" "));
  }
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const r = spawnSync(process.execPath, ["src/cli.ts", "sleep", "累了"], { cwd: root, env: { ...process.env, HH_CONFIG: sandboxConfig() }, encoding: "utf8", timeout: 30_000 });   // 临时配置：用法检查坏了也连不到线上的 hhd（11-13）
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /用法：hh sleep/);
});

// ---------- sleep-flow Task 10：hh sleep bank ----------
test("sleepRequest: bank import parses file/tag/layer; stats; bad forms get the usage", async () => {
  const { sleepRequest, UsageError } = await import("../src/control.ts");
  assert.deepEqual(sleepRequest(["bank", "stats"]), { cmd: "sleep-bank-stats" });
  assert.deepEqual(sleepRequest(["bank", "import", "/x/exam-1102.json"]), { cmd: "sleep-bank-import", file: "/x/exam-1102.json", tag: "exam-1102", layer: "searchable" });
  assert.deepEqual(sleepRequest(["bank", "import", "/x/a.json", "--tag", "t1", "--layer", "archive"]), { cmd: "sleep-bank-import", file: "/x/a.json", tag: "t1", layer: "archive" });
  assert.deepEqual(sleepRequest(["bank", "import", "--layer", "resident", "/x/a.json"]), { cmd: "sleep-bank-import", file: "/x/a.json", tag: "a", layer: "resident" });
  for (const w of [["bank"], ["bank", "list"], ["bank", "import"], ["bank", "import", "a.json", "--layer", "x"], ["bank", "import", "a.json", "--wat"], ["bank", "import", "a.json", "--tag"], ["bank", "stats", "extra"]]) {
    assert.throws(() => sleepRequest(w), (e: unknown) => e instanceof UsageError && /用法：hh sleep/.test(e.message), w.join(" "));
  }
});

test("cli: hh sleep bank <unknown word> exits 2 with the usage", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const r = spawnSync(process.execPath, ["src/cli.ts", "sleep", "bank", "累了"], { cwd: root, env: { ...process.env, HH_CONFIG: sandboxConfig() }, encoding: "utf8", timeout: 30_000 });   // 临时配置：用法检查坏了也连不到线上的 hhd（11-13）
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /bank import/);
});

// ---- final fix M9 ----
test("M9: hh sleep bank import resolves a relative file before sending it to hhd", async () => {
  const { sleepRequest } = await import("../src/control.ts");
  const { resolve } = await import("node:path");
  assert.deepEqual(sleepRequest(["bank", "import", "rel/exam-1102.json"]), { cmd: "sleep-bank-import", file: resolve("rel/exam-1102.json"), tag: "exam-1102", layer: "searchable" });
  assert.equal((sleepRequest(["bank", "import", "/abs/a.json"]) as { file: string }).file, "/abs/a.json");
});

test("recall show / around：c:N 跟 #N 一样（夜里整理的出处写的是 c:N）", () => {
  const db = openDb(":memory:");
  const c = new CentralMemory(db, () => Date.UTC(2026, 9, 29, 8));
  c.append(1, "外界", "input", "前一句", { from: "ada", human: true });
  const r = c.append(1, "外界", "input", "就这一句", { from: "ada", human: true });
  const o = { timezone: "UTC", labels: (s: string) => s };
  assert.equal(recallCentral(db, ["show", `c:${r.seq}`], o), recallCentral(db, ["show", `#${r.seq}`], o));
  assert.match(recallCentral(db, ["show", `c:${r.seq}`], o), /就这一句/);
  const around = recallCentral(db, ["around", String(r.seq)], o);
  assert.match(around, /前一句/);
  assert.equal(recallCentral(db, ["around", `c:${r.seq}`], o), around);
  assert.equal(recallCentral(db, ["around", `#${r.seq}`], o), around);
  assert.match(recallCentral(db, ["show", "c:999"], o), /没有 #999/);
});

// ---- #0046：客户端先走了（超时 destroy、只发不收），控制面别再往里写，也别把它的断开记成 control error ----
test("#0046 控制面：客户端断开后不再写它、断开不算 control error；handle 真出错照记", async () => {
  const { serve, request } = await import("../src/control.ts");
  const { createConnection } = await import("node:net");
  type Sock = import("node:net").Socket;
  const { rmSync } = await import("node:fs");
  const dir = tmpDir("hh-ctl-");
  const sockPath = pj(dir, "hh.sock");
  const errors: unknown[] = [];
  let release = () => {};
  let entered = () => {};
  // 只有 sleep 用得到 brain：慢一点、由测试决定什么时候回
  const brain = { sleep: () => new Promise<void>((r) => { release = r; entered(); }) };
  const server = serve(brain as never, sockPath, (e) => errors.push(e));
  const nextConn = () => new Promise<Sock>((r) => server.once("connection", r));
  // 等一次事件（不用 events.once：它碰到 error 会抛，这里要让断开的错走到 serve 自己的处理里）
  const once = (x: { once(name: string, f: () => void): unknown }, name: string) => new Promise<void>((r) => x.once(name, () => r()));
  try {
    await once(server, "listening");

    // 1. 跟 hh 命令行 / 控制台超时一样：请求还在办，客户端 destroy 走了；hhd 还没看到它断，回复照样写出去
    let conn = nextConn();
    const a = createConnection(sockPath);
    await once(a, "connect");
    const sa = await conn;
    let inSleep = new Promise<void>((r) => { entered = r; });
    a.write(JSON.stringify({ cmd: "sleep" }) + "\n");
    await inSleep;
    a.destroy(); release();
    await once(sa, "close");

    // 2. 客户端发完就半关（只发不收）：hhd 看到它关了以后才办完，不该再往里写
    conn = nextConn();
    const b = createConnection(sockPath);
    await once(b, "connect");
    const sb = await conn;
    inSleep = new Promise<void>((r) => { entered = r; });
    let lateWrites = 0;
    sb.once("end", () => {
      const w = sb.write;
      sb.write = ((...x: Parameters<Sock["write"]>) => { lateWrites++; return w.apply(sb, x); }) as Sock["write"];
      release();
    });
    b.end(JSON.stringify({ cmd: "sleep" }) + "\n");
    await inSleep;
    await once(sb, "close");
    b.destroy();
    await new Promise((r) => setImmediate(r));

    const gone = errors.filter((e) => ["EPIPE", "ECONNRESET"].includes((e as { code?: string })?.code ?? ""));
    assert.deepEqual(gone.map(String), [], "客户端自己断开不是 hhd 的错，不报 control error");
    assert.equal(lateWrites, 0, "hhd 看到客户端关了以后不再往里写");

    // 3. 正常的照常回；handle 真出错照样报上去、也回给客户端
    assert.deepEqual(await request(sockPath, { cmd: "ping" }, 2000), { ok: true });
    await assert.rejects(request(sockPath, { cmd: "gate", action: "bogus" } as never, 2000), /用法：gate probe/);
    // socket 上别的错（不是客户端断开）也照报
    conn = nextConn();
    const c = createConnection(sockPath);
    await once(c, "connect");
    (await conn).emit("error", Object.assign(new Error("别的 socket 错"), { code: "EMFILE" }));
    c.destroy();
    assert.equal(errors.length, 2, errors.map(String).join("\n"));
    assert.match(String(errors[0]), /用法：gate probe/);
    assert.match(String(errors[1]), /别的 socket 错/);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- #0054：最后一段可以跳过一截（夜里睡着到醒来之间的记录） ----------
test("#0054 central.tail：给了要跳过的一截就当它不存在，再长也一样；不给照旧", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  c.append(1, "外界", "input", "睡前别人说的");
  const slept = c.append(1, "system", "system", "去睡觉了").seq;
  for (let i = 0; i < 2100; i++) c.append(1, "hippocampus", "act", `夜里的动作 ${i}`);
  const woke = c.lastSeq();
  c.append(2, "system", "system", "睡醒了");
  const texts = (es: Array<{ text: string }>): string[] => es.map((e) => e.text);
  assert.deepEqual(texts(c.tail(10_000, { after: slept, upTo: woke })), ["睡前别人说的", "去睡觉了", "睡醒了"]);
  const plain = texts(c.tail(40));
  assert.equal(plain.at(-1), "睡醒了");
  assert.ok(plain.includes("夜里的动作 2099") && !plain.includes("去睡觉了"), "不给就照旧取最后一段");
  // 预算照旧算：跳过以后剩下的装不下就从最早的舍
  assert.deepEqual(texts(c.tail(estimateTokens("去睡觉了") + estimateTokens("睡醒了"), { after: slept, upTo: woke })), ["去睡觉了", "睡醒了"]);
});

test("#0054 醒来的几句话：不叫她去读别人整理的东西", () => {
  assert.match(PR.FOCUS_PLAN, /^【规划专注】早上第一段专注：先想想睡着前在弄什么，再看目标（goals 工具 \["ls"\]）和待办，想清楚今天最想做的，定今日目标，然后开始做事。/);
  assert.doesNotMatch(PR.FOCUS_PLAN, /回看|昨天的日记/);
  assert.equal(PR.WOKE_UP_AFTER_NIGHT, "【醒了】你刚睡醒。看看睡觉时有没有人找你，接着过你的一天。");
  assert.equal(PR.WOKE_UP, "【醒了】你刚睡醒，记忆整理过了。看看睡觉时有没有人找你，接着过你的一天。", "小睡醒来的那句不动");
  assert.match(PR.BEFORE_SLEEP_NOTE, /睡着以前/);
  assert.match(PR.BEFORE_SLEEP_NOTE, /夜里的整理/);
  assert.doesNotMatch(PR.BEFORE_SLEEP_NOTE, /\n/);
});

test("#0054 central.tail：那一截里指定来源的不跳过", () => {
  const c = new CentralMemory(openDb(":memory:"), () => T0);
  c.append(1, "main", "say", "睡前说的");
  const slept = c.append(1, "system", "system", "去睡觉了").seq;
  c.append(1, "main", "note", "她自己记的");
  c.append(1, "hippocampus", "say", "整理的记录");
  const woke = c.lastSeq();
  c.append(2, "system", "system", "睡醒了");
  assert.deepEqual(c.tail(10_000, { after: slept, upTo: woke, keep: "main" }).map((e) => e.text), ["睡前说的", "去睡觉了", "她自己记的", "睡醒了"]);
  assert.equal(c.skips({ after: slept, upTo: woke, keep: "main" }), true);
  assert.equal(c.skips({ after: slept, upTo: slept + 1, keep: "main" }), false, "那一截里只有留下的来源：没有可跳过的");
});

test("runtimeNote: 配了语言就在说明末尾多一条；空的原样", () => {
  const n = runtimeNote("中文");
  assert.ok(n.startsWith(hhRuntimeNote()));
  assert.ok(n.endsWith("- 你自己想的、说的、记下的都用中文；跟别人说话时，对方用什么语言就用什么语言。"));
  assert.match(n, /用中文/);
  assert.equal(runtimeNote(""), hhRuntimeNote());
  assert.equal(runtimeNote("  "), hhRuntimeNote());
});

test("languageLine：语言那一句只在一个地方写（运行说明、夜里整理的前缀都用它）；配置手改写成不是字符串的（null、数字……）当没配，不抛（final-review F-6）", () => {
  assert.equal(languageLine("X语"), "- 你自己想的、说的、记下的都用X语；跟别人说话时，对方用什么语言就用什么语言。");
  assert.equal(languageLine(" X语 "), languageLine("X语"));
  assert.equal(runtimeNote("X语"), `${hhRuntimeNote()}\n${languageLine("X语")}`);
  for (const bad of [null, undefined, 7, true, {}, ["X语"], "", "  "]) {
    assert.equal(languageLine(bad), "", JSON.stringify(bad));
    assert.equal(runtimeNote(bad), hhRuntimeNote(), JSON.stringify(bad));
  }
  const persona = new Persona("p", [{ path: "IDENTITY.md", text: "我是谁。" }]);
  assert.equal(buildPrefix(persona, [], { language: 7 as unknown as string }), buildPrefix(persona, []));
});

test("buildPrefix: extra.language 进说明；不给就和原来一字不差", () => {
  const persona = new Persona("p", [{ path: "IDENTITY.md", text: "我是谁。" }]);
  const withLang = buildPrefix(persona, [], { language: "X语" });
  assert.ok(withLang.startsWith(runtimeNote("X语")));
  assert.match(withLang, /用X语/);
  assert.equal(buildPrefix(persona, []), [hhRuntimeNote(), `<file path="IDENTITY.md">\n我是谁。\n</file>`].join("\n\n---\n\n"));
  assert.equal(buildPrefix(persona, [], { language: "" }), buildPrefix(persona, []));
});

// ---- #0057 后续（CEO 11-12）：状态栏挂着旧代码记下的假帮手（--help 11-12 07:53、xxx 03:28），新规则下她自己 stop 不掉 ----
test("#0057 后续：启动时挑出假帮手——名字不合规矩又没会话的丢；挂得再久的不丢（ada 11-12：问她，不直接清）；-x 这种真派过、有会话的留着", () => {
  const now = Date.UTC(2026, 10, 12, 8, 0);
  const h = 3600_000;
  const busy = {
    "--help": now - h, "-h": now - h, "": now, "a b": now, "../x": now, "-x": now - 30 * h,
    xxx: now - 30 * h, "didi-visual": now - 30 * h, "new-one": now - h, 剪片子: now - 30 * h, "a.b_c": now - 2 * h,
  };
  const has = (n: string): boolean => ["didi-visual", "剪片子", "-x", "../x"].includes(n);
  assert.deepEqual(ghostHelpers(busy, has).sort(), ["", "--help", "-h", "a b", "../x", "a.b_c"].sort(), "带 / 的名字不拿去查文件；-x 真有会话照留；xxx 挂了 30 小时也不丢");
  assert.deepEqual(ghostHelpers(busy, null).sort(), ["", "--help", "-h", "-x", "a b", "../x", "a.b_c"].sort(), "不知道会话在哪：只按名字丢");
});

// ---- 事件循环卡顿自检（CEO 11-12）：hhd 卡住时 relay 等不到回话，要知道卡了多久、哪条命令慢 ----
test("卡顿自检：事件循环被占住超过门槛就报卡了多久；控制命令处理慢了记下是哪条、多慢", async (t) => {
  const { watchLoop } = await import("../src/basal/loopWatch.ts");
  // 模拟计时器加手拨的钟（11-14：原来真的占住事件循环 400 毫秒、真等 60 毫秒，机器忙时「没卡」那一段自己就会卡，时好时坏）
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 1_000;
  const blocked: number[] = [];
  const stop = watchLoop({ everyMs: 20, thresholdMs: 150, now: () => clock, onBlocked: (ms) => blocked.push(ms) });
  for (let i = 0; i < 3; i++) { clock += 20; t.mock.timers.tick(20); }
  assert.equal(blocked.length, 0, "没卡不报");
  clock += 400;                                   // 事件循环被占住 400 毫秒：这期间计时器一次也没跑
  clock += 20; t.mock.timers.tick(20);
  assert.equal(blocked.length, 1, "卡一次报一次");
  assert.equal(blocked[0], 400, `卡了多久：${blocked[0]}`);
  for (let i = 0; i < 3; i++) { clock += 20; t.mock.timers.tick(20); }
  assert.equal(blocked.length, 1, "卡完照常不再报");
  stop();
  t.mock.timers.reset();

  const { serve, request } = await import("../src/control.ts");
  const sockPath = pj(tmpDir("hh-ctl-"), "hh.sock");
  const seen: string[] = [];
  const slow: Array<[string, number]> = [];
  const brain = {
    drainRelaySpool: () => {},
    fromChannel: () => { const s = Date.now(); while (Date.now() - s < 400) { /* 同步慢 */ } return "delivered"; },
    status: () => ({ alertness: "awake" }),
  };
  const server = serve(brain as never, sockPath, () => {}, { slowMs: 300, seen: (c) => seen.push(c), onSlow: (c, ms) => slow.push([c, ms]) });   // 慢的那条 400 毫秒、门槛 300：status 要被机器负载拖过 300 毫秒才会误记（原来是 120 对 80，机器忙时 status 也会被记成慢）
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    assert.deepEqual(await request(sockPath, { cmd: "relay", message: { channel: "whatsapp", text: "在吗" } } as never), { result: "delivered" });
    await request(sockPath, { cmd: "status" });
    assert.deepEqual(seen, ["relay", "status"]);
    assert.equal(slow.length, 1, "只有慢的那条记");
    assert.equal(slow[0]![0], "relay");
    assert.ok(slow[0]![1] >= 400);
  } finally {
    server.close();
  }
});

/** 真跑 hh 的子进程用的临时配置：状态目录、工作区都在临时目录里（11-13 以前默认配置的 stateDir 就是线上的状态目录；配置分层以后默认配置里没有了，没带实例配置的 hh 一启动就报错退出） */
function sandboxConfig(): string {
  const dir = tmpDir("hh-cli-sandbox-");
  const f = pj(dir, "config.json");
  // 名字也给上：默认配置里没有名字了，闸门默认开着，没名字命令行一启动就停在 requireInstance，走不到要测的用法错误
  wf(f, JSON.stringify({ lang: "zh", stateDir: pj(dir, "state"), workspace: pj(dir, "ws"), names: { me: "阿青", owner: "老林", notMe: [] } }));
  return f;
}

test("运行说明：配了 OpenClaw 网关、有修系统那一页的角色（第一个角色）读到的是原文，一字不动；新角色那几句换掉", async () => {
  const { runtimeNote, hhRuntimeNote, languageLine } = await import("../src/persona/persona.ts");
  const { B } = await import("../src/lang/index.ts");
  // 第一个角色：和改之前拼出来的完全一样（原文 + 语言那一句）
  assert.equal(runtimeNote("中文", { openclaw: true, repairGuide: true }), `${hhRuntimeNote()}\n${languageLine("中文")}`);
  assert.equal(runtimeNote("中文"), `${hhRuntimeNote()}\n${languageLine("中文")}`, "不给事实 = 都有");
  // 原文里那三处还在（谁改了语言包里的原文，这条会先红）
  for (const [from] of B.persona.runtimeNoteNoOpenClaw) assert.ok(hhRuntimeNote().includes(from), from);
  assert.ok(hhRuntimeNote().includes(B.persona.runtimeNoteNoRepairGuide[0]));
  // 新角色：没有 OpenClaw、没有那一页
  const fresh = runtimeNote("中文", { openclaw: false, repairGuide: false });
  assert.ok(!/openclaw|sessions_spawn|修系统\.md/.test(fresh), fresh);
  assert.ok(fresh.includes("remind") && fresh.includes("browser 工具") && fresh.includes("毛病本"));
});
