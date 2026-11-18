#!/usr/bin/env node
// npx human-harness [./setup's flags]: HH from npm. Node runs no TypeScript from inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), and npx keeps a package in a cache that can be cleared under the roles
// running from it. So this copies the package to a folder of its own, ~/.local/share/human-harness, and runs its
// ./setup there: the clone's setup, wizard and all, whose npm ci installs the packages the lockfile names.
// Why the published package.json names no dependencies: npx would install them into its own cache before running this
// (about 330 MB, most of it the Claude Code binary the Agent SDK brings), and setup's npm ci would then install them
// again. The real manifest and lock travel as package.hh.json and package-lock.hh.json (ops/npm-package.mjs makes the
// package so); here they get their names back, and the folder is exactly a clone's.
// Run again, it copies nothing over an HH already there (the roles made with it run from it): it says so, and runs that
// one's setup, for another role. Updating it is not this command's.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const from = join(dirname(fileURLToPath(import.meta.url)), "..");
const to = join(homedir(), ".local", "share", "human-harness");
const args = process.argv.slice(2);

// in one language, as ./setup picks it: --lang's, else the terminal's, else both
const flag = args[args.indexOf("--lang") + 1];
const pick = args.includes("--lang") ? flag : /^zh/.test(process.env.LC_ALL || process.env.LANG || "") ? "zh" : /^en/.test(process.env.LC_ALL || process.env.LANG || "") ? "en" : "";
const say = (en, zh) => console.log(pick === "en" ? en : pick === "zh" ? zh : `${en}\n${zh}`);
const versionOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version; } catch { return null; } };

const mine = versionOf(from), there = versionOf(to);
if (there) {
  say(there === mine ? `HH ${there} is already in ${to}: running its setup, for another role.` : `HH ${there} is already in ${to}; this is ${mine}, and npx does not update an HH that is there. Running the setup of the one there, for another role.`,
    there === mine ? `HH ${there} 已经装在 ${to}：跑它的 setup，再建一个角色。` : `HH ${there} 已经装在 ${to}；这次的是 ${mine}，npx 不更新已经装好的 HH。跑装好的那个的 setup，再建一个角色。`);
} else if (existsSync(to)) {
  say(`${to} is there but holds no HH (no package.json): move it away, then run this again.`, `${to} 已经存在，但里面不是 HH（没有 package.json）：先把它挪走，再跑一次。`);
  process.exit(1);
} else {
  // copied next to it and then renamed: a copy cut short leaves no half an HH where the next run would take it for one
  const part = join(dirname(to), `.${basename(to)}-${process.pid}`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    cpSync(from, part, { recursive: true, filter: (src) => basename(src) !== "node_modules" });
    renameSync(join(part, "package.hh.json"), join(part, "package.json"));
    renameSync(join(part, "package-lock.hh.json"), join(part, "package-lock.json"));
    renameSync(part, to);
  } catch (e) { rmSync(part, { recursive: true, force: true }); throw e; }
  say(`HH ${mine} is in ${to}. Running its setup.`, `HH ${mine} 放在了 ${to}。接着跑它的 setup。`);
}
// what npx added for running this package: its node_modules/.bin folders and npm's node-gyp-bin on PATH, and the
// variables of this one run. Left in, setup would put the role's short command in one of those folders and write that
// PATH into the role's jobs. The owner's own npm settings (npm_config_*: a registry, a proxy) stay for setup's npm ci.
const RUN = /^(npm_lifecycle_|npm_package_|npm_command$|npm_execpath$|npm_node_execpath$|npm_config_package$|npm_config_yes$|INIT_CWD$|NODE$|COLOR$)/;
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !RUN.test(k)));
env.PATH = (process.env.PATH ?? "").split(":").filter((d) => !/\/node_modules\/\.bin\/?$|\/node-gyp-bin\/?$/.test(d)).join(":");
const r = spawnSync(join(to, "setup"), args, { stdio: "inherit", env });
process.exit(r.status ?? 1);
