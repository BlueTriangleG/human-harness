// This computer at a glance, for /machine and the menu bar of Human.app: which roles run here, and for each what its
// console's summary says (up, awake, at work, quota, load level, today's trouble: never what about). Read-only: each role's
// console is asked over 127.0.0.1 for /api/summary, the one read that needs no owner's token. Nothing a role names is run
// or written: a role's role.json sits in its own folder, so from it only the id, the name, the account and the port are taken.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { programOf, type Installed } from "../services/index.ts";

export interface RoleEntry { id: string; name: string; account: string; port: number }

const ID = /^[a-z0-9-]+$/;

/** a role.json's four fields, when they are what they say they are */
function entryOf(v: unknown): RoleEntry | null {
  const r = v as Partial<Record<keyof RoleEntry, unknown>> | null;
  if (!r || typeof r.id !== "string" || !ID.test(r.id) || !Number.isInteger(r.port) || (r.port as number) <= 0 || (r.port as number) > 65535) return null;
  return { id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 60) : r.id, account: typeof r.account === "string" ? r.account.slice(0, 60) : "", port: r.port as number };
}

/** the uid of the process listening on 127.0.0.1:<port>: Linux says it in /proc/net/tcp; macOS's netstat names the pid, ps its user */
export function listenerUid(port: number): number | undefined {
  try {
    if (process.platform === "linux") {
      const want = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
      const row = readFileSync("/proc/net/tcp", "utf8").split("\n").map((l) => l.trim().split(/\s+/)).find((f) => f[1] === want && f[3] === "0A");
      return row ? Number(row[7]) : undefined;
    }
    const line = execFileSync("/usr/sbin/netstat", ["-anv", "-p", "tcp"], { encoding: "utf8" }).split("\n")
      .find((l) => { const f = l.trim().split(/\s+/); return f[3] === `127.0.0.1.${port}` && f[5] === "LISTEN"; });
    const pid = line && /\S+:(\d+)\s/.exec(line.slice(line.indexOf("LISTEN") + 6))?.[1];
    if (!pid) return undefined;
    const uid = Number(execFileSync("/bin/ps", ["-o", "uid=", "-p", pid], { encoding: "utf8" }).trim());
    return Number.isInteger(uid) ? uid : undefined;
  } catch { return undefined; }
}

/** how a port and a folder are checked; the real ones by default */
export interface Lookups {
  /** this console's account */
  me: number;
  listener: (port: number) => number | undefined;
  folderUid: (dir: string) => number | undefined;
  /** a job's instance config: its role's id */
  configId: (file: string) => string | undefined;
}

export const realLookups = (): Lookups => ({
  me: process.getuid?.() ?? -1,
  listener: listenerUid,
  folderUid: (d) => { try { return statSync(d).uid; } catch { return undefined; } },
  configId: (f) => { try { const id = (JSON.parse(readFileSync(f, "utf8")) as { id?: unknown }).id; return typeof id === "string" ? id : undefined; } catch { return undefined; } },
});

/**
 * The roles on this computer, each one only when the port is held by the account it claims, read off the process that
 * listens there, not off anything a role writes:
 *   - this account's: the consoles among its jobs (the service manager's: launchd's or systemd's; their program
 *     [node, …/main.ts], or [HH, "--", node, …/main.ts] once HH.app starts them) whose port this account listens on;
 *     self is this console
 *   - another account's: a folder under shared (<id>/role.json) that belongs to the account listening on its port, named
 *     as its id, the id none of this account's roles has (a role's folder is its own: it could claim any name and port)
 */
export function rolesOnMachine(o: { shared: string; jobs: readonly Installed[]; account: string; self: RoleEntry }, look: Lookups = realLookups()): RoleEntry[] {
  const out: RoleEntry[] = [o.self];
  for (const j of o.jobs) {
    const main = programOf(j)[1];
    const port = Number(j.env.HH_CONSOLE_PORT);
    if (!main?.endsWith("/src/console/main.ts") || !Number.isInteger(port) || out.some((e) => e.port === port) || look.listener(port) !== look.me) continue;
    const fromLabel = j.label.replace(/^ai\.hh\./, "").replace(/\.?console$/, "");
    const id = (j.env.HH_CONFIG && look.configId(j.env.HH_CONFIG)) || fromLabel || o.account;
    const e = entryOf({ id, name: id, account: o.account, port });
    if (e) out.push(e);
  }
  const ours = new Set(out.map((e) => e.id));
  for (const d of existsSync(o.shared) ? readdirSync(o.shared) : []) {
    let e: RoleEntry | null;
    try { e = entryOf(JSON.parse(readFileSync(join(o.shared, d, "role.json"), "utf8"))); } catch { continue; }
    if (!e || e.id !== d || ours.has(e.id) || out.some((x) => x.port === e!.port)) continue;
    const uid = look.listener(e.port);
    if (uid === undefined || uid === look.me || look.folderUid(join(o.shared, d)) !== uid) continue;
    out.push(e);
  }
  return out;
}

type Get = (url: string) => Promise<unknown>;
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});

/** the most a console's summary may be: anything bigger is not one */
export const SUMMARY_MAX_BYTES = 64 * 1024;

/**
 * GET one of this computer's consoles: 127.0.0.1 only, no redirect followed (a 3xx is a failure: a role's own server on
 * its port could send this console's process anywhere), two seconds, at most SUMMARY_MAX_BYTES, JSON.
 */
export async function getLocal(url: string, max = SUMMARY_MAX_BYTES, ms = 2000): Promise<unknown> {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1") throw new Error(`not a console on this computer: ${u.host}`);
  const r = await fetch(u, { redirect: "manual", signal: AbortSignal.timeout(ms) });
  if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}`);
  const parts: Uint8Array[] = [];
  let n = 0;
  for await (const c of r.body as unknown as AsyncIterable<Uint8Array>) {
    n += c.byteLength;
    if (n > max) throw new Error(`more than ${max} bytes`);
    parts.push(c);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

/**
 * What a console tells anyone, unpaired (/api/summary): how the role is, never what it is about. Up, awake / asleep,
 * at work, the week's quota, the load guard's level, today's stops, refusals and blocks in the role's own time zone;
 * no topic, no words, no name. From the bodies of its own /api/status, /api/incidents and /api/load.
 */
export function summaryOf(st: unknown, inc: unknown, load: unknown, now: number): Record<string, unknown> {
  const s = record(record(st).status);
  const i = record(inc), l = record(load);
  const hours = Array.isArray(i.hours) ? (i.hours as Array<Record<string, number | string>>) : [];
  let day = "";
  try { day = new Intl.DateTimeFormat("en-CA", { timeZone: typeof i.tz === "string" ? i.tz : undefined }).format(now); } catch { /* no hours to count */ }
  const today = (k: string): number => hours.filter((h) => h.day === day).reduce((n, h) => n + (Number(h[k]) || 0), 0);
  const quota = record(s.quotaUsed).sevenDay;
  return {
    up: !!st && record(st).ok !== false, alertness: typeof s.alertness === "string" ? s.alertness : null, nightRest: s.nightRest === true, focus: !!s.focusSlot,
    busy: Array.isArray(s.regions) && (s.regions as Array<{ busy?: boolean }>).some((r) => r.busy === true),
    quota: typeof quota === "number" ? quota : null, load: typeof l.level === "string" ? l.level : null,
    today: { stops: today("stops"), refusals: today("refusals"), blocks: today("blocks") },
    rulesErrors: Array.isArray(s.rulesErrors) ? s.rulesErrors.length : 0,
  };
}

const word = (v: unknown): string | null => (typeof v === "string" && /^[a-z][a-z-]{0,23}$/.test(v) ? v : null);
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : 0);

/**
 * Another console's summary as read here: only summaryOf's keys, each of its own type, else empty. The console is the
 * role's process, which can say anything: what else it sends (an id, a name, a port) never reaches the role's entry.
 */
export function summaryFrom(v: unknown): Record<string, unknown> {
  const s = record(v), t = record(s.today);
  return {
    up: s.up === true, alertness: word(s.alertness), nightRest: s.nightRest === true, focus: s.focus === true, busy: s.busy === true,
    quota: typeof s.quota === "number" && Number.isFinite(s.quota) ? s.quota : null,
    load: ["ok", "tight", "danger"].includes(s.load as string) ? s.load : null,
    today: { stops: count(t.stops), refusals: count(t.refusals), blocks: count(t.blocks) }, rulesErrors: count(s.rulesErrors),
  };
}

/** one role as its console's summary tells it; up false when it does not answer */
export async function roleView(e: RoleEntry, get: Get): Promise<Record<string, unknown>> {
  return { ...e, ...summaryFrom(await get(`http://127.0.0.1:${e.port}/api/summary`).catch(() => null)) };
}

/** the heavy-job lock, when the instance names one (console.lockDir: a folder there while held, holding who and pid) */
export function lockView(dir: string | undefined): { held: boolean; who: string; alive: boolean } | null {
  if (!dir) return null;
  if (!existsSync(dir)) return { held: false, who: "", alive: false };
  const read = (f: string): string => { try { return readFileSync(join(dir, f), "utf8").trim(); } catch { return ""; } };
  const pid = Number(read("pid"));
  let alive = false;
  try { if (pid > 0) { execFileSync("/bin/ps", ["-p", String(pid)], { stdio: "ignore" }); alive = true; } } catch { alive = false; }
  return { held: true, who: read("who").slice(0, 120), alive };
}
