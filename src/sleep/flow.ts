import { S } from "../lang/index.ts";
// 夜里整理的流程配置：解析、核对、按依赖和共用文件排先后、坏了退回上一份能用的。
// 纯函数模块，不碰文件系统（读写由 loadFlow 的调用方传进来）。
export type StageKind = "agent" | "script" | "builtin";
export type Carry = "redo" | "drop";
export type When = "always" | "sunday" | "material-full" | "backlog<=1";

export type Model = "opus" | "sonnet" | "haiku";

/** 段里的 exam 块：没写 = 不考（null）；写了 {} = 全用默认值 */
export interface StageExam {
  min: number; max: number; old: number; sample: number; hidden: number;
  newRate: { resident: number; searchable: number };
  regressions: number; highAllRight: boolean; hiddenGates: boolean;
}

export type SaveStep = "hidden" | "old" | "cheap" | "final-old";

export interface ExamConfig {
  baseBlocks: string[]; examineeModel: Model; graderModel: Model; preview: string[] | null;
  saveLadder: SaveStep[]; finalOld: number; finalSample: number;
  /** 全天考试里被两段以上碰过的东西上挂着的题最多考几道 */
  finalShared: number;
  /** 考试的会话不让读的（相对工作区的通配，matchWrites 的写法）；HH 不给默认值，她的工作区里配 */
  hide: string[];
  /**
   * 明天会注入她前缀的文件（相对工作区的通配，matchWrites 的写法）；基础块总是注入（经考场开头）。
   * 改过的文件只有基础块和这里点名的进考生的注入，别的进查得到那层的附录。HH 不给默认值，她的工作区里配
   */
  inject: string[];
  /** 附录（改过、不注入的文件现在的样子）一共最多几个字 */
  appendixChars: number;
  /**
   * 常驻那层的考生也看她前缀里从事件库渲染的那一块（中期视图），整理后照现在的库、整理前照拷贝（切换前 P6）。
   * 默认 false（不考试的夜、旧的整理都不受影响）；她的 flow.json 里开
   */
  residentMemory: boolean;
  /**
   * 要忽略的标记（切换前 P5）：比较压缩（compressions）、挪走的那行还在不在（lineKept）之前，整理前后的每一行都先去掉它们
   * ——只加了这种标记的一行不算改过。默认是字面的；写成 re:… 的是正则（修正轮 2 M1）。默认 []；她的 flow.json 里配
   */
  ignoreMarks: string[];
}

export interface StageSpec {
  id: string; title: string; kind: StageKind;
  after: string[]; when: When[]; enabled: boolean; required: boolean;
  model: Model;
  exam: StageExam | null;
  skill: string | null; material: string[]; tools: string[]; bash: string[];
  writes: string[]; memWrite: boolean; needsDialogue: boolean;
  budget: { minutes: number; calls: number };
  validate: string[]; carry: Carry; checkpoint: boolean;
  command: string[] | null; builtin: string | null;
  /** 多人模式（全局写了 personasFile）：这一段挂在哪个脑区（只是标签，进日志、报告、记账）；没写就没有这个键 */
  region?: string;
  /** 做这一段的是哪一个她（personas.json 里的 id） */
  persona?: string;
  /** 这一段的核依据用哪个模型（不写 = 全局 auditModel；切换前 P8：核心段可以配更强的） */
  auditModel?: "opus" | "sonnet";
  /** 这一段的交叉审用哪个模型（不写 = 全局 reviewModel） */
  reviewModel?: Model;
  /** 谁来审：不写 = 除了做的那个以外的全部 */
  reviewers?: string[];
  /** 没过时谁来修：不写 = 除了上一次做的那个以外的全部 */
  fixers?: string[];
  /**
   * 这一段该管的文件（相对工作区的路径或通配，matchWrites 的写法）：专员 + 领导的夜里，交差时哪一条一个文件都没动、
   * 报告里也没说「看过、不用改：<这一条>」，当场退回一次。没写就没有这个键
   */
  duty?: string[];
  /** 这一段自己的材料切片上限（字数；盖过 team.sliceCap）：整天的对话就是它的活的那一段可以写大一点。没写就没有这个键 */
  sliceCap?: number;
}

/**
 * 「专员 + 领导」模式（engine: "team"）：专员一个个做，领导出题、看改动、判前后一致。
 * lead.skill 相对 flow.json 所在目录；turnMinutes = 领导一轮最多多久
 */
export interface TeamConfig {
  lead: { model: Model; skill: string; turnMinutes: number };
  /** 没过时发回原来那个专员改，最多几轮（0 到 2，默认 2） */
  maxFixRounds: number;
  /** 每晚固定要问的几道题（问法在流程配置里，HH 里不写） */
  continuity: string[];
  /** 新题、漏题要答对的比例（0 到 1，默认 0.85） */
  tolerance: number;
  /** 引擎自己加的旧题（挂在这个专员改过的东西上的生效题）最多几道；没写 = 30（没有这个键） */
  old?: number;
  /** 给领导看的那一份改动（文件 diff、事件库的变化、专员列的改动）每样最多多少字；全文总在 .diff 文件里。没写 = 12000（没有这个键） */
  diffCap?: number;
  /** 材料的切片超过这么多字就不贴进专员的第一条消息，只写文件在哪（用到再读）。没写 = 20000（没有这个键） */
  sliceCap?: number;
  /** 领导每个专员一个会话，开头带前面几个专员今晚定了什么：每个专员那一块最多多少字。没写 = 1500（没有这个键） */
  digestCap?: number;
  /** 「出处里两种说法都有」这一种撤题开不开（默认不开：还没在真的回放里见过，条件也不够严）。没写 = false（没有这个键） */
  withdrawTwoAnswers?: boolean;
  /** 一夜里领导最多撤几道题（标准答案本身错了的；一个专员最多 2 道是写死的）。没写 = 4（没有这个键） */
  withdrawCap?: number;
  /** 每晚固定要问的题在哪个专员那里问（agent 段的 id）；没写 = 最后一个开着的专员（没有这个键） */
  continuityAt?: string;
}

export interface FlowConfig {
  engine: "legacy" | "flow" | "team"; maxParallel: number;
  budget: { targetPct: number; hardPct: number };
  saveMode: string[]; auditModel: "opus" | "sonnet";
  checks: Record<string, string[]>; exam: ExamConfig; stages: StageSpec[];
  /**
   * 下面几个没写就没有这个键（流程的 JSON、哈希跟以前一字不差）。
   * personasFile：几个不同性格的她（相对 flow.json 所在目录）；写了才有交叉审、换人修
   */
  personasFile?: string;
  /** 没过时最多换人修几轮（0 到 3，默认 2；只在 personasFile 写了时用，没写照旧一共两次） */
  maxFixRounds?: number;
  /** 交叉审的会话用什么模型（默认 sonnet） */
  reviewModel?: Model;
  /** 前额叶：一夜一个协调的会话，每段验完定过、重做还是推迟；persona 给了就用那一个她的说明 */
  coordinator?: { model: Model; persona?: string;
    /** 一夜最多打磨几次（都过了、前额叶还要再修一次）：0 到 5 的整数，没写 = 2（没有这个键） */
    maxPolish?: number };
  /**
   * 回放（hh sleep replay）开跑前、那一天还没有 sleep/<日>/slices/ 时在回放的工作区里按顺序跑的命令（argv，{day} 换成日子）。
   * 没写 = []（没有这个键）；真的夜里不用它
   */
  replayPrep?: string[][];
  /**
   * 回放时从流程目录所在的仓库（git rev-parse --show-toplevel）盖到回放工作区的几个文件（相对工作区的路径）：基准提交以后改过、
   * 流程要用的脚本（不在流程目录里的）。只是工具，不算回放的改动。没写 = []（没有这个键）；真的夜里不用它
   */
  replayOverlay?: string[];
  /**
   * 回放里、最后一个专员考过以后、固定要问的题考之前，在回放的工作区里按顺序跑的命令（argv，{day} 换成日子）：把真的夜里落地时
   * 拼的「她醒来看到的样子」拼出来，考生照它答。没写 = 没有这个键；真的夜里不用它
   */
  replayFinish?: string[][];
  /** engine 是 team 才有（没写 engine: "team" 就没有这个键） */
  team?: TeamConfig;
}

/** personas.json：{ "<id>": { name, text } } */
export type Personas = Record<string, { name: string; text: string }>;

export interface Known {
  tools: ReadonlySet<string>; builtins: ReadonlySet<string>;
  /** 写事件库的工具：段的 tools 里有一个就算 memWrite（不靠配置自己写），两段都写事件库就不同时跑 */
  memWriters: ReadonlySet<string>;
}

export class FlowError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(S.flow.problems(problems.length, problems.join(S.marks.clauseSep)));
    this.name = "FlowError";
    this.problems = problems;
  }
}

const KINDS = ["agent", "script", "builtin"];
const WHENS = ["always", "sunday", "material-full", "backlog<=1"];
const MODELS = ["opus", "sonnet", "haiku"];
const SAVE_STEPS = ["hidden", "old", "cheap", "final-old"];
/** 段的 id 会变成文件名、会话 id、批次名：只用字母数字和 _ -，不以符号开头 */
const STAGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isStrs = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

export function parseFlow(raw: unknown, known: Known): FlowConfig {
  const problems: string[] = [];
  if (!isObj(raw)) throw new FlowError([S.flow.notObject]);

  const pick = <T>(o: Record<string, unknown>, k: string, ok: (v: unknown) => boolean, dflt: T, where: string): T => {
    const v = o[k];
    if (v === undefined) return dflt;
    if (ok(v)) return v as T;
    problems.push(S.flow.badValue(where, k));
    return dflt;
  };
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const nonNeg = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const rate = (v: unknown) => nonNeg(v) && (v as number) <= 1;
  const bool = (v: unknown) => typeof v === "boolean";
  const parseExam = (r: unknown, w: string): StageExam | null => {
    if (r === undefined || r === null) return null;
    if (!isObj(r)) { problems.push(S.flow.badExam(w)); return null; }
    const x = S.flow.examOf(w);
    const nr = isObj(r.newRate) ? r.newRate : {};
    if (r.newRate !== undefined && !isObj(r.newRate)) problems.push(S.flow.badNewRate(x));
    const rateOf = (o: Record<string, unknown>, k: string, where: string): number => {
      if (o[k] === undefined) return 0.9;
      if (rate(o[k])) return o[k] as number;
      problems.push(S.flow.badRate(where, k));
      return 0.9;
    };
    const e: StageExam = {
      // max 要是整数（切换前 P10a：2.5 这种算错）
      min: pick(r, "min", nonNeg, 1, x), max: pick(r, "max", (v) => nonNeg(v) && Number.isInteger(v), 40, x),
      old: pick(r, "old", nonNeg, 30, x), sample: pick(r, "sample", nonNeg, 5, x),
      hidden: pick(r, "hidden", nonNeg, 3, x),
      newRate: { resident: rateOf(nr, "resident", x), searchable: rateOf(nr, "searchable", x) },
      regressions: pick(r, "regressions", nonNeg, 0, x),
      highAllRight: pick(r, "highAllRight", bool, true, x),
      hiddenGates: pick(r, "hiddenGates", bool, false, x),
    };
    if (e.min > e.max) problems.push(S.flow.minOverMax(x, e.min, e.max));
    return e;
  };

  const engine = pick<FlowConfig["engine"]>(raw, "engine", (v) => v === "legacy" || v === "flow" || v === "team", "legacy", S.flow.global);
  const maxParallel = pick(raw, "maxParallel", (v) => Number.isInteger(v) && (v as number) >= 1, 2, S.flow.global);
  const bRaw = isObj(raw.budget) ? raw.budget : {};
  const budget = {
    targetPct: pick(bRaw, "targetPct", num, 1, S.flow.globalBudget),
    hardPct: pick(bRaw, "hardPct", num, 2, S.flow.globalBudget),
  };
  const saveMode = pick<string[]>(raw, "saveMode", isStrs, [], S.flow.global);
  const auditModel = pick<"opus" | "sonnet">(raw, "auditModel", (v) => v === "opus" || v === "sonnet", "opus", S.flow.global);
  let checks: Record<string, string[]> = {};
  if (raw.checks !== undefined) {
    if (isObj(raw.checks) && Object.values(raw.checks).every(isStrs)) checks = raw.checks as Record<string, string[]>;
    else problems.push(S.flow.badChecks);
  }

  // 全局 exam：baseBlocks 没有默认值（HH 默认里不放任何人的数据），没写就是 []
  const gx = isObj(raw.exam) ? raw.exam : {};
  if (raw.exam !== undefined && !isObj(raw.exam)) problems.push(S.flow.badGlobalExam);
  const gw = S.flow.globalExam;
  const baseBlocks = pick<string[]>(gx, "baseBlocks", isStrs, [], gw);
  for (const b of baseBlocks) {
    if (!b || b.startsWith("/") || b.split("/").includes("..")) problems.push(S.flow.badBaseBlock(gw, b));
  }
  const saveLadder = pick<SaveStep[]>(gx, "saveLadder",
    (v) => isStrs(v) && v.every((s) => SAVE_STEPS.includes(s)) && new Set(v).size === v.length,
    ["hidden", "old", "cheap", "final-old"], gw);
  const exam: ExamConfig = {
    baseBlocks,
    examineeModel: pick<Model>(gx, "examineeModel", (v) => MODELS.includes(v as string), "opus", gw),
    graderModel: pick<Model>(gx, "graderModel", (v) => MODELS.includes(v as string), "opus", gw),
    preview: pick<string[] | null>(gx, "preview", isStrs, null, gw),
    saveLadder,
    finalOld: pick(gx, "finalOld", nonNeg, 20, gw),
    finalSample: pick(gx, "finalSample", nonNeg, 5, gw),
    finalShared: pick(gx, "finalShared", nonNeg, 40, gw),
    hide: pick<string[]>(gx, "hide", isStrs, [], gw),
    inject: pick<string[]>(gx, "inject", isStrs, [], gw),
    appendixChars: pick(gx, "appendixChars", nonNeg, 40000, gw),
    residentMemory: pick(gx, "residentMemory", bool, false, gw),
    ignoreMarks: pick<string[]>(gx, "ignoreMarks", isStrs, [], gw),
  };
  // 默认是字面的标记；re: 开头的才是正则，要能编译（修正轮 2 M1）
  for (const m of exam.ignoreMarks) {
    if (!m) { problems.push(S.flow.emptyMark(gw)); continue; }
    // 终审修正轮 M6：没写 re: 却带着 ASCII 的正则符号的，多半是想当正则用（字面去找什么都对不上）：报出来
    if (!m.startsWith("re:")) {
      if (/[[\]()*+?{}|\\^$]/.test(m)) problems.push(S.flow.markHasRegex(gw, m));
      continue;
    }
    if (m === "re:") { problems.push(S.flow.markNoRegex(gw)); continue; }
    try { new RegExp(m.slice(3), "gu"); } catch (e) { problems.push(S.flow.markBadRegex(gw, m, e instanceof Error ? e.message : String(e))); }
  }
  for (const [k, list] of [["hide", exam.hide], ["inject", exam.inject]] as const) {
    for (const h of list) {
      if (!h || h.startsWith("/") || h.startsWith("!") || h.split("/").includes("..")) problems.push(S.flow.badGlob(gw, k, h));
      // ./ 开头、/ 结尾的什么都对不上（matchWrites 比的是 a/b 这样的路径）
      else if (h.startsWith("./") || h.endsWith("/")) problems.push(S.flow.deadGlob(gw, k, h));
    }
  }

  // 多人：没写的键不放进结果
  const team: Pick<FlowConfig, "personasFile" | "maxFixRounds" | "reviewModel" | "coordinator"> = {};
  if (raw.personasFile !== undefined) {
    const f = raw.personasFile;
    if (typeof f !== "string" || !f || f.startsWith("/") || f.split("/").includes("..")) problems.push(S.flow.badPersonasFile);
    else team.personasFile = f;
  }
  // 最多 3 轮（最终评审 M3：写错成 20 就是一段 21 次）
  if (raw.maxFixRounds !== undefined) team.maxFixRounds = pick(raw, "maxFixRounds", (v) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3, 2, S.flow.global);
  if (raw.reviewModel !== undefined) team.reviewModel = pick<Model>(raw, "reviewModel", (v) => MODELS.includes(v as string), "sonnet", S.flow.global);
  if (raw.coordinator !== undefined) {
    const c = raw.coordinator;
    const polishOk = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 5);
    if (!isObj(c) || !MODELS.includes(c.model as string) || (c.persona !== undefined && (typeof c.persona !== "string" || !c.persona)) || !polishOk(c.maxPolish)) {
      problems.push(S.flow.badCoordinator);
    } else {
      team.coordinator = {
        model: c.model as Model, ...(typeof c.persona === "string" ? { persona: c.persona } : {}),
        ...(typeof c.maxPolish === "number" ? { maxPolish: c.maxPolish } : {}),
      };
    }
  }

  const rawStages = raw.stages;
  if (!Array.isArray(rawStages)) { problems.push(S.flow.stagesNotArray); throw new FlowError(problems); }

  const stages: StageSpec[] = [];
  const seen = new Set<string>();
  rawStages.forEach((r, i) => {
    if (!isObj(r)) { problems.push(S.flow.stageNotObject(i + 1)); return; }
    const id = typeof r.id === "string" && r.id ? r.id : "";
    if (!id) { problems.push(S.flow.stageNoId(i + 1)); return; }
    if (seen.has(id)) { problems.push(S.flow.stageDuplicate(id)); return; }
    seen.add(id);
    const w = S.flow.stage(id);
    if (!STAGE_ID.test(id)) problems.push(S.flow.badId(w));
    const kind = pick<StageKind>(r, "kind", (v) => KINDS.includes(v as string), "agent", w);
    if (r.kind === undefined) problems.push(S.flow.noKind(w));
    const when = pick<When[]>(r, "when", (v) => isStrs(v) && v.length > 0 && v.every((s) => WHENS.includes(s)), ["always"], w);
    const bd = isObj(r.budget) ? r.budget : {};
    const st: StageSpec = {
      id, title: pick(r, "title", (v) => typeof v === "string", id, w), kind,
      after: pick(r, "after", isStrs, [], w), when,
      enabled: pick(r, "enabled", (v) => typeof v === "boolean", true, w),
      required: pick(r, "required", (v) => typeof v === "boolean", false, w),
      model: pick<Model>(r, "model", (v) => MODELS.includes(v as string), "opus", w),
      exam: parseExam(r.exam, w.trimEnd()),
      skill: pick<string | null>(r, "skill", (v) => typeof v === "string" && v !== "", null, w),
      material: pick(r, "material", isStrs, [], w), tools: pick(r, "tools", isStrs, [], w),
      bash: pick(r, "bash", isStrs, [], w), writes: pick(r, "writes", isStrs, [], w),
      memWrite: pick(r, "memWrite", (v) => typeof v === "boolean", false, w),
      needsDialogue: pick(r, "needsDialogue", (v) => typeof v === "boolean", false, w),
      budget: { minutes: pick(bd, "minutes", num, 30, w + "budget "), calls: pick(bd, "calls", num, 120, w + "budget ") },
      validate: pick(r, "validate", isStrs, [], w),
      carry: pick<Carry>(r, "carry", (v) => v === "redo" || v === "drop", "redo", w),
      checkpoint: pick(r, "checkpoint", (v) => typeof v === "boolean", false, w),
      command: pick<string[] | null>(r, "command", (v) => isStrs(v) && v.length > 0, null, w),
      builtin: pick<string | null>(r, "builtin", (v) => typeof v === "string" && v !== "", null, w),
    };
    if (kind === "agent" && !st.skill) problems.push(S.flow.agentNoSkill(w));
    if (kind === "script" && !st.command) problems.push(S.flow.scriptNoCommand(w));
    if (kind === "builtin") {
      if (!st.builtin) problems.push(S.flow.builtinNoName(w));
      else if (!known.builtins.has(st.builtin)) problems.push(S.flow.unknownBuiltin(w, st.builtin));
    }
    for (const t of st.tools) if (!known.tools.has(t)) problems.push(S.flow.unknownTool(w, t));
    if (st.bash.some((b) => !b.trim())) problems.push(S.flow.emptyBash(w));
    if (st.tools.some((t) => known.memWriters.has(t))) st.memWrite = true;
    // 多人：写了才放进来
    if (r.region !== undefined) {
      if (typeof r.region === "string" && r.region) st.region = r.region; else problems.push(S.flow.badRegion(w));
    }
    // 切换前 P8：这一段的核依据、交叉审换模型（写了才放进来）
    if (r.auditModel !== undefined) {
      if (r.auditModel === "opus" || r.auditModel === "sonnet") st.auditModel = r.auditModel; else problems.push(S.flow.badAuditModel(w));
    }
    if (r.reviewModel !== undefined) {
      if (MODELS.includes(r.reviewModel as string)) st.reviewModel = r.reviewModel as Model; else problems.push(S.flow.badReviewModel(w));
    }
    if (r.sliceCap !== undefined) {
      if (Number.isInteger(r.sliceCap) && (r.sliceCap as number) >= 0) st.sliceCap = r.sliceCap as number;
      else problems.push(S.flow.badSliceCap(w));
    }
    if (r.duty !== undefined) {
      const okDuty = (g: unknown): boolean => typeof g === "string" && g !== "" && !g.startsWith("/") && !g.startsWith("./") && !g.split("/").includes("..");
      if (Array.isArray(r.duty) && r.duty.length > 0 && r.duty.every(okDuty)) st.duty = r.duty as string[];
      else problems.push(S.flow.badDuty(w));
    }
    for (const k of ["persona"] as const) {
      if (r[k] === undefined) continue;
      if (typeof r[k] === "string" && r[k]) st[k] = r[k] as string; else problems.push(S.flow.badValue(w, k));
    }
    for (const k of ["reviewers", "fixers"] as const) {
      if (r[k] === undefined) continue;
      if (isStrs(r[k]) && r[k].length > 0 && r[k].every(Boolean)) st[k] = r[k] as string[]; else problems.push(S.flow.badIds(w, k));
    }
    if (team.personasFile && kind === "agent" && !st.persona) problems.push(S.flow.needsPersona(w));
    if (!team.personasFile && (st.persona || st.reviewers || st.fixers)) problems.push(S.flow.personasNoFile(w));
    if (st.persona && st.reviewers?.includes(st.persona)) problems.push(S.flow.selfReview(w, st.persona));
    stages.push(st);
  });

  // 引擎真跑的配置：得有段可做、得有 finish 落地（不然每晚白跑、每天撤回）
  if (engine === "flow") {
    if (!stages.some((s) => s.kind === "agent" && s.enabled)) problems.push(S.flow.flowNoAgent);
    const fin = stages.find((s) => s.id === "finish");
    if (!fin || fin.kind !== "script" || !fin.enabled) problems.push(S.flow.flowNoFinish);
  }

  // 专员 + 领导：team 块只在 engine 是 team 时看（别的 engine 写了也不放进结果，流程的 JSON、哈希跟以前一字不差）
  let teamCfg: TeamConfig | undefined;
  if (engine === "team") {
    if (!stages.some((s) => s.kind === "agent" && s.enabled)) problems.push(S.flow.teamNoAgent);
    const fin = stages.find((s) => s.id === "finish");
    if (!fin || fin.kind !== "script" || !fin.enabled) problems.push(S.flow.teamNoFinish);
    // 专员一个个做：领导定了上一个，下一个才开始
    if ((maxParallel as number) !== 1) problems.push(S.flow.teamParallel);
    for (const s of stages) if (s.kind === "agent" && s.exam) problems.push(S.flow.teamStageExam(s.id));
    if (team.personasFile) problems.push(S.flow.teamPersonasFile);
    if (team.coordinator) problems.push(S.flow.teamCoordinator);
    // 多人模式的几个键 team 用不上：写了就说（team 自己的轮数在 team.maxFixRounds）
    if (raw.maxFixRounds !== undefined) problems.push(S.flow.teamFixRounds);
    if (raw.reviewModel !== undefined) problems.push(S.flow.teamReviewModel);
    for (const s of stages) for (const k of ["auditModel", "reviewModel"] as const) if (s[k] !== undefined) problems.push(S.flow.teamStageModel(s.id, k));
    if (baseBlocks.length === 0) problems.push(S.flow.teamNoBaseBlocks);
    const t = raw.team;
    if (t === undefined) problems.push(S.flow.teamNoBlock);
    else if (!isObj(t)) problems.push(S.flow.badTeam);
    else {
      const l = t.lead;
      const okSkill = (f: unknown): f is string => typeof f === "string" && f !== "" && !f.startsWith("/") && !f.startsWith("./") && !f.endsWith("/") && !f.split("/").includes("..");
      const leadOk = isObj(l) && okSkill(l.skill) && (l.model === undefined || MODELS.includes(l.model as string)) && (l.turnMinutes === undefined || num(l.turnMinutes));
      if (!leadOk) problems.push(S.flow.badLead);
      const tw = "team ";
      let maxFixRounds = 2;
      if (t.maxFixRounds !== undefined) {
        if (Number.isInteger(t.maxFixRounds) && (t.maxFixRounds as number) >= 0 && (t.maxFixRounds as number) <= 2) maxFixRounds = t.maxFixRounds as number;
        else problems.push(S.flow.badTeamFixRounds);
      }
      const continuity = pick<string[]>(t, "continuity", (v) => isStrs(v) && v.every((x) => x.trim() !== ""), [], tw);
      let tolerance = 0.85;
      if (t.tolerance !== undefined) {
        if (rate(t.tolerance)) tolerance = t.tolerance as number;
        else problems.push(S.flow.badTolerance);
      }
      // 可以不写的两个（没写就没有这个键）：old = 引擎自己加的旧题最多几道；continuityAt = 固定要问的题在哪个专员那里问
      const more: Pick<TeamConfig, "old" | "continuityAt" | "diffCap" | "sliceCap" | "digestCap" | "withdrawCap" | "withdrawTwoAnswers"> = {};
      if (t.withdrawTwoAnswers !== undefined) {
        if (typeof t.withdrawTwoAnswers === "boolean") more.withdrawTwoAnswers = t.withdrawTwoAnswers;
        else problems.push(S.flow.badWithdrawTwoAnswers);
      }
      if (t.withdrawCap !== undefined) {
        if (Number.isInteger(t.withdrawCap) && (t.withdrawCap as number) >= 0) more.withdrawCap = t.withdrawCap as number;
        else problems.push(S.flow.badWithdrawCap);
      }
      if (t.digestCap !== undefined) {
        if (Number.isInteger(t.digestCap) && (t.digestCap as number) >= 200) more.digestCap = t.digestCap as number;
        else problems.push(S.flow.badDigestCap);
      }
      if (t.sliceCap !== undefined) {
        if (Number.isInteger(t.sliceCap) && (t.sliceCap as number) >= 0) more.sliceCap = t.sliceCap as number;
        else problems.push(S.flow.badTeamSliceCap);
      }
      if (t.diffCap !== undefined) {
        if (Number.isInteger(t.diffCap) && (t.diffCap as number) >= 500) more.diffCap = t.diffCap as number;
        else problems.push(S.flow.badDiffCap);
      }
      if (t.old !== undefined) {
        if (Number.isInteger(t.old) && (t.old as number) >= 0) more.old = t.old as number;
        else problems.push(S.flow.badOld);
      }
      if (t.continuityAt !== undefined) {
        if (typeof t.continuityAt === "string" && stages.some((s) => s.kind === "agent" && s.id === t.continuityAt)) more.continuityAt = t.continuityAt;
        else problems.push(S.flow.badContinuityAt);
      }
      // 固定要问的题考的是今晚整理完她醒来的样子：只能在最后一个专员那里问（那时候今晚的改动才全，没过还能发回它的会话改）
      const lastAgent = [...stages].reverse().find((s) => s.kind === "agent" && s.enabled)?.id;
      if (continuity.length && more.continuityAt !== undefined && more.continuityAt !== lastAgent) problems.push(S.flow.continuityNotLast(lastAgent ?? S.flow.noneAgent));
      if (leadOk) {
        teamCfg = {
          lead: { model: (l.model as Model | undefined) ?? "opus", skill: l.skill as string, turnMinutes: (l.turnMinutes as number | undefined) ?? 20 },
          maxFixRounds, continuity, tolerance, ...more,
        };
      }
    }
  }

  if (stages.some((s) => s.exam) && baseBlocks.length === 0) problems.push(S.flow.examNoBaseBlocks);

  for (const st of stages) {
    for (const a of st.after) if (!seen.has(a)) problems.push(S.flow.badAfter(st.id, a));
  }
  // 拓扑排序查环：剩下排不掉的就是环上或被环卡住的
  const indeg = new Map(stages.map((s) => [s.id, s.after.filter((a) => seen.has(a)).length]));
  const queue = stages.filter((s) => indeg.get(s.id) === 0).map((s) => s.id);
  let sorted = 0;
  while (queue.length) {
    const id = queue.shift()!;
    sorted++;
    for (const s of stages) if (s.after.includes(id)) {
      const n = indeg.get(s.id)! - 1;
      indeg.set(s.id, n);
      if (n === 0) queue.push(s.id);
    }
  }
  if (sorted < stages.length) {
    const stuck = stages.filter((s) => indeg.get(s.id)! > 0).map((s) => s.id);
    problems.push(S.flow.afterCycle(stuck.join(S.marks.listSep)));
  }

  if (team.coordinator?.persona && !team.personasFile) problems.push(S.flow.coordinatorNoFile);

  // 回放的准备命令：没写的不放进结果（流程的 JSON、哈希跟以前一字不差）
  const replay: Pick<FlowConfig, "replayPrep" | "replayOverlay" | "replayFinish"> = {};
  if (raw.replayFinish !== undefined) {
    const v = raw.replayFinish;
    if (Array.isArray(v) && v.every((c) => isStrs(c) && c.length > 0 && c.every((a) => a.length > 0))) replay.replayFinish = v as string[][];
    else problems.push(S.flow.badReplayFinish);
  }
  if (raw.replayPrep !== undefined) {
    const v = raw.replayPrep;
    if (Array.isArray(v) && v.every((c) => isStrs(c) && c.length > 0 && c.every((a) => a.length > 0))) replay.replayPrep = v as string[][];
    else problems.push(S.flow.badReplayPrep);
  }
  if (raw.replayOverlay !== undefined) {
    const v = raw.replayOverlay;
    const okPath = (p: unknown): boolean => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.endsWith("/")
      && p.split("/").every((seg) => seg !== "" && seg !== "." && seg !== ".." && seg.toLowerCase() !== ".git");
    if (Array.isArray(v) && v.every(okPath)) replay.replayOverlay = v as string[];
    else problems.push(S.flow.badReplayOverlay);
  }

  // 键的顺序：replayFinish 排在另外两个回放的键后面
  if (replay.replayFinish) { const v = replay.replayFinish; delete replay.replayFinish; replay.replayFinish = v; }
  if (problems.length) throw new FlowError(problems);
  return { engine, maxParallel, budget, saveMode, auditModel, checks, exam, stages, ...team, ...replay, ...(teamCfg ? { team: teamCfg } : {}) };
}

/** personas.json 读进来：{ "<id>": { name, text } }，至少两个（一个做、一个审）；不对给问题 */
export function parsePersonas(raw: unknown): { personas: Personas | null; problems: string[] } {
  if (!isObj(raw)) return { personas: null, problems: [S.flow.personasNotObject] };
  const problems: string[] = [];
  const out: Personas = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!id.trim()) { problems.push(S.flow.personaEmptyId); continue; }
    if (!isObj(v) || typeof v.name !== "string" || !v.name.trim() || typeof v.text !== "string" || !v.text.trim()) {
      problems.push(S.flow.personaShape(id));
      continue;
    }
    out[id] = { name: v.name.trim(), text: v.text.trim() };
  }
  if (!problems.length && Object.keys(out).length < 2) problems.push(S.flow.personasTooFew);
  return problems.length ? { personas: null, problems } : { personas: out, problems: [] };
}

/** 流程里点名的 persona 都得在 personas.json 里 */
export function personaProblems(flow: FlowConfig, personas: Personas): string[] {
  const problems: string[] = [];
  const has = (id: string) => Object.hasOwn(personas, id);
  for (const s of flow.stages) {
    for (const id of [...(s.persona ? [s.persona] : []), ...(s.reviewers ?? []), ...(s.fixers ?? [])]) {
      if (!has(id)) problems.push(S.flow.personaMissing(s.id, id));
    }
  }
  if (flow.coordinator?.persona && !has(flow.coordinator.persona)) problems.push(S.flow.coordinatorPersonaMissing(flow.coordinator.persona));
  return [...new Set(problems)];
}

// ---- 写同一个文件的冲突 ----

/** 通配前的固定前缀 */
const prefixOf = (p: string): string => { const i = p.search(/\*/); return i < 0 ? p : p.slice(0, i); };
const concrete = (p: string): boolean => !p.includes("*");

/** 路径是否匹配通配：* 一段内任意，** 跨段 */
function globMatch(pat: string, path: string): boolean {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") {
      if (pat[i + 1] === "*") { re += ".*"; i++; } else re += "[^/]*";
    } else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`).test(path);
}

/** 路径是否落在 writes 范围内：匹配任一正向模式且不匹配任何 `!` 排除 */
export function matchWrites(writes: string[], path: string): boolean {
  const ex = writes.filter((w) => w.startsWith("!")).map((w) => w.slice(1));
  return writes.some((w) => !w.startsWith("!") && globMatch(w, path)) && !ex.some((e) => globMatch(e, path));
}

/** 保守：两个模式只要可能匹配到同一个路径就算冲突；一边是具体路径时精确判断 */
function patsMayOverlap(a: string, b: string): boolean {
  if (concrete(a) && concrete(b)) return a === b;
  if (concrete(a)) return globMatch(b, a);
  if (concrete(b)) return globMatch(a, b);
  const pa = prefixOf(a), pb = prefixOf(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** 排除只在对方是不带通配的具体路径时生效 */
function oneSided(a: StageSpec, b: StageSpec): boolean {
  const exA = a.writes.filter((w) => w.startsWith("!")).map((w) => w.slice(1));
  for (const pa of a.writes.filter((w) => !w.startsWith("!"))) {
    for (const pb of b.writes.filter((w) => !w.startsWith("!"))) {
      if (!patsMayOverlap(pa, pb)) continue;
      if (concrete(pb) && exA.some((e) => globMatch(e, pb))) continue;
      return true;
    }
  }
  return false;
}

export function conflict(a: StageSpec, b: StageSpec): boolean {
  if (a.memWrite && b.memWrite) return true;
  // 一边的排除只挡对方具体路径；两个方向都查，任一方向有重叠且没被排除就算冲突
  return oneSided(a, b) && oneSided(b, a);
}

export function runnable(
  flow: FlowConfig,
  st: { done: ReadonlySet<string>; failed: ReadonlySet<string>; running: ReadonlySet<string>; skipped: ReadonlySet<string> },
): StageSpec[] {
  const slots = flow.maxParallel - st.running.size;
  const picked: StageSpec[] = [];
  if (slots <= 0) return picked;
  const active = flow.stages.filter((s) => st.running.has(s.id));
  for (const s of flow.stages) {
    if (picked.length >= slots) break;
    if (!s.enabled) continue;
    if (st.done.has(s.id) || st.failed.has(s.id) || st.running.has(s.id) || st.skipped.has(s.id)) continue;
    // 依赖必须都 done：failed / skipped 的依赖自然挡住后面整条链
    if (!s.after.every((a) => st.done.has(a))) continue;
    if ([...active, ...picked].some((o) => conflict(s, o))) continue;
    picked.push(s);
  }
  return picked;
}

/** hh sleep plan：按引擎的排法一波一波推演今晚的先后（不看当天的 when，只标出来；关了的段不跑，但算满足依赖，和 runner 一样） */
export function planText(flow: FlowConfig): string {
  const off = flow.stages.filter((s) => !s.enabled);
  const done = new Set(off.map((s) => s.id));
  const empty = new Set<string>();
  const lines: string[] = [];
  const earlier: StageSpec[] = [];
  for (let wave = 1; ; wave++) {
    const picked = runnable(flow, { done, failed: empty, running: empty, skipped: empty });
    if (!picked.length) break;
    for (const s of picked) {
      const notes: string[] = [];
      if (s.after.length) notes.push(S.flow.planAfter(s.after.join(S.marks.listSep)));
      const clash = earlier.filter((o) => !s.after.includes(o.id) && conflict(s, o)).map((o) => o.id);
      if (clash.length) notes.push(S.flow.planClash(clash.join(S.marks.listSep)));
      const only = s.when.length === 1 && s.when[0] === "always" ? "" : S.flow.planOnly(s.when.join(S.marks.listSep));
      lines.push(S.flow.planWave(wave, s.id, notes.length ? S.flow.planNotes(notes.join(S.marks.clauseSep)) : "", only));
    }
    for (const s of picked) { done.add(s.id); earlier.push(s); }
  }
  for (const s of off) lines.push(S.flow.planOff(s.id));
  return lines.join("\n");
}

export function loadFlow(o: {
  file: string; lastGood: string; known: Known;
  read(p: string): string | null; write(p: string, s: string): void;
}): { flow: FlowConfig | null; source: "file" | "last-good" | "none"; problems: string[] } {
  const tryParse = (text: string): FlowConfig => {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { throw new FlowError([S.flow.notJson]); }
    return parseFlow(raw, o.known);
  };
  const safeRead = (p: string): { ok: true; text: string | null } | { ok: false; err: string } => {
    try { return { ok: true, text: o.read(p) }; } catch (e) { return { ok: false, err: (e as Error).message }; }
  };
  let problems: string[] = [];
  const f = safeRead(o.file);
  // 文件不存在 = 走旧整理（删掉 flow.json 就是回滚）；存在但读不进来或没过核对，才退回上一份能用的
  if (f.ok && f.text === null) return { flow: null, source: "none", problems: [] };
  if (!f.ok) problems = [S.flow.readError(f.err)];
  else {
    let flow: FlowConfig | null = null;
    try { flow = tryParse(f.text!); } catch (e) {
      problems = e instanceof FlowError ? e.problems : [S.flow.readError((e as Error).message)];
    }
    if (flow) {
      try { o.write(o.lastGood, f.text!); } catch (e) { problems = [S.flow.saveGoodError((e as Error).message)]; }
      return { flow, source: "file", problems };
    }
  }
  const g = safeRead(o.lastGood);
  if (g.ok && g.text !== null) {
    try { return { flow: tryParse(g.text), source: "last-good", problems }; } catch { problems = [...problems, S.flow.goodBroken]; }
  }
  return { flow: null, source: "none", problems };
}
