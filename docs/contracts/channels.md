# Contract: channels

Maintained by the framework. The code is `src/channels/`: the shapes in `types.ts`, the one entry in `send.ts`, the
first implementation in `gateway.ts`.

## What a channel is

A channel is one way a role talks with people (a chat app, a web chat). In code it is a `Channel` (`types.ts`) with four
members: `connected`, `start(onMessage)` (connect, then call `onMessage` once for each message that arrives; a throw
from `onMessage` means the message was not taken), `send(message)` and `stop()`. Three shapes go across it:
`InboundMessage` (what arrived), `OutboundMessage` (what to send) and `Delivered` (what a send answers: `ok`, the
sentence the caller shows the role as `out`, `unsure` when the channel could not tell whether the message went out, and
`resolved`, the conversation id the channel recognised for the target, when it differs from what was asked).

## The framework's two openings

- **In:** `brain.fromChannel(message)`. A message with the same channel, message id and text as one already taken is
  dropped there, so a channel may hand in twice a message that carries an id. A message without an id is always taken.
- **Out:** the `send` of `openChannels(cfg, …)` (`send.ts`). Every message HH sends goes through it: the `message` and
  `sticker` tools, the final reply of a turn, and `hh send`. hhd and `hh send` both open their channels with
  `openChannels`, so both get the same channels. Nothing else in the framework talks to a channel.

## The table in the instance config

```json
"channels": { "<channel name>": { "via": "<implementation>" } }
```

The key is the channel name the role writes in the `message` tool (and that comes back as `InboundMessage.channel`);
`via` names the implementation that carries it. The framework's default is an empty table: a new role is connected to
nothing (and `tools.sendDryRun` is on); `docs/new-role.md` step 4 gives a role a bridged channel. An unknown `via` stops the boot with `channels.<name>.via: unknown "<via>"`.
This table is not `senses.sources`, which sorts the sources of sense events (`senses.md`).

## What `send` answers, in this order

1. `tools.sendDryRun` is on: the simulated-sending sentence, and nothing is asked.
2. The channel is not in the table: the "not connected to this channel" sentence (`T.deliver.noChannel`), which names
   the channels that are — a mistyped channel name is corrected in one step. Nothing is asked of any channel.
3. The hook, if one is installed (below).
4. The channel's own `send`.

## The hook: `BeforeSend`

One hook is called in step 3 above for every message that would go out. The framework's hook is installed **inside**
`openChannels`, from the config — not handed in by a caller — so that hhd, `hh send` (which the deploy watchdog also
uses) and anything else that opens channels cannot differ. It is the outbound filter (`src/gate/outbound.ts`, instance
config `outbound`): off in the framework's default, so a new role's messages go as they are.
The `beforeSend` option of `openChannels` exists for tests. A hook answers one of three things: nothing (send as is), `{ text }` (send this text instead), or `{ refuse }` (do not send;
the caller gets `{ ok: false, out: <the reason> }` and goes down the same path as a send the channel refused). The
`message` tool's own check before sending (`ToolContext.beforeSend`: the word list, the notes check) is a different,
earlier thing that only the tool has.

## Adding an implementation

One file in `src/channels/` that returns a `Channel`, and one `case` line in `openChannels` that builds it for its
`via`. An instance moves a channel to it by changing that channel's `via`; nothing else in the framework changes.

What hhd does with it, which an implementation has to live with: `start` is awaited during boot, and a throw there
stops hhd (launchd starts it again) — throw only for a mistake that must stop the boot, and restore a dropped
connection yourself. `stop` is called at shutdown after the brain has stopped, so that last replies still go out; it
must not throw. Not settled yet, and to be settled with the first channel that takes messages in directly: how such
a channel stops handing messages in before the brain stops.

## The bridge implementation (`via: "bridge"`)

`src/channels/bridge.ts`. The chat app's connection lives in a process of its own, the bridge, and HH reaches it over
the unix socket `<stateDir>/channels/<name>.sock` (`bridgeSocket`). The app's code and dependencies stay out of hhd;
hhd and `hh send` share the bridge's one connection (an app such as WhatsApp drops the older of two); and what arrives
while hhd is down waits in the bridge's inbox, `<stateDir>/channels/<name>.inbox/`, one file per message.

- `send` is one connection per message: no bridge listening = not sent; asked and no answer within a minute (two and a
  half with media), or the connection dropped after asking = `unsure`, not to be resent.
- `start` connects as the listener and returns at once; it reconnects every two seconds while the bridge is away. The
  bridge hands over its inbox oldest first, then each new message. A message `onMessage` throws on stays in the inbox
  and is handed over again at the next connect, so the "stops before the brain stops" question above is answered
  for this implementation: a message the stopping brain does not take is not lost. A message handed over twice (an
  answer lost on the way) is dropped by `fromChannel` by its id.
- `stop` closes the listener.

Two more things a bridge does for whoever watches the role's channels (the `watchdog` module, `hh channels`):

- `{"op":"status"}` on the socket is answered with `{ connected, down?, since, inbox, direct, waiting, ownerIn, lastOut }`
  (the last three are times only — for how many seconds the oldest message in the inbox has waited to be taken, when the
  owner's last private messages came in, when a send last went through — by which a watchdog tells that the role does not
  take its messages or does not answer its owner, without seeing who wrote or what): the channel's own
  `connected`; `down`, the reason it will not come back by itself (the app signed this device out — a restart does not
  help); since when the bridge serves; how many messages wait. No answer within five seconds means the bridge is not
  running or is stuck.
- The owner's command never reaches the inbox. A private message that opens with `/cc` (or `／cc`) from one of the
  owner's sender ids goes to `<stateDir>/channels/<name>.direct/` instead, in the inbox's file format, and no listener
  is given it: it is the owner's way round the role and must work when hhd is down. Who the owner is comes from the
  machine's side (`docs/contracts/machine.md`, the owner's sender ids), compared with the sender exactly as the channel
  reports it; a group message is never one. That directory is in the role's own state directory, so it keeps other
  people out, not the role itself.
- A bridge may keep what a later reply can quote in `<stateDir>/channels/<name>.quotes.json` (`bridgeQuotes`, 0600:
  it holds message text), so that a quote of something heard before a restart still reads. The QQ bridge does.
- A bridge whose app refuses its credentials stays up and answers status with `down`; it does not end and get started
  again for ever. The WhatsApp bridge says `logged out`, the QQ bridge `bad credentials`.

The bridge's side is `serveBridge(channel)`, which puts any `Channel` behind the socket, and `runBridge`, a bridge
process's whole start. A bridge for one app is a directory under `bridge/` with its own `package.json` and lockfile
(versions pinned, installed with `npm ci --ignore-scripts --omit=dev`; `node_modules` stays out of git) and a `main.ts`
that builds that app's `Channel` and hands it to `runBridge`. It is started on its own (launchd), not by hhd:
`HH_CONFIG=<the role's config> node bridge/<app>/main.ts [channel name]`. `runBridge` reads the role's config as hhd
does and speaks the role's language; the bridge's own file, `<stateDir>/channels/<name>.json`, holds only what the
bridge alone needs (the app's login, allow lists, a media directory). Once serving it records its pid in
`<stateDir>/repair/bridge-<name>.json`; a deploy (with the console, when hhd restarts for it) and a rollback stop it by
that record, and launchd starts it again on the code then live. From then on an error a library leaves uncaught does not
end it: it logs the error's kind and code, never its words, and goes on (`keepRunning`). `bridge/whatsapp/` (baileys)
and `bridge/qq/` (Tencent's QQ bot SDK) are the first two.

What each bridge's own file holds, and what it does that the other does not:

| | `bridge/whatsapp/` | `bridge/qq/` |
|---|---|---|
| Own file | `auth` (a baileys login directory), `allowFrom`, `groupAllowFrom`, `media?` | `appId`, `appSecret`, `allowFrom`, `groupAllowFrom`, `markdownSupport?` (default on), `media?` |
| Who a sender is | the phone number, `+` and digits | the user's openid |
| Targets | a phone number, or a WhatsApp id (`…@g.us` for a group) | `qqbot:c2c:<openid>`, `qqbot:group:<openid>` |
| Voice in | the audio file's path | the platform's transcript as the text |
| `down` | `logged out` | `bad credentials` |
| Its own rule | one process per login directory | a private message may be answered free of charge for `QQ_REPLY_WINDOW_MS` (`src/channels/qq.ts`), a group message for five minutes, four times each; later sends are rationed by the platform |

Each bridge has a module (`whatsapp`, `qq`) that only declares it: the bridge as a service (`docs/contracts/modules.md`)
under the label `<the role's prefix>.bridge.<channel>`, installed once the bridge's own file exists, and a self-check
for `hh modules doctor` — the file and its mode, `via`, whether the bridge answers and is connected, and whether the
owner has a sender id on this channel in the people list and on the machine's side. The modules bring no tools, manuals
or senses. `hh channels add <whatsapp|qq> …` writes the bridge's file, the two config keys and the owner's id in the
people list (`src/channels/setup.ts`). `hh channels link whatsapp --phone <number>` links the role as a new device of a
WhatsApp account by pairing code and writes the login directory (`bridge/whatsapp/link.ts`); the WhatsApp bridge's job
is installed only once that login exists. `hh channels remove <name>` unloads the job, takes the channel out of the
config and moves its files to `<stateDir>/channels/removed-<time>/`.

Who watches the bridges: the `watchdog` module asks each one its status once a minute, restarts one that does not answer
or stays disconnected, and tells the owner when `down` is set (`modules/watchdog/guide.md`).

## The gateway implementation (`via: "gateway"`)

Today's path through the OpenClaw gateway: `send` is the gateway request `send` HH has always made, with its retry and
re-ask rules. `start` and `stop` do nothing: its incoming side is the relay plugin, which hands messages to hhd's
control socket (the `relay` command in `src/control.ts`), and the gateway client belongs to whoever created it (hhd, or
`hh send`). It goes away, with `src/gateway/`, `relay/` and `src/relaySpool.ts`, when the direct channels are in and the
`computer` tool no longer needs the gateway.
