// Repair: the role fixing HH itself — the bug notebook, `hh fix` / `hh deploy` through the guarded deploy and the
// watchdog that rolls a bad deploy back. All HH's own (src/repair); this declaration lists it and carries the weekly
// tool check (scripts/weekly_tool_check.py): once a week the versions of the role's brew tools are looked at and the
// result is left to the role as a reminder; nothing is upgraded.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule, z } from "../../src/modules/api.ts";

const WEEK_MS = 7 * 24 * 3600_000;

export default defineModule({
  name: "repair",
  summary: "fixing HH itself: the bug notebook, hh fix / deploy, the deploy watchdog (HH's own), and a weekly tool check",
  required: true,
  config: {
    // the brew formulae the weekly check looks at; toolCheck false: no weekly check from here (a role whose own job does it)
    shape: { brewTools: z.array(z.string()), toolCheck: z.boolean() },
    defaults: { brewTools: [], toolCheck: true },
  },
  // checked hourly against the last time (in the module's state), since hhd restarts far more often than weekly; the
  // first week counts from when the module first runs
  timers: [{
    name: "toolcheck", everyMs: 3600_000, run: {
      timeoutMs: 15 * 60_000,
      async run(m) {
        if (!m.remind || m.config.toolCheck === false) return "";
        const file = join(m.stateDir, "toolcheck.json");
        const last = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { at: number }).at : 0;
        if (last && Date.now() - last < WEEK_MS) return "";
        mkdirSync(m.stateDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ at: Date.now() }));
        if (!last) return "";
        const r = await m.run("scripts/weekly_tool_check.py", [], { timeoutMs: 14 * 60_000 });
        if (r.stdout.trim()) m.remind(r.stdout.trim());
        return "";
      },
    },
  }],
});
