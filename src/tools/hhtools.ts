// HH 工具：每个脑区按角色拿到一部分。背后尽量复用她现有的脚本（recall.py / cc.py）；目标的工具在 goals 模块里。
import { z } from "zod";
import { join } from "node:path";
import type { ToolDef } from "../kernel/types.ts";
import type { Runner, RunResult } from "../util/run.ts";
import type { GatewayCaller } from "../gateway/client.ts";
import type { Logger } from "../log.ts";
import type { Send } from "../channels/types.ts";
import { summarize } from "../util/run.ts";
import { calendarDay, hhmm, localTime, nextDay, parseHM } from "../brainstem/clock.ts";
import { B, G, T, N, dateLocale } from "../lang/index.ts";
import { stickerChannels, stickerTool } from "./stickers.ts";
import { browserTool } from "./browser.ts";
import { computerTool } from "./computer.ts";
import type { Chrome } from "../browser/chrome.ts";
import type { Rule } from "../gate/rules.ts";
import { changeRules, OUTCOMES, readRuleFile, ruleLine, checkRule, tryRules, writeRuleFile } from "../gate/rules.ts";
import type { Outcome, RuleChange } from "../gate/rules.ts";
import type { SenseEvent } from "../gate/types.ts";
import { type Sources, fixedSrcs } from "../gate/sources.ts";
import type { People } from "../persona/people.ts";
import { CARD_DIR } from "../memory/events/people.ts";
import {
  applyApproved, baseOf, changeText, clashOf, entryProblem, handlesText, idKeys, isElevated, keyFor, mergePerson, newIdentifiers, ownersOf,
  readRegistryFile, REGISTRY_FILE, sameValue, writeRegistryFile,
} from "../persona/registry.ts";

/** Brain 提供给工具的能力（工具本身不碰数据库和其它模块） */
/** A loaded module's script (ToolContext.moduleRun); with that module off, a failed run that says so */
export function moduleScript(ctx: Pick<ToolContext, "moduleRun">, module: string, script: string, args: string[], o: { timeoutMs?: number } = {}): Promise<RunResult> {
  return ctx.moduleRun?.(module, script, args, o) ?? Promise.resolve({ code: 1, stdout: "", stderr: B.modules.needsModule(module) });
}

export interface ToolContext {
  regionId: string;
  workspace: string;
  python: string;
  sendDryRun: boolean;
  /** The role's channels (config channels); none: the message tool is not offered. Not given: the first role's two */
  channels?: readonly string[];
  /** Sends one message: the framework's one way out (openChannels in src/channels/send.ts) */
  send: Send;
  gateway?: GatewayCaller;
  /** 工具里要记的日志（电脑收尾没收掉） */
  log?: Pick<Logger, "info" | "warn" | "error">;
  timezone: string;
  sideThreads: number;
  run: Runner;
  now(): number;
  /** 随手记一笔；urgent：急事，一边做着的那头记的会尽快叫说话的那头看 */
  note(text: string, o?: { urgent?: boolean }): void;
  /** 开始做一件事：about 是她估的「大概要多久」，pri 是 T0–T3；返回给她的那句话（超过阈值的会一边做着；自己做时后面接想起来的笔记） */
  start(topic: string, about?: string, pri?: string): Promise<string>;
  /** 做完了 / 只剩跟进 / 卡住了（on：卡在什么上）；花了多久按钟表算，不用她自报 */
  finish(topic: string, state?: string, on?: string): string | Promise<string>;
  /** 发出去之前：返回一段话就不发、把这段话给她（交给主人之前先对一遍笔记）；null 照发 */
  beforeSend?: (target: string, text: string, media?: string) => Promise<string | null>;
  /** 定下手上这件事做到什么样才算好；改的时候带理由 */
  setBar(bar: string, why?: string, topic?: string): string;
  /** 只要结论的事放着慢慢想（下意识思考） */
  mullOver(what: string): string;
  /** 截图之类的图片存到哪 */
  shotsDir?: string;
  /** 她自己的 Chrome（HH 直接控制） */
  browser?: Chrome;
  /** 下意识注意到的事交给主线好好想 */
  thinkItOver(what: string): string;
  schedule(kind: "remind" | "focus", due: number, text: string, everyMs: number | null, minutes?: number | null): number;
  /** 还没到点的提醒和专注（reminders 用） */
  scheduled?(): Array<{ id: number; kind: "remind" | "focus"; due: number; everyMs: number | null; text: string; minutes: number | null }>;
  /** 按编号取消一个排好的；没有这个编号返回 false */
  unschedule?(id: number): boolean;
  /** 循环提醒今天已经做过了：记下现在（同一天里的到点不叫；HH 的一天凌晨 4 点换） */
  remindDone?(id: number): void;
  /** 这个提醒最后一次记「做过了」的时间；没记过返回 null */
  remindDoneAt?(id: number): number | null;
  /** 发出去了：记进中央记忆。resolved：网关回的、它认出的会话号（她写的是群名之类时和 to 不一样） */
  recordSend(to: string, text: string, resolved?: string): void;
  /** target 写的是人名时换成真正的发送目标（认不出就原样返回） */
  resolveTarget?(channel: string, target: string): string;
  /** 这一轮是被谁的消息叫起来的（回给谁）；不是被消息叫起来的返回 null */
  currentChat?(): { channel: string; target: string; name?: string } | null;
  /** 这个人在这个渠道最后一次来消息的时间；没来过返回 null */
  lastHeardFrom?(channel: string, target: string): number | null;
  /** 发送目标是谁（名单里的名字）；认不出返回 null */
  nameOf?(target: string): string | null;
  /** 先在中央记忆里找原话；找不到返回空字符串 */
  recallLocal(args: string[]): string;
  /** 按意思找原话层（HH 的原话 + 导入的旧原话 + 笔记）；有它就不再去调 Honcho。找不到返回空字符串 */
  recallQuotes?(q: string, who?: string, o?: { olderOnly?: boolean }): Promise<string>;
  /** 某一天原话层里的原话（换大脑之前的日子） */
  recallQuotesDay?(day: string, who?: string): string;
  /** 开始做一件事的工具（goals）里联想笔记：挂给她的文字，没想起来、出错、超时都是空串（不抛错，最多等联想的时限）。派活（hands）的笔记由 cc.py 附给帮手 */
  recallNotes?(topic: string, binding: "goals"): Promise<string>;
  /** Run a script of a loaded module (src/modules: its environment, its time limit); null when that module is not on */
  moduleRun?(module: string, script: string, args: readonly string[], o?: { timeoutMs?: number }): Promise<RunResult> | null;
  /** 她自己找全（what_do_i_know）：笔记里相关的页 + 以前做过的类似的事，两段之间空一行；都没有返回 T.what_do_i_know.none。category 只看那个大类的页 */
  askNotes?(topic: string, category?: string): Promise<string>;
  /** 她的下意识规则（what_reaches_me）：闸门开着才有 */
  gateRules?: {
    /** 规则文件（工作区里的相对路径，配置 gate.rulesFile） */
    file: string;
    /** 现在生效的规则（坏的、被跳过的不在里面） */
    current(): Rule[];
    /** 文件刚写过：马上重读 */
    reread(): void;
    /** 当前名单（try 里认人） */
    people(): People;
    /** 她的名字（认 @ 用） */
    names: { me: string; notMe: string[] };
    /** 通道表（实例配置 senses.sources）：哪些来源走固定的路、规则管不到 */
    sources: Sources;
    /** 最近几天的真动静（事件日志 senses.logFile，去过重）；读不到给 null */
    recent(days: number): SenseEvent[] | null;
  };
  /** 认识的人名单（people_i_know）：有名单文件才有 */
  registry?: {
    /** 主人批过的底子；读不了给 null */
    approved(): Record<string, Record<string, unknown>> | null;
    /** 文件刚写过：重载名单（马上认得）、记一笔给每日总结 */
    changed(line: string): void;
    /** 现在生效的名单 */
    people(): People;
  };
}

/** 改完文件记进她工作区的 git；失败只报告，不撤回已经写好的文件 */
async function commitToWorkspace(ctx: ToolContext, rel: string, msg: string): Promise<string> {
  const W = ctx.workspace;
  const add = await ctx.run("git", ["-C", W, "add", rel], { cwd: W, timeoutMs: 30_000 });
  const r = add.code === 0 ? await ctx.run("git", ["-C", W, "commit", "-m", msg, "--", rel], { cwd: W, timeoutMs: 30_000 }) : add;
  return r.code === 0 ? "" : T.workspaceGit.failed(summarize(r, 200));
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

async function whatReachesMe(ctx: ToolContext, a: Record<string, unknown>): Promise<string> {
  const g = ctx.gateRules;
  if (!g) return T.what_reaches_me.gateOff;
  const action = String(a.action);
  const rule = obj(a.rule);
  const id = a.id === undefined ? undefined : String(a.id);
  const to = typeof a.to === "number" ? a.to : undefined;
  const path = join(ctx.workspace, g.file);

  if (action === "list") {
    const f = readRuleFile(path);
    const lines = "error" in f
      ? [T.what_reaches_me.listUnreadable(f.error), ...g.current().map(ruleLine)]
      : f.list.map((x, i) => { const v = checkRule(x, fixedSrcs(g.sources)); return "error" in v ? T.what_reaches_me.ruleBroken(i, obj(x)?.id, v.error) : ruleLine(v.rule, i); });
    const head = "error" in f ? [] : [T.what_reaches_me.listHead(f.fresh)];
    return [...head, ...lines, T.what_reaches_me.fixedLine, T.what_reaches_me.ruleLegend].join("\n");
  }

  if (action === "try") return tryReaches(g, rule, id, to, typeof a.days === "number" ? a.days : 7);

  let change: RuleChange;
  if (action === "add") {
    if (!rule) return T.what_reaches_me.addNeedsRule;
    change = { kind: "add", rule, ...(to !== undefined ? { to } : {}) };
  } else if (action === "edit") {
    if (!id || !rule) return T.what_reaches_me.editNeedsIdRule;
    change = { kind: "edit", id, patch: rule };
  } else if (action === "remove") {
    if (!id) return T.what_reaches_me.removeNeedsId;
    change = { kind: "remove", id };
  } else if (action === "move") {
    if (!id || to === undefined) return T.what_reaches_me.moveNeedsIdTo;
    change = { kind: "move", id, to };
  } else return T.what_reaches_me.unknownAction(action);

  const f = readRuleFile(path);
  if ("error" in f) return T.what_reaches_me.fileUnreadable(f.error);
  const r = changeRules(f.list, change, fixedSrcs(g.sources));
  if ("error" in r) return T.what_reaches_me.notChanged(r.error);
  try { writeRuleFile(path, f.top, r.list); } catch (e) { return T.what_reaches_me.notWritten(e instanceof Error ? e.message : String(e)); }
  g.reread();
  const git = await commitToWorkspace(ctx, g.file, T.what_reaches_me.commit(action, r.id));
  return T.what_reaches_me.changed(action, r.id, r.at, git);
}

/** try：拿最近几天的真动静按「改了以后的」规则走一遍，只算不判 */
function tryReaches(g: NonNullable<ToolContext["gateRules"]>, rule: Record<string, unknown> | undefined, id: string | undefined, to: number | undefined, days: number): string {
  const base = g.current();
  let rules = base;
  let what = T.what_reaches_me.currentRules;
  let focus = id;
  if (rule) {
    const rid = typeof rule.id === "string" ? rule.id : undefined;
    const exists = rid !== undefined && base.some((x) => x.id === rid);
    const r = exists
      ? changeRules(base, { kind: "edit", id: rid!, patch: rule }, fixedSrcs(g.sources))
      : changeRules(base, { kind: "add", rule, ...(to !== undefined ? { to } : {}) }, fixedSrcs(g.sources));
    if ("error" in r) return T.what_reaches_me.tryFailed(r.error);
    rules = r.list as Rule[];
    what = exists ? T.what_reaches_me.afterEdit(r.id) : T.what_reaches_me.afterAdd(r.id, r.at);
    focus = r.id;
  } else if (id !== undefined && !base.some((x) => x.id === id)) return T.what_reaches_me.noSuchRule(id);
  const evs = g.recent(days);
  if (evs === null) return T.what_reaches_me.noEvents;
  const people = g.people();
  const run = (rs: Rule[]) => tryRules(evs, rs, people, g.names, g.sources);
  const res = run(rules);
  const example = (ev: SenseEvent) => { const t = ev.text.replace(/\s+/g, " ").trim(); return t.length > 40 ? T.what_reaches_me.clipped(t.slice(0, 39)) : t; };
  const buckets = (xs: ReturnType<typeof run>) => new Map(OUTCOMES.map((o) => [o, xs.filter((x) => x.outcome === o)] as [Outcome, typeof xs]));
  const out = [T.what_reaches_me.tried(days, evs.length, what)];
  for (const [o, xs] of buckets(res)) out.push(T.what_reaches_me.bucket(G.rules.outcomeName[o], xs.length, xs.slice(0, 3).map((x) => example(x.ev))));
  if (focus) out.push(T.what_reaches_me.caught(focus, res.filter((x) => x.ruleId === focus).length));
  if (rule) out.push(T.what_reaches_me.underCurrent([...buckets(run(base))].map(([o, xs]) => [G.rules.outcomeName[o], xs.length] as const)));
  out.push(T.what_reaches_me.tryOnly);
  return out.join("\n");
}

async function peopleIKnow(ctx: ToolContext, a: Record<string, unknown>): Promise<string> {
  const book = ctx.registry;
  if (!book) return T.people_i_know.noBook;
  const action = String(a.action);
  if (action === "list") {
    const reg = book.people().registry;
    const lines = Object.entries(reg).flatMap(([k, v]) => {
      const e = obj(v);
      if (k.startsWith("_") || !e) return [];
      const tags = [typeof e.privacy === "string" ? e.privacy : "guest", ...(typeof e.trust === "string" ? [e.trust] : []), ...(e.privacy === "owner" ? [T.people_i_know.ownerTag] : [])];
      return [T.people_i_know.listLine(k, typeof e.name === "string" ? e.name : k, tags, handlesText(e))];
    });
    return lines.length ? T.people_i_know.list(lines) : T.people_i_know.listEmpty;
  }
  const key = a.key === undefined ? undefined : String(a.key).trim();
  const entry = obj(a.entry);
  if (entry?.privacy === "owner") return T.people_i_know.ownerForbidden;
  const path = join(ctx.workspace, REGISTRY_FILE);
  const f = readRegistryFile(path);
  if ("error" in f) return T.people_i_know.fileUnreadable(f.error);
  const reg = f.reg;
  const approved = book.approved() ?? {};
  // 主人：底子里记着的，加上文件里写着 owner 的（宁可多护一个）
  const owners = new Set([...ownersOf(approved), ...ownersOf(reg)]);
  // 查撞名、撞号时比的「别人」：文件里的每个人，加上文件里被删掉、但底子里记着的主人
  // 主人一律按底子比（生效的是底子那条）：手改从文件里删掉的主人的号，别人也认领不走
  const ownerKeys = new Set(ownersOf(approved));
  const others = (self: string | null): Array<[string, Record<string, unknown>]> => [
    ...Object.entries(reg).flatMap(([k, v]) => { const e = obj(v); return k === self || k.startsWith("_") || ownerKeys.has(k) || !e ? [] : [[k, e] as [string, Record<string, unknown>]]; }),
    ...[...ownerKeys].filter((k) => k !== self).map((k) => [k, baseOf(approved, k)!] as [string, Record<string, unknown>]),
  ];
  const keyBad = (k: string): string | null => (!k || k.startsWith("_") || /\s/.test(k) || k.length > 40 ? T.people_i_know.keyBad(k) : null);
  const nameOf = (k: string): string => { const e = obj(reg[k]); return typeof e?.name === "string" ? e.name : k; };
  let line: string;
  let reply: string;
  let dropped: string[] = [];

  if (action === "add") {
    if (!entry) return T.people_i_know.addNeedsEntry;
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (!name) return T.people_i_know.addNeedsName;
    const k = key ?? keyFor(name);
    const bad = keyBad(k);
    if (bad) return bad;
    if (owners.has(k)) return T.people_i_know.ownerOnly;
    if (Object.hasOwn(reg, k)) return T.people_i_know.addExists(k, nameOf(k));
    const prob = entryProblem(entry);
    if (prob) return T.people_i_know.addRefused(prob);
    // 不在文件里的 key 就是新的人：不拿底子比（删了阿青再用 aqing 加一个，也拿不回阿青批过的权限，ruling 39）
    const m = mergePerson(undefined, { ...entry, name }, undefined);
    const clash = clashOf(others(null), { names: [name, k], ids: idKeys(m.entry) });
    if (clash) return T.people_i_know.addClash(clash);
    if (m.entry.privacy === undefined) m.entry.privacy = "guest";
    reg[k] = m.entry;
    dropped = m.dropped;
    const ids = handlesText(m.entry);
    line = T.people_i_know.addedLine(name, ids);
    reply = T.people_i_know.added(k, name, ids);
  } else if (action === "update") {
    if (!key || !entry) return T.people_i_know.updateNeedsKeyEntry;
    if (keyBad(key)) return keyBad(key)!;
    if (owners.has(key)) return T.people_i_know.ownerOnly;
    const old = obj(reg[key]);
    if (!Object.hasOwn(reg, key) || !old) return T.people_i_know.updateNoKey(key);
    const prob = entryProblem(entry);
    if (prob) return T.people_i_know.updateRefused(prob);
    const base = baseOf(approved, key);
    const m = mergePerson(old, entry, base);
    // 这次新带来的号、会话、显示名（删掉的不算）；改了名字也要查撞没撞
    const oldIds = idKeys(old);
    const added = new Map([...idKeys(m.entry)].filter(([id]) => !oldIds.has(id)));
    // 文件里她身上已经有没批过的号 / 显示名（装名单时整条权限按访客上限，等主人 approve）：只许删认人字段（这正是解开它的办法）。
    // 别的改动先不做：不然写回去的权限会跟着变，主人再 approve 就批成了改过的样子
    const pending = applyApproved({ [key]: old }, approved).unapproved.find((u) => u.key === key);
    const idOnly = Object.keys(entry).every((k) => k === "senders" || k === "sessionKeys" || k === "handles") && added.size === 0;
    if (pending && !idOnly) return T.people_i_know.updatePending(nameOf(key), pending.ids);
    const newName = typeof m.entry.name === "string" && m.entry.name !== old.name ? [m.entry.name] : [];
    const clash = clashOf(others(key), { names: newName, ids: added });
    if (clash) return T.people_i_know.updateClash(clash);
    // 升过权的人（信任的朋友这样的）：加号、加显示名要主人批，不然陌生人借她的号就拿到她的权限（ruling 39）
    if (isElevated(base) && added.size) {
      const notApproved = new Set(newIdentifiers(m.entry, obj(base!.identity) ?? {}));
      const asks = [...added.values()].filter((d) => notApproved.has(d));
      if (asks.length) return T.people_i_know.updateAskOwnerIds(nameOf(key), asks);
    }
    // 写进文件的是合并后的样子：权限字段只裁这次写的，文件里原有的照旧（绝不拿装名单时裁过的样子写回去）
    const next = m.entry;
    const lost = m.dropped;
    // 什么都没变（要么和原来一样，要么想改的全被裁了）：不写、不提交
    if (sameValue(next, old)) return lost.length ? T.people_i_know.updateAskOwner(lost) : T.people_i_know.updateSame;
    reg[key] = next;
    dropped = lost;
    // 记真变了什么：号、显示名写出加了哪个、删了哪个（主人在总结里要看得见）
    const what = changeText(old, next);
    line = T.people_i_know.updatedLine(nameOf(key), what);
    reply = T.people_i_know.updated(key, what);
  } else if (action === "remove") {
    if (!key) return T.people_i_know.removeNeedsKey;
    if (keyBad(key)) return keyBad(key)!;
    if (owners.has(key)) return T.people_i_know.ownerOnly;
    if (!Object.hasOwn(reg, key) || !obj(reg[key])) return T.people_i_know.removeNoKey(key);
    const name = nameOf(key);
    delete reg[key];
    line = T.people_i_know.removedLine(name, key);
    reply = T.people_i_know.removed(name, key);
  } else return T.people_i_know.unknownAction(action);

  if (dropped.length) line += T.people_i_know.droppedLine(dropped);
  try { writeRegistryFile(path, reg); } catch (e) { return T.people_i_know.notWritten(e instanceof Error ? e.message : String(e)); }
  const git = await commitToWorkspace(ctx, REGISTRY_FILE, T.people_i_know.commit(line));
  book.changed(line);
  return `${reply}${dropped.length ? T.people_i_know.droppedNote(dropped) : ""}${git}`;
}


/** "+40m" / "+2h" / "15:00"（今天，过了就明天）/ ISO 时间 → 毫秒时间戳 */
export function parseWhen(when: string, now: number, tz: string): number {
  const s = when.trim();
  const rel = /^\+(\d+)\s*([mh])$/.exec(s);
  if (rel) return now + Number(rel[1]) * (rel[2] === "h" ? 3_600_000 : 60_000);
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const target = parseHM(s);
    const { minutes } = localTime(now, tz);
    let diff = target - minutes;
    if (diff <= 0) diff += 24 * 60;
    return now + diff * 60_000;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(T.schedule.timeUnreadable(when));
  return t;
}

/**
 * 给她看的时间：同一天「今天 07:40」、下一天「明天 07:40」，再往后带日期。
 * 现在或那个时间落在半夜（0–4 点，HH 的一天和日历上的一天不是同一天）时说「今天 / 明天」会读错，直接写日期
 */
export function whenLabel(ts: number, now: number, tz: string): string {
  const day = localTime(ts, tz).day;
  const today = localTime(now, tz).day;
  const date = calendarDay(ts, tz);
  if (date !== day || calendarDay(now, tz) !== today) return `${date.slice(5)} ${hhmm(ts, tz)}`;
  const label = day === today ? T.schedule.today : day === nextDay(today) ? T.schedule.tomorrow : day.slice(5);
  return `${label} ${hhmm(ts, tz)}`;
}

/** 此刻记了「今天做过了」以后真正叫的第一次：已经过点还没叫的、今天（HH 的一天）剩下的都跳过 */
function nextAfterDone(due: number, everyMs: number, now: number, tz: string): number {
  const today = localTime(now, tz).day;
  let t = due;
  while (t <= now || localTime(t, tz).day === today) t += everyMs;
  return t;
}

export function parseEvery(every: string | undefined): number | null {
  if (!every) return null;
  if (every === "daily") return 86_400_000;
  const m = /^(\d+)\s*([mh])$/.exec(every.trim());
  if (!m) throw new Error(T.schedule.everyUnreadable(every));
  const ms = Number(m[1]) * (m[2] === "h" ? 3_600_000 : 60_000);
  if (ms < 30 * 60_000) throw new Error(T.schedule.everyTooShort);
  return ms;
}

export function buildTools(ctx: ToolContext, allowed: readonly string[]): ToolDef[] {
  // the role's channels, in name order; with none the message tool is left out (nothing can go out)
  const channels = [...(ctx.channels ?? ["qqbot", "whatsapp"])].sort();
  const all: ToolDef[] = [
    {
      name: "message",
      description: T.message.description.replaceAll("{{channels}}", channels.map((c) => T.message.channelLabel(c)).join(" / ")),
      shape: {
        action: z.enum(["send"]).default("send"),
        channel: z.string().describe(channels.join(" / ")),
        target: z.string().describe(T.message.params.target),
        message: z.string().optional().describe(T.message.params.message),
        media: z.string().optional().describe(T.message.params.media),
        replyTo: z.string().optional().describe(T.message.params.replyTo),
        asVoice: z.boolean().optional().describe(T.message.params.asVoice),
      },
      handler: async (a) => {
        const target = ctx.resolveTarget ? ctx.resolveTarget(String(a.channel), String(a.target)) : String(a.target);
        const hold = ctx.beforeSend ? await ctx.beforeSend(target, a.message === undefined ? "" : String(a.message), a.media === undefined ? undefined : String(a.media)) : null;
        if (hold) return hold;
        const r = await ctx.send({
          channel: String(a.channel), target, text: a.message === undefined ? "" : String(a.message),
          media: a.media === undefined ? undefined : String(a.media), replyTo: a.replyTo === undefined ? undefined : String(a.replyTo),
          asVoice: a.asVoice === undefined ? /\.(ogg|opus)$/i.test(a.media === undefined ? "" : String(a.media)) : a.asVoice === true,
        });
        if (r.ok) ctx.recordSend(target, a.message === undefined ? `[${String(a.media)}]` : String(a.message), r.resolved);
        return r.out;
      },
    },
    {
      name: "jot_down",
      description: T.jot_down.description,
      shape: {
        text: z.string(),
        urgent: z.boolean().optional().describe(T.jot_down.params.urgent),
      },
      handler: async (a) => { ctx.note(String(a.text), a.urgent === true ? { urgent: true } : undefined); return T.jot_down.noted; },
    },
    {
      name: "on_it",
      description: T.on_it.description,
      shape: {
        topic: z.string().describe(T.on_it.params.topic),
        about: z.string().optional().describe(T.on_it.params.about),
        pri: z.enum(["T0", "T1", "T2", "T3"]).optional().describe(T.on_it.params.pri),
      },
      handler: async (a) => ctx.start(String(a.topic), a.about === undefined ? undefined : String(a.about), a.pri === undefined ? undefined : String(a.pri)),
    },
    {
      name: "set_bar",
      description: T.set_bar.description,
      shape: {
        bar: z.string().describe(T.set_bar.params.bar),
        why: z.string().optional().describe(T.set_bar.params.why),
        topic: z.string().optional().describe(T.set_bar.params.topic),
      },
      handler: async (a) => ctx.setBar(String(a.bar), a.why === undefined ? undefined : String(a.why), a.topic === undefined ? undefined : String(a.topic)),
    },
    {
      name: "done_with",
      description: T.done_with.description,
      shape: {
        topic: z.string(),
        state: z.enum([B.forms.doneStates.done, B.forms.doneStates.follow, B.forms.doneStates.stuck]).optional(),
        on: z.string().optional().describe(T.done_with.params.on),
      },
      handler: async (a) => ctx.finish(String(a.topic), a.state === undefined ? undefined : String(a.state), a.on === undefined ? undefined : String(a.on)),
    },
    {
      name: "mull_over",
      description: T.mull_over.description,
      shape: { what: z.string().describe(T.mull_over.params.what) },
      handler: async (a) => ctx.mullOver(String(a.what)),
    },
    {
      name: "think_it_over",
      description: T.think_it_over.description,
      shape: { what: z.string().describe(T.think_it_over.params.what) },
      handler: async (a) => ctx.thinkItOver(String(a.what)),
    },
    {
      name: "ack",
      description: T.ack.description,
      shape: { id: z.string().describe(T.ack.params.id) },
      handler: async (a) => {
        const id = String(a.id).trim();
        if (!/^[0-9a-f]{6,40}$/i.test(id)) return T.ack.badId;
        const r = await moduleScript(ctx, "senses", "senses.py", ["--ack", id]);
        return r.code === 0 ? T.ack.acked : T.ack.failed(summarize(r));
      },
    },
    computerTool(ctx),
    {
      name: "remind",
      description: T.remind.description,
      shape: {
        when: z.string(), text: z.string(), kind: z.enum(["remind", "focus"]).optional(), every: z.string().optional(), minutes: z.number().int().min(5).max(480).optional(),
        done_today: z.boolean().optional().describe(T.remind.params.done_today),
      },
      handler: async (a) => {
        const now = ctx.now();
        const due = String(a.when) === "now" ? now : parseWhen(String(a.when), now, ctx.timezone);
        const every = parseEvery(a.every === undefined ? undefined : String(a.every));
        const kind = (a.kind as "remind" | "focus" | undefined) ?? "remind";
        const minutes = kind === "focus" ? Number(a.minutes ?? 30) : null;
        const id = ctx.schedule(kind, due, String(a.text), every, minutes);
        if (kind === "remind" && every) {
          // 循环提醒：说清第一次真正叫是什么时候；第一次就在今天又没说做过了，提一句做过了怎么跳过
          const today = localTime(now, ctx.timezone).day;
          const done = a.done_today === true && !!ctx.remindDone;
          if (done) ctx.remindDone!(id);
          const first = done ? nextAfterDone(due, every, now, ctx.timezone) : due;
          const firstToday = localTime(first, ctx.timezone).day === today;
          // 真跳过了（第一次往后挪了）才说不叫
          return T.remind.repeating(id, every, whenLabel(first, now, ctx.timezone), first !== due, firstToday);
        }
        return T.remind.once(id, new Date(due).toLocaleString(dateLocale(), { timeZone: ctx.timezone }), minutes, every);
      },
    },
    {
      name: "reminders",
      description: T.reminders.description,
      shape: { action: z.enum(["ls", "cancel", "done"]), id: z.number().int().optional() },
      handler: async (a) => {
        const items = ctx.scheduled?.() ?? [];
        const now = ctx.now();
        const today = localTime(now, ctx.timezone).day;
        const doneToday = (x: (typeof items)[number]): number | null => {
          const at = x.kind === "remind" && x.everyMs ? ctx.remindDoneAt?.(x.id) ?? null : null;
          return at !== null && localTime(at, ctx.timezone).day === today ? at : null;
        };
        const line = (x: (typeof items)[number]): string => {
          const done = doneToday(x);
          return T.reminders.line({
            id: x.id, at: new Date(x.due).toLocaleString(dateLocale(), { timeZone: ctx.timezone }), everyMs: x.everyMs,
            doneAt: done !== null ? hhmm(done, ctx.timezone) : null, kind: x.kind, minutes: x.minutes, text: x.text,
          });
        };
        if (a.action === "ls") return items.length ? T.reminders.list(items.map(line)) : T.reminders.none;
        if (a.id === undefined) return T.reminders.needsId(a.action);
        const x = items.find((i) => i.id === Number(a.id));
        if (!x) return T.reminders.noSuch(a.id);
        if (a.action === "done") {
          if (!x.everyMs) return T.reminders.onceOnly(x.id);
          if (x.kind !== "remind") return T.reminders.focusNotDone(x.id);
          ctx.remindDone?.(x.id);
          const next = nextAfterDone(x.due, x.everyMs, now, ctx.timezone);
          const skips = x.due <= now || localTime(x.due, ctx.timezone).day === today;
          return skips
            ? T.reminders.doneSkips(x.id, x.everyMs, whenLabel(next, now, ctx.timezone))
            : T.reminders.doneNothingLeft(x.id, whenLabel(next, now, ctx.timezone));
        }
        if (x.text.startsWith(B.forms.ownerSetReminder(N.owner))) return T.reminders.ownerSet(x.id);
        ctx.unschedule?.(x.id);
        return T.reminders.cancelled(x.id, x.text.slice(0, 40));
      },
    },
    {
      name: "hands",
      description: T.hands.description,
      shape: { action: z.enum(["send", "show", "ls", "stop"]), name: z.string().optional(), text: z.string().optional(), model: z.enum(["opus", "sonnet", "haiku", "default"]).optional() },
      handler: async (a) => {
        const args = [String(a.action)];
        if (a.name) args.push(String(a.name));
        if (a.action === "send") {
          if (!a.name || !a.text) return T.hands.sendNeeds;
          args.push(String(a.text));
          if (a.model) args.push("--model", String(a.model));
        }
        // the notes for the task are added by cc.py (hh learn helper), which says in its output which pages it added
        return summarize(await moduleScript(ctx, "helpers", "cc.py", args, { timeoutMs: 120_000 }));
      },
    },
    {
      name: "recall",
      description: T.recall.description,
      shape: { args: z.array(z.string()) },
      handler: async (a) => {
        const args = a.args as string[];
        const local = ctx.recallLocal(args);
        if (ctx.recallQuotes && (args[0] === "search" || args[0] === "day")) {
          // 中央记忆只从 10-26 起；更早的、别处导入的原话在原话库里，两边一起给（10-31：只看中央记忆，她以为主人的原话不存在）
          const i = args.indexOf("--who");
          const who = i >= 0 ? args[i + 1] : undefined;
          const more = args[0] === "day"
            ? ctx.recallQuotesDay?.(String(args[1] ?? ""), who) ?? ""
            : await ctx.recallQuotes(String(args[1] ?? ""), who, ...(local ? [{ olderOnly: true }] : []));
          if (local && more) return T.recall.withMore(local, more);
          return local || more || (args[0] === "day" ? T.recall.dayNone : T.recall.searchNone);
        }
        if (local) return local;
        if (ctx.recallQuotes) return T.recall.none;
        const r = await moduleScript(ctx, "night", "recall.py", args);
        return r.code === 0 ? summarize(r) : T.recall.honchoDown(summarize(r, 200));
      },
    },
    {
      name: "what_do_i_know",
      description: T.what_do_i_know.description,
      shape: { topic: z.string(), category: z.string().optional().describe(T.what_do_i_know.params.category) },
      handler: async (a) => ctx.askNotes ? ctx.askNotes(String(a.topic), a.category ? String(a.category) : undefined) : T.what_do_i_know.none,
    },
    {
      name: "what_reaches_me",
      description: T.what_reaches_me.description,
      shape: {
        action: z.enum(["list", "add", "edit", "remove", "move", "try"]),
        rule: z.record(z.string(), z.unknown()).optional().describe(T.what_reaches_me.params.rule),
        id: z.string().optional().describe(T.what_reaches_me.params.id),
        to: z.number().int().min(0).optional().describe(T.what_reaches_me.params.to),
        days: z.number().int().min(1).max(30).optional().describe(T.what_reaches_me.params.days),
      },
      handler: async (a) => whatReachesMe(ctx, a),
    },
    {
      name: "people_i_know",
      description: T.people_i_know.description,
      shape: {
        action: z.enum(["list", "add", "update", "remove"]),
        key: z.string().optional().describe(T.people_i_know.params.key),
        entry: z.record(z.string(), z.unknown()).optional().describe(T.people_i_know.params.entry(CARD_DIR)),
      },
      handler: async (a) => peopleIKnow(ctx, a),
    },
    stickerTool(ctx),
    browserTool(ctx),
  ];
  // no channel, nothing goes out: no message tool, and no sticker tool when none of the channels takes stickers
  return all.filter((t) => allowed.includes(t.name) && (t.name !== "message" || channels.length > 0) && (t.name !== "sticker" || stickerChannels(ctx).length > 0));
}
