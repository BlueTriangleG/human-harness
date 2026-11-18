// hh setup --wizard: the server of the "make your Human" wizard (docs: /Users/Shared/hh-config-layers/WIZARD.md). It
// listens on 127.0.0.1 at a free port with a token made for this one run, handed to the page after the # of its address
// (a fragment never reaches a server or a log). Every API request passes the console's Host check, carries the token in
// X-HH-Wizard (no cookie: no other local page or role's console ever holds it), and a write is JSON from this origin.
// The page (src/console/web/wizard/, its words src/console/lang/<lang>/wizard.ts) reads the defaults, has the persona
// files filled from a preset card or drafted by the owner's own Claude Code login on a model that is not Fable, sends
// what the owner chose, and reads the progress as a stream until the role is up and has said hello. A failed make is
// removed again (hh remove). The server closes when the page says it is done, or after 30 minutes nobody used it; started
// at a terminal, a few seconds after the role is made, the terminal saying the window can be closed.
// An OpenAI key, optional, is checked here (/api/wizard/openai-check: whether OpenAI knows it, then one embedding and one
// decision) and goes with the make into the role's secrets.json (0600); it is never sent back, logged or kept here.
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { claudeLogin, claudeLogIn, type Login } from "./claude-login.ts";
import { loadConfig, roleNames } from "./config.ts";
import { MARK } from "./console/command.ts";
import { consoleCommand } from "./console/open.ts";
import { B, langCode, setLang } from "./lang/index.ts";
import { BUILTIN_ROOT, discover } from "./modules/load.ts";
import { checkOpenAIKey, looksLikeKey, usable, type KeyCheck } from "./openai.ts";
import { removeCommand } from "./remove.ts";
import { colorOf, initialOf } from "./services/app.ts";
import { REPO } from "./services/index.ts";
import { freeId, fullName, idFrom, ownerGuess, setUp, type SetUp, type Tier } from "./setup.ts";

const WEB = join(REPO, "src", "console", "web", "wizard");
/** the console's OpenAI key block (web/js/openai.js): the memory and learning step uses the same file */
const SHARED = "/web/js/openai.js";
const PERSONAS = join(REPO, "personas");
const IDLE_MS = 30 * 60_000;
/** a long make (the permission page waits for the owner) sends something this often, so no web view gives up on it */
const BEAT_MS = 15_000;
const MAX_BODY = 4 * 1024 * 1024;   // a picture of a few MB, as a data URL
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };
/** the two quota tiers the owner picks from: standard (each tier its default model), save (the opus tier on sonnet; haiku's stays) */
const TIER: Record<string, Tier | undefined> = { standard: undefined, save: "sonnet" };

export interface WizardDeps {
  /** open the page (a browser, or Human.app's window) */
  open: (url: string) => void;
  /** run claude -p on the owner's own login, lean (a short system prompt, no tools, MCP servers, settings or skills: a
   *  draft is a thousand or two tokens); the text it answered */
  claude: (prompt: string, model: string, system: string) => Promise<string>;
  /** which Claude login the role will think with (the kind only: claude-login.ts) */
  login: () => Promise<Login>;
  /** Claude Code's own sign-in (claude auth login --claudeai / --console), started for the owner; its exit code */
  logIn: (method: "claudeai" | "console") => Promise<number>;
  setUp: (o: SetUp) => Promise<string[]>;
  /** take a half-made role away again (hh remove <id> --yes) */
  remove: (id: string) => Promise<unknown>;
  /** how to reach the role: its console, an address to pair a client with (hh console --url), and a command that talks
   *  to it from a terminal (its short command when it is on PATH, else the whole path) */
  reachOf: (id: string) => Promise<{ console: string; pair: string | null; talk: string }>;
  /** check an OpenAI key (src/openai.ts): a free call, then the smallest embedding and decision */
  checkKey?: (key: string) => Promise<KeyCheck>;
  idleMs?: number;
}

const env = (): NodeJS.ProcessEnv => { const e = { ...process.env }; delete e.CLAUDECODE; return e; };
const system = (): WizardDeps => ({
  open: (url) => { execFile("/usr/bin/open", [url], () => {}); },
  claude: (prompt, model, system) => new Promise((resolve, reject) => {
    const lean = ["--system-prompt", system, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--no-session-persistence"];
    // stdin ended at once: claude -p otherwise waits 3 s for piped input and warns on stderr, over the real reason, which
    // it prints on stdout ("Not logged in · Please run /login")
    const last = (s: string): string | undefined => s.trim().split("\n").filter(Boolean).at(-1);
    execFile("claude", ["-p", "--model", model, ...lean, "--output-format", "text", prompt], { env: env(), timeout: 180_000, maxBuffer: 1 << 20, cwd: tmpdir() }, (e, out, err) => {
      if (e) reject(new Error((last(out) ?? last(String(err)) ?? e.message).slice(0, 300))); else resolve(out.trim());
    }).stdin?.end();
  }),
  login: () => claudeLogin(),
  // the terminal setup was run in is lent to it: a sign-in that falls back to "paste the code shown" asks there
  logIn: (method) => claudeLogIn(method, { tty: !!process.stdin.isTTY }),
  checkKey: (key) => checkOpenAIKey(key),
  setUp,
  remove: (id) => removeCommand([id, "--yes"]),
  reachOf: async (id) => {
    const config = join(homedir(), "HH", id, "instance.json");
    process.env.HH_CONFIG = config;
    const cfg = loadConfig();
    setLang(cfg.lang, roleNames(cfg));   // what it says from here on is the new role's
    const console = `http://127.0.0.1:${cfg.launchd?.consolePort}/`;
    const path = (process.env.PATH ?? "").split(":").filter(Boolean);
    const own = [...path, join(homedir(), ".local", "bin")].map((d) => join(d, id)).find((f) => { try { return readFileSync(f, "utf8").includes(`${MARK} ${id}:`); } catch { return false; } });
    const talk = own ? `${path.includes(dirname(own)) ? id : own} "hi"` : `HH_CONFIG=${config} ${join(REPO, "bin", "hh")} tell "hi"`;
    // its console was started by install a moment ago: a few tries while it comes up
    for (let i = 0; i < 15; i++) {
      try { return { console, pair: (await consoleCommand(cfg, ["--url"])).trim() || null, talk }; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    return { console, pair: null, talk };
  },
});

/** the models of the tiers (config/default.json) */
const models = (): Record<string, string> => (JSON.parse(readFileSync(join(REPO, "config", "default.json"), "utf8")) as { models: Record<string, string> }).models;

/** a model that is not Fable, for drafting: the sonnet tier's (the page says Sonnet), else haiku's */
function draftModel(): string {
  const m = models();
  return [m.sonnet, m.haiku].find((x) => x && !/fable/i.test(x)) ?? "claude-sonnet-5-5";
}

/** the preset persona cards: personas/<key>/ with "preset": true, their title and about in each language, by their "order" (the first is the default) */
function presets(): Array<{ key: string; title: Record<string, string>; about: Record<string, string> }> {
  return readdirSync(PERSONAS).filter((k) => existsSync(join(PERSONAS, k, "persona.json"))).flatMap((key) => {
    const p = JSON.parse(readFileSync(join(PERSONAS, key, "persona.json"), "utf8")) as { preset?: boolean; order?: number; title?: Record<string, string>; about?: Record<string, string> };
    return p.preset && p.title && p.about ? [{ key, order: p.order ?? 99, title: p.title, about: p.about }] : [];
  }).sort((a, b) => a.order - b.order).map(({ order: _, ...p }) => p);
}

/** the modules every role keeps on: listed, not offered to turn off */
const ALWAYS = new Set(["base", "load-guard"]);

/** what a module card says to the owner: the module's own words (texts.<lang>.json, else texts.json), else its name and summary */
function card(dir: string, lang: string): { title?: string; about?: string; how?: string } {
  for (const f of [`texts.${lang}.json`, "texts.json"]) {
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>;
      if (t.wizardTitle) return { title: t.wizardTitle, about: t.wizardAbout, how: t.wizardHow };
    } catch { /* no words in that language */ }
  }
  return {};
}

/** fn in another language's pack, then back */
function inLang<T>(lang: string, fn: () => T): T {
  const was = langCode();
  setLang(lang);
  try { return fn(); } finally { setLang(was); }
}

interface Who { name: string; owner: string; pronouns?: string; relation?: string; notes?: string; lang: string; preset?: string }

/** the persona files of a role from what the owner said: IDENTITY.md, SOUL.md (a preset's, or the starter), USER.md */
function personaFiles(w: Who, soul?: string): Array<{ name: string; text: string }> {
  const preset = w.preset && /^[a-z][a-z0-9-]*$/.test(w.preset) ? join(PERSONAS, w.preset, w.lang, "SOUL.md") : null;
  const fill = (t: string) => t.replaceAll("{{me}}", w.name).replaceAll("{{owner}}", w.owner);
  return inLang(w.lang, () => [
    { name: "IDENTITY.md", text: B.newRole.identity(w.name) + (w.pronouns ? B.newRole.pronouns(w.pronouns) : "") + (w.notes ? `\n${w.notes}\n` : "") },
    { name: "SOUL.md", text: soul ?? (preset && existsSync(preset) ? fill(readFileSync(preset, "utf8")) : B.newRole.soul) },
    { name: "USER.md", text: B.newRole.user(w.owner) + (w.relation ? B.newRole.relation(w.owner, w.relation) : "") },
  ]);
}

/** a program on this PATH */
const onPath = (bin: string): boolean => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin)));

const str = (v: unknown, max: number): string | undefined => typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined;

/** what a request says of the role and its owner */
function who(b: Record<string, unknown>, lang: string): Who | null {
  const name = str(b.name, 40);
  if (!name) return null;
  return { name, owner: str(b.owner, 60) ?? fullName(), pronouns: str(b.pronouns, 60), relation: str(b.relation, 200), notes: str(b.notes, 4000), lang: str(b.lang, 10) ?? lang, preset: str(b.preset, 40) };
}

/** the console's DNS-rebinding check: only 127.0.0.1, localhost or [::1] at this port */
const hostAllowed = (host: string | undefined, port: number): boolean => !!host && [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);

function body(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const parts: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) { resolve(null); req.destroy(); } else parts.push(c); });
    req.on("end", () => {
      try { const v = JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown; resolve(v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null); }
      catch { resolve(null); }
    });
  });
}

const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const send = (res: ServerResponse, code: number, v: unknown): void => { res.writeHead(code, { "Content-Type": "application/json", ...HEADERS }); res.end(JSON.stringify(v)); };
/** write unless the page has gone (or it was ended) */
const put = (res: ServerResponse, text: string): void => { if (!res.writableEnded && !res.destroyed) res.write(text); };

/** a data:image/png or jpeg URL as a file of its own; undefined when there is none, null when it is not one */
function picture(v: unknown): string | null | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const m = typeof v === "string" ? /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(v) : null;
  if (!m) return null;
  const file = join(mkdtempSync(join(tmpdir(), "hh-wizard-")), `avatar.${m[1] === "png" ? "png" : "jpg"}`);
  writeFileSync(file, Buffer.from(m[2]!, "base64"));
  return file;
}

interface Line { step: string; text: string; done: boolean; error?: string; retry?: boolean; [k: string]: unknown }

export interface Wizard { url: string; port: number; server: Server; closed: Promise<string>; close(why: string): void }

/** what happens on the page, for the terminal that started the wizard to say (wizardCommand) */
export type WizardEvent = { kind: "page" } | { kind: "persona" } | { kind: "login" } | { kind: "key" } | { kind: "make"; name: string } | { kind: "line"; text: string }
  | { kind: "done"; name: string; talk: string } | { kind: "failed"; text: string; cleaned?: boolean };

/** Start the wizard's server; closed settles with what was made (or that nothing was) */
export async function startWizard(o: { lang: string; app: boolean; tell?: (e: WizardEvent) => void }, deps: WizardDeps = system()): Promise<Wizard> {
  const tell = (e: WizardEvent): void => { try { o.tell?.(e); } catch { /* the terminal's words never stop the wizard */ } };
  let paged = false;
  const token = randomBytes(32).toString("base64url");
  const want = Buffer.from(token);
  let settle: (why: string) => void = () => {};
  const closed = new Promise<string>((r) => { settle = r; });
  let idle: NodeJS.Timeout | undefined;
  // idle: nobody called for so long, and no role is being made (the permission page can keep the owner a while)
  const touch = (): void => { clearTimeout(idle); idle = setTimeout(() => (job.running ? touch() : finish(B.wizard.idle)), deps.idleMs ?? IDLE_MS); idle.unref?.(); };
  // the make: its lines so far (the last one done or an error), and who is reading them
  let loggingIn = false;   // a sign-in (POST /api/wizard/login) is running
  const job: { id?: string; lines: Line[]; running: boolean; made: boolean; readers: Set<ServerResponse> } = { lines: [], running: false, made: false, readers: new Set() };
  const emit = (l: Line): void => { if (!l.done && !l.error && l.text) tell({ kind: "line", text: l.text }); job.lines.push(l); for (const r of job.readers) { put(r, `${JSON.stringify(l)}\n`); if (l.done || l.error) r.end(); } if (l.done || l.error) job.readers.clear(); };
  let port = 0;

  const authorized = (req: IncomingMessage): boolean => {
    const got = Buffer.from(String(req.headers["x-hh-wizard"] ?? ""));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
    if (req.method === "GET") return true;
    const origin = req.headers.origin;
    return (origin === undefined || origin === `http://${req.headers.host}`) && String(req.headers["content-type"] ?? "").startsWith("application/json");
  };

  /** make the role; what the last line of the progress says, done */
  const create = async (b: Record<string, unknown>): Promise<Line> => {
    const w = who(b, o.lang);
    if (!w || !str(b.owner, 60)) throw new Error(B.wizard.missing);
    const id = typeof b.id === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(b.id) ? b.id : freeId(idFrom(w.name) || "role");
    const avatar = picture(b.avatar);
    if (avatar === null) throw new Error(B.wizard.badPicture);
    const files = Array.isArray(b.files) ? Object.fromEntries((b.files as unknown[]).flatMap((f) => {
      const x = f as { name?: unknown; text?: unknown };
      return typeof x?.name === "string" && typeof x.text === "string" && x.text.length <= 20_000 ? [[x.name, x.text]] : [];
    })) as Record<string, string> : undefined;
    const openaiKey = typeof b.openaiKey === "string" && b.openaiKey.trim() ? b.openaiKey.trim() : undefined;
    if (openaiKey && !looksLikeKey(openaiKey)) throw new Error(B.openai.badKey);
    const modules = b.modules && typeof b.modules === "object" ? Object.fromEntries(Object.entries(b.modules as Record<string, unknown>).filter(([k, v]) => typeof v === "boolean" && !ALWAYS.has(k))) as Record<string, boolean> : undefined;
    job.id = id;
    tell({ kind: "make", name: w.name });
    try {
      await deps.setUp({
        lang: w.lang, name: w.name, owner: w.owner, id, model: TIER[String(b.tier)], app: o.app, pronouns: w.pronouns, relation: w.relation,
        files, avatar, modules, timezone: str(b.timezone, 60), progress: (text, step) => emit({ step, text, done: false }), openConsole: false,
        ...(openaiKey ? { openaiKey } : {}),
      });
    } catch (e) {
      // not half a role: what was made goes again, and the page says whether it went
      const cleaned = await deps.remove(id).then(() => true, () => false);
      throw Object.assign(new Error((e as { why?: string }).why || (e instanceof Error ? e.message : String(e))), { cleaned });
    }
    const cfg = join(homedir(), "HH", id, "instance.json");
    const app = existsSync(cfg) ? (JSON.parse(readFileSync(cfg, "utf8")) as { launchd?: { app?: string } }).launchd?.app : undefined;
    job.made = true;
    const reach = await deps.reachOf(id);
    const done: Line = { step: "done", text: B.wizard.made(id), done: true, id, ...(app ? { app } : {}), ...reach, remove: `${join(REPO, "bin", "hh")} remove ${id}` };
    tell({ kind: "done", name: w.name, talk: reach.talk });
    emit(done);
    return done;
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    if (!authorized(req)) { send(res, 403, { error: B.wizard.refused }); return; }
    touch();
    const path = url.pathname;
    // the words in the language the page asks for (?lang=), else the wizard's
    const lang = /^[a-z]{2}$/.test(url.searchParams.get("lang") ?? "") ? url.searchParams.get("lang")! : o.lang;
    if (req.method === "GET" && path === "/api/wizard/defaults") {
      const m = models(), name = inLang(lang, () => B.setup.defaultName), id = freeId(idFrom(name) || "role");
      const found = await discover([{ dir: BUILTIN_ROOT, trusted: true }], lang);
      send(res, 200, {
        // owner: the account's full name, empty when it names the computer; user: what stands in when the field is left empty
        lang: o.lang, owner: ownerGuess(), user: userInfo().username, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, name, id, initial: initialOf(name), color: colorOf(id),
        // terminal: setup's terminal is there for Claude Code's sign-in to ask in (a code to paste); not when Human.app opened the wizard
        swiftc: o.app, login: await deps.login(), terminal: !!process.stdin.isTTY,
        // ready: nothing to set up first (a login, another program); always: every role keeps it on
        modules: found.filter((f) => f.spec && !f.spec.required).map((f) => {
          const setup = f.spec!.requires?.setup ?? [], bins = f.spec!.requires?.bins ?? [];
          const ready = !setup.length && bins.every((b) => onPath(b)), w = card(f.dir, lang), always = ALWAYS.has(f.name);
          return { name: f.name, title: w.title ?? f.name, about: w.about ?? f.spec!.summary, ready, ...(!ready && w.how ? { how: w.how } : {}), on: ready || always, ...(always ? { always } : {}) };
        }),
        tiers: inLang(lang, () => [{ id: "standard", about: B.wizard.tierStandard(m.opus ?? "") }, { id: "save", about: B.wizard.tierSave(m.sonnet ?? "") }]),
        presets: presets().map((p) => ({ key: p.key, title: p.title[lang] ?? p.title.en, about: p.about[lang] ?? p.about.en })),
      });
      return;
    }
    // asked again once the owner has changed the login in Claude Code (/login)
    if (req.method === "GET" && path === "/api/wizard/login") { send(res, 200, await deps.login()); return; }
    // the page's "Log in to Claude Code": Claude Code's own sign-in, one at a time; the answer is the login it then finds,
    // and the command, which the page shows when the sign-in did not finish (the owner can run it in a terminal)
    if (req.method === "POST" && path === "/api/wizard/login") {
      tell({ kind: "login" });
      const b = await body(req);
      if (!b) { send(res, 400, { error: B.wizard.badRequest }); return; }
      const method = b.method === "console" ? "console" : "claudeai";
      if (loggingIn) { send(res, 409, { error: B.wizard.busy }); return; }
      // already logged in: signing in again changes the login of Claude Code on this Mac, everything's, not HH's alone;
      // the page has to have said so and been confirmed
      if (b.confirm !== true && (await deps.login()).kind !== "none") { send(res, 409, { error: B.wizard.loginSwitch, confirm: true }); return; }
      loggingIn = true;
      try {
        const code = await deps.logIn(method);
        send(res, 200, { code, login: await deps.login(), command: `claude auth login --${method}` });
      } finally { loggingIn = false; }
      return;
    }
    if (req.method === "GET" && path === "/api/wizard/id") {
      const id = freeId(idFrom(url.searchParams.get("name") ?? "") || "role");
      send(res, 200, { id, initial: initialOf(url.searchParams.get("name") || "?"), color: colorOf(id) });
      return;
    }
    // the make's lines from the first; read before the make starts, it waits for it; ends with its last line. A blank
    // line now and then while nothing happens (skip it)
    if (req.method === "GET" && path === "/api/wizard/progress") {
      res.writeHead(200, { "Content-Type": "application/x-ndjson", ...HEADERS });
      for (const l of job.lines) res.write(`${JSON.stringify(l)}\n`);
      const last = job.lines.at(-1);
      if (last?.done || last?.error) { res.end(); return; }
      job.readers.add(res);
      const beat = setInterval(() => put(res, "\n"), BEAT_MS);
      res.on("close", () => { clearInterval(beat); job.readers.delete(res); });
      return;
    }
    const b = req.method === "POST" ? await body(req) : null;
    if (req.method !== "POST" || !b) { send(res, 400, { error: B.wizard.badRequest }); return; }
    if (path === "/api/wizard/persona" || path === "/api/wizard/draft-persona") {
      const w = who(b, o.lang);
      if (!w) { send(res, 400, { error: B.wizard.missing }); return; }
      if (path === "/api/wizard/persona") { tell({ kind: "persona" }); send(res, 200, { files: personaFiles(w) }); return; }
      // the draft runs on the owner's Claude login, which the usage step comes after: without one, said so before trying
      if ((await deps.login()).kind === "none") { send(res, 409, { error: B.wizard.draftNoLogin }); return; }
      const prompt = inLang(w.lang, () => B.wizard.draftPrompt({ ...w, lang: w.lang, soul: personaFiles(w)[1]!.text }));
      try {
        const draft = (await deps.claude(prompt, draftModel(), inLang(w.lang, () => B.wizard.draftSystem))).replace(/^```[a-z]*\n|\n```\s*$/g, "").trim();
        if (!draft) throw new Error("empty");
        tell({ kind: "persona" });
        send(res, 200, { files: personaFiles(w, `${draft}\n`) });
      } catch (e) { send(res, 502, { error: B.wizard.draftFailed(e instanceof Error ? e.message : String(e)), retry: true }); }
      return;
    }
    // the memory and learning step: whether a key works, each use on its own (one may work and the other not); nothing is kept
    if (path === "/api/wizard/openai-check") {
      tell({ kind: "key" });
      const key = typeof b.key === "string" ? b.key.trim() : "";
      if (!looksLikeKey(key)) { send(res, 400, { error: inLang(lang, () => B.openai.badKey) }); return; }
      const c = await (deps.checkKey ?? checkOpenAIKey)(key);
      send(res, 200, { ...c, usable: usable(c) });
      return;
    }
    // answered when the make is over, with its last line (done, or the error): the page has it even if its stream broke.
    // Until then a space now and then (JSON allows it before the value)
    if (path === "/api/wizard/create") {
      if (job.running || job.made) { send(res, 409, { error: B.wizard.busy }); return; }
      job.running = true; job.lines = [];
      res.writeHead(200, { "Content-Type": "application/json", ...HEADERS });
      const beat = setInterval(() => put(res, " "), BEAT_MS);
      let last: Line;
      try { last = await create(b); }
      catch (e) {
        // cleaned: set when something had been made (true: removed again, false: not all of it)
        const cleaned = (e as { cleaned?: boolean }).cleaned;
        last = { step: "error", text: "", done: false, error: e instanceof Error ? e.message : String(e), retry: true, ...(cleaned === undefined ? {} : { cleaned }) };
        tell({ kind: "failed", text: last.error as string, ...(cleaned === undefined ? {} : { cleaned }) });
        emit(last);
      }
      finally { clearInterval(beat); job.running = false; }
      if (!res.destroyed) res.end(JSON.stringify(last));
      return;
    }
    if (path === "/api/wizard/done") {
      send(res, 200, { ok: true });
      finish(job.made ? B.wizard.made(job.id!) : B.wizard.nothing);
      return;
    }
    send(res, 404, { error: B.wizard.badRequest });
  };

  const page = async (res: ServerResponse, url: URL): Promise<void> => {
    if (!paged) { paged = true; tell({ kind: "page" }); }
    if (url.pathname === "/wizard/strings.json") {
      // the page's words: the console's pack of that language (src/console/lang/<lang>.ts, its wizard group), else English's
      const words = async (lang: string): Promise<unknown> => {
        if (!/^[a-z]{2}$/.test(lang) || !existsSync(join(REPO, "src", "console", "lang", `${lang}.ts`))) return undefined;
        // its own group, and the OpenAI key block's (web/js/openai.js, the same block as the console's settings)
        const pack = ((await import(`./console/lang/${lang}.ts`)) as Record<string, { wizard?: object; openai?: object } | undefined>)[lang];
        return pack?.wizard ? { ...pack.wizard, openai: pack.openai } : undefined;
      };
      const found = (await words(url.searchParams.get("lang") ?? o.lang)) ?? (await words("en"));
      if (!found) { res.writeHead(404); res.end(); return; }
      send(res, 200, found);
      return;
    }
    const rel = normalize(url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/wizard\//, "")).replace(/^(\.\.(\/|$))+/, "");
    // the console's OpenAI key block, one file for both pages
    const file = url.pathname === SHARED ? join(WEB, "..", "js", "openai.js") : join(WEB, rel);
    if ((url.pathname !== SHARED && !file.startsWith(`${WEB}/`)) || !existsSync(file) || !TYPES[extname(file)]) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)]!, ...HEADERS,
      "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'",
    });
    res.end(readFileSync(file));
  };

  const server = createServer((req, res) => {
    if (!hostAllowed(req.headers.host, port)) { send(res, 403, { error: B.wizard.refused }); return; }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const fail = (e: unknown) => { if (!res.headersSent) send(res, 500, { error: String(e).slice(0, 300) }); else res.end(); };
    if (url.pathname.startsWith("/api/")) { api(req, res, url).catch(fail); return; }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname.startsWith("/wizard/") || url.pathname === SHARED)) { page(res, url).catch(fail); return; }
    res.writeHead(404); res.end();
  });
  const finish = (why: string): void => { clearTimeout(idle); server.close(); server.closeAllConnections?.(); settle(why); };
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  touch();
  return { url: `http://127.0.0.1:${port}/#${token}`, port, server, closed, close: finish };
}

/**
 * hh setup --wizard [--lang zh|en] [--no-app] [--no-open]: starts the wizard, opens it in the browser, and waits until it
 * is done. To a person at the terminal it says so in words: that the page is open in the browser, its address to paste
 * when the browser did not bring it up (said again when the page is not asked for within half a minute), Enter to open
 * it again, and what happens on the page as it happens. To a program (Human.app reads it), one JSON line with the address.
 */
export async function wizardCommand(argv: readonly string[], deps: WizardDeps = system()): Promise<string> {
  const i = argv.indexOf("--lang");
  const sys = (Intl.DateTimeFormat().resolvedOptions().locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
  const lang = i >= 0 && argv[i + 1] ? argv[i + 1]! : sys;
  setLang(lang);
  const app = !argv.includes("--no-app") && process.platform === "darwin";
  const person = !!process.stdout.isTTY;
  const say = (line: string): void => { process.stdout.write(`${line}\n`); };
  let seen = false, made = false, listen = (): void => {}, quiet = (): void => {}, over = (): void => {};
  // the terminal is lent to Claude Code's sign-in meanwhile (it may ask there for a code): Enter is not listened for then
  const d: WizardDeps = person ? { ...deps, logIn: async (m) => { quiet(); try { return await deps.logIn(m); } finally { listen(); } } } : deps;
  const tell = (e: WizardEvent): void => {
    if (e.kind === "page") seen = true;
    if (e.kind === "done") made = true;
    const W = B.wizard;
    say(e.kind === "page" ? W.termSeen : e.kind === "persona" ? W.termPersona : e.kind === "login" ? W.termLogin : e.kind === "key" ? W.termKey
      : e.kind === "make" ? W.termMake(e.name) : e.kind === "line" ? `  ${e.text}` : e.kind === "done" ? W.termDone(e.name, e.talk) : W.termFailed(e.text, e.cleaned));
    // made: nothing left to wait for here. The window can be closed; a few seconds for the page to get its last line, then over
    if (e.kind === "done") { say(W.termClose); setTimeout(over, 5_000); }
  };
  const w = await startWizard({ lang, app, ...(person ? { tell } : {}) }, d);
  over = () => w.close(B.wizard.nothing);
  const open = (): void => { if (!argv.includes("--no-open")) d.open(w.url); };
  if (!person) { process.stdout.write(`${JSON.stringify({ url: w.url })}\n`); open(); return w.closed; }
  say(B.wizard.termOpen(w.url));
  say(B.wizard.termWait);
  open();
  const nudge = setTimeout(() => { if (!seen) say(B.wizard.termNotSeen(w.url)); }, 30_000);
  if (process.stdin.isTTY) {
    const onData = (b: Buffer): void => { if (b.includes(10) || b.includes(13)) { open(); say(B.wizard.termReopened); } };
    listen = () => { process.stdin.on("data", onData); process.stdin.resume(); };
    quiet = () => { process.stdin.off("data", onData); process.stdin.pause(); };
    listen();
  }
  // its "Done: … talk to it …" line has said it: the closing line would only repeat it
  try { const why = await w.closed; return made ? "" : why; } finally { clearTimeout(nudge); quiet(); }
}
