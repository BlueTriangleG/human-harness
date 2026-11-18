# Contract: the night's consolidation (between the framework and a role's workspace)

Owner: sleep. Consumed by `src/brain.ts` (the night's sleep), `src/sleep/guide.ts`, `src/sleep/wake.ts`, and the
language pack's `nightOrganize` / `nightContinue`.

The framework does four things only: decide when to sleep, wake the organizer, read what it replies, and wake up.
How a day is consolidated (what material is read, what proposals are written, how they are applied) belongs to the
guide in the role's workspace. The framework does not read that guide.

## 1. What a role provides

| What | Config item | Contract |
|---|---|---|
| Which days are still waiting to be consolidated | `sleep.pendingDays` (argv) | Run without a shell, in the workspace, 60 seconds at most. Standard output: one `YYYY-MM-DD` per line, earliest first; other lines are ignored. Only exit code 0 counts; anything else is read as "no day listed". Once a day has been consolidated this command must stop listing it. Unset: the night module's `sleep_digest.py pending`; with the night module off too, nothing is asked and no day counts as pending |
| The guide | `sleep.organizer.guide`, `firstStep`, `lastStep` | A file relative to the workspace and the numbers of its first and last step. The framework only writes them into what it tells the organizer; it never reads the file. Unset, with the night module on: the module's general guide in the role's language, `scripts/sleep_organize.<lang>.md` (`sleep_organize.zh.md`), else the English `scripts/sleep_organize.md`; steps 0 to 10 |
| Where each day's progress is kept | `sleep.organizer.state` | Written into the prompt only. The framework does not read it; it asks the command above |
| Where the night's output goes | `sleep.workDir`, `sleep.organizer.apply` | A directory relative to the workspace (unset = `sleep`); the organizer may write only there, see section 4. `apply` is the name of the script that, in the guide's last step, checks the proposals and swaps them in. It is written into the prompt only; the framework does not run it |
| The nightly report | `sleep.reportFile` | A template relative to the workspace; `{day}` is the day consolidated that night. The framework does not write it. Other modules (learning's nightly pass) append to its end, and do nothing if the file is not there |
| What to regenerate before waking | `sleep.wakeRefresh` (argv), `sleep.wakeRefreshSec` | Run once when the night's sleep ends, before the prefix is rebuilt. Unset: the night module's `ledger_snapshot.py`. A failure or timeout is logged as one warn; waking goes on |

An item of `sleep.organizer` that is unset drops its clause from what the organizer is told. Note: when the
pending-days command lists nothing (or is not configured), the framework still wakes the organizer for one run,
and the guide decides which day that run is about; if nothing is listed afterwards, the night counts as consolidated.

## 2. How the organizer replies

The organizer is a session of its own. The framework sends it one prompt (`nightOrganize`); its last reply of that
turn is read as follows:

- `NO_REPLY`: the run ended normally.
- First line is exactly `AUTOMATION_FAILED`: this night cannot land. The second line says, in one sentence, which
  day, where it got stuck and which report to read. The framework retries once; after a second failure it wakes
  with the compacted memory kept.
- Anything else: read as a normal end. A turn that itself fails (the session cannot start, or is stopped) counts
  as a failure, like `AUTOMATION_FAILED`.

These two words are tokens the code matches. They are not in the language pack and do not change with the language.

One run consolidates one day. When the turn ends the framework asks "which days are pending" again:

- The day just worked on is still listed: one nudge in the same session (`nightContinue`); still listed after
  that, the night counts as **deferred**.
- That day is gone and others remain: a new session for the next day, up to `sleep.nightMaxDays` days a night
  (default 3); days still left at that point also make the night deferred.
- Nothing listed: the night counts as **consolidated**.

## 3. The three endings

| Ending | Compacted memory | What the role reads on waking |
|---|---|---|
| Consolidated | cleared | the consolidation is done |
| Deferred | kept | not finished, the rest is left for the next night |
| Failed (error, gave up, watchdog) | kept | it did not go well this time, memory stays as it is |

All three open a new page, rebuild the prefix and run `wakeRefresh`. From then until morning is night rest: the
role starts nothing on its own and answers as usual when someone comes. Morning is the first of
`schedule.focusSlots`, or `schedule.morning` when there are none.

## 4. Where the organizer may write

During the night's consolidation the organizer's Write / Edit may land only under `sleep.workDir` in the workspace
(unset = `sleep`). Anything else is refused, and the refusal tells it to write the complete new content as a
proposal instead. With `sleep.organizer.apply` set, the refusal adds that the last step has that script check the
proposal before it is swapped in. A path starting with `~/` resolves against `sleep.home` (default: the home of
the user running hhd).
