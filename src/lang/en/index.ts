// The English pack, filled entry by entry: each part is the entries translated so far (the file of the same name next
// to this one) laid over the reference pack's part, so the pack is complete at every moment. tsc checks each file here
// against the reference part where it is laid over it below; `hh lang status en` shows what is still missing.
import type { LangPack } from "../index.ts";
import { overlay } from "../overlay.ts";
import { zh } from "../zh/index.ts";
import * as prompts from "./prompts.ts";
import * as tools from "./tools.ts";
import * as memory from "./memory.ts";
import * as gate from "./gate.ts";
import * as learning from "./learning.ts";
import * as sleep from "./sleep.ts";
import * as repair from "./repair.ts";
import * as brain from "./brain.ts";
import { defaults } from "./defaults.ts";

export const en: LangPack = {
  code: "en",
  locale: "en-US",
  prompts: overlay(zh.prompts, prompts),
  tools: overlay(zh.tools, tools),
  memory: overlay(zh.memory, memory),
  gate: overlay(zh.gate, gate),
  learning: overlay(zh.learning, learning),
  sleep: overlay(zh.sleep, sleep),
  repair: overlay(zh.repair, repair),
  brain: overlay(zh.brain, brain),
  defaults,
  own: { prompts, tools, memory, gate, learning, sleep, repair, brain },
};
