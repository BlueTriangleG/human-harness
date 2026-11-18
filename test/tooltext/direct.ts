// 工具文字的钉子（Task 0）：两条没有工具入口的话——它们由 src/brain.ts 取用（what_do_i_know 找页失败、给的大类书架上没有），
// 所以清单里直接调到它们。文字已经搬进语言包（T.what_do_i_know），这里在调用时从当前的包里读（不在模块顶层存一份），调用和指纹不动。
import { T } from "../../src/lang/index.ts";

export const notesUnreadable = (): string => T.what_do_i_know.unreadable;
export const categoryMissing = (category: string, names: readonly string[]): string => T.what_do_i_know.categoryMissing(category, names);
