// 每日总结：夜里整理前，把今天闸门放下的动静回想成一段笔记。材料从 gate_log 里取，小判断（Haiku）写成第一人称。
import type { AskOpts, AskResult } from "../kernel/types.ts";
import type { People } from "../persona/people.ts";
import type { Db } from "../store/db.ts";
import { all } from "../store/db.ts";
import { P } from "../lang/index.ts";
import { G } from "../lang/index.ts";

const DAY = 86_400_000;
const DIGEST_TIMEOUT_MS = 60_000;
const EXCERPT_CHARS = 1500;
const LINE_CHARS = 80;
const PER_GROUP = 20;
const NOMINATE_DAYS = 14;
const NOMINATE_MIN = 3;
const KEEP_DAYS = 30;

interface Row { conv: string | null; src: string; line: string; rule: string | null; action: string | null; verdict: string | null; gist: string | null; why: string | null; unsure: number | null }

const clip = (s: string, n: number): string => { const t = s.replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
/** 没有 gist（没判过，规则直接放下的）就用原话：去掉行首的 [xx id=…] 标签 */
const textOf = (r: Row): string => clip(r.gist ?? r.line.replace(/^-\s*\[[^\]]*\]\s*/, ""), LINE_CHARS);
// verdict 是小判断的结论，规则直接放下的只有 action
const kindOf = (r: Row): string | null => r.verdict ?? r.action;

// 她的规则看过的 action（同 Gate.stats 的 byRule）：固定规则、小判断兜底的行不算进任何规则
const RULE_ACTIONS = ["main", "judge", "digest", "drop"];

/** 只有落定（done）的行算材料；还在判的行留给下一次：下次从最早那条没落定的行开始 */
export function nextDigestFrom(db: Db, from: number, to: number): number {
  const r = all<{ t: number | null }>(db, "SELECT MIN(ts) AS t FROM gate_log WHERE ts >= ? AND ts < ? AND state != 'done'", from, to)[0]?.t;
  return r == null ? to : Math.min(to, r);
}

export type NomineeCounts = Record<string, number>;

/** 名单提名现在的全貌（key=「src:conv」）：Brain 记下，下次只提数量涨了的。chat：通道表里的聊天来源（sources.ts） */
export function nomineeCounts(db: Db, to: number, people: People, chat: ReadonlySet<string>): NomineeCounts {
  return Object.fromEntries(nominate(db, to, people, chat).map((n) => [`${n.src}:${n.conv}`, n.n]));
}

/** chat：通道表里的聊天来源（sources.ts），名单提名只看它们 */
export function dailyDigestMaterial(db: Db, from: number, to: number, ruleErrors: string[], registryChanges: string[], people: People, chat: ReadonlySet<string>, lastNominees: NomineeCounts = {}): string | null {
  const rows = all<Row>(db, "SELECT conv, src, line, rule, action, verdict, gist, why, unsure FROM gate_log WHERE ts >= ? AND ts < ? AND state = 'done' ORDER BY ts, id", from, to);
  const gone = rows.filter((r) => kindOf(r) === "digest" || kindOf(r) === "drop");
  const unsure = rows.filter((r) => r.unsure === 1);
  // 上次提过的、数量没涨的不再提（一直认不出的人不能天天把总结叫醒）
  const nominees = nominate(db, to, people, chat).filter((n) => !(`${n.src}:${n.conv}` in lastNominees) || n.n > lastNominees[`${n.src}:${n.conv}`]!);
  if (!gone.length && !unsure.length && !ruleErrors.length && !registryChanges.length && !nominees.length) return null;

  // 短的段落在前：整段材料被截成 1500 字时，丢的是长长的会话明细，不是名单和规则的问题
  const out: string[] = [];
  if (nominees.length) out.push(G.digest.nomineesHeading, ...nominees.map((n) => G.digest.nomineeLine(n.conv, n.src, n.n)));
  if (ruleErrors.length) out.push(G.digest.ruleErrorsHeading, ...ruleErrors.map((e) => `- ${e}`));
  if (registryChanges.length) out.push(G.digest.registryChangesHeading, ...registryChanges.map((c) => `- ${c}`));
  const hits = new Map<string, number>();
  for (const r of rows) if (r.action && RULE_ACTIONS.includes(r.action)) hits.set(r.rule ?? G.digest.ruleHitsNoRule, (hits.get(r.rule ?? G.digest.ruleHitsNoRule) ?? 0) + 1);
  if (hits.size) out.push(G.digest.ruleHitsHeading + [...hits].map(([k, n]) => G.digest.ruleHitsItem(k, n)).join(G.digest.ruleHitsSeparator));
  if (unsure.length) {
    out.push(G.digest.unsureHeading);
    for (const r of unsure.slice(0, PER_GROUP)) out.push(G.digest.unsureLine(r.conv ?? r.src, textOf(r), r.why ? G.digest.unsureReasonSuffix(clip(r.why, LINE_CHARS)) : ""));
    if (unsure.length > PER_GROUP) out.push(G.digest.unsureMore(unsure.length - PER_GROUP));
  }
  if (gone.length) {
    const groups = new Map<string, Row[]>();
    for (const r of gone) { const k = r.conv ?? r.src; groups.set(k, [...(groups.get(k) ?? []), r]); }
    out.push(G.digest.setAsideHeading);
    for (const [k, rs] of groups) {
      const digest = rs.filter((r) => kindOf(r) === "digest");
      const drops = rs.length - digest.length;
      out.push(G.digest.setAsideGroupLine(k, rs[0]!.src, digest.length, drops));
      for (const r of digest.slice(0, PER_GROUP)) out.push(`- ${textOf(r)}`);
      if (digest.length > PER_GROUP) out.push(G.digest.setAsideGroupMore(digest.length - PER_GROUP));
    }
  }
  return out.join("\n");
}

/** 名单提名：14 天里在聊天来源上反复来私聊、却认不出是谁的会话（isGroup 没有列，只能从 ev JSON 里取）。没有聊天来源就没有提名（不拼空的 IN ()） */
function nominate(db: Db, to: number, people: People, chat: ReadonlySet<string>): Array<{ src: string; conv: string; n: number }> {
  const srcs = [...chat];
  if (!srcs.length) return [];
  const rows = all<{ src: string; conv: string; n: number }>(db,
    `SELECT src, conv, COUNT(*) AS n FROM gate_log
     WHERE ts >= ? AND ts < ? AND src IN (${srcs.map(() => "?").join(",")}) AND conv IS NOT NULL AND conv != ''
       AND COALESCE(json_extract(ev, '$.isGroup'), 0) = 0
     GROUP BY src, conv HAVING n >= ? ORDER BY n DESC, conv`, to - NOMINATE_DAYS * DAY, to, ...srcs, NOMINATE_MIN);
  const out: Array<{ src: string; conv: string; n: number }> = [];
  for (const r of rows) {
    if (people.identifyHandle(r.src, r.conv)) continue;
    const senders = all<{ sender: string | null }>(db, "SELECT DISTINCT sender FROM gate_log WHERE src = ? AND conv = ? AND ts >= ? AND ts < ?", r.src, r.conv, to - NOMINATE_DAYS * DAY, to);
    if (senders.some((s) => s.sender && people.identifyHandle(r.src, s.sender))) continue;
    out.push(r);
  }
  return out;
}

/** 写成第一人称的一段。硬超时 60 秒；问不到、超时就用材料前 1500 字，绝不拖住夜里整理 */
export async function dailyDigest(o: {
  db: Db; ask: (a: AskOpts) => Promise<AskResult>; base: Omit<AskOpts, "system" | "prompt">; material: string;
  later?: (fn: () => void, ms: number) => void;   // 测试里换成假时钟
}): Promise<string> {
  const excerpt = o.material.slice(0, EXCERPT_CHARS);
  const later = o.later ?? ((fn, ms) => { setTimeout(fn, ms).unref(); });
  let timedOut!: () => void;
  const timeout = new Promise<string>((r) => { timedOut = () => r(excerpt); });
  later(timedOut, DIGEST_TIMEOUT_MS);
  try {
    const r = await Promise.race([o.ask({ ...o.base, timeoutMs: DIGEST_TIMEOUT_MS, system: P.DIGEST_SYSTEM, prompt: o.material }).then((x) => x.text.trim()), timeout]);
    return r || excerpt;
  } catch {
    return excerpt;
  }
}

/** 闸门账只留 30 天（名单提名看 14 天）。还在判的、判给主意识等着送的（同 takeQueued）不删 */
export function pruneGateLog(db: Db, now: number): void {
  db.prepare("DELETE FROM gate_log WHERE ts < ? AND state = 'done' AND NOT (when_ IS NOT NULL AND when_ != 'now' AND delivered IS NULL)").run(now - KEEP_DAYS * DAY);
}
