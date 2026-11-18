import type { Strings } from "../zh.ts";
import type { machine as zh } from "../zh/machine.ts";

export const machine: Strings<typeof zh> = {
  listLabel: "Roles on this computer",
  frameTitle: "The picked role's console",
  pick: "Pick a role on the left to see its console here.",
  loadFailed: "Cannot read the roles on this computer: {error}",
  roleSub: "{account} · {state}",
  state: { down: "not answering", trouble: "trouble today", asleep: "asleep", busy: "at work", idle: "idle" },
  noAnswer: "Its console (port {port}) does not answer.",
  regions: "At work",
  allIdle: "all idle",
  quota: "Quota this week",
  load: "Load guard",
  loadLevel: { ok: "fine", tight: "tight", danger: "danger" },
  today: "Today",
  todayCounts: "stopped {stops} · refused {refusals} · blocked {blocks}",
  lock: "Heavy-job lock",
  lockFree: "free",
  lockStale: "{who} (the process holding it is gone)",
  none: "none",
};
