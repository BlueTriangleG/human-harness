#!/usr/bin/env node
// npx human-harness [./setup's flags]: HH from npm. Node runs no TypeScript from inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and npx keeps a package in a cache that can be cleared under the roles
// running from it. So this copies the package to a folder of its own, ~/.local/share/human-harness, and runs its
// ./setup there: the clone's setup, wizard and all, whose npm ci installs the packages the lockfile names.
// Why the published package.json names no dependencies: npx would install them into its own cache before running this
// (about 330 MB, most of it the Claude Code binary the Agent SDK brings), and setup's npm ci would then install them
// again. The real manifest and lock travel as package.hh.json and package-lock.hh.json (ops/npm-package.mjs makes the
// package so); here they get their names back, and the folder is exactly a clone's.
//
// Run again, the same command:
// - an older HH there: asked, it is upgraded. The new copy is made ready beside it (./setup --prepare: its Node, its
//   packages) and tried (hh setup --help) before anything there is touched; then the two folders are swapped, the old
//   one kept as human-harness.previous. The roles running from it keep their data (~/HH/<id>): their console and the
//   module services restart at once on the new code, each role's hhd once it is calm (src/hhd.ts sees the version change).
// - --rollback: the kept one goes back in place the same way.
// - the same version (or a newer one) there: it says so, and runs that one's setup, for another role.
// Every swap is journaled (human-harness.swap.json, a rename at a time): one cut short is undone by the next run, so no
// half an HH is ever in place, and the copy made beside it by a run that died is cleared.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const from = join(dirname(fileURLToPath(import.meta.url)), "..");
// HH_INSTALL_DIR: another folder for it (a second HH beside the usual one)
const to = process.env.HH_INSTALL_DIR || join(homedir(), ".local", "share", "human-harness");
const PREV = `${to}.previous`, JOURNAL = `${to}.swap.json`;
const argv = process.argv.slice(2);
const rollback = argv.includes("--rollback");
const args = argv.filter((a) => a !== "--rollback");

// in one language, as ./setup picks it: --lang's, else the terminal's, else both
const flag = args[args.indexOf("--lang") + 1];
const pick = args.includes("--lang") ? flag : /^zh/.test(process.env.LC_ALL || process.env.LANG || "") ? "zh" : /^en/.test(process.env.LC_ALL || process.env.LANG || "") ? "en" : "";
const say = (en, zh) => console.log(pick === "en" ? en : pick === "zh" ? zh : `${en}\n${zh}`);

// the Node this runs on (18 or newer) is checked before this file is loaded, by bin/human-harness.mjs: on an older one
// this file does not even parse; setup brings Node 24 for HH itself

const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch { return null; } };
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
/** a yes to a question: Enter or y; --yes answers yes; with nobody at the terminal the answer is no */
async function ask(en, zh) {
  if (args.includes("--yes")) { say(`${en} yes (--yes)`, `${zh} 是（--yes）`); return true; }
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^(|y|yes|是|好)$/i.test((await rl.question(`${pick === "en" ? en : pick === "zh" ? zh : `${en}\n${zh}`} [Y/n] `)).trim()); } finally { rl.close(); }
}

// renames done one at a time, each written down first: a swap cut short anywhere is undone by the next run
function swap(steps) {
  writeFileSync(JOURNAL, `${JSON.stringify({ steps, done: 0 })}\n`);
  steps.forEach(([a, b], i) => { renameSync(a, b); writeFileSync(JOURNAL, `${JSON.stringify({ steps, done: i + 1 })}\n`); });
  rmSync(JOURNAL, { force: true });
}
function recover() {
  if (!existsSync(JOURNAL)) return;
  let j; try { j = JSON.parse(readFileSync(JOURNAL, "utf8")); } catch { rmSync(JOURNAL, { force: true }); return; }
  // the step after the last one written down may have happened too: undone as well when its source is gone and its target there
  const last = j.steps[j.done];
  const undo = j.steps.slice(0, j.done + (last && !existsSync(last[0]) && existsSync(last[1]) ? 1 : 0)).reverse();
  for (const [a, b] of undo) if (!existsSync(a) && existsSync(b)) renameSync(b, a);
  rmSync(JOURNAL, { force: true });
  say(`A swap of HH's code was cut short: undone, HH ${versionOf(to) ?? ""} is as it was.`, `上次换 HH 的代码没换完：已退回，HH ${versionOf(to) ?? ""} 照原样。`);
}
/** a copy beside it that a run left when it died */
function clearStale() {
  if (!existsSync(dirname(to))) return;
  for (const n of readdirSync(dirname(to))) {
    const m = new RegExp(`^\\.${basename(to)}-(\\d+)$`).exec(n);
    if (m && !alive(Number(m[1]))) rmSync(join(dirname(to), n), { recursive: true, force: true });
  }
}
/** the package copied beside it, the manifest and lock under their names; HH's own Node taken along when there is one */
function stage() {
  const part = join(dirname(to), `.${basename(to)}-${process.pid}`);
  mkdirSync(dirname(to), { recursive: true });
  const drop = () => rmSync(part, { recursive: true, force: true });
  for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(s, () => { drop(); process.exit(130); });
  try {
    cpSync(from, part, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    renameSync(join(part, "package.hh.json"), join(part, "package.json"));
    renameSync(join(part, "package-lock.hh.json"), join(part, "package-lock.json"));
    if (existsSync(join(to, "node"))) cpSync(join(to, "node"), join(part, "node"), { recursive: true, verbatimSymlinks: true });
  } catch (e) { drop(); throw e; }
  return { part, drop };
}

// what npx added for running this package: its node_modules/.bin folders and npm's node-gyp-bin on PATH, and the
// variables of this one run. Left in, setup would put the role's short command in one of those folders and write that
// PATH into the role's jobs. The owner's own npm settings (npm_config_*: a registry, a proxy) stay for setup's npm ci.
const RUN = /^(npm_lifecycle_|npm_package_|npm_command$|npm_execpath$|npm_node_execpath$|npm_config_package$|npm_config_yes$|INIT_CWD$|NODE$|COLOR$)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !RUN.test(k)));
env.PATH = (process.env.PATH ?? "").split(":").filter((d) => !/\/node_modules\/\.bin\/?$|\/node-gyp-bin\/?$/.test(d)).join(":");
// what setup tells the person to run to start over: this, not a ./setup in a folder they never saw
env.HH_SETUP_AGAIN = "npx human-harness";
const setup =(dir, a) => spawnSync(join(dir, "setup"), a, { stdio: "inherit", env }).status ?? 1;

/** the roles' jobs that run from the code here (launchd): their labels, whether each is kept alive, the role's config */
function jobsHere() {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (process.platform !== "darwin" || !existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^ai\.hh\..+\.plist$/.test(f)).flatMap((f) => {
    try {
      const p = JSON.parse(execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(dir, f)], { encoding: "utf8" }));
      const prog = [...(p.ProgramArguments ?? []), p.WorkingDirectory ?? ""];
      return prog.some((x) => String(x).startsWith(`${to}/`) || x === to) ? [{ label: p.Label, keep: p.KeepAlive === true, config: p.EnvironmentVariables?.HH_CONFIG }] : [];
    } catch { return []; }
  });
}
/** after a swap: the console and module services (kept alive) restart at once; each hhd once its role is calm */
function restartAround() {
  const jobs = jobsHere(), uid = process.getuid();
  for (const j of jobs.filter((x) => x.keep && !x.label.endsWith(".hhd"))) {
    const pid = (spawnSync("/bin/launchctl", ["list", j.label], { encoding: "utf8" }).stdout.match(/"PID" = (\d+);/) ?? [])[1];
    say(`restarting ${j.label}${pid ? ` (pid ${pid})` : ""} on the new code`, `在新代码上重启 ${j.label}${pid ? `（pid ${pid}）` : ""}`);
    spawnSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${j.label}`], { stdio: "ignore" });
  }
  return jobs.filter((x) => x.label.endsWith(".hhd")).map((x) => ({ id: x.label.replace(/^ai\.hh\./, "").replace(/\.hhd$/, ""), label: x.label, config: x.config }));
}

/**
 * Each role's hhd restarted on the new code once the role is calm (asleep, turning a page, a region busy, a turn being
 * prepared, a focus period: not calm), checked every 10 s, twice calm in a row, waited for up to 10 minutes. An hhd from
 * 0.1.3 on also does it by itself (src/hhd.ts); one from before has no such check, so here it is done for every role.
 * A role still busy after that: said, with the command that restarts it.
 */
async function restartCalm(roles) {
  const uid = process.getuid(), hh = join(to, "bin", "hh"), until = Date.now() + 10 * 60_000;
  const calm = (config) => {
    const r = spawnSync(hh, ["status"], { encoding: "utf8", env: { ...env, HH_CONFIG: config }, timeout: 20_000 });
    if (r.status !== 0) return "down";
    try {
      const s = JSON.parse(r.stdout);
      return s.alertness !== "asleep" && !s.turning && s.frontIdle !== false && !s.focusSlot && !(s.regions ?? []).some((x) => x.busy) ? "calm" : "busy";
    } catch { return "down"; }
  };
  const left = new Map(roles.map((r) => [r.id, { ...r, calmChecks: 0 }]));
  while (left.size && Date.now() < until) {
    for (const r of [...left.values()]) {
      const c = r.config ? calm(r.config) : "down";
      r.calmChecks = c === "calm" ? r.calmChecks + 1 : 0;
      if (c === "down" || r.calmChecks >= 2) {
        say(`${r.id}: restarting its hhd on the new code${c === "down" ? " (it was not answering)" : " (it is calm)"}`, `${r.id}：在新代码上重启它的 hhd${c === "down" ? "（它没在应答）" : "（它正平静）"}`);
        spawnSync("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/${r.label}`], { stdio: "ignore" });
        left.delete(r.id);
      }
    }
    if (left.size) await new Promise((res) => setTimeout(res, 10_000));
  }
  for (const r of left.values()) say(`${r.id} stayed busy for 10 minutes: it restarts by itself once calm, or now with launchctl kickstart -k gui/${uid}/${r.label}`,
    `${r.id} 忙了 10 分钟：它平静下来会自己重启，或者现在用 launchctl kickstart -k gui/${uid}/${r.label}`);
}

recover();
clearStale();
const mine = versionOf(from), there = versionOf(to);

if (rollback) {
  const back = versionOf(PREV);
  if (!there || !back) { say(`Nothing to roll back to: no earlier HH is kept beside ${to}.`, `没有可以退回的：${to} 旁边没有留着更早的 HH。`); process.exit(1); }
  if (!await ask(`Put HH ${back} back in place of ${there}? The roles keep their data; each restarts once, when it is calm.`, `把 HH ${back} 换回来、替下 ${there}？角色的数据不动；每个角色在平静时重启一次。`)) process.exit(1);
  const aside = `${to}.rollback-${process.pid}`;
  swap([[to, aside], [PREV, to], [aside, PREV]]);
  const roles = restartAround();
  say(`HH ${there} → ${back}: ${back} is back in ${to}; ${there} is kept in ${PREV} (npx human-harness upgrades to it again).`,
    `HH ${there} → ${back}：${back} 已经换回 ${to}；${there} 留在 ${PREV}（再跑 npx human-harness 可以再升上去）。`);
  await restartCalm(roles);
  process.exit(0);
}

let declined = false;
if (there && newer(mine, there)) {
  declined = true;
  if (await ask(`HH ${there} is in ${to}; this is ${mine}. Upgrade it? The roles keep their data (~/HH); each restarts once, when it is calm.`,
    `${to} 里是 HH ${there}；这次的是 ${mine}。升级吗？角色的数据（~/HH）不动；每个角色在平静时重启一次。`)) {
    say(`Upgrading HH ${there} → ${mine}: ${mine} is made ready beside it first; nothing in ${to} is touched until it runs.`, `升级 HH ${there} → ${mine}：先在旁边把 ${mine} 准备好，跑得起来之前不动 ${to}。`);
    const { part, drop } = stage();
    const tried = setup(part, ["--prepare", ...args]) === 0 && spawnSync(join(part, "bin", "hh"), ["setup", "--help"], { stdio: "ignore", env }).status === 0;
    if (!tried) { drop(); say(`Not upgraded: getting ${mine} ready stopped (above). HH ${there} is as it was.`, `没有升级：准备 ${mine} 时停了（见上面）。HH ${there} 照原样。`); process.exit(1); }
    rmSync(PREV, { recursive: true, force: true });   // the one kept from the upgrade before
    swap([[to, PREV], [part, to]]);
    const roles = restartAround();
    say(`HH ${there} → ${mine}: in place in ${to}. ${there} is kept in ${PREV}; npx human-harness --rollback puts it back.`,
      `HH ${there} → ${mine}：已经换到 ${to}。${there} 留在 ${PREV}；npx human-harness --rollback 可以换回去。`);
    await restartCalm(roles);
    process.exit(0);
  }
}

if (there && declined) {
  say(`Not upgraded: HH ${there} stays in ${to}. Running its setup, for another role.`, `没有升级：${to} 里还是 HH ${there}。跑它的 setup，再建一个角色。`);
} else if (there) {
  say(there === mine ? `HH ${there} is already in ${to}: running its setup, for another role.` : `HH ${there} is in ${to}; this is ${mine}, not newer. Running the setup of the one there, for another role.`,
    there === mine ? `HH ${there} 已经装在 ${to}：跑它的 setup，再建一个角色。` : `${to} 里是 HH ${there}；这次的是 ${mine}，不比它新。跑装好的那个的 setup，再建一个角色。`);
} else if (existsSync(to)) {
  say(`${to} is there but holds no HH (no package.json): move it away, then run this again.`, `${to} 已经存在，但里面不是 HH（没有 package.json）：先把它挪走，再跑一次。`);
  process.exit(1);
} else {
  // copied next to it and then renamed: a copy cut short leaves no half an HH where the next run would take it for one
  const { part } = stage();
  renameSync(part, to);
  say(`HH ${mine} is in ${to}. Running its setup.`, `HH ${mine} 放在了 ${to}。接着跑它的 setup。`);
}
process.exit(setup(to, args));
