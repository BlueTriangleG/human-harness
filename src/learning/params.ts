// 学习这一套能调的参数（「具体的参数我希望都是动态的，可以随着她每天睡觉的 evals 找到最合适的参数，
// 在性能、价格和效果之间平衡」）。登记表给默认值、上下限、每次调多少；kv learn.params 存覆盖值（hh learn param、
// 夜里的调参改它），用到时现读，不用重启。默认值是 null 的跟着配置走（调用的一方给配置里的值）。
// 每次改动记一行在 kv learn.params.log（谁、为什么、从多少到多少），有据可查。
import { kvGet, kvSet, type Db } from "../store/db.ts";
import { L } from "../lang/index.ts";

export interface ParamDef {
  /** null：跟着配置（param 的第三个参数） */
  def: number | null;
  min: number;
  max: number;
  /** 调参一次最多动这么多 */
  step: number;
  /** what it is, in the role's language (read when shown: the pack is chosen after load) */
  desc: () => string;
  /** 归谁管（改它的代码在哪） */
  owner: string;
  /** 夜里调参往下调最多到这么多（手动 hh learn param 还能更低）；不写就是 min */
  tunerMin?: number;
}

export const PARAMS: Record<string, ParamDef> = {
  // 强度
  "strength.windowDays": { def: 14, min: 3, max: 60, step: 1, desc: () => L.params.descStrengthWindowDays, owner: "strength" },
  "strength.strongDays": { def: 2, min: 1, max: 10, step: 1, desc: () => L.params.descStrengthStrongDays, owner: "strength" },
  "strength.residentDays": { def: 3, min: 1, max: 15, step: 1, desc: () => L.params.descStrengthResidentDays, owner: "strength" },
  "strength.calmDays": { def: 14, min: 3, max: 60, step: 1, desc: () => L.params.descStrengthCalmDays, owner: "strength" },
  "strength.residentMax": { def: 10, min: 0, max: 30, step: 1, desc: () => L.params.descStrengthResidentMax, owner: "strength" },
  "strength.strongMin": { def: 4, min: 4, max: 5, step: 1, desc: () => L.params.descStrengthStrongMin, owner: "strength" },
  "strength.strongThreshold": { def: 0.5, min: 0.3, max: 0.9, step: 0.05, desc: () => L.params.descStrengthStrongThreshold, owner: "strength" },
  "strength.strongRemountTokens": { def: 10_000, min: 0, max: 200_000, step: 5_000, desc: () => L.params.descStrengthStrongRemountTokens, owner: "strength" },
  "strength.strongAsk": { def: 20, min: 0, max: 60, step: 5, desc: () => L.params.descStrengthStrongAsk, owner: "strength" },
  // 11-04 标了一天的强联想：交之前同一处刚贴过的又贴一遍，中间她只看了几千 token，上一次还在眼前
  "strength.handRemountTokens": { def: 3_000, min: 0, max: 50_000, step: 1_000, desc: () => L.params.descStrengthHandRemountTokens, owner: "strength" },
  // 11-12：l:0112 九天贴了 425 次、l:0111 372 次、l:0110 235 次，三条这期间照样又犯：贴成了墙纸。贴够了就按普通条目的门槛，不再进「老毛病」那一块
  "strength.dailyMax": { def: 3, min: 0, max: 50, step: 1, desc: () => L.params.descStrengthDailyMax, owner: "strength" },
  // 联想（associate.ts）
  // 11-04 调研：0.7 时贴出来的约七成不是标注员会挑的；0.9 贴错的少一半。learning.threshold（0.7）还管主人那句是不是纠正，那个不跟着动
  "assoc.threshold": { def: 0.9, min: 0.4, max: 0.95, step: 0.05, desc: () => L.params.descAssocThreshold, owner: "assoc" },
  // 11-04 调研（253 个话题×整书架，标注员标的「真用得上」）：每次的花费几乎全在题数（一题≈225 token）；页粗筛 10/15、
  // 不再把通用类全补进来、条目 8 条，题数 54 → 28、花费减半，想起来的几乎不少（页 42→39%、教训 36→34%）
  // 11-06 到 11-12 调参器嫌判断慢，把它从 8 一路减到 0（每隔一晚减 2），p90 没见快，普通教训一条都不贴了（#0026）：调参器最多减到 4
  "assoc.itemsK": { def: 8, min: 0, max: 40, step: 2, desc: () => L.params.descAssocItemsK, owner: "assoc", tunerMin: 4 },
  "assoc.kWake": { def: null, min: 3, max: 40, step: 2, desc: () => L.params.descAssocKWake, owner: "assoc" },
  "assoc.kTask": { def: null, min: 3, max: 60, step: 5, desc: () => L.params.descAssocKTask, owner: "assoc" },
  "assoc.generalExtra": { def: 0, min: 0, max: 30, step: 5, desc: () => L.params.descAssocGeneralExtra, owner: "assoc" },
  // 同一个脑区隔不久又联想一个几乎一样的话题（11-04 约一成，多半是同一件事连着交两次差）：上次问过的题照用，只问新的
  "assoc.reuseCos": { def: 0.95, min: 0.8, max: 1, step: 0.01, desc: () => L.params.descAssocReuseCos, owner: "assoc" },
  "assoc.reuseMin": { def: 10, min: 0, max: 60, step: 5, desc: () => L.params.descAssocReuseMin, owner: "assoc" },
  // 11-05 改稿（Astra v7、v9，five-lines v4）开始做时写稿那几页判断没过线，几分钟后主人纠正的正是那两页里写着的：
  // 最近做过很像的事（开始做那一刻的话题向量够像），那时她翻过的页直接带上，不再问判断。多像算「同一件事」先存几天向量再定，默认不带
  "assoc.carryCos": { def: 1.01, min: 0.5, max: 1.01, step: 0.02, desc: () => L.params.descAssocCarryCos, owner: "assoc" },
  "assoc.carryDays": { def: 7, min: 1, max: 30, step: 1, desc: () => L.params.descAssocCarryDays, owner: "assoc" },
  "assoc.carryMax": { def: 3, min: 0, max: 8, step: 1, desc: () => L.params.descAssocCarryMax, owner: "assoc" },
  "assoc.hitsPerPage": { def: 2, min: 1, max: 5, step: 1, desc: () => L.params.descAssocHitsPerPage, owner: "assoc" },
  "assoc.remountTokens": { def: null, min: 0, max: 300_000, step: 10_000, desc: () => L.params.descAssocRemountTokens, owner: "assoc" },
  // 11-04 拿 1053 处人标的「话题×强教训」试问法：动作型教训多问一句「这一步就要做吗」，过 0.2 才算，噪音 16% → 7%、有用的几乎不丢
  "assoc.fullTextAt": { def: 0.995, min: 0.5, max: 1.01, step: 0.005, desc: () => L.params.descAssocFullTextAt, owner: "assoc" },
  "assoc.stepThreshold": { def: 0.2, min: 0.05, max: 0.9, step: 0.05, desc: () => L.params.descAssocStepThreshold, owner: "assoc" },
  // 11-04 判断的每日上限 19:34 用完、整晚没联想：花到这条线先停干活途中的联想，叫醒、开始做、交之前、发之前照常
  "assoc.saveAt": { def: 0.8, min: 0.3, max: 1, step: 0.05, desc: () => L.params.descAssocSaveAt, owner: "assoc" },
  // 笔记分层（layers.ts，重要度低的沉到更深的层级，不消失）
  "layers.deepDays": { def: 30, min: 7, max: 180, step: 7, desc: () => L.params.descLayersDeepDays, owner: "layers" },
  "layers.graceDays": { def: 14, min: 0, max: 90, step: 7, desc: () => L.params.descLayersGraceDays, owner: "layers" },
  "layers.shallowOpens": { def: 4, min: 1, max: 50, step: 1, desc: () => L.params.descLayersShallowOpens, owner: "layers" },
  // 11-14：两件事从早开到凌晨，一整天翻的 22 页两两全连上，「一起翻」一晚从 169 条涨到 386 条
  "links.coGapMin": { def: 60, min: 5, max: 1440, step: 5, desc: () => L.params.descLinksCoGapMin, owner: "layers" },
  // 干活时联想（brain.midwork）：只按花费和延迟调，又犯太稀量不出效果
  "midwork.minMin": { def: 2, min: 1, max: 30, step: 1, desc: () => L.params.descMidworkMinMin, owner: "midwork" },
  "midwork.everyMin": { def: 5, min: 2, max: 60, step: 1, desc: () => L.params.descMidworkEveryMin, owner: "midwork" },
  "midwork.everyTools": { def: 8, min: 2, max: 40, step: 2, desc: () => L.params.descMidworkEveryTools, owner: "midwork" },
  "midwork.unreadTools": { def: 6, min: 2, max: 30, step: 2, desc: () => L.params.descMidworkUnreadTools, owner: "midwork" },
  // 交给主人之前（brain.handoverCheck）
  "handover.minChars": { def: 200, min: 50, max: 2000, step: 50, desc: () => L.params.descHandoverMinChars, owner: "handover" },
  "handover.burstChars": { def: 400, min: 100, max: 4000, step: 100, desc: () => L.params.descHandoverBurstChars, owner: "handover" },
  "handover.sentAt": { def: 1.01, min: 0.05, max: 1.01, step: 0.05, desc: () => L.params.descHandoverSentAt, owner: "handover" },
  "handover.graceMin": { def: 10, min: 1, max: 60, step: 1, desc: () => L.params.descHandoverGraceMin, owner: "handover" },
};

const KEY = "learn.params";
const LOG_KEY = "learn.params.log";
const LOG_MAX = 300;

export interface ParamChange { at: number; name: string; old: number | null; value: number | null; by: string; why: string }

function overrides(db: Db): Record<string, number> {
  try {
    const o = JSON.parse(kvGet(db, KEY) ?? "{}") as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, number>) : {};
  } catch {
    return {};
  }
}

const defOf = (name: string): ParamDef | undefined => (Object.hasOwn(PARAMS, name) ? PARAMS[name] : undefined);

/** 一个名字现在的值（覆盖值卡在上下限里；不是数的当没有） */
function valueOf(o: Record<string, unknown>, name: string, fallback?: number): number {
  const d = defOf(name);
  if (!d) throw new Error(L.params.unknownParam(name));
  const v = o[name];
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(d.max, Math.max(d.min, v));
  const base = d.def ?? fallback;
  if (base === undefined) throw new Error(L.params.needsConfigValue(name));
  return base;
}

/** 现在的值：覆盖值（卡在上下限里）→ 登记的默认 → 配置给的 fallback。没登记的名字抛错（写错名字要马上看到） */
export function param(db: Db, name: string, fallback?: number): number {
  return valueOf(overrides(db), name, fallback);
}

/** 一次读好的参数（一次联想里要读很多回，kv 只读一次） */
export function paramsNow(db: Db): (name: string, fallback?: number) => number {
  const o = overrides(db);
  return (name, fallback) => valueOf(o, name, fallback);
}

/** 改一个参数（null = 清掉覆盖，回到默认）；超出上下限、不是数都抛错。返回改之前和之后的覆盖值 */
export function setParam(db: Db, name: string, value: number | null, o: { why: string; by: string; now: number }): { old: number | null; value: number | null } {
  const d = defOf(name);
  if (!d) throw new Error(L.params.unknownParamWithList(name, Object.keys(PARAMS).join(" ")));
  if (value !== null && !Number.isFinite(value)) throw new Error(L.params.notANumber(name, value));
  if (value !== null && (value < d.min || value > d.max)) throw new Error(L.params.outOfRange(name, value, d.min, d.max));
  const all = overrides(db);
  const old = typeof all[name] === "number" ? all[name]! : d.def;
  if (value === null) delete all[name]; else all[name] = value;
  kvSet(db, KEY, JSON.stringify(all));
  const log = paramLog(db);
  log.push({ at: o.now, name, old: typeof old === "number" ? old : null, value, by: o.by, why: o.why });
  kvSet(db, LOG_KEY, JSON.stringify(log.slice(-LOG_MAX)));
  return { old: typeof old === "number" ? old : null, value };
}

export function paramLog(db: Db): ParamChange[] {
  try {
    const l = JSON.parse(kvGet(db, LOG_KEY) ?? "[]") as unknown;
    return Array.isArray(l) ? (l as ParamChange[]) : [];
  } catch {
    return [];
  }
}

/** 全部参数和现在的值（跟着配置、没覆盖的 value 是 null） */
export function listParams(db: Db): Array<{ name: string; value: number | null; overridden: boolean } & ParamDef> {
  const o = overrides(db);
  return Object.entries(PARAMS).map(([name, d]) => {
    const v = o[name];
    const set = typeof v === "number" && Number.isFinite(v);
    return { name, ...d, value: set ? valueOf(o, name) : d.def, overridden: set };
  });
}
