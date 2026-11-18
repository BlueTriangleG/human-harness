# Helper sessions

A helper is a Claude Code session the role itself sends off to do a piece of work. Starting a helper, talking to it
and collecting its result is the `helpers` module (`modules/helpers/`): its script `scripts/cc.py` does the work, the
role runs it as the `helper` command, and HH's `hands` tool runs the same script. A role has helpers when that module
is switched on in its instance config.

The module's script is the only writer of the records below. hhd and the console only **read** them.

Two parts: the session file (owned by the console) and how a helper's report reaches the role (owned by the gate).

## 1. The session file (console)

Read by:

- the console's helpers panel and the view of one helper's steps: `workers` and `findTranscript` in
  `src/console/data.ts`, served as `/api/workers` and `/api/worker`;
- hhd at start-up, when it drops names in its status that are not helpers: `ghostHelpers` in
  `src/basal/lifecycle.ts`, called from `src/brain.ts`. It asks one thing only: does this name have a session file.

### Where

One key names the folder, for the writer and the readers alike: `modules.helpers.sessionsDir`, an absolute path; unset,
that is `sessions/` in the module's own state folder (`<stateDir>/modules/helpers/sessions`). The module's script
decides it that way, and hhd and the console decide it the same way (`helperSessionsDir` in `src/basal/dispatch.ts`),
so a new role's helpers show without anything being set. The console also takes the environment variable `HH_CC_DIR`,
which wins when set.

With the module off the console shows no helpers panel (`/api/workers` answers `"configured": false`) and the start-up
clean-up goes by the name alone.
A folder that does not exist yet is not an error: the role has helpers, none so far.

### One file per session

`<name>.json`, directly in that folder.

- The console lists a file when `<name>` is 1 to 80 characters out of ASCII letters, digits, `.`, `_` and `-`, and
  does not start with `.`. The module accepts other names too (any letters, CJK included), so a helper with such a
  name works and is not listed.
- `<name>.settings.json` beside it is the Claude Code settings file the module starts that session with (it carries
  the path of the module's hook, `scripts/cc_inbox_hook.py`). `events.jsonl` in the same folder is the module's queue
  of reports. The readers open neither.
- The content is one JSON object. A file that cannot be read or is not JSON is skipped.

The readers take the fields below and nothing else. No other field leaves the server, so the module may keep whatever
it needs in the same object (a token, for example).

| field | type | meaning | when absent |
|---|---|---|---|
| `session_id` | string | The helper's Claude Code session id: 8 to 64 characters out of hexadecimal digits and `-`. HH looks for `<session_id>.jsonl` under Claude Code's session-record folder and reads the helper's steps from it. | The helper is listed; its steps cannot be shown. |
| `model` | string | The model it runs on. | Not shown. |
| `bg_model` | string | The model actually in use while it runs in the background. Shown instead of `model` when present. | `model` is shown. |
| `state` | string | What it is doing now. `running` and `busy` count as working, `idle` as idle; any other value is shown as written. | Not shown. |
| `turn` | number | How many turns it has done. | Not shown. |
| `dir` | string | Its working directory. | Not shown. |
| `created` | string | When it was started, in the module's own notation; shown as written. | Not shown. |

When the helper last did something is not a field: HH takes the modification time of the session record
(`<session_id>.jsonl`).

### What the readers never do

hhd and the console do not write, change or delete anything in this folder. Starting a helper and speaking to one
happen only through the module's script.

## 2. How a helper's report reaches the role (gate)

### HH learns that a helper was sent from the role's own actions

- The `hands` tool (`src/tools/hhtools.ts`, which runs the module's `cc.py`): `send` with a `name` marks that helper
  as working; `stop` with a `name` marks it as no longer working.
- The same two steps written as a shell command count too: `helper send <name>` / `helper stop <name>`, or the script
  by its path, `python3 …cc.py send <name>` (`helperNameFromAct`, `helperStoppedFromAct` in `src/basal/lifecycle.ts`).
- A helper sent while a region is doing a task is attached to that task (`tasks.addHelper`). For the main region this
  happens only when the helper was born in that task.
- The working helpers are kept in the database, so a restart does not forget them. They show in `hh status`. One still
  working after a day makes HH ask the role once whether to clear it.

### The report is a sense event from a `hands` source

When a helper's turn ends, the module hands HH a sense event the usual way (its source `cc`, collected by the senses
module; [senses.md](senses.md)):

- `src` is a `hands` source. The module declares `cc` as one (`senseKinds` in `modules/helpers/module.ts`); an
  instance can list others under `senses.sources.hands`.
- The text names the helper as `Claude Code「<name>」`.
- The `id` is new for each report.

### The gate passes it through untouched

A `hands` source takes the fixed route before any rule is looked at (`fixedRoute`, `src/gate/fixed.ts`). It is:

- logged in `gate_log` with route and action `hands`;
- handed on at once (`handOff` in `src/gate/gate.ts`);
- never judged, never held by a pause, and never put in the daily digest.

### The brain hands it to whoever sent the helper

`gateToHands`, then `deliverInbound` in `src/brain.ts`:

1. **Several reports in one delivery** are split into one report per helper. Each is delivered on its own, and lines
   that are not reports go with the first.
2. **The named helper** is marked as no longer working.
3. **Where it goes:** to the region doing the task the helper is attached to, if that is a side region that still
   exists. Otherwise it goes to the main region. It never goes to the sense region, because the region that sent the
   work takes the result. Delivering it wakes that region the usual way.
4. **No second de-duplication:** the gate already removed repeats by event id, so the brain does not drop a delivery by
   id again.

### Not neutral yet

- The brain recognises a report by the literal `[cc id=` in the text, and splits a batch on it, instead of using the
  `hands` sources.
- The helper's name comes from the text `Claude Code「<name>」` (`helperOf`, `src/gate/parse.ts`), not from a field of
  the event.
- Dispatch typed as a shell command is recognised from the command line (`helper` or `cc.py`, then `send` or `stop`),
  not reported by the script.

So a second helper tool beside the module would have to send its reports from a source named `cc` and write the
helper's name in that shape.

The neutral form is a `helper` field on the event and the report recognised by its `hands` source. When that lands,
this section changes first.
