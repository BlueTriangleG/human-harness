// relay-spool（CEO 11-12，b）：hhd 不在时 relay 存下的消息，hhd 起来按先后补交、交完就删；同一条消息只收一次
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { drainSpool } from "../src/relaySpool.ts";
import { makeBrain } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";

const msg = (id: string, text: string) => ({ channel: "whatsapp", senderId: "+6155500011", text, messageId: id });
const put = (dir: string, name: string, body: unknown) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body), { mode: 0o600 });

test("relay-spool：按存的先后补交，交完就删；读不了的改名 .failed 留着、不重试；日志里没有原文", () => {
  const dir = join(tmpDir("hh-spool-"), "relay-spool");
  mkdirSync(dir, { recursive: true });
  put(dir, "1740002000-1-b.json", { v: 1, at: 2, message: msg("m2", "第二条") });
  put(dir, "1740001000-1-a.json", { v: 1, at: 1, message: msg("m1", "第一条") });
  put(dir, "1740003000-1-c.json", "不是 JSON 的秘密内容");
  put(dir, ".000000000000004-1-d.json.tmp", { v: 1, at: 4, message: msg("m4", "还没写完") });
  const got: string[] = [];
  const logs: Array<[string, unknown]> = [];
  const log = { info: (m: string, d?: unknown) => logs.push([m, d]), warn: (m: string, d?: unknown) => logs.push([m, d]) };
  assert.deepEqual(drainSpool({ dir, deliver: (m) => got.push(m.text), log }), { delivered: 2, failed: 1 });
  assert.deepEqual(got, ["第一条", "第二条"], "按存的先后");
  assert.deepEqual(readdirSync(dir).sort(), [".000000000000004-1-d.json.tmp", "1740003000-1-c.json.failed"], "交完的删了；坏的留成 .failed；没写完的临时文件不碰");
  assert.doesNotMatch(JSON.stringify(logs), /秘密内容|第一条|第二条/, "日志里没有原文");
  assert.deepEqual(drainSpool({ dir, deliver: () => { throw new Error("不该再交"); }, log }), { delivered: 0, failed: 0 }, ".failed 不再重试");
  assert.deepEqual(drainSpool({ dir: join(dir, "没有这个目录"), deliver: () => {}, log }), { delivered: 0, failed: 0 });
});

test("relay-spool：交进 HH 的消息按编号只收一次（补交前已经收过、渠道重投），重启后也记得；补交的按先后进她的记忆", async () => {
  const t = makeBrain();
  const inputs = (): string[] => t.brain.central.since(0).filter((e) => e.kind === "input").map((e) => e.text);
  t.brain.fromChannel(msg("m1", "在吗"));
  t.brain.fromChannel(msg("m1", "在吗"));
  assert.deepEqual(inputs().filter((x) => x === "在吗").length, 1, "同一条只收一次");
  t.brain.fromChannel({ channel: "whatsapp", senderId: "+6155500011", text: "没编号的照收" });
  t.brain.fromChannel({ channel: "whatsapp", senderId: "+6155500011", text: "没编号的照收" });
  assert.equal(inputs().filter((x) => x === "没编号的照收").length, 2);

  // 没收下（抛错）的不记成收过：relay 存进 spool、补交时还要能交进来
  const real = t.brain.inbound.bind(t.brain);
  (t.brain as unknown as { inbound: () => never }).inbound = () => { throw new Error("坏了"); };
  assert.throws(() => t.brain.fromChannel(msg("m9", "这条没收下")));
  (t.brain as unknown as { inbound: typeof real }).inbound = real;
  t.brain.fromChannel(msg("m9", "这条没收下"));
  assert.equal(inputs().filter((x) => x === "这条没收下").length, 1, "抛错那次不算收过，再交一次照收");

  const t2 = makeBrain({}, undefined, { db: t.db });                       // 重启
  const dir = join(tmpDir("hh-spool-"), "relay-spool");
  mkdirSync(dir, { recursive: true });
  const at = t2.clock.now();
  put(dir, "1740001000-1-a.json", { v: 1, at, message: msg("m1", "在吗") });      // 重启前已经收过
  put(dir, "1740002000-1-b.json", { v: 1, at, message: msg("m2", "人呢") });
  put(dir, "1740003000-1-c.json", { v: 1, at, message: msg("m3", "回我一下") });
  const log = { info: () => {}, warn: () => {} };
  assert.deepEqual(drainSpool({ dir, deliver: (m) => t2.brain.fromChannel(m), log }), { delivered: 3, failed: 0 });
  const after = t2.brain.central.since(0).filter((e) => e.kind === "input").map((e) => e.text);
  assert.equal(after.filter((x) => x === "在吗").length, 1, "重启前收过的不再收");
  assert.ok(after.indexOf("人呢") < after.indexOf("回我一下"), "按存的先后");
  assert.ok(t2.logs.some((l) => l.msg === "relay: message already taken, skipped"));
});

test("relay-spool 往返：relay 的 spool() 写、hhd 的 drainSpool 读；目录名两边一样；存了一会儿的说清几分钟前发的；同一编号内容不同照收；relay 交新消息前先补交存着的", async () => {
  const { pathToFileURL } = await import("node:url");
  const { basename } = await import("node:path");
  const { spoolDirOf } = await import("../src/relaySpool.ts");
  const relay = (await import(pathToFileURL(join(import.meta.dirname, "..", "relay", "logic.mjs")).href)) as { spool: (m: unknown, dir: string, now: number) => string; SPOOL_DIR: string };
  assert.equal(basename(relay.SPOOL_DIR), basename(spoolDirOf("/x")), "两边的目录名一样");

  const t = makeBrain();
  const H = 3600_000;
  const now = t.clock.now();
  const state = tmpDir("hh-spool-");
  const dir = spoolDirOf(state);
  relay.spool(msg("r1", "在吗"), dir, now - 2 * H);         // hhd 停了两个小时
  relay.spool(msg("r2", "人呢"), dir, now - 30_000);        // 半分钟前：不用说
  const log = { info: () => {}, warn: () => {} };
  assert.deepEqual(drainSpool({ dir, deliver: (m) => t.brain.fromChannel(m), log }), { delivered: 2, failed: 0 });
  const inputs = t.brain.central.since(0).filter((e) => e.kind === "input").map((e) => e.text);
  assert.ok(inputs.some((x) => /^（这条是 120 分钟前发来的，你那时不在，存下来现在才交给你）在吗$/.test(x)), inputs.join(" | "));
  assert.ok(inputs.includes("人呢"), "刚存的不加说明");

  t.brain.fromChannel(msg("r2", "人呢？（改过）"));            // 同一编号、内容不同（编辑过的消息）：照收、记一笔
  assert.equal(t.brain.central.since(0).filter((e) => e.kind === "input" && e.text === "人呢？（改过）").length, 1);
  assert.ok(t.logs.some((l) => l.msg === "relay: same message id with different text, taken again"));

  // relay 交来新消息前，先把存着的交了（不乱序）：走控制面的 relay 命令
  const { serve, request } = await import("../src/control.ts");
  const t2 = makeBrain({ stateDir: state });
  relay.spool(msg("s1", "第一句（存着的）"), spoolDirOf(state), t2.clock.now());
  const sock = join(tmpDir("hh-ctl-"), "hh.sock");
  const server = serve(t2.brain, sock, () => {});
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    await request(sock, { cmd: "relay", message: msg("s2", "第二句（直达的）") } as never);
  } finally {
    server.close();
  }
  const order = t2.brain.central.since(0).filter((e) => e.kind === "input").map((e) => e.text);
  assert.ok(order.indexOf("第一句（存着的）") >= 0 && order.indexOf("第一句（存着的）") < order.indexOf("第二句（直达的）"), order.join(" | "));
});
