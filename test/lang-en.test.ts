// The English pack is an overlay on the reference pack: it holds the entries translated so far and reads every other one
// from the reference. Every test that changes the pack goes back to the reference with no names bound in finally.
import { test } from "node:test";
import assert from "node:assert/strict";
import { P, T, langGaps, registerLang, setLang } from "../src/lang/index.ts";
import { gaps, overlay } from "../src/lang/overlay.ts";
import { en } from "../src/lang/en/index.ts";
import * as enTools from "../src/lang/en/tools.ts";
import { zh } from "../src/lang/zh/index.ts";
import { TEST_LANG, TEST_NAMES } from "./names.ts";

// This file checks the pack objects themselves (identity), in the Chinese pack the suite runs in: unbind the names
// test/names.ts bound on import
setLang(TEST_LANG, null);

/** Every entry under v as [dotted path, value]: strings by value, functions by identity */
const leaves = (v: unknown, at: string): [string, unknown][] =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof RegExp)
    ? Object.entries(v).flatMap(([k, x]) => leaves(x, `${at}.${k}`))
    : [[at, v]];
const BEFORE = leaves(zh, "zh");

// A pack with only the deliver entries of its own, so that the checks of what an untranslated entry reads do not depend
// on how far the English pack has come
const partial = { ...en, code: "en-partial", tools: overlay(zh.tools, { deliver: enTools.deliver }), prompts: overlay(zh.prompts, {}), memory: overlay(zh.memory, {}) };
registerLang(partial);

/** Only for tsc, never called: an overlay entry with another parameter list, or a name the reference does not have, does not compile */
function overlaysTscRejects(): void {
  const fewer = { deliver: { noChannel: (channel: string): string => channel } };
  // @ts-expect-error noChannel takes (channel: string, connected: readonly string[])
  overlay(zh.tools, fewer);
  const misspelled = { deliver: { noGateway: "x", noChanel: "y" } };
  // @ts-expect-error the reference's deliver has no noChanel
  overlay(zh.tools, misspelled);
  const extraExport = { ...enTools, delivr: { noGateway: "x" } };
  // @ts-expect-error the reference has no export delivr
  overlay(zh.tools, extraExport);
}

test("en pack: a translated entry is English and takes the reference entry's parameters; an untranslated one is the reference's own", () => {
  const d = en.tools.deliver;
  for (const [name, entry] of Object.entries(enTools.deliver)) {
    const ref: unknown = zh.tools.deliver[name as keyof typeof zh.tools.deliver];
    assert.equal(typeof entry, typeof ref, name);
    if (typeof entry === "function") assert.equal(entry.length, (ref as (...a: never[]) => string).length, `${name}: the reference's parameters`);
    assert.equal(d[name as keyof typeof d], entry, `${name}: the pack reads the English file's entry`);
  }
  const said = [
    d.unsure("timed out"), d.dryRun("sms", "+100"), d.noGateway, d.noChannel("sms", ["qqbot", "whatsapp"]), d.noChannel("sms", []),
    d.refused("E1", "bad target"), d.unreachable("connection refused"), d.refusedAfterRecheck("E1", "bad target"), d.stillSilent("timed out", "closed"),
  ];
  for (const s of said) assert.doesNotMatch(s, /\p{Script=Han}/u, s);
  assert.match(d.noChannel("sms", ["qqbot", "whatsapp"]), /"sms".*qqbot, whatsapp/);
  assert.equal(partial.tools.jot_down, zh.tools.jot_down, "a tool with nothing translated is the reference's object");
  assert.equal(partial.tools.sticker.noHandle, zh.tools.sticker.noHandle);
  assert.equal(partial.prompts.FOCUS_REGULAR, zh.prompts.FOCUS_REGULAR);
  assert.equal(partial.memory.recallCentral.noSuch(7), zh.memory.recallCentral.noSuch(7));
  try {
    setLang("en");
    assert.equal(T.deliver.noGateway, d.noGateway, "through the binding");
    setLang("en-partial");
    assert.equal(T.deliver.noGateway, d.noGateway, "through the binding, in the partial pack");
    assert.equal(T.computer.locked, zh.tools.computer.locked);
    assert.equal(P.UNSENT_REPLY, zh.prompts.UNSENT_REPLY);
  } finally { setLang(TEST_LANG, null); }
});

test("en pack: after setLang(\"en\", names) a placeholder is filled, in a sentence read from the reference and in an English one", () => {
  registerLang({ ...en, code: "en-names", tools: overlay(zh.tools, { ...enTools, computer: { locked: "The computer is locked: ask {{owner}} to unlock it." } }) });
  try {
    setLang("en-partial", TEST_NAMES);
    assert.equal(T.computer.locked, zh.tools.computer.locked.replace("{{owner}}", TEST_NAMES.owner), "untranslated: the reference's sentence, filled");
    assert.equal(T.deliver.noChannel("sms", []), en.tools.deliver.noChannel("sms", []), "an English sentence");
    setLang("en-names");
    assert.equal(T.computer.locked, `The computer is locked: ask ${TEST_NAMES.owner} to unlock it.`, "an English sentence, filled");
  } finally { setLang(TEST_LANG, null); }
});

test("en pack: the listing — the translated entries are not missing, an untranslated one is, en has nothing the reference lacks, and a misspelled name is reported", () => {
  const parts = langGaps("en");
  const tools = parts.find((p) => p.part === "tools")!;
  const translated = Object.keys(enTools.deliver).map((k) => `tools.deliver.${k}`);
  for (const path of translated) assert.ok(!tools.missing.includes(path), path);
  // an overlay made here, so that the check does not depend on how far the translation has come
  assert.ok(gaps(zh.tools, { deliver: { noGateway: "x" } }, "tools").missing.includes("tools.jot_down.noted"));
  assert.deepEqual(parts.flatMap((p) => p.extra), []);
  assert.deepEqual(gaps(zh.tools, { deliver: { noGateway: "x", noChanel: "y" } }, "tools").extra, ["tools.deliver.noChanel"]);
  assert.ok(langGaps("zh").every((p) => p.missing.length === 0 && p.extra.length === 0), "the reference has every entry of its own");
});

test("en pack: setLang back to the reference leaves it as it was — the overlay never writes into the reference's objects", () => {
  try {
    setLang("en", TEST_NAMES);
    assert.notEqual(T.deliver.noGateway, zh.tools.deliver.noGateway);
  } finally { setLang(TEST_LANG, null); }
  assert.equal(P, zh.prompts);
  assert.equal(T, zh.tools);
  assert.deepEqual(leaves(zh, "zh"), BEFORE);
});

test("en pack: complete — English is the default, so an entry missing here would reach an English role in Chinese", () => {
  assert.deepEqual(langGaps("en").flatMap((p) => p.missing), []);
});
