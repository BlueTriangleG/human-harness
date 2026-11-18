// The native layer's two packs (apps/macos/Sources/UI/Lang.swift): the same keys, and the same {fill-ins} in each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = readFileSync(join(import.meta.dirname, "..", "apps", "macos", "Sources", "UI", "Lang.swift"), "utf8");
const pack = (name: string): Map<string, string> => {
  const body = new RegExp(`static let ${name}: \\[String: String\\] = \\[([\\s\\S]*?)\\n  \\]`).exec(src)?.[1];
  assert.ok(body, `pack ${name}`);
  return new Map([...body.matchAll(/^\s*"([^"]+)": "((?:[^"\\]|\\.)*)",$/gm)].map((m) => [m[1]!, m[2]!]));
};
const fills = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

test("native words: the Chinese pack has every English key and no other, each with the same fill-ins", () => {
  const en = pack("en"), zh = pack("zh");
  assert.ok(en.size > 40, `${en.size} English words`);
  assert.deepEqual([...zh.keys()].sort(), [...en.keys()].sort());
  for (const [k, v] of en) assert.deepEqual(fills(zh.get(k)!), fills(v), k);
});
