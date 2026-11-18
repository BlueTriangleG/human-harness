// 基底神经节：多件想做的事里只放行一件。
// - 认领：做一件事前登记，别人已经认领的就不放行
// - 唯一出口：谁能对外说话
import type { Db } from "../store/db.ts";
import type { RegionSpec } from "../regions/specs.ts";
import { B } from "../lang/index.ts";

export const SHORT_REPLY_MAX = 40;

export class Claims {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  /** 认领成功返回 null；已被别人认领返回占用者 */
  claim(topic: string, owner: string): string | null {
    const cur = this.db.prepare("SELECT owner FROM claims WHERE topic = ?").get(topic) as { owner: string } | undefined;
    if (cur && cur.owner !== owner) return cur.owner;
    this.db.prepare("INSERT INTO claims (topic, owner, since) VALUES (?, ?, ?) ON CONFLICT(topic) DO UPDATE SET since = excluded.since").run(topic, owner, this.now());
    return null;
  }

  release(topic: string, owner: string): boolean {
    const r = this.db.prepare("DELETE FROM claims WHERE topic = ? AND owner = ?").run(topic, owner);
    return Number(r.changes) > 0;
  }

  /** 某个实例退场时，它认领的事全部释放 */
  releaseAll(owner: string): number {
    return Number(this.db.prepare("DELETE FROM claims WHERE owner = ?").run(owner).changes);
  }

  list(): Array<{ topic: string; owner: string; since: number }> {
    return this.db.prepare("SELECT topic, owner, since FROM claims ORDER BY since").all() as Array<{ topic: string; owner: string; since: number }>;
  }
}

/** 唯一出口：返回拒绝理由，或者 undefined = 放行 */
export function outletDecision(spec: RegionSpec, tool: string, input: unknown): string | undefined {
  if (tool !== "message") return undefined;
  if (spec.outlet === "full") return undefined;
  if (spec.outlet === "short") {
    const text = typeof (input as { message?: unknown })?.message === "string" ? (input as { message: string }).message : "";
    return text.length <= SHORT_REPLY_MAX
      ? undefined
      : B.claims.shortReplyTooLong(SHORT_REPLY_MAX);
  }
  return B.claims.outletClosed;
}
