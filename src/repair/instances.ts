// The machine's role table: <GUARD_DIR>/instances.json, one entry per role keyed by its stateDir. It sits where the roles cannot
// write, so a role cannot change who may approve its repairs, which commits are its own, or whom a rollback tells.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { trusted } from "./approvals.ts";

export interface RoleEntry {
  /** the system account the role runs as */
  user: string;
  /** author of the commits made on the role's behalf (the watchdog's reverts); hh-guard knows the role's own commits by this email */
  author: { name: string; email: string };
  /** whose approval counts and over which channels; a rollback is reported to them */
  owner: { name: string; channels: string[] };
  /** where the repair commands check and clone; default under <stateDir>/repair/ */
  checkDir?: string;
  clone?: string;
}

export function roleEntry(guardDir: string, stateDir: string, selfUid: number): RoleEntry {
  const file = join(guardDir, "instances.json");
  if (!trusted(file, selfUid)) throw new Error(`repair: ${file} is missing or writable by this role; the role table must be held by the machine's account`);
  const entry = (JSON.parse(readFileSync(file, "utf8")) as Record<string, RoleEntry | undefined>)[stateDir];
  if (!entry) throw new Error(`repair: ${file} has no entry for ${stateDir}`);
  const me = userInfo().username;
  if (entry.user !== me) throw new Error(`repair: ${stateDir} runs as ${entry.user}, not ${me}`);
  return entry;
}

/** The file that holds a role's owner sender ids: <GUARD_DIR>/owner-senders/<the stateDir with every run of other characters as one "-">.json */
export const ownerSendersFile = (guardDir: string, stateDir: string): string =>
  join(guardDir, "owner-senders", `${stateDir.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "")}.json`);

/**
 * The owner's sender ids on each channel, exactly as that channel reports a sender (a phone number with its +, an
 * openid): { "stateDir": "<the role's>", "senders": { "<channel>": ["<id>", …] } }. A channel's bridge compares a
 * sender with these to know the owner's command, the one way round the role — so they are kept where the role cannot
 * write, and not in the role table, which is printed often. No file, a file or directory the role could have written,
 * or a file made for another stateDir: nobody is the owner ({}).
 */
export function ownerSenders(guardDir: string, stateDir: string, selfUid: number): Record<string, string[]> {
  const file = ownerSendersFile(guardDir, stateDir);
  if (!trusted(guardDir, selfUid) || !trusted(join(guardDir, "owner-senders"), selfUid) || !trusted(file, selfUid)) return {};
  const o = JSON.parse(readFileSync(file, "utf8")) as { stateDir?: string; senders?: Record<string, string[]> };
  return o.stateDir === stateDir ? o.senders ?? {} : {};
}
