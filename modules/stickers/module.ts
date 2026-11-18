// Stickers: the role's own sticker library — collecting, describing and picking by mood (scripts/sticker.py, the first
// role's script moved as it was, minus the OpenClaw-only sending). HH's sticker tool sends what the script picks.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineModule, T, z } from "../../src/modules/api.ts";

const WEEK_MS = 7 * 24 * 3600_000;

export default defineModule({
  name: "stickers",
  summary: "the role's sticker library: collect, describe, pick one by mood (HH's sticker tool sends it)",
  config: {
    // the library, relative to the workspace: index.json, img/, inbox/, trash/; weeklyHunt: the weekly reminder below (off for a role that keeps its own)
    shape: { library: z.string(), weeklyHunt: z.boolean() },
    defaults: { library: "stickers", weeklyHunt: true },
  },
  // a GIF goes to WhatsApp as an MP4
  requires: { bins: ["ffmpeg"] },
  // Once a week the role is reminded to look for new stickers. Checked hourly against the last time, kept in the module's
  // state, since hhd restarts far more often than weekly; the first week counts from when the module is first on.
  timers: [{
    name: "hunt", everyMs: 3600_000, run: {
      timeoutMs: 5_000,
      async run(m) {
        if (!m.remind || m.config.weeklyHunt === false) return "";
        const file = join(m.stateDir, "hunt.json");
        const last = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { at: number }).at : 0;
        if (last && Date.now() - last < WEEK_MS) return "";
        if (last) m.remind(T.sticker.weeklyHunt);
        mkdirSync(m.stateDir, { recursive: true });
        writeFileSync(file, JSON.stringify({ at: Date.now() }));
        return "";
      },
    },
  }],
  async check(m) {
    // reads the index, writes nothing but the library's folders when they are missing
    const r = await m.run("scripts/sticker.py", ["stats"], { timeoutMs: 20_000 });
    if (r.code !== 0 || r.timedOut) return [{ status: "broken", text: (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("\n") }];
    const s = JSON.parse(r.stdout) as { total: number; inbox: number };
    return [{ status: s.total ? "ok" : "setup", text: `${s.total} stickers, ${s.inbox} waiting in the inbox` }];
  },
});
