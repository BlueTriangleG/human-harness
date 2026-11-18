# Contracts between the framework and a role

HH is a framework; a role is a directory (an instance config plus a workspace). The framework knows no particular
role: a role's names, channels, paths and file names live in its own instance config.

There are still a few places where the framework and a role's workspace have to agree — the format a role's script
writes, where the framework looks for which file, which reply means what. Each of them is written down here as one
contract. `hh new` builds a new role's skeleton from these contracts; whoever changes a contract changes the code
that consumes it and this document together.

The owner of the consuming code writes and maintains the contract. This index belongs to the framework.

| Contract | What it says | Consumed by | Owner | State |
|---|---|---|---|---|
| `instance-config.md` | Every key of the instance config in three tiers: what a new role must write, what most roles write, what is rarely touched; how the layers merge and what the framework refuses to start without | `src/config.ts`, `src/new.ts` | framework | written |
| `lang.md` | The language pack: where text lives, how code reads it, how the role's names are bound, how to name and add an entry, how to add a language | every module under `src/` | framework | written |
| `senses.md` | What an event handed over by a role's sense scripts looks like (fields, the source table, the event log), and the safety rules that must hold | `src/gate/` | gate | written, landing |
| `notebook.md` | The layout of the learning notebook in a workspace (which file and directory names are part of the contract) | `src/learning/` | learning | written, landing |
| `channels.md` | What a channel is (the shapes, the way in and the one way out), the `channels` table of the instance config, the hook before sending, how to add an implementation | `src/channels/`, `src/brain.ts` | framework | written, landing |
| `night.md` | The night's consolidation: what the "which days are still pending" command prints, where the organizer may write, the organizer's two reply tokens | `src/brain.ts`, `src/sleep/` | sleep | written, landing |
| `hands.md` | Helper sessions: the format of a session file, how a helper's report enters the senses | `src/console/`, `src/gate/` | console (file format), gate (reports) | written |
| `modules.md` | What a module is, where modules are found, the declaration (`module.ts` / `module.json`), the command convention, `hh modules` | `src/modules/`, `src/brain.ts`, `src/hhd.ts` | framework | written, landing |
| `workspace-layout.md` | What lives where in a role's workspace and who reads or writes it; the skeleton `hh new` makes | `src/persona/layout.ts`, `modules/night/`, `src/new.ts` | framework | written, landing |
| `db-read.md` | The tables and columns of `hh.db` that scripts outside `src/` read | `modules/night/`, `src/store/db.ts` | framework | written |
| `machine.md` | What is shared by the whole machine (the shared repository, the approvals directory, the heavy-job lock) and what is per instance (check directories, who may approve) | `src/repair/`, the guard tool | ops | written |

Rules that hold for every contract:

- A contract names no particular role: no role's name, path or channel. Examples use made-up names.
- The role's side of a contract (where a file lives, what a channel is called) goes into its instance config. The
  framework's default is empty or neutral; empty means "this role does not use it".
- A format that exists only because of an older setup's history is not part of a contract: the code that parses it
  lives under `src/legacy/` and is loaded only when an instance config asks for it.
- Whatever must resist the role itself — who may approve, whose commits count as the role's — does not live in the
  role's instance config (a role can edit it); it lives on the machine's side (see `machine.md`).
- Contracts are written in English.
