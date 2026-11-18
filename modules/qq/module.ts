// The QQ channel: the bridge process (bridge/qq/main.ts) that holds the role's QQ connection, as a launchd
// service outside hhd, and a self-check of the whole path. The bridge's code stays under bridge/; this module only
// declares it. No tools, no manual, no senses: turning it on changes nothing the role reads.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineModule, z } from "../../src/modules/api.ts";

const channel = (m: { config: Readonly<Record<string, unknown>> }): string => String(m.config.channel);

export default defineModule({
  name: "qq",
  summary: "the role's QQ channel: its bridge as a service that outlives hhd, and a check of the whole path",
  // channel: the name this channel goes by in the role's config (channels.<name>) and in the message tool
  config: { shape: { channel: z.string().min(1) }, defaults: { channel: "qqbot" } },
  requires: { npm: "../../bridge/qq", setup: ["the bridge's own file with the QQ login (hh channels add qq)"] },
  services: [{
    name: "bridge", script: "../../bridge/qq/main.ts",
    argv: (m) => [channel(m)],
    // one label scheme for every bridge: <the role's prefix>.bridge.<channel>
    label: (m) => `bridge.${channel(m)}`,
    // nothing to run before the channel is set up
    when: (m) => existsSync(join(m.role.stateDir, "channels", `${channel(m)}.json`)),
  }],
  check: (m) => m.channelCheck(channel(m), "qq"),
});
