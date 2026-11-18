"use strict";
import { T, TGroup, clock } from "./i18n.js";
import { $, TOOL_CN, el, gateDay, gateOpen, laneOf, lens, persist, putLens } from "./core.js";
import { ago, hm, rows } from "./timeline.js";
import { allRegions, brain, lastStatus, paintBrain, renderCard } from "./brain.js";
import { renderIntro } from "./nav.js";
import { loadGate } from "./gate.js";
import { drawerTimer, putDrawerName } from "./drawer.js";
import { loadPrompt, promptRegion, putPromptRegion } from "./prompt.js";
import { evFocus, evSel, evView, putEvView, refreshEvOverview, showEvView } from "./events.js";
import { healthView, loadHealth } from "./health.js";
import { loadNotebook, nbSel, nbView } from "./notebook.js";
import { refreshNow } from "./now.js";
import { loadSettings } from "./settings.js";
import { machineView, refreshMachine, showMachine } from "./machine.js";
// ---------- 记忆页 ----------
const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs, text) => { const x = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) x.setAttribute(k, String(v)); if (text != null) x.textContent = text; return x; };
const tok = (n) => n >= 10_000 ? Math.round(n / 1000) + "k" : n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(Math.round(n));
/** 月日。中文照原来的数字写法（11-12）；别的语言用那个地区的月份缩写（Nov 12），由包里的 common.dates 定 */
const md = (ts) => { const d = new Date(ts); return T("common.dates") === "numeric" ? (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0") : d.toLocaleDateString(T("common.locale"), { month: "short", day: "numeric" }); };
const dhm = (ts) => T("common.dateTime", { date: md(ts), time: hm(ts).slice(0, 5) });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const when = (ts) => sameDay(ts, clock()) ? hm(ts).slice(0, 5) : dhm(ts);
const REASON = Object.assign(Object.create(null), { boot: T("memory.reason.boot"), "page-turn": T("memory.reason.pageTurn"), wake: T("memory.reason.wake") });
const END = Object.assign(Object.create(null), {
  "page-turn": { name: T("memory.end.pageTurn"), color: "--l-main" },
  sleep: { name: T("memory.end.sleep"), color: "--l-hippo" },
  restart: { name: T("memory.end.restart"), color: "--l-system" },
  current: { name: T("common.now"), color: "--l-main" },
});
/** 前缀里每一段是什么（颜色分三类：人格和规矩、长期记忆快照、今天的压缩记忆）。文件按文件名认；不是文件的那几段按服务端给的代号 id 认（memory.ts 的 PrefixPart） */
const PART = Object.assign(Object.create(null), {
  runtime: { short: T("memory.part.runtimeNote.short"), what: T("memory.part.runtimeNote.what"), color: "--l-system" },
  frame: { short: T("memory.part.frame.short"), what: T("memory.part.frame.what"), color: "--l-system" },
  "IDENTITY.md": { short: T("memory.part.identity.short"), what: T("memory.part.identity.what"), color: "--l-main" },
  "SOUL.md": { short: T("memory.part.soul.short"), what: T("memory.part.soul.what"), color: "--l-main" },
  "USER.md": { short: T("memory.part.user.short"), what: T("memory.part.user.what"), color: "--l-main" },
  "MEMORY.md": { short: T("memory.part.memory.short"), what: T("memory.part.memory.what"), color: "--l-side" },
  "AGENTS.md": { short: T("memory.part.agents.short"), what: T("memory.part.agents.what"), color: "--l-main" },
  "SOUL.memory.md": { short: T("memory.part.soulMemory.short"), what: T("memory.part.soulMemory.what"), color: "--l-side" },
  "ledger/SOUL.md": { short: T("memory.part.ledger.short"), what: T("memory.part.ledger.what"), color: "--l-side" },
  midterm: { short: T("memory.part.midterm.short"), what: T("memory.part.midterm.what"), color: "--l-side" },
});
/** 前缀里不是文件、但算记忆的部分 */
const isMemNote = (p) => p.kind === "note" && p.id === "midterm";
/** 前缀里算「记忆」的文件：MEMORY.md，加上过渡句「你的人生」之后的文件（没有过渡句的旧拼法就是账本快照） */
function memoryFileNames() {
  if (!mem) return new Set(["MEMORY.md", "ledger/SOUL.md"]);
  const i = mem.prefix.findIndex((p) => p.id === "frame");
  const after = i < 0 ? ["ledger/SOUL.md"] : mem.prefix.slice(i + 1).filter((p) => p.kind === "file").map((p) => p.name);
  return new Set(["MEMORY.md", ...after]);
}
const partOf = (p) => p.kind === "block" ? { short: T("memory.part.block.short", { n: p.n }), what: T("memory.part.block.what"), color: "--l-hippo" } : PART[p.kind === "file" ? p.name : p.id] || { short: p.name, what: "", color: "--l-main" };

let tab = "now", mem = null, memNode = null, memPageId = null;
const mnodes = new Map([...document.querySelectorAll("#memmap .mnode")].map((g) => [g.dataset.node, g]));
for (const [k, g] of mnodes) {
  g.addEventListener("click", () => memSelect(k, true));
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); memSelect(k, true); } });
}
function paintMemSel() { for (const [k, g] of mnodes) g.classList.toggle("sel", k === memNode && memPageId === null); }

/** 记忆的几块，在大脑上放在哪（照 10-25 体检报告的「快慢两套学习系统」：快的在海马，慢的在皮层） */
const MEM = Object.assign(Object.create(null), {
  page: { name: T("brain.map.memMain"), where: T("regions.main.where"), tier: "carry", color: "--l-perception", what: T("memory.brain.what.page") },
  self: { name: T("memory.brain.selfName"), where: T("memory.brain.selfWhere"), tier: "carry", color: "--l-main", what: T("memory.brain.what.self") },
  blocks: { name: T("brain.map.memHippocampus"), where: T("regions.hippocampus.where"), tier: "carry", color: "--l-hippo", what: T("memory.brain.what.blocks") },
  longterm: { name: T("brain.map.memGate"), where: T("memory.brain.longtermWhere"), tier: "carry", color: "--l-side", what: T("memory.brain.what.longterm") },
  recall: { name: T("brain.map.memSide"), where: T("regions.side.where"), tier: "intuit", color: "--l-speech", what: T("memory.brain.what.recall") },
  skills: { name: T("brain.map.memSystem"), where: T("regions.system.where"), tier: "store", color: "--l-system", what: T("memory.brain.what.skills") },
  central: { name: T("brain.map.memOuter"), where: T("regions.outer.where"), tier: "store", color: "--l-outer", what: T("memory.brain.what.central") },
});
const TIER = TGroup("memory.brain.tier");

function memSelect(node, fromMap) {
  memNode = node && (node !== memNode || memPageId !== null || fromMap) ? node : null;
  memPageId = null;
  paintMemSel(); paintBrain(); renderCard(); renderMemDetail(); updateHash();
  if (memNode) $("#mempane").scrollTop = 0;
}

function setLens(l) {
  putLens(l);
  persist();
  brain.classList.toggle("mem", l === "memory");
  for (const t of brain.querySelectorAll("[data-mlabel]")) {
    if (t.dataset.tlabel === undefined) t.dataset.tlabel = t.textContent;
    t.textContent = l === "memory" ? t.dataset.mlabel : t.dataset.tlabel;
    if (t.dataset.mx) { if (t.dataset.tx === undefined) t.dataset.tx = t.getAttribute("x"); t.setAttribute("x", l === "memory" ? t.dataset.mx : t.dataset.tx); }
  }
  for (const g of allRegions) {
    if (g.dataset.tlane === undefined) g.dataset.tlane = g.style.getPropertyValue("--lane");
    const m = MEM[g.dataset.mem];
    g.style.setProperty("--lane", l === "memory" && m ? "var(" + m.color + ")" : g.dataset.tlane);
    g.classList.remove("carry", "intuit", "store", "none", "sel", "busy", "closed", "flash");
    // 回到「在想什么」：提示换回脑区自己的（记忆那一面换过）
    const t = g.querySelector("title");
    if (l !== "memory" && t && g.dataset.ttitle !== undefined) t.textContent = g.dataset.ttitle;
  }
  showPanes();
  if (l !== "memory" && gateOpen) loadGate(false);   // 闸门那一页又露出来：重读
  $("#strip").hidden = l === "memory";
  $("#others").hidden = l === "memory";
  if (l === "memory") refreshMemory();
  paintBrain(); renderCard(); updateHash();
}
/** 中间那一栏放什么：记忆那一面是记忆页；在想什么那一面是时间线，或者点开的下意识（闸门）。页头的视图钮跟着亮（nav.js） */
function showPanes() {
  $("#tlpane").hidden = lens === "memory" || gateOpen;
  $("#gatepane").hidden = lens === "memory" || !gateOpen;
  $("#mempane").hidden = lens !== "memory";
}

function updateHash() {
  renderIntro();
  if (location.hash.startsWith("#w=")) return;
  const h = tab === "now" ? "" : tab === "settings" ? "#settings" : tab === "machine" ? "#machine" + (machineView === "monitor" ? ":monitor" : "")
    : tab === "prompt" ? "#in:" + promptRegion
    : tab === "events" ? "#ev" + (evView === "events" ? (evSel ? ":" + (evFocus || evSel) : "") : ":" + evView)
    : tab === "health" ? "#health" + (healthView === "week" ? ":week" : "")
    : tab === "notebook" ? "#nb" + (nbSel ? ":" + nbSel : nbView !== "all" ? ":" + nbView : "")
    : lens === "memory" ? "#mem" + (memNode ? ":" + memNode : "")
    : gateOpen ? "#gate" + (gateDay ? ":" + gateDay : "") : "#activity";
  if (location.hash !== h) history.replaceState(null, "", h || location.pathname);
}

/** 记忆这一面：每块的亮度 = 每轮带着的 token 有多少；实线 = 直接带着，点线 = 直觉，虚线 = 仓库 */
function memCarried() {
  if (!mem) return {};
  const memFiles = memoryFileNames();
  const sumOf = (pred) => mem.prefix.filter(pred).reduce((n, p) => n + p.tokens, 0);
  const cur = mem.pages[mem.pages.length - 1];
  return {
    self: sumOf((p) => (p.kind === "note" && !isMemNote(p)) || (p.kind === "file" && !memFiles.has(p.name))),
    longterm: sumOf((p) => (p.kind === "file" && memFiles.has(p.name)) || isMemNote(p)),
    blocks: mem.prefix.filter((p) => p.kind === "block").reduce((n, p) => n + p.tokens, 0),
    page: cur ? cur.tokens : 0,
  };
}
function paintMemBrain() {
  const c = memCarried();
  const max = Math.max(1, ...Object.values(c));
  for (const g of allRegions) {
    const k = g.dataset.mem;
    const m = MEM[k];
    g.classList.remove("busy", "closed", "flash");
    g.classList.toggle("none", !m);
    for (const t of ["carry", "intuit", "store"]) g.classList.toggle(t, !!m && m.tier === t);
    g.classList.toggle("sel", !!m && k === memNode);
    const v = c[k] !== undefined ? Math.sqrt(c[k] / max) * 0.9 : k === "recall" ? 0.35 : k === "skills" ? 0.25 : k === "central" ? 0.2 : 0;
    g.style.setProperty("--act", v.toFixed(3));
    const t = g.querySelector("title");
    if (m && t) { if (g.dataset.ttitle === undefined) g.dataset.ttitle = t.textContent; t.textContent = T("memory.brain.regionTitle", { name: m.name, where: m.where, what: m.what }); }
  }
  brain.classList.toggle("picking", !!memNode);
}
function renderMemCard() {
  const card = $("#card");
  const legend = el("div", "legend3");
  legend.innerHTML = '<span><i></i>' + T("memory.card.legendCarry") + '</span><span><i class="d"></i>' + T("memory.card.legendIntuit") + '</span><span><i class="s"></i>' + T("memory.card.legendStore") + '</span>';
  if (!mem) { card.replaceChildren(el("p", "hint", T("memory.card.loading")), legend); return; }
  const c = memCarried();
  if (!memNode) {
    card.style.removeProperty("--lane");
    const carried = c.self + c.longterm + c.blocks;
    const files = mem.areas.reduce((n, a) => n + a.files, 0);
    card.replaceChildren(
      el("p", "hint", T("memory.card.hint")),
      legend,
      el("p", "hint", T("memory.card.summary", { carried: tok(carried), self: tok(c.self), longterm: tok(c.longterm), blocks: tok(c.blocks), page: tok(c.page), rows: mem.central.rows.toLocaleString(T("common.locale")), files, events: mem.events && mem.events.ready ? T("memory.card.summaryEvents", { n: mem.events.counts.events }) : "", skills: mem.skills ? T("memory.card.summarySkills", { n: mem.skills.files }) : "" })),
    );
    return;
  }
  const m = MEM[memNode];
  if (!m) { card.replaceChildren(legend); return; }
  card.style.setProperty("--lane", "var(" + m.color + ")");
  const h = el("h3", null, m.name);
  h.append(el("small", null, m.where + T("common.comma") + TIER[m.tier]));
  const facts = el("div", "facts");
  const fact = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); facts.append(x); };
  if (c[memNode] !== undefined) fact(T("memory.card.carried"), T("memory.tokens", { n: tok(c[memNode]) }));
  if (memNode === "page") { const cur = mem.pages[mem.pages.length - 1]; if (cur) fact(T("memory.map.page"), T("memory.card.thisPageValue", { id: cur.id, tokens: tok(cur.tokens), limit: tok(mem.limits.pageTokens) })); }
  if (memNode === "blocks") fact(T("memory.card.blockCount"), T("memory.card.blockCountValue", { n: mem.blocks.filter((b) => b.cleared === null).length }));
  if (memNode === "longterm") fact(T("memory.card.files"), T("memory.card.filesValue", { n: mem.areas.reduce((n, a) => n + a.files, 0) }));
  if (memNode === "central") fact(T("memory.card.quotes"), T("memory.card.quotesValue", { n: mem.central.rows.toLocaleString(T("common.locale")) }));
  if (memNode === "skills" && mem.skills) fact(T("memory.skills.manuals"), T("memory.skills.manualCount", { n: mem.skills.files }));
  card.replaceChildren(h, el("p", "what", m.what), facts, legend);
}

function setTab(t) {
  tab = t;
  $("#brainview").hidden = t !== "brain";
  $("#nowview").hidden = t !== "now";
  $("#promptview").hidden = t !== "prompt";
  $("#memview").hidden = t !== "events";
  $("#healthview").hidden = t !== "health";
  $("#notebookview").hidden = t !== "notebook";
  $("#settingsview").hidden = t !== "settings";
  $("#machineview").hidden = t !== "machine";
  updateHash();
  if (t === "prompt") loadPrompt(promptRegion);
  if (t === "brain") { refreshMemory(); if (gateOpen && lens !== "memory") loadGate(false); }
  if (t === "events") { refreshEvOverview().then(() => showEvView(evView)); }
  if (t === "health") loadHealth();
  if (t === "notebook") loadNotebook();
  if (t === "now") refreshNow();
  if (t === "settings") loadSettings();
  if (t === "machine") refreshMachine().then(() => showMachine(machineView));
}

async function refreshMemory() {
  if (tab !== "brain" || lens !== "memory") return;
  const r = await fetch("/api/memory").then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (r.error) { $("#mdetail").replaceChildren(el("p", "hint", T("memory.loadFailed", { error: r.error }))); return; }
  mem = r;
  paintMemMap(); renderPages(); renderMemDetail(); paintBrain(); renderCard();
}

function setText(id, t) { const n = document.getElementById(id); if (n) n.textContent = t; }

function paintMemMap() {
  const L = mem.limits;
  // 前缀：按 token 比例画成一条
  const parts = mem.prefix;
  const total = parts.reduce((s, p) => s + p.tokens, 0) || 1;
  setText("mm-prefix-total", T("memory.aboutTokens", { n: tok(total) }));
  const bar = $("#mm-prefix-bar");
  bar.replaceChildren();
  let x = 58;
  const W = 864;
  parts.forEach((p) => {
    const w = Math.max(3, (p.tokens / total) * W);
    const info = partOf(p);
    const r = svgEl("rect", { class: "seg", x: x.toFixed(1), y: 76, width: Math.max(1, w - 1).toFixed(1), height: 34, rx: 3 });
    r.style.fill = "var(" + info.color + ")";
    r.style.fillOpacity = p.missing ? ".2" : ".88";
    r.append(svgEl("title", {}, T("memory.map.partTitle", { name: p.name, tokens: tok(p.tokens) }) + (info.what ? T("common.comma") + info.what : "")));
    bar.append(r);
    if (w > 46) bar.append(svgEl("text", { class: "seglbl", x: (x + 7).toFixed(1), y: 98 }, w > 96 ? info.short + " " + tok(p.tokens) : info.short));
    x += w;
  });
  // 外界 + 各脑区：最近 1 小时写进来多少条（时间线那边已经有的数据）
  const hour = rows.filter((r) => r.ts >= clock() - 3600_000).length;
  setText("mm-src", T("memory.map.perHour", { n: hour }));
  // 这一页
  const cur = mem.pages[mem.pages.length - 1];
  if (cur) {
    setText("mm-page-title", T("memory.map.pageTitle", { id: cur.id }));
    setText("mm-page-num", tok(cur.tokens) + " / " + tok(L.pageTokens));
    $("#mm-page-fill").setAttribute("width", (188 * Math.min(1, cur.tokens / L.pageTokens)).toFixed(1));
    setText("mm-page-sub", T("memory.map.pageSince", { when: when(cur.started), reason: REASON[cur.reason] || cur.reason }));
  }
  // 压缩记忆 + 困意
  const active = mem.blocks.filter((b) => b.cleared === null).reverse();
  const comp = active.reduce((s, b) => s + b.tokens, 0);
  setText("mm-blocks-title", T("memory.map.blocksTitle", { n: active.length }));
  setText("mm-blocks-tok", T("memory.aboutTokens", { n: tok(comp) }));
  const stack = $("#mm-blocks-stack");
  stack.replaceChildren(...active.slice(-10).map((b, i) => {
    const r = svgEl("rect", { class: "stackb", x: 546 + i * 18, y: 208, width: 14, height: 22, rx: 2 });
    r.append(svgEl("title", {}, T("memory.map.blockTitle", { n: i + 1, when: when(b.created), tokens: tok(b.tokens) })));
    return r;
  }));
  if (!active.length) stack.append(svgEl("text", { class: "ns", x: 546, y: 226 }, T("memory.map.noBlocks")));
  $("#mm-blocks-fill").setAttribute("width", (188 * Math.min(1, comp / L.mustSleepAtTokens)).toFixed(1));
  const mx = 546 + 188 * (L.sleepyAtTokens / L.mustSleepAtTokens);
  const mark = svgEl("line", { class: "mark", x1: mx, x2: mx, y1: 236, y2: 254 });
  mark.append(svgEl("title", {}, T("memory.map.sleepyMark")));
  $("#mm-blocks-marks").replaceChildren(mark);
  setText("mm-blocks-sub", T("memory.map.blocksSub", { sleepy: tok(L.sleepyAtTokens), must: tok(L.mustSleepAtTokens) }));
  // 睡觉
  const sleeps = mem.pages.filter((p, i) => p.end === "sleep" && mem.pages[i + 1]).map((p) => mem.pages[mem.pages.indexOf(p) + 1].started);
  setText("mm-sleep-1", sleeps.length ? T("memory.map.lastWoke", { when: when(sleeps[sleeps.length - 1]) }) : T("memory.map.noSleep"));
  setText("mm-sleep-2", T("memory.map.nextSleep", { time: mem.night || "03:00" }));
  setText("mm-sleep-3", T("memory.map.sleepNote"));
  // 回想
  const day = mem.recall.filter((r) => r.ts >= clock() - 86_400_000);
  setText("mm-recall", T("memory.map.recallValue"));
  setText("mm-recall-sub", T("memory.map.recallSub", { n: day.length }));
  // 中央记忆
  const c = mem.central;
  setText("mm-central", T("memory.map.centralTotal", { rows: c.rows.toLocaleString(T("common.locale")), tokens: tok(c.tokens) }));
  setText("mm-central-sub", (c.firstTs ? T("memory.map.centralSince", { when: dhm(c.firstTs) }) : "") + T("memory.map.centralPages", { n: mem.pages.length ? mem.pages[mem.pages.length - 1].id : 0 }));
  // 长期记忆
  const files = mem.areas.reduce((s, a) => s + a.files, 0);
  setText("mm-lt", T("memory.map.files", { n: files }));
  setText("mm-lt-sub", mem.events && mem.events.ready ? T("memory.map.plusEvents", { n: mem.events.counts.events }) : mem.organizer.lastDone ? T("memory.map.organizedTo", { day: mem.organizer.lastDone.slice(5) }) : T("memory.map.neverOrganized"));
  paintMemSel();
}

function renderPages() {
  const box = $("#mpages");
  const L = mem.limits;
  const cols = el("div", "cols");
  for (const p of mem.pages) {
    const end = END[p.end] || END.current;
    const b = el("button", "pcol" + (p.end === "current" ? " current" : "") + (memPageId === p.id ? " sel" : ""));
    b.style.setProperty("--c", "var(" + end.color + ")");
    const bb = el("div", "barbox");
    const bar = el("div", "bar");
    bar.style.height = Math.max(2, Math.min(100, (p.tokens / L.pageTokens) * 100)) + "%";
    bb.append(bar);
    b.append(bb, el("div", "pn", T("memory.pageNo", { id: p.id })), el("div", "pt", when(p.firstTs || p.started) + (p.lastTs ? "–" + hm(p.lastTs).slice(0, 5) : "")), el("div", "pt", tok(p.tokens)), el("div", "pe", p.end === "current" ? T("memory.pages.current") : "→ " + end.name));
    b.title = T("memory.pages.colTitle", { id: p.id, rows: p.rows, tokens: tok(p.tokens), state: p.end === "current" ? T("memory.pages.writing") : T("memory.pages.endedBy", { end: end.name }) });
    b.addEventListener("click", () => { memPageId = p.id; memNode = "page"; paintMemSel(); renderPages(); renderMemDetail(); paintBrain(); renderCard(); updateHash(); });
    cols.append(b);
  }
  box.replaceChildren(el("h2", null, T("memory.pages.title")), el("p", "legend", T("memory.pages.legend", { limit: tok(L.pageTokens) })), cols);
  cols.scrollLeft = cols.scrollWidth;
}

function mrow(title, num, sub, meter, onOpen) {
  const r = el("div", "mrow");
  const t = onOpen ? el("button", "link", title) : el("span", null, title);
  if (onOpen) t.addEventListener("click", onOpen);
  r.append(t, el("span", "num", num || ""));
  if (meter != null) { const m = el("div", "meter"); const b = el("b"); b.style.width = Math.max(0, Math.min(100, meter * 100)) + "%"; m.append(b); r.append(m); }
  if (sub) r.append(el("div", "sub", sub));
  return r;
}
function head(title, what, color) {
  const d = $("#mdetail");
  d.style.setProperty("--c", "var(" + color + ")");
  d.replaceChildren(el("h3", null, title), el("p", "what", what));
  return d;
}

async function openBlock(id, title) {
  const r = await fetch("/api/memory/block?id=" + id).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  openDoc(title, r.error ? r.error : T("memory.doc.blockSub", { n: r.text.length }), r.text || "");
}
async function openFile(key, title) {
  const r = await fetch("/api/memory/file?key=" + encodeURIComponent(key)).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (r.error) { openDoc(title, r.error, ""); return; }
  openDoc(title, T("memory.doc.fileSub", { kb: Math.round(r.bytes / 1024), when: dhm(r.mtime) }) + (r.clipped ? T("memory.doc.clipped") : ""), r.text);
}
function openDoc(title, sub, text) {
  putDrawerName(null); clearInterval(drawerTimer);
  $("#drawer").classList.add("open");
  $("#dtitle").textContent = title;
  $("#dsub").textContent = sub;
  const pre = el("pre", "doc", text);
  $("#dsteps").replaceChildren(pre);
  $("#dsteps").scrollTop = 0;
}

function renderMemDetail() {
  if (!mem) return;
  const L = mem.limits;
  if (!memNode && memPageId === null) { $("#mdetail").replaceChildren(); return; }
  if (memPageId !== null) {
    const p = mem.pages.find((x) => x.id === memPageId);
    if (!p) { memPageId = null; return renderMemDetail(); }
    const end = END[p.end] || END.current;
    const d = head(T("memory.pageNo", { id: p.id }), p.end === "current" ? T("memory.pageDetail.current") : T("memory.pageDetail.ended", { end: end.name }), end.color);
    d.append(
      mrow(T("memory.pageDetail.time"), when(p.firstTs || p.started) + (p.lastTs ? " – " + when(p.lastTs) : "")),
      mrow(T("memory.pageDetail.startedBy"), REASON[p.reason] || p.reason),
      mrow(T("memory.pageDetail.rows"), String(p.rows)),
      mrow(T("memory.pageDetail.size"), tok(p.tokens) + " / " + tok(L.pageTokens), T("memory.pageDetail.sizeNote"), p.tokens / L.pageTokens),
    );
    if (p.block) {
      d.append(el("h4", null, T("memory.pageDetail.compacted")));
      d.append(mrow(T("memory.pageDetail.openBlock"), T("memory.tokens", { n: tok(p.block.tokens) }), T("memory.pageDetail.blockMade", { when: when(p.block.created) }) + (p.block.cleared ? T("memory.pageDetail.blockCleared", { when: when(p.block.cleared) }) : T("memory.pageDetail.blockKept")), null, () => openBlock(p.block.id, T("memory.pageDetail.blockDocTitle", { id: p.id }))));
    } else if (p.end === "sleep") {
      d.append(el("p", "hint", T("memory.pageDetail.noBlockSleep")));
    } else if (p.end === "restart") {
      d.append(el("p", "hint", T("memory.pageDetail.noBlockRestart")));
    }
    return;
  }
  switch (memNode) {
    case "prefix": {
      const total = mem.prefix.reduce((s, p) => s + p.tokens, 0);
      const d = head(T("memory.prefix.title"), T("memory.prefix.what", { tokens: tok(total) }), "--l-main");
      for (const p of mem.prefix) {
        const info = partOf(p);
        const sub = [info.what, p.mtime ? T("memory.prefix.changed", { when: dhm(p.mtime) }) : null, p.missing ? T("memory.prefix.missing") : null].filter(Boolean).join(T("common.comma"));
        const open = p.key ? () => openFile(p.key, p.name) : p.blockId ? () => openBlock(p.blockId, p.name) : null;
        const r = mrow(p.name, T("memory.tokens", { n: tok(p.tokens) }), sub, p.tokens / Math.max(1, total), open);
        r.style.setProperty("--c", "var(" + info.color + ")");
        d.append(r);
      }
      return;
    }
    case "sources": {
      const d = head(T("memory.map.sources"), T("memory.sources.what"), "--l-outer");
      const b = el("button", "link", T("memory.sources.toThink"));
      b.addEventListener("click", () => setLens("think"));
      d.append(b);
      return;
    }
    case "self": {
      const memFiles = memoryFileNames();
      const parts = mem.prefix.filter((p) => (p.kind === "note" && !isMemNote(p)) || (p.kind === "file" && !memFiles.has(p.name)));
      const total = parts.reduce((n, p) => n + p.tokens, 0);
      const d = head(T("memory.brain.selfName"), T("memory.self.what", { tokens: tok(total) }), "--l-main");
      for (const p of parts) {
        const info = partOf(p);
        d.append(mrow(p.name, T("memory.tokens", { n: tok(p.tokens) }), [info.what, p.mtime ? T("memory.prefix.changed", { when: dhm(p.mtime) }) : null].filter(Boolean).join(T("common.comma")), p.tokens / Math.max(1, total), p.key ? () => openFile(p.key, p.name) : null));
      }
      const soul = mem.areas.find((a) => a.dir === "soul");
      if (soul) {
        d.append(el("h4", null, T("memory.self.soulParts")));
        soul.list.forEach((f) => d.append(mrow(f.name.replace("soul/", ""), when(f.mtime), null, null, () => openFile(f.key, f.name))));
      }
      return;
    }
    case "skills": {
      const a = mem.skills;
      const d = head(T("memory.skills.title"), T("memory.skills.what"), "--l-system");
      if (!a) { d.append(el("p", "hint", T("memory.skills.noDir"))); return; }
      d.append(mrow(T("memory.skills.manuals"), T("memory.skills.manualCount", { n: a.files }), a.latest ? T("memory.lastChanged", { when: when(a.latest) }) : null));
      const map = a.list.find((f) => f.name === "skills/MAP.md");
      if (map) d.append(mrow(T("memory.skills.map"), when(map.mtime), null, null, () => openFile(map.key, "skills/MAP.md")));
      d.append(el("h4", null, T("memory.skills.newestFirst")));
      a.list.filter((f) => f.name !== "skills/MAP.md").slice(0, 60).forEach((f) => d.append(mrow(f.name.replace("skills/", ""), when(f.mtime), null, null, () => openFile(f.key, f.name))));
      return;
    }
    case "page": {
      const cur = mem.pages[mem.pages.length - 1];
      const d = head(T("memory.map.page"), T("memory.thisPage.what"), "--l-main");
      if (cur) d.append(
        mrow(T("memory.thisPage.which"), T("memory.pageNo", { id: cur.id })),
        mrow(T("memory.thisPage.since"), T("memory.thisPage.sinceValue", { when: when(cur.started), reason: REASON[cur.reason] || cur.reason })),
        mrow(T("memory.pageDetail.rows"), String(cur.rows)),
        mrow(T("memory.pageDetail.size"), tok(cur.tokens) + " / " + tok(L.pageTokens), T("memory.thisPage.turnsAt", { limit: tok(L.pageTokens) }), cur.tokens / L.pageTokens),
      );
      d.append(el("h4", null, T("memory.thisPage.contexts")));
      const regs = lastStatus?.regions || [];
      if (!regs.length) d.append(el("p", "hint", T("memory.thisPage.noStatus")));
      for (const g of regs) {
        const r = mrow(laneOf(g.id).name, tok(g.contextTokens) + " / " + tok(L.maxContextTokens), g.busy ? T("brain.card.busy") : g.open ? null : T("brain.card.closed"), g.contextTokens / L.maxContextTokens);
        r.style.setProperty("--c", "var(" + laneOf(g.id).color + ")");
        d.append(r);
      }
      d.append(el("p", "hint", T("memory.thisPage.contextNote", { limit: tok(L.maxContextTokens * 0.95) })));
      return;
    }
    case "blocks": {
      const active = mem.blocks.filter((b) => b.cleared === null).reverse();
      const comp = active.reduce((s, b) => s + b.tokens, 0);
      const d = head(T("memory.map.blocks"), T("memory.blocks.what"), "--l-hippo");
      d.append(mrow(T("memory.blocks.total"), T("memory.blocks.totalValue", { n: active.length, tokens: tok(comp) }), T("memory.blocks.limits", { sleepy: tok(L.sleepyAtTokens), must: tok(L.mustSleepAtTokens) }), comp / L.mustSleepAtTokens));
      d.append(el("h4", null, T("memory.blocks.inPrefix")));
      if (!active.length) d.append(el("p", "hint", T("memory.blocks.none")));
      active.forEach((b, i) => d.append(mrow(T("memory.blocks.rowTitle", { n: i + 1, page: b.epoch }), T("memory.tokens", { n: tok(b.tokens) }), T("memory.blocks.preview", { when: when(b.created), text: b.preview }), null, () => openBlock(b.id, T("memory.blocks.docTitle", { n: i + 1, page: b.epoch })))));
      const old = mem.blocks.filter((b) => b.cleared !== null);
      if (old.length) {
        d.append(el("h4", null, T("memory.blocks.clearedTitle")));
        old.forEach((b) => d.append(mrow(T("memory.blocks.ofPage", { id: b.epoch }), T("memory.tokens", { n: tok(b.tokens) }), T("memory.blocks.clearedSub", { created: when(b.created), cleared: when(b.cleared) }), null, () => openBlock(b.id, T("memory.blocks.ofPage", { id: b.epoch })))));
      }
      return;
    }
    case "sleep": {
      const d = head(T("memory.map.sleep"), T("memory.sleep.what", { time: mem.night || "03:00" }), "--l-hippo");
      const sleeps = mem.pages.map((p, i) => p.end === "sleep" && mem.pages[i + 1] ? { from: p, wake: mem.pages[i + 1].started } : null).filter(Boolean);
      d.append(el("h4", null, T("memory.sleep.recent")));
      if (!sleeps.length) d.append(el("p", "hint", T("memory.sleep.none")));
      sleeps.reverse().forEach((s) => d.append(mrow(T("memory.sleep.woke", { when: when(s.wake) }), T("memory.sleep.afterPage", { id: s.from.id }))));
      const o = mem.organizer;
      d.append(el("h4", null, T("memory.sleep.progress")));
      d.append(mrow(T("memory.sleep.organizedTo"), o.lastDone || T("common.dash"), o.lastAppliedAt ? T("memory.sleep.appliedAt", { when: o.lastAppliedAt.replace("T", " ").slice(0, 16) }) : null));
      o.runs.slice(0, 5).forEach((r) => d.append(mrow(T("memory.sleep.reportOf", { day: r.day }), "", null, null, r.report ? () => openFile(r.report, T("memory.sleep.reportTitle", { day: r.day })) : null)));
      // 早上的开头：醒来那一页主线每次开场，hhd 原样存的（日子和时刻是文件名里她当地的）
      if (mem.wakes && mem.wakes.length) {
        d.append(el("h4", null, T("memory.sleep.openings")), el("p", "hint", T("memory.sleep.openingsHint", { n: mem.wakes.length })));
        mem.wakes.forEach((f) => {
          const at = T("common.dateTime", { date: md(new Date(f.day + "T12:00:00").getTime()), time: f.time });
          d.append(mrow(at, Math.round(f.bytes / 1024 * 10) / 10 + " KB", null, null, () => openFile(f.key, T("memory.sleep.openingTitle", { when: at }))));
        });
      }
      return;
    }
    case "recall": {
      const d = head(T("memory.map.recall"), T("memory.recall.what"), "--l-speech");
      const b = el("button", "link", T("memory.recall.inPrompt"));
      b.addEventListener("click", () => { putPromptRegion("main"); setTab("prompt"); });
      d.append(b, el("h4", null, T("memory.recall.recent")));
      if (!mem.recall.length) d.append(el("p", "hint", T("memory.recall.none")));
      for (const r of mem.recall) {
        const row = mrow((r.tool && r.tool !== "recall" ? T("memory.recall.toolPrefix", { tool: TOOL_CN[r.tool] || r.tool }) : "") + r.query, when(r.ts), laneOf(r.src).name + (r.found === true ? T("memory.recall.found") : r.found === false ? T("memory.recall.notFound") : T("memory.recall.pending")));
        row.querySelector(".num").classList.add(r.found === false ? "no" : "ok");
        d.append(row);
      }
      return;
    }
    case "central": {
      const c = mem.central;
      const d = head(T("memory.map.central"), T("memory.central.what"), "--l-outer");
      d.append(
        mrow(T("memory.total"), T("common.rows", { n: c.rows.toLocaleString(T("common.locale")) })),
        mrow(T("memory.central.size"), T("memory.tokens", { n: tok(c.tokens) })),
        mrow(T("memory.central.first"), c.firstTs ? dhm(c.firstTs) : T("common.dash"), c.imported ? T("memory.central.imported", { n: c.imported }) : null),
        mrow(T("memory.central.last"), c.lastTs ? dhm(c.lastTs) : T("common.dash")),
      );
      const b = el("button", "link", T("memory.central.toTimeline"));
      b.addEventListener("click", () => setLens("think"));
      d.append(el("h4", null, T("memory.central.viewTitle")), b);
      return;
    }
    case "longterm": {
      const o = mem.organizer;
      const d = head(T("memory.longterm.title"), T("memory.longterm.what"), "--l-side");
      const memFiles = memoryFileNames();
      const snap = mem.prefix.filter((p) => (p.kind === "file" && memFiles.has(p.name)) || isMemNote(p));
      if (snap.length) {
        d.append(el("h4", null, T("memory.longterm.carried")));
        snap.forEach((p) => d.append(mrow(p.name, T("memory.tokens", { n: tok(p.tokens) }), partOf(p).what, null, p.key ? () => openFile(p.key, p.name) : isMemNote(p) ? () => { putEvView("midterm"); setTab("events"); } : null)));
      }
      const ev = mem.events;
      if (ev && ev.ready) {
        d.append(el("h4", null, T("memory.longterm.eventStore")));
        const c = ev.counts;
        d.append(mrow(T("memory.total"), T("memory.longterm.eventCounts", { events: c.events, entries: c.entries }), T("memory.longterm.eventEvidence", { entities: c.entities, quotes: c.quotes.toLocaleString(T("common.locale")) }) + (ev.lastWrite ? T("memory.longterm.lastWrite", { ago: ago(ev.lastWrite) }) : "")));
        const f = ev.flags;
        if (f) d.append(mrow(T("memory.longterm.usage"), f.enabled ? T("memory.longterm.on") : T("memory.longterm.off"), [f.enabled ? T("memory.longterm.useDayNight") : null, f.inject ? T("memory.longterm.useInject") : null, f.midterm ? T("memory.longterm.midtermIn") : T("memory.longterm.midtermOut")].filter(Boolean).join(T("memory.longterm.useSep"))));
        const b = el("button", "link", T("memory.longterm.openEvents"));
        b.addEventListener("click", () => setTab("events"));
        d.append(b);
      }
      d.append(mrow(T("memory.sleep.organizedTo"), o.lastDone || T("common.dash"), o.lastAppliedAt ? T("memory.sleep.appliedAt", { when: o.lastAppliedAt.replace("T", " ").slice(0, 16) }) : null));
      d.append(el("h4", null, T("memory.longterm.recent")));
      if (!mem.recent.length) d.append(el("p", "hint", T("memory.longterm.noRecent")));
      mem.recent.slice(0, 15).forEach((f) => d.append(mrow(f.name, when(f.mtime), null, null, () => openFile(f.key, f.name))));
      d.append(el("h4", null, T("memory.longterm.areas")));
      const max = Math.max(1, ...mem.areas.map((a) => a.files));
      for (const a of mem.areas) {
        const det = el("details");
        const sm = el("summary");
        sm.append(mrow(a.label + (a.label !== a.dir ? T("memory.longterm.areaDir", { dir: a.dir }) : ""), T("memory.longterm.areaFiles", { n: a.files }), a.latest ? T("memory.lastChanged", { when: when(a.latest) }) : null, a.files / max));
        det.append(sm);
        a.list.slice(0, 40).forEach((f) => det.append(mrow(f.name.replace(a.dir + "/", ""), when(f.mtime), null, null, () => openFile(f.key, f.name))));
        d.append(det);
      }
      if (o.runs.length) {
        d.append(el("h4", null, T("memory.longterm.reports")));
        o.runs.forEach((r) => d.append(mrow(r.day, "", null, null, r.report ? () => openFile(r.report, T("memory.sleep.reportTitle", { day: r.day })) : null)));
      }
      return;
    }
  }
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putMemNode(v) { return memNode = v; }
export {
  MEM, dhm, md, memNode, memPageId, memSelect, mnodes, mrow, openDoc, openFile, paintMemBrain, refreshMemory, renderMemCard, renderMemDetail, sameDay,
  setLens, setTab, showPanes, svgEl, tab, tok, updateHash, when, putMemNode,
};
