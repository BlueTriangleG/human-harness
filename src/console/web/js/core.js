"use strict";
import { T, TGroup } from "./i18n.js";
const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };

// ---------- 脑区：名字、颜色、在大脑哪一块 ----------
/** 一个脑区在包里的名字、位置、说明（regions.<键>.name / where / what） */
const regionText = (key, color, order, params) => ({ name: T("regions." + key + ".name", params), where: T("regions." + key + ".where", params), what: T("regions." + key + ".what", params), color, order });
const REGION = {
  main: regionText("main", "--l-main", 0),
  // 11-04 以前的下意识脑区：已经不开了，中央记忆里只剩它当时的记录（旧行照样显示）
  "perception-messages": regionText("oldPerception", "--l-perception", 1),
  speech: regionText("speech", "--l-speech", 3),
  hippocampus: regionText("hippocampus", "--l-hippo", 4),
  "外界": regionText("outer", "--l-outer", 5),
  system: regionText("system", "--l-system", 6),
  deep: regionText("deep", "--l-deep", 2.5),
};
function laneOf(src) {
  if (REGION[src]) return REGION[src];
  if (src.startsWith("side-")) return regionText("side", "--l-side", 2, { n: src.slice(5) });   // 配了几个就有几个，不在上面一个个列
  if (src.startsWith("perception-")) return { name: T("regions.oldPerception.nameOf", { stream: src.slice(11) }), where: T("regions.oldPerception.where"), what: T("regions.oldPerception.whatOther"), color: "--l-perception", order: 1 };
  return { name: src, where: "", what: "", color: "--l-system", order: 7 };
}
/** 下意识 = 闸门（丘脑）：大脑图上那一块点开是闸门的账，不是中央记忆里的一个来源 */
const GATE = { name: T("regions.gate.name"), where: T("regions.gate.where"), color: "--l-perception", what: T("regions.gate.what") };
const KINDS = ["input", "think", "say", "act", "result", "note", "system"].map((k) => [k, T("regions.kinds." + k)]);
const VERB = Object.fromEntries(KINDS);
/** 事件库的工具：名字后面带一句说明 */
const TOOL_CN = TGroup("regions.tools");
const shortTool = (n) => (n || "").replace(/^mcp__self__/, "");

// ---------- 过滤 ----------
const LS = (() => { try { return window.localStorage; } catch { return null; } })();
const saved = (() => { try { return JSON.parse(LS?.getItem("hh-console") || "{}"); } catch { return {}; } })();
const hidden = { kind: new Set(saved.kind || []), inner: saved.inner === true };
let selected = typeof saved.selected === "string" ? saved.selected : null;
let lens = saved.lens === "memory" ? "memory" : "think";
let query = "";
// 下意识（闸门）那一页：开着没有、看哪一天（null = 她的今天）、读到的账
let gateOpen = false, gateDay = null, gateData = null, gateToday = null, gateSeq = 0, gateKey = "";
function persist() {
  try { LS?.setItem("hh-console", JSON.stringify({ kind: [...hidden.kind], inner: hidden.inner, selected, lens })); } catch {}
}
function visible(r) {
  if (selected && r.src !== selected) return false;
  if (hidden.kind.has(r.kind)) return false;
  if (hidden.inner && r.meta && r.meta.inner === true) return false;
  if (!query) return true;
  const hay = (r.text + " " + (r.meta ? JSON.stringify(r.meta) : "")).toLowerCase();
  return hay.includes(query);
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putGateData(v) { return gateData = v; }
function putGateDay(v) { return gateDay = v; }
function putGateKey(v) { return gateKey = v; }
function putGateOpen(v) { return gateOpen = v; }
function putGateSeq(v) { return gateSeq = v; }
function putGateToday(v) { return gateToday = v; }
function putLens(v) { return lens = v; }
function putQuery(v) { return query = v; }
function putSelected(v) { return selected = v; }
export {
  $, GATE, KINDS, TOOL_CN, VERB, el, gateData, gateDay, gateKey, gateOpen, gateSeq, gateToday, hidden, laneOf, lens, persist, query, selected, shortTool,
  visible, putGateData, putGateDay, putGateKey, putGateOpen, putGateSeq, putGateToday, putLens, putQuery, putSelected,
};
