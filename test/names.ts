// The language pack names nobody: where a sentence addresses the role or its owner it carries a placeholder, and a process
// binds the names when it picks its pack. Most of this suite was written when the first role's names were part of the text,
// and asserts whole sentences with them. Importing this file binds those same names for the test process, so the old
// assertions keep saying what they said. New tests should bind made-up names of their own instead.
// The suite was written against the Chinese pack, so it runs in Chinese (the default for a role is English): a test
// that switches packs goes back to TEST_LANG, not to the default.
import { setLang, type PackNames } from "../src/lang/index.ts";

export const TEST_NAMES: PackNames = { me: "米拉", owner: "ada", ta: "她", place: "枫湾", id: "mira" };
export const TEST_LANG = "zh";
setLang(TEST_LANG, TEST_NAMES);
