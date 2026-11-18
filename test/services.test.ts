// The Linux service manager, against a stand-in systemctl: the unit files it writes and what it asks systemd.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installJobs, jobsAs } from "../src/services/index.ts";
import { systemd } from "../src/services/systemd.ts";
import { openUrl } from "../src/services/desktop.ts";
import { launchd } from "../src/services/launchd.ts";
import { tmpDir } from "./tmp.ts";

test("systemd: a timer is a oneshot unit and its .timer, a service a unit systemd restarts; hhd's and the console's units are filled in", async () => {
  const dir = tmpDir("hh-units-");
  const asked: string[] = [];
  const svc = systemd({ dir, systemctl: async (a) => { asked.push(a.join(" ")); return { code: a[0] === "is-active" ? 3 : 0, stderr: "" }; } });
  const timer = svc.timerJob("ai.hh.aqing.owl.night", ["/n/node", "/code/src/cli.ts", "modules", "timer", "owl", "night"], 90_000, { HH_CONFIG: "/r/a b.json", PATH: "/usr/bin:$HOME/bin" }, "/r/logs/100%.log");
  const service = svc.serviceJob("ai.hh.aqing.bridge.qqbot", ["/n/node", "/code/bridge/qq/main.ts", "qqbot"], { HH_CONFIG: "/r/instance.json" }, "/r/logs/q.log", "/code");
  const [hhd, consoleJob] = svc.kernelJobs({ hhd: "ai.hh.aqing.hhd", console: "ai.hh.aqing.console" }, { NODE: "/n/node", CODE: "/code", HH_CONFIG: "/r/instance.json", HOME: "/home/aqing", PATH: "/usr/bin", LOG_DIR: "/r/logs" });
  assert.deepEqual(await installJobs([timer, service, hhd!], svc), ["installed", "installed", "installed"].map((state, i) => ({ label: [timer, service, hhd!][i]!.label, state })));
  assert.equal(readFileSync(join(dir, "ai.hh.aqing.owl.night.service"), "utf8"), `[Unit]
Description=ai.hh.aqing.owl.night

[Service]
Type=oneshot
ExecStart="/n/node" "/code/src/cli.ts" "modules" "timer" "owl" "night"
Environment="HH_CONFIG=/r/a b.json"
Environment="PATH=/usr/bin:$$HOME/bin"
StandardOutput=append:/r/logs/100%%.log
StandardError=append:/r/logs/100%%.log
`);
  assert.equal(readFileSync(join(dir, "ai.hh.aqing.owl.night.timer"), "utf8"), "[Unit]\nDescription=ai.hh.aqing.owl.night\n\n[Timer]\nOnActiveSec=0\nOnUnitActiveSec=90s\n\n[Install]\nWantedBy=timers.target\n");
  assert.match(readFileSync(join(dir, "ai.hh.aqing.bridge.qqbot.service"), "utf8"), /^WorkingDirectory=\/code\n[^]*Restart=always\nRestartSec=30\n\n\[Install\]\nWantedBy=default\.target\n$/m);
  assert.match(readFileSync(join(dir, "ai.hh.aqing.hhd.service"), "utf8"), /^ExecStart="\/n\/node" "\/code\/src\/hhd\.ts"\n[^]*^StandardError=append:\/r\/logs\/hhd\.err$/m);
  assert.deepEqual(asked, [
    "daemon-reload", "enable --now ai.hh.aqing.owl.night.timer",
    "is-active --quiet ai.hh.aqing.bridge.qqbot.service", "daemon-reload", "enable --now ai.hh.aqing.bridge.qqbot.service",
    "daemon-reload", "enable --now ai.hh.aqing.hhd.service",
  ]);
  assert.deepEqual(consoleJob!.unfilled, ["CONSOLE_PORT"]);
  assert.match(consoleJob!.files["ai.hh.aqing.console.service"]!, /^Environment="HH_CONSOLE_PORT=\{\{CONSOLE_PORT\}\}"$/m);
  asked.length = 0;
  await svc.stop("ai.hh.aqing.bridge.qqbot");
  assert.deepEqual(asked, ["disable --now ai.hh.aqing.bridge.qqbot.service"]);
});

test("launchd: the role's app's path is safe only when root or the user owns every part and nobody else can write it", async () => {
  const { unsafePath } = await import("../src/services/launchd.ts");
  const { chmodSync, mkdirSync, realpathSync } = await import("node:fs");
  const uid = process.getuid!();
  const root = realpathSync(tmpDir("hh-app-path-"));
  const app = join(root, "role", "Role.app");
  mkdirSync(app, { recursive: true });
  assert.equal(unsafePath(app, uid), null);
  assert.equal(unsafePath(join(app, "not", "built", "yet"), uid), null, "parts that are not there yet are not counted");
  assert.equal(unsafePath(app, uid + 1), join(root, "role", "Role.app"), "owned by a user other than the one the jobs run as");
  chmodSync(join(root, "role"), 0o1777);
  assert.equal(unsafePath(app, uid), null, "a sticky directory may be writable by all: only an entry's owner can move it");
  chmodSync(join(root, "role"), 0o775);
  assert.equal(unsafePath(app, uid), join(root, "role"));
  chmodSync(join(root, "role"), 0o755);
});

test("app: role.json's console port is the config's, else the one the role's console job starts it with; the job read as that user (jobsAs) is the same", { skip: process.platform !== "darwin" }, async () => {
  const { consolePort } = await import("../src/services/app.ts");
  const { writeFileSync } = await import("node:fs");
  const home = tmpDir("hh-agents-"), agents = join(home, "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "ai.hh.console.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>ai.hh.console</string>
<key>EnvironmentVariables</key><dict><key>HH_CONSOLE_PORT</key><string>7790</string></dict></dict></plist>
`);
  const svc = launchd({ dir: agents, uid: 501, launchctl: async () => ({ code: 0, stderr: "" }) });
  assert.equal(await consolePort({ launchd: { consolePort: 7801 } }, svc), 7801);
  assert.equal(await consolePort({}, svc), 7790, "a role whose config has no port (its labels the default ones)");
  assert.equal(await consolePort({ launchd: { console: "ai.hh.other.console" } }, svc), undefined, "no such job");
  // the same job read as that user (jobsAs: its own sh and plutil)
  const as = async (cmd: readonly string[]) => ({ code: 0, stdout: execFileSync(cmd[0]!, cmd.slice(1), { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" }), stderr: "" });
  assert.deepEqual(await jobsAs(as, "darwin"), await svc.list(""));
});

test("openUrl: macOS's open; on Linux xdg-open only where there is a desktop (DISPLAY or WAYLAND_DISPLAY) and xdg-open on PATH, otherwise not opened; a failing opener says why", async () => {
  const ran: string[] = [];
  const run = (code: number, stderr = "") => async (cmd: string, args: readonly string[]) => { ran.push([cmd, ...args].join(" ")); return { code, stdout: "", stderr }; };
  const bin = tmpDir("hh-xdg-");
  writeFileSync(join(bin, "xdg-open"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(await openUrl("http://x/", { platform: "darwin", env: {}, run: run(0) }), true);
  assert.equal(await openUrl("http://x/", { platform: "linux", env: { PATH: bin }, run: run(0) }), false, "no desktop");
  assert.equal(await openUrl("http://x/", { platform: "linux", env: { DISPLAY: ":0", PATH: "/nowhere" }, run: run(0) }), false, "no xdg-open");
  assert.equal(await openUrl("http://x/", { platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0", PATH: bin }, run: run(0) }), true);
  assert.deepEqual(ran, ["/usr/bin/open http://x/", "xdg-open http://x/"]);
  await assert.rejects(openUrl("http://x/", { platform: "linux", env: { DISPLAY: ":0", PATH: bin }, run: run(4) }), { message: "xdg-open: exit 4" });
  await assert.rejects(openUrl("http://x/", { platform: "darwin", env: {}, run: run(1, "LSOpenURLsWithRole() failed") }), { message: "LSOpenURLsWithRole() failed" });
});

test("systemd list: what it reads back from the units is what was written — the program, the environment (quotes, $, % and spaces too), a timer beside its service; read as that user (jobsAs, a real sh), the same", async () => {
  const home = tmpDir("hh-units-"), dir = join(home, ".config", "systemd", "user");
  mkdirSync(dir, { recursive: true });
  const svc = systemd({ dir, systemctl: async () => ({ code: 0, stderr: "" }) });
  const env = { HH_CONFIG: "/r/it's \"mine\"/instance.json", ODD: "50% of $HOME and a \\ too" };
  const jobs = [svc.serviceJob("ai.hh.t.bridge.qq", ["/n/node", "/code with space/bridge/qq/main.ts", "--x=$1"], env, "/l/b.log", "/code"),
    svc.timerJob("ai.hh.t.load-guard.guard", ["/bin/sh", "-c", "exec \"$0\""], 60_000, { HH_TZ: "UTC" }, "/l/g.log")];
  for (const j of jobs) for (const [f, text] of Object.entries(j.files)) writeFileSync(join(dir, f), text);
  const got = await svc.list("ai.hh.t.");
  assert.deepEqual(got.map((j) => [j.label, j.files.length, j.program, j.env]), [
    ["ai.hh.t.bridge.qq", 1, ["/n/node", "/code with space/bridge/qq/main.ts", "--x=$1"], env],
    ["ai.hh.t.load-guard.guard", 2, ["/bin/sh", "-c", "exec \"$0\""], { HH_TZ: "UTC" }],
  ]);
  assert.deepEqual(await svc.list("ai.hh.other."), []);
  const as = async (cmd: readonly string[]) => ({ code: 0, stdout: execFileSync(cmd[0]!, cmd.slice(1), { env: { HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" }), stderr: "" });
  assert.deepEqual(await jobsAs(as, "linux"), await svc.list(""));
});
