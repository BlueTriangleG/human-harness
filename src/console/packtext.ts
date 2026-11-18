// 认她那边的字。她读到、写下的话在语言包里（src/lang：M 是记忆层那一份，T 是工具回的话）；控制台有三处要认出这些话：
// 回想工具「没想起来」的回话、中期记忆那一段的标题、叫醒时附的「只给你看」。
// 这里从包里取同一句来比，不另抄一份：包里的字改了、换了语言，认的跟着变。
// M 和 T 是活绑定（进程启动时才按配置定语言），所以都是用的时候现取，不存在模块顶层。
// 包里哪一句的固定文字太少（几乎全是空），就不拿它来认：不然什么都认得上，页面上会整片标错。跳过时记一行 warn。
import { B, L, M, T, langCode } from "../lang/index.ts";
import type { PageMarks } from "./lang/index.ts";
import { defaultLang, isLang, translator } from "./lang/index.ts";

/** 填进包里那句话的空里的记号 */
const HOLE = "<<hole>>";
/** 一句话去掉空和空白以后，固定的字至少要有这么多才拿来认 */
const MIN_FIXED = 4;

/** 一段字原样放进正则 */
export const literal = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 包里一句带空的话 → 认这整句的正则。空里填的是编号、名字、时间段这类一行以内的值，所以空的地方只认不换行的字：
 * 不然一段很长的回话只要结尾碰巧是这句，就会被认上。lines 为真的那一句，空里是一段可能有好几行的话
 */
const shapeOf = (said: string, lines = false): RegExp => new RegExp("^" + said.split(HOLE).map(literal).join(lines ? "[\\s\\S]*" : "[^\\n]*") + "$");

/** 跳过的条目只报一次（按包、按条目） */
const warned = new Set<string>();
function skip(entry: string, left: string, warn: (line: string) => void): void {
  const key = `${langCode()} ${entry}`;
  if (warned.has(key)) return;
  warned.add(key);
  const code = langCode();
  warn(translator(isLang(code) ? code : defaultLang())("api.markTooShort", { lang: code, entry, left }));
}

/**
 * 回想工具「没想起来」时回的话，各一个正则：事件库那几种回想的十二句（M.recall、M.remember、M.recallPeriod）、翻中央记忆的一句（M.recallCentral），
 * 和翻原话的 recall 工具的四句（T.recall）。带空的一句要是固定的字不到 MIN_FIXED 个，跳过（没有空的一句是整句相等，不会多认）
 */
export function notFoundShapes(warn: (line: string) => void = console.warn): RegExp[] {
  const r = M.recall, t = T.recall;
  const said: ReadonlyArray<readonly [entry: string, text: string, lines?: boolean]> = [
    ["M.recall.noSuchEvent", r.noSuchEvent(HOLE)], ["M.recall.noQuote", r.noQuote(HOLE)], ["M.recall.noCentral", r.noCentral(HOLE)],
    ["M.recall.periodUnknown", r.periodUnknown(HOLE)], ["M.recall.periodEmpty", r.periodEmpty(HOLE)], ["M.recall.reverseNoEvent", r.reverseNoEvent(HOLE)],
    ["M.recall.reverseUnknown", r.reverseUnknown(HOLE)], ["M.recall.reverseNone", r.reverseNone(HOLE)],
    ["M.recall.personUnknown", r.personUnknown(HOLE)], ["M.recall.personNothing", r.personNothing(HOLE)],
    ["M.remember.nothing", M.remember.nothing(HOLE)], ["M.recallPeriod.badRange", M.recallPeriod.badRange(HOLE)],
    ["M.recallCentral.noSuch", M.recallCentral.noSuch(HOLE as unknown as number)],   // 这一句的空是个号码，照样放记号
    ["T.recall.dayNone", t.dayNone], ["T.recall.searchNone", t.searchNone], ["T.recall.none", t.none], ["T.recall.honchoDown", t.honchoDown(HOLE), true],   // 空里是一段摘要，可能好几行
  ];
  const out: RegExp[] = [];
  for (const [entry, text, lines] of said) {
    const fixed = text.split(HOLE).join("").replace(/\s/g, "");
    if (text.includes(HOLE) && fixed.length < MIN_FIXED) { skip(entry, fixed, warn); continue; }
    out.push(shapeOf(text, lines));
  }
  return out;
}

/** 中期记忆那一段开头的标题行；包里那一行要是空的、或者只有记号没有字（「#」「---」），没法拿来认，给 null */
export function midtermHead(warn: (line: string) => void = console.warn): string | null {
  const line = M.midterm.head.split("\n", 1)[0]!;
  if (/[\p{L}\p{N}]/u.test(line)) return line;
  skip("M.midterm.head", line, warn);
  return null;
}

/** How four parts of the prefix open: the first line of the entry buildPrefix (src/persona/persona.ts) writes for each */
export function prefixHeads(): { runtime: string; shelf: string; frame: string; compacted: string } {
  const first = (entry: string) => entry.split("\n", 1)[0]!;
  return { runtime: first(B.persona.runtimeNote), shelf: first(L.shelf.header), frame: first(B.persona.memoryFrame), compacted: first(B.persona.compactedMemoryHeading) };
}

/** What the page scripts recognise of the role's own text, each from the definition its writer uses */
export function pageMarks(): PageMarks {
  return { thinkItOver: B.brain.thinkItOverHead, sentHead: B.forms.sentHead.source, memoryTag: M.central.tag };
}

/** 「只给你看」那一段正文之前的开头；太短（或者包里那句正文在前、没有开头）就没法拿来认，给 null */
export function forYouHead(warn: (line: string) => void = console.warn): string | null {
  const head = M.situation.forYouOnly(HOLE).split(HOLE, 1)[0]!.trim();
  if (head.replace(/\s/g, "").length >= MIN_FIXED) return head;
  skip("M.situation.forYouOnly", head, warn);
  return null;
}
