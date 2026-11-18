// Finding and loading modules (docs/contracts/modules.md): three places are searched — the repo's modules/, the role's
// workspace modules/ and the directories the instance config lists in modulePaths. Only the repo's may hold code
// (module.ts); the others are data (module.json), because the role can write them and hhd holds what the role must not
// decide. Two modules with one name stop hhd. A module loads when its declaration is sound and the instance config turns
// it on (modules.<name>.enabled), or when it is required.
import { BRIDGE_APPS, channelCheck } from "../channels/setup.ts";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { roleNames, type Config } from "../config.ts";
import type { ToolDef } from "../kernel/types.ts";
import type { Logger } from "../log.ts";
import { B, DEFAULT_LANG } from "../lang/index.ts";
import { REGION_ROLES, type CommandResult, type ModuleContext, type ModuleHook, type ModuleSpec, type RegionRole, type RoleFacts } from "./api.ts";
import { command, runScript } from "./command.ts";
import type { SourceKind } from "../gate/sources.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const BUILTIN_ROOT = join(REPO, "modules");
const CODE_FILES = ["module.ts", "module.js", "module.mjs"];
const DEFAULT_REGIONS: readonly RegionRole[] = ["main", "side"];

export interface ModuleRoot { dir: string; trusted: boolean }
/** A module directory as found: its declaration, or why it could not be read */
export interface Found { name: string; dir: string; trusted: boolean; spec: ModuleSpec | null; error?: string }

export function moduleRoots(cfg: Config): ModuleRoot[] {
  return [
    { dir: BUILTIN_ROOT, trusted: true },
    { dir: join(cfg.workspace, "modules"), trusted: false },
    ...(cfg.modulePaths ?? []).map((d) => ({ dir: resolve(cfg.workspace, d), trusted: false })),
  ];
}

/** Every module directory under the roots (names starting with _ or . are not modules). Throws on a name used twice */
export async function discover(roots: readonly ModuleRoot[], lang: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    for (const entry of readdirSync(root.dir).sort()) {
      const dir = join(root.dir, entry);
      if (/^[._]/.test(entry) || !statSync(dir).isDirectory()) continue;
      const f = await readOne(dir, root.trusted, lang);
      if (!f) continue;
      const twin = found.find((x) => x.name === f.name);
      if (twin) throw new Error(B.modules.nameClash(f.name, twin.dir, f.dir));
      found.push(f);
    }
  }
  return found;
}

async function readOne(dir: string, trusted: boolean, lang: string): Promise<Found | null> {
  const name = basename(dir);
  const code = CODE_FILES.find((f) => existsSync(join(dir, f)));
  const data = join(dir, "module.json");
  if (!code && !existsSync(data)) return null;
  try {
    if (code && !trusted) throw new Error(B.modules.codeRefused(code));
    const spec = code
      ? ((await import(pathToFileURL(join(dir, code)).href)) as { default: ModuleSpec }).default
      : fromJson(JSON.parse(readFileSync(data, "utf8")), lang);
    if (spec?.name !== name) throw new Error(B.modules.nameMismatch(String(spec?.name), name));
    return { name, dir, trusted, spec };
  } catch (e) {
    return { name, dir, trusted, spec: null, error: e instanceof Error ? e.message : String(e) };
  }
}

// ---- module.json: a role's own module, as data ----

const Text = z.union([z.string(), z.record(z.string(), z.string())]);
const Param = z.object({ type: z.enum(["string", "number", "boolean"]), description: Text, optional: z.boolean().optional() }).strict();
const Args = z.array(z.string()).optional();
const JsonModule = z.object({
  name: z.string(),
  summary: Text,
  config: z.object({ defaults: z.record(z.string(), z.unknown()) }).strict().optional(),
  requires: z.object({ python: z.string().optional(), bins: z.array(z.string()).optional(), modules: z.array(z.string()).optional(), setup: z.array(z.string()).optional() }).strict().optional(),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/), description: Text, params: z.record(z.string(), Param).optional(),
    script: z.string(), args: Args, stdin: z.literal("json").optional(),
    regions: z.array(z.enum(REGION_ROLES)).optional(), timeoutMs: z.number().int().positive().optional(),
  }).strict()).optional(),
  senses: z.array(z.string()).optional(),
  timers: z.array(z.object({
    name: z.string(), everyMinutes: z.number().positive(), script: z.string(), args: Args,
    timeoutMs: z.number().int().positive().optional(), standalone: z.boolean().optional(),
  }).strict()).optional(),
  mcp: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional() }).strict()).optional(),
}).strict();

/** A module.json as a declaration; its words are picked in the role's language (or the first one given) */
export function fromJson(raw: unknown, lang: string): ModuleSpec {
  const j = JsonModule.parse(raw);
  const pick = (t: z.infer<typeof Text>): string => typeof t === "string" ? t : t[lang] ?? Object.values(t)[0] ?? "";
  const param = (p: z.infer<typeof Param>) => {
    const base = p.type === "string" ? z.string() : p.type === "number" ? z.number() : z.boolean();
    return p.optional ? base.describe(pick(p.description)).optional() : base.describe(pick(p.description));
  };
  return {
    name: j.name, summary: pick(j.summary),
    ...(j.config ? { config: { shape: {}, defaults: j.config.defaults } } : {}),
    ...(j.requires ? { requires: j.requires } : {}),
    ...(j.senses ? { senses: j.senses } : {}),
    ...(j.mcp ? { mcp: j.mcp } : {}),
    tools: (j.tools ?? []).map((t) => command({
      name: t.name, description: pick(t.description), script: t.script, stdin: t.stdin === "json",
      shape: Object.fromEntries(Object.entries(t.params ?? {}).map(([k, p]) => [k, param(p)])),
      argv: (a) => fillArgs(t.args ?? [], a),
      ...(t.regions ? { regions: t.regions } : {}), ...(t.timeoutMs ? { timeoutMs: t.timeoutMs } : {}),
    })),
    timers: (j.timers ?? []).map((t) => ({
      name: t.name, everyMs: t.everyMinutes * 60_000, ...(t.standalone ? { standalone: true } : {}),
      run: command({ script: t.script, argv: () => t.args ?? [], timeoutMs: t.timeoutMs ?? 60_000 }),
    })),
  };
}

/** ["add", "{text}", "--due", "{due}"] with { text: "x" } → ["add", "x"]: a slot with no value is left out, and so is the option name right before it */
export function fillArgs(template: readonly string[], args: Record<string, unknown>): string[] {
  const out: string[] = [];
  let optionBefore = false;
  for (const t of template) {
    const names = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!);
    if (names.some((n) => args[n] === undefined || args[n] === null)) {
      if (optionBefore) out.pop();
      optionBefore = false;
      continue;
    }
    out.push(t.replace(/\{(\w+)\}/g, (_, n: string) => String(args[n])));
    optionBefore = !names.length && t.startsWith("-");
  }
  return out;
}

// ---- the loaded set ----

export const isOn = (cfg: Config, spec: ModuleSpec): boolean => spec.required === true || cfg.modules?.[spec.name]?.enabled === true;

/** The module's config: its defaults with the instance's modules.<name> over them, checked against its shape */
export function configOf(cfg: Config, spec: ModuleSpec): Record<string, unknown> {
  const { enabled: _on, guide: _guide, ...mine } = cfg.modules?.[spec.name] ?? {};
  const merged = { ...spec.config?.defaults, ...mine };
  return spec.config && Object.keys(spec.config.shape).length ? z.object(spec.config.shape).parse(merged) : merged;
}

/** What a module's scripts are told of the role. lang is the pack the core speaks for this config: unset or empty is the default, as setLang takes it */
export function roleFacts(cfg: Config): RoleFacts {
  const n = roleNames(cfg);
  return { id: cfg.id, workspace: cfg.workspace, stateDir: cfg.stateDir, me: n.me, owner: n.owner, timezone: cfg.schedule.timezone, lang: cfg.lang?.trim() || DEFAULT_LANG, hhBin: join(REPO, "bin", "hh"), python: cfg.tools.python };
}

export interface Loaded { spec: ModuleSpec; ctx: ModuleContext; guide: string }

export class Modules {
  readonly found: readonly Found[];
  readonly loaded: readonly Loaded[];
  /** The directories put in front of PATH: every loaded module's bin/ */
  readonly binDirs: readonly string[];

  /** The MCP servers already reported as left out (said once per process) */
  private readonly leftOut = new Set<string>();

  /** What the kernel lends the modules once it is up (Brain.start): until then a module's remind does nothing */
  kernelHooks: { remind(text: string, due?: number): void } | null = null;

  constructor(found: readonly Found[], loaded: readonly Loaded[]) {
    this.found = found;
    this.loaded = loaded;
    this.binDirs = loaded.map((l) => join(l.ctx.dir, "bin")).filter((d) => existsSync(d));
  }

  /** The module tools a region with this role gets, as kernel tools; a throw comes back as a failure line. extra: what the region lends a tool call (notes) */
  toolsFor(role: string, extra: Pick<ModuleContext, "notes"> = {}): ToolDef[] {
    return this.loaded.flatMap(({ spec, ctx: own }) => { const ctx = { ...own, ...extra }; return (spec.tools ?? [])
      .filter((t) => (t.regions ?? DEFAULT_REGIONS).includes(role as RegionRole))
      .map((t): ToolDef => ({
        name: t.name,
        description: typeof t.description === "function" ? t.description() : t.description,
        shape: typeof t.shape === "function" ? t.shape() : t.shape,
        handler: async (args) => {
          try { return await t.handler(args, ctx); } catch (e) { return B.modules.toolFailed(spec.name, e instanceof Error ? e.message : String(e)); }
        },
      })); });
  }

  /** A region's tools: its own and the modules' for its role. One name twice stops the start */
  withTools(own: ToolDef[], role: string, extra: Pick<ModuleContext, "notes"> = {}): ToolDef[] {
    const all = [...own, ...this.toolsFor(role, extra)];
    const twice = all.find((t, i) => all.findIndex((u) => u.name === t.name) !== i);
    if (twice) throw new Error(B.modules.toolClash(twice.name));
    return all;
  }

  /** The kernel's environment and MCP servers with the loaded modules': bin/ in front of PATH, each module's servers added */
  kernel(k: Config["kernel"]): { env: Record<string, string>; mcpServers: Record<string, unknown> } {
    // Only what the modules bring changes anything: a module with no commands and no servers (one that is required, say) leaves both as they are.
    // HH_BIN: a module's bin/ wrapper runs its script through `hh modules run`, which gives the script its environment
    // (straight from the env.sh writeEnv left in HH_STATE_DIR when there is one, without starting node)
    const r = this.loaded[0]?.ctx.role;
    const env = this.binDirs.length && r ? { ...k.env, PATH: [...this.binDirs, k.env.PATH ?? process.env.PATH ?? ""].join(":"), HH_BIN: r.hhBin, HH_NODE: process.execPath, HH_STATE_DIR: r.stateDir } : k.env;
    if (!this.loaded.some((l) => Object.keys(l.spec.mcp ?? {}).length)) return { env, mcpServers: k.mcpServers };
    const mcpServers: Record<string, unknown> = { ...k.mcpServers };
    for (const { spec, ctx } of this.loaded) {
      for (const [name, s] of Object.entries(spec.mcp ?? {})) {
        if (name === "self" || name in mcpServers) throw new Error(B.modules.mcpClash(name, spec.name));
        // a server that cannot start (its environment not installed) is not handed to the kernel: a session would wait on it for nothing
        if (s.ready && !s.ready(ctx)) { if (!this.leftOut.has(name)) { this.leftOut.add(name); ctx.log("warn", "modules: an MCP server is left out, it cannot start (hh modules doctor says why)", { server: name }); } continue; }
        const cmd = s.command.includes("/") && !isAbsolute(s.command) ? join(ctx.dir, s.command) : s.command;
        mcpServers[name] = { command: cmd, args: [...(s.args ?? [])], env: { ...commandEnv(ctx, this.binDirs), ...s.env } };
      }
    }
    return { env, mcpServers };
  }

  /**
   * Leave each loaded module's environment in its state dir (hhd does at start): env.json (the HH_* facts and PYTHONPATH)
   * for whatever runs its scripts from outside HH, env.sh (the same, and its bin/ dirs in front of PATH) for bin/hh, which
   * then runs `hh modules run <module> …` without node. A module that is off has neither.
   */
  writeEnv(cfg: Pick<Config, "stateDir">): void {
    for (const f of this.found) {
      const l = this.loaded.find((x) => x.spec.name === f.name);
      const dir = join(cfg.stateDir, "modules", f.name);
      if (!l) { for (const n of ["env.sh", "env.json"]) rmSync(join(dir, n), { force: true }); continue; }
      const env = Object.fromEntries(Object.entries(commandEnv(l.ctx, this.binDirs)).filter(([k]) => k !== "PATH"));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "env.json"), `${JSON.stringify(env, null, 1)}\n`, { mode: 0o600 });
      chmodSync(join(dir, "env.json"), 0o600);   // mode only applies to a new file: one written before (wider) is narrowed too
      const q = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;
      const sh = [...Object.entries(env).map(([k, v]) => `export ${k}=${q(v)}`), `export PATH=${q(this.binDirs.join(":"))}:"$PATH"`];
      writeFileSync(join(dir, "env.sh"), `${sh.join("\n")}\n`, { mode: 0o600 });
      chmodSync(join(dir, "env.sh"), 0o600);
    }
  }

  /** Run a script of a loaded module, for HH's own code that leans on one (null: that module is not on) */
  run(module: string, script: string, argv: readonly string[], o?: { timeoutMs?: number }): Promise<CommandResult> | null {
    return this.loaded.find((l) => l.spec.name === module)?.ctx.run(join("scripts", script), argv, o) ?? null;
  }

  /** The source kinds the loaded modules declare */
  senseKinds(): Array<Partial<Record<SourceKind, readonly string[]>>> {
    return this.loaded.flatMap((l) => (l.spec.senseKinds ? [l.spec.senseKinds] : []));
  }

  /** The loaded modules' guide.md, for the prefix */
  guides(): string {
    return this.loaded.filter((l) => l.guide).map((l) => `<guide module="${l.spec.name}">\n${l.guide}\n</guide>`).join("\n\n");
  }

  /** Each loaded module's situation hook, bounded by its own time limit; a failure is logged and gives "" */
  situationHooks(): Array<{ name: string; run(): Promise<string> }> {
    return this.loaded.flatMap(({ spec, ctx }) => spec.hooks?.situation ? [{ name: spec.name, run: () => runHook(spec.hooks!.situation!, ctx, "situation") }] : []);
  }
}

/** Run a hook or timer body within its time limit; a throw or a timeout is logged and gives "" */
export async function runHook(h: ModuleHook, ctx: ModuleContext, what: string): Promise<string> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(B.modules.timedOut(Math.round(h.timeoutMs / 1000)))), h.timeoutMs); });
  try { return await Promise.race([h.run(ctx), late]); }
  catch (e) { ctx.log("warn", `modules: ${what} failed`, { module: ctx.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) }); return ""; }
  finally { clearTimeout(timer); }
}

/** The environment a module's commands run in (docs/contracts/modules.md) */
export function commandEnv(ctx: ModuleContext, binDirs: readonly string[]): Record<string, string> {
  const r = ctx.role;
  return {
    PATH: [...binDirs, process.env.PATH ?? ""].join(":"),
    PYTHONPATH: [join(BUILTIN_ROOT, "_lib"), process.env.PYTHONPATH].filter(Boolean).join(":"),
    // the on modules' bin/ dirs again, for a script started outside HH with only env.json (hh_env puts them on PATH)
    HH_MODULE_BINS: binDirs.join(":"),
    HH_WORKSPACE: r.workspace, HH_STATE_DIR: r.stateDir, HH_MODULE_DIR: ctx.dir, HH_MODULE_STATE: ctx.stateDir,
    HH_ROLE_ID: r.id, HH_ME: r.me, HH_OWNER: r.owner, HH_TZ: r.timezone, HH_LANG: r.lang, HH_BIN: r.hhBin, HH_NODE: process.execPath, HH_PYTHON: r.python,
    // the instance file HH runs with, for the hh a script calls from wherever it was started (launchd, the role's shell)
    ...(process.env.HH_CONFIG ? { HH_CONFIG: process.env.HH_CONFIG } : {}),
    HH_MODULE_CONFIG: JSON.stringify(ctx.config),
    ...ctx.ownEnv,
  };
}

/** A file or directory of a module in the role's language (name.<lang>.ext, or <name>.<lang> for a directory), else the plain one */
export function inLang(cfg: Config, dir: string, name: string): string {
  const dot = name.lastIndexOf(".");
  const lang = cfg.lang || DEFAULT_LANG;
  const own = join(dir, dot > 0 ? `${name.slice(0, dot)}.${lang}${name.slice(dot)}` : `${name}.${lang}`);
  return existsSync(own) ? own : join(dir, name);
}

/** A module's context. binDirs is a getter's source: the loaded set is known only after every context is made */
/** How a module's script is run: for real (runScript), or by the parity world's recording runner */
export type ScriptRunner = typeof runScript;

export function contextOf(cfg: Config, spec: ModuleSpec, dir: string, config: Record<string, unknown>, binDirs: () => readonly string[], log?: Pick<Logger, "info" | "warn" | "error">, remind?: ModuleContext["remind"], peers?: ModuleContext["peers"], runner: ScriptRunner = runScript): ModuleContext {
  const ctx: ModuleContext = {
    name: spec.name, dir, stateDir: join(cfg.stateDir, "modules", spec.name), config, role: roleFacts(cfg),
    ...(spec.env ? { ownEnv: spec.env(config, roleFacts(cfg)) } : {}),
    log: (level, msg, data) => log?.[level](msg, { module: spec.name, ...data }),
    run: (script, argv, o = {}) => runner(join(dir, script), argv, {
      python: cfg.tools.python, cwd: cfg.workspace, stateDir: ctx.stateDir,
      env: { ...process.env, ...commandEnv(ctx, binDirs()) }, ...o,
    }),
    channelCheck: async (name, app) => {
      const a = BRIDGE_APPS[app];
      if (!a) throw new Error(`no bridge for ${app}`);
      return channelCheck(cfg, name, a);
    },
    ...(remind ? { remind } : {}),
    ...(peers ? { peers } : {}),
  };
  return ctx;
}

/**
 * The modules of this role: found, and those that are on loaded. A declaration that is on but unsound is logged and not
 * loaded (hh modules doctor says why); a name used twice throws.
 */
export async function loadModules(cfg: Config, o: { log?: Pick<Logger, "info" | "warn" | "error">; roots?: readonly ModuleRoot[]; run?: ScriptRunner } = {}): Promise<Modules> {
  const found = await discover(o.roots ?? moduleRoots(cfg), cfg.lang ?? "");
  const loaded: Loaded[] = [];
  let mods: Modules | null = null;
  const binDirs = () => mods?.binDirs ?? [];
  const peers = () => (mods?.loaded ?? []).map((l) => ({ name: l.spec.name, dir: l.ctx.dir, senses: l.spec.senses ?? [], config: l.ctx.config }));
  for (const f of found) {
    if (!f.spec) { if (cfg.modules?.[f.name]?.enabled) o.log?.error("modules: not loaded", { module: f.name, error: f.error }); continue; }
    if (!isOn(cfg, f.spec)) continue;
    try {
      const ctx = contextOf(cfg, f.spec, f.dir, configOf(cfg, f.spec), binDirs, o.log, (text, due) => mods?.kernelHooks?.remind(text, due), peers, o.run);
      // guide: false keeps the module's guide out of the prefix (a role moving over keeps its own words a while)
      const guideFile = cfg.modules?.[f.name]?.guide === false ? "" : inLang(cfg, f.dir, "guide.md");
      loaded.push({ spec: f.spec, ctx, guide: guideFile && existsSync(guideFile) ? readFileSync(guideFile, "utf8").trim() : "" });
    } catch (e) {
      o.log?.error("modules: not loaded", { module: f.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) });
    }
  }
  mods = new Modules(found, loaded);
  if (loaded.length) o.log?.info("modules: loaded", { modules: loaded.map((l) => l.spec.name) });
  return mods;
}
