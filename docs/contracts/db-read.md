# What scripts read from hh.db

Owner: framework. Scripts outside `src/` (the night module) open the role's `hh.db` read-only. The tables and columns
below are what they read; changing one of them means changing those scripts in the same change (`src/store/db.ts`
points here).

| Table | Columns | Read by | For |
|---|---|---|---|
| `central` | `seq`, `ts`, `kind`, `src`, `text`, `meta` | `night/sleep_digest.py`, `night/hh_messages.py`, `night/memory_lint.py`, `night/ledger_snapshot.py` | the day's words (who said what, what was sent), the material and the checks of the night, what happened before sleep |
| `epochs` | `started` | `night/ledger_snapshot.py` | when the current page began |
| `tasks` | `owner`, `topic`, `started`, `ended` | `night/sleep_digest.py` | what the role worked on that day |

The database is found as `HH_DB`, else `<HH_STATE_DIR>/hh.db`. The old agent platform's databases a script may also
read (`transcript_events`, `session_windows`, `cron_jobs`) are not HH's: see `legacyAgentDb` / `legacyStateDb` in the
night module's config.
