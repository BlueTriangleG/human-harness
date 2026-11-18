// Create your Human: eight steps, one a screen, each with a default so Next all the way works. Talks only to the server
// that ./setup (hh setup --wizard) started: its one-time token comes in the address after #, and goes in a header on
// every request (never a cookie). The words come from strings.json in the language picked on the first step.
import { keyBlock } from "/web/js/openai.js";   // the console's settings use the same block

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

const token = (() => {
  let t = location.hash.slice(1);
  try { if (t) sessionStorage.setItem("hh_wizard", t); else t = sessionStorage.getItem("hh_wizard") || ""; } catch { /* no storage: this load only */ }
  history.replaceState(null, "", location.pathname);
  return t;
})();

class Expired extends Error {}
async function api(path, body) {
  let r;
  try {
    r = await fetch(path, { method: body ? "POST" : "GET", headers: { "X-HH-Wizard": token, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error(S ? T("errors.network") : "The wizard's service is not answering. Is the terminal running ./setup still open?"); }
  if (r.status === 403 || r.status === 410) throw new Expired(S ? T("errors.expired") : "This page has expired. Run ./setup again in the terminal.");
  let j = null;
  try { j = await r.json(); } catch { /* not JSON */ }
  // a POST's own error (draft, create) is the caller's to show; anything else that failed is thrown
  if (r.ok && j) return j;
  if (body && j?.error) return j;
  throw new Error(j?.error ?? `${path}: HTTP ${r.status}`);
}

let S = null;   // the words, in the language picked
const T = (path, vars = {}) => String(path.split(".").reduce((o, k) => o?.[k], S) ?? path).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

const STEPS = ["welcome", "you", "human", "persona", "modules", "tier", "memory", "grants", "meet"];
const st = {
  step: 0, lang: "en", owner: "", timezone: "", name: "", id: "", initial: "", color: "", pronouns: "", avatar: null,
  relation: "", preset: "", notes: "", files: null, from: "", edited: false, modules: {}, tier: "standard", made: null, making: false,
  login: null, openaiKey: null, openaiSkipped: false,
  named: false,   // the owner has typed a name: the suggested one is gone
};
/** no Claude login yet: nothing to think with, so the wizard goes no further than the usage step */
const noLogin = () => (D?.login?.kind ?? "none") === "none";
/** the card for the login found: its own card, the subscription when there is none yet, no card for another kind */
const cardOf = (kind) => kind === "console" ? "console" : kind === "other" ? "" : "subscription";
/** the login found, as a few words in a sentence */
function loginWords(login) {
  return login.kind === "subscription" ? T("tier.withSubscription", { plan: login.plan ? T("tier.plan", { plan: login.plan }) : "" })
    : login.kind === "console" ? T("tier.withConsole") : T("tier.withOther");
}
let D = null;   // the server's defaults

async function loadWords(lang) {
  S = await api(`/wizard/strings.json?lang=${encodeURIComponent(lang)}`);
  document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  document.title = T("title");
}

/** the id, first letter and colour for a name, as the app's icon will have them */
let idTimer = 0;
function nameChanged() {
  clearTimeout(idTimer);
  idTimer = setTimeout(async () => {
    const name = st.name.trim();
    if (!name) { st.id = ""; st.initial = ""; card(); idLine(); return; }
    const r = await api(`/api/wizard/id?name=${encodeURIComponent(name)}`).catch(() => null);
    if (r && name === st.name.trim()) { st.id = r.id || ""; st.initial = r.initial || [...name][0]; st.color = r.color || st.color; card(); idLine(); }
  }, 200);
  st.initial = [...st.name.trim()][0]?.toUpperCase() || "";
  st.id = "";   // until the server names it: never the id of the name before
  card(); idLine();
}

function card() {
  // before the name step the card has no name and no letter: the suggested name is only a suggestion, not a Human already there
  const before = st.step < STEPS.indexOf("human");
  const name = before ? "" : st.name.trim();
  $("cname").textContent = name || (before ? T("cardBefore") : T("cardEmpty"));
  $("cname").classList.toggle("empty", !name);
  $("initial").textContent = before ? "" : st.initial || "?";
  $("face").style.background = before ? "" : st.color || "";
  $("face").classList.toggle("blank", before);
  $("photo").hidden = !st.avatar;
  if (st.avatar) $("photo").src = st.avatar;
  $("cpron").textContent = st.pronouns.trim();
  $("crel").textContent = st.relation.trim() ? T("cardRelation", { relation: st.relation.trim() }) : "";
  const chips = $("cchips"); chips.replaceChildren();
  const preset = D?.presets?.find((p) => p.key === st.preset);
  if (preset && st.step >= 3) chips.append(el("span", null, preset.title));
  if (st.step >= 5) chips.append(el("span", null, T("tier." + st.tier)));
}

function idLine() { const p = document.getElementById("idline"); if (p) p.textContent = st.id ? T("human.id", { id: st.id }) : ""; }

/** one labelled field */
function field(label, input, hint, tag = "label") {
  const l = el(tag, "field"); l.append(el("span", null, label), input);
  if (hint) l.append(el("p", "hint", hint));
  return l;
}
function text(value, onInput, placeholder = "") {
  const i = el("input"); i.type = "text"; i.value = value; i.placeholder = placeholder;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}
function choices(name, items, picked, onPick, two = false) {
  const f = el("fieldset", "choices" + (two ? " two" : ""));
  for (const it of items) {
    const l = el("label", "choice"), r = el("input"); r.type = "radio"; r.name = name; r.value = it.key; r.checked = it.key === picked;
    r.addEventListener("change", () => onPick(it.key));
    l.append(r, el("b", null, it.title)); if (it.about) l.append(el("small", null, it.about));
    f.append(l);
  }
  return f;
}

const screens = {
  welcome(f) {
    f.append(el("h2", null, T("welcome.title")), el("p", "lead", T("welcome.lead")));
    const lab = el("p", null); lab.append(el("b", null, T("welcome.lang"))); f.append(lab);
    f.append(choices("lang", [{ key: "en", title: "English" }, { key: "zh", title: "中文" }], st.lang, async (v) => {
      st.lang = v;
      if (st.from === "card" && !st.edited) st.files = null;
      try { await loadWords(v); await refreshLists(); render(); } catch (e) { f.append(el("p", "status bad", e.message)); }
    }, true));
    f.append(el("p", "hint", T("welcome.langHint")));
  },
  you(f) {
    f.append(el("h2", null, T("you.title")), el("p", "lead", T("you.lead")));
    // where the name offered came from, so it is not taken for one the page knows; empty, what stands in
    f.append(field(T("you.owner"), text(st.owner, (v) => { st.owner = v; }), D.owner ? T("you.ownerFrom") : T("you.ownerEmpty", { user: D.user || "" })));
    const zones = el("select");
    const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [st.timezone];
    for (const z of all.includes(st.timezone) ? all : [st.timezone, ...all]) { const o = el("option", null, z.replaceAll("_", " ")); o.value = z; o.selected = z === st.timezone; zones.append(o); }
    zones.addEventListener("change", () => { st.timezone = zones.value; });
    f.append(field(T("you.timezone"), zones, T("you.timezoneHint")));
  },
  human(f) {
    // what it is to you starts as the default (an assistant), in the language picked by now
    if (!st.relation.trim()) { st.relation = T("human.relationDefault"); card(); }
    f.append(el("h2", null, T("human.title")));
    // the name is filled with a suggestion, said so and selected: typing replaces it
    const suggested = el("p", "hint", T("human.suggested"));
    const name = text(st.name, (v) => { st.name = v; st.named = true; suggested.hidden = true; nameChanged(); });
    const suggest = el("button", null, T("human.suggest")); suggest.type = "button";
    suggest.addEventListener("click", () => {
      const pool = T("human.names").split(",").filter((n) => n !== st.name);
      st.name = pool[Math.floor(Math.random() * pool.length)]; name.value = st.name; st.named = false; suggested.hidden = false; nameChanged();
    });
    suggested.hidden = st.named;
    if (!st.named) queueMicrotask(() => name.select());
    const row = el("div", "row"); row.append(name, suggest);
    const nf = field(T("human.name"), row); nf.append(suggested, el("p", "hint")); nf.lastChild.id = "idline";
    f.append(nf);
    f.append(field(T("human.pronouns"), text(st.pronouns, (v) => { st.pronouns = v; card(); }, T("human.pronounsPlaceholder"))));
    const file = el("input"); file.type = "file"; file.accept = "image/png,image/jpeg"; file.hidden = true;
    const up = el("button", null, T("human.upload")); up.type = "button"; up.addEventListener("click", () => file.click());
    const auto = el("button", "link", T("human.auto")); auto.type = "button"; auto.hidden = !st.avatar;
    auto.addEventListener("click", () => { st.avatar = null; auto.hidden = true; card(); });
    file.addEventListener("change", async () => { const f0 = file.files?.[0]; if (!f0) return; st.avatar = await square(f0); auto.hidden = false; card(); });
    const arow = el("div", "row"); arow.append(up, auto, file);
    f.append(field(T("human.avatar"), arow, T("human.avatarHint"), "div"));
    f.append(field(T("human.relation"), text(st.relation, (v) => { st.relation = v; card(); }, T("human.relationPlaceholder"))));
    idLine();
  },
  persona(f) {
    f.append(el("h2", null, T("persona.title")), el("p", "lead", T("persona.lead")));
    // files made from the card alone follow the card; written by AI or edited by hand, they stay until written again
    const changed = () => {
      if (!st.files) return;
      if (st.from === "card" && !st.edited) { st.files = null; showFiles(); status.textContent = ""; return; }
      status.className = "status"; status.textContent = T("persona.stale");
    };
    f.append(choices("preset", D.presets, st.preset, (v) => { st.preset = v; changed(); card(); }));
    const notes = el("textarea"); notes.value = st.notes; notes.placeholder = T("persona.notesPlaceholder");
    notes.addEventListener("input", () => { st.notes = notes.value; changed(); });
    f.append(field(T("persona.notes"), notes));
    const draft = el("button", "primary", T("persona.draft")); draft.type = "button";
    const preview = el("button", null, T("persona.preview")); preview.type = "button";
    const row = el("div", "row"); row.append(draft, preview);
    const status = el("p", "status");
    f.append(row, el("p", "hint cost", T("persona.draftCost")), status, el("div", "files"));
    if (st.files) status.textContent = T("persona.previewHint");
    draft.addEventListener("click", async () => {
      draft.disabled = preview.disabled = true; status.className = "status"; status.textContent = T("persona.drafting");
      try {
        const r = await api("/api/wizard/draft-persona", personaAsk());
        if (r.error) { status.className = "status bad"; status.textContent = T("persona.draftFailed", { error: r.error }); draft.textContent = T("retry"); }
        else { st.files = r.files; st.from = "ai"; st.edited = false; status.textContent = T("persona.previewHint"); draft.textContent = T("persona.draft"); showFiles(true); }
      } catch (e) { status.className = "status bad"; status.textContent = e.message; }
      draft.disabled = preview.disabled = false;
    });
    preview.addEventListener("click", async () => {
      try {
        if (!st.files) { st.files = (await api("/api/wizard/persona", personaAsk())).files ?? null; st.from = "card"; st.edited = false; }
        status.className = "status"; status.textContent = T("persona.previewHint"); showFiles(true);
      } catch (e) { status.className = "status bad"; status.textContent = e.message; }
    });
    showFiles();
  },
  modules(f) {
    f.append(el("h2", null, T("modules.title")), el("p", "lead", T("modules.lead")));
    const ul = el("ul", "mods");
    for (const m of D.modules) {
      const li = el("li"); li.append(el("b", null, m.title), el("small", null, m.ready ? m.about : `${m.about} ${m.how ?? ""}`.trim()));
      if (m.ready) {
        const sw = el("input", "switch"); sw.type = "checkbox"; sw.checked = st.modules[m.name]; sw.setAttribute("aria-label", m.title);
        sw.addEventListener("change", () => { st.modules[m.name] = sw.checked; });
        const s = el("span", "state"); s.append(sw); li.append(s);
      } else li.append(el("span", "state", T("modules.later")));
      ul.append(li);
    }
    f.append(ul);
  },
  tier(f) {
    // the login Claude Code has, as the server asked it (the kind only); HH never handles it, it says how /login changes it
    const login = D.login ?? { kind: "none" }, found = login.kind;
    const lead = found === "subscription" ? T("tier.foundSubscription", { plan: login.plan ? T("tier.plan", { plan: login.plan }) : "" })
      : found === "console" ? T("tier.foundConsole")
      : found === "other" ? T("tier.foundOther")
      : T("tier.foundNone");
    f.append(el("h2", null, T("tier.title")), el("p", found === "none" ? "lead bad" : "lead", lead), el("h3", null, T("tier.login")));
    const logins = [{ key: "subscription", title: T("tier.subscription"), about: T("tier.subscriptionAbout") }, { key: "console", title: T("tier.console"), about: T("tier.consoleAbout") }];
    // the card picked is the login found until the owner picks the other one: only then the steps to switch
    st.login ??= cardOf(found);
    const how = el("div", "how");
    // failed: the sign-in came back without a login; its command, for the owner to run in a terminal
    const showHow = (failed) => {
      how.hidden = st.login === found;
      const check = el("button", "check", T("tier.check")); check.type = "button";
      const status = el("span", "status");
      check.addEventListener("click", async () => {
        check.disabled = true; status.className = "status"; status.textContent = T("tier.checking");
        try {
          D.login = await api("/api/wizard/login"); st.login = null; render();
          // still not the login picked: say it was asked again, and stay on the button
          const again = document.querySelector("#step .how:not([hidden])");
          if (again) { again.querySelector(".status").textContent = T("tier.checked"); again.querySelector(".check").focus(); }
        }
        catch (e) { check.disabled = false; status.className = "status bad"; status.textContent = e.message; }
      });
      const row = el("div", "row"); row.append(check, status);
      if (found !== "none") {
        const keep = { claude: "{claude}", login: "{login}" };
        const steps = rich(st.login === "console" ? T("tier.pickConsole", keep) : T("tier.pickSubscription", keep), { claude: el("code", "cmd", "claude"), login: el("code", "cmd", "/login") });
        how.replaceChildren(el("b", null, T("tier.switch")), steps, row);
        return;
      }
      // not logged in: the wizard's server runs Claude Code's own sign-in for the card picked; HH sees no credential
      const go = el("button", "primary", T("tier.signIn")); go.type = "button";
      const note = el("p", "hint", T("tier.signInNote"));
      const parts = [el("b", null, T("tier.logIn")), go, note];
      if (failed) { const p = el("p"); p.append(T("tier.runThis") + " ", el("code", "cmd", failed)); parts.push(p, row); }
      how.replaceChildren(...parts);
      go.addEventListener("click", async () => {
        go.disabled = true; go.textContent = T("tier.signingIn");
        // with setup's terminal, a code the sign-in asks for goes there; without it (Human.app), the command does
        const paste = el("p", "hint", D.terminal === false ? T("tier.pasteCodeNoTerminal") : T("tier.pasteCode")); note.after(paste);
        const back = (msg) => { go.disabled = false; go.textContent = T("tier.signIn"); paste.className = "status bad"; paste.textContent = msg; };
        let r;
        try { r = await api("/api/wizard/login", { method: st.login === "console" ? "console" : "claudeai" }); }
        catch (e) { back(e.message); return; }
        if (r.error) { back(r.error); return; }
        if (r.login && r.login.kind !== "none") { D.login = r.login; st.login = null; render(); return; }
        showHow(r.command || "claude auth login");
      });
    };
    f.append(choices("login", logins, st.login, (v) => { st.login = v; showHow(); }, true), how, el("p", "hint", T("tier.experimental")));
    showHow();
    f.append(el("h3", null, T("tier.model")));
    const tiers = [{ key: "standard", title: T("tier.standard"), about: T("tier.standardAbout") }, { key: "save", title: T("tier.save"), about: T("tier.saveAbout") }];
    f.append(choices("tier", tiers, st.tier, (v) => { st.tier = v; card(); }, true));
  },
  memory(f) {
    // an OpenAI key, optional: checked here, kept only when the role is made (create's openaiKey)
    f.append(el("h2", null, T("memory.title")), keyBlock({
      T, kept: !!st.openaiKey, skipped: st.openaiSkipped,
      check: (key) => api("/api/wizard/openai-check", { key, lang: st.lang }),
      onKey: (k) => { st.openaiKey = k; if (k) st.openaiSkipped = false; },
      skip: () => { st.openaiKey = null; st.openaiSkipped = true; go(1); },
    }));
  },
  grants(f) {
    f.append(el("h2", null, T("grants.title")), el("p", "lead", T("grants.lead")), el("p", null, D.swiftc === false ? T("grants.noApp") : T("grants.how")));
  },
  meet(f) {
    f.append(el("h2", null, T("meet.title")));
    if (st.made) {
      const name = st.name.trim(), first = st.pronouns.trim().split(/[\s/]+/)[0] ?? "";
      // English: the pronoun's first word (she/her → She), They without one; Chinese: the name
      const who = T("meet.usePronoun") !== "yes" ? name : first ? first[0].toUpperCase() + first.slice(1) : T("meet.they");
      // with an app, setup has opened its window; without one, its console opens here
      const lead = (st.made.app ? T("meet.appOpen", { name }) + " " : "") + T("meet.doneLead", { who });
      f.replaceChildren(el("p", "big", T("meet.done", { name })), el("p", "lead", lead));
      if (!st.made.app && st.made.pair) {
        const b = el("button", "primary", T("meet.open", { name })); b.type = "button";
        b.addEventListener("click", () => { location.href = st.made.pair; });
        f.append(b);
      }
      const talk = el("div", "talk"); talk.append(el("h3", null, T("meet.talkTitle")));
      if (st.made.talk) { const t = el("p"); t.append(T("meet.talkTerminal") + " ", el("code", "cmd", st.made.talk)); talk.append(t); }
      talk.append(el("p", null, T("meet.talkLater", { name })));
      const p = el("p", "hint"); p.append(T("meet.remove", { name }) + " ", el("code", "cmd", st.made.remove));
      f.append(talk, p);
      return;
    }
    // the login it will think with is the one found, whatever card was picked
    f.append(el("p", "lead", `${T("meet.lead")} ${T("meet.thinksWith", { name: st.name.trim(), login: loginWords(D.login ?? { kind: "none" }) })}`), el("ol", "progress"));
  },
};

/** a sentence as a paragraph, with the given elements where its {blanks} are */
function rich(text, nodes) {
  const p = el("p");
  text.split(/\{(\w+)\}/).forEach((s, i) => p.append(i % 2 ? nodes[s] ?? "" : s));
  return p;
}

function personaAsk() { return { preset: st.preset, name: st.name.trim(), pronouns: st.pronouns.trim(), relation: st.relation.trim(), owner: st.owner.trim(), lang: st.lang, notes: st.notes.trim() }; }

function showFiles(open = false) {
  const box = document.querySelector("#step .files"); if (!box) return;
  box.replaceChildren();
  for (const [i, f] of (st.files ?? []).entries()) {
    const d = el("details"); d.open = open && i === 0;
    const ta = el("textarea"); ta.value = f.text; ta.spellcheck = false;
    ta.addEventListener("input", () => { st.files[i] = { ...st.files[i], text: ta.value }; st.edited = true; });
    d.append(el("summary", null, f.name), ta); box.append(d);
  }
}

/** a picture made square and at most 512 px, as a PNG */
function square(file) {
  return new Promise((done) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const n = Math.min(512, img.naturalWidth, img.naturalHeight), s = Math.min(img.naturalWidth, img.naturalHeight);
      const c = el("canvas"); c.width = c.height = n;
      c.getContext("2d").drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, n, n);
      URL.revokeObjectURL(url); done(c.toDataURL("image/png"));
    };
    img.onerror = () => { URL.revokeObjectURL(url); done(null); };
    img.src = url;
  });
}

async function make() {
  const list = document.querySelector("#step .progress"); list.replaceChildren(el("li", null, T("meet.working")));
  st.making = true; foot();
  if (!st.files) try { st.files = (await api("/api/wizard/persona", personaAsk())).files ?? null; st.from = "card"; } catch { /* the server fills them from the card */ }
  const body = {
    name: st.name.trim(), id: st.id || undefined, pronouns: st.pronouns.trim(), avatar: st.avatar || undefined, relation: st.relation.trim(),
    owner: st.owner.trim(), timezone: st.timezone, files: st.files ?? undefined, preset: st.preset, modules: st.modules, tier: st.tier, lang: st.lang, openaiKey: st.openaiKey || undefined,
  };
  // create answers with the make's last line, done or the error: that is the result. The progress, asked for a moment
  // after (it replays from the first line), only shows the steps; asked before a retry's create, it could replay the
  // attempt before
  const making = api("/api/wizard/create", body).catch((e) => ({ error: e.message, retry: !(e instanceof Expired) }));
  await new Promise((ok) => setTimeout(ok, 300));
  const reading = follow(list);
  let r = await making;
  const last = await Promise.race([reading, new Promise((ok) => setTimeout(() => ok(null), 2000))]);
  if (!r.error && last?.done && last.id === r.id) r = { ...last, ...r };
  st.making = false;
  if (r.error) {
    list.append(el("li", "bad", T("meet.failed", { error: r.error })));
    if (r.cleaned !== false) list.append(el("li", null, T("meet.cleaned")));
    foot(r.retry !== false);
    return;
  }
  st.made = r; render();
}

/** the server's progress lines, one JSON a line, read as they come (fetch, so the token header goes along); the last one */
async function follow(list) {
  let res;
  try { res = await fetch("/api/wizard/progress", { headers: { "X-HH-Wizard": token } }); } catch { return null; }
  if (!res.ok || !res.body) return null;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return null;
    buf += value;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.text?.trim() && !m.error) list.append(el("li", null, m.text.trim()));
      if (m.done || m.error) return m;
    }
  }
}

function foot(retry = false) {
  const last = st.step === STEPS.length - 1;
  $("back").textContent = T("back");
  $("back").hidden = st.step === 0 || !!st.made;
  $("back").disabled = st.making;
  const next = $("next");
  next.className = st.made && !st.made.app ? "" : "primary";
  next.disabled = st.making || (STEPS[st.step] === "tier" && noLogin());
  next.textContent = st.step === 0 ? T("welcome.start") : last ? (st.made ? T("meet.finish") : retry ? T("retry") : T("meet.create")) : T("next");
}

function render() {
  const f = $("step"); f.replaceChildren();
  $("title").textContent = T("stepOf", { n: st.step + 1, total: STEPS.length });
  const dots = $("dots"); dots.replaceChildren();
  STEPS.forEach((_, i) => dots.append(el("li", i < st.step ? "done" : i === st.step ? "now" : null)));
  screens[STEPS[st.step]](f);
  card(); foot();
  f.querySelector("input[type=text], textarea, select")?.focus({ preventScroll: true });
}

function go(d) {
  const n = Math.max(0, Math.min(STEPS.length - 1, st.step + d));
  // a name is needed before the steps that use it: the default stands in when the field was emptied
  if (STEPS[st.step] === "human" && d > 0 && !st.name.trim()) { st.name = T("human.names").split(",")[0]; nameChanged(); }
  if (STEPS[st.step] === "human" && d > 0 && !st.relation.trim()) st.relation = T("human.relationDefault");
  if (STEPS[st.step] === "you" && d > 0 && !st.owner.trim()) st.owner = D.owner || D.user || "";
  st.step = n; render();
}

$("step").addEventListener("submit", async (e) => {
  e.preventDefault();
  if ($("next").disabled) return;
  if (st.step < STEPS.length - 1) return go(1);
  if (st.made) {
    await api("/api/wizard/done", {}).catch(() => null);
    window.close();   // a page the browser opened by itself stays: say so
    $("step").replaceChildren(el("p", "big", T("meet.closed")));
    $("foot").hidden = true;
    return;
  }
  if (!st.making) await make();
});
$("back").addEventListener("click", () => go(-1));

async function refreshLists() {
  // the modules and cards, in the language picked: the defaults are worded in it
  const d = await api(`/api/wizard/defaults?lang=${encodeURIComponent(st.lang)}`);
  D = { ...D, ...d, presets: d.presets ?? [], modules: d.modules ?? [] };
  for (const m of D.modules) if (!(m.name in st.modules)) st.modules[m.name] = !!(m.ready && m.on);
  if (!D.presets.some((p) => p.key === st.preset)) st.preset = D.presets[0]?.key ?? "";
}

(async () => {
  try {
    D = await api("/api/wizard/defaults");
    st.lang = D.lang === "zh" ? "zh" : "en";
    await loadWords(st.lang);
    await refreshLists();
    st.owner = D.owner || ""; st.timezone = D.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    // the name the server suggests, with its id, first letter and colour: the card has a face from the first step
    st.name = D.name || ""; st.id = D.id || ""; st.initial = D.initial || [...st.name][0] || ""; st.color = D.color || ""; st.relation = "";
    render();
  } catch (e) {
    document.body.replaceChildren(el("p", "status bad", e.message || "The wizard's service is not answering."));
    document.body.style.display = "block"; document.body.style.padding = "48px";
  }
})();
