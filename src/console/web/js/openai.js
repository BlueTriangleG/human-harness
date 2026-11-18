"use strict";
// Settings → memory and learning, and the wizard's step for it: the role's OpenAI key, one block on both pages (the
// wizard's server serves this same file). The page hands in its words (T, keys under "openai.") and how to reach its
// server. A key typed in is sent only to be checked or kept; no answer carries any of it back, and once kept the field
// is emptied and the page says only that a key is set.
//
// keyBlock({ T, check, save, remove, status }): the console's settings — status() is GET /api/openai, check(key) and
//   save(key) its writes (check("") checks the kept key), remove() takes it away.
// keyBlock({ T, check, onKey, skip, kept, skipped }): the wizard — check(key) only checks; a usable key goes to
//   onKey(key) for the role to be made with, a changed one to onKey(null); skip() moves on without one.

const el = (tag, cls, text) => { const x = document.createElement(tag); if (cls) x.className = cls; if (text != null) x.textContent = text; return x; };
const usd = (n) => `$${Number(n).toFixed(2)}`;

export function keyBlock(o) {
  const { T } = o;
  const box = el("div", "okey");
  const now = el("dl", "okey-now");
  const input = el("input", "okey-input"); input.type = "password"; input.autocomplete = "off"; input.spellcheck = false;
  input.placeholder = o.kept ? "••••••••" : "sk-…"; input.setAttribute("aria-label", T("openai.inputLabel"));
  const checkBtn = el("button", null, T("openai.check")); checkBtn.type = "button";
  const row = el("div", "okey-row"); row.append(input, checkBtn);
  const result = el("div", "okey-result"); result.setAttribute("aria-live", "polite");
  const after = el("div", "okey-after");
  box.append(el("p", "okey-lead", T("openai.lead")));
  if (o.status) box.append(now);
  box.append(row, el("p", "hint", T("openai.checkCost")), result, after,
    el("p", "hint", o.status ? T("openai.money", { limit: usd(1) }) : T("openai.moneyNoLimit")), el("p", "hint", T("openai.where")));
  const money = box.lastChild.previousSibling;

  /** what the check found, one line each, and what it means */
  const show = (c) => {
    const list = el("ul", "okey-items");
    for (const [k, label] of [["key", T("openai.items.key")], ["embeddings", T("openai.items.embeddings")], ["decisions", T("openai.items.decisions")]]) {
      const li = el("li", c[k] === "ok" ? "ok" : c[k] === "skipped" ? "skip" : "bad");
      li.append(el("b", null, label), " ", T("openai.result." + c[k]));
      list.append(li);
    }
    const verdict = !c.usable ? T("openai.verdictNo") : c.decisions === "ok" ? T("openai.verdictFull") : T("openai.verdictPart");
    result.replaceChildren(list, el("p", c.usable ? "okey-verdict" : "okey-verdict bad", verdict));
  };
  const say = (text, bad) => { after.replaceChildren(el("p", bad ? "status bad" : "status", text)); };
  const busy = (on, btn, label) => { checkBtn.disabled = on; if (saveBtn) saveBtn.disabled = on; btn.textContent = on ? T("openai.checking") : label; };

  // ---- the console: what it runs with now, keep a key, take it away ----
  let saveBtn = null, polling = 0;
  const paint = (s) => {
    const line = (k, v) => now.append(el("dt", null, k), el("dd", null, v));
    now.replaceChildren();
    line(T("openai.now.search"), s.mode === "meaning" ? T("openai.mode.meaning") : s.mode === "words" ? T("openai.mode.words") : T("openai.mode.off"));
    line(T("openai.now.key"), (s.set ? T("openai.set") : T("openai.notSet")) + (s.pending ? ` · ${T("openai.pending")}` : ""));
    if (s.spend) {
      line(T("openai.now.judging"), T("openai.spend", { usd: usd(s.spend.usd), limit: usd(s.spend.limit) }));
      money.textContent = T("openai.money", { limit: usd(s.spend.limit) });
    }
    if (s.vectors && s.vectors.have != null) line(T("openai.now.vectors"), s.vectors.missing ? T("openai.vectors", { have: s.vectors.have, missing: s.vectors.missing }) : T("openai.vectorsDone", { have: s.vectors.have }));
    removeBtn.hidden = !s.set;
    o.onStatus?.(s);
  };
  const removeBtn = el("button", "okey-remove", T("openai.remove")); removeBtn.type = "button"; removeBtn.hidden = true;
  const refresh = async () => { try { const s = await o.status(); paint(s); return s; } catch (e) { say(String(e.message || e), true); return null; } };
  /** after a key is kept or taken away: read again every few seconds until hhd has taken it up */
  const follow = () => {
    clearTimeout(polling);
    let n = 0;
    const tick = async () => {
      const s = await refresh();
      if (s && s.pending && ++n < 45) { polling = setTimeout(tick, 4000); return; }
      // taken up: say so, so nobody thinks the key was not kept
      if (s && s.set && s.mode === "meaning") say(T("openai.live"));
    };
    polling = setTimeout(tick, 1500);
  };
  if (o.status) {
    saveBtn = el("button", "primary", T("openai.save")); saveBtn.type = "button";
    row.append(saveBtn);
    box.append(removeBtn);
    saveBtn.addEventListener("click", async () => {
      const key = input.value.trim();
      if (!key) return;
      busy(true, saveBtn, T("openai.save"));
      try {
        const r = await o.save(key);
        if (r.error && r.saved === undefined) { say(r.error, true); return; }
        show(r);
        if (r.saved) { input.value = ""; say(T("openai.saved")); follow(); }
      } catch (e) { say(String(e.message || e), true); }
      finally { busy(false, saveBtn, T("openai.save")); }
    });
    let sure = false;
    removeBtn.addEventListener("click", async () => {
      if (!sure) { sure = true; removeBtn.textContent = T("openai.removeSure"); return; }
      sure = false; removeBtn.textContent = T("openai.remove"); removeBtn.disabled = true;
      try { await o.remove(); result.replaceChildren(); say(T("openai.removed")); follow(); }
      catch (e) { say(String(e.message || e), true); }
      finally { removeBtn.disabled = false; }
    });
    refresh();
  }

  // ---- both: check the key typed (the console: the kept one when nothing is typed) ----
  checkBtn.addEventListener("click", async () => {
    const key = input.value.trim();
    if (!key && !o.status) return;
    busy(true, checkBtn, T("openai.check"));
    after.replaceChildren();
    try {
      const r = await o.check(key);
      if (r.error && r.usable === undefined) { say(r.error, true); return; }
      show(r);
      if (o.onKey) { o.onKey(r.usable ? key : null); if (r.usable) say(T("openai.kept")); }
    } catch (e) { say(String(e.message || e), true); }
    finally { busy(false, checkBtn, T("openai.check")); }
  });

  // ---- the wizard: a key typed after a check is not the key checked; or go on without one ----
  if (o.onKey) {
    input.addEventListener("input", () => { o.onKey(null); result.replaceChildren(); after.replaceChildren(); });
    if (o.kept) say(T("openai.kept"));
    else if (o.skipped) say(T("openai.skipped"));
  }
  if (o.skip) {
    const skip = el("button", "link", T("openai.skip")); skip.type = "button";
    skip.addEventListener("click", () => o.skip());
    row.append(skip);
  }
  return box;
}
