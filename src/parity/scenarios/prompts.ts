// prompts 场景：当前语言包的提示语（src/lang/index.ts 的 P：绑过这个角色名字的那一份，也就是主脑读到的）的每一个导出都渲染一遍记成 call——常量记它的值，函数照 prompts.fixtures.ts 里的每组参数调一次，
// 再加人格前缀那几个拼字的函数（runtimeNote、languageLine、buildPrefix、dropThreadTiers）和每个脑区的定义（regionSpecs）。
// 只渲染：不 start、不叫醒、不记状态。以后把这些话挪进语言包、把写死的名字换成参数，两棵树的这份记录一字不差才算没改坏。
// 夹具里有几组参数是从世界的名单算的（跟「是谁」有关的分支要真名字才走得到）：调之前先算，记的是算出来的参数。
import { P } from "../../lang/index.ts";   // the bound pack: every prompt as the role reads it, names filled in
import { buildPrefix, dropThreadTiers, languageLine, runtimeNote } from "../../persona/persona.ts";
import { regionSpecs } from "../../regions/specs.ts";
import { recordCall } from "../drive.ts";
import { thrown } from "../recorder.ts";
import type { Scenario } from "../scenario.ts";
import type { World } from "../world.ts";
import { LANGUAGES, PREFIX_CALLS, PROMPT_FIXTURES, THREAD_TIERS_TEXT, type FixtureArgs } from "./prompts.fixtures.ts";

/** 要记的一项：calls 为 null 是常量（记值），否则是函数，照每组参数调一次（一组参数可以是从世界里算的） */
export interface PromptEntry { name: string; value: unknown; calls: ReadonlyArray<FixtureArgs<readonly unknown[]>> | null }

/**
 * 模块的导出排成要记的项：按导出名排（模块命名空间本来就是这个顺序；声明挪了位置、换了文件，记录的先后也不变），
 * 对象导出拆成「名字.键」（键也按名排）。missing：是函数却没有夹具的；stale：夹具对不上任何一个函数导出的
 */
export function promptEntries(mod: object, fixtures: object): { entries: PromptEntry[]; missing: string[]; stale: string[] } {
  const entries: PromptEntry[] = [];
  const missing: string[] = [];
  const fns = new Set<string>();
  const add = (name: string, value: unknown, calls: unknown): void => {
    if (typeof value !== "function") { entries.push({ name, value, calls: null }); return; }
    fns.add(name);
    if (Array.isArray(calls) && calls.length) entries.push({ name, value, calls: calls as PromptEntry["calls"] });
    else missing.push(name);
  };
  const fx = fixtures as Record<string, unknown>;
  for (const [name, v] of Object.entries(mod).sort(byKey)) {
    if (isRecord(v)) {
      const sub = isRecord(fx[name]) ? fx[name] : {};
      for (const [key, x] of Object.entries(v).sort(byKey)) add(`${name}.${key}`, x, sub[key]);
    } else add(name, v, fx[name]);
  }
  const named = Object.entries(fx).flatMap(([name, v]) => (isRecord(v) ? Object.keys(v).map((k) => `${name}.${k}`) : [name]));
  return { entries, missing, stale: named.filter((n) => !fns.has(n)).sort() };
}

const byKey = (a: [string, unknown], b: [string, unknown]): number => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 调一次记一条：返回什么记什么（不是字符串的照 JSON 记）；抛了就记 threw，下一个照调（recordCall） */
function call<A extends readonly unknown[]>(w: World, name: string, args: A, fn: (...a: A) => unknown): void {
  recordCall(w.rec, name, args, () => fn(...args));
}

/** 一组参数：写死的原样用，从世界里算的先算；算不出来（真名单里没有那样的人）记一条 threw、args 为 null，再记一句 warn 的 log（这一组没渲染，别当它比过了），接着往下 */
function resolve(w: World, name: string, args: FixtureArgs<readonly unknown[]>): readonly unknown[] | null {
  if (typeof args !== "function") return args;
  try {
    return args(w);
  } catch (e) {
    w.rec.add("call", { name, args: null, threw: `parity fixture: ${thrown(e)}` });
    w.rec.log("warn", `parity: prompts: a fixture of ${name} could not be computed from this snapshot and was not rendered`, { error: e });
    return null;
  }
}

export const prompts: Scenario = {
  name: "prompts",
  async run(w) {
    const { entries, missing } = promptEntries(P, PROMPT_FIXTURES);
    // 新加的函数没夹具就不往下跑：漏掉的那个不在记录里，对照时谁也看不出来
    if (missing.length) throw new Error(`parity: src/lang/zh/prompts.ts exports without a fixture in prompts.fixtures.ts: ${missing.join(", ")}`);
    for (const e of entries) {
      if (!e.calls) { w.rec.add("call", { name: e.name, returned: e.value }); continue; }
      for (const c of e.calls) {
        const args = resolve(w, e.name, c);
        if (args) call(w, e.name, args, e.value as (...a: readonly unknown[]) => unknown);
      }
    }
    for (const lang of LANGUAGES) call(w, "runtimeNote", [lang], runtimeNote);
    for (const lang of LANGUAGES) call(w, "languageLine", [lang], languageLine);
    for (const args of PREFIX_CALLS) call(w, "buildPrefix", args, buildPrefix);
    call(w, "dropThreadTiers", [THREAD_TIERS_TEXT], dropThreadTiers);
    // 配置不当参数记：boot 场景已经记了，这里再记一份，每改一处配置这个场景就跟着多一处差别
    call(w, "regionSpecs", [], () => regionSpecs(w.cfg));
  },
};
