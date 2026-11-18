// 对照工具的「怎么带着跑」：场景共用的几样动作。读存着的输入是 stored.ts 的事，搭世界是 world.ts 的事，这里只管把它们带起来——
// 调一个入口记一条 call（recordCall）；存着的一条输入喂进它当年走的那个入口（feed）；
// 还有没回的 send 的假会话演一轮剧本（answerUnanswered），一圈圈演到没有为止（answerUntilQuiet）；
// 再喂感官事件之前先从闸门账上拿掉它们（forgetSenses）。
import type { FakeSession, Script } from "../kernel/fake.ts";
import type { Db } from "../store/db.ts";
import { thrown, type Recorder } from "./recorder.ts";
import type { Entry, StoredSense } from "./stored.ts";
import type { World } from "./world.ts";

/**
 * 调一次、记一条 call：回来的记 returned，抛了的记 threw（「错误名: 话」）。args 在调之前先定下来（记的是给进去的样子）。
 * 抛了错默认不往外抛（两棵树一边抛一边不抛也是差别，下一步照做）；rethrow：记完再抛给场景（场景算挂）
 */
export function recordCall<T>(rec: Recorder, name: string, args: unknown, fn: () => T, o: { rethrow?: boolean } = {}): T | undefined {
  const given = rec.normalize(args);
  let returned: T;
  try {
    returned = fn();
  } catch (e) {
    rec.add("call", { name, args: given, threw: thrown(e) });
    if (o.rethrow) throw e;
    return undefined;
  }
  rec.add("call", { name, args: given, returned });
  return returned;
}

/** recordCall 的异步版：等 fn 的结果出来再记 */
export async function recordCallAsync<T>(rec: Recorder, name: string, args: unknown, fn: () => Promise<T>, o: { rethrow?: boolean } = {}): Promise<T | undefined> {
  const given = rec.normalize(args);
  let returned: T;
  try {
    returned = await fn();
  } catch (e) {
    rec.add("call", { name, args: given, threw: thrown(e) });
    if (o.rethrow) throw e;
    return undefined;
  }
  rec.add("call", { name, args: given, returned });
  return returned;
}

/**
 * 喂一条，记一条 call（name 是走的哪个入口，args 是喂进去的原样，returned 是大脑回的）。入口前后做的事照控制面（src/control.ts 的 handle）：
 * relay 那条命令先把 relay 存下的消息补交了再交这一条（不乱序）；sense、tell 两条在调大脑前后什么都不做（她自己排的提醒、
 * 额度提醒是大脑自己调的 inbound，也一样）。控制面回给命令行的那层包装（{ result }、{ status, result }）不记：那是回给 relay 和脚本的
 */
export function feed(w: World, e: Entry): void {
  recordCall(w.rec, e.name, e.args, () => {
    if (e.name === "fromChannel") { w.brain.drainRelaySpool(); return w.brain.fromChannel(e.args); }
    return e.name === "inbound" ? w.brain.inbound(e.args) : w.brain.fromSenses(e.args.text, e.args.events);
  });
}

/**
 * 要再喂的那几条先从闸门账上拿掉：账按事件编号去重（见过的整条跳过），不拿掉的话再喂什么也不发生。
 * 拿掉以后的账就是这几条还没来时的样子（工作副本里的库，快照不动）。返回拿掉了几行
 */
export function forgetSenses(db: Db, senses: readonly StoredSense[]): number {
  if (!senses.length) return 0;
  return Number(db.prepare(`DELETE FROM gate_log WHERE id IN (${senses.map(() => "?").join(",")})`).run(...senses.map((s) => s.id)).changes);
}

/** 演什么：所有会话同一个剧本，或者按会话定（脑区的名字、它是哪种脑区；不是 Brain 的脑区——夜里分段整理的会话——没有 role） */
export type ScriptFor = Script | ((region: string, role?: string) => Script);

/** 每个会话演过的那一轮之前送进去了几条（跟 FakeSession 自己一样：一轮回的是开演那一刻还没回的全部） */
export type Answered = WeakMap<FakeSession, number>;

/** 这个脑区最近开的那个会话还开着、不在演、有没回的 send */
function waiting(w: World, answered: Answered, region: string): boolean {
  const s = w.driver.latest(region);
  return !s.closed && !s.busy && s.sent.length > (answered.get(s) ?? 0);
}

/** 开过会话的脑区，按最早开的先后 */
const regionsOf = (w: World): string[] => [...new Set(w.driver.sessions.map((s) => s.id))];

/**
 * 一圈：每个还开着、有没回的 send 的假会话演一轮（按会话最早开的先后；轮到它的那一刻再看它有没有没回的，
 * 前面的会话演的时候给它送了话，这一圈就演）
 */
export async function answerUnanswered(w: World, answered: Answered, script: ScriptFor): Promise<void> {
  for (const region of regionsOf(w)) {
    if (!waiting(w, answered, region)) continue;
    const s = w.driver.latest(region);
    answered.set(s, s.sent.length);
    await w.play(region, typeof script === "function" ? script(region, w.brain.regions.get(region)?.spec.role) : script);
  }
}

/** answerUntilQuiet 最多演几圈 */
export const ANSWER_ROUNDS = 20;

/**
 * 一圈圈演（answerUnanswered）、每圈完了排空；演完又冒出来的（翻页重试、并进来的）下一圈接着演，直到没有为止。
 * 到了 rounds 圈还有：抛错（场景算挂，main.ts 记一条 error 的 log），不悄悄停
 */
export async function answerUntilQuiet(w: World, answered: Answered, script: ScriptFor, rounds = ANSWER_ROUNDS): Promise<void> {
  const left = (): string[] => regionsOf(w).filter((region) => waiting(w, answered, region));
  for (let r = 0; r < rounds; r++) {
    if (!left().length) return;
    await answerUnanswered(w, answered, script);
    await w.drain();
  }
  if (left().length) throw new Error(`parity: sessions still have unanswered sends after ${rounds} rounds (${left().join(", ")})`);
}
