// 夜里引擎在 Brain 这一头的接线（spec §5、§6.1、§8）：读流程（flow.json + SOUL + common），开段、核依据、考试的会话，真文件。
// Brain 只给一个窄接口（NightBrain）；这里拼出 runner 要的 StageHost、核依据要的 AuditHost、考试要的 ExamHost。
// 一夜里段和核依据的会话开头一样：系统提示 =「睡着的她」（SOUL + common）；考试的会话（考生、判分、出暗题）开头是「考场开头」
// （配置点名的基础块）。工具清单所有会话都是当晚各段工具的并集 + 交差工具（有段要考试时再加考试的工具），一字不差（缓存共用）；
// 这一段能用哪些、能写哪里由 session.ts 的 guard 在运行时拦。
// 考试（有段配了 exam 才有）：段先交题才能动手（交够 min 道解锁）；写事件库的段解锁前把事件库拷一份放在 stateDir 下（不放工作区），
// 整理前补考读它，这一次尝试结束就删；落地时题库里过了的段的待定题生效，整天撤回时丢掉（推迟了的段留着）。
// 考试的会话读的是「醒着的她」：第一条消息不带夜里整理的角色说明，不能读 sleep/ 和答案从注入里给的那几个文件；
// 常驻那层的考生、判分、出暗题的什么都不读。注入预览的草稿写在 stateDir 下，用完就删。
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as sqlite from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { kernelEnv, type Config } from "../config.ts";
import type { KernelDriver, ToolDef, SessionSpec } from "../kernel/types.ts";
import type { Logger } from "../log.ts";
import type { EventMemory } from "../memory/events/memory.ts";
import type { EventStore } from "../memory/events/store.ts";
import { P, S } from "../lang/index.ts";
import { modelFor } from "../regions/specs.ts";
import { one, type Db } from "../store/db.ts";
import { MEM_READ_TOOLS, MEM_STORE_WRITERS, MEM_WRITE_TOOLS } from "../tools/memtools.ts";
import type { Runner } from "../util/run.ts";
import { Bank, type QuestionIn } from "./bank.ts";
import { DEFAULT_WEIGHTS, units, type Budget, type Model, type Weights } from "./budget.ts";
import { beforeContent, centralRef, plainInjection, questionProblem, SEARCH_TOOLS, type BeforeView, type ExamHost, type ExamOpen, type ExamSession } from "./exam.ts";
import { examReadGuard } from "./readguard.ts";
import { hangsOn } from "./examiner.ts";
import { renderMidterm } from "../memory/events/midterm.ts";
import { nextDayStart, nightWindow } from "../brainstem/clock.ts";
import { languageLine, trimForMidterm } from "../persona/persona.ts";
import { loadFlow, matchWrites, parsePersonas, personaProblems, type FlowConfig, type Personas, type StageExam, type StageSpec } from "./flow.ts";
import type { LadderPlan } from "./ladder.ts";
import type { MiniFs, Snapshot, StageRecord } from "./record.ts";
import { stageBatch, type OpenedStage, type StageHost } from "./runner.ts";
import { openStageSession, STAGE_BUILTINS, type StageSession, type StageUsage } from "./session.ts";
import {
  auditDoneTool, coordinateTool, examAnswersTool, examGradesTool, examQuestionsTool, leadReviewTool, leadVerdictTool, reviewDoneTool, stageDoneTool,
  type AuditDone, type CoordinateIn, type ExamAnswers, type ExamGrades, type LeadReview, type LeadVerdict, type QuestionsIn, type ReviewDone, type StageDone,
} from "./tools.ts";
import type { AuditHost } from "./validate.ts";
import type { ReviewHost } from "./review.ts";
import { batchDiff } from "./opsdiff.ts";
import { SLICE_CAP, SLICE_TOO_LONG } from "./leadprompts.ts";
import { cacheKeyOf } from "./cachekey.ts";
import type { CoordHost } from "./coordinator.ts";

/**
 * 段能点名的 HH 工具：想起事情的、写事件库的、学习的工作单和把关（就是旧的整理时海马有的，去掉 jot_down）。
 * 对外说话的、记进她中央记忆的都不在里面：段的会话不进中央记忆、不能开口
 */
export const SLEEP_HH_TOOLS: readonly string[] = ["recall", ...MEM_READ_TOOLS, ...MEM_WRITE_TOOLS, "learn_worklist", "learn_check"];
/** 核依据要用的 HH 工具（validate.ts 给它的 allowed）：并集里总带着，核依据的会话才有得用 */
export const AUDIT_HH_TOOLS: readonly string[] = ["recall", "recall_event"];
/**
 * builtin 段认得的名字：都是引擎外照旧做的睡前、收尾步骤（闸门的每日总结、清闸门的账、放下后台的活、学习的夜里收尾、换新前缀）。
 * 配置里写上只是让顺序看得见，runner 一律当作过了
 */
export const SLEEP_BUILTINS: readonly string[] = ["gate-digest", "prune-gate", "pause-backgrounds", "learn-after-night", "consolidate"];

const TIERS: readonly Model[] = ["opus", "sonnet", "haiku"];
const PYTHONS = new Set(["python3", "python"]);
/** 注入预览脚本的时限 */
const PREVIEW_MS = 2 * 60_000;
/** 考试会话 id 里的日子：exam-<日>-… */
const EXAM_DAY = /^exam-(\d{4}-\d{2}-\d{2})-/;
/** 整理前的事件库拷贝的文件名（<日>-<段>-<第几次>.db 和它的 -wal/-shm/-journal）：开跑前只清这样的 */
const COPY_NAME = /^\d{4}-\d{2}-\d{2}-[A-Za-z0-9_-]+-\d+\.db(-wal|-shm|-journal)?$/;
/** p 在 dir 里面（或者就是它） */
const within = (dir: string, p: string): boolean => { const r = relative(dir, p); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 今晚要考试的段：开着的 agent 段配了 exam */
export const examStages = (flow: FlowConfig): StageSpec[] => flow.stages.filter((s) => s.kind === "agent" && s.enabled && s.exam !== null);

/** 真文件：相对路径按 root（工作区）算，绝对路径照用；写先写临时文件再换名（写到一半断了不留半截） */
export function nodeFs(root: string): MiniFs {
  const abs = (p: string): string => resolve(root, p);
  return {
    read: (p) => { try { return readFileSync(abs(p), "utf8"); } catch { return null; } },
    write: (p, s) => {
      const f = abs(p);
      mkdirSync(dirname(f), { recursive: true });
      const tmp = `${f}.tmp-${process.pid}`;
      writeFileSync(tmp, s);
      renameSync(tmp, f);
    },
    remove: (p) => { rmSync(abs(p), { force: true }); },
    list: (dir) => { try { return readdirSync(abs(dir)); } catch { return []; } },
    isDir: (p) => { try { return statSync(abs(p)).isDirectory(); } catch { return false; } },
  };
}

/** 比路径时不分大小写、不分全角半角（有的盘不分大小写：换个写法是同一个文件） */
const foldPath = (p: string): string => p.normalize("NFKC").toLowerCase();
const insidePath = (p: string, dir: string): boolean => foldPath(p) === foldPath(dir) || foldPath(p).startsWith(foldPath(dir) + sep);
/** 一个绝对路径实际落在哪儿：最深的那一层存在的目录照 realpath（软链解开、照盘上的写法），剩下的原样接上 */
function landsAt(abs: string): string {
  let rest: string[] = [];
  for (let cur = abs; ; ) {
    try { return join(realpathSync.native(cur), ...rest); } catch { /* 这一层不在：往上找 */ }
    const up = dirname(cur);
    if (up === cur) return abs;
    rest = [cur.slice(up.length).replace(/^[\\/]+/, ""), ...rest];
    cur = up;
  }
}
/** 路径的每一段是不是盘上那个写法：盘上有这个名字、只是大小写不一样的不算（没有这个名字的不管：读不出来就是读不出来） */
function spelledAsOnDisk(base: string, segs: string[]): boolean {
  let dir = base;
  for (const seg of segs) {
    let names: string[];
    try { names = readdirSync(dir); } catch { return true; }
    if (!names.includes(seg)) return !names.some((n) => foldPath(n) === foldPath(seg));
    dir = join(dir, seg);
  }
  return true;
}

/**
 * 出处里的一个路径（工作区里的相对路径）算不算「改动以外的」：给回理顺过的写法（去掉 ./、并掉 //），不算的给 null。
 * 不看怎么写、看它实际落在哪儿：
 * - 绝对路径、带 .. 的不认；
 * - sleep/ 下面只认这一天的材料（input.md、slices/）；别的（提案、引擎写的记录和它抄的那份改动、别的日子）不认——
 *   换个大小写、绕一个软链落到那里的一样不认；
 * - 提案目录里那个位置要是绕出了提案目录（软链），不认；
 * - 提案目录里有这个文件、只是大小写写得不一样的不认（照错的写法去找「动手以前的样子」会找到它今晚写的）。
 * 领导交题时核出处、贴给领导看的原文、改标准答案的证据，都走这一个
 */
export function outsidePath(raw: string, day: string, root: string): string | null {
  const p = raw.trim();
  if (!p || p.includes("\0") || isAbsolute(p)) return null;
  const segs0 = p.split("/");
  if (segs0.includes("..")) return null;
  const segs = segs0.filter((x) => x && x !== ".");
  if (!segs.length) return null;
  const path = segs.join("/");
  const zone = foldPath(segs[0]!) === "sleep";
  const input = `sleep/${day}/input.md`, slices = `sleep/${day}/slices`;
  if (zone && path !== input && !path.startsWith(`${slices}/`)) return null;
  const at = landsAt(join(root, path));
  if (insidePath(at, landsAt(join(root, "sleep")))) {
    if (!zone || !(insidePath(at, landsAt(join(root, input))) || insidePath(at, landsAt(join(root, slices))))) return null;
  }
  if (!zone) {
    const proposed = join(root, "sleep", day, "proposed");
    if (!spelledAsOnDisk(proposed, segs) || !insidePath(landsAt(join(proposed, path)), landsAt(proposed))) return null;
  }
  return path;
}

/** 配置里的换算系数（缺的用默认） */
export function sleepWeights(w: Partial<Weights> | undefined): Weights {
  return { ...DEFAULT_WEIGHTS, ...w, model: { ...DEFAULT_WEIGHTS.model, ...w?.model } };
}

/**
 * 回放的命令（flow.json 的 replayPrep、replayFinish）里的占位符：{day} 那一天；{sleepAt} 那一夜睡下的时刻（nightWindow 的开头，
 * 考试也照它）；{wakeAt} 她第二天一开始的那一刻（nextDayStart，考场拼中期视图照的那一刻）。时刻是 ISO（UTC）。别的花括号原样
 */
export function replayArgs(argv: string[], at: { day: string; tz: string; nightSleep: string }): string[] {
  const sleepAt = new Date(nightWindow(at.day, at.tz, at.nightSleep).from).toISOString();
  const wakeAt = new Date(nextDayStart(at.day, at.tz, at.nightSleep)).toISOString();
  return argv.map((a) => a.replaceAll("{day}", at.day).replaceAll("{sleepAt}", sleepAt).replaceAll("{wakeAt}", wakeAt));
}

/** personas：写了 personasFile 才有（多人模式）；common：engine 是 team 才有（专员和领导的开头 = 核心的基础块 + 它） */
export interface NightPlan { flow: FlowConfig; prefix: string; hash: string; personas?: Personas; common?: string }

/** 读这一夜的流程：有 plan 就跑引擎；没有就是旧的整理，why 说为什么（quiet = 本来就该走旧的，不算出错） */
export type NightRead =
  | { plan: NightPlan; source: "file" | "last-good"; problems: string[] }
  | { plan: null; why: string; quiet: boolean; problems: string[] };

export function readNight(o: { cfg: Config; read(p: string): string | null; write(p: string, s: string): void }): NightRead {
  const W = o.cfg.workspace;
  const sc = o.cfg.sleep;
  const r = loadFlow({
    file: join(W, sc.flowFile), lastGood: join(o.cfg.stateDir, sc.lastGood),
    known: { tools: new Set(SLEEP_HH_TOOLS), builtins: new Set(SLEEP_BUILTINS), memWriters: new Set(MEM_STORE_WRITERS) },
    read: o.read, write: o.write,
  });
  if (!r.flow) {
    return r.problems.length
      ? { plan: null, why: S.host.flowBroken, quiet: false, problems: r.problems }
      : { plan: null, why: S.host.noFlow, quiet: true, problems: [] };
  }
  if (r.flow.engine !== "flow" && r.flow.engine !== "team") return { plan: null, why: "engine legacy", quiet: true, problems: r.problems };
  const text = (p: string): string | null => { try { const t = o.read(join(W, p)); return t?.trim() ? t : null; } catch { return null; } };
  const soul = text(sc.soulFile);
  if (soul === null) return { plan: null, why: S.host.missingFile(sc.soulFile), quiet: false, problems: r.problems };
  const common = text(sc.commonFile);
  if (common === null) return { plan: null, why: S.host.missingFile(sc.commonFile), quiet: false, problems: r.problems };
  // 开着的 agent 段的 skill 页都得在（核依据没有 skill 页，不用查）：缺一页就今晚走旧的整理，别开到一半才发现
  // engine 是 team：领导的 skill 页也一样
  const missing = [
    ...r.flow.stages.filter((s) => s.kind === "agent" && s.enabled && s.skill).map((s) => s.skill!),
    ...(r.flow.team ? [r.flow.team.lead.skill] : []),
  ]
    .map((s) => join(dirname(sc.flowFile), s))
    .filter((p) => text(p) === null);
  if (missing.length) return { plan: null, why: S.host.missingSkills(missing.join(S.marks.listSep)), quiet: false, problems: r.problems };
  // 有段要考试，基础块却一块都读不到：考生没有「醒着的她」可当，今晚走旧的整理
  // （engine 是 team：没有哪段配 exam，但每个专员都要考前后两场，一样要）
  if ((examStages(r.flow).length || r.flow.engine === "team") && r.flow.exam.baseBlocks.every((p) => text(p) === null)) {
    return { plan: null, why: "exam base blocks missing", quiet: false, problems: r.problems };
  }
  // 多人模式：personas 跟 flow.json 放在一起；没有、坏了、点名的人不在里面，今晚走旧的整理（跟缺 common 一样）
  let personas: Personas | undefined;
  if (r.flow.personasFile) {
    const file = join(dirname(sc.flowFile), r.flow.personasFile);
    const t = text(file);
    if (t === null) return { plan: null, why: S.host.missingFile(file), quiet: false, problems: r.problems };
    let raw: unknown;
    try { raw = JSON.parse(t); } catch { return { plan: null, why: S.host.notJson(file), quiet: false, problems: r.problems }; }
    const p = parsePersonas(raw);
    const bad = p.personas ? personaProblems(r.flow, p.personas) : p.problems;
    if (!p.personas || bad.length) return { plan: null, why: S.host.unusable(file), quiet: false, problems: [...r.problems, ...bad] };
    personas = p.personas;
  }
  // engine 是 team：plan 另带 common（专员和领导的开头 = 核心的基础块 + 它）
  const teamCommon = r.flow.engine === "team" ? { common: [common.trimEnd(), languageLine(o.cfg.writingLanguage)].filter(Boolean).join("\n\n") } : {};   // 语言那一句也跟着（跟 flow 的前缀一样）
  // 哈希：不是多人模式时跟以前一样只算流程
  const hash = createHash("sha256").update(JSON.stringify(personas ? [r.flow, personas] : r.flow)).digest("hex").slice(0, 16);
  // 前缀 = 她的 SOUL + 整理的共同规矩 + 她用的语言那一句（和运行说明里的同一句；没配就没有，final-review F-5）。哈希不算它
  const prefix = [soul.trimEnd(), common.trimEnd(), languageLine(o.cfg.writingLanguage)].filter(Boolean).join("\n\n");
  return { plan: { flow: r.flow, prefix, hash, ...(personas ? { personas } : {}), ...teamCommon }, source: r.source === "last-good" ? "last-good" : "file", problems: r.problems };
}

/** Brain 给夜里引擎的：它自己的这些能力，不多给 */
export interface NightBrain {
  cfg: Config;
  driver: KernelDriver;
  db: Db;
  log: Logger;
  mem: EventMemory | null;
  /** 根是工作区 */
  fs: MiniFs;
  run: Runner;
  readText(p: string): string | null;
  /** 和事件库同一个钟（批次开的时刻要和引擎记的「准备完」比） */
  now(): number;
  later(fn: () => void, ms: number): () => void;
  /**
   * 一个会话的 HH 工具：names 是当晚的并集，定义每个会话一字不差，handler 绑在 id 上（事件库写进这个 id 的批）；
   * 给了 mem 就用它（考整理前：开在事件库拷贝上的那个），不给用 Brain 自己的
   */
  hhTools(id: string, names: readonly string[], mem?: EventMemory): ToolDef[];
  /** 这一天报告最上面要加的几行（Brain 记着的，比如把关结论回来时那一段已经关了） */
  dayNotes?(day: string): string[];
  /** 在事件库拷贝（path）上开一个只读的事件记忆（向量服务、时区、人物卡跟 Brain 的一样）；没有事件记忆给 null */
  memAt?(path: string): { mem: EventMemory; close(): void } | null;
}

/** 开着的段会话：learn_check 的结论交回发起的那一段 */
export interface LiveStage {
  /** 交去把关、还没回来的有几份：大于 0 时它这一轮结束了不算「没交」，等结论叫醒它再算 */
  checks: number;
  /** stage_done 收下了：之后不再收它交去把关（learn_check） */
  handedIn: boolean;
  wake(text: string): void;
  close(): Promise<void>;
}

export interface NightHosts {
  stage: StageHost;
  audit: AuditHost;
  /** 考试（有段配了 exam、或者 engine 是 team 才有）；coreOpening：给一句头，下面是整理之前的基础块（专员、领导的开头用） */
  exam: (ExamHost & {
    coreOpening(head: string): string;
    /**
     * 今晚都整理完她醒来看到的开头（固定要问的题那一场用），每次现读、不走一天一份的缓存：
     * built = 回放里落地那几步已经在工作区里拼过了，照工作区现在的；不然基础块有今晚的提案就用提案里的，没有用工作区的
     */
    wakeOpening(day: string, built: boolean): string;
    /**
     * 一条从今晚的改动以外来的出处的原文（领导核标准答案、撤题的证据、「出处得从改动以外来」都照它）：
     * #N / c:N 是中央记忆那一行（central）；q编号是那句原话（quote）；路径:行（或起-止）是那几行（path）——
     * 工作区的文件照这个专员动手前的样子读（before 快照里有照快照，没有照工作区）；sleep/ 下面只认当天的材料
     * （sleep/<日>/input.md、sleep/<日>/slices/…），别的一律不认（引擎抄的那份改动、提案目录都是今晚的改动本身）；
     * 绝对路径、带 .. 的不认。事件库的编号、读不出来的给 null
     */
    rawSource(ref: string, x: { day: string; before: Snapshot; writes?: string[] }): { kind: "central" | "quote" | "path"; text: string } | null;
  }) | null;
  /** 领导（engine 是 team 才有） */
  lead: LeadHost | null;
  /** 交叉审（多人模式才有） */
  review: ReviewHost | null;
  /** 前额叶（配了 coordinator 才有） */
  coord: CoordHost | null;
  /** 题库（考试的验证器、全天考试也用这一个） */
  bank: Bank;
  /** 开着的段会话（id → 它）；会话结束就拿掉 */
  live: Map<string, LiveStage>;
  /** 开着的全部会话（段的、核依据的、考试的）；会话结束就拿掉 */
  sessions: Map<string, StageSession>;
  /** 当晚的工具并集（HH 工具名） */
  union: string[];
  /**
   * 收摊（hhd 停机、Brain 的兜底看门狗）：开着的会话全关，之后不再开新会话（开就抛错）、不再跑脚本。
   * 先让 runner abort，再调这个：关掉的会话 runner 才会当作中止，不当作没过
   */
  shut(): Promise<void>;
}

/**
 * 专员 + 领导模式的领导：一天一个会话（lead-<日>：落地会换基础块，一夜开一个的话后面几天的开头就不是那天整理之前的样子了）。
 * 开头、工具清单跟专员一字不差（同一个模型的吃同一份缓存），角色写在叫醒它的第一条消息里；
 * 只读：能读文件、翻原话和事件，不能写文件、跑脚本、写事件库
 */
export interface LeadHost {
  open(o: { id: string; model: string; timeoutMs: number }): StageSession & { onReview(fn: (r: LeadReview) => string): void; onVerdict(fn: (v: LeadVerdict) => string): void };
}
/** 领导的会话 id */
export const leadId = (day: string, stage?: string): string => (stage ? `lead-${day}-${stage}` : `lead-${day}`);
/** 领导放行的 HH 工具：翻原话、翻事件（跟核依据一样），加上想起事情的那几个；交差的两个工具由 tools.ts 的 team 工具接上 */
export const LEAD_ALLOWED: readonly string[] = [...new Set([...AUDIT_HH_TOOLS, ...SEARCH_TOOLS, "lead_review", "lead_verdict"])];

/** 交去把关还没回来就交差：不收（学习那边的复查 ①：结论回来照着写完提案再交） */
export const CHECKS_OUT = (n: number): string => S.host.checksOut(n);
/** 交差收下以后再交把关：不收（结论回来时这一段已经交了，没人照着写） */

/** nightHosts 的选项：花费表、核依据时限；考试夜（有段配了 exam）还要省钱阶梯和缓存核实（一夜一个，跟 runner 一起建） */
export interface NightOpts {
  budget: Budget;
  weights: Weights;
  auditMs: number;
  /** 省钱阶梯现在这一级：cheap 时核依据也用 sonnet。不给 = 不省 */
  ladder?: () => LadderPlan;
  /** 考试会话的缓存核实（ladder.ts 的 examCacheCheck()） */
  cache?: { seen(id: string, u: StageUsage): string | null };
  /** team：专员的会话最多留多久（整夜的看门狗时长）；不给 = 照段的 budget.minutes */
  holdMs?: number;
  /** 段外的会话（核依据、交叉审、考试、前额叶）花了多少：会话 id 和单位，跟加进 budget 的一样（runner 按 id 记到各段头上） */
  charge?: (id: string, units: number) => void;
  /** 这一天过了的各段的记录（runner.passed）：引擎自己拼的材料（tonight-events、handoff）要看。不给 = 这两份是空的 */
  passed?: (day: string) => Array<{ stage: string; record: StageRecord }>;
}

/** 引擎自己拼的材料名：不读 slices/ */
export const ENGINE_MATERIALS = ["tonight-events", "handoff"] as const;

/**
 * 引擎拼的两份材料。tonight-events = 今晚过了的各段提交的 sleep:<日>/<段>/<第几次> 批里写的经过，按事件分组；
 * handoff = 前面过了的各段交差时写的毛病、拿不准、提案，按段分组。不是这两个名字给 null
 */
export function engineMaterial(name: string, o: {
  day: string;
  stage?: string;
  passed: Array<{ stage: string; record: StageRecord }>;
  store: Pick<EventStore, "batchState" | "ops" | "event" | "entry" | "entryPeople"> | null;
}): string | null {
  if (name === "handoff") {
    // 同一段过了两次（全天考试叫重做）：并成一节，条目去重
    const byStage = new Map<string, string[]>();
    for (const { stage, record: r } of o.passed) {
      if (stage === o.stage) continue;
      const lines = byStage.get(stage) ?? [];
      for (const l of [...r.bugs.map((x) => S.host.bugLine(x)), ...r.uncertain.map((x) => S.host.uncertainLine(x)), ...r.proposals.map((x) => S.host.proposalLine(x))]) if (!lines.includes(l)) lines.push(l);
      byStage.set(stage, lines);
    }
    const parts = [...byStage].filter(([, l]) => l.length).map(([stage, l]) => `## ${stage}\n${l.join("\n")}`);
    return parts.length ? parts.join("\n\n") : S.host.noNotes;
  }
  if (name !== "tonight-events") return null;
  if (!o.store) return S.host.noStoreTonight;
  const byEvent = new Map<string, Map<string, { full: string; gist: string; source: string; who: string; corrects: string | null }>>();
  const moved: string[] = [];
  const title = (id: string): string => `${id} ${o.store!.event(id)?.title ?? ""}`.trimEnd();
  const json = (t: string | null): Record<string, unknown> | null => { try { return t ? (JSON.parse(t) as Record<string, unknown>) : null; } catch { return null; } };
  for (const { stage, record: r } of o.passed) {
    if (r.day !== o.day) continue;
    const batch = `sleep:${o.day}/${stage}/${r.attempt}`;
    if (o.store.batchState(batch) !== "committed") continue;
    const splits = new Set<string>();
    for (const op of o.store.ops(batch)) {
      if (op.tbl === "mem_event") {
        const bf = json(op.before), af = json(op.after);
        if (!af) continue;
        const id = String(af.id);
        if (op.op === "event_create") moved.push(S.host.created(title(id), af.stance ? S.host.stanceNote(String(af.stance)) : ""));
        else if (op.op === "event_update" && bf) {
          const ch = [["summary", S.host.field.summary], ["gist", S.host.field.gist], ["importance", S.host.field.importance], ["stance", S.host.field.stance]].filter(([k]) => (bf[k!] ?? null) !== (af[k!] ?? null))
            .map(([k, n]) => (k === "summary" || k === "gist") ? n! : S.host.fieldChange(n, String(bf[k!] ?? S.marks.nothing), String(af[k!] ?? S.marks.nothing)));
          if (af.status === "retired" && bf.status !== "retired") ch.push(S.host.retiredWord);
          if (ch.length) moved.push(S.host.updated(title(id), ch.join(S.marks.clauseSep)));
        }
        else if (op.op === "merge" && af.status === "superseded" && af.superseded_by) moved.push(S.host.merged(title(id), title(String(af.superseded_by))));
        else if (op.op === "supersede" && af.superseded_by) moved.push(S.host.superseded(title(id), title(String(af.superseded_by))));
        else if (op.op === "retire") moved.push(S.host.retired(title(id)));
        continue;
      }
      if (op.op === "split" && op.tbl === "mem_entry") {
        const bf = json(op.before), af = json(op.after);
        if (bf && af && bf.event_id !== af.event_id) splits.add(S.host.split(title(String(bf.event_id)), title(String(af.event_id))));
        continue;
      }
      if (op.tbl !== "mem_entry" || !op.after || (op.op !== "entry_add" && op.op !== "entry_correct")) continue;
      let id = "";
      try { id = String((JSON.parse(op.key) as { id?: string }).id ?? ""); } catch { /* 下面跳过 */ }
      const e = id ? o.store.entry(id) : undefined;
      if (!e) continue;   // 之后被撤回、并走了
      const m = byEvent.get(e.event_id) ?? new Map();
      let src = e.source;
      try { src = (JSON.parse(e.source) as string[]).join(S.marks.listSep); } catch { /* 原样 */ }
      m.set(id, { full: e.full, gist: e.gist, source: src, who: o.store.entryPeople(id).join(S.marks.listSep), corrects: e.corrects ?? null });
      byEvent.set(e.event_id, m);
    }
    moved.push(...splits);
  }
  if (!byEvent.size && !moved.length) return S.host.nothingWrittenYet;
  const entries = byEvent.size ? [...byEvent].map(([ev, m]) => {
    const row = o.store!.event(ev);
    const head = `## ${ev} ${row?.title ?? ""}`.trimEnd();
    return `${head}\n${[...m].map(([id, x]) => S.host.entry(id, x.full, x.gist, x.who || S.host.notTagged, x.source || S.marks.none, x.corrects ? S.host.corrects(x.corrects) : "")).join("\n")}`;
  }).join("\n\n") : S.host.nothingWritten;
  return moved.length ? S.host.withMoved(entries, moved.join("\n")) : entries;
}

/** 一个会话上交差、考试那几个工具交给谁（谁没设就回「这个会话不用交这个」） */
interface Handlers {
  done?: (d: StageDone) => string;
  audit?: (a: AuditDone) => string;
  questions?: (q: QuestionsIn) => string | Promise<string>;
  answers?: (a: ExamAnswers) => string;
  grades?: (g: ExamGrades) => string;
  review?: (r: ReviewDone) => string;
  coordinate?: (c: CoordinateIn) => string;
  leadReview?: (r: LeadReview) => string;
  leadVerdict?: (v: LeadVerdict) => string;
}

export function nightHosts(b: NightBrain, plan: NightPlan, o: NightOpts): NightHosts {
  const W = b.cfg.workspace;
  const log = b.log.child("sleep");
  /** 专员 + 领导（engine: "team"）：没有哪段配 exam，但每个专员都考前后两场，考试那一套（考场、题库、事件库拷贝）一样要 */
  const leadNight = plan.flow.engine === "team";
  // team 的开头 = 核心的基础块 + common：plan 里没带 common 就不开这一夜（不拿短一截的开头凑合）
  if (leadNight && !plan.common?.trim()) throw new Error(S.host.teamNoCommon);
  const examNight = examStages(plan.flow).length > 0 || leadNight;
  /** 多人模式（personas）、前额叶（coordinator）：有才把它们的交差工具放进每个会话的清单（没有的夜清单照旧） */
  const teamNight = !!plan.personas;
  const coordNight = !!plan.flow.coordinator;
  // 考试夜：考生查得到那一层要的想起事情的工具也进并集（各段的会话里有，guard 照这一段的 tools 拦）
  const union = [...new Set([...plan.flow.stages.flatMap((s) => s.tools), ...AUDIT_HH_TOOLS, ...(examNight ? SEARCH_TOOLS : [])])].sort();
  const live = new Map<string, LiveStage>();
  const sessions = new Map<string, StageSession>();
  const bank = new Bank(b.db, b.now);
  /** 引擎自己要加在各天报告最上面的（事件库没拷成、考试会话没吃到缓存） */
  const notes = new Map<string, string[]>();
  const note = (day: string, line: string): void => { notes.set(day, [...(notes.get(day) ?? []), line]); };
  let shut = false;
  const deps = {
    driver: b.driver, cwd: W, permissionMode: b.cfg.kernel.permissionMode, env: kernelEnv(b.cfg), claudeExecutable: b.cfg.kernel.claudeExecutable,
    render: { maxItemChars: b.cfg.limits.maxItemChars, timezone: b.cfg.schedule.timezone },
    now: b.now, later: b.later, log,
  };
  const tierOf = (m: string): Model => (TIERS.includes(m as Model) ? (m as Model) : "opus");

  /**
   * 开一个会话：工具 = 并集 + 交差工具（考试夜再加三个考试工具），交给谁绑在这个会话上（on 里设）；
   * 开头默认是 SOUL + common，考试的会话给的是考场开头；mem 给了，这个会话的事件库工具读它
   */
  const open = (id: string, tier: Model, x: {
    allowed: ReadonlySet<string>; proposedRoot: string; writes: string[]; bash: string[]; timeoutMs: number;
    prefix?: string; mem?: EventMemory; writeLock?: () => string | undefined; readDeny?: (tool: string, input: Record<string, unknown>) => string | undefined; roleText?: string;
  }) => {
    if (shut) throw new Error(S.host.nightClosed);
    const on: Handlers = {};
    const tools = [
      ...b.hhTools(id, union, x.mem),
      // affects 只在考试夜带（不考试的夜工具定义照旧）
      stageDoneTool((d) => (on.done ? on.done(d) : S.host.notHere), { affects: examNight }),
      auditDoneTool((a) => (on.audit ? on.audit(a) : S.host.notHere)),
      ...(examNight ? [
        examQuestionsTool((q) => (on.questions ? on.questions(q) : S.host.notHere)),
        examAnswersTool((a) => (on.answers ? on.answers(a) : S.host.notHere)),
        examGradesTool((g) => (on.grades ? on.grades(g) : S.host.notHere)),
      ] : []),
      ...(teamNight ? [reviewDoneTool((r) => (on.review ? on.review(r) : S.host.notHere))] : []),
      ...(coordNight ? [coordinateTool((c) => (on.coordinate ? on.coordinate(c) : S.host.notHere))] : []),
      // team：领导的两个交差工具每个会话的清单里都有（清单一字不差），只有领导的会话放行、接得上
      ...(leadNight ? [
        leadReviewTool((r) => (on.leadReview ? on.leadReview(r) : S.host.notHere)),
        leadVerdictTool((v) => (on.leadVerdict ? on.leadVerdict(v) : S.host.notHere)),
      ] : []),
    ];
    const sess = openStageSession(deps, {
      id, model: modelFor(b.cfg, tier), prefix: x.prefix ?? (leadNight ? teamPrefix() : plan.prefix), tools, workspace: W,
      allowed: x.allowed, proposedRoot: x.proposedRoot, writes: x.writes, bash: x.bash, timeoutMs: x.timeoutMs,
      ...(x.writeLock ? { writeLock: x.writeLock } : {}),
      ...(x.readDeny ? { readDeny: x.readDeny } : {}),
      ...(x.roleText !== undefined ? { roleText: x.roleText } : {}),
      // team：内核会话真开的时候，把发给模型的那些东西各记一个短哈希（sleep/cachekey.ts，照内核真拿到的 spec 算）：
      // 领导和同一个模型的专员要是哪样不一样，开头的缓存就共用不了
      ...(leadNight ? { onSpec: (spec: SessionSpec) => {
        const role = id.startsWith("lead-") ? "lead" : id.startsWith("sleep-") ? "specialist" : "exam";
        // 专员的：开头各部分多大（核心的基础块、common、它的页、材料各片；字数）
        const m = role === "specialist" ? /^sleep-(\d{4}-\d{2}-\d{2})-(.+)-\d+$/.exec(id) : null;
        const mine = m ? openingParts.get(`${m[1]}/${m[2]}`) : undefined;
        const common = plan.common?.length ?? 0;
        log.info("sleep: session spec", {
          id, role, systemChars: spec.systemAppend.length, tools: spec.tools.length, key: cacheKeyOf(spec),
          ...(mine ? { parts: { core: spec.systemAppend.length - common - (common ? 2 : 0), common, page: mine.page, slices: mine.slices } } : {}),
        });
      } } : {}),
    });
    sessions.set(id, sess);
    // team：每一轮记一行——第一次调用读写了多少缓存、之前闲了多久（M1 要量：闲一阵以后缓存还在不在）
    if (leadNight) {
      const role = id.startsWith("lead-") ? "lead" : id.startsWith("sleep-") ? "specialist" : "exam";
      sess.onTurnEnd((_ok, _e, _u, t) => {
        if (!t) return;
        // 每个会话头一轮：开头多大（第一次调用的输入：没进缓存的 + 读缓存的 + 写缓存的；内核没报就空着）记到这一天的记录里，回放的 compare.md 列出来
        if (t.turn === 1) {
          const day = /\d{4}-\d{2}-\d{2}/.exec(id)?.[0];
          if (day) {
            try {
              const path = `sleep/${day}/flow/lead/sessions.json`;
              const cur = JSON.parse(b.fs.read(path) ?? "[]") as unknown[];
              cur.push({ id, role, opening: t.first ? t.first.input + t.first.cacheRead + t.first.cacheWrite : null });
              b.fs.write(path, JSON.stringify(cur, null, 2));
            } catch (e) { log.warn("sleep: recording the session's opening size failed", { id, error: msg(e).slice(0, 200) }); }
          }
        }
        log.info("sleep: turn cache", {
          id, role, model: modelFor(b.cfg, tier), turn: t.turn, idleSec: Math.round(t.idleMs / 1000),
          firstCacheRead: t.first?.cacheRead ?? null, firstCacheWrite: t.first?.cacheWrite ?? null, firstInput: t.first?.input ?? null,
          calls: t.calls, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, input: t.input,
        });
      });
    }
    const gone = (): void => { if (sessions.get(id) === sess) sessions.delete(id); };
    sess.settled.then(gone, gone);
    return { sess, on };
  };

  // ---------- 整理前的事件库拷贝 ----------

  const scratch = resolve(b.cfg.stateDir, b.cfg.sleep.examScratch);
  /**
   * 拷贝目录不是它自己的一个目录（就是 stateDir、就是库所在的目录、在工作区里）：开跑前不清、也不往里拷
   * （清的时候会碰到 hh.db 这些；工作区是她的 git 仓库）
   */
  const scratchProblem = !examNight ? null : ((): string | null => {
    const dbDirs = [b.db, b.mem?.store.db].flatMap((d) => { const at = d?.location(); return at ? [dirname(resolve(at))] : []; });
    if (scratch === resolve(b.cfg.stateDir) || dbDirs.includes(scratch)) return S.host.scratchIsState(scratch);
    if (within(resolve(W), scratch)) return S.host.scratchInWorkspace(scratch);
    return null;
  })();
  if (scratchProblem) log.warn("sleep: exam scratch dir is not a dir of its own, no sweep and no copies", { dir: scratch, why: scratchProblem });
  /** 这一天这一段（day/stage）现在的拷贝路径 */
  const copies = new Map<string, string>();
  /** 正在拷的（day/stage → 这一次的记号）：拷完时记号换了（这一次已经收了），拷出来的就删掉 */
  const copying = new Map<string, object>();
  const removeCopy = (path: string): void => {
    for (const f of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
      try { rmSync(f, { force: true }); } catch (e) { log.warn("sleep: removing an event-store copy failed", { path: f, error: msg(e).slice(0, 200) }); }
    }
  };
  const dropCopy = (key: string): void => {
    copying.delete(key);
    const path = copies.get(key);
    if (path === undefined) return;
    copies.delete(key);
    removeCopy(path);
  };
  const dropDay = (day: string): void => { for (const key of new Set([...copies.keys(), ...copying.keys()])) if (key.startsWith(`${day}/`)) dropCopy(key); };
  const dropAll = (): void => { for (const key of new Set([...copies.keys(), ...copying.keys()])) dropCopy(key); };
  /**
   * 注入预览的草稿目录（final fix M5）：在拷贝目录下（stateDir 里，不在工作区）；拷贝目录不是它自己的一个目录时用系统临时目录。
   * 每次预览写 <日>/<段>/<状态>/，用完就删
   */
  const previewRoot = scratchProblem ? join(tmpdir(), `hh-exam-preview-${process.pid}`) : join(scratch, "preview");
  /** 考试夜开跑前：上次崩了留下的拷贝全清掉（只清拷贝那样起名的文件和预览的草稿目录，别的不动）；不考试的夜不碰这个目录 */
  const sweep = (): void => {
    if (!examNight || scratchProblem) return;
    try { rmSync(previewRoot, { recursive: true, force: true }); } catch (e) { log.warn("sleep: sweeping leftover preview files failed", { dir: previewRoot, error: msg(e).slice(0, 200) }); }
    let left: string[];
    try { left = readdirSync(scratch); } catch { return; }
    const old = left.filter((f) => COPY_NAME.test(f));
    for (const f of old) {
      try { rmSync(join(scratch, f), { force: true }); } catch (e) { log.warn("sleep: sweeping a leftover event-store copy failed", { file: f, error: msg(e).slice(0, 200) }); }
    }
    if (old.length) log.info("sleep: swept leftover event-store copies", { dir: scratch, files: old.length });
  };
  sweep();

  /** 库文件多大（含 -wal）；内存里的库（测试）按页数算 */
  const dbBytes = (db: Db): number => {
    const at = db.location();
    if (!at) {
      const n = one<{ n: number }>(db, "SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()");
      return n?.n ?? 0;
    }
    const size = (f: string): number => { try { return statSync(f).size; } catch { return 0; } };
    return size(at) + size(`${at}-wal`);
  };
  const mb = (n: number): string => `${Math.round(n / 1_048_576)}MB`;
  /** 拷一份：node:sqlite 的 backup（异步，一步步拷，不卡住事件循环）；没有它或者它没拷成，退回 VACUUM INTO */
  const copyTo = async (db: Db, path: string): Promise<void> => {
    if (typeof sqlite.backup === "function") {
      try { await sqlite.backup(db, path); return; } catch (e) {
        removeCopy(path);
        log.warn("sleep: event-store backup failed, trying VACUUM INTO", { path, error: msg(e).slice(0, 200) });
      }
    }
    db.prepare("VACUUM INTO ?").run(path);
  };

  /**
   * 这一段动手前把事件库拷一份，放在 stateDir 下的 examScratch（工作区是她的 git 仓库，不放那里）。
   * 拷贝目录不对、剩余空间不到库文件（含 -wal）的 examMinFree 倍、或者拷不成：不拷，记 warn，报告最上面写一句，
   * 整理前补考用现在的事件库。拷的时候这一次结束了（attemptEnded、撤回、收摊）：拷出来的删掉，不记
   */
  const copyBefore = async (day: string, stage: StageSpec, attempt: number): Promise<void> => {
    const key = `${day}/${stage.id}`;
    dropCopy(key);
    const db = b.mem?.store.db;
    if (!db) return;
    const path = join(scratch, `${day}-${stage.id}-${attempt}.db`);
    const mark = {};
    copying.set(key, mark);
    let why: string;
    try {
      if (scratchProblem) throw new Error(scratchProblem);
      mkdirSync(scratch, { recursive: true });
      const need = b.cfg.sleep.examMinFree * dbBytes(db);
      const fs = statfsSync(scratch);
      const free = fs.bavail * fs.bsize;
      if (free < need) why = S.host.noSpace(mb(free), mb(need));
      else {
        removeCopy(path);
        await copyTo(db, path);
        if (copying.get(key) !== mark) { removeCopy(path); return; }
        copying.delete(key);
        copies.set(key, path);
        log.info("sleep: event store copied for the before exam", { day, stage: stage.id, attempt, path });
        return;
      }
    } catch (e) {
      removeCopy(path);
      why = S.host.cannotCopy(msg(e).slice(0, 200));
    }
    if (copying.get(key) !== mark) return;
    copying.delete(key);
    log.warn("sleep: no event-store copy before the stage, the before exam uses the live store", { day, stage: stage.id, attempt, why });
    note(day, P.SLEEP_LIVE_BEFORE(stage.title, why));
  };

  // ---------- 出处、交题 ----------

  /**
   * 出处查得到吗：#序号或 c:序号（中央记忆）、q编号（原话层）、e / n / t / i 编号（事件库：事件、经过、人和东西、印象）、路径:行；别的写法不认。
   * 路径：先看今天的提案（前面几段过了的改动在那里），没有再看工作区；验证时考整理前（给了 files = 这一段开始时的样子）
   * 最先看它——这一段改过的文件以它开始时为准；它管不到的文件不在里面，提案里的是前面几段的改动，正是它的整理前
   */
  const sourceExists = (ref: string, x: { day: string; state: "before" | "after"; files?: Snapshot; writes?: string[] }): boolean => {
    const r = ref.trim();
    try {
      const seq = centralRef(r);
      if (seq !== null) return one(b.db, "SELECT 1 AS x FROM central WHERE seq = ?", seq) !== undefined;
      if (/^q\d+$/.test(r)) return !!b.mem?.index.quote(r);
      if (/^e\d+$/.test(r)) return !!b.mem?.store.event(r);
      if (/^n\d+$/.test(r)) return !!b.mem?.store.entry(r);
      if (/^t\d+$/.test(r)) return !!b.mem?.store.entityById(r);
      if (/^i\d+$/.test(r)) return !!b.mem?.store.impression(r);
      const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(r);
      if (!m) return false;
      const path = m[1]!.trim();
      const line = Number(m[3] ?? m[2]);
      if (!path || isAbsolute(path) || path.split("/").includes("..") || line < 1) return false;
      const text = x.state === "before" && x.files
        ? beforeText(x.day, path, { files: x.files, ...(x.writes ? { writes: x.writes } : {}) })
        : b.fs.read(join("sleep", x.day, "proposed", path)) ?? b.fs.read(path);
      if (text === null) return false;
      return text.replace(/\n$/, "").split("\n").length >= line;
    } catch {
      return false;
    }
  };

  /**
   * 事件库里这个编号顶替了哪些（ExamHost.parentsOf，切换前 P4），一路往前认；只认 at 这一次尝试自己的批里写的（修正轮 M1）：
   * 经过的更正（entry_correct 新建的那条的 corrects）、合并（merge 把被并的那件标成 superseded_by 它，经过搬过来了；
   * supersede 不搬经过，不认）、印象新建的一行顶掉的旧行（supersedes）。查不到、出错给 []
   */
  /** 每一次尝试的批：读到第几条 op 时整理出来的链接（批里多了 op 才重读；修正轮 2 FR-m1） */
  const linkCache = new Map<string, { n: number; links: Map<string, string[]> }>();
  const linksOf = (batch: string): Map<string, string[]> => {
    const st = b.mem!.store;
    const n = st.opCount(batch);
    const hit = linkCache.get(batch);
    if (hit && hit.n === n) return hit.links;
    const links = new Map<string, string[]>();
    const row = (t: string | null): Record<string, unknown> | null => (t ? JSON.parse(t) as Record<string, unknown> : null);
    for (const op of st.ops(batch)) {
      const before = row(op.before), after = row(op.after);
      let from: unknown = null, to: unknown = null;
      if (op.op === "entry_correct" && op.tbl === "mem_entry" && after?.corrects) { from = after.id; to = after.corrects; }
      else if (op.op === "merge" && op.tbl === "mem_event" && after?.status === "superseded" && after.superseded_by && before?.status !== "superseded") { from = after.superseded_by; to = after.id; }
      else if (op.tbl === "mem_impression" && !before && after?.supersedes) { from = after.id; to = after.supersedes; }
      if (typeof from === "string" && typeof to === "string") links.set(from, [...(links.get(from) ?? []), to]);
    }
    linkCache.set(batch, { n, links });
    return links;
  };
  const parentsOf = (id: string, at: { day: string; stage: string; attempt: number }): string[] => {
    if (!b.mem) return [];
    const out: string[] = [];
    try {
      const links = linksOf(stageBatch(at.day, at.stage, at.attempt));
      const seen = new Set([id]);
      for (let frontier = [id]; frontier.length && out.length < 50;) {
        const next: string[] = [];
        for (const x of frontier) for (const p of links.get(x) ?? []) if (!seen.has(p)) { seen.add(p); out.push(p); next.push(p); }
        frontier = next;
      }
    } catch (e) {
      log.warn("sleep: following correction / merge links failed", { id, error: msg(e).slice(0, 200) });
      return [];
    }
    return out;
  };

  /**
   * 考场常驻那层看的中期视图（ExamHost.memory，切换前 P6）：跟她的前缀同一个渲染（renderMidterm），只在她的前缀里本来就有它时
   * （memory.events.midterm）才拼。时刻照整理完那一夜、她第二天一开始（nextDayStart：这一天不再是「今天」，只剩事件那一级的概要，
   * 跟她第二天的前缀一样；修正轮 2 I1；回放、补整理以前的日子都照那一天算）；
   * 整理后用现在的库，整理前用拷贝（开了就关）。前缀里别的从事件库来的东西：没有（人物卡是对话时按人附的，书架来自学习笔记）
   */
  const memoryView = (x: { day: string; state: "after" | "before"; store: string }): string => {
    if (!b.cfg.memory?.events?.midterm || !b.mem) return "";
    const tz = b.cfg.schedule.timezone;
    const now = nextDayStart(x.day, tz, b.cfg.schedule.nightSleep);
    if (x.store === "live") return renderMidterm(b.mem.recall, { now, tz });
    const copy = b.memAt?.(x.store) ?? null;
    if (!copy) throw new Error(S.host.copyUnopenable(x.store));
    try { return renderMidterm(copy.mem.recall, { now, tz }); } finally {
      try { copy.close(); } catch (e) { log.warn("sleep: closing the event-store copy failed", { store: x.store, error: msg(e).slice(0, 200) }); }
    }
  };

  /** 一个文件整理前的内容（beforeContent）：提案是 sleep/<日>/proposed/ 下的，工作区的走 b.fs */
  const beforeText = (day: string, path: string, v: BeforeView): string | null =>
    beforeContent(path, v, { proposed: (p) => b.fs.read(join("sleep", day, "proposed", p)), workspace: (p) => b.fs.read(p) });

  /** 这一天这一段交了的题（暗题不算） */
  const ownPending = (day: string, stage: string): number => bank.pending(day, stage).filter((q) => !q.hidden).length;
  /** 这一天这一段上一次过了的尝试结束时的待定题（那次考过、过了；examPending 给了第几次时不算它们） */
  const examinedOk = new Map<string, Set<string>>();
  /** 每一次尝试开会话时这一段已经有的待定题（那一次没过时只撤它自己交的） */
  const atOpen = new Map<string, Set<string>>();

  /** 交的一道题有什么毛病（没毛病给 null）：questionProblem，出处照整理前看（交题时这一段还锁着，提案就是整理前） */
  const problemOf = (q: QuestionIn, day: string): string | null => questionProblem(q, (r) => sourceExists(r, { day, state: "before" }), isPrivate);
  /** 私密的印象（事件库 mem_impression 的 visibility 不是 all）：不出题、不进题库（题库和判分主人看得到） */
  function isPrivate(ref: string): boolean { return /^i\d+$/.test(ref) && (b.mem?.store.impression(ref)?.visibility ?? "all") !== "all"; }

  /**
   * 段交题：合格的存成待定（这一段最多 max 道），改题、退休记成 op（记下是第几次尝试）；返回回话和这一段现在一共几道。
   * only：交的 stage_done 被退回以后（切换前 P2）只收挂在退回点名的那几处上的题，不收改题、退休；没退回过是 null
   */
  const takeQuestions = (day: string, stage: StageSpec, exam: StageExam, x: QuestionsIn, attempt: number, only: string[] | null = null): { reply: string; total: number } => {
    const have = ownPending(day, stage.id);
    const refused: string[] = [];
    const ok: QuestionIn[] = [];
    x.questions.forEach((q, i) => {
      const name = S.lead.itemName(i + 1, String(q.q ?? "").slice(0, 30));
      const why = problemOf(q, day);
      if (why) refused.push(S.marks.labeled(name, why));
      else if (only && !only.some((t) => hangsOn(q, t, (id) => parentsOf(id, { day, stage: stage.id, attempt })))) refused.push(S.marks.labeled(name, P.QUESTION_REFUSED.notNamed(only)));
      else if (have + ok.length >= exam.max) refused.push(S.marks.labeled(name, P.QUESTION_REFUSED.full(exam.max)));
      else ok.push(q);
    });
    const ids = ok.length ? bank.addPending(day, stage.id, ok) : [];
    let ops = 0;
    const op = (kind: "revise" | "retire", id: string, add: () => void): void => {
      if (only) { refused.push(S.host.opRefused(kind, id, P.QUESTION_REFUSED.afterBounce)); return; }
      const cur = bank.get(id);
      if (!cur || (cur.status !== "active" && cur.status !== "pending")) { refused.push(S.host.opRefused(kind, id, P.QUESTION_REFUSED.unknown)); return; }
      try { add(); ops += 1; } catch (e) { refused.push(S.host.opRefused(kind, id, msg(e))); }
    };
    for (const r of x.revise) op("revise", r.q, () => bank.addOp(day, stage.id, { kind: "revise", q: r.q, gold: r.gold, why: r.why }, attempt));
    for (const r of x.retire) op("retire", r.q, () => bank.addOp(day, stage.id, { kind: "retire", q: r.q, why: r.why }, attempt));
    if (refused.length) log.info("sleep: some submitted questions refused", { day, stage: stage.id, taken: ids.length, refused: refused.length });
    return { reply: P.SLEEP_QUESTIONS_TAKEN(ids.length, ids, refused) + (ops ? P.SLEEP_QUESTION_OPS(ops) : ""), total: have + ids.length };
  };

  /** 上一次拼材料时各片多大；team 的夜里每一段第一条消息里的页、材料各片多大（<日>/<段> → …） */
  const sliceSizes = new Map<string, number>();
  const openingParts = new Map<string, { page: number; slices: Record<string, number> }>();
  const stage: StageHost = {
    flowHash: plan.hash,
    // team：专员的开头是核心的基础块 + common（跟领导一字不差）；要用时才拼（基础块读一次）
    get prefix() { return leadNight ? teamPrefix() : plan.prefix; },
    open(x): OpenedStage {
      const exam = examNight ? x.stage.exam : null;
      // 先交题再动手：交够 min 道才解锁；重做（第 2 次起）这一段已经有够数的题就一开就不锁（题照旧，可以补）。
      // 写事件库的段解锁之前拷一份事件库（这时的库就是整理前：锁着写不进去，重做时上一次的批已经撤回）
      const attempt = Number(x.id.slice(`sleep-${x.day}-${x.stage.id}-`.length)) || 1;
      let unlocked = !exam;
      /** 交的 stage_done 被退回了（切换前 P2）：交题只收挂在退回点名的那几处上的；没退回过是 null */
      let questionsFor: string[] | null = null;
      /** 正在拷整理前的事件库：拷完才解锁 */
      let unlocking: Promise<void> | null = null;
      const unlock = (): Promise<void> => {
        unlocking ??= (x.stage.memWrite ? copyBefore(x.day, x.stage, attempt) : Promise.resolve())
          .catch((e: unknown) => log.warn("sleep: copying the event store before unlocking failed", { id: x.id, error: msg(e).slice(0, 200) }))
          .finally(() => { unlocked = true; });
        return unlocking;
      };
      const { sess, on } = open(x.id, x.stage.model, {
        allowed: exam ? new Set([...x.allowed, "exam_questions"]) : x.allowed,
        proposedRoot: join(W, "sleep", x.day, "proposed"), writes: x.stage.writes, bash: x.stage.bash,
        // team：会话留到这个专员定了（等领导看、考试、再改），时限给整夜的；每一轮做多久由 TeamRunner 管
        timeoutMs: leadNight && o.holdMs ? o.holdMs : x.stage.budget.minutes * 60_000,
        ...(exam ? { writeLock: () => (unlocked ? undefined : unlocking ? P.SLEEP_COPYING : P.SLEEP_LOCKED) } : {}),
      });
      if (exam) {
        // 这一次开始时已经有的待定题：这一次没过，只撤这一次交的（回放第 1 次 F2）
        atOpen.set(`${x.day}/${x.stage.id}/${attempt}`, new Set(bank.pending(x.day, x.stage.id).map((q) => q.id)));
        // 重做（第 2 次起）这一段已经有够数的题：会话开成了就解锁（写事件库的先拷一份）
        if (attempt >= 2 && ownPending(x.day, x.stage.id) >= exam.min) void unlock();
        on.questions = async (q) => {
          const r = takeQuestions(x.day, x.stage, exam, q, attempt, questionsFor);
          if (unlocked || unlocking) { await unlocking; return r.reply; }
          if (r.total < exam.min) return r.reply + P.SLEEP_QUESTIONS_SHORT(exam.min - r.total);
          await unlock();
          return r.reply + P.SLEEP_QUESTIONS_UNLOCKED;
        };
      }
      const ends: Array<(ok: boolean, error?: string, usage?: StageUsage) => void> = [];
      const me: LiveStage = { checks: 0, handedIn: false, wake: (t) => sess.wake(t), close: () => sess.close() };
      live.set(x.id, me);
      const gone = (): void => { if (live.get(x.id) === me) live.delete(x.id); };
      sess.settled.then(gone, gone);
      // 交去把关还没回来、也还没交差：这一轮结束不报给引擎（不然会被催、被算成没交），结论叫醒它的那一轮结束再报
      sess.onTurnEnd((ok, error, usage) => {
        if (ok && me.checks > 0 && !me.handedIn) {
          log.info("sleep: stage ended its turn while the checker is still looking; waiting for the verdicts", { id: x.id, checks: me.checks });
          return;
        }
        for (const f of ends) f(ok, error, usage);
      });
      return {
        id: sess.id, settled: sess.settled,
        wake: (t) => sess.wake(t),
        close: () => sess.close(),
        onTurnEnd: (fn) => { ends.push(fn); },
        // 交去把关的还没回来：不收这次交差（结论回来照着写完提案再交）；超时的那批也会回来（整批没看完），照样叫醒它
        onDone: (fn) => {
          on.done = (d) => {
            if (me.checks > 0) return CHECKS_OUT(me.checks);
            me.handedIn = true;
            return fn(d);
          };
        },
        // 引擎当场核对没过、退回去了：这次不算交差（还能交去把关）；点名了要补题的地方，交题只收挂在它们上面的
        // （只对账、没点名的退回不动交题：修正轮 I3）
        bounced: (o) => {
          me.handedIn = false;
          if (o.questionsFor.length) questionsFor = [...o.questionsFor];
        },
        alive: () => sess.alive(),
      };
    },
    async run(argv, timeoutMs) {
      const [cmd, ...args] = argv;
      if (!cmd) return { code: -1, out: S.host.noCommand };
      if (shut) return { code: -1, out: S.host.scriptsClosed };
      const r = await b.run(PYTHONS.has(cmd) ? b.cfg.tools.python : cmd, args, { cwd: W, timeoutMs });
      return { code: r.code, out: r.stderr.trim() ? `${r.stdout}${r.stdout && !r.stdout.endsWith("\n") ? "\n" : ""}${r.stderr}` : r.stdout };
    },
    fs: b.fs,
    mem: b.mem,
    skillText: (s) => (s.skill ? b.readText(join(W, dirname(b.cfg.sleep.flowFile), s.skill)) : null),
    materialText: (day, names, stage) => {
      sliceSizes.clear();
      // 引擎拼的两份（tonight-events、handoff）和切片可以混着要：各占一块
      const eng = names.filter((n) => (ENGINE_MATERIALS as readonly string[]).includes(n));
      const rest = names.filter((n) => !eng.includes(n));
      const passed = o.passed?.(day) ?? [];
      const sliced = !eng.length ? slices(day, names, stage) : rest.length ? slices(day, rest, stage) : "";
      const built = eng.map((n) => { const t = engineMaterial(n, { day, ...(stage ? { stage: stage.id } : {}), passed, store: b.mem?.store ?? null }) ?? ""; sliceSizes.set(n, t.length); return S.marks.slice(n, t); });
      // team：这一段的第一条消息里材料各片多大（会话真开的时候记进日志那一行）
      if (leadNight && stage) openingParts.set(`${day}/${stage.id}`, { page: (stage.skill ? b.readText(join(W, dirname(b.cfg.sleep.flowFile), stage.skill)) : null)?.length ?? 0, slices: Object.fromEntries(names.filter((n) => sliceSizes.has(n)).map((n) => [n, sliceSizes.get(n)!])) });
      if (!eng.length) return sliced;
      return [...(rest.length ? [sliced] : []), ...built].join("\n\n");
    },
    db: b.db,
    now: b.now,
    later: b.later,
    log,
    dayNotes: (day: string) => [...(b.dayNotes?.(day) ?? []), ...(notes.get(day) ?? [])],
    opsText: (day: string, stageId: string, attempt: number, cap?: number, skip?: number) => (b.mem ? batchDiff(b.mem.store, stageBatch(day, stageId, attempt), cap, b.cfg.schedule.timezone, skip) : S.marks.noStore),
    ...(leadNight ? {
      // team：这一次在事件库里新建的编号（事件、经过、人和东西、印象）：领导出题时，出处全是这些的不算从改动以外来的
      madeIn: (day: string, stageId: string, attempt: number): Set<string> => {
        const made = new Set<string>();
        for (const op of b.mem?.store.ops(stageBatch(day, stageId, attempt)) ?? []) {
          if (op.before !== null || op.after === null) continue;
          try { const id = (JSON.parse(op.key) as { id?: unknown }).id; if (typeof id === "string") made.add(id); } catch { /* 没有 id 的行不算 */ }
        }
        return made;
      },
      // team：编号后面带上一句标题（事件的标题、经过的标题、人和东西的名字）；查不到的只写编号
      idTitles: (ids: string[]): string[] => ids.map((id) => {
        const st = b.mem?.store;
        let t: string | undefined;
        try { t = /^e/.test(id) ? st?.event(id)?.title : /^n/.test(id) ? st?.entry(id)?.title : /^t/.test(id) ? st?.entityById(id)?.name : undefined; } catch { t = undefined; }
        return t ? `${id} ${t}` : id;
      }),
      // team：这一次的批里第 skip 行以后碰过的编号（事件、经过、人和东西、印象；经过挪过的两头的事件也算）：改的那一轮照它挑要重考的题
      touchedIn: (day: string, stageId: string, attempt: number, skip = 0): string[] => {
        const ids = new Set<string>();
        const take = (v: unknown): void => { if (typeof v === "string" && /^[enti]\d+$/.test(v)) ids.add(v); };
        for (const op of (b.mem?.store.ops(stageBatch(day, stageId, attempt)) ?? []).slice(skip)) {
          for (const t of [op.key, op.before, op.after]) {
            if (!t) continue;
            try { const r = JSON.parse(t) as Record<string, unknown>; for (const k of ["id", "event_id", "entry_id", "entity_id", "a", "b", "about", "superseded_by", "parent", "corrects", "supersedes"]) take(r[k]); } catch { /* 读不出来的行不算 */ }
          }
        }
        return [...ids];
      },
      // team：专员的会话一开就拷（不等交题解锁）；这份拷贝留到这个专员定了（attemptEnded）——原地修的几轮都考同一份整理前
      copyBefore: async (day: string, stageId: string, attempt: number): Promise<void> => {
        const s = plan.flow.stages.find((x) => x.id === stageId);
        if (s?.memWrite) await copyBefore(day, s, attempt);
      },
    } : {}),
    ...(examNight ? {
      // 配了 exam 的段：材料后面列出挂在它要改的那几个文件上的旧题（变淡、挪档案的要写 affects，事实变了用 revise）。
      // 只进叫醒它的话：验证器拿到的材料（出暗题的看的）不带旧题和标准答案
      // 挂在它能写的文件上：照 writes 的通配算（matchWrites，排除也算）
      wakeNotes: (_day: string, s: StageSpec) => {
        if (!s.exam) return "";
        const old = bank.where((q) => q.tags.files.some((f) => matchWrites(s.writes, f)), s.exam.old);
        return old.length ? P.SLEEP_OLD_QUESTIONS(old) : "";
      },
      storeBefore: (day: string, s: string) => copies.get(`${day}/${s}`) ?? "live",
      // 这一段这一天待定的题和 op（交的题、改题、退休、改层）：多人模式里没改东西的尝试只有这也是 0 才不验
      examPending: (day: string, s: string, attempt?: number) => {
        if (attempt === undefined) return bank.pending(day, s).length + bank.pendingOps(day, [s]).length;
        // 最终评审 M4：只算这一次记下的 op（没过的那几次的已经丢了），和还没在过了的一次里考过的待定题——
        // 打磨（前一次过了）什么都没改就不再考；没过以后重做的，上一次交的题还没考过，照样要考
        const ok = examinedOk.get(`${day}/${s}`);
        return bank.pending(day, s).filter((q) => !ok?.has(q.id)).length + bank.attemptOps(day, s, attempt);
      },
      // 没过的那一次申请的改题、退休不落地（过了的那次才算数；改层的 op 本来就只在过了时记）
      attemptEnded: (day: string, s: string, passed: boolean, attempt: number) => {
        dropCopy(`${day}/${s}`);
        const had = atOpen.get(`${day}/${s}/${attempt}`);
        atOpen.delete(`${day}/${s}/${attempt}`);
        if (passed) { examinedOk.set(`${day}/${s}`, new Set(bank.pending(day, s).map((q) => q.id))); return; }
        // 回放第 1 次 F2：没过的那一次交的待定题（连它考试出的暗题）撤掉——它们占着这一段的题数上限、挂在撤回了的事件上；
        // 修的人照满额自己出题。这一次开始以前就有的（过了的那一次的）不动
        if (had) {
          const q = bank.dropQuestions(bank.pending(day, s).map((x) => x.id).filter((id) => !had.has(id)));
          if (q) log.info("sleep: a failed attempt's pending questions dropped", { day, stage: s, attempt, questions: q });
        }
        // 改层的 op 平常只在过了时记；多人模式里前额叶可以叫考过了的一次重做，那一次记下的改层也不落地
        const n = bank.dropAttemptOps(day, s, attempt, ["revise", "retire", "layer"]);
        if (n) log.info("sleep: a failed attempt's revise/retire ops dropped", { day, stage: s, attempt, ops: n });
      },
      landed: (day: string, stages: string[]) => {
        dropDay(day);
        // 落地改了基础块：同一夜后面的日子考试用落地了的
        blocks.clear();
        openings.clear();
        // carry: drop 的段没过：这一天不再补它（不记欠着），它的待定题和 op 丢掉（final fix M7）
        const gone = plan.flow.stages.filter((s) => s.kind === "agent" && s.carry === "drop" && !stages.includes(s.id)).map((s) => s.id);
        const dropped = bank.dropPendingOf(day, gone);
        if (dropped) log.info("sleep: landed day's carry-drop stages' pending questions dropped", { day, stages: gone, questions: dropped });
        const n = bank.activate(day, stages);
        log.info("sleep: landed day's questions activated", { day, stages, questions: n });
      },
      abandoned: (day: string, keep: string[]) => {
        dropDay(day);
        const n = bank.dropPending(day, keep);
        if (n) log.info("sleep: abandoned day's pending questions dropped", { day, keep, questions: n });
      },
    } : {}),
  };

  /** 材料：有切片给切片；一片都还没切（sleep_digest 还没切）给整份 input.md */
  function slices(day: string, names: string[], stage?: StageSpec): string {
    if (!names.length) return "";
    const dir = join(W, "sleep", day);
    // team：太长的一片不贴进第一条消息（每一轮都要再付一遍），只写它在哪，用到再读
    const cap = leadNight ? stage?.sliceCap ?? plan.flow.team?.sliceCap ?? SLICE_CAP : Infinity;
    const fit = (text: string, rel: string): string => (text.length > cap ? SLICE_TOO_LONG(rel, text.length) : text);
    const got = names.map((n) => ({ n, text: b.readText(join(dir, "slices", `${n}.md`)) }));
    if (got.every((g) => g.text === null)) {
      // 切片还没有（sleep_digest 还没切，第 3 份之前）：整份材料给它
      const whole = b.readText(join(dir, "input.md"));
      if (whole === null) throw new Error(S.host.noSlices(day));
      log.info("sleep: no slices yet, the stage gets the whole input.md", { day, names });
      return fit(whole, `sleep/${day}/input.md`);
    }
    return got.map((g) => { const t = g.text === null ? S.host.noSlice : fit(g.text, `sleep/${day}/slices/${g.n}.md`); sliceSizes.set(g.n, t.length); return S.marks.slice(g.n, t); }).join("\n\n");
  }

  /**
   * 段外的只读会话（核依据、交叉审、前额叶）：不写文件、不跑脚本；花的算进这一夜的花费（每一轮结束记上这一轮的，结算时补上没报的），
   * 也报给 charge（runner 记到各段头上）
   */
  const side = (id: string, tier: Model, allowed: string[], timeoutMs: number) => {
    const { sess, on } = open(id, tier, { allowed: new Set(allowed), proposedRoot: join(W, "sleep"), writes: [], bash: [], timeoutMs });
    let counted = 0;
    const count = (u: StageUsage): void => {
      const x = units(u, tier, o.weights);
      if (x === counted) return;
      const add = x - counted;
      counted = x;
      o.budget.add(add);
      try { o.charge?.(id, add); } catch (e) { log.warn("sleep: charging a side session to its stage failed", { id, error: msg(e).slice(0, 200) }); }
    };
    sess.settled.then((r) => count(r.usage), () => {});
    const base = { id: sess.id, settled: sess.settled, wake: (t: string) => sess.wake(t), close: () => sess.close() };
    return { sess, on, base, count };
  };
  const audit: AuditHost = {
    // 时限是配置的 auditMinutes（和交给 auditValidator 的 timeoutMs 同一个数）。考试夜省钱阶梯到了 cheap：核依据也用 sonnet
    open(x): StageSession & { onAudit(fn: (a: AuditDone) => string): void } {
      const tier = examNight && o.ladder?.().cheap ? "sonnet" : tierOf(x.model);
      const { sess, on, base } = side(x.id, tier, x.allowed, o.auditMs);
      return { ...base, onTurnEnd: (fn) => sess.onTurnEnd(fn), onAudit: (fn) => { on.audit = fn; } };
    },
    read: (p) => b.fs.read(p),
  };
  // 交叉审：跟核依据一样只读、一样的时限；模型照 reviewModel（交给 reviewValidator 的）
  const review: ReviewHost | null = !teamNight ? null : {
    // 考试夜省钱阶梯到了 cheap：交叉审最多用 sonnet（haiku 照旧；修正轮 2 M7）
    open(x) {
      const tier = tierOf(x.model);
      const { sess, on, base } = side(x.id, examNight && o.ladder?.().cheap && tier === "opus" ? "sonnet" : tier, x.allowed, o.auditMs);
      return { ...base, onTurnEnd: (fn) => sess.onTurnEnd(fn), onReview: (fn) => { on.review = fn; } };
    },
    read: (p) => b.fs.read(p),
    page: (s) => stage.skillText(s),
  };
  // 前额叶：一夜一个会话，只能交 coordinate（只读）；每一轮结束就把这一轮的花费记上（不等一夜完了才算）
  const coord: CoordHost | null = !coordNight ? null : {
    open(x) {
      const { sess, on, base, count } = side(x.id, tierOf(x.model), ["coordinate"], x.timeoutMs);
      sess.onTurnEnd((_ok, _e, u) => { if (u) count(u); });
      return { ...base, onTurnEnd: (fn) => sess.onTurnEnd(fn), onCoordinate: (fn) => { on.coordinate = fn; } };
    },
  };

  // 领导：跟前额叶一样是只读的段外会话，每一轮结束记上这一轮的花费；开头、工具清单就是 open() 给专员的那一份（不另给 roleText、prefix）
  const lead: LeadHost | null = !leadNight ? null : {
    open(x) {
      const { sess, on, base, count } = side(x.id, tierOf(x.model), [...LEAD_ALLOWED], x.timeoutMs);
      sess.onTurnEnd((_ok, _e, u) => { if (u) count(u); });
      return { ...base, onTurnEnd: (fn) => sess.onTurnEnd(fn), onReview: (fn) => { on.leadReview = fn; }, onVerdict: (fn) => { on.leadVerdict = fn; } };
    },
  };

  // ---------- 考试 ----------

  /** 基础块读一次（一夜里不变：各段的改动在提案里，落地前不动原文件）；读不到的记 warn、跳过 */
  const blocks = new Map<string, string | null>();
  const block = (p: string): string | null => {
    if (blocks.has(p)) return blocks.get(p)!;
    let t: string | null = null;
    try { t = b.readText(join(W, p)); } catch { t = null; }
    if (t === null) log.warn("sleep: exam base block unreadable, left out of the exam opening", { block: p });
    blocks.set(p, t);
    return t;
  };
  const openings = new Map<string, string>();
  /**
   * 核心开头：一句头，下面是配置顺序的基础块，照工作区里现在的样子（今晚的提案在 sleep/<日>/proposed/ 里，不看；不照中期视图裁——
   * 这是给动手整理的人看的全文）。同一句头在落地之前给同一份
   */
  const coreOpening = (head: string): string => {
    const key = `core:${head}`;
    const hit = openings.get(key);
    if (hit !== undefined) return hit;
    const parts = plan.flow.exam.baseBlocks.flatMap((p) => { const t = block(p); return t === null ? [] : [`## ${p}\n${t.trimEnd()}`]; });
    const text = [head, ...parts].join("\n\n");
    openings.set(key, text);
    return text;
  };
  /** team 的专员和领导的开头：核心开头 + common（夜里整理的约定） */
  function teamPrefix(): string { return `${coreOpening(S.leadprompts.coreHead)}\n\n${plan.common ?? ""}`.trimEnd(); }
  const exam: NightHosts["exam"] = !examNight ? null : {
    timeoutMs: o.auditMs,
    open(x: ExamOpen): ExamSession {
      // 整理前那次：事件库工具读拷贝（只读，会话结束就关）；拷贝打不开就抛（考试那边重开一次，还不行算没考完）
      let copy: { mem: EventMemory; close(): void } | null = null;
      // 用不上事件库工具的会话（常驻那层的考生、判分、出暗题的）不开拷贝（final fix M11）
      if (x.store !== "live" && x.allowed.some((t) => SEARCH_TOOLS.includes(t))) {
        copy = b.memAt?.(x.store) ?? null;
        if (!copy) throw new Error(S.host.copyUnopenable(x.store));
      }
      let opened: ReturnType<typeof open>;
      try {
        opened = open(x.id, tierOf(x.model), {
          allowed: new Set(x.allowed), proposedRoot: join(W, "sleep"), writes: [], bash: [], timeoutMs: o.auditMs, prefix: x.opening,
          // 考生、判分：不带「夜里整理」那句角色说明（说明在叫醒的话里）；不能读今晚的整理和答案从注入里给的那几个文件；
          // reads: false（常驻那层的考生、判分、出暗题的）什么都不让读
          roleText: "",
          readDeny: x.reads === false ? () => P.EXAM_NO_READS : examReadGuard({ workspace: W, hide: x.hide ?? [], patterns: plan.flow.exam.hide }),
          ...(copy ? { mem: copy.mem } : {}),
        });
      } catch (e) {
        copy?.close();
        throw e;
      }
      const { sess, on } = opened;
      if (copy) {
        const c = copy;
        const closeCopy = (): void => { try { c.close(); } catch (e) { log.warn("sleep: closing the event-store copy failed", { id: x.id, error: msg(e).slice(0, 200) }); } };
        sess.settled.then(closeCopy, closeCopy);
      }
      return {
        id: sess.id, settled: sess.settled, wake: (t) => sess.wake(t), close: () => sess.close(), onTurnEnd: (fn) => sess.onTurnEnd(fn),
        onAnswers: (fn) => { on.answers = fn; },
        onGrades: (fn) => { on.grades = fn; },
        // 出暗题的交的题直接交给 hidden.ts（它自己存进题库），不走段的那一关
        onQuestions: (fn) => { on.questions = fn; },
      };
    },
    /**
     * 考场开头：一句「这是你醒着的时候的样子」，下面是配置顺序的基础块（exclude 里的不放；tonight 里有的用它：
     * 今晚前面过了的段改过的，明天的样子）；同样的输入一夜里给同一份
     */
    coreOpening,
    rawSource(ref, x) {
      const r = ref.trim();
      try {
        const seq = centralRef(r);
        if (seq !== null) { const t = one<{ text: string }>(b.db, "SELECT text FROM central WHERE seq = ?", seq)?.text; return t === undefined ? null : { kind: "central", text: t }; }
        if (/^q\d+$/.test(r)) { const t = b.mem?.index.quote(r)?.text; return t === undefined ? null : { kind: "quote", text: t }; }
        if (/^[enti]\d+/.test(r)) return null;
        const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(r);
        if (!m) return null;
        // 路径照实际落在哪儿认（outsidePath）：sleep/ 下面只认当天的材料，换个写法、绕个软链到提案或引擎的记录里的不认
        const path = outsidePath(m[1]!, x.day, W);
        if (path === null) return null;
        const text = path.startsWith("sleep/")
          ? b.readText(join(W, path))
          : beforeText(x.day, path, { files: x.before, ...(x.writes ? { writes: x.writes } : {}) });
        if (text === null) return null;
        const from = Number(m[2]), to = Number(m[3] ?? m[2]);
        const lines = text.replace(/\n$/, "").split("\n");
        if (from < 1 || to < from || lines.length < to) return null;
        return { kind: "path", text: lines.slice(from - 1, to).join("\n") };
      } catch { return null; }
    },
    wakeOpening(day, built) {
      const mid = plan.flow.exam.residentMemory && !!b.cfg.memory?.events?.midterm && !!b.mem;
      const fresh = (p: string): string | null => { try { return b.readText(join(W, p)); } catch { return null; } };
      const parts = plan.flow.exam.baseBlocks.flatMap((p) => {
        const t = built ? fresh(p) : b.fs.read(`sleep/${day}/proposed/${p}`) ?? fresh(p);
        return t === null ? [] : [`## ${p}\n${(mid ? trimForMidterm(p, t) : t).trimEnd()}`];
      });
      return [P.EXAM_OPENING_HEAD, ...parts].join("\n\n");
    },
    opening(exclude, tonight) {
      const over = [...(tonight ?? [])].filter(([p]) => plan.flow.exam.baseBlocks.includes(p) && !exclude.includes(p)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      const key = createHash("sha256").update(JSON.stringify([[...new Set(exclude)].sort(), over])).digest("hex");
      const hit = openings.get(key);
      if (hit !== undefined) return hit;
      const tomorrow = new Map(over);
      // 常驻那层看中期视图时（exam.residentMemory、她的前缀里有中期视图），基础块照她的前缀那样给（trimForMidterm：账本去掉旧事件线那几段；修正轮 2 M3）
      const mid = plan.flow.exam.residentMemory && !!b.cfg.memory?.events?.midterm && !!b.mem;
      const parts = plan.flow.exam.baseBlocks.filter((p) => !exclude.includes(p)).flatMap((p) => {
        const t = tomorrow.has(p) ? tomorrow.get(p)! : block(p);
        return t === null ? [] : [`## ${p}\n${(mid ? trimForMidterm(p, t) : t).trimEnd()}`];
      });
      const text = [P.EXAM_OPENING_HEAD, ...parts].join("\n\n");
      openings.set(key, text);
      return text;
    },
    /**
     * 这些文件明天注入的样子：配了 preview 脚本就写出来让它拼（2 分钟），没配就原样拼起来。
     * 脚本没跑成：记 warn、抛错（考试那边常驻层不考，报告里写一句；不拿原样的冒充明天的样子）
     */
    async preview(x) {
      const argv = plan.flow.exam.preview;
      if (!argv?.length) return plainInjection(x.files);
      // 写在 stateDir 下的草稿目录（不写进工作区：考生能读工作区），用完就删
      const dir = join(previewRoot, x.day, x.stage, x.state);
      let why: string;
      try {
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        for (const [p, t] of x.files) {
          if (t === null) continue;
          const f = join(dir, p);
          mkdirSync(dirname(f), { recursive: true });
          writeFileSync(f, t);
        }
        const [cmd, ...args] = argv.map((a) => a.replaceAll("{day}", x.day).replaceAll("{stage}", x.stage).replaceAll("{state}", x.state).replaceAll("{dir}", dir));
        const r = await b.run(PYTHONS.has(cmd!) ? b.cfg.tools.python : cmd!, args, { cwd: W, timeoutMs: PREVIEW_MS });
        if (r.code === 0) return r.stdout;
        const out = (r.stderr || r.stdout).trim().slice(0, 300);
        log.warn("sleep: exam preview script failed", { day: x.day, stage: x.stage, state: x.state, code: r.code, out });
        why = S.host.previewExit(r.code, out ? S.host.previewOut(out) : "");
      } catch (e) {
        log.warn("sleep: exam preview script failed", { day: x.day, stage: x.stage, state: x.state, error: msg(e).slice(0, 300) });
        why = S.host.previewCannotRun(msg(e).slice(0, 300));
      } finally {
        try { rmSync(dir, { recursive: true, force: true }); } catch (e) { log.warn("sleep: removing the preview files failed", { dir, error: msg(e).slice(0, 200) }); }
        // 上面几层（<段>/<日>/ 和草稿目录本身）空了也删：草稿目录在系统临时目录里时不留在那儿（#0055）；
        // rmdir 只删空目录，别的预览正在用的删不掉，到那儿就停
        for (let d = dirname(dir); within(previewRoot, d); d = dirname(d)) {
          try { rmdirSync(d); } catch { break; }
        }
      }
      throw new Error(why);
    },
    sourceExists,
    beforeText,
    isPrivate,
    parentsOf,
    memory: memoryView,
    /** 会话结算时报一次：算进这一夜的花费；之后的考试会话一点缓存都没读到的，记日志、写进那一天报告最上面 */
    spent(id, model, u) {
      const x = units(u, tierOf(model), o.weights);
      o.budget.add(x);
      try { o.charge?.(id, x); } catch { /* 记到段头上失败不挡考试 */ }
      const miss = o.cache?.seen(id, u) ?? null;
      if (!miss) return;
      log.warn("sleep: exam session got no cache hit", { id, calls: u.calls });
      const day = EXAM_DAY.exec(id)?.[1];
      if (day) note(day, miss);
    },
  };

  return {
    stage, audit, exam, lead, review, coord, bank, live, sessions, union,
    async shut() {
      shut = true;
      // 先删拷贝：关不掉的会话不能把它留下
      dropAll();
      await Promise.all([...sessions.values()].map((x) => x.close().catch(() => {})));
    },
  };
}
