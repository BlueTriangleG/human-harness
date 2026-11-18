# The instance config

Maintained by the framework. A new key gets its row here in the same change that adds it.

A role is a directory: an instance config (one JSON file) laid over the framework defaults, plus a workspace of files. This page says what that file has to contain and what every key does. It is for an engineer who has never seen the project and must set up a second role, or change one key without breaking anything. Read parts 1 to 3 (about ten minutes) to set a role up; part 4 is a lookup. Contracts about the *content* of files a role provides are not repeated: see [channels.md](channels.md), [senses.md](senses.md), [night.md](night.md), [notebook.md](notebook.md).

The keys come in three tiers. **Tier 1** (part 2): without them the role does not start or is not a role. **Tier 2** (part 3): what most roles write, grouped by what you are trying to do. **Tier 3** (part 4): tuning, and keys kept only for history. A key is described in exactly one tier.

## 1. How the config is put together

`loadConfig` (`src/config.ts`) merges four layers; later layers win.

1. The language pack's defaults (`src/lang/<code>/defaults.ts`; today `memory.people.template` and `learning.generalCategory`). The pack is chosen before the merge from the instance's `lang`, else the default file's, else `zh`.
2. The framework defaults, `config/default.json`.
3. The instance config: the JSON file named by the environment variable `HH_CONFIG`.
4. Overrides passed by the caller (tests, replays, the parallel world). A running role never has this layer.

Objects merge key by key, to any depth. **Arrays and scalars replace**: an instance that sets `skills.names` or `schedule.focusSlots` replaces the default list, it does not extend it. To switch a default off, write the empty value the feature understands (`""`, `[]`); `null` replaces the default with `null`.

After the merge, `skills.roots[*]`, `skills.discover` and `learning.root` are resolved against the workspace, and `browser.userDataDir` against `stateDir`; absolute paths and empty strings are left alone. A blank `schedule.timezone` becomes the machine's timezone. Every other path is resolved by the code that reads it; part 4 says against what.

A process finds its instance file only through `HH_CONFIG` (there is no search). `hhd`, the console and the CLI all read it that way, and the launchd files put it in the job's environment. The one exception: the CLI commands `fix`, `deploy` and `numbers` fall back to `.hh/config.json` under the user's home if `HH_CONFIG` is unset. The console's port is not a config key: `HH_CONSOLE_PORT` is required, and `HH_CC_DIR` overrides the helpers module's sessions folder for the console.

`requireInstance` runs in `hhd`, the console and the CLI right after `loadConfig` and stops the process with a one-line message naming the key and the instance file when:

- `workspace` or `stateDir` is empty or not an absolute path;
- `models.byRole` is not an object, names a role other than `main`, `side`, `deep`, `hippocampus`, `speech`, `perception`, or has an empty model name or one with spaces around it;
- a `models.providers.<name>` lacks `baseUrl`, `keyFile`, `model`, `price.input`, `price.output`, `contextTokens` or `cliVersion`, or its `weekUsd` is not above 0; or `models.providerByRole` names an unknown role or a provider `models.providers` does not have;
- `gate.enabled` is true (the default) and `names.me` or `names.owner` is empty.

Later and elsewhere: every file in `personaFiles` must exist (`hhd` throws on a missing one), an unknown `channels.<name>.via` stops the boot, and the browser throws if `browser.port` is unset. Nothing checks `id`; an empty one gives anonymous labels.

**The rule: the framework defaults name nobody.** Every name, path, port and file name that belongs to a role is in that role's instance config. A default is empty ("this role does not use it"), neutral, or a framework-owned number. Identities that must resist the role itself (who may approve a change, whose commits count as the role's) never come from this file, because a role can edit its own config.

## 2. Tier 1: what a new role must write

| key | what it is, and what happens when it is wrong |
|---|---|
| `id` | The role's id: lower-case letters, digits and `-`, starting with a letter. It is the name the persona is loaded under, `roleNames().id`, and part of the launchd labels. Not checked at boot; empty gives anonymous labels. |
| `names.me` | What the role is called. Used to recognise "@name" in chat and to fill the language pack's placeholders. Empty while the gate is on: the process refuses to start. |
| `names.owner` | What the role calls the person it works for. Same refusal when empty. |
| `workspace` | Absolute path of the role's working directory: persona files, notes, skills, scripts. It is a git repository; most relative paths in the config start here. Empty or relative: refusal. |
| `stateDir` | Absolute path of the role's state: database, logs, screenshots, replay copies. Keep it outside the workspace. Empty or relative: refusal. |
| `schedule.timezone` | IANA zone in which the role's day, focus slots and night are measured. Unset means the machine's zone, which is wrong for a role that lives elsewhere; write it unless they agree. |
| `lang` | Code of the language pack under `src/lang/` that holds every text shown to the role and the operator. Unset or empty means `zh`; an unknown code throws. Write it unless `zh` is what you want. It does not say what language the role itself writes in (`writingLanguage`, part 3). |

`hh new <id> --owner <name> [--dir <path>] [--me <name>] [--lang <code>]` creates `<role dir>/instance.json`, `<role dir>/workspace/` with five persona files, and two launchd files in `<role dir>/launchd/` (rendered from `ops/launchd/*.plist.template`, not installed; the console's port is picked then and kept as `launchd.consolePort`; `hh modules install` installs them). For a role `r2` with owner `Sam` and `--lang en` it writes:

```json
{
  "id": "r2",
  "names": { "me": "r2", "owner": "Sam", "notMe": [] },
  "lang": "en",
  "workspace": "<role dir>/workspace",
  "stateDir": "<role dir>/state",
  "personaFiles": ["IDENTITY.md", "SOUL.md", "USER.md", "MEMORY.md", "AGENTS.md"],
  "tools": { "sendDryRun": true },
  "browser": { "port": 9301 },
  "launchd": { "hhd": "ai.hh.r2.hhd", "console": "ai.hh.r2.console" }
}
```

(Paths are absolute in the real file; the port is a free one picked at the time.) Of these keys `id`, `names.me`, `names.owner`, `workspace`, `stateDir` and `lang` are tier 1. `schedule.timezone` is not written; add it. The rest are written for safety or convenience: `tools.sendDryRun: true` keeps all sending simulated until the role has a channel, `browser.port` is a free port so two roles never collide, `launchd.*` keep two roles under one user from sharing job labels, and `personaFiles` and `names.notMe` repeat their defaults. Every built-in module is turned on under `modules`; `modules.helpers.tasksDir` is written as `<role dir>/tasks`, so that two roles under one user do not share the directory their helpers work in (the module's own default is `~/agent-tasks`).

## 3. Tier 2: what most roles write

### Give the role channels to talk on

| key | what it is | default |
|---|---|---|
| `channels` | The transports the role is connected to: `{ "<name>": { "via": "<implementation>" } }`. The name is what the role writes in the `message` tool. Today the only `via` is `gateway`. Contract: [channels.md](channels.md). | `{}` (connected to nothing) |
| `tools.sendDryRun` | While `true`, nothing is sent: messages are only reported as if sent. Set `false` when the role has a channel and the owner agrees. | `true` |
| `outbound.refuseLatinLines` | Every send refuses a short line in Latin words only (one line of at most 150 characters, no kana or han, no link, three words or more): for a role that writes Chinese such a line is its own narration. The role is told why, in its pack's words. Leave it off for a role that writes in a Latin script. | `false` |
| `outbound.latinLinesTo` | Targets that may get such lines anyway: a target containing one of these strings passes. | `[]` |
| `outbound.latinLinesFile` | Absolute path of a file `{ "until": <ms> }` that lets such lines go to anyone until then (the role's own switch writes it); missing or broken: no. | `""` (none) |
| `outbound.tidyLines` | A one-line message loses a leading list mark (`1.` `1、` `-` `•` `*` followed by a space) and trailing `。`. A message starting with a notice sign (⚠️ ⏳ ✅ ❌ …) is left alone by both rules. | `false` |
| `modules.<name>.enabled` | Turns that module on ([modules.md](modules.md)); the other keys under `modules.<name>` are the module's own config, over its defaults. | `{}` (none on) |
| `modules.<name>.guide` | `false` keeps that module's guide out of the prefix (a role moving over keeps its own words for a while). | on |
| `modulePaths` | More directories holding modules (each a `<name>/module.json`), relative to the workspace. | `[]` |
| `gateway.authFile` | Absolute path of the gateway's login file, for `via: "gateway"`. | unset (`<workspace>/../openclaw.json`) |

### Let senses reach the role

The role's own scripts hand events to the framework; the contract is [senses.md](senses.md). Not to be confused with `channels`.

| key | what it is | default |
|---|---|---|
| `senses.sources` | Sorts each sense source (an event's `src`) into the lists `senses.sources.chat`, `senses.sources.public`, `senses.sources.probe`, `senses.sources.always`, `senses.sources.hands`; a source may be in several. A source in none is judged by the rules and masked in the console as chat. | five empty lists |
| `senses.logFile` | The role's event log, one event per line, relative to the workspace. Empty: no log, so `hh gate replay` and the rule try-out do not work. | `""` |
| `senses.labels` | `{ source: display name }`: how the role is shown each source, in the role's own language. | unset (the code is shown) |
| `gate.enabled` | The gate decides which events reach the role. Off: events go straight through and the `names` check is dropped. | `true` |
| `gate.rulesFile` | The role's rules file, relative to the workspace; first matching rule wins. | `gate.json` |
| `gate.digest` | Turns on the gate's daily summary. Off: events that would wait for it are delivered at once. | `false` |
| `gate.card.soul` | Workspace files that make the persona card for the gate's small judgements; unreadable ones are skipped. | `[]` |

### Choose models and the daily rhythm

| key | what it is | default |
|---|---|---|
| `models.opus`, `models.sonnet`, `models.haiku` | The model of each tier; haiku also serves the gate's small judgements. | `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| `models.byRole` | Picks a model for one brain region (`main`, `side`, `deep`, `hippocampus`, `speech`, `perception`) instead of by tier. Unknown names are refused at boot. | unset |
| `models.providers` | Other model providers by name, each an Anthropic-format endpoint: `baseUrl`, `keyFile` (a file holding the provider's own token, read when the region opens: empty, the region does not start, since Claude Code would otherwise send this computer's claude.ai login to `baseUrl`), `model`, `smallModel` (the small slot; else `model`), `subagentModel` (else `smallModel`), `contextTokens` (the model's real context window), `cliVersion` (the Claude Code version it was tried on: hhd does not start on another, and needs `kernel.claudeExecutable` named), `configDir` (its own Claude Code config directory, never logged in: hhd asks the CLI's `auth status` there before it starts, since on macOS a login lives in the keychain and leaves no file; else `<stateDir>/providers/<name>`), `price` (`input`, `output`, `cacheRead`, `cacheWrite`: USD per million tokens; cache prices default to `input`) and `weekUsd` (the 7-day spend that counts as a full week's quota). | unset |
| `models.providerByRole` | Puts a role's regions on one of `models.providers`: their sessions get `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, an empty `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`, the provider's model in every model slot (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU,FABLE}_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL`), `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `CLAUDE_CONFIG_DIR` set to its own directory, and no fallback model; one of them missing, the region does not start. Their turns are priced into the provider's spend (`hh status` → `spend`), their rate readings are not taken as the subscription's, and the week's quota the gates read for that role (`side`: parallel work; `main`: the focus nudge) is the 7-day spend against `weekUsd`. | unset |
| `schedule.focusSlots` | Start times ("HH:MM") of the daily focus periods; the night ends at the first. | `["07:30","09:00","13:00","18:00"]` |
| `schedule.focusMinutes` | Length of each focus period. | `30` |
| `schedule.nightSleep` | When the night's consolidation begins ("HH:MM"). Not before 02:00: the organizer marks a day done only after 02:00 the next morning (sleep_digest.py, NIGHT_START), so a night that starts earlier is put off to the next one every time, and the day waits a day. | `03:00` |
| `schedule.morning` | When the night ends if `focusSlots` is empty. | unset (`07:30`) |
| `sleep.pendingDays` | Command (argv, run in the workspace, no shell, 60 s at most) that prints the days waiting for consolidation, one `YYYY-MM-DD` per line, earliest first. Unset: the night module's `sleep_digest.py pending`. | unset |
| `sleep.organizer.*` | The guide the night's organizer follows: `guide` (file), `firstStep`, `lastStep`, `state` (file), `apply` (script), `recallNote`, `eventNote`. The framework only names them in the organizer's instruction. See [night.md](night.md). | unset |
| `sleep.reportFile` | Path template of the night's report, `{day}` replaced by the date; unset: no report. | unset |

### Persona files, language and skills

| key | what it is | default |
|---|---|---|
| `personaFiles` | Workspace files concatenated, in order, into the persona prefix. Every one must exist. | the five files `hh new` writes |
| `writingLanguage` | The language the role itself thinks and writes in, as a phrase (for example `Japanese`), put into the shared runtime note and the night organizer's text. Empty: not mentioned. Independent of `lang`. | `""` |
| `skills.roots` | Directories, relative to the workspace, where manuals are looked up by name. | `["skills"]` |
| `skills.names` | Manuals that must load; a missing one is logged. | `[]` |
| `skills.discover` | Directory whose every sub-folder with a `SKILL.md` also loads, so a new manual needs no config change. | `skills` |
| `skills.exclude` | Names discovery skips. | `[]` |

### The browser, the console, launchd

| key | what it is | default |
|---|---|---|
| `browser.port` | Remote-debugging port of the role's own Chrome; unique per role on a machine; unset: the driver throws. | unset |
| `browser.chrome` | The browser program. | the macOS Google Chrome path |
| `browser.userDataDir` | Profile folder, relative to `stateDir`; logins live here. | `browser` |
| `browser.logins` | What the browser tool's description says is signed in there, in the role's language, in place of the general words: `"the work Google account is signed in"`. Only what is true of this role's own profile. Older code ignores the key. | the pack's: `your accounts stay logged in there` |
| `console.sourceLabels`, `console.channelLabels` | Display names of the role's sources (gate page) and channels (timeline) for the operator, per interface language: `{ "en": { "<code>": "<name>" } }`. | unset |
| `console.memoryPage.*` | What the console's memory page lists and opens: `areas` (`[folder, label]`, in order), `readable` (folder prefixes of openable `.md`), `hidden`; `restOf`, `only`, `hiddenPatterns` refine. All relative to the workspace. The nightly reports and the skill manuals are listed from `sleep.workDir` and `skills.discover` without being named here; opening them still needs their folders in `readable`. Unset: nothing is opened beyond the persona files. | unset |
| `launchd.hhd`, `launchd.console` | Job labels. Write both when two roles share one OS user. | `ai.hh.hhd`, `ai.hh.console` |
| `launchd.extraPath` | Folders added at the end of the PATH of the role's jobs. The PATH they get is the one setup ran with, minus its folders on an external disk (under `/Volumes`): the role's app looking into one makes macOS ask for access to a removable volume. Setup and `hh modules doctor` name the folders left out; put back the ones the role needs here. | none |

## 4. Tier 3: rarely touched, the reference

Tags: **[legacy]** exists for an older setup's history or a rollback path: leave it alone. **[stopped]** belongs to a project that was stopped: leave it alone. Types are in `Config` (`src/config.ts`); a path is relative to the workspace unless the row says otherwise.

### Names and platform files

| key | default | what it is |
|---|---|---|
| `names.notMe` | `[]` | Other names that start with the role's name; "@<me>..." followed by one of them is not a mention. |
| `names.ta`, `names.place` | unset | The third-person word others use for the role (unset: the role's own name); the place named when the clock is announced (unset: none). |
| `names.ordinary` | unset | What the role calls an ordinary person on its list, in the sentences about the permissions it may give by itself (the guest level): a name the role knows that level by. Unset: the pack's words ("an ordinary person on the list"). Older code ignores the key. |
| `load.statusFile` | unset (`<stateDir>/modules/load-guard/status.json`, where the load-guard module's patrol writes it) | Absolute path of the load guard's status file; when it says "tight" the role starts no optional work, and the wake-up brief shows its line. |
| `metrics.teamDirs` | unset | Absolute folders in which a team using the role's quota works; sessions below them count as "team" in the weekly table. |

### `limits` (context size and paging; tokens count one region's context)

| key | default | what it is |
|---|---|---|
| `limits.maxContextTokens` | `600000` | Hard context size of a region; a page turn is forced at 95 percent. |
| `limits.pageTokens` | `300000` | Shared memory view size at which the role turns a page (hippocampus compresses it). |
| `limits.sleepyAtTokens`, `limits.mustSleepAtTokens` | `150000`, `200000` | Compressed blocks reach this: the role prefers to sleep when idle; must sleep as soon as it can. |
| `limits.idleMinutesBeforeSleep` | `20` | Idle time required before sleepiness may put the role to sleep. |
| `limits.maxItemChars` | `1500` | Longest text of one record rendered into the memory view. |
| `limits.rotationTailTokens` | `20000` | Recent text carried into a new session at a shift change. |
| `limits.syncThinkChars` | `120` | Other regions' "thinking" is folded to one numbered line of at most this many characters in the main thread; `0` = full text. |
| `limits.pageTurnFork` | `true` | Page-turn compression forks the main session; `false` starts a fresh hippocampus session. |
| `limits.sideRotateTokens`, `limits.restartPageTokens` | unset (`250000`, `150000`) | A side region's own shift change; the most page the main thread takes when it restarts without a page turn. |
| `limits.perceptionRotateTokens` | unset (`150000`) | **[legacy]** Shift change of the legacy perception region. |

### `schedule` tuning, `regions`, `parallel`

| key | default | what it is |
|---|---|---|
| `schedule.wanderEveryMinutes` | `45` | How often the idle main thread may start a free-wandering turn. |
| `schedule.focusQuotaWeekMax` | `90` | Percent of this week's quota above which idle wake-ups in a focus period are stretched and ask for light work. Real events still wake the role. |
| `schedule.remindEvidenceTools` | `["Bash","hands"]` | Tools whose actions count as proof a recurring reminder was acted on today. |
| `regions.sideThreads` | `2` | Background (side) regions running in parallel. |
| `regions.perception` | `[]` | **[legacy]** Names of the legacy perception streams; non-empty turns the gate off for the old path. Leave empty. |
| `parallel.thresholdMin` | `5` | A job estimated longer than this many minutes goes to an idle region. |
| `parallel.busyChat.*` | `windowMin` 15, `count` 3, `exchangeMin` 5 | Chat counts as busy after `count` exchanges in `windowMin`; an exchange stays open `exchangeMin`. |
| `parallel.quotaWeekMax` | `97` | Percent of the weekly quota above which the role stops delegating (a reminder, not a block). |
| `parallel.look.*` | `maxLooks` 8, `overFactor` 4, `timeoutMin` 15 | Looking back at a finished task: stop and ask the person after `maxLooks` looks or `overFactor` times the estimate; one look takes at most `timeoutMin`. |
| `parallel.urgentNote.minGapMin` | `10` | An urgent note made while working calls the speaking thread at most this often; later ones are bundled. |

### `gate` tuning and `kernel`

| key | default | what it is |
|---|---|---|
| `gate.batchMax` | `20` | Most events judged in one batch. |
| `gate.judgeTimeoutMs` | `60000` | Time one small judgement may take. |
| `gate.dailyUnits` | `2000000` | Daily budget for small judgements in budget units (see `sleep.weights`); used up: the gate holds events instead of judging. |
| `gate.convContext`, `gate.convContextMinutes` | `8`, `120` | Earlier group messages shown with an event, and how far back they may be. |
| `gate.workMaxAgeHours` | `24` | A queued "work" event older than this is demoted to "leisure". |
| `gate.attachMax` | `3` | Most queued events of each kind attached to a wake-up not caused by a person. |
| `gate.defaultWant` | `""` | Sentence used when a rule does not say what is wanted; empty: the pack's. |
| `gate.card.midterm` | `exports/midterm.md` | Mid-term export appended to the card; **relative to `stateDir`**. |
| `gate.card.midtermMaxChars` | `0` | Truncates it to this many characters; `0` = no limit. |
| `kernel.permissionMode` | `bypassPermissions` | Do not change to `auto` before changing where `src/kernel/sdk.ts` decides a turn is over: `auto` merges queued sub-agent reports and would count several turns. |
| `kernel.allowedTools`, `kernel.claudeExecutable` | `[]`, `null` | Tools allowed without asking; path of the `claude` executable (`null` = the SDK's). |
| `kernel.builtinTools` | Agent, Bash, Edit, EnterWorktree, ExitWorktree, ListAgents, Monitor, Read, SendMessage, Skill, TaskStop, ToolSearch, WebFetch, WebSearch, Write | The kernel's own tools every region gets (a region whose spec names its own list gets that one). Nothing outside the list is given: a tool the kernel adds later does not appear by itself, and the MCP servers of the signed-in account are never loaded. A role that needs one more names the whole list in its instance config. |
| `kernel.env`, `kernel.mcpServers` | `{}`, `{}` | Environment given to every kernel session (and the role's shell commands); extra MCP servers attached to every region. Roles whose scripts or tools need them write these. |

### `memory`

| key | default | what it is |
|---|---|---|
| `memory.events.enabled` | `true` | Event-memory tools are available and the night writes events into the database. |
| `memory.events.inject` | `true` | The event association is put into the role's context. |
| `memory.events.midterm` | `true` | The mid-term view of recent events goes into the persona prefix. |
| `memory.events.recognize` | `true` | The role is reminded in one sentence when it meets something tied to what it likes or dislikes. |
| `memory.people.template` | the pack's | Shape of a person card (fields, limits, private fields, quotes, computed sections); validated by `parseTemplate`. Invalid: person cards are off, `hhd` still starts. |
| `memory.promptFolds` | unset | `[{ find, say, word?, note? }]`: text folded to a short sentence before it enters a prompt; the database and console keep the original. Each `note` says when and why it was added. |
| `memory.retiredFiles` | unset | `[{ path, whenExists?, whenMissing?, hippocampus, other }]`: files nobody may write any more, with the message saying where to write instead; `path` is a regular expression. |
| `memory.peopleSwitchFile` | unset | **[legacy]** File whose appearance means person cards replaced the old people files; unset: they always have. |

### `learning` (switches are independent; layout in [notebook.md](notebook.md))

| key | default | what it is |
|---|---|---|
| `learning.enabled`, `learning.inject`, `learning.shelf` | `false`, `false`, `false` | Compute associations from the notebook; show the computed pages to the role (off: computed and logged only); put the shelf's contents list into the prefix. |
| `learning.root` | `skills` | Notebook root (`<root>/<category>/<book>/<page>.md`). |
| `learning.generalCategory` | the pack's name | Category whose pages are candidates however they rank. |
| `learning.threshold`, `learning.askThreshold` | `0.7`, `0.5` | Probability line for showing a page (also for counting a message as a correction); the lower line when the role asks its notes. |
| `learning.maxPages` | `3` | Most pages shown at once. |
| `learning.kWake`, `learning.kTask` | `10`, `15` | Candidate pages pre-selected for the judgement at wake-up and at the start of a task. |
| `learning.timeoutMs`, `learning.dailyUsd` | `800`, `1` | Time of one judgement; most the judgements may spend per day (US dollars). |
| `learning.helperSkipBooks` | `[]` | Books not attached when work goes to a helper. |
| `learning.remountTokens` | `50000` | A page already shown is shown again at working moments only after this many tokens of new history. |
| `learning.shelfFile`, `learning.newGroundPage` | unset (`shelf.json`), unset | The shelf's rules file; the page on how to learn a new skill (both relative to `learning.root`); unset page: that sentence is not said. |

### `sleep` (the night; contract [night.md](night.md))

| key | default | what it is |
|---|---|---|
| `sleep.nightMaxDays` | unset (`3`) | Most days consolidated in one night. |
| `sleep.workDir` | `sleep` | The only workspace folder the organizer may write in at night; the console's memory page lists the nightly reports from it. |
| `sleep.home` | unset (the running user's home) | Absolute path that `~/` means in paths the organizer writes. |
| `sleep.wakeRefresh`, `sleep.wakeRefreshSec` | unset, unset (`60`, max `600`) | Command (argv) run in the workspace after the night and before the prefix is rebuilt, and how long it may take; failure only logs a warning. Unset: the night module's `ledger_snapshot.py`. |
| `sleep.unitsPerPct` | `5400000` | Budget units that equal one percent of the weekly quota. |
| `sleep.weights.*` | `input` 1, `cacheRead` 0.1, `cacheWrite` 1.25, `output` 5, `model.opus` 1, `model.sonnet` 0.6, `model.haiku` 0.2 | Cost per token kind and per model, in units; missing entries are filled from these. |
| `sleep.auditMinutes`, `sleep.watchdogHours` | `20`, `5` | Longest check of the evidence for one proposal; whole-night watchdog. |
| `sleep.examScratch`, `sleep.examMinFree` | `sleep-exam`, `3` | Folder below `stateDir` for the event-database copy the pre-night exam uses; the copy is made only with this many times the database size free. |
| `sleep.workspaceEnv`, `sleep.dbEnv` | unset | Names of environment variables through which the role's scripts find the workspace and the event database; `hh sleep replay` points them at its copies and refuses to start without them. |
| `sleep.newEngine` | unset (off) | **[stopped]** Only `true` makes the night read the segmented engine's files below. |
| `sleep.flowFile`, `sleep.commonFile`, `sleep.soulFile` | `scripts/sleep_flow/flow.json`, `scripts/sleep_flow/common.md`, `SOUL.md` | **[stopped]** The engine's flow, shared text and persona file. |
| `sleep.lastGood` | `sleep-flow.last-good.json` | **[stopped]** Last flow file that parsed; relative to `stateDir`. |

### `tools`

| key | default | what it is |
|---|---|---|
| `tools.python` | `python3` | Interpreter for the role's Python scripts that the framework starts. |
| `tools.wordListFile` | `""` | Workspace file of words the role noted as unnatural; a message containing one is held back once, the role is told, and the same text sent again goes out. Empty: no check. |
| `tools.extra` | `[]` | Tools a region gets only when listed here; today `"computer"`. |

## 5. Conventions

- Paths are relative to the workspace unless the row says otherwise. Relative to `stateDir`: `browser.userDataDir`, `gate.card.midterm`, `sleep.lastGood`, `sleep.examScratch`. Relative to `learning.root`: `learning.shelfFile`, `learning.newGroundPage`. Absolute: `workspace`, `stateDir`, `gateway.authFile`, `load.statusFile`, `metrics.teamDirs`, `sleep.home`, `memory.leakGuardDir`.
- Time suffixes are mixed today: `Ms`, `Sec`, `Min` and `Minutes`, `Hours`. A new key spells the unit out: `Minutes`, not `Min`. A percent ends in `Pct`, money in `Usd`, budget units in `Units`.
- A boolean that switches a feature on is `false` by default; a feature that is on by default is switched off with an explicit `false` and its default is written in `config/default.json`, never only in the code.
- A new key gets its row on this page, in its tier, in the same change as the code. A key that exists for one role's history gets a tag and a way out (when it can be deleted).
- Code reads names through `roleNames(cfg)`, never from the config path. Where a key has a framework default of empty, the code treats empty as "not used", not as an error.
