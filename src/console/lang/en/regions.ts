import type { Strings } from "../zh.ts";
import type { regions as zh } from "../zh/regions.ts";

export const regions: Strings<typeof zh> = {
  main: { name: "Main", where: "prefrontal cortex", what: "The part of {me} that decides, talks to people and gets things done." },
  side: { name: "Side task {n}", where: "parietal lobe", what: "Longer work running alongside Main, kept in sync with it.", group: "Side tasks" },
  speech: { name: "Quick reply", where: "Broca's area", what: "A fast acknowledgement while Main is still thinking; it only relays what Main has decided to say." },
  hippocampus: { name: "Consolidation", where: "hippocampus", what: "At each page turn and during sleep, summarizes what just happened into memory." },
  outer: { name: "Outside", where: "brainstem", what: "What comes in from outside: people's messages, sense events, reminders." },
  system: { name: "System", where: "cerebellum", what: "Things that happen automatically: page turns, going to sleep, waking up." },
  deep: { name: "Mulling", where: "occipital lobe", what: "A background thread that keeps turning over a question {me} has set aside. The process stays out of Main; the conclusion comes back as {me}'s own thought." },
  oldPerception: {
    name: "Old subconscious",
    nameOf: "Old subconscious ({stream})",
    where: "retired (replaced by the gate on 11-04)",
    what: "The subconscious region from before 11-04; only its old records remain here. Sense events now pass through the gate first: click “Subconscious” on the brain.",
    whatOther: "The old subconscious for another sense stream; only its old records remain here.",
  },
  gate: {
    name: "Subconscious",
    where: "thalamus",
    what: "Everything {me} senses (messages, notifications, reminders) arrives here first. A few fixed routes go straight to {me}; the rest are decided by {me}'s own rules and a quick judge (a small, fast model): deliver now, hold for the daily digest, or drop. Dropped items are still listed in the daily digest.",
  },
  kinds: { input: "Received", think: "Thought", say: "Said", act: "Did", result: "Result", note: "Noted", system: "System" },
  tools: {
    recall: "search the transcript", remember: "recall by meaning", recall_person: "recall a person", recall_event: "open an event", recall_period: "browse by time", like: "save a like", my_likes: "view likes",
    mem_worklist: "night worklist", learn_worklist: "learning worklist", learn_check: "send to the checker", mem_event_create: "create an event", mem_event_update: "edit an event", mem_entry_add: "add an entry", mem_entries_add: "add entries",
    mem_entry_correct: "correct an entry", mem_link: "link two events", mem_unlink: "remove a link", mem_merge: "merge into one", mem_split: "split in two", mem_supersede: "mark as superseded",
    mem_retire: "mark as withdrawn", mem_entity_upsert: "register a person or thing", mem_entity_merge: "merge into one", mem_entity_drop: "unregister", mem_entity_tag: "tag people and things", mem_day_done: "day organized",
  },
};
