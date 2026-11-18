# The machine: what every role on one computer shares

Owner: ops. Read by the repair commands (`src/repair/machine.ts`, `src/repair/instances.ts`) and by the machine's own tools (hh-guard, hh-heavy).

## Shared by every role

| What | Where | Held by |
|---|---|---|
| The framework code | one live copy; each role's hhd records where it runs from in `<stateDir>/repair/boot.json` (`root`), and the repair commands deploy into that copy | the machine |
| The shared repository | `/Users/Shared/hh.git`; its `master` is what gets deployed | the machine |
| The guard directory | `/Users/Shared/hh-guard`: session approvals (`approvals/`), the sensitive-file baseline, the role table | the machine's account; roles read only |
| The heavy-work lock | `/Users/Shared/hh-heavy/lock` (group-writable, no sticky bit, so either account can clear a dead lock) | whoever runs heavy work |

## The role table: `/Users/Shared/hh-guard/instances.json`

One entry per role, keyed by the role's `stateDir` (absolute). It holds what a role must not be able to change about itself, so it lives where the role's account cannot write; the repair commands refuse when the file is writable by the role, when there is no entry for the role's `stateDir`, or when the entry's `user` is not the account running the command.

```json
{
  "<stateDir>": {
    "user": "<system account the role runs as>",
    "author": { "name": "<revert author name>", "email": "<email that marks the role's own commits>" },
    "owner": { "name": "<whose approval counts>", "channels": ["<channel>", "..."] },
    "checkDir": "<optional; default <stateDir>/repair/check>",
    "clone": "<optional; default <stateDir>/repair/src>"
  }
}
```

- `owner`: an approval counts only from this person over these channels, and a rollback is reported to them.
- `author`: the watchdog's revert commits carry it; hh-guard tells the role's own commits from the sessions' by the email.
- Several roles may run under one account; each has its own entry and its own check and clone directories.

## The owner's sender ids: `/Users/Shared/hh-guard/owner-senders/<key>.json`

One file per role; `<key>` is the role's `stateDir` with every run of characters other than letters and digits turned
into one `-` (`/opt/roles/qing/.hh` → `opt-roles-qing-hh`). The machine's account writes it; the role's account can at
most read it.

```json
{ "stateDir": "<the role's stateDir>", "senders": { "<channel>": ["<sender id as that channel reports it>", "..."] } }
```

A channel's bridge reads it at start (`ownerSenders` in `src/repair/instances.ts`) to know the owner's command — a
private `/cc …` from one of these ids is taken out of the role's inbox and handed to the watchdog, which starts a Claude
Code session with the owner's words. That is the one way round the role, so the key to it is kept where the role cannot
write, and apart from the role table, which is printed often. The directory and the file must not be owned by the
role's account nor writable by group or others, and the file's `stateDir` must be the role's; otherwise nobody is the
owner and no message is a command.

## Per role, in its instance config (the role may change these)

- `browser.port`: the debug port (no framework default; two roles on one port would drive each other's browser).
- `launchd.hhd`, `launchd.console`: launchd labels (unset: `ai.hh.hhd`, `ai.hh.console`; `hh new` gives each role its own, `ai.hh.<id>.hhd` and `ai.hh.<id>.console`). The plists come from `ops/launchd/*.plist.template`.
