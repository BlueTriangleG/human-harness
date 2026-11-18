// The talk pane's thread, built from the role's central memory (the rows /api/central and /api/stream give).
// No React here: test/console-chat.test.ts runs it under node.
//   a turn starts at an input row the owner told on the local channel (what POST /api/tell and hh tell hand in);
//   the main region's rows after it are the role's side of that turn: think → reasoning, act + its result → one tool
//   call, say → text; the turn ends at the main region's local-reply note (a role with no channel; when the turn failed,
//   that note says why, and is drawn as its text), or at the owner's
//   next input. A role busy with something else when the owner speaks answers later; the rows in between are drawn in
//   the owner's turn (step 1 accepts this; the record has no turn id to tell them apart).
//   The owner may speak again while the role is answering (hhd shows it after the role's next tool call); what the role
//   had not seen by the end of that turn it answers in a turn of its own, with no input row before it: the rows after a
//   reply are drawn once they end in a reply to the owner, or while that turn runs right after one that left words unseen.

export interface Row { seq: number; ts: number; src: string; kind: string; text: string; meta: Record<string, unknown> | null }

/** a JSON value, as tool arguments are */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type Part =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; args: { [k: string]: Json }; argsText: string; result?: string; isError?: boolean };

export interface Msg {
  id: string;
  role: "user" | "assistant";
  content: Part[];
  createdAt: Date;
  /** assistant messages: still being written, or done */
  status?: { type: "running" } | { type: "complete"; reason: "stop" | "unknown" };
  /** the owner's words the role has not seen yet: how far they got (unseen: in the record, handed over after its next tool call) */
  metadata?: { custom: { state: "sending" | "delivered" | "queued" | "failed" | "unseen"; busy?: boolean } };
}

/** where an inbound message is recorded (brain.ts inbound()), and the main region's id */
export const OUTER = "外界";
export const MAIN = "main";

/** the owner's own words: a tell under the owner's name that a program handed in (human: false, as setup's "you have
 * just been made") is not drawn as the owner speaking; what the role says to it is a turn of its own */
const isOwnerTell = (r: Row, owner: string): boolean =>
  r.src === OUTER && r.kind === "input" && r.meta?.channel === "local" && r.meta?.from === owner && r.meta?.human !== false;

function toolOf(r: Row): Extract<Part, { type: "tool-call" }> {
  const name = typeof r.meta?.tool === "string" ? r.meta.tool : r.text.split(" ", 1)[0] ?? "";
  const argsText = r.text.startsWith(name + " ") ? r.text.slice(name.length + 1) : "";
  let args: { [k: string]: Json } = {};
  try { const v = JSON.parse(argsText) as Json; if (v && typeof v === "object" && !Array.isArray(v)) args = v; } catch { /* shown as text */ }
  return { type: "tool-call", toolCallId: typeof r.meta?.id === "string" ? r.meta.id : `act-${r.seq}`, toolName: name, args, argsText };
}

/** a turn that runs this soon after a reply that left the owner's words unseen is taken for the one that answers them */
const FOLLOW_MS = 120_000;

/**
 * The owner's turns, oldest first. busy: the main region is in a turn right now (/api/status); the last turn is still
 * running while it is and no reply has been recorded.
 */
export function thread(rows: readonly Row[], owner: string, busy: boolean): Msg[] {
  const out: Msg[] = [];
  let reply: Msg | null = null;
  // main rows after a reply: a turn of the role's own, or the one answering what the owner said while it was at work
  let after: Msg | null = null;
  // the owner's inputs since the last reply; more than one: some came while the role was at work, maybe unseen
  let asked = 0;
  let owedUntil = 0;
  // said while the role was answering: hhd hands them over after its next tool call (a result row)
  let unseen: Msg[] = [];
  const running = (id: string, ts: number): Msg => ({ id, role: "assistant", content: [], createdAt: new Date(ts), status: { type: "running" } });
  // calls by id, so a result finds its call when the owner spoke between the two
  const calls = new Map<string, Extract<Part, { type: "tool-call" }>>();
  for (const r of rows) {
    if (isOwnerTell(r, owner)) {
      if (reply) reply.status = { type: "complete", reason: "unknown" };
      // the owner spoke again before the role wrote anything: two lines in a row, no empty answer between them
      if (reply && !reply.content.length) out.splice(out.indexOf(reply), 1);
      const said: Msg = { id: `u${r.seq}`, role: "user", content: [{ type: "text", text: r.text }], createdAt: new Date(r.ts) };
      if (reply) unseen.push(said);
      out.push(said);
      reply = running(`a${r.seq}`, r.ts);
      out.push(reply);
      after = null;
      asked += 1;
      continue;
    }
    if (r.src !== MAIN) continue;
    if (r.kind === "result") unseen = [];
    const to: Msg = reply ?? (after ??= running(`f${r.seq}`, r.ts));
    if (r.kind === "think") to.content.push({ type: "reasoning", text: r.text });
    else if (r.kind === "say") to.content.push({ type: "text", text: r.text });
    else if (r.kind === "act") { const call = toolOf(r); calls.set(call.toolCallId, call); to.content.push(call); }
    else if (r.kind === "result") {
      const call = calls.get(String(r.meta?.id)) ?? to.content.filter((p): p is Extract<Part, { type: "tool-call" }> => p.type === "tool-call").reverse().find((p) => p.result === undefined);
      if (call) { call.result = r.text; if (r.meta?.error === true) call.isError = true; }
    } else if (r.kind === "note" && r.meta?.local === true && (r.meta?.sent === true || r.meta?.failed === true)) {
      // the reply printed back on this machine: the same words are its say row; the turn is over. A turn that failed has
      // no say row: its note says why and what to do, drawn as the turn's text
      if (r.meta?.failed === true) to.content.push({ type: "text", text: r.text });
      to.status = { type: "complete", reason: "stop" };
      if (to === after && r.meta?.to === owner) out.push(after);
      unseen = [];
      owedUntil = asked > 1 ? r.ts + FOLLOW_MS : 0;
      asked = 0;
      reply = after = null;
    }
  }
  if (after && busy && after.createdAt.getTime() <= owedUntil) out.push(after);
  if (busy) for (const m of unseen) m.metadata = { custom: { state: "unseen" } };
  if (reply && !busy) reply.status = { type: "complete", reason: "unknown" };
  return out;
}
