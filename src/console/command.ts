// Each role's own short command, put on its owner's PATH: `<id> "…"` says something to it, `<id> console [--pair]`
// opens its console on the talk page (pairing the browser the first time). hh modules install writes it for a role
// running under the owner's account; hh console --as <user> writes it for a role under an account of its own, where both
// halves go through that account (sudo). A file of the same name that this did not write is never touched.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

/** the line every command written here carries, by which it is known as one of ours */
export const MARK = "# hh role command";

const sh = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

/**
 * The script. config, node, code: how the role runs (its instance config, the node and the checkout it runs on).
 * as: the account the role runs under, when it is not the owner's own; then the owner's node and checkout open the
 * console, and a tell goes in through that account.
 */
export function commandText(o: { id: string; config: string; node: string; code: string; as?: { user: string; node: string; code: string } }): string {
  const cli = (node: string, code: string): string => `${sh(node)} ${sh(join(code, "src", "cli.ts"))}`;
  const consoleLine = o.as ? `${cli(o.as.node, o.as.code)} console --as ${sh(o.as.user)} "$@"` : `/usr/bin/env HH_CONFIG=${sh(o.config)} ${cli(o.node, o.code)} console "$@"`;
  const tellLine = o.as ? `sudo -u ${sh(o.as.user)} -H /usr/bin/env HH_CONFIG=${sh(o.config)} ${cli(o.node, o.code)} tell "$*"` : `/usr/bin/env HH_CONFIG=${sh(o.config)} ${cli(o.node, o.code)} tell "$*"`;
  return [
    "#!/bin/sh",
    `${MARK} ${o.id}: written by HH; to rewrite it run hh modules install${o.as ? ` (or hh console --as ${o.as.user})` : ""} again`,
    `#   ${o.id} "…"                say something to this role and print its reply`,
    `#   ${o.id} console [--pair]   open its console in the browser, on the talk page (the first time it pairs this browser)`,
    `[ $# -gt 0 ] || { echo 'usage: ${o.id} "what you want to say" | ${o.id} console [--pair]' >&2; exit 2; }`,
    `if [ "$1" = console ]; then shift; exec ${consoleLine}; fi`,
    `exec ${tellLine}`,
    "",
  ].join("\n");
}

/** where it went, or why it did not: the line for the person installing */
export type Placed = { file: string; onPath: boolean } | { skipped: string };

/** where a role's own short command was put, kept in its state directory: hh remove takes it from there, not from the
 *  PATH it happens to run with (npx's run of setup had folders of its own on it) */
export const commandRecord = (stateDir: string): string => join(stateDir, "command.json");

/**
 * Put the command into ~/.local/bin (created; said when it is not on PATH yet). Not the first writable folder of home's
 * on PATH: that is as often a tool's own (nvm's node bin, npx's node_modules/.bin), where a node switch or an uninstall
 * takes the command with it. Skipped when a file of that name is there and is not ours, or when the name already runs
 * something else from an earlier directory on PATH.
 */
export function placeCommand(id: string, text: string, env: { PATH?: string; HOME?: string }): Placed {
  const home = resolve(env.HOME ?? "");
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean).map((d) => resolve(d));
  const dir = join(home, ".local", "bin");
  const ours = (f: string): boolean => { try { return readFileSync(f, "utf8").includes(`${MARK} ${id}:`); } catch { return false; } };
  const earlier = dirs.slice(0, Math.max(0, dirs.indexOf(dir))).map((d) => join(d, id)).find((f) => existsSync(f) && !ours(f));
  if (earlier) return { skipped: earlier };
  const file = join(dir, id);
  if (existsSync(file) && !ours(file)) return { skipped: file };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text, { mode: 0o755 });
  return { file, onPath: dirs.includes(dir) };
}
