---
name: helpers
description: Helpers - handing work that takes time to a Claude Code session in the background: how to send it, how to cut in, how to see what it did, how to stop it and let something through, the load gate, the common pitfalls. Open it when you want to hand work over, a helper's answer woke you, you are about to accept what it handed back, or it is stuck.
---
# Helpers (helpers)

## What it is
A helper is a Claude Code session running in the background, with a name and a working directory of its own. You hand it work and it does it by itself; when it has finished a turn (it has answered), has stopped on an error, is out of quota, or has been quiet for a long time, the senses wake you, with its last words to you attached to the wake-up. A session remembers its context: the next send carries on from there.

## Commands
- `helper send <name> "words" [--dir directory] [--add-dir directory]… [--model sonnet|haiku|opus|default] [--light]`
  - No session of that name: a new one is started, working in `<name>` under the tasks directory by default; `--dir` names another.
  - It is idle: it carries on.
  - It is working: your words cut in, and it sees them when its next step is done.
  - `--model`: the model for every later turn; the turn that changes the model rewrites the whole cache, so for a lasting change a new session is better.
  - `--light`: light work that only changes code and runs small tests: no audio or video processing, no installs, no browser.
- `helper show <name> [turns|all] [--process|--steps|--full]`: by default only its last message to you; `--process` shows what every step did, `--steps` adds the result of every step, `--full` cuts nothing short.
- `helper ls`: every helper: working or idle, its directory, its last line.
- `helper stop <name>`: stops it (like pressing Esc); send again to go on.
- `helper allow <name> "rule"`: lets through one kind of thing it was stopped on, for instance `"Bash(npm install:*)"`; then send to have it go on.
- `dispatch <directory> <one line saying what> -- <command…>`: for running one long command without a helper; it wakes you when the command is done.

## The rules of handing work over
- A new session passes the load gate first: when the computer is in danger or there is not enough room it is not started this turn; make room or wait a while. Cutting in on a session that is already working is not stopped.
- The pages of your notes that bear on the work are attached by themselves when you hand it over; which pages is written in the command's output.
- One matter, one session, with a name that shows what the matter is.
- Say clearly what it is to hand in and what counts as done; have a big piece of work handed in step by step.

## Accepting
- That it says it is done does not mean it did it right: look at the result, run it, compare with the bar you set.
- `helper show <name> --process` shows how it did it and whether it skipped or fudged anything.
- Tell those who need to know only when it passes; when it does not, send again and say exactly what is wrong.

## Common pitfalls
- Several memory-hungry helpers at once (video, rendering) push the computer into danger, and helpers get closed by the automatic shedding. Heavy work goes one piece at a time.
- What you cut in with is seen only when its next step is done; when it is urgent, stop first and then send.
- When a permission prompt stops it, it just waits there: let it through with `helper allow`; do not have it work around the prompt.
- Changing the model rewrites the cache; do not switch back and forth.
