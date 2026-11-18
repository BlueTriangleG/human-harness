// 中文包：参照包，别的语言包要跟它一个形状。包里以后的文件也在这里加进来。
import * as prompts from "./prompts.ts";
import * as tools from "./tools.ts";
import * as memory from "./memory.ts";
import * as gate from "./gate.ts";
import * as learning from "./learning.ts";
import * as sleep from "./sleep.ts";
import * as repair from "./repair.ts";
import * as brain from "./brain.ts";
import { defaults } from "./defaults.ts";

export const zh = { code: "zh", locale: "zh-CN", prompts, tools, memory, gate, learning, sleep, repair, brain, defaults };
