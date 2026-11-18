// Sense collection: part of the kernel, kept in a module's layout (required: every role has it). Every 20
// seconds the pulse builds the source table from the loaded modules — each source is defined in the config of the module
// that owns it (its `senses` key, for the ids it declares), so a module that is off has no sources running — and from
// the role's own table (config `table`, a file in the workspace it edits itself, read again each round: its sources no
// on module declares, and its settings over this module's) and runs
// scripts/senses.py, which looks at every source and hands new events to HH (hh sense). scripts/senses_watch.py stays up
// and triggers a source the moment its watcher sees something.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineModule, z } from "../../src/modules/api.ts";

/** A source run by this module's own scripts, under this module's environment */
const own = (script: string) => `"$HH_BIN" modules run senses ${script}`;
/** The collector's own settings, written into the table next to the sources */
const SETTINGS = ["min_wake_gap_sec", "retry_unacked_sec", "hh_json", "keep_phone_on", "watchers", "hooks"] as const;

type SourceDefs = Record<string, Record<string, unknown>>;

export default defineModule({
  name: "senses",
  summary: "sense collection: looks at every source the loaded modules define and hands new events to HH",
  required: true,
  config: {
    shape: {
      senses: z.record(z.string(), z.record(z.string(), z.unknown())),
      min_wake_gap_sec: z.number(), retry_unacked_sec: z.number(), hh_json: z.boolean(), keep_phone_on: z.boolean(),
      watchers: z.array(z.record(z.string(), z.unknown())), hooks: z.array(z.record(z.string(), z.unknown())),
      // "@<name>" that is not the role (HH's names.notMe); the role's Xiaohongshu name; its phone's AVD
      notMe: z.array(z.string()), xhsName: z.string(), phoneAvd: z.string(),
      // where the helpers keep their session files, for the budget's "running" line; unset: none counted
      helperSessionsDir: z.string(),
      // relative to the workspace: the role's own source table; where the rounds keep their state and events (unset:
      // this module's state dir); the queue the role's timers put reminders in (unset: reminders.jsonl in that dir)
      table: z.string(), dataDir: z.string(), remindersFile: z.string(),
    },
    defaults: {
      senses: {
        quota: { type: "command", cmd: own("quota_pulse.py"), every_sec: 300, fire_on_first: true },
        budget: { type: "command", cmd: own("budget.py pulse"), every_sec: 300, fire_on_first: true },
        remind: { type: "command", cmd: own("remind.py due"), fire_on_first: true },
      },
      min_wake_gap_sec: 3, retry_unacked_sec: 180, hh_json: true, keep_phone_on: false, watchers: [],
      hooks: [{ type: "wake_main", on: "*", debounce_sec: 15 }],
      notMe: [], xhsName: "", phoneAvd: "", helperSessionsDir: "", table: "", dataDir: "", remindersFile: "",
    },
  },
  senses: ["quota", "budget", "remind"],
  senseKinds: { probe: ["quota", "budget"], always: ["remind"] },
  timers: [{
    name: "pulse", everyMs: 20_000, run: {
      timeoutMs: 120_000,
      async run(m) {
        if (!m.peers) return "";
        const peers = m.peers();
        const declared = new Set(peers.flatMap((p) => p.senses));
        const own = (m.config.table ? JSON.parse(readFileSync(resolve(m.role.workspace, String(m.config.table)), "utf8")) : {}) as { sources?: Array<Record<string, unknown>> } & Record<string, unknown>;
        // a source whose definition gives no note gets the owning module's sentence senseNote.<id>, in the role's language
        const noteOf = (dir: string, id: string): string | undefined => {
          for (const f of [`texts.${m.role.lang}.json`, "texts.json"]) {
            try { const n = (JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, string>)[`senseNote.${id}`]; if (n) return n; } catch { /* no such file */ }
          }
          return undefined;
        };
        const sources = [
          ...peers.flatMap((p) => p.senses.flatMap((id) => {
            const def = (p.config.senses as SourceDefs | undefined)?.[id];
            const note = def && def.note === undefined ? noteOf(p.dir, id) : undefined;
            return def ? [{ ...def, ...(note ? { note } : {}), id }] : [];
          })),
          ...(own.sources ?? []).filter((s) => !declared.has(String(s.id))),
        ];
        mkdirSync(m.stateDir, { recursive: true });
        // written whole, then put in place: the watcher and the rounds it starts never read half of it
        const table = join(m.stateDir, "senses.json");
        writeFileSync(`${table}.tmp`, JSON.stringify({ ...Object.fromEntries(SETTINGS.map((k) => [k, k in own ? own[k] : m.config[k]])), sources }, null, 1));
        renameSync(`${table}.tmp`, table);
        const r = await m.run("scripts/senses.py", [], { timeoutMs: 110_000 });
        // what the round said (new events, a source's error) goes where the rounds the watcher starts write theirs
        if (r.stdout || r.stderr) appendFileSync(join(m.stateDir, "senses.log"), r.stdout + r.stderr);
        if (r.code !== 0 || r.timedOut) m.log("warn", "senses: the pulse failed", { code: r.code, stderr: r.stderr.slice(-300) });
        return "";
      },
    },
  }],
  processes: [{ name: "watch", script: "scripts/senses_watch.py" }],
  async check(m) {
    const state = join(m.config.dataDir ? resolve(m.role.workspace, String(m.config.dataDir)) : m.stateDir, "state.json");
    if (!existsSync(state)) return [{ status: "setup", text: "no round has run yet (hhd runs one every 20 seconds)" }];
    const age = Math.round((Date.now() - statSync(state).mtimeMs) / 60_000);
    return [age <= 5 ? { status: "ok", text: `last round ${age} min ago` } : { status: "broken", text: `last round ${age} min ago; the pulse should run every 20 seconds` }];
  },
});
