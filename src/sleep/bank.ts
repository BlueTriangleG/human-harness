// 考试的题库：待定的题、生效的题、改题的待办、考试结果。时间由调用方传进来（毫秒）。
import { all, one, type Db } from "../store/db.ts";
import { touchesTags } from "./things.ts";
import { S } from "../lang/index.ts";

export type Layer = "resident" | "searchable" | "archive";
export type Kind = "fact" | "why" | "feeling" | "taste" | "unsure" | "update";
export interface Tags { who: string[]; events: string[]; files: string[]; lessons: string[] }
export interface QuestionIn {
  q: string; gold: string; accept: string; sources: string[]; tags: Tags;
  importance: number; kind: Kind; layer: Layer; isNew: boolean;
}
export interface Question extends QuestionIn {
  id: string; day: string; stage: string; hidden: boolean;
  status: "pending" | "active" | "retired" | "dropped"; created: number; lastExamined: number | null;
}
export type Verdict = "right" | "partial" | "wrong";
export interface ResultIn {
  q: string; day: string; stage: string; phase: "after" | "retake" | "before" | "final" | "hidden";
  layer: Layer; verdict: Verdict; reason: string; answer: string;
}
export type Op =
  | { kind: "revise"; q: string; gold: string; why: string }
  | { kind: "retire"; q: string; why: string }
  | { kind: "layer"; q: string; layer: Layer; why: string };

interface Row {
  id: string; q: string; gold: string; accept: string; sources: string; tags: string; importance: number;
  kind: Kind; layer: Layer; is_new: number; hidden: number; day: string; stage: string;
  status: Question["status"]; created: number; last_examined: number | null;
}

/** 每种判定记几分：别处算分都用这份 */
export const SCORE: Record<Verdict, number> = { right: 1, partial: 0.5, wrong: 0 };
const LAYERS: Layer[] = ["resident", "searchable", "archive"];
const SEED_KIND: Record<string, Kind> = {
  fact: "fact", temporal: "fact", multi: "fact", abstain: "unsure", update: "update", people: "feeling", taste: "taste",
};
const DAY_MS = 86_400_000;

/** 挑旧题的先后：重要度高的先、同样重要的上次考得早的先（没考过最先），再按题号 */
export const examOrder = (a: Question, b: Question): number => b.importance - a.importance
  || (a.lastExamined ?? -Infinity) - (b.lastExamined ?? -Infinity)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function toQuestion(r: Row): Question {
  const t = JSON.parse(r.tags) as Partial<Tags>;
  return {
    id: r.id, q: r.q, gold: r.gold, accept: r.accept, sources: JSON.parse(r.sources) as string[],
    tags: { who: t.who ?? [], events: t.events ?? [], files: t.files ?? [], lessons: t.lessons ?? [] },
    importance: r.importance, kind: r.kind, layer: r.layer, isNew: r.is_new === 1, day: r.day, stage: r.stage,
    hidden: r.hidden === 1, status: r.status, created: r.created, lastExamined: r.last_examined,
  };
}

const INSERT = `INSERT INTO exam_q (id, q, gold, accept, sources, tags, importance, kind, layer, is_new, hidden, day, stage, status, created, updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

export class Bank {
  private db: Db;
  private now: () => number;
  constructor(db: Db, now: () => number) {
    this.db = db;
    this.now = now;
  }

  private insert(id: string, q: QuestionIn, hidden: boolean, day: string, stage: string, status: string): void {
    const t = this.now();
    this.db.prepare(INSERT).run(id, q.q, q.gold, q.accept, JSON.stringify(q.sources), JSON.stringify(q.tags),
      q.importance, q.kind, q.layer, q.isNew ? 1 : 0, hidden ? 1 : 0, day, stage, status, t, t);
  }

  /** 题号 q:<day>/<stage>/<n>，n 在这一天这一段里接着数 */
  addPending(day: string, stage: string, qs: QuestionIn[], o: { hidden?: boolean } = {}): string[] {
    const prefix = `q:${day}/${stage}/`;
    const rows = all<{ id: string }>(this.db, "SELECT id FROM exam_q WHERE day = ? AND stage = ?", day, stage);
    let n = rows.reduce((m, r) => Math.max(m, Number(r.id.slice(prefix.length)) || 0), 0);
    const ids: string[] = [];
    for (const q of qs) {
      n += 1;
      const id = `${prefix}${n}`;
      this.insert(id, q, o.hidden === true, day, stage, "pending");
      ids.push(id);
    }
    return ids;
  }

  pending(day: string, stage?: string): Question[] {
    const rows = stage === undefined
      ? all<Row>(this.db, "SELECT * FROM exam_q WHERE status = 'pending' AND day = ? ORDER BY rowid", day)
      : all<Row>(this.db, "SELECT * FROM exam_q WHERE status = 'pending' AND day = ? AND stage = ? ORDER BY rowid", day, stage);
    return rows.map(toQuestion);
  }

  get(id: string): Question | null {
    const r = one<Row>(this.db, "SELECT * FROM exam_q WHERE id = ?", id);
    return r ? toQuestion(r) : null;
  }

  /** 这几段的待定题变成生效，再执行这几段记下的 op（一个事务）；返回生效了几道 */
  activate(day: string, stages: string[]): number {
    const t = this.now();
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const stage of stages) {
        n += Number(this.db.prepare("UPDATE exam_q SET status = 'active', updated = ? WHERE status = 'pending' AND day = ? AND stage = ?").run(t, day, stage).changes);
        const ops = all<{ id: number; kind: string; q: string; value: string }>(this.db,
          "SELECT id, kind, q, value FROM exam_op WHERE status = 'pending' AND day = ? AND stage = ? ORDER BY id", day, stage);
        for (const op of ops) this.applyOp(op, t);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  private applyOp(op: { id: number; kind: string; q: string; value: string }, t: number): void {
    const v = JSON.parse(op.value) as { gold?: string; layer?: Layer; why?: string; from?: string };
    const cur = one<{ gold: string }>(this.db, "SELECT gold FROM exam_q WHERE id = ?", op.q);
    let status = "applied";
    if (!cur) status = "dropped";
    else if (op.kind === "revise") {
      this.db.prepare("UPDATE exam_q SET gold = ?, updated = ? WHERE id = ?").run(v.gold ?? "", t, op.q);
      v.from = cur.gold;
    } else if (op.kind === "retire") this.db.prepare("UPDATE exam_q SET status = 'retired', retired_why = ?, updated = ? WHERE id = ?").run(v.why ?? "", t, op.q);
    else if (op.kind === "layer") this.db.prepare("UPDATE exam_q SET layer = ?, updated = ? WHERE id = ?").run(v.layer ?? "searchable", t, op.q);
    this.db.prepare("UPDATE exam_op SET status = ?, value = ? WHERE id = ?").run(status, JSON.stringify(v), op.id);
  }

  /** 丢掉这一天的待定题和待定 op（记成 dropped、不删，题号不会再被用），keep 里的段留着；返回丢了几道题 */
  dropPending(day: string, keep: string[]): number {
    const marks = keep.map(() => "?").join(",");
    const not = keep.length ? ` AND stage NOT IN (${marks})` : "";
    const n = Number(this.db.prepare(`UPDATE exam_q SET status = 'dropped', updated = ? WHERE status = 'pending' AND day = ?${not}`).run(this.now(), day, ...keep).changes);
    this.db.prepare(`UPDATE exam_op SET status = 'dropped' WHERE status = 'pending' AND day = ?${not}`).run(day, ...keep);
    return n;
  }

  /** 待定的题换标准答案（领导判是题的毛病时）；不是待定的不动。返回换没换 */
  reviseGold(id: string, gold: string): boolean {
    return Number(this.db.prepare("UPDATE exam_q SET gold = ?, updated = ? WHERE id = ? AND status = 'pending'").run(gold, this.now(), id).changes) > 0;
  }

  /** 丢掉这几道待定题（记成 dropped；不是待定的不动）；返回丢了几道 */
  dropQuestions(ids: string[]): number {
    if (!ids.length) return 0;
    return Number(this.db.prepare(`UPDATE exam_q SET status = 'dropped', updated = ? WHERE status = 'pending' AND id IN (${ids.map(() => "?").join(",")})`)
      .run(this.now(), ...ids).changes);
  }

  /** 丢掉这一天这几段的待定题和待定 op（记成 dropped）；返回丢了几道题 */
  dropPendingOf(day: string, stages: string[]): number {
    if (!stages.length) return 0;
    const marks = stages.map(() => "?").join(",");
    const n = Number(this.db.prepare(`UPDATE exam_q SET status = 'dropped', updated = ? WHERE status = 'pending' AND day = ? AND stage IN (${marks})`).run(this.now(), day, ...stages).changes);
    this.db.prepare(`UPDATE exam_op SET status = 'dropped' WHERE status = 'pending' AND day = ? AND stage IN (${marks})`).run(day, ...stages);
    return n;
  }

  /** 丢掉这一天这一段还没执行的、这几种的 op（记成 dropped）；给了 qs 就只丢这几道题的；返回丢了几条 */
  dropOps(day: string, stage: string, kinds: Op["kind"][], qs?: Set<string>): number {
    if (!kinds.length || qs?.size === 0) return 0;
    const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
    const only = qs ? ` AND q IN (${marks(qs.size)})` : "";
    return Number(this.db.prepare(`UPDATE exam_op SET status = 'dropped' WHERE status = 'pending' AND day = ? AND stage = ? AND kind IN (${marks(kinds.length)})${only}`)
      .run(day, stage, ...kinds, ...(qs ?? [])).changes);
  }

  /** 这一天这几段还没执行的 op（按记下的先后） */
  pendingOps(day: string, stages: string[]): Op[] {
    if (!stages.length) return [];
    const marks = stages.map(() => "?").join(",");
    return all<{ kind: Op["kind"]; q: string; value: string }>(this.db,
      `SELECT kind, q, value FROM exam_op WHERE status = 'pending' AND day = ? AND stage IN (${marks}) ORDER BY id`, day, ...stages)
      .map((r) => ({ kind: r.kind, q: r.q, ...(JSON.parse(r.value) as object) }) as Op);
  }

  /** 今晚（since 以后记的）这一天的段考过的题（结果表里这一天有全天考试以外的判定）；时刻按结果记下的时候算，不按材料的日子 */
  examinedOn(day: string, since: number): Set<string> {
    return new Set(all<{ q: string }>(this.db, "SELECT DISTINCT q FROM exam_result WHERE day = ? AND phase != 'final' AND at >= ?", day, since).map((r) => r.q));
  }

  /** 这道题在 before 那一刻以前（这一夜开始以前）最后记下的那次判定（按记下的先后）；没有给 null */
  lastVerdictBefore(q: string, before: number): Verdict | null {
    return one<{ verdict: Verdict }>(this.db, "SELECT verdict FROM exam_result WHERE q = ? AND at < ? ORDER BY at DESC, id DESC LIMIT 1", q, before)?.verdict ?? null;
  }

  /** 合 pred 的生效题，照 examOrder 取前 cap 道 */
  where(pred: (q: Question) => boolean, cap: number): Question[] {
    return all<Row>(this.db, "SELECT * FROM exam_q WHERE status = 'active'").map(toQuestion).filter(pred).sort(examOrder).slice(0, cap);
  }

  /** 挂在这些东西上的生效题，照 examOrder 取前 cap 道：出处、标签照 thing 比（touchesTags，跟考试、交题同一个说法；终审修正轮 M4） */
  touching(tags: Partial<Tags>, cap: number): Question[] {
    return all<Row>(this.db, "SELECT * FROM exam_q WHERE status = 'active'").map(toQuestion)
      .filter((q) => touchesTags(q, tags))
      .sort(examOrder)
      .slice(0, cap);
  }

  /** 从生效题里随机抽 n 道，exclude 里的跳过 */
  sample(n: number, rnd: () => number, exclude: Set<string>): Question[] {
    const pool = all<Row>(this.db, "SELECT * FROM exam_q WHERE status = 'active' ORDER BY rowid").map(toQuestion)
      .filter((q) => !exclude.has(q.id));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool.slice(0, n);
  }

  record(r: ResultIn): void {
    const t = this.now();
    this.db.prepare("INSERT INTO exam_result (q, day, stage, phase, layer, verdict, reason, answer, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(r.q, r.day, r.stage, r.phase, r.layer, r.verdict, r.reason, r.answer, t);
    this.db.prepare("UPDATE exam_q SET last_examined = ? WHERE id = ?").run(t, r.q);
  }

  /** 存成待定，落地时由 activate 执行；attempt 是哪一次尝试记的（那一次没过，它的改题、退休就丢掉） */
  addOp(day: string, stage: string, op: Op, attempt?: number): void {
    if (!op.why.trim()) throw new Error(`addOp: ${op.kind} needs a reason`);
    const { kind, q, ...value } = op;
    this.db.prepare("INSERT INTO exam_op (day, stage, kind, q, value, status, created, attempt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(day, stage, kind, q, JSON.stringify(value), this.now(), attempt ?? null);
  }

  /** 这一天这一段第 attempt 次记下、还没执行的 op 有几条 */
  attemptOps(day: string, stage: string, attempt: number): number {
    return one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM exam_op WHERE status = 'pending' AND day = ? AND stage = ? AND attempt = ?", day, stage, attempt)?.n ?? 0;
  }

  /** 丢掉这一天这一段第 attempt 次记下、还没执行的这几种 op（那一次没过）；返回丢了几条 */
  dropAttemptOps(day: string, stage: string, attempt: number, kinds: Op["kind"][]): number {
    if (!kinds.length) return 0;
    return Number(this.db.prepare(`UPDATE exam_op SET status = 'dropped' WHERE status = 'pending' AND day = ? AND stage = ? AND attempt = ? AND kind IN (${kinds.map(() => "?").join(",")})`)
      .run(day, stage, attempt, ...kinds).changes);
  }

  /** 把白天体检格式的题导进来：生效、没有标签；已经导过的题号跳过。返回新导了几道 */
  importSeed(raw: unknown, o: { tag: string; layer: Layer; day: string }): number {
    if (!Array.isArray(raw)) throw new Error("importSeed: expected an array");
    const bad: string[] = [];
    const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
    raw.forEach((x: unknown, i) => {
      const it = (typeof x === "object" && x !== null && !Array.isArray(x) ? x : {}) as Record<string, unknown>;
      const miss = ["id", "q", "gold"].filter((k) => !nonEmpty(it[k]));
      const label = S.bank.seedLabel(i + 1, nonEmpty(it.id) ? String(it.id) : S.bank.seedNoId);
      if (miss.length) bad.push(S.bank.seedMissing(label, miss.join(S.marks.listSep)));
      if (it.importance !== undefined && !(Number.isInteger(it.importance) && (it.importance as number) >= 1 && (it.importance as number) <= 5)) bad.push(S.bank.seedBadImportance(label));
    });
    if (bad.length) throw new Error(bad.join(S.marks.clauseSep));
    let n = 0;
    this.db.exec("BEGIN");
    try {
      for (const item of raw as Array<Record<string, unknown>>) {
        const id = `seed:${o.tag}/${String(item.id)}`;
        if (one(this.db, "SELECT 1 FROM exam_q WHERE id = ?", id)) continue;
        const evidence = Array.isArray(item.evidence) ? item.evidence.map(String) : [];
        this.insert(id, {
          q: String(item.q), gold: String(item.gold), accept: String(item.accept ?? ""), sources: evidence,
          tags: { who: [], events: [], files: [], lessons: [] },
          importance: Number(item.importance ?? 3), kind: SEED_KIND[String(item.type)] ?? "fact", layer: o.layer, isNew: false,
        }, false, o.day, "seed", "active");
        n += 1;
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return n;
  }

  stats(): { active: number; pending: number; retired: number; byLayer: Record<Layer, number>; passRate: Record<Layer, number | null> } {
    const count = (s: string) => one<{ n: number }>(this.db, "SELECT COUNT(*) AS n FROM exam_q WHERE status = ?", s)!.n;
    const byLayer: Record<Layer, number> = { resident: 0, searchable: 0, archive: 0 };
    for (const r of all<{ layer: Layer; n: number }>(this.db, "SELECT layer, COUNT(*) AS n FROM exam_q WHERE status = 'active' GROUP BY layer")) byLayer[r.layer] = r.n;
    const passRate: Record<Layer, number | null> = { resident: null, searchable: null, archive: null };
    const since = this.now() - 30 * DAY_MS;
    const sum: Record<Layer, { n: number; ok: number }> = { resident: { n: 0, ok: 0 }, searchable: { n: 0, ok: 0 }, archive: { n: 0, ok: 0 } };
    for (const r of all<{ layer: Layer; verdict: Verdict; n: number }>(this.db,
      "SELECT layer, verdict, COUNT(*) AS n FROM exam_result WHERE phase = 'after' AND at >= ? GROUP BY layer, verdict", since)) {
      if (!LAYERS.includes(r.layer)) continue;
      sum[r.layer].n += r.n;
      sum[r.layer].ok += r.n * (SCORE[r.verdict] ?? 0);
    }
    for (const l of LAYERS) if (sum[l].n > 0) passRate[l] = sum[l].ok / sum[l].n;
    return { active: count("active"), pending: count("pending"), retired: count("retired"), byLayer, passRate };
  }
}
