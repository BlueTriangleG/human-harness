// 纪元：一页一页地翻。压缩块睡前不重压；睡觉整理后清空。
import type { Db } from "../store/db.ts";
import type { Block } from "../persona/persona.ts";
import { estimateTokens } from "../memory/tokens.ts";

export type EpochReason = "boot" | "page-turn" | "wake";

export interface Epoch { id: number; started: number; reason: EpochReason; firstSeq: number }

export class Epochs {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  current(): Epoch | null {
    const r = this.db.prepare("SELECT id, started, reason, first_seq FROM epochs ORDER BY id DESC LIMIT 1").get() as
      | { id: number; started: number; reason: string; first_seq: number }
      | undefined;
    return r ? { id: Number(r.id), started: Number(r.started), reason: r.reason as EpochReason, firstSeq: Number(r.first_seq) } : null;
  }

  begin(reason: EpochReason, firstSeq: number): Epoch {
    const prev = this.current();
    const id = (prev?.id ?? 0) + 1;
    const started = this.now();
    this.db.prepare("INSERT INTO epochs (id, started, reason, first_seq) VALUES (?, ?, ?, ?)").run(id, started, reason, firstSeq);
    return { id, started, reason, firstSeq };
  }

  /** 当前有效的压缩块（这次醒来以后的），按时间排 */
  blocks(): Block[] {
    const rows = this.db.prepare("SELECT id, text, tokens, created FROM blocks WHERE cleared IS NULL ORDER BY id").all() as Array<{ id: number; text: string; tokens: number; created: number }>;
    return rows.map((r) => ({ id: Number(r.id), text: r.text, tokens: Number(r.tokens), created: Number(r.created) }));
  }

  addBlock(epoch: number, text: string): Block {
    const created = this.now();
    const tokens = estimateTokens(text);
    const r = this.db.prepare("INSERT INTO blocks (epoch, created, text, tokens) VALUES (?, ?, ?, ?)").run(epoch, created, text, tokens);
    return { id: Number(r.lastInsertRowid), text, tokens, created };
  }

  compactedTokens(): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(tokens), 0) AS n FROM blocks WHERE cleared IS NULL").get() as { n: number };
    return Number(r.n);
  }

  /** 睡觉整理完：压缩块全部清空（原文还在中央记忆里） */
  clearBlocks(): number {
    return Number(this.db.prepare("UPDATE blocks SET cleared = ? WHERE cleared IS NULL").run(this.now()).changes);
  }
}
