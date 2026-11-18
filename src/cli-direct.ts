// 不经 hhd 的两条命令：hh send（直接连网关发）、hh browser（直接连她的 Chrome）。
// 以前都起 openclaw 命令行，每次 4–6 秒、三四百兆内存（不要走 OpenClaw）。hhd 挂了也能用。
// And hh lang status: what a language pack still lacks of its own (reads only the packs, no config);
// hh outbound latin: the switch that lets Latin-only lines out for a while (outbound.latinLinesFile);
// hh channels: how each channel is reached and what its bridge says of itself, and restarting a bridge.
import { addChannel, bridgeFile, BRIDGE_APPS, removeChannel, whatsappAuth, type AddOptions } from "./channels/setup.ts";
import { link, type Connect } from "../bridge/whatsapp/link.ts";
import { services } from "./services/index.ts";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { calendarDay, hhmm } from "./brainstem/clock.ts";
import { latinUntil } from "./gate/outbound.ts";
import { writeFileAtomic } from "./util/atomic.ts";
import type { Config } from "./config.ts";
import { People } from "./persona/people.ts";
import { GatewayClient, readGatewayAuth } from "./gateway/client.ts";
import type { GatewayCaller } from "./gateway/client.ts";
import { openChannels } from "./channels/send.ts";
import { bridgeSocket, bridgeStatus, type BridgeStatus } from "./channels/bridge.ts";
import { bridgeRecord, stopRecorded } from "./repair/restart.ts";
import { gatewayAuthFile } from "./channels/gateway.ts";
import { Logger } from "./log.ts";
import { Chrome } from "./browser/chrome.ts";
import { B, langGaps, overlayPacks, type PartGaps } from "./lang/index.ts";

/** 从参数里取出 --名字 值（取完删掉） */
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

/** hh outbound latin [on [--minutes N] | off]: write or remove the switch file, then say whether it is on and until when */
export function outboundCommand(cfg: Config, argv: string[], now = Date.now()): string {
  const args = [...argv];
  const minutes = Number(option(args, "--minutes") ?? 120);
  const [what, state, ...rest] = args;
  const file = cfg.outbound?.latinLinesFile;
  if (what !== "latin" || rest.length || (state !== undefined && state !== "on" && state !== "off") || !(minutes > 0)) throw new Error(B.cliDirect.latinUsage);
  if (!file) throw new Error(B.cliDirect.latinNoFile);
  if (state === "on") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify({ until: Math.round(now + minutes * 60_000) }));
  }
  if (state === "off") rmSync(file, { force: true });
  const until = latinUntil(file);
  const tz = cfg.schedule.timezone;
  return until > now ? B.cliDirect.latinOn(`${calendarDay(until, tz).slice(5)} ${hhmm(until, tz)}`) : B.cliDirect.latinOff;
}

export async function sendCommand(cfg: Config, argv: string[], deps: { gateway?: GatewayCaller } = {}): Promise<string> {
  const args = [...argv];
  const channel = option(args, "--channel") ?? "whatsapp";
  const media = option(args, "--media");
  const [to, ...words] = args;
  if (!to || (!words.length && !media)) throw new Error(B.cliDirect.sendUsage);
  const target = People.load(cfg.workspace).targetFor(to, channel) ?? to;
  // the gateway only for a channel that goes through it: a bridged channel is sent with the gateway down, or with none at all
  const own = deps.gateway || cfg.channels[channel]?.via !== "gateway" ? null : new GatewayClient({ ...readGatewayAuth(gatewayAuthFile(cfg)), log: new Logger("hh-send", () => {}) });
  const gateway = deps.gateway ?? own ?? undefined;
  try {
    const r = await openChannels(cfg, { gateway }).send({ channel, target, text: words.join(" "), ...(media ? { media } : {}) });
    if (!r.ok) throw new Error(r.out);
    return cfg.tools.sendDryRun ? r.out : B.cliDirect.sendDone(channel, to);
  } finally {
    own?.close();
  }
}

/**
 * hh channels: every channel of the role, how it is reached and, for a bridge, its own status (null: it does not answer).
 * hh channels restart <name>: stop that channel's bridge by the pid it recorded; the service manager starts it again. Neither needs hhd.
 */
export async function channelsCommand(cfg: Config, argv: string[]): Promise<unknown> {
  const [what, name, ...rest] = argv;
  const bridged = (n: string): boolean => cfg.channels[n]?.via === "bridge";
  if (what === undefined) {
    const out: Record<string, { via: string; status?: BridgeStatus | null }> = {};
    for (const [n, c] of Object.entries(cfg.channels)) out[n] = bridged(n) ? { via: c.via, status: await bridgeStatus(bridgeSocket(cfg.stateDir, n)) } : { via: c.via };
    return out;
  }
  if (what === "add") {
    const app = BRIDGE_APPS[name ?? ""];
    const file = process.env.HH_CONFIG;
    if (!app || !file) throw new Error(`usage: HH_CONFIG=<the role's config> hh channels add <${Object.keys(BRIDGE_APPS).join("|")}> --allow <id> [--allow <id>…] [--group-allow <id>…] [--owner-id <id>] [--name <channel>] [--app-id <id>, secret on stdin] [--auth <dir>]`);
    const many = (flag: string): string[] => { const out: string[] = []; for (let v = option(rest, flag); v !== undefined; v = option(rest, flag)) out.push(v); return out; };
    const o: AddOptions = { allow: many("--allow"), groupAllow: many("--group-allow") };
    for (const [flag, key] of [["--owner-id", "ownerId"], ["--name", "name"], ["--app-id", "appId"], ["--auth", "auth"]] as const) { const v = option(rest, flag); if (v !== undefined) o[key] = v; }
    if (rest.length) throw new Error(`not understood: ${rest.join(" ")}`);
    if (app.app === "qq") o.appSecret = readFileSync(0, "utf8").trim();
    const r = addChannel(cfg, file, app, o);
    return [...r.done, "", "still to do:", ...r.todo.map((t) => `  - ${t}`)].join("\n");
  }
  if (what === "link") {
    const phone = option(rest, "--phone");
    const channel = option(rest, "--name") ?? BRIDGE_APPS.whatsapp!.channel;
    if (name !== "whatsapp" || !phone || rest.length) throw new Error("usage: HH_CONFIG=<the role's config> hh channels link whatsapp --phone <the account's number, with country code> [--name <channel>]");
    return linkCommand(cfg.stateDir, channel, phone);
  }
  if (what === "remove") {
    const file = process.env.HH_CONFIG;
    if (!name || !file || rest.length) throw new Error("usage: HH_CONFIG=<the role's config> hh channels remove <channel>");
    return (await removeChannel(cfg, file, name, services())).join("\n");
  }
  if (what !== "restart" || !name || rest.length || !bridged(name)) throw new Error(B.cliDirect.channelsUsage);
  return { restarted: stopRecorded(cfg.stateDir, bridgeRecord(name)) };
}

/**
 * hh channels link whatsapp: the role's first WhatsApp login, by pairing code. Refused while the channel's bridge runs —
 * one login, one process. The code is printed for the person at the terminal as soon as WhatsApp gives it
 */
export async function linkCommand(stateDir: string, channel: string, phone: string, o: { connect?: Connect; settleMs?: number; say?: (line: string) => void } = {}): Promise<string> {
  if (await bridgeStatus(bridgeSocket(stateDir, channel), 2_000)) throw new Error(`the ${channel} bridge is running and holds the login: hh channels remove ${channel} first if it should be linked anew`);
  const auth = whatsappAuth(stateDir, channel);
  mkdirSync(join(stateDir, "channels"), { recursive: true, mode: 0o700 });
  const say = o.say ?? ((line: string) => console.log(line));
  await link({
    auth, phone, ...(o.connect ? { connect: o.connect } : {}), ...(o.settleMs === undefined ? {} : { settleMs: o.settleMs }),
    say: (code) => say(`pairing code: ${code.replace(/^(.{4})(.{4})$/, "$1-$2")}\non the phone: WhatsApp > Settings > Linked devices > Link a device > "Link with phone number instead", then type the code. Waiting…`),
  });
  const named = channel === BRIDGE_APPS.whatsapp!.channel ? "" : ` --name ${channel}`;
  return [`linked: the login is in ${auth}`, "next:",
    ...(existsSync(bridgeFile(stateDir, channel)) ? [] : [`  - hh channels add whatsapp --allow <number> --owner-id <number>${named}    (who may write to the role)`]),
    "  - hh modules install    (the bridge starts and holds the login from now on)"].join("\n");
}

export async function browserCommand(cfg: Config, argv: string[]): Promise<unknown> {
  const chrome = new Chrome({ ...cfg.browser, shotsDir: join(cfg.stateDir, "shots") });
  switch (argv[0]) {
    case "status": return { running: await chrome.running() };
    case "stop": return { stopped: await chrome.stop() };
    case "cookies": {
      if (!argv[1]) throw new Error(B.cliDirect.browserCookiesUsage);
      return { cookies: await chrome.cookies(argv[1]) };
    }
    default: throw new Error(B.cliDirect.browserUsage);
  }
}

/**
 * hh lang status [<code>] [--list <part>]: for the pack code (default: every pack that is an overlay), per part the entries
 * of its own out of the reference's, and the entries it has that the reference does not; --list: the missing entries of
 * one part, one dotted path per line. For engineers: plain English, not pack text.
 */
export function langCommand(argv: string[]): string {
  const args = [...argv];
  const list = option(args, "--list");
  const [verb, code] = args;
  if (verb !== "status") throw new Error("usage: hh lang status [<code>] [--list <part>]");
  const own = (p: PartGaps): number => p.total - p.missing.length;
  const row = (name: string, mine: number, total: number): string => `  ${name.padEnd(9)} ${String(mine).padStart(5)} / ${total}`;
  return (code ? [code] : overlayPacks()).map((c) => {
    const parts = langGaps(c);
    if (list !== undefined) {
      const part = parts.find((p) => p.part === list);
      if (!part) throw new Error(`no part "${list}" (parts: ${parts.map((p) => p.part).join(", ")})`);
      return part.missing.join("\n");
    }
    const extra = parts.flatMap((p) => p.extra);
    return [
      `${c}: entries of its own / entries of the reference pack (every other entry is read from the reference)`,
      ...parts.map((p) => row(p.part, own(p), p.total)),
      row("total", parts.reduce((n, p) => n + own(p), 0), parts.reduce((n, p) => n + p.total, 0)),
      ...(extra.length ? ["  in this pack but not in the reference, so never read (a misspelled name?):", ...extra.map((x) => `    ${x}`)] : []),
    ].join("\n");
  }).join("\n\n");
}

