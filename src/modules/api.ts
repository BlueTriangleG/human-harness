// Everything the kernel gives a module is in this file (docs/contracts/modules.md). A built-in module's module.ts imports
// from here and from zod, nothing else under src/; a role's own module is data (module.json) and imports nothing.
import type { ZodRawShape } from "zod";
import type { SourceKind } from "../gate/sources.ts";
export { command } from "./command.ts";
/** Parameter and config shapes */
export { z } from "zod";
/** HH's own way of putting a command's output for the role (stdout, stderr, the exit code, cut at 6000 characters) */
export { summarize } from "../util/run.ts";
/** The core language pack's tool text: built-in modules keep their words there in this first round */
export { T } from "../lang/index.ts";

/** The region roles a module tool can be given to */
export const REGION_ROLES = ["main", "side", "deep", "speech", "perception", "hippocampus"] as const;
export type RegionRole = (typeof REGION_ROLES)[number];

/** What a module may know about the role it runs in */
export interface RoleFacts {
  id: string;
  workspace: string;
  stateDir: string;
  me: string;
  owner: string;
  timezone: string;
  lang: string;
  /** How to run the `hh` command */
  hhBin: string;
  /** The python a .py script runs under */
  python: string;
}

export interface CommandResult { code: number; stdout: string; stderr: string; timedOut: boolean }

/** What a module gets when one of its tools, hooks, timers or checks runs */
export interface ModuleContext {
  name: string;
  /** The module's own variables (ModuleSpec.env) */
  ownEnv?: Record<string, string>;
  /** The module's own directory */
  dir: string;
  /** <stateDir>/modules/<name>/ — the module's own state */
  stateDir: string;
  /** The declared defaults with the instance config's modules.<name> over them */
  config: Readonly<Record<string, unknown>>;
  role: RoleFacts;
  log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>): void;
  /** Run one of the module's scripts by the command convention (environment, working directory, time limit) */
  run(script: string, argv: readonly string[], o?: { stdin?: string; timeoutMs?: number }): Promise<CommandResult>;
  /** What the role's bridged channel of this name still lacks (file, bridge, connection, the owner's ids); app: the bridge under bridge/ */
  channelCheck(name: string, app: string): Promise<CheckItem[]>;
  /** Leave the role a reminder: at due (ms, default now) it wakes the role like any reminder. Only inside hhd, not in hh modules */
  remind?(text: string, due?: number): void;
  /** Inside a tool call: what the role's notebook brings up for a topic, as the role is shown it ("" when nothing, or no notebook) */
  notes?(topic: string, binding: "goals"): Promise<string>;
  /** The loaded modules, this one too: each one's name, directory, the sense sources it owns and its config. The senses
   *  collector builds its source table from them. Only inside hhd */
  peers?(): ReadonlyArray<{ name: string; dir: string; senses: readonly string[]; config: Readonly<Record<string, unknown>> }>;
}

export interface ModuleTool {
  name: string;
  description: string | (() => string);
  /** A function when its descriptions come from the language pack: it is read when the tools are built, not at import */
  shape: ZodRawShape | (() => ZodRawShape);
  /** Which regions get it; unset = main and side */
  regions?: readonly RegionRole[];
  /** What the role reads back. A throw comes back to the role as a failure line, never into the kernel */
  handler(args: Record<string, unknown>, m: ModuleContext): Promise<string>;
}

/** A hook or timer body: its text, or a throw (logged; that part is left out) */
export interface ModuleHook { timeoutMs: number; run(m: ModuleContext): Promise<string> }

export interface ModuleTimer {
  name: string;
  everyMs: number;
  run: ModuleHook;
  /** Runs even when hhd is down: `hh modules install` makes it a launchd job and hhd leaves it alone */
  standalone?: boolean;
}

/** A long-running process started with hhd, recorded under the role's state directory and stopped by that record */
export interface ModuleProcess { name: string; script: string; argv?: readonly string[] }

/**
 * A long-running process that lives outside hhd: `hh modules install` makes it a launchd job that is kept alive, and hhd
 * neither starts nor stops it — a restart of hhd leaves it running. (A process, above, is hhd's own child.)
 * script: relative to the module's directory, run with HH's node; label: the job's label after the role's prefix
 * (default "<module>.<name>"); when: install it only then (e.g. once the thing it serves is configured).
 */
export interface ModuleService {
  name: string;
  script: string;
  argv?(m: ModuleContext): readonly string[];
  label?(m: ModuleContext): string;
  when?(m: ModuleContext): boolean;
}

/** An MCP server handed to the kernel as it is; a relative command is taken from the module's directory */
export interface McpServer {
  command: string; args?: readonly string[]; env?: Readonly<Record<string, string>>;
  /** Whether the server can start at all (its Python environment installed, say); false: it is left out of the kernel's servers, doctor says why. Unset: always */
  ready?: (m: ModuleContext) => boolean;
}

export type CheckStatus = "ok" | "setup" | "broken";
/** One line of a self-check: fine, needs a person to set something up (says what), or broken (says why) */
export interface CheckItem { status: CheckStatus; text: string }

export interface ModuleSpec {
  name: string;
  summary: string;
  /** Part of the kernel kept in a module's layout: loaded whatever the config says */
  required?: boolean;
  config?: { shape: ZodRawShape; defaults?: Record<string, unknown> };
  requires?: {
    /** requirements.txt, relative to the module */
    python?: string;
    /** Programs looked up on PATH */
    bins?: readonly string[];
    /** A directory with a package.json and lockfile, relative to the module: installed with npm ci, no install scripts */
    npm?: string;
    /** Other modules that must be on */
    modules?: readonly string[];
    /** What a person sets up once (a login, a key); check() says whether it is done */
    setup?: readonly string[];
  };
  tools?: readonly ModuleTool[];
  /** The sense sources this module owns */
  senses?: readonly string[];
  /** Which kind (src/gate/sources.ts) each of those sources is, e.g. { hands: ["cc"] }; the role's own table (senses.sources) wins for a source it names */
  senseKinds?: Partial<Record<SourceKind, readonly string[]>>;
  hooks?: { situation?: ModuleHook; beforeSleep?: ModuleHook; wake?: ModuleHook };
  timers?: readonly ModuleTimer[];
  processes?: readonly ModuleProcess[];
  services?: readonly ModuleService[];
  mcp?: Readonly<Record<string, McpServer>>;
  /** Variables of its own for everything of this module HH starts (and env.json, env.sh), worked out once from its
   *  config: what a script would otherwise start a process to read */
  env?(config: Record<string, unknown>, role: RoleFacts): Record<string, string>;
  check?(m: ModuleContext): Promise<CheckItem[]>;
}

export const defineModule = (spec: ModuleSpec): ModuleSpec => spec;
