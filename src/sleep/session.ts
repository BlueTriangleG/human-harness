// 夜里整理一段的会话：每段一个全新的 Claude Code 会话，开头（系统提示 + 工具清单）所有段一字不差，缓存共用；
// 这一段能用什么、能写哪里，运行时由 guard 拦。不往任何记忆库里记东西，只收用量。
import path from "node:path";
import type { KernelDriver, ToolDef, KernelSession, SessionSpec } from "../kernel/types.ts";
import { CentralMemory } from "../memory/central.ts";
import { Region } from "../regions/region.ts";
import { openDb } from "../store/db.ts";
import type { Logger } from "../log.ts";
import { matchWrites } from "./flow.ts";
import { MEM_STORE_WRITERS } from "../tools/memtools.ts";
import { S } from "../lang/index.ts";

export interface StageSessionOpts {
  id: string; model: string; prefix: string;
  /** 当晚的并集，一字不差 */
  tools: ToolDef[];
  /** 这一段能用的 HH 工具 + 引擎工具 */
  allowed: ReadonlySet<string>;
  /** 绝对路径 W/sleep/<日>/proposed */
  proposedRoot: string;
  writes: string[];
  /** 放行的脚本：「脚本名」（参数随便）或「脚本名 参数1 参数2…」（脚本后面的词得以这几个参数开头），如 sleep_apply.py、sleep_apply.py step */
  bash: string[];
  workspace: string;
  timeoutMs: number;
  /** 内核会话真开的时候（第一次叫醒）拿到的 spec：记日志用（team 的夜里看两个会话发给模型的东西一不一样） */
  onSpec?: (spec: SessionSpec) => void;
  /** 返回字符串就是锁着（先出题）：写文件、Bash、写事件库、learn_check 都拦，字符串是理由 */
  writeLock?: () => string | undefined;
  /** 给了就管读（考试的会话）：Read / Grep / Glob 都交给它（readguard.ts），返回字符串就拦，字符串是理由 */
  readDeny?: (tool: string, input: Record<string, unknown>) => string | undefined;
  /** 第一条消息开头的角色说明；不给是「夜里整理」那句，给 "" 就不加（考试的会话：考生、判分的说明在叫醒的话里） */
  roleText?: string;
}

export interface StageSessionDeps {
  driver: KernelDriver; cwd: string; permissionMode: string; env: Record<string, string>; claudeExecutable: string | null;
  render: { maxItemChars: number; timezone: string };
  /** 定时；返回取消的就在会话结束时取消这一段的超时（不返回也行） */
  now(): number; later(fn: () => void, ms: number): void | (() => void); log: Logger;
}

export interface StageUsage { calls: number; input: number; cacheRead: number; cacheWrite: number; output: number; maxCtx: number }
/** 一轮的样子（M1 量缓存用）：这一轮之前闲了多久、这一轮几次调用、读写了多少缓存、第一次调用读写的（驱动报了才有） */
export interface TurnInfo {
  turn: number; idleMs: number; calls: number; input: number; cacheRead: number; cacheWrite: number;
  first?: { input: number; cacheRead: number; cacheWrite: number };
}
export interface StageSession {
  readonly id: string;
  wake(text: string): void;
  /** close() 时 how=ok；到 timeoutMs 时 how=timeout 并关掉。一轮结束不算交差，出错的轮也不结算 */
  readonly settled: Promise<{ how: "ok" | "timeout" | string; turns: number; usage: StageUsage }>;
  /** 每次内核一轮结束都调（引擎用来发现「一轮结束了却没交差」、看调用次数超没超）；usage 是这个会话到这一轮为止的合计 */
  onTurnEnd(fn: (ok: boolean, error?: string, usage?: StageUsage, turn?: TurnInfo) => void): void;
  close(): Promise<void>;
}
/** openStageSession 开出来的：多一个 alive（别处包一层的会话、测试里的假会话不用给） */
export interface HeldSession extends StageSession {
  /**
   * 这个会话还是当初开的那一个、还活着吗：关了、超时了、内核会话死了都是 false；内核会话死了以后 Region 会悄悄重开一个空的
   * （不记得前面做的），重开过的也是 false。还没叫醒过（内核会话还没开）算活着
   */
  alive(): boolean;
}

/** 段的会话第一条消息开头那句（考试的会话不加） */
/** 所有段一样的内置工具（共用开头） */
export const STAGE_BUILTINS = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"];
const READ_ONLY = new Set(["Read", "Grep", "Glob"]);
const WRITERS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const BUILTIN = new Set([...READ_ONLY, ...WRITERS, "Bash"]);
const LOCKED_TOOLS = new Set<string>([...MEM_STORE_WRITERS, "learn_check"]);
const INTERPS = new Set(["python3", "python", "/usr/bin/python3"]);
const SHELL_META = /[;&|><`\n\r$(){}\[\]*?~!\\#]/;

export function guardFor(o: Pick<StageSessionOpts, "allowed" | "proposedRoot" | "writes" | "bash" | "workspace" | "writeLock" | "readDeny">): (tool: string, input: unknown) => string | undefined {
  const root = path.resolve(o.proposedRoot);
  const ws = path.resolve(o.workspace);
  // 每条放行：脚本的几种写法 + 钉住的参数（「sleep_apply.py step」= 只能调 step）
  const rules = o.bash.map((entry) => {
    const [name = "", ...args] = entry.trim().split(/[ \t]+/);
    return { paths: new Set([`scripts/${name}`, `./scripts/${name}`, `${ws}/scripts/${name}`]), args };
  });
  return (tool, input) => {
    const inp = (input ?? {}) as Record<string, unknown>;
    if (READ_ONLY.has(tool)) return o.readDeny?.(tool, inp);
    if (BUILTIN.has(tool) || LOCKED_TOOLS.has(tool)) { const why = o.writeLock?.(); if (why) return why; }
    if (tool === "Bash") {
      const cmd = typeof inp.command === "string" ? inp.command : "";
      // 跟 shell 一样只按空格、tab 分词（换行之类已经被上面的字符挡了）；不间断空格这些在 shell 里是词的一部分
      const words = cmd.split(/[ \t]+/).filter(Boolean);
      const at = words.length && INTERPS.has(words[0]!) ? 1 : 0;
      const script = words[at];
      const rest = words.slice(at + 1);
      const fits = script !== undefined && rules.some((r) => r.paths.has(script) && r.args.every((a, i) => rest[i] === a));
      if (!SHELL_META.test(cmd) && fits) return undefined;
      const names = o.bash.length ? o.bash.map((n) => `scripts/${n}`).join(S.marks.listSep) : S.marks.none;
      return S.session.scriptOnly(names) + S.session.badChars;
    }
    if (WRITERS.has(tool)) {
      const raw = inp.file_path ?? inp.notebook_path ?? inp.path;
      if (typeof raw !== "string" || !raw) return S.session.noPath;
      const abs = path.resolve(ws, raw);
      const rel = path.relative(root, abs);
      const inside = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      if (!inside) {
        const orig = path.relative(ws, abs);
        const alt = orig && !orig.startsWith("..") && !path.isAbsolute(orig) ? path.join(root, orig) : root;
        return S.session.writeProposed(alt);
      }
      if (!matchWrites(o.writes, rel)) return S.session.writesOnly(o.writes.join(S.marks.listSep) || S.marks.none, rel);
      return undefined;
    }
    if (BUILTIN.has(tool)) return undefined;
    if (!o.allowed.has(tool)) return S.session.toolNotHere(tool);
    return undefined;
  };
}

export function openStageSession(deps: StageSessionDeps, o: StageSessionOpts): HeldSession {
  if (path.resolve(deps.cwd) !== path.resolve(o.workspace)) throw new Error(`stage session cwd ${deps.cwd} != workspace ${o.workspace}`);
  const scratch = openDb(":memory:");
  const usage: StageUsage = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, maxCtx: 0 };
  let turns = 0;
  let done = false;
  const turnFns: Array<(ok: boolean, error?: string, usage?: StageUsage, turn?: TurnInfo) => void> = [];
  /** 上一轮结束（或会话开）的时刻；这一轮开始前闲了多久（叫醒时算，一轮里再叫醒不重算） */
  let lastEnd = deps.now();
  let idleMs: number | null = null;
  let resolve!: (v: { how: string; turns: number; usage: StageUsage }) => void;
  const settled = new Promise<{ how: "ok" | "timeout" | string; turns: number; usage: StageUsage }>((r) => { resolve = r; });
  const spec = {
    id: o.id, role: "hippocampus" as const, tier: "opus" as const, label: "", outlet: "none" as const, external: false,
    builtinTools: STAGE_BUILTINS, tools: o.tools.map((t) => t.name),
    roleText: o.roleText ?? S.session.stageRole,
  };
  // 内核会话开了几个、头一个是哪个：Region 自己不说会话死没死、重开没重开，从这里看（不改 regions/）
  const kernels: KernelSession[] = [];
  const driver: KernelDriver = {
    open: (ks) => {
      const k = deps.driver.open(ks);
      kernels.push(k);
      try { o.onSpec?.(ks); } catch (e) { deps.log.warn("stage session: onSpec failed", { id: o.id, error: String(e).slice(0, 200) }); }
      return k;
    },
    ...(deps.driver.ask ? { ask: (a) => deps.driver.ask!(a) } : {}),
    ...(deps.driver.quota ? { quota: (q) => deps.driver.quota!(q) } : {}),
  };
  const region = new Region(spec, {
    driver, central: new CentralMemory(scratch, deps.now), labeler: () => "",
    render: deps.render, model: o.model, cwd: deps.cwd, permissionMode: deps.permissionMode,
    env: deps.env, claudeExecutable: deps.claudeExecutable, tools: o.tools,
    prefix: () => o.prefix, tailTokens: 0, now: deps.now,
    guard: guardFor(o),
    onEvent: (_r, ev) => {
      if (ev.type !== "turn-end") return;
      turns += 1;
      if (ev.total) {
        usage.calls += ev.total.calls; usage.input += ev.total.input; usage.cacheRead += ev.total.cacheRead;
        usage.cacheWrite += ev.total.cacheWrite; usage.output += ev.total.output;
      }
      usage.maxCtx = Math.max(usage.maxCtx, ev.usage.contextTokens);
      const info: TurnInfo = {
        turn: turns, idleMs: idleMs ?? 0, calls: ev.total?.calls ?? 0, input: ev.total?.input ?? 0, cacheRead: ev.total?.cacheRead ?? 0, cacheWrite: ev.total?.cacheWrite ?? 0,
        ...(ev.first ? { first: ev.first } : {}),
      };
      lastEnd = deps.now();
      idleMs = null;
      for (const f of turnFns) f(ev.ok, ev.error, { ...usage }, info);
    },
    log: deps.log,
  });
  // 关会话只关一次：超时先关了的，之后 close() 等的是同一个「关」，关完了才算关了
  let closing: Promise<void> | null = null;
  let cancelTimeout: (() => void) | null = null;
  const finish = (how: string): Promise<void> => {
    if (closing) return closing;
    done = true;
    cancelTimeout?.();
    cancelTimeout = null;
    // 半路关掉（超时、中止）：这一轮已经花的还没随 turn-end 报，关之前从内核那里拿过来记上（一轮正常结束后是 0）
    const open = region.inFlight();
    if (open) {
      usage.calls += open.calls; usage.input += open.input; usage.cacheRead += open.cacheRead;
      usage.cacheWrite += open.cacheWrite; usage.output += open.output;
    }
    resolve({ how, turns, usage: { ...usage } });
    closing = (async () => { try { await region.close(); } finally { scratch.close(); } })();
    return closing;
  };
  const cancel = deps.later(() => { finish("timeout").catch((e: unknown) => deps.log.warn("stage session: close after timeout failed", { id: o.id, error: String(e).slice(0, 200) })); }, o.timeoutMs);
  if (typeof cancel === "function") cancelTimeout = cancel;
  return {
    id: o.id,
    wake: (text) => { if (done) return; idleMs ??= Math.max(0, deps.now() - lastEnd); region.wake(text, { raw: true }); },
    settled,
    onTurnEnd: (fn) => { turnFns.push(fn); },
    close: () => finish("ok"),
    alive: () => !done && kernels.length <= 1 && !kernels[0]?.dead,
  };
}
