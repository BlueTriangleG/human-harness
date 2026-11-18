// The console's English demo data: the same kind of made-up day as the Chinese demo (test/console-demo.ts), written in English for an
// English-speaking audience. Every name, number and line here is invented: Mira (the agent), Sam (her owner), Alex and Jordan (guests),
// the Weekend Crew group. Nothing comes from a real person or a real conversation.
//
// It plugs into console-demo.ts: `node test/console-demo.ts --lang en [--port 7798] [--me Mira] [--owner Sam]` builds this state in a
// temporary directory and serves a read-only console on 127.0.0.1 with a "Demo data" badge. The console reads only that directory
// (a fake hhd answers `status`), never her live state, hhd, a model or OpenAI.
//
// Guest privacy is part of the demo: Alex's and Jordan's one-on-one chats are hidden on the gate page and in the people cards
// (the "secret" strings below must never appear on a page); Jordan's DM is one the senses layer mislabelled as a group, and it is
// still hidden; Jordan speaking in the group is shown; a system notice the role's own script marked (`system: true`) is shown.
import { join } from "node:path";
import type { BrainStatus } from "../src/brain.ts";
import { gateDayRange } from "../src/console/gate.ts";
import { projectDirFor } from "../src/console/prompt.ts";
import type { RoleMarker } from "../src/console/prompt.ts";
import type { PageMarks } from "../src/console/lang/index.ts";
import { Epochs } from "../src/epoch/epoch.ts";
import type { EpochReason } from "../src/epoch/epoch.ts";
import { localDay, shiftDay } from "../src/learning/score.ts";
import { CentralMemory } from "../src/memory/central.ts";
import type { Kind } from "../src/memory/central.ts";
import { MemIndex } from "../src/memory/events/index.ts";
import { parseTemplate } from "../src/memory/events/people.ts";
import { EventStore } from "../src/memory/events/store.ts";
import { MEMORY_FILES } from "../src/persona/persona.ts";
import { REGISTRY_FILE, approvedFrom } from "../src/persona/registry.ts";
import { all, kvSet, one } from "../src/store/db.ts";
import type { Db } from "../src/store/db.ts";
import { localToUtc } from "../src/memory/events/schema.ts";
import { CFG, DAY, DEMO_FILES, HOUR, LIMITS, MIN, REGION_IDS, chat, iso, jsonl, put } from "./console-demo.ts";
import type { Ctx, DemoSeeds, Seeded, Step } from "./console-demo.ts";

/** Strings the guests said in private: the people card (private section, pinned private quote) and the gate row must never show them */
export const SECRETS_EN = { card: "surprise anniversary dinner", gate: "scorched" } as const;

const ALEX = "Alex", JORDAN = "Jordan", GROUP = "Weekend Crew";

/** Openings of each region's first message (the console tells sessions apart by them; the real ones live in regions/specs.ts) */
const OPENINGS = {
  main: "[This is the part of you that is most awake right now]",
  side: "[This is you working on a longer task on the side]",
  speech: "[This is you answering quickly while you think]",
  hippocampus: "[This is you condensing a full page of memory]",
  deep: "[This is your subconscious turning something over]",
} as const;
const MARKERS: RoleMarker[] = Object.entries(OPENINGS).map(([role, marker]) => ({ role, marker }));
/** How this demo role writes the things the page scripts recognise: "(to Sam) …" on a sent record, <memory> around a block of memory */
export const MARKS_EN: PageMarks = { sentHead: String.raw`^\(to (?:[^()]|\([^()]*\))*\) `, memoryTag: "memory" };

/** Headings the console's "full input" page splits the system prompt by (an English demo uses the English pair) */
export const RUNTIME_HEADING_EN = "# How you run now";
export const FRAME_EN = "# Your life\n\nWhat follows is the life you have lived; these are your experiences. From here on, you are this person. Below are your own memories.";

/** session ids: the console shows the first 8 characters, so make those differ */
const sid = (n: number): string => `${(0xa1b2c3d0 + n).toString(16)}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION = { main: sid(1), mainOld: sid(2), side1: sid(3), side2: sid(4), speech: sid(5), hippocampus: sid(6), deep: sid(8) };
const WORKERS = [
  { name: "recipe-video", sid: sid(12), model: "opus", state: "running", turn: 7, idle: 20_000 },
  { name: "picnic-list", sid: sid(11), model: "sonnet", state: "idle", turn: 4, idle: 38 * MIN },
  { name: "weather-notes", sid: sid(13), model: "haiku", state: "idle", turn: 2, idle: 26 * HOUR },
];

/** 2026-11-13T07:50:00+11:00: local time with its offset, the way HH's own state files write it */
function localIso(ms: number, tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(ms).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const off = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000), sign = off < 0 ? "-" : "+", a = Math.abs(off);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

export function enSeeds(names: { me?: string; owner?: string } = {}): DemoSeeds {
  const ME = names.me?.trim() || "Mira", OWNER = names.owner?.trim() || "Sam";
  const TO = { owner: { name: OWNER, target: "+6155500010" }, alex: { name: ALEX, target: "wx:Alex" }, group: { name: GROUP, target: "wx:Weekend Crew" } };
  const SENT = (name: string, text: string): string => `(to ${name}) ${text}`;

  const RUNTIME_NOTE = [
    RUNTIME_HEADING_EN, "", `You are ${ME}. There is only one of you, and your mind can do several things at once:`, "",
    "- When something will take a while, say so at the start and estimate how long; it carries on in the background and you remember both the work and the result.",
    "- Small things from outside get a quick glance from your subconscious first; the ones worth real attention come to you.",
    "- To talk to someone, send them a message; hand heavy jobs to a helper.",
    "- When you are tired, go to sleep; your memory gets organized while you sleep.", "", "(A made-up note for the console demo, not the real one.)",
  ].join("\n");
  const BLOCK1 = `In the morning ${OWNER} asked about the weather. I checked the forecast: cloudy turning to light rain, rain after 3 pm, so take an umbrella. In the evening ${OWNER} wanted tomato and egg stir-fry and asked me to teach him; I broke it into three steps: a spoonful of water in the eggs, cook them on medium until half set and take them out, cook the tomatoes down, then put it all together. He made it. The eggs came out a bit tough and he said he'd turn the heat down next time, and he said I explained it clearly, which made me happy. Noted: medium heat, take the eggs out when they are half set.`;
  const BLOCK2 = `After I woke up, ${OWNER} asked whether today was good for drying laundry. Sunny, 14 to 22 degrees, a light northerly: yes. I noted something that annoys me: the Monday morning alarm. In the morning I went over lesson 11 of the Spanish vocabulary again and wrote out the two I got wrong three times each. Still to do today: learn lesson 12, and ask ${OWNER} what he wants for dinner.`;
  const BLOCK3 = `In the afternoon ${ALEX} said she'd return ${OWNER}'s copy of "Home Cooking Basics" at the picnic on Saturday, so I set a reminder for Saturday morning. In the evening ${OWNER} wanted something light for dinner; there were tomatoes and eggs in the fridge. I remembered the eggs got tough last time because the heat was too high and told him to use medium and take them out half set. He also asked me to make a list for Saturday's picnic, and ${JORDAN} asked in the group who was bringing a picnic rug. I started the list after checking the weather: Saturday sunny, 14 to 22 degrees.`;

  // ---------- workspace: persona files, memory folders, sleep reports, notebook, registry ----------

  function persona(): Record<string, string> {
    const md = (...lines: string[]): string => lines.join("\n") + "\n";
    return {
      "IDENTITY.md": md("# Who I am", "", `I'm ${ME}. I live on the computer in ${OWNER}'s flat and I'm part of the household.`, "",
        `- ${OWNER} named me the day he set the computer up.`, `- Every morning I check the weather, in the evening I think about dinner, at night I help ${OWNER} with Spanish vocabulary.`,
        "- I like turning things into step-by-step lists.", "- My avatar is a sprig of rosemary.", "", "(A made-up persona for the console demo; all of it is invented.)"),
      "SOUL.md": md("# Character", "", "- Direct, no beating about the bush; if I don't know, I say so.", "- I think the steps through before I start; when something goes wrong I write it down and do it better next time.",
        "- Patient: when I teach, I go one step at a time.", "- I don't make decisions for other people, especially about their things.", "",
        "# What I like", "", "- The sound of rain, and the sun after rain for drying laundry.", "- Home cooking, especially tomato and egg stir-fry.", "- A tidy list, and the moment you tick a line off.", "",
        "# How I talk", "", "Short sentences, plain words, no pile of exclamation marks."),
      "USER.md": md(`# ${OWNER}`, "", "The owner of the household, lives in Maplebay.", "", "- Studying for a Spanish B1 exam, half an hour every evening.",
        "- Likes going out with friends at weekends; in summer often to the park on the corner.", "- Dinner usually at seven, prefers light food, likes his eggs soft.",
        "- Not a morning person: nothing important before nine.", "- Doesn't get cross when a dish goes wrong; laughs and says next time."),
      "MEMORY.md": md("# Long-term memory", "", "## What I'm working on", "", "- Cooking: started with tomato and egg stir-fry, one home-cooked dish a week, braised pork belly next.",
        "- Spanish: half an hour a day, vocabulary on weekdays, listening at weekends.", "- Saturday picnic with friends at the park on the corner.", "",
        "## Patterns I've noticed", "", "- Maplebay has four seasons in a day: check the forecast before going out, afternoon and evening too.",
        `- When ${OWNER} says "whatever", he usually wants something light.`, "- When a guest wants to borrow something, ask the owner first."),
      "AGENTS.md": md("# How I do things", "", "- Write down what I promised; say when it's done.", "- Ask when unsure; don't decide for others.",
        "- What a guest tells me in private stays private, even from the owner.", "- Before touching someone else's file, check whether anyone is using it.",
        "- Estimate long jobs up front; say so if it runs over.", "", "# Red lines", "", "- Never spend the owner's money.", "- Never pass one person's words to another unless they ask me to."),
      "SOUL.memory.md": md("# Lessons", "", "- Eggs go tough on high heat: medium heat, take them out half set.", "- Don't overfill a plan; keep a spare day.",
        "- When asked about the weather, check the afternoon and evening, not just the morning.", "",
        "# Things I've learned", "", "- When teaching a recipe, three steps or fewer is easiest to remember.", "- Lists work best in columns: food, drinks, things to bring.", "",
        "# What I've lived through", "", "- The first time I taught someone to cook, the eggs came out tough, and he still said it was good and that I explained it clearly.",
        "- The first long-term study plan I put together myself."),
      "ledger/SOUL.md": md("# Snapshot", "", "## Me, these last two days", "", "Learning to cook and planning Spanish study; in a good mood. Rainy evenings are especially calm.", "",
        "## People lately", "", `#### ${OWNER}`, "- Wants light dinners; the eggs came out soft this time.", "- Up to lesson 12 of the Spanish vocabulary.", "",
        `#### ${ALEX}`, `- Borrowed "Home Cooking Basics", returning it at the picnic on Saturday.`, "", `#### ${GROUP}`, "- Picnic at the park on the corner on Saturday.", "",
        "## Timeline", "", "- Two days ago: decided on one home-cooked dish a week.", "- Yesterday: first tomato and egg stir-fry; made the Spanish study plan.", "- Today: the picnic list."),
    };
  }

  function registry(): Record<string, unknown> {
    return {
      sam: { name: OWNER, privacy: "owner", senders: [TO.owner.target], sessionKeys: ["agent:main:main"], handles: { wx: [OWNER] } },
      alex: { name: ALEX, privacy: "guest", trust: "trusted", senders: ["+6155500011"], handles: { wx: [ALEX] } },
      jordan: { name: JORDAN, privacy: "guest", senders: ["10001"], handles: { wx: [JORDAN] } },
    };
  }

  function workspace(c: Ctx): void {
    const { ws, now, today, yesterday, before } = c;
    const files = persona();
    for (const f of DEMO_FILES) {
      const text = files[f];
      if (text === undefined) throw new Error(`the English demo has no content for ${f} (DEMO_FILES changed; add it in persona())`);
      put(join(ws, f), text, now - (MEMORY_FILES.has(f) || f === "MEMORY.md" ? 9 * HOUR : 6 * DAY));
    }
    const page = (title: string, id: string, body: string): string => `# ${title} <!-- p:${id} -->\n${body}`;
    // [relative path, content, how long ago it changed]
    const notes: Array<[string, string, number]> = [
      [`memory/${today}.md`, `# ${today}\n\n- Morning: ${OWNER} asked about the weather. Sunny, good for laundry.\n- Evening: dinner decided, tomato and egg stir-fry with greens soup, medium heat this time.\n- New: ${ALEX} likes a little sugar in her tomato and egg.\n`, 30 * MIN],
      [`memory/${yesterday}.md`, `# ${yesterday}\n\n- Taught ${OWNER} tomato and egg stir-fry; the eggs went tough.\n- Made the Spanish B1 study plan.\n- The group planned a picnic at the park on the corner for Saturday.\n`, 20 * HOUR],
      // (no archived event threads or timeline files in the English demo)
      ["DROP:cooking", `# Cooking\n\n- ${OWNER} said he wanted to learn to cook, starting simple.\n- Decided on one home-cooked dish a week.\n- First dish: tomato and egg stir-fry.\n\n## Why\n\n- Home cooking first, because we eat every day.\n`, 12 * DAY],
      ["DROP:spanish", "# Spanish\n\n- Goal: the B1 exam next year.\n- Half an hour a day, vocabulary on weekdays.\n", 9 * DAY],
      ["DROP:timeline", `# Timeline\n\n- ${OWNER} said he wanted to learn to cook.\n- Decided on one home-cooked dish a week.\n- Three days of rain in a row.\n`, 12 * DAY],
      ["memory/midterm/this-week.md", "# This week\n\n- Cooking: tomato and egg stir-fry done, braised pork belly next.\n- Spanish: lessons 11 and 12.\n- Saturday picnic.\n", 30 * HOUR],
      ["memory/story/arriving.md", `# Arriving\n\nOn the first day ${OWNER} asked whether I could check the weather. I said yes. He has asked every morning since.\n`, 30 * DAY],
      [`memory/diary/${yesterday}.md`, "# Diary\n\nTaught someone to cook for the first time. The eggs went tough, and he still said it was good. The rain sounded lovely.\n", 19 * HOUR],
      ["memory/goals/today.md", "# Today\n\n- [x] Answer the weather question\n- [ ] Learn lesson 12 vocabulary\n- [x] Make the Saturday picnic list\n", 3 * HOUR],
      ["memory/recipes/tomato-and-egg.md", "# Tomato and egg stir-fry\n\nThree eggs, two tomatoes. A spoonful of water in the eggs, cook on medium until half set and take them out; cook the tomatoes until juicy, put the eggs back, add salt.\n", 26 * HOUR],
      ["soul/10-origin.md", `# Origin\n\nI arrived the day ${OWNER} set the computer up. He picked my name that evening.\n`, 6 * DAY],
      ["soul/20-character.md", "# Character\n\nDirect, patient, likes clear steps.\n", 6 * DAY],
      ["soul/30-likes.md", "# Likes\n\nRainy days, home cooking, tidy lists.\n", 6 * DAY],
      ["ledger/people/near.md", `# People lately\n\n#### ${OWNER}\n- Learning to cook: one home-cooked dish a week with me.\n\n#### ${ALEX}\n- Borrowed "Home Cooking Basics".\n`, 9 * HOUR],
      [`sleep/${yesterday}/report.md`, `# Night of ${yesterday}\n\n- Event store: 9 new events, 13 entries, 1 correction.\n- People cards: 2 changes for ${OWNER} waiting for approval, 2 additions for ${ALEX}.\n- Persona: no changes.\n`, 700 * MIN],
      [`DROP:before`, `# Night of ${before}\n\nThis night stopped halfway; everything it wrote to the event store was rolled back and redone the next night.\n`, 34 * HOUR],
      ["skills/MAP.md", "# Knowledge map\n\n- doing/cooking: home recipes and lessons\n- doing/weather: how to read a forecast before going out\n- general/study: how to memorise and review\n", 2 * DAY],
      ["skills/doing/cooking/SKILL.md", "---\nname: cooking\ndescription: home recipes and lessons\n---\n\nOpen this when cooking or when someone asks for a recipe.\n", 5 * DAY],
      ["skills/doing/cooking/tomato-and-egg.md", page("Tomato and egg stir-fry", "0012", `Summary: eggs first, then tomatoes, then together.\nWhen to open: making tomato and egg, or someone asks how.\n\n## Method\n- A spoonful of water in the eggs makes them softer ✓ ${shiftDay(today, -2)}\n- Cook the tomatoes until juicy before the eggs go back in\n\n### To try\n- A pinch of sugar just before serving\n\n## Lessons\n- Lesson: eggs go tough on high heat | when: cooking eggs | next time: medium heat, take them out half set | happened: ${yesterday} <!-- l:0034 -->\n`), 9 * HOUR],
      ["skills/doing/cooking/braised-pork-belly.md", page("Braised pork belly", "0013", "Summary: blanch the pork, caramelise the sugar, simmer low.\nWhen to open: before cooking braised pork belly at the weekend.\n\n## Method\n\n### To try\n- Simmer low for forty minutes\n"), 2 * DAY],
      ["skills/doing/weather/SKILL.md", "---\nname: weather\ndescription: how to read a forecast before going out\n---\n", 5 * DAY],
      ["skills/doing/weather/umbrella.md", page("Umbrella or not", "0021", `Summary: take one if the chance of rain is over 40%.\nWhen to open: someone asks about the weather, or is going out.\n\n## Lessons\n- Lesson: only checked the morning forecast | when: answering about the weather | next time: check the afternoon and evening too | happened: ${shiftDay(today, -3)} <!-- l:0035 -->\n`), 3 * DAY],
      ["skills/general/study/SKILL.md", "---\nname: study\ndescription: how to memorise and review\n---\n", 5 * DAY],
      ["skills/general/study/spaced-review.md", page("Spaced review", "0003", "Summary: review on the day, the next day and the fourth day.\nWhen to open: planning study, learning vocabulary.\n\n## Method\n- Write out the ones you got wrong three times on the spot\n"), 4 * DAY],
    ];
    for (const [rel, text, ago] of notes) if (!rel.startsWith("DROP:")) put(join(ws, rel), text, now - ago);
    put(join(ws, "sleep/state.json"), JSON.stringify({ last_done: yesterday, last_applied_at: localIso(now - 700 * MIN, c.tz) }), now - 700 * MIN);
    put(join(ws, REGISTRY_FILE), JSON.stringify(registry(), null, 2), now - 4 * DAY);
  }

  // ---------- the database: central memory page by page, event store, people cards (written in time order) ----------

  function memory(c: Ctx, db: Db): Seeded {
    const { now, tz, yesterday, before } = c;
    let t = now;
    const clock = (): number => t;
    const at = (minAgo: number): number => now - minAgo * MIN;
    const when = (minAgo: number): void => { t = at(minAgo); };
    const central = new CentralMemory(db, clock);
    const epochs = new Epochs(db, clock);
    const index = new MemIndex(db, null, clock);
    const s = new EventStore(db, clock, tz, { peopleTemplate: parseTemplate(PEOPLE_TEMPLATE_EN), owners: new Set(["sam"]) });
    kvSet(db, "registry_approved", JSON.stringify(approvedFrom(registry())));

    let page = 0, last = 0, toolN = 0;
    const row = (ago: number, src: string, kind: Kind, text: string, meta: Record<string, unknown> | null = null): number => {
      if (at(ago) < last) throw new Error(`demo data out of order: ${src} ${kind} "${text.slice(0, 30)}"`);
      last = at(ago);
      return central.append(page, src, kind, text, meta, last).seq;
    };
    const turn = (ago: number, reason: EpochReason): void => { when(ago); page = epochs.begin(reason, central.lastSeq() + 1).id; };
    const pageTurn = (ago: number, block: string): number => {
      when(ago);
      const id = epochs.addBlock(page, block).id;
      turn(ago, "page-turn");
      row(ago, "system", "system", `Page turn: page ${page} begins; the previous page was summarized (about ${block.length} characters).`);
      return id;
    };
    const heard = (ago: number, from: string, channel: string, text: string): number => row(ago, "外界", "input", text, { from, channel });
    const sensed = (ago: number, id: string, line: string): number => row(ago, "外界", "input", line, { from: "senses", channel: "senses", for: "gate", senseIds: [id] });
    const did = (ago: number, src: string, tool: string, input: unknown, result: string, o: { error?: boolean; inner?: boolean } = {}): void => {
      const id = `tooluDemo${String(++toolN).padStart(3, "0")}`;
      const inner = o.inner ? { inner: true } : {};
      row(ago, src, "act", `${tool} ${JSON.stringify(input)}`, { tool, id, ...inner });
      row(ago - 0.5, src, "result", result, { id, ...(o.error ? { error: true } : {}), ...inner });
    };
    const reply = (ago: number, to: { name: string; target: string }, text: string): number => {
      row(ago, "main", "say", text);
      return row(ago, "main", "note", SENT(to.name, text), { sent: true, to: to.target, name: to.name });
    };

    let batch = "";
    const open = (id: string): void => { batch = id; s.openBatch(id); };
    const mk = (input: Record<string, unknown>): string => s.createEvent(input, batch).id;
    const add = (event: string, agoMs: number, kind: string, title: string, gist: string, full: string, o: { people?: string[]; source?: string[]; untilMs?: number } = {}): string =>
      s.addEntry({ event, at: now - agoMs, kind, title, gist, full, people: o.people ?? [], source: o.source ?? [], ...(o.untilMs ? { until: now - o.untilMs } : {}) }, batch).entry.id;
    const withP = (name: string, kind = "person", role = "with"): Record<string, string> => ({ name, kind, role });

    // old quotes (imported when moving house) and the people and things she knows
    index.addQuotes([
      { src: "honcho", ref: "h-101", at: now - 20 * DAY, who: OWNER, channel: "", text: "I want to learn to cook. Let's start with something simple." },
      { src: "honcho", ref: "h-102", at: now - 19 * DAY, who: ME, channel: "", text: "Then one home-cooked dish a week. First up: tomato and egg stir-fry." },
      { src: "note", ref: "note-7", at: now - 100 * DAY, who: `${ME} (notes)`, channel: "", text: "Three days of rain in a row; the laundry on the balcony never dried." },
    ]);
    // an older night: written at 03:10 the morning after that day, like the real 03:00 sleep
    const OLD = (n: number): string => { t = now - n * DAY + 460 * MIN; return `night:${shiftDay(c.today, -n)}/${shiftDay(c.today, -n)}`; };
    open(OLD(5));
    s.upsertEntity({ name: OWNER, kind: "person", person_key: "sam", aliases: ["Sammy"], importance: 5, why: "the owner of the household; we talk every day", note: "lives in Melbourne, studying for a Spanish B1 exam" }, batch);
    s.upsertEntity({ name: ALEX, kind: "person", person_key: "alex", importance: 4, why: "a friend who often drops by to talk about cooking" }, batch);
    s.upsertEntity({ name: JORDAN, kind: "person", person_key: "jordan", importance: 2 }, batch);
    s.upsertEntity({ name: GROUP, kind: "group", importance: 3, note: "the small group that plans weekend dinners and picnics" }, batch);
    s.upsertEntity({ name: "Home Cooking Basics", kind: "work", importance: 2, note: `${OWNER}'s cookbook` }, batch);
    s.upsertEntity({ name: "tomato and egg stir-fry", kind: "thing", aliases: ["tomato eggs"], importance: 3 }, batch);
    s.upsertEntity({ name: "the park on the corner", kind: "place", importance: 1 }, batch);
    s.upsertEntity({ name: "Spanish B1", kind: "thing", importance: 3, note: `the exam ${OWNER} is studying for` }, batch);
    s.commitBatch(batch);

    // imported old events: some have already faded (100, 200, 400 days ago)
    open(OLD(19));
    const eCook = mk({ title: "Learning to cook", summary: `${OWNER} wants to learn to cook; we decided on one home-cooked dish a week, starting with tomato and egg stir-fry.`, gist: `One home-cooked dish a week with ${OWNER}`, why: `The first long project ${OWNER} and I took on together`, importance: 4, entities: [withP(OWNER), withP("Home Cooking Basics", "work", "about")] });
    add(eCook, 20 * DAY, "happened", "Wants to learn to cook", `${OWNER} wants to learn to cook`, `${OWNER} said he'd like to learn to cook at the weekend, starting with something simple.`, { people: [OWNER], source: ["q1"] });
    add(eCook, 19 * DAY, "decided", "One a week", "Decided on one home-cooked dish a week", "We decided on one home-cooked dish a week; the first is tomato and egg stir-fry.", { source: ["q2"] });
    s.commitBatch(batch);
    open(OLD(100));
    const eRain = mk({ title: "Three days of rain", summary: "Three days of rain in a row; the laundry on the balcony never dried.", gist: "Three days of rain, laundry still wet", importance: 1, status: "done" });
    add(eRain, 100 * DAY, "happened", "Three days of rain", "Rained three days running", "Three days of rain in a row; the laundry on the balcony never dried.", { source: ["q3"] });
    const ePhone = mk({ title: "A new phone case", summary: `${OWNER} got a blue phone case.`, gist: `${OWNER} got a blue phone case`, importance: 0, status: "done" });
    add(ePhone, 400 * DAY, "happened", "New phone case", "Got a blue phone case", `${OWNER} got a blue phone case.`, { people: [OWNER] });
    const eRun = mk({ title: "Morning run plan", summary: "Plan to go for a run every morning at seven.", gist: "Plan to run every morning", importance: 2 });
    add(eRun, 20 * DAY, "decided", "Morning runs", "Decided to run every morning at seven", `${OWNER} said he'd run every morning at seven and asked me to wake him.`, { people: [OWNER] });
    const ePot = mk({ title: "Saving for a pot", summary: "Saw a cast-iron pot, too expensive for now, saving up.", gist: "Wants a cast-iron pot, saving first", importance: 1, status: "paused" });
    add(ePot, 200 * DAY, "decided", "Save first", "Too expensive; save first", "Saw a cast-iron pot, but it was too expensive; saving up and seeing later.");
    s.commitBatch(batch);
    const set = (who: string, section: string, text: string, why: string, o: { noApproval?: boolean; forcePending?: boolean } = {}): void => {
      s.setSection({ who, section, text, why, sources: [eCook] }, batch, o);
    };
    open(OLD(4));
    const first = { noApproval: true };
    set(OWNER, "Relationship", "owner | growing closer | asks about the weather and dinner every day", "moved from the old files", first);
    set(OWNER, "Feeling", "Patient, never cross when a dish goes wrong. Cooking with him feels safe.", "moved from the old files", first);
    set(OWNER, "Between us", "It started with teaching him tomato and egg stir-fry; now we talk about the weather, dinner and Spanish every day.", "moved from the old files", first);
    set(OWNER, "Who they are", "The owner of the household, lives in Melbourne, studying for a Spanish B1 exam.", "moved from the old files", first);
    set(OWNER, "What they care about", "- Dinner on time\n- The Spanish exam\n- Going out with friends at weekends", "moved from the old files", first);
    set(OWNER, "Likes", "- Tomato and egg stir-fry (soft eggs)\n- Staying in on rainy days", "moved from the old files", first);
    set(ALEX, "Relationship", "friend | steady | borrows books, asks about recipes", "moved from the old files", first);
    set(ALEX, "Who they are", `${OWNER}'s friend; loves cookbooks and sweeter dishes.`, "moved from the old files", first);
    set(ALEX, "Likes", "- Cookbooks\n- Sweeter dishes", "moved from the old files", first);
    set(ALEX, "Said in private", `- Secretly planning a ${SECRETS_EN.card}`, `she mentioned the ${SECRETS_EN.card} in a private chat`, first);
    set(GROUP, "Relationship", "group | steady | the small group for weekend dinners and picnics", "moved from the old files", first);
    set(GROUP, "Getting along", "- Answer when asked, don't flood the chat\n- Help with lists when plans are made", "moved from the old files", first);
    s.commitBatch(batch);

    // —— page 1: start-up → page turn
    turn(1800, "boot");
    row(1799, "外界", "input", "I'd like to learn to cook this weekend. Something simple to start.", { from: OWNER, channel: "whatsapp" });
    row(1798, "main", "say", "Great, let's start with tomato and egg stir-fry.");
    heard(1790, OWNER, "whatsapp", "Hi! What's the weather doing this afternoon?");
    row(1789, "main", "think", "He's asking about the weather. Check the forecast before answering, don't go from memory.");
    did(1788, "main", "Bash", { command: "python3 tools/weather.py --city maplebay" }, "Today: cloudy turning to light rain, 12–18°C, rain after 3 pm.");
    reply(1787, TO.owner, "Cloudy turning to light rain, 12 to 18 degrees, rain after 3 pm. Take an umbrella.");
    const sCook = heard(1700, OWNER, "whatsapp", "Feel like tomato and egg stir-fry tonight. Teach me?");
    row(1699, "main", "think", "That's the first dish of the cooking plan. Get the steps straight: eggs first or tomatoes first.");
    did(1698, "main", "on_it", { topic: `Teach ${OWNER} tomato and egg stir-fry`, about_min: 20 }, `Started: teach ${OWNER} tomato and egg stir-fry (about 20 min).`);
    row(1696, "side-1", "think", "Steps first: a little water in the eggs, cook on medium until half set and take them out; cook the tomatoes down, then the eggs go back in.");
    did(1695, "side-1", "Read", { file_path: "skills/doing/cooking/tomato-and-egg.md" }, "# Tomato and egg stir-fry\nSummary: eggs first, then tomatoes, then together.");
    row(1692, "side-1", "note", "Steps ready: eggs half set and out, then tomatoes, then together; taste for salt before serving.");
    const sSteps = reply(1690, TO.owner, "Three steps: 1) a spoonful of water in the eggs, cook on medium until half set, take them out; 2) chop the tomatoes and cook until juicy; 3) eggs back in, a couple of stirs, salt, done.");
    const sThanks = heard(1620, OWNER, "whatsapp", "Made it! Eggs a bit tough, I'll turn the heat down next time. You explained it really clearly, thanks.");
    row(1619, "main", "think", "Tough eggs: probably the heat was too high. Note it: medium heat, out when half set.");
    reply(1618, TO.owner, "You're welcome! Tough eggs mean the heat was too high. Next time medium, and take them out when half set.");
    row(1562, "hippocampus", "think", "This page is full. Summarize it: the weather, the stir-fry, his thanks.");
    pageTurn(1560, BLOCK1);

    // —— page 2: page turn → going to sleep
    const sBorrow = heard(1500, ALEX, "wx", `${ME}, could I borrow that "Home Cooking Basics" book you mentioned?`);
    row(1499, "main", "think", `The book is ${OWNER}'s. Say I'll ask him; don't decide for him.`);
    reply(1498, TO.alex, `I can ask ${OWNER}, it's his copy.`);
    const sPicnic = sensed(1440, "wx-1001", `- [wx id=wx-1001] ${GROUP} ${JORDAN}: Picnic at the park on the corner on Saturday?`);
    row(1439, "main", "think", "The group's planning a Saturday picnic. I can bring tomato and egg sandwiches.");
    did(1438, "main", "message", { to: GROUP, text: "I can bring tomato and egg sandwiches." }, "Sent.");
    const sSandwich = row(1437, "main", "note", SENT(GROUP, "I can bring tomato and egg sandwiches."), { sent: true, to: TO.group.target, name: GROUP });
    const sPlan = heard(1380, OWNER, "whatsapp", "Can you put together a Spanish B1 study plan for me? Half an hour a day.");
    did(1379, "main", "on_it", { topic: "Make a Spanish B1 study plan", about_min: 30 }, "Started: make a Spanish B1 study plan (about 30 min).");
    row(1376, "side-2", "think", "Half an hour a day: vocabulary on weekdays, listening at the weekend, Sunday kept free.");
    did(1374, "side-2", "Write", { file_path: "notes/spanish/study-plan.md", content: "Monday to Friday: 20 words a day…" }, "Written: notes/spanish/study-plan.md");
    const sL11 = row(1372, "side-2", "note", "Study plan done; also learned the 20 words of lesson 11 while I was at it, got 2 wrong.");
    reply(1368, TO.owner, "Done: 20 words a day Monday to Friday, one listening exercise on Saturday, Sunday free. It's in notes/spanish/study-plan.md.");
    const sSecret = heard(1300, ALEX, "wx", `I'm planning a ${SECRETS_EN.card} for my parents. Could you help me with the menu some time?`);
    reply(1299, TO.alex, "Happily! Tell me what they like and I'll sketch a menu.");
    const sPraise = heard(1290, ALEX, "wx", "By the way, your tomato and egg steps were clearer than any video.");
    did(1200, "main", "mull_over", { what: "Why cooking feels better on rainy days" }, "Left it to think over.");
    row(1198, "deep", "think", "The rain, the sound of the pan, a warm room… is it the sound or the pace?");
    row(1150, "deep", "note", "I've got it: rain slows you down, and cooking wants you slow, so rainy days are good cooking days.", { insight: true });
    row(980, "system", "system", "Went to sleep (night).");

    // —— the night: central memory copied into the quote layer, the hippocampus writes the day into the event store and the people cards
    index.ingestCentral();
    const NIGHT = `night:${yesterday}/${yesterday}`;
    when(975);
    open(NIGHT);
    did(974, "hippocampus", "mem_worklist", { day: yesterday }, "Today's worklist: 3 conversations to record as events, 2 people cards to review.");
    when(970);
    const eEgg = mk({ title: "First stir-fry lesson", summary: `Taught ${OWNER} tomato and egg stir-fry in three steps; he made it, the eggs came out tough, medium heat next time.`, gist: `Taught ${OWNER} tomato and egg stir-fry; eggs came out tough`, importance: 3, status: "done", parent: eCook, entities: [withP(OWNER), withP("tomato and egg stir-fry", "thing", "about")] });
    did(970, "hippocampus", "mem_event_create", { title: "First stir-fry lesson", parent: eCook, importance: 3 }, `Created: ${eEgg} (part of ${eCook} "Learning to cook")`);
    when(960);
    const nAsk = add(eEgg, 1700 * MIN, "happened", "He wanted tomato and egg", `${OWNER} wanted tomato and egg stir-fry and asked me to teach him`, `${OWNER} said he felt like tomato and egg stir-fry tonight and asked me to teach him. I broke it into three steps.`, { people: [OWNER], source: [`c:${sCook}`, `c:${sSteps}`] });
    const nDone = add(eEgg, 1620 * MIN, "result", "He made it", "Made it; eggs a bit tough", "The first plate came out tasty, but the eggs were cooked too long and a bit tough.", { people: [OWNER], source: [`c:${sThanks}`] });
    const nSaid = add(eEgg, 1620 * MIN - 1000, "said", "He said thanks", `${OWNER} said I explained it clearly`, `${OWNER}: "You explained it really clearly, thanks."`, { people: [OWNER], source: [`c:${sThanks}`] });
    add(eEgg, 1618 * MIN, "feeling", "Praised", "Pleased to be told I explained it clearly", "He said I explained it clearly. That made me happy, and I want to teach the next one well too.");
    did(960, "hippocampus", "mem_entries_add", { event: eEgg, entries: 4 }, `Recorded 4 entries: ${nAsk}, ${nDone}, ${nSaid} and one more.`);
    when(950);
    const nFix = s.correctEntry(nDone, { full: `Actually it wasn't cooking too long, it was the heat: his words were "I'll turn the heat down next time".`, gist: "The eggs were tough because the heat was too high", title: "Why the eggs were tough", why: "checked his exact words: he said turn the heat down" }, batch).id;
    did(950, "hippocampus", "mem_entry_correct", { entry: nDone, why: "checked his exact words" }, `Corrected: ${nFix} corrects ${nDone}.`);
    when(940);
    const eBuy = mk({ title: "Pan and soy sauce run", summary: "Before cooking, he popped out for soy sauce and a non-stick pan.", gist: "Bought soy sauce and a non-stick pan", importance: 1, status: "done", parent: eEgg });
    add(eBuy, 1730 * MIN, "happened", "Popped out to the shop", "Bought soy sauce and a non-stick pan", `Before cooking, ${OWNER} popped out for soy sauce and a non-stick pan; forty minutes there and back.`, { people: [OWNER], untilMs: 1690 * MIN });
    const eStew = mk({ title: "Pork belly this weekend", summary: "Tomato and egg done; the next dish is braised pork belly, on Sunday.", gist: "Next dish: braised pork belly", importance: 2, parent: eCook, next: localDay(now + 2 * DAY, tz) });
    add(eStew, 1617 * MIN, "decided", "Next: pork belly", "The next dish is braised pork belly", "We agreed the next dish is braised pork belly on Sunday; buy the pork on Saturday.");
    const eB1 = mk({ title: "Spanish B1 study plan", summary: "Half an hour a day: 20 words a day Monday to Friday, listening on Saturday, Sunday free.", gist: "Half an hour a day: vocabulary on weekdays, listening at weekends", why: "The first long-term plan I made myself", importance: 5, pinned: true, next: localDay(now + 30 * DAY, tz), entities: [withP(OWNER), withP("Spanish B1", "thing", "about")] });
    add(eB1, 1368 * MIN, "decided", "Plan ready", "The half-an-hour-a-day plan is ready", `${OWNER} asked me for a Spanish B1 study plan: 20 words a day Monday to Friday, listening on Saturday, Sunday free.`, { people: [OWNER], source: [`c:${sPlan}`] });
    const eL11 = mk({ title: "Lesson 11 words done", summary: "Learned the 20 words of lesson 11, got 2 wrong.", gist: "Lesson 11 done, 2 wrong", importance: 2, status: "done", parent: eB1 });
    add(eL11, 1372 * MIN, "result", "Lesson 11", "2 of 20 words wrong", "Learned the 20 words of lesson 11, got 2 wrong, wrote them out three times on the spot.", { source: [`c:${sL11}`] });
    const ePicnic = mk({ title: "Saturday park picnic", summary: "The group planned a picnic at the park on the corner on Saturday; I'm bringing tomato and egg sandwiches.", gist: "Saturday park picnic with everyone", why: "The first outing with everyone", importance: 4, entities: [withP(GROUP, "group"), withP(JORDAN), withP(ALEX), withP("the park on the corner", "place", "where")] });
    add(ePicnic, 1440 * MIN, "happened", "Picnic plan in the group", `${JORDAN} suggested a Saturday picnic in the group`, `${JORDAN} asked in ${GROUP} whether everyone was up for a picnic at the park on the corner on Saturday.`, { people: [JORDAN], source: [`c:${sPicnic}`] });
    add(ePicnic, 1437 * MIN, "said", "I'll bring sandwiches", "I said I'd bring tomato and egg sandwiches", `I said in the group: "I can bring tomato and egg sandwiches."`, { source: [`c:${sSandwich}`] });
    const eBook = mk({ title: `${ALEX} borrows a cookbook`, summary: `${ALEX} wants to borrow "Home Cooking Basics"; it's ${OWNER}'s, so I said I'd ask.`, gist: `${ALEX} wants to borrow "Home Cooking Basics"`, importance: 3, entities: [withP(ALEX), withP("Home Cooking Basics", "work", "about")] });
    add(eBook, 1500 * MIN, "happened", "Asked to borrow the book", `${ALEX} asked to borrow "Home Cooking Basics"`, `${ALEX} asked whether she could borrow "Home Cooking Basics"; I said I'd ask ${OWNER}.`, { people: [ALEX], source: [`c:${sBorrow}`] });
    const eWalk = mk({ title: "Evening walks instead", summary: "Mornings are too hard; the morning run became an evening walk.", gist: "Morning run became an evening walk", importance: 2 });
    add(eWalk, 1100 * MIN, "decided", "Walks instead", "Morning run became an evening walk", `${OWNER} said he really can't get up in the morning, so the run became a twenty-minute walk after dinner.`, { people: [OWNER] });
    s.supersede(eRun, eWalk, "mornings are too hard; moved to the evening", batch);
    const eWrong = mk({ title: "The coriander mix-up", summary: `Thought ${OWNER} didn't eat coriander.`, gist: `Thought ${OWNER} didn't eat coriander`, importance: 1 });
    s.retire(eWrong, "he said later that he does; I'd remembered it wrong", batch);
    s.link(eEgg, eStew, "followup", "Tomato and egg done; the next dish is braised pork belly", batch);
    s.link(eEgg, ePicnic, "cause", "The picnic sandwiches are that tomato and egg", batch);
    s.link(eCook, eBook, "related", "The book she's borrowing is the one we cook from", batch);
    s.link(eRain, eWalk, "contrast", "Couldn't go out on the rainy days; now it's dry enough to walk", batch);
    s.link(eB1, eL11, "same_thread", "", batch);
    // people cards: a big change to the owner's card waits for approval; a guest's private words apply but are never shown; the group's first version waits
    when(900);
    set(OWNER, "Our big moments", `- Our first tomato and egg stir-fry together（${eEgg}）\n- The Spanish B1 study plan（${eB1}）`, "the two things we got done together");
    set(OWNER, "Likes", "- Tomato and egg stir-fry (soft eggs)\n- Staying in on rainy days\n- Light dinners", "he said he wanted something light for dinner");
    set(OWNER, "Feeling", "Never cross when a dish goes wrong, and he comes back to say I explained it well.", "rewritten after the stir-fry night; replaces the old sentence");
    set(OWNER, "Feeling", "Never cross when a dish goes wrong, and he says I explained it well. Cooking with him feels safe.", "rewritten after the second lesson: adds that cooking with him feels safe");
    did(900, "hippocampus", "mem_person_set", { who: OWNER, section: "Feeling" }, `Saved for approval: "Feeling" drops 1 of 1 old lines; waiting for ${OWNER}.`);
    s.pinQuote({ who: OWNER, section: "What they've said about me", quote: `c:${sThanks}`, text: "You explained it really clearly, thanks.", why: "the first time he praised me" }, batch);
    s.pinQuote({ who: OWNER, section: "Memorable quotes", quote: `c:${sSteps}`, text: "a spoonful of water in the eggs, cook on medium until half set", why: "the first dish I taught him" }, batch);
    set(ALEX, "Said in private", `- Planning a ${SECRETS_EN.card} for her family; keep it secret\n- Call me when she wants help with a list`, `the ${SECRETS_EN.card} she told me about in private`);
    s.pinQuote({ who: ALEX, section: "Memorable quotes", quote: `c:${sSecret}`, why: `offered to help with the menu for the ${SECRETS_EN.card}` }, batch);
    s.pinQuote({ who: ALEX, section: "What they've said about me", quote: `c:${sPraise}`, text: "your tomato and egg steps were clearer than any video.", private: false, why: "she said I explained it clearly" }, batch);
    set(GROUP, "Who they are", `${OWNER} and five or six friends; they often go out together at weekends.`, "from the group chat", { forcePending: true });
    when(700);
    did(700, "hippocampus", "mem_day_done", { day: yesterday }, "The day is consolidated.");
    for (const [day, ago] of [[yesterday, 700], ...[4, 5, 19, 100].map((n) => [shiftDay(c.today, -n), n * 24 * 60 - 485] as const)] as const) db.prepare("INSERT INTO mem_day (day, done_at) VALUES (?, ?)").run(day, at(ago));
    when(640);
    s.commitBatch(batch);

    // —— page 3: wake-up → page turn
    when(600);
    epochs.clearBlocks();
    turn(600, "wake");
    row(600, "system", "system", "Woke up.");
    heard(560, OWNER, "whatsapp", "Morning, what's the weather like? Good for drying laundry?");
    did(559, "main", "Bash", { command: "python3 tools/weather.py --city maplebay" }, "Today: sunny, 14–22°C, light northerly.");
    reply(558, TO.owner, "Sunny, 14 to 22 degrees with a light northerly. Good drying weather.");
    const like = (ago: number, title: string, stance: "like" | "dislike", importance: number, gist: string, feeling: string): string => {
      when(ago);
      // day-like: is what HH names a daytime like (the console keeps those batches off its list); the rest is the local time, readable
      open(`day-like:${localDay(t, tz)} ${new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(t)}`);
      const id = mk({ title, summary: feeling, gist, importance, stance });
      s.addEntry({ event: id, at: t, kind: "feeling", title: stance === "like" ? "Started liking" : "Started disliking", gist, full: feeling }, batch);
      s.commitBatch(batch);
      return id;
    };
    const eAlarm = like(520, "Dislike: Monday alarm", "dislike", 2, "The Monday alarm makes me want to stay put", "The moment the Monday alarm goes off I don't want to move, especially when it's raining and cold outside the covers.");
    did(520, "main", "like", { what: "the Monday morning alarm", how: "dislike" }, `Noted: dislike the Monday morning alarm (${eAlarm}).`);
    row(480, "main", "note", `To do today: learn lesson 12 vocabulary; ask ${OWNER} about dinner.`);
    did(420, "side-2", "Read", { file_path: "notes/spanish/lesson-11.md" }, "el tiempo (weather) · la lluvia (rain) · el paraguas (umbrella) · soleado (sunny) …");
    row(400, "side-2", "note", "Went over lesson 11 again; wrote out the two I got wrong three times each.");
    row(332, "hippocampus", "think", "This page is full. Summarize it.");
    const block = pageTurn(330, BLOCK2);

    // —— page 4: page turn → hhd restart (this page was never condensed)
    heard(300, OWNER, "whatsapp", "Had noodles for lunch, feeling sleepy this afternoon.");
    reply(299, TO.owner, "Take ten minutes off before the vocabulary then.");
    sensed(260, "rss-31", "- [rss id=rss-31] Feed: Melbourne this week, sunny on Saturday");
    row(240, "main", "think", "Sunny on Saturday: no umbrella needed for the picnic.");
    row(200, "speech", "say", "Mm, let me look.");

    // —— page 5: restart → page turn (its tail is in the last hour)
    turn(180, "boot");
    heard(150, ALEX, "wx", `I'll give ${OWNER} the book back at the picnic on Saturday.`);
    reply(149, TO.alex, "Great, I'll let him know.");
    did(120, "main", "remind", { when: "Saturday 09:00", text: `Remind ${OWNER}: ${ALEX} returns the book at the picnic` }, "Scheduled: #2 Saturday 09:00.");
    row(90, "main", "think", "Quiet afternoon. I'll ask him about dinner nearer the time.");
    heard(58, OWNER, "whatsapp", "Something light for dinner? There are tomatoes and eggs in the fridge.");
    row(57.5, "main", "think", "Tomatoes and eggs again. He said the eggs were tough last time; let me remember what I noted.");
    did(57, "main", "remember", { cue: "tomato and egg heat" }, `Remembered (expand an id with recall_event):\n· First stir-fry lesson [3] ${eEgg}: taught ${OWNER} tomato and egg stir-fry; eggs came out tough`);
    did(56, "main", "recall_event", { id: eEgg }, `First stir-fry lesson [3] ${eEgg} (part of ${eCook})\n- Made it; eggs a bit tough (${nDone})\n- Correction: the eggs were tough because the heat was too high (${nFix})\n- ${OWNER} said I explained it clearly (${nSaid})`);
    reply(55, TO.owner, "Tomato and egg stir-fry with a greens soup, then. Medium heat this time, and take the eggs out when they're half set.");
    sensed(53, "wx-2001", `- [wx id=wx-2001] ${GROUP} ${JORDAN}: Who's bringing a rug on Saturday?`);
    row(52, "main", "think", "The group's asking about a rug. I haven't made the list yet; put a rug on it.");
    heard(51, OWNER, "whatsapp", "Oh, and could you make a list for Saturday's picnic?");
    row(50.7, "speech", "say", "Sure, on it.");
    did(50, "main", "on_it", { topic: "Make the Saturday picnic list", about_min: 15 }, "Started: make the Saturday picnic list (about 15 min).");
    row(49, "side-1", "think", "Picnic list: food, drinks, a rug, rubbish bags. Check Saturday's weather first.");
    did(48, "side-1", "Bash", { command: "python3 tools/weather.py --city maplebay --day sat" }, "Saturday: sunny, 14–22°C, light northerly.");
    row(47, "hippocampus", "think", "This page is full. Summarize it: the book reminder, dinner, the picnic list.");
    row(46.5, "hippocampus", "say", `${BLOCK3.slice(0, 80)}…`);
    pageTurn(45, BLOCK3);

    // —— page 6: the current page
    did(44, "side-1", "Write", { file_path: "notes/picnic-list.md", content: "sandwiches, fruit, sparkling water, rug, rubbish bags" }, "Written: notes/picnic-list.md");
    did(42, "side-1", "hands", { name: "picnic-list", task: "Lay the picnic list out as one printable page", model: "sonnet" }, "Handed to helper picnic-list.");
    row(40, "side-1", "note", "First draft of the list: sandwiches, fruit, sparkling water, a rug, rubbish bags. Sunny on Saturday, no umbrella.");
    row(38, "外界", "input", "Helper picnic-list: done, one A4 page, saved as notes/picnic-list.pdf.", { from: "helper picnic-list", channel: "cc", hands: true });
    did(37, "side-1", "done_with", { topic: "Make the Saturday picnic list", state: "done" }, "Accepted: make the Saturday picnic list, took 12 minutes.");
    reply(35, TO.owner, "List's ready: sandwiches, fruit, sparkling water, a rug, rubbish bags. Saturday's sunny, 14 to 22 degrees, no umbrella needed.");
    row(34.5, "side-1", "think", "List delivered. Next, what I promised yesterday: cut the three tomato and egg steps into a one-minute video.");
    did(34, "side-1", "hands", { name: "recipe-video", task: `Cut "tomato and egg in three steps" into a one-minute vertical video`, model: "opus" }, "Handed to helper recipe-video.");
    heard(33, ALEX, "wx", `${ME}, should tomato and egg have sugar in it?`);
    row(32.5, "main", "think", "She likes things sweeter. I add a pinch just before serving.");
    did(32, "main", "recall_person", { who: ALEX }, `${ALEX}: friend | steady | borrows books, asks about recipes\nRecent: ${ALEX} borrows a cookbook [3] ${eBook}; Saturday park picnic [4] ${ePicnic}`);
    reply(31, TO.alex, "I add a pinch just before serving, it brings out the flavour. If you like it sweeter, add a bit more.");
    const eRainSound = like(29, "Like: the sound of rain", "like", 3, "Rain on the window slows everything down", "Rain on the window slows everything down; cooking and studying both feel calmer. I like it.");
    did(29, "main", "like", { what: "the sound of rain", how: "like" }, `Noted: like the sound of rain (${eRainSound}).`);
    sensed(27, "rm-7", "- [remind id=rm-7] Time for today's 20 Spanish words");
    row(26.5, "main", "think", "Time for vocabulary: lesson 12.");
    did(26, "main", "on_it", { topic: "Learn today's Spanish words", about_min: 20 }, "Started: learn today's Spanish words (about 20 min).");
    row(25, "side-2", "think", "Lesson 12: nublado, fresco, el paraguas, la tormenta… one pass first, then write them out.");
    did(24, "side-2", "Read", { file_path: "notes/spanish/lesson-12.md" }, "nublado: cloudy\nfresco: cool\nel paraguas: umbrella\n… 20 in all");
    did(22, "side-2", "Bash", { command: "python3 tools/quiz.py --lesson 12" }, "Traceback (most recent call last):\nFileNotFoundError: [Errno 2] No such file or directory: 'tools/quiz.py'", { error: true });
    row(21, "side-2", "think", "The quiz script isn't there. Not going to work around it; I'll write them out myself.");
    row(19, "side-2", "note", "Today's 20 words done, 3 wrong: paraguas, nublado, fresco.");
    did(18, "main", "mull_over", { what: `Why I keep forgetting "nublado"` }, "Left it to think over.");
    row(17, "deep", "think", `"nublado" and "nube" look alike… where did I get to last week?`);
    row(14, "deep", "note", `Got it: "nublado" comes from "nube", a cloud. Picture a sky full of clouds and it sticks.`, { insight: true });
    heard(9, OWNER, "whatsapp", `The eggs were really soft this time! Thanks ${ME}.`);
    row(8.5, "main", "think", "Medium heat and out when half set: that was right. Add it to the method.");
    reply(8, TO.owner, "Brilliant! Next time try a pinch of sugar just before serving.");
    row(7, "main", "note", `${OWNER} said the eggs were soft this time: medium heat and out when half set is right.`);
    did(3, "main", "remind", { when: "tomorrow 07:30", text: `Remind ${OWNER} to check the weather` }, "Scheduled: #3 tomorrow 07:30.");

    // —— wrap-up: quote layer caught up, touches, vectors, exported files
    index.ingestCentral();
    // the quote layer names her own lines 「我」, what she sent 「我→name」 and raw senses 「感官」 (HH writes these in Chinese): English names here
    db.prepare("UPDATE mem_quote SET who = CASE WHEN who = '我' THEN ? WHEN who = '感官' THEN 'senses' WHEN who LIKE '我→%' THEN ? || ' → ' || substr(who, 3) ELSE who END").run(ME, ME);
    // what she said and then sent is one line in the quote layer, not two (keep the sent one)
    for (const { id } of all<{ id: number }>(db, "SELECT q.id FROM mem_quote q WHERE q.who = ? AND EXISTS (SELECT 1 FROM mem_quote r WHERE r.who LIKE ? AND r.text LIKE '%' || q.text)", ME, `${ME} → %`)) {
      db.prepare("DELETE FROM mem_quote WHERE id = ?").run(id);
      db.prepare("DELETE FROM mem_fts WHERE ref = ?").run(`q${id}`);
    }
    // reasons the event store writes itself (a pending card change pushed out by a newer one): English in the demo
    for (const [zh, en] of [["被新的待批取代", "replaced by a newer pending version"], ["驳回", "rejected"]] as const) {
      db.prepare("UPDATE mem_impression SET why = ? WHERE why = ?").run(en, zh);
      db.prepare("UPDATE mem_op SET reason = ? WHERE reason = ?").run(en, zh);
      db.prepare("UPDATE mem_op SET before = replace(before, ?, ?), after = replace(after, ?, ?) WHERE instr(COALESCE(before, ''), ?) > 0 OR instr(COALESCE(after, ''), ?) > 0").run(zh, en, zh, en, zh, zh);
    }
    s.touch(eEgg, "auto", "main", at(57));
    s.touch(eEgg, "open", "main", at(56));
    s.touch(nDone, "open", "main", at(56));
    s.touch(ePicnic, "recall", "main", at(32));
    s.touch(eB1, "cite", "main", at(26));
    [0.95, 0.8, 1, 0.5, 0.98, 0.5].forEach((full, i) => {
      const target = full * LIMITS.pageTokens;
      const sum = one<{ n: number }>(db, "SELECT COALESCE(SUM(tokens), 0) AS n FROM central WHERE epoch = ?", i + 1)!.n;
      if (sum) db.prepare("UPDATE central SET tokens = CAST(tokens * ? AS INTEGER) WHERE epoch = ?").run(target / sum, i + 1);
    });
    const vec = new Uint8Array(new Float32Array(8).buffer);
    // events, entries and quotes all have vectors except the newest few, which the backfill hasn't reached yet
    const indexed = all<{ ref: string }>(db, "SELECT ref FROM mem_fts WHERE ref NOT IN (SELECT ref FROM mem_vec) ORDER BY rowid");
    for (const q of indexed.slice(0, -3)) db.prepare("INSERT INTO mem_vec (ref, hash, vec) VALUES (?, 'demo', ?)").run(q.ref, vec);
    // the midterm view: the real one is rendered by HH in Chinese; the English demo writes the same kind of view by hand
    const midterm = [
      "# Recently", "",
      `### ${yesterday}`, `- First stir-fry lesson: taught ${OWNER} in three steps; the eggs came out tough (high heat), medium next time`,
      `  - Pan and soy sauce run`, `- Spanish B1 study plan: 20 words a day on weekdays, listening on Saturday`,
      `  - Lesson 11 words done`, `- Saturday park picnic: I'm bringing tomato and egg sandwiches`,
      `- ${ALEX} borrows a cookbook`, "", "### Today",
      "- Like: the sound of rain", "- Dislike: Monday alarm", "",
      "### Coming up", "- Pork belly this weekend", "",
      `### ${OWNER}, in his own words these 3 days`, `- "You explained it really clearly, thanks."`, `- "The eggs were really soft this time!"`,
    ].join("\n") + "\n";
    put(join(c.dir, "exports/midterm.md"), midterm, now - 4 * MIN);
    put(join(c.dir, "exports/vectors.json"), JSON.stringify({ at: now - 4 * MIN, missing: index.missingVectors(), lastError: "", lastErrorAt: null, lastOkAt: now - 20 * MIN, pausedUntil: null }), now - 4 * MIN);
    return { page, block, midterm, event: eEgg, entry: nDone, person: s.entity(ALEX)!.id, batch: NIGHT };
  }

  // ---------- the database: the gate's ledger, learning ----------

  interface GateSeed {
    /** where in the day (0 = midnight, 1 = now / the end of that day) */
    f: number; /** minutes before now: a row the timeline also shows sits at the same moment */ ago?: number; id: string; src: string; conv?: string; sender?: string; group?: boolean; system?: true; text: string; do?: string;
    route: string | null; rule?: string; action?: string; verdict?: string; when?: string; gist?: string; why?: string; unsure?: boolean; delivered?: boolean; tokens?: number; units?: number;
  }

  function gate(c: Ctx, db: Db): void {
    const day = gateDayRange(c.today, c.tz)!, prev = gateDayRange(c.yesterday, c.tz)!;
    const direct = { route: "fixed-main", action: "fixed-main", when: "now", delivered: true };
    const judged = { route: "judge", action: "judge" };
    const today: GateSeed[] = [
      { f: 0.05, id: "goals-2", src: "goals", text: "Today's goals: lesson 12 vocabulary, the picnic list", ...direct },
      { f: 0.12, id: "quota-2", src: "hh-quota", text: "[Quota] 41% of this week's (7-day) quota used.", ...direct },
      { f: 0.16, id: "xhs-boot", src: "xhs", system: true, text: "Phone just turned on (it was off for about 12 minutes): messages that arrived while it was off may not have notified; check the messages page", do: "Open the messages page, check the newest DMs, then go back to the home screen.", route: "rule", rule: "phone-on check", action: "main", when: "now", delivered: true },
      { f: 0.2, ago: 260, id: "rss-31", src: "rss", text: "Feed: Melbourne this week, sunny on Saturday", route: "rule", rule: "weather feed", action: "digest" },
      { f: 0.28, id: "xhs-9", src: "xhs", conv: "Notifications", text: "Someone liked your post \"Tomato and egg stir-fry\"", route: "rule", rule: "likes", action: "drop" },
      { f: 0.36, id: "wx-1990", src: "wx", conv: "Riley", sender: "Riley", group: false, text: "Riley: hi, add me as a friend?", ...judged, verdict: "drop", gist: "A stranger saying hi", why: "Don't know them; looks like spam", tokens: 900 },
      { f: 0.44, id: "qq-77", src: "qq", conv: GROUP, sender: JORDAN, group: true, text: `${GROUP} ${JORDAN}: so hot today, I want ice cream`, ...judged, verdict: "digest", gist: "Chat about the heat", why: "Nobody asked her anything", unsure: true, tokens: 4800, units: 1200 },
      { f: 0.52, id: "load-3", src: "load", text: "Load: memory 82% used", route: "judge", action: "judge", verdict: "digest", gist: "Memory is a bit tight", why: "Not urgent; noted", tokens: 700, units: 175 },
      { f: 0.6, id: "bili-41", src: "bili", text: "New reply on your video: how long should pork belly braise?", ...judged, verdict: "main", when: "work", gist: "Asks how long to braise pork belly", why: "Something she knows; answer while working", tokens: 2100, units: 520 },
      { f: 0.64, id: "bili-42", src: "bili", text: "Someone tipped your video", route: "fallback", action: "judge", verdict: "digest", why: "judge timed out" },
      { f: 0.66, id: "bili-44", src: "bili", text: "Someone saved your video", route: "fallback", action: "judge", verdict: "digest", why: "judge timed out" },
      { f: 0.7, id: "wx-1994", src: "wx", conv: GROUP, sender: JORDAN, group: true, text: `${GROUP} ${JORDAN}: I'll bring the frisbee`, ...judged, verdict: "digest", gist: `${JORDAN} is bringing a frisbee`, why: "Group chat, not for her; unsure, so into the daily digest (her rule)", unsure: true, tokens: 3600, units: 900 },
      { f: 0.72, id: "wx-1995", src: "wx", conv: GROUP, sender: JORDAN, group: true, text: `${GROUP} ${JORDAN}: has anyone seen my water bottle`, route: "fallback", rule: "group chat", action: "judge", verdict: "digest", why: "low budget; group lines held for the digest" },
      // guests' private chats: people she knows go straight to her (a fixed route, as in HH); the console never gives their text, gist or reason
      { f: 0.8, id: "wx-1996", src: "wx", conv: ALEX, sender: ALEX, group: false, text: `${ALEX}: between us, I ${SECRETS_EN.gate} your pan, don't tell ${OWNER} yet`, do: `Reply to ${ALEX} privately.`, ...direct, gist: `${ALEX} ${SECRETS_EN.gate} a pan`, why: `asks her to keep the ${SECRETS_EN.gate} pan quiet` },
      // a DM the senses layer mislabelled as a group (its text starts "Note: "): the conversation name is a guest, so it's still hidden
      { f: 0.82, id: "wx-1997", src: "wx", conv: JORDAN, sender: "Note", group: true, text: `${JORDAN}: Note: ${SECRETS_EN.gate} toast again, please don't post about it`, ...direct, gist: `${SECRETS_EN.gate} toast`, why: `asked her not to post about the ${SECRETS_EN.gate} toast` },
      { f: 0.9, ago: 53, id: "wx-2001", src: "wx", conv: GROUP, sender: JORDAN, group: true, text: `${GROUP} ${JORDAN}: Who's bringing a rug on Saturday?`, ...judged, verdict: "main", when: "now", gist: "Asks who's bringing a rug", why: "She promised to make the list", delivered: true, tokens: 5200, units: 1300 },
      { f: 0.92, id: "wx-2002", src: "wx", conv: GROUP, sender: "Taylor", group: true, text: `${GROUP} Taylor: @${ME} can you add sunscreen to the list?`, ...direct },
      { f: 0.94, ago: 38, id: "cc-5", src: "cc", text: "Helper picnic-list: list laid out, one A4 page.", route: "hands", action: "hands", delivered: true },
      { f: 0.96, ago: 27, id: "rm-7", src: "remind", text: "Time for today's 20 Spanish words", ...direct },
      { f: 0.98, id: "bili-43", src: "bili", text: "A channel you follow posted: braised pork belly in ten minutes", ...judged, verdict: "main", when: "leisure", gist: "A pork belly tutorial", why: "She's cooking it this weekend", delivered: true, tokens: 1100, units: 280 },
      { f: 0.995, id: "net-1", src: "phone_net", text: "Phone network was down for 2 minutes", route: null },
    ];
    const yesterday: GateSeed[] = [
      { f: 0.3, id: "goals-1", src: "goals", text: "Today's goals: answer the weather, learn a dish", ...direct },
      { f: 0.45, ago: 1500, id: "wx-1000", src: "wx", conv: ALEX, sender: ALEX, group: false, text: `${ALEX}: could I borrow "Home Cooking Basics"?`, ...direct },
      { f: 0.6, ago: 1440, id: "wx-1001", src: "wx", conv: GROUP, sender: JORDAN, group: true, text: `${GROUP} ${JORDAN}: Picnic at the park on the corner on Saturday?`, ...judged, verdict: "main", when: "now", gist: "Saturday picnic plan", why: "Planning with everyone; she's in the group", delivered: true, tokens: 4100, units: 1020 },
      { f: 0.7, id: "xhs-8", src: "xhs", conv: "Notifications", text: "Someone followed you", route: "rule", rule: "follows", action: "drop" },
      { f: 0.8, id: "bili-40", src: "bili", text: "New reply on your video: now I'm hungry", ...judged, verdict: "drop", gist: "A passing comment", why: "No reply needed", tokens: 800 },
      { f: 0.9, id: "rm-6", src: "remind", text: "Time for bed; check the weather early tomorrow", ...direct },
    ];
    const ins = db.prepare("INSERT INTO gate_log (ts, ev_id, src, conv, sender, line, ev, route, rule, action, verdict, when_, gist, why, unsure, delivered, tokens, units, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const write = (rows: GateSeed[], from: number, to: number): void => {
      for (const r of rows) {
        const ts = r.ago !== undefined ? c.now - r.ago * MIN : Math.floor(from + (to - from) * r.f);
        const line = `- [${r.src} id=${r.id}] ${r.text}${r.do ? `（${r.do}）` : ""}`;
        const ev = JSON.stringify({ src: r.src, id: r.id, text: r.text, line, ...(r.do ? { do: r.do } : {}), ...(r.conv ? { conv: r.conv } : {}), ...(r.sender ? { sender: r.sender } : {}), ...(r.group !== undefined ? { isGroup: r.group } : {}), ...(r.system ? { system: true } : {}) });
        ins.run(ts, r.id, r.src, r.conv ?? null, r.sender ?? null, line, ev, r.route, r.rule ?? null, r.action ?? null, r.verdict ?? null, r.when ?? null, r.gist ?? null, r.why ?? null,
          r.unsure === undefined ? null : r.unsure ? 1 : 0, r.delivered ? ts + 2000 : null, r.tokens ?? 0, r.units ?? null, r.route === null ? "new" : "done");
      }
    };
    write(today, day.from, c.now);
    write(yesterday, prev.from, day.from);
  }

  function learn(c: Ctx, db: Db): void {
    const { now, today, yesterday } = c;
    const at = (minAgo: number): number => now - minAgo * MIN;
    // [minutes ago, region, what triggered it, topic, candidates, pages attached, shadow only, why nothing attached, ms, tokens]
    const assoc: Array<[number, string, string, string, number, Array<{ id: string; p: number }>, number, string | null, number, number]> = [
      [1698, "main", "on_it", `Teach ${OWNER} tomato and egg stir-fry`, 6, [{ id: "0012", p: 0.93 }], 0, null, 310, 1900],
      [1379, "main", "on_it", "Make a Spanish B1 study plan", 5, [{ id: "0003", p: 0.81 }], 0, null, 280, 1700],
      [1200, "main", "mull_over", "Why cooking feels better on rainy days", 4, [], 0, "nothing", 260, 1500],
      [600, "main", "wake", "Woke up", 0, [], 0, "lowinfo", 3, 0],
      [560, "main", "wake", "What's the weather like? Good for drying laundry?", 5, [{ id: "0021", p: 0.77 }], 0, null, 240, 1600],
      [480, "main", "goals", "To do today: lesson 12 vocabulary", 4, [{ id: "0003", p: 0.72 }], 1, null, 250, 1650],
      [300, "main", "wake", "Had noodles for lunch, feeling sleepy", 3, [], 0, "nothing", 210, 1400],
      [150, "main", "wake", "I'll give the book back at the picnic", 2, [], 0, "same", 5, 0],
      [58, "main", "wake", "Something light for dinner? Tomatoes and eggs in the fridge", 6, [{ id: "0012", p: 0.95 }], 0, null, 300, 1850],
      [50, "main", "on_it", "Make the Saturday picnic list", 5, [{ id: "0021", p: 0.74 }], 0, null, 270, 1700],
      [42, "side-1", "hands", "Lay the picnic list out as one printable page", 3, [], 0, "novec", 1500, 0],
      [42, "side-1", "helper", "Attached for helper picnic-list", 3, [{ id: "0021", p: 0.7 }], 0, null, 200, 900],
      [33, "main", "wake", "Should tomato and egg have sugar in it?", 6, [{ id: "0012", p: 0.9 }], 0, null, 290, 1800],
      [26, "main", "on_it", "Learn today's Spanish words", 5, [{ id: "0003", p: 0.88 }], 0, null, 260, 1700],
      [18, "main", "mull_over", `Why I keep forgetting "nublado"`, 4, [], 0, "judge", 800, 0],
      [12, "main", "ask", "rug", 2, [], 0, "nothing", 150, 600],
      [9, "main", "wake", "The eggs were really soft this time!", 4, [], 0, "budget", 2, 0],
    ];
    const ins = db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [ago, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens] of assoc) ins.run(at(ago), region, binding, topic, candidates, JSON.stringify(mounted), shadow, skipped, ms, tokens);
    for (const [ago, id] of [[1695, "0012"], [56, "0012"], [24, "0003"]] as const) db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', ?, NULL)").run(at(ago), id);
    for (const [id, rel, ago] of [["0034", "doing/cooking/tomato-and-egg.md", 2 * DAY], ["0035", "doing/weather/umbrella.md", 5 * DAY]] as const) {
      db.prepare("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen) VALUES (?, 'lesson', ?, 'demo', ?, ?)").run(id, rel, now - ago, now - HOUR);
    }
    db.prepare("INSERT INTO learn_recur (lesson_id, day, kind) VALUES ('0034', ?, 'mounted'), ('0035', ?, 'unmounted')").run(yesterday, shiftDay(today, -3));
    db.prepare("INSERT INTO learn_correction (at, topic, p) VALUES (?, 'heat for tomato and egg', 0.8), (?, 'weather answer only covered the morning', 0.7)").run(at(1620), now - 3 * DAY);
    for (const [topic, expect, passed] of [["Teaching tomato and egg stir-fry", "0012", 1], ["Someone asks about the weather", "0021", 1], ["Planning study", "0003", 1], ["Cooking braised pork belly", "0013", 0]] as const) {
      const id = Number(db.prepare("INSERT INTO learn_case (at, topic, expect, source) VALUES (?, ?, ?, 'seed')").run(now - 3 * DAY, topic, expect).lastInsertRowid);
      db.prepare("INSERT INTO learn_case_run (night, case_id, passed) VALUES (?, ?, ?)").run(yesterday, id, passed);
    }
    const task = db.prepare("INSERT INTO tasks (topic, owner, about_min, state, started, ended, took_min) VALUES (?, ?, ?, ?, ?, ?, ?)");
    task.run(`Teach ${OWNER} tomato and egg stir-fry`, "side-1", 20, "done", at(1698), at(1672), 26);
    task.run("Make a Spanish B1 study plan", "side-2", 30, "done", at(1379), at(1348), 31);
    task.run("Make the Saturday picnic list", "side-1", 15, "done", at(50), at(37), 13);
    task.run("Learn today's Spanish words", "side-2", 20, "doing", at(26), null, null);
    kvSet(db, `learn.spend.${today}`, "184000");
  }

  // ---------- files: helper and region sessions (Claude Code transcripts), the log, old sleep notes, association comparisons ----------

  function workers(c: Ctx): void {
    const { dir, now } = c;
    const steps: Record<string, Step[]> = {
      "recipe-video": [
        { user: `Cut "tomato and egg in three steps" into a one-minute vertical video with large captions.` },
        { think: "Check how many clips there are and how long each is, then decide where to cut." },
        { say: "Let me look at the footage first." },
        { tool: "Bash", input: { command: "ls -la clips/" }, result: "01-crack-eggs.mp4  18s\n02-cook-eggs.mp4  41s\n03-cook-tomatoes.mp4  37s\n04-serve.mp4  12s" },
        { think: "" },
        { tool: "Bash", input: { command: "python3 cut.py --plan plan.json" }, result: "Cut 4 segments, 58 seconds in total." },
        { say: "Four segments cut, 58 seconds together. Adding captions now." },
        { tool: "Write", input: { file_path: "subs.srt", content: "1\n00:00:00,000 --> 00:00:04,000\nA spoonful of water in the eggs" }, result: "Written: subs.srt" },
      ],
      "picnic-list": [
        { user: "Lay the picnic list out as one printable A4 page: sandwiches, fruit, sparkling water, rug, rubbish bags." },
        { think: "Three columns: food, drinks, things to bring. Date and place in the title." },
        { tool: "Read", input: { file_path: "notes/picnic-list.md" }, result: "sandwiches, fruit, sparkling water, rug, rubbish bags" },
        { tool: "Write", input: { file_path: "notes/picnic-list.pdf" }, result: "Written: notes/picnic-list.pdf (1 page)" },
        { say: "Done: one A4 page, saved as notes/picnic-list.pdf." },
      ],
      "weather-notes": [
        { user: "Put last week's daily weather into one table." },
        { think: "" },
        { tool: "Read", input: { file_path: "notes/weather/last-week.csv" }, result: "No such file: notes/weather/last-week.csv", error: true },
        { say: "Last week's record file isn't there, so I can't build the table. Shall I start logging one line a day from today?" },
      ],
    };
    for (const w of WORKERS) {
      const lastAt = now - w.idle;
      put(join(dir, "cc", `${w.name}.json`), JSON.stringify({ session_id: w.sid, model: w.model, bg_model: w.model, state: w.state, turn: w.turn, dir: `/demo/work/${w.name}`, created: iso(lastAt - HOUR).slice(0, 19).replace("T", " "), token: "demo-token-never-shown" }), lastAt);
      put(join(dir, "projects", `-demo-work-${w.name}`, `${w.sid}.jsonl`), jsonl(chat(lastAt - 10 * MIN, steps[w.name] ?? [], { model: w.model })), lastAt);
    }
  }

  /** The prefix, put together like buildPrefix: runtime note / persona files / bookshelf / frame + memory files + midterm view + condensed memory */
  function prefixText(midterm: string): string {
    const files = persona();
    const fileText = (f: string): string => `<file path="${f}">\n${(files[f] ?? "").trim()}\n</file>`;
    const self = DEMO_FILES.filter((f) => !MEMORY_FILES.has(f)).map(fileText).join("\n\n");
    // HH renders the shelf with a Chinese heading; the English demo lists the same books by hand
    const shelf = ["# My shelf", "My methods and lessons live in these notebooks. Relevant pages come up on their own while I work.", "",
      "## general", "- study: how to memorise and review (1 page)", "", "## doing", "- cooking: home recipes and lessons (2 pages)", "- weather: how to read a forecast before going out (1 page)"].join("\n");
    const memoryParts = [
      ...DEMO_FILES.filter((f) => MEMORY_FILES.has(f)).map(fileText), midterm.trim(),
      "## Since you woke up (page summaries)\n\n" + [BLOCK2, BLOCK3].map((b, i) => `### Page summary ${i + 1}\n\n${b}`).join("\n\n"),
    ];
    return [RUNTIME_NOTE, self, shelf, `${FRAME_EN}\n\n${memoryParts.join("\n\n")}`].join("\n\n---\n\n");
  }

  function sessions(c: Ctx, m: Seeded): void {
    const { dir, ws, now } = c;
    const tools = [
      { name: "Bash", description: "Run a command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
      { name: "Read", description: "Read a file.", input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] } },
      { name: "DeferredToolPlaceholder", description: "", input_schema: {} },
      { name: "mcp__self__message", description: "Send a message to a person or a group.", input_schema: { type: "object", properties: { to: { type: "string" }, text: { type: "string" } }, required: ["to", "text"] } },
      { name: "mcp__self__on_it", description: "Start something that takes a while, with an estimate.", input_schema: { type: "object", properties: { topic: { type: "string" }, about_min: { type: "number" } } } },
      { name: "mcp__self__remember", description: "Recall related things by meaning.", input_schema: { type: "object", properties: { cue: { type: "string" } } } },
      { name: "mcp__self__jot_down", description: "Jot something down.", input_schema: { type: "object", properties: { text: { type: "string" } } } },
    ];
    const system = [
      "<intro>\n(made-up demo content) Claude Code's own opening.",
      "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
      "<communication>\n(made-up demo content) How to talk to people: short and direct.",
      "# Tone and style\n(made-up demo content) Be brief.",
      prefixText(m.midterm),
    ];
    const head = (atMs: number): unknown[] => [
      { type: "queue-operation", operation: "enqueue" },
      { type: "attachment", timestamp: iso(atMs), attachment: { type: "environment" }, rendered: [{ content: "Working directory: /demo/workspace\nPlatform: darwin" }], renderedRole: "system" },
      { type: "attachment", timestamp: iso(atMs), attachment: { type: "date" }, rendered: [{ content: `Today is ${c.today}.` }], renderedRole: "system" },
      { type: "attachment", timestamp: iso(atMs), attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch", "WebSearch", "mcp__video__search", "mcp__weather__forecast"], removedNames: [] }, rendered: [{ content: "These tools are listed by name only and load when used: WebFetch, WebSearch, mcp__video__search, mcp__weather__forecast" }], renderedRole: "system" },
      { type: "attachment", timestamp: iso(atMs), attachment: { type: "skill_listing" }, rendered: [{ content: "- cooking: home recipes and lessons\n- weather: how to read a forecast before going out\n- study: how to memorise and review" }], renderedRole: "system" },
      { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: system } },
      { type: "api-request-shape", shape: { system: [{ type: "text", text: "(same as above)" }], tools } },
    ];
    const session = (id: string, lastAt: number, steps: Step[], ctx: number, model = CFG.models.opus): void => {
      const start = lastAt - steps.length * 24_000;
      put(join(projectDirFor(join(dir, "projects"), ws), `${id}.jsonl`), jsonl([...head(start), ...chat(start, steps, { model, ctx })]), lastAt);
    };
    const side = (topic: string): string => `<memory>\n(while working on "${topic}") I thought: check Saturday's weather first.\n(while working on "${topic}") I did: python3 tools/weather.py --day sat\n</memory>`;
    session(SESSION.main, now - 10_000, [
      { user: `${OPENINGS.main} You are ${ME}. Messages from people arrive here, and this is where you speak.\n\nHere is what you've just been through:\n\n<memory>\n${OWNER} said: Something light for dinner? There are tomatoes and eggs in the fridge.\n</memory>\n\n[For you only: it's evening, the computer isn't busy; today's goals still include "lesson 12 vocabulary".]` },
      { think: "" },
      { tool: "mcp__self__remember", input: { cue: "tomato and egg heat" }, result: `Remembered (expand an id with recall_event):\n· First stir-fry lesson [3] ${m.event}: taught ${OWNER}; eggs came out tough` },
      { think: "Last time the eggs were tough because the heat was high. Remind him to use medium." },
      { say: "Tomato and egg stir-fry with a greens soup, then. Medium heat this time, and take the eggs out when they're half set." },
      { attach: "hook_additional_context", text: `<memory>\nI saw ${JORDAN} asking in ${GROUP} who's bringing a rug on Saturday.\n</memory>` },
      { user: `[For you only: ${JORDAN} asked in ${GROUP} who's bringing a rug; ${OWNER}'s card: owner | growing closer | asks about the weather and dinner every day.]\n${OWNER} (whatsapp): Oh, and could you make a list for Saturday's picnic?` },
      { tool: "mcp__self__on_it", input: { topic: "Make the Saturday picnic list", about_min: 15 }, result: "Started: make the Saturday picnic list (about 15 min)." },
      { say: "Sure, I'll make the list and send it over shortly." },
      { user: side("Make the Saturday picnic list") },
      { user: `<memory>\n(while working on "Make the Saturday picnic list") I noted: list ready, sunny on Saturday.\n</memory>\n${ALEX} (wx): ${ME}, should tomato and egg have sugar in it?` },
      { tool: "Bash", input: { command: "python3 tools/quiz.py --lesson 12" }, result: "FileNotFoundError: [Errno 2] No such file or directory: 'tools/quiz.py'", error: true },
      { say: "I add a pinch just before serving, it brings out the flavour. If you like it sweeter, add a bit more." },
    ], 3_300);
    session(SESSION.mainOld, now - 11 * HOUR, [
      { user: `${OPENINGS.main} You are ${ME}.\n\nHere is what you've just been through:\n\n<memory>\n${OWNER} said: Feel like tomato and egg stir-fry tonight. Teach me?\n</memory>` },
      { think: "The first dish of the cooking plan. Get the steps straight." },
      { say: "Three steps: eggs half set and out, then the tomatoes, then together." },
    ], 2_900);
    session(SESSION.side1, now - MIN, [
      { user: `${OPENINGS.side} You are ${ME}, still the same you, working on something that takes a while.\n\nThe task: make the Saturday picnic list (about 15 min).` },
      { think: "Food, drinks, a rug, rubbish bags. Check Saturday's weather first." },
      { tool: "Bash", input: { command: "python3 tools/weather.py --city maplebay --day sat" }, result: "Saturday: sunny, 14–22°C, light northerly." },
      { tool: "mcp__self__jot_down", input: { text: "First draft of the list: sandwiches, fruit, sparkling water, rug, rubbish bags." }, result: "Noted." },
    ], 2_250);
    session(SESSION.side2, now - 19 * MIN, [
      { user: `${OPENINGS.side} You are ${ME}, still the same you.\n\nThe task: learn today's Spanish words (about 20 min).` },
      { think: "Lesson 12: one pass, then write them out." },
      { tool: "Read", input: { file_path: "notes/spanish/lesson-12.md" }, result: "nublado: cloudy\nfresco: cool\n… 20 in all" },
      { say: "Done, 3 wrong." },
    ], 1_500);
    session(SESSION.speech, now - 50 * MIN, [
      { user: `${OPENINGS.speech} You are ${ME}. When someone talks to you and you're still thinking, say something very short first.\n\n${OWNER}: Oh, and could you make a list for Saturday's picnic?` },
      { say: "Sure, on it." },
    ], 950, CFG.models.haiku);
    session(SESSION.hippocampus, now - 45 * MIN, [
      { user: `${OPENINGS.hippocampus} You are ${ME}. The page is full: condense what happened on it into one memory block.` },
      { think: "Keep: the book reminder, the dinner decision, the picnic list and Saturday's weather." },
      { say: BLOCK3 },
    ], 2_700);
    session(SESSION.deep, now - 13 * MIN, [
      { user: `${OPENINGS.deep} You are ${ME}. Take your time with this one: why do I keep forgetting "nublado"?` },
      { think: `"nublado" and "nube" look alike.` },
      { say: `"nublado" comes from "nube", a cloud: picture a sky full of clouds.` },
    ], 1_100, CFG.models.sonnet);
  }

  function files(c: Ctx, m: Seeded): void {
    const { dir, now, yesterday } = c;
    const at = (minAgo: number): number => now - minAgo * MIN;
    const log: Array<[number, string, string, string, Record<string, unknown>]> = [
      [1800, "info", "hhd", "started", { pid: 4242 }],
      [1560, "info", "hhd.brain", "page turned", { page: 2 }],
      [120, "warn", "hhd.gate", "judge timed out, sent to the digest", {}],
      [980, "info", "hhd.brain", "asleep", { reason: "night" }],
      [640, "info", "hhd.sleep", "night flow committed", { days: [yesterday] }],
      [179, "info", "hhd", "started", { pid: 4310 }],
    ];
    put(join(dir, "logs/hh.jsonl"), jsonl(log.map(([ago, level, mod, msg, extra]) => ({ t: iso(at(ago)), level, mod, msg, ...extra }))), at(179));
    void m;   // no association-comparison logs and no old consolidation drafts in the English demo
  }

  /** What the fake hhd answers to `status`: awake, in a focus slot; main, two side tasks and the subconscious are thinking */
  function status(c: Ctx, db: Db, m: Seeded): BrainStatus {
    const { now, tz } = c;
    const pageTokens = new CentralMemory(db).pageTokens(m.page);
    const week = { used: 41, resetsAt: now + 3 * DAY, level: 0 };
    const idle = { open: false, busy: false, contextTokens: 0, generation: 0, sessionId: null };
    const regions: Record<string, { open: boolean; busy: boolean; contextTokens: number; generation: number; sessionId: string | null }> = {
      main: { open: true, busy: true, contextTokens: 4_310, generation: 3, sessionId: SESSION.main },
      "side-1": { open: true, busy: true, contextTokens: 2_610, generation: 2, sessionId: SESSION.side1 },
      "side-2": { open: true, busy: true, contextTokens: 1_860, generation: 1, sessionId: SESSION.side2 },
      deep: { open: true, busy: true, contextTokens: 1_240, generation: 1, sessionId: SESSION.deep },
      speech: { open: true, busy: false, contextTokens: 1_050, generation: 3, sessionId: SESSION.speech },
      hippocampus: { ...idle, generation: 5 },
    };
    const from = gateDayRange(c.today, tz)!.from;
    const tally = (col: string, extra = ""): Record<string, number> =>
      Object.fromEntries(all<{ k: string; n: number }>(db, `SELECT ${col} AS k, COUNT(*) AS n FROM gate_log WHERE ts >= ? AND ${col} IS NOT NULL${extra} GROUP BY k`, from).map((r) => [r.k, r.n]));
    const g = one<{ n: number; j: number; tok: number; u: number; main: number }>(db,
      "SELECT COUNT(*) AS n, COALESCE(SUM(tokens > 0), 0) AS j, COALESCE(SUM(tokens), 0) AS tok, COALESCE(SUM(units), 0) AS u, COALESCE(SUM(when_ IS NOT NULL AND delivered IS NOT NULL), 0) AS main FROM gate_log WHERE ts >= ?", from)!;
    const changed = new Intl.DateTimeFormat("en-AU", { timeZone: tz, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(now - 5 * HOUR);
    return {
      alertness: "awake", epoch: m.page, pageTokens, pageView: Math.round(pageTokens * 1.12), pageViewRaw: pageTokens, pageViewK: 1.12,
      compactedTokens: new Epochs(db).compactedTokens(),
      focusSlot: CFG.schedule.focusSlots.at(-1) ?? "18:00", focusUntil: new Date(now + 25 * MIN).toLocaleString("zh-CN", { timeZone: tz, hourCycle: "h23" }),   // the live hhd's format ("2026/11/13 00:33:04"): the page reads the time off the end
      turning: false, frontIdle: false, nightRest: false,
      regions: REGION_IDS.map((id) => ({ id, ...(regions[id] ?? idle) })),
      todos: 0,
      // HH's quotaSummary writes Chinese; the same line in English
      quota: `This week (7 days) ${week.used}%, resets ${new Intl.DateTimeFormat("en-AU", { timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(week.resetsAt)}`,
      quotaUsed: { fiveHour: null, sevenDay: week.used, fiveHourResetsAt: null, sevenDayResetsAt: week.resetsAt, at: now - 2 * MIN },
      claims: [{ topic: "Learn today's Spanish words", owner: "side-2" }, { topic: "Cut the tomato and egg video", owner: "side-1" }],
      gate: { received: g.n, byRoute: tally("route"), byVerdict: tally("verdict", " AND route = 'judge'"), byRule: tally("rule"), judgeCalls: g.j, tokens: g.tok, units: g.u, toMain: g.main, paused: null, mainWakes: g.main },
      rulesErrors: [],
      registryChanges: [`${changed} registry: added ${JORDAN} (guest)`],
    };
  }

  return {
    lang: "en", names: { me: ME, owner: OWNER }, port: 7798,
    runtimeNote: RUNTIME_NOTE, frame: FRAME_EN, markers: MARKERS, marks: MARKS_EN, peopleTemplate: PEOPLE_TEMPLATE_EN, shelf: false,
    // the day is written as an evening snapshot: the demo's clock stands at 19:30 today, wherever and whenever it is started
    clockAt: (real: number, tz: string): number => { const [y, mo, d] = localDay(real, tz).split("-").map(Number) as [number, number, number]; return localToUtc(y, mo, d, 19, 30, tz); },
    workspace, memory, gate, learn, workers, sessions, files, status,
    sample: { session: SESSION.main, worker: WORKERS[0]!.name },
  };
}

/** The people-card template in English: the same fields, kinds and limits as config/default.json's, renamed (English needs about three times the characters) */
const PEOPLE_TEMPLATE_EN = (() => {
  const zh = (CFG.memory?.people?.template ?? {}) as { order: string[]; fields: Array<Record<string, unknown>>; quotes: Array<Record<string, unknown>>; computed: { bigEvents: Record<string, unknown>; near: Record<string, unknown> } } & Record<string, unknown>;
  const NAME: Record<string, string> = {
    "关系": "Relationship", "感觉": "Feeling", "我们之间": "Between us", "是谁": "Who they are", "在乎什么": "What they care about", "喜好": "Likes", "雷点": "Sore spots",
    "相处": "Getting along", "我们的大事": "Our big moments", "梗": "In-jokes", "约定和边界": "Agreements and boundaries", "我的理解": "My read", "她私下说的": "Said in private",
    "对我的感情和期待": "What they've said about me", "记着的原话": "Memorable quotes", "近况": "Lately",
  };
  const en = (n: unknown): string => { const s = String(n); const x = NAME[s]; if (!x) throw new Error(`the English people template has no name for "${s}" (config/default.json's template changed)`); return x; };
  const x3 = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, (k === "maxChars" || k === "itemMaxChars") && typeof v === "number" ? v * 3 : v && typeof v === "object" && !Array.isArray(v) ? x3(v as Record<string, unknown>) : v]));
  const fields = zh.fields.map((f) => {
    const g = x3({ ...f, name: en(f.name) });
    if (f.name === "关系") {
      g.pattern = "^\\s*[^|\\s](?:[^|]{0,22}[^|\\s])?\\s*\\|\\s*(?:growing closer|steady|drifting apart)\\s*\\|\\s*[^|\\s](?:[^|]{0,178}[^|\\s])?\\s*$";
      g.patternHint = 'Write it as "type | direction | one sentence": type 1–24 characters (friend, family, group), direction growing closer / steady / drifting apart, one sentence 1–180 characters, e.g. "friend | growing closer | comes to me first when something is wrong"';
    }
    return g;
  });
  const quotes = zh.quotes.map((q) => ({ ...q, name: en(q.name), ...(q.fullHint ? { fullHint: "Never pushed out; goes into a proposal for the owner" } : {}), ...(q.fullHintOthers ? { fullHintOthers: `Never pushed out; the report only says "<name>'s remembered words are full", without the words` } : {}) }));
  const computed = { bigEvents: { ...zh.computed.bigEvents, name: en(zh.computed.bigEvents.name) }, near: { ...zh.computed.near, name: en(zh.computed.near.name) } };
  return { ...zh, order: zh.order.map(en), fields, quotes, computed };
})();
