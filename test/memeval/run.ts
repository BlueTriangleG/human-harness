// Offline long-term memory evaluation: a made-up month (world.ts) goes into an empty event store, and each question in
// questions.json is put to HH's own recall the way the role's tools put it — no model, no network, no role's data.
//   hh-fw node test/memeval/run.ts [--embedder none|chars|both] [--json]
// What is measured is the retrieval stage (does the memory the answer needs come back, in the text the role would read),
// split by the question types of the public benchmarks (LongMemEval, LoCoMo): recall from one day, across days, by time,
// after an update, and abstention. A reader stage (a model answering from that text) is not part of it.
// Types and how each question counts as right:
//   recall    the expected event is among the events recalled, and every answer word is in the recalled text
//   unspaced  the same, for a question written as one run of Chinese with no space or punctuation in it
//   multi     every expected event is recalled, and every answer word is in the text
//   temporal  the time phrase is understood, and the period lists every expected event
//   update    the newest value is in the recalled text (stale: only the old one is)
//   abstain   nothing is recalled for something that never happened
import "./lang.ts";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../../src/store/db.ts";
import { EventStore } from "../../src/memory/events/store.ts";
import { MemIndex } from "../../src/memory/events/index.ts";
import type { Embedder } from "../../src/memory/events/embed.ts";
import { EventRecall, parseRange } from "../../src/memory/events/recall.ts";
import { NOW, buildWorld } from "./world.ts";

interface Question { id: string; type: "recall" | "unspaced" | "multi" | "temporal" | "update" | "abstain"; q: string; expect: string[]; answer?: string[]; stale?: string[] }
interface Result { id: string; type: Question["type"]; ok: boolean; rank?: number; found?: number; of?: number; stale?: boolean; extra?: number; note?: string }

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = "UTC";
const args = process.argv.slice(2);
const opt = (k: string): string | undefined => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

/** Each character counts in one of 512 dimensions: close wording gives close vectors (the same stand-in the tests use). */
const chars: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Float32Array(512);
      for (const ch of t) v[ch.codePointAt(0)! % 512]! += 1;
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};

async function run(embedder: Embedder | null, questions: Question[]): Promise<Result[]> {
  const db = openDb(":memory:");
  const store = new EventStore(db, () => NOW);
  const ids = buildWorld(store);
  const index = new MemIndex(db, embedder, () => NOW);
  if (embedder) await index.backfillVectors(10_000);
  const recall = new EventRecall({ store, index, now: () => NOW, tz: TZ });
  const out: Result[] = [];
  for (const q of questions) {
    const want = q.expect.map((k) => ids[k] ?? k);
    if (q.type === "temporal") {
      const range = parseRange(q.q, NOW, TZ);
      if (!range) { out.push({ id: q.id, type: q.type, ok: false, found: 0, of: want.length, note: "time phrase not understood" }); continue; }
      const text = recall.period(range, { pageChars: 100_000 });
      const listed = new Set(text.match(/\be\d{4,}\b/g) ?? []);
      const found = want.filter((w) => listed.has(w)).length;
      out.push({ id: q.id, type: q.type, ok: found === want.length, found, of: want.length, extra: [...listed].filter((x) => !want.includes(x)).length });
      continue;
    }
    const { text, events } = await recall.clusterRaw(q.q, { touch: false });
    if (q.type === "abstain") { out.push({ id: q.id, type: q.type, ok: events.length === 0, found: events.length }); continue; }
    const found = want.filter((w) => events.includes(w)).length;
    const words = (q.answer ?? []).every((w) => text.includes(w));
    const rank = Math.min(...want.map((w) => events.indexOf(w)).filter((i) => i >= 0)) + 1;
    if (q.type === "update") {
      const old = (q.stale ?? []).some((w) => text.includes(w));
      out.push({ id: q.id, type: q.type, ok: words, stale: !words && old, found, of: want.length });
      continue;
    }
    out.push({ id: q.id, type: q.type, ok: found === want.length && words, rank: Number.isFinite(rank) ? rank : undefined, found, of: want.length });
  }
  return out;
}

function report(name: string, rs: Result[]): Record<string, unknown> {
  const types = ["recall", "unspaced", "multi", "temporal", "update", "abstain"] as const;
  const by = {} as Record<(typeof types)[number], { n: number; right: number }>;
  for (const t of types) { const r = rs.filter((x) => x.type === t); by[t] = { n: r.length, right: r.filter((x) => x.ok).length }; }
  const ranked = rs.filter((x) => x.type === "recall" || x.type === "unspaced" || x.type === "multi");
  const mrr = ranked.reduce((a, x) => a + (x.rank ? 1 / x.rank : 0), 0) / (ranked.length || 1);
  const right = rs.filter((x) => x.ok).length;
  console.log(`\n${name}: ${right}/${rs.length} right`);
  for (const t of types) console.log(`  ${t.padEnd(9)} ${by[t].right}/${by[t].n}`);
  console.log(`  MRR of the first expected event (recall, unspaced, multi): ${mrr.toFixed(3)}`);
  console.log(`  stale answers (update, only the old value came back): ${rs.filter((x) => x.stale).length}`);
  const wrong = rs.filter((x) => !x.ok).map((x) => `${x.id}${x.note ? `(${x.note})` : x.of !== undefined ? `(${x.found}/${x.of}${x.extra ? ` +${x.extra}` : ""})` : x.found ? `(${x.found} recalled)` : ""}`);
  console.log(`  wrong: ${wrong.join(" ") || "none"}`);
  return { name, right, of: rs.length, by, mrr: Number(mrr.toFixed(3)), results: rs };
}

const questions = JSON.parse(readFileSync(opt("--questions") ?? join(HERE, "questions.json"), "utf8")) as Question[];
const which = opt("--embedder") ?? "both";
const modes: Array<[string, Embedder | null]> = [];
if (which === "none" || which === "both") modes.push(["full text only (no vectors)", null]);
if (which === "chars" || which === "both") modes.push(["full text + character vectors", chars]);
const all = [];
for (const [name, e] of modes) all.push(report(name, await run(e, questions)));
if (args.includes("--json")) console.log(JSON.stringify(all, null, 1));
