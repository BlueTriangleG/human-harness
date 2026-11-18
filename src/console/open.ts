// hh console [--pair]: open this role's console in the owner's browser, on its first page, where the talk pane is. When
// the console asks for the owner's token and there is none yet (or with --pair), a new one is made first: its sha256 goes
// into the token file, and the console is given a one-time code for it; the address handed to the browser carries only
// the code, after the #, and the page trades it for the token, which it keeps in its own origin's storage. The token file
// keeps one line per client (a browser, HH.app); --pair unpairs every client before it. Neither is printed, but by --url,
// for HH.app, whose web view loads the address it prints; and where there is no desktop to open a browser in (a Linux
// server or container), for the owner to open the address themselves.
//
// hh console --as <user> [--pair] [--token-dir <dir>] [--label <job label>]: the same, run by the owner for a role
// under an account of its own (whose console stays read-only until it is given a token file the role cannot write). It
// finds the role's console among that account's jobs (launchd's or systemd's, read by that account), and when the
// console is read-only has the role point console.ownerTokenFile at <dir>/<id>.owner (hh console --token-file, run as
// that account) and restart its console; then pairs as above and puts the role's short command on the owner's PATH
// (command.ts). <dir> is /Users/Shared/hh-console on macOS, /var/lib/hh-console on Linux.
import { execFile } from "node:child_process";
import { request } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { launchdLabels, nodeBin, type Config } from "../config.ts";
import { B } from "../lang/index.ts";
import { jobsAs, programOf, REPO } from "../services/index.ts";
import { buildHuman } from "../services/app.ts";
import { openUrl } from "../services/desktop.ts";
import { stopRecorded } from "../repair/restart.ts";
import { commandRecord, commandText, placeCommand, type Placed } from "./command.ts";
import { ownersOnly, tokenFileOf } from "./owner.ts";

export interface OpenDeps {
  /** hand the address to the system's browser; false: there is no desktop here to open it in */
  open: (url: string) => Promise<boolean | void>;
  /** GET a URL of the console as JSON; throws when nothing answers */
  get: (url: string) => Promise<unknown>;
  /** POST JSON to the console as its own page does (its Origin and header): the status code */
  post: (base: string, path: string, body: unknown) => Promise<number>;
  wait?: (ms: number) => Promise<void>;
}

export interface AsDeps extends OpenDeps {
  /** run a command as that account (sudo -u <user> -H, which may ask the owner's password) */
  as: (user: string, cmd: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** where the short command goes: the owner's PATH and home */
  env: { PATH?: string; HOME?: string };
  platform: string;
  /** make the owner's Human.app (services/app.ts); where it is */
  human: () => Promise<string>;
}

const run = (cmd: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((done) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (e, stdout, stderr) => done({ code: e ? (typeof e.code === "number" ? e.code : 1) : 0, stdout, stderr })));

const system: AsDeps = {
  open: (url) => openUrl(url),
  get: async (url) => (await fetch(url)).json(),
  post: (base, path, body) => new Promise((done, fail) => {
    const req = request(`${base}${path}`, { method: "POST", headers: { origin: base, "content-type": "application/json", "x-hh-console": "1" } }, (res) => { res.resume(); done(res.statusCode ?? 0); });
    req.on("error", fail);
    req.end(JSON.stringify(body));
  }),
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
  as: (user, cmd) => run("sudo", ["-u", user, "-H", ...cmd]),
  env: process.env,
  platform: process.platform,
  human: buildHuman,
};

interface Status { enabled?: boolean; token?: boolean; role?: string }

/** what /api/pair/status says, or the console's not running */
async function statusOf(base: string, label: string, deps: OpenDeps): Promise<Status> {
  try { return (await deps.get(`${base}/api/pair/status`)) as Status; }
  catch { throw new Error(B.cliDirect.consoleDown(base, label)); }
}

/** clients paired at once: a browser or two, an app; the oldest goes when another comes */
const CLIENTS = 8;

/**
 * A new token for one more client: its sha256 becomes a line of file (alone: every client paired before is unpaired).
 * The address returned carries a one-time code the console was just given for it (owner.ts PAIR_CODE_MS), never the
 * token: an address can stay behind in a browser's history or command line.
 */
async function pairAddress(base: string, file: string, alone: boolean, deps: OpenDeps): Promise<string> {
  const token = randomBytes(32).toString("hex"), code = randomBytes(16).toString("hex");
  let kept: string[] = [];
  if (!alone) try { kept = readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-(CLIENTS - 1)); } catch { /* the first */ }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.new`, [...kept, createHash("sha256").update(token).digest("hex"), ""].join("\n"), { mode: 0o644 });
  renameSync(`${file}.new`, file);
  const status = await deps.post(base, "/api/pair/code", { token, code });
  if (status !== 200) throw new Error(B.cliDirect.consoleCodeRefused(base, status));
  return `${base}/pair#c=${code}`;
}

/** pair this browser (--pair: alone) or just open the page */
async function pairOrOpen(base: string, file: string, status: Status, pair: boolean, deps: OpenDeps): Promise<string> {
  const pairs = !!status.token && (pair || !existsSync(file));
  const link = pairs ? await pairAddress(base, file, true, deps) : `${base}/`;
  if ((await deps.open(link)) === false) return B.cliDirect.consoleByHand(link, new URL(base).port);
  return pairs ? B.cliDirect.consolePaired(base) : B.cliDirect.consoleOpened(base);
}

export async function consoleCommand(cfg: Config, argv: readonly string[], deps: OpenDeps = system): Promise<string> {
  if (argv[0] === "--token-file") return ownTokenFile(cfg, argv);
  // --url: for HH.app, which loads the pairing address in its own web view: one more client, the browsers stay paired
  if (argv[0] === "--url" && argv.length === 1) {
    const port = cfg.launchd?.consolePort;
    if (!port) throw new Error(B.cliDirect.consoleNoPort);
    const base = `http://127.0.0.1:${port}`;
    const status = await statusOf(base, launchdLabels(cfg).console, deps);
    if (!status.enabled) throw new Error(B.cliDirect.consoleReadOnly(userInfo().username));
    return status.token ? pairAddress(base, tokenFileOf(cfg), false, deps) : `${base}/`;
  }
  const pair = argv[0] === "--pair";
  if (argv.length > (pair ? 1 : 0)) throw new Error(B.cliDirect.consoleUsage);
  const port = cfg.launchd?.consolePort;
  if (!port) throw new Error(B.cliDirect.consoleNoPort);
  const base = `http://127.0.0.1:${port}`;
  const status = await statusOf(base, launchdLabels(cfg).console, deps);
  if (!status.enabled) throw new Error(B.cliDirect.consoleReadOnly(userInfo().username));
  return pairOrOpen(base, tokenFileOf(cfg), status, pair, deps);
}

/** hh modules install, once the console is up: wait for it to answer, then pair and open it (a failure is a line, not a stop) */
export async function openAfterInstall(cfg: Config, deps: OpenDeps = system): Promise<string> {
  const port = cfg.launchd?.consolePort;
  for (let i = 0; port && i < 30; i++) {
    try { await deps.get(`http://127.0.0.1:${port}/api/pair/status`); break; } catch { await deps.wait?.(1000); }
  }
  try { return await consoleCommand(cfg, [], deps); }
  catch (e) { return B.cliDirect.consoleNotOpened(e instanceof Error ? e.message : String(e), cfg.id); }
}

/**
 * hh console --token-file <file>, run as the role: point console.ownerTokenFile at file in its instance config and restart
 * its console (launchd starts it again, reading the new config). Refused when the role could write there itself: then the
 * role could make itself the owner.
 */
function ownTokenFile(cfg: Config, argv: readonly string[]): string {
  const file = argv[1];
  if (argv.length !== 2 || !file || !isAbsolute(file)) throw new Error(B.cliDirect.consoleUsage);
  // the same check the console makes before it takes the owner's words from this file (owner.ts)
  if (ownersOnly(file, process.getuid?.())) throw new Error(B.cliDirect.consoleTokenWritable(dirname(file)));
  const configFile = process.env.HH_CONFIG;
  if (!configFile) throw new Error(B.cliDirect.consoleUsage);
  const raw = JSON.parse(readFileSync(configFile, "utf8")) as { console?: Record<string, unknown> };
  if (raw.console?.ownerTokenFile === file) return B.cliDirect.consoleTokenSame(file);
  const backup = `${configFile}.bak-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-ownertoken`;
  copyFileSync(configFile, backup);
  chmodSync(backup, 0o600);
  raw.console = { ...raw.console, ownerTokenFile: file };
  writeFileSync(`${configFile}.new`, `${JSON.stringify(raw, null, 2)}\n`, { mode: statSync(configFile).mode & 0o777 });
  renameSync(`${configFile}.new`, configFile);
  stopRecorded(cfg.stateDir, "console.json");
  return B.cliDirect.consoleTokenSet(file, backup);
}

interface Job { label: string; node: string; code: string; config: string; port: number }

/** the HH consoles among that account's jobs: how each runs (its node, checkout, instance config, port) */
async function consolesOf(user: string, deps: AsDeps): Promise<Job[]> {
  const jobs: Job[] = [];
  for (const j of await jobsAs((cmd) => deps.as(user, cmd), deps.platform)) {
    const [node, main] = programOf(j);
    if (!node || !main?.endsWith("/src/console/main.ts") || !j.env.HH_CONFIG || !Number(j.env.HH_CONSOLE_PORT)) continue;
    jobs.push({ label: j.label, node, code: main.slice(0, -"/src/console/main.ts".length), config: j.env.HH_CONFIG, port: Number(j.env.HH_CONSOLE_PORT) });
  }
  return jobs;
}

/** the shared place the owner writes and every account reads, where nothing of the role's can write */
const TOKEN_DIR: Record<string, string> = { darwin: "/Users/Shared/hh-console", linux: "/var/lib/hh-console" };

export async function consoleAs(argv: readonly string[], deps: AsDeps = system): Promise<string> {
  const flags = new Map<string, string>();
  let pair = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    if (k === "--pair") pair = true;
    else if (["--as", "--token-dir", "--label"].includes(k) && argv[i + 1]) flags.set(k, argv[++i]!);
    else throw new Error(B.cliDirect.consoleUsage);
  }
  const user = flags.get("--as");
  if (!user) throw new Error(B.cliDirect.consoleUsage);
  const jobs = (await consolesOf(user, deps)).filter((j) => !flags.has("--label") || j.label === flags.get("--label"));
  if (!jobs.length) throw new Error(B.cliDirect.consoleAsNone(user));
  if (jobs.length > 1) throw new Error(B.cliDirect.consoleAsMany(user, jobs.map((j) => j.label).join(", ")));
  const job = jobs[0]!;
  const base = `http://127.0.0.1:${job.port}`;
  let status = await statusOf(base, job.label, deps);
  const id = status.role ?? user;
  const dir = flags.get("--token-dir") ?? TOKEN_DIR[deps.platform]!;
  const file = join(dir, `${id}.owner`);
  const lines: string[] = [];
  if (!status.enabled) {
    // the owner's directory first: the role checks that it cannot write there. Anyone may make one in /Users/Shared/;
    // in /var/lib only root, who makes it the owner's
    try { mkdirSync(dir, { recursive: true, mode: 0o755 }); }
    catch {
      const r = await deps.as("root", ["/usr/bin/install", "-d", "-m", "755", "-o", userInfo().username, dir]);
      if (r.code) throw new Error(r.stderr.trim() || r.stdout.trim());
    }
    const r = await deps.as(user, ["/usr/bin/env", `HH_CONFIG=${job.config}`, job.node, join(job.code, "src", "cli.ts"), "console", "--token-file", file]);
    if (r.code) throw new Error(r.stderr.trim() || r.stdout.trim());
    lines.push(r.stdout.trim());
    // launchd starts the console again at once; systemd after its RestartSec (30s)
    for (let i = 0; i < 60; i++) {
      await deps.wait?.(1000);
      try { status = (await deps.get(`${base}/api/pair/status`)) as Status; if (status.enabled) break; } catch { /* restarting */ }
    }
    if (!status.enabled) throw new Error(B.cliDirect.consoleStillOff(base));
  }
  lines.push(await pairOrOpen(base, file, status, pair, deps));
  const placed = placeCommand(id, commandText({ id, config: job.config, node: job.node, code: job.code, as: { user, node: process.execPath, code: REPO } }), deps.env);
  lines.push(placedLine(id, placed));
  // the owner's window on this computer, when this account has none yet (no role of its own has made it)
  if (deps.platform === "darwin" && !existsSync(join(deps.env.HOME ?? homedir(), "Applications", "Human.app"))) {
    try { lines.push(B.cliDirect.humanBuilt(await deps.human())); }
    catch (e) { lines.push(B.cliDirect.humanNotBuilt(e instanceof Error ? e.message : String(e))); }
  }
  return lines.join("\n");
}

/** what the person installing reads about the short command */
export function placedLine(id: string, p: Placed): string {
  return "skipped" in p ? B.cliDirect.commandSkipped(id, p.skipped) : B.cliDirect.commandPlaced(id, p.file) + (p.onPath ? "" : B.cliDirect.commandNotOnPath(dirname(p.file)));
}

/** the short command for a role running under this account (hh modules install) */
export function placeOwnCommand(cfg: Config, env: { PATH?: string; HOME?: string } = { PATH: process.env.PATH, HOME: homedir() }): string {
  const config = process.env.HH_CONFIG;
  if (!config) return "";
  const placed = placeCommand(cfg.id, commandText({ id: cfg.id, config, node: nodeBin(cfg), code: REPO }), env);
  if ("file" in placed) writeFileSync(commandRecord(cfg.stateDir), `${JSON.stringify({ file: placed.file })}\n`);
  return placedLine(cfg.id, placed);
}
