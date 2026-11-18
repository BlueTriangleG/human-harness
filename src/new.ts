// hh new: lay out a new role — a directory holding its instance config and the workspace files its persona is read from.
// A role is that directory and nothing else: no OS user, no fixed port, no path outside it, so several roles can live
// under one OS user next to each other.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, userInfo } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { B, DEFAULT_LANG, setLang } from "./lang/index.ts";
import { deepMerge, launchdLabels } from "./config.ts";
import { makeSkeleton } from "./persona/layout.ts";
import { SHELF_FILE } from "./learning/layers.ts";
import { REGISTRY_FILE } from "./persona/registry.ts";
import { jobPath, REPO, services } from "./services/index.ts";
import { launcherOf } from "./services/launchd.ts";
import { appFolder } from "./services/app.ts";
import { BUILTIN_ROOT, discover } from "./modules/load.ts";

export interface NewRole {
  /** The role's id: the config's id and part of its launchd labels */
  id: string;
  /** Where the role lives; must not exist yet, or be empty */
  dir: string;
  /** What the role is called (defaults to the id) and what it calls its owner */
  me?: string;
  owner: string;
  lang?: string;
  /** Where this OS user's service jobs are (default: the service manager's directory): another role's load guard there means this one only watches */
  launchAgents?: string;
  /** A ready-made persona (personas/<name>/): its files replace the starter ones, and its name is the role's unless me is given */
  persona?: string;
  /** From the setup wizard: the role's pronouns, who the owner is to it, persona files the owner read (IDENTITY.md,
   *  SOUL.md, USER.md…: each replaces the starter one of its name), a square PNG or JPEG of it (copied into its
   *  directory: its app's icon), modules turned on or off by name, and the owner's time zone */
  pronouns?: string;
  relation?: string;
  files?: Record<string, string>;
  avatar?: string;
  modules?: Record<string, boolean>;
  timezone?: string;
}

/** The file hh new leaves in a role's directory, holding its id: hh remove deletes a directory whole only where it finds it */
export const ROLE_MARK = ".hh-role";

/** a name as a file name: no path separators or control characters, no leading dot, nothing a file system refuses */
export const fileName = (name: string): string =>
  [...name].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || "/\\:".includes(c) ? "-" : c)).join("").replace(/^[.\s]+/, "").trim() || "role";

/**
 * A ready-made persona in the role's language: personas/<name>/<lang>/ holds the persona files it brings (the others stay
 * the starter ones), personas/<name>/persona.json the name it goes by in each language. {{me}} and {{owner}} in the files
 * are filled in when the role is made
 */
function readyMade(name: string, lang: string): { me?: string; files: Record<string, string> } {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("hh new: --persona is a name under personas/ (lower-case letters, digits and -)");
  const root = join(REPO, "personas", name), dir = join(root, lang);
  if (!existsSync(dir)) throw new Error(`hh new: no persona "${name}" in language ${lang} (looked in ${dir})`);
  const meta = JSON.parse(readFileSync(join(root, "persona.json"), "utf8")) as { me?: Record<string, string> };
  const files = Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
  return { ...(meta.me?.[lang] ? { me: meta.me[lang] } : {}), files };
}

/** What a new role starts with over the framework's defaults (config/new-role.json): all, then its language; the gate's first rules */
interface Template { all: Record<string, unknown>; lang: Record<string, Record<string, unknown>>; gateRules: unknown }

/** A TCP port nobody listens on right now (the OS picks one) */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => done(typeof a === "object" && a ? a.port : 0)); });
  });
}

/** Create the role's directory and return what a person needs to know next */
export async function newRole(o: NewRole): Promise<string> {
  if (!/^[a-z][a-z0-9-]*$/.test(o.id)) throw new Error("hh new: the id is lower-case letters, digits and -, starting with a letter");
  if (!o.owner.trim()) throw new Error("hh new: --owner is required (what the role calls its owner)");
  const dir = resolve(o.dir);
  if (existsSync(dir) && readdirSync(dir).length > 0) throw new Error(`hh new: ${dir} exists and is not empty`);
  const lang = o.lang?.trim() || DEFAULT_LANG;
  setLang(lang);   // throws on an unknown pack, before anything is written
  const preset = o.persona ? readyMade(o.persona, lang) : undefined;   // throws on an unknown one, before anything is written
  const me = o.me?.trim() || preset?.me || o.id;
  const workspace = join(dir, "workspace");
  if (o.avatar && !/\.(png|jpe?g)$/i.test(o.avatar)) throw new Error("hh new: the avatar is a PNG or JPEG file");
  const files: Record<string, string> = {
    "IDENTITY.md": B.newRole.identity(me) + (o.pronouns?.trim() ? B.newRole.pronouns(o.pronouns.trim()) : ""),
    "SOUL.md": B.newRole.soul,
    "USER.md": B.newRole.user(o.owner) + (o.relation?.trim() ? B.newRole.relation(o.owner, o.relation.trim()) : ""),
    "MEMORY.md": B.newRole.memory,
    "AGENTS.md": B.newRole.agents(o.owner),
  };
  // a ready-made persona brings some of these five, the wizard's files any of them; what neither brings stays the starter
  for (const [name, text] of Object.entries(preset?.files ?? {})) if (name in files) files[name] = text.replaceAll("{{me}}", me).replaceAll("{{owner}}", o.owner);
  for (const [name, text] of Object.entries(o.files ?? {})) if (name in files && text.trim()) files[name] = `${text.trim()}\n`;
  if (o.timezone) try { new Intl.DateTimeFormat("en", { timeZone: o.timezone }); } catch { throw new Error(`hh new: ${o.timezone} is not a time zone`); }
  const stateDir = join(dir, "state");
  // every built-in module is on, as for the first role; the kernel's own (required) are on anyway
  const modules: Record<string, Record<string, unknown>> = Object.fromEntries((await discover([{ dir: BUILTIN_ROOT, trusted: true }], lang))
    .filter((f) => f.spec && !f.spec.required).map((f) => [f.name, { enabled: true }]));
  // one role per machine sheds load: when this user already runs another role's guard, this one only watches
  const svc = services();
  const agents = o.launchAgents ?? svc.dir;
  const otherGuard = existsSync(agents) && readdirSync(agents).some((f) => f.includes("load-guard") && /\.(plist|service|timer)$/.test(f));
  if (otherGuard && modules["load-guard"]) modules["load-guard"].shed = false;
  for (const [name, on] of Object.entries(o.modules ?? {})) if (modules[name]) modules[name].enabled = on;
  // its helpers work under the role's own directory: the module's default is one directory for every role of this OS user
  if (modules.helpers) modules.helpers.tasksDir = join(dir, "tasks");
  const template = JSON.parse(readFileSync(join(REPO, "config", "new-role.json"), "utf8")) as Template;
  const config = deepMerge(deepMerge({
    id: o.id,
    names: { me, owner: o.owner, notMe: [] },
    lang,
    workspace,
    stateDir,
    personaFiles: Object.keys(files),
    // nothing is sent anywhere until the owner gives the role a channel and turns this off; the scripts run under the
    // role's own Python environment, which hh modules install makes
    tools: { sendDryRun: true, python: join(stateDir, "venv", "bin", "python"), node: process.execPath },
    modules,
    browser: { port: await freePort() },
    // on macOS its jobs start through its own app, which holds the privacy grants the owner gives it
    launchd: { hhd: `ai.hh.${o.id}.hhd`, console: `ai.hh.${o.id}.console`, consolePort: await freePort(), ...(svc.kind === "launchd" ? { app: join(appFolder(o.id), `${fileName(me)}.app`) } : {}) },
    ...(o.avatar ? { avatar: join(dir, `avatar${extname(o.avatar).toLowerCase()}`) } : {}),
  }, template.all), template.lang[lang] ?? {});
  if (o.timezone) { const c = config as { schedule?: Record<string, unknown> }; c.schedule = { ...c.schedule, timezone: o.timezone }; }
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(dir, ROLE_MARK), `${o.id}\n`);
  if (o.avatar) copyFileSync(o.avatar, config.avatar as string);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace, name), text);
  // the gate's first rules, where the framework's default gate.rulesFile looks
  writeFileSync(join(workspace, "gate.json"), `${JSON.stringify(template.gateRules, null, 2)}\n`);
  makeSkeleton(workspace, files["SOUL.md"]!);
  // the notebook's rules file, empty: the role adds its own marks; without the file every night's report says it is missing
  const shelfRoot = join(workspace, (JSON.parse(readFileSync(join(REPO, "config", "default.json"), "utf8")) as { learning: { root: string } }).learning.root);
  writeFileSync(join(shelfRoot, SHELF_FILE), `${JSON.stringify({ importantMarks: [], importanceKey: "importance" }, null, 2)}\n`);
  // the people list starts with the owner (privacy owner), so HH knows from the first start who the owner is (hh tell, the
  // gate's fixed routes, the night's owner file); the role adds everyone else itself. hhd's first start takes the file as it
  // finds it for the approved baseline. The key names the owner's files: the owner's name when it is a plain word, else "owner"
  const ownerKey = /^[A-Za-z][A-Za-z0-9_-]*$/.test(o.owner) ? o.owner.toLowerCase() : "owner";
  writeFileSync(join(workspace, REGISTRY_FILE), `${JSON.stringify({ [ownerKey]: { name: o.owner, privacy: "owner" } }, null, 2)}\n`);
  // the workspace is a git repository from the first day: the night's persona snapshot reads HEAD
  let git = "a git repository, first commit made";
  try {
    const run = (...args: string[]) => execFileSync("git", ["-C", workspace, ...args], { stdio: "ignore" });
    run("init", "-q"); run("add", "-A");
    run("-c", `user.name=${me}`, "-c", `user.email=${o.id}@hh.local`, "commit", "-q", "-m", "the first day");
  } catch { git = "NOT a git repository (git failed): run git init and a first commit there, the night's persona snapshot needs one"; }
  const configFile = join(dir, "instance.json");
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const root = REPO;
  // the two jobs, for a look before hh modules install puts them where the service manager reads them
  const jobs = svc.kernelJobs(launchdLabels(config), { LAUNCHER: launcherOf(config)[0], NODE: config.tools.node, CODE: root, HH_CONFIG: configFile, HOME: homedir(), PATH: jobPath(process.env.PATH).path, LOG_DIR: join(stateDir, "logs"), CONSOLE_PORT: String(config.launchd.consolePort) });
  const unfilled = [...new Set(jobs.flatMap((j) => j.unfilled))];
  mkdirSync(join(dir, svc.kind));
  const plists = jobs.flatMap((j) => Object.entries(j.files).map(([name, text]) => { const file = join(dir, svc.kind, name); writeFileSync(file, text); return file; }));
  return [
    `created ${dir}`,
    `  config     ${configFile}`,
    `  workspace  ${workspace}  (${Object.keys(files).join(", ")} — ${preset ? `${Object.keys(preset.files).filter((f) => f in files).join(", ")} from the ready-made persona ${o.persona}; change them as you like` : "write who this role is into them"})`,
    `  ${svc.kind.padEnd(11)}${plists.join(", ")}  (not installed${unfilled.length ? `; fill in ${unfilled.map((k) => `{{${k}}}`).join(", ")} first` : ""})`,
    ...(config.launchd.app ? [`  app        ${config.launchd.app}  (the role's own app: it starts the role's jobs and holds the privacy grants you give it; hh modules install builds it${config.launchd.app.startsWith(homedir()) ? "" : ` in its folder, which you make once: sudo mkdir -p -m 755 ${dirname(config.launchd.app)} && sudo chown ${userInfo().username} ${dirname(config.launchd.app)}`})`] : []),
    `  modules    ${Object.keys(modules).join(", ") || "none"} on${otherGuard ? " (load-guard only watches: this user already runs another role's guard, which sheds load)" : ""}`,
    `  workspace  ${git}`,
    `  schedule   no focus slots, no idle wandering; to turn them on, set schedule.focusSlots (e.g. ["09:00"]) and schedule.wanderEveryMinutes in ${configFile}`,
    `set it up    HH_CONFIG=${configFile} node ${join(root, "src/cli.ts")} modules install   (Python environment, manuals, ${svc.kind} jobs; it starts the role, opens its console in your browser on the talk page and puts the command ${o.id} on your PATH)`,
    `check it     HH_CONFIG=${configFile} node ${join(root, "src/cli.ts")} modules doctor`,
    `talk to it   ${o.id} "…"   (once installed)`,
    `open it      ${o.id} console   (its console in your browser, on the talk page)`,
    "Sending is simulated (tools.sendDryRun) until the role has a channel.",
  ].join("\n");
}

const USAGE = "usage: hh new <id> --owner <name> [--dir <path>] [--me <name>] [--lang <code>] [--persona <name>]";

/** hh new <id> --owner <name> [--dir <path>] [--me <name>] [--lang <code>] [--persona <name>] */
export async function newCommand(argv: readonly string[]): Promise<string> {
  const [id, ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const k = rest[i]!; const v = rest[i + 1];
    if (!/^--(dir|me|owner|lang|persona)$/.test(k) || v === undefined) throw new Error(USAGE);
    flags[k.slice(2)] = v;
  }
  if (!id || id.startsWith("-")) throw new Error(USAGE);
  return newRole({ id, dir: flags.dir ?? id, owner: flags.owner ?? "", ...(flags.me ? { me: flags.me } : {}), ...(flags.lang ? { lang: flags.lang } : {}), ...(flags.persona ? { persona: flags.persona } : {}) });
}
