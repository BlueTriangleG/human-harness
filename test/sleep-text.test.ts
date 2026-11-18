// The night's text (src/sleep/) lives in the sleep part of the language packs. This test holds the move to what the code
// said before it, word for word, and keeps it there:
// - every literal with Chinese text the code had (test/sleep-text.pins.json, one per place, with the line it was on) is the
//   Chinese pack's entry it moved to; a sentence with holes is called with ⟨0⟩, ⟨1⟩, … where the code had its expressions;
// - what src/sleep still writes in Chinese is on test/sleep-text.kept.json, with the reason it stays in the code;
// - the English pack's sleep part is English, apart from the two entries below that name a Chinese form on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectTree } from "../src/parity/census.ts";
import { zh } from "../src/lang/zh/index.ts";
import { en } from "../src/lang/en/index.ts";

const TREE = resolve(fileURLToPath(import.meta.url), "../..");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(TREE, "test", f), "utf8")) as T;
const PINS = read<Array<{ at: string; path: string; params?: number; want: string; shared?: boolean }>>("sleep-text.pins.json");
const KEPT = read<Array<{ file: string; text: string; why: string }>>("sleep-text.kept.json");
const HAN = /[㐀-鿿　-〿＀-￯]/;
/** The English entries that name a Chinese form on purpose: the subject of the night's landing commit (modules/night writes it), and a numeral the engine reads as a digit */
const EN_NAMES_CHINESE = new Set(["sleep.leadprompts.withdraw.tokens"]);

const entry = (pack: object, path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], pack);
const render = (v: unknown, n: number): unknown => (typeof v === "function" ? (v as (...a: string[]) => unknown)(...Array.from({ length: n }, (_, i) => `⟨${i}⟩`)) : v);

test("sleep text: every literal the night's code had is, word for word, the Chinese pack's entry it moved to", () => {
  const wrong = PINS.filter((p) => render(entry(zh, p.path), p.params ?? 0) !== p.want)
    .map((p) => `${p.at} ${p.path}: ${JSON.stringify(render(entry(zh, p.path), p.params ?? 0))} is not ${JSON.stringify(p.want)}`);
  assert.deepEqual(wrong, []);
  assert.ok(PINS.length > 1000, "the pins are all there");
});

test("sleep text: what src/sleep still writes in Chinese is on the kept list, with its reason", () => {
  const key = (file: string, text: string): string => `${file}\u0000${text}`;
  const want = new Map<string, number>();
  for (const k of KEPT) {
    assert.ok(k.why.trim().length > 40, `${k.file}: a reason, not a label`);
    want.set(key(k.file, k.text), (want.get(key(k.file, k.text)) ?? 0) + 1);
  }
  const extra: string[] = [];
  for (const o of collectTree(TREE).occurrences) {
    if (!o.path.startsWith("src/sleep/") || !["string", "template", "regex"].includes(o.kind) || !HAN.test(o.text)) continue;
    const n = want.get(key(o.path, o.text)) ?? 0;
    if (n > 0) want.set(key(o.path, o.text), n - 1);
    else extra.push(`${o.path}:${o.line}  ${o.text}`);
  }
  assert.deepEqual(extra, [], `Chinese in src/sleep that is not on test/sleep-text.kept.json — move it into the sleep pack:\n${extra.join("\n")}`);
  assert.deepEqual([...want].filter(([, n]) => n > 0).map(([k]) => k.replace("\u0000", "  ")), [], "the kept list names what the code no longer has");
});

test("sleep text: the English pack's sleep part is English, and has every entry the Chinese one has", () => {
  const leaves = (o: object, at: string): Array<[string, unknown]> => Object.entries(o).flatMap(([k, v]) =>
    v !== null && typeof v === "object" ? leaves(v as object, `${at}.${k}`) : [[`${at}.${k}`, v] as [string, unknown]]);
  const zhLeaves = leaves(zh.sleep, "sleep"), enLeaves = new Map(leaves(en.sleep, "sleep"));
  assert.deepEqual(zhLeaves.map(([p]) => p).filter((p) => !enLeaves.has(p)), []);
  const chinese = [...enLeaves].filter(([p, v]) => !EN_NAMES_CHINESE.has(p) && HAN.test(String(render(v, typeof v === "function" ? v.length : 0))));
  assert.deepEqual(chinese.map(([p]) => p), []);
  for (const p of EN_NAMES_CHINESE) assert.ok(enLeaves.has(p), `${p} is still an entry`);
});
