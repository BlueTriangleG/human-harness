// Commands that change a role's installation — its channels, its launchd jobs, a new role — are the operator's.
// A role's own session (the kernel, its helpers, their subagents: every shell of theirs carries CLAUDECODE=1) is told
// so instead of running them. HH_OPERATOR=1 lets one through: for a person who works as the operator from a Claude Code
// session in the role's account.
// This is NOT a security boundary. The role has a shell under the same user and can unset a variable; it only stops a
// well-meant mistake. Whatever must hold against the role itself stays on the machine's side (docs/contracts/machine.md).
import { roleNames, type Config } from "./config.ts";
import { B, N, setLang } from "./lang/index.ts";

/**
 * role: for a command that runs before the role's config is read (hh new) — how to read it, so that the refusal is in
 * that role's language and names its owner; it is read only when the command is refused, and a config that cannot be
 * read leaves the default pack and no name.
 */
export function operatorOnly(env: Readonly<Record<string, string | undefined>> = process.env, role?: () => Config): void {
  if (env["CLAUDECODE"] !== "1" || env["HH_OPERATOR"] === "1") return;
  if (role) try { const own = role(); setLang(own.lang, roleNames(own)); } catch { /* no role here */ }
  throw new Error(B.cliDirect.operatorOnly(N.owner.trim() || B.brain.ownerNameFallback));
}
