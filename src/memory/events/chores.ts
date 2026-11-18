// 事件记忆的日常（hhd 每 30 秒一次）：新原话抄进原话层；补算向量放到后台（OpenAI 慢或断了不拖住大脑的定时检查，
// 同一时间只跑一轮）；每 10 分钟导出 events.json、中期视图和向量的情况（给脚本和控制台用），顺带导出一次人物卡和近况；
// 夜里写了事件、经过（现算段会变，peopleDirty），下一个 30 秒就导出人物卡和近况。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventMemory } from "./memory.ts";
import { renderMidterm } from "./midterm.ts";

const EXPORT_EVERY_MS = 10 * 60_000;

export class MemChores {
  private readonly o: { mem: EventMemory; exportsDir: string; tz: string; now: () => number; asleep: () => boolean; log: (msg: string, data: Record<string, unknown>) => void };
  private backfilling: Promise<void> | null = null;
  private lastExport = 0;

  constructor(o: MemChores["o"]) { this.o = o; }

  tick(): void {
    const { mem } = this.o;
    mem.index.ingestCentral();
    if (!this.o.asleep() && !this.backfilling) {
      this.backfilling = mem.index.backfillVectors(200)
        .then(() => undefined, (e: unknown) => this.o.log("vector backfill failed", { error: String(e).slice(0, 200) }))
        .finally(() => { this.backfilling = null; });
    }
    if (this.o.now() - this.lastExport >= EXPORT_EVERY_MS) {
      this.lastExport = this.o.now();
      // 人物卡和近况（ledger/people/）写了就导出，这里兜底：手动改过、上次出错的都跟上；出错只记日志，不拦下面的
      mem.exportPeople();
      if (mem.peopleExportError) this.o.log("people export failed", { error: mem.peopleExportError.slice(0, 300) });
      mkdirSync(this.o.exportsDir, { recursive: true });
      mem.exportJson(join(this.o.exportsDir, "events.json"));
      writeFileSync(join(this.o.exportsDir, "midterm.md"), renderMidterm(mem.recall, { now: this.o.now(), tz: this.o.tz }));
      // 向量断了（没额度、key 失效）只会悄悄退成全文检索：还差多少条、最后一次的错写出来给控制台
      const st = mem.index.embedder?.status?.() ?? { lastError: "", lastErrorAt: null, lastOkAt: null, pausedUntil: null };
      writeFileSync(join(this.o.exportsDir, "vectors.json"), JSON.stringify({ at: this.o.now(), missing: mem.index.missingVectors(), ...st }));
    }
    // 事件、经过写过还没导出的（上面那次导过就清掉了，不会导两遍）；出错 exportPeople 自己记日志（一样的错不刷屏）
    mem.flushPeople();
  }

  /** 后台那一轮补算做完（测试、关机用） */
  async idle(): Promise<void> { await this.backfilling; }
}
