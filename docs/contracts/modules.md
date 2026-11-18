# Modules

Owner: framework. Code: `src/modules/` (`api.ts` is everything a module gets; `load.ts` finds and loads; `command.ts` is the
command convention; `timers.ts` runs timers; `doctor.ts` is `hh modules`). Design: the module protocol of 11-14.

A module is one capability a role can have: tools, the text that teaches the role to use them, its config, its own
state directory, and optionally sense sources, hooks, timers, long-running processes and MCP servers. Each role turns
modules on and off in its instance config. With no module on, HH behaves exactly as without this mechanism.

## Where modules are found

| Place | May hold | Loaded |
|---|---|---|
| the repo's `modules/<name>/` (built-in) | `module.ts` (code) or `module.json` | when on, or when it is `required` |
| the workspace's `modules/<name>/` (the role's own) | `module.json` only | when on |
| each directory in `modulePaths` | `module.json` only | when on |

A directory whose name starts with `_` or `.` is not a module (`modules/_lib/` holds the Python helper). The name in the
declaration must be the directory's name. **Two modules with one name stop hhd.** A module outside the repo that brings
`module.ts` (or `.js`, `.mjs`) is refused: the role can write those places, and hhd holds what the role must not decide
(who may approve, the filter before sending). A built-in module is framework code and goes through the guarded deploy.

Turning one on (instance config):

```json
{ "modules": { "goals": { "enabled": true, "dataFile": "memory/goals/goals.json" } } }
```

`"guide": false` keeps that module's guide out of the prefix. Everything under `modules.<name>` except `enabled` and
`guide` is the module's config, laid over its declared defaults (one level)
and checked against its declared shape. An unsound declaration or config is logged and not loaded; `hh modules doctor`
says why.

## A module's directory

```
modules/<name>/
  module.ts | module.json   the declaration
  scripts/                  what its command tools run
  bin/                      commands the role runs in its shell; every on module's bin/ goes in front of PATH.
                            A wrapper is one line: exec "$HH_BIN" modules run <module> <script> "$@"
  guide.md                  a few lines in every prefix, right after the runtime note
  skills/<category>/<book>/ manuals; `hh modules install` links each to <shelf>/<category>/<book>
  requirements.txt          Python packages
  tests/
```

Text the role reads comes in its language: `guide.<lang>.md` is taken before `guide.md`, and `skills.<lang>/` before
`skills/` (`<lang>` is the instance's `lang`, default `zh`). Write the plain one in English (the repo's language) and
add a file per language the role may speak. A built-in module's tool text stays in the core language pack (`T.*`).

What a module's scripts say to the role — replies, usage, what a sense reports, what they write into files the role
reads — is not written in the scripts. It lives in `texts.json` (English) and `texts.<lang>.json`, one entry per
sentence with named holes (`"added": "Set {id} ({level}): {title}"`), and a script asks for a sentence by name:

```python
from hh_env import hh, words
say = words(__file__)            # this module's sentences in the role's language, else in English
print(say("added", id=gid, level=level, title=title))
```

`{me}` and `{owner}` are filled with the role's and its owner's names; a sentence never spells a name out. Every
language file has the same entries with the same holes as `texts.json` (a test holds them to it). A form that other
code reads stays as that code expects it, in every language: `Claude Code「name」` in a helper's report. What a script
writes for code to read back in the role's language goes into its forms (`forms.json`, `forms.<lang>.json`, read with
`forms(__file__)`, unformatted; `form.every(key)` gives every language's, for reading): the senses script's header
(`[感官]`, `[senses]`; `brain.senseHeader` in the packs), its body marker and the end of a probe's tag that asks for
the role (`·要你处理]`, `·needs you]`), which HH and the gate read in every language (`docs/contracts/senses.md`).
goals, load-guard, senses, helpers, watchdog, stickers, media and bilibili's sense script keep their sentences this
way; the night's scripts and the bilibili server are still written in Chinese.

## The declaration

`module.ts` default-exports `defineModule({...})` (types in `src/modules/api.ts`):

| Field | What |
|---|---|
| `name`, `summary` | required |
| `required` | part of the kernel kept in a module's layout: loaded whatever the config says |
| `config` | `{ shape, defaults }` (zod shape) |
| `requires` | `python` (requirements file), `bins` (looked up on PATH), `modules` (must be on), `setup` (things a person does once; the module's `check` says whether they are done) |

`requires.npm` names a directory with a `package.json` and a lockfile (relative to the module): `hh modules install`
runs `npm ci --ignore-scripts --omit=dev` there when nothing is installed or the lockfile is newer. A module's context
also has `channelCheck(name, app)`: what the role's bridged channel still lacks (`docs/contracts/channels.md`).
| `tools` | function tools (`handler(args, ctx)`) or command tools (`command({...})`); `regions` names which regions get each (default main and side). A tool's words from the language pack are given as functions (`description: () => T.x.description`, `shape: () => ({ … .describe(T.x.params.y) })`): they are read when the tools are built, in the role's language, not when the module is imported |
| `senses` | the sense sources this module owns |
| `hooks` | `situation` (a short part of the wake-up brief), `beforeSleep`, `wake`; each with its own time limit, a failure only leaves that part out |
| `timers` | `{ name, everyMs, run, standalone? }`: hhd runs them; a standalone one is a launchd job and hhd leaves it alone |
| `processes` | long-running processes, recorded under the role's state directory; one that ends is started again 10 s later; its output goes to `<name>.log` in the module's state dir |
| `env(config, role)` | variables of its own for everything of this module HH starts (and `env.json`, `env.sh`), worked out once from its config, so a script need not start a process to read it |
| `services` | `{ name, script, argv?, label?, when? }`: long-running processes that live outside hhd. `hh modules install` makes each a launchd job that is kept alive (label `<the role's prefix>.<label or module.name>`); hhd neither starts nor stops it, so it outlives a restart of hhd. `when` false: not installed. A service launchd already runs under that label is never written, loaded or restarted |
| `mcp` | MCP servers handed to the kernel as they are; `self` is HH's own name and cannot be used |
| `check` | the self-check: a list of `{ status: "ok" \| "setup" \| "broken", text }` |

Besides running its scripts, a module's context can `remind(text, due?)`: leave the role a reminder that wakes it
like any other (only inside hhd; absent under `hh modules`). Sense events and sending are not given yet.

A tool's or MCP server's name that is already taken (by HH or another module) stops the start.

`module.json` (a role's own module) is data and has only: `name`, `summary`, `config.defaults`, `requires`, `tools`,
`senses`, `timers`, `mcp`. Text fields are a string or `{ "<lang>": "...", ... }` (the role's language, else the first).
A tool:

```json
{ "name": "note", "description": { "en": "jot one down" },
  "params": { "text": { "type": "string", "description": "what" }, "due": { "type": "string", "description": "when", "optional": true } },
  "script": "scripts/note.sh", "args": ["add", "{text}", "--due", "{due}"], "stdin": "json", "regions": ["main"], "timeoutMs": 8000 }
```

`args` is a template: `{param}` is replaced by the argument; a slot whose argument is missing is left out, and so is the
option name right before it. `"stdin": "json"` also hands the whole argument object to stdin. A timer:
`{ "name", "everyMinutes", "script", "args", "timeoutMs", "standalone" }`.

## The command convention

A command runs `scripts/...` of its module: a `.py` file under the role's Python (`tools.python`), anything else as an
executable. No shell; the working directory is the workspace; stdin is closed after the given text.

| Variable | Value |
|---|---|
| `HH_WORKSPACE`, `HH_STATE_DIR` | the role's workspace and state directory |
| `HH_MODULE_DIR` | the module's directory |
| `HH_MODULE_STATE` | `<stateDir>/modules/<name>/` (made before each run) |
| `HH_ROLE_ID`, `HH_ME`, `HH_OWNER` | the role's id and names |
| `HH_TZ`, `HH_LANG` | timezone, language pack |
| `HH_BIN` | the `hh` command of this checkout; it starts the CLI on `HH_NODE` |
| `HH_NODE`, `HH_CONFIG` | the node HH runs on and its instance file, so `hh` works from wherever a script was started |
| `HH_PYTHON` | the python a `.py` script runs under (`tools.python`) |
| `HH_MODULE_CONFIG` | the module's config, JSON |
| `PATH` | every on module's `bin/` first, then the inherited PATH |
| `HH_MODULE_BINS` | those `bin/` dirs again: `hh_env` puts them in front of PATH when a script is started outside HH with only `env.json` |
| `PYTHONPATH` | `modules/_lib` first (`from hh_env import hh`) |

What the role reads: stdout, trimmed, cut at 6000 characters with a note. A non-zero exit is a failure and reports the
last 20 lines of stderr (stdout when stderr is empty). Every run has a time limit (default 60 s); past it the process
is killed and the role is told so. A tool never throws into the kernel: a throw comes back as one failure line.

The kernel sessions get the same PATH, `HH_BIN`, `HH_NODE` and `HH_STATE_DIR` (in `kernel.env`) and every on module's MCP servers next to
`kernel.mcpServers`.

## hh modules

Runs in the CLI process; hhd need not be up.

- `hh modules list` — name, on / off / kernel, built-in or the role's, summary.
- `hh modules doctor`, `hh modules check <name>` — per module the worst of: the declaration, the config, each program
  in `requires.bins`, each module in `requires.modules`, the requirements file, manuals that would land on a page the
  role already has, and the module's own `check` (30 s limit). Exit code 1 when one is broken.
- `hh modules install` — links each on module's manuals onto the shelf. A page that is already there and is not this
  module's link is not touched; it is reported.
- `hh modules run <module> <script> [args…]` — runs `scripts/<script>` of that module under its environment, with no
  time limit, and exits with the script's code. This is what a `bin/` wrapper calls, so a command the role types in
  its shell sees the same environment as the module's tools. When hhd has left the module's `env.sh` (below),
  `bin/hh` runs the script itself without starting node: same environment, working directory and exit code; stdin
  and stdout pass straight through.
- `hh modules env` — writes every on module's environment into its state dir, as hhd does at start: `env.json` (the
  `HH_*` variables and `PYTHONPATH` above, for whatever runs a module's scripts from outside HH) and `env.sh` (the same
  as `export` lines, with the `bin/` dirs put in front of PATH). A module that is off has neither. Prints each on
  module and its state dir.
