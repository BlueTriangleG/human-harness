// This computer: /api/machine (the roles running here and what each console's summary says, for /machine, the monitor
// and the menu bar of Human.app) and /api/load (this role's load guard, read from the module's own status file). Both
// read-only and, like every read but /api/summary, the owner's only.
import { readFileSync } from "node:fs";
import { getLocal, lockView, roleView, rolesOnMachine } from "../machine.ts";
import { ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

/** the load guard's last reading: its level, why, when; the pressure figures beside */
function loadView(file: string | undefined): Record<string, unknown> {
  try {
    const s = JSON.parse(readFileSync(file ?? "", "utf8")) as Record<string, unknown>;
    return Object.fromEntries(["at", "level", "why", "pressure", "avail_pct", "seg_pct", "swap_gb", "disk_gb"].map((k) => [k, s[k] ?? null]));
  } catch { return { level: null }; }
}

const MACHINE_TTL_MS = 10_000;

export function machineRoutes({ o, now }: Site): Routes {
  let last: { at: number; body: unknown } | null = null;
  return {
    "/api/load": () => ok(loadView(o.loadStatus)),
    "/api/machine": async () => {
      if (last && now() - last.at < MACHINE_TTL_MS) return ok(last.body);
      const m = o.machine;
      const self = { id: o.role ?? "", name: o.names?.me ?? o.role ?? "", account: m?.account ?? "", port: m?.port ?? 0 };
      const roles = m ? rolesOnMachine({ shared: m.shared, jobs: await m.jobs(), account: m.account, self }) : [self];
      const body = { at: now(), self: self.id, roles: await Promise.all(roles.map((e) => roleView(e, getLocal))), lock: lockView(m?.lockDir) };
      last = { at: now(), body };
      return ok(body);
    },
  };
}
