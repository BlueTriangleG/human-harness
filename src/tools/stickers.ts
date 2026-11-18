// 表情包：按情绪从她自己的表情库里挑一张，经 ctx.send（src/channels/）发出去。
// 以前她跑 sticker.py react，脚本里起两次 openclaw 命令行（查会话 + 发图），一张图要等 30 多秒，回复也跟着等。
// 挑图、GIF 转 MP4、记使用次数是表情包模块的 sticker.py（prepare / used，0.1 秒）；这里只管发给谁、怎么发。
import { z } from "zod";
import { QQ_REPLY_WINDOW_MS } from "../channels/qq.ts";
import type { ToolDef } from "../kernel/types.ts";
import { moduleScript, type ToolContext } from "./hhtools.ts";
import { summarize, type RunResult } from "../util/run.ts";
import { targetKey } from "../persona/people.ts";
import { T } from "../lang/index.ts";

type Channel = "qqbot" | "whatsapp";
const LABEL: Record<Channel, string> = { qqbot: "QQ", whatsapp: "WhatsApp" };
const QQ_WINDOW_MS = QQ_REPLY_WINDOW_MS;

interface Prepared {
  ok?: boolean;
  items?: Array<{ id: string | null; name: string; path: string; gifPlayback: boolean }>;
  errors?: string[];
  nearest_moods?: string[];
}

interface Dest { channel: Channel; target: string; name: string | null; rerouted: boolean }

const isChannel = (c: string | undefined): c is Channel => c === "qqbot" || c === "whatsapp";

/** The role's channels a sticker can go out on (sticker.py sends on QQ and WhatsApp), in name order; none: no sticker tool */
export function stickerChannels(ctx: ToolContext): Channel[] {
  return [...(ctx.channels ?? ["qqbot", "whatsapp"])].filter(isChannel).sort();
}

/** 号码本身看得出渠道：+61… 是 WhatsApp，qqbot:… 是 QQ */
function channelOf(target: string): Channel | null {
  if (target.startsWith("+")) return "whatsapp";
  if (target.startsWith("qqbot:")) return "qqbot";
  return null;
}

/** 人名 → 这个渠道上的号；认不出返回空字符串 */
function resolveName(ctx: ToolContext, ch: Channel, name: string | undefined): string {
  if (!name) return "";
  const t = ctx.resolveTarget ? ctx.resolveTarget(ch, name) : name;
  return t !== name || channelOf(t) === ch ? t : "";
}

/** 发给谁、走哪个渠道。默认是正在跟她聊的人；QQ 回复窗口过了、对方有 WhatsApp 就改发 WhatsApp */
export function stickerDestination(ctx: ToolContext, to: string | undefined, channel: Channel | undefined): Dest | { error: string } {
  const chs = stickerChannels(ctx);
  const chat = ctx.currentChat?.() ?? null;
  const chatCh = chat && isChannel(chat.channel) && chs.includes(chat.channel) ? chat.channel : null;
  const want = to?.trim() || undefined;
  let ch: Channel;
  let target: string;
  if (!want || (chat && (want.toLowerCase() === chat.name?.toLowerCase() || targetKey(want) === targetKey(chat.target)))) {
    if (!chat || !chatCh) return { error: T.sticker.noChat(chs.map((c) => LABEL[c]).join(" / ")) };
    ch = channel ?? chatCh;
    target = ch === chatCh ? chat.target : resolveName(ctx, ch, chat.name);
  } else {
    const inferred = channelOf(want);
    if (inferred && channel && inferred !== channel) return { error: T.sticker.channelMismatch(want, LABEL[inferred], channel) };
    ch = inferred ?? channel ?? (chs.includes("whatsapp") ? "whatsapp" : chs[0]!);
    target = inferred ? want : resolveName(ctx, ch, want);
  }
  if (!target) return { error: T.sticker.noHandle(want ?? chat?.name, LABEL[ch]) };
  let rerouted = false;
  if (ch === "qqbot" && chs.includes("whatsapp") && !target.startsWith("qqbot:group:")) {
    const heard = ctx.lastHeardFrom?.("qqbot", target) ?? null;
    if (heard === null || ctx.now() - heard > QQ_WINDOW_MS) {
      const wa = resolveName(ctx, "whatsapp", ctx.nameOf?.(target) ?? undefined);
      if (wa) { ch = "whatsapp"; target = wa; rerouted = true; }
    }
  }
  return { channel: ch, target, name: ctx.nameOf?.(target) ?? (chat && targetKey(target) === targetKey(chat.target) ? chat.name ?? null : null), rerouted };
}

/** The stickers module's sticker.py (picking, GIF to MP4, counting uses) */
const sticker = (ctx: ToolContext, args: string[], o: { timeoutMs?: number } = {}): Promise<RunResult> => moduleScript(ctx, "stickers", "sticker.py", args, o);

export function stickerTool(ctx: ToolContext): ToolDef {
  return {
    name: "sticker",
    description: T.sticker.description,
    shape: {
      mood: z.string().optional().describe(T.sticker.params.mood),
      ref: z.array(z.string()).optional().describe(T.sticker.params.ref),
      to: z.string().optional().describe(T.sticker.params.to),
      channel: z.enum((stickerChannels(ctx).length ? stickerChannels(ctx) : ["qqbot", "whatsapp"]) as [Channel, ...Channel[]]).optional().describe(T.sticker.params.channel),
    },
    handler: async (a) => {
      const dest = stickerDestination(ctx, a.to === undefined ? undefined : String(a.to), a.channel as Channel | undefined);
      if ("error" in dest) return dest.error;
      const refs = ((a.ref as string[] | undefined) ?? []).map((x) => String(x).trim()).filter(Boolean);
      const mood = a.mood === undefined ? "" : String(a.mood).trim();
      if (!refs.length && !mood) return T.sticker.needMoodOrRef;
      const pick = refs.length ? ["--ref", ...refs] : ["--mood", ...mood.split(/[\s,，、]+/).filter(Boolean)];
      // 新的 GIF 第一次发 WhatsApp 要转 MP4（ffmpeg），给足时间
      const r = await sticker(ctx, ["prepare", ...pick, "--channel", dest.channel], { timeoutMs: 150_000 });
      let prep: Prepared;
      try { prep = JSON.parse(r.stdout) as Prepared; } catch { return T.sticker.pickFailed(summarize(r, 300)); }
      const items = prep.items ?? [];
      if (!items.length) {
        if (prep.errors?.length) return T.sticker.pickErrors(prep.errors);
        return T.sticker.noMood(mood, prep.nearest_moods);
      }
      const sent: string[] = [];
      const failed: string[] = [...(prep.errors ?? [])];
      const used: string[] = [];
      for (const [i, it] of items.entries()) {
        const res = await ctx.send({ channel: dest.channel, target: dest.target, text: "", media: it.path, ...(it.gifPlayback ? { gifPlayback: true } : {}) });
        if (!res.ok) {
          failed.push(T.sticker.failedItem(it.name, res.out.slice(0, 200)));
          // 超时了、再问一次也没回音（网关卡住了）：后面几张先不发，不然一张张都要等一遍（跟最终回复一样）
          const left = res.unsure === "rechecked" ? items.slice(i + 1) : [];
          if (left.length) { failed.push(T.sticker.heldBack(left.map((x) => x.name))); break; }
          continue;
        }
        sent.push(it.name);
        ctx.recordSend(dest.target, T.sticker.sentRecord(it.name));
        if (it.id) used.push(it.id);
      }
      if (used.length && !ctx.sendDryRun) await sticker(ctx, ["used", ...used]);
      const who = T.sticker.who(dest.name ?? dest.target, LABEL[dest.channel]);
      const parts: string[] = [];
      if (sent.length) parts.push(T.sticker.sent(ctx.sendDryRun, sent, who));
      if (dest.rerouted) parts.push(T.sticker.rerouted);
      if (failed.length) parts.push(T.sticker.notSent(failed));
      return parts.join(T.sticker.sep);
    },
  };
}
