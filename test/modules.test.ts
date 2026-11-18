// Modules (src/modules): a fake module with command tools is found, loads only when turned on, reaches the regions its
// tools name (with its bin/ on PATH, its MCP server and its guide), runs by the command convention, and is listed and
// checked by hh modules. A module in the workspace may not bring code. With no module on, nothing changes.
import { launchd } from "../src/services/launchd.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUILTIN_ROOT, discover, loadModules, Modules, fillArgs, roleFacts, type ModuleRoot } from "../src/modules/load.ts";
import { doctor, install, modulesCommand, runTimer } from "../src/modules/doctor.ts";
import { startProcesses } from "../src/modules/timers.ts";
import { buildPrefix, Persona } from "../src/persona/persona.ts";
import { B, DEFAULT_LANG } from "../src/lang/index.ts";
import { Situation } from "../src/memory/situation.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import { makeBrain, testConfig } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";
import { zh } from "../src/lang/zh/index.ts";
import { en } from "../src/lang/en/index.ts";

const API = pathToFileURL(resolve(fileURLToPath(import.meta.url), "../../src/modules/api.ts")).href;

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** A built-in-style module "parrot" under a trusted root, and a config for a role named 阿青 */
function world(modules: Record<string, unknown> = {}) {
  const root = tmpDir("hh-mod-root-");
  const ws = tmpDir("hh-mod-ws-");
  const state = tmpDir("hh-mod-state-");
  const dir = join(root, "parrot");
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "bin"));
  script(join(dir, "scripts", "say.sh"), 'echo "args:$*"\necho "me:$HH_ME owner:$HH_OWNER config:$HH_MODULE_CONFIG"\necho "state:$HH_MODULE_STATE ws:$HH_WORKSPACE"\necho "stdin:$(cat)"');
  script(join(dir, "scripts", "fail.sh"), "echo first >&2\necho last >&2\nexit 3");
  script(join(dir, "scripts", "slow.sh"), "exec sleep 5");
  script(join(dir, "bin", "parrot"), "echo squawk");
  script(join(dir, "scripts", "brief.sh"), "echo parrot is awake");
  writeFileSync(join(dir, "guide.md"), "parrot repeats a word back.\n");
  writeFileSync(join(dir, "module.ts"), `
import { defineModule, command, z } from ${JSON.stringify(API)};
export default defineModule({
  name: "parrot", summary: "repeats words",
  config: { shape: { greeting: z.string() }, defaults: { greeting: "hi" } },
  tools: [
    command({ name: "parrot_say", description: "say a word back", shape: { word: z.string() }, script: "scripts/say.sh", argv: (a) => ["say", String(a.word)], stdin: true }),
    command({ name: "parrot_fail", description: "fails", shape: {}, script: "scripts/fail.sh" }),
    command({ name: "parrot_slow", description: "too slow", shape: {}, script: "scripts/slow.sh", timeoutMs: 1000, regions: ["deep"] }),
  ],
  mcp: { "parrot-mcp": { command: "bin/parrot", args: ["--serve"] } },
  env: (c) => ({ PARROT_LOUD: String(c.greeting).toUpperCase() }),
  hooks: { situation: command({ script: "scripts/brief.sh", timeoutMs: 5000 }) },
});
`);
  const cfg = testConfig({ workspace: ws, stateDir: state, names: { me: "阿青", owner: "老林" }, modules });
  const roots: ModuleRoot[] = [{ dir: root, trusted: true }, { dir: join(ws, "modules"), trusted: false }];
  return { cfg, roots, root, ws, dir };
}

test("modules: found but not loaded until the config turns it on; a required one loads anyway", async () => {
  const off = world();
  const a = await loadModules(off.cfg, { roots: off.roots });
  assert.deepEqual(a.found.map((f) => f.name), ["parrot"]);
  assert.equal(a.loaded.length, 0);
  const on = world({ parrot: { enabled: true, greeting: "hello" } });
  const b = await loadModules(on.cfg, { roots: on.roots });
  assert.deepEqual(b.loaded.map((l) => l.spec.name), ["parrot"]);
  assert.deepEqual(b.loaded[0]!.ctx.config, { greeting: "hello" });
  const req = world();
  mkdirSync(join(req.root, "core"));
  writeFileSync(join(req.root, "core", "module.ts"), `export default { name: "core", summary: "always there", required: true };`);
  const c = await loadModules(req.cfg, { roots: req.roots });
  assert.deepEqual(c.loaded.map((l) => l.spec.name), ["core"]);
});

test("modules: one name in two places stops the load", async () => {
  const w = world();
  mkdirSync(join(w.ws, "modules", "parrot"), { recursive: true });
  writeFileSync(join(w.ws, "modules", "parrot", "module.json"), JSON.stringify({ name: "parrot", summary: "a second parrot" }));
  await assert.rejects(loadModules(w.cfg, { roots: w.roots }), /parrot/);
});

test("modules: a module in the workspace cannot bring code; its module.json is loaded, its args filled from the template", async () => {
  const w = world({ notes: { enabled: true }, sneaky: { enabled: true } });
  const mods = join(w.ws, "modules");
  mkdirSync(join(mods, "sneaky"), { recursive: true });
  writeFileSync(join(mods, "sneaky", "module.ts"), "export default { name: 'sneaky', summary: 'x' };");
  mkdirSync(join(mods, "notes", "scripts"), { recursive: true });
  script(join(mods, "notes", "scripts", "note.sh"), 'echo "$@"');
  writeFileSync(join(mods, "notes", "module.json"), JSON.stringify({
    name: "notes", summary: { zh: "记事", en: "notes" },
    tools: [{ name: "note", description: { zh: "记一条", en: "jot one down" }, params: { text: { type: "string", description: "what" }, due: { type: "string", description: "when", optional: true } }, script: "scripts/note.sh", args: ["add", "{text}", "--due", "{due}"] }],
  }));
  const m = await loadModules(w.cfg, { roots: w.roots });
  const sneaky = m.found.find((f) => f.name === "sneaky")!;
  assert.equal(sneaky.spec, null);
  assert.equal(sneaky.error, B.modules.codeRefused("module.ts"));
  assert.deepEqual(m.loaded.map((l) => l.spec.name), ["notes"]);
  const [note] = m.toolsFor("main");
  assert.equal(await note!.handler({ text: "buy milk" }), "add buy milk");
  assert.equal(await note!.handler({ text: "buy milk", due: "friday" }), "add buy milk --due friday");
  assert.deepEqual(fillArgs(["-v", "{x}", "{y}"], { y: "1" }), ["1"]);
});

test("modules: a turned-on module's tools reach the regions they name, with its bin/ on PATH, its MCP server and its guide", async () => {
  const w = world({ parrot: { enabled: true } });
  const modules = await loadModules(w.cfg, { roots: w.roots });
  const t = makeBrain({}, undefined, { modules });
  t.brain.wakeRegion("main", "go");
  const spec = t.driver.latest("main").spec;
  const say = spec.tools.find((x) => x.name === "parrot_say")!;
  assert.ok(spec.tools.some((x) => x.name === "parrot_fail"));
  assert.ok(!spec.tools.some((x) => x.name === "parrot_slow"), "parrot_slow is for deep only");
  assert.equal(spec.env!.PATH!.split(":")[0], join(w.dir, "bin"));
  assert.ok(spec.env!.HH_BIN, "the bin/ wrappers run their scripts through hh modules run");
  assert.deepEqual((spec.mcpServers!["parrot-mcp"] as { command: string; args: string[] }).command, join(w.dir, "bin", "parrot"));
  assert.match(spec.systemAppend, /<guide module="parrot">\nparrot repeats a word back\.\n<\/guide>/);
  const out = await say.handler({ word: "cracker" });
  assert.match(out, /^args:say cracker$/m);
  assert.match(out, /^me:阿青 owner:老林 config:\{"greeting":"hi"\}$/m);
  assert.match(out, new RegExp(`^state:${join(w.cfg.stateDir, "modules", "parrot")} ws:${w.ws}$`, "m"));
  assert.match(out, /^stdin:\{"word":"cracker"\}$/m);
});

test("modules: writeEnv leaves each on module's env.json and env.sh; bin/hh runs `modules run` from env.sh as the CLI does, without node; an off module has neither", async () => {
  const w = world({ parrot: { enabled: true, greeting: "it's" } });
  const m = await loadModules(w.cfg, { roots: w.roots });
  const state = join(w.cfg.stateDir, "modules", "parrot");
  // one written earlier with a wider mode is narrowed too
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "env.json"), "{}", { mode: 0o644 });
  m.writeEnv(w.cfg);
  assert.equal(statSync(join(state, "env.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(state, "env.sh")).mode & 0o777, 0o600);
  const env = JSON.parse(readFileSync(join(state, "env.json"), "utf8")) as Record<string, string>;
  assert.equal(env.HH_ME, "阿青");
  assert.equal(env.HH_PYTHON, w.cfg.tools.python);
  assert.equal(env.HH_NODE, process.execPath);
  assert.equal(env.PARROT_LOUD, "IT'S", "the module's own variables, worked out from its config");
  assert.equal(env.PATH, undefined);
  const args = ["say", "a b", "it's"];
  // no node on PATH: the run can only come from the shell
  const fast = spawnSync("/bin/sh", [resolve(fileURLToPath(import.meta.url), "../../bin/hh"), "modules", "run", "parrot", "say.sh", ...args],
    { cwd: "/", env: { PATH: "/usr/bin:/bin", HH_STATE_DIR: w.cfg.stateDir }, input: "", encoding: "utf8" });
  const cli = await m.loaded[0]!.ctx.run("scripts/say.sh", args, { timeoutMs: 0 });
  assert.equal(fast.status, 0, fast.stderr);
  assert.equal(fast.stdout, cli.stdout);
  assert.match(fast.stdout, /config:\{"greeting":"it's"\}/);
  // anything else starts the CLI on HH_NODE, whatever node the caller's PATH has (here none)
  const cliRun = spawnSync("/bin/sh", [resolve(fileURLToPath(import.meta.url), "../../bin/hh"), "--help"], { env: { PATH: "/usr/bin:/bin", HH_NODE: process.execPath }, encoding: "utf8" });
  assert.equal(cliRun.status, 0, cliRun.stderr);
  const off = await loadModules(testConfig({ ...w.cfg, modules: {} }), { roots: w.roots });
  off.writeEnv(w.cfg);
  assert.ok(!existsSync(join(state, "env.sh")) && !existsSync(join(state, "env.json")));
});

test("modules: a non-zero exit reports the last lines of stderr; a run past its time limit is stopped and says so", async () => {
  const w = world({ parrot: { enabled: true } });
  const m = await loadModules(w.cfg, { roots: w.roots });
  const fail = m.toolsFor("main").find((x) => x.name === "parrot_fail")!;
  assert.equal(await fail.handler({}), B.run.exitedWithCode(3, "first\nlast"));
  const slow = m.toolsFor("deep").find((x) => x.name === "parrot_slow")!;
  assert.equal(await slow.handler({}), B.modules.timedOut(1));
});

test("modules: hh modules list and doctor name the module, its state and what it still needs", async () => {
  const w = world({ helper: { enabled: true } });
  mkdirSync(join(w.ws, "modules", "helper"), { recursive: true });
  writeFileSync(join(w.ws, "modules", "helper", "module.json"), JSON.stringify({ name: "helper", summary: "needs a program", requires: { bins: ["hh-no-such-program"] } }));
  const list = await modulesCommand(w.cfg, ["list"]);
  assert.match(list.text, new RegExp(`^helper\\t${B.modules.stateOn}\\t${B.modules.rootRole}\\tneeds a program$`, "m"));
  const doc = await modulesCommand(w.cfg, ["doctor"]);
  assert.match(doc.text, new RegExp(`^helper\\t${B.modules.stateOn}\\t${B.modules.rootRole}\\t${B.modules.statusSetup}\\n  - ${B.modules.statusSetup}: ${B.modules.needsBin("hh-no-such-program")}$`, "m"));
  assert.equal(doc.code, 0);
  assert.equal((await modulesCommand(w.cfg, ["check", "nobody"])).code, 1);
  mkdirSync(join(w.ws, "modules", "helper", "scripts"));
  script(join(w.ws, "modules", "helper", "scripts", "hi.sh"), 'echo "hi $1 from $HH_MODULE_DIR"; echo oops >&2; exit 4');
  assert.deepEqual(await modulesCommand(w.cfg, ["run", "helper", "hi.sh", "there"]), { text: `hi there from ${join(w.ws, "modules", "helper")}`, code: 4, err: "oops\n" });
});

test("modules: with no module on, the kernel's environment, MCP servers, tools and the prefix are what they were; a module that brings nothing leaves them too", async () => {
  const cfg = testConfig();
  const none = new Modules([], []);
  const k = none.kernel(cfg.kernel);
  assert.equal(k.env, cfg.kernel.env);
  assert.equal(k.mcpServers, cfg.kernel.mcpServers);
  const root = tmpDir("hh-mod-bare-");
  mkdirSync(join(root, "core"));
  writeFileSync(join(root, "core", "module.ts"), `export default { name: "core", summary: "x", required: true };`);
  const bare = (await loadModules(cfg, { roots: [{ dir: root, trusted: true }] })).kernel(cfg.kernel);
  assert.equal(bare.env, cfg.kernel.env);
  assert.equal(bare.mcpServers, cfg.kernel.mcpServers);
  const own = [{ name: "jot_down", description: "", shape: {}, handler: async () => "" }];
  assert.deepEqual(none.withTools(own, "main"), own);
  const persona = new Persona("阿青", [{ path: "IDENTITY.md", text: "我是阿青。" }]);
  assert.equal(buildPrefix(persona, [], { guides: none.guides() }), buildPrefix(persona, []));
});

test("modules: an on module's situation hook adds its part to the wake-up brief; one that never answers only leaves its own part out", async () => {
  const w = world({ parrot: { enabled: true }, mute: { enabled: true } });
  mkdirSync(join(w.root, "mute"));
  writeFileSync(join(w.root, "mute", "module.ts"), `export default { name: "mute", summary: "x", hooks: { situation: { timeoutMs: 200, run: () => new Promise(() => {}) } } };`);
  const logs: LogRecord[] = [];
  const log = new Logger("t", memorySink(logs));
  const m = await loadModules(w.cfg, { roots: w.roots, log });
  const s = new Situation({
    workspace: w.ws, loadStatusFile: `${w.ws}/load/status.json`, timezone: "UTC", now: Date.now,
    log, modules: m.situationHooks(),
  });
  assert.match(await s.forMain(), /parrot is awake/);
  assert.ok(logs.some((l) => l.msg === "modules: situation failed" && l.module === "mute"));
});

test("modules: a module process starts with hhd, is recorded under the role's state directory, and is stopped by its record", async () => {
  const w = world({ keeper: { enabled: true } });
  mkdirSync(join(w.root, "keeper", "scripts"), { recursive: true });
  script(join(w.root, "keeper", "scripts", "watch.sh"), "exec sleep 30");
  writeFileSync(join(w.root, "keeper", "module.ts"), `export default { name: "keeper", summary: "x", processes: [{ name: "watch", script: "scripts/watch.sh" }] };`);
  const m = await loadModules(w.cfg, { roots: w.roots });
  const stop = startProcesses(w.cfg, m);
  const { pid } = JSON.parse(readFileSync(join(w.cfg.stateDir, "repair", "module-keeper-watch.json"), "utf8")) as { pid: number };
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive());
  stop();
  for (let i = 0; i < 40 && alive(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(!alive(), "stopped by its record");
});

test("modules: a module process writes to <name>.log in its state dir; one that ends is started again; once stopped it is not", async () => {
  const w = world({ keeper: { enabled: true } });
  const runs = join(w.cfg.stateDir, "modules", "keeper", "watch.log");
  mkdirSync(join(w.root, "keeper", "scripts"), { recursive: true });
  script(join(w.root, "keeper", "scripts", "watch.sh"), "echo started");
  writeFileSync(join(w.root, "keeper", "module.ts"), `export default { name: "keeper", summary: "x", processes: [{ name: "watch", script: "scripts/watch.sh" }] };`);
  const stop = startProcesses(w.cfg, await loadModules(w.cfg, { roots: w.roots }), 50);
  const count = (): number => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").length - 1 : 0);
  for (let i = 0; i < 60 && count() < 3; i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(count() >= 3, `started ${count()} times`);
  stop();
  await new Promise((r) => setTimeout(r, 300));
  const n = count();
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(count(), n);
});

test("modules: the guide and manuals in the role's language win over the plain ones; a module's reminder reaches the role's schedule", async () => {
  const w = world({ parrot: { enabled: true } });
  writeFileSync(join(w.dir, "guide.en.md"), "parrot, in English.\n");
  const zh = await loadModules(w.cfg, { roots: w.roots });
  assert.equal(zh.loaded[0]!.guide, "parrot repeats a word back.");
  const en = await loadModules({ ...w.cfg, lang: "en" }, { roots: w.roots });
  assert.equal(en.loaded[0]!.guide, "parrot, in English.");
  const t = makeBrain({}, undefined, { modules: zh });
  zh.loaded[0]!.ctx.remind!("time to sort the stickers", t.clock.now() + 60_000);
  assert.deepEqual(t.brain.schedule.list().map((x) => [x.kind, x.text, x.due]), [["remind", "time to sort the stickers", t.clock.now() + 60_000]]);
});

test("modules: every built-in module's declaration loads when turned on, and none of them checks as broken", async () => {
  const roots = [{ dir: BUILTIN_ROOT, trusted: true }];
  const on = Object.fromEntries((await discover(roots, "zh")).map((f) => [f.name, { enabled: true }]));
  const cfg = testConfig({ workspace: tmpDir("hh-mod-builtin-"), stateDir: tmpDir("hh-mod-builtin-state-"), names: { me: "阿青", owner: "老林" }, modules: on });
  const m = await loadModules(cfg, { roots });
  assert.deepEqual(m.found.filter((f) => !f.spec).map((f) => `${f.name}: ${f.error}`), []);
  assert.deepEqual(m.loaded.map((l) => l.spec.name).sort(), Object.keys(on).sort());
  assert.deepEqual((await doctor(cfg, m)).filter((r) => r.status === "broken").map((r) => `${r.found.name}: ${r.items.map((i) => i.text).join("; ")}`), []);
  // their MCP servers take their own names (a role that still lists one of them under kernel.mcpServers is stopped at start);
  // B站's is left out here: this fresh role has no Python environment for it, so it could not start
  assert.deepEqual(Object.keys(m.kernel({ ...cfg.kernel, mcpServers: {} }).mcpServers).sort(), m.loaded.flatMap((l) => Object.keys(l.spec.mcp ?? {})).filter((n) => n !== "bili").sort());
});

test("modules: B站's MCP server goes to the kernel only when its Python environment can start it; doctor says why it is off", async () => {
  const ws = tmpDir("hh-mod-bili-"), venv = join(ws, "venv");
  mkdirSync(join(venv, "bin"), { recursive: true });
  // a python whose packages did not install (bilibili-api-python on a Python it does not support): every import fails
  writeFileSync(join(venv, "bin", "python"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(venv, "bin", "python"), 0o755);
  const cfg = testConfig({ workspace: ws, stateDir: tmpDir("hh-mod-bili-state-"), names: { me: "阿青", owner: "老林" }, modules: { bilibili: { enabled: true, venv: "venv" } } });
  const m = await loadModules(cfg, { roots: [{ dir: BUILTIN_ROOT, trusted: true }] });
  // asked in the background so a slow answer holds no session up: given until this python answers no, then left out
  const inKernel = () => "bili" in m.kernel({ ...cfg.kernel, mcpServers: {} }).mcpServers;
  for (let i = 0; i < 100 && inKernel(); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(inKernel(), false, "left out");
  // found by what it says, not by its place: where a required program (ffmpeg) is not on PATH, doctor's own line about that comes first
  const lines = (await doctor(cfg, m)).find((r) => r.found.name === "bilibili")!.items;
  assert.ok(lines.some((l) => l.status === "setup" && /packages did not install/.test(l.text)), JSON.stringify(lines));
});

test("modules: the goals module's tool and brief work in an empty workspace, run the way the role runs them", async () => {
  const cfg = testConfig({ workspace: tmpDir("hh-mod-goals-"), stateDir: tmpDir("hh-mod-goals-state-"), names: { me: "阿青", owner: "老林" }, modules: { goals: { enabled: true } } });
  const m = await loadModules(cfg, { roots: [{ dir: BUILTIN_ROOT, trusted: true }] });
  const goals = m.toolsFor("main").find((t) => t.name === "goals")!;
  assert.match(await goals.handler({ args: ["add", "today", "写周报", "--why", "周一要交", "--done-when", "发出去"] }), /g1/);
  assert.match(await m.situationHooks().find((h) => h.name === "goals")!.run(), /写周报/);
});

test("modules: peers lists every loaded module with the sense sources it owns and its config (the senses collector's view)", async () => {
  const w = world({ parrot: { enabled: true, greeting: "yo" } });
  const hen = join(w.root, "hen");
  mkdirSync(hen);
  writeFileSync(join(hen, "module.ts"), `
import { defineModule } from ${JSON.stringify(API)};
export default defineModule({ name: "hen", summary: "lays", required: true, senses: ["eggs"], config: { shape: {}, defaults: { senses: { eggs: { type: "command" } } } } });
`);
  const mods = await loadModules(w.cfg, { roots: w.roots });
  const peers = mods.loaded[0]!.ctx.peers!();
  assert.deepEqual(peers.map((p) => [p.name, p.senses, p.config]).sort(), [
    ["hen", ["eggs"], { senses: { eggs: { type: "command" } } }],
    ["parrot", [], { greeting: "yo" }],
  ]);
});

test("modules install: the role's venv, the on modules' Python packages, and launchd jobs for hhd, the console and each standalone timer; a job file that differs is left alone", async () => {
  const w = world({ owl: { enabled: true } });
  const owl = join(w.root, "owl");
  mkdirSync(join(owl, "scripts"), { recursive: true });
  writeFileSync(join(owl, "requirements.txt"), "six==1.16.0\n");
  script(join(owl, "scripts", "hoot.sh"), "echo hoot");
  writeFileSync(join(owl, "module.ts"), `
import { defineModule, command } from ${JSON.stringify(API)};
export default defineModule({ name: "owl", summary: "hoots", requires: { python: "requirements.txt" },
  timers: [{ name: "night", everyMs: 90_000, standalone: true, run: command({ script: "scripts/hoot.sh", timeoutMs: 5000 }) },
           { name: "inside", everyMs: 60_000, run: command({ script: "scripts/hoot.sh", timeoutMs: 5000 }) }] });
`);
  const cfg = { ...w.cfg, tools: { ...w.cfg.tools, python: join(w.cfg.stateDir, "venv", "bin", "python") }, launchd: { hhd: "ai.hh.aqing.hhd", console: "ai.hh.aqing.console", consolePort: 7801 } };
  const mods = await loadModules(cfg, { roots: w.roots });
  const agents = tmpDir("hh-agents-");
  writeFileSync(join(agents, "ai.hh.aqing.console.plist"), "someone else's\n");
  const ran: string[] = [];
  const loaded: string[] = [];
  const saved = process.env.HH_CONFIG, path = process.env.PATH;
  process.env.HH_CONFIG = "/roles/aqing/instance.json";
  // a folder on an external disk is left out of the jobs' PATH (macOS would ask for a removable volume), one put back in launchd.extraPath is in
  process.env.PATH = `/usr/bin:/Volumes/Ext/bin:/bin`;
  (cfg.launchd as { extraPath?: string[] }).extraPath = ["/Volumes/Tools/bin"];
  try {
    const { lines } = await install(cfg, mods, {
      run: async (cmd, args) => { ran.push([cmd, ...args].join(" ")); return { code: 0, stdout: "", stderr: "" }; },
      services: launchd({ dir: agents, uid: 501, launchctl: async (args) => { loaded.push(args.join(" ")); return { code: 0, stderr: "" }; } }),
    });
    assert.ok(ran[0]!.startsWith(`python3 -m venv ${join(cfg.stateDir, "venv")}`), ran.join("\n"));
    assert.ok(ran.some((r) => r === `${cfg.tools.python} -m pip install -q -r ${join(owl, "requirements.txt")}`), ran.join("\n"));
    const timer = readFileSync(join(agents, "ai.hh.aqing.owl.night.plist"), "utf8");
    assert.match(timer, /<key>StartInterval<\/key><integer>90<\/integer>/);
    assert.match(timer, /<string>modules<\/string>\s*<string>timer<\/string>\s*<string>owl<\/string>\s*<string>night<\/string>/);
    assert.match(timer, /<key>HH_CONFIG<\/key><string>\/roles\/aqing\/instance\.json<\/string>/);
    assert.ok(!existsSync(join(agents, "ai.hh.aqing.owl.inside.plist")), "a timer hhd runs gets no job");
    assert.match(readFileSync(join(agents, "ai.hh.aqing.hhd.plist"), "utf8"), /<string>\/roles\/aqing\/instance\.json<\/string>/);
    for (const f of ["ai.hh.aqing.hhd.plist", "ai.hh.aqing.owl.night.plist"]) assert.match(readFileSync(join(agents, f), "utf8"), /<key>PATH<\/key><string>\/usr\/bin:\/bin:\/Volumes\/Tools\/bin<\/string>/, f);
    assert.ok(lines.includes(B.modules.pathLeftOut("/Volumes/Ext/bin")), lines.join("\n"));
    assert.equal(readFileSync(join(agents, "ai.hh.aqing.console.plist"), "utf8"), "someone else's\n", "a job file that differs is not touched");
    assert.deepEqual(loaded.sort(), [`bootstrap gui/501 ${join(agents, "ai.hh.aqing.hhd.plist")}`, `bootstrap gui/501 ${join(agents, "ai.hh.aqing.owl.night.plist")}`]);
    assert.ok(lines.some((l) => l === B.modules.jobKept("ai.hh.aqing.console", agents)), lines.join("\n"));
    const { lines: again } = await install(cfg, mods, { run: async () => ({ code: 0, stdout: "", stderr: "" }), services: launchd({ dir: agents, uid: 501, launchctl: async () => ({ code: 0, stderr: "" }) }) });
    assert.ok(again.includes(B.modules.jobSame("ai.hh.aqing.owl.night")), again.join("\n"));
    // --no-start: the job files are written, nothing is loaded
    const fresh = tmpDir("hh-agents-");
    const quiet = await install(cfg, mods, { run: async () => ({ code: 0, stdout: "", stderr: "" }), services: launchd({ dir: fresh, uid: 501, launchctl: async () => { throw new Error("must not load"); } }) }, { start: false });
    assert.ok(quiet.lines.includes(B.modules.jobWritten("ai.hh.aqing.owl.night", `launchctl bootstrap gui/501 ${join(fresh, "ai.hh.aqing.owl.night.plist")}`)), quiet.lines.join("\n"));
    assert.equal(quiet.failed, false);
    // a LaunchAgents path that cannot hold files fails each job, and the steps before it are still reported
    const blocked = join(tmpDir("hh-agents-"), "a-file");
    writeFileSync(blocked, "");
    const bad = await install(cfg, mods, { run: async () => ({ code: 0, stdout: "", stderr: "" }), services: launchd({ dir: blocked, uid: 501, launchctl: async () => ({ code: 0, stderr: "" }) }) });
    assert.ok(bad.failed && bad.lines.some((l) => l.startsWith("ai.hh.aqing.owl.night ")) && bad.lines.some((l) => l === B.modules.venvMade(join(cfg.stateDir, "venv"))), bad.lines.join("\n"));
  } finally {
    if (saved === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = saved;
    process.env.PATH = path;
  }
  const once = await runTimer(cfg, mods, "owl", "night");
  assert.deepEqual([once.code, once.text], [0, "hoot"]);
  assert.equal((await runTimer(cfg, mods, "owl", "nope")).code, 2);
});

test("modules install with the role's own app (launchd.app): install builds and signs it (or keeps the one there) and each job starts with its launcher; without the role's folder, when it cannot be built, or on a path others can change, nothing is installed", async () => {
  const w = world({ owl: { enabled: true } });
  const owl = join(w.root, "owl");
  mkdirSync(join(owl, "scripts"), { recursive: true });
  script(join(owl, "scripts", "hoot.sh"), "echo hoot");
  writeFileSync(join(owl, "module.ts"), `
import { defineModule, command } from ${JSON.stringify(API)};
export default defineModule({ name: "owl", summary: "hoots", timers: [{ name: "night", everyMs: 90_000, standalone: true, run: command({ script: "scripts/hoot.sh", timeoutMs: 5000 }) }] });
`);
  const home = realpathSync(tmpDir("hh-role-app-"));
  const app = join(home, "aqing", "Aqing.app");
  const cfg = { ...w.cfg, launchd: { hhd: "ai.hh.aqing.hhd", console: "ai.hh.aqing.console", consolePort: 7801, app } };
  const mods = await loadModules(cfg, { roots: w.roots });
  const run = async () => ({ code: 0, stdout: "", stderr: "" });
  const svc = (dir: string) => launchd({ dir, uid: 501, launchctl: async () => ({ code: 0, stderr: "" }) });
  const saved = process.env.HH_CONFIG;
  process.env.HH_CONFIG = "/roles/aqing/instance.json";
  const launcher = join(app, "Contents", "MacOS", "HH");
  let count = 0;
  const builds = () => count;
  const human = join(home, "Applications", "Human.app");
  const build = async () => { count++; mkdirSync(dirname(launcher), { recursive: true }); writeFileSync(launcher, ""); return { built: true, human }; };
  try {
    const none = tmpDir("hh-agents-");
    const ask = async () => null;
    const noFolder = await install(cfg, mods, { run, services: svc(none), app: build, grants: ask });
    assert.ok(noFolder.failed && noFolder.lines.includes(B.modules.appNoFolder(join(home, "aqing"), userInfo().username)) && noFolder.lines.includes(B.modules.appNoJobs), noFolder.lines.join("\n"));
    assert.equal(builds(), 0, "nothing is built before the owner makes the role's folder");
    assert.deepEqual(readdirSync(none), [], "no job points at an app that is not there");
    mkdirSync(join(home, "aqing"));
    const broken = await install(cfg, mods, { run, services: svc(none), app: async () => { throw new Error("swiftc: no such file"); }, grants: ask });
    assert.ok(broken.failed && broken.lines.includes(B.modules.appFailed(app, "swiftc: no such file")), broken.lines.join("\n"));
    assert.deepEqual(readdirSync(none), [], "nor at one that could not be built");
    const agents = tmpDir("hh-agents-");
    const done = await install(cfg, mods, { run, services: svc(agents), app: build, grants: ask });
    assert.equal(done.failed, false, done.lines.join("\n"));
    assert.ok(builds() === 1 && done.lines.join("\n").includes(`${B.modules.appBuilt(app)}\n${B.modules.humanBuilt(human)}\n${B.modules.grantsAsk(app)}`), done.lines.join("\n"));
    for (const job of ["ai.hh.aqing.hhd", "ai.hh.aqing.console", "ai.hh.aqing.owl.night"]) {
      assert.match(readFileSync(join(agents, `${job}.plist`), "utf8"), new RegExp(`<array>\\s*<string>${launcher.replace(/[.]/g, "\\.")}</string>\\s*<string>--</string>\\s*<string>${process.execPath.replace(/[.]/g, "\\.")}</string>`), job);
    }
    // the owner at the screen turned on two of the three on the app's page: the jobs are installed all the same
    const kept = await install(cfg, mods, { run, services: svc(agents), app: async () => ({ built: false }), grants: async () => ({ fda: true, screen: false, ax: true }) });
    assert.ok(!kept.failed && kept.lines.join("\n").includes(`${B.modules.appKept(app)}\n${B.modules.grantsOff(app, [B.modules.grantName.screen])}`) && !kept.lines.some((l) => l.includes("Human.app")), kept.lines.join("\n"));
    const all = await install(cfg, mods, { run, services: svc(agents), app: async () => ({ built: false }), grants: async () => ({ fda: true, screen: true, ax: true }) });
    assert.ok(all.lines.includes(`${B.modules.appKept(app)}\n${B.modules.grantsOn}`), all.lines.join("\n"));
    chmodSync(join(home, "aqing"), 0o775);
    const open = await install(cfg, mods, { run, services: svc(tmpDir("hh-agents-")), app: build, grants: ask });
    assert.ok(open.failed && open.lines.includes(B.modules.appUnsafe(app, join(home, "aqing"))) && builds() === 1, open.lines.join("\n"));
  } finally {
    if (saved === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = saved;
  }
});

test("modules: a helper session gets the same built-in tools as the kernel's sessions by default (helpers' tools = kernel.builtinTools)", async () => {
  const helpers = (await import("../modules/helpers/module.ts")).default;
  const kernel = JSON.parse(readFileSync(resolve(fileURLToPath(import.meta.url), "../../config/default.json"), "utf8")) as { kernel: { builtinTools: string[] } };
  assert.deepEqual(helpers.config!.defaults!.tools, kernel.kernel.builtinTools);
});

test("modules: a module that keeps its words in files has them in English (texts.json), and each language file has the same entries with the same placeholders", () => {
  const holes = (s: string): string => [...new Set(s.match(/\{\w+\}/g) ?? [])].sort().join(" ");
  const read = (f: string): Record<string, string> => JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
  let files = 0;
  for (const m of readdirSync(BUILTIN_ROOT)) {
    const langs = existsSync(join(BUILTIN_ROOT, m)) && statSync(join(BUILTIN_ROOT, m)).isDirectory() ? readdirSync(join(BUILTIN_ROOT, m)).filter((f) => /^texts\.[a-z-]+\.json$/.test(f)) : [];
    if (!langs.length) continue;
    const en = read(join(BUILTIN_ROOT, m, "texts.json"));   // absent: a role in another language has no words at all, and the script stops
    for (const f of langs) {
      const t = read(join(BUILTIN_ROOT, m, f));
      assert.deepEqual(Object.keys(t).sort(), Object.keys(en).sort(), `${m}/${f}: its entries`);
      for (const k of Object.keys(en)) assert.equal(holes(t[k]!), holes(en[k]!), `${m}/${f}: the placeholders of ${k}`);
      files++;
    }
  }
  assert.ok(files > 0);
});

test("modules: a module's forms (what its code writes for code to read) have English in forms.json, and each language's file has the same entries, each a string or a list as there", () => {
  const read = (f: string): Record<string, unknown> => JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>;
  const kind = (v: unknown): string => (Array.isArray(v) ? "list" : typeof v);
  let files = 0;
  for (const m of readdirSync(BUILTIN_ROOT)) {
    const dir = join(BUILTIN_ROOT, m);
    const langs = statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => /^forms\.[a-z-]+\.json$/.test(f)) : [];
    if (!langs.length) continue;
    const en = read(join(dir, "forms.json"));
    for (const f of langs) {
      const t = read(join(dir, f));
      assert.deepEqual(Object.keys(t).sort(), Object.keys(en).sort(), `${m}/${f}: its entries`);
      for (const k of Object.keys(en)) assert.equal(kind(t[k]), kind(en[k]), `${m}/${f}: ${k} is a ${kind(en[k])}`);
      files++;
    }
  }
  assert.ok(files > 0);
});

test("modules: the night's forms that HH reads too are the packs' in each language: the head of a night's landing commit, the snapshot's thread tiers", () => {
  for (const pack of [zh, en]) {
    const forms = JSON.parse(readFileSync(join(BUILTIN_ROOT, "night", `forms${pack.code === "en" ? "" : `.${pack.code}`}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(forms.sleepCommit, pack.sleep.replay.landingHead, pack.code);
    const texts = JSON.parse(readFileSync(join(BUILTIN_ROOT, "night", `texts${pack.code === "en" ? "" : `.${pack.code}`}.json`), "utf8")) as Record<string, string>;
    const said = (k: string, holes: Record<string, number>): string => texts[k]!.replace(/\{(\w+)\}/g, (_, h: string) => String(holes[h]));
    for (const [k, holes] of [["midTierBrief", { brief_days: 7 }], ["midTierLine", { brief_days: 7, last: 13 }], ["midTierName", { line_days: 14, name_days: 60 }]] as const) {
      assert.ok(pack.brain.forms.threadTier.test(said(k, holes)), `${pack.code}: ${k}`);
    }
    assert.ok(pack.brain.forms.threadWindow.test(said("midWindow", { b: 7, l: 14, n: 60 })), `${pack.code}: the window sentence`);
    assert.equal(texts.midNoThreads, pack.brain.forms.threadNone, pack.code);
  }
});

test("modules: the night's notebook forms are the packs' page forms, and the English general guide writes what the scripts and packs read", () => {
  for (const pack of [zh, en]) {
    const forms = JSON.parse(readFileSync(join(BUILTIN_ROOT, "night", `forms${pack.code === "en" ? "" : `.${pack.code}`}.json`), "utf8")) as Record<string, string | string[]>;
    const page = pack.brain.forms.page;
    assert.deepEqual([forms.noteLesson, forms.noteLessons, forms.notePractices, forms.noteCover, forms.noteDays], [page.lesson.text, page.lessons, page.practice, [page.brief, page.when], page.lesson.days], pack.code);
    assert.equal(forms.noteArchive, (pack.defaults.learning as { archiveDir: string }).archiveDir, pack.code);
  }
  const guide = readFileSync(join(BUILTIN_ROOT, "night", "scripts", "sleep_organize.md"), "utf8");
  assert.doesNotMatch(guide, /\p{Script=Han}/u, "the English guide has no Chinese");
  const forms = JSON.parse(readFileSync(join(BUILTIN_ROOT, "night", "forms.json"), "utf8")) as Record<string, string>;
  const page = en.brain.forms.page;
  for (const want of [
    `<!-- ${forms.stampWord} `, `## ${forms.loopsOpen}`, "## Week N (MM-DD – MM-DD)", "Correction MM-DD:", "Added MM-DD:", `\`${forms.pinTag}\``,
    `## ${page.practice}`, `### ${page.pending}`, `## ${page.lessons}`, `${page.brief}: `, `${page.when}: `, `- ${page.lesson.text}: `, `${page.lesson.days}: `,
    `skills/${(en.defaults.learning as { archiveDir: string }).archiveDir}/`, `## ${forms.reportUnsure}`, `${forms.reportKeywords}: `, "before X → now Y",
    `memory/${en.repair.log.summaryWaitingFile}`, `## ${en.repair.log.waitingHeading.replace("{{owner}}", "<the owner's name>")}`,
  ]) assert.ok(guide.includes(want), `the English guide writes ${want}`);
  const tpl = (en.defaults.memory as { people: { template: { fields: Array<{ name: string }>; quotes: Array<{ name: string }> } } }).people.template;
  for (const f of [...tpl.fields.map((x) => x.name), tpl.quotes[1]!.name]) assert.ok(guide.includes(f), `the English guide names the card's ${f}`);
});

test("modules: a role whose config names no language hands its modules the code of the pack the core speaks, not an empty one", () => {
  const { lang: _unset, ...bare } = testConfig();
  assert.equal(roleFacts(bare as ReturnType<typeof testConfig>).lang, DEFAULT_LANG);
  assert.equal(roleFacts({ ...testConfig(), lang: " " }).lang, DEFAULT_LANG);   // a script given "" would read texts..json, find none and speak English
  assert.equal(roleFacts({ ...testConfig(), lang: "en" }).lang, "en");
});

test("modules: a built-in module with manuals in Chinese has them in English too: the same books with the same number of pages, a cover with name and description, a page opening with its summary and when to open it, no CJK", () => {
  const dirs = (p: string): string[] => readdirSync(p).filter((x) => statSync(join(p, x)).isDirectory());
  const books = (root: string): Map<string, string> =>   // book -> its directory, whatever category it is shelved under
    new Map(dirs(root).flatMap((cat) => dirs(join(root, cat)).map((b) => [b, join(root, cat, b)] as [string, string])));
  let n = 0;
  for (const m of dirs(BUILTIN_ROOT).filter((m) => existsSync(join(BUILTIN_ROOT, m, "skills.zh")))) {
    const zh = books(join(BUILTIN_ROOT, m, "skills.zh")), en = books(join(BUILTIN_ROOT, m, "skills"));
    assert.deepEqual([...en.keys()].sort(), [...zh.keys()].sort(), `${m}: its books`);
    for (const [book, dir] of en) {
      const pages = readdirSync(dir).filter((f) => f.endsWith(".md"));
      assert.equal(pages.length, readdirSync(zh.get(book)!).filter((f) => f.endsWith(".md")).length, `${m}/${book}: its pages`);
      for (const f of pages) {
        const text = readFileSync(join(dir, f), "utf8");
        assert.doesNotMatch(text, /[\u2e80-\u303f\u3400-\u9fff\uff00-\uffef]/, `${m}/${book}/${f}: no CJK`);
        if (f === "SKILL.md") assert.match(text, new RegExp(`^---\\nname: ${book}\\ndescription: .+\\n---\\n`), `${m}/${book}: its cover`);
        else assert.match(text, /^# .+\nSummary: .+\nWhen to open: .+\n/, `${m}/${book}/${f}: its first lines`);
        n++;
      }
    }
  }
  assert.ok(n > 0);
});
