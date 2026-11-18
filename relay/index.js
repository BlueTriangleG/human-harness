// hh-relay：OpenClaw 只做渠道，消息交给 Human Harness（hhd）。
// - 开关：~/.hh/relay-mode 写 "hh" 才接管；别的（或没有这个文件）= OpenClaw 原生大脑照旧。改了马上生效，不用重启网关。
// - 斜杠命令（/stop、/cc、/new…）一律放行给 OpenClaw。
// - hhd 连不上、回话前就关了连接、明说没收下：先存进 ~/.hh/relay-spool，hhd 起来按先后补交（~/.hh/relay.json 的 fallback 写 "openclaw" 才交回 OpenClaw）；
//   已经送到、连接开着、等满了（~/.hh/relay.json 的 timeoutMs，默认 15 秒）还没回话：hhd 活着只是卡住，当它收下了，不交回（11-12「两个她」）。
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
// - 附件（#0012）：message_received 记下附件的本地路径，接管时拼成「[附件: 路径]」跟在文字后面。
//   WhatsApp 要在 openclaw.json 打开 channels.whatsapp.pluginHooks.messageReceived 才会发 message_received。
import { relayMode, request, fallbackAction, relayFallback, spool, shouldClaim, toRelayMessage, createMediaCache, mediaPathsOf, mediaKey, takeMediaFor, SOCK } from "./logic.mjs";

export default definePluginEntry({
  id: "hh-relay",
  name: "Human Harness Relay",
  description: "渠道消息交给 Human Harness",
  register(api) {
    const media = createMediaCache();
    const hookSeen = new Set();   // 哪些渠道真的发过 message_received（没发过的不等）
    api.on("message_received", (event, ctx) => {
      const channel = String(ctx?.channelId ?? "");
      if (channel) hookSeen.add(channel);
      media.remember(mediaKey(channel, event?.messageId ?? event?.metadata?.messageId), mediaPathsOf(event));
      return undefined;
    });
    api.on("before_dispatch", async (event, ctx) => {
      const mode = relayMode();
      if (!shouldClaim(event?.content, mode)) return undefined;
      const channel = String(ctx?.channelId ?? event?.channel ?? "");
      const paths = await takeMediaFor(media, mediaKey(channel, event?.messageId ?? ctx?.messageId), { wait: hookSeen.has(channel) });
      const message = toRelayMessage(event, ctx, paths);
      try {
        const res = await request(SOCK, { cmd: "relay", message });
        api.logger?.info?.(`[hh-relay] ${message.channel} ${message.senderId ?? "?"} → hh (${res?.result ?? "?"})`);
        return { handled: true };
      } catch (e) {
        const act = fallbackAction(e, relayFallback());
        if (act === "taken") {
          // 已经送到 hhd、只是没等到回音：它多半收下了，别再交给 OpenClaw 的 agent（不然两边各回一遍）
          api.logger?.warn?.(`[hh-relay] hhd 没及时回话（${e?.message ?? e}），消息已送到、它还连着，当它收下了，不交回 OpenClaw：${message.channel} ${message.senderId ?? "?"} ${message.messageId ?? "?"}`);
          return { handled: true };
        }
        if (act === "spool") {
          // hhd 不在（没起来、正在重启）：先存着，hhd 起来按先后补交；不交给 OpenClaw 自己的 agent（11-12「两个她」，主人：老的停了）
          try {
            spool(message);
            api.logger?.warn?.(`[hh-relay] hhd 不可用（${e?.message ?? e}），消息先存着等它回来补交：${message.channel} ${message.senderId ?? "?"} ${message.messageId ?? "?"}`);
            return { handled: true };
          } catch (se) {
            api.logger?.error?.(`[hh-relay] hhd 不可用、也存不下（${se?.message ?? se}），只好交回 OpenClaw`);
          }
        }
        api.logger?.warn?.(`[hh-relay] hhd 不可用，交回 OpenClaw：${e?.message ?? e}`);
        return undefined;
      }
    });
  },
});
