"use strict";
import { HH } from "./i18n.js";
// ---------- 她的回复：「说」和「发给」认成同一段 ----------
/*
 * 她的最终回复在中央记忆里记两回：先是「说」（整段话），发出去以后每个气泡再记一条「发给 谁」。
 * 原样列出来就是同一句话两行。认得出是同一段的，「发给」那几条并进「说」那一行（时间线在那一行标上发给了谁、分几条），
 * 不另占一行；认不出的照旧单独一行。这里只管认，不碰页面。
 *
 * 认法：同一个来源、上一次「做了」之后的那几段「说」，从早到晚，各自从上次认到的地方往后找这个气泡
 * （气泡是那几段话按空行切出来的一截，照原来的次序发）。用 message 工具发的前面隔着它自己那条「做了」，不会并。
 * 一段话只认同一批、发给同一个人的。
 */
const sentInto = new Map();   // 「发给」那条的 seq → 并进去的那条「说」
const sentOf = new Map();     // 「说」的 seq → 并进来的「发给」，按发出的次序
const openSays = new Map();   // 来源 → 上一次「做了」之后的「说」：{ row, at }，at 是这段话认到哪了

/** A "sent" record without its head (who it went to) is what was sent. How the head is written comes from the server: the definition the role's side uses */
const SENT_HEAD = HH.marks.sentHead ? new RegExp(HH.marks.sentHead) : null;
const sentText = (text) => (SENT_HEAD ? text.replace(SENT_HEAD, "") : text);

/** 按 seq 从小到大一条条喂进来。这条「发给」并进了哪条「说」就返回那条，没并返回 null */
function fold(r) {
  if (r.kind === "act") { openSays.delete(r.src); return null; }
  if (r.kind === "say") {
    const open = openSays.get(r.src) || [];
    open.push({ row: r, at: 0 });
    if (open.length > 8) open.shift();
    openSays.set(r.src, open);
    return null;
  }
  if (r.kind !== "note" || !r.meta || r.meta.sent !== true) return null;
  const body = sentText(r.text).trim();
  if (!body) return null;
  for (const s of openSays.get(r.src) || []) {
    const got = sentOf.get(s.row.seq);
    if (got && (got[0].meta.to !== r.meta.to || got[0].meta.batch !== r.meta.batch)) continue;
    const i = s.row.text.indexOf(body, s.at);
    if (i < 0) continue;
    s.at = i + body.length;
    sentInto.set(r.seq, s.row);
    if (got) got.push(r); else sentOf.set(s.row.seq, [r]);
    return s.row;
  }
  return null;
}

/** 前面又接上了更早的记录、或者丢掉了最早的一截：从头再认一遍 */
function refold(all) {
  sentInto.clear(); sentOf.clear(); openSays.clear();
  for (const r of all) fold(r);
}

// ---------- 给别的文件用的 ----------
export { fold, refold, sentInto, sentOf, sentText };
