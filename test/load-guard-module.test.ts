// The load guard's script: its own tests on this machine's readings, and the Linux readings on a made-up /proc and /sys.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { BUILTIN_ROOT } from "../src/modules/load.ts";
import { testConfig } from "./helpers.ts";

for (const t of ["test_load.py", "test_machine_linux.py"]) {
  test(`load guard: ${t} passes`, () => {
    const r = spawnSync(testConfig().tools.python, ["-I", join(BUILTIN_ROOT, "load-guard", "tests", t), join(BUILTIN_ROOT, "load-guard", "scripts", "load.py")], { encoding: "utf8" });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1500));
  });
}
