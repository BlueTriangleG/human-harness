// The watchdog module (modules/watchdog): its declaration, its script's own tests, and the script asking a real bridge —
// the status question is answered by src/channels/bridge.ts and asked by a Python script, so the two are run together here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeDirect, bridgeInbox, bridgeSocket, isOwnerCommand, serveBridge } from "../src/channels/bridge.ts";
import type { Channel, InboundMessage } from "../src/channels/types.ts";
import { BUILTIN_ROOT, loadModules } from "../src/modules/load.ts";
import { testConfig } from "./helpers.ts";

const OWNER = "+6155500010";

test("watchdog module: a standalone check every minute, its own sense source that never wakes the role by itself, a named model that is not Fable", async () => {
  const cfg = testConfig({ workspace: mkdtempSync(join(tmpdir(), "hh-wd-ws-")), stateDir: mkdtempSync(join(tmpdir(), "hh-wd-st-")), names: { me: "阿青", owner: "老林" }, modules: { watchdog: { enabled: true } } });
  const { spec, ctx } = (await loadModules(cfg, { roots: [{ dir: BUILTIN_ROOT, trusted: true }] })).loaded.find((l) => l.spec.name === "watchdog")!;
  assert.deepEqual(spec.timers?.map((t) => [t.name, t.everyMs, t.standalone]), [["check", 60_000, true]]);
  assert.deepEqual([spec.senses, spec.senseKinds], [["watchdog"], { probe: ["watchdog"] }]);
  assert.match(String(ctx.config.model), /^claude-(?!.*fable)/i);
});

test("watchdog module: the script's own tests pass (made-up bridges, time and names)", () => {
  const r = spawnSync(testConfig().tools.python, ["-I", join(BUILTIN_ROOT, "watchdog", "tests", "test_watchdog.py"), join(BUILTIN_ROOT, "watchdog", "scripts", "watchdog.py")], { encoding: "utf8" });
  assert.match(r.stdout, /^ok \d+\n$/, r.stderr.slice(-600));
  assert.equal(r.status, 0);
});

test("watchdog module: the script asks a real bridge its status, and finds the owner's command the bridge kept out of the inbox", async (t) => {
  const stateDir = mkdtempSync(join(tmpdir(), "hh-wd-"));
  const cfg = testConfig({ workspace: stateDir, stateDir, names: { me: "阿青", owner: "老林" }, channels: { whatsapp: { via: "bridge" } }, modules: { watchdog: { enabled: true } } });
  const file = join(stateDir, "instance.json");
  writeFileSync(file, JSON.stringify({ channels: cfg.channels }));
  const before = process.env.HH_CONFIG;
  process.env.HH_CONFIG = file;   // what a role's own process has: the script reads its channel table from the instance file
  let arrive: (m: InboundMessage) => void = () => {};
  const state = { connected: true };
  const fake: Channel = { get connected() { return state.connected; }, start: async (on) => { arrive = on; }, send: async () => ({ ok: true, out: "" }), stop: async () => {} };
  const served = await serveBridge({
    socket: bridgeSocket(stateDir, "whatsapp"), inbox: bridgeInbox(stateDir, "whatsapp"), channel: fake,
    direct: { dir: bridgeDirect(stateDir, "whatsapp"), is: (m) => isOwnerCommand(m, [OWNER]) },
  });
  t.after(async () => { await served.close(); if (before === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = before; rmSync(stateDir, { recursive: true, force: true }); });
  const { ctx } = (await loadModules(cfg, { roots: [{ dir: BUILTIN_ROOT, trusted: true }] })).loaded.find((l) => l.spec.name === "watchdog")!;
  const round = async (): Promise<unknown> => { const r = await ctx.run("scripts/watchdog.py", ["check", "--dry-run"]); assert.equal(r.code, 0, r.stderr); return JSON.parse(r.stdout); };

  assert.deepEqual(await round(), [], "connected, nothing waiting: nothing to do");
  arrive({ channel: "whatsapp", text: "/cc 看看她怎么了", senderId: OWNER, isGroup: false });
  arrive({ channel: "whatsapp", text: "/cc 看看", senderId: "+6155500011", isGroup: false });
  assert.deepEqual(await round(), [["cc", "whatsapp", "看看她怎么了"]], "the owner's command, and only the owner's");
  assert.equal(readdirSync(bridgeInbox(stateDir, "whatsapp")).length, 1, "the other sender's /cc went to the role");
  const status = JSON.parse((await ctx.run("scripts/watchdog.py", ["status"])).stdout.split("\n{")[0]!) as { channels: Record<string, { connected: boolean; direct: number }> };
  assert.deepEqual([status.channels.whatsapp!.connected, status.channels.whatsapp!.direct], [true, 1]);
  state.connected = false;
  assert.deepEqual(await round(), [["cc", "whatsapp", "看看她怎么了"]], "disconnected for less than ten minutes: no restart yet");
});
