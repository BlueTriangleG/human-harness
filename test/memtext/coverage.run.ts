// 记忆文字覆盖检查用的：在本进程里把 test/memtext/calls.ts 的整张清单渲染一遍。test/memory-text.test.ts 用
// node --test --experimental-test-coverage 跑它，再从 lcov 里查 COMPLETE 里每个文件有文字的行都跑到了、行上的每个分支都走到了、起在这些行上的函数都被调用过（test/textpins/lib.ts 的 reach）。
// 不叫 *.test.ts：全套测试的 glob 不单独跑它。
import { test } from "node:test";
import { renderAll } from "./calls.ts";

test("render every pinned call of the memory text in-process", async () => {
  await renderAll();
});
