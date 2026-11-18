// 控制台的界面文字，英文。键照 zh.ts；少一条、多一条 tsc 都报。
// 英文里不用 she / her：说到角色时写 {me}（每条都能用的参数，还有 {owner}）。
import type { ConsolePack } from "./zh.ts";
import { common } from "./en/common.ts";
import { api } from "./en/api.ts";
import { shell } from "./en/shell.ts";
import { regions } from "./en/regions.ts";
import { brain } from "./en/brain.ts";
import { timeline } from "./en/timeline.ts";
import { side } from "./en/side.ts";
import { gate } from "./en/gate.ts";
import { memory } from "./en/memory.ts";
import { prompt } from "./en/prompt.ts";
import { events } from "./en/events.ts";
import { health } from "./en/health.ts";
import { notebook } from "./en/notebook.ts";
import { chat } from "./en/chat.ts";
import { now } from "./en/now.ts";
import { settings } from "./en/settings.ts";
import { machine } from "./en/machine.ts";
import { wizard } from "./en/wizard.ts";
import { openai } from "./en/openai.ts";

export const en: ConsolePack = { common, api, shell, regions, brain, timeline, side, gate, memory, prompt, events, health, notebook, chat, now, settings, machine, wizard, openai };
