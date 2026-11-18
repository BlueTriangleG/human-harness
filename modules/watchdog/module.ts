// The channel watchdog: every minute it asks each of the role's bridged channels how it is, restarts a bridge that does
// not answer or does not reconnect, tells the owner over a channel that works, and starts Claude Code for the owner's
// /cc — the owner's way round the role, which the bridge keeps out of the inbox. It must run when hhd is stuck, so it is
// a standalone timer, and its script asks the bridges itself (no node, no model in a round).
import { defineModule, command, z } from "../../src/modules/api.ts";

export default defineModule({
  name: "watchdog",
  summary: "keeps the bridged channels reachable: restarts a silent or disconnected bridge, tells the owner, runs the owner's /cc",
  config: {
    // model: what the Claude Code sessions it starts run on (the owner's /cc, a diagnosis) — named here, never a default;
    // claude: the claude command (unset: the one on PATH); background: lines about this role's own set-up for both prompts;
    // busyFile: a file that exists while the machine is under heavy work (a lock): hhd then gets five minutes, not three, to answer;
    // senses: the source the senses collector runs for what the watchdog did
    shape: { model: z.string(), claude: z.string(), background: z.string(), busyFile: z.string(), senses: z.record(z.string(), z.record(z.string(), z.unknown())) },
    defaults: {
      model: "claude-opus-5-5", claude: "", background: "", busyFile: "",
      senses: { watchdog: { type: "command", cmd: "watchdog events" } },
    },
  },
  requires: { bins: ["claude"] },
  senses: ["watchdog"],
  // its own probe, and never an alarm: what it did is for the day's digest, not a wake-up
  senseKinds: { probe: ["watchdog"] },
  timers: [{ name: "check", everyMs: 60_000, standalone: true, run: command({ script: "scripts/watchdog.py", argv: () => ["check"], timeoutMs: 55_000 }) }],
  async check(m) {
    const ready = await m.run("scripts/watchdog.py", ["ready"], { timeoutMs: 20_000 });
    if (ready.code !== 0) return [{ status: "setup", text: ready.stderr.trim().split("\n").slice(-1)[0] ?? "" }];
    const r = await m.run("scripts/watchdog.py", ["check", "--dry-run"], { timeoutMs: 30_000 });
    if (r.code !== 0 || r.timedOut) return [{ status: "broken", text: (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("\n") }];
    return [{ status: "ok", text: r.stdout.trim() === "[]" ? "every bridged channel answers and is connected (or there is none)" : `this round would do: ${r.stdout.trim().slice(0, 200)}` }];
  },
});
