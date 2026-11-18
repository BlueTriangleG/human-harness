// Setting a bridged channel up for a role, and saying what is still missing. The two bridge modules (modules/whatsapp,
// modules/qq) check their channel through channelCheck; `hh channels add` writes what a person would otherwise write by
// hand (docs/new-role.md step 4). Operator text: plain English, not pack text.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchdLabels, type Config } from "../config.ts";
import type { ServiceManager } from "../services/index.ts";
import type { CheckItem } from "../modules/api.ts";
import { LAYOUT as layout } from "../persona/layout.ts";
import { ownerSenders } from "../repair/instances.ts";
import { GUARD_DIR } from "../repair/machine.ts";
import { bridgeSocket, bridgeStatus, type BridgeStatus } from "./bridge.ts";

/** A chat app HH has a bridge for: its directory under bridge/, its module, the channel name it goes by, how its sender ids look */
export interface BridgeApp { app: string; module: string; channel: string; sender: RegExp; idHint: string }
export const BRIDGE_APPS: Record<string, BridgeApp> = {
  whatsapp: { app: "whatsapp", module: "whatsapp", channel: "whatsapp", sender: /^\+\d{6,15}$/, idHint: "a phone number, + and digits" },
  qq: { app: "qq", module: "qq", channel: "qqbot", sender: /^[A-Za-z0-9_-]{8,64}$/, idHint: "the sender's openid" },
};

/** The bridge's own file: the app's login, the allow lists, a media directory. It holds secrets: 0600 */
export const bridgeFile = (stateDir: string, name: string): string => join(stateDir, "channels", `${name}.json`);

/** Where a WhatsApp channel's login is: what its bridge file names, or <stateDir>/channels/<name>.auth */
export function whatsappAuth(stateDir: string, name: string): string {
  try {
    const auth = (JSON.parse(readFileSync(bridgeFile(stateDir, name), "utf8")) as { auth?: unknown }).auth;
    if (typeof auth === "string" && auth) return auth;
  } catch { /* no bridge file yet: the default */ }
  return join(stateDir, "channels", `${name}.auth`);
}
/** Has this WhatsApp channel a login (a linked device)? */
export const whatsappLinked = (stateDir: string, name: string): boolean => existsSync(join(whatsappAuth(stateDir, name), "creds.json"));

const registryOf = (workspace: string): Record<string, unknown> => {
  try { return JSON.parse(readFileSync(join(workspace, layout.registry), "utf8")) as Record<string, unknown>; } catch { return {}; }
};
const isEntry = (e: unknown): e is { privacy?: string; senders?: unknown[] } => typeof e === "object" && e !== null && !Array.isArray(e);
const ownersOf = (reg: Record<string, unknown>): Array<[string, { privacy?: string; senders?: unknown[] }]> =>
  Object.entries(reg).filter((kv): kv is [string, { privacy?: string; senders?: unknown[] }] => !kv[0].startsWith("_") && isEntry(kv[1]) && kv[1].privacy === "owner");

export interface CheckDeps { status(socket: string): Promise<BridgeStatus | null>; ownerIds(stateDir: string): Record<string, string[]> }
const realDeps: CheckDeps = {
  status: (socket) => bridgeStatus(socket),
  ownerIds: (stateDir) => { try { return ownerSenders(GUARD_DIR, stateDir, process.getuid?.() ?? 0); } catch { return {}; } },
};

/** What a role's bridged channel still lacks, most basic first; one "ok" line when nothing */
export async function channelCheck(cfg: Pick<Config, "stateDir" | "workspace" | "channels">, name: string, app: BridgeApp, deps: CheckDeps = realDeps): Promise<CheckItem[]> {
  const file = bridgeFile(cfg.stateDir, name);
  if (!existsSync(file)) return [{ status: "setup", text: `channel ${name} is not set up (no ${file}): hh channels add ${app.app}` }];
  const items: CheckItem[] = [];
  if (statSync(file).mode & 0o077) items.push({ status: "broken", text: `${file} can be read by others and holds the login: chmod 600` });
  if (cfg.channels[name]?.via !== "bridge") items.push({ status: "setup", text: `the role's config does not send ${name} through the bridge: set channels.${name}.via to "bridge" and restart hhd` });
  const unlinked = app.app === "whatsapp" && !whatsappLinked(cfg.stateDir, name);
  const st = await deps.status(bridgeSocket(cfg.stateDir, name));
  if (unlinked) items.push({ status: "setup", text: `WhatsApp is not linked: hh channels link whatsapp --phone <the account's number>, then hh modules install` });
  else if (!st) items.push({ status: "broken", text: `the ${name} bridge does not answer: it is not running (hh modules install installs its job) or it is stuck (hh channels restart ${name})` });
  else if (st.down) items.push({ status: "setup", text: `the ${name} bridge cannot connect by itself: ${st.down}${app.app === "whatsapp" ? " (link the device again)" : " (check appId and appSecret in its file)"}` });
  else if (!st.connected) items.push({ status: "broken", text: `the ${name} bridge is running but not connected` });
  const owners = ownersOf(registryOf(cfg.workspace));
  if (!owners.some(([, e]) => (e.senders ?? []).some((s) => app.sender.test(String(s).replace(/^qqbot:c2c:/i, "")))))
    items.push({ status: "setup", text: `the owner has no sender id for ${name} in the people list (${layout.registry}): the role will not know its owner there (hh channels add ${app.app} --owner-id …)` });
  if (!(deps.ownerIds(cfg.stateDir)[name] ?? []).length)
    items.push({ status: "setup", text: `the machine's side has no owner sender id for ${name}: the owner's /cc is not recognised there (docs/contracts/machine.md; the machine's account writes it)` });
  return items.length ? items : [{ status: "ok", text: `${name}: connected, ${st!.inbox} waiting in the inbox` }];
}

export interface AddOptions {
  name?: string; allow: string[]; groupAllow: string[]; ownerId?: string;
  /** WhatsApp: the login directory (default <stateDir>/channels/<name>.auth) */
  auth?: string;
  /** QQ: the app id, and the secret (read from stdin by the CLI, never an argument) */
  appId?: string; appSecret?: string;
}

/**
 * Write the bridge's own file, point the role's config at the bridge and turn the app's module on, and add the owner's
 * sender id to the people list. Returns what was done and what a person still has to do. It does not install or start
 * anything (hh modules install does), does not turn tools.sendDryRun off, and does not touch the machine's side.
 */
export function addChannel(cfg: Pick<Config, "stateDir" | "workspace">, configFile: string, app: BridgeApp, o: AddOptions): { done: string[]; todo: string[] } {
  const name = o.name ?? app.channel;
  const bad = [...o.allow, ...o.groupAllow, ...(o.ownerId ? [o.ownerId] : [])].find((x) => x !== "*" && !app.sender.test(x));
  if (bad !== undefined) throw new Error(`"${bad}" is not ${app.idHint} (nor *)`);
  if (!o.allow.length) throw new Error("give at least one --allow: with an empty list the bridge takes nobody's private messages");
  if (app.app === "qq" && (!o.appId || !o.appSecret)) throw new Error("QQ needs --app-id, and the app secret on standard input");
  const done: string[] = [];
  const file = bridgeFile(cfg.stateDir, name);
  if (existsSync(file)) throw new Error(`${file} is there already: this channel is set up (hh channels remove ${name} first, or edit the file)`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const own = app.app === "qq"
    ? { appId: o.appId, appSecret: o.appSecret, allowFrom: o.allow, groupAllowFrom: o.groupAllow }
    : { auth: o.auth ?? join(cfg.stateDir, "channels", `${name}.auth`), allowFrom: o.allow, groupAllowFrom: o.groupAllow };
  writeFileSync(file, `${JSON.stringify(own, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  done.push(`wrote ${file} (0600): ${o.allow.length} allowed in private, ${o.groupAllow.length} in groups`);

  const raw = JSON.parse(readFileSync(configFile, "utf8")) as { channels?: Record<string, { via: string }>; modules?: Record<string, Record<string, unknown>> };
  const backup = `${configFile}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-channel`;
  copyFileSync(configFile, backup);
  chmodSync(backup, 0o600);
  raw.channels = { ...raw.channels, [name]: { via: "bridge" } };
  raw.modules = { ...raw.modules, [app.module]: { ...raw.modules?.[app.module], enabled: true, ...(name === app.channel ? {} : { channel: name }) } };
  writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
  done.push(`${configFile}: channels.${name}.via = "bridge", modules.${app.module}.enabled = true (backup ${backup})`);

  const todo: string[] = [];
  const regFile = join(cfg.workspace, layout.registry);
  const reg = registryOf(cfg.workspace);
  const owner = ownersOf(reg)[0];
  if (o.ownerId && owner) {
    owner[1].senders = [...new Set([...(owner[1].senders ?? []).map(String), o.ownerId])];
    writeFileSync(regFile, `${JSON.stringify(reg, null, 2)}\n`);
    done.push(`${layout.registry}: the owner's entry has this channel's sender id`);
  } else {
    todo.push(o.ownerId ? `the people list (${regFile}) has no entry with "privacy": "owner": add one with "senders": ["<the id>"], or the role will not know its owner on ${name}`
      : `add the owner's sender id on ${name} to the owner's entry in ${regFile} ("senders"), or run this again with --owner-id`);
  }
  if (app.app === "whatsapp" && !whatsappLinked(cfg.stateDir, name))
    todo.push(`WhatsApp is not linked yet: hh channels link whatsapp --phone <the account's number>${name === app.channel ? "" : ` --name ${name}`}    (or put an existing login directory at ${(own as { auth: string }).auth})`);
  todo.push("hh modules install    (the bridge's packages and its launchd job; the bridge starts)");
  todo.push("restart hhd, then: hh channels    (the channel should be connected) and hh modules doctor");
  todo.push(`for the owner's /cc: the machine's account adds this channel to the role's owner-senders file (docs/contracts/machine.md)`);
  todo.push("tools.sendDryRun is not changed here: turn it off in the config when the role may really send");
  return { done, todo };
}

/**
 * Take a bridged channel away from a role: its job is stopped and unloaded, channels.<name> and its module's
 * entry leave the role's config (a backup is kept), and everything the channel kept in <stateDir>/channels — its file,
 * its login, its inbox — moves to <stateDir>/channels/removed-<time>/, with the job's file. Nothing is deleted.
 */
export async function removeChannel(cfg: Pick<Config, "stateDir" | "launchd">, configFile: string, name: string, svc: ServiceManager): Promise<string[]> {
  const raw = JSON.parse(readFileSync(configFile, "utf8")) as { channels?: Record<string, { via: string }>; modules?: Record<string, Record<string, unknown>> };
  const dir = join(cfg.stateDir, "channels");
  const mine = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${name}.`)) : [];
  if (raw.channels?.[name]?.via !== "bridge" && !mine.length) throw new Error(`${name} is not a channel of this role that goes over a bridge`);
  const done: string[] = [];
  const label = `${launchdLabels(cfg).hhd.replace(/\.hhd$/, "")}.bridge.${name}`;
  const out = await svc.stop(label);
  done.push(out.code === 0 ? `stopped and unloaded ${label}` : `${label} was not loaded`);
  const auth = whatsappAuth(cfg.stateDir, name);
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const app = Object.values(BRIDGE_APPS).find((a) => (raw.modules?.[a.module]?.["channel"] ?? a.channel) === name);
  if (raw.channels?.[name] || (app && raw.modules?.[app.module])) {
    const backup = `${configFile}.bak-${stamp}-channel`;
    copyFileSync(configFile, backup);
    chmodSync(backup, 0o600);
    delete raw.channels?.[name];
    if (app) delete raw.modules?.[app.module];
    writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
    done.push(`${configFile}: channels.${name}${app ? ` and modules.${app.module}` : ""} taken out (backup ${backup})`);
  }
  const to = join(dir, `removed-${stamp}`);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  const jobFiles = [".plist", ".service", ".timer"].map((ext) => `${label}${ext}`).filter((f) => existsSync(join(svc.dir, f)));
  for (const [from, as] of [...mine.map((f) => [join(dir, f), f] as const), ...jobFiles.map((f) => [join(svc.dir, f), f] as const)]) renameSync(from, join(to, as));
  done.push(`moved to ${to}: ${[...mine, ...jobFiles].join(", ") || "nothing"}`);
  if (dirname(auth) !== dir && existsSync(auth)) done.push(`the login at ${auth} is outside the state directory: left where it is`);
  done.push("restart hhd: it still has the channel until then. The owner's sender id stays in the people list and on the machine's side");
  return done;
}
