// 夜里调参。
// 每晚回测之后跑一次：量这一天的花费、判断耗时、挂了翻没翻，加上回测（只比两晚都判过的老题），按几条规矩最多动两个参数，
// 每次按登记表的步长走、不出上下限（setParam 校验）；上一晚的改动先看它盯的那个数变没变坏，坏了就退回去。
// 规矩（定下的约束）：
// - 频率类（干活时联想多久一次）只按花费和延迟调，不按效果调：又犯一天才几次，太稀，量不出来
// - 门槛、条目数按回测和当天的挂载、翻开调
// - 一天花费的上限（learning.dailyUsd）不归这里管
// 改动都用 setParam 写（by night-tuner），日志在 kv learn.params.log；上一次的改动和当时的数记在 kv learn.tuner.last。
import { all, kvGet, kvSet, type Db } from "../store/db.ts";
import { PARAMS, param, setParam } from "./params.ts";
import { L } from "../lang/index.ts";

export const TUNER = "night-tuner";
const LAST_KEY = "learn.tuner.last";   // {night, changes}：哪一晚调过、改了什么（一个没改也记下这一晚）
const CUTS_KEY = "learn.tuner.cuts";   // {参数名: Cut}：为了快往下减的那一次，当时有多慢（下次还慢，先看上次减了有没有用）
const CUT_MEMORY_DAYS = 30;            // 这么久以前减的不算数了，可以再试
const USD_PER_TOKEN = 0.1 / 1e6;          // 判断（Decisions）输入 $0.10 / 百万 token，同 decisions.ts
const DAY_MS = 24 * 3600_000;
const OPEN_WINDOW_MS = 30 * 60_000;       // 挂上以后多久内翻开算接住
const MAX_CHANGES = 2;
const COLD_AFTER_MS = 60_000;             // 离上一次判断超过这么久算冷（同 associate.ts）

/** 一天的数：花费、在回复路径上的判断（叫醒）慢不慢、挂了翻没翻、干活时联想占多少、回测老题 */
export interface NightMetrics {
  spendUsd: number;
  dailyUsd: number;
  /** 叫醒时的联想：次数、判断没回来（超时、熔断）的比例、热的判断耗时 p90、超时上限 */
  wake: { n: number; judgeFail: number; p90: number; limitMs: number };
  /** 挂上的页、30 分钟内翻开了几页、平均一次联想挂几页 */
  mounted: number;
  opened: number;
  perAssoc: number;
  /** 干活时联想（midwork）花掉的 token 占这一天的多少 */
  midworkShare: number;
  /** 两晚都判过的老题：今晚、前一晚各过了几成；没有可比的为 null */
  replay: { now: number; prev: number; n: number } | null;
}

/** 一次改动：改哪个、改成多少、为什么、要盯哪个数（下一晚看它变没变坏） */
export interface TuneChange { name: string; value: number; why: string; watch: Watch }
/** 改了以后可能伤到哪个数（下一晚看它，坏了就退回）：花费、回测、翻开率；none = 量不出坏处（比如为了省钱把联想调稀，效果太稀量不出） */
type Watch = "spend" | "replay" | "openRate" | "none";
export interface LastChange { night: string; name: string; old: number; value: number; watch: Watch; before: number }
/** 为了快往下减的那一次：哪一晚、减到多少、减之前叫醒判断的热 p90 和没回来的比例 */
export interface Cut { night: string; at: number; value: number; p90: number; fail: number }

/** 上次减了以后快了没有：p90 降了一成以上（两边都量到了热的判断才比），或者没回来的少了一个百分点以上 */
const helped = (c: Cut, m: NightMetrics): boolean =>
  (c.p90 > 0 && m.wake.p90 > 0 && m.wake.p90 < c.p90 * 0.9) || m.wake.judgeFail < c.fail - 0.01;

function watchValue(m: NightMetrics, w: Watch): number | null {
  if (w === "none") return null;
  if (w === "spend") return m.spendUsd;
  if (w === "openRate") return m.mounted ? m.opened / m.mounted : null;
  return m.replay ? m.replay.now : null;
}

/** 盯的那个数变坏了没有：花费越大越坏（到了上限的八成才算），回测、翻开率越小越坏；留一点余量，别被一天的起伏带着来回跳 */
function worse(w: Watch, before: number, after: number, m: NightMetrics): boolean {
  if (w === "spend") return after > m.dailyUsd * 0.8 && after > before * 1.1;
  return after < before - 0.1;
}

const clampStep = (name: string, cur: number, dir: 1 | -1): number | null => {
  const d = PARAMS[name]!;
  const v = Math.round((cur + dir * d.step) * 1e6) / 1e6;
  return v < d.min || v > d.max || v === cur ? null : v;
};

/**
 * 按这一天的数定今晚改哪几个（纯函数，测得到）。cur 给每个参数现在的值。
 * 先看上一晚的改动：盯的数变坏了就退回（算一个改动），这一晚别的不再动同一个参数。
 */
export function planTuning(m: NightMetrics, cur: Record<string, number>, last: LastChange[], cuts: Record<string, Cut> = {}, now = 0): { rollbacks: TuneChange[]; changes: TuneChange[]; held: string[] } {
  const held: string[] = [];
  const rollbacks: TuneChange[] = [];
  for (const l of last) {
    const after = watchValue(m, l.watch);
    if (after !== null && worse(l.watch, l.before, after, m)) {
      rollbacks.push({ name: l.name, value: l.old, why: L.tuner.rollbackReason(l.name, l.old, l.value, l.watch, round(l.before), round(after)), watch: l.watch });
    }
  }
  const out: TuneChange[] = [];
  const room = () => MAX_CHANGES - out.length - rollbacks.length;
  const touched = new Set(last.map((l) => l.name));   // 上一晚刚改过的这一晚先不动（退回的除外），看清楚效果
  const add = (name: string, dir: 1 | -1, why: string, watch: Watch): void => {
    if (room() <= 0 || touched.has(name) || out.some((c) => c.name === name) || cur[name] === undefined) return;
    let v = clampStep(name, cur[name]!, dir);
    const def = PARAMS[name]!.def;
    if (v !== null && name === "assoc.itemsK" && dir > 0 && def !== null) v = Math.min(v, def);   // 往回加最多到默认
    const floor = PARAMS[name]!.tunerMin;
    if (v !== null && dir < 0 && floor !== undefined && v < floor) {   // 往下调到底了（调参器的下限，比手动的高）
      held.push(L.tuner.heldAtFloor(name, floor, cur[name]));
      v = null;
    }
    if (v !== null) out.push({ name, value: v, why, watch });
  };
  if (m.wake.n < 10 && m.mounted < 10) return { rollbacks, changes: out, held };   // 这一天几乎没联想过（睡着、出事）：数不够，不调
  const spendRate = m.dailyUsd > 0 ? m.spendUsd / m.dailyUsd : 0;
  const slow = m.wake.n >= 10 && (m.wake.judgeFail >= 0.05 || m.wake.p90 >= m.wake.limitMs * 0.9);
  // 1. 花费快到上限：省干活时联想的次数（它占得多的时候）
  if (spendRate >= 0.8) {
    // 省钱只省干活时联想的次数，不少问条目：少问条目砍的是她能想起来的教训
    if (m.midworkShare >= 0.3) {
      add("midwork.everyMin", 1, L.tuner.spendHighWidenMinutes(round(m.spendUsd), m.dailyUsd, pct(m.midworkShare)), "none");
      add("midwork.everyTools", 1, L.tuner.spendHighWidenTools(round(m.spendUsd), m.dailyUsd, pct(m.midworkShare)), "none");
    }
  }
  // 2. 叫醒时的判断慢（回复路径上）：少问几条
  // 条目数回测量不出（回测不问条目）：照实写 none，不退回；往下调了，钱和速度都宽裕时再往回加，最多回到默认（review a530de7）
  // 上次为了快减过、减了没快（11-06 到 11-12 一路减到 0，p90 一直 1.5 秒上下）：不再减，写一行说为什么
  // 只在还停在那次减到的值（或更低）时才算数：后来往回加过（调参器或手动），那次的效果就量不出来了（review fbec08b2）
  const lastCut = cuts["assoc.itemsK"];
  const fresh = lastCut && now - lastCut.at < CUT_MEMORY_DAYS * DAY_MS && (cur["assoc.itemsK"] ?? Infinity) <= lastCut.value;
  if (slow && fresh && !helped(lastCut, m)) {
    held.push(L.tuner.itemsCutNotFaster(lastCut.night, Math.round(lastCut.p90), pct(lastCut.fail), Math.round(m.wake.p90), pct(m.wake.judgeFail)));
  } else if (slow) {
    add("assoc.itemsK", -1, L.tuner.wakeSlowFewerItems(pct(m.wake.judgeFail), Math.round(m.wake.p90), m.wake.limitMs), "none");
  }
  // 3. 钱花得少、也不慢：干活时联想可以勤一点
  if (spendRate <= 0.3 && !slow && m.wake.judgeFail < 0.02) {
    add("midwork.everyMin", -1, L.tuner.spendLowMoreOften(round(m.spendUsd), m.dailyUsd), "spend");
    const def = PARAMS["assoc.itemsK"]!.def ?? 0;
    if ((cur["assoc.itemsK"] ?? def) < def) add("assoc.itemsK", 1, L.tuner.spendLowMoreItems(round(m.spendUsd), def), "spend");
  }
  // 4. 门槛：老题回测过得少、挂的她还翻 → 放低；回测都过、一次挂好几页、几乎不翻 → 抬高。
  //    翻开率是个弱信号：页下面已经直接贴了对得上的条目，她不翻也看到了，翻开率天然偏低；抬高那条还要求回测 ≥90% 才动。
  //    以后换成「贴出来的条目当天有没有又犯」这类
  const openRate = m.mounted ? m.opened / m.mounted : 0;
  if (m.replay && m.replay.n >= 5 && m.replay.now < 0.7 && openRate >= 0.1) {
    add("assoc.threshold", -1, L.tuner.thresholdLower(pct(m.replay.now), pct(openRate)), "openRate");
  } else if (m.replay && m.replay.n >= 5 && m.replay.now >= 0.9 && m.perAssoc >= 1.5 && m.mounted >= 20 && openRate < 0.05) {
    add("assoc.threshold", 1, L.tuner.thresholdRaise(pct(m.replay.now), round(m.perAssoc), pct(openRate)), "replay");
  }
  return { rollbacks, changes: out, held };
}

const round = (x: number): number => Math.round(x * 100) / 100;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** 量这一天（now 往前 24 小时）的数；回测比今晚和前一晚都判过的题 */
export function nightMetrics(db: Db, o: { now: number; day: string; night: string; prevNight: string | null; dailyUsd: number; limitMs: number }): NightMetrics {
  const since = o.now - DAY_MS;
  const rows = all<{ at: number; region: string; binding: string; mounted: string; skipped: string | null; ms: number; tokens: number }>(db,
    "SELECT at, region, binding, mounted, skipped, ms, tokens FROM learn_assoc WHERE at >= ? AND at < ? AND binding NOT IN ('replay', 'helper', 'ask')", since, o.now);
  const wake = rows.filter((r) => r.binding === "wake" && r.skipped !== "lowinfo" && r.skipped !== "same");
  // p90 只算热的判断（前一次判断不到一分钟）：冷的时限翻倍，混进来会把冷启动的慢算成条目问多了（review a530de7）
  const judgedAt = rows.filter((r) => Number(r.tokens) > 0).map((r) => Number(r.at)).sort((a, b) => a - b);
  const warm = (at: number): boolean => {
    const i = judgedAt.findIndex((t) => t >= at);
    const prev = i > 0 ? judgedAt[i - 1]! : i < 0 && judgedAt.length ? judgedAt.at(-1)! : null;
    return prev !== null && prev < at && at - prev <= COLD_AFTER_MS;
  };
  const ms = wake.filter((r) => warm(Number(r.at))).map((r) => Number(r.ms)).sort((a, b) => a - b);
  // 同一件事接着做带上的页（carry）不算：那几页不是门槛挑的、又是她上次翻过的，混进来翻开率虚高，夜里会照着它降门槛
  const judgedPages = (r: { mounted: string }): Array<{ id: string }> => {
    try { return (JSON.parse(r.mounted) as Array<{ id: string; carry?: boolean }>).filter((p) => !p.carry); } catch { return []; }
  };
  const pages = rows.flatMap((r) => judgedPages(r).map((p) => ({ at: Number(r.at), region: r.region, id: p.id })));
  const opens = all<{ at: number; region: string; page_id: string | null }>(db, "SELECT at, region, page_id FROM learn_open WHERE at >= ? AND at < ?", since, o.now + OPEN_WINDOW_MS);
  // 每次翻开只算给它前面最近、30 分钟内挂的那一次（同一页一天挂几次时，一次翻开不算成接住几次）
  const used = new Set<number>();
  let opened = 0;
  for (const x of opens) {
    let best = -1;
    pages.forEach((p, i) => {
      if (!used.has(i) && p.id === x.page_id && p.region === x.region && x.at >= p.at && x.at <= p.at + OPEN_WINDOW_MS && (best < 0 || p.at > pages[best]!.at)) best = i;
    });
    if (best >= 0) { used.add(best); opened += 1; }
  }
  const judged = rows.filter((r) => Number(r.tokens) > 0);
  const tokens = judged.reduce((n, r) => n + Number(r.tokens), 0);
  const midTokens = judged.filter((r) => r.binding === "midwork").reduce((n, r) => n + Number(r.tokens), 0);
  return {
    spendUsd: (Number(kvGet(db, `learn.spend.${o.day}`)) || 0) * USD_PER_TOKEN,
    dailyUsd: o.dailyUsd,
    wake: { n: wake.length, judgeFail: wake.length ? wake.filter((r) => r.skipped === "judge").length / wake.length : 0, p90: ms.length ? ms[Math.floor(ms.length * 0.9)]! : 0, limitMs: o.limitMs },
    mounted: pages.length,
    opened,
    perAssoc: rows.filter((r) => judgedPages(r).length).length ? pages.length / rows.filter((r) => judgedPages(r).length).length : 0,
    midworkShare: tokens ? midTokens / tokens : 0,
    replay: o.prevNight ? stableReplay(db, o.night, o.prevNight) : null,
  };
}

/** 两晚都判过的题（新长出来的题都是挂错了才收的，混进来会把通过率拉低，看不出参数的效果） */
function stableReplay(db: Db, night: string, prev: string): { now: number; prev: number; n: number } | null {
  const rows = all<{ case_id: number; a: number; b: number }>(db,
    "SELECT a.case_id, a.passed AS a, b.passed AS b FROM learn_case_run a JOIN learn_case_run b ON b.case_id = a.case_id AND b.night = ? WHERE a.night = ?", prev, night);
  if (!rows.length) return null;
  return { now: rows.filter((r) => Number(r.a) === 1).length / rows.length, prev: rows.filter((r) => Number(r.b) === 1).length / rows.length, n: rows.length };
}

/**
 * 夜里调一次：量、定、改（setParam，by night-tuner），记下这次改了什么、盯的数是多少；返回写进夜里报告的几行。
 * cur 里跟着配置的参数（默认 null）用 fallback 给的配置值。出错不抛（调参失败不能拖住夜里整理）。
 */
export function nightTune(db: Db, o: { now: number; day: string; night: string; prevNight: string | null; dailyUsd: number; limitMs: number; fallback: Record<string, number> }): string[] {
  const m = nightMetrics(db, o);
  const cur: Record<string, number> = {};
  for (const name of Object.keys(PARAMS)) {
    try { cur[name] = param(db, name, o.fallback[name]); } catch { /* 跟着配置又没给：这一晚不调它 */ }
  }
  let saved: { night?: string; changes?: LastChange[] } = {};
  try {
    const v = JSON.parse(kvGet(db, LAST_KEY) ?? "{}") as unknown;
    saved = v && typeof v === "object" && !Array.isArray(v) ? (v as typeof saved) : {};
  } catch { saved = {}; }
  if (saved.night === o.night) return [L.tuner.rerunTitle, L.tuner.alreadyTuned];   // 同一晚重跑：不再动（一个没改也算调过）
  const last = Array.isArray(saved.changes) ? saved.changes : [];
  let cuts: Record<string, Cut> = {};
  try {
    const v = JSON.parse(kvGet(db, CUTS_KEY) ?? "{}") as unknown;
    cuts = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, Cut>) : {};
  } catch { cuts = {}; }
  const plan = planTuning(m, cur, last, cuts, o.now);
  const lines: string[] = [];
  const apply = (c: TuneChange): boolean => {
    if (cur[c.name] === undefined) return false;
    try {
      setParam(db, c.name, c.value, { why: c.why, by: TUNER, now: o.now });
      lines.push(L.tuner.changeLine(c.name, cur[c.name], c.value, c.why));
      return true;
    } catch (e) {
      lines.push(L.tuner.changeFailed(c.name, String(e).slice(0, 120)));
      return false;
    }
  };
  for (const r of plan.rollbacks) apply(r);
  const next: LastChange[] = [];
  for (const c of plan.changes) {
    const old = cur[c.name];
    const before = watchValue(m, c.watch);
    // 量不出坏处（none）、或者这一晚没有那个数的也记下：下一晚先不动它，看清楚
    if (old !== undefined && apply(c)) {
      next.push({ night: o.night, name: c.name, old, value: c.value, watch: before === null ? "none" : c.watch, before: before ?? 0 });
      // 为了快往下减的：记下当时多慢，下次还慢先看这次减了有没有用
      if (c.value < old && c.name === "assoc.itemsK") cuts[c.name] = { night: o.night, at: o.now, value: c.value, p90: m.wake.p90, fail: m.wake.judgeFail };
    }
  }
  kvSet(db, LAST_KEY, JSON.stringify({ night: o.night, changes: next }));
  kvSet(db, CUTS_KEY, JSON.stringify(cuts));
  const head = L.tuner.dayStatsSpend(round(m.spendUsd), m.dailyUsd, m.wake.n, pct(m.wake.judgeFail), Math.round(m.wake.p90)) +
    L.tuner.dayStatsMounts(m.mounted, m.opened, pct(m.midworkShare)) +
    (m.replay ? L.tuner.dayStatsReplay(pct(m.replay.prev), pct(m.replay.now), m.replay.n) : "");
  return [L.tuner.title, head, ...(lines.length ? lines : [L.tuner.noChange]), ...plan.held];
}
