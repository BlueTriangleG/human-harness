# Questions

`<id>` is your role's id (`./setup` says it, and it is the folder name under `~/HH/`); `<name>` is its name. Commands that
start with `bin/hh` are run in the folder you cloned HH into. 中文：[faq.zh.md](faq.zh.md).

## Which Claude account do I need, and who pays?

HH drives the official, unmodified Claude Code through Anthropic's Agent SDK. It has no login of its own and never reads,
keeps or passes on your Claude credentials, and every part of the role uses Claude Code's login. When Claude Code is
not logged in, `./setup` and the wizard start Claude Code's own sign-in for you (`claude auth login`, in your browser);
otherwise they only ask which kind of login it has (`claude auth status`) and tell you. Changing it later is Claude
Code's own `/login`.

You choose, and the role's use is billed the way that login is:

- **Your Claude subscription** (Pro, Max, Team, …), **the default**: run `claude`, type `/login` and pick your Claude
  account. The role's use counts against your plan's usage limits, like your own use of Claude Code. HH is run on this
  every day. How much: our longest-running agent, working through the day, uses roughly 5 to 10 % of a Max 20x plan's
  weekly allowance a day, before helper sessions, which can add as much again. A full week of work takes about half of a
  Max 20x week; on Max 5x, a quarter the size, it would run out in a few days. These are estimates from our own use.
- **An Anthropic Console account** (an API key): run `claude`, type `/login` and pick the Anthropic Console account. The
  role's use is billed per token, at API prices. Not fully tried yet: HH takes this login, but its usage guard is built
  for subscriptions, so on this login it shows no usage and caps nothing; set a spend limit in the Console if you want
  one. How much: at API prices, roughly $10 to $100 a day on Sonnet and about twice that on Opus. That is an estimate
  from our longest-running agent's use (two chat channels, weeks of memory); a new role starts lower, and helper
  sessions are not included, so real costs run higher.
- **Another provider's Anthropic-format endpoint** (advanced, experimental): not a login but a setting of the role,
  `models.providers` (see [Using another model](#using-another-model)). It has not been fully tried, and not on every
  model.

A key or token set only in your terminal (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) does not reach the role: its
jobs run in the background without it. Amazon Bedrock and Google Vertex AI are not on the list: Claude Code reports
them as logged in as soon as their switch is set, without checking anything, and HH has not been tried on them.

Anthropic's rules on subscriptions, the Agent SDK and tools built on them have changed more than once. Its guidance for
products built on the Agent SDK is to use API key authentication. Read the official pages before you choose; what they
say is what counts:

- [Claude Code: legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540)

HH reads how much of the quota is used only from what Claude Code itself reports (the rate-limit reading of each turn,
and the SDK's usage call). Above 90% of the week it wakes itself less often in its focus periods, and above 97% it is
reminded to stop handing work to parallel sessions (`schedule.focusQuotaWeekMax`, `parallel.quotaWeekMax`). An OpenAI
key is optional and separate: setup and the wizard ask for it after the Claude login, and `hh openai set` or the app's
settings add, change or remove it later (kept in the role's `state/secrets.json`, mode 0600; hhd takes a change up by
itself, restarting once the role is calm). With it memory and the notebook are searched by meaning, billed by OpenAI;
without it, by words.

## The permission page: what is it, and can I skip it?

Once `./setup` has built the role's app, it opens the app's permission page, "Permissions for `<name>`", with three
rows:

| Permission | What the role uses it for |
|---|---|
| Full Disk Access | reading protected files, such as Mail and Photos |
| Screen & System Audio Recording | taking screenshots, seeing what is on the screen |
| Accessibility | clicking and typing for you |

Each row has a button and shows a ✓ once the permission is on. Full Disk Access is the one macOS will not ask about for
a program: press "Open Settings", then drag the app's icon from the page into the list.

"Not now" is fine. The role runs without them; only what needs a permission (a screenshot, reading a protected file,
using the mouse) fails until it is on. To come back to the page, open the role's app
(`~/Applications/HH/<id>/<name>.app`): while one of the three is off it shows the page first, and with all three on it
opens the role's window.

Why an app: macOS gives a permission to the program that asks for it, and everything the role runs is started by its own
app, so the permissions are the app's. They are given once, and an update, a rebuild of the app or a new name keeps
them.

Without the Xcode Command Line Tools there is no app (nothing to build it with). `./setup` (and `npx human-harness`)
first asks whether to install them: yes opens Apple's own installer (`xcode-select --install`), and setup waits for it and
goes on, with the app. Said no to, it goes on without the app when git and Python are there some other way, and opens the
role's console in the browser instead. To get the app later: `xcode-select --install`, then
`HH_CONFIG=~/HH/<id>/instance.json bin/hh modules install`.

## Pairing: why does the console know it is me?

The console (the role's window, or its page in a browser) answers only a client paired with it. The first time it is
opened, which `./setup` does for you, it pairs that client by itself: there is nothing to type. Up to eight clients stay
paired at once (a browser or two, the app); when one more comes, the oldest goes.

How it pairs: `<id> console` makes a new token and opens an address with a one-time code after the `#`, never the
token itself. The page trades the code for the token once, within 60 seconds, keeps the token in this browser's storage
for the page, and takes the code out of the address. A code already used, or older than a minute, pairs nothing: the
page then says the browser is not paired yet and shows the command to type. Run `<id> console --pair` and let the new
address open within the minute. Clearing the browser's data for the page unpairs that browser; pair it again the same
way.

## Using another browser

`<id> console` opens the role's page in your default browser. To move to another browser, make it the default browser
(System Settings → Desktop & Dock → Default web browser), then run `<id> console --pair`. That pairs the new browser and
unpairs every client paired before; the role's app pairs itself again the next time you open it. The address it opens
works once, within a minute: if it opened in the wrong browser, switch the default and run it again.

If the `<id>` command is not found, `./setup` put it in `~/.local/bin`, which is not on your PATH: use
`HH_CONFIG=~/HH/<id>/instance.json bin/hh console --pair`.

## The PATH line setup adds

When `~/.local/bin` is not on your PATH, setup asks whether to add it. Yes puts one line at the end of `~/.zshrc` (zsh,
the Mac's default shell; for bash, `~/.bash_profile`, or `~/.profile` when only that one is there):

```sh
export PATH="$HOME/.local/bin:$PATH"  # added by HH setup (Human Harness): the folder of its short commands; delete this line to undo
```

It is added once: a file that has it, or already puts `~/.local/bin` on PATH, is left as it is. New terminal windows have
it. To take it out, delete that line (for example open `~/.zshrc` in a text editor, or
`sed -i '' '/# added by HH setup/d' ~/.zshrc`) and open a new terminal window. `hh remove` does not touch it, because
Claude Code's installer puts `claude` in the same folder; removing the last role says the line is still there.

## Removing a role

```sh
bin/hh remove <id>
```

It lists what it will remove and asks you to type the id again (`--yes` skips the question). Then it stops the role's
jobs, closes its app's windows, and deletes:

- its app and the app's folder (`~/Applications/HH/<id>`);
- its directory (`~/HH/<id>`): its config, its workspace and its state, **its memory included**: copy the folder first if
  you want to keep it;
- its short command, its console token, and the records of the Claude Code sessions it ran;
- the folders `./setup` made for it (`~/HH`, `~/Applications/HH`), when nothing else is in them.

It resets the app's privacy permissions. Some of them need an administrator: when it cannot reset those it says so;
remove the role's rows in System Settings → Privacy & Security yourself. A workspace or state folder that the role's
config put outside its directory is left where it is, and named. `~/Applications/Human.app` (the list of this
computer's roles) stays; move it to the Trash once no role is left.

## Using another model

The role thinks with Claude Code, on the Claude account logged in on this computer.

- When you make it: `./setup --model sonnet` (or `haiku`) puts the main region on that model instead of the default
  (`config/default.json` → `models`).
- Later: edit `models` in `~/HH/<id>/instance.json`. `models.opus`, `models.sonnet` and `models.haiku` name the model of
  each tier; `models.byRole` picks one model for a single brain region (`main`, `side`, `deep`, `hippocampus`,
  `speech`, `perception`). Then restart the role: `launchctl kickstart -k gui/$(id -u)/ai.hh.<id>.hhd`.
- Another provider with an Anthropic-format endpoint: `models.providers` and `models.providerByRole`. Experimental:
  not fully tried yet, and not on every model; each provider names the Claude Code version it was tried on, and
  Anthropic does not support other vendors' models behind Claude Code.

Every key is in [contracts/instance-config.md](contracts/instance-config.md) ("Choose models and the daily rhythm").

## Linux and Windows

HH runs on macOS 14 or newer today. The layer that runs the role's jobs has a Linux side (systemd user units where macOS
has launchd), and `./setup` goes on without the app there (the console opens in the browser). A clean Ubuntu 24.04 has
been taken from `git clone` through `./setup` to `hh remove` in a container, but with Claude Code's login stood in for
(no account could be logged in there): a real role has not run on Linux end to end yet, and some modules use macOS
tools (`computer`, `phone`, `media`). WSL2 and Windows are not supported yet. The README's "Status" says where this
stands.

What is different on Linux:

- systemd starts hhd or the console again 30 seconds after it stops (launchd does at once): after a crash or a restart
  the role is back about half a minute later.
- `hh console --as <user>` (a role under an account of its own) restarts that role's console and waits up to a minute
  for it to come back.
- The role runs while you are logged in. To keep it running after you log out, and start it when the computer boots:
  `sudo loginctl enable-linger $(id -un)` (`./setup` says so too).
- With no desktop to open a browser in, `<id> console` prints the pairing address instead: open it yourself, from
  another computer after `ssh -L <port>:127.0.0.1:<port>` to this one. It pairs once, within a minute.
