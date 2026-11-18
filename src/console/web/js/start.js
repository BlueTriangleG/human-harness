"use strict";
import { pairing } from "./owner.js";   // first: every read of this console carries the owner's token
import { HH, T } from "./i18n.js";
import { $, el, gateDay, gateOpen, lens, putGateDay, putLens, putSelected } from "./core.js";
import { appendRows, index, lastSeq, putFirstSeq, putLastSeq, renderAll, rows, tl } from "./timeline.js";
import { paintBrain, renderCard } from "./brain.js";
import { renderKinds, renderScope } from "./toolbar.js";
import { refreshStatus, refreshStrip } from "./topbar.js";
import { renderIntro } from "./nav.js";
import { showMachine } from "./machine.js";
import { refreshNow, renderPulse } from "./now.js";
import { refreshNotes } from "./notify.js";
import { refreshLearn, refreshWorkers } from "./side.js";
import { loadGate, openGate } from "./gate.js";
import { openWorker } from "./drawer.js";
import { MEM, mnodes, putMemNode, refreshMemory, setLens, setTab, tab } from "./memory.js";
import { putPromptRegion } from "./prompt.js";
import { EV_VIEWS, loadEvList, putEvFocus, putEvSel, putEvView, refreshEvOverview } from "./events.js";
import { loadHealth, putHealthView } from "./health.js";
import { NB_VIEWS, loadNotebook, putNbSel, putNbView } from "./notebook.js";
import { keyHint, readKey } from "./settings.js";
// ---------- 开始 ----------
/** a browser this console does not know (not paired, or no owner's token set up yet): only how to pair it */
function unpaired(talkOn) {
  $("#unpairedtext").textContent = talkOn ? T("chat.notPaired") : T("now.talkOff");
  $("#unpairedcmd").textContent = HH.base.cmd;
  $("#unpairedcopy").addEventListener("click", (e) => navigator.clipboard.writeText(HH.base.cmd).then(() => { e.target.textContent = T("now.copied"); }, () => undefined));
  $("#unpaired").hidden = false;
  document.body.classList.add("unpaired");
}

async function start() {
  if (pairing && await pairing) return;   // traded a pairing code for the token: the page is reloading
  // every read but the summary is the owner's (server.ts): a browser it does not know sees only how to pair
  const ps = await fetch("/api/pair/status").then((x) => x.json()).catch(() => null);
  if (!HH.demo && !(ps && ps.enabled && (!ps.token || ps.paired))) { unpaired(!!(ps && ps.enabled)); return; }
  const m = location.hash.match(/^#r=(.+)$/);
  if (m) putSelected(decodeURIComponent(m[1]));
  try {
    const r = await fetch("/api/central?limit=600").then((x) => x.json());
    if (r.error) throw new Error(r.error);
    rows.push(...r.rows); index(r.rows);
    putFirstSeq(rows.length ? rows[0].seq : null);
    putLastSeq(rows.length ? rows[rows.length - 1].seq : r.maxSeq);
    renderAll();
  } catch (e) {
    tl.replaceChildren(el("div", "empty", T("timeline.loadFailed", { error: e.message })));
  }
  renderScope(); renderKinds(); paintBrain(); renderCard(); renderIntro();
  const es = new EventSource("/api/stream?after=" + lastSeq);
  es.addEventListener("rows", (ev) => { const was = rows.some((r) => r.meta && r.meta.inner); appendRows(JSON.parse(ev.data)); if (!was) renderKinds(); renderPulse(); });
  es.addEventListener("problem", (ev) => console.warn("stream", ev.data));
  refreshStatus(); refreshStrip(); refreshWorkers(); refreshLearn(); refreshNow(); refreshNotes();
  // the state in the top bar is read all the time; each page's own data only while that page is open
  const on = (t, f) => () => { if (tab === t) f(); };
  setInterval(refreshStatus, 4000);
  setInterval(on("now", refreshNow), 60_000);
  setInterval(on("brain", refreshStrip), 30_000);
  setInterval(on("brain", refreshWorkers), 15_000);
  setInterval(refreshNotes, 30_000);   // the bell in the top bar, on every page
  setInterval(on("brain", refreshLearn), 60_000);
  setInterval(() => { paintBrain(); }, 10_000);   // 没新动静时也让亮度慢慢退下去
  setInterval(refreshMemory, 30_000);
  setInterval(() => { if (tab === "events") { refreshEvOverview(); loadEvList(false); } }, 30_000);
  setInterval(() => { if (gateOpen && !gateDay && tab === "brain" && lens !== "memory") loadGate(false); }, 30_000);
  setInterval(() => { if (tab === "health") loadHealth(); }, 60_000);   // 服务端五分钟内给的是同一份，这里只是到点了能自己换上新的
  setInterval(() => { if (tab === "notebook") loadNotebook(); }, 60_000);
  const mh = location.hash.match(/^#mem(?::([a-z]+))?$/);
  const ih = location.hash.match(/^#in(?::([a-z0-9-]+))?$/);
  const eh = location.hash.match(/^#ev(?::([a-z0-9]+))?$/);
  const gh = location.hash.match(/^#gate(?::(\d{4}-\d{2}-\d{2}))?$/);
  const hh = location.hash.match(/^#health(?::(week))?$/);   // 要在 setLens 之前认：它会把地址栏改成当前这一页的
  const nh = location.hash.match(/^#nb(?::([a-z0-9-]+))?$/);
  // no address (or the talk pane's old #chat): 此刻, the first page. #activity, #mem, #gate: the brain pane, as before
  const ah = location.hash === "#activity";
  if (location.hash === "#settings") setTab("settings");
  readKey().then(keyHint);   // no OpenAI key: a dot on Settings
  // Human.app opens this computer's page alone (/?human#machine); #machine, #machine:monitor open it in any console
  const human = new URLSearchParams(location.search).has("human");
  if (human) document.body.classList.add("human");
  const xh = location.hash.match(/^#machine(?::(monitor))?$/);
  if (human || xh) { setTab("machine"); showMachine(xh && xh[1] ? "monitor" : "roles"); }
  if (mh) { putLens("memory"); if (mh[1] && (MEM[mh[1]] || mnodes.has(mh[1]))) putMemNode(mh[1]); }
  if (gh || ah) { putLens("think"); putGateDay(gh ? gh[1] || null : null); }
  if (mh || gh || ah) { setTab("brain"); setLens(lens); }
  if (gh) openGate(true);
  if (ih) { if (ih[1]) putPromptRegion(ih[1]); setTab("prompt"); }
  if (eh) {
    const v = eh[1];
    if (v && /^[en]\d{4,7}$/.test(v)) { putEvSel(v); putEvFocus(v.startsWith("n") ? v : null); }
    else if (v && EV_VIEWS.some(([k]) => k === v)) putEvView(v);
    setTab("events");
  }
  if (hh) { if (hh[1]) { putHealthView("week"); for (const b of document.querySelectorAll("#hviews button")) b.setAttribute("aria-pressed", String(b.dataset.hview === "week")); } setTab("health"); }
  if (nh) { if (nh[1]) { if (NB_VIEWS.includes(nh[1])) putNbView(nh[1]); else putNbSel(nh[1]); } setTab("notebook"); }
  // 地址带 #w=名字 时直接打开那个会话
  const w = location.hash.match(/^#w=([A-Za-z0-9._-]+)$/);
  if (w) openWorker(w[1]);
}
start();
