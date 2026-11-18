"use strict";
import { T, TGroup, clock } from "./i18n.js";
import { $, el, laneOf } from "./core.js";
import { ago, hm } from "./timeline.js";
import { openWorker } from "./drawer.js";
import { when } from "./memory.js";
// ---------- 右栏 ----------
// 帮手：按在干活、空闲、结束了（或一天没动）分三组，每组能收起；名字能筛；每个写着用的模型、第几轮、多久以前动过，点开看过程
const DAY = 24 * 3600_000;
const W_GROUPS = ["working", "idle", "done"];
const wOpen = { working: true, idle: true, done: false };
let wList = [];
const groupOf = (w) => (w.state === "running" || w.state === "busy" ? "working" : w.state === "idle" && w.lastActive && clock() - w.lastActive < DAY ? "idle" : "done");
async function refreshWorkers() {
  const r = await fetch("/api/workers").then((x) => x.json()).catch(() => null);
  if (!r) return;
  // no helper-session folder configured for this role: hide the panel, heading included
  const none = r.configured === false;
  $("#workersh").hidden = none; $("#workers").hidden = none; $("#wfilter").hidden = none || r.workers.length < 6;
  if (none) return;
  wList = r.workers;
  renderWorkers();
}
function renderWorkers() {
  const box = $("#workers");
  if (!wList.length) { box.replaceChildren(el("p", "hint", T("side.noWorkers"))); return; }
  const q = $("#wfilter").value.trim().toLowerCase();
  const shown = wList.filter((w) => !q || w.name.toLowerCase().includes(q)).sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
  box.replaceChildren(...W_GROUPS.map((g) => {
    const ws = shown.filter((w) => groupOf(w) === g);
    const d = el("details", "wgroup " + g);
    d.open = wOpen[g] && ws.length > 0;
    d.addEventListener("toggle", () => { wOpen[g] = d.open; });
    d.append(el("summary", null, T("side.workerGroups." + g, { n: ws.length })));
    d.append(...ws.map((w) => {
      const b = el("button", "w" + (g === "working" ? " busy" : ""));
      b.append(el("div", "nm", w.name), el("div", "sub", [w.model, w.turn != null ? T("common.turns", { n: w.turn }) : null, w.lastActive ? ago(w.lastActive) : null].filter(Boolean).join(T("common.comma"))));
      b.addEventListener("click", () => openWorker(w.name));
      return b;
    }));
    return d;
  }));
}
$("#wfilter").addEventListener("input", renderWorkers);

// 学习：最近 7 天的数字、今天的花费、最近 20 次联想；hhd 记了告警（24 小时内的）就标红放最上面，带上时间
const LEARN_BINDING = TGroup("side.learn.binding");
const LEARN_SKIP = TGroup("side.learn.skip");
async function refreshLearn() {
  const r = await fetch("/api/learn").then((x) => x.json()).catch(() => null);
  const box = $("#learn");
  if (!r || r.error) { box.replaceChildren(el("p", "hint", r && r.error ? r.error : T("side.learn.failed"))); return; }
  const nodes = [];
  if (r.alert) nodes.push(el("p", "learn-alert", r.alertAt ? T("side.learn.alertAt", { alert: r.alert, when: when(r.alertAt) }) : r.alert));
  const w = r.weekly;
  const pct = (x) => Math.round(x * 100) + "%";
  // 一行数：叫法、数，叫法下面可以带一句小字说明
  const numbers = (list) => {
    const grid = el("div", "lnum");
    for (const [k, v, note] of list) {
      const name = el("span", null, k);
      if (note) name.append(el("small", null, note));
      grid.append(name, el("b", null, v));
    }
    return grid;
  };
  const grid = numbers([
    [T("side.learn.newLessons"), T("common.rows", { n: w.newLessons })],
    [T("side.learn.recur"), w.recurMounted + " / " + w.recurUnmounted],
    [T("side.learn.corrections"), T("common.times", { n: w.corrections }), T("side.learn.correctionsNote")],
    [T("side.learn.catchRate"), w.mounts ? T("side.learn.catchValue", { pct: pct(w.opened / w.mounts), opened: w.opened, mounts: w.mounts }) : T("common.dash")],
    [T("side.learn.idleMounts"), T("common.times", { n: w.idleMounts })],
    [T("side.learn.promoted"), T("common.rows", { n: w.promoted })],
    [T("side.learn.spend"), "$" + r.spend.usd + " / $" + r.spend.limit],
  ]);
  // 没什么人看的两样收在「更多」里（学习 11-13：数还在算，她的情境和每周小结也用，只是页面上收起来）；开着的话刷新以后还开着
  const more = el("details", "lmore");
  more.open = !!box.querySelector("details.lmore")?.open;
  more.append(el("summary", "hint", T("side.learn.more")), numbers([
    [T("side.learn.estimate"), w.estimateRatio == null ? T("common.dash") : T("side.learn.estimateValue", { x: w.estimateRatio })],
    [T("side.learn.replay"), w.replayPassRate == null ? T("common.dash") : pct(w.replayPassRate)],
  ]));
  nodes.push(el("p", "hint", T("side.learn.week")), grid, more, el("p", "hint", T("side.learn.recent")));
  if (!r.recent.length) nodes.push(el("p", "hint", T("side.learn.none")));
  for (const a of r.recent) {
    const d = el("div", "la");
    d.append(el("span", "t", hm(a.at)), el("span", null, T("side.learn.line", { region: laneOf(a.region).name, binding: LEARN_BINDING[a.binding] || a.binding || T("side.learn.unknown"), shadow: a.shadow ? T("side.learn.shadow") : "" })));
    d.append(el("span", "tp", (a.topic || "").slice(0, 60)));
    const got = a.mounted.length
      ? el("div", "pg", a.mounted.map((m) => m.id + " " + Math.round(m.p * 100) + "%").join(T("common.listSep")))
      : el("div", "sk", LEARN_SKIP[a.skipped] || a.skipped || LEARN_SKIP.nothing);
    d.append(got);
    nodes.push(d);
  }
  box.replaceChildren(...nodes);
}

// ---------- 给别的文件用的 ----------
export { refreshLearn, refreshWorkers };
