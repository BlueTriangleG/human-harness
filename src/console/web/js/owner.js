"use strict";
// The owner's token: the pairing below keeps it in this console's own origin's storage (key hh_owner, which the talk
// pane, console-ui/src/main.tsx, reads too), and every read of this console's /api/ carries it as X-HH-Owner, like the writes (server.ts takes no other
// read but /api/summary and /api/pair/status). Loaded before any other script of the page: fetch and EventSource here
// add the header for this origin's /api/ only. EventSource cannot carry a header, so this origin's streams are read
// with fetch, reconnecting as an EventSource does.
const KEY = "hh_owner";
const token = () => { try { return localStorage.getItem(KEY) || ""; } catch { return ""; } };
const ours = (u) => { const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith("/api/"); };

const plainFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const url = input instanceof Request ? input.url : String(input);
  const t = token();
  if (!t || !ours(url)) return plainFetch(input, init);
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
  if (!headers.has("x-hh-owner")) headers.set("x-hh-owner", t);
  return plainFetch(input, { ...init, headers });
};

const NativeEventSource = window.EventSource;
class OwnerStream extends EventTarget {
  constructor(url) {
    super();
    if (!ours(url)) return new NativeEventSource(url);
    this.url = new URL(url, location.href).href;
    this.readyState = 0;
    this.onopen = this.onmessage = this.onerror = null;
    this.run();
  }
  close() { this.readyState = 2; if (this.ctl) this.ctl.abort(); }
  emit(type, data) {
    const ev = data === undefined ? new Event(type) : new MessageEvent(type, { data });
    this.dispatchEvent(ev);
    const h = this["on" + type];
    if (typeof h === "function") h.call(this, ev);
  }
  async run() {
    while (this.readyState !== 2) {
      this.ctl = new AbortController();
      try {
        const r = await window.fetch(this.url, { signal: this.ctl.signal, headers: { accept: "text/event-stream" } });
        if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
        this.readyState = 1;
        this.emit("open");
        const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            let type = "message";
            const data = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
            }
            if (data.length) this.emit(type, data.join("\n"));
          }
        }
      } catch { /* closed, or the console went away: try again below */ }
      if (this.readyState === 2) return;
      this.readyState = 0;
      this.emit("error");
      await new Promise((ok) => setTimeout(ok, 2000));
    }
  }
}
window.EventSource = OwnerStream;

// /pair#c=<code>: hh console (its --as, --url, HH.app) left a one-time code with this console for a new token; it is
// traded here for the token, once, within a minute, and the address loses it at once. The page reloads paired.
const code = location.pathname === "/pair" ? new URLSearchParams(location.hash.slice(1)).get("c") : null;
if (code) history.replaceState(null, "", "/pair");
export const pairing = code ? plainFetch("/api/pair", { method: "POST", headers: { "content-type": "application/json", "x-hh-console": "1" }, body: JSON.stringify({ code }) })
  .then((r) => r.json()).then((r) => {
    if (!r.token) return false;
    try { localStorage.setItem(KEY, r.token); } catch { return false; }
    location.replace("/");
    return true;
  }, () => false) : null;
