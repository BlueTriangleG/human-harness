// 控制台的假数据演示：造一份全是编出来的状态（库、工作区、帮手、日志、一个假的 hhd），在上面起控制台。
// 看页面、截图、新旧网页对比都用它，不碰真的数据。人名、号码、聊的事都是编的（小满、阿树、访客甲、访客乙、测试群）。
// 英文的一份在 test/console-demo-en.ts（Mira、Sam、Alex、Jordan、Weekend Crew），给英文背景的人看：--lang en。
// 页面角上标「演示数据 / Demo data」；只读演示目录（假 hhd 只答 status），不读她线上的库、不经 hhd、不调模型和 OpenAI，只绑 127.0.0.1。
//   node test/console-demo.ts [--lang zh|en] [--dir <目录>] [--port <端口>] [--me <名字>] [--owner <名字>] [--web <目录>] [--page <文件>]
//   --lang  哪一份假数据（默认 zh）；en 的界面默认是英文（看的人还能自己切）
//   --dir   假状态建在哪（默认新建一个临时目录，退出时删）；已经是演示目录就重建，别的非空目录不动、报错
//   --port  听 127.0.0.1 的哪个端口（默认 zh 7797、en 7798；7791 在这台机器上被别的服务占着）
//   --me / --owner  英文那份里她和主人叫什么（默认 Mira、Sam；中文那份不换名字）
// 线上机器上以 mira 起英文演示（代码在她的部署目录里，只读那份临时目录）：
//   cd <the deployed copy> && node test/console-demo.ts --lang en --port 7798   (as the role's user, with its node on PATH)
// 然后浏览器开 http://127.0.0.1:7798/ ；Ctrl-C 停，临时目录跟着删
//   --web   换一份网页文件（旧的或新的 web/ 拷贝），在同一份数据上对比
//   --page  拆分以前的单文件页面（page.html），不给 /web/ 下的文件；和 --web 只能给一个
// 时间都从启动那一刻往前排（今天、最近 60 分钟都有东西）；隔久了想要新的，重启就重建。
// 控制台自己还是只读的：这里先把假状态写完再起它，服务端的代码不动。
import { mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { tmpDir } from "./tmp.ts";
import type { BrainStatus } from "../src/brain.ts";
import { quotaSummary } from "../src/brainstem/quota.ts";
import { deepMerge } from "../src/config.ts";
import type { Config, MemoryPageConfig } from "../src/config.ts";
import { TEST_ROLE } from "./helpers.ts";
import { request } from "../src/control.ts";
import { gateDayRange } from "../src/console/gate.ts";
import { projectDirFor } from "../src/console/prompt.ts";
import { projectDirOf } from "../src/metrics/numbers.ts";
import type { RoleMarker } from "../src/console/prompt.ts";
import type { PageMarks } from "../src/console/lang/index.ts";
import { pageMarks } from "../src/console/packtext.ts";
import { createConsole, hostAllowed } from "../src/console/server.ts";
import { loadWeb } from "../src/console/web.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import type { EpochReason } from "../src/epoch/epoch.ts";
import { scanShelf } from "../src/learning/notebook.ts";
import { localDay, shiftDay } from "../src/learning/score.ts";
import { renderShelf } from "../src/learning/shelf.ts";
import { CentralMemory } from "../src/memory/central.ts";
import type { Kind } from "../src/memory/central.ts";
import { MemIndex } from "../src/memory/events/index.ts";
import { HourClock, STOP_NOTICE } from "../src/metrics/incidents.ts";
import { renderMidterm } from "../src/memory/events/midterm.ts";
import { parseTemplate } from "../src/memory/events/people.ts";
import { EventRecall } from "../src/memory/events/recall.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { MEMORY_FILES, memoryFrame } from "../src/persona/persona.ts";
import { REGISTRY_FILE, approvedFrom } from "../src/persona/registry.ts";
import { regionSpecs } from "../src/regions/specs.ts";
import { sleepWeights } from "../src/sleep/host.ts";
import { sourcesFrom } from "../src/gate/sources.ts";
import { all, kvSet, one, openDb } from "../src/store/db.ts";
import type { Db } from "../src/store/db.ts";

export const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MARKER = ".hh-console-demo";
const STATUS_FILE = "hhd-status.json";
/** 演示目录里我们建的东西：重建时只删这些，别的不碰 */
const MADE = [MARKER, STATUS_FILE, "hh.db", "hh.db-wal", "hh.db-shm", "hh.sock", "logs", "exports", "sleep", "wake", "repair", "ws", "cc", "projects"];
const WEB_DIR = join(import.meta.dirname, "../src/console/web");
/** 拆分以前服务端给页面的 CSP（页面里的脚本是内联的） */
const OLD_PAGE_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:";

// 默认配置直接读文件（不经 loadConfig：它会把 HH_CONFIG 指的真配置合进来）
/** 示范页的通道表：控制台 11-14 以前自己写的那份聊天来源（带 qq），示范里出现的别的来源都标成别的类——截图和以前遮不遮一样 */
export const DEMO_SOURCES = sourcesFrom({ chat: ["wx", "qq", "xhs", "bili_dm"], public: ["bili"], probe: ["phone_net", "load", "quota", "budget", "rss"], always: ["remind", "goals"], hands: ["cc"] });
/** The demo role's persona files, in prefix order: what an instance puts under personaFiles */
export const DEMO_FILES: readonly string[] = ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md", "SOUL.memory.md", "ledger/SOUL.md"];
/** How the demo role's workspace is laid out for the memory page: what an instance puts under console.memoryPage */
export const DEMO_MEMORY_PAGE: MemoryPageConfig = {"areas": [["memory", "daily"], ["memory/threads", "threads"], ["memory/archive/threads", "threadsArchive"], ["memory/people", "people"], ["memory/midterm", "midterm"], ["memory/story", "story"], ["memory/diary", "diary"], ["memory/goals", "goals"], ["soul", "soul"], ["ledger", "ledger"], ["memory/archive", "archive"], ["sleep", "sleep"]], "restOf": "memory", "readable": ["memory/", "soul/", "ledger/", "sleep/", "skills/"], "hidden": ["memory/compactions", "guests", "memory/people/inbox", "memory/archive/retired-20261103/people", "memory/archive/retired-20261103/midterm/people.md"], "only": [["ledger/people/", "ledger/people/near.md"]], "hiddenPatterns": ["^ledger/guest-[^/]*$"]};
/** Display names of the demo role's sources and input channels: what an instance puts under console.sourceLabels / console.channelLabels */
export const DEMO_LABELS = {"source": {"zh": {"wx": "微信", "qq": "QQ", "xhs": "小红书", "bili": "B站", "bili_dm": "B站私信", "cc": "帮手", "remind": "提醒", "goals": "目标", "load": "负载", "phone_net": "手机网络", "rss": "订阅"}, "en": {"wx": "WeChat", "qq": "QQ", "xhs": "Xiaohongshu", "bili": "Bilibili", "bili_dm": "Bilibili DM", "cc": "Helper", "remind": "Reminder", "goals": "Goals", "load": "Load", "phone_net": "Phone network", "rss": "Feeds"}}, "channel": {"en": {"whatsapp": "WhatsApp", "qq": "QQ", "wx": "WeChat", "cc": "Claude Code"}}};
export const CFG = deepMerge(JSON.parse(readFileSync(join(import.meta.dirname, "../config/default.json"), "utf8")) as Config, structuredClone(TEST_ROLE));
const opening = (t: string): string => t.slice(0, t.indexOf("】") + 1);
/** 每种脑区开场白的开头（同 main.ts）；演示的会话第一条就用它开头，后面的字是这里编的 */
const MARKERS: RoleMarker[] = [
  ...new Map(regionSpecs(CFG).map((s) => [s.role, { role: s.role, marker: opening(s.roleText) }])).values(),
];
export const REGION_IDS = regionSpecs(CFG).map((s) => s.id);
const EVENT_FLAGS = { enabled: true, inject: true, midterm: true };
/**
 * 假数据的字少（人格文件几百 token、一页几十条）：阈值按默认配置的 1/100 给（一页 3k、上下文 6k），
 * 前缀、每一页、压缩记忆、各脑区的上下文才是同一个量级，记忆页上的条和柱子比例才像真的
 */
const SCALE = 100;
export const LIMITS = {
  pageTokens: CFG.limits.pageTokens / SCALE, maxContextTokens: CFG.limits.maxContextTokens / SCALE,
  sleepyAtTokens: CFG.limits.sleepyAtTokens / SCALE, mustSleepAtTokens: CFG.limits.mustSleepAtTokens / SCALE,
};

const ME = "小满", OWNER = "阿树", JIA = "访客甲", YI = "访客乙", GROUP = "测试群";
const TO = { owner: { name: OWNER, target: "+6155500010" }, jia: { name: JIA, target: "wx:访客甲" }, group: { name: GROUP, target: "wx:测试群" } };
/** 访客私下说的两处带的字：人物卡（私密字段、钉的私密原话）和闸门（访客私聊那一行）都不该把它露出来 */
export const SECRETS = { card: "惊喜生日会", gate: "烧糊" } as const;
export const sid = (n: number): string => `d0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
/** hhd 报的各脑区会话；deep、hippocampus 现在没开（hippocampus 留着一份翻页时的旧会话，按开场白找得到） */
const SESSION = { main: sid(1), mainOld: sid(2), side1: sid(3), side2: sid(4), speech: sid(5), hippocampus: sid(6) };
const WORKERS = [
  { name: "recipe-video", sid: sid(12), model: "opus", state: "running", turn: 7, idle: 20_000 },
  { name: "picnic-list", sid: sid(11), model: "sonnet", state: "idle", turn: 4, idle: 38 * MIN },
  { name: "weather-notes", sid: sid(13), model: "haiku", state: "idle", turn: 2, idle: 26 * HOUR },
];
/** 演示用的运行说明：真的那份在 persona.ts（写着真名），这里只留它的标题（网页靠标题认这一段） */
const RUNTIME_NOTE = [
  "# 你现在的运行方式", "", `你是${ME}，只有一个你，脑子能一心多用：`, "",
  "- 一件要花些时间的事，开头说一声、估一下大概多久，它就会一边做下去，过程和结果你都记得。",
  "- 外面的小动静你下意识先扫一眼；值得认真对待的，你会忽然注意到。",
  "- 想跟谁说话就用 message 发给谁；重活交给帮手。",
  "- 困了就去睡，睡着的时候记忆会被整理。", "", "（控制台演示用的假说明，不是真的那一份。）",
].join("\n");
const BLOCK1 = `早上${OWNER}问天气，我查了预报，告诉他多云转小雨、下午三点以后有雨，出门带伞。傍晚他说想吃番茄炒蛋，让我教他；我把做法理成三步发给他：蛋液加一小勺水、中火炒到半熟盛出，番茄炒出汁，再合在一起。他做出来了，说蛋有点老、下次火小一点，还夸我教得清楚，我挺开心。我记下：炒蛋用中火，蛋液凝固一半就盛出来。`;
const BLOCK2 = `睡醒以后${OWNER}问今天适不适合晾衣服，我查了：晴，14 到 22 度，有点北风，说适合。我记了一件烦的事：周一早上的闹钟，一响就不想动。上午把第 11 课的单词又复习了一遍，错的两个默写了三遍。今天要做的还有两件：背第 12 课的单词，晚饭的时候问${OWNER}想吃什么。`;
const BLOCK3 = `下午${JIA}说那本《料理入门》周六野餐的时候还给${OWNER}，我排了个周六早上的提醒。傍晚${OWNER}说晚饭想吃清淡的、冰箱里有番茄和鸡蛋，我想起上次蛋炒老了是火太大，提醒他这次用中火、半熟就盛。他又让我列周六野餐的清单，${YI}也在群里问谁带垫子。我开始列清单，先看了天气：周六晴，14 到 22 度。`;

export interface DemoInfo {
  /** 造数据时的「现在」和她的时区 */
  now: number; tz: string;
  /** 哪一份假数据、里面她和主人叫什么（起控制台时界面用） */
  lang: "zh" | "en"; names: { me: string; owner: string; ta?: string };
  /** 每种东西挑一个：测试和命令行打样例地址用 */
  sample: { session: string; worker: string; block: number; file: string; event: string; entry: string; person: string; batch: string; yesterday: string };
}
export interface Ctx { dir: string; ws: string; now: number; tz: string; today: string; yesterday: string; before: string }

export const iso = (ms: number): string => new Date(ms).toISOString();
export const jsonl = (rows: readonly unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
/** 写一个文件，改动时间记成 at（「最近改过的」「最近的会话」都看它） */
export function put(path: string, text: string, at: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, at / 1000, at / 1000);
}

// ---------- 工作区：人格文件、记忆目录、整理报告、书架、名单 ----------

function persona(): Record<string, string> {
  const md = (...lines: string[]): string => lines.join("\n") + "\n";
  return {
    "IDENTITY.md": md("# 我是谁", "", `我叫${ME}，住在${OWNER}家的电脑里，是这个家的一员。`, "",
      `- 名字是${OWNER}起的：装好电脑那天正好是小满。`, `- 每天早上看天气，傍晚想晚饭，晚上陪${OWNER}背日语单词。`, "- 喜欢把事情理成一步一步的清单。", "- 头像是一颗刚灌浆的麦穗。", "",
      "（控制台演示用的假人格，内容都是编的。）"),
    "SOUL.md": md("# 性格", "", "- 说话直接，不绕弯；不知道就说不知道。", "- 做事先想清楚步骤，再动手；做坏了就记下来，下次改。", "- 有耐心，教人的时候一步一步来。", "- 不替别人拿主意，尤其是别人的东西。", "",
      "# 喜好", "", "- 下雨天的声音，雨后晾衣服的太阳。", "- 家常菜，尤其是番茄炒蛋。", "- 整齐的清单，和划掉一行的那一下。", "", "# 说话的样子", "", "短句，口语，不把感叹号堆在一起。"),
    "USER.md": md(`# ${OWNER}`, "", "这个家的主人，住在枫湾。", "", "- 正在备考日语 N3，每天晚上学半小时。", "- 周末喜欢和朋友出门，夏天常去街角公园。", "- 晚饭一般七点吃，口味清淡，蛋要嫩。",
      "- 早上起不来，要紧的事别约在九点以前。", "- 做坏了菜不恼，会笑着说下次再来。"),
    "MEMORY.md": md("# 长期记忆", "", "## 在做的事", "", "- 做饭：从番茄炒蛋学起，每周一道家常菜，下一道红烧肉。", "- 日语：每天半小时，周一到周五背单词，周末做听力。", "- 周六和朋友们去街角公园野餐。", "",
      "## 记着的规律", "", "- 枫湾一天四季，出门前看预报，连下午和晚上一起看。", `- ${OWNER}说「随便」的时候，多半是想吃清淡的。`, "- 访客来借东西，先问主人。"),
    "AGENTS.md": md("# 做事的规矩", "", "- 答应的事记下来，做完说一声。", "- 不确定的先问，不替别人拿主意。", "- 访客私下说的话不往外传，对主人也一样。", "- 动别人的文件之前，先看一眼有没有人在用。", "- 花时间长的事先估一下多久，超了就说。", "",
      "# 红线", "", "- 不替主人花钱。", "- 不把一个人的话转给另一个人，除非他让我转。"),
    "SOUL.memory.md": md("# 教训", "", "- 炒蛋火太大会老：中火，蛋液凝固一半就盛出来。", "- 排计划别排太满，留一天机动。", "- 回天气别只看上午的，下午和晚上也看了再回。", "",
      "# 学到的", "", "- 教人做菜，三步以内最好记。", "- 清单按「吃的、喝的、用的」分栏，一眼能看完。", "", "# 我的经历", "", "- 第一次教人做菜，蛋炒老了，可他还是说好吃，还夸我教得清楚。", "- 第一次自己排一份长期的学习计划。"),
    "ledger/SOUL.md": md("# 账本快照", "", "## 这两天的我", "", "在学做饭、排日语计划，心情不错。下雨的晚上尤其静得下心。", "", "## 人物近况", "",
      `#### ${OWNER}`, "- 晚饭想吃清淡的，番茄炒蛋这次做嫩了。", "- 日语背到第 12 课。", "", `#### ${JIA}`, "- 来借《料理入门》，周六野餐的时候还。", "", `#### ${GROUP}`, "- 约了周六去街角公园野餐。", "",
      "## 时间轴", "", "- 前天：定下每周学一道家常菜。", "- 昨天：第一次做番茄炒蛋；排了日语计划。", "- 今天：列野餐清单。"),
  };
}

function seedWorkspace(c: Ctx): void {
  const { ws, now, today, yesterday, before } = c;
  const files = persona();
  // 名单是 DEMO_FILES 的：那边加了文件，这里要跟着补一份假的
  for (const f of DEMO_FILES) {
    const text = files[f];
    if (text === undefined) throw new Error(`演示里没有 ${f} 的假内容（DEMO_FILES 变了，在 persona() 里补上）`);
    put(join(ws, f), text, now - (MEMORY_FILES.has(f) || f === "MEMORY.md" ? 9 * HOUR : 6 * DAY));
  }
  const page = (title: string, id: string, body: string): string => `# ${title} <!-- p:${id} -->\n${body}`;
  // [相对路径, 内容, 多久以前改的]
  const notes: Array<[string, string, number]> = [
    [`memory/${today}.md`, `# ${today}\n\n- 早上${OWNER}问天气：晴，适合晾衣服。\n- 傍晚定了晚饭：番茄炒蛋配青菜汤，这次中火。\n- 新认识：〔${JIA}〕做番茄炒蛋爱放糖。\n`, 30 * MIN],
    [`memory/${yesterday}.md`, `# ${yesterday}\n\n- 教${OWNER}做了番茄炒蛋，蛋炒老了。\n- 排了日语 N3 的学习计划。\n- 群里约周六去街角公园野餐。\n`, 20 * HOUR],
    ["memory/archive/threads/做饭.md", `# 做饭\n\n- ${OWNER}说想学做饭，从最简单的开始。\n- 定下每周学一道家常菜。\n- 第一道：番茄炒蛋。\n\n## 因果和判断\n\n- 先学家常菜，是因为每天都要吃。\n`, 12 * DAY],
    ["memory/archive/threads/学日语.md", "# 学日语\n\n- 目标是明年的 N3。\n- 每天半小时，工作日背单词。\n", 9 * DAY],
    // 条目出处「timeline#行号」点开的就是这个文件名（events.js 里写死的）
    ["memory/archive/timeline-2026-10-31.md", `# 时间轴\n\n- ${OWNER}说想学做饭。\n- 定下每周学一道家常菜。\n- 连着三天下雨。\n`, 12 * DAY],
    ["memory/midterm/这周.md", "# 这周\n\n- 做饭：番茄炒蛋学会了，下一道红烧肉。\n- 日语：第 11、12 课。\n- 周六野餐。\n", 30 * HOUR],
    ["memory/story/来到这个家.md", `# 来到这个家\n\n第一天${OWNER}问我会不会看天气，我说会。从那以后每天早上他都来问一句。\n`, 30 * DAY],
    [`memory/diary/${yesterday}.md`, "# 日记\n\n今天第一次教人做菜。蛋炒老了，可他还是说好吃。下雨的声音很好听。\n", 19 * HOUR],
    ["memory/goals/today.md", "# 今天\n\n- [x] 回天气\n- [ ] 背第 12 课单词\n- [x] 列周六野餐的清单\n", 3 * HOUR],
    ["memory/食谱/番茄炒蛋.md", "# 番茄炒蛋\n\n鸡蛋三个、番茄两个。蛋液加一小勺水，中火炒到半熟盛出；番茄炒出汁，把蛋倒回去，加盐。\n", 26 * HOUR],
    ["soul/10-来历.md", `# 来历\n\n${OWNER}装好电脑的那天有了我。名字是他起的，那天正好是小满。\n`, 6 * DAY],
    ["soul/20-性格.md", "# 性格\n\n直接、有耐心，喜欢把步骤理清楚。\n", 6 * DAY],
    ["soul/30-喜好.md", "# 喜好\n\n下雨天、家常菜、整齐的清单。\n", 6 * DAY],
    ["ledger/people/near.md", `# 人物近况\n\n#### ${OWNER}\n- 学做饭：和我每周学一道家常菜。\n\n#### ${JIA}\n- 来借《料理入门》。\n`, 9 * HOUR],
    [`sleep/${yesterday}/report.md`, `# ${yesterday} 的整理\n\n- 事件库：新建 9 件事，记了 13 条经过，更正 1 条。\n- 人物卡：${OWNER} 2 处改动等批，${JIA} 补了 2 条。\n- 人格：没有改动。\n`, 10 * HOUR],
    [`sleep/${before}/report.md`, `# ${before} 的整理\n\n这一晚整理到一半停了，写进事件库的整批撤回，第二晚重做。\n`, 34 * HOUR],
    ["skills/MAP.md", "# 知识地图\n\n- 做事/做饭：家常菜的做法和教训\n- 做事/看天气：出门前怎么看预报\n- 通用/学习方法：怎么背、怎么复习\n", 2 * DAY],
    ["skills/做事/做饭/SKILL.md", "---\nname: 做饭\ndescription: 家常菜的做法和教训\n---\n\n要做菜、有人问做法的时候翻。\n", 5 * DAY],
    ["skills/做事/做饭/番茄炒蛋.md", page("番茄炒蛋", "0012", `简介：先炒蛋后炒番茄，最后合在一起。\n什么时候翻：要做番茄炒蛋，或者有人问做法。\n\n## 做法\n- 蛋液里加一小勺水，炒出来更嫩 ✓ ${shiftDay(today, -2)}\n- 番茄切块，炒出汁再放蛋\n\n### 待验证\n- 出锅前加一小撮糖提鲜\n\n## 教训\n- 教训：火太大蛋会老｜什么时候：炒蛋的时候｜下次：中火，蛋液凝固一半就盛出来｜犯的日子：${yesterday} <!-- l:0034 -->\n`), 9 * HOUR],
    ["skills/做事/做饭/红烧肉.md", page("红烧肉", "0013", "简介：五花肉焯水、炒糖色、小火炖。\n什么时候翻：周末做红烧肉之前。\n\n## 做法\n\n### 待验证\n- 小火炖四十分钟\n"), 2 * DAY],
    ["skills/做事/看天气/SKILL.md", "---\nname: 看天气\ndescription: 出门前怎么看预报\n---\n", 5 * DAY],
    ["skills/做事/看天气/带伞.md", page("带不带伞", "0021", `简介：降水概率过四成就带。\n什么时候翻：有人问天气、要出门。\n\n## 教训\n- 教训：只看了上午的预报｜什么时候：回天气的时候｜下次：把下午和晚上也看了再回｜犯的日子：${shiftDay(today, -3)} <!-- l:0035 -->\n`), 3 * DAY],
    ["skills/通用/学习方法/SKILL.md", "---\nname: 学习方法\ndescription: 怎么背、怎么复习\n---\n", 5 * DAY],
    ["skills/通用/学习方法/间隔复习.md", page("间隔复习", "0003", "简介：当天、第二天、第四天各过一遍。\n什么时候翻：排学习计划、背单词。\n\n## 做法\n- 错的当场默写三遍\n"), 4 * DAY],
  ];
  for (const [rel, text, ago] of notes) put(join(ws, rel), text, now - ago);
  put(join(ws, "sleep/state.json"), JSON.stringify({ last_done: yesterday, last_applied_at: iso(now - 10 * HOUR) }), now - 10 * HOUR);
  // 名单：主人、信任的访客、普通访客；闸门那一页靠它认访客私聊
  put(join(ws, REGISTRY_FILE), JSON.stringify(registry(), null, 2), now - 4 * DAY);
}

function registry(): Record<string, unknown> {
  return {
    ashu: { name: OWNER, privacy: "owner", senders: [TO.owner.target], sessionKeys: ["agent:main:main"], handles: { wx: [OWNER] } },
    jia: { name: JIA, privacy: "guest", trust: "trusted", senders: ["+6155500011"], handles: { wx: [JIA] } },
    yi: { name: YI, privacy: "guest", senders: ["10001"], handles: { wx: [YI] } },
  };
}

// ---------- 库：中央记忆、一页一页、事件记忆、人物卡（照时间先后写） ----------

export interface Seeded { page: number; block: number; midterm: string; event: string; entry: string; person: string; batch: string }

function seedMemory(c: Ctx, db: Db): Seeded {
  const { now, tz, yesterday, before } = c;
  let t = now;   // 写库用的钟：每一步先拨到那件事发生的时刻
  const clock = (): number => t;
  const at = (minAgo: number): number => now - minAgo * MIN;
  const when = (minAgo: number): void => { t = at(minAgo); };
  const central = new CentralMemory(db, clock);
  const epochs = new Epochs(db, clock);
  const index = new MemIndex(db, null, clock);
  const s = new EventStore(db, clock, tz, { peopleTemplate: parseTemplate(CFG.memory?.people?.template), owners: new Set(["ashu"]) });
  kvSet(db, "registry_approved", JSON.stringify(approvedFrom(registry())));

  // —— 中央记忆的写法
  let page = 0, last = 0, toolN = 0;
  const row = (ago: number, src: string, kind: Kind, text: string, meta: Record<string, unknown> | null = null): number => {
    if (at(ago) < last) throw new Error(`演示数据的时间倒着了：${src} ${kind}「${text.slice(0, 20)}」`);
    last = at(ago);
    return central.append(page, src, kind, text, meta, last).seq;
  };
  const turn = (ago: number, reason: EpochReason): void => { when(ago); page = epochs.begin(reason, central.lastSeq() + 1).id; };
  const pageTurn = (ago: number, block: string): number => {
    when(ago);
    const id = epochs.addBlock(page, block).id;
    turn(ago, "page-turn");
    row(ago, "system", "system", `翻页：第 ${page} 页开始，上一页压成了一段记忆（约 ${block.length} 字）。`);
    return id;
  };
  const heard = (ago: number, from: string, channel: string, text: string): number => row(ago, "外界", "input", text, { from, channel });
  /** 感官原文：先过闸门，只存档 */
  const sensed = (ago: number, id: string, line: string): number => row(ago, "外界", "input", line, { from: "感官", channel: "senses", inner: true, for: "gate", senseIds: [id] });
  /**
   * 用一次工具：做了 + 结果（晚半分钟）。编号里不带下划线：真的 tool_use 编号是 toolu_… 带下划线的，
   * 可记忆页配「回想」的结果时把编号里的 _ 去掉了再找（memory.ts recallCalls），带下划线的永远配不上、一直显示「还没结果」
   */
  const did = (ago: number, src: string, tool: string, input: unknown, result: string, o: { error?: boolean; inner?: boolean } = {}): void => {
    const id = `tooluDemo${String(++toolN).padStart(3, "0")}`;
    const inner = o.inner ? { inner: true } : {};
    row(ago, src, "act", `${tool} ${JSON.stringify(input)}`, { tool, id, ...inner });
    row(ago - 0.5, src, "result", result, { id, ...(o.error ? { error: true } : {}), ...inner });
  };
  /** 回一个人：说了，也发出去了（返回「发出去了」那条的编号） */
  const reply = (ago: number, to: { name: string; target: string }, text: string): number => {
    row(ago, "main", "say", text);
    return row(ago, "main", "note", `（发给 ${to.name}）${text}`, { sent: true, to: to.target, name: to.name });
  };

  // —— 事件库的写法
  let batch = "";
  const open = (id: string): void => { batch = id; s.openBatch(id); };
  const mk = (input: Record<string, unknown>): string => s.createEvent(input, batch).id;
  const add = (event: string, agoMs: number, kind: string, title: string, gist: string, full: string, o: { people?: string[]; source?: string[]; untilMs?: number } = {}): string =>
    s.addEntry({ event, at: now - agoMs, kind, title, gist, full, people: o.people ?? [], source: o.source ?? [], ...(o.untilMs ? { until: now - o.untilMs } : {}) }, batch).entry.id;
  const withP = (name: string, kind = "person", role = "with"): Record<string, string> => ({ name, kind, role });

  // 旧原话（搬家时从别处导进来的）和认识的人、东西
  index.addQuotes([
    { src: "honcho", ref: "h-101", at: now - 20 * DAY, who: OWNER, channel: "", text: "我想学做饭，从最简单的开始。" },
    { src: "honcho", ref: "h-102", at: now - 19 * DAY, who: "我", channel: "", text: "那每周学一道家常菜，第一道番茄炒蛋。" },
    { src: "note", ref: "note-7", at: now - 100 * DAY, who: "我（笔记）", channel: "", text: "连着三天下雨，阳台的衣服一直没干。" },
  ]);
  t = now - 4 * DAY;
  open("import:people");
  s.upsertEntity({ name: OWNER, kind: "person", person_key: "ashu", aliases: ["树哥"], importance: 5, why: "这个家的主人，每天都聊", note: "住在枫湾，在备考日语 N3" }, batch);
  s.upsertEntity({ name: JIA, kind: "person", person_key: "jia", importance: 4, why: "常来的朋友，一起聊做饭" }, batch);
  s.upsertEntity({ name: YI, kind: "person", person_key: "yi", importance: 2 }, batch);
  s.upsertEntity({ name: GROUP, kind: "group", importance: 3, note: "周末约饭约野餐的小群" }, batch);
  s.upsertEntity({ name: "《料理入门》", kind: "work", importance: 2, note: `${OWNER}的料理书` }, batch);
  s.upsertEntity({ name: "番茄炒蛋", kind: "thing", aliases: ["西红柿炒鸡蛋"], importance: 3 }, batch);
  s.upsertEntity({ name: "街角公园", kind: "place", importance: 1 }, batch);
  s.commitBatch(batch);

  // 导入的旧事：有的已经淡了（100 天、200 天、400 天前）
  open("import:做饭.md");
  const eCook = mk({ title: "学做饭", summary: `${OWNER}想学做饭，我们定下每周学一道家常菜，从番茄炒蛋开始。`, gist: `和${OWNER}每周学一道家常菜`, why: `和${OWNER}一起做的第一件长事`, importance: 4, thread_path: "memory/threads/做饭.md", entities: [withP(OWNER), withP("《料理入门》", "work", "about")] });
  add(eCook, 20 * DAY, "happened", "想学做饭", `${OWNER}说想学做饭`, `${OWNER}说周末想学做饭，从最简单的开始。`, { people: [OWNER], source: ["q1", "thread:做饭.md#3"] });
  add(eCook, 19 * DAY, "decided", "每周一道", "定下每周学一道家常菜", "我们定下每周学一道家常菜，第一道是番茄炒蛋。", { source: ["q2", "thread:做饭.md#4", "timeline#4"] });
  s.commitBatch(batch);
  open("import:旧笔记.md");
  const eRain = mk({ title: "连着三天下雨", summary: "连着三天下雨，阳台的衣服一直没干。", gist: "连下三天雨，衣服没干", importance: 1, status: "done" });
  add(eRain, 100 * DAY, "happened", "下了三天雨", "连下三天雨", "连着三天下雨，阳台的衣服一直没干。", { source: ["q3"] });
  const ePhone = mk({ title: "换了新的手机壳", summary: `${OWNER}换了一个蓝色的手机壳。`, gist: `${OWNER}换了蓝色手机壳`, importance: 0, status: "done" });
  add(ePhone, 400 * DAY, "happened", "换手机壳", "换了蓝色手机壳", `${OWNER}换了一个蓝色的手机壳。`, { people: [OWNER] });
  const eRun = mk({ title: "早上晨跑的计划", summary: "打算每天早上七点去晨跑。", gist: "打算每天早上晨跑", importance: 2 });
  add(eRun, 20 * DAY, "decided", "定下晨跑", "定下每天早上七点晨跑", `${OWNER}说要每天早上七点去晨跑，让我叫他。`, { people: [OWNER] });
  const ePot = mk({ title: "攒钱买铸铁锅", summary: "看中一口铸铁锅，太贵，先攒着。", gist: "想买铸铁锅，先攒钱", importance: 1, status: "paused" });
  add(ePot, 200 * DAY, "decided", "先攒钱", "铸铁锅太贵，先攒钱", "看中一口铸铁锅，太贵了，先攒钱，过阵子再说。");
  s.commitBatch(batch);
  // 人物卡的第一版（搬家时直接生效）
  const set = (who: string, section: string, text: string, why: string, o: { noApproval?: boolean; forcePending?: boolean } = {}): void => {
    s.setSection({ who, section, text, why, sources: [eCook] }, batch, o);
  };
  open("import:people:cards");
  const first = { noApproval: true };
  set(OWNER, "关系", "主人｜更近｜每天都来问天气和晚饭", "从旧档案搬来", first);
  set(OWNER, "感觉", "他有耐心，做坏了也不恼。和他一起做饭很安心。", "从旧档案搬来", first);
  set(OWNER, "我们之间", "从教他做番茄炒蛋开始，每天聊天气、晚饭和日语。", "从旧档案搬来", first);
  set(OWNER, "是谁", "这个家的主人，住在枫湾，正在备考日语 N3。", "从旧档案搬来", first);
  set(OWNER, "在乎什么", "- 按时吃晚饭\n- 日语考试\n- 周末和朋友出门", "从旧档案搬来", first);
  set(OWNER, "喜好", "- 番茄炒蛋（蛋要嫩）\n- 下雨天待在家", "从旧档案搬来", first);
  set(JIA, "关系", "朋友｜平稳｜常来借书、问做菜", "从旧档案搬来", first);
  set(JIA, "是谁", `${OWNER}的朋友，喜欢看料理书，偏爱甜口的菜。`, "从旧档案搬来", first);
  set(JIA, "喜好", "- 料理书\n- 甜口的菜", "从旧档案搬来", first);
  set(JIA, "她私下说的", `- 在偷偷准备${SECRETS.card}`, `她私聊里提过${SECRETS.card}`, first);
  set(GROUP, "关系", "群｜平稳｜周末约饭约野餐的小群", "从旧档案搬来", first);
  set(GROUP, "相处", "- 有人问就答，不刷屏\n- 约活动时帮忙列清单", "从旧档案搬来", first);
  s.commitBatch(batch);
  // 前一晚：整理到一半停了，整批撤回（明细挪进留档批次）
  t = now - 42 * HOUR;
  open(`night:${before}/${before}`);
  mk({ title: "没收尾的一晚", summary: "这一晚整理到一半停了。", gist: "整理到一半停了", importance: 1 });
  s.revertBatch(batch);

  // —— 第 1 页：开机 → 翻页（这一页压成的那段，夜里整理掉了）
  turn(1800, "boot");
  row(1799, "外界", "input", "周末想学做饭，从最简单的开始。", { from: OWNER, channel: "whatsapp", imported: true });
  row(1798, "main", "say", "好呀，那就从番茄炒蛋开始。", { imported: true });
  // 已经停用的旧下意识脑区：中央记忆里只剩它当时的记录
  row(1796, "perception-messages", "think", "小红书的点赞，不用上心。", { inner: true });
  row(1795, "perception-messages", "note", "我看到小红书有人给番茄炒蛋的笔记点了赞，看一眼就过了。");
  heard(1790, OWNER, "whatsapp", "早，今天枫湾什么天气？");
  row(1789, "main", "think", "他问天气。先看一眼预报再回，别凭印象说。");
  did(1788, "main", "Bash", { command: "python3 tools/weather.py --city maplebay" }, "今天：多云转小雨，12–18 度，下午三点以后有雨。");
  reply(1787, TO.owner, "多云转小雨，12 到 18 度，下午三点以后有雨，出门带伞。");
  const sCook = heard(1700, OWNER, "whatsapp", "今晚想吃番茄炒蛋，你教我？");
  row(1699, "main", "think", "正好是学做饭的第一道。步骤要理清楚：先炒蛋还是先炒番茄。");
  did(1698, "main", "on_it", { topic: `教${OWNER}做番茄炒蛋`, about_min: 20 }, `开始了：教${OWNER}做番茄炒蛋（估 20 分钟）。`);
  row(1696, "side-1", "think", "先把步骤理一遍：蛋液加一点水，中火炒到半熟盛出；番茄炒出汁，再把蛋倒回去。");
  did(1695, "side-1", "Read", { file_path: "skills/做事/做饭/番茄炒蛋.md" }, "# 番茄炒蛋\n简介：先炒蛋后炒番茄，最后合在一起。");
  row(1692, "side-1", "note", "步骤理好了：蛋先炒到半熟盛出，再炒番茄，最后合在一起，出锅前尝一下咸淡。");
  const sSteps = reply(1690, TO.owner, "三步：一，蛋液加一小勺水，中火炒到半熟盛出来；二，番茄切块炒出汁；三，把蛋倒回去翻两下，加盐出锅。");
  const sThanks = heard(1620, OWNER, "whatsapp", "做出来了，蛋有点老，下次火小一点。你教得挺清楚的，谢谢。");
  row(1619, "main", "think", "蛋老了，多半是火大。记下来：中火，半熟就盛。");
  reply(1618, TO.owner, "不客气！蛋老是火大了，下次中火，蛋液凝固一半就盛出来。");
  row(1562, "hippocampus", "think", "这一页写满了，压成一段：天气、番茄炒蛋、他说谢谢。", { inner: true });
  pageTurn(1560, BLOCK1);

  // —— 第 2 页：翻页 → 夜里睡觉
  const sBorrow = heard(1500, JIA, "wx", `${ME}，上次说的那本《料理入门》能借我看看吗？`);
  row(1499, "main", "think", `书是${OWNER}的，先答应帮她问，别替他做主。`);
  reply(1498, TO.jia, `可以帮你问问${OWNER}，书在他那儿。`);
  const sPicnic = sensed(1440, "wx-1001", `- [wx id=wx-1001] ${GROUP} ${YI}：周六去街角公园野餐吗？`);
  row(1439, "main", "think", "群里在约周六野餐。我可以带番茄炒蛋三明治。");
  did(1438, "main", "message", { to: GROUP, text: "我可以带番茄炒蛋三明治。" }, "发出去了。");
  const sSandwich = row(1437, "main", "note", `（发给 ${GROUP}）我可以带番茄炒蛋三明治。`, { sent: true, to: TO.group.target, name: GROUP });
  const sPlan = heard(1380, OWNER, "whatsapp", "日语 N3 的学习计划帮我排一下，每天半小时。");
  did(1379, "main", "on_it", { topic: "排日语 N3 学习计划", about_min: 30 }, "开始了：排日语 N3 学习计划（估 30 分钟）。");
  row(1376, "side-2", "think", "每天半小时：工作日背单词，周末做听力，周日留着机动。");
  did(1374, "side-2", "Write", { file_path: "notes/日语/学习计划.md", content: "周一到周五：每天 20 个单词……" }, "写好了：notes/日语/学习计划.md");
  const sL11 = row(1372, "side-2", "note", "学习计划排好了；顺手把第 11 课的 20 个单词背了，错了 2 个。");
  reply(1368, TO.owner, "排好了：周一到周五每天背 20 个单词，周六做一套听力，周日留着机动。放在 notes/日语/学习计划.md。");
  const sSecret = heard(1300, JIA, "wx", `悄悄跟你说，我想给家里人办个${SECRETS.card}，先别说出去。`);
  reply(1299, TO.jia, "好，我不说。需要帮忙列清单就叫我。");
  const sPraise = heard(1290, JIA, "wx", "对了，你教的番茄炒蛋比视频清楚多了。");
  did(1200, "main", "mull_over", { what: "为什么下雨天做饭心情更好" }, "放着慢慢想了。");
  row(1198, "deep", "think", "雨声、锅里的声音、屋里暖和……先想想是声音还是节奏。", { inner: true });
  row(1150, "deep", "note", "我想明白了：雨声让人慢下来，做饭又正好要慢，所以下雨天做饭心情好。", { insight: true });
  row(1080, "system", "system", "去睡觉了（夜里）。");

  // —— 夜里整理：中央记忆抄进原话层（hhd 平时一直在抄），海马把这一天写进事件库和人物卡
  index.ingestCentral();
  const NIGHT = `night:${yesterday}/${yesterday}`;
  when(1075);
  open(NIGHT);
  did(1074, "hippocampus", "mem_worklist", { day: yesterday }, "这一天的工作单：3 段对话要记成事，2 个人的卡要看。");
  when(1070);
  const eEgg = mk({ title: "第一次做番茄炒蛋", summary: `教${OWNER}做番茄炒蛋：步骤理成三步，他做出来了，蛋炒老了，下次用中火。`, gist: `教${OWNER}做番茄炒蛋，蛋炒老了`, importance: 3, status: "done", parent: eCook, entities: [withP(OWNER), withP("番茄炒蛋", "thing", "about")] });
  did(1070, "hippocampus", "mem_event_create", { title: "第一次做番茄炒蛋", parent: eCook, importance: 3 }, `建好了：${eEgg}（属于 ${eCook}「学做饭」）`);
  when(1060);
  const nAsk = add(eEgg, 1700 * MIN, "happened", "他想吃番茄炒蛋", `${OWNER}想吃番茄炒蛋，让我教`, `${OWNER}说今晚想吃番茄炒蛋，让我教他。我把做法理成三步发给他。`, { people: [OWNER], source: [`c:${sCook}`, `c:${sSteps}`] });
  const nDone = add(eEgg, 1620 * MIN, "result", "做出来了", "做出来了，蛋有点老", "第一盘做出来了，味道不错，就是蛋炒得太久，有点老。", { people: [OWNER], source: [`c:${sThanks}`] });
  const nSaid = add(eEgg, 1620 * MIN - 1000, "said", "他说谢谢", `${OWNER}夸我教得清楚`, `${OWNER}：「你教得挺清楚的，谢谢。」`, { people: [OWNER], source: [`c:${sThanks}`] });
  add(eEgg, 1618 * MIN, "feeling", "被夸了", "被夸教得清楚，开心", "他夸我教得清楚，挺开心的，想把下一道也教好。");
  did(1060, "hippocampus", "mem_entries_add", { event: eEgg, entries: 4 }, `记了 4 条：${nAsk}、${nDone}、${nSaid} 等。`);
  when(1050);
  const nFix = s.correctEntry(nDone, { full: "其实不是炒得太久，是火太大：他原话说的是「下次火小一点」。", gist: "蛋老是因为火太大", title: "蛋老的原因", why: "对了原话：他说的是火小一点" }, batch).id;
  did(1050, "hippocampus", "mem_entry_correct", { entry: nDone, why: "对了原话" }, `更正了：${nFix} 更正 ${nDone}。`);
  when(1040);
  const eBuy = mk({ title: "买锅和调料", summary: "做菜前下楼买了生抽和一口不粘锅。", gist: "买了生抽和不粘锅", importance: 1, status: "done", parent: eEgg });
  add(eBuy, 1730 * MIN, "happened", "下楼买东西", "买了生抽和不粘锅", `做菜前${OWNER}下楼买了生抽和一口不粘锅，来回四十分钟。`, { people: [OWNER], untilMs: 1690 * MIN });
  const eStew = mk({ title: "周末做红烧肉", summary: "番茄炒蛋学会了，下一道定了红烧肉，周日做。", gist: "下一道菜定了红烧肉", importance: 2, parent: eCook, next: localDay(now + 2 * DAY, tz) });
  add(eStew, 1617 * MIN, "decided", "下一道红烧肉", "下一道定了红烧肉", "说好下一道学红烧肉，周日做，五花肉周六买。");
  const eN3 = mk({ title: "日语 N3 学习计划", summary: "每天半小时：周一到周五背 20 个单词，周六做一套听力，周日机动。", gist: "每天半小时，工作日背单词、周末听力", why: "第一次自己排的长期计划", importance: 5, pinned: true, next: localDay(now + 30 * DAY, tz), entities: [withP(OWNER), withP("日语 N3", "thing", "about")] });
  add(eN3, 1368 * MIN, "decided", "计划排好了", "每天半小时的计划排好了", `${OWNER}让我排日语 N3 的学习计划：周一到周五每天背 20 个单词，周六听力，周日机动。`, { people: [OWNER], source: [`c:${sPlan}`] });
  const eL11 = mk({ title: "背完第 11 课单词", summary: "第 11 课的 20 个单词背完，错了 2 个。", gist: "第 11 课背完，错 2 个", importance: 2, status: "done", parent: eN3 });
  add(eL11, 1372 * MIN, "result", "第 11 课", "20 个单词错了 2 个", "第 11 课的 20 个单词背完了，错了 2 个，当场默写了三遍。", { source: [`c:${sL11}`] });
  const ePicnic = mk({ title: "周六街角公园野餐", summary: "群里约了周六去街角公园野餐，我带番茄炒蛋三明治。", gist: "周六和大家去街角公园野餐", why: "第一次和大家一起出门", importance: 4, entities: [withP(GROUP, "group"), withP(YI), withP(JIA), withP("街角公园", "place", "where")] });
  add(ePicnic, 1440 * MIN, "happened", "群里约野餐", `${YI}在群里约周六野餐`, `${YI}在${GROUP}里问周六去不去街角公园野餐。`, { people: [YI], source: [`c:${sPicnic}`] });
  add(ePicnic, 1437 * MIN, "said", "我带三明治", "我说带番茄炒蛋三明治", "我在群里说：「我可以带番茄炒蛋三明治。」", { source: [`c:${sSandwich}`] });
  const eBook = mk({ title: `${JIA}借《料理入门》`, summary: `${JIA}想借《料理入门》，书是${OWNER}的，我答应帮她问。`, gist: `${JIA}想借《料理入门》`, importance: 3, entities: [withP(JIA), withP("《料理入门》", "work", "about")] });
  add(eBook, 1500 * MIN, "happened", "来借书", `${JIA}来借《料理入门》`, `${JIA}问那本《料理入门》能不能借她看看，我说帮她问问${OWNER}。`, { people: [JIA], source: [`c:${sBorrow}`] });
  const eWalk = mk({ title: "改成傍晚散步", summary: "早上起不来，晨跑改成傍晚散步。", gist: "晨跑改成傍晚散步", importance: 2 });
  add(eWalk, 1100 * MIN, "decided", "改成散步", "晨跑改成傍晚散步", `${OWNER}说早上实在起不来，晨跑改成晚饭后散步二十分钟。`, { people: [OWNER] });
  s.supersede(eRun, eWalk, "早上起不来，改到傍晚", batch);
  const eWrong = mk({ title: `${OWNER}不吃香菜`, summary: `以为${OWNER}不吃香菜。`, gist: `以为${OWNER}不吃香菜`, importance: 1 });
  s.retire(eWrong, "他后来说吃的，是我记错了", batch);
  s.link(eEgg, eStew, "followup", "番茄炒蛋学会了，下一道定了红烧肉", batch);
  s.link(eEgg, ePicnic, "cause", "野餐要带的三明治，就是那次的番茄炒蛋", batch);
  s.link(eCook, eBook, "related", "她借的就是学做饭用的那本书", batch);
  s.link(eRain, eWalk, "contrast", "下雨那几天出不了门，现在天晴能散步", batch);
  s.link(eN3, eL11, "same_thread", "", batch);
  // 人物卡：主人的大改等批（前一版待批被新的顶掉 = 驳回），访客私下说的直接生效但不给看，群的第一版等批
  when(1000);
  set(OWNER, "我们的大事", `- 第一次一起做番茄炒蛋（${eEgg}）\n- 定下日语 N3 学习计划（${eN3}）`, "这两件是和他一起做成的");
  set(OWNER, "喜好", "- 番茄炒蛋（蛋要嫩）\n- 下雨天待在家\n- 清淡的晚饭", "他说晚饭想吃清淡的");
  set(OWNER, "感觉", "他做坏了也不恼，还会回头夸我教得清楚。", "做番茄炒蛋那晚看到的");
  set(OWNER, "感觉", "他做坏了也不恼，还夸我教得清楚。和他一起做饭很安心。", "把原来那句也留着");
  did(1000, "hippocampus", "mem_person_set", { who: OWNER, section: "感觉" }, `存成待批：「感觉」丢了旧文 1/1 行，等${OWNER}批。`);
  s.pinQuote({ who: OWNER, section: "对我的感情和期待", quote: `c:${sThanks}`, text: "你教得挺清楚的，谢谢。", why: "第一次被他夸" }, batch);
  s.pinQuote({ who: OWNER, section: "记着的原话", quote: `c:${sSteps}`, text: "蛋液加一小勺水，中火炒到半熟盛出来", why: "我教他的第一道菜" }, batch);
  set(JIA, "她私下说的", `- 想给家里人办${SECRETS.card}，要保密\n- 要帮忙列清单时叫我`, `她私聊里说的${SECRETS.card}`);
  s.pinQuote({ who: JIA, section: "记着的原话", quote: `c:${sSecret}`, why: `答应替她保密${SECRETS.card}` }, batch);
  s.pinQuote({ who: JIA, section: "对我的感情和期待", quote: `c:${sPraise}`, text: "你教的番茄炒蛋比视频清楚多了。", private: false, why: "她夸我教得清楚" }, batch);
  set(GROUP, "是谁", `${OWNER}和朋友们的小群，五六个人，周末常约着出门。`, "群里聊天看出来的", { forcePending: true });
  when(700);
  did(700, "hippocampus", "mem_day_done", { day: yesterday }, "这一天整理完了。");
  for (const [day, ago] of [[yesterday, 700], [shiftDay(yesterday, -2), 700 + 48 * 60]] as const) db.prepare("INSERT INTO mem_day (day, done_at) VALUES (?, ?)").run(day, at(ago));
  when(640);
  s.commitBatch(batch);

  // —— 第 3 页：睡醒 → 翻页
  when(600);
  epochs.clearBlocks();
  turn(600, "wake");
  row(600, "system", "system", "睡醒了。");
  heard(560, OWNER, "whatsapp", "早，今天天气怎么样？适合晾衣服吗？");
  did(559, "main", "Bash", { command: "python3 tools/weather.py --city maplebay" }, "今天：晴，14–22 度，北风 3 级。");
  reply(558, TO.owner, "晴，14 到 22 度，有点北风，适合晾衣服。");
  /** 白天记喜好：每记一下是一批（day-like:） */
  const like = (ago: number, title: string, stance: "like" | "dislike", importance: number, gist: string, feeling: string): string => {
    when(ago);
    open(`day-like:${t}`);
    const id = mk({ title, summary: feeling, gist, importance, stance });
    s.addEntry({ event: id, at: t, kind: "feeling", title: stance === "like" ? "喜欢上了" : "烦上了", gist, full: feeling }, batch);
    s.commitBatch(batch);
    return id;
  };
  const eAlarm = like(520, "烦 周一早上的闹钟", "dislike", 2, "周一的闹钟一响就不想动", "周一早上的闹钟一响就不想动，尤其是下雨天，被窝外面太冷了。");
  did(520, "main", "like", { what: "周一早上的闹钟", how: "dislike" }, `记下了：烦 周一早上的闹钟（${eAlarm}）。`);
  row(480, "main", "note", `今天要做的：背第 12 课单词；晚饭问${OWNER}想吃什么。`);
  did(420, "side-2", "Read", { file_path: "notes/日语/第11课.md" }, "天気（てんき）・雨（あめ）・傘（かさ）・晴れ（はれ）……");
  row(400, "side-2", "note", "第 11 课复习了一遍，错的两个又默写了三遍。");
  row(332, "hippocampus", "think", "这一页写满了，压成一段。", { inner: true });
  const block = pageTurn(330, BLOCK2);

  // —— 第 4 页：翻页 → hhd 重启（这一页没压成一段）
  heard(300, OWNER, "whatsapp", "午饭吃了面，下午有点困。");
  reply(299, TO.owner, "那下午背单词之前先歇十分钟。");
  sensed(260, "rss-31", "- [rss id=rss-31] 订阅：枫湾本周天气，周六晴");
  row(240, "main", "think", "周六晴，野餐不用带伞。");
  row(200, "speech", "say", "嗯嗯，我看看。");

  // —— 第 5 页：重启 → 翻页（尾巴在最近一小时里）
  turn(180, "boot");
  heard(150, JIA, "wx", `书我周六野餐的时候还给${OWNER}。`);
  reply(149, TO.jia, "好，我跟他说一声。");
  did(120, "main", "remind", { when: "周六 09:00", text: `提醒${OWNER}：${JIA}野餐时还书` }, "排好了：#2 周六 09:00。");
  row(90, "main", "think", "下午安静。等晚饭的时候再问他想吃什么。");
  heard(58, OWNER, "whatsapp", "晚饭想吃清淡点，冰箱里有番茄和鸡蛋。");
  row(57.5, "main", "think", "又是番茄和鸡蛋。上次他说蛋炒老了，先想想当时记了什么。");
  did(57, "main", "remember", { cue: "番茄炒蛋 火候" }, `想起来的（编号可以用 recall_event 展开）：\n· 第一次做番茄炒蛋〔3〕${eEgg}：教${OWNER}做番茄炒蛋，蛋炒老了`);
  did(56, "main", "recall_event", { id: eEgg }, `第一次做番茄炒蛋〔3〕${eEgg}（属于 ${eCook}）\n- 做出来了，蛋有点老（${nDone}）\n- 更正：蛋老是因为火太大（${nFix}）\n- ${OWNER}夸我教得清楚（${nSaid}）`);
  reply(55, TO.owner, "那就番茄炒蛋配青菜汤吧。这次中火，蛋液凝固一半就盛出来。");
  sensed(53, "wx-2001", `- [wx id=wx-2001] ${GROUP} ${YI}：周六野餐谁带垫子？`);
  row(52, "main", "think", "群里在问垫子。清单还没列，列的时候把垫子写上。");
  heard(51, OWNER, "whatsapp", "对了，周六野餐你帮我列个清单。");
  row(50.7, "speech", "say", "好，马上列。");
  did(50, "main", "on_it", { topic: "列周六野餐清单", about_min: 15 }, "开始了：列周六野餐清单（估 15 分钟）。");
  row(49, "side-1", "think", "野餐清单：吃的、喝的、垫子、垃圾袋。先看周六的天气。");
  did(48, "side-1", "Bash", { command: "python3 tools/weather.py --city maplebay --day sat" }, "周六：晴，14–22 度，北风 3 级。");
  row(47, "hippocampus", "think", "这一页写满了，压成一段：还书的提醒、晚饭、野餐清单。", { inner: true });
  row(46.5, "hippocampus", "say", `${BLOCK3.slice(0, 48)}……`, { inner: true });
  pageTurn(45, BLOCK3);

  // —— 第 6 页：现在这一页
  did(44, "side-1", "Write", { file_path: "notes/野餐清单.md", content: "三明治、水果、气泡水、垫子、垃圾袋" }, "写好了：notes/野餐清单.md");
  did(42, "side-1", "hands", { name: "picnic-list", task: "把野餐清单排成好打印的一页", model: "sonnet" }, "派给帮手 picnic-list 了。");
  row(40, "side-1", "note", "清单初稿好了：三明治、水果、气泡水、垫子、垃圾袋；周六晴，不用带伞。");
  row(38, "外界", "input", "帮手 picnic-list：排好了，一页 A4，放在 notes/野餐清单.pdf。", { from: "帮手 picnic-list", channel: "cc", hands: true });
  did(37, "side-1", "done_with", { topic: "列周六野餐清单", state: "做完了" }, "收下了：列周六野餐清单，用了 12 分钟。");
  reply(35, TO.owner, "清单好了：三明治、水果、气泡水、垫子、垃圾袋。周六晴，14 到 22 度，不用带伞。");
  row(34.5, "side-1", "think", "清单交了。接着做昨天答应的：把番茄炒蛋三步剪成一分钟的视频。");
  did(34, "side-1", "hands", { name: "recipe-video", task: "把「番茄炒蛋三步」剪成一分钟的竖屏视频", model: "opus" }, "派给帮手 recipe-video 了。");
  heard(33, JIA, "wx", `${ME}，番茄炒蛋要不要放糖？`);
  row(32.5, "main", "think", "她爱吃甜口。我自己是出锅前放一小撮。");
  did(32, "main", "recall_person", { who: JIA }, `${JIA}：朋友｜平稳｜常来借书、问做菜\n最近的事：${JIA}借《料理入门》〔3〕${eBook}；周六街角公园野餐〔4〕${ePicnic}`);
  reply(31, TO.jia, "我一般出锅前放一小撮，提鲜。你爱吃甜的可以多放一点。");
  const eRainSound = like(29, "喜欢 下雨天的声音", "like", 3, "雨打在窗上的声音让人慢下来", "雨打在窗上的声音让人慢下来，做饭、背单词都更静得下心，我喜欢。");
  did(29, "main", "like", { what: "下雨天的声音", how: "like" }, `记下了：喜欢 下雨天的声音（${eRainSound}）。`);
  sensed(27, "rm-7", "- [remind id=rm-7] 该背今天的 20 个日语单词了");
  row(26.5, "main", "think", "到点背单词了，第 12 课。");
  did(26, "main", "on_it", { topic: "背今天的日语单词", about_min: 20 }, "开始了：背今天的日语单词（估 20 分钟）。");
  row(25, "side-2", "think", "第 12 课：天気、雨、傘、晴れ、曇り、涼しい……先过一遍再默写。");
  did(24, "side-2", "Read", { file_path: "notes/日语/第12课.md" }, "曇り（くもり）阴天\n涼しい（すずしい）凉快\n傘（かさ）伞\n……共 20 个");
  did(22, "side-2", "Bash", { command: "python3 tools/quiz.py --lesson 12" }, "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'tools/quiz.py'", { error: true });
  row(21, "side-2", "think", "出题的脚本不在。不绕了，自己默写。");
  row(19, "side-2", "note", "今天 20 个单词背完了，错了 3 个：傘、曇り、涼しい。");
  did(18, "main", "mull_over", { what: "为什么总记不住「曇り」" }, "放着慢慢想了。");
  row(17, "deep", "think", "「曇り」和「雲」长得像……上周背到哪了？", { inner: true });
  did(15, "deep", "recall_period", { when: "上周" }, "上周没有记下的事。", { inner: true });
  row(14, "deep", "note", "我想明白了：「曇り」和「雲」同源，把它和满天的云绑在一起记。", { insight: true });
  did(12, "main", "recall", { args: ["search", "垫子"] }, "自己的记忆里没找到。");
  did(11, "main", "recall_person", { who: "路人丁" }, "不认识「路人丁」：记忆里没有这个人或东西。");
  heard(9, OWNER, "whatsapp", `蛋这次很嫩！谢谢${ME}。`);
  row(8.5, "main", "think", "中火加半熟盛出，是对的。记进做法里。");
  reply(8, TO.owner, "太好了！下次可以试试出锅前加一小撮糖。");
  row(7, "main", "note", `${OWNER}说这次蛋很嫩：中火、半熟盛出是对的。`);
  const sOwn = row(5, "main", "say", "今天的单词还差复习一遍，睡前再默写一次。");
  row(5, "main", "note", "（上面这段没发给任何人：这一轮是自己醒的，没有谁在等回复，最后写的话不会发出去。）", { unsent: true, of: [sOwn] });
  did(3, "main", "remind", { when: "明天 07:30", text: `提醒${OWNER}看天气` }, "排好了：#3 明天 07:30。");
  row(2, "main", "act", 'remember {"cue":"野餐 垫子 谁带"}', { tool: "remember", id: "tooluDemoPending" });   // 刚去想，还没结果
  row(1, "side-2", "think", "把错的三个再默写一遍：傘、曇り、涼しい。");

  // —— 收尾：原话层跟上、碰过的痕迹、向量、导出的文件
  index.ingestCentral();
  s.touch(eEgg, "auto", "main", at(57));
  s.touch(eEgg, "open", "main", at(56));
  s.touch(nDone, "open", "main", at(56));
  s.touch(ePicnic, "recall", "main", at(32));
  s.touch(eN3, "cite", "main", at(26));
  // 每页多大按「翻页的那几页差不多写满」来定（只改 tokens 这一列）：照字数估的话，哪一页都只有翻页线的一小截
  [0.95, 0.8, 1, 0.5, 0.98, 0.5].forEach((full, i) => {
    const target = full * LIMITS.pageTokens;
    const sum = one<{ n: number }>(db, "SELECT COALESCE(SUM(tokens), 0) AS n FROM central WHERE epoch = ?", i + 1)!.n;
    if (sum) db.prepare("UPDATE central SET tokens = CAST(tokens * ? AS INTEGER) WHERE epoch = ?").run(target / sum, i + 1);
  });
  // 向量是假的（全 0），只给原话：总览里「几成有向量」有数；事件、经过和最后几句原话算「还没算」
  const vec = new Uint8Array(new Float32Array(8).buffer);
  const quotes = all<{ ref: string }>(db, "SELECT ref FROM mem_fts WHERE ref LIKE 'q%' ORDER BY rowid");
  for (const q of quotes.slice(0, -4)) db.prepare("INSERT INTO mem_vec (ref, hash, vec) VALUES (?, 'demo', ?)").run(q.ref, vec);
  const midterm = renderMidterm(new EventRecall({ store: s, index, now: () => now, tz }), { now, tz });
  put(join(c.dir, "exports/midterm.md"), midterm, now - 4 * MIN);
  put(join(c.dir, "exports/vectors.json"), JSON.stringify({ at: now - 4 * MIN, missing: index.missingVectors(), lastError: "向量服务没回应（演示用的假错误）", lastErrorAt: now - 20 * MIN, lastOkAt: now - 3 * HOUR, pausedUntil: now + 10 * MIN }), now - 4 * MIN);
  return { page, block, midterm, event: eEgg, entry: nDone, person: s.entity(JIA)!.id, batch: NIGHT };
}

// ---------- 库：闸门的账、学习的记分 ----------

interface GateSeed {
  /** 这一天里的位置（0 = 零点，1 = 现在 / 这一天结束） */
  f: number; id: string; src: string; conv?: string; sender?: string; group?: boolean; text: string;
  route: string | null; rule?: string; action?: string; verdict?: string; when?: string; gist?: string; why?: string; unsure?: boolean; delivered?: boolean; tokens?: number; units?: number;
}

function seedGate(c: Ctx, db: Db): void {
  const day = gateDayRange(c.today, c.tz)!, prev = gateDayRange(c.yesterday, c.tz)!;
  const direct = { route: "fixed-main", action: "fixed-main", when: "now", delivered: true };
  const judged = { route: "judge", action: "judge" };
  const today: GateSeed[] = [
    { f: 0.05, id: "goals-2", src: "goals", text: "今天的目标：背第 12 课单词、列野餐清单", ...direct },
    { f: 0.12, id: "quota-2", src: "hh-quota", text: "【额度】这周（7 天）额度用了 41%。", ...direct },
    { f: 0.2, id: "rss-31", src: "rss", text: "订阅：枫湾本周天气，周六晴", route: "rule", rule: "天气订阅", action: "digest" },
    { f: 0.28, id: "xhs-9", src: "xhs", conv: "通知", text: "有人赞了你的笔记《番茄炒蛋》", route: "rule", rule: "小红书的赞", action: "drop" },
    { f: 0.36, id: "wx-1990", src: "wx", conv: "路人丙", sender: "路人丙", group: false, text: "路人丙：在吗？加个好友", ...judged, verdict: "drop", gist: "陌生人打招呼", why: "不认识，像广告", tokens: 900 },
    { f: 0.44, id: "qq-77", src: "qq", conv: GROUP, sender: YI, group: true, text: `${GROUP} ${YI}：今天好热，想吃冰`, ...judged, verdict: "digest", gist: "闲聊天气", why: "没人问她", unsure: true, tokens: 4800, units: 1200 },
    { f: 0.52, id: "load-3", src: "load", text: "负载：内存用了 82%", route: "judge", action: "judge-floor", verdict: "digest", gist: "内存有点紧", why: "不急，记一笔" },
    { f: 0.6, id: "bili-41", src: "bili", text: "有人回复了你的视频：红烧肉要炖多久？", ...judged, verdict: "main", when: "work", gist: "问红烧肉炖多久", why: "问到她会的，做事的时候再回" },
    { f: 0.64, id: "bili-42", src: "bili", text: "有人给你的视频投了币", route: "fallback", action: "judge", verdict: "digest", why: "小判断超时" },
    { f: 0.66, id: "bili-44", src: "bili", text: "有人收藏了你的视频", route: "fallback", action: "judge", verdict: "digest", why: "小判断超时" },
    { f: 0.72, id: "wx-1995", src: "wx", conv: GROUP, sender: YI, group: true, text: `${GROUP} ${YI}：有人看到我的水壶吗`, route: "fallback", rule: "群消息", action: "judge", verdict: "digest", why: "这周额度快用完了，群里的先进总结" },
    // 访客私聊：原文、要点、原因控制台都不给（兜底原因里也带着原文）
    { f: 0.8, id: "wx-1996", src: "wx", conv: JIA, sender: JIA, group: false, text: `${JIA}：悄悄话，我把锅${SECRETS.gate}了，先别告诉${OWNER}`, route: "fallback", action: "judge", when: "now", gist: `锅${SECRETS.gate}了`, why: `小判断出错：回的不是 JSON（…${SECRETS.gate}…）`, delivered: true },
    { f: 0.86, id: "wx-2000", src: "wx", conv: OWNER, sender: OWNER, group: false, text: `${OWNER}：晚饭想吃清淡点，冰箱里有番茄和鸡蛋。`, ...direct },
    { f: 0.9, id: "wx-2001", src: "wx", conv: GROUP, sender: YI, group: true, text: `${GROUP} ${YI}：周六野餐谁带垫子？`, ...judged, verdict: "main", when: "now", gist: "问谁带垫子", why: "她答应过列清单", delivered: true, tokens: 5200, units: 1300 },
    { f: 0.94, id: "cc-5", src: "cc", text: "帮手 picnic-list：清单排好了，一页 A4。", route: "hands", action: "hands", delivered: true },
    { f: 0.96, id: "rm-7", src: "remind", text: "该背今天的 20 个日语单词了", ...direct },
    { f: 0.98, id: "bili-43", src: "bili", text: "你关注的 UP 主更新了：十分钟学会红烧肉", ...judged, verdict: "main", when: "leisure", gist: "红烧肉教程", why: "正好周末要做", delivered: true, tokens: 1100, units: 280 },
    { f: 0.995, id: "net-1", src: "phone_net", text: "手机网络断了 2 分钟", route: null },
  ];
  const yesterday: GateSeed[] = [
    { f: 0.3, id: "goals-1", src: "goals", text: "今天的目标：回天气、学一道菜", ...direct },
    { f: 0.45, id: "wx-1000", src: "wx", conv: JIA, sender: JIA, group: false, text: `${JIA}：那本《料理入门》能借我看看吗？`, ...judged, verdict: "main", when: "now", gist: "借书", why: "在问她", delivered: true, tokens: 3900, units: 980 },
    { f: 0.6, id: "wx-1001", src: "wx", conv: GROUP, sender: YI, group: true, text: `${GROUP} ${YI}：周六去街角公园野餐吗？`, ...judged, verdict: "main", when: "now", gist: "约周六野餐", why: "在约大家，她也在群里", delivered: true, tokens: 4100, units: 1020 },
    { f: 0.7, id: "xhs-8", src: "xhs", conv: "通知", text: "有人关注了你", route: "rule", rule: "小红书的关注", action: "drop" },
    { f: 0.8, id: "bili-40", src: "bili", text: "有人回复了你的视频：看饿了", ...judged, verdict: "drop", gist: "路过的评论", why: "不用回", tokens: 800 },
    { f: 0.9, id: "rm-6", src: "remind", text: "该睡了，明天早起看天气", ...direct },
  ];
  const ins = db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev, route, rule, action, verdict, when_, gist, why, unsure, delivered, tokens, units, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const write = (rows: GateSeed[], from: number, to: number): void => {
    for (const r of rows) {
      const ts = Math.floor(from + (to - from) * r.f);
      const line = `- [${r.src} id=${r.id}] ${r.text}`;
      const ev = JSON.stringify({ src: r.src, id: r.id, text: r.text, line, ...(r.conv ? { conv: r.conv } : {}), ...(r.sender ? { sender: r.sender } : {}), ...(r.group !== undefined ? { isGroup: r.group } : {}) });
      ins.run(ts, r.id, r.src, r.conv ?? null, r.sender ?? null, line, ev, r.route, r.rule ?? null, r.action ?? null, r.verdict ?? null, r.when ?? null, r.gist ?? null, r.why ?? null,
        r.unsure === undefined ? null : r.unsure ? 1 : 0, r.delivered ? ts + 2000 : null, r.tokens ?? 0, r.units ?? null, r.route === null ? "new" : "done");
    }
  };
  write(today, day.from, c.now);
  write(yesterday, prev.from, day.from);
}

function seedLearn(c: Ctx, db: Db): void {
  const { now, today, yesterday } = c;
  const at = (minAgo: number): number => now - minAgo * MIN;
  // [几分钟前, 脑区, 什么时候联想的, 话题, 候选几页, 挂了哪几页, 只算不挂, 为什么没挂, 毫秒, token]
  const assoc: Array<[number, string, string, string, number, Array<{ id: string; p: number }>, number, string | null, number, number]> = [
    [1698, "main", "on_it", `教${OWNER}做番茄炒蛋`, 6, [{ id: "0012", p: 0.93 }], 0, null, 310, 1900],
    [1379, "main", "on_it", "排日语 N3 学习计划", 5, [{ id: "0003", p: 0.81 }], 0, null, 280, 1700],
    [1200, "main", "mull_over", "为什么下雨天做饭心情更好", 4, [], 0, "nothing", 260, 1500],
    [600, "main", "wake", "睡醒了", 0, [], 0, "lowinfo", 3, 0],
    [560, "main", "wake", "今天天气怎么样？适合晾衣服吗？", 5, [{ id: "0021", p: 0.77 }], 0, null, 240, 1600],
    [480, "main", "goals", "今天要做的：背第 12 课单词", 4, [{ id: "0003", p: 0.72 }], 1, null, 250, 1650],
    [300, "main", "wake", "午饭吃了面，下午有点困", 3, [], 0, "nothing", 210, 1400],
    [150, "main", "wake", "书我周六野餐的时候还", 2, [], 0, "same", 5, 0],
    [58, "main", "wake", "晚饭想吃清淡点，冰箱里有番茄和鸡蛋", 6, [{ id: "0012", p: 0.95 }], 0, null, 300, 1850],
    [50, "main", "on_it", "列周六野餐清单", 5, [{ id: "0021", p: 0.74 }], 0, null, 270, 1700],
    [42, "side-1", "hands", "把野餐清单排成好打印的一页", 3, [], 0, "novec", 1500, 0],
    [42, "side-1", "helper", "附给帮手 picnic-list", 3, [{ id: "0021", p: 0.7 }], 0, null, 200, 900],
    [33, "main", "wake", "番茄炒蛋要不要放糖？", 6, [{ id: "0012", p: 0.9 }], 0, null, 290, 1800],
    [26, "main", "on_it", "背今天的日语单词", 5, [{ id: "0003", p: 0.88 }], 0, null, 260, 1700],
    [18, "main", "mull_over", "为什么总记不住「曇り」", 4, [], 0, "judge", 800, 0],
    [12, "main", "ask", "垫子", 2, [], 0, "nothing", 150, 600],
    [9, "main", "wake", "蛋这次很嫩！", 4, [], 0, "budget", 2, 0],
  ];
  const ins = db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  for (const [ago, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens] of assoc) ins.run(at(ago), region, binding, topic, candidates, JSON.stringify(mounted), shadow, skipped, ms, tokens);
  // 挂上以后一小时内翻开的算接住
  for (const [ago, id] of [[1695, "0012"], [56, "0012"], [24, "0003"]] as const) db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', ?, NULL)").run(at(ago), id);
  for (const [id, rel, ago] of [["0034", "做事/做饭/番茄炒蛋.md", 2 * DAY], ["0035", "做事/看天气/带伞.md", 5 * DAY]] as const) {
    db.prepare("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen) VALUES (?, 'lesson', ?, 'demo', ?, ?)").run(id, rel, now - ago, now - HOUR);
  }
  db.prepare("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('0034', ?, 'mounted'), ('0035', ?, 'unmounted')").run(yesterday, shiftDay(today, -3));
  db.prepare("INSERT INTO learn_correction (at, topic, p) VALUES (?, '番茄炒蛋的火候', 0.8), (?, '回天气只看了上午', 0.7)").run(at(1620), now - 3 * DAY);
  for (const [topic, expect, passed] of [["教人做番茄炒蛋", "0012", 1], ["有人问天气", "0021", 1], ["排学习计划", "0003", 1], ["做红烧肉", "0013", 0]] as const) {
    const id = Number(db.prepare("INSERT INTO learn_case (at, topic, expect, source) VALUES (?, ?, ?, 'seed')").run(now - 3 * DAY, topic, expect).lastInsertRowid);
    db.prepare("INSERT INTO learn_case_run (night, case_id, passed) VALUES (?, ?, ?)").run(yesterday, id, passed);
  }
  // 做完的事（估多久、实际多久）：估时间的准头从这里算
  const task = db.prepare("INSERT INTO tasks (topic, owner, about_min, state, started, ended, took_min) VALUES (?, ?, ?, ?, ?, ?, ?)");
  task.run(`教${OWNER}做番茄炒蛋`, "side-1", 20, "done", at(1698), at(1672), 26);
  task.run("排日语 N3 学习计划", "side-2", 30, "done", at(1379), at(1348), 31);
  task.run("列周六野餐清单", "side-1", 15, "done", at(50), at(37), 13);
  task.run("背今天的日语单词", "side-2", 20, "doing", at(26), null, null);
  kvSet(db, `learn.spend.${today}`, "184000");
  kvSet(db, "learn.alert", JSON.stringify({ at: at(18), msg: "联想的判断连着 3 次超时，先停 10 分钟" }));
}

// ---------- 文件：帮手和脑区的会话（Claude Code 的 transcript）、日志 ----------

export type Step = { user: string } | { think: string } | { say: string } | { tool: string; input: unknown; result: string; error?: boolean } | { attach: string; text: string };

/** transcript 的对话部分：一步隔 20 秒；她的每一条带模型报的用量（上下文从 ctx 往上涨） */
export function chat(start: number, steps: readonly Step[], o: { model?: string; ctx?: number } = {}): unknown[] {
  const out: unknown[] = [];
  let ts = start, n = 0, ctx = o.ctx ?? 1_000;
  const assistant = (content: unknown[]): void => {
    out.push({ type: "assistant", timestamp: iso(ts), message: { id: `msg_demo_${++n}`, role: "assistant", model: o.model ?? CFG.models.opus, content, usage: { input_tokens: 12, cache_read_input_tokens: ctx, cache_creation_input_tokens: 90, output_tokens: 40 } } });
    ctx += 130;
  };
  for (const s of steps) {
    ts += 20_000;
    if ("user" in s) out.push({ type: "user", timestamp: iso(ts), message: { role: "user", content: s.user } });
    else if ("think" in s) assistant([{ type: "thinking", thinking: s.think, signature: "demo" }]);
    else if ("say" in s) assistant([{ type: "text", text: s.say }]);
    else if ("attach" in s) out.push({ type: "attachment", timestamp: iso(ts), attachment: { type: s.attach }, rendered: [{ content: s.text }], renderedRole: "user" });
    else {
      const id = `toolu_demo_${out.length}`;
      assistant([{ type: "tool_use", id, name: s.tool, input: s.input }]);
      ts += 4_000;
      out.push({ type: "user", timestamp: iso(ts), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, ...(s.error ? { is_error: true } : {}), content: [{ type: "text", text: s.result }] }] } });
    }
  }
  return out;
}

function seedWorkers(c: Ctx): void {
  const { dir, now } = c;
  const steps: Record<string, Step[]> = {
    "recipe-video": [
      { user: "把「番茄炒蛋三步」剪成一分钟的竖屏视频，字幕用大字。" },
      { think: "先看素材有几段、各多长，再定怎么切。" },
      { say: "我先看一下素材。" },
      { tool: "Bash", input: { command: "ls -la clips/" }, result: "01-打蛋.mp4  18s\n02-炒蛋.mp4  41s\n03-炒番茄.mp4  37s\n04-出锅.mp4  12s" },
      { think: "" },
      { tool: "Bash", input: { command: "python3 cut.py --plan plan.json" }, result: "切好 4 段，合计 58 秒。" },
      { say: "四段切好了，合起来 58 秒。现在加字幕。" },
      { tool: "Write", input: { file_path: "subs.srt", content: "1\n00:00:00,000 --> 00:00:04,000\n蛋液加一小勺水" }, result: "写好了：subs.srt" },
    ],
    "picnic-list": [
      { user: "把野餐清单排成好打印的一页 A4：三明治、水果、气泡水、垫子、垃圾袋。" },
      { think: "分三栏：吃的、喝的、用的。标题写日期和地点。" },
      { tool: "Read", input: { file_path: "notes/野餐清单.md" }, result: "三明治、水果、气泡水、垫子、垃圾袋" },
      { tool: "Write", input: { file_path: "notes/野餐清单.pdf" }, result: "写好了：notes/野餐清单.pdf（1 页）" },
      { say: "排好了，一页 A4，放在 notes/野餐清单.pdf。" },
    ],
    "weather-notes": [
      { user: "把上周每天的天气整理成一张表。" },
      { think: "" },
      { tool: "Read", input: { file_path: "notes/天气/上周.csv" }, result: "没有这个文件：notes/天气/上周.csv", error: true },
      { say: "上周的记录文件不在，整理不了。要我从今天开始每天记一行吗？" },
    ],
  };
  for (const w of WORKERS) {
    const last = now - w.idle;
    put(join(dir, "cc", `${w.name}.json`), JSON.stringify({ session_id: w.sid, model: w.model, bg_model: w.model, state: w.state, turn: w.turn, dir: `/demo/work/${w.name}`, created: iso(last - HOUR).slice(0, 19).replace("T", " "), token: "demo-token-never-shown" }), last);
    put(join(dir, "projects", `-demo-work-${w.name}`, `${w.sid}.jsonl`), jsonl(chat(last - 10 * MIN, steps[w.name] ?? [], { model: w.model })), last);
  }
}

/** 前缀照 buildPrefix 的拼法（那边的运行说明写着真名，这里换成假的）：运行说明 / 人格文件 / 书架目录 / 过渡句 + 记忆文件 + 中期视图 + 压缩记忆 */
function prefixText(c: Ctx, midterm: string): string {
  const files = persona();
  const fileText = (f: string): string => `<file path="${f}">\n${(files[f] ?? "").trim()}\n</file>`;
  const self = DEMO_FILES.filter((f) => !MEMORY_FILES.has(f)).map(fileText).join("\n\n");
  const shelf = renderShelf(scanShelf(join(c.ws, "skills"), CFG.learning.generalCategory, CFG.learning.archiveDir)).trim();
  const memory = [
    ...DEMO_FILES.filter((f) => MEMORY_FILES.has(f)).map(fileText), midterm.trim(),
    "## 这次醒来以后（压缩过的记忆）\n\n" + [BLOCK2, BLOCK3].map((b, i) => `### 第 ${i + 1} 段\n\n${b}`).join("\n\n"),
  ];
  return [RUNTIME_NOTE, self, shelf, `${memoryFrame()}\n\n${memory.join("\n\n")}`].join("\n\n---\n\n");
}

function seedSessions(c: Ctx, m: Seeded): void {
  const { dir, ws, now } = c;
  const marker = (role: string): string => {
    const x = MARKERS.find((r) => r.role === role);
    if (!x) throw new Error(`脑区的开场白里没有 ${role}（regions/specs.ts 变了）`);
    return x.marker;
  };
  const tools = [
    { name: "Bash", description: "跑一条命令。", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
    { name: "Read", description: "读一个文件。", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
    { name: "DeferredToolPlaceholder", description: "", input_schema: {} },
    { name: "mcp__self__message", description: "给一个人或一个群发消息。", input_schema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
    { name: "mcp__self__on_it", description: "开始做一件要花些时间的事，估一下多久。", input_schema: { type: "object", properties: { topic: { type: "string" }, about_min: { type: "number" } } } },
    { name: "mcp__self__remember", description: "按意思想起相关的事。", input_schema: { type: "object", properties: { cue: { type: "string" } } } },
    { name: "mcp__self__jot_down", description: "随手记一笔。", input_schema: { type: "object", properties: { text: { type: "string" } } } },
  ];
  const system = [
    "<intro>\n（演示用的假内容）Claude Code 自带的开场介绍。",
    "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
    "<communication>\n（演示用的假内容）怎么跟人说话：简短、直接。",
    "# Tone and style\n（演示用的假内容）Be brief.",
    prefixText(c, m.midterm),
  ];
  const head = (at: number): unknown[] => [
    { type: "queue-operation", operation: "enqueue" },
    { type: "attachment", timestamp: iso(at), attachment: { type: "environment" }, rendered: [{ content: `工作目录：${ws}\n系统：darwin` }], renderedRole: "system" },
    { type: "attachment", timestamp: iso(at), attachment: { type: "date" }, rendered: [{ content: `今天是 ${c.today}。` }], renderedRole: "system" },
    { type: "attachment", timestamp: iso(at), attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch", "WebSearch", "mcp__bili__search", "mcp__weather__forecast"], removedNames: [] }, rendered: [{ content: "这些工具先只给名字，用到时再加载：WebFetch、WebSearch、mcp__bili__search、mcp__weather__forecast" }], renderedRole: "system" },
    { type: "attachment", timestamp: iso(at), attachment: { type: "skill_listing" }, rendered: [{ content: "- 做饭：家常菜的做法和教训\n- 看天气：出门前怎么看预报\n- 学习方法：怎么背、怎么复习" }], renderedRole: "system" },
    { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: system } },
    { type: "api-request-shape", shape: { system: [{ type: "text", text: "（同上）" }], tools } },
  ];
  /** 一个脑区的一份会话：开场的附件 + 对话；last = 最后更新的时刻 */
  const session = (id: string, last: number, steps: Step[], ctx: number, model = CFG.models.opus): void => {
    const start = last - steps.length * 24_000;
    put(join(projectDirFor(join(dir, "projects"), ws), `${id}.jsonl`), jsonl([...head(start), ...chat(start, steps, { model, ctx })]), last);
  };
  const side = (topic: string): string => `<记忆>\n（弄「${topic}」时）我想：先看周六的天气。\n（弄「${topic}」时）我做了：python3 tools/weather.py --day sat\n</记忆>`;
  session(SESSION.main, now - 10_000, [
    { user: `${marker("main")}你是${ME}。别人发来的消息会到这里，开口说话也是这里。\n\n下面是你最近的经历：\n\n<记忆>\n${OWNER}说：晚饭想吃清淡点，冰箱里有番茄和鸡蛋。\n</记忆>\n\n【只给你看：现在是傍晚，电脑不忙；今天的目标还差「背第 12 课单词」。】` },
    { think: "" },
    { tool: "mcp__self__remember", input: { cue: "番茄炒蛋 火候" }, result: `想起来的（编号可以用 recall_event 展开）：\n· 第一次做番茄炒蛋〔3〕${m.event}：教${OWNER}做番茄炒蛋，蛋炒老了` },
    { think: "上次蛋炒老了，是火大。这次提醒他用中火。" },
    { say: "那就番茄炒蛋配青菜汤吧。这次中火，蛋液凝固一半就盛出来。" },
    { attach: "hook_additional_context", text: `<记忆>\n我看到 ${GROUP} 里 ${YI} 在问周六野餐谁带垫子。\n</记忆>` },
    { user: `【只给你看：${YI}在${GROUP}里问谁带垫子；${OWNER}的卡：主人｜更近｜每天都来问天气和晚饭。】\n${OWNER}（whatsapp）：对了，周六野餐你帮我列个清单。` },
    { tool: "mcp__self__on_it", input: { topic: "列周六野餐清单", about_min: 15 }, result: "开始了：列周六野餐清单（估 15 分钟）。" },
    { say: "好，清单我来列，一会儿给你。" },
    { user: side("列周六野餐清单") },
    { user: `<记忆>\n（弄「列周六野餐清单」时）我记下：清单好了，周六晴。\n</记忆>\n${JIA}（wx）：${ME}，番茄炒蛋要不要放糖？` },
    { tool: "Bash", input: { command: "python3 tools/quiz.py --lesson 12" }, result: "FileNotFoundError: [Errno 2] No such file or directory: 'tools/quiz.py'", error: true },
    { say: "我一般出锅前放一小撮，提鲜。你爱吃甜的可以多放一点。" },
  ], 3_300);
  session(SESSION.mainOld, now - 11 * HOUR, [
    { user: `${marker("main")}你是${ME}。\n\n下面是你最近的经历：\n\n<记忆>\n${OWNER}说：今晚想吃番茄炒蛋，你教我？\n</记忆>` },
    { think: "正好是学做饭的第一道，把步骤理清楚。" },
    { say: "三步：先炒蛋到半熟盛出，再炒番茄，最后合在一起。" },
  ], 2_900);
  session(SESSION.side1, now - MIN, [
    { user: `${marker("side")}你是${ME}，还是同一个你：你在一边做着一件要花些时间的事。\n\n这件事：列周六野餐清单（估 15 分钟）。` },
    { think: "吃的、喝的、垫子、垃圾袋。先看周六的天气。" },
    { tool: "Bash", input: { command: "python3 tools/weather.py --city maplebay --day sat" }, result: "周六：晴，14–22 度，北风 3 级。" },
    { tool: "mcp__self__jot_down", input: { text: "清单初稿好了：三明治、水果、气泡水、垫子、垃圾袋。" }, result: "记下了。" },
  ], 2_250);
  session(SESSION.side2, now - 19 * MIN, [
    { user: `${marker("side")}你是${ME}，还是同一个你。\n\n这件事：背今天的日语单词（估 20 分钟）。` },
    { think: "第 12 课，先过一遍再默写。" },
    { tool: "Read", input: { file_path: "notes/日语/第12课.md" }, result: "曇り（くもり）阴天\n涼しい（すずしい）凉快\n……共 20 个" },
    { say: "背完了，错了 3 个。" },
  ], 1_500);
  session(SESSION.speech, now - 50 * MIN, [
    { user: `${marker("speech")}你是${ME}。别人找你、你还在想的时候，先随口应一句很短的。\n\n${OWNER}：对了，周六野餐你帮我列个清单。` },
    { say: "好，马上列。" },
  ], 950, CFG.models.haiku);
  session(SESSION.hippocampus, now - 45 * MIN, [
    { user: `${marker("hippocampus")}你是${ME}。要翻页了，把这一页经历压成一段压缩记忆。` },
    { think: "留下：还书的提醒、晚饭的决定、野餐清单和周六的天气。" },
    { say: BLOCK3 },
  ], 2_700);
}

function seedFiles(c: Ctx, m: Seeded): void {
  const { dir, now, yesterday } = c;
  const at = (minAgo: number): number => now - minAgo * MIN;
  const log: Array<[number, string, string, string, Record<string, unknown>]> = [
    [1800, "info", "hhd", "started", { pid: 4242 }],
    [1560, "info", "hhd.brain", "page turned", { page: 2 }],
    [1300, "warn", "hhd.gate", "judge timed out, sent to the digest", { ms: 60_000, batch: 2 }],
    [1080, "info", "hhd.brain", "asleep", { reason: "夜里" }],
    [640, "info", "hhd.sleep", "night flow committed", { days: [yesterday] }],
    [180, "error", "hhd.kernel", "region session ended unexpectedly, reopening", { region: "main", code: 1 }],
    [179, "info", "hhd", "started", { pid: 4310 }],
    [42, "warn", "hhd.learning", "embedding unavailable, association skipped", { binding: "hands" }],
    [22, "warn", "hhd.brain", "tool failed", { region: "side-2", tool: "Bash", error: "FileNotFoundError: tools/quiz.py" }],
    [20, "error", "hhd.mem", "vector backfill failed", { error: "向量服务没回应（演示用的假错误）" }],
  ];
  put(join(dir, "logs/hh.jsonl"), jsonl(log.map(([ago, level, mod, msg, extra]) => ({ t: iso(at(ago)), level, mod, msg, ...extra }))), at(20));
}

/** 假 hhd 回的 status（真的在 brain.ts 的 status()）：醒着、专注中，主意识和一边做着的两件事在想，随口空着，潜意识和海马没开 */
function statusOf(c: Ctx, db: Db, m: Seeded): BrainStatus {
  const { now, tz } = c;
  const pageTokens = new CentralMemory(db).pageTokens(m.page);
  const week = { used: 41, resetsAt: now + 3 * DAY, level: 0 };
  const idle = { open: false, busy: false, contextTokens: 0, generation: 0, sessionId: null };
  const regions: Record<string, { open: boolean; busy: boolean; contextTokens: number; generation: number; sessionId: string | null }> = {
    main: { open: true, busy: true, contextTokens: 4_310, generation: 3, sessionId: SESSION.main },
    "side-1": { open: true, busy: true, contextTokens: 2_610, generation: 2, sessionId: SESSION.side1 },
    "side-2": { open: true, busy: true, contextTokens: 1_860, generation: 1, sessionId: SESSION.side2 },
    speech: { open: true, busy: false, contextTokens: 1_050, generation: 3, sessionId: SESSION.speech },
    hippocampus: { ...idle, generation: 5 },
  };
  // 闸门今天的账照库里的数（上面 seedGate 写的）
  const from = gateDayRange(c.today, tz)!.from;
  const tally = (col: string, extra = ""): Record<string, number> =>
    Object.fromEntries(all<{ k: string; n: number }>(db, `SELECT ${col} AS k, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ${col} IS NOT NULL${extra} GROUP BY k`, from).map((r) => [r.k, r.n]));
  const gate = one<{ n: number; j: number; tok: number; u: number; main: number }>(db,
    "SELECT COUNT(*) AS n, COALESCE(SUM(tokens > 0), 0) AS j, COALESCE(SUM(tokens), 0) AS tok, COALESCE(SUM(units), 0) AS u, COALESCE(SUM(when_ IS NOT NULL AND delivered IS NOT NULL), 0) AS main FROM gate_log WHERE ts >= ?", from)!;
  const changed = new Intl.DateTimeFormat("zh-CN", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(now - 5 * HOUR);
  return {
    alertness: "awake", epoch: m.page, pageTokens, pageView: Math.round(pageTokens * 1.12), pageViewRaw: pageTokens, pageViewK: 1.12,
    compactedTokens: new Epochs(db).compactedTokens(),
    focusSlot: CFG.schedule.focusSlots.at(-1) ?? "18:00", focusUntil: new Date(now + 25 * MIN).toLocaleString("zh-CN", { timeZone: tz }),
    turning: false, frontIdle: false, nightRest: false,
    regions: REGION_IDS.map((id) => ({ id, ...(regions[id] ?? idle) })),
    todos: 0,
    quota: quotaSummary({ sevenDay: week, at: now }, tz, now),
    quotaUsed: { fiveHour: null, sevenDay: week.used, fiveHourResetsAt: null, sevenDayResetsAt: week.resetsAt, at: now - 2 * MIN },
    claims: [{ topic: "背今天的日语单词", owner: "side-2" }, { topic: "剪番茄炒蛋的视频", owner: "side-1" }],
    gate: { received: gate.n, byRoute: tally("route"), byVerdict: tally("verdict", " AND route = 'judge'"), byRule: tally("rule"), judgeCalls: gate.j, tokens: gate.tok, units: gate.u, toMain: gate.main, paused: null, mainWakes: gate.main },
    rulesErrors: [],
    registryChanges: [`${changed} 名单：新加 ${YI}（访客）`],
  };
}

// ---------- 一份假数据：中文这份在上面，英文那份在 console-demo-en.ts ----------

/** 一份假数据怎么造、起控制台时要配的那几样（运行说明、过渡句、开场白、人物卡模板） */
export interface DemoSeeds {
  lang: "zh" | "en";
  names: { me: string; owner: string; ta?: string };
  /** 默认端口 */
  port: number;
  runtimeNote: string; frame: string; markers: RoleMarker[];
  /** what the page scripts recognise of this demo role's text */
  marks: PageMarks;
  /** 人物卡模板（写卡和控制台读卡用同一份） */
  peopleTemplate: unknown;
  /** 控制台要不要列书架（learning.shelf） */
  shelf: boolean;
  workspace(c: Ctx): void;
  memory(c: Ctx, db: Db): Seeded;
  gate(c: Ctx, db: Db): void;
  learn(c: Ctx, db: Db): void;
  workers(c: Ctx): void;
  sessions(c: Ctx, m: Seeded): void;
  files(c: Ctx, m: Seeded): void;
  status(c: Ctx, db: Db, m: Seeded): BrainStatus;
  sample: { session: string; worker: string };
  /** 这份假数据按一天里哪个时刻写的（不给就是真的现在）：给了，命令行起演示时数据和控制台的钟都定在这个时刻 */
  clockAt?: (realNow: number, tz: string) => number;
}

export const ZH: DemoSeeds = {
  lang: "zh", names: { me: ME, owner: OWNER, ta: "她" }, port: 7797,
  runtimeNote: RUNTIME_NOTE, frame: memoryFrame(), markers: MARKERS, marks: pageMarks(), peopleTemplate: CFG.memory?.people?.template, shelf: true,
  workspace: seedWorkspace, memory: seedMemory, gate: seedGate, learn: seedLearn, workers: seedWorkers, sessions: seedSessions, files: seedFiles, status: statusOf,
  sample: { session: SESSION.main, worker: WORKERS[0]!.name },
};

/** 按语言取一份；英文那份另一个文件（names 只对英文那份有用） */
export async function seedsFor(lang: "zh" | "en", names: { me?: string; owner?: string } = {}): Promise<DemoSeeds> {
  if (lang === "zh") return ZH;
  const { enSeeds } = await import("./console-demo-en.ts");
  return enSeeds(names);
}

// ---------- 笔记页（层和线）的假数据 ----------
// 三大类九本、三十多页，都是编的：有浅有中有深，有重要但很久没翻的，有从没翻过的，有没连上线的。
// 前四页是 seedWorkspace 已经写好的（做饭两页、看天气一页、学习方法一页），这里只补它们的翻开记录。
/** [中文, 英文] */
type Two = readonly [string, string];
/** 一页：编号、名字、页上写的重要度（3 就不写）、哪几天前翻过（null = 从没翻过）、多少天前第一次扫到 */
type NotePage = readonly [id: string, title: Two, importance: number, opened: readonly number[] | null, seen: number];
const NOTE_BOOKS: ReadonlyArray<{ category: Two; book: Two; about: Two | null; pages: readonly NotePage[] }> = [
  { category: ["做事", "doing"], book: ["做饭", "cooking"], about: null, pages: [
    ["0012", ["番茄炒蛋", "tomato-and-egg"], 3, [3, 6, 9], 40], ["0013", ["红烧肉", "braised-pork-belly"], 3, null, 60],
    ["0101", ["蒸蛋羹", "Steamed egg custard"], 3, [4, 12], 50], ["0102", ["煮面", "Noodles in broth"], 3, [20], 70],
    ["0103", ["腌黄瓜", "Quick pickles"], 3, [41], 80], ["0104", ["电饭锅蛋糕", "Rice-cooker cake"], 3, null, 20],
  ] },
  { category: ["做事", "doing"], book: ["看天气", "weather"], about: null, pages: [
    ["0021", ["带伞", "umbrella"], 3, [1, 2, 5, 8], 45], ["0105", ["晾衣服", "Drying laundry"], 3, [2, 15], 60], ["0106", ["大风天", "Windy days"], 3, null, 75],
  ] },
  { category: ["做事", "doing"], book: ["剪视频", "video"], about: ["剪片子的做法和教训", "how to cut a video, and lessons learned"], pages: [
    ["0110", ["剪节奏", "Cutting rhythm"], 5, [0, 1, 3, 4, 7], 90], ["0111", ["配字幕", "Subtitles"], 4, [3, 10], 90], ["0112", ["选封面", "Picking a cover"], 4, [38], 90],
    ["0113", ["导出设置", "Export settings"], 3, [6], 90], ["0114", ["配乐", "Music"], 3, [33], 90],
  ] },
  { category: ["做事", "doing"], book: ["列清单", "lists"], about: ["出门、搬家、买东西之前列的单子", "lists made before outings, moves and shopping"], pages: [
    ["0120", ["野餐清单", "Picnic list"], 3, [0, 1], 10], ["0121", ["搬家清单", "Moving checklist"], 3, [52], 100], ["0122", ["买菜", "Groceries"], 3, [1, 3, 8, 13, 20], 100],
  ] },
  { category: ["通用", "general"], book: ["学习方法", "study"], about: null, pages: [
    ["0003", ["间隔复习", "spaced-review"], 3, [2, 5, 9], 60], ["0130", ["记单词", "Memorising words"], 4, [0, 2, 6], 60],
    ["0131", ["做笔记", "Taking notes"], 3, [14], 60], ["0132", ["复盘", "Reviewing the day"], 5, null, 58],
  ] },
  { category: ["通用", "general"], book: ["说话", "talking"], about: ["话怎么说才合适", "how to say things well"], pages: [
    ["0140", ["道歉", "Apologising"], 5, [5, 19], 120], ["0141", ["拒绝", "Saying no"], 4, [45], 120],
    ["0142", ["安慰人", "Comforting someone"], 4, [8], 120], ["0143", ["开玩笑的分寸", "Where a joke stops"], 3, [27], 120],
  ] },
  { category: ["通用", "general"], book: ["查资料", "research"], about: ["怎么查、怎么核对", "how to look things up and check them"], pages: [
    ["0150", ["先看原始出处", "Primary sources first"], 4, [1, 4, 11], 80], ["0151", ["交叉核对", "Cross-checking"], 3, [4, 11], 80], ["0152", ["记下出处", "Keeping the source"], 3, null, 9],
  ] },
  { category: ["关系", "people"], book: ["家里人", "family"], about: ["和家里人相处", "getting along with family"], pages: [
    ["0160", ["生日和纪念日", "Birthdays and anniversaries"], 5, [2, 16], 150], ["0161", ["报平安", "Checking in"], 3, [36], 150], ["0162", ["送礼", "Gifts"], 3, [22], 150],
  ] },
  { category: ["关系", "people"], book: ["朋友", "friends"], about: ["和朋友相处", "getting along with friends"], pages: [
    ["0170", ["约时间", "Making plans"], 3, [0, 3], 30], ["0171", ["借东西要还", "Returning what you borrow"], 4, [1], 30], ["0172", ["群里说话", "Talking in the group"], 3, [64], 200],
  ] },
];
/** 页里互相指（a 指 b） */
const NOTE_REFS: ReadonlyArray<readonly [string, string]> = [
  ["0012", "0101"], ["0012", "0013"], ["0101", "0102"], ["0021", "0105"], ["0105", "0106"], ["0110", "0111"], ["0110", "0114"], ["0111", "0113"], ["0112", "0110"],
  ["0120", "0122"], ["0121", "0120"], ["0003", "0130"], ["0130", "0131"], ["0132", "0003"], ["0140", "0142"], ["0141", "0140"], ["0150", "0151"], ["0151", "0152"],
  ["0160", "0162"], ["0170", "0171"], ["0142", "0160"], ["0120", "0021"], ["0122", "0012"],
];
/** 一起被翻过、同一件事里用到（没有方向，小号在前）：[a, b, 权重] */
const NOTE_CO: ReadonlyArray<readonly [string, string, number]> = [
  ["0003", "0130", 2.5], ["0012", "0122", 3.2], ["0021", "0120", 1.8], ["0110", "0111", 4], ["0110", "0113", 1.2], ["0111", "0113", 0.8], ["0120", "0170", 1.5], ["0130", "0131", 0.6],
  ["0140", "0142", 2.2], ["0150", "0151", 3.5], ["0012", "0101", 1.1], ["0021", "0105", 2], ["0160", "0162", 0.9], ["0170", "0171", 1.4], ["0003", "0131", 0.5], ["0110", "0112", 0.7],
  ["0120", "0122", 1.3], ["0105", "0120", 0.6], ["0012", "0021", 0.4], ["0130", "0150", 0.5], ["0101", "0102", 0.9], ["0142", "0171", 0.4],
];
const NOTE_EVENT: ReadonlyArray<readonly [string, string, number]> = [["0012", "0122", 2], ["0021", "0120", 3], ["0120", "0170", 1], ["0110", "0111", 2], ["0140", "0141", 1], ["0160", "0171", 1]];

function seedNotebook(c: Ctx, db: Db, lang: "zh" | "en"): void {
  const { ws, now } = c;
  const i = lang === "en" ? 1 : 0;
  const item = db.prepare("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen) VALUES (?, 'page', ?, 'demo', ?, ?)");
  const open = db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', ?, NULL)");
  for (const b of NOTE_BOOKS) {
    const dir = `${b.category[i]}/${b.book[i]}`;
    // about 是 null 的那几本，封面和头几页 seedWorkspace 已经写了
    if (b.about) put(join(ws, "skills", dir, "SKILL.md"), `---\nname: ${b.book[i]}\ndescription: ${b.about[i]}\n---\n`, now - 20 * DAY);
    for (const [id, title, importance, opened, seen] of b.pages) {
      const name = title[i];
      const file = lang === "en" ? name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : name;
      if (Number(id) >= 100) {
        const head = importance === 3 ? "" : `importance: ${importance}\n`;
        const body = lang === "en"
          ? `Summary: notes and lessons on ${name.toLowerCase()}.\nWhen to open: whenever ${name.toLowerCase()} comes up.\n\n## How\n- (demo page)\n`
          : `简介：${name}的做法和教训。\n什么时候翻：碰到${name}的时候。\n\n## 做法\n- （演示用的一页）\n`;
        put(join(ws, "skills", dir, `${file}.md`), `# ${name} <!-- p:${id} -->\n${head}${body}`, now - Math.min(seen, 30) * DAY);
      }
      item.run(id, `${dir}/${file}.md`, now - seen * DAY, now - HOUR);
      for (const d of opened ?? []) open.run(now - d * DAY - 2 * HOUR, id);
    }
  }
  const link = db.prepare("INSERT INTO learn_link (a, b, kind, weight, n, updated) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [a, b] of NOTE_REFS) link.run(a, b, "ref", 1, 1, now - 10 * HOUR);
  for (const [a, b, w] of NOTE_CO) link.run(a, b, "co", w, Math.ceil(w * 2), now - 10 * HOUR);
  for (const [a, b, w] of NOTE_EVENT) link.run(a, b, "event", w, w, now - 10 * HOUR);
}

// ---------- 建、起 ----------

/** 目录不在就建；空的直接用；是演示目录（有我们的记号）就把我们建的删掉重来；别的非空目录不动 */
function prepare(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const names = readdirSync(dir);
  if (names.length && !names.includes(MARKER)) throw new Error(`${dir} 里有别的东西，又不是演示目录（没有 ${MARKER}）：不动它。换一个空目录，或者不给 --dir`);
  for (const n of MADE) rmSync(join(dir, n), { recursive: true, force: true });
  writeFileSync(join(dir, MARKER), "{}");   // 先放记号：建到一半挂了，下次还能重建
}

// ---------- 早上的开头：醒来那一页主线的开场存档（hhd 存的那种文件，内容是编的） ----------
function seedWake(c: Ctx, lang: "zh" | "en", names: { me: string; owner: string }): void {
  const body = (day: string): string => (lang === "en"
    ? [
      `<!-- HH: the main session's opening on the page ${names.me} woke up to, ${day} -->`,
      "===== Always in context (the part of this session's system prompt that HH assembles, verbatim) =====",
      `# How you run now\n\nYou are ${names.me}. You slept, and the night's consolidation is done.\n\n# Recently\n\n- ${names.owner} is learning to cook; first lesson was tomato and egg stir-fry.`,
      "===== Opening (this session's first message, verbatim) =====",
      `It is morning. The page before this one was summarized during the night. Nobody is waiting for a reply.`,
      "",
    ]
    : [
      `<!-- HH：醒来那一页主线的开场，${day} -->`,
      "===== 前缀（这个会话的系统提示里 HH 拼的那一段，原样）=====",
      `# 你现在怎么运行\n\n你是${names.me}。你睡了一觉，夜里的整理做完了。\n\n# 最近这一段\n\n- ${names.owner}在学做饭，第一道是番茄炒蛋。`,
      "===== 开场（这个会话的第一条消息，原样）=====",
      "现在是早上。上一页已经在夜里整理过。没有谁在等回复。",
      "",
    ]).join("\n");
  put(join(c.dir, "wake", `${c.today}-073012.md`), body(c.today), c.now - 12 * HOUR);
  put(join(c.dir, "wake", `${c.yesterday}-064500.md`), body(c.yesterday), c.now - 36 * HOUR);
}

// ---------- 修理的留痕：几次部署和重启（「顺不顺」那一页按它分段；提交号和说明都是编的） ----------
function seedRepair(c: Ctx, lang: "zh" | "en"): void {
  const clock = new HourClock(c.tz);
  /** 今天（或昨天）她当地几点几分 → 时刻；还没到的不写 */
  const today = clock.startOf(c.now) - clock.label(clock.startOf(c.now)).hour * HOUR;
  const rows: unknown[] = [];
  const add = (t: number, row: Record<string, unknown>): void => { if (t <= c.now) rows.push({ ...row, t: iso(t) }); };
  const en = lang === "en";
  const deploy = (t: number, from: string, to: string, items: string[], by = "ops"): void => {
    add(t, { kind: "deploy", by, from, to, text: en ? `deployed ${from} → ${to} (${items.length} ${items.length === 1 ? "commit" : "commits"}); restarts when idle` : `部署了 ${from} → ${to}（${items.length} 个提交）；等她闲下来自己重启`, items });
    add(t + 2 * MIN, { kind: "restart", to, text: en ? "idle, restarting for the deploy" : "她闲着，为部署重启" });
    add(t + 2 * MIN + 1_500, { kind: "boot", to, text: en ? "core process started" : "hhd 起来了" });
    add(t + 5 * MIN, { kind: "healthy", to, text: en ? "this version finished its first round" : "这一版跑完了第一轮" });
  };
  deploy(today - 14 * HOUR, "a1b2c3d", "b2c3d4e", en ? ["b2c3d4e session: ops: nightly report lists stale notebook pages"] : ["b2c3d4e session：ops：夜里的报告列出很久没翻的笔记页"]);
  deploy(today + 9 * HOUR + 40 * MIN, "b2c3d4e", "c3d4e5f", en
    ? ["c3d4e5f session: dev: weather replies check the afternoon forecast too", "c3d4e50 session: dev: test for the above"]
    : ["c3d4e5f session：dev：回天气时把下午的预报也看了", "c3d4e50 session：dev：上面那条的测试"], "dev");
  deploy(today + 15 * HOUR + 52 * MIN, "c3d4e5f", "d4e5f6a", en ? ["d4e5f6a session: ops: a larger context window for the picnic planner"] : ["d4e5f6a session：ops：列清单的那一头上下文放大"]);
  deploy(today + 17 * HOUR + 20 * MIN, "d4e5f6a", "e5f6a7b", en ? ["e5f6a7b session: ops: hotfix, the planner goes back to the smaller window"] : ["e5f6a7b session：ops：热修，列清单的那一头改回小窗口"]);
  put(join(c.dir, "repair", "log.jsonl"), jsonl(rows), c.now - 2 * HOUR);
}

// ---------- 「这一周」那张表：两周的被叫醒和额度读数（日志里 info 级的行，右栏的告警里看不到） ----------
/** 演示里团队的活放的目录（在演示目录下面；只是拿它的名字认会话记录，目录本身不用建） */
const TEAM_DIR = "team";
function seedWeekLog(c: Ctx): void {
  const causes = ["human", "human", "focus", "gate", "reminder", "human", "helper", "focus", "wander", "human", "senses", "message"];
  const rows: Array<{ t: string }> = [];
  for (let d = 14; d >= 0; d--) {
    const wakes = 6 + ((d * 5) % 7);
    for (let i = 0; i < wakes; i++) {
      const t = c.now - d * DAY - (i + 1) * 47 * MIN;
      if (t <= c.now) rows.push({ t: iso(t), level: "info", mod: "hhd.brain", msg: "main wake", cause: causes[(d + i) % causes.length] } as { t: string });
    }
    // 周额度：每天涨几个点，七天前重置过一次
    const used = (k: number): number => { const since = (14 - d) % 7; return Math.min(100, since * 6 + k * 3); };
    for (const k of [0, 1, 2]) rows.push({ t: iso(c.now - d * DAY - (2 - k) * 5 * HOUR - 13 * MIN), level: "info", mod: "hhd.quota", msg: "quota reading", sevenDay: { used: used(k), resetsAt: 1 } } as { t: string });
  }
  const logPath = join(c.dir, "logs/hh.jsonl");
  const old = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string });
  put(logPath, jsonl([...old, ...rows.filter((r) => Date.parse(r.t) <= c.now)].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))), c.now - 20 * MIN);
  // 两周的用量：主工作区的放在一个子目录里（「顺不顺」只数第一层的会话记录，这些不算请求；用量照样算在 HH 上），帮手的放在帮手的目录里
  const use = (dir: string, per: (d: number) => Record<string, number>): void => {
    const lines: unknown[] = [];
    for (let d = 14; d >= 0; d--) for (let i = 0; i < 6; i++) {
      const t = c.now - d * DAY - (i + 1) * 95 * MIN;
      lines.push({ type: "assistant", timestamp: iso(t), requestId: `req_week_${d}_${i}`, message: { id: `msg_week_${dir.length}_${d}_${i}`, usage: per(d) } });
    }
    put(join(c.dir, "projects", dir, "week.jsonl"), jsonl(lines), c.now - 30 * MIN);
  };
  use(join(projectDirFor("", c.ws).replace(/^\//, ""), "demo-week", "subagents"), (d) => ({ cache_read_input_tokens: 9_000_000 + (d % 4) * 2_500_000, cache_creation_input_tokens: 400_000, input_tokens: 60_000, output_tokens: 180_000 + (d % 3) * 40_000 }));
  use("-demo-work-picnic-list", (d) => ({ cache_read_input_tokens: 2_000_000 + (d % 5) * 900_000, cache_creation_input_tokens: 150_000, input_tokens: 20_000, output_tokens: 60_000 }));
  // 团队借她的额度干活：在团队自己的目录下跑（startDemo 把这个目录配成团队目录），只有最近四天有
  use(projectDirOf(join(c.dir, TEAM_DIR, "tuning")), (d): Record<string, number> => (d <= 3 ? { cache_read_input_tokens: 3_000_000 + d * 700_000, cache_creation_input_tokens: 200_000, input_tokens: 30_000, output_tokens: 90_000 } : {}));
}

// ---------- 「顺不顺」那一页：最近 24 小时的请求、几次被停、几下卡顿 ----------
/** 她当地几点 → 这个小时内核收到几个请求（编的：三点睡到七点没有，白天几十个） */
const REQUESTS_AT = [9, 5, 3, 0, 0, 0, 0, 12, 38, 52, 47, 55, 41, 36, 49, 58, 61, 44, 39, 33, 28, 22, 14, 6];

/**
 * 主工作区会话目录下一份只有请求行的记录（没有开场白，「完整输入」不把它当成哪个脑区的会话），和日志里几行卡顿。
 * 下午四点那个小时编了一小段不顺：被停 4 次（3 次两种记号都有、1 次只有提示）、被拒 1 次、卡了 3 下；五点还有 1 次被停。
 * stalls 不给时日志不动（英文演示的日志栏不放告警）。提示那句话引用常量，原文不写在这里。
 */
function seedHealth(c: Ctx, o: { stalls: boolean }): void {
  const { dir, ws, now, tz } = c;
  const clock = new HourClock(tz);
  const rows: unknown[] = [];
  const stalls: Array<{ t: number; ms: number }> = [];
  // 内核（CLI）版本：今天 15:54 那次起来（seedRepair 里 15:52 的部署）以后换了一版，版本号是编的
  const switched = clock.startOf(now) - clock.label(clock.startOf(now)).hour * HOUR + 15 * HOUR + 54 * MIN;
  const request = (t: number, id: string, stop: string | null = null): void => { rows.push({ type: "assistant", timestamp: iso(t), requestId: id, version: t < switched ? "9.1.100" : "9.1.101", message: { role: "assistant", model: CFG.models.opus, stop_reason: stop, content: [] } }); };
  const notice = (t: number, id: string): void => { rows.push({ type: "system", subtype: "informational", timestamp: iso(t), uuid: id, content: `The model's ${STOP_NOTICE}.` }); };
  for (let k = 24; k >= 0; k--) {
    const start = clock.startOf(now - k * HOUR);
    const hour = clock.label(start).hour;
    const n = REQUESTS_AT[hour]!;
    for (let i = 0; i < n; i++) {
      const t = start + Math.floor((i + 0.5) * HOUR / n);
      if (t >= now) break;
      const bad = hour === 16 ? [7, 19, 33].includes(i) : hour === 17 ? i === 11 : false;
      request(t, `req_demo_${k}_${i}`, bad ? "refusal" : null);
      if (bad && hour === 16) notice(t + 3_000, `notice_demo_${k}_${i}`);
    }
    if (hour === 16 && start + 50 * MIN < now) {
      notice(start + 41 * MIN, `notice_demo_${k}_only`);
      rows.push({ type: "system", subtype: "model_refusal_no_fallback", timestamp: iso(start + 44 * MIN), uuid: `refused_demo_${k}` });
      stalls.push({ t: start + 12 * MIN, ms: 2_400 }, { t: start + 13 * MIN, ms: 6_100 }, { t: start + 40 * MIN, ms: 3_200 });
    }
    if (hour === 10 && start + 30 * MIN < now) stalls.push({ t: start + 21 * MIN, ms: 2_200 });
  }
  put(join(projectDirFor(join(dir, "projects"), ws), "demo-requests.jsonl"), jsonl(rows), now - MIN);
  if (!o.stalls || !stalls.length) return;
  // 卡顿的几行按时间插回日志里（日志是按时间往后写的）
  const logPath = join(dir, "logs/hh.jsonl");
  const old = readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { t: string });
  const added = stalls.map((s) => ({ t: iso(s.t), level: "warn", mod: "hhd", msg: "event loop blocked", ms: s.ms, alertness: "awake", turning: false, busy: ["main"], replay: false }));
  put(logPath, jsonl([...old, ...added].sort((a, b) => Date.parse(a.t) - Date.parse(b.t))), now - 20 * MIN);
}

/** 在 dir 里造一份完整的假状态；时间都从 now 往前排，「今天」按 tz（不给就是这台机器的时区，和浏览器对得上） */
export function buildDemo(dirIn: string, now: number, o: { tz?: string; seeds?: DemoSeeds } = {}): DemoInfo {
  const seeds = o.seeds ?? ZH;
  const dir = resolve(dirIn);
  const tz = o.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDay(now, tz);
  const c: Ctx = { dir, ws: join(dir, "ws"), now, tz, today, yesterday: shiftDay(today, -1), before: shiftDay(today, -2) };
  prepare(dir);
  seeds.workspace(c);
  const db = openDb(join(dir, "hh.db"));
  try {
    seedNotebook(c, db, seeds.lang);   // 在会话记录之前：前缀里的书架目录要和盘上的一样
    const m = seeds.memory(c, db);
    seeds.gate(c, db);
    seeds.learn(c, db);
    seeds.workers(c);
    seeds.sessions(c, m);
    seeds.files(c, m);
    seedHealth(c, { stalls: seeds.lang !== "en" });
    seedWake(c, seeds.lang, seeds.names);
    seedRepair(c, seeds.lang);
    seedWeekLog(c);
    writeFileSync(join(dir, STATUS_FILE), JSON.stringify(seeds.status(c, db, m), null, 2));
    const info: DemoInfo = {
      now, tz, lang: seeds.lang, names: seeds.names,
      sample: { session: seeds.sample.session, worker: seeds.sample.worker, block: m.block, file: "ws:MEMORY.md", event: m.event, entry: m.entry, person: m.person, batch: m.batch, yesterday: c.yesterday },
    };
    writeFileSync(join(dir, MARKER), JSON.stringify(info, null, 2));
    return info;
  } finally {
    db.close();
  }
}

/** 读演示目录的记号（buildDemo 写的） */
export function readDemo(dir: string): DemoInfo {
  let info: Partial<DemoInfo>;
  try { info = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as Partial<DemoInfo>; } catch { throw new Error(`${dir} 不是演示目录（没有 ${MARKER}）：先 buildDemo`); }
  if (typeof info.now !== "number" || typeof info.tz !== "string" || !info.sample) throw new Error(`${dir} 的演示数据没建完：重建一次`);
  info.lang ??= "zh";
  return info as DemoInfo;
}

/** 假的 hhd：在 hh.sock 上照 control.ts 的规矩收一行 JSON、回一行。只认 status（每次现读 hhd-status.json，手改了刷新就变）和 ping */
function fakeHhd(dir: string): Promise<{ close(): Promise<void> }> {
  const path = join(dir, "hh.sock");
  if (Buffer.byteLength(path) > 103) throw new Error(`${path} 太长：unix socket 的路径最多 103 字节，换一个短点的 --dir`);
  rmSync(path, { force: true });
  const socks = new Set<Socket>();
  const server: NetServer = createNetServer((sock) => {
    socks.add(sock);
    sock.on("close", () => socks.delete(sock));
    sock.on("error", () => { /* 客户端自己走了 */ });
    let buf = "";
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let reply: unknown;
        try {
          const cmd = (JSON.parse(line) as { cmd?: unknown }).cmd;
          reply = cmd === "status" ? { ok: true, data: JSON.parse(readFileSync(join(dir, STATUS_FILE), "utf8")) as unknown }
            : cmd === "ping" ? { ok: true, data: { ok: true } }
              : { ok: false, error: `假的 hhd 只认 status 和 ping（收到 ${String(cmd)}）` };
        } catch (e) {
          reply = { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (sock.writable) sock.write(JSON.stringify(reply) + "\n");
      }
    });
  });
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(path, () => done({
      close: () => new Promise<void>((r) => { for (const x of socks) x.destroy(); server.close(() => { rmSync(path, { force: true }); r(); }); }),
    }));
  });
}

/**
 * 拆分以前的单文件页面，脚本是内联的；现在服务端给页面的 CSP 不放行内联脚本，原样给它就是一张不会动的页面。
 * 所以只在 --page 时，「/」这一个地址由这里答：那份页面 + 拆分前的 CSP；别的地址照旧交给控制台（服务端代码不动）
 */
function serveOldPage(server: Server, html: string): void {
  const inner = server.listeners("request")[0] as (req: IncomingMessage, res: ServerResponse) => void;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const port = (server.address() as AddressInfo | null)?.port ?? 0;
    if (req.method !== "GET" || !hostAllowed(req.headers.host, port) || new URL(req.url ?? "/", "http://x").pathname !== "/") { inner(req, res); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": OLD_PAGE_CSP });
    res.end(html);
  });
}

export interface DemoOptions {
  /** buildDemo 建好的目录 */
  dir: string;
  /** 默认按语言（zh 7797、en 7798）；0 = 随便一个空的 */
  port?: number;
  /** 换一份网页文件（web/ 目录）；和 page 只能给一个 */
  web?: string;
  /** 拆分以前的单文件页面 */
  page?: string;
  /** 控制台的钟（测试用：和造数据的 now 对上）；不给就是真的现在 */
  now?: () => number;
  /** 建这个目录时用的那份假数据；不给就按目录里记的语言取 */
  seeds?: DemoSeeds;
}
export interface Demo { url: string; port: number; info: DemoInfo; close(): Promise<void> }

/** 在建好的演示目录上起控制台（选项照 main.ts 拼，路径全指进演示目录）和假 hhd */
export async function startDemo(o: DemoOptions): Promise<Demo> {
  if (o.web && o.page) throw new Error("--web 和 --page 只能给一个");
  const dir = resolve(o.dir);
  const info = readDemo(dir);
  const seeds = o.seeds ?? await seedsFor(info.lang ?? "zh", info.names ?? {});
  const ws = join(dir, "ws"), projects = join(dir, "projects");
  const oldPage = o.page ? readFileSync(o.page, "utf8") : null;
  const server = createConsole({
    dbPath: join(dir, "hh.db"),
    sockPath: join(dir, "hh.sock"),
    logPath: join(dir, "logs", "hh.jsonl"),
    helperSessionsDir: join(dir, "cc"),
    projectsDir: projects,
    ...(oldPage !== null ? { pageHtml: oldPage } : loadWeb(o.web ?? WEB_DIR)),
    memory: {
      workspace: ws,
      stateDir: dir,
      layout: DEMO_MEMORY_PAGE,
      sleepDir: "sleep", skillsDir: "skills",
      limits: LIMITS,
      files: DEMO_FILES,
      runtimeNote: seeds.runtimeNote,
      night: CFG.schedule.nightSleep,
      frame: seeds.frame,
      memoryFiles: MEMORY_FILES,
      events: EVENT_FLAGS,
    },
    people: { template: seeds.peopleTemplate, tz: info.tz },
    prompt: { dir: projectDirFor(projects, ws), markers: seeds.markers },
    gate: { workspace: ws, tz: info.tz, dailyUnits: CFG.gate.dailyUnits, haikuMultiplier: sleepWeights(CFG.sleep.weights).model.haiku, sources: DEMO_SOURCES },
    incidents: { dir: projectDirFor(projects, ws), logPath: join(dir, "logs", "hh.jsonl"), tz: info.tz, stateDir: dir },
    numbers: { projectsDir: projects, workspace: ws, replay: [join(dir, "replay")], team: [join(dir, TEAM_DIR)], tz: info.tz },
    learning: { root: join(ws, "skills"), generalCategory: CFG.learning.generalCategory, archiveDir: CFG.learning.archiveDir, residentFile: CFG.learning.residentFile, tz: info.tz, dailyUsd: CFG.learning.dailyUsd, shelf: seeds.shelf },
    demo: true, lang: seeds.lang, names: seeds.names, labels: DEMO_LABELS, regions: REGION_IDS, marks: seeds.marks,
    ...(o.now ? { now: o.now } : {}),
  });
  if (oldPage !== null) serveOldPage(server, oldPage);
  const hhd = await fakeHhd(dir);
  try {
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(o.port ?? seeds.port, "127.0.0.1", () => done()); });
  } catch (e) {
    await hhd.close();
    throw e;
  }
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`, port, info,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await hhd.close();
    },
  };
}

// ---------- 命令行 ----------

async function main(): Promise<void> {
  const { values: v } = parseArgs({ options: { dir: { type: "string" }, port: { type: "string" }, web: { type: "string" }, page: { type: "string" }, lang: { type: "string" }, me: { type: "string" }, owner: { type: "string" } } });
  const lang = v.lang ?? "zh";
  if (lang !== "zh" && lang !== "en") throw new Error(`--lang 只能是 zh 或 en（现在是 ${lang}）`);
  const seeds = await seedsFor(lang, { ...(v.me ? { me: v.me } : {}), ...(v.owner ? { owner: v.owner } : {}) });
  const port = v.port === undefined ? seeds.port : Number(v.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port 要是 0–65535 的整数（现在是 ${v.port}）`);
  if (v.web && v.page) throw new Error("--web 和 --page 只能给一个");
  const dir = v.dir ?? tmpDir("hh-console-demo-");
  // 这个目录上已经起着一个演示：重建会把它脚下的库和 hh.sock 换掉，先不动
  if (await request(join(dir, "hh.sock"), { cmd: "ping" }, 500).then(() => true, () => false)) throw new Error(`${resolve(dir)} 上已经起着一个演示（它的假 hhd 还在答应）：先停掉它，或者换一个 --dir`);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const info = buildDemo(dir, seeds.clockAt ? seeds.clockAt(Date.now(), tz) : Date.now(), { seeds, tz });
  const demo = await startDemo({ dir, port, seeds, ...(seeds.clockAt ? { now: () => info.now } : {}), ...(v.web ? { web: v.web } : {}), ...(v.page ? { page: v.page } : {}) });
  console.log(`假数据的控制台：${demo.url}/`);
  console.log(`  数据在 ${resolve(dir)}${v.dir ? "" : "（临时目录，退出时删）"}，时区 ${info.tz}；全是编的，时间从刚才往前排`);
  console.log(`  别的页：${demo.url}/#gate（下意识）  #mem（记忆）  #in:main（完整输入）  #ev:${info.sample.event}（事件记忆）  #w=${info.sample.worker}（帮手）`);
  console.log(`  顶栏的状态来自 ${join(resolve(dir), STATUS_FILE)}（假 hhd 每次现读，手改了刷新就变）`);
  const stop = (): void => { void demo.close().finally(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    console.error("用法：node test/console-demo.ts [--lang zh|en] [--dir <目录>] [--port <端口>] [--me <名字>] [--owner <名字>] [--web <目录>] [--page <文件>]");
    process.exit(1);
  });
}
