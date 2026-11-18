"use strict";
import { T, TGroup, clock } from "./i18n.js";
import { $, VERB, el, laneOf } from "./core.js";
import { CHANNEL, ago, clampable, hm } from "./timeline.js";
import { dhm, md, mrow, openDoc, openFile, sameDay, setTab, tab, tok, updateHash, when } from "./memory.js";
// ---------- 事件记忆：一件件事、时间线、人、原话层、夜里的改动（全部只读，翻看不算她碰过） ----------
const EV_VIEWS = [["events", T("events.views.events")], ["people", T("events.views.people")], ["cards", T("events.views.cards")], ["quotes", T("events.views.quotes")], ["midterm", T("events.views.midterm")], ["batches", T("events.views.batches")]];
const CLAR = TGroup("events.clarity");
const CLAR_SHORT = TGroup("events.clarityShort");
const EST = TGroup("events.status");
const EKIND = TGroup("events.entryKind");
const EROLE = TGroup("events.role");
const EREL = TGroup("events.rel");
const ETOUCH = TGroup("events.touch");
const ENTK = TGroup("events.entityKind");
const BSTATE = TGroup("events.batchState");
// 10-31 起事件线文件收进档案（事件只在事件库里），出处链接指向档案里那一份
const THREADS_DIR = "memory/archive/threads/";
const ETBL = TGroup("events.table");
/** 改动记录里一步是什么操作：库里记的是代号，页面显示包里的叫法（没列的代号原样显示），代号留在悬停里 */
const EOP = TGroup("events.op");
/** 批次里人物卡的私密改动：服务端已经把原文换成这句（src/memory/events/people.ts 的 SECRET_SHOWN，这里的字面量要和它一字不差，test/console-lang.test.ts 看着）。
 *  它是给角色看的写法；页面上换成看的人的语言。只换这一句，别的一个字不动 */
const SECRET_SHOWN = "（私密，不显示）";
const shownSecret = (s) => s.replaceAll(SECRET_SHOWN, T("events.cards.secret"));
const QSRC = TGroup("events.quoteSrc");
let evView = "events", evSel = null, evFocus = null, evOv = null, evEnts = null, evListKey = "", evBatch = null, evPerson = null, evCard = null, evCards = null;
const evFilter = { q: "", status: "", min: "", who: "" };
const evQ = { q: "", src: "", who: "", offset: 0, items: [], total: 0 };
const spanOf = (a, b) => !a && !b ? T("common.dash") : !a || !b ? md(a || b) : sameDay(a, b) ? md(a) : T("events.dateRange", { from: md(a), to: md(b) });
const getJ = (u) => fetch(u).then((x) => x.json()).catch((e) => ({ error: String(e) }));

/** 文字里的事件编号（e0012）、条目编号（n00123）变成能点的 */
const ID_RE = /\b(e\d{4,6}|n\d{5,7})\b/g;
function linkIds(node, text) {
  if (!text || !ID_RE.test(text)) return;
  ID_RE.lastIndex = 0;
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(ID_RE)) {
    frag.append(text.slice(last, m.index));
    const b = el("button", "idlink", m[1]);
    b.title = T("events.openId", { id: m[1] });
    b.addEventListener("click", (e) => { e.stopPropagation(); openEvent(m[1]); });
    frag.append(b);
    last = m.index + m[0].length;
  }
  frag.append(text.slice(last));
  node.replaceChildren(frag);
}

async function refreshEvOverview() {
  const r = await getJ("/api/event-memory");
  if (r.error) { $("#estats").replaceChildren(el("span", "warn", T("events.overview.loadFailed", { error: r.error }))); return; }
  evOv = r;
  renderEStats();
}

function renderEStats() {
  const o = evOv, box = $("#estats");
  if (!o) return;
  if (!o.ready) { box.replaceChildren(el("span", "warn", T("events.overview.notReady"))); return; }
  const c = o.counts;
  const st = (label, n, tail) => { const x = el("span"); x.append(el("b", null, Number(n || 0).toLocaleString(T("common.locale"))), " " + label + (tail || "")); return x; };
  const nodes = [
    st(T("events.overview.events"), c.events), st(T("events.overview.entries"), c.entries, c.corrections ? T("events.overview.corrections", { n: c.corrections }) : ""), st(T("events.overview.entities"), c.entities),
    st(T("events.overview.quotes"), c.quotes, c.quotes ? T("events.overview.withVectors", { pct: Math.round((c.quoteVectors / c.quotes) * 100) }) : ""),
  ];
  // 向量断了只会悄悄退成全文检索（没额度、key 失效）：还差多少条（事件、经过、原话一起算），现在还在出错就标出来
  const v = o.vectors;
  if (v && v.missing) nodes.push(st(T("events.overview.noVector"), v.missing));
  if (v && v.lastErrorAt && (v.pausedUntil > clock() || !v.lastOkAt || v.lastErrorAt > v.lastOkAt)) nodes.push(el("span", "warn", T("events.overview.vectorError", { when: when(v.lastErrorAt), error: v.lastError }) + (v.pausedUntil && v.pausedUntil > clock() ? T("events.overview.vectorPaused", { until: when(v.pausedUntil) }) : "")));
  if (c.events) {
    const bar = el("div", "fadebar");
    const order = ["full", "gist", "title", "fold", "hidden"], op = { full: 1, gist: .7, title: .45, fold: .25, hidden: .1 };
    for (const k of order) { const n = o.clarity[k] || 0; if (!n) continue; const sp = el("span"); sp.style.width = (n / c.events * 100) + "%"; sp.style.opacity = op[k]; sp.title = T("events.overview.clarityBar", { clarity: CLAR[k], n }); bar.append(sp); }
    nodes.push(bar, el("span", null, T("events.overview.recallNow", { list: order.filter((k) => o.clarity[k]).map((k) => CLAR_SHORT[k] + " " + o.clarity[k]).join(T("common.comma")) })));
  }
  const f = o.flags;
  if (f) nodes.push(el("span", null, [
    f.enabled ? T("events.overview.toolsOn") : T("events.overview.toolsOff"),
    f.inject ? T("events.overview.assocNew") : T("events.overview.assocOff"),
    f.midterm ? T("events.overview.midtermOn") : T("events.overview.midtermOff"),
  ].join(T("common.comma"))));
  if (o.lastWrite) nodes.push(el("span", null, T("events.overview.lastWrite", { ago: ago(o.lastWrite) })));
  box.replaceChildren(...nodes);
}

function renderEViews() {
  $("#eviews").replaceChildren(...EV_VIEWS.map(([k, v]) => {
    const b = el("button", null, v);
    b.setAttribute("aria-pressed", String(k === evView));
    b.addEventListener("click", () => showEvView(k));
    return b;
  }));
}

function showEvView(v) {
  evView = v;
  renderEViews();
  updateHash();
  const wide = v === "quotes" || v === "midterm";
  $("#ebody").classList.toggle("wide", wide);
  $("#elist").replaceChildren();
  $("#edetail").replaceChildren(el("p", "hint", T("common.loading")));
  evListKey = "";
  if (v === "events") { buildEvFilter(); loadEvList(true); if (evSel) openEvent(evFocus || evSel); else evHint(); }
  else if (v === "people") loadPeople();
  else if (v === "cards") loadCards();
  else if (v === "quotes") loadQuotes(true);
  else if (v === "midterm") loadMidterm();
  else if (v === "batches") loadBatches();
}
function evHint() {
  const d = $("#edetail");
  d.replaceChildren(el("h3", null, T("shell.views.events")),
    el("p", "hint", T("events.detail.intro")),
    el("p", "hint", T("events.detail.introHow")));
  if (evOv && evOv.ready && !evOv.counts.events) d.append(el("p", "hint", T("events.detail.introEmpty")));
}

function buildEvFilter() {
  const f = el("div", "efilter");
  const q = el("input"); q.type = "search"; q.placeholder = T("events.list.search"); q.value = evFilter.q;
  let timer = null;
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { evFilter.q = q.value.trim(); loadEvList(true); }, 250); });
  const st = el("select");
  st.setAttribute("aria-label", T("events.list.byStatus"));
  st.append(new Option(T("events.list.allStatuses"), ""), ...Object.entries(EST).map(([k, v]) => new Option(v, k)));
  st.value = evFilter.status;
  st.addEventListener("change", () => { evFilter.status = st.value; loadEvList(true); });
  const mi = el("select");
  mi.setAttribute("aria-label", T("events.list.byImportance"));
  mi.append(new Option(T("events.list.allImportance"), ""), ...[5, 4, 3, 2, 1].map((n) => new Option(n === 5 ? T("events.list.onlyCore") : T("events.list.atLeast", { n }), String(n))));
  mi.value = evFilter.min;
  mi.addEventListener("change", () => { evFilter.min = mi.value; loadEvList(true); });
  const who = el("select");
  who.id = "evwho";
  who.setAttribute("aria-label", T("events.list.byWho"));
  who.addEventListener("change", () => { evFilter.who = who.value; loadEvList(true); });
  f.append(q, st, mi, who, el("div", "n"));
  $("#elist").replaceChildren(f, el("div", null));
  fillWho();
}
async function fillWho() {
  if (!evEnts) { const r = await getJ("/api/event-memory/entities"); evEnts = r.entities || []; }
  const who = $("#evwho");
  if (!who) return;
  who.replaceChildren(new Option(T("events.list.everyone"), ""), ...evEnts.filter((t) => t.events).map((t) => new Option(T("events.list.whoOption", { name: t.name, kind: ENTK[t.kind] || t.kind, n: t.events }), t.id)));
  who.value = evFilter.who;
}

async function loadEvList(force) {
  if (evView !== "events") return;
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(evFilter)) if (v) p.set(k, v);
  const r = await getJ("/api/event-memory/events?" + p);
  if (evView !== "events") return;
  const box = $("#elist"), list = box.children[1], count = box.querySelector(".efilter .n");
  if (!list) return;
  if (r.error) { list.replaceChildren(el("p", "hint", r.error)); return; }
  const key = r.total + "|" + r.items.map((e) => e.id + e.updated + e.clarity).join(",");
  if (!force && key === evListKey) return;
  evListKey = key;
  const filtered = Object.values(evFilter).some(Boolean);
  count.textContent = T("events.list.count", { n: r.total }) + (filtered ? T("events.filtered") : "") + (r.items.length < r.total ? T("events.list.firstOnly", { n: r.items.length }) : "");
  const top = box.scrollTop;
  const titleOf = new Map(r.items.map((e) => [e.id, e.title]));
  list.replaceChildren(...r.items.map((e) => {
    const b = el("button", "erow c-" + e.clarity + (e.id === evSel ? " sel" : ""));
    b.dataset.id = e.id;
    const imp = el("span", "imp i" + e.importance, String(e.importance));
    imp.title = T("events.list.importance", { n: e.importance });
    b.append(imp, el("span", "ti", e.title), el("span", "dt", e.ended || e.started ? spanOf(e.started, e.ended) : ""), el("span", "gi", e.gist),
      el("span", "mt", [e.parent ? T("events.list.partOf", { title: titleOf.get(e.parent) || e.parent }) : "", EST[e.status] || e.status, e.people.slice(0, 4).join(T("common.listSep")) + (e.people.length > 4 ? T("events.list.andMore") : ""), T("events.list.entries", { n: e.entries }), CLAR_SHORT[e.clarity], e.pinned ? T("events.list.pinned") : ""].filter(Boolean).join(T("common.comma"))));
    b.title = T("events.list.rowTitle", { id: e.id, clarity: CLAR[e.clarity] });
    b.addEventListener("click", () => openEvent(e.id));
    return b;
  }));
  if (!r.items.length) list.append(el("p", "hint", filtered ? T("events.list.noMatch") : T("events.list.empty")));
  box.scrollTop = top;
}

async function openEvent(ref) {
  // 别的页面点过来：先记下要看哪件，切过去以后由 showEvView 打开（免得旧的选中项后到、盖掉新的）
  if (tab !== "events" || evView !== "events") {
    evSel = ref; evFocus = ref.startsWith("n") ? ref : null; evView = "events";
    if (tab !== "events") setTab("events"); else showEvView("events");
    return;
  }
  evSel = ref.startsWith("e") ? ref : evSel; evFocus = ref.startsWith("n") ? ref : null;
  const r = await getJ("/api/event-memory/event?id=" + encodeURIComponent(ref));
  if (ref !== (evFocus || evSel)) return;
  if (r.error) { $("#edetail").replaceChildren(el("p", "hint", r.error)); return; }
  evSel = r.event.id; evFocus = r.focus;
  updateHash();
  for (const b of document.querySelectorAll("#elist .erow")) b.classList.toggle("sel", b.dataset.id === evSel);
  renderEvDetail(r);
}

function sourceRef(x) {
  const b = el("button", "ref", x);
  const q = /^q(\d+)$/.exec(x), c = /^c:(\d+)$/.exec(x), t = /^thread:(.+)$/.exec(x), tl = /^timeline#(\d+)$/.exec(x);
  if (q) { b.title = T("events.source.quote", { n: q[1] }); b.addEventListener("click", () => openQuote(x)); }
  else if (c) { b.title = T("events.source.central", { n: c[1] }); b.addEventListener("click", () => openCentral(Number(c[1]))); }
  else if (t) {
    // thread:<文件>#<第几条经过> 或 #判断<第几条>（10-31 搬家时记进来的「因果和判断」）
    const [, file, judge, line] = /^(.+?)(?:#(判断)?(\d+))?$/.exec(t[1]);
    b.title = T("events.source.thread", { file }) + (line ? (judge ? T("events.source.threadJudge", { n: line }) : T("events.source.threadLine", { n: line })) : "");
    b.addEventListener("click", () => openFileAt("ws:" + THREADS_DIR + file, file, line && !judge ? Number(line) : null));
  }
  else if (tl) {
    b.title = T("events.source.timeline", { n: tl[1] });
    b.addEventListener("click", () => openFileAt("ws:memory/archive/timeline-2026-10-31.md", "timeline-2026-10-31.md", Number(tl[1])));
  }
  else { b.disabled = true; b.style.cursor = "default"; }
  return b;
}
/** 打开记忆文件，跳到第 line 行并标出来（条目的出处 thread:文件#行） */
async function openFileAt(key, title, line) {
  const r = await getJ("/api/memory/file?key=" + encodeURIComponent(key));
  if (r.error) { openDoc(title, r.error, ""); return; }
  if (!line) { openDoc(title, T("events.source.fileSub", { kb: Math.round(r.bytes / 1024), when: dhm(r.mtime) }), r.text); return; }
  const lines = r.text.split("\n");
  openDoc(title, T("events.source.fileLineSub", { line, total: lines.length, when: dhm(r.mtime) }), "");
  const pre = $("#dsteps pre");
  const mark = el("mark", null, (lines[line - 1] ?? T("events.source.fileLineGone")) + "\n");
  pre.append(lines.slice(0, line - 1).join("\n") + (line > 1 ? "\n" : ""), mark, lines.slice(line).join("\n"));
  mark.scrollIntoView({ block: "center" });
}
async function openQuote(ref) {
  const r = await getJ("/api/event-memory/quotes?q=" + encodeURIComponent(ref));
  const x = r.items && r.items[0];
  if (!x) { openDoc(ref, T("events.source.quoteMissing"), ""); return; }
  openDoc(T("events.source.quoteTitle", { ref }), dhm(x.at) + T("common.comma") + (x.who || T("events.unknown")) + (x.channel ? T("events.paren", { text: CHANNEL[x.channel] || x.channel }) : "") + T("common.comma") + (QSRC[x.src] || x.src) + " " + x.ref, x.text);
}
async function openCentral(seq) {
  const r = await getJ("/api/central?after=" + (seq - 1) + "&limit=1");
  const x = r.rows && r.rows[0];
  if (!x || x.seq !== seq) { openDoc(T("events.source.central", { n: seq }), T("events.source.centralMissing"), ""); return; }
  openDoc(T("events.source.central", { n: seq }), T("events.source.centralSub", { when: dhm(x.ts), region: laneOf(x.src).name, verb: VERB[x.kind] || x.kind }), x.text);
}

function renderEvDetail(d) {
  const e = d.event, box = $("#edetail");
  const h = el("h3", null, e.title);
  h.append(el("small", null, e.id));
  const meta = el("div", "emeta");
  const m = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); meta.append(x); };
  m(T("events.importance"), e.importance + (e.importance === 5 ? T("events.detail.core") : ""));
  m(T("events.detail.status"), EST[e.status] || e.status);
  m(T("events.detail.time"), spanOf(e.started, e.ended));
  m(T("events.detail.clarityNow"), CLAR[e.clarity] + (e.pinned ? T("events.detail.pinned") : ""));
  m(T("events.detail.lastCleared"), e.touched ? ago(e.touched) : T("events.detail.never"));
  const nodes = [h, meta];
  if (e.supersededBy) { const p = el("p", "ewhy", T("events.detail.supersededPre")); const b = el("button", "idlink", T("events.detail.idTitle", { id: e.supersededBy, title: d.supersededTitle || "" })); b.addEventListener("click", () => openEvent(e.supersededBy)); p.append(b, T("events.detail.supersededPost")); nodes.push(p); }
  for (const x of d.supersedes) { const p = el("p", "ewhy", T("events.detail.supersedes")); const b = el("button", "idlink", T("events.detail.idTitle", { id: x.id, title: x.title })); b.addEventListener("click", () => openEvent(x.id)); p.append(b); nodes.push(p); }
  if (d.parent) { const p = el("p", "ewhy", T("events.detail.partOf")); const b = el("button", "idlink", T("events.detail.idTitle", { id: d.parent.id, title: d.parent.title })); b.addEventListener("click", () => openEvent(d.parent.id)); p.append(b); nodes.push(p); }
  if (e.why) nodes.push(el("p", "ewhy", T("events.detail.why", { why: e.why })));
  const sum = el("div", "esum", e.summary); linkIds(sum, e.summary);
  nodes.push(el("p", "egist", T("events.detail.gist", { gist: e.gist })), sum);
  if (e.threadPath) { const b = el("button", "link", T("events.detail.fromThread", { path: e.threadPath })); const tp = THREADS_DIR + e.threadPath.replace(/^memory\/threads\//, ""); b.addEventListener("click", () => openFile("ws:" + tp, e.threadPath)); nodes.push(b); }
  // 人和东西
  const chips = el("div", "chips");
  for (const t of d.entities) {
    const c = el("button", "chip", t.name); c.append(el("small", null, (ENTK[t.kind] || t.kind) + T("common.comma") + (EROLE[t.role] || t.role)));
    c.title = T("events.detail.onlyAbout", { name: t.name });
    c.addEventListener("click", () => { evFilter.who = t.id; buildEvFilter(); loadEvList(true); });
    chips.append(c);
  }
  const extra = e.people.filter((n) => !d.entities.some((t) => t.name === n));
  for (const n of extra) { const c = el("span", "chip", n); c.append(el("small", null, T("events.detail.inTimeline"))); chips.append(c); }
  if (d.entities.length || extra.length) nodes.push(el("h4", null, T("events.detail.who")), chips);
  // 子事件：大事拆成的一段段经过
  if (d.children && d.children.length) {
    nodes.push(el("h4", null, T("events.detail.children", { n: d.children.length })));
    for (const c of d.children) nodes.push(mrow(c.title, c.id, T("events.detail.childSub", { gist: c.gist, status: EST[c.status] || c.status, n: c.entries }), null, () => openEvent(c.id)));
  }
  if (d.links.length) {
    nodes.push(el("h4", null, T("events.detail.links")));
    for (const l of d.links) nodes.push(mrow(T("events.detail.linkTitle", { rel: EREL[l.rel] || l.rel, title: l.title || l.id }), l.id, l.note || null, null, () => openEvent(l.id)));
  }
  // 时间线
  nodes.push(el("h4", null, T("events.detail.timeline", { n: d.entries.length })));
  const tlx = el("div", "tlx");
  for (const n of d.entries) {
    const it = el("div", "ent k-" + n.kind + " c-" + n.clarity + (n.correctedBy ? " fixed" : "") + (n.id === evFocus ? " focus" : ""));
    it.id = "ent-" + n.id;
    const eh = el("div", "eh");
    eh.append(el("span", "t", dhm(n.at) + (n.until ? T("events.detail.until", { time: sameDay(n.at, n.until) ? hm(n.until).slice(0, 5) : dhm(n.until) }) : "")), el("span", "kd", EKIND[n.kind] || n.kind), el("span", "tt", n.title), el("span", "id", n.id), el("span", "cl", CLAR_SHORT[n.clarity]));
    const full = el("div", "full");
    const more = clampable(full, n.full, 8);
    linkIds(full, n.full);
    it.append(eh, full);
    if (more) it.append(more);
    const sub = el("div", "sub", T("events.detail.gist", { gist: n.gist }));
    if (n.people.length) sub.append(T("events.detail.entryPeople", { names: n.people.join(T("common.listSep")) }));
    if (n.corrects) { sub.append(T("events.detail.corrects")); const b = el("button", "idlink", n.corrects); b.addEventListener("click", () => document.getElementById("ent-" + n.corrects)?.scrollIntoView({ block: "center" })); sub.append(b); }
    if (n.correctedBy) { sub.append(T("events.detail.correctedPre")); const b = el("button", "idlink", n.correctedBy); b.addEventListener("click", () => document.getElementById("ent-" + n.correctedBy)?.scrollIntoView({ block: "center" })); sub.append(b, T("events.detail.correctedPost")); }
    const why = n.source.filter((x) => x.startsWith("why:")), refs = n.source.filter((x) => !x.startsWith("why:"));
    if (why.length) sub.append(T("events.detail.basis", { list: why.map((x) => x.slice(4)).join(T("events.semi")) }));
    if (refs.length) { sub.append(T("events.detail.sources")); refs.forEach((x) => sub.append(sourceRef(x))); }
    it.append(sub);
    tlx.append(it);
  }
  if (!d.entries.length) tlx.append(el("p", "hint", T("events.detail.noEntries")));
  nodes.push(tlx);
  // 碰过、改过
  nodes.push(el("h4", null, T("events.detail.touches", { n: d.touches.length })));
  if (!d.touches.length) nodes.push(el("p", "hint", T("events.detail.noTouches")));
  for (const t of d.touches.slice(0, 40)) nodes.push(mrow((ETOUCH[t.how] || t.how) + (t.ref !== e.id ? T("events.paren", { text: t.ref }) : ""), when(t.at), t.region ? laneOf(t.region).name : null));
  if (d.touches.length) nodes.push(el("p", "hint", T("events.detail.touchHint")));
  nodes.push(el("h4", null, T("events.detail.ops", { n: d.ops.length })));
  for (const o of d.ops) {
    const row = mrow(T("events.detail.opTitle", { when: when(o.at), op: EOP[o.op] || o.op, table: ETBL[o.tbl] || o.tbl }), o.batch, o.reason || null, null, () => { evBatch = o.batch; showEvView("batches"); });
    row.firstChild.title = o.op;
    nodes.push(row);
  }
  box.replaceChildren(...nodes);
  if (evFocus) document.getElementById("ent-" + evFocus)?.scrollIntoView({ block: "center" });
  else box.scrollTop = 0;
}

// 人和东西
async function loadPeople() {
  const r = await getJ("/api/event-memory/entities");
  if (evView !== "people") return;
  evEnts = r.entities || [];
  const f = el("div", "efilter");
  const q = el("input"); q.type = "search"; q.placeholder = T("events.people.search");
  const list = el("div");
  const draw = () => {
    const k = q.value.trim().toLowerCase();
    const items = evEnts.filter((t) => !k || t.name.toLowerCase().includes(k) || t.aliases.some((a) => a.toLowerCase().includes(k)));
    list.replaceChildren(...items.map((t) => {
      const b = el("button", "erow" + (t.id === evPerson ? " sel" : ""));
      b.dataset.id = t.id;
      b.append(el("span", "imp", (ENTK[t.kind] || t.kind).slice(0, 1)), el("span", "ti", t.name), el("span", "dt", t.last ? md(t.last) : ""),
        el("span", "gi", t.note || (t.aliases.length ? T("events.people.aka", { names: t.aliases.join(T("common.listSep")) }) : "")), el("span", "mt", T("events.people.rowMeta", { kind: ENTK[t.kind] || t.kind, importance: t.importance ?? T("events.unknown"), events: t.events, entries: t.entries })));
      b.addEventListener("click", () => openPerson(t.id));
      return b;
    }));
    if (!items.length) list.append(el("p", "hint", evEnts.length ? T("events.people.noMatch") : T("events.people.empty")));
  };
  q.addEventListener("input", draw);
  f.append(q, el("div", "n", T("events.people.count", { n: evEnts.length, people: evEnts.filter((t) => t.kind === "person").length })));
  $("#elist").replaceChildren(f, list);
  draw();
  if (evPerson) openPerson(evPerson); else $("#edetail").replaceChildren(el("h3", null, T("events.views.people")), el("p", "hint", T("events.people.intro")));
}
async function openPerson(id) {
  evPerson = id;
  for (const b of document.querySelectorAll("#elist .erow")) b.classList.toggle("sel", b.dataset.id === id);
  const t = (evEnts || []).find((x) => x.id === id);
  if (!t) return;
  const r = await getJ("/api/event-memory/events?who=" + encodeURIComponent(id));
  const d = $("#edetail");
  const h = el("h3", null, t.name); h.append(el("small", null, t.id));
  const meta = el("div", "emeta");
  const m = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); meta.append(x); };
  m(T("events.kind"), ENTK[t.kind] || t.kind);
  m(T("events.importance"), t.importance === null ? T("events.people.unrated") : String(t.importance) + (t.why ? T("events.paren", { text: t.why }) : ""));
  if (t.aliases.length) m(T("events.people.akaLabel"), t.aliases.join(T("common.listSep")));
  if (t.personKey) m(T("events.people.profile"), t.personKey);
  m(T("events.people.appearsIn"), T("events.people.appearsValue", { events: t.events, entries: t.entries }));
  if (t.last) m(T("events.people.last"), when(t.last));
  const nodes = [h, meta];
  if (t.note) nodes.push(el("p", "ewhy", t.note));
  const b = el("button", "link", T("events.showRelated"));
  b.addEventListener("click", () => { evFilter.who = id; showEvView("events"); });
  nodes.push(b);
  if (t.kind === "person" || t.kind === "group") {
    const cb = el("button", "link", T("events.people.openCard"));
    cb.addEventListener("click", () => { evCard = id; showEvView("cards"); });
    nodes.push(el("span", null, " · "), cb);
  }
  nodes.push(el("h4", null, T("events.people.eventsTitle")));
  for (const e of r.items || []) { const row = mrow(T("events.people.eventTitle", { importance: e.importance, title: e.title }), spanOf(e.started, e.ended), T("events.people.eventSub", { gist: e.gist, clarity: CLAR_SHORT[e.clarity] }), null, () => openEvent(e.id)); row.classList.add("c-" + e.clarity); nodes.push(row); }
  d.replaceChildren(...nodes);
}

// People cards: like hh mem card, only the public side; what a guest said in private is never shown as written
const PST = TGroup("events.cards.status");
const POP = TGroup("events.cards.op");
const PKIND = TGroup("events.cards.kind");
async function loadCards() {
  const r = await getJ("/api/event-memory/people");
  if (evView !== "cards") return;
  evCards = r.people || [];
  const list = el("div");
  list.replaceChildren(...evCards.map((p) => {
    const b = el("button", "erow" + (p.id === evCard ? " sel" : ""));
    b.dataset.id = p.id;
    const imp = el("span", "imp" + (p.owner ? " i5" : ""), p.owner ? T("events.cards.ownerBadge") : (PKIND[p.kind] || PKIND.person).slice(0, 1));
    b.append(imp, el("span", "ti", p.name), el("span", "dt", p.updated ? md(p.updated) : ""),
      el("span", "gi", p.relation || T("events.cards.noRelation")),
      el("span", "mt", T("events.cards.rowTotal", { total: p.total, cap: p.cap }) + (p.pending ? T("events.cards.rowPending", { n: p.pending }) : "")));
    b.addEventListener("click", () => openCard(p.id));
    return b;
  }));
  if (!evCards.length) list.append(el("p", "hint", r.enabled === false ? T("events.cards.disabled") : r.error ? T("events.cards.loadFailed", { error: r.error }) : T("events.cards.empty")));
  const f = el("div", "efilter");
  f.append(el("div", "n", T("events.cards.count", { n: evCards.length }) + (evCards.some((p) => p.pending) ? T("events.cards.somePending") : "")));
  $("#elist").replaceChildren(f, list);
  if (evCard) openCard(evCard);
  else $("#edetail").replaceChildren(el("h3", null, T("events.views.cards")), el("p", "hint", T("events.cards.intro")));
}
async function openCard(id) {
  evCard = id;
  for (const b of document.querySelectorAll("#elist .erow")) b.classList.toggle("sel", b.dataset.id === id);
  const d = $("#edetail");
  const c = await getJ("/api/event-memory/person?id=" + encodeURIComponent(id));
  if (evView !== "cards" || evCard !== id) return;
  if (!c.person) { d.replaceChildren(el("h3", null, T("events.views.cards")), el("p", "hint", c.error || T("events.cards.noCard"))); return; }
  const p = c.person;
  const h = el("h3", null, p.name); h.append(el("small", null, p.id));
  const meta = el("div", "emeta");
  const m = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); meta.append(x); };
  m(T("events.kind"), p.owner ? T("events.cards.owner") : (PKIND[p.kind] || p.kind) + (p.key ? T("events.cards.rosterKey", { key: p.key }) : ""));
  m(T("events.cards.total"), T("events.cards.totalValue", { total: p.total, cap: p.cap }));
  if (p.updated) m(T("events.cards.lastChange"), when(p.updated));
  if (p.pending) m(T("events.cards.pending"), T("events.cards.pendingValue", { n: p.pending }));
  const nodes = [h, meta];
  const eb = el("button", "link", T("events.showRelated"));
  eb.addEventListener("click", () => { evFilter.who = id; showEvView("events"); });
  nodes.push(eb);
  for (const s of c.sections) {
    const sec = el("div", "psec" + (s.kind === "computed" ? " computed" : ""));
    const sh = el("h4"); sh.append(el("span", null, s.name));
    if (s.usage) sh.append(el("span", "u" + (s.over ? " over" : ""), s.usage));
    if (s.kind === "computed") sh.append(el("span", "u", T("events.cards.computed")));
    sec.append(sh, el("div", "pbody", s.text));
    nodes.push(sec);
  }
  if (!c.sections.length) nodes.push(el("p", "hint", c.privateCount ? T("events.cards.publicEmpty") : T("events.cards.nothingLive")));
  if (c.privateCount) nodes.push(el("p", "pnote", T("events.cards.privateCount", { n: c.privateCount })));
  if (c.pending.length) {
    nodes.push(el("h4", null, T("events.cards.pendingTitle", { n: c.pending.length })));
    for (const x of c.pending) {
      const b = el("div", "ppend");
      b.append(el("div", "t", x.id + " · " + x.section + " · " + x.change));
      if (x.secret) b.append(el("div", "hint", T("events.cards.secret")));
      else {
        if (x.text) b.append(el("div", "pbody", x.text));
        if (x.why) b.append(el("p", "ewhy", T("events.cards.why", { why: x.why })));
      }
      if (x.stale) b.append(el("div", "stale", T("events.cards.stale")));
      nodes.push(b);
    }
    nodes.push(el("p", "hint", T("events.cards.approveHint", { id: c.pending[0].id, name: p.name })));
  }
  nodes.push(el("h4", null, T("events.cards.history", { n: c.history.length })));
  for (const x of c.history) {
    const det = el("details", "phist");
    const sum = el("summary");
    sum.append(el("span", null, when(x.updated)), el("b", null, x.section), el("span", "s " + x.status, PST[x.status] || x.status), el("span", "id", x.id + (x.kind === "quote" ? T("events.cards.quoteTag") : "")));
    det.append(sum);
    if (x.secret) det.append(el("div", "pbody hint", T("events.cards.secret")));
    else {
      det.append(el("div", "pbody", x.text || T("events.cards.cleared")));
      if (x.why) det.append(el("p", "ewhy", T("events.cards.why", { why: x.why })));
    }
    const ops = el("div", "ops");
    for (const o of x.ops) {
      const a = el("button", "link", o.batch);
      a.addEventListener("click", () => { evBatch = o.batch; showEvView("batches"); });
      ops.append(el("span", null, when(o.at) + " " + (POP[o.op] || o.op) + " · "), a, el("br"));
    }
    det.append(ops);
    nodes.push(det);
  }
  d.replaceChildren(...nodes);
  d.scrollTop = 0;
}

// 原话层
async function loadQuotes(reset) {
  if (reset) { evQ.offset = 0; evQ.items = []; }
  const p = new URLSearchParams({ offset: String(evQ.offset), limit: "100" });
  for (const k of ["q", "src", "who"]) if (evQ[k]) p.set(k, evQ[k]);
  const r = await getJ("/api/event-memory/quotes?" + p);
  if (evView !== "quotes") return;
  const d = $("#edetail");
  if (r.error) { d.replaceChildren(el("p", "hint", r.error)); return; }
  evQ.items.push(...r.items); evQ.total = r.total;
  let f = d.querySelector(".efilter");
  if (!f || reset === "full") {
    f = el("div", "efilter");
    const q = el("input"); q.type = "search"; q.placeholder = T("events.quotes.search"); q.value = evQ.q;
    let timer = null;
    q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => { evQ.q = q.value.trim(); loadQuotes(true); }, 300); });
    const src = el("select");
    src.setAttribute("aria-label", T("events.quotes.bySource"));
    src.append(new Option(T("events.quotes.allSources"), ""), ...((evOv && evOv.quotes) || []).map((x) => new Option(T("events.quotes.srcOption", { src: QSRC[x.src] || x.src, n: x.n }), x.src)));
    src.value = evQ.src;
    src.addEventListener("change", () => { evQ.src = src.value; loadQuotes(true); });
    const who = el("input"); who.type = "search"; who.placeholder = T("events.quotes.who"); who.value = evQ.who; who.style.flex = "0 1 120px";
    who.addEventListener("change", () => { evQ.who = who.value.trim(); loadQuotes(true); });
    f.append(q, src, who, el("div", "n"));
    d.replaceChildren(el("h3", null, T("events.views.quotes")), el("p", "hint", T("events.quotes.intro")), f, el("div", "qlist"));
  }
  f.querySelector(".n").textContent = T("events.quotes.count", { n: evQ.total.toLocaleString(T("common.locale")) }) + (evQ.q || evQ.src || evQ.who ? T("events.filtered") : "") + T("events.quotes.listed", { n: evQ.items.length });
  const list = d.querySelector(".qlist");
  if (reset) list.replaceChildren();
  list.querySelector(".older")?.remove();
  for (const x of r.items) {
    const row = el("div", "qrow");
    const w = el("div", "qw", x.who || T("events.unknown")); w.append(el("small", null, "q" + x.id + " " + (QSRC[x.src] || x.src) + (x.channel ? " " + (CHANNEL[x.channel] || x.channel) : "")));
    const t = el("div", "x");
    const more = clampable(t, x.text, 6);
    const body = el("div"); body.append(t); if (more) body.append(more);
    row.append(el("div", "t", dhm(x.at)), w, body);
    list.append(row);
  }
  if (!evQ.items.length) list.append(el("p", "hint", T("events.quotes.none")));
  if (evQ.items.length < evQ.total) { const b = el("button", "older", T("events.quotes.more")); b.addEventListener("click", () => { evQ.offset = evQ.items.length; loadQuotes(false); }); list.append(b); }
}

// 中期视图
async function loadMidterm() {
  const r = await getJ("/api/event-memory/midterm");
  if (evView !== "midterm") return;
  const d = $("#edetail");
  if (r.error) { d.replaceChildren(el("h3", null, T("events.views.midterm")), el("p", "hint", r.error)); return; }
  const pre = el("pre", "doc", r.text);
  linkIds(pre, r.text);
  pre.style.padding = "8px 0 30px";
  d.replaceChildren(el("h3", null, T("events.midterm.title")),
    el("p", "hint", (r.inPrefix ? T("events.midterm.inPrefix") : T("events.midterm.notInPrefix")) + T("events.midterm.size", { tokens: tok(r.tokens), chars: r.chars.toLocaleString(T("common.locale")), ago: ago(r.mtime) })),
    pre);
}

// 夜里改了什么
function batchName(id) {
  const arch = /^(.*)~reverted@\d+$/.exec(id);
  if (arch) return T("events.batches.archived", { name: batchName(arch[1]) });
  const n = /^night:([^/]+)\/(.+)$/.exec(id);
  // 日期：中文照原样写 11-12，别的语言用月份缩写；整理的就是那一晚的同一天，就不再说一遍「整理哪天」
  const dayOf = (iso) => T("common.dates") === "numeric" || !/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso.slice(5) : md(new Date(iso + "T12:00:00").getTime());
  if (n) return T("events.batches.night", { day: dayOf(n[1]) }) + (n[2] === "today" || n[2] === n[1] ? "" : T("events.batches.nightOf", { day: dayOf(n[2]) }));
  const i = /^import:(.+)$/.exec(id);
  return i ? T("events.batches.import", { file: i[1] }) : id;
}
async function loadBatches() {
  if (!evOv) await refreshEvOverview();
  if (evView !== "batches") return;
  const o = evOv || { batches: [], days: [] };
  const f = el("div", "efilter");
  f.append(el("div", "n", T("events.batches.count", { n: o.batches.length }) + (o.dayLikes ? T("events.batches.dayLikes", { n: o.dayLikes }) : "")));
  const list = el("div");
  list.replaceChildren(...o.batches.map((b) => {
    const r = el("button", "erow" + (b.id === evBatch ? " sel" : "") + (b.state === "reverted" ? " c-title" : ""));
    r.dataset.id = b.id;
    r.append(el("span", "imp", b.state === "committed" ? "✓" : b.state === "reverted" ? "↺" : "…"), el("span", "ti", batchName(b.id)), el("span", "dt", when(b.started)),
      el("span", "gi", (BSTATE[b.state] || b.state) + T("common.comma") + T("events.batches.steps", { n: b.ops })), el("span", "mt", b.id));
    r.addEventListener("click", () => openBatch(b.id));
    return r;
  }));
  if (!o.batches.length) list.append(el("p", "hint", T("events.batches.empty")));
  $("#elist").replaceChildren(f, list);
  if (evBatch) openBatch(evBatch);
  else {
    const d = $("#edetail");
    d.replaceChildren(el("h3", null, T("events.views.batches")), el("p", "hint", T("events.batches.intro")), el("h4", null, T("events.batches.daysTitle")));
    if (!o.days.length) d.append(el("p", "hint", T("events.batches.noDays")));
    for (const x of o.days) d.append(mrow(x.day, T("events.batches.doneAt", { when: when(x.doneAt) })));
  }
}
async function openBatch(id) {
  evBatch = id;
  for (const b of document.querySelectorAll("#elist .erow")) b.classList.toggle("sel", b.dataset.id === id);
  const r = await getJ("/api/event-memory/batch?id=" + encodeURIComponent(id));
  const d = $("#edetail");
  if (r.error) { d.replaceChildren(el("p", "hint", r.error)); return; }
  const b = r.batch;
  const nodes = [el("h3", null, batchName(id))];
  const meta = el("div", "emeta");
  if (b) { meta.append(el("span", null, BSTATE[b.state] || b.state), el("span", null, T("events.batches.started", { when: when(b.started) })), el("span", null, b.ended ? T("events.batches.ended", { when: when(b.ended) }) : T("events.batches.notEnded")), el("span", null, T("events.batches.steps", { n: r.ops.length }))); }
  nodes.push(meta);
  if (b && b.state === "reverted") nodes.push(el("p", "hint", id.includes("~reverted@")
    ? T("events.batches.revertedArchive")
    : T("events.batches.revertedMoved")));
  for (const o of r.ops) {
    const row = el("div", "oprow");
    const oh = el("div", "oh");
    let key = o.key; try { key = Object.values(JSON.parse(o.key)).join(" / "); } catch {}
    const k = el("span", null, key); linkIds(k, key);
    const ob = el("b", null, EOP[o.op] || o.op); ob.title = o.op;
    oh.append(el("span", "t", hm(o.at)), ob, el("span", null, ETBL[o.tbl] || o.tbl), k);
    row.append(oh);
    if (o.reason) row.append(el("div", "hint", shownSecret(o.reason)));
    if (o.op === "revert_conflict") { nodes.push(row); continue; }   // 撤回时没能撤的：只有原因
    const det = el("details");
    det.append(el("summary", "hint", o.before && o.after ? T("events.batches.beforeAfter") : o.after ? T("events.batches.written") : T("events.batches.deleted")));
    if (o.before) det.append(el("pre", null, T("events.batches.before", { json: shownSecret(o.before) })));
    if (o.after) det.append(el("pre", null, T("events.batches.after", { json: shownSecret(o.after) })));
    row.append(det);
    nodes.push(row);
  }
  d.replaceChildren(...nodes);
  d.scrollTop = 0;
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putEvFocus(v) { return evFocus = v; }
function putEvSel(v) { return evSel = v; }
function putEvView(v) { return evView = v; }
export { EV_VIEWS, evFocus, evSel, evView, linkIds, loadEvList, refreshEvOverview, showEvView, putEvFocus, putEvSel, putEvView };
