// 对照工具的场景：一个场景 = 在一个新搭的虚拟世界里做一串事（叫醒、喂剧本、tick），每件事留下的记录就是它的 transcript。
// 每个场景在自己的子进程里跑，互不串状态。新场景写在 scenarios/ 下，往 SCENARIOS 里加一条 { name, load }：
// dump 的父进程只读名字（这个文件不能静态 import 任何碰树的东西），用到时子进程才 load。
import type { World } from "./world.ts";

export interface Scenario {
  /** 命令行 --scenario 用的名字，也是 <out>/<name>/ 的目录名 */
  name: string;
  run(w: World): Promise<void>;
}

/** 登记的样子：名字，加用到时才加载的场景（动态 import，父进程不加载树） */
export interface ScenarioEntry {
  name: string;
  load(): Promise<Scenario>;
}

/**
 * 登记过的场景，按这个顺序跑（dump 不给 --scenario 就全跑）。直接放 Scenario 对象也认（子进程照样跑），
 * 但那得静态 import 场景文件，父进程就加载了树——test/parity.test.ts 查父进程的 import 图会挂
 */
export const SCENARIOS: ReadonlyArray<ScenarioEntry | Scenario> = [
  { name: "boot", load: async () => (await import("./scenarios/boot.ts")).boot },
  { name: "prompts", load: async () => (await import("./scenarios/prompts.ts")).prompts },
  { name: "inbound", load: async () => (await import("./scenarios/inbound.ts")).inbound },
  { name: "senses", load: async () => (await import("./scenarios/senses.ts")).senses },
  { name: "tools", load: async () => (await import("./scenarios/tools.ts")).tools },
  { name: "day", load: async () => (await import("./scenarios/day.ts")).day },
  { name: "console", load: async () => (await import("./scenarios/console.ts")).consoleTell },
];

/** 登记的那一条 → 场景本身 */
export async function loadScenario(e: ScenarioEntry | Scenario): Promise<Scenario> {
  return "run" in e ? e : e.load();
}
