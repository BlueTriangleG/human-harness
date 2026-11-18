// 控制台的「下意识」：闸门（丘脑）一天的账——进来了什么、每条怎么分（直达 / 帮手 / 她的规则 / 小判断 / 兜底）、判成什么、为什么。
// 直接只读查 gate_log：不建 Gate、不经 hhd。原始事件 JSON（ev 列）不出控制台，只在 SQL 里取几个字段：是不是群聊、是不是系统提示（system）、
// 正文（text）、附带的做法（do）、正文块（body），都按类型取（不是字符串的不要）。
// 访客私聊（只在这一页）不出原文：聊天来源（通道表 senses.sources 里的 chat，加上表里没标的——宁可多遮，见 gate/sources.ts 的 maskAsChat）里，会话名认出是访客的（不管 isGroup 怎么标），
// 或者一对一的（ev 里 isGroup 不是 true）发话人认出是访客的 → text / body / do / gist / why 都是 null，发话人只留和会话名一样的，
// 兜底原因也只记成「访客私聊」一类。宁可多遮：名单或批准底子读不了，聊天来源的行全遮（群也遮：被标成群的私聊分不出来）；
// 认不出是谁的聊天也遮；主人只认批准底子里的，而且只认微信备注（小红书 / B站显示名谁都能改成主人的）。
// 唯一的例外：角色自己的感官脚本写明是系统提示的（ev 里 system 是 true、没有 isGroup），会话名和发话人都是空（NULL，不是空字符串）——
// 那不是谁说的话，名单读不读得了都不遮；它被小判断判过的话，要点和原因不出（小判断写它时同一批里可能有访客的私聊）。
// 事件库里那个人的名字、别名也认访客（#0042；库里认出是主人的不算，当陌生人）；查库出错（不是没有那张表）同样聊天来源的行全遮。
// relay（她跟访客聊的会话转述访客说的话）一律遮。
import type { DatabaseSync } from "node:sqlite";
import { type Sources, maskAsChat } from "../gate/sources.ts";
import { localToUtc } from "../memory/events/schema.ts";
import { aliasLookup } from "../memory/events/store.ts";
import { People, registryFileOf } from "../persona/people.ts";
import type { AliasKey } from "../persona/people.ts";
import { all, kvGet, one } from "../store/db.ts";

export interface GateViewOptions {
  /** 她的工作区：名单在 memory/people/registry.json */
  workspace: string;
  /** 她的时区：一天按她的日历日算 */
  tz: string;
  /** config gate.dailyUnits */
  dailyUnits: number;
  /** 老行（units 是 NULL）按 tokens × 这个倍数估：sleepWeights(cfg.sleep.weights).model.haiku */
  haikuMultiplier: number;
  /** 通道表（实例配置 senses.sources，经 sourcesOf 读）：哪些来源的行按聊天遮 */
  sources: Sources;
}

export interface GateRow {
  ts: number; src: string; conv: string | null; sender: string | null;
  route: string | null; rule: string | null; action: string | null; verdict: string | null; when: string | null;
  unsure: boolean | null; delivered: boolean;
  /** 原文：事件的正文（正文块另放 body、附带的做法另放 do）；ev 读不出就是整行去掉行首的「- [src id=…] 」。访客私聊是 null */
  text: string | null; gist: string | null; why: string | null;
  /** 原文带的正文块（图片识别、长消息）；没有、访客私聊是 null */
  body: string | null;
  /** 原文附带的做法（感官给的「怎么处理」）：页面上默认折起来；没有、访客私聊是 null */
  do: string | null;
  private: boolean;
}

export interface GateDayStats {
  received: number;
  byRoute: Record<string, number>;
  byVerdict: Record<string, number>;
  /** 小判断调了几次（tokens > 0 的行：一次调用的花费记在那批第一行） */
  judgeCalls: number;
  units: number;
  dailyUnits: number;
  /** 兜底的行各是什么原因 */
  fallbackWhy: Record<string, number>;
}

export interface GateView {
  day: string; today: string; stats: GateDayStats; rows: GateRow[]; total: number; limit: number;
  /** 名单读得了没有；读不了时聊天来源的行全遮（群也遮；角色自己的脚本写明的系统提示除外，见文件开头） */
  registryOk: boolean;
  /** 名单的批准底子（kv registry_approved）读得了没有；读不了时同样聊天来源的行全遮（系统提示除外） */
  baselineOk: boolean;
  /** 事件库里的人名查得了没有（没有那张表也算查得了：认不出而已）；查不了时同样聊天来源的行全遮（系统提示除外） */
  aliasOk: boolean;
}

/** 认访客私聊用的：名单（读不了是 null）过了批准底子；底子读得了没有；事件库里的人名查得了没有 */
export interface Privacy { people: People | null; baselineOk: boolean; aliasOk: boolean }

export const GATE_ROWS = 500;
/** 兜底原因里，访客私聊那几行记成这一类（原因可能带着报错原文） */
/** 这两个也是统计里兜底原因的键；网页 web/js/gate.js 的 G_WHY_SHOWN 按它们认、换成看的人的语言显示，改这里要一起改那边 */
export const PRIVATE_LABEL = "访客私聊（不显示原文）";
export const NO_WHY_LABEL = "（没写原因）";
const ROUTES = ["fixed-main", "hands", "rule", "judge", "fallback"];
const VERDICTS = ["main", "digest", "drop"];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
// ev 坏了（不是 JSON）算一对一：宁可多遮
const GRP = "CASE WHEN json_valid(ev) AND json_type(ev, '$.isGroup') = 'true' THEN 1 ELSE 0 END AS grp";
// 角色自己的感官脚本写明的系统提示（SenseEvent.system，只认 JSON 的 true）；真的聊天事件都带 isGroup，带了它的不算（宁可多遮）；ev 坏了不算
const SYS = "CASE WHEN json_valid(ev) AND json_type(ev, '$.system') = 'true' AND json_type(ev, '$.isGroup') IS NULL THEN 1 ELSE 0 END AS sys";
// 原文分开取：正文、附带的做法（do）、正文块；只要字符串（对象、数组 json_extract 会给 JSON 文本）；取不到正文就退回整行
const str = (k: string, as: string) => `CASE WHEN json_valid(ev) AND json_type(ev, '$.${k}') = 'text' THEN json_extract(ev, '$.${k}') END AS ${as}`;
const EVTEXT = [str("text", "evText"), str("do", "evDo"), str("body", "evBody")].join(", ");

/** YYYY-MM-DD → 她那一天的 [from, to) 毫秒；写法不对、没有这一天就是 null */
export function gateDayRange(day: string, tz: string): { from: number; to: number } | null {
  const m = DAY.exec(day);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const c = new Date(Date.UTC(y, mo - 1, d));
  if (y < 1970 || c.getUTCFullYear() !== y || c.getUTCMonth() !== mo - 1 || c.getUTCDate() !== d) return null;
  return { from: localToUtc(y, mo, d, 0, 0, tz), to: localToUtc(y, mo, d + 1, 0, 0, tz) };
}

/**
 * 名单文件过一遍批准底子（和 hhd 一样用 People.from）：没批过就改成主人的，还是访客。
 * 名单读不了（文件不在、JSON 坏了）people 是 null；底子读不了、没有就按空底子过（谁都不是主人），baselineOk 是 false（聊天来源的行全遮）。
 * 事件库里那个人的名字、别名也认（#0042）：这一次请求用同一份索引；没有那张表就认不出（和以前一样），别的错 aliasOk 是 false（聊天来源的行全遮）
 */
export function readPrivacy(db: DatabaseSync, workspace: string): Privacy {
  let aliasKey: AliasKey = () => null;
  let aliasOk = true;
  try { aliasKey = aliasLookup(db); } catch { aliasOk = false; }
  let approved: Record<string, Record<string, unknown>> = {};
  let baselineOk = false;
  try {
    const v = kvGet(db, "registry_approved");
    const a: unknown = v ? JSON.parse(v) : null;
    if (a && typeof a === "object" && !Array.isArray(a)) { approved = a as Record<string, Record<string, unknown>>; baselineOk = true; }
  } catch { /* 底子坏了：按空底子过 */ }
  try {
    const f = registryFileOf(workspace);
    if (f.mtime() === null) return { people: null, baselineOk, aliasOk };
    const raw: unknown = f.read();
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { people: null, baselineOk, aliasOk };
    // 库里认出的一律按显示名算（People.identifyHandle）；遮行时连主人也认（hides 给 ownersToo）：访客多遮不少遮
    return { people: People.from(raw as Record<string, unknown>, approved, aliasKey), baselineOk, aliasOk };
  } catch {
    return { people: null, baselineOk, aliasOk };
  }
}

interface Who { src: string; conv: string | null; sender: string | null; grp: number; sys: number }

/**
 * 这个名字要不要遮：认出是访客；或者认出是主人但没核实——小红书 / B站的显示名、事件库里的名字（byDisplayName）、
 * 按号 / 会话对上的（显示名可以起成主人的号）。只有微信备注认出的主人算核实（备注是自己设的）。
 * 库里的名字在这里不排除主人（ownersToo，final-review R-2）：闸门那边把它当陌生人，遮行这边宁可多遮
 */
function hides(src: string, name: string | null, people: People): boolean {
  if (!name) return false;
  const h = people.identifyHandle(src, name, { ownersToo: true });
  if (h) return h.person.privacy !== "owner" || h.byDisplayName;
  return people.identify(name, name) !== null;
}

/** 访客私聊（见文件开头）。这一行要遮，也影响兜底原因的统计。sources：通道表 */
function isPrivate(r: Who, privacy: Privacy, sources: Sources): boolean {
  // relay：她跟访客聊的那个会话转述访客说了什么（relay.py send），一律遮
  if (r.src === "relay") return true;
  if (!maskAsChat(sources, r.src)) return false;
  // 认不出是谁的聊天：遮。只有角色自己的脚本写明是系统提示的（没有会话名、没有发话人）不遮：那不是谁说的话。
  // 有会话名或发话人的，带不带这个标记都照下面认人那套走
  // 空字符串的名字照旧当「认不出」遮，不算没名字（不让系统提示的例外放开它）
  if (!r.conv && !r.sender) return !(r.sys === 1 && r.conv === null && r.sender === null);
  // 名单、底子读不了，或者库里的人名查不了：认不出访客，也分不出被标成群的私聊和真的群，聊天来源的全遮
  const people = privacy.baselineOk && privacy.aliasOk ? privacy.people : null;
  if (!people) return true;
  // senses.py 会把正文以「xx: 」开头的私聊标成群（fixed.ts 也是先看会话名）：会话名认出访客，不管 isGroup 都遮
  if (hides(r.src, r.conv, people)) return true;
  if (r.grp === 1) return false;
  return hides(r.src, r.sender, people);
}

/** 页面上显示的原文：事件的正文（正文块、做法另给）；ev 读不出正文就用整行（去掉行首，正文块和做法都在里面） */
function shownText(x: { line: string; evText: unknown }): string {
  return typeof x.evText === "string" ? x.evText : x.line.replace(/^-\s*\[[^\]]*\]\s*/, "");
}
/** ev 里取出的字符串字段：只有正文取得到时才另给（取不到正文时整行里已经带着了） */
const part = (x: { evText: unknown }, v: unknown): string | null => (typeof x.evText === "string" && typeof v === "string" && v ? v : null);

interface Raw extends Who {
  ts: number; line: string; route: string | null; rule: string | null; action: string | null; verdict: string | null; when_: string | null;
  gist: string | null; why: string | null; unsure: number | null; delivered: number | null;
  evText: unknown; evDo: unknown; evBody: unknown;
}

/** 某一天（她的日历日，调用方先用 gateDayRange 核过）的账：统计 + 最新的 500 行（新的在前） */
export function gateView(db: DatabaseSync, day: string, today: string, o: GateViewOptions, privacy: Privacy): GateView {
  const r = gateDayRange(day, o.tz);
  if (!r) throw new Error(`gateView: not a day: ${day}`);   // the route checked it already (api.badDay); this is the code's own guard
  const W = "ts >= ? AND ts < ?";
  const count = (extra: string): number => one<{ n: number }>(db, `SELECT COUNT(*) AS n FROM gate_log WHERE ${W}${extra}`, r.from, r.to)!.n;
  const group = (key: string, extra: string, base: string[]): Record<string, number> => {
    const out: Record<string, number> = Object.fromEntries(base.map((k) => [k, 0]));
    for (const g of all<{ k: string; n: number }>(db, `SELECT ${key} AS k, COUNT(*) AS n FROM gate_log WHERE ${W}${extra} GROUP BY k`, r.from, r.to)) out[g.k] = g.n;
    return out;
  };
  const fallbackWhy: Record<string, number> = {};
  for (const f of all<Who & { why: string | null }>(db, `SELECT src, conv, sender, why, ${GRP}, ${SYS} FROM gate_log WHERE ${W} AND route = 'fallback'`, r.from, r.to)) {
    const k = isPrivate(f, privacy, o.sources) ? PRIVATE_LABEL : f.why || NO_WHY_LABEL;
    fallbackWhy[k] = (fallbackWhy[k] ?? 0) + 1;
  }
  const received = count("");
  const stats: GateDayStats = {
    received,
    byRoute: group("COALESCE(route, 'pending')", "", ROUTES),
    byVerdict: group("verdict", " AND verdict IS NOT NULL AND route = 'judge'", VERDICTS),   // 小判断的结论；判不了先进总结的（兜底）不算
    judgeCalls: count(" AND tokens > 0"),
    units: one<{ n: number }>(db, `SELECT COALESCE(SUM(COALESCE(units, tokens * ?)), 0) AS n FROM gate_log WHERE ${W}`, o.haikuMultiplier, r.from, r.to)!.n,
    dailyUnits: o.dailyUnits,
    fallbackWhy,
  };
  const rows = all<Raw>(db,
    `SELECT ts, src, conv, sender, line, route, rule, action, verdict, when_, gist, why, unsure, delivered, ${GRP}, ${SYS}, ${EVTEXT}
     FROM gate_log WHERE ${W} ORDER BY ts DESC, id DESC LIMIT ?`, r.from, r.to, GATE_ROWS,
  ).map((x): GateRow => {
    const hide = isPrivate(x, privacy, o.sources);
    const judgedSys = x.sys === 1 && x.route === "judge";
    return {
      // 遮的行：发话人和会话名不一样就不给（被标成群的私聊，发话人是正文开头那几个字）
      ts: x.ts, src: x.src, conv: x.conv, sender: hide && x.sender !== x.conv ? null : x.sender,
      route: x.route, rule: x.rule, action: x.action, verdict: x.verdict, when: x.when_,
      unsure: x.unsure === null ? null : x.unsure === 1, delivered: x.delivered !== null,
      text: hide ? null : shownText(x),
      body: hide ? null : part(x, x.evBody),
      do: hide ? null : part(x, x.evDo),
      // 系统提示被小判断判过：要点和原因是小判断看着一整批（可能有访客私聊）写的，不出
      gist: hide || judgedSys ? null : x.gist,
      why: hide || judgedSys ? null : x.why,
      private: hide,
    };
  });
  return { day, today, stats, rows, total: received, limit: GATE_ROWS, registryOk: privacy.people !== null, baselineOk: privacy.baselineOk, aliasOk: privacy.aliasOk };
}
