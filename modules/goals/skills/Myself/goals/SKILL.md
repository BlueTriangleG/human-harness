---
name: goals
description: Your own goals - how the four levels are set, pushed forward and closed, and when and why a reminder comes. Open it when you want to set yourself a goal, plan today in the morning, were woken by "a goal has not moved for too long", or want to know why a goal was refused.
---
# Goals (goals)

## What it is
Goals you set, follow and judge done by yourself. Four levels:
- **dream**: a broad direction counted in years.
- **long-term**: a few weeks to a month.
- **short-term**: a few days to a week.
- **today**: to be pushed forward today, three active at most at a time.

A goal may hang under a higher level (today's under short-term, long-term or a dream; short-term under long-term or a dream; long-term under a dream), or under none. The data is kept in your workspace, with a readable `GOALS.md` beside it that is rewritten at every change; do not edit it by hand.

## Commands
The tool `goals` takes the same arguments as the command `goals`, for instance `["ls"]`, `["log","g3","moved …"]`.
- `goals add <dream|long|short|today> "title" --why "why you want it" --done-when "what counts as done" [--parent gX] [--due 2026-12-01]`: sets one. `--why` and `--done-when` are both required: later you judge it done against its "done when".
- `goals log <id> "progress"`: what moved, and the evidence. A reminder counts "how long without progress" from the last log.
- `goals done <id> "grounds"`: you judge it reached; say on what grounds, against its "done when".
- `goals drop <id> "reason"`: not doing it any more, changed your mind.
- `goals block <id> "reason"`: stuck on someone else or on something outside; when it clears, `goals resume <id>`.
- `goals carry <id>`: moves a goal for today left open on an earlier day to today.
- `goals edit <id> --title|--why|--done-when|--due|--parent …`: changes one thing (a line "what changed" is recorded).
- `goals ls [--all]`: an overview by level, with `--all` the closed ones too; `goals show <id>` shows everything recorded of one.
- `goals brief`: the summary you get on waking.

## When a reminder comes
- **A goal for today**: when it has gone too long without a log you are woken to push it, by default only between 8 in the morning and 1 at night (the config can change this: `remindFrom`, `remindUntil` under `modules.goals`), at most 10 times a day for each goal.
- **Short-term, long-term, a dream**: past its due date, a short-term one due today, too long without progress (2 days for short-term, 4 for long-term, 10 for a dream), or blocked for more than 3 days: you are woken to look at it, at most once a day for each goal.
- The reminder brings why you want it, what counts as done and the latest progress; what to do is take a step and log it, done when it is reached, `edit --due` and log the reason to extend it, drop it if you no longer want it, block it if you are stuck.

## Common pitfalls
- "A day" changes at 4 in the morning by default (the config can change this: `dayStartsAt` under `modules.goals`): a goal for today set at 1 at night belongs to the day before and shows as "not closed yet" in the morning; close it or carry it.
- With three goals for today already active, add, resume and carry are all refused: finish, drop or swap one first.
- A parent must be at least one level higher, and a wrong level is refused; a dream has no parent.
- While a goal is handed to a helper (`goals link <id> cc:<helper's name>`) and the helper is working, you are not nudged.
