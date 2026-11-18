// 对照工具的内核沙箱：场景子进程套在 macOS 的 sandbox-exec 里跑。写只许落在 --work、--out（和几个设备文件），网络全关，
// 草稿区外面的 secrets.json 不许读，信号只发得给自己。边界在这一层：内核管着，node:sqlite、Worker、execve 换出去的程序、
// 原生扩展这些 JS 包不住的路一样拦。管不到的只有一样：经 Mach / XPC 找系统服务代办的事（服务在沙箱外面替它做；要走到那儿得有原生代码或者 exec 出去的帮手）。
// fence.ts、offline.ts 两层 JS 围栏照旧装着，做早一步的、话说得清楚的、留记录的拒绝。
// 这个文件只管 profile 的字和套上它的命令行，外加两个问法：这台机器套不套得上（真跑一次试试）、这个进程是不是在里面。
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** 没包过的 process.kill（这个文件一加载就记下：围栏装上以后 process.kill 只许发给自己） */
const signal = process.kill.bind(process);

/**
 * 内核按真实路径比（macOS 上 /tmp 其实是 /private/tmp）：解开符号链接，大小写也照盘上的；
 * 目录还没建的（dump 先查沙箱、后建目录），解开最近一个存在的上级再接上剩下的
 */
function kernelPath(p: string): string {
  try { return realpathSync.native(p); } catch { /* 还没建，往上找 */ }
  const parent = dirname(p);
  return parent === p ? p : join(kernelPath(parent), basename(p));
}

/** profile 里的字符串：反斜杠和双引号前面加反斜杠 */
const quoted = (p: string): string => `"${p.replace(/[\\"]/g, "\\$&")}"`;

/**
 * 场景子进程的 profile：别的照常（读、起线程），网络一律不行，写只许在 work、out 里面和几个设备文件上；
 * 名字是 secrets.json 的文件不许读，在 work 里面的除外（世界写进工作副本的那把假 key 得读得到）——一条规则说完
 * （require-all + require-not），不靠规则的先后；
 * 信号只许发给自己（先全拦、再放开自己，后一条盖前一条）：跑它的系统用户名下还有线上的进程。外面发进来的不受这条管，超时的 SIGTERM 照样到
 */
export function sandboxProfile(work: string, out: string): string {
  const w = quoted(kernelPath(resolve(work)));
  const o = quoted(kernelPath(resolve(out)));
  return [
    "(version 1)(allow default)(deny network*)(deny file-write*)",
    `(allow file-write* (subpath ${w}) (subpath ${o}) (literal "/dev/null") (literal "/dev/stdout")`,
    "  (literal \"/dev/stderr\") (regex #\"^/dev/fd/\") (literal \"/dev/dtracehelper\"))",
    `(deny file-read* (require-all (regex #"/secrets\\.json$") (require-not (subpath ${w}))))`,
    "(deny signal)(allow signal (target self))",
  ].join("\n");
}

/** 套着 profile 跑 cmd 的命令行。sandbox-exec 装好沙箱就 exec 成 cmd：还是同一个 pid，发给它的信号直接到 cmd */
export function sandboxed(profile: string, cmd: string, args: readonly string[]): { cmd: string; args: string[] } {
  return { cmd: SANDBOX_EXEC, args: ["-p", profile, cmd, ...args] };
}

/** 这台机器套不上沙箱的原因（不是 macOS、没有 sandbox-exec、profile 装不上）；套得上给 null。拿这份 profile 真跑一次 /usr/bin/true 来试 */
export function sandboxProblem(profile: string): string | null {
  if (process.platform !== "darwin") return `sandbox-exec is macOS only, this is ${process.platform}`;
  const probe = sandboxed(profile, "/usr/bin/true", []);
  const r = spawnSync(probe.cmd, probe.args, { stdio: "ignore" });
  if (r.error) return `cannot run ${SANDBOX_EXEC}: ${r.error.message}`;
  return r.status === 0 ? null : `${SANDBOX_EXEC} could not apply the profile (exit ${r.status ?? r.signal})`;
}

/**
 * 这个进程是不是在上面那份 profile 的沙箱里：沙箱里信号只发得给自己，所以问一声父进程在不在（0 号信号，什么都不发）会被拒（EPERM）；
 * 没套沙箱时问得到。光看 EPERM 不够：父进程是别的用户的（sudo -u 手工起的，父进程是 root 的）、或者已经没了（挂到了 launchd 名下）
 * 也是 EPERM。所以要 dump 把自己的 pid 传过来（--parent）：这个进程的父进程就是它，问它又被拒，才算在沙箱里
 */
export function insideSandbox(parent: number): boolean {
  if (process.ppid !== parent) return false;
  try { signal(parent, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
