// 通道表（src/gate/sources.ts）：读配置、固定来源、控制台遮不遮。来源名是编的，不用任何一个角色的。
import { test } from "node:test";
import assert from "node:assert/strict";
import { SOURCE_KINDS, sourcesFrom, sourcesOf, fixedSrcs, HH_ALWAYS, maskAsChat, withDeclared } from "../src/gate/sources.ts";

const TABLE = { chat: ["line", "mailbox"], public: ["forum"], probe: ["ping", "meter"], always: ["memo", "meter"], hands: ["aide"] };
const sorted = (s: ReadonlySet<string>) => [...s].sort();

test("sources: the table from the instance config, one set per kind; a source may sit in several kinds", () => {
  const sources = sourcesOf({ senses: { sources: TABLE } });
  for (const k of SOURCE_KINDS) assert.deepEqual(sorted(sources[k]), [...TABLE[k]].sort(), k);
  assert.ok(sources.probe.has("meter") && sources.always.has("meter"));
});

test("sources: no senses section, no table, or a broken table reads as empty kinds (the framework's default is empty)", () => {
  for (const cfg of [{}, { senses: {} }, { senses: { sources: undefined } }]) {
    const sources = sourcesOf(cfg);
    for (const k of SOURCE_KINDS) assert.equal(sources[k].size, 0, `${JSON.stringify(cfg)} ${k}`);
  }
  for (const raw of [null, "chat", 3, ["line"], { chat: "line" }, { chat: { 0: "line" } }]) {
    const sources = sourcesFrom(raw);
    for (const k of SOURCE_KINDS) assert.equal(sources[k].size, 0, `${JSON.stringify(raw)} ${k}`);
  }
});

test("sources: non-string and empty entries are skipped, the rest of the kind still counts", () => {
  const sources = sourcesFrom({ chat: ["line", 7, "", null, { x: 1 }, "mailbox"], hands: [""] });
  assert.deepEqual(sorted(sources.chat), ["line", "mailbox"]);
  assert.equal(sources.hands.size, 0);
});

test("sources: a key named like an Object property is not read off the prototype", () => {
  const sources = sourcesFrom(JSON.parse('{"__proto__": {"chat": ["sneaky"]}}'));
  assert.equal(sources.chat.size, 0);
});

test("sources: fixed sources are hands, always and HH's own plain — the role's rules never reach them", () => {
  const sources = sourcesFrom(TABLE);
  assert.deepEqual(sorted(fixedSrcs(sources)), ["aide", "memo", "meter", ...HH_ALWAYS].sort());
  assert.deepEqual(sorted(fixedSrcs(sourcesFrom({}))), [...HH_ALWAYS].sort(), "with no table only HH's own source is fixed");
});

test("sources: the console masks chat sources and anything the table does not name; public / probe / always / hands and HH's own sources stay readable", () => {
  const sources = sourcesFrom(TABLE);
  for (const src of ["line", "mailbox"]) assert.equal(maskAsChat(sources, src), true, src);
  for (const src of ["forum", "ping", "meter", "memo", "aide", "plain", "hh-quota"]) assert.equal(maskAsChat(sources, src), false, src);
  assert.equal(maskAsChat(sources, "newapp"), true, "a source the table does not name yet is treated as chat");
  const both = sourcesFrom({ chat: ["line"], probe: ["line"] });
  assert.equal(maskAsChat(both, "line"), true, "in chat and in another kind: chat wins (mask rather than leak)");
});

test("sources: with no table at all the console masks every source except HH's own", () => {
  const sources = sourcesFrom(undefined);
  for (const src of ["line", "forum", "ping", "aide", "chatapp"]) assert.equal(maskAsChat(sources, src), true, src);
  for (const src of ["plain", "hh-quota"]) assert.equal(maskAsChat(sources, src), false, src);
});

test("withDeclared: the modules' kinds fill in sources the role's own table does not name; one it names keeps only its own kinds", () => {
  const declared = [{ hands: ["aide"] }, { probe: ["meter"], always: ["meter"] }];
  assert.deepEqual(withDeclared({ chat: ["aide"], probe: ["memo"] }, declared), { chat: ["aide"], public: [], probe: ["memo", "meter"], always: ["meter"], hands: [] });
  assert.deepEqual(withDeclared(undefined, declared), { chat: [], public: [], probe: ["meter"], always: ["meter"], hands: ["aide"] });
});
