// 对照工具测试用的小快照：manifest；状态目录（config.json，用 openDb 建的库和几条 central）；工作区（树要的人格文件、名单、一本手册、空的闸门规则）。
// 名字全是中性的：她叫阿青，主人老林，访客小禾。manifest 的 home 是个不存在的假「真 home」：配置里的路径都写在它下面，dump 时换到工作副本。
// 后面的测试要别的数据：给 config 盖配置、给 central 换库里的记录（extraCentral 接在后面再记几行）、给 files 往工作区加文件、给 registry 换名单、给 gateLog 往闸门账上加行、
// 给 takenAt 换快照的时刻（只能往后挪：库里的记录都在 TAKEN_AT 以前）、给 relaySpool 往状态目录的 relay-spool 里放 hhd 不在时 relay 存下的消息。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deepMerge } from "../../src/config.ts";
import { openDb } from "../../src/store/db.ts";
import { CentralMemory, type Kind } from "../../src/memory/central.ts";
import { Epochs } from "../../src/epoch/epoch.ts";

/** 快照的时刻（北京时间 10:00）：虚拟时钟从这里起 */
export const TAKEN_AT = Date.UTC(2026, 10, 1, 2, 0);
export const TZ = "Asia/Shanghai";
/** 假真 home 下面的状态目录、工作区（相对 home） */
export const STATE_REL = ".aqing-hh";
export const WORKSPACE_REL = ".agent/workspace";

export interface CentralRow { src: string; kind: Kind; text: string; meta?: Record<string, unknown>; at: number }

/** 闸门账上的一行（落定了的）：ev 是落库时的事件（src、id、line、text 必有），at 是落库时刻 */
export interface GateRow { at: number; ev: { src: string; id: string; line: string; text: string; conv?: string; sender?: string; [k: string]: unknown } }

export interface SnapshotOpts {
  /** 盖在测试配置上（按字段合并，跟 HH_CONFIG 一样） */
  config?: Record<string, unknown>;
  /** 库里预先有的 central（不给就是下面那几条） */
  central?: CentralRow[];
  /** 接在 central（或默认那几条）后面再记的行（工具调用这种：不用把默认的抄一遍） */
  extraCentral?: CentralRow[];
  /** 工作区里另加的文件：相对工作区的路径 → 内容 */
  files?: Record<string, string>;
  /** 名单（不给就是下面那份：老林、小禾） */
  registry?: Record<string, unknown>;
  /** 闸门账上预先有的行（不给就没有） */
  gateLog?: GateRow[];
  /** manifest 里快照的时刻（不给就是 TAKEN_AT；不能早于它） */
  takenAt?: number;
  /**
   * hhd 不在时 relay 存下、还没补交的渠道消息（不给就没有）：照 relay/logic.mjs 的 spool() 写进 <状态目录>/relay-spool/，
   * 一条一个文件 {v: 1, at, message}，文件名开头是存的时刻（src/relaySpool.ts 按它排先后）
   */
  relaySpool?: Array<{ at: number; message: Record<string, unknown> }>;
}

export interface Snapshot {
  /** --data 给它 */
  data: string;
  /** manifest 里的 home（假的真 home，不存在） */
  home: string;
}

const PERSONA: Record<string, string> = {
  "IDENTITY.md": "# 我是谁\n\n我是阿青，住在一台电脑里。\n",
  "SOUL.md": "# 性格\n\n说话直，爱喝茶。\n",
  "USER.md": "# 老林\n\n老林是我的主人，做木工。\n",
  "MEMORY.md": "# 记着的事\n\n- 老林的工作台在窗边。\n",
  "AGENTS.md": "# 怎么做事\n\n先想清楚再动手。\n",
  "SOUL.memory.md": "# 长期记忆\n\n- 小禾是老林的邻居。\n",
  "ledger/SOUL.md": "# 账本\n\n- 下周三老林要去集市。\n",
};

const REGISTRY = {
  laolin: { name: "老林", privacy: "owner", senders: ["qq:owner-0001", "0000000000000000000000000000A001"], sessionKeys: ["agent:main:main"] },
  xiaohe: { name: "小禾", privacy: "guest", senders: ["qq:guest-0002"] },
};

const SKILL = "---\nname: tidy-notes\ndescription: 把散的笔记理成一页\n---\n# 整理笔记\n\n1. 先按日期排。\n2. 重复的合并。\n";

const CENTRAL: CentralRow[] = [
  { src: "外界", kind: "input", text: "老林：今天下雨，记得把木料收进来", meta: { from: "老林", channel: "qq", human: true, replyTo: null }, at: TAKEN_AT - 50 * 60_000 },
  { src: "main", kind: "think", text: "木料在院子里，得提醒他盖布", at: TAKEN_AT - 49 * 60_000 },
  { src: "main", kind: "say", text: "收好了，顺手盖了块布", at: TAKEN_AT - 48 * 60_000 },
  { src: "外界", kind: "input", text: "小禾：阿青，周三集市几点开？", meta: { from: "小禾", channel: "qq", human: true, replyTo: null }, at: TAKEN_AT - 20 * 60_000 },
];

/**
 * 一份记录里场景自己记的那一段：到最后一条 state 为止。后面只有收尾（w.close）时系统关掉各个会话留下的 close；
 * 没有 state 的记录（只渲染的场景、跳过的场景）原样返回
 */
export function upToState<T extends { kind: string }>(recs: T[]): T[] {
  const last = recs.findLastIndex((r) => r.kind === "state");
  return last < 0 ? recs : recs.slice(0, last + 1);
}

const write = (p: string, text: string): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

/** 在 root 下建快照（root 是测试自己的临时目录） */
export function buildSnapshot(root: string, o: SnapshotOpts = {}): Snapshot {
  const data = join(root, "snapshot");
  const home = join(root, "live-home");
  const at = (rel: string): string => join(data, "home", rel);
  const ws = join(home, WORKSPACE_REL);
  if (o.takenAt !== undefined && o.takenAt < TAKEN_AT) throw new Error("fixture: takenAt must not be earlier than TAKEN_AT");
  write(join(data, "manifest.json"), `${JSON.stringify({ id: "fixture-1", takenAt: o.takenAt ?? TAKEN_AT, home, tz: TZ })}\n`);

  // 树的默认配置里指到机器上真目录的路径全改到假 home 下面
  const config = deepMerge({
    id: "aqing",
    lang: "zh",
    workspace: ws,
    personaFiles: Object.keys(PERSONA),
    stateDir: join(home, STATE_REL),
    schedule: { timezone: TZ },
    skills: { roots: [join(ws, "skills")], names: [], discover: join(ws, "skills"), exclude: [] },
    learning: { root: join(ws, "skills") },
    browser: { userDataDir: join(home, ".agent/browser/user-data") },
    kernel: { mcpServers: { bili: { type: "stdio", command: join(ws, "plugins/bili/bin/bili-mcp"), args: [] } } },
    names: { me: "阿青", owner: "老林", notMe: [] },
    gate: { defaultWant: "有人在跟我说话、提到我或老林的时候" },
    channels: { whatsapp: { via: "gateway" }, qqbot: { via: "gateway" } },
    tools: { extra: ["computer"] },
    // the modules a role has once it has moved over (package 18, stage 1)
    modules: { goals: { enabled: true }, stickers: { enabled: true }, "load-guard": { enabled: true } },
  }, o.config ?? {});
  write(at(join(STATE_REL, "config.json")), `${JSON.stringify(config, null, 2)}\n`);

  const db = openDb(at(join(STATE_REL, "hh.db")));
  const rows = [...(o.central ?? CENTRAL), ...(o.extraCentral ?? [])];
  const epoch = new Epochs(db, () => (rows[0]?.at ?? TAKEN_AT) - 60_000).begin("boot", 1);
  const central = new CentralMemory(db);
  for (const r of rows) central.append(epoch.id, r.src, r.kind, r.text, r.meta ?? null, r.at);
  const gate = db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev, route, action, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'judge', 'judge', 'done')");
  for (const g of o.gateLog ?? []) gate.run(g.at, g.ev.id, g.ev.src, g.ev.conv ?? null, g.ev.sender ?? null, g.ev.line, JSON.stringify(g.ev));
  db.close();
  (o.relaySpool ?? []).forEach((r, i) => write(at(join(STATE_REL, "relay-spool", `${String(r.at).padStart(15, "0")}-1-${String(i).padStart(6, "0")}.json`)), JSON.stringify({ v: 1, at: r.at, message: r.message })));

  const files: Record<string, string> = {
    ...PERSONA,
    "memory/people/registry.json": `${JSON.stringify(o.registry ?? REGISTRY, null, 2)}\n`,
    "skills/tidy-notes/SKILL.md": SKILL,
    "gate.json": `${JSON.stringify({ rules: [] })}\n`,
    ...o.files,
  };
  for (const [rel, text] of Object.entries(files)) write(at(join(WORKSPACE_REL, rel)), text);
  return { data, home };
}
