// macOS: the role's own app (launchd.app, <folder>/<name>.app, ai.hh.role.<id>), built from apps/macos and signed by the
// role's own identity. macOS keeps the owner's privacy grants by bundle id and signer, so they outlast a rebuild, a new
// name or a new icon, and no other role can sign an app as this one. Beside the app, role.json tells the owner's
// Human.app which role the folder is. Human.app (this computer's roles, the menu bar) is the owner's, in the owner's
// ~/Applications: it starts no job and is given no privacy grant, so it is signed ad hoc.
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { launchdLabels, roleNames, type Config } from "../config.ts";
import { adminAccount } from "../console/owner.ts";
import { DEFAULT_LANG } from "../lang/index.ts";
import { REPO } from "./launchd.ts";
import { services, type ServiceManager } from "./index.ts";

/** a command's output; a failure says the command and its stderr, never its arguments (a keychain's password is one) */
async function run(cmd: string, args: string[], env?: Record<string, string>): Promise<string> {
  try { return (await promisify(execFile)(cmd, args, { maxBuffer: 1 << 24, ...(env ? { env: { ...process.env, ...env } } : {}) })).stdout; }
  catch (e) { throw new Error(`${basename(cmd)} ${cmd === "security" ? args[0] : ""}: ${String((e as { stderr?: string }).stderr ?? e).trim()}`); }
}
/** where the apps of roles under accounts of their own are, each in a folder named as its role's id: root's, mode 755; each folder its role's */
export const SHARED = "/Users/Shared/HH";

/**
 * The folder of a role's app: under the owner's own account (one that administers the machine) ~/Applications/HH/<id>,
 * which install makes; under an account of its own /Users/Shared/HH/<id>, which the owner makes once (sudo): the owner
 * cannot see into that account's home, and its app must be where he can open it.
 */
export const appFolder = (id: string, admin = adminAccount()): string => (admin ? join(homedir(), "Applications", "HH", id) : join(SHARED, id));
const OPENSSL = "/usr/bin/openssl";

const REQUEST = (id: string) => `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = HH ${id}
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
`;

/**
 * The role's signing identity in its own keychain under `dir`, made the first time: a self-signed code signing
 * certificate whose key only codesign may use, the keychain's password in a file only the role reads. Returns the
 * keychain, unlocked, and the certificate's SHA-1 (what codesign signs with).
 */
export async function signingIdentity(dir: string, id: string): Promise<{ keychain: string; sha1: string }> {
  const keychain = join(dir, "signing.keychain-db"), pass = join(dir, "signing.pass"), cert = join(dir, "signing.pem");
  if (!existsSync(keychain)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(dir, "new-"));
    try {
      const t = (f: string) => join(tmp, f), p = randomBytes(24).toString("hex");
      writeFileSync(t("req.cnf"), REQUEST(id));
      await run(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", t("key.pem"), "-out", t("cert.pem"), "-days", "7300", "-config", t("req.cnf")]);
      await run(OPENSSL, ["pkcs12", "-export", "-inkey", t("key.pem"), "-in", t("cert.pem"), "-out", t("id.p12"), "-passout", "pass:hh"]);
      await run("security", ["create-keychain", "-p", p, t("k.keychain-db")]);
      await run("security", ["set-keychain-settings", t("k.keychain-db")]);   // never locks on its own
      await run("security", ["import", t("id.p12"), "-k", t("k.keychain-db"), "-P", "hh", "-T", "/usr/bin/codesign"]);
      await run("security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", p, t("k.keychain-db")]);
      writeFileSync(pass, p, { mode: 0o600 });
      renameSync(t("cert.pem"), cert);
      renameSync(t("k.keychain-db"), keychain);   // last: a keychain there is a whole identity
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }
  await run("security", ["unlock-keychain", "-p", readFileSync(pass, "utf8"), keychain]);
  const sha1 = (await run(OPENSSL, ["x509", "-noout", "-fingerprint", "-sha1", "-in", cert])).replace(/^.*=/, "").replace(/[:\s]/g, "");
  return { keychain, sha1 };
}

const BUILD = join(REPO, "apps", "macos", "build.sh");

/**
 * The port the role's console listens on: its config's, else the one its console job starts it with (a role set up before
 * hh new wrote the port into the config has it only there); undefined when neither says.
 */
export async function consolePort(cfg: Pick<Config, "launchd">, svc: ServiceManager = services()): Promise<number | undefined> {
  if (cfg.launchd?.consolePort) return cfg.launchd.consolePort;
  const label = launchdLabels(cfg).console;
  const port = Number((await svc.list(label)).find((j) => j.label === label)?.env.HH_CONSOLE_PORT);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

const HUMAN = join(homedir(), "Applications", "Human.app");

/**
 * A role without a picture: its icon is the first letter of its name (a whole character, not a byte) on a colour its id
 * gives, the same for the same id (the wizard's preview draws it with these two; the app's build draws the icon)
 */
export const initialOf = (name: string): string => [...new Intl.Segmenter().segment(name.trim())][0]?.segment.toUpperCase() ?? "?";
export function colorOf(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.codePointAt(0)!) >>> 0;
  // a hue from the id, at a saturation and lightness white letters read well on
  const hue = h % 360, s = 0.55, l = 0.45, k = (n: number) => (n + hue / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Human.app is there and names this repository's hh (an older one has no "+ New Human" to offer) */
function humanKnowsHh(): boolean {
  try { return readFileSync(join(HUMAN, "Contents", "Info.plist"), "utf8").includes(`<key>HHCommand</key><string>${join(REPO, "bin", "hh")}</string>`); } catch { return false; }
}

/** The owner's Human.app, built afresh (ad hoc) in ~/Applications; returns where. Its Info.plist names the hh command
 *  (HHCommand) its "+ New Human" runs as hh setup --wizard, and the node it runs on (HHNode: an app opened from the
 *  Finder has no PATH to find one) */
export async function buildHuman(): Promise<string> {
  mkdirSync(dirname(HUMAN), { recursive: true });
  await run(BUILD, [HUMAN, "ai.hh.human", "Human", "-"], { HH_COMMAND: join(REPO, "bin", "hh"), HH_NODE: process.execPath });
  return HUMAN;
}

/** Whether the app is this role's as built: intact, its bundle id, signed by the role's identity (certificate `sha1`) */
async function intact(app: string, id: string, sha1: string): Promise<boolean> {
  try {
    if (!readFileSync(join(app, "Contents", "Info.plist"), "utf8").includes(`<string>ai.hh.role.${id}</string>`)) return false;
    await run("codesign", ["--verify", "--strict", app]);
    const r = await promisify(execFile)("codesign", ["-d", "-r-", app]);
    return `${r.stdout}${r.stderr}`.includes(`certificate leaf = H"${sha1.toLowerCase()}"`);
  } catch { return false; }
}

/**
 * The role's app at launchd.app (its folder must exist: the owner makes it), signed by the role's identity
 * (<stateDir>/app), named as the role, its avatar the icon; and role.json beside it (id, name, account, console port:
 * the role's window takes its title from it; lang: the language of its permission page). An app already there, intact and the role's, is kept as it is unless
 * `rebuild`: the owner's grants have been given to it, and a rebuild must not cost him another round of them.
 * Under the owner's own account (one that administers the machine) Human.app too, when there is none or on `rebuild`.
 * built: the role's app was built; human: where Human.app was built. A throw says what failed.
 */
export async function buildApp(cfg: Config, rebuild = false): Promise<{ built: boolean; human?: string }> {
  const app = cfg.launchd!.app!, name = roleNames(cfg).me || cfg.id;
  const { keychain, sha1 } = await signingIdentity(join(cfg.stateDir, "app"), cfg.id);
  const built = rebuild || !(await intact(app, cfg.id, sha1));
  if (built) await run(BUILD, [app, `ai.hh.role.${cfg.id}`, name, sha1, keychain, ...(cfg.avatar ? [cfg.avatar] : [])], cfg.avatar ? undefined : { HH_ICON_LETTER: initialOf(name), HH_ICON_COLOR: colorOf(cfg.id) });
  writeFileSync(join(dirname(app), "role.json"), `${JSON.stringify({ id: cfg.id, name, account: userInfo().username, port: await consolePort(cfg), lang: cfg.lang || DEFAULT_LANG }, null, 2)}\n`);
  return { built, human: adminAccount() && (rebuild || !humanKnowsHh()) ? await buildHuman() : undefined };
}

/** what the role's app may do: Full Disk Access, Screen & System Audio Recording, Accessibility */
export interface GrantState { fda: boolean; screen: boolean; ax: boolean }
export const GRANTS = ["fda", "screen", "ax"] as const;

/**
 * The owner turns the role's app's permissions on, on the app's own page (HH --grants, apps/macos/Sources/Grants.swift: a
 * button and a live ✓ each; the app asks for them itself, it is their owner). Opened when whoever runs this is the person
 * at the screen; waited for until the page closes (by itself once all three are on, or put off) or `waitMs` passes.
 * What the page last read; null when nobody at the screen runs this (the owner opens the app himself then).
 */
export async function askGrants(app: string, waitMs = 600_000): Promise<GrantState | null> {
  if (statSync("/dev/console").uid !== process.getuid?.()) return null;
  const dir = mkdtempSync(join(tmpdir(), "hh-grants-")), file = join(dir, "status.json");
  const page = spawn("/usr/bin/open", ["-n", "-W", app, "--args", "--grants", "--status", file], { stdio: "ignore" });
  let open = true;
  page.on("exit", () => { open = false; });
  try {
    for (const end = Date.now() + waitMs; open && Date.now() < end; ) await new Promise((r) => setTimeout(r, 1000));
    try { return JSON.parse(readFileSync(file, "utf8")) as GrantState; } catch { return { fda: false, screen: false, ax: false }; }
  } finally {
    if (open) page.kill();   // the page stays up for the owner; only the wait ends
    rmSync(dir, { recursive: true, force: true });
  }
}
