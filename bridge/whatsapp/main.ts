// The WhatsApp bridge: one process that holds the WhatsApp Web connection (baileys, pinned in this directory's own
// package.json) and serves it to hhd and hh send through src/channels/bridge.ts.
//   HH_CONFIG=<the role's config> node bridge/whatsapp/main.ts [channel name, default whatsapp]
// Its own file <stateDir>/channels/<name>.json: { auth, media?, allowFrom, groupAllowFrom } — auth is a baileys multi-file
// auth directory. Only one process may use an auth directory at a time: WhatsApp drops the older connection.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import makeWASocket, { Browsers, DisconnectReason, downloadMediaMessage, makeCacheableSignalKeyStore, useMultiFileAuthState } from "baileys";
import { badTarget, notConnected, runBridge } from "../../src/channels/bridge.ts";
import type { Channel, Delivered, InboundMessage } from "../../src/channels/types.ts";
import type { Logger } from "../../src/log.ts";
import { allowed, extOf, fresh, inbound, isGroup, lidOf, mediaContent, mediaOf, phoneOf, toJid, toWhatsAppText, unwrap, type Allow, type WaMessage } from "./map.ts";

interface Own extends Allow { auth: string; media?: string }

const MAX_MEDIA = 50 * 1024 * 1024;

function whatsapp(name: string, cfg: Own, media: string, log: Logger): Channel {
  const quiet = {
    level: "warn",
    child() { return quiet; },
    trace() {}, debug() {}, info() {},
    warn(o: unknown, m?: string) { log.warn(`baileys: ${m ?? ""}`, { detail: String(JSON.stringify(o)).slice(0, 300) }); },
    error(o: unknown, m?: string) { log.warn(`baileys error: ${m ?? ""}`, { detail: String(JSON.stringify(o)).slice(0, 300) }); },
  };
  let sock: ReturnType<typeof makeWASocket> | undefined;
  let open = false;
  let stopped = false;
  let down: string | undefined;
  const recent = new Map<string, WaMessage>();   // for quoting: baileys needs the message a reply quotes

  const senderOf = async (m: WaMessage): Promise<string | null> => {
    const k = m.key;
    const jids = isGroup(k) ? [k.participant, k.participantAlt] : [k.remoteJid, k.remoteJidAlt];
    const lid = lidOf(...jids);
    return phoneOf(...jids) ?? (lid ? phoneOf(await sock?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null)) : null);
  };
  const save = async (m: WaMessage): Promise<string[]> => {
    const c = unwrap(m.message);
    const sec = mediaOf(c);
    if (!sec || Number(c![sec.key].fileLength ?? 0) > MAX_MEDIA) return [];
    try {
      const data = await downloadMediaMessage(m as never, "buffer", {}, { logger: quiet, reuploadRequest: sock!.updateMediaMessage });
      const file = join(media, `${(m.key.id ?? String(Date.now())).replace(/[^A-Za-z0-9_-]/g, "")}.${extOf(c![sec.key].mimetype)}`);
      writeFileSync(file, data);
      return [file];
    } catch (e) {
      log.warn("media download failed", { kind: sec.kind, error: String(e).slice(0, 200) });
      return [];
    }
  };
  const take = async (m: WaMessage, onMessage: (m: InboundMessage) => void): Promise<void> => {
    const jid = m.key.remoteJid ?? "";
    if (m.key.fromMe || !m.message || jid.endsWith("@status") || jid.endsWith("@broadcast")) return;
    const sender = await senderOf(m);
    if (!sender) return log.warn("no phone number for a sender, message dropped", { group: isGroup(m.key) });
    if (!allowed(cfg, sender, isGroup(m.key))) return log.info("not on the allow list, message dropped", { group: isGroup(m.key) });
    const message = inbound(m, sender, await save(m));
    if (!message.text) return;   // receipts, reactions, protocol messages
    if (m.key.id) { recent.set(m.key.id, m); if (recent.size > 500) recent.delete(recent.keys().next().value!); }
    onMessage(message);
    void sock?.readMessages([m.key as never]).catch(() => {});
  };
  const connect = async (onMessage: (m: InboundMessage) => void): Promise<void> => {
    const { state, saveCreds } = await useMultiFileAuthState(cfg.auth);
    const s = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, quiet) }, logger: quiet,
      browser: Browsers.macOS("Desktop"), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false,
    });
    sock = s;
    s.ev.on("creds.update", saveCreds);
    s.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "open") { open = true; down = undefined; log.info("connected"); }
      if (connection !== "close") return;
      open = false;
      const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) { down = "logged out"; return log.error("logged out: link this device again", { code }); }
      log.warn("connection closed, reconnecting", { code });
      if (!stopped) setTimeout(() => void connect(onMessage).catch((e) => log.error("reconnect failed", { error: String(e) })), 3_000);
    });
    s.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages as WaMessage[]) {
        if (fresh(m, type, Date.now())) void take(m, onMessage).catch((e) => log.warn("incoming message failed", { error: String(e).slice(0, 200) }));
      }
    });
  };
  return {
    get connected(): boolean { return open; },
    get down(): string | undefined { return down; },
    start: (onMessage) => connect(onMessage),
    stop: async () => { stopped = true; await sock?.end(undefined).catch(() => {}); },
    async send(m): Promise<Delivered> {
      if (!sock || !open) return notConnected(name);
      const jid = toJid(m.target);
      if (!jid) return badTarget(m.target);
      const quoted = m.replyTo ? recent.get(m.replyTo) : undefined;
      const opts = quoted ? { quoted: quoted as never } : undefined;
      const { content, textAfter } = m.media
        ? mediaContent(m.media, readFileSync(m.media), m.text, { gifPlayback: m.gifPlayback })
        : { content: { text: toWhatsAppText(m.text) }, textAfter: undefined };
      const r = await sock.sendMessage(jid, content as never, opts);
      if (textAfter) await sock.sendMessage(jid, { text: textAfter });
      return { ok: true, out: JSON.stringify({ messageId: r?.key?.id, toJid: jid }) };
    },
  };
}

const name = process.argv[2] ?? "whatsapp";
await runBridge<Own>(name, (own, o) => whatsapp(name, own, o.media, o.log));
