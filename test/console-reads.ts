// A console that asks no owner's token (an owner's own account with console.ownerToken false): its reads are open, so a
// test can GET its /api/ without pairing. Every read but /api/summary and /api/pair/status takes the owner's token otherwise.
import type { TellOptions } from "../src/console/owner.ts";

export const OPEN_READS: TellOptions = { owner: "owner", roleId: "test", tokenFile: null };
