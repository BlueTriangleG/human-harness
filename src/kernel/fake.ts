// 测试用假内核：不调模型。每次 send 之后由测试脚本决定这一轮"做了什么"。
import { z } from "zod";
import type { KernelDriver, KernelSession, SessionSpec, Priority, AskOpts, AskResult, ForkResult, TurnTotal, ToolDef, FirstCall } from "./types.ts";

/**
 * 跟真内核（SDK 的进程内 MCP 服务，validateToolInput）一样：工具的参数先照工具的 zod shape 解析，
 * handler 拿到的是解析后的（没写进 shape 的键被去掉）；不合格的不调 handler，回一条出错的结果
 */
export async function callTool(def: ToolDef, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const parsed = await z.object(def.shape).safeParseAsync(args);
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { text: `Input validation error: Invalid arguments for tool ${def.name}: ${why}`, isError: true };
  }
  return { text: await def.handler(parsed.data as Record<string, unknown>), isError: false };
}

export interface Sent { id: string; text: string; priority?: Priority; human?: boolean }

/** 一轮的剧本：可以说话、调用工具（会真的走 hooks 和 handler），最后结束。 */
export interface Script {
  say?: string;
  think?: string;
  /** 调工具之前先说的话（中途的自言自语） */
  sayBefore?: string;
  tool?: { name: string; args: Record<string, unknown> };
  contextTokens?: number;
  /** 这一轮的用量合计（不写 = turn-end 不带 total） */
  total?: TurnTotal;
  /** 这一轮第一次调用读写的缓存（不写 = turn-end 不带 first） */
  first?: FirstCall;
  /** 这一轮结束时后台还在跑的任务数（帮手、后台命令） */
  background?: number;
  /** 这一轮在回哪几条消息（不写 = 上一轮以后送进来的全部，跟真内核一样；[] = 内核自己开的一轮，不回谁） */
  answering?: string[];
  /** 这一轮被安全分类器拦了（拦的类别）：跟真内核一样，以 api_error:invalid_request 失败收尾，带上 refused */
  refused?: string;
  /** 这一轮被停过、但 CLI 接着跑成了：跟真内核一样，以成功收尾、带上 stopped */
  stopped?: boolean;
}

export class FakeSession implements KernelSession {
  readonly id: string;
  readonly spec: SessionSpec;
  readonly sent: Sent[] = [];
  readonly injected: string[] = [];   // afterTool 钩子追加进来的内容
  readonly denied: string[] = [];
  closed = false;
  busy = false;
  get dead(): boolean { return this.closed; }
  /** 跟真内核一样：发过第一条消息才有会话 id */
  get sessionId(): string | null { return this.sent.length ? `fake-${this.id}` : null; }
  /** 驱动设了 forkReply 才有：分叉问一次（翻页压缩），记下问了什么 */
  fork?: (text: string, opts: { timeoutMs: number }) => Promise<ForkResult>;
  readonly forked: string[] = [];
  constructor(spec: SessionSpec, forkReply?: ((text: string, s: FakeSession) => ForkResult | Promise<ForkResult>) | null) {
    this.spec = spec;
    this.id = spec.id;
    if (forkReply) {
      this.fork = async (text: string) => {
        this.forked.push(text);
        return forkReply(text, this);
      };
    }
  }
  private answered = 0;   // sent 里前几条已经回过了
  send(text: string, opts?: { priority?: Priority; human?: boolean }): string {
    const id = `${this.id}#${this.sent.length + 1}`;
    this.sent.push({ id, text, ...opts });
    return id;
  }
  /** 测试用：模拟一个旧会话在关闭后又冒出来的事件 */
  emitRaw(ev: Parameters<SessionSpec["onEvent"]>[0]): void { this.spec.onEvent(ev); }
  /** 测试驱动：模拟这一轮按剧本跑完 */
  async play(script: Script & { fail?: string }): Promise<void> {
    this.busy = true;
    const ev = this.spec.onEvent;
    if (script.fail) {
      this.busy = false;
      ev({ type: "turn-end", ok: false, error: script.fail, usage: { contextTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0 }, ...(script.stopped ? { stopped: true } : {}) });
      return;
    }
    if (script.refused) {
      this.busy = false;
      ev({ type: "turn-end", ok: false, error: "api_error:invalid_request", refused: script.refused, stopped: true, usage: { contextTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
      return;
    }
    const ids = script.answering ?? this.sent.slice(this.answered).map((m) => m.id);
    this.answered = this.sent.length;
    if (ids.length) ev({ type: "answering", ids });
    if (script.think) ev({ type: "think", text: script.think });
    if (script.sayBefore) ev({ type: "say", text: script.sayBefore });
    if (script.tool) {
      const deny = this.spec.hooks.beforeTool(script.tool.name, script.tool.args);
      if (deny) {
        this.denied.push(deny);
        ev({ type: "result", tool: script.tool.name, text: deny, isError: true });
      } else {
        ev({ type: "act", tool: script.tool.name, input: script.tool.args });
        const def = this.spec.tools.find((t) => t.name === script.tool!.name);
        const r = def ? await callTool(def, script.tool.args) : { text: "(no such tool)", isError: true };
        ev({ type: "result", tool: script.tool.name, text: r.text, isError: r.isError });
      }
      const extra = this.spec.hooks.afterTool();
      if (extra) this.injected.push(extra);
    }
    if (script.say) ev({ type: "say", text: script.say });
    this.busy = false;
    ev({ type: "turn-end", ok: true, usage: { contextTokens: script.contextTokens ?? 1000, cacheRead: 0, cacheWrite: 0, output: 0 }, ...(script.total ? { total: script.total } : {}), ...(script.background ? { background: script.background } : {}), ...(script.first ? { first: script.first } : {}), ...(script.stopped ? { stopped: true } : {}) });
  }
  interrupted = 0;
  /** 跟真的一样：打断会让这一轮以失败结束（SDK 报的是 error_during_execution，分不出是打断还是出错） */
  async interrupt(): Promise<void> {
    if (!this.busy) return;
    this.busy = false;
    this.interrupted++;
    this.spec.onEvent({ type: "turn-end", ok: false, error: "error_during_execution", usage: { contextTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  }
  async close(): Promise<void> { this.closed = true; }
  /** 测试用：这一轮还没报出去的用量（真内核在一轮中途被关时 tally 里那些） */
  inFlightTotal: TurnTotal | null = null;
  inFlight(): TurnTotal { return this.inFlightTotal ?? { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }; }
}

export class FakeDriver implements KernelDriver {
  readonly sessions: FakeSession[] = [];
  /** ask 的记录和剧本：answerAsk 返回 Error 就抛；askUsage 可以自定每次的用量 */
  readonly asks: AskOpts[] = [];
  private askFn: (o: AskOpts) => string | Error = () => "";
  askUsage: (o: AskOpts) => AskResult["usage"] = () => ({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  answerAsk(fn: (o: AskOpts) => string | Error): void { this.askFn = fn; }
  async ask(o: AskOpts): Promise<AskResult> {
    this.asks.push(o);
    const r = this.askFn(o);
    if (r instanceof Error) throw r;
    return { text: r, usage: this.askUsage(o) };
  }
  /** 设了就让新开的会话支持分叉（翻页压缩分叉主线）；不设 = 跟以前一样不支持 */
  forkReply: ((text: string, s: FakeSession) => ForkResult | Promise<ForkResult>) | null = null;
  /** 设了就让某些会话开不起来：返回原因就当场抛（像真 SDK 校验不过），null 照常开 */
  openError: ((spec: SessionSpec) => string | null) | null = null;
  open(spec: SessionSpec): FakeSession {
    // 跟真 SDK 一样：退路模型和主模型相同，开会话当场抛错（11-13 换 Fable 时测试没拦住，因为假内核不查）
    if (spec.fallbackModel && spec.fallbackModel === spec.model) throw new Error("Fallback model cannot be the same as the main model. Please specify a different model for fallbackModel option.");
    const why = this.openError?.(spec) ?? null;
    if (why) throw new Error(why);
    const s = new FakeSession(spec, this.forkReply);
    this.sessions.push(s);
    return s;
  }
  /** 某个实例名最近一次打开的会话 */
  latest(id: string): FakeSession {
    const s = [...this.sessions].reverse().find((x) => x.id === id);
    if (!s) throw new Error(`no fake session ${id}`);
    return s;
  }
}
