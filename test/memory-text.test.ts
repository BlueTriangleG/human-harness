// 记忆文字的钉子（Task 0）：test/memtext/calls.ts 的每条调用今天说的话，和 test/memory-text.pins.json 里存的指纹一个字节不差
// （每条两个指纹：回复本身、回复后面接的踪迹 / 文件——记忆层没有后者，rest 恒为空；文件开头的 env 记着钉的时候的 node / icu / zod 版本）；
// 再证明这张清单没有漏：COMPLETE 里每个文件，每一个带文字的行都被调用跑到、行上的每个分支都走到、起在这些行上的函数都被调用过。
// 以后把文字挪出 src/memory/，这两个测试不改：指纹对不上就是挪错了。COMPLETE 随各个分段（0a 到 0d、0h）加文件；events/memory.ts 分四段（0e 到 0h）才管全，所以 0h 才把它加进来。
// 逻辑都在 test/textpins/lib.ts（别的范围也用）；这里只有这一个范围的名字：文件、绑定、命令。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bindingReads, checkPins, markLeaves, markerOf, packLeaves, reach, runtimeImports, textLines } from "./textpins/lib.ts";
import type { Exempt } from "./textpins/lib.ts";
import { renderAll } from "./memtext/calls.ts";

const TREE = resolve(fileURLToPath(import.meta.url), "../..");
const PINS_FILE = join(TREE, "test/memory-text.pins.json");
const REPIN = "hh-fw node test/memtext/pin.ts > <a scratch file>, then move the scratch file to test/memory-text.pins.json (on the tree before the moves, in the pin commit)";
/** 覆盖检查在本进程里渲染整张清单的那个文件（相对树根；不叫 *.test.ts） */
const COVERAGE_RUN = "test/memtext/coverage.run.ts";
/** 文字读语言包用的绑定名（还不存在：挪之前的树上只有字面量算） */
const BINDINGS = ["M"] as const;
/** 文字已经挪进语言包的文件：「留下的字」那个测试只管它们（还没挪的文件里字都在，不归它管）。3b-1 的七个，加 3b-2 的 events/memory.ts */
const MOVED: readonly string[] = ["src/memory/central.ts", "src/memory/recall.ts", "src/memory/events/render.ts", "src/memory/events/midterm.ts", "src/memory/events/recall.ts", "src/memory/situation.ts", "src/memory/events/memory.ts"];
// (events/exam.ts was one of them; its words, like the owner's review answers of events/memory.ts, are brain.eventsOwner now)
/** 清单已经管全了的文件：明确列出，后面的分段往里加（记忆目录里还有这个范围之外的文件，所以不从目录读） */
const COMPLETE: readonly string[] = [...MOVED];
/** 清单够不着的文字行（按字面量文字、或按那一行的源码匹配，每条写 reason） */
const EXEMPT: readonly Exempt[] = [
  { file: "src/memory/events/memory.ts", code: 'cleared: !String(a.text ?? "").trim() });',
    reason: "the `?? \"\"` arm cannot be taken through the writer: mem_person_set's schema requires text (z.string()). The line is unchanged from before the move; it became a text line only because it now reads M.personSet.waitWhy" },
];
/** 挪完以后记忆的文字都在这个文件里：它存在时，整个文件的行、分支、函数都要跑到 */
const LANG_MEMORY = "src/lang/zh/memory.ts";

test("memory text: every call renders to the pins in test/memory-text.pins.json, reply and rest separately (a mismatch names the id and prints the text now; an environment mismatch is one line)", async () => {
  if (!existsSync(PINS_FILE)) {
    assert.fail(`test/memory-text.pins.json is missing — generate it: ${REPIN}`);
  }
  const pins: unknown = JSON.parse(readFileSync(PINS_FILE, "utf8"));
  const message = checkPins(pins, await renderAll(), { command: REPIN });
  if (message !== null) assert.fail(message);
});

test("memory text: the call list reaches every text line of the COMPLETE files, with every branch on that line taken and every function that starts on it called (V8 coverage)", () => {
  const problems = reach({
    tree: TREE, files: COMPLETE, exempt: EXEMPT, packFile: LANG_MEMORY, bindings: BINDINGS,
    include: [...COMPLETE, LANG_MEMORY], run: COVERAGE_RUN,
  });
  assert.deepEqual(problems, [], `the call list in test/memtext/calls.ts misses text (add a call, or an EXEMPT entry with a reason):\n${problems.join("\n")}`);
});

// ---------- 收口的四个测试（3b-1、3b-2 挪完以后：这些文件里剩下的、包里的每一条、渲染出来的每一条、渲染不出来的按值钉住） ----------

const NON_ASCII = /[^\x00-\x7f]/;
const source = (rel: string): string => readFileSync(join(TREE, rel), "utf8");
/** 按路径动态引入（URL 跟 src/ 里静态引入解析出的是同一个，所以拿到的是同一个模块实例） */
const importFrom = async (rel: string): Promise<Record<string, unknown>> => (await import(pathToFileURL(join(TREE, rel)).href)) as Record<string, unknown>;

type Kind = "token" | "operator";
interface Left { file: string; kind: Kind; why: string; texts: readonly string[] }
const tok = (file: string, why: string, ...texts: string[]): Left => ({ file, kind: "token", why, texts });
const op = (file: string, why: string, ...texts: string[]): Left => ({ file, kind: "operator", why, texts });
const CENTRAL = "src/memory/central.ts", RENDER = "src/memory/events/render.ts";
const EVRECALL = "src/memory/events/recall.ts", SITUATION = "src/memory/situation.ts", EVMEMORY = "src/memory/events/memory.ts";
/**
 * 这些文件（MOVED）里留在代码里的非 ASCII 字面量，按文字（textLines 的找法：模板的每一段静态文字算一条）。记号 = 代码认它（正则、includes、split、===、比长度）或它写进库后被认；运维文字 = 给跑机器的人看的报错 / 日志。
 * 新的、不在这张表上的字面量会让测试失败并报出文件:行 —— 她读的字要进 src/lang/zh/memory.ts，不是加到这里。
 */
const LEFT: readonly Left[] = [
  tok(CENTRAL, "the time mark 〔…〕: brain.ts seenLine matches /^〔[^〕]*〕/ to find the first line of her page", "〔", "〕"),
  tok(CENTRAL, "who a line came from: meta.from is compared with 感官, the id the brain records a sense under (stored, never shown: M.central.saw renders it)", "感官"),
  tok(RENDER, "head line of an event: events/recall.ts clusterRaw and associate (the moments part) look for `${id}（` in the shown text", "· ", "〔", "〕", "（", "）"),
  tok(RENDER, "the three entry lines: events/recall.ts event and associate (the moments part) look for （id）, （id→ and →id）", "（", "→", "）", "（", "）"),
  tok(RENDER, "the filler repeated only for its length (the room reserved for the overflow line)", "还"),
  tok(EVRECALL, "`${id}（` is how a shown event is recognised in the text (touches, the exclude set of association)", "（"),
  tok(EVRECALL, "the template of an entity with its role in reverse: the next lines test whether a line starts with a person's name (!ents.some((x) => x.startsWith(n)))", "（", "）"),
  tok(EVRECALL, "which entries count as shown: includes（id、id）、→id", "（", "）", "→"),
  tok(EVRECALL, "the two id matchers over the shown text", "/(e\\d{4,})（/g", "/（(n\\d{4,})(?:→(n\\d{4,}))?）/g"),
  tok(EVRECALL, "the shown-entry matchers of association: （id）, （id→, →id）", "（", "（", "）", "（", "→", "→", "）"),
  tok(EVRECALL, "lowInfo: the punctuation normaliser, the envelope head of a forwarded message (the words that carry nothing are B.forms.filler)", "/[\\p{P}\\p{S}\\s\\u200d\\ufe0f]/gu", "/^\\s*\\[(?:WhatsApp|QQ)[^\\]]*\\]\\s*[^:：\\n]{0,40}[:：]\\s*/u"),
  tok(EVRECALL, "parseRange: the marks between the two dates of a range, read in every language (the words are B.forms.period.to)", "|~|～|–|—|-{1,2})\\s*(\\d{4}-)?(\\d{1,2})-(\\d{1,2})"),
  tok(SITUATION, "the type marks and the 维护规则 heading of the old profile files", "/^<!-- 类型：(\\S+) -->/", "设定", "总结", "原话", "/^维护规则/", "/^<!-- 类型：/"),
  tok(EVMEMORY, "the speaker labels stored in mem_quote.who (我→X, 我（笔记）) are parsed: the arrow, and the suffix in brackets", "→", "/（.*$/"),
  tok(EVMEMORY, "likePrefix: after a like / dislike word (B.forms.stance, any pack's for a stored title), a space or an opening bracket makes it a prefix", ")(?:\\s+|(?=[《「『〈【（(“‘]))"),
  tok(EVMEMORY, "MENTIONED: written into mem_op.reason by like, split off again by the night's worklist", "；以前提过："),
  tok(EVMEMORY, "selfTo: the arrow after any pack's word for the role itself (我→, me→) at the head of a quote's speaker", ")→"),
];

test("memory text: left — the non-ASCII literals still in the moved files are exactly the listed tokens and operator text (a new one is named with file:line)", () => {
  const key = (file: string, text: string): string => `${file}\u0000${text}`;
  const want = new Map<string, number>();
  for (const e of LEFT) for (const t of e.texts) want.set(key(e.file, t), (want.get(key(e.file, t)) ?? 0) + 1);
  const extra: string[] = [];
  for (const f of MOVED) {
    for (const l of textLines(source(f), [], f)) for (const t of l.texts) {
      const n = want.get(key(f, t)) ?? 0;
      if (n > 0) want.set(key(f, t), n - 1);
      else extra.push(`${f}:${l.line}  ${t}`);
    }
  }
  const gone = [...want].filter(([, n]) => n > 0).map(([k, n]) => `${k.replace("\u0000", "  ")}${n > 1 ? ` (x${n})` : ""}`);
  assert.deepEqual(extra, [], `non-ASCII literal(s) in the moved files that are not on the list — text she reads goes into src/lang/zh/memory.ts (M.…), only a token or operator text may be added to LEFT:\n${extra.join("\n")}`);
  assert.deepEqual(gone, [], `LEFT lists literal(s) the files no longer have:\n${gone.join("\n")}`);
});

const memoryFiles = (dir = "src/memory"): string[] =>
  readdirSync(join(TREE, dir), { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? memoryFiles(`${dir}/${d.name}`) : d.name.endsWith(".ts") ? [`${dir}/${d.name}`] : []));
/** 包里的标签表：代码用任意字符串去下标（M.central.verb[kind]），或先放进一个 Record<string, string> 视图。读到表本身（M.<表>）就算读了它的每一项 */
// 两层的表（M.like.feltTitle[how][stance]）只登记最上面那一层：下面各层是它的格子，不单独登记
const TABLES = ["central.verb", "like.feltTitle", "personSet.waitWhy", "recall.role", "recall.status", "recallCentral.verb", "render.rel", "render.status", "situation.loadLevel"];

test("memory text: no dead leaf (every leaf of zh.memory is read as M.<path>, a label table as M.<table>, in src/memory/** or src/brain.ts) and the pack file has no runtime import", async () => {
  const pack = (await importFrom("src/lang/zh/index.ts")).zh as { memory: object };
  const leaves = packLeaves(pack.memory);
  assert.ok(leaves.length > 150, `only ${leaves.length} leaves found in the pack — the walk is broken or the pack is not the finished one`);
  const nested = leaves.map((l) => l.path.split(".").slice(0, -1).join(".")).filter((p) => p.includes("."));
  const tables = new Set(nested.map((p) => TABLES.find((t) => p.startsWith(`${t}.`)) ?? p));
  assert.deepEqual([...tables].sort(), [...TABLES].sort(), "the objects nested below the pack's top-level objects are exactly the label tables listed in TABLES (a new one: decide whether code reads it as a table)");
  const reads = new Set<string>();
  for (const f of [...memoryFiles(), "src/brain.ts"]) for (const r of bindingReads(source(f), "M", f)) reads.add(r);
  for (const t of TABLES) assert.ok(reads.has(t), `the table M.${t} is never read`);
  const dead = leaves.filter((l) => !reads.has(l.path) && !TABLES.some((t) => l.path.startsWith(`${t}.`))).map((l) => l.path);
  assert.deepEqual(dead, [], `${dead.length} leaf(s) of zh.memory are never read as M.<path> — delete them, or the call site reads another key:\n${dead.join("\n")}`);
  const imports = runtimeImports(source(LANG_MEMORY), LANG_MEMORY);
  assert.deepEqual(imports, [], `${LANG_MEMORY} may only import types (import type), found:\n${imports.join("\n")}`);
});

/** 标记包登记的语言代码（随便取，只要不跟真的包重名） */
const MARKER_LANG = "memory-marker";
interface LangApi { registerLang(pack: unknown): void; setLang(code?: string | null): void; langCode(): string }
/** 渲染出来的文字里永远不会有标记的叶子（每条写读它的地方和它在那里干什么；写不出理由的缺标记是毛病，不是在这里加一条） */
const NEVER_SHOWN: ReadonlyArray<{ path: string; reason: string }> = [
  // 搬之前它在 VERB 表里就是用不到的一格：表按 Kind 取，键得齐，所以原样搬了过来。以后改这张表的类型时把这一格拿掉
  { path: "central.verb.input", reason: "central.ts: renderMemory writes an input itself (the saw / remembered / heard lines) and continues before who() is asked, so who() never gets kind \"input\"; the key exists because the table is indexed by Kind" },
  { path: "midterm.namesMoreRoom", reason: "events/midterm.ts names() reads only M.midterm.namesMoreRoom(rest).length, the room kept for the \"…还有 N 件\" tail; the tail itself is M.midterm.namesMore" },
  { path: "midterm.staleSepRoom", reason: "events/midterm.ts staleLine (the loop over stale) reads only items.join(M.midterm.staleSepRoom).length to reserve room for the separator; the separator printed is another entry" },
  { path: "render.overflowReserve", reason: "events/render.ts renderEvents hands M.render.overflowReserve(n + 1) to total(), which reads only its .length; the line printed is built by overflowLine" },
  // 它在没标记的渲染里是显示出来的（钉子 midterm: likes … 三条）：标记 20 个字加长了前面的行和它自己的字头，names() 的预算（midterm.ts names()）装不下了，整行就不出
  { path: "midterm.stillLikes", reason: "events/midterm.ts hands it to names() as the head of the overflow line; names() starts len at head.length and drops the whole line when no name fits min(cap, avail), and the marker (20 chars on this head and on the lines before it) takes that room — the plain pack shows the line in the pinned calls" },
];

/**
 * 标记包里不加标记的条目（整张表写表的路径）：它们的值写进库里有长度上限的列，加了标记库自己就拒收，那条调用连夹具都造不出来。
 * 这些条目不靠标记管：代码走得到的那些（标题十格里的八格、省略号），写进库的值由 stored() 的钉子逐字钉着（读错键、改了字，钉子就变）；
 * 标题里另外两格（how=like 配「烦」那边、how=dislike 配「喜欢」那边）代码走不到、没有调用能钉，由「渲染不出来的按值钉住」那个测试管：这两行必须是同一行。
 * 代价：这两条读的是不是「调用时的包」，标记测试看不出来（把它们抄成模块顶层常量，所有测试照样过）——改 clipGist 和 like 写标题那一行时自己看。
 * 这张表没有「不再需要」的自查：条目搬走或列改了上限，要手工删。
 */
const UNMARKED: ReadonlyArray<{ path: string; reason: string }> = [
  { path: "like.feltTitle", reason: "written to mem_entry.title, which the store limits to TITLE_MAX characters: a marked title is refused by the store" },
  { path: "like.gistCut", reason: "appended to a gist already cut to GIST_MAX - 1 characters, so the value must be one character: a marked one makes the gist longer than the store accepts" },
];
/** 标记好的那棵树里，把 UNMARKED 的条目换回原样 */
function unmarkPaths(marked: Record<string, unknown>, original: object): Record<string, unknown> {
  for (const { path } of UNMARKED) {
    const keys = path.split(".");
    let m = marked, o = original as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) { m = m[k] as Record<string, unknown>; o = o[k] as Record<string, unknown>; }
    const last = keys[keys.length - 1]!;
    assert.ok(o !== undefined && last in o, `UNMARKED names ${path}, which is not in the pack`);
    m[last] = o[last];
  }
  return marked;
}
const unmarked = (path: string): boolean => UNMARKED.some((u) => path === u.path || path.startsWith(`${u.path}.`));

/**
 * 加了标记（每个叶子前 ⟦路径⟧）就和普通包渲染不一样的调用。多数是标记让文字变长，撞上长度预算，别的字被截 / 丢 / 折起来 / 多分页——每组写它撞的是哪道预算。
 * 还有一种不是长度预算：包里的字被交给了机器（向量的线索 like.meaningCue），标记改了线索，算出来的相似度就不一样；记在计划的欠账里
 */
const BUDGET: ReadonlyArray<{ reason: string; ids: readonly string[] }> = [
  { reason: "budget: my_likes pages are cut at 4000 characters at a whole line; longer lines move the page breaks, the tail and what page 2 starts with", ids: [
    "memory myLikes: over 4000 characters, page 1 stops at a whole line and ends with the tail (还有 40 件 …page=2)",
    "memory myLikes: page 2 starts inside a group (the head is printed again) and is held back by the room for the tail",
    "memory myLikes: the last page has no tail",
    "memory myLikes: no page argument is page 1 (same text as memory myLikes: over 4000 characters, page 1 stops at a whole line and ends with the tail (还有 40 件 …page=2): pins the path)"] },
  { reason: "not a length budget: the cue handed to the embedder is pack text (M.like.meaningCue: what：feeling), so the marked cue has another vector and the logged cosine differs", ids: [
    "memory like: by meaning, a new like finds a candidate (the cue is what：feeling; the candidate and its cosine are logged)"] },
  { reason: "budget: renderEvents (render.ts) — the event budget, the overflow room and the final cut; longer head lines make entries fold, titles drop into the 还有 N 件 line, the last line is cut", ids: [
    "render entries: a budget too tight for the lines folds them", "render overflow: the list is cut when the room is small", "render overflow: overflowRoom fixes the line and cuts the titles",
    "render overflow: a small budget moves events out", "render overflow: a small budget moves events out, overflowRoom reserved", "render events: the final cut when many events cannot fit"] },
  { reason: "budget: the midterm view (midterm.ts) — the 600-character stale line, the likes / dislikes room, the owner's quotes and the section total; the section ends earlier or later and the cut falls on another word", ids: [
    "midterm: a stale line over 600 characters counts the rest", "midterm: likes that all fit as lines", "midterm: likes overflow into names and the names are cut",
    "midterm: likes overflow into names that all fit, dislikes get no room", "midterm: likes lines, a likes names line and a dislikes line", "midterm: dislikes only",
    "midterm: dislikes only, more than fit", "midterm: the owner's quotes, more than fit, with how to turn the pages", "midterm: everything at once", "midterm: a tight budget cuts every section"] },
  { reason: "budget: events/recall.ts cluster / person / associate hand renderEvents or the card sections a fixed budget; the longer text drops entries, skips a card section or cuts the line earlier", ids: [
    "cluster: a small budget shrinks the event text and leaves little room for quote lines", "person: card, a guest with stored fields names the file",
    "person: card cut, the sections that do not fit are skipped and the later ones that fit are kept", "person: card cut, no section fits",
    "associate: a guest's recap, then the moments", "associate: the guest's recap and a named person's recap share the room", "associate: the text is cut at the budget",
    "associate: touch off still gives the same text (same text as associate: a guest's recap, then the moments: pins the path)"] },
  { reason: "budget: period pages are cut by length; longer lines make more pages (第 N/M 页) and move what is on each", ids: [
    "period: paged, the second page", "period: paged, a page past the end is the last", "period: a line longer than the page is cut"] },
];

test("memory text: marker pack — with every leaf of zh.memory marked and set as the language, every marker shows up in some rendered text (a module-level copy of pack text, a dead leaf or a call site reading the wrong key leaves its marker out)", async () => {
  const lang = (await importFrom("src/lang/index.ts")) as unknown as LangApi;
  const zh = (await importFrom("src/lang/zh/index.ts")).zh as { memory: object };
  const leaves = packLeaves(zh.memory);
  assert.ok(leaves.length > 150, `only ${leaves.length} leaves found in the pack — the walk is broken or the pack is not the finished one`);
  // 别的部分原样带上，只换记忆这一部分
  lang.registerLang({ ...zh, code: MARKER_LANG, memory: unmarkPaths(markLeaves(zh.memory), zh.memory) });
  let rendered: Awaited<ReturnType<typeof renderAll>>;
  try {
    lang.setLang(MARKER_LANG);
    assert.equal(lang.langCode(), MARKER_LANG);
    rendered = await renderAll();
  } finally {
    lang.setLang("zh");
  }
  assert.equal(lang.langCode(), "zh", "the default pack is back");
  // 同一张清单再用普通包渲染一遍：删掉所有标记以后，每条调用的文字应当和普通包的一样。不一样的只有两种可能：
  // 长度预算（标记让文字变长，被截了、被丢了、折进了「还有 N 件」、多分了几页）——下面的 BUDGET 逐条写着；或者代码在认包里的字（该改成记号，不是加到表里）
  const plain = await renderAll();
  // 只删完整的标记（⟦路径⟧）：被预算截成半个的标记留着，那条调用本来就在 BUDGET 里；这样不会把半个标记到下一个标记之间的真文字也删掉
  const unmark = (t: string): string => t.replace(/⟦[A-Za-z0-9_.]+⟧/g, "");
  const budget = new Map<string, string>();
  for (const g of BUDGET) for (const id of g.ids) budget.set(id, g.reason);
  const differing = Object.keys(plain).filter((id) => unmark(rendered[id]!.reply) !== plain[id]!.reply || unmark(rendered[id]!.rest) !== plain[id]!.rest);
  assert.deepEqual(differing.filter((id) => !budget.has(id)), [], "these calls render differently once the markers are deleted and are not on BUDGET — a length budget or pack text handed to a machine (add them with the reason), or code recognising pack text (fix the code)");
  assert.deepEqual([...budget.keys()].filter((id) => !differing.includes(id)), [], "BUDGET lists calls that now render the same — delete the entries");
  const all = Object.values(rendered).map((r) => `${r.reply}\n${r.rest}`).join("\n");
  const exempt = new Set(NEVER_SHOWN.map((e) => e.path));
  for (const e of NEVER_SHOWN) assert.ok(leaves.some((l) => l.path === e.path), `NEVER_SHOWN names ${e.path}, which is not a leaf`);
  for (const e of NEVER_SHOWN) assert.ok(!unmarked(e.path), `${e.path} is on both NEVER_SHOWN and UNMARKED`);
  const missing = leaves.filter((l) => !exempt.has(l.path) && !unmarked(l.path) && !all.includes(markerOf(l.path))).map((l) => l.path);
  assert.deepEqual(missing, [], `${missing.length} of ${leaves.length} leaves never show up in any rendered text (marked pack):\n${missing.join("\n")}`);
  const shown = NEVER_SHOWN.filter((e) => all.includes(markerOf(e.path))).map((e) => e.path);
  assert.deepEqual(shown, [], "NEVER_SHOWN lists leaves that do show up — delete the entry");
});

test("memory text: the entries no rendered text shows are pinned by value (the marker test cannot see them; each is read only for its length, or is a cell kept for a table index)", async () => {
  const m = (await importFrom("src/lang/zh/index.ts")).zh as { memory: { midterm: { namesMore: (n: number) => string; namesMoreRoom: (n: number) => string; staleSep: string; staleSepRoom: string }; render: { overflowReserve: (n: number) => string; overflowCut: (s: string) => string; overflowHead: (n: number) => string }; central: { verb: { input: string } } } };
  const { midterm, render, central } = m.memory;
  const felt = (m.memory as unknown as { like: { feltTitle: { like: unknown; dislike: unknown } } }).like.feltTitle;
  assert.deepEqual(felt.dislike, felt.like, "the two rows a first like / dislike reads are one row: the two cells no call reaches equal the two that are pinned through stored()");
  assert.equal(midterm.namesMoreRoom(7), midterm.namesMore(7), "the room kept for the tail is the length of the tail itself");
  assert.equal(midterm.staleSepRoom, midterm.staleSep, "the separator whose length is reserved is the one printed");
  assert.equal(render.overflowReserve(3), render.overflowCut(render.overflowHead(3)), "the reserved room is the length of the overflow line as it would be printed");
  // 这一个字面量允许写在测试里：central.verb.input 是为 Kind 索引留着的一格，没有渲染出来的字显示它
  assert.equal(central.verb.input, "收到");
});
