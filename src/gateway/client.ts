// OpenClaw 网关常连客户端：一条 WebSocket 一直连着，发消息、写 App 记录都走它（一次调用几毫秒；
// 以前每次起一个 openclaw 命令行要 ~10 秒）。断了下次调用时重连；失败抛给上层（分得清没发出去和发了没回音）。
import { refuseLive } from "../testGuard.ts";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Logger } from "../log.ts";
import { B } from "../lang/index.ts";

export interface GatewayCaller {
  request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  readonly connected: boolean;
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

export class GatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 请求已经发出去了，但没等到回音：不知道对方收没收到，别当成没发。
 * kind：timeout = 这个请求自己的时限到了（连接还在：网关按去重编号把结果留着，同一个编号再问一次不会发两遍）；
 * dropped = 连接断了（可能是网关重启了，留着的结果跟着没了，再问可能真发第二遍）
 */
export class GatewayUnsure extends Error {
  readonly kind: "timeout" | "dropped";
  constructor(message: string, kind: "timeout" | "dropped") {
    super(message);
    this.kind = kind;
  }
}

const CONNECT_TIMEOUT_MS = 15_000;

export function readGatewayAuth(openclawConfigPath: string): { url: string; token: string } {
  refuseLive(B.client.gatewayAuthName, openclawConfigPath);   // 测试里拿不到线上网关的凭据，也就连不上她的网关（11-13）
  const cfg = JSON.parse(readFileSync(openclawConfigPath, "utf8")) as { gateway?: { port?: number; auth?: { token?: string } } };
  const port = cfg.gateway?.port ?? 18789;
  const token = cfg.gateway?.auth?.token;
  if (!token) throw new Error(B.client.gatewayTokenMissing);
  return { url: `ws://127.0.0.1:${port}`, token };
}

export class GatewayClient implements GatewayCaller {
  private readonly url: string;
  private readonly token: string;
  private readonly log: Logger;
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;
  connected = false;

  private readonly connectTimeoutMs: number;

  constructor(opts: { url: string; token: string; log: Logger; connectTimeoutMs?: number }) {
    this.url = opts.url;
    this.token = opts.token;
    this.log = opts.log;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  /** 连上并完成握手（已经连着就直接返回） */
  connect(): Promise<void> {
    if (this.connected && this.ready) return this.ready;
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      // 握手迟迟不来、握手前就断了，都要让等着的人失败（以前会一直等，发回复的队列跟着堵死）
      let settled = false;
      const timer = setTimeout(() => fail(new Error("gateway connect timeout")), this.connectTimeoutMs);
      const fail = (e: Error) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(e instanceof GatewayUnsure ? new Error(e.message) : e); }   // 握手阶段失败：要发的还没发出去
        if (this.ws === ws) this.reset(e);   // 旧连接的尾巴不去动新连接
      };
      ws.onmessage = (m) => {
        let f: { type?: string; event?: string; id?: string; ok?: boolean; payload?: unknown; error?: { code?: string; message?: string } };
        try { f = JSON.parse(String(m.data)); } catch { return; }
        if (f.type === "event" && f.event === "connect.challenge") {
          this.send<unknown>("connect", {
            minProtocol: 4, maxProtocol: 4,
            client: { id: "gateway-client", version: "human-harness", platform: "macos", mode: "backend" },
            role: "operator", scopes: ["operator.read", "operator.write", "operator.admin"],
            caps: [], commands: [], permissions: {}, auth: { token: this.token },
            locale: "zh-CN", userAgent: "human-harness",
          }, 10_000).then(() => { settled = true; clearTimeout(timer); this.connected = true; this.log.info("gateway connected"); resolve(); }, fail);
          return;
        }
        if (f.type === "res" && f.id) {
          const p = this.pending.get(f.id);
          if (!p) return;
          this.pending.delete(f.id);
          clearTimeout(p.timer);
          if (f.ok) p.resolve(f.payload);
          else p.reject(new GatewayError(f.error?.code ?? "ERROR", f.error?.message ?? "gateway error"));
        }
      };
      ws.onerror = () => fail(new Error("gateway socket error"));
      ws.onclose = () => { if (!this.closed && this.ws === ws) this.log.warn("gateway disconnected"); fail(new Error("gateway closed")); };
    });
    return this.ready;
  }

  private reset(e: Error): void {
    this.connected = false;
    this.ready = null;
    const ws = this.ws;
    this.ws = null;
    try { ws?.close(); } catch { /* 已经关了 */ }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new GatewayUnsure(B.client.requestSentOutcomeUnknown(e.message), "dropped"));
      this.pending.delete(id);
    }
  }

  private send<T>(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) { reject(new Error("gateway not open")); return; }
      const id = String(++this.seq);
      const timer = setTimeout(() => { this.pending.delete(id); reject(new GatewayUnsure(`gateway ${method} timeout`, "timeout")); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** 调一个网关方法；没连上会先连。连不上抛普通错误（没发出去），发了没等到回音抛 GatewayUnsure */
  async request<T = unknown>(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    await this.connect();
    return this.send<T>(method, params, timeoutMs);
  }

  close(): void {
    this.closed = true;
    this.reset(new Error("closed"));
  }
}

export const idempotencyKey = (): string => `hh-${randomUUID()}`;
