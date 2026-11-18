"use strict";
import { HH, T } from "./i18n.js";
import { $, el, laneOf } from "./core.js";
import { rows } from "./timeline.js";
import { lastStatus } from "./brain.js";
import { tab } from "./memory.js";
import { go } from "./nav.js";
// ---------- 对话那一页：右边的窄状态栏，对话右上角的脑区指示 ----------
// 状态栏只放一眼能看的：醒着还是睡着、在忙还是空着、这周额度、手上的事、要你管的有几件（点开看是哪几件，每件点了跳到出处）。
// 都是现有接口里的数：/api/status 是顶栏每 4 秒读的那一份；帮手、顺不顺的接口只在这一页开着时读（start.js）
let workers = null, incidents = null, shown = "";

async function refreshNow() {
  if (tab !== "now") return;
  const get = (u) => fetch(u).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  [workers, incidents] = await Promise.all([get("/api/workers"), get("/api/incidents")]);
  renderStatus();
}

/** one line of the bar: a small label, then what it says */
function line(label, ...nodes) {
  const s = el("div", "nrow");
  s.append(el("span", "nlabel", label), ...nodes.filter(Boolean));
  return s;
}

/** a line that takes you to where it comes from */
function jump(text, to, bad) {
  const b = el("button", "njump" + (bad ? " bad" : ""), text);
  b.addEventListener("click", () => go(...to));
  return b;
}

function renderStatus() {
  renderPulse();
  const box = $("#status");
  const s = lastStatus;
  // a console without the talk pane says, where the pane would be, how to open it (/web/app/chat.js sets data-talk)
  $("#talkoff").hidden = $("#nowview").dataset.talk !== "off";
  const nodes = [];
  if (s) {
    const mood = T("shell.state." + (s.alertness === "asleep" ? "asleep" : s.alertness === "sleepy" ? "sleepy" : s.nightRest ? "nightRest" : s.focusSlot ? "focus" : "awake"));
    const busy = (s.regions || []).some((r) => r.id === "main" && r.busy);
    nodes.push(line(T("now.state"), el("b", null, mood), el("span", "nsub", busy ? T("now.busy") : T("now.idle"))));
    const q = s.quotaUsed || {};
    if (q.sevenDay != null) {
      const bar = el("div", "nbar");
      const fill = el("i");
      fill.style.width = Math.min(100, q.sevenDay) + "%";
      bar.append(fill);
      // the Claude account's week, the owner's own use in it too: not what this Human alone has used
      nodes.push(line(T("now.quota"), el("b", null, q.sevenDay + "%"), bar, el("span", "nsub", T("now.quotaWhose"))));
    } else nodes.push(line(T("now.quota"), el("span", "nsub", s.quota || T("now.quotaNone"))));
    const running = workers && workers.workers ? workers.workers.filter((w) => w.state === "running" || w.state === "busy").length : 0;
    const claims = (s.claims || []).slice(0, 3).map((c) => el("span", "nitem", c.topic));
    nodes.push(line(T("now.doing"), ...(claims.length ? claims : [el("span", "nsub", T("now.doingNone"))]), running ? jump(T("now.helpers", { n: running }), ["activity", "timeline"]) : null));
  }
  // what wants the owner: a count; open it for the lines, each opens where it comes from
  const todo = [];
  if (!s) todo.push(jump(T("now.hhdSilent"), ["run"], true));
  else {
    if (s.rulesErrors && s.rulesErrors.length) todo.push(jump(T("now.rules", { n: s.rulesErrors.length }), ["activity", "gate"], true));
    if (s.todos) todo.push(jump(T("now.todos", { n: s.todos }), ["activity", "timeline"]));
    if (s.registryChanges && s.registryChanges.length) todo.push(jump(T("now.registry", { n: s.registryChanges.length }), ["activity", "timeline"]));
  }
  if (incidents && incidents.hours) {
    const sum = (k) => incidents.hours.reduce((n, h) => n + (h[k] || 0), 0);
    const bad = sum("stops") + sum("refusals");
    if (bad) todo.push(jump(T("now.incidents", { n: bad }), ["run"], true));
    if (sum("blocks")) todo.push(jump(T("now.blocked", { n: sum("blocks") }), ["run"]));
  }
  const need = el("details", "nneed");
  const head = el("summary", null, T("now.attention") + " ");
  head.append(el("b", todo.length ? "bad" : null, String(todo.length)));
  need.append(head, ...todo);
  need.setAttribute("aria-live", "polite");
  nodes.push(need);
  // the status comes every 4 seconds: redraw only when something changed, and keep the list open if it was
  const text = nodes.map((n) => n.textContent).join("\n");
  if (text === shown) return;
  shown = text;
  need.open = !!box.querySelector("details.nneed[open]");
  box.replaceChildren(...nodes);
}

/** the region's latest step while it is at work: thinking, or the tool it called */
function doing(id) {
  const name = laneOf(id).name;
  for (let i = rows.length - 1; i >= 0 && i >= rows.length - 400; i--) {
    const r = rows[i];
    if (r.src !== id) continue;
    if (r.kind === "act") return T("now.pulseTool", { name, tool: (r.meta && r.meta.tool) || "" });
    if (r.kind === "think") return T("now.pulseThink", { name });
    break;
  }
  return T("now.pulseBusy", { name });
}

/** one dot per brain region in the corner of the talk pane: the ones at work turn; the words say what they do */
function renderPulse() {
  const s = lastStatus;
  const regions = s ? [...(s.regions || [])].sort((a, b) => laneOf(a.id).order - laneOf(b.id).order) : [];
  $("#pulsedots").replaceChildren(...regions.map((r) => {
    const d = el("i", r.busy ? "on" : null);
    d.style.setProperty("--lane", "var(" + laneOf(r.id).color + ")");
    d.title = laneOf(r.id).name;
    return d;
  }));
  const busy = regions.filter((r) => r.busy);
  $("#pulsetext").textContent = !s ? T("shell.state.hhdSilent") : busy.length ? busy.map((r) => doing(r.id)).join(T("common.listSep")) : T("now.pulseIdle");
  $("#pulse").classList.toggle("on", busy.length > 0);
  $("#pulse").setAttribute("aria-label", T("now.pulseLabel", { what: $("#pulsetext").textContent }));
}
$("#pulse").addEventListener("click", () => go("activity", "timeline"));
// a console without the talk pane: the one command that opens it, to copy
$("#talkcmd").textContent = HH.base.cmd;
$("#talkcopy").addEventListener("click", (e) => navigator.clipboard.writeText(HH.base.cmd).then(() => { e.target.textContent = T("now.copied"); }, () => undefined));
// past every fold of the thread, straight to the box to type in
$("#toinput").addEventListener("click", (e) => { e.preventDefault(); document.querySelector("#chat .ct-input")?.focus(); });

// ---------- 给别的文件用的 ----------
export { refreshNow, renderPulse, renderStatus };
