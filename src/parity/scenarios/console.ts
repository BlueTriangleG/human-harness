// console scenario: the owner speaks from the console, then with hh tell (each tell as tellOf in src/control.ts makes it,
// with the name the console speaks as), and the role answers each with one line. What is kept: the words main is woken
// with, and where its answer goes (printed back on this machine, sent through a channel, or kept by no one).
import { ownerNameOf } from "../../cli-parse.ts";
import { tellOf } from "../../control.ts";
import { answerUntilQuiet, feed, type Answered } from "../drive.ts";
import type { Scenario } from "../scenario.ts";

export const consoleTell: Scenario = {
  name: "console",
  async run(w) {
    const from = ownerNameOf(w.brain.currentPeople().registry) ?? w.cfg.names.owner;
    const answered: Answered = new WeakMap();
    w.start();
    await w.drain();
    for (const [via, here] of [["console", true], ["hh tell", false]] as const) {
      feed(w, { name: "inbound", args: tellOf({ cmd: "tell", from, text: `（对照：从 ${via} 说的一句）`, ...(here ? { here } : {}) }) });
      await w.drain();
      await answerUntilQuiet(w, answered, { say: `（对照：回 ${via} 那句）` });
    }
    w.recordState();
  },
};
