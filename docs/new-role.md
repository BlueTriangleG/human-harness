# Making a new role

A role is one directory: its instance config, its workspace (persona files, memory) and its state. Several roles can
live under one OS user; each has its own labels, ports and state. Run these from the framework's checkout. 中文：
[new-role.zh.md](new-role.zh.md).

`./setup` does steps 1 to 3 for you: it asks the role's language, its name and what it calls you, makes the role in
`~/HH/<id>` with only the modules that need nothing more set up, installs it and opens its window. Its flags:
`./setup [--lang zh|en] [--name <name>] [--owner <what it calls you>] [--id <id>] [--model opus|sonnet|haiku]
[--dir <path>] [--no-app] [--yes]` (`--yes` takes the defaults for whatever was not given). This page is what it does,
step by step, and how to do the same by hand.

## 1. Lay it out

```sh
node src/cli.ts new <id> --owner <what it calls its owner> [--dir <path>] [--me <its name>] [--lang zh] [--persona <name>]
```

This writes `<dir>/instance.json`, five persona files and the gate's first rules (`gate.json`) in `<dir>/workspace/`,
and the hhd and console launchd files in `<dir>/launchd/` (for a look; step 2 installs them). The workspace is a git
repository from the first day, with one commit: the night's persona snapshot reads its HEAD.

The role speaks English unless `--lang` names another pack (`zh` is the other one): its prompts, tools, manuals and
starter persona files are in that language, and the config says `lang` either way. What an English role still meets in
Chinese is listed in the README's "Status". The config:

- turns on every built-in module (the kernel's own are on anyway); `./setup` then turns off the ones that need a login or
  another program first (on a fresh Mac `backup`, `bilibili`, `media`, `phone`, `qq` and `whatsapp`), and
  `hh modules doctor` says how to turn each on;
- starts from `config/new-role.json` over the framework's defaults: no focus slots and no idle wandering (set
  `schedule.focusSlots` and `schedule.wanderEveryMinutes` to turn them on), the notebook on, the gate's daily digest on,
  and what the role's language needs;
- points `tools.python` at the role's own Python environment, `<dir>/state/venv` (step 2 makes it);
- keeps `tools.sendDryRun: true`: nothing is sent anywhere until the role has a channel;
- picks free ports for its browser and console, and labels `ai.hh.<id>.hhd` / `ai.hh.<id>.console`;
- on macOS, names the role's own app, `launchd.app` (`~/Applications/HH/<id>/<name>.app`): step 2 builds it, and the
  role's jobs start through it, so the privacy permissions the owner gives are the app's;
- sets `modules.load-guard.shed: false` when this OS user already runs another role's load guard: one role per machine
  sheds load and tells its owner, the others only watch.

Write who the role is into `IDENTITY.md`, `SOUL.md` and `USER.md` before it starts. `AGENTS.md` starts with a few
working rules that name the owner; change them as you like.

With `--persona <name>` the role starts from a ready-made persona instead (`personas/README.md` lists them): its files
replace the starter ones, with the role's name and its owner filled in, and the role goes by the persona's name unless
`--me` gives another. What the persona does not bring stays the starter.

## 2. Install it

```sh
HH_CONFIG=<dir>/instance.json node src/cli.ts modules install
```

- makes the Python environment and installs each on module's `requirements.txt` into it, and its packages into a module
  that has them;
- links each on module's manuals onto the role's shelf (a page already there is left alone and reported);
- on macOS, builds the role's app (`launchd.app`) with the Xcode Command Line Tools and signs it with an identity of the
  role's own, then opens its permission page (Full Disk Access, Screen & System Audio Recording, Accessibility; "Not
  now" is fine, and opening the app later shows the page again while one is off). If the app cannot be made, no job is
  installed and the line says why. Without the tools, `./setup` passes `--no-app` (`hh new` without an app: delete
  `launchd.app` from the config) and the jobs start without one;
- installs launchd jobs into `~/Library/LaunchAgents` and loads them: hhd, the console, and one per standalone module
  timer (`<label prefix>.<module>.<timer>`, running `hh modules timer <module> <timer>`). A job file already there with
  other content is left alone and reported. hhd starts as soon as its job is loaded;
- puts the role's short command, `<id>`, in the first folder on your PATH inside your home that you can write to
  (`~/.local/bin` when there is none): `<id> "…"` talks to the role, `<id> console` opens its console.

`./setup` then opens the role's window (its app, paired with you), or its console in your browser when there is no app;
`<id> console` does the same later, and the first time it pairs the browser by itself.

Every step is reported, and a step that fails does not stop the others; the exit code is 1 when one failed. With
`--no-start` the job files are written and not loaded (the line says how to load each).

Run it again after turning a module on or off; what is already in place stays.

Keep the HH code on the system disk. On macOS a job launchd starts may not read an external disk: with the code under
`/Volumes/…` hhd, the console and the module timers end at once with "operation not permitted" on `package.json`,
while the same command typed in a terminal works. The role's own directory may be anywhere launchd can read.

Without an app, keep node at a fixed path too, and overwrite it in place when you upgrade. macOS then grants a system
permission (screen recording, full disk access, …) to the very file that runs, and the launchd jobs run `tools.node`
(`hh new` writes the node it ran with): if that path holds a version number (`…/Cellar/node/24.1.0/bin/node`), the next
upgrade is a different file and every permission is asked for again. With the app, the permissions are the app's, and
a new node keeps them.

## 3. Check it

```sh
HH_CONFIG=<dir>/instance.json node src/cli.ts modules doctor
```

Every module should be "ok" or "needs setup". "Needs setup" says what a person has to do once (a program to install,
a login, another module to turn on). "Broken" means the declaration or the config is wrong; the line says why.

## 4. Give it a channel

Until then it only talks through `hh tell`:

```sh
HH_CONFIG=<dir>/instance.json node src/cli.ts tell --from <owner> "…"
```

A role with no channel has no `message` tool, so `hh tell` waits for the turn and prints what the role said (up to ten
minutes). What the role wants its owner to know between two of the owner's messages it jots down and says first when
the owner next speaks.

A channel is carried by a bridge: one small process per chat app that holds the app's connection and hands messages to
hhd over a socket in the role's state directory (`docs/contracts/channels.md`). Two bridges exist, WhatsApp and QQ, each
with a module (`whatsapp`, `qq`) that keeps it running and checks it.

```sh
export HH_CONFIG=<dir>/instance.json
# QQ: the bot's app id; its secret is read from standard input, never from the command line
node src/cli.ts channels add qq --app-id <id> --allow <the owner's openid> --owner-id <the owner's openid> < secret.txt
# WhatsApp: who may write, then link the role as a new device of the account (a pairing code to type on the phone)
node src/cli.ts channels add whatsapp --allow +<the owner's number> --owner-id +<the owner's number>
node src/cli.ts channels link whatsapp --phone +<the role's account number>

node src/cli.ts modules install      # the bridge's packages and its launchd job; the bridge starts
# restart hhd (launchctl kickstart -k gui/$(id -u)/ai.hh.<id>.hhd), then
node src/cli.ts channels             # the channel, how it is carried, whether it is connected
node src/cli.ts modules doctor       # the whatsapp / qq line says what is still missing
```

`channels add` writes the bridge's own file `<state>/channels/<name>.json` (0600: it holds the login), sets
`channels.<name>.via` to `bridge` and turns the app's module on in the config (a backup is kept), and puts the owner's
sender id into the owner's entry of the people list. `--allow` is who may write to the role in private, `--group-allow`
whose messages in a group are taken (`*` is everybody); anyone else is dropped and counted. `--name` gives the channel
another name than `whatsapp` / `qqbot`. It tells you what is left for a person:

- `tools.sendDryRun` stays as it is; turn it off when the role may really send.
- For the owner's `/cc`, the machine's account adds this channel to the role's owner-senders file
  (`docs/contracts/machine.md`). The role's own account cannot, by design.

The bridge is a launchd job of its own (`<the role's label prefix>.bridge.<name>`): it keeps running when hhd restarts,
and a deploy restarts it on the new code. `hh channels restart <name>` restarts it by hand. With the `watchdog` module on
(it is, for a new role) a bridge that stops answering is restarted and the owner is told.

Only one process may hold one app login: before a role's channel moves from another program to a bridge, stop that
program's connection first.

**Linking WhatsApp.** `channels link whatsapp --phone <the account's number, with country code>` prints an 8-character
pairing code. On the phone that has the account: WhatsApp > Settings > Linked devices > Link a device > "Link with phone
number instead", and type the code. The command waits until the phone accepts, writes the login to
`<state>/channels/whatsapp.auth` (0700) and says what is next. If the code is not typed in time it ends and leaves
nothing; run it again for a new code. It refuses while the bridge is running (one login, one process) and when a login
is there already. There is no QR code. An existing login directory put at that path works as well, without linking.

`hh setup`, `hh new`, `hh remove`, `hh modules install` and `hh channels add | link | remove` are the operator's
commands. Run from the role's own session (its shells carry `CLAUDECODE=1`) they are refused with one line asking for
the owner; a person working as the operator from a Claude Code session sets `HH_OPERATOR=1`. It stops a well-meant
mistake, nothing more.

`channels remove <name>` takes a channel away again: the bridge's job is stopped and unloaded, `channels.<name>` and the
module's entry leave the config (a backup is kept), and the bridge's file, the login and the inbox move to
`<state>/channels/removed-<time>/`. Nothing is deleted. Restart hhd afterwards.

## 5. Remove it

```sh
bin/hh remove <id>
```

It lists what it will remove and asks for the id once more (`--yes` does not ask): the role's launchd jobs, its app and
the app's folder, its directory when `hh new` made it (config, workspace and state: its memory goes with it), its short
command, its console token and its Claude Code session records; then it resets the app's privacy permissions. A
workspace or state its config puts outside its directory is left, and named. More in [faq.md](faq.md#removing-a-role).

## What works without extra setup, and what does not

- Without an OpenAI key in `<dir>/state/secrets.json`, the notebook finds pages by their words only, and
  `hh modules doctor` says so. With a key it finds them by meaning: `hh openai set` adds one (or the app's settings).
- Helper sessions run on whatever model the one who sends them picks; `modules.helpers.model` fixes one for all of them.
- A module that needs a login or a program a person must install shows as "needs setup" in `hh modules doctor`, with
  what to do.

The config's keys are in `docs/contracts/instance-config.md`; modules and their config in `docs/contracts/modules.md`.
