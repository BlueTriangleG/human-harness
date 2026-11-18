// B站: the role's own B站 account, as a plugin — an MCP server (server/, started by bin/bili-mcp) with ~60 tools, the
// bili command line, and two sense sources (scripts/bili_events.py: replies and @, private messages) run by the senses
// collector. Its Python environment is <module state>/venv; the login is synced from the role's own Chrome (hh browser).
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defineModule, z, type ModuleContext } from "../../src/modules/api.ts";

/** A config path: relative to the workspace, or ~ / absolute; unset: <module state>/<own> */
const at = (m: ModuleContext, k: string, own: string): string =>
  (m.config[k] ? resolve(m.role.workspace, String(m.config[k]).replace(/^~(?=\/|$)/, homedir())) : join(m.stateDir, own));
const python = (m: ModuleContext): string => join(at(m, "venv", "venv"), "bin", "python");
/**
 * Can the environment's python import what the server needs? A failed install (bilibili-api-python on a Python it does
 * not support) leaves a python that cannot start the server: it is not handed to the kernel, and doctor says so.
 * For a session it is asked in the background, never holding a session up: until the answer comes the server is
 * offered (as before the check); a "no" (a broken install, or the check timing out on a busy machine) is asked again
 * RECHECK_MS later, so one slow moment does not take the B站 tools away until hhd restarts.
 */
const IMPORTS = ["-E", "-s", "-c", "import bilibili_api, mcp, aiohttp"];
const RECHECK_MS = 5 * 60_000;
const answers = new Map<string, { ok: boolean; at: number }>();   // by python: one per venv
const asking = new Set<string>();
const serverCanStart = (m: ModuleContext): boolean => {
  const py = python(m), a = answers.get(py);
  if (!asking.has(py) && (!a || (!a.ok && Date.now() - a.at > RECHECK_MS))) {
    asking.add(py);
    execFile(py, IMPORTS, { timeout: 30_000 }, (err) => { answers.set(py, { ok: !err, at: Date.now() }); asking.delete(py); });
  }
  return a?.ok ?? true;
};
/** doctor asks now and waits (the command line can) */
const serverCanStartNow = (m: ModuleContext): boolean => {
  try { execFileSync(python(m), IMPORTS, { stdio: "ignore", timeout: 30_000 }); return true; } catch { return false; }
};

export default defineModule({
  name: "bilibili",
  summary: "The role's own B站 account: find and watch videos, react, comment, private messages (MCP server)",
  config: {
    // ownerHandle: the owner's B站 name, the one the role may @ without asking; uploadRoots: folders besides the workspace it may upload from
    // senses: the two sources the senses collector runs for this module; dataDir, venv: where the login and records are
    // and the Python environment, relative to the workspace or ~ / absolute (unset: in the module's state, venv made by bin/setup.sh)
    // healthFile: the private messages' health record (consecutive failures, the day of the last alert), relative to the
    // workspace (unset: in the module's state)
    shape: { ownerHandle: z.string(), uploadRoots: z.array(z.string()), dataDir: z.string(), venv: z.string(), healthFile: z.string(), senses: z.record(z.string(), z.record(z.string(), z.unknown())) },
    defaults: {
      ownerHandle: "", uploadRoots: [], dataDir: "", venv: "", healthFile: "",
      senses: {
        bili: { type: "command", cmd: "\"$HH_BIN\" modules run bilibili bili_events.py", every_sec: 300 },
        bili_dm: { type: "command", cmd: "\"$HH_BIN\" modules run bilibili bili_events.py dm", every_sec: 300 },
      },
    },
  },
  requires: {
    python: "server/requirements.txt",
    bins: ["ffmpeg"],
    setup: ["the Python environment: hh modules run bilibili ../bin/setup.sh", "a B站 login in the role's own Chrome, then the auth_sync tool"],
  },
  mcp: { bili: { command: "bin/bili-mcp", ready: (m) => existsSync(python(m)) && serverCanStart(m) } },
  // the Python environment, resolved once here: bin/bili and bin/bili-mcp run it without starting a python to read the config
  env: (c, r) => ({ BILI_VENV: c.venv ? resolve(r.workspace, String(c.venv).replace(/^~(?=\/|$)/, homedir())) : "" }),
  senses: ["bili", "bili_dm"],
  senseKinds: { public: ["bili"], chat: ["bili_dm"] },
  check: async (m) => {
    return [
    !existsSync(python(m))
      ? { status: "setup", text: "no Python environment yet: hh modules run bilibili ../bin/setup.sh" }
      : serverCanStartNow(m)
        ? { status: "ok", text: "Python environment in place" }
        : { status: "setup", text: "the Python environment is there but its packages did not install (bilibili-api-python needs a newer Python): the B站 tools are off until bin/setup.sh succeeds" },
    existsSync(join(at(m, "dataDir", ""), "credential.json"))
      ? { status: "ok", text: "a B站 login is stored (auth_status tells whether it still holds)" }
      : { status: "setup", text: "no B站 login yet: log in to bilibili.com in the role's own Chrome, then call auth_sync" },
    ];
  },
});
