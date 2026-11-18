// 她自己记下的「不自然的词」（#0015）：她工作区里的一个 Markdown 文件，词和理由都是她的数据，HH 不带词。
// 发消息之前对一遍：message 工具对上了先不发、告诉她一句（原样再发照发）；最终回复发出去以后记一笔提醒她。
import type { Logger } from "../log.ts";

export interface ListedWord { word: string; reason: string }

/**
 * 只认「- 」开头的行：第一个「｜」或「|」前面是词、后面是理由（都去掉首尾空白，理由可以空）；
 * 别的行、空词跳过；同一个词写了两遍只留第一条
 */
export function parseWordList(text: string): ListedWord[] {
  const out: ListedWord[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("- ")) continue;
    const body = line.slice(2);
    const cut = body.search(/[｜|]/);
    const word = (cut < 0 ? body : body.slice(0, cut)).trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push({ word, reason: cut < 0 ? "" : body.slice(cut + 1).trim() });
  }
  return out;
}

/** 这段话里出现了词表里的哪些词（照原样找子串，按词表的顺序） */
export function wordHits(list: readonly ListedWord[], text: string): ListedWord[] {
  return text ? list.filter((w) => text.includes(w.word)) : [];
}

/** 词表文件：mtime 变了才重读；没有、读不了就不查（每个 mtime 最多记一次 warn）；path 为 null（没配）不查 */
export class WordList {
  private readonly path: string | null;
  private readonly read: (p: string) => string | null;
  private readonly mtime: (p: string) => number | null;
  private readonly log: Pick<Logger, "warn">;
  private seen: number | null | undefined = undefined;   // undefined：还没看过
  private words: ListedWord[] = [];

  constructor(o: { path: string | null; read: (p: string) => string | null; mtime: (p: string) => number | null; log: Pick<Logger, "warn"> }) {
    this.path = o.path; this.read = o.read; this.mtime = o.mtime; this.log = o.log;
  }

  current(): ListedWord[] {
    const path = this.path;
    if (!path) return [];
    let mt: number | null;
    try { mt = this.mtime(path); } catch { mt = null; }
    if (mt === this.seen) return this.words;
    this.seen = mt;
    this.words = [];
    if (mt === null) { this.log.warn("word list: no file, not checking", { path }); return this.words; }
    let raw: string | null;
    try { raw = this.read(path); } catch { raw = null; }
    if (raw === null) { this.log.warn("word list: file unreadable, not checking", { path }); return this.words; }
    this.words = parseWordList(raw);
    return this.words;
  }
}
