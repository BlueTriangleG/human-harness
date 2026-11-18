// 控制台的网页服务：只读，只听 127.0.0.1。这里只管守门（只认本机、只收 GET）、选语言、把结果写出去；
// 取数的接口一页一个文件，在 routes/ 下各自登记（地址和参数写在那里）：
//   GET /                        网页的骨架
//   GET /web/…                   网页的样式和脚本：只给 web.ts 名单里的那几个
//   GET /api/stream              中央记忆的直播（SSE，?after=）
//   routes/brain.ts              /api/central、/api/activity、/api/status、/api/workers、/api/worker、/api/log、/api/learn
//   routes/memory.ts             /api/memory、/api/memory/block、/api/memory/file
//   routes/prompt.ts             /api/prompt、/api/prompt/sessions
//   routes/events.ts             /api/event-memory 和它下面的 events、event、entities、people、person、quotes、batch、midterm
//   routes/gate.ts               /api/gate
//   routes/health.ts             /api/incidents、/api/numbers
//   routes/notebook.ts           /api/notebook
// 两处改过名（11-14）：/api/events → /api/central（它是中央记忆的一段，不是事件记忆），/api/mem… → /api/event-memory…（和 /api/memory 太像）。
// 旧地址照样能用（RENAMED），等确认没人再用了再拿掉。
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { events, maxSeq, openReadOnly } from "./data.ts";
import type { Limits } from "./memory.ts";
import type { RoleMarker } from "./prompt.ts";
import type { LearnOptions } from "./learn.ts";
import type { GateViewOptions } from "./gate.ts";
import type { WebAsset } from "./web.ts";
import type { MemoryPageConfig } from "../config.ts";
import { LANGS, defaultLang, langFromCookie, renderPage, translator, withClock, withLang } from "./lang/index.ts";
import type { PageMarks } from "./lang/index.ts";
import type { Key, Lang, Params, Translate } from "./lang/index.ts";
import { num } from "./routes/types.ts";
import type { Handler, Site } from "./routes/types.ts";
import { brainRoutes } from "./routes/brain.ts";
import { memoryRoutes } from "./routes/memory.ts";
import { promptRoutes } from "./routes/prompt.ts";
import { eventRoutes } from "./routes/events.ts";
import { gateRoutes } from "./routes/gate.ts";
import { healthRoutes } from "./routes/health.ts";
import { notebookRoutes } from "./routes/notebook.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { OPENAI_WRITES, openaiRoutes, openaiWrite, type OpenAIOptions } from "./routes/openai.ts";
import { summaryOf } from "./machine.ts";
import { machineRoutes } from "./routes/machine.ts";
import { request } from "../control.ts";
import { MAX_TELL, PAIR_CODE_MS, TELLS_PER_MINUTE, oldCookie, readJson, sameConsole, tokenMatches, tokenOf } from "./owner.ts";
import { createHash } from "node:crypto";
import type { Refusal, TellOptions } from "./owner.ts";
import type { Installed } from "../services/index.ts";

export { roleOf } from "./routes/prompt.ts";

/** 改过名的接口：旧地址 → 新地址 */
export const RENAMED: Readonly<Record<string, string>> = {
  "/api/events": "/api/central",
  "/api/mem": "/api/event-memory",
  ...Object.fromEntries(["events", "event", "entities", "people", "person", "quotes", "batch", "midterm"].map((n) => [`/api/mem/${n}`, `/api/event-memory/${n}`])),
};

export interface ConsoleOptions {
  dbPath: string;
  sockPath: string;
  /** folder where the helpers module keeps one <name>.json per helper session (helperSessionsDir); absent = this role has no helpers */
  helperSessionsDir?: string;
  projectsDir: string;
  logPath: string;
  /** what the page scripts recognise of the role's own text; goes to the page with its data */
  marks?: PageMarks;
  /** 骨架：里面的 {{…}} 按看的人选的语言换成字（见 lang/index.ts 的 renderPage） */
  pageHtml: string;
  /** 网页的样式和脚本：地址（/web/…）→ 内容。只给这张表里有的，不按请求里的路径读文件 */
  assets?: ReadonlyMap<string, WebAsset>;
  /** 记忆页要的：她的 workspace、hhd 的状态目录、阈值、前缀里的人格文件和运行说明 */
  memory?: {
    /** how the memory page sees the role's workspace (instance config console.memoryPage) */
    layout?: MemoryPageConfig;
    /** the folders of the nightly reports (instance config sleep.workDir) and of the skill manuals (skills.discover), relative to the workspace */
    sleepDir?: string; skillsDir?: string;
    workspace: string; stateDir: string; limits: Limits; files: readonly string[]; runtimeNote: string; night?: string; frame?: string; memoryFiles?: ReadonlySet<string>;
    /** 事件记忆的开关（config memory.events）：midterm 开着时中期视图在前缀里 */
    events?: { enabled: boolean; inject: boolean; midterm: boolean };
  };
  /** 完整输入页要的：她脑区会话 transcript 所在的目录、每种脑区开场白的开头 */
  prompt?: { dir: string; markers: readonly RoleMarker[] };
  /** 人物卡那一页要的：config memory.people.template 原样（没配就不开）和她的时区 */
  people?: { template: unknown; tz: string };
  /** 学习那一块要的（config learning + 她的时区）；shelf 开着时记忆页的前缀里也算上书架目录 */
  learning?: LearnOptions & { shelf: boolean; /** 书架的规矩文件（config learning.shelfFile）：笔记页分层时用 */ shelfFile?: string; /** file name of the resident list (config learning.residentFile): the notebook page needs it for layers */ residentFile: string };
  /** 下意识（闸门）那一页要的：她的工作区（认访客私聊的名单）、时区、每日小判断额度、老行估花费的 haiku 倍数 */
  gate?: GateViewOptions;
  /** 「顺不顺」那一页要的：她工作区的会话记录所在的目录（只看第一层）、HH 日志、她的时区。只读这些文件来数数，不留里面的字 */
  incidents?: { dir: string; logPath: string; tz: string; minIntervalMs?: number; /** hhd 的状态目录：修理的留痕在它的 repair/ 下，按每次上线分段要读；不给就不分段 */ stateDir?: string; /** 她线上的配置文件：只看它的修改时间（哪次重启之前改过） */ configPath?: string };
  /** 角色和主人叫什么：界面文字里的 {me}、{owner}（从配置来，不写在包里）。meLatin：角色名字的拉丁字母写法，有的话英文界面用它 */
  /** display names the instance gives for its own sources (gate page) and input channels (timeline), per interface language; a code without a name shows as the code */
  labels?: { source?: Record<string, Record<string, string>>; channel?: Record<string, Record<string, string>> };
  names?: { me: string; owner: string; /** third-person word for the role in the interface texts ({ta}); the role's name when absent */ ta?: string; meLatin?: string };
  /** 没选过语言的人看到哪个语言（不给就是 lang/index.ts 的 defaultLang） */
  lang?: Lang;
  /**
   * 「这一周」那张表要的：会话记录的总目录（~/.claude/projects，用量当量从这里数）、她的工作区和回放的目录（分去向）、时区。
   * cacheFile：用量读到哪了存在这个文件里（控制台自己的缓存，不是她的数据；放系统临时目录，不进她的状态目录）。不给就只记在内存里
   */
  numbers?: { projectsDir: string; workspace: string; replay: string[]; team?: string[]; tz: string; cacheFile?: string };
  /** 配置里开着哪几个脑区（id）：大脑图上「同时在做」画几条、有没有「慢慢想」照它来。不给就照默认的样子画 */
  regions?: readonly string[];
  /** the read-only command that lists the role's system permissions as JSON (routes/settings.ts); absent = the page says so */
  permissionsCheck?: readonly string[];
  /** the write ports (POST /api/tell, /api/pair; see owner.ts, talkOf); absent = read-only */
  tell?: TellOptions;
  /** settings → memory and learning: the role's OpenAI key (routes/openai.ts); its writes need the write ports (tell) too */
  openai?: OpenAIOptions;
  /** the role's id (/api/pair/status gives it, hh console --as names the token file by it) */
  role?: string;
  /** what the owner types to open this console with the talk pane ({cmd} in the page's texts) */
  command?: string;
  /** the role's app's own link to its page of system permissions (ai.hh.role.<id>://grants), when it has the app */
  grants?: string;
  /** this role's load guard status file (/api/load) */
  loadStatus?: string;
  /** /api/machine: where the roles on this computer are found (machine.ts), this console's own port and account, the heavy-job lock */
  machine?: { shared: string; jobs: () => Promise<Installed[]>; account: string; port: number; lockDir?: string };
  /** 演示模式：读的是造出来的演示库，页面角上标「演示数据」 */
  demo?: boolean;
  now?: () => number;
  pollMs?: number;
}

/** 带着包里一条字的报错：到了请求那一层再按看的人的语言出 */
class Told extends Error {
  key: Key;
  params: Params | undefined;
  constructor(key: Key, params?: Params) { super(key); this.key = key; this.params = params; }
}

/** 防 DNS rebinding：只认 127.0.0.1 / localhost 加本端口 */
export function hostAllowed(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(s);
}

export function createConsole(o: ConsoleOptions): Server {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? 800;
  let db: DatabaseSync | null = null;
  const getDb = (): DatabaseSync => {
    if (db) return db;
    if (!existsSync(o.dbPath)) throw new Told("api.noDb", { path: o.dbPath });
    db = openReadOnly(o.dbPath);
    return db;
  };
  const withDb = <T>(fn: (d: DatabaseSync) => T): T => {
    try { return fn(getDb()); } catch (e) {
      try { db?.close(); } catch { /* 已经关了 */ }
      db = null;
      throw e;
    }
  };
  const streams = new Set<ServerResponse>();
  // 各页的接口：地址 → 处理函数（地址都以 / 开头，不会撞上对象自带的属性；还是放进 Map 里查）
  const site: Site = { o, now, withDb };
  const routes = new Map<string, Handler>(Object.entries({
    ...brainRoutes(site), ...memoryRoutes(site), ...promptRoutes(site), ...eventRoutes(site), ...gateRoutes(site), ...healthRoutes(site), ...notebookRoutes(site), ...settingsRoutes(site), ...openaiRoutes(site), ...machineRoutes(site),
  }));
  // 骨架每个语言各出一份（启动时就出：骨架里写了包里没有的条目，起不来）
  const base: Params = { me: o.names?.me ?? "", owner: o.names?.owner ?? "", ta: o.names?.ta || o.names?.me || "", cmd: o.command ?? "", grants: o.grants ?? "" };
  // 英文界面：角色的名字有拉丁字母的写法就用它（汉字名字夹在英文句子里不好读）
  const bases: Record<Lang, Params> = { zh: base, en: o.names?.meLatin ? { ...base, me: o.names.meLatin } : base };
  const keyed = (prefix: string, m: Record<string, string> = {}): Array<[string, string]> => Object.entries(m).map(([k, v]) => [prefix + k, v]);
  const extra = (l: Lang): Record<string, string> => Object.fromEntries([...keyed("gate.source.", o.labels?.source?.[l]), ...keyed("timeline.channel.", o.labels?.channel?.[l])]);
  const shells = new Map<Lang, string>(LANGS.map((l) => [l, renderPage(o.pageHtml, l, bases[l], o.demo === true, o.regions ?? null, { strings: extra(l), ...(o.marks ? { marks: o.marks } : {}) })]));

  /** /api/summary from this console's own reads: its status, today's incidents, its load guard (machine.ts summaryOf) */
  const summary = async (tx: Translate, told: (e: unknown) => string): Promise<Record<string, unknown>> => {
    const ask = async (path: string): Promise<unknown> => {
      try { const r = await routes.get(path)?.({ q: new URLSearchParams(), tx, told }); return r && r.code === 200 ? r.body : null; } catch { return null; }
    };
    const [st, inc, load] = await Promise.all(["/api/status", "/api/incidents", "/api/load"].map(ask));
    return summaryOf(st, inc, load, now());
  };

  /** when the tells of the last minute were taken */
  const tellsAt: number[] = [];
  /** pairing codes left by hh console: the code's sha256 → the token it is traded for, and until when (owner.ts PAIR_CODE_MS) */
  const codes = new Map<string, { token: string; until: number }>();
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  /** A write: checks 2–5 (owner.ts), then a pairing code left or traded, or the tell itself */
  const write = async (t: TellOptions, req: IncomingMessage, res: ServerResponse, path: string, port: number, tx: Translate, told: (e: unknown) => string): Promise<void> => {
    const refuse = (check: Refusal): void => json(res, 403, { error: tx(`api.refused.${check}`), check });
    const bad = sameConsole(req, port);
    if (bad) { req.resume(); refuse(bad); return; }
    const body = await readJson(req);
    if (!body) { json(res, 400, { error: tx("api.badBody") }); return; }
    if (path === "/api/pair/code") {
      // a code for a token: only from whoever could put that token in the owner's file (the owner's hh console)
      const token = typeof body.token === "string" ? body.token : undefined;
      const code = typeof body.code === "string" && /^[0-9a-f]{32,}$/.test(body.code) ? body.code : undefined;
      if (!code || !tokenMatches(t.tokenFile, token, t.guard)) { refuse("token"); return; }
      for (const [k, c] of codes) if (c.until <= now()) codes.delete(k);
      codes.set(sha(code), { token: token!, until: now() + PAIR_CODE_MS });
      json(res, 200, { ok: true });
      return;
    }
    if (path === "/api/pair") {
      // a code is traded once, in time, for a token still in the owner's file; the page keeps the token in this origin's storage
      const key = sha(typeof body.code === "string" ? body.code : "");
      const c = codes.get(key);
      codes.delete(key);
      if (!c || c.until <= now() || !tokenMatches(t.tokenFile, c.token, t.guard)) { refuse("token"); return; }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "set-cookie": oldCookie(t.roleId) });
      res.end(JSON.stringify({ ok: true, token: c.token }));
      return;
    }
    if (!tokenMatches(t.tokenFile, tokenOf(req), t.guard)) { refuse("token"); return; }
    if (o.openai && OPENAI_WRITES.includes(path)) { const r = await openaiWrite(o.openai, path, body, tx); json(res, r.code, r.body); return; }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > MAX_TELL) { json(res, 400, { error: tx("api.tellText", { max: MAX_TELL }) }); return; }
    // while the role is at work a tell goes in all the same: hhd shows it after the role's next tool call, or holds it for the turn's end
    while (tellsAt.length && tellsAt[0]! <= now() - 60_000) tellsAt.shift();
    if (tellsAt.length >= TELLS_PER_MINUTE) { json(res, 429, { error: tx("api.tellTooMany", { n: TELLS_PER_MINUTE }) }); return; }
    tellsAt.push(now());
    try {
      // what `hh tell --from <owner> <text>` sends (cli-parse.ts), and here: the reply comes back to the console
      const result = await request(o.sockPath, { cmd: "tell", from: t.owner, text, here: true });
      json(res, 200, { ok: true, result });
    } catch (e) {
      json(res, 502, { error: told(e) });
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    // 看的人选的语言（页面上切，记在 cookie 里）；没选过就是默认的
    const lang = langFromCookie(req.headers.cookie) ?? o.lang ?? defaultLang();
    const tx = translator(lang, bases[lang]);
    const told = (e: unknown): string => e instanceof Told ? tx(e.key, e.params) : e instanceof Error ? e.message : String(e);
    if (!hostAllowed(req.headers.host, port)) { json(res, 403, { error: tx("api.hostOnly") }); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (req.method === "POST" && o.tell && ["/api/tell", "/api/pair", "/api/pair/code", ...(o.openai ? OPENAI_WRITES : [])].includes(url.pathname)) {
      write(o.tell, req, res, url.pathname, port, tx, told).catch((e: unknown) => json(res, 500, { error: told(e) }));
      return;
    }
    if (req.method !== "GET") { json(res, 405, { error: tx("api.readOnly") }); return; }
    const q = url.searchParams;
    // 取数的模块放进数据里的标签（段名、区名、截短的记号）跟着这个请求的语言
    withLang(tx, () => {
      try {
        if (url.pathname === "/api/pair/status") {
          // from: whose tells the talk pane draws as the owner's (the name hh tell speaks as)
          // token: whether one is asked (hh console makes it before opening the page)
          if (o.tell) res.setHeader("set-cookie", oldCookie(o.tell.roleId));
          json(res, 200, { enabled: o.tell !== undefined, token: o.tell ? o.tell.tokenFile !== null : false, paired: o.tell ? tokenMatches(o.tell.tokenFile, tokenOf(req), o.tell.guard) : false, from: o.tell?.owner ?? null, ...(o.role ? { role: o.role } : {}), ...(o.names?.me ? { name: o.names.me } : {}) });
          return;
        }
        // the one read anyone gets: how the role is, never what about; the other consoles on this computer ask it for /machine
        if (url.pathname === "/api/summary") {
          summary(tx, told).then((b) => json(res, 200, b), (e: unknown) => json(res, 500, { error: told(e) }));
          return;
        }
        // every other read is the owner's, by the token the writes take (owner.ts, check 4): a console's data is the role's
        // memory and its guests' words, and any process of any account on this computer reaches 127.0.0.1. The demo's is made up
        if (url.pathname.startsWith("/api/") && o.demo !== true && !(o.tell && tokenMatches(o.tell.tokenFile, tokenOf(req), o.tell.guard))) {
          json(res, 403, { error: tx("api.refused.token"), check: "token" });
          return;
        }
        // /pair is the page itself: its script reads the token after the # (never sent to the server in the address) and posts it
        if (url.pathname === "/" || url.pathname === "/pair") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            // 脚本全在 /web/ 下的文件里，页面里没有内联脚本；样式还有写在标签上的（style="--lane: …"），所以 style-src 留着 unsafe-inline.
            // frame-ancestors: framed only by itself or another console here (this computer's page frames a role's console). Not
            // narrowed to the consoles whose ports check out (machine.ts): a header cannot follow roles coming and going, and a
            // framing page gets nothing from the frame but what it shows (the token is the frame's origin's alone)
            "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; frame-ancestors 'self' http://127.0.0.1:*",
          });
          // 钟是外面给的（演示库把钟定在一个时刻）：告诉页面，让它按这个钟算「多久以前」；线上不给，页面用浏览器的钟
          res.end(o.now ? withClock(shells.get(lang)!, now()) : shells.get(lang));
          return;
        }
        if (url.pathname === "/api/stream") {
          let cursor = num(q.get("after")) ?? withDb(maxSeq);
          res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
          res.write(`retry: 2000\n\n`);
          streams.add(res);
          let beat = 0;
          const tick = setInterval(() => {
            try {
              const rows = withDb((d) => events(d, { after: cursor, limit: 500 }));
              if (rows.length) {
                cursor = rows[rows.length - 1]!.seq;
                res.write(`event: rows\ndata: ${JSON.stringify(rows)}\n\n`);
              } else if (++beat * pollMs >= 15_000) {
                beat = 0;
                res.write(`: alive\n\n`);
              }
            } catch (e) {
              res.write(`event: problem\ndata: ${JSON.stringify(told(e))}\n\n`);
            }
          }, pollMs);
          const end = () => { clearInterval(tick); streams.delete(res); };
          req.on("close", end);
          res.on("error", end);
          return;
        }
        const handler = routes.get(RENAMED[url.pathname] ?? url.pathname);
        if (handler) {
          const r = handler({ q, tx, told });
          if (r instanceof Promise) r.then((x) => json(res, x.code, x.body), (e: unknown) => json(res, 500, { error: told(e) }));
          else json(res, r.code, r.body);
          return;
        }
        const a = o.assets?.get(url.pathname);
        if (!a) { json(res, 404, { error: tx("api.notFound") }); return; }
        res.writeHead(200, { "content-type": a.type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
        res.end(a.body);
      } catch (e) {
        json(res, 500, { error: told(e) });
      }
    });
  });
  server.on("close", () => {
    for (const s of streams) s.end();
    streams.clear();
    try { db?.close(); } catch { /* 已经关了 */ }
    db = null;
  });
  return server;
}
