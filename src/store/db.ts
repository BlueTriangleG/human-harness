// 状态库：一个 SQLite 文件（WAL）。所有模块的持久状态都在这里，表按模块分开，模块之间不直接读别人的表。
import { refuseLive } from "../testGuard.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { MIGRATION_EVENTS } from "../memory/events/schema.ts";

export const MIGRATIONS: string[] = [
  // 1: 中央记忆、纪元、压缩块、待办、日程、认领、实例
  `
  CREATE TABLE central (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,              -- 毫秒
    epoch INTEGER NOT NULL,
    src TEXT NOT NULL,                -- 哪个脑区 / 外界来源
    kind TEXT NOT NULL,               -- input/think/say/act/result/note/system
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    meta TEXT                         -- JSON：来自谁、渠道等
  );
  CREATE INDEX central_epoch ON central(epoch, seq);
  CREATE TABLE epochs (
    id INTEGER PRIMARY KEY,
    started INTEGER NOT NULL,
    reason TEXT NOT NULL,             -- boot / page-turn / wake
    first_seq INTEGER NOT NULL        -- 这一页从中央记忆的哪条开始
  );
  CREATE TABLE blocks (               -- 压缩块：睡前不重压，睡觉时清空
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    epoch INTEGER NOT NULL,           -- 哪一页压出来的
    created INTEGER NOT NULL,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    cleared INTEGER                   -- 睡觉整理后清空的时间
  );
  CREATE TABLE todos (                -- 睡觉时来的消息，醒来再处理
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created INTEGER NOT NULL,
    payload TEXT NOT NULL,
    done INTEGER
  );
  CREATE TABLE schedule (             -- 她自己排的提醒 / 专注
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,               -- remind / focus
    due INTEGER NOT NULL,
    every_ms INTEGER,                 -- 循环间隔；null = 一次
    text TEXT NOT NULL,
    fired INTEGER
  );
  CREATE TABLE claims (               -- 基底神经节：谁在做哪件事
    topic TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    since INTEGER NOT NULL
  );
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `,
  // 2: 专注（上班）可以带时长
  `ALTER TABLE schedule ADD COLUMN minutes INTEGER;`,
  // 3: 事件记忆（长期记忆：事件、时间线、人和东西、关联、原话层、向量、审计）
  MIGRATION_EVENTS,
  // 4: 事件的「下次的日子」（考试、截止、约好的那天；替代事件线文件元数据里的 下次=）
  `ALTER TABLE mem_event ADD COLUMN next_at INTEGER;`,
  // 5: 她手上在做的事（并行大脑：估多久、实际多久、谁在做、派了哪些帮手）。sleep_digest.py 读 owner/topic/started/ended，别改名（docs/contracts/db-read.md）
  `
  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    owner TEXT NOT NULL,              -- main / side-N
    about_min INTEGER,                -- 她自己估的分钟数
    pri TEXT NOT NULL DEFAULT 'T2',
    asked_by TEXT,
    state TEXT NOT NULL,              -- doing / done / follow / paused / dropped
    started INTEGER NOT NULL,
    ended INTEGER,
    took_min INTEGER,                 -- 钟表上花了多久（10-31 晚起；以前是她自报的，不拿来校准）
    helpers TEXT NOT NULL DEFAULT '[]',
    waiting_for TEXT,
    idle_wakes INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX tasks_state ON tasks(state, owner);
  `,
  // 6: 做到什么样才算好：开头定的标准、当初要的原话、回头看了几次、上次还差什么
  `
  ALTER TABLE tasks ADD COLUMN bar TEXT;
  ALTER TABLE tasks ADD COLUMN ask TEXT;
  ALTER TABLE tasks ADD COLUMN looks INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN missing TEXT;
  `,
  // 7: 学习系统：笔记本的页和课的编号、封面向量、话题联想的记录、翻开、纠正、复发、回放用例；任务带上挂了哪几页
  `
  CREATE TABLE learn_item (           -- 笔记本里的页 / 课：编号跟着内容走，文件改名不丢
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,               -- page / lesson
    rel TEXT NOT NULL,                -- 当前相对路径
    hash TEXT NOT NULL,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    gone INTEGER                      -- 文件不见的时间；null = 还在
  );
  CREATE TABLE learn_alias (          -- 旧编号 → 现在的编号（合并、拆分后旧引用还能找到）
    alias TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE TABLE learn_cover (          -- 页的封面向量；hash 变了才重算
    page_id TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    vec BLOB NOT NULL
  );
  CREATE TABLE learn_assoc (          -- 每次话题联想：候选几页、挂了哪些、花了多少
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    region TEXT NOT NULL,
    binding TEXT,
    topic TEXT,
    task_id INTEGER,
    candidates INTEGER NOT NULL,
    mounted TEXT NOT NULL,            -- JSON [{id,p}]
    shadow INTEGER NOT NULL,          -- 1 = 只记录、没真挂上
    skipped TEXT,
    ms INTEGER NOT NULL,
    tokens INTEGER NOT NULL
  );
  CREATE TABLE learn_open (           -- 她翻开了哪页 / 哪本
    at INTEGER NOT NULL,
    region TEXT NOT NULL,
    page_id TEXT,
    book TEXT
  );
  CREATE TABLE learn_correction (     -- 被纠正的那一刻：当时在做什么话题
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    seq INTEGER,
    topic TEXT,
    task_id INTEGER,
    p REAL NOT NULL
  );
  CREATE TABLE learn_recur (          -- 同一课一天只记一次复发
    lesson_id TEXT NOT NULL,
    day TEXT NOT NULL,
    seq INTEGER,
    kind TEXT NOT NULL,               -- mounted / unmounted
    case_id INTEGER,
    PRIMARY KEY (lesson_id, day)
  );
  CREATE TABLE learn_case (           -- 回放用例：这个话题应该挂上哪些
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    topic TEXT NOT NULL,
    expect TEXT NOT NULL,
    source TEXT NOT NULL              -- seed / mounted / unmounted
  );
  CREATE TABLE learn_case_run (       -- 每晚回放的结果
    night TEXT NOT NULL,
    case_id INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    PRIMARY KEY (night, case_id)
  );
  ALTER TABLE tasks ADD COLUMN pages TEXT;  -- JSON 页编号数组
  `,
  // 8: 子事件（事件要有子事件的颗粒度）：大事下面挂子事件，最多三层
  `
  ALTER TABLE mem_event ADD COLUMN parent TEXT;
  CREATE INDEX mem_event_parent ON mem_event(parent);
  `,
  // 9: 人和东西也有重要度（事件、东西、人都要有重要等级，后面做遗忘曲线）。不给默认值：没打分的是 null，撤回老批次时和老记录对得上
  `
  ALTER TABLE mem_entity ADD COLUMN importance INTEGER;
  ALTER TABLE mem_entity ADD COLUMN why TEXT;
  `,
  // 10: 喜欢 / 烦的事：事件可以标成 like / dislike，没标的是 null
  `ALTER TABLE mem_event ADD COLUMN stance TEXT;`,
  // 11: 闸门记账：感官事件进 HH 先落一行（交接即确认），分流、判法、送没送、花了多少 token 都记在这一行；
  // state new → judging → done，重启后接着处理没 done 的。route：fixed-main | hands | rule | judge | fallback
  `
  CREATE TABLE gate_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, ev_id TEXT NOT NULL, src TEXT NOT NULL,
    conv TEXT, sender TEXT, line TEXT NOT NULL, ev TEXT NOT NULL,
    route TEXT, rule TEXT, action TEXT, verdict TEXT, when_ TEXT, gist TEXT, why TEXT, unsure INTEGER,
    seq INTEGER, delivered INTEGER, tokens INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'new'
  );
  CREATE UNIQUE INDEX gate_log_ev ON gate_log(ev_id);
  CREATE INDEX gate_log_ts ON gate_log(ts);
  CREATE INDEX gate_log_conv ON gate_log(conv, ts);
  `,
  // 12: 人物卡 = 通用印象表的一种：一段一行（kind=section），钉住的原话也是一行（kind=quote）；
  // status current / pending（大改等人批）/ superseded / rejected；改一段 = 旧行标 superseded + 新行 current。编号 i0001 起
  `
  CREATE TABLE mem_impression (
    id TEXT PRIMARY KEY, about TEXT NOT NULL, kind TEXT NOT NULL, section TEXT NOT NULL, text TEXT NOT NULL,
    quote_id INTEGER, visibility TEXT NOT NULL, status TEXT NOT NULL, supersedes TEXT, why TEXT NOT NULL DEFAULT '',
    sources TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE UNIQUE INDEX mem_impression_cur ON mem_impression(about, section) WHERE kind = 'section' AND status = 'current';
  CREATE UNIQUE INDEX mem_impression_pin ON mem_impression(about, section, quote_id) WHERE kind = 'quote';
  CREATE INDEX mem_impression_about ON mem_impression(about, status);
  `,
  // 13: 联想多记两样：asked 这次问到的每一题的概率（过没过门槛都记，太低的不记；调门槛只用存下的、不再调 API 回放）；
  // vec 开始做（on_it）那一刻的话题向量（认「同一件事接着做」，把上次翻过的页带上）
  `
  ALTER TABLE learn_assoc ADD COLUMN asked TEXT;   -- JSON {编号: 概率}，概率不到 0.05 的不记；没判断的是 null
  ALTER TABLE learn_assoc ADD COLUMN vec BLOB;     -- 只有 on_it 的行有：512 个 Float32
  `,
  // 14: 新睡眠的记账：一晚一行（sleep_run）、每段每次尝试一行（sleep_stage）、欠着没补的段（sleep_owed，一天一段一行）
  `
  CREATE TABLE sleep_run (
    id INTEGER PRIMARY KEY, night TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, status TEXT NOT NULL,
    flow_hash TEXT NOT NULL, days TEXT NOT NULL DEFAULT '[]', spent_units REAL, quota_before REAL, quota_after REAL, notes TEXT);
  CREATE TABLE sleep_stage (
    id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, day TEXT NOT NULL, stage TEXT NOT NULL, attempt INTEGER NOT NULL,
    model TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, status TEXT NOT NULL,
    calls INTEGER, max_ctx INTEGER, cache_read INTEGER, cache_write INTEGER, input INTEGER, output INTEGER,
    units REAL, changes INTEGER, verdict TEXT, error TEXT);
  CREATE INDEX sleep_stage_run ON sleep_stage(run_id);
  CREATE TABLE sleep_owed (
    day TEXT NOT NULL, stage TEXT NOT NULL, nights INTEGER NOT NULL, problems TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL, updated INTEGER NOT NULL, status TEXT NOT NULL, PRIMARY KEY (day, stage));
  `,
  // 15: 考试的题库：题（exam_q，待定/生效/退役）、每次考的结果（exam_result）、改题的待办（exam_op，落地时执行）；
  // 睡眠记账多记考试的几个数
  `
  CREATE TABLE exam_q (
    id TEXT PRIMARY KEY, q TEXT NOT NULL, gold TEXT NOT NULL, accept TEXT NOT NULL,
    sources TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '{}', importance INTEGER NOT NULL DEFAULT 3,
    kind TEXT NOT NULL, layer TEXT NOT NULL, is_new INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
    day TEXT NOT NULL, stage TEXT NOT NULL, status TEXT NOT NULL, retired_why TEXT,
    created INTEGER NOT NULL, updated INTEGER NOT NULL, last_examined INTEGER);
  CREATE INDEX exam_q_status ON exam_q(status);
  CREATE INDEX exam_q_day_stage ON exam_q(day, stage);
  CREATE TABLE exam_result (
    id INTEGER PRIMARY KEY, q TEXT NOT NULL, day TEXT NOT NULL, stage TEXT NOT NULL, phase TEXT NOT NULL,
    layer TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', answer TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
  CREATE INDEX exam_result_q ON exam_result(q);
  CREATE TABLE exam_op (
    id INTEGER PRIMARY KEY, day TEXT NOT NULL, stage TEXT NOT NULL, kind TEXT NOT NULL, q TEXT NOT NULL,
    value TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, created INTEGER NOT NULL,
    attempt INTEGER);  -- status: pending|applied|dropped；attempt：哪一次尝试记的（没过的那次的改题、退休不落地）
  ALTER TABLE sleep_stage ADD COLUMN questions INTEGER;
  ALTER TABLE sleep_stage ADD COLUMN score_before REAL;
  ALTER TABLE sleep_stage ADD COLUMN score_after REAL;
  ALTER TABLE sleep_stage ADD COLUMN regressions INTEGER;
  ALTER TABLE sleep_stage ADD COLUMN hidden_score REAL;
  ALTER TABLE sleep_stage ADD COLUMN examined INTEGER;  -- 0 没考完 1 考了 null 不考
  ALTER TABLE sleep_run ADD COLUMN save_level INTEGER;
  `,
  // 16：把关每日额度按真实花费记账——小判断每次调用换算成睡眠预算的「单位」，记在这批第一行（老行是 NULL，按 tokens 估）
  `
  ALTER TABLE gate_log ADD COLUMN units REAL;
  `,
  // 17：夜里整理多人模式：每次尝试挂在哪个脑区（region）、谁做的（persona）、谁审的（reviewer）、怎么定的（decision：rule:/coord: + pass/redo/defer）、
  // 这一次各花了多少（cost：{"do","review","audit","exam","coord"} 的单位）；不是多人模式都是 NULL
  `
  ALTER TABLE sleep_stage ADD COLUMN region TEXT;
  ALTER TABLE sleep_stage ADD COLUMN persona TEXT;
  ALTER TABLE sleep_stage ADD COLUMN reviewer TEXT;
  ALTER TABLE sleep_stage ADD COLUMN decision TEXT;
  ALTER TABLE sleep_stage ADD COLUMN cost TEXT;
  `,
  // 18：笔记之间的连线（learning/graph.ts）：ref 页里提到（有方向 a→b）、
  // co 同一件事里一起翻过、event 同一件事的经过里写到（这两种没方向，a < b）；夜里整张重算，不改她的页
  `
  CREATE TABLE learn_link (
    a TEXT NOT NULL, b TEXT NOT NULL, kind TEXT NOT NULL, weight REAL NOT NULL, n INTEGER NOT NULL, updated INTEGER NOT NULL,
    PRIMARY KEY (a, b, kind));
  CREATE INDEX learn_link_b ON learn_link(b);
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  if (path !== ":memory:") refuseLive("数据库", path);   // 测试里开不了线上的库（11-13）
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number } | undefined;
  let v = row?.v ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (v) VALUES (0)").run();
  while (v < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]!);
      v += 1;
      db.prepare("UPDATE schema_version SET v = ?").run(v);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

export function kvGet(db: Db, k: string): string | undefined {
  const r = db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
  return r?.v;
}

export function kvSet(db: Db, k: string, v: string): void {
  db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
}

/** 类型化查询：SQLite 返回的是通用行，这里集中做一次转换。 */
export function all<T>(db: Db, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(db: Db, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}
