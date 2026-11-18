// The senses module (modules/senses): one pulse builds the source table from the loaded modules' configs and runs the
// real scripts/senses.py, which hands a new event to HH. HH here is a fake `hh` that keeps what `hh sense --file` gave it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import senses from "../modules/senses/module.ts";
import type { ModuleContext } from "../src/modules/api.ts";
import { runScript } from "../src/modules/command.ts";
import { testConfig } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";
import { zh } from "../src/lang/zh/index.ts";
import { en } from "../src/lang/en/index.ts";

const MODULES = resolve(dirname(fileURLToPath(import.meta.url)), "../modules");

/** A pulse's world: a fake hh, the module's context with this config, one peer "parrot" declaring ping (and defining pong) */
function world(over: Record<string, unknown> = {}) {
  const root = tmpDir("hh-senses-");
  const got = join(root, "sensed.json");
  const hh = join(root, "hh");
  // the fake hh: `hh sense --file <f>` keeps <f> and answers ok, as HH does when it takes the events
  writeFileSync(hh, `#!/bin/sh\n[ "$1" = sense ] && cp "$3" ${JSON.stringify(got)} && echo '{"status": "ok"}'\n`);
  chmodSync(hh, 0o755);
  const state = join(root, "state", "modules", "senses");
  const config = { ...senses.config!.defaults, hooks: [{ type: "wake_main", on: "*", debounce_sec: 0 }], ...over };
  const env = {
    ...process.env, PYTHONPATH: join(MODULES, "_lib"), HH_WORKSPACE: root, HH_STATE_DIR: join(root, "state"),
    HH_MODULE_DIR: join(MODULES, "senses"), HH_MODULE_STATE: state, HH_ROLE_ID: "t", HH_ME: "阿青", HH_OWNER: "老林",
    HH_TZ: "UTC", HH_LANG: "zh", HH_BIN: hh, HH_MODULE_CONFIG: JSON.stringify(config),
  };
  const m = {
    name: "senses", stateDir: state, config, role: { workspace: root },
    peers: () => [{ name: "parrot", senses: ["ping"], config: { senses: { ping: { type: "command", cmd: "echo ping-1", fire_on_first: true }, pong: { type: "command", cmd: "echo pong-1", fire_on_first: true } } } }],
    run: (script: string, argv: readonly string[], o: { timeoutMs?: number } = {}) =>
      runScript(join(MODULES, "senses", script), argv, { python: testConfig().tools.python, cwd: root, env, stateDir: state, ...o }),
    log: () => {},
  } as unknown as ModuleContext;
  const pulse = () => senses.timers!.find((t) => t.name === "pulse")!.run.run(m);
  /** what the fake hh was handed (handing over runs in the background) */
  const sent = async () => {
    // until it parses: the fake hh's cp can be caught halfway, the file there and empty (a deploy check failed on it, 11-16)
    for (let i = 0; ; i++) {
      try { return JSON.parse(readFileSync(got, "utf8")) as { text: string; events: Array<{ src: string; text: string }> }; }
      catch (e) { if (i >= 50) throw e; await new Promise((r) => setTimeout(r, 100)); }
    }
  };
  return { root, state, pulse, sent };
}

test("senses module: a source defined in an on module's config reaches HH within one pulse; a module's undeclared source does not run", async () => {
  const { state, pulse, sent: handed } = world();
  await pulse();
  const table = JSON.parse(readFileSync(join(state, "senses.json"), "utf8")) as { sources: Array<{ id: string }>; hh_json: boolean };
  assert.deepEqual(table.sources.map((s) => s.id), ["ping"], "only the sources the owning module declares");
  const sent = await handed();
  assert.deepEqual(sent.events.map((e) => [e.src, e.text]), [["ping", "ping-1"]]);
  assert.match(sent.text, /^\[感官\] 有新动静/);
});

test("senses module: the role's own table, read each round, adds the sources no on module declares and its settings win; the rounds keep their state in dataDir", async () => {
  const { root, state, pulse, sent } = world({ table: "senses/senses.json", dataDir: "senses", hooks: [] });
  mkdirSync(join(root, "senses"));
  writeFileSync(join(root, "senses", "senses.json"), JSON.stringify({
    hooks: [{ type: "wake_main", on: "*", debounce_sec: 0 }],
    sources: [{ id: "ping", type: "command", cmd: "echo from-the-table", fire_on_first: true }, { id: "own", type: "command", cmd: "echo own-1", fire_on_first: true }],
  }));
  await pulse();
  const table = JSON.parse(readFileSync(join(state, "senses.json"), "utf8")) as { sources: Array<{ id: string; cmd: string }>; hooks: unknown[] };
  assert.deepEqual(table.sources.map((s) => [s.id, s.cmd]), [["ping", "echo ping-1"], ["own", "echo own-1"]], "a declared id comes from its module");
  assert.equal(table.hooks.length, 1, "the table's hooks over the module's");
  assert.deepEqual((await sent()).events.map((e) => [e.src, e.text]), [["ping", "ping-1"], ["own", "own-1"]]);
  assert.ok(existsSync(join(root, "senses", "state.json")) && !existsSync(join(state, "state.json")));
  assert.match(readFileSync(join(state, "senses.log"), "utf8"), /^NEW own /m, "what the round said");
});

test("senses: what the script writes in each language is what the gate reads back: a body's opening line, a tag that asks for the role, the acknowledgement line, the sense header", () => {
  for (const pack of [zh, en]) {
    const file = (kind: string): Record<string, string> => JSON.parse(readFileSync(join(MODULES, "senses", `${kind}${pack.code === "en" ? "" : `.${pack.code}`}.json`), "utf8")) as Record<string, string>;
    const texts = file("texts"), forms = file("forms");
    assert.equal(forms.bodyOpen, pack.gate.parse.bodyOpen, pack.code);
    assert.ok(texts.netTagAlarm!.endsWith(`${pack.gate.parse.asksTail}]`), pack.code);
    assert.ok(texts.netFail!.startsWith(texts.netTagAlarm!), pack.code);
    assert.ok(texts.dispatch!.split("{lines}\n")[1]!.startsWith(pack.gate.parse.ackHead), pack.code);
    assert.ok(texts.dispatch!.startsWith(`${pack.brain.brain.senseHeader} `), `${pack.code}: the sense header`);
    const night = JSON.parse(readFileSync(join(MODULES, "night", `forms${pack.code === "en" ? "" : `.${pack.code}`}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(night.senseHeader, pack.brain.brain.senseHeader, `${pack.code}: the night's scripts know the header`);
    assert.ok((night.lintSystemHeads as string[]).includes(pack.brain.brain.senseHeader), pack.code);
  }
});
