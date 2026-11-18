// 记忆文字的钉子（Task 0）：一张有名字的调用清单，每一条返回「今天记忆层在这种情况下说的原话」。
// 公共的部分（登记、指纹、拆成回复和其余、覆盖闸）在 test/textpins/lib.ts；夹具（内存库、固定时钟、场景）在 test/memtext/world.ts；这里只有清单。
// 导入这个文件只登记 id，什么都不建：库、记忆对象都在每条调用的 run 里建、用完关；环境变量和时区在 renderAll 里动、做完还原。
// 记忆层渲染的文字没有「回复后面接的踪迹 / 文件」：整段文字就是回复，rest 恒为空。
// 以后把 src/memory/ 里的文字挪走，这些调用算出的指纹必须一个字节不差（test/memory-text.pins.json 存着今天的指纹）。
// 这个文件和 pins 文件在 Task 0 之后不再改：挪文字时发现要加调用或改指纹，说明挪错了。
// 纯确定性：时钟固定在 T0，时区显式传；没有网络、没有真库。只有 0d 的「情境」那组调用碰文件：临时根在 renderAll 里建、用完删，文字里的临时根换成 <TMP>；脚本一律走假的 Runner。
// 夹具里的名字只用 阿青 / 老林 / 小禾；下面用到的「代码认的记号」（感官、带「提醒」的来源、--who 我）都在用到的地方写明。
// 0a 管 central.ts 和 recall.ts；0b 管 events/render.ts 和 events/midterm.ts；0c 管 events/recall.ts；0d 管 situation.ts 和 events/exam.ts；每段把自己的文件加进 test/memory-text.test.ts 的 COMPLETE。
// events/recall.ts 里直接读真时钟的只有 associate 头尾的 Date.now()（t0 和 ms，没有注入口）：那几条调用用 withClock 把 Date.now 钉住，ms 也不进文字；别处的 now 都是传进去的 EV_NOW。
import { foldAct, renderMemory, sentBody, truncate } from "../../src/memory/central.ts";
import type { Entry, RenderOpts, TimeMarks } from "../../src/memory/central.ts";
import { recallCentral } from "../../src/memory/recall.ts";
import type { RecallOpts } from "../../src/memory/recall.ts";
import { renderEvents } from "../../src/memory/events/render.ts";
import type { RenderEvent, RenderOpts as EventRenderOpts } from "../../src/memory/events/render.ts";
import { renderMidterm } from "../../src/memory/events/midterm.ts";
import { lowInfo, parseRange } from "../../src/memory/events/recall.ts";
import type { Range } from "../../src/memory/events/recall.ts";
import { cardOf } from "../../src/memory/situation.ts";
import type { HumanContext, Said } from "../../src/memory/situation.ts";
import { likeKey, likeMatch, stripLikePrefix } from "../../src/memory/events/memory.ts";
import type { EventMemory, WriteOp } from "../../src/memory/events/memory.ts";
import { parseExam } from "../../src/memory/events/exam.ts";
import type { ExamQuestion } from "../../src/memory/events/exam.ts";
import { examQuestion, examRole } from "./direct.ts";
import { FixtureError, caught, createRegistry, makeNorm, renderAll as renderList, withEnv } from "../textpins/lib.ts";
import type { Call, Rendered } from "../textpins/lib.ts";
import { mock } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EV_NOW, TZ, ago, inEvents, inEventsAsync, inWorld, label, pad, sceneChildren, sceneCorrections, sceneEntries, sceneFoldDay, sceneHelper, sceneInputs, sceneKinds, sceneLevels,
  sceneLinks, sceneMany, sceneMarks, sceneMeta, sceneRecall, sceneStances, sceneStatuses, sceneTools,
  seedCrowd, seedDated, seedFull, seedLikes, seedManyOwnerQuotes, seedOwnerQuotes, seedRecent, seedStale, seedToday, seedTodayEarly,
  LOAD_OK, OLD_LEDGER, inPeopleMemory, makeSit, profileDoc, putFile, putLoad, said, sitDirs, sitLogger, usDoc,
  OWNER, fakeEmbedder, fixture, plain, seedAssoc, seedAssocQuotes, seedCluster, seedExpand, seedPeople, seedPeriod, seedPersonCrowd, seedQuoteLines, seedReverseBare, seedReverseFull, seedTitles,
  evOf, inMemory, inMemoryAsync, nightEntry, seedCards, seedNightBase, seedQuoteLayer,
  deadEmbedder, fixtureAsync, recordingEmbedder, seedLikeCrowd, seedLikePool,
  WORK_DAY, seedHeldCrowd, seedQuoteCrowd, seedWorkDay,
} from "./world.ts";
import type { EvOpts, EvWorld, LikePool, LoadStatus, MemOpts, MemWorld, RecallWorld, SitDirs, SitOpts, SitWorld, WorkDay, World } from "./world.ts";
import type { Person } from "../../src/persona/people.ts";

const { add, calls } = createRegistry();

/**
 * 本次运行的临时根的路径（只是一个名字，导入时不建）：renderAll 开始时建、结束时删。文字里它换成 <TMP>，所以每次运行随机的目录名不进指纹。
 * 只有「情境」那组调用往里写（每条调用自己一个子目录）
 */
const ROOT = join(tmpdir(), `hh-memtext-${process.pid}-${randomBytes(4).toString("hex")}`);

/**
 * 渲染整张清单：每条一个 { reply, rest }（rest 只有「情境」里带脚本踪迹的那几条非空）。先把环境理好（去掉 HH_*、时区 UTC、建临时根），跑完不管成不成都还原、删掉。
 * 夹具自己的错（TypeError / ReferenceError / FixtureError）不记成记忆的话，直接抛。文字里的临时根换成 <TMP>
 */
export async function renderAll(): Promise<Record<string, Rendered>> {
  return withEnv({ deletePrefixes: ["HH_"], set: { TZ: "UTC" } }, async () => {
    mkdirSync(ROOT, { recursive: true });
    try {
      return await renderList(CALLS, makeNorm(ROOT));
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
}

// ---------- 小工具 ----------

type Scene = (w: World) => Entry[];
/** 在一个新世界里把一个场景渲染成记忆（marks 这类有状态的选项由调用的箭头函数每次新建，别在这里共用） */
const rm = (scene: Scene, opts: Partial<RenderOpts> = {}, maxItemChars = 300): string =>
  inWorld((w) => renderMemory(scene(w), label, { maxItemChars, timezone: TZ, ...opts }));

/** 一条动作记录（可以带或不带 meta.tool）经 foldAct 压成一句 */
const foldOf = (text: string, meta: Record<string, unknown> | null = null): string =>
  inWorld((w) => foldAct(w.put(0, "side-a", "act", text, meta)));
const args = (a: Record<string, unknown>): string => JSON.stringify(a);

// ---------- renderMemory：full ----------

add("render full: every arm of an input, time marks with and without the day", () => rm(sceneInputs, {}, 150));
add("render full: with viewer main a report of another owner over 200 characters is cut, one with no owner (main's) is not", () => rm(sceneHelper, { viewer: "main" }, 400));
add("render full: with viewer helper-b its own report is whole and the others are cut", () => rm(sceneHelper, { viewer: "helper-b" }, 400));
add("render full: without a viewer no helper report is cut by the helper rule", () => rm(sceneHelper, {}, 300));
add("render full: every kind, an unsent say, an insight, act names, a system line", () => rm(sceneKinds, {}, 300));
add("render full: a small item limit cuts items and says where the whole is", () => rm(sceneKinds, {}, 40));
add("render full: seqs on every line", () => rm(sceneKinds, { seqs: true }, 300));
add("render full: brief header", () => rm(sceneKinds, { brief: true }, 300));
add("render full: brief header with seqs", () => rm(sceneInputs, { brief: true, seqs: true }, 150));
add("render full: sync-only options do nothing in full mode (same text as render full: an explicit full mode wins over the fold flag: pins the path)", () => rm(sceneTools, { viewer: "main", fullFor: "side-a", thinkChars: 60 }, 400));
add("render full: an explicit full mode wins over the fold flag", () => rm(sceneTools, { mode: "full", fold: true }, 400));

// ---------- renderMemory：fold ----------

add("render fold: the fold flag", () => rm(sceneTools, { fold: true }, 400));
add("render fold: the fold mode with seqs", () => rm(sceneTools, { mode: "fold", seqs: true }, 400));
add("render fold: brief header", () => rm(sceneTools, { fold: true, brief: true }, 400));
add("render fold: kinds, an unsent say, an insight and a short result", () => rm(sceneKinds, { mode: "fold" }, 300));
add("render fold: inputs are not folded", () => rm(sceneInputs, { fold: true }, 150));

// ---------- renderMemory：sync ----------

add("render sync: viewer main (same text as render sync: an explicit sync mode wins over the fold flag: pins the path)", () => rm(sceneTools, { mode: "sync", viewer: "main" }, 400));
add("render sync: viewer main with thinkChars", () => rm(sceneTools, { mode: "sync", viewer: "main", thinkChars: 60 }, 400));
add("render sync: viewer main, fullFor another part, thinkChars and seqs", () => rm(sceneTools, { mode: "sync", viewer: "main", fullFor: "side-a", thinkChars: 60, seqs: true }, 400));
add("render sync: fullFor without a viewer", () => rm(sceneTools, { mode: "sync", fullFor: "helper-b" }, 400));
add("render sync: no viewer (same text as render sync: an explicit sync mode wins over the fold flag: pins the path)", () => rm(sceneTools, { mode: "sync" }, 400));
add("render sync: brief header", () => rm(sceneTools, { mode: "sync", viewer: "main", brief: true }, 400));
add("render sync: a helper report of another part is cut for its viewer", () => rm(sceneHelper, { mode: "sync", viewer: "main" }, 400));
add("render sync: kinds, an unsent say, act names and a system line", () => rm(sceneKinds, { mode: "sync", viewer: "main", thinkChars: 30 }, 300));
add("render sync: an explicit sync mode wins over the fold flag", () => rm(sceneTools, { mode: "sync", fold: true, viewer: "main" }, 400));

// ---------- renderMemory：时间标记、没有东西可渲染 ----------

const MARK_MINUTES = [0, 10, 29, 30, 45, 100, 1500] as const;
add("render marks: a fresh state marks the first line, then every half hour, and the day when it changed", () => rm((w) => sceneMarks(w, MARK_MINUTES), {}, 300));
add("render marks: the same state continued across two renders, and a fresh state for the second", () => inWorld((w) => {
  const es = sceneMarks(w, MARK_MINUTES);
  const first = es.slice(0, 3);
  const second = es.slice(3);
  const marks: TimeMarks = { last: null };
  const o = { maxItemChars: 300, timezone: TZ };
  const a = renderMemory(first, label, { ...o, marks });
  const b = renderMemory(second, label, { ...o, marks });
  const c = renderMemory(second, label, o);
  return [a, b, c, JSON.stringify(marks)].join("\n=====\n");
}));
add("render marks: a time zone with a different day line", () => inWorld((w) => {
  const es = sceneMarks(w, MARK_MINUTES);
  return renderMemory(es, label, { maxItemChars: 300, timezone: "America/Sao_Paulo", marks: { last: null } });
}));
add("render marks: a start state that marked the evening before", () => inWorld((w) => {
  const es = sceneMarks(w, [0, 20, 90]);
  return renderMemory(es, label, { maxItemChars: 300, timezone: TZ, marks: { last: es[0]!.ts - 4 * 3_600_000 } });
}));
add("render: no entries", () => renderMemory([], label, { maxItemChars: 300, timezone: TZ }));
add("render: only an unsent mark leaves nothing to say", () => inWorld((w) => {
  const say = w.put(0, "main", "say", pad("这一段话在上一段增量里", 50));
  const mark = w.put(1, "main", "note", "（上面这段没发给任何人）", { unsent: true, of: [say.seq] });
  return `[${renderMemory([mark], label, { maxItemChars: 300, timezone: TZ })}]`;
}));

// ---------- foldAct、truncate、sentBody ----------

add("foldAct: path, description and the tool by its real name", () => foldOf(`read_file ${args({ file_path: "/ws/notes/qing.md", description: "读阿青留下的出行笔记" })}`, { tool: "read_file" }));
add("foldAct: notebook path and query", () => foldOf(`NotebookEdit ${args({ notebook_path: "/ws/nb/zhou.ipynb", query: "老林的刨子在哪一格" })}`, { tool: "NotebookEdit" }));
add("foldAct: plain path and pattern, tool taken from the first word", () => foldOf(`grep ${args({ path: "/ws/notes/he.md", pattern: "小禾的社团押金" })}`));
add("foldAct: url alone", () => foldOf(`web_fetch ${args({ url: "https://example.test/timetable/saturday" })}`, { tool: "web_fetch" }));
add("foldAct: a command of exactly 80 characters is not cut", () => foldOf(`Bash ${args({ command: pad("ls 阿青", 80) })}`, { tool: "Bash" }));
add("foldAct: a command over 80 characters is cut with an ellipsis", () => foldOf(`Bash ${args({ command: pad("grep 老林的刨子", 81) })}`, { tool: "Bash" }));
add("foldAct: a command with a path", () => foldOf(`Bash ${args({ file_path: "/ws/out/he.md", command: "cat 小禾的社团名单" })}`, { tool: "Bash" }));
add("foldAct: a description wins over a command", () => foldOf(`Bash ${args({ description: "列出阿青的笔记", command: "ls /ws/notes/qing" })}`, { tool: "Bash" }));
add("foldAct: nothing to show but the tool", () => foldOf("ack {}", { tool: "ack" }));
add("foldAct: a tool that already carries its prefix is left alone", () => foldOf(`mcp__other__lookup ${args({ query: "小禾的鸭子" })}`, { tool: "mcp__other__lookup" }));
add("foldAct: escaped newline and quote inside a value", () => foldOf(`task ${args({ description: "读一段带\n换行和\"引号\"的说明" })}`, { tool: "task" }));
add("foldAct: a tool with neither path nor what (pick falls through)", () => foldOf(args({ query: "老林" }), { tool: "sticker" }));

add("truncate: a short text is returned as is", () => truncate("阿青的短消息", 20, 7));
add("truncate: a text of exactly the limit is returned as is", () => truncate(pad("老林的刨子", 30), 30, 8));
add("truncate: a longer text is cut and says the full length and the number", () => truncate(pad("小禾的社团名单", 61), 30, 9));

add("sentBody: the head of a sent line is removed", () => sentBody("（发给 阿青）周六五点半，楼下见。"));
add("sentBody: a name with a bracket inside keeps its whole head", () => sentBody("（发给 陌生人（+6155500020））你好，请问是小禾吗？"));
add("sentBody: a text without the head is returned as is", () => sentBody("没有抬头的一句话：老林的刨子找到了。"));

// ---------- recallCentral ----------

const RECALL_LABELS = (s: string): string => (s === "main" ? "我" : s === "side-a" ? "另一头" : s);
type Rows = RecallWorld["rows"];
/** 在一个新世界里写好场景，按场景里的记录拼出参数再问；o 盖掉默认的选项 */
const rc = (build: (r: Rows) => string[], o: Partial<RecallOpts> = {}): string =>
  inWorld((w) => recallCentral(w.db, build(sceneRecall(w).rows), { timezone: TZ, labels: RECALL_LABELS, ...o }));
const WORD = "蓝莓果酱";

add("recall search: every label of who (outside, a name, sent with a name, to only, neither, note, say, unsent say)", () => rc(() => ["search", WORD]));
add("recall search: two words must both match", () => rc(() => ["search", `${WORD} 阿青`]));
add("recall search: a limit", () => rc(() => ["search", WORD, "-n", "3"]));
add("recall search: a limit from the options", () => rc(() => ["search", WORD], { limit: 2 }));
add("recall search: a clipped row, and the same row whole with full", () => `${rc(() => ["search", "旧配方"])}\n=====\n${rc(() => ["search", "旧配方"], { full: true })}`);
add("recall search: who a name", () => rc(() => ["search", WORD, "--who", "阿青"]));
add("recall search: who is a name nobody has", () => rc(() => ["search", WORD, "--who", "老林老林"]));
add("recall search: who 我 asks for her own rows (same text as recall search: who in capitals matches lower case: pins the path)", () => rc(() => ["search", WORD, "--who", "我"]));   // 「我」是代码认的记号：问「我」才算她自己说的、记的、发出去的
add("recall search: who in capitals matches lower case", () => rc(() => ["search", WORD, "--who", "MIRA"]));
add("recall search: nothing matches", () => rc(() => ["search", "完全不存在的一句话"]));
add("recall search: an empty query", () => rc(() => ["search", "   "]));
add("recall search: no query at all", () => rc(() => ["search"]));
add("recall search: another time zone", () => rc(() => ["search", WORD, "-n", "4"], { timezone: "Asia/Shanghai" }));

add("recall day: the rows of that day, from four in the morning", () => rc(() => ["day", "2026-11-13"]));
add("recall day: the early hours belong to the day before", () => rc(() => ["day", "2026-11-12"]));
add("recall day: who a name", () => rc(() => ["day", "2026-11-13", "--who", "小禾"]));
add("recall day: a day without rows", () => rc(() => ["day", "2025-01-01"]));
add("recall day: a bad date", () => rc(() => ["day", "13/11/2026"]));
add("recall day: no date", () => rc(() => ["day"]));
add("recall day: another time zone", () => rc(() => ["day", "2026-11-13"], { timezone: "Asia/Shanghai" }));

add("recall show: one row whole, by its number", () => rc((r) => ["show", String(r.long.seq)]));
add("recall show: by #number", () => rc((r) => ["show", `#${r.say.seq}`]));
add("recall show: by c:number", () => rc((r) => ["show", `c:${r.sentName.seq}`]));
add("recall show: a think row", () => rc((r) => ["show", String(r.think.seq)]));
add("recall show: a row of a kind the other modes never list", () => rc((r) => ["show", String(r.system.seq)]));
add("recall show: a number nobody has", () => rc(() => ["show", "9999"]));
add("recall show: not a number", () => rc(() => ["show", "abc"]));
add("recall show: no number", () => rc(() => ["show"]));
add("recall show: a long row, the first page (same text as recall show: a bad --from starts at the beginning: pins the path)", () => rc((r) => ["show", String(r.huge.seq)]));
add("recall show: the second page with --from", () => rc((r) => ["show", String(r.huge.seq), "--from", "30000"]));
add("recall show: the last page has no tail", () => rc((r) => ["show", `#${r.huge.seq}`, "--from", "60000"]));
add("recall show: a bad --from starts at the beginning", () => rc((r) => ["show", String(r.huge.seq), "--from", "abc"]));
add("recall show: a negative --from starts at the beginning (same text as recall show: a bad --from starts at the beginning: pins the path)", () => rc((r) => ["show", String(r.huge.seq), "--from", "-5"]));

add("recall around: the rows around an act, with act and result labels", () => rc((r) => ["around", String(r.act.seq), "-n", "3"]));
add("recall around: the default limit around a row", () => rc((r) => ["around", String(r.sentTo.seq)]));
add("recall around: by #number", () => rc((r) => ["around", `#${r.note.seq}`, "-n", "1"]));
add("recall around: not a number", () => rc(() => ["around", "xyz"]));
add("recall around: no number", () => rc(() => ["around"]));

add("recall: an unknown mode", () => rc(() => ["wander", WORD]));
add("recall: no mode", () => rc(() => []));

// ---------- events/render.ts：renderEvents ----------

/** 预算够大、件数不限的默认选项；now 是固定的 EV_NOW，时区显式；o 盖掉 */
const re = (list: RenderEvent[], o: Partial<EventRenderOpts> = {}): string => renderEvents(list, { now: EV_NOW, tz: TZ, budget: 6000, maxEvents: 40, ...o });

add("render events: the five statuses and one the code does not know", () => re(sceneStatuses()));
add("render events: the four stance marks, a retired stance event has none", () => re(sceneStances()));
add("render events: next day, superseded by, parent, people, origin, and a head with none of them", () => re(sceneMeta()));
add("render events: the same days in another time zone", () => re(sceneMeta(), { tz: "Pacific/Honolulu" }));
add("render events: the three levels, never active, pinned, brief", () => re(sceneLevels()));
add("render events: compact writes every event as one sentence", () => re(sceneLevels(), { compact: true }));
add("render events: a header line counts in the budget", () => re(sceneStatuses(), { header: "想起来的（编号可以展开）：" }));

add("render entries: three clarities, a faded one left out, an old quote kept, the rest folded over several days", () => re(sceneEntries()));
add("render entries: one entry per event folds the rest over several days (same text as render entries: a budget too tight for the lines folds them: pins the path)", () => re(sceneEntries(), { entriesPerEvent: 1 }));
add("render entries: a fold over one day names the day once", () => re(sceneFoldDay(), { entriesPerEvent: 1 }));
add("render entries: a budget too tight for the lines folds them", () => re(sceneEntries(), { budget: 260 }));
add("render entries: gistEntries writes full entries as one sentence", () => re(sceneEntries(), { gistEntries: true }));
add("render entries: hit entries go first", () => re(sceneEntries().map((r) => ({ ...r, hits: new Set(["n00104", "n00103"]) }))));
// 碰的是本来淡到看不见的那条（n00105，500 天前）：碰过以后它又算数，折起来的从 2 条变成 3 条。碰一条本来就看得见的，输出和没碰一样，钉不出区别
add("render entries: a touched entry is clear again", () => re(sceneEntries(), { touched: (ref) => (ref === "n00105" ? ago(0.5) : null) }));
add("render entries: corrections that read the same, differ, carry their own date, are twice corrected, are orphans", () => re(sceneCorrections(), { entriesPerEvent: 20, budget: 9000 }));

add("render links: every relation, one the code does not know, and the fifth link cut", () => re(sceneLinks()));
add("render children: over the default maximum the line ends with an ellipsis (same text as render children: childrenFirst counts the line with the head: pins the path)", () => re(sceneChildren(15)));
add("render children: exactly the default maximum has no ellipsis", () => re(sceneChildren(12)));
add("render children: a smaller maxChildren", () => re(sceneChildren(5), { maxChildren: 3 }));
add("render children: childrenFirst counts the line with the head", () => re(sceneChildren(15), { childrenFirst: true }));

add("render overflow: events past maxEvents are listed by title", () => re(sceneMany(6), { maxEvents: 2 }));
add("render overflow: the list is cut when the room is small", () => re(sceneMany(6), { maxEvents: 1, budget: 120 }));
add("render overflow: overflowRoom fixes the line and cuts the titles", () => re(sceneMany(6), { maxEvents: 2, overflowRoom: 60 }));
add("render overflow: overflowRoom with nothing to overflow", () => re(sceneMany(3), { overflowRoom: 60 }));
add("render overflow: a small budget moves events out", () => re(sceneMany(6), { budget: 190 }));
add("render overflow: a small budget moves events out, overflowRoom reserved", () => re(sceneMany(6), { budget: 180, overflowRoom: 50 }));
add("render overflow: a keep event stays past maxEvents", () => re(sceneMany(6, 4), { maxEvents: 2 }));
add("render overflow: keepOrder leaves importance 5 where it is", () => re(sceneMany(4).reverse(), { keepOrder: true }));
add("render overflow: without keepOrder importance 5 goes first", () => re(sceneMany(4).reverse()));

add("render events: the final cut when many events cannot fit", () => re(sceneStatuses(), { budget: 30 }));
add("render events: the final cut when one head is longer than the budget", () => re(sceneStatuses().slice(0, 1), { budget: 12 }));
add("render events: no events", () => re([]));

// ---------- events/midterm.ts：renderMidterm ----------

/** 往新的事件库里种一个场景再渲染中期视图；now 默认 EV_NOW（09:00），时区显式，budget 不写 = 默认 */
const mt = (seed: (w: EvWorld) => void, o: { now?: number; tz?: string; budget?: number } = {}): string => {
  const now = o.now ?? EV_NOW;
  return inEvents((w) => {
    seed(w);
    return renderMidterm(w.r, { now, tz: o.tz ?? TZ, budget: o.budget });
  }, now);
};

add("midterm: an empty store", () => mt(() => {}));
add("midterm: today's entries by the half hour, a retired event and an entry before four left out", () => mt(seedToday));
add("midterm: before four in the morning her day began yesterday", () => mt(seedTodayEarly, { now: Date.UTC(2026, 10, 13, 2, 30) }));
add("midterm: dated events, a past one, a retired one and a superseded one left out", () => mt(seedDated));
add("midterm: dated events in another time zone", () => mt(seedDated, { tz: "America/Sao_Paulo" }));
add("midterm: recent events, a big one with its children folded in, links and people, stale names", () => mt(seedRecent));
add("midterm: more recent events than fit list the rest by title", () => mt((w) => seedCrowd(w, 46)));
add("midterm: a short stale line", () => mt((w) => seedStale(w, 5)));
add("midterm: a stale line over 600 characters counts the rest", () => mt((w) => seedStale(w, 26)));

add("midterm: likes that all fit as lines", () => mt((w) => { seedStale(w, 18); seedLikes(w, 2, 0); }));
add("midterm: likes overflow into names and the names are cut", () => mt((w) => { seedStale(w, 18); seedLikes(w, 7, 0); }));
add("midterm: likes overflow into names that all fit, dislikes get no room", () => mt((w) => { seedStale(w, 18); seedLikes(w, 5, 2); }));
add("midterm: likes lines, a likes names line and a dislikes line", () => mt((w) => { seedStale(w, 18); seedLikes(w, 4, 1); }));
add("midterm: dislikes only", () => mt((w) => { seedStale(w, 18); seedLikes(w, 0, 6); }));
add("midterm: dislikes only, more than fit", () => mt((w) => { seedStale(w, 18); seedLikes(w, 0, 12); }));

add("midterm: the owner's quotes, one over 300 characters, one in capitals, others' and old ones left out", () => mt(seedOwnerQuotes));
add("midterm: the owner's quotes, more than fit, with how to turn the pages", () => mt((w) => seedManyOwnerQuotes(w, 7), { budget: 1500 }));
add("midterm: everything at once", () => mt(seedFull));
add("midterm: a tight budget cuts every section", () => mt(seedFull, { budget: 1800 }));

// ---------- events/recall.ts ----------
// 事件库世界：库是 :memory:，时钟 EV_NOW（2026-11-13 09:00 UTC）、时区 UTC 都显式，编号按写入顺序从头起；每条调用各建各的。
// 这个文件里读真时钟的只有 associate 的头尾（t0 和 ms）：associate 的调用都过 withClock。人物卡的「全文」是 ledger/people/<key>.md 这样的相对路径（只是指路，不读文件），所以没有临时目录。

const inR = <T>(fn: (w: EvWorld) => T, o: EvOpts = {}): T => inEvents(fn, EV_NOW, o);
const inRA = <T>(fn: (w: EvWorld) => Promise<T>, o: EvOpts = {}): Promise<T> => inEventsAsync(fn, EV_NOW, o);
/** 开人物卡（模板、主人名单 OWNER） */
const PEOPLE: EvOpts = { people: true };
/** 文字和编号表；ms 不进（它是 Date.now 差，每次不同），其余原样 */
const jsonOf = (o: { text: string; events: string[]; entries?: string[] }): string => JSON.stringify({ text: o.text, events: o.events, ...(o.entries ? { entries: o.entries } : {}) });
/** associate 开头结尾各读一次真时钟（t0 / ms，没有注入口）：这一条调用期间把 Date.now 钉在 EV_NOW，跑完（不管成不成）还原 */
const withClock = async <T>(f: () => Promise<T>): Promise<T> => {
  const m = mock.method(Date, "now", () => EV_NOW);
  try {
    return await f();
  } finally {
    m.mock.restore();
  }
};
const assoc = (w: EvWorld, cue: string, o: Parameters<EvWorld["r"]["associate"]>[1] = {}): Promise<string> =>
  withClock(async () => jsonOf(await w.r.associate(cue, o)));

// ----- cluster -----
const CUE = "周六去海边的行程";
const QCUE = "冰箱门上贴着的便条";
const HDR = "线索对上的几件事：";

add("cluster: events and then the quote lines, with a header, as text and ids", () => inRA(async (w) => { seedCluster(w); return jsonOf(await w.r.clusterRaw(CUE, { header: HDR })); }));
add("cluster: events and quote lines without a header, the same words twice give one quote line", () => inRA(async (w) => { seedCluster(w); return w.r.cluster(CUE); }));
add("cluster: quote lines alone go under the header", () => inRA(async (w) => { seedCluster(w); return w.r.cluster(QCUE, { header: HDR }); }));
add("cluster: quote lines alone without a header", () => inRA(async (w) => { seedCluster(w); return w.r.cluster(QCUE); }));
add("cluster: nothing found", () => inRA(async (w) => { seedCluster(w); return w.r.cluster("鲸鱼与灯塔的故事"); }));
add("cluster: a small budget shrinks the event text and leaves little room for quote lines", () => inRA(async (w) => { seedCluster(w); return w.r.cluster(CUE, { budget: 200 }); }));

// ----- quoteLine -----
add("quoteLine: with and without a channel, 120 characters whole, 121 cut, an unknown ref", () => inR((w) => {
  seedQuoteLines(w);
  return ["q1", "q2", "q3", "q4", "q9"].map((ref) => `${ref} -> ${w.r.quoteLine(ref)}`).join("\n=====\n");
}));

// ----- person -----
add("person: a name the memory does not know", () => inR((w) => { seedPeople(w); return w.r.person("没这个人"); }, PEOPLE));
add("person: known, but nothing yet", () => inR((w) => { seedPeople(w); return w.r.person("小禾"); }, PEOPLE));
add("person: the recent events of someone, no card asked for", () => inR((w) => { seedPeople(w); return w.r.person("阿青"); }, PEOPLE));
add("person: only two events", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 2); }, PEOPLE));
add("person: automatic recall leaves out a retired event and the ones already given", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 5, 1500, { auto: true, exclude: new Set(["e0002"]) }); }, PEOPLE));
add("person: every event already given leaves nothing", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 5, 1500, { exclude: new Set(["e0001", "e0002", "e0004", "e0005"]) }); }, PEOPLE));
add("person: card, a guest with stored fields names the file", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 5, 1500, { card: true }); }, PEOPLE));
add("person: card, a guest with only computed parts names no file", () => inR((w) => { seedPeople(w); return w.r.person("老林", 5, 1500, { card: true }); }, PEOPLE));
add("person: card, the owner gets a pointer, not a card", () => inR((w) => { seedPeople(w); return w.r.person(OWNER, 5, 1500, { card: true }); }, PEOPLE));
add("person: card asked for, someone without a card has only the events line (same text as person: known, but nothing yet: pins the path)", () => inR((w) => { seedPeople(w); return w.r.person("小禾", 5, 1500, { card: true }); }, PEOPLE));
add("person: card cut, the sections that do not fit are skipped and the later ones that fit are kept", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 5, 300, { card: true }); }, PEOPLE));
add("person: card cut, no section fits", () => inR((w) => { seedPeople(w); return w.r.person("阿青", 5, 120, { card: true }); }, PEOPLE));

// ----- event -----
add("event: by event id, with the quotes the entries cite", () => inR((w) => { seedExpand(w); return w.r.event("e0001"); }));
add("event: a small quote budget stops each entry's quotes at the room", () => inR((w) => { seedExpand(w); return w.r.event("e0001", { quoteBudget: 150 }); }));
add("event: only the entries between from and to", () => inR((w) => { seedExpand(w); return w.r.event("e0001", { from: ago(1.1), to: ago(0.3) }); }));
add("event: by entry id the entry is located", () => inR((w) => { seedExpand(w); return w.r.event("n00003"); }));
add("event: an entry nobody has", () => inR((w) => { seedExpand(w); return w.r.event("n99999"); }));
add("event: an event id nobody has", () => inR((w) => { seedExpand(w); return w.r.event("e9999"); }));
add("event: q ref, the quote and where it was used", () => inR((w) => { seedExpand(w); return w.r.event("q1"); }));
add("event: q ref, a long quote cut at 120, used once", () => inR((w) => { seedExpand(w); return w.r.event("q2"); }));
add("event: q ref, a quote nobody cites", () => inR((w) => { seedExpand(w); return w.r.event("q3"); }));
add("event: q ref, no such quote", () => inR((w) => { seedExpand(w); return w.r.event("q99"); }));
add("event: # ref in the quote layer, used by several entries", () => inR((w) => { seedExpand(w); return w.r.event("#21"); }));
add("event: c: ref in the quote layer (same text as event: # ref in the quote layer, used by several entries: pins the path)", () => inR((w) => { seedExpand(w); return w.r.event("c:21"); }));
add("event: # ref in the quote layer, a long quote used once (same text as event: q ref, a long quote cut at 120, used once: pins the path)", () => inR((w) => { seedExpand(w); return w.r.event("#22"); }));
add("event: # ref in the quote layer, nobody cites it (same text as event: q ref, a quote nobody cites: pins the path)", () => inR((w) => { seedExpand(w); return w.r.event("#23"); }));
add("event: # ref in central memory only, cited by an entry, text cut at 160", () => inR((w) => { seedExpand(w); return w.r.event("#1"); }));
add("event: # ref in central memory only, nobody cites it", () => inR((w) => { seedExpand(w); return w.r.event("#2"); }));
add("event: # ref nobody has", () => inR((w) => { seedExpand(w); return w.r.event("#999"); }));
add("event: by a title that several events contain, the five nearest in length first", () => inR((w) => { seedTitles(w); return w.r.event("看日出"); }));
add("event: by a title that is exactly one event's", () => inR((w) => { seedTitles(w); return w.r.event("看日出的约定"); }));
add("event: by a sentence that contains one event's title (same text as event: by a title that is exactly one event's: pins the path)", () => inR((w) => { seedTitles(w); return w.r.event("我想问问看日出的约定怎么样了"); }));
add("event: by a few words that only one title contains", () => inR((w) => { seedTitles(w); return w.r.event("早班车"); }));
add("event: by words only a summary has, found by full text", () => inR((w) => { seedTitles(w); return w.r.event("糖醋排骨"); }));
add("event: by a title nobody has", () => inR((w) => { seedTitles(w); return w.r.event("根本没有的事"); }));
add("event: by nothing, every event is a candidate", () => inR((w) => { seedTitles(w); return w.r.event(""); }));
add("event: by nothing in an empty memory", () => inR((w) => w.r.event("  ")));

// ----- period -----
const SHORT = (): Range => ({ from: ago(10), to: EV_NOW });
const LONG = (): Range => ({ from: EV_NOW - 44 * 86_400_000, to: EV_NOW });
add("period: a person the memory does not know", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { who: "没这个人" }); }));
add("period: nothing in that stretch", () => inR((w) => { seedPeriod(w); return w.r.period({ from: ago(100), to: ago(90) }); }));
add("period: one line per event, statuses, people, an unknown status", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT()); }));
// 不算数了的事在这一段里照样列（period 不筛状态），带着它的状态名：别的调用里没有这种状态的事，这里把一件改成 retired（用 SQL，只动这一列）
add("period: a retired event is still listed, with its label (status set by SQL)", () => inR((w) => {
  seedPeriod(w);
  fixture("retire one", () => { w.db.prepare("UPDATE mem_event SET status = 'retired' WHERE title = ?").run("刨子的借用记录"); });
  return w.r.period(SHORT());
}));
add("period: only one person's events", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { who: "老林" }); }));
add("period: only the important events", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { minImportance: 3 }); }));
add("period: over three weeks is by week", () => inR((w) => { seedPeriod(w); return w.r.period(LONG()); }));
add("period: weekly forced off on a long stretch", () => inR((w) => { seedPeriod(w); return w.r.period(LONG(), { weekly: false }); }));
add("period: weekly forced on a short stretch", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { weekly: true }); }));
add("period: paged, the second page", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { pageChars: 300, page: 2 }); }));
add("period: paged, a page past the end is the last", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { pageChars: 300, page: 9 }); }));
add("period: a line longer than the page is cut", () => inR((w) => { seedPeriod(w); return w.r.period(SHORT(), { pageChars: 90 }); }));

// ----- reverse -----
add("reverse: an event with all four roles, one the code does not know, a person only in the entries, two links", () => inR((w) => { seedReverseFull(w); return w.r.reverse("e0001"); }));
add("reverse: an event nobody has", () => inR((w) => { seedReverseFull(w); return w.r.reverse("e9999"); }));
add("reverse: an event without entities, with a link", () => inR((w) => { seedReverseBare(w); return w.r.reverse("e0001"); }));
add("reverse: an event with entities, without links", () => inR((w) => { seedReverseBare(w); return w.r.reverse("e0003"); }));
add("reverse: an event with neither", () => inR((w) => { seedReverseBare(w); return w.r.reverse("e0004"); }));
add("reverse: a person in no event", () => inR((w) => { fixture("reverse person", () => w.s.upsertEntity({ name: "小禾", kind: "person" }, "w")); return w.r.reverse("小禾"); }));
add("reverse: a name nobody has", () => inR((w) => { seedReverseBare(w); return w.r.reverse("没这个人"); }));
add("reverse: a person in a few events, one without an end day", () => inR((w) => { seedPersonCrowd(w, "老林", 3); return w.r.reverse("老林"); }));
add("reverse: a person in exactly forty events", () => inR((w) => { seedPersonCrowd(w, "阿青", 40); return w.r.reverse("阿青"); }));
add("reverse: a person in over forty events, the rest counted", () => inR((w) => { seedPersonCrowd(w, "阿青", 45); return w.r.reverse("阿青"); }));

// ----- associate -----
const ACUE = "刨子的借用记录里写着刨子在仓库第三格对吗";
add("associate: a guest's recap, then the moments", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "阿青" }); }));
add("associate: a guest already recapped in this prefix gets only the moments", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "阿青", exclude: new Set(["recap:阿青"]) }); }));
add("associate: a guest with no events has no recap (same text as associate: a guest already recapped in this prefix gets only the moments: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "小禾" }); }));
add("associate: the owner as speaker is nobody's guest (same text as associate: a guest already recapped in this prefix gets only the moments: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: OWNER }); }));
add("associate: a speaker nobody knows is nobody's guest (same text as associate: a guest already recapped in this prefix gets only the moments: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "路过的人" }); }));
add("associate: no speaker, only the moments (same text as associate: a guest already recapped in this prefix gets only the moments: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE); }));
add("associate: a person named in the cue is recapped after the moments", () => inRA((w) => { seedAssoc(w); return assoc(w, "老林最近怎么样了"); }));
add("associate: the guest's recap and a named person's recap share the room", () => inRA((w) => { seedAssoc(w); return assoc(w, "老林最近怎么样了", { speaker: "阿青" }); }));
add("associate: a named person already in the moments is not recapped", () => inRA((w) => { seedAssoc(w); return assoc(w, "刨子的借用记录和老林", {}); }));
add("associate: an answer with no content brings nothing (same text as associate: a cue that is only the message envelope brings nothing: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, "好的好的", { speaker: "阿青" }); }));
add("associate: a cue that is only the message envelope brings nothing", () => inRA((w) => { seedAssoc(w); return assoc(w, "[WhatsApp +6155500020 Sat 2026-10-31 13:16 GMT+11] 阿青: ", { speaker: "阿青" }); }));
add("associate: a vague cue is tried again with what she last said (same text as associate: a named person already in the moments is not recapped: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, "这几个都不够好吗", { context: "刨子的借用记录你问过仓库了吗" }); }));
add("associate: a vague cue and a vague last thing bring nothing (same text as associate: a cue that is only the message envelope brings nothing: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, "这几个都不够好吗", { context: "好的" }); }));
add("associate: a moment that was corrected shows the correction", () => inRA((w) => { seedAssoc(w); return assoc(w, "社团押金的交接和押金收据抬头"); }));
add("associate: the text is cut at the budget", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "阿青", budget: 60 }); }));
add("associate: touch off still gives the same text (same text as associate: a guest's recap, then the moments: pins the path)", () => inRA((w) => { seedAssoc(w); return assoc(w, ACUE, { speaker: "阿青", touch: false }); }));
add("associate: the speaker's own earlier quote and her reply to it", () => inRA(async (w) => {
  await seedAssocQuotes(w);
  return assoc(w, "周六去海边的行程七点四十出发行吗", { speaker: "阿青", exclude: new Set(["recap:阿青"]) });
}, { embedder: fakeEmbedder() }));

// ----- parseRange 认的日期词 -----
const isoRange = (r: Range | null): string => (r ? `${new Date(r.from).toISOString()} .. ${new Date(r.to).toISOString()}` : "null");
/** 每个线索一行：线索 -> 从 .. 到（UTC 的 ISO 写法）或 null */
const ranges = (cues: readonly string[], now: number = EV_NOW, tz: string = TZ): string => cues.map((c) => `${c} -> ${isoRange(parseRange(c, now, tz))}`).join("\n");
add("parseRange: today, the day before yesterday, yesterday and last night", () => ranges(["今天", "今天又想起了老林的刨子", "前天", "昨天", "昨晚"]));
add("parseRange: last week, this week in every wording", () => ranges(["上周", "上个星期", "上星期", "这周", "本周", "这个星期"]));
add("parseRange: last month, this month in every wording", () => ranges(["上个月", "上月", "这个月", "本月"]));
add("parseRange: last month when it is January", () => ranges(["上个月", "这个月"], Date.UTC(2027, 0, 15, 9, 0)));
add("parseRange: the last N days", () => ranges(["最近3天", "近 7 天", "最近 1天"]));
add("parseRange: a single date, with and without a year, one in the future is last year's, one that is not a date", () => ranges(["10-20", "2026-10-20", "12-25", "11-13", "3-4 个小时", "13-45", "2-30 号", "做脸要 3-4 个小时"]));
add("parseRange: a date range in every separator", () => ranges(["10-20到10-25", "10-20至10-25", "10-20~10-25", "10-20～10-25", "10-20–10-25", "10-20—10-25", "10-20-10-25", "10-20--10-25", "2025-12-30到2026-01-02"]));
add("parseRange: a date range with a date that cannot be", () => ranges(["13-45到14-50", "10-20到13-45"]));
add("parseRange: nothing it knows", () => ranges(["随便说说", "", "周六去海边"]));
add("parseRange: another time zone, where it is already the next day", () => ranges(["今天", "昨天", "上周", "这周", "最近3天", "这个月"], Date.UTC(2026, 10, 13, 20, 0), "Asia/Shanghai"));

// ----- lowInfo 的应答词 -----
/** FILLER 里的每个词（代码里的原词）：词后面跟一个真字，词被去掉就只剩一个字（没内容） */
const FILLERS = ["还没好", "怎么样", "咋样", "知道了", "知道", "收到", "可以", "好的", "okay", "yeah", "yes", "ok", "在吗", "哈", "呵", "嘿", "嗯", "哦", "噢", "喔", "哎", "哟", "诶", "欸", "啊", "呀", "吧", "呢", "吗", "嘛", "了", "的", "好", "行", "对", "是", "在", "嗷", "哇"] as const;
add("lowInfo: every filler word is dropped, so a filler plus one real character has no content", () => FILLERS.map((f) => `${f} -> ${lowInfo(`${f}苹`)}`).join("\n"));
add("lowInfo: two real characters are content, punctuation and emoji are not, the envelope is dropped", () => [
  "苹果", "苹", "！！！", "😀😀", "好的好的", "[WhatsApp +6155500020 Sat 2026-10-31 13:16 GMT+11] 阿青: ", "[QQ 群] 小禾：好的", "[WhatsApp +6155500020 Sat 2026-10-31 13:16 GMT+11] 阿青: 周六去海边", "OK Yes", "知道了，周六去海边",
].map((c) => `${c} -> ${lowInfo(c)}`).join("\n"));

// ---------- situation.ts ----------
// 情境：时钟是 Situation 的 deps.now（T0 或调用给的时间），它不读真时钟；goals.py 走假的 Runner（踪迹接在文字后面）；说话的人直接给在 HumanContext.person 里。
// 主人靠登记项的 privacy === "owner" 认，不靠名字：下面主人这一项用 老林，不用 OWNER。

const SEP = "\n=====\n";
const bare = (t: string): string => `[${t}]`;
/** 没有文件的调用用：路径只是名字，不建 */
const NODIR: SitDirs = { ws: join(ROOT, "no-ws"), st: join(ROOT, "no-state") };
const DAY0 = Date.UTC(2026, 10, 13);
const atHour = (h: number, m = 0): number => DAY0 + h * 3_600_000 + m * 60_000;
/** 一条调用自己的目录 + 一个 Situation；tag 不许重名（sitDirs 会拒） */
const sit = (tag: string, o: SitOpts = {}): SitWorld & { d: SitDirs } => {
  const d = sitDirs(ROOT, tag);
  return { d, ...makeSit(d, o) };
};
/** 文字后面接假 Runner / 假笔记联想被问了什么，和 Logger 记下的（lib 的 splitRest 认 `--- trace ---`） */
const traced = (reply: string, w: SitWorld): string => `${reply}\n--- trace ---\n${[...w.trace, ...w.logs.map((l) => `log ${l}`)].join("\n")}`;

// ----- timeLine -----
const tlAt = (t: number, tz: string = TZ): string => makeSit(NODIR, { now: t, tz }).s.timeLine();
add("timeLine: 03:30 is the small hours", () => tlAt(atHour(3, 30)));
add("timeLine: 08:30 is morning", () => tlAt(atHour(8, 30)));
add("timeLine: 12:30 is noon", () => tlAt(atHour(12, 30)));
add("timeLine: 15:30 is afternoon", () => tlAt(atHour(15, 30)));
add("timeLine: 20:30 is evening", () => tlAt(atHour(20, 30)));
add("timeLine: 23:30 is late night", () => tlAt(atHour(23, 30)));
add("timeLine: the edge hours of every part of the day, midnight included", () => [0, 5, 6, 10, 11, 12, 13, 17, 18, 22, 23].map((h) => `${h}:00 -> ${tlAt(atHour(h))}`).join("\n"));
add("timeLine: the time zone decides the hour and the day", () => [atHour(2), atHour(12, 30), atHour(20)].map((t) => tlAt(t, "Australia/Melbourne")).join("\n"));

// ----- loadBrief -----
/** 状态文件写成 status（t 是 T0 往前 ageSec 秒）再读；null = 不写 */
const lb = (tag: string, status: Omit<LoadStatus, "t"> | null, ageSec = 30): string => {
  const w = sit(tag);
  if (status) putLoad(w.d, ageSec, status);
  return bare(w.s.loadBrief());
};
add("loadBrief: no status file says nothing", () => lb("lb-nofile", null));
add("loadBrief: a file that is not JSON says nothing", () => {
  const w = sit("lb-bad");
  putFile(w.d.st, "load/status.json", "not json at all {");
  return bare(w.s.loadBrief());
});
add("loadBrief: ten minutes and a second old is stale", () => lb("lb-stale", LOAD_OK, 601));
add("loadBrief: exactly ten minutes old is still read", () => lb("lb-600", LOAD_OK, 600));
add("loadBrief: ok, five top consumers cut to four, phone off", () => lb("lb-ok", { ...LOAD_OK, mine_top: [["claude", 1.8], ["ffmpeg", 0.9], ["python", 0.6], ["node", 0.4], ["chrome", 0.3]] }));
add("loadBrief: ok, no top consumers, phone on", () => lb("lb-phone", { ...LOAD_OK, phone_on: true }));
add("loadBrief: tight, with reasons and consumers, phone on", () => lb("lb-tight", { level: "tight", avail_pct: 12, comp_gb: 5.1, swap_gb: 2.3, mine_gb: 6.2, phone_on: true, mine_top: [["claude", 3.1], ["ffmpeg", 2]], why: ["压缩区太大", "交换区在涨"] }));
add("loadBrief: danger without any reason", () => lb("lb-danger", { level: "danger", avail_pct: 4, comp_gb: 7, swap_gb: 5, mine_gb: 9, phone_on: false }));
add("loadBrief: tight with a recent automatic relief action", () => lb("lb-relief", { level: "tight", avail_pct: 15, comp_gb: 4.4, swap_gb: 1.1, mine_gb: 5.5, phone_on: false, why: ["压缩区太大"], last_action: "关掉了模拟器" }, 400));
add("loadBrief: ok with a relief action", () => lb("lb-ok-relief", { ...LOAD_OK, last_action: "收掉了一个空闲的浏览器标签" }, 100));
add("loadBrief: a level the code does not know is written as it is", () => lb("lb-unknown", { level: "frozen", avail_pct: 9, comp_gb: 6, swap_gb: 4, mine_gb: 8, phone_on: true, why: ["磁盘快满了"] }));

// ----- ledgerChanges -----
/** 前缀重建时账本是 OLD_LEDGER，现在磁盘上是 live：问两次（第二次每行已经提过） */
const led = (tag: string, live: string): string => {
  const w = sit(tag);
  putFile(w.d.ws, "ledger/SOUL.md", live);
  w.s.prefixRebuilt(OLD_LEDGER);
  return [w.s.ledgerChanges(), w.s.ledgerChanges()].map(bare).join(SEP);
};
const facts = (n: number): string => Array.from({ length: n }, (_, i) => `- 第 ${i + 1} 条新账：阿青托的事记在 ${i + 1} 号格子里`).join("\n");
add("ledgerChanges: a few new fact lines (list items, a star, a number, a table row); headings, too-short lines and old lines do not count; each is said once", () =>
  led("led-few", `${OLD_LEDGER}- 帮手写的新一行：阿青的车次已经查完\n* 定时任务记的：周五对过一次账\n1. 老林说刨子周日来取\n| 周六 | 海边 | 五点半 |\n## 一个标题不算\n- a\n\n`));
add("ledgerChanges: over 15 new lines says how many more and where to look", () => led("led-17", `${OLD_LEDGER}${facts(17)}\n`));
add("ledgerChanges: exactly 15 new lines has no tail", () => led("led-15", `${OLD_LEDGER}${facts(15)}\n`));
add("ledgerChanges: a line of 200 characters is whole, one of 201 is cut with an ellipsis", () =>
  led("led-long", `${OLD_LEDGER}- ${pad("阿青托我记的一件很长很长的事", 198)}\n- ${pad("老林托我记的一件更长一点的事", 199)}\n`));
add("ledgerChanges: nothing to say without a ledger, before the first prefix, when nothing changed, or when the ledger cannot be read", () => {
  const none = sit("led-none");
  none.s.prefixRebuilt(OLD_LEDGER);
  const unfrozen = sit("led-unfrozen");
  putFile(unfrozen.d.ws, "ledger/SOUL.md", `${OLD_LEDGER}- 新的一行：老林的刨子\n`);
  const same = sit("led-same");
  putFile(same.d.ws, "ledger/SOUL.md", OLD_LEDGER);
  same.s.prefixRebuilt(OLD_LEDGER);
  const dir = sit("led-dir");
  putFile(dir.d.ws, "ledger/SOUL.md/keep.txt", "这里是个目录，不是文件");
  dir.s.prefixRebuilt(OLD_LEDGER);
  return [none, unfrozen, same, dir].map((w) => bare(w.s.ledgerChanges())).join(SEP);
});

// ----- personCard -----
const QING: Person = { key: "qing", privacy: "guest", name: "阿青" };
const askQing: HumanContext = { person: QING, text: "周六几点出发？", said: [] };
const inGroup = (h: HumanContext): HumanContext => ({ ...h, group: true });
/** 只用 personCard 的 Situation；mem 给了就开事件记忆的人物卡 */
const pcSit = (tag: string, mem?: EventMemory): SitWorld & { d: SitDirs } => sit(tag, mem ? { mem } : {});
add("personCard: a stored card in a private chat shows her own face, and only once", () => inPeopleMemory((mem) => {
  const w = pcSit("pc-private", mem);
  return [w.s.personCard(askQing), w.s.personCard(askQing)].map(bare).join(SEP);
}));
add("personCard: a stored card in a group shows only the public face, once; the private face still comes afterwards", () => inPeopleMemory((mem) => {
  const w = pcSit("pc-group", mem);
  return [w.s.personCard(inGroup(askQing)), w.s.personCard(inGroup(askQing)), w.s.personCard(askQing)].map(bare).join(SEP);
}));
add("personCard: a guest whose stored card is all private gets nothing in a group and the card in a private chat", () => inPeopleMemory((mem) => {
  const w = pcSit("pc-private-only", mem);
  const ask = { ...askQing, person: { key: "zhou", privacy: "guest", name: "老林" } };
  return [w.s.personCard(inGroup(ask)), w.s.personCard(ask)].map(bare).join(SEP);
}));
const HE: Person = { key: "he", privacy: "guest", name: "小禾", profile: "memory/people/he.md" };
const askHe: HumanContext = { ...askQing, person: HE, text: "吉他弦到了吗？" };
add("personCard: no stored card for her, so the old profile and its -us.md are read, and only once", () => inPeopleMemory((mem) => {
  const w = pcSit("pc-old", mem);
  putFile(w.d.ws, "memory/people/he.md", profileDoc("小禾"));
  putFile(w.d.ws, "memory/people/he-us.md", usDoc("小禾"));
  return [w.s.personCard(askHe), w.s.personCard(askHe)].map(bare).join(SEP);
}));
add("personCard: no event memory at all, only the -us.md exists, no name in the registry", () => {
  const w = pcSit("pc-old-us");
  putFile(w.d.ws, "memory/people/he-us.md", usDoc("小禾"));
  return bare(w.s.personCard({ ...askHe, person: { key: "he", privacy: "guest", name: "he", profile: "memory/people/he.md" } }));
});
add("personCard: an old profile with nothing to keep gives nothing", () => {
  const w = pcSit("pc-old-empty");
  putFile(w.d.ws, "memory/people/he.md", ["# 小禾", "", "## 详情（按日期）", "<!-- 类型：详情 -->", "- 11-02 托我记社团的押金", ""].join("\n"));
  return bare(w.s.personCard(askHe));
});
add("personCard: nothing for the owner, an unknown sender, or a guest with neither a card nor a profile", () => {
  const owner = pcSit("pc-owner");
  putFile(owner.d.ws, "memory/people/zhou.md", profileDoc("老林"));
  const stranger = pcSit("pc-stranger");
  const bare1 = pcSit("pc-bare");
  return [
    owner.s.personCard({ ...askQing, person: { key: "zhou", privacy: "owner", name: "老林", profile: "memory/people/zhou.md" } }),
    stranger.s.personCard({ ...askQing, person: null }),
    bare1.s.personCard({ ...askHe, person: { key: "he", privacy: "guest", name: "小禾" } }),
  ].map(bare).join(SEP);
});

// ----- saidNote -----
const sn = (list: Said[]): string => bare(makeSit(NODIR).s.saidNote(list));
const PROMISE_TEXT = "好，我去把车次表查一下，等我一下";
add("saidNote: nothing said in the last two hours", () => [sn([]), sn([said(7200, "两个小时整以前说的"), said(9000, "更早以前说的")])].join(SEP));
add("saidNote: a line still being sent is marked and explained", () => sn([said(30, "车次表在我这儿，周六早班车七点四十"), said(2, "我把集合点也发给你", { pending: true })]));
add("saidNote: a promise nothing came after is listed", () => sn([said(20, PROMISE_TEXT)]));
add("saidNote: every wording of a promise (first six)", () => sn([
  "我帮你查查看", "我给你留一罐果酱", "等我一下", "回头我再告诉你", "我去查一下", "我去看看",
].map((t, i) => said(100 - i * 10, t))));
add("saidNote: the other two wordings of a promise", () => sn([said(40, "我去找找老林的刨子"), said(30, "我去挑一个好看的")]));
add("saidNote: a real message from a later send settles the promise, so it is not listed", () => sn([said(60, PROMISE_TEXT, { batch: "b1" }), said(30, "读完了，我最喜欢写海边日出的那一段", { batch: "b2" })]));
add("saidNote: a sticker, a short line, another promise or a bubble of the same send do not settle it", () => [
  sn([said(60, PROMISE_TEXT), said(30, "[表情包：举着伞的小熊]")]),
  sn([said(60, PROMISE_TEXT), said(30, "好的呀")]),
  sn([said(60, PROMISE_TEXT), said(30, "马上就好，再等我两分钟哦")]),
  sn([said(60, PROMISE_TEXT, { batch: "b1" }), said(30, "你先忙，查到了第一时间告诉你", { batch: "b1" })]),
].join(SEP));
add("saidNote: a line over 80 characters is cut with an ellipsis, 80 is not, and a promise over 80 is cut without one", () => sn([
  said(100, pad("阿青问的那件事我想了很久", 80)), said(90, pad("老林的刨子借用记录我又核对了一遍", 81)), said(80, `等我一下，${pad("我把仓库第三格和第四格都看一遍再回你", 85)}`),
]));
add("saidNote: only the last 14 lines are quoted and only the last 6 promises listed", () => sn(Array.from({ length: 16 }, (_, i) => said(1000 - i * 10, `第${i + 1}句：等我一下，周六的事我再想想`))));
add("saidNote: blank lines are left out of the quotes", () => sn([said(20, "   "), said(10, "嗯")]));

// ----- forMain -----
add("forMain: nobody asks: time, load and goals; asking again at once gives the time alone", async () => {
  const w = sit("fm-alone");
  putLoad(w.d, 30, { ...LOAD_OK, mine_top: [["claude", 1.8], ["ffmpeg", 0.9]] });
  putFile(w.d.ws, "ledger/SOUL.md", OLD_LEDGER);
  w.s.prefixRebuilt(OLD_LEDGER);
  const first = await w.s.forMain();
  const again = await w.s.forMain();
  return traced(`${first}${SEP}${again}`, w);
});
add("forMain: a guest asks: the old profile card, a ledger change, what she said and promised", async () => {
  const guest: Person = { key: "qing", privacy: "guest", name: "阿青", profile: "memory/people/qing.md" };
  const w = sit("fm-guest");
  putLoad(w.d, 30, LOAD_OK);
  putFile(w.d.ws, "memory/people/qing.md", profileDoc("阿青"));
  putFile(w.d.ws, "memory/people/qing-us.md", usDoc("阿青"));
  putFile(w.d.ws, "ledger/SOUL.md", `${OLD_LEDGER}- 帮手写的新一行：阿青的车次已经查完\n`);
  w.s.prefixRebuilt(OLD_LEDGER);
  const out = await w.s.forMain({ ...askQing, person: guest, text: "周六早班车几点？", said: [said(120, PROMISE_TEXT), said(60, "[表情包：举着伞的小熊]"), said(5, "七点四十那一班", { pending: true })] });
  return traced(out, w);
});
add("forMain: the owner asks: no card", async () => {
  const owner: Person = { key: "zhou", privacy: "owner", name: "老林", profile: "memory/people/zhou.md" };
  const w = sit("fm-owner");
  putFile(w.d.ws, "memory/people/zhou.md", profileDoc("老林"));
  return traced(await w.s.forMain({ person: owner, text: "刨子到了吗？", said: [] }), w);
});
// 联想笔记（deps.notes）：别的调用都没接。这两条接一个假的，看带给它的东西——主人说话时多问的那道纠正题（名字和问法）、她刚说过的话当上文；
// 客人说话不带那道题，没有刚说过的话就不带上文。问法是她读不到、判断读得到的字，只有在这里的踪迹里才看得见
add("forMain: the owner speaks with the notes on: the correction question goes along, and what she just said is the context", async () => {
  const trace: string[] = [];
  const owner: Person = { key: "zhou", privacy: "owner", name: "老林" };
  const w = sit("fm-notes-owner", { trace, notes: { reply: "笔记里对得上的一条：刨子用完要擦油再收进仓库" }, correction: true });
  return traced(await w.s.forMain({ person: owner, text: "不是第三格，是第四格", said: [said(50, "刨子我放在仓库第三格了，你去拿就行")] }), w);
});
add("forMain: a guest speaks with the notes on: no correction question, and with nothing said no context", async () => {
  const trace: string[] = [];
  const w = sit("fm-notes-guest", { trace, notes: { reply: "笔记里对得上的一条：订车票先看末班车几点" }, correction: true });
  return traced(await w.s.forMain({ ...askQing, text: "周日还有票吗？", said: [] }), w);
});
add("forMain: an unknown sender gets no card, but what she said is still listed", async () => {
  const w = sit("fm-stranger");
  return traced(await w.s.forMain({ person: null, text: "请问是小禾吗？", said: [said(40, "你好呀，请问你是哪位？")] }), w);
});
add("forMain: a goals script that exits with an error adds no goals", async () => {
  const w = sit("fm-goals-exit", { goals: { code: 1, stdout: "Traceback: goals.py failed" } });
  putLoad(w.d, 30, LOAD_OK);
  return traced(await w.s.forMain(), w);
});
add("forMain: a goals script that cannot start only loses its part, and it is logged", async () => {
  const w = sit("fm-goals-throws", { goals: "throws" });
  putLoad(w.d, 30, LOAD_OK);
  return traced(await w.s.forMain(), w);
});
// ----- cardOf -----
add("cardOf: settings, summaries and quotes are kept; details and the maintenance rules are not", () => cardOf(profileDoc("阿青")));
add("cardOf: a heading without a type mark keeps the state of the one before it", () => cardOf([
  "## 她是谁", "<!-- 类型：总结 -->", "- 管器材的人", "", "### 小节没有类型行", "- 跟着上一段留下", "",
  "## 详情", "<!-- 类型：详情 -->", "- 不要", "", "### 详情下的小节", "- 也不要", "",
].join("\n")));
add("cardOf: text before the first heading is dropped, blank runs shrink, a single # is no heading, a heading on the last line is kept", () => cardOf([
  "前言：这一行在标题前面", "# 一级标题不算标题", "", "## 她是谁", "<!-- 类型：总结 -->", "- 管器材的人", "", "", "", "- 隔了三个空行", "# 又一个一级标题，当正文", "## 最后一行是标题",
].join("\n")));
add("cardOf: empty text and text without a heading give nothing", () => [cardOf(""), cardOf("没有标题的文字\n只有两行")].map(bare).join(SEP));

// ---------- events/exam.ts ----------
const QUESTION: ExamQuestion = { id: "q1", q: "周六去海边的行程，最后定的是几点的车？" };
/** parseExam：抛了记成 threw: 原因（夹具的错 caught 会原样再抛） */
const exam = (raw: unknown): string => {
  try {
    return JSON.stringify(parseExam(raw));
  } catch (e) {
    return caught(e);
  }
};
add("exam: the role text the brain gives the exam session", () => examRole());
add("exam: how a question is put", () => examQuestion(QUESTION));
add("exam: a question with extra fields is put the same way", () => examQuestion({ id: "q2", q: "老林的刨子借给了谁？", answer: "小禾", source: "n00003" }));
add("parseExam: a paper that is not an array", () => exam({ id: "q1", q: "周六去海边的行程定的是几点的车？" }));
add("parseExam: a question without an id names its place", () => exam([QUESTION, { q: "老林的刨子借给了谁？" }]));
add("parseExam: an id that is not text", () => exam([{ id: 7, q: "小禾的社团押金交给谁了？" }]));
add("parseExam: an empty id (same text as parseExam: an id that is not text: pins the path)", () => exam([{ id: "", q: "小禾的社团押金交给谁了？" }]));
add("parseExam: a question without q (same text as parseExam: a question without an id names its place: pins the path)", () => exam([QUESTION, { id: "q2" }]));
add("parseExam: a blank q (same text as parseExam: an id that is not text: pins the path)", () => exam([{ id: "q1", q: "   " }]));
add("parseExam: a repeated id", () => exam([QUESTION, { id: "q2", q: "老林的刨子借给了谁？" }, { id: "q1", q: "再问一遍周六的车" }]));
add("parseExam: a good paper keeps the extra fields", () => exam([QUESTION, { id: "q2", q: "老林的刨子借给了谁？", answer: "小禾", source: "n00003" }]));

// ---------- events/memory.ts（EventMemory）：Task 2-0 的 0e——世界的搭法、读（remember / recallEvent / recallPeriod / quotes / quotesDay）、写（write / apply） ----------
// 世界是 test/memtext/world.ts 的 inMemory：一个 EventMemory、:memory: 库、可拨的时钟（起点 EV_NOW）、时区 UTC、没有向量、没有人物卡、不导出到磁盘。
// 写要夜里那一批开着：mnight 种好底子（seedNightBase，批次 seed）再 beginNight；写成功的走 fixture（意外的拒绝大声失败），要看拒绝的走 mrefuse（记成 threw: 原因）。

/** 夜里那一批的名字，和夜里引擎起的一样的写法 */
const MNIGHT = "night:2026-11-12/today";
/** 新睡眠的一段：region 和批次 */
const MSTAGE = "sleep-2026-11-12-events-1";
const MSTAGE_BATCH = "sleep:2026-11-12/events";

/** 种好底子、开了夜里那一批的世界；fn 在里面写 */
const mnight = <T>(fn: (w: MemWorld) => T, o: MemOpts = {}): T =>
  inMemory((w) => {
    seedNightBase(w);
    fixture("begin night", () => w.mem.beginNight(MNIGHT));
    return fn(w);
  }, o);
/** 种好底子、开了新睡眠一段的世界（没开夜里那一批） */
const mstage = <T>(fn: (w: MemWorld) => T): T =>
  inMemory((w) => {
    seedNightBase(w);
    fixture("begin stage", () => w.mem.beginStage(MSTAGE, MSTAGE_BATCH));
    return fn(w);
  });
/** 写一次，应该成功：拒绝了就是夹具错（FixtureError），不钉 */
const mput = (w: MemWorld, op: WriteOp, a: Record<string, unknown>, region = "hippocampus"): string => fixture(op, () => w.mem.write(op, a, region));
/** 写一次，应该被拒：记成 threw: 原因（caught）；没被拒就是夹具错 */
const mrefuse = (w: MemWorld, op: WriteOp, a: Record<string, unknown>, region = "hippocampus"): string => {
  let out = "";
  try {
    out = w.mem.write(op, a, region);
  } catch (e) {
    return caught(e);
  }
  throw new FixtureError(`${op}: expected a refusal, got: ${out}`);
};
/** 回复，和这一条调用写进库里的东西（lib 的 splitRest 认 `--- trace ---`） */
const mshown = (w: MemWorld, reply: string): string => `${reply}\n--- trace ---\n${w.stored()}`;
/** 一条新经过的参数（event 不写 = 交给 mem_entries_add 顶层的 event）：原文 80 字、一句话 20 字、各条时间不同 */
const mnew = (days: number, title: string, event?: string): Record<string, unknown> => ({
  ...(event ? { event } : {}), at: ago(days), full: pad(`${title}：这是夜里补进时间线的一条，阿青说周六要早起去海边`, 80), gist: pad(`${title}的大意`, 20), title, source: [],
});
/** 登记 n 个还没打重要度的东西（名字各不相同），写进 region 那一批 */
const mthings = (w: MemWorld, n: number, region = "hippocampus"): void => {
  for (let i = 1; i <= n; i++) mput(w, "mem_entity_upsert", { name: `社团杂物${String(i).padStart(2, "0")}号箱子` }, region);
};

// ----- remember -----
// seedCluster：线索「周六去海边的行程」直接对上 e0001（挂阿青，11-12 09:00 有进展）；顺关联带出 e0002，同一个人的 e0003（重要度 3）跟着来；原话层四句。
// 事件只有 e0001 是直接搜到的，所以日期范围只有两种结果：e0001 在范围里（A：三件事 + 原话行）、不在（B：只剩标题行 + 原话行，范围不筛原话）。
const mrem = (cue: string, o: Parameters<EventMemory["remember"]>[1] = {}): Promise<string> =>
  inMemoryAsync(async (w) => {
    seedCluster(evOf(w));
    return w.mem.remember(cue, o);
  });
const NOTHING_CUE = "鲸鱼与灯塔的故事";
add("memory remember: neither from nor to (the range is not read)", () => mrem(CUE));
add("memory remember: from only, a day after e0001's last news, so only the quote lines come back", () => mrem(CUE, { from: "2026-11-13" }));
add("memory remember: to only, a range that holds e0001 (same text as memory remember: neither from nor to (the range is not read): pins the path)", () => mrem(CUE, { to: "2026-11-12" }));
add("memory remember: from and to, a range that holds e0001 (same text as memory remember: neither from nor to (the range is not read): pins the path)", () => mrem(CUE, { from: "2026-11-10", to: "2026-11-12" }));
add("memory remember: a person the memory does not know is said so, then the events", () => mrem(CUE, { who: "鲸鱼" }));
add("memory remember: a known person (阿青) is no note (same text as memory remember: neither from nor to (the range is not read): pins the path)", () => mrem(CUE, { who: "阿青" }));
add("memory remember: a cue nothing matches", () => mrem(NOTHING_CUE));
add("memory remember: an unknown person and nothing found: the note, then nothing", () => mrem(NOTHING_CUE, { who: "鲸鱼" }));

// ----- recallEvent -----
// e0001 再加一条 20 天前的经过：{} 两条都在，from 只剩新的，to 只剩旧的
const mev = (o: Parameters<EventMemory["recallEvent"]>[1] = {}): string =>
  inMemory((w) => {
    const ev = evOf(w);
    seedCluster(ev);
    fixture("old entry", () => ev.entry("e0001", ago(20), { source: [] }));
    return w.mem.recallEvent("e0001", o);
  });
add("memory recallEvent: no range, the whole timeline of e0001", () => mev());
add("memory recallEvent: from only, the newer entry", () => mev({ from: "2026-11-01" }));
add("memory recallEvent: to only, the older entry", () => mev({ to: "2026-11-01" }));

// ----- recallPeriod -----
const mper = (when: string, o: Parameters<EventMemory["recallPeriod"]>[1] = {}): string =>
  inMemory((w) => {
    seedPeriod(evOf(w));
    return w.mem.recallPeriod(when, o);
  });
add("memory recallPeriod: a day and an end day", () => mper("11-03", { to: "11-12" }));
add("memory recallPeriod: the last ten days, no end day", () => mper("最近10天"));
add("memory recallPeriod: a time it cannot read says what it reads", () => mper("某个说不清的时候"));

// ----- quotes -----
// seedQuoteLayer 的十句（见 world.ts）。q4 正好 500 字（500 不截）、q5 501 字（截成 500 字加「…」）；q6 是中央记忆来的。
const mq = (q: string, o: Parameters<EventMemory["quotes"]>[1] = {}): Promise<string> =>
  inMemoryAsync(async (w) => {
    seedQuoteLayer(w);
    return w.mem.quotes(q, o);
  });
add("memory quotes: every line that holds the cue, with and without a channel, 500 characters whole and 501 cut, the central line among them", () => mq("早班车"));
add("memory quotes: who 阿青 keeps 阿青's lines, not 我→阿青 or 我（笔记）", () => mq("早班车", { who: "阿青" }));
add("memory quotes: who 我 keeps 我→阿青, 我→老林 and 我（笔记）", () => mq("早班车", { who: "我" }));
add("memory quotes: a limit of three keeps the first three", () => mq("早班车", { limit: 3 }));
add("memory quotes: olderOnly with two words keeps the lines with both, newest first, and leaves the central line out", () => mq("早班车 七点四十", { olderOnly: true }));
add("memory quotes: olderOnly without words (empty, then only spaces) gives nothing", () => inMemoryAsync(async (w) => {
  seedQuoteLayer(w);
  return [await w.mem.quotes("", { olderOnly: true }), await w.mem.quotes("   ", { olderOnly: true })].map(bare).join(SEP);
}));
add("memory quotes: a cue nothing holds gives nothing", () => mq(NOTHING_CUE).then(bare));

// ----- quotesDay -----
// 她的一天从 04:00 起：11-12 是 11-12 04:00 到 11-13 03:59，所以 q8（11-13 03:30）算 11-12，q9（11-12 03:30）算 11-11；中央记忆那句（q6）不要
const mqd = (day: string, o: Parameters<EventMemory["quotesDay"]>[1] = {}): string =>
  inMemory((w) => {
    seedQuoteLayer(w);
    return w.mem.quotesDay(day, o);
  });
add("memory quotesDay: a day's lines by time, 500 whole and 501 cut, the early morning line of the next date in, the central line out", () => mqd("2026-11-12"));
add("memory quotesDay: the day before holds the line from 03:30 and the one from 9 in the morning", () => mqd("2026-11-11"));
add("memory quotesDay: who 阿青 keeps only 阿青's", () => mqd("2026-11-12", { who: "阿青" }));
add("memory quotesDay: who 我 keeps 我→阿青, 我（笔记）and 我→老林", () => mqd("2026-11-12", { who: "我" }));
add("memory quotesDay: a limit of two keeps the last two", () => mqd("2026-11-12", { limit: 2 }));
add("memory quotesDay: a day that is not YYYY-MM-DD gives nothing", () => inMemory((w) => {
  seedQuoteLayer(w);
  return ["11-12", "昨天", ""].map((d) => bare(w.mem.quotesDay(d))).join(SEP);
}));
add("memory quotesDay: a day without lines gives nothing (same text as memory quotes: a cue nothing holds gives nothing: pins the path)", () => bare(mqd("2026-11-09")));

// ----- write：夜里没开 -----
add("memory write: no batch open in the day refuses and points to jot_down and like", () =>
  inMemory((w) => {
    seedNightBase(w);
    return mrefuse(w, "mem_retire", { id: "e0001", reason: "白天想撤掉这件事" });
  }));

// ----- write：事件、经过 -----
add("memory write: mem_event_create says the new id and title", () => mnight((w) => mshown(w, mput(w, "mem_event_create", {
  title: "周日去仓库的行程", summary: pad("周日去仓库拿刨子的行程：老林说上午十点以后仓库才开门", 60), gist: pad("周日去仓库拿刨子", 30), importance: 2, entities: [{ name: "老林", kind: "person", role: "with" }],
}))));
add("memory write: mem_event_update says it is done", () => mnight((w) => mshown(w, mput(w, "mem_event_update", { id: "e0001", gist: pad("改过的一句话：周六早班车改到七点四十", 30), importance: 3 }))));
add("memory write: mem_entry_add says the new id and event, and the same again says it was already there", () => mnight((w) => {
  const a = mnew(0.5, "仓库开门的时间", "e0002");
  const first = mput(w, "mem_entry_add", a);
  const again = mput(w, "mem_entry_add", a);
  return mshown(w, [first, again].join(SEP));
}));
add("memory write: mem_entry_correct says the correction and what it corrects", () => mnight((w) => mshown(w, mput(w, "mem_entry_correct", {
  id: "n00001", full: pad("改正后的原文：阿青在群里说早班车其实是七点五十的那一班", 60), gist: pad("早班车是七点五十", 20), title: "早班车的时间改了", why: "阿青后来在群里改了口",
}))));
add("memory write: mem_link says what is linked to what (no note needed for followup)", () => mnight((w) => mput(w, "mem_link", { a: "e0002", b: "e0003", rel: "followup" })));
add("memory write: mem_unlink of a link that is there", () => mnight((w) => mput(w, "mem_unlink", { a: "e0005", b: "e0006", rel: "related" })));
add("memory write: mem_unlink of a link that is not there", () => mnight((w) => mput(w, "mem_unlink", { a: "e0001", b: "e0002", rel: "cause" })));
add("memory write: mem_merge says the timelines went to the kept event", () => mnight((w) => mshown(w, mput(w, "mem_merge", { keep: "e0002", others: ["e0003"], reason: "其实是同一件事的两种说法" }))));
add("memory write: mem_merge with no others and no reason (the lists default to empty, nothing moves)", () => mnight((w) => mshown(w, mput(w, "mem_merge", { keep: "e0002" }))));
add("memory write: mem_split under the event makes a child", () => mnight((w) => mshown(w, mput(w, "mem_split", {
  id: "e0001", entries: ["n00002", "n00003"], event: { title: "海边集合点的安排", summary: pad("海边集合点的安排：阿青说在北门等", 50), gist: pad("集合点在北门", 20), importance: 2 }, reason: "大事拆成小事", under: true,
}))));
add("memory write: mem_split not under makes a sibling of the same thread", () => mnight((w) => mshown(w, mput(w, "mem_split", {
  id: "e0001", entries: ["n00002", "n00003"], event: { title: "海边集合点的安排", summary: pad("海边集合点的安排：阿青说在北门等", 50), gist: pad("集合点在北门", 20), importance: 2 }, reason: "同一件事的另一段",
}))));
add("memory write: mem_supersede says the old one is replaced", () => mnight((w) => mshown(w, mput(w, "mem_supersede", { old: "e0004", by: "e0006" }))));
add("memory write: mem_retire says it no longer counts", () => mnight((w) => mshown(w, mput(w, "mem_retire", { id: "e0004" }))));

// ----- write：mem_entries_add（一次记几条） -----
add("memory write: mem_entries_add of three new entries gives the range of ids", () => mnight((w) => mshown(w, mput(w, "mem_entries_add", {
  event: "e0002", entries: [mnew(0.7, "补进来的第一条"), mnew(0.6, "补进来的第二条"), mnew(0.5, "补进来的第三条")],
}))));
add("memory write: mem_entries_add of two new and one that was already there", () => mnight((w) => mshown(w, mput(w, "mem_entries_add", {
  event: "e0002", entries: [mnew(0.7, "补进来的第一条"), nightEntry(1), mnew(0.6, "补进来的第二条")],
}))));
add("memory write: mem_entries_add of one new and one the store refuses (an event nobody has)", () => mnight((w) => mshown(w, mput(w, "mem_entries_add", {
  event: "e0002", entries: [mnew(0.7, "补进来的第一条"), mnew(0.6, "记到没有的事件上", "e9999")],
}))));
add("memory write: mem_entries_add of entries the store all refuses says it recorded none", () => mnight((w) => mshown(w, mput(w, "mem_entries_add", {
  event: "e0002", entries: [mnew(0.7, "记到没有的事件上", "e9999"), { ...mnew(0.6, "一句话比原文还长"), full: "短短的原文", gist: "这一句话比原文还要长得多" }],
}))));
add("memory write: mem_entries_add where the store refuses with something that is not an Error (addEntry replaced on the instance by one that throws a string)", () => mnight((w) => {
  (w.s as unknown as { addEntry: unknown }).addEntry = () => { throw "仓库的登记簿暂时打不开"; };
  return mshown(w, mput(w, "mem_entries_add", { event: "e0002", entries: [mnew(0.7, "补进来的第一条")] }));
}));

// ----- write：登记（人和东西） -----
add("memory write: mem_entity_upsert of a new thing with no importance and no alias", () => mnight((w) => mput(w, "mem_entity_upsert", { name: "社团的旧吉他" })));
add("memory write: mem_entity_upsert with an importance and two aliases", () => mnight((w) => mput(w, "mem_entity_upsert", { name: "仓库的大木箱", kind: "thing", importance: 3, aliases: ["木头箱子", "老木箱"] })));
add("memory write: mem_entity_merge says the merged name and what it is also called", () => mnight((w) => mput(w, "mem_entity_merge", { keep: "旧相机", others: ["老相机"], reason: "同一台相机的两种叫法" })));
add("memory write: mem_entity_merge when the merged row has no aliases (mergeEntities replaced on the instance by one that returns the row without them)", () => mnight((w) => {
  (w.s as unknown as { mergeEntities: unknown }).mergeEntities = () => ({ id: "t0004", name: "旧相机", aliases: [] });
  return mput(w, "mem_entity_merge", { keep: "旧相机", others: ["老相机"], reason: "同一台相机的两种叫法" });
}));
add("memory write: mem_entity_tag says what was hung on which event", () => mnight((w) => mput(w, "mem_entity_tag", { name: "小禾", to: "e0002" })));
add("memory write: mem_entity_drop says the registration went and the events stayed", () => mnight((w) => mput(w, "mem_entity_drop", { name: "记错的登记", reason: "登记错了，不是一个真的东西" })));
add("memory write: mem_entity_drop without a reason is refused by the store", () => mnight((w) => mrefuse(w, "mem_entity_drop", { name: "记错的登记" })));

// ----- write：mem_day_done -----
// 没打重要度的登记按这一批算（unrated）：名字最多列 30 个，31 个以上写「 等 N 个」。下面 2、30、31 个：2 与 30 不写「等」，31 写「 等 31 个」
add("memory write: mem_day_done with a day that is not a real day (2026-02-30, then empty)", () => mnight((w) => ["2026-02-30", ""].map((d) => mrefuse(w, "mem_day_done", { day: d })).join(SEP)));
add("memory write: mem_day_done refuses while two things of this night are unrated", () => mnight((w) => {
  mthings(w, 2);
  return mrefuse(w, "mem_day_done", { day: "2026-11-12" });
}));
add("memory write: mem_day_done with exactly thirty unrated lists them all", () => mnight((w) => {
  mthings(w, 30);
  return mrefuse(w, "mem_day_done", { day: "2026-11-12" });
}));
add("memory write: mem_day_done with thirty-one unrated lists thirty and counts the rest", () => mnight((w) => {
  mthings(w, 31);
  return mrefuse(w, "mem_day_done", { day: "2026-11-12" });
}));
add("memory write: mem_day_done in a clean night is noted until the night ends", () => mnight((w) => {
  mput(w, "mem_entity_upsert", { name: "社团的旧吉他", importance: 2 });
  return mput(w, "mem_day_done", { day: "2026-11-12" });
}));
add("memory write: mem_day_done in a stage that is clean takes effect when the stage lands", () => mstage((w) => mput(w, "mem_day_done", { day: "2026-11-12" }, MSTAGE)));
add("memory write: mem_day_done in a stage with an unrated thing is refused", () => mstage((w) => {
  mthings(w, 1, MSTAGE);
  return mrefuse(w, "mem_day_done", { day: "2026-11-12" }, MSTAGE);
}));
add("memory write: mem_day_done in an import batch (same text as memory write: mem_day_done in a clean night is noted until the night ends: pins the path)", () => inMemory((w) => {
  seedNightBase(w);
  fixture("begin import", () => w.mem.beginImport("people:qing", new Map()));
  return mput(w, "mem_day_done", { day: "2026-11-12" }, "importer");
}));

// ----- write：withFull（经过没写原文） -----
const noFull = (): Record<string, unknown> => ({ event: "e0001", at: ago(0.5), gist: "没写原文的一句话", title: "没写原文的一条" });
add("memory write: mem_entry_add with no full and no source says the source is empty", () => mnight((w) => mrefuse(w, "mem_entry_add", noFull())));
add("memory write: mem_entry_add with no full and two sources nobody knows lists both", () => mnight((w) => mrefuse(w, "mem_entry_add", { ...noFull(), source: ["thread:x#7", "thread:x#8"] })));
add("memory write: mem_entry_add with no full and a source the import knows takes the line for its full", () => inMemory((w) => {
  seedNightBase(w);
  fixture("begin import", () => w.mem.beginImport("thread:x", new Map([["thread:x#1", pad("导入进来的原文：阿青说周六去海边，老林说周日去仓库拿刨子", 60)]])));
  const reply = mput(w, "mem_entry_add", { ...noFull(), source: ["thread:x#1"] }, "importer");
  return `${mshown(w, reply)}\nfull of n00009: ${w.s.entry("n00009")?.full}`;
}));

// ---------- events/memory.ts：Task 2-0 的 0f ——人物卡（mem_person_set / mem_quote_pin 的回话和七种待批的理由）和命令行的四条（approve / reject / approveWho / pendingList） ----------
// 世界是 cnight：mnight（seedNightBase 的底子、夜里那一批开着）加上人物卡开着、名单上的主人默认只有小禾（key he）、seedCards 的原话六句；o 盖得过这几样。
// 写成功的走 cok / cpend（回话去掉标记以后不是「改好了」/「存成待批」开头就是夹具错，大声失败）；只有被测的那一步可以记成 threw: 原因。
// 印象表 stored() 不显示：cshown 把回话、stored() 和印象表（现行的、待批的、驳回的、被换下的、钉的原话）一起给出，回话在前，其余接在 `--- trace ---` 后面。
// 要人批的话里的「he」是名单 key（approver 打的是 key，不是名字）；没有主人就是「人」。

/** 人物卡的世界：人物卡开着、主人只有 he、夜里那一批开着、底子是 seedNightBase 加 seedCards */
const cnight = <T>(fn: (w: MemWorld) => T, o: MemOpts = {}): T =>
  mnight((w) => {
    seedCards(w);
    return fn(w);
  }, { people: true, owners: ["he"], ...o });
/** 写一个字段（region 不写 = 夜里那一批；"importer" = 导入那一批） */
const cset = (w: MemWorld, who: string, section: string, text: string, more: Record<string, unknown> = {}, region = "hippocampus"): string =>
  mput(w, "mem_person_set", { who, section, text, sources: ["e0001"], ...more }, region);
/** 写一个字段，应该直接成了：回话不是「改好了」就是夹具错 */
const cok = (w: MemWorld, who: string, section: string, text: string, more: Record<string, unknown> = {}, region = "hippocampus"): string => {
  const r = cset(w, who, section, text, more, region);
  if (!plain(r).startsWith("改好了")) throw new FixtureError(`${who}·${section}: expected a direct write, got: ${r}`);
  return r;
};
/** 写一个字段，应该存成待批：回话不是「存成待批」就是夹具错 */
const cpend = (w: MemWorld, who: string, section: string, text: string, more: Record<string, unknown> = {}, region = "hippocampus"): string => {
  const r = cset(w, who, section, text, more, region);
  if (!plain(r).startsWith("存成待批")) throw new FixtureError(`${who}·${section}: expected a pending write, got: ${r}`);
  return r;
};
/** 给阿青钉一句原话（quote 是 q1 … q6） */
const cpin = (w: MemWorld, quote: string, more: Record<string, unknown> = {}, section = "对我的感情和期待", region = "hippocampus"): string =>
  mput(w, "mem_quote_pin", { who: "阿青", section, quote, ...more }, region);
/** 开一个导入批（forcePending：这一份里 mem_person_set 写的字段一律存成待批） */
const cimport = (w: MemWorld, forcePending = false): void =>
  fixture("begin import", () => w.mem.beginImport("people:qing", new Map(), forcePending ? { forcePending: true } : {}));
/** 印象表，按编号 */
const crows = (w: MemWorld): string =>
  `mem_impression\n${(w.db.prepare("SELECT id, about, kind, section, text, quote_id, visibility, status, supersedes, why FROM mem_impression ORDER BY id").all() as unknown as Array<Record<string, unknown>>).map((r) => JSON.stringify(r)).join("\n")}`;
/** 回话，和这一条调用写进库里的东西 */
const cshown = (w: MemWorld, reply: string): string => `${reply}\n--- trace ---\n${w.stored()}\n${crows(w)}`;
/** 编号最大的一行印象 */
const clast = (w: MemWorld): string =>
  fixture("last impression", () => {
    const r = w.db.prepare("SELECT id FROM mem_impression ORDER BY id DESC LIMIT 1").get() as unknown as { id: string } | undefined;
    if (!r) throw new Error("no impression rows");
    return r.id;
  });
/** 这个字段现行的那一行的编号（库里只有一个人有这个字段的时候用） */
const ccur = (w: MemWorld, section: string): string =>
  fixture("current impression", () => {
    const r = w.db.prepare("SELECT id FROM mem_impression WHERE kind = 'section' AND section = ? AND status = 'current' ORDER BY id LIMIT 1").get(section) as unknown as { id: string } | undefined;
    if (!r) throw new Error(`no current row for ${section}`);
    return r.id;
  });
/** 一定要抛：记成 threw: 原因（caught）；没抛就是夹具错 */
const cthrows = (what: string, fn: () => string): string => {
  let out = "";
  try {
    out = fn();
  } catch (e) {
    return caught(e);
  }
  throw new FixtureError(`${what}: expected a throw, got: ${out}`);
};
/** n 条、每条正好 each 字的列表（各条互不包含）；tag 区分是哪个字段 */
const clist = (n: number, each: number, tag: string): string[] =>
  Array.from({ length: n }, (_, i) => `- ${pad(`${tag}${i + 1}号：阿青说起的一件小事`, each)}`);
const citems = (n: number, each: number, tag: string): string => clist(n, each, tag).join("\n");
/** 同 citems，只把第 idx 条（从 0 数）换成另一条，其余原样（丢一行） */
const cswap = (n: number, each: number, tag: string, idx: number, seed: string): string =>
  clist(n, each, tag).map((l, i) => (i === idx ? `- ${pad(seed, each)}` : l)).join("\n");
/** 「我的理解」的列表：每条带〔推断〕 */
const cguess = (n: number, each: number): string =>
  Array.from({ length: n }, (_, i) => `- ${pad(`〔推断〕阿青大概是这样想的${i + 1}`, each)}`).join("\n");
/** 主人「我们的大事」的一条：30 字加「（e0001）」7 字 = 37 字 */
const cbigItem = (i: number, tag: string): string => `- ${pad(`${tag}${i}号：小禾和我定下的一件大事`, 30)}（e0001）`;
/** 一个字段已经有现行的，再存一个改了第三条的待批（设定字段「约定和边界」，要谁批）；返回待批的编号 */
const cwait = (w: MemWorld): string => {
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  cpend(w, "阿青", "约定和边界", cswap(3, 30, "约定", 2, "约定改过的第三条"));
  return clast(w);
};
/**
 * 一个过时的待批（mergeEntities 做出来的）：阿青有现行的梗；阿青的旧登记（另一个登记）在导入里存成第一版待批（要替换的是「空的」），再并进阿青——
 * 并过来以后这个待批还是要替换「空的」，可阿青的梗已经有现行的了。返回那个待批的编号
 */
const cstale = (w: MemWorld): string => {
  cok(w, "阿青", "梗", citems(3, 30, "梗"));
  mput(w, "mem_entity_upsert", { name: "阿青的旧登记", kind: "person" });
  cimport(w, true);
  cpend(w, "阿青的旧登记", "梗", citems(2, 30, "旧梗"), {}, "importer");
  mput(w, "mem_entity_merge", { keep: "阿青", others: ["阿青的旧登记"], reason: "登记了两次的同一个人" });
  return clast(w);
};

// ----- 人物卡还没切过去（:474）-----
const CARD_WHO = pad("阿青是常和我一起出门的朋友", 60);
add("memory card: people not switched over, a night mem_person_set throws peopleOff", () => cnight((w) => {
  w.flags.active = false;
  return mrefuse(w, "mem_person_set", { who: "阿青", section: "是谁", text: CARD_WHO, sources: ["e0001"] });
}));
add("memory pin: people not switched over, a night mem_quote_pin throws peopleOff (same text as memory card: people not switched over, a night mem_person_set throws peopleOff: pins the path)", () => cnight((w) => {
  w.flags.active = false;
  return mrefuse(w, "mem_quote_pin", { who: "阿青", section: "对我的感情和期待", quote: "q1" });
}));
add("memory card: people not switched over, the same mem_person_set in an import batch is written", () => cnight((w) => {
  w.flags.active = false;
  cimport(w);
  return cshown(w, cset(w, "阿青", "是谁", CARD_WHO, {}, "importer"));
}));
add("memory pin: people not switched over, the same mem_quote_pin in an import batch is written", () => cnight((w) => {
  w.flags.active = false;
  cimport(w);
  return cshown(w, cpin(w, "q1", {}, "对我的感情和期待", "importer"));
}));

// ----- 改好了（:559、:575）-----
// 访客的合计上限 1500，主人的 4500。下面各条的字数都是 pad / citems 定的整数：4 条 × 28 字 = 112；60 字；主人 180 + 8 × 50 = 580
add("memory card: people switched over, a night list field is saved (4/5 条, the card total 112/1500)", () => cnight((w) => cshown(w, cset(w, "阿青", "喜好", citems(4, 28, "喜好")))));
add("memory card: a night text field is saved (60/150 字)", () => cnight((w) => cshown(w, cset(w, "阿青", "是谁", CARD_WHO))));
add("memory card: the owner's text and list fields use the owner's caps (300 字, 8 条, 4500 total)", () => cnight((w) => {
  const text = cok(w, "小禾", "是谁", pad("小禾是我最常聊天的人，他说话直来直去", 180));
  const list = cok(w, "小禾", "喜好", citems(8, 50, "主人的喜好"));
  return cshown(w, [text, list].join(SEP));
}));
add("memory card: the private detail field is cleared with a why", () => cnight((w) => {
  cok(w, "阿青", "她私下说的", citems(3, 30, "私下"));
  return cshown(w, cset(w, "阿青", "她私下说的", "", { why: "她说这几条不用再留着了" }));
}));
add("memory card: the private detail field is cleared, asked by the entity id (t0001) instead of the name (same text as memory card: the private detail field is cleared with a why: pins the path)", () => cnight((w) => {
  cok(w, "阿青", "她私下说的", citems(3, 30, "私下"));
  return cshown(w, cset(w, "t0001", "她私下说的", "", { why: "她说这几条不用再留着了" }));
}));
add("memory card: the same text again on a current field says nothing changed", () => cnight((w) => {
  cok(w, "阿青", "是谁", CARD_WHO);
  return cshown(w, cset(w, "阿青", "是谁", CARD_WHO));
}));
add("memory card: the same text again on a pending field says it is still waiting for he", () => cnight((w) => {
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  const changed = cswap(3, 30, "约定", 2, "约定改过的第三条");
  cpend(w, "阿青", "约定和边界", changed);
  return cshown(w, cset(w, "阿青", "约定和边界", changed));
}));
add("memory card: the same text again on a pending field, no owner on the list, says it waits for 人", () => cnight((w) => {
  w.owners([]);
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  const changed = cswap(3, 30, "约定", 2, "约定改过的第三条");
  cpend(w, "阿青", "约定和边界", changed);
  return cshown(w, cset(w, "阿青", "约定和边界", changed));
}));

// ----- 超了合计（:574，?? 的两边）-----
// 访客：阿青 梗 5×40=200、约定和边界 5×40=200、是谁 150、感觉 120、我的理解 3×40=120 → 790；阿青的旧登记 在乎什么 / 喜好 / 雷点 / 相处 各 5×40=200 → 800；并起来 1590，上限 1500。
// 再把「是谁」改成 100 字：1590 − 50 = 1540，超了 40 字（overCap 只拒变大的，变小的能写），keepHint 对访客是 undefined → 「先把别的字段收一收」
add("memory card: a guest's card made too large by a merge can be written smaller: 1540/1500, 先把别的字段收一收", () => cnight((w) => {
  cok(w, "阿青", "梗", citems(5, 40, "梗"));
  cok(w, "阿青", "约定和边界", citems(5, 40, "约定"));
  cok(w, "阿青", "是谁", pad("阿青是常和我一起出门的朋友，最近常提起周六去海边的事", 150));
  cok(w, "阿青", "感觉", pad("阿青对我很放心，有什么都会先说", 120));
  cok(w, "阿青", "我的理解", cguess(3, 40));
  mput(w, "mem_entity_upsert", { name: "阿青的旧登记", kind: "person" });
  for (const sec of ["在乎什么", "喜好", "雷点", "相处"]) cok(w, "阿青的旧登记", sec, citems(5, 40, `旧登记的${sec}`));
  mput(w, "mem_entity_merge", { keep: "阿青", others: ["阿青的旧登记"], reason: "登记了两次的同一个人" });
  return cshown(w, cset(w, "阿青", "是谁", pad("阿青是常和我一起出门的朋友，近来话多了些", 100)));
}));
// 主人：是谁 被 SQL 改成 4600 字（接口写不出主人超过 4500 的卡：并人最多并出 3523），我们的大事 2 条 × 37 = 74 → 4674，上限 4500，超了 174 字；
// 把我们的大事两条换个顺序（一行不丢、字数不变，直接生效）：protect 字段 → keepHint 是「满了：写进给 小禾 的提案，不要收短」
add("memory card: the owner's protect field over the card's cap says to write a proposal (SQL: one row's text made longer, the API cannot overfill an owner's card)", () => cnight((w) => {
  cok(w, "小禾", "是谁", pad("小禾是我最常聊天的人，他说话直来直去", 100));
  cok(w, "小禾", "我们的大事", `${cbigItem(1, "大事")}\n${cbigItem(2, "大事")}`);
  fixture("overfill", () => w.db.prepare("UPDATE mem_impression SET text = ? WHERE kind = 'section' AND section = '是谁' AND status = 'current'").run(pad("小禾的是谁被撑大了", 4600)));
  return cshown(w, cset(w, "小禾", "我们的大事", `${cbigItem(2, "大事")}\n${cbigItem(1, "大事")}`));
}));

// ----- 顺带作废的待批（:560）-----
add("memory card: a direct write (import batch) while a pending is open drops the pending (被直接改过了)", () => cnight((w) => {
  cwait(w);
  cimport(w);
  return cshown(w, cset(w, "阿青", "约定和边界", citems(3, 30, "导入的约定"), {}, "importer"));
}));
add("memory card: a new pending replaces an older one (被新的待批取代)", () => cnight((w) => {
  cwait(w);
  return cshown(w, cset(w, "阿青", "约定和边界", cswap(3, 30, "约定", 1, "约定又改过的第二条")));
}));

// ----- 七种待批的理由（:138–144、:564–567）-----
// forced：o.forcePending === true（beginImport 带 forcePending 的那一批）、字段不私密。
add("memory card: waiting because forced: an import with forcePending writes a guest's 是谁 (第一版卡)", () => cnight((w) => {
  cimport(w, true);
  return cshown(w, cpend(w, "阿青", "是谁", CARD_WHO, { why: "迁移时的第一版卡" }, "importer"));
}));
// first：没有现行的，又有一个 supersedes 为空的待批（上面 forced 留下的）、不是 forcePending、字段不私密；顺带 dropped（被新的待批取代）。
add("memory card: waiting because first: a night write on the field whose first version is still waiting (also drops it)", () => cnight((w) => {
  cimport(w, true);
  cpend(w, "阿青", "是谁", CARD_WHO, { why: "迁移时的第一版卡" }, "importer");
  return cshown(w, cpend(w, "阿青", "是谁", pad("阿青说周六想去海边看日出，希望我陪她", 70)));
}));
// setting：字段类型是设定（约定和边界）、有现行的（judged）、不是导入、不是 forced / first。
add("memory card: waiting because setting: 约定和边界 changed (and 'one owner' he in the approver)", () => cnight((w) => {
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  return cshown(w, cpend(w, "阿青", "约定和边界", cswap(3, 30, "约定", 2, "约定改过的第三条")));
}));
add("memory card: waiting because setting, cleared: 约定和边界 cleared with a why", () => cnight((w) => {
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  return cshown(w, cpend(w, "阿青", "约定和边界", "", { why: "她说这几条规矩不用再守了" }));
}));
// protect：主人（小禾，he 在名单上）的 protect 总结字段（感觉）、有现行的、新文里找不到旧文的那一行（lost 1 > 0）。
add("memory card: waiting because protect: the owner's 感觉 rewritten without the old line (with the tail about adding only)", () => cnight((w) => {
  cok(w, "小禾", "感觉", pad("小禾对我很直接，从不绕弯子", 90));
  return cshown(w, cpend(w, "小禾", "感觉", pad("小禾最近话少了，常常只回一个字", 80)));
}));
// cleared：总结字段（梗，不 protect）、有现行的、新文是空的。
add("memory card: waiting because cleared: 梗 cleared with a why", () => cnight((w) => {
  cok(w, "阿青", "梗", citems(5, 30, "梗"));
  return cshown(w, cpend(w, "阿青", "梗", "", { why: "这个梗她说不好笑了" }));
}));
// lost：总结字段（在乎什么，不 protect）、有现行的、新文非空、旧文 5 行一行都找不到（lost 5 ≥ 5 且 5×4 > 5）。
add("memory card: waiting because lost: 在乎什么 with all five lines replaced (丢了旧文 5/5 行)", () => cnight((w) => {
  cok(w, "阿青", "在乎什么", citems(5, 30, "旧"));
  return cshown(w, cpend(w, "阿青", "在乎什么", citems(5, 30, "新")));
}));
// sweep：总结字段（雷点）、有现行的、非空、丢 1 行；这一批里阿青已有两个现行字段被直接换掉（是谁、喜好），加上这个共 3 个，阿青现行的设定 / 总结字段共 4 个（是谁、喜好、雷点、相处），3×2 > 4。
add("memory card: waiting because sweep: the third changed field of one person in one batch", () => cnight((w) => {
  cok(w, "阿青", "是谁", CARD_WHO);
  cok(w, "阿青", "喜好", citems(5, 30, "喜好"));
  cok(w, "阿青", "雷点", citems(5, 30, "雷点"));
  cok(w, "阿青", "相处", citems(5, 30, "相处"));
  cok(w, "阿青", "是谁", pad("阿青说周六想去海边看日出，希望我陪她", 60));
  cok(w, "阿青", "喜好", cswap(5, 30, "喜好", 4, "喜好改过的第五条"));
  return cshown(w, cpend(w, "阿青", "雷点", cswap(5, 30, "雷点", 4, "雷点改过的第五条")));
}));

// ----- 要谁批（:548）-----
add("memory card: approver with two owners on the list joins their keys with 或", () => cnight((w) => {
  w.owners(["he", "owner-b"]);
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  return cshown(w, cpend(w, "阿青", "约定和边界", cswap(3, 30, "约定", 2, "约定改过的第三条")));
}));
add("memory card: approver with nobody on the list says 人", () => cnight((w) => {
  w.owners([]);
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  return cshown(w, cpend(w, "阿青", "约定和边界", cswap(3, 30, "约定", 2, "约定改过的第三条")));
}));

// ----- 钉原话（:513–521）-----
// 阿青是访客：原话默认私聊（visibility private:qing），private false 才公开；对我的感情和期待 max 3（访客）；记着的原话 max 40，可以钉「我→阿青」（q6）。
add("memory pin: a public pin (private false) says 1/3 句 without 私聊", () => cnight((w) => cshown(w, cpin(w, "q1", { private: false }))));
add("memory pin: a private pin (the default for a guest) says 1/3 句，私聊", () => cnight((w) => cshown(w, cpin(w, "q1"))));
add("memory pin: a pin that replaces another (the section is full at 3) says 换下了 …，", () => cnight((w) => {
  cpin(w, "q1");
  const first = clast(w);
  cpin(w, "q2");
  cpin(w, "q3");
  return cshown(w, cpin(w, "q4", { replaces: first }));
}));
add("memory pin: the same quote again says it was already pinned", () => cnight((w) => {
  cpin(w, "q1");
  return cshown(w, cpin(w, "q1"));
}));
add("memory pin: a quote said to 阿青 (我→阿青) in 记着的原话 says 1/40 句，私聊", () => cnight((w) => cshown(w, cpin(w, "q6", {}, "记着的原话"))));

// ----- 命令行的四条（:599–645）-----
add("memory approve: a pending set replaces the current text", () => cnight((w) => {
  const id = cwait(w);
  return cshown(w, w.mem.approve(id));
}));
add("memory approve: a pending clear removes the field", () => cnight((w) => {
  cok(w, "阿青", "梗", citems(3, 30, "梗"));
  cpend(w, "阿青", "梗", "", { why: "这个梗她说不好笑了" });
  return cshown(w, w.mem.approve(clast(w)));
}));
add("memory reject: a pending is dropped and the current stays", () => cnight((w) => {
  const id = cwait(w);
  return cshown(w, w.mem.reject(id, "夜里写得不对，她没这么说过"));
}));
add("memory approveWho: a name nobody registered throws", () => cnight((w) => cthrows("approveWho", () => w.mem.approveWho("鲸鱼"))));
add("memory approveWho: a person with nothing pending says so", () => cnight((w) => cshown(w, w.mem.approveWho("阿青"))));
// 三条能批（设定改了、总结清掉、丢了五行）加一条过时的（梗：并人并过来的第一版）：批三条、跳过一条并列出为什么
add("memory approveWho: three pendings are approved and a stale one is skipped with its reason", () => cnight((w) => {
  cok(w, "阿青", "约定和边界", citems(3, 30, "约定"));
  cok(w, "阿青", "喜好", citems(3, 30, "喜好"));
  cok(w, "阿青", "在乎什么", citems(5, 30, "旧"));
  cpend(w, "阿青", "约定和边界", cswap(3, 30, "约定", 2, "约定改过的第三条"));
  cpend(w, "阿青", "喜好", "", { why: "这几样她说都不爱了" });
  cpend(w, "阿青", "在乎什么", citems(5, 30, "新"));
  cstale(w);
  return cshown(w, w.mem.approveWho("阿青"));
}));
add("memory approveWho: one pending, approved, nothing skipped", () => cnight((w) => {
  cwait(w);
  return cshown(w, w.mem.approveWho("阿青"));
}));
// 批的时候库抛的不是 Error：真的库抛不出来，把这一个世界的 approveImpression 换成抛一句话的，走 catch 里 String(e) 那一边（整文件的「走到」检查要它）
add("memory approveWho: a refusal that is not an Error is listed as it is (approveImpression replaced on the instance)", () => cnight((w) => {
  cwait(w);
  (w.s as unknown as { approveImpression: unknown }).approveImpression = () => { throw "登记簿这会儿批不了"; };
  return cshown(w, w.mem.approveWho("阿青"));
}));
add("memory approveWho: when the only pending is stale, nothing is approved and the skip is listed (asked by key)", () => cnight((w) => {
  cstale(w);
  return cshown(w, w.mem.approveWho("qing"));
}));
add("memory pending: nothing pending", () => cnight((w) => cshown(w, w.mem.pendingList())));
// 一条改了丢一行（有 why，why 里有换行和连着的空白）、一条清掉（有 why）、一条第一版（没有 why）：按编号一行一条
add("memory pending: a change with a lost line, a clear and a first version, with and without a why", () => cnight((w) => {
  cok(w, "阿青", "约定和边界", citems(2, 30, "约定"));
  cok(w, "老林", "梗", citems(3, 30, "梗"));
  cpend(w, "阿青", "约定和边界", `${clist(2, 30, "约定").slice(0, 1).join("")}\n- ${pad("约定的第二条改成了新的", 30)}`, { why: "他说晚上要睡，\n  早上\t也别吵" });
  cpend(w, "老林", "梗", "", { why: "这个梗他不想再提了" });
  cimport(w, true);
  cpend(w, "老林", "是谁", pad("老林是常借给我工具的朋友", 60), {}, "importer");
  return cshown(w, w.mem.pendingList());
}));
// 私密的待批（接口产不出来：私密字段从不等批）：把一个第一版待批的 visibility 改成 private:qing（SQL，只改这一列）
add("memory pending: a private row shows neither its text nor its why (SQL: visibility of one pending row)", () => cnight((w) => {
  cimport(w, true);
  cpend(w, "阿青", "相处", citems(3, 30, "相处"), { why: "她私下说她考试前总是睡不着" }, "importer");
  const id = clast(w);
  fixture("make private", () => w.db.prepare("UPDATE mem_impression SET visibility = 'private:qing' WHERE id = ?").run(id));
  return cshown(w, w.mem.pendingList());
}));
add("memory pending: a stale row whose replaced row is not there (merge: it replaces 空的, the field has a current one)", () => cnight((w) => {
  cstale(w);
  return cshown(w, w.mem.pendingList());
}));
add("memory pending: a stale row whose field has no current row any more (SQL: status of the replaced row)", () => cnight((w) => {
  cwait(w);
  const cur = ccur(w, "约定和边界");
  fixture("retire current", () => w.db.prepare("UPDATE mem_impression SET status = 'superseded' WHERE id = ?").run(cur));
  return cshown(w, w.mem.pendingList());
}));

// ---------- events/memory.ts：Task 2-0 的 0g ——白天记喜好：like / likeWithMeaning / fix、drop（likeEdit）/ 参数检查（likeCheck）/ my_likes（myLikes） ----------
// 世界是 lw：inMemory 加 seedLikePool 的底子（十件事，编号由返回值给；没有向量，没有人物卡）；按意思找的 lmeaning 配 recordingEmbedder（底子的向量补好以后才开始记问了什么），lwa 配调用的一方给的向量（deadEmbedder / 不给 = 没配）。
// 写过什么用 stored() 看（lshown：回复在前，`--- trace ---` 之后是事件、经过、白天喜好的改动记录、日志）；被拒的也接上（lrefuse：什么都没写，库和底子一样）。
// 感受那条经过的标题、一句话后面的省略号、理由（改状态的、新建带「以前提过」的）只写进库不回复，钉它们的只有 stored()。
// 向量只用答得马上的：recordingEmbedder（同 fakeEmbedder 的算法，余弦在 test 外用同一算法算过：底子里的「雨后石板路的气味」对下面几条线索 0.77–0.85，其余各件都在 0.4 以下，门槛 0.56）和 deadEmbedder（马上答 null）；挂着不答的那种要等真时钟，不用。
// 前缀的三个函数（stripLikePrefix / likeKey / likeMatch）是 memory.ts 导出的，直接调；bareKey / titleKeys 等没导出，经 like 走到。
// 感受标题那张表（how × stance）有两个格子到不了：how=like 时 stance 一定是 like（找已有的要同一边、写 event 要同一边），how=dislike 同理，所以「like 行的烦上了」「dislike 行的喜欢上了」没有调用能走到（那一行的行覆盖由其余格子带上）。

/** 喜好的世界：底子 seedLikePool（十件事），fn 在里面调；o 给向量等 */
const lw = <T>(fn: (w: MemWorld, p: LikePool) => T, o: MemOpts = {}): T => inMemory((w) => fn(w, seedLikePool(w)), o);
/** 同上，fn 是异步的（likeWithMeaning） */
const lwa = <T>(fn: (w: MemWorld, p: LikePool) => Promise<T>, o: MemOpts = {}): Promise<T> => inMemoryAsync((w) => fn(w, seedLikePool(w)), o);
/** 按意思找的世界：底子的向量补好以后才开始记向量服务被问了什么；asked 是被问的文字（`embed <JSON>`） */
const lmeaning = (fn: (w: MemWorld, p: LikePool, asked: string[]) => Promise<string>): Promise<string> => {
  const asked: string[] = [];
  const rec = recordingEmbedder(asked);
  return inMemoryAsync(async (w) => {
    const p = seedLikePool(w);
    await fixtureAsync("pool vectors", () => w.mem.index.backfillVectors(200));
    rec.on();
    return fn(w, p, asked);
  }, { embedder: rec });
};
/** 回复，和这一条调用写进库里的东西（lib 的 splitRest 认 `--- trace ---`）；asked 给了（按意思找的世界）就再接上向量服务被问到的文字，空的也写出来 */
const lshown = (w: MemWorld, reply: string, asked?: readonly string[]): string =>
  `${reply}\n--- trace ---\n${w.stored()}${asked === undefined ? "" : `\nasked\n${asked.join("\n")}`}`;
/** 应该被拒：记成 threw: 原因，后面接 stored()（拒了什么都没写）；没被拒就是夹具错 */
const lrefuse = (w: MemWorld, fn: () => unknown, asked?: readonly string[]): string => {
  try {
    fn();
  } catch (e) {
    return lshown(w, caught(e), asked);
  }
  throw new FixtureError("like: expected a refusal, got a reply");
};
/** 同上，异步的 */
const lrefuseAsync = async (w: MemWorld, fn: () => Promise<unknown>, asked?: readonly string[]): Promise<string> => {
  try {
    await fn();
  } catch (e) {
    return lshown(w, caught(e), asked);
  }
  throw new FixtureError("likeWithMeaning: expected a refusal, got a reply");
};
/** 两件同一边、名字一样的「喜欢 酸奶味的瓜子」（第二件腻了），返回两个编号 */
const ltwins = (w: MemWorld): readonly [string, string] => fixture("twins", () => {
  const mk = (gist: string, over: Record<string, unknown>): string => {
    w.clock.tick();
    return w.s.createEvent({ title: "喜欢 酸奶味的瓜子", summary: `${gist}；这一件是另一天另一包的`, gist, importance: 2, stance: "like", ...over }, "seed").id;
  };
  return [mk("酸奶味的瓜子嗑起来是甜的，奶味不重", {}), mk("第二包酸奶味的瓜子，嗑了半袋就腻了", { status: "done" })] as const;
});
/** 两件喜欢的杯子，后一件取代前一件（「喜欢 老式搪瓷杯」并进「喜欢 搪瓷杯子」），返回 [被并的, 取代它的] */
const lmugs = (w: MemWorld): readonly [string, string] => fixture("mugs", () => {
  const mk = (title: string, gist: string): string => {
    w.clock.tick();
    return w.s.createEvent({ title, summary: `${gist}，写成总结是为了和一句话不一样`, gist, importance: 2, stance: "like" }, "seed").id;
  };
  const a = mk("喜欢 老式搪瓷杯", "白底蓝边的搪瓷杯，装热水烫手");
  const b = mk("喜欢 搪瓷杯子", "和老式搪瓷杯是同一只，名字换了个写法");
  w.s.supersede(a, b, "两件其实是同一只杯子", "seed");
  return [a, b] as const;
});

// ----- 前缀的三个函数（直接调） -----
const LTITLES = ["喜欢 红糖姜茶", "喜欢《白噪音》", "喜欢红糖姜茶", "烦恼", "喜欢你", "  烦 排队等位", "烦「弹窗广告」", "烦（早高峰）", "喜欢  Cold Brew", "喜欢", "桂花乌龙茶"] as const;
const lfn = (name: string, args: readonly string[], out: unknown): string => `${name}(${args.map((x) => JSON.stringify(x)).join(", ")}) = ${JSON.stringify(out)}`;
const lmatches = (pairs: ReadonlyArray<readonly [string, string]>): string => pairs.map(([what, title]) => lfn("likeMatch", [what, title], likeMatch(what, title))).join("\n");
add("memory likeKey: stripLikePrefix on eleven shapes of a title (a space or an opening bracket makes the word a prefix; 喜欢你, 烦恼 and an old title like 喜欢红糖姜茶 are names)", () =>
  LTITLES.map((t) => lfn("stripLikePrefix", [t], stripLikePrefix(t))).join("\n"));
add("memory likeKey: likeKey on the same eleven shapes (prefix, brackets, spaces and case gone)", () =>
  LTITLES.map((t) => lfn("likeKey", [t], likeKey(t))).join("\n"));
add("memory likeKey: likeMatch exact (a title in every shape meets the name; either side may carry the word)", () => lmatches([
  ["红糖姜茶", "喜欢 红糖姜茶"], ["红糖姜茶", "喜欢红糖姜茶"], ["喜欢红糖姜茶", "喜欢 红糖姜茶"], ["白噪音", "喜欢《白噪音》"], ["《白噪音》", "喜欢 白噪音"],
  ["烦恼", "烦恼"], ["喜欢你", "喜欢你"], ["烦 排队等位", "烦排队等位"], ["Cold Brew", "喜欢 cold brew"],
]));
add("memory likeKey: likeMatch near (one inside the other, either way round; the shorter at least two characters)", () => lmatches([
  ["红糖", "喜欢 红糖姜茶"], ["红糖姜茶", "喜欢 红糖"], ["姜茶", "喜欢《红糖姜茶》"], ["喜欢红糖", "喜欢 红糖姜茶"],
]));
add("memory likeKey: likeMatch none (a one-character remainder is no name: 喜欢你 against 喜欢 你, 烦恼 against 烦 恼, one character against a title)", () => lmatches([
  ["喜欢你", "喜欢 你"], ["烦恼", "烦 排队等位"], ["红", "喜欢 红糖姜茶"], ["烦恼", "烦 恼"], ["绿茶", "喜欢 红糖姜茶"],
]));

// ----- likeCheck：每一种拒绝（按代码检查的顺序；前面的拒绝也成立时前面的赢） -----
const LREGION = "memory likeCheck: region hippocampus cannot note a like (like)";
const LNOWHY = "memory likeCheck: fix without a why";
const LNOFEEL = "memory likeCheck: how like without a feeling";
const LNOWHAT = "memory likeCheck: an empty what without an event";
const LNEWFEEL = "memory likeCheck: new with how feel";
add(LREGION, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "feel", feeling: "想在海马那头记一下这杯茶" }, { region: "hippocampus" }))));
add("memory likeCheck: region hippocampus, likeWithMeaning refuses before it asks the embedder (the asked list stays empty)", () => lmeaning((w, _p, asked) =>
  lrefuseAsync(w, () => w.mem.likeWithMeaning({ what: "桂花乌龙茶", how: "feel", feeling: "想在海马那头记一下这杯茶" }, { region: "hippocampus" }), asked)));
add(LNOWHY, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "喜欢 桂花乌龙", why: "" }))));
add("memory likeCheck: drop without a why (a blank why is no why)", () => lw((w) => lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "drop", why: "   " }))));
add(LNOFEEL, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "凉拌木耳的脆劲", how: "like" }))));
add(`memory likeCheck: how feel with a blank feeling (same text as ${LNOFEEL}: pins the path)`, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "feel", feeling: "  " }))));
add("memory likeCheck: fix with a why but neither a title nor a gist", () => lw((w) => lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix", why: "想改但还没想好改成什么" }))));
add(LNOWHAT, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "《》", how: "like", feeling: "名字只写了一对书名号" }))));
add(LNEWFEEL, () => lw((w) => lrefuse(w, () => w.mem.like({ what: "凉拌木耳的脆劲", how: "feel", feeling: "想单独记一件新的", new: true }))));
add("memory likeCheck: new with an event", () => lw((w, p) => lrefuse(w, () => w.mem.like({ what: "凉拌木耳的脆劲", how: "like", feeling: "又想单独记，又想接在老的上面", new: true, event: p.tea }))));
add(`memory likeCheck: the region wins over a missing feeling (same text as ${LREGION}: pins the path)`, () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "feel" }, { region: "hippocampus" }))));
add(`memory likeCheck: a missing why wins over a missing title and gist (same text as ${LNOWHY}: pins the path)`, () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix" }))));
add(`memory likeCheck: a missing feeling wins over an empty what (same text as ${LNOFEEL}: pins the path)`, () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "《》", how: "like" }))));
add(`memory likeCheck: an empty what wins over new with how feel (same text as ${LNOWHAT}: pins the path)`, () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "《》", how: "feel", feeling: "名字没写，还带着 new", new: true }))));
add(`memory likeCheck: new with how feel wins over new with an event (same text as ${LNEWFEEL}: pins the path)`, () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "凉拌木耳的脆劲", how: "feel", feeling: "带着 new 又带着 event", new: true, event: p.tea }))));
add("memory like: an empty what is fine when the event is given (feel on the tea)", () => lw((w, p) =>
  lshown(w, w.mem.like({ what: "", how: "feel", feeling: "没写名字，是靠编号接上的这一下", event: p.tea }))));

// ----- event 给了的各种拒绝 -----
add("memory like: event given, an id that is not there", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "feel", feeling: "编号写错了的一下", event: "e9999" }))));
add("memory like: event given, an event that has no stance", () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "器材", how: "feel", feeling: "想把一件普通的事当成喜欢的", event: p.plain }))));
add("memory like: event given, a superseded one names what took its place", () => lw((w) => {
  const [old] = lmugs(w);
  return lrefuse(w, () => w.mem.like({ what: "搪瓷杯", how: "feel", feeling: "又拿起了那只白底蓝边的杯子", event: old }));
}));
add("memory like: event given, a superseded one nobody took the place of (set by updateEvent, no superseded_by)", () => lw((w, p) => {
  fixture("supersede the mint", () => w.s.updateEvent(p.mint, { status: "superseded" }, "手工标成并掉了", "seed"));
  return lrefuse(w, () => w.mem.like({ what: "薄荷糖罐头", how: "again", feeling: "想把并掉的那罐糖再接上", event: p.mint }));
}));
add("memory like: event given, a retired one with how drop (no hint to note it anew)", () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "竹编小筐", how: "drop", why: "已经撤掉的又想撤一次", event: p.basket }))));
add("memory like: event given, a retired one with how feel (the hint: note it anew with how=like)", () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "竹编小筐", how: "feel", feeling: "想给撤掉的那只小筐再添一笔", event: p.basket }))));
add("memory like: event given, how like on a dislike (all four words of the refusal on the dislike side)", () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "周一早上的例会", how: "like", feeling: "今天的例会居然很短，一时高兴", event: p.meeting }))));
add("memory like: event given, how dislike on a like (all four words of the refusal on the like side)", () => lw((w, p) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "dislike", feeling: "今天这杯茶泡苦了，有点烦", event: p.tea }))));

// ----- 名字对上了好几件、只对上撤掉的 -----
add("memory like: two events of one side with the same name (feel lists both, with their labels)", () => lw((w) => {
  ltwins(w);
  return lshown(w, w.mem.like({ what: "酸奶味的瓜子", how: "feel", feeling: "不知道该接在哪一包上的一下" }));
}));
add("memory like: new=true while two of the same name exist (the names joined by 、)", () => lw((w) => {
  ltwins(w);
  return lrefuse(w, () => w.mem.like({ what: "酸奶味的瓜子", how: "like", feeling: "想再单独记一包", new: true }));
}));
add("memory like: new=true while one of the same name exists", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "like", feeling: "想把这个茶单独再记一件", new: true }))));
add("memory like: the name matches only a retired event, how feel (with the hint)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "竹编小筐", how: "feel", feeling: "看到小筐想再添一笔" }))));
add("memory like: the name matches only a retired event, how drop (without the hint)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "竹编小筐", how: "drop", why: "撤掉的再撤一次" }))));

// ----- 候选（名字沾边、挂着的东西叫这个名字） -----
add("memory like: fix with one candidate (it says which to write as event)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "傍晚河边", how: "fix", title: "喜欢 傍晚的河边", why: "名字写得不对" }))));
add("memory like: drop with two candidates (which one to write as event)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "河边", how: "drop", why: "想撤掉河边的那件" }))));
add("memory like: like with one candidate (the new=true hint)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "傍晚河边", how: "like", feeling: "傍晚在河边又喜欢上了什么" }))));
add("memory like: like with two candidates (the new=true hint and which one to write)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "河边", how: "like", feeling: "河边的风把头发都吹乱了，还是喜欢" }))));
add("memory like: feel with two candidates (no new=true hint)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "河边", how: "feel", feeling: "走到河边忽然又想起一下" }))));
add("memory like: a candidate found through an entity's alias (叫「…」的那个)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "小夜曲", how: "feel", feeling: "电台里又放到了那首曲子" }))));
add("memory like: a candidate found through an entity's own name (叫「…」的那个)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "檐下小夜曲", how: "feel", feeling: "晚上哼了一遍檐下小夜曲的调子" }))));

// ----- 什么都没找到、名字太长 -----
add("memory like: nothing found, fix (the name has to be the same, or write event)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "路边摊的烤红薯", how: "fix", title: "喜欢 烤红薯", why: "想改一个没记过的名字" }))));
add("memory like: nothing found, feel (the first time is how=like or dislike)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "路边摊的烤红薯", how: "feel", feeling: "闻到烤红薯的香味又想起一下" }))));
add("memory like: a what of 23 characters with how like is too long for a title", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "周六早上在老城区那家没有招牌的小面馆吃牛肉面条", how: "like", feeling: "那碗面的汤特别清" }))));

// ----- 第一次喜欢 / 烦：新建 -----
add("memory like: the first like creates the event (title 喜欢上了 on the feeling entry, importance 3)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "凉拌木耳的脆劲", how: "like", feeling: "咬下去咔嚓一声，酸辣刚好，一小碗很快就见底了" }))));
add("memory like: the first dislike creates the event (title 烦上了 on the feeling entry)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "公交车上外放的短视频声音", how: "dislike", feeling: "一整路都在响，捂着耳朵也挡不住，下车时头还在嗡" }))));
add("memory like: the first like with importance 4 (the feeling is also the why)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "冬天晒过的棉被", how: "like", feeling: "晒了一下午的棉被盖上去有太阳的味道，睡得特别沉", importance: 4 }))));
add("memory like: a what that already carries the prefix is stripped before the title is built", () => lw((w) =>
  lshown(w, w.mem.like({ what: "喜欢 竹节虫标本", how: "like", feeling: "小禾给我看了一盒标本，细长的肢节排得整整齐齐" }))));

// ----- 已有的：又一下、腻了、又喜欢上了 -----
add("memory like: feel on a like (title 又一下, the plain reply)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "feel", feeling: "今天换了个小瓷杯，花香好像更集中了" }))));
add("memory like: feel on a dislike (title 又一下)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "周一早上的例会", how: "feel", feeling: "例会上又有人把上周的事从头念了一遍" }))));
add("memory like: over on a like (title 腻了, the status goes to done with the feeling as the reason, reply 改成)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "over", feeling: "喝了一个多月，桂花的甜味已经腻了" }))));
add("memory like: over on a dislike (title 不烦了, reply 改成)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "周一早上的例会", how: "over", feeling: "例会改成站着开了，十分钟就散，不烦了" }))));
add("memory like: over with a feeling over 80 characters (the reason of the status change ends with …)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "over", feeling: pad("喝腻了桂花乌龙，每次一闻到那股甜味就想换别的", 100) }))));
add("memory like: again on a done like (title 又喜欢上了, reason 又喜欢上了, reply 改回)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "薄荷糖罐头", how: "again", feeling: "路过杂货铺看见一罐薄荷糖，忽然又想吃了" }))));
add("memory like: again on a done dislike (title 又烦上了, reason 又烦上了, reply 改回)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "楼下的电钻声", how: "again", feeling: "楼下又开始装修了，电钻声一响我就绷紧了" }))));
add("memory like: like on a done like (it comes back: reason 又喜欢上了, reply 改回)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "薄荷糖罐头", how: "like", feeling: "小禾又给了我一颗，含着还是那个凉味" }))));
add("memory like: a feeling over 80 characters on a new like (the stored gist ends with …)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "秋天落在窗台上的银杏叶", how: "like", feeling: pad("窗台上落了一片金黄的银杏叶，我舍不得扫掉", 100) }))));
add("memory like: the same feel twice without a tick (刚才已经记过这一下)", () => lw((w) => {
  const feeling = "傍晚在河边又坐了一会儿，同一句话说了两遍";
  fixture("first feel", () => w.mem.like({ what: "傍晚河边散步", how: "feel", feeling }));
  return lshown(w, w.mem.like({ what: "傍晚河边散步", how: "feel", feeling }));
}));

// ----- 新建时的旁话：以前提过、另一边还开着、撤掉的同名 -----
add("memory like: a new like whose name sits on an entity of two plain events (the sentence, and the reason with ；以前提过： in the store)", () => lw((w) => {
  fixture("two plain events with the kettle", () => {
    const s = w.s;
    w.clock.tick();
    const a = s.createEvent({ title: "周六摆摊的咖啡角", summary: "周六在社团的摊位上摆了个咖啡角，来试喝的人不少", gist: "摊位上摆了个咖啡角", importance: 2, entities: [{ name: "手冲壶", kind: "thing", role: "about" }] }, "seed").id;
    const n1 = s.addEntry({ event: a, at: ago(5), kind: "happened", title: "试了新壶", gist: "试用新壶", full: "老林把新买的壶拿来试了一遍，水流很细，试喝的人都说顺口" }, "seed").entry.id;
    const n2 = s.addEntry({ event: a, at: ago(4), kind: "happened", title: "壶嘴有点滴水", gist: "壶嘴滴水", full: "第二天发现壶嘴收水不干净，桌上留了一圈水印，得垫块布" }, "seed").entry.id;
    s.tagEntity("手冲壶", n1, "about", "seed");
    s.tagEntity("手冲壶", n2, "about", "seed");
    w.clock.tick();
    s.createEvent({ title: "社团器材清点", summary: "清点了摊位要用的器材，小禾把清单誊了一份", gist: "清点摊位器材", importance: 2, entities: [{ name: "手冲壶", kind: "thing", role: "about" }] }, "seed");
  });
  return lshown(w, w.mem.like({ what: "手冲壶", how: "like", feeling: "手冲出来的第一杯很干净，水声也好听，想以后天天用" }));
}));
add("memory like: like while a dislike of the same name is ongoing (the other side is mentioned, 还在烦着)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "周一早上的例会", how: "like", feeling: "今天的例会居然只开了十分钟，一下子喜欢上了" }))));
add("memory like: dislike while a like of the same name is ongoing (the other side is mentioned, 还标着喜欢中)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "dislike", feeling: "今天泡出来是涩的，一口就皱了眉，烦" }))));
add("memory like: like after drop of the same name (the retired namesake is mentioned)", () => lw((w) => {
  fixture("drop the walk", () => w.mem.like({ what: "傍晚河边散步", how: "drop", why: "那其实是别人的习惯，不是我的" }));
  w.clock.tick();
  return lshown(w, w.mem.like({ what: "傍晚河边散步", how: "like", feeling: "这回是自己走了一圈，风凉凉的，才知道真喜欢" }));
}));

// ----- 按意思找（likeWithMeaning） -----
const LRAIN = { what: "雨后老街石板路上的泥土气味", feeling: "走在老街上，雨后的石板路和泥土的味道，闻着很安静" } as const;
add("memory like: by meaning, a new like finds a candidate (the cue is what：feeling; the candidate and its cosine are logged)", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: LRAIN.what, how: "like", feeling: LRAIN.feeling }), asked)));
add("memory like: by meaning, fix finds a candidate (no feeling, so the cue is what alone)", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "雨后老街石板路上的泥土味", how: "fix", gist: "老街雨后的泥土味", why: "想改成更短的说法" }), asked)));
add("memory like: by meaning, drop finds a candidate (the cue is what alone)", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "雨后的老街和石板路的潮湿气味", how: "drop", why: "想撤掉老街的那件" }), asked)));
add("memory like: by meaning, nothing passes the threshold, so a new like is created and no sentence is added", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "蒸好的红薯", how: "like", feeling: "掰开冒着热气，隔着袋子都能闻到甜味，烫手也舍不得放" }), asked)));
add("memory like: by meaning, an exact name is found without asking the embedder (feel on the tea)", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "桂花乌龙茶", how: "feel", feeling: "今天用的是新买的壶，味道差不多" }), asked)));
add("memory like: by meaning, an event given is not searched for", () => lmeaning(async (w, p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "傍晚河边散步", how: "feel", feeling: "编号接上的一下，不用去问向量", event: p.walk }), asked)));
add("memory like: by meaning, new=true is not searched for", () => lmeaning(async (w, _p, asked) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "新买的绿釉小碗", how: "like", feeling: "单独记一件，不用去问向量", new: true }), asked)));
add("memory like: by meaning, a name that only a retired event has is not searched for either (the refusal comes with nothing asked)", () => lmeaning((w, _p, asked) =>
  lrefuseAsync(w, () => w.mem.likeWithMeaning({ what: "竹编小筐", how: "feel", feeling: "看到小筐想再添一笔" }), asked)));
add("memory like: a dead embedder, a new like is created and the reply ends with the sentence 这次没法按意思找 (a warn is logged)", () => lwa(async (w) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "手工做的小风铃", how: "like", feeling: "风一吹就叮叮地响，挂在窗边特别好听" })), { embedder: deadEmbedder }));
add("memory like: a dead embedder, a candidate list ends with the same sentence", () => lwa(async (w) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "河边", how: "like", feeling: "河边的草长得很高，傍晚特别安静" })), { embedder: deadEmbedder }));
add("memory like: a dead embedder, a refusal ends with the same sentence", () => lwa((w) =>
  lrefuseAsync(w, () => w.mem.likeWithMeaning({ what: "路边摊的烤红薯", how: "feel", feeling: "闻到烤红薯的香味又想起一下" })), { embedder: deadEmbedder }));
add("memory like: no embedder at all, a new like says nothing about the search", () => lwa(async (w) =>
  lshown(w, await w.mem.likeWithMeaning({ what: "晒干的橘子皮泡水", how: "like", feeling: "泡开以后有一点点苦，又有一点点甜，喝完嘴里很清爽" }))));

// ----- fix / drop（likeEdit） -----
add("memory likeEdit: drop by event (the reply; the store shows retired and the why as the reason)", () => lw((w, p) =>
  lshown(w, w.mem.like({ what: "傍晚河边散步", how: "drop", why: "那其实是别人的习惯，记到我身上了", event: p.walk }))));
add("memory likeEdit: drop by the exact name", () => lw((w) =>
  lshown(w, w.mem.like({ what: "河边慢跑", how: "drop", why: "跑过一次就没再跑，算不上喜欢" }))));
add("memory likeEdit: fix the title only", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "喜欢 桂花乌龙", why: "茶名里不用带那个茶字" }))));
add("memory likeEdit: fix the gist only", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", gist: "桂花味的乌龙，第三泡最好喝", why: "原来的一句话太长了" }))));
add("memory likeEdit: fix the title and the gist by event", () => lw((w, p) =>
  lshown(w, w.mem.like({ what: "傍晚河边散步", how: "fix", title: "喜欢 傍晚沿河走", gist: "太阳快落时沿着河走一圈", why: "换个顺口的说法", event: p.walk }))));
add("memory likeEdit: fix a gist over 80 characters (cut with …)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", gist: pad("桂花乌龙茶泡开以后的香气一直留到第三泡", 100), why: "想把一句话写得更完整" }))));
add("memory likeEdit: a title without a prefix is completed with the own word (喜欢 …)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "金桂乌龙茶", why: "换成商家写的名字" }))));
add("memory likeEdit: a title with the own word and a bracket stays as written", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "喜欢《桂花乌龙》", why: "想用书名号圈起来" }))));
add("memory likeEdit: a title with the own word, a space and one character after it counts as marked (the prefix test, not the remainder)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "喜欢 乌", why: "试一个只剩一个字的名字" }))));
add("memory likeEdit: on a like, a title that is the other word's name itself (烦恼) is completed, not refused", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "烦恼", why: "这杯茶的名字就叫烦恼" }))));
add("memory likeEdit: on a dislike, a title that is the own word's name itself (喜欢你) is completed with the own word", () => lw((w) =>
  lshown(w, w.mem.like({ what: "周一早上的例会", how: "fix", title: "喜欢你", why: "例会的外号叫喜欢你" }))));
add("memory likeEdit: the other side's word on a like is refused (腻了, then how=dislike)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "烦 周末加班的味道", why: "想把方向也一起改了" }))));
add("memory likeEdit: the other side's word on a dislike is refused (不烦了, then how=like)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "周一早上的例会", how: "fix", title: "喜欢 周末的懒觉", why: "想把方向也一起改了" }))));
add("memory likeEdit: a title too long (the completed title is over 24 characters)", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "清晨六点半在楼下早餐铺子买到的热豆浆和刚炸好的油条", why: "想写得具体一点" }))));
add("memory likeEdit: a title that collides with another event of the same side", () => lw((w) =>
  lrefuse(w, () => w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "河边慢跑", why: "想把名字改得和别的一样" }))));
add("memory likeEdit: nothing changed (the same title, no gist)", () => lw((w) =>
  lshown(w, w.mem.like({ what: "桂花乌龙茶", how: "fix", title: "桂花乌龙茶", why: "以为名字写错了，其实没错" }))));

// ----- my_likes -----
add("memory myLikes: an empty store", () => inMemory((w) => w.mem.myLikes()));
add("memory myLikes: four groups; no feeling (the line has no 最近一下 part), a last feeling that is its gist, a later feeling that differs, a retired event left out", () => lw((w) => w.mem.myLikes()));
add("memory myLikes: one group missing (the only 以前烦 is retired)", () => lw((w, p) => {
  fixture("retire the drill", () => w.s.retire(p.drill, "那其实是别人家的电钻", "seed"));
  return w.mem.myLikes();
}));
add("memory myLikes: a like made by like has one feeling that is its gist (no 最近一下 part)", () => inMemory((w) => {
  fixture("first dislike", () => w.mem.like({ what: "弹窗广告的声音", how: "dislike", feeling: "一打开应用就弹出来，吵得人心烦" }));
  return w.mem.myLikes();
}));
const lcrowd = (page?: number): string => inMemory((w) => {
  seedLikeCrowd(w);
  return page === undefined ? w.mem.myLikes() : w.mem.myLikes(page);
});
const LPAGE1 = "memory myLikes: over 4000 characters, page 1 stops at a whole line and ends with the tail (还有 40 件 …page=2)";
add(LPAGE1, () => lcrowd(1));
add("memory myLikes: page 2 starts inside a group (the head is printed again) and is held back by the room for the tail", () => lcrowd(2));
add("memory myLikes: the last page has no tail", () => lcrowd(3));
add("memory myLikes: page 99 does not exist (一共 3 页)", () => lcrowd(99));
add(`memory myLikes: no page argument is page 1 (same text as ${LPAGE1}: pins the path)`, () => lcrowd());

// ---------- events/memory.ts：Task 2-0 的 0h ——夜里的工作单（worklist）：交给夜里那一遍的长文字，列白天留下的、还没整理的 ----------
// 世界是 inMemory（时钟起点 EV_NOW = 11-13 09:00，在工作单那一天 WORK_DAY 的窗口 11-13 04:00 到 11-14 03:59:59.999 里），满的一天是 seedWorkDay（见 world.ts：每一节里有什么、怎么落在哪一支）。
// 工作单只读：返回的话就是整份文字（没有踪迹）。每个段的「没有」支在空库那条里走；40 团、40 件的上限各有一条调用；整份文字里的人名、事件编号都由夹具的写入顺序定，是确定的。
// 旧种类（项目、话题）库的写法造不出来（登记只收五种），调用里用 SQL 只改 mem_entity.kind 这一列（老项目账本 → project、旧话题清单 → topic），写在 id 里。
// 人物卡那两节（第 8 节末尾的「最近常打交道」一行和人物卡摘要）的文字在 events/people.ts 里，不在 memory.ts 的文字行上；开 / 关两条调用把这条缝钉住（3b-3 要用）。

/** 满的一天：fn 在里面调（d 是夹具返回的编号） */
const wday = <T>(fn: (w: MemWorld, d: WorkDay) => T, o: MemOpts = {}): T => inMemory((w) => fn(w, seedWorkDay(w)), o);
/** 旧种类：只改 mem_entity.kind 这一列（库的写法写不出 project / topic） */
const wlegacy = (w: MemWorld): void => fixture("legacy kinds", () => {
  const set = w.db.prepare("UPDATE mem_entity SET kind = ? WHERE name = ?");
  set.run("project", "老项目账本");
  set.run("topic", "旧话题清单");
});
/** 小禾（重要度 2）在三个不同的日子（11-12、11-11、11-10）的经过里出现：第 8 节末尾「最近常打交道」那一行有的写 */
const wfriends = (w: MemWorld, d: WorkDay): void => fixture("friends", () => {
  w.s.openBatch("friends");
  for (let i = 1; i <= 3; i++) {
    w.s.addEntry({
      event: d.party, at: ago(i), kind: "happened", full: pad(`第 ${i} 天的聚餐筹备：小禾又来问了一次人数和预算`, 60), gist: pad(`聚餐筹备的第 ${i} 步`, 20),
      title: `聚餐筹备${i}`, people: ["小禾"], source: [],
    }, "friends");
  }
  w.s.commitBatch("friends");
});

const WEMPTY = "memory worklist: an empty store (every none arm: no quotes, no events, no entities, no likes)";
const WFULL = "memory worklist: a full day, the legacy kinds project and topic set by SQL on mem_entity.kind (not yet organised)";
add(WEMPTY, () => inMemory((w) => w.mem.worklist(WORK_DAY)));
add(WFULL, () => wday((w) => {
  wlegacy(w);
  return w.mem.worklist(WORK_DAY);
}));
add("memory worklist: the same full day after markDay (the header says it was organised; legacy kinds set by SQL)", () => wday((w) => {
  wlegacy(w);
  w.s.markDay(WORK_DAY);
  return w.mem.worklist(WORK_DAY);
}));
add("memory worklist: a full day with the people feature on and switched over (promote line and card digest after section 8; legacy kinds set by SQL)", () => wday((w, d) => {
  wlegacy(w);
  wfriends(w, d);
  return w.mem.worklist(WORK_DAY);
}, { people: true }));
add(`memory worklist: a full day with the people feature on but not switched over (no promote line, no card digest; same text as ${WFULL}: pins the path; legacy kinds set by SQL)`, () => wday((w, d) => {
  wlegacy(w);
  wfriends(w, d);
  return w.mem.worklist(WORK_DAY);
}, { people: true, active: false }));
add("memory worklist: 41 quotes 31 minutes apart are 41 groups (the first 40 listed, then the tail line 还有 1 团)", () => inMemory((w) => {
  seedQuoteCrowd(w, 41);
  return w.mem.worklist(WORK_DAY);
}));
add("memory worklist: 41 ongoing likes (the first 40 listed, then the tail line 还有 1 件)", () => inMemory((w) => {
  seedHeldCrowd(w, 41);
  return w.mem.worklist(WORK_DAY);
}));

export const CALLS: readonly Call[] = calls;
