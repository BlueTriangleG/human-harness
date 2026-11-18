"use strict";
// ---------- 界面文字 ----------
// 服务端按看的人选的语言，把那一份包放在页面里（#hh-data）。这里只管取字、填空、换语言。
// 字都在 src/console/lang/<语言>/ 里；她的数据不翻。
const HH = JSON.parse(document.getElementById("hh-data").textContent);   // { lang, langs, base, strings, demo, marks, regions, now }
/**
 * 页面上的「现在」。线上就是浏览器的钟。演示库的钟是定死的（数据按那一刻往前排）：服务端把它的「现在」放在 HH.now，
 * 页面记下它和浏览器的钟差多少，以后算「多久以前」「最近一小时」都按服务端那边的钟走，不然傍晚的记录在中午看就成了「还没发生」。
 */
const CLOCK_SKEW = typeof HH.now === "number" ? HH.now - Date.now() : 0;
const clock = () => Date.now() + CLOCK_SKEW;
/** 把一条字里的 {名字} 和 {n|单数|复数} 填上；没给的参数原样留着。同 lang/index.ts 的 fill */
function fillText(text, params) {
  const p = params ? Object.assign({}, HH.base, params) : HH.base;
  return text.replace(/\{(\w+)(?:\|([^|{}]*)\|([^{}]*))?\}/g, (whole, name, one, other) => {
    const v = p[name];
    if (v === undefined) return whole;
    return one === undefined ? String(v) : Number(v) === 1 ? one : other ?? "";
  });
}
/** 取一条字：键是「页.组.条」，要填的写在第二个参数里 */
function T(key, params) {
  const text = HH.strings[key];
  if (text === undefined) { console.warn("console text missing: " + key); return key; }
  return fillText(text, params);
}
/** 换语言：记在 cookie 里（服务端每个请求都看得到），重新载入 */
function setLang(code) {
  if (!HH.langs.includes(code) || code === HH.lang) return;
  document.cookie = "hh_console_lang=" + code + "; Path=/; Max-Age=31536000; SameSite=Lax";
  location.reload();
}
/** 包里某一组下面的每一条：TGroup("regions.tools") → { recall: "…", remember: "…", … }。没有原型：拿数据里的代号去查，碰上 constructor 这种名字也查不到别的东西 */
function TGroup(prefix) {
  const out = Object.create(null), p = prefix + ".";
  for (const k in HH.strings) if (k.startsWith(p) && !k.slice(p.length).includes(".")) out[k.slice(p.length)] = fillText(HH.strings[k]);
  return out;
}
// 演示模式：页面角上标出来（数据是造的，不是她的真实记录）
if (HH.demo) document.getElementById("demo").hidden = false;
// 顶栏最右边的语言切换钮
{
  const box = document.getElementById("langs");
  for (const code of HH.langs) {
    const b = document.createElement("button");
    b.textContent = T("shell.lang." + code);
    b.lang = code;
    b.setAttribute("aria-pressed", String(code === HH.lang));
    b.addEventListener("click", () => setLang(code));
    box.append(b);
  }
}

// ---------- 给别的文件用的 ----------
export { HH, T, TGroup, clock };
