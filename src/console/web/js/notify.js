"use strict";
import { T } from "./i18n.js";
import { $, el } from "./core.js";
import { when } from "./memory.js";
// ---------- 通知：hhd 的警告和错误 ----------
// 顶栏一个铃铛带未读数，点开是按时间的通知（新的在上）。同一类（同一个模块、同一句话，数字不算）并成一条，带次数和最近一次。
// 读到哪儿记在这个浏览器里（只是个方便：清掉了就全算没读），「全部标为已读」把它挪到最新那一条
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
const KEY = "hh-console-notes-read";
let readUpTo = (() => { try { return Number(LS?.getItem(KEY)) || 0; } catch { return 0; } })();
let groups = [];

/** the same kind of line: its level, module and words, with the numbers taken out */
const kindOf = (l) => [l.level, l.mod, String(l.msg).replace(/\d+(\.\d+)?/g, "#")].join("|");

async function refreshNotes() {
  const r = await fetch("/api/log?level=warn&n=300").then((x) => x.json()).catch(() => null);
  if (!r) return;
  const by = new Map();
  for (const l of r.lines) {
    const t = Date.parse(l.t);
    const g = by.get(kindOf(l)) || { line: l, at: t, n: 0 };
    g.n += 1;
    if (t >= g.at) { g.at = t; g.line = l; }
    by.set(kindOf(l), g);
  }
  groups = [...by.values()].sort((a, b) => b.at - a.at);
  renderNotes();
}

function renderNotes() {
  const unread = groups.filter((g) => g.at > readUpTo).length;
  const c = $("#bellcount");
  c.hidden = unread === 0;
  c.textContent = unread > 99 ? "99+" : String(unread);
  $("#bell").classList.toggle("bad", groups.some((g) => g.at > readUpTo && g.line.level === "error"));
  $("#bell").title = T("shell.notes.unread", { n: unread });
  $("#bell").setAttribute("aria-label", T("shell.notes.bellLabel", { n: unread }));
  const list = $("#noteslist");
  if (!groups.length) { list.replaceChildren(el("p", "hint", T("side.noLogs"))); return; }
  list.replaceChildren(...groups.map((g) => {
    const l = g.line;
    const d = el("div", "note " + l.level + (g.at > readUpTo ? " unread" : ""));
    const head = el("div", "nh");
    head.append(el("span", "lv", l.level === "error" ? T("side.error") : T("side.warn")), el("span", "t", when(g.at)));
    if (g.n > 1) head.append(el("span", "times", T("shell.notes.times", { n: g.n })));
    const extra = Object.entries(l).filter(([k]) => !["t", "level", "mod", "msg"].includes(k)).map(([k, v]) => k + "=" + (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
    d.append(head, el("div", "msg", T("side.logLine", { mod: l.mod, msg: l.msg }) + (extra ? T("side.logExtra", { extra: extra.slice(0, 300) }) : "")));
    return d;
  }));
}

function openNotes(on) {
  $("#notes").hidden = !on;
  $("#bell").setAttribute("aria-expanded", String(on));
  if (on) $("#notesread").focus();
}
$("#bell").addEventListener("click", (e) => { e.stopPropagation(); openNotes($("#notes").hidden); });
$("#notesread").addEventListener("click", () => {
  readUpTo = Math.max(readUpTo, ...groups.map((g) => g.at));
  try { LS?.setItem(KEY, String(readUpTo)); } catch { /* this browser keeps nothing: they show as unread next time */ }
  renderNotes();
});
document.addEventListener("click", (e) => { if (!$("#notes").hidden && !$("#notes").contains(e.target)) openNotes(false); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#notes").hidden) { openNotes(false); $("#bell").focus(); } });

// ---------- 给别的文件用的 ----------
export { refreshNotes };
