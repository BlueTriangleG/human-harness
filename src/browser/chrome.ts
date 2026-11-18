// 她自己的 Chrome：HH 直接开、直接连。
// 以前每一步都起一次 openclaw browser 命令行（4–6 秒、三四百兆内存，不要走 OpenClaw）。
// 还是原来那份用户资料（B站、小红书的登录都在里面）和原来的调试端口：以前开着的那个 Chrome 也能直接接上。
// Chrome 单独成一个进程组，hhd 重启它不跟着关。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { P } from "../lang/index.ts";
import { B } from "../lang/index.ts";

export interface ChromeOptions {
  chrome: string;
  userDataDir: string;
  /** Debug port; every role sets its own in its instance config (the framework has no default: two roles on one port would drive each other's browser) */
  port?: number;
  /** 截图存哪 */
  shotsDir: string;
  /** what the browser tool's description says is signed in here, in the role's language (config browser.logins) */
  logins?: string;
  /** 测试用：不弹窗口 */
  headless?: boolean;
  /** 测试用：这台机器上所有进程的命令行（默认 /bin/ps）；读不出来就抛，或给空的 */
  listProcs?: () => Promise<string[]>;
}

/** 这个端口上开着的是谁：没人 / 是这个角色自己的 Chrome / 别人的 / 进程表读不出来 */
export interface Holder { state: "free" | "ours" | "other" | "unknown" }

/**
 * 默认的进程表：/bin/ps 的命令行（绝对路径、不经 shell、5 秒超时）。命令行跨系统用户都看得到，监听端口的归属看不到，所以查命令行不查 lsof。
 * 超时、退出码不是 0 都算读不出来（抛），不会变成一张空表被当成「没有别人」
 */
export const psLines = (): Promise<string[]> => new Promise((done, fail) => {
  // LC_ALL：launchd 起的进程没有 LANG，macOS 的 ps 会把命令行里非 ASCII 的字节打成 vis 形式（M-iM^X…），资料目录带中文的角色自己的 Chrome 就认不出；
  // -ww：不截断（不管平台和 COLUMNS）
  execFile("/bin/ps", ["-axww", "-o", "command="], { timeout: 5000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: "en_US.UTF-8" } }, (err, out) => {
    if (err) fail(err);
    else done(String(out).split("\n"));
  });
});

/** 命令行里有没有这个参数：整个参数（前面是行首或空格），后面 tail 认可 */
function hasArg(line: string, arg: string, tail: (rest: string) => boolean): boolean {
  for (let i = line.indexOf(arg); i >= 0; i = line.indexOf(arg, i + 1)) {
    if ((i === 0 || line[i - 1] === " ") && tail(line.slice(i + arg.length))) return true;
  }
  return false;
}

/** 跟 OpenClaw 开它时一样的参数（同一份用户资料，别让 Chrome 觉得换了人） */
const FLAGS = [
  "--no-first-run", "--no-default-browser-check", "--disable-sync", "--disable-background-networking",
  "--disable-component-update", "--disable-features=Translate,MediaRouter", "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble", "--password-store=basic", "--no-proxy-server",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Chrome {
  private conn: Browser | null = null;
  private connecting: Promise<Browser> | null = null;
  /** 每份心思各自看着哪个标签页（同时在做的两件事别抢同一页） */
  private readonly current = new Map<string, Page>();
  private readonly lastUsed = new Map<string, number>();   // 每份心思上次用浏览器的时间（关之前看看别人还在不在用）
  private readonly ids = new WeakMap<Page, string>();
  private nextId = 1;
  readonly o: ChromeOptions;

  constructor(o: ChromeOptions) {
    this.o = o;
  }

  private get port(): number {
    if (!this.o.port) throw new Error("config: browser.port is not set — give this role its own debug port in its instance config");
    return this.o.port;
  }

  private get endpoint(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** 调试端口有没有在应（Chrome 开着没有） */
  async running(): Promise<boolean> {
    try {
      return (await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(1500) })).ok;
    } catch {
      return false;
    }
  }

  private async launch(headless: boolean): Promise<ChildProcess> {
    // 配置里没有浏览器程序（回放的子进程就是这样）：一句话说清，不去 spawn 一个空程序名（那样报的是看不懂的参数错误）
    if (this.o.chrome.trim() === "") throw new Error(P.BROWSER_OFF);
    mkdirSync(this.o.userDataDir, { recursive: true });
    const child = spawn(this.o.chrome, [
      `--remote-debugging-port=${this.port}`, `--user-data-dir=${this.o.userDataDir}`, ...FLAGS,
      ...(headless ? ["--headless=new"] : []), "about:blank",
    ], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    for (let i = 0; i < 80; i++) {
      if (await this.running()) return child;
      await sleep(250);
    }
    throw new Error(B.chrome.launchTimeout);
  }

  /** 这个角色的用户资料目录的几种写法：配置里的、resolve 过的、解开链接的（目录在的话） */
  private dirForms(): string[] {
    const forms = new Set([this.o.userDataDir, resolve(this.o.userDataDir)]);
    try { forms.add(realpathSync(resolve(this.o.userDataDir))); } catch { /* 目录还没有 */ }
    return [...forms];
  }

  /**
   * 调试端口上应着的是不是这个角色自己的 Chrome：端口没人应 = free；进程表读不出来 = unknown；
   * 命令行里带整个参数 --remote-debugging-port=<端口>（后面是空格或行尾）的，有一行同时带整个参数 --user-data-dir=<这个角色的目录>
   * （后面是行尾或空格加 --）= ours；其余（别的资料占着，或看得见的进程里没有谁带这个端口）= other。
   * 不从行里把参数值剥出来：ps 不加引号，资料目录可以带空格，所以只问「这一整段在不在」
   */
  async holder(): Promise<Holder> {
    if (!(await this.running())) return { state: "free" };
    let lines: string[];
    try {
      lines = (await (this.o.listProcs ?? psLines)()).filter((l) => l.trim() !== "");
    } catch {
      return { state: "unknown" };
    }
    if (lines.length === 0) return { state: "unknown" };
    const port = `--remote-debugging-port=${this.port}`;
    const dirs = this.dirForms().map((d) => `--user-data-dir=${d}`);
    for (const line of lines) {
      if (!hasArg(line, port, (rest) => rest === "" || rest.startsWith(" "))) continue;
      if (dirs.some((d) => hasArg(line, d, (rest) => rest === "" || rest.startsWith(" --")))) return { state: "ours" };
    }
    return { state: "other" };
  }

  /** 碰调试端口（/json/version 以外）之前问一次：别人的浏览器就不连；看不清（进程表读不出来）放行，不能因为看不清就把健康的浏览器断了 */
  private async guard(): Promise<void> {
    if ((await this.holder()).state === "other") throw new Error(P.browserPortTaken(this.port));
  }

  /** 连上（没开就先开）；返回它是不是这次才开的 */
  async connect(o: { headless?: boolean } = {}): Promise<{ context: BrowserContext; started: boolean }> {
    let started = false;
    if (!this.conn?.isConnected()) {
      this.connecting ??= (async () => {
        let spawned: ChildProcess | null = null;
        if (!(await this.running())) {
          spawned = await this.launch(o.headless ?? this.o.headless ?? false);
          started = true;
        }
        // 开完以后、碰端口之前再问一次（我们开的应该是 ours；开的时候别的 Chrome 抢了端口也在这里拦下）。每次新连接问一次，不是每次工具调用
        try {
          await this.guard();
        } catch (e) {
          // 刚开的这个 Chrome 用着这个角色的资料、又没人拿着它：端口被别人抢了，别留着（尽力杀，杀不掉不改报的错）
          if (spawned) try { spawned.kill(); } catch { /* 随它 */ }
          throw e;
        }
        await this.ensureWindow();
        const b = await chromium.connectOverCDP(this.endpoint, { timeout: 15_000 });
        b.on("disconnected", () => {
          if (this.conn === b) this.conn = null;
          this.current.clear();
        });
        return b;
      })().finally(() => { this.connecting = null; });
      this.conn = await this.connecting;
    }
    const context = this.conn.contexts()[0] ?? await this.conn.newContext();
    return { context, started };
  }

  /**
   * Mac 上关掉最后一个窗口 Chrome 不退出，但用户资料也卸了：这时连上去会报
   * "Browser context management is not supported"（11-01 线上：她的 Chrome 开了 20 小时，一个标签页都没有）。
   * 一个页面都没有就先开个空白页，资料就加载回来了。
   */
  private async ensureWindow(): Promise<void> {
    try {
      const list = await (await fetch(`${this.endpoint}/json/list`, { signal: AbortSignal.timeout(3000) })).json() as Array<{ type?: string }>;
      if (list.some((t) => t.type === "page")) return;
      await fetch(`${this.endpoint}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) });
    } catch {
      /* 看不清就照常连，连不上再报 */
    }
  }

  idOf(p: Page): string {
    let id = this.ids.get(p);
    if (!id) {
      id = `t${this.nextId++}`;
      this.ids.set(p, id);
    }
    return id;
  }

  async pages(): Promise<Page[]> {
    const { context } = await this.connect();
    return context.pages().filter((p) => !p.isClosed());
  }

  /**
   * 这份心思现在看着的标签页：指定了就换过去；没有就接着用上次的；
   * 都没有就拿一个别的心思没在用的（以前拿最后一个，常常正是另一份心思刚开的那页），没有空着的就开个新的
   */
  async page(who: string, tab?: string): Promise<Page> {
    const { context } = await this.connect();
    const open = context.pages().filter((p) => !p.isClosed());
    this.lastUsed.set(who, Date.now());
    if (tab) {
      const p = open.find((x) => this.idOf(x) === tab);
      if (!p) throw new Error(B.chrome.tabNotFound(tab));
      this.current.set(who, p);
      return p;
    }
    const cur = this.currentOf(who);
    if (cur) return cur;
    const taken = new Set([...this.current].filter(([w]) => w !== who).map(([, p]) => p));
    const p = [...open].reverse().find((x) => !taken.has(x)) ?? await context.newPage();
    this.current.set(who, p);
    return p;
  }

  /** 这份心思现在看着的那页（只看，不认领） */
  currentOf(who: string): Page | null {
    const p = this.current.get(who);
    return p && !p.isClosed() ? p : null;
  }

  /** 最近（10 分钟内）还在用浏览器的别的心思，和它们看着的那页 */
  othersUsing(who: string): Array<{ who: string; page: Page }> {
    return [...this.current]
      .filter(([w, p]) => w !== who && !p.isClosed() && Date.now() - (this.lastUsed.get(w) ?? 0) < 10 * 60_000)
      .map(([w, page]) => ({ who: w, page }));
  }

  async newPage(who: string): Promise<Page> {
    const { context } = await this.connect();
    const p = await context.newPage();
    this.current.set(who, p);
    this.lastUsed.set(who, Date.now());
    return p;
  }

  /** 整个关掉（腾内存）；本来就没开返回 false */
  async stop(): Promise<boolean> {
    if (!(await this.running())) return false;
    const { context } = await this.connect();
    const s = await context.browser()!.newBrowserCDPSession();
    await s.send("Browser.close").catch(() => {});
    this.conn = null;
    this.current.clear();
    this.lastUsed.clear();
    for (let i = 0; i < 40 && await this.running(); i++) await sleep(250);
    return true;
  }

  /**
   * 拿某个网站的 cookie（B站 插件同步登录用）：先打开一下那个网站让它自己续期，再关掉那个标签页。
   * 浏览器本来没开就临时无头开一下，用完关掉。
   */
  async cookies(url: string): Promise<Array<{ name: string; value: string; domain: string; path: string; expires: number }>> {
    const { context, started } = await this.connect({ headless: true });
    try {
      const p = await context.newPage();
      try {
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
        await sleep(3000);
        return await context.cookies(url);
      } finally {
        await p.close().catch(() => {});
      }
    } finally {
      if (started) await this.stop();
    }
  }

  shotPath(ext: string): string {
    mkdirSync(this.o.shotsDir, { recursive: true });
    return join(this.o.shotsDir, `web-${Date.now()}.${ext}`);
  }
}

/**
 * 她写的 JS 变成能直接在页面里跑的一段：函数（`() => …`）就调用它，表达式就取它的值，
 * 几句语句就包成函数体跑（要结果得自己写 return）。只在页面里跑一次，不会把有副作用的话跑两遍。
 */
export function evalSource(js: string): string {
  try {
    new Function(`return (${js}\n)`);
  } catch {
    return `(async () => {${js}\n})()`;
  }
  return `(async () => { const v = (${js}\n); return typeof v === "function" ? await v() : await v; })()`;
}
