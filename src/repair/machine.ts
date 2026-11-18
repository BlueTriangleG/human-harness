// What the repair commands share across every role on this machine (docs/contracts/machine.md). Not a role's data: each role's own
// settings live in its instance config, and what a role must not change about itself lives in the role table (instances.ts).

/** The shared repository whose master is what gets deployed */
export const SHARED_REPO = "/Users/Shared/hh.git";
/** Held by the machine's account; the roles' accounts can read it but not write it: session approvals and the role table */
export const GUARD_DIR = "/Users/Shared/hh-guard";
