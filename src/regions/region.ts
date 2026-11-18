// 一个运行中的脑区：包着一个内核会话（用到时才打开），带着"看到哪了"的游标。
// - wake：把游标之后别人的记录拼在触发消息前面一起送进去（C1：一条送，不用 shouldQuery:false）
// - afterTool：每次工具调用之后补一次这期间别人的新记录
// - 换班：关掉旧会话，下次用到时用新前缀重开，并带上"最近一段"
// - 主线不是换班开的新会话（hhd 重启、会话断了）：带上这一页到现在的经历，不然上次压缩以后的事要等下次翻页才回来
// - 只认当前会话的事件：换班后旧会话冒出来的尾巴一律丢掉；会话死了下次用到时自动重开
import type { RegionSpec } from "./specs.ts";
import type { KernelDriver, KernelSession, KernelEvent, SessionSpec, ToolDef, Priority, Usage, ForkResult, TurnTotal } from "../kernel/types.ts";
import type { CentralMemory, Entry, Labeler, SeqGap } from "../memory/central.ts";
import { renderMemory, unsentMark, visibleTo } from "../memory/central.ts";
import type { TimeMarks } from "../memory/central.ts";
import type { PromptFolds } from "../memory/folds.ts";
import { estimateTokens } from "../memory/tokens.ts";
import { outletDecision } from "../basal/claims.ts";
import type { Logger } from "../log.ts";
import { B } from "../lang/index.ts";

/** 会话当场开不起来（driver.open 抛错）：带上哪个区、原因 */
export class SessionOpenError extends Error {
  readonly region: string;
  readonly reason: string;
  constructor(region: string, reason: string) {
    super(`${region}: session would not open: ${reason}`);
    this.name = "SessionOpenError";
    this.region = region;
    this.reason = reason;
  }
}

export interface RegionDeps {
  driver: KernelDriver;
  central: CentralMemory;
  labeler: Labeler;
  /** syncThinkChars：主线眼前别人的「想」折成一行（只管主线；后台之间照原样） */
  render: { maxItemChars: number; timezone: string; syncThinkChars?: number; folds?: PromptFolds };
  model: string;
  /** 主模型被安全分类器拒了就改用它（#0045） */
  fallbackModel?: string;
  cwd: string;
  permissionMode: string;
  env?: Record<string, string>;
  claudeExecutable?: string | null;
  allowedTools?: string[];
  /** The kernel's own tools for a region whose spec does not name its own list (config kernel.builtinTools). Neither given: none of them. */
  builtinTools?: string[];
  mcpServers?: Record<string, unknown>;
  plugins?: string[];
  tools: ToolDef[];
  prefix: () => string;                 // 当前纪元前缀（打开会话时取）
  tailTokens: number;                   // 换班时带进来的"最近一段"
  /** 当前这一页（上次压缩以后）的全部记录：主线不是换班开新会话时整页带上（重启别把这一页忘了） */
  pageSoFar?: () => Entry[];
  /**
   * 夜里那一觉在中央记忆里占的那一截（睡着到醒来之间写进来的，#0054）：开场取「最近一段」时跳过它，带的是睡着以前的。
   * 给了 note（那一夜整理好了、或者最早那天推迟到了下一晚才给，说法不同）、真跳过了记录、又带到了睡着以前的话，就在那段经历前面放上这一句；整页带上的开场不放。
   * 没睡过夜里那一觉、不管这件事的会话不给。
   * wakePage：现在这一页就是那一夜整理好（或推迟了）以后开的醒来那一页、还没翻过页——整页带上的开场前面也接上睡前那段（#0054 漏洞：重启后整页那条路不跳过夜里，睡前那段就丢了）
   */
  sleptThrough?: () => (SeqGap & { note?: string; wakePage?: boolean }) | null;
  /** 整页带上时渲染后最多多少（估算 token），超了从最早的开始舍 */
  restartPageTokens?: number;
  /** 新会话的第一条消息送出去以后：这个会话的前缀和那条消息原样给它（醒来那一页的开场存档用） */
  opened?: (prefix: string, text: string) => void;
  now: () => number;
  /** Brain 加的额外拦截（比如夜里整理时海马只能写 sleep/）：返回理由就拦下 */
  guard?: (tool: string, input: unknown) => string | undefined;
  /** 每次工具调用之后，除了别人的新记录再补的一句（前台：有人在等你回、这一轮做太久了） */
  afterToolNote?: () => string | undefined;
  onEvent: (region: Region, ev: KernelEvent) => void;
  log: Logger;
}

const ZERO: Usage = { contextTokens: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

export class Region {
  readonly spec: RegionSpec;
  private readonly deps: RegionDeps;
  private session: KernelSession | null = null;
  /** 这个会话打开时用的前缀（会话的系统提示里 HH 拼的那一段） */
  private openedPrefix = "";
  private needsIntro = true;
  /** 下一个新会话是换班开的（翻页、做完一件事）：只带最近一段；否则（刚启动、会话断了）主线带整页 */
  private rotated = false;
  /** 这一次开场放在经历前面的那一句（introEntries 定；没有就是空的） */
  private introNote = "";
  private cursor = 0;
  /**
   * 现在这个会话从哪条记录开始带着（开场「最近一段」的第一条；没带经历就是开场那一刻之后）。
   * 比它早的、这一页里的记录不在这个会话里（翻页后只带最近一段、重启后只带一截）：分叉压缩时要另外补上（复核 #1）
   */
  coveredFrom = 1;
  /**
   * 开场带的最早一条（上一页的尾巴、睡着以前的那段都算）。一般就是 coveredFrom；醒来那一页整页带上、又从前面舍掉了一截时，
   * 接在前面的睡前那段比 coveredFrom 早，中间舍掉的那截不在会话里（分叉压缩照 coveredFrom 补，照它点明这一页从哪条算起）
   */
  openedFrom = 1;
  private readonly self: ReadonlySet<string>;
  private says: string[] = [];
  usage: Usage = ZERO;
  pendingRotate = false;
  generation = 0;                       // 换过几次班
  lastEventAt = 0;
  lastWakeAt = 0;
  /** 这一轮用了几次工具（turn-end 交出去以后清零）：后台连着空转就先放下 */
  toolsThisTurn = 0;
  /** 这一轮被打断过（SDK 打断后报 error_during_execution，和真出错分不出来，靠这个分） */
  interruptedThisTurn = false;
  /**
   * 这一轮送到她眼前的别人的记录（编号区间：游标从哪到哪；turn-end 报完就清）：开这一轮的那条消息带的（含新会话开场的经历）、工具调用之后钩子补的。
   * 排进内核等着的那几条带的不算（不知道哪一轮才轮到）（11-13 回两遍）
   */
  private inTurn: Array<[number, number]> = [];

  constructor(spec: RegionSpec, deps: RegionDeps) {
    this.spec = spec;
    this.deps = deps;
    this.self = new Set([spec.id]);
  }

  get id(): string { return this.spec.id; }
  get sessionId(): string | null { return this.session?.sessionId ?? null; }
  get open(): boolean { return this.session !== null && !this.session.dead; }
  get busy(): boolean { return this.open && (this.session?.busy ?? false); }

  /** 现在能不能从这个会话分叉（开着、有内核的会话 id、驱动支持） */
  get canFork(): boolean {
    const s = this.session;
    return !!s && !s.dead && typeof s.fork === "function" && !!s.sessionId;
  }

  /** 分叉问一次（翻页压缩）：不动游标、不回报事件、不算她的一轮；会话没开或驱动不支持就 null */
  async fork(text: string, timeoutMs: number): Promise<ForkResult | null> {
    const s = this.session;
    if (!s || s.dead || !s.fork) return null;
    return s.fork(text, { timeoutMs });
  }

  /**
   * 还没送进这个会话的别人的记录（渲染好的，不推进游标、不改时间标记）和到哪一条为止。
   * 翻页分叉压缩时跟压缩要求放在同一条消息里，这样分叉看到的就是到此刻为止的全部，切页点就是现在
   */
  pendingView(): { text: string; upTo: number } {
    const upTo = this.deps.central.lastSeq();
    const fresh = visibleTo(this.deps.central.since(this.cursor, this.self), this.id).filter((e) => e.seq <= upTo);
    const text = renderMemory(fresh, this.deps.labeler, { ...this.view(), marks: { ...this.marks }, brief: this.explained });
    return { text, upTo };
  }

  /** 按这个会话眼前的样子渲染几条记录（不推进游标、不改时间标记）：分叉压缩时补上会话开始以前的那段 */
  renderAsSeen(entries: Entry[]): string {
    return renderMemory(entries, this.deps.labeler, { ...this.view(), marks: { last: null }, brief: this.explained });
  }

  /** 中央记忆里看到哪一条为止了（游标；只读） */
  seenUpTo(): number { return this.cursor; }

  /** 这一轮最后说的那段话（不清空） */
  finalSay(): string { return this.says.at(-1) ?? ""; }

  /** 这一轮说过的话（取走后清空） */
  takeTurnText(): string {
    const t = this.says.join("\n\n").trim();
    this.says = [];
    return t;
  }

  /** 这个会话里上一次标的时间（隔半小时以上才再标） */
  private marks: TimeMarks = { last: null };

  /** 视角：下意识看压缩的；几个主意识之间想的、说的、动作原样，工具结果折成一行；其余全量 */
  private view(): { maxItemChars: number; timezone: string; mode: "full" | "sync" | "fold"; marks: TimeMarks; viewer: string; thinkChars?: number; folds?: PromptFolds } {
    const role = this.spec.role;
    const mode = role === "perception" || role === "deep" ? "fold" : role === "main" || role === "side" ? "sync" : "full";
    const { syncThinkChars, ...render } = this.deps.render;
    return { ...render, mode, marks: this.marks, viewer: this.id, ...(role === "main" && syncThinkChars ? { thinkChars: syncThinkChars } : {}) };
  }

  /** 把别人的新记录渲染出来，并推进游标。这个会话里记忆的抬头说明过一次以后，后面的只带一句短的 */
  delta(): string {
    const fresh = visibleTo(this.deps.central.since(this.cursor, this.self), this.id);
    this.cursor = this.deps.central.lastSeq();
    const text = renderMemory(fresh, this.deps.labeler, { ...this.view(), brief: this.explained });
    if (text) this.explained = true;
    return text;
  }
  /** 这个会话里 <记忆> 的抬头完整说明过了（开场或第一段增量） */
  private explained = false;

  /** 补进这一轮的别人的新记录（工具调用之后的钩子、开这一轮的那条消息）：记下补到了哪条 */
  private deltaInTurn(): string {
    const from = this.cursor;
    const text = this.delta();
    if (text) this.inTurn.push([from, this.cursor]);
    return text;
  }

  /**
   * 这条记录是不是这一轮里送到她眼前的（开这一轮的那条消息带的、工具调用之后钩子补的；这一轮还没报 turn-end）。
   * 都在这一轮某次调用的输入里：这一轮好好结束了，就是她看过了；被打断、出错的那一轮不算（调用方看 turn-end 的 ok）
   */
  shownThisTurn(seq: number): boolean {
    return this.inTurn.some(([from, to]) => seq > from && seq <= to);
  }

  private ensureOpen(): KernelSession {
    if (this.session && !this.session.dead) return this.session;
    if (this.session?.dead) this.deps.log.warn("session dead, reopening", { region: this.id });
    let opened: KernelSession | null = null;
    const spec: SessionSpec = {
      id: this.spec.id,
      model: this.deps.model,
      ...(this.deps.fallbackModel ? { fallbackModel: this.deps.fallbackModel } : {}),
      log: (msg, fields) => this.deps.log.info(msg, { region: this.id, ...fields }),
      systemAppend: this.deps.prefix(),
      cwd: this.deps.cwd,
      permissionMode: this.deps.permissionMode,
      tools: this.deps.tools,
      env: this.deps.env,
      claudeExecutable: this.deps.claudeExecutable,
      allowedTools: this.deps.allowedTools,
      ...(this.spec.external === false ? {} : { mcpServers: this.deps.mcpServers, plugins: this.deps.plugins }),
      builtinTools: [...(this.spec.builtinTools ?? this.deps.builtinTools ?? [])],
      hooks: {
        afterTool: () => [this.deltaInTurn(), this.deps.afterToolNote?.()].filter(Boolean).join("\n\n") || undefined,
        beforeTool: (tool, input) => outletDecision(this.spec, tool, input) ?? this.deps.guard?.(tool, input),
      },
      onEvent: (ev) => {
        if (opened !== this.session) return;   // 旧会话的事件：丢掉
        this.handle(ev);
      },
    };
    try {
      opened = this.deps.driver.open(spec);
    } catch (e) {
      // 开会话当场抛错（11-13：退路模型和主模型相同，SDK 校验不过）：认成 SessionOpenError，叫的地方据此告诉她、放下这一次
      const reason = e instanceof Error ? e.message : String(e);
      this.deps.log.error("session open failed", { region: this.id, error: reason.slice(0, 300) });
      throw new SessionOpenError(this.id, reason);
    }
    this.session = opened;
    this.inTurn = [];
    this.openedPrefix = spec.systemAppend;
    this.needsIntro = true;
    this.explained = false;
    this.usage = ZERO;
    this.deps.log.info("open", { region: this.id, generation: this.generation });
    return opened;
  }

  /** 新会话的开场：角色说明 + 最近一段经历（换班时接得上） */
  private intro(withTail: boolean): string {
    this.cursor = this.deps.central.lastSeq();
    this.coveredFrom = this.openedFrom = this.cursor + 1;
    this.marks = { last: null };
    const rotated = this.rotated;
    this.rotated = false;
    if (!withTail) return this.spec.roleText;
    this.introNote = "";
    const recent = renderMemory(this.introEntries(rotated), this.deps.labeler, this.view());
    this.explained = !!recent;
    return [this.spec.roleText, recent ? B.region.recentExperienceIntro(this.introNote, recent) : ""].filter(Boolean).join("\n\n");
  }

  /**
   * 开场带哪些经历。换班开的、或者这一页还没「最近一段」长：最近一段（上一页在前缀的压缩块里）。
   * 主线刚启动或会话断了重开：这一页到现在的全部（只带最近一段的话，上次压缩以后、最近一段以前的事
   * 既不在眼前也还没压进前缀；11-02 量过，重启后只剩最近 7–73 分钟）。渲染后超过上限就从最早的开始舍。
   * 夜里整理好以后开的醒来那一页（还没翻过页）整页带上时，前面照样接上睡前那段，最多也是「最近一段」那么多（#0054 漏洞）。
   */
  private introEntries(rotated: boolean): Entry[] {
    const slept = this.deps.sleptThrough?.() ?? null;
    // 这一段是跳过夜里那一截、从睡着以前接过来的：前面说一句。只有「去睡觉了」那一条（编号 = after）不算带到了睡前；
    // 白天的开场够不到那么早，一字不变
    const noteBefore = (seen: Entry[]): void => {
      if (slept?.note && seen.some((e) => e.seq < slept.after) && this.deps.central.skips(slept)) this.introNote = `${slept.note}\n`;
    };
    const tail = (): Entry[] => {
      const raw = this.deps.central.tail(this.deps.tailTokens, slept ?? undefined);
      if (raw.length) this.coveredFrom = this.openedFrom = Math.min(...raw.map((e) => e.seq));
      const seen = visibleTo(raw, this.id);
      noteBefore(seen);
      return seen;
    };
    if (rotated || this.spec.role !== "main" || !this.deps.pageSoFar) return tail();
    const page = visibleTo(this.deps.pageSoFar(), this.id);
    if (page.reduce((n, e) => n + e.tokens, 0) <= this.deps.tailTokens) return tail();
    const kept = this.wholePage(page);
    if (!slept?.wakePage) return kept;
    const raw = this.deps.central.tail(this.deps.tailTokens, slept, slept.upTo);
    if (!raw.length) return kept;
    this.openedFrom = Math.min(...raw.map((e) => e.seq));
    const before = visibleTo(raw, this.id);
    noteBefore(before);
    return [...before, ...kept];
  }

  /** 整页带上（主线刚启动、会话断了重开）：渲染后超过上限就从最早的开始舍 */
  private wholePage(page: Entry[]): Entry[] {
    const cap = this.deps.restartPageTokens ?? 150_000;
    const size = (from: number): number => estimateTokens(renderMemory(page.slice(from), this.deps.labeler, { ...this.view(), marks: { last: null } }));
    if (size(0) <= cap) { if (page.length) this.coveredFrom = this.openedFrom = page[0]!.seq; return page; }
    let hi = page.length - 1;
    while (hi > 0 && unsentMark(page[hi]!)) hi -= 1;   // 至少留最后一条看得见的（标记行不单独显示）
    let lo = Math.min(1, hi);           // 找最早的、渲染后不超上限的起点
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (size(mid) <= cap) hi = mid; else lo = mid + 1;
    }
    this.deps.log.info("restart intro trimmed", { region: this.id, dropped: lo, kept: page.length - lo });
    this.coveredFrom = this.openedFrom = page[lo]!.seq;
    return page.slice(lo);
  }

  /**
   * 叫醒。raw=true：不带中央记忆增量和"最近一段"（调用方自己把要看的内容放进 text，比如翻页压缩的整页）。
   */
  /** 返回这条消息的编号（内核回报 answering 时对得上） */
  /** 先把会话开起来（还没开、或者断了）：开得起来给 null，开不起来给原因（不发任何话）。派活前用它，当场就能告诉她没交出去 */
  tryOpen(): string | null {
    try { this.ensureOpen(); return null; } catch (e) {
      if (e instanceof SessionOpenError) return e.reason;
      throw e;
    }
  }

  wake(text: string, opts: { priority?: Priority; human?: boolean; raw?: boolean } = {}): string {
    const s = this.ensureOpen();
    const parts: string[] = [];
    const first = this.needsIntro;
    if (this.needsIntro) {
      // 开场是空的（会话没给角色说明、也没有经历要带）：不留空的一段
      const intro = this.intro(!opts.raw);
      if (intro) parts.push(intro);
      if (!opts.raw) this.inTurn.push([this.openedFrom - 1, this.cursor]);   // 开场带的经历也是这一轮的输入
      this.needsIntro = false;
    } else if (opts.raw) {
      this.cursor = this.deps.central.lastSeq();
    } else {
      // 不忙：这条开一轮，带的记录算这一轮的；忙：排进内核等着，不知道哪一轮轮到，不算
      const d = s.busy ? this.delta() : this.deltaInTurn();
      if (d) parts.push(d);
    }
    parts.push(text);
    const wasBusy = s.busy;
    if (!wasBusy) this.says = [];
    this.lastWakeAt = this.deps.now();
    const message = parts.join("\n\n");
    const id = s.send(message, { priority: opts.priority ?? (wasBusy ? "next" : undefined), human: opts.human });
    if (first) this.deps.opened?.(this.openedPrefix, message);
    return id;
  }

  private handle(ev: KernelEvent): void {
    if (ev.type === "rate") { this.deps.onEvent(this, ev); return; }   // 额度读数不算她在活动
    this.lastEventAt = this.deps.now();
    if (ev.type === "say") this.says.push(ev.text);
    if (ev.type === "turn-end" && ev.ok) this.usage = ev.usage;
    if (ev.type === "act") this.toolsThisTurn += 1;
    this.deps.onEvent(this, ev);
    if (ev.type === "turn-end") { this.toolsThisTurn = 0; this.interruptedThisTurn = false; this.inTurn = []; }
  }

  async interrupt(): Promise<void> {
    if (this.busy) this.interruptedThisTurn = true;
    await this.session?.interrupt();
  }

  /** 内核这一轮还没报出去的用量（会话没开、驱动不支持给 null） */
  inFlight(): TurnTotal | null { return this.session?.inFlight?.() ?? null; }

  /** 换班：关掉旧会话；下次 wake 时用新前缀重开 */
  async rotate(): Promise<void> {
    const s = this.session;
    this.session = null;
    this.pendingRotate = false;
    this.needsIntro = true;
    this.rotated = true;
    this.generation += 1;
    this.usage = ZERO;
    this.says = [];
    this.inTurn = [];
    if (s) await s.close();
    this.deps.log.info("rotate", { region: this.id, generation: this.generation });
  }

  async close(): Promise<void> {
    const s = this.session;
    this.session = null;
    if (s) await s.close();
  }
}
