"use strict";
import { HH, T } from "./i18n.js";
import { $, el } from "./core.js";
import { hm } from "./timeline.js";
import { keyBlock } from "./openai.js";
// ---------- 设置：系统权限 ----------
// 一个程序一组，每项一行：哪项权限、为什么要、给了没有。没给的那项有个按钮，在主人的浏览器里打开系统设置的那一页
// （x-apple.systempreferences: 链接，服务端只放这一种），旁边写要加的程序和怎么点；查不了的照检查说的写。这一页不替人点任何东西

/** the role's app's page that asks macOS for each permission, a button each: shown when the role has its app */
function grantsLink() {
  if (!HH.base.grants) return null;
  const a = el("a", "popen pgrants", T("settings.grants"));
  a.href = HH.base.grants;
  return a;
}

async function loadPermissions(fresh) {
  const box = $("#perms");
  if (!box.childElementCount) box.replaceChildren(el("p", "hint", T("settings.loading")));
  const r = await fetch("/api/permissions" + (fresh ? "?fresh=1" : "")).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  const grants = grantsLink();
  if (r.error) { box.replaceChildren(...[el("p", "hint offline", T("settings.failed", { error: r.error })), grants].filter(Boolean)); return; }
  if (!r.configured) { box.replaceChildren(...[el("p", "hint", T("settings.notSet")), grants].filter(Boolean)); return; }
  const again = el("button", "precheck", T("settings.recheck"));
  again.addEventListener("click", () => { again.disabled = true; loadPermissions(true); });
  const head = el("div", "phead");
  head.append(el("p", "hint", T("settings.checked", { time: hm(r.at).slice(0, 5), user: r.user, program: r.program })), ...(grants ? [grants] : []), again);
  const groups = new Map();
  for (const i of r.items) { if (!groups.has(i.program)) groups.set(i.program, []); groups.get(i.program).push(i); }
  const nodes = [head];
  for (const [program, items] of groups) {
    const g = el("section", "pgroup");
    g.append(el("h3", "pprog", program));
    for (const i of items) g.append(row(i));
    nodes.push(g);
  }
  box.replaceChildren(...nodes);
}

function row(i) {
  const r = el("div", "prow " + i.status);
  const name = T("settings.names." + i.permission);
  r.append(el("span", "pstate", T("settings.status." + i.status)), el("b", "pname", name.startsWith("settings.") ? i.name : name), el("p", "pwhy", i.why));
  if (i.status === "missing") {
    const fix = el("div", "pfix");
    if (i.link) { const a = el("a", "popen", T("settings.open")); a.href = i.link; fix.append(a); }
    const path = el("p", "ppath", T("settings.add"));
    path.append(el("code", null, i.program));
    const copy = el("button", "pcopy", T("settings.copy"));
    copy.addEventListener("click", () => navigator.clipboard.writeText(i.program).then(() => { copy.textContent = T("settings.copied"); }, () => undefined));
    path.append(copy);
    fix.append(path, el("p", "hint", T("settings.how")));
    r.append(fix);
  } else if (i.note || (i.status === "unknown" && i.link)) {
    const n = el("p", "pextra", i.note);
    if (i.status === "unknown" && i.link) { const a = el("a", null, T("settings.look")); a.href = i.link; n.append(" ", a); }
    r.append(n);
  }
  return r;
}

// ---------- Settings → memory and learning: the role's OpenAI key (web/js/openai.js, routes/openai.ts) ----------
// The writes go as a tell does: JSON, this origin, x-hh-console (the owner's token is added by owner.js). An answer is
// handed back as it came, error or not: the block says what it found
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-hh-console": "1" }, body: JSON.stringify(body) })
  .then((r) => r.json().catch(() => ({ error: `HTTP ${r.status}` })));
const readKey = () => fetch("/api/openai").then((r) => (r.ok ? r.json() : null)).catch(() => null);

/** no key: a dot on the Settings button, and its title says why; a console without the block (an older role): nothing */
function keyHint(s) {
  const b = document.querySelector('#nav button[data-page="settings"]');
  if (!b) return;
  const off = !!s && !s.set;
  b.classList.toggle("keyhint", off);
  if (off) b.title = T("openai.hint"); else b.removeAttribute("title");
}

async function loadKey() {
  const s = await readKey();
  $("#okeyhead").hidden = $("#okey").hidden = !s;
  keyHint(s);
  if (!s) return;
  $("#okey").replaceChildren(keyBlock({
    T, status: () => fetch("/api/openai").then((r) => r.json()), onStatus: keyHint,
    check: (key) => post("/api/openai/check", key ? { key } : {}), save: (key) => post("/api/openai/key", { key }), remove: () => post("/api/openai/remove", {}),
  }));
}

function loadSettings() { loadKey(); loadPermissions(false); }

// ---------- 给别的文件用的 ----------
export { loadPermissions, loadSettings, keyHint, readKey };
