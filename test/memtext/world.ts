// 记忆文字钉子的夹具（Task 0）：一个内存库 + 固定时钟的中央记忆，和几组「场景」（往里写一串固定的记录，回写进去的那些条）。
// 导入这个文件什么都不建：库、记忆对象都在 inWorld 里建、用完（不管成不成）关掉；不碰环境变量、时区；文件系统只有「情境」那一组夹具碰（sitDirs / putFile，只写调用方给的根目录，根由 calls.ts 的 renderAll 建、删）。
// 全是编的：名字只用 阿青 / 老林 / 小禾，号码、路径、网址都是编的；每段文字都不一样、够长，调错参数位置指纹就变。
// 库用 openDb(":memory:")（仓库里拒绝线上路径的守卫只管文件路径），时钟固定在 T0，时区一律显式传 "UTC"（个别调用另传）。
import "../names.ts";
import { all, one, openDb } from "../../src/store/db.ts";
import type { Db } from "../../src/store/db.ts";
import { CentralMemory } from "../../src/memory/central.ts";
import type { Entry, Kind, Labeler } from "../../src/memory/central.ts";
import { EventStore } from "../../src/memory/events/store.ts";
import { MemIndex } from "../../src/memory/events/index.ts";
import type { QuoteIn } from "../../src/memory/events/index.ts";
import { EventRecall } from "../../src/memory/events/recall.ts";
import type { EntryRow, EventRow } from "../../src/memory/events/schema.ts";
import type { RenderEvent } from "../../src/memory/events/render.ts";
import { EMBED_DIMS } from "../../src/memory/events/embed.ts";
import type { Embedder } from "../../src/memory/events/embed.ts";
import { parseTemplate } from "../../src/memory/events/people.ts";
import type { PeopleTemplate } from "../../src/memory/events/people.ts";
import { defaults } from "../../src/lang/zh/defaults.ts";
import { FixtureError } from "../textpins/lib.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Situation } from "../../src/memory/situation.ts";
import type { Correction, Said } from "../../src/memory/situation.ts";
import type { NoteAssociator } from "../../src/learning/associate.ts";
import { EventMemory } from "../../src/memory/events/memory.ts";
import type { LikeArgs, MemLog } from "../../src/memory/events/memory.ts";
import { Logger } from "../../src/log.ts";
import type { Runner } from "../../src/util/run.ts";
import goalsModule from "../../modules/goals/module.ts";
import { runHook } from "../../src/modules/load.ts";
import type { ModuleContext } from "../../src/modules/api.ts";

/** 2026-11-13 02:00 UTC */
export const T0 = Date.UTC(2026, 10, 13, 2, 0);
export const MIN = 60_000;
export const TZ = "UTC";

export interface World {
  db: Db;
  mem: CentralMemory;
  /** T0 之后第 min 分钟写一条（纪元 1）；返回写进去的那条，也记在 log 里 */
  put(min: number, src: string, kind: Kind, text: string, meta?: Record<string, unknown> | null): Entry;
  log: Entry[];
}

/** 建一个新世界跑 fn（同步），跑完关库。每条调用各建各的：编号从 1 起按写入顺序，所以是确定的 */
export function inWorld<T>(fn: (w: World) => T): T {
  const db = openDb(":memory:");
  try {
    const mem = new CentralMemory(db, () => T0);
    const log: Entry[] = [];
    const put: World["put"] = (min, src, kind, text, meta) => {
      const e = mem.append(1, src, kind, text, meta ?? null, T0 + min * MIN);
      log.push(e);
      return e;
    };
    return fn({ db, mem, put, log });
  } finally {
    db.close();
  }
}

/** 一段确定的长文字：种子句带序号重复，截到正好 n 个字（只有 BMP 字符） */
export function pad(seed: string, n: number): string {
  let s = "";
  for (let i = 1; s.length < n; i++) s += `${seed}（${i}）`;
  return s.slice(0, n);
}

/** 标来源的人：主线是空的（就是自己）；别的带上这一条的编号（真的标注会带「弄 X 时」，这里用编号证明 e 传到了） */
const LABELS: Record<string, string> = { main: "", system: "", "side-a": "另一头", "helper-b": "帮手" };
export const label: Labeler = (src, e) => {
  const l = LABELS[src] ?? src;
  return l && e ? `${l}（弄 ${e.seq} 时）` : l;
};

// ---------- 场景：渲染（renderMemory） ----------

/** 每一种输入：感官、两种提醒、带不带标签 / 渠道的人、没有来源、来源不是字符串、很长的一条、隔了半天的一条 */
export function sceneInputs(w: World): Entry[] {
  // from 是代码认的记号：「感官」整个相等
  w.put(0, "external", "input", "屏幕右下角弹出一条新通知：老林刚发来一张傍晚拍的照片，配文说今天的云厚得像一团被压扁的棉花糖。", { from: "感官" });
  // from 是代码认的记号：带「提醒」二字的走「我想起来」，开头的「你」换成「我」
  w.put(5, "external", "input", "到点了：把阿青上周托我查的那趟周六早班车的时刻表整理好，发到她的私聊里。", { from: "你自己排的提醒" });
  w.put(50, "external", "input", "每月第二个周三要给小禾的社团交活动场地的押金，别忘了先问清楚收据的抬头写谁。", { from: "月度提醒" });
  w.put(52, "external", "input", "我这周六想去海边看日出，你要不要一起？顺便帮我想想带哪只相机，旧的那只电池不太行了。", { from: "阿青", tag: "私聊", channel: "whatsapp" });
  w.put(70, "external", "input", "刨子的事我问过了，仓库那边说在第三格最里面，周日我自己去拿，不用你们特地跑一趟。", { from: "老林", tag: "周末小群" });
  w.put(100, "external", "input", "社团新到的那批二手吉他弦有两根发涩，要不要先别装，等我周三回去再一起看看？", { from: "小禾", channel: "qqbot" });
  w.put(130, "external", "input", "晚上的汤我多放了半勺糖，你尝尝看会不会太甜，不合口味的话下次我再少放一点。", { from: "阿青" });
  w.put(160, "external", "input", "一条没有任何来源信息的消息：门口的快递柜今天换了新的取件码，短信里发的是旧的那一个。", null);
  w.put(190, "external", "input", "来源和渠道都不是字符串的一条：窗台上的薄荷被风吹倒了，花盆边缘裂了一道细细的缝。", { from: 7, channel: 9, tag: 3 });
  w.put(220, "external", "input", pad("小禾说起社团新来的那批旧乐器和它们各自的毛病", 420), { from: "小禾", tag: "社团", channel: "qqbot" });
  // 隔了二十多个小时：跨天，时间标记带日期
  w.put(1350, "external", "input", "昨晚睡得很晚，今早起来才看到你发的消息，早班车的时间我对过了，七点四十那一班最合适。", { from: "阿青" });
  return w.log.slice();
}

/** 帮手的回报：派活的那部分看原样，别的部分只看开头 */
export function sceneHelper(w: World): Entry[] {
  w.put(0, "main", "say", pad("我先把阿青的行程拆开，让帮手分头去查车次和仓库", 60));
  w.put(1, "external", "input", pad("帮手甲回报：车次表已经查完，周六有三班早车", 420), { from: "帮手甲", hands: true, owner: "helper-b" });
  w.put(2, "external", "input", pad("帮手乙回报：老林借走的刨子登记在仓库第三格", 260), { from: "帮手乙", hands: true });
  w.put(3, "external", "input", pad("帮手丙回报：小禾的社团押金单已经归档到本月", 330), { from: "帮手丙", hands: true, owner: "side-a" });
  w.put(4, "external", "input", pad("阿青说的话也很长，但她不是帮手", 330), { from: "阿青" });
  return w.log.slice();
}

/** 每一种记录：想、说（有一条没发出去）、记下、下意识想通的、各种写法的动作、结果、系统；还有两条「没人收」标记 */
export function sceneKinds(w: World): Entry[] {
  w.put(0, "main", "think", "先想想阿青说的海边的事，周六的天气预报还没出来，不能现在就答应得太满。");
  w.put(3, "side-a", "think", "另一头在想：老林那把刨子的事拖了两周了，该有个了结，不然他下次开口会不好意思。");
  const unsentSay = w.put(6, "main", "say", "好呀，周六我陪你去，到时候我们五点半在你家楼下碰头。");
  w.put(6, "main", "note", "（上面这段没发给任何人：这一轮是自己醒的，没有谁在等回复。）", { unsent: true, of: [unsentSay.seq] });
  w.put(9, "main", "say", "老林，刨子的事你不用着急，仓库那边我已经替你问好了。");
  w.put(12, "main", "note", "记下：小禾的社团这个月要交的押金是三百八，收据抬头写社团全称。");
  w.put(15, "side-a", "think", "想通了：阿青其实不是想看日出，是想有人陪她走一段长一点的路。", { insight: true });
  w.put(18, "main", "act", `message ${JSON.stringify({ to: "阿青", text: "周六五点半，楼下见。" })}`, { tool: "message", id: "k1" });
  w.put(19, "main", "result", "已发出，对方回了一个笑脸。", { id: "k1" });
  w.put(21, "main", "act", `read_file ${JSON.stringify({ path: "/ws/notes/qing.md" })}`);   // 没有 meta.tool：工具名取文字的第一个词
  w.put(24, "main", "act", `Bash ${JSON.stringify({ command: "ls /ws/notes" })}`, { tool: "Bash", id: "k2" });
  w.put(25, "main", "result", "qing.md\nzhou.md\nhe.md", { id: "k2", error: false });
  w.put(27, "main", "act", `mcp__other__lookup ${JSON.stringify({ query: "老林的刨子" })}`, { tool: "mcp__other__lookup" });
  w.put(30, "main", "act", JSON.stringify({ id: "s-9", name: "举着伞的小熊" }), { tool: "sticker" });   // 文字不以工具名开头：原样
  w.put(33, "main", "result", "命令超时了，没有拿到任何输出，重试之后才成功。", { id: "k3", error: true });
  w.put(36, "side-a", "note", "记下：另一头替我把周日的菜单对了一遍。");
  w.put(39, "system", "system", "上下文刚被压缩过一次，前面的经过折成了摘要。");
  w.put(42, "main", "note", "（没有 of 的标记）", { unsent: true, of: "x" });   // of 不是数组：不算标记谁
  w.put(45, "side-a", "say", "另一头说：周日的菜单我对过了，没问题。");
  return w.log.slice();
}

/** 折叠 / 同步视角用的：三个来源（main 是看的人，side-a 是 fullFor，helper-b 是帮手），各种动作和结果，有的有结果有的没有 */
export function sceneTools(w: World): Entry[] {
  const act = (min: number, src: string, tool: string, args: Record<string, unknown>, id: string): Entry =>
    w.put(min, src, "act", `${tool} ${JSON.stringify(args)}`, { tool, id });
  w.put(0, "external", "input", pad("阿青发来的一条消息，问周六的早班车到底几点", 90), { from: "阿青", channel: "whatsapp" });
  w.put(3, "main", "say", pad("我在看车次，马上回你", 40));
  w.put(6, "side-a", "think", `${pad("另一头在想周六早班车的几种坐法", 300)}\n\n   ${pad("接着想换乘", 60)}`);
  w.put(9, "side-a", "think", "另一头短短地想了一下：先看时刻表。");
  act(12, "side-a", "read_file", { file_path: "/ws/notes/qing.md", description: "读阿青留下的出行笔记" }, "r1");
  w.put(13, "side-a", "result", pad("阿青的出行笔记：周六想去海边，要带旧相机", 520), { id: "r1" });
  act(15, "side-a", "Bash", { command: pad("grep -rn 车次 /ws/notes 然后整理", 120) }, "r2");
  w.put(16, "side-a", "result", "grep: /ws/notes: 没有这个文件或目录", { id: "r2", error: true });
  act(18, "side-a", "grep", { pattern: "老林", path: "/ws/notes" }, "r3");
  w.put(19, "side-a", "result", `${pad("找到太多结果，输出被截断了", 320)}\n  末尾还有换行`, { id: "r3", error: true });
  act(21, "side-a", "web_fetch", { url: "https://example.test/timetable" }, "r4");   // 一直没有结果
  w.put(23, "side-a", "result", pad("一个没有对上任何动作的结果", 90), { id: "r9" });
  w.put(24, "side-a", "result", "一个没有对上任何动作的出错结果：连接被重置了", { id: "r10", error: true });
  act(25, "side-a", "message", { to: "阿青", text: "我在查车次，稍等。" }, "r5");   // 她自己的工具：入参全文保留
  w.put(26, "side-a", "result", "已发出。", { id: "r5" });
  const unsentSay = w.put(27, "side-a", "say", "另一头说：车次我替你查好了，一会儿发给你。");
  w.put(28, "side-a", "note", "（上面这段没发给任何人）", { unsent: true, of: [unsentSay.seq] });
  act(30, "helper-b", "write_file", { path: "/ws/out/plan.md", content: pad("周六行程草稿：五点半出门，七点四十上车", 500) }, "r6");
  w.put(31, "helper-b", "result", pad("写入成功，文件已更新", 70), { id: "r6" });
  act(33, "main", "read_file", { path: "/ws/notes/zhou.md" }, "r7");
  w.put(34, "main", "result", pad("老林的笔记：刨子在仓库第三格", 150), { id: "r7" });
  w.put(36, "main", "think", pad("我自己的想法：先答应阿青，再核对时间", 260));
  w.put(38, "side-a", "think", "想通了：车次不是问题，问题是她想不想一个人去。", { insight: true });
  w.put(40, "side-a", "act", `sticker ${JSON.stringify({ name: "举着伞的小熊" })}`, { id: "r8" });   // 没有 meta.tool：工具名取第一个词
  w.put(41, "side-a", "result", "已发出。", { id: "r8" });
  act(42, "helper-b", "NotebookEdit", { notebook_path: "/ws/nb/a.ipynb", query: "把第二格的说明改成「周六出发」" }, "r11");
  w.put(43, "helper-b", "result", pad("笔记本已更新", 40), { id: "r11" });
  act(44, "helper-b", "task", { description: "读一段带\n换行和\"引号\"的说明" }, "r12");
  w.put(45, "main", "note", "记下：另一头和帮手各自查了一半，我来合起来。");
  w.put(48, "helper-b", "think", pad("帮手在想怎么把两份行程合成一份", 120));
  return w.log.slice();
}

/** 一串隔着不同间隔的记录，给时间标记用：同半小时内、刚好半小时、隔了几个小时、跨天 */
export function sceneMarks(w: World, minutes: readonly number[]): Entry[] {
  for (const m of minutes) w.put(m, "main", "say", pad(`第 ${m} 分钟说的话`, 40 + (m % 7)));
  return w.log.slice();
}

// ---------- 场景：想起原话（recallCentral） ----------

export interface RecallWorld {
  rows: Record<"fromQing" | "noMeta" | "emptyMeta" | "say" | "unsentSay" | "sentName" | "sentTo" | "sentNeither" | "note" | "act" | "result" | "long" | "think" | "system" | "huge", Entry>;
}

/** 关键词「蓝莓果酱」散在各种记录里；huge 是最后一条（一万字以上，给 show 分页），think / system 只有 show 找得到 */
export function sceneRecall(w: World): RecallWorld {
  // 凌晨两点的一条：她的一天从凌晨 4 点算，所以 day 2026-11-13 不含它
  w.put(0, "external", "input", "凌晨两点还没睡，在想蓝莓果酱那一罐到底放没放糖，明早得问问老林。", { from: "老林" });
  const fromQing = w.put(180, "external", "input", "阿青说蓝莓果酱已经熬好了，装了三个小罐子，周六去海边的时候带一罐路上吃。", { from: "阿青", sessionKey: "s-qing" });
  const noMeta = w.put(185, "external", "input", "没有来源的一条：门口放着一罐蓝莓果酱，不知道是谁放的，上面贴着一张手写的便条。", null);
  const emptyMeta = w.put(190, "external", "input", "来源是空对象的一条：蓝莓果酱的标签被水泡花了，只看得清最后两个字。", {});
  const say = w.put(200, "main", "say", "蓝莓果酱我留了一罐给老林，等他周日来拿刨子的时候一起带走。");
  const unsentSay = w.put(205, "main", "say", "蓝莓果酱的配方我写在厨房的小本子上了，下次你想做可以照着来。");
  w.put(206, "main", "note", "（上面这段没发给任何人：这一轮是自己醒的，没有谁在等回复。）", { unsent: true, of: [unsentSay.seq] });
  const sentName = w.put(210, "main", "note", "（发给 阿青）蓝莓果酱我替你收好了，周六一早带上。", { sent: true, to: "+6155500020", name: "阿青" });
  const sentTo = w.put(215, "main", "note", "（发给 老林）蓝莓果酱给你留了一罐，刨子的事周日再说。", { sent: true, to: "+6155500021" });
  const sentNeither = w.put(220, "main", "note", "（发给 小禾）蓝莓果酱的事别告诉阿青，我想给她一个惊喜。", { sent: true });
  const note = w.put(225, "side-a", "note", "蓝莓果酱的保质期在便条上写着：冷藏三周，开罐后尽快吃完。");
  const act = w.put(230, "main", "act", `jot_down ${JSON.stringify({ text: "买蓝莓" })}`, { tool: "jot_down", id: "a1" });
  const result = w.put(231, "main", "result", "已记下：买蓝莓。", { id: "a1" });
  const long = w.put(240, "external", "input", pad("小禾发来一大段话讲蓝莓果酱的几种做法和她家的旧配方", 700), { from: "小禾", channel: "qqbot" });
  const think = w.put(245, "main", "think", "想了想：蓝莓果酱的糖是不是放少了，要不要等阿青尝过再说。");
  const system = w.put(250, "system", "system", "系统提示：中央记忆刚做过一次整理。");
  const huge = w.put(260, "main", "say", pad("一条很长很长的话，用来试分页", 61_234));
  return { rows: { fromQing, noMeta, emptyMeta, say, unsentSay, sentName, sentTo, sentNeither, note, act, result, long, think, system, huge } };
}

// ---------- 场景：事件记忆的渲染（renderEvents，纯数据，不用库） ----------
// renderEvents 吃的是现成的 RenderEvent（事件行、经过行、人、关联），不碰库，所以这里直接造数据：这样才造得出库的写法造不出的状态
// （比如代码不认识的状态、没有标题以外内容的经过）。事件用的编号、标题、经过的文字各不相同；时间都从 EV_NOW 往回数。

export const DAY = 86_400_000;
/** 2026-11-13 09:00 UTC */
export const EV_NOW = Date.UTC(2026, 10, 13, 9, 0);
/** EV_NOW 之前 days 天 */
export const ago = (days: number): number => EV_NOW - Math.round(days * DAY);

type EvOver = Omit<Partial<EventRow>, "id" | "status"> & { status?: string };
/** 一件事的行：默认重要度 2、进行中、一天前有进展；总结和一句话按标题生成；status 可以写代码不认识的 */
export function evRow(id: string, title: string, over: EvOver = {}): EventRow {
  const { status, ...rest } = over;
  return {
    id, title, summary: pad(`${title}的总结：阿青托我把这件事盯到周六`, 64), gist: pad(`${title}的一句话`, 26), why: "", importance: 2,
    status: (status ?? "ongoing") as EventRow["status"], started_at: ago(3), ended_at: ago(1), pinned: 0, superseded_by: null, thread_path: null,
    created_at: ago(4), updated_at: ago(1), next_at: null, parent: null, stance: null, ...rest,
  };
}

type EnOver = Omit<Partial<EntryRow>, "id" | "event_id" | "at" | "title">;
/** 一条经过：原文、一句话、标题三层各不相同；created_at 默认等于 at */
export function enRow(id: string, eventId: string, at: number, title: string, over: EnOver = {}): EntryRow {
  return {
    id, event_id: eventId, at, until: null, kind: "happened", full: pad(`${title}的原文：老林说周日去仓库拿刨子`, 72), gist: pad(`${title}的一句话`, 24), title,
    source: "[]", corrects: null, created_at: at, ...over,
  };
}

export function reEv(ev: EventRow, over: Partial<Omit<RenderEvent, "ev">> = {}): RenderEvent {
  return { ev, entries: [], people: [], links: [], ...over };
}

/** 五种状态各一件，外加一个代码不认识的状态（原样写出来） */
export function sceneStatuses(): RenderEvent[] {
  return [
    reEv(evRow("e0001", "周六去海边的行程")),
    reEv(evRow("e0002", "社团押金的交接", { status: "done" })),
    reEv(evRow("e0003", "旧吉他弦的更换", { status: "paused" })),
    reEv(evRow("e0004", "早班车的备选方案", { status: "superseded" })),
    reEv(evRow("e0005", "记错了的仓库格子", { status: "retired" })),
    reEv(evRow("e0006", "刨子的借用记录", { status: "archived" })),
  ];
}

/** 喜欢 / 烦各自在进行中和不在进行中，一件撤掉的（不算数，不带记号），一件没有态度的 */
export function sceneStances(): RenderEvent[] {
  return [
    reEv(evRow("e0011", "喜欢海边的日出", { stance: "like" })),
    reEv(evRow("e0012", "喜欢旧相机的声音", { stance: "like", status: "done" })),
    reEv(evRow("e0013", "烦周日早上的雨", { stance: "dislike" })),
    reEv(evRow("e0014", "烦吉他弦发涩", { stance: "dislike", status: "paused" })),
    reEv(evRow("e0015", "记错了的喜欢", { stance: "like", status: "retired" })),
    reEv(evRow("e0016", "没有态度的一件事")),
  ];
}

/** 括号里的各段：下次的日子（在一天内 / 更早 / 没有）、被谁取代、属于哪件大事、人（0 到 3 个）、在哪聊的 */
export function sceneMeta(): RenderEvent[] {
  const people = ["阿青", "老林", "小禾"];
  return [
    reEv(evRow("e0021", "社团年底的聚餐", { next_at: EV_NOW + 6 * DAY }), { parent: { id: "e0020", title: "社团这一学期的活动" }, people, origin: "在小禾的社团群里" }),
    reEv(evRow("e0022", "改过的行程草稿", { next_at: ago(3), superseded_by: "e0023" })),
    reEv(evRow("e0023", "替换它的行程草稿", { status: "done", next_at: ago(0.5) }), { people: ["老林"], origin: "在阿青的私聊里" }),
    reEv(evRow("e0024", "什么括号内容都没有的事")),
  ];
}

/** 三个清晰度（一天前 / 二十天前 / 一百天前有进展）、从没有进展过、钉住的老事（按重要度 5 写总结）、只写标题的 */
export function sceneLevels(): RenderEvent[] {
  return [
    reEv(evRow("e0031", "刚发生不久的一件事")),
    reEv(evRow("e0032", "二十天前的一件事", { ended_at: ago(20) })),
    reEv(evRow("e0033", "一百天前的一件事", { ended_at: ago(100) })),
    reEv(evRow("e0034", "没有进展过的一件事", { ended_at: null, created_at: ago(2) })),
    reEv(evRow("e0035", "钉住的一件老事", { ended_at: ago(400), pinned: 1, importance: 3 })),
    reEv(evRow("e0036", "只写标题的一件事"), { brief: true }),
  ];
}

/** 一件事的时间线（新的在前）：全文 / 一句话 / 标题三种清晰度，一条淡到折叠（不出现），一条很老的原话（至少留一句话） */
export function sceneEntries(): RenderEvent[] {
  const e = "e0041";
  return [reEv(evRow(e, "周六早班车的核对"), {
    people: ["阿青"],
    entries: [
      enRow("n00101", e, ago(0.2), "小禾回了消息"),
      enRow("n00102", e, ago(3), "阿青改了出发时间"),
      enRow("n00103", e, ago(15), "老林查到末班车"),
      enRow("n00104", e, ago(90), "第一次问车次"),
      enRow("n00105", e, ago(500), "太老的一条"),
      enRow("n00106", e, ago(520), "很久以前她说过的原话", { kind: "said" }),
    ],
  })];
}

/** 四条经过：最新的一条，和同一天的三条（折叠起来只剩一个日子） */
export function sceneFoldDay(): RenderEvent[] {
  const e = "e0042";
  return [reEv(evRow(e, "社团押金的收据"), {
    entries: [
      enRow("n00111", e, ago(0.3), "收据抬头问清了"),
      enRow("n00112", e, ago(5), "小禾把押金交了"),
      enRow("n00113", e, ago(5.1), "阿青去银行取现金"),
      enRow("n00114", e, ago(5.2), "老林说先垫着"),
    ],
  })];
}

/** 带更正的时间线：更正读起来一样 / 不一样、原文自带日期的两种、一条被更正两次（后写的算）、更正找不到原条目、一句话层读起来一样 */
export function sceneCorrections(): RenderEvent[] {
  const e = "e0043";
  const fix = (id: string, of: string, at: number, title: string, over: EnOver): EntryRow => enRow(id, e, at, title, { kind: "correction", corrects: of, ...over });
  return [reEv(evRow(e, "各种更正的写法"), {
    entries: [
      enRow("n00201", e, ago(2), "核对了周日的菜单"),
      fix("n00202", "n00203", ago(2.5), "阿青的早班车", { source: "[\"why:出处补上了\"]", created_at: ago(1.5) }),
      enRow("n00203", e, ago(2.5), "阿青的早班车"),
      fix("n00204", "n00205", ago(3), "老林的刨子在第三格", { created_at: ago(1.4) }),
      enRow("n00205", e, ago(3), "老林的刨子在第几格"),
      fix("n00206", "n00207", ago(3.5), "海边的集合点", { full: "11-09 下午阿青说周六去海边，五点半在楼下碰头。", created_at: ago(1.3) }),
      enRow("n00207", e, ago(3.5), "海边的集合点", { full: "11-09 下午阿青说周六去海边，五点半出门。" }),
      fix("n00208", "n00209", ago(4), "小禾的押金", { full: "11-08 小禾把押金交了。", gist: "小禾交了押金，更正过出处", created_at: ago(1.2) }),
      enRow("n00209", e, ago(4), "小禾的押金", { full: "11-08 小禾把押金交了。" }),
      fix("n00210", "n00212", ago(4.5), "社团名单的第二版", { created_at: ago(2.1) }),
      fix("n00211", "n00212", ago(4.5), "社团名单的第三版", { created_at: ago(2.0) }),
      enRow("n00212", e, ago(4.5), "社团名单的第一版"),
      fix("n00213", "n99999", ago(5), "找不到原条目的更正", { created_at: ago(1.1) }),
      enRow("n00216", e, ago(6), "海边的日子定下了", { full: "11-07 阿青定下了周六去海边。" }),   // 没有更正、原文自带日期：不加日子前缀
      fix("n00214", "n00215", ago(20), "三周前的一条", { full: pad("三周前那条的更正全文，换了一种说法", 60), created_at: ago(1.0) }),
      enRow("n00215", e, ago(20), "三周前的一条"),
    ],
  })];
}

/** 每种关联各一条（含代码不认识的）；第一件有五条（只写前四条），第二件三条 */
export function sceneLinks(): RenderEvent[] {
  const lk = (rel: string, id: string, title: string) => ({ rel, id, title });
  return [
    reEv(evRow("e0051", "海边之行的来龙去脉"), { links: [lk("cause", "e0061", "阿青想看日出"), lk("followup", "e0062", "回程的早班车"), lk("same_thread", "e0063", "周六行程的另一半"), lk("contrast", "e0064", "去年雨天的那次"), lk("related", "e0065", "被砍掉的第五条")] }),
    reEv(evRow("e0052", "吉他弦的后话"), { links: [lk("supersedes", "e0066", "第一版采购单"), lk("related", "e0067", "小禾的社团预算"), lk("echoes", "e0068", "代码不认识的关系")] }),
  ];
}

/** 一件有 n 个子事件的大事，和一件没有子事件的事 */
export function sceneChildren(n: number): RenderEvent[] {
  const kids = Array.from({ length: n }, (_, i) => ({ id: `e${String(200 + i).padStart(4, "0")}`, title: `社团第${i + 1}期活动筹备` }));
  return [
    reEv(evRow("e0071", "社团这一学期的活动", { importance: 3 }), { children: kids }),
    reEv(evRow("e0072", "没有子事件的一件事")),
  ];
}

/** n 件事，第一件重要度 5（排最前、挪走时最后动），其余 2 / 3 轮着来；keepAt 那一件写上 keep（超过件数也留着） */
export function sceneMany(n: number, keepAt = -1): RenderEvent[] {
  return Array.from({ length: n }, (_, i) => reEv(
    evRow(`e${String(300 + i).padStart(4, "0")}`, pad(`备忘${i + 1}：小禾的社团`, 16), { importance: i === 0 ? 5 : 2 + (i % 2), why: "", ended_at: ago(1 + i * 0.5) }),
    i === keepAt ? { keep: true } : {},
  ));
}

// ---------- 场景：事件记忆的中期视图（renderMidterm，要一个真的事件库） ----------

const HOUR = 3_600_000;

export interface EvWorld {
  db: Db;
  s: EventStore;
  ix: MemIndex;
  r: EventRecall;
  /** 中央记忆（同一个库）：recall.ts 的 `#N` / `c:N` 在原话层没有时回到这里找 */
  mem: CentralMemory;
  now: number;
  /** 建一件事（标题最多 24 字），返回编号；总结和一句话按标题生成，over 盖掉 */
  event(title: string, over?: Record<string, unknown>): string;
  /** 给一件事加一条经过（at 是毫秒），返回条目编号；原文带序号，每条都不一样 */
  entry(eventId: string, at: number, over?: Record<string, unknown>): string;
}

/** 事件库世界的开关：embedder 不写 = 没有向量（只剩全文）；people = 开人物卡（store 带上人物卡模板和主人名单 OWNER） */
export interface EvOpts { embedder?: Embedder | null; people?: boolean }

/** 建一个事件库世界（库、时钟、时区都显式）；close 关库。同步和异步两种外壳共用 */
function openEvents(now: number, o: EvOpts): { w: EvWorld; close(): void } {
  const db = openDb(":memory:");
  try {
    const s = new EventStore(db, () => now, TZ, o.people ? { peopleTemplate: peopleTemplate(), owners: new Set([OWNER]) } : {});
    const ix = new MemIndex(db, o.embedder ?? null, () => now);
    const r = new EventRecall({ store: s, index: ix, now: () => now, tz: TZ });
    const mem = new CentralMemory(db, () => now);
    let k = 0;
    const event: EvWorld["event"] = (title, over = {}) =>
      s.createEvent({ title, summary: pad(`${title}的总结：阿青托我把这件事盯到周六`, 70), gist: pad(`${title}的一句话`, 30), why: `${title}为什么要紧`, importance: 2, ...over }, "w").id;
    const entry: EvWorld["entry"] = (eventId, at, over = {}) => {
      k += 1;
      return s.addEntry({ event: eventId, at, kind: "happened", full: pad(`第 ${k} 条经过：${eventId} 上阿青说周六早班车七点四十`, 80), gist: pad(`第 ${k} 条的一句话`, 24), title: `经过${k}`, source: [`c:${k}`], ...over }, "w").entry.id;
    };
    return { w: { db, s, ix, r, mem, now, event, entry }, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}

/** 建一个新的事件库世界跑 fn（同步），跑完关库：库、时钟（store / 索引 / 召回都是 now）、时区都显式；编号从 e0001 / n00001 起按写入顺序，所以是确定的 */
export function inEvents<T>(fn: (w: EvWorld) => T, now: number = EV_NOW, o: EvOpts = {}): T {
  const { w, close } = openEvents(now, o);
  try {
    return fn(w);
  } finally {
    close();
  }
}

/** 同上，fn 是异步的：等它跑完（不管成不成）再关库（同步那个会在 Promise 还没出结果时就把库关了） */
export async function inEventsAsync<T>(fn: (w: EvWorld) => Promise<T>, now: number = EV_NOW, o: EvOpts = {}): Promise<T> {
  const { w, close } = openEvents(now, o);
  try {
    return await fn(w);
  } finally {
    close();
  }
}

const on = (day: number, h: number, m: number): number => Date.UTC(2026, 10, day, h, m);
const qing = { name: "阿青", kind: "person", role: "with" };
const zhou = { name: "老林", kind: "person", role: "with" };

/** 今天（11-13 本地 04:00 以后，现在 09:00）的经过：乱序写、两条同一件事、一条在撤掉的事里（不列）、一条在 04:00 之前（不列） */
export function seedToday(w: EvWorld): void {
  const sea = w.event("周六去海边的行程", { entities: [qing] });
  const rent = w.event("社团押金的交接");
  const wrong = w.event("记错了的仓库格子");
  w.entry(sea, on(13, 7, 5));
  w.entry(rent, on(13, 5, 40));
  w.entry(sea, on(13, 4, 10));
  w.entry(wrong, on(13, 6, 0));
  w.entry(sea, on(13, 3, 30));
  w.entry(sea, on(13, 8, 59));
  w.s.retire(wrong, "记错了，不算数", "w");
}

/** 凌晨 02:30 看：她的今天从 11-12 的 04:00 起——前一天夜里的两条和凌晨的一条算今天，11-12 的 03:30 不算 */
export function seedTodayEarly(w: EvWorld): void {
  const sea = w.event("周六去海边的行程", { entities: [qing] });
  w.entry(sea, on(12, 3, 30));
  w.entry(sea, on(12, 22, 30));
  w.entry(sea, on(13, 1, 15));
  w.entry(sea, on(13, 2, 20));
}

/** 有日子的事：今天的、以后的（含已经办完的）；早于昨天 04:00 的、撤掉的、被取代的都不列 */
export function seedDated(w: EvWorld): void {
  // 每件写一条各不相同的老经过（ago(100 + 序号)）：没写的话 ended_at 都是 NULL，「最近没动」那一行的顺序就靠 SQLite 的平局顺序
  let k = 0;
  const mk = (title: string, over: Record<string, unknown>): string => {
    const id = w.event(title, over);
    w.entry(id, ago(100 + k++));
    return id;
  };
  mk("周六的海边日出", { next: "2026-11-13" });
  mk("社团押金交接", { next: "2026-11-20", importance: 3 });
  mk("吉他弦到货", { next: "2026-12-05" });
  mk("已经过了的约定", { next: "2026-11-10" });
  mk("已经办完的约定", { next: "2026-11-15", status: "done" });
  w.s.retire(mk("作废的约定", { next: "2026-11-25" }), "不算数了", "w");
  const old = mk("被取代的约定", { next: "2026-11-26" });
  w.s.supersede(old, mk("取代它的约定", { next: "2026-11-27" }), "改期了", "w");
}

/** 最近 14 天的事：大事和它下面最近有进展的两个子事件（并成一格）、不在最近里的子事件（照列）、老大事的新一段（自己一格）、重要度 5 和 4、几件普通的、关联、人；撤掉的和 15 天没动的不进 */
export function seedRecent(w: EvWorld): void {
  const old = w.event("很久以前的大事", { importance: 3 });
  w.entry(old, ago(40));
  const big = w.event("社区晚会的筹备", { importance: 3, entities: [qing, zhou] });
  w.entry(big, ago(1.5));
  w.entry(big, ago(6));
  const k1 = w.event("晚会第一次碰头", { parent: big });
  w.entry(k1, ago(1.6));
  const k2 = w.event("晚会节目单", { parent: big });
  w.entry(k2, ago(2));
  const k3 = w.event("晚会场地的旧方案", { parent: big });
  w.entry(k3, ago(41));   // 和「很久以前的大事」的 ago(40) 错开：最近没动那一行按 ended_at 倒序，不留平局
  const orphan = w.event("老大事的新一段", { parent: old });
  w.entry(orphan, ago(1.2));
  const five = w.event("最要紧的那件", { importance: 5 });
  w.entry(five, ago(13));
  w.entry(w.event("要紧的另一件", { importance: 4 }), ago(12.5));
  const a = w.event("阿青的行程", { entities: [qing] });
  w.entry(a, ago(0.5));
  w.entry(a, ago(10));
  const b = w.event("老林的刨子", { entities: [zhou] });
  w.entry(b, ago(5));
  w.entry(w.event("吉他弦的更换"), ago(13.9));
  w.entry(w.event("十五天没动的事"), ago(15));
  const drop = w.event("记错了的事");
  w.entry(drop, ago(1));
  w.s.retire(drop, "记错了", "w");
  w.s.link(big, a, "followup", "", "w");
  w.s.link(five, b, "related", "两件事都牵着周六的行程", "w");
}

/** n 件普通的最近的事（比 40 格多时放不下的归进「还有 N 件」），其中一件重要度 4 */
export function seedCrowd(w: EvWorld, n: number): void {
  for (let i = 0; i < n; i++) {
    const id = w.event(pad(`备忘${i + 1}：小禾的社团`, 16), { importance: i === 7 ? 4 : 2 });
    w.entry(id, ago(2 + i * 0.2));
  }
}

/** n 件还在进行、没有过进展的事（每件标题正好 24 字；每四件有一件是暂停）：最近没动的那一行 */
export function seedStale(w: EvWorld, n: number): void {
  // 每件写一条各不相同的老经过（ago(20 + i)）：最近没动那一行按 ended_at 倒序，不能让一排 NULL 靠 SQLite 的平局顺序定先后；标题和编号的长度不变
  for (let i = 0; i < n; i++) w.entry(w.event(pad(`旧事${i + 1}`, 24), i % 4 === 3 ? { status: "paused" } : {}), ago(20 + i));
}

/** 喜欢的 / 烦的事（还在进行）：标题正好 12 字，一句话正好 50 字，所以每行 73 字；第二件喜欢的两天前写过一条感受（感受时间 = 两天前，比其余的 felt = 固定的 now 老，所以排在最后；也不落进「今天」） */
export function seedLikes(w: EvWorld, likes: number, dislikes: number): void {
  for (let i = 0; i < likes; i++) {
    const id = w.event(pad(`喜欢第${i + 1}样`, 12), { stance: "like", gist: pad(`喜欢第${i + 1}样的一句话`, 50) });
    if (i === 1) w.entry(id, ago(2), { kind: "feeling" });
  }
  for (let i = 0; i < dislikes; i++) w.event(pad(`烦第${i + 1}件事`, 12), { stance: "dislike", gist: pad(`烦第${i + 1}件事的一句话`, 50) });
}

// 这是 midterm.ts 拿来和 lower(who) 比的那个字面量（SQL 里挑出「主人最近 3 天的原话」）：被测代码自己比的值，名字只写在这一个常量里
export const OWNER = "ada";

/** 主人最近的原话：一条短的、一条超过 300 字的、一条大写写法的名字；不在列的：别人说的、4 天前的 */
export function seedOwnerQuotes(w: EvWorld): void {
  const q = (ref: string, at: number, who: string, text: string): QuoteIn => ({ src: "central", ref, at, who, channel: "qqbot", text });
  w.ix.addQuotes([
    q("k1", on(13, 8, 20), OWNER, "周六的日出你自己去看吧，我这周要陪阿青去取相机。"),
    q("k2", on(13, 1, 10), OWNER, pad("老林那把刨子的事我想了很久，还是觉得不用催他，等他自己开口", 340)),
    q("k3", on(12, 21, 45), OWNER.toUpperCase(), "社团的押金我周三替小禾先垫上。"),
    q("k4", on(13, 8, 40), "阿青", "我不是主人，这句话不该出现在主人的原话那一节里。"),
    q("k5", Date.UTC(2026, 10, 9, 8, 0), OWNER, "四天前说的一句话，已经过了三天的窗口。"),
  ]);
}

/** 主人的原话多到放不下：n 条，每条正好 320 字 */
export function seedManyOwnerQuotes(w: EvWorld, n: number): void {
  w.ix.addQuotes(Array.from({ length: n }, (_, i): QuoteIn => ({
    src: "central", ref: `m${i}`, at: EV_NOW - (i + 1) * HOUR, who: OWNER, channel: "", text: pad(`第${i + 1}句：关于周六早班车和海边日出的一段很长的话`, 320),
  })));
}

/** 所有的一起：今天、有日子的、最近的、一行没动的、喜欢和烦的、主人的原话 */
export function seedFull(w: EvWorld): void {
  seedToday(w);
  seedDated(w);
  seedRecent(w);
  seedStale(w, 5);
  seedLikes(w, 3, 2);
  seedOwnerQuotes(w);
}

// ---------- 场景：事件记忆的读（events/recall.ts：想起一串、一个人、展开、翻时间段、反查、自动联想） ----------

/** 守卫比回话之前先去掉标记（⟦叶子路径⟧）：标记包那一轮每句回话前面都多一个标记，「这一步成了没有」要照样认得出；平常这一步什么都不改 */
export const plain = (reply: string): string => reply.replace(/⟦[A-Za-z0-9_.]+⟧/g, "");

/** 夹具自己造数据时出的错（写进库被拒、编号对不上……）：不是记忆说的话，包成 FixtureError，让整张清单大声失败（不然会被记成 threw: …） */
export function fixture<T>(what: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof FixtureError) throw e;
    throw new FixtureError(`${what}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** 同上，异步的 */
export async function fixtureAsync<T>(what: string, f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof FixtureError) throw e;
    throw new FixtureError(`${what}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
}

/** 人物卡模板：中文包带的那一份默认配置（跟线上的模板同一份），每次现解析 */
function peopleTemplate(): PeopleTemplate {
  const raw = defaults.memory?.people?.template;
  if (!raw) throw new FixtureError("src/lang/zh/defaults.ts has no memory.people.template");
  return parseTemplate(raw);
}

/** 假向量（不联网）：每个字按字码落进 512 维里的一维、数一数再单位化；字重合得多 cos 就高（算法同 test/events.test.ts 里的那个，那个不能导入：它是测试文件） */
export const fakeEmbedder = (): Embedder => ({
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(EMBED_DIMS);
      for (const ch of t) {
        const d = ch.codePointAt(0)! % EMBED_DIMS;
        v[d] = (v[d] ?? 0) + 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
});

const he = { name: "小禾", kind: "person", role: "with" };
const ownerRef = { name: OWNER, kind: "person", role: "with" };

/**
 * 想起一串（cluster）：线索「周六去海边的行程」对上一件事（挂着阿青），顺着关联带出一件，同一个人的另一件（重要度 3）跟着来，一件不相干的；
 * 原话层四句：1 和 3 是同样的话（只差标点）、2 是很长的一句（没有渠道）、4 只对得上另一条线索「冰箱门上贴着的便条」
 */
export function seedCluster(w: EvWorld): void {
  fixture("cluster", () => {
    const sea = w.event("周六去海边的行程", { entities: [qing] });
    w.entry(sea, ago(1), { source: [] });
    const sun = w.event("海边日出的机位");
    w.entry(sun, ago(2), { source: [] });
    const cam = w.event("旧相机电池的更换", { importance: 3, entities: [qing] });
    w.entry(cam, ago(1.5), { source: [] });
    const dep = w.event("社团押金的交接");
    w.entry(dep, ago(4), { source: [] });
    w.s.link(sea, sun, "followup", "", "w");
    w.ix.addQuotes([
      { src: "central", ref: "31", at: ago(5), who: "阿青", channel: "whatsapp", text: "周六去海边的行程我定了早班车，七点四十出发，记得带那台旧相机。" },
      { src: "central", ref: "32", at: ago(6), who: "老林", channel: "", text: `周六去海边的行程老林补充说：${pad("仓库的刨子周日再还，别忘了带上借用记录", 140)}` },
      { src: "central", ref: "33", at: ago(5.5), who: "小禾", channel: "qqbot", text: "周六去海边的行程我定了早班车七点四十出发记得带那台旧相机" },
      { src: "central", ref: "34", at: ago(7), who: "阿青", channel: "whatsapp", text: "冰箱门上贴着的便条写着：蓝色罐子里是新熬的果酱，别一次吃完。" },
    ]);
  });
}

/**
 * 人物（person，要开人物卡）：主人 OWNER；阿青（名单上、重要度 4，存着「关系」「是谁」（120 字）「在乎什么」，挂着六件事里的 e0001 e0002 e0004（撤掉的）e0005）；
 * 老林（重要度 3，没存字段，只有现算的近况）；小禾（登记了、没有事、没有重要度）。事件 e0001 周六去海边的行程（重要度 4）e0002 旧相机电池的更换 e0003 刨子的借用记录（老林）
 * e0004 记错了的仓库格子（撤掉）e0005 社团年底的聚餐（挂着阿青、经过里没有她）e0006 陪主人看展（主人）
 */
export function seedPeople(w: EvWorld): void {
  fixture("people", () => {
    const s = w.s;
    s.upsertEntity({ name: OWNER, kind: "person", person_key: OWNER, importance: 5, why: "最重要的人" }, "w");
    s.upsertEntity({ name: "阿青", kind: "person", person_key: "qing", importance: 4, why: "常一起出门的人" }, "w");
    s.upsertEntity({ name: "老林", kind: "person", person_key: "zhou", importance: 3 }, "w");
    s.upsertEntity({ name: "小禾", kind: "person", person_key: "he" }, "w");
    const sea = w.event("周六去海边的行程", { importance: 4, entities: [qing] });
    w.entry(sea, ago(1.5), { source: [], people: ["阿青"] });
    w.entry(sea, ago(1), { source: [], people: ["阿青"] });
    const cam = w.event("旧相机电池的更换", { entities: [qing] });
    w.entry(cam, ago(3), { source: [] });
    const planer = w.event("刨子的借用记录", { importance: 3, entities: [zhou] });
    w.entry(planer, ago(2), { source: [], people: ["老林"] });
    const wrong = w.event("记错了的仓库格子", { entities: [qing] });
    w.entry(wrong, ago(4), { source: [] });
    const club = w.event("社团年底的聚餐", { entities: [qing] });
    w.entry(club, ago(5), { source: [] });
    const show = w.event("陪主人看展", { importance: 3, entities: [ownerRef] });
    w.entry(show, ago(1.2), { source: [] });
    s.retire(wrong, "记错了，不算数", "w");
    s.setSection({ who: "阿青", section: "关系", text: "朋友｜更近｜周六一起去海边的老朋友", sources: [sea] }, "w");
    s.setSection({ who: "阿青", section: "是谁", text: pad("常和我一起出门的人", 120), sources: [sea] }, "w");
    s.setSection({ who: "阿青", section: "在乎什么", text: "- 周六的日出\n- 旧相机的电池\n- 早班车的时间", sources: [sea] }, "w");
  });
}

/** 按标题找事：六件标题里都带「看日出」（长短各不一样，所以「像不像」不平局）、一件总结里写着「糖醋排骨」的；每件一条不同时间的经过（没有来源） */
export function seedTitles(w: EvWorld): void {
  fixture("titles", () => {
    const titles = ["看日出的约定", "周六看日出的行程", "海边看日出的好机位", "看日出前要带的旧相机电池", "清晨看日出的早班车时刻", "老林在海边看日出时拍的照片"];
    titles.forEach((t, i) => w.entry(w.event(t), ago(1 + i), { source: [] }));
    w.entry(w.event("傍晚的家常菜", { summary: "阿青教的糖醋排骨做法：先炸后烧，糖要后放。" }), ago(8), { source: [] });
  });
}

/**
 * 展开一件事（event）：事件 e0001 的七条经过各带不同的出处——n00001 原话层里有（c:21 → q1）、n00002 只在中央记忆里（c:1）、n00003 哪里都没有（c:999）、
 * n00004 一句很长的原话（q2）加两个不是原话的出处、n00005 和 n00001 同一句、n00006 没有出处、n00007 直接写 q1、n00008 是四百天前的（淡到不显示）；
 * 原话层 q1 q2 q3（c:21 c:22 c:23）；中央记忆 seq 1（200 字的想法，不在原话层）和 seq 2（没有人引用）
 */
export function seedExpand(w: EvWorld): void {
  fixture("expand", () => {
    w.mem.append(1, "main", "think", pad("中央记忆里只有一条想法：周六早班车的班次要再核对一次", 200), null, on(12, 8, 10));
    w.mem.append(1, "main", "think", "中央记忆里的另一条想法，没有人引用它。", null, on(12, 9, 40));
    w.ix.addQuotes([
      { src: "central", ref: "21", at: on(12, 7, 20), who: "阿青", channel: "whatsapp", text: "周六早班车我查过了，七点四十那一班最合适。" },
      { src: "central", ref: "22", at: on(12, 7, 50), who: "老林", channel: "", text: pad("老林说周日去仓库拿刨子，顺路把相机电池也带回来", 140) },
      { src: "central", ref: "23", at: on(12, 8, 5), who: "小禾", channel: "qqbot", text: "社团的押金收据我放在你抽屉里了。" },
    ]);
    const id = w.event("周六早班车的核对", { entities: [qing] });
    w.entry(id, ago(0.2), { source: ["c:21"] });
    w.entry(id, ago(0.4), { source: ["c:1"] });
    w.entry(id, ago(0.6), { source: ["c:999"] });
    w.entry(id, ago(0.8), { source: ["q2", "why:出处补上了", "thread:行程.md"] });
    w.entry(id, ago(1), { source: ["c:21"] });
    w.entry(id, ago(1.2), { source: [] });
    w.entry(id, ago(1.4), { source: ["q1"] });
    w.entry(id, ago(400), { source: ["c:21"] });
  });
}

/** 一段时间里的事：近 10 天九件（状态各不同，其中一件的状态是代码不认识的，直接改表；人 0 到 3 个）、更早的三件（给「按周」用）；每件一条不同时间的经过，所以每件事在这段时间里的第一条都不平局 */
export function seedPeriod(w: EvWorld): void {
  fixture("period", () => {
    const rows: Array<[string, number, Record<string, unknown>]> = [
      ["月初的搬家", 38.5, {}],
      ["上个月的露营", 30.5, {}],
      ["很早以前的旧账", 22.5, {}],
      ["周六去海边的行程", 9.5, { importance: 3, entities: [qing, zhou, he] }],
      ["社团押金的交接", 8.5, { status: "done", entities: [he] }],
      ["旧相机电池的更换", 7.5, { status: "paused", importance: 1 }],
      ["早班车的备选方案", 6.5, { status: "superseded" }],
      ["仓库格子的新编号", 5.5, { entities: [zhou] }],
      ["吉他弦的更换", 4.5, { entities: [zhou] }],
      ["刨子的借用记录", 3.5, {}],
      ["海边日出的机位", 2.5, { importance: 4 }],
      ["社团年底的聚餐", 1.5, { entities: [he] }],
    ];
    for (const [title, days, over] of rows) {
      const id = w.event(title, over);
      w.entry(id, ago(days), { source: [] });
      if (title === "仓库格子的新编号") w.db.prepare("UPDATE mem_event SET status = 'archived' WHERE id = ?").run(id);
    }
  });
}

/** 反查：e0001 挂着五样东西（四种角色各一，加一个角色代码不认识的，直接改表），经过里还出现一个事件上没挂的人（小禾），有两条关联（时间错开，顺序不平局） */
export function seedReverseFull(w: EvWorld): void {
  fixture("reverse full", () => {
    const main = w.event("周六去海边的行程", {
      entities: [qing, { name: "老林", kind: "person", role: "about" }, { name: "旧相机", kind: "thing", role: "by" }, { name: "海边", kind: "place", role: "where" }, { name: "木吉他", kind: "thing", role: "with" }],
    });
    w.db.prepare("UPDATE mem_event_entity SET role = 'witness' WHERE event_id = ? AND entity_id = (SELECT id FROM mem_entity WHERE name = ?)").run(main, "木吉他");
    w.entry(main, ago(1), { source: [], people: ["小禾"] });
    const back = w.event("回程的早班车");
    const cause = w.event("阿青想看日出");
    w.s.link(main, back, "followup", "", "w");
    w.s.link(cause, main, "followup", "", "w");
    w.db.prepare("UPDATE mem_link SET created_at = ? WHERE a = ? AND b = ?").run(EV_NOW - 2000, main, back);
    w.db.prepare("UPDATE mem_link SET created_at = ? WHERE a = ? AND b = ?").run(EV_NOW - 1000, cause, main);
  });
}

/** 反查：e0001 没挂任何人和东西、有一条关联（到 e0002）；e0002 挂着阿青；e0003 挂着老林、没有关联；e0004 什么都没有 */
export function seedReverseBare(w: EvWorld): void {
  fixture("reverse bare", () => {
    const bare = w.event("海边日出的机位");
    const club = w.event("社团年底的聚餐", { entities: [qing] });
    w.event("旧相机电池的更换", { entities: [zhou] });
    w.event("刨子的借用记录");
    w.s.link(bare, club, "related", "两件事牵着同一个周末", "w");
  });
}

/** 一个人（或东西）出现在 n 件事里：第一件没有经过（没有结束时间），其余各有一条不同时间的经过 */
export function seedPersonCrowd(w: EvWorld, name: string, n: number): void {
  fixture("person crowd", () => {
    for (let i = 0; i < n; i++) {
      const id = w.event(pad(`备忘${i + 1}：${name}的事`, 16), { entities: [{ name, kind: "person", role: "with" }] });
      if (i > 0) w.entry(id, ago(1 + i * 0.1), { source: [] });
    }
  });
}

/**
 * 联想（associate）：e0001 周六去海边的行程（挂着阿青，两条经过：n00001 早班车七点四十、n00002 海边的集合点）、e0002 刨子的借用记录（挂着老林，n00003 刨子在仓库第三格）、
 * e0003 社团押金的交接（n00004 押金收据抬头，被更正过一次：n00005）；小禾登记了、没有事；主人 OWNER 登记了。总结、一句话、原文都写短，让近况放得进 250 字
 */
export function seedAssoc(w: EvWorld): void {
  fixture("associate", () => {
    const short = (title: string): Record<string, unknown> => ({ summary: `${title}的总结`, gist: `${title}的大意` });
    w.s.upsertEntity({ name: "小禾", kind: "person" }, "w");
    w.s.upsertEntity({ name: OWNER, kind: "person", person_key: OWNER }, "w");
    const sea = w.event("周六去海边的行程", { importance: 3, entities: [qing], ...short("周六去海边的行程") });
    w.entry(sea, ago(2), { title: "早班车七点四十", full: pad("阿青说周六早班车改到七点四十", 36), gist: pad("早班车改到七点四十", 18), source: [], people: ["阿青"] });
    w.entry(sea, ago(3), { title: "海边的集合点", full: pad("阿青说海边的集合点在北门", 36), gist: pad("集合点在北门", 18), source: [], people: ["阿青"] });
    const planer = w.event("刨子的借用记录", { importance: 3, entities: [zhou], ...short("刨子的借用记录") });
    w.entry(planer, ago(3.5), { title: "刨子在仓库第三格", full: pad("老林说刨子放在仓库第三格", 36), gist: pad("刨子在第三格", 18), source: [], people: ["老林"] });
    const dep = w.event("社团押金的交接", short("社团押金的交接"));
    const receipt = w.entry(dep, ago(2), { title: "押金收据抬头", full: pad("小禾说收据抬头写社团全称", 36), gist: pad("抬头写社团全称", 18), source: [] });
    w.s.correctEntry(receipt, { full: pad("小禾说收据抬头改成写社团的简称", 36), gist: pad("抬头改写简称", 18), title: "押金抬头改了", why: "小禾后来改口了" }, "w");
  });
}

/** 联想里「说话人的原话和她当时的回话」：在 seedAssoc 之上加五句原话（阿青 3 天前一句像线索的；她回阿青的「好的」（太短，不算）和一句真话；回老林的一句；两小时后回阿青的一句），再补算向量 */
export async function seedAssocQuotes(w: EvWorld): Promise<void> {
  seedAssoc(w);
  const at = w.now - 3 * DAY;
  fixture("associate quotes", () => w.ix.addQuotes([
    { src: "central", ref: "41", at, who: "阿青", channel: "whatsapp", text: "周六去海边的行程我想七点四十出发可以吗" },
    { src: "central", ref: "42", at: at + MIN, who: "我→阿青", channel: "", text: "好的" },
    { src: "central", ref: "43", at: at + 2 * MIN, who: "我→老林", channel: "", text: "刨子的事周日再说，你先别急着去仓库" },
    { src: "central", ref: "44", at: at + 3 * MIN, who: "我→阿青", channel: "", text: "可以呀，七点四十那班车我替你看过了，周六一早出发" },
    { src: "central", ref: "45", at: at + 2 * 3_600_000, who: "我→阿青", channel: "", text: "两个小时后聊的别的事：电池充好了没有" },
  ]));
  await fixtureAsync("associate quotes", () => w.ix.backfillVectors(500));
  if (w.ix.missingVectors() !== 0) throw new FixtureError("associate quotes: vectors missing");
}

/** 原话行：q1 有渠道、短；q2 没有渠道、140 字（要截）；q3 正好 120 字（不截）；q4 121 字（截） */
export function seedQuoteLines(w: EvWorld): void {
  fixture("quote lines", () => {
    w.ix.addQuotes([
      { src: "central", ref: "51", at: ago(2), who: "阿青", channel: "whatsapp", text: "周六早班车七点四十，我在北门等你。" },
      { src: "central", ref: "52", at: ago(3), who: "老林", channel: "", text: pad("老林说周日去仓库拿刨子，顺路把电池带回来", 140) },
      { src: "central", ref: "53", at: ago(4), who: "小禾", channel: "qqbot", text: pad("小禾说社团的押金收据放在抽屉里", 120) },
      { src: "central", ref: "54", at: ago(5), who: "阿青", channel: "qqbot", text: pad("阿青说旧相机的电池还没有充好", 121) },
    ]);
  });
}

// ---------- 场景：情境（situation.ts：时间、负载、账本变动、人物卡、说过的话、叫醒附带） ----------
// Situation 只读 deps.now（这里一律 T0 或调用给的时间），不读真时钟；脚本（goals.py）只走下面假的 Runner，不起任何进程；
// the speaker comes in HumanContext.person (the brain identifies it);
// 文件都写在调用方给的根目录下（每条调用自己一个子目录，sitDirs 不许重名）。主人是靠登记项的 privacy === "owner" 认的，不靠名字，所以这里不用 OWNER。

export interface SitDirs { ws: string; st: string }

/** root 下 tag 这条调用自己的两个目录：工作区 ws、状态目录 st（里面有空的 load/）；同一个 tag 用两次是夹具的错 */
export function sitDirs(root: string, tag: string): SitDirs {
  const base = join(root, tag);
  if (existsSync(base)) throw new FixtureError(`sit dirs: ${tag} was used twice`);
  const ws = join(base, "ws");
  const st = join(base, "state");
  fixture("sit dirs", () => { mkdirSync(ws, { recursive: true }); mkdirSync(join(st, "load"), { recursive: true }); });
  return { ws, st };
}

/** 在 dir 下写一个文件（目录按需建） */
export function putFile(dir: string, rel: string, text: string): void {
  fixture(`write ${rel}`, () => {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  });
}

/** load.py guard 写的状态文件 */
export interface LoadStatus {
  t: number; level: string; avail_pct: number; comp_gb: number; swap_gb: number; mine_gb: number; phone_on: boolean;
  mine_top?: Array<[string, number]>; why?: string[]; last_action?: string;
}
export const LOAD_OK: Omit<LoadStatus, "t"> = { level: "ok", avail_pct: 41, comp_gb: 1.2, swap_gb: 0, mine_gb: 3.4, phone_on: false };

/** 状态文件：写的时间是 T0 往前 ageSec 秒（不靠文件的修改时间：代码读的是里面的 t） */
export function putLoad(d: SitDirs, ageSec: number, o: Omit<LoadStatus, "t">): void {
  putFile(d.st, "load/status.json", JSON.stringify({ t: T0 / 1000 - ageSec, ...o }));
}

/** 收日志的 Logger：每条去掉时间戳（那是真时钟），其余原样（级别、模块、消息、额外字段） */
export function sitLogger(): { log: Logger; logs: string[] } {
  const logs: string[] = [];
  const log = new Logger("sit", (r) => { const { t: _t, ...rest } = r; logs.push(JSON.stringify(rest)); });
  return { log, logs };
}

export interface SitOpts {
  now?: number; tz?: string;
  /** 假 goals.py 怎么回：不写 = 退出 0 并给一段目标；"throws" = 起不来（Runner 抛） */
  goals?: { code: number; stdout: string } | "throws";
  /** 人物卡的事件记忆（只给 personCard 用：带它的调用不走 recall，recall 会读真时钟） */
  mem?: EventMemory;
  /** 共用的踪迹（假 Runner 和假的联想笔记记到同一处） */
  trace?: string[];
  /** 联想笔记：一个假的（开着、会挂上），记下被问了什么话题、带了什么（多问的题、上文），回这一句；不写 = 没接笔记 */
  notes?: { reply: string };
  /** 主人说话时多问的那道纠正题：接上才会带（假的联想不回这道题的概率，所以不会去记纠正，库用不上） */
  correction?: boolean;
}
export interface SitWorld { s: Situation; trace: string[]; logs: string[]; clock: { now: number } }
const GOALS_OUT = "目标：g7 把阿青托的周六行程查清楚（今天先查车次）\n";

/** 一个 Situation：时钟 T0、时区 TZ（都可以盖掉）、python 是个名字、Runner 是假的（记下被问了什么） */
export function makeSit(d: SitDirs, o: SitOpts = {}): SitWorld {
  const trace = o.trace ?? [];
  const { log, logs } = sitLogger();
  const clock = { now: o.now ?? T0 };
  const goals = o.goals ?? { code: 0, stdout: GOALS_OUT };
  const run: Runner = async (cmd, args, opts) => {
    trace.push(`run ${JSON.stringify([cmd, ...args])} ${JSON.stringify(opts ?? {})}`);
    if (goals === "throws") throw new Error("goals.py could not start");
    return { code: goals.code, stdout: goals.stdout, stderr: "" };
  };
  // the goals module's own situation hook, its script answered by the fake Runner above
  const goalsCtx = { name: "goals", log: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => log[level](msg, { module: "goals", ...data }),
    run: (script: string, argv: readonly string[], ro?: { timeoutMs?: number }) => run("py", [script, ...argv], ro).then((r) => ({ ...r, timedOut: false })) } as unknown as ModuleContext;
  const reply = o.notes?.reply;
  // 假的联想笔记只有 Situation 用到的三样：enabled、injects、associate（学习那边真的 NoteAssociator 要库、书架、判断，这里不起）
  const notes = reply === undefined ? undefined : ({
    enabled: true,
    injects: true,
    associate: async (topic: string, opts: Record<string, unknown>) => {
      trace.push(`notes.associate ${JSON.stringify(topic)} ${JSON.stringify(opts)}`);
      return { text: reply, extra: new Map<string, number>() };
    },
  } as unknown as NoteAssociator);
  // 纠正题的库这里没有：假的联想不回这道题的概率，记纠正那一步走不到；真走到了会抛 TypeError，清单大声失败
  const correction = o.correction ? ({ db: undefined, threshold: 0.6, currentTask: () => null } as unknown as Correction) : undefined;
  const s = new Situation({
    workspace: d.ws, loadStatusFile: join(d.st, "load/status.json"), timezone: o.tz ?? TZ, log, now: () => clock.now,
    modules: [{ name: "goals", run: () => runHook(goalsModule.hooks!.situation!, goalsCtx, "situation") }],
    ...(notes ? { notes } : {}), ...(correction ? { correction } : {}),
    ...(o.mem ? { events: { mem: o.mem, inject: true } } : {}),
  });
  return { s, trace, logs, clock };
}

/** 说过的话：agoSec 秒之前（T0 往前数）发的 */
export const said = (agoSec: number, text: string, o: { pending?: boolean; batch?: string } = {}): Said => ({ text, at: T0 - agoSec * 1000, ...o });

/** 账本：前缀重建时的样子（冻结的那份） */
export const OLD_LEDGER = "# 账本\n- 旧的一行：阿青的早班车时刻表\n- 另一条旧账：老林借走了刨子\n";

// 旧档案文件里代码认的记号：每段标题下一行的 <!-- 类型：X -->（设定 / 总结 / 原话 留下，别的不要）、标题「维护规则」不要
/** 旧档案：身份（设定）、她是谁（总结）、她说过的话（原话）、详情（不要）、维护规则（设定但不要）；前面有一段说明 */
export function profileDoc(name: string): string {
  return [
    `# ${name}`, "<!-- 关键词: 社团 -->", "说明：这份档案只记看到的", "",
    "## 身份和怎么认出她", "<!-- 类型：设定 -->", "- 在 QQ 上认", "",
    "## 她是谁", "<!-- 类型：总结 -->", "- 社团里管器材的人", "",
    "## 她说过的话", "<!-- 类型：原话 -->", "- 「吉他弦先别装，等我周三回去」", "",
    "## 详情（按日期）", "<!-- 类型：详情 -->", "- 11-02 托我记社团的押金", "",
    "## 维护规则", "<!-- 类型：设定 -->", "- 只记观察到的", "",
  ].join("\n");
}

/** 「我和她之间」那份旧档案 */
export function usDoc(name: string): string {
  return [`# 我和${name}之间`, "", "## 我们之间", "<!-- 类型：总结 -->", "- 她常在周三来", "", "## 流水", "<!-- 类型：详情 -->", "- 11-05 一起整理了器材", ""].join("\n");
}

/** 一个事件记忆里有两位访客的卡（人物卡开着）：阿青（key qing，公开的「是谁」加她私下说的）、老林（key zhou，只有私下说的）；小禾（key he）登记了、没有卡 */
export function inPeopleMemory<T>(fn: (mem: EventMemory) => T): T {
  const db = openDb(":memory:");
  try {
    const mem = new EventMemory({ db, embedder: null, now: () => EV_NOW, tz: TZ, peopleTemplate: peopleTemplate() });
    fixture("sit people", () => {
      const s = mem.store;
      s.upsertEntity({ name: "阿青", kind: "person", person_key: "qing", importance: 3 }, "b0");
      s.upsertEntity({ name: "老林", kind: "person", person_key: "zhou", importance: 3 }, "b0");
      s.upsertEntity({ name: "小禾", kind: "person", person_key: "he" }, "b0");
      const e = s.createEvent({ title: "周六去海边的行程", summary: "周六去海边", gist: "周六去海边", importance: 1 }, "b0");
      const put = (who: string, section: string, text: string): void => { s.setSection({ who, section, text, sources: [e.id] }, "b1"); };
      put("阿青", "是谁", "常和我一起出门的朋友");
      put("阿青", "她私下说的", "- 她说周六有点紧张");
      put("老林", "她私下说的", "- 老林的私事");
    });
    return fn(mem);
  } finally {
    db.close();
  }
}

// ---------- 场景：事件记忆的门面（events/memory.ts 的 EventMemory；Task 2-0 的 0e 起） ----------
// 一个世界一个 EventMemory：库是 :memory:，时钟是世界自己的（clock.now，可以往后拨），时区 TZ，不给 peopleDir（什么都不导出到磁盘）。
// 人物卡开不开（people）、切没切过去（flags.active）、谁是主人（owners）、有没有向量（embedder）都由调用的一方定。
// 写过什么用 stored() 看：事件、经过、白天喜好的改动记录、日志，原样成文字，接在回复后面（`--- trace ---`）。


export interface MemOpts {
  /** 不写 = 没有向量（只剩全文，like 不按意思找） */
  embedder?: Embedder | null;
  /** 开人物卡（中文包带的那份模板）；不写 = 不开 */
  people?: boolean;
  /** peopleActive 的起点（人物卡切过去了没有）；不写 = 切过去了。之后改 flags.active */
  active?: boolean;
  /** 名单上的主人（person_key）的起点；不写 = 没有。之后调 owners() */
  owners?: readonly string[];
  /** 时钟的起点；不写 = EV_NOW。之后调 clock.tick() */
  now?: number;
}

export interface MemWorld {
  mem: EventMemory;
  /** mem.store */
  s: EventStore;
  db: Db;
  /** 世界的时钟：mem / 事件库 / 索引 / 召回读的都是它；tick 往后拨（默认一分钟） */
  clock: { now: number; tick(ms?: number): void };
  /** 人物卡切过去了没有（peopleActive 读它）；false = 还没切 */
  flags: { active: boolean };
  /** MemLog 收到的每条 warn / info，一条一行 JSON */
  logs: string[];
  /** 换名单上的主人（mem.store.owners） */
  owners(keys: readonly string[]): void;
  /** 一条调用写进库里的东西，成文字（接在回复后面当踪迹）：事件、经过、白天喜好的改动记录、日志 */
  stored(): string;
}

function openMemory(o: MemOpts): { w: MemWorld; close(): void } {
  const db = openDb(":memory:");
  try {
    const clock: MemWorld["clock"] = { now: o.now ?? EV_NOW, tick(ms: number = MIN): void { clock.now += ms; } };
    const flags = { active: o.active ?? true };
    const logs: string[] = [];
    const log: MemLog = {
      warn: (msg, data) => { logs.push(JSON.stringify({ level: "warn", msg, data })); },
      info: (msg, data) => { logs.push(JSON.stringify({ level: "info", msg, data })); },
    };
    const mem = new EventMemory({
      db, embedder: o.embedder ?? null, now: () => clock.now, tz: TZ,
      ...(o.people ? { peopleTemplate: peopleTemplate() } : {}), peopleActive: () => flags.active, log,
    });
    const s = mem.store;
    s.owners = new Set(o.owners ?? []);
    const rows = (title: string, sql: string): string =>
      `${title}\n${(db.prepare(sql).all() as unknown as Array<Record<string, unknown>>).map((r) => JSON.stringify(r)).join("\n")}`;
    const w: MemWorld = {
      mem, s, db, clock, flags, logs,
      owners: (keys) => { s.owners = new Set(keys); },
      stored: () => [
        rows("mem_event", "SELECT id, title, gist, status, stance, importance FROM mem_event ORDER BY id"),
        rows("mem_entry", "SELECT id, event_id, kind, title, gist FROM mem_entry ORDER BY id"),
        rows("mem_op day-like", "SELECT batch, op, tbl, reason FROM mem_op WHERE batch LIKE 'day-like:%' ORDER BY id"),
        `logs\n${logs.join("\n")}`,
      ].join("\n"),
    };
    return { w, close: () => db.close() };
  } catch (e) {
    db.close();
    throw e;
  }
}

/** 建一个事件记忆世界跑 fn（同步），跑完（不管成不成）关库；编号按写入顺序，所以是确定的 */
export function inMemory<T>(fn: (w: MemWorld) => T, o: MemOpts = {}): T {
  const { w, close } = openMemory(o);
  try {
    return fn(w);
  } finally {
    close();
  }
}

/** 同上，fn 是异步的：等它跑完（不管成不成）再关库 */
export async function inMemoryAsync<T>(fn: (w: MemWorld) => Promise<T>, o: MemOpts = {}): Promise<T> {
  const { w, close } = openMemory(o);
  try {
    return await fn(w);
  } finally {
    close();
  }
}

/** 同一个世界的事件库视角（同一个 store / 索引 / 召回），让 0c 的种子（seedCluster / seedPeriod / seedPeople）原样用；event / entry 的写法同 openEvents */
export function evOf(w: MemWorld): EvWorld {
  const s = w.s;
  const mem = new CentralMemory(w.db, () => w.clock.now);
  let k = 0;
  const event: EvWorld["event"] = (title, over = {}) =>
    s.createEvent({ title, summary: pad(`${title}的总结：阿青托我把这件事盯到周六`, 70), gist: pad(`${title}的一句话`, 30), why: `${title}为什么要紧`, importance: 2, ...over }, "w").id;
  const entry: EvWorld["entry"] = (eventId, at, over = {}) => {
    k += 1;
    return s.addEntry({ event: eventId, at, kind: "happened", full: pad(`第 ${k} 条经过：${eventId} 上阿青说周六早班车七点四十`, 80), gist: pad(`第 ${k} 条的一句话`, 24), title: `经过${k}`, source: [`c:${k}`], ...over }, "w").entry.id;
  };
  return { db: w.db, s, ix: w.mem.index, r: w.mem.recall, mem, now: w.clock.now, event, entry };
}

/**
 * 原话层（quotes / quotesDay）：十句，线索「早班车」都在里面，id 按写入顺序 q1 … q10；
 * q1 阿青（whatsapp，有「七点四十」）、q2 我→阿青（没有渠道，有「七点四十」）、q3 我（笔记）（有「七点四十」）、q4 老林（qqbot）正好 500 字、q5 小禾（没有渠道）501 字、
 * q6 是中央记忆来的一句（阿青，有「七点四十」；olderOnly 和 quotesDay 都不要它）、q7 阿青 11-11、q8 老林 11-13 03:30（她的 11-12 还没过完）、
 * q9 小禾 11-12 03:30（还算 11-11）、q10 我→老林。11-12 那天（04:00 起）有 q1 … q5、q10、q8 七句，11-11 那天有 q7、q9 两句。时间两两不同
 */
export function seedQuoteLayer(w: MemWorld): void {
  fixture("quote layer", () => {
    const q = (src: QuoteIn["src"], ref: string, at: number, who: string, channel: string, text: string): QuoteIn => ({ src, ref, at, who, channel, text });
    w.mem.index.addQuotes([
      q("honcho", "h1", on(12, 5, 10), "阿青", "whatsapp", "周六早班车我查过了，七点四十那一班最合适，你定好了就告诉我一声。"),
      q("honcho", "h2", on(12, 6, 20), "我→阿青", "", "早班车的票我替你看了一下，七点四十还有靠窗的座，周六一早在北门碰头。"),
      q("honcho", "h3", on(12, 7, 30), "我（笔记）", "", "记一笔：阿青说周六早班车要赶七点四十那班，老林可能不一起去。"),
      q("honcho", "h4", on(12, 8, 40), "老林", "qqbot", pad("早班车那一趟我坐过很多次", 500)),
      q("honcho", "h5", on(12, 9, 50), "小禾", "", pad("早班车上的座位小禾记得靠窗", 501)),
      q("central", "c1", on(12, 11, 5), "阿青", "whatsapp", "早班车的事我在群里说过了，七点四十不见不散；这是中央记忆那边的原话，旧原话的查找不该翻到它。"),
      q("honcho", "h6", on(11, 9, 0), "阿青", "qqbot", "前一天说的：早班车要提前一个小时到站，别和周六的混了。"),
      q("honcho", "h7", on(13, 3, 30), "老林", "", "凌晨三点半还没睡，早班车的闹钟已经定好了，明天不会迟到。"),
      q("honcho", "h8", on(12, 3, 30), "小禾", "whatsapp", "夜里想起来早班车的时刻表还没抄给社团的人，明早先发出去吧。"),
      q("honcho", "h9", on(12, 12, 15), "我→老林", "", "老林问早班车要不要带伞，我说带一把小的就行，别的不用多拿。"),
    ]);
  });
}

/** 夜里底子里八条经过（nightEntry(1) … nightEntry(8)）：事件 e0001 三条、e0002 … e0006 各一条；e0007 没有 */
const NIGHT_ENTRIES: ReadonlyArray<readonly [event: string, daysAgo: number, title: string]> = [
  ["e0001", 5, "早班车改到七点四十"],
  ["e0001", 4, "海边的集合点"],
  ["e0001", 3, "出发前要带的东西"],
  ["e0002", 2.5, "日出的机位定了"],
  ["e0003", 2, "旧相机换了电池"],
  ["e0004", 1.5, "押金收据的抬头"],
  ["e0005", 1, "刨子借出去了"],
  ["e0006", 0.8, "备选方案的比较"],
];

/** 底子里第 n 条经过（n00001 起）写进库用的那份参数：原样再写一次就是「这条已经记过了」 */
export function nightEntry(n: number): Record<string, unknown> {
  const spec = NIGHT_ENTRIES[n - 1];
  if (!spec) throw new FixtureError(`night entry ${n} does not exist`);
  const [event, days, title] = spec;
  return { event, at: ago(days), kind: "happened", full: pad(`${title}：阿青托我把这件事盯到周六，老林说周日去仓库`, 72), gist: pad(`${title}的一句话`, 24), title, source: [] };
}

/**
 * 夜里写之前的底子（批次 "seed"，写完提交，不开夜里那一批）：登记六个——t0001 阿青（key qing）t0002 老林（zhou）t0003 小禾（he）（重要度都是 3）、
 * t0004 旧相机 t0005 老相机（东西，重要度 2）t0006 记错的登记（东西，重要度 1）；七件事（重要度都是 2，没有 stance）——
 * e0001 周六去海边的行程（挂阿青）e0002 海边日出的机位 e0003 旧相机电池的更换（挂旧相机）e0004 社团押金的交接（挂小禾）e0005 刨子的借用记录（挂老林）e0006 早班车的备选方案 e0007 仓库格子的新编号；
 * 八条经过 n00001 … n00008（见 nightEntry）；一条关联 e0005 —related→ e0006。之后第一件新事是 e0008、第一条新经过是 n00009、第一个新登记是 t0007
 */
export function seedNightBase(w: MemWorld): void {
  fixture("night base", () => {
    const s = w.s;
    s.openBatch("seed");
    s.upsertEntity({ name: "阿青", kind: "person", person_key: "qing", importance: 3 }, "seed");
    s.upsertEntity({ name: "老林", kind: "person", person_key: "zhou", importance: 3 }, "seed");
    s.upsertEntity({ name: "小禾", kind: "person", person_key: "he", importance: 3 }, "seed");
    s.upsertEntity({ name: "旧相机", kind: "thing", importance: 2 }, "seed");
    s.upsertEntity({ name: "老相机", kind: "thing", importance: 2 }, "seed");
    s.upsertEntity({ name: "记错的登记", kind: "thing", importance: 1 }, "seed");
    const mk = (title: string, entities: Array<Record<string, unknown>> = []): void => {
      s.createEvent({ title, summary: pad(`${title}的总结：阿青托我把这件事盯到周六`, 60), gist: pad(`${title}的一句话`, 26), importance: 2, entities }, "seed");
    };
    mk("周六去海边的行程", [qing]);
    mk("海边日出的机位");
    mk("旧相机电池的更换", [{ name: "旧相机", kind: "thing", role: "about" }]);
    mk("社团押金的交接", [he]);
    mk("刨子的借用记录", [zhou]);
    mk("早班车的备选方案");
    mk("仓库格子的新编号");
    for (let n = 1; n <= NIGHT_ENTRIES.length; n++) s.addEntry(nightEntry(n), "seed");
    s.link("e0005", "e0006", "related", "两件事都牵着周六的行程", "seed");
    s.commitBatch("seed");
  });
}

/**
 * 人物卡（Task 2-0 的 0f）：在 seedNightBase 之上（先调它）加原话层的六句，让钉原话有得钉。
 * 人和事用底子里的：阿青（key qing）和老林（key zhou）是访客，小禾（key he）在调用把 he 放进名单的时候是主人（owners），事件 e0001 当依据（sources）。
 * 六句：q1 … q5 是阿青说的（whatsapp，各不相同、够长），q6 是我说给阿青的（我→阿青，没有渠道）；时间两两不同
 */
export function seedCards(w: MemWorld): void {
  fixture("cards", () => {
    w.mem.index.addQuotes([
      { src: "honcho", ref: "k1", at: on(12, 10, 5), who: "阿青", channel: "whatsapp", text: "周六早上我想去海边看日出，你愿意陪我走一段吗，我怕自己一个人走不动。" },
      { src: "honcho", ref: "k2", at: on(12, 10, 15), who: "阿青", channel: "whatsapp", text: "你上次说的那首歌我听了好几遍，听到副歌的时候忽然就想起我们去年的夏天。" },
      { src: "honcho", ref: "k3", at: on(12, 10, 25), who: "阿青", channel: "whatsapp", text: "我今天把旧相机的电池换好了，晚上给你看拍出来的第一张照片行不行呀。" },
      { src: "honcho", ref: "k4", at: on(12, 10, 35), who: "阿青", channel: "whatsapp", text: "有你在的时候我就不太害怕，哪怕明天要去面试，也觉得没那么难熬了。" },
      { src: "honcho", ref: "k5", at: on(12, 10, 45), who: "阿青", channel: "whatsapp", text: "谢谢你一直听我讲这些琐碎的事，我知道你也很忙，所以更想认真说一声谢谢。" },
      { src: "honcho", ref: "k6", at: on(12, 10, 55), who: "我→阿青", channel: "", text: "不用谢，我一直都在，周六早班车七点四十，我们北门见，路上慢慢讲给我听。" },
    ]);
  });
}

// ---------- 场景：白天记喜好（Task 2-0 的 0g：like / likeWithMeaning / fix、drop / my_likes） ----------

/**
 * 问了什么才记下来的向量服务：算法同 fakeEmbedder（字码落维、数一数再单位化），但在 on() 以后每次被问就把 `embed <被问的文字（JSON）>` 推进 trace。
 * 种子补向量（backfillVectors）在 on() 之前，所以 trace 里只有被测那一步问的线索
 */
export function recordingEmbedder(trace: string[]): Embedder & { on(): void } {
  const inner = fakeEmbedder();
  let live = false;
  return {
    on(): void { live = true; },
    async embed(texts, o) {
      if (live) trace.push(`embed ${JSON.stringify(texts)}`);
      return inner.embed(texts, o);
    },
  };
}

/** 向量服务出错 / 超时 / 熔断的样子：马上答 null（不是挂着不答：那一支要等真时钟） */
export const deadEmbedder: Embedder = { embed: async () => null };

/** seedLikePool 种下的十件事的编号 */
export interface LikePool {
  /** 喜欢 桂花乌龙茶：喜欢中，两条感受（最近那条和一句话不一样） */
  tea: string;
  /** 烦 周一早上的例会：烦着，一条感受 */
  meeting: string;
  /** 喜欢 薄荷糖罐头：腻了（done），一条感受 */
  mint: string;
  /** 烦 楼下的电钻声：不烦了（done），一条感受 */
  drill: string;
  /** 喜欢 傍晚河边散步：喜欢中，没有感受 */
  walk: string;
  /** 喜欢 河边慢跑：喜欢中，最近那条感受和一句话是同一句 */
  run: string;
  /** 喜欢 午后那首老歌：喜欢中，没有感受；挂着东西「檐下小夜曲」，别名「小夜曲」 */
  song: string;
  /** 喜欢 雨后石板路的气味：喜欢中，一条感受；按意思找的靶子 */
  rain: string;
  /** 喜欢 竹编小筐：撤掉了（retired） */
  basket: string;
  /** 社团整理器材的下午：普通的事，没有 stance */
  plain: string;
}

/** 河边慢跑那件的一句话：它最近那条感受用的是同一句 */
const RUN_GIST = "不赶时间的慢跑，跑完去长椅上坐一会儿";

/**
 * 白天记喜好的底子（批次 "seed"，写完提交）：十件事，编号 e0001 … e0010 按 LikePool 里的顺序，每件之间时钟拨一分钟（改动时间两两不同）；
 * 感受条目的时间（ago(2) … ago(30)）两两不同，没有感受的事靠改动时间排（比所有感受都新），所以 my_likes 的排序键没有平局。
 * 名字沾边的候选：「河边」同时沾上 傍晚河边散步（6 字）和 河边慢跑（4 字），长短比不同，排得出先后。
 * 全是编的日常小事；人只出现 阿青 / 老林 / 小禾
 */
export function seedLikePool(w: MemWorld): LikePool {
  return fixture("like pool", () => {
    const s = w.s;
    s.openBatch("seed");
    const mk = (title: string, gist: string, summary: string, over: Record<string, unknown> = {}): string => {
      w.clock.tick();
      return s.createEvent({ title, summary, gist, importance: 3, ...over }, "seed").id;
    };
    const felt = (event: string, daysAgo: number, gist: string, full: string): void => {
      s.addEntry({ event, at: ago(daysAgo), kind: "feeling", title: "又一下", gist, full }, "seed");
    };
    const tea = mk("喜欢 桂花乌龙茶", "闻起来像秋天的一种茶，泡到第三道还留着花香", "阿青送的一盒茶，冲开以后有桂花味，第三泡最好喝，我记住了这个味道", { stance: "like" });
    felt(tea, 9, "第一次喝，花香重得有点腻", "第一次泡这个茶放多了叶子，花香重得有点腻，只喝了小半杯就放下了");
    felt(tea, 6, "第三泡的花香最清楚", "下午泡了一壶，第三泡的花香最清楚，坐着把整壶喝完了，一直没有去看手机");
    const meeting = mk("烦 周一早上的例会", "一开会就是把上周做过的事念一遍，念完还要再念一遍", "老林主持的例会总是拖到十一点，大家都在等着散会", { stance: "dislike" });
    felt(meeting, 4, "又拖了四十分钟", "今天的例会又拖了四十分钟，我一直在看墙上的钟，什么也没听进去");
    const mint = mk("喜欢 薄荷糖罐头", "铁皮罐子一打开就哗啦一响的那种糖", "小禾放在抽屉里的一罐薄荷糖，含一颗能清醒半个下午", { stance: "like", status: "done", importance: 2 });
    felt(mint, 30, "吃完了最后一颗就不想再买", "罐子见底的那天我发现自己已经不想再买了，那种凉意吃腻了");
    const drill = mk("烦 楼下的电钻声", "从早上八点开始响的电钻声，震得桌上的杯子都在抖", "楼下装修了三个星期，电钻一响整层楼都能听见", { stance: "dislike", status: "done", importance: 2 });
    felt(drill, 20, "电钻终于停了，耳朵还在嗡", "装修队撤走的那天下午，电钻终于停了，我的耳朵还在嗡嗡响了很久");
    const walk = mk("喜欢 傍晚河边散步", "太阳快落的时候沿着河走一圈，风是凉的", "阿青有时候陪我沿着河慢慢走，走到桥头再折回来", { stance: "like" });
    const run = mk("喜欢 河边慢跑", RUN_GIST, "早上六点的河堤上人很少，跑得慢也没有人催", { stance: "like", importance: 2 });
    felt(run, 3, RUN_GIST, `跑完在长椅上坐着，${RUN_GIST}`);
    const song = mk("喜欢 午后那首老歌", "下午三点左右电台放的一首老歌，旋律很慢", "每次听到前奏就想把手里的事放一放，一直听到最后一句", {
      stance: "like", entities: [{ name: "檐下小夜曲", kind: "work", role: "about" }],
    });
    s.upsertEntity({ name: "檐下小夜曲", aliases: ["小夜曲"], importance: 3 }, "seed");
    const rain = mk("喜欢 雨后石板路的气味", "雨刚停的时候走在老街的石板路上，潮湿的泥土味", "小禾带我走过的一条老街，雨后石板路发亮，空气里是泥土和青苔的味道", { stance: "like" });
    felt(rain, 2, "雨后石板路的气味让人安静", "又走了一遍那条老街，雨后的石板路和泥土的气味让人心里很安静");
    const basket = mk("喜欢 竹编小筐", "老林编的一只小筐，后来发现是记错了人", "以为是老林编的那只竹筐，后来问了才知道是别人送的", { stance: "like", status: "retired", importance: 2 });
    const plain = mk("社团整理器材的下午", "把仓库的器材分类贴上标签，一直忙到天黑", "周六下午和老林一起把仓库里的线材和支架分了类，每个箱子都贴了标签", { importance: 2 });
    s.commitBatch("seed");
    return { tea, meeting, mint, drill, walk, run, song, rain, basket, plain };
  });
}

/**
 * my_likes 翻页用的一大群（在空世界里调，不和 seedLikePool 一起用）：70 件，编号 e0001 … e0070；
 * 0–33 喜欢中、34–49 烦着、50–61 腻了、62–69 不烦了；每件一条感受（时间 ago(1 + k × 0.02)，k 越大越老，所以组里 k 小的在前，键两两不同），
 * 一句话 50–68 字、最近一下 30–46 字（长短各不同）：每行 100 多字，第一页装 30 件（3951 字），第二页装 29 件（3828 字；再装一件是 3968 字，
 * 加上末尾那句的 40 字留位就超了 4000——这一页是留位挡住的），第三页 11 件
 */
export function seedLikeCrowd(w: MemWorld): void {
  fixture("like crowd", () => {
    const s = w.s;
    s.openBatch("seed");
    for (let k = 0; k < 70; k++) {
      const like = k < 34 || (k >= 50 && k < 62);
      const word = like ? "喜欢" : "烦";
      w.clock.tick();
      const id = s.createEvent({
        title: `${word} 第${String(k + 1).padStart(2, "0")}号小物件`,
        summary: pad(`第${k + 1}号小物件的总结`, 60),
        gist: pad(`第${k + 1}号小物件为什么让我${like ? "安心" : "烦躁"}`, 50 + (k % 7) * 3),
        importance: 3, stance: like ? "like" : "dislike", status: k >= 50 ? "done" : "ongoing",
      }, "seed").id;
      s.addEntry({
        event: id, at: ago(1 + k * 0.02), kind: "feeling", title: "又一下",
        gist: pad(`第${k + 1}号最近的一下`, 30 + (k % 5) * 4), full: pad(`第${k + 1}号最近那一下的完整感受`, 90),
      }, "seed");
    }
    s.commitBatch("seed");
  });
}

// ---------- 场景：夜里的工作单（Task 2-0 的 0h：EventMemory.worklist） ----------
// 工作单的那一天是 WORK_DAY（她的一天：本地 04:00 到第二天 04:00，时区 UTC，所以是 11-13 04:00 到 11-14 03:59:59.999）；世界的时钟起点 EV_NOW（11-13 09:00）在这一天里，往后拨的分钟也都在里面。
// 「今天」的原话、经过的发生时间一律写成 11-13 的明确钟点（today()）；往前的日子用 ago()。每个有排序的段，排序键都两两不同：靠 tick() 把改动时间错开，不靠平局。

/** 工作单那一天 */
export const WORK_DAY = "2026-11-13";

/** seedWorkDay 返回的编号：后面要往里加东西的调用用 */
export interface WorkDay {
  /** 小禾挂着的那件事（社团年底的聚餐）：人物卡那几条调用往它的经过里写，让小禾出现在三个不同的日子里 */
  party: string;
}

/** 本地时间 11-13 的 h 点 m 分 */
const today = (h: number, m: number): number => on(13, h, m);

/**
 * 满满的一天（空库里调；用 w.clock，先不拨到 11-13 04:00 以前）。里面有什么，按工作单的节：
 * 1 原话（11-13 05:00 起）：第一团三句（阿青、「我→阿青」、老林）、第二团七句（五分钟一句，中央记忆来的两句，一句「我（笔记）」）、第三团五句（二十五分钟一句：第四句以后离第一句满 90 分钟，从第五句另起一团），
 　共 15 句 4 团；另有一句 note 来源的、一句 11-13 03:30 的（前一天的）、两句已经写进经过出处的（一句中央记忆、一句 honcho），都不列；
 2 今天有进展的事：周六早班车的时刻（两条，总结还没跟上）、海边日出的拍摄计划（一条，总结跟上了），加上白天用 like 记的那些（它们的经过也是今天的）；
 3 疑似重复：社团仓库的器材盘点 / 社团仓库的器材盘点和归档；4 疑似关联：仓库钥匙放在哪个抽屉 / 社团换了新门锁（都有仓库钥匙），主人 OWNER 挂在两件事上（不成对）；
 5 有更正：押金收据的抬头；6 滑出中期视图：吉他弦的更换、年前那场社团演出（最后一条经过在 10-30），旧账本的核对（10-31 04:00 整，差一毫秒不在）不列；
 7 太大的事：老街修缮的全部进展（41 条，下面一件子事件）、社团年度账目的整理（16 条，从 11-10 往前 15 天，没有子事件）；
 8 人和东西：十二个（五种加两种旧种类要调用自己用 SQL 改：老项目账本 → project、旧话题清单 → topic），四个没打重要度，檐下小夜曲五个别名；
 9 喜欢 / 烦：种子里四件进行中的（一件只有感受没有今天的、一件没有感受）和一件腻了没碰的（不列），今天白天用 like 记的七件（腻了一件、不烦了一件、今天又一下一件、今天新建没挂东西的两件〔一件带「以前提过」两件事〕、新建后挂上东西的一件），撤掉两件。
 */
export function seedWorkDay(w: MemWorld): WorkDay {
  return fixture("work day", () => {
    const s = w.s;
    const t = (): void => w.clock.tick();
    const q = (src: QuoteIn["src"], ref: string, when: number, who: string, channel: string, text: string): QuoteIn => ({ src, ref, at: when, who, channel, text });
    w.mem.index.addQuotes([
      q("honcho", "w1", today(5, 0), "阿青", "whatsapp", "早上醒得特别早，窗外还是灰蒙蒙的，我想起周六那趟早班车的事，你有空的话帮我再看一眼七点四十那一班还有没有座位。"),
      q("honcho", "w2", today(5, 10), "我→阿青", "", "我看过了，七点四十那一班还剩靠窗的两个座位，我先替你留着，你起床以后告诉我要不要，我再去确认一下。"),
      q("honcho", "w3", today(5, 20), "老林", "qqbot", "仓库那边的钥匙我放在门口的鞋柜上了，你们谁先到谁自己取，用完记得放回原来的地方，别带走。"),
      q("note", "n1", today(5, 5), "我（笔记）", "", "这是一条笔记类的原话，来源标成 note，工作单不列它。"),
      q("honcho", "w11", today(3, 30), "老林", "", "凌晨三点半还没睡，明天的早班车闹钟已经定好了，这一句属于她前一天的最后一段，不算今天。"),
      q("central", "101", today(7, 0), "小禾", "qqbot", "社团新买的那批吉他弦到了，一共六套，我拆开看了一下，其中两套的包装有点潮，等你们来了一起检查。"),
      q("honcho", "w5", today(7, 5), "阿青", "whatsapp", "我刚到北门，这里的风比想象中大，你们来的时候多带一件外套，不然拍照的时候会冷得发抖，我已经在门口的石阶上先占了个位置。"),
      q("honcho", "w6", today(7, 10), "老林", "", "刨子的事我问过仓库了，在第三格最里面，周日我自己去拿，不用你们特地跑一趟，我顺路。"),
      q("honcho", "w7", today(7, 15), "我（笔记）", "", "记一笔：小禾说社团的押金收据抬头要写全称，老林周日去仓库取刨子，阿青周六早上要赶七点四十的早班车。"),
      q("honcho", "w8", today(7, 20), "小禾", "qqbot", "今天整理器材的时候发现一箱旧线材，大部分还能用，我先分类贴了标签，放在了仓库靠窗的架子上。"),
      q("central", "102", today(7, 25), "阿青", "whatsapp", "到站了，海边的云很厚，日出大概要等到云散开才能看到，我先在石阶上找个位置坐着等你们。"),
      q("honcho", "w9", today(7, 30), "老林", "", "我这边的事情提前办完了，晚一点可以过去和你们碰头，路上顺便买点热的东西带过去，不用等我吃饭。"),
      q("central", "103", today(8, 30), "阿青", "whatsapp", "这一句已经被写进事件的时间线了，所以工作单里不该再列它，它的出处编号会出现在某条经过的 source 里。"),
      q("honcho", "w10", today(8, 40), "老林", "", "这一句也已经进了时间线，出处写的是 q 开头的编号，所以同样不会出现在还没进事件库的材料里。"),
      q("honcho", "w12", today(10, 0), "阿青", "whatsapp", "中午想吃点热的，楼下新开的那家汤面店听说味道不错，你们要是也在附近的话可以一起去试试。"),
      q("honcho", "w13", today(10, 25), "小禾", "qqbot", "社团下周的活动场地定下来了，在老街尽头的那间旧仓库，租金比预想的便宜，只是没有暖气。"),
      q("honcho", "w14", today(10, 50), "我→老林", "", "刨子的事你放心，我已经跟仓库的人说好了，周日你直接过去报名字就行，不用再带什么证明。"),
      q("honcho", "w15", today(11, 15), "老林", "", "收到，周日我十点之前到，顺便把上次借的那把锯子也还回去，免得下次又忘了放在哪里。"),
      q("honcho", "w16", today(11, 40), "阿青", "whatsapp", "我这边也差不多了，下午回家以后把今天拍的照片整理一下发给你们，挑几张好看的放进社团的相册里。"),
    ]);
    const qid = (src: string, ref: string): number => {
      const r = one<{ id: number }>(w.db, "SELECT id FROM mem_quote WHERE src = ? AND ref = ?", src, ref);
      if (!r) throw new FixtureError(`quote ${src}/${ref} was not stored`);
      return r.id;
    };

    s.openBatch("seed");
    // 名单：前九个明着登记（重要度各不相同；老项目账本、旧话题清单先登记成东西，调用用 SQL 改成旧种类），后三个由事件挂上时顺带登记（没打重要度）
    s.upsertEntity({ name: "阿青", kind: "person", person_key: "qing", importance: 4, why: "常联系的朋友，周六的行程都是她托的", note: "周六要去海边看日出" }, "seed");
    s.upsertEntity({ name: "老林", kind: "person", person_key: "zhou", importance: 3, note: "借走了仓库的刨子" }, "seed");
    s.upsertEntity({ name: "小禾", kind: "person", person_key: "he", importance: 2, note: "管社团的押金" }, "seed");
    s.upsertEntity({ name: "社团群聊", kind: "group", importance: 2, note: "社团的人都在里面" }, "seed");
    s.upsertEntity({ name: "檐下小夜曲", kind: "work", importance: 3, aliases: ["小夜曲", "夜曲", "檐下曲", "那首老歌", "午后的歌"] }, "seed");
    s.upsertEntity({ name: "旧相机", kind: "thing", importance: 3 }, "seed");
    s.upsertEntity({ name: "木吉他", kind: "thing", importance: 1 }, "seed");
    s.upsertEntity({ name: "老项目账本", kind: "thing", importance: 2 }, "seed");
    s.upsertEntity({ name: "旧话题清单", kind: "thing" }, "seed");

    /** 一件事：先拨一分钟（改动时间两两不同） */
    const mk = (title: string, over: Record<string, unknown> = {}): string => {
      t();
      return s.createEvent({ title, summary: pad(`${title}的总结：阿青托我把这件事盯到周六`, 60), gist: pad(`${title}的一句话`, 26), importance: 2, ...over }, "seed").id;
    };
    let k = 0;
    /** 一条经过：原文带序号，每条都不一样 */
    const note = (event: string, when: number, title: string, over: Record<string, unknown> = {}): string => {
      k += 1;
      return s.addEntry({ event, at: when, kind: "happened", full: pad(`第 ${k} 条经过（${title}）：阿青说周六早班车七点四十，老林说周日去仓库`, 80), gist: pad(`${title}的大意${k}`, 24), title, source: [], ...over }, "seed").entry.id;
    };
    const feel = (event: string, days: number, gist: string, full: string): void => {
      s.addEntry({ event, at: ago(days), kind: "feeling", title: "又一下", gist, full }, "seed");
    };
    const about = (name: string, kind: string): Record<string, unknown> => ({ name, kind, role: "about" });

    // 4 疑似关联：两件事都有仓库钥匙（登记时没打重要度）
    mk("仓库钥匙放在哪个抽屉", { entities: [about("仓库钥匙", "thing")] });
    mk("社团换了新门锁", { entities: [about("仓库钥匙", "thing")] });
    // 主人挂在两件事上：不成对。阿青、老林、北门各只挂一件
    mk("周六去海边的行程", { entities: [qing, { name: "北门", kind: "place", role: "where" }, ownerRef] });
    mk("借给老林的那把刨子", { entities: [zhou, ownerRef] });
    mk("那首老歌的来历", { entities: [about("檐下小夜曲", "work")] });
    const party = mk("社团年底的聚餐", { entities: [he] });
    // 9 以前提过「青梅酒」的两件事：一件在总结里，一件在一条经过的原文里（都不是喜欢 / 烦的事）；经过的发生时间不同，排得出先后
    const wine1 = mk("年底聚餐的酒水清单", { summary: "年底社团聚餐定了酒水，老林带来一瓶自己泡的青梅酒，大家都说甜了点，下回少放糖。" });
    note(wine1, ago(6), "酒水的分工");
    const wine2 = mk("老林泡酒的小本子");
    note(wine2, ago(4), "泡酒的那一页", { full: "翻到泡青梅酒的那一页，老林写着要泡满三个月，不能提前开瓶，瓶口要用蜡封。", gist: "泡青梅酒要满三个月" });
    // 3 疑似重复：一个标题包着另一个，都没有立场、没连过
    mk("社团仓库的器材盘点");
    mk("社团仓库的器材盘点和归档");
    // 2 今天有进展：E3 的总结早于经过（总结还没跟上），E4 的总结在经过之后又改过
    const bus = mk("周六早班车的时刻", { importance: 3 });
    t();
    note(bus, today(5, 30), "早班车的时刻", { source: [`q${qid("honcho", "w10")}`, "c:103"] });
    t();
    note(bus, today(6, 15), "换乘的几种坐法");
    const sunrise = mk("海边日出的拍摄计划");
    t();
    note(sunrise, today(8, 0), "机位和时间");
    t();
    s.updateEvent(sunrise, { gist: "日出前四十分钟到北门，机位选在石阶第三级" }, "补上了总结里漏的机位", "seed");
    // 5 有更正：更正的经过比事件的总结新
    const receipt = mk("押金收据的抬头");
    const first = note(receipt, ago(3), "收据抬头写法");
    t();
    s.correctEntry(first, { full: pad("更正：小禾说收据抬头要写社团全称，不是简称，上次写错了一个字", 50), gist: "抬头要写社团全称", title: "抬头改成全称", why: "小禾当面核对过" }, "seed");
    // 6 滑出中期视图：最后一条经过在 10-30（14 天前那一天），差一毫秒的 10-31 04:00 整不在
    note(mk("吉他弦的更换"), Date.UTC(2026, 9, 30, 12, 0), "换了第三根弦");
    note(mk("年前那场社团演出"), Date.UTC(2026, 9, 30, 20, 0), "演出前的彩排");
    note(mk("旧账本的核对"), Date.UTC(2026, 9, 31, 4, 0), "核对到第几页");
    // 7 太大的事：41 条（有子事件）、16 条跨 15 天（没有子事件）；经过都在今天以前，不进第 2 节
    const street = mk("老街修缮的全部进展");
    for (let i = 0; i < 41; i++) note(street, ago(2 + i * 0.5), `修缮进展${i + 1}`);
    mk("石板路这一段的返工", { parent: street });
    const books = mk("社团年度账目的整理");
    for (let i = 0; i < 16; i++) note(books, ago(3 + i), `账目第${i + 1}笔`);
    // 9 喜欢 / 烦：种子里的（批次 seed，不是白天记的）
    const tea = mk("喜欢 桂花乌龙茶", { stance: "like", importance: 3, gist: "闻起来像秋天的一种茶，泡到第三道还留着花香", summary: "阿青送的一盒茶，冲开以后有桂花味，第三泡最好喝，我记住了这个味道" });
    feel(tea, 9, "第一次喝，花香重得有点腻", "第一次泡这个茶放多了叶子，花香重得有点腻，只喝了小半杯就放下了");
    feel(tea, 5, "第三泡的花香最清楚", "下午泡了一壶，第三泡的花香最清楚，坐着把整壶喝完了，一直没有去看手机");
    const meeting = mk("烦 周一早上的例会", { stance: "dislike", importance: 3, gist: "一开会就是把上周做过的事念一遍，念完还要再念一遍", summary: "老林主持的例会总是拖到十一点，大家都在等着散会" });
    feel(meeting, 7, "又拖了四十分钟", "今天的例会又拖了四十分钟，我一直在看墙上的钟，什么也没听进去");
    const mint = mk("喜欢 薄荷糖罐头", { stance: "like", status: "done", importance: 2, gist: "铁皮罐子一打开就哗啦一响的那种糖", summary: "小禾放在抽屉里的一罐薄荷糖，含一颗能清醒半个下午" });
    feel(mint, 30, "吃完了最后一颗就不想再买", "罐子见底的那天我发现自己已经不想再买了，那种凉意吃腻了");
    const walk = mk("喜欢 傍晚河边散步", { stance: "like", importance: 3, gist: "太阳快落的时候沿着河走一圈，风是凉的", summary: "阿青有时候陪我沿着河慢慢走，走到桥头再折回来" });
    feel(walk, 4, "走到桥头的时候天刚好暗下来", "这周又沿着河走了一圈，走到桥头的时候天刚好暗下来，风里有桂花的味道");
    mk("烦 楼上的拖鞋声", { stance: "dislike", importance: 3, gist: "深夜里一下一下拖着走的声音，像有人在天花板上数步子", summary: "楼上新搬来的住户习惯穿硬底拖鞋，夜里走动的声音很清楚" });
    s.commitBatch("seed");

    // 9 白天自己记的（mem.like，每次自己一批 day-like:<时刻>，先拨一分钟）；返回的话不对（比如列了候选没建）就是夹具错
    const say = (a: LikeArgs, head: string, must = ""): void => {
      t();
      const r = plain(w.mem.like(a));
      if (!r.startsWith(head) || !r.includes(must)) throw new FixtureError(`like ${a.how} ${a.what}: ${r}`);
    };
    say({ what: "凉拌木耳的脆劲", how: "like", feeling: "夜市摊子上拌的木耳，咬下去嘎嘣脆，酸辣刚好，吃了两碗还想要" }, "建好了");
    say({ what: "青梅酒", how: "like", feeling: "老林那天带来的青梅酒，酸甜里带一点点酒气，倒在冰块上特别舒服" }, "建好了", "里提过");
    say({ what: "巷口的吉他声", how: "like", feeling: "傍晚路过巷口，有人弹着一把旧吉他，不成调但很温柔，我在墙边站了一会儿" }, "建好了");
    const guitar = one<{ id: string }>(w.db, "SELECT id FROM mem_event WHERE title = ?", "喜欢 巷口的吉他声");
    if (!guitar) throw new FixtureError("the guitar like was not stored");
    s.openBatch("attach");
    s.tagEntity("木吉他", guitar.id, "about", "attach");
    s.commitBatch("attach");
    say({ what: "河边慢跑", how: "like", feeling: "早上六点的河堤上人很少，跑得慢也没有人催，跑完在长椅上坐着出汗" }, "建好了");
    say({ what: "河边慢跑", how: "over", feeling: "跑了一个月，开始觉得每天早起太累，不想再跑了" }, "记上了");
    say({ what: "楼下的电钻声", how: "dislike", feeling: "从早上八点开始响的电钻声，震得桌上的杯子都在抖，什么也做不成" }, "建好了");
    say({ what: "楼下的电钻声", how: "over", feeling: "装修队今天撤走了，电钻终于停了，耳朵里还嗡嗡响了很久" }, "记上了");
    say({ what: "傍晚河边散步", how: "feel", feeling: "今天陪阿青走到了桥头，她说想把这条路一直走下去，我也是" }, "记上了");
    // 撤掉两件（先喜欢 / 烦上，再 drop）：第 9 节末尾列出来
    say({ what: "竹编小筐", how: "like", feeling: "以为是老林编的那只小筐，摸起来很光滑，放在窗边挺好看" }, "建好了");
    say({ what: "竹编小筐", how: "drop", why: "问了才知道是别人送的，我记错了人" }, "e0");
    say({ what: "弹窗广告的声音", how: "dislike", feeling: "一打开应用就弹出来，吵得人心烦，关了又来" }, "建好了");
    say({ what: "弹窗广告的声音", how: "drop", why: "其实不是烦它，是当时心情不好" }, "e0");
    // 工作清单里「最近的事」那一趟查询没有 ORDER BY，按 rowid 扫；重复那一行和「都有」那一行朝哪边写，看的是 e0001 / e0002、e0009 / e0010 谁先扫到。
    // 这四件建好以后没有再被改写过（改写会让那一行挪到最后），所以先后就是建的先后。以后谁在这个种子里给它们加了经过、改了它们，
    // 这里大声失败，不钉下一个朝向悄悄变了的结果。
    const scan = all<{ id: string }>(w.db, "SELECT id FROM mem_event WHERE id IN ('e0001', 'e0002', 'e0009', 'e0010') ORDER BY rowid").map((r) => r.id).join(" ");
    if (scan !== "e0001 e0002 e0009 e0010") throw new FixtureError(`seedWorkDay: the scan order of the four oriented events changed (${scan})`);
    return { party };
  });
}

/** n 句原话，每句隔 31 分钟（11-13 04:05 起），不会并成一团：n = 41 就是 41 团 */
export function seedQuoteCrowd(w: MemWorld, n: number): void {
  fixture("quote crowd", () => {
    const who = ["阿青", "老林", "小禾"];
    w.mem.index.addQuotes(Array.from({ length: n }, (_, i): QuoteIn => ({
      src: "honcho", ref: `m${i + 1}`, at: today(4, 5) + i * 31 * MIN, who: who[i % 3] ?? "阿青", channel: i % 2 ? "whatsapp" : "",
      text: pad(`第 ${i + 1} 句：周六早班车的事、仓库的钥匙和社团的押金`, 40 + i),
    })));
  });
}

/** 41 件的名字：互相不像（同一边两两的相似度都不到 0.5），不重复 */
const HELD_THINGS = [
  "蓝莓酸奶", "红豆沙冰", "老式收音机", "旧毛线帽", "晒过的被子", "木勺子", "玻璃弹珠", "雨天的公交", "黄油曲奇", "纸质书签", "小区的桂花", "电风扇的声音", "热毛巾", "竹制书架",
  "夜市的烤红薯", "旧唱片", "围棋子", "陶瓷小猫", "蒲公英", "铁皮饼干盒", "薄荷牙膏", "清晨的鸟叫", "手写的信", "羊毛袜", "咖啡渣蛋糕", "海盐饼干", "旧地图", "纸飞机",
  "铅笔的味道", "楼顶的晾衣绳", "窗边的绿萝", "公园的长椅", "红茶包", "煮玉米", "空酒瓶花瓶", "傍晚的蝉鸣", "石榴汁", "泡面的热气", "皮质笔记本", "小号练习曲", "折叠伞",
] as const;

/**
 * 喜欢 / 烦着的事 n 件（空库里调，n 最多 41），全是进行中的（每三件里第三件是烦）：编号 e0001 起，每件之间拨一分钟，各有一条感受，
 * 时间 ago(1 + 0.02 × 序号) 两两不同（序号越大越老），所以第 9 节的排序键没有平局；经过都在今天以前
 */
export function seedHeldCrowd(w: MemWorld, n: number): void {
  fixture("held crowd", () => {
    const s = w.s;
    s.openBatch("seed");
    for (let i = 0; i < n; i++) {
      const thing = HELD_THINGS[i];
      if (thing === undefined) throw new FixtureError(`held crowd: only ${HELD_THINGS.length} names, asked for ${n}`);
      const like = i % 3 !== 2;
      w.clock.tick();
      const id = s.createEvent({
        title: `${like ? "喜欢" : "烦"} ${thing}`, summary: pad(`第${i + 1}件：${thing}的总结`, 60), gist: pad(`${thing}为什么${like ? "让我安心" : "让我烦躁"}（${i + 1}）`, 40),
        importance: 3, stance: like ? "like" : "dislike",
      }, "seed").id;
      s.addEntry({ event: id, at: ago(1 + i * 0.02), kind: "feeling", title: "又一下", gist: pad(`${thing}的最近一下（${i + 1}）`, 24), full: pad(`${thing}最近那一下的完整感受（${i + 1}）`, 60) }, "seed");
    }
    s.commitBatch("seed");
  });
}
