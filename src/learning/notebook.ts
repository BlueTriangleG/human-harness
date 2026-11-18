// 笔记本的页格式和书架扫描：skills/<大类>/<本>/<页>.md，<本>/SKILL.md 是这本的封面和目录。
// 归档/ 下的都算归档：本里的 归档/，也可以是大类那层（<大类>/归档/…）或书架那层（归档/…）的，整本挪进去也行；
// 归档的页照样扫（编号还认得），但不进联想，归档里的本也不上书架目录。
// 只读不写（发编号是 ids.ts 的事）。她手写的页难免不全，所以解析永远不抛：缺的字段是空串，文件读不了进 problems。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { B, L } from "../lang/index.ts";

export interface Lesson {
  /** 行尾 <!-- l:… --> 里的编号；第一个是它自己的，后面是并进来的旧编号；没有编号时为空 */
  ids: string[];
  /** 在页文件里的行号，从 1 数 */
  line: number;
  text: string;
  when: string;
  next: string;
  days: string[];
  sources: number[];
  /** 「怎样算做到」（夜里把关写的新教训带这一段）；没有就不带 */
  done?: string;
  /** 「强度」0–5（夜里按又犯升降，她审过写上）；没写就没有，按 3 算 */
  strength?: number;
  /**
   * 「提醒：动手时」：这条讲的是一个具体动作（提交、发评论、生图、给帮手插话……），只在看得出她这一步就要做的时候才提醒。
   * 11-04 标了一天的强联想：这类教训一沾边就被判「用得上」，占了噪音的四分之三；联想时多问一句「这一步就要做吗」把它们筛掉
   */
  step?: true;
  /**
   * 「提醒：发之前」：这条老毛病会出在发给主人的话里（没核过就说过了、看完了，钟点数字没核就写）。发给主人之前那道核对只拿这种强教训拦
   * （11-05：没标的强教训一律能拦，两天拦了 21 次，20 次她原样重发）。和「动手时」可以一起写：「提醒：动手时、发之前」
   */
  send?: true;
}

/**
 * The numbers of the pages HH does not write into — files that lie off the shelf and are linked onto it, like a module's
 * manuals in the HH code, which every role on the machine shares: shelf path → number, kept by ids.ts in the shelf's root
 */
export const KEPT_IDS = ".page-ids.json";

export interface Page {
  /** 标题行 <!-- p:… --> 里的编号，规则同 Lesson.ids（书架外的页用 KEPT_IDS 里记的那个） */
  ids: string[];
  /** 相对书架根目录，如 通用/验收/看成片.md */
  rel: string;
  category: string;
  book: string;
  title: string;
  brief: string;
  when: string;
  archived: boolean;
  general: boolean;
  lessons: Lesson[];
  /** ## 做法 里 ### 待验证 下的条数 */
  pending: number;
}

export interface Book {
  category: string;
  book: string;
  description: string;
  /** 没归档的页数 */
  pages: number;
}

export interface Shelf {
  pages: Page[];
  books: Book[];
  problems: string[];
}

export const PAGE_ID = /<!-- (p:\d{4,}(?:\s+p:\d{4,})*) -->/;
export const LESSON_ID = /<!-- (l:\d{4,}(?:\s+l:\d{4,})*) -->/;

/** 不是页的文件名 */
const NOT_PAGES = new Set(["SKILL.md", "CHANGELOG.md"]);
/** 归档下面最多往下翻几层，防链接成环 */
const ARCHIVE_DEPTH = 5;

/** 取出所有编号（不带 p:/l: 前缀），保持出现顺序 */
function idsOf(re: RegExp, text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(new RegExp(re.source, "g"))) {
    for (const part of m[1]!.split(/\s+/)) out.push(part.slice(2));
  }
  return out;
}

const stripIds = (re: RegExp, text: string): string => text.replace(new RegExp(re.source, "g"), "").trim();

/** 正则里有特殊意思的字符转义（拿名字拼正则用） */
export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 字段前缀后面的值；冒号全角半角都认 */
function after(line: string, label: string): string | null {
  const m = new RegExp(`^${label}[：:]\\s*(.*)$`).exec(line);
  return m ? m[1]!.trim() : null;
}

// The page format (docs/contracts/notebook.md): the labels and marks the parser matches are the role's language's, B.forms.page
/**
 * The regular expressions that are put together from the page format's words. Under the reference pack each has the
 * source of the literal the code used to have (test/lang-forms.test.ts pins them)
 */
export const pageRe = {
  /** A lesson: a list item that opens with the label of the lesson field */
  lessonLine: (): RegExp => new RegExp(`^[-*]\\s+${B.forms.page.lesson.text}[：:]`),
  /** The label a lesson's text opens with, and the same with the space after it */
  lessonLabel: (): RegExp => new RegExp(`^${B.forms.page.lesson.text}[：:]`),
  lessonLabelGap: (): RegExp => new RegExp(`^${B.forms.page.lesson.text}[：:]\\s*`),
  /** Where the body of a lesson ends: the next field, or the label of what to do next time */
  lessonBodyEnd: (): RegExp => new RegExp(`${escapeRe(B.forms.page.sep.trim())}|${B.forms.page.lesson.next}[：:]`),
  /** The heading of the practices section (it may carry a note in brackets), and of its subsection of practices not yet verified */
  practiceHeading: (): RegExp => new RegExp(`^##\\s*${B.forms.page.practice}\\s*(?:[（(][^）)]*[）)])?\\s*$`),
  pendingHeading: (): RegExp => new RegExp(`^###\\s*${B.forms.page.pending}`),
};

/**
 * The marks parsePage goes by, as data (hh learn format): a script outside HH that has to recognise ids in a page
 * reads them from here instead of keeping its own copy. Regexes are given as their source.
 */
export const pageFormat = (archiveDir: string) => ({
  pageId: PAGE_ID.source, lessonId: LESSON_ID.source, lessonLine: pageRe.lessonLine().source,
  lessonSection: B.forms.page.lessons, notPages: [...NOT_PAGES], archiveDir,
});
/**
 * The fields of a lesson line are B.forms.page.lesson. how and done are written by the night's check (its questions are
 * when to use → how → how to confirm it is done): how is the same as next.
 * The remind field takes only the two values B.forms.page.remindStep and remindSend, several joined by a comma;
 * anything else written there is body text and goes back into the field before it
 */
type LessonField = keyof typeof B.forms.page.lesson;
const remindParts = (v: string): string[] | null => {
  const parts = v.split(/[、，,]/).map((x) => x.trim());
  return parts.every((x) => B.forms.page.remindStep.test(x) || B.forms.page.remindSend.test(x)) ? parts : null;
};

/** 去掉括号里的字（全角半角都算，套着的、没关上的也去掉）：说明里提到的别的日期不能算成犯的日子 */
function outsideParens(s: string): string {
  let depth = 0;
  let out = "";
  for (const ch of s) {
    if (ch === "（" || ch === "(") depth += 1;
    else if (ch === "）" || ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** 一行教训：去掉编号注释，按 ｜ 切开，按前缀认字段；没有前缀的片段是上一个字段里自己带的 ｜，并回去 */
function parseLesson(raw: string, line: number): Lesson {
  const body = stripIds(LESSON_ID, raw).replace(/^[-*]\s+/, "");
  const page = B.forms.page;
  const labels = Object.entries(page.lesson) as Array<[LessonField, string]>;
  const f: Partial<Record<LessonField, string>> = {};
  let cur: LessonField | "" = "";
  // 「提醒」认出来的那一刻就记下是哪几种：写了两段「提醒：」、后面跟着别的字的，都不会把前面认出的丢掉
  let step = false;
  let send = false;
  for (const seg of body.split(page.sep.trim())) {
    const s = seg.trim();
    const hit = labels.find(([k, l]) => after(s, l) !== null && (k !== "remind" || remindParts(after(s, l)!) !== null));
    if (hit) {
      cur = hit[0];
      const v = after(s, hit[1])!;
      f[cur] = v;
      if (cur === "remind") for (const x of remindParts(v)!) { if (page.remindStep.test(x)) step = true; if (page.remindSend.test(x)) send = true; }
    } else if (cur) {
      f[cur] += `${page.sep}${s}`;
    }
  }
  return {
    ids: idsOf(LESSON_ID, raw),
    line,
    text: f.text ?? "",
    when: f.when ?? "",
    // 两个都写了：都留着（以前「怎么做」那段是并在下次里的）
    next: f.next !== undefined && f.how !== undefined ? `${f.next}${page.sep}${page.lesson.how}${page.colon}${f.how}` : f.next ?? f.how ?? "",
    // 日期后面常带一句括号里的说明（「2026-11-04（样本文件凭感觉写了钟点）」，说明里还有逗号）：先去掉括号里的，日期开头的只留日期。
    // 以前整串当日子，带说明的那几天认不出来，11-04 起最要紧的几条教训的又犯都没记上
    days: outsideParens(f.days ?? "").split(/[、，,]/).map((d) => d.trim()).filter(Boolean)
      .map((d) => /^\d{4}-\d{2}-\d{2}/.exec(d)?.[0] ?? d),
    sources: [...(f.sources ?? "").matchAll(/#(\d+)/g)].map((m) => Number(m[1])),
    ...(f.done ? { done: f.done } : {}),
    ...strengthOf(f.strength),
    ...(step ? { step: true as const } : {}),
    ...(send ? { send: true as const } : {}),
  };
}

/** 「强度：4」「强度：4（11-03 升）」「强度：４」都认；两位数、别的不认（按 3 算） */
function strengthOf(raw: string | undefined): { strength?: number } {
  const s = (raw ?? "").trim().replace(/[０-５]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0));
  const m = /^([0-5])(?!\d)/.exec(s);
  return m ? { strength: Number(m[1]) } : {};
}

export const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+\S/;

/** archiveDir：归档目录的名字（配置 learning.archiveDir）；路径上哪一层目录叫这个名字，这页就算归档 */
export function parsePage(text: string, rel: string, generalCategory: string, archiveDir: string): Page {
  const parts = rel.split("/");
  const category = parts[0] ?? "";
  const book = parts.length >= 3 ? parts[1]! : "";
  const file = (parts[parts.length - 1] ?? "").replace(/\.md$/, "");

  let title: string | null = null;
  let ids: string[] = [];
  let brief: string | null = null;
  let when: string | null = null;
  const lessons: Lesson[] = [];
  const pendingIndents: number[] = [];

  let section = "";
  let sub = "";
  let fence = false;
  const fmt = B.forms.page;
  const isLesson = pageRe.lessonLine();
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 代码块里的 ## 和 - 教训： 都不算
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;

    if (line.startsWith("## ")) { section = line.slice(3).trim(); sub = ""; continue; }
    if (line.startsWith("### ")) { sub = line.slice(4).trim(); continue; }

    if (section === "") {
      // 开头三行：标题（带编号）、简介、什么时候翻
      if (title === null && line.startsWith("# ")) {
        ids = idsOf(PAGE_ID, line);
        title = stripIds(PAGE_ID, line.slice(2));
      } else {
        brief ??= after(line, fmt.brief);
        when ??= after(line, fmt.when);
      }
    } else if (section === fmt.practice && sub === fmt.pending) {
      const m = LIST_ITEM.exec(line);
      if (m) pendingIndents.push(m[1]!.length);
    } else if (section === fmt.lessons && isLesson.test(line)) {
      lessons.push(parseLesson(line, i + 1));
    }
  }

  // 条目里的子条目（缩进更深）是这一条的细节，只数最外一层
  const outer = Math.min(...pendingIndents);
  return {
    ids,
    rel,
    category,
    book,
    title: title || file,
    brief: brief ?? "",
    when: when ?? "",
    // 路径上任何一层目录是归档目录都算（本里的、大类那层的、书架那层的）
    archived: parts.slice(0, -1).includes(archiveDir),
    general: category === generalCategory,
    lessons,
    pending: pendingIndents.filter((n) => n === outer).length,
  };
}

/** 一条做法最多给这么多字；短于 PRACTICE_LABEL 个字的条目多半只是个小标题，用下一层的「怎么做」补上 */
const PRACTICE_CHARS = 120;
const PRACTICE_LABEL = 20;
const TOP_ITEM = /^(?:[-*+]\s+|\d+(?:[.)]\s+|[、）]\s*))(.*)$/;
const SUB_ITEM = /^\s+(?:[-*+]\s+|\d+(?:[.)]\s+|[、）]\s*))(.*)$/;

/**
 * 条目里的出处：编号注释去掉；带钟点、整日期，或者只有日期的括号去掉，省出字给做法本身（挂教训时也这样缩）。
 * keep：她的规矩文件里点名的记号（layers.ts 的 importantMarks）；括号里带着哪个记号，就只留下那个记号（按 keep 的顺序，先对上的算）
 */
export function cleanPractice(s: string, keep: readonly string[] = []): string {
  return s.replace(/<!--.*?-->/g, "").replace(B.forms.page.paren, (paren) => {
    const inner = paren.slice(1, -1);
    const mark = keep.find((m) => inner.includes(m));
    if (mark !== undefined) return L.notebook.keptMark(mark);
    const dated = /\d{1,2}:\d{2}|\d{4}-\d{1,2}-\d{1,2}/.test(inner) || !inner.replace(B.forms.page.datesOnly, "");
    return dated ? "" : paren;
  }).trim();
}

/**
 * 一页「## 做法」里前 n 条顶层的条目（列表或编号；开始做一件事时直接贴给她，让做法在下决定那一刻就在眼前）：
 * 下一层的细节不给，只是个小标题的用下一层的「怎么做」（没有就用下一层第一行）补上；出处缩短；太长的截到 PRACTICE_CHARS 个字。
 * 「### 待验证」以下的不给，除非这一页的做法全在待验证里（那就给，前面标「（待验证）」）
 */
export function practiceHead(text: string, n = 3, keep: readonly string[] = []): string[] {
  type Item = { text: string; kids: string[] };
  const sure: Item[] = [];
  const pending: Item[] = [];
  let inPractice = false;
  let inPending = false;
  let cur: Item | null = null;
  let fence = false;
  const fmt = B.forms.page;
  const practiceHeading = pageRe.practiceHeading();
  const pendingHeading = pageRe.pendingHeading();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }   // 代码块里的 # 和 - 不是标题、条目
    if (fence) continue;
    if (/^##\s/.test(line)) { inPractice = practiceHeading.test(line); inPending = false; cur = null; continue; }
    if (!inPractice) continue;
    if (/^###\s/.test(line)) { inPending = pendingHeading.test(line); cur = null; continue; }
    const top = TOP_ITEM.exec(line);
    if (top) { cur = { text: top[1]!, kids: [] }; (inPending ? pending : sure).push(cur); continue; }
    const kid = SUB_ITEM.exec(line);
    if (kid && cur) cur.kids.push(kid[1]!);
  }
  const render = (it: Item): string => {
    let t = cleanPractice(it.text, keep);
    const core = t.replace(fmt.paren, "");
    if ([...core].length < PRACTICE_LABEL || /[：:]$/.test(t)) {
      const kids = it.kids.map((k) => cleanPractice(k, keep)).filter(Boolean);
      const how = kids.find((k) => fmt.howLead.test(k)) ?? kids[0];
      if (how) t = L.notebook.practiceWithHow(t.replace(/[：:]$/, ""), how.replace(fmt.howLead, ""));
    }
    // 只剩个出处、或只是个没补上内容的小标题（「**具体怎么做**：」下面没东西）：不算一条
    const bare = t.replace(fmt.paren, "").replace(/\*\*/g, "").trim();
    if (!bare || /[：:]$/.test(bare)) return "";
    return [...t].length > PRACTICE_CHARS ? `${[...t].slice(0, PRACTICE_CHARS).join("")}…` : t;
  };
  const items = (sure.length ? sure : pending).map(render).filter(Boolean).slice(0, n);
  return sure.length ? items : items.map((t) => L.notebook.unverifiedPractice(t));
}

/** 页里的一条：有编号的教训（id 是 l:编号），或做法的头几条（id 是 页号#第几条） */
export interface Item {
  id: string;
  pageId: string;
  kind: "lesson" | "practice";
  /** 这一条的原文（出处缩过）：教训按「教训｜什么时候｜下次｜怎样算做到」拼回一行 */
  text: string;
  /** 拿去算向量、问判断的那一句 */
  ask: string;
  /** 挂给她看的那一行：教训先说下次怎么做，括号里是上次的错 */
  line: string;
  /** 强度（教训写了的照写，没写和做法都算 3） */
  strength: number;
  /** 教训的「提醒：动手时」：联想时多问一句「这一步就要碰上『when』吗」，两句都过才算对得上（when 空的不问，照旧） */
  step?: { when: string };
  /** 教训的「提醒：发之前」：发给主人之前那道核对只拿这种强条目拦（见 Lesson.send） */
  send?: true;
  /** 强联想时挂的那一行：再带上犯过几次、最近哪天、主人的原话和页的路径 */
  loud: string;
}

/** 一页做法问几条 */
const ITEM_PRACTICE = 4;
/** 只说「何时」的那条讲的是什么时候翻（封面已经有了），不是怎么做：不当条目（11-03 重放：挂出来都是噪音） */
const clip = (s: string, n = PRACTICE_CHARS): string => ([...s].length > n ? `${[...s].slice(0, n).join("")}…` : s);


/** pageItems 要的那几样角色的东西：主人的名字、书架目录相对工作区的路径（给她看的页路径的前缀）、出处里要留下的记号 */
export interface ItemRole { owner: string; shelfDir: string; keep?: readonly string[] }

/** 一页拆成条目（教训没编号的不算；做法要页的原文，读不到就只有教训） */
export function pageItems(p: Page, text: string | null, role: ItemRole): Item[] {
  const pageId = p.ids[0];
  if (!pageId || p.archived) return [];
  const keep = role.keep ?? [];
  // 主人的原话：名字后面八个字以内跟着的那句「……」；没有名字就不认（不然随便哪句引号都对得上）
  const quoted = role.owner ? new RegExp(B.forms.page.ownerQuote(escapeRe(role.owner))) : null;
  const out: Item[] = [];
  for (const l of p.lessons) {
    if (!l.ids[0] || !l.text) continue;
    const [what, when, next, done] = [l.text, l.when, l.next, l.done ?? ""].map((s) => cleanPractice(s, keep));
    // 犯过几次、最近哪天、主人当时的原话（括号里的出处缩掉之前先取出来）：强联想时让她看到这是老毛病
    const days = [...new Set(l.days)].sort();
    const quote = quoted?.exec(l.text)?.[1];
    const why = [L.notebook.lastTime(what), days.length ? L.notebook.recurCount(days.length, days.at(-1)!.slice(5)) : "", quote ? L.ownerQuote(role.owner, quote) : ""].filter(Boolean).join(B.common.listSep);
    out.push({
      id: `l:${l.ids[0]}`, pageId, kind: "lesson",
      text: [L.notebook.lessonField(what), when && L.notebook.whenField(when), next && L.notebook.nextField(next), done && L.notebook.doneField(done)].filter(Boolean).join(B.forms.page.sep),
      ask: `${when ? L.notebook.askWhenPrefix(when) : ""}${what}${next ? L.notebook.askNextSuffix(next) : ""}`,
      line: clip(next ? L.notebook.lineNextWithLast(next, what) : L.notebook.lineLesson(what)),
      strength: l.strength ?? 3,
      ...(l.step && when ? { step: { when } } : {}),
      ...(l.send ? { send: true as const } : {}),
      loud: L.notebook.loudLine(next ? clip(next) : L.notebook.loudLesson(clip(what!)), why, role.shelfDir, p.rel),
    });
  }
  // 编号是它在做法里的位置（跳过的不挪后面的号）
  const practice = (text ? practiceHead(text, ITEM_PRACTICE * 2, keep) : []).map((t, i) => ({ t, n: i + 1 })).filter((x) => !B.forms.page.whenOnly.test(x.t));
  for (const { t, n } of practice.slice(0, ITEM_PRACTICE)) {
    out.push({ id: `${pageId}#${n}`, pageId, kind: "practice", text: t, ask: L.notebook.practiceAsk(p.title, t), line: t, strength: 3, loud: L.notebook.practiceLoudLine(t, role.shelfDir, p.rel) });
  }
  return out;
}

/** 联想只看这一句 */
export function coverText(p: Page): string {
  return L.notebook.coverText(p.book, p.title, p.brief, p.when);
}

/** SKILL.md 开头 --- 之间的 key: value（值可以带引号，或 > / | 后面缩进接着写），压成一行 */
function frontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const out: Record<string, string> = {};
  if (lines[0]?.trim() !== "---") return out;
  for (let i = 1; i < lines.length && lines[i]!.trim() !== "---"; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^[>|][+-]?$/.test(v)) v = "";
    // 后面缩进的行接着是这个值
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) v += ` ${lines[++i]!.trim()}`;
    v = v.trim();
    const q = /^(["'])(.*)\1$/.exec(v);
    out[m[1]!] = (q ? q[2]! : v).replace(/\s+/g, " ").trim();
  }
  return out;
}

type Kind = "dir" | "file" | null;
/** 跟着链接走；断了的链接、没权限的返回 null */
function kindOf(path: string): Kind {
  try {
    const st = statSync(path);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 120);

/**
 * 本里的页文件：直接放在本下面的 .md，加上 归档/ 下（任意深）的 .md；返回相对本的路径片段。
 * archiveName：归档目录的名字；archive：dir 本身就是一个 归档 目录（大类、书架那层的），所有子目录都往下走
 */
function pageFiles(bookDir: string, problems: string[], shown: string, archiveName: string, archive = false): string[][] {
  const out: string[][] = [];
  const walk = (dir: string, prefix: string[], depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (e) {
      problems.push(L.notebook.dirUnreadable([shown, ...prefix].join("/"), errText(e)));
      return;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      const kind = kindOf(full);
      if (kind === "dir") {
        // 本里别的子目录（脚本、素材）不是页；只有归档往下走
        if (archive || prefix.length > 0 || name === archiveName) {
          if (depth < ARCHIVE_DEPTH) walk(full, [...prefix, name], depth + 1);
        }
      } else if (name.endsWith(".md") && !NOT_PAGES.has(name)) {
        // kind 为 null（断链接）也先收下，读的时候再记 problems
        out.push([...prefix, name]);
      }
    }
  };
  walk(bookDir, [], 0);
  return out;
}

/** archiveDir：归档目录的名字（配置 learning.archiveDir，默认值在语言包里） */
export function scanShelf(root: string, generalCategory: string, archiveDir: string): Shelf {
  const pages: Page[] = [];
  const books: Book[] = [];
  const problems: string[] = [];

  let cats: string[];
  try {
    cats = readdirSync(root).sort();
  } catch (e) {
    return { pages, books, problems: [L.notebook.shelfUnreadable(root, errText(e))] };
  }

  /** 大类、书架那层的 归档/：里面（任意深）的 .md 都是归档的页，有没有封面都收（号要认得）；不算一本，不上书架目录 */
  const archivePages = (dir: string, base: string[]): void => {
    for (const segs of pageFiles(dir, problems, base.join("/"), archiveDir, true)) {
      const rel = [...base, ...segs].join("/");
      try {
        pages.push(parsePage(readFileSync(join(dir, ...segs), "utf8"), rel, generalCategory, archiveDir));
      } catch (e) {
        problems.push(L.notebook.archivedPageUnreadable(rel, errText(e)));
      }
    }
  };

  for (const category of cats) {
    if (category.startsWith(".")) continue;
    const catDir = join(root, category);
    if (kindOf(catDir) !== "dir") continue;
    if (category === archiveDir) { archivePages(catDir, [category]); continue; }
    // 直接带 SKILL.md 的是旧的一层手册（搬家期间还在），不是大类，里面的文件也不算页
    if (kindOf(join(catDir, "SKILL.md")) === "file") continue;

    let bookNames: string[];
    try {
      bookNames = readdirSync(catDir).sort();
    } catch (e) {
      problems.push(L.notebook.categoryUnreadable(category, errText(e)));
      continue;
    }
    for (const bookName of bookNames) {
      if (bookName.startsWith(".")) continue;
      const bookDir = join(catDir, bookName);
      if (kindOf(bookDir) !== "dir") continue;
      if (bookName === archiveDir) { archivePages(bookDir, [category, bookName]); continue; }

      const files = pageFiles(bookDir, problems, `${category}/${bookName}`, archiveDir);
      const coverPath = join(bookDir, "SKILL.md");
      let description: string | null = null;
      if (kindOf(coverPath) === "file") {
        try {
          description = frontmatter(readFileSync(coverPath, "utf8"))["description"] ?? "";
        } catch (e) {
          problems.push(L.notebook.skillFileUnreadable(category, bookName, errText(e)));
          description = "";
        }
      } else if (files.some((f) => f.length === 1)) {
        // 有页没封面：不算一本（书架目录列不出来），但别让她白写
        problems.push(L.notebook.bookWithoutSkill(category, bookName));
      }
      if (description === null) continue;

      let live = 0;
      for (const segs of files) {
        const rel = [category, bookName, ...segs].join("/");
        let text: string;
        try {
          text = readFileSync(join(bookDir, ...segs), "utf8");
        } catch (e) {
          problems.push(L.notebook.pageUnreadable(rel, errText(e)));
          continue;
        }
        const page = parsePage(text, rel, generalCategory, archiveDir);
        pages.push(page);
        if (!page.archived) live += 1;
      }
      books.push({ category, book: bookName, description, pages: live });
    }
  }

  let kept: Record<string, string> = {};
  try { kept = JSON.parse(readFileSync(join(root, KEPT_IDS), "utf8")) as Record<string, string>; } catch { /* no page off the shelf has a number yet */ }
  for (const p of pages) if (kept[p.rel]) p.ids = [kept[p.rel]!];
  problems.push(...pageProblems(pages));
  return { pages, books, problems };
}

/** 没归档的页：缺的字段、重复的编号（同一个号出现两次以上，不管在不在同一页）。归档的是被推翻的，不查 */
function pageProblems(pages: readonly Page[]): string[] {
  const out: string[] = [];
  const pageIds = new Map<string, string[]>();
  const lessonIds = new Map<string, string[]>();
  const note = (m: Map<string, string[]>, id: string, rel: string): void => {
    m.set(id, [...(m.get(id) ?? []), rel]);
  };

  for (const p of pages) {
    if (p.archived) continue;
    if (!p.brief) out.push(L.notebook.missingBrief(p.rel));
    if (!p.when) out.push(L.notebook.missingWhen(p.rel));
    for (const id of p.ids) note(pageIds, id, p.rel);
    for (const l of p.lessons) for (const id of l.ids) note(lessonIds, id, p.rel);
  }
  for (const [prefix, m] of [["p", pageIds], ["l", lessonIds]] as const) {
    for (const [id, rels] of m) {
      if (rels.length > 1) out.push(L.notebook.duplicateId(prefix, id, [...new Set(rels)].join(L.notebook.pathSeparator)));
    }
  }
  return out;
}
