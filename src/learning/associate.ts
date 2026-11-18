// 话题联想：拿到一个话题（叫醒的那条消息、开始做的那件事），先按封面向量粗筛一批页，再交给 Decisions 逐页问
// "这件事需要翻这一页吗"，过门槛的按概率取前几页，把封面挂给她。
// 每次（开关关着、回测除外）记一行 learn_assoc：挂了哪些、花了多少，之后按这个看接住率、调门槛。
// 她翻开了哪页、加载了哪本（observeTool）记一行 learn_open，和 learn_assoc 对着看挂了的页她翻没翻。
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { LearningCfg } from "../config.ts";
import type { Logger } from "../log.ts";
import { all, one, type Db } from "../store/db.ts";
import { lowInfo } from "../memory/events/recall.ts";
import type { CoverIndex, ItemIndex } from "./covers.ts";
import type { Judge } from "./decisions.ts";
import { paramsNow } from "./params.ts";
import { resolveId } from "./ids.ts";
import { coverText, pageRe, practiceHead, type Item, type Page, type Shelf } from "./notebook.ts";
import { B, L } from "../lang/index.ts";

/** 在哪儿联想的：叫醒、四个开始做事的工具、她自己找（ask）、夜里回测（replay）、派给帮手的活（helper，cc.py 派活时附给帮手）、
 * 干活中途（midwork）、交之前（done_with）、发给主人之前（handover）。hands 是 11-02 以前派活时挂给她自己的，以后不再有新的 */
export type Binding = "wake" | "on_it" | "goals" | "hands" | "mull_over" | "ask" | "replay" | "helper" | "midwork" | "done_with" | "handover";

/** 挂上的一页里对得上的一条（教训 / 做法），和它的概率 */
export interface Hit {
  id: string;
  kind: Item["kind"];
  text: string;
  p: number;
  /** 这一条的强度（0–5，没写的按 3）；strong：到了 strength.strongMin，算强联想（11-03 强度） */
  strength: number;
  strong: boolean;
}

export interface AssocResult {
  /** 挂给她的文字；没挂、或只算不挂（inject 关）时是空串 */
  text: string;
  /**
   * 挂上的页（只算不挂时照算），按概率从高到低；页里有对得上的条目时带 hits（按概率，最多 assoc.hitsPerPage 条）；strong：里面有强联想的条目。
   * carry：没问判断，是同一件事上次她翻过的页（开始做时才有，排在最后；p 是两次话题向量的余弦）
   */
  pages: Array<{ id: string; p: number; hits?: Hit[]; strong?: boolean; carry?: boolean }>;
  /** 一起问的别的题（比如 correction）各自的概率；没判时为空 */
  extra: Map<string, number>;
  ms: number;
  tokens: number;
  /**
   * off 开关关着；lowinfo 话题没内容；same 这个脑区和上次同一个话题；novec 话题向量算不出来；judge 判断失败或超时；nothing 没候选或一页都没过；
   * budget 当天判断的花费到了 assoc.saveAt，先停干活途中的联想（省给叫醒、开始做、交之前、发之前）
   */
  skipped?: "off" | "lowinfo" | "same" | "novec" | "judge" | "nothing" | "budget";
  /**
   * 先算不挂（associate 带 hold）、有页时才有：真贴给她那一刻调一次，这时才记那一行、才算挂过；
   * 这期间被别的联想挂上的页去掉，返回去掉以后的结果（用它的 text）。不调就什么都不记（算了没贴）
   */
  confirm?: () => AssocResult;
  /** 先算不挂、最后不贴了（发给主人之前没对上能拦的）：只记一行（不挂、不算挂过），判断的概率照样留在 asked 里 */
  discard?: () => void;
}

export interface NoteAssociatorDeps {
  db: Db;
  cfg: LearningCfg;
  shelf: () => Shelf;
  covers: CoverIndex;
  /** 页里每条教训、做法的向量；不给就只联想页 */
  items?: ItemIndex;
  judge: Judge;
  /** 话题的向量（和事件记忆共用 cueVector，同一句话只算一次）；不可用时 null */
  vec: (q: string, timeoutMs?: number) => Promise<Float32Array | null>;
  /** 没有向量（没有 OpenAI key）：按字粗筛候选页、不问条目，judge 也是按字的（KeywordDecisions） */
  keywordOnly?: boolean;
  now: () => number;
  log: Logger;
  /** 脑区的工作目录（她 Bash 里的相对路径按它算，不给用书架的上一层）；home 是 ~ 展开成的目录（不给用这个进程的） */
  cwd?: string;
  home?: string;
  /** The role's manuals plugin: a Skill call named <it>:<book> opens that book (none: only bare names count) */
  skillsPlugin?: string;
  /** 读书架上一页的原文（rel 相对书架根）；读不到给 null。不给就从 cfg.root 读 */
  read?: (rel: string) => string | null;
  /** 书架目录相对工作区的路径：挂给她的每一行里页的路径用它做前缀 */
  shelfDir: string;
  /** 做法出处里要留下的记号（她的规矩文件点名的，见 cleanPractice）；每次现取，不给就没有 */
  keep?: () => readonly string[];
  /**
   * 这个脑区从中央记忆这几条（各自）以后，自己眼前又多了多少 token（central.viewTokensAfter：她自己的原样，别的脑区的按同步时折起来的样子；
   * 一次扫一遍）。「挂过的页隔多少再挂」按它算；不给就按中央记忆所有脑区的原文合计（三个脑区并行时涨得快，11-04 同一条强教训中位 13 分钟就重贴一次）
   */
  seenSince?: (region: string, seqs: number[]) => Map<number, number>;
}

type Mounted = Array<{ id: string; p: number }>;

const GIST_CHARS = 24;
/** 条目的大概：教训取「教训：」那一句，做法取原文，截到 GIST_CHARS 字 */
const gistOf = (h: { kind: Item["kind"]; text: string }): string => {
  const s = h.kind === "lesson" ? h.text.split(B.forms.page.sep)[0]!.replace(pageRe.lessonLabel(), "") : h.text;
  return [...s].length > GIST_CHARS ? `${[...s].slice(0, GIST_CHARS).join("")}…` : s;
};
// 条目挑几条（assoc.itemsK，11-03 量过：一次问 20 题中位 165ms、50 题 245ms）、一页贴几条、门槛、再挂的间隔都在 params.ts，当场能调
/** 干活的时刻：挂过的页她又看了 assoc.remountTokens 的经历就能再挂；别的时候这个前缀里只挂一次 */
const WORK: ReadonlySet<Binding> = new Set<Binding>(["on_it", "midwork", "done_with", "handover"]);
/** 帮手的联想按帮手分开记：脑区写成 cc:<名字> */
const HELPER_REGION = "cc:";
/** 派活不在回复路径上，给足时间（cc.py 那边等 10 秒） */
const HELPER_TIMEOUT_MS = 4000;
/** ask 不知道是哪个脑区问的，记录里的脑区统一写这个 */
const ASK_REGION = "ask";
const TOPIC_MAX = 500;
/** ask 是她自己要找、等着结果的，判断的页多（还可能冷启动），给得比回复路径长 */
const ASK_TIMEOUT_MS = 5000;
/** 夜里回测不在回复路径上：向量和判断整次共用 10 秒（一晚第一次判断常是冷启动，回复路径的 timeoutMs 不够） */
const REPLAY_TIMEOUT_MS = 10_000;
/** 隔多久没判过算冷、冷的时候时限乘几 */
const COLD_AFTER_MS = 60_000;
const COLD_FACTOR = 2;
/** 单独判一页都没过、要带上她的话再判一次时，剩的时间至少要这么多（不够就算了，不拖回复） */
const RETRY_MIN_MS = 300;
/**
 * With less than this left the judge is not asked, and the round counts as the judge not answering (nothing spent, no strike
 * towards the breaker): measured 11-03, twenty questions take a median 165ms, so a shorter call cannot come back
 * (11-18: after a slow vector the judge was left 66ms and sent two requests that could only time out).
 */
const JUDGE_MIN_MS = 150;

const sha1 = (s: string): string => createHash("sha1").update(s).digest("hex");
const inputOf = (topic: string): string =>
  L.associate.judgeInput(topic);
/** 每页一题，题名用页自己的编号 */
const questionOf = (p: Page): { name: string; text: string } => ({ name: p.ids[0]!, text: L.associate.pageQuestion(coverText(p)) });
/** 每条一题，题名用条目的编号 */
const itemQuestion = (it: Item): { name: string; text: string } =>
  ({ name: it.id, text: L.associate.itemQuestion(it.kind === "lesson" ? L.associate.kindLesson : L.associate.kindPractice, it.ask) });
/**
 * 标了「提醒：动手时」的条目多问一句：这一步是不是就要做（题名是条目编号加 STEP）。11-04 拿 1053 处人标的「话题×强教训」试了 7 种问法，
 * 这一问跟原来那题放在同一次判断里（同一段 input）就管用：动作型的 4 条噪音 62 → 8 处，有用的 28 → 23 处；别的教训加这一问反而丢一大半有用的
 */
const STEP = "~step";
const stepQuestion = (it: Item): { name: string; text: string } =>
  ({ name: it.id + STEP, text: L.associate.stepQuestion(it.step!.when) });
/** 同一件事接着做：上次她翻过的页；带的那件事的话题截到这么多字 */
const carryHeader = (from: string): string => L.associate.carryHeader(from);
const CARRY_FROM_CHARS = 24;
/** 往回找最像的几件事 */
const CARRY_TASKS = 3;
/** 问到的题概率不到这么多的不记进 asked（调门槛用不上，省地方；assoc.stepThreshold 最低能调到 0.05） */
const ASKED_MIN = 0.05;
/**
 * 发给主人之前（handover）：标了「提醒：发之前」的强教训多问一句「这条里正好又犯了吗」（题名是条目编号加 SENT）。
 * 先只问、记进 asked（handover.sentAt 默认 1.01 不看它）：攒几天她真拦下、真改了的再定门槛
 */
const SENT = "~sent";
const sentQuestion = (it: Item): { name: string; text: string } =>
  ({ name: it.id + SENT, text: L.associate.sentQuestion(it.ask) });
/**
 * 判断超时了不再试的时刻（#0047）：Brain 开始做事那几处（notesFor）只等到 limitFor，超时的那次判断已经用完了剩下的时间，
 * 再试回来她也看不到，反倒记成挂过。派活附笔记（helper）也一样：cc.py 只等 10 秒，4 秒再试一轮加上起 hh 的时间在电脑忙时会等不及，
 * 页却已经记成给过这个帮手。别的时刻（叫醒、干活途中、交之前、发之前、回测、她自己找）超时了再试一次
 */
const ONE_TRY: ReadonlySet<Binding> = new Set<Binding>(["on_it", "goals", "mull_over", "helper"]);
/** 数强教训贴了几次时最多往回翻几行（一天七八百行，够看好几天） */
const STRONG_SCAN_ROWS = 4000;
/** 干活途中的联想：判断花费快到上限时先停这个（叫醒、开始做、交之前、发之前留着） */
const SAVE_FIRST: ReadonlySet<Binding> = new Set<Binding>(["midwork"]);
/** 挂给她的一行：封面 + 几条教训 + 路径 */
function coverLine(shelfDir: string, p: Page): string {
  const n = p.lessons.length;
  return L.associate.coverEntry(p.book, p.title, p.brief, n ? L.associate.coverLessonCount(n) : "", shelfDir, p.rel);
}

/** 真实路径（链接跟到底）；不存在、没权限就按给的路径 */
function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** path 相对 base 的路径；在 base 外面（或就是 base）返回 null。只比字面，macOS 上中文名的两种写法先统一 */
function under(base: string, path: string): string | null {
  const rel = relative(base, path);
  return !rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel.normalize("NFC");
}

export class NoteAssociator {
  private readonly d: NoteAssociatorDeps;
  /** 每个脑区这个前缀里挂过的页 → 挂的时候中央记忆到了哪一条（换前缀清空） */
  private readonly given = new Map<string, Map<string, number>>();
  /** 每个脑区上一个联想过的话题（内容 hash） */
  private readonly lastTopic = new Map<string, string>();
  /**
   * 每个脑区最近一次「从头问」的判断：那次的话题向量、时刻（锚），之后照用期间新问的题也补进来；每题记着题面和概率
   * （不含主人那句的纠正题）。几乎一样的话题隔不久再来，题面没变的照用
   */
  private readonly recent = new Map<string, { v: Float32Array; at: number; p: Map<string, { text: string; p: number }> }>();
  /** 上一次判断开始的时刻（建好时算一次：hhd 刚起来那一分钟不按冷的算） */
  private lastJudge: number;

  constructor(d: NoteAssociatorDeps) {
    this.d = d;
    this.lastJudge = d.now();
  }

  /** learning.enabled：关着时 associate 什么都不算（调用的一方可以省掉为它准备的事，比如认说话的人） */
  get enabled(): boolean {
    return this.d.cfg.enabled;
  }

  /**
   * 这一次联想（向量 + 判断）最多用多久：回测、派活各有各的；隔了一阵没判过（连接和判断那边的缓存都冷了）给双倍
   * （11-02：闲 5 分钟以上的第一次判断中位 1.1 秒、18% 超过 1.5 秒；隔 30 秒内的中位 0.4 秒）。
   * 等联想结果的一方（Brain 开始做事那几处）用同一个数，别在联想还在算时先放弃
   */
  limitFor(binding: Binding): number {
    if (binding === "replay") return REPLAY_TIMEOUT_MS;
    if (binding === "helper") return HELPER_TIMEOUT_MS;
    return this.d.now() - this.lastJudge > COLD_AFTER_MS ? this.d.cfg.timeoutMs * COLD_FACTOR : this.d.cfg.timeoutMs;
  }

  /** learning.inject：联想出来的东西真给她看（关着是只算不挂，她看到的话不变） */
  get injects(): boolean {
    return this.d.cfg.inject;
  }

  /**
   * 联想一次。整个过程受 timeoutMs 限制：向量先用，剩下的给判断，用完了就按判断失败算。
   * extra 题（主人的纠正）开关开着就一定问：页的题因为没内容、同一个话题、没向量、没候选问不了时，单独问 extra 题。
   * replay（夜里回测）每次都重新判：不看上一个话题、不去重、不管 inject 都出文字、不记录；
   * 整次给 REPLAY_TIMEOUT_MS（不用 timeoutMs），判断标成后台的（失败不算进回复路径的熔断）。
   */
  async associate(
    topic: string,
    o: { region: string; binding: Binding; taskId?: number; extra?: Array<{ name: string; text: string }>; context?: string; hold?: boolean },
  ): Promise<AssocResult> {
    const cfg = this.d.cfg;
    if (!cfg.enabled) return { text: "", pages: [], extra: new Map(), ms: 0, tokens: 0, skipped: "off" };
    const t0 = this.d.now();
    const replay = o.binding === "replay";
    // 这一次联想用的参数（params.ts；kv 里改了下一次联想就生效）：读一次
    const P = paramsNow(this.d.db);
    // 开始做那一刻的话题向量（第一轮算的，不是带上她的话再判的那次）：记进 learn_assoc，认「同一件事接着做」
    let topicVec: Float32Array | null = null;
    // at、ms：先算不挂的那份确认时，记的是贴给她的时刻、当初算了多久；asked：选出这几页的那次判断，每题的概率
    const finish = (r: { text?: string; pages?: AssocResult["pages"]; extra?: Map<string, number>; tokens?: number; candidates?: number; skipped?: AssocResult["skipped"]; at?: number; ms?: number; asked?: Map<string, number> }): AssocResult => {
      const res: AssocResult = {
        text: r.text ?? "", pages: r.pages ?? [], extra: r.extra ?? new Map(), ms: r.ms ?? this.d.now() - t0, tokens: r.tokens ?? 0,
        ...(r.skipped ? { skipped: r.skipped } : {}),
      };
      if (!replay) {
        this.record({
          at: r.at ?? t0, region: o.region, binding: o.binding, topic, taskId: o.taskId ?? null, candidates: r.candidates ?? 0,
          // 命中的条目只记编号（原文在页里）
          // strong：这页挂上是因为有强联想的条目（在「⚠️ 老毛病」里整句贴过了），不算「以前做过类似的」那几页（11-05 挂了没翻的提醒用）
          // loud：这一页里按「老毛病」贴出去的那几条（strength.dailyMax 按它数；同页别的条目不算）
          mounted: res.pages.map((x) => ({
            id: x.id, p: x.p, ...(x.hits?.length ? { hits: x.hits.map((h) => h.id) } : {}),
            ...(x.strong ? { strong: true, loud: x.hits!.filter((h) => h.strong).map((h) => h.id) } : {}), ...(x.carry ? { carry: true } : {}),
          })),
          shadow: !cfg.inject, skipped: res.skipped ?? null, ms: res.ms, tokens: res.tokens,
          asked: r.asked ?? null, vec: o.binding === "on_it" ? topicVec : null,
        });
      }
      return res;
    };
    const extra = o.extra ?? [];
    const extraNames = new Set(extra.map((q) => q.name));
    /** 记进 asked 的：页和条目的题（不含主人那句的纠正题，那个另有记录），概率到 ASKED_MIN 的，留三位 */
    const askedOf = (p: Map<string, number>): Map<string, number> =>
      new Map([...p].filter(([k, x]) => !extraNames.has(k) && x >= ASKED_MIN).map(([k, x]) => [k, Math.round(x * 1000) / 1000]));
    const extraOf = (p: Map<string, number>) => new Map(extra.map((q) => [q.name, p.get(q.name) ?? 0]));
    const limit = this.limitFor(o.binding);
    // 回测和派活都不在回复路径上：判断标成后台的，失败不算进回复路径的熔断
    const background = replay || o.binding === "helper";
    const left = () => limit - (this.d.now() - t0);
    // 页的题问不了：不挂、记原因；有 extra 题就在剩下的时间里单独问（"不行""不对"这种纠正正好是没内容的短句）
    const skip = async (why: "lowinfo" | "same" | "novec" | "nothing"): Promise<AssocResult> => {
      const ms = left();
      const r = extra.length && ms >= JUDGE_MIN_MS ? await this.judge(inputOf(topic), extra, ms, false, ONE_TRY.has(o.binding)) : null;
      return finish({ skipped: why, ...(r ? { extra: extraOf(r.p), tokens: r.tokens } : {}) });
    };

    // 当天判断的花费快到上限：先停干活途中的联想，别等用完了整晚什么都想不起来（11-04 19:34 用完以后整晚没联想）
    if (SAVE_FIRST.has(o.binding) && (this.d.judge.spentRate?.() ?? 0) >= P("assoc.saveAt")) return finish({ skipped: "budget" });
    if (lowInfo(topic)) return skip("lowinfo");
    if (!replay) {
      // 先记下再等：同一个话题同时进来两次，第二次也算 same
      const h = sha1(topic);
      if (this.lastTopic.get(o.region) === h) return skip("same");
      this.lastTopic.set(o.region, h);
    }

    // 一轮：向量 → 粗筛 → 判断。问不了（没向量、没候选、判断失败）给原因
    // retry：带上她的话再判的那次——算完向量剩的时间不够就不判（太短的判断多半超时），判断标成后台的（不算进回复路径的熔断）
    // Each round logs, as numbers only, how long the vector, the shortlist and the judge took and how many questions were asked,
    // to see what share of the limit the vector and the judge each take (judge timeouts, 11-18)
    const timing = (x: Record<string, number | true>): void => this.d.log.info("note association: timing", { binding: o.binding, limit, ...x });
    const round = async (t: string, ms0: number, qsExtra: Array<{ name: string; text: string }>, retry = false) => {
      const tv = this.d.now();
      let v: Float32Array | null = null;
      try {
        v = await this.d.vec(t, ms0);
      } catch (e) {
        this.d.log.warn("note association: topic vector failed", { error: String(e).slice(0, 200) });
      }
      const vecMs = this.d.now() - tv;
      if (!v && !this.d.keywordOnly) {
        timing({ vecMs, novec: true, ...(retry ? { retry: true as const } : {}) });
        return { ok: false as const, why: "novec" as const };
      }
      if (v && !retry) topicVec = v;
      // 这个前缀里这个脑区挂过的页先拿掉再粗筛，前 k 都是没挂过的（干活的时刻隔得够久的能再挂，见 blocked）
      // 派给帮手的：讲她自己的本（怎么说话、怎么学、身体……）也拿掉，帮手用不上
      const given = replay ? undefined : this.blocked(o.region, o.binding, P);
      const skip = o.binding === "helper" ? new Set(cfg.helperSkipBooks ?? []) : undefined;
      const shelf = this.d.shelf();
      const pool = given?.size || skip?.size
        ? { ...shelf, pages: shelf.pages.filter((p) => !given?.has(p.ids[0] ?? "") && !skip?.has(p.book)) }
        : shelf;
      const k = o.binding === "wake" ? P("assoc.kWake", cfg.kWake) : P("assoc.kTask", cfg.kTask);
      const cands = v ? this.d.covers.shortlist(v, pool, k, cfg.generalCategory, P("assoc.generalExtra")) : this.d.covers.shortlistByWords(t, pool, k, cfg.generalCategory, P("assoc.generalExtra"));
      // 页里的条目按自己的向量挑最像的几条一起问（回测、派活只看页：回测的分数和以前可比，帮手拿的是整页）
      // 强联想的条目不管像不像都问（多半又犯的那一刻，叫醒她的话跟那条教训没关系）
      const live = new Set(pool.pages.filter((p) => !p.archived && p.ids[0]).map((p) => p.ids[0]!));
      // 发给主人之前：强的条目只认标了「提醒：发之前」的，没标的这时不问（11-05：没标的强教训一沾「发给主人」就判用得上，
      // 两天拦了 21 次、20 次她原样重发；peek、最终回复写 NO_REPLY、生图这些跟要发的话本身无关）。在取前 strongAsk 条之前就筛
      const sendOnly = o.binding === "handover";
      const strongNow = P("strength.strongMin");
      const near = !v || replay || o.binding === "helper" || !this.d.items ? [] : this.d.items.shortlist(v, live, P("assoc.itemsK"));
      const loud = !v || replay || o.binding === "helper" || !this.d.items ? []
        : this.d.items.strong(v, live, strongNow, P("strength.strongAsk"), new Set(near.map((n) => n.id)), sendOnly ? (it) => it.send === true : undefined);
      const items = [...near, ...loud].filter((it) => !sendOnly || it.strength < strongNow || it.send);
      // 条目所在的页不在粗筛里也当候选：条目对得上，这页就该挂
      const byId = new Map(pool.pages.map((p) => [p.ids[0], p]));
      const extraPages = [...new Set(items.map((it) => it.pageId))].filter((id) => !cands.some((c) => c.ids[0] === id)).flatMap((id) => byId.get(id) ?? []);
      if (!cands.length && !extraPages.length) return { ok: false as const, why: "nothing" as const };
      const ms = left();
      if (retry && ms < RETRY_MIN_MS) return { ok: false as const, why: "nothing" as const };
      const base = [
        ...cands.map(questionOf), ...items.map(itemQuestion), ...items.filter((it) => it.step).map(stepQuestion),
        ...(sendOnly ? items.filter((it) => it.send && it.strength >= strongNow).map(sentQuestion) : []),
      ];
      // 这个脑区隔不久又联想一个几乎一样的话题（assoc.reuseCos / reuseMin）：上次问过的题照用，只问新的；纠正题每次都问
      // （同一题的概率不随同批别的题变，11-04 量过 400 对一个不差，所以拆开问、拼起来算是一样的）
      // 照用只看锚（那次从头问的话题和时刻），不看上一次：一串一次比一次偏一点的话题不会一直沿用最早的判断；题面改了（页、教训改过）的重问
      const prev = replay || retry || !v ? undefined : this.recentFor(o.region, v, P);
      // 「这条里正好又犯了吗」看的是这一次要发的话，题面一样也不照用
      const known = (q: { name: string; text: string }): boolean => !q.name.endsWith(SENT) && prev?.p.get(q.name)?.text === q.text;
      const qs = [...base.filter((q) => !known(q)), ...qsExtra];
      const tj = this.d.now();
      const got = !qs.length ? { p: new Map<string, number>(), tokens: 0 } : ms >= JUDGE_MIN_MS ? await this.judge(inputOf(t), qs, ms, background || retry, ONE_TRY.has(o.binding)) : null;
      timing({
        vecMs, prepMs: tj - tv - vecMs, judgeMs: this.d.now() - tj, budgetMs: ms, questions: qs.length,
        ...(got ? {} : { failed: true as const }), ...(retry ? { retry: true as const } : {}),
      });
      if (!got) return { ok: false as const, why: "judge" as const, candidates: cands.length };
      const p = new Map<string, number>(base.filter(known).map((q) => [q.name, prev!.p.get(q.name)!.p]));
      for (const [k, x] of got.p) p.set(k, x);
      const r = { p, tokens: got.tokens };
      if (!replay && !retry && v) {
        const extraNames = new Set(qsExtra.map((q) => q.name));
        const asked = qs.filter((q) => !extraNames.has(q.name)).map((q) => [q.name, { text: q.text, p: got.p.get(q.name) ?? 0 }] as const);
        if (prev) for (const [k, x] of asked) prev.p.set(k, x);
        else this.recent.set(o.region, { v, at: this.d.now(), p: new Map(asked) });
      }
      return { ok: true as const, cands: [...cands, ...extraPages], items, r };
    };
    // 判完再对一次挂过的页：同一个脑区几次联想重叠时（一条消息里并行的工具调用、叫醒和工具同时算），
    // 等判断的这段时间里别的那次可能已经挂上了，先挂上的算数；在取前 maxPages 之前去掉，空出来的位置给下一页。
    // 一页的分数取它自己和它对得上的条目里高的那个；过线的条目按概率挂在这页下面
    // 强联想的条目门槛低一点（strength.strongThreshold）；页自己没过线、有条目过线也挂
    const threshold = P("assoc.threshold", cfg.threshold);
    const strongMin = P("strength.strongMin");
    const strongThreshold = P("strength.strongThreshold");
    const stepThreshold = P("assoc.stepThreshold");
    const sentAt = o.binding === "handover" ? P("handover.sentAt") : 2;
    // 一页的分数取它自己和所有过线条目里最高的；强的、普通的条目各自最多 hitsPerPage 条（别让强的挤掉更对得上的普通那条）；
    // 有强条目的页排最前、不占 maxPages（相关时一定插进来）
    // 同一条强教训 24 小时里按「老毛病」贴够了 strength.dailyMax 次：这次要过普通的门槛才贴，也不进「老毛病」那一块。
    // 它不占普通条目的名额，它那一页也不占 maxPages（以前是强的时候就不占）：按话题挂的页、贴的普通条目和以前一样，变的只有这条强教训贴不贴、怎么贴。
    // 发给主人之前那道核对（handover）不受限、也不计数，回测不管
    const dailyMax = replay || o.binding === "handover" ? 0 : P("strength.dailyMax");
    const pasted = dailyMax > 0 ? this.strongPastes(t0 - 86_400_000) : new Map<string, number>();
    const loudNow = (it: Item): boolean => it.strength >= strongMin && !(dailyMax > 0 && (pasted.get(it.id) ?? 0) >= dailyMax);
    const pick = (cands: Page[], items: Item[], p: Map<string, number>) => {
      const taken = replay ? undefined : this.blocked(o.region, o.binding, P);
      const per = P("assoc.hitsPerPage");
      const gates = (it: Item): boolean => (!it.step || (p.get(it.id + STEP) ?? 0) >= stepThreshold)
        && (sentAt > 1 || !it.send || it.strength < strongMin || (p.get(it.id + SENT) ?? 0) >= sentAt);
      // 不封顶的话会按强的挂上的页：照旧不占 maxPages
      const exempt = new Set(items.filter((it) => it.strength >= strongMin && (p.get(it.id) ?? 0) >= strongThreshold && gates(it)).map((it) => it.pageId));
      const hitsOf = (id: string): Array<Hit & { line: string; loud: string; capped: boolean }> => {
        const ok = items
          .filter((it) => it.pageId === id && (p.get(it.id) ?? 0) >= (loudNow(it) ? strongThreshold : it.strength >= strongMin ? Math.max(threshold, strongThreshold) : threshold)
            && gates(it))
          .map((it) => ({ id: it.id, kind: it.kind, text: it.text, p: p.get(it.id)!, strength: it.strength, strong: loudNow(it), capped: it.strength >= strongMin && !loudNow(it), line: it.line, loud: it.loud }))
          .sort((a, b) => b.p - a.p);
        return [...ok.filter((h) => h.strong).slice(0, per), ...ok.filter((h) => !h.strong && !h.capped).slice(0, per), ...ok.filter((h) => h.capped).slice(0, per)];
      };
      const all = cands
        .map((page) => { const hits = hitsOf(page.ids[0]!); const own = p.get(page.ids[0]!) ?? 0; return { page, hits, own, p: Math.max(own, ...hits.map((h) => h.p)) }; })
        .filter((c) => (c.own >= threshold || c.hits.length > 0) && !taken?.has(c.page.ids[0]!))
        .sort((a, b) => b.p - a.p);   // 同分保持粗筛的先后
      const loud = all.filter((c) => c.hits.some((h) => h.strong));
      const quiet = all.filter((c) => !loud.includes(c) && exempt.has(c.page.ids[0]!));   // 强教训贴够了的页：还够格挂就挂在最后，不占名额
      return [...loud, ...all.filter((c) => !loud.includes(c) && !quiet.includes(c)).slice(0, cfg.maxPages), ...quiet];
    };

    const first = await round(topic, limit, extra);
    if (!first.ok) {
      if (first.why === "judge") return finish({ skipped: "judge", candidates: first.candidates });
      return skip(first.why);
    }
    let { cands, r } = first;
    let picked = pick(cands, first.items, r.p);
    let tokens = r.tokens;
    let usedP = r.p;
    // 这句话单独一页都没过（「这几个都不够好」没说在讲什么）：带上她刚说的几句再判一次；纠正题只看这句话本身，不再问。
    if (!picked.length && !replay && o.context && !lowInfo(o.context) && left() >= RETRY_MIN_MS) {
      const again = await round(`${o.context}\n${topic}`, left(), [], true);
      if (again.ok) {
        tokens += again.r.tokens;
        const p2 = pick(again.cands, again.items, again.r.p);
        if (p2.length) { picked = p2; cands = again.cands; usedP = again.r.p; }
      }
    }
    // 开始做一件事：同一件事上次她翻过的页（判断没挑上的也带上，判断说不准正是要防的；判断失败的那 2% 不带）
    // （没开的时候不算挂过的页：blocked 要扫一遍中央记忆，开始做时判断已经用掉了大半时限）
    const carry = o.binding === "on_it" && !replay && topicVec && P("assoc.carryCos") <= 1 && P("assoc.carryMax") > 0
      ? this.carryFor(topicVec, o.taskId, P, new Set([...picked.map((c) => c.page.ids[0]!), ...this.blocked(o.region, o.binding, P)]))
      : null;
    // 页里有对得上的条目：贴那几条（11-03 教训级别）；没有的话，开始做一件事时最像的那页把做法的头几条直接贴出来
    // （只给封面她多半不翻：11-02 切换后头一个小时挂了 24 页、翻了 4 页）
    const render = (sel: typeof picked, car: typeof carry): { pages: AssocResult["pages"]; text: string } => {
      const carried = car?.pages ?? [];
      const pages: AssocResult["pages"] = [
        ...sel.map((c) => ({
          id: c.page.ids[0]!, p: c.p,
          ...(c.hits.length ? { hits: c.hits.map((h): Hit => ({ id: h.id, kind: h.kind, text: h.text, p: h.p, strength: h.strength, strong: h.strong })) } : {}),
          ...(c.hits.some((h) => h.strong) ? { strong: true } : {}),
        })),
        ...carried.map((c) => ({ id: c.page.ids[0]!, p: c.cos, carry: true })),
      ];
      const loud = sel.flatMap((c) => c.hits.filter((h) => h.strong).map((h) => `- ${h.loud}`));
      // 判断很有把握的（assoc.fullTextAt）直接给原文；其余只给一句大概，让她翻开核一下。11-04 量过：判断说 0.995 以上的，
      // 页对一半、教训对四成；0.9–0.99 的只对两三成——把握不高的给原文，错的也会被当真
      const fullAt = P("assoc.fullTextAt");
      const lines = sel.map((c, i) => {
        const soft = c.hits.filter((h) => !h.strong);
        const sure = soft.filter((h) => h.p >= fullAt);
        const maybe = soft.filter((h) => h.p < fullAt);
        return [
          coverLine(this.d.shelfDir, c.page),
          ...(sure.length ? [L.associate.hitsHeader, ...sure.map((h) => `  - ${h.line}`)] : []),
          ...(maybe.length ? [L.associate.maybeHeader, ...maybe.map((h) => `  - ${gistOf(h)}`)] : []),
          ...(i === 0 && !c.hits.length && o.binding === "on_it" && c.p >= fullAt ? this.practiceLines(c.page) : []),
        ];
      });
      // 按是哪件事翻过的分开写（几件事各带了几页时，别把后一件的页说成前一件的）
      const carryLines = carried.flatMap((c, i) => [...(i === 0 || carried[i - 1]!.from !== c.from ? [carryHeader(c.from)] : []), coverLine(this.d.shelfDir, c.page)]);
      const show = pages.length && (cfg.inject || replay);
      return { pages, text: show ? [...(loud.length ? [L.associate.loudHeader, ...loud] : []), o.binding === "on_it" ? L.associate.onItHeader : L.associate.header, ...lines.flat(), ...carryLines].join("\n") : "" };
    };
    // 记成这个脑区挂过（只算不挂时也记，统计才和真挂时一样）
    const mount = (pages: AssocResult["pages"]): void => {
      if (replay || !pages.length) return;
      const map = this.given.get(o.region) ?? new Map<string, number>();
      const at = this.centralSeq();
      for (const pg of pages) map.set(pg.id, at);
      this.given.set(o.region, map);
    };
    const out = render(picked, carry);
    const base = { extra: extraOf(r.p), tokens, candidates: cands.length, asked: askedOf(usedP) };
    if (o.hold && !replay && out.pages.length) {
      // 先算不挂：不记、不算挂过；贴的那一刻 confirm，把这期间别的联想挂上的页去掉再记
      const ms = this.d.now() - t0;
      let used = false;
      const confirm = (): AssocResult => {
        if (used) return { text: "", pages: [], extra: new Map(), ms: 0, tokens: 0, skipped: "same" };
        used = true;
        const taken = this.blocked(o.region, o.binding, paramsNow(this.d.db));
        const car = carry && { pages: carry.pages.filter((c) => !taken.has(c.page.ids[0]!)) };
        const now = render(picked.filter((c) => !taken.has(c.page.ids[0]!)), car);
        mount(now.pages);
        return finish({ ...now, ...base, at: this.d.now(), ms, ...(now.pages.length ? {} : { skipped: "same" as const }) });
      };
      const discard = (): void => {
        if (used) return;
        used = true;
        finish({ ...base, at: this.d.now(), ms, skipped: "nothing" });
      };
      return { ...out, ...base, ms, confirm, discard };
    }
    // 选完马上记下（中间没有 await），重叠的那次判完就看得到
    mount(out.pages);
    return finish({ ...out, ...base, ...(out.pages.length ? {} : { skipped: "nothing" as const }) });
  }

  /**
   * 派给帮手的活（cc.py send 经 hh learn helper 来问）：拿活的内容联想，挂上的页写成帮手读得到的绝对路径，接在派给它的话后面。
   * 帮手（另一个 Claude Code）以前看不到她的笔记，11-01。每个帮手按名字单独去重（同一页只给它一次）；
   * 记成 helper，不算她自己的挂载；只算不挂（inject 关）时只记不给
   */
  async forHelper(task: string, worker: string): Promise<{ text: string; pages: Mounted }> {
    const r = await this.associate([...task].slice(0, TOPIC_MAX).join(""), { region: `${HELPER_REGION}${worker}`, binding: "helper" });
    if (!this.d.cfg.inject || !r.pages.length) return { text: "", pages: r.pages };
    const byId = new Map(this.d.shelf().pages.map((p) => [p.ids[0], p]));
    const lines = r.pages.flatMap((m) => { const p = byId.get(m.id); return p ? [L.associate.helperPageLine(join(this.d.cfg.root, p.rel), p.brief)] : []; });
    return { text: lines.length ? [L.associate.helperHeader, ...lines].join("\n") : "", pages: r.pages };
  }

  /** 一页做法的头几条，缩进挂在封面下面；读不到页、没有做法就没有 */
  private practiceLines(p: Page): string[] {
    let text: string | null;
    try {
      text = this.d.read ? this.d.read(p.rel) : readFileSync(join(this.d.cfg.root, p.rel), "utf8");
    } catch {
      text = null;
    }
    const head = text ? practiceHead(text, undefined, this.d.keep?.() ?? []) : [];
    return head.length ? [L.associate.practiceHeader, ...head.map((h) => `  - ${h}`)] : [];
  }

  /**
   * 她自己找全（what_do_i_know）：候选是这个大类（不给就全部）所有有编号、没归档的页，不粗筛，全部交给判断；
   * 过 askThreshold 的全列出，按概率排，一页一行（不带开头那句）。不看上一个话题、不去重；开关关着照样能用，只是不记。
   * 判断给 ASK_TIMEOUT_MS。failed：有候选但判断没回来（出错、熔断、超预算、超时），和"判了、一页都没过"分开
   */
  async ask(topic: string, category?: string): Promise<{ text: string; pages: Mounted; failed: boolean }> {
    if (!topic.trim()) return { text: "", pages: [], failed: false };
    const cfg = this.d.cfg;
    const t0 = this.d.now();
    const cands = this.d.shelf().pages.filter((p) => p.ids[0] && !p.archived && (!category || p.category === category));
    const r = cands.length ? await this.judge(inputOf(topic), cands.map(questionOf), ASK_TIMEOUT_MS) : null;
    const picked = r
      ? cands.map((page) => ({ page, p: r.p.get(page.ids[0]!) ?? 0 })).filter((c) => c.p >= cfg.askThreshold).sort((a, b) => b.p - a.p)
      : [];
    const pages = picked.map((c) => ({ id: c.page.ids[0]!, p: c.p }));
    if (cfg.enabled) {
      // 她自己要的，结果一定给她看：shadow 记 0
      this.record({
        at: t0, region: ASK_REGION, binding: "ask", topic, taskId: null, candidates: cands.length, mounted: pages, shadow: false,
        skipped: !cands.length ? "nothing" : !r ? "judge" : pages.length ? null : "nothing", ms: this.d.now() - t0, tokens: r?.tokens ?? 0,
      });
    }
    return { text: picked.map((c) => coverLine(this.d.shelfDir, c.page)).join("\n"), pages, failed: cands.length > 0 && !r };
  }

  /**
   * 她翻开了什么：Read 的文件是书架里的一页，记页号（没编号的页没号可记，不记；归档的页也记，翻开过就是翻开过）；
   * Bash 里用 cat、sed、head、grep 这些读了书架上的页也一样记（怎么认见 bashReads；一条命令里同一页只记一次）；
   * Skill 加载的是一本，记本名；别的工具都不记。只记录、不拦，开关关着不记（只算不挂时照记：翻开是她真实的行为）。
   * 每个脑区的每次工具调用都过这里：不在书架下的路径不取书架；任何出错只记 warn，不往外抛。
   */
  observeTool(region: string, tool: string, input: unknown): void {
    if (!this.d.cfg.enabled) return;
    try {
      const raw = (input as { file_path?: unknown; skill?: unknown; command?: unknown } | null | undefined) ?? {};
      if (tool === "Read") {
        const id = this.openedPage(raw.file_path);
        if (id) this.recordOpen(region, id, null);
      } else if (tool === "Bash" && typeof raw.command === "string") {
        const cwd = this.d.cwd ?? resolve(this.d.cfg.root, "..");
        const ids = new Set(bashReads(raw.command, cwd, this.d.home ?? homedir()).map((f) => this.openedPage(f)));
        for (const id of ids) if (id) this.recordOpen(region, id, null);
      } else if (tool === "Skill" && typeof raw.skill === "string") {
        // 带手册插件名的全名、斜杠开头的写法都认
        const bare = raw.skill.trim().replace(/^\//, "");
        const own = this.d.skillsPlugin ? `${this.d.skillsPlugin}:` : null;
        const name = own && bare.startsWith(own) ? bare.slice(own.length) : bare;
        if (this.d.shelf().books.some((b) => b.book === name)) this.recordOpen(region, null, name);
      }
    } catch (e) {
      this.d.log.warn("note open log failed", { error: String(e).slice(0, 200) });
    }
  }

  /**
   * 这个路径是书架里哪一页（返回页号；不在书架下、不是一页、页没编号都是 null）。
   * 手册插件里的路径是链回原文件的，跟到底就回到书架里；书架根本身是链接也一样，两边都取真实路径再比。
   * 页自己是指到别处的链接时，字面路径也对一遍。
   */
  private openedPage(file: unknown): string | null {
    if (typeof file !== "string" || !isAbsolute(file)) return null;
    const root = this.d.cfg.root;
    const rels = [under(realOr(root), realOr(file)), under(resolve(root), resolve(file))].filter((r): r is string => r !== null);
    if (!rels.length) return null;
    const pages = this.d.shelf().pages;
    for (const rel of rels) {
      const page = pages.find((p) => p.rel.normalize("NFC") === rel);
      if (page) return page.ids[0] ?? null;
    }
    return null;
  }

  private recordOpen(region: string, pageId: string | null, book: string | null): void {
    this.d.db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, ?, ?, ?)").run(this.d.now(), region, pageId, book);
  }

  /**
   * since 以后每条强教训按「老毛病」真贴给她几次：learn_assoc 里带 strong 的那几页的 loud（以前的行没有 loud，按 hits 算）；
   * 只算不挂的、发之前那道核对的不算。只翻最近 STRONG_SCAN_ROWS 行（表按时间往后长，没有 at 的索引）
   */
  private strongPastes(since: number): Map<string, number> {
    const out = new Map<string, number>();
    try {
      const rows = all<{ mounted: string }>(this.d.db,
        `SELECT mounted FROM learn_assoc WHERE id > (SELECT COALESCE(MAX(id), 0) FROM learn_assoc) - ${STRONG_SCAN_ROWS}
         AND at >= ? AND shadow = 0 AND COALESCE(binding, '') <> 'handover' AND mounted LIKE '%"strong":true%'`, since);
      for (const r of rows) {
        try {
          for (const m of JSON.parse(r.mounted) as Array<{ hits?: string[]; loud?: string[]; strong?: boolean }>) {
            if (m.strong) for (const h of m.loud ?? m.hits ?? []) out.set(h, (out.get(h) ?? 0) + 1);
          }
        } catch { /* 坏的一行跳过 */ }
      }
    } catch (e) {
      this.d.log.warn("note association: counting strong pastes failed", { error: String(e).slice(0, 200) });
    }
    return out;
  }

  /** 这个脑区上一次判断的概率，能照用的话（话题够像、隔得不久）；不能就 undefined */
  private recentFor(region: string, v: Float32Array, P: (name: string, fallback?: number) => number): { v: Float32Array; at: number; p: Map<string, { text: string; p: number }> } | undefined {
    const last = this.recent.get(region);
    const cosMin = P("assoc.reuseCos");
    if (!last || cosMin >= 1 || this.d.now() - last.at > P("assoc.reuseMin") * 60_000 || last.v.length !== v.length) return undefined;
    let cos = 0;
    for (let i = 0; i < v.length; i++) cos += v[i]! * last.v[i]!;
    return cos >= cosMin ? last : undefined;
  }

  /**
   * 这个脑区现在不能再挂的页：这个前缀里挂过的，叫醒（和别的时候）一律不再挂；干活的时刻（WORK）她又看了
   * remountTokens 的经历（中央记忆从挂的那一刻起又进了这么多 token）就能再挂
   */
  private blocked(region: string, binding: Binding, P: (name: string, fallback?: number) => number): Set<string> {
    const given = this.given.get(region);
    if (!given?.size) return new Set();
    if (binding === "helper") return new Set(given.keys());   // 每个帮手同一页只给一次，强的也一样
    // 有强联想条目的页：隔 strength.strongRemountTokens 就能再挂，叫醒也算；别的页叫醒时这个前缀里只挂一次，干活的时刻隔 assoc.remountTokens
    const strongMin = P("strength.strongMin");
    const loud = new Set(this.d.shelf().pages.filter((p) => p.lessons.some((l) => (l.strength ?? 3) >= strongMin)).map((p) => p.ids[0]));
    // 交出去的那一下（交之前、发给主人之前）：强的再贴；
    // 这个脑区刚贴过、还在眼前的不重贴（strength.handRemountTokens，11-04：两分钟里交两次差就贴两遍）
    const handing = binding === "done_with" || binding === "handover";
    const strongGap = P("strength.strongRemountTokens");
    const handGap = P("strength.handRemountTokens");
    const workGap = P("assoc.remountTokens", this.d.cfg.remountTokens ?? 50_000);
    const needOf = (id: string): number => (loud.has(id) ? (handing ? handGap : strongGap) : WORK.has(binding) ? workGap : Infinity);
    if (![...given.keys()].some((id) => Number.isFinite(needOf(id)))) return new Set(given.keys());
    // 按这个脑区自己眼前的算（给了 seenSince 时）：要隔一段才能再挂的那几个挂的时刻，一次算好
    if (this.d.seenSince) {
      const timed = [...given].filter(([id]) => { const need = needOf(id); return need > 0 && Number.isFinite(need); }).map(([, seq]) => seq);
      const since = timed.length ? this.d.seenSince(region, timed) : new Map<number, number>();
      return new Set([...given].filter(([id, seq]) => { const need = needOf(id); return need > 0 && (!Number.isFinite(need) || (since.get(seq) ?? 0) < need); }).map(([id]) => id));
    }
    // 一次取出最早那次挂以后的每一条，从后往前累加，得到每个挂的时刻之后又进了多少
    const seqs = [...new Set(given.values())].sort((a, b) => b - a);
    const rows = all<{ seq: number; tokens: number }>(this.d.db,
      `SELECT seq, tokens FROM central WHERE seq > ? AND (meta IS NULL OR meta NOT LIKE '%"inner":true%') ORDER BY seq`, seqs.at(-1)!);
    const since = new Map<number, number>();
    let i = rows.length - 1;
    let acc = 0;
    for (const s of seqs) {
      for (; i >= 0 && Number(rows[i]!.seq) > s; i--) acc += Number(rows[i]!.tokens);
      since.set(s, acc);
    }
    return new Set([...given].filter(([id, seq]) => needOf(id) > 0 && since.get(seq)! < needOf(id)).map(([id]) => id));
  }

  /** 中央记忆现在到了哪一条（挂页时记下，干活的时刻按它算又看了多少） */
  private centralSeq(): number {
    return Number(one<{ s: number }>(this.d.db, "SELECT COALESCE(MAX(seq), 0) AS s FROM central")?.s ?? 0);
  }

  /** 前缀重建了：清这个脑区挂过的页和上一个话题；不带参数清全部 */
  prefixRebuilt(region?: string): void {
    if (region === undefined) {
      // 帮手的（cc:<名字>）不跟着清：她翻页不等于帮手换了会话，给过它的页照样不再给
      for (const m of [this.given, this.lastTopic]) for (const k of [...m.keys()]) if (!k.startsWith(HELPER_REGION)) m.delete(k);
      return;
    }
    this.given.delete(region);
    this.lastTopic.delete(region);
  }

  /** 这个脑区从 since 起真挂给她看过的页（只算不挂的不算），去重，按先后 */
  mountedSince(region: string, since: number): string[] {
    const out = new Set<string>();
    const rows = all<{ mounted: string }>(this.d.db, "SELECT mounted FROM learn_assoc WHERE region = ? AND shadow = 0 AND at >= ? ORDER BY at, id", region, since);
    for (const row of rows) {
      try {
        for (const m of JSON.parse(row.mounted) as Mounted) out.add(m.id);
      } catch { /* 坏行跳过 */ }
    }
    return [...out];
  }

  /** 判断；抛错（时区不对、kv 出错）当失败，不往外抛。background、once 见 Judge */
  private async judge(input: string, qs: Array<{ name: string; text: string }>, timeoutMs?: number, background = false, once = false) {
    this.lastJudge = this.d.now();
    try {
      return await this.d.judge.judge(input, qs, { ...(timeoutMs === undefined ? {} : { timeoutMs }), ...(background ? { background: true } : {}), ...(once ? { once: true } : {}) });
    } catch (e) {
      this.d.log.warn("note association: judge threw", { error: String(e).slice(0, 200) });
      return null;
    }
  }

  /**
   * 同一件事接着做（开始做时）：最近 assoc.carryDays 天里开始做的事，话题向量和这次的余弦到 assoc.carryCos 的，取最像的 CARRY_TASKS 件，
   * 那件事做的期间（开始到做完，没做完到现在）它那个脑区翻开过的页，按先像后翻的先后，去掉 skip（这次判断挑上的、这个脑区现在不能再挂的）、
   * 书架上没有或归档了的（翻的时候的编号后来合并、改号的，按别名认），最多 assoc.carryMax 页；每页带着是哪件事翻过的（from：那件事话题的头）。
   * 不问判断、不花钱。carryCos 超过 1（默认）就不带
   */
  private carryFor(v: Float32Array, taskId: number | undefined, P: (name: string, fallback?: number) => number, skip: Set<string>): { pages: Array<{ page: Page; cos: number; from: string }> } | null {
    const cosMin = P("assoc.carryCos");
    const max = P("assoc.carryMax");
    if (cosMin > 1 || max <= 0) return null;
    try {
      const since = this.d.now() - P("assoc.carryDays") * 86_400_000;
      const rows = all<{ vec: Uint8Array; task_id: number; owner: string; started: number; ended: number | null; topic: string }>(this.d.db,
        `SELECT a.vec, a.task_id, t.owner, t.started, t.ended, t.topic FROM learn_assoc a JOIN tasks t ON t.id = a.task_id
         WHERE a.binding = 'on_it' AND a.vec IS NOT NULL AND a.at >= ? AND a.task_id IS NOT ?`, since, taskId ?? null);
      const near = rows.flatMap((row) => {
        if (row.vec.byteLength !== v.length * 4) return [];
        const u = new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + row.vec.byteLength));
        let cos = 0;
        for (let i = 0; i < v.length; i++) cos += v[i]! * u[i]!;
        return cos >= cosMin ? [{ ...row, cos: Math.round(cos * 1000) / 1000 }] : [];
      }).sort((a, b) => b.cos - a.cos).slice(0, CARRY_TASKS);
      if (!near.length) return null;
      const byId = new Map(this.d.shelf().pages.filter((p) => !p.archived && p.ids[0]).map((p) => [p.ids[0]!, p]));
      const out: Array<{ page: Page; cos: number; from: string }> = [];
      for (const t of near) {
        const from = [...t.topic].length > CARRY_FROM_CHARS ? `${[...t.topic].slice(0, CARRY_FROM_CHARS).join("")}…` : t.topic;
        const opened = all<{ page_id: string }>(this.d.db,
          "SELECT page_id, MIN(at) AS first FROM learn_open WHERE region = ? AND page_id IS NOT NULL AND at >= ? AND at <= ? GROUP BY page_id ORDER BY first",
          t.owner, t.started, t.ended ?? this.d.now());
        for (const { page_id } of opened) {
          const id = resolveId(this.d.db, page_id);
          const page = byId.get(id);
          if (!page || skip.has(id) || out.some((x) => x.page === page) || out.length >= max) continue;
          out.push({ page, cos: t.cos, from });
        }
      }
      return out.length ? { pages: out } : null;
    } catch (e) {
      this.d.log.warn("note association: carry failed", { error: String(e).slice(0, 200) });
      return null;
    }
  }

  private record(r: {
    at: number; region: string; binding: Binding; topic: string; taskId: number | null; candidates: number;
    mounted: Mounted; shadow: boolean; skipped: string | null; ms: number; tokens: number;
    asked?: Map<string, number> | null; vec?: Float32Array | null;
  }): void {
    try {
      const asked = r.asked ? JSON.stringify(Object.fromEntries(r.asked)) : null;
      const vec = r.vec ? new Uint8Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength) : null;
      this.d.db
        .prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens, asked, vec) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(r.at, r.region, r.binding, r.topic.slice(0, TOPIC_MAX), r.taskId, r.candidates, JSON.stringify(r.mounted), r.shadow ? 1 : 0, r.skipped, r.ms, r.tokens, asked, vec);
    } catch (e) {
      this.d.log.warn("note association log failed", { error: String(e).slice(0, 200) });
    }
  }
}

/** 读文件的命令（读进来给她看的）；sed 带 -i 是改，不算 */
const READERS = new Set(["cat", "head", "tail", "less", "more", "nl", "sed", "grep", "egrep", "fgrep", "rg"]);
/** 头一个不是选项的参数是要找的字或 sed 脚本（有 -e、-f 时就没有） */
const PATTERN_FIRST = new Set(["sed", "grep", "egrep", "fgrep", "rg"]);
/** 后面跟一个值的短选项、长选项（--x=y 写在一起的不用管） */
const VALUE_SHORT: Record<string, string> = { sed: "efl", grep: "efABCmdD", egrep: "efABCmdD", fgrep: "efABCmdD", rg: "efABCmgtTMj", head: "nc", tail: "nc" };
const VALUE_LONG = new Set(["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--max-count", "--context", "--after-context", "--before-context", "--lines", "--bytes", "--expression", "--max-depth", "--threads"]);

/** shell 命令拆成一段段的词：引号里的照原样，; && || | & 换行 ( ) 分段，> >> < 2> 这些重定向连同后面的目标去掉（写到哪不算读） */
function shellSegments(cmd: string): Array<Array<{ word: string; raw: boolean }>> {
  const segs: Array<Array<{ word: string; raw: boolean }>> = [[]];
  let word = "";
  let quoted = false;    // 这个词里有引号（"" 也算一个词）
  let raw = false;       // 有没被引号包住的 $ 或反引号：展开不了
  let skipNext = false;  // 下一个词是重定向的目标
  let any = false;
  const end = (): void => {
    if (any || quoted) {
      if (skipNext) skipNext = false;
      else segs.at(-1)!.push({ word, raw });
    }
    word = ""; quoted = false; raw = false; any = false;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1);
      word += cmd.slice(i + 1, j < 0 ? cmd.length : j);
      quoted = true; any = true;
      i = j < 0 ? cmd.length : j;
    } else if (c === '"') {
      let j = i + 1;
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === "\\" && j + 1 < cmd.length) { j++; word += cmd[j]; continue; }
        if (cmd[j] === "$" || cmd[j] === "`") raw = true;
        word += cmd[j];
      }
      quoted = true; any = true;
      i = j;
    } else if (c === "\\") {
      if (i + 1 < cmd.length && cmd[i + 1] !== "\n") { word += cmd[i + 1]; any = true; }
      i++;
    } else if (c === " " || c === "\t") {
      end();
    } else if (c === "\n" || c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      // >& 和 &> 是重定向，不是分段
      if (c === "&" && (cmd[i + 1] === ">" || word.endsWith(">"))) { word += c; any = true; continue; }
      end();
      if (c === "&" && cmd[i + 1] === "&") i++;
      else if (c === "|" && cmd[i + 1] === "|") i++;
      segs.push([]);
    } else if (c === ">" || c === "<") {
      // 词里只有数字（2>）、或者是 & 开头（&>）：连着算这个重定向
      if (!/^(\d*|&)$/.test(word) || quoted) end();
      while (cmd[i + 1] === ">" || cmd[i + 1] === "<" || cmd[i + 1] === "&") i++;
      word = ""; any = false; quoted = false; raw = false;
      // 目标写在一起的（>/dev/null、2>&1）：读到空白为止都是目标
      skipNext = true;
    } else {
      if (c === "$" || c === "`") raw = true;
      word += c; any = true;
    }
  }
  end();
  return segs.filter((s) => s.length);
}

/** heredoc 的正文去掉（python 脚本、写进文件的内容，里面的路径不是她在读） */
function stripHeredocs(cmd: string): string {
  const lines = cmd.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    out.push(line);
    const tags = [...line.matchAll(/<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/g)].map((m) => m[2]!);
    for (const tag of tags) {
      while (i + 1 < lines.length && lines[i + 1]!.replace(/^\t+/, "").trim() !== tag) i++;
      i++;   // 结尾那行
    }
  }
  return out.join("\n");
}

/**
 * 一条 Bash 命令里读了哪些文件（绝对路径，去重，按出现先后）：只认 cat、head、tail、less、more、nl、sed（不带 -i）、grep、rg，
 * 而且只认写明的路径——带通配（* ? [ {）、变量、命令替换的不展开，heredoc 里的、重定向的目标不算。
 * 相对路径按 cwd，cd 跟着走（cd 到哪儿展开不了就不再认相对路径）；~ 和 $HOME 展开成 home。宁可漏记，不乱记。
 */
export function bashReads(cmd: string, cwd: string, home: string): string[] {
  const out: string[] = [];
  let dir: string | null = cwd;
  const expand = (w: { word: string; raw: boolean }): string | null => {
    let p = w.word;
    if (p === "~" || p.startsWith("~/")) p = home + p.slice(1);
    else if (p === "$HOME" || p.startsWith("$HOME/")) p = home + p.slice(5);
    else if (w.raw) return null;
    if (/[*?[{$`]/.test(p) || !p) return null;
    if (isAbsolute(p)) return resolve(p);
    return dir === null ? null : resolve(dir, p);
  };
  for (const seg of shellSegments(stripHeredocs(cmd))) {
    let words = seg;
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0]!.word)) words = words.slice(1);   // 前面的 X=1 环境变量
    if (!words.length) continue;
    const name = basename(words[0]!.word);
    const args = words.slice(1);
    if (name === "cd") {
      dir = args.length ? expand(args[0]!) : home;
      continue;
    }
    if (!READERS.has(name)) continue;
    const short = VALUE_SHORT[name] ?? "";
    const files: Array<{ word: string; raw: boolean }> = [];
    let patternGiven = false;
    let inPlace = false;
    let opts = true;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!.word;
      if (opts && a === "--") { opts = false; continue; }
      if (opts && a.startsWith("--") && a.length > 2) {
        const key = a.split("=")[0]!;
        if (key === "--in-place") inPlace = true;
        if (key === "--regexp" || key === "--file" || key === "--expression") patternGiven = true;
        if (!a.includes("=") && VALUE_LONG.has(key)) i++;
        continue;
      }
      if (opts && a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) {
        for (let k = 1; k < a.length; k++) {
          const f = a[k]!;
          if (name === "sed" && f === "i") { inPlace = true; break; }   // -i 后面跟的是备份后缀
          if (short.includes(f)) {
            if (f === "e" || f === "f") patternGiven = true;
            if (k === a.length - 1) i++;   // 值是下一个词；不然值就是这个词剩下的
            break;
          }
        }
        continue;
      }
      if (opts && /^-\d+$/.test(a)) continue;   // head -40
      files.push(args[i]!);
    }
    if (inPlace) continue;
    const paths = PATTERN_FIRST.has(name) && !patternGiven ? files.slice(1) : files;
    for (const w of paths) {
      const p = expand(w);
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}
