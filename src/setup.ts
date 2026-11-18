// hh setup: from a fresh clone to a role running on this computer. ./setup checks what it needs first, installs the
// packages and runs this. It asks the role's language, its name and what it calls its owner (or takes them as flags);
// makes the role in ~/HH/<id> (hh new) with only the modules that need nothing more set up; installs it (hh modules
// install: its app and the app's permission page, its jobs started); and opens its window, paired with the owner (the
// console in the browser when there is no app). It ends with where the app is, how to talk to the role and how to remove it.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { claudeLogin, claudeLogIn, type Login } from "./claude-login.ts";
import { loadConfig, roleNames, type Config } from "./config.ts";
import { openAfterInstall, placeOwnCommand } from "./console/open.ts";
import { B, setLang } from "./lang/index.ts";
import { install } from "./modules/doctor.ts";
import { BUILTIN_ROOT, discover, loadModules } from "./modules/load.ts";
import { newRole, type NewRole } from "./new.ts";
import { askOpenAIKey, prompter, saveOpenAIKey, secretsFile } from "./openai.ts";
import { request } from "./control.ts";
import { askGrants } from "./services/app.ts";
import { runProcess } from "./util/run.ts";
import { launcherOf, REPO } from "./services/launchd.ts";
import { services } from "./services/index.ts";

const USAGE = "usage: hh setup [--wizard [--no-open] | --terminal] [--lang zh|en] [--name <name>] [--owner <what it calls you>] [--id <id>] [--model opus|sonnet|haiku] [--dir <path>] [--no-app] [--yes]";
export const TIERS = ["opus", "sonnet", "haiku"] as const;
export type Tier = (typeof TIERS)[number];

/** an id from a name: lower-case letters, digits and -, starting with a letter; empty when the name has none of them */
export const idFrom = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^[^a-z]+|-+$/g, "");

/** an account's full name that is the computer's ("Sam's MacBook", "iMac"), not a person's */
export const namesComputer = (n: string): boolean => /mac(book|mini)?\b|imac/i.test(n);

/** what it calls its owner, offered first: this account's full name; "" when there is none or it names the computer */
export function ownerGuess(): string {
  let n = "";
  try { n = execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim(); } catch { /* none */ }
  return namesComputer(n) ? "" : n;
}

/** what it calls its owner when nothing is said: ownerGuess, else the account's user name */
export const fullName = (): string => ownerGuess() || userInfo().username;

/**
 * The new role's config, made fit for a first run: the modules that need something set up first (a login, another
 * program) off, and those whose programs are missing; every tier on `model` when one is given; no app without the tools
 * to build one. Returns the names of the modules turned off.
 */
export async function firstRunConfig(file: string, o: { lang: string; model?: (typeof TIERS)[number]; app: boolean; onPath?: (bin: string) => boolean }): Promise<string[]> {
  const onPath = o.onPath ?? ((bin: string) => (process.env.PATH ?? "").split(":").some((d) => d && existsSync(join(d, bin))));
  const c = JSON.parse(readFileSync(file, "utf8")) as Record<string, any>;
  const off: string[] = [];
  for (const f of await discover([{ dir: BUILTIN_ROOT, trusted: true }], o.lang)) {
    const needs = f.spec?.requires;
    if (!c.modules?.[f.name]?.enabled || !(needs?.setup?.length || needs?.bins?.some((b) => !onPath(b)))) continue;
    c.modules[f.name].enabled = false;
    off.push(f.name);
  }
  if (o.model) {
    const ids = (JSON.parse(readFileSync(join(REPO, "config", "default.json"), "utf8")) as { models: Record<string, string> }).models;
    const upto = TIERS.indexOf(o.model);
    c.models = { ...c.models, ...Object.fromEntries(TIERS.slice(0, upto).map((t) => [t, ids[o.model!]])) };
  }
  if (!o.app && c.launchd) delete c.launchd.app;
  writeFileSync(file, `${JSON.stringify(c, null, 2)}\n`);
  return off;
}

/** whoever sits at this Mac's screen is this user (a wizard in a window can be clicked through) */
function atScreen(): boolean {
  try { return process.platform === "darwin" && statSync("/dev/console").uid === process.getuid?.(); } catch { return false; }
}

/**
 * hh setup [flags]: what was done, step by step; throws with what stopped it. --wizard, or no answers given at a Mac's
 * screen, opens the wizard (src/wizard.ts) instead of asking here; --terminal asks here all the same
 */
export async function setupCommand(argv: readonly string[]): Promise<string> {
  const given = argv.some((a) => a === "--name" || a === "--owner" || a === "--yes" || a === "--terminal");
  if (argv.includes("--wizard") || (!given && atScreen())) {
    const { wizardCommand } = await import("./wizard.ts");
    return wizardCommand(argv.filter((a) => a !== "--wizard"));
  }
  argv = argv.filter((a) => a !== "--terminal");
  const flags: Record<string, string> = {};
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--no-app" || k === "--yes") { bare.add(k); continue; }
    if (!/^--(lang|name|owner|id|model|dir)$/.test(k) || argv[i + 1] === undefined) throw new Error(USAGE);
    flags[k.slice(2)] = argv[++i]!;
  }
  if (flags.model && !(TIERS as readonly string[]).includes(flags.model)) throw new Error(USAGE);
  const ask = process.stdin.isTTY && !bare.has("--yes");
  const p = ask ? prompter() : null;
  const q = async (text: string, def: string): Promise<string> => (p ? await p.ask(text) : "") || def;
  let out: string[];
  try {
    const sys = (Intl.DateTimeFormat().resolvedOptions().locale || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
    const lang = flags.lang ?? await q(`Language / 语言 (zh/en) [${sys}] `, sys);
    setLang(lang);   // throws on an unknown pack
    let login = await claudeLogin();
    // not logged in, someone at the terminal: asked, Claude Code's own sign-in runs in this terminal, and it is looked at again
    for (let tries = 0; login.kind === "none" && p && tries < 3; tries++) {
      if (!B.forms.setupYes.test(await p.ask(B.setup.loginAsk))) break;
      p.pause();
      await claudeLogIn("claudeai", { tty: true });
      p.resume();
      login = await claudeLogin();
    }
    process.stdout.write(`${loginLine(login)}\n\n`);
    // the OpenAI key, optional: asked only at a terminal (with --yes or no terminal, none; hh openai set adds one later)
    const openaiKey = p ? await askOpenAIKey(p, (l) => process.stdout.write(`${l}\n`)) : undefined;
    if (p) process.stdout.write("\n");
    const name = flags.name ?? await q(B.setup.askName(B.setup.defaultName), B.setup.defaultName);
    const owner = flags.owner ?? await q(B.setup.askOwner(fullName()), fullName());
    out = await setUp({ lang, name, owner, id: flags.id, model: flags.model as Tier | undefined, dir: flags.dir, app: !bare.has("--no-app"), openaiKey });
  } finally { p?.close(); }
  return out.join("\n");
}

/** which Claude login the role will think with, and how to change it (Claude Code's own /login); none stops setup */
export function loginLine(l: Login): string {
  if (l.kind === "none") throw new Error(B.setup.loginNone);
  return l.kind === "subscription" ? B.setup.loginSubscription(l.plan ?? "") : l.kind === "console" ? B.setup.loginConsole
    : l.kind === "unknown" ? B.setup.loginUnknown(l.said ?? "") : B.setup.loginOther(l.method ?? "");
}

/** an id no role on this computer has: no job file of this user's under its label prefix (launchd's or systemd's), and ~/HH/<id> free */
export function freeId(base: string): string {
  const dir = services().dir, jobs = existsSync(dir) ? readdirSync(dir) : [];
  const taken = (id: string) => existsSync(join(homedir(), "HH", id)) || jobs.some((f) => f.startsWith(`ai.hh.${id}.`));
  for (let n = 1; ; n++) { const id = n === 1 ? base : `${base}-${n}`; if (!taken(id)) return id; }
}

/** What a setup takes: the terminal's answers, or the wizard's (src/wizard.ts) with what it adds for hh new */
export interface SetUp extends Pick<NewRole, "pronouns" | "relation" | "files" | "avatar" | "modules" | "timezone"> {
  lang: string; name: string; owner: string; id?: string; model?: Tier; dir?: string; app: boolean;
  /** each line as it is done, and the step it belongs to (the wizard's progress) */
  progress?: (line: string, step: string) => void;
  /** false: without an app its console is not opened here (the wizard's page goes to it) */
  openConsole?: boolean;
  /** the owner's OpenAI key, checked already (src/openai.ts): into the role's secrets.json before hhd first starts */
  openaiKey?: string;
}

export async function setUp(o: SetUp): Promise<string[]> {
  const id = o.id ?? freeId(idFrom(o.name) || "role");
  const dir = o.dir ?? join(homedir(), "HH", id);
  const lines: string[] = [B.setup.making(id, dir)];
  // the wizard hears one sentence a step; the lines are the terminal's account
  const step = (name: string, text: string): void => o.progress?.(text, name);
  step("make", B.setup.stepMake);
  await newRole({ id, dir, owner: o.owner, me: o.name, lang: o.lang, pronouns: o.pronouns, relation: o.relation, files: o.files, avatar: o.avatar, modules: o.modules, timezone: o.timezone });
  const config = join(dir, "instance.json");
  const off = await firstRunConfig(config, { lang: o.lang, model: o.model, app: o.app && process.platform === "darwin" });
  if (off.length) lines.push(B.setup.modulesOff(off.join(", ")));
  if (!o.app && process.platform === "darwin") lines.push(B.setup.noApp);
  process.env.HH_CONFIG = config;
  const cfg: Config = loadConfig();
  setLang(cfg.lang, roleNames(cfg));
  if (o.openaiKey) { saveOpenAIKey(cfg.stateDir, o.openaiKey); lines.push(B.openai.saved(secretsFile(cfg.stateDir))); }
  step("install", B.setup.stepInstall);
  // the permission page opens inside install and waits for the owner: the wizard hears of it first
  const r = await install(cfg, await loadModules(cfg), { run: runProcess, services: services(), grants: async (app) => { step("grants", B.setup.grantsWaiting); return askGrants(app); } });
  lines.push(...r.lines);
  const remove = `${join(REPO, "bin", "hh")} remove ${id}`;
  if (r.failed) throw new Error([...lines, B.setup.failed(remove)].join("\n"));
  const own = placeOwnCommand(cfg);
  if (own) lines.push(own);
  const app = cfg.launchd?.app;
  if (app && existsSync(launcherOf(cfg)[0]!)) {
    // its window, paired with whoever opened it (the permission page was offered by install already). -n: a permission
    // page still up after install stopped waiting is the same app, and without it open would only bring that page forward
    spawn("/usr/bin/open", ["-n", app, "--args", "--window"], { stdio: "ignore", detached: true }).unref();
    lines.push("", B.setup.doneApp(app));
  } else {
    if (o.openConsole !== false) lines.push(await openAfterInstall(cfg));
    lines.push("", B.setup.doneConsole(id));
  }
  step("greet", B.setup.stepGreet);
  lines.push(await greet(cfg));
  lines.push(B.setup.doneTalk(id), B.setup.doneRemove(remove));
  return lines;
}

/** its first turn: a note to say hello to its owner, in its window, once hhd answers (a minute at most) */
async function greet(cfg: Config): Promise<string> {
  const sock = join(cfg.stateDir, "hh.sock");
  const owner = cfg.names.owner;
  let why = "hhd did not answer";
  for (let i = 0; i < 30; i++) {
    try {
      await request(sock, { cmd: "ping" }, 2000);
      await request(sock, { cmd: "tell", from: owner, text: B.setup.greet(owner), human: false, here: true }, 30_000);
      return B.setup.greeted;
    } catch (e) { why = e instanceof Error ? e.message : String(e); await new Promise((r) => setTimeout(r, 2000)); }
  }
  return B.setup.greetFailed(why);
}
