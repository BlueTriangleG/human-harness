// 进提示前折成一句（memory.promptFolds，实例的数据，框架里不写死任何词）。
// 11-13：一件事的说明被 HH 当成记忆反复喂回各个会话（工具结果、她自己说的记的、压缩块、开场），越喂越多。
// 这里只管「进提示时」换掉：库里照原样存，控制台照原样看。
// 规矩：真人发来的话（human）只把命中的那几个字换成短语，别的字原样留着；别的种类（工具结果、动作、思考、
// 她自己说的记的、压缩块里的行）命中就整条 / 整行换成替换句。匹配是子串、不分大小写。
// 条目可以带 from / until（本地时间或毫秒）：只在这段时间里的记录上认（通用的词只管出事那一段，不误伤平时的记忆）。
import type { Entry } from "./central.ts";
import { parseTime } from "./events/schema.ts";

export interface PromptFold {
  /** 要认的说法（子串，不分大小写）；要窄，只收确实指那件事的说法；通用的词要配 from / until */
  find: string;
  /** 整条 / 整行换成的那句话 */
  say: string;
  /** 真人的话里只换这几个字时用的短语；不写就用 say */
  word?: string;
  /** 只认这段时间里的记录（本地时间「2026-11-13 16:20」、带时区的 ISO，或毫秒）；不写 = 不限 */
  from?: number | string;
  until?: number | string;
  /** 加这一条的日期和原因（代码不读，给人看：这是临时的止血带，到期复查） */
  note?: string;
}

interface Fold { find: string; say: string; word?: string; lower: string; re: RegExp; from: number | null; until: number | null }

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class PromptFolds {
  private readonly list: readonly Fold[];

  constructor(list: readonly unknown[] = [], timezone = "UTC") {
    const out: Fold[] = [];
    for (const raw of list) {
      const f = raw as PromptFold | null;
      if (!f || typeof f.find !== "string" || f.find.trim() === "" || typeof f.say !== "string") continue;
      let from: number | null = null;
      let until: number | null = null;
      try {
        if (f.from !== undefined) from = parseTime(f.from, timezone);
        if (f.until !== undefined) until = parseTime(f.until, timezone);
      } catch { continue; }   // 时间写坏了：这一条不用（宁可不折，也不在不知道的时间段里乱折）
      out.push({ find: f.find, say: f.say, ...(f.word !== undefined ? { word: f.word } : {}), lower: f.find.toLowerCase(), re: new RegExp(escape(f.find), "gi"), from, until });
    }
    this.list = out;
  }

  get empty(): boolean { return this.list.length === 0; }

  /** 这一条在 [start, end] 这段时间里能不能用：不限时间的总能用；限了时间的要跟这段有重叠，不知道时间就不用 */
  private usable(f: Fold, start?: number, end: number | undefined = start): boolean {
    if (f.from === null && f.until === null) return true;
    if (start === undefined || end === undefined) return false;
    return (f.until === null || start <= f.until) && (f.from === null || end >= f.from);
  }

  /** 第一条命中的（ts：这条记录的时间，限时间段的条目按它判）；都没命中给 null */
  hit(text: string, ts?: number): { say: string; word?: string } | null {
    if (this.empty || !text) return null;
    const t = text.toLowerCase();
    return this.list.find((f) => t.includes(f.lower) && this.usable(f, ts)) ?? null;
  }

  /** 整条：命中就换成那条的 say，不然原样 */
  whole(text: string, ts?: number): string {
    return this.hit(text, ts)?.say ?? text;
  }

  /** 只换字：每个命中的说法都换成它的短语（word，没有就 say），别的字原样 */
  words(text: string, ts?: number): string {
    if (this.empty || !text) return text;
    let out = text;
    for (const f of this.list) if (this.usable(f, ts)) out = out.replace(f.re, f.word ?? f.say);
    return out;
  }

  /** 按行：命中的那一行整行换成 say（留着行首的「- 」），别的行原样。range：这段文字是哪段时间的（压缩块按那一页的起止） */
  lines(text: string, range?: readonly [number, number]): string {
    if (this.empty || !text) return text;
    return text.split("\n").map((line) => {
      const t = line.toLowerCase();
      const f = this.list.find((x) => t.includes(x.lower) && this.usable(x, range?.[0], range?.[1]));
      if (!f) return line;
      const lead = /^(\s*[-*]\s+)/.exec(line)?.[1] ?? "";
      return `${lead}${f.say}`;
    }).join("\n");
  }

  /** 一条中央记忆进提示时的样子：真人的话只换字，别的命中就整条换；没命中原样返回同一个对象 */
  entry(e: Entry): Entry {
    if (this.empty) return e;
    if (e.kind === "input" && e.meta?.human === true) {
      const text = this.words(e.text, e.ts);
      return text === e.text ? e : { ...e, text };
    }
    const f = this.hit(e.text, e.ts);
    return f ? { ...e, text: f.say } : e;
  }
}
