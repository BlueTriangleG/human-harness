// The first channel implementation: sending through the OpenClaw gateway, as HH has done since it left the openclaw
// command line. It goes away when the direct channels are in (docs/contracts/channels.md).
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { GatewayCaller } from "../gateway/client.ts";
import { GatewayError, GatewayUnsure, idempotencyKey } from "../gateway/client.ts";
import type { Logger } from "../log.ts";
import { T } from "../lang/index.ts";
import type { Channel, Delivered } from "./types.ts";

/** Where the gateway's auth file is: gateway.authFile, else openclaw.json next to the workspace (hhd and hh send both read it from here) */
export const gatewayAuthFile = (cfg: Config): string => cfg.gateway?.authFile || join(cfg.workspace, "..", "openclaw.json");

/** Whether hhd connects to the OpenClaw gateway: a channel goes through it, or the config names its auth file (the computer tool needs it too) */
export const usesGateway = (cfg: Config): boolean => Boolean(cfg.gateway?.authFile) || Object.values(cfg.channels ?? {}).some((c) => c.via === "gateway");

/** 超时以后再问网关一次等多久：文字一分钟，带图、语音的两分半（QQ 传图慢） */
const RECHECK_MS = 60_000;
const RECHECK_MEDIA_MS = 150_000;

// retryMs：没发出去时隔多久再试（测试里给 0）；log：超时后再问一次的结果记一笔（只记渠道和目标，不记话）
export function gatewayChannel(gateway: GatewayCaller | undefined, o: { retryMs?: number; log?: Pick<Logger, "info" | "warn"> } = {}): Channel {
  return {
    get connected(): boolean { return gateway?.connected ?? false; },
    // Nothing to start or stop here: messages come in through the relay plugin, which hands them to hhd's control socket
    // (the relay command in src/control.ts), and the gateway client's connection belongs to whoever created it
    // (hhd also uses it for the computer tool).
    start: async () => {},
    stop: async () => {},
    /**
     * 经 OpenClaw 网关发一条（工具和"回复自动发回"共用）。
     * 走常连的网关（几毫秒）。不再退回 openclaw 命令行（不要走 OpenClaw）：命令行走的也是同一个网关，网关不通它也发不出去。
     * A sent result carries resolved (the conversation id the gateway recognised) when there is one.
     */
    async send(m): Promise<Delivered> {
      if (!gateway) return { ok: false, out: T.deliver.noGateway };
      const params: Record<string, unknown> = {
        to: m.target, channel: m.channel, idempotencyKey: idempotencyKey(),
        ...(m.text ? { message: m.text } : {}), ...(m.media ? { mediaUrl: m.media } : {}), ...(m.asVoice ? { asVoice: true } : {}),
        ...(m.gifPlayback ? { gifPlayback: true } : {}), ...(m.replyTo ? { replyToId: m.replyTo } : {}),
      };
      const call = () => gateway.request("send", params, m.media ? 150_000 : undefined);   // QQ 传图慢，一张可能要一分多钟
      const sent = (payload: unknown): Delivered => {
        const resolved = resolvedTarget(payload);
        return { ok: true, out: (JSON.stringify(payload) ?? "").slice(0, 500), ...(resolved ? { resolved } : {}) };
      };
      for (let attempt = 0; ; attempt++) {
        let payload: unknown;
        try {
          payload = await call();
        } catch (e) {
          if (e instanceof GatewayError) return { ok: false, out: T.deliver.refused(e.code, e.message) };
          if (e instanceof GatewayUnsure) {
            // 发出去了只是没等到回音：可能已经到了，换个编号重发会重复。超时的（连接还在）用同一个编号原样再问一次（#0063）：
            // 网关按编号去重，前一个还在发就等它的结果，发完了的结果留五分钟，问几次都只发一遍。
            // 连接断了的不问：可能是网关重启了，留着的结果跟着没了，再问可能真发第二遍
            if (e.kind === "timeout") return recheckSend(gateway, params, m.media ? RECHECK_MEDIA_MS : RECHECK_MS, e, o.log, sent);
            return { ok: false, out: T.deliver.unsure(e.message), unsure: e.kind };
          }
          if (attempt === 0) { await new Promise((r) => setTimeout(r, o.retryMs ?? 2_000)); continue; }   // 确定没发出去（连不上）：再试一次
          return { ok: false, out: T.deliver.unreachable(e instanceof Error ? e.message : String(e)) };
        }
        return sent(payload);
      }
    },
  };
}

/** 超时以后同样的 send（同一个去重编号）再问一次：回了 = 发出去了；网关说错 = 没发出去；还是没回音、连不上 = 照旧不确定 */
async function recheckSend(
  gateway: GatewayCaller, params: Record<string, unknown>, timeoutMs: number, first: GatewayUnsure,
  log: Pick<Logger, "info" | "warn"> | undefined, sent: (payload: unknown) => Delivered,
): Promise<Delivered> {
  let payload: unknown;
  const where = { channel: params.channel, to: params.to };
  try {
    payload = await gateway.request("send", params, timeoutMs);
  } catch (e) {
    if (e instanceof GatewayError) {
      log?.warn("send refused on re-ask", { ...where, code: e.code });
      return { ok: false, out: T.deliver.refusedAfterRecheck(e.code, e.message) };
    }
    log?.warn("send still unsure after re-ask", where);
    return { ok: false, out: T.deliver.unsure(T.deliver.stillSilent(first.message, e instanceof Error ? e.message : String(e))), unsure: "rechecked" };
  }
  log?.info("send confirmed after timeout", where);
  return sent(payload);
}

/** 网关发成功后回的会话号（她写的是群名之类时网关自己认出来的那个）：conversationId、chatId、toJid 里第一个非空的字符串 */
function resolvedTarget(payload: unknown): string | undefined {
  const p = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
  for (const k of ["conversationId", "chatId", "toJid"]) {
    const v = p?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}
