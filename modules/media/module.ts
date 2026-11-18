// Media: the role's voice (scripts/voice.py: a voice message through Fish Audio) and its eyes on a video
// (scripts/watch.py: info, danmaku peaks, a frame sheet and the first minutes transcribed, all on this machine).
// The Fish Audio key is fishAudioKey in HH's secrets file; the voices are the role's own (config voices / defaultVoice).
import { command, defineModule, T, z } from "../../src/modules/api.ts";

export default defineModule({
  name: "media",
  summary: "Voice messages in the role's voice (Fish Audio) and watching a video locally",
  config: {
    // voices: name -> Fish Audio voice id; defaultVoice: one of those names (or an id); voiceModel: the Fish model
    // keyFile, keyField: a file of the role's own that holds the Fish Audio key, and its field (unset: HH's secrets file, fishAudioKey)
    shape: { voices: z.record(z.string(), z.string()), defaultVoice: z.string(), voiceModel: z.string(), keyFile: z.string(), keyField: z.string() },
    defaults: { voices: {}, defaultVoice: "", voiceModel: "drama-3", keyFile: "", keyField: "" },
  },
  requires: {
    bins: ["ffmpeg", "yt-dlp", "whisper"],
    setup: ["a Fish Audio key as fishAudioKey in <state dir>/secrets.json, and the role's voices in modules.media.voices"],
  },
  tools: [
    command({
      name: "voice", description: () => T.voice.description, script: "scripts/voice.py", timeoutMs: 120_000,
      shape: () => ({ text: z.string().describe(T.voice.params.text), voice: z.string().optional().describe(T.voice.params.voice) }),
      argv: (a) => ["say", String(a.text), ...(a.voice ? ["--voice", String(a.voice)] : [])],
    }),
    command({
      name: "watch_video", description: () => T.watch_video.description, script: "scripts/watch.py", timeoutMs: 20 * 60_000,
      shape: () => ({
        url: z.string().describe(T.watch_video.params.url),
        minutes: z.number().optional().describe(T.watch_video.params.minutes),
        noAudio: z.boolean().optional().describe(T.watch_video.params.noAudio),
        lang: z.string().optional().describe(T.watch_video.params.lang),
      }),
      argv: (a) => [String(a.url), ...(a.minutes ? ["--minutes", String(a.minutes)] : []), ...(a.noAudio ? ["--no-audio"] : []), ...(a.lang ? ["--lang", String(a.lang)] : [])],
    }),
  ],
});
