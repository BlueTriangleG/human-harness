// 核对（护栏后面的留痕）：线上代码和上次部署的提交一不一样（她自己改的，部署前存成分支）；仓库外几样敏感文件有没有在流程外变过。
// The role's app too: still the one built and signed for it (a valid signature by its own certificate, its bundle id, its launcher its own).
// 敏感文件只比 hash 和权限位，不读出内容。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "./git.ts";
import { R } from "../lang/index.ts";

export interface Drift { path: string; how: "changed" | "missing" | "extra" }

/**
 * git run against the live copy as if it were a checkout of `commit` (it is an extracted tree, not a repository): a throwaway index
 * read from the commit, the live directory as the work tree, so its .gitignore applies. `g` runs git with both bound
 */
function onLive<T>(gitDir: string, live: string, commit: string, fn: (g: (args: string[], env?: NodeJS.ProcessEnv) => string) => T): T {
  const d = mkdtempSync(join(tmpdir(), "hh-live-index-"));
  try {
    const g = (args: string[], env: NodeJS.ProcessEnv = {}) => git(gitDir, [`--work-tree=${live}`, ...args], undefined, { GIT_INDEX_FILE: join(d, "index"), ...env });
    g(["read-tree", commit]);
    return fn(g);
  } finally { rmSync(d, { recursive: true, force: true }); }
}

/** What `git status --porcelain` says of the live copy against the deployed commit: changed, missing, and files not in it (anywhere its .gitignore does not leave out) */
export function liveDrift(gitDir: string, live: string, commit: string): Drift[] {
  const out = onLive(gitDir, live, commit, (g) => g(["status", "--porcelain", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules"]));
  // XY path: Y is the work tree against the index (X, the index against the repository's HEAD, says nothing about the live copy)
  return out.split("\0").filter((e) => e.startsWith("??") || (e.length > 3 && e[1] !== " "))
    .map((e): Drift => ({ path: e.slice(3), how: e.startsWith("??") ? "extra" : e[1] === "D" ? "missing" : "changed" }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * The role's own edits to the live copy, kept before a deploy replaces them: the live tree as `git add -A` sees it, committed on top
 * of the deployed commit as the role and written to the shared repository as `branch`, for the team to read and decide on
 */
export function keepLocal(gitDir: string, live: string, commit: string, branch: string, who: { name: string; email: string }, message: string): string {
  return onLive(gitDir, live, commit, (g) => {
    g(["add", "-A"]);
    const id = { GIT_AUTHOR_NAME: who.name, GIT_AUTHOR_EMAIL: who.email, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email };
    const sha = g(["commit-tree", g(["write-tree"]), "-p", commit, "-m", message], id);
    g(["update-ref", `refs/heads/${branch}`, sha, ""]);   // "": the branch must not exist yet
    return sha;
  });
}

export interface Stamp { path: string; sha256: string | null; mode: number | null }

/**
 * 路径带 `#主人` 的（人名单）只算谁算主人：主人那一条的 senders 和 sessionKeys（她照手册改备注、别名不算漂移）。
 * 算法和 hh-guard baseline 里的一样：`senders:` + 排好序一行一个 + `\nsessionKeys:` + 排好序一行一个。
 */
export function stamp(paths: string[]): Stamp[] {
  return paths.map((path) => {
    const [file, part] = path.split("#") as [string, string | undefined];
    try {
      const raw = readFileSync(file);
      const body = part ? personIdentity(raw.toString("utf8"), part) : raw;
      return { path, sha256: createHash("sha256").update(body).digest("hex"), mode: statSync(file).mode & 0o777 };
    } catch { return { path, sha256: null, mode: null }; }
  });
}

function personIdentity(json: string, name: string): string {
  const g = (JSON.parse(json) as Record<string, { senders?: string[]; sessionKeys?: string[] } | undefined>)[name] ?? {};
  const list = (xs: string[] | undefined) => [...(xs ?? [])].sort().join("\n");
  return `senders:${list(g.senders)}\nsessionKeys:${list(g.sessionKeys)}`;
}

const show = (s: Stamp | undefined) => (s?.sha256 ? `${s.sha256.slice(0, 8)}/${(s.mode ?? 0).toString(8)}` : R.audit.auditNoStamp);

export function sensitiveDrift(baseline: Stamp[], now: Stamp[]): Array<{ path: string; was: string; now: string }> {
  const out: Array<{ path: string; was: string; now: string }> = [];
  for (const n of now) {
    const b = baseline.find((x) => x.path === n.path);
    if (!b) { out.push({ path: n.path, was: R.audit.auditNoBaseline, now: show(n) }); continue; }
    if (b.sha256 !== n.sha256 || b.mode !== n.mode) out.push({ path: n.path, was: show(b), now: show(n) });
  }
  return out;
}

/** 要核对的仓库外敏感文件：配置（能改权限模式）、密钥、谁算主人（人名单里只看主人那一条的号码和会话） */
export function sensitivePaths(workspace: string, stateDir: string, owner: string): string[] {
  return [join(stateDir, "config.json"), join(stateDir, "secrets.json"), `${join(workspace, "memory", "people", "registry.json")}#${owner}`];
}

export type AppFault = "missing" | "unsigned" | "identity" | "signer" | "bundle" | "launcher";
export type Run = (cmd: string, args: string[]) => { ok: boolean; out: string };
const runCmd: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * The role's app as src/services/app.ts builds it, checked without unlocking anything: there; a valid signature
 * (codesign --verify --strict); a designated requirement that names the role's own certificate (<stateDir>/app/signing.pem);
 * Info.plist's bundle id ai.hh.role.<id>; the launcher (Contents/MacOS/HH) the role's account's and writable by no one else.
 * What is not so, by name; [] when all is.
 */
export function appFaults(app: string, id: string, stateDir: string, uid: number, run: Run = runCmd): AppFault[] {
  if (!existsSync(join(app, "Contents"))) return ["missing"];
  const f: AppFault[] = [];
  if (!run("/usr/bin/codesign", ["--verify", "--strict", app]).ok) f.push("unsigned");
  const fp = run("/usr/bin/openssl", ["x509", "-noout", "-fingerprint", "-sha1", "-in", join(stateDir, "app", "signing.pem")]);
  const sha1 = fp.ok ? fp.out.trim().replace(/^.*=/, "").replace(/[:\s]/g, "").toLowerCase() : "";
  if (!sha1) f.push("identity");
  else if (!run("/usr/bin/codesign", ["-d", "-r-", app]).out.includes(`certificate leaf = H"${sha1}"`)) f.push("signer");
  let plist = "";
  try { plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8"); } catch { /* no Info.plist: the id is wrong */ }
  if (!plist.includes(`<string>ai.hh.role.${id}</string>`)) f.push("bundle");
  try {
    const s = statSync(join(app, "Contents", "MacOS", "HH"));
    if (s.uid !== uid || (s.mode & 0o022) !== 0) f.push("launcher");
  } catch { f.push("launcher"); }
  return f;
}
