import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileName, newRole, ROLE_MARK } from "../src/new.ts";
import { firstRunConfig, idFrom, loginLine, namesComputer } from "../src/setup.ts";
import { claudeLogIn, loginOf, withoutTerminal } from "../src/claude-login.ts";
import { removeCommand, type RemoveDeps } from "../src/remove.ts";
import { consoleUsageCache } from "../src/config.ts";
import { commandRecord, MARK } from "../src/console/command.ts";
import { placeOwnCommand } from "../src/console/open.ts";
import { launchd } from "../src/services/launchd.ts";
import { systemd } from "../src/services/systemd.ts";
import { B, setLang } from "../src/lang/index.ts";
import { tmpDir } from "./tmp.ts";

test("setup: an id from the role's name, or none when the name has no Latin letters", () => {
  assert.equal(idFrom("Aria"), "aria");
  assert.equal(idFrom("My Role 2"), "my-role-2");
  assert.equal(idFrom("2nd Try"), "nd-try");
  assert.equal(idFrom("小禾"), "");
});

test("setup: the Claude login is the kind auth status names, asked without what only a terminal carries; none stops setup", () => {
  // auth status's keys as Claude Code 2.1.327 prints them; the values made up
  const status = (o: Record<string, unknown>) => JSON.stringify({ apiProvider: "firstParty", email: "someone@example.com", orgId: "x", ...o });
  assert.deepEqual(loginOf(status({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" })), { kind: "subscription", plan: "Max" });
  assert.deepEqual(loginOf(status({ loggedIn: true, authMethod: "api_key", apiKeySource: "/login managed key" })), { kind: "console" });
  assert.deepEqual(loginOf(status({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" })), { kind: "other", method: "third_party, bedrock" });
  assert.deepEqual(loginOf(status({ loggedIn: false, authMethod: "none" })), { kind: "none" });
  assert.deepEqual(loginOf("Not logged in"), { kind: "none" });
  assert.deepEqual(loginOf("error: unknown command 'auth'\nUsage: claude"), { kind: "unknown", said: "error: unknown command 'auth'" }, "a Claude Code without auth status: not known, not taken for no login");
  assert.deepEqual(loginOf("", "spawn claude ENOENT"), { kind: "unknown", said: "spawn claude ENOENT" });
  assert.deepEqual(Object.keys(withoutTerminal({ PATH: "/bin", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_OAUTH_TOKEN: "o", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", CLAUDECODE: "1", ANTHROPIC_MODEL: "m" })), ["PATH", "ANTHROPIC_MODEL"]);
  setLang("en");
  assert.match(loginLine({ kind: "subscription", plan: "Max" }), /Claude subscription \(Max\), the default.*\/login/);
  assert.match(loginLine({ kind: "console" }), /Anthropic Console account/);
  assert.match(loginLine({ kind: "unknown", said: "error: unknown command 'auth'" }), /could not be read.*unknown command 'auth'.*claude update/);
  assert.throws(() => loginLine({ kind: "none" }), { message: B.setup.loginNone });
});

test("setup: Claude Code's own sign-in is run as it is, without a token from the terminal, and its exit code is the answer", async () => {
  const dir = tmpDir("hh-login-"), exe = join(dir, "claude"), out = join(dir, "ran");
  writeFileSync(exe, `#!/bin/sh\necho "$* token=$ANTHROPIC_API_KEY$CLAUDE_CODE_OAUTH_TOKEN" > "${out}"\nexit 3\n`, { mode: 0o755 });
  const was = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-terminal";
  try {
    assert.equal(await claudeLogIn("console", { tty: false, exe }), 3);
  } finally { if (was === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = was; }
  assert.equal(readFileSync(out, "utf8").trim(), "auth login --console token=");
  assert.equal(await claudeLogIn("claudeai", { tty: false, exe: join(dir, "nowhere") }), 127);
});

test("setup: a first run's config has only the modules that need nothing set up, every tier on the model asked for, and no app without the tools", async () => {
  const dir = join(tmpDir("hh-setup-"), "trial");
  await newRole({ id: "trial", dir, owner: "Ada", me: "试试", lang: "zh", launchAgents: tmpDir("hh-agents-") });
  const file = join(dir, "instance.json");
  const off = await firstRunConfig(file, { lang: "zh", model: "sonnet", app: false, onPath: (bin) => bin !== "ffmpeg" });
  const c = JSON.parse(readFileSync(file, "utf8")) as { modules: Record<string, { enabled: boolean }>; models: Record<string, string>; launchd: { app?: string } };
  for (const m of ["qq", "whatsapp", "phone", "backup", "media", "bilibili", "stickers"]) assert.ok(off.includes(m) && !c.modules[m]!.enabled, m);
  for (const m of ["goals", "helpers", "base", "watchdog"]) assert.ok(!off.includes(m) && c.modules[m]!.enabled, m);
  assert.equal(c.models.opus, "claude-sonnet-5-5", "the opus tier runs on sonnet");
  assert.equal(c.models.sonnet, undefined, "the tiers below stay as they are");
  assert.equal(c.launchd.app, undefined);
});

/** a Claude Code session record of a session that ran in `cwd`, where Claude Code keeps it */
function session(home: string, cwd: string): string {
  const folder = join(home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "s.jsonl"), `${JSON.stringify({ type: "user", cwd, message: "…" })}\n`);
  return folder;
}

/** a role as hh new and install leave it, in a home of its own: its config, its app, two jobs, its short command, a token */
function role(home: string): { config: string; app: string; agents: string } {
  const dir = join(home, "HH", "trial"), app = join(home, "Applications", "HH", "trial", "试试.app"), agents = join(home, "Library", "LaunchAgents");
  for (const d of [join(dir, "workspace"), join(dir, "state", "app"), join(app, "Contents"), agents, join(home, ".local", "bin"), join(home, "tokens"), join(home, "Library", "Preferences")]) mkdirSync(d, { recursive: true });
  session(home, join(dir, "workspace"));
  const config = join(dir, "instance.json");
  writeFileSync(config, JSON.stringify({ id: "trial", workspace: join(dir, "workspace"), stateDir: join(dir, "state"), launchd: { app } }));
  writeFileSync(join(dir, ROLE_MARK), "trial\n");
  writeFileSync(join(dir, "state", "app", "signing.keychain-db"), "");
  for (const label of ["ai.hh.trial.hhd", "ai.hh.trial.console"]) {
    writeFileSync(join(agents, `${label}.plist`), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>${config}</string></dict></dict></plist>
`);
  }
  writeFileSync(join(agents, "ai.hh.jarvis.hhd.plist"), "<plist/>");
  writeFileSync(join(home, ".local", "bin", "trial"), `#!/bin/sh\n${MARK} trial: written by HH\n`);
  writeFileSync(join(home, "tokens", "trial.owner"), "x");
  // what its app and console keep outside its folders, and the same of a role whose id starts alike
  for (const b of ["ai.hh.role.trial", "ai.hh.role.trialen"]) {
    for (const d of [join(home, "Library", "WebKit", b), join(home, "Library", "Caches", b), join(home, "tmp", b)]) mkdirSync(d, { recursive: true });
    writeFileSync(join(home, "Library", "Preferences", `${b}.plist`), "");
  }
  writeFileSync(consoleUsageCache(join(dir, "state"), join(home, "tmp")), "{}");
  return { config, app, agents };
}

function deps(home: string, answer: string | null, ran: string[]): RemoveDeps {
  return {
    services: launchd({ dir: join(home, "Library", "LaunchAgents"), uid: process.getuid!(), launchctl: async (args) => { ran.push(["launchctl", ...args].join(" ")); return { code: 0, stderr: "" }; } }),
    home, tokens: join(home, "tokens"),
    run: async (cmd, args) => {
      if (cmd.endsWith("/ps")) return { code: 0, out: "" };
      ran.push([cmd.split("/").pop(), ...args].join(" "));
      return { code: cmd.endsWith("tccutil") ? 1 : 0, out: "" };
    },
    confirm: answer === null ? null : async () => answer,
    settleMs: 0,
    tmp: join(home, "tmp"),
  };
}

test("remove: a role's jobs stopped, its app, directory, short command, token and session records gone, its grants asked to be cleared; another role's job untouched", { skip: process.platform !== "darwin" }, async () => {
  setLang("en");
  const home = tmpDir("hh-remove-");
  const { app, agents } = role(home);
  const ran: string[] = [];
  const out = await removeCommand(["trial"], deps(home, "trial", ran));
  const uid = process.getuid!();
  assert.ok(ran.includes(`launchctl bootout gui/${uid}/ai.hh.trial.hhd`) && ran.includes(`launchctl bootout gui/${uid}/ai.hh.trial.console`) && ran.includes("tccutil reset All ai.hh.role.trial"), ran.join("\n"));
  for (const gone of [join(home, "HH", "trial"), join(home, "Applications", "HH", "trial"), join(agents, "ai.hh.trial.hhd.plist"), join(home, ".local", "bin", "trial"), join(home, "tokens", "trial.owner")]) assert.ok(!existsSync(gone), gone);
  assert.deepEqual((await import("node:fs")).readdirSync(join(home, ".claude", "projects")), [], "its session records");
  assert.ok(existsSync(join(agents, "ai.hh.jarvis.hhd.plist")), "nothing of another role's");
  assert.ok(!existsSync(join(home, "HH")) && !existsSync(join(home, "Applications", "HH")), "the folders setup made, now empty");
  assert.ok(out.includes(B.remove.grantsLeft("ai.hh.role.trial")) && out.endsWith(B.remove.done("trial")), out);
  assert.ok(!existsSync(app));
  const left = (b: string) => [join(home, "Library", "WebKit", b), join(home, "Library", "Caches", b), join(home, "Library", "Preferences", `${b}.plist`), join(home, "tmp", b)].filter(existsSync);
  assert.deepEqual(left("ai.hh.role.trial"), [], "its app's web data, caches and preferences");
  assert.ok(!existsSync(consoleUsageCache(join(home, "HH", "trial", "state"), join(home, "tmp"))), "its console's usage cache");
  assert.equal(left("ai.hh.role.trialen").length, 4, "nothing of a role whose id starts alike");
});

test("remove on Linux: the role's systemd user units — services and timers — disabled, their files gone and systemd reloaded; its config found in a unit's Environment=; another role's units untouched", async () => {
  setLang("en");
  const home = tmpDir("hh-remove-linux-"), units = join(home, ".config", "systemd", "user"), dir = join(home, "HH", "trial");
  for (const d of [units, join(dir, "workspace"), join(dir, "state")]) mkdirSync(d, { recursive: true });
  const config = join(dir, "instance.json");
  writeFileSync(config, JSON.stringify({ id: "trial", workspace: join(dir, "workspace"), stateDir: join(dir, "state") }));
  writeFileSync(join(dir, ROLE_MARK), "trial\n");
  const asked: string[] = [];
  const svc = systemd({ dir: units, systemctl: async (a) => { asked.push(a.join(" ")); return { code: 0, stderr: "" }; } });
  const write = (job: { files: Record<string, string> }) => { for (const [f, text] of Object.entries(job.files)) writeFileSync(join(units, f), text); };
  write(svc.kernelJobs({ hhd: "ai.hh.trial.hhd", console: "ai.hh.trial.console" }, { NODE: "/n/node", CODE: "/code", HH_CONFIG: config, PATH: "/bin", HOME: home, LOG_DIR: join(dir, "state", "logs"), CONSOLE_PORT: "38133" })[0]!);
  write(svc.timerJob("ai.hh.trial.load-guard.guard", ["/bin/sh", "-c", "x"], 60_000, {}, "/l/g.log"));
  write(svc.timerJob("ai.hh.jarvis.load-guard.guard", ["/bin/sh", "-c", "x"], 60_000, {}, "/l/g.log"));
  const out = await removeCommand(["trial", "--yes"], { services: svc, home, tokens: join(home, "tokens"), run: async () => ({ code: 0, out: "" }), confirm: null, settleMs: 0 });
  for (const a of ["disable --now ai.hh.trial.hhd.service", "disable --now ai.hh.trial.load-guard.guard.timer", "disable --now ai.hh.trial.load-guard.guard.service", "daemon-reload", "reset-failed ai.hh.trial.load-guard.guard.timer ai.hh.trial.load-guard.guard.service"]) assert.ok(asked.includes(a), `${a}\n${asked.join("\n")}`);
  assert.ok(asked.indexOf("disable --now ai.hh.trial.load-guard.guard.timer") < asked.indexOf("disable --now ai.hh.trial.load-guard.guard.service"), "the timer first, or it starts its service again");
  assert.deepEqual((await import("node:fs")).readdirSync(units).sort(), ["ai.hh.jarvis.load-guard.guard.service", "ai.hh.jarvis.load-guard.guard.timer"], "only another role's units are left");
  assert.ok(!existsSync(dir) && out.endsWith(B.remove.done("trial")), out);
});

test("remove: nothing goes unless the id is typed again, or --yes is given where nobody can be asked", { skip: process.platform !== "darwin" }, async () => {
  setLang("en");
  const home = tmpDir("hh-remove-");
  const { config } = role(home);
  const ran: string[] = [];
  assert.equal(await removeCommand(["trial"], deps(home, "tria", ran)), B.remove.cancelled);
  await assert.rejects(removeCommand(["trial"], deps(home, null, ran)), (e: Error) => e.message.endsWith(B.remove.needYes));
  assert.ok(existsSync(config) && ran.length === 0, "nothing stopped, nothing removed");
  await assert.rejects(removeCommand(["nobody"], deps(home, "nobody", ran)), { message: B.remove.none("nobody") });
  assert.ok((await removeCommand(["trial", "--yes"], deps(home, null, ran))).endsWith(B.remove.done("trial")));
  assert.ok(!existsSync(config));
});

test("remove: only the session records of sessions that ran in the role's own folders, not a neighbour's whose folder name encodes alike", { skip: process.platform !== "darwin" }, async () => {
  setLang("en");
  const home = tmpDir("hh-remove-");
  role(home);
  // trial-2 is another role; trial-workspace a folder next to trial whose encoded name is that of trial/workspace
  mkdirSync(join(home, "HH", "trial-2", "workspace"), { recursive: true });
  const theirs = session(home, join(home, "HH", "trial-2", "workspace"));
  const lookalike = join(home, ".claude", "projects", join(home, "HH", "trial-workspace").replace(/[^A-Za-z0-9]/g, "-"));
  assert.ok(existsSync(lookalike), "the role's own record sits under the very name a trial-workspace folder would have");
  const ran: string[] = [];
  await removeCommand(["trial", "--yes"], deps(home, null, ran));
  assert.ok(!existsSync(lookalike) && existsSync(theirs), "its own gone, trial-2's left");
  // a folder of that name whose sessions ran in trial-workspace is not the role's
  const other = session(home, join(home, "HH", "trial-workspace"));
  mkdirSync(join(home, "HH", "trial", "workspace"), { recursive: true });
  assert.deepEqual((await import("../src/remove.ts")).sessionsOf(join(home, "HH", "trial"), join(home, ".claude", "projects")), []);
  assert.ok(existsSync(other));
});

test("remove: a directory without its mark, or with another id in it, is listed and left, and the output says why", { skip: process.platform !== "darwin" }, async () => {
  setLang("en");
  for (const mark of [null, "other\n"]) {
    const home = tmpDir("hh-remove-");
    const { config } = role(home);
    const dir = join(home, "HH", "trial");
    if (mark === null) (await import("node:fs")).unlinkSync(join(dir, ROLE_MARK)); else writeFileSync(join(dir, ROLE_MARK), mark);
    const out = await removeCommand(["trial", "--yes"], deps(home, null, []));
    assert.ok(existsSync(config) && existsSync(join(dir, "workspace")), "the directory stays");
    assert.ok(out.includes(B.remove.notMarked(dir, "trial")), out);
  }
});

test("setup's short command: where it was put is kept in the role's state directory", () => {
  const home = tmpDir("hh-cmd-"), state = join(home, "state");
  mkdirSync(state);
  const was = process.env.HH_CONFIG;
  process.env.HH_CONFIG = join(home, "instance.json");
  try {
    placeOwnCommand({ id: "trial", stateDir: state, tools: { node: "/usr/bin/node" } } as never, { PATH: "/usr/bin", HOME: home });
  } finally { if (was === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = was; }
  assert.deepEqual(JSON.parse(readFileSync(commandRecord(state), "utf8")), { file: join(home, ".local", "bin", "trial") });
});

test("remove: the short command goes from where setup recorded it; a marked one elsewhere on PATH, not recorded, stays", { skip: process.platform !== "darwin" }, async () => {
  setLang("en");
  const home = tmpDir("hh-remove-");
  role(home);
  const text = `#!/bin/sh\n${MARK} trial: written by HH\n`;
  const put = join(home, "npx-bin"), other = join(home, "other-bin");
  for (const d of [put, other]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, "trial"), text); }
  writeFileSync(commandRecord(join(home, "HH", "trial", "state")), JSON.stringify({ file: join(put, "trial") }));
  const path = process.env.PATH;
  process.env.PATH = `${other}:${path}`;
  try { await removeCommand(["trial", "--yes"], deps(home, null, [])); } finally { process.env.PATH = path; }
  assert.ok(!existsSync(join(put, "trial")), "where it was put, though that is not on PATH now");
  assert.ok(existsSync(join(other, "trial")), "PATH is not searched");
});

test("new: a name becomes a file name without path separators, control characters or a leading dot", () => {
  assert.equal(fileName("a/b"), "a-b");
  assert.equal(fileName("../x"), "-x");
  assert.equal(fileName(".hidden"), "hidden");
  assert.equal(fileName("x\u0007y"), "x-y");
  assert.equal(fileName(""), "role");
  assert.equal(fileName("小禾"), "小禾");
});

test("new: what the wizard adds — pronouns, who the owner is to it, its persona, its picture, modules off — and its mark", async () => {
  const dir = join(tmpDir("hh-new-"), "aria");
  const pic = join(tmpDir("hh-pic-"), "me.PNG");
  writeFileSync(pic, "png");
  await newRole({ id: "aria", dir, owner: "Sam", me: "Ar/ia", lang: "en", launchAgents: tmpDir("hh-agents-"), pronouns: "she/her", relation: "a friend", files: { "SOUL.md": "# My nature\n\nCurious.", "NOTES.md": "not one of the five" }, avatar: pic, modules: { goals: false }, timezone: "Europe/Paris" });
  const ws = join(dir, "workspace");
  assert.ok(readFileSync(join(ws, "IDENTITY.md"), "utf8").includes(B.newRole.pronouns("she/her").trim()));
  assert.ok(readFileSync(join(ws, "USER.md"), "utf8").includes(B.newRole.relation("Sam", "a friend").trim()));
  assert.equal(readFileSync(join(ws, "SOUL.md"), "utf8"), "# My nature\n\nCurious.\n");
  assert.ok(!existsSync(join(ws, "NOTES.md")), "only the five persona files");
  const c = JSON.parse(readFileSync(join(dir, "instance.json"), "utf8")) as { avatar: string; modules: Record<string, { enabled: boolean }>; launchd: { app?: string }; schedule: { timezone: string } };
  assert.equal(c.schedule.timezone, "Europe/Paris");
  assert.equal(c.avatar, join(dir, "avatar.png"));
  assert.equal(readFileSync(c.avatar, "utf8"), "png");
  assert.equal(c.modules.goals!.enabled, false);
  if (c.launchd.app) assert.equal(c.launchd.app.split("/").pop(), "Ar-ia.app");
  assert.equal(readFileSync(join(dir, ROLE_MARK), "utf8"), "aria\n");
  await assert.rejects(newRole({ id: "bad", dir: join(tmpDir("hh-new-"), "bad"), owner: "Sam", lang: "en", avatar: "/tmp/x.gif" }), /PNG or JPEG/);
});

test("setup: an account's full name that names the computer is not offered as what to call its owner", () => {
  for (const n of ["Sam's MacBook Pro", "Sam的macbook", "iMac", "Mac mini", "Sam's Mac"]) assert.ok(namesComputer(n), n);
  for (const n of ["Sam Lee", "Mack Lee", "Macy", "Tomas"]) assert.ok(!namesComputer(n), n);
});
