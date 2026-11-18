// The role's OpenAI key. It lives in one place, <stateDir>/secrets.json's openaiKey (0600, this account's alone), and hhd
// reads it when it starts (loadOpenAIKey in src/memory/events/embed.ts): with it, memory and the notebook find things by
// meaning (embeddings) and the notebook's judge scores pages (decisions); without it both go by words. Here: writing it,
// taking it away, checking one (a call that costs nothing first, then the two HH makes, the smallest of each), and the
// operator's command, hh openai. A key is never printed, logged or put on a command line; what a check says of a failure is
// its kind, never OpenAI's words (they echo part of the key).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Config } from "./config.ts";
import { B } from "./lang/index.ts";
import { DECISIONS_MODEL, DECISIONS_URL } from "./learning/decisions.ts";
import { EMBED_DIMS, EMBED_MODEL, EMBEDDINGS_URL, loadOpenAIKey } from "./memory/events/embed.ts";

const MODELS_URL = "https://api.openai.com/v1/models";
const SECRETS = "secrets.json";

export const secretsFile = (stateDir: string): string => join(stateDir, SECRETS);

/** Write the key into <stateDir>/secrets.json, or with null take it out, keeping whatever else the file holds; 0600 */
export function saveOpenAIKey(stateDir: string, key: string | null): void {
  const file = secretsFile(stateDir);
  // a file there that is not JSON throws: what else it holds is not thrown away
  const j = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown> : {};
  if (key) j.openaiKey = key; else delete j.openaiKey;
  mkdirSync(stateDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(j, null, 1)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

/** what one call came to: ok, or the kind of failure (the key not known, not allowed this, out of quota, no answer, another) */
export type Outcome = "ok" | "key" | "denied" | "quota" | "network" | "failed";
export interface KeyCheck { key: Outcome; embeddings: Outcome | "skipped"; decisions: Outcome | "skipped" }

/** a key HH can use: OpenAI knows it and embeddings answer (decisions may not: the notebook's judge then goes by words) */
export const usable = (c: KeyCheck): boolean => c.key === "ok" && c.embeddings === "ok";

const outcome = (status: number): Outcome => (status === 401 ? "key" : status === 403 || status === 404 ? "denied" : status === 429 ? "quota" : "failed");

/**
 * Check a key: the list of models (costs nothing) says whether OpenAI knows it; then one embedding of a word and one decision
 * of one question, as HH makes them (a tiny fraction of a cent together). When the key is not known, nothing is spent.
 */
export async function checkOpenAIKey(key: string, fetchImpl: typeof fetch = (i, init) => globalThis.fetch(i, init), timeoutMs = 20_000): Promise<KeyCheck> {
  const call = async (url: string, body?: unknown, ok: (j: unknown) => boolean = () => true): Promise<Outcome> => {
    let r: Response;
    try {
      r = await fetchImpl(url, {
        method: body ? "POST" : "GET",
        headers: { Authorization: `Bearer ${key}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch { return "network"; }
    if (!r.ok) return outcome(r.status);
    try { return ok(await r.json()) ? "ok" : "failed"; } catch { return "failed"; }
  };
  const known = await call(MODELS_URL);
  if (known !== "ok") return { key: known, embeddings: "skipped", decisions: "skipped" };
  const [embeddings, decisions] = await Promise.all([
    call(EMBEDDINGS_URL, { model: EMBED_MODEL, input: ["hello"], dimensions: EMBED_DIMS },
      (j) => (j as { data?: Array<{ embedding?: unknown[] }> }).data?.[0]?.embedding?.length === EMBED_DIMS),
    call(DECISIONS_URL, { model: DECISIONS_MODEL, input: "hello", questions: [{ type: "predicate", name: "q", instructions: "Is this a greeting?" }] },
      (j) => Array.isArray((j as { answers?: unknown }).answers)),
  ]);
  return { key: "ok", embeddings, decisions };
}

/** a check as lines for a person: the key, then the two uses, then what follows for the role */
export function checkLines(c: KeyCheck): string[] {
  const o = B.openai;
  const word = (k: string): string => o.outcome[k] ?? k;
  const lines = [o.lineKey(word(c.key)), o.lineEmbeddings(word(c.embeddings)), o.lineDecisions(word(c.decisions))];
  if (!usable(c)) lines.push(o.notUsable);
  else if (c.decisions !== "ok") lines.push(o.wordsJudge);
  return lines;
}

/** questions at a terminal; hidden ones are not shown as they are typed (a key). One per terminal: two would both read it */
export interface Prompter { ask(text: string): Promise<string>; hidden(text: string): Promise<string>; pause(): void; resume(): void; close(): void }

export function prompter(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Prompter {
  let mute = false;
  const out = new Writable({ write(chunk, enc, done) { if (!mute) output.write(chunk, enc); done(); } });
  const rl = createInterface({ input, output: out, terminal: true });
  return {
    ask: async (text) => (await rl.question(text)).trim(),
    hidden: async (text) => {
      output.write(text);
      mute = true;
      try { return (await rl.question("")).trim(); } finally { mute = false; output.write("\n"); }
    },
    // lent to another program meanwhile (Claude Code's sign-in in this terminal)
    pause: () => rl.pause(),
    resume: () => rl.resume(),
    close: () => rl.close(),
  };
}

/** one run of 20 to 300 characters with no space: what any OpenAI key is (checked before anything is sent) */
export const looksLikeKey = (key: string): boolean => /^\S{20,300}$/.test(key);

/**
 * hh setup --terminal, after the Claude login: what the key is for, then the key (Enter skips), checked; asked again until
 * it is one HH can use, or skipped
 */
export async function askOpenAIKey(p: Prompter, say: (line: string) => void, check: (key: string) => Promise<KeyCheck> = (k) => checkOpenAIKey(k)): Promise<string | undefined> {
  say(B.openai.about);
  for (;;) {
    const key = await p.hidden(B.openai.ask);
    if (!key) return undefined;
    if (!looksLikeKey(key)) { say(B.openai.notAKey); continue; }
    say(B.openai.checking);
    const c = await check(key);
    for (const l of checkLines(c)) say(l);
    if (usable(c)) return key;
  }
}

/** the key from the person: typed, not shown (a terminal), or one line piped in; never an argument (it would sit in ps and the shell's history) */
async function readKey(): Promise<string> {
  if (process.stdin.isTTY) {
    const p = prompter();
    try { return await p.hidden(B.openai.ask); } finally { p.close(); }
  }
  const parts: Buffer[] = [];
  for await (const c of process.stdin) parts.push(c as Buffer);
  return Buffer.concat(parts).toString("utf8").split("\n")[0]!.trim();
}

/**
 * hh openai [status] | set | check | remove — the operator's: whether the role has a key and where, put one in (checked
 * first; kept only when HH can use it), check the one it has, take it away. hhd takes a change up by itself: it restarts
 * once the role is calm (src/hhd.ts), so nobody restarts it by hand
 */
export async function openaiCommand(
  cfg: Config, argv: readonly string[],
  o: { check?: (key: string) => Promise<KeyCheck>; readKey?: () => Promise<string>; say?: (line: string) => void } = {},
): Promise<string> {
  const check = o.check ?? ((k: string) => checkOpenAIKey(k));
  const say = o.say ?? ((l: string) => process.stdout.write(`${l}\n`));
  const what = argv[0] ?? "status";
  const has = loadOpenAIKey(cfg.stateDir);
  const lines: string[] = [];
  switch (what) {
    case "status":
      return has ? B.openai.statusSet(secretsFile(cfg.stateDir)) : B.openai.statusNone;
    case "check": {
      if (!has) return B.openai.statusNone;
      say(B.openai.checking);
      return checkLines(await check(has)).join("\n");
    }
    case "set": {
      const key = await (o.readKey ?? readKey)();
      if (!key) return B.openai.nothingTyped;
      if (!looksLikeKey(key)) throw new Error(B.openai.notAKey);
      say(B.openai.checking);
      const c = await check(key);
      lines.push(...checkLines(c));
      if (!usable(c)) throw new Error(lines.join("\n"));
      saveOpenAIKey(cfg.stateDir, key);
      lines.push(B.openai.saved(secretsFile(cfg.stateDir)), B.openai.takesEffect);
      return lines.join("\n");
    }
    case "remove": {
      if (!has) return B.openai.statusNone;
      saveOpenAIKey(cfg.stateDir, null);
      lines.push(B.openai.removed, B.openai.takesEffect);
      return lines.join("\n");
    }
    default:
      throw new Error(B.openai.usage);
  }
}
