// The pack is chosen after the code has loaded (hhd calls setLang once it has read its config), so no module may copy
// pack text while it loads: such a copy keeps the pack that happened to be in use then. A parse of src/ finds every read
// of the pack outside a function; and the text that used to be copied comes out in the pack chosen afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type * as TS from "typescript";
import { setLang } from "../src/lang/index.ts";
import { en } from "../src/lang/en/index.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ts = createRequire(import.meta.url)("typescript") as typeof TS;

// the modules below load under the Chinese pack, as they do in hhd before it reads the role's config
setLang("zh");
const { renderShelf } = await import("../src/learning/shelf.ts");
const { kindLabel } = await import("../src/memory/events/schema.ts");
const { validateRule, defaultWant } = await import("../src/gate/rules.ts");
const { sleepRequest } = await import("../src/control.ts");
const { memoryFrame } = await import("../src/persona/persona.ts");
const { listParams } = await import("../src/learning/params.ts");
const { openDb } = await import("../src/store/db.ts");
const { quotaSummary } = await import("../src/brainstem/quota.ts");
const { Situation } = await import("../src/memory/situation.ts");

test("lang: nothing in src/ reads the language pack while its module loads", () => {
  const files: string[] = [];
  const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n.endsWith(".ts")) files.push(p); } };
  walk(join(ROOT, "src"));
  const hits: string[] = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    if (rel.startsWith("src/lang/") || rel.startsWith("src/console/lang/")) continue;
    const sf = ts.createSourceFile(f, readFileSync(f, "utf8"), ts.ScriptTarget.Latest, true);
    const bound = new Set<string>();
    for (const st of sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/(^|\/)lang\/index\.ts$/.test(st.moduleSpecifier.text)) continue;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (/^[PTMGLSRBN]$/.test(e.name.text)) bound.add(e.name.text);
    }
    const visit = (n: TS.Node): void => {
      if (ts.isFunctionLike(n) || ts.isClassLike(n)) return;
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && bound.has(n.expression.text)) {
        hits.push(`${rel}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.getText()}`);
      }
      ts.forEachChild(n, visit);
    };
    for (const st of sf.statements) if (!ts.isImportDeclaration(st)) visit(st);
  }
  assert.deepEqual(hits, [], "read it where it is used (a function, or zod's error function), not into a constant");
});

test("lang: what used to be copied at load comes out in the pack chosen afterwards", () => {
  setLang("en");
  try {
    const shelf = { pages: [{ archived: false }], books: [{ category: "General", book: "checks", description: "how to check", pages: 1 }], problems: [] };
    assert.ok(renderShelf(shelf as never).startsWith(en.learning.shelf.header), "the shelf heading");
    assert.equal(kindLabel("person"), en.brain.schema.kindLabelPerson, "an entity kind's name");
    assert.equal(defaultWant(), en.gate.rules.defaultWant, "what a rule wants by default");
    assert.deepEqual(validateRule({ id: "a", match: { src: 1 }, action: "drop" }), { error: en.gate.rules.invalidMatchField("a", en.gate.rules.matchSrcType) }, "the gate's rule check");
    assert.throws(() => sleepRequest(["nonsense"]), (e: unknown) => e instanceof Error && e.message === en.brain.control.sleepUsage, "a usage");
    assert.equal(memoryFrame(), en.brain.persona.memoryFrame, "the frame between persona and memory");
    assert.equal(listParams(openDb(":memory:"))[0]!.desc(), en.learning.params.descStrengthWindowDays, "a learning parameter's description");
  } finally { setLang("zh"); }
});

test("lang: dates the role reads are written in the chosen pack's locale", () => {
  const now = Date.UTC(2026, 10, 17, 4, 0);
  const state = { fiveHour: { used: 20, resetsAt: now + 3_600_000, level: 0 }, sevenDay: { used: 40, resetsAt: now + 2 * 86_400_000, level: 0 } };
  const timeLine = (): string => new Situation({ now: () => now, timezone: "UTC" } as never).timeLine();
  setLang("en");
  try {
    assert.doesNotMatch(timeLine(), /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/, "the time line, its weekday and date");
    assert.doesNotMatch(quotaSummary(state, "UTC", now)!, /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/, "the quota line, its weekday and separator");
  } finally { setLang("zh"); }
  assert.match(quotaSummary(state, "UTC", now)!, /周四.*；|；.*周四/, "the Chinese pack keeps its own");
  assert.match(timeLine(), /星期二/);
});
