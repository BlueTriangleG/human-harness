// 潜意识门：感官事件进 HH 先落库（交接即确认），再按 固定规则 → 她的规则 → 小判断 分流。
// 不用判断的当场落定当场送；只有要小判断的排进串行的处理链。
// 任何一步出错、超时、额度把关停了小判断，本该判的都退回直达主意识（宁可吵，不可丢）。
// 例外（主人 11-12 批 #0070 那批）：额度停判、判两回都没判出来时，群里的、不是 主人 说的那几条先进今天的总结，不直达
// （只在每日总结开着时：gate.digest 关着就没有总结可进，照旧直达）。
import type { Config } from "../config.ts";
import type { AskResult } from "../kernel/types.ts";
import type { Logger } from "../log.ts";
import { People } from "../persona/people.ts";
import { DEFAULT_WEIGHTS, units } from "../sleep/budget.ts";
import type { Weights } from "../sleep/budget.ts";
import { all, one } from "../store/db.ts";
import type { Db } from "../store/db.ts";
import type { Sources } from "./sources.ts";
import { fixedRoute, knownOf } from "./fixed.ts";
import type { JudgeItem, Verdict } from "./judge.ts";
import type { Rules } from "./rules.ts";
import type { SenseEvent, When } from "./types.ts";
import { G } from "../lang/index.ts";

export interface Delivery { ev: SenseEvent; rowId: number; gist?: string; when: When; priority: boolean; urgent?: string; who?: { key: string; name: string; byDisplayName: boolean }; fallback?: string }
export interface GateSinks {
  toMain(items: Delivery[]): void;   // 马上送（when=now）；Brain 负责忙时的排队
  toHands(ev: SenseEvent): void;     // cc，照现在的帮手路由
}
/** 小判断：context(conv, src) 给群聊语境（闸门从账本里取），Brain 接 judgeBatch */
export type JudgeFn = (items: JudgeItem[], context: (conv: string, src: string) => string[]) => Promise<{ verdicts: Map<string, Verdict>; usage: AskResult["usage"] }>;
export interface GateStats { received: number; byRoute: Record<string, number>; byVerdict: Record<string, number>; byRule: Record<string, number>; judgeCalls: number; tokens: number; units: number; toMain: number; paused: string | null }
export interface ReplayResult { ev: SenseEvent; route: string; rule: string | null; verdict?: Verdict }

interface Row { id: number; ts: number; ev_id: string; src: string; conv: string | null; sender: string | null; line: string; ev: string; gist: string | null; state: string }
/** 落了库、等分流的一条 */
interface Incoming { id: number; ts: number; ev: SenseEvent }

// 分流：固定规则和她的规则当场定，只有 judge 要等小判断。action 列：她的规则的 action，固定规则记 fixed-main / hands / judge-floor
type Route =
  | { kind: "hands" }
  | { kind: "main"; route: "fixed-main" | "rule"; rule: string | null; action: string; when: When; priority: boolean; urgent?: string; who?: Delivery["who"] }
  | { kind: "judge"; rule: string | null; action: string; item: JudgeItem }
  | { kind: "log"; rule: string | null; action: string }
  | { kind: "fallback"; rule: string | null; action: string | null; reason: string };

/** 排进处理链等小判断的一条 */
interface JudgeEntry { id: number; ts: number; ev: SenseEvent; rule: string | null; action: string; item: JudgeItem }
/** 落定一行要写的东西 */
interface Done { route: string; rule: string | null; action: string | null; verdict?: string; when?: When; gist?: string; why?: string; unsure?: boolean; delivered?: boolean }
/** 要马上送主意识的：先落定再送 */
interface Ready { done: Done; d: Delivery }

// 小判断挂了一次（超时、出错）就先停 5 分钟：排在后面的不再一个个等 60 秒（final review M3）；停着时和额度停判一样，群里不是 主人 说的先进总结，别的直接给她（CEO 11-13）
const BROKEN_MS = 5 * 60_000;
const DAY_MS = 24 * 3600_000;
/** 小判断用的是 Haiku 档（框架事实）：换算「单位」时的模型 */
const JUDGE_MODEL = "haiku" as const;
// 「她的规则看过」的 action：byRule 只数这些，固定规则的行不算进任何规则
const RULE_ACTIONS = ["main", "judge", "digest", "drop"];
// 这些来源没有上游的 id（id 是正文的哈希）：同样的提醒过几天再来一次也得送，去重只在同一时刻内
export const NO_UPSTREAM_ID: ReadonlySet<string> = new Set(["plain", "hh-quota"]);
// 名单读不了时拿它跑固定规则：cc、总是直达的来源、@ 这些不靠名单的照常走
const NOBODY = new People({});

// 退回原因只留第一行、截短：小判断的报错可能带一大段
const short = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 120);

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

function evOf(r: Row): SenseEvent {
  try {
    const e = JSON.parse(r.ev) as SenseEvent;
    if (e && typeof e === "object") return e;
  } catch { /* 用列里的拼一个 */ }
  return { src: r.src, id: r.ev_id, text: r.line, line: r.line, ...(r.conv ? { conv: r.conv } : {}), ...(r.sender ? { sender: r.sender } : {}) };
}

function fallbackOf(ev: SenseEvent, rowId: number, rule: string | null, action: string | null, reason: string): Ready {
  return { done: { route: "fallback", rule, action, when: "now", why: reason, delivered: true }, d: { ev, rowId, when: "now", priority: false, fallback: reason } };
}

/** 判不了、先进总结的那一行：落定不送，verdict 记 digest（每日总结和控制台都按它算「进总结」），原因写清是哪种判不了 */
function heldOf(en: JudgeEntry, reason: string): Done {
  return { route: "fallback", rule: en.rule, action: en.action, verdict: "digest", why: `${reason}${G.gate.heldToDigestSuffix}` };
}

/** 她的规则写了 ifUnsure: digest：判成 main 但拿不准的改成进总结（底线条目不改）。这是她自己选的，跟 action: digest 一样，不看总结开没开 */
function settle(v: Verdict, item: JudgeItem): Verdict {
  if (v.verdict !== "main" || !v.unsure || item.floor || item.hit.ifUnsure !== "digest") return v;
  return { ...v, verdict: "digest", why: `${v.why}${G.gate.heldUnsureToDigestSuffix}` };
}

export class Gate {
  private readonly db: Db;
  private readonly cfg: Config["gate"];
  private readonly people: () => People;
  private readonly rules: Rules;
  private readonly judge: JudgeFn;
  /** 额度把关：停判时给原因（Brain 接的是这周的额度线）；算额度停判，群里的、不是 主人 说的先进总结（小判断挂了的停判也一样） */
  private readonly paused: () => string | null;
  private readonly sinks: GateSinks;
  private readonly now: () => number;
  private readonly log: Logger;
  // 小判断串行：一批判完、落定、送完，下一批才开始（批与批不交错）
  private chain: Promise<void> = Promise.resolve();
  // 排着等小判断、还没轮到的：处理链每走一步把这时候排着的全拿走、按 batchMax 分批判（来得再碎也不会一条一判，final review I2）
  private waiting: JudgeEntry[] = [];
  // 小判断上次挂掉以后停到什么时候（毫秒）
  private brokenUntil = 0;
  // 花费换算的权重（睡眠预算那一套，配置里 sleep.weights）
  private readonly weights: Weights;
  // 通道表（实例配置 senses.sources，sources.ts）：哪个来源是聊天、探针、一律直达、帮手
  private readonly sources: Sources;
  // the role's names (config names): who "@me" is
  private readonly names: Config["names"];

  constructor(o: { db: Db; cfg: Config["gate"]; names: Config["names"]; sources: Sources; people: () => People; rules: Rules; judge: JudgeFn; paused: () => string | null; sinks: GateSinks; now: () => number; log: Logger; weights?: Weights }) {
    this.db = o.db; this.cfg = o.cfg; this.names = o.names; this.sources = o.sources; this.people = o.people; this.rules = o.rules; this.judge = o.judge;
    this.paused = o.paused; this.sinks = o.sinks; this.now = o.now; this.log = o.log;
    this.weights = o.weights ?? DEFAULT_WEIGHTS;
  }

  /** 同步落库（ev_id 去重：见过的整条跳过），不用判断的当场送，要判断的排进处理链 */
  receive(evs: SenseEvent[]): void {
    const ts = this.now();
    const list: Array<Incoming | Delivery> = [];
    for (const ev of evs) {
      try {
        // 只有 ev_id 撞了才跳过；别的约束（比如缺 line）要抛出来走下面的直达
        const r = this.db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(ev_id) DO NOTHING")
          .run(ts, NO_UPSTREAM_ID.has(ev.src) ? `${ev.id}@${ts}` : ev.id, ev.src, ev.conv ?? null, ev.sender ?? null, ev.line, JSON.stringify(ev));
        if (r.changes) list.push({ id: Number(r.lastInsertRowid), ts, ev });
      } catch (e) {
        // 记不了账也不能丢：直接给主意识
        this.log.error("gate: cannot log event, straight to main", { id: ev?.id, err: short(e) });
        list.push({ ev, rowId: 0, when: "now", priority: false, fallback: G.gate.fallbackLogFailed(short(e)) });
      }
    }
    this.dispatch(list);
  }

  /** 启动时：state 不是 done 的行（还没分流、判到一半）按 id 顺序再分流一次，和 receive 一样拆开 */
  recover(): void {
    let rows: Row[];
    try {
      rows = all<Row>(this.db, "SELECT * FROM gate_log WHERE state != 'done' ORDER BY id");
    } catch (e) {
      this.log.error("gate: recover failed", { err: short(e) });
      return;
    }
    if (!rows.length) return;
    this.log.info("gate: recovering pending rows", { n: rows.length });
    this.dispatch(rows.map((r) => ({ id: r.id, ts: r.ts, ev: evOf(r) })));
  }

  /** 处理链清空时 resolve（等的时候又排进来的也等） */
  async idle(): Promise<void> {
    let c: Promise<void>;
    do { c = this.chain; await c; } while (c !== this.chain);
  }

  /** 还没送的 work / leisure（最老的先）；只取不标，送了由 markDelivered 标。work 放太久的先转成 leisure */
  takeQueued(kind: "work" | "leisure", max: number): Delivery[] {
    try {
      const cutoff = this.now() - this.cfg.workMaxAgeHours * 3600_000;
      this.db.prepare("UPDATE gate_log SET when_ = 'leisure' WHERE when_ = 'work' AND delivered IS NULL AND state = 'done' AND ts < ?").run(cutoff);
      const rows = all<Row>(this.db, "SELECT * FROM gate_log WHERE when_ = ? AND delivered IS NULL AND state = 'done' ORDER BY ts, id LIMIT ?", kind, Math.max(0, Math.floor(max)));
      return rows.map((r) => ({ ev: evOf(r), rowId: r.id, ...(r.gist ? { gist: r.gist } : {}), when: kind, priority: false }));
    } catch (e) {
      // 叫醒时顺带取的：取不到就这次不带，不能把叫醒弄坏
      this.log.error("gate: takeQueued failed", { kind, err: short(e) });
      return [];
    }
  }

  /** 送到了：记下中央记忆的编号；已经马上送过的保留原来的送达时间 */
  markDelivered(rowIds: number[], seq: number): void {
    if (!rowIds.length) return;
    try {
      this.db.prepare(`UPDATE gate_log SET seq = ?, delivered = COALESCE(delivered, ?) WHERE id IN (${rowIds.map(() => "?").join(",")})`)
        .run(seq, this.now(), ...rowIds);
    } catch (e) {
      // 也在叫醒的路上：标不上最多下次再附一遍，不能把叫醒弄坏
      this.log.error("gate: markDelivered failed", { rowIds, err: short(e) });
    }
  }

  /**
   * 最近 24 小时（滚动）小判断花的「单位」（睡眠预算的换算：缓存读 1/10、模型倍数）。
   * 迁移前的老行没有分项（units 为 NULL），按 tokens × haiku 倍数估：11-05/06 的日志量过，
   * 不乘模型倍数的加权和约是原始 tokens 的 92%，所以这个估法略偏保守
   */
  todayUnits(): number {
    return one<{ n: number }>(this.db, "SELECT COALESCE(SUM(COALESCE(units, tokens * ?)), 0) AS n FROM gate_log WHERE ts >= ?", this.weights.model[JUDGE_MODEL], this.now() - DAY_MS)!.n;
  }

  /** [from, to) 毫秒区间里的账 */
  stats(from: number, to: number): GateStats {
    const W = "ts >= ? AND ts < ?";
    const count = (extra: string) => one<{ n: number }>(this.db, `SELECT COUNT(*) AS n FROM gate_log WHERE ${W}${extra}`, from, to)!.n;
    const group = (key: string, extra: string) => Object.fromEntries(
      all<{ k: string; n: number }>(this.db, `SELECT ${key} AS k, COUNT(*) AS n FROM gate_log WHERE ${W}${extra} GROUP BY k ORDER BY k`, from, to).map((r) => [r.k, r.n]),
    );
    return {
      received: count(""),
      byRoute: group("COALESCE(route, 'pending')", ""),
      byVerdict: group("verdict", " AND verdict IS NOT NULL AND route = 'judge'"),   // 小判断的结论；判不了先进总结的（route fallback）不算
      byRule: group("COALESCE(rule, 'default')", ` AND action IN (${RULE_ACTIONS.map((a) => `'${a}'`).join(",")})`),
      judgeCalls: count(" AND tokens > 0"),
      tokens: one<{ n: number }>(this.db, `SELECT COALESCE(SUM(tokens), 0) AS n FROM gate_log WHERE ${W}`, from, to)!.n,
      units: one<{ n: number }>(this.db, `SELECT COALESCE(SUM(COALESCE(units, tokens * ?)), 0) AS n FROM gate_log WHERE ${W}`, this.weights.model[JUDGE_MODEL], from, to)!.n,   // 老行同 todayUnits 的估法
      toMain: count(" AND when_ IS NOT NULL"),   // 去主意识的行（不管哪条路、送没送）才有 when_
      paused: this.pauseReason(),
    };
  }

  /**
   * 只判不送、不记账（hh gate replay 用）。重复的 id 和真接手一样只算第一条（plain / hh-quota 除外）。
   * times：每条的时间（毫秒，和 evs 对齐）；给了群聊语境才按 convContextMinutes 截，不给就不截。
   * 和真接手不一样的地方：漏判的不再问一次，停判时不分哪些先进总结——这两种都报成 fallback（真接手里群里的那几条会先进总结）
   */
  async replay(evs: SenseEvent[], times?: number[]): Promise<ReplayResult[]> {
    const seen = new Set<string>();
    const list: Array<{ ev: SenseEvent; t: number | undefined }> = [];
    evs.forEach((ev, i) => {
      if (!NO_UPSTREAM_ID.has(ev.src)) {
        if (seen.has(ev.id)) return;
        seen.add(ev.id);
      }
      list.push({ ev, t: times?.[i] });
    });
    const people = this.peopleNow();
    const out: ReplayResult[] = [];
    const toJudge: Array<{ i: number; item: JudgeItem; rule: string | null }> = [];
    list.forEach(({ ev }, i) => {
      const r = this.route(ev, people);
      if (r.kind === "hands") out.push({ ev, route: "hands", rule: null });
      else if (r.kind === "main") out.push({ ev, route: r.route, rule: r.rule });
      else if (r.kind === "log") out.push({ ev, route: "rule", rule: r.rule });
      else if (r.kind === "fallback") out.push({ ev, route: "fallback", rule: r.rule });
      else { out.push({ ev, route: "fallback", rule: r.rule }); toJudge.push({ i, item: r.item, rule: r.rule }); }   // 判出来再改
    });
    if (!toJudge.length || this.pauseReason()) return out;
    const n = Math.max(0, Math.floor(this.cfg.convContext));
    for (const chunk of chunks(toJudge, this.batchMax())) {
      const first = chunk[0]!.i;
      const t0 = list[first]!.t;
      const since = t0 === undefined ? undefined : t0 - this.cfg.convContextMinutes * 60_000;
      // 没有账本可查：语境用输入里更早的同会话（同平台）那几条
      const ctx = (conv: string, src: string) => (n
        ? list.slice(0, first).filter((x) => x.ev.conv === conv && x.ev.src === src && (since === undefined || (x.t !== undefined && x.t >= since))).slice(-n).map((x) => x.ev.line)
        : []);
      try {
        const { verdicts } = await this.callJudge(chunk.map((c) => c.item), ctx);
        for (const c of chunk) {
          const v = verdicts.get(c.item.ev.id);
          if (v) out[c.i] = { ev: c.item.ev, route: "judge", rule: c.rule, verdict: settle(v, c.item) };
        }
      } catch (e) {
        this.log.warn("gate replay: judge failed", { err: short(e) });
      }
    }
    return out;
  }

  // ---- 内部 ----

  /** 分流：不用判断的当场落定、当场送（一次 toMain），cc 交给帮手；要判断的排进处理链 */
  private dispatch(list: Array<Incoming | Delivery>): void {
    const people = this.peopleNow();
    const direct: Array<Ready | Delivery> = [];
    const toJudge: JudgeEntry[] = [];
    for (const x of list) {
      if ("rowId" in x) { direct.push(x); continue; }   // 没落上库的，原样直达
      try {
        const r = this.route(x.ev, people);
        if (r.kind === "hands") this.handOff(x.id, x.ev);
        else if (r.kind === "main") {
          const done: Done = { route: r.route, rule: r.rule, action: r.action, when: r.when, delivered: r.when === "now" };
          if (r.when === "now") {
            direct.push({ done, d: { ev: x.ev, rowId: x.id, when: "now", priority: r.priority, ...(r.urgent ? { urgent: r.urgent } : {}), ...(r.who ? { who: r.who } : {}) } });
          } else {
            this.finish(x.id, done);   // work / leisure：落定不送，等 takeQueued
          }
        } else if (r.kind === "log") this.finish(x.id, { route: "rule", rule: r.rule, action: r.action });
        else if (r.kind === "fallback") direct.push(fallbackOf(x.ev, x.id, r.rule, r.action, r.reason));
        else toJudge.push({ id: x.id, ts: x.ts, ev: x.ev, rule: r.rule, action: r.action, item: r.item });
      } catch (e) {
        // 这一行落定时出错（多半是库）：退回直达
        this.log.error("gate: dispatch failed for a row, straight to main", { id: x.ev.id, err: short(e) });
        direct.push(fallbackOf(x.ev, x.id, null, null, G.gate.fallbackDispatchFailed(short(e))));
      }
    }
    this.deliver(direct);
    if (!toJudge.length) return;
    this.waiting.push(...toJudge);
    this.chain = this.chain.then(() => this.judgeWaiting()).catch((e) => { this.log.error("gate: chain error", { err: short(e) }); });
  }

  /** 处理链的一步：排着的全拿走（同一行排了两次只判一次）；前一步已经拿光了就什么都不做 */
  private async judgeWaiting(): Promise<void> {
    const seen = new Set<number>();
    const entries = this.waiting.splice(0).filter((en) => !seen.has(en.id) && !!seen.add(en.id));
    if (entries.length) await this.judgeAll(entries);
  }

  private async judgeAll(entries: JudgeEntry[]): Promise<void> {
    const ready = new Map<number, Ready>();
    let todo = entries;
    try {
      // 从库里重读：别的处理（恢复）已经落定的行不再判
      todo = entries.filter((en) => { const r = this.row(en.id); return !!r && r.state !== "done"; });
      for (const chunk of chunks(todo, this.batchMax())) await this.judgeChunk(chunk, ready);
    } catch (e) {
      // 意外出错：判好的照判好的送，还没判的退回直达，不能卡在库里等下次重启
      this.log.error("gate: judging failed, falling back to main", { err: short(e) });
      for (const en of todo) if (!ready.has(en.id)) ready.set(en.id, fallbackOf(en.ev, en.id, en.rule, en.action, G.gate.fallbackDispatchFailedAtJudging(short(e))));
    }
    this.deliver(todo.flatMap((en) => ready.get(en.id) ?? []));
  }

  private async judgeChunk(chunk: JudgeEntry[], ready: Map<number, Ready>): Promise<void> {
    const p = this.pause();
    if (p) {
      // 额度停判（主人 11-12）、小判断挂了的停判（CEO 11-13）：群里的、不是 主人 说的先进总结；别的照旧直达。看不清额度那种照旧全直达
      for (const c of chunk) {
        if (p.hold && this.canHold(c)) this.finish(c.id, heldOf(c, p.held ?? p.reason));
        else ready.set(c.id, fallbackOf(c.ev, c.id, c.rule, c.action, p.reason));
      }
      return;
    }
    const ids = chunk.map((c) => c.id);
    this.db.prepare(`UPDATE gate_log SET state = 'judging' WHERE state != 'done' AND id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    let verdicts: Map<string, Verdict>;
    try {
      verdicts = await this.judgeOnce(chunk, chunk[0]!.id);
    } catch (e) {
      this.brokenUntil = this.now() + BROKEN_MS;
      this.log.warn("gate: judge failed, batch falls back to main; judging paused 5 min", { n: chunk.length, err: short(e) });
      // 这批本身和停着时一样：群里的、不是 主人 说的先进总结，别的直达（11-13 20:21 那次一条超时，后面 5 分钟 12 条群话全送到她面前）
      for (const c of chunk) {
        if (this.canHold(c)) this.finish(c.id, heldOf(c, short(e)));
        else ready.set(c.id, fallbackOf(c.ev, c.id, c.rule, c.action, short(e)));
      }
      return;
    }
    const take = (c: JudgeEntry, raw: Verdict): void => {
      const v = settle(raw, c.item);
      const toMain = v.verdict === "main";
      const now = toMain && v.when === "now";
      const done: Done = { route: "judge", rule: c.rule, action: c.action, verdict: v.verdict, ...(toMain ? { when: v.when } : {}), gist: v.gist, why: v.why, unsure: v.unsure, delivered: now };
      if (now) ready.set(c.id, { done, d: { ev: c.ev, rowId: c.id, gist: v.gist, when: "now", priority: false } });
      else this.finish(c.id, done);
    };
    const missed: JudgeEntry[] = [];
    for (const c of chunk) {
      const raw = verdicts.get(c.ev.id);
      if (raw) take(c, raw); else missed.push(c);
    }
    if (!missed.length) return;
    // 漏判的再问一次（只问漏的那几条）。先把已经判成马上看的送出去（连前面几批攒着的，按先后），别让它们陪着再等一次
    const early = [...ready.values()];
    ready.clear();
    this.deliver(early);
    // 这次的用量记在漏判里不是这批第一行的那一行（第一行记着第一次）；只漏了第一行就只能并在一起，judgeCalls 少算一次
    const again = await this.judgeAgain(missed, (missed.find((c) => c.id !== chunk[0]!.id) ?? missed[0]!).id);
    // 还漏、或者这时停了判、或者这次出错：群里的先进总结（总结开着时），别的直达
    for (const c of missed) {
      const raw = again.get(c.ev.id);
      if (raw) take(c, raw);
      else if (this.canHold(c)) this.finish(c.id, heldOf(c, G.gate.judgeNoVerdict));
      else ready.set(c.id, fallbackOf(c.ev, c.id, c.rule, c.action, G.gate.judgeNoVerdict));
    }
  }

  /**
   * 问一次小判断；记一行日志，把这次的 token 和单位记在 usageRow 那一行（judgeCalls 数 tokens > 0 的行，所以两次记在同一行时少算一次）。
   * 小判断出错就抛出；记账出错只记一笔，判出来的照用
   */
  private async judgeOnce(entries: JudgeEntry[], usageRow: number): Promise<Map<string, Verdict>> {
    const t0 = this.now();
    const res = await this.callJudge(entries.map((c) => c.item), this.contextFor(entries[0]!));
    try {
      // 观察日那天要看每次花了多少（final review M6）
      const u = res.usage;
      const usage = { input: u?.input ?? 0, cacheRead: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0, output: u?.output ?? 0 };
      const cost = units(usage, JUDGE_MODEL, this.weights);
      this.log.info("gate: judged", { items: entries.length, ...usage, units: cost, ms: this.now() - t0 });
      const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
      if (tokens > 0) this.db.prepare("UPDATE gate_log SET tokens = tokens + ?, units = COALESCE(units, 0) + ? WHERE id = ?").run(tokens, cost, usageRow);
    } catch (e) {
      this.log.error("gate: cannot record judge usage", { err: short(e) });
    }
    return res.verdicts;
  }

  /** 漏判的再问一次：这时停了判就不问；出错和第一次出错一样停 5 分钟，这几条算还是没判出来。又是一条都没判出来就记 warn（小判断的输出格式可能坏了） */
  private async judgeAgain(missed: JudgeEntry[], usageRow: number): Promise<Map<string, Verdict>> {
    if (this.pause()) return new Map();
    try {
      const got = await this.judgeOnce(missed, usageRow);
      const n = missed.filter((c) => got.has(c.ev.id)).length;
      if (n === 0) this.log.warn("gate: judge missed items again on the second ask", { n: missed.length });
      else this.log.info("gate: judge missed items, asked again", { n: missed.length, got: n });
      return got;
    } catch (e) {
      this.brokenUntil = this.now() + BROKEN_MS;
      this.log.warn("gate: asking again for missed items failed; judging paused 5 min", { n: missed.length, err: short(e) });
      return new Map();
    }
  }

  /** 小判断加一道超时：处理是串行的，一次调用挂住会让后面的判断全停下 */
  private callJudge(items: JudgeItem[], context: (conv: string, src: string) => string[]): ReturnType<JudgeFn> {
    let p: ReturnType<JudgeFn>;
    try { p = this.judge(items, context); } catch (e) { return Promise.reject(e); }
    const ms = this.cfg.judgeTimeoutMs;
    if (!(ms > 0)) return p;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(G.gate.judgeTimedOut)), ms);
      timer.unref?.();
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }

  /** 群聊语境：这批第一行之前、同一平台同一会话、convContextMinutes 内最近 convContext 条的原文，老的在前 */
  private contextFor(first: JudgeEntry): (conv: string, src: string) => string[] {
    const n = Math.max(0, Math.floor(this.cfg.convContext));
    const since = first.ts - this.cfg.convContextMinutes * 60_000;
    return (conv, src) => {
      if (!n) return [];
      try {
        return all<{ line: string }>(this.db, "SELECT line FROM gate_log WHERE conv = ? AND src = ? AND ts >= ? AND id < ? ORDER BY id DESC LIMIT ?", conv, src, since, first.id, n)
          .map((r) => r.line).reverse();
      } catch (e) {
        this.log.warn("gate: conv context failed", { err: short(e) });
        return [];
      }
    };
  }

  /**
   * 判不了的时候能先放进总结的：每日总结开着，而且是群里的、不是 主人 说的（主人 在群里没 @ 她的是底线条目 floor，照样直达）。
   * @ 她的、认识的人私聊在固定规则里就直达了，排不到小判断。
   * isGroup 是感官层给的：它偶尔把「xx: yy」样子的私聊标成群（fixed.ts 那条），这种陌生人私聊停判时也会先进总结（不丢，只是晚看）
   */
  private canHold(en: JudgeEntry): boolean {
    return this.cfg.digest === true && en.ev.isGroup === true && !en.item.floor;
  }

  private pauseReason(): string | null { return this.pause()?.reason ?? null; }

  /** 停判的原因；hold：停着时群里的、不是 主人 说的先进总结——额度停的（这周的额度线、今天的小判断额度）和小判断挂了的都算，看不清额度的不算（退回直达）；held：先进总结那几行的原因（和送给她的那句不一样时才有） */
  private pause(): { reason: string; hold: boolean; held?: string } | null {
    let r: string | null;
    try { r = this.paused(); } catch (e) { return { reason: G.gate.pauseCheckFailed(short(e)), hold: false }; }   // 看不清额度就当停了：退回直达，不丢
    if (r) return { reason: r, hold: true };
    if (this.now() < this.brokenUntil) return { reason: G.gate.pauseJudgeBrokenSendDirect(G.gate.pauseJudgeBroken), hold: true, held: G.gate.pauseJudgeBroken };
    return this.todayUnits() >= this.cfg.dailyUnits ? { reason: G.gate.pauseDailyQuotaUsed, hold: true } : null;
  }

  private peopleNow(): People | Error {
    try { return this.people(); } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
  }

  private route(ev: SenseEvent, people: People | Error): Route {
    try {
      const f = fixedRoute(ev, people instanceof Error ? NOBODY : people, this.names, this.sources);
      if (f?.kind === "hands") return { kind: "hands" };
      if (f?.kind === "main") return { kind: "main", route: "fixed-main", rule: null, action: "fixed-main", when: "now", priority: f.priority, ...(f.urgent ? { urgent: f.urgent } : {}), ...(f.who ? { who: f.who } : {}) };
      if (people instanceof Error) return { kind: "fallback", rule: null, action: null, reason: G.gate.fallbackPeopleUnreadable(short(people)) };
      // 主人 在群里没 @ 她：她的规则不看，用默认标准判；判 drop 也只会落进总结（floor）
      if (f?.kind === "judge-floor") return { kind: "judge", rule: null, action: "judge-floor", item: { ev, hit: { ruleId: null, action: "judge", when: "now", want: this.cfg.defaultWant }, floor: true } };
      const hit = this.rules.match(ev, knownOf(ev, people));
      if (hit.action === "main") return { kind: "main", route: "rule", rule: hit.ruleId, action: "main", when: hit.when, priority: false };
      if (hit.action === "judge") return { kind: "judge", rule: hit.ruleId, action: "judge", item: { ev, hit, floor: false } };
      return { kind: "log", rule: hit.ruleId, action: hit.action };
    } catch (e) {
      return { kind: "fallback", rule: null, action: null, reason: G.gate.fallbackRoutingFailed(short(e)) };
    }
  }

  private batchMax(): number { return Math.max(1, Math.floor(this.cfg.batchMax) || 1); }

  private row(id: number): Row | undefined {
    return one<Row>(this.db, "SELECT * FROM gate_log WHERE id = ?", id);
  }

  /** 落定一行；已经 done 的不动（返回 false，调用方就不送） */
  private finish(id: number, d: Done): boolean {
    const r = this.db.prepare(
      "UPDATE gate_log SET route = ?, rule = ?, action = ?, verdict = ?, when_ = ?, gist = ?, why = ?, unsure = ?, delivered = ?, state = 'done' WHERE id = ? AND state != 'done'",
    ).run(d.route, d.rule, d.action, d.verdict ?? null, d.when ?? null, d.gist ?? null, d.why ?? null,
      d.unsure === undefined ? null : d.unsure ? 1 : 0, d.delivered ? this.now() : null, id);
    return r.changes > 0;
  }

  /**
   * 先落定再送（一次 toMain）。落定成功的一定送；落定时出错的也送（宁可吵：那行没落定，重启后可能再送一遍，也不能丢）；
   * 已经被别的处理落定的不送
   */
  private deliver(slots: Array<Ready | Delivery>): void {
    const out: Delivery[] = [];
    try {
      for (const s of slots) {
        if (!("done" in s)) { out.push(s); continue; }
        let claimed = true;
        try { claimed = this.finish(s.d.rowId, s.done); } catch (e) {
          this.log.error("gate: cannot mark row done, sending anyway", { id: s.d.ev.id, err: short(e) });
        }
        if (claimed) out.push(s.d);
      }
    } finally {
      this.send(out);
    }
  }

  private send(out: Delivery[]) {
    if (!out.length) return;
    try { this.sinks.toMain(out); } catch (e) {
      this.log.error("gate: toMain failed", { ids: out.map((d) => d.ev.id), err: short(e) });
      this.undelivered(out.map((d) => d.rowId), e);
    }
  }

  /** cc 交给帮手：先落定再交 */
  private handOff(id: number, ev: SenseEvent) {
    if (!this.finish(id, { route: "hands", rule: null, action: "hands", delivered: true })) return;
    try { this.sinks.toHands(ev); } catch (e) {
      this.log.error("gate: toHands failed", { id: ev.id, err: short(e) });
      this.undelivered([id], e);
    }
  }

  /** 送不出去：行还是 done（不重试），但账上写明没送到、为什么 */
  private undelivered(rowIds: number[], e: unknown) {
    const ids = rowIds.filter((id) => id > 0);
    if (!ids.length) return;
    try {
      this.db.prepare(`UPDATE gate_log SET delivered = NULL, why = ? WHERE id IN (${ids.map(() => "?").join(",")})`).run(G.gate.deliveryFailed(short(e)), ...ids);
    } catch (e2) {
      this.log.error("gate: cannot record failed delivery", { err: short(e2) });
    }
  }
}
