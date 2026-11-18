// The console's write ports (src/console/owner.ts): a tell is hh tell's own request; every refusal is a 403 that sends nothing.
// And the talk pane's thread (console-ui/src/thread.ts), built from central memory rows.
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer as createHttp, request as httpRequest } from "node:http";
import type { ServerResponse } from "node:http";
import { createServer as createNet } from "node:net";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { createConsole } from "../src/console/server.ts";
import type { ConsoleOptions } from "../src/console/server.ts";
import { parse } from "../src/cli-parse.ts";
import { B } from "../src/lang/index.ts";
import { PAIR_CODE_MS, TELLS_PER_MINUTE, adminAccount, talkOf, tokenMatches } from "../src/console/owner.ts";
import { consoleAs, consoleCommand, openAfterInstall } from "../src/console/open.ts";
import { SUMMARY_MAX_BYTES, getLocal, roleView, rolesOnMachine, summaryOf } from "../src/console/machine.ts";
import { MARK, commandText, placeCommand } from "../src/console/command.ts";
import { systemd } from "../src/services/systemd.ts";
import type { Config } from "../src/config.ts";
import { thread } from "../console-ui/src/thread.ts";
import type { Row } from "../console-ui/src/thread.ts";

const OWNER = "Sam";
const TOKEN = "a".repeat(64);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

interface Res { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let t = "";
      res.on("data", (c: Buffer) => { t += c.toString(); });
      // only JSON is parsed: a throw in this callback would leave the promise pending and the servers open
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: String(res.headers["content-type"]).startsWith("application/json") ? JSON.parse(t) as Record<string, unknown> : {} }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** a console with write ports over a fake control socket that records what it was sent; "no token": console.ownerToken false */
async function withConsole(fn: (port: number, sent: unknown[], dir: string) => Promise<void>, tell: boolean | "no token" = true, more: Partial<ConsoleOptions> = {}): Promise<void> {
  const dir = tmpDir("hh-console-chat-");
  mkdirSync(join(dir, "owner"));
  const tokenFile = join(dir, "owner", "role.owner");
  writeFileSync(tokenFile, sha(TOKEN) + "\n");
  const sock = join(dir, "control.sock");
  const sent: unknown[] = [];
  const hhd = createNet((c) => {
    let buf = "";
    c.on("data", (d) => {
      buf += d.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sent.push(JSON.parse(buf.slice(0, i)));
      c.end(JSON.stringify({ ok: true, data: { result: "delivered" } }) + "\n");
    });
  });
  await new Promise<void>((r) => hhd.listen(sock, () => r()));
  const o: ConsoleOptions = {
    dbPath: join(dir, "none.db"), sockPath: sock, projectsDir: dir, logPath: join(dir, "hh.jsonl"), pageHtml: "<!doctype html><title>t</title>",
    names: { me: "Mira", owner: OWNER },
    ...(tell ? { tell: { owner: OWNER, tokenFile: tell === "no token" ? null : tokenFile, roleId: "mira" } } : {}),
    ...more,
  };
  const server = createConsole(o);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  try { await fn(port, sent, dir); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => hhd.close(() => r()));
    rmSync(dir, { recursive: true });
  }
}

const good = (port: number, extra: Record<string, string> = {}): Record<string, string> => ({
  origin: `http://127.0.0.1:${port}`, "content-type": "application/json", "x-hh-console": "1", "x-hh-owner": TOKEN, ...extra,
});

test("console tell: the request on the control socket is hh tell --from <owner>'s, word for word, and asks for the reply here", async () => {
  await withConsole(async (port, sent) => {
    const r = await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "  are you there  " }));
    assert.equal(r.status, 200);
    assert.deepEqual(sent, [{ ...parse(["tell", "--from", OWNER, "are", "you", "there"]), here: true }]);
    // the browser cannot pick who speaks
    await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "hi", from: "someone else" }));
    assert.equal((sent[1] as { from: string }).from, OWNER);
  });
});

test("console tell: the owner may speak while a tell is on its way; past ten a minute it waits", async () => {
  let now = 1_800_000_000_000;
  await withConsole(async (port, sent) => {
    const all = await Promise.all(Array.from({ length: TELLS_PER_MINUTE }, (_, i) => call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: `line ${i}` }))));
    assert.deepEqual(all.map((r) => r.status), Array(TELLS_PER_MINUTE).fill(200));
    assert.equal(sent.length, TELLS_PER_MINUTE);
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "one more" }))).status, 429);
    now += 60_000;
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "one more" }))).status, 200);
    assert.equal(sent.length, TELLS_PER_MINUTE + 1);
  }, true, { now: () => now });
});

test("console tell: each impersonation is a 403 naming the check, and nothing reaches the role", async () => {
  await withConsole(async (port, sent) => {
    const body = JSON.stringify({ text: "hi" });
    const { origin: _o, ...noOrigin } = good(port);
    const { "x-hh-console": _h, ...noHeader } = good(port);
    const { "x-hh-owner": _t, ...noToken } = good(port);
    const cases: Array<[string, Record<string, string>, string]> = [
      ["another site", good(port, { origin: "http://evil.example" }), "origin"],
      ["another console's port", good(port, { origin: `http://127.0.0.1:${port + 1}` }), "origin"],
      ["no Origin", noOrigin, "origin"],
      ["no console header", noHeader, "header"],
      ["a form post", good(port, { "content-type": "text/plain" }), "header"],
      ["no token", noToken, "token"],
      ["a wrong token", good(port, { "x-hh-owner": "b".repeat(64) }), "token"],
      // the old way: a cookie goes to every port of 127.0.0.1, so it never counts, the right token in it neither
      ["the token in the old cookie", { ...noToken, cookie: `hh_owner_mira=${TOKEN}` }, "token"],
    ];
    for (const [what, headers, check] of cases) {
      const r = await call(port, "POST", "/api/tell", headers, body);
      assert.equal(r.status, 403, what);
      assert.equal(r.body.check, check, what);
    }
    const host = await call(port, "POST", "/api/tell", good(port, { host: "evil.example" }), body);
    assert.equal(host.status, 403);
    assert.deepEqual(sent, []);
  });
});

test("console tell: deleting the token file unpairs at once; empty and overlong text is refused", async () => {
  await withConsole(async (port, sent, dir) => {
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "" }))).status, 400);
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "x".repeat(4001) }))).status, 400);
    rmSync(join(dir, "owner", "role.owner"));
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "hi" }))).status, 403);
    assert.deepEqual(sent, []);
  });
});

test("console pair: hh console leaves a one-time code for a token in the owner's file; the page trades it once, in time, for the token, never a cookie", async () => {
  let now = 1_800_000_000_000;
  await withConsole(async (port, _sent, dir) => {
    const { "x-hh-owner": _t, ...h } = good(port);
    const code = "c0de".repeat(8);
    assert.equal((await call(port, "POST", "/api/pair/code", h, JSON.stringify({ token: "c".repeat(64), code }))).status, 403, "a token not in the owner's file leaves no code");
    assert.equal((await call(port, "POST", "/api/pair", h, JSON.stringify({ token: TOKEN }))).status, 403, "the token itself pairs nothing any more");
    assert.equal((await call(port, "POST", "/api/pair/code", h, JSON.stringify({ token: TOKEN, code }))).status, 200);
    assert.equal((await call(port, "POST", "/api/pair", h, JSON.stringify({ code: "bad0".repeat(8) }))).status, 403);
    const ok = await call(port, "POST", "/api/pair", h, JSON.stringify({ code }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.token, TOKEN);
    assert.equal(String(ok.headers["set-cookie"]), "hh_owner_mira=; HttpOnly; SameSite=Strict; Path=/api; Max-Age=0", "no token in any cookie");
    assert.equal((await call(port, "POST", "/api/pair", h, JSON.stringify({ code }))).status, 403, "a second time: used");
    await call(port, "POST", "/api/pair/code", h, JSON.stringify({ token: TOKEN, code }));
    now += PAIR_CODE_MS;
    assert.equal((await call(port, "POST", "/api/pair", h, JSON.stringify({ code }))).status, 403, "a minute on: gone");
    await call(port, "POST", "/api/pair/code", h, JSON.stringify({ token: TOKEN, code }));
    rmSync(join(dir, "owner", "role.owner"));
    assert.equal((await call(port, "POST", "/api/pair", h, JSON.stringify({ code }))).status, 403, "its token unpaired since: nothing");
    assert.deepEqual((await call(port, "GET", "/api/pair/status", { "x-hh-owner": TOKEN })).body, { enabled: true, token: true, paired: false, from: OWNER, name: "Mira" });
    const old = await call(port, "GET", "/api/pair/status", { cookie: `hh_owner_mira=${TOKEN}` });
    assert.equal(old.body.paired, false, "the old cookie pairs nothing");
    assert.match(String(old.headers["set-cookie"]), /^hh_owner_mira=; .*Max-Age=0$/, "and is cleared");
    assert.equal((await call(port, "GET", "/pair", {})).status, 200);
  }, true, { now: () => now });
});

test("console without a token file stays read-only", async () => {
  await withConsole(async (port, sent) => {
    assert.equal((await call(port, "POST", "/api/tell", good(port), JSON.stringify({ text: "hi" }))).status, 405);
    assert.deepEqual((await call(port, "GET", "/api/pair/status", {})).body, { enabled: false, token: false, paired: false, from: null, name: "Mira" });
    assert.deepEqual(sent, []);
  }, false);
});

test("console with the token turned off: the owner's tell needs no token, a web page is still refused", async () => {
  await withConsole(async (port, sent) => {
    const { "x-hh-owner": _t, ...h } = good(port);
    assert.equal((await call(port, "POST", "/api/tell", h, JSON.stringify({ text: "hi" }))).status, 200);
    assert.equal((await call(port, "POST", "/api/tell", { ...h, origin: "http://evil.example" }, JSON.stringify({ text: "hi" }))).status, 403);
    assert.equal((await call(port, "POST", "/api/tell", { ...h, "content-type": "text/plain" }, JSON.stringify({ text: "hi" }))).status, 403);
    assert.equal(sent.length, 1);
    assert.deepEqual((await call(port, "GET", "/api/pair/status", {})).body, { enabled: true, token: false, paired: true, from: OWNER, name: "Mira" });
  }, "no token");
});

test("talk is on by default for a role under an account that administers the machine, with the token in its state dir", () => {
  const cfg = (c?: Config["console"]) => ({ id: "mira", stateDir: "/r/state", ...(c ? { console: c } : {}) });
  assert.deepEqual(talkOf(cfg(), OWNER, true, 501), { owner: OWNER, roleId: "mira", tokenFile: "/r/state/console/owner.sha256" });
  assert.equal(talkOf(cfg({ ownerToken: false }), OWNER, true, 501)?.tokenFile, null);
  // a standard account, the role's own, logged in at the screen or not: read-only until the instance names a token it cannot write
  assert.equal(talkOf(cfg(), OWNER, false, 502), undefined);
  assert.deepEqual(talkOf(cfg({ ownerTokenFile: "/usr/share/mira.owner" }), OWNER, false, 502), { owner: OWNER, roleId: "mira", tokenFile: "/usr/share/mira.owner", guard: 502 });
  assert.equal(talkOf(cfg(), null, true, 501), undefined);
  // which accounts administer the machine: the admin group (macOS), sudo or wheel (Linux), by the ids /etc/group gives them
  const dir = tmpDir("hh-console-admin-");
  try {
    const etc = join(dir, "group");
    writeFileSync(etc, "wheel:*:0:root\nstaff:*:20:root\nadmin:*:80:root\nsudo:x:27:sam\n");
    assert.equal(adminAccount([20, 80], etc, "darwin"), true);
    assert.equal(adminAccount([20], etc, "darwin"), false, "a standard account, like a role's own");
    assert.equal(adminAccount([0], etc, "darwin"), false, "wheel is not the admin group on macOS");
    assert.equal(adminAccount([27], etc, "linux"), true);
    assert.equal(adminAccount([20, 80], etc, "win32"), false);
    assert.equal(adminAccount([80], join(dir, "none"), "darwin"), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("a role under a standard account, at the screen or not: no talk when its config names a token it could write, or turns the token off; checked at every write too", () => {
  const dir = tmpDir("hh-console-guard-");
  try {
    const me = process.getuid!(), someone = me + 1000;   // files made here are this test's: as the role's they are me's, as another account's someone's
    const cfg = (c: Config["console"]) => ({ id: "mira", stateDir: "/r/state", console: c });
    const refused: string[] = [];
    const talk = (c: Config["console"], uid: number) => talkOf(cfg(c), OWNER, false, uid, (w) => refused.push(w));
    const file = join(dir, "mira.owner");
    writeFileSync(file, `${sha(TOKEN)}\n`, { mode: 0o644 });
    chmodSync(dir, 0o755);
    assert.equal(talk({ ownerTokenFile: file }, me), undefined, "the role's own directory");
    assert.deepEqual(talk({ ownerTokenFile: file }, someone)?.guard, someone, "another account's, shut to the role");
    chmodSync(file, 0o664);
    assert.equal(talk({ ownerTokenFile: file }, someone), undefined, "the file writable by its group");
    chmodSync(file, 0o644); chmodSync(dir, 0o777);
    assert.equal(talk({ ownerTokenFile: file }, someone), undefined, "the directory writable by others");
    assert.equal(talk({ ownerTokenFile: join(dir, "none", "mira.owner") }, someone), undefined, "no directory yet");
    assert.equal(talk({ ownerToken: false }, someone), undefined, "the token turned off by the role itself");
    assert.deepEqual(refused, [dir, file, dir, join(dir, "none"), "console.ownerToken"]);
    // at every write: a file that becomes the role's to write stops matching
    chmodSync(dir, 0o755);
    assert.equal(tokenMatches(file, TOKEN, someone), true);
    assert.equal(tokenMatches(file, TOKEN, me), false);
    chmodSync(file, 0o666);
    assert.equal(tokenMatches(file, TOKEN, someone), false);
    assert.equal(tokenMatches(file, TOKEN), true, "the owner's own account is not checked");
  } finally { rmSync(dir, { recursive: true }); }
});

/** what hh console leaves with the console: each code and the token it is for (the address carries only the code) */
function fakeCodes(): { post: (base: string, path: string, body: unknown) => Promise<number>; token: (address: string) => string } {
  const left = new Map<string, string>();
  return {
    post: async (_base, path, body) => { const b = body as { token: string; code: string }; if (path === "/api/pair/code") left.set(b.code, b.token); return 200; },
    token: (address) => { const code = /\/pair#c=([0-9a-f]{32})$/.exec(address)?.[1]; assert.ok(code, address); assert.ok(left.has(code), "the code was left with the console"); return left.get(code)!; },
  };
}

test("hh console: the first time it makes the token and opens the pairing address; the token is never printed", async () => {
  const dir = tmpDir("hh-console-open-");
  try {
    const cfg = { id: "mira", stateDir: dir, launchd: { consolePort: 4321 } } as unknown as Config;
    const opened: string[] = [];
    let status: unknown = { enabled: true, token: true };
    const codes = fakeCodes();
    const deps = { open: async (u: string) => { opened.push(u); }, get: async () => status, post: codes.post };
    const file = join(dir, "console", "owner.sha256");
    const first = await consoleCommand(cfg, [], deps);
    assert.match(opened[0]!, /^http:\/\/127\.0\.0\.1:4321\/pair#c=[0-9a-f]{32}$/, "the address carries a code, not the token");
    const token = codes.token(opened[0]!);
    assert.equal(readFileSync(file, "utf8"), `${sha(token)}\n`);
    assert.equal(statSync(file).mode & 0o022, 0);
    assert.ok(!first.includes(token));
    // paired before: straight to the talk page, the token stays
    await consoleCommand(cfg, [], deps);
    assert.equal(opened[1], "http://127.0.0.1:4321/");
    assert.equal(readFileSync(file, "utf8"), `${sha(token)}\n`);
    // --pair: a new token
    await consoleCommand(cfg, ["--pair"], deps);
    assert.notEqual(readFileSync(file, "utf8"), `${sha(token)}\n`);
    // no token asked: nothing written
    rmSync(file);
    status = { enabled: true, token: false };
    await consoleCommand(cfg, [], deps);
    assert.equal(opened[3], "http://127.0.0.1:4321/");
    assert.ok(!existsSync(file));
    status = { enabled: false };
    await assert.rejects(consoleCommand(cfg, [], deps));
    await assert.rejects(consoleCommand(cfg, [], { ...deps, get: async () => { throw new Error("ECONNREFUSED"); } }));
    assert.equal(opened.length, 4);
  } finally { rmSync(dir, { recursive: true }); }
});

test("hh console where there is no desktop to open a browser in (a Linux server or container): the address is said for the owner to open, with how to reach it from another computer", async () => {
  const dir = tmpDir("hh-console-nodesk-");
  try {
    const cfg = { id: "mira", stateDir: dir, launchd: { consolePort: 4321 } } as unknown as Config;
    const deps = { open: async () => false, get: async () => ({ enabled: true, token: true }), post: fakeCodes().post };
    const out = await consoleCommand(cfg, [], deps);
    const link = /(http:\/\/127\.0\.0\.1:4321\/pair#c=[0-9a-f]{32})$/.exec(out)?.[1];
    assert.ok(link && out === B.cliDirect.consoleByHand(link, "4321"), out);
    assert.ok(out.includes("ssh -L 4321:127.0.0.1:4321"));
    assert.ok(existsSync(join(dir, "console", "owner.sha256")), "the address said pairs as an opened one would");
  } finally { rmSync(dir, { recursive: true }); }
});

test("the role's short command: in ~/.local/bin, never in another writable folder on PATH, never over a file of someone else's", () => {
  const home = tmpDir("hh-console-cmd-");
  try {
    const bin = join(home, ".local", "bin"), mine = bin, elsewhere = join(home, "other"), nvm = join(home, ".nvm", "versions", "node", "v24", "bin");
    mkdirSync(bin, { recursive: true }); mkdirSync(elsewhere); mkdirSync(nvm, { recursive: true });
    const text = commandText({ id: "mira", config: "/r/it's/instance.json", node: "/n/node", code: "/c" });
    execFileSync("/bin/sh", ["-n", "-c", text]);   // the shell reads it, quotes in paths and all
    const env = { HOME: home, PATH: ["/usr/bin", nvm, bin].join(":") };
    assert.deepEqual(placeCommand("mira", text, env), { file: join(bin, "mira"), onPath: true });
    assert.ok(!existsSync(join(nvm, "mira")), "not in a tool's own folder that comes earlier on PATH");
    assert.equal(statSync(join(bin, "mira")).mode & 0o111, 0o111);
    assert.ok(readFileSync(join(bin, "mira"), "utf8").includes(`${MARK} mira:`));
    assert.deepEqual(placeCommand("mira", text, env), { file: join(bin, "mira"), onPath: true }, "ours: written again");
    writeFileSync(join(bin, "kim"), "#!/bin/sh\necho mine\n");
    assert.deepEqual(placeCommand("kim", text, env), { skipped: join(bin, "kim") });
    assert.equal(readFileSync(join(bin, "kim"), "utf8"), "#!/bin/sh\necho mine\n");
    // the name already runs something from an earlier directory on PATH
    writeFileSync(join(elsewhere, "ada"), "x");
    assert.deepEqual(placeCommand("ada", text, { HOME: home, PATH: [elsewhere, bin].join(":") }), { skipped: join(elsewhere, "ada") });
    // no writable directory of home's on PATH: ~/.local/bin, said to be off PATH
    assert.deepEqual(placeCommand("zoe", text, { HOME: home, PATH: "/usr/bin" }), { file: join(mine, "zoe"), onPath: false });
  } finally { rmSync(home, { recursive: true }); }
});

test("hh console --as: a read-only console under another account gets its token file from the role, then the owner's browser is paired and the short command put in; on Linux from its systemd units, the token folder made by root", async () => {
  const home = tmpDir("hh-console-as-");
  try {
    const dir = join(home, "shared"), bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    // that account's plists as plutil gives them; its console started through the role's app's launcher
    const plists = [{ Label: "ai.hh.hhd", ProgramArguments: ["/r/node", "/r/hh/src/hhd.ts"], EnvironmentVariables: { HH_CONFIG: "/r/.hh/config.json" } },
      { Label: "ai.hh.console", ProgramArguments: ["/Users/Shared/HH/mira/HH.app/Contents/MacOS/HH", "--", "/r/node", "/r/hh/src/console/main.ts"], EnvironmentVariables: { HH_CONFIG: "/r/.hh/config.json", HH_CONSOLE_PORT: "7790" } }];
    let dump = plists.map((j) => `/r/home/Library/LaunchAgents/${j.Label}.plist\0${JSON.stringify(j)}\0`).join("");
    let status: Record<string, unknown> = { enabled: false, role: "mira" };
    const ran: string[][] = [], opened: string[] = [];
    const codes = fakeCodes();
    const deps = {
      open: async (u: string) => { opened.push(u); },
      get: async () => status,
      post: codes.post,
      wait: async () => {},
      as: async (user: string, cmd: readonly string[]) => {
        ran.push([user, ...cmd]);
        if (cmd[0] === "/bin/sh") return { code: 0, stdout: dump, stderr: "" };
        if (user === "root") { chmodSync(dirname(cmd.at(-1)!), 0o755); mkdirSync(cmd.at(-1)!); return { code: 0, stdout: "", stderr: "" }; }
        status = { enabled: true, token: true, role: "mira" };   // the role pointed its config at the file and restarted
        return { code: 0, stdout: "set", stderr: "" };
      },
      env: { HOME: home, PATH: bin },
      platform: "darwin",
      human: async () => { built.push(join(home, "Applications", "Human.app")); mkdirSync(built.at(-1)!, { recursive: true }); return built.at(-1)!; },
    };
    const built: string[] = [];
    const out = await consoleAs(["--as", "mira", "--token-dir", dir], deps);
    assert.deepEqual(built, [join(home, "Applications", "Human.app")], "the owner's Human.app, made once when there was none");
    assert.deepEqual(ran[1], ["mira", "/usr/bin/env", "HH_CONFIG=/r/.hh/config.json", "/r/node", "/r/hh/src/cli.ts", "console", "--token-file", join(dir, "mira.owner")]);
    assert.match(opened[0]!, /^http:\/\/127\.0\.0\.1:7790\/pair#c=[0-9a-f]{32}$/);
    const token = codes.token(opened[0]!);
    assert.equal(readFileSync(join(dir, "mira.owner"), "utf8"), `${sha(token)}\n`);
    assert.ok(!out.includes(token));
    const cmd = readFileSync(join(bin, "mira"), "utf8");
    assert.match(cmd, /console --as 'mira' "\$@"/);
    assert.match(cmd, /sudo -u 'mira' -H \/usr\/bin\/env HH_CONFIG='\/r\/\.hh\/config\.json' '\/r\/node' '\/r\/hh\/src\/cli\.ts' tell "\$\*"/);
    // set up already: no sudo for the role's half, the page opens paired
    await consoleAs(["--as", "mira", "--token-dir", dir], deps);
    assert.equal(ran.filter((r) => r.includes("--token-file")).length, 1);
    assert.equal(opened[1], "http://127.0.0.1:7790/");
    assert.equal(built.length, 1, "there already: not made again");
    await assert.rejects(consoleAs(["--as", "mira", "--label", "ai.hh.jarvis.console"], deps), /ai\.hh\.jarvis\.console|HH/);

    // Linux: the console found among the account's systemd units; the token folder's parent is not the owner's to write
    const units = systemd({ dir: "/home/mira/.config/systemd/user", systemctl: async () => ({ code: 0, stderr: "" }) }).kernelJobs({ hhd: "ai.hh.hhd", console: "ai.hh.console" },
      { NODE: "/r/node", CODE: "/r/hh", HH_CONFIG: "/r/.hh/config.json", HOME: "/home/mira", PATH: "/usr/bin", CONSOLE_PORT: "7791", LOG_DIR: "/r/logs" });
    dump = units.flatMap((j) => Object.entries(j.files)).map(([f, t]) => `/home/mira/.config/systemd/user/${f}\0${t}\0`).join("");
    const locked = join(home, "locked"), tokens = join(locked, "hh-console");
    mkdirSync(locked, { mode: 0o555 });
    rmSync(join(home, "Applications"), { recursive: true });
    status = { enabled: false, role: "mira" };
    ran.length = 0;
    await consoleAs(["--as", "mira", "--token-dir", tokens], { ...deps, platform: "linux" });
    assert.deepEqual(ran.slice(1), [["root", "/usr/bin/install", "-d", "-m", "755", "-o", userInfo().username, tokens],
      ["mira", "/usr/bin/env", "HH_CONFIG=/r/.hh/config.json", "/r/node", "/r/hh/src/cli.ts", "console", "--token-file", join(tokens, "mira.owner")]]);
    assert.match(opened.at(-1)!, /^http:\/\/127\.0\.0\.1:7791\/pair#c=[0-9a-f]{32}$/);
    assert.equal(built.length, 1, "no Human.app on Linux");
  } finally { rmSync(home, { recursive: true }); }
});

test("hh console --token-file, as the role: only to a place it cannot write; the config gets the key (with a backup) and the console is restarted", async () => {
  const dir = tmpDir("hh-console-own-");
  const before = process.env.HH_CONFIG;
  try {
    const config = join(dir, "instance.json");
    writeFileSync(config, `${JSON.stringify({ id: "mira", console: { permissionsCheck: ["x"] } })}\n`, { mode: 0o600 });
    process.env.HH_CONFIG = config;
    const cfg = { id: "mira", stateDir: join(dir, "state"), launchd: { consolePort: 4321 } } as unknown as Config;
    const open = join(dir, "open");
    mkdirSync(open);
    await assert.rejects(consoleCommand(cfg, ["--token-file", join(open, "mira.owner")]), /--token-dir/);
    assert.equal(JSON.parse(readFileSync(config, "utf8")).console.ownerTokenFile, undefined);
    // a directory of its own it cannot write is still its own; one that is another account's and shut to it will do
    const shut = join(dir, "owner");
    mkdirSync(shut);
    chmodSync(shut, 0o555);
    await assert.rejects(consoleCommand(cfg, ["--token-file", join(shut, "mira.owner")]), /--token-dir/);
    chmodSync(shut, 0o755);
    await consoleCommand(cfg, ["--token-file", "/usr/share/mira.owner"]);
    assert.deepEqual(JSON.parse(readFileSync(config, "utf8")).console, { permissionsCheck: ["x"], ownerTokenFile: "/usr/share/mira.owner" });
    assert.equal(statSync(config).mode & 0o777, 0o600);
    assert.match(await consoleCommand(cfg, ["--token-file", "/usr/share/mira.owner"]), /mira\.owner/);
  } finally {
    if (before === undefined) delete process.env.HH_CONFIG; else process.env.HH_CONFIG = before;
    rmSync(dir, { recursive: true });
  }
});

test("hh modules install, the console up for the first time: once it answers, the installer's browser is paired and opened; when it cannot be, a line says what to type", async () => {
  const dir = tmpDir("hh-console-install-");
  try {
    const cfg = { id: "mira", stateDir: dir, launchd: { consolePort: 4321 } } as unknown as Config;
    const opened: string[] = [];
    let tries = 0;
    const get = async () => { if (++tries < 3) throw new Error("ECONNREFUSED"); return { enabled: true, token: true }; };
    const codes = fakeCodes();
    await openAfterInstall(cfg, { open: async (u) => { opened.push(u); }, get, wait: async () => {}, post: codes.post });
    assert.ok(codes.token(opened[0]!));
    assert.match(await openAfterInstall(cfg, { open: async () => {}, get: async () => ({ enabled: false }), wait: async () => {}, post: codes.post }), /mira console/);
    // a console that will not take the code: nothing opened, and the line says so
    rmSync(join(dir, "console", "owner.sha256"));
    assert.match(await openAfterInstall(cfg, { open: async () => { throw new Error("opened"); }, get, wait: async () => {}, post: async () => 403 }), /403/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("hh console --url: one more client (HH.app) beside the browser; --pair unpairs them all; at most eight at once", async () => {
  const dir = tmpDir("hh-console-url-");
  try {
    const cfg = { id: "mira", stateDir: dir, launchd: { consolePort: 4321 } } as unknown as Config;
    const opened: string[] = [];
    const codes = fakeCodes();
    const deps = { open: async (u: string) => { opened.push(u); }, get: async () => ({ enabled: true, token: true }), post: codes.post };
    const file = join(dir, "console", "owner.sha256");
    const tok = codes.token;
    await consoleCommand(cfg, [], deps);
    const browser = tok(opened[0]!);
    const app = tok(await consoleCommand(cfg, ["--url"], deps));
    assert.equal(opened.length, 1, "--url opens nothing");
    assert.ok(tokenMatches(file, browser) && tokenMatches(file, app), "both paired");
    for (let i = 0; i < 8; i++) await consoleCommand(cfg, ["--url"], deps);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 8);
    assert.ok(!tokenMatches(file, browser), "the oldest went");
    await consoleCommand(cfg, ["--pair"], deps);
    assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);
    assert.ok(!tokenMatches(file, app));
  } finally { rmSync(dir, { recursive: true }); }
});

test("this computer: a role is shown only when its port is held by the account it claims, read off the listening process", () => {
  const dir = tmpDir("hh-console-machine-");
  try {
    const shared = join(dir, "HH");
    const ME = 501, LAN = 502, KIM = 503;
    const folders: Record<string, [unknown, number]> = {
      mira: [{ id: "mira", name: "米拉", account: "mira", port: 7790, node: "/x/evil" }, LAN],
      // her folder claiming to be Jarvis, a role of this account, on a port of hers: the owner would pair it
      jarvis: [{ id: "jarvis", name: "贾维斯", account: "mira", port: 7999 }, LAN],
      // a folder of hers whose port this account holds: a same-account role comes from this account's launchd only
      zoe: [{ id: "zoe", port: 57940 }, LAN],
      // named other than its id; another account's folder for her port; a name that is no id
      x: [{ id: "mira2", port: 7791 }, LAN],
      bob: [{ id: "bob", port: 7792 }, KIM],
      bad: [{ id: "../x", port: 1 }, LAN],
    };
    for (const [d, [v]] of Object.entries(folders)) { mkdirSync(join(shared, d), { recursive: true }); writeFileSync(join(shared, d, "role.json"), JSON.stringify(v)); }
    // this account's jobs as its service manager lists them (launchd's plists, or systemd's units)
    const plists: Record<string, { Label: string; ProgramArguments: string[]; EnvironmentVariables?: Record<string, string> }> = {
      "ai.hh.jarvis.console.plist": { Label: "ai.hh.jarvis.console", ProgramArguments: ["/n", "/c/src/console/main.ts"], EnvironmentVariables: { HH_CONSOLE_PORT: "57929", HH_CONFIG: "/j/instance.json" } },
      "ai.hh.mo.console.plist": { Label: "ai.hh.mo.console", ProgramArguments: ["/Applications/HH.app/Contents/MacOS/HH", "--", "/n", "/c/src/console/main.ts"], EnvironmentVariables: { HH_CONSOLE_PORT: "50001" } },
      // a job file whose port someone else listens on now
      "ai.hh.old.console.plist": { Label: "ai.hh.old.console", ProgramArguments: ["/n", "/c/src/console/main.ts"], EnvironmentVariables: { HH_CONSOLE_PORT: "50002" } },
      "ai.hh.jarvis.hhd.plist": { Label: "ai.hh.jarvis.hhd", ProgramArguments: ["/n", "/c/src/hhd.ts"] },
    };
    const jobs = Object.entries(plists).map(([f, j]) => ({ label: j.Label, files: [f], program: j.ProgramArguments, env: j.EnvironmentVariables ?? {} }));
    const listening: Record<number, number> = { 57929: ME, 50001: ME, 50002: LAN, 7790: LAN, 7999: LAN, 57940: ME, 7791: LAN, 7792: LAN, 57939: ME };
    const look = {
      me: ME, listener: (p: number) => listening[p],
      folderUid: (d: string) => folders[d.split("/").pop()!]?.[1], configId: (f: string) => (f === "/j/instance.json" ? "jarvis" : undefined),
    };
    const self = { id: "preview", name: "预览", account: "ada", port: 57939 };
    const roles = rolesOnMachine({ shared, jobs, account: "ada", self }, look);
    assert.deepEqual(roles.map((r) => [r.id, r.account, r.port]), [["preview", "ada", 57939], ["jarvis", "ada", 57929], ["mo", "ada", 50001], ["mira", "mira", 7790]]);
    assert.ok(!("node" in roles.find((r) => r.id === "mira")!), "nothing but the four fields from a role's own file");
  } finally { rmSync(dir, { recursive: true }); }
});

test("this computer: a role as its console's summary tells it, and only that; not answering is down", async () => {
  const asked: string[] = [];
  const e = { id: "jarvis", name: "jarvis", account: "ada", port: 57929 };
  const v = await roleView(e, async (u) => { asked.push(new URL(u).pathname); return { up: true, alertness: "awake", busy: true, quota: 47, load: "tight", today: { stops: 1, refusals: 0, blocks: 2 } }; });
  assert.deepEqual(asked, ["/api/summary"], "never another console's own reads: those are its owner's");
  assert.deepEqual({ ...v }, { ...e, up: true, alertness: "awake", nightRest: false, focus: false, busy: true, quota: 47, load: "tight", today: { stops: 1, refusals: 0, blocks: 2 }, rulesErrors: 0 });
  assert.equal((await roleView(e, async () => { throw new Error("ECONNREFUSED"); })).up, false);
});

test("this computer: another console's summary cannot rename its role, move its port or say more than the summary's keys", async () => {
  const e = { id: "mira", name: "米拉", account: "mira", port: 7790 };
  const v = await roleView(e, async () => ({
    id: "jarvis", name: "贾维斯", account: "ada", port: 57929, lang: "en", up: "yes", alertness: "说点什么", focus: 1, busy: true,
    quota: "47", load: "<b>", today: { stops: -1, refusals: 2.5, blocks: "3" }, rulesErrors: Infinity, extra: "x",
  }));
  assert.deepEqual({ ...v }, { ...e, up: false, alertness: null, nightRest: false, focus: false, busy: true, quota: null, load: null, today: { stops: 0, refusals: 0, blocks: 0 }, rulesErrors: 0 });
});

test("summary: how the role is, never what about — no topic, no words, no name, whatever its status holds", () => {
  const NOW = Date.UTC(2026, 10, 17, 3, 0);   // 14:00 in Melbourne, the 17th
  const st = { ok: true, status: { alertness: "awake", focusSlot: { why: "剪祥子" }, regions: [{ id: "main", busy: true }], claims: [{ topic: "整理笔记", owner: "main" }], quotaUsed: { sevenDay: 47 }, rulesErrors: [{ rule: "r", error: "x" }], lastFrom: "阿树", lastText: "在吗" } };
  const inc = { tz: "Australia/Melbourne", hours: [{ day: "2026-11-17", stops: 1, refusals: 0, blocks: 2, what: "阿树的私信" }, { day: "2026-11-16", stops: 5, refusals: 5, blocks: 5 }] };
  const s = summaryOf(st, inc, { level: "tight", why: ["swap 37 GB"], mine_top: [["ffmpeg", 47000]] }, NOW);
  assert.deepEqual(s, { up: true, alertness: "awake", nightRest: false, focus: true, busy: true, quota: 47, load: "tight", today: { stops: 1, refusals: 0, blocks: 2 }, rulesErrors: 1 });
  for (const word of ["剪祥子", "整理笔记", "阿树", "在吗", "私信", "swap", "ffmpeg", "main"]) assert.ok(!JSON.stringify(s).includes(word), word);
  assert.equal(summaryOf({ ok: false, error: "hhd 没有回应" }, null, null, NOW).up, false);
});

test("console reads: every /api/ read takes the owner's token as the writes do; the summary and the pairing status do not", async () => {
  await withConsole(async (port) => {
    for (const path of ["/api/status", "/api/central", "/api/load", "/api/machine", "/api/workers", "/api/stream?after=0"]) {
      const r = await call(port, "GET", path, {});
      assert.equal(r.status, 403, path);
      assert.equal(r.body.check, "token", path);
      assert.equal((await call(port, "GET", path, { cookie: `hh_owner_mira=${TOKEN}` })).status, 403, `${path}: an old cookie is not the token`);
      assert.equal((await call(port, "GET", path, { "x-hh-owner": "b".repeat(64) })).status, 403, `${path}: a wrong token`);
    }
    assert.equal((await call(port, "GET", "/api/load", { "x-hh-owner": TOKEN })).status, 200);
    const sum = await call(port, "GET", "/api/summary", {});
    assert.equal(sum.status, 200);
    assert.deepEqual(Object.keys(sum.body).sort(), ["alertness", "busy", "focus", "load", "nightRest", "quota", "rulesErrors", "today", "up"]);
    assert.equal((await call(port, "GET", "/api/pair/status", {})).status, 200);
    assert.equal((await call(port, "GET", "/", {})).status, 200, "the page itself: it shows how to pair");
  });
  // a console that takes no owner's words at all reads nothing either; one that asks no token (the owner's own account) reads open
  await withConsole(async (port) => { assert.equal((await call(port, "GET", "/api/load", {})).status, 403); }, false);
  await withConsole(async (port) => { assert.equal((await call(port, "GET", "/api/load", {})).status, 200); }, "no token");
});

test("console page: framed only by itself or another console on 127.0.0.1", async () => {
  await withConsole(async (port) => {
    assert.match(String((await call(port, "GET", "/", {})).headers["content-security-policy"]), /frame-ancestors 'self' http:\/\/127\.0\.0\.1:\*$/);
  });
});

/** an HTTP server on 127.0.0.1 answering every request with `answer`; returns its port and how many it was asked */
async function local(answer: (res: ServerResponse) => void): Promise<{ port: number; hits: () => number; close: () => Promise<void> }> {
  let n = 0;
  const s = createHttp((_req, res) => { n++; answer(res); });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return { port: (s.address() as AddressInfo).port, hits: () => n, close: () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); }) };
}

test("this computer: another console is asked on 127.0.0.1 only, a redirect is not followed, more than 64 KB is no answer", async () => {
  const target = await local((res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"up":true}'); });
  const bounce = await local((res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.port}/api/summary` }); res.end(); });
  const big = await local((res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ up: true, pad: "x".repeat(SUMMARY_MAX_BYTES) })); });
  try {
    assert.deepEqual(await getLocal(`http://127.0.0.1:${target.port}/api/summary`), { up: true });
    await assert.rejects(getLocal(`http://127.0.0.1:${bounce.port}/api/summary`), /HTTP 302/);
    assert.equal(target.hits(), 1, "the redirect's target was never asked");
    await assert.rejects(getLocal(`http://127.0.0.1:${big.port}/api/summary`), /more than 65536 bytes/);
    await assert.rejects(getLocal(`http://localhost:${target.port}/api/summary`), /not a console on this computer/);
    await assert.rejects(getLocal("http://192.0.2.1/api/summary"), /not a console on this computer/);
    assert.equal((await roleView({ id: "x", name: "x", account: "a", port: bounce.port }, getLocal)).up, false);
  } finally { await Promise.all([target.close(), bounce.close(), big.close()]); }
});

test("/api/load: this role's load guard as its status file says; none yet, no level", async () => {
  const dir = tmpDir("hh-console-load-");
  try {
    const file = join(dir, "status.json");
    writeFileSync(file, JSON.stringify({ at: "2026-11-17 14:00:00", level: "danger", why: ["压缩区 89%"], pressure: 3, swap_gb: 37.6, mine_top: [["x", 1]] }));
    await withConsole(async (port) => {
      assert.deepEqual((await call(port, "GET", "/api/load", { "x-hh-owner": TOKEN })).body, { at: "2026-11-17 14:00:00", level: "danger", why: ["压缩区 89%"], pressure: 3, avail_pct: null, seg_pct: null, swap_gb: 37.6, disk_gb: null });
    }, true, { loadStatus: file });
    await withConsole(async (port) => { assert.deepEqual((await call(port, "GET", "/api/load", { "x-hh-owner": TOKEN })).body, { level: null }); }, true, { loadStatus: join(dir, "none.json") });
  } finally { rmSync(dir, { recursive: true }); }
});

test("talk pane thread: the owner's turns, with thinking, tool calls and their results, and the reply", () => {
  const row = (seq: number, src: string, kind: string, text: string, meta: Record<string, unknown> | null = null): Row => ({ seq, ts: seq * 1000, src, kind, text, meta });
  const rows: Row[] = [
    row(1, "main", "say", "before the owner spoke"),
    row(2, "外界", "input", "what time is it", { from: OWNER, channel: "local" }),
    row(3, "main", "think", "check the clock"),
    row(4, "main", "act", 'Bash {"command":"date"}', { tool: "Bash", id: "t1" }),
    row(5, "main", "result", "Mon 23:40", { id: "t1" }),
    row(6, "外界", "input", "a sense", { from: "senses", channel: "senses" }),
    row(7, "main", "say", "It is 23:40."),
    row(8, "main", "note", "(printed for Sam, on this computer) It is 23:40.", { sent: true, local: true, to: OWNER }),
    row(9, "main", "say", "something else later"),
    row(10, "外界", "input", "and now", { from: OWNER, channel: "local" }),
    row(11, "main", "act", 'Read {"file_path":"x"}', { tool: "Read", id: "t2" }),
    row(12, "main", "result", "no such file", { id: "t2", error: true }),
    row(13, "外界", "input", "not the owner", { from: "Kim", channel: "local" }),
  ];
  const t = thread(rows, OWNER, true);
  assert.deepEqual(t.map((m) => [m.id, m.role, m.status?.type ?? null]), [["u2", "user", null], ["a2", "assistant", "complete"], ["u10", "user", null], ["a10", "assistant", "running"]]);
  assert.deepEqual(t[1]!.content, [
    { type: "reasoning", text: "check the clock" },
    { type: "tool-call", toolCallId: "t1", toolName: "Bash", args: { command: "date" }, argsText: '{"command":"date"}', result: "Mon 23:40" },
    { type: "text", text: "It is 23:40." },
  ]);
  assert.deepEqual(t[3]!.content, [{ type: "tool-call", toolCallId: "t2", toolName: "Read", args: { file_path: "x" }, argsText: '{"file_path":"x"}', result: "no such file", isError: true }]);
  assert.equal(thread(rows, OWNER, false)[3]!.status?.type, "complete");
});

test("talk pane thread: a program's tell under the owner's name (setup's \"you have just been made\") is not the owner speaking; the hello is the role's own turn", () => {
  const row = (seq: number, src: string, kind: string, text: string, meta: Record<string, unknown> | null = null): Row => ({ seq, ts: seq * 1000, src, kind, text, meta });
  const rows: Row[] = [
    row(1, "外界", "input", "(A note from setup.) You have just been made: say hello.", { from: OWNER, channel: "local", human: false }),
    row(2, "main", "say", "Hi, I'm Mira."),
    row(3, "main", "note", "(printed for Sam, on this computer) Hi, I'm Mira.", { sent: true, local: true, to: OWNER }),
    row(4, "外界", "input", "hello Mira", { from: OWNER, channel: "local", human: true }),
  ];
  const t = thread(rows, OWNER, true);
  assert.deepEqual(t.map((m) => [m.id, m.role]), [["f2", "assistant"], ["u4", "user"], ["a4", "assistant"]]);
  assert.deepEqual(t[0]!.content, [{ type: "text", text: "Hi, I'm Mira." }]);
});

test("talk pane thread: said while the role answers, it is unseen until a tool returns; a turn of its own answers what it missed", () => {
  const row = (seq: number, src: string, kind: string, text: string, meta: Record<string, unknown> | null = null): Row => ({ seq, ts: seq * 1000, src, kind, text, meta });
  const note = (seq: number, text: string): Row => row(seq, "main", "note", text, { sent: true, local: true, to: OWNER });
  const rows: Row[] = [
    row(1, "外界", "input", "where are my keys", { from: OWNER, channel: "local" }),
    row(2, "main", "think", "the drawer"),
    row(3, "外界", "input", "and the wallet", { from: OWNER, channel: "local" }),
    row(4, "main", "say", "In the drawer."),
    note(5, "In the drawer."),
    // hhd wakes it again for the line it did not see: no input row before this turn
    row(6, "main", "think", "the wallet"),
    row(7, "main", "say", "On the desk."),
    note(8, "On the desk."),
    row(9, "main", "say", "a turn of its own"),
  ];
  const state = (t: ReturnType<typeof thread>, id: string) => t.find((m) => m.id === id)?.metadata?.custom.state ?? null;
  assert.equal(state(thread(rows.slice(0, 4), OWNER, true), "u3"), "unseen");
  assert.deepEqual(thread([rows[0]!, rows[2]!], OWNER, true).map((m) => m.id), ["u1", "u3", "a3"]);
  // the call made before the owner spoke again gets its result after
  const split = thread([rows[0]!, row(2, "main", "act", "Bash {}", { tool: "Bash", id: "t9" }), rows[2]!, row(4, "main", "result", "done", { id: "t9" })], OWNER, true);
  assert.equal((split[1]!.content[0] as { result?: string }).result, "done");
  assert.equal(state(thread([...rows.slice(0, 3), row(4, "main", "act", "Bash {}", { tool: "Bash", id: "t" }), row(5, "main", "result", "ok", { id: "t" })], OWNER, true), "u3"), null);
  // the turn that answers it, while it runs and once it replied
  assert.deepEqual(thread(rows.slice(0, 6), OWNER, true).map((m) => [m.id, m.status?.type ?? null]), [["u1", null], ["a1", "complete"], ["u3", null], ["a3", "complete"], ["f6", "running"]]);
  const t = thread(rows, OWNER, false);
  assert.deepEqual(t.map((m) => [m.id, m.status?.type ?? null]), [["u1", null], ["a1", "complete"], ["u3", null], ["a3", "complete"], ["f6", "complete"]]);
  assert.deepEqual(t[4]!.content, [{ type: "reasoning", text: "the wallet" }, { type: "text", text: "On the desk." }]);
});

test("talk pane: a turn that failed ends at its note, which says why and is drawn as the turn's text", () => {
  const row = (seq: number, src: string, kind: string, text: string, meta: Record<string, unknown> | null = null): Row => ({ seq, ts: seq * 1000, src, kind, text, meta });
  const rows = [row(1, "外界", "input", "where is it?", { channel: "local", from: OWNER }), row(2, "main", "note", "Claude Code is not logged in", { local: true, failed: true, to: OWNER })];
  const t = thread(rows, OWNER, false);
  assert.deepEqual(t.map((m) => [m.role, m.status?.type ?? null]), [["user", null], ["assistant", "complete"]]);
  assert.deepEqual(t[1]!.content, [{ type: "text", text: "Claude Code is not logged in" }]);
});

test("talk pane bundle: what is committed is console-ui's build, untouched (console-ui/check.sh rebuilds it from the lock file)", async () => {
  const { readFileSync } = await import("node:fs");
  const root = new URL("..", import.meta.url).pathname;
  const lines = readFileSync(join(root, "console-ui/app.sha256"), "utf8").trim().split("\n");
  assert.deepEqual(lines.map((l) => l.split(/\s+/)[1]), ["chat.js", "chat.css"]);
  for (const l of lines) {
    const [want, file] = l.split(/\s+/) as [string, string];
    const body = readFileSync(join(root, "src/console/web/app", file));
    assert.equal(createHash("sha256").update(body).digest("hex"), want, `${file} differs from the recorded build`);
    assert.match(body.toString("utf8"), /^\/\*!? generated by console-ui/, `${file} is marked generated`);
  }
});
