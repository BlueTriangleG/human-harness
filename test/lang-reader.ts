// lang.test.ts 用的小模块：跟 src 里的代码一样 import { P }、调用时才读，看活绑定换了包以后在别的模块里也跟着变。
import { M, P, T } from "../src/lang/index.ts";

/** 调用时读当前包的 FOCUS_REGULAR */
export const focusRegularNow = (): string => P.FOCUS_REGULAR;

/** 调用时读当前包的 jot_down 回话（T 的活绑定在别的模块里也跟着换） */
export const jotDownNotedNow = (): string => T.jot_down.noted;

/** 调用时读当前包的 recallCentral.unsent（M 的活绑定在别的模块里也跟着换） */
export const recallUnsentNow = (): string => M.recallCentral.unsent;
