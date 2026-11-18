// The night's consolidation: the scripts the sleeping role runs (material, apply, mechanical checks, the mid-term view,
// the persona files and the persona snapshot) and the organizer's guide. Part of the kernel, kept in a module's layout:
// required, so it is loaded whatever the config says. HH's sleep layer runs its sleep_digest.py pending and, on waking,
// its ledger_snapshot.py, unless the config names other commands (sleep.pendingDays, sleep.wakeRefresh); the snapshot
// also runs every 10 minutes (timer snapshot, off with config snapshotTimer: false).
import { command, defineModule, z } from "../../src/modules/api.ts";

const SNAPSHOT = command({ script: "scripts/ledger_snapshot.py", timeoutMs: 120_000 });

export default defineModule({
  name: "night",
  summary: "The night's consolidation scripts and the persona snapshot (part of the kernel)",
  required: true,
  config: {
    shape: {
      // For a role that ran on the old agent platform before HH: its records, its scheduler database, its leak filter's state
      legacyAgentDb: z.string(), legacyStateDb: z.string(), leakGuardState: z.string(),
      // What a few checks need to know about people (scripts/night_names.py): other spellings of the owner, the people
      // besides the owner whose whole conversations HH keeps (key -> name), pronouns (name -> m / f), and the files
      // the role's one-off move of person files into the event store took
      ownerAliases: z.array(z.string()), transcriptPeople: z.record(z.string(), z.string()),
      genders: z.record(z.string(), z.enum(["m", "f"])), retiredFiles: z.array(z.string()),
      // Words of the role's own that the lint takes as ordinary, not as a name to find in the sources (memory_lint.py)
      commonWords: z.array(z.string()),
      // false: no snapshot every 10 minutes from here (a role whose own job takes it, as soon as its memory changes)
      snapshotTimer: z.boolean(),
    },
    defaults: { legacyAgentDb: "", legacyStateDb: "", leakGuardState: "", ownerAliases: [], transcriptPeople: {}, genders: {}, retiredFiles: [], commonWords: [], snapshotTimer: true },
  },
  timers: [{ name: "snapshot", everyMs: 600_000, run: { timeoutMs: 120_000, run: (m) => (m.config.snapshotTimer === false ? Promise.resolve("") : SNAPSHOT.run(m)) } }],
});
