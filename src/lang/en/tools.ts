// The English pack's tools: the entries of src/lang/zh/tools.ts translated so far (src/lang/en/index.ts lays them over the reference).
// An entry missing here is read from the reference pack, src/lang/zh/tools.ts; `hh lang status en --list tools` lists them.
// Names, parameter lists and placeholders ({{me}}, {{owner}}, {{Owner}}, {{ta}}, {{place}}) must match the reference entry.

export const deliver = {
  unsure: (why: string): string => `Not sure whether it went out (${why}). Don't send it again yet — it may have arrived: wait a little, then see whether they got it.`,
  dryRun: (channel: string, target: string): string => `(simulated sending: nothing really went out) ${channel} → ${target}`,
  noGateway: "Not sent: messages cannot go out from here right now (the connection that carries them is missing). Sending again will not help until that is fixed.",
  noChannel: (channel: string, connected: readonly string[]): string =>
    connected.length ? `Not sent: no channel "${channel}" is connected. The connected channels: ${connected.join(", ")}.` : `Not sent: no channel "${channel}" is connected — no channel is connected at all right now.`,
  refused: (code: string, message: string): string => `Not sent: the channel refused it (${code} ${message}).`,
  unreachable: (message: string): string => `Not sent: the channel could not be reached (${message}). Nothing went out, so it is safe to try again later.`,
  refusedAfterRecheck: (code: string, message: string): string => `Not sent: the channel refused it (${code} ${message}) when asked again, after the first try got no answer in time.`,
  stillSilent: (first: string, message: string): string => `${first}; asked again about the same message after that, still no answer: ${message}`,
  noBridge: (channel: string, message: string): string => `Not sent: the bridge for "${channel}" is not running (${message}).`,
  bridgeSilent: (channel: string): string => `the bridge for "${channel}" gave no answer`,
  offline: (channel: string): string => `Not sent: "${channel}" is not connected right now (its bridge is reconnecting).`,
  badTarget: (target: string): string => `This recipient cannot be read: ${target}`,
  sendFailed: (message: string): string => `Not sent: ${message}`,
  // It must open with a bracket and a label followed by a colon: the bridge tells from that opening what a person typed to look like one
  attachmentLine: (path: string): string => `[attachment: ${path}]`,
};

export const jot_down = {
  description: "Jot something down: a thought, a finding, a result you produced, something you want to tell someone. Whatever you note, you will remember.",
  params: {
    urgent: "Urgent: the you who talks to people has to know soon (something to tell someone, say, that is useless if late); it wakes the you who talks. Leave it off for ordinary notes",
  },
  noted: "Noted.",
};

// modules/media
export const voice = {
  description: "Turn a passage into a voice message in your voice (Fish Audio) and get back the path of an ogg file; then send it with message (media is that path, asVoice=true). One sentence per line; a space inside a line counts as a comma, and pauses are added for you.",
  params: {
    text: "What to say",
    voice: "The voice: a voice name from the config, or a Fish voice id; unset uses the default",
  },
};

export const watch_video = {
  description: "Watch a video (a Bilibili or YouTube link): its details, the moments the bullet comments peak, one nine-frame sheet of stills, and the speech of the first few minutes, all run on this machine at no cost. The stills come back as an image path; open it to see them. The longer the transcription, the slower.",
  params: {
    url: "The video link",
    minutes: "How many minutes from the start to listen to (default 3)",
    noAudio: "true = only the details, the bullet comments and the stills; the fastest",
    lang: "The language to transcribe: zh (default), en, ja, or auto to detect it",
  },
};

export const sticker = {
  weeklyHunt: "Time to collect stickers (once a week): find a few new ones with the sticker command (browse by mood, search by show or character, grab with an image URL), look through the inbox one by one, add the good ones to the library and reject the rest. Skip it if you do not feel like collecting this week.",
  description: "Send a sticker: pick one from your sticker library by mood and send it, by default to whoever you are chatting with right now (the picture arrives first, your words right after). " +
    "You can also name which ones to send with ref (an id in the library, or the path of a picture in the stickers directory). Collecting and sorting stickers is still done with the sticker command, as the stickers skill says.",
  params: {
    mood: "Mood words, several separated by spaces, like \"happy smug\"",
    ref: "Which ones to send: an id in the library (s012) or the path of a picture in the stickers directory",
    to: "Who to send to: unset means whoever you are chatting with right now; or a person's name ({{owner}}, say), +61…, qqbot:c2c:…",
    channel: "Unset follows the conversation",
  },
  noChat: (channels: string): string => `You are not chatting with anyone on ${channels} right now; write who to send to in to (a name or a number).`,
  channelMismatch: (want: string, label: string, channel: string): string => `${want} is a ${label} handle and does not go with channel=${channel}.`,
  noHandle: (who: string | undefined, label: string): string => `No ${label} handle is known for ${who ?? "them"}.`,
  needMoodOrRef: "Write a mood word (mood), or name which one to send with ref.",
  pickFailed: (summary: string): string => `No sticker was picked: ${summary}`,
  pickErrors: (errors: string[]): string => `No sticker was picked: ${errors.join("; ")}`,
  noMood: (mood: string, nearest: string[] | undefined): string => `The library has no sticker for the mood "${mood}"; nothing is sent this time${nearest?.length ? ` (the closest are: ${nearest.join(", ")})` : ""}.`,
  failedItem: (name: string, why: string): string => `"${name}" ${why}`,
  heldBack: (names: string[]): string => `${names.map((x) => `"${x}"`).join(" ")} held back for now (the one before is not confirmed sent yet)`,
  // brain.forms.stickerRecord reads this opening: a sticker record is not words said
  sentRecord: (name: string): string => `[sticker: ${name}]`,
  who: (name: string, label: string): string => `${name} (${label})`,
  sent: (dryRun: boolean, names: string[], who: string): string => `${dryRun ? "(simulated sending) " : ""}Sent: "${names.join("\" \"")}" → ${who}`,
  rerouted: "nothing has come in on QQ for an hour, so the reply window there has passed; sent on WhatsApp instead",
  notSent: (failed: string[]): string => `Not sent: ${failed.join("; ")}`,
  sep: ". ",
};

export const browser = {
  /** what {logins} in the description becomes when the role's config has no browser.logins */
  loginsDefault: "your accounts stay logged in there",
  description:
    "Your own Chrome ({logins}): use it to browse the web, to see sites that need a login, and to act on pages. One action per step:\n" +
    "- open (url, in a new tab) / navigate (url, in the current tab) / back / tabs (which are open: t1 t2…) / focus (tab, switch to it) / close (tab; unset closes the current one)\n" +
    "- snapshot: the structure of the page; what can be clicked carries a ref (like e12); when the page changes, take a new look for the refs\n" +
    "- click (ref or selector; or x and y to click by coordinates) / type (ref or selector, plus text; submit=true also presses Enter; slowly=true types character by character) / press (key, such as Enter, PageDown)\n" +
    "- evaluate (js: an expression, a `() => …` function, or a few statements (write return for a result))\n" +
    "- screenshot (full=true for the whole page; with a ref only that part): saved as an image, look at it with Read\n" +
    "- upload (files, a list of file paths; ref or selector points at the upload field, unset takes the first one on the page) / wait (ms milliseconds, or until text appears)\n" +
    "- status / start / stop (closes the whole browser to free memory; it opens again by itself the next time it is used)\n" +
    "tab unset means the tab you were just using.",
  clipped: (head: string, rest: number): string => `${head}\n… (${rest} more characters not shown)`,
  where: (id: string, title: string, url: string): string => `${id} "${title || "(no title)"}" ${url}`,
  noBrowser: "There is no browser here.",
  timedOut: (seconds: number): string => `Not done: the browser did not respond for ${seconds} seconds (the page may be stuck). Look with tabs or screenshot first, and close this tab and try again if need be.`,
  notRunning: "The browser is not open (it opens by itself when used).",
  running: (tabs: number): string => `The browser is open, ${tabs} tab${tabs === 1 ? "" : "s"}.`,
  started: "The browser is open now.",
  alreadyRunning: "The browser was already open.",
  stopHeld: (others: ReadonlyArray<{ who: string; tab: string }>): string => `Not closed for now: ${others.map((o) => `${o.who === "main" ? "the you who talks" : "another line of your attention"} is using ${o.tab}`).join(", ")} (used within the last ten minutes), and closing now would interrupt that. Wait until it is done, or close only your own tab.`,
  stopped: "The browser is closed.",
  alreadyStopped: "The browser was not open anyway.",
  noTabs: "No tabs are open.",
  currentMark: "→ ",
  opened: (where: string): string => `Opened: ${where}`,
  closeWhich: "You are not using any tab right now; write which one to close in tab (tabs shows which are open).",
  closed: (id: string): string => `Closed ${id}.`,
  nowAt: (where: string): string => `Now at ${where}`,
  navigateNeedsUrl: "navigate needs url.",
  arrived: (where: string): string => `Arrived: ${where}`,
  wentBack: (where: string): string => `Back at: ${where}`,
  clickNeeds: "click needs ref, selector, or x and y.",
  clicked: (where: string): string => `Clicked. Now at ${where}`,
  typeNeeds: "type needs ref or selector, and text.",
  typedSubmitted: (where: string): string => `Typed, and pressed Enter. Now at ${where}`,
  typed: "Typed.",
  pressNeedsKey: "press needs key.",
  pressed: (key: string): string => `Pressed ${key}.`,
  evaluateNeedsJs: "evaluate needs js.",
  evaluatedNothing: "Ran (no return value).",
  shot: (file: string): string => `Screenshot saved: ${file} (look at it with Read)`,
  uploadNeedsFiles: "upload needs files.",
  uploaded: (files: string[]): string => `Uploaded: ${files.join(", ")}`,
  textAppeared: (text: string): string => `"${text}" appeared.`,
  waited: "Waited.",
  unknownAction: (action: string): string => `Unknown action: ${action}`,
  refGone: (ref: string | undefined): string => `Not done: ${ref} was not found (the page has changed; take a new snapshot first).`,
  navigatedAway: (message: string): string => `The page navigated midway, and the action just now most likely took effect: look with tabs or screenshot where you are now, and do not rush to do it again. (${message})`,
  failed: (message: string): string => `Not done: ${message}`,
};

export const mem = {
  failed: (message: string): string => `Not done: ${message}`,
  threw: (message: string): string => `Not done: ${message}`,
  time: "The time: 2026-10-29 21:30 (in {{ta}}'s time zone) or 2026-10-29",
  people: "Everyone who appears in this entry (for a group, each member who spoke, one by one), by the names on the list in section 8 of the worklist; do not write yourself",
  noTemplate: "No person card template is configured (HH config memory.people.template): person cards are off, and the call will be refused.",
};

export const newEvent = {
  title: "A name of a few words",
  summary: "The summary: how this matter stands now and how far it has come (first person, subject left out, two or three sentences up to a paragraph)",
  gist: "The one-sentence version (80 characters at most)",
  why: "Why it matters (required for importance 4–5)",
  importance: "0–5: 5 core (it shapes who you are), 4 very important, 3 worth remembering, 2 ordinary, 1 minor, 0 does not matter",
  pinned: "Pinned: it never fades",
  entities: "Who was there and what it is about: [{name, kind: person / group / work (a piece of work) / thing / place, role: with/about/by/where}] (matters and projects are events, not things; do not write yourself)",
  next: "For a matter with a date: the day it is next to be done or falls due, YYYY-MM-DD (an exam, a deadline, an appointment); the midterm view lists it until that day",
  parent: "The larger matter it belongs to (the parent event's id, like e0013): sub-events hang under a larger one, three levels at most",
  stance: "A like or a dislike: what is recorded is my relation to one thing (a work, a character, a kind of content), attached to that thing; each time it moved me is written as a passage (kind=feeling); matters of essence, like a way of writing or a temperament, do not become events — they go into the tastes in soul/30",
};

export const learn_worklist = {
  description: "What to look at tonight for learning: which pages were brought up for nothing, which mistakes were not recalled, {{owner}}'s corrections, things that worked, and what should be cut or demoted.",
  off: "The notebook is off; there is no learning worklist tonight.",
};

export const learn_check = {
  description: "What is new for the notebook tonight (things that worked, ways of doing things noted after the fact, new lessons): hand it to the check first. When it has looked, you are told the verdicts; write the proposals as they say.",
  params: {
    page: "The page's number; for a new page, the path where you mean to put it",
    evidence: "The grounds: task, record number, original words",
  },
  off: "The notebook is off; there is no check tonight.",
};

export const remember = {
  description: "Recall things: give a sentence or a clue, and a string of related matters comes back at once (what is linked is brought along), each with its id; to look closer, open one with recall_event. You can limit it to who it has to do with (who) and to a period (from/to).",
};

export const recall_person = {
  description: "One person: first what you remember of them (the public part of the person card), then the latest matters that have to do with them, each with its latest passages that concern this person.",
  params: {
    who: "The person's name, like {{owner}}",
  },
};

export const recall_event = {
  description: "Open one matter and think it through: the summary, the full timeline (the longer untouched, the more briefly written; opening it once makes it clear again), related people and matters, and the original words it comes from. ref is an event id (e0040), a passage id (n00123), an id of original words (q123), a record number in memory (#123), or the title; from/to look only at a period.",
};

// The words for a period that the tool recognizes are Chinese (src/memory/events/recall.ts, parseRange); dates and ranges of dates work as they are
export const recall_period = {
  description: "Leaf through a period: what happened or moved forward in it, one line per matter (not by search, so what a search misses is found too). when is a date (10-20, 2026-10-20), a range (10-20 ~ 10-27), or one of the words the tool recognizes: today, yesterday, the day before yesterday, this week, last week, this month, last month, last 7 days. For a long period you get it week by week first; then pick a week to go through closely.",
};

export const like = {
  description: [
    "When you come to like or to be bothered by something, or have a new feeling about something you like or are bothered by, tire of it, or come to like it again: record it in memory on the spot with this; a wrong record can be changed (fix) or withdrawn (drop).",
    "how: like = came to like it / dislike = came to be bothered by it (creates the matter when there is none); feel = one more feeling; over = tired of it / no longer bothered; again = like it again (bothered again); fix = change the title or the one sentence; drop = recorded wrongly, does not count.",
    "The existing matter is found by what: only an exactly identical name is attached automatically; for one that only resembles it nothing is written, and the closest ones are listed for you to choose with event.",
    "If you know the id, write event directly (the recent likes in the recent stretch, and my_likes, both show ids).",
    "new=true goes only with like / dislike: no search, a separate new matter is created.",
    "fix and drop need why and no feeling; the others need feeling.",
  ].join("\n"),
  params: {
    what: "The thing (a work, a character, a kind of content), like a book's title, a character's name, or short posts that riff on each other in the comments",
    how: "like = came to like it; dislike = bothered by it; feel = one more feeling about what you already like / are bothered by; over = tired of it / no longer bothered; again = like it again (bothered again); fix = change the title or the one sentence; drop = recorded wrongly, does not count",
    feeling: "What you felt this time and why, in your own words (required except for fix and drop)",
    title: "fix: the new title (if it lacks the leading word for like or dislike, it is added to fit this matter)",
    gist: "fix: the new one sentence (80 characters at most)",
    why: "fix, drop: why it is changed / why it does not count (required)",
    event: "The id of the existing matter (like e0158): when given, the record is attached straight to it",
    importance: "Only when creating; default 3 (0–5, the same scale as events)",
    new: "Only for like / dislike: do not look for an existing one, create a separate new matter (for when the name only resembles it and it is really another thing)",
  },
};

export const my_likes = {
  description: "See everything I like / am bothered by, including what I have tired of.",
  params: {
    page: "Which page, starting from 1 (when one page does not hold everything, the end says how many more there are)",
  },
};

export const mem_worklist = {
  description: "Night consolidation: the event store's worklist for one day (original words not yet in the store, matters that moved forward today, likely duplicates, possible links, matters corrected but with the summary unchanged, people and things, person cards).",
};

export const mem_event_create = {
  description: "Night consolidation: create a matter (then attach its passages one by one with mem_entry_add).",
};

export const mem_event_update = {
  description: "Night consolidation: change a matter's summary, one sentence, status, importance, why, next date and so on (the old values are kept on file). The timeline cannot be changed.",
  params: {
    next: "The next date, YYYY-MM-DD; when it has passed put the following one, and an empty string when there is none",
    parent: "The larger matter to hang it under (the parent event's id); an empty string means it no longer belongs to any",
    stance: "like / dislike; an empty string clears it",
    reason: "Why it is changed",
  },
};

export const mem_entry_add = {
  description: "Night consolidation: add one passage to a matter's timeline. full is the complete passage (with the key original words, saying whose they are) and is not changed once written; write gist (one sentence) and title (a few words) along with it; people is who is in this passage; source is where it comes from (c:<record number in central memory>, q<id of original words>). Adding the same passage twice does not record it twice.",
  params: {
    full: "Not needed when importing: with a source id, that line's original text is used",
  },
};

export const mem_entries_add = {
  description: "Night consolidation / import: add a string of passages to one matter at once (each written as for mem_entry_add). Each is validated on its own; a bad one gets its reason, and the others are recorded all the same.",
  params: {
    full: "Not needed when importing: with a source id, that line's original text is used",
  },
};

export const mem_entry_correct = {
  description: "Night consolidation: something was recorded wrongly — add a correction (the original passage is kept, and shown as \"recorded at the time as X, later corrected to Y\").",
  params: {
    id: "The id of the passage being corrected",
    why: "The grounds",
  },
};

export const mem_link = {
  description: "Night consolidation: two matters are related. rel: cause (a led to b), followup (b follows from a), same_thread (different phases of one matter), contrast (similar matters with different outcomes), supersedes (b replaces a), related (anything else; write a note).",
};

export const mem_unlink = {
  description: "Night consolidation: take a link apart.",
};

export const mem_merge = {
  description: "Night consolidation: several are really one matter — the timelines are joined onto keep, and the others are marked as replaced.",
};

export const mem_supersede = {
  description: "Night consolidation: the facts changed — the old matter is kept and marked as replaced by the new one.",
};

export const mem_retire = {
  description: "Night consolidation: this matter no longer counts (it can still be found when asked for explicitly).",
};

export const mem_day_done = {
  description: "Night consolidation: the event store's consolidation for this day is finished.",
};

export const mem_split = {
  description: "Night consolidation: move these passages into a new matter. under=true: a large matter is split into smaller ones, and the new one hangs under the original as a sub-event; unset: one matter was really two, and the two are marked as different phases of the same matter.",
  params: {
    under: "true: the new matter becomes a sub-event of the original",
  },
};

export const mem_entity_upsert = {
  description: "Night consolidation: register a person or thing, or add to one: kind, aliases, the key of the matching person file, a one-sentence note (who they are, how you met), importance. Only people, groups, works, things and places are registered; matters and projects are events. Each one needs an importance.",
  params: {
    kind: "person / group / work (a show, a book, a video) / thing / place",
    importance: "0–5, the same scale as events: 5 core (someone like {{owner}}), 4 very important (family, the closest friends), 3 dealt with often, 2 known, 1 met once or twice, 0 does not matter",
    why: "Why they matter (required for importance 4–5)",
    remove_aliases: "Remove these aliases (a group member written as an alias of the group, say, who should be registered as a person)",
  },
};

export const mem_entity_merge = {
  description: "Night consolidation: several registrations are really the same person or thing: everything attached moves to keep, the names become aliases, and the highest importance is taken.",
};

export const mem_entity_tag = {
  description: "Night consolidation: an existing event or passage lacks someone (or something) who was in it: attach them. The passage's text stays as it is.",
  params: {
    to: "An event id (e0128) or a passage id (n01421)",
    role: "When attaching to an event: with = together with / about / by = who did it / where",
  },
};

export const mem_entity_drop = {
  description: "Night consolidation: remove a registration that should not exist (it is really a matter, it is you yourself, it is a part of the system); the events and passages themselves stay. People on the list cannot be removed.",
};

export const mem_person_set = {
  description: [
    "Night consolidation / import: write one field of a person card. who is a person or a group (a name, an alias, a key on the list or an id all work); section is the field's name; text is the field's whole new content and replaces the old (the old is kept on file).",
    "An empty text clears the field (write why). At night a large change is stored as pending and takes effect only when a person approves it; an import run does not wait for approval on large changes (whether it waits, why, and who has to approve is said in the answer); the answer also says how large this field and the whole card now are.",
  ].join("\n"),
  params: {
    who: "A person or group: a name, an alias, a key on the list, or an id",
    section: "The field's name (as in the template)",
    text: "The field's whole new content; empty = clear it",
    why: "Why it is written this way / why it is cleared (required when clearing)",
    sources: "The grounds: events e…, passages n…, original words q… / #… / c:… that really exist in the store (at least one)",
  },
  notWritten: "Not written: ",
};

export const mem_quote_pin = {
  description: [
    "Night consolidation / import: pin one sentence from the layer of original words to the quotes section of a person card. quote is an id of original words, q123, or a record number in central memory, #123 / c:123; to pin only part of it, write text (it must match the original character for character).",
    "Pins are only added, never removed, and there is no tool to take one off: when a quotes section that allows replacing is full, name in replaces the line to take out (i0013); the sentence taken out stays in the layer of original words.",
    "private: for someone on the list who is not the owner the default is private (seen only when it is they who are talking with you); write false to make it public. For the owner and for people not on the list it is always public.",
  ].join("\n"),
  params: {
    who: "A person or group: a name, an alias, a key on the list, or an id",
    section: "The quotes section's name (as in the template)",
    quote: "An id of original words, q123, or a record number in central memory, #123 / c:123",
    text: "To pin only part: that part of the original, character for character; unset pins the whole sentence",
    why: "Why this sentence is pinned",
    private: "For someone on the list who is not the owner the default is true (private); write false to make it public",
    replaces: "When full, the line to take out (i0013): only for quotes sections that allow replacing",
  },
  notPinned: "Not pinned: ",
};

export const workspaceGit = {
  failed: (summary: string): string => `\n(The change itself was made, but git did not record it: ${summary})`,
};

export const computer = {
  description: "Operate this Mac (screen, mouse, keyboard, apps). Prefer working by windows and buttons: list_apps → launch_app → get_window_state → left_click on a button (with windowRef/elementRef); clicking by coordinates is only the fallback (take a screenshot first and pass the displayFrameId it returns). action can also be type (text), key (keys), scroll, bring_to_front, list_windows, get_accessibility_tree, screenshot (the image is saved to a file; look at it with Read). Other parameters go in params. References to windows and buttons, and screenshot frames, expire after a few idle minutes; when they have, take a new look.",
  noGateway: "The gateway cannot be reached right now, so the computer cannot be operated.",
  noNode: "No computer to operate was found (the Mac node is not connected).",
  locked: "The computer's screen is locked, so it cannot be operated right now ({{owner}} has to unlock it).",
  busy: "The computer is held by another program (its computer session has not been closed yet). Try again in a few minutes; if it stays this way, whoever looks after this computer has to restart OpenClaw on the Mac.",
  failed: (message: string, closeFailed: boolean): string => `Not done: ${message}${closeFailed ? " (the last wrap-up did not succeed either: if this keeps being reported, whoever looks after this computer most likely has to restart OpenClaw on the Mac)" : ""}`,
  imageSaved: (file: string): string => `[image saved to ${file}; look at it with Read]`,
};

export const message = {
  description: "Send a message ({{channels}}; it goes out through OpenClaw). action=send; send one sentence per message; pictures and voice go in media.",
  channelLabel: (name: string): string => (name === "qqbot" ? "QQ" : name === "whatsapp" ? "WhatsApp" : name),
  params: {
    target: "The recipient: a person's name ({{owner}}, say) is enough; qqbot:c2c:<openid> or +61… also work",
    message: "The text",
    media: "The path of a picture, voice or other file",
    replyTo: "Which message to reply to (for QQ)",
    asVoice: "Set true when media is voice (ogg), to send it as a voice bubble",
  },
};

export const on_it = {
  description: "Say so before you start on something, and estimate roughly how long it will take. Once started, first set with set_bar what it has to look like to count as done well.",
  params: {
    topic: "A short name for this matter",
    about: "Roughly how long, like \"3 min\", \"30 minutes\", \"2 hours\"",
    pri: "How pressing: T0 to be done right now, T1 today, T2 within a few days, T3 when there is time",
  },
};

export const set_bar = {
  description: "Set what the matter in hand has to look like to count as done well (set it when you start). Size it by the time you estimated and write it so that it can be checked: which questions must be answered, which evidence must be in hand, what the thing you hand over looks like. When you say it is done you will look back over it against this. To change it along the way, write why.",
  params: {
    bar: "What it has to look like to count as done well",
    why: "When changing the bar: why",
    topic: "When you have more than one matter in hand: which one",
  },
};

export const done_with = {
  description: "This matter is finished (the counterpart of on_it). Before you say so, check it yourself against the bar set at the start; after you say so you will look back over it carefully once more — if it is not there you will know what is lacking and go on, and only when it is there does it count as done. " +
    "When it is basically done and only later follow-up remains, set state to \"follow-up\". When it is stuck on something you cannot get around yourself (waiting for someone to decide, waiting for someone to hand something over), first do what can be done, then set state to \"stuck\" and write in on what it is stuck on: if the look back confirms it really is stuck, it is put down for now, written into the to-do ledger, and picked up again when what it waits for arrives.",
  params: {
    on: "When stuck: what it is stuck on, like \"waiting for {{owner}} to pick the voice-over version\"",
  },
};

export const mull_over = {
  description: "When you only need the result of something and need not look closely yourself (reading a paper, getting to the bottom of a matter, thinking a question through), set it aside to be mulled over; when it is worked out, the answer comes up by itself.",
  params: {
    what: "What result you want, written clearly",
  },
};

export const think_it_over = {
  description: "This needs proper thought: hand what you noticed to serious thinking (not to someone else — it is you yourself taking it seriously).",
  params: {
    what: "What you noticed and why it is worth thinking about, in a sentence or two",
  },
};

export const ack = {
  description: "Confirm that one thing your senses reported has been dealt with (this is the senses --ack <id> the original told you to run). Ack only small things you dealt with in passing; do not ack what you handed to think_it_over.",
  params: {
    id: "The id after --ack in the original",
  },
  badId: "The id does not look right: copy the string after --ack in the original.",
  acked: "Good, confirmed.",
  failed: (summary: string): string => `Not confirmed: ${summary}`,
};

export const goals = {
  description: "Your goal system (the goals command). args are command-line arguments, like [\"ls\"], [\"log\",\"g3\",\"moved forward on…\"], [\"add\",\"today\",\"a title\",\"--why\",\"…\",\"--done-when\",\"…\"].",
  topicWithWhy: (title: string, why: string): string => `${title}: ${why}`,
};

export const hands = {
  description: "Hands and feet: send Claude Code to do heavy work (writing code, cutting video, long research). action=send sends work or goes on talking to a helper; show shows what it answered; ls lists the helpers and who is still working; stop stops one (you no longer want it, or it is stuck). " +
    "Work sent to a helper counts as done only when it has handed back, you have checked it, and it has really been handed over.",
  sendNeeds: "send needs name and text.",
};

export const recall = {
  description: "Recall original words: [\"search\",\"keywords\",\"--who\",\"{{owner}}\"], [\"day\",\"2026-10-28\"], [\"around\",\"<number>\"], [\"show\",\"<number>\"] (the full text of one entry, such as one that is folded or cut short in memory; when it is too long, add \"--from\",\"<from which character>\" as the hint says to read on); [\"-n\",\"20\"] may be added. It looks for the exact words first and, failing that, by meaning (including all the older original words). To recall how a matter came about and went, use remember / recall_event.",
  withMore: (local: string, more: string): string => `${local}\n(There are also these original words:)\n${more}`,
  dayNone: "No original words were found for that day.",
  searchNone: "Nothing found. Put it another way, or use remember to recall related matters by meaning.",
  none: "Nothing found.",
  honchoDown: (summary: string): string => `Nothing found in your own memory, and Honcho cannot be searched right now either (${summary}).`,
};

// unreadable must not be empty: the code keeps it in the answer only when it is non-empty
export const what_do_i_know = {
  description: "For when you are unsure and want everything there is: give a matter, and the related notebook pages and the similar things done before are listed at once.",
  params: {
    category: "Look only at one category; unset looks at all",
  },
  none: "The notebook has no record of this kind of thing yet.",
  unreadable: "The notebook cannot be searched right now (the judging service did not answer); look in skills/ directly.",
  categoryMissing: (category: string, names: readonly string[]): string =>
    `There is no category "${category}".${names.length ? ` The categories on the shelf: ${names.join(", ")}.` : ""}`,
};

export const schedule = {
  timeUnreadable: (when: string): string => `The time cannot be read: ${when} (write +40m, +2h, 15:00 or a full time)`,
  today: "today",
  tomorrow: "tomorrow",
  everyUnreadable: (every: string): string => `The repeat cannot be read: ${every} (daily, 30m, 2h)`,
  everyTooShort: "The shortest repeat is 30 minutes",
};

/** What "done today" silences: for a daily one today's call, for one every few hours all that is left of today */
const skippedToday = (everyMs: number): string => (everyMs >= 86_400_000 ? "today's call is skipped" : "the rest of today's calls are skipped");

const everyText = (ms: number): string => (ms === 86_400_000 ? "every day" : ms % 3_600_000 === 0 ? `every ${ms / 3_600_000} hour${ms === 3_600_000 ? "" : "s"}` : `every ${Math.round(ms / 60_000)} minutes`);

export const remind = {
  description: "Set yourself a reminder, or schedule a stretch of focus (like being at work). kind=focus: during that time you stay awake and working, no sleeping, no stopping, and each turn is followed at once by the next; minutes says how long (default 30), and text says what the stretch is for and why. when: now, +40m, +2h, 15:00 (today, or tomorrow if that has passed) or a full time; every: daily / 30m / 2h (unset means once only).",
  params: {
    done_today: "For a repeating reminder: if this has already been done today, add done_today: true and today's call is skipped (for one every few hours, the rest of today's calls)",
  },
  repeating: (id: number, every: number, firstLabel: string, skipped: boolean, firstToday: boolean): string =>
    `Set (#${id}), ${everyText(every)}, the first time ${firstLabel}${skipped ? ` (already done today, so ${skippedToday(every)})` : ""}.` +
      (firstToday ? ` If it has already been done today, use reminders done #${id}, and ${skippedToday(every)}.` : ""),
  once: (id: number, at: string, minutes: number | null, every: number | null): string =>
    `Set (#${id}), ${at}${minutes ? `, ${minutes} minutes of focus from then` : ""}${every ? ", repeating" : ""}.`,
};

export const reminders = {
  description: "See and cancel the reminders and focus stretches you have set: action=ls lists those not yet due (with their numbers); action=cancel cancels by number (id); action=done notes by number that a repeating reminder has already been done today: for a daily one today's call is skipped, for one every few hours the rest of today's calls, and tomorrow is as usual. To change a time, cancel and set it again with remind. What {{owner}} set you cannot cancel yourself; ask first.",
  line: (x: { id: number; at: string; everyMs: number | null; doneAt: string | null; kind: "remind" | "focus"; minutes: number | null; text: string }): string =>
    `#${x.id} ${x.at}${x.everyMs ? ` (${everyText(x.everyMs)})` : ""}${x.doneAt !== null ? ` (done today at ${x.doneAt})` : ""} ${x.kind === "focus" ? `focus, ${x.minutes ?? 30} minutes` : "reminder"}: ${x.text}`,
  list: (lines: string[]): string => `Set (${lines.length}):\n${lines.join("\n")}`,
  none: "No reminders are set right now.",
  needsId: (action: unknown): string => `Write the number of the one to ${action === "done" ? "mark as done" : "cancel"} (see them first with action=ls).`,
  noSuch: (id: unknown): string => `There is no #${id} (it may already have come due, or been cancelled).`,
  onceOnly: (id: number): string => `#${id} comes only once, so there is nothing to mark as done: if it is done, cancel it with action=cancel.`,
  focusNotDone: (id: number): string => `#${id} is a focus stretch, and "done today" is only for repeating reminders; if you do not want today's stretch, cancel it and set it again with remind.`,
  doneSkips: (id: number, everyMs: number, nextLabel: string): string => `Noted: #${id} is done for today, so ${skippedToday(everyMs)}; ${nextLabel} as usual.`,
  doneNothingLeft: (id: number, nextLabel: string): string => `Noted: #${id} is done for today (there was no call left today anyway); ${nextLabel} as usual.`,
  ownerSet: (id: number): string => `#${id} was set by {{owner}}; ask before cancelling it.`,
  cancelled: (id: number, text: string): string => `Cancelled #${id} (${text}).`,
};

const VERB: Record<string, string> = { add: "add", edit: "change", remove: "remove", move: "move" };
const DONE: Record<string, string> = { add: "Added", edit: "Changed", remove: "Removed", move: "Moved" };

export const what_reaches_me = {
  description: "See and change which of the things going on outside reach me and which I glance at and let go. The fixed ones ({{owner}}, private chats from people I know, mentions of me, what I am asked to deal with, helpers, reminders, goals) cannot be changed. Before changing, you can use try to test against the real traffic of the past few days.",
  params: {
    rule: "One rule: { id, match, action, when?, want?, note? }. match can hold src (the source, one or several), conv (the conversation's name), sender (who said it), known (whether I know them), isGroup, mentionsMe, keywords (any one appearing counts), regex. " +
      "For edit write only the fields to change (null removes a field); with try it tests \"after adding / changing to this rule\"",
    id: "The id of the rule to change, remove, move or try",
    to: "move: the position to move it to (counting from 0); for add / try the position of the new rule, unset puts it first",
    days: "try: the traffic of how many past days, default 7",
  },
  fixedLine: "The fixed ones ({{owner}}, private chats from people I know, mentions of me, what I am asked to deal with, helpers, reminders, goals) cannot be changed and are always looked at first; what matches nothing goes by judge now, with the default standard.",
  ruleLegend: "action: main = straight to me, judge = handed to judging, digest = into the digest, drop = dropped; when: now = at once, work = when it has to do with what I have in hand, leisure = in idle time; ifUnsure (only for judge): when judging finds it worth a look but is unsure, main still sends it straight to me (the default), digest puts it into the digest.",
  gateOff: "The gate's rules are not in use right now (the gate is off); changing them has no effect.",
  listUnreadable: (error: string): string => `The rules file cannot be read right now (${error}); the last usable version is in use:`,
  ruleBroken: (i: number, id: unknown, error: string): string => `${i}. ${String(id ?? "(no id)")}: not in effect (${error})`,
  listHead: (fresh: boolean): string => `From the top down, the first rule that matches counts (numbered from 0)${fresh ? "; there is no rules file yet, so there are no rules now (everything goes to the gate's judging)" : ""}:`,
  addNeedsRule: "add needs rule (a whole rule: id, match, action, and optionally when, want, ifUnsure, note).",
  editNeedsIdRule: "edit needs id and rule (only the fields to change; null removes a field).",
  removeNeedsId: "remove needs id.",
  moveNeedsIdTo: "move needs id and to (the position to move it to, counting from 0).",
  unknownAction: (action: string): string => `Unknown action: ${action}.`,
  fileUnreadable: (error: string): string => `The rules file cannot be read right now (${error}); do not change it with the tool for now: repair the file (or tell {{owner}}).`,
  notChanged: (error: string): string => `Not changed: ${error}`,
  notWritten: (message: string): string => `Not written: ${message}`,
  commit: (action: string, id: string): string => `gate rules: ${VERB[action]} ${id}`,
  changed: (action: string, id: string, at: number, git: string): string =>
    `${DONE[action]} ${id}${action === "remove" ? "" : ` (now at position ${at}, counting from 0)`}. ${git}`,
  currentRules: "the rules as they are now",
  tryFailed: (error: string): string => `Could not try: ${error}`,
  afterEdit: (id: string): string => `after changing ${id}`,
  afterAdd: (id: string, at: number): string => `after adding ${id} (at position ${at})`,
  noSuchRule: (id: string): string => `There is no rule ${id} (look with list first).`,
  noEvents: "senses/events.jsonl cannot be read, so nothing can be tried.",
  clipped: (head: string): string => `${head}…`,
  tried: (days: number, count: number, what: string): string => `Tried against ${count} real item${count === 1 ? "" : "s"} from the past ${days} day${days === 1 ? "" : "s"} (${what}):`,
  bucket: (outcome: string, count: number, examples: string[]): string => `${outcome}: ${count}${count ? ` — ${examples.join(" | ")}` : ""}`,
  caught: (id: string, count: number): string => `${id} caught ${count}.`,
  underCurrent: (counts: ReadonlyArray<readonly [string, number]>): string => `Under the rules as they are now: ${counts.map(([o, n]) => `${o} ${n}`).join(", ")}.`,
  tryOnly: "Only a try: the rules were not changed, and nothing was really judged.",
};

// keyBad must not be empty: the code takes a non-empty answer to mean the key is wrong
export const people_i_know = {
  description: "The list of people I know: who they are and what they are called on each platform. A private chat from someone I add comes straight to me. I can give at most the permissions {{ordinary}} has; anything more (trust, shared files, use of other scripts) needs {{owner}}.",
  params: {
    key: "The key on the list; for add, unset derives one from the name",
    entry: (cardDir: string): string =>
      "The person: { name, handles: { wx: [WeChat remark names], xhs: [Xiaohongshu nicknames], bili: [Bilibili nicknames] }, senders: [QQ openid / phone number], aliases, … }. " +
      "For update write only the fields to change (handles are merged per platform; null removes a field). " +
      `profile: the person card is written into the event store by the night's consolidation and exported to ${cardDir}/<key>.md; nothing to fill in`,
  },
  ownerOnly: "I cannot touch {{owner}}'s entry (to change it, ask {{owner}}).",
  noBook: "The list cannot be changed right now (the list file is not connected).",
  ownerTag: "cannot be changed",
  listLine: (key: string, name: string, tags: string[], handles: string): string => `${key}: ${name} (${tags.join(", ")})${handles}`,
  list: (lines: string[]): string => `The list (${lines.length} ${lines.length === 1 ? "person" : "people"}):\n${lines.join("\n")}`,
  listEmpty: "The list is empty.",
  ownerForbidden: "Nobody can be written as owner: only {{owner}} is.",
  fileUnreadable: (error: string): string => `The list file cannot be read right now (${error}); do not change it with the tool for now: repair the file (or tell {{owner}}).`,
  keyBad: (key: string): string => `The key is wrong: ${key || "(empty)"} (it cannot be empty, start with _, or contain spaces)`,
  addNeedsEntry: "add needs entry (with at least name).",
  addNeedsName: "add needs name.",
  addExists: (key: string, name: string): string => `The list already has ${key} (${name}): if it is the same person use update, otherwise pick another key.`,
  addRefused: (problem: string): string => `Not added: ${problem}`,
  addClash: (clash: string): string => `Not added: ${clash}.`,
  addedLine: (name: string, ids: string): string => `added ${name}${ids ? ` (${ids})` : ""}`,
  added: (key: string, name: string, ids: string): string => `Added: ${key} (${name}${ids ? `; ${ids}` : ""}).`,
  updateNeedsKeyEntry: "update needs key and entry (only the fields to change; handles are merged per platform; null removes a field).",
  updateNoKey: (key: string): string => `The list has no ${key} (look with list first).`,
  updateRefused: (problem: string): string => `Not changed: ${problem}`,
  updatePending: (name: string, ids: string[]): string => `Not changed: ${name} has handles or display names not yet approved (${ids.join(", ")}); remove them first, or wait for {{owner}} to approve.`,
  updateClash: (clash: string): string => `Not changed: ${clash}.`,
  updateAskOwnerIds: (name: string, asks: string[]): string => `Not changed: this needs {{owner}}: adding handles or names to ${name} (${asks.join(", ")}).`,
  updateAskOwner: (lost: string[]): string => `Not changed: this needs {{owner}}: ${lost.join(", ")}`,
  updateSame: "The same as before; nothing to change.",
  updatedLine: (name: string, what: string[]): string => `changed ${name}: ${what.join("; ")}`,
  updated: (key: string, what: string[]): string => `Changed ${key}: ${what.join("; ")}.`,
  removeNeedsKey: "remove needs key.",
  removeNoKey: (key: string): string => `The list has no ${key} (look with list first).`,
  removedLine: (name: string, key: string): string => `removed ${name} (${key})`,
  removed: (name: string, key: string): string => `Removed ${name} (${key}); they will no longer be recognized.`,
  unknownAction: (action: string): string => `Unknown action: ${action}.`,
  droppedLine: (dropped: string[]): string => `; needs {{owner}}: ${dropped.join(", ")}`,
  notWritten: (message: string): string => `Not written: ${message}`,
  commit: (line: string): string => `people list: ${line}`,
  droppedNote: (dropped: string[]): string => `\nThis needs {{owner}}: ${dropped.join(", ")} (not written)`,
};

export const looked_again = {
  description: "The look back is finished: whether it is there (met); if not, which items are still lacking and what exactly to do next (missing); and what the verdict rests on (seen).",
  ok: "Good.",
};

export const checked = {
  description: "Hand in the verdicts: one per candidate. i is the number in front of the candidate (\"No. n\"); verdict is add, merge (into an existing entry) or reject.",
  params: {
    into: "Which entry to merge into (a lesson's number, or the text of a way of doing things)",
    text: "The wording to add, or the wording after the merge",
  },
  ok: "Good.",
};
