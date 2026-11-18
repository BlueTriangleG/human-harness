"use strict";
import { T } from "./i18n.js";
import { $, el, laneOf, lens, selected } from "./core.js";
import { hm } from "./timeline.js";
import { lastStatus, paintBrain, putLastStatus, renderCard, select } from "./brain.js";
import { memNode, memPageId, renderMemDetail, tab } from "./memory.js";
import { renderPRegions } from "./prompt.js";
import { renderStatus } from "./now.js";
// ---------- 顶栏 ----------
async function refreshStatus() {
  let r;
  try { r = await fetch("/api/status").then((x) => x.json()); } catch { r = { ok: false, error: T("shell.state.consoleDown") }; }
  const st = $("#state");
  if (!r.ok) {
    putLastStatus(null);
    st.className = "state offline"; st.textContent = T("shell.state.hhdSilent"); st.title = r.error || "";
    paintBrain(); renderCard(); renderStatus();
    return;
  }
  const s = r.status;
  const first = !lastStatus;
  putLastStatus(s);
  st.title = "";
  const mood = T("shell.state." + (s.alertness === "asleep" ? "asleep" : s.alertness === "sleepy" ? "sleepy" : s.nightRest ? "nightRest" : s.focusSlot ? "focus" : "awake"));
  st.className = s.alertness === "asleep" || s.nightRest ? "state dim" : "state";
  st.replaceChildren(el("b", null, mood));
  if (s.focusUntil) st.append(T("shell.state.until", { time: s.focusUntil.replace(/^.*?(\d+:\d+):\d+$/, "$1") }));
  if (s.turning) st.append(T("shell.state.turning"));
  if (s.todos) st.append(T("shell.state.todos", { n: s.todos }));
  paintBrain(); renderCard(); renderStatus();
  // 记忆页「这一页」的细节里列着各脑区的上下文，是从这份状态里来的：状态比记忆晚到时，它已经画成「hhd 没有回应」了，这里补画一遍
  if (first && lens === "memory" && memNode === "page" && memPageId === null) renderMemDetail();
  if (tab === "prompt") renderPRegions();
}

async function refreshStrip() {
  const a = await fetch("/api/activity?minutes=60").then((x) => x.json()).catch(() => null);
  if (!a) return;
  const strip = $("#strip");
  const srcs = Object.keys(a.lanes).sort((x, y) => laneOf(x).order - laneOf(y).order || x.localeCompare(y));
  const max = Math.max(1, ...srcs.flatMap((s) => a.lanes[s]));
  const nodes = [el("h2", null, T("brain.strip.title"))];
  for (const s of srcs) {
    const lane = laneOf(s);
    const row = el("button", "lane" + (s === selected ? " sel" : ""));
    row.style.setProperty("--lane", "var(" + lane.color + ")");
    row.title = T("brain.only", { name: lane.name });
    row.addEventListener("click", () => select(s));
    const tr = el("div", "trace");
    tr.style.setProperty("--n", a.minutes);
    a.lanes[s].forEach((n, i) => {
      const b = el("b");
      b.style.height = n ? Math.max(12, Math.sqrt(n / max) * 100) + "%" : "0";
      b.title = T("brain.strip.bar", { time: hm(a.from + i * 60_000).slice(0, 5), name: lane.name, n });
      tr.append(b);
    });
    row.append(el("span", null, lane.name), tr);
    nodes.push(row);
  }
  if (srcs.length) {
    const axis = el("div", "axis");
    const ticks = el("div");
    for (let i = 0; i <= 3; i++) ticks.append(el("span", null, i === 3 ? T("common.now") : hm(a.from + i * 20 * 60_000).slice(0, 5)));
    axis.append(el("span"), ticks);
    nodes.push(axis);
  } else nodes.push(el("p", "hint", T("brain.strip.quiet")));
  strip.replaceChildren(...nodes);
}

// ---------- 给别的文件用的 ----------
export { refreshStatus, refreshStrip };
