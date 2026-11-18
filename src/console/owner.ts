// The console's write ports, POST /api/tell, /api/pair/code (hh console leaves a one-time code for a new token) and
// /api/pair (the page trades the code for the token), and the checks every write passes (the first, the Host check, is
// the one every request passes in server.ts; the token of check 4 is also what every read but /api/summary takes):
//   2. Origin is exactly this console (a cross-site page in the owner's browser always sends its own origin on a POST)
//   3. JSON with the console's own header (a cross-site request carrying them needs a preflight the console never answers)
//   4. the owner's token, in the X-HH-Owner header: the page keeps it in its own origin's storage, which is per port, so no
//      other console or local server ever gets it (a cookie goes to every port of 127.0.0.1: the owner's browser on a
//      role's console handed it every other role's token). Its sha256 is a line in the owner's token file (hh console
//      writes it, under the owner's account; for /api/pair/code the token is in the body), unless the instance turns the
//      token off. For a role under a standard account (not one that administers the
//      machine) the instance config is the role's to change, so what it names is checked rather than trusted: the file and
//      its directory must not be the role's account's, nor writable by group or others, at start and at every write; and
//      it cannot turn the token off
//   5. limits: ten tells a minute, a short body
// A tell from the console is the request `hh tell --from <owner>` sends, on the role's own control socket. The owner's name
// comes from the console's config, never from the browser, and the channel is the same local one: the owner's approvals do
// not count from it, as they do not from hh tell.
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";

export interface TellOptions {
  /** the owner's name, taken the way hh tell takes it when --from is not given */
  owner: string;
  /** sha256 (hex) of the owner's tokens, one line per paired client (a browser, an app), written by hh console (tokenFileOf); null: no token is asked */
  tokenFile: string | null;
  /** the role's id, in the cookie's name: browsers keep cookies per host, not per port, so two roles' consoles on 127.0.0.1 share them */
  roleId: string;
  /** a role under an account of its own: that account's uid, which must not be able to write the token (ownersOnly) */
  guard?: number;
}

export const MAX_TELL = 4000;
/** tells taken in any minute: the owner may speak while the role is at work (hhd folds it in), a stuck key may not flood it */
export const TELLS_PER_MINUTE = 10;
/**
 * A pairing address carries a code, never the token: hh console (and its --as, --url) leaves a code with the console for
 * a token it has just written to the owner's file, and the page trades the code for the token, once, within this long.
 * An address can stay behind in a browser's history or, when it starts the browser, in its command line.
 */
export const PAIR_CODE_MS = 60_000;
const MAX_BODY = 16_384;

export type Refusal = "origin" | "header" | "token";

/** the header the page sends the token in */
export const TOKEN_HEADER = "x-hh-owner";

/** the token as the request carries it: the header only (never a cookie) */
export const tokenOf = (req: IncomingMessage): string | undefined => {
  const v = req.headers[TOKEN_HEADER];
  return typeof v === "string" && v ? v : undefined;
};

/** the cookie the token was kept in before (it went to every port of 127.0.0.1): cleared wherever it still turns up */
export const oldCookie = (roleId: string): string => `hh_owner_${roleId}=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0`;

/** where the owner's token is kept: console.ownerTokenFile, else in the role's own state directory */
export const tokenFileOf = (cfg: Pick<Config, "console" | "stateDir">): string =>
  cfg.console?.ownerTokenFile ?? join(cfg.stateDir, "console", "owner.sha256");

/** the groups whose members administer the machine, by platform */
const ADMIN_GROUPS: Readonly<Record<string, readonly string[]>> = { darwin: ["admin"], linux: ["sudo", "wheel"] };

/**
 * Whether this process's account administers the machine (a member of an ADMIN_GROUPS group, its id read from etc): the
 * owner's own account. Not who sits at the screen: a role's own account can be logged in there (signed in at boot, or
 * the owner handing the screen to it), and that does not make it the owner.
 */
export function adminAccount(groups: readonly number[] = process.getgroups?.() ?? [], etc = "/etc/group", platform: string = process.platform): boolean {
  const names = ADMIN_GROUPS[platform] ?? [];
  let text: string;
  try { text = readFileSync(etc, "utf8"); } catch { return false; }
  return text.split("\n").map((l) => l.split(":")).some((f) => names.includes(f[0] ?? "") && f[2] !== undefined && groups.includes(Number(f[2])));
}

/**
 * The path that keeps the token from being the owner's alone for a role running as uid me, or null: the directory (it must
 * be there) or the file (when it is) belongs to me, or group or others can write it. Such a token the role could write.
 */
export function ownersOnly(file: string, me: number | undefined): string | null {
  for (const p of [dirname(file), file]) {
    let st;
    try { st = statSync(p); } catch { if (p === file) continue; return p; }
    if (st.uid === me || (st.mode & 0o022) !== 0) return p;
  }
  return null;
}

/**
 * Whether the console takes the owner's words, and how (instance config console.ownerToken / ownerTokenFile). On by
 * default for a role running under an account that administers the machine, the owner's own: the token in its state
 * directory keeps out every other account's processes, which reach 127.0.0.1 as well. A role under a standard account
 * (one of its own) stays read-only until its instance names a token file the role cannot write (hh console --as sets it
 * up); refused: refusedBy names what the role could write, or the token turned off.
 */
export function talkOf(cfg: Pick<Config, "console" | "stateDir" | "id">, owner: string | null, admin: boolean = adminAccount(), me = process.getuid?.(), refusedBy: (what: string) => void = () => {}): TellOptions | undefined {
  if (!owner) return undefined;
  if (admin) return { owner, roleId: cfg.id, tokenFile: cfg.console?.ownerToken === false ? null : tokenFileOf(cfg) };
  const file = cfg.console?.ownerTokenFile;
  if (!file) { if (cfg.console?.ownerToken === false) refusedBy("console.ownerToken"); return undefined; }
  const why = ownersOnly(file, me);
  if (why) { refusedBy(why); return undefined; }
  return { owner, roleId: cfg.id, tokenFile: file, ...(me !== undefined ? { guard: me } : {}) };
}

/** checks 2 and 3 */
export function sameConsole(req: IncomingMessage, port: number): Refusal | null {
  const origin = req.headers.origin;
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}` && origin !== `http://[::1]:${port}`) return "origin";
  if (req.headers["x-hh-console"] !== "1" || !String(req.headers["content-type"] ?? "").startsWith("application/json")) return "header";
  return null;
}

/** check 4. The file is read every time: pairing again or deleting it takes effect at once; guard: checked every time too */
export function tokenMatches(tokenFile: string | null, token: string | undefined, guard?: number): boolean {
  if (tokenFile === null) return true;
  if (!token || (guard !== undefined && ownersOnly(tokenFile, guard))) return false;
  let lines: string[];
  try { lines = readFileSync(tokenFile, "utf8").split("\n").map((l) => l.trim()).filter(Boolean); } catch { return false; }
  const got = createHash("sha256").update(token).digest();
  return lines.some((l) => { const want = Buffer.from(l, "hex"); return want.length === got.length && timingSafeEqual(want, got); });
}

/** The body as a JSON object; null when it is larger than the limit or not an object */
export function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve(null); req.destroy(); return; }
      parts.push(c);
    });
    req.on("end", () => {
      try {
        const v = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
        resolve(v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null);
      } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}
