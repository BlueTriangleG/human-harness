// 脑区定义：每个脑区是什么、用什么模型、能用哪些工具、在别的脑区眼里叫什么。
// 角色说明放在会话第一条消息里（不进系统提示），这样所有脑区共用同一份前缀缓存。
import type { Config } from "../config.ts";
import { MEM_LIKE_TOOLS, MEM_READ_TOOLS, MEM_WRITE_TOOLS } from "../tools/memtools.ts";
import { B } from "../lang/index.ts";

export type Role = "main" | "side" | "speech" | "perception" | "hippocampus" | "deep";
export type ModelTier = "opus" | "sonnet" | "haiku";

export interface RegionSpec {
  id: string;
  role: Role;
  tier: ModelTier;
  label: string;          // 记忆里怎么标它：主线是空的（就是自己），另一头、下意识这些才标出来
  roleText: string;       // 会话第一条消息
  tools: readonly string[];
  /** 能不能对外发消息；speech 只能发短句 */
  outlet: "full" | "short" | "none";
  /** 只给这些内置工具（不写 = 全套）；下意识只能看，不能动手 */
  builtinTools?: readonly string[];
  /** false = 不挂 B站 等外部 MCP 和技能插件 */
  external?: boolean;
}

/** 自查的工具：和书架目录一起上线（learning.shelf 开着才给，不然她看不到书架却能自查，A–C 阶段的行为就变了） */
const ASK_TOOL = "what_do_i_know";
/** 夜里整理看学习的工作单：只给海马，和书架一起上线（learning.shelf 开着才给）；没接学习时它自己回「笔记本没开」 */
const LEARN_WORKLIST_TOOL = "learn_worklist";
/** 夜里要进笔记本的候选先交给把关：只给海马，也跟着 learning.shelf；没接学习时它也自己回「笔记本没开」 */
const LEARN_CHECK_TOOL = "learn_check";

const MAIN_TOOLS = ["message", "sticker", "jot_down", "on_it", "set_bar", "done_with", "mull_over", "remind", "reminders", "goals", "hands", "recall", ...MEM_READ_TOOLS, ...MEM_LIKE_TOOLS] as const;
const SIDE_TOOLS = ["jot_down", "on_it", "set_bar", "done_with", "remind", "reminders", "goals", "hands", "recall", ...MEM_READ_TOOLS, ...MEM_LIKE_TOOLS] as const;

/** 前台能看到的文字里不能有的词（她只知道这都是自己的脑子，不知道怎么分的） */
export const STRUCTURE_WORDS = /另一头|后台|主线|副线|meanwhile|\bside\b|几条线|最多同时|前台|分身|另一个我/;

// 措辞原则：她只有一个自己。并行是"一心多用"，不是好几个自己；感知是"下意识"，交给主线是"好好想想"。
// 别出现"主线 / 副线 / 子代理 / 交接"这类字眼。
export function regionSpecs(cfg: Config): RegionSpec[] {
  const ask = cfg.learning.shelf ? [ASK_TOOL] : [];
  // 夜里学习的两个工具也等书架上线才给：生产上有 OpenAI key，部署那天就能用，开着会叫起把关、拖住整夜
  const night = cfg.learning.shelf ? [LEARN_WORKLIST_TOOL, LEARN_CHECK_TOOL] : [];
  // computer only for an instance that lists it (tools.extra); it keeps its place before browser, since the replay records each list in order
  const computer = cfg.tools.extra.includes("computer") ? ["computer"] : [];
  const specs: RegionSpec[] = [
    {
      id: "main", role: "main", tier: "opus", label: "", outlet: "full", tools: [...MAIN_TOOLS, ...computer, "browser", "what_reaches_me", "people_i_know", ...ask],
      roleText:
        B.specs.mainRole +
        B.specs.mainMultitasking +
        B.specs.mainSenses +
        B.specs.mainRhythm +
        B.specs.mainHeavyWorkToHands,
    },
  ];
  for (let i = 1; i <= cfg.regions.sideThreads; i++) {
    specs.push({
      id: `side-${i}`, role: "side", tier: "opus", label: "", outlet: "none", tools: [...SIDE_TOOLS, ...computer, "browser", ...ask],
      roleText:
        B.specs.sideRole +
        B.specs.sideSetBar +
        B.specs.sideDoneWith +
        B.specs.sideStuck +
        B.specs.sideJotDown +
        B.specs.sideAskPerson +
        B.specs.sideLatestRequestWins +
        B.specs.sideNoMetaTalk +
        B.specs.sideHeavyWorkToHands,
    });
  }
  // 下意识思考：只要结论的长研究放着慢慢想；过程不进任何主意识，结论作为她自己想到的回来。
  // id 必须叫 deep：事件库里 deep 翻事件不算碰过，sleep_digest 把 deep 的结论算「我」
  specs.push({
    id: "deep", role: "deep", tier: "opus", label: "", outlet: "none", tools: ["jot_down", "recall", ...MEM_READ_TOOLS, ...ask],
    roleText:
      B.specs.deepRole +
      B.specs.deepJotConclusion +
      B.specs.deepNoMetaTalk +
      B.specs.deepStaySilent,
  });
  specs.push({
    id: "speech", role: "speech", tier: "haiku", label: B.specs.speechLabel, outlet: "short", tools: ["message", "jot_down"],
    roleText:
      B.specs.speechRole +
      B.specs.speechOnlySettled,
  });
  for (const stream of cfg.regions.perception) {
    specs.push({
      id: `perception-${stream}`, role: "perception", tier: "haiku", label: B.specs.perceptionLabel, outlet: "none",
      tools: ["jot_down", "recall", "remember", "recall_person", "recall_period", "think_it_over", "ack"], builtinTools: ["Read", "Grep", "Glob"], external: false,
      roleText:
        B.specs.perceptionRole +
        B.specs.perceptionAckRoutine +
        B.specs.perceptionWhenToEscalate +
        B.specs.perceptionOwnReminders +
        B.specs.perceptionQuotaNotices +
        B.specs.perceptionRoundSummary +
        B.specs.perceptionWhenUnsure,
    });
  }
  specs.push({
    id: "hippocampus", role: "hippocampus", tier: "opus", label: B.specs.hippocampusLabel, outlet: "none", tools: ["jot_down", "recall", ...MEM_READ_TOOLS, ...MEM_WRITE_TOOLS, ...night],
    roleText:
      B.specs.hippocampusRole +
      B.specs.hippocampusPageAndSleep,
  });
  return specs;
}

export function modelFor(cfg: Config, tier: ModelTier): string { return cfg.models[tier]; }

/**
 * 她的常驻脑区用哪个模型：实例配置 models.byRole 按角色指定了就用它，没写就照旧按档（11-14：主线留一个模型、别的脑区换另一个，只按档分不出来）。
 * 只管常驻的脑区（brain 建脑区那一处）；临时开的一次性会话（导入、体检这些）照旧按档。
 */
export function modelOf(cfg: Config, spec: Pick<RegionSpec, "tier"> & { role?: Role }): string {
  const by = spec.role ? cfg.models.byRole?.[spec.role] : undefined;
  return typeof by === "string" && by.trim() !== "" ? by : modelFor(cfg, spec.tier);
}

/**
 * 退路模型：不对外说话的 opus 区（side、deep、海马）被拒或主模型用不了时退到 sonnet 档（#0045）；main 和别的档不带。
 * 退路和这个脑区真正用的主模型（modelOf，按角色指定了就是指定的那个）相同就不带：SDK 见到退路和主模型相同，开会话当场抛错
 * （11-13 两档都换成 Fable 后，支线和翻页用的海马全起不来）。
 */
export function fallbackFor(cfg: Config, spec: Pick<RegionSpec, "tier" | "outlet"> & { role?: Role }): string | undefined {
  if (spec.tier !== "opus" || spec.outlet !== "none") return undefined;
  const fallback = cfg.models.sonnet;
  return fallback && fallback !== modelOf(cfg, spec) ? fallback : undefined;
}
