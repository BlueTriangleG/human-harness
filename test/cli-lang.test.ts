// 命令行入口也按实例配置的语言取字（和 hhd、控制台一样）。
// src/cli.ts 一 import 就开跑（读配置、按命令分叉、退出），没法在测试进程里调它；现在又只有一个语言包，起子进程也看不出差别。
// 所以这里看源文件：设语言那一行在、位置对；再看一遍所有读配置的入口，免得以后新加一个入口忘了设。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

test("cli: the language pack is set from the instance config right after the instance check, before any command branches", () => {
  const src = read("src/cli.ts");
  assert.match(src, /import \{[^}]*\bsetLang\b[^}]*\} from "\.\/lang\/index\.ts";/);
  const load = src.indexOf("const cfg = loadConfig();"), check = src.indexOf("requireInstance(cfg)"), lang = src.indexOf("\nsetLang(cfg.lang, roleNames(cfg));");
  const firstBranch = src.indexOf("\nif (argv[0] === ", check);
  assert.ok(load > 0 && check > load && lang > check, "先读配置、查实例，再设语言");
  assert.ok(firstBranch > lang, "设语言在第一个按命令分叉的地方之前：哪条命令都用得上");
  assert.equal(src.split("setLang(").length - 1, 1, "只设一次");
});

test("entries: every file that loads the config at start-up also sets the language; the one exception is the one-off import from the old system", () => {
  // 一次性从旧系统搬家的脚本不渲染角色读的字，不设
  const EXEMPT = new Set(["src/config.ts"]);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { if (name !== "web" && name !== "node_modules") walk(p); continue; }
      if (name.endsWith(".ts")) files.push(relative(ROOT, p));
    }
  };
  walk(join(ROOT, "src"));
  const loaders = files.filter((f) => !EXEMPT.has(f) && /\bloadConfig\(\)/.test(read(f)));
  assert.deepEqual(loaders.sort(), ["src/channels/bridge.ts", "src/cli.ts", "src/console/main.ts", "src/hhd.ts", "src/parity/world.ts", "src/setup.ts", "src/wizard.ts"], "读配置的入口就这几个；多了一个要想清楚它设不设语言，再加进这张单子");
  for (const f of loaders) {
    const src = read(f);
    const at = src.search(/\bloadConfig\(\)/), lang = src.search(/\bsetLang\([a-zA-Z.]*lang, roleNames\([a-zA-Z]+\)\)/);
    assert.ok(lang > at, `${f}：读了配置，后面要按它的 lang 设语言`);
  }
});
