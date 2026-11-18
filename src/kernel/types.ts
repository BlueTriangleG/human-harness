// 内核适配层：一个 KernelSession = 一个原版 Claude Code 会话。Brain 只通过这些接口用内核，
// 换驱动（SDK / 命令行后台会话 / 测试用假内核）不影响上层。
import type { ZodRawShape } from "zod";
import type { QuotaReading } from "../brainstem/quota.ts";

/** HH 自己的工具在内核里的名字前缀（sdk 驱动把它们挂在叫 self 的 MCP 服务上；回报动作时去掉，记忆里渲染时加回来） */
export const MCP_PREFIX = "mcp__self__";

export type Priority = "now" | "next" | "later";

/** 内核回报的事件。turn-end = 一轮结束（含用量），Brain 据此判断上下文大小和下一步。 */
export type KernelEvent =
  | { type: "think"; text: string }
  | { type: "say"; text: string }
  | { type: "act"; tool: string; input: unknown; id?: string }
  /** images：工具结果里的图片（base64），看过的东西要能翻出来 */
  | { type: "result"; tool: string; text: string; isError: boolean; images?: Array<{ mediaType: string; data: string }> }
  /** background：这一轮结束时后台还在跑的任务数（帮手、后台命令）；它们交回时内核会自己再开一轮 */
  | { type: "turn-end"; ok: boolean; error?: string; usage: Usage; total?: TurnTotal; background?: number; backgroundTasks?: string[];
      /** 这一轮第一次调用读写了多少缓存（闲了一阵以后缓存还在不在，看它）；驱动不报就没有 */ first?: FirstCall;
      /** 这一轮被模型的安全分类器拦了、没有换模型重试（内核报 model_refusal_no_fallback）：拦的类别，比如 reasoning_extraction */ refused?: string;
      /** 这一轮被停过（CLI 那句提示、refusal 收尾、没换模型的拒绝，任一样）：不管最后成没成都报；被停过的会话 Brain 会换掉（④） */ stopped?: boolean }
  /** 订阅额度的读数（内核每次调用附带的限流信息） */
  | { type: "rate"; reading: QuotaReading }
  /** 这一轮在回哪几条消息（send 返回的编号）：每轮第一条回复上带，中途并进来的消息也会再报一次 */
  | { type: "answering"; ids: string[] };

/** 这一轮所有调用加起来（含子代理）：usage 只是最后一次调用，拿它算开销会少算好几倍 */
export interface TurnTotal { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number }

/** 一轮里第一次调用的输入：没进缓存的、读缓存的、写缓存的 */
export interface FirstCall { input: number; cacheRead: number; cacheWrite: number }

export interface Usage {
  /** 这一轮最后一次调用时的上下文大小（输入 + 读缓存 + 写缓存），用来判断要不要翻页 */
  contextTokens: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** 给内核的工具。handler 在 HH 进程里执行（SDK 进程内 MCP）。 */
export interface ToolDef {
  name: string;
  description: string;
  shape: ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export interface Hooks {
  /** 每次工具调用之后：返回要追加进上下文的文字（中央记忆增量），没有就 undefined */
  afterTool(): string | undefined;
  /** 每次工具调用之前：返回拒绝理由就拦下（比如非主线调用 send） */
  beforeTool(tool: string, input: unknown): string | undefined;
}

export interface SessionSpec {
  id: string;                 // 实例名，如 main / side-1
  model: string;
  /** 被安全分类器拒了就改用它（#0045）；不设就不带，跟以前一样 */
  fallbackModel?: string;
  /** 内核发来的、值得记一笔的事（目前只有拒绝后改用 fallback）；不设就不记 */
  log?: (msg: string, fields: Record<string, unknown>) => void;
  systemAppend: string;       // 纪元前缀（会话内不变）
  cwd: string;
  permissionMode: string;
  tools: ToolDef[];
  hooks: Hooks;
  onEvent: (ev: KernelEvent) => void;
  env?: Record<string, string>;
  claudeExecutable?: string | null;
  /** 非 bypass 模式下预先放行的工具（HH 自己的工具总是放行） */
  allowedTools?: string[];
  /** 额外的 MCP 服务器、本地插件目录（技能手册） */
  mcpServers?: Record<string, unknown>;
  plugins?: string[];
  /** The kernel's own tools this session gets, by name; nothing else of the kernel's reaches it (config kernel.builtinTools, or the region's own list) */
  builtinTools: string[];
}

export interface KernelSession {
  readonly id: string;
  /** 投递一条消息，返回它的编号（answering 事件里对得上）。origin=human 表示真人输入（只有外界消息才用）。 */
  send(text: string, opts?: { priority?: Priority; human?: boolean }): string;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  readonly busy: boolean;
  /** 内核自己的会话 id（SDK 的 session_id；控制台用它找 transcript），还不知道就 null */
  readonly sessionId?: string | null;
  /** 会话已经结束（进程退出 / 被关），不能再用，需要重开 */
  readonly dead: boolean;
  /**
   * 这一轮到现在已经花的、还没随 turn-end 报出去的用量（只看不清；一轮正常结束后是 0）。
   * 夜里整理的段、核依据被半路关掉（超时、中止）时拿它把这一轮花的记上；驱动不支持就没有这个方法
   */
  inFlight?(): TurnTotal;
  /**
   * 从这个会话现在的样子分叉一份、发一条消息、拿回复文字；分叉出来的会话不留、不回报任何事件、工具全拦
   * （翻页压缩用：整段历史按缓存价读）。驱动不支持就没有这个方法。
   */
  fork?(text: string, opts: { timeoutMs: number }): Promise<ForkResult>;
}

/** 分叉问一次的结果。ok=false：出错、被拦、超时（error 写原因），text 可能是半截 */
export interface ForkResult { ok: boolean; text: string; error?: string; total: TurnTotal }

/** 一次性调用：自带 system、不带工具、不留会话（闸门的判断用） */
export interface AskOpts { model: string; system: string; prompt: string; cwd: string; env?: Record<string, string>; claudeExecutable?: string | null; timeoutMs: number }
export interface AskResult { text: string; usage: { input: number; cacheRead: number; cacheWrite: number; output: number } }

export interface KernelDriver {
  ask?(o: AskOpts): Promise<AskResult>;
  open(spec: SessionSpec): KernelSession;
  /** 问一次订阅额度（5 小时 / 7 天用量）：临时开个连接问完就关；不支持或读不到就 null. "no-plan": the login has no plan
   *  limits at all (an API key, Bedrock, Vertex), so there is nothing to read */
  quota?(opts: { model: string; cwd: string; env?: Record<string, string>; claudeExecutable?: string | null }): Promise<QuotaReading | "no-plan" | null>;
}
