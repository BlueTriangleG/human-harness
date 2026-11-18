# The workspace layout

Owner: framework. What lives where in a role's workspace, and who reads or writes it: HH itself, the night module
(`modules/night/`), the other built-in modules. `hh new` makes the empty skeleton of part 4 from this page. Whoever
moves a file changes this page, the code that reads it, and `src/persona/layout.ts` (HH's side keeps every path of
this page in that one file) together.

Paths are relative to the workspace. "Generated" files are written by a script from other files: do not edit them.

## 1. Persona and memory files (in every prefix)

| Path | What | Written by | Read by |
|---|---|---|---|
| `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md` | who the role is, its owner, its ways of working, its long memory (`personaFiles` in the instance config) | the role; the night (MEMORY.md is merged by the role from the night's proposal) | HH: every prefix |
| `SOUL.md` | the persona — **generated** from `soul/` | `night/soul_build.py` | HH: every prefix |
| `SOUL.memory.md` | the memory blocks of `soul/` (those marked for the snapshot) — **generated** | `night/soul_build.py` | HH: the memory part of the prefix |
| `SOUL.lens-<guest>.md` | what a guest's own session may see of the persona — **generated** | `night/soul_build.py` | guest sessions |
| `soul/*.md` | the persona, split by aspect (`NN-<aspect>.md`) | the role, the night's proposals | `night/soul_build.py`, `night/sleep_apply.py` (guards), `night/memory_lint.py` |
| `ledger/SOUL.md` | the persona snapshot: current threads, the mid-term window, the owner, open loops, today — **generated**, every 600 s and after the night | `night/ledger_snapshot.py` | HH: the memory part of the prefix; the situation (lines added since the prefix) |
| `ledger/people/<key>.md`, `ledger/people/near.md` | the person cards exported from the event store; people's recent news | HH (event memory export); `night/midterm.py` | `night/ledger_snapshot.py` |

## 2. `memory/`

| Path | What | Written by | Read by |
|---|---|---|---|
| `memory/people/registry.json` | who the role knows: key → name, privacy (`owner`, `guest`…), ids per channel, permissions | the role (through HH's people tools; a person's permissions only by approval) | HH (recognising people, the gate), all night scripts |
| `memory/<owner key>.md` | the owner's card before person cards moved into the event store (the owner's key: the registry entry whose privacy is `owner`) | the night | `night/ledger_snapshot.py` |
| `memory/us.md`, `memory/kept-words.md` | the role and its owner; words it keeps | the night | `night/ledger_snapshot.py` |
| `memory/threads/*.md` | event threads, one per matter (a metadata comment on line 2: start, last progress, state) | the night | `night/midterm.py`, `night/ledger_snapshot.py`, `night/sleep_digest.py`, `night/sleep_apply.py` |
| `memory/midterm/`, `memory/recent.md` | the mid-term window — **generated** | `night/midterm.py` | `night/ledger_snapshot.py`, the night's material |
| `memory/open-loops.md`, `memory/timeline.md` | open loops ("进行中" and the rest); today's timeline | the role, the night | `night/ledger_snapshot.py` |
| `memory/my-life.md`, `memory/diary/`, `memory/life/` (`moments/`, `think/cycles/`) | the role's own life: its diary, moments kept whole before sleep, its free-time thinking | the role | the night's material; `moments/` in the snapshot |
| `memory/story/<YYYY-MM>.md` | the month's story | the night | the role |
| `memory/archive/` | what the night retired (moved, never deleted) | the night | `night/sleep_apply.py`, `night/ledger_snapshot.py` |
| `memory/compactions/` | page-turn texts kept for the night | HH | `night/sleep_digest.py` |
| `memory/goals/goals.json`, `memory/goals/GOALS.md` | the goals and their readable copy (**generated**) | `goals/goals.py` | goals module, the night (`goals ls`) |
| `memory/bili/`, `memory/videos/<id>/` | the B站 ledger and archive; what was seen of a video (shared with `watch_video`) | bilibili module, media module | those modules |

## 3. The night's own, the shelf, the modules' data

| Path | What | Written by | Read by |
|---|---|---|---|
| `sleep/state.json` | which days are done (`last_done`, `done`) | `night/sleep_digest.py done` | `night/sleep_digest.py pending`, HH (`sleep.pendingDays`) |
| `sleep/<day>/` | that night's material, proposals (`proposed/`), report | `night/sleep_digest.py`, the organizer, `night/sleep_apply.py` | the organizer, `night/sleep_apply.py`, HH (`sleep.reportFile`) |
| `sleep/config.json`, `sleep/soul-changelog.md` | the night's own settings; the persona's change log | the night | `night/memory_lint.py`, the role |
| `skills/<category>/<book>/` | the notebook and manuals (`SKILL.md` is a book's cover, every other `.md` a page; see notebook.md) | the role; the night; `hh modules install` links module manuals here | HH (learning, the shelf) |
| `voice/` (`out/`, `usage.jsonl`), `stickers/` | voice clips and their usage; the sticker library | media module; the role | media module; stickers module, bilibili module (images) |
| `scripts/` | the role's own scripts (not the framework's) | the role | `night/sleep_apply.py` fingerprints it during the night |
| `.git/` | the workspace is a git repository: the night commits before and after it applies | the night | `night/sleep_apply.py` |

## 4. The skeleton `hh new` makes

The five persona files with their starter text; `soul/10-soul.md` with the same starter persona (the night builds
`SOUL.md` from `soul/`, so the persona has to start there too); the folders `ledger/people/`, `memory/people/`,
`memory/threads/`, `memory/archive/`, `memory/diary/`, `sleep/`, `skills/`; `sleep/config.json` (`{"mode": "live"}`);
the gate's first rules (`gate.json`); the notebook's rules file `skills/shelf.json`, with no marks yet; and the people
list `memory/people/registry.json` with the owner alone (privacy `owner`), so HH knows the owner from the first start;
the role adds everyone else itself. The workspace is a git repository with one commit (the night's persona snapshot
reads its HEAD). Everything else is made when it is first written.
