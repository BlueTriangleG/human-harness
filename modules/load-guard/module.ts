// The load guard: looks at the machine's memory, gates heavy work, and sheds load before the machine freezes
// (scripts/load.py, the first role's script moved as it was). Its minute-by-minute patrol must run when hhd is stuck,
// so it is a standalone timer.
import { defineModule, command, z } from "../../src/modules/api.ts";

export default defineModule({
  name: "load-guard",
  summary: "machine load: a look, a gate before heavy work, and shedding load when memory is about to run out",
  config: {
    // the owner's system user, so the owner's processes are shown under the owner's name; shed: this role sheds load
    // and tells the owner when it is dangerous (false: it only watches — one role per machine sheds, hh new writes false
    // when the machine already has another role's guard); senses: the source the senses collector runs for this module
    // neverKill: the role's own processes (names, matched as text in the command line) that are never shed and never count as heavy work
    shape: { ownerUser: z.string(), shed: z.boolean(), neverKill: z.array(z.string()), senses: z.record(z.string(), z.record(z.string(), z.unknown())) },
    defaults: { ownerUser: "", shed: true, neverKill: [], senses: { load: { type: "command", cmd: "load events", fire_on_first: true } } },
  },
  senses: ["load"],
  senseKinds: { probe: ["load"], always: ["load"] },
  timers: [{ name: "guard", everyMs: 60_000, standalone: true, run: command({ script: "scripts/load.py", argv: () => ["guard"], timeoutMs: 50_000 }) }],
  async check(m) {
    // one sample, written nowhere
    const r = await m.run("scripts/load.py", ["json"], { timeoutMs: 20_000 });
    if (r.code !== 0 || r.timedOut) return [{ status: "broken", text: (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("\n") }];
    const s = JSON.parse(r.stdout) as { level: string; headroom_mb: number };
    return [{ status: "ok", text: `level ${s.level}, headroom ${s.headroom_mb} MB` }];
  },
});
