// 对照工具的假东西：世界（world.ts）接线时拿来顶替真内核、真网关、真的外部命令、真的 OpenAI 的那几样，每样都把经手的事记进记录。
// 内核是 src/kernel/fake.ts 的 FakeDriver 套一层记录（那个文件不动）；网关、外部命令是记录用的假实现；
// OpenAI 是给记录器的假 fetch 用的回答（向量、判断两个地址，别的地址不回，fetch 就抛「网络是关的」）。
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { FakeDriver, type FakeSession } from "../kernel/fake.ts";
import type { AskOpts, AskResult, ForkResult, KernelDriver, SessionSpec } from "../kernel/types.ts";
import type { QuotaReading } from "../brainstem/quota.ts";
import type { GatewayCaller } from "../gateway/client.ts";
import type { Channel } from "../channels/types.ts";
import type { RunResult, Runner } from "../util/run.ts";
import { mulberry32 } from "./determinism.ts";
import { thrown, type Recorder } from "./recorder.ts";

/** 只在工作副本里有的假 key：事件记忆、学习照真的建起 OpenAI 客户端，请求全被假 fetch 接住 */
export const OFFLINE_KEY = "parity-offline";
const EMBEDDINGS = "https://api.openai.com/v1/embeddings";
const DECISIONS = "https://api.openai.com/v1/decisions";

/** 场景给外部命令的回答：认得的命令给结果，别的给 undefined（就是默认的：成功、没输出） */
export type RunAnswer = (cmd: string, args: readonly string[], opts: unknown) => RunResult | undefined;

/**
 * 世界自带的回答：情境（src/memory/situation.ts）每次叫醒主线、闸门每次小判断之前要跑的命令。它们都回空的话，
 * 把她脚本的输出拼进「只给你看」那一段（变了才给、隔半小时再给）、拼进小判断「现在在做」的那些代码永远只见到空串。
 * 情境只跑一条命令：目标模块的 `<python> modules/goals/scripts/goals.py brief main`，输出原样用（去掉首尾空白）。
 * 回的样子照树自己的测试（test/units.test.ts 的「目标：剪完 g30」），内容是编的；带一个「（N 分钟前）」，比「变没变」时去掉数字的那一步也走到。
 * 场景自己的 answerRun 认得的命令先听场景的
 */
export const WORLD_ANSWERS: ReadonlyArray<{ what: string; match: (cmd: string, args: readonly string[], cfg: Config) => boolean; answer: RunResult | ((args: readonly string[], cfg: Config) => RunResult) }> = [
  {
    what: "goals.py brief main",
    // the goals module's script (modules/goals/scripts/goals.py brief main)
    match: (cmd, args, cfg) => cmd === cfg.tools.python && args.length === 3 && args[0]!.endsWith("/modules/goals/scripts/goals.py") && args[1] === "brief" && args[2] === "main",
    answer: { code: 0, stdout: "目标：把工具墙整理完 g30（40 分钟前）\n", stderr: "" },
  },
  {
    // the goals tool asks it after setting, moving or blocking a goal: answered as the script does, from the workspace copy
    what: "goals.py topic",
    match: (cmd, args, cfg) => cmd === cfg.tools.python && args[0]!.endsWith("/modules/goals/scripts/goals.py") && args[1] === "topic",
    answer: (args, cfg) => ({ code: 0, stdout: goalsTopic(join(cfg.workspace, String(cfg.modules?.goals?.dataFile ?? "memory/goals/goals.json")), args.slice(2)), stderr: "" }),
  },
];

/** goals.py topic, as the script answers it (modules/goals/scripts/goals.py cmd_topic): the title and why of the goal an add,
 *  log or block is about, as JSON; null for anything else or an unknown goal */
export function goalsTopic(dataFile: string, args: readonly string[]): string {
  const opts = new Set(["why", "done-when", "parent", "due", "link"]);
  let g: { title?: string; why?: string } | undefined;
  if (args[0] === "add") {
    let why: string | undefined;
    const rest: string[] = [];
    for (let i = 1; i < args.length; i++) {
      const a = args[i]!;
      if (a.startsWith("--") && opts.has(a.slice(2)) && i + 1 < args.length) { if (a === "--why") why = args[i + 1]; i++; } else rest.push(a);
    }
    g = { title: rest.slice(1).join(" ").trim(), ...(why !== undefined ? { why } : {}) };
  } else if ((args[0] === "log" || args[0] === "block") && args.length > 1) {
    try { g = (JSON.parse(readFileSync(dataFile, "utf8")) as { goals?: Array<{ id?: string; title?: string; why?: string }> }).goals?.find((x) => x.id === args[1]); } catch { g = undefined; }
  }
  return JSON.stringify(g?.title ? { title: g.title, why: g.why } : null);
}

/** 世界自带的回答接成 RunAnswer（每次给一份新的，树改了它也不串） */
export function worldAnswers(cfg: Config): RunAnswer {
  return (cmd, args) => {
    const hit = WORLD_ANSWERS.find((x) => x.match(cmd, args, cfg));
    return hit ? (typeof hit.answer === "function" ? hit.answer(args, cfg) : { ...hit.answer }) : undefined;
  };
}

const hashSeed = (s: string): number => createHash("sha256").update(s).digest().readUInt32BE(0);

/** 一段话的假向量：按它的哈希定种子，dims 维，单位长度（同一句话永远是同一个向量） */
function hashVector(text: string, dims: number): number[] {
  const rnd = mulberry32(hashSeed(text));
  const v = Array.from({ length: dims }, () => rnd() * 2 - 1);
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

/** 判断题的假概率：按题目的哈希取 0.05–0.95（0.05 一档），门槛上下都有，是和不是两条路都走得到 */
const hashProbability = (s: string): number => ((hashSeed(s) % 19) + 1) * 5 / 100;

/**
 * 假的 OpenAI：向量（embeddings）和判断（decisions，请求和回答的样子照 src/learning/decisions.ts）两个地址给确定的回答；
 * 别的地址给 undefined（记录器的 fetch 就抛「网络是关的」）
 */
export function offlineOpenAI(url: string, body: unknown): unknown {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (url === EMBEDDINGS) {
    const input = Array.isArray(b.input) ? b.input : [b.input];
    const dims = typeof b.dimensions === "number" ? b.dimensions : 1536;
    return { object: "list", model: b.model, data: input.map((t, index) => ({ object: "embedding", index, embedding: hashVector(String(t), dims) })), usage: { prompt_tokens: 0, total_tokens: 0 } };
  }
  if (url === DECISIONS) {
    const input = String(b.input ?? "");
    const qs = (Array.isArray(b.questions) ? b.questions : []) as Array<{ type?: unknown; name?: unknown; instructions?: unknown }>;
    return {
      answers: qs.map((q) => ({ name: q.name, type: q.type ?? "predicate", probability: hashProbability(`${input}\n${String(q.name)}\n${String(q.instructions)}`) })),
      usage: { input_tokens: Math.ceil(input.length / 4) + 20 * qs.length },
    };
  }
  return undefined;
}

/** 只留数据：函数去掉，全是函数的对象（hooks 这种）整个去掉。按对象自己的键走，接口以后加了字段也照记 */
function dataOf(o: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "function") continue;
    const vals = v && typeof v === "object" && !Array.isArray(v) ? Object.values(v) : null;
    if (vals && vals.length > 0 && vals.every((x) => typeof x === "function")) continue;
    out[k] = v;
  }
  return out;
}

/** open 里没给的可选项写 null（格式表的约定） */
const OPEN_NULLS = { fallbackModel: null, claudeExecutable: null, builtinTools: null, allowedTools: null, mcpServers: null, plugins: null, env: null };
/** 一个对象的键照原来的先后（没给这个对象就是 null） */
const keyOrder = (o: object | undefined): string[] | null => (o ? Object.keys(o) : null);
/** quota() 默认的读数：两个窗口都在中间，哪一档都不跨（5 小时 50/70/85/95、7 天 70/85/95，专注的线 90、并行的线 97） */
const DEFAULT_QUOTA: QuotaReading = { fiveHour: { used: 20, resetsAt: null }, sevenDay: { used: 30, resetsAt: null } };
/** 分叉默认回的固定短压缩稿 */
const FORK_TEXT = "（对照）分叉压缩的固定稿：这一页的经历压成了这一段。";

/**
 * 记录用的假内核：开会话记 open（规格里除了函数都记，工具的 schema 照 zod 渲成 JSON Schema），每条 send 记 send；
 * 演剧本时回给内核的工具结果记 result、工具后追加的记 inject、工具前拦下的记 deny；系统打断、关掉会话记 interrupt、close
 * （少关一个会话，真的就是多留一个 Claude Code 进程）；ask 记 ask。
 * 记录的键是排过序的，先后本身是内容的三处另记：每个工具的参数照 shape 里的先后（paramOrder——真内核把 shape 原样交出去，
 * 参数的先后是模型读到的、也算在缓存的前缀里）、mcpServers 和 env 的键照规格里的先后（mcpServersOrder、envOrder）。
 * 跟真内核一样有额度读数（quota）和分叉（fork），各记一条 call；回什么场景可以换（quotaReading、forkAnswer）。
 * src/kernel/fake.ts 不动，只套在外面
 */
export class RecordingDriver extends FakeDriver {
  private readonly rec: Recorder;
  /** quota() 回的读数（null = 读不到） */
  quotaReading: QuotaReading | null = DEFAULT_QUOTA;
  /** 分叉问一次的回答 */
  forkAnswer: (text: string, s: FakeSession) => ForkResult | Promise<ForkResult> =
    () => ({ ok: true, text: FORK_TEXT, total: { calls: 1, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });

  constructor(rec: Recorder) {
    super();
    this.rec = rec;
    // 假内核自己的能力留的 call，不经场景用的 recordCall（drive.ts 是场景那一层的，这个文件不依赖它）；抛错的写法是同一个 thrown
    this.forkReply = async (text, s) => {
      const args = { region: s.id, text };
      try {
        const r = await this.forkAnswer(text, s);
        rec.add("call", { name: "fork", args, returned: r });
        return r;
      } catch (e) {
        rec.add("call", { name: "fork", args, threw: thrown(e) });
        throw e;
      }
    };
  }

  override open(spec: SessionSpec): FakeSession {
    const rec = this.rec;
    const region = spec.id;
    const { id: _id, tools, ...rest } = spec;
    rec.add("open", {
      ...OPEN_NULLS, ...dataOf(rest), region,
      mcpServersOrder: keyOrder(spec.mcpServers), envOrder: keyOrder(spec.env),
      tools: tools.map(({ shape, ...t }) => ({ ...dataOf(t), schema: z.toJSONSchema(z.object(shape)), paramOrder: Object.keys(shape) })),
    });
    const s = super.open({
      ...spec,
      hooks: {
        beforeTool: (tool, input) => {
          const deny = spec.hooks.beforeTool(tool, input);
          if (deny) rec.add("deny", { region, tool, text: deny });
          return deny;
        },
        afterTool: () => {
          const extra = spec.hooks.afterTool();
          if (extra) rec.add("inject", { region, text: extra });
          return extra;
        },
      },
      onEvent: (ev) => {
        if (ev.type === "result") rec.add("result", { region, tool: ev.tool, text: ev.text, isError: ev.isError });
        spec.onEvent(ev);
      },
    });
    const send = s.send.bind(s);
    s.send = (text, opts) => {
      rec.add("send", { region, text, priority: opts?.priority ?? null, human: opts?.human ?? null });
      return send(text, opts);
    };
    // 系统叫它打断、关掉的每一次都记（假会话不在演时打断什么也不做，也照记：记的是系统做了什么）
    const interrupt = s.interrupt.bind(s);
    s.interrupt = () => { rec.add("interrupt", { region }); return interrupt(); };
    const close = s.close.bind(s);
    s.close = () => { rec.add("close", { region }); return close(); };
    return s;
  }

  override async ask(o: AskOpts): Promise<AskResult> {
    this.rec.add("ask", { env: null, claudeExecutable: null, ...dataOf(o) });
    return super.ask(o);
  }

  async quota(opts: Parameters<NonNullable<KernelDriver["quota"]>>[0]): Promise<QuotaReading | null> {
    const r = this.quotaReading === null ? null : structuredClone(this.quotaReading);
    this.rec.add("call", { name: "quota", args: dataOf(opts), returned: r });
    return r;
  }
}

/**
 * 记录用的外部命令：每次记一条 run（命令、参数、选项，和回给系统的是什么）。answer 认得的回它给的结果（记在 answered 里），
 * 不认得、没给 answer 的回成功、没输出（answered 记 null）。先问再记：回答是这条记录的一个字段；answer 抛了错这条也照记
 */
export function recordingRunner(rec: Recorder, answer?: RunAnswer): Runner {
  return async (cmd, args, opts) => {
    let answered: RunResult | undefined;
    try { answered = answer?.(cmd, args, opts); }
    finally { rec.add("run", { cmd, args: [...args], opts: opts ?? null, answered: answered ?? null }); }
    return answered ?? { code: 0, stdout: "", stderr: "" };
  };
}

/** 记录用的网关：记 gateway（方法、参数、时限）；send 回 m1、m2……，node.list 回没有节点，别的回 {} */
/**
 * A stand-in for the channels that go through a bridge (config via "bridge"): what the role sends is recorded and
 * answered as a bridge that sent it; nothing is connected, nothing arrives by itself (scenarios hand messages in).
 */
export function recordingBridge(rec: Recorder): (name: string) => Channel {
  let messageNo = 0;
  return (name) => ({
    connected: true,
    start: async () => {},
    stop: async () => {},
    send: async (m) => {
      rec.add("bridge", { channel: name, m });
      return { ok: true, out: JSON.stringify({ messageId: `b${++messageNo}` }) };
    },
  });
}

export function recordingGateway(rec: Recorder): GatewayCaller {
  let messageNo = 0;
  return {
    connected: true,
    request: async <T>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T> => {
      rec.add("gateway", { method, params, timeoutMs: timeoutMs ?? null });
      const reply = method === "send" ? { messageId: `m${++messageNo}` } : method === "node.list" ? { nodes: [] } : {};
      return reply as T;
    },
  };
}
