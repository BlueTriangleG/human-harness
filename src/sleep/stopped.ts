import { S } from "../lang/index.ts";
// 新的睡眠（分段的引擎：flow、team，和 hh sleep replay）2026-11-13 停了，代码留着不用。两道门关着，别不小心开起来：
// - 夜里：配置 sleep.newEngine 不是 true，一律旧的整理（海马）——工作区里有没有 flow.json 都一样，flow.json 也不读（brain.ts 的 nightEngineWhy）；
// - 回放：不带 --i-know-it-spends-quota 不开——hh 命令行先停下（cli-parse.ts，退出码 1，不连 hhd），hhd 这边也核（brain.ts 的 sleepReplay：别的客户端也绕不过）。
// 只放这几句话：hh 命令行（control.ts、cli-parse.ts）也 import 它，别往这里 import 引擎。

/** 今晚不走引擎的原因（日志的 why、hh sleep plan 都说这一句） */

/** hh sleep replay 要明说的那个参数 */
export const REPLAY_CONFIRM = "--i-know-it-spends-quota";

/** 没明说就回这一句，什么都不开 */
