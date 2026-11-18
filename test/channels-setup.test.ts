// Bridges as modules: the service job hh modules install makes for a bridge (and what it never touches), the channel's
// self-check, and what hh channels add writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { addChannel, bridgeFile, BRIDGE_APPS, channelCheck, removeChannel, whatsappAuth, whatsappLinked } from "../src/channels/setup.ts";
import { linkCommand } from "../src/cli-direct.ts";
import type { Connect, LinkUpdate } from "../bridge/whatsapp/link.ts";
import type { BridgeStatus } from "../src/channels/bridge.ts";
import { installJobs, REPO } from "../src/services/index.ts";
import { launchd } from "../src/services/launchd.ts";
import { loadModules } from "../src/modules/load.ts";
import { doctor, install } from "../src/modules/doctor.ts";
import { B } from "../src/lang/index.ts";
import { testConfig } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";

const OPENID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAA0000";
/** A role in fresh directories with the qq module on, its labels its own */
function role(modules: Record<string, unknown> = { qq: { enabled: true } }) {
  const dir = tmpDir("hh-chan-");
  const cfg = testConfig({ stateDir: join(dir, "state"), workspace: join(dir, "ws"), modules, launchd: { hhd: "ai.hh.aqing.hhd", console: "ai.hh.aqing.console" }, channels: {} });
  mkdirSync(join(cfg.workspace, "memory", "people"), { recursive: true });
  mkdirSync(cfg.stateDir, { recursive: true });
  return { dir, cfg };
}
const ok = async () => ({ code: 0, stdout: "", stderr: "" });

test("a service's job: launchd keeps it alive; one already running under its label is not written, loaded or restarted", async () => {
  const agents = tmpDir("hh-agents-");
  const job = launchd({ dir: "", uid: 501, launchctl: ok }).serviceJob("ai.hh.bridge.whatsapp", ["/n/node", "/code/bridge/whatsapp/main.ts", "whatsapp"], { HH_CONFIG: "/r/instance.json" }, "/r/logs/b.log", "/code");
  const calls: string[] = [];
  // not known to launchd: written and loaded
  const fresh = await installJobs([job], launchd({ dir: agents, uid: 501, launchctl: async (a) => { calls.push(a.join(" ")); return { code: a[0] === "print" ? 113 : 0, stderr: "" }; } }));
  assert.deepEqual(fresh.map((r) => r.state), ["installed"]);
  const text = readFileSync(join(agents, "ai.hh.bridge.whatsapp.plist"), "utf8");
  assert.match(text, /<key>KeepAlive<\/key><true\/>/);
  assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(text, /<string>\/code\/bridge\/whatsapp\/main\.ts<\/string>\s*<string>whatsapp<\/string>/);
  assert.ok(!text.includes("StartInterval"));
  assert.deepEqual(calls, ["print gui/501/ai.hh.bridge.whatsapp", `bootstrap gui/501 ${join(agents, "ai.hh.bridge.whatsapp.plist")}`]);
  // running already, from a file somebody wrote by hand: nothing is written, nothing but the look is asked of launchd
  for (const there of ["a hand-written job\n", null]) {
    const dir = tmpDir("hh-agents-");
    if (there !== null) writeFileSync(join(dir, "ai.hh.bridge.whatsapp.plist"), there);
    const asked: string[] = [];
    const r = await installJobs([job], launchd({ dir, uid: 501, launchctl: async (a) => { asked.push(a.join(" ")); return { code: 0, stderr: "" }; } }));
    assert.deepEqual(r, [{ label: "ai.hh.bridge.whatsapp", state: "running" }]);
    assert.deepEqual(asked, ["print gui/501/ai.hh.bridge.whatsapp"], "no bootstrap, no kickstart, no bootout");
    assert.equal(there === null ? existsSync(join(dir, "ai.hh.bridge.whatsapp.plist")) : readFileSync(join(dir, "ai.hh.bridge.whatsapp.plist"), "utf8"), there === null ? false : there);
  }
  // a timer's job is not a service: the look is not even made
  const asked: string[] = [];
  await installJobs([{ label: "ai.hh.x.t", files: { "ai.hh.x.t.plist": "x" } }], launchd({ dir: tmpDir("hh-agents-"), uid: 501, launchctl: async (a) => { asked.push(a[0]!); return { code: 0, stderr: "" }; } }));
  assert.deepEqual(asked, ["bootstrap"]);
});

test("hh modules install with a bridge module on: no job before the channel is set up; then its packages and a job under <prefix>.bridge.<channel>; off, nothing", async () => {
  const { cfg } = role();
  const mods = await loadModules(cfg);
  assert.ok(mods.loaded.some((l) => l.spec.name === "qq"));
  const saved = process.env.HH_CONFIG;
  process.env.HH_CONFIG = "/roles/aqing/instance.json";
  try {
    const run = (ran: string[]) => async (cmd: string, args: readonly string[], o?: { cwd?: string }) => { ran.push(`${cmd} ${args.join(" ")} @${o?.cwd ?? ""}`); return { code: 0, stdout: "", stderr: "" }; };
    const launch = (dir: string, loaded: string[]) => launchd({ dir, uid: 501, launchctl: async (a: readonly string[]) => { loaded.push(a.join(" ")); return { code: a[0] === "print" ? 113 : 0, stderr: "" }; } });
    const before = tmpDir("hh-agents-"), ran: string[] = [];
    const first = await install(cfg, mods, { run: run(ran), services: launch(before, []) });
    assert.ok(!existsSync(join(before, "ai.hh.aqing.bridge.qqbot.plist")), "the channel is not set up: nothing to keep running");
    assert.ok(ran.some((r) => r === `npm ci --ignore-scripts --omit=dev --no-audit --no-fund @${join(REPO, "bridge", "qq")}`), ran.join("\n"));
    assert.ok(first.lines.includes(B.modules.npmDone("qq")), first.lines.join("\n"));
    mkdirSync(join(cfg.stateDir, "channels"), { recursive: true });
    writeFileSync(bridgeFile(cfg.stateDir, "qqbot"), "{}", { mode: 0o600 });
    const agents = tmpDir("hh-agents-"), loaded: string[] = [];
    const second = await install(cfg, mods, { run: ok, services: launch(agents, loaded) });
    const text = readFileSync(join(agents, "ai.hh.aqing.bridge.qqbot.plist"), "utf8");
    assert.match(text, new RegExp(`<string>${join(REPO, "bridge", "qq", "main.ts").replace(/[.]/g, "\\.")}</string>\\s*<string>qqbot</string>`));
    assert.match(text, /<key>HH_CONFIG<\/key><string>\/roles\/aqing\/instance\.json<\/string>/);
    assert.match(text, /<key>KeepAlive<\/key><true\/>/);
    assert.ok(loaded.includes(`bootstrap gui/501 ${join(agents, "ai.hh.aqing.bridge.qqbot.plist")}`));
    assert.ok(second.lines.includes(B.modules.jobInstalled("ai.hh.aqing.bridge.qqbot")));
  } finally {
    if (saved === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = saved;
  }
  // a role that has not turned the module on (the first role today): not loaded, so no packages, no job, no check of its own
  const off = role({});
  const none = await loadModules(off.cfg);
  assert.ok(!none.loaded.some((l) => l.spec.name === "qq" || l.spec.name === "whatsapp"));
  for (const name of ["qq", "whatsapp"]) {
    const spec = none.found.find((f) => f.name === name)!.spec!;
    assert.deepEqual([spec.tools, spec.senses, spec.hooks, spec.timers, spec.processes, spec.mcp], [undefined, undefined, undefined, undefined, undefined, undefined], `${name} brings nothing the role reads or runs inside hhd`);
  }
});

test("a bridge module's check: what the channel still lacks, most basic first", async () => {
  const { cfg } = role();
  const app = BRIDGE_APPS.qq!;
  const deps = (status: BridgeStatus | null, owners: string[] = []) =>
    ({ status: async () => status, ownerIds: () => ({ qqbot: owners }) });
  const texts = async (c: typeof cfg, d: ReturnType<typeof deps>) => (await channelCheck(c, "qqbot", app, d)).map((i) => `${i.status}: ${i.text.split(":")[0]!.split(" (")[0]}`);
  assert.deepEqual(await texts(cfg, deps(null)), ["setup: channel qqbot is not set up"]);
  mkdirSync(join(cfg.stateDir, "channels"), { recursive: true });
  const file = bridgeFile(cfg.stateDir, "qqbot");
  writeFileSync(file, "{}", { mode: 0o644 });
  chmodSync(file, 0o644);
  assert.deepEqual(await texts(cfg, deps(null)), [
    `broken: ${file} can be read by others and holds the login`,
    "setup: the role's config does not send qqbot through the bridge",
    "broken: the qqbot bridge does not answer",
    "setup: the owner has no sender id for qqbot in the people list",
    "setup: the machine's side has no owner sender id for qqbot",
  ]);
  chmodSync(file, 0o600);
  const on = { ...cfg, channels: { qqbot: { via: "bridge" } } };
  writeFileSync(join(cfg.workspace, "memory/people/registry.json"), JSON.stringify({ _note: "x", 阿青: { privacy: "owner", senders: ["+6155500010", `qqbot:c2c:${OPENID}`] } }));
  const up = { connected: true, since: "x", inbox: 2, direct: 0, waiting: 0, ownerIn: [], lastOut: null };
  assert.deepEqual(await texts(on, deps({ ...up, connected: false, down: "bad credentials" }, [OPENID])), ["setup: the qqbot bridge cannot connect by itself"]);
  assert.deepEqual(await texts(on, deps({ ...up, connected: false }, [OPENID])), ["broken: the qqbot bridge is running but not connected"]);
  assert.deepEqual(await channelCheck(on, "qqbot", app, deps(up, [OPENID])), [{ status: "ok", text: "qqbot: connected, 2 waiting in the inbox" }]);
  // the owner known only by a phone number is not known on QQ; and through the module, hh modules doctor says the same
  writeFileSync(join(cfg.workspace, "memory/people/registry.json"), JSON.stringify({ 阿青: { privacy: "owner", senders: ["+6155500010"] } }));
  assert.deepEqual(await texts(on, deps(up, [OPENID])), ["setup: the owner has no sender id for qqbot in the people list"]);
  const report = (await doctor(on, await loadModules(on), "qq"))[0]!;
  assert.ok(report.items.some((i) => i.status === "broken" && i.text.startsWith("the qqbot bridge does not answer")), JSON.stringify(report.items));
});

test("hh channels add: the bridge's own file (0600), the role's config, the owner's id in the people list; what it leaves to a person", () => {
  const { dir, cfg } = role({});
  const configFile = join(dir, "instance.json");
  writeFileSync(configFile, JSON.stringify({ id: "aqing", modules: { goals: { enabled: true } }, tools: { sendDryRun: true } }));
  writeFileSync(join(cfg.workspace, "memory/people/registry.json"), JSON.stringify({ 阿青: { privacy: "owner", senders: ["+6155500010"] } }));
  const qq = BRIDGE_APPS.qq!;
  assert.throws(() => addChannel(cfg, configFile, qq, { allow: [], groupAllow: [] }), /at least one --allow/);
  assert.throws(() => addChannel(cfg, configFile, qq, { allow: ["not an id!"], groupAllow: [] }), /is not the sender's openid/);
  assert.throws(() => addChannel(cfg, configFile, qq, { allow: [OPENID], groupAllow: [] }), /--app-id, and the app secret on standard input/);
  assert.ok(!existsSync(bridgeFile(cfg.stateDir, "qqbot")), "a refused call writes nothing");
  const r = addChannel(cfg, configFile, qq, { allow: [OPENID], groupAllow: [], appId: "1900000001", appSecret: "sec-NEVER-PRINT", ownerId: OPENID });
  const file = bridgeFile(cfg.stateDir, "qqbot");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { appId: "1900000001", appSecret: "sec-NEVER-PRINT", allowFrom: [OPENID], groupAllowFrom: [] });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { id: "aqing", modules: { goals: { enabled: true }, qq: { enabled: true } }, tools: { sendDryRun: true }, channels: { qqbot: { via: "bridge" } } }, "sendDryRun is the person's to turn off");
  assert.deepEqual(JSON.parse(readFileSync(join(cfg.workspace, "memory/people/registry.json"), "utf8")), { 阿青: { privacy: "owner", senders: ["+6155500010", OPENID] } });
  const said = [...r.done, ...r.todo].join("\n");
  assert.ok(!said.includes("sec-NEVER-PRINT") && !said.includes("1900000001") && !said.includes(OPENID), "nothing secret is printed");
  assert.ok(r.todo.some((t) => t.startsWith("hh modules install")) && r.todo.some((t) => t.includes("owner-senders")) && r.todo.some((t) => t.includes("sendDryRun")));
  assert.throws(() => addChannel(cfg, configFile, qq, { allow: [OPENID], groupAllow: [], appId: "1", appSecret: "s" }), /is there already/);
  // WhatsApp under another channel name, never linked, no owner id given
  const w = addChannel(cfg, configFile, BRIDGE_APPS.whatsapp!, { name: "wa2", allow: ["+6155500011"], groupAllow: ["*"] });
  assert.deepEqual(JSON.parse(readFileSync(bridgeFile(cfg.stateDir, "wa2"), "utf8")), { auth: join(cfg.stateDir, "channels", "wa2.auth"), allowFrom: ["+6155500011"], groupAllowFrom: ["*"] });
  assert.deepEqual((JSON.parse(readFileSync(configFile, "utf8")) as { modules: unknown }).modules, { goals: { enabled: true }, qq: { enabled: true }, whatsapp: { enabled: true, channel: "wa2" } });
  assert.ok(w.todo.some((t) => t.includes("not linked yet")) && w.todo.some((t) => t.includes("--owner-id")));
});

/** A WhatsApp that never leaves the test: each connection plays its script once somebody listens; the first writes what baileys would */
function fakeWhatsApp(scripts: LinkUpdate[][]): { connect: Connect; asked: string[] } {
  const asked: string[] = [];
  let n = 0;
  const connect: Connect = async (auth) => {
    const script = scripts[n++] ?? [];
    return {
      on: (update) => { setImmediate(() => { for (const u of script) update(u); }); },
      requestPairingCode: async (phone) => { asked.push(phone); writeFileSync(join(auth, "creds.json"), "{}", { mode: 0o644 }); return "ABCD1234"; },
      end: () => {},
    };
  };
  return { connect, asked };
}

test("hh channels link whatsapp: the code is shown once, the login lands in <state>/channels/<name>.auth (0700, files 0600); a refused link leaves nothing; then remove", async () => {
  const { dir, cfg } = role({});
  const auth = whatsappAuth(cfg.stateDir, "whatsapp");
  assert.equal(auth, join(cfg.stateDir, "channels", "whatsapp.auth"));
  // WhatsApp gives up (the code was never typed): nothing is left, so the next try starts clean
  const said: string[] = [];
  const gaveUp = fakeWhatsApp([[{ qr: "x" }, { connection: "close", code: 408 }]]);
  await assert.rejects(linkCommand(cfg.stateDir, "whatsapp", "+61 555 000 10", { connect: gaveUp.connect, say: (l) => said.push(l) }), /closed the connection before the device was linked \(code 408\)/);
  assert.ok(!existsSync(auth));
  // the phone accepts: WhatsApp restarts the connection (515), the second one opens
  const wa = fakeWhatsApp([[{ qr: "x" }, { qr: "y" }, { connection: "close", code: 515 }], [{ connection: "open" }]]);
  const out = await linkCommand(cfg.stateDir, "whatsapp", "+61 555 000 10", { connect: wa.connect, settleMs: 0, say: (l) => said.push(l) });
  assert.deepEqual(wa.asked, ["6155500010"], "asked once, digits only");
  assert.equal(said.filter((l) => l.startsWith("pairing code: ABCD-1234")).length, 2);
  assert.equal(statSync(auth).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(auth).map((f) => statSync(join(auth, f)).mode & 0o777), [0o600]);
  assert.ok(whatsappLinked(cfg.stateDir, "whatsapp"));
  assert.match(out, /hh channels add whatsapp[^]*hh modules install/);
  assert.ok(!out.includes("6155500010") && !out.includes("ABCD"), "neither the number nor the code in what is returned");
  await assert.rejects(linkCommand(cfg.stateDir, "whatsapp", "+6155500010", { connect: wa.connect }), /is not empty: there is a login there already/);

  // set up, then taken away: the job unloaded, the config as before, the file and the login kept under removed-<time>/
  const configFile = join(dir, "instance.json");
  writeFileSync(configFile, JSON.stringify({ id: "aqing", modules: { goals: { enabled: true } } }));
  const wapp = BRIDGE_APPS.whatsapp!;
  const added = addChannel(cfg, configFile, wapp, { allow: ["+6155500010"], groupAllow: [] });
  assert.ok(!added.todo.some((t) => t.includes("not linked")));
  const agents = tmpDir("hh-agents-"), calls: string[] = [];
  writeFileSync(join(agents, "ai.hh.aqing.bridge.whatsapp.plist"), "job");
  const lines = await removeChannel(cfg, configFile, "whatsapp", launchd({ dir: agents, uid: 501, launchctl: async (a) => { calls.push(a.join(" ")); return { code: 0, stderr: "" }; } }));
  assert.deepEqual(calls, ["bootout gui/501/ai.hh.aqing.bridge.whatsapp"]);
  assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { id: "aqing", modules: { goals: { enabled: true } }, channels: {} });
  const kept = readdirSync(join(cfg.stateDir, "channels"));
  assert.equal(kept.length, 1, kept.join(" "));
  assert.match(kept[0]!, /^removed-\d{14}$/);
  assert.deepEqual(readdirSync(join(cfg.stateDir, "channels", kept[0]!)).sort(), ["ai.hh.aqing.bridge.whatsapp.plist", "whatsapp.auth", "whatsapp.json"]);
  assert.ok(existsSync(join(cfg.stateDir, "channels", kept[0]!, "whatsapp.auth", "creds.json")));
  assert.ok(lines.some((l) => l.startsWith("stopped and unloaded ai.hh.aqing.bridge.whatsapp")));
  const check = await channelCheck({ ...cfg, channels: {} }, "whatsapp", wapp, { status: async () => null, ownerIds: () => ({}) });
  assert.deepEqual(check.map((i) => i.status), ["setup"]);
  assert.match(check[0]!.text, /^channel whatsapp is not set up/);
  await assert.rejects(removeChannel(cfg, configFile, "whatsapp", launchd({ dir: agents, uid: 501, launchctl: async () => ({ code: 0, stderr: "" }) })), /is not a channel of this role/);
});
