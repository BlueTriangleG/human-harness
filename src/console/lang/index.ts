// 控制台的界面文字：给看的人读的，按看的人选语言（页面上切，记在 cookie 里），一个请求一个语言。
// 和 src/lang/ 不是一回事：那边是角色读的字，一个进程一个语言。
// 包是纯数据：一条就是一句字，要填的地方写 {名字}，英文的单复数写 {n|单数|复数}（n 是 1 取前一个）。不放逻辑。
// 不进包的：她的数据（事件、原话、笔记、人物卡内容）和库里记下的原因，界面上原样显示。
import { AsyncLocalStorage } from "node:async_hooks";
import { zh } from "./zh.ts";
import { en } from "./en.ts";
import type { ConsolePack } from "./zh.ts";
import { langCode } from "../../lang/index.ts";

export const LANGS = ["zh", "en"] as const;
export type Lang = (typeof LANGS)[number];
const PACKS: Readonly<Record<Lang, ConsolePack>> = { zh, en };
/** 写进 <html lang> 的 */
export const LANG_TAG: Readonly<Record<Lang, string>> = { zh: "zh-CN", en: "en" };

/** What a viewer who has not picked a language sees when the server names none: the language this process speaks (main.ts
 * chooses the role's pack), or English when the console has no page in it */
export function defaultLang(): Lang { const c = langCode(); return isLang(c) ? c : "en"; }

export function isLang(v: unknown): v is Lang { return typeof v === "string" && (LANGS as readonly string[]).includes(v); }

export const LANG_COOKIE = "hh_console_lang";
/** 请求的 cookie 里选的语言；没有或不认识就是 null */
export function langFromCookie(cookie: string | undefined): Lang | null {
  for (const part of (cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === LANG_COOKIE) {
      const v = part.slice(i + 1).trim();
      return isLang(v) ? v : null;
    }
  }
  return null;
}

type Leaves<T, P extends string = ""> = { [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`> }[keyof T & string];
/** 包里每一条的名字：「页.组.条」 */
export type Key = Leaves<ConsolePack>;
export type Params = Readonly<Record<string, string | number>>;

const SLOT = /\{(\w+)(?:\|([^|{}]*)\|([^{}]*))?\}/g;
/** 一条字里出现的参数名（{名字} 和 {n|…|…} 都算） */
export function paramsOf(text: string): string[] {
  return [...new Set([...text.matchAll(SLOT)].map((m) => m[1]!))].sort();
}

/** 把一条字里的 {名字} 和 {n|单数|复数} 填上。没给的参数原样留着：看得见，不悄悄变空。web/js/i18n.js 里有同一个写法 */
export function fill(text: string, params: Params): string {
  return text.replace(SLOT, (whole: string, name: string, one?: string, other?: string) => {
    const v = params[name];
    if (v === undefined) return whole;
    return one === undefined ? String(v) : Number(v) === 1 ? one : other ?? "";
  });
}

const flats = new Map<Lang, Readonly<Record<string, string>>>();
/** 一个语言的包摊平成 { "页.组.条": "字" }，页面拿的就是这个 */
export function flatPack(lang: Lang): Readonly<Record<string, string>> {
  let f = flats.get(lang);
  if (!f) {
    const out: Record<string, string> = {};
    const walk = (o: object, prefix: string): void => {
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === "string") out[prefix + k] = v;
        else walk(v as object, prefix + k + ".");
      }
    };
    walk(PACKS[lang], "");
    flats.set(lang, f = out);
  }
  return f;
}

export type Translate = (key: Key, params?: Params) => string;
/** 某个语言的取字函数。base 是每条都能用的参数（角色和主人叫什么） */
export function translator(lang: Lang, base: Params = {}): Translate {
  const flat = flatPack(lang);
  return (key, params) => fill(flat[key] ?? key, params ? { ...base, ...params } : base);
}

const current = new AsyncLocalStorage<Translate>();
/** 在一个请求里跑 fn：这期间 say() 用这个请求的语言（之后排的回调、定时器也算在内） */
export function withLang<R>(t: Translate, fn: () => R): R { return current.run(t, fn); }
/** 取字，用当前请求的语言。取数的模块（memory.ts、prompt.ts……）放进数据里的标签用它；不在请求里（测试、命令行）就是默认语言 */
export const say: Translate = (key, params) => (current.getStore() ?? translator(defaultLang()))(key, params);

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * What the page scripts recognise of the role's own text. It is the role's side that writes these, so the entry point takes
 * each from the definition the writer uses (packtext.ts pageMarks) and the scripts carry no copy. One left out = not recognised.
 */
export interface PageMarks {
  /** how the record of a "think it over" opens: brain.js does not count such a record as thinking of its own */
  thinkItOver?: string;
  /** source of the regular expression matching the head of a "sent" record, before what was sent: sent.js takes it off */
  sentHead?: string;
  /** the tag wrapping a block of the role's memory in a message (<tag>…</tag>): prompt.js labels such messages */
  memoryTag?: string;
}

/**
 * 骨架里的 {{…}} 换成这个语言的字：
 *   {{页.组.条}}  包里的一条（转义过，能放在标签里和属性里）
 *   {{@lang}}     <html lang> 的值
 *   {{@data}}     给页面脚本的数据：{ lang, langs, base, strings, demo, now }，放在 <script type="application/json"> 里（demo = 这是演示数据，页面角上标出来；now 先是 null，服务端的钟是定死的时才在出页面的那一刻填上）
 * 骨架里写了包里没有的条目就报错（启动时每个语言各出一遍，写错了起不来，不等到页面上露出半截）。
 */
export function renderPage(template: string, lang: Lang, base: Params = {}, demo = false, regions: readonly string[] | null = null, more: { strings?: Readonly<Record<string, string>>; marks?: PageMarks } = {}): string {
  // more.strings: strings the instance supplies on top of the pack (display names of the role's own sources and channels)
  const flat = { ...flatPack(lang), ...more.strings };
  // regions：配置里开着哪几个脑区（大脑图照它画）；now 要留在最后（withClock 认数据块结尾的那一项）
  const data = JSON.stringify({ lang, langs: LANGS, base, strings: flat, demo, marks: more.marks ?? {}, regions, now: null }).replace(/</g, "\\u003c");
  return template.replace(/\{\{([@\w.]+)\}\}/g, (_whole: string, key: string) => {
    if (key === "@lang") return LANG_TAG[lang];
    if (key === "@data") return data;
    const text = flat[key];
    if (text === undefined) throw new Error(`控制台骨架里的 {{${key}}} 在 ${lang} 包里没有`);
    return escapeHtml(fill(text, base));
  });
}

/** 出好的页面里把钟填上（数据块最后那个 "now":null）：服务端的钟不是真的现在时（演示库），页面要照它走 */
export function withClock(page: string, now: number): string {
  const mark = '"now":null}';
  const i = page.lastIndexOf(mark);
  return i < 0 ? page : `${page.slice(0, i)}"now":${Math.round(now)}}${page.slice(i + mark.length)}`;
}
