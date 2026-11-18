// 控制台的界面文字，中文。这一份同时是类型：别的语言照着它的键写，少一条 tsc 就报。
// 一页一个文件，在 zh/ 下面；这里只是拼起来。写法见 index.ts 顶上的说明。
import { common } from "./zh/common.ts";
import { api } from "./zh/api.ts";
import { shell } from "./zh/shell.ts";
import { regions } from "./zh/regions.ts";
import { brain } from "./zh/brain.ts";
import { timeline } from "./zh/timeline.ts";
import { side } from "./zh/side.ts";
import { gate } from "./zh/gate.ts";
import { memory } from "./zh/memory.ts";
import { prompt } from "./zh/prompt.ts";
import { events } from "./zh/events.ts";
import { health } from "./zh/health.ts";
import { notebook } from "./zh/notebook.ts";
import { chat } from "./zh/chat.ts";
import { now } from "./zh/now.ts";
import { settings } from "./zh/settings.ts";
import { machine } from "./zh/machine.ts";
import { wizard } from "./zh/wizard.ts";
import { openai } from "./zh/openai.ts";

export const zh = { common, api, shell, regions, brain, timeline, side, gate, memory, prompt, events, health, notebook, chat, now, settings, machine, wizard, openai } as const;

/** 同样的键，值是字 */
export type Strings<T> = { readonly [K in keyof T]: T[K] extends string ? string : Strings<T[K]> };
export type ConsolePack = Strings<typeof zh>;
