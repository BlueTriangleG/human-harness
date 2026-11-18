// hh-relay 的纯逻辑（不依赖 OpenClaw，可以单独测试）
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** The role's state directory: HH_STATE_DIR in the gateway's environment, else ~/.hh (the first role, unchanged). Several roles under one user each point their relay at their own */
export const HH = process.env.HH_STATE_DIR || path.join(os.homedir(), ".hh");
export const MODE_FILE = path.join(HH, "relay-mode");
export const SOCK = path.join(HH, "hh.sock");
export const CONFIG_FILE = path.join(HH, "relay.json");
/** hhd 连不上时消息先存在这里，hhd 起来按先后补交（src/relaySpool.ts）；文件 600、目录 700，交完就删 */
export const SPOOL_DIR = path.join(HH, "relay-spool");
/** 等 hhd 回话的默认时间：以前是 5 秒，hhd 一忙就超时（11-12 两天 10 次） */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** 等 hhd 回话多久（毫秒）：~/.hh/relay.json 里的 timeoutMs（1 秒到 2 分钟），没有或不合法就用默认 */
export function relayTimeoutMs(file = CONFIG_FILE) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"))?.timeoutMs;
    if (Number.isInteger(v) && v >= 1000 && v <= 120_000) return v;
  } catch { /* 没有这个文件、不是 JSON：用默认 */ }
  return DEFAULT_TIMEOUT_MS;
}

export function relayMode() {
  try { return fs.readFileSync(MODE_FILE, "utf8").trim(); } catch { return "native"; }
}

/**
 * hhd 连不上时怎么办：~/.hh/relay.json 的 fallback。"spool"（默认）= 先存进 relay-spool、等 hhd 回来补交，不交给 OpenClaw 的 agent；
 * "openclaw" = 照旧交回 OpenClaw（老的 agent 停了，默认不交）
 */
export function relayFallback(file = CONFIG_FILE) {
  try { if (JSON.parse(fs.readFileSync(file, "utf8"))?.fallback === "openclaw") return "openclaw"; } catch { /* 默认 */ }
  return "spool";
}

/**
 * request 失败以后这条消息怎么办（纯函数，钩子照它走）：
 * "taken" = hhd 已经收下（送到了、连接开着、只是超时），不交回；"spool" = 先存着等 hhd 回来补交；"openclaw" = 交回 OpenClaw
 */
export function fallbackAction(err, fallback) {
  if (!handBack(err)) return "taken";
  return fallback === "openclaw" ? "openclaw" : "spool";
}

/** 存一条消息等 hhd 回来：先写 .tmp 再改名（hhd 只拿写完的）；文件名开头是存的时刻，补交按它排先后 */
export function spool(message, dir = SPOOL_DIR, now = Date.now()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `${String(now).padStart(15, "0")}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: now, message }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, name));
  return name;
}

/**
 * 把一条请求交给 hhd。出错时错误上带两个记号，给 handBack 判断要不要交回 OpenClaw：
 * sent（请求已经写进 hhd 的 socket）、hhError（hhd 回了话，明说没收下）
 */
export function request(sock, req, timeoutMs = relayTimeoutMs()) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sock);
    let buf = "";
    let sent = false;
    let done = false;
    const fail = (e, extra = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(Object.assign(e instanceof Error ? e : new Error(String(e)), { sent }, extra));
    };
    const timer = setTimeout(() => { s.destroy(); fail(Object.assign(new Error("hhd timeout"), { code: "HH_TIMEOUT" })); }, timeoutMs);
    s.on("connect", () => { s.write(JSON.stringify(req) + "\n"); sent = true; });
    s.on("data", (c) => {
      buf += c.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      s.end();
      let msg;
      try { msg = JSON.parse(buf.slice(0, i)); } catch (e) { fail(e); return; }
      if (msg.ok) { done = true; clearTimeout(timer); resolve(msg.data); } else fail(new Error(msg.error), { hhError: true });
    });
    s.on("error", (e) => fail(e));
    // 回话前连接就关了：hhd 回 relay 是同步的（读到就处理、同一拍回话），关了还没回 = 它没处理（正在退出、崩了、被杀）。
    // macOS 上这种情况客户端只收到 EOF、没有 error，不接住就会一直等到超时、再被当成「已接管」（复核 fd1e1217）
    s.on("close", () => fail(Object.assign(new Error("hhd closed without answering"), { code: "HH_CLOSED" })));
  });
}

/**
 * request 失败了，这条消息要不要交回 OpenClaw（交回就是 OpenClaw 自己的 agent 来回）：
 * 只有一种不交回——已经送到、连接一直开着、等满了还没回话（HH_TIMEOUT）：hhd 活着、只是卡住了，字节在它那里，解卡后照样处理。
 *   以前超时也交回，一条消息两边各处理一遍：OpenClaw 的老 agent 也动手、以她的名义回人（11-12「两个她」，两天 10 次）。
 * 其余都交回，不然没人接：连不上（hhd 没起来、正在重启）、回话前连接就关了或断了（它没处理）、hhd 明说没收下
 */
export function handBack(err) {
  return !(err?.sent === true && err?.code === "HH_TIMEOUT");
}

/** 这条消息要不要交给 HH（纯函数，方便测试） */
export function shouldClaim(text, mode) {
  if (mode !== "hh") return false;
  const t = String(text ?? "").trim();
  return t.length > 0 && !t.startsWith("/");
}

/**
 * 附件路径（#0012）：before_dispatch 事件不带附件，OpenClaw 只在 message_received 事件里给 media。
 * 所以 message_received 先按 messageId 记下附件的本地路径，before_dispatch 再取出来拼进文字。
 */
export function mediaPathsOf(event) {
  const fromMedia = Array.isArray(event?.media) ? event.media.map((m) => m?.path) : [];
  const md = event?.metadata ?? {};
  const fallback = Array.isArray(md.mediaPaths) ? md.mediaPaths : [md.mediaPath];
  const paths = (fromMedia.some(Boolean) ? fromMedia : fallback).filter((p) => typeof p === "string" && p.trim());
  return [...new Set(paths)];
}

const MEDIA_TTL_MS = 10 * 60_000;
const MEDIA_MAX = 200;

/** messageId → 附件路径（只在内存里，短暂保存，取过就删） */
export function createMediaCache(now = () => Date.now()) {
  const map = new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of map) if (t - v.at > MEDIA_TTL_MS) map.delete(k);
    while (map.size > MEDIA_MAX) map.delete(map.keys().next().value);
  };
  return {
    remember(messageId, paths) {
      if (!messageId) return;
      map.set(String(messageId), { paths, at: now() });
      prune();
    },
    has(messageId) { return messageId != null && map.has(String(messageId)); },
    take(messageId) {
      if (messageId == null) return [];
      const k = String(messageId);
      const v = map.get(k);
      map.delete(k);
      return v?.paths ?? [];
    },
  };
}

/**
 * 取这条消息的附件。message_received 是「发了不等」的，极少数情况会比 before_dispatch 晚到，
 * 所以见过这个渠道的 message_received 时，没记录就最多等 waitMs；没见过（配置没开）就不等，行为跟以前一样。
 */
export async function takeMediaFor(cache, messageId, { wait = false, waitMs = 300, stepMs = 20 } = {}) {
  if (messageId == null) return [];
  if (wait) {
    for (let t = 0; t < waitMs && !cache.has(messageId); t += stepMs) {
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  return cache.take(messageId);
}

/** 缓存的键：渠道 + messageId（两个渠道的 id 撞上也不串） */
export function mediaKey(channel, messageId) {
  return messageId == null || messageId === "" ? null : `${channel}:${messageId}`;
}

export function toRelayMessage(event, ctx, mediaPaths = []) {
  // 人自己打的「[附件:」换成全角，只有 relay 拼的那种是半角原样（不然谁都能手打一个「[附件: /Users/someone/.ssh/…]」冒充附件）
  const content = String(event?.content ?? "").replace(/\[附件\s*[:：]/g, "［附件:");
  // QQ 的正文里已经自带「[Attachment: 路径]」，写过的路径不重复加
  const attach = mediaPaths.filter((p) => !content.includes(p)).map((p) => `[附件: ${p}]`).join("\n");
  return {
    channel: String(ctx?.channelId ?? event?.channel ?? ""),
    text: [content, attach].filter(Boolean).join("\n"),
    senderId: event?.senderId ?? ctx?.senderId,
    sessionKey: event?.sessionKey ?? ctx?.sessionKey,
    messageId: event?.messageId ?? ctx?.messageId,
    isGroup: event?.isGroup === true,
    conversationId: ctx?.conversationId,
    replyToBody: event?.replyToBody ?? ctx?.replyToBody,
  };
}

