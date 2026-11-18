"use strict";
import { T, TGroup, clock } from "./i18n.js";
import { $, GATE, el, gateData, gateDay, gateKey, gateOpen, gateSeq, gateToday, persist, putGateData, putGateDay, putGateKey, putGateOpen, putGateSeq, putGateToday, putSelected, selected } from "./core.js";
import { clampable, hm, pill, putFollow, putUnseen, renderAll, tl } from "./timeline.js";
import { paintBrain, renderCard } from "./brain.js";
import { renderScope } from "./toolbar.js";
import { refreshStrip } from "./topbar.js";
import { md, showPanes, updateHash } from "./memory.js";
// ---------- 下意识：闸门（丘脑）一天的账 ----------
// 进来的每一条：从哪来、怎么分（直达 / 她的规则 / 小判断 / 兜底）、判成什么、为什么、送到没有。访客私聊不出原文（服务端就遮掉了）。
const G_ROUTE = TGroup("gate.route");
const G_VERDICT = TGroup("gate.verdict");
const G_WHEN = TGroup("gate.when");
const G_SRC = TGroup("gate.source");
const G_PRIVATE = T("gate.row.private");
/** 兜底原因里有两个键是服务端放的：src/console/gate.ts 的 PRIVATE_LABEL 和 NO_WHY_LABEL，这里的两个字面量要和它们一字不差（test/console-lang.test.ts 看着）。
 *  键是数据不动，页面上换成看的人的语言；别的原因是库里记的任意字串，原样显示（所以这张表没有原型） */
const G_WHY_SHOWN = Object.assign(Object.create(null), { "访客私聊（不显示原文）": G_PRIVATE, "（没写原因）": T("gate.row.noReason") });
/** 额度的数：一万以上，中文写成几万；别的语言用那个地区的缩写（123K、2M），由包里的 common.numbers 定 */
const wan = (n) => n < 10_000 ? String(Math.round(n))
  : T("common.numbers") === "wan" ? T("gate.tenThousands", { n: (n / 10_000).toFixed(n >= 1_000_000 ? 0 : 1) })
  : new Intl.NumberFormat(T("common.locale"), { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** 大脑图上那一块的亮度：读到的是今天的账时，按最近 5 分钟进来几条（和别的脑区一样的算法） */
function gateAct() {
  if (!gateData || gateData.day !== gateData.today) return 0;
  const since = clock() - 5 * 60_000;
  return Math.min(1, Math.sqrt(gateData.rows.filter((x) => x.ts >= since).length / 30));
}

function openGate(on) {
  putGateOpen(on);
  if (on && selected) { putSelected(null); persist(); renderScope(); renderAll(); refreshStrip(); }
  showPanes(); paintBrain(); renderCard(); updateHash();
  if (on) loadGate(true);
  else { tl.scrollTop = tl.scrollHeight; putFollow(true); putUnseen(0); pill(); }   // 时间线藏着的时候滚动位置丢了：回到最新
}

/** 日子那一栏：读到了写读到的那天，没读到（读取中、出错）写要看的那天，不留空；后一天 / 今天 在看今天时不能按 */
function gateDayBar(day, today) {
  // 日子：中文照原样写 2026-11-13；别的语言用月份缩写（Nov 13），和页面别处一致
  const shown = !day || T("common.dates") === "numeric" ? day : md(new Date(day + "T12:00:00").getTime());
  $("#gdaylbl").textContent = day ? shown + (today ? T("gate.todayMark") : "") : T("common.today");
  $("#gnext").disabled = today;
  $("#gtoday").disabled = today;
}

async function loadGate(force) {
  const my = putGateSeq(gateSeq + 1);
  if (force) {
    putGateKey("");
    if (!gateData || gateData.day !== (gateDay || gateData.today)) { gateDayBar(gateDay, !gateDay); $("#gbody").replaceChildren(el("p", "hint", T("common.loading"))); }
  }
  const r = await fetch("/api/gate" + (gateDay ? "?day=" + encodeURIComponent(gateDay) : "")).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (my !== gateSeq || !gateOpen) return;
  if (r.error) {
    // 出错（地址里的日子不对、连不上）：错误写在这一页，日子那一栏照样能按
    putGateData(null); putGateKey("");
    gateDayBar(gateDay, !gateDay);
    $("#gsum").replaceChildren();
    $("#gbody").replaceChildren(el("p", "gnote", gateDay ? T("gate.loadFailedDay", { day: gateDay, error: r.error }) : T("gate.loadFailed", { error: r.error })));
    renderCard(); paintBrain();
    return;
  }
  putGateData(r); putGateToday(r.today);
  // 自动刷新时没变就不重画（免得把展开的原文收起来）
  // 名单、底子改了（哪些行要遮变了）也要重画：遮了的原文不能还留在页面上
  const key = [r.day, r.total, JSON.stringify(r.stats), r.rows[0] ? r.rows[0].ts : "", r.rows.filter((x) => x.delivered).length, r.registryOk, r.baselineOk, r.aliasOk, r.rows.map((x) => (x.private ? 1 : 0)).join("")].join("|");
  if (key !== gateKey) { putGateKey(key); renderGate(); }
  renderCard(); paintBrain();
}

/** YYYY-MM-DD 而且真有这一天 */
function validDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || "");
  if (!m) return false;
  const t = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return t.getUTCFullYear() === +m[1] && t.getUTCMonth() === +m[2] - 1 && t.getUTCDate() === +m[3];
}
/** 前一天 / 后一天 / 今天（n = 0）。没读到过账（出错）也能按：从要看的那天算，那天不对就从今天算 */
function gateStep(n) {
  const d0 = new Date(clock());
  const today = gateToday || d0.getFullYear() + "-" + String(d0.getMonth() + 1).padStart(2, "0") + "-" + String(d0.getDate()).padStart(2, "0");
  if (n === 0) putGateDay(null);
  else {
    const base = validDay(gateDay) ? gateDay : gateData ? gateData.day : today;
    const [y, m, d] = base.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
    putGateDay(next >= today ? null : next);
  }
  updateHash();
  loadGate(true);
}
$("#gprev").addEventListener("click", () => gateStep(-1));
$("#gnext").addEventListener("click", () => gateStep(1));
$("#gtoday").addEventListener("click", () => gateStep(0));
$("#gclose").addEventListener("click", () => openGate(false));

function renderGateCard() {
  const card = $("#card");
  card.style.setProperty("--lane", "var(" + GATE.color + ")");
  const h = el("h3", null, GATE.name);
  h.append(el("small", null, GATE.where));
  const nodes = [h, el("p", "what", GATE.what)];
  const s = gateData && gateData.stats;
  if (s) {
    const facts = el("div", "facts");
    const fact = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); facts.append(x); };
    const today = gateData.day === gateData.today;
    fact(today ? T("gate.card.inToday") : T("gate.card.inOn", { day: T("common.dates") === "numeric" ? gateData.day : md(new Date(gateData.day + "T12:00:00").getTime()) }), T("common.rows", { n: s.received }));
    fact(T("gate.card.judgeCalls"), T("common.times", { n: s.judgeCalls }));
    fact(T("gate.card.quotaUsed"), Math.round(s.units / Math.max(1, s.dailyUnits) * 100) + "%");
    nodes.push(facts);
  }
  nodes.push(el("p", "hint", T("gate.card.hint")));
  card.replaceChildren(...nodes);
}

function gateOutcome(x) {
  if (x.verdict) return x.verdict;
  if (["main", "digest", "drop"].includes(x.action)) return x.action;
  return x.when ? "main" : null;
}

function gateRow(x) {
  const d = el("div", "grow" + (x.private ? " priv" : ""));
  const t = el("span", "t", hm(x.ts).slice(0, 5));
  t.title = new Date(x.ts).toLocaleString(T("common.locale"), { hour12: false });
  const from = el("span", "gw");
  from.append(el("b", null, G_SRC[x.src] || x.src));
  const who = [x.conv, x.sender && x.sender !== x.conv ? x.sender : null].filter(Boolean).join(" / ");
  if (who) from.append(who);
  from.title = [G_SRC[x.src] || x.src, x.conv, x.sender].filter(Boolean).join(" / ");
  const rk = x.route || "pending";
  const route = el("span", "gr r-" + rk, G_ROUTE[rk] || rk);
  if (x.rule) route.append(el("small", null, x.rule));
  else if (x.action === "judge-floor") route.append(el("small", null, T("gate.row.judgeFloor")));
  const out = gateOutcome(x);
  const v = el("span", "gv" + (out ? " v-" + out : ""), out ? G_VERDICT[out] || out : T("common.dash"));
  if (out === "main" && x.when) v.append(el("small", null, G_WHEN[x.when] || x.when));
  const why = el("span", "gy", x.private ? T("common.dash") : x.why || x.gist || "");
  if (!x.private && x.why && x.gist) why.title = T("gate.row.gist", { gist: x.gist });
  const un = el("span", "gu", x.unsure ? T("gate.row.unsure") : "");
  if (x.unsure) un.title = T("gate.row.unsureTitle");
  const late = !x.delivered && x.when && x.route !== "hands";
  const dl = el("span", "gd" + (late ? " late" : ""), x.delivered ? T("gate.row.sent") : late ? T("gate.row.notSent") : T("common.dash"));
  dl.title = x.delivered ? T("gate.row.sentTitle") : late ? T("gate.row.notSentTitle") : T("gate.row.noSendTitle");
  const tx = el("div", "gx");
  if (x.private) { const pv = el("span", "gpriv", G_PRIVATE); pv.title = T("gate.row.privateTitle"); tx.append(pv); }
  else {
    const p = el("div", "txt");
    const more = clampable(p, x.text || "", 2);
    tx.append(p);
    if (more) tx.append(more);
    // 正文块（图片识别、长消息）：单独一块，不接在通知那一行后面
    if (x.body) {
      const b = el("div", "txt gblk");
      const bmore = clampable(b, x.body, 4);
      tx.append(b);
      if (bmore) tx.append(bmore);
    }
    // 感官附带的做法（怎么处理）：常常很长，默认折起来
    if (x.do) {
      const dd = el("details", "gdo");
      dd.append(el("summary", null, T("gate.row.attachedDo")), el("div", "txt", x.do));
      tx.append(dd);
    }
  }
  d.append(t, from, route, v, why, un, dl, tx);
  return d;
}

function renderGate() {
  const r = gateData;
  const today = r.day === r.today;
  gateDayBar(r.day, today);
  const s = r.stats, br = s.byRoute, bv = s.byVerdict;
  const part = (label, n, extra, title) => { const x = el("span", null, label + " "); x.append(el("b", null, String(n || 0))); if (extra) x.append(extra); if (title) x.title = title; return x; };
  const why = Object.entries(s.fallbackWhy).sort((a, b) => b[1] - a[1]).map(([k, n]) => (G_WHY_SHOWN[k] || k) + (n > 1 ? " ×" + n : "")).join(T("common.listSep"));
  const parts = [
    part(T("gate.summary.received"), s.received),
    part(G_ROUTE["fixed-main"], br["fixed-main"]),
    ...(br.hands ? [part(T("gate.summary.toHands"), br.hands)] : []),
    part(G_ROUTE.rule, br.rule),
    part(G_ROUTE.judge, br.judge, T("gate.summary.verdicts", { main: bv.main || 0, digest: bv.digest || 0, drop: bv.drop || 0 }), T("gate.summary.judgeTitle")),
    part(G_ROUTE.fallback, br.fallback, why ? T("gate.summary.fallbackWhy", { why }) : "", T("gate.summary.fallbackTitle")),
    ...(br.pending ? [part(G_ROUTE.pending, br.pending)] : []),
  ];
  const q = el("span", null, (today ? T("gate.summary.quotaToday") : T("gate.summary.quotaThatDay")) + " ");
  q.append(el("b", null, wan(s.units)), " / " + wan(s.dailyUnits) + T("gate.summary.judgeCalls", { n: s.judgeCalls }));
  q.title = T("gate.summary.quotaTitle");
  parts.push(q);
  $("#gsum").replaceChildren(...parts);
  const nodes = [];
  if (!r.registryOk || !r.baselineOk || r.aliasOk === false) nodes.push(el("p", "gnote", (!r.registryOk ? T("gate.note.registry") : !r.baselineOk ? T("gate.note.baseline") : T("gate.note.aliases")) + T("gate.note.unreadable")));
  if (r.rows.length < r.total) nodes.push(el("p", "hint", T("gate.listed", { shown: r.rows.length, total: r.total })));
  if (!r.rows.length) nodes.push(el("div", "empty", today ? T("gate.emptyToday") : T("gate.emptyDay")));
  else {
    const head = el("div", "grow ghead");
    for (const c of [T("gate.head.time"), T("gate.head.from"), T("gate.head.route"), T("gate.head.verdict"), T("gate.head.why"), T("gate.head.unsure"), T("gate.head.delivered")]) head.append(el("span", null, c));
    // oldest at the top, the newest at the bottom, as on the timeline and in the talk pane; the list opens at the newest
    nodes.push(head, ...[...r.rows].reverse().map(gateRow));
  }
  const box = $("#gbody");
  box.replaceChildren(...nodes);
  box.scrollTop = box.scrollHeight;
}

// ---------- 给别的文件用的 ----------
export { gateAct, loadGate, openGate, renderGateCard };
