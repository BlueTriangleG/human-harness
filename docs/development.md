# Working on HH

What the repository's README leaves out: how HH is put together, the built-in modules, the commands, the layout of the
code, its configuration and its rules. For a role step by step see [new-role.md](new-role.md); for every setting,
[contracts/instance-config.md](contracts/instance-config.md).

## Three layers

| Layer | Where | What it is |
|---|---|---|
| **Kernel** | `src/` | The regions, the central memory and its epochs, the persona and the shared prefix, the schedule, the night's consolidation, the gate in front of the senses, the people list, the one way out (channels), the language packs, the config, the module loader. Always on. |
| **Modules** | `modules/<name>/` | What a role can call and what it is told about it: tools, commands, timers, processes, sense sources, manuals. One protocol for all of them ([contracts/modules.md](contracts/modules.md)). Each is on or off per role (`modules.<name>.enabled`). A role can add its own in its workspace. |
| **Roles** | a directory each | Data only: an instance config, a workspace (persona files, memory, notebook) and a state directory. Several roles can live under one OS user. Nothing about a particular role belongs in this repository. |

A role made with `hh new` starts with every built-in module on, so a new role can do what the first one can.

### Built-in modules

`hh modules list` says which are on and which belong to the kernel (those load whatever the config says).

| Module | What it brings |
|---|---|
| `senses` | Sense collection: looks at every source the on modules define and hands new events to HH |
| `night` | The night's consolidation scripts and the persona snapshot |
| `learning` | The notebook, the shelf of manuals, and the association that brings a page up |
| `browser` | The role's own Chrome |
| `computer` | The Mac's screen, mouse and keyboard (through OpenClaw.app for now) |
| `goals` | The role's own goals at four levels |
| `helpers` | Claude Code helper sessions the role starts, talks to and hears back from |
| `load-guard` | Machine load: a look, a gate before heavy work, shedding load before memory runs out |
| `stickers` | A sticker library the role collects and picks from by mood |
| `base` | The general manuals every role gets: working, learning, replying, using the computer |
| `bilibili` | The role's own Bilibili account (an MCP server) |
| `media` | Voice messages in the role's voice, and watching a video locally |
| `phone` | An Android emulator the role can use |
| `backup` | An off-machine copy of the role's workspace and state |
| `console` | The read-only web console |
| `repair` | Fixing HH itself: the bug notebook, `hh fix` / `hh deploy`, the deploy watchdog |
| `watchdog` | Keeps the bridged channels reachable, tells the owner, and runs the owner's `/cc` round the role |
| `whatsapp` | The role's WhatsApp channel: its bridge as a service that outlives hhd, and a check of the whole path |
| `qq` | The role's QQ channel: its bridge as a service that outlives hhd, and a check of the whole path |

## Making a role

```sh
npm ci
node src/cli.ts new <id> --owner <what it calls its owner> [--dir <path>] [--me <its name>] [--lang zh] [--persona jarvis]
export HH_CONFIG=<dir>/instance.json
node src/cli.ts modules install      # Python environment, manuals, launchd jobs (hhd starts)
node src/cli.ts modules doctor       # every module should be "ok" or "needs setup"
node src/cli.ts tell --from <owner> "hello"
```

A role speaks English unless `--lang` names another pack (`zh` is the other one); the config says `lang` either way.
Write who the role is into `IDENTITY.md`, `SOUL.md` and `USER.md` in its workspace before it starts, or start from a
ready-made persona with `--persona` (`personas/`; `jarvis` is a composed, exacting assistant). A role with no channel
answers `hh tell` on the terminal. The steps in full: [new-role.md](new-role.md).

## Commands

Every command needs `HH_CONFIG` to point at the role's instance file; without it they exit 1. `bin/hh` is the same CLI
for scripts.

```sh
node src/hhd.ts                          # the daemon (normally started by launchd)
node src/cli.ts status                   # what the brain is doing now
node src/cli.ts tell --from <who> "…"    # say something to the role
node src/cli.ts events 30                # the last 30 entries of the central memory
node src/cli.ts sleep | pageturn         # send it to sleep / turn the page by hand
node src/cli.ts mem <action> …           # event memory: stats, search, person, export, …
node src/cli.ts learn <action> …         # the notebook: scan, stats, week, …
node src/cli.ts modules list | doctor | check <name> | install [--no-start] | env | run <module> <script> […]
node src/cli.ts new <id> --owner <name> [--persona <name>]   # lay out a new role
node src/cli.ts lang status              # what each language pack still reads from the reference pack
node src/cli.ts <command> --help         # the usage, and nothing else
```

## Layout

```
bin/hh                the CLI for scripts (runs a module's script without starting node when it can)
config/
  default.json        the framework's defaults
  new-role.json       what `hh new` writes on top of them
modules/<name>/       a built-in module: module.ts, scripts/, bin/, its guide and manuals, its tests
modules/_lib/         what a module's script imports to read its environment (hh_env) and the machine (machine_darwin, machine_linux)
personas/<name>/      a ready-made persona `hh new --persona <name>` starts a role from
src/
  hhd.ts              the daemon: starts the brain, ticks, serves the control socket
  cli.ts  control.ts  the hh command and the control socket's protocol
  brain.ts            the only orchestrator: wires everything below together
  config.ts  new.ts
  services/           the jobs under the machine's service manager: launchd on macOS, systemd's user units on Linux
  regions/  kernel/   the regions, and the adapter to Claude Code (an SDK driver; a fake one for tests)
  memory/  epoch/  store/      central memory, event memory, epochs (page turns) and compressed blocks, SQLite
  persona/            persona files, the shared prefix, people, the manuals plugin
  brainstem/  thalamus/  basal/   the clock and sleep states; input gating and reminders; claiming work and the single outlet
  gate/               what a sense event does: wake the role now, go into a digest, or be dropped
  sleep/              the night
  learning/           the notebook, the shelf, the association
  channels/  gateway/ the way in and the one way out; the client of an OpenClaw gateway
  tools/  browser/    HH's own tools
  modules/            the loader, `hh modules`, timers and processes
  repair/             self-repair, deploys and the watchdog
  console/            the read-only web console
  lang/               the language packs: en (the default) and zh (still the reference whose shape the packs share)
  parity/             replays: what a role reads before and after a change, compared entry by entry
relay/                an OpenClaw plugin that hands inbound messages to hhd, for a role whose channels go through a gateway
ops/                  the deploy's instance check and the launchd templates
test/                 unit tests and end-to-end brain tests on the fake kernel
docs/                 the documentation (docs/README.md)
```

## Configuration

Three layers, later over earlier: `config/default.json`, the defaults of the role's language pack, and the role's
instance file (`HH_CONFIG`). Every key is in [contracts/instance-config.md](contracts/instance-config.md). A module's own settings sit under
`modules.<name>` and are described by its `module.ts`.

## Rules of the code

- Modules talk to each other only through interfaces; `brain.ts` is the only orchestrator.
- Every module owns its own tables. Every threshold lives in config.
- No role's name, path, number or account goes into this repository (`test/no-role-trace.test.ts` searches the code,
  the modules, the docs and the tests for them). The role's side of anything goes into its instance config; the
  framework's default is empty or neutral.
- Text the role reads lives in the language packs, not in code.
- Comments, docs and commit messages are in English.

```sh
npm test               # everything
npm run typecheck      # tsc --noEmit
```

## Status in detail

- **Platforms.** macOS 14 or newer. Linux: the layer that runs the role's jobs has a Linux side (systemd user units) and
  `./setup` goes on without the app, but a whole run has not been checked end to end yet. WSL2 and Windows: not yet.
- **Channels.** A new role has no chat channel: you talk to it in its window, or with `<id> "…"`. A channel is carried
  either by a bridge (`via: bridge`: a small process of HH's own that holds the chat app's connection —
  `bridge/whatsapp/`, `bridge/qq/`, run by the `whatsapp` and `qq` modules) or by the OpenClaw gateway (`via: gateway`,
  the older path). [new-role.md](new-role.md) says how to give a role one.
- **The watchdog and `/cc`.** The `watchdog` module looks at every bridged channel once a minute, restarts a bridge that
  stopped answering, and tells the owner when a restart cannot help (logged out, credentials refused). A private message
  from the owner that opens with `/cc` never reaches the role: the bridge sets it aside and the watchdog starts a Claude
  Code session with the owner's words. Who the owner is comes from a file on the machine's side that the role cannot
  write ([contracts/machine.md](contracts/machine.md)).
- **Languages.** English is the default: a role made without `--lang` speaks English. The English pack is complete
  (`hh lang status` lists nothing left) and the modules' manuals have English pages. The modules' scripts keep what
  they say in language files with an English one (texts.json, texts.<lang>.json), the Bilibili server's tool
  descriptions and results included. What a script writes for code to read back (a header, a tag, a commit subject, the
  words a check matches) is in its forms (forms.json, forms.<lang>.json): written in the role's language, read in every
  one. Left in Chinese on purpose: what is B站's own (its zone names, the words the code reads in its pages and
  answers) and the verdicts stored in the seen list.
  The night's general organizing guide has an English and a Chinese version; a role gets the one in its language, and
  what it has the organizer write (the bug book `memory/bugs.md` and its `## Ask <owner>`, `[pinned]`, the notebook's
  pages, the report's `Unsure`) is read in either language. What an English role still meets in Chinese: the
  full-width brackets of an anchor (`〔anchor: …〕`, `（#12）`, an event's `（e0007）` in what HH writes about people), the
  `＃` that stands for a `#` in the night's material, the repair trailers' `通过` and the entry check's row marks; the
  thread files and soul blocks of a role that has them (a new role has neither) are read only in Chinese.
  Dates follow the pack's locale (zh-CN, en-US).
  `--lang zh` makes a Chinese role.
- **The kernel's tools are a fixed list** (`kernel.builtinTools`): a region gets HH's own tools, its modules' tools and
  the Claude Code tools named there, nothing else. A tool Claude Code adds later does not appear by itself, and the
  connectors of the logged-in account are not loaded.
- **Ready-made personas.** `hh new --persona <name>` starts a role from one of `personas/` (`personas/README.md` lists
  them).
- The `computer` tool still goes through OpenClaw.app, so the gateway stays for it for now.
