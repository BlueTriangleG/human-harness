"use strict";
import { HH, T, clock } from "./i18n.js";
import { $, GATE, el, gateOpen, laneOf, lens, persist, putGateOpen, putSelected, selected } from "./core.js";
import { ago, renderAll, rows, rowsOf, splitAct } from "./timeline.js";
import { sideShapes } from "./sides.js";
import { renderScope } from "./toolbar.js";
import { refreshStrip } from "./topbar.js";
import { gateAct, openGate, renderGateCard } from "./gate.js";
import { memNode, memPageId, memSelect, paintMemBrain, renderMemCard, showPanes, updateHash } from "./memory.js";
// ---------- 大脑 ----------
const brain = $("#brain");
// 「同时在做」那几块照服务端给的脑区画（HH.regions 是从配置里来的）；没给（没配这一项的服务端）就照默认的两个
const SIDE_IDS = (Array.isArray(HH.regions) ? HH.regions : ["side-1", "side-2"]).filter((id) => /^side-\d+$/.test(id));
(() => {
  const svg = (tag) => document.createElementNS("http://www.w3.org/2000/svg", tag);
  sideShapes(SIDE_IDS.length).forEach((shape, i) => {
    const id = SIDE_IDS[i], n = id.slice(5);
    const g = svg("g");
    g.setAttribute("class", "region"); g.setAttribute("tabindex", "0"); g.setAttribute("role", "button");
    g.dataset.src = id; g.dataset.mem = "recall";
    g.style.setProperty("--lane", "var(--l-side)");
    const title = svg("title"); title.textContent = T("brain.map.sideTitle", { n });
    const path = svg("path"); path.setAttribute("class", "shape"); path.setAttribute("d", shape.d);
    const num = svg("text"); num.setAttribute("class", "lbl num"); num.setAttribute("x", shape.x); num.setAttribute("y", shape.y); num.dataset.mlabel = ""; num.textContent = n;
    g.append(title, path, num);
    $("#sides").append(g);
  });
  // 没配「慢慢想」：图上不留它那一块
  if (Array.isArray(HH.regions) && !HH.regions.includes("deep")) brain.querySelector('.region[data-src="deep"]')?.remove();
})();
const regionEls = new Map([...brain.querySelectorAll(".region[data-src]")].map((g) => [g.dataset.src, g]));
const allRegions = [...brain.querySelectorAll(".region")];
let lastStatus = null;

function select(src) {
  putSelected(src && src !== selected ? src : null);
  if (gateOpen) { putGateOpen(false); showPanes(); updateHash(); }
  persist();
  paintBrain();
  renderScope();
  renderCard();
  renderAll();
  refreshStrip();
}
for (const g of allRegions) {
  const src = g.dataset.src;
  if (src) g.setAttribute("aria-label", T("brain.regionLabel", { name: laneOf(src).name, where: laneOf(src).where }));
  else if (g.dataset.gate) g.setAttribute("aria-label", T("brain.gateLabel", { name: GATE.name, where: GATE.where }));
  const act = () => { if (lens === "memory") { if (g.dataset.mem) memSelect(g.dataset.mem); } else if (src) select(src); else if (g.dataset.gate) openGate(!gateOpen); };
  g.addEventListener("click", (e) => { e.stopPropagation(); act(); });
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
}
brain.addEventListener("click", () => { if (lens === "memory") { if (memNode || memPageId !== null) memSelect(null); } else if (gateOpen) openGate(false); else if (selected) select(null); });

function flash(src) {
  const g = regionEls.get(src);
  if (!g || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  g.classList.add("flash");
  requestAnimationFrame(() => requestAnimationFrame(() => g.classList.remove("flash")));
}

/** 每块的亮度 = 最近 5 分钟有几条；正在想的那块会呼吸 */
function paintBrain() {
  if (lens === "memory") { paintMemBrain(); return; }
  const since = clock() - 5 * 60_000;
  const recent = new Map();
  for (let i = rows.length - 1; i >= 0 && rows[i].ts >= since; i--) recent.set(rows[i].src, (recent.get(rows[i].src) || 0) + 1);
  const st = new Map((lastStatus?.regions || []).map((g) => [g.id, g]));
  for (const [src, g] of regionEls) {
    g.style.setProperty("--act", Math.min(1, Math.sqrt((recent.get(src) || 0) / 30)).toFixed(3));
    const s = st.get(src);
    g.classList.toggle("busy", !!s?.busy);
    g.classList.toggle("closed", !!s && !s.open && !s.busy && !recent.get(src));
    g.classList.toggle("sel", src === selected);
  }
  const gn = brain.querySelector(".region[data-gate]");
  if (gn) {
    gn.classList.toggle("sel", gateOpen);
    gn.style.setProperty("--act", gateAct().toFixed(3));
  }
  brain.classList.toggle("picking", !!selected || gateOpen);
  // 图上没有位置的脑区（以后加的），放在图下面
  const extra = new Set([...rows.map((r) => r.src), ...(lastStatus?.regions || []).map((g) => g.id)]);
  const others = [...extra].filter((s) => !regionEls.has(s)).sort();
  $("#others").replaceChildren(...others.map((s) => {
    const b = el("button", "rchip" + (s === selected ? " sel" : ""), laneOf(s).name);
    b.style.setProperty("--lane", "var(" + laneOf(s).color + ")");
    b.addEventListener("click", () => select(s));
    return b;
  }));
}

function renderCard() {
  if (lens === "memory") { renderMemCard(); return; }
  if (gateOpen) { renderGateCard(); return; }
  const card = $("#card");
  const st = new Map((lastStatus?.regions || []).map((g) => [g.id, g]));
  if (!selected) {
    const busy = (lastStatus?.regions || []).filter((g) => g.busy).map((g) => laneOf(g.id).name);
    card.style.removeProperty("--lane");
    card.replaceChildren(
      el("p", "hint", busy.length ? T("brain.card.thinking", { names: busy.join(T("common.listSep")) }) : lastStatus ? T("brain.card.nobodyThinking") : ""),
    );
    thinkHint(card);
    return;
  }
  const lane = laneOf(selected);
  card.style.setProperty("--lane", "var(" + lane.color + ")");
  const h = el("h3", null, lane.name);
  if (lane.where) h.append(el("small", null, lane.where));
  const s = st.get(selected);
  const mine = rowsOf(selected);   // 连这一段以前它自己的（时间线为它另外要来的）
  const hour = mine.filter((r) => r.ts >= clock() - 3600_000).length;
  const facts = el("div", "facts");
  const fact = (k, v) => { const x = el("span", null, k + " "); x.append(el("b", null, v)); facts.append(x); };
  if (s) {
    fact(T("brain.card.state"), s.busy ? T("brain.card.busy") : s.open ? T("brain.card.open") : T("brain.card.closed"));
    fact(T("brain.card.context"), Math.round(s.contextTokens / 1000) + "k");
    fact(T("brain.card.shift"), T("brain.card.shiftValue", { n: s.generation }));
  }
  if (mine.length) fact(T("brain.card.lastRow"), ago(mine[mine.length - 1].ts));
  fact(T("brain.card.lastHour"), T("common.rows", { n: hour }));
  const nodes = [h, el("p", "what", lane.what), facts];
  if (s?.busy) nodes.push(el("div", "busyline now", T("brain.card.busyLine")));
  // 它最近在做什么：最后一次动手、最后一句话、最后一个念头
  const last = (pred) => { for (let i = mine.length - 1; i >= 0; i--) if (pred(mine[i])) return mine[i]; return null; };
  const show = (label, r, mono) => {
    if (!r) return;
    const d = el("div", "now");
    d.append(el("span", "k", T("brain.card.lastLabel", { label, ago: ago(r.ts) })));
    let text = r.text;
    if (r.kind === "act") { const [n, a] = splitAct(text); text = n + " " + a; }
    d.append(el("span", "v" + (mono ? " mono" : ""), text.length > 160 ? text.slice(0, 160) + "…" : text));
    nodes.push(d);
  };
  show(T("brain.card.lastAct"), last((r) => r.kind === "act"), true);
  show(T("brain.card.lastThink"), last((r) => r.kind === "think"), false);
  const words = last((r) => r.kind === "say" || (r.kind === "note" && !(r.meta && (r.meta.sent || r.meta.unsent))));   // unsent：「上面这段没发给任何人」的标记行，不是她记的
  show(words && words.kind === "note" ? T("brain.card.lastNote") : T("brain.card.lastSay"), words, false);
  const claims = (lastStatus?.claims || []).filter((c) => c.owner === selected).map((c) => c.topic);
  if (claims.length) { const d = el("div", "now"); d.append(el("span", "k", T("brain.card.claims")), el("span", "v", claims.join(T("common.listSep")))); nodes.push(d); }
  card.replaceChildren(...nodes);
}
function thinkHint(card) {
  const head = HH.marks.thinkItOver;   // how a "think it over" record opens, as the role's side writes it
  const realThinks = rows.filter((r) => r.kind === "think" && !(head && r.text.startsWith(head))).length;
  if (!realThinks && rows.length) card.append(el("p", "hint", T("brain.card.noThinking")));
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putLastStatus(v) { return lastStatus = v; }
export { allRegions, brain, flash, lastStatus, paintBrain, renderCard, select, putLastStatus };
