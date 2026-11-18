// QQ bot messages (@tencent-connect/qqbot-nodejs shapes) to and from HH's channel shapes. No SDK import, so it is tested
// without it. HH's QQ targets are "qqbot:c2c:<user openid>" and "qqbot:group:<group openid>", as OpenClaw's plugin wrote them.
import { readFileSync, writeFileSync } from "node:fs";
import { withAttachments } from "../../src/channels/bridge.ts";
import { QQ_REPLY_WINDOW_MS } from "../../src/channels/qq.ts";
import type { InboundMessage } from "../../src/channels/types.ts";

/** The parts of the SDK's QQBotInboundMessage this bridge reads. */
export interface QqMessage {
  kind: string; senderId: string; content: string; messageId: string; groupOpenid?: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string; asr_refer_text?: string }>;
  msgIdx?: string; refMsgIdx?: string;
}
export interface QqTarget { scope: "c2c" | "group"; targetId: string }

/** Who may write: openids or "*"; private chats by allowFrom, group messages by their sender in groupAllowFrom. */
export interface Allow { allowFrom: readonly string[]; groupAllowFrom: readonly string[] }
export const allowed = (a: Allow, sender: string, group: boolean): boolean =>
  (group ? a.groupAllowFrom : a.allowFrom).some((x) => x === "*" || x === sender);

export function qqTarget(target: string): QqTarget | null {
  const m = /^qqbot:(c2c|group):([A-Za-z0-9_-]+)$/i.exec(target.trim());
  return m ? { scope: m[1]!.toLowerCase() as "c2c" | "group", targetId: m[2]! } : null;
}

/** The words of a message: its text, the platform's transcript of a voice message, else a placeholder per attachment kind. */
export function bodyOf(m: QqMessage): string {
  const asr = (m.attachments ?? []).map((a) => a.asr_refer_text?.trim()).filter(Boolean);
  const kinds = (m.attachments ?? []).map((a) => `<media:${(a.content_type.split("/")[0] || "file").replace("voice", "audio")}>`);
  return [m.content.trim(), ...asr].filter(Boolean).join("\n") || kinds.join(" ");
}

/** The InboundMessage HH gets: the sender's openid as senderId, a group's openid as its conversation id. */
export function inbound(m: QqMessage, files: readonly string[], quote: string | undefined): InboundMessage {
  const group = m.kind === "group";
  return {
    channel: "qqbot", text: withAttachments(bodyOf(m), files), senderId: m.senderId, messageId: m.messageId, isGroup: group,
    ...(group && m.groupOpenid ? { conversationId: m.groupOpenid } : {}), ...(quote ? { replyToBody: quote } : {}),
  };
}

/**
 * QQ lets a bot answer a message it received ("passive", free) for a while, a few times; past that a send is a
 * proactive message, which the platform rations. The newest message from that person or group, answered at most 4
 * times: in a private chat for QQ_REPLY_WINDOW_MS (the platform's hour less a margin; OpenClaw's plugin forgot the
 * message after 30 minutes, the sticker tool always went by the hour), in a group for 5 minutes as the plugin did.
 */
export class Passive {
  private readonly last = new Map<string, { msgId: string; t: number; used: number }>();
  heard(t: QqTarget, msgId: string, now: number): void {
    const key = `${t.scope}:${t.targetId}`;
    this.last.delete(key);
    this.last.set(key, { msgId, t: now, used: 0 });
    if (this.last.size > 200) this.last.delete(this.last.keys().next().value!);
  }
  /** The msgId to answer with, or undefined for a proactive send. */
  take(t: QqTarget, now: number): string | undefined {
    const e = this.last.get(`${t.scope}:${t.targetId}`);
    if (!e || now - e.t >= (t.scope === "group" ? 5 * 60_000 : QQ_REPLY_WINDOW_MS) || e.used >= 4) return undefined;
    e.used++;
    return e.msgId;
  }
}

/**
 * What a later reply may quote: msgIdx → the words HH got for that message, the newest 500. Kept in a file (0600, it
 * holds message text), so a quote of something heard before the bridge was restarted still reads.
 */
export class Quotes {
  private readonly seen = new Map<string, string>();
  private readonly file: string;
  constructor(file: string) {
    this.file = file;
    try { for (const [k, v] of JSON.parse(readFileSync(file, "utf8")) as Array<[string, string]>) this.seen.set(k, v); } catch { /* none yet */ }
  }
  get(idx: string | undefined): string | undefined { return idx ? this.seen.get(idx) : undefined; }
  add(idx: string | undefined, text: string): void {
    if (!idx) return;
    this.seen.set(idx, text);
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
    writeFileSync(this.file, JSON.stringify([...this.seen]), { mode: 0o600 });
  }
}

/**
 * Why the connection cannot come back by itself, read off the SDK's start failure (protocol/api/token.js): the platform
 * refused the app id and secret. A network error is not one — the process ends and launchd tries again.
 */
export const downReason = (e: unknown): string | undefined =>
  /Token fetch failed: HTTP 4\d\d|Failed to get access_token/.test(String(e)) ? "bad credentials" : undefined;

export type MediaKind = "image" | "video" | "voice" | "file";
export function mediaKind(file: string): MediaKind {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) return "image";
  if (["mp4", "mov"].includes(ext)) return "video";
  if (["silk", "amr", "mp3", "wav", "ogg", "opus", "m4a"].includes(ext)) return "voice";
  return "file";
}
