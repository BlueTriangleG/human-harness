# The language pack

Everything a role reads that the framework wrote — prompts, tool descriptions and replies, the views of its memory,
the notes the gate, the night and the repair line hand it — is text in a language pack, not in code. Code decides
*when* something is said; the pack decides *how it is worded*. A second language is a second pack; a role chooses its
pack with `lang` in its instance config.

Owner of this contract: the framework. Consumed by: every module under `src/`.

## Where things are

| | |
|---|---|
| `src/lang/index.ts` | The only module code imports. Live bindings to the current pack, one per part: `P` prompts, `T` tools, `M` memory, `G` gate, `L` learning, `S` sleep, `R` repair, `B` everything else. `N` holds the bound names. `setLang(code, names)` picks the pack. |
| `src/lang/<code>/` | One pack. One file per part (`prompts.ts`, `tools.ts`, …), plus `defaults.ts`: the config values that depend on the language, laid under `config/default.json`. |
| `src/lang/zh/` | The reference pack: its shape is the type every other pack must satisfy (`LangPack`), so a missing or mis-typed entry in another pack does not compile — except in a pack being translated, which reads its missing entries from the reference (see "Adding a language"). |
| `src/lang/overlay.ts` | How a pack being translated is built: `overlay()` lays its entries over the reference's parts, `gaps()` lists what it lacks. |

A part file exports one object per source module that reads it (`export const deploy = { … }` is read by
`src/repair/deploy.ts` as `R.deploy.<entry>`). An entry is a string, or a function returning a string when the
sentence has holes:

```ts
export const tasks = {
  // ---- handing work back ----
  handedBack: (title: string, minutes: number) => `…${title}…${minutes}…`,
};
```

## Rules for code

- Read an entry where it is used: `T.deliver.noChannel(name)`. Never copy `P.x` into a module-level constant — the
  bindings change when a process picks its pack, and a constant would keep the previous pack's text.
- No sentence in code. A string literal a role, a helper model or the owner will read belongs in the pack. What stays
  in code: log messages (English), error messages only an engineer sees (English), and **data** — values that are
  stored and later compared (a field's type name in a row, a marker in a file the code parses back).
- A marker that one place writes and another place recognises is **one** entry, read by both. Never a sentence in the
  pack on one side and a literal or a regular expression in code on the other: a translator changing the sentence
  would silently break the recogniser.
- Patterns that parse what a person writes in their language (number words, "in two hours") are pack entries named as
  patterns (`…Pattern`), not code.
- A file that runs outside the repository tree cannot read the pack. Today that is `src/repair/watchdog.ts`: the deploy
  copies it out and it runs alone, importing nothing local. Its sentences are rendered ahead by the deploy
  (`watchdogText()` in `src/repair/deploy.ts`) and handed to it, so the entries of that group must be plain
  templates, and their keys are a wire format between the two files.
- A program entry point binds the pack before anything is said: `setLang(cfg.lang, roleNames(cfg))` is the first
  thing after the config is loaded (`src/hhd.ts`, `src/cli.ts`, `src/console/main.ts`). A process that skips it reads
  the placeholders unfilled.

## Names

Pack text names nobody. Where a sentence addresses the role or its owner it carries a placeholder: `{{me}}`,
`{{owner}}` (`{{Owner}}` capitalised), `{{ta}}` (the third-person word others use for the role), `{{place}}` (where
the role lives). A process that speaks as a role binds them once, at start: `setLang(cfg.lang, roleNames(cfg))`
(`roleNames` reads the role's names from its instance config). Code that must recognise a name — "is this speaker the
owner?" — compares with `N.owner`, `N.me`, `N.id`, never with a literal. Tests bind made-up names by importing
`test/names.ts`.

## Naming an entry

The reader of a call site must know which sentence appears without opening the pack.

- The name says what the sentence is for, or the situation it is said in — `routingFailed`, `focusStartedByOwner`,
  `pageTurnForkFailed` — not its wording, and never a running number.
- Entries of one feature share their first word (`task…`, `look…`, `digest…`) and sit together under a section
  comment (`// ---- page turn ----`), in the order the code uses them.
- A table of labels is named as a table: `sourceNamePlain`, `sourceNameQuota`.
- Parameters are named for what they carry (`reason`, `minutes`, `taskTitle`), typed as narrowly as the callers allow.
- The same sentence for the same purpose is one entry with two readers, not two entries.

## Adding a sentence

1. Add the entry to the reference pack's part file, in its feature's section, named by the rules above.
2. Read it through the binding at the place of use.
3. Add it to every other complete pack (the compiler lists the packs that lack it); a pack being translated reads it
   from the reference until it is translated (`hh lang status` lists it).
A sentence the role reads is a prompt: write it for a reader who has nothing but the page — say what happened and
what can be done, in the role's own vocabulary, without internal terms.

## Adding a language

A new language starts empty and is filled entry by entry: its pack is an **overlay** on the reference pack. It holds
only the entries translated so far; every entry it does not have is read from the reference pack, so a role can run
in that language at every moment of the translation. English (`src/lang/en/`) is built this way.

- **Its files.** `src/lang/<code>/` has one file per part with the reference's file names (`prompts.ts`, `tools.ts`,
  `memory.ts`, …). A part with nothing translated is its three-line header and `export {};`. An entry is translated
  by writing it in that file under the reference's names: `export const deliver = { noGateway: "…" }` in
  `src/lang/en/tools.ts` gives `T.deliver.noGateway` and nothing else of `deliver`. `src/lang/<code>/index.ts` builds
  the pack — each part is `overlay(zh.<part>, <part>)` (`src/lang/overlay.ts`), `own` keeps the files' parts for the
  listing — and the pack is registered next to `zh` in `src/lang/index.ts`. A role uses it with `lang` in its
  instance config.
- **What must match the reference entry.** Its name and every key on the way to it; its parameter list (the same
  parameters, of the same types, in the same order: copy the reference's signature); its placeholders (`{{me}}`,
  `{{owner}}`, `{{Owner}}`, `{{ta}}`, `{{place}}` — the ones the reference sentence has). tsc refuses another
  parameter list and a name the reference does not have, where `src/lang/<code>/index.ts` lays the part over the
  reference; placeholders are not checked.
- **What is missing.** `hh lang status [<code>]` prints, per part, the entries the pack has of its own out of the
  reference's, and any entry it has that the reference does not (never read: most likely a misspelled name).
  `hh lang status <code> --list <part>` prints the entries of that part still read from the reference, one dotted
  path per line (`tools.deliver.noChannel`).
- **Config defaults.** The pack's `defaults` are the reference's until they are translated too; they are not counted
  by `hh lang status`.

Translating is prompt writing for a reader in that language: the unit of translation is the sentence's purpose (see
its entry name and its call site), not its words.
