// What HH and the QQ bridge both have to know about QQ, in one place.

/**
 * How long after someone's private message a QQ bot may still answer it (a "passive" reply, free): the platform gives an
 * hour, we leave five minutes. Past it a send is a proactive message, which the platform rations. The bridge answers
 * passively inside this window (bridge/qq/map.ts); the sticker tool sends elsewhere outside it (src/tools/stickers.ts).
 */
export const QQ_REPLY_WINDOW_MS = 55 * 60_000;
