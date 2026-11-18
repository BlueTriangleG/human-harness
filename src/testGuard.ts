// Tests never touch the live role. Run under the role's own account, the default config is the live one: on 11-13 a test
// reached the live hhd and sent the role two messages in its owner's name.
// 跑测试的进程（node --test 给每个测试进程和它起的子进程都带 NODE_TEST_CONTEXT；别的测试工具设 HH_TEST=1）要连 hhd 的控制口、
// 开数据库、读网关凭据，目标落在线上那几个目录底下，就直接抛错，不连、不开、不读。平常跑（hhd、hh 命令）不受影响。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { B } from "./lang/index.ts";

/** 正在跑测试 */
export function underTest(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.NODE_TEST_CONTEXT || env.HH_TEST === "1";
}

/**
 * 线上的那几个目录：跑的这个用户家目录下的 ~/.hh 和 ~/.openclaw（以角色自己的账号跑时就是它的状态目录、工作区和 openclaw.json），
 * HH_CONFIG 指的要是那底下的实例配置（她的 ~/.hh/config.json），再加上它写的 stateDir 和工作区的上一层（搬到外置盘也认得）。
 * 默认配置里的 stateDir、workspace 还在的话也算（框架的「配置分层」会把它们搬走，所以不靠它们）
 */
export function liveRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = [join(homedir(), ".hh"), join(homedir(), ".openclaw")].map((p) => resolve(p));
  const under = (p: string): boolean => home.some((r) => p === r || p.startsWith(r + sep));
  const dirsOf = (file: string): string[] => {
    try {
      const d = JSON.parse(readFileSync(file, "utf8")) as { stateDir?: unknown; workspace?: unknown };
      return [typeof d.stateDir === "string" ? d.stateDir : null, typeof d.workspace === "string" ? dirname(d.workspace) : null].filter((x): x is string => !!x);
    } catch { return []; }
  };
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const instance = env.HH_CONFIG && under(resolve(env.HH_CONFIG)) ? dirsOf(env.HH_CONFIG) : [];
  return [...new Set([...home, ...instance, ...dirsOf(join(repo, "config/default.json"))].map((p) => resolve(p)))];
}

/**
 * 测试里要碰的 path（socket、数据库、凭据文件）落在线上目录底下就抛错；不在测试里什么都不做。
 * HH_TEST_EXTRA_LIVE（冒号隔开）：只加不减，给闸自己的测试用——拿一个临时目录当「线上」去探，闸坏了碰到的也只是假的
 * （11-13 变异检查拿掉闸以后，探测用的真线上路径真被打开了一次：线上的 hh.db 开了又关，没写进东西）
 */
export function refuseLive(what: string, path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!underTest(env)) return;
  const p = resolve(path);
  const extra = (env.HH_TEST_EXTRA_LIVE ?? "").split(":").filter(Boolean).map((x) => resolve(x));
  const hit = [...liveRoots(env), ...extra].find((r) => p === r || p.startsWith(r + sep));
  if (hit) throw new Error(B.testGuard.refuseLive(what, p, hit));
}
