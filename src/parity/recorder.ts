// 对照工具的记录器：场景里内核拿到的、系统往外做的每一件事按顺序记一条（n 编号、t 虚拟时间），
// 绝对路径换成 <WORK> / <TREE>，最后写成 transcript.jsonl（规范 JSON：键递归排序、没有空白、一行一条）。
// 键排了序，先后就不在记录里了：先后本身是内容的地方（工具的参数表、配置）另记一份（open 里的 paramOrder 这些、orderDigest）。
// 出错时也照写（写到哪算哪，最后一条是出错的 log），所以挂了的场景也留得下记录。
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { urlOf } from "./determinism.ts";

/** 这棵树的根（src/parity/ 往上两层）：记录里写成 <TREE>，两棵树的记录才比得了 */
export const TREE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Fields = Record<string, unknown>;

/** 记录的去处（Recorder 就是）：两道 JS 围栏（fence.ts、offline.ts）拦下一次先往这里记一条 */
export interface Sink { add(kind: string, fields: Fields): void }

/** call 记录里 threw 的写法：「错误名: 话」（不带调用栈）；抛的不是 Error 就照字符串写 */
export const thrown = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

/** 假 fetch 认得的地址给回答（JSON 正文）；不认得的给 undefined，fetch 就抛错 */
export type FetchAnswer = (url: string, body: unknown) => unknown;

/** 记录器自己填的三个字段：场景给的字段不许叫这几个名字（不然悄悄盖掉一个） */
const RESERVED = ["n", "t", "kind"] as const;

/**
 * 没换成记号的绝对路径（两段以上，前面不挨着字、数字和路径里的符号——换过的 <WORK>/… 前面挨着 >，不算）和 file: 地址。
 * log 的 error 那一行里的它们换成 <path>：两棵树、两台机器上不一样的只会是这种路径
 */
const STRAY_PATH = /(?<![\p{L}\p{N}_<>.:\/~-])(?:\/[^\s\/'"`()<>:,;]+){2,}\/?/gu;
const STRAY_FILE_URL = /file:\/\/(?!<)[^\s'"`()<>]+/g;

/**
 * 规范化：键排序（sort 关掉就照原来的先后）、对象里 undefined 的值写成 null（格式表的约定：没有的可选值写 null）、函数去掉
 * （数组里的 undefined、函数变 null，跟 JSON 一样）、二进制写成 base64。JSON 装不下的几样写成带记号的样子，不让它们悄悄变成 {}：
 * Map → {$map: [[键, 值]…]}、Set → {$set: […]}、正则 → {$regex: "/…/flags"}、Error → {$error: "错误名: 话"}。fix 改每个字符串
 */
function tidy(v: unknown, fix: (s: string) => string, sort = true): unknown {
  if (typeof v === "string") return fix(v);
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Uint8Array) return { $blob: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map((x) => (x === undefined || typeof x === "function" ? null : tidy(x, fix, sort)));
  if (v instanceof Map) return { $map: [...v].map(([k, x]) => [tidy(k, fix, sort) ?? null, tidy(x, fix, sort) ?? null]) };
  if (v instanceof Set) return { $set: [...v].map((x) => tidy(x, fix, sort) ?? null) };
  if (v instanceof RegExp) return { $regex: fix(String(v)) };
  if (v instanceof Error) return { $error: fix(thrown(v)) };
  const j = (v as { toJSON?: () => unknown }).toJSON;
  if (typeof j === "function") return tidy(j.call(v), fix, sort);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(v);
  for (const k of sort ? keys.sort() : keys) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === "function") continue;
    out[fix(k)] = x === undefined ? null : tidy(x, fix, sort);
  }
  return out;
}

/** fetch 的正文能记成什么：JSON 字符串解开、别的字符串原样、表单和查询串写成文字、二进制和 Blob 写成字节（规范化时成 $blob）；流读不到，只记它是什么 */
async function bodyOf(b: unknown): Promise<unknown> {
  if (b === undefined || b === null) return null;
  if (typeof b === "string") { try { return JSON.parse(b) as unknown; } catch { return b; } }
  if (b instanceof URLSearchParams) return b.toString();
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
  if (b instanceof FormData) return [...b.entries()].map(([k, v]) => [k, typeof v === "string" ? v : { file: v.name, size: v.size }]);
  return { $unrecorded: Object.prototype.toString.call(b) };
}

/** 规范 JSON：键递归排序、没有空白 */
export function canonical(v: unknown): string {
  return JSON.stringify(tidy(v, (s) => s));
}

export class Recorder implements Sink {
  private readonly lines: string[] = [];
  private readonly t0: number;
  private readonly now: () => number;
  /** [绝对路径, 记号]：长的在前（/private/var/… 先于 /var/…，套着的目录也是里面的先换） */
  private readonly swaps: Array<[string, string]>;

  /** roots：记号 → 绝对路径（{ "<WORK>": …, "<TREE>": … }）；真实路径（解开符号链接的）也一起换 */
  constructor(o: { t0: number; now: () => number; roots: Record<string, string> }) {
    this.t0 = o.t0;
    this.now = o.now;
    const swaps = new Map<string, string>();
    for (const [token, p] of Object.entries(o.roots)) {
      const abs = resolve(p);
      swaps.set(abs, token);
      if (existsSync(abs)) swaps.set(realpathSync(abs), token);
    }
    this.swaps = [...swaps].sort((a, b) => b[0].length - a[0].length);
  }

  get count(): number { return this.lines.length; }

  /** 一个字符串里的绝对路径换成记号 */
  private swap(s: string): string {
    return this.swaps.reduce((acc, [abs, token]) => acc.split(abs).join(token), s);
  }

  /** 路径换成记号、键排序（db、files 这些摘要先过一遍它再算 sha256，换了工作目录也一样） */
  normalize(v: unknown): unknown {
    return tidy(v, (s) => this.swap(s));
  }

  /**
   * 键的先后也算进去的摘要：路径换成记号、键不排序，照原来的先后 JSON.stringify 再 sha256。
   * 规范化排了键，先后不同的两份配置记出来一样；真系统是照原来的先后用的（拼进前缀、交给内核），所以配置那两条另带这个摘要
   */
  orderDigest(v: unknown): string {
    return createHash("sha256").update(JSON.stringify(tidy(v, (s) => this.swap(s), false)) ?? "").digest("hex");
  }

  /** 记一条：当场规范化成一行（之后对象再变也不影响这条）。字段不许叫 n、t、kind（记录器自己填） */
  add(kind: string, fields: Fields): void {
    for (const k of RESERVED) if (Object.hasOwn(fields, k)) throw new Error(`parity: a record field may not be named "${k}" (the recorder fills n, t and kind itself)`);
    this.lines.push(JSON.stringify(this.normalize({ ...fields, n: this.lines.length, t: this.now() - this.t0, kind })));
  }

  /**
   * 记一条 log：工具自己的话（parity: 开头；mod 不给就是 parity——挂了的场景是 error，各场景的条数小结是 info），
   * 或者树的 warn / error（mod 是那个 Logger 的名字）。日志带的数据只留 error 那一项的第一行（同一句话底下吞掉的是哪个错看得出来）：
   * 调用栈不要，没换成记号的绝对路径写成 <path>；没带 error 的写 null
   */
  log(level: string, msg: string, o: { mod?: string; error?: unknown } = {}): void {
    this.add("log", { level, mod: o.mod ?? "parity", msg, error: o.error === undefined ? null : this.errorLine(o.error) });
  }

  private errorLine(e: unknown): string {
    const text = e instanceof Error ? thrown(e) : typeof e === "string" ? e : JSON.stringify(tidy(e, (s) => s)) ?? String(e);
    return this.swap(text.split("\n", 1)[0]!).replace(STRAY_FILE_URL, "file://<path>").replace(STRAY_PATH, "<path>");
  }

  /**
   * 假的 fetch：每次都记一条 fetch——地址、方法、请求头（authorization 只记有，不记值）、正文（JSON 就解开，二进制记成 $blob）；
   * answer 认得的回 200 和它的回答，别的一律抛错
   */
  fetch(answer: FetchAnswer): typeof fetch {
    return async (input, init) => {
      const url = urlOf(input);
      const req = input instanceof Request ? input : null;
      const headers = new Headers(req?.headers);
      new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
      const shown: Record<string, string> = {};
      headers.forEach((v, k) => { shown[k] = k === "authorization" ? "<present>" : v; });
      const raw = init?.body !== undefined ? init.body : req?.body ? await req.clone().text() : null;
      const body = await bodyOf(raw);
      this.add("fetch", { url, method: (init?.method ?? req?.method ?? "GET").toUpperCase(), headers: shown, body });
      const reply = answer(url, body);
      if (reply === undefined) throw new Error(`parity: network is off (${url})`);
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    };
  }

  /** 写 transcript.jsonl：目录 0700、文件 0600（里面是她的原话） */
  write(file: string): void {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, this.lines.map((l) => `${l}\n`).join(""), { mode: 0o600 });
  }
}
