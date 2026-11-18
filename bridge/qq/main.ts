// The QQ bridge: one process that holds the QQ bot connection (Tencent's @tencent-connect/qqbot-nodejs, pinned in this
// directory's own package.json) and serves it to hhd and hh send through src/channels/bridge.ts.
//   HH_CONFIG=<the role's config> node bridge/qq/main.ts [channel name, default qqbot]
// Its own file <stateDir>/channels/<name>.json (keep it 0600, it holds the secret):
// { appId, appSecret, markdownSupport?, media?, allowFrom, groupAllowFrom }.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { QQBot } from "@tencent-connect/qqbot-nodejs";
import { badTarget, runBridge } from "../../src/channels/bridge.ts";
import type { Channel, Delivered, InboundMessage } from "../../src/channels/types.ts";
import type { Logger } from "../../src/log.ts";
import { allowed, downReason, inbound, mediaKind, Passive, qqTarget, Quotes, type Allow, type QqMessage } from "./map.ts";

interface Own extends Allow { appId: string; appSecret: string; markdownSupport?: boolean; media?: string }

const MAX_MEDIA = 100 * 1024 * 1024;

function qq(cfg: Own, media: string, quotesFile: string, log: Logger): Channel {
  const sdkLog = { info() {}, debug() {}, warn: (m: string) => log.warn(`sdk: ${m}`.slice(0, 300)), error: (m: string) => log.warn(`sdk error: ${m}`.slice(0, 300)) };
  const bot = new QQBot({ appId: cfg.appId, appSecret: cfg.appSecret, markdownSupport: cfg.markdownSupport !== false, logger: sdkLog });
  const passive = new Passive();
  const quotes = new Quotes(quotesFile);
  let open = false;
  let down: string | undefined;

  const download = async (m: QqMessage): Promise<string[]> => {
    const files: string[] = [];
    for (const [i, a] of (m.attachments ?? []).entries()) {
      const url = a.url.startsWith("//") ? `https:${a.url}` : a.url;
      if (!url.startsWith("https://") || a.content_type.startsWith("voice")) continue;   // voice: the platform's transcript is in the body
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        const data = Buffer.from(await r.arrayBuffer());
        if (!r.ok || data.length > MAX_MEDIA) continue;
        const ext = (a.filename?.split(".").pop() ?? a.content_type.split("/")[1] ?? "bin").replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "bin";
        const file = join(media, `${m.messageId.replace(/[^A-Za-z0-9_-]/g, "").slice(-40)}-${i}.${ext}`);
        writeFileSync(file, data);
        files.push(file);
      } catch (e) {
        log.warn("attachment download failed", { error: String(e).slice(0, 200) });
      }
    }
    return files;
  };

  return {
    get connected(): boolean { return open; },
    get down(): string | undefined { return down; },
    async start(onMessage: (m: InboundMessage) => void): Promise<void> {
      bot.on("ready", () => { open = true; log.info("connected"); });
      bot.on("resumed", () => { open = true; log.info("resumed"); });
      bot.on("error", (e) => log.warn("connection error", { error: String(e).slice(0, 200) }));
      bot.on("message", async (_ctx, msg) => {
        const m = msg as unknown as QqMessage;
        const group = m.kind === "group";
        if (m.kind !== "c2c" && !group) return;
        if (!allowed(cfg, m.senderId, group)) return log.info("not on the allow list, message dropped", { group });
        const target = { scope: msg.replyTarget.scope, targetId: msg.replyTarget.targetId };
        const message = inbound(m, await download(m), quotes.get(m.refMsgIdx));
        quotes.add(m.msgIdx, message.text);
        passive.heard(target, m.messageId, Date.now());
        onMessage(message);
      });
      // start() resolves only when stopped. Refused credentials: stay up and say so in the status (a restart would not help,
      // and whoever watches the bridge tells the owner). Anything else ends the process and launchd starts it again.
      void bot.start().catch((e: unknown) => {
        log.error("connection failed", { error: String(e).slice(0, 300) });
        down = downReason(e);
        if (!down) process.exit(1);
      });
    },
    stop: async () => { bot.stop(); },
    async send(m): Promise<Delivered> {
      const t = qqTarget(m.target);
      if (!t) return badTarget(m.target);
      const target = { ...t, msgId: passive.take(t, Date.now()) };
      if (!m.media) {
        const r = await bot.sendText(target, m.text);
        return { ok: true, out: JSON.stringify({ messageId: r.id, passive: Boolean(target.msgId) }) };
      }
      const source = { localPath: m.media };
      const kind = mediaKind(m.media);
      const r = kind === "image" ? await bot.sendImage(target, source, { content: m.text || undefined })
        : kind === "video" ? await bot.sendVideo(target, source, { content: m.text || undefined })
        : kind === "voice" ? await bot.sendVoice(target, source)
        : await bot.sendFile(target, source, { fileName: m.media.split("/").pop(), content: m.text || undefined });
      if (kind === "voice" && m.text) await bot.sendText({ ...t, msgId: passive.take(t, Date.now()) }, m.text);
      return { ok: true, out: JSON.stringify({ messageId: r.message?.id, passive: Boolean(target.msgId) }) };
    },
  };
}

await runBridge<Own>(process.argv[2] ?? "qqbot", (own, o) => qq(own, o.media, o.quotes, o.log));
