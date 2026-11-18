// 中期记忆 = 同一个事件库"最近这一段"的常驻视图：今天、有日子的事、最近在发生的事、最近喜欢的 / 烦的、主人最近的原话。
// 人物近况、这两天的我是她夜里手写的，留在账本快照里（buildPrefix 去掉快照里按旧事件线排的那几段）。
// 每一行都带编号（入口），想细想用 recall_event 展开；同一件事只在一处展开，其余一句加编号。
import type { EventRecall } from "./recall.ts";
import type { EventRow, EntryRow } from "./schema.ts";
import { all } from "../../store/db.ts";
import { renderEvents, fmtDay } from "./render.ts";
import { localToUtc } from "./schema.ts";
import { M, N } from "../../lang/index.ts";

const DAY = 86_400_000;
export const LIKES_BUDGET = 800;
export const LIKES_OVERFLOW = 300;
export const DISLIKES_BUDGET = 200;

/** 她的今天从本地 04:00 开始 */
function todayStart(now: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map((x) => [x.type, x.value])) as Record<string, string>;
  const start = localToUtc(Number(p.year), Number(p.month), Number(p.day), 4, 0, tz);
  return Number(p.hour) < 4 ? start - DAY : start;
}

function hm(t: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(t).map((x) => [x.type, x.value])) as Record<string, string>;
  return `${p.hour}:${Number(p.minute) < 30 ? "00" : "30"}`;
}

function clip(s: string, budget: number): string {
  return s.length <= budget ? s : s.slice(0, Math.max(0, budget - 1)) + M.midterm.cut;
}

/** 最近喜欢的 / 烦的：还 ongoing 的 stance 事件，按最近一条感受倒序；整节最多 room 字（含标题），不够就少写，不够一行就不写 */
function likesSection(db: EventRecall["store"]["db"], room: number): string {
  const rows = all<EventRow & { felt: number }>(db, `SELECT e.*, COALESCE((SELECT MAX(n.at) FROM mem_entry n WHERE n.event_id = e.id AND n.kind = 'feeling'), e.updated_at) felt FROM mem_event e WHERE e.stance IS NOT NULL AND e.status = 'ongoing' ORDER BY felt DESC, e.id`);
  const likes = rows.filter((e) => e.stance === "like");
  const dislikes = rows.filter((e) => e.stance === "dislike");
  const title = likes.length ? M.midterm.likesTitle : M.midterm.dislikesTitle;
  let avail = room - title.length;
  if (avail <= 0 || (!likes.length && !dislikes.length)) return "";
  const out: string[] = [];
  let used = 0, n = 0;
  const lineCap = Math.min(LIKES_BUDGET, avail);
  for (const e of likes) {
    const l = M.midterm.likeLine(e.title, e.importance, e.id, e.gist);
    if (used + l.length + (n ? 1 : 0) > lineCap) break;
    out.push(l); used += l.length + (n ? 1 : 0); n++;
  }
  avail -= used;
  const names = (list: EventRow[], head: string, cap: number): string => {
    cap = Math.min(cap, avail - (out.length ? 1 : 0));
    const items: string[] = [];
    let len = head.length;
    for (const e of list) {
      const it = `${e.title} ${e.id}`;
      const rest = list.length - items.length - 1;
      const tail = rest > 0 ? M.midterm.namesMoreRoom(rest).length : 0;
      if (len + it.length + (items.length ? 1 : 0) + tail > cap) break;
      items.push(it); len += it.length + (items.length > 1 ? 1 : 0);
    }
    if (!items.length) return "";
    const more = list.length - items.length;
    const line = `${head}${items.join(M.midterm.namesSep)}${more ? M.midterm.namesMore(more) : ""}`;
    avail -= line.length + (out.length ? 1 : 0);
    return line;
  };
  const restLikes = likes.slice(n);
  const o1 = restLikes.length ? names(restLikes, M.midterm.stillLikes, LIKES_OVERFLOW) : "";
  if (o1) out.push(o1);
  const o2 = dislikes.length ? names(dislikes, M.midterm.dislikesHead, DISLIKES_BUDGET) : "";
  if (o2) out.push(o2);
  return out.length ? `${title}${out.join("\n")}` : "";
}

export function renderMidterm(r: EventRecall, o: { now: number; tz: string; budget?: number }): string {
  const budget = o.budget ?? 14000;
  const db = r.store.db;
  const t0 = todayStart(o.now, o.tz);
  const parts: string[] = [M.midterm.head];
  let left = budget - M.midterm.head.length - 2;

  // 今天：今天所有经过，按时间，精确到半小时（这里写全文，别处只写一句）；夜里才进库，白天多半是空的，空就不写。
  // 标成不算数的事（她白天 drop 掉的、夜里 retire 的）的经过不列：和联想一样，不算数的不再自己冒出来
  const today = all<EntryRow & { title_e: string }>(db, "SELECT n.*, e.title title_e FROM mem_entry n JOIN mem_event e ON e.id = n.event_id WHERE n.at >= ? AND n.at <= ? AND e.status != 'retired' ORDER BY n.at, n.id", t0, o.now);
  if (today.length) {
    const todayLines = today.map((n) => M.midterm.todayLine(hm(n.at, o.tz), n.title_e, n.event_id, n.full, n.id));
    const todayText = clip(M.midterm.today(todayLines), Math.floor(left * 0.3));
    parts.push(todayText);
    left -= todayText.length + 2;
  }

  // 有日子的事：下次的日子还没到的（考试、截止、约好的那天），按日子排；很久没进展的也在，到那天之前一直在
  // next_at 是那天的零点；她的一天到第二天 04:00，所以那一天整天都列着
  const dated = all<EventRow>(db, "SELECT * FROM mem_event WHERE next_at IS NOT NULL AND next_at > ? AND status NOT IN ('superseded','retired') ORDER BY next_at", t0 - DAY);
  if (dated.length) {
    const lines = dated.map((e) => M.midterm.datedLine(fmtDay(e.next_at!, o.tz), e.title, e.importance, e.id, e.gist));
    const datedText = clip(M.midterm.dated(lines), Math.min(1500, Math.floor(left * 0.15)));
    parts.push(datedText);
    left -= datedText.length + 2;
  }

  // 最近在发生的事：14 天内有进展的，按清晰度写总结 / 一句话 / 名字；时间线不在这里展开
  const recent = all<EventRow>(db, `SELECT * FROM mem_event WHERE status NOT IN ('superseded','retired') AND stance IS NULL AND ended_at >= ? ORDER BY ended_at DESC`, o.now - 14 * DAY);
  const recentIds = new Set(recent.map((e) => e.id));
  // 大事和它下面最近有进展的子事件占一格（11-01 拆完子事件：90 件里一半是子事件，40 格不够，重要的被挤掉）：
  // 子事件并进最上面那件也在最近里的大事，列在它的「子事件」那行（最近的在前）；大事不在最近里的子事件照常自己一格
  const owner = new Map<string, string>();
  for (const e of recent) {
    const top = r.store.ancestors(e.id).filter((a) => a.id !== e.id && recentIds.has(a.id)).pop();
    if (top) owner.set(e.id, top.id);
  }
  // 数据里万一成了环（互为上一层）：并进去的那件自己也被并走了，就不并（不然两件都看不到）
  for (const [k, v] of [...owner]) if (owner.has(v)) owner.delete(k);
  const imp = (e: EventRow) => (e.pinned ? 5 : e.importance);
  const packs = recent.filter((e) => !owner.has(e.id)).map((e) => {
    const folded = recent.filter((k) => owner.get(k.id) === e.id);
    const others = r.store.children(e.id).filter((k) => !folded.some((f) => f.id === k.id) && k.status !== "superseded" && k.status !== "retired" && !k.stance);
    const children = [...folded, ...others].map((k) => ({ id: k.id, title: k.title }));
    // 重要度 4 以上的（连同并进来的子事件）不被挤掉
    const keep = [e, ...folded].some((k) => imp(k) >= 4);
    return { ...r.pack(e.id)!, entries: [], children, keep, latest: Math.max(...[e, ...folded].map((k) => k.ended_at ?? 0)) };
  }).sort((a, b) => b.latest - a.latest);   // 这一格按组里最新的进展排（大事自己很久没动、子事件刚有进展）
  const stale = all<EventRow>(db, "SELECT * FROM mem_event WHERE status IN ('ongoing','paused') AND stance IS NULL AND (ended_at IS NULL OR ended_at < ?) ORDER BY ended_at DESC", o.now - 14 * DAY);
  // 还在进行、最近没动的：只留名字，最多 600 字，多的写「还有 N 件」
  let staleLine = "";
  if (stale.length) {
    const head = M.midterm.staleHead;
    const items: string[] = [];
    for (const e of stale) {
      const it = `${e.title} ${e.id}`;
      if (head.length + items.join(M.midterm.staleSepRoom).length + it.length > 600) break;
      items.push(it);
    }
    staleLine = `${head}${items.join(M.midterm.staleSep)}${items.length < stale.length ? M.midterm.staleMore(stale.length - items.length) : ""}`;
  }
  // 最近在发生的事先照老样子排满、量出它自然的长度 L；主人那节照旧只看 L（不管有没有喜欢的）。
  // 最近喜欢的 / 烦的最多用 L 的一半，从这一格里扣：最近在发生的事再按 L 减去它重排
  const renderRecent = (recentBudget: number) => {
    const body = packs.length
      // 按最近有进展排（重要度 4 以上的不插到最前；放不下时它们最后才被挪走）；放不下的那行留位置列标题
      ? renderEvents(packs, { budget: Math.max(100, recentBudget - staleLine.length - 20), now: o.now, tz: o.tz, maxEvents: 40, entriesPerEvent: 0, keepOrder: true, maxChildren: 40, childrenFirst: true, overflowRoom: Math.min(600, Math.floor(recentBudget * 0.15)), touched: (ref) => r.store.lastTouched(ref) })
      : M.midterm.noRecent;
    return clip(M.midterm.recent(body, staleLine), recentBudget);
  };
  let recentText = renderRecent(Math.floor(left * 0.45));
  const natural = recentText.length;
  const likesText = likesSection(db, Math.floor(natural / 2) - 2);
  if (likesText) recentText = renderRecent(natural - likesText.length - 2);
  parts.push(recentText);
  if (likesText) parts.push(likesText);
  left -= natural + 2;

  // 人物近况是她夜里手写的（在账本快照里，每句带事件编号）；这里只放主人最近 3 天的原话：新的在前，放不下的说怎么翻
  const gq = all<{ id: number; at: number; text: string }>(db, "SELECT id, at, text FROM mem_quote WHERE lower(who) = ? AND at >= ? ORDER BY at DESC", N.owner.toLowerCase(), o.now - 3 * DAY);
  if (gq.length) {
    const head = M.midterm.ownerQuotesHead;
    const room = left - head.length - 80;
    const ql: string[] = [];
    let used = 0;
    for (const q of gq) {
      const l = M.midterm.ownerQuote(fmtDay(q.at, o.tz), hm(q.at, o.tz), q.text.length > 300 ? q.text.slice(0, 300) + M.midterm.ownerQuoteCut : q.text, q.id);
      if (used + l.length + 1 > room) break;
      ql.push(l);
      used += l.length + 1;
    }
    const more = gq.length - ql.length;
    parts.push(clip(`${head}\n\n${ql.join("\n")}${more ? M.midterm.ownerQuotesMore(more) : ""}`, Math.max(0, left)));
  }
  return clip(parts.join("\n\n"), budget);
}
