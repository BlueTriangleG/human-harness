// 测试里碰不到线上（CEO 11-13）：跑测试的进程要连 hhd 的控制口、开数据库、读网关凭据，落在线上目录底下就抛错
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, writeFileSync } from "node:fs";
import { underTest, liveRoots, refuseLive } from "../src/testGuard.ts";
import { request } from "../src/control.ts";
import { openDb } from "../src/store/db.ts";
import { readGatewayAuth } from "../src/gateway/client.ts";
import { tmpDir } from "./tmp.ts";
import { setLang } from "../src/lang/index.ts";

// this file asserts the Chinese pack's text
setLang("zh");

test("node --test 里算在测试里；HH_TEST=1 也算；都没有不算", () => {
  assert.ok(underTest(), "node --test 给测试进程带着 NODE_TEST_CONTEXT");
  assert.ok(underTest({ HH_TEST: "1" }));
  assert.ok(!underTest({}));
});

test("线上的目录：家目录下的 ~/.hh、~/.openclaw；HH_CONFIG 指的是那底下的实例配置时，它写的 stateDir、工作区的上一层也算；测试自己的临时配置不算", () => {
  const r = liveRoots({});
  assert.ok(r.includes(join(homedir(), ".hh")), r.join(" "));
  assert.ok(r.includes(join(homedir(), ".openclaw")), r.join(" "));
  const sandbox = tmpDir("hh-guard-cfg-");
  writeFileSync(join(sandbox, "config.json"), JSON.stringify({ stateDir: join(sandbox, "state"), workspace: join(sandbox, "ws") }));
  assert.ok(!liveRoots({ HH_CONFIG: join(sandbox, "config.json") }).includes(join(sandbox, "state")), "临时配置不当成线上");
});

// 下面两条探的都是一个临时目录（HH_TEST_EXTRA_LIVE 把它也算作线上），不拿真的线上路径去探：闸坏了，碰到的也只是这个假的
const FAKE_LIVE = tmpDir("hh-fake-live-");
process.env.HH_TEST_EXTRA_LIVE = FAKE_LIVE;
writeFileSync(join(FAKE_LIVE, "openclaw.json"), JSON.stringify({ gateway: { port: 1, auth: { token: "假的" } } }));

test("测试里碰线上的 socket、库、凭据都抛错；临时目录照常；不在测试里不管", () => {
  assert.throws(() => refuseLive("hhd 控制口", join(FAKE_LIVE, "hh.sock")), /测试里不许碰线上的hhd 控制口/);
  assert.throws(() => refuseLive("数据库", join(FAKE_LIVE, "sub", "..", "hh.db")), /数据库/, "绕一圈的路径也认");
  assert.throws(() => refuseLive("数据库", join(liveRoots()[0]!, "hh.db")), /数据库/, "真的线上目录只拿来比路径，不去开");
  refuseLive("数据库", join(tmpDir("hh-guard-"), "hh.db"));
  refuseLive("hhd 控制口", join(FAKE_LIVE, "hh.sock"), {});   // hhd、hh 命令平常跑：不管
});

test("接线：request 连 hh.sock、openDb 开库、readGatewayAuth 读 openclaw.json，落在线上目录底下都当场抛错，不去连、不去开", () => {
  assert.throws(() => request(join(FAKE_LIVE, "hh.sock"), { cmd: "status" }), /hhd 控制口/);
  assert.throws(() => openDb(join(FAKE_LIVE, "hh.db")), /数据库/);
  assert.ok(!existsSync(join(FAKE_LIVE, "hh.db")), "库没被建出来");
  assert.throws(() => readGatewayAuth(join(FAKE_LIVE, "openclaw.json")), /网关凭据/);
  const db = openDb(join(tmpDir("hh-guard-db-"), "hh.db"));   // 临时的照开
  db.close();
  assert.doesNotThrow(() => openDb(":memory:").close());
});
