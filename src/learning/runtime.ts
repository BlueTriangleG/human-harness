// 学习的运行时：把书架、编号、封面向量和话题联想装在一起交给 Brain。
// scan = 补编号 → 重扫 → 后台刷封面向量；rescan 是等封面刷完的版本；shelf() 用缓存的书架（没扫过先扫一次）；
// refreshIfChanged 是白天书架有改动时的 scan（hhd 每次 tick 问一次）；
// afterNight 是夜里整理完一天之后的收尾：记又犯；这一夜最后一天整理完再发号、刷封面、回测、写每周数字。
import { skillsPluginName } from "../persona/skills.ts";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { roleNames, type Config, type LearningCfg } from "../config.ts";
import type { Logger } from "../log.ts";
import { kvSet, one, type Db } from "../store/db.ts";
import { OpenAIEmbedder, loadOpenAIKey, type Embedder } from "../memory/events/embed.ts";
import type { EventMemory } from "../memory/events/memory.ts";
import { CentralMemory } from "../memory/central.ts";
import { NoteAssociator } from "./associate.ts";
import { CoverIndex, ItemIndex } from "./covers.ts";
import { KeywordDecisions, OpenAIDecisions, type Judge } from "./decisions.ts";
import { assignIds, QUIET_MS } from "./ids.ts";
import { curateShelf } from "./curator.ts";
import { rebuildLinks } from "./graph.ts";
import { readShelfRules, SHELF_FILE } from "./layers.ts";
import { scanShelf, type Shelf } from "./notebook.ts";
import { classifyRecurrences, localDay, previousNight, renderWeekly, replayScore, runReplay, shiftDay, weekly, worklist } from "./score.ts";
import { shelfDirOf } from "./shelf.ts";
import { nightTune } from "./tuner.ts";
import { L } from "../lang/index.ts";

export interface LearningRuntime {
  notes: NoteAssociator;
  /** 记分表、回测题所在的库（hh learn 直接读写） */
  readonly db: Db;
  /** 主人的名字（给她看的句子里写到主人的地方用） */
  readonly owner: string;
  /** 书架目录相对工作区的路径（给她看的页路径的前缀） */
  readonly shelfDir: string;
  /** 出处里要留下的记号：她的规矩文件里的 importantMarks，上次扫书架时读的那份（还没扫过是空的） */
  marks(): readonly string[];
  shelf(): Shelf;
  scan(): Shelf;
  /** scan，但等封面向量刷完才返回（夜里、hh learn scan 用）；刷封面出错只记 warn，embedded 记 0 */
  rescan(): Promise<{ shelf: Shelf; embedded: number }>;
  /**
   * 书架上的 .md 和上次扫完时不一样（新页、改了字、删了），而且最近一次改动已经过了安静期，就 scan 一次，返回 true；
   * 没改动、她还在写、读不了书架都不扫。她白天改了笔记，几分钟内就有编号和封面，联想用得上，不用等换前缀。
   * hhd 每次 tick 调；她睡着时别调：夜里整理的提案是照整理开始时的文件写的，中途发号会让应用对不上。
   */
  refreshIfChanged(): boolean;
  /** 夜里整理 day 这一天的学习工作单（海马的 learn_worklist）：按书架现在的样子重读一遍、只读，不发号、不写文件 */
  worklist(day: string): Promise<string>;
  /** final 默认 true；这一夜后面还要接着整理别的日子时给 false：只记这一天的又犯，回测等最后一天 */
  afterNight(day: string, o?: { final?: boolean }): Promise<void>;
}

const errText = (e: unknown): string => String(e).slice(0, 200);
/** 条目向量没算成：白天 tick 时隔这么久再试（书架没变也试） */
const ITEM_RETRY_MS = 10 * 60_000;
/** 最后一天整理完，往前看几天的又犯（含那天）：她整理时会给前几天的教训补上"犯的日子"，工作单也让她补前一天的 */
const RECUR_WINDOW_DAYS = 7;
/** 书架上每个 .md 的路径、改动时间、大小（隐藏的不算，最多往下走 8 层）和最近一次改动的时间；读不了书架给 null */
function shelfStamp(root: string): { sig: string; newest: number } | null {
  const parts: string[] = [];
  let newest = 0;
  const walk = (dir: string, rel: string, depth: number): void => {
    for (const n of readdirSync(dir).sort()) {
      if (n.startsWith(".")) continue;
      const abs = join(dir, n);
      let st;
      try { st = statSync(abs); } catch { continue; }
      const r = rel ? `${rel}/${n}` : n;
      if (st.isDirectory()) { if (depth < 8) { try { walk(abs, r, depth + 1); } catch { parts.push(`${r}/:读不了`); /* part of the stamp: only compared, never shown */ } } }
      else if (n.endsWith(".md")) { parts.push(`${r}:${st.mtimeMs}:${st.size}`); newest = Math.max(newest, st.mtimeMs); }
    }
  };
  try { walk(root, "", 0); } catch { return null; }
  return { sig: parts.join("\n"), newest };
}

const rate = (s: { total: number; passed: number }): string => L.runtime.passRate(Math.round((s.passed / s.total) * 100), s.passed, s.total);
type Score = { total: number; passed: number; skipped: number };

/** 每周数字后面接今晚回测的那几行；回测通过率比前一晚低时第一行标出来——两晚都全判成了才比 */
function nightReport(weeklyText: string, cur: Score | null, prev: Score | null): string {
  const lines = [cur ? L.runtime.replayTonight(cur.passed, cur.total, cur.skipped ? L.runtime.replayUnjudged(cur.skipped) : "") : L.runtime.replayNoResult];
  let drop = "";
  if (cur && prev) {
    if (cur.skipped) lines.push(L.runtime.tonightUnjudged(cur.skipped));
    else if (prev.skipped) lines.push(L.runtime.previousUnjudged(prev.skipped));
    else if (cur.total && prev.total && cur.passed * prev.total < prev.passed * cur.total) drop = L.runtime.passRateDropped(rate(prev), rate(cur));
  }
  return `${drop}${weeklyText}${lines.join("\n")}\n`;
}

export function createLearningRuntime(o: {
  db: Db;
  cfg: LearningCfg;
  embedder: Embedder | null;
  judge: Judge;
  /** 话题的向量（事件记忆的 cueVector，同一句话只算一次） */
  vec: (q: string, timeoutMs?: number) => Promise<Float32Array | null>;
  now: () => number;
  log: Logger;
  /** hhd 的状态目录：每周数字写进 learn/weekly.md */
  stateDir: string;
  /** 她的时区：回测按晚记、每周数字按她的日子算 */
  tz: string;
  /** 脑区的工作目录（她 Bash 里读页的相对路径按它算） */
  cwd?: string;
  /** The role's manuals plugin (persona/skills.ts skillsPluginName): a Skill call named <it>:<book> opens that book */
  skillsPlugin?: string;
  /** 夜里整理那份报告的位置：相对工作区（cwd）的路径模板，{day} 换成整理的那一天（配置 sleep.reportFile）；不给 = 不往报告里追加 */
  reportFile?: string;
  /** 主人的名字 */
  owner: string;
  /** 书架目录相对工作区的路径，正斜杠（shelfDirOf）：给她看的页路径都用它做前缀 */
  shelfDir: string;
  /** 「隔多少再挂」按脑区自己眼前的算时，别人的一条最多算多少字（limits.maxItemChars）；不给就按所有脑区的原文合计 */
  viewItemChars?: number;
  /** 没有向量（没有 OpenAI key）：联想只按字找 */
  keywordOnly?: boolean;
  /** 主线眼前别人的「想」折成一行多少字（limits.syncThinkChars）；只算主线的时候用 */
  viewThinkChars?: number;
}): LearningRuntime {
  const { db, cfg, log, owner, shelfDir } = o;
  const covers = new CoverIndex(db, o.embedder);
  /** 这一天的整理报告在哪（sleep.reportFile）：没配、没有工作区、或者算出来落在工作区外面，都当没有（落在外面的记一条） */
  const reportPath = (day: string): string | null => {
    if (!o.reportFile || !o.cwd) return null;
    const p = resolve(o.cwd, o.reportFile.replaceAll("{day}", day));
    const rel = relative(resolve(o.cwd), p);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) { log.warn("learning: sleep.reportFile points outside the workspace, not appending", { reportFile: o.reportFile }); return null; }
    return p;
  };
  /** 出处里要留下的记号（她的规矩文件里的 importantMarks）：跟着书架重扫读一次，和缓存的书架放在一起 */
  let marks: readonly string[] = [];
  // 页里每条教训、做法的向量（只在内存里，跟着封面一起刷）；页读不到就只有教训
  const items = new ItemIndex(o.embedder, (rel) => readFileSync(join(cfg.root, rel), "utf8"), () => ({ owner, shelfDir, keep: marks }));
  const central = new CentralMemory(db, o.now);
  const readPage = (rel: string): string | null => { try { return readFileSync(join(cfg.root, rel), "utf8"); } catch { return null; } };
  let cached: Shelf | null = null;
  /** 上次扫完时书架的样子（发号写回的也算进去）；null 是还没扫过 */
  let stamped: string | null = null;
  /** 上次记下的扫描问题：一样的不再记（书架目录不进前缀时，这是唯一看得到它们的地方） */
  let reported = "";

  /** 补编号再扫一遍，换掉缓存；封面向量交给调用的人刷 */
  const reshelve = (): Shelf => {
    // 先补编号（没号的页存不进封面向量），再扫一遍拿带号的书架；编号失败不挡扫描，没号的页这次只是不当候选
    try {
      const r = assignIds(cfg.root, db, { now: o.now, generalCategory: cfg.generalCategory, archiveDir: cfg.archiveDir });
      if (r.pages || r.lessons || r.renumbered?.length) log.info("learning: ids assigned", { ...r });
    } catch (e) {
      log.warn("learning: assigning ids failed", { error: errText(e) });
    }
    cached = scanShelf(cfg.root, cfg.generalCategory, cfg.archiveDir);
    marks = readShelfRules(cfg.root, cfg.shelfFile ?? SHELF_FILE).rules.importantMarks;
    stamped = shelfStamp(cfg.root)?.sig ?? null;
    // 页里提到别的页的那种连线跟着书架重算（一起翻过的、事件里写到的夜里再算）
    try { rebuildLinks(db, cached, readPage, o.now(), { refOnly: true }); } catch (e) { log.warn("learning: links (ref) failed", { error: errText(e) }); }
    const problems = cached.problems.join("\n");
    if (problems !== reported && cached.problems.length) log.warn("learning: shelf scan problems", { count: cached.problems.length, first: cached.problems.slice(0, 3) });
    reported = problems;
    return cached;
  };
  const coverFailed = (e: unknown): void => log.warn("learning: cover refresh failed", { error: errText(e) });
  const itemsFailed = (e: unknown): void => log.warn("learning: item vectors failed", { error: errText(e) });
  /** 条目向量这次没算成（向量服务出错）：记一条（连着失败只记一次），refreshIfChanged 隔 ITEM_RETRY_MS 再试 */
  let itemsStale = false;
  let itemsTried = -Infinity;
  const refreshItems = (shelf: Shelf): void => {
    itemsTried = o.now();
    items.refresh(shelf).then((r) => {
      if (r.failed && !itemsStale) log.warn("learning: item vectors failed", { error: "embedder returned nothing; will retry" });
      itemsStale = !!r.failed;
    }, (e: unknown) => { if (!itemsStale) itemsFailed(e); itemsStale = true; });
  };

  const scan = (): Shelf => {
    const shelf = reshelve();
    // 封面、条目的向量在后台算（一批可能几秒），不等；出错只记一条
    covers.refresh(shelf).catch(coverFailed);
    refreshItems(shelf);
    return shelf;
  };

  const rescan = async (): Promise<{ shelf: Shelf; embedded: number }> => {
    const shelf = reshelve();
    refreshItems(shelf);
    try {
      return { shelf, embedded: (await covers.refresh(shelf)).embedded };
    } catch (e) {
      coverFailed(e);
      return { shelf, embedded: 0 };
    }
  };

  /**
   * 联想用的向量最多等 timeoutMs：cueVector 同一句话正在算时会接上那一次（可能是事件记忆用更长的超时开的），
   * 所以自己再掐一次表，到点按没有向量算
   */
  const vec = (q: string, timeoutMs?: number): Promise<Float32Array | null> => {
    const ms = timeoutMs ?? cfg.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
    return Promise.race([o.vec(q, ms), late]).finally(() => clearTimeout(timer));
  };

  // 挂过的页隔多少再挂：按这个脑区自己眼前的算（这一页里、挂的那条以后；central.viewTokens）
  const seenSince = o.viewItemChars === undefined ? undefined : (region: string, seqs: number[]): Map<number, number> => {
    const epoch = one<{ e: number }>(db, "SELECT epoch AS e FROM central ORDER BY seq DESC LIMIT 1")?.e;
    return epoch === undefined ? new Map() : central.viewTokensAfter(Number(epoch), region, seqs, { maxItemChars: o.viewItemChars!, ...(region === "main" && o.viewThinkChars ? { thinkChars: o.viewThinkChars } : {}) });
  };
  const notes = new NoteAssociator({
    db, cfg, shelf: () => cached ?? scan(), covers, items, judge: o.judge, vec, now: o.now, log, shelfDir, keep: () => marks, ...(o.keywordOnly ? { keywordOnly: true } : {}),
    ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.skillsPlugin ? { skillsPlugin: o.skillsPlugin } : {}), ...(seenSince ? { seenSince } : {}),
  });

  /** 这一夜已经整理完、还没做最后一步的日子：最后一步发完号再记一遍它们的又犯（新写的教训那时才有号） */
  const organized = new Set<string>();

  /**
   * 整理完 day 这一天。不是最后一天（final false）：只按书架现在的样子（只读地扫，不发号）记这一天的又犯。
   * 最后一天：发号 → 刷完封面（回测要新向量）→ 记往前 7 天（day−6..day）加上这一夜整理过的每一天的又犯
   * → 用最后的封面回测一次（按今晚记）→ 每周数字和今晚的回测写进 learn/weekly.md。
   * 每一步出错只记 warn，后面的照做，整个不抛；又犯一天一步，一天出错不耽误别的天（记过的不会重记）。
   */
  const night = async (day: string, final: boolean): Promise<void> => {
    const step = async <T>(what: string, fn: () => T | Promise<T>, d = day): Promise<T | undefined> => {
      try {
        return await fn();
      } catch (e) {
        log.warn(`learning: after-night ${what} failed`, { day: d, error: errText(e) });
        return undefined;
      }
    };
    const classify = async (shelf: Shelf, days: string[]): Promise<number> => {
      let n = 0;
      for (const d of days) n += (await step("recurrences", () => classifyRecurrences(db, shelf, d, { central, tz: o.tz }).length, d)) ?? 0;
      return n;
    };
    if (!final) {
      organized.add(day);
      const recur = await classify(scanShelf(cfg.root, cfg.generalCategory, cfg.archiveDir), [day]);
      log.info("learning: after night (more days to organize)", { day, recurrences: recur });
      return;
    }
    // day 不是真有的一天时推不了日子，只看它自己（classifyRecurrences 会跳过）
    const window = (await step("recurrence window", () => Array.from({ length: RECUR_WINDOW_DAYS }, (_, i) => shiftDay(day, i - RECUR_WINDOW_DAYS + 1)))) ?? [day];
    const days = [...organized, ...window].filter((d, i, a) => a.indexOf(d) === i);
    organized.clear();
    const shelf = (await step("rescan", rescan))?.shelf ?? cached;
    if (!shelf) return;
    // 连线三种都重算；再分一遍层（#0058：不挪页，只记层），这一天的报告在就加一节
    await step("links", () => { log.info("learning: links rebuilt", { ...rebuildLinks(db, shelf, readPage, o.now()) }); });
    await step("layers", () => {
      const r = curateShelf(db, cfg.root, cfg.generalCategory, o.now(), { archiveDir: cfg.archiveDir, residentFile: cfg.residentFile, ...(cfg.shelfFile ? { shelfFile: cfg.shelfFile } : {}) });
      if (r.problem) log.warn("learning: shelf rules file", { problem: r.problem });
      const report = reportPath(day);
      if (r.text && report && existsSync(report)) appendFileSync(report, `\n\n${r.text}\n`);
    });
    const recur = await classify(shelf, days);
    const tonight = localDay(o.now(), o.tz);
    const replay = await step("replay", () => runReplay(db, notes, tonight));
    // 回测完调参（参数靠每晚的 eval 找最合适的，平衡性能、价格、效果）：最多动两个，坏了下一晚退回
    const tuned = await step("tune", () => nightTune(db, {
      now: o.now(), day: shiftDay(tonight, -1), night: tonight, prevNight: previousNight(db, tonight), dailyUsd: cfg.dailyUsd, limitMs: cfg.timeoutMs,
      fallback: { "assoc.threshold": cfg.threshold, "assoc.remountTokens": cfg.remountTokens ?? 50_000, "assoc.kWake": cfg.kWake, "assoc.kTask": cfg.kTask },
    }));
    if (tuned) log.info("learning: night tuning", { lines: tuned.slice(1) });
    await step("weekly", () => {
      const before = previousNight(db, tonight);
      const text = nightReport(
        renderWeekly(weekly(db, { now: o.now(), tz: o.tz, shelf, central, root: cfg.root }), owner),
        replayScore(db, tonight), before ? replayScore(db, before) : null,
      ) + (tuned ? `\n${tuned.join("\n")}\n` : "");
      const dir = join(o.stateDir, "learn");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "weekly.md"), text);
    });
    log.info("learning: after night", { days, night: tonight, recurrences: recur, replay: replay ?? null });
  };
  // 一夜整理几天时一天一次：排着做，回测不会同时跑两遍
  let chain: Promise<void> = Promise.resolve();
  const afterNight = (day: string, a: { final?: boolean } = {}): Promise<void> => {
    const run = chain.then(() => night(day, a.final ?? true));
    chain = run.catch(() => {});
    return run;
  };

  return {
    notes,
    db,
    owner,
    shelfDir,
    marks: () => marks,
    shelf: () => cached ?? scan(),
    scan,
    rescan,
    refreshIfChanged: () => {
      if (itemsStale && cached && o.now() - itemsTried >= ITEM_RETRY_MS) refreshItems(cached);
      const s = shelfStamp(cfg.root);
      if (!s || s.sig === stamped) return false;
      // 她还在写：等最近一次改动过了安静期（不然发号会跳过那页，白扫一遍）
      if (o.now() - s.newest < QUIET_MS) return false;
      scan();
      return true;
    },
    afterNight,
    worklist: (day) => worklist(db, scanShelf(cfg.root, cfg.generalCategory, cfg.archiveDir), day, { now: o.now(), tz: o.tz, embedder: o.embedder, root: cfg.root, owner, shelfDir, residentFile: cfg.residentFile }),
  };
}

/**
 * hhd 里建学习这一套：判断和向量都要 OpenAI key；没有就只按字找（KeywordDecisions、粗筛按字、没有向量），记一条 warn。
 * 开关全关也建：hh learn、夜里的工作单和把关要用，开关只管行为。
 * 事件记忆有向量服务就共用它的 embedder 和线索向量（熔断一份，同一句话只算一次）；没有就自己开一个。
 * 判断的告警记 error，写进 kv learn.alert（控制台标红）。fetchImpl、now 给测试换。
 */
export function makeLearning(
  cfg: Config, db: Db, mem: EventMemory | undefined, log: Logger,
  o: { fetchImpl?: typeof fetch; now?: () => number; keywordWithoutKey?: boolean } = {},
): LearningRuntime | undefined {
  const key = loadOpenAIKey(cfg.stateDir);
  const now = o.now ?? Date.now;
  // 主人的名字、书架目录相对工作区的路径：在这里从配置取一次，往下都走参数
  const owner = roleNames(cfg).owner;
  const shelfDir = shelfDirOf(cfg.workspace, cfg.learning.root);
  const common = { db, cfg: cfg.learning, now, log, stateDir: cfg.stateDir, tz: cfg.schedule.timezone, cwd: cfg.workspace, skillsPlugin: skillsPluginName(cfg.id), ...(cfg.sleep.reportFile ? { reportFile: cfg.sleep.reportFile } : {}), owner, shelfDir, viewItemChars: cfg.limits.maxItemChars, viewThinkChars: cfg.limits.syncThinkChars ?? 0 };
  if (!key && o.keywordWithoutKey === false) return undefined;   // 回放的世界：照没有退路以前那样不建
  if (!key) {
    // 和事件记忆一样有退路：没有 key 也建，联想只按字找（不花钱、不会失败）
    log.warn("learning: no OpenAI key, keyword search only");
    return createLearningRuntime({ ...common, embedder: null, judge: new KeywordDecisions(), vec: async () => null, keywordOnly: true });
  }
  const fetchImpl = o.fetchImpl ? { fetchImpl: o.fetchImpl } : {};
  const judge = new OpenAIDecisions({
    key, db, tz: common.tz, timeoutMs: cfg.learning.timeoutMs, dailyUsd: cfg.learning.dailyUsd, now, log, ...fetchImpl,
    // a key that may not use decisions still finds pages by meaning; the words judge scores them
    instead: new KeywordDecisions(),
    // 日志的 msg 是固定的那句，告警的话放 alert 里（放 msg 会盖掉）
    onAlert: (msg) => {
      log.error("learning alert", { alert: msg });
      kvSet(db, "learn.alert", JSON.stringify({ at: now(), msg }));
    },
  });
  const index = mem?.index.embedder ? mem.index : null;
  const embedder = index?.embedder ?? new OpenAIEmbedder({ key, ...fetchImpl });
  const vec = index
    ? (q: string, ms?: number) => index.cueVector(q, ms)
    : async (q: string, ms?: number) => (await embedder.embed([q], ms ? { timeoutMs: ms } : {}))?.[0] ?? null;
  // 熔断、上一次的错误：判断的记在日志里（OpenAIDecisions 的 log）；向量的熔断和事件记忆共用一份（index.embedder，归事件记忆管）
  return createLearningRuntime({ ...common, embedder, judge, vec });
}
