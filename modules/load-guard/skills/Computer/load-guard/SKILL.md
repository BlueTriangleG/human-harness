---
name: load-guard
description: The computer's memory load - how to pass the gate before heavy work, how to make room when there is not enough, what "tight" and "danger" mean, what the automatic shedding did. Open it when you are about to start the phone, process video or audio, start a new helper session, or are told that load was shed automatically.
---
# Machine load (load-guard)

## What it is
The memory of this computer is shared between you and others. The load guard looks at memory once a minute (the compressor, swap, how fast pages come back from disk, the system's pressure, available memory, free disk, whether the machine has frozen), writes the state down, and sheds load for you when the computer is about to freeze. It only guards against a freeze: short of the danger line the computer is yours to use.

## Three levels
- **normal**: use it as you like.
- **tight**: a notice only; nothing is stopped. Take care not to start several heavy things at once.
- **danger**: starting anything more may freeze the whole computer. Start no new heavy work now (starting the phone automatically included); finish up and close what is not in use.

## Commands
- `load`: how things stand now, in one line. It also says how much room there is before heavy work.
- `load gate <kind>`: the gate before starting. The kind is `phone` (the phone emulator), `cc` (a new helper session or another turn of one), `heavy` (video, audio, a batch); for light work that only changes code use `cc-light`. Exit code 0 lets it through, 1 does not, and says why.
- `load room <kind>`: for when you yourself want to start something. With enough room it lets you through; without, it first closes what is safe to close, and if that is still not enough it lists the processes of yours that hold memory, and you decide which to close.
- `load json`: the same as `load`, for programs to read.
- `load events`: the shedding events not yet reported (for the senses; you will hardly need it).

## Automatic shedding
- On one machine only one role's load guard sheds load; one whose config says `shed: false` only watches.
- At the line nearer to a freeze than "danger", held for several minutes (at once when the system's memory pressure is at its highest level), each patrol takes one step: first it closes the phone (which is then not started automatically again for half an hour); with the phone off it ends the biggest of your heavy processes that may be closed (video processing, scripts, a browser and the like). Services that are always on are not touched, and neither are other people's processes.
- You are woken and told what was done.
- When that line holds for several minutes and nothing on your side is left to close (the memory is held on someone else's side), it tells your owner, at most once in a few hours.

## Common pitfalls
- A gate that does not let you through does not mean stopping work: first close what you have idle, then switch to a way that takes less memory (one at a time, in pieces one after another, fewer threads); do not wait again and again for the same heavy way to be let through.
- Do not reopen at once what was closed automatically; first think which job was too heavy.
- Heavy work goes one piece at a time: do not run the phone and video processing together; run only one big audio or video job at a time, counting the helpers' with your own.
- Close only processes that are your own; for someone else's, or when unsure, tell your owner.
- Do not change thresholds or enlarge swap by hand in order to start work.
