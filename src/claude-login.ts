// Which Claude login a role will think with. HH has no login of its own and never reads, keeps or passes on a
// credential: it asks Claude Code's own `auth status` and keeps only the kind of login it names (and a subscription's
// plan). Changing the login is Claude Code's own /login. The question is asked without the variables only a terminal
// carries (a key or token, a switch to Bedrock or Vertex): the role's jobs run in the background without them, and
// auth status counts each of them as a login.
import { execFile, spawn } from "node:child_process";

export interface Login {
  /** subscription: claude.ai, the default; console: an Anthropic Console account's key, made by /login; other: any
   *  other login Claude Code reports, which HH has not been tried on; none: not logged in; unknown: auth status printed
   *  something else (a Claude Code too old to have it, or an error of its own), so whether there is a login is not known */
  kind: "subscription" | "console" | "other" | "none" | "unknown";
  /** a subscription's plan as Claude Code names it (Pro, Max, Team, …) */
  plan?: string;
  /** an other login's method and provider, as auth status names them */
  method?: string;
  /** unknown: the first line of what came instead */
  said?: string;
}

/** what `claude auth status` printed (else, what it said on stderr or why it did not run), as the kind of login it names */
export function loginOf(out: string, err = ""): Login {
  let s: { loggedIn?: unknown; authMethod?: unknown; apiKeySource?: unknown; subscriptionType?: unknown; apiProvider?: unknown };
  try { s = JSON.parse(out) as typeof s; } catch {
    if (/^not logged in/i.test(out.trim())) return { kind: "none" };
    return { kind: "unknown", said: (out.trim() || err.trim()).split("\n")[0]!.slice(0, 160) };
  }
  if (s.loggedIn !== true) return { kind: "none" };
  if (s.authMethod === "claude.ai") {
    const plan = typeof s.subscriptionType === "string" && s.subscriptionType ? s.subscriptionType[0]!.toUpperCase() + s.subscriptionType.slice(1) : "";
    return { kind: "subscription", ...(plan ? { plan } : {}) };
  }
  if (s.authMethod === "api_key" && s.apiKeySource === "/login managed key") return { kind: "console" };
  return { kind: "other", method: [s.authMethod, s.apiProvider === "firstParty" ? "" : s.apiProvider].filter((x) => typeof x === "string" && x).join(", ") };
}

/** the environment without what only a terminal carries: the role's jobs have none of it */
export const withoutTerminal = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).filter(([k]) => !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_\w+|CLAUDECODE)$/.test(k)));

/** the login Claude Code reports for the role */
export const claudeLogin = (exe = "claude"): Promise<Login> => new Promise((resolve) => {
  // auth status exits 1 when there is no login, its JSON on stdout all the same
  execFile(exe, ["auth", "status"], { env: withoutTerminal(process.env), timeout: 20_000 }, (e, out, err) => resolve(loginOf(String(out ?? ""), String(err ?? "") || (e?.message ?? ""))));
});

/**
 * Claude Code's own sign-in, started for the owner: `claude auth login --claudeai` (a subscription, the default) or
 * `--console`. It opens their browser and keeps the login itself; HH starts the command and reads nothing of it. tty:
 * the terminal is lent to it (it may ask there to paste a code the sign-in page shows). Its exit code; 127 when it did
 * not start, 124 when it was still waiting after timeoutMs.
 */
export const claudeLogIn = (method: "claudeai" | "console", o: { tty: boolean; exe?: string; timeoutMs?: number }): Promise<number> => new Promise((resolve) => {
  const p = spawn(o.exe ?? "claude", ["auth", "login", `--${method}`], { stdio: o.tty ? "inherit" : "ignore", env: withoutTerminal(process.env) });
  const timer = setTimeout(() => { p.kill(); resolve(124); }, o.timeoutMs ?? 600_000);
  p.on("error", () => { clearTimeout(timer); resolve(127); });
  p.on("exit", (code) => { clearTimeout(timer); resolve(code ?? 1); });
});
