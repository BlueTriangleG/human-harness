---
name: media
description: Sending a voice message (in your own voice) and watching a video (Bilibili, YouTube) - how to use them, how slow they are, where the results go, the common pitfalls. Open it when you want to send someone a voice message, want to know what a video says, or the voice or the video tool reports an error.
---
# Voice messages and watching videos (media)

## Sending a voice message: voice
- The `voice` tool: `text` is what to say, `voice` is the voice (a name given in the config, or a Fish voice id; left out, the default one is used). It returns the path of an ogg file.
- Sending it: `message` with this path as `media` and `asVoice=true` makes a voice bubble. A role without a channel has no `message`: the voice message can be made but not sent, so just tell your owner the file's path.
- How to write it: one sentence a line; a space inside a line counts as a comma, a full stop is added at the end of a sentence and a pause between lines; for no automatic pauses use the command line, `voice say "…" --raw`.
- The default model (drama-3) knows paired tone tags: `[emphasis]…[/emphasis]`, `[laugh]…[/laugh]`, `[whisper]…[/whisper]`, `[sigh]…[/sigh]`. Use few tags and light directions; many sound affected. With another model, a one-word tag that is not in the official table gets read out as "um, er", and the script warns you.
- It is charged by the character: `voice usage` on the command line shows how many characters were spoken this month. Do not read a long text out whole as a voice message.
- The error `fish error 401/402` means the key is wrong or the balance is too low: tell your owner; "unknown voice": use a name that is in the config.

## Watching a video: watch_video
- `watch_video` (on the command line `watch-video <link>`), with a Bilibili or YouTube link as `url`. By default it listens to the first 3 minutes (make `minutes` longer; the longer, the slower); `noAudio=true` only looks at the information, the bullet comments and the frames, which is fastest; `lang` is the language of the transcription (zh by default; en, ja or auto also work).
- It returns: the video's information, the stretches where the bullet comments are densest (with their time and what people are posting), the path of an image with a 3×3 grid of frames, and a transcript of the first minutes. The image counts as seen only once you open that file.
- It all runs on this machine and costs nothing, but it is slow: transcribing a video of a few minutes takes a minute or two or more. The results are also kept in the workspace under `memory/videos/<video id>/` (info.txt, the frame image, transcript.txt); for the same video again, look there first.
- Whichever step fails (information, bullet comments, frames, transcript) writes one line saying why, and the rest goes on; do not treat a step you saw fail as having a result.
- The transcript is machine-made and often gets names and in-jokes wrong; compare with the subtitles, the bullet comments and the frames before concluding.
