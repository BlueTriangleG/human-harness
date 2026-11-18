// A channel that runs in its own process, the bridge, reached over a unix socket. The chat app's code and dependencies
// stay out of hhd; hhd and hh send share the bridge's one connection to the app; and messages that arrive while hhd is
// down wait in the bridge's inbox. bridgeChannel is HH's side. serveBridge is the bridge's side: it puts any Channel
// behind the socket. The contract is docs/contracts/channels.md.
//
// The protocol is JSON lines. A send is one connection: {"op":"send","m":<OutboundMessage>} → <Delivered>, then the
// bridge closes it. A listener keeps its connection: {"op":"listen"} → the bridge pushes {"in":<id>,"m":<InboundMessage>}
// for every message in its inbox, oldest first, then each new one; the listener answers {"ack":<id>} (taken: the bridge
// deletes it) or {"nack":<id>} (not taken: it stays and goes again at the next listen). One listener at a time.
// {"op":"status"} → <BridgeStatus>, then the bridge closes it: whoever watches the role's channels asks this.
// Its log (standard output) has one line for every message it keeps ("bridge: in") and every send it is asked for
// ("bridge: out"), without who or what, and nothing a library prints by itself (quietConsole).
//
// The owner's command (a private message from the owner that opens with /cc) never reaches the inbox: the bridge puts it
// in <name>.direct/ beside it, where the role's watchdog picks it up. It is the owner's way round the role, so it is
// told apart here, before hhd: it must work when hhd is down, and a message in the inbox is gone within a second.
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { loadConfig, roleNames } from "../config.ts";
import { setLang, T } from "../lang/index.ts";
import { Logger } from "../log.ts";
import { ownerSenders } from "../repair/instances.ts";
import { GUARD_DIR } from "../repair/machine.ts";
import { bridgeRecord, markRecord } from "../repair/restart.ts";
import type { Channel, Delivered, InboundMessage, OutboundMessage } from "./types.ts";

type Log = Pick<Logger, "info" | "warn">;

/** Where a role's bridge for one channel listens, and where it keeps what arrived. */
export const bridgeSocket = (stateDir: string, name: string): string => join(stateDir, "channels", `${name}.sock`);
export const bridgeInbox = (stateDir: string, name: string): string => join(stateDir, "channels", `${name}.inbox`);
/** Where the bridge puts the owner's commands instead of the inbox */
export const bridgeDirect = (stateDir: string, name: string): string => join(stateDir, "channels", `${name}.direct`);

/** Where a bridge that remembers what a reply may quote keeps it (the QQ bridge does) */
export const bridgeQuotes = (stateDir: string, name: string): string => join(stateDir, "channels", `${name}.quotes.json`);

/**
 * What a bridge answers to {"op":"status"}: its channel's state, since when the bridge serves, how many messages wait, and
 * what a watchdog needs to tell that the role does not take or does not answer — times only, never who or what:
 * waiting: for how many seconds the oldest message in the inbox has waited to be taken (0: none waits);
 * ownerIn: when the owner's last private messages came in (epoch seconds, at most five; the owner's command is not one);
 * lastOut: when a send last went through (epoch seconds; null: none since the bridge started).
 */
export interface BridgeStatus { connected: boolean; down?: string; since: string; inbox: number; direct: number; waiting: number; ownerIn: number[]; lastOut: number | null }

/** The owner's command: /cc, with a half-width or a full-width slash */
const OWNER_COMMAND = /^\s*[/／]cc\b/i;
/** A private message from one of the owner's sender ids (compared as the channel reports them). A group is never one. */
export const fromOwner = (m: InboundMessage, owners: readonly string[]): boolean => m.isGroup === false && !!m.senderId && owners.includes(m.senderId);
/** The owner's private message that opens with the command */
export const isOwnerCommand = (m: InboundMessage, owners: readonly string[]): boolean => fromOwner(m, owners) && OWNER_COMMAND.test(m.text);
/** How many of the owner's last messages a bridge remembers the times of */
const OWNER_KEPT = 5;

/** Same wait as the gateway's re-ask: a minute for text, two and a half with media. */
const SEND_MS = 60_000;
const SEND_MEDIA_MS = 150_000;
const INBOX_FILE = /^\d{15}-\d{6}\.json$/;

/**
 * The text HH gets for a message with attachments: the message's own text, then one attachment line per saved file.
 * Where a person typed something that opens like an attachment line, its bracket becomes a full-width one, so only the
 * bridge can make such a line (relay/logic.mjs did the same). How a line opens is read off the pack's own entry.
 */
export function withAttachments(text: string, files: readonly string[]): string {
  const open = T.deliver.attachmentLine("\0").split("\0", 1)[0]!.replace(/[\s:：]+$/, "");   // the bracket and the label: "[label" of "[label: <path>]"
  const typed = new RegExp(`${open.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[:：]`, "g");
  const own = open ? text.replace(typed, `［${open.slice(1)}:`) : text;
  return [own, ...files.filter((f) => !own.includes(f)).map((f) => T.deliver.attachmentLine(f))].filter(Boolean).join("\n");
}

/** What a bridge's channel answers when its app is not connected, and when it cannot read the recipient. The bridge programs answer with these, so that this file is the only one of a bridge that reads the pack. */
export const notConnected = (name: string): Delivered => ({ ok: false, out: T.deliver.offline(name) });
export const badTarget = (target: string): Delivered => ({ ok: false, out: T.deliver.badTarget(target) });

function onLines(s: Socket, take: (v: Record<string, unknown>) => void): void {
  let buf = "";
  s.setEncoding("utf8");
  s.on("data", (chunk: string) => {
    buf += chunk;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try { if (line.trim()) take(JSON.parse(line) as Record<string, unknown>); } catch { /* not a line of this protocol */ }
    }
  });
}
const line = (v: unknown): string => `${JSON.stringify(v)}\n`;

export function bridgeChannel(name: string, socket: string, o: { log?: Log; retryMs?: number; sendMs?: number } = {}): Channel {
  let listener: Socket | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  let lost = false;
  const listen = (onMessage: (m: InboundMessage) => void): void => {
    if (stopped) return;
    const s = createConnection(socket);
    s.on("connect", () => {
      listener = s;
      lost = false;
      s.write(line({ op: "listen" }));
      o.log?.info("bridge: listening", { channel: name });
    });
    onLines(s, (v) => {
      if (typeof v.in !== "string") return;
      let taken = true;
      try { onMessage({ ...(v.m as InboundMessage), channel: name }); } catch (e) {
        taken = false;
        o.log?.warn("bridge: message not taken, it stays in the bridge's inbox", { channel: name, error: String(e).slice(0, 200) });
      }
      s.write(line(taken ? { ack: v.in } : { nack: v.in }));
    });
    s.on("error", () => { /* close follows */ });
    s.on("close", () => {
      if (listener === s) listener = null;
      if (stopped) return;
      if (!lost) o.log?.warn("bridge: not reachable, retrying", { channel: name });
      lost = true;
      retry = setTimeout(() => listen(onMessage), o.retryMs ?? 2_000);
    });
  };
  return {
    get connected(): boolean { return listener !== null; },
    start: async (onMessage) => { listen(onMessage); },
    stop: async () => { stopped = true; clearTimeout(retry); listener?.end(); },
    send: (m) => sendVia(name, socket, m, o.sendMs ?? (m.media ? SEND_MEDIA_MS : SEND_MS)),
  };
}

/** Ask a bridge for its status; null when it does not answer in time (not running, or stuck) */
export function bridgeStatus(socket: string, ms = 5_000): Promise<BridgeStatus | null> {
  return new Promise((resolve) => {
    const s = createConnection(socket);
    const finish = (v: BridgeStatus | null): void => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => finish(null), ms);
    s.on("connect", () => s.write(line({ op: "status" })));
    onLines(s, (v) => finish(v as unknown as BridgeStatus));
    s.on("error", () => finish(null));
    s.on("close", () => finish(null));
  });
}

function sendVia(name: string, socket: string, m: OutboundMessage, ms: number): Promise<Delivered> {
  return new Promise((resolve) => {
    const s = createConnection(socket);
    let asked = false;
    let done = false;
    const finish = (d: Delivered): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      resolve(d);
    };
    // Asked and no answer: the bridge may be sending it right now, so this is not a failure to resend on.
    const unsure = (why: string, kind: "timeout" | "dropped"): Delivered => ({ ok: false, out: T.deliver.unsure(why), unsure: kind });
    const timer = setTimeout(() => finish(unsure(T.deliver.bridgeSilent(name), "timeout")), ms);
    s.on("connect", () => { asked = true; s.write(line({ op: "send", m })); });
    onLines(s, (v) => finish(v as unknown as Delivered));
    s.on("error", (e) => finish(asked ? unsure(e.message, "dropped") : { ok: false, out: T.deliver.noBridge(name, e.message) }));
    s.on("close", () => finish(asked ? unsure(T.deliver.bridgeSilent(name), "dropped") : { ok: false, out: T.deliver.noBridge(name, "closed") }));
  });
}

/**
 * Put a channel behind the socket: start it, keep what it hands in until a listener takes it, answer sends and status.
 * direct: the messages is() says yes to go to dir instead of the inbox, and no listener ever gets them.
 */
export async function serveBridge(o: { socket: string; inbox: string; channel: Channel; direct?: { dir: string; is(m: InboundMessage): boolean }; owner?: (m: InboundMessage) => boolean; log?: Log }): Promise<{ close(): Promise<void> }> {
  for (const d of [o.inbox, ...(o.direct ? [o.direct.dir] : [])]) mkdirSync(d, { recursive: true, mode: 0o700 });
  mkdirSync(dirname(o.socket), { recursive: true });
  const since = new Date().toISOString();
  let listener: Socket | null = null;
  let seq = 0;
  const now = (): number => Math.floor(Date.now() / 1000);
  const ownerIn: number[] = [];
  let lastOut: number | null = null;
  const waiting = (dir: string): string[] => readdirSync(dir).filter((f) => INBOX_FILE.test(f)).sort();
  const push = (s: Socket, f: string): void => { s.write(line({ in: f, m: JSON.parse(readFileSync(join(o.inbox, f), "utf8")) })); };
  const keep = (m: InboundMessage): void => {
    const direct = o.direct?.is(m) ?? false;
    const dir = direct ? o.direct!.dir : o.inbox;
    if (!direct && o.owner?.(m)) { ownerIn.push(now()); ownerIn.splice(0, ownerIn.length - OWNER_KEPT); }
    const f = `${String(Date.now()).padStart(15, "0")}-${String(seq++ % 1e6).padStart(6, "0")}.json`;
    writeFileSync(join(dir, `.${f}`), JSON.stringify(m), { mode: 0o600 });
    renameSync(join(dir, `.${f}`), join(dir, f));
    o.log?.info("bridge: in", { group: m.isGroup === true, kept: direct ? "direct" : "inbox" });   // never who or what
    if (!direct && listener) push(listener, f);
  };
  const server = createServer((s) => {
    s.on("error", () => { /* close follows */ });
    s.on("close", () => { if (listener === s) listener = null; });
    onLines(s, (v) => {
      if (v.op === "send") {
        const m = v.m as OutboundMessage;
        const asked = Date.now();
        void o.channel.send(m)
          .catch((e: unknown): Delivered => ({ ok: false, out: T.deliver.sendFailed(e instanceof Error ? e.message : String(e)) }))
          .then((d) => {
            if (d.ok) lastOut = now();
            o.log?.info("bridge: out", { ok: d.ok, ...(d.unsure ? { unsure: d.unsure } : {}), media: Boolean(m.media), ms: Date.now() - asked });   // never to whom or what
            s.end(line(d));
          });
      } else if (v.op === "listen") {
        if (listener && listener !== s) listener.destroy();
        listener = s;
        for (const f of waiting(o.inbox)) push(s, f);
      } else if (v.op === "status") {
        const inbox = waiting(o.inbox);   // a file's name starts with the millisecond it arrived
        const status: BridgeStatus = {
          connected: o.channel.connected, ...(o.channel.down ? { down: o.channel.down } : {}), since,
          inbox: inbox.length, direct: o.direct ? waiting(o.direct.dir).length : 0,
          waiting: inbox.length ? Math.max(0, now() - Math.floor(Number(inbox[0]!.slice(0, 15)) / 1000)) : 0, ownerIn, lastOut,
        };
        s.end(line(status));
      } else if (typeof v.ack === "string" && INBOX_FILE.test(v.ack)) {
        rmSync(join(o.inbox, v.ack), { force: true });
      }
    });
  });
  rmSync(o.socket, { force: true });
  await new Promise<void>((res, rej) => { server.once("error", rej); server.listen(o.socket, () => res()); });
  chmodSync(o.socket, 0o600);
  await o.channel.start(keep);
  o.log?.info("bridge: serving", { socket: o.socket });
  return {
    close: async () => {
      await o.channel.stop();
      listener?.destroy();
      await new Promise<void>((res) => server.close(() => res()));
    },
  };
}

/**
 * A bridge's standard output is its log, and the libraries under an app's client print to the console on their own: the
 * signal library prints whole sessions, key material included, at every message. So in a bridge process nothing a library
 * prints reaches the log as it is: console.log, info and debug are dropped; of console.warn and error only the first
 * argument is kept, when it is text, as one line of the bridge's own log.
 */
export function quietConsole(log: Pick<Logger, "warn">): void {
  const drop = (): void => {};
  const said = (...a: unknown[]): void => { if (typeof a[0] === "string") log.warn("library", { said: a[0].slice(0, 200) }); };
  Object.assign(console, { log: drop, info: drop, debug: drop, warn: said, error: said });
}

/**
 * An error a library under the bridge leaves uncaught (an 'error' event nobody listens to, a rejected promise nobody
 * awaits) would end the process; on 11-16 baileys' fetch lost its socket that way while nothing was being sent. The
 * bridge logs what kind of error it was, never its words (they may carry a number or a message's text), and keeps
 * running. A connection that is really gone is still the library's to reconnect and the watchdog's to restart.
 */
export function keepRunning(log: Pick<Logger, "warn">): void {
  const word = (v: unknown): string | undefined => (typeof v === "string" && /^[A-Za-z_]{1,40}$/.test(v) ? v : undefined);
  const kind = (e: unknown): Record<string, string | undefined> => {
    const x = (e ?? {}) as { name?: unknown; code?: unknown; cause?: { name?: unknown; code?: unknown } };
    return { kind: word(x.name) ?? typeof e, code: word(x.code), cause: word(x.cause?.code) ?? word(x.cause?.name) };
  };
  process.on("uncaughtException", (e) => log.warn("uncaught error, kept running", kind(e)));
  process.on("unhandledRejection", (e) => log.warn("unhandled rejection, kept running", kind(e)));
}

/**
 * A bridge process's start, the same for every app: the role's config from HH_CONFIG (as hhd and the console read it) and
 * its language; the bridge's own file <stateDir>/channels/<name>.json, which holds only what the bridge alone needs (login,
 * allow lists, media directory); then serve, and record the pid in the role's state directory, by which a deploy and a
 * rollback stop it (src/repair/restart.ts bridgeRecord). media defaults to <stateDir>/channels/<name>.media; quotes is
 * bridgeQuotes, for a bridge that remembers what a reply may quote.
 * Who the owner is on this channel comes from the machine's side (src/repair/instances.ts ownerSenders), never from
 * anything the role can write; with nobody there, no message is the owner's command.
 */
export async function runBridge<Own extends { media?: string }>(name: string, build: (own: Own, o: { media: string; quotes: string; log: Logger }) => Channel): Promise<void> {
  const cfg = loadConfig();
  setLang(cfg.lang, roleNames(cfg));
  const own = JSON.parse(readFileSync(join(cfg.stateDir, "channels", `${name}.json`), "utf8")) as Own;
  const media = own.media ?? join(cfg.stateDir, "channels", `${name}.media`);
  mkdirSync(media, { recursive: true });
  const log = new Logger(`bridge.${name}`, (r) => process.stdout.write(`${JSON.stringify(r)}\n`));
  quietConsole(log);
  const owners = ownerSenders(GUARD_DIR, cfg.stateDir, process.getuid!())[name] ?? [];
  if (!owners.length) log.warn("no owner sender ids for this channel on the machine's side: the owner's command is not recognised here");
  const served = await serveBridge({
    socket: bridgeSocket(cfg.stateDir, name), inbox: bridgeInbox(cfg.stateDir, name), channel: build(own, { media, quotes: bridgeQuotes(cfg.stateDir, name), log }), log,
    direct: { dir: bridgeDirect(cfg.stateDir, name), is: (m) => isOwnerCommand(m, owners) }, owner: (m) => fromOwner(m, owners),
  });
  keepRunning(log);
  markRecord(cfg.stateDir, bridgeRecord(name), process.pid);
  for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void served.close().finally(() => process.exit(0)));
}
