// Console: HH's read-only web console (src/console, its own launchd job). It has no login, so to reach it from outside
// the machine scripts/console_gate.py puts a passphrase in front of it for a tunnel (the `console-gate` command). This
// declaration lists the console and carries that script.
import { defineModule } from "../../src/modules/api.ts";

export default defineModule({
  name: "console",
  summary: "the read-only web console (HH's own, src/console), and a passphrase gate in front of it for a tunnel",
  required: true,
});
