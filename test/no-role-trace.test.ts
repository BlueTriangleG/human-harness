// HH is a package other people download: what it ships names no particular role. The code and its defaults, the
// modules, the docs, the ops files, the entry and setup scripts and the README are searched for a home directory, a
// working-session name that carries the machine's account, and any number of eleven digits or more (a phone number, an
// account id) — tests use made-up ones of ten digits at most. The framework's own words (src/) also say nothing of which
// sites a role has accounts on: that is the role's to say (browser.logins in its instance config); a module about one
// site (modules/bilibili) may name that site's account.
// It looks for shapes only, never for a name: writing the first role's or its people's names down to look for them would
// put them in the repository. Names are looked for outside it, against the role's list as it is: before a deploy
// (hh-guard), and in the release snapshot's check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TREE = resolve(fileURLToPath(import.meta.url), "../..");
// everything the npm package ships (package.json's files) and the tests; a root a tree lacks (a package has no test/) is skipped.
// LICENSE, NOTICE and package.json's author name the copyright holder on purpose and are not searched
const ROOTS = ["apps", "bin", "bridge", "config", "docs", "modules", "ops", "personas", "src", "README.md", "README.zh-CN.md", "setup", "test"];
const TRACES: Array<[string, RegExp]> = [
  ["a home directory", /\/Users\/(?!Shared\b)[A-Za-z]/],
  ["a number of eleven digits or more", /(?<![0-9A-Za-z_.-])\+?\d{11,}(?![0-9A-Za-z_])/],
];
const SRC_TRACES: Array<[string, RegExp]> = [
  ["a particular role's accounts on named sites", /(B站|小红书|哔哩哔哩|抖音|微博|bilibili|xiaohongshu|douyin|weibo)[^。\n"`]{0,8}(的号|账号|accounts?\b)/i],
];
const SKIP_DIRS = new Set(["__pycache__", "node_modules", ".venv"]);
const SELF = fileURLToPath(import.meta.url);   // spells out what it looks for, so it is not searched itself
// A pins file holds fingerprints only (a sha256 prefix and a byte count): a prefix can be sixteen digits by chance.
const PINS = /\.pins\.json$/;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  if (!statSync(dir).isDirectory()) return [dir];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(p);
    return [p];
  });
}

test("no role trace: what HH ships has no home directory, session name or long number, and src/ no site's accounts", () => {
  const found: string[] = [];
  for (const root of ROOTS) {
    for (const p of files(join(TREE, root))) {
      if (p === SELF || PINS.test(p)) continue;
      const text = readFileSync(p);
      if (text.includes(0)) continue;   // not text
      const rel = relative(TREE, p);
      text.toString("utf8").split("\n").forEach((line, i) => {
        for (const [what, re] of rel.startsWith("src/") ? [...TRACES, ...SRC_TRACES] : TRACES) if (re.test(line)) found.push(`${rel}:${i + 1}: ${what}`);
      });
    }
  }
  assert.deepEqual(found, [], `${found.length} trace(s) of a particular role:\n${found.slice(0, 40).join("\n")}`);
});
