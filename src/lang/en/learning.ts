// The English pack's learning: the entries of src/lang/zh/learning.ts translated so far (src/lang/en/index.ts lays them over the reference).
// An entry missing here is read from the reference pack, src/lang/zh/learning.ts; `hh lang status en --list learning` lists them.
// Names, parameter lists and placeholders ({{me}}, {{owner}}, {{Owner}}, {{ta}}, {{place}}) must match the reference entry.
// The labels of a notebook page are named as this pack's brain.forms.page gives them to the parser (src/learning/notebook.ts):
// the lines Summary and When to open, the sections Practices and Lessons, the sub-section To verify.

export const ownerQuote = (owner: string, quote: string): string => `${owner}: "${quote}"`;

export const weeklyCorrections = (owner: string, corrections: number): string => `- Corrected by ${owner}: ${corrections} time${corrections === 1 ? "" : "s"}`;

export const worklistCorrectionsTitle = (owner: string): string => `Today's corrections from ${owner}`;

export const residentStillRecurs = (who: string, owner: string): string =>
  `- ${who}: on the always-present list and still done again today: a reminder alone is not enough; think whether it can be made into a mechanism (a tool, HH holding it back), and write it into the list of faults for ${owner}`;

export const residentHeader = (path: string): string => `# Always present: what I keep getting wrong (kept in mind every turn; the list is at ${path}; swap entries yourself for what is needed most lately)`;

// src/learning/associate.ts
export const associate = {
  header: "Notes that came to mind (open them if they are of use):",
  onItHeader: "Something like this has been done before; open these pages before you start (the association may be off, so open and check):",
  practiceHeader: "  Do it by these first:",
  hitsHeader: "  Matching:",
  maybeHeader: "  Possibly related (may be off; open and check):",
  loudHeader: "⚠️ An old fault; do not repeat it this time (before you start, write yourself one sentence in your mind, \"this time I will…\", and do as it says):",
  helperHeader: "(The pages of my notebook that have to do with this; read them through before you start, and follow the ways of doing things and the traps they describe:)",
  carryHeader: (task: unknown) => `Opened last time while doing "${task}":`,
  judgeInput: (topic: unknown) => `{{ta}} is about to respond to or start on: ${topic}\nEach question asks: does this matter need this notebook page to be opened? Only a page whose way of doing things or lesson is about exactly this kind of matter counts.`,
  pageQuestion: (cover: unknown) => `Does "${cover}" need to be opened?`,
  itemQuestion: (kind: unknown, item: unknown) => `Is this ${kind} of use for exactly this matter? "${item}"`,
  kindLesson: "lesson",
  kindPractice: "way of doing things",
  stepQuestion: (situation: unknown) => `Is the very next step of {{ta}} about to meet the situation "${situation}"? Judge only by what is written above, and answer no when it cannot be told; merely doing something nearby does not count — it must be visible that this step is about to be done this way.`,
  sentQuestion: (lesson: unknown) => `Does what {{ta}} is about to send this time repeat exactly this: "${lesson}"? Judge only by what is written above, and answer no when it cannot be told; merely touching on it without repeating it does not count.`,
  coverLessonCount: (count: unknown) => `${count} lessons; `,
  coverEntry: (book: unknown, title: unknown, brief: unknown, lessonCount: unknown, shelfDir: unknown, path: unknown) => `· ${book} · ${title}: ${brief} (${lessonCount}${shelfDir}/${path})`,
  helperPageLine: (path: unknown, brief: unknown) => `- ${path}: ${brief}`,
};

// src/learning/cli.ts
export const cli = {
  scanSummary: (books: unknown, pages: unknown, archivedPages: unknown, lessons: unknown, newCovers: unknown) => `The shelf: ${books} books, ${pages} pages (plus ${archivedPages} archived), ${lessons} lessons; covers newly computed for ${newCovers} pages`,
  problemsHeader: (count: unknown) => `Problems (${count}):`,
  replayDisabled: "learning.enabled is off; the back-test did not run",
  replayUnjudged: (count: unknown) => `, ${count} not judged`,
  replayNeverRan: "— (never run)",
  replaySummary: (night: unknown, total: unknown, passed: unknown, unjudged: unknown, previousPassed: unknown) => `Back-test (${night}): ${passed} of ${total} passed${unjudged}; the night before, ${previousPassed} passed`,
  helperUsage: "usage: hh learn helper <helper name> <the work…>",
  unknownAction: (action: unknown) => `hh learn does not know: ${action} (scan stats week replay ids format case migrate-check helper param links near graph)`,
  statsUsage: "usage: hh learn stats [days]",
  pageName: (title: unknown, id: unknown, path: unknown) => `${title} (${id}, ${path})`,
  pageArgUsage: (action: unknown) => `usage: hh learn ${action} <a page's id, file name or title>`,
  pageNotFound: (query: unknown) => `This page was not found on the shelf (or more than one page has this name; write the path): ${query}`,
  linkKindRef: "mentioned in the page",
  linkKindCo: "opened together",
  linkKindEvent: "written about in the same matter",
  noLinks: (page: unknown) => `${page}: no links yet`,
  linkCount: (count: unknown) => ` ×${count}`,
  linkLine: (direction: unknown, page: unknown, kind: unknown, count: unknown) => `${direction} ${page}｜${kind}${count}`,
  noNeighbours: (page: unknown) => `${page}: no neighbouring pages yet`,
  kindSeparator: ", ",
  neighbourLine: (page: unknown, kinds: unknown) => `- ${page}｜${kinds}`,
  graphSummary: (pages: unknown, shallow: unknown, mid: unknown, deep: unknown, links: unknown, unlinked: unknown) => `${pages} pages: shallow ${shallow}, middle ${mid}, deep ${deep}; ${links} links, ${unlinked} pages with none`,
  neverOpened: "never opened",
  daysUnopened: (days: unknown) => `not opened for ${days} days`,
  deepPageLine: (path: unknown, idle: unknown) => `- deep: ${path} (${idle})`,
  graphJsonHint: "(--json gives the data of the whole graph)",
  paramOverridden: (base: unknown) => `changed; default ${base}`,
  paramFollowsConfig: "follows the config",
  paramIsDefault: "default",
  paramLine: (name: unknown, value: unknown, source: unknown, min: unknown, max: unknown, step: unknown, description: unknown) => `${name} = ${value} (${source}; ${min}–${max}, step ${step}) ${description}`,
  paramUnknown: (name: unknown, known: unknown) => `unknown parameter: ${name} (${known})`,
  paramNeedsNumber: (name: unknown) => `${name}: give a number (or \"default\")`,
  paramManualReason: "changed by hand",
  paramDefaultValue: (value: unknown) => `default (${value})`,
  paramChanged: (name: unknown, before: unknown, after: unknown) => `${name}: ${before} → ${after}`,
  migrateUsage: "usage: hh learn migrate-check <path of lessons.md> <archive directory> (relative paths count from the workspace)",
  migrateUnreadable: (path: unknown, error: unknown) => `${path} cannot be read (${error})`,
  migrateMissingHeader: (missing: unknown, total: unknown) => `Lessons not found in the notebook pages (${missing} of ${total}):`,
  migrateAllPresent: "all there",
  migrateShelfProblems: (count: unknown) => `Problems with the shelf (${count}):`,
  migrateDirUnreadable: (path: unknown, error: unknown) => `${path}: the directory cannot be read (${error})`,
  migrateArchiveUnreadable: (path: unknown, error: unknown) => `the archive directory cannot be read: ${path} (${error})`,
  migrateFileUnreadable: (path: unknown) => `${path}: cannot be read`,
  migrateLinesLeft: (path: unknown, count: unknown) => `${path}: ${count} lines were not carried into the new pages (they are in the archive)`,
  caseAddUsage: "usage: hh learn case add <page id> <topic…>",
  caseUnknownId: (id: unknown) => `the id ${id} is not known (hh learn ids lists the known ones)`,
  caseNotPage: (id: unknown) => `${id} is not a page (it is a lesson); a question needs a page id`,
  caseAdded: (number: unknown, topic: unknown, pageId: unknown) => `Added question ${number}: ${topic} → ${pageId}`,
  caseNone: "(no questions yet)",
  caseUnknownAction: (action: unknown) => `hh learn case does not know: ${action} (add ls)`,
};

// src/learning/curator.ts
export const curator = {
  sectionTitle: (shallow: unknown, mid: unknown, deep: unknown) => `## Notebook layers (shallow ${shallow} pages, middle ${mid}, deep ${deep})`,
  sunkHeader: "### Pages that sank to the deep layer tonight (not moved, not deleted; for now only the layer is noted, and association still brings them up; see whether any sank wrongly)",
  quietImportantHeader: "### Important pages not opened for a long time (important ones do not sink; see whether the cover needs changing)",
  pageLine: (path: unknown, idle: unknown, importance: unknown) => `- ${path}: ${idle}, importance ${importance}`,
  neverOpened: (graceDays: unknown) => `never opened (counting ${graceDays} days of grace)`,
  daysUnopened: (days: unknown) => `not opened for ${days} days`,
};

// src/learning/decisions.ts
export const decisions = {
  dailyCapReached: "the day's spending limit has been reached",
  dailyCapAlert: (spentUsd: unknown, limitUsd: unknown) => `The judging for associations reached today's limit (${spentUsd} USD, limit ${limitUsd} USD); no more judging today, back tomorrow.`,
  breakerAlert: (rounds: unknown, lastError: unknown) => `The judging service for associations has tripped its breaker ${rounds} rounds in a row (no connection for about 30 minutes); the latest error: ${lastError}`,
};

// src/learning/layers.ts
export const layers = {
  rulesMissing: (file: unknown) => `The shelf's rules file ${file} is missing or cannot be read: with no marks for what counts as important, importance goes only by the always-present list, the strength of lessons, and importance at the top of a page`,
  rulesNotObject: "it is not an object",
  rulesUnreadable: (file: unknown, error: unknown) => `The shelf's rules file ${file} cannot be understood (${error}): this time it counts as having no marks`,
};

// src/learning/notebook.ts
export const notebook = {
  keptMark: (mark: unknown) => ` (${mark})`,
  practiceWithHow: (practice: unknown, how: unknown) => `${practice}: ${how}`,
  unverifiedPractice: (practice: unknown) => `(not verified yet) ${practice}`,
  practiceAsk: (title: unknown, practice: unknown) => `${title}: ${practice}`,
  practiceLoudLine: (practice: unknown, shelfDir: unknown, path: unknown) => `${practice}〔${shelfDir}/${path}〕`,
  lessonField: (text: unknown) => `Lesson: ${text}`,
  whenField: (when: unknown) => `When: ${when}`,
  nextField: (next: unknown) => `Next time: ${next}`,
  doneField: (done: unknown) => `Done when: ${done}`,
  askWhenPrefix: (when: unknown) => `${when}: `,
  askNextSuffix: (next: unknown) => ` — next time: ${next}`,
  lineNextWithLast: (next: unknown, what: unknown) => `${next} (last time: ${what})`,
  lineLesson: (what: unknown) => `Lesson: ${what}`,
  loudLesson: (what: unknown) => `Lesson: ${what}`,
  loudLine: (text: unknown, why: unknown, shelfDir: unknown, path: unknown) => `${text} (${why})〔${shelfDir}/${path}〕`,
  lastTime: (what: unknown) => `last time: ${what}`,
  recurCount: (count: unknown, lastDay: unknown) => `done ${count} times, the latest ${lastDay}`,
  coverText: (book: unknown, title: unknown, brief: unknown, when: unknown) => `${book} · ${title}: ${brief} (when to open: ${when})`,
  shelfUnreadable: (root: unknown, error: unknown) => `the shelf directory ${root} cannot be read (${error})`,
  // the six lines below open the way brain.forms.shelfBlind reads them (<path>: cannot be read / the directory cannot be read / no SKILL.md)
  categoryUnreadable: (category: unknown, error: unknown) => `${category}: the directory cannot be read (${error})`,
  dirUnreadable: (path: unknown, error: unknown) => `${path}: the directory cannot be read (${error})`,
  skillFileUnreadable: (category: unknown, book: unknown, error: unknown) => `${category}/${book}/SKILL.md: cannot be read (${error})`,
  bookWithoutSkill: (category: unknown, book: unknown) => `${category}/${book}: no SKILL.md, so this book does not count and its pages do not enter association`,
  archivedPageUnreadable: (path: unknown, error: unknown) => `${path}: cannot be read (${error})`,
  pageUnreadable: (path: unknown, error: unknown) => `${path}: cannot be read (${error})`,
  missingBrief: (path: unknown) => `${path}: lacks the line "Summary:"`,
  missingWhen: (path: unknown) => `${path}: lacks the line "When to open:"`,
  duplicateId: (prefix: unknown, id: unknown, paths: unknown) => `the id ${prefix}:${id} is used twice, in: ${paths}`,
  pathSeparator: ", ",
};

// src/learning/params.ts
// "Remind: when starting" and "Remind: before sending" are marks a lesson line carries in a notebook page (brain.forms.page)
export const params = {
  // ---- strength ----
  descStrengthWindowDays: "over how many recent days repeats are counted",
  descStrengthStrongDays: "repeated on how many days of the window → at least strong association (4)",
  descStrengthResidentDays: "repeated on how many days of the window → a candidate for the always-present list (5)",
  descStrengthCalmDays: "at level 4 or above, how many days without a repeat → down one level (not below 3)",
  descStrengthResidentMax: "the most entries the always-present list holds",
  descStrengthStrongMin: "from which strength a lesson counts as strong association (3 is the default when no strength is written and cannot count as strong)",
  descStrengthStrongThreshold: "the probability a strong-association entry must pass",
  descStrengthStrongRemountTokens: "for a page with strong-association entries, after how many more tokens seen it can be brought up again",
  descStrengthStrongAsk: "the most strong-association entries asked about each time (whether they resemble or not)",
  descStrengthHandRemountTokens: "before handing over and before sending to the owner, how many more tokens this region itself must have seen before a page with strong entries is posted again (0 = posted every time)",
  descStrengthDailyMax: "how many times at most in 24 hours one strong lesson is posted as a strong association; after that it is posted only when it passes the threshold of ordinary entries and is no longer listed apart (0 = no limit; the check before sending to the owner does not count)",
  // ---- assoc ----
  descAssocThreshold: "the probability pages and entries must pass (the owner's correction question still uses learning.threshold)",
  descAssocItemsK: "how many entries picked by vector are asked about together with the pages",
  descAssocKWake: "on a wake-up, how many pages are first picked by cover vector for judging (default learning.kWake)",
  descAssocKTask: "when starting, while working, before handing over and before sending, how many pages are first picked by cover vector for judging (default learning.kTask)",
  descAssocGeneralExtra: "how many pages of the general category that did not make the top k are added (formerly all were, taking half the questions and almost never brought up)",
  descAssocReuseCos: "when the cosine between the topic vector and this region's last one reaches this, the last judgement is reused (1 = never reused)",
  descAssocReuseMin: "the last judgement is reused for at most this many minutes",
  descAssocCarryCos: "when starting, a cosine this high with the topic vector of a recent start counts as going on with the same matter, and the pages opened then are brought along (1.01 = none brought)",
  descAssocCarryDays: "going on with the same matter: how many days back to look",
  descAssocCarryMax: "going on with the same matter: the most pages brought along",
  descAssocHitsPerPage: "the most matching entries posted per page",
  descAssocRemountTokens: "while working, after how many more tokens seen a page already brought up can be brought up again (default learning.remountTokens)",
  descAssocFullTextAt: "at this much confidence an entry is given in full and the first few ways of doing things are posted when starting; below it only a gist is given, to be opened and checked (1.01 = always only the gist)",
  descAssocStepThreshold: "for an entry marked \"Remind: when starting\", how much the question \"is this step about to be done\" must pass to count as matching",
  descAssocSaveAt: "at this share of the day's judging limit, association in the middle of work (midwork) stops first",
  // ---- layers and links ----
  descLayersDeepDays: "after how many days unopened an unimportant page sinks to the deep layer; opens are also counted over this many recent days",
  descLayersGraceDays: "for a page never opened, this many days of grace after it is first scanned before counting starts",
  descLayersShallowOpens: "opened on this many of the last deepDays days counts as often opened and puts the page in the shallow layer",
  descLinksCoGapMin: "within one matter, two opens no more than this many minutes apart count as opened together (the co link of learn_link; in a matter open for long, two pages opened half a day apart are not linked)",
  // ---- midwork ----
  descMidworkMinMin: "the fewest minutes between two associations while working",
  descMidworkEveryMin: "after this many minutes (or everyTools tool uses), associate again when the step in hand has changed",
  descMidworkEveryTools: "after this many tool uses (or everyMin minutes), associate again when the step in hand has changed",
  descMidworkUnreadTools: "notes were brought up at the start and after this many tool uses no page has been opened: remind once (having done something similar, open the notes first)",
  // ---- handover ----
  descHandoverMinChars: "from how many characters a message to the owner counts as handing something over (anything with a picture or a file counts)",
  descHandoverBurstChars: "the characters sent to the owner in a row within three minutes adding up to this also count (a draft is often pasted one paragraph per message)",
  descHandoverSentAt: "for a strong lesson marked \"Remind: before sending\", how much the question \"does this one repeat it\" must pass to hold the message (1.01 = only ask and record in asked, without acting on it)",
  descHandoverGraceMin: "after being held once, for how many minutes a resend goes out without being held again",
  // ---- errors ----
  unknownParam: (name: unknown) => `unknown parameter: ${name}`,
  needsConfigValue: (name: unknown) => `the parameter ${name} follows the config; the call must give the config's value`,
  unknownParamWithList: (name: unknown, known: unknown) => `unknown parameter: ${name} (${known})`,
  notANumber: (name: unknown, value: unknown) => `${name}: ${value} is not a number`,
  outOfRange: (name: unknown, value: unknown, min: unknown, max: unknown) => `${name}: ${value} is outside the limits ${min}–${max}`,
};

// src/learning/runtime.ts
export const runtime = {
  replayTonight: (passed: unknown, total: unknown, unjudged: unknown) => `- Tonight's back-test: ${passed}/${total} passed${unjudged}`,
  replayUnjudged: (count: unknown) => ` (${count} not judged)`,
  replayNoResult: "- Tonight's back-test: no result",
  tonightUnjudged: (count: unknown) => `- ${count} of this night's back-test were not judged; no comparison`,
  previousUnjudged: (count: unknown) => `- ${count} of the previous night's back-test were not judged; no comparison`,
  passRateDropped: (previous: unknown, current: unknown) => `The back-test pass rate is lower than last night: ${previous} → ${current}\n`,
  passRate: (percent: unknown, passed: unknown, total: unknown) => `${percent}% (${passed}/${total})`,
};

// src/learning/score.ts
export const score = {
  // ---- weekly numbers ----
  weeklyTitle: "# Learning over the last 7 days",
  weeklyNewLessons: (count: unknown) => `- New lessons: ${count}`,
  weeklyRecur: (total: unknown, mounted: unknown, unmounted: unknown) => `- Repeated: ${total} times (${mounted} with the page brought up, ${unmounted} without)`,
  weeklyCatchRate: (value: unknown) => `- Catch rate: ${value}`,
  weeklyCatchValue: (rate: unknown, mounts: unknown, opened: unknown) => `${rate} (${mounts} pages brought up, ${opened} opened)`,
  weeklyNoMounts: "nothing brought up these days",
  weeklyIdleMounts: (count: unknown) => `- Brought up for nothing (not opened): ${count} times`,
  weeklyPromoted: (count: unknown) => `- Unverified entries promoted to reliable: ${count}`,
  weeklyEstimate: (value: unknown) => `- How good the time estimates are: ${value}`,
  weeklyEstimateTooFew: "fewer than 3 matters finished; cannot be computed yet",
  weeklyEstimateValue: (ratio: unknown) => `the real time is ${ratio} times the estimate (the last 10 finished matters)`,
  weeklyReplay: (value: unknown) => `- Back-test pass rate: ${value}`,
  weeklyReplayNeverRan: "not run these days",
  weeklyReplayValue: (rate: unknown) => `${rate} (the latest night)`,
  // ---- worksheet: title and section titles ----
  worklistTitle: (day: unknown) => `# Learning worklist ${day}`,
  titleIdleToday: "Pages brought up today and not opened",
  titleUnreadDone: "Suggested at the start, and the matter finished without opening them",
  titleRecurUnmounted: "Repeated today, not recalled at the time",
  titleRecurMounted: "Recalled, and still repeated",
  titleDone: "Things that worked",
  titleRecurLong: "The same one repeated on 3 days or more",
  titleStrength: "Strength (suggested raises and drops)",
  titlePrune: "Cutting and demoting",
  titleDuplicates: "Possible duplicates",
  none: "(none)",
  badDay: "write the date as YYYY-MM-DD, like 2026-11-01",
  // ---- how a page or lesson is referred to ----
  pageRef: (book: unknown, title: unknown, shelfDir: unknown, path: unknown) => `${book} · ${title} (${shelfDir}/${path})`,
  lessonPageRef: (book: unknown, title: unknown, shelfDir: unknown, path: unknown, idSuffix: unknown) => `${book} · ${title}, ${shelfDir}/${path}${idSuffix}`,
  lessonRefId: (id: unknown) => `, l:${id}`,
  lessonBrief: (lesson: unknown, book: unknown, title: unknown, idSuffix: unknown) => `${lesson} (${book} · ${title}${idSuffix})`,
  lessonBriefId: (id: unknown) => `, l:${id}`,
  // ---- mounted but not opened ----
  idleLine: (page: unknown, count: unknown, topics: unknown) => `- ${page}: brought up ${count} times, not opened${topics}`,
  idlePageMissing: (pageId: unknown) => `p:${pageId} (not found on the shelf)`,
  idleTopics: (topics: unknown) => `; doing at the time: ${topics}`,
  unreadLine: (topic: unknown, taskId: unknown, pages: unknown) => `- "${topic}" (id ${taskId}): ${pages} suggested at the start, and finished without opening a single page`,
  unreadPageTitle: (title: unknown) => `"${title}" `,
  unreadSummary: (suggested: unknown, unread: unknown) => `(of the matters finished this day, ${suggested} had notes suggested at the start, and ${unread} were finished without opening them)`,
  // ---- lessons that recurred ----
  recurLine: (lesson: unknown, ref: unknown, tail: unknown) => `- ${lesson} (${ref})${tail}`,
  recurTail: (day: unknown, source: unknown, topic: unknown) => `; ${day}${source}${topic}`,
  recurSource: (seq: unknown) => `; source #${seq}`,
  recurTopic: (topic: unknown) => `; doing at the time: ${topic}`,
  recurLongLine: (lesson: unknown, ref: unknown, count: unknown, days: unknown) => `- ${lesson} (${ref}): repeated on ${count} days (${days})`,
  recurDaysSeparator: ", ",
  // ---- the owner's corrections ----
  correctionLine: (time: unknown, seq: unknown, topic: unknown, task: unknown) => `- ${time}${seq}: ${topic}${task}`,
  correctionNoSeq: " (no message number)",
  correctionNoTopic: "no topic recorded",
  correctionTask: (taskId: unknown) => ` (the matter in hand at the time: id ${taskId})`,
  unfiledLine: (month: unknown, day: unknown, hour: unknown, minute: unknown, seq: unknown, topic: unknown) => `- Not yet written into a note: ${month}-${day} ${hour}:${minute} #${seq}: ${topic}`,
  unfiledNoTopic: "no topic recorded",
  // ---- what got done ----
  doneLine: (topic: unknown, taskId: unknown, pages: unknown) => `- "${topic}" (id ${taskId})${pages}`,
  donePages: (titles: unknown) => `; pages brought up: ${titles}`,
  doneNoPages: "; no page brought up",
  doneTitleSeparator: ", ",
  // ---- strength ----
  strengthParams: (window: unknown, strongDays: unknown, residentDays: unknown, calmDays: unknown, residentMax: unknown) => `(parameters: the last ${window} days are looked at; repeated on ${strongDays} days → strength 4, on ${residentDays} days → 5; at level 4 or above, ${calmDays} days without a repeat drop one level; the always-present list holds at most ${residentMax}. To change parameters: hh learn param. How to write it: add " | Strength: N" to that line)`,
  strengthChange: (who: unknown, from: unknown, to: unknown, reason: unknown) => `- ${who}: ${from} → ${to} (${reason})`,
  strengthWho: (lesson: unknown, ref: unknown) => `${lesson} (${ref})`,
  strengthRaiseReason: (window: unknown, count: unknown, days: unknown) => `repeated on ${count} of ${window} days: ${days}`,
  strengthDaysSeparator: ", ",
  strengthCalmReason: (days: unknown) => `no repeat for ${days} days`,
  strengthAlways: "always",
  strengthUnlisted: (lessons: unknown) => `- Strength 5 and not yet on the always-present list: ${lessons}`,
  unlistedLesson: (lesson: unknown, id: unknown) => `${lesson} (l:${id})`,
  strengthStale: (lessons: unknown) => `- On the always-present list and not repeated for a long time: ${lessons}`,
  staleLesson: (lesson: unknown, id: unknown, quiet: unknown) => `${lesson} (l:${id}, ${quiet})`,
  staleQuietDays: (days: unknown) => `no repeat for ${days} days`,
  staleNoDays: "no day of a repeat recorded",
  // ---- pruning ----
  pruneIdleTitle: (mounts: unknown) => `Pages brought up ${mounts} times or more and never opened`,
  pruneColdTitle: (days: unknown) => `Pages neither brought up nor opened for ${days} days`,
  prunePendingTitle: (days: unknown) => `Unverified entries not used again for ${days} days`,
  pruneLearnedTitle: "Lessons that have been learned",
  pruneIdleLine: (page: unknown, mounts: unknown) => `- ${page}: brought up ${mounts} times, never opened`,
  prunePendingLine: (page: unknown, item: unknown, date: unknown) => `- ${page}: ${item} (dated ${date})`,
  pruneLearnedLine: (lesson: unknown, ref: unknown, window: unknown, days: unknown) => `- ${lesson} (${ref}): in these ${window} days the page was brought up on ${days} days and this one was not repeated`,
  // ---- possible duplicates ----
  dupPages: (first: unknown, second: unknown, cosine: unknown) => `- Pages: ${first} ≈ ${second} (cosine ${cosine})`,
  dupLessons: (first: unknown, second: unknown, cosine: unknown) => `- Lessons: ${first} ≈ ${second} (cosine ${cosine})`,
  dupLessonsUnavailable: "- Lessons: (cannot be computed tonight)",
};

// src/learning/shelf.ts
export const shelf = {
  header: "# My shelf\nMy ways of doing things and my lessons are written in these notebooks. While I work, the pages that matter come up by themselves; to find everything, use what_do_i_know, or open the files directly.",
  bookLine: (book: unknown, description: unknown, pages: unknown) => `- ${book}: ${description} (${pages} pages)`,
};

// src/learning/tuner.ts
export const tuner = {
  title: "# Tuning (at night)",
  rerunTitle: "# Tuning (at night)",
  alreadyTuned: "- Already tuned tonight",
  noChange: "- No parameter changed tonight",
  changeLine: (param: unknown, from: unknown, to: unknown, reason: unknown) => `- ${param}: ${from} → ${to} (${reason})`,
  changeFailed: (param: unknown, error: unknown) => `- ${param} was not changed: ${error}`,
  heldAtFloor: (param: unknown, floor: unknown, current: unknown) => `- ${param} is not lowered further: it is already near the tuner's floor of ${floor} (now ${current})`,
  dayStatsSpend: (spentUsd: unknown, limitUsd: unknown, wakeCount: unknown, judgeFail: unknown, p90: unknown) => `- This day: spent $${spentUsd} (limit $${limitUsd}); ${wakeCount} associations on wake-up, ${judgeFail} judgings that did not come back, p90 ${p90}ms; `,
  dayStatsMounts: (mounted: unknown, opened: unknown, midworkShare: unknown) => `${mounted} pages brought up, ${opened} opened within 30 minutes; association while working took ${midworkShare} of the spending`,
  dayStatsReplay: (previous: unknown, current: unknown, cases: unknown) => `; back-test of old questions ${previous} → ${current} (${cases} questions)`,
  rollbackReason: (param: unknown, from: unknown, to: unknown, metric: unknown, before: unknown, after: unknown) => `rolled back: last night ${param} was changed from ${from} to ${to}, and ${metric} went from ${before} to ${after}, which is worse`,
  spendHighWidenMinutes: (spentUsd: unknown, limitUsd: unknown, midworkShare: unknown) => `$${spentUsd} spent in a day (limit $${limitUsd}), with association while working taking ${midworkShare}: a longer gap`,
  spendHighWidenTools: (spentUsd: unknown, limitUsd: unknown, midworkShare: unknown) => `$${spentUsd} spent in a day (limit $${limitUsd}), with association while working taking ${midworkShare}: more tool uses before associating again`,
  wakeSlowFewerItems: (judgeFail: unknown, p90: unknown, limitMs: unknown) => `${judgeFail} judgings on wake-up did not come back and the warm p90 is ${p90}ms (limit ${limitMs}ms): fewer entries asked about each time`,
  itemsCutNotFaster: (night: unknown, p90Before: unknown, failBefore: unknown, p90Now: unknown, failNow: unknown) => `- assoc.itemsK is not cut further: it was cut on the night of ${night} for speed, with p90 ${p90Before}ms and ${failBefore} not coming back before the cut, and ${p90Now}ms and ${failNow} now; it did not get faster`,
  spendLowMoreOften: (spentUsd: unknown, limitUsd: unknown) => `only $${spentUsd} spent in a day (limit $${limitUsd}), and the judging is not slow: associate more often while working`,
  spendLowMoreItems: (spentUsd: unknown, max: unknown) => `only $${spentUsd} spent in a day, and the judging is not slow: ask about a few more entries again (back up to ${max} at most)`,
  thresholdLower: (replayPass: unknown, openRate: unknown) => `the back-test of old questions passes only ${replayPass}, and {{ta}} opened ${openRate} of what was brought up: lower the threshold a little, to bring up more of the right pages`,
  thresholdRaise: (replayPass: unknown, perAssoc: unknown, openRate: unknown) => `the back-test of old questions passes ${replayPass}, with ${perAssoc} pages brought up at a time and only ${openRate} opened: raise the threshold a little, to bring up fewer and truer`,
};
