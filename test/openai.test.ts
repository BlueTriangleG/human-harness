// The role's OpenAI key (src/openai.ts) and what follows from having one: every OpenAI call here goes to a stand-in fetch,
// none to the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { PassThrough } from "node:stream";
import { tmpDir } from "./tmp.ts";
import { testConfig } from "./helpers.ts";
import { setLang } from "../src/lang/index.ts";
import { Logger, memorySink, type LogRecord } from "../src/log.ts";
import { openDb } from "../src/store/db.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { OpenAIEmbedder, loadOpenAIKey, redactKey, EMBEDDINGS_URL } from "../src/memory/events/embed.ts";
import { KeywordDecisions, OpenAIDecisions, DECISIONS_URL } from "../src/learning/decisions.ts";
import { makeLearning } from "../src/learning/runtime.ts";
import { askOpenAIKey, checkLines, checkOpenAIKey, openaiCommand, prompter, saveOpenAIKey, secretsFile, usable, type KeyCheck, type Prompter } from "../src/openai.ts";
import { startWizard, type WizardDeps } from "../src/wizard.ts";
import type { SetUp } from "../src/setup.ts";
import { buildWorld, NOW } from "./memeval/world.ts";

const KEY = `sk-test-${"k".repeat(40)}`;
/** the notebook's clock: an hour on, so pages just written are past the quiet time before they get their ids */
const LATER = Date.now() + 3_600_000;
const MODELS_URL = "https://api.openai.com/v1/models";
const ALL_OK: KeyCheck = { key: "ok", embeddings: "ok", decisions: "ok" };

/** Each character counts in one of 512 dimensions: close wording, close vectors */
const vec = (t: string): number[] => {
  const v = new Array<number>(512).fill(0);
  for (const ch of t) v[ch.codePointAt(0)! % 512]! += 1;
  return v;
};

/** A stand-in OpenAI: what was asked of it, and answers like the real one's; per address a status to fail with instead */
function fakeOpenAI(fail: Record<string, number> = {}, body: (url: string) => string = () => "{}") {
  const calls: Array<{ url: string; method: string; auth: string; body: Record<string, unknown> | null }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const b = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url, method: init.method ?? "GET", auth: String((init.headers as Record<string, string>).Authorization), body: b });
    if (fail[url]) return new Response(body(url), { status: fail[url] });
    if (url === MODELS_URL) return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
    if (url === DECISIONS_URL) {
      const qs = b!.questions as Array<{ name: string }>;
      return new Response(JSON.stringify({ answers: qs.map((q) => ({ name: q.name, type: "predicate", probability: 0.9 })), usage: { input_tokens: 10 * qs.length } }), { status: 200 });
    }
    const input = b!.input as string[];
    return new Response(JSON.stringify({ data: input.map((t, index) => ({ embedding: vec(t), index })) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, urls: () => calls.map((c) => c.url) };
}

test("openai: the key goes into secrets.json, 0600, keeping what else is there; removed, the rest stays; a broken file is left as it is", () => {
  const dir = tmpDir("hh-openai-");
  try {
    const state = join(dir, "state");
    saveOpenAIKey(state, KEY);
    assert.equal(loadOpenAIKey(state), KEY);
    assert.equal(statSync(secretsFile(state)).mode & 0o777, 0o600);
    writeFileSync(secretsFile(state), JSON.stringify({ openaiKey: "old", other: "kept" }), { mode: 0o644 });
    saveOpenAIKey(state, KEY);
    assert.deepEqual(JSON.parse(readFileSync(secretsFile(state), "utf8")), { openaiKey: KEY, other: "kept" });
    assert.equal(statSync(secretsFile(state)).mode & 0o777, 0o600, "a wider file is narrowed");
    saveOpenAIKey(state, null);
    assert.deepEqual(JSON.parse(readFileSync(secretsFile(state), "utf8")), { other: "kept" });
    assert.equal(loadOpenAIKey(state), null);
    writeFileSync(secretsFile(state), "not json");
    assert.throws(() => saveOpenAIKey(state, KEY));
    assert.equal(readFileSync(secretsFile(state), "utf8"), "not json");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openai: a check asks whether OpenAI knows the key for free first, then makes one embedding and one decision as HH does; each use said on its own", async () => {
  setLang("en");
  const f = fakeOpenAI();
  assert.deepEqual(await checkOpenAIKey(KEY, f.fetchImpl), ALL_OK);
  assert.deepEqual(f.calls.map((c) => [c.method, c.url]), [["GET", MODELS_URL], ["POST", EMBEDDINGS_URL], ["POST", DECISIONS_URL]]);
  assert.ok(f.calls.every((c) => c.auth === `Bearer ${KEY}`));
  assert.deepEqual([f.calls[1]!.body!.model, f.calls[1]!.body!.dimensions], ["text-embedding-3-small", 512]);
  assert.equal(f.calls[2]!.body!.model, "gpt-6-luna");

  // a key OpenAI does not know: nothing else is tried (nothing spent)
  const echo = () => JSON.stringify({ error: { message: `Incorrect API key provided: sk-test-****${KEY.slice(-4)}.` } });
  const bad = fakeOpenAI({ [MODELS_URL]: 401 }, echo);
  const c = await checkOpenAIKey(KEY, bad.fetchImpl);
  assert.deepEqual(c, { key: "key", embeddings: "skipped", decisions: "skipped" });
  assert.equal(bad.calls.length, 1);
  assert.equal(usable(c), false);
  const lines = checkLines(c).join("\n");
  assert.match(lines, /does not know this key/);
  assert.ok(!lines.includes(KEY.slice(-4)) && !lines.includes("sk-"), "what OpenAI echoes of the key is never said");

  // embeddings work, decisions are not allowed: usable, and said so
  const half = await checkOpenAIKey(KEY, fakeOpenAI({ [DECISIONS_URL]: 403 }).fetchImpl);
  assert.deepEqual(half, { key: "ok", embeddings: "ok", decisions: "denied" });
  assert.ok(usable(half));
  assert.match(checkLines(half).join("\n"), /decisions\): this key is not allowed this[\s\S]*scores them by words/);
  // embeddings refused: not usable however decisions went
  assert.equal(usable(await checkOpenAIKey(KEY, fakeOpenAI({ [EMBEDDINGS_URL]: 429 }).fetchImpl)), false);
  // no answer at all
  const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
  assert.deepEqual(await checkOpenAIKey(KEY, down), { key: "network", embeddings: "skipped", decisions: "skipped" });
});

test("openai: no piece of a key in an error text — not the key, not OpenAI's masked echo of it; the embedder's and the judge's errors go through it", async () => {
  assert.equal(redactKey(`x ${KEY} y`, KEY), "x *** y");
  assert.equal(redactKey("Incorrect API key provided: sk-proj-********abcd. See", null), "Incorrect API key provided: sk-***. See");
  const echo = () => JSON.stringify({ error: { message: `Incorrect API key provided: sk-test-****${KEY.slice(-4)}.` } });
  const logs: LogRecord[] = [];
  const e = new OpenAIEmbedder({ key: KEY, fetchImpl: fakeOpenAI({ [EMBEDDINGS_URL]: 401 }, echo).fetchImpl, log: new Logger("t", memorySink(logs)) });
  assert.equal(await e.embed(["a"]), null);
  const d = new OpenAIDecisions({ key: KEY, db: openDb(":memory:"), tz: "UTC", fetchImpl: fakeOpenAI({ [DECISIONS_URL]: 401 }, echo).fetchImpl, dailyUsd: 1, log: new Logger("t", memorySink(logs)) });
  assert.equal(await d.judge("t", [{ name: "a", text: "q" }]), null);
  const said = JSON.stringify(logs) + e.status().lastError + d.lastError;
  assert.match(said, /HTTP 401/);
  assert.ok(!said.includes(KEY.slice(-4)) && !said.includes("sk-test"), said);
});

test("openai: a key that may not use decisions (403 / 404) — the words judge answers from then on, said once; no breaker, no alert", async () => {
  const logs: LogRecord[] = [];
  const f = fakeOpenAI({ [DECISIONS_URL]: 403 });
  const alerts: string[] = [];
  const d = new OpenAIDecisions({ key: KEY, db: openDb(":memory:"), tz: "UTC", fetchImpl: f.fetchImpl, dailyUsd: 1, log: new Logger("t", memorySink(logs)), onAlert: (m) => alerts.push(m), instead: new KeywordDecisions() });
  const qs = [{ name: "a", text: "验收成片的时候吗？" }, { name: "b", text: "煮面的时候吗？" }];
  for (let i = 0; i < 5; i++) {
    const r = await d.judge("验收这条成片", qs);
    assert.ok(r && r.tokens === 0 && r.p.get("a")! > r.p.get("b")!, "scored by words");
  }
  assert.equal(f.calls.length, 1, "asked OpenAI once");
  assert.equal(logs.filter((l) => /may not use decisions/.test(l.msg)).length, 1);
  assert.equal(d.broken, false);
  assert.deepEqual(alerts, []);
  // without a words judge to fall back on: as before, a failure
  const plain = new OpenAIDecisions({ key: KEY, db: openDb(":memory:"), tz: "UTC", fetchImpl: fakeOpenAI({ [DECISIONS_URL]: 404 }).fetchImpl, dailyUsd: 1 });
  assert.equal(await plain.judge("t", qs), null);
});

/** a new role's config (config/new-role.json laid over the defaults: learning on) with a shelf of two pages, in Chinese */
function newRole(dir: string) {
  setLang("zh");   // the shelf's pages are read in the role's language
  const root = join(dir, "skills");
  for (const [rel, text] of Object.entries({
    "通用/陶艺/SKILL.md": "---\nname: 陶艺\ndescription: d\n---\n",
    "通用/陶艺/拉坯.md": "# 拉坯怎么不塌\n简介：陶艺课上拉坯时泥坯总塌\n什么时候翻：拉坯、做陶艺的时候\n",
    "通用/陶艺/煮面.md": "# 怎么煮面\n简介：煮面的火候\n什么时候翻：饿了的时候\n",
  })) { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); }
  const shipped = JSON.parse(readFileSync(new URL("../config/new-role.json", import.meta.url), "utf8")) as { all: { learning: Record<string, unknown> } };
  return testConfig({ stateDir: join(dir, "state"), schedule: { timezone: "UTC" }, learning: { ...shipped.all.learning, root } });
}

test("openai: a new role with a key — memory finds by meaning, the notebook brings a page up by meaning and the judge runs; learning is on with nothing to change", async () => {
  const dir = tmpDir("hh-openai-role-");
  try {
    const cfg = newRole(dir);
    assert.ok(cfg.learning.enabled && cfg.learning.inject && cfg.learning.shelf, "a new role's learning is on");
    saveOpenAIKey(cfg.stateDir, KEY);
    const f = fakeOpenAI();
    const logs: LogRecord[] = [];
    const log = new Logger("t", memorySink(logs));
    // as hhd.ts wires it: the key read from the state directory
    const db = openDb(":memory:");
    const mem = new EventMemory({ db, embedder: new OpenAIEmbedder({ key: loadOpenAIKey(cfg.stateDir)!, fetchImpl: f.fetchImpl }), now: () => NOW, tz: "UTC" });
    buildWorld(mem.store);
    assert.ok(await mem.index.backfillVectors(1000) > 0, "vectors made for what it remembers");
    const before = f.calls.length;
    assert.ok((await mem.index.search("陶艺课")).length > 0);
    assert.ok(f.calls.slice(before).some((c) => c.url === EMBEDDINGS_URL && (c.body!.input as string[])[0] === "陶艺课"), "the question went by meaning");

    const rt = makeLearning(cfg, db, mem, log, { fetchImpl: f.fetchImpl, now: () => LATER })!;
    assert.ok((await rt.rescan()).embedded > 0, "the pages' covers have vectors");
    const r = await rt.notes.associate("拉坯的时候泥总是塌", { region: "main", binding: "wake" });
    assert.ok(f.urls().includes(DECISIONS_URL), "the judge was asked");
    assert.ok(r.pages.length > 0 && r.tokens > 0, JSON.stringify(r));
    assert.ok(!logs.some((l) => l.level === "warn" || l.level === "error"), JSON.stringify(logs));
    assert.ok(!JSON.stringify(logs).includes(KEY.slice(-6)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openai: a new role with no key — memory and the notebook go by words, nothing is sent anywhere, nothing fails", async () => {
  const dir = tmpDir("hh-openai-none-");
  try {
    const cfg = newRole(dir);
    const nowhere = (async () => { throw new Error("no network"); }) as unknown as typeof fetch;
    const logs: LogRecord[] = [];
    const db = openDb(":memory:");
    const mem = new EventMemory({ db, embedder: loadOpenAIKey(cfg.stateDir) ? new OpenAIEmbedder({ key: "x", fetchImpl: nowhere }) : null, now: () => NOW, tz: "UTC" });
    buildWorld(mem.store);
    assert.ok((await mem.index.search("陶艺")).length > 0, "found by its words");
    const rt = makeLearning(cfg, db, mem, new Logger("t", memorySink(logs)), { fetchImpl: nowhere, now: () => LATER })!;
    assert.equal((await rt.rescan()).embedded, 0);
    const r = await rt.notes.associate("拉坯的时候泥坯总塌", { region: "main", binding: "wake" });
    assert.ok(r.pages.length > 0, JSON.stringify(r));
    assert.deepEqual(logs.filter((l) => l.level !== "info").map((l) => l.msg), ["learning: no OpenAI key, keyword search only"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openai: hh openai — status, set (typed, checked, kept only when usable, 0600), check, remove; the key is never in what it says", async () => {
  setLang("en");
  const dir = tmpDir("hh-openai-cmd-");
  try {
    const cfg = testConfig({ stateDir: join(dir, "state") });
    const said: string[] = [];
    const o = (check: KeyCheck, key = KEY) => ({ check: async () => check, readKey: async () => key, say: (l: string) => said.push(l) });
    assert.match(await openaiCommand(cfg, []), /No OpenAI key[\s\S]*hh openai set/);
    await assert.rejects(openaiCommand(cfg, ["set"], o({ key: "key", embeddings: "skipped", decisions: "skipped" })), /not kept/);
    assert.ok(!existsSync(secretsFile(cfg.stateDir)), "a key HH cannot use is not kept");
    await assert.rejects(openaiCommand(cfg, ["set"], o(ALL_OK, "has a space in it and is long enough")), /does not look like a key/);
    assert.match(await openaiCommand(cfg, ["set"], o(ALL_OK, "")), /Nothing typed/);
    const set = await openaiCommand(cfg, ["set"], o({ key: "ok", embeddings: "ok", decisions: "denied" }));
    assert.match(set, /scores them by words[\s\S]*kept[\s\S]*restarts by itself once the role is calm/);
    assert.equal(loadOpenAIKey(cfg.stateDir), KEY);
    assert.equal(statSync(secretsFile(cfg.stateDir)).mode & 0o777, 0o600);
    assert.match(await openaiCommand(cfg, ["status"]), /OpenAI key: set/);
    assert.match(await openaiCommand(cfg, ["check"], o(ALL_OK)), /embeddings\): works/);
    assert.match(await openaiCommand(cfg, ["remove"]), /The key is gone[\s\S]*restarts by itself/);
    assert.equal(loadOpenAIKey(cfg.stateDir), null);
    await assert.rejects(openaiCommand(cfg, ["what"]), /usage: hh openai/);
    assert.ok(![...said, set].join("\n").includes(KEY.slice(-6)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("openai: setup's terminal question — what the key is for, the key not shown as typed, checked, asked again until usable or skipped", async () => {
  setLang("en");
  const answers = ["", "too short", `sk-bad-${"b".repeat(30)}`, KEY];
  const run = async (given: string[]) => {
    const said: string[] = [];
    const p: Prompter = { ask: async () => "", hidden: async () => given.shift() ?? "", pause() {}, resume() {}, close() {} };
    const key = await askOpenAIKey(p, (l) => said.push(l), async (k) => (k === KEY ? ALL_OK : { key: "key", embeddings: "skipped", decisions: "skipped" }));
    return { key, said: said.join("\n") };
  };
  const skipped = await run([answers[0]!]);
  assert.equal(skipped.key, undefined);
  assert.match(skipped.said, /OpenAI key \(optional\)[\s\S]*api\.openai\.com/);
  const got = await run(answers.slice(1));
  assert.equal(got.key, KEY);
  assert.match(got.said, /does not look like a key[\s\S]*does not know this key[\s\S]*key: works/);
  assert.ok(!got.said.includes(KEY));

  // the hidden question at a real readline: what is typed is not written back
  const input = new PassThrough(), output = new PassThrough();
  let shown = "";
  output.on("data", (c: Buffer) => { shown += c.toString(); });
  const pr = prompter(input, output);
  const typed = pr.hidden("key: ");
  input.write(`${KEY}\n`);
  assert.equal(await typed, KEY);
  pr.close();
  assert.ok(shown.includes("key: ") && !shown.includes(KEY.slice(-6)), JSON.stringify(shown));
});

function wizardDeps(over: Partial<WizardDeps> = {}): WizardDeps & { made: SetUp[]; checked: string[] } {
  const made: SetUp[] = [], checked: string[] = [];
  return {
    made, checked,
    open: () => {},
    claude: async () => "# x",
    login: async () => ({ kind: "subscription", plan: "Max" }),
    logIn: async () => 0,
    setUp: async (o) => { made.push(o); o.progress?.("making", "make"); return ["making"]; },
    remove: async () => {},
    reachOf: async () => ({ console: "http://127.0.0.1:1/", pair: null, talk: 'aria "hi"' }),
    checkKey: async (k) => { checked.push(k); return k === KEY ? { key: "ok", embeddings: "ok", decisions: "denied" } : { key: "key", embeddings: "skipped", decisions: "skipped" }; },
    ...over,
  };
}

test("openai: the wizard checks a key (each use on its own, nothing kept) and hands it with the make to setup; it never comes back", async () => {
  setLang("en");
  const d = wizardDeps();
  const w = await startWizard({ lang: "en", app: false }, d);
  const token = w.url.split("#")[1]!;
  const base = w.url.split("#")[0]!.replace(/\/$/, "");
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "X-HH-Wizard": token, "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  try {
    const ok = await post("/api/wizard/openai-check", { key: ` ${KEY} ` });
    assert.deepEqual(await ok.json(), { key: "ok", embeddings: "ok", decisions: "denied", usable: true });
    const no = await post("/api/wizard/openai-check", { key: `sk-other-${"o".repeat(30)}` });
    assert.deepEqual(await no.json(), { key: "key", embeddings: "skipped", decisions: "skipped", usable: false });
    const odd = await post("/api/wizard/openai-check", { key: "not a key" });
    assert.equal(odd.status, 400);
    assert.ok(!(await odd.text()).includes("not a key"), "what was sent is not said back");
    assert.equal(d.checked.length, 2, "only something like a key is checked");
    const made = await (await post("/api/wizard/create", { name: "Aria", owner: "Ada", openaiKey: KEY })).text();
    assert.equal(d.made[0]!.openaiKey, KEY);
    assert.ok(!made.includes(KEY.slice(-6)));
  } finally { w.server.close(); }
});

