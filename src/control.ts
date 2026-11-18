// 控制面：hhd 在本地 unix socket 上收一行 JSON 请求、回一行 JSON。hh 命令行用它。
import { refuseLive } from "./testGuard.ts";
import { createServer, createConnection } from "node:net";
import type { Server, Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Brain } from "./brain.ts";
import type { InboundMessage } from "./channels/types.ts";
import type { Inbound } from "./thalamus/router.ts";
import { memCommand } from "./memory/events/cli.ts";
import { learnCommand } from "./learning/cli.ts";
import { REPLAY_CONFIRM } from "./sleep/stopped.ts";
import { B } from "./lang/index.ts";
import { descendsFrom, peerPid } from "./peer.ts";

export type Request =
  | { cmd: "status" }
  | TellRequest
  | { cmd: "wake"; region: string; text: string }
  | { cmd: "remind"; text: string }
  | { cmd: "events"; n?: number; full?: boolean }
  | { cmd: "sleep"; reason?: string }
  | { cmd: "pageturn" }
  | { cmd: "sleep-plan" }
  | { cmd: "sleep-bank-import"; file: string; tag: string; layer: "resident" | "searchable" | "archive" }
  | { cmd: "sleep-bank-stats" }
  | { cmd: "sleep-replay"; day: string; base?: string; flowDir?: string; iKnowItSpendsQuota?: boolean }
  | { cmd: "sleep-replay-status" }
  | { cmd: "sleep-replay-stop" }
  | { cmd: "relay"; message: InboundMessage }
  | { cmd: "sense"; text: string; events?: unknown }
  | { cmd: "work"; action: "add"; when: string; minutes: number; why: string; every?: string }
  | { cmd: "work"; action: "ls" }
  | { cmd: "work"; action: "rm"; id: number }
  | { cmd: "work"; action: "stop" }
  | { cmd: "people"; action: "approve"; key: string }
  | { cmd: "mem"; action: string; args: string[] }
  | { cmd: "learn"; action: string; args: string[] }
  | { cmd: "gate"; action: "probe" }
  | { cmd: "gate"; action: "replay"; from: string; to: string }
  | { cmd: "ping" };

/** 命令行写错了（不认识的词）：打用法、退出码 2，不往 hhd 发 */
export class UsageError extends Error {
  constructor(message: string) { super(message); this.name = "UsageError"; }
}


/** hh sleep / hh sleep plan；别的词不认（别把写错的当成睡觉的理由，真让她睡了） */
export function sleepRequest(rest: string[]): Request {
  if (!rest.length) return { cmd: "sleep", reason: B.control.sleepReasonManual };
  if (rest[0] === "plan") return { cmd: "sleep-plan" };
  if (rest[0] === "replay-status" && rest.length === 1) return { cmd: "sleep-replay-status" };
  if (rest[0] === "replay-stop" && rest.length === 1) return { cmd: "sleep-replay-stop" };
  if (rest[0] === "replay") {
    let day = "", base = "", flowDir = "", confirmed = false;
    const a = rest.slice(1);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "--base" && a[i + 1] !== undefined) base = a[++i]!;
      else if (a[i] === "--flow-dir" && a[i + 1] !== undefined) flowDir = a[++i]!;
      else if (a[i] === REPLAY_CONFIRM) confirmed = true;
      else if (!a[i]!.startsWith("--") && !day) day = a[i]!;
      else throw new UsageError(B.control.sleepUsage);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new UsageError(B.control.sleepUsage);
    // hhd 的工作目录不是命令行的：流程目录先在这里变成绝对路径再发。没加 --i-know-it-spends-quota 的照样解析：hh 命令行在 cli-parse.ts 先停下，hhd 自己也核（sleep/stopped.ts）
    return { cmd: "sleep-replay", day, ...(base ? { base } : {}), ...(flowDir ? { flowDir: resolve(flowDir) } : {}), ...(confirmed ? { iKnowItSpendsQuota: true } : {}) };
  }
  if (rest[0] === "bank" && rest[1] === "stats" && rest.length === 2) return { cmd: "sleep-bank-stats" };
  if (rest[0] === "bank" && rest[1] === "import") {
    let file = "", tag = "", layer = "searchable";
    const a = rest.slice(2);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === "--tag" && a[i + 1] !== undefined) tag = a[++i]!;
      else if (a[i] === "--layer" && a[i + 1] !== undefined) layer = a[++i]!;
      else if (!a[i]!.startsWith("--") && !file) file = a[i]!;
      else throw new UsageError(B.control.sleepUsage);
    }
    if (!file) throw new UsageError(B.control.sleepUsage);
    if (layer !== "resident" && layer !== "searchable" && layer !== "archive") throw new UsageError(B.control.sleepUsage);
    // hhd 的工作目录不是命令行的：相对路径先在这里变成绝对路径再发
    return { cmd: "sleep-bank-import", file: resolve(file), tag: tag || basename(file).replace(/\.[^.]*$/, ""), layer };
  }
  throw new UsageError(B.control.sleepUsage);
}

/** hh people <动作> <key>：只认 approve */
export function peopleRequest(rest: string[]): Request {
  if (rest[0] !== "approve" || !rest[1]) throw new Error(B.control.peopleUsage);
  return { cmd: "people", action: "approve", key: rest[1] };
}

/** hh gate probe / hh gate replay <起> <止>（ISO 时间） */
export function gateRequest(rest: string[]): Request {
  if (rest[0] === "probe") return { cmd: "gate", action: "probe" };
  if (rest[0] === "replay" && rest[1] && rest[2]) return { cmd: "gate", action: "replay", from: rest[1], to: rest[2] };
  throw new Error(B.control.gateUsage);
}

// 控制面收到的是一行 JSON，不一定是 hh 命令行拼的：server 这边也核动作，不认识的不做（别把写错的当成 probe）
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** The channel a tell enters on: handed in on this machine, never a chat channel (the owner's approvals count only from those) */
export const TELL_CHANNEL = "local";

/** here: the console's tell (src/console/server.ts), answered where it was said; hh tell leaves it out */
export interface TellRequest { cmd: "tell"; from: string; text: string; human?: boolean; here?: boolean }

/**
 * What a tell hands the brain (src/parity's console scenario hands it the same). The console's comes back on this
 * machine, as every tell does for a role with no channel; hh tell's, to a role with channels, carries no address.
 */
export function tellOf(req: TellRequest): Inbound {
  return {
    from: req.from, text: req.text, channel: TELL_CHANNEL, human: req.human ?? true,
    ...(req.here ? { replyTo: { channel: TELL_CHANNEL, target: req.from, name: req.from } } : {}),
  };
}

export async function handle(brain: Brain, req: Request, statusExtra?: () => Record<string, unknown>): Promise<unknown> {
  switch (req.cmd) {
    case "ping": return { ok: true };
    // 存着的（hhd 不在时 relay 存下的）先交，再交这条：不乱序
    case "relay": brain.drainRelaySpool(); return { result: brain.fromChannel(req.message) };
    case "sense": return { status: "ok", result: brain.fromSenses(req.text, req.events) };   // status 给 senses.py 的 wake_result 看
    case "status": {
      // 附加的字段出错不能拖垮 status（看门狗探的就是它）
      let extra: Record<string, unknown> = {};
      try { extra = statusExtra?.() ?? {}; } catch { /* 没有附加字段 */ }
      return { ...brain.status(), ...extra };
    }
    case "tell": return { result: brain.inbound(tellOf(req)) };
    case "wake": brain.wakeRegion(req.region, req.text); return { ok: true };
    // the role's own background work reporting back (src/repair/cli.ts keepFix): her reminder, from nobody
    case "remind": if (!nonEmpty(req.text)) throw new Error(B.control.remindNoText); brain.remind(req.text); return { ok: true };
    case "events": {
      const n = Math.min(req.n ?? 30, 500);
      const start = Math.max(0, brain.central.lastSeq() - n);
      return brain.central.since(start).map((e) => ({ seq: e.seq, t: new Date(e.ts).toISOString(), src: e.src, kind: e.kind, text: req.full ? e.text : e.text.slice(0, 600),
        ...(e.meta?.failed === true ? { failed: true } : {}) }));   // the turn answering a tell from this computer failed: hh tell prints why
    }
    case "sleep": await brain.sleep(req.reason ?? B.control.sleepReasonManual); return { ok: true };
    case "sleep-plan": return brain.sleepPlan();
    case "sleep-bank-import": return brain.bankImport(req.file, req.tag, req.layer);
    case "sleep-bank-stats": return brain.bankStats();
    case "sleep-replay":
      if (!nonEmpty(req.day)) throw new Error(B.control.sleepUsage);
      // 要明说才开：只认 true（别的客户端发来的也一样），brain.sleepReplay 自己再核一遍
      return brain.sleepReplay(req.day, { ...(nonEmpty(req.base) ? { base: req.base } : {}), ...(nonEmpty(req.flowDir) ? { flowDir: req.flowDir } : {}), iKnowItSpendsQuota: req.iKnowItSpendsQuota === true });
    case "sleep-replay-status": return brain.sleepReplayStatus();
    case "sleep-replay-stop": return brain.sleepReplayStop();
    case "pageturn": brain.startPageTurn({ now: true }); return { ok: true };
    case "people":
      if (req.action !== "approve" || !nonEmpty(req.key)) throw new Error(B.control.peopleUsage);
      return { ok: true, approved: brain.approvePerson(req.key) };
    case "mem":
      if (!brain.mem) throw new Error(B.control.eventsMemoryOff);
      return memCommand(brain.mem, req.action, req.args, {
        exportsDir: join(brain.cfg.stateDir, "exports"), assocDir: join(brain.cfg.stateDir, "mem-assoc"), workspace: brain.cfg.workspace,
        runExam: (qs, out, o) => brain.runExam(qs, out, o),
        log: (msg, data) => brain.logInfo(msg, data),
      });
    case "learn":
      if (!brain.learning) throw new Error(B.control.learningNotConnected);
      return learnCommand(brain.learning, req.action, req.args, { cfg: brain.cfg.learning, tz: brain.cfg.schedule.timezone, now: Date.now });
    case "gate":
      if (req.action === "probe") return brain.gateProbe();
      if (req.action === "replay" && nonEmpty(req.from) && nonEmpty(req.to)) return brain.gateReplay(req.from, req.to);
      throw new Error(B.control.gateUsage);
    case "work":
      switch (req.action) {
        case "add": return brain.addWork(req.when, req.minutes, req.why, req.every);
        case "ls": return brain.listSchedule().map((x) => ({ ...x, due: new Date(x.due).toISOString() }));
        case "rm": return { removed: brain.removeSchedule(req.id) };
        case "stop": return { stopped: brain.stopWork() };
      }
  }
}

/** 客户端自己走了（超时 destroy、进程被杀、只发不收）：写它会 EPIPE、读它会 ECONNRESET，这不是 hhd 的错 */
const peerGone = (e: unknown) => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "EPIPE" || code === "ECONNRESET";
};

/** 看着控制命令：每条命令进来时 seen，处理超过 slowMs 时 onSlow（relay 等 hhd 回话有时限，慢了要知道是哪条、多慢） */
export interface ServeWatch { slowMs: number; seen(cmd: string): void; onSlow(cmd: string, ms: number): void }

/** A tell speaks for whoever it names: one from the role's own processes (its tools, its helpers, anything hhd started) is refused */
async function refuseRoleTell(sock: Socket): Promise<void> {
  const own = await peerPid(sock).then((pid) => descendsFrom(pid, process.pid)).catch((e: unknown) => { throw new Error(B.control.tellOriginUnknown(e instanceof Error ? e.message : e)); });
  if (own) throw new Error(B.control.tellFromRole);
}

export function serve(brain: Brain, path: string, onError: (e: unknown) => void, watch?: ServeWatch, statusExtra?: () => Record<string, unknown>): Server {
  if (existsSync(path)) unlinkSync(path);
  const server = createServer((sock) => {
    let buf = "";
    // 客户端中途断开不能带倒 hhd，也不记成 control error（#0046）；别的 socket 错照报
    sock.on("error", (e) => { if (!peerGone(e)) onError(e); });
    // 客户端关了（半关以后 hhd 这头也收了、或已经断了）就不再往里写；还没察觉它断的那一下写出去的 EPIPE 由上面那行吞掉
    const reply = (msg: unknown) => { if (sock.writable) sock.write(JSON.stringify(msg) + "\n"); };
    sock.on("data", async (chunk) => {
      buf += chunk.toString();
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const t0 = Date.now();
        let cmd = "?";
        try {
          const req = JSON.parse(line) as Request;
          cmd = String(req.cmd);
          watch?.seen(cmd);
          if (req.cmd === "tell") await refuseRoleTell(sock);
          reply({ ok: true, data: await handle(brain, req, statusExtra) });
        } catch (e) {
          onError(e);
          reply({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        const ms = Date.now() - t0;
        if (watch && ms >= watch.slowMs) watch.onSlow(cmd, ms);
      }
    });
  });
  server.listen(path);
  return server;
}

export function request(path: string, req: Request, timeoutMs = 30_000): Promise<unknown> {
  refuseLive(B.control.hhdSocketName, path);   // 测试里连不到线上的 hhd（11-13）
  return new Promise((resolve, reject) => {
    const sock = createConnection(path);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(B.control.hhdNoResponse)); }, timeoutMs);
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (c) => {
      buf += c.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      clearTimeout(timer);
      sock.end();
      const msg = JSON.parse(buf.slice(0, i)) as { ok: boolean; data?: unknown; error?: string };
      if (msg.ok) resolve(msg.data);
      else reject(new Error(msg.error));
    });
    sock.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}
