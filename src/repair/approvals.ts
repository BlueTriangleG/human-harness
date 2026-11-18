// Approvals, of two kinds, neither of them the role's own say:
// - a Claude Code session's commit: the session leaves a record in /Users/Shared/hh-guard/approvals/, owned by the owner's
//   account and only readable by the role's; a record the role's account can write is never taken.
// - 她问过主人的：主人在 whatsapp/qq 里真回过（消息库里核对），回在她问的那条之后；批的是问的时候守门列出的那几条理由。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Reason } from "./gate.ts";
import { R } from "../lang/index.ts";

export interface SessionApproval { shas: string[]; by: string; why: string; t: string }

/** a directory or file the role's account (selfUid) owns, or that group or others can write: the role may have changed it, so it is not taken */
export function trusted(path: string, selfUid: number): boolean {
  try {
    const s = statSync(path);
    return s.uid !== selfUid && (s.mode & 0o022) === 0;
  } catch { return false; }
}

export function sessionApproval(guardDir: string, sha: string, selfUid: number): SessionApproval | null {
  const dir = join(guardDir, "approvals");
  if (!trusted(guardDir, selfUid) || !trusted(dir, selfUid)) return null;
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort(); } catch { return null; }
  for (const n of names) {
    const p = join(dir, n);
    if (!trusted(p, selfUid)) continue;
    try {
      const rec = JSON.parse(readFileSync(p, "utf8")) as SessionApproval;
      if (Array.isArray(rec.shas) && rec.shas.some((s) => typeof s === "string" && s.length >= 7 && sha.startsWith(s))) return rec;
    } catch { /* 坏文件跳过 */ }
  }
  return null;
}

export interface OwnerCheck { ok: boolean; why: string }

interface Row { seq: number; kind: string; text: string; meta: string | null }

/** owner: from the machine's role table (instances.ts), never from the role's own config */
export function ownerApproval(db: DatabaseSync, trailers: Record<string, string>, reasons: Reason[], owner: { name: string; channels: string[] }): OwnerCheck {
  const { name, channels } = owner;
  const asked = Number(trailers.Asked);
  // older commits carry a trailer named after the owner (<Name>-OK); what counts is the row it points at, checked below
  const okSeq = Number(trailers["Owner-OK"] ?? Object.entries(trailers).find(([k]) => /^[A-Z][a-z]+-OK$/.test(k))?.[1]);
  const listed = new Set((trailers["Ask-reasons"] ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  if (!asked || !okSeq || !listed.size) return { ok: false, why: R.approvals.approvalTrailersMissing };
  const row = (seq: number) => db.prepare("SELECT seq, kind, text, meta FROM central WHERE seq = ?").get(seq) as Row | undefined;
  const meta = (r: Row) => { try { return JSON.parse(r.meta ?? "{}") as Record<string, unknown>; } catch { return {}; } };
  const ask = row(asked);
  if (!ask || ask.kind !== "note" || meta(ask).sent !== true || meta(ask).name !== name) return { ok: false, why: R.approvals.approvalAskNotSent(asked) };
  // 问的那条要写着这个毛病的编号：同一对问答不能拿去批别的修理
  const fix = trailers.Fix ?? "";
  if (!fix || !ask.text.includes(fix)) return { ok: false, why: R.approvals.approvalAskMissingFix(asked, fix || R.approvals.approvalFixIdLabel) };
  const ok = row(okSeq);
  const m = ok ? meta(ok) : {};
  if (!ok || ok.kind !== "input" || m.from !== name || m.human !== true) return { ok: false, why: R.approvals.approvalReplyNotFromOwner(okSeq) };
  if (!channels.includes(String(m.channel))) return { ok: false, why: R.approvals.approvalChannelRejected(okSeq, String(m.channel), channels.join("/")) };
  if (okSeq <= asked) return { ok: false, why: R.approvals.approvalReplyBeforeAsk(okSeq, asked) };
  const extra = reasons.map((r) => r.key).filter((k) => !listed.has(k));
  if (extra.length) return { ok: false, why: R.approvals.approvalReasonsNotAsked(extra.join(R.approvals.approvalReasonSeparator)) };
  return { ok: true, why: R.approvals.approvalGranted(okSeq, ok.text.replace(/\s+/g, " ").slice(0, 80), asked, fix) };
}
