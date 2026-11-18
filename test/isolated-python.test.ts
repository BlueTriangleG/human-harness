// What HH starts with `python3 -I` reads no PYTHONPATH and has no script folder of the caller on sys.path, so such a
// script must find hh_env (modules/_lib) by itself: the night's rebuild of the persona snapshot (sleep_apply finish),
// the helpers' hooks and their session runner. The module tests copy a script out with hh_env laid beside it, which hides
// a missing path (11-17: a new role's first night failed at finish on it). These start the module's own files, in place.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BUILTIN_ROOT } from "../src/modules/load.ts";

const PY = "/usr/bin/python3";   // what sleep_apply starts the snapshot with
const LIB = join(BUILTIN_ROOT, "_lib");
/** the scripts some part of HH starts isolated */
const ISOLATED = ["night/scripts/ledger_snapshot.py", "helpers/scripts/cc.py", "helpers/scripts/cc_inbox_hook.py"];
/** the scripts that start one of them with -I */
const LAUNCHERS = ["helpers/scripts/cc.py", "night/scripts/sleep_apply.py"];
const skip = !existsSync(PY) && `${PY} is not on this machine`;

/** a made-up role's module environment, everything under one temporary folder */
function roleEnv(dir: string, module: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, HOME: dir, HH_WORKSPACE: join(dir, "ws"), HH_STATE_DIR: join(dir, "state"), HH_MODULE_DIR: join(BUILTIN_ROOT, module),
    HH_MODULE_STATE: join(dir, "module"), HH_ROLE_ID: "isolated", HH_ME: "Wren", HH_OWNER: "Sam", HH_TZ: "UTC", HH_LANG: "en",
    HH_BIN: join(dir, "no-hh"), HH_MODULE_CONFIG: "{}", LEAK_GUARD_STATE: join(dir, "lg"),
  };
}

test("isolated python: every script that starts another with -I is known here", () => {
  const launchers = readdirSync(BUILTIN_ROOT).flatMap((m) => {
    const d = join(BUILTIN_ROOT, m, "scripts");
    return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".py")).map((f) => `${m}/scripts/${f}`) : [];
  }).filter((rel) => /['"]-I['"]|\} -I \{/.test(readFileSync(join(BUILTIN_ROOT, rel), "utf8"))).sort();
  assert.deepEqual(launchers, [...LAUNCHERS].sort(), "a script starts another with python -I: add what it starts to ISOLATED");
});

// run each script's top up to its hh_env import, as itself (its __file__), under -I with no PYTHONPATH
const TOP = `import ast, sys
p = sys.argv[1]
body = []
for n in ast.parse(open(p, encoding="utf-8").read()).body:
    body.append(n)
    if (isinstance(n, ast.ImportFrom) and n.module == "hh_env") or (isinstance(n, ast.Import) and any(a.name == "hh_env" for a in n.names)):
        break
else:
    sys.exit("no hh_env import in " + p)
exec(compile(ast.Module(body=body, type_ignores=[]), p, "exec"), {"__file__": p, "__name__": "isolated_check"})`;

for (const rel of ISOLATED) {
  test(`isolated python: ${rel} finds hh_env under -I`, { skip }, () => {
    const dir = mkdtempSync(join(tmpdir(), "hh-isolated-"));
    const r = spawnSync(PY, ["-I", "-c", TOP, join(BUILTIN_ROOT, rel)], { encoding: "utf8", env: roleEnv(dir, rel.split("/")[0]!) });
    assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1500));
  });
}

test("isolated python: ledger_snapshot.py and cc.py start under -I from the module", { skip }, () => {
  for (const [rel, arg] of [["night/scripts/ledger_snapshot.py", "--help"], ["helpers/scripts/cc.py", "--help"]] as const) {
    const dir = mkdtempSync(join(tmpdir(), "hh-isolated-"));
    const r = spawnSync(PY, ["-I", join(BUILTIN_ROOT, rel), arg], { encoding: "utf8", env: roleEnv(dir, rel.split("/")[0]!) });
    assert.equal(r.status, 0, `${rel}: ${(r.stdout + r.stderr).slice(-1500)}`);
  }
});

test("isolated python: sleep_apply finish rebuilds the snapshot from the module (ledger_snapshot under -I)", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hh-isolated-"));
  const ws = join(dir, "ws");
  for (const [rel, text] of Object.entries({
    "AGENTS.md": "# AGENTS\n", "IDENTITY.md": "# IDENTITY\n", "USER.md": "# USER\n- Sam\n", "MEMORY.md": "# MEMORY\n## Rules\n- rule one\n",
    "soul/20-character.md": "# Character\n- direct\n", "memory/people/registry.json": JSON.stringify({ sam: { name: "Sam", privacy: "owner" } }),
    "memory/open-loops.md": "# To do\n## In progress\n## Done lately\n", "sleep/config.json": JSON.stringify({ mode: "live" }),
  })) {
    mkdirSync(dirname(join(ws, rel)), { recursive: true });
    writeFileSync(join(ws, rel), text);
  }
  // as the night command starts sleep_apply (PYTHONPATH=_lib); its rebuild then starts the snapshot with -I
  const run = `import json, sys
sys.path.insert(0, sys.argv[1])
import sleep_apply as A
ctx = A.Ctx(root=sys.argv[2], home=sys.argv[3], state_db="none")
res = {"errors": []}
out = A.run_rebuild(ctx, res)
print(json.dumps({"out": out, "errors": res["errors"], "report": A.snapshot_report(ctx)[:300]}))`;
  const r = spawnSync(PY, ["-c", run, join(BUILTIN_ROOT, "night", "scripts"), ws, join(dir, "home")],
    { encoding: "utf8", env: { ...roleEnv(dir, "night"), PYTHONPATH: LIB } });
  assert.equal(r.status, 0, (r.stdout + r.stderr).slice(-1500));
  const got = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { out: string[]; errors: string[]; report: string };
  assert.deepEqual(got.errors.filter((e) => e.includes("ledger_snapshot")), [], JSON.stringify(got.errors));
  assert.ok(!JSON.stringify(got).includes("hh_env"), JSON.stringify(got));
});
