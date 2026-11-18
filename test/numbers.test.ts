// hh numbers：周表的五个数（CEO 11-12）。只读：hh.db、HH 日志、Claude 会话记录
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/store/db.ts";
import { numbers, numbersCommand, renderNumbers, dayList, destOf, projectDirOf, teamDirsOf } from "../src/metrics/numbers.ts";
import { tmpDir } from "./tmp.ts";

const TZ = "Australia/Melbourne";
const NOW = Date.UTC(2026, 10, 12, 10, 0);          // 枫湾 11-12 21:00
const L = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h - 11, mi);   // 枫湾时间 → 毫秒（11 月是 UTC+11）
const DIRS = { workspace: "/home/role/.openclaw/workspace", replay: ["/home/role/.hh/replay"] };

function seed(db: ReturnType<typeof openDb>): void {
  const ins = (sql: string, ...p: Array<string | number | null>): void => { db.prepare(sql).run(...p); };
  ins("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('l:1', '2026-11-12', 'mounted')");
  ins("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('l:2', '2026-11-12', 'mounted')");
  ins("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('l:1', '2026-11-11', 'mounted')");
  ins("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('l:1', '2026-11-01', 'mounted')");   // 太早，不算
  ins("INSERT INTO learn_correction (at, p) VALUES (?, 0.9)", L(2026, 11, 12, 9));
  ins("INSERT INTO learn_correction (at, p) VALUES (?, 0.8)", L(2026, 11, 12, 23, 30));   // 枫湾 23:30 还是 11-12
  ins("INSERT INTO learn_correction (at, p) VALUES (?, 0.8)", L(2026, 11, 11, 0, 30));
  const assoc = (at: number, region: string, binding: string | null, mounted: string, shadow: number): void =>
    ins("INSERT INTO learn_assoc (at, region, binding, candidates, mounted, shadow, ms, tokens) VALUES (?, ?, ?, 3, ?, ?, 10, 10)", at, region, binding, mounted, shadow);
  assoc(L(2026, 11, 12, 10), "main", "wake", '[{"id":"p1","p":0.9,"strong":true,"loud":["l:1","l:2"]},{"id":"p2","p":0.8,"strong":true,"hits":["l:3"]},{"id":"p3","p":0.7,"carry":true}]', 0);
  assoc(L(2026, 11, 12, 14), "main", "handover", '[{"id":"p5","p":0.9,"strong":true,"loud":["l:9"]}]', 0);   // handover：算挂上，强教训不算
  assoc(L(2026, 11, 12, 11), "main", "wake", '[{"id":"p9","p":0.9}]', 1);           // shadow：不算
  assoc(L(2026, 11, 12, 12), "side-1", "helper", '[{"id":"p9","p":0.9}]', 0);       // 帮手挂的：不算
  assoc(L(2026, 11, 12, 12), "main", null, '[{"id":"p9","p":0.9}]', 0);             // binding 是 NULL：照学习的 SQL 不算
  assoc(L(2026, 11, 11, 15), "side-1", "on_it", '[{"id":"p4","p":0.9}]', 0);
  const open = (at: number, region: string, page: string): void => ins("INSERT INTO learn_open (at, region, page_id) VALUES (?, ?, ?)", at, region, page);
  open(L(2026, 11, 12, 10, 20), "main", "p1");      // 30 分钟内、同一个脑区：算
  open(L(2026, 11, 12, 10, 40), "main", "p2");      // 过了 30 分钟：不算
  open(L(2026, 11, 12, 10, 5), "main", "p3");       // carry 的页：本来就不算
  open(L(2026, 11, 11, 15, 10), "main", "p4");      // 别的脑区翻的：不算
}

const log = (t: number, msg: string, extra: Record<string, unknown> = {}): string => JSON.stringify({ t: new Date(t).toISOString(), level: "info", mod: "hhd", msg, ...extra });
const LOGS = [
  log(L(2026, 11, 11, 9), "turn end", { region: "main" }),
  log(L(2026, 11, 11, 10), "turn end", { region: "main" }),
  log(L(2026, 11, 11, 10), "turn end", { region: "side-1" }),
  log(L(2026, 11, 12, 9), "main wake", { cause: "human" }),
  log(L(2026, 11, 12, 9, 5), "turn end", { region: "main" }),
  log(L(2026, 11, 12, 10), "main wake", { cause: "focus" }),
  log(L(2026, 11, 12, 11), "main wake", { cause: "focus" }),
  log(L(2026, 11, 11, 8), "quota reading", { sevenDay: { used: 90, resetsAt: 1 } }),
  log(L(2026, 11, 11, 23, 30), "quota reading", { sevenDay: { used: 95, resetsAt: 1 } }),
  log(L(2026, 11, 12, 0, 30), "quota reading", { sevenDay: { used: 2, resetsAt: 2 } }),     // 重置了：新一周的 2% 算进 11-12
  log(L(2026, 11, 12, 20), "quota reading", { sevenDay: { used: 10, resetsAt: 2 } }),
  log(L(2026, 11, 12, 21), "quota reading", { sevenDay: { used: 9, resetsAt: 2 } }),     // a one-point dip (seen live at 03:00): not a reset
  log(L(2026, 11, 12, 22), "quota reading", { sevenDay: { used: 11, resetsAt: 2 } }),
  "不是 JSON 的一行",
];
const usageLine = (t: number, id: string, u: Record<string, number>): string =>
  JSON.stringify({ type: "assistant", timestamp: new Date(t).toISOString(), requestId: `req-${id}`, message: { id, model: "claude-opus-5-5", usage: u } });
const TRANSCRIPTS = [
  { dir: projectDirOf(DIRS.workspace), lines: [
    usageLine(L(2026, 11, 12, 9), "m1", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 }),
    usageLine(L(2026, 11, 12, 9), "m1", { cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 0 }),   // 同一次回复的第二段：去重
    usageLine(L(2026, 11, 11, 9), "m2", { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, input_tokens: 0, output_tokens: 200_000 }),
  ] },
  { dir: "-home-role-agent-tasks-jingke-visual", lines: [usageLine(L(2026, 11, 12, 12), "h1", { cache_creation_input_tokens: 800_000 })] },
  { dir: projectDirOf("/home/role/.openclaw/workspace/projects/bili"), lines: [usageLine(L(2026, 11, 12, 12), "h2", { input_tokens: 1_000_000 })] },
  { dir: projectDirOf("/home/role/.hh/replay/2026-11-12T02-35"), lines: [usageLine(L(2026, 11, 12, 13), "r1", { output_tokens: 100_000 })] },
  { dir: "-private-var-folders-y6-abc", lines: [usageLine(L(2026, 11, 12, 13), "o1", { input_tokens: 2_000_000 })] },
];

test("numbers：日子、会话目录认去向", () => {
  assert.deepEqual(dayList(NOW, 3, TZ), ["2026-11-10", "2026-11-11", "2026-11-12"]);
  assert.equal(projectDirOf("/home/role/.openclaw/workspace"), "-home-role--openclaw-workspace");
  assert.equal(destOf("-home-role--openclaw-workspace", DIRS), "hh");
  assert.equal(destOf("-home-role--openclaw-workspace-projects-bili", DIRS), "helpers", "工作区子目录里干活的是帮手");
  assert.equal(destOf("-home-role-agent-tasks-x", DIRS), "helpers");
  assert.equal(destOf("-Volumes-Mira-worktrees-x", DIRS), "helpers");
  assert.equal(destOf("-home-role--hh-replay-2026-11-12T02-35", DIRS), "replay");
  assert.equal(destOf("-private-var-folders-y6", DIRS), "other");
  assert.equal(destOf("-home-role--cache-quota-probe", DIRS), "other");
  assert.equal(destOf("-Users-Shared-hh-team-sess-da", DIRS), "helpers", "没配团队目录：和以前一样算帮手");
});

test("numbers：团队目录（实例配置 metrics.teamDirs）——那个目录本身和下面的子目录算团队，名字只是开头一样的不算；用量、周表都多一栏", () => {
  const TEAM = { ...DIRS, team: ["/Users/Shared/hh-team"] };
  assert.equal(destOf("-Users-Shared-hh-team-sess-da", TEAM), "team");
  assert.equal(destOf("-Users-Shared-hh-team-sess-55-probe-fable-a", TEAM), "team", "子目录的子目录也算");
  assert.equal(destOf("-Users-Shared-hh-team", TEAM), "team", "目录本身");
  assert.equal(destOf("-Users-Shared-hh-teamwork", TEAM), "helpers", "只是开头一样、不是它下面的：不算");
  assert.equal(destOf("-home-role--openclaw-workspace", TEAM), "hh", "她的工作区照旧");
  assert.equal(destOf("-home-role--hh-replay-2026-11-12T02-35", TEAM), "replay", "回放照旧");
  assert.equal(destOf("-Users-Shared-hh-team-sess-da", { ...DIRS, team: [] }), "helpers", "配了空的：没有团队这一类");
  const base = { stateDir: "/x", workspace: "/w", schedule: { timezone: TZ } };
  assert.deepEqual(teamDirsOf(base), [], "没配");
  assert.deepEqual(teamDirsOf({ ...base, metrics: { teamDirs: "/Users/Shared/hh-team" as unknown as string[] } }), [], "写成了字符串：当没配，不崩");
  assert.deepEqual(teamDirsOf({ ...base, metrics: { teamDirs: ["/a", "", 3 as unknown as string, " "] } }), ["/a"], "只留非空字符串");

  const lines = [...TRANSCRIPTS, { dir: projectDirOf("/Users/Shared/hh-team/sess-da/run1"), lines: [usageLine(L(2026, 11, 12, 14), "t1", { input_tokens: 3_000_000 })] }];
  const [, with12] = numbers({ days: 2, now: NOW, tz: TZ, db: null, logLines: [], transcripts: lines, dirs: TEAM });
  assert.deepEqual(with12!.usage, { hh: 0.1, helpers: 2, team: 3, replay: 0.5, other: 2 });
  const [, without12] = numbers({ days: 2, now: NOW, tz: TZ, db: null, logLines: [], transcripts: lines, dirs: DIRS });
  assert.deepEqual(without12!.usage, { hh: 0.1, helpers: 5, team: 0, replay: 0.5, other: 2 }, "没配团队目录：同一份记录算进帮手，和以前一样");

  const text = renderNumbers([with12!], { tz: TZ });
  assert.match(text, /用量当量 HH \/ 帮手 \/ 团队 \/ 回放 \/ 其他 \|/);
  assert.match(text, /\| 8（0 \/ 2 \/ 3 \/ 1 \/ 2） \|$/m, "合计和五个去向，按 HH / 帮手 / 团队 / 回放 / 其他 的顺序");
});

test("numbers：五个数按她的日子切天——又犯、纠正、翻开率照学习的口径，被叫醒数 main wake（没有就退回主线回合数），额度数读数（重置也认），用量按消息去重", () => {
  const db = openDb(":memory:");
  seed(db);
  const rows = numbers({ days: 2, now: NOW, tz: TZ, db, logLines: LOGS, transcripts: TRANSCRIPTS, dirs: DIRS });
  const [d11, d12] = rows;
  assert.deepEqual(rows.map((r) => r.day), ["2026-11-11", "2026-11-12"]);
  assert.equal(d12!.recur, 2);
  assert.equal(d11!.recur, 1);
  assert.equal(d12!.corrections, 2, "枫湾 23:30 还算 11-12");
  assert.equal(d11!.corrections, 1);
  assert.deepEqual([d12!.mounted, d12!.opened], [3, 1], "carry、shadow、帮手挂的、binding 是 NULL 的都不算；30 分钟外的不算");
  assert.equal(d12!.mounts, 2, "有挂载的联想次数");
  assert.equal(d12!.strongPastes, 3, "强教训：有 loud 数 loud，没有就数 hits；handover 的不算");
  assert.deepEqual([d11!.mounted, d11!.opened], [1, 0], "别的脑区翻的不算");
  assert.equal(d12!.wakes, 3);
  assert.deepEqual(d12!.wakeCauses, { human: 1, focus: 2 });
  assert.equal(d11!.wakes, 2, "没有 main wake 日志的那天：数主线的 turn end");
  assert.equal(d11!.wakeCauses, null);
  assert.equal(d11!.quotaPct, 5);
  assert.equal(d12!.quotaPct, 12, "重置后的 2% 加上之后涨的 8%，掉一点不算重置，再涨的 2%");
  assert.equal(d12!.usage.hh, 0.1, "同一次回复只算一次");
  assert.equal(d11!.usage.hh, 1);
  assert.equal(d12!.usage.helpers, 2);
  assert.equal(d12!.usage.replay, 0.5);
  assert.equal(d12!.usage.other, 2);
  // 权重是参数
  const w = numbers({ days: 2, now: NOW, tz: TZ, db: null, logLines: [], transcripts: TRANSCRIPTS, dirs: DIRS, weights: { cacheRead: 1, cacheWrite: 1, input: 1, output: 1 } });
  assert.equal(w[1]!.usage.hh, 1);
  assert.equal(w[1]!.recur, 0, "没有库也能出（只是那几列是 0）");

  const text = renderNumbers(rows.slice(1), { tz: TZ, prev: rows.slice(0, 1) });
  assert.match(text, /\| 2026-11-12 \| 2 \| 2 \| 33%（1 \/ 3） \| 1\.5 \| 3 \| 3（专注 2、真人 1） \| 12% \|/);
  assert.match(renderNumbers(rows, { tz: TZ, today: "2026-11-12" }), /\| 2026-11-12 \| — \| 2 \|/, "当天的又犯夜里才记：写「—」");
  assert.match(renderNumbers(rows.slice(0, 1), { tz: TZ }), /\| 2（没分类） \|/);
  assert.match(text, /和前 1 天（2026-11-11 到 2026-11-11）比：又犯 1 → 2，纠正 1 → 2，翻开率 0% → 33%，强教训贴了 0 → 3，被叫醒 2 → 3，周额度 5% → 12%/);
  assert.doesNotMatch(text, /ada/, "不写死名字");
});

test("hh numbers 命令：只读打开她的库、读日志和会话记录，按天出表，--compare 和前一段比，--json 给原始数", () => {
  const dir = tmpDir("hh-numbers-");
  const stateDir = join(dir, "state");
  const projects = join(dir, "projects");
  const db = openDb(join(stateDir, "hh.db"));
  seed(db);
  db.close();
  mkdirSync(join(stateDir, "logs"), { recursive: true });
  writeFileSync(join(stateDir, "logs", "hh.jsonl"), LOGS.join("\n") + "\n");
  for (const t of TRANSCRIPTS) {
    mkdirSync(join(projects, t.dir), { recursive: true });
    writeFileSync(join(projects, t.dir, "s.jsonl"), t.lines.join("\n") + "\n");
  }
  // 子代理的记录在会话目录下面几层：也算，去向按最上面那层认
  mkdirSync(join(projects, projectDirOf(DIRS.workspace), "sess-1", "subagents"), { recursive: true });
  writeFileSync(join(projects, projectDirOf(DIRS.workspace), "sess-1", "subagents", "agent-a.jsonl"), usageLine(L(2026, 11, 12, 15), "sub1", { input_tokens: 400_000 }) + "\n");
  const before = statSync(join(stateDir, "hh.db")).mtimeMs;
  const cfg = { stateDir, workspace: DIRS.workspace, schedule: { timezone: TZ } };
  const out = numbersCommand({ ...cfg, stateDir }, ["1", "--compare"], { now: NOW, projectsDir: projects });
  assert.match(out, /\| 2026-11-12 \| — \| 2 \|/, "命令按 now 认出当天");
  assert.match(out, /和前 1 天/);
  const j = JSON.parse(numbersCommand(cfg, ["2", "--json"], { now: NOW, projectsDir: projects })) as { days: Array<{ day: string; wakes: number; usage: { hh: number } }> };
  assert.deepEqual(j.days.map((d) => [d.day, d.wakes]), [["2026-11-11", 2], ["2026-11-12", 3]]);
  assert.equal(j.days[1]!.usage.hh, 0.5, "0.1（主会话）+ 0.4（子代理）");
  assert.equal(statSync(join(stateDir, "hh.db")).mtimeMs, before, "只读：库没被碰");
  assert.throws(() => numbersCommand(cfg, ["0"], { now: NOW, projectsDir: projects }), /用法/);
  assert.throws(() => numbersCommand(cfg, ["--weights", "1,2"], { now: NOW, projectsDir: projects }), /四个非负数/);
  // 实例配置 metrics.teamDirs：命令把它交给 destOf，团队目录下的记录算团队；不配的那次（上面）算帮手
  const teamDir = join(dir, "hh-team");
  mkdirSync(join(projects, projectDirOf(join(teamDir, "sess-da"))), { recursive: true });
  writeFileSync(join(projects, projectDirOf(join(teamDir, "sess-da")), "t.jsonl"), usageLine(L(2026, 11, 12, 14), "team1", { input_tokens: 700_000 }) + "\n");
  type U = { days: Array<{ usage: Record<string, number> }> };
  const plain = JSON.parse(numbersCommand(cfg, ["1", "--json"], { now: NOW, projectsDir: projects })) as U;
  const teamed = JSON.parse(numbersCommand({ ...cfg, metrics: { teamDirs: [teamDir] } }, ["1", "--json"], { now: NOW, projectsDir: projects })) as U;
  assert.deepEqual([plain.days[0]!.usage.team, teamed.days[0]!.usage.team], [0, 0.7]);
  const total = (u: Record<string, number>): number => Math.round(Object.values(u).reduce((a, b) => a + b, 0) * 10) / 10;
  assert.equal(total(teamed.days[0]!.usage), total(plain.days[0]!.usage), "只是从原来那栏挪到团队（这里的临时目录原来算其他），合计不变、不重算");
});
