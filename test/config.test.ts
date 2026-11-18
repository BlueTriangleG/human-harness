// 配置的几层：语言包的默认值 → config/default.json → 实例文件（HH_CONFIG）→ 调用处给的，对象逐字段合、数组整个替换；
// 合完几个相对路径解析成绝对的（工作区、状态目录下面），没写时区的用本机的；requireInstance 在起来时拦下没配全的实例；
// 默认标准（gate.defaultWant）空着 = 闸门自带的那句。实例文件每个测试自己写一份、自己设 HH_CONFIG，用完删掉环境变量。
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeBrain, flush } from "./helpers.ts";
import { kernelEnv, loadConfig, remapConfig, requireInstance, roleNames, type Config } from "../src/config.ts";
import { langDefaults, registerLang, type LangPack } from "../src/lang/index.ts";
import { en } from "../src/lang/en/index.ts";
import { zh } from "../src/lang/zh/index.ts";
import { defaultWant } from "../src/gate/rules.ts";
import { People } from "../src/persona/people.ts";
import type { AskOpts } from "../src/kernel/types.ts";
import { tmpDir } from "./tmp.ts";

const DEFAULT = JSON.parse(readFileSync(join(import.meta.dirname, "../config/default.json"), "utf8")) as Config;
const MACHINE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 测试包：中文的字，配置默认值是自己的（每一样都能认出是从这一层来的） */
const PACK_WS_ENV = ["PACK_WS"];
const PACK: LangPack = {
  ...zh,
  code: "cfgtest",
  defaults: {
    limits: { perceptionRotateTokens: 111, restartPageTokens: 1, pageTokens: 1 },
    schedule: { focusSlots: ["01:00", "02:00", "03:00", "04:00", "05:00", "06:00"] },
    regions: { sideThreads: 9 },
    sleep: { workspaceEnv: PACK_WS_ENV },
  },
};
registerLang(PACK);

/** 只给 tsc 看、从来不调：包少了 defaults 不收；defaults 是框架的 Config 的一部分，不认识的键、类型不对的值不收 */
function packsTscRejects(): void {
  const { defaults: _noDefaults, ...withoutDefaults } = zh;
  // @ts-expect-error 少了 defaults
  registerLang({ ...withoutDefaults, code: "no-defaults" });
  // @ts-expect-error defaults 里没有这个键
  registerLang({ ...zh, code: "unknown-key", defaults: { nope: 1 } });
  // @ts-expect-error limits.pageTokens 是数
  registerLang({ ...zh, code: "wrong-type", defaults: { limits: { pageTokens: "1" } } });
}

/** 写一份实例文件、HH_CONFIG 指过去跑 fn，跑完把 HH_CONFIG 拿掉 */
function withInstance<T>(instance: unknown, fn: (file: string) => T): T {
  const file = join(tmpDir("hh-config-"), "config.json");
  writeFileSync(file, JSON.stringify(instance));
  process.env.HH_CONFIG = file;
  try { return fn(file); } finally { delete process.env.HH_CONFIG; }
}

test("config layers: language defaults < default.json < the instance file < call-site overrides; objects merge, arrays replace", () => {
  const cfg = withInstance(
    { lang: "cfgtest", limits: { restartPageTokens: 2 }, regions: { sideThreads: 3 }, schedule: { focusSlots: ["10:00"] }, models: { haiku: "inst-haiku", sonnet: "inst-sonnet" } },
    () => loadConfig({ models: { haiku: "over-haiku" }, regions: { sideThreads: 4 } }),
  );
  assert.equal(cfg.limits.perceptionRotateTokens, 111, "set only in the language defaults: it shows through");
  assert.equal(cfg.limits.pageTokens, DEFAULT.limits.pageTokens, "default.json beats the language defaults");
  assert.equal(cfg.limits.restartPageTokens, 2, "the instance file beats the language defaults");
  assert.deepEqual(cfg.schedule.focusSlots, ["10:00"], "an array is replaced whole, never merged element by element (the pack had six, default.json four)");
  assert.equal(cfg.models.sonnet, "inst-sonnet", "the instance file beats default.json");
  assert.equal(cfg.models.haiku, "over-haiku", "call-site overrides beat the instance file");
  assert.equal(cfg.regions.sideThreads, 4, "call-site overrides beat everything below");
  assert.equal(cfg.models.opus, DEFAULT.models.opus, "siblings nobody overrode stay");
  assert.equal(cfg.schedule.focusMinutes, DEFAULT.schedule.focusMinutes);
  // 只有包里有的数组：合出来的是一份拷贝，改它不会改到包里
  assert.deepEqual(cfg.sleep.workspaceEnv, PACK_WS_ENV);
  assert.notEqual(cfg.sleep.workspaceEnv, PACK_WS_ENV);
  cfg.sleep.workspaceEnv!.push("CHANGED");
  assert.deepEqual(withInstance({ lang: "cfgtest" }, () => loadConfig()).sleep.workspaceEnv, ["PACK_WS"], "the next load is not affected");
});

test("config layers: the instance file's lang picks the language defaults (absent or blank = the default, English; unknown throws like setLang); call-site overrides do not pick it", () => {
  assert.equal(loadConfig().limits.perceptionRotateTokens, DEFAULT.limits.perceptionRotateTokens, "no instance file: the default pack, not the test pack");
  assert.equal(withInstance({}, () => loadConfig()).limits.perceptionRotateTokens, DEFAULT.limits.perceptionRotateTokens, "an instance without lang: the default pack");
  assert.equal(withInstance({ lang: " " }, () => loadConfig()).limits.perceptionRotateTokens, DEFAULT.limits.perceptionRotateTokens, "a blank lang: the default pack");
  assert.equal(withInstance({ lang: " cfgtest " }, () => loadConfig()).limits.perceptionRotateTokens, 111, "trimmed like setLang");
  assert.throws(() => withInstance({ lang: "nope" }, () => loadConfig()), (e: unknown) => e instanceof Error && e.message.startsWith('no language pack "nope" (have: zh, en, cfgtest'));
  assert.equal(loadConfig({ lang: "cfgtest" }).limits.perceptionRotateTokens, DEFAULT.limits.perceptionRotateTokens, "the language is read from the files before merging");
  assert.equal(langDefaults(), en.defaults);
  assert.equal(langDefaults(""), en.defaults);
  assert.equal(langDefaults(null), en.defaults);
  assert.equal(langDefaults("zh"), zh.defaults);
  assert.equal(langDefaults("cfgtest"), PACK.defaults);
  assert.throws(() => langDefaults("nope"), /no language pack "nope"/);
});

test("config layers: each pack's defaults carry the person-card template and the general category; the merged config never shares the pack's objects", () => {
  for (const [pack, lang, general] of [[zh, "zh", "通用"], [en, "en", "General"]] as const) {
    const z = pack.defaults;
    assert.equal(z.learning?.generalCategory, general);
    const tpl = z.memory?.people?.template as { quotes: Array<{ fullHint?: string; fullHintOthers?: string }> };
    assert.ok(tpl && Array.isArray(tpl.quotes));
    const cfg = withInstance({ lang }, () => loadConfig());
    assert.notEqual(cfg.memory?.people?.template, z.memory?.people?.template);
    assert.equal(cfg.learning.generalCategory, general);
  }
});

test("config paths: skills.roots / skills.discover / learning.root resolve against workspace, browser.userDataDir against stateDir; absolute and empty values are left as they are", () => {
  const cfg = withInstance({
    workspace: "/r/ws", stateDir: "/r/st",
    skills: { roots: ["skills", "/abs/plugin-skills/", "", "sub/../more"], discover: "skills" },
    learning: { root: "books" },
    browser: { userDataDir: "browser" },
    tools: { wordListFile: "memory/words.md" },
  }, () => loadConfig());
  assert.deepEqual(cfg.skills.roots, ["/r/ws/skills", "/abs/plugin-skills/", "", "/r/ws/more"], "an absolute one passes through untouched (not even normalized)");
  assert.equal(cfg.skills.discover, "/r/ws/skills");
  assert.equal(cfg.learning.root, "/r/ws/books");
  assert.equal(cfg.browser.userDataDir, "/r/st/browser");
  assert.equal(cfg.tools.wordListFile, "memory/words.md", "only those four keys are resolved here (the brain joins the word list itself)");
  assert.equal(cfg.gate.rulesFile, DEFAULT.gate.rulesFile);
  const abs = withInstance({ workspace: "/r/ws", stateDir: "/r/st", skills: { roots: ["/a"], discover: "/a/b" }, learning: { root: "/c" }, browser: { userDataDir: "/d" } }, () => loadConfig());
  assert.deepEqual([abs.skills.roots, abs.skills.discover, abs.learning.root, abs.browser.userDataDir], [["/a"], "/a/b", "/c", "/d"]);
  assert.equal(withInstance({ workspace: "/r/ws", stateDir: "/r/st", skills: { discover: "" } }, () => loadConfig()).skills.discover, "", "empty means off and stays empty");
});

test("config paths: resolved after every layer (against the final workspace and stateDir), and not at all when that base is absent, empty or relative", () => {
  const cfg = withInstance({ workspace: "/inst/ws", stateDir: "/inst/st", skills: { roots: ["skills"], discover: "skills" }, learning: { root: "skills" }, browser: { userDataDir: "browser" } },
    () => loadConfig({ workspace: "/over/ws", stateDir: "/over/st" }));
  assert.deepEqual([cfg.skills.roots, cfg.skills.discover, cfg.learning.root, cfg.browser.userDataDir], [["/over/ws/skills"], "/over/ws/skills", "/over/ws/skills", "/over/st/browser"]);
  for (const base of ["", "rel/ws"]) {
    const c = loadConfig({ workspace: base, stateDir: base, skills: { roots: ["skills"], discover: "skills" }, learning: { root: "skills" }, browser: { userDataDir: "browser" } });
    assert.deepEqual([c.skills.roots, c.skills.discover, c.learning.root, c.browser.userDataDir], [["skills"], "skills", "skills", "browser"], `no resolving against the current directory (base ${JSON.stringify(base)})`);
  }
  const over = { skills: { roots: ["skills"] } };
  loadConfig({ workspace: "/w", ...over });
  assert.deepEqual(over.skills.roots, ["skills"], "the caller's objects are not changed");
});

test("config timezone: empty, blank or null = the machine's zone; a set zone is kept", () => {
  for (const tz of ["", "  ", null]) assert.equal(loadConfig({ schedule: { timezone: tz } }).schedule.timezone, MACHINE_TZ, JSON.stringify(tz));
  assert.equal(loadConfig({ schedule: { timezone: "Asia/Tokyo" } }).schedule.timezone, "Asia/Tokyo");
  assert.equal(withInstance({ schedule: { timezone: "Europe/Paris" } }, () => loadConfig()).schedule.timezone, "Europe/Paris");
});

test("requireInstance: names the missing or relative workspace / stateDir, and the empty gate names while the gate is on, with HH_CONFIG — in one line", () => {
  const ok = loadConfig({ workspace: "/w", stateDir: "/s", gate: { enabled: true }, names: { me: "阿青", owner: "老林", notMe: [] } });
  requireInstance(ok);
  const without = (key: "workspace" | "stateDir"): Config => { const c = structuredClone(ok) as Partial<Config>; delete c[key]; return c as Config; };
  const cases: Array<[Config, RegExp]> = [
    [without("workspace"), /^config: workspace is not set — the instance file must give it as an absolute path \(HH_CONFIG is not set\)$/],
    [{ ...ok, workspace: "" }, /^config: workspace is not set/],
    [{ ...ok, workspace: "ws" }, /^config: workspace must be an absolute path, got "ws" \(HH_CONFIG is not set\)$/],
    [without("stateDir"), /^config: stateDir is not set/],
    [{ ...ok, stateDir: "  " }, /^config: stateDir is not set/],
    [{ ...ok, stateDir: "./st" }, /^config: stateDir must be an absolute path, got "\.\/st"/],
    [{ ...ok, names: { ...ok.names, me: "" } }, /^config: names\.me is empty while the gate is enabled — set it in the instance file, or set gate\.enabled to false \(HH_CONFIG is not set\)$/],
    [{ ...ok, names: { ...ok.names, owner: " " } }, /^config: names\.owner is empty while the gate is enabled/],
  ];
  for (const [cfg, msg] of cases) {
    assert.throws(() => requireInstance(cfg), (e: unknown) => e instanceof Error && msg.test(e.message) && !e.message.includes("\n"), String(msg));
  }
  // 实例文件是哪个也写上
  withInstance({}, (file) => {
    assert.throws(() => requireInstance({ ...ok, workspace: "" }), (e: unknown) => e instanceof Error && e.message.endsWith(`(HH_CONFIG=${file})`));
  });
  // 闸门关着：名字空着也起得来
  requireInstance({ ...ok, gate: { ...ok.gate, enabled: false }, names: { me: "", owner: "", notMe: [] } });
});

test("roleNames: the role's own name and the owner's, from where the config keeps them — a fresh object, empty strings when nothing is set", () => {
  const cfg = withInstance({ names: { me: "阿青", owner: "老林", notMe: ["小禾"] } }, () => loadConfig());
  const names = roleNames(cfg);
  assert.deepEqual(names, { me: "阿青", owner: "老林", ta: "阿青", place: "", id: cfg.id }, "no pronoun set: the role's own name stands in; no place set: empty");
  names.owner = "changed";
  assert.equal(cfg.names.owner, "老林", "a fresh object: changing it does not change the config");
  assert.deepEqual(roleNames(cfg), { me: "阿青", owner: "老林", ta: "阿青", place: "", id: cfg.id });
  // a pronoun that is set is used as written (trimmed); blank counts as unset
  const withTa = (ta: string): Config => withInstance({ names: { me: "阿青", owner: "老林", ta, place: " 河边镇 " } }, () => loadConfig());
  assert.equal(roleNames(withTa("她")).ta, "她");
  assert.equal(roleNames(withTa(" 他 ")).ta, "他");
  assert.equal(roleNames(withTa("  ")).ta, "阿青");
  assert.equal(roleNames(withTa("她")).place, "河边镇", "the place is trimmed too");
  // nothing set: the framework's defaults are empty — no other role's names stand in
  assert.deepEqual(roleNames(withInstance({}, () => loadConfig())), { me: "", owner: "", ta: "", place: "", id: "" });
  // a hand-built partial config (tests and tools do this): no names, no throw
  assert.deepEqual(roleNames({} as unknown as Config), { me: "", owner: "", ta: "", place: "", id: "" });
});

/** 小判断的回答：每条都判 digest */
const digestAll = (o: AskOpts): string => JSON.stringify({ items: [...o.prompt.matchAll(/^\[([^\]\s]+)\] 来源：/gm)].map((m) => ({ id: m[1], verdict: "digest", gist: "路过", when: "now", why: "因为", unsure: false })) });

test("an empty gate.defaultWant means the gate's built-in default: for an event no rule names, and for the owner in a group without @ (judge-floor)", async () => {
  const people = new People({ owner: { name: "老林", privacy: "owner", senders: ["+6155500015"], handles: { wx: ["老林"] } } });
  const t = makeBrain({ gate: { defaultWant: "" } }, undefined, { people });
  t.driver.answerAsk(digestAll);
  t.brain.fromSenses("x", [{ src: "bili", id: "dw01", text: "B站 某人回复了你：路过" }]);
  await t.brain.gate!.idle();
  t.brain.fromSenses("x", [{ src: "wx", id: "dw02", text: "某群：老林: 周末去哪", conv: "某群", sender: "老林", isGroup: true, mentionsMe: false }]);
  await t.brain.gate!.idle();
  await flush();
  assert.equal(t.driver.asks.length, 2);
  for (const a of t.driver.asks) {
    assert.ok(a.prompt.includes(`规则想看的：${defaultWant()}`), a.prompt);
    assert.doesNotMatch(a.prompt, /规则想看的：\n/, "never an empty standard");
  }
  const floor = t.db.prepare("SELECT action FROM gate_log WHERE ev_id = 'dw02'").get() as { action: string } | undefined;
  assert.equal(floor?.action, "judge-floor", "the second one went the judge-floor way");
  // 配了的照用配的
  const set = makeBrain({ gate: { defaultWant: "只看提到我的" } });
  set.driver.answerAsk(digestAll);
  set.brain.fromSenses("x", [{ src: "bili", id: "dw03", text: "B站 某人回复了你：路过" }]);
  await set.brain.gate!.idle();
  assert.ok(set.driver.asks[0]!.prompt.includes("规则想看的：只看提到我的"));
});

test("config/default.json is neutral: no home-directory path, no non-ASCII character, no workspace / stateDir", () => {
  const raw = readFileSync(join(import.meta.dirname, "../config/default.json"), "utf8");
  assert.doesNotMatch(raw, /\/Users\/|\/home\/|~\//, "an absolute path under a home directory");
  assert.doesNotMatch(raw, /[^\x00-\x7f]/, "a non-ASCII character (names and language text belong to the instance file or the language pack)");
  const cfg = JSON.parse(raw) as Config;
  assert.equal(cfg.id, "");
  assert.equal(cfg.writingLanguage, "");
  assert.deepEqual(cfg.names, { me: "", owner: "", notMe: [] });
  assert.equal(cfg.gate.defaultWant, "");
  assert.deepEqual(cfg.gate.card.soul, []);
  assert.deepEqual(cfg.skills.names, []);
  assert.deepEqual(cfg.kernel.mcpServers, {});
  assert.ok(!("workspace" in cfg) && !("stateDir" in cfg), "workspace and stateDir are the instance file's alone");
});

test("remapConfig: several roots (longest wins), path boundary, arrays, keys untouched, one pass", () => {
  const pairs = [["/a/ws", "/r/ws"], ["/a/ws/sub", "/r/sub"], ["/a/state", "/a/ws/x"]] as const;
  const out = remapConfig({
    "/a/ws": ["/a/ws", "/a/ws/skills", "/a/ws/sub/deep", "/a/ws2", "/a/wsx/y", "/b/a/ws"],
    nested: { deep: { p: "/a/ws/sub", q: "/a/state/db", n: 3, f: false, z: null } },
  }, pairs);
  assert.deepEqual(out, {
    "/a/ws": ["/r/ws", "/r/ws/skills", "/r/sub/deep", "/a/ws2", "/a/wsx/y", "/b/a/ws"],
    nested: { deep: { p: "/r/sub", q: "/a/ws/x/db", n: 3, f: false, z: null } },
  }, "the replaced /a/state/db (now under /a/ws) is not looked at again");
});

test("two roles under one system user get their own kernel temp root, inside their own state dir", () => {
  const user = tmpDir("hh-kernel-tmp-");
  const kernel = { ...DEFAULT.kernel, env: { KEEP: "1" } };
  const [a, b] = [kernelEnv({ stateDir: join(user, "a"), kernel }), kernelEnv({ stateDir: join(user, "b"), kernel })];
  assert.equal(a.CLAUDE_CODE_TMPDIR, join(user, "a", "tmp"));
  assert.equal(b.CLAUDE_CODE_TMPDIR, join(user, "b", "tmp"));
  assert.ok(existsSync(a.CLAUDE_CODE_TMPDIR!) && existsSync(b.CLAUDE_CODE_TMPDIR!), "made, so the kernel can create its own dir in it");
  assert.equal(a.KEEP, "1");
  assert.equal(kernelEnv({ stateDir: join(user, "a"), kernel: { ...kernel, env: { CLAUDE_CODE_TMPDIR: "/set" } } }).CLAUDE_CODE_TMPDIR, "/set", "the role's config wins");
});
