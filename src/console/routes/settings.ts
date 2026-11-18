// 设置 → 系统权限: what the machine's read-only check says about the role's system permissions (macOS privacy settings):
// which program, which permission, why the role needs it, granted / missing / cannot tell. The command is the instance's
// (console.permissionsCheck, e.g. the operator's permissions.py --json) and runs only when the page asks, at most once a
// minute unless asked again. Nothing is changed from here: the page links to the system settings pane, which the owner
// opens in their own browser and decides on.
import { execFile } from "node:child_process";
import { fail, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export interface Permission {
  program: string;
  /** the check's code for it: screen, ax, fda, automation, files… (the page names the ones it knows) */
  permission: string;
  name: string;
  why: string;
  status: "granted" | "missing" | "unknown";
  /** the system settings pane for it; only x-apple.systempreferences: links are kept */
  link: string;
  note: string;
}

// the check writes its states in Chinese (已给 / 没给 / 查不了); anything else is a state the page cannot vouch for
const STATUS: Readonly<Record<string, Permission["status"]>> = { 已给: "granted", 没给: "missing", 查不了: "unknown", granted: "granted", missing: "missing", unknown: "unknown" };
const SETTINGS_LINK = "x-apple.systempreferences:";
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The check's JSON, kept to what the page shows */
export function permissionsOf(raw: unknown): { user: string; program: string; items: Permission[] } {
  const r = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const items = Array.isArray(r.items) ? r.items.filter((i): i is Record<string, unknown> => i !== null && typeof i === "object") : [];
  return {
    user: str(r.user),
    program: str(r.judged_as),
    items: items.map((i) => ({
      program: str(i.program), permission: str(i.permission), name: str(i.name), why: str(i.why),
      status: STATUS[str(i.status)] ?? "unknown",
      link: str(i.link).startsWith(SETTINGS_LINK) ? str(i.link) : "",
      note: str(i.note),
    })),
  };
}

const run = (cmd: readonly string[]): Promise<unknown> => new Promise((done, failed) => {
  execFile(cmd[0]!, cmd.slice(1), { timeout: 60_000, maxBuffer: 1 << 20 }, (e, out) => {
    if (e) { failed(e); return; }
    try { done(JSON.parse(out) as unknown); } catch (x) { failed(x); }
  });
});

export function settingsRoutes({ o, now }: Site): Routes {
  let last: { at: number; body: unknown } | null = null;
  return {
    // ?fresh=1: run the check again now
    "/api/permissions": async ({ q, tx, told }) => {
      const cmd = o.permissionsCheck;
      if (!cmd?.length) return ok({ configured: false });
      if (!last || q.get("fresh") === "1" || now() - last.at > 60_000) {
        try { last = { at: now(), body: { configured: true, at: now(), ...permissionsOf(await run(cmd)) } }; }
        catch (e) { return fail(502, tx("api.permissionsFailed", { error: told(e) })); }
      }
      return ok(last.body);
    },
  };
}
