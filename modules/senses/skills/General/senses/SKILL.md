---
name: senses
description: The senses (what HH notices from outside) - which sources there are, how events reach you, where a source is defined, how to add one of your own, the common pitfalls. Open it when you want to know why some kind of message did not wake you, want to add a new source, or the senses report an error.
---
# The senses (senses)

## What it is
The senses are part of HH's kernel and cannot be turned off. They run a round every 20 seconds: every source that a turned-on module defines is looked at, what is new is written as an event and handed to the gate, and the gate decides by its rules whether to wake you at once, to hold it, or only to note it. A watcher that is always running also has the matching source run a round at once when it sees something (a notification on the phone, say), without waiting the 20 seconds.

## How events reach you
- Each thing a source reports is an event: one line of summary, sometimes with a body (a helper's last words to you, for instance).
- What comes in a row from one source is held a short while and handed over together (15 seconds by default, a minute at most).
- Handed to HH, it counts as received. What could not be handed over (HH was not there) is handed again after 3, 10 and 30 minutes, three times at most.
- Items already seen are remembered, and the same one is not reported twice.

## Where a source is defined
Every source belongs to a module: the module names the sources it owns in its declaration, and says in `senses` of its config how each is looked at. With the module off, its sources do not run.

The fields of a source:
- `type`: `command` (runs a command, one item per line of output; a line of JSON `{"text", "body"?, "id"?}` may carry a body), `web` (fetches a page and finds new items with `pattern`), `xhs_notify` / `wx_notify` / `phone_net` (notifications and loss of network on the phone; they need a phone), `mac_badge` (the unread count of a Mac app).
- `cmd` / `url`+`pattern`: what to look at.
- `every_sec`: how often to look (left out: every round).
- `fire_on_first`: whether what is seen the first time is reported (by default not: it is only noted).
- `note`: a line of explanation (shown by `senses --list`).
- `do`: a hint given to you when you are woken.
- `enabled`: `false` keeps it stopped for now.

## How to add a source of your own
Write a module of your own (`modules/<name>/module.json` in the workspace): name the source in `senses`, and define it in `config.defaults.senses`, for instance a command that runs every 10 minutes and prints one event a line. Turn the module on and the next round starts looking. The command must finish within a minute; a line printed once is not reported again, so it does no harm if the command prints everything there is each time.

## Commands
- `senses --list`: which sources there are now, and whether they are on.
- `senses --dry`: what this round would report, without handing over or noting.
- `senses`: runs a round by hand.
- `senses --ack <id…>`: acknowledges by hand (hardly needed: handing to HH counts as acknowledged).

## Common pitfalls
- A source that fails does not stop the others, but it was not looked at this round: its command must be able to finish within a minute.
- Every line of a command counts as one item; printing debug output makes a heap of events.
- When some kind of message did not wake you, first see with `senses --list` whether its source is on, then think whether the gate's rules only noted it.
