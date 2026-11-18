"use strict";
import { T } from "./i18n.js";
import { $, el } from "./core.js";
import { tab } from "./memory.js";
// ---------- 这台电脑：跑在这里的角色，点一个右边就是它的控制台；监视台一页看全 ----------
// 数据是 /api/machine：服务端去问各角色控制台的 /api/summary（machine.ts：只有状态，没有事情、原话和人名）。Human.app 开的是 /?human#machine，只看这一页
let machineView = "roles", picked = null, last = null;

/** how a role is: red when it does not answer or had trouble today, grey asleep, blue at work, green idle */
function stateOf(r) {
  if (!r.up) return ["down", T("machine.state.down")];
  if (r.today.stops || r.today.refusals || r.rulesErrors) return ["trouble", T("machine.state.trouble")];
  if (r.alertness === "asleep") return ["asleep", T("machine.state.asleep")];
  if (r.busy) return ["busy", T("machine.state.busy")];
  return ["idle", T("machine.state.idle")];
}

async function refreshMachine() {
  if (tab !== "machine") return;
  const j = await fetch("/api/machine").then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (j.error) { $("#mlist").replaceChildren(el("li", "hint", T("machine.loadFailed", { error: j.error }))); return; }
  last = j;
  renderList();
  if (machineView === "monitor") renderMonitor();
}

/** the left column: one line per role */
function renderList() {
  $("#mlist").replaceChildren(...last.roles.map((r) => {
    const [k, word] = stateOf(r);
    const on = machineView === "roles" && picked === r.port;
    const b = el("button", "mrole");
    b.setAttribute("aria-pressed", String(on));
    const who = el("span", "mwho");
    who.append(el("b", null, r.name), el("span", "msub", T("machine.roleSub", { account: r.account || "—", state: word })));
    b.append(el("i", "mdot " + k), who);
    b.addEventListener("click", () => { picked = r.port; showMachine("roles"); });
    const li = el("li");
    li.append(b);
    return li;
  }));
}

/** a role's console on the right; the monitor in its place */
function showMachine(view) {
  machineView = view;
  if (view === "roles" && picked === null && last) picked = (last.roles.find((r) => r.up) || last.roles[0] || {}).port ?? null;
  const frame = $("#mframe");
  const src = view === "roles" && picked ? `http://127.0.0.1:${picked}/` : "";
  if (frame.dataset.src !== src) { frame.dataset.src = src; frame.src = src || "about:blank"; }
  frame.hidden = !src;
  $("#monitor").hidden = view !== "monitor";
  $("#mempty").hidden = view !== "roles" || !!src;
  if (last) { renderList(); if (view === "monitor") renderMonitor(); }
}

/** a line of the card: a small label, then what it says */
function line(label, text, bad) {
  const p = el("p", "mline");
  p.append(el("span", "mlabel", label), el("span", bad ? "bad" : null, text));
  return p;
}

/** the monitor: one card per role, the machine's lock under them */
function renderMonitor() {
  const cards = last.roles.map((r) => {
    const [k, word] = stateOf(r);
    const c = el("article", "mcard");
    const h = el("h3");
    h.append(el("i", "mdot " + k), document.createTextNode(r.name + " "), el("span", "msub", word));
    c.append(h);
    if (!r.up) { c.append(el("p", "hint", T("machine.noAnswer", { port: r.port }))); return c; }
    c.append(line(T("machine.regions"), r.busy ? T("machine.state.busy") : T("machine.allIdle")));
    c.append(line(T("machine.quota"), r.quota == null ? T("machine.none") : r.quota + "%"));
    c.append(line(T("machine.load"), r.load ? T("machine.loadLevel." + r.load) : T("machine.none"), !!r.load && r.load !== "ok"));
    c.append(line(T("machine.today"), T("machine.todayCounts", r.today), r.today.stops + r.today.refusals > 0));
    return c;
  });
  const l = last.lock;
  const lock = l ? line(T("machine.lock"), !l.held ? T("machine.lockFree") : l.alive ? l.who : T("machine.lockStale", { who: l.who })) : null;
  $("#monitor").replaceChildren(el("div", "mcards"), ...(lock ? [lock] : []));
  $("#monitor .mcards").append(...cards);
}

setInterval(refreshMachine, 10_000);

// ---------- 给别的文件用的 ----------
export { machineView, refreshMachine, showMachine };
