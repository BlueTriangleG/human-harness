"use strict";
import { HH, T, TGroup } from "./i18n.js";
import { $, el, laneOf } from "./core.js";
import { hm } from "./timeline.js";
import { lastStatus } from "./brain.js";
import { dhm, openDoc, svgEl, tok, updateHash, when } from "./memory.js";
// ---------- 完整输入：某个脑区这个会话完整收到了什么 ----------
let promptRegion = "main", promptData = null;
// 问不到 hhd 时列哪几个脑区：服务端给的（配置里来的）；没给就是默认的那几个
const PREGIONS = ["main", "side-1", "side-2", "speech", "hippocampus"];
const pregions = () => (Array.isArray(HH.regions) && HH.regions.length ? HH.regions : PREGIONS);
const estTok = (t) => { if (!t) return 0; const cjk = (t.match(/[　-鿿가-힯＀-￯]/g) || []).length; return Math.ceil(cjk * 1.1 + (t.length - cjk) / 3.6); };
const preview = (t) => (t || "").replace(/\s+/g, " ").trim().slice(0, 140);
const ATT = TGroup("prompt.attachmentType");

function renderPRegions() {
  const ids = (lastStatus?.regions || []).map((g) => g.id);
  const list = ids.length ? ids : pregions();
  $("#pregions").replaceChildren(...list.map((id) => {
    const b = el("button", null, laneOf(id).name);
    b.style.setProperty("--lane", "var(" + laneOf(id).color + ")");
    b.setAttribute("aria-pressed", String(id === promptRegion));
    b.addEventListener("click", () => loadPrompt(id));
    return b;
  }));
}

async function loadPrompt(region, session) {
  promptRegion = region;
  updateHash(); renderPRegions();
  $("#pbody").replaceChildren(el("p", "hint", T("common.loading")));
  const url = session ? "/api/prompt?session=" + encodeURIComponent(session) : "/api/prompt?region=" + encodeURIComponent(region);
  const [r, list] = await Promise.all([
    fetch(url).then((x) => x.json()).catch((e) => ({ error: String(e) })),
    fetch("/api/prompt/sessions?region=" + encodeURIComponent(region)).then((x) => x.json()).catch(() => ({ sessions: [] })),
  ]);
  if (region !== promptRegion) return;
  renderPSess(r, list.sessions || []);
  if (r.error) { $("#pbody").replaceChildren(el("p", "hint", r.error)); return; }
  promptData = r;
  renderPrompt();
}

function renderPSess(r, sessions) {
  const nodes = [];
  if (!r.error) {
    const u = r.usage, first = u[0], last = u[u.length - 1];
    nodes.push(el("span", null, T("prompt.session.label", { id: r.session.id.slice(0, 8), how: r.how })));
    if (r.session.started) nodes.push(el("span", null, T("prompt.session.started", { when: when(Date.parse(r.session.started)) })));
    nodes.push(el("span", null, T("prompt.session.calls", { n: u.length })));
    if (first) nodes.push(el("span", null, T("prompt.session.context", { first: tok(first.total), last: tok(last.total) })));
  }
  if (sessions.length) {
    const sel = el("select");
    sel.setAttribute("aria-label", T("prompt.session.others"));
    sel.append(new Option(T("prompt.session.others"), ""));
    for (const x of sessions) sel.append(new Option(T("prompt.session.option", { when: when(x.mtime), id: x.id.slice(0, 8) }), x.id));
    sel.addEventListener("change", () => { if (sel.value) loadPrompt(promptRegion, sel.value); });
    nodes.push(sel);
  }
  $("#psess").replaceChildren(...nodes);
}

function prow(time, label, pv, size, onOpen, color, first) {
  const b = el("button", "prow" + (first ? " first" : ""));
  if (color) b.style.setProperty("--c", "var(" + color + ")");
  const z = el("span", "z", size);
  z.title = T("prompt.sizeTitle");
  b.append(el("span", "t", time || ""), el("span", "k", label), el("span", "v", pv), z);
  b.addEventListener("click", onOpen);
  return b;
}

function msgLabel(m, i) {
  if (m.role === "assistant") return m.kind === "thinking" ? T("prompt.messageLabel.thinks") : m.kind === "tool_use" ? (m.tool ? T("prompt.messageLabel.uses", { tool: m.tool.replace("mcp__self__", "") }) : T("prompt.messageLabel.usesSomeTool")) : T("prompt.messageLabel.says");
  if (m.kind === "tool_result") return m.error ? T("prompt.messageLabel.toolError", { tool: (m.tool || "").replace("mcp__self__", "") }) : T("prompt.messageLabel.toolResult", { tool: (m.tool || "").replace("mcp__self__", "") });
  if (i === 0) return T("prompt.messageLabel.first");
  if (m.forYou) return T("prompt.messageLabel.wakeWithContext");   // 附着「只给你看」的那一段：服务端认的（那句话在她的语言包里）
  const tt = m.text.trim();
  const tag = HH.marks.memoryTag;   // the tag that wraps a block of the role's memory, as the role's side writes it
  if (tag && tt.startsWith(`<${tag}>`)) return tt.endsWith(`</${tag}>`) ? T("prompt.messageLabel.newRecords") : T("prompt.messageLabel.newRecordsAndWake");
  return T("prompt.messageLabel.wake");
}
function msgColor(m) {
  if (m.role === "assistant") return m.kind === "thinking" ? "--muted" : m.kind === "tool_use" ? "--l-outer" : "--l-main";
  return m.kind === "tool_result" ? (m.error ? "--err" : "--faint") : "--l-speech";
}

function renderPrompt() {
  const r = promptData;
  const body = $("#pbody");
  // 每段是什么看服务端给的 kind（prompt.ts 的 SegmentKind），label 只是显示用的名字
  const isCC = (x) => x.kind === "cc" || x.kind === "boundary";
  const isFile = (x) => x.kind === "personaFile" || x.kind === "memoryFile";
  const snapshot = (x) => x.kind === "memoryFile" || x.kind === "midterm" || (isFile(x) && /(MEMORY\.md|ledger\/SOUL\.md)$/.test(x.file));
  const hasMid = r.system.some((x) => x.kind === "midterm");
  const persona = (x) => isFile(x) && !snapshot(x);
  const hhNote = (x) => x.kind === "runtime" || x.kind === "frame";
  const sumT = (items, f) => items.reduce((n, x) => n + estTok(f ? f(x) : x.text), 0);
  const groups = [
    { name: T("prompt.group.claudeCode"), color: "--l-system", t: sumT(r.system.filter(isCC)) },
    { name: T("prompt.group.hhNote"), color: "--l-outer", t: sumT(r.system.filter(hhNote)) },
    { name: T("prompt.group.persona"), color: "--l-main", t: sumT(r.system.filter(persona)) },
    { name: hasMid ? T("prompt.group.slowWithMid") : T("prompt.group.slow"), color: "--l-side", t: sumT(r.system.filter(snapshot)) },
    { name: T("prompt.group.fast"), color: "--l-hippo", t: sumT(r.system.filter((x) => x.kind === "compacted")) },
    { name: T("prompt.group.tools"), color: "--l-perception", t: sumT(r.tools, (x) => x.name + x.description + x.schema) },
    { name: T("prompt.group.attachments"), color: "--l-speech", t: sumT(r.attachments) },
    { name: T("prompt.group.firstMessage"), color: "--muted", t: sumT(r.messages.slice(0, 1)) },
    { name: T("prompt.group.laterMessages"), color: "--faint", t: sumT(r.messages.slice(1)) },
  ].filter((g) => g.t > 0);
  const total = groups.reduce((n, g) => n + g.t, 0) || 1;
  const bar = el("div", "pcomp");
  for (const g of groups) { const sp = el("span"); sp.style.width = (g.t / total * 100) + "%"; sp.style.background = "var(" + g.color + ")"; sp.title = T("prompt.groupSize", { name: g.name, size: tok(g.t) }); bar.append(sp); }
  const key = el("div", "pkey");
  for (const g of groups) { const k = el("span"); const sw = el("b"); sw.style.background = "var(" + g.color + ")"; k.append(sw, g.name + " ", el("em", null, tok(g.t))); key.append(k); }
  const nodes = [
    el("h2", null, T("prompt.heading", { name: laneOf(promptRegion).name })),
    el("p", "hint", T("prompt.hint", { total: tok(total) })),
    bar, key,
  ];
  // 上下文怎么涨的（模型每次报的真实数）
  if (r.usage.length > 1) {
    const W = 960, H = 70, max = Math.max(...r.usage.map((u) => u.total)) * 1.08;
    const pts = r.usage.map((u, i) => [(i / (r.usage.length - 1)) * (W - 60) + 50, H - 14 - (u.total / max) * (H - 24)]);
    const svg = svgEl("svg", { class: "pgrow", viewBox: "0 0 " + W + " " + H, preserveAspectRatio: "none" });
    svg.append(svgEl("line", { class: "ax", x1: 50, x2: W - 10, y1: H - 14, y2: H - 14 }));
    svg.append(svgEl("path", { class: "ar", d: "M" + pts[0][0] + "," + (H - 14) + " L" + pts.map((p) => p.join(",")).join(" L") + " L" + pts[pts.length - 1][0] + "," + (H - 14) + " Z" }));
    svg.append(svgEl("path", { class: "ln", d: "M" + pts.map((p) => p.join(",")).join(" L") }));
    svg.append(svgEl("text", { x: 0, y: 14 }, tok(max / 1.08)));
    svg.append(svgEl("text", { x: 50, y: H - 2 }, T("prompt.growth.nth", { n: 1 })));
    svg.append(svgEl("text", { x: W - 70, y: H - 2 }, T("prompt.growth.nth", { n: r.usage.length })));
    nodes.push(el("h4", null, T("prompt.growth.title")), svg);
  }
  body.replaceChildren(...nodes);
  const sec = (title, n, open) => { const d = el("details"); d.open = !!open; const sm = el("summary", null, title); sm.append(el("span", "n", n)); d.append(sm); body.append(d); return d; };
  const colorOf = (x) => isCC(x) ? "--l-system" : hhNote(x) ? "--l-outer" : snapshot(x) ? "--l-side" : x.kind === "compacted" ? "--l-hippo" : "--l-main";
  const s1 = sec(T("prompt.system.title"), T("prompt.system.count", { n: r.system.length, size: tok(sumT(r.system)) }), true);
  r.system.forEach((x) => s1.append(prow("", x.label, preview(x.text), tok(estTok(x.text)), () => openDoc(x.label, T("prompt.system.size", { chars: x.text.length, size: tok(estTok(x.text)) }), x.text), colorOf(x))));
  const s2 = sec(T("prompt.tools.title"), T("prompt.tools.count", { n: r.tools.length, size: tok(groups.find((g) => g.name === T("prompt.group.tools"))?.t || 0) }));
  r.tools.forEach((t) => s2.append(prow("", t.name.replace("mcp__self__", T("prompt.tools.selfPrefix")), preview(t.description), tok(estTok(t.name + t.description + t.schema)), () => openDoc(t.name, T("prompt.tools.docSub"), t.description + "\n\n" + T("prompt.tools.params") + "\n" + t.schema), "--l-perception")));
  const s3 = sec(T("prompt.deferred.title"), T("prompt.deferred.count", { n: r.deferred.length }));
  const byGroup = new Map();
  for (const n of r.deferred) { const g = n.startsWith("mcp__") ? n.split("__")[1] : T("prompt.deferred.builtin"); if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(n.startsWith("mcp__") ? n.split("__").slice(2).join("__") : n); }
  for (const [g, names] of byGroup) { s3.append(el("h4", null, T("prompt.deferred.group", { name: g, n: names.length })), el("div", "names", names.join("  "))); }
  const s4 = sec(T("prompt.attachments.title"), T("prompt.attachments.count", { n: r.attachments.length, size: tok(sumT(r.attachments)) }), true);
  r.attachments.forEach((a) => s4.append(prow(a.ts ? hm(Date.parse(a.ts)).slice(0, 5) : "", ATT[a.type] || a.type, preview(a.text), tok(estTok(a.text)), () => openDoc(ATT[a.type] || a.type, a.role === "system" ? T("prompt.attachments.asSystem", { size: tok(estTok(a.text)) }) : T("prompt.attachments.asUser", { size: tok(estTok(a.text)) }), a.text), "--l-speech")));
  const s5 = sec(T("prompt.messages.title"), T("prompt.messages.count", { n: r.messages.length, size: tok(sumT(r.messages)) }), true);
  r.messages.forEach((m, i) => s5.append(prow(m.ts ? hm(Date.parse(m.ts)) : "", msgLabel(m, i), preview(m.text), tok(estTok(m.text)), () => openDoc(msgLabel(m, i), (m.ts ? dhm(Date.parse(m.ts)) + T("common.comma") : "") + T("prompt.messages.size", { size: tok(estTok(m.text)) }), m.text), msgColor(m), i === 0)));
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putPromptRegion(v) { return promptRegion = v; }
export { loadPrompt, promptRegion, renderPRegions, putPromptRegion };
