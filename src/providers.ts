// Another model provider for a region: an Anthropic-format endpoint (DeepSeek's, or a gateway in front of another
// vendor's models). The region's sessions reach it through Claude Code's environment, and what it spends is money, not
// the subscription: the week's quota of such a region is its 7-day spend as a share of the provider's weekUsd.
// Given a base URL but no token, Claude Code sends the claude.ai login of this machine to that URL. So such a session
// runs in a Claude Code config directory of its own that was never logged in, with the provider's own token, and every
// variable that names an identity or a model set; when the token is empty, or any of them is missing, it does not start.
// Anthropic does not support other vendors' models behind Claude Code: each provider names the CLI version it was tried
// on, and hhd does not start on another one (try the new version first, then change cliVersion).
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Config, ModelRole, Provider } from "./config.ts";
import type { TurnTotal } from "./kernel/types.ts";

export const providerOf = (cfg: Pick<Config, "models">, role: string): { name: string; provider: Provider } | undefined => {
  const name = cfg.models.providerByRole?.[role as ModelRole];
  return name ? { name, provider: cfg.models.providers![name]! } : undefined;
};

/** The variables a provider's session must carry, each not empty (ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN must be
 *  there and empty: they would otherwise come from hhd's own environment) */
export const PROVIDER_ENV = [
  "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "CLAUDE_CONFIG_DIR",
] as const;
const EMPTY = ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** The provider's own Claude Code config directory: configDir, else <stateDir>/providers/<name> */
export const providerConfigDir = (name: string, p: Provider, stateDir: string): string => resolve(p.configDir ?? join(stateDir, "providers", name));

/**
 * What Claude Code reads to talk to the provider: its endpoint, its own token (read from keyFile now), its model for every
 * slot and for subagents, its context window, no experimental betas, and a config directory of its own. Throws, saying
 * why in plain words, when the token is empty, when that directory is the owner's own or has a login in it, or when
 * any variable would be missing: the region does not start rather than reach the provider as the owner.
 */
export function providerEnv(name: string, p: Provider, stateDir: string, o: { home?: string; env?: NodeJS.ProcessEnv } = {}): Record<string, string> {
  let token = "";
  try { token = readFileSync(p.keyFile, "utf8").trim(); } catch { /* said below */ }
  if (!token) throw new Error(`provider ${name}: no token in ${p.keyFile}. A session on another provider needs its own token; without one Claude Code would send this computer's claude.ai login to ${p.baseUrl}. Put the provider's key in that file`);
  const dir = providerConfigDir(name, p, stateDir);
  const own = [join(o.home ?? homedir(), ".claude"), (o.env ?? process.env).CLAUDE_CONFIG_DIR].filter((d): d is string => !!d).map((d) => resolve(d));
  if (own.includes(dir)) throw new Error(`provider ${name}: its config directory ${dir} is the owner's own Claude Code one; give it a directory of its own (models.providers.${name}.configDir), never logged in`);
  if (existsSync(join(dir, ".credentials.json"))) throw new Error(`provider ${name}: someone logged in to Claude Code in ${dir}, its own config directory; remove ${join(dir, ".credentials.json")} (it must never hold a login)`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const small = p.smallModel ?? p.model;
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_MODEL: p.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: p.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: p.model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: p.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: small,
    ANTHROPIC_SMALL_FAST_MODEL: small,
    CLAUDE_CODE_SUBAGENT_MODEL: p.subagentModel ?? small,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(p.contextTokens ?? ""),
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CONFIG_DIR: dir,
  };
  const missing = [...PROVIDER_ENV.filter((k) => !env[k]), ...EMPTY.filter((k) => env[k] !== "")];
  if (missing.length) throw new Error(`provider ${name}: its sessions would lack ${missing.join(", ")}; set what models.providers.${name} is missing`);
  return env;
}

/**
 * Before hhd starts: no base URL outside models.providers (in hhd's own environment every session would carry it, with
 * the owner's login and no token of its own), the CLI version a provider was tried on, against the one hhd runs
 * (kernel.claudeExecutable --version), and no login in the provider's config directory. Throws on another version, or on
 * no executable named: the SDK's own one changes with every package update. The login is asked of the CLI itself
 * (auth status): on macOS it is kept in the keychain, under the directory's name, and leaves no file in it
 */
export async function checkProviders(cfg: Pick<Config, "models" | "kernel" | "stateDir">, o: { version?: (exe: string) => Promise<string>; loggedIn?: (exe: string, dir: string) => Promise<boolean | undefined>; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  if ((o.env ?? process.env).ANTHROPIC_BASE_URL) throw new Error(`hhd's environment sets ANTHROPIC_BASE_URL: every session would send this computer's claude.ai login to it. Put another provider in models.providers instead (its own token and config directory), and take ANTHROPIC_BASE_URL out of hhd's environment`);
  const version = o.version ?? cliVersion;
  const used = [...new Set(Object.values(cfg.models.providerByRole ?? {}))].filter((n): n is string => !!n);
  if (!used.length) return;
  const exe = cfg.kernel.claudeExecutable;
  if (!exe) throw new Error(`providers ${used.join(", ")}: name the Claude Code CLI they were tried on (kernel.claudeExecutable); a role on another provider does not run on whatever version the SDK brings`);
  const got = await version(exe);
  for (const name of used) {
    const p = cfg.models.providers![name]!;
    if (got !== p.cliVersion) throw new Error(`provider ${name}: tried on Claude Code ${p.cliVersion}, but ${exe} is ${got || "of no version it would say"}. Anthropic does not support other vendors' models: try ${got} on it first, then set models.providers.${name}.cliVersion`);
    const dir = providerConfigDir(name, p, cfg.stateDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const login = await (o.loggedIn ?? loggedIn)(exe, dir);
    if (login) throw new Error(`provider ${name}: Claude Code is logged in in ${dir}, the provider's own config directory; log out there (CLAUDE_CONFIG_DIR=${dir} ${exe} auth logout): it must never hold a login`);
    if (login === undefined) throw new Error(`provider ${name}: could not tell whether Claude Code is logged in in ${dir} (CLAUDE_CONFIG_DIR=${dir} ${exe} auth status said nothing readable); hhd does not start on a provider whose directory it cannot check`);
  }
}

/** the command that runs the CLI (a .js one on this node) */
const cli = (exe: string, args: string[]): [string, string[]] => /\.[cm]?js$/.test(exe) ? [process.execPath, [exe, ...args]] : [exe, args];

/** what the CLI says its version is */
const cliVersion = async (exe: string): Promise<string> => {
  try { return /\d+\.\d+\.\d+/.exec((await promisify(execFile)(...cli(exe, ["--version"]), { timeout: 30_000 })).stdout)?.[0] ?? ""; } catch { return ""; }
};

/** whether the CLI holds a login in that config directory, with no token from the environment (auth status exits 1
 *  when there is none, its JSON on stdout all the same); undefined when it says nothing readable */
const loggedIn = async (exe: string, dir: string): Promise<boolean | undefined> => {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  for (const k of [...EMPTY, "ANTHROPIC_AUTH_TOKEN"]) delete env[k];
  const out = await promisify(execFile)(...cli(exe, ["auth", "status"]), { env, timeout: 30_000 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "");
  try {
    const v = (JSON.parse(out) as { loggedIn?: unknown }).loggedIn;
    return typeof v === "boolean" ? v : undefined;
  } catch { return undefined; }
};

/** A turn's cost in USD at the provider's prices (per million tokens; cache reads and writes at the input price unless given) */
export const turnUsd = (p: Provider, t: TurnTotal): number =>
  (t.input * p.price.input + t.output * p.price.output + t.cacheRead * (p.price.cacheRead ?? p.price.input) + t.cacheWrite * (p.price.cacheWrite ?? p.price.input)) / 1e6;

/** Spend by provider and day (YYYY-MM-DD in the role's timezone) */
export type Spend = Record<string, Record<string, number>>;

/** The first day of the 7 that end on `day` */
const weekStart = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);

/** `usd` added to `day`; days before that day's week are dropped */
export function addSpend(s: Spend, provider: string, day: string, usd: number): Spend {
  const from = weekStart(day);
  const days = Object.entries({ ...s[provider], [day]: (s[provider]?.[day] ?? 0) + usd }).filter(([d]) => d >= from);
  return { ...s, [provider]: Object.fromEntries(days) };
}

/** The provider's spend over the 7 days ending on `today` */
export const weekSpend = (s: Spend, provider: string, today: string): number =>
  Object.entries(s[provider] ?? {}).reduce((sum, [d, usd]) => (d >= weekStart(today) ? sum + usd : sum), 0);
