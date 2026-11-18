// tools 场景：她手上的每个工具都经真的 handler 调一遍。起来，挨个叫醒每个脑区（跟 boot 一样），叫醒的那几条先回掉；
// 然后每个脑区、按它会话工具表的先后，每个工具先调一次 {}（记下参数检查说的话，或者不带参数时做了什么），
// 再把库里这个脑区最后几次不同的调用（act 行）照原样的参数、老的先再调一遍。每次调都是演一轮 { tool }、排空；
// 之后还有没回的 send 的会话（工具叫起来的另一头、慢慢想、回头看、把关这些）各回一句「（对照）」、排空，回了又有新的就接着回，
// 直到没有在等的（有上限），不去编像样的下文。
// 白天这一遍，整理记忆的写工具只会被拒：再照夜里整理的样子开一跑（Brain 叫海马整理时那样 revertNight、beginNight），
// 海马的写工具在这一跑里把 {} 和存着的调用再调一遍，照整理成功那样 commitNight 收尾（拒的话、写成了的话都要钉住）。
// browser、computer 不调：它们出进程（真开浏览器、真经节点动电脑）。小判断由假的回（judge.ts）。
// 会话叫不开、回不完都不悄悄跳过：抛错，场景算挂；库里一次存着的调用都没有也算挂（除非快照的配置明说了 parity.allowEmpty）。最后记一条 tools-coverage（每个脑区调了哪些、各再调了几次存着的、按设计不调的）、
// 一条总数的 info 日志，再记状态。
// 记下的是：每个工具回的话、出错的话、参数检查的话，工具后追加的、工具前拦下的，往外的网关调用、要跑的命令、写进库和文件的。
import { nightOf } from "../../brainstem/clock.ts";
import type { FakeSession } from "../../kernel/fake.ts";
import type { ToolDef } from "../../kernel/types.ts";
import { regionSpecs } from "../../regions/specs.ts";
import { MEM_STORE_WRITERS } from "../../tools/memtools.ts";
import { answerUntilQuiet, recordCall, type Answered } from "../drive.ts";
import { judgeAnswer } from "../judge.ts";
import type { Scenario } from "../scenario.ts";
import { callKind, pickCalls, requireStored, storedCalls } from "../stored.ts";
import type { StoredCall } from "../stored.ts";
import type { World } from "../world.ts";

/** 每个（脑区, 工具）再调库里存着的这么多次（不同的；存着的没这么多就有多少调多少） */
export const STORED_PER_TOOL = 6;
/** 不调的工具：出进程 */
export const SKIPPED_TOOLS: ReadonlySet<string> = new Set(["browser", "computer"]);
/** 叫醒、回没回的 send 用的那句 */
const PLAIN = "（对照）";

/** 一个脑区里调过的一个工具：{} 之外再调了几次存着的 */
interface Covered { name: string; stored: number }

/** 这个脑区最近开的那个会话，开着才给；没有开着的就叫醒它一次（会重开），还是没开着给 null */
async function sessionOf(w: World, region: string): Promise<FakeSession | null> {
  const open = (): FakeSession | null => {
    const s = w.driver.sessions.findLast((x) => x.id === region);
    return s && !s.closed ? s : null;
  };
  const s = open();
  if (s) return s;
  w.brain.wakeRegion(region, PLAIN);
  await w.drain();
  return open();
}

/** 开着的会话；叫醒了也没开着就抛错（悄悄跳过的话，真数据上没人会发现哪个工具从来没调过） */
async function mustSession(w: World, region: string, what: string): Promise<FakeSession> {
  const s = await sessionOf(w, region);
  if (!s) throw new Error(`parity: tools: no open session in ${region} ${what}`);
  return s;
}

/** 没回的 send 一圈圈回掉、排空，直到没有在等的（answerUntilQuiet：有上限，到了抛错）；抛的错带上是哪一次调用之后 */
async function settle(w: World, answered: Answered, where: string): Promise<void> {
  try {
    await answerUntilQuiet(w, answered, { say: PLAIN });
  } catch (e) {
    throw new Error(`${e instanceof Error ? e.message : String(e)} — after ${where}`);
  }
}

/** 在这个脑区调一次工具：演一轮 { tool }、排空、回完。这一轮回的是开演那一刻这个会话还没回的全部（跟 FakeSession 一样），answered 跟着记上 */
async function callOnce(w: World, region: string, name: string, args: Record<string, unknown>, answered: Answered): Promise<void> {
  const s = await mustSession(w, region, `to call ${name}`);
  answered.set(s, s.sent.length);
  await w.play(region, { tool: { name, args } });
  await w.drain();
  await settle(w, answered, `${region} ${name}`);
}

/** 一个工具：先 {}，再挑出来的存着的（老的先）；返回再调了几次存着的 */
async function callTool(w: World, region: string, def: ToolDef, stored: readonly StoredCall[], answered: Answered): Promise<number> {
  // 存着的 {} 就是先调的那次，不算
  const mine = stored.filter((c) => Object.keys(c.args).length > 0);
  const picked = pickCalls(mine, STORED_PER_TOOL, (c) => callKind(def, c.args));
  for (const args of [{}, ...picked.map((c) => c.args)]) await callOnce(w, region, def.name, args, answered);
  return picked.length;
}

export const tools: Scenario = {
  name: "tools",
  async run(w) {
    const specs = regionSpecs(w.cfg);
    const named = new Map(specs.map((s) => [s.id, new Set(s.tools)]));
    // 起来之前取：后面每调一次都会记一条新的 act。脑区已经不在的、不在这个脑区工具表里的、不调的都不要（先在库里按脑区、工具名筛）
    const wantedTools = [...new Set(specs.flatMap((s) => s.tools))].filter((t) => !SKIPPED_TOOLS.has(t));
    const byPair = new Map<string, StoredCall[]>();
    const pair = (region: string, tool: string): string => `${region}\n${tool}`;
    for (const c of storedCalls(w.db, (region, tool) => !SKIPPED_TOOLS.has(tool) && named.get(region)?.has(tool) === true, { regions: specs.map((s) => s.id), tools: wantedTools })) {
      const list = byPair.get(pair(c.region, c.tool));
      if (list) list.push(c);
      else byPair.set(pair(c.region, c.tool), [c]);
    }
    requireStored(w.cfg, "tools", "stored tool calls (central rows of kind act for a tool of today's regions)", [...byPair.values()].reduce((n, list) => n + list.length, 0));
    w.driver.answerAsk(judgeAnswer);
    w.start();
    await w.drain();
    for (const spec of specs) {
      w.brain.wakeRegion(spec.id, PLAIN);
      await w.drain();
    }
    const answered: Answered = new WeakMap();
    await settle(w, answered, "the first wakes");

    // —— 白天这一遍：每个脑区、每个工具 ——
    const coverage: Array<{ region: string; tools: Covered[]; skipped: string[] }> = [];
    const toolsOf = new Map<string, readonly ToolDef[]>();
    for (const spec of specs) {
      // 工具表按会话开的时候的（open 那条里记的就是它）：没接事件库时记忆工具不在里面，跟真的一样
      const defs = (await mustSession(w, spec.id, "to read its tool list")).spec.tools;
      toolsOf.set(spec.id, defs);
      const done: Covered[] = [];
      for (const def of defs) {
        if (SKIPPED_TOOLS.has(def.name)) continue;
        done.push({ name: def.name, stored: await callTool(w, spec.id, def, byPair.get(pair(spec.id, def.name)) ?? [], answered) });
      }
      coverage.push({ region: spec.id, tools: done, skipped: defs.filter((d) => SKIPPED_TOOLS.has(d.name)).map((d) => d.name) });
    }

    // —— 夜里这一遍：海马的写工具在开着的一跑里（批次编号跟 askHippocampusToOrganize 一样；没整理的日子 sleep_digest.py 给，
    // 假的外部命令什么都不回，所以跟 Brain 这时一样是 today）——
    let night: { region: string; batch: string; tools: Covered[] } | null = null;
    const mem = w.brain.mem;
    const hippo = specs.find((s) => s.role === "hippocampus");
    const writers = hippo ? (toolsOf.get(hippo.id) ?? []).filter((d) => MEM_STORE_WRITERS.includes(d.name)) : [];
    if (mem && hippo && writers.length) {
      const batch = `night:${nightOf(w.clock.now, w.cfg.schedule.timezone)}/today`;
      // 照 Brain 的样子动事件记忆（开一跑、收尾），各记一条 call；抛了错记下再抛（场景算挂）
      recordCall(w.rec, "revertNight", {}, () => mem.revertNight(), { rethrow: true });
      recordCall(w.rec, "beginNight", { id: batch }, () => mem.beginNight(batch), { rethrow: true });
      const done: Covered[] = [];
      for (const def of writers) done.push({ name: def.name, stored: await callTool(w, hippo.id, def, byPair.get(pair(hippo.id, def.name)) ?? [], answered) });
      recordCall(w.rec, "commitNight", { day: null }, () => mem.commitNight(null), { rethrow: true });
      night = { region: hippo.id, batch, tools: done };
    }

    // 两遍分开数、数的是同一样东西：调了几个工具（每个先调一次 {}）、另外再调了几次存着的
    const count = (tools: readonly Covered[]): { called: number; storedCalls: number } => ({ called: tools.length, storedCalls: tools.reduce((n, t) => n + t.stored, 0) });
    const dayTotals = count(coverage.flatMap((r) => r.tools));
    const nightTotals = count(night?.tools ?? []);
    const skipped = [...new Set(coverage.flatMap((r) => r.skipped))].sort();
    w.rec.add("call", {
      name: "tools-coverage", args: { storedPerTool: STORED_PER_TOOL, skippedByDesign: [...SKIPPED_TOOLS].sort() },
      returned: { regions: coverage, night, totals: { day: dayTotals, night: nightTotals, skipped } },
    });
    w.rec.log("info", `parity: tools called=${dayTotals.called}(day)+${nightTotals.called}(night) stored-calls=${dayTotals.storedCalls}(day)+${nightTotals.storedCalls}(night) skipped=${skipped.join(",")}`);
    w.recordState();
  },
};
