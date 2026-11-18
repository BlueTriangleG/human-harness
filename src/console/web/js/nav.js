"use strict";
import { T } from "./i18n.js";
import { $, el, gateOpen, lens, putGateOpen } from "./core.js";
import { openGate } from "./gate.js";
import { setLens, setTab, tab, updateHash } from "./memory.js";
import { machineView, showMachine } from "./machine.js";
// ---------- 左边的五页 ----------
// 每一页是下面那几块（tab）里的一块，或者一块里的一个视图：活动 = 大脑那一块的时间线或闸门；记忆 = 事件记忆、大脑那一块的
// 记忆那一面（每轮带着的）、完整输入；运行 = 顺不顺。页名和视图名在语言包的 shell.nav、shell.views
const VIEWS = { activity: ["timeline", "gate"], memory: ["events", "prefix", "input"], machine: ["roles", "monitor"] };

/** which page and view are open, read off the panes' own state */
function where() {
  if (tab === "now") return ["now", null];
  if (tab === "brain") return lens === "memory" ? ["memory", "prefix"] : ["activity", gateOpen ? "gate" : "timeline"];
  if (tab === "events") return ["memory", "events"];
  if (tab === "prompt") return ["memory", "input"];
  if (tab === "settings") return ["settings", null];
  if (tab === "machine") return ["machine", machineView];
  return [tab === "notebook" ? "notes" : "run", null];
}

/** open a page, at its first view or the one given */
function go(page, view) {
  if (!VIEWS[page]) { setTab(page === "now" ? "now" : page === "notes" ? "notebook" : page === "settings" ? "settings" : "health"); return; }
  const v = view || VIEWS[page][0];
  if (page === "machine") { if (tab !== "machine") setTab("machine"); showMachine(v); updateHash(); return; }
  if (v === "events") { setTab("events"); return; }
  if (v === "input") { setTab("prompt"); return; }
  if (tab !== "brain") setTab("brain");
  if (v === "prefix") { setLens("memory"); return; }
  if (lens === "memory") { putGateOpen(false); setLens("think"); }
  if ((v === "gate") !== gateOpen) openGate(v === "gate");
}

// the views of a page, under its title: one row of buttons per page, the open page's shows
for (const [page, views] of Object.entries(VIEWS)) for (const v of views) {
  const b = el("button", null, T("shell.views." + v));
  b.dataset.page = page; b.dataset.view = v;
  b.addEventListener("click", () => go(page, v));
  $("#pviews").append(b);
}
for (const b of document.querySelectorAll("#nav button")) b.addEventListener("click", () => go(b.dataset.page));
// the skip link: to the open page, without leaving #content in the address
document.querySelector('.skip[href="#content"]').addEventListener("click", (e) => { e.preventDefault(); $("#content").focus(); });

/** the page's head and the left column follow what is open (every change of page, view or lens comes through here).
 *  No line under the title saying what the page is for: the owner asked for fewer words */
function renderIntro() {
  const [page, view] = where();
  for (const b of document.querySelectorAll("#nav button")) { if (b.dataset.page === page) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
  $("#ptitle").textContent = T("shell.nav." + page);
  $("#pviews").hidden = !VIEWS[page];
  for (const b of document.querySelectorAll("#pviews button")) { b.hidden = b.dataset.page !== page; b.setAttribute("aria-pressed", String(b.dataset.view === view)); }
  $("#pregions").hidden = tab !== "prompt"; $("#eviews").hidden = tab !== "events"; $("#hviews").hidden = tab !== "health"; $("#nviews").hidden = tab !== "notebook";
  // no views on this page: no empty navigation for a screen reader to announce
  $("#views").hidden = [...$("#views").children].every((g) => g.hidden);
}

// ---------- 给别的文件用的 ----------
export { go, renderIntro };
