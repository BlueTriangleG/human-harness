// The pack names nobody: placeholders in its text are filled with a role's names when a process picks its pack.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { B, N, P, T, registerLang, setLang, type LangPack } from "../src/lang/index.ts";
import { zh } from "../src/lang/zh/index.ts";

const PACK: LangPack = {
  ...zh,
  code: "names-test",
  prompts: {
    ...zh.prompts,
    FOCUS_REGULAR: "{{me}} / {{owner}} / {{Owner}} / {{ta}} / {{place}} / {{other}}",
    focusQuotaTight: (used, mins) => `{{owner}}: ${used} ${mins} — {{me}}`,
    QUESTION_REFUSED: { ...zh.prompts.QUESTION_REFUSED, full: (max) => `{{ta}} ${max}` },
  },
};
registerLang(PACK);
const NAMES = { me: "阿青", owner: "laolin", ta: "他", place: "河边镇", id: "aqing" };

test("pack names: unbound, the bindings are the pack's own objects; bound, every string and every function result is filled; names stick until null", () => {
  try {
    setLang("names-test", null);
    assert.equal(P, PACK.prompts, "unbound: the pack's own object");
    assert.equal(P.FOCUS_REGULAR, "{{me}} / {{owner}} / {{Owner}} / {{ta}} / {{place}} / {{other}}", "placeholders stay as written");
    assert.deepEqual(N, { me: "", owner: "", ta: "", place: "", id: "" });

    setLang("names-test", NAMES);
    assert.equal(P.FOCUS_REGULAR, "阿青 / laolin / Laolin / 他 / 河边镇 / {{other}}", "a string; an unknown placeholder is left alone");
    assert.equal(P.focusQuotaTight(96, 15), "laolin: 96 15 — 阿青", "what a function returns");
    assert.equal(P.QUESTION_REFUSED.full(3), "他 3", "a function inside an object");
    assert.equal(P.UNSENT_REPLY, zh.prompts.UNSENT_REPLY, "text without a placeholder is untouched");
    assert.equal(N, NAMES, "code that recognises a name reads N");
    assert.notEqual(P, PACK.prompts);

    setLang("names-test");
    const kept: string = P.FOCUS_REGULAR;   // read into a plain string: the assertions above narrowed the binding's type
    assert.ok(kept.startsWith("阿青 / laolin"), "a later setLang without names keeps them");
    setLang(undefined);
    assert.equal(N, NAMES, "also across packs");

    setLang("names-test", null);
    assert.equal(P, PACK.prompts, "null unbinds");
  } finally { setLang(undefined, null); }
});

test("pack names: the Chinese pack names nobody — no placeholder is left unfilled once a role is bound", () => {
  const holes = /\{\{[A-Za-z]+\}\}/;
  const walk = (v: unknown, path: string, out: string[]): void => {
    if (typeof v === "string") { if (holes.test(v)) out.push(path); }
    else if (v !== null && typeof v === "object" && !(v instanceof RegExp)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`, out);
  };
  try {
    setLang("zh", NAMES);
    const left: string[] = [];
    walk(P, "P", left);
    assert.deepEqual(left, [], "every placeholder of the constant strings is one the binding knows");
  } finally { setLang(undefined, null); }
});

test("pack names: {{ordinary}} is what the role calls an ordinary person on its list (names.ordinary), else the pack's words; the first role's, set in its config, give the two sentences it read before, byte for byte", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const zhNames = { me: "米拉", owner: "ada", ta: "她", place: "枫湾", id: "mira" }, enNames = { me: "Mira", owner: "ada", ta: "she", place: "Maple Bay", id: "mira" };
  try {
    // sha256 of the two sentences at 01bed46de, when the Chinese pack still named a person itself, that name swapped for
    // the made-up one here: the template is that text with a slot where the name was
    setLang("zh", { ...zhNames, ordinary: "砚" });
    assert.equal(sha(T.people_i_know.description), "5a6926f6f32ce011cab2d473662910fdfe7573f2b7fa227a828ee7dd0f42ae0e");
    assert.equal(sha(B.brain.peopleUnapprovedIdsNote("wx:abc、qq:def")), "37443d44d22e2c679dc34386d2aa9de0fbdc903b6c5bee17f4da3b577dc6b868");
    setLang("zh", zhNames);
    assert.match(T.people_i_know.description, /最多给到和名单上的普通人一样的权限/);
    assert.match(B.brain.peopleUnapprovedIdsNote("x"), /权限先按名单上的普通人那一级/);
    // the English pack, nothing set: as it was
    setLang("en", enNames);
    assert.equal(sha(T.people_i_know.description), "328bccf8223909e9a0b7ba4372081089fbadc5c7532e59855883d0b94f18ed72");
    assert.equal(sha(B.brain.peopleUnapprovedIdsNote("wx:abc, qq:def")), "d3f1dececb212605ff1c655de6b0ced5326415db5bdbfa7ac00b30c84bc5f8eb");
  } finally { setLang(undefined, null); }
});
