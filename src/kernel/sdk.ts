// SDK 驱动：每个脑区一个长期的 Agent SDK 流式会话（底层是原版 Claude Code，用她自己的订阅）。
// C1 原型的正式版：实时把思考 / 说话 / 工具调用回报给 Brain；工具调用前后走钩子。
import { randomUUID } from "node:crypto";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { KernelDriver, KernelSession, SessionSpec, Priority, TurnTotal, Usage, AskOpts, AskResult, ForkResult, FirstCall } from "./types.ts";
import { MCP_PREFIX } from "./types.ts";
import type { QuotaReading, QuotaWindow } from "../brainstem/quota.ts";
import { B } from "../lang/index.ts";

/** 内核被安全分类器拒了、改用 fallback 模型的通知：返回要记的字段；别的消息返回 null（#0045） */
/**
 * CLI 在一轮被安全检查停下、又接着跑一次时打的那句提示（informational）的开头。用 \u 转义写：原文别进仓库
 * （她修系统时会读代码；11-13 这句话被当成记忆反复喂回各个会话，越喂越停）
 */
export const STOP_NOTICE = "\u0073\u0061\u0066\u0065\u0067\u0075\u0061\u0072\u0064\u0073\u0020\u0073\u0074\u006f\u0070\u0070\u0065\u0064\u0020\u0074\u0068\u0065\u0020\u0072\u0065\u0073\u0070\u006f\u006e\u0073\u0065";

/** 这条消息说明这一轮被停过：CLI 那句提示、assistant 以 refusal 收尾、model_refusal_no_fallback（跟 hh numbers 那套出事口径认的是同三样） */
export function stopSignalOf(m: unknown): boolean {
  const x = m as { type?: unknown; subtype?: unknown; content?: unknown; message?: { stop_reason?: unknown } | null } | null;
  if (!x) return false;
  if (x.type === "system") return x.subtype === "model_refusal_no_fallback" || (x.subtype === "informational" && typeof x.content === "string" && x.content.includes(STOP_NOTICE));
  return x.type === "assistant" && x.message?.stop_reason === "refusal";
}

/** 被安全分类器拦了、没有换模型重试（model_refusal_no_fallback）：给拦的类别（没写就是 unknown）；别的消息给 null */
export function refusalNoFallbackOf(m: unknown): string | null {
  const x = m as { type?: unknown; subtype?: unknown; api_refusal_category?: unknown; apiRefusalCategory?: unknown } | null;
  if (!x || x.type !== "system" || x.subtype !== "model_refusal_no_fallback") return null;
  const c = x.api_refusal_category ?? x.apiRefusalCategory;
  return typeof c === "string" && c ? c : "unknown";
}

export function refusalFallbackNote(m: unknown): { original_model: string; fallback_model: string; api_refusal_category: string | null; scope: string | null; direction: string | null; retracted: number } | null {
  const x = m as { type?: string; subtype?: string; original_model?: string; fallback_model?: string; api_refusal_category?: string | null; scope?: string; direction?: string; retracted_message_uuids?: unknown };
  if (x.type !== "system" || x.subtype !== "model_refusal_fallback") return null;
  return {
    original_model: x.original_model ?? "", fallback_model: x.fallback_model ?? "", api_refusal_category: x.api_refusal_category ?? null,
    scope: x.scope ?? null, direction: x.direction ?? null,
    retracted: Array.isArray(x.retracted_message_uuids) ? x.retracted_message_uuids.length : 0,   // 只记条数：看上线后有没有半截被撤回
  };
}

interface UserMsg {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
  priority?: Priority;
  origin?: { kind: "human" };
  uuid?: ReturnType<typeof randomUUID>;
}

/** 一个可以一直往里推消息的异步队列（SDK 的流式输入）。 */
class InputQueue {
  private items: UserMsg[] = [];
  private waiter: (() => void) | null = null;
  private ended = false;
  push(m: UserMsg) {
    this.items.push(m);
    this.wake();
  }
  end() {
    this.ended = true;
    this.wake();
  }
  private wake() {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }
  async *iterate(): AsyncGenerator<UserMsg> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.ended) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
}

/**
 * 还没结束的回合数：SDK 自己开的那一轮（后台 Agent / Bash 做完时的 task-notification）不经过 send，
 * 看到它的 assistant 消息时也要算忙，不然那一轮里 busy 是 false。
 */
export function turnsAfter(turns: number, msgType: string, subagent = false): number {
  if (msgType === "assistant") return subagent ? turns : turns === 0 ? 1 : turns;   // 子代理的消息不算一轮
  if (msgType === "result") return Math.max(0, turns - 1);
  return turns;
}

/**
 * 这条回复在回哪几条消息：内核在每轮第一条（和中途并进新消息后的第一条）主线回复上标 send 时给的 uuid。
 * 子代理的消息、没标的消息返回空。
 */
export function answeringOf(m: { parent_tool_use_id?: unknown; user_message_uuid?: unknown; user_message_uuids?: unknown }): string[] {
  if (m.parent_tool_use_id != null) return [];
  if (Array.isArray(m.user_message_uuids)) return m.user_message_uuids.filter((u): u is string => typeof u === "string");
  return typeof m.user_message_uuid === "string" ? [m.user_message_uuid] : [];
}

/** 一轮里每次调用的用量加起来；同一条消息拆成几帧发来（几个内容块）只算一次 */
export class UsageTally {
  private total: TurnTotal = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  /** 每条消息记过的输出 token：同一条消息后面的帧输出才全（第一帧往往只有几个），读写缓存每帧一样 */
  private readonly outs = new Map<string, number>();
  /** 这一轮第一次调用的输入（只记，不进合计；take 以后重新记） */
  private firstCall: FirstCall | null = null;
  first(): FirstCall | null { return this.firstCall ? { ...this.firstCall } : null; }
  add(messageId: string | undefined, u: Record<string, number>): void {
    const out = u.output_tokens ?? 0;
    if (messageId) {
      const prev = this.outs.get(messageId);
      if (prev !== undefined) {   // 同一条消息的后面几帧：调用和输入只算一次，输出补上多出来的（11-04：以前只认第一帧，111 次调用只记了 1220 个输出）
        if (out > prev) { this.total.output += out - prev; this.outs.set(messageId, out); }
        return;
      }
      this.outs.set(messageId, out);
    }
    this.firstCall ??= { input: u.input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 };
    this.total.calls += 1;
    this.total.input += u.input_tokens ?? 0;
    this.total.cacheRead += u.cache_read_input_tokens ?? 0;
    this.total.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.total.output += out;
  }
  /** 到现在的合计，不清空 */
  peek(): TurnTotal { return { ...this.total }; }
  take(): TurnTotal {
    const t = this.total;
    this.total = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    this.outs.clear();
    this.firstCall = null;
    return t;
  }
}

/**
 * 每轮结束那一帧（result）的用量是这一轮自己的合计，输出 token 只有它准：每条 assistant 消息上带的是开头那一刻的数
 * （11-05 线上：分叉写了约 4000 字，按消息记的输出只有 5）。读写缓存照旧按调用加，输出取两者里大的
 */
export function withResultOutput(total: TurnTotal, result: unknown): TurnTotal {
  const out = (result as { usage?: { output_tokens?: unknown } } | null)?.usage?.output_tokens;
  return typeof out === "number" && out > total.output ? { ...total, output: out } : total;
}

/** 这条回复其实是 API 报错（被安全拦、额度没了、过载…）：内核把报错写成一段话，不能当她说的（11-01 12:59 连着 7 次进了记忆） */
export function apiErrorOf(m: { error?: unknown; isApiErrorMessage?: unknown }): string | null {
  if (typeof m.error === "string" && m.error) return m.error;
  return m.isApiErrorMessage === true ? "unknown" : null;
}

/** 工具结果拆成文字和图片（图片以前被丢掉了，看过的东西要能翻出来） */
export function toolParts(content: unknown): { text: string; images: Array<{ mediaType: string; data: string }> } {
  if (typeof content === "string") return { text: content, images: [] };
  const images: Array<{ mediaType: string; data: string }> = [];
  let text = "";
  if (Array.isArray(content)) {
    for (const c of content as Array<Record<string, unknown>>) {
      if (!c || typeof c !== "object") continue;
      if ("text" in c) text += String(c.text);
      else if (c.type === "image") {
        const src = c.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
        if (src && src.type === "base64" && typeof src.data === "string") images.push({ mediaType: String(src.media_type ?? "image/png"), data: src.data });
      }
    }
  }
  return { text, images };
}

/**
 * What a kernel session is opened with. The kernel's own tools are the ones the spec names and no others; the MCP servers
 * are the ones passed here and no others (the connectors of the signed-in claude.ai account are not loaded); no settings
 * file is read. So nothing reaches the role that HH did not hand it.
 */
export function sessionOptions(spec: SessionSpec, server: ReturnType<typeof createSdkMcpServer>): Options {
  const bypass = spec.permissionMode === "bypassPermissions";
  return {
    model: spec.model,
    ...(spec.fallbackModel ? { fallbackModel: spec.fallbackModel } : {}),
    cwd: spec.cwd,
    systemPrompt: { type: "preset", preset: "claude_code", append: spec.systemAppend, excludeDynamicSections: true },
    thinking: { type: "adaptive", display: "summarized" },   // 新模型默认不给思考原文（omitted），要 summarized 才看得到她在想什么
    settingSources: [],
    permissionMode: spec.permissionMode as "default",
    ...(bypass ? { allowDangerouslySkipPermissions: true } : {}),
    mcpServers: { ...(spec.mcpServers as Record<string, never> | undefined), self: server },
    // only the servers passed here: the connectors of the signed-in claude.ai account (documents, mail, calendar) are not loaded
    strictMcpConfig: true,
    ...(spec.plugins?.length ? { plugins: spec.plugins.map((path) => ({ type: "local" as const, path })) } : {}),
    tools: spec.builtinTools,
    allowedTools: [...spec.tools.map((t) => MCP_PREFIX + t.name), ...(spec.allowedTools ?? [])],
    // 关掉内核自己的「The user hasn't heard from you in a while…」：英文提醒逼她写英文的进度汇报，夹在回复里发出去过（11-02）
    env: { ...process.env, CLAUDE_CODE_SILENT_TURN_REMINDER: "0", ...spec.env },
    ...(spec.claudeExecutable ? { pathToClaudeCodeExecutable: spec.claudeExecutable } : {}),
  };
}

/** The session's first message: the kernel's own tools and the MCP servers it has. Logged, so a role's log shows what reached it. */
export function givenOf(m: unknown): { builtin: string[]; mcpServers: string[] } | null {
  const x = m as { type?: unknown; subtype?: unknown; tools?: unknown; mcp_servers?: unknown } | null;
  if (!x || x.type !== "system" || x.subtype !== "init") return null;
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.map((t) => (typeof t === "string" ? t : String((t as { name?: unknown } | null)?.name ?? ""))) : []);
  return { builtin: names(x.tools).filter((t) => !t.startsWith("mcp__")), mcpServers: names(x.mcp_servers) };
}

export class SdkSession implements KernelSession {
  readonly id: string;
  private readonly spec: SessionSpec;
  private readonly input = new InputQueue();
  private readonly q: ReturnType<typeof query>;
  private lastUsage: Usage = { contextTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  private turns = 0;          // 还没结束的回合数（忙的时候插进来的话会并进当前回合，不另算）
  private background: string[] = [];   // 这一轮结束（Stop 钩子）时后台还在跑的任务（类型：说明）
  private apiError: string | null = null;
  private refused: string | null = null;     // 这一轮被安全分类器拦了、没换模型重试：拦的类别，收尾时随 turn-end 报
  private stopped = false;                   // 这一轮被停过（不管最后成没成），收尾时随 turn-end 报（④：被停过的会话 Brain 会换掉）
  private readonly tally = new UsageTally();   // 这一轮最后一条主线回复是 API 报错（后面又正常回了就清掉）
  private closed = false;
  dead = false;
  sessionId: string | null = null;

  get busy(): boolean { return !this.dead && this.turns > 0; }

  /** 关闭以后不再往外报任何事件（防止旧会话的尾巴打乱新会话的状态） */
  private emit(ev: Parameters<SessionSpec["onEvent"]>[0]): void {
    if (!this.closed) this.spec.onEvent(ev);
  }

  constructor(spec: SessionSpec) {
    this.spec = spec;
    this.id = spec.id;
    this.q = query({
      prompt: this.input.iterate(),
      options: {
        ...this.options(this.mcpServer(true)),
        hooks: {
          PreToolUse: [{ hooks: [async (input: unknown) => {
            const i = input as { tool_name?: string; tool_input?: unknown };
            const name = (i.tool_name ?? "").replace(MCP_PREFIX, "");
            const deny = spec.hooks.beforeTool(name, i.tool_input);
            return deny
              ? { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: deny } }
              : {};
          }] }],
          PostToolUse: [{ hooks: [async (input: unknown) => postToolUse(input, spec.hooks.afterTool)] }],
          // 她这一轮说完了：记下后台还有几个任务在跑（帮手、后台命令），它们交回时内核会自己再开一轮
          Stop: [{ hooks: [async (input: unknown) => {
            this.background = backgroundTasks(input);
            return {};
          }] }],
        },
      },
    });
    void this.pump();
  }

  /** HH 自己的工具挂在叫 self 的进程内 MCP 服务上。live=false（分叉用）：定义一模一样，调了也只回一句不执行 */
  private mcpServer(live: boolean): ReturnType<typeof createSdkMcpServer> {
    return createSdkMcpServer({
      name: "self",
      version: "0.1.0",
      tools: this.spec.tools.map((t) =>
        tool(t.name, t.description, t.shape, async (args: Record<string, unknown>) => ({
          content: [{ type: "text" as const, text: live ? await t.handler(args) : B.sdk.forkNoTools }],
        }), { alwaysLoad: true }),   // HH 工具一开始就加载，不用她先 ToolSearch
      ),
    });
  }

  /** 会话的参数（钩子另加）。分叉要用一模一样的一份：模型、系统提示、工具清单差一点，缓存就对不上，整段历史得重新写。 */
  private options(server: ReturnType<typeof createSdkMcpServer>): Options { return sessionOptions(this.spec, server); }

  /**
   * 分叉问一次（翻页压缩）：带着这个会话到现在的全部历史另开一份，发 text，拿最后的回复。
   * 参数和主会话一模一样（缓存对得上，整段历史按读缓存算）；工具一律在调用前拦掉；分叉的会话不写盘（persistSession=false）、
   * 不回报任何事件——它不是她的一轮，不进中央记忆、不数工具次数、不标没发出去的话。
   */
  async fork(text: string, opts: { timeoutMs: number }): Promise<ForkResult> {
    const tally = new UsageTally();
    if (!this.sessionId) return { ok: false, text: "", error: "no session id yet", total: tally.take() };
    const q = query({
      prompt: text,
      options: {
        ...this.options(this.mcpServer(false)),
        resume: this.sessionId,
        forkSession: true,
        persistSession: false,
        hooks: {
          PreToolUse: [{ hooks: [async () => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "deny" as const, permissionDecisionReason: B.sdk.forkNoTools } })] }],
        },
      },
    });
    // 压缩稿得一次调用写完：调了工具（被拦后接着写）、被安全拦了又重来，都会变成两次以上的调用，只剩后半截——算失败（复核 #6）
    const parts = new Map<string, string>();   // 每次调用（消息 id）说的话
    let tools = 0;
    let apiError: string | null = null;
    const said = (): string => [...parts.values()].join("");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ForkResult>((res) => {
      timer = setTimeout(() => res({ ok: false, text: said(), error: "timeout", total: tally.take() }), opts.timeoutMs);
    });
    const run = (async (): Promise<ForkResult> => {
      for await (const m of q) {
        if (m.type === "assistant" && (m as { parent_tool_use_id?: unknown }).parent_tool_use_id == null) {
          const msg = m.message as unknown as { id?: string; content?: unknown[]; usage?: Record<string, number> };
          if (msg.usage) tally.add(msg.id, msg.usage);
          const err = apiErrorOf(m as Parameters<typeof apiErrorOf>[0]);
          if (err) { apiError = err; continue; }
          const id = msg.id ?? `frame-${parts.size}`;
          for (const b of (msg.content ?? []) as Array<Record<string, unknown>>) {
            if (b.type === "tool_use") tools += 1;
            else if (b.type === "text" && typeof b.text === "string") parts.set(id, (parts.get(id) ?? "") + b.text);
          }
          if (!parts.has(id)) parts.set(id, "");
        }
        if (m.type === "result") {
          const r = m as { subtype: string; is_error?: boolean };
          const error = apiError ? `api_error:${apiError}`
            : r.subtype !== "success" ? r.subtype
            : r.is_error === true ? "is_error"
            : tools > 0 ? `tried ${tools} tool call(s)`
            : parts.size > 1 ? `took ${parts.size} calls`
            : null;
          return { ok: !error, text: said(), ...(error ? { error } : {}), total: withResultOutput(tally.take(), m) };
        }
      }
      return { ok: false, text: said(), error: "ended without result", total: tally.take() };
    })().catch((e: unknown) => ({ ok: false, text: said(), error: e instanceof Error ? e.message : String(e), total: tally.take() }));
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }

  send(text: string, opts: { priority?: Priority; human?: boolean } = {}): string {
    if (this.dead) throw new Error(`session ${this.id} is dead`);
    if (this.turns === 0) this.turns = 1;
    const uuid = randomUUID();
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(opts.priority ? { priority: opts.priority } : {}),
      ...(opts.human ? { origin: { kind: "human" as const } } : {}),
      uuid,
    });
    return uuid;
  }

  async interrupt(): Promise<void> { await this.q.interrupt(); }

  /** 这一轮还没报出去的用量（只看，不动 tally；别的脑区用不到，行为不变） */
  inFlight(): TurnTotal { return this.tally.peek(); }

  async close(): Promise<void> {
    this.closed = true;
    this.dead = true;
    this.input.end();
    this.q.close();
  }

  private async pump(): Promise<void> {
    const ev = (e: Parameters<SessionSpec["onEvent"]>[0]) => this.emit(e);
    try {
      for await (const m of this.q) {
        const sid = (m as { session_id?: unknown }).session_id;
        if (typeof sid === "string" && sid) this.sessionId = sid;
        if (stopSignalOf(m)) {
          if (!this.stopped) this.spec.log?.("turn stopped by the safety check", {});
          this.stopped = true;
        }
        const given = givenOf(m);
        if (given) this.spec.log?.("kernel session opened", given);
        const refusal = refusalFallbackNote(m);
        if (refusal) { this.spec.log?.("model refusal, fell back", refusal); continue; }   // 不是她说的话，也不是错误
        const refused = refusalNoFallbackOf(m);
        if (refused) { this.refused = refused; this.spec.log?.("model refusal, no fallback", { category: refused }); continue; }   // 这一轮收尾时报给 Brain
        if (m.type === "assistant" || m.type === "result") this.turns = turnsAfter(this.turns, m.type, (m as { parent_tool_use_id?: unknown }).parent_tool_use_id != null);
        if (m.type === "assistant") {
          const ids = answeringOf(m as Parameters<typeof answeringOf>[0]);
          if (ids.length) ev({ type: "answering", ids });
          const msg = m.message as unknown as { id?: string; content?: unknown[]; usage?: Record<string, number> };
          const u = msg.usage;
          if (u) {
            this.tally.add(msg.id, u);
            this.lastUsage = {
              contextTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
              cacheRead: u.cache_read_input_tokens ?? 0,
              cacheWrite: u.cache_creation_input_tokens ?? 0,
              output: u.output_tokens ?? 0,
            };
          }
          if ((m as { parent_tool_use_id?: unknown }).parent_tool_use_id == null) {
            this.apiError = apiErrorOf(m as Parameters<typeof apiErrorOf>[0]);
            if (this.apiError) continue;          // 报错那段话不当她说的：不进记忆、不发给人；这一轮按失败结束
          }
          for (const b of (msg.content ?? []) as Array<Record<string, unknown>>) {
            if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) ev({ type: "think", text: b.thinking });
            else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) ev({ type: "say", text: b.text });
            else if (b.type === "tool_use") ev({ type: "act", tool: String(b.name).replace(MCP_PREFIX, ""), input: b.input, ...(b.id ? { id: String(b.id) } : {}) });
          }
        } else if (m.type === "user") {
          const content = (m.message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const b of content as Array<Record<string, unknown>>) {
              if (b.type === "tool_result") {
                const parts = toolParts(b.content);
                ev({ type: "result", tool: String(b.tool_use_id ?? ""), text: parts.text, isError: b.is_error === true, ...(parts.images.length ? { images: parts.images } : {}) });
              }
            }
          }
        } else if ((m as { type: string }).type === "rate_limit_event") {
          const reading = parseRateLimitEvent(m);
          if (reading) ev({ type: "rate", reading });
        } else if (m.type === "result") {
          // result 列着这一轮消化过的每一条：内部唤醒开的一轮中途并进来的消息，前面的帧不会标它，只有这里报
          const ids = answeringOf(m as Parameters<typeof answeringOf>[0]);
          if (ids.length) ev({ type: "answering", ids });
          const r = m as { subtype: string; is_error?: boolean };
          const bg = this.background;
          this.background = [];
          const error = this.apiError ? `api_error:${this.apiError}` : r.subtype !== "success" ? r.subtype : r.is_error === true ? "is_error" : null;
          this.apiError = null;
          const refusedNow = this.refused;
          this.refused = null;
          const stoppedNow = this.stopped;
          this.stopped = false;
          const first = this.tally.first();
          ev({ type: "turn-end", ok: !error, ...(error ? { error } : {}), usage: this.lastUsage, total: withResultOutput(this.tally.take(), m), ...(bg.length ? { background: bg.length, backgroundTasks: bg } : {}), ...(first ? { first } : {}), ...(error && refusedNow ? { refused: refusedNow } : {}), ...(stoppedNow ? { stopped: true } : {}) });
        }
      }
      // 流正常结束（进程退出）：会话死了
      this.dead = true;
      this.turns = 0;
      ev({ type: "turn-end", ok: false, error: "session ended", usage: this.lastUsage });
    } catch (e) {
      this.dead = true;
      this.turns = 0;
      ev({ type: "turn-end", ok: false, error: e instanceof Error ? e.message : String(e), usage: this.lastUsage });
    }
  }
}

/**
 * 工具调用之后补别人的新记录（PostToolUse）。子代理（她开的 Agent）里调的工具也会触发这个钩子（输入带 agent_id）：
 * 不补——补了，记录进的是子代理的上下文，她自己那头的游标却走过去了，那几条她就再也看不到（11-13 复核：她的子代理里有 129 次这样的补充，7 次是真人的消息）
 */
export async function postToolUse(input: unknown, afterTool: () => string | undefined): Promise<{ hookSpecificOutput?: { hookEventName: "PostToolUse"; additionalContext: string } }> {
  if (typeof (input as { agent_id?: unknown } | null)?.agent_id === "string") return {};
  const extra = afterTool();
  return extra ? { hookSpecificOutput: { hookEventName: "PostToolUse" as const, additionalContext: extra } } : {};
}

/** Stop 钩子的输入里后台还在跑的任务（background_tasks：running/pending 且在后台的），写成「类型：说明」；老版本没有这个字段就是空的 */
export function backgroundTasks(input: unknown): string[] {
  const t = (input as { background_tasks?: unknown } | null)?.background_tasks;
  if (!Array.isArray(t)) return [];
  return t.map((x) => { const b = (x ?? {}) as { type?: unknown; description?: unknown }; return B.sdk.backgroundTaskItem(String(b.type ?? "?"), String(b.description ?? "").slice(0, 80)); });
}

type RawWindow = { utilization?: number | null; resets_at?: string | null } | null | undefined;

function win(w: RawWindow): QuotaWindow | undefined {
  if (!w || typeof w.utilization !== "number") return undefined;
  const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
  return { used: w.utilization, resetsAt: Number.isFinite(t) ? t : null };
}

/** SDK 的用量回复 → 读数 */
export function parseUsageResponse(r: unknown): QuotaReading | "no-plan" | null {
  const x = r as { rate_limits_available?: boolean; rate_limits?: { five_hour?: RawWindow; seven_day?: RawWindow } | null } | null;
  // the SDK's own word: false when plan rate limits do not apply (an API key, Bedrock, Vertex, or no profile scope)
  if (x?.rate_limits_available === false) return "no-plan";
  if (!x?.rate_limits_available || !x.rate_limits) return null;
  const fiveHour = win(x.rate_limits.five_hour);
  const sevenDay = win(x.rate_limits.seven_day);
  if (!fiveHour && !sevenDay) return null;
  return { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** 每次调用附带的限流事件 → 读数（这里 utilization 是 0–1 的比例、resetsAt 是秒，跟 budget.py 读的一样） */
export function parseRateLimitEvent(m: unknown): QuotaReading | null {
  const i = (m as { rate_limit_info?: { status?: string; resetsAt?: number; rateLimitType?: string; utilization?: number } }).rate_limit_info;
  if (!i) return null;
  const resetsAt = typeof i.resetsAt === "number" ? i.resetsAt * 1000 : null;
  if (i.status === "rejected") return { rejected: { window: i.rateLimitType ?? "", resetsAt } };
  if (typeof i.utilization !== "number") return null;
  const used = i.utilization * 100;
  if (i.rateLimitType === "five_hour") return { fiveHour: { used, resetsAt } };
  if (i.rateLimitType === "seven_day") return { sevenDay: { used, resetsAt } };
  return null;
}

export class SdkDriver implements KernelDriver {
  open(spec: SessionSpec): SdkSession { return new SdkSession(spec); }

  /** 一次性调用：自带 system（替掉 Claude Code 默认提示）、没有工具、不写 transcript、只跑一轮 */
  async ask(o: AskOpts): Promise<AskResult> {
    const q = query({
      prompt: o.prompt,
      options: {
        model: o.model, cwd: o.cwd, systemPrompt: o.system, tools: [], settingSources: [], maxTurns: 1, persistSession: false,
        ...(o.env ? { env: { ...process.env, ...o.env } } : {}),
        ...(o.claudeExecutable ? { pathToClaudeCodeExecutable: o.claudeExecutable } : {}),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error("ask timed out")), o.timeoutMs); });
    const run = (async (): Promise<AskResult> => {
      for await (const m of q) {
        if (m.type !== "result") continue;
        if (m.subtype !== "success") throw new Error(`ask failed: ${m.subtype}`);
        const u = m.usage as { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } | undefined;
        return { text: m.result, usage: { input: u?.input_tokens ?? 0, cacheRead: u?.cache_read_input_tokens ?? 0, cacheWrite: u?.cache_creation_input_tokens ?? 0, output: u?.output_tokens ?? 0 } };
      }
      throw new Error("ask ended without result");
    })();
    run.catch(() => {});   // 超时后 run 被 close 打断报的错不用管
    try {
      return await Promise.race([run, timeout]);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }

  /** 临时开一个空连接问 /usage 的额度数据（接口还是实验性的，不调模型），问完就关 */
  async quota(opts: { model: string; cwd: string; env?: Record<string, string>; claudeExecutable?: string | null }): Promise<QuotaReading | "no-plan" | null> {
    const input = new InputQueue();
    const q = query({
      prompt: input.iterate(),
      options: {
        model: opts.model, cwd: opts.cwd, settingSources: [], tools: [],
        ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
        ...(opts.claudeExecutable ? { pathToClaudeCodeExecutable: opts.claudeExecutable } : {}),
      },
    });
    try {
      const f = (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (o: { skipBehaviors: boolean }) => Promise<unknown> })
        .usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
      if (typeof f !== "function") return null;
      return parseUsageResponse(await f.call(q, { skipBehaviors: true }));
    } finally {
      input.end();
      q.close();
    }
  }
}
