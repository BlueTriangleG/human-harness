// 工具文字的钉子（Task 0）：一张有名字的调用清单，每一条返回「今天这个工具在这种情况下说的原话」。
// 公共的部分（登记、指纹、拆成回复和其余、覆盖闸）在 test/textpins/lib.ts；这里只有工具的夹具和清单。
// 导入这个文件只登记 id，什么都不建：工具、假对象、临时目录、环境变量和时区都在 renderAll 里、每条调用的 run 里才动。
// 以后把 src/tools/ 里的文字挪走，这些调用算出的指纹必须一个字节不差（test/tools-text.pins.json 存着今天的指纹）。
// 这个文件和 pins 文件在 Task 0 之后不再改：挪文字时发现要加调用或改指纹，说明挪错了。
// 纯确定性：时钟、时区固定，临时目录来自 test/tmp.ts 并在文字里换成 <TMP>，没有网络、没有真网关、没有真库——
// 记忆库、网关、命令行都是下面手写的假货（转成真类型的样子照 test/send.test.ts、test/stickers.test.ts 的做法）。
// 夹具里的名字只用 阿青 / 老林 / 小禾，号码和编号都是编的。
// 0a 管 memtools.ts 和 stickers.ts 以及所有 def 变体（scratch 除外）；0b 管 browser.ts；0c 管发消息（src/channels/）、电脑（computer.ts）和 hhtools.ts 的提醒、目标这些；
// 0d 管 hhtools.ts 剩下的 what_reaches_me / people_i_know，以及 brain.ts 里 looked_again、checked 两个工具定义（def scratch/…）。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { mock } from "node:test";
import type { ToolDef } from "../../src/kernel/types.ts";
import { buildTools, parseEvery, parseWhen, whenLabel } from "../../src/tools/hhtools.ts";
import { closeComputerNow, computerExecutionId } from "../../src/tools/computer.ts";
import { openChannels } from "../../src/channels/send.ts";
import { badTarget, bridgeChannel, notConnected, serveBridge, withAttachments } from "../../src/channels/bridge.ts";
import type { OutboundMessage } from "../../src/channels/types.ts";
import type { ToolContext } from "../../src/tools/hhtools.ts";
import { MEM_LIKE_TOOLS, MEM_READ_TOOLS, MEM_STORE_WRITERS, MEM_WRITE_TOOLS, memTools } from "../../src/tools/memtools.ts";
import type { CheckCandidate, LearnNight } from "../../src/tools/memtools.ts";
import { stickerDestination, stickerTool } from "../../src/tools/stickers.ts";
import { browserTool } from "../../src/tools/browser.ts";
import type { Chrome } from "../../src/browser/chrome.ts";
import type { Page } from "playwright-core";
import { GatewayError, GatewayUnsure } from "../../src/gateway/client.ts";
import type { GatewayCaller } from "../../src/gateway/client.ts";
import { categoryMissing, notesUnreadable } from "./direct.ts";
import stickersModule from "../../modules/stickers/module.ts";
import type { ModuleContext } from "../../src/modules/api.ts";
import mediaModule from "../../modules/media/module.ts";
import goalsModule from "../../modules/goals/module.ts";
import { goalsTopic } from "../../src/parity/fakes.ts";
import type { EventMemory } from "../../src/memory/events/memory.ts";
import type { PeopleTemplate } from "../../src/memory/events/people.ts";
import type { Rule } from "../../src/gate/rules.ts";
import type { SenseEvent } from "../../src/gate/types.ts";
import { People } from "../../src/persona/people.ts";
import { approvedFrom, REGISTRY_FILE } from "../../src/persona/registry.ts";
import { makeBrain, TEST_SOURCES, testConfig } from "../helpers.ts";
import { FixtureError, caught, createRegistry, defText, makeNorm, need, renderAll as renderList, viaHandler, viaTool, withEnv } from "../textpins/lib.ts";
import type { Call, Rendered } from "../textpins/lib.ts";

/**
 * 本次运行的临时根的路径（只是一个名字，导入时不建）：renderAll 开始时建、结束时删。文字里它换成 <TMP>，所以每次运行随机的目录名不进指纹。
 * 手跑时 shell 里的 HH_* 不能漏进来（跟 test/helpers.ts 一样）、时区固定：也都在 renderAll 里做、做完还原
 */
const ROOT = join(tmpdir(), `hh-tooltext-${process.pid}-${randomBytes(4).toString("hex")}`);
const WS = join(ROOT, "workspace");
/** 2026-11-13 02:00 UTC */
const T0 = Date.UTC(2026, 10, 13, 2, 0);
const MIN = 60_000;

/** 工具名单一律传这个：新加的工具不会漏掉（includes 永远真） */
const everything = { includes: () => true } as unknown as readonly string[];

// ---------- 清单 ----------
// （公共的 viaTool / viaHandler / need / defText 在 test/textpins/lib.ts）
// 注意：清单里「rejects / refused by zod」的钉子里是 zod 自己的英文拒绝文字，只对锁定的 zod 版本成立（pins 文件的 env 记着版本）；升依赖之前先从那个提交重新钉（计划的风险 10）
const { add, calls } = createRegistry();

/**
 * 渲染整张清单：每条一个 { reply, rest }（见 splitRest）。先把环境理好（去掉 HH_*、时区 UTC、建临时根），跑完不管成不成都还原、删掉。
 * 夹具自己的错（TypeError / ReferenceError / FixtureError）不记成工具的话，直接抛
 */
export async function renderAll(): Promise<Record<string, Rendered>> {
  return withEnv({ deletePrefixes: ["HH_"], set: { TZ: "UTC" } }, async () => {
    mkdirSync(ROOT, { recursive: true });
    tryPeopleMade = undefined;   // 共用的名单夹具每次渲染重建：同一进程里跑两次互不相干
    try {
      return await renderList(CALLS, makeNorm(ROOT, [[/shot-\d+-/g, "shot-<T>-"]]));
    } finally {
      rmSync(ROOT, { recursive: true, force: true });
    }
  });
}

// ---------- 夹具：人 ----------
const WA_QING = "+6155500019";
const WA_ZHOU = "+6155500020";
const QQ_QING = "qqbot:c2c:AAAAAAAAAAAAAAAAAAAAAAAAAAAA0002";
const QQ_HE = "qqbot:c2c:AAAAAAAAAAAAAAAAAAAAAAAAAAAA0003";
const QQ_GROUP = "qqbot:group:AAAAAAAAAAAAAAAAAAAAAAAAAAAA0004";
const BOOK: Record<string, Record<string, string>> = {
  阿青: { whatsapp: WA_QING, qqbot: QQ_QING },
  老林: { whatsapp: WA_ZHOU },
  小禾: { qqbot: QQ_HE },
};
const NAMES: Record<string, string> = { [WA_QING]: "阿青", [QQ_QING]: "阿青", [WA_ZHOU]: "老林", [QQ_HE]: "小禾" };

// ---------- 夹具：工具上下文（表情包和 hh 变体用） ----------
type Chat = { channel: string; target: string; name?: string } | null;
type GwAnswer = "ok" | "refused" | "timeout" | "dropped";
interface CtxOpts {
  /** 不写 = 阿青在 WhatsApp 上；null = 这一轮不是被谁的消息叫起来的 */
  chat?: Chat;
  /** 不写 = 一分钟前；null = 没来过 */
  heard?: number | null;
  noHeardFn?: boolean; noResolver?: boolean; noNameOf?: boolean; noChatFn?: boolean; noGateway?: boolean;
  dryRun?: boolean;
  /** sticker.py prepare 的 stdout / 退出码 / stderr */
  stdout?: string; code?: number; stderr?: string;
  /** 网关按顺序怎么回（用完了回 ok） */
  gateway?: GwAnswer[];
}

const ITEM_A = { id: "s101", name: "雨中奔跑的小狗", path: join(WS, "stickers/mp4/a101.mp4"), gifPlayback: true };
const ITEM_B = { id: "s202", name: "趴在窗边打盹的猫", path: join(WS, "stickers/png/b202.png"), gifPlayback: false };
const ITEM_C = { id: null, name: "举着伞的小熊", path: join(WS, "stickers/inbox/c303.gif"), gifPlayback: true };
const prepared = (items: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({ ok: true, items, errors: [], ...extra });

/** The send hhd would give this context: the test role's channels over its gateway and logger, simulated when its sendDryRun says so */
const withSend = (c: Omit<ToolContext, "send">): ToolContext => ({ ...c, send: openChannels(testConfig({ tools: { sendDryRun: c.sendDryRun } }), { gateway: c.gateway, log: c.log }).send });

/** 一个假的 ToolContext，加一条会按顺序记下 run / 网关 / 记进中央记忆 / 日志 的踪迹（不含每次随机的去重编号） */
function makeCtx(o: CtxOpts = {}): { ctx: ToolContext; trace: string[] } {
  const trace: string[] = [];
  const answers = [...(o.gateway ?? [])];
  const chat: Chat = o.chat === undefined ? { channel: "whatsapp", target: WA_QING, name: "阿青" } : o.chat;
  const heard = o.heard === undefined ? T0 - MIN : o.heard;
  const stdout = o.stdout ?? prepared([ITEM_A]);
  const at = (level: string) => (msg: string, extra?: Record<string, unknown>): void => { trace.push(`log ${level} ${msg} ${JSON.stringify(extra ?? {})}`); };
  const ctx = withSend({
    regionId: "main", workspace: WS, python: "py", sendDryRun: o.dryRun ?? false, timezone: "UTC", sideThreads: 3,
    run: async (cmd, args, opts) => {
      trace.push(`run ${JSON.stringify([cmd, ...args])} ${JSON.stringify(opts ?? {})}`);
      return { code: o.code ?? 0, stdout: args.includes("prepare") ? stdout : "{\"ok\": true}", stderr: o.stderr ?? "" };
    },
    log: { info: at("info"), warn: at("warn"), error: at("error") },
    now: () => T0, note: () => {}, start: async () => "好。", finish: () => "好。", setBar: () => "好。", mullOver: () => "好。", thinkItOver: () => "ok", schedule: () => 1,
    recordSend: (to, text, resolved) => { trace.push(`send ${JSON.stringify([to, text, resolved ?? null])}`); },
    recallLocal: () => "",
    ...(o.noGateway ? {} : {
      gateway: {
        connected: true,
        request: async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
          const { idempotencyKey: _key, ...rest } = params;
          trace.push(`gateway ${method} ${JSON.stringify(rest)} ${timeoutMs ?? "-"}`);
          const a = answers.shift() ?? "ok";
          if (a === "timeout") throw new GatewayUnsure(`gateway ${method} timeout`, "timeout");
          if (a === "dropped") throw new GatewayUnsure("gateway closed（请求已经发出去了）", "dropped");
          if (a === "refused") throw new GatewayError("UNAVAILABLE", "No delivery result");
          return { messageId: "3EB0F1A2" } as T;
        },
      },
    }),
    ...(o.noResolver ? {} : { resolveTarget: (ch: string, t: string) => BOOK[t]?.[ch] ?? t }),
    ...(o.noChatFn ? {} : { currentChat: () => chat }),
    ...(o.noHeardFn ? {} : { lastHeardFrom: () => heard }),
    ...(o.noNameOf ? {} : { nameOf: (t: string) => NAMES[t] ?? null }),
  });
  // a module's script (the stickers module's sticker.py) through this context's runner, as Brain's moduleRun does
  ctx.moduleRun = (module, script, a, ro) => ctx.run(ctx.python, [`modules/${module}/scripts/${script}`, ...a], { cwd: ctx.workspace, ...ro });
  return { ctx, trace };
}

// ---------- def 变体：hh ----------
// 每个变体的工具名只在这里列一次（id 要在不建工具的时候就数得出来）；末尾有一条调用核对「建出来的名字 = 这张名单，顺序也一样」
const HH_TOOLS = ["message", "jot_down", "on_it", "set_bar", "done_with", "mull_over", "think_it_over", "ack", "computer", "remind", "reminders", "hands", "recall", "what_do_i_know", "what_reaches_me", "people_i_know", "sticker", "browser"] as const;
const builtHh = (): ToolDef[] => buildTools(makeCtx().ctx, everything);
for (const name of HH_TOOLS) add(`def hh/${name}`, () => defText(need(builtHh(), name), "hh"));
// the browser's description when the role's config says what is signed in there (browser.logins); a made-up one
add("def hh/browser, its logins named by the role", () => defText(browserTool({ ...makeCtx().ctx, browser: { o: { logins: "工作用的谷歌账号登着" } } } as unknown as ToolContext), "hh"));

// ---------- 记忆工具的夹具 ----------
const TEMPLATE: PeopleTemplate = {
  order: ["性格", "关系", "口头禅", "备注", "原话", "私语", "最近的事", "大事"],
  fields: [
    { name: "性格", type: "设定", shape: "text", maxChars: 120, maxSentences: 3, owner: { maxChars: 200 }, private: true },
    { name: "关系", type: "总结", shape: "list", maxItems: 5, itemMaxChars: 40, itemMustContain: "〔推断〕", requireEvent: true },
    { name: "口头禅", type: "总结", shape: "text", maxChars: 60, ownerOnly: true, protect: true },
    { name: "备注", type: "详情", shape: "line", maxChars: 50, patternHint: "写成「谁：做什么」" },
  ],
  quotes: [
    { name: "原话", max: 6, countsTowardTotal: true, replaceable: true, speaker: "self", fullHint: "满了就换掉最旧的" },
    { name: "私语", max: 3, ownerMax: 5, countsTowardTotal: false, replaceable: false, speaker: "selfOrMe", fullHint: "主人的先挑最短的", fullHintOthers: "别人的不再往里加" },
  ],
  computed: { bigEvents: { name: "大事", minImportance: 4, max: 3 }, near: { name: "最近的事", days: 14, max: 5 } },
  totalCap: 900, ownerTotalCap: 1500, computedOnlyMinImportance: 3, promote: { days: 7, minDays: 3 },
};

interface MemOpts { template?: PeopleTemplate; writable?: boolean; failWith?: { value: unknown } }
/** 假的事件库：每个方法把收到的参数原样回成一行字，所以每条调用同时钉住了「工具把参数怎么交给事件库」 */
function fakeMem(o: MemOpts = {}): EventMemory {
  const echo = (name: string, args: readonly unknown[]): string => `${name} ${JSON.stringify(args)}`;
  const mem = {
    store: { peopleTemplate: o.template },
    writable: (region?: string): boolean => (o.writable ?? false) && region !== undefined,
    write: (op: string, a: Record<string, unknown>, region?: string): string => {
      if (o.failWith) throw o.failWith.value;
      return echo("write", [op, a, region]);
    },
    remember: (cue: string, opts: unknown): Promise<string> => Promise.resolve(echo("remember", [cue, opts])),
    recallPerson: (who: string, n: unknown, opts: unknown): string => echo("recallPerson", [who, n, opts]),
    recallEvent: (ref: string, opts: unknown): string => echo("recallEvent", [ref, opts]),
    recallPeriod: (when: string, opts: unknown): string => echo("recallPeriod", [when, opts]),
    likeWithMeaning: (args: unknown, opts: unknown): string => echo("likeWithMeaning", [args, opts]),
    myLikes: (page: unknown): string => echo("myLikes", [page]),
    worklist: (day: string): string => echo("worklist", [day]),
  };
  return mem as unknown as EventMemory;
}

type LearnMode = "ok" | "reject-error" | "reject-text" | "throw-error" | "throw-text";
/** 假的学习工作单 / 把关：按模式正常回、异步拒、同步抛（Error 和不是 Error 的各一种） */
function learnNight(mode: LearnMode): LearnNight {
  const fail = (): never => {
    if (mode === "throw-error") throw new Error("工作单读不出来：老林的笔记本文件坏了");
    throw "笔记本炸了（不是 Error）";
  };
  return {
    worklist(day: string): Promise<string> {
      if (mode === "throw-error" || mode === "throw-text") return fail();
      if (mode === "reject-error") return Promise.reject(new Error("异步读工作单失败：磁盘没响应"));
      if (mode === "reject-text") return Promise.reject("异步读工作单失败（不是 Error）");
      return Promise.resolve(`learn.worklist ${day}`);
    },
    check(day: string, candidates: unknown[], requester: string): string {
      if (mode === "throw-error" || mode === "throw-text") return fail();
      return `learn.check ${JSON.stringify([day, candidates, requester])}`;
    },
  };
}

const memSet = (region: string, o: MemOpts = { template: TEMPLATE }, learn: LearnNight | null = learnNight("ok")): ToolDef[] => memTools(fakeMem(o), region, everything, learn ?? undefined);

// ---------- def 变体：mem / mem-no-template / no-mem ----------
const MEM_DEF_TOOLS = ["remember", "recall_person", "recall_event", "recall_period", "like", "my_likes", "mem_worklist", "learn_worklist", "learn_check", "mem_event_create", "mem_event_update", "mem_entry_add", "mem_entries_add", "mem_entry_correct", "mem_link", "mem_unlink", "mem_merge", "mem_split", "mem_supersede", "mem_retire", "mem_entity_upsert", "mem_entity_merge", "mem_entity_tag", "mem_entity_drop", "mem_day_done", "mem_person_set", "mem_quote_pin"] as const;
const NO_TEMPLATE_TOOLS = ["mem_person_set", "mem_quote_pin"] as const;
const NO_MEM_TOOLS = ["learn_worklist", "learn_check"] as const;
const builtNoMem = (): ToolDef[] => memTools(undefined, "main", everything, learnNight("ok"));
for (const name of MEM_DEF_TOOLS) add(`def mem/${name}`, () => defText(need(memSet("main"), name), "mem"));
for (const name of NO_TEMPLATE_TOOLS) add(`def mem-no-template/${name}`, () => defText(need(memSet("main", {}), name), "mem-no-template"));
for (const name of NO_MEM_TOOLS) add(`def no-mem/${name}`, () => defText(need(builtNoMem(), name), "no-mem"));

// ---------- 记忆工具：读 ----------
add("mem: remember with every filter, in the main line", () => viaTool(need(memSet("main"), "remember"), { cue: "老林上周借走的那把刨子后来怎么样了", who: "老林", from: "2026-10-01", to: "2026-11-12" }));
add("mem: remember with a cue only", () => viaTool(need(memSet("main"), "remember"), { cue: "小禾问过集市几点开" }));
add("mem: remember with empty filters drops them", () => viaTool(need(memSet("main"), "remember"), { cue: "阿青说过的那个梦", who: "", from: "", to: "" }));
add("mem: remember in the exam region leaves no trace", () => viaTool(need(memSet("exam"), "remember"), { cue: "体检时翻到阿青的旧事", who: "阿青" }));
add("mem: recall_person with a count", () => viaTool(need(memSet("main"), "recall_person"), { who: "阿青", n: 4 }));
add("mem: recall_person without a count", () => viaTool(need(memSet("main"), "recall_person"), { who: "小禾" }));
add("mem: recall_person in the importer region leaves no trace", () => viaTool(need(memSet("importer"), "recall_person"), { who: "老林", n: 1 }));
for (const region of ["main", "deep", "exam", "importer", "audit-2026-11-04-people-1-1", "exam-2026-11-04-3", "review-2026-11-04-a", "coord-2026-11-04", "lead-2026-11-04", "sleep-2026-10-28-people-1", "hippocampus"]) {
  add(`mem: recall_event in region ${region}`, () => viaTool(need(memSet(region), "recall_event"), { ref: "e0040", from: "2026-10-01", to: "2026-10-31" }));
}
add("mem: recall_event without a time range", () => viaTool(need(memSet("main"), "recall_event"), { ref: "阿青的生日" }));
add("mem: recall_period with every filter", () => viaTool(need(memSet("main"), "recall_period"), { when: "10-20 到 10-27", who: "阿青", min_importance: 3, page: 2 }));
add("mem: recall_period with importance zero", () => viaTool(need(memSet("main"), "recall_period"), { when: "上周", min_importance: 0 }));
add("mem: recall_period with a page only", () => viaTool(need(memSet("main"), "recall_period"), { when: "最近7天", page: 3 }));
add("mem: recall_period with the time only", () => viaTool(need(memSet("main"), "recall_period"), { when: "今天" }));

// ---------- 记忆工具：like / my_likes ----------
const LIKE_FULL = { what: "老林院子里那棵晒着旧毯子的枣树", how: "like", feeling: "傍晚小禾坐在树下削铅笔，老林在旁边慢慢补竹筐，整个画面安静得让人想多看几眼", title: "喜欢 老林的枣树院子", gist: "枣树下补竹筐的傍晚", why: "第一次路过时就记住了那个画面", event: "e0158", importance: 4, new: true };
add("mem: like with every argument", () => viaTool(need(memSet("main"), "like"), LIKE_FULL));
add("mem: like new=false is left out", () => viaTool(need(memSet("main"), "like"), { ...LIKE_FULL, new: false }));
add("mem: like with importance zero and no event", () => viaTool(need(memSet("main"), "like"), { what: "评论区接梗的短帖", how: "dislike", feeling: "又是同一个梗，看腻了", importance: 0 }));
for (const how of ["feel", "over", "again"]) {
  add(`mem: like how=${how}`, () => viaTool(need(memSet("main"), "like"), { what: "小禾画的那只鸭子", how, feeling: "今天又看了一遍，还是觉得线条很软" }));
}
add("mem: like how=fix", () => viaTool(need(memSet("main"), "like"), { what: "小禾画的那只鸭子", how: "fix", title: "喜欢 小禾的鸭子", gist: "线条软软的鸭子", why: "标题少了前缀" }));
add("mem: like how=drop", () => viaTool(need(memSet("main"), "like"), { what: "老林的旧收音机", how: "drop", why: "记错了，那是别人的收音机" }));
add("mem: like in the hippocampus region", () => viaTool(need(memSet("hippocampus"), "like"), { what: "阿青养的那盆薄荷", how: "like", feeling: "夜里整理时也想起它" }));
add("mem: like rejects an unknown how", () => viaTool(need(memSet("main"), "like"), { what: "老林的收音机", how: "adore" }));
add("mem: like called without what reaches the handler with an empty name", () => viaHandler(need(memSet("main"), "like"), { how: "like", feeling: "绕过 zod 直接调" }));
add("mem: my_likes without a page", () => viaTool(need(memSet("main"), "my_likes"), {}));
add("mem: my_likes page 3", () => viaTool(need(memSet("main"), "my_likes"), { page: 3 }));

// ---------- 记忆工具：工作单和把关（学习这一块不靠事件库） ----------
add("mem: mem_worklist", () => viaTool(need(memSet("hippocampus"), "mem_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist with the notebook", () => viaTool(need(memSet("hippocampus"), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist with the notebook off", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, null), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist with the notebook off and no memory at all", () => viaTool(need(memTools(undefined, "hippocampus", everything), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist whose promise rejects with an Error", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("reject-error")), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist whose promise rejects with a non-Error", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("reject-text")), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist that throws an Error at once", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("throw-error")), "learn_worklist"), { day: "2026-11-12" }));
add("mem: learn_worklist that throws a non-Error at once", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("throw-text")), "learn_worklist"), { day: "2026-11-12" }));
const CANDIDATES = [
  { kind: "做成的", page: "做成的事/修好了阿青的台灯", text: "台灯的接线松了，重新拧紧后能亮", evidence: "任务 t0457，阿青说「亮了」" },
  { kind: "教训", page: "教训/不要在老林睡觉时发消息", text: "老林中午要睡，打扰他会被念叨", evidence: "原话 q8821" },
];
add("mem: learn_check with the notebook", () => viaTool(need(memSet("sleep-2026-11-12-people-1"), "learn_check"), { day: "2026-11-12", candidates: CANDIDATES }));
add("mem: learn_check with the notebook off", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, null), "learn_check"), { day: "2026-11-12", candidates: CANDIDATES }));
add("mem: learn_check with the notebook off and no memory at all", () => viaTool(need(memTools(undefined, "hippocampus", everything), "learn_check"), { day: "2026-11-12", candidates: [] }));
add("mem: learn_check that throws an Error", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("throw-error")), "learn_check"), { day: "2026-11-12", candidates: CANDIDATES }));
add("mem: learn_check that throws a non-Error", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE }, learnNight("throw-text")), "learn_check"), { day: "2026-11-12", candidates: CANDIDATES }));
add("mem: learn_check rejects a candidate of an unknown kind", () => viaTool(need(memSet("hippocampus"), "learn_check"), { day: "2026-11-12", candidates: [{ kind: "感想", page: "x", text: "y", evidence: "z" }] }));

// ---------- 记忆工具：夜里整理写的 ----------
const NEW_EVENT = { title: "小禾的集市摊", summary: "小禾周末要在集市摆摊卖手绘明信片，选了靠近喷泉的位置，还在等摊位费退回来", gist: "小禾周末摆摊卖明信片", why: "她第一次摆摊，说想听听结果", importance: 4, pinned: true, next: "2026-11-16", parent: "e0013", stance: "like" };
const WRITE_ARGS: Record<string, Record<string, unknown>> = {
  mem_worklist: { day: "2026-11-12" },
  mem_event_create: { ...NEW_EVENT, entities: [{ name: "小禾", kind: "person", role: "with" }, { name: "集市", kind: "place", role: "where" }], thread_path: "threads/小禾/集市摊.md", reason: "白天聊到了好几次" },
  mem_event_update: { id: "e0301", title: "小禾的集市摊（改）", summary: "摊位费退回来了", gist: "摊位费退了", why: "确认过收据", importance: 3, pinned: false, next: "", parent: "", stance: "", reason: "收据已核对" },
  mem_entry_add: { event: "e0301", at: "2026-11-12 21:30", until: "2026-11-12 22:10", kind: "said", full: "小禾说：摊位费今天退回来了，阿青陪她数了一遍", gist: "摊位费退回", title: "退摊位费", people: ["小禾", "阿青"], source: ["q8821", "c:4410"] },
  mem_entries_add: { event: "e0301", entries: [{ at: "2026-11-12", gist: "收到摊位费", title: "摊位费" }, { at: "2026-11-12 22:00", until: "2026-11-12 22:30", kind: "said", full: "老林来看了摊位，说位置不错", gist: "老林看摊位", title: "老林来看", people: ["老林"], source: ["q8830"] }] },
  mem_entry_correct: { id: "n00123", full: "当时记成了周五，其实是周六", gist: "日子更正为周六", title: "更正日子", why: "小禾后来亲口说的" },
  mem_link: { a: "e0001", b: "e0002", rel: "related", note: "都是关于集市的" },
  mem_unlink: { a: "e0001", b: "e0002", rel: "cause", reason: "其实没有因果" },
  mem_merge: { keep: "e0301", others: ["e0302", "e0303"], reason: "三件其实是同一个摊" },
  mem_split: { id: "e0301", entries: ["n00201", "n00202"], event: { title: "老林的刨子", summary: "老林借走了刨子，说周末还", gist: "借刨子", importance: 2 }, reason: "混进来的另一件事", under: true },
  mem_supersede: { old: "e0310", by: "e0311", reason: "摊位换了地方" },
  mem_retire: { id: "e0320", reason: "不再算数了" },
  mem_entity_upsert: { name: "小禾", kind: "person", aliases: ["禾禾", "小禾子"], person_key: "xiaohe", note: "画明信片的朋友，在集市摆过摊", importance: 3, why: "常聊起", remove_aliases: ["阿禾"] },
  mem_entity_merge: { keep: "小禾", others: ["禾禾"], reason: "同一个人" },
  mem_entity_tag: { name: "老林", to: "e0128", role: "about", reason: "经过里漏写了他" },
  mem_entity_drop: { name: "工作台左边的抽屉", reason: "是一件东西的位置，不是要登记的对象" },
  mem_day_done: { day: "2026-11-12" },
  mem_person_set: { who: "阿青", section: "性格", text: "做事慢一点但很稳，爱把东西摆整齐。", why: "夜里整理", sources: ["e0301", "q8821"] },
  mem_quote_pin: { who: "阿青", section: "原话", quote: "q8821", text: "亮了，真的亮了", why: "她修好台灯时的第一句", private: false, replaces: "i0013", sources: ["q8821"] },
};
for (const name of MEM_WRITE_TOOLS) {
  add(`mem: write tool ${name}`, () => {
    const args = WRITE_ARGS[name];
    if (!args) throw new FixtureError(`no arguments for ${name}`);
    return viaTool(need(memSet("hippocampus"), name), args);
  });
}
add("mem: mem_event_create rejects a missing title", () => viaTool(need(memSet("hippocampus"), "mem_event_create"), { summary: "没有名字", gist: "x", importance: 2 }));
add("mem: a store that throws an Error says 没做成", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE, failWith: { value: new Error("事件 e0999 不存在") } }), "mem_day_done"), { day: "2026-11-12" }));
add("mem: a store that throws a non-Error says 没做成", () => viaTool(need(memSet("hippocampus", { template: TEMPLATE, failWith: { value: "库打不开（不是 Error）" } }), "mem_retire"), { id: "e0320", reason: "试一下" }));

// ---------- 记忆工具：人物卡（白天照旧「没做成」；能写时被拒回「没写进去 / 没钉上」） ----------
const CARD_SET = WRITE_ARGS.mem_person_set ?? {};
const CARD_PIN = WRITE_ARGS.mem_quote_pin ?? {};
const cardCases: Array<[string, MemOpts]> = [
  ["by day (not writable) and the store accepts", { template: TEMPLATE, writable: false }],
  ["by night (writable) and the store accepts", { template: TEMPLATE, writable: true }],
  ["by night and the store refuses with an Error", { template: TEMPLATE, writable: true, failWith: { value: new Error("「性格」写了 130 字，上限 120 字：删掉一句再写") } }],
  ["by night and the store refuses with a non-Error", { template: TEMPLATE, writable: true, failWith: { value: "字段名不对（不是 Error）" } }],
  ["by day and the store refuses with an Error", { template: TEMPLATE, writable: false, failWith: { value: new Error("白天不能写人物卡") } }],
  ["by day and the store refuses with a non-Error", { template: TEMPLATE, writable: false, failWith: { value: "白天不能写（不是 Error）" } }],
];
for (const [what, o] of cardCases) {
  add(`mem: mem_person_set ${what}`, () => viaTool(need(memSet("hippocampus", o), "mem_person_set"), CARD_SET));
  add(`mem: mem_quote_pin ${what}`, () => viaTool(need(memSet("hippocampus", o), "mem_quote_pin"), CARD_PIN));
}
add("mem: mem_person_set without a template still answers", () => viaTool(need(memSet("hippocampus", { writable: true }), "mem_person_set"), CARD_SET));
add("mem: mem_quote_pin without a template still answers", () => viaTool(need(memSet("hippocampus", { writable: true }), "mem_quote_pin"), CARD_PIN));
add("mem: mem_quote_pin rejects a missing quote", () => viaTool(need(memSet("hippocampus"), "mem_quote_pin"), { who: "阿青", section: "原话" }));

// ---------- 记忆工具：名单和过滤 ----------
add("mem: allowed list keeps only the named tools, in order of the table", () => JSON.stringify(memTools(fakeMem({ template: TEMPLATE }), "main", ["my_likes", "remember", "learn_check"]).map((t) => t.name)));
add("mem: without memory only the two learn tools can be had", () => JSON.stringify(memTools(undefined, "main", everything, learnNight("ok")).map((t) => t.name)));
add("mem: without memory the allowed list still filters", () => JSON.stringify(memTools(undefined, "main", ["learn_check", "remember"]).map((t) => t.name)));
add("mem: the exported tool name lists", () => JSON.stringify({ read: MEM_READ_TOOLS, like: MEM_LIKE_TOOLS, write: MEM_WRITE_TOOLS, storeWriters: MEM_STORE_WRITERS }));

// ---------- 表情包：发给谁 ----------
const dest = (o: CtxOpts, to: string | undefined, channel: "qqbot" | "whatsapp" | undefined): string => JSON.stringify(stickerDestination(makeCtx(o).ctx, to, channel));
const QQ_CHAT: Chat = { channel: "qqbot", target: QQ_QING, name: "阿青" };
add("stickers dest: default is the person being talked to", () => dest({}, undefined, undefined));
add("stickers dest: a blank to counts as no to", () => dest({}, "   ", undefined));
add("stickers dest: no chat and no to", () => dest({ chat: null }, undefined, undefined));
add("stickers dest: the chat is on another channel (telegram)", () => dest({ chat: { channel: "telegram", target: "tg:7f3a", name: "阿青" } }, undefined, undefined));
add("stickers dest: no currentChat function, to given", () => dest({ noChatFn: true }, "老林", undefined));
add("stickers dest: no currentChat function, no to", () => dest({ noChatFn: true }, undefined, undefined));
add("stickers dest: to is the chat name", () => dest({}, "阿青", undefined));
add("stickers dest: to is the chat target with an upper-case prefix and a lower-case id (QQ)", () => dest({ chat: QQ_CHAT }, `QQBOT:C2C:${QQ_QING.slice("qqbot:c2c:".length).toLowerCase()}`, undefined));
add("stickers dest: the chat is QQ, same channel", () => dest({ chat: QQ_CHAT }, undefined, undefined));
add("stickers dest: the chat is QQ, asked for WhatsApp", () => dest({ chat: QQ_CHAT }, undefined, "whatsapp"));
add("stickers dest: the chat is WhatsApp, asked for QQ (fresh)", () => dest({}, undefined, "qqbot"));
add("stickers dest: the chat is WhatsApp, asked for QQ, person has no QQ", () => dest({ chat: { channel: "whatsapp", target: WA_ZHOU, name: "老林" } }, undefined, "qqbot"));
add("stickers dest: the chat has no name, asked for QQ", () => dest({ chat: { channel: "whatsapp", target: WA_QING } }, undefined, "qqbot"));
add("stickers dest: the chat is WhatsApp, asked for QQ, no resolver", () => dest({ noResolver: true }, undefined, "qqbot"));
add("stickers dest: another person by name, WhatsApp by default", () => dest({}, "老林", undefined));
add("stickers dest: another person by name, QQ asked", () => dest({}, "小禾", "qqbot"));
add("stickers dest: another person, no number on that channel", () => dest({}, "老林", "qqbot"));
add("stickers dest: unknown name, default channel", () => dest({}, "路过的陌生人", undefined));
add("stickers dest: unknown name, QQ asked", () => dest({}, "路过的陌生人", "qqbot"));
add("stickers dest: name without a resolver", () => dest({ noResolver: true }, "老林", undefined));
add("stickers dest: a WhatsApp number", () => dest({}, "+6155500021", undefined));
add("stickers dest: a WhatsApp number with channel=whatsapp", () => dest({}, "+6155500021", "whatsapp"));
add("stickers dest: a WhatsApp number but channel=qqbot", () => dest({}, WA_ZHOU, "qqbot"));
add("stickers dest: a QQ number but channel=whatsapp", () => dest({}, QQ_HE, "whatsapp"));
add("stickers dest: a QQ number, heard a minute ago", () => dest({}, QQ_HE, undefined));
add("stickers dest: a QQ number never heard from, person has WhatsApp (rerouted)", () => dest({ heard: null }, QQ_QING, undefined));
add("stickers dest: a QQ number never heard from, person has no WhatsApp", () => dest({ heard: null }, QQ_HE, undefined));
add("stickers dest: a QQ number never heard from, nobody knows it", () => dest({ heard: null, noNameOf: true }, QQ_QING, undefined));
add("stickers dest: a QQ number heard two hours ago (rerouted)", () => dest({ heard: T0 - 120 * MIN }, QQ_QING, "qqbot"));
add("stickers dest: a QQ number heard exactly 55 minutes ago (window still open)", () => dest({ heard: T0 - 55 * MIN }, QQ_QING, undefined));
add("stickers dest: a QQ number heard 55 minutes and a millisecond ago (rerouted)", () => dest({ heard: T0 - 55 * MIN - 1 }, QQ_QING, undefined));
add("stickers dest: no lastHeardFrom function counts as never heard", () => dest({ noHeardFn: true }, QQ_QING, undefined));
add("stickers dest: a QQ group is never rerouted", () => dest({ heard: null }, QQ_GROUP, undefined));
add("stickers dest: no nameOf function, name falls back to the chat name", () => dest({ noNameOf: true }, undefined, undefined));
add("stickers dest: no nameOf function, other target has no name", () => dest({ noNameOf: true }, "+6155500021", undefined));
add("stickers dest: to is another person's number while chatting with 阿青", () => dest({}, WA_ZHOU, undefined));

// ---------- 表情包：工具（经 zod，handler 的每个出口） ----------
async function stick(o: CtxOpts, args: Record<string, unknown>): Promise<string> {
  const { ctx, trace } = makeCtx(o);
  const out = await viaTool(stickerTool(ctx), args);
  return [out, "--- trace ---", ...trace].join("\n");
}
add("stickers: mood to the person being talked to", () => stick({}, { mood: "开心 得意" }));
add("stickers: ref list, trimmed, blanks dropped", () => stick({}, { ref: ["  s301 ", "", "stickers/inbox/qing.gif"], mood: "这个情绪词不会被用到" }));
add("stickers: mood split on commas, spaces and 、", () => stick({}, { mood: "开心,得意、累 平静，困" }));
add("stickers: neither mood nor ref", () => stick({}, {}));
add("stickers: blank mood and empty ref", () => stick({}, { mood: "   ", ref: [] }));
add("stickers: no destination", () => stick({ chat: null }, { mood: "开心" }));
add("stickers: destination mismatch", () => stick({}, { mood: "开心", to: WA_ZHOU, channel: "qqbot" }));
add("stickers: unknown person asked for", () => stick({}, { mood: "开心", to: "路过的陌生人" }));
add("stickers: channel outside the enum is refused by zod", () => stick({}, { mood: "开心", channel: "sms" }));
add("stickers: prepare printed something that is not JSON", () => stick({ stdout: "Traceback: sticker.py 崩了 {" }, { mood: "开心" }));
add("stickers: prepare printed nothing and exited 0", () => stick({ stdout: "" }, { mood: "开心" }));
add("stickers: prepare failed with a code and stderr", () => stick({ stdout: "not json", code: 2, stderr: "ffmpeg 找不到" }, { mood: "开心" }));
add("stickers: no items, errors listed", () => stick({ stdout: JSON.stringify({ ok: false, items: [], errors: ["表情库没建", "inbox 是空的"] }) }, { mood: "开心" }));
add("stickers: no items, nearest moods offered", () => stick({ stdout: JSON.stringify({ ok: true, items: [], nearest_moods: ["开心", "得意"] }) }, { mood: "狂喜" }));
add("stickers: no items, empty nearest moods", () => stick({ stdout: JSON.stringify({ ok: true, items: [], nearest_moods: [] }) }, { mood: "狂喜" }));
add("stickers: no items and no items key at all", () => stick({ stdout: "{}" }, { mood: "狂喜" }));
add("stickers: no items, empty errors list falls through to the mood message", () => stick({ stdout: JSON.stringify({ items: [], errors: [] }) }, { ref: ["s999"] }));
add("stickers: two items sent, ids recorded, one without a gif flag", () => stick({ stdout: prepared([ITEM_A, ITEM_B]) }, { mood: "开心" }));
add("stickers: item without an id is sent but not counted", () => stick({ stdout: prepared([ITEM_C]) }, { mood: "开心" }));
add("stickers: prepare errors ride along with a sent item", () => stick({ stdout: prepared([ITEM_A], { errors: ["s999 不在库里"] }) }, { ref: ["s101", "s999"] }));
add("stickers: gateway refuses the first, second is sent", () => stick({ stdout: prepared([ITEM_A, ITEM_B]), gateway: ["refused"] }, { mood: "开心" }));
add("stickers: gateway refuses the only one", () => stick({ stdout: prepared([ITEM_A]), gateway: ["refused"] }, { mood: "开心" }));
add("stickers: timeout then the re-ask confirms", () => stick({ stdout: prepared([ITEM_A, ITEM_B]), gateway: ["timeout", "ok"] }, { mood: "开心" }));
add("stickers: timeout and the re-ask is refused, the rest go on", () => stick({ stdout: prepared([ITEM_A, ITEM_B]), gateway: ["timeout", "refused"] }, { mood: "开心" }));
add("stickers: timeout and no answer to the re-ask, the rest are held back", () => stick({ stdout: prepared([ITEM_A, ITEM_B, ITEM_C]), gateway: ["timeout", "timeout"] }, { mood: "开心" }));
add("stickers: timeout and no answer to the re-ask on the last one", () => stick({ stdout: prepared([ITEM_A, ITEM_B]), gateway: ["ok", "timeout", "dropped"] }, { mood: "开心" }));
add("stickers: connection dropped is not stuck, the next one is sent", () => stick({ stdout: prepared([ITEM_A, ITEM_B]), gateway: ["dropped"] }, { mood: "开心" }));
add("stickers: dry run sends nothing and counts nothing", () => stick({ dryRun: true, stdout: prepared([ITEM_A, ITEM_B]) }, { mood: "开心" }));
add("stickers: no gateway and not a dry run", () => stick({ noGateway: true, stdout: prepared([ITEM_A, ITEM_B]) }, { mood: "开心" }));
add("stickers: QQ window passed, rerouted to WhatsApp and sent", () => stick({ chat: QQ_CHAT, heard: T0 - 3 * 60 * MIN }, { mood: "开心" }));
add("stickers: rerouted and the send fails", () => stick({ chat: QQ_CHAT, heard: null, gateway: ["refused"] }, { mood: "开心" }));
add("stickers: rerouted with the re-ask unsure", () => stick({ chat: QQ_CHAT, heard: null, gateway: ["timeout", "timeout"] }, { mood: "开心" }));
add("stickers: sent over QQ, label in the reply", () => stick({ chat: QQ_CHAT }, { mood: "开心" }));
add("stickers: to a stranger's number, the reply names the number", () => stick({ stdout: prepared([ITEM_A]) }, { mood: "开心", to: "+6155500021" }));
add("stickers: to another person by name over QQ", () => stick({}, { mood: "开心", to: "小禾", channel: "qqbot" }));
add("stickers: to a QQ group", () => stick({ heard: null }, { ref: ["s101"], to: QQ_GROUP }));
add("stickers: no nameOf, the reply falls back to the chat name", () => stick({ noNameOf: true }, { mood: "开心" }));
add("stickers: a bare number as to (no zod) is refused as an unknown name", () => viaHandler(stickerTool(makeCtx().ctx), { mood: "开心", to: 6155500021 }));

// ---------- 浏览器：假的 Chrome 和假的 Page（记下被问了什么，回编好的值，或抛编好的错；不碰真浏览器） ----------
interface FakeLoc {
  first(): FakeLoc;
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  pressSequentially(text: string, opts: unknown): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(opts: unknown): Promise<void>;
  setInputFiles(files: string[]): Promise<void>;
}
interface PageOpts {
  id: string;
  /** null = 取标题时抛错 */
  title: string | null;
  url?: string;
  snapshot?: string;
  /** evaluate 的返回值 */
  value?: unknown;
  /** 这个方法被调用时抛 failWith（可以是 Error，也可以是别的东西） */
  failAt?: string;
  failWith?: unknown;
  /** waitForLoadState 超时 */
  loadFails?: boolean;
}
const PAGE_IDS = new WeakMap<object, string>();

function fakePage(trace: string[], o: PageOpts): Page {
  const hit = async (what: string, ...args: unknown[]): Promise<void> => {
    trace.push(`${o.id} ${what} ${JSON.stringify(args)}`);
    if (o.failAt === what) throw o.failWith;
  };
  const loc = (sel: string): FakeLoc => {
    const l: FakeLoc = {
      first: () => l,
      click: () => hit("click", sel),
      fill: (text: string) => hit("fill", sel, text),
      pressSequentially: (text: string, opts: unknown) => hit("pressSequentially", sel, text, opts),
      press: (key: string) => hit("press", sel, key),
      screenshot: (opts: unknown) => hit("locator.screenshot", sel, opts),
      setInputFiles: (files: string[]) => hit("setInputFiles", sel, files),
    };
    return l;
  };
  const page = {
    title: async (): Promise<string> => {
      trace.push(`${o.id} title`);
      if (o.title === null) throw new Error("title 取不到");
      return o.title;
    },
    url: (): string => o.url ?? `https://example.com/${o.id}`,
    goto: (url: string, opts: unknown) => hit("goto", url, opts),
    goBack: (opts: unknown) => hit("goBack", opts),
    bringToFront: () => hit("bringToFront"),
    close: () => hit("close"),
    setDefaultTimeout: (ms: number): void => { trace.push(`${o.id} setDefaultTimeout ${ms}`); },
    ariaSnapshot: async (opts: unknown): Promise<string> => { await hit("ariaSnapshot", opts); return o.snapshot ?? "- heading \"默认的结构\" [ref=e1]"; },
    evaluate: async (src: string): Promise<unknown> => { await hit("evaluate", src); return o.value; },
    screenshot: (opts: unknown) => hit("screenshot", opts),
    waitForLoadState: async (state: string, opts: unknown): Promise<void> => {
      await hit("waitForLoadState", state, opts);
      if (o.loadFails) throw new Error("load 超时");
    },
    waitForTimeout: (ms: number) => hit("waitForTimeout", ms),
    getByText: (text: string) => ({ first: () => ({ waitFor: (opts: unknown) => hit("waitFor", text, opts) }) }),
    locator: loc,
    mouse: { click: (x: number, y: number) => hit("mouse.click", x, y) },
    keyboard: { press: (key: string) => hit("keyboard.press", key) },
  };
  PAGE_IDS.set(page, o.id);
  return page as unknown as Page;
}

interface ChromeOpts {
  running?: boolean;
  pages?: Page[];
  /** 每份心思现在看着哪一页 */
  current?: Record<string, Page | null>;
  others?: Array<{ who: string; page: Page }>;
  started?: boolean;
  stopped?: boolean;
  /** newPage 开出来的 */
  open?: Page;
  /** page(who, tab) 回的 */
  pick?: Page;
  /** page(who, tab) 抛这句 */
  pickFails?: string;
  /** 这一步永远不回（超时用） */
  hang?: "running" | "page";
}

function fakeChrome(trace: string[], o: ChromeOpts): Chrome {
  const never = <T>(): Promise<T> => new Promise<T>(() => {});
  const c = {
    running: (): Promise<boolean> => { trace.push("chrome.running"); return o.hang === "running" ? never<boolean>() : Promise.resolve(o.running ?? false); },
    pages: async (): Promise<Page[]> => { trace.push("chrome.pages"); return o.pages ?? []; },
    connect: async (): Promise<{ started: boolean }> => { trace.push("chrome.connect"); return { started: o.started ?? false }; },
    othersUsing: (who: string): Array<{ who: string; page: Page }> => { trace.push(`chrome.othersUsing ${who}`); return o.others ?? []; },
    idOf: (p: Page): string => PAGE_IDS.get(p) ?? "t?",
    stop: async (): Promise<boolean> => { trace.push("chrome.stop"); return o.stopped ?? false; },
    currentOf: (who: string): Page | null => o.current?.[who] ?? null,
    newPage: async (who: string): Promise<Page> => {
      trace.push(`chrome.newPage ${who}`);
      if (!o.open) throw new Error("fake chrome: no page scripted for newPage");
      return o.open;
    },
    page: (who: string, tab?: string): Promise<Page> => {
      trace.push(`chrome.page ${who} ${tab ?? "-"}`);
      if (o.hang === "page") return never<Page>();
      if (o.pickFails) return Promise.reject(new Error(o.pickFails));
      if (!o.pick) return Promise.reject(new Error("fake chrome: no page scripted for page()"));
      return Promise.resolve(o.pick);
    },
    shotPath: (ext: string): string => { trace.push(`chrome.shotPath ${ext}`); return join(ROOT, "shots", `web-${T0}.${ext}`); },
  };
  return c as unknown as Chrome;
}

const pg = (t: string[], id: string, title: string | null, extra: Partial<PageOpts> = {}): Page => fakePage(t, { id, title, ...extra });

/** 经 zod 调 browser 工具；文字后面接一条踪迹：假 Chrome / 假 Page 被问了什么、按什么顺序 */
async function surf(build: ((t: string[]) => ChromeOpts) | null, args: Record<string, unknown>, region = "main"): Promise<string> {
  const trace: string[] = [];
  const ctx = { regionId: region, ...(build ? { browser: fakeChrome(trace, build(trace)) } : {}) } as unknown as ToolContext;
  const out = await viaTool(browserTool(ctx), args);
  return [out, "--- trace ---", ...trace].join("\n");
}
/** 绕过 zod（动作不在名单里时 handler 仍有话说） */
async function surfRaw(build: (t: string[]) => ChromeOpts, args: Record<string, unknown>): Promise<string> {
  const trace: string[] = [];
  const ctx = { regionId: "main", browser: fakeChrome(trace, build(trace)) } as unknown as ToolContext;
  const out = await viaHandler(browserTool(ctx), args);
  return [out, "--- trace ---", ...trace].join("\n");
}
/** 超时：handler 自己用 setTimeout（120 秒，wait 另算）；用 node:test 的假计时器拨过去，不真等。handler 是同步走到定时器的，所以先调用、再拨 */
async function surfHung(hang: "running" | "page", args: Record<string, unknown>, ms: number): Promise<string> {
  const trace: string[] = [];
  const ctx = { regionId: "main", browser: fakeChrome(trace, { hang }) } as unknown as ToolContext;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const pending = viaHandler(browserTool(ctx), args);
    mock.timers.tick(ms);
    const out = await pending;
    return [out, "--- trace ---", ...trace].join("\n");
  } finally {
    mock.timers.reset();
  }
}

const QING_URL = "https://example.com/qing/albums?id=7731&page=2";
const ZHOU_URL = "https://www.example.org/zhou/notes/20261112";
const HE_URL = "https://example.com/xiaohe/market";

// ---------- 浏览器：没有浏览器 / status / start / stop ----------
add("browser: no browser in this context", () => surf(null, { action: "status" }));
add("browser: status when not running", () => surf(() => ({ running: false }), { action: "status" }));
add("browser: status when running, three tabs", () => surf((t) => ({ running: true, pages: [pg(t, "t1", "阿青的相册"), pg(t, "t2", "老林的笔记"), pg(t, "t3", "小禾的集市")] }), { action: "status" }));
add("browser: start when it was not open", () => surf(() => ({ started: true }), { action: "start" }));
add("browser: start when it was already open", () => surf(() => ({ started: false }), { action: "start" }));
add("browser: stop refused while the front and a side thought are using it", () =>
  surf((t) => ({ others: [{ who: "main", page: pg(t, "t4", "阿青的相册") }, { who: "side-2", page: pg(t, "t9", "老林的笔记") }] }), { action: "stop" }, "side-1"));
add("browser: stop refused while one side thought is using it", () => surf((t) => ({ others: [{ who: "side-3", page: pg(t, "t6", "小禾的集市") }] }), { action: "stop" }));
add("browser: stop closes the browser", () => surf(() => ({ others: [], stopped: true }), { action: "stop" }));
add("browser: stop when it was not open", () => surf(() => ({ others: [], stopped: false }), { action: "stop" }));

// ---------- 浏览器：标签页 ----------
add("browser: tabs with nothing open", () => surf(() => ({ pages: [] }), { action: "tabs" }));
add("browser: tabs marks the current one, titles empty / missing / given", () =>
  surf((t) => {
    const a = pg(t, "t1", "阿青的相册", { url: QING_URL });
    const b = pg(t, "t2", "", { url: ZHOU_URL });
    const c = pg(t, "t3", null, { url: HE_URL });
    return { pages: [a, b, c], current: { main: b } };
  }, { action: "tabs" }));
add("browser: tabs when this thought has no current page", () => surf((t) => ({ pages: [pg(t, "t5", "老林的笔记", { url: ZHOU_URL })], current: { main: null } }), { action: "tabs" }));
add("browser: open with a url", () => surf((t) => ({ open: pg(t, "t7", "阿青的相册", { url: QING_URL }) }), { action: "open", url: QING_URL }));
add("browser: open without a url", () => surf((t) => ({ open: pg(t, "t8", "", { url: "about:blank" }) }), { action: "open" }));
add("browser: close with neither a tab nor a current page", () => surf(() => ({ current: { main: null } }), { action: "close" }));
add("browser: close a named tab when there is no current page", () => surf((t) => ({ current: {}, pick: pg(t, "t3", "小禾的集市") }), { action: "close", tab: "t3" }));
add("browser: close the current page", () => surf((t) => { const p = pg(t, "t2", "老林的笔记"); return { current: { main: p }, pick: p }; }, { action: "close" }));
add("browser: close a named tab that is not open", () => surf(() => ({ current: { main: null }, pickFails: "没有 t77 这个标签页（tabs 看现在开着哪些）" }), { action: "close", tab: "t77" }));
add("browser: focus", () => surf((t) => ({ pick: pg(t, "t4", "阿青的相册", { url: QING_URL }) }), { action: "focus", tab: "t4" }));
add("browser: navigate without a url", () => surf((t) => ({ pick: pg(t, "t2", "老林的笔记") }), { action: "navigate" }));
add("browser: navigate to a url", () => surf((t) => ({ pick: pg(t, "t2", "小禾的集市", { url: HE_URL }) }), { action: "navigate", url: HE_URL }));
add("browser: back", () => surf((t) => ({ pick: pg(t, "t2", "老林的笔记", { url: ZHOU_URL }) }), { action: "back" }));

// ---------- 浏览器：看页面 ----------
const SNAP = "- heading \"阿青的相册\" [ref=e1]\n- button \"发布\" [ref=e12]\n- textbox \"名字\" [ref=e13]\n- link \"老林的笔记\" [ref=e14]";
add("browser: snapshot, default limit", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { url: QING_URL, snapshot: SNAP }) }), { action: "snapshot" }));
add("browser: snapshot cut by max", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { url: QING_URL, snapshot: SNAP }) }), { action: "snapshot", max: 37 }));
add("browser: snapshot with max larger than the text", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { url: QING_URL, snapshot: SNAP }) }), { action: "snapshot", max: 5000 }));
add("browser: evaluate without js", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "evaluate" }));
add("browser: evaluate returns nothing", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "evaluate", js: "void 0" }));
add("browser: evaluate returns a string, cut by max", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { value: "老林昨天在集市上买了三斤枣，小禾说那天的天气特别好" }) }), { action: "evaluate", js: "document.body.innerText", max: 14 }));
add("browser: evaluate returns an object, default limit", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { value: { n: 2, 名字: ["阿青", "小禾"] } }) }), { action: "evaluate", js: "const n = 2;\nreturn {n}" }));
add("browser: evaluate returns a long string, default limit cuts it", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { value: "禾".repeat(8200) }) }), { action: "evaluate", js: "() => document.title" }));

// ---------- 浏览器：点、输入、按键 ----------
add("browser: click by ref with the ref= prefix", () => surf((t) => ({ pick: pg(t, "t1", "点过了", { url: QING_URL }) }), { action: "click", ref: "ref=e12" }));
add("browser: click by ref", () => surf((t) => ({ pick: pg(t, "t1", "点过了", { url: QING_URL }) }), { action: "click", ref: "e14", selector: "#ignored" }));
add("browser: click by selector", () => surf((t) => ({ pick: pg(t, "t1", "点过了", { url: QING_URL }) }), { action: "click", selector: "button.publish-7731" }));
add("browser: click by coordinates", () => surf((t) => ({ pick: pg(t, "t1", "点过了", { url: QING_URL }) }), { action: "click", x: 311, y: 478 }));
add("browser: click with x but no y is refused", () => surf((t) => ({ pick: pg(t, "t1", "点过了") }), { action: "click", x: 311 }));
add("browser: click with nothing to click is refused", () => surf((t) => ({ pick: pg(t, "t1", "点过了") }), { action: "click" }));
add("browser: click whose page-load wait times out still answers", () => surf((t) => ({ pick: pg(t, "t1", "点过了", { url: QING_URL, loadFails: true }) }), { action: "click", ref: "e12" }));
add("browser: type with no target", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "type", text: "老林的新地址" }));
add("browser: type with a target but no text", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "type", ref: "e13" }));
add("browser: type fills", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "type", ref: "e13", text: "阿青的新名字" }));
add("browser: type slowly", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "type", selector: "#name-7731", text: "小禾慢慢敲", slowly: true }));
add("browser: type then submit", () => surf((t) => ({ pick: pg(t, "t1", "搜索结果", { url: HE_URL }) }), { action: "type", ref: "e13", text: "老林的刨子", submit: true }));
add("browser: type slowly then submit", () => surf((t) => ({ pick: pg(t, "t1", "搜索结果", { url: HE_URL }) }), { action: "type", selector: "input.search", text: "小禾的明信片", slowly: true, submit: true }));
add("browser: press without a key", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "press" }));
add("browser: press a key", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "press", key: "PageDown" }));

// ---------- 浏览器：截图、上传、等 ----------
add("browser: screenshot whole page as jpeg", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "screenshot", full: true }));
add("browser: screenshot visible part as png", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "screenshot" }));
add("browser: screenshot of one element", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "screenshot", ref: "e12" }));
add("browser: screenshot of one element, full asked (jpeg name, element wins)", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "screenshot", selector: "div.card-7731", full: true }));
add("browser: upload without files", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "upload" }));
add("browser: upload with an empty file list", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "upload", files: [] }));
add("browser: upload to the given box", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "upload", ref: "e15", files: ["/home/example/pics/阿青-0417.png", "/home/example/pics/小禾-0902.png"] }));
add("browser: upload to the first file box on the page", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "upload", files: ["/home/example/pics/老林-1131.jpg"] }));
add("browser: wait for text, with ms", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait", text: "加载完了", ms: 4321 }));
add("browser: wait for text, ms over the cap", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait", text: "老林来了", ms: 90_000 }));
add("browser: wait for text, default ms", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait", text: "小禾发的新帖" }));
add("browser: wait for a time, with ms", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait", ms: 2500 }));
add("browser: wait for a time, ms over the cap", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait", ms: 99_000 }));
add("browser: wait with neither text nor ms", () => surf((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "wait" }));
add("browser: an action outside the list reaches the closing line", () => surfRaw((t) => ({ pick: pg(t, "t1", "阿青的相册") }), { action: "dance" }));

// ---------- 浏览器：出错的三条路 ----------
add("browser: a click on a ref that is gone says the page changed", () =>
  surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { failAt: "click", failWith: new Error("locator.click: Error: aria-ref=e999 resolved to 0 elements\n  Call log:\n  - waiting") }) }), { action: "click", ref: "e999" }));
add("browser: a navigation that is interrupted says the action probably worked", () =>
  surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { failAt: "goto", failWith: new Error("page.goto: Navigation to \"https://example.com/qing/albums\" is interrupted by another navigation\n  at x") }) }), { action: "navigate", url: QING_URL }));
add("browser: an evaluate whose page went away says the action probably worked", () =>
  surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { failAt: "evaluate", failWith: new Error("page.evaluate: Execution context was destroyed, most likely because of a nav") }) }), { action: "evaluate", js: "document.title" }));
add("browser: any other Error says 没做成 with its first line", () =>
  surf((t) => ({ pick: pg(t, "t1", "老林的笔记", { failAt: "fill", failWith: new Error("locator.fill: Timeout 10000ms exceeded.\n  Call log: 老林的输入框一直是只读的") }) }), { action: "type", selector: "#zhou", text: "写点什么" }));
add("browser: a long Error message is cut at 400 characters", () =>
  surf((t) => ({ pick: pg(t, "t1", "小禾的集市", { failAt: "keyboard.press", failWith: new Error("keyboard.press: " + "小禾的键盘坏了".repeat(80)) }) }), { action: "press", key: "Enter" }));
add("browser: a thrown value that is not an Error", () =>
  surf((t) => ({ pick: pg(t, "t1", "阿青的相册", { failAt: "bringToFront", failWith: "窗口被老林关掉了（不是 Error）" }) }), { action: "focus" }));
add("browser: a tab that is not open", () => surf(() => ({ pickFails: "没有 t42 这个标签页（tabs 看现在开着哪些）" }), { action: "snapshot", tab: "t42" }));

// ---------- 浏览器：超时（假计时器，不真等） ----------
add("browser: no answer for 120 seconds", () => surfHung("running", { action: "status" }, 120_000));
add("browser: wait with ms 20000 times out at 35 seconds", () => surfHung("page", { action: "wait", text: "老林的消息", ms: 20_000 }, 35_000));
add("browser: wait with no ms times out at 30 seconds", () => surfHung("page", { action: "wait", text: "小禾的消息" }, 30_000));

// ================= 0c：hhtools.ts 的发消息、电脑、提醒、目标、手脚、想起原话 =================
// （whatReachesMe / tryReaches / peopleIKnow 归 0d；commitToWorkspace 没有出口，借 what_reaches_me 的 add 走到）
/** 2026-11-13 10:00 UTC：这个钟点上 HH 的一天和日历上的一天是同一天；T0（02:00）则不是 */
const T10 = Date.UTC(2026, 10, 13, 10, 0);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MEL = "Australia/Melbourne";

/** 给一次调用改 ToolContext 的某几项；拿到的 trace 是这次调用的踪迹 */
type Over = (trace: string[]) => Partial<ToolContext>;
interface Ran { code: number; stdout?: string; stderr?: string }

/** 假的命令行：记下被叫的命令和选项；按顺序回 answers，用完了一直回最后一个 */
const runner = (trace: string[], ...answers: Ran[]): ToolContext["run"] => async (cmd, args, opts) => {
  trace.push(`run ${JSON.stringify([cmd, ...args])} ${JSON.stringify(opts ?? {})}`);
  const a = (answers.length > 1 ? answers.shift() : answers[0]) ?? { code: 0 };
  return { code: a.code, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
};

/** 经 buildTools 取工具（跟真的一样）、经 zod 或直接调 handler；文字后面接这次调用的踪迹 */
async function use(name: string, args: Record<string, unknown>, over?: Over, o: CtxOpts = {}, how: "tool" | "handler" = "tool"): Promise<string> {
  const { ctx, trace } = makeCtx(o);
  const full = over ? withSend({ ...ctx, ...over(trace) }) : ctx;
  // a module's script (the stickers module's sticker.py) through this call's runner, as Brain's moduleRun does
  full.moduleRun = (module, script, a, ro) => full.run(full.python, [`modules/${module}/scripts/${script}`, ...a], { cwd: full.workspace, ...ro });
  const out = await (how === "tool" ? viaTool : viaHandler)(need(buildTools(full, everything), name), args);
  return [out, "--- trace ---", ...trace].join("\n");
}

/** 临时根下的一个空目录（重跑也是空的） */
function freshDir(name: string): string {
  const d = join(ROOT, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
function put(dir: string, rel: string, text: string): void {
  const f = join(dir, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, text);
}

// ---------- commitToWorkspace（借 what_reaches_me 的 add 走到：改完文件记进工作区的 git） ----------
const GATE: NonNullable<ToolContext["gateRules"]> = {
  file: "senses/gate.json", current: () => [], reread: () => {}, people: () => { throw new Error("fake: 这几条调用用不到名单"); },
  names: { me: "阿青", notMe: [] }, sources: TEST_SOURCES, recent: () => null,
};
const RULE_ADD = { id: "qing-album-note", match: { keywords: ["阿青的相册"] }, action: "digest", note: "阿青发相册的动静放进总结" };
function viaGit(name: string, ...answers: Ran[]): Promise<string> {
  const ws = freshDir(name);
  return use("what_reaches_me", { action: "add", rule: RULE_ADD }, (t) => ({ workspace: ws, run: runner(t, ...answers), gateRules: GATE }));
}
add("commit: git add and git commit both succeed", () => viaGit("commit-ok", { code: 0 }));
add("commit: git add fails", () => viaGit("commit-add", { code: 128, stderr: "fatal: not a git repository（工作区的 .git 被老林挪走了）" }));
add("commit: git commit fails", () => viaGit("commit-commit", { code: 0 }, { code: 1, stdout: "nothing to commit", stderr: "error: 小禾的钩子拒绝了这次提交" }));
add("commit: a long git error is cut at 200 characters", () => viaGit("commit-long", { code: 0 }, { code: 1, stderr: "提交被拒绝：阿青的钩子说文件太大。".repeat(30) }));

// ---------- 发消息：假网关按剧本回 ----------
type Step = "ok" | "refused" | "timeout" | "dropped" | "down" | "down-text" | "empty" | { payload: unknown };
/** 网关按顺序回（用完了回 ok）：timeout 请求自己的时限到了、dropped 连接断了、refused 网关说没发出去、down 连不上（Error）、down-text 连不上（抛的不是 Error）、empty 回了空；{payload} 回这个。
 *  踪迹里去重编号只写第几个（同一个编号再问一次会看得出来），不写随机值 */
function scriptedGateway(trace: string[], steps: readonly Step[], connected = true): GatewayCaller {
  const left = [...steps];
  const keys = new Map<string, number>();
  return {
    connected,
    request: async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
      const { idempotencyKey, ...rest } = params;
      let key = "no-key";
      if (typeof idempotencyKey === "string") {
        if (!keys.has(idempotencyKey)) keys.set(idempotencyKey, keys.size + 1);
        key = `key#${keys.get(idempotencyKey)}`;
      }
      trace.push(`gateway ${method} ${JSON.stringify(rest)} ${timeoutMs ?? "-"} ${key}`);
      const a = left.shift() ?? "ok";
      if (a === "timeout") throw new GatewayUnsure(`gateway ${method} timeout`, "timeout");
      if (a === "dropped") throw new GatewayUnsure("gateway closed（请求已经发出去了）", "dropped");
      if (a === "refused") throw new GatewayError("UNAVAILABLE", "No delivery result");
      if (a === "down") throw new Error("connect ECONNREFUSED 127.0.0.1:9");
      if (a === "down-text") throw "连接被重置（不是 Error）";
      if (a === "empty") return undefined as T;
      if (typeof a === "object") return a.payload as T;
      return { messageId: "3EB0F1A2" } as T;
    },
  };
}
const sendOver = (steps: readonly Step[], hold?: "pass" | "hold"): Over => (t) => ({
  gateway: scriptedGateway(t, steps),
  ...(hold ? {
    beforeSend: async (to: string, text: string, media?: string): Promise<string | null> => {
      t.push(`beforeSend ${JSON.stringify([to, text, media ?? null])}`);
      return hold === "hold" ? "先别发：这条还没和老林对过笔记，对完再发。" : null;
    },
  } : {}),
});
const send = (args: Record<string, unknown>, over: Over = sendOver([]), o: CtxOpts = {}): Promise<string> => use("message", args, over, o);
const PIC = "/home/example/pics/老林-1131.jpg";
const VOICE = "/home/example/voice/小禾-0902.ogg";

add("message: a text to a person by name", () => send({ channel: "whatsapp", target: "阿青", message: "台灯的灯泡我明天帮你换" }));
add("message: the gateway names the conversation it recognised", () => send({ channel: "whatsapp", target: "手工小组", message: "周末集市的摊位定下来了" }, sendOver([{ payload: { messageId: "3EB0F1A3", conversationId: "手工小组@g.example" } }])));
add("message: a picture without text", () => send({ channel: "whatsapp", target: "老林", media: PIC }));
add("message: text, picture, reply and voice over QQ", () => send({ channel: "qqbot", target: "小禾", message: "这段语音是新录的", media: VOICE, replyTo: "m88213", asVoice: true }));
add("message: asVoice false is not sent on", () => send({ channel: "qqbot", target: "小禾", message: "只是文字", asVoice: false }));
add("message: an empty text", () => send({ channel: "whatsapp", target: "阿青", message: "" }));
// 没有文字也没有图时，代码今天记的是 "[undefined]"：这是它现在的样子，照样钉住
add("message: neither text nor picture", () => send({ channel: "whatsapp", target: "阿青" }));
add("message: no name resolver, the target is sent as written", () => send({ channel: "whatsapp", target: "阿青", message: "没有名单也照发" }, sendOver([]), { noResolver: true }));
add("message: a name with no number on that channel stays a name", () => send({ channel: "qqbot", target: "老林", message: "他没有 QQ" }));
add("message: the check before sending lets it through", () => send({ channel: "whatsapp", target: "老林", message: "刨子我周末还你", media: PIC }, sendOver([], "pass")));
add("message: the check before sending holds it back", () => send({ channel: "whatsapp", target: "老林", message: "这句不该现在发" }, sendOver([], "hold")));
add("message: dry run", () => send({ channel: "whatsapp", target: "阿青", message: "试一下" }, (t) => ({ ...sendOver([])(t), sendDryRun: true })));
add("message: no gateway connection", () => send({ channel: "whatsapp", target: "阿青", message: "发不出去" }, (t) => ({ ...sendOver([])(t), gateway: undefined })));
add("message: the gateway refuses", () => send({ channel: "whatsapp", target: "阿青", message: "被拒绝的一句" }, sendOver(["refused"])));
add("message: the connection dropped, not re-asked", () => send({ channel: "whatsapp", target: "阿青", message: "连接断了的一句" }, sendOver(["dropped"])));
add("message: timeout and the re-ask confirms", () => send({ channel: "whatsapp", target: "阿青", message: "超时又问了一次" }, sendOver(["timeout", "ok"])));
add("message: timeout and the re-ask is refused", () => send({ channel: "whatsapp", target: "阿青", message: "超时后被拒绝" }, sendOver(["timeout", "refused"])));
add("message: timeout and the re-ask has no answer either", () => send({ channel: "whatsapp", target: "阿青", message: "超时后还是没回音" }, sendOver(["timeout", "timeout"])));
add("message: timeout and the connection drops on the re-ask", () => send({ channel: "whatsapp", target: "阿青", message: "超时后连接断了" }, sendOver(["timeout", "dropped"])));
add("message: timeout and the re-ask cannot connect", () => send({ channel: "whatsapp", target: "阿青", message: "超时后连不上" }, sendOver(["timeout", "down"])));
add("message: timeout, then something that is not an Error", () => send({ channel: "whatsapp", target: "阿青", message: "超时后抛了个字符串" }, sendOver(["timeout", "down-text"])));
add("message: a picture times out, the re-ask waits longer and confirms", () => send({ channel: "qqbot", target: "小禾", media: PIC }, sendOver(["timeout", "ok"])));
add("message: the gateway answers with nothing", () => send({ channel: "whatsapp", target: "阿青", message: "回了个空" }, sendOver(["empty"])));
add("message: a long answer is cut at 500 characters", () => send({ channel: "whatsapp", target: "阿青", message: "回得很长" }, sendOver([{ payload: { messageId: "3EB0F1A4", note: "长长的回音".repeat(200) } }])));
add("message: a missing channel is refused by zod", () => send({ target: "阿青", message: "没写渠道" }));
add("message: a channel the role is not connected to", () => send({ channel: "sms", target: "阿青", message: "没接的通道" }));

// The send path called directly (when the gateway cannot be reached it really sleeps 2 seconds before its one retry; retryMs is 0 here, as in test/send.test.ts)
type Msg = OutboundMessage;
async function deliver(steps: readonly Step[], m: Msg, o: { dry?: boolean; noGateway?: boolean; noLog?: boolean; noChannels?: boolean } = {}): Promise<string> {
  const trace: string[] = [];
  const at = (level: string) => (msg: string, extra?: Record<string, unknown>): void => { trace.push(`log ${level} ${msg} ${JSON.stringify(extra ?? {})}`); };
  const cfg = testConfig({ tools: { sendDryRun: o.dry ?? false } });
  const out = await openChannels(o.noChannels ? { ...cfg, channels: {} } : cfg, {
    retryMs: 0,
    ...(o.noGateway ? {} : { gateway: scriptedGateway(trace, steps) }),
    ...(o.noLog ? {} : { log: { info: at("info"), warn: at("warn") } }),
  }).send(m);
  return [JSON.stringify(out), "--- trace ---", ...trace].join("\n");
}
const WA: Msg = { channel: "whatsapp", target: WA_QING, text: "直接交给 deliverText 的一句" };
add("deliver: dry run", () => deliver([], WA, { dry: true }));
add("deliver: no gateway", () => deliver([], WA, { noGateway: true }));
add("deliver: the role has no channel at all", () => deliver([], WA, { noChannels: true }));
add("deliver: sent, with every option", () => deliver([], { channel: "qqbot", target: QQ_HE, text: "带齐了的一句", media: PIC, replyTo: "m5521", asVoice: true, gifPlayback: true }));
add("deliver: media only, no text", () => deliver([], { channel: "whatsapp", target: WA_ZHOU, text: "", media: PIC }));
add("deliver: cannot connect once, the second try goes through", () => deliver(["down", "ok"], WA));
add("deliver: cannot connect twice (an Error)", () => deliver(["down", "down"], WA));
add("deliver: cannot connect twice (not an Error)", () => deliver(["down-text", "down-text"], WA));
add("deliver: refused by the gateway", () => deliver(["refused"], WA));
add("deliver: connection dropped", () => deliver(["dropped"], WA));
add("deliver: timeout, the re-ask confirms (logged)", () => deliver(["timeout", "ok"], WA));
add("deliver: timeout, the re-ask confirms (no logger)", () => deliver(["timeout", "ok"], WA, { noLog: true }));
add("deliver: timeout, the re-ask is refused (logged)", () => deliver(["timeout", "refused"], WA));
add("deliver: timeout, the re-ask is refused (no logger)", () => deliver(["timeout", "refused"], WA, { noLog: true }));
add("deliver: timeout, the re-ask times out (logged)", () => deliver(["timeout", "timeout"], WA));
add("deliver: timeout, the re-ask times out (no logger)", () => deliver(["timeout", "timeout"], WA, { noLog: true }));
add("deliver: timeout, the re-ask drops", () => deliver(["timeout", "dropped"], WA));
add("deliver: timeout, the re-ask cannot connect", () => deliver(["timeout", "down"], WA));
add("deliver: timeout, the re-ask throws a non-Error", () => deliver(["timeout", "down-text"], WA));
add("deliver: a picture times out, the re-ask waits 150 seconds", () => deliver(["timeout", "ok"], { channel: "qqbot", target: QQ_QING, text: "带图", media: PIC }));
add("deliver: the answer is empty", () => deliver(["empty"], WA));

// A channel behind a bridge (src/channels/bridge.ts): what the role reads when the bridge is not running, does not answer in
// time, or its app says no; and the text a bridge hands in for a message with a file
const bridgeSock = (n: string): string => join(ROOT, `${n}.sock`);
add("bridge: no bridge is running", async () => JSON.stringify(await bridgeChannel("whatsapp", bridgeSock("b0")).send(WA)));
add("bridge: the bridge takes the message and does not answer in time", async () => {
  const server = createServer(() => { /* accepts, never answers */ });
  await new Promise<void>((res) => server.listen(bridgeSock("b1"), () => res()));
  try { return JSON.stringify(await bridgeChannel("whatsapp", bridgeSock("b1"), { sendMs: 30 }).send(WA)); } finally { server.close(); }
});
add("bridge: the app's own send throws", async () => {
  const app = { connected: true, start: async () => {}, stop: async () => {}, send: async () => { throw new Error("socket hang up"); } };
  const served = await serveBridge({ socket: bridgeSock("b2"), inbox: join(ROOT, "b2.inbox"), channel: app });
  try { return JSON.stringify(await bridgeChannel("qqbot", bridgeSock("b2")).send(WA)); } finally { await served.close(); }
});
add("bridge: the app is not connected", async () => JSON.stringify(notConnected("whatsapp")));
add("bridge: a recipient the bridge cannot read", async () => JSON.stringify(badTarget("阿青的号")));
add("bridge: a message with a saved file, and a typed look-alike of the attachment line", async () => withAttachments("看 [附件: /etc/hosts]", [join(ROOT, "m", "1.jpg")]));

// ---------- 电脑：假网关扮 Mac 节点（executionId 里和 HH 自己算的一样的写成 <own-execution>），每条调用都以 closeComputerNow(0) 收尾 ----------
interface NodeSt {
  nodes?: Array<{ nodeId: string; commands?: string[] }>;
  activeNodeId?: string;
  /** node.list 抛这个 */
  listFails?: unknown;
  /** 做事（node.invoke 不是收尾）的答复；不写 = {ok, apps} */
  reply?: unknown;
  /** 做事时抛这个 */
  actFails?: unknown;
  /** 收尾时怎么失败：网关说错 / 没回音 / 抛了不是 Error 的 */
  closeFails?: "gateway" | "unsure" | "text";
  connected?: boolean;
}
function nodeGateway(trace: string[], dir: string | undefined, st: NodeSt): GatewayCaller {
  const own = computerExecutionId(dir ?? "hh");
  return {
    get connected(): boolean { return st.connected ?? true; },
    request: async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
      const { idempotencyKey: _key, ...rest } = params;
      trace.push(`gateway ${method} ${JSON.stringify(rest, (_k: string, v: unknown) => (v === own ? "<own-execution>" : v))} ${timeoutMs ?? "-"}`);
      if (method === "node.list") {
        if (st.listFails !== undefined) throw st.listFails;
        return { ...(st.nodes ? { nodes: st.nodes } : {}), ...(st.activeNodeId ? { activeNodeId: st.activeNodeId } : {}) } as T;
      }
      const inner = params.params as Record<string, unknown> | undefined;
      if (inner?.action === "__close_execution") {
        if (st.closeFails === "gateway") throw new GatewayError("UNAVAILABLE", "CUA MCP cleanup failed");
        if (st.closeFails === "unsure") throw new GatewayUnsure("gateway node.invoke timeout", "timeout");
        if (st.closeFails === "text") throw "收尾的连接被重置（不是 Error）";
        return { ok: true } as T;
      }
      if (st.actFails !== undefined) throw st.actFails;
      return (st.reply !== undefined ? st.reply : { ok: true, apps: ["Finder", "备忘录"] }) as T;
    },
  };
}
const NODES = [{ nodeId: "phone", commands: [] as string[] }, { nodeId: "mac-a", commands: ["computer.act", "screen.snapshot"] }];
interface Go {
  go(action: string, params?: Record<string, unknown>): Promise<string>;
  st: NodeSt;
  say(s: string): void;
  closeNow(): Promise<void>;
  dir: string | undefined;
}
/** 经 computer 工具走一串步骤（可以中途改假网关的脾气）；不管怎样最后 closeComputerNow(0)，文字后面接踪迹 */
async function computerRun(init: NodeSt, steps: (c: Go) => Promise<void>, o: { dir?: string; noGateway?: boolean } = {}): Promise<string> {
  const { ctx: base, trace } = makeCtx();
  const dir = o.dir === undefined ? undefined : freshDir(o.dir);
  const st: NodeSt = { ...init };
  const ctx: ToolContext = { ...base, ...(o.noGateway ? { gateway: undefined } : { gateway: nodeGateway(trace, dir, st) }), ...(dir ? { shotsDir: dir } : {}) };
  const tool = need(buildTools(ctx, everything), "computer");
  const out: string[] = [];
  try {
    await steps({
      go: async (action, params) => { const r = await viaTool(tool, params ? { action, params } : { action }); out.push(`${action}: ${r}`); return r; },
      st, dir, say: (s) => { out.push(s); }, closeNow: () => closeComputerNow(0),
    });
  } finally {
    await closeComputerNow(0);
  }
  return [...out, "--- trace ---", ...trace].join("\n");
}
/** 一个目录里存下来的图：名字（时间戳换成 <T>）和大小 */
const shotFiles = (dir: string | undefined): string => (dir ? readdirSync(dir).map((f) => `${f.replace(/^shot-\d+-/, "shot-<T>-")} ${statSync(join(dir, f)).size}`).sort().join("\n") || "(no files)" : "(no dir)");
const PNG_B64 = "iVBORw0KGgo".repeat(300);
const PNG_URL = `data:image/png;base64,${"iVBORw0KGgoAAAANSUhEUg".repeat(8)}`;
const JPG_URL = `data:image/jpeg;base64,${"/9j/4AAQSkZJRgABAQ".repeat(20)}`;

add("computer: executionId of the default seed", () => computerExecutionId("hh"));
add("computer: executionId of a path seed", () => computerExecutionId("/home/example/.hh/shots"));
add("computer: executionId of an empty seed", () => computerExecutionId(""));
add("computer: executionId of a Chinese seed", () => computerExecutionId("阿青的屏幕"));
add("computer: no gateway", () => computerRun({}, async (c) => { await c.go("list_apps"); }, { noGateway: true }));
add("computer: the node that has computer.act is chosen", () => computerRun({ nodes: NODES }, async (c) => { await c.go("list_apps"); }));
add("computer: her own executionId is replaced, the other parameters ride along", () =>
  computerRun({ nodes: NODES }, async (c) => { await c.go("left_click", { x: 311, y: 478, displayFrameId: "frame-1", executionId: "crab-click-1" }); }));
add("computer: no node has computer.act, the active node is used", () =>
  computerRun({ nodes: [{ nodeId: "phone", commands: [] }, { nodeId: "no-commands" }], activeNodeId: "mac-b" }, async (c) => { await c.go("list_apps"); }));
add("computer: only an active node is listed", () => computerRun({ activeNodeId: "mac-c" }, async (c) => { await c.go("list_apps"); }));
add("computer: no node at all (the close still goes to the last node used)", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    await c.closeNow();
    c.st.nodes = [];
    await c.go("list_apps");
  }));
add("computer: a screenshot is saved to a file", () =>
  computerRun({ nodes: NODES, reply: { format: "png", base64: PNG_B64, displayFrameId: "frame-1" } }, async (c) => {
    // 文件名里是 Date.now()：两次截图可能落在同一毫秒而互相覆盖，所以这条里让它每问一次走一格
    let tick = 1_700_000_000_000;
    const fake = mock.method(Date, "now", () => tick++);
    try {
      await c.go("screenshot");
      c.say(shotFiles(c.dir));
      await c.go("screenshot", { display: 2 });
      c.say(shotFiles(c.dir));
    } finally {
      fake.mock.restore();
    }
  }, { dir: "shots-a" }));
add("computer: images nested in arrays and objects, and values that stay as they are", () =>
  computerRun({
    nodes: NODES,
    reply: { frames: [{ data: PNG_URL }, "短说明", 7, null, true, [JPG_URL, { inner: PNG_B64 }], "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", "说明".repeat(1500), `${"A".repeat(50)}，不是图`], note: "阿青的相册截完了" },
  }, async (c) => {
    await c.go("get_window_state", { windowRef: "w1" });
    c.say(shotFiles(c.dir));
  }, { dir: "shots-b" }));
add("computer: the answer is cut at 6000 characters", () => computerRun({ nodes: NODES, reply: { text: "禾".repeat(7000) } }, async (c) => { await c.go("get_accessibility_tree"); }));
add("computer: the desktop is locked", () => computerRun({ nodes: NODES, actFails: new Error("UNAVAILABLE: COMPUTER_DESKTOP_LOCKED: unlock") }, async (c) => { await c.go("left_click", { x: 1, y: 2 }); }));
add("computer: the computer is busy", () => computerRun({ nodes: NODES, actFails: new Error("UNAVAILABLE: COMPUTER_HOST_BUSY: another provider execution owns this computer") }, async (c) => { await c.go("list_apps"); }));
add("computer: another Error says 没做成", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.actFails = new Error("gateway timeout");
    await c.go("left_click", { x: 5, y: 6 });
  }));
add("computer: something that is not an Error", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.actFails = "节点连接被老林拔掉了（不是 Error）";
    await c.go("list_apps");
  }));
add("computer: a long error is cut at 400 characters", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.actFails = new Error("节点那边的日志太长了：" + "小禾的窗口没响应，".repeat(80));
    await c.go("list_apps");
  }));
add("computer: a close the gateway refuses is logged, and the next error says so (until one succeeds)", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.closeFails = "gateway";
    await c.closeNow();
    c.st.closeFails = undefined;
    c.st.actFails = new GatewayError("UNAVAILABLE", "CUA MCP cleanup failed");
    await c.go("left_click", { x: 9, y: 9 });
    c.st.actFails = undefined;
    await c.go("list_apps");
    c.st.actFails = new Error("gateway timeout");
    await c.go("left_click", { x: 9, y: 9 });
  }));
add("computer: a close with no answer is only a warning", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.closeFails = "unsure";
    await c.closeNow();
    c.st.actFails = new Error("gateway timeout");
    await c.go("left_click", { x: 9, y: 9 });
  }));
add("computer: a close that throws a non-Error is only a warning", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.closeFails = "text";
    await c.closeNow();
  }));
add("computer: a disconnected gateway is not asked to close", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    c.st.connected = false;
    await c.closeNow();
  }));
add("computer: node.list fails with an Error, the close still goes to the last node", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    await c.closeNow();
    c.st.listFails = new Error("gateway timeout");
    await c.go("list_apps");
  }));
add("computer: node.list throws a non-Error", () =>
  computerRun({ nodes: NODES }, async (c) => {
    await c.go("list_apps");
    await c.closeNow();
    c.st.listFails = "节点列表读不出来（不是 Error）";
    await c.go("list_apps");
  }));

// ---------- 时间：parseWhen / parseEvery / whenLabel（钟和时区都是给定的，不碰真时钟） ----------
const stamp = (n: number): string => new Date(n).toISOString();
const stamped = (f: () => number): string => {
  try { const n = f(); return `${n} ${stamp(n)}`; } catch (e) { return caught(e); }
};
const whenRows: Array<[string, number, string]> = [
  ["+40m", T10, "UTC"], ["+2h", T10, "UTC"], ["  +15m  ", T10, "UTC"], ["+90 m", T10, "UTC"], ["+0m", T10, "UTC"],
  ["15:00", T10, "UTC"], ["9:30", T10, "UTC"], ["10:00", T10, "UTC"], ["23:59", T10, "UTC"], ["02:00", T0, "UTC"], ["03:30", T0, "UTC"], ["15:00", T10, MEL],
  ["2026-11-14T08:30:00Z", T10, "UTC"], ["2026-11-14 08:30", T10, "UTC"], ["2026-11-14", T10, "UTC"], ["2026-11-14T08:30:00+11:00", T10, MEL],
  ["下周三", T10, "UTC"], ["later", T10, "UTC"], ["", T10, "UTC"], ["   ", T10, "UTC"],
];
for (const [when, now, tz] of whenRows) add(`time: parseWhen ${JSON.stringify(when)} at ${stamp(now).slice(11, 16)} ${tz}`, () => stamped(() => parseWhen(when, now, tz)));
const labelRows: Array<[string, number, number, string]> = [
  ["same day", T10 + 5 * HOUR, T10, "UTC"], ["earlier the same day", T10 - 3 * HOUR, T10, "UTC"], ["next day", T10 + 23 * HOUR, T10, "UTC"],
  ["three days on", T10 + 3 * DAY, T10, "UTC"], ["yesterday", T10 - DAY, T10, "UTC"], ["small hours of the next calendar day", T10 + 16 * HOUR, T10, "UTC"],
  ["now in the small hours", T0 + 8 * HOUR, T0, "UTC"], ["both in the small hours", T0 + HOUR, T0, "UTC"], ["next day in Melbourne", T10 + 12 * HOUR, T10, MEL],
];
for (const [what, ts, now, tz] of labelRows) add(`time: whenLabel ${what} (${stamp(ts).slice(0, 16)} from ${stamp(now).slice(0, 16)} ${tz})`, () => whenLabel(ts, now, tz));
const everyRows: Array<string | undefined> = [undefined, "", "daily", "30m", "2h", " 45 m ", "24h", "1h", "29m", "10m", "0h", "weekly", "daily ", "1.5h", "2H"];
for (const every of everyRows) add(`time: parseEvery ${JSON.stringify(every)}`, () => { try { return String(parseEvery(every)); } catch (e) { return caught(e); } });

// ---------- remind / reminders（假的排程：记下排了什么、记了什么） ----------
interface Item { id: number; kind: "remind" | "focus"; due: number; everyMs: number | null; text: string; minutes: number | null }
interface SchedOpts { now?: number; timezone?: string; remindDone?: boolean; scheduled?: Item[]; doneAt?: Record<number, number | null>; unschedule?: boolean }
const sched = (so: SchedOpts = {}): Over => (t) => ({
  now: () => so.now ?? T10,
  timezone: so.timezone ?? "UTC",
  schedule: (kind: "remind" | "focus", due: number, text: string, everyMs: number | null, minutes?: number | null): number => {
    t.push(`schedule ${JSON.stringify([kind, due, stamp(due), text, everyMs, minutes ?? null])}`);
    return 41;
  },
  ...(so.remindDone === false ? {} : { remindDone: (id: number): void => { t.push(`remindDone ${id}`); } }),
  ...(so.scheduled ? { scheduled: (): Item[] => so.scheduled ?? [] } : {}),
  ...(so.doneAt ? { remindDoneAt: (id: number): number | null => so.doneAt?.[id] ?? null } : {}),
  ...(so.unschedule === false ? {} : { unschedule: (id: number): boolean => { t.push(`unschedule ${id}`); return true; } }),
});
const remind = (args: Record<string, unknown>, so?: SchedOpts): Promise<string> => use("remind", args, sched(so));
const LAMP = "给阿青的台灯换灯泡，备用的在工作台左边的抽屉里";

add("remind: once, in 40 minutes", () => remind({ when: "+40m", text: LAMP }));
add("remind: once, right now", () => remind({ when: "now", text: LAMP }));
add("remind: once, a full time", () => remind({ when: "2026-11-14T08:30:00Z", text: LAMP }));
add("remind: once, in Melbourne's time zone", () => remind({ when: "15:00", text: LAMP }, { timezone: MEL }));
add("remind: daily, first time later today", () => remind({ when: "15:00", text: LAMP, every: "daily" }));
add("remind: daily, first time tomorrow", () => remind({ when: "09:00", text: LAMP, every: "daily" }));
add("remind: every 2 hours, first time today", () => remind({ when: "+30m", text: LAMP, every: "2h" }));
add("remind: every 45 minutes", () => remind({ when: "+10m", text: LAMP, every: "45m" }));
add("remind: daily, already done today", () => remind({ when: "15:00", text: LAMP, every: "daily", done_today: true }));
add("remind: every 2 hours, already done today", () => remind({ when: "+30m", text: LAMP, every: "2h", done_today: true }));
add("remind: already done today, but no way to record it", () => remind({ when: "15:00", text: LAMP, every: "daily", done_today: true }, { remindDone: false }));
add("remind: daily in the small hours, first time still in the HH day", () => remind({ when: "03:30", text: LAMP, every: "daily" }, { now: T0 }));
add("remind: daily in the small hours, already done today", () => remind({ when: "03:30", text: LAMP, every: "daily", done_today: true }, { now: T0 }));
add("remind: an empty every is no loop", () => remind({ when: "+1h", text: LAMP, every: "" }));
add("remind: a focus with the default 30 minutes", () => remind({ when: "+10m", kind: "focus", text: "整理小禾的明信片目录" }));
add("remind: a focus with minutes", () => remind({ when: "+10m", kind: "focus", text: "整理小禾的明信片目录", minutes: 45 }));
add("remind: a focus that loops", () => remind({ when: "09:00", kind: "focus", text: "整理小禾的明信片目录", minutes: 60, every: "daily" }));
add("remind: kind=remind spelled out", () => remind({ when: "+1h", kind: "remind", text: LAMP }));
add("remind: a time that cannot be read", () => remind({ when: "下周三", text: LAMP }));
add("remind: a loop that cannot be read", () => remind({ when: "+1h", text: LAMP, every: "weekly" }));
add("remind: a loop shorter than 30 minutes", () => remind({ when: "+1h", text: LAMP, every: "10m" }));
add("remind: minutes below 5 refused by zod", () => remind({ when: "+1h", kind: "focus", text: "x", minutes: 3 }));
add("remind: no time refused by zod", () => remind({ text: LAMP }));

const REM_A: Item = { id: 11, kind: "remind", due: T10 + 5 * HOUR, everyMs: DAY, text: "给阿青的台灯买灯泡，要暖光的那种", minutes: null };
const REM_B: Item = { id: 12, kind: "remind", due: T10 + 30 * MIN, everyMs: 2 * HOUR, text: "老林的刨子今天要还给小禾", minutes: null };
const REM_C: Item = { id: 13, kind: "focus", due: T10 + 3 * HOUR, everyMs: 90 * MIN, text: "整理小禾的明信片目录", minutes: 45 };
// "主人排的" 是被测代码（hhtools.ts 的 startsWith）认的记号，编不出别的名字走到那一支；留给以后「记号」那一步列出
const REM_D: Item = { id: 14, kind: "focus", due: T10 + 26 * HOUR, everyMs: null, text: "ada 排的专注：帮阿青核对相册", minutes: null };
const REM_E: Item = { id: 15, kind: "remind", due: T10 + 23 * HOUR, everyMs: DAY, text: "ada 排的提醒：周末给老林回电话，顺便问问枣树的事，再问问他刨子的下落，别忘了", minutes: null };
const REM_F: Item = { id: 16, kind: "remind", due: T10 + 4 * HOUR, everyMs: null, text: "给小禾的集市摊送一箱明信片，顺便带上老林借走的那把刨子和阿青的台灯，再替老林问问摊位旁边那家卖枣糕的铺子几点收摊，别忘了带零钱", minutes: null };
const REM_G: Item = { id: 17, kind: "remind", due: T10 - HOUR, everyMs: DAY, text: "给阿青的薄荷浇水", minutes: null };
const ALL: Item[] = [REM_A, REM_B, REM_C, REM_D, REM_E, REM_F, REM_G];
const DONE_AT: Record<number, number | null> = { 11: T10 - 2 * HOUR, 12: T10 - 20 * HOUR, 13: T10 - HOUR, 15: null };
const reminders = (args: Record<string, unknown>, so: SchedOpts = {}): Promise<string> => use("reminders", args, sched({ scheduled: ALL, doneAt: DONE_AT, ...so }));

add("reminders: ls with every kind of item", () => reminders({ action: "ls" }));
add("reminders: ls in Melbourne's time zone", () => reminders({ action: "ls" }, { timezone: MEL }));
add("reminders: ls without a way to read when each was done", () => use("reminders", { action: "ls" }, sched({ scheduled: [REM_A, REM_F] })));
add("reminders: ls with nothing scheduled", () => use("reminders", { action: "ls" }, sched({ scheduled: [] })));
add("reminders: ls when the context cannot list", () => use("reminders", { action: "ls" }, sched()));
add("reminders: cancel without a number", () => reminders({ action: "cancel" }));
add("reminders: done without a number", () => reminders({ action: "done" }));
add("reminders: cancel a number that is not there", () => reminders({ action: "cancel", id: 99 }));
add("reminders: done a number that is not there", () => reminders({ action: "done", id: 99 }));
add("reminders: done on a one-off", () => reminders({ action: "done", id: 16 }));
add("reminders: done on a focus", () => reminders({ action: "done", id: 13 }));
add("reminders: done on a daily one due later today", () => reminders({ action: "done", id: 11 }));
add("reminders: done on a daily one when nothing can record it", () => reminders({ action: "done", id: 11 }, { remindDone: false }));
add("reminders: done on an every-2-hours one", () => reminders({ action: "done", id: 12 }));
add("reminders: done on a daily one whose time has passed", () => reminders({ action: "done", id: 17 }));
add("reminders: done on a daily one that is not due today", () => reminders({ action: "done", id: 15 }));
add("reminders: cancel one of the owner's focus", () => reminders({ action: "cancel", id: 14 }));
add("reminders: cancel one of the owner's reminders", () => reminders({ action: "cancel", id: 15 }));
add("reminders: cancel a long one (cut at 40 characters)", () => reminders({ action: "cancel", id: 16 }));
add("reminders: cancel a short one", () => reminders({ action: "cancel", id: 11 }));
add("reminders: cancel when the context cannot unschedule", () => reminders({ action: "cancel", id: 11 }, { unschedule: false }));
add("reminders: an action outside the list refused by zod", () => reminders({ action: "pause", id: 11 }));

// ---------- ack / jot_down ----------
const ack = (args: Record<string, unknown>, ran: Ran = { code: 0 }): Promise<string> => use("ack", args, (t) => ({ run: runner(t, ran) }));
add("ack: an id that is not hex", () => ack({ id: "xyz-阿青" }));
add("ack: an id that is too short", () => ack({ id: "abc12" }));
add("ack: an id that is too long", () => ack({ id: "a1".repeat(21) }));
add("ack: an id with spaces around it", () => ack({ id: "  3F9A0C7B12DE  " }));
add("ack: the script says no", () => ack({ id: "9e8d7c6b5a40", }, { code: 2, stdout: "", stderr: "senses.py: 没有这个 id" }));
add("ack: a missing id refused by zod", () => ack({}));
const jot = (args: Record<string, unknown>): Promise<string> => use("jot_down", args, (t) => ({ note: (text: string, o?: { urgent?: boolean }): void => { t.push(`note ${JSON.stringify([text, o ?? null])}`); } }));
add("jot_down: a plain note", () => jot({ text: "小禾说集市的摊位费下周一退" }));
add("jot_down: an urgent note", () => jot({ text: "老林十分钟后要出门，刨子的事得现在告诉他", urgent: true }));
add("jot_down: urgent false is the same as plain", () => jot({ text: "阿青的灯泡换好了", urgent: false }));

// ---------- goals / hands ----------
const GOALS_JSON = JSON.stringify({ goals: [{ id: "g3", title: "给阿青的台灯换灯泡", why: "她晚上看书要用" }, { id: "g7", title: "整理小禾的明信片目录", why: "" }, { id: "g9" }] });
interface GoalOpts { json?: string | null; ran?: Ran; notes?: "echo" | "empty" | "absent" }
/** The goals module's tool, called the way a region calls it: its script and the notes through a context made here */
async function goals(name: string, args: Record<string, unknown> | string[], o: GoalOpts = {}): Promise<string> {
  const ws = freshDir(name);
  if (o.json !== null) put(ws, "memory/goals/goals.json", o.json ?? GOALS_JSON);
  const trace: string[] = [];
  const ran = runner(trace, o.ran ?? { code: 0, stdout: "g3 推进了：换上了新灯泡" });
  const m = {
    run: async (script: string, argv: readonly string[], ro?: { timeoutMs?: number }) => argv[0] === "topic"
      ? (trace.push(`run ${JSON.stringify([script, ...argv])}`), { code: 0, stdout: goalsTopic(join(ws, "memory/goals/goals.json"), argv.slice(1)), stderr: "", timedOut: false })
      : { ...(await ran("py", [script, ...argv], ro)), timedOut: false },
    ...(o.notes === "absent" ? {} : {
      notes: async (topic: string, binding: "goals"): Promise<string> => {
        trace.push(`recallNotes ${JSON.stringify([topic, binding])}`);
        return o.notes === "empty" ? "" : `（想起来的笔记）${topic}`;
      },
    }),
  } as unknown as ModuleContext;
  const t = goalsModule.tools![0]!;
  const def: ToolDef = { name: t.name, description: typeof t.description === "function" ? t.description() : t.description, shape: typeof t.shape === "function" ? t.shape() : t.shape, handler: (a) => t.handler(a, m) };
  const out = await viaTool(def, Array.isArray(args) ? { args } : args);
  return [out, "--- trace ---", ...trace].join("\n");
}
add("goals: ls does not look up notes", () => goals("goals-1", ["ls"]));
add("goals: add with a why", () => goals("goals-2", ["add", "today", "给老林的收音机换电池", "--why", "他说声音越来越小", "--done-when", "能听清整点新闻"]));
add("goals: add without a why", () => goals("goals-3", ["add", "today", "给小禾的摊位做一块牌子"]));
add("goals: add whose why has no value", () => goals("goals-4", ["add", "today", "擦工作台", "--why"]));
add("goals: add with the other options and an unknown one", () => goals("goals-5", ["add", "short", "给阿青的薄荷换盆", "--parent", "g1", "--due", "2026-11-20", "--link", "e0158", "--foo", "--why", "根都顶出来了"]));
add("goals: add with a level and no title", () => goals("goals-6", ["add", "today"]));
add("goals: add with nothing", () => goals("goals-7", ["add"]));
add("goals: log looks up the goal's title and why", () => goals("goals-8", ["log", "g3", "推进了：灯泡买到了"]));
add("goals: block on a goal with an empty why", () => goals("goals-9", ["block", "g7", "等小禾回消息"]));
add("goals: log on a goal with no title", () => goals("goals-10", ["log", "g9", "不知道是哪个"]));
add("goals: log on a goal that is not in the file", () => goals("goals-11", ["log", "g99", "没有这个目标"]));
add("goals: log with no goals.json", () => goals("goals-12", ["log", "g3", "文件不见了"], { json: null }));
add("goals: log with a goals.json that is not JSON", () => goals("goals-13", ["log", "g3", "文件坏了"], { json: "{坏了" }));
add("goals: log with a goals.json that has no goals", () => goals("goals-14", ["log", "g3", "没有目标列表"], { json: "{}" }));
add("goals: another subcommand does not look up notes", () => goals("goals-15", ["done", "g3"]));
add("goals: the script fails, no notes", () => goals("goals-16", ["add", "today", "失败的一条", "--why", "脚本退出了"], { ran: { code: 2, stdout: "", stderr: "goals.py: 标题重复" } }));
add("goals: no way to look up notes", () => goals("goals-17", ["add", "today", "没有联想的一条", "--why", "测试"], { notes: "absent" }));
add("goals: the notes lookup finds nothing", () => goals("goals-18", ["add", "today", "联想不到的一条", "--why", "测试"], { notes: "empty" }));
add("goals: a missing args list refused by zod", () => goals("goals-19", {}));

const hands = (args: Record<string, unknown>, ran: Ran = { code: 0, stdout: "已派给 阿青的帮手" }): Promise<string> => use("hands", args, (t) => ({ run: runner(t, ran) }));
add("hands: send with a model", () => hands({ action: "send", name: "阿青的帮手", text: "把相册里重复的图删掉", model: "opus" }));
add("hands: send with the default model", () => hands({ action: "send", name: "小禾的帮手", text: "整理明信片目录", model: "default" }));
add("hands: send without a model", () => hands({ action: "send", name: "老林的帮手", text: "核对刨子的借还记录" }));
add("hands: send without a name", () => hands({ action: "send", text: "没写名字" }));
add("hands: send with an empty name", () => hands({ action: "send", name: "", text: "名字是空的" }));
add("hands: send without a text", () => hands({ action: "send", name: "阿青的帮手" }));
add("hands: show", () => hands({ action: "show", name: "阿青的帮手" }, { code: 0, stdout: "它回了：重复的图删了 12 张" }));
add("hands: ls", () => hands({ action: "ls" }, { code: 0, stdout: "阿青的帮手 干活中\n小禾的帮手 空闲" }));
add("hands: stop", () => hands({ action: "stop", name: "小禾的帮手" }));
add("hands: the script fails", () => hands({ action: "show", name: "不存在的帮手" }, { code: 1, stderr: "cc.py: 没有这个帮手" }));
add("hands: no output at all", () => hands({ action: "ls" }, { code: 0 }));
add("hands: an action outside the list refused by zod", () => hands({ action: "dance" }));

// ---------- recall / what_do_i_know ----------
interface RecallOpts { local?: string; quotes?: string | null; day?: string | null; ran?: Ran }
/** quotes：原话库（null = 没有这个能力）；day：某一天的原话（null = 没有这个能力） */
function recall(args: string[], o: RecallOpts = {}): Promise<string> {
  return use("recall", { args }, (t) => ({
    recallLocal: (a: string[]): string => { t.push(`recallLocal ${JSON.stringify(a)}`); return o.local ?? ""; },
    run: runner(t, o.ran ?? { code: 0, stdout: "Honcho 里找到：小禾提过一次摊位费" }),
    ...(o.quotes === undefined || o.quotes === null ? {} : {
      recallQuotes: async (q: string, who?: string, opts?: { olderOnly?: boolean }): Promise<string> => { t.push(`recallQuotes ${JSON.stringify([q, who ?? null, opts ?? null])}`); return o.quotes ?? ""; },
    }),
    ...(o.day === undefined || o.day === null ? {} : {
      recallQuotesDay: (d: string, who?: string): string => { t.push(`recallQuotesDay ${JSON.stringify([d, who ?? null])}`); return o.day ?? ""; },
    }),
  }));
}
const LOCAL = "#297 阿青：刨子放在左边的抽屉里 (q5626)";
const OLDER = "q0412 老林：刨子借给小禾了（10-08 以前的原话）";
add("recall: search finds both, older ones only asked for", () => recall(["search", "刨子", "--who", "老林"], { local: LOCAL, quotes: OLDER }));
add("recall: search finds only the older ones", () => recall(["search", "刨子"], { quotes: OLDER }));
add("recall: search finds only the central ones", () => recall(["search", "刨子"], { local: LOCAL, quotes: "" }));
add("recall: search finds nothing", () => recall(["search", "刨子"], { quotes: "" }));
add("recall: search with no keyword", () => recall(["search"], { quotes: "" }));
add("recall: search ending in --who without a value", () => recall(["search", "刨子", "--who"], { quotes: OLDER }));
add("recall: day finds both", () => recall(["day", "2026-10-28", "--who", "小禾"], { local: LOCAL, quotes: "", day: "q0502 小禾：摊位费的事（那天的旧原话）" }));
add("recall: day finds only the older ones", () => recall(["day", "2026-10-28"], { quotes: "", day: "q0502 小禾：摊位费的事（那天的旧原话）" }));
add("recall: day finds only the central ones", () => recall(["day", "2026-10-28"], { local: LOCAL, quotes: "", day: "" }));
add("recall: day finds nothing", () => recall(["day", "2026-10-28"], { quotes: "", day: "" }));
add("recall: day with no way to read the older day", () => recall(["day", "2026-10-28"], { quotes: "" }));
add("recall: day with no date", () => recall(["day"], { quotes: "", day: "" }));
add("recall: around finds it, quote library present", () => recall(["around", "q5626"], { local: LOCAL, quotes: OLDER }));
add("recall: around finds nothing, quote library present", () => recall(["around", "q5626"], { quotes: OLDER }));
add("recall: around finds it, no quote library", () => recall(["around", "q5626"], { local: LOCAL }));
add("recall: around finds nothing, no quote library, the script answers", () => recall(["around", "q5626"]));
add("recall: search finds nothing locally, no quote library, the script answers", () => recall(["search", "刨子", "-n", "20"]));
add("recall: no quote library and the script fails", () => recall(["show", "q5626", "--from", "400"], { ran: { code: 1, stderr: "recall.py: Honcho 连不上" } }));

const know = (args: Record<string, unknown>, asks: boolean): Promise<string> => use("what_do_i_know", args, (t) => (asks ? {
  askNotes: async (topic: string, category?: string): Promise<string> => { t.push(`askNotes ${JSON.stringify([topic, category ?? null])}`); return `（笔记里相关的页）${topic}${category ? `，只看「${category}」` : ""}`; },
} : {}));
add("know: a topic with a category", () => know({ topic: "怎么给老林的收音机换电池", category: "手艺" }, true));
add("know: a topic without a category", () => know({ topic: "怎么给老林的收音机换电池" }, true));
add("know: an empty category counts as none", () => know({ topic: "小禾的摊位", category: "" }, true));
add("know: no notebook to ask", () => know({ topic: "小禾的摊位" }, false));
add("know: a missing topic refused by zod", () => know({}, true));

// ---------- 没有工具入口的两句（brain.ts 取用）：直接调 ----------
add("direct: notesUnreadable", () => notesUnreadable());
add("direct: categoryMissing with the shelf's categories", () => categoryMissing("园艺", ["手艺", "人情", "集市"]));
add("direct: categoryMissing with an empty shelf", () => categoryMissing("园艺", []));

// ---------- built-in modules: words a module hands the role ----------
add("module stickers: the weekly hunt reminder, a week after the last", async () => {
  const state = join(ROOT, "modules", "stickers");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "hunt.json"), JSON.stringify({ at: Date.now() - 8 * 24 * 3600_000 }));
  const said: string[] = [];
  await stickersModule.timers!.find((t) => t.name === "hunt")!.run.run({ stateDir: state, config: {}, remind: (text: string) => { said.push(text); } } as unknown as ModuleContext);
  return said.join("\n");
});
// ---------- built-in modules: the tools a module hands the role ----------
for (const t of goalsModule.tools ?? []) {
  add(`def module goals/${t.name}`, () => defText({ name: t.name, description: typeof t.description === "function" ? t.description() : t.description, shape: typeof t.shape === "function" ? t.shape() : t.shape, handler: async () => "" }, "module"));
}
for (const t of mediaModule.tools ?? []) {
  add(`def module media/${t.name}`, () => defText({ name: t.name, description: typeof t.description === "function" ? t.description() : t.description, shape: typeof t.shape === "function" ? t.shape() : t.shape, handler: async () => "" }, "module"));
}

// ================= 0d：hhtools.ts 的 what_reaches_me / people_i_know，以及 brain.ts 里的两个工具定义（scratch） =================
/** 改完文件后读回来接在文字后面（没有这个文件就写明） */
const fileAfter = (dir: string, rel: string): string => { const f = join(dir, rel); return existsSync(f) ? readFileSync(f, "utf8") : "(no file)"; };

// ---------- 名单里的人（people_i_know 用，what_reaches_me 的 try 也要认人） ----------
// 主人是名单里 privacy 写着 owner 的那条（代码认这个字段，不认名字）；这里主人叫老林
const P_OWNER = { name: "老林", privacy: "owner", senders: [WA_ZHOU, "ZHOU0000OPENID000000000000000001"], sessionKeys: ["agent:zhou:desk"], handles: { wx: ["老林的微信"] } };
// 阿青：升过权的人（trusted、共享文件），底子里连认人字段一起记着
const P_QING = {
  name: "阿青", privacy: "guest", trust: "trusted", shared: ["notes/集市.md"], sharedThreads: ["t-market"],
  allowedScripts: { "scripts/cast.py": ["play"] }, senders: [WA_QING], handles: { wx: ["阿青的微信"], xhs: ["青青的小红书"] },
};
const P_HE = { name: "小禾", privacy: "guest", senders: ["+6155500021"], handles: { wx: ["小禾的微信"] } };
const NEW_NUMBER = "+6155500022";
const P_REG: Record<string, unknown> = { _说明: "认人用的名单（夹具）", zhou: P_OWNER, qing: P_QING, he: P_HE, loose: "不是对象的条目" };
const { zhou: _owner, ...WITHOUT_OWNER } = P_REG;

// ---------- what_reaches_me：规则和动静的夹具 ----------
const GATE_REL = "senses/gate.json";
const RULES_X: Rule[] = [
  { id: "market-group", match: { src: "wx", conv: "集市群", mentionsMe: false }, action: "judge", when: "now",
    want: "提到我或老林的摊位；和我在做的事有关；有人问了问题没人接；打游戏、表情包、和我无关的闲聊不用——这一条故意写得很长，好让列表把它从第六十个字截断",
    note: "老林说：集市群里无关的不进主意识" },
  { id: "postcard-likes", match: { src: "xhs", keywords: ["赞了", "收藏了"] }, action: "digest" },
  { id: "net-probe", match: { src: "phone_net" }, action: "digest", ifUnsure: "main" },
  { id: "stranger-dm", match: { src: ["wx", "xhs"], isGroup: false, known: false }, action: "judge", when: "work", ifUnsure: "digest" },
];
const GATE_JSON = JSON.stringify({ _说明: "阿青的下意识规则（夹具）", rules: RULES_X }, null, 2);
/** 有各种坏条目的规则文件：字段类型不对、没有 id、不是对象、动作不认识，夹在好的中间 */
const GATE_MIXED = JSON.stringify({
  rules: [
    RULES_X[1],
    { id: "bad-keywords", match: { keywords: "赞了" }, action: "drop" },
    { match: {}, action: "drop" },
    "不是对象的条目",
    { id: "bad-action", match: {}, action: "maybe" },
  ],
});
const sense = (src: string, id: string, text: string, extra: Partial<SenseEvent> = {}): SenseEvent => ({ src, id, text, line: `- [${src} id=${id}] ${text}`, ...extra });
/** 最近几天的真动静：老林私聊（固定直达）、帮手、提醒、集市群里小禾说的长话（里面有换行和多个空格）、集市群里老林没 @ 的话（必判）、赞、网络、陌生人私聊、推广 */
const EVENTS: SenseEvent[] = [
  sense("wx", "a1b2c3d4", "老林的微信：在吗，周末集市你来不来", { conv: "老林的微信", sender: "老林的微信", isGroup: false }),
  sense("cc", "b2c3d4e5", "帮手做完了：阿青的相册去重"),
  sense("remind", "c3d4e5f6", "提醒：给阿青的台灯换灯泡"),
  sense("wx", "d4e5f6a7", "集市群：小禾的微信:  周末摊位的位置\n  已经定在喷泉旁边了，大家记得带上自己的零钱和袋子，别忘了", { conv: "集市群", sender: "小禾的微信", isGroup: true, mentionsMe: false }),
  sense("wx", "e5f6a7b8", "集市群：老林的微信: 我晚点到", { conv: "集市群", sender: "老林的微信", isGroup: true, mentionsMe: false }),
  sense("xhs", "f6a7b8c9", "青青的小红书赞了你的明信片帖子"),
  sense("phone_net", "a7b8c9d0", "手机网络恢复了"),
  sense("xhs", "b8c9d0e1", "路过的陌生人：这个明信片怎么卖", { conv: "路过的陌生人", sender: "路过的陌生人", isGroup: false }),
  sense("xhs", "c9d0e1f2", "推广：集市摊位限时折扣，点击领取"),
];
/** 第一次用的时候才建，之后共用这一个（跟导入时建一个的行为一样，只是导入时不建） */
let tryPeopleMade: People | undefined;
const tryPeople = (): People => (tryPeopleMade ??= People.from(P_REG, approvedFrom(P_REG)));

interface RuleOpts {
  /** 规则文件：不写 = 上面那份标准的；字符串 = 原样写进去；null = 没有这个文件 */
  file?: string | null;
  /** 最近的动静：不写 = EVENTS；null = 读不到 */
  events?: SenseEvent[] | null;
  /** git 的回答（add、commit 依次；用完了回最后一个）；不写 = 都成功 */
  ran?: Ran[];
  how?: "tool" | "handler";
}
/** 经 what_reaches_me 走一次（闸门开着：规则文件在临时工作区里，名单、动静是假的）；文字后面接这次的踪迹和调用后的规则文件 */
async function rules(dir: string, args: Record<string, unknown>, o: RuleOpts = {}): Promise<string> {
  const ws = freshDir(dir);
  const text = o.file === undefined ? GATE_JSON : o.file;
  if (text !== null) put(ws, GATE_REL, text);
  const out = await use("what_reaches_me", args, (t) => ({
    workspace: ws,
    run: runner(t, ...(o.ran ?? [{ code: 0 }])),
    gateRules: {
      file: GATE_REL,
      current: (): Rule[] => RULES_X,
      reread: (): void => { t.push("gateRules.reread"); },
      people: (): People => tryPeople(),
      names: { me: "阿青", notMe: [] },
      sources: TEST_SOURCES,
      recent: (days: number): SenseEvent[] | null => { t.push(`gateRules.recent ${days}`); return o.events === undefined ? EVENTS : o.events; },
    },
  }), {}, o.how ?? "tool");
  return [out, "--- file ---", fileAfter(ws, GATE_REL)].join("\n");
}
let ruleDirs = 0;
function ruleCall(label: string, args: Record<string, unknown>, o: RuleOpts = {}): void {
  const dir = `rules-${++ruleDirs}`;
  add(`rules: ${label}`, () => rules(dir, args, o));
}
const GIT_ADD_FAILS: Ran[] = [{ code: 128, stderr: "fatal: 阿青的工作区不是 git 仓库" }];
const GIT_COMMIT_FAILS: Ran[] = [{ code: 0 }, { code: 1, stdout: "nothing to commit", stderr: "error: 小禾的钩子拒绝了这次提交" }];
const AD_DROP = { id: "ad-drop", match: { keywords: ["推广"] }, action: "drop", note: "集市摊位的推广贴不看" };
/** 写文件时 JSON.stringify 会调到它的 toJSON，抛出来的东西落进 catch：一个是 Error，一个不是 */
const BOOM_ERROR = { id: "boom-rule", match: {}, action: "drop", toJSON: (): never => { throw new Error("磁盘满了，写不下"); } };
const BOOM_TEXT = { id: "boom-rule", match: {}, action: "drop", toJSON: (): never => { throw "写到一半被拔了线（不是 Error）"; } };

// 闸门没开
add("rules: the gate is off (list)", () => use("what_reaches_me", { action: "list" }));
add("rules: the gate is off (an add is not tried)", () => use("what_reaches_me", { action: "add", rule: RULE_ADD }));
// list
ruleCall("list the rules in the file", { action: "list" });
ruleCall("list when there is no rules file yet", { action: "list" }, { file: null });
ruleCall("list with entries that do not take effect", { action: "list" }, { file: GATE_MIXED });
ruleCall("list when the file cannot be read", { action: "list" }, { file: "{ 坏了：老林手滑多按了个键" });
ruleCall("list when the file has no rules array", { action: "list" }, { file: JSON.stringify({ 规则: [] }) });
// try
ruleCall("try the current rules", { action: "try" });
ruleCall("try over 30 days", { action: "try", days: 30 });
ruleCall("try with a new rule at the front", { action: "try", rule: AD_DROP });
ruleCall("try with a new rule at place 2", { action: "try", rule: AD_DROP, to: 2 });
ruleCall("try with an edit of a rule that exists", { action: "try", rule: { id: "market-group", action: "digest" } });
ruleCall("try with a rule the checks refuse", { action: "try", rule: { id: "bad-one", match: {}, action: "maybe" } });
ruleCall("try with a rule that has no id", { action: "try", rule: { match: {}, action: "drop" } });
ruleCall("try with a place that is too far", { action: "try", rule: AD_DROP, to: 99 });
ruleCall("try one rule by its id", { action: "try", id: "postcard-likes" });
ruleCall("try an id that is not there", { action: "try", id: "no-such-rule" });
ruleCall("try with an id and a rule, the rule's id is the one counted", { action: "try", id: "net-probe", rule: AD_DROP });
ruleCall("try when the events cannot be read", { action: "try" }, { events: null });
ruleCall("try over no events", { action: "try", rule: AD_DROP }, { events: [] });
// add
ruleCall("add without a rule", { action: "add" });
ruleCall("add a rule", { action: "add", rule: RULE_ADD });
ruleCall("add a rule at place 2", { action: "add", rule: RULE_ADD, to: 2 });
ruleCall("add a rule the checks refuse", { action: "add", rule: { id: "bad-one", match: { keywords: "赞了" }, action: "drop" } });
ruleCall("add a rule whose id is taken", { action: "add", rule: { id: "net-probe", match: {}, action: "drop" } });
ruleCall("add a rule for the fixed sources only", { action: "add", rule: { id: "hands-quiet", match: { src: ["cc", "remind"] }, action: "drop" } });
ruleCall("add at a place that is too far", { action: "add", rule: RULE_ADD, to: 99 });
ruleCall("add when there is no rules file yet", { action: "add", rule: RULE_ADD }, { file: null });
ruleCall("add when the file cannot be read", { action: "add", rule: RULE_ADD }, { file: "{ 坏了：老林手滑多按了个键" });
ruleCall("add when git add fails", { action: "add", rule: RULE_ADD }, { ran: GIT_ADD_FAILS });
ruleCall("add when git commit fails", { action: "add", rule: RULE_ADD }, { ran: GIT_COMMIT_FAILS });
ruleCall("add when the file cannot be written (an Error)", { action: "add", rule: BOOM_ERROR }, { how: "handler" });
ruleCall("add when the file cannot be written (not an Error)", { action: "add", rule: BOOM_TEXT }, { how: "handler" });
// edit
ruleCall("edit without an id", { action: "edit", rule: { want: "只看提到我的" } });
ruleCall("edit without a rule", { action: "edit", id: "market-group" });
ruleCall("edit a rule", { action: "edit", id: "market-group", rule: { action: "digest", match: { keywords: ["摊位"] }, want: null } });
ruleCall("edit a rule that is not there", { action: "edit", id: "no-such-rule", rule: { action: "drop" } });
ruleCall("edit to an id that is taken", { action: "edit", id: "market-group", rule: { id: "net-probe" } });
ruleCall("edit into a rule the checks refuse", { action: "edit", id: "market-group", rule: { when: "later" } });
// remove
ruleCall("remove without an id", { action: "remove" });
ruleCall("remove a rule", { action: "remove", id: "stranger-dm" });
ruleCall("remove a rule, git commit fails", { action: "remove", id: "stranger-dm" }, { ran: GIT_COMMIT_FAILS });
ruleCall("remove a rule that is not there", { action: "remove", id: "no-such-rule" });
// move
ruleCall("move without an id", { action: "move", to: 1 });
ruleCall("move without a place", { action: "move", id: "net-probe" });
ruleCall("move a rule", { action: "move", id: "net-probe", to: 0 });
ruleCall("move too far", { action: "move", id: "net-probe", to: 9 });
ruleCall("move a rule that is not there", { action: "move", id: "no-such-rule", to: 0 });
// 动作不在名单里
ruleCall("an action outside the list (no zod)", { action: "dance" }, { how: "handler" });
ruleCall("an action outside the list is refused by zod", { action: "dance" });

// ---------- people_i_know：名单的夹具的剩下部分（人本身的夹具在上面，what_reaches_me 的 try 也要认人） ----------

interface PeopleOpts {
  /** 名单文件：对象 = 写成 JSON；字符串 = 原样写进去（坏文件）；null = 没有这个文件；不写 = P_REG */
  file?: Record<string, unknown> | string | null;
  /** 批准的底子从哪份名单来：不写 = 文件里的；null = 读不到（approved() 回 null） */
  base?: Record<string, unknown> | null;
  ran?: Ran[];
  how?: "tool" | "handler";
}
/** 经 people_i_know 走一次（名单文件在临时工作区里，底子、重载都是假的，重载记进踪迹）；文字后面接这次的踪迹和调用后的名单文件 */
async function people(dir: string, args: Record<string, unknown>, o: PeopleOpts = {}): Promise<string> {
  const ws = freshDir(dir);
  const fileReg: Record<string, unknown> = typeof o.file === "object" && o.file !== null ? o.file : o.file === undefined ? P_REG : {};
  if (o.file !== null) put(ws, REGISTRY_FILE, typeof o.file === "string" ? o.file : JSON.stringify(fileReg, null, 2));
  const base = o.base === null ? null : approvedFrom(o.base ?? fileReg);
  const out = await use("people_i_know", args, (t) => ({
    workspace: ws,
    run: runner(t, ...(o.ran ?? [{ code: 0 }])),
    registry: {
      approved: (): Record<string, Record<string, unknown>> | null => base,
      changed: (line: string): void => { t.push(`registry.changed ${line}`); },
      people: (): People => People.from(fileReg, base ?? undefined),
    },
  }), {}, o.how ?? "tool");
  return [out, "--- file ---", fileAfter(ws, REGISTRY_FILE)].join("\n");
}
let peopleDirs = 0;
function peopleCall(label: string, args: Record<string, unknown>, o: PeopleOpts = {}): void {
  const dir = `people-${++peopleDirs}`;
  add(`people: ${label}`, () => people(dir, args, o));
}
/** 写文件时 JSON.stringify 会调到条目里的 toJSON，抛出来的东西落进 catch：一个是 Error，一个不是 */
const TOJSON_ERROR = { name: "阿雪", toJSON: (): never => { throw new Error("磁盘满了，写不下"); } };
const TOJSON_TEXT = { name: "阿雪", toJSON: (): never => { throw "写到一半被拔了线（不是 Error）"; } };
const XUE_CUT = { name: "阿雪", privacy: "guest", trust: "trusted", shared: ["a.md"], allowedScripts: { "scripts/cast.py": ["play"] }, handles: { wx: ["阿雪的微信"] } };
/** 阿青的文件里多了一个没批过的号（手改）；底子还是原来的 */
const QING_PLUS: Record<string, unknown> = { ...P_REG, qing: { ...P_QING, senders: [WA_QING, NEW_NUMBER] } };
/** 阿青的文件里号被删光了（底子里记着 WA_QING） */
const QING_BARE: Record<string, unknown> = { ...P_REG, qing: { ...P_QING, senders: [] } };

// 没接名单文件
add("people: no registry (list)", () => use("people_i_know", { action: "list" }));
add("people: no registry (an add is not tried)", () => use("people_i_know", { action: "add", entry: { name: "阿雪" } }));
// list
peopleCall("list", { action: "list" });
peopleCall("list of an empty registry", { action: "list" }, { file: {} });
peopleCall("list with entries that have no name and no privacy", { action: "list" }, { file: { zhou: P_OWNER, nameless: { handles: { wx: ["无名氏的微信"] } } } });
peopleCall("list with a privacy and a trust that are not text (no base)", { action: "list" }, { file: { zhou: P_OWNER, odd: { name: "阿雪", privacy: 7, trust: 5, handles: { wx: ["阿雪的微信"] } } }, base: null });
// add
peopleCall("add without an entry", { action: "add" });
peopleCall("add an entry without a name", { action: "add", entry: { handles: { wx: ["小禾的微信"] } } });
peopleCall("add a blank name", { action: "add", entry: { name: "   " } });
peopleCall("add a name that is not text", { action: "add", entry: { name: 5 } });
peopleCall("add with an empty key", { action: "add", key: "", entry: { name: "阿雪" } });
peopleCall("add with a key that starts with _", { action: "add", key: "_xue", entry: { name: "阿雪" } });
peopleCall("add with a key that has a space", { action: "add", key: "a xue", entry: { name: "阿雪" } });
peopleCall("add with a key that is too long", { action: "add", key: "k".repeat(41), entry: { name: "阿雪" } });
peopleCall("add under the owner's key", { action: "add", key: "zhou", entry: { name: "冒充的" } });
peopleCall("add under the owner's key after the owner was cut from the file", { action: "add", key: "zhou", entry: { name: "冒充的" } }, { file: WITHOUT_OWNER, base: P_REG });
peopleCall("add under a key that is taken", { action: "add", key: "he", entry: { name: "另一个小禾" } });
peopleCall("add an entry the checks refuse", { action: "add", entry: { name: "阿雪", handles: { wx: "一个字符串" } } });
peopleCall("add a name that is already in the list", { action: "add", entry: { name: "小禾" } });
peopleCall("add a number that is already in the list", { action: "add", entry: { name: "阿雪", senders: [WA_QING] } });
peopleCall("add the owner level", { action: "add", entry: { name: "阿雪", privacy: "owner" } });
peopleCall("add with handles and a number, the key made from the name", { action: "add", entry: { name: "阿雪", handles: { wx: ["阿雪的微信"], xhs: ["雪雪的小红书"] }, senders: [NEW_NUMBER] } });
peopleCall("add with no ids and the guest level written out", { action: "add", key: "xue", entry: { name: "阿雪", privacy: "guest" } });
peopleCall("add a name in letters, the key made from it", { action: "add", entry: { name: "Xue Er" } });
peopleCall("add with permissions above the guest level", { action: "add", key: "xue", entry: XUE_CUT });
peopleCall("add when the file cannot be read", { action: "add", entry: { name: "阿雪" } }, { file: "{ 坏了：老林手滑多按了个键" });
peopleCall("add when the file is not an object", { action: "add", entry: { name: "阿雪" } }, { file: "[]" });
peopleCall("add when there is no file yet", { action: "add", entry: { name: "阿雪" } }, { file: null });
peopleCall("add when the approved base cannot be read", { action: "add", entry: { name: "阿雪" } }, { base: null });
peopleCall("add when git add fails", { action: "add", entry: { name: "阿雪" } }, { ran: GIT_ADD_FAILS });
peopleCall("add when the file cannot be written (an Error)", { action: "add", entry: TOJSON_ERROR }, { how: "handler" });
peopleCall("add when the file cannot be written (not an Error)", { action: "add", entry: TOJSON_TEXT }, { how: "handler" });
// update
peopleCall("update without a key", { action: "update", entry: { profile: "画明信片的朋友" } });
peopleCall("update without an entry", { action: "update", key: "he" });
peopleCall("update with a key that starts with _", { action: "update", key: "_he", entry: { profile: "x" } });
peopleCall("update the owner", { action: "update", key: "zhou", entry: { handles: { wx: ["新名字"] } } });
peopleCall("update a key that is not there", { action: "update", key: "nobody", entry: { profile: "x" } });
peopleCall("update a key whose entry is not an object", { action: "update", key: "loose", entry: { profile: "x" } });
peopleCall("update with an entry the checks refuse", { action: "update", key: "he", entry: { senders: "一个字符串" } });
peopleCall("update to the owner level", { action: "update", key: "he", entry: { privacy: "owner" } });
peopleCall("update a platform name and a field", { action: "update", key: "he", entry: { handles: { xhs: ["禾禾的小红书"] }, profile: "画明信片的朋友" } });
peopleCall("update a field with a long text", { action: "update", key: "he", entry: { profile: "每周六在集市摆摊卖手绘明信片，喜欢画鸭子和枣树，说话很轻，总是先问摊位费退了没有，退了才肯收钱" } });
peopleCall("update by deleting a platform with null", { action: "update", key: "he", entry: { handles: { wx: null } } });
peopleCall("update to what it already is", { action: "update", key: "he", entry: { name: "小禾" } });
peopleCall("update with a permission that is cut and nothing else", { action: "update", key: "he", entry: { trust: "trusted" } });
peopleCall("update with a permission that is cut and a real change", { action: "update", key: "he", entry: { trust: "trusted", profile: "画明信片的朋友" } });
peopleCall("update to a name that is already in the list", { action: "update", key: "he", entry: { name: "阿青" } });
peopleCall("update to a number that is another person's", { action: "update", key: "he", entry: { senders: [WA_QING] } });
peopleCall("update an elevated person with a new number", { action: "update", key: "qing", entry: { senders: [WA_QING, NEW_NUMBER] } });
peopleCall("update an elevated person with a number the base has", { action: "update", key: "qing", entry: { senders: [WA_QING] } }, { file: QING_BARE, base: P_REG });
peopleCall("update a person who carries a number nobody approved", { action: "update", key: "qing", entry: { profile: "画明信片的朋友" } }, { file: QING_PLUS, base: P_REG });
peopleCall("update by taking the unapproved number away", { action: "update", key: "qing", entry: { senders: [WA_QING] } }, { file: QING_PLUS, base: P_REG });
peopleCall("update when the file cannot be read", { action: "update", key: "he", entry: { profile: "x" } }, { file: "{ 坏了：老林手滑多按了个键" });
// remove
peopleCall("remove without a key", { action: "remove" });
peopleCall("remove with a key that has a space", { action: "remove", key: "a he" });
peopleCall("remove the owner", { action: "remove", key: "zhou" });
peopleCall("remove a key that is not there", { action: "remove", key: "nobody" });
peopleCall("remove a key whose entry is not an object", { action: "remove", key: "loose" });
peopleCall("remove a person", { action: "remove", key: "he" });
peopleCall("remove a person, git commit fails", { action: "remove", key: "he" }, { ran: GIT_COMMIT_FAILS });
// 动作不在名单里
peopleCall("an action outside the list (no zod)", { action: "dance" }, { how: "handler" });
peopleCall("an action outside the list is refused by zod", { action: "dance" });

// ---------- scratch 变体：brain.ts 里 Brain 开回头看、把关两个会话时塞进去的工具 ----------
interface Scratch { looked: ToolDef; checked: ToolDef }
interface CheckStarter { startCheck(day: string, candidates: CheckCandidate[], requester: string): string }
const CHECK_CASES: CheckCandidate[] = [
  { kind: "做成的", page: "做成的事/修好了阿青的台灯", text: "台灯的接线松了，重新拧紧后能亮", evidence: "任务 t0457，阿青说「亮了」" },
  { kind: "教训", page: "教训/不要在老林睡觉时发消息", text: "老林中午要睡，打扰他会被念叨", evidence: "原话 q8821" },
];
/**
 * 造一个完整的 Brain（makeBrain：内存库、假内核、手动时钟；目录放在临时根下），让它真的开出回头看的会话
 * （主线 on_it、set_bar、done_with 以后 lookAgain 开 look-<编号>）和把关的会话（startCheck，learn_check 背后的私有方法，
 * 没有学习运行时和夜里的整理也能开）。把两个会话带着的 looked_again、checked 交给 fn；不管成不成，最后 brain.stop() 关掉所有会话。
 * Brain 的定时全走手动时钟（later），没有真定时器留下
 */
async function withScratch<T>(fn: (s: Scratch) => Promise<T>): Promise<T> {
  const t = makeBrain({ stateDir: join(ROOT, "scratch-state"), workspace: join(ROOT, "scratch-ws") });
  try {
    t.brain.wakeRegion("main", "开始");
    const main = t.driver.latest("main");
    await main.play({ tool: { name: "on_it", args: { topic: "给阿青回条评论", about: "2分钟" } } });
    await main.play({ tool: { name: "set_bar", args: { bar: "回得接住阿青的玩笑" } } });
    t.clock.advance(56_000);
    await main.play({ tool: { name: "done_with", args: { topic: "给阿青回条评论" } } });
    const look = t.driver.sessions.filter((s) => s.id.startsWith("look-")).at(-1);
    if (!look) throw new FixtureError("no look-… session was opened");
    (t.brain as unknown as CheckStarter).startCheck("2026-11-12", CHECK_CASES, "hippocampus");
    const check = t.driver.latest("check-2026-11-12");
    return await fn({ looked: need(look.spec.tools, "looked_again"), checked: need(check.spec.tools, "checked") });
  } finally {
    await t.brain.stop();
  }
}
add("def scratch/looked_again", () => withScratch(async (s) => defText(s.looked, "scratch")));
add("def scratch/checked", () => withScratch(async (s) => defText(s.checked, "scratch")));
add("scratch: looked_again with every argument", () => withScratch((s) => viaTool(s.looked, { met: false, missing: "还差第二段，要接上阿青说的那个梗", seen: "只看了标题和开头" })));
add("scratch: looked_again with met only", () => withScratch((s) => viaTool(s.looked, { met: true })));
add("scratch: looked_again without met is refused by zod", () => withScratch((s) => viaTool(s.looked, { seen: "没写到没到" })));
add("scratch: checked with every kind of verdict", () => withScratch((s) => viaTool(s.checked, { verdicts: [
  { i: 1, verdict: "merge", into: "l:0039", text: "台灯接线松了就先拧紧再试", why: "和旧的一条是一回事" },
  { i: 2, verdict: "add", why: "具体，下次能照着做" },
  { i: 3, verdict: "reject", why: "一次性的事" },
] })));
add("scratch: checked with an empty list", () => withScratch((s) => viaTool(s.checked, { verdicts: [] })));
add("scratch: checked without the list (no zod)", () => withScratch((s) => viaHandler(s.checked, {})));
add("scratch: checked with a verdict of an unknown kind is refused by zod", () => withScratch((s) => viaTool(s.checked, { verdicts: [{ i: 1, verdict: "maybe", why: "拿不准" }] })));

// ---------- 工具的顺序（模型看到的工具清单顺序也是它读到的东西）；以及名单核对 ----------
// 这几条是最后加的，所以排在最后：已有的 id 和它们的顺序不动
add("order hh", () => JSON.stringify(builtHh().map((t) => t.name)));
// the role's own channels name the message tool's; with none it is not there
add("message: the role's own channels", () => defText(need(buildTools({ ...makeCtx().ctx, channels: ["whatsapp", "telegram", "qqbot"] }, everything), "message"), "hh"));
add("message: no channel, no message tool", () => JSON.stringify(buildTools({ ...makeCtx().ctx, channels: [] }, everything).map((t) => t.name)));
add("order mem", () => JSON.stringify(memSet("main").map((t) => t.name)));
add("names: every variant builds exactly the tools listed for it, in the listed order", () => {
  const names = (tools: readonly ToolDef[]): string[] => tools.map((t) => t.name);
  const noTemplate = names(memSet("main", {}));
  const checks: Array<[string, readonly string[], readonly string[]]> = [
    ["hh", HH_TOOLS, names(builtHh())],
    ["mem", MEM_DEF_TOOLS, names(memSet("main"))],
    ["mem (no template)", MEM_DEF_TOOLS, noTemplate],
    ["mem-no-template", NO_TEMPLATE_TOOLS, noTemplate.filter((n) => (NO_TEMPLATE_TOOLS as readonly string[]).includes(n))],
    ["no-mem", NO_MEM_TOOLS, names(builtNoMem())],
  ];
  const bad = checks.filter(([, listed, built]) => JSON.stringify(listed) !== JSON.stringify(built));
  if (bad.length) throw new FixtureError(`the tool name lists of calls.ts are out of date:\n${bad.map(([v, listed, built]) => `  ${v}: listed ${JSON.stringify(listed)}\n  ${" ".repeat(v.length)}  built  ${JSON.stringify(built)}`).join("\n")}`);
  return "ok";
});

export const CALLS: readonly Call[] = calls;
