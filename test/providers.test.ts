// A region on another model provider: its sessions carry the provider's endpoint, key and model; its turns are counted as
// spend, and its week's quota is that spend against the provider's weekUsd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addSpend, checkProviders, PROVIDER_ENV, providerEnv, weekSpend } from "../src/providers.ts";
import { makeBrain } from "./helpers.ts";
import { loadConfig, requireInstance } from "../src/config.ts";
import { tmpDir } from "./tmp.ts";

test("a region on another provider opens with its endpoint, key and models, and its turns are counted as spend", async () => {
  const keyFile = join(tmpDir("hh-provider-"), "ds.key");
  writeFileSync(keyFile, "sk-test\n");
  const ds = { baseUrl: "http://127.0.0.1:9/anthropic", keyFile, model: "ds-chat", smallModel: "ds-small", contextTokens: 128_000, cliVersion: "2.1.330", price: { input: 1, output: 2 }, weekUsd: 10 };
  const t = makeBrain({ models: { providers: { ds }, providerByRole: { side: "ds" } } });
  t.brain.wakeRegion("main", "回一下");
  t.brain.wakeRegion("side-1", "看一下");
  const side = t.driver.latest("side-1").spec;
  assert.equal(side.model, "ds-chat");
  assert.equal(side.fallbackModel, undefined);
  assert.deepEqual(Object.fromEntries(Object.entries(side.env ?? {}).filter(([k]) => k.startsWith("ANTHROPIC_"))), {
    ANTHROPIC_BASE_URL: "http://127.0.0.1:9/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-test", ANTHROPIC_API_KEY: "", ANTHROPIC_MODEL: "ds-chat",
    ANTHROPIC_DEFAULT_OPUS_MODEL: "ds-chat", ANTHROPIC_DEFAULT_SONNET_MODEL: "ds-chat", ANTHROPIC_DEFAULT_FABLE_MODEL: "ds-chat",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: "ds-small", ANTHROPIC_SMALL_FAST_MODEL: "ds-small",
  });
  assert.equal(side.env!.CLAUDE_CODE_SUBAGENT_MODEL, "ds-small");
  assert.equal(side.env!.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "128000");
  assert.equal(side.env!.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, "1");
  const main = t.driver.latest("main").spec;
  assert.equal(Object.keys(main.env ?? {}).some((k) => k.startsWith("ANTHROPIC_")), false, "a region on the subscription is unchanged");
  await t.driver.latest("side-1").play({ total: { calls: 1, input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000 } });
  assert.deepEqual(t.brain.status().spend, { ds: { week: 2, weekUsd: 10 } });
});

test("spend keeps the 7 days ending today", () => {
  let s = addSpend({}, "ds", "2026-11-01", 1);
  s = addSpend(s, "ds", "2026-11-07", 2);
  assert.equal(weekSpend(s, "ds", "2026-11-07"), 3);
  assert.equal(weekSpend(s, "ds", "2026-11-08"), 2);
  assert.deepEqual(addSpend(s, "ds", "2026-11-08", 4), { ds: { "2026-11-07": 2, "2026-11-08": 4 } });
});

const provider = (keyFile: string, over: Record<string, unknown> = {}) => ({ baseUrl: "http://127.0.0.1:9/anthropic", keyFile, model: "ds-chat", contextTokens: 128_000, cliVersion: "2.1.330", price: { input: 1, output: 2 }, weekUsd: 10, ...over });

test("a provider given a base URL but no token does not start: Claude Code would send the owner's claude.ai login there", () => {
  const dir = tmpDir("hh-provider-");
  for (const content of [null, "", "  \n"]) {
    const keyFile = join(dir, `k${String(content?.length)}`);
    if (content !== null) writeFileSync(keyFile, content);
    assert.throws(() => makeBrain({ models: { providers: { ds: provider(keyFile) }, providerByRole: { side: "ds" } } }), /no token in .*claude\.ai login/s, String(content));
  }
});

test("a provider's sessions run in a config directory of their own: the process environment holds no config directory of the owner's", async () => {
  const keyFile = join(tmpDir("hh-provider-"), "ds.key");
  writeFileSync(keyFile, "sk-test\n");
  const owner = join(tmpDir("hh-owner-"), "claude-config");
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = owner;
  try {
    const t = makeBrain({ models: { providers: { ds: provider(keyFile) }, providerByRole: { side: "ds" } } });
    t.brain.wakeRegion("side-1", "看一下");
    const spec = t.driver.latest("side-1").spec;
    // what the kernel hands the CLI (src/kernel/sdk.ts): hhd's own environment, the session's over it
    const env = { ...process.env, ...spec.env };
    assert.equal(env.CLAUDE_CONFIG_DIR, join(t.cfg.stateDir, "providers", "ds"));
    const mine = [owner, join(homedir(), ".claude")];
    assert.deepEqual(Object.entries(env).filter(([, v]) => mine.includes(String(v))), [], "no variable points at the owner's config");
    assert.equal(env.ANTHROPIC_API_KEY, "");
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "");
    for (const k of PROVIDER_ENV) assert.ok(env[k], k);
  } finally { if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was; }
});

test("a provider refuses the owner's config directory, one with a login in it, and any variable it would lack", () => {
  const dir = tmpDir("hh-provider-"), keyFile = join(dir, "k");
  writeFileSync(keyFile, "sk");
  const home = tmpDir("hh-home-");
  assert.throws(() => providerEnv("ds", provider(keyFile, { configDir: join(home, ".claude") }) as never, dir, { home, env: {} }), /the owner's own Claude Code one/);
  assert.throws(() => providerEnv("ds", provider(keyFile, { configDir: "/x/owner" }) as never, dir, { home, env: { CLAUDE_CONFIG_DIR: "/x/owner" } }), /the owner's own/);
  const logged = join(dir, "logged");
  mkdirSync(logged);
  writeFileSync(join(logged, ".credentials.json"), "{}");
  assert.throws(() => providerEnv("ds", provider(keyFile, { configDir: logged }) as never, dir, { home, env: {} }), /logged in/);
  assert.throws(() => providerEnv("ds", provider(keyFile, { contextTokens: undefined }) as never, dir, { home, env: {} }), /would lack CLAUDE_CODE_MAX_CONTEXT_TOKENS/);
  assert.throws(() => providerEnv("ds", provider(keyFile, { model: "" }) as never, dir, { home, env: {} }), /would lack ANTHROPIC_MODEL/);
});

test("a role on a provider runs only on the Claude Code CLI version the provider was tried on, named in kernel.claudeExecutable", async () => {
  const p = provider("/k");
  const cfg = (exe: string | null, byRole: Record<string, string> = { side: "ds" }) => ({ models: { opus: "", sonnet: "", haiku: "", providers: { ds: p }, providerByRole: byRole }, kernel: { claudeExecutable: exe }, stateDir: tmpDir("hh-provider-") }) as never;
  let asked = 0;
  const version = (v: string) => ({ env: {}, version: async () => { asked++; return v; }, loggedIn: async () => false });
  await checkProviders(cfg("/bin/claude", {}), version("0.0.0"));
  assert.equal(asked, 0, "no role on a provider: not asked");
  await assert.rejects(checkProviders(cfg(null), version("2.1.330")), /kernel\.claudeExecutable/);
  await assert.rejects(checkProviders(cfg("/bin/claude"), version("2.1.331")), /tried on Claude Code 2\.1\.330, but \/bin\/claude is 2\.1\.331/);
  await checkProviders(cfg("/bin/claude"), version("2.1.330"));
});

test("hhd does not start while the CLI holds a login in a provider's config directory, as auth status says with no token from the environment", async () => {
  const dir = tmpDir("hh-provider-"), exe = join(dir, "claude");
  // auth status counts a token in the environment as a login too; the fake does the same
  writeFileSync(exe, `#!/bin/sh
[ "$1" = --version ] && { echo "2.1.330 (Claude Code)"; exit 0; }
[ "$1 $2" = "auth status" ] || exit 2
if [ -e "$CLAUDE_CONFIG_DIR/login" ] || [ -n "$ANTHROPIC_AUTH_TOKEN$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN" ]; then echo '{"loggedIn": true}'; exit 0; fi
[ -e "$CLAUDE_CONFIG_DIR/garbled" ] && { echo "?"; exit 1; }
echo '{"loggedIn": false}'; exit 1
`, { mode: 0o755 });
  const cfg = { models: { opus: "", sonnet: "", haiku: "", providers: { ds: provider("/k") }, providerByRole: { side: "ds" } }, kernel: { claudeExecutable: exe }, stateDir: dir } as never;
  const own = join(dir, "providers", "ds");
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "hhd's own";
  try {
    await checkProviders(cfg, { env: {} });
    writeFileSync(join(own, "login"), "");
    await assert.rejects(checkProviders(cfg, { env: {} }), /logged in in .*providers\/ds.*auth logout/);
    rmSync(join(own, "login"));
    writeFileSync(join(own, "garbled"), "");
    await assert.rejects(checkProviders(cfg, { env: {} }), /could not tell/);
  } finally {
    if (token === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
  }
});

test("a base URL anywhere but models.providers stops hhd: in its environment or the kernel's, every session would take the owner's login there", async () => {
  const cfg = { models: { opus: "", sonnet: "", haiku: "" }, kernel: { claudeExecutable: null } } as never;
  await assert.rejects(checkProviders(cfg, { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } }), /claude\.ai login/);
  await checkProviders(cfg, { env: {} });
  const base = { workspace: "/tmp/hh-test-ws", stateDir: "/tmp/hh-test-state", gate: { enabled: false } };
  assert.throws(() => requireInstance(loadConfig({ ...base, kernel: { env: { ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic" } } } as never)), /kernel\.env sets ANTHROPIC_BASE_URL/);
  assert.doesNotThrow(() => requireInstance(loadConfig(base as never)));
});

test("a provider without its context window or the CLI version it was tried on is refused when the role starts", () => {
  const base = { workspace: "/tmp/hh-test-ws", stateDir: "/tmp/hh-test-state", gate: { enabled: false } };
  const check = (over: Record<string, unknown>) => requireInstance(loadConfig({ ...base, models: { providers: { ds: provider("/k", over) }, providerByRole: { side: "ds" } } } as never));
  assert.doesNotThrow(() => check({}));
  assert.throws(() => check({ contextTokens: undefined }), /contextTokens/);
  assert.throws(() => check({ cliVersion: "latest" }), /cliVersion/);
});
