import type { Strings } from "../zh.ts";
import type { timeline as zh } from "../zh/timeline.ts";

export const timeline: Strings<typeof zh> = {
  search: "Search",
  sentTo: "Sent to",
  channel: { senses: "notification" },
  someone: "the recipient",
  saidTo: "to {name}",
  saidToMany: "to {name} ({n} messages)",
  saidAt: "sent at {time}",
  saidBetween: "sent as {n} messages, {from} to {to}",
  rowTitle: "{day}, record #{seq}",
  innerNote: ", internal notes of the subconscious, not shared with the other regions",
  older: "Earlier",
  empty: "Central memory is still empty. Records appear here once {me} receives a message and starts thinking.",
  emptyRegion: "Central memory has no records from {name}. Look at the whole brain, or pick another region.",
  regionLoading: "Nothing from {name} in the latest stretch; looking further back for its own records…",
  regionFailed: "Nothing from {name} in the latest stretch, and looking further back failed ({error}). That does not mean it did nothing: click “Earlier” to try again.",
  emptyFiltered: "No records match the filters. Change the toggles or the search above.",
  unseen: "{n} new below",
  loadFailed: "Can't read central memory: {error}",
};
