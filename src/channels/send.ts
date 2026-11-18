// The framework's one way out: every message HH sends (the message and sticker tools, the final reply, hh send) goes
// through the send of openChannels. The contract is docs/contracts/channels.md.
import type { Config } from "../config.ts";
import type { GatewayCaller } from "../gateway/client.ts";
import type { Logger } from "../log.ts";
import { T } from "../lang/index.ts";
import { bridgeChannel, bridgeSocket } from "./bridge.ts";
import { gatewayChannel } from "./gateway.ts";
import { outboundFilter } from "../gate/outbound.ts";
import type { BeforeSend, Channel, InboundMessage, Send } from "./types.ts";

export interface Channels { send: Send; start(onMessage: (m: InboundMessage) => void): Promise<void>; stop(): Promise<void> }

/**
 * One channel per entry of cfg.channels, built by the implementation its via names (an unknown via throws: a config
 * mistake stops the boot). send answers simulated sending first, then a channel that is not in the table, then the hook,
 * and only then hands the message to its channel.
 */
export function openChannels(cfg: Config, o: {
  gateway?: GatewayCaller; retryMs?: number; log?: Pick<Logger, "info" | "warn">;
  /** A stand-in for a channel's bridge, by the channel's name (the replay world hands one in: it connects nowhere). Unset: the bridge's socket in the role's state directory. */
  bridge?: (name: string) => Channel;
  /** For tests. The framework's own hook, the outbound filter of cfg.outbound, is installed inside this function, never handed in by hhd or hh send: the two must not be able to differ. */
  beforeSend?: BeforeSend;
} = {}): Channels {
  const build = (name: string, via: string): Channel => {
    switch (via) {
      case "gateway": return gatewayChannel(o.gateway, { retryMs: o.retryMs, log: o.log });
      case "bridge": return o.bridge?.(name) ?? bridgeChannel(name, bridgeSocket(cfg.stateDir, name), { log: o.log });
      default: throw new Error(`channels.${name}.via: unknown "${via}"`);
    }
  };
  const open = new Map(Object.entries(cfg.channels).map(([name, c]) => [name, build(name, c.via)] as const));
  const beforeSend = o.beforeSend ?? outboundFilter(cfg.outbound);
  return {
    send: async (m) => {
      if (cfg.tools.sendDryRun) return { ok: true, out: T.deliver.dryRun(m.channel, m.target) };
      const channel = open.get(m.channel);
      if (!channel) return { ok: false, out: T.deliver.noChannel(m.channel, [...open.keys()]) };
      const hook = await beforeSend?.(m);
      if (hook && "refuse" in hook) return { ok: false, out: hook.refuse };
      return channel.send(hook ? { ...m, text: hook.text } : m);
    },
    start: async (onMessage) => { for (const c of open.values()) await c.start(onMessage); },
    stop: async () => { for (const c of open.values()) await c.stop(); },
  };
}
