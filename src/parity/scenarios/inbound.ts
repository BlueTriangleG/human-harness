// inbound 场景：库里存着的最近那些外来消息（人发来的、她排的提醒），老的先，一条条再喂一遍。
// 每条之间虚拟时间走 90 秒；喂完排空，还有没回的 send 的会话按第 i 条轮着演四种回法（直接回、NO_REPLY、先记一笔再回、
// 用 message 另发给这个人再 NO_REPLY），演完又冒出来的接着演到没有为止。记下的是：每条进来时交给内核的那段话（提示、是谁、情境）、
// 交给了哪个脑区、往外发了什么发给谁。最后记一条每个入口各走了几条（inbound-paths 的 call，同样的数一条 info 的 log），再记状态。
// 每十条里有一条（第 2、12、22…… 条）是在主线「正演着一轮」时进来的（feedWhileBusy）：别人的话压着等、提醒她有人在等、
// 等久了把手上这一轮打断、打断以后这条才送到、回复发给这条的人——「回给谁」的那套逻辑只有这时才走得到。
// 库里一条外来消息都没有：场景算挂（两边都什么也不喂，比出来「一样」是假的），除非快照的配置明说了 parity.allowEmpty。
// 这里不 tick（tick 归 day 场景）：没有 tick 她就一直醒着，不管快照是几点拍的。
import type { Script } from "../../kernel/fake.ts";
import type { People } from "../../persona/people.ts";
import { answerUntilQuiet, feed, type Answered } from "../drive.ts";
import { judgeAnswer } from "../judge.ts";
import type { Scenario } from "../scenario.ts";
import { messageBack, messageEntry, requireStored, storedMessages } from "../stored.ts";
import type { Entry, StoredMessage } from "../stored.ts";
import type { World } from "../world.ts";

/** 再喂最近这么多条（库里没这么多就有多少喂多少） */
export const INBOUND_COUNT = 60;
/** 两条之间隔多久（虚拟时间） */
const GAP_MS = 90_000;
/** 每这么多条里的第二条（下标 1、11、21……）在主线正演着一轮时喂：有两条消息的快照就至少有一次 */
export const BUSY_EVERY = 10;
/**
 * 那一条喂进去以后虚拟时间走这么久：比大脑让真人消息最多等的时间长（brain.ts 的 HOLD_MAX_MS，20 秒，没导出），压着的那条到点就把这一轮打断。
 * 大脑那边改长了、这里没过线：busy-turn-end 那条的 interrupted 变成 false，记录上看得出来
 */
export const HOLD_WAIT_MS = 30_000;
/** 主线的脑区名（大脑里写死的那个） */
const MAIN = "main";
/** 在忙的时候进来的那一条，最后回这一句（不照 i % 4 轮：要看得出回复发给了谁） */
export const BUSY_REPLY: Script = { say: "（对照：刚才手上有事，现在回你）" };

/** 第 i 条之后演的那一轮 */
function scriptFor(i: number, m: StoredMessage, e: Entry, people: People): Script {
  switch (i % 4) {
    case 0: return { say: "（对照：收到）" };
    case 1: return { say: "NO_REPLY" };
    case 2: return { tool: { name: "jot_down", args: { text: "（对照：记一笔）" } }, say: "（对照：记下了）" };
    default: return { tool: { name: "message", args: messageBack(m, e, "（对照：另发一条）", people) }, say: "NO_REPLY" };
  }
}

/**
 * 主线正演着一轮时来了一条消息。照假内核的样子摆出「正在演」（假会话的 busy 是公开的），然后：
 * 1. 喂这一条：同一件事的并进这一轮，别人的压着等（大脑记下有人在等）；
 * 2. 这一轮里一次工具调用做完——内核照例跑工具后的钩子，「有人在等你回」那句就附在这里（记成 inject）；
 * 3. 时间走过 HOLD_WAIT_MS：压着的真人消息到点，大脑把这一轮打断（假内核的 interrupt：这一轮以失败结束），压着的那条这才送进去；
 * 4. 没被打断的（并进来的、不急的没有计时）：这一轮照常演完（script），回的是这一刻还没回的全部。
 * 做了什么记两条 call：busy-turn（开始）、busy-turn-end（这条是并进去的还是压着的、打断了没有、这一轮怎么结束的）。
 * 主线没有开着的会话（刚换班）摆不出「正在演」：记一条说明，这一条照常喂。
 * 返回这一条的下场（场景最后数一数）：skipped 没摆成、interrupted 压着等到打断、joined 并进了那一轮、held 压着但没等到打断（那一轮照常演完才轮到它）
 */
async function feedWhileBusy(w: World, answered: Answered, e: Entry, script: Script, message: number): Promise<"skipped" | "joined" | "interrupted" | "held"> {
  const args = { message, region: MAIN, holdWaitMs: HOLD_WAIT_MS };
  const s = w.driver.sessions.findLast((x) => x.id === MAIN);
  if (!s || s.closed) {
    w.rec.add("call", { name: "busy-turn", args, returned: "skipped: main has no open session" });
    feed(w, e);
    await w.drain();
    return "skipped";
  }
  w.rec.add("call", { name: "busy-turn", args, returned: "main marked busy" });
  s.busy = true;
  const [sentBefore, interruptedBefore] = [s.sent.length, s.interrupted];
  feed(w, e);
  await w.drain();
  const joined = s.sent.length > sentBefore;
  const nudge = s.spec.hooks.afterTool();
  if (nudge) s.injected.push(nudge);
  await w.clock.advanceTo(w.clock.now + HOLD_WAIT_MS);
  const interrupted = s.interrupted > interruptedBefore;
  const stillRunning = s.busy && !s.closed;
  if (stillRunning) {
    answered.set(s, s.sent.length);
    await w.play(MAIN, script);
  }
  s.busy = false;   // 会话在这中间被关了（换班）：摆出来的「正在演」收掉
  await w.drain();
  w.rec.add("call", {
    name: "busy-turn-end", args: { message, region: MAIN },
    returned: { joined, interrupted, endedBy: interrupted ? "interrupt" : stillRunning ? "turn-end" : "session closed" },
  });
  return interrupted ? "interrupted" : joined ? "joined" : "held";
}

export const inbound: Scenario = {
  name: "inbound",
  async run(w) {
    // 起来之前取：起来时接着送的（重启前没回完的）会再记进中央记忆
    const messages = storedMessages(w.db, INBOUND_COUNT);
    requireStored(w.cfg, "inbound", "stored messages (central rows of kind input)", messages.length);
    // 快照里有没分流完的闸门行，起来时闸门会再判一次
    w.driver.answerAsk(judgeAnswer);
    w.start();
    await w.drain();
    const answered: Answered = new WeakMap();
    const paths: Record<string, number> = {};
    const busy: Record<string, number> = {};
    for (const [i, m] of messages.entries()) {
      await w.clock.advanceTo(w.clock.now + GAP_MS);
      const people = w.brain.currentPeople();
      const e = messageEntry(m, people);
      paths[e.name] = (paths[e.name] ?? 0) + 1;
      if (i % BUSY_EVERY === 1) {
        const outcome = await feedWhileBusy(w, answered, e, BUSY_REPLY, i);
        busy[outcome] = (busy[outcome] ?? 0) + 1;
        await answerUntilQuiet(w, answered, BUSY_REPLY);
        continue;
      }
      feed(w, e);
      await w.drain();
      await answerUntilQuiet(w, answered, scriptFor(i, m, e, people));
    }
    w.rec.add("call", { name: "inbound-paths", args: { messages: messages.length }, returned: paths });
    // 同样的数再记一条 info 的 log：hh-parity dump 只打各类的条数和 log 那几句（不打内容），真数据上靠它看每个入口各走了几条
    const counts = (c: Record<string, number>): string => Object.keys(c).sort().map((k) => `${k}=${c[k]}`).join(" ") || "none";
    w.rec.log("info", `parity: inbound paths ${counts(paths)}`);
    w.rec.log("info", `parity: inbound fed while main was busy ${counts(busy)}`);
    w.recordState();
  },
};
