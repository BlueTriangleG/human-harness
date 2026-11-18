import { test } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { B, setLang } from "../src/lang/index.ts";
import { startWizard, type WizardDeps, type WizardEvent } from "../src/wizard.ts";
import type { SetUp } from "../src/setup.ts";

function deps(over: Partial<WizardDeps> = {}): WizardDeps & { removed: string[]; made: SetUp[] } {
  const removed: string[] = [], made: SetUp[] = [];
  return {
    removed, made,
    open: () => {},
    claude: async () => "# My nature\n\nCurious about everything.",
    login: async () => ({ kind: "subscription", plan: "Max" }),
    logIn: async () => 0,
    setUp: async (o) => { made.push(o); o.progress?.("making", "make"); o.progress?.("its permission page is open", "grants"); return ["making"]; },
    remove: async (id) => { removed.push(id); },
    reachOf: async () => ({ console: "http://127.0.0.1:1/", pair: "http://127.0.0.1:1/pair#t=x", talk: 'aria "hi"' }),
    ...over,
  };
}

async function wizard(d: WizardDeps) {
  setLang("en");
  const w = await startWizard({ lang: "en", app: false }, d);
  const token = w.url.split("#")[1]!;
  const base = w.url.split("#")[0]!.replace(/\/$/, "");
  const call = (path: string, o: { body?: unknown; headers?: Record<string, string> } = {}) => fetch(`${base}${path}`, {
    method: o.body === undefined ? "GET" : "POST",
    headers: { "X-HH-Wizard": token, ...(o.body === undefined ? {} : { "Content-Type": "application/json", Origin: base }), ...o.headers },
    ...(o.body === undefined ? {} : { body: JSON.stringify(o.body) }),
  });
  return { w, token, base, call };
}

test("wizard: only with its token, from its own origin, as JSON, at its own host; the token is after the # of its address", async () => {
  const { w, base, call } = await wizard(deps());
  try {
    assert.match(w.url, /^http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]{43}$/);
    assert.equal((await fetch(`${base}/api/wizard/defaults`)).status, 403, "no token");
    assert.equal((await call("/api/wizard/defaults", { headers: { "X-HH-Wizard": "x".repeat(43) } })).status, 403, "another token");
    assert.equal((await call("/api/wizard/persona", { body: { name: "Aria" }, headers: { Origin: "http://evil.example" } })).status, 403, "another origin");
    assert.equal((await call("/api/wizard/persona", { body: { name: "Aria" }, headers: { "Content-Type": "text/plain" } })).status, 403, "not JSON");
    const host = await new Promise<number>((resolve) => {
      httpRequest({ host: "127.0.0.1", port: w.port, path: "/", headers: { Host: "evil.example" } }, (res) => { res.resume(); resolve(res.statusCode!); }).end();
    });
    assert.equal(host, 403, "another host (DNS rebinding)");
    assert.equal((await fetch(`${base}/wizard/%2e%2e/%2e%2e/package.json`)).status, 404, "nothing outside the wizard's own files");
  } finally { w.server.close(); }
});

test("wizard: the defaults — two tiers, the preset cards, the modules and whether each is ready, a suggested id with its icon, the kind of Claude login", async () => {
  const { w, call } = await wizard(deps());
  try {
    type Card = { name: string; title: string; about: string; ready: boolean; how?: string; on: boolean; always?: boolean };
    const d = await (await call("/api/wizard/defaults")).json() as { tiers: Array<{ id: string }>; presets: Array<{ key: string; title: string }>; modules: Card[]; id: string; color: string; initial: string; timezone: string; login: { kind: string; plan?: string } };
    assert.deepEqual(d.tiers.map((t) => t.id), ["standard", "save"]);
    assert.ok(["gentle-friend", "sharp-assistant", "playful-buddy", "quiet-scholar"].every((k) => d.presets.some((p) => p.key === k)), JSON.stringify(d.presets));
    const qq = d.modules.find((m) => m.name === "qq")!;
    assert.ok(!qq.ready && qq.how && !qq.on, "qq needs a login first");
    assert.ok(d.modules.every((m) => m.title !== m.name || m.name === "qq") && d.modules.every((m) => !/[\u3400-\u9fff]/.test(m.title + m.about + (m.how ?? ""))), "the owner's words, and no Chinese on an English page");
    const base = d.modules.find((m) => m.name === "base")!;
    assert.ok(base.always && base.on, "every role keeps base");
    assert.ok(d.modules.some((m) => m.ready && m.on));
    assert.match(d.color, /^#[0-9a-f]{6}$/);
    assert.equal(d.initial, "A");
    assert.ok(d.timezone);
    assert.deepEqual(d.login, { kind: "subscription", plan: "Max" }, "the kind of login, nothing of it");
    assert.deepEqual(await (await call("/api/wizard/login")).json(), d.login, "asked again after a /login");
    const zh = await (await call("/api/wizard/defaults?lang=zh")).json() as { presets: Array<{ key: string; title: string }>; tiers: Array<{ about: string }>; modules: Card[] };
    assert.equal(zh.modules.find((m) => m.name === "goals")!.title, "目标");
    assert.equal(zh.presets.find((p) => p.key === "gentle-friend")!.title, "温柔的朋友");
    assert.match(zh.tiers[1]!.about, /省额度/);
    const id = await (await call("/api/wizard/id?name=Sam%20Two")).json() as { id: string; initial: string };
    assert.match(id.id, /^sam-two/);
    assert.equal(id.initial, "S");
  } finally { w.server.close(); }
});

test("wizard: persona files from a preset card, or drafted (a model that is not Fable) — a failed draft says so and can be tried again", async () => {
  const asked: string[] = [];
  let fail = false;
  const { w, call } = await wizard(deps({ claude: async (_p, model, system) => { asked.push(model); assert.ok(system.length < 200); if (fail) throw new Error("rate limited"); return "```markdown\n# My nature\n\nCurious.\n```"; } }));
  try {
    const p = await (await call("/api/wizard/persona", { body: { name: "Aria", owner: "Sam", preset: "gentle-friend", relation: "a friend", pronouns: "she/her", lang: "en" } })).json() as { files: Array<{ name: string; text: string }> };
    assert.deepEqual(p.files.map((f) => f.name), ["IDENTITY.md", "SOUL.md", "USER.md"]);
    assert.ok(p.files[1]!.text.includes("Sam") && !p.files[1]!.text.includes("{{"), "the preset filled in");
    assert.ok(p.files[0]!.text.includes("she/her") && p.files[2]!.text.includes("a friend"));
    const zh = await (await call("/api/wizard/persona", { body: { name: "小禾", owner: "Sam", preset: "gentle-friend", lang: "zh" } })).json() as { files: Array<{ text: string }> };
    assert.ok(zh.files[1]!.text.startsWith("# 我的性子"), "in the role's language, whatever the wizard's");
    const d = await (await call("/api/wizard/draft-persona", { body: { name: "Aria", owner: "Sam", lang: "en" } })).json() as { files: Array<{ name: string; text: string }> };
    assert.equal(d.files[1]!.text, "# My nature\n\nCurious.\n");
    assert.ok(asked.every((m) => /sonnet/i.test(m)), asked.join());
    fail = true;
    const r = await call("/api/wizard/draft-persona", { body: { name: "Aria", owner: "Sam", lang: "en" } });
    assert.equal(r.status, 502);
    assert.equal((await r.json() as { retry: boolean }).retry, true);
  } finally { w.server.close(); }
});

test("wizard: create streams its progress to the end, read before or after it starts, and answers with its last line; a failed one is removed again and can be tried again", async () => {
  let boom = true;
  const seen: SetUp[] = [];
  const d = deps({ setUp: async (o) => { seen.push(o); o.progress?.("making", "make"); if (boom) { boom = false; throw new Error("npm failed"); } o.progress?.("its permission page is open", "grants"); return []; } });
  const { w, call } = await wizard(d);
  try {
    const lines$ = async (r: Response) => (await r.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    const role = { name: "Aria", owner: "Sam", tier: "save", timezone: "Europe/Paris", modules: { goals: false, qq: "yes" }, files: [{ name: "SOUL.md", text: "# Me" }], lang: "en" };
    // read before the make starts: it waits for it
    const early = await call("/api/wizard/progress");
    const failed = await (await call("/api/wizard/create", { body: role })).json() as Record<string, unknown>;
    assert.equal(failed.retry, true);
    assert.match(String(failed.error), /npm failed/);
    assert.deepEqual((await lines$(early)).map((l) => l.step), ["make", "error"]);
    assert.deepEqual(d.removed, [seen[0]!.id], "the half-made role goes");
    const answer = await (await call("/api/wizard/create", { body: role })).json() as Record<string, unknown>;
    assert.equal(answer.done, true);
    assert.equal(answer.pair, "http://127.0.0.1:1/pair#t=x", "the create answer has the last line too");
    // read after it: from the first line
    const lines = await lines$(await call("/api/wizard/progress"));
    assert.deepEqual(lines.map((l) => l.step), ["make", "grants", "done"]);
    assert.equal(lines.at(-1)!.done, true);
    assert.equal(lines.at(-1)!.pair, "http://127.0.0.1:1/pair#t=x");
    assert.equal(lines.at(-1)!.talk, 'aria "hi"');
    assert.match(String(lines.at(-1)!.remove), /\/bin\/hh remove /);
    const o = seen[1]!;
    assert.equal(o.model, "sonnet", "save: the opus tier on sonnet");
    assert.equal(o.openConsole, false, "the page goes to the console itself");
    assert.deepEqual(o.modules, { goals: false }, "only switches");
    assert.deepEqual(o.files, { "SOUL.md": "# Me" });
    assert.equal(o.timezone, "Europe/Paris");
    assert.equal((await call("/api/wizard/create", { body: role })).status, 409, "one role per run");
  } finally { w.server.close(); }
});

test("wizard: done closes it, and so do 30 idle minutes", async () => {
  const { w, call } = await wizard(deps());
  assert.equal((await call("/api/wizard/done", { body: {} })).status, 200);
  assert.match(await w.closed, /nothing was made/);
  const idle = await startWizard({ lang: "en", app: false }, deps({ idleMs: 30 }));
  assert.match(await idle.closed, /30 minutes/);
});

test("wizard: a picture that is not a PNG or JPEG is refused before anything is made", async () => {
  const d = deps();
  const { w, call } = await wizard(d);
  try {
    const r = await (await call("/api/wizard/create", { body: { name: "Aria", owner: "Sam", avatar: "data:image/gif;base64,AA==" } })).json() as Record<string, unknown>;
    assert.match(String(r.error), /PNG or JPEG/);
    assert.equal(d.made.length, 0);
  } finally { w.server.close(); }
});

test("wizard: Log in to Claude Code runs Claude Code's own sign-in for the card picked, then says the login it finds and the command", async () => {
  const ran: string[] = [];
  let kind: "none" | "console" = "none";
  const { w, call } = await wizard(deps({ login: async () => ({ kind }), logIn: async (m) => { ran.push(m); kind = "console"; return 0; } }));
  try {
    assert.equal(((await (await call("/api/wizard/defaults")).json()) as { login: { kind: string } }).login.kind, "none");
    const r = await (await call("/api/wizard/login", { body: { method: "console" } })).json() as { code: number; login: { kind: string }; command: string };
    assert.deepEqual(ran, ["console"]);
    assert.deepEqual(r, { code: 0, login: { kind: "console" }, command: "claude auth login --console" });
    // now logged in: a second sign-in would change Claude Code's login on this Mac, so it waits for the page's confirm
    const again = await call("/api/wizard/login", { body: { method: "claudeai" } });
    assert.equal(again.status, 409);
    assert.match(String((await again.json() as { error: string }).error), /not only HH's/);
    assert.deepEqual(ran, ["console"], "not run without the confirm");
    assert.equal((await (await call("/api/wizard/login", { body: { method: "anything", confirm: true } })).json() as { command: string }).command, "claude auth login --claudeai", "confirmed; anything else is the subscription");
  } finally { w.server.close(); }
});

test("wizard: what happens on the page is told to the terminal that started it — the page opened, each step, the make line by line, how to talk to it", async () => {
  setLang("en");
  const told: WizardEvent[] = [];
  const w = await startWizard({ lang: "en", app: false, tell: (e) => told.push(e) }, deps({ login: async () => ({ kind: "none" }) }));
  const token = w.url.split("#")[1]!, base = w.url.split("#")[0]!.replace(/\/$/, "");
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "X-HH-Wizard": token, "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body) });
  try {
    await (await fetch(`${base}/`)).text();
    await (await fetch(`${base}/`)).text();
    const draft = await post("/api/wizard/draft-persona", { name: "Aria", owner: "Sam", lang: "en" });
    assert.equal(draft.status, 409);
    assert.equal((await draft.json() as { error: string }).error, B.wizard.draftNoLogin, "no login yet: the draft says where to log in, and the terminal is not told it was written");
    await (await post("/api/wizard/persona", { name: "Aria", owner: "Sam", preset: "gentle-friend", lang: "en" })).json();
    await (await post("/api/wizard/login", { method: "claudeai" })).json();
    await (await post("/api/wizard/create", { name: "Aria", owner: "Sam", lang: "en" })).text();
    assert.deepEqual(told.map((e) => e.kind), ["page", "persona", "login", "make", "line", "line", "done"], "the page told once, however often it is asked for");
    assert.deepEqual(told.at(-1), { kind: "done", name: "Aria", talk: 'aria "hi"' });
  } finally { w.server.close(); }
  const quiet = await startWizard({ lang: "en", app: false }, deps());
  quiet.server.close();   // no tell given (a program reads the JSON line): nothing is told, nothing breaks
});
