// Where things live in a role's workspace (docs/contracts/workspace-layout.md): HH's code names these paths only here.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LAYOUT = {
  /** Who the role knows */
  registry: "memory/people/registry.json",
  /** The person cards the event store exports */
  peopleCards: "ledger/people",
  /** The persona snapshot the night module generates */
  snapshot: "ledger/SOUL.md",
  /** The memory blocks soul_build cuts out of soul/ */
  soulMemory: "SOUL.memory.md",
  /** The persona, split by aspect; SOUL.md is built from it */
  soulDir: "soul",
} as const;

/** The folders of a new role's workspace (contract part 4); the starter persona goes into soul/ as well, since the night builds SOUL.md from there; the night's own settings */
export function makeSkeleton(workspace: string, soulText: string): void {
  for (const d of [LAYOUT.soulDir, LAYOUT.peopleCards, "memory/people", "memory/threads", "memory/archive", "memory/diary", "sleep", "skills"]) {
    mkdirSync(join(workspace, d), { recursive: true });
  }
  writeFileSync(join(workspace, LAYOUT.soulDir, "10-soul.md"), soulText);
  // The night applies what its organizer proposes; without this file the night's scripts only rehearse (mode "draft")
  writeFileSync(join(workspace, "sleep", "config.json"), `${JSON.stringify({ mode: "live" }, null, 2)}\n`);
}
