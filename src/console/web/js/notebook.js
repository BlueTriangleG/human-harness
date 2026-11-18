"use strict";
import { T } from "./i18n.js";
import { $, el } from "./core.js";
import { svgEl, tab, updateHash } from "./memory.js";
import { NB_GUTTER, NB_HEAD, nbRadius, shelfArc, shelfFit, shelfMap, shelfNameRect, shelfNameSide, shelfTextWidth } from "./shelfmap.js";
// ---------- 笔记：书架上每一页在哪一层、多重要、多久没翻，页和页之间的线（只读） ----------
/*
 * 三层从上到下（浅、中、深），每一本一竖条，一页一个点。要让人一眼看出三样：重要但很久没翻的（红圈）、
 * 沉到深层的有没有沉错（最下面那一层）、没有线的孤页。整张图上看的是点：线只有「同一件事里用到」的画得清楚，
 * 「页里互相指」的很淡，「一起被翻」的不画（真实规模三百多条线，都画出来是一团网）；点一页，它的三种线才都亮出来。
 */
const NB_VIEWS = ["all", "stale", "orphans", "deep"];
const NB_KINDS = ["ref", "event", "co"];
let nbSeq = 0;
let nbData = null;     // 服务端给的那一份
let nbView = "all";    // 看哪些页：全部 / 重要但很久没翻 / 没有线 / 深层
let nbSel = null;      // 点开的那一页的编号
let nbBookMid = [];    // 图上每一本竖条的中线在哪（算「右边还有几本」用）
const NB_NAME_W = 150; // 写在点旁边的页名最多这么宽

const nbIn = (p, view) => view === "stale" ? p.stale : view === "orphans" ? p.links === 0 : view === "deep" ? p.layer === "deep" : true;
/** 颜色有多实：刚翻过的最实，越久越淡，到了「很久」那条线就不再淡下去 */
const nbFresh = (p, deepDays) => Math.max(0.25, 1 - 0.75 * Math.min(1, p.days / Math.max(1, deepDays)));
const nbBookName = (p) => (p.book ? T("notebook.inBook", { category: p.category, book: p.book }) : T("notebook.unfiled"));
/** 多久没翻，说成一句 */
function nbLastOpened(p) {
  if (p.never) return p.days > 0 ? T("notebook.card.neverPast", { n: p.days }) : T("notebook.card.neverGrace");
  return p.days === 0 ? T("notebook.card.openedToday") : T("notebook.card.openedAgo", { n: p.days });
}

async function loadNotebook() {
  const seq = ++nbSeq;
  const r = await fetch("/api/notebook").then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (seq !== nbSeq || tab !== "notebook") return;
  if (r.error) {
    nbData = null;
    $("#nbsum").textContent = T("notebook.failed", { error: r.error });
    $("#nbmap").replaceChildren(); $("#nblegend").replaceChildren(); $("#nbside").replaceChildren();
    nbBookMid = []; nbEdges();
    return;
  }
  nbData = r;
  if (nbSel && !r.pages.some((p) => p.id === nbSel)) nbSel = null;
  renderNotebook();
}

function renderNotebook() {
  if (!nbData) return;
  const pages = nbData.pages;
  for (const b of document.querySelectorAll("#nviews button")) {
    const name = T("notebook.views." + b.dataset.nview);
    b.textContent = T("notebook.viewCount", { name, n: pages.filter((p) => nbIn(p, b.dataset.nview)).length });
    b.setAttribute("aria-pressed", String(b.dataset.nview === nbView));
  }
  const books = new Set(pages.filter((p) => p.book).map((p) => p.category + "\n" + p.book)).size;
  $("#nbsum").textContent = pages.length ? T("notebook.summary", { pages: pages.length, books, links: nbData.links.length }) : T("notebook.empty");
  nbDrawMap();
  nbDrawLegend();
  nbDrawSide();
}

/** 和这一页有线的页：页编号 → 它们之间的那几条线（一对页可以有几种线） */
function nbNeighbours(id) {
  const near = new Map();
  for (const l of nbData.links) {
    if (l.a !== id && l.b !== id) continue;
    const other = l.a === id ? l.b : l.a;
    if (!near.has(other)) near.set(other, []);
    near.get(other).push(l);
  }
  return near;
}

function nbDrawMap() {
  const svg = $("#nbmap");
  const pages = nbData.pages;
  const m = shelfMap(pages, Math.max(320, $("#nbscroll").clientWidth - 2));
  svg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  svg.setAttribute("width", m.width); svg.setAttribute("height", m.height);
  const near = nbSel ? nbNeighbours(nbSel) : null;
  // 只看某一类页、又没点开哪一页的时候，线都收起来：这时看的是点
  svg.classList.toggle("quiet", nbView !== "all" && !nbSel);
  const parts = [];

  for (const b of m.bands) {
    const g = svgEl("g", { class: "nbband " + b.layer });
    g.append(svgEl("rect", { x: NB_GUTTER - 6, y: b.y, width: m.right - NB_GUTTER + 12, height: b.h, rx: 8 }));
    g.append(svgEl("text", { class: "nbl", x: 2, y: b.y + 18 }, T("notebook.layer." + b.layer)));
    g.append(svgEl("text", { class: "nbn", x: 2, y: b.y + 33 }, T("notebook.pageCount", { n: b.count })));
    if (b.layer === "deep" && b.count === 0) g.append(svgEl("text", { class: "nbempty", x: NB_GUTTER + 6, y: b.y + b.h / 2 + 4 }, T("notebook.deepEmpty")));
    parts.push(g);
  }
  for (const c of m.categories) {
    const g = svgEl("g", { class: "nbcat" });
    g.append(svgEl("text", { x: c.x, y: 12 }, shelfFit(c.name, c.w, 12)), svgEl("line", { x1: c.x, y1: 17, x2: c.x + c.w, y2: 17 }));
    parts.push(g);
  }
  const mid = (b) => b.x + b.w / 2;
  m.books.forEach((b, i) => {
    const name = b.key === "" ? T("notebook.unfiled") : b.book;
    // 本名错开成两行：一个名字最多伸到左右两条竖条的中线（再宽就会压到隔壁那条的引线）
    const y = i % 2 ? NB_HEAD - 10 : NB_HEAD - 26;   // 两行隔 16：隔 14 时上下两行字的框会挨上（线上真数据量到的）
    const prev = m.books[i - 1], next = m.books[i + 1];
    const half = Math.min(prev ? mid(b) - mid(prev) : 90, next ? mid(next) - mid(b) : 90, 90) - 4;
    const g = svgEl("g", { class: "nbbook" });
    const t = svgEl("text", { x: mid(b), y, "text-anchor": "middle" }, shelfFit(name, Math.max(b.w, 2 * half), 11.5));
    t.append(svgEl("title", null, T("notebook.bookTitle", { name, n: b.count })));
    g.append(t, svgEl("line", { x1: mid(b), y1: y + 4, x2: mid(b), y2: NB_HEAD - 3 }));
    parts.push(g);
  });

  const lines = svgEl("g", { class: "nblines" });
  for (const l of nbData.links) {
    const a = m.at[l.a], b = m.at[l.b];
    if (!a || !b) continue;
    const touches = nbSel && (l.a === nbSel || l.b === nbSel);
    const p = svgEl("path", { class: "nbline " + l.kind + (nbSel ? (touches ? " on" : " off") : ""), d: shelfArc(a, b) });
    p.style.strokeWidth = String(l.kind === "ref" ? 1 : 0.6 + Math.min(l.weight, 3) * 0.6);   // 页里互相指的线没有轻重；另两种超过 3 按 3 画（联想里也是这么封顶的）
    lines.append(p);
  }
  parts.push(lines);

  const dots = svgEl("g", { class: "nbdots" });
  const spots = pages.filter((p) => m.at[p.id]).map((p) => ({ id: p.id, dot: [m.at[p.id][0], m.at[p.id][1], nbRadius(p.importance) * m.scale] }));
  const names = svgEl("g", { class: "nbnames" });
  const written = [];   // 一直写着的那些名字各占了哪一块：后写的让开先写的
  const tip = svgEl("text", { class: "nbname tip", visibility: "hidden" });
  for (const p of pages) {
    const at = m.at[p.id];
    if (!at) continue;
    const r = nbRadius(p.importance) * m.scale;
    const cls = ["nbnode"];
    if (p.important) cls.push("important");
    if (p.never) cls.push("never");
    if (p.id === nbSel) cls.push("sel");
    else if (nbSel ? !near.has(p.id) : !nbIn(p, nbView)) cls.push("dim");
    const layer = T("notebook.layer." + p.layer);
    const g = svgEl("g", { class: cls.join(" "), tabindex: 0, role: "button", "aria-label": T("notebook.pageLabel", { title: p.title, layer }), transform: `translate(${at[0]},${at[1]})` });
    if (p.id === nbSel) g.append(svgEl("circle", { class: "selring", r: r + 5.5 }));
    if (p.stale) g.append(svgEl("circle", { class: "halo", r: r + 3.2 }));
    const dot = svgEl("circle", { class: "dot", r });
    if (!p.never) dot.style.fillOpacity = String(nbFresh(p, nbData.deepDays));
    g.append(dot);
    g.addEventListener("click", (e) => { e.stopPropagation(); nbSelect(p.id === nbSel ? null : p.id); });
    g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); nbSelect(p.id === nbSel ? null : p.id); } });
    dots.append(g);
    // 页名。套红圈的（最该一眼看见的）和点开的那一页，名字一直写在点旁边；别的页鼠标停上去、键盘走到时才出
    const named = p.stale || p.id === nbSel;
    // 写在右边、左边、上方还是下方：不压着旁边的点和已经写了的名字，不伸到图外面，也不出它那一层
    const place = (t, keep) => {
      const gap = r + (p.id === nbSel ? 10 : 7);   // 点开的那一页外面还有一圈虚线
      const band = m.bands.find((b) => b.layer === p.layer);
      const width = shelfTextWidth(t.textContent, 12);
      const side = shelfNameSide(at, gap, width, spots.filter((s) => s.id !== p.id).map((s) => s.dot), { from: NB_GUTTER - 6, to: m.width, top: band.y, bottom: band.y + band.h }, written);
      if (keep) written.push(shelfNameRect(at, gap, width, side));
      t.setAttribute("x", at[0] + (side === "left" ? -gap : side === "right" ? gap : 0));
      t.setAttribute("y", side === "above" ? at[1] - gap - 1 : side === "below" ? at[1] + gap + 9 : at[1] + 4);
      t.setAttribute("text-anchor", side === "left" ? "end" : side === "right" ? "start" : "middle");
    };
    if (named) {
      const t = svgEl("text", { class: "nbname" + (p.id === nbSel ? " sel" : "") + (cls.includes("dim") ? " dim" : "") }, shelfFit(p.title, NB_NAME_W, 12));
      place(t, true);
      names.append(t);
    } else {
      const show = () => { tip.textContent = shelfFit(p.title, NB_NAME_W + 60, 12); place(tip, false); tip.setAttribute("visibility", "visible"); };
      const hide = () => tip.setAttribute("visibility", "hidden");
      g.addEventListener("mouseenter", show); g.addEventListener("mouseleave", hide);
      g.addEventListener("focus", show); g.addEventListener("blur", hide);
    }
  }
  names.append(tip);
  parts.push(dots, names);
  svg.replaceChildren(...parts);
  nbBookMid = m.books.map((b) => b.x + b.w / 2);
  nbEdges();
}

/** 图比放它的地方宽（手机上）：右边、左边还有没有，边上压一道淡出；下面写一句右边还有几本 */
function nbEdges() {
  const box = $("#nbscroll"), wrap = $("#nbwrap"), more = $("#nbmore");
  const right = box.scrollLeft + box.clientWidth;
  const moreRight = right < box.scrollWidth - 2;
  wrap.classList.toggle("more-right", moreRight);
  wrap.classList.toggle("more-left", box.scrollLeft > 2);
  const n = moreRight ? nbBookMid.filter((x) => x > right).length : 0;
  more.hidden = !moreRight;
  more.textContent = moreRight ? (n ? T("notebook.moreRight", { n }) : T("notebook.moreRightEdge")) : "";
}

/** 图例：每一样画一个小样 */
function nbDrawLegend() {
  const sample = (draw, text) => {
    const s = svgEl("svg", { width: 48, height: 22, viewBox: "0 0 48 22", "aria-hidden": "true" });
    draw(s);
    const item = el("span", "nbkey");
    item.append(s, el("span", null, text));
    return item;
  };
  const node = (cls, r, x, extra) => { const g = svgEl("g", { class: "nbnode " + cls, transform: `translate(${x},11)` }); if (extra) g.append(extra); g.append(svgEl("circle", { class: "dot", r })); return g; };
  const line = (kind) => (s) => { const p = svgEl("path", { class: "nbline on " + kind, d: "M4,16 Q24,0 44,16" }); p.style.strokeWidth = "1.6"; s.append(p); };
  $("#nblegend").replaceChildren(
    sample((s) => s.append(node("", nbRadius(3), 6), node("", nbRadius(4), 20), node("", nbRadius(5), 37)), T("notebook.legend.size")),
    sample((s) => s.append(node("important", nbRadius(4), 24)), T("notebook.legend.important")),
    sample((s) => { const faint = node("", nbRadius(4), 34); faint.querySelector(".dot").style.fillOpacity = "0.25"; s.append(node("", nbRadius(4), 14), faint); }, T("notebook.legend.fresh")),
    sample((s) => s.append(node("never", nbRadius(4), 24)), T("notebook.legend.never")),
    sample((s) => s.append(node("important", nbRadius(4), 24, svgEl("circle", { class: "halo", r: nbRadius(4) + 3 }))), T("notebook.legend.stale", { n: nbData.deepDays })),
    sample(line("ref"), T("notebook.legend.ref")),
    sample(line("event"), T("notebook.legend.event")),
    sample(line("co"), T("notebook.legend.co")),
  );
}

/** 一页在列表里的一行：点了就选中它 */
function nbItem(p, note) {
  const b = el("button", "nbitem");
  b.append(el("span", "t", p.title), el("small", null, note || nbBookName(p)));
  b.addEventListener("click", () => nbSelect(p.id));
  return b;
}
/** 一类页的名单；一页都没有就是一句话 */
function nbList(view, none) {
  const list = nbData.pages.filter((p) => nbIn(p, view)).sort((a, b) => b.days - a.days || b.score - a.score);
  const box = el("section", "nbgroup");
  box.append(el("h4", null, T("notebook.overview." + view, { n: nbData.deepDays })));
  if (!list.length) box.append(el("p", "hint", none));
  for (const p of list) box.append(nbItem(p, T("notebook.itemNote", { book: nbBookName(p), last: nbLastOpened(p) })));
  return box;
}

function nbDrawSide() {
  const side = $("#nbside");
  const sel = nbSel ? nbData.pages.find((p) => p.id === nbSel) : null;
  if (!sel) {
    // 没点开哪一页：列出最该看的三样（只看某一类时只列那一类）
    const lists = { stale: () => nbList("stale", T("notebook.none.stale", { n: nbData.deepDays })), deep: () => nbList("deep", T("notebook.deepEmpty")), orphans: () => nbList("orphans", T("notebook.none.orphans")) };
    side.replaceChildren(el("h3", null, T("notebook.overview.title")), ...(nbView === "all" ? [lists.stale(), lists.deep(), lists.orphans()] : [lists[nbView]()]));
    return;
  }
  const back = el("button", "nbback", T("notebook.card.back"));
  back.addEventListener("click", () => nbSelect(null));
  const facts = el("dl", "nbfacts");
  const fact = (k, v, note) => { const d = el("dd", null, v); if (note) d.append(el("small", null, note)); facts.append(el("dt", null, k), d); };
  fact(T("notebook.card.book"), nbBookName(sel));
  fact(T("notebook.card.layer"), T("notebook.layer." + sel.layer), T("notebook.card.why." + (sel.important ? "important" : sel.layer), { n: nbData.deepDays }));
  fact(T("notebook.card.importance"), T("notebook.card.importanceOf", { n: sel.importance }));
  fact(T("notebook.card.opened"), T("notebook.card.openedDays", { k: sel.opens, n: nbData.deepDays }));
  fact(T("notebook.card.last"), nbLastOpened(sel), sel.stale ? T("notebook.card.staleNote") : null);
  const file = el("p", "nbfile", sel.rel);
  const parts = [back, el("h3", null, sel.title), facts, file];
  const near = nbNeighbours(sel.id);
  const byId = new Map(nbData.pages.map((p) => [p.id, p]));
  for (const kind of NB_KINDS) {
    const rows = [...near].map(([id, ls]) => ({ page: byId.get(id), link: ls.find((l) => l.kind === kind) })).filter((x) => x.page && x.link)
      .sort((a, b) => b.link.weight - a.link.weight || (a.page.title < b.page.title ? -1 : 1));
    if (!rows.length) continue;
    const box = el("section", "nbgroup");
    box.append(el("h4", null, T("notebook.card.linked." + kind, { n: rows.length })));
    // 学习 11-14：一件事开了一整天，当天翻过的页会两两都连上，「一起翻」的条数偏多；它改了算法以后去掉这一句
    if (kind === "co") box.append(el("p", "hint", T("notebook.card.coNote")));
    box.append(...rows.map((x) => nbItem(x.page)));
    parts.push(box);
  }
  if (!near.size) parts.push(el("p", "hint", T("notebook.card.noLinks")));
  side.replaceChildren(...parts);
}

function nbSelect(id) {
  nbSel = id;
  renderNotebook();
  updateHash();
  // 图是整张重画的：用键盘选的，焦点放回选中的那个点上
  const dot = document.querySelector("#nbmap .nbnode.sel");
  if (dot) dot.focus({ preventScroll: true });
}
function setNbView(v) {
  nbView = NB_VIEWS.includes(v) ? v : "all";
  nbSel = null;
  renderNotebook();
  updateHash();
}
for (const b of document.querySelectorAll("#nviews button")) b.addEventListener("click", () => setNbView(b.dataset.nview));
$("#nbmap").addEventListener("click", () => { if (nbSel) nbSelect(null); });
$("#nbscroll").addEventListener("scroll", nbEdges, { passive: true });
// 窗口宽了窄了，竖条的列数要重排
let nbResize = null;
window.addEventListener("resize", () => { clearTimeout(nbResize); nbResize = setTimeout(() => { if (tab === "notebook") renderNotebook(); }, 150); });

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putNbSel(v) { return nbSel = v; }
function putNbView(v) { return nbView = v; }
export { NB_VIEWS, loadNotebook, nbSel, nbView, putNbSel, putNbView };
