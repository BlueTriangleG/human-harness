// prompts 夹具的覆盖检查用的：在本进程里把 src/lang/zh/prompts.ts 每组写死的夹具都渲染一遍。test/parity-prompts.test.ts 用
// node --test --experimental-test-coverage 跑它，要 src/lang/zh/prompts.ts 的行、分支、函数都是 100%（夹具走到了每一个分支）。
// 不叫 *.test.ts：全套测试的 glob 不单独跑它。从世界里算的那几组（名单上的人）不在这里：写死的那些已经走到了每个分支。
import { test } from "node:test";
import * as promptsModule from "../../src/lang/zh/prompts.ts";
import { promptEntries } from "../../src/parity/scenarios/prompts.ts";
import { PROMPT_FIXTURES } from "../../src/parity/scenarios/prompts.fixtures.ts";

test("render every literal fixture of src/lang/zh/prompts.ts in-process", () => {
  const { entries, missing } = promptEntries(promptsModule, PROMPT_FIXTURES);
  if (missing.length) throw new Error(`exports without a fixture: ${missing.join(", ")}`);
  for (const e of entries) {
    for (const args of e.calls ?? []) {
      if (typeof args !== "function") (e.value as (...a: readonly unknown[]) => unknown)(...args);
    }
  }
});
