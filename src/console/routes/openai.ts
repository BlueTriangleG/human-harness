// Settings → memory and learning: the role's OpenAI key (src/openai.ts). The read says whether there is a key — never the
// key, nor any part of it — whether hhd runs by meaning or by words and whether a changed key waits for its calm restart
// (src/hhd.ts takes a change up by itself), what the notebook's judge spent today against its daily cap, and how far
// memory's vectors are made. The writes (check a key, keep one, take it away) go through the console's write checks and
// the owner's token, as a tell does (server.ts write): a key is kept only when HH can use it, in <stateDir>/secrets.json, 0600.
import { kvGet } from "../../store/db.ts";
import { request } from "../../control.ts";
import { localDay } from "../../learning/score.ts";
import { checkOpenAIKey, looksLikeKey, saveOpenAIKey, usable, type KeyCheck } from "../../openai.ts";
import { loadOpenAIKey } from "../../memory/events/embed.ts";
import { USD_PER_TOKEN } from "../../learning/decisions.ts";
import { fail, ok } from "./types.ts";
import type { Reply, Routes, Site } from "./types.ts";
import type { Translate } from "../lang/index.ts";

export interface OpenAIOptions {
  /** the role's state directory: secrets.json is here */
  stateDir: string;
  /** her time zone (the judge's spend is kept by her day) and the judge's daily cap (config learning.dailyUsd) */
  tz: string;
  dailyUsd: number;
  /** checks a key (tests give a stand-in); OpenAI's own by default */
  check?: (key: string) => Promise<KeyCheck>;
}

/** the writes, by path (POST, behind the console's write checks and the owner's token) */
export const OPENAI_WRITES: readonly string[] = ["/api/openai/check", "/api/openai/key", "/api/openai/remove"];

export function openaiRoutes(site: Site): Routes {
  const o = site.o.openai;
  if (!o) return {};
  return {
    "/api/openai": async () => {
      const set = loadOpenAIKey(o.stateDir) !== null;
      // what hhd runs with: only it knows (it read the key as it started); not answering, nothing said of it
      let hhd: { keyed: boolean; pending: boolean } | null = null;
      try {
        const s = (await request(site.o.sockPath, { cmd: "status" }, 3_000)) as { openai?: { keyed?: unknown; pending?: unknown } };
        if (s.openai) hhd = { keyed: s.openai.keyed === true, pending: s.openai.pending === true };
      } catch { /* hhd not running: it takes the key up as it starts */ }
      const day = localDay(site.now(), o.tz);
      const { tokens, vectors } = site.withDb((d) => {
        const n = (sql: string): number | null => { try { return (d.prepare(sql).get() as { n: number }).n; } catch { return null; } };
        return {
          tokens: Number(kvGet(d, `learn.spend.${day}`)) || 0,
          // memory's texts with and without a vector yet (no event memory: null)
          vectors: { have: n("SELECT count(*) n FROM mem_vec"), missing: n("SELECT count(*) n FROM mem_fts WHERE ref NOT IN (SELECT ref FROM mem_vec)") },
        };
      });
      return ok({
        set,
        running: hhd !== null,
        mode: hhd ? (hhd.keyed ? "meaning" : "words") : null,
        pending: hhd?.pending ?? false,
        spend: { day, usd: Math.round(tokens * USD_PER_TOKEN * 1e4) / 1e4, limit: o.dailyUsd },
        vectors,
      });
    },
  };
}

/** A write, once the console's checks and the owner's token have passed: check a key (the one given, else the kept one), keep one, take it away */
export async function openaiWrite(o: OpenAIOptions, path: string, body: Record<string, unknown>, tx: Translate): Promise<Reply> {
  const check = o.check ?? ((k: string) => checkOpenAIKey(k));
  const given = typeof body.key === "string" ? body.key.trim() : "";
  if (path === "/api/openai/remove") {
    saveOpenAIKey(o.stateDir, null);
    return ok({ removed: true });
  }
  if (path === "/api/openai/check" && !given) {
    const kept = loadOpenAIKey(o.stateDir);
    if (!kept) return fail(404, tx("api.openaiNoKey"));
    const c = await check(kept);
    return ok({ ...c, usable: usable(c) });
  }
  // what was sent is never said back, right or wrong
  if (!looksLikeKey(given)) return fail(400, tx("api.openaiNotAKey"));
  const c = await check(given);
  if (path === "/api/openai/check") return ok({ ...c, usable: usable(c) });
  if (!usable(c)) return { code: 400, body: { saved: false, ...c, usable: false } };
  saveOpenAIKey(o.stateDir, given);
  return ok({ saved: true, ...c, usable: true });
}
