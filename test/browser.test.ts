// 她自己的 Chrome：HH 直接开、直接连（不走 openclaw browser 命令行）；hh send 直接连网关发。
// 浏览器的测试开一个无头 Chrome（临时用户资料、临时端口），不碰她真的那个；机器上没有 Chrome 就跳过。
import { TEST_LANG, TEST_NAMES } from "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Chrome, evalSource, psLines } from "../src/browser/chrome.ts";
import { P, setLang } from "../src/lang/index.ts";
import { browserTool } from "../src/tools/browser.ts";
import type { ToolContext } from "../src/tools/hhtools.ts";
import { regionSpecs } from "../src/regions/specs.ts";
import { loadConfig } from "../src/config.ts";
import { sendCommand } from "../src/cli-direct.ts";
import { testConfig } from "./helpers.ts";

const CHROME = loadConfig().browser.chrome;
const noChrome = !existsSync(CHROME) && "这台机器上没有 Chrome";

test("browser: what is signed in is the role's to say (browser.logins), else the pack's general words; the first role's words, set in its config, give the description it read before, byte for byte", () => {
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const desc = (lang: string, logins?: string) => { setLang(lang); return browserTool({ regionId: "main", ...(logins ? { browser: { o: { logins } } } : {}) } as unknown as ToolContext).description; };
  try {
    // sha256 of the Chinese description at 01bed46de, when the pack still said itself what was signed in there, those
    // words swapped for the made-up ones here: the template is that text with a slot where they were (that a role's own
    // words give what it read, byte for byte, is checked outside the repository, against its config)
    assert.equal(sha(desc("zh", "工作用的谷歌账号登着")), "ce18b409fb2609a32b65074337883f13d8178343fc5a9a8a0a4b791de168754a");
    assert.equal(sha(desc("en")), "fcc9790f1cbd9bea866cb6b07e5f5578b43e22845b86bbaad4b0073102b4ddf0", "English, nothing set: as it was");
    assert.match(desc("zh"), /^你自己的 Chrome（你登过的网站会一直登着），/);
  } finally { setLang(TEST_LANG, TEST_NAMES); }
});

test("evaluate：表达式取值、函数调用、几句语句包成函数体；有副作用的话只跑一次", async () => {
  const run = (js: string) => new Function(`return ${evalSource(js)}`)() as Promise<unknown>;
  assert.equal(await run("1 + 2"), 3);
  assert.equal(await run("() => 6 * 7"), 42);
  assert.equal(await run("async () => { return 'ok'; }"), "ok");
  assert.equal(await run("const a = [1, 2, 3];\nreturn a.length"), 3);
  const g = globalThis as { hits?: number };
  g.hits = 0;
  await run("globalThis.hits++");
  assert.equal(g.hits, 1);
  await run("globalThis.hits += 1; globalThis.hits += 1");
  assert.equal(g.hits, 3);
});

test("browser 工具前台和一边做的事都有，下意识和睡觉整理没有", () => {
  const specs = regionSpecs(loadConfig());
  for (const s of specs) assert.equal(s.tools.includes("browser"), s.role === "main" || s.role === "side", s.id);
});

test("浏览器：开页、看结构、按 ref 点、输入、跑 JS、截图、上传、标签页、关掉；两份心思各看各的页", { skip: noChrome, timeout: 90_000 }, async () => {
  const dir = tmpDir("hh-browser-");
  const page = join(dir, "page.html");
  writeFileSync(page, `<title>测试页</title><h1>你好</h1>
    <button onclick="document.title='点过了'">发布</button>
    <input placeholder="名字" id="name"><input type="file" id="f">
    <script>setTimeout(() => { const p = document.createElement('p'); p.textContent = '加载完了'; document.body.append(p); }, 300)</script>`);
  writeFileSync(join(dir, "up.txt"), "x");
  const chrome = new Chrome({ chrome: CHROME, userDataDir: join(dir, "profile"), port: 19000 + Math.floor(Math.random() * 500), shotsDir: join(dir, "shots"), headless: true });
  const ctx = (regionId: string) => ({ regionId, browser: chrome }) as unknown as ToolContext;
  const main = browserTool(ctx("main")).handler;
  const side = browserTool(ctx("side-1")).handler;
  try {
    assert.match(await main({ action: "status" }), /没开/);
    assert.match(await main({ action: "open", url: `file://${page}` }), /^开好了：t\d+「测试页」file:/);
    const snap = await main({ action: "snapshot" });
    const ref = /button "发布" \[ref=(e\d+)\]/.exec(snap)?.[1];
    assert.ok(ref, snap);
    assert.match(await main({ action: "click", ref }), /点了。现在在 t\d+「点过了」/);
    const box = /textbox "名字" \[ref=(e\d+)\]/.exec(snap)?.[1];
    assert.equal(await main({ action: "type", ref: box, text: "米拉" }), "输入了。");
    assert.equal(await main({ action: "evaluate", js: "document.getElementById('name').value" }), "米拉");
    assert.equal(await main({ action: "evaluate", js: "() => document.title" }), "点过了");
    assert.equal(await main({ action: "evaluate", js: "const n = document.querySelectorAll('input').length;\nreturn {n}" }), '{\n "n": 2\n}');
    assert.equal(await main({ action: "evaluate", js: "void 0" }), "跑完了（没有返回值）。");
    assert.equal(await main({ action: "wait", text: "加载完了" }), "「加载完了」出来了。");
    assert.match(await main({ action: "upload", files: [join(dir, "up.txt")] }), /传上去了/);
    assert.equal(await main({ action: "evaluate", js: "document.getElementById('f').files[0].name" }), "up.txt");
    const shot = /截好了：(\S+)（/.exec(await main({ action: "screenshot" }))?.[1];
    assert.ok(shot && existsSync(shot));
    assert.match(await main({ action: "click", ref: "e999" }), /没做成/);

    // 另一份心思开自己的页，不抢前台那一页
    await side({ action: "open", url: "about:blank" });
    assert.match(await main({ action: "evaluate", js: "document.title" }), /点过了/);
    const tabs = await main({ action: "tabs" });
    assert.match(tabs, /→ t\d+「点过了」/);
    assert.equal(tabs.split("\n").length, 3, tabs);           // 一开始那个空白页 + 两页
    // 第三份心思还没认领过页：close 不乱关别人的；看页面拿空着的那页，不拿前台的
    const side2 = browserTool(ctx("side-2")).handler;
    assert.match(await side2({ action: "close" }), /没在用哪一页/);
    assert.doesNotMatch(await side2({ action: "snapshot" }), /点过了/);
    // 别的心思十分钟内还在用：stop 先不关整个浏览器
    assert.match(await main({ action: "stop" }), /先没关：另一份心思在用 t\d+/);
    assert.match(await side2({ action: "close" }), /^关了 t\d+/);
    assert.match(await side({ action: "close" }), /^关了 t\d+/);
    assert.match(await main({ action: "evaluate", js: "document.title" }), /点过了/);

    assert.equal(await main({ action: "stop" }), "浏览器关了。");
    assert.equal(await chrome.running(), false);
    assert.equal(await main({ action: "stop" }), "浏览器本来就没开。");
    // 关了以后再用会自己开回来，登录资料还是那一份
    assert.match(await main({ action: "open", url: `file://${page}` }), /开好了/);
  } finally {
    await chrome.stop().catch(() => {});
  }
});

test("拿 cookie（B站 插件同步登录用）：浏览器没开就临时开一下，用完关掉", { skip: noChrome, timeout: 60_000 }, async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Set-Cookie": "SESSDATA=abc; Path=/; Max-Age=3600", "Content-Type": "text/html" });
    res.end("<title>b</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const dir = tmpDir("hh-browser-");
  const chrome = new Chrome({ chrome: CHROME, userDataDir: join(dir, "profile"), port: 19500 + Math.floor(Math.random() * 400), shotsDir: dir, headless: true });
  try {
    const cookies = await chrome.cookies(url);
    assert.deepEqual(cookies.map((c) => [c.name, c.value]), [["SESSDATA", "abc"]]);
    assert.equal(await chrome.running(), false, "本来没开的，用完关掉");
  } finally {
    server.close();
    await chrome.stop().catch(() => {});
  }
});

test("Chrome 开着但一个页面都没有（Mac 上关了最后一个窗口）：先开个空白页再连（11-01 线上连不上就是这样）", { skip: noChrome, timeout: 60_000 }, async () => {
  const dir = tmpDir("hh-browser-");
  const port = 19900 + Math.floor(Math.random() * 90);
  const chrome = new Chrome({ chrome: CHROME, userDataDir: join(dir, "profile"), port, shotsDir: dir, headless: true });
  try {
    await chrome.connect();
    const again = new Chrome({ ...chrome.o });   // 换一个新连接（像 hhd 重启过）
    const pages = async () => ((await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{ type: string; id: string }>).filter((t) => t.type === "page");
    for (const p of await pages()) await fetch(`http://127.0.0.1:${port}/json/close/${p.id}`);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await pages()).length, 0);
    const { context } = await again.connect();
    assert.deepEqual(context.pages().map((p) => p.url()), ["about:blank"]);
  } finally {
    await chrome.stop().catch(() => {});
  }
});

test("hh send：人名换成号码，直接连网关发；网关不通就报错，不退回 openclaw 命令行", async () => {
  const ws = tmpDir("hh-send-");
  mkdirSync(join(ws, "memory/people"), { recursive: true });
  writeFileSync(join(ws, "memory/people/registry.json"), JSON.stringify({ ada: { name: "ada", senders: ["+6155500010"] } }));
  const cfg = testConfig({ workspace: ws, tools: { sendDryRun: false } });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const gateway = { connected: true, request: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return {}; } };
  assert.equal(await sendCommand(cfg, ["ada", "[米拉的电脑负载]", "内存紧"], { gateway: gateway as never }), "发出去了（whatsapp → ada）");
  assert.equal(calls[0]!.method, "send");
  assert.equal(calls[0]!.params.to, "+6155500010");
  assert.equal(calls[0]!.params.message, "[米拉的电脑负载] 内存紧");
  await sendCommand(cfg, ["ada", "--media", "/a.png"], { gateway: gateway as never });
  assert.equal(calls[1]!.params.mediaUrl, "/a.png");
  const down = { connected: false, request: async () => { throw new Error("gateway socket error"); } };
  await assert.rejects(sendCommand(cfg, ["ada", "在吗"], { gateway: down as never }), /连不上网关/);
  await assert.rejects(sendCommand(cfg, ["ada"], { gateway: gateway as never }), /用法/);
});

// ---------- 调试端口上开着的是谁：只连自己角色的 Chrome ----------

/** 假的「端口有人应」：随机本地端口，/json/version 回一个指不到哪的 ws 地址，记下每个请求的路径；其余路径 /json/list 回有一页 */
async function fakePort(): Promise<{ port: number; paths: string[]; close: () => Promise<void> }> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end(req.url === "/json/list" ? JSON.stringify([{ type: "page" }]) : JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, paths, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

/** 只问 holder：端口有人应（假服务器）、进程表是 lines */
async function holderWith(lines: (port: number, dir: string) => string[], dirName = "profile"): Promise<{ state: string; port: number; paths: string[]; chrome: Chrome; dir: string; close: () => Promise<void> }> {
  const fake = await fakePort();
  const dir = join(tmpDir("hh-holder-"), dirName);
  mkdirSync(dir, { recursive: true });
  const chrome = new Chrome({ chrome: "/nonexistent/chrome", userDataDir: dir, port: fake.port, shotsDir: join(dir, "shots"), listProcs: async () => lines(fake.port, dir) });
  return { state: (await chrome.holder()).state, port: fake.port, paths: fake.paths, chrome, dir, close: fake.close };
}

const PS_NOISE = ["/usr/sbin/cfprefsd agent", "/bin/zsh -l"];

test("holder: a line with the port argument and our profile followed by more flags is ours; the configured, resolved and realpath forms all count", async () => {
  const a = await holderWith((port, dir) => [...PS_NOISE, `/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=${dir} --no-first-run about:blank`]);
  try { assert.equal(a.state, "ours"); } finally { await a.close(); }
  // 配置里写的是软链，ps 里是解开的真路径
  const fake = await fakePort();
  const root = tmpDir("hh-holder-");
  const real = join(root, "real");
  mkdirSync(real);
  symlinkSync(real, join(root, "link"));
  const chrome = new Chrome({ chrome: "/x", userDataDir: join(root, "link"), port: fake.port, shotsDir: root, listProcs: async () => [`/opt/x/chrome --user-data-dir=${realpathSync(real)} --remote-debugging-port=${fake.port}`] });
  try { assert.equal((await chrome.holder()).state, "ours"); } finally { await fake.close(); }
});

test("holder: the port is answered but the profile is another one -> other; connect() rejects with exactly the port-taken sentence and the endpoint saw nothing but /json/version", async () => {
  const h = await holderWith((port) => [`/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=/somewhere/else/profile --no-first-run`]);
  try {
    assert.equal(h.state, "other");
    await assert.rejects(h.chrome.connect(), (e: Error) => e.message === P.browserPortTaken(h.port));
    assert.ok(!P.browserPortTaken(h.port).includes("/somewhere/else"), "the sentence does not carry the other profile's path");
    assert.ok(h.paths.length > 0 && h.paths.every((x) => x === "GET /json/version"), JSON.stringify(h.paths));
  } finally { await h.close(); }
});

test("holder boundaries: our dir plus a suffix is not ours; port <p>1 or a prefix of <p> is not this port's holder; a profile directory with a space is recognised", async () => {
  const suffix = await holderWith((port, dir) => [`/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=${dir}-2 --no-first-run`]);
  try { assert.equal(suffix.state, "other"); } finally { await suffix.close(); }
  const longer = await holderWith((port, dir) => [`/opt/x/chrome --remote-debugging-port=${port}1 --user-data-dir=${dir}`]);
  try { assert.equal(longer.state, "other", "a line for port <p>1 is not <p>'s holder"); } finally { await longer.close(); }
  const shorter = await holderWith((port, dir) => [`/opt/x/chrome --remote-debugging-port=${String(port).slice(0, -1)} --user-data-dir=${dir}`]);
  try { assert.equal(shorter.state, "other", "a line for a prefix of <p> is not <p>'s holder"); } finally { await shorter.close(); }
  const space = await holderWith((port, dir) => [`/Applications/Some Chrome.app/chrome --user-data-dir=${dir} --remote-debugging-port=${port}`, `/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=${dir} --no-first-run`], "阿青 的 profile");
  try { assert.equal(space.state, "ours", "a space in the path"); } finally { await space.close(); }
  const spaceEnd = await holderWith((port, dir) => [`/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=${dir}`], "老林 的 profile");
  try { assert.equal(spaceEnd.state, "ours", "a space in the path, at the end of the line"); } finally { await spaceEnd.close(); }
});

test("holder: the port answers but no visible line carries the port argument -> other", async () => {
  const h = await holderWith(() => [...PS_NOISE, "/opt/x/chrome --user-data-dir=/x/y"]);
  try { assert.equal(h.state, "other"); } finally { await h.close(); }
});

test("holder: the process list cannot be read (throws, or is empty) -> unknown, and the guard lets the call through", async () => {
  const fake = await fakePort();
  const dir = tmpDir("hh-holder-");
  try {
    for (const listProcs of [async () => { throw new Error("ps 超时"); }, async () => [], async () => ["", "  "]]) {
      const chrome = new Chrome({ chrome: "/x", userDataDir: dir, port: fake.port, shotsDir: dir, listProcs });
      assert.equal((await chrome.holder()).state, "unknown");
      // 放行：后面照常去碰端口（/json/list），最后在连 CDP 上失败，但不是「端口被占」那句
      fake.paths.length = 0;
      await assert.rejects(chrome.connect(), (e: Error) => e.message !== P.browserPortTaken(fake.port));
      assert.ok(fake.paths.includes("GET /json/list"), JSON.stringify(fake.paths));
    }
  } finally { await fake.close(); }
});

test("holder: nothing answers on the port -> free (the process list is not even read)", async () => {
  const fake = await fakePort();
  const port = fake.port;
  await fake.close();
  let read = 0;
  const dir = tmpDir("hh-holder-");
  const chrome = new Chrome({ chrome: "/x", userDataDir: dir, port, shotsDir: dir, listProcs: async () => { read++; return ["x"]; } });
  assert.equal((await chrome.holder()).state, "free");
  assert.equal(read, 0);
});

test("the default process listing (real /bin/ps, no LANG / LC_*) shows a non-ASCII, space-containing argument literally", async () => {
  const marker = `--user-data-dir=${tmpDir("hh-ps-")}/阿青 的 profile`;
  const dummy = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "--", marker], { stdio: "ignore" });
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) if (k === "LANG" || k.startsWith("LC_")) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    await new Promise((r) => setTimeout(r, 300));   // 让它起来
    const lines = await psLines();
    assert.ok(lines.some((l) => l.includes(marker)), "the marker argument is in some line, byte for byte");
  } finally {
    for (const [k, v] of Object.entries(saved)) process.env[k] = v;
    dummy.kill();
  }
});

test("connect(): when the guard refuses right after our own launch, the Chrome we just started is killed", { timeout: 30_000 }, async () => {
  const root = tmpDir("hh-launch-");
  const pidFile = join(root, "pid");
  const prog = join(root, "fake-chrome");
  writeFileSync(prog, `#!/bin/sh\necho $$ > '${pidFile}'\nexec /bin/sleep 60\n`);
  chmodSync(prog, 0o755);
  // 假端点一直占着自己的端口；程序起来以前 /json/version 回 503（running() 看 .ok，等于没人应），起来以后才回 200（像别的 Chrome 在我们起的时候抢到了端口）
  let up = false;
  const server = createServer((_q, res) => { res.statusCode = up ? 200 : 503; res.end("{}"); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const chrome = new Chrome({ chrome: prog, userDataDir: join(root, "profile"), port, shotsDir: root, headless: true, listProcs: async () => [`/opt/x/chrome --remote-debugging-port=${port} --user-data-dir=/somewhere/else`] });
  const result = chrome.connect().then(() => null, (e: Error) => e);
  try {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(existsSync(pidFile), "the program was started");
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    up = true;
    const err = await result;
    assert.equal(err?.message, P.browserPortTaken(port));
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false, "the Chrome we spawned was killed");
  } finally {
    // 断言挂了也别让假程序（sleep 60）留着
    try { process.kill(Number(readFileSync(pidFile, "utf8").trim())); } catch { /* 已经没了，或没写出来 */ }
    server.closeAllConnections(); server.close();
  }
});
