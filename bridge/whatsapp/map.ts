// WhatsApp messages (baileys shapes) to and from HH's channel shapes. No baileys import: what needs the live socket
// (looking up a LID's phone number, downloading media) is done by main.ts and handed in.
import { withAttachments } from "../../src/channels/bridge.ts";
import type { InboundMessage } from "../../src/channels/types.ts";

/** The parts of a baileys WAMessage this bridge reads. */
export interface WaKey {
  remoteJid?: string | null; remoteJidAlt?: string | null; participant?: string | null; participantAlt?: string | null;
  fromMe?: boolean | null; id?: string | null;
}
export type WaContent = Record<string, any>;
export interface WaMessage { key: WaKey; message?: WaContent | null; messageTimestamp?: number | string | { toNumber(): number } | null }

/** Who may write: phone numbers ("+<digits>") or "*"; DMs by allowFrom, group messages by their sender in groupAllowFrom (OpenClaw's allowlist policy). */
export interface Allow { allowFrom: readonly string[]; groupAllowFrom: readonly string[] }

const WRAPPERS = ["ephemeralMessage", "viewOnceMessage", "viewOnceMessageV2", "viewOnceMessageV2Extension", "documentWithCaptionMessage", "editedMessage"];
const MEDIA: Record<string, string> = { imageMessage: "image", videoMessage: "video", ptvMessage: "video", audioMessage: "audio", documentMessage: "document", stickerMessage: "sticker" };

export function unwrap(m: WaContent | null | undefined): WaContent | undefined {
  let cur = m ?? undefined;
  for (let w = WRAPPERS.find((k) => cur?.[k]?.message); cur && w; w = WRAPPERS.find((k) => cur?.[k]?.message)) cur = cur[w].message;
  return cur;
}

/** The media section of a message: its key in the message (imageMessage…) and its kind (image…). */
export function mediaOf(c: WaContent | undefined): { key: string; kind: string } | undefined {
  const key = c && Object.keys(MEDIA).find((k) => c[k]);
  return key ? { key, kind: MEDIA[key]! } : undefined;
}

/** A message's own words, as OpenClaw read them: the text, else a caption, else a contact placeholder; "" when none. */
export function textOf(c: WaContent | undefined): string {
  if (!c) return "";
  const t = [c.conversation, c.extendedTextMessage?.text, c.imageMessage?.caption, c.videoMessage?.caption, c.ptvMessage?.caption, c.documentMessage?.caption]
    .find((v) => typeof v === "string" && v.trim());
  if (t) return t.trim();
  if (c.contactMessage) return "<contact>";
  const n = c.contactsArrayMessage?.contacts?.length;
  return n ? `<contacts: ${n} ${n === 1 ? "contact" : "contacts"}>` : "";
}

/** The words, or a "<media:kind>" placeholder for media without words; "" for what is not a message (receipts, reactions…). */
export const bodyOf = (c: WaContent | undefined): string => textOf(c) || (mediaOf(c) ? `<media:${mediaOf(c)!.kind}>` : "");

/** What a reply quotes: its body, or OpenClaw's placeholder when WhatsApp sent only the quoted id. */
export function quoteOf(c: WaContent | undefined): string | undefined {
  const ctx = c && Object.values(c).find((v) => v && typeof v === "object" && "contextInfo" in v)?.contextInfo;
  if (!ctx?.quotedMessage) return ctx?.stanzaId ? "[quoted message unavailable]" : undefined;
  return bodyOf(unwrap(ctx.quotedMessage)) || undefined;
}

/** "+<digits>" from the first phone-number jid among these (a device suffix ":12" dropped); null when none is one. */
export function phoneOf(...jids: (string | null | undefined)[]): string | null {
  for (const j of jids) {
    const d = j?.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/)?.[1];
    if (d) return `+${d}`;
  }
  return null;
}
export const lidOf = (...jids: (string | null | undefined)[]): string | undefined => jids.find((j) => j && /@(lid|hosted\.lid)$/.test(j)) ?? undefined;

export const isGroup = (k: WaKey): boolean => (k.remoteJid ?? "").endsWith("@g.us");
export const allowed = (a: Allow, sender: string, group: boolean): boolean =>
  (group ? a.groupAllowFrom : a.allowFrom).some((x) => x === "*" || x === sender);

/** OpenClaw took new messages ("notify") and history appends no older than a minute; everything else is history sync. */
export function fresh(m: WaMessage, type: string, now: number): boolean {
  if (type === "notify") return true;
  if (type !== "append") return false;
  const ts = m.messageTimestamp;
  const s = typeof ts === "object" && ts ? ts.toNumber() : Number(ts ?? 0);
  return s * 1000 >= now - 60_000;
}

/** The InboundMessage HH gets, the same fields the relay gave it from OpenClaw (a group's conversation id is its jid). */
export function inbound(m: WaMessage, sender: string, files: readonly string[]): InboundMessage {
  const c = unwrap(m.message);
  const group = isGroup(m.key);
  const quote = quoteOf(c);
  return {
    channel: "whatsapp", text: withAttachments(bodyOf(c), files), senderId: sender,
    ...(m.key.id ? { messageId: m.key.id } : {}), isGroup: group,
    ...(group ? { conversationId: m.key.remoteJid! } : {}), ...(quote ? { replyToBody: quote } : {}),
  };
}

/** The jid to send to: a phone number (with or without +, "whatsapp:" prefix allowed) or a jid as is; null when it is neither. */
export function toJid(target: string): string | null {
  const t = target.trim().replace(/^whatsapp:/i, "");
  if (/@(s\.whatsapp\.net|g\.us|lid)$/.test(t)) return t;
  const d = t.replace(/[\s()-]/g, "").match(/^\+?(\d{6,})$/)?.[1];
  return d ? `${d}@s.whatsapp.net` : null;
}

/** HH writes Markdown; WhatsApp bolds with one star and strikes with one tilde. */
export const toWhatsAppText = (t: string): string => t.replace(/\*\*(.+?)\*\*/gs, "*$1*").replace(/~~(.+?)~~/gs, "~$1~");

const MIME: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif",
  mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", ogg: "audio/ogg; codecs=opus", opus: "audio/ogg; codecs=opus",
  m4a: "audio/mp4", wav: "audio/wav", pdf: "application/pdf",
};

/**
 * What baileys sends for a file, the way OpenClaw sent it: images and videos with the text as caption (a video plays as
 * a gif when asked), audio always as a voice note with the text in a message of its own, anything else as a document.
 */
export function mediaContent(file: string, data: Buffer, text: string, o: { gifPlayback?: boolean } = {}): { content: WaContent; textAfter?: string } {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const mimetype = MIME[ext] ?? "application/octet-stream";
  const caption = text ? toWhatsAppText(text) : undefined;
  if (mimetype.startsWith("image/")) return { content: { image: data, mimetype, caption } };
  if (mimetype.startsWith("video/")) return { content: { video: data, mimetype, caption, ...(o.gifPlayback ? { gifPlayback: true } : {}) } };
  if (mimetype.startsWith("audio/")) return { content: { audio: data, mimetype, ptt: true }, ...(caption ? { textAfter: caption } : {}) };
  return { content: { document: data, mimetype, fileName: file.split("/").pop(), caption } };
}

export const extOf = (mimetype: string | undefined): string => {
  const sub = (mimetype ?? "").split(";")[0]!.split("/")[1] ?? "";
  return ({ jpeg: "jpg", quicktime: "mov", mpeg: "mp3" } as Record<string, string>)[sub] ?? (sub.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin");
};
