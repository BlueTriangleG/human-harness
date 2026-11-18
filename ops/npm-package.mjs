#!/usr/bin/env node
// node ops/npm-package.mjs <dir>: turn a clean copy of the tree (the public snapshot's) into what `npm pack` makes HH's
// npm package from. Run by the snapshot's last step, in its copy, right before npm pack.
//
// The published package.json names no dependencies. npx installs a package's dependencies into its own cache before it
// runs the package, and HH's are about 330 MB (most of it the Claude Code binary the Agent SDK brings), which setup's
// npm ci then installs again in ~/.local/share/human-harness. So the real manifest and lock travel as package.hh.json
// and package-lock.hh.json (npm would leave a package-lock.json out of a package anyway), npx fetches HH alone, and
// bin/npx.mjs gives the two files their names back in the folder it copies HH to, which is then exactly a clone's.
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) { console.error("usage: node ops/npm-package.mjs <dir>"); process.exit(2); }
const real = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
renameSync(join(dir, "package.json"), join(dir, "package.hh.json"));
renameSync(join(dir, "package-lock.json"), join(dir, "package-lock.hh.json"));
const pick = (keys) => Object.fromEntries(keys.filter((k) => real[k] !== undefined).map((k) => [k, real[k]]));
// what npx needs to run bin/npx.mjs, which runs on any Node from 18 (setup brings Node 24 when the computer's is older)
writeFileSync(join(dir, "package.json"), `${JSON.stringify({
  ...pick(["name", "version", "description", "author", "license", "repository", "bin", "files"]),
  engines: { node: ">=18" },
}, null, 2)}\n`);
