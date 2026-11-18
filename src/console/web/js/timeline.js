"use strict";
import { T, TGroup, clock } from "./i18n.js";
import { $, TOOL_CN, VERB, el, laneOf, selected, shortTool, visible } from "./core.js";
import { fold, refold, sentInto, sentOf, sentText } from "./sent.js";
import { flash, paintBrain, renderCard, select } from "./brain.js";
import { linkIds } from "./events.js";
// ---------- 时间线 ----------
const rows = [];        // 按 seq 从小到大
const toolById = new Map();   // tool_use id → 工具名（act 和 result 配对用）
/*
 * 只看一个脑区时，这一段以前它自己的记录。
 * rows 是最近连着的一段。光在这一段里筛不够：别的脑区一忙（夜里整理半小时就是六百条），这个脑区在这一段里一条都没有，
 * 看着像它没动过。所以选了脑区以后，这一段以前它自己的记录另外向服务端要（/api/central?src=），放在这里，画的时候接在前面。
 * 这里的每一条都比 rows 最早的那条早。
 */
const earlier = new Map();   // 脑区 → { rows: 按 seq 从小到大, done: 再往前没有了, failed: 上一次没取到的原因 }
const REGION_MIN = 40;       // 这个脑区手里不到这么多条，就自己去要一页
const REGION_PAGE = 200;
const regionAsking = new Set();   // 正在要哪几个脑区的（同一个不重复要）
let regionEra = 0;           // rows 最早的那头每变一次加一：变之前发出去的请求回来就不要了（接不上）
const earlierOf = (src) => earlier.get(src) || { rows: [], done: false, failed: "" };
/** 一个脑区手里的全部记录：这一段以前它自己的，加这一段里它的 */
function rowsOf(src) {
  const mine = rows.filter((r) => r.src === src);
  const more = earlier.get(src);
  return more && more.rows.length ? [...more.rows, ...mine] : mine;
}
/** 时间线上现在要画的：没选脑区就是这一段；选了，前面接上它更早的 */
function shownRows() {
  const more = selected ? earlier.get(selected) : null;
  return more && more.rows.length ? [...more.rows, ...rows] : rows;
}
/** 「说」和「发给」从头再认一遍，更早的那些也算上（认是按来源各认各的，先后只看同一个来源里的） */
function refoldAll() { refold([...[...earlier.values()].flatMap((m) => m.rows), ...rows]); }
/** rows 最早的那头变了：更早的那些里已经落进 rows 的不留；在路上的请求作废 */
function regionReset(drop) {
  regionEra++;
  if (drop) { earlier.clear(); return; }
  for (const m of earlier.values()) m.rows = m.rows.filter((r) => firstSeq !== null && r.seq < firstSeq);
}
/** 新读到的一段记录；older = 接在已有的前面（往上翻），这时「说」和「发给」要从头再认一遍 */
function index(list, older) {
  for (const r of list) if (r.kind === "act" && r.meta && r.meta.id && r.meta.tool) toolById.set(r.meta.id, r.meta.tool);
  if (older) refoldAll(); else for (const r of list) fold(r);
}
/** 时间线上列不列这一条：并进「说」那一行的「发给」不另列；那条「说」被筛掉了就照旧单独列 */
function listed(r) {
  if (!visible(r)) return false;
  const into = sentInto.get(r.seq);
  return !(into && visible(into));
}
let firstSeq = null, lastSeq = 0, follow = true, unseen = 0;
const tl = $("#timeline");

/** 渠道的代号在页面上叫什么（中文界面就显示代号本身，和原来一样；没列的代号原样显示） */
const CHANNEL = TGroup("timeline.channel");
const hm = (ts) => new Date(ts).toLocaleTimeString(T("common.locale"), { hour12: false });
const day = (ts) => new Date(ts).toLocaleDateString(T("common.locale"), { month: T("common.dates") === "numeric" ? "numeric" : "short", day: "numeric", weekday: "short" });
const ago = (ms) => {
  const m = Math.round((clock() - ms) / 60_000);
  return m < 1 ? T("common.justNow") : m < 60 ? T("common.minutesAgo", { n: m }) : m < 1440 ? T("common.hoursAgo", { n: Math.round(m / 60) }) : T("common.daysAgo", { n: Math.round(m / 1440) });
};

function clampable(node, text, lines) {
  node.textContent = text;
  const n = text.split("\n").length;
  if (n <= lines && text.length < lines * 90) return null;
  node.classList.add("clamp");
  node.style.setProperty("--lines", lines);
  const b = el("button", "more", T("common.expand"));
  b.addEventListener("click", () => {
    const open = node.classList.toggle("clamp");
    b.textContent = open ? T("common.expand") : T("common.collapse");
  });
  return b;
}

function splitAct(text) {
  // 中央记忆里的格式：「工具名 {参数}」
  const i = text.indexOf(" ");
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, ""];
}

function renderBody(kind, text, meta, tool) {
  const body = el("div", "body");
  const verb = el("div", "verb", VERB[kind] || kind);
  let lines = 6;
  if (kind === "input") {
    const who = meta && (meta.from || meta.channel) ? [meta.from, CHANNEL[meta.channel] || meta.channel].filter(Boolean).join(T("common.comma")) : "";
    if (who) body.append(el("span", "from", who));
    lines = 8;
  } else if (kind === "note" && meta && meta.sent) {
    verb.textContent = T("timeline.sentTo");
    body.append(el("span", "to", meta.name || T("timeline.someone")));
    text = sentText(text);
  }
  if (kind === "act") {
    let name = tool, args = text;
    if (!name) [name, args] = splitAct(text);
    const tn = el("div", "tool", name);
    const cn = TOOL_CN[shortTool(name)];
    if (cn) tn.append(el("span", "of", "  " + cn));
    body.append(tn);
    if (args && args !== "{}") {
      const pre = el("div", "txt");
      const more = clampable(pre, args, 2);
      if (cn) linkIds(pre, args);
      body.append(pre);
      if (more) body.append(more);
    }
    return [verb, body];
  }
  if (kind === "result") {
    lines = 3;
    const of = tool || (meta && meta.id ? toolById.get(meta.id) : null);
    if (of) body.append(el("span", "of", of));
  }
  if (kind === "think") lines = 10;
  const t = el("div", "txt");
  const more = clampable(t, text, lines);
  const ofTool = kind === "result" ? shortTool(tool || (meta && meta.id ? toolById.get(meta.id) : "")) : "";
  if (TOOL_CN[ofTool] || kind === "say") linkIds(t, text);
  body.append(t);
  if (more) body.append(more);
  return [verb, body];
}

/** 「说」那一行标上发给了谁（并进来的那几条「发给」）；又并进来一条时重画 */
function paintSent(e, r) {
  const sent = sentOf.get(r.seq);
  if (!sent) return;
  const body = e.querySelector(".body");
  body.querySelector(".to")?.remove();
  const name = sent[0].meta.name || T("timeline.someone");
  const to = el("span", "to", sent.length > 1 ? T("timeline.saidToMany", { name, n: sent.length }) : T("timeline.saidTo", { name }));
  to.title = sent.length > 1 ? T("timeline.saidBetween", { from: hm(sent[0].ts), to: hm(sent[sent.length - 1].ts), n: sent.length }) : T("timeline.saidAt", { time: hm(sent[0].ts) });
  body.prepend(to);
}

function entry(r, prev) {
  const lane = laneOf(r.src);
  const e = el("div", "e k-" + r.kind + (r.meta && r.meta.error ? " err" : ""));
  e.dataset.seq = r.seq;
  e.style.setProperty("--lane", "var(" + lane.color + ")");
  const first = !prev || prev.src !== r.src || r.ts - prev.ts > 5 * 60_000;
  if (first) e.classList.add("first");
  const t = el("div", "t", hm(r.ts));
  t.title = T("timeline.rowTitle", { day: day(r.ts), seq: r.seq });
  if (r.meta && r.meta.inner === true) { e.classList.add("inner"); t.title += T("timeline.innerNote"); }
  const who = el("div", "who", lane.name);
  who.title = T("brain.only", { name: lane.name });
  who.addEventListener("click", () => select(r.src));
  e.append(t, who, ...renderBody(r.kind, r.text, r.meta));
  if (r.kind === "say") paintSent(e, r);
  return e;
}

function atBottom() { return tl.scrollHeight - tl.scrollTop - tl.clientHeight < 60; }

function renderAll() {
  tl.replaceChildren();
  // 只看一个脑区时，「更早的」翻的是它自己的
  const more = selected ? earlierOf(selected) : null;
  const olderLeft = firstSeq !== null && firstSeq > 1 && !(more && more.done);
  if (olderLeft) {
    const b = el("button", "older", T("timeline.older"));
    b.addEventListener("click", selected ? () => loadRegionOlder(selected, true) : loadOlder);
    tl.append(b);
  }
  let prev = null, shown = 0, mine = 0;
  for (const r of shownRows()) {
    if (selected && r.src === selected) mine++;
    if (!listed(r)) continue;
    tl.append(entry(r, prev)); prev = r; shown++;
  }
  // 这个脑区手里太少（多半是被别的脑区挤出了这一段）：自己去要一页它更早的。数的是它全部的记录，不管勾选和搜索——不然筛得一条不剩时会一页页要个没完
  const asking = !!more && olderLeft && !more.failed && mine < REGION_MIN;
  if (!shown) {
    const name = selected ? laneOf(selected).name : "";
    const msg = !rows.length ? T("timeline.empty")
      : selected && !mine ? (asking ? T("timeline.regionLoading", { name }) : more.failed ? T("timeline.regionFailed", { name, error: more.failed }) : T("timeline.emptyRegion", { name }))
      : T("timeline.emptyFiltered");
    tl.append(el("div", "empty", msg));
  }
  tl.scrollTop = tl.scrollHeight;
  follow = true;
  if (asking) loadRegionOlder(selected, false);
}

function appendRows(newRows) {
  const stick = follow && atBottom();
  let prev = null;
  const before = shownRows();
  for (let i = before.length - 1; i >= 0; i--) if (listed(before[i])) { prev = before[i]; break; }
  const fresh = [];
  for (const r of newRows) {
    if (r.seq <= lastSeq) continue;
    rows.push(r); lastSeq = r.seq; index([r]); fresh.push(r);
    if (firstSeq === null) firstSeq = r.seq;
    const into = sentInto.get(r.seq);
    if (into) { const said = tl.querySelector('.e[data-seq="' + into.seq + '"]'); if (said) paintSent(said, into); }
    if (!listed(r)) continue;
    tl.querySelector(".empty")?.remove();
    tl.append(entry(r, prev)); prev = r;
    if (!stick) unseen++;
  }
  if (rows.length > 6000) { rows.splice(0, rows.length - 5000); firstSeq = rows[0].seq; regionReset(true); refold(rows); renderAll(); }
  if (stick) tl.scrollTop = tl.scrollHeight;
  pill();
  for (const src of new Set(fresh.map((r) => r.src))) flash(src);
  paintBrain();
  renderCard();
}

function pill() {
  const p = $("#newpill");
  if (unseen > 0 && !atBottom()) { p.textContent = T("timeline.unseen", { n: unseen }); p.style.display = "block"; }
  else { p.style.display = "none"; unseen = 0; }
}
$("#newpill").addEventListener("click", () => { tl.scrollTop = tl.scrollHeight; unseen = 0; pill(); });
tl.addEventListener("scroll", () => { follow = atBottom(); if (follow) { unseen = 0; pill(); } });

async function loadOlder() {
  const top = tl.scrollHeight - tl.scrollTop;
  const r = await fetch("/api/central?limit=300&before=" + firstSeq).then((x) => x.json());
  if (!r.rows.length) { firstSeq = 1; regionReset(false); renderAll(); return; }
  rows.unshift(...r.rows);
  firstSeq = r.rows[0].seq;
  regionReset(false);
  index(r.rows, true);
  renderAll();
  tl.scrollTop = tl.scrollHeight - top;
}

/** 向服务端要这个脑区更早的一页，要到了重画。keep：画完停在原来看的地方（点「更早的」时） */
async function loadRegionOlder(src, keep) {
  if (regionAsking.has(src) || firstSeq === null) return;
  const more = earlierOf(src);
  if (more.done) return;
  const era = regionEra, top = tl.scrollHeight - tl.scrollTop;
  const before = more.rows.length ? more.rows[0].seq : firstSeq;
  regionAsking.add(src);
  let got = null, failed = "";
  try {
    const r = await fetch("/api/central?limit=" + REGION_PAGE + "&src=" + encodeURIComponent(src) + "&before=" + before).then((x) => x.json());
    if (r.error) throw new Error(r.error);
    got = r.rows;
  } catch (e) { failed = e.message || String(e); }
  regionAsking.delete(src);
  if (era !== regionEra) { if (selected === src) renderAll(); return; }   // 这一段的开头在这期间变了，这一页接不上：不要（还缺的话 renderAll 会再去要）
  if (got) {
    earlier.set(src, { rows: [...got, ...more.rows], done: got.length < REGION_PAGE, failed: "" });
    index(got, true);
  } else earlier.set(src, { rows: more.rows, done: false, failed });
  if (selected !== src) return;
  renderAll();
  if (keep) tl.scrollTop = tl.scrollHeight - top;
  renderCard();
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putFirstSeq(v) { return firstSeq = v; }
function putFollow(v) { return follow = v; }
function putLastSeq(v) { return lastSeq = v; }
function putUnseen(v) { return unseen = v; }
export {
  CHANNEL, ago, appendRows, clampable, firstSeq, follow, hm, index, lastSeq, pill, renderAll, renderBody, rows, rowsOf, splitAct, tl, unseen, putFirstSeq,
  putFollow, putLastSeq, putUnseen,
};
