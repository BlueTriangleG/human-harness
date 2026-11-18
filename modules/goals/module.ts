// Goals: the role's dream, long, short and today goals, set, tracked and closed by the role itself (scripts/goals.py).
// The data stays in the role's workspace (config dataFile). The wake-up brief carries the goals summary; the sense
// source "goals" is the script's pulse (run by the senses collector).
import { defineModule, summarize, T, z } from "../../src/modules/api.ts";

const GOALS = "scripts/goals.py";
/** Setting, moving or blocking a goal brings up the notes on its title and why */
const TOPIC_COMMANDS = new Set(["add", "log", "block"]);
/** The brief is asked at every wake-up and by the gate's small judge: one run a minute at most */
const BRIEF_MS = 60_000;
const briefs = new WeakMap<object, { text: string; at: number }>();   // per module context: each loaded set its own

export default defineModule({
  name: "goals",
  summary: "The role's own goals at four levels: set, tracked, closed by the role",
  config: {
    // dayStartsAt: the hour the role's day changes (a goal for today set before it belongs to the day before);
    // remindFrom, remindUntil: the hours the pulse may wake the role (an hour before dayStartsAt counts as the next day's);
    // senses: the source the senses collector runs for this module
    shape: {
      dataFile: z.string(), helperSessionsDir: z.string(), dayStartsAt: z.number(), remindFrom: z.number(), remindUntil: z.number(),
      senses: z.record(z.string(), z.record(z.string(), z.unknown())),
    },
    defaults: {
      dataFile: "memory/goals/goals.json", helperSessionsDir: "", dayStartsAt: 4, remindFrom: 8, remindUntil: 1,
      senses: { goals: { type: "command", cmd: "goals pulse", every_sec: 60, fire_on_first: true } },
    },
  },
  tools: [{
    name: "goals", description: () => T.goals.description, shape: () => ({ args: z.array(z.string()) }),
    async handler(a, m) {
      const args = a.args as string[];
      const r = await m.run(GOALS, args);
      const out = summarize(r);
      if (r.code !== 0 || !m.notes || !TOPIC_COMMANDS.has(args[0] ?? "")) return out;
      const t = await m.run(GOALS, ["topic", ...args], { timeoutMs: 10_000 });
      let g: { title: string; why?: string } | null = null;
      try { g = t.code === 0 ? JSON.parse(t.stdout) : null; } catch { g = null; }
      const notes = g ? await m.notes(g.why ? T.goals.topicWithWhy(g.title, g.why) : g.title, "goals") : "";
      return notes ? `${out}\n${notes}` : out;
    },
  }],
  senses: ["goals"],
  senseKinds: { always: ["goals"] },
  hooks: {
    situation: {
      timeoutMs: 4000,
      async run(m) {
        const last = briefs.get(m);
        if (last && Date.now() - last.at < BRIEF_MS) return last.text;
        const r = await m.run(GOALS, ["brief", "main"], { timeoutMs: 4000 });
        const text = r.code === 0 && !r.timedOut ? r.stdout.trim() : "";
        briefs.set(m, { text, at: Date.now() });
        return text;
      },
    },
  },
});
