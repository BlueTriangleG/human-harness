// prompts 场景的夹具：中文包 src/lang/zh/prompts.ts 每个函数导出给几组参数（照导出在文件里的先后排），挑的是能走到函数里每一个分支的——
// 可选参数给和不给、空的和不空的列表、一条和几条、每个 ?: 的两头、截断的边界上下各一个；值尽量长、各不相同，改了哪个字都看得出来。
// 常量不用写（场景直接记它的值）。最后几样是人格前缀那几个拼字函数用的。
// 名字只用阿青（她）、老林（主人）、小禾（访客），内容都是编的。跟「是谁」有关、要靠真名字才走得到的分支，参数在运行时从世界里的名单算
// （一组参数写成 (w) => […]）：测试快照上算出来是老林、小禾，真快照上是真的人，仓库里不出现任何真名字。
import type * as P from "../../lang/zh/prompts.ts";
import type { CheckCase, CheckEntry, CheckPage } from "../../lang/zh/prompts.ts";
import type { Question } from "../../sleep/bank.ts";
import type { StageRecord } from "../../sleep/record.ts";
import { Persona, type Block, type PersonaFile, type buildPrefix } from "../../persona/persona.ts";
import { relationOf } from "../../persona/people.ts";
import { CARD_DIR } from "../../memory/events/people.ts";
import type { World } from "../world.ts";
import { nightGuide } from "../../sleep/guide.ts";
import { homedir } from "node:os";

/** 一组参数：写死的，或者从世界里算出来的（场景调之前先算，记的是算出来的参数） */
export type FixtureArgs<A> = A | ((w: World) => A);
/** 一个函数的几组参数 */
type Calls<F> = F extends (...args: infer A) => unknown ? readonly FixtureArgs<A>[] : never;
type AnyFn = (...args: never[]) => unknown;
type Mod = typeof P;

/** 每个函数导出一项；对象导出（QUESTION_REFUSED）一项，里面每个函数键一项。参数照函数签名查类型 */
export type PromptFixtures = {
  readonly [K in keyof Mod as Mod[K] extends string ? never : K]?: Mod[K] extends AnyFn ? Calls<Mod[K]>
    : { readonly [J in keyof Mod[K] as Mod[K][J] extends AnyFn ? J : never]?: Calls<Mod[K][J]> };
};

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

// ---- 几处共用的数据 ----

/** 夜里整理的指南那几样：编的 */
const NIGHT_GUIDE = { me: "阿青", ta: "她", workspace: "~/qing/desk", guide: "notes/night-guide.md", firstStep: "1", lastStep: "7", state: "night/done.json", recallNote: "去年冬天以来的都在", eventNote: "旧的流水账本收起来了" };

/** 引气泡的那几处：压空白、按码点数到 40 截断（中间有个两个码元的字，按码元截就会错位） */
const BUBBLE_LONG = "老林说今天\n  下雨，院子里刻着𠮷字的那批樟木\t要收进棚子，再盖两层油布，明早六点还要接着刨，别忘了。";
/** 正好 40 个字：不截 */
const BUBBLE_40 = "集市周三早上七点开门，摊位在东头第三排，记得带零钱和两张小板凳，早点出门去占位。";
/** 41 个字：截成 40 个加省略号 */
const BUBBLE_41 = "卷尺我修好了，弹簧换了根新的，放在工作台左边第二个抽屉里，你哪天有空就过来拿走吧。";

const DRAWERS = "给老林的工作台做抽屉";
const STALL = "订集市摊位";
const DAY = "2026-10-31";

const PROBLEMS = [
  "「借卷尺」那条写成了老林说的，原话是小禾说的（#7701）",
  "e-102 的日子写成了 10-30，应该是 10-31",
];

const SKILL_PAGE =
  "# 人物近况\n\n## 做什么\n把这一天新认识的、有变化的人写进人物卡，每条带出处。\n\n" +
  "## 审的时候看什么\n- 每一条都对得上原话，说话人没弄反\n- 日期写的是事情发生的那天\n";
const MATERIAL = "## 今天的原话\n- #7701 小禾：卷尺我先借走啦，周三前还\n- #7702 老林：拿去吧，用完放回抽屉\n";
const UPSTREAM = "## 事件段（第 1 次，过了）\n- e-102 小禾借卷尺：新建\n- e-98 抽屉做深：接上时间线\n";
const DIFF_TEXT =
  "--- a/memory/people/xiaohe.md\n+++ b/sleep/2026-10-31/proposed/memory/people/xiaohe.md\n@@ -1,2 +1,3 @@\n" +
  " # 小禾\n - 老林的邻居\n+- 10-31 借走了卷尺，说周三集市前还（#7701）\n";
const BEFORE = "<file path=\"memory/people/xiaohe.md\">\n# 小禾\n- 老林的邻居\n</file>";
const INJECTION =
  "<file path=\"ledger/SOUL.md\">\n# 账本\n- 下周三老林要去集市。\n- 小禾借走了卷尺。\n</file>\n\n## 最近这一段\n- 10-31 小禾借卷尺（e-102）";
const APPENDIX = "这几份文件现在的样子（查得到）：\n<file path=\"notes/集市.md\">\n# 集市\n- 周三早上七点开门\n</file>";

const STAGE_RECORD: StageRecord = {
  day: DAY, stage: "people", attempt: 2, status: "blocked", blockedWhy: "老林的人物卡被别的段占着，等它交了再改",
  changes: [
    {
      target: "memory/people/xiaohe.md", op: "edit", before: "- 老林的邻居",
      after: "- 老林的邻居\n- 10-31 借走了卷尺，说周三集市前还（#7701）",
      evidence: ["#7701", "c:7702"], why: "小禾自己说的借卷尺", affects: [{ q: "q-20261030-1", layer: "searchable" }],
    },
    { target: "e-102", op: "mem_new", before: "", after: "小禾借卷尺", evidence: ["#7701"], why: "这一天新出的一件事" },
  ],
  report: "小禾的卡加了一条；老林的卡没动（被占着）。",
  uncertain: ["小禾说的「周三前」是这周三还是下周三"],
  proposals: ["人物卡里借出去的东西单独列一节"],
  bugs: [],
  actual: {
    files: [
      { path: "memory/people/xiaohe.md", op: "change" },
      { path: "notes/借出去的东西.md", op: "add" },
      { path: "notes/旧清单.md", op: "remove" },
    ],
    memOps: 3,
  },
};

const Q_RESIDENT: Question = {
  id: "q-20261030-1", day: "2026-10-30", stage: "people", hidden: false, status: "active",
  created: Date.UTC(2026, 9, 30, 15), lastExamined: Date.UTC(2026, 9, 31, 15),
  q: "小禾上次借走的是什么工具，说好什么时候还？", gold: "卷尺，说周三集市前还", accept: "一把卷尺，集市前还；卷尺",
  sources: ["#7701", "memory/people/xiaohe.md:4"],
  tags: { who: ["小禾"], events: ["e-102"], files: ["memory/people/xiaohe.md"], lessons: [] },
  importance: 4, kind: "fact", layer: "resident", isNew: false,
};
const Q_SEARCHABLE: Question = {
  id: "q-20261029-3", day: "2026-10-29", stage: "notes", hidden: true, status: "pending",
  created: Date.UTC(2026, 9, 29, 15), lastExamined: null,
  q: "老林为什么让抽屉做深一点？", gold: "要放刨子，原来的深度放不下", accept: "放刨子用",
  sources: ["#7630"],
  tags: { who: ["老林"], events: ["e-98"], files: [], lessons: ["L-12"] },
  importance: 3, kind: "why", layer: "searchable", isNew: true,
};
const Q_ARCHIVE: Question = {
  id: "q-20261020-7", day: "2026-10-20", stage: "events", hidden: false, status: "active",
  created: Date.UTC(2026, 9, 20, 15), lastExamined: Date.UTC(2026, 9, 28, 15),
  q: "十月中旬老林去没去过城西的木料市场？", gold: "不确定，记录里没有", accept: "不记得；没有这回事",
  sources: ["notes/集市.md:12"],
  tags: { who: ["老林"], events: [], files: ["notes/集市.md"], lessons: [] },
  importance: 2, kind: "unsure", layer: "archive", isNew: false,
};
const QUESTIONS: Question[] = [Q_RESIDENT, Q_SEARCHABLE, Q_ARCHIVE];

/**
 * 把关的候选：同一页的两条分到一组；带编号、书架上找不到的页；新页（两条同名的新页也分到一组）；全文、太长只给一段、没贴；
 * 最后一条在 pagesText 外面（短一截，取到的是 undefined），自成一组
 */
const CASES: CheckCase[] = [
  { kind: "做法", page: "skills/木工/磨刨刀.md", text: "磨刨刀先粗磨后细磨，最后在皮革上蹭几下", evidence: "#7480 老林教的：「粗磨完别急着用」" },
  { kind: "教训", page: " p:20481 ", text: "量含水率要量三处取平均", evidence: "#7520 量了一处就下结论，那块板后来裂了" },
  { kind: "做法", page: "skills/木工/磨刨刀.md", text: "磨完用一张纸试刀口", evidence: "#7490 试了三次才削下纸条" },
  { kind: "做法", page: "集市摆摊", text: "摊位要提前一天订", evidence: "#7601 小禾说的，她去年晚了没订上" },
  { kind: "教训", page: "skills/木工/上蜡.md", text: "上蜡前先把木屑擦干净", evidence: "#7650 没擦干净，蜡里全是渣" },
  { kind: "做法", page: "skills/木工/锯木头.md", text: "锯之前先用铅笔画线", evidence: "#7660" },
  { kind: "教训", page: "集市摆摊", text: "零钱要备足，一块的多换些", evidence: "#7602 上次找不开" },
  { kind: "做法", page: "工具墙怎么挂", text: "重的工具挂下面，常用的挂顺手的高度", evidence: "#7802 量墙的时候想到的" },
  // 只写了页号、没带 p: 的，书架上又没有这页（PAGES 里没有它的那一项）
  { kind: "教训", page: "20517", text: "刷漆前先在边角料上试色", evidence: "#7810 直接刷了，颜色深了一档" },
];
const SHARPEN_PAGE: CheckPage = { path: "skills/木工/磨刨刀.md", text: "# 磨刨刀\n\n- 先粗磨，再细磨。\n", full: true };
const PAGES: Array<CheckPage | null> = [
  SHARPEN_PAGE,
  null,
  SHARPEN_PAGE,
  null,
  { path: "skills/木工/上蜡.md", text: "# 上蜡\n\n- 薄涂两遍，每遍隔一天", full: false },
  { path: "skills/木工/锯木头.md", text: "", full: false },
  null,
];

/** 把关的结论：收（给了改写的、没给的）、并进（点了哪条的、没点的）、不收（写了理由的、没写的）、没看完；标题一条超 40 字、一条正好 40 字 */
const ADD_REWRITTEN: CheckEntry = {
  i: 1, kind: "做法", page: "skills/木工/磨刨刀.md",
  text: "磨刨刀先粗磨后细磨，\n最后在皮革上蹭几下，再用一张纸试刀口，能顺滑地削下纸条才算磨好了",
  verdict: "add", into: null, finalText: "磨刨刀：先粗磨、再细磨，最后在皮革上蹭几下；用纸试刀口，能削下纸条才算好。", why: "有 #7480 老林教的原话",
};
const ADD_AS_IS: CheckEntry = {
  i: 2, kind: "教训", page: "p:20481", text: "量含水率要在板子两头和中间各量一处，三处取平均，差得多的那块木板先放一边别急着用",
  verdict: "add", into: null, finalText: null, why: "#7520 裂了的那块就是教训",
};
const MERGE_INTO: CheckEntry = {
  i: 3, kind: "做法", page: "skills/木工/磨刨刀.md", text: "磨完用一张纸试刀口",
  verdict: "merge", into: "「先粗磨，再细磨。」", finalText: "先粗磨，再细磨；磨完用一张纸试刀口。", why: "和已有的一条是一回事",
};
const MERGE_SOMEWHERE: CheckEntry = {
  i: 4, kind: "教训", page: "skills/木工/上蜡.md", text: "上蜡前先把木屑擦干净",
  verdict: "merge", into: null, finalText: "上蜡前先把木屑擦干净，薄涂两遍。", why: null,
};
const REJECT_WHY: CheckEntry = {
  i: 5, kind: "做法", page: "集市摆摊", text: "摊位要提前一天订",
  verdict: "reject", into: null, finalText: null, why: "是小禾说的，我自己没做过",
};
const REJECT_SILENT: CheckEntry = {
  i: 6, kind: "做法", page: "skills/木工/锯木头.md", text: "锯之前先用铅笔画线",
  verdict: "reject", into: null, finalText: null, why: null,
};
const OPEN_SHORT: CheckEntry = {
  i: 7, kind: "教训", page: "集市摆摊", text: "零钱要备足",
  verdict: "unchecked", into: null, finalText: null, why: null,
};
const OPEN_LONG: CheckEntry = {
  i: 8, kind: "做法", page: "skills/木工/刨木头.md", text: "刨之前看清木纹的走向，顺着纹刨，\t逆着刨会起毛刺，起了毛刺就换个方向再刨一遍",
  verdict: "unchecked", into: null, finalText: null, why: null,
};

// ---- 从世界的名单里算的参数：照 Brain.fromChannel 认人那样（同一份 People、relationOf），真快照上就是真名字、真关系 ----

/**
 * 名单里第一个认得出的主人（owner=true）、或第一个认得出的不是主人的人发来消息时 inboundTrigger 拿到的参数：from 是 People 认出来的名字，relation 是 relationOf；
 * profile 是名单上写的档案（Brain 会先找事件库里导出的人物卡，那一步是它私有的，这里不照搬），card 照 Brain 的 triggerWho 算；
 * 回复地址取 targetFor 认得的第一个渠道（QQ、WhatsApp），都不认得就没有（inboundTrigger 只看渠道，不看发给谁）。
 * 「认得出」= 拿它自己的第一个号（或会话）去 identify，认出来的就是它：没写号的、号跟别人撞了的跳过，往下找，真名单上这条路也钉得住；一个都没有才抛
 */
function inboundFromRegistry(w: World, owner: boolean): Parameters<typeof P.inboundTrigger> {
  const people = w.brain.currentPeople();
  const who = owner ? "owner" : "non-owner";
  const records = Object.entries(people.registry).filter((kv): kv is [string, { privacy?: unknown; senders?: unknown; sessionKeys?: unknown }] =>
    !kv[0].startsWith("_") && typeof kv[1] === "object" && kv[1] !== null && !Array.isArray(kv[1]) && ((kv[1] as { privacy?: unknown }).privacy === "owner") === owner);
  if (!records.length) throw new Error(`the registry has no ${who} record`);
  const first = (v: unknown): string | undefined => (Array.isArray(v) ? v.find((x): x is string => typeof x === "string" && x !== "") : undefined);
  const person = records
    .map(([key, e]) => ({ key, p: people.identify(first(e.senders), first(e.sessionKeys)) }))
    .find(({ key, p }) => p?.key === key)?.p;
  if (!person) throw new Error(`no ${who} record of the registry is identified by its own senders / sessionKeys`);
  const channel = ["qqbot", "whatsapp"].find((c) => people.targetFor(person.name, c) !== null);
  const reply = channel ? { channel, target: people.targetFor(person.name, channel) ?? "" } : undefined;
  return [person.name, reply, {
    relation: relationOf(person),
    ...(person.profile ? { profile: person.profile } : {}),
    ...(person.profile?.startsWith(`${CARD_DIR}/`) ? { card: true } : {}),
    owner,
  }];
}

// ---- src/lang/zh/prompts.ts 的函数导出，照文件里的先后 ----

export const PROMPT_FIXTURES = {
  // cut 和 idle 两头各取一次
  mainTaskContinue: [["把三期的剪辑粗剪出来", false, false], ["整理小禾问的那几个书单", true, false], ["给老林写周报的第二节", false, true], ["把相册里重复的截图挑出来删掉", true, true]],
  mainTaskWaiting: [["等帮手把字幕对齐以后接着剪"]],
  focusQuotaTight: [[96.6, 20], [90.2, 45]],
  // 四种渠道写法（没有回复地址、QQ、WhatsApp、别的照原样）；主人（没写关系）和别人；人物卡、旧档案、没档案。
  // 接着 relationOf 的四种关系各一组（主人、信任的访客、访客、陌生人；用树自己的 relationOf 算，名字只用中性的，哪份快照上都一样）：
  // 这几句里有写死的主人名字，生产上每条来消息都会拼进去。
  // 最后两组从名单算：第一个认得出的主人（「是不是主人」那一下在真快照上按真名字判）、第一个认得出的访客
  // relationOf 的字里有主人的名字（语言包里是占位，世界建好才绑上）：带它的几组写成函数，用的时候才算
  inboundTrigger: [
    ["老林"],
    ["小禾", { channel: "qqbot", target: "qqbot:c2c:guest-0002", messageId: "m-0042" }, { relation: "老林的邻居，常来借工具", profile: "memory/people/cards/xiaohe.md", card: true }],
    ["老林", { channel: "qqbot", target: "qq:owner-0001" }, { profile: "memory/people/laolin.md" }],
    ["小禾", { channel: "whatsapp", target: "+00 000 0002" }, { relation: "一起逛集市的朋友" }],
    ["小禾", { channel: "telegram", target: "tg:guest-0002" }, { relation: "老林的邻居", profile: "memory/people/xiaohe.md", card: false }],
    // a tell to a role connected to no channel: the reply is printed back on this machine
    ["老林", { channel: "local", target: "老林" }],
    () => ["老林", { channel: "whatsapp", target: "+00 000 0001" }, { relation: relationOf({ key: "laolin", name: "老林", privacy: "owner" }), owner: true }],
    () => ["小禾", { channel: "qqbot", target: "qqbot:c2c:guest-0002" }, { relation: relationOf({ key: "xiaohe", name: "小禾", privacy: "guest", trust: "trusted" }) }],
    () => ["小禾", { channel: "whatsapp", target: "+00 000 0002" }, { relation: relationOf({ key: "xiaohe", name: "小禾", privacy: "guest" }) }],
    () => ["陌生人（qq:stranger-0009）", { channel: "qqbot", target: "qqbot:c2c:stranger-0009" }, { relation: relationOf(null) }],
    (w) => inboundFromRegistry(w, true),
    (w) => inboundFromRegistry(w, false),
  ],
  // 前面已经送到她眼前的那条再叫醒时的开头（11-13 回两遍）：主人、带人物卡的访客；「上一轮那段没发给他」那个分支；空白折成一个、长的截到 60 字加省略号；没有回复地址（不写渠道）
  inboundTriggerShown: [
    ["老林", { channel: "whatsapp", target: "+00 000 0001" }, {}, "我在给你升级"],
    ["小禾", { channel: "whatsapp", target: "+00 000 0002" }, { relation: "老林的邻居，常来借工具", profile: "memory/people/cards/xiaohe.md", card: true }, "好\n\n  那你忙", true],
    ["老林", { channel: "qqbot", target: "qq:owner-0001" }, { profile: "memory/people/laolin.md" }, "长".repeat(70), false],
    ["老林", undefined, {}, "没有回复地址的"],
  ],
  // 兜底那句：真人消息排到了她手上那一轮后面
  mergedSaid: [["老林"], ["小禾"]],
  // 不到一分钟、几分钟（四舍五入）、几小时几分、整几小时；估了、没估、估的是 0
  sideNotStarted: [["读一卷古书"]],
  sideNotOpened: [["剪片子的第二段"]],
  sideRefused: [["把一件旧事理清写成稿", "阿树"], ["读一份长报告", "主人"]],
  sideRefusedNote: [["把一件旧事理清写成稿"]],
  finishedAfter: [[30 * SEC, null], [25 * MIN + 35 * SEC, 20], [2 * HOUR + 15 * MIN, 90], [3 * HOUR, 0]],
  writeDownNow: [[["刨刀怎么磨", "木料含水率怎么量", "集市摊位怎么订"]], [[]]],
  newGround: [["木工入门怎么学", "notes/基础/入门/木工入门怎么学.md"]],
  quotaTight: [[97.5], [88.4]],
  similarOnIt: [
    [DRAWERS, 35, null],
    [DRAWERS, 50, "抽屉滑轨还没装，左边那条要先打磨两遍再上蜡，右边那条尺寸量错了要重新锯，装好以后还得试推二十次看卡不卡，最后把螺丝都拧紧并补一层清漆"],
  ],
  barNeedsWhy: [["- 三个抽屉都能顺滑推拉\n- 每个抽屉内壁都打磨过\n- 拍照发给老林确认"]],
  barChanged: [[DRAWERS, "老林说两个抽屉就够，第三个位置要放工具箱", "- 两个抽屉都能顺滑推拉\n- 右侧留出放工具箱的空位"]],
  lookedShort: [["右边抽屉还卡，滑轨没上蜡"]],
  lookedMet: [["两个抽屉都试推了二十次，照片在 notes/抽屉.jpg"]],
  helpersStillRunning: [[["量尺寸的帮手", "画图纸的帮手"]], [[]]],
  lookedMetMine: [["整理工具墙", "每样工具都挂回了原位，标签也贴了"]],
  lookedStuck: [["要等老林决定用樟木还是松木，别的都做完了"]],
  lookedNotStuck: [["松木的价钱自己就能查，查完可以先报给老林"]],
  keepGoing: [[DRAWERS, "右边抽屉还卡"], [STALL, "摊位费自己能查", true]],
  parked: [[STALL, "老林拍板摊位大小", "能比的三家都比过了，价钱记在 notes/集市.md"], [STALL, "老林拍板摊位大小", ""]],
  shelved: [["修院子的篱笆", "缺一把合适的锯子"]],
  stuckOnBar: [["做一把小板凳", 140, 3, "凳面还不平，四条腿长短差两毫米", "老林"], ["做一把小板凳", 25, 0, "凳腿还没装", "小禾"]],
  unreadNotes: [[["磨刨刀", "给木头上蜡"]], [[]]],
  // 理由去掉句末标点（几个连着的也去）；没写理由、只有标点的给默认那句
  wordsHeld: [
    [[{ word: "赋能", reason: "太像公文了；。" }, { word: "闭环", reason: "" }, { word: "抓手", reason: "！！" }]],
    [[{ word: "亲", reason: "老林不喜欢这么叫" }]],
  ],
  wordsUsed: [
    ["老林", [{ word: "赋能", reason: "太像公文了。" }, { word: "闭环", reason: "" }]],
    ["小禾", [{ word: "亲", reason: "听着假，" }]],
  ],
  wordsUsedHint: [[[{ word: "赋能", reason: "太像公文了。" }, { word: "闭环", reason: "" }]]],
  // 三种（没发出去、拿不准、先没发）各有和没有；气泡压空白、40 字以内不截、41 字起截
  replyNotAllSentHere: [
    ["老林", { notSent: [BUBBLE_LONG, "好嘞"], unsure: [BUBBLE_41], withheld: [BUBBLE_40, "还有一件事"] }],
    ["小禾", { notSent: ["周三早上七点开门"], unsure: [], withheld: [] }],
    ["老林", { notSent: [], unsure: ["木料我收好了  \n  盖了油布"], withheld: [] }],
    ["小禾", { notSent: [], unsure: [], withheld: ["卷尺不急着还"] }],
  ],
  replyNotAllSentElsewhere: [
    [{ who: "小禾", channel: "qqbot", target: "group:carpentry-0003", group: true, notSent: [BUBBLE_LONG], unsure: ["好嘞"], withheld: [] }],
    [{ who: "老林", channel: "whatsapp", target: "+00 000 0001", notSent: [], unsure: [], withheld: [BUBBLE_41, "等我十分钟"] }],
    [{ who: "小禾", channel: "whatsapp", target: "+00 000 0002", group: false, notSent: [], unsure: [], withheld: [] }],
  ],
  // 谁要做的四种（有原话有人、有原话没人、没原话有人、自己的）；估没估、跟进、卡住（给了、null、没写）、上次还差、笔记、聊天（有、只有空白、没有）、记录空不空
  lookAgain: [
    [{
      topic: DRAWERS, ask: "工作台下面加三个抽屉，放凿子和砂纸", askedBy: "老林", bar: "- 三个抽屉都能顺滑推拉\n- 内壁打磨过\n- 拍照给老林看",
      aboutMin: 60, ms: HOUR + 5 * MIN + 20 * SEC, follow: true, stuckOn: "老林决定把手用铜的还是木的", missing: "右边抽屉还卡",
      record: "#7480 量尺寸 → 记进 notes/抽屉.md\n#7481 锯板子（三块）\n#7490 装滑轨：右边卡",
      notes: "- 装滑轨前先上蜡（L-12）\n- 拍照要在白天拍", chat: "  老林：抽屉要深一点\n阿青：好，加深两厘米\n老林：第三个不要了  \n",
    }],
    [{ topic: STALL, ask: "帮我看看周三集市的摊位", askedBy: null, bar: "- 比过三家\n- 价钱写清楚", aboutMin: null, ms: 45 * SEC, follow: false, missing: null, record: "" }],
    [{
      topic: "给小禾修卷尺", ask: null, askedBy: "小禾", bar: "- 卷尺能收回去", aboutMin: 15, ms: 40 * MIN, follow: false, stuckOn: null,
      missing: "卷尺弹簧还没换", record: "#7701 拆开卷尺看了弹簧", chat: "   \n  ",
    }],
    [{
      topic: "整理工具墙", ask: null, askedBy: null, bar: "- 每样工具都挂回原位\n- 贴好标签", aboutMin: 0, ms: 2 * HOUR, follow: true,
      stuckOn: "等新的挂钩寄到", missing: null, record: "#7801 拆下旧挂钩\n#7802 量墙", notes: "- 挂钩要买承重五公斤的",
      chat: "小禾：挂钩我家有多的\n老林：先用小禾的",
    }],
  ],
  backgroundDone: [[DRAWERS]],
  askSomeone: [["要问老林：抽屉把手要铜的还是木的"]],
  // 一条（去空白、去句末句号）、几条（编号）、一条都没有
  urgentNotes: [[["  集市明早七点就开门，要提前去占位。 "]], [[" 木料棚漏雨了。", "小禾说明天来借刨子.", "油布不够了"]], [[]]],
  remindLooksDone: [["09:12", "09:40", ["scripts/water_plants.sh", "scripts/check_wood.py"]], ["14:05", "14:05", ["scripts/check_wood.py"]]],
  mullOver: [["樟木和松木哪个更适合做抽屉，得把含水率和价钱都比一比"]],
  senseGlance: [[]],
  thinkItOver: [["小禾在群里问周三集市几点开（#9120，id e-77）"]],
  senseTrigger: [[]],
  senseSeen: [[1], [3]],
  handsTrigger: [[]],
  compactPrompt: [[1800]],
  compactForkPrompt: [[1200], [1500, { boundary: "老林：今天下雨", gap: true }], [1800, { boundary: null, gap: true }], [2000, { boundary: "收好了，顺手盖了块布" }]],
  // 没有条目（0）；小节标题断开、缩进的子条借上一组的编号、标题下面直接缩进的自成一组、缩进的非条目行不算、tab 缩进、空行（3/4）；
  // 最外层本身是缩进的（2/3）
  refCoverage: [
    ["今天没什么事。\n明天去集市。"],
    [
      "**木工房**\n- 量了木料的含水率（#7480–#7613）\n  - 窗边那堆最干\n  - 门口那堆还湿（#7620）\n- 约了老林周三去集市\n  - 带上刨子\n\n" +
      "**琐事**\n  - 小禾借走了卷尺（#7701）\n  补一句没有横杠的缩进行（#7702）\n- 茶叶快喝完了\n\t- 用 tab 缩进的子条（#7800）",
    ],
    ["### 上午\n  - 刨了两块板（#8001）\n    - 一块有节疤\n### 下午\n    - 磨刀（#8002）\n  - 扫地"],
  ],
  // 正好八成（收）、七成五（不收）、没有条目（不收）
  blockHasRefs: [
    ["- 一（#1）\n- 二（#2）\n- 三（#3）\n- 四（#4）\n- 等老林回话"],
    ["- 一（#1）\n  - 子条（#2）\n- 二\n- 三（#3）\n- 四（#4）"],
    ["只有一段话，没有条目。"],
  ],
  // 前两组：角色自己的那几样照世界里的配置算（真快照上是真角色的值，渲染出来要和搬之前逐字一样）；后面是编的值和全空的（每一段出和不出）
  nightOrganize: [
    (w) => ["到点了", false, nightGuide(w.cfg, w.cfg.sleep.home || homedir())],
    (w) => ["今天累了，早点睡", true, nightGuide(w.cfg, w.cfg.sleep.home || homedir())],
    ["到点了", true, NIGHT_GUIDE], ["到点了", true, {}], ["今天累了，早点睡"],
  ],
  nightContinue: [(w) => [DAY, nightGuide(w.cfg, w.cfg.sleep.home || homedir())], [DAY, NIGHT_GUIDE], ["2031-02-03"]],
  nightRestNote: [["07:30", "consolidated"], ["07:30", "deferred"], ["07:30", "failed"]],
  checkAsk: [[CASES, PAGES], [[], []]],
  checked: [
    [DAY, [ADD_REWRITTEN, OPEN_SHORT, ADD_AS_IS, MERGE_INTO, MERGE_SOMEWHERE, REJECT_WHY, OPEN_LONG, REJECT_SILENT]],
    [DAY, [MERGE_INTO, REJECT_WHY]],
    [DAY, [OPEN_LONG]],
    [DAY, []],
  ],
  judgeSystem: [[{ me: "阿青", owner: "老林" }]],
  // 喜欢 / 以前喜欢过 / 烦 / 以前烦过；书名号的不再套引号；最近一下（有、null、没写）
  recognized: [
    [{ seen: "集市上看到一摊卖《木工入门》的旧书", state: "喜欢中", name: "《木工入门》", id: "like-3", like: true, last: { day: "10-28", gist: "翻到讲榫卯的那章看了一下午" } }],
    [{ seen: "收音机里放刨花声的白噪音", state: "腻了", name: "刨花声白噪音", id: "like-7", like: true, last: null }],
    [{ seen: "隔壁又在半夜锯木头", state: "烦着", name: "半夜锯木头的声音", id: "dislike-2", like: false }],
    [{ seen: "小禾又发来那首《雨天小曲》", state: "不烦了", name: "《雨天小曲》", id: "dislike-5", like: false, last: { day: "10-20", gist: "听多了也还行" } }],
  ],
  SLEEP_AUDIT: [[STAGE_RECORD, DIFF_TEXT]],
  SLEEP_STAGE_WAKE: [
    [SKILL_PAGE, MATERIAL, UPSTREAM, { day: DAY, proposed: "sleep/2026-10-31/proposed" }],
    [SKILL_PAGE, "  \n ", "\n", { day: "2026-10-30", proposed: "sleep/2026-10-30/proposed" }],
  ],
  SLEEP_STAGE_REDO: [[PROBLEMS], [[]]],
  SLEEP_PERSONA_DO: [["细心的阿青", "一条条对原话，宁可慢也不漏。"]],
  SLEEP_PERSONA_REVIEW: [["挑剔的阿青", "专找说法和原话对不上的地方。"]],
  // 上一次的改动撤了（给 changes 和 diff）、还留着、上一次没交
  SLEEP_STAGE_FIX: [
    [PROBLEMS, "细心的阿青", { changes: "- memory/people/xiaohe.md：加了借卷尺那条（#7701）", diff: DIFF_TEXT }],
    [PROBLEMS, "细心的阿青", "kept"],
    [[], "挑剔的阿青", null],
  ],
  SLEEP_REVIEW: [
    [{ reviewer: { name: "挑剔的阿青", text: "专找说法和原话对不上的地方。" }, doer: "细心的阿青", title: "人物近况", attempt: 2, page: SKILL_PAGE, record: STAGE_RECORD, diff: DIFF_TEXT }],
    [{ reviewer: { name: "挑剔的阿青", text: "专找说法和原话对不上的地方。" }, doer: null, title: "事件", attempt: 1, page: " \n ", record: { status: "nothing", report: "" }, diff: "" }],
  ],
  SLEEP_COORD_ROLE: [[{ name: "稳当的阿青", text: "看全局、不抠字眼，拿不准就推迟。" }], [null, false], [null, true]],
  // 脑区、谁做的有没有；花费（小数取两位、去掉末尾的 0）有没有；写过事件库（几条、0、没写）；报告超 400 字截断、只有空白、短的；验证几条、一条没有
  SLEEP_COORD_BRIEF: [
    [{
      day: DAY, title: "人物近况", region: "hippocampus", doer: "细心的阿青", attempt: 2, roundsLeft: 1,
      checks: [{ name: "改动对得上", result: "过" }, { name: "出题", result: "没过：第 3 处没出题" }], changes: 5,
      report: `  \n${"把木料按长短分好堆，量了每一块的含水率，记在账本第三页。".repeat(16)}\n  `,
      spent: { pct: 3.14159, targetPct: 5.5 }, memOps: 7,
    }],
    [{ day: DAY, title: "事件", region: null, doer: null, attempt: 1, roundsLeft: 2, checks: [], changes: 0, report: "   " }],
    [{
      day: DAY, title: "笔记", region: "side-1", doer: null, attempt: 3, roundsLeft: 0, checks: [{ name: "格式", result: "过" }], changes: 2,
      report: "只改了两处措辞。", spent: { pct: 12, targetPct: 0.125 }, memOps: 0,
    }],
  ],
  SLEEP_STAGE_NEAR_BUDGET: [[64, 80]],
  SLEEP_STAGE_BOUNCED: [[PROBLEMS, 2, ["memory/people/xiaohe.md", "e-102"]], [["changes 里少了 notes/集市.md"], 0, []]],
  SLEEP_STAGE_BOUNCED_AGAIN: [[PROBLEMS], [PROBLEMS, ["memory/people/xiaohe.md", "e-102"]]],
  SLEEP_QUESTIONS_TAKEN: [[3, ["q-1", "q-2", "q-3"], ["第 4 道出处查不到", "第 5 道标签全是空的"]], [1, ["q-7"], []]],
  SLEEP_QUESTION_OPS: [[2]],
  SLEEP_QUESTIONS_SHORT: [[3]],
  QUESTION_REFUSED: {
    noSource: [[["#7480", "q-20261031-2", "notes/集市.md:12"]], [[]]],
    full: [[12]],
    notNamed: [[["memory/people/xiaohe.md", "e-102"]], [[]]],
  },
  SLEEP_OLD_QUESTIONS: [[QUESTIONS], [[]]],
  SLEEP_LIVE_BEFORE: [["人物近况", "整理前的拷贝没拷成"]],
  EXAM_READ_HIDDEN: [["sleep/2026-10-31/proposed/memory/people/xiaohe.md"]],
  EXAM_NO_CUTS: [["memory/people/xiaohe.md"]],
  EXAM_FULL_CUTS: [["memory/people/xiaohe.md", 12]],
  EXAM_BEFORE_ASSUMED: [["整理前的事件库没拷成"]],
  EXAM_PREVIEW_FAILED_BEFORE: [["ledger/SOUL.md 读不出来"]],
  EXAM_MEMORY_FAILED: [["事件库打不开"]],
  EXAM_APPENDIX_CUT: [[6000]],
  EXAM_PREVIEW_FAILED: [["人格文件缺了 SOUL.md"]],
  // 常驻（不能查）、查得到（带附录、不带）、只在仓库（给了附录也不放）；题目几道、一道、没有
  EXAM_SITTER: [
    ["resident", INJECTION, QUESTIONS],
    ["searchable", INJECTION, QUESTIONS, APPENDIX],
    ["searchable", INJECTION, [Q_SEARCHABLE]],
    ["archive", INJECTION, [], APPENDIX],
  ],
  EXAM_GRADER: [
    [[{ q: Q_RESIDENT, answer: "卷尺，周三前还" }, { q: Q_ARCHIVE, answer: "去过，是周四去的" }], QUESTIONS],
    [[{ q: Q_SEARCHABLE, answer: "不记得" }], []],
  ],
  EXAM_HIDDEN_SETTER: [[MATERIAL, BEFORE, 4], ["  ", BEFORE, 2]],
  browserPortTaken: [[19123]],
} satisfies PromptFixtures;

// ---- 人格前缀（src/persona/persona.ts） ----

/** runtimeNote、languageLine 各调一次的 language */
export const LANGUAGES: readonly string[] = ["", "中文"];

/**
 * 账本快照：dropThreadTiers 要去掉的每一种行都有——三种旧事件线小节（连同下面的 #### 小标题和正文，下一个 ## 标题才停）、
 * 「他最近 3 天直接说的」「他最近3天说的」和紧跟着的带日期条目、窗口说明那句、前后带空白的「最近没有事件线有进展」；
 * 也有该留下的：不跟在那句后面的带日期条目。去掉以后连着的空行并成一个
 */
export const THREAD_TIERS_TEXT = [
  "# 账本",
  "",
  "- 下周三老林要去集市。",
  "",
  "## 人物近况",
  "",
  "### 老林",
  "- 他最近 3 天直接说的：",
  "  - 10-29 「木料别堆在门口」",
  "  - 10-30 「抽屉做深一点」",
  "- 他说过最多的是「慢慢来」。",
  "- 10-31 这条不跟在那句后面，留着。",
  "",
  "### 小禾",
  "- 他最近3天说的：",
  "- 10-30 「卷尺先借我」",
  "  （最近没有事件线有进展）  ",
  "",
  "## 事件线",
  "",
  "（最近 7 天的写得细，更早的只记个名；全文在 memory/threads/ 下面。）",
  "",
  "### 最近 7 天有进展的",
  "- 给工作台做抽屉：装好了两个",
  "#### 抽屉的细节",
  "- 滑轨上了蜡",
  "",
  "",
  "### 8–30 天前动过的",
  "- 修篱笆：缺一把锯子",
  "### 只记个名",
  "- 刨刀、卷尺",
  "",
  "## 还没完的",
  "- 订集市摊位",
  "",
].join("\n");

const IDENTITY: PersonaFile = { path: "IDENTITY.md", text: "# 我是谁\n\n我是阿青，住在老林木工房的一台电脑里。\n" };
const SOUL: PersonaFile = { path: "SOUL.md", text: "  # 性格\n\n说话直，爱喝茶，见不得木屑乱飞。\n\n" };
const PERSONA_FILES: PersonaFile[] = [
  IDENTITY,
  SOUL,
  { path: "USER.md", text: "# 老林\n\n老林是我的主人，做木工，起得早。\n" },
  { path: "MEMORY.md", text: "# 记着的事\n\n- 老林的工作台在窗边。\n- 小禾借东西总会还。\n" },
  { path: "AGENTS.md", text: "# 怎么做事\n\n先想清楚再动手，做完对一遍。\n" },
  { path: "SOUL.memory.md", text: "\n# 长期记忆\n\n- 小禾是老林的邻居。\n- 老林不喜欢别人叫他「亲」。\n" },
  { path: "ledger/SOUL.md", text: THREAD_TIERS_TEXT },
];
/** 带记忆文件的人格（账本快照就是上面那段） */
const PERSONA = new Persona("aqing", PERSONA_FILES);
/** 没有记忆文件的人格：没中期、没压缩块时前缀里就没有「你的人生」那一节 */
const PERSONA_SELF_ONLY = new Persona("aqing", [IDENTITY, SOUL]);

const BLOCK_MORNING: Block = { id: 41, text: "\n**上午**\n- 量了木料的含水率，窗边那堆最干（#7480–#7613）\n", tokens: 36, created: Date.UTC(2026, 9, 31, 2) };
const BLOCK_AFTERNOON: Block = {
  id: 42, text: "- 给工作台装了两个抽屉，右边那个还卡（#7620–#7700）\n- 小禾借走了卷尺（#7701）", tokens: 40, created: Date.UTC(2026, 9, 31, 8),
};
const MIDTERM = "\n## 最近这一段（事件库）\n\n- 10-31 小禾借走卷尺（e-102）\n- 10-30 老林让抽屉做深一点（e-98）\n\n";
const SHELF = "  # 书架目录\n\n- skills/木工/磨刨刀.md：磨刨刀的做法\n- skills/木工/上蜡.md：上蜡的做法\n  ";

/** buildPrefix 的几组参数：什么都不加；中期、书架、两段压缩块、语言都有；中期和书架只有空白、一段压缩块；没有记忆文件、只有书架 */
export const PREFIX_CALLS: ReadonlyArray<Parameters<typeof buildPrefix>> = [
  [PERSONA, []],
  [PERSONA, [BLOCK_MORNING, BLOCK_AFTERNOON], { midterm: MIDTERM, shelf: SHELF, language: "中文" }],
  [PERSONA, [BLOCK_AFTERNOON], { midterm: " \n\t", shelf: "  \n" }],
  [PERSONA_SELF_ONLY, [], { shelf: SHELF }],
];
