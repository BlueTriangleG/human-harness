// The outbound filter: the framework's BeforeSend, installed inside openChannels (docs/contracts/channels.md). It is
// what the gateway plugin leak-guard did to every message HH sent through it, moved here so that it holds for any
// channel. Every rule is off in the framework's default; an instance turns on the ones that fit its role
// (instance config `outbound`, docs/contracts/instance-config.md).
import { readFileSync } from "node:fs";
import type { Config } from "../config.ts";
import type { BeforeSend } from "../channels/types.ts";
import { G } from "../lang/index.ts";

export type OutboundConfig = NonNullable<Config["outbound"]>;

/** A notice that starts with one of these signs goes out untouched (the old filter let its own notices through so) */
const NOTICE = /^\s*(⚠️|⚠|⏳|🔁|✅|❌|🦞|🔄|🛑)/u;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/;
const URL = /https?:\/\/|www\./i;

/**
 * A short line in Latin words only: one line of at most 150 characters, no kana or han, no link, three words or more.
 * For a role that writes Chinese this is nearly always the role narrating its own work in English, not something said
 * to a person.
 */
export function latinLine(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 150 || t.includes("\n") || CJK.test(t) || URL.test(t)) return false;
  return (t.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length >= 3;
}

/** One line loses a leading list mark (1. 1、 1) - • *) and trailing 。; several lines are left as they are */
export function tidyLine(text: string): string {
  if (text.includes("\n")) return text;
  return text.replace(/^\s*(\d+[.、)]|[-•*])\s+/, "").replace(/。+\s*$/, "");
}

/** Until when (ms) the latinLinesFile lets Latin lines go to anyone; a missing or broken file says 0 */
export function latinUntil(file: string): number {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as { until?: unknown };
    return typeof j.until === "number" ? j.until : 0;
  } catch { return 0; }
}

/** The filter for this instance, or none when every rule is off */
export function outboundFilter(cfg: OutboundConfig | undefined, now: () => number = Date.now): BeforeSend | undefined {
  if (!cfg?.refuseLatinLines && !cfg?.tidyLines) return undefined;
  return async (m) => {
    if (NOTICE.test(m.text)) return undefined;
    if (cfg.refuseLatinLines && latinLine(m.text)
      && !(cfg.latinLinesTo ?? []).some((t) => t && m.target.includes(t))
      && !(cfg.latinLinesFile && latinUntil(cfg.latinLinesFile) > now())) {
      return { refuse: G.outbound.latinLineRefused };
    }
    if (!cfg.tidyLines) return undefined;
    const t = tidyLine(m.text);
    return t !== m.text && t.trim() ? { text: t } : undefined;
  };
}
