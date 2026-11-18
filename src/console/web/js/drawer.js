"use strict";
import { T } from "./i18n.js";
import { $, el, gateOpen, lens, selected } from "./core.js";
import { hm, renderBody } from "./timeline.js";
import { select } from "./brain.js";
import { openGate } from "./gate.js";
import { tab, updateHash } from "./memory.js";
// ---------- 抽屉：某个 Claude Code 会话的过程 ----------
let drawerName = null, drawerTimer = null;
async function openWorker(name) {
  drawerName = name;
  history.replaceState(null, "", "#w=" + name);
  $("#drawer").classList.add("open");
  $("#dtitle").textContent = name;
  $("#dsub").textContent = T("common.loading");
  await refreshDrawer(true);
  clearInterval(drawerTimer);
  drawerTimer = setInterval(() => refreshDrawer(false), 5000);
}
async function refreshDrawer(scroll) {
  if (!drawerName) return;
  const box = $("#dsteps");
  const stick = scroll || box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  const r = await fetch("/api/worker?name=" + encodeURIComponent(drawerName)).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (r.error) { $("#dsub").textContent = r.error; return; }
  const w = r.worker;
  const th = r.thinking;
  $("#dsub").textContent = [w.model, w.state === "idle" ? T("common.idle") : w.state, w.turn != null ? T("common.turns", { n: w.turn }) : null, w.dir].filter(Boolean).join(T("common.comma")) +
    (th.hidden ? T("side.drawer.hiddenThinking", { n: th.hidden }) + (th.shown ? T("side.drawer.shownThinking", { n: th.shown }) : "") : "");
  let prev = null;
  const nodes = r.steps.map((s) => {
    const e = el("div", "e k-" + s.kind + (s.error ? " err" : "") + (prev ? "" : " first"));
    e.append(el("div", "t", s.ts ? hm(Date.parse(s.ts)) : ""), ...renderBody(s.kind, s.text, null, s.tool));
    prev = s;
    return e;
  });
  if (!nodes.length) nodes.push(el("div", "empty", r.note || T("side.drawer.empty")));
  box.replaceChildren(...nodes);
  if (stick) box.scrollTop = box.scrollHeight;
}
function closeDrawer() {
  drawerName = null; clearInterval(drawerTimer); $("#drawer").classList.remove("open");
  if (location.hash.startsWith("#w=")) { history.replaceState(null, "", location.pathname); updateHash(); }
}
$("#dclose").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if ($("#drawer").classList.contains("open")) closeDrawer(); else if (gateOpen && tab === "brain" && lens !== "memory") openGate(false); else if (selected) select(null); } });

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putDrawerName(v) { return drawerName = v; }
export { drawerName, drawerTimer, openWorker, putDrawerName };
