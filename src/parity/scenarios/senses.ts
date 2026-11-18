// senses 场景：闸门那一头。先拿闸门账上最后一条往前 24 小时重判一遍（hh gate replay，只判不送），
// 再把账上最近那些感官事件老的先、隔 30 秒一条再喂一遍（喂之前从账上拿掉它们，不然按编号去重什么都不发生）。
// 小判断由假的回（judge.ts：按每一条自己的哈希给合格的结论）。记下的是：判断的题目和结论、每条走了哪条路、叫醒她时交给内核的那段话。最后记状态。
// 闸门没开（配置关了它，或者还配着下意识）：再喂只会走老路、重判会抛错，记一条 senses-skipped 说明为什么（再加一句 info 的 log，diff 会打出来），就此结束。
// 账上一条都没有：场景算挂（两边都什么也不喂，比出来「一样」是假的），除非快照的配置明说了 parity.allowEmpty。最后一句 info 的 log 说每个入口各喂了几条。
// 这里不 tick（tick 归 day 场景）：没有 tick 她就一直醒着，不管快照是几点拍的。
import { answerUntilQuiet, feed, forgetSenses, recordCallAsync, type Answered } from "../drive.ts";
import { judgeAnswer } from "../judge.ts";
import type { Scenario } from "../scenario.ts";
import { lastGateTs, requireStored, senseEntry, storedSenses } from "../stored.ts";

/** 再喂最近这么多条（账上没这么多就有多少喂多少） */
export const SENSES_COUNT = 80;
/** 两条之间隔多久（虚拟时间） */
const GAP_MS = 30_000;
/** 重判的那一段多长 */
const REPLAY_MS = 24 * 3600_000;

export const senses: Scenario = {
  name: "senses",
  async run(w) {
    if (!w.brain.gate) {
      const reason = `gate is off (gate.enabled=${String(w.cfg.gate.enabled)}, regions.perception=${JSON.stringify(w.cfg.regions.perception)})`;
      w.rec.add("call", { name: "senses-skipped", args: { reason }, returned: null });
      w.rec.log("info", "parity: senses skipped (the gate is off)");
      return;
    }
    // 起来之前取、之前拿掉：起来时闸门会把没分流完的行再分一次（拿掉的那几条不在里面，后面再喂）
    const events = storedSenses(w.db, SENSES_COUNT);
    requireStored(w.cfg, "senses", "stored sense events (gate_log rows)", events.length);
    const to = lastGateTs(w.db) ?? w.clock.now;
    forgetSenses(w.db, events);
    w.driver.answerAsk(judgeAnswer);
    w.start();
    await w.drain();

    const args = { from: new Date(to - REPLAY_MS).toISOString(), to: new Date(to).toISOString() };
    await recordCallAsync(w.rec, "gateReplay", args, () => w.clock.run(w.brain.gateReplay(args.from, args.to)));
    await w.drain();

    const answered: Answered = new WeakMap();
    const paths: Record<string, number> = {};
    for (const s of events) {
      await w.clock.advanceTo(w.clock.now + GAP_MS);
      const e = senseEntry(s);
      paths[e.name] = (paths[e.name] ?? 0) + 1;
      feed(w, e);
      await w.drain();
      await answerUntilQuiet(w, answered, { say: "（对照）" });
    }
    w.rec.log("info", `parity: senses fed ${Object.keys(paths).sort().map((k) => `${k}=${paths[k]}`).join(" ") || "none"}`);
    w.recordState();
  },
};
