// 情境：每次叫醒主线时附在消息后面的"只给你看"的一段（OpenClaw 时代 leak-guard 的 before_prompt_build 那一套，搬进 HH）。
// - 现在几点（照配置的时区、一天里的哪段）
// - 电脑负载（负载把关每分钟写的状态文件）、各模块的一段（目标进度这些）：变了或隔久了才给
// - when someone talks to her: event-memory association and the speaker's card (the brain identifies the speaker),
//   她这次聊天最近说过的话和答应过的事（别复读、别光说不做），账本在这次前缀之后的外部变动
// - 有人来消息、提醒、感官报上来的事、专注开始时：拿那件事的原话去联想笔记，挂上的页放在记忆联想后面；主人的话顺带判一下是不是在纠正她
// 附在叫醒消息里（不进前缀），不影响共享缓存。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.ts";
import { kvGet, kvSet, one, type Db } from "../store/db.ts";
import type { NoteAssociator } from "../learning/associate.ts";
import type { EventMemory } from "./events/memory.ts";
import { logAssociation } from "./events/assoc.ts";
import { B, M, P, dateLocale } from "../lang/index.ts";
import { withoutVolatile } from "../basal/situationLines.ts";
import type { Person } from "../persona/people.ts";
import { LAYOUT } from "../persona/layout.ts";

/** pending：最终回复正在一条条发、这条还在路上（#0051） */
/** batch：同一次发送（一段最终回复的几个气泡、message 的一次）；以前记的没有 */
export interface Said { text: string; at: number; pending?: boolean; batch?: string }

export interface SituationDeps {
  workspace: string;
  /** The load guard's status file (its patrol rewrites it every minute) */
  loadStatusFile: string;
  timezone: string;
  log: Logger;
  now: () => number;
  /**
   * Event-memory association, attached when someone talks to her and inject is on.
   * logDir：真附给她的联想每次记一行（hh mem assoc-stats 看她接住了多少）。
   */
  events?: { mem: EventMemory; inject: boolean; logDir?: string };
  /** 笔记联想：叫醒主线时和记忆联想同时算，挂上的笔记放在记忆联想后面；没有就不联想笔记 */
  notes?: NoteAssociator;
  /**
   * 主人的纠正：他的消息在同一次联想里多问一道"是不是在纠正她"，过 threshold 在 db 里记一行 learn_correction，
   * 挂在 currentTask（主线手上那件事）上；没有就不问
   */
  correction?: Correction;
  /** The on modules' situation hooks (src/modules/load.ts): each bounded and failing to "" on its own, shown after the goals */
  modules?: ReadonlyArray<{ name: string; run(): Promise<string> }>;
}

export interface Correction {
  db: Db;
  threshold: number;
  currentTask: () => { id: number; topic: string } | null;
}

export interface HumanContext {
  /** Who is speaking, as the brain's registry identifies the sender (People.identify); null = not in the registry */
  person: Person | null;
  text: string;
  /** 她这次聊天最近发给这个人的话（中央记忆里的 sent） */
  said: Said[];
  /** 这条消息在中央记忆里的编号（记纠正时按它去重）；不知道就不带 */
  seq?: number;
  /** 群聊里的消息：她回的话群里都看得到，说话人的卡只给公开的那一面（R27） */
  group?: boolean;
}

const BRIEF_EVERY_MS = 30 * 60_000;   // 负载、目标没变时，隔多久再给一次
const SAID_MS = 2 * 3600_000;
/** 联想对不上时带上她刚说的几句：最多几句、最多多少字（长了话题被冲淡） */
const CONTEXT_LINES = 3;
const CONTEXT_CHARS = 200;
/**
 * 说过要做之后，又对这个人说了这么长的正经话（不是表情包、本身也不是又一句「等我」）：多半已经兑现了，不再提醒「这次就兑现」
 * （11-12 00:18：「等我一下」后面「读完了…」整段已经发了，还被提醒兑现，她又整段发了一遍）
 */
const FOLLOW_UP_CHARS = 10;
/**
 * 同一段回复的几个气泡不算后来兑现（复核：「等我一下」「查到了第一时间告诉你」是一段）：都记着发送批次就按批次分；
 * 以前记的没有批次，按隔多久分（同一段的气泡隔一两秒发）
 */
const FOLLOW_UP_GAP_MS = 5_000;
const LEDGER = LAYOUT.snapshot;
/** 拿去联想笔记的话最多这么长（感官、帮手的回报可能很长：费 token，话题也被冲淡） */
const NOTE_TOPIC_MAX = 1000;
/** 那道纠正题的名字；问法在语言包里（M.situation.correctionQuestion） */
const CORRECTION_NAME = "correction";
/** 每次问到的纠正概率（没过门槛的也留），kv 里一个列表，留最近这么多条 */
const ASKED_KEY = "learn.correction.asked";
const ASKED_KEEP = 500;

export class Situation {
  private d: SituationDeps;
  private shown = new Map<string, { sig: string; at: number }>();
  private frozenLedger = new Set<string>();
  private shownLedger = new Set<string>();
  /** 这个前缀里联想给过的事件、片段、原话（换前缀清空） */
  private givenEvents = new Set<string>();
  /** 只算不挂时在后台算的笔记联想（settled 等它们） */
  private pending = new Set<Promise<unknown>>();

  constructor(d: SituationDeps) { this.d = d; }

  /** 情境在 Brain 外面建；Brain 拿到学习的那套时从这里接上笔记联想和纠正的记录 */
  attachNotes(notes: NoteAssociator, correction: Correction): void {
    this.d = { ...this.d, notes, correction };
  }

  /** 前缀刚重建（翻页、醒来）：账本以这一刻为准，之后的变动才算外部变动；联想去重重新算（笔记挂过的页也是） */
  prefixRebuilt(ledgerText: string): void {
    this.frozenLedger = new Set(factLines(ledgerText));
    this.shownLedger.clear();
    this.shown.clear();
    this.givenEvents.clear();
    this.d.notes?.prefixRebuilt("main");
  }

  /**
   * 主线开了新会话（换班、会话断了重开）：给旧会话的那些附带新会话没看到，重新给一遍
   * （负载、目标、档案、联想过的事、账本变动；review 11-02：翻页时主线正忙，叫醒落在旧会话、换班晚一轮，新会话就一直看不到）
   */
  newMainSession(): void {
    this.shown.clear();
    this.givenEvents.clear();
    this.shownLedger.clear();
  }

  timeLine(): string {
    const now = new Date(this.d.now());
    const hm = new Intl.DateTimeFormat(dateLocale(), { timeZone: this.d.timezone, hour: "numeric", minute: "2-digit", hour12: false, weekday: "long", month: "numeric", day: "numeric" }).format(now);
    const h = Number(new Intl.DateTimeFormat("en-AU", { timeZone: this.d.timezone, hour: "numeric", hour12: false }).format(now)) % 24;
    const part = h < 6 ? M.situation.dawn : h < 11 ? M.situation.morning : h < 13 ? M.situation.noon : h < 18 ? M.situation.afternoon : h < 23 ? M.situation.evening : M.situation.night;
    return M.situation.now(hm, part);
  }

  loadBrief(): string {
    try {
      const s = JSON.parse(readFileSync(this.d.loadStatusFile, "utf8")) as {
        t: number; level: string; avail_pct: number; comp_gb: number; swap_gb: number; mine_gb: number; phone_on: boolean;
        mine_top?: Array<[string, number]>; why?: string[]; last_action?: string;
      };
      if (this.d.now() / 1000 - s.t > 600) return M.situation.loadStale;
      const top = (s.mine_top ?? []).slice(0, 4).map(([n, g]) => `${n}${g}`).join(M.situation.loadTopSep);
      const level: Record<string, string> = M.situation.loadLevel;
      let t = M.situation.load(level[s.level] ?? s.level, s.avail_pct, s.comp_gb, s.swap_gb, s.mine_gb, top, s.phone_on);
      if (s.level !== "ok") t += M.situation.loadWhy(s.why ?? []);
      if (s.last_action && this.d.now() / 1000 - s.t < 3600) t += M.situation.loadLastAction(s.last_action);
      return t;
    } catch {
      return "";
    }
  }

  /** The on modules' situation parts together (the gate's small judge reads them as what she is doing) */
  async moduleParts(): Promise<string> {
    return (await Promise.all((this.d.modules ?? []).map((m) => m.run()))).filter(Boolean).join("\n");
  }

  /** 变了才给；没变的隔一阵（默认 30 分钟）再给一次。sig 是拿来比的样子（负载、目标去掉数字和「N 分钟前」，档案按原文） */
  private fresh(key: string, text: string, everyMs = BRIEF_EVERY_MS, sig = text): string {
    if (!text) return "";
    const prev = this.shown.get(key);
    if (prev && prev.sig === sig && this.d.now() - prev.at < everyMs) return "";
    this.shown.set(key, { sig, at: this.d.now() });
    return text;
  }

  /** 账本在这次前缀之后多出来的行（别处写的：帮手、定时任务、白天对账），每行只提一次 */
  ledgerChanges(): string {
    const p = join(this.d.workspace, LEDGER);
    if (!existsSync(p) || !this.frozenLedger.size) return "";
    let live: string;
    try { live = readFileSync(p, "utf8"); } catch { return ""; }
    const fresh = factLines(live).filter((l) => !this.frozenLedger.has(l) && !this.shownLedger.has(l));
    if (!fresh.length) return "";
    for (const l of fresh) this.shownLedger.add(l);
    const lines = fresh.slice(0, 15).map((l) => (l.length > 200 ? l.slice(0, 200) + M.situation.ledgerCut : l));
    return M.situation.ledgerChanges(lines, fresh.length, LEDGER);
  }

  /**
   * 说话的那个人的卡（不是主人时）。人物卡切过去了、事件库里有他的卡（存着字段或钉的原话，storedCard）：私聊给他自己看的那一面（他自己的私密在，别人的不在），
   * 群聊只给公开的那一面（她回的话群里都看得到，R27）；导出的文件里是存着的那些（访客的卡文件不带现算段，R35）。
   * 还没切（R34：迁移写了卡也一样，切的那一刻才换）、库里还没有（只有现算段的也算没有，他的近况联想里有）：照旧读档案里「设定、总结、原话」几段
   * （详情和维护规则不带），加上「我和他/她之间」那份（有的话）。换前缀后只附一次（私聊、群聊那一面各算各的），卡或档案改了再附。
   */
  personCard(h: HumanContext): string {
    const person = h.person;
    if (!person || person.privacy === "owner") return "";
    try {
      const mem = this.d.events?.mem;
      const stored = mem?.storedCard(person.key) ?? null;
      if (mem && stored) {
        const sections = mem.sectionsOf(stored.entity, h.group ? null : person.key);
        if (!sections.length) return "";
        const which = h.group ? M.situation.cardPublicOnly : M.situation.cardRemembered;
        const text = M.situation.card(person.name, which, stored.path, sections);
        return this.fresh(`card:${person.key}${h.group ? ":public" : ""}`, text, Number.POSITIVE_INFINITY);
      }
      if (!person.profile) return "";
      const parts: string[] = [];
      for (const rel of [person.profile, person.profile.replace(/\.md$/, "-us.md")]) {
        const p = join(this.d.workspace, rel);
        if (!existsSync(p)) continue;
        const card = cardOf(readFileSync(p, "utf8"));
        if (card) parts.push(M.situation.profilePart(rel, card));
      }
      if (!parts.length) return "";
      const text = M.situation.profile(person.name, parts);
      return this.fresh(`card:${person.key}`, text, Number.POSITIVE_INFINITY);
    } catch (e) {
      this.d.log.warn("person card failed", { error: String(e).slice(0, 200) });
      return "";
    }
  }

  /** Association from event memory when someone talks to her; nothing when memory.events.inject is off */
  async recall(h: HumanContext): Promise<string> {
    const ev = this.d.events;
    if (!ev?.inject) return "";
    const speaker = h.person?.name;
    const last = this.recentSaid(h);
    const found = await ev.mem.recall.associate(h.text, { ...(speaker ? { speaker } : {}), ...(last ? { context: last } : {}), exclude: this.givenEvents, region: "main" })
      .catch((e: unknown) => { this.d.log.warn("event association failed", { error: String(e).slice(0, 200) }); return { text: "", events: [] as string[], entries: [] as string[], ms: -1 }; });
    // 给过的事件、片段、原话都记下：片段和原话不再给，事件只在有新片段时用标题带过
    for (const id of [...found.events, ...found.entries]) this.givenEvents.add(id);
    if (ev.logDir && found.ms >= 0) {
      try {
        logAssociation(ev.logDir, { at: this.d.now(), region: "main", ...(speaker ? { speaker } : {}), cue: h.text, events: found.events, entries: found.entries, chars: found.text.length, ms: found.ms }, this.d.timezone);
      } catch (e) { this.d.log.warn("association log failed", { error: String(e).slice(0, 200) }); }
    }
    return found.text;
  }

  /**
   * 他这句话自己对不上时拿去一起联想的：她两小时内刚跟他说的最后三句（她常分几条发，点到事的那句不一定是最后一条；
   * 11-02 拿两天的真消息重放：事件、笔记都是带三句比只带最后一句对上的多一半），从后往前留 CONTEXT_CHARS 个字
   */
  private recentSaid(h: HumanContext): string | undefined {
    const recent = h.said.filter((m) => this.d.now() - m.at < SAID_MS).slice(-CONTEXT_LINES).map((m) => m.text).join(" ");
    return recent ? [...recent].slice(-CONTEXT_CHARS).join("") : undefined;   // 按字截，不把表情劈成半个
  }

  /**
   * 笔记联想（话题 = 那条消息，没人找她时是 cue；太长只取开头 NOTE_TOPIC_MAX 个字）。说话的是主人（registry 里 privacy=owner 的那位）时
   * 同一次请求里带纠正题，过门槛记一次；笔记是真挂给她看的（inject）时，后面接一句「回他的同一轮就记进页里」。
   * 联想出什么错都不挡叫醒：记 warn，当没想起笔记。
   * learning.enabled 关着时不问纠正题，也就不为它读 registry。
   * （11-02 试过把她刚跟他说的那句带进纠正题：放进题里两条原本判出来的掉到 0；放进话题里漏判的抓到两条，
   * 但引用回复的掉到 0、普通的接话也被当成纠正，先不带，等问到的概率攒够了再定。）
   */
  private async notesFor(topic: string | undefined, h?: HumanContext): Promise<string> {
    const notes = this.d.notes;
    if (!notes || !topic) return "";
    const correction = h && this.d.correction && notes.enabled && h.person?.privacy === "owner" ? this.d.correction : undefined;
    try {
      const context = h ? this.recentSaid(h) : undefined;
      const r = await notes.associate(topic.slice(0, NOTE_TOPIC_MAX), { region: "main", binding: "wake", ...(correction ? { extra: [{ name: CORRECTION_NAME, text: M.situation.correctionQuestion }] } : {}), ...(context ? { context } : {}) });
      const corrected = correction && h ? this.noteCorrection(correction, r.extra.get(CORRECTION_NAME), h) : false;
      return corrected && notes.injects ? [r.text, P.CORRECTED_WRITE_DOWN].filter(Boolean).join("\n") : r.text;
    } catch (e) {
      this.d.log.warn("note association failed", { error: String(e).slice(0, 200) });
      return "";
    }
  }

  /**
   * 纠正题的结果：问到的概率先留一笔（kv 里 ASKED_KEY，没过门槛的也留，看差一点的、调门槛用）；
   * 过门槛的再记一行 learn_correction，挂在主线手上那件事上。同一条消息（同一个编号）叫醒几次也只记一次。返回过没过门槛
   */
  private noteCorrection(c: Correction, p: number | undefined, h: HumanContext): boolean {
    if (p !== undefined) this.noteAsked(c.db, p, h);
    if (p === undefined || p < c.threshold) return false;
    try {
      if (h.seq !== undefined && one(c.db, "SELECT 1 AS x FROM learn_correction WHERE seq = ?", h.seq)) return true;
      const task = c.currentTask();
      c.db.prepare("INSERT INTO learn_correction (at, seq, topic, task_id, p) VALUES (?, ?, ?, ?, ?)")
        .run(this.d.now(), h.seq ?? null, task?.topic ?? null, task?.id ?? null, p);
    } catch (e) {
      this.d.log.warn("correction log failed", { error: String(e).slice(0, 200) });
    }
    return true;
  }

  private noteAsked(db: Db, p: number, h: HumanContext): void {
    try {
      const prev = JSON.parse(kvGet(db, ASKED_KEY) ?? "[]") as unknown;
      const list = Array.isArray(prev) ? (prev as Array<{ seq?: number | null }>) : [];
      if (h.seq !== undefined && list.some((x) => x.seq === h.seq)) return;
      kvSet(db, ASKED_KEY, JSON.stringify([...list, { at: this.d.now(), seq: h.seq ?? null, p }].slice(-ASKED_KEEP)));
    } catch (e) {
      this.d.log.warn("correction asked log failed", { error: String(e).slice(0, 200) });
    }
  }

  saidNote(said: Said[]): string {
    const recent = said.filter((m) => this.d.now() - m.at < SAID_MS);
    if (!recent.length) return "";
    const lines = recent.slice(-14).filter((m) => m.text.trim()).map((m) => ({ text: m.text.trim(), pending: m.pending === true }));
    const followedUp = (i: number): boolean => recent.slice(i + 1).some((m) => {
      const t = m.text.trim();
      const p = recent[i]!;
      const later = p.batch && m.batch ? m.batch !== p.batch : m.at - p.at >= FOLLOW_UP_GAP_MS;
      return later && t.length >= FOLLOW_UP_CHARS && !B.forms.stickerRecord.test(t) && !B.forms.promise.test(t);
    });
    const promises = recent.map((m, i) => ({ t: m.text, i })).slice(-6).filter((x) => B.forms.promise.test(x.t) && !followedUp(x.i)).map((x) => x.t);
    const quote = (l: { text: string; pending: boolean }) => M.situation.saidQuote(l.text.length > 80 ? l.text.slice(0, 80) + M.situation.saidCut : l.text, l.pending);
    let note = M.situation.said(lines.map(quote).join(""));
    // #0051：标着「正在发」的是上一轮的最终回复还在一条条发，已经在路上了；别当成没发出去再补
    if (lines.some((l) => l.pending)) note += M.situation.saidPendingNote;
    if (promises.length) note += M.situation.promises(promises.map((l) => M.situation.promiseQuote(l.slice(0, 80))).join(""));
    return note;
  }

  /**
   * 叫醒主线时附上的一段；human 有值 = 有人找她（加联想、说过的话、账本变动）。
   * cue：没人找她时拿来联想笔记的话（提醒、感官报上来的事、专注开始）；不给就不联想笔记。
   * 各模块的一段（目标这些）、记忆联想、笔记联想同时开始，哪样出错只少那一段。笔记只算不挂（inject 关）时结果给不了她，
   * 不等它：在后台算完照样记录、照样判纠正（settled 等它们）。
   */
  async forMain(human?: HumanContext, cue?: string): Promise<string> {
    const topic = human?.text ?? cue;
    const notes = this.d.notes && !this.d.notes.injects ? this.inBackground(this.notesFor(topic, human)) : this.notesFor(topic, human);
    const hooks = this.d.modules ?? [];
    const [hookTexts, memory, notesText] = await Promise.all([Promise.all(hooks.map((m) => m.run())), human ? this.recall(human) : "", notes]);
    const parts: string[] = [this.timeLine()];
    const load = this.loadBrief();
    parts.push(this.fresh("load", load, BRIEF_EVERY_MS, withoutVolatile(load)));
    hooks.forEach((m, i) => { const t = hookTexts[i] ?? ""; parts.push(this.fresh(`module:${m.name}`, t, BRIEF_EVERY_MS, withoutVolatile(t))); });
    parts.push(this.ledgerChanges());
    if (human) {
      parts.push(this.personCard(human));
      parts.push(memory, notesText);
      parts.push(this.saidNote(human.said));
    } else {
      parts.push(notesText);
    }
    const body = parts.filter(Boolean).join("\n");
    return M.situation.forYouOnly(body);
  }

  /** 后台跑一件（出错只记 warn），马上给空串 */
  private inBackground(p: Promise<string>): Promise<string> {
    const q: Promise<unknown> = p
      .catch((e: unknown) => { this.d.log.warn("note association failed", { error: String(e).slice(0, 200) }); })
      .finally(() => { this.pending.delete(q); });
    this.pending.add(q);
    return Promise.resolve("");
  }

  /** 后台还在算的笔记联想都算完（测试用；退出前也可以等一下） */
  async settled(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}

/** 档案里一直带着的部分：类型是设定、总结、原话的段（<!-- 类型：X --> 标记），不要详情和维护规则 */
export function cardOf(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let keep = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const h = /^(#{2,})\s+(.*)$/.exec(l);
    if (h) {
      const mark = /^<!-- 类型：(\S+) -->/.exec(lines[i + 1] ?? "")?.[1];
      if (mark) keep = ["设定", "总结", "原话"].includes(mark) && !/^维护规则/.test(h[2]!);
      if (keep) out.push(l);
      continue;
    }
    if (keep && !/^<!-- 类型：/.test(l)) out.push(l);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** 账本里算"事实"的行：列表项和表格行（标题、空行、注释不算） */
export function factLines(text: string): string[] {
  return text.split("\n").map((l) => l.trim()).filter((l) => /^(- |\* |\d+\. |\|)/.test(l) && l.length > 3);
}
