// 控制台的界面文字：两个语言的包对得上，骨架和脚本里用到的条目包里都有，服务端按看的人选的语言出。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import {
  LANGS, LANG_COOKIE, LANG_TAG, defaultLang, fill, flatPack, isLang, langFromCookie, paramsOf, renderPage, say, translator, withClock, withLang,
} from "../src/console/lang/index.ts";
import type { Key } from "../src/console/lang/index.ts";
import { setLang } from "../src/lang/index.ts";
import { createConsole } from "../src/console/server.ts";
import { loadWeb } from "../src/console/web.ts";
import { WEB_DIR, asPlainScript } from "./console-web.ts";
import { NO_WHY_LABEL, PRIVATE_LABEL } from "../src/console/gate.ts";
import { clip } from "../src/console/data.ts";
import { splitPrefix } from "../src/console/prompt.ts";
import { tmpDir } from "./tmp.ts";
import { TEST_ROLE } from "./helpers.ts";
import { OPEN_READS } from "./console-reads.ts";

const zh = flatPack("zh"), en = flatPack("en");
/** 每条都能用的参数：角色和主人叫什么 */
const BASE = ["me", "owner", "ta"];
const CJK = /[㐀-鿿]/;

test("lang: fill puts in {name}, picks {n|one|other}, and leaves what it wasn't given", () => {
  assert.equal(fill("下面有 {n} 条新的", { n: 3 }), "下面有 3 条新的");
  assert.equal(fill("{n} {n|record|records}", { n: 1 }), "1 record");
  assert.equal(fill("{n} {n|record|records}", { n: 0 }), "0 records");
  assert.equal(fill("{n} {n|record|records}", { n: "1" }), "1 record");
  assert.equal(fill("{a}{b}", { a: "{b}", b: "x" }), "{b}x", "填进去的字不再当占位看");
  assert.equal(fill("{who} 说 {what}", { who: "甲" }), "甲 说 {what}", "没给的原样留着，看得见");
  assert.equal(fill("{n|one|}", { n: 2 }), "", "复数那一半可以是空的");
  assert.deepEqual(paramsOf("{b} {a} {n|x|y} {a}"), ["a", "b", "n"]);
  const t = translator("zh", { me: "小满" });
  assert.equal(t("shell.title"), "小满的控制台");
  assert.equal(t("common.minutesAgo", { n: 5 }), "5 分钟前");
  assert.equal(translator("en", { me: "Mira" })("shell.title"), "Mira's console");
  assert.equal(t("没有.这一条" as Key), "没有.这一条", "包里没有的条目显示成它的名字");
});

test("lang: both packs have the same entries and the same blanks; English has no Chinese left in it", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
  for (const k of Object.keys(zh)) {
    const own = (s: string) => paramsOf(s).filter((p) => !BASE.includes(p));
    assert.deepEqual(own(en[k]!), own(zh[k]!), `${k}：两个语言要填的地方不一样`);
    assert.ok(zh[k]!.trim() !== "" && en[k]!.trim() !== "", `${k} 是空的`);
    // 英文包里只有语言切换钮上「中文」两个字是中文
    if (k !== "shell.lang.zh") assert.doesNotMatch(en[k]!, CJK, `${k} 的英文里还有中文`);
  }
  assert.equal(en["common.locale"], "en-US");
  assert.equal(zh["common.locale"], "zh-CN");
});

test("lang: the packs carry no names — who she is and who the owner is come from the config", () => {
  const names = TEST_ROLE.names;
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(flatPack(lang))) {
      for (const n of [names.me, names.owner]) assert.ok(!n || !v.includes(n), `${lang} ${k} 里写死了名字`);
    }
  }
});

test("lang: cookie picks the language; anything else falls back to the default", () => {
  assert.equal(defaultLang(), "zh", "the language this process speaks (the suite runs in Chinese)");
  setLang("en");
  try { assert.equal(defaultLang(), "en"); } finally { setLang("zh"); }
  assert.ok(isLang("en") && isLang("zh") && !isLang("fr") && !isLang(undefined));
  assert.equal(langFromCookie(`${LANG_COOKIE}=en`), "en");
  assert.equal(langFromCookie(`a=1; ${LANG_COOKIE}=zh ; b=2`), "zh");
  assert.equal(langFromCookie(`${LANG_COOKIE}=fr`), null);
  assert.equal(langFromCookie(`x${LANG_COOKIE}=en`), null);
  assert.equal(langFromCookie(undefined), null);
  assert.equal(langFromCookie(""), null);
});

test("lang: the skeleton renders in every language; values are escaped; the data block can't close its own tag", () => {
  const { pageHtml } = loadWeb(WEB_DIR);
  for (const lang of LANGS) {
    const html = renderPage(pageHtml, lang, { me: "小满", owner: "阿树" });
    assert.doesNotMatch(html, /\{\{/, "骨架里的 {{…}} 都换掉了");
    assert.match(html, new RegExp(`<html lang="${LANG_TAG[lang]}">`));
    const m = /<script type="application\/json" id="hh-data">(.*?)<\/script>/s.exec(html);
    assert.ok(m, "页面里有给脚本的数据");
    const data = JSON.parse(m[1]!) as { lang: string; langs: string[]; base: Record<string, string>; strings: Record<string, string>; demo: boolean };
    assert.equal(data.demo, false);
    assert.equal((data as { now?: unknown }).now, null, "钟默认不给：页面用浏览器的钟");
    // 服务端的钟是定死的时候（演示库）：出页面那一刻把它填进数据块，别的一个字不动
    const clocked = withClock(html, 1_794_500_000_123.7);
    assert.equal((JSON.parse(/<script type="application\/json" id="hh-data">(.*?)<\/script>/s.exec(clocked)![1]!) as { now: number }).now, 1_794_500_000_124);
    assert.equal(clocked.replace(`"now":${1_794_500_000_124}}`, '"now":null}'), html);
    assert.equal(data.lang, lang);
    assert.deepEqual(data.langs, [...LANGS]);
    assert.deepEqual(data.base, { me: "小满", owner: "阿树" });
    assert.deepEqual(data.strings, flatPack(lang));
  }
  assert.match(renderPage(pageHtml, "zh", { me: "小满", owner: "阿树" }), /<title>小满的控制台<\/title>/);
  assert.match(renderPage(pageHtml, "en", { me: "Mira", owner: "Sam" }), /<title>Mira&#39;s console<\/title>/);
  // 名字里带尖括号、引号：标签里转义，数据块里的 < 写成 <
  const evil = renderPage(`<title>{{shell.title}}</title><script type="application/json">{{@data}}</script>`, "zh", { me: `</script><b a="1">` });
  assert.ok(!evil.includes("</script><b"), evil.slice(0, 120));
  assert.match(evil, /<title>&#60;\/script&#62;&#60;b a=&#34;1&#34;&#62;的控制台<\/title>/);
  assert.throws(() => renderPage("{{shell.nope}}", "zh"), /shell\.nope/, "骨架里写了包里没有的条目就报错");
  assert.equal(renderPage("<!doctype html><title>t</title>", "zh"), "<!doctype html><title>t</title>", "没有 {{…}} 的骨架原样出");
});

/** 网页脚本的源码：文件名 → 内容 */
function webScripts(): Map<string, string> {
  const dir = join(WEB_DIR, "js");
  return new Map(readdirSync(dir).filter((f) => f.endsWith(".js")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
}

test("lang: every entry the page asks for exists, and every entry in the pack is used somewhere", () => {
  const used = new Set<string>(), groups = new Set<string>();
  const need = (key: string, where: string): void => { assert.ok(key in zh, `${where} 用了包里没有的 ${key}`); used.add(key); };
  const needGroup = (prefix: string, where: string): void => {
    assert.ok(Object.keys(zh).some((k) => k.startsWith(prefix)), `${where} 用了包里没有的一组 ${prefix}…`);
    groups.add(prefix);
  };
  // the talk pane is built from console-ui/src: its source asks for texts the same way (the built bundle renames T)
  const ui = join(import.meta.dirname, "../console-ui/src");
  const uiSources = readdirSync(ui).filter((f) => f.endsWith(".tsx")).map((f): [string, string] => [`console-ui/src/${f}`, readFileSync(join(ui, f), "utf8")]);
  // the wizard's page (web/wizard/) reads its own group: its keys are written without the "wizard." in front
  const sources: Array<[string, string, string]> = [...[...webScripts(), ...uiSources].map(([f, s]): [string, string, string] => [f, s, ""]),
    ["wizard/wizard.js", readFileSync(join(WEB_DIR, "wizard", "wizard.js"), "utf8"), "wizard."]];
  for (const [file, src, prefix] of sources) {
    // 取字只有这几种写法：T("键")、T("键", {…})、T("一组." + 变量)、TGroup("一组")、regionText("脑区", …)
    for (const m of src.matchAll(/(?<![\w$.])(?<!function )T\(\s*([^)]{0,80})/g)) {
      const lit = /^"([\w.]+)"\s*([,)+]?)/.exec(m[1]! + ")");
      assert.ok(lit, `${file}：T( 后面要直接跟一个写死的键：T(${m[1]!.slice(0, 40)}`);
      if (lit[2] === "+") { assert.ok(lit[1]!.endsWith("."), `${file}：拼出来的键要写成 T("一组." + …)：${lit[1]}`); needGroup(prefix + lit[1]!, file); }
      else need(prefix + lit[1]!, file);
    }
    for (const m of src.matchAll(/(?<![\w$.])TGroup\(\s*"([\w.]+)"\s*\)/g)) needGroup(m[1]! + ".", file);
    for (const m of src.matchAll(/(?<![\w$.])regionText\(\s*"(\w+)"/g)) for (const f of ["name", "where", "what"]) need(`regions.${m[1]}.${f}`, file);
  }
  const { pageHtml } = loadWeb(WEB_DIR);
  for (const m of pageHtml.matchAll(/\{\{([\w.]+)\}\}/g)) need(m[1]!, "index.html");
  // 服务端用到的（tx("…")、new Told("…")）：tsc 已经看住键对不对，这里只记「用过」
  const serverSrc = ["../src/console", "../src/console/routes"].flatMap((dir) => readdirSync(join(import.meta.dirname, dir)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(import.meta.dirname, dir, f), "utf8"))).join("\n");
  for (const m of serverSrc.matchAll(/"([a-z]\w*(?:\.\w+)+)"/g)) if (m[1]! in zh) used.add(m[1]!);
  // 服务端拼出来的键写成 `一组.${代号}`：那一组都算用到
  for (const m of serverSrc.matchAll(/`([a-z]\w*(?:\.\w+)*\.)\$\{/g)) if (Object.keys(zh).some((k) => k.startsWith(m[1]!))) groups.add(m[1]!);
  const unused = Object.keys(zh).filter((k) => !used.has(k) && ![...groups].some((g) => k.startsWith(g)));
  assert.deepEqual(unused, [], "包里有没人用的条目");
});

test("lang: the page script's T fills blanks exactly like the server's", () => {
  const src = asPlainScript(webScripts().get("i18n.js")!);
  for (const lang of LANGS) {
    const base = { me: "小满", owner: "阿树" };
    const data = JSON.stringify({ lang, langs: LANGS, base, demo: lang === "en", strings: { ...flatPack(lang), "x.plural": "{n} {n|record|records}{gone}", "x.nest": "{a}{b}" } });
    const warned: string[] = [];
    // 假的页面：只有给脚本的那块数据和放语言切换钮的地方
    const buttons: Array<{ textContent: string; pressed: string }> = [];
    const demoBadge = { hidden: true };
    const document = {
      getElementById: (id: string) => (id === "hh-data" ? { textContent: data } : id === "langs" ? { append: (b: { textContent: string; pressed: string }) => buttons.push(b) } : id === "demo" ? demoBadge : null),
      createElement: () => ({ textContent: "", pressed: "", setAttribute(_k: string, v: string) { this.pressed = v; }, addEventListener() {} }),
    };
    const ctx = vm.createContext({ document, console: { warn: (s: string) => warned.push(s) } });
    vm.runInContext(src, ctx);
    const T = (key: string, params?: Record<string, string | number>): string => vm.runInContext(`T(${JSON.stringify(key)}${params ? ", " + JSON.stringify(params) : ""})`, ctx) as string;
    const t = translator(lang, base);
    for (const [key, params] of [
      ["shell.title", undefined], ["common.minutesAgo", { n: 1 }], ["common.hoursAgo", { n: 1 }], ["common.hoursAgo", { n: 7 }], ["common.rows", { n: 0 }],
      ["timeline.emptyRegion", { name: "主意识" }], ["brain.strip.bar", { time: "08:00", name: "x", n: 2 }], ["brain.map.selfTitle", undefined], ["shell.state.until", {}],
    ] as Array<[Key, Record<string, string | number> | undefined]>) {
      assert.equal(T(key, params), t(key, params), `${lang} ${key}`);
    }
    assert.equal(T("x.plural", { n: 1 }), "1 record{gone}");
    assert.equal(T("x.plural", { n: 2 }), fill("{n} {n|record|records}{gone}", { n: 2 }));
    assert.equal(T("x.nest", { a: "{b}", b: "y" }), "{b}y");
    assert.equal(warned.length, 0);
    assert.equal(demoBadge.hidden, lang !== "en", "演示模式才亮出「演示数据」的标记");
    assert.equal(vm.runInContext("CLOCK_SKEW", ctx), 0, "没给钟：页面的钟就是浏览器的钟");
    assert.deepEqual(buttons.map((b) => [b.textContent, b.pressed]), LANGS.map((l) => [flatPack(lang)[`shell.lang.${l}`], String(l === lang)]), "语言切换钮：每个语言一个，现在用的那个按下");
    assert.equal(T("没有.这一条"), "没有.这一条");
    assert.equal(warned.length, 1, "包里没有的条目在浏览器控制台里说一声");
    assert.deepEqual({ ...(vm.runInContext(`TGroup("regions.kinds")`, ctx) as Record<string, string>) }, Object.fromEntries(Object.entries(flatPack(lang)).filter(([k]) => /^regions\.kinds\.\w+$/.test(k)).map(([k, v]) => [k.slice("regions.kinds.".length), v])));
  }
});

test("lang: the server answers in the viewer's language — page, errors, and listed files stay the same", async () => {
  const dir = tmpDir("hh-console-lang-");
  const web = loadWeb(WEB_DIR);
  const server = createConsole({ tell: OPEN_READS,
    dbPath: join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "p"), logPath: join(dir, "l"),
    ...web, names: { me: "小满", owner: "阿树" },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, lang?: string) => fetch(base + path, lang ? { headers: { cookie: `${LANG_COOKIE}=${lang}` } } : {});
  try {
    const page = await (await get("/")).text();
    assert.match(page, /<html lang="zh-CN">/);
    assert.match(page, /<title>小满的控制台<\/title>/);
    assert.match(await (await get("/", "en")).text(), /<html lang="en">[\s\S]*<title>小满&#39;s console<\/title>/);
    assert.match(await (await get("/", "fr")).text(), /<html lang="zh-CN">/, "不认识的语言按默认的");
    // 名字有拉丁字母的写法时：英文界面用它，中文界面照旧
    const latin = createConsole({ tell: OPEN_READS, dbPath: join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "p"), logPath: join(dir, "l"), ...web, names: { me: "小满", owner: "阿树", meLatin: "Mira" } });
    await new Promise<void>((r) => latin.listen(0, "127.0.0.1", () => r()));
    try {
      const b3 = `http://127.0.0.1:${(latin.address() as AddressInfo).port}`;
      assert.match(await (await fetch(b3 + "/", { headers: { cookie: `${LANG_COOKIE}=en` } })).text(), /<title>Mira&#39;s console<\/title>/);
      assert.match(await (await fetch(b3 + "/")).text(), /<title>小满的控制台<\/title>/);
      assert.deepEqual(await (await fetch(b3 + "/api/gate?day=x", { headers: { cookie: `${LANG_COOKIE}=en` } })).json(), { error: "The gate is not configured" });
    } finally {
      latin.closeAllConnections();
      await new Promise<void>((r) => latin.close(() => r()));
    }
    assert.deepEqual(await (await get("/nope")).json(), { error: "没有这个地址" });
    assert.deepEqual(await (await get("/nope", "en")).json(), { error: "No such address" });
    assert.deepEqual(await (await get("/api/worker?name=nobody", "en")).json(), { error: "No session named nobody" });
    // 库不在：这条报错是在请求外面抛的，也按看的人的语言出
    assert.deepEqual(await (await get("/api/events")).json(), { error: `找不到 ${join(dir, "none.db")}` });
    assert.deepEqual(await (await get("/api/events", "en")).json(), { error: `Can't find ${join(dir, "none.db")}` });
    assert.equal(await (await get("/web/js/i18n.js", "en")).text(), web.assets.get("/web/js/i18n.js")!.body);
    // 没选过语言的人看到的语言、演示模式的标记，都是起服务时定的
    const demo = createConsole({ tell: OPEN_READS, dbPath: join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "p"), logPath: join(dir, "l"), ...web, lang: "en", demo: true });
    await new Promise<void>((r) => demo.listen(0, "127.0.0.1", () => r()));
    try {
      const b2 = `http://127.0.0.1:${(demo.address() as AddressInfo).port}`;
      const html = await (await fetch(b2 + "/")).text();
      assert.match(html, /<html lang="en">/);
      assert.match(html, /"demo":true/);
      assert.match(await (await fetch(b2 + "/", { headers: { cookie: `${LANG_COOKIE}=zh` } })).text(), /<html lang="zh-CN">/, "选过的照选的");
      assert.doesNotMatch(page, /"demo":true/);
    } finally {
      demo.closeAllConnections();
      await new Promise<void>((r) => demo.close(() => r()));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("lang: the two reason keys the server builds for the gate are the ones the page recognises, and Chinese shows them unchanged", () => {
  const src = webScripts().get("gate.js")!;
  assert.ok(src.includes(`{ ${JSON.stringify(PRIVATE_LABEL)}: G_PRIVATE, ${JSON.stringify(NO_WHY_LABEL)}: T("gate.row.noReason") }`), "gate.js 的 G_WHY_SHOWN 和 gate.ts 的两个键一字不差");
  assert.equal(zh["gate.row.private"], PRIVATE_LABEL);
  assert.equal(zh["gate.row.noReason"], NO_WHY_LABEL);
});

test("lang: every operation code the event store writes into its change log has a display name", () => {
  // 库里记的是代号（store.ts 的 put 第一个参数，和撤回时直接写的那一条）；页面显示 events.op.<代号>，没列的会原样露出代号
  const store = readFileSync(join(import.meta.dirname, "../src/memory/events/store.ts"), "utf8");
  const written = new Set([
    ...[...store.matchAll(/this\.put\("([a-z_]+)", /g)].map((m) => m[1]!),
    ...[...store.matchAll(/this\.(?:liftChildren|reparent)\([^"()]*, "([a-z_]+)", /g)].map((m) => m[1]!),   // 代号经这两个传给 put
    ...[...store.matchAll(/INSERT INTO mem_op \([^)]*\) VALUES \(\?, \?, '([a-z_]+)'/g)].map((m) => m[1]!),
  ]);
  assert.ok(written.has("entry_add") && written.has("revert_conflict") && written.has("retire") && written.size >= 20, `从 store.ts 里认出的代号不对：${[...written].join(" ")}`);
  const named = new Set(Object.keys(zh).filter((k) => k.startsWith("events.op.")).map((k) => k.slice("events.op.".length)));
  assert.deepEqual([...written].filter((c) => !named.has(c)), [], "store.ts 写的操作代号，语言包 events.op 里没有叫法");
  assert.deepEqual([...named].filter((c) => !written.has(c)), [], "events.op 里有 store.ts 已经不写的代号");
  assert.ok(webScripts().get("events.js")!.includes('const EOP = TGroup("events.op");'));
});

test("lang: labels the data modules build follow the request's language; outside a request they are in the default language", async () => {
  const prefix = ["# 你现在的运行方式\n说明", `<file path="IDENTITY.md">\n我</file>`, "# 你的人生\n过渡", `<file path="ledger/SOUL.md">\n账</file>`, "# 这次醒来以后\n压缩"].join("\n\n---\n\n");
  const kinds = ["runtime", "personaFile", "frame", "memoryFile", "compacted"];
  // 不在请求里：默认语言
  assert.equal(say("common.image"), "〔图片〕");
  assert.deepEqual(splitPrefix(prefix).map((x) => x.label), ["HH 运行说明", "人格文件 IDENTITY.md", "过渡句：你的人生", "记忆文件 ledger/SOUL.md", "压缩记忆（这次醒来以后）"]);
  assert.deepEqual(splitPrefix(prefix).map((x) => x.kind), kinds);
  assert.equal(clip("头".repeat(100) + "尾".repeat(100), 100).split("\n")[1], "…（中间省略 100 字）…");
  // 英文的请求里：种类不变，显示名换了；文件名是数据，原样
  const en = withLang(translator("en"), () => ({ parts: splitPrefix(prefix), cut: clip("a".repeat(101), 100).split("\n")[1], image: say("common.image") }));
  assert.deepEqual(en.parts.map((x) => x.kind), kinds);
  assert.deepEqual(en.parts.map((x) => x.label), ["Operating note", "Core file IDENTITY.md", "Transition line: your life", "Memory file ledger/SOUL.md", "Page summaries (since waking)"]);
  assert.deepEqual(en.parts.map((x) => x.file ?? null), [null, "IDENTITY.md", null, "ledger/SOUL.md", null]);
  assert.equal(en.cut, "… (1 character left out) …");
  assert.equal(en.image, "[image]");
  // 请求里排出去的回调也在同一个语言里；两个请求互不串
  const [a, b] = await Promise.all([
    withLang(translator("en"), () => new Promise<string>((r) => setTimeout(() => r(say("common.image")), 5))),
    withLang(translator("zh"), () => new Promise<string>((r) => setTimeout(() => r(say("common.image")), 1))),
  ]);
  assert.deepEqual([a, b], ["[image]", "〔图片〕"]);
});

test("lang: when the server's clock is fixed (the demo), the page's clock follows it; otherwise it is the browser's", async () => {
  const src = asPlainScript(webScripts().get("i18n.js")!);
  const then = Date.now() - 16 * 3600_000;   // 服务端的「现在」比真的现在早 16 小时
  const data = JSON.stringify({ lang: "en", langs: LANGS, base: {}, demo: true, now: then, strings: flatPack("en") });
  const document = { getElementById: (id: string) => (id === "hh-data" ? { textContent: data } : id === "langs" ? { append() {} } : id === "demo" ? { hidden: true } : null), createElement: () => ({ setAttribute() {}, addEventListener() {} }) };
  const ctx = vm.createContext({ document, console, Date });
  vm.runInContext(src, ctx);
  const page = vm.runInContext("clock()", ctx) as number;
  assert.ok(Math.abs(page - then) < 5000, "页面的钟跟着服务端的");
  // 页面里算「现在」的地方都走 clock()，不直接问浏览器
  for (const [file, text] of webScripts()) if (file !== "i18n.js") assert.doesNotMatch(text, /Date\.now\(\)|new Date\(\)/, `${file} 里还有直接用浏览器的钟的地方`);
  // 服务端：给了 now 选项才把钟写进页面
  const dir = tmpDir("hh-console-clock-");
  const web = loadWeb(WEB_DIR);
  const mk = (extra: { now?: () => number }) => createConsole({ tell: OPEN_READS, dbPath: join(dir, "none.db"), sockPath: join(dir, "no.sock"), helperSessionsDir: join(dir, "cc"), projectsDir: join(dir, "p"), logPath: join(dir, "l"), ...web, ...extra });
  for (const [server, want] of [[mk({ now: () => then }), `"now":${then}}`], [mk({}), '"now":null}']] as const) {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    try {
      const html = await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)).text();
      assert.ok(html.includes(want), want);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});
