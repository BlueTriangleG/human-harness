// Backup: an off-machine copy of the role's workspace and state. HH does not do it: it is a launcher with Full Disk
// Access that a person sets up once on the machine (the first role's runs from its own launchd job). This declaration
// only says so, so a new role's doctor shows it as something to set up.
import { defineModule } from "../../src/modules/api.ts";

export default defineModule({
  name: "backup",
  summary: "an off-machine copy of the role's workspace and state, by a launcher a person sets up once",
  requires: { setup: ["a backup launcher with Full Disk Access, run by launchd, copying the role's directory off the machine"] },
  check: async () => [{ status: "setup", text: "set up by hand: a backup launcher with Full Disk Access (HH does not make it)" }],
});
