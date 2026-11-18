// relay/test.mjs（hh-relay 插件的纯逻辑测试）也跟着全量测试跑：relay 装在 OpenClaw 网关里，这里只测不依赖 OpenClaw 的那部分
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

test("hh-relay 纯逻辑（relay/test.mjs）：认领、附件、超时不交回 OpenClaw、等待时间配置", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out = execFileSync(process.execPath, [join(root, "relay", "test.mjs")], { encoding: "utf8", timeout: 60_000 });
  assert.match(out, /relay logic ok/);
  assert.match(out, /relay hand-back ok/);
  assert.match(out, /relay spool ok/);
});
