// 对照工具的 JS 围栏。边界不在这里：场景子进程套在内核沙箱里跑（sandbox.ts），草稿区（--work、--out）外面写不了、网出不去、信号发不给别的进程，
// 文件和网络上那一层才拦得全（它也有管不到的：经 Mach / XPC 找系统服务代办的事，要原生代码或 exec 出去的帮手才走得到）；包函数的围栏包不全。
// 这个文件做的是早一步的拒绝：最要紧的那类错——默认路径错一个，落在她的真数据上——在碰到文件之前就拦下，
// 话说得清楚（哪条路径、为什么），先记一条 refused 再抛错，树里把错吞了也留得下痕迹。
// 起来先把要碰的路径查一遍（assertOffLive、assertNoLiveMention），再把 node:fs 按路径读写的函数包一层（installFence）：
// 真 home 里的写、删、挪、拷出、硬链出，快照的 home 里的读，草稿区外面的写、从外面硬链进来、往外面指的符号链接
// （克隆快照时照抄的链接不算，那是 clone.ts 的事）；
// 外加进程级的几样：换当前目录、给别的进程发信号、开 Worker、module.register。
// 还有一件不是拦的事：给了虚拟时钟（opts.now）时，树在草稿区里写成一个文件，就把它的修改时间改成虚拟的「现在」（STAMPED）——
// 时钟是虚拟的，文件时间却是真的，树拿两者相减（笔记本「刚改过先别动」）就永远算不对。
// 不管的（都交给内核沙箱）：原生的写（node:sqlite、报告和堆快照、编译缓存、原生扩展）、cp 顺着目的地里已有的符号链接写出去、按描述符写内容；
// process.binding、选项对象上的 getter、抢在检查和调用之间换链接这类故意绕的。
// 路径包含关系只在这里写一份（isWithin、contained、overlap），main.ts、world.ts 都用这里的。
import fs from "node:fs";
import nodeModule, { syncBuiltinESMExports } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import workerThreads from "node:worker_threads";
import type { Sink } from "./recorder.ts";

const SECRETS = "secrets.json";
/** 没包过的 utimesSync（这个文件一加载就记下）：写完以后改文件时间用它，不过围栏、不留记录 */
const utimesAsIs = fs.utimesSync;
/** 这个进程真的 pid（模块一加载就记下：场景子进程里 determinism.ts 之后会把 process.pid 换成固定的号） */
const OWN_PID = process.pid;
/**
 * darwin 的卷（APFS）默认不分大小写：守真 home 时比路径不分大小写（/A/Home 就是 /a/home）。
 * 碰上分大小写的卷会多拦一些（大小写不同的别的目录也被当成真 home），宁可多拦
 */
const FOLD = process.platform === "darwin";

const liveRefusal = (p: string): Error => new Error(`parity: refusing to touch the live home (${p})`);
const scratchRefusal = (p: string): Error => new Error(`parity: refusing to write outside the scratch area (${p})`);
const linkRefusal = (p: string): Error => new Error(`parity: refusing to hard-link a file from outside the scratch area (${p})`);
const symlinkRefusal = (p: string): Error => new Error(`parity: refusing to symlink to a target outside the scratch area (${p})`);

/**
 * 要守的 home：快照里写的那个（manifest.home），加上跑这个进程的系统用户自己的 home（用户表里的，不看 HOME，HOME 换成了工作副本）。
 * 测试里快照的 home 是假的，配置里漏改的默认路径（指向这个用户的真目录）也拦得下
 */
export function fencedHomes(manifestHome: string): string[] {
  const own = userHome();
  return own ? [manifestHome, own] : [manifestHome];
}

/** 跑这个进程的系统用户自己的 home（用户表里的，不看 HOME）；用户表里没有就是 null */
export function userHome(): string | null {
  try { return userInfo().homedir || null; } catch { return null; }
}

/** 解开符号链接后的真实路径：最近一个存在的上级 realpath 再接上剩下的；链接坏了（指向还不存在的地方）照它指的算 */
function realish(p: string, depth = 0): string {
  try { return fs.realpathSync(p); } catch { /* 不存在，往下看 */ }
  try {
    if (depth < 40 && fs.lstatSync(p).isSymbolicLink()) return realish(resolve(dirname(p), fs.readlinkSync(p)), depth + 1);
  } catch { /* 连链接都不是 */ }
  const parent = dirname(p);
  return parent === p ? p : join(realish(parent, depth), basename(p));
}

/** 一个路径的两种样子：resolve 出来的、解开链接的 */
const forms = (p: string): [string, string] => { const abs = resolve(p); return [abs, realish(abs)]; };

/** p 是 root 本身或在它下面（只比字面）；fold = 不分大小写 */
export function isWithin(p: string, root: string, fold = false): boolean {
  const [a, r] = fold ? [p.toLowerCase(), root.toLowerCase()] : [p, root];
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** 草稿区这边：字面上、解开链接后都在 root 里才算（分大小写：拿不准就不算在里面，宁可多拦） */
export function contained(p: string, root: string): boolean {
  const [pa, pr] = forms(p);
  const [ra, rr] = forms(root);
  return isWithin(pa, ra) && isWithin(pr, rr);
}

/** 两个目录是同一个、或者一个在另一个里面（任一种样子，不分大小写） */
export function overlap(a: string, b: string): boolean {
  return forms(a).some((x) => forms(b).some((y) => isWithin(x, y, FOLD) || isWithin(y, x, FOLD)));
}

function rootsOf(liveHome: string | readonly string[]): string[] {
  const homes = typeof liveHome === "string" ? [liveHome] : liveHome;
  return [...new Set(homes.flatMap((h) => forms(h)))];
}

/** 在真 home 里（两种样子有一种落在任一个根里） */
const under = (p: string, roots: readonly string[]): boolean => forms(p).some((c) => roots.some((r) => isWithin(c, r, FOLD)));
/** 真 home 在它里面（删、挪一个上级目录也是碰了真 home） */
const holds = (p: string, roots: readonly string[]): boolean => forms(p).some((c) => roots.some((r) => isWithin(r, c, FOLD)));

/** 这些路径有一个（解开符号链接后）是真 home 或在它下面就抛错 */
export function assertOffLive(paths: Iterable<string>, liveHome: string | readonly string[]): void {
  const roots = rootsOf(liveHome);
  for (const p of paths) if (under(p, roots)) throw liveRefusal(p);
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 路径里的字：真 home 前后挨着它们就是别的路径（/a/home2、/x/a/home），不算提到 */
const PATH_CHAR = "[\\p{L}\\p{N}_.~@+-]";

/** 字符串里哪儿提到真 home 都不行（不只开头：--x=<home>/…、PATH 那种冒号串起来的），抛错时写出这个字符串 */
export function assertNoLiveMention(values: Iterable<string>, liveHome: string | readonly string[]): void {
  const res = rootsOf(liveHome).map((r) => new RegExp(`(?<!${PATH_CHAR})${escapeRe(r)}(?!${PATH_CHAR})`, FOLD ? "iu" : "u"));
  for (const v of values) if (res.some((re) => re.test(v))) throw liveRefusal(v);
}

/** fs 调用里的路径参数：字符串、file: URL、Buffer；文件描述符、FileHandle 不算（它们是 open 出来的，open 已经查过） */
function pathOf(t: unknown): string | null {
  if (typeof t === "string") return t;
  if (t instanceof URL) return t.protocol === "file:" ? fileURLToPath(t) : null;
  if (Buffer.isBuffer(t)) return t.toString();
  return null;
}

/** open 的 flags：字符串或数字；那个位置是函数（回调式 fs.open(path, cb)）或没给，就是默认的 "r" */
const flagsOf = (a: unknown): string | number => (typeof a === "string" || typeof a === "number" ? a : "r");

/** readFile、createReadStream 这类的选项里的 flag / flags（选项是字符串就是编码，没有 flag）；没给就是 "r" */
const optionFlags = (o: unknown, key: "flag" | "flags"): string | number =>
  (o && typeof o === "object" ? flagsOf((o as Record<string, unknown>)[key]) : "r");

/** open 的 flags 能不能写：w / a / + 带一个就算；数字的看写、追加、新建、截断几位 */
function canWrite(flags: string | number): boolean {
  const c = fs.constants;
  if (typeof flags === "number") return (flags & (c.O_WRONLY | c.O_RDWR | c.O_APPEND | c.O_CREAT | c.O_TRUNC)) !== 0;
  return /[wa+]/.test(flags);
}

/** 按路径动文件、读文件的函数（同步 xxxSync、回调、fs.promises 三种写法里有哪种包哪种） */
const PATH_FNS = [
  "writeFile", "appendFile", "mkdir", "mkdtemp", "mkdtempDisposable", "truncate", "unlink", "rm", "rmdir", "rename",
  "copyFile", "cp", "symlink", "link", "chmod", "lchmod", "chown", "lchown", "utimes", "lutimes",
  "open", "readFile", "openAsBlob", "readdir", "opendir",
] as const;
/**
 * 写成以后把目标文件的时间改成虚拟的「现在」的那几族（同步、回调、promise 三种写法都算）：函数名 → 目标路径是第几个参数。
 * 只改草稿区里的普通文件。管不到的：流（createWriteStream）、按描述符写的（fs.write、FileHandle.write，writeFile / appendFile 给的是描述符时也是）、
 * 原生的写（node:sqlite 的库和它的 backup、cp 整个目录时里面的文件）——这些文件的时间还是真的
 */
const STAMPED: Partial<Record<(typeof PATH_FNS)[number], number>> = { writeFile: 0, appendFile: 0, truncate: 0, copyFile: 1, rename: 1, cp: 1 };
/** 流：create* 是函数，其余是类（能 new 也能直接调） */
const STREAMS = ["createWriteStream", "createReadStream", "WriteStream", "FileWriteStream", "ReadStream", "FileReadStream", "Utf8Stream"] as const;
/**
 * 按描述符改权限、属主、时间的：只读打开的描述符也改得动（守着的那层 home 里照样能只读打开），又看不出描述符指着谁——一律拦，
 * 不管描述符是哪来的（树里没人用；哪天有人用了，拦下来、留了记录，再教围栏认草稿区里的描述符）。FileHandle 的同名方法一样
 */
const FD_META_FNS = ["fchmod", "fchmodSync", "fchown", "fchownSync", "futimes", "futimesSync"] as const;
const HANDLE_META_FNS = ["chmod", "chown", "utimes"] as const;

/** fs / fs.promises 上包了的名字（照这个 Node 真有的算） */
export function fencedNames(): { fs: string[]; promises: string[] } {
  const f = fs as unknown as Record<string, unknown>;
  const fp = fs.promises as unknown as Record<string, unknown>;
  return {
    fs: [...PATH_FNS.flatMap((n) => [n, `${n}Sync`]), ...STREAMS, ...FD_META_FNS].filter((n) => typeof f[n] === "function"),
    promises: PATH_FNS.filter((n) => typeof fp[n] === "function"),
  };
}

/**
 * 不包的：只看元数据的、按文件描述符读写的、类和内部的。按描述符写内容的（write、writev、ftruncate）由系统按 open 的模式管：
 * 能写的 open 已经查过目标了。测试把 fs、fs.promises 导出的函数挨个对一遍：每个不是包了就得在这里，Node 加了新函数测试就挂，逼着归一下类
 */
export const UNFENCED_FS: readonly string[] = [
  "access", "accessSync", "exists", "existsSync", "stat", "statSync", "lstat", "lstatSync", "statfs", "statfsSync",
  "readlink", "readlinkSync", "realpath", "realpathSync", "glob", "globSync", "watch", "watchFile", "unwatchFile",
  "read", "readSync", "readv", "readvSync", "fstat", "fstatSync", "write", "writeSync", "writev", "writevSync",
  "ftruncate", "ftruncateSync", "fsync", "fsyncSync", "fdatasync", "fdatasyncSync", "close", "closeSync",
  "Dir", "Dirent", "Stats", "_toUnixTimestamp",
];
export const UNFENCED_PROMISES: readonly string[] = ["access", "stat", "lstat", "statfs", "readlink", "realpath", "glob", "watch"];

export interface FenceOpts {
  /** 写、删、挪的目标还必须在这些目录里（场景子进程给 --work、--out）；硬链接的来源、符号链接的目标解开后也得在里面 */
  scratch?: readonly string[];
  /**
   * 也要守、但读照常的 home（跑这个进程的系统用户的；它和快照的 home 不是同一个时）：不许写、删、挪、链出、拷出，不许读 secrets.json。
   * 读得放开：Node 加载模块走的就是 fs.readFileSync，依赖装在这个 home 下面时（比如镜像目录的 node_modules 链过去）一读就拦，树都加载不起来
   */
  guarded?: readonly string[];
  /** 拦下的每一次先记 refused {api, path}，再抛错：树里吞掉错误的写也留得下痕迹 */
  sink?: Sink;
  /** 虚拟时钟的「现在」（毫秒）。给了就在 STAMPED 那几族写成以后，把草稿区里的目标文件的访问、修改时间改成它 */
  now?: () => number;
}

type Check = (args: unknown[], api: string) => void;

/**
 * 包上：同步、回调的当场抛，promise 的拒掉；类（WriteStream 这些）new 和直接调都查。包完 syncBuiltinESMExports，具名 import 的也换上。
 * liveHome（快照的 home）里的东西一律不读不写：open 不管什么 flags、readFile、readdir、opendir、读流都拦；
 * guarded 的 home 照常能读（只读打开也行），所以按描述符改元数据的一律拦（FD_META_FNS）。
 * process.chdir、new Worker、module.register 一律拦，process.kill 只许发给自己（都记 refused，path 写目录 / 文件 / <pid N>）。
 * 返回拆掉的函数（只给测试用）
 */
export function installFence(liveHome: string | readonly string[], opts: FenceOpts = {}): () => void {
  const live = rootsOf(liveHome);
  const guard = [...new Set([...live, ...rootsOf(opts.guarded ?? [])])];
  const scratch = opts.scratch?.map((s) => resolve(s)) ?? null;
  const refuse = (api: string, p: string, e: Error): never => {
    opts.sink?.add("refused", { api, path: p });
    throw e;
  };
  // 先看真 home（自己那句话），再看草稿区
  const target = (api: string, p: string, destructive: boolean): void => {
    if (under(p, guard) || (destructive && holds(p, guard))) refuse(api, p, liveRefusal(p));
    if (scratch && !scratch.some((s) => contained(p, s))) refuse(api, p, scratchRefusal(p));
  };
  const at = (i: number, check: (api: string, p: string) => void): Check => (args, api) => { const p = pathOf(args[i]); if (p !== null) check(api, p); };
  const write = (i: number): Check => at(i, (api, p) => target(api, p, false));
  const destroy = (i: number): Check => at(i, (api, p) => target(api, p, true));
  // 读：快照的 home 里一律不读；另外守着的 home 只拦 secrets.json（按给的名字和解开链接后的名字认）
  const read = (i: number): Check => at(i, (api, p) => {
    const secret = basename(p) === SECRETS || basename(realish(resolve(p))) === SECRETS;
    if (under(p, live) || (secret && under(p, guard))) refuse(api, p, liveRefusal(p));
  });
  // 拷贝、硬链接的来源：守着的 home 里的一律不行（硬链接 realpath 看不出来，之后写它就写穿了真文件）
  const source = (i: number): Check => at(i, (api, p) => { if (under(p, guard)) refuse(api, p, liveRefusal(p)); });
  // 解开链接后真落在草稿区里（硬链接的来源、符号链接的目标：只看它真在哪儿——树会把 realpath 过的路径拿来建链接，字面上不一定以 --work 开头）
  const resolvesInScratch = (p: string): boolean => scratch === null || scratch.some((s) => isWithin(realish(resolve(p)), realish(s)));
  // 硬链接的来源还得在草稿区里：链进来以后往链接里写，改的是外面那个文件
  const linkSource: Check = at(0, (api, p) => { if (!resolvesInScratch(p)) refuse(api, p, linkRefusal(p)); });
  // 符号链接的目标相对链接所在的目录。指进守着的 home 的 secrets.json 不行；有草稿区时，目标解开后落在草稿区外面的也不行
  // （没有草稿区时别的照旧能链：链进去也读不了、写不了，读写时按解开后的路径查）
  const symlinkTarget: Check = (args, api) => {
    const t = pathOf(args[0]);
    const where = pathOf(args[1]);
    if (t === null || where === null) return;
    const p = resolve(dirname(resolve(where)), t);
    if ((basename(p) === SECRETS || basename(realish(p)) === SECRETS) && under(p, guard)) refuse(api, t, liveRefusal(t));
    if (!resolvesInScratch(p)) refuse(api, t, under(p, guard) ? liveRefusal(t) : symlinkRefusal(t));
  };
  const all = (...checks: Check[]): Check => (args, api) => { for (const c of checks) c(args, api); };
  // 读的函数带了能写的 flag（readFile(p, { flag: "w" }) 会截断、"a" 会新建；Node 不经过公开的 open）：照写来查
  const writeFlag = (i: number, key: "flag" | "flags"): Check => (args, api) => { if (canWrite(optionFlags(args[i], key))) write(0)(args, api); };
  const checks: Record<(typeof PATH_FNS)[number] | (typeof STREAMS)[number], Check> = {
    writeFile: write(0), appendFile: write(0), mkdir: write(0), mkdtemp: write(0), mkdtempDisposable: write(0), truncate: write(0),
    unlink: write(0), rm: destroy(0), rmdir: destroy(0), rename: all(destroy(0), write(1)),
    copyFile: all(source(0), write(1)), cp: all(source(0), write(1)), symlink: all(symlinkTarget, write(1)), link: all(source(0), linkSource, write(1)),
    chmod: write(0), lchmod: write(0), chown: write(0), lchown: write(0), utimes: write(0), lutimes: write(0),
    open: (args, api) => { if (canWrite(flagsOf(args[1]))) write(0)(args, api); read(0)(args, api); },
    readFile: all(read(0), writeFlag(1, "flag")), openAsBlob: read(0), readdir: read(0), opendir: read(0),
    createWriteStream: write(0), WriteStream: write(0), FileWriteStream: write(0),
    createReadStream: all(read(0), writeFlag(1, "flags")), ReadStream: all(read(0), writeFlag(1, "flags")), FileReadStream: all(read(0), writeFlag(1, "flags")),
    Utf8Stream: (args, api) => { const o = args[0]; if (o && typeof o === "object") write(0)([(o as { dest?: unknown }).dest], api); },
  };

  const saved: Array<[object, string, PropertyDescriptor]> = [];
  const replace = (obj: object, name: string, value: unknown): void => {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    if (!d) return;
    saved.push([obj, name, d]);
    Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: d.enumerable ?? true });
  };
  type Fn = (...args: unknown[]) => unknown;
  // 写成了：目标是草稿区里的一个普通文件，就把它的时间改成虚拟的现在（目录、链接、不在了的不动；给的是描述符就不知道是哪个文件）
  const { now } = opts;
  const stamp = now ? (target: unknown): void => {
    const p = pathOf(target);
    if (p === null) return;
    try {
      if (!fs.lstatSync(p).isFile() || (scratch && !scratch.some((s) => contained(p, s)))) return;
      utimesAsIs(p, now() / 1000, now() / 1000);
    } catch { /* 写完就被挪走、删掉了：没有可改的 */ }
  } : null;
  /** at：写成以后要改时间的那个参数的位置（不改就不给）。同步的返回了就改，回调的在回调报成功时改，promise 的在它成了以后改 */
  const fn = (orig: Fn, check: Check, api: string, promise: boolean, at?: number): Fn => {
    const done = stamp && at !== undefined ? (args: unknown[]): void => stamp(args[at]) : null;
    if (promise) {
      return function (this: unknown, ...args: unknown[]) {
        try { check(args, api); } catch (e) { return Promise.reject(e); }
        const r = orig.apply(this, args) as Promise<unknown>;
        return done ? r.then((v) => { done(args); return v; }) : r;
      };
    }
    const sync = api.endsWith("Sync");
    return function (this: unknown, ...args: unknown[]) {
      check(args, api);
      if (!done) return orig.apply(this, args);
      if (sync) { const r = orig.apply(this, args); done(args); return r; }
      const cb = args.at(-1);
      if (typeof cb !== "function") return orig.apply(this, args);
      return orig.apply(this, [...args.slice(0, -1), (err: unknown, ...rest: unknown[]) => { if (!err) done(args); (cb as Fn)(err, ...rest); }]);
    };
  };
  const cls = (orig: Fn, check: Check, api: string): Fn => new Proxy(orig, {
    construct: (t, args, nt) => { check(args, api); return Reflect.construct(t, args, nt) as object; },
    apply: (t, self, args) => { check(args, api); return Reflect.apply(t, self, args); },
  });
  const f = fs as unknown as Record<string, Fn | undefined>;
  const fp = fs.promises as unknown as Record<string, Fn | undefined>;
  // 按描述符改元数据：记一条（path 写 <fd>），抛错 / 拒掉
  const fdMeta = (api: string, promise: boolean): Fn => function () {
    const e = new Error(`parity: refusing to change file metadata through a descriptor (${api})`);
    opts.sink?.add("refused", { api, path: "<fd>" });
    if (promise) return Promise.reject(e);
    throw e;
  };
  for (const n of FD_META_FNS) if (typeof f[n] === "function") replace(fs, n, fdMeta(`fs.${n}`, false));
  // FileHandle 不公开：第一次从包过的 promises.open 拿到它时，把原型上那几个方法换掉（FileHandle 只有 promises.open 给得出来）
  let handleProto: object | null = null;
  const patchHandle = (fh: unknown): unknown => {
    if (handleProto === null && fh && typeof fh === "object") {
      handleProto = Object.getPrototypeOf(fh) as object;
      for (const m of HANDLE_META_FNS) replace(handleProto, m, fdMeta(`FileHandle.${m}`, true));
    }
    return fh;
  };
  for (const name of PATH_FNS) {
    for (const n of [name, `${name}Sync`]) { const o = f[n]; if (typeof o === "function") replace(fs, n, fn(o, checks[name], `fs.${n}`, false, STAMPED[name])); }
    const o = fp[name];
    if (typeof o !== "function") continue;
    const wrapped = fn(o, checks[name], `fs.promises.${name}`, true, STAMPED[name]);
    replace(fs.promises, name, name === "open" ? function (this: unknown, ...args: unknown[]) { return (wrapped.apply(this, args) as Promise<unknown>).then(patchHandle); } : wrapped);
  }
  for (const name of STREAMS) {
    const o = f[name];
    if (typeof o === "function") replace(fs, name, name.startsWith("create") ? fn(o, checks[name], `fs.${name}`, false) : cls(o, checks[name], `fs.${name}`));
  }
  // 进程级的几样（内核沙箱照样管着后果；这里图的是早拦、留一条记录）
  const off = (api: string, why: string) => function (subject: unknown): never {
    const what = subject instanceof URL ? subject.href : String(subject);
    return refuse(api, what, new Error(`parity: refusing to ${why} (${what})`));
  };
  // 换了当前目录，相对路径就不落在 <work> 里了
  replace(process, "chdir", off("process.chdir", "change the working directory"));
  // Worker、module.register 的钩子各起一条新线程，里面的 fs / child_process / net 是没包过的
  replace(workerThreads, "Worker", off("worker_threads.Worker", "start a worker thread"));
  replace(nodeModule, "register", off("module.register", "register module hooks"));
  // 信号只许发给自己：树看到的 process.pid（场景子进程里是换过的固定号）就是这个进程，转给真的 pid；别的 pid 一律不发
  const kill = process.kill;
  replace(process, "kill", function (pid: unknown, signal?: string | number): true {
    if (Number(pid) !== process.pid) refuse("process.kill", `<pid ${String(pid)}>`, new Error(`parity: refusing to signal another process (${String(pid)})`));
    return kill.call(process, OWN_PID, signal);
  });
  syncBuiltinESMExports();
  return () => {
    for (const [obj, name, d] of saved.reverse()) Object.defineProperty(obj, name, d);
    syncBuiltinESMExports();
  };
}
