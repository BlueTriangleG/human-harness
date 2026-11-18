// The console's settings → memory and learning (src/console/routes/openai.ts): the role's OpenAI key, read as set or not,
// written through the console's write checks and the owner's token. A stand-in checks keys; nothing goes to the network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer as createNet } from "node:net";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { setLang } from "../src/lang/index.ts";
import { openDb } from "../src/store/db.ts";
import { loadOpenAIKey } from "../src/memory/events/embed.ts";
import { secretsFile, type KeyCheck } from "../src/openai.ts";
import { createConsole } from "../src/console/server.ts";

const KEY = `sk-test-${"k".repeat(40)}`;
/** a console with its write ports and settings → memory and learning, over a stand-in hhd that answers status with how it runs */
async function withSettings(fn: (port: number, dir: string, o: { stateDir: string }) => Promise<void>, keyed = false) {
  const dir = tmpDir("hh-openai-console-");
  const tokenFile = join(dir, "owner.sha256");
  writeFileSync(tokenFile, `${createHash("sha256").update(TOKEN).digest("hex")}\n`);
  const sock = join(dir, "hh.sock");
  const hhd = createNet((c) => {
    c.on("data", () => c.end(`${JSON.stringify({ ok: true, data: { alertness: "awake", openai: { keyed, pending: false } } })}\n`));
  });
  await new Promise<void>((r) => hhd.listen(sock, () => r()));
  const dbPath = join(dir, "hh.db");
  openDb(dbPath).close();
  const stateDir = join(dir, "state");
  const check = async (k: string): Promise<KeyCheck> => (k === KEY ? { key: "ok", embeddings: "ok", decisions: "ok" } : { key: "key", embeddings: "skipped", decisions: "skipped" });
  const server = createConsole({
    dbPath, sockPath: sock, projectsDir: dir, logPath: join(dir, "hh.jsonl"), pageHtml: "<!doctype html><title>t</title>",
    names: { me: "Mira", owner: "Sam" }, tell: { owner: "Sam", tokenFile, roleId: "mira" },
    openai: { stateDir, tz: "UTC", dailyUsd: 1, check },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try { await fn(port, dir, { stateDir }); } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => hhd.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
}
const TOKEN = "b".repeat(64);

test("openai: the console's settings — reads say only whether there is a key; writes take the owner's token and the console's checks; a key is kept only when usable, 0600", async () => {
  setLang("en");
  await withSettings(async (port, _dir, { stateDir }) => {
    const base = `http://127.0.0.1:${port}`;
    const owner = { "content-type": "application/json", origin: base, "x-hh-console": "1", "x-hh-owner": TOKEN };
    const get = (headers: Record<string, string> = owner) => fetch(`${base}/api/openai`, { headers });
    const post = (path: string, body: unknown, headers: Record<string, string> = owner) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    const seen: string[] = [];
    const text = async (r: Response) => { const t = await r.text(); seen.push(t); return JSON.parse(t) as Record<string, unknown>; };

    assert.equal((await get({})).status, 403, "no token, no read");
    const none = await text(await get());
    assert.deepEqual(none, { set: false, running: true, mode: "words", pending: false, spend: { day: none.spend && (none.spend as { day: string }).day, usd: 0, limit: 1 }, vectors: { have: 0, missing: 0 } });

    // the console's checks: another page, no token
    assert.equal((await post("/api/openai/key", { key: KEY }, { ...owner, origin: "http://evil.example" })).status, 403);
    assert.equal((await post("/api/openai/key", { key: KEY }, { ...owner, "x-hh-owner": "c".repeat(64) })).status, 403);
    assert.equal((await post("/api/openai/remove", {}, { ...owner, "x-hh-console": "" })).status, 403);
    assert.ok(!existsSync(secretsFile(stateDir)));

    const odd = await post("/api/openai/key", { key: "not a key at all" });
    assert.equal(odd.status, 400);
    assert.ok(!(await text(odd)).error?.toString().includes("not a key at all"));
    const unknown = await post("/api/openai/key", { key: `sk-other-${"o".repeat(30)}` });
    assert.equal(unknown.status, 400);
    assert.deepEqual(await text(unknown), { saved: false, key: "key", embeddings: "skipped", decisions: "skipped", usable: false });
    assert.ok(!existsSync(secretsFile(stateDir)), "a key HH cannot use is not kept");

    assert.deepEqual(await text(await post("/api/openai/check", { key: KEY })), { key: "ok", embeddings: "ok", decisions: "ok", usable: true });
    assert.ok(!existsSync(secretsFile(stateDir)), "a check keeps nothing");
    assert.equal((await post("/api/openai/check", {})).status, 404, "no kept key to check");
    assert.deepEqual(await text(await post("/api/openai/key", { key: KEY })), { saved: true, key: "ok", embeddings: "ok", decisions: "ok", usable: true });
    assert.equal(loadOpenAIKey(stateDir), KEY);
    assert.equal(statSync(secretsFile(stateDir)).mode & 0o777, 0o600);
    assert.equal((await text(await get())).set, true);
    assert.deepEqual(await text(await post("/api/openai/check", {})), { key: "ok", embeddings: "ok", decisions: "ok", usable: true }, "the kept key, checked");
    assert.deepEqual(await text(await post("/api/openai/remove", {})), { removed: true });
    assert.equal(loadOpenAIKey(stateDir), null);
    assert.ok(!seen.join("\n").includes(KEY.slice(-6)), "no read or write answer carries any of the key");
  });
  await withSettings(async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/openai`, { headers: { "x-hh-owner": TOKEN } });
    assert.equal(((await r.json()) as { mode: string }).mode, "meaning", "hhd says it runs with a key");
  }, true);
});
