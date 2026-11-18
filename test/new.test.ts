// hh new: the directory it lays out is a role the framework can load — and nothing in it points outside itself.
import { test } from "node:test";
import { readShelfRules } from "../src/learning/layers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, requireInstance, roleNames, launchdLabels } from "../src/config.ts";
import { Persona } from "../src/persona/persona.ts";
import { newCommand, newRole } from "../src/new.ts";
import { BUILTIN_ROOT, discover } from "../src/modules/load.ts";
import { validateRule } from "../src/gate/rules.ts";
import { People } from "../src/persona/people.ts";
import { ownerNameOf } from "../src/cli-parse.ts";
import { tmpDir } from "./tmp.ts";

test("hh new: lays out a role the framework loads — instance config, workspace files, its own port and labels, nothing outside its directory", async () => {
  const root = tmpDir("hh-new-"), dir = join(root, "aqing");
  mkdirSync(join(root, "LaunchAgents"));
  const said = await newRole({ id: "aqing", dir, me: "阿青", owner: "老林", lang: "zh", launchAgents: join(root, "LaunchAgents") });
  assert.ok(said.includes(`HH_CONFIG=${join(dir, "instance.json")}`), said);
  process.env.HH_CONFIG = join(dir, "instance.json");
  try {
    const cfg = loadConfig();
    requireInstance(cfg);
    assert.equal(cfg.workspace, join(dir, "workspace"));
    assert.equal(cfg.stateDir, join(dir, "state"));
    assert.deepEqual(roleNames(cfg), { me: "阿青", owner: "老林", ta: "阿青", place: "", id: "aqing" });
    assert.equal(cfg.tools.sendDryRun, true, "nothing is sent until the owner sets a channel");
    assert.equal(cfg.tools.python, join(dir, "state", "venv", "bin", "python"), "its own Python environment (hh modules install makes it)");
    assert.equal(cfg.tools.node, process.execPath, "the node its launchd jobs run, written down so it can be pointed at a fixed path");
    const builtin = (await discover([{ dir: BUILTIN_ROOT, trusted: true }], "zh")).filter((f) => f.spec && !f.spec.required).map((f) => f.name);
    assert.deepEqual(Object.keys(cfg.modules ?? {}).sort(), builtin.sort(), "every built-in module is on");
    assert.ok(Number.isInteger(cfg.browser.port) && (cfg.browser.port ?? 0) > 1024, "a port of its own, picked when the role is made");
    assert.deepEqual(launchdLabels(cfg), { hhd: "ai.hh.aqing.hhd", console: "ai.hh.aqing.console" });
    for (const label of Object.values(launchdLabels(cfg))) assert.ok(readFileSync(join(dir, "launchd", `${label}.plist`), "utf8").includes(`<string>${label}</string>`), label);
    const persona = Persona.load(cfg.workspace, cfg.id, cfg.personaFiles);
    assert.deepEqual(persona.files.map((f) => f.path), ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md"]);
    assert.ok(persona.files[0]!.text.includes("阿青") && persona.files[2]!.text.includes("老林") && persona.files[4]!.text.includes("先问老林"), "the starter files name the role and its owner");
    // the workspace skeleton (docs/contracts/workspace-layout.md part 4): the persona also starts in soul/, which the night builds SOUL.md from
    for (const d of ["soul", "ledger/people", "memory/people", "memory/threads", "memory/archive", "memory/diary", "sleep", "skills"]) assert.ok(existsSync(join(cfg.workspace, d)), d);
    assert.equal(readFileSync(join(cfg.workspace, "soul", "10-soul.md"), "utf8"), persona.files[1]!.text);
    // every path in the config lies inside the role's own directory (but the node it runs, which is the machine's, and on
    // macOS its app, in the folder the owner makes for it)
    // the owner's own account: ~/Applications/HH/<id>; an account of its own: /Users/Shared/HH/<id>
    const app = process.platform === "darwin" ? join((await import("../src/services/app.ts")).appFolder("aqing"), "阿青.app") : undefined;
    assert.equal(cfg.launchd?.app, app);
    const paths = (JSON.stringify(JSON.parse(readFileSync(join(dir, "instance.json"), "utf8"))).match(/"\/[^"]*"/g) ?? []).filter((p) => p !== JSON.stringify(process.execPath) && p !== JSON.stringify(app));
    assert.ok(paths.length >= 2 && paths.every((p) => p.slice(1).startsWith(dir)), paths.join(" "));
    // what a new role starts with (config/new-role.json): no focus slots or wandering, learning on, the digest and first rules
    assert.deepEqual([cfg.schedule.focusSlots, cfg.schedule.wanderEveryMinutes], [[], 0]);
    assert.deepEqual([cfg.learning.enabled, cfg.learning.inject, cfg.learning.shelf, cfg.learning.timeoutMs], [true, true, true, 1500]);
    assert.equal(cfg.gate.digest, true);
    assert.equal(cfg.writingLanguage, "中文", "the role is told which language to think and write in");
    assert.equal(readShelfRules(resolve(cfg.workspace, cfg.learning.root)).problem, null, "the notebook starts with a rules file");
    assert.equal(cfg.memory?.promptFolds?.length, 8);
    assert.equal((cfg as unknown as { outbound?: { refuseLatinLines?: boolean } }).outbound?.refuseLatinLines, true, "a zh role filters Latin lines out");
    assert.equal(cfg.gate.rulesFile, "gate.json");
    const rules = (JSON.parse(readFileSync(join(cfg.workspace, cfg.gate.rulesFile), "utf8")) as { rules: unknown[] }).rules;
    assert.ok(rules.length > 0 && rules.every((r) => "rule" in validateRule(r)), "the first rules load");
    assert.equal(execFileSync("git", ["-C", cfg.workspace, "rev-list", "--count", "HEAD"], { encoding: "utf8" }).trim(), "1", "a git repository with a first commit");
    assert.equal(cfg.modules?.["load-guard"]?.shed, undefined, "the only guard for this user sheds load");
    // the people list starts with the owner, approved as the owner from the first start
    const people = People.load(cfg.workspace);
    assert.equal(ownerNameOf(people.registry), "老林");
    assert.deepEqual(JSON.parse(readFileSync(join(cfg.workspace, "memory/people/registry.json"), "utf8")), { owner: { name: "老林", privacy: "owner" } });
    assert.equal((cfg.modules?.helpers as { tasksDir?: string } | undefined)?.tasksDir, join(dir, "tasks"), "its helpers work under its own directory");
  } finally { delete process.env.HH_CONFIG; }
});

test("hh new: refuses a directory that already holds something, a bad id, a missing owner, an unknown pack — and writes nothing then", async () => {
  const root = tmpDir("hh-new-");
  writeFileSync(join(root, "taken"), "x");
  await assert.rejects(newRole({ id: "a", dir: root, owner: "老林" }), /exists and is not empty/);
  await assert.rejects(newRole({ id: "Bad Id", dir: join(root, "x1"), owner: "老林" }), /the id is lower-case/);
  await assert.rejects(newCommand(["a", "--dir", join(root, "x2")]), /--owner is required/);
  await assert.rejects(newRole({ id: "a", dir: join(root, "x3"), owner: "老林", lang: "nope" }), /no language pack/);
  await assert.rejects(newCommand(["a", "--what", "x"]), /^Error: usage: hh new/);
  assert.deepEqual(["x1", "x2", "x3"].filter((d) => { try { readFileSync(join(root, d, "instance.json")); return true; } catch { return false; } }), []);
});

test("hh new: without --lang the role is English (written into its config): English folds and no outbound filter; with another role's load guard for this user, its own only watches", async () => {
  const root = tmpDir("hh-new-"), agents = join(root, "LaunchAgents"), dir = join(root, "heng");
  mkdirSync(agents);
  writeFileSync(join(agents, "ai.hh.load-guard.guard.plist"), "");
  const said = await newRole({ id: "heng", dir, owner: "Zhou", launchAgents: agents });
  const cfg = JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")) as { lang: string; modules: Record<string, { shed?: boolean }>; memory: { promptFolds: Array<{ say: string }> }; outbound?: unknown };
  assert.equal(cfg.lang, "en");
  assert.equal(cfg.modules["load-guard"]!.shed, false);
  assert.match(said, /load-guard only watches/);
  assert.ok(cfg.memory.promptFolds.length > 0 && cfg.memory.promptFolds.every((f) => !/[\u4e00-\u9fff]/.test(f.say)), "English folds");
  assert.equal(cfg.outbound, undefined);
  assert.match(readFileSync(join(dir, "workspace", "AGENTS.md"), "utf8"), /^# How I work[\s\S]*ask Zhou first/, "English starter files");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "workspace", "memory/people/registry.json"), "utf8")), { zhou: { name: "Zhou", privacy: "owner" } }, "a plain-word owner name is the key");
});

test("hh new --persona: a ready-made persona's files replace the starter ones, with the role's name and its owner filled in; the rest stays the starter", async () => {
  const root = tmpDir("hh-new-"), agents = join(root, "LaunchAgents");
  mkdirSync(agents);
  const made = async (id: string, extra: { me?: string; lang?: string }) => {
    const dir = join(root, id);
    const said = await newRole({ id, dir, owner: "老林", persona: "jarvis", launchAgents: agents, ...extra });
    const read = (f: string) => readFileSync(join(dir, "workspace", f), "utf8");
    return { said, read, me: (JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")) as { names: { me: string } }).names.me };
  };
  // the persona's own name in the role's language when --me gives none
  const zh = await made("j", { lang: "zh" });
  assert.equal(zh.me, "贾维斯");
  assert.match(zh.read("IDENTITY.md"), /我叫贾维斯，是老林的助手/);
  assert.match(zh.said, /IDENTITY\.md, SOUL\.md from the ready-made persona jarvis/);
  for (const f of ["IDENTITY.md", "SOUL.md"]) assert.ok(!/\{\{/.test(zh.read(f)), `${f}: nothing left to fill in`);
  assert.equal(zh.read("soul/10-soul.md"), zh.read("SOUL.md"), "the night builds SOUL.md from soul/: the persona starts there too");
  // what the persona does not bring stays the starter: the working rules still say what to ask the owner about first
  assert.ok(zh.read("AGENTS.md").includes("先问老林") && zh.read("USER.md").includes("老林"));
  const en = await made("j-en", { lang: "en" });
  assert.equal(en.me, "Jarvis");
  assert.match(en.read("IDENTITY.md"), /My name is Jarvis\. I am 老林's assistant/);
  // --me wins over the persona's name
  const named = await made("j-named", { me: "阿维", lang: "zh" });
  assert.equal(named.me, "阿维");
  assert.match(named.read("IDENTITY.md"), /我叫阿维/);
  // an unknown persona, or one not written in the role's language, stops before anything is written
  await assert.rejects(newRole({ id: "k", dir: join(root, "k"), owner: "老林", persona: "nobody", launchAgents: agents }), /no persona "nobody"/);
  await assert.rejects(newRole({ id: "k", dir: join(root, "k"), owner: "老林", persona: "../x", launchAgents: agents }), /--persona is a name/);
  assert.ok(!existsSync(join(root, "k")));
});
