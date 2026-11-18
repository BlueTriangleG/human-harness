// 丘脑：所有进来的信号先过它，决定送给谁。睡着的时候一律进待办，醒来再处理（睡觉不被叫醒）。
// 另外管两样"时间到了才进来的信号"：她自己排的提醒、以及待办。
import type { SenseEvent } from "../gate/types.ts";
import type { Db } from "../store/db.ts";
import { kvGet, kvSet } from "../store/db.ts";

export interface Inbound {
  from: string;            // 主人 / 朋友 / 系统 / 提醒……
  channel?: string;        // qq / whatsapp / local / internal
  text: string;
  human: boolean;          // 是不是真人发来的
  /** 这个人和她的关系（"主人本人" / "朋友（访客）…" / "陌生人…"），渠道消息才有 */
  relation?: string;
  /** 记忆里的简短标注（朋友 / 陌生人；主人不标） */
  tag?: string;
  /** 指路的文件（workspace 里的相对路径）：人物卡导出的文件，迁移前是名单上的档案 */
  profile?: string;
  /** 群聊里的消息（她回的话群里都看得到） */
  group?: boolean;
  /** 渠道上的发送者号码、OpenClaw 会话键（联想认人用） */
  senderId?: string;
  sessionKey?: string;
  /** 怎么回：channel=qqbot/whatsapp 经 OpenClaw 网关发。group：回的是群（target 是群的会话，name 是群里说话的人） */
  replyTo?: { channel: string; target: string; messageId?: string; name?: string; group?: boolean };
  /** 感官层带字段的事件（解析后存着，路由暂不读） */
  events?: SenseEvent[];
}

export type Route = { kind: "deliver"; region: string; event: Inbound } | { kind: "queue"; event: Inbound };

export class Thalamus {
  private readonly db: Db;
  private readonly now: () => number;
  constructor(db: Db, now: () => number = Date.now) {
    this.db = db;
    this.now = now;
  }

  route(ev: Inbound, asleep: boolean): Route {
    if (asleep) {
      this.db.prepare("INSERT INTO todos (created, payload) VALUES (?, ?)").run(this.now(), JSON.stringify(ev));
      return { kind: "queue", event: ev };
    }
    // 第一版：外界的话都交给主线（文字聊天由主线写）
    return { kind: "deliver", region: "main", event: ev };
  }

  /** 还没处理的待办（不标记；送达后再 markDone，送一半崩了不会丢） */
  pendingTodoItems(): Array<{ id: number; event: Inbound }> {
    const rows = this.db.prepare("SELECT id, payload FROM todos WHERE done IS NULL ORDER BY id").all() as Array<{ id: number; payload: string }>;
    return rows.map((r) => ({ id: Number(r.id), event: JSON.parse(r.payload) as Inbound }));
  }

  markDone(id: number): void {
    this.db.prepare("UPDATE todos SET done = ? WHERE id = ?").run(this.now(), id);
  }

  pendingTodos(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM todos WHERE done IS NULL").get() as { n: number };
    return Number(r.n);
  }
}

export interface ScheduleItem { id: number; kind: "remind" | "focus"; due: number; everyMs: number | null; text: string; minutes: number | null }

/** 循环提醒「今天已经做过了」记在 kv 的这一个键里：{ 编号: 记下的时间 }（不加表） */
const DONE_KEY = "remind_done";

/** 提醒里写到的脚本，只留文件名（scripts/hot_collect.py → hot_collect.py）：到点时看今天是不是已经碰过 */
export function scriptNames(text: string): string[] {
  const names = [...text.matchAll(/[\w./-]+\.(?:py|sh|js|mjs|ts)\b/g)].map((m) => m[0].split("/").at(-1) ?? "");
  return [...new Set(names.filter((n) => n && !n.startsWith(".")))];
}

/** 文字里提到这个脚本文件名（前面是开头、/、空白或引号，后面不再接 [\w.-]：myfoo.py、foo.py.bak 不算 foo.py） */
export function mentionsScript(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[\\s/"'])${esc}(?![\\w.-])`).test(text);
}

/** 她自己排的提醒和专注 */
export class Schedule {
  private readonly db: Db;
  constructor(db: Db) { this.db = db; }

  add(kind: "remind" | "focus", due: number, text: string, everyMs: number | null = null, minutes: number | null = null): number {
    const r = this.db.prepare("INSERT INTO schedule (kind, due, every_ms, text, minutes) VALUES (?, ?, ?, ?, ?)").run(kind, due, everyMs, text, minutes);
    return Number(r.lastInsertRowid);
  }

  /** 到时间的：一次性的标记已触发，循环的顺延到下一次 */
  takeDue(now: number, kind?: "remind" | "focus"): ScheduleItem[] {
    const rows = (kind
      ? this.db.prepare("SELECT id, kind, due, every_ms, text, minutes FROM schedule WHERE fired IS NULL AND due <= ? AND kind = ? ORDER BY due").all(now, kind)
      : this.db.prepare("SELECT id, kind, due, every_ms, text, minutes FROM schedule WHERE fired IS NULL AND due <= ? ORDER BY due").all(now)) as Array<{ id: number; kind: string; due: number; every_ms: number | null; text: string; minutes: number | null }>;
    for (const r of rows) {
      if (r.every_ms) {
        let next = Number(r.due);
        while (next <= now) next += Number(r.every_ms);
        this.db.prepare("UPDATE schedule SET due = ? WHERE id = ?").run(next, r.id);
      } else {
        this.db.prepare("UPDATE schedule SET fired = ? WHERE id = ?").run(now, r.id);
      }
    }
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind as "remind" | "focus", due: Number(r.due), everyMs: r.every_ms ? Number(r.every_ms) : null, text: r.text, minutes: r.minutes == null ? null : Number(r.minutes) }));
  }

  list(): ScheduleItem[] {
    const rows = this.db.prepare("SELECT id, kind, due, every_ms, text, minutes FROM schedule WHERE fired IS NULL ORDER BY due").all() as Array<{ id: number; kind: string; due: number; every_ms: number | null; text: string; minutes: number | null }>;
    return rows.map((r) => ({ id: Number(r.id), kind: r.kind as "remind" | "focus", due: Number(r.due), everyMs: r.every_ms ? Number(r.every_ms) : null, text: r.text, minutes: r.minutes == null ? null : Number(r.minutes) }));
  }

  remove(id: number): boolean {
    return Number(this.db.prepare("DELETE FROM schedule WHERE id = ?").run(id).changes) > 0;
  }

  /** 记下这个循环提醒在 at 做过了（同一天里到点不叫）；顺手清掉已经不在的编号 */
  setDone(id: number, at: number): void {
    const live = new Set(this.list().map((x) => String(x.id)));
    const marks = Object.entries({ ...this.doneMarks(), [String(id)]: at }).filter(([k]) => live.has(k));
    kvSet(this.db, DONE_KEY, JSON.stringify(Object.fromEntries(marks)));
  }

  /** 这个提醒最后一次记「做过了」的时间；没记过返回 null */
  doneAt(id: number): number | null {
    const v = this.doneMarks()[String(id)];
    return typeof v === "number" ? v : null;
  }

  private doneMarks(): Record<string, number> {
    try {
      const v = JSON.parse(kvGet(this.db, DONE_KEY) ?? "{}") as unknown;
      return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, number>) : {};
    } catch {
      return {};
    }
  }
}
