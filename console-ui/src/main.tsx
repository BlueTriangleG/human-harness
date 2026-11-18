// The console's talk pane: say something to the role as its owner (POST /api/tell, the same request as hh tell) and see
// its turn drawn from its own record — thinking, tool calls with their results, what it said.
// Mounted into #chat of the console page; texts come from the page's own data (#hh-data, the console language packs).
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AssistantRuntimeProvider, ComposerPrimitive, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { AppendMessage, ReasoningMessagePartComponent, TextMessagePartComponent, ToolCallMessagePartComponent } from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type { MarkdownTextPrimitiveProps } from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { thread, MAIN, OUTER } from "./thread.ts";
import type { Msg, Row } from "./thread.ts";
import "./chat.css";

interface PageData { lang: string; base: Record<string, string>; strings: Record<string, string> }
const HH = JSON.parse(document.getElementById("hh-data")!.textContent!) as PageData;
/** a console text, {name} filled from the page's base (me, owner) and params; same rule as js/i18n.js */
const T = (key: string, params: Record<string, string | number> = {}): string => {
  const p: Record<string, string | number> = { ...HH.base, ...params };
  return (HH.strings[key] ?? key).replace(/\{(\w+)\}/g, (w, n: string) => (p[n] === undefined ? w : String(p[n])));
};
// The owner's token lives in this console's own origin's storage (per port: no other console or local server reads it)
// and goes in a header, never a cookie (a cookie goes to every port of 127.0.0.1)
const KEY = "hh_owner";
const ownToken = (): string => { try { return localStorage.getItem(KEY) ?? ""; } catch { return ""; } };
const owner = (): Record<string, string> => { const t = ownToken(); return t ? { "x-hh-owner": t } : {}; };
const WRITE = { "content-type": "application/json", "x-hh-console": "1" };
const pairStatus = (): Promise<Status> => fetch("/api/pair/status", { headers: owner() }).then((x) => x.json() as Promise<Status>);

// /pair#t=<token> (hh console opens it): read the token before anything else touches the address, wipe it from the
// address bar, post it; once paired, load the first page (此刻), where the talk pane is
const pairToken = location.pathname === "/pair" ? new URLSearchParams(location.hash.slice(1)).get("t") : null;
if (location.pathname === "/pair") history.replaceState(null, "", "/pair");

interface Status { enabled: boolean; paired: boolean; from: string | null }
type Note = { kind: "info" | "error"; text: string } | null;

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; error?: string; result?: unknown }> {
  const r = await fetch(path, { method: "POST", headers: { ...WRITE, ...owner() }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false };
  const j = (await r.json().catch(() => ({}))) as { error?: string; result?: unknown };
  return { ok: r.ok, ...(j.error ? { error: j.error } : {}), ...(j.result !== undefined ? { result: j.result } : {}) };
}

/**
 * What the owner sent that is not in the record yet. after: the last row seen when it was sent; it is in the record
 * once an owner input with the same words comes after that. hhd records it at once while the role answers the owner,
 * and when it wakes the role for it while the role is busy with something else or asleep.
 */
interface Sent { id: string; text: string; after: number; at: number; state: "sending" | "delivered" | "queued" | "failed" }
type Seen = NonNullable<Msg["metadata"]>["custom"]["state"];

/** the rows the thread is built from: the inputs and the main region; the first page, then the live stream */
function useRows(): { rows: Row[]; error: string | null } {
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let es: EventSource | null = null;
    const keep = (rs: Row[]): Row[] => rs.filter((r) => r.src === MAIN || r.src === OUTER);
    fetch("/api/central?limit=600").then((x) => x.json()).then((j: { rows?: Row[]; maxSeq?: number; error?: string }) => {
      if (j.error) throw new Error(j.error);
      const first = j.rows ?? [];
      setRows(keep(first));
      const after = first.length ? first[first.length - 1]!.seq : j.maxSeq ?? 0;
      es = new EventSource(`/api/stream?after=${after}`);
      es.addEventListener("rows", (ev) => setRows((prev) => [...prev, ...keep(JSON.parse((ev as MessageEvent<string>).data) as Row[])]));
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => es?.close();
  }, []);
  return { rows, error };
}

/** whether the main region is in a turn (the console's status page asks hhd every few seconds) */
function useBusy(): boolean {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const tick = () => fetch("/api/status").then((x) => x.json()).then((s: { status?: { regions?: Array<{ id: string; busy?: boolean }> } }) => {
      setBusy(s.status?.regions?.find((r) => r.id === MAIN)?.busy === true);
    }).catch(() => setBusy(false));
    tick();
    const t = setInterval(tick, 3000);
    return () => clearInterval(t);
  }, []);
  return busy;
}

/** busy: the role is at work on something else, so what was delivered waits for that turn to end (or interrupts it) */
/** not paired: the role's own command that pairs this browser, to copy */
function NotPaired() {
  const [copied, setCopied] = useState(false);
  const cmd = HH.base.cmd ?? "";
  return (
    <div className="ct-note">
      <p>{T("chat.notPaired")}</p>
      <p className="ct-cmd"><code>{cmd}</code><button type="button" className="ct-copy" onClick={() => void navigator.clipboard.writeText(cmd).then(() => setCopied(true), () => undefined)}>{copied ? T("now.copied") : T("now.copy")}</button></p>
    </div>
  );
}

const markOf = (state: Seen, busy: boolean): string =>
  state === "sending" ? T("chat.sending") : state === "queued" ? T("chat.queued") : state === "failed" ? T("chat.notSent")
    : state === "unseen" ? T("chat.unseen") : busy ? T("chat.deliveredBusy") : T("chat.delivered");

/** what the owner typed: plain text, as typed */
const Text: TextMessagePartComponent = ({ text }) => <p className="ct-text">{text}</p>;

/** how far the owner's words got, until the role has seen them */
function Mark() {
  const state = useAuiState((s) => s.message.metadata.custom?.state) as Seen | undefined;
  const busy = useAuiState((s) => s.message.metadata.custom?.busy) === true;
  return state ? <span className="ct-mark">{markOf(state, busy)}</span> : null;
}

// What the role says and thinks is Markdown (GitHub's flavour: tables, task lists). No raw HTML; images only load from
// the console itself (the page's CSP); a link opens beside the console.
const MD_PLUGINS = [remarkGfm];
const MD_PARTS: MarkdownTextPrimitiveProps["components"] = {
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
};
const Markdown = ({ className }: { className: string }) => (
  <MarkdownTextPrimitive className={className} remarkPlugins={MD_PLUGINS} components={MD_PARTS} smooth={false} />
);
const Said: TextMessagePartComponent = () => <Markdown className="ct-md" />;

const Reasoning: ReasoningMessagePartComponent = () => (
  <details className="ct-fold ct-think">
    <summary>{T("chat.thinking")}</summary>
    <Markdown className="ct-body ct-md" />
  </details>
);

const Tool: ToolCallMessagePartComponent = ({ toolName, argsText, result, isError }) => {
  const label = result === undefined ? T("chat.toolRunning", { tool: toolName }) : isError ? T("chat.toolError", { tool: toolName }) : T("chat.tool", { tool: toolName });
  return (
    <details className={`ct-fold ct-tool${isError ? " ct-err" : ""}`}>
      <summary>{label}</summary>
      <h4>{T("chat.input")}</h4>
      <pre className="ct-body">{argsText}</pre>
      {result !== undefined && <><h4>{T("chat.result")}</h4><pre className="ct-body">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre></>}
    </details>
  );
};

const UserMessage = () => (
  <MessagePrimitive.Root className="ct-msg ct-owner">
    <span className="ct-who">{T("chat.owner")}</span>
    <MessagePrimitive.Parts components={{ Text }} />
    <Mark />
  </MessagePrimitive.Root>
);

const AssistantMessage = () => (
  <MessagePrimitive.Root className="ct-msg ct-role">
    <span className="ct-who">{T("chat.me")}</span>
    <MessagePrimitive.Parts components={{ Text: Said, Reasoning, tools: { Fallback: Tool } }} />
  </MessagePrimitive.Root>
);

let sentN = 0;

function Talk({ status }: { status: Status }) {
  const { rows, error } = useRows();
  const busy = useBusy();
  const [note, setNote] = useState<Note>(null);
  const [sent, setSent] = useState<Sent[]>([]);
  const lastSeq = useRef(0);
  lastSeq.current = rows.at(-1)?.seq ?? 0;
  const owner = status.from ?? "";
  const messages = useMemo<Msg[]>(() => {
    const drawn = thread(rows, owner, busy);
    // at work, but not on the owner's turn: what is delivered waits for that turn
    const elsewhere = busy && !drawn.some((m) => m.status?.type === "running");
    // each owner input in the record takes the oldest sent message with its words that it came after
    const left = [...sent];
    for (const r of rows) {
      if (r.src !== OUTER || r.kind !== "input" || r.meta?.from !== owner) continue;
      const i = left.findIndex((x) => x.state !== "failed" && x.text === r.text && r.seq > x.after);
      if (i >= 0) left.splice(i, 1);
    }
    return [...drawn, ...left.map((x): Msg => ({ id: x.id, role: "user", content: [{ type: "text", text: x.text }], createdAt: new Date(x.at), metadata: { custom: { state: x.state, busy: elsewhere } } }))];
  }, [rows, owner, busy, sent]);
  const running = messages.some((m) => m.status?.type === "running");
  const onNew = useCallback(async (m: AppendMessage) => {
    const text = m.content.map((p) => (p.type === "text" ? p.text : "")).join("").trim();
    if (!text) return;
    setNote(null);
    const id = `s${++sentN}`;
    setSent((xs) => [...xs, { id, text, after: lastSeq.current, at: Date.now(), state: "sending" }]);
    const r = await postJson("/api/tell", { text });
    const state: Sent["state"] = !r.ok ? "failed" : r.result === "queued" ? "queued" : "delivered";
    setSent((xs) => xs.map((x) => (x.id === id ? { ...x, state } : x)));
    if (!r.ok) setNote({ kind: "error", text: T("chat.sendFailed", { error: r.error ?? "" }) });
  }, []);
  // never "running" to assistant-ui: it would lock the composer, and the owner may speak while the role is at work
  const runtime = useExternalStoreRuntime<Msg>({
    messages, isRunning: false, isDisabled: !status.paired, convertMessage: (m) => m, onNew,
  });
  const live = useRef<HTMLParagraphElement>(null);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ct">
        <ThreadPrimitive.Viewport className="ct-view" aria-live="polite">
          {error && <p className="ct-note ct-error">{T("chat.loadFailed", { error })}</p>}
          {!error && messages.length === 0 && <p className="ct-empty">{T("chat.empty")}</p>}
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
          {running && <p className="ct-working" ref={live}>{T("chat.working")}</p>}
        </ThreadPrimitive.Viewport>
        {!status.paired && <NotPaired />}
        {status.paired && busy && <p className="ct-hint">{running ? T("chat.busyAnswering") : T("chat.busyElse")}</p>}
        {note && <p className={`ct-note${note.kind === "error" ? " ct-error" : ""}`} role="status">{note.text}</p>}
        <ComposerPrimitive.Root className="ct-compose">
          <ComposerPrimitive.Input className="ct-input" placeholder={T("chat.placeholder")} aria-label={T("chat.placeholder")} />
          <ComposerPrimitive.Send className="ct-send">{T("chat.send")}</ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function App({ first }: { first: Note }) {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => { pairStatus().then(setStatus).catch(() => setStatus({ enabled: false, paired: false, from: null })); }, []);
  if (!status) return null;
  if (!status.enabled) return <p className="ct-note">{T("chat.disabled")}</p>;
  return <>{first && <p className={`ct-note${first.kind === "error" ? " ct-error" : ""}`} role="status">{first.text}</p>}<Talk status={status} /></>;
}

async function start(): Promise<void> {
  let first: Note = null;
  if (pairToken) {
    const r = await postJson("/api/pair", { token: pairToken });
    if (r.ok) {
      try { localStorage.setItem(KEY, pairToken); } catch { /* no storage here: this page stays unpaired */ }
      location.replace("/");
      return;
    }
    first = { kind: "error", text: T("chat.pairFailed", { error: r.error ?? "" }) };
  }
  const s = await pairStatus().catch(() => null);
  // the pane shows only on a console with the write ports; on the others the first page is the role's state alone
  const page = document.getElementById("nowview")!, box = document.getElementById("chat")!;
  page.dataset.talk = s?.enabled ? "on" : "off";
  if (!s?.enabled) return;
  box.hidden = false;
  createRoot(box).render(<StrictMode><App first={first} /></StrictMode>);
}
void start();
