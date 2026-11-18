"use strict";
import { T, TGroup } from "./i18n.js";
import { $, el } from "./core.js";
import { md, tab, updateHash } from "./memory.js";
// ---------- 顺不顺：每次上线之后的那几段、按小时的数（只读；只有数和上线记录，不显示被拦下的内容） ----------
let healthSeq = 0;
/** 这一页的两个视图：day = 最近 24 小时（每次上线之后、按小时）；week = 这一周的五个数 */
let healthView = "day";
const hnum = (n) => n.toLocaleString(T("common.locale"));
const hsec = (ms) => (ms / 1000).toFixed(1);
/** 时刻都按她的时区显示（小时表的几点是服务端按她的时区切的，这里要对得上） */
const htime = (ts, tz) => new Date(ts).toLocaleTimeString(T("common.locale"), { hourCycle: "h23", hour: "2-digit", minute: "2-digit", timeZone: tz });
const hday = (ts, tz) => new Date(ts).toLocaleDateString("en-CA", { timeZone: tz });   // YYYY-MM-DD
const hmd = (day) => md(new Date(day + "T12:00:00").getTime());
/** 一段有多长：几小时几分 */
const hdur = (ms) => { const min = Math.max(1, Math.round(ms / 60_000)), h = Math.floor(min / 60), m = min % 60; return h ? T("health.duration.hm", { h, m }) : T("health.duration.m", { m }); };
/** 一段里请求不到这么多个，出事率旁边标「样本小」：一两次出事就能把比例拉得很高（运维 11-14） */
const SMALL_SAMPLE = 30;

/** 一行的数：请求数和它里面出事的那一截、被停 / 被拒、出事率、卡住 */
function healthCells(h, max, small) {
  const bad = h.stops + h.refusals;
  const req = el("div", "hreq");
  const bar = el("div", "hbar");
  const fill = el("b");
  fill.style.width = (max ? h.requests / max * 100 : 0) + "%";
  if (bad && h.requests) { const red = el("i"); red.style.width = Math.min(100, bad / h.requests * 100) + "%"; fill.append(red); }
  bar.append(fill);
  req.append(el("span", "num", hnum(h.requests)), bar);
  const inc = el("div", "hinc" + (bad ? " bad" : ""), bad ? T("health.incidents", { stops: h.stops, refusals: h.refusals }) : T("common.dash"));
  const rate = el("div", "hrate" + (bad ? " bad" : ""), bad && h.requests ? T("health.rate", { pct: (bad / h.requests * 100).toFixed(1) }) : "");
  if (small && bad && h.requests && h.requests < SMALL_SAMPLE) { const tag = el("span", "hsmall", T("health.smallSample")); tag.title = T("health.smallSampleTitle", { n: SMALL_SAMPLE }); rate.append(tag); }
  const blk = el("div", "hblk" + (h.blocks ? " slow" : ""), h.blocks ? T("health.blocked", { seconds: hsec(h.blockedMs), n: h.blocks, longest: hsec(h.longestMs) }) : T("common.dash"));
  return [req, inc, rate, blk];
}
function healthRow(label, h, max, cls, small) {
  const row = el("div", "hrow" + (cls ? " " + cls : ""));
  row.append(el("div", "ht", label), ...healthCells(h, max, small));
  return row;
}
function healthHead(first, wide) {
  const head = el("div", "hrow hhead" + (wide ? " hwide" : ""));
  for (const [text, title] of [[first, ""], [T("health.head.requests"), T("health.title.requests")], [T("health.head.incidents"), T("health.title.incidents")], [T("health.head.rate"), T("health.title.rate")], [T("health.head.blocked"), T("health.title.blocked")]]) {
    const c = el("div", null, text);
    if (title) c.title = title;
    head.append(c);
  }
  return head;
}

/** 一次部署 / 退回：留痕里那一行说明，点开是每个提交怎么放行的（都是留痕里的原样，不翻） */
function healthChange(c, tz, today) {
  const d = el("details", "hchange");
  const day = hday(c.at, tz);
  const when = (day === today ? "" : hmd(day) + " ") + htime(c.at, tz);
  d.append(el("summary", null, T("health.change", { when, by: c.by || T("common.dash"), text: c.text })));
  if (!c.items.length) d.append(el("p", "hint", T("health.noItems")));
  for (const it of c.items) d.append(el("p", "hitem", it));
  return d;
}

/** 每次上线之后：新的在上面。一段 = hhd 起来一次到下一次起来 */
function healthStretches(r, today) {
  const tz = r.tz, list = r.stretches || [];
  const nodes = [el("h3", null, T("health.stretch.title")), el("p", "hint", T("health.stretch.hint"))];
  if ((r.pending && r.pending.length) || r.configPending) {
    const p = el("div", "hpending");
    if (r.pending && r.pending.length) p.append(el("p", "hint", T("health.stretch.pending", { n: r.pending.length })), ...r.pending.map((c) => healthChange(c, tz, today)));
    if (r.configPending) p.append(el("p", "hint", T("health.stretch.configPending")));
    nodes.push(p);
  }
  const max = Math.max(0, ...list.map((s) => s.requests));
  nodes.push(healthHead(T("health.head.stretch"), true));
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const day = hday(s.from, tz);
    const from = (day === today ? "" : hmd(day) + " ") + htime(s.from, tz);
    const span = i === list.length - 1 ? T("health.stretch.since", { from }) : T("health.stretch.range", { from, to: htime(s.to, tz) });
    const box = el("div", "hstretch");
    box.append(healthRow(T("health.stretch.lasted", { label: span, duration: hdur(s.to - s.from) }), s, max, i === list.length - 1 ? "hnow" : "", true));
    if (s.versions && s.versions.length) box.append(el("p", "hint", T("health.stretch.versions", { list: s.versions.join(T("common.listSep")) })));
    if (s.configChanged) box.append(el("p", "hint hconfig", T("health.stretch.configChanged")));
    const carried = s.bootAt === null || s.bootAt < s.from;
    if (s.changes.length) {
      if (carried) box.append(el("p", "hint", T("health.stretch.carried")));
      box.append(...s.changes.map((c) => healthChange(c, tz, today)));
    } else box.append(el("p", "hint", s.bootAt === null ? T("health.stretch.unknown") : carried ? T("health.stretch.carriedPlain") : T("health.stretch.restartOnly")));
    nodes.push(box);
  }
  return nodes;
}

/** 按小时：新的在上面，换了一天插一行日子。最上面那个小时还没过完 */
function healthHours(r) {
  const hours = r.hours;
  const sum = { requests: 0, stops: 0, refusals: 0, blocks: 0, blockedMs: 0, longestMs: 0 };
  for (const h of hours) {
    sum.requests += h.requests; sum.stops += h.stops; sum.refusals += h.refusals;
    sum.blocks += h.blocks; sum.blockedMs += h.blockedMs; sum.longestMs = Math.max(sum.longestMs, h.longestMs);
  }
  const max = Math.max(0, ...hours.map((h) => h.requests));
  const nodes = [el("h3", null, T("health.hours.title")), healthHead(T("health.head.hour")), healthRow(T("health.total", { n: hours.length - 1 }), sum, sum.requests, "htotal")];
  let day = "";
  for (let i = hours.length - 1; i >= 0; i--) {
    const h = hours[i];
    if (h.day !== day) { day = h.day; nodes.push(el("div", "hday", hmd(h.day))); }
    const row = healthRow(String(h.hour).padStart(2, "0") + ":00", h, max, i === hours.length - 1 ? "hnow" : "");
    if (i === hours.length - 1) row.querySelector(".ht").append(el("span", "hrun", T("health.running")));   // 窄屏上不显示这几个字，颜色已经标出来了
    nodes.push(row);
  }
  return nodes;
}

// ---------- 这一周：五个数一天一行（口径在 src/metrics/numbers.ts；用量当量在后台读会话记录，没读完先空着） ----------
const WCAUSE = TGroup("health.week.cause");
const WDEST = TGroup("health.week.dest");
/** 用量按去向分的那几类，照这个次序列；服务端没给的（旧版本没有「团队」）当 0 */
const WDESTS = ["hh", "helpers", "team", "replay", "other"];
const wsum = (rows, f) => rows.reduce((n, r) => n + f(r), 0);
/** 几行合成一行的数（合计、前七天） */
function weekTotal(rows) {
  const quota = rows.some((r) => r.quotaPct !== null) ? wsum(rows, (r) => r.quotaPct || 0) : null;
  const usage = {};
  for (const k of WDESTS) usage[k] = wsum(rows, (r) => r.usage[k] || 0);
  const causes = {};
  for (const r of rows) for (const [k, n] of Object.entries(r.wakeCauses || {})) causes[k] = (causes[k] || 0) + n;
  return {
    recur: wsum(rows, (r) => r.recur), corrections: wsum(rows, (r) => r.corrections), opened: wsum(rows, (r) => r.opened), mounted: wsum(rows, (r) => r.mounted),
    wakes: wsum(rows, (r) => r.wakes), wakeCauses: rows.some((r) => r.wakeCauses) ? causes : null, quotaPct: quota, usage,
  };
}
function weekRow(label, r, o) {
  const row = el("div", "wrow" + (o.cls ? " " + o.cls : ""));
  const cell = (cls, text, head) => { const c = el("div", cls, text); c.dataset.label = T("health.week.head." + head); return c; };
  const day = el("div", "wday", label);
  // 当天的又犯要等夜里整理才记：不当 0 显示
  const recur = cell(null, o.today ? T("common.dash") : hnum(r.recur), "recur");
  if (o.today) recur.title = T("health.week.recurToday");
  const open = cell(null, r.mounted ? T("health.week.openRate", { pct: Math.round(r.opened / r.mounted * 100), opened: r.opened, mounted: r.mounted }) : T("common.dash"), "openRate");
  const wakes = cell("wwake", hnum(r.wakes), "wakes");
  if (r.wakeCauses) {
    const top = Object.entries(r.wakeCauses).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => (WCAUSE[k.replace(/-(.)/g, (_, c) => c.toUpperCase())] || k) + " " + n);
    if (top.length) wakes.append(el("small", null, top.join(T("common.listSep"))));
  } else if (r.wakes) wakes.title = T("health.week.wakesNoCause");
  const quota = cell(null, r.quotaPct === null ? T("common.dash") : T("health.week.quota", { pct: Math.round(r.quotaPct) }), "quota");
  const use = cell("wuse", "", "usage");
  if (!o.usageReady) use.textContent = T("health.week.usageReading");
  else {
    const total = WDESTS.reduce((n, k) => n + (r.usage[k] || 0), 0);
    use.append(total.toFixed(1));
    // 这一行里有归档走、现在读不到的日子：这个数只会比真的少，标出来，别让人当成真的少
    if (o.partial) { const tag = el("span", "wpart", T("health.week.usagePartial")); tag.title = T("health.week.usagePartialTitle"); use.append(tag); }
    use.append(el("small", null, WDESTS.filter((k) => (r.usage[k] || 0) >= 0.05).map((k) => WDEST[k] + " " + r.usage[k].toFixed(1)).join(T("common.listSep"))));
  }
  row.append(day, recur, cell(null, hnum(r.corrections), "corrections"), open, wakes, quota, use);
  return row;
}
async function loadWeek() {
  const seq = ++healthSeq;
  const box = $("#hbody");
  const r = await fetch("/api/numbers").then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (seq !== healthSeq || tab !== "health" || healthView !== "week") return;
  if (r.error) { box.replaceChildren(el("p", "hint", T("health.failed", { error: r.error }))); return; }
  const head = el("div", "wrow whead");
  for (const k of ["day", "recur", "corrections", "openRate", "wakes", "quota", "usage"]) head.append(el("div", null, T("health.week.head." + k)));
  const nodes = [el("h3", null, T("health.week.title")), el("p", "hint", T("health.week.hint", { tz: r.tz })), head];
  const o = { usageReady: r.usage.ready };
  const unread = r.usage.ready ? r.usage.unread : null;
  const partial = (rows) => !!unread && rows.some((d) => d.day <= unread.upTo);
  for (let i = r.days.length - 1; i >= 0; i--) {
    const d = r.days[i];
    nodes.push(weekRow(hmd(d.day), d, { ...o, partial: partial([d]), today: d.day === r.today, cls: d.day === r.today ? "wtoday" : "" }));
  }
  nodes.push(weekRow(T("health.week.total", { n: r.days.length }), weekTotal(r.days), { ...o, partial: partial(r.days), cls: "wtotal" }));
  if (r.prev.length) nodes.push(weekRow(T("health.week.prev", { n: r.prev.length }), weekTotal(r.prev), { ...o, partial: partial(r.prev), cls: "wprev" }));
  if (unread) nodes.push(el("p", "hint wwarn", T("health.week.usageUnread", { n: unread.links, day: hmd(unread.upTo) })));
  if (!r.usage.ready) nodes.push(el("p", "hint", r.usage.reading ? T("health.week.usageProgress", { files: hnum(r.usage.reading.files), mb: hnum(Math.round(r.usage.reading.readBytes / 1048576)) }) : T("health.week.usageWaiting")));
  const notes = el("ul", "wnotes");
  for (const k of ["recur", "corrections", "openRate", "wakes", "quota", "usage"]) notes.append(el("li", null, T("health.week.note." + k)));
  nodes.push(notes);
  box.replaceChildren(...nodes);
  // 用量还在读：过一会儿自己再问一次
  if (!r.usage.ready) setTimeout(() => { if (tab === "health" && healthView === "week" && seq === healthSeq) loadWeek(); }, 5000);
}

function setHealthView(v) {
  healthView = v === "week" ? "week" : "day";
  for (const b of document.querySelectorAll("#hviews button")) b.setAttribute("aria-pressed", String(b.dataset.hview === healthView));
  $("#hbody").replaceChildren(el("p", "hint", T("common.loading")));
  updateHash();
  loadHealth();
}
for (const b of document.querySelectorAll("#hviews button")) b.addEventListener("click", () => setHealthView(b.dataset.hview));

async function loadHealth() {
  if (healthView === "week") return loadWeek();
  const seq = ++healthSeq;
  const box = $("#hbody");
  // 点开着的那几条上线记录，重画以后还开着（按它那一行的字认）
  const open = new Set([...box.querySelectorAll("details.hchange[open] > summary")].map((s) => s.textContent));
  const r = await fetch("/api/incidents").then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (seq !== healthSeq || tab !== "health" || healthView !== "day") return;
  if (r.error) { box.replaceChildren(el("p", "hint", T("health.failed", { error: r.error }))); return; }
  const today = hday(r.at, r.tz);
  box.replaceChildren(
    ...healthStretches(r, today), ...healthHours(r),
    el("p", "hint", T("health.computed", { time: htime(r.at, r.tz), kb: hnum(Math.round(r.readBytes / 1024)), ms: hnum(r.tookMs) })),
  );
  for (const d of box.querySelectorAll("details.hchange")) if (open.has(d.querySelector("summary").textContent)) d.open = true;
}

// ---------- 给别的文件用的 ----------
// 别的文件要改这里的变量，经这几个函数：模块里的变量只有声明它的文件能赋值。返回存进去的值
function putHealthView(v) { return healthView = v; }
export { healthView, loadHealth, putHealthView };
