"use strict";
import { T } from "./i18n.js";
import { $, KINDS, el, hidden, laneOf, persist, putQuery, selected } from "./core.js";
import { renderAll, rows } from "./timeline.js";
import { select } from "./brain.js";
// ---------- 工具栏 ----------
function renderScope() {
  const sc = $("#scope");
  if (!selected) { sc.style.removeProperty("--lane"); sc.replaceChildren(T("brain.whole")); return; }
  const lane = laneOf(selected);
  sc.style.setProperty("--lane", "var(" + lane.color + ")");
  const back = el("button", null, T("brain.backToWhole"));
  back.addEventListener("click", () => select(null));
  sc.replaceChildren(T("brain.only", { name: lane.name }), back);
}
function renderKinds() {
  $("#kinds").replaceChildren(...KINDS.map(([k, v]) => {
    const b = el("button", "kchip", v);
    b.setAttribute("aria-pressed", String(!hidden.kind.has(k)));
    b.title = hidden.kind.has(k) ? T("brain.kinds.show", { kind: v }) : T("brain.kinds.hide", { kind: v });
    b.addEventListener("click", () => { hidden.kind.has(k) ? hidden.kind.delete(k) : hidden.kind.add(k); persist(); renderKinds(); renderAll(); });
    return b;
  }));
  const inner = rows.some((r) => r.meta && r.meta.inner === true);
  const box = $("#innerbox");
  if (!inner) { box.replaceChildren(); return; }
  const b = el("button", "kchip", T("brain.kinds.inner"));
  b.title = T("brain.kinds.innerTitle");
  b.setAttribute("aria-pressed", String(!hidden.inner));
  b.addEventListener("click", () => { hidden.inner = !hidden.inner; persist(); renderKinds(); renderAll(); });
  box.replaceChildren(b);
}
let searchTimer = null;
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { putQuery(e.target.value.trim().toLowerCase()); renderAll(); }, 200);
});

// ---------- 给别的文件用的 ----------
export { renderKinds, renderScope };
