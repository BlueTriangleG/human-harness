// 学习系统：笔记本编号、话题联想、翻开记录、纠正、复发、回放用例。
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync, readdirSync, renameSync, utimesSync, chmodSync, statSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { tmpDir } from "./tmp.ts";
import { join, dirname } from "node:path";
import { openDb, MIGRATIONS, kvGet, kvSet, all } from "../src/store/db.ts";
import { parsePage, scanShelf, coverText, practiceHead, pageItems, PAGE_ID, LESSON_ID, KEPT_IDS } from "../src/learning/notebook.ts";
import { assignIds, resolveId, knownIds } from "../src/learning/ids.ts";
import { renderShelf } from "../src/learning/shelf.ts";
import { curateShelf, savedLayers } from "../src/learning/curator.ts";
import { coLinks, eventLinks, linksOf, neighbors, pageIndex, rebuildLinks, refLinks } from "../src/learning/graph.ts";
import { importanceOf, layerOf, readShelfRules, statedImportance } from "../src/learning/layers.ts";
import { OpenAIDecisions } from "../src/learning/decisions.ts";
import { CoverIndex, ItemIndex } from "../src/learning/covers.ts";
import { listParams, param, paramLog, setParam } from "../src/learning/params.ts";
import { renderResident } from "../src/learning/shelf.ts";
import { classifyRecurrences, addSeedCase, caught } from "../src/learning/score.ts";
import { CentralMemory } from "../src/memory/central.ts";
import { NoteAssociator } from "../src/learning/associate.ts";
import type { Judge } from "../src/learning/decisions.ts";
import type { Embedder } from "../src/memory/events/embed.ts";
import type { Lesson, Page, Shelf } from "../src/learning/notebook.ts";
import { testConfig } from "./helpers.ts";
import type { LearningCfg } from "../src/config.ts";
import { Logger, memorySink } from "../src/log.ts";
import type { LogRecord } from "../src/log.ts";

/** 这份测试里现成的断言都按这个主人名、书架目录和记号写的（当参数传进去；换个名字的测试在最后） */
const WHO = { owner: "ada", shelfDir: "skills" };
const KEEP: readonly string[] = ["ada 教的"];
/** 归档目录的名字、常驻单子的文件名（配置 learning.archiveDir、learning.residentFile；中文包的默认值） */
const ARCH = "归档";
const RES_FILE = "常驻.md";
const ROLE = { ...WHO, keep: KEEP, residentFile: RES_FILE };

test("迁移：学习的表都在，tasks 多了 pages", () => {
  const db = openDb(":memory:");
  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

  // 表名和列名后面所有学习任务都按这份用
  const expected: Record<string, string[]> = {
    learn_item: ["id", "kind", "rel", "hash", "first_seen", "last_seen", "gone"],
    learn_alias: ["alias", "id", "at"],
    learn_cover: ["page_id", "hash", "vec"],
    learn_assoc: ["id", "at", "region", "binding", "topic", "task_id", "candidates", "mounted", "shadow", "skipped", "ms", "tokens", "asked", "vec"],
    learn_open: ["at", "region", "page_id", "book"],
    learn_correction: ["id", "at", "seq", "topic", "task_id", "p"],
    learn_recur: ["lesson_id", "day", "seq", "kind", "case_id"],
    learn_case: ["id", "at", "topic", "expect", "source"],
    learn_case_run: ["night", "case_id", "passed"],
  };
  for (const [table, want] of Object.entries(expected)) {
    assert.deepEqual(cols(table), want, `${table} 的列`);
  }
  assert.ok(cols("tasks").includes("pages"), "tasks.pages");

  const row = db.prepare("SELECT v FROM schema_version").get() as { v: number };
  assert.equal(row.v, MIGRATIONS.length);
});

// 在临时目录里按 { 相对路径: 内容 } 建一个书架
function makeShelf(files: Record<string, string>): string {
  const root = tmpDir("hh-shelf-");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const FULL_PAGE = [
  "# 看成片 <!-- p:0012 -->",
  "简介：看完整条成片再说好不好",
  "什么时候翻：要验收一条做完的视频的时候",
  "",
  "## 做法",
  "先从头到尾看一遍。",
  "",
  "### 待验证",
  "- 先看静音版（2026-10-30，自己摸索）",
  "  - 细节：为什么这样",
  "- 抽帧看封面",
  "",
  "## 教训",
  "- 教训：只看了前十秒就说好｜什么时候：要验收成片的时候｜下次：从头看到尾｜犯的日子：2026-10-25、2026-10-28｜出处：#12345、#13001 <!-- l:0039 l:0041 -->",
  "- 教训：没核对时长｜什么时候：要交片的时候｜下次：先看时长",
  "",
  "## 相关",
  "- 教训：这行不在教训小节里，不算",
  "",
  "## 旧做法",
  "- 以前只抽查",
  "",
].join("\n");

test("页：封面、教训、待验证都认得", () => {
  const p = parsePage(FULL_PAGE, "通用/验收/看成片.md", "通用", ARCH);
  assert.deepEqual(p.ids, ["0012"]);
  assert.equal(p.rel, "通用/验收/看成片.md");
  assert.equal(p.category, "通用");
  assert.equal(p.book, "验收");
  assert.equal(p.title, "看成片");
  assert.equal(p.brief, "看完整条成片再说好不好");
  assert.equal(p.when, "要验收一条做完的视频的时候");
  assert.equal(p.archived, false);
  assert.equal(p.general, true);
  assert.equal(p.pending, 2, "待验证只数一级条目，子条目和旧做法下的不算");

  assert.equal(p.lessons.length, 2, "只认 ## 教训 下以「- 教训：」开头的行");
  const [a, b] = p.lessons;
  assert.deepEqual(a!.ids, ["0039", "0041"]);
  assert.equal(a!.line, 14, "行号从 1 数");
  assert.equal(a!.text, "只看了前十秒就说好");
  assert.equal(a!.when, "要验收成片的时候");
  assert.equal(a!.next, "从头看到尾");
  assert.equal(a!.days.length, 2);
  assert.deepEqual(a!.days, ["2026-10-25", "2026-10-28"]);
  assert.deepEqual(a!.sources, [12345, 13001]);
  assert.deepEqual(b!.ids, []);
  assert.equal(b!.text, "没核对时长");
  assert.deepEqual(b!.days, []);
  assert.deepEqual(b!.sources, []);

  assert.equal(
    coverText(p),
    "验收 · 看成片：看完整条成片再说好不好（什么时候翻：要验收一条做完的视频的时候）",
  );
});

test("页：缺字段也能解析", () => {
  const p = parsePage("# 标题\n", "形象/形象制作/某页.md", "通用", ARCH);
  assert.equal(p.title, "标题");
  assert.equal(p.brief, "");
  assert.equal(p.when, "");
  assert.deepEqual(p.ids, []);
  assert.equal(p.general, false);
  assert.equal(p.pending, 0);
  assert.deepEqual(p.lessons, []);
  assert.ok(coverText(p).startsWith("形象制作 · 标题："));

  // 连标题行都没有：退成文件名；空文本也不抛
  assert.equal(parsePage("", "形象/形象制作/某页.md", "通用", ARCH).title, "某页");
  assert.equal(parsePage("# <!-- p:0003 -->\n", "形象/形象制作/某页.md", "通用", ARCH).title, "某页");
});

test("页：教训也认「怎么做」「怎样算做到」的写法（夜里把关写的新教训是这样）", () => {
  const p = parsePage([
    "# 页 <!-- p:0001 -->",
    "## 教训",
    "- 教训：生图没喂原图｜什么时候：要照现成角色生图｜怎么做：用 edit 把原图喂进去｜怎样算做到：和原图并排对得上｜犯的日子：2026-11-02｜出处：#31787 <!-- l:0150 -->",
  ].join("\n"), "a/b/c.md", "通用", ARCH);
  const l = p.lessons[0]!;
  assert.equal(l.when, "要照现成角色生图");
  assert.equal(l.next, "用 edit 把原图喂进去", "怎么做就是下次怎么做");
  assert.equal(l.done, "和原图并排对得上");
  assert.deepEqual(l.days, ["2026-11-02"]);
  assert.deepEqual(l.sources, [31787]);
  const both = parsePage("# 页\n## 教训\n- 教训：甲｜下次：先看说明｜怎么做：照官方示例 <!-- l:0151 -->\n", "a/b/c.md", "通用", ARCH).lessons[0]!;
  assert.equal(both.next, "先看说明｜怎么做：照官方示例", "两个都写了：都留着（以前「怎么做」那段并在下次里）");
});

test("页：教训的「强度」（0–5，没写就没有，按 3 算）", () => {
  const ls = parsePage("# 页\n## 教训\n- 教训：甲｜下次：乙｜强度：4 <!-- l:0001 -->\n- 教训：丙｜强度：九 <!-- l:0002 -->\n- 教训：丁 <!-- l:0003 -->\n", "a/b/c.md", "通用", ARCH).lessons;
  assert.deepEqual(ls.map((l) => l.strength), [4, undefined, undefined]);
  const more = parsePage("# 页\n## 教训\n- 教训：甲｜强度：4（11-03 升）\n- 教训：乙｜强度：５\n- 教训：丙｜强度：45\n", "a/b/c.md", "通用", ARCH).lessons;
  assert.deepEqual(more.map((l) => l.strength), [4, 5, undefined], "后面带说明的、全角数字也认；两位数不认");
  assert.equal(ls[0]!.next, "乙");
});

test("页：教训的「提醒：动手时」（11-04 动作型教训只在这一步就要做时提醒）；「提醒：」后面写别的是正文", () => {
  const ls = parsePage([
    "# 页", "## 教训",
    "- 教训：甲｜什么时候：要 git 提交的时候｜下次：乙｜提醒：动手时｜强度：4 <!-- l:0001 -->",
    "- 教训：丙｜什么时候：发评论前｜下次：丁｜提醒：动手那一下 <!-- l:0002 -->",
    "- 教训：戊｜下次：先问他｜提醒：他别忘了带伞 <!-- l:0003 -->",
    "- 教训：辛｜下次：先截图｜提醒：动手前先给 ada 看一眼 <!-- l:0005 -->",
    "- 教训：己｜下次：庚 <!-- l:0004 -->",
  ].join("\n"), "a/b/c.md", "通用", ARCH).lessons;
  assert.deepEqual(ls.map((l) => l.step), [true, true, undefined, undefined, undefined]);
  assert.equal(ls[3]!.next, "先截图｜提醒：动手前先给 ada 看一眼", "「动手」开头但不是那几种写法：也是正文");
  assert.equal(ls[0]!.strength, 4, "后面的字段照认");
  assert.equal(ls[2]!.next, "先问他｜提醒：他别忘了带伞", "不是「动手」开头的，并回上一段");
  const items = pageItems({ ...parsePage("# 页 <!-- p:0001 -->\n## 教训\n- 教训：甲｜什么时候：要 git 提交的时候｜下次：乙｜提醒：动手时 <!-- l:0001 -->\n- 教训：丙｜下次：丁｜提醒：动手时 <!-- l:0002 -->\n", "a/b/c.md", "通用", ARCH) }, null, ROLE);
  assert.deepEqual(items.map((it) => [it.id, it.step]), [["l:0001", { when: "要 git 提交的时候" }], ["l:0002", undefined]], "没写「什么时候」的问不了这一步，照旧");
});

test("页：教训的「提醒：发之前」（11-05 发给 ada 之前那道核对只拿这种强教训拦）；能和「动手时」用顿号连着写；别的写法是正文", () => {
  const ls = parsePage([
    "# 页", "## 教训",
    "- 教训：甲｜什么时候：要说过了的时候｜下次：乙｜提醒：发之前｜强度：5 <!-- l:0001 -->",
    "- 教训：丙｜什么时候：发评论前｜下次：丁｜提醒：动手时、发给 ada 之前 <!-- l:0002 -->",
    "- 教训：戊｜下次：己｜提醒：发前 <!-- l:0003 -->",
    "- 教训：庚｜下次：辛｜提醒：发之前先问他、动手时 <!-- l:0004 -->",
    "- 教训：壬｜下次：癸｜提醒：动手时｜强度：5｜提醒：发之前 <!-- l:0005 -->",
    "- 教训：子｜下次：丑｜提醒：动手时｜（11-04 加） <!-- l:0006 -->",
    "- 教训：寅｜下次：卯｜提醒：发给小贝之前 <!-- l:0007 -->",
  ].join("\n"), "a/b/c.md", "通用", ARCH).lessons;
  assert.deepEqual(ls.map((l) => [l.step, l.send]), [[undefined, true], [true, true], [undefined, true], [undefined, undefined], [true, true], [true, undefined], [undefined, true]],
    "后面又写一段「提醒：」、跟着别的字的：前面认出的不丢");
  assert.equal(ls[0]!.strength, 5, "后面的字段照认");
  assert.equal(ls[3]!.next, "辛｜提醒：发之前先问他、动手时", "有一样不是那几种写法：整个当正文");
  const items = pageItems({ ...parsePage("# 页 <!-- p:0001 -->\n## 教训\n- 教训：甲｜什么时候：要说过了的时候｜下次：乙｜提醒：发之前 <!-- l:0001 -->\n- 教训：丙｜下次：丁 <!-- l:0002 -->\n", "a/b/c.md", "通用", ARCH) }, null, ROLE);
  assert.deepEqual(items.map((it) => [it.id, it.send, it.step]), [["l:0001", true, undefined], ["l:0002", undefined, undefined]]);
});

test("页：编号注释的几种写法、教训里的竖线、代码块里的小节标题", () => {
  assert.ok(PAGE_ID.test("# x <!-- p:0012 p:0020 -->"));
  assert.ok(!PAGE_ID.test("# x <!-- p:12 -->"), "编号至少 4 位");
  assert.ok(LESSON_ID.test("<!-- l:10234 -->"), "4 位以上都行");

  const text = [
    "# 两个号 <!-- p:0012 p:0020 -->",
    "## 教训",
    "- 教训：先判断｜再动手｜什么时候：要动手的时候｜下次：想清楚 <!-- l:10234 -->",
    "```",
    "## 教训",
    "- 教训：代码块里的不算",
    "```",
    "- 教训：最后一条｜犯的日子：2026-11-01",
  ].join("\r\n"); // 她在别处改过的文件可能是 CRLF
  const p = parsePage(text, "a/b/c.md", "通用", ARCH);
  assert.deepEqual(p.ids, ["0012", "0020"]);
  assert.equal(p.lessons.length, 2);
  assert.deepEqual(p.lessons[0]!.ids, ["10234"]);
  assert.equal(p.lessons[0]!.text, "先判断｜再动手", "没有字段前缀的片段并回前一个字段");
  assert.equal(p.lessons[0]!.next, "想清楚");
  assert.equal(p.lessons[1]!.line, 8);
  assert.deepEqual(p.lessons[1]!.days, ["2026-11-01"]);
});

test("书架：两层目录、归档、通用、旧的一层手册不算页", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": "---\nname: 验收\ndescription: 做完的东西怎么验\n---\n# 验收\n",
    "通用/验收/看成片.md": FULL_PAGE,
    "通用/验收/CHANGELOG.md": "# 变更\n",
    "形象/形象制作/SKILL.md": "---\nname: 形象制作\ndescription: \"画她自己的样子\"\n---\n",
    "形象/形象制作/归档/旧.md": "# 旧\n简介：被推翻的\n",
    "living/SKILL.md": "---\nname: living\ndescription: 旧的一层手册\n---\n",
    "living/references/不是页.md": "# 不是页\n",
    "MAP.md": "# 根上的文件不是页\n",
  });
  try {
    const shelf = scanShelf(root, "通用", ARCH);
    const byTitle = new Map(shelf.pages.map((p) => [p.title, p]));
    assert.deepEqual([...byTitle.keys()].sort(), ["旧", "看成片"].sort());

    const watch = byTitle.get("看成片")!;
    assert.equal(watch.general, true);
    assert.equal(watch.archived, false);
    assert.equal(watch.rel, "通用/验收/看成片.md");

    const old = byTitle.get("旧")!;
    assert.equal(old.archived, true);
    assert.equal(old.general, false);
    assert.equal(old.rel, "形象/形象制作/归档/旧.md");
    assert.equal(old.book, "形象制作");

    assert.equal(shelf.pages.some((p) => p.category === "living" || p.book === "living"), false);
    assert.equal(shelf.books.length, 2);
    const book = (name: string) => shelf.books.find((b) => b.book === name)!;
    assert.deepEqual(book("验收"), { category: "通用", book: "验收", description: "做完的东西怎么验", pages: 1 });
    assert.deepEqual(book("形象制作"), { category: "形象", book: "形象制作", description: "画她自己的样子", pages: 0 }, "归档的不算页数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("书架：大类和书架这两层的 归档/ 也是归档——里面的页都算归档的、编号照收，这些本不上书架", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": "---\nname: 验收\ndescription: 做完的东西怎么验\n---\n",
    "通用/验收/看成片.md": "# 看成片 <!-- p:0001 -->\n简介：a\n什么时候翻：b\n",
    // 整本挪进书架那层的归档（带着封面）
    "归档/旧剪辑/SKILL.md": "---\nname: 旧剪辑\ndescription: 以前的剪法\n---\n",
    "归档/旧剪辑/粗剪.md": "# 粗剪 <!-- p:0002 -->\n简介：a\n什么时候翻：b\n",
    "归档/旧剪辑/归档/更旧.md": "# 更旧 <!-- p:0003 -->\n",
    // 挪进大类那层的归档（没封面也收）
    "通用/归档/旧验收/封面.md": "# 封面 <!-- p:0004 -->\n简介：a\n什么时候翻：b\n\n## 教训\n- 教训：甲 <!-- l:0005 -->\n",
    "通用/归档/散页.md": "# 散页 <!-- p:0006 -->\n",
    "通用/归档/旧验收/CHANGELOG.md": "# 变更\n",
  });
  try {
    const shelf = scanShelf(root, "通用", ARCH);
    const byRel = new Map(shelf.pages.map((p) => [p.rel, p]));
    assert.deepEqual([...byRel.keys()].sort(), [
      "归档/旧剪辑/归档/更旧.md", "归档/旧剪辑/粗剪.md", "通用/归档/散页.md", "通用/归档/旧验收/封面.md", "通用/验收/看成片.md",
    ].sort());
    for (const [rel, p] of byRel) assert.equal(p.archived, rel !== "通用/验收/看成片.md", rel);
    assert.deepEqual(byRel.get("通用/归档/旧验收/封面.md")!.lessons.map((l) => l.ids), [["0005"]]);
    assert.deepEqual(shelf.books.map((b) => `${b.category}/${b.book}`), ["通用/验收"], "归档里的本不算书架上的本");
    assert.deepEqual(shelf.problems, [], "归档的不查字段、没封面也不报");
    const text = renderShelf(shelf);
    assert.doesNotMatch(text, /归档|旧剪辑|旧验收/);
    assert.match(text, /## 通用\n- 验收：做完的东西怎么验（1 页）/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("书架：缺字段、重复编号、没有封面的本、读不了的文件都记进 problems，别的照常", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": "---\nname: 验收\n---\n",
    "通用/验收/甲.md": "# 甲 <!-- p:0007 -->\n简介：有简介\n什么时候翻：要甲的时候\n## 教训\n- 教训：一 <!-- l:0001 -->\n",
    "通用/验收/乙.md": "# 乙 <!-- p:0007 -->\n## 教训\n- 教训：二 <!-- l:0001 -->\n",
    "通用/验收/归档/丙.md": "# 丙 <!-- p:0007 -->\n",
    "通用/没封面/页.md": "# 页\n简介：a\n什么时候翻：b\n",
    "通用/素材/图.png": "x",
  });
  symlinkSync(join(root, "不存在"), join(root, "通用/验收/坏.md")); // 链出去的文件没了
  try {
    const shelf = scanShelf(root, "通用", ARCH);
    assert.deepEqual(shelf.pages.map((p) => p.title).sort(), ["丙", "乙", "甲"].sort(), "读不了的跳过，别的照常");
    const joined = shelf.problems.join("\n");
    assert.match(joined, /乙\.md[^\n]*简介/);
    assert.match(joined, /乙\.md[^\n]*什么时候翻/);
    assert.doesNotMatch(joined, /甲\.md：缺/, "字段齐的页不报缺字段");
    assert.doesNotMatch(joined, /丙\.md/, "归档的页不查字段和重复编号");
    assert.doesNotMatch(joined, /p:0007[^\n]*丙/, "归档的页不算重复");
    const dup = (id: string) => shelf.problems.find((m) => m.includes(id)) ?? "";
    assert.ok(dup("p:0007").includes("甲.md") && dup("p:0007").includes("乙.md"), "重复的页编号");
    assert.ok(dup("l:0001").includes("甲.md") && dup("l:0001").includes("乙.md"), "重复的教训编号");
    assert.match(joined, /坏\.md/, "读不了的文件");
    assert.match(joined, /没封面/, "没有 SKILL.md 但有页的本");
    assert.equal(shelf.books.length, 1, "没封面的本不进书架目录");
    assert.equal(shelf.books[0]!.description, "", "frontmatter 没有 description 就是空串");
    assert.equal(shelf.books[0]!.pages, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("书架：目录不存在也不抛", () => {
  const shelf = scanShelf(join(tmpdir(), "hh-shelf-不存在"), "通用", ARCH);
  assert.deepEqual(shelf.pages, []);
  assert.deepEqual(shelf.books, []);
  assert.equal(shelf.problems.length, 1);
});

test("书架：按大类列本和页数，开头照抄", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": "---\nname: 验收\ndescription: 做完的东西怎么验\n---\n",
    "通用/验收/看成片.md": FULL_PAGE,
    "通用/验收/抽帧.md": "# 抽帧\n简介：a\n什么时候翻：b\n",
    "通用/验收/归档/旧.md": "# 旧\n简介：被推翻的\n什么时候翻：不翻\n",
    "通用/复盘/SKILL.md": "---\nname: 复盘\ndescription: 做完一件事回头看\n---\n",
    "通用/复盘/一页.md": "# 一页\n简介：a\n什么时候翻：b\n",
    "做饭/煎蛋/SKILL.md": "---\nname: 煎蛋\ndescription: 火候和翻面\n---\n",
    "做饭/煎蛋/火候.md": "# 火候\n简介：a\n什么时候翻：b\n",
    "视频/剪辑/SKILL.md": "---\nname: 剪辑\ndescription: 剪一条片子\n---\n",
    "视频/剪辑/归档/全旧.md": "# 全旧\n简介：a\n什么时候翻：b\n",
    "living/SKILL.md": "---\nname: living\ndescription: 旧的一层手册\n---\n",
  });
  try {
    const out = renderShelf(scanShelf(root, GEN, ARCH));
    assert.equal(
      out,
      [
        "# 我的书架",
        "我的做法和教训都记在这些笔记本里。做事时相关的页会自己冒出来；想找全就用 what_do_i_know，或者直接翻文件。",
        "",
        "## 通用",
        "- 复盘：做完一件事回头看（1 页）",
        "- 验收：做完的东西怎么验（2 页）",
        "",
        "## 做饭",
        "- 煎蛋：火候和翻面（1 页）",
        "",
        "## 视频",
        "- 剪辑：剪一条片子（0 页）",
      ].join("\n"),
      "通用大类排最前，其余照扫描顺序；归档不计页数；旧的一层手册不列",
    );
    for (const w of ["另一头", "后台", "主线", "副线", "meanwhile", "side", "几条线", "最多同时", "前台", "分身", "另一个我"]) {
      assert.ok(!out.includes(w), `书架里不出现「${w}」`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("书架：没有未归档的页（空书架、读不了、全归档）就是空串", () => {
  assert.equal(renderShelf(scanShelf(join(tmpdir(), "hh-shelf-不存在"), GEN, ARCH)), "");
  const root = makeShelf({
    "通用/验收/SKILL.md": "---\nname: 验收\ndescription: d\n---\n",
    "通用/验收/归档/旧.md": "# 旧\n简介：a\n什么时候翻：b\n",
  });
  try {
    assert.equal(renderShelf(scanShelf(root, GEN, ARCH)), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("配置：learning 默认三个开关都关，数值照约定；局部覆盖只改给的字段", () => {
  const d = testConfig().learning;
  assert.deepEqual(d, {
    enabled: false, inject: false, shelf: false,
    root: "/home/role/.openclaw/workspace/skills", generalCategory: "通用", archiveDir: "归档", residentFile: "常驻.md",
    threshold: 0.7, askThreshold: 0.5, maxPages: 3, kWake: 10, kTask: 15, timeoutMs: 800, dailyUsd: 1,
    helperSkipBooks: ["talk", "learning", "self", "delegate", "social"], remountTokens: 50000,
  });
  const o = testConfig({ learning: { shelf: true, root: "/tmp/x" } }).learning;
  assert.equal(o.shelf, true);
  assert.equal(o.root, "/tmp/x");
  assert.equal(o.enabled, false, "没给的字段留默认");
  assert.equal(o.maxPages, 3);
});

// ---------- 编号 ----------

/** 文件的 mtime 离这个时刻都在安静期之外 */
const T = Date.now() + 3_600_000;
const GEN = "通用";
const COVER = "---\nname: 验收\ndescription: d\n---\n";
const page = (title: string, lessons: string[] = [], idc = "") =>
  `# ${title}${idc}\n简介：a\n什么时候翻：b\n\n## 教训\n${lessons.map((l) => `- 教训：${l}\n`).join("")}`;
const items = (db: ReturnType<typeof openDb>) =>
  all<{ id: string; kind: string; rel: string; hash: string; first_seen: number; last_seen: number; gone: number | null }>(
    db, "SELECT * FROM learn_item ORDER BY id");
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

test("编号：没号的页和教训补上，写回文件", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲", "乙｜什么时候：x"]),
    "通用/验收/二.md": page("二", ["丙"]),
  });
  try {
    const db = openDb(":memory:");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 2, lessons: 3, skipped: [], aliases: 0 });
    // 按扫描顺序发：页先，再它的教训
    assert.equal(read(root, "通用/验收/一.md"), "# 一 <!-- p:0001 -->\n简介：a\n什么时候翻：b\n\n## 教训\n- 教训：甲 <!-- l:0002 -->\n- 教训：乙｜什么时候：x <!-- l:0003 -->\n");
    assert.equal(read(root, "通用/验收/二.md"), "# 二 <!-- p:0004 -->\n简介：a\n什么时候翻：b\n\n## 教训\n- 教训：丙 <!-- l:0005 -->\n");

    const rows = items(db);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map((x) => `${x.id}:${x.kind}:${x.rel}`), [
      "0001:page:通用/验收/一.md", "0002:lesson:通用/验收/一.md", "0003:lesson:通用/验收/一.md",
      "0004:page:通用/验收/二.md", "0005:lesson:通用/验收/二.md",
    ]);
    assert.ok(rows.every((x) => x.first_seen === T && x.last_seen === T && x.gone === null && /^[0-9a-f]{40}$/.test(x.hash)));
    assert.equal(kvGet(db, "learn.next"), "6");

    // 重新扫一遍：编号读得出来，没有问题；再编一次什么都不动
    const shelf = scanShelf(root, GEN, ARCH);
    assert.deepEqual(shelf.pages.map((p) => [p.ids, p.lessons.map((l) => l.ids)]), [[["0001"], [["0002"], ["0003"]]], [["0004"], [["0005"]]]]);
    assert.deepEqual(assignIds(root, db, { now: () => T + 1000, generalCategory: GEN, archiveDir: ARCH }), { pages: 0, lessons: 0, skipped: [], aliases: 0 });
    assert.equal(read(root, "通用/验收/二.md").split("<!--").length, 3);
    assert.equal(items(db).length, 5);
    assert.ok(items(db).every((x) => x.first_seen === T && x.last_seen === T + 1000), "再看到一次只动 last_seen");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("numbers: a page linked in from off the shelf (a module's manual) is never written; its number is kept in the shelf and survives", () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一") });
  const code = makeShelf({ "工作/SKILL.md": COVER.replace("验收", "工作"), "工作/查到底.md": page("查到底", ["甲"]) });
  symlinkSync(join(code, "工作"), join(root, "通用/工作"));
  const manual = join(code, "工作/查到底.md");
  const before = readFileSync(manual, "utf8");
  const db = openDb(":memory:");
  const run = (t: number) => assignIds(root, db, { now: () => T + t, generalCategory: GEN, archiveDir: ARCH });
  const numbers = () => scanShelf(root, GEN, ARCH).pages.map((p) => `${p.rel} ${p.ids.join(" ")}`);
  try {
    assert.deepEqual(run(0), { pages: 2, lessons: 0, skipped: [], aliases: 0 });
    assert.equal(readFileSync(manual, "utf8"), before, "the manual is byte for byte as it was");
    assert.equal(read(root, "通用/验收/一.md").split("\n")[0], "# 一 <!-- p:0002 -->", "a page on the shelf is numbered in its file as before");
    assert.deepEqual(JSON.parse(read(root, KEPT_IDS)), { "通用/工作/查到底.md": "0001" });
    assert.deepEqual(numbers(), ["通用/工作/查到底.md 0001", "通用/验收/一.md 0002"]);
    assert.deepEqual(run(1000), { pages: 0, lessons: 0, skipped: [], aliases: 0 });

    // a number another role's older code wrote into the shared file does not replace this role's
    writeFileSync(manual, before.replace("# 查到底", "# 查到底 <!-- p:0042 -->"));
    assert.equal(numbers()[0], "通用/工作/查到底.md 0001");
    writeFileSync(manual, before);
    // the kept file lost: the table gives the same number back
    rmSync(join(root, KEPT_IDS));
    run(2000);
    assert.deepEqual(numbers(), ["通用/工作/查到底.md 0001", "通用/验收/一.md 0002"]);
    assert.equal(kvGet(db, "learn.next"), "3");
    assert.deepEqual(items(db).map((x) => `${x.id} ${x.rel} ${x.gone}`), ["0001 通用/工作/查到底.md null", "0002 通用/验收/一.md null"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(code, { recursive: true, force: true });
  }
});

test("编号：重复的重新发号", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"], " <!-- p:0007 -->").replace("甲", "甲 <!-- l:0001 -->"),
    "通用/验收/二.md": page("二", ["乙"], " <!-- p:0007 p:0020 -->").replace("乙", "乙 <!-- l:0001 -->"),
  });
  try {
    const db = openDb(":memory:");
    assert.ok(scanShelf(root, GEN, ARCH).problems.some((m) => m.includes("p:0007") && m.includes("重复")), "扫描先报出重复");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    // 第二个出现的换新号；号从所有见过的号（含别名 0020）后面发
    assert.deepEqual(r, {
      pages: 1, lessons: 1, skipped: [], aliases: 1,
      renumbered: ["通用/验收/二.md p:0007→p:0021", "通用/验收/二.md l:0001→l:0022"],
    });
    assert.match(read(root, "通用/验收/一.md"), /^# 一 <!-- p:0007 -->\n[^]*- 教训：甲 <!-- l:0001 -->\n$/, "第一个出现的不动");
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0021 p:0020 -->\n/, "只换第一个号，后面带的旧号原样");
    assert.match(read(root, "通用/验收/二.md"), /- 教训：乙 <!-- l:0022 -->\n$/);
    assert.deepEqual(scanShelf(root, GEN, ARCH).problems, []);
    assert.equal(resolveId(db, "0020"), "0021");
    assert.deepEqual(items(db).map((x) => `${x.id}:${x.rel}`), [
      "0001:通用/验收/一.md", "0007:通用/验收/一.md", "0021:通用/验收/二.md", "0022:通用/验收/二.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：拿旧页当模板抄出新页（连号一起抄了）——号留给原来那页，抄的那份换新号", () => {
  // 11-02 她复制「验收和核实」新建「旁人验证」，p:0109 一起抄过去；新页排在前面，按扫描顺序号归了新页，老页反倒换了号
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/b-验收和核实.md": page("验收和核实", ["甲"], " <!-- p:0007 -->").replace("甲", "甲 <!-- l:0001 -->"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    writeFileSync(join(root, "通用/验收/a-旁人验证.md"), page("旁人验证", ["甲"], " <!-- p:0007 -->").replace("甲", "甲 <!-- l:0001 -->"));
    const r = assignIds(root, db, { now: () => T + 1000, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r.renumbered, ["通用/验收/a-旁人验证.md p:0007→p:0008", "通用/验收/a-旁人验证.md l:0001→l:0009"]);
    assert.match(read(root, "通用/验收/b-验收和核实.md"), /^# 验收和核实 <!-- p:0007 -->\n[^]*- 教训：甲 <!-- l:0001 -->\n$/, "原来那页一个字节不动");
    assert.match(read(root, "通用/验收/a-旁人验证.md"), /^# 旁人验证 <!-- p:0008 -->\n[^]*- 教训：甲 <!-- l:0009 -->\n$/);
    assert.deepEqual(items(db).map((x) => `${x.id}:${x.rel}`), [
      "0001:通用/验收/b-验收和核实.md", "0007:通用/验收/b-验收和核实.md", "0008:通用/验收/a-旁人验证.md", "0009:通用/验收/a-旁人验证.md",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：抄过去的号行上带着旧别名——别名也还归原来那页，不跟着抄的那份走", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/b.md": page("验收和核实", [], " <!-- p:0007 p:0042 -->"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(resolveId(db, "0042"), "0007");
    writeFileSync(join(root, "通用/验收/a.md"), page("旁人验证", [], " <!-- p:0007 p:0042 -->"));
    const r = assignIds(root, db, { now: () => T + 1000, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r.renumbered, ["通用/验收/a.md p:0007→p:0043"]);
    assert.equal(resolveId(db, "0042"), "0007");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：整页挪了地方又留了一份抄的——号跟着内容没变的那份走", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/a.md": page("看成片", [], " <!-- p:0007 -->"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    renameSync(join(root, "通用/验收/a.md"), join(root, "通用/验收/c.md"));
    writeFileSync(join(root, "通用/验收/b.md"), page("看成片的新想法", [], " <!-- p:0007 -->"));
    const r = assignIds(root, db, { now: () => T + 1000, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r.renumbered, ["通用/验收/b.md p:0007→p:0008"]);
    assert.deepEqual(items(db).map((x) => `${x.id}:${x.rel}`), ["0007:通用/验收/c.md", "0008:通用/验收/b.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：归档里的文件一个字节都不动——没号的不发号，和活页重号的号归活页；归档里已有的号照认", () => {
  const archived = {
    "通用/验收/归档/看成片.md": page("看成片（旧）", ["旧教训"], " <!-- p:0007 -->"),
    "通用/验收/归档/另一页.md": page("另一页", ["没号的旧教训"]),
    "通用/验收/归档/挪进来的.md": page("挪进来的", [], " <!-- p:0003 -->"),
    "归档/搬家前-20261101/MAP.md": "# 知识地图\n简介：a\n什么时候翻：b\n",
  };
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/看成片.md": page("看成片", [], " <!-- p:0007 -->"),
    "通用/验收/新页.md": page("新页"),
    ...archived,
  });
  try {
    const db = openDb(":memory:");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 1, lessons: 0, skipped: [], aliases: 0 });
    assert.match(read(root, "通用/验收/看成片.md"), /^# 看成片 <!-- p:0007 -->\n/, "活页留着原号，虽然归档那份先扫到");
    assert.match(read(root, "通用/验收/新页.md"), /^# 新页 <!-- p:0008 -->\n/);
    for (const [rel, text] of Object.entries(archived)) assert.equal(read(root, rel), text, `${rel} 没被改`);
    assert.deepEqual(items(db).map((x) => `${x.id}:${x.rel}`), ["0003:通用/验收/归档/挪进来的.md", "0007:通用/验收/看成片.md", "0008:通用/验收/新页.md"]);
    assert.ok(knownIds(db).has("0003"), "整页挪进归档的，号还认得");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：一行带几个号，后面的记成别名", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲 <!-- l:0039 l:0041 -->"], " <!-- p:0001 -->"),
  });
  try {
    const db = openDb(":memory:");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 0, lessons: 0, skipped: [], aliases: 1 });
    assert.equal(resolveId(db, "0041"), "0039");
    assert.equal(resolveId(db, "0039"), "0039", "不是别名原样返回");
    assert.equal(resolveId(db, "0777"), "0777");
    assert.deepEqual(items(db).map((x) => x.id), ["0001", "0039"], "别名不进 learn_item");
    assert.deepEqual(knownIds(db), new Set(["0001", "0039", "0041"]));
    assert.equal(assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH }).aliases, 0, "没变就不重复记");
    // 号从别名后面发
    writeFileSync(join(root, "通用/验收/二.md"), page("二"));
    assert.equal(assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH }).pages, 1);
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0042 -->/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：一条带别名的教训删掉了，它的别名也不再算认得的号", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲 <!-- l:0039 l:0041 -->"], " <!-- p:0001 -->"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(knownIds(db), new Set(["0001", "0039", "0041"]));
    writeFileSync(join(root, "通用/验收/一.md"), page("一", [], " <!-- p:0001 -->"));
    assignIds(root, db, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(items(db).find((x) => x.id === "0039")!.gone, T + 1);
    assert.deepEqual(knownIds(db), new Set(["0001"]), "0039 没了，指向它的 0041 也不认");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：合并两次，旧别名跟着指向最后留下的；别名不会盖住还活着的号", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲 <!-- l:0039 l:0041 -->"], " <!-- p:0001 -->"),
    "通用/验收/二.md": page("二", ["乙 <!-- l:0050 -->"], " <!-- p:0002 -->"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    // 0039 再被并进 0050：行上写 l:0050 l:0039
    writeFileSync(join(root, "通用/验收/一.md"), page("一", [], " <!-- p:0001 -->"));
    writeFileSync(join(root, "通用/验收/二.md"), page("二", ["乙 <!-- l:0050 l:0039 -->"], " <!-- p:0002 -->"));
    const r = assignIds(root, db, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(r.aliases, 2, "0039 新记，0041 改指向");
    assert.equal(resolveId(db, "0041"), "0050");
    assert.equal(resolveId(db, "0039"), "0050");
    assert.equal(items(db).find((x) => x.id === "0039")!.gone, T + 1, "合并掉的那条标 gone");
    assert.deepEqual(knownIds(db), new Set(["0001", "0002", "0050", "0039", "0041"]));

    // 别名号又被人写成了另一条自己的号（比如拆回来）：活的号优先，别名先不记
    writeFileSync(join(root, "通用/验收/一.md"), page("一", ["丙 <!-- l:0041 -->"], " <!-- p:0001 -->"));
    assignIds(root, db, { now: () => T + 2, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(resolveId(db, "0041"), "0041");
    assert.ok(knownIds(db).has("0041") && knownIds(db).has("0039"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：最近改过的文件这次不写，进 skipped，过了安静期再补", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "通用/验收/二.md": page("二", ["乙"]),
    "通用/验收/三.md": page("三", [], " <!-- p:0003 -->"),
  });
  try {
    const db = openDb(":memory:");
    const touch = (rel: string, at: number) => utimesSync(join(root, rel), new Date(at), new Date(at));
    touch("通用/验收/一.md", T - 119_000);
    touch("通用/验收/二.md", T - 121_000);
    touch("通用/验收/三.md", T - 1000); // 刚改过，但本来就不缺号：不用写，也不算跳过
    const before = read(root, "通用/验收/一.md");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r.skipped, ["通用/验收/一.md"]);
    assert.deepEqual([r.pages, r.lessons], [1, 1]);
    assert.equal(read(root, "通用/验收/一.md"), before, "没动");
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0004 -->[^]*<!-- l:0005 -->/, "安静期外的照常写，跳过的不占号");
    assert.deepEqual(items(db).map((x) => x.rel).sort(), ["通用/验收/三.md", "通用/验收/二.md", "通用/验收/二.md"].sort());

    const r2 = assignIds(root, db, { now: () => T + 10_000, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r2, { pages: 1, lessons: 1, skipped: [], aliases: 0 });
    assert.match(read(root, "通用/验收/一.md"), /^# 一 <!-- p:0006 -->[^]*<!-- l:0007 -->/);

    // quietMs 可以调
    writeFileSync(join(root, "通用/验收/四.md"), page("四"));
    assert.deepEqual(assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH, quietMs: 1e9 }).skipped, ["通用/验收/四.md"]);
    assert.equal(assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH, quietMs: 0 }).pages, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：读和写之间文件被别人改了，放弃这个文件，不留临时文件", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "通用/验收/二.md": page("二", ["乙"]),
  });
  const orig = fs.writeFileSync;
  try {
    const db = openDb(":memory:");
    const target = join(root, "通用/验收/一.md");
    const edited = `${read(root, "通用/验收/一.md")}- 教训：她刚追加的\n`;
    // 写临时文件的时候，她正好改了一一.md（内容变、mtime 变）
    mock.method(fs, "writeFileSync", (path: string, ...rest: unknown[]) => {
      if (String(path).includes("一.md") && String(path) !== target) {
        orig(target, edited);
        utimesSync(target, new Date(T - 500_000), new Date(T - 500_000));
      }
      return (orig as (...a: unknown[]) => void)(path, ...rest);
    });
    syncBuiltinESMExports();

    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r.skipped, ["通用/验收/一.md"]);
    assert.deepEqual([r.pages, r.lessons], [1, 1], "只有二.md 写成");
    assert.equal(read(root, "通用/验收/一.md"), edited, "她的改动原样留着");
    assert.deepEqual(readdirSync(join(root, "通用/验收")).sort(), ["SKILL.md", "一.md", "二.md"].sort(), "临时文件清掉了");
    assert.deepEqual(items(db).map((x) => x.rel), ["通用/验收/二.md", "通用/验收/二.md"]);
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0001 -->[^]*<!-- l:0002 -->/, "放弃的那份没占号");
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：扫描之后、读之前文件变了（教训行数不一样了），这次不写", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
  });
  const real = fs.realpathSync;
  try {
    const db = openDb(":memory:");
    const target = join(root, "通用/验收/一.md");
    const edited = `${read(root, "通用/验收/一.md")}- 教训：她刚追加的\n`;
    mock.method(fs, "realpathSync", (path: string, ...rest: unknown[]) => {
      writeFileSync(target, edited); // 扫描已经过去，这是 rewrite 要读之前的一刻
      utimesSync(target, new Date(T - 500_000), new Date(T - 500_000));
      return (real as (...a: unknown[]) => string)(path, ...rest);
    });
    syncBuiltinESMExports();
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 0, lessons: 0, skipped: ["通用/验收/一.md"], aliases: 0 });
    assert.equal(read(root, "通用/验收/一.md"), edited);
    assert.equal(items(db).length, 0);

    // 下一次扫描看到新的样子，正常补号
    mock.restoreAll();
    syncBuiltinESMExports();
    assert.deepEqual(assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH }), { pages: 1, lessons: 2, skipped: [], aliases: 0 });
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：同一个文件从两条路径都走得到（链接的本、链接的页），号不会每次扫描都重发，条目只有一份", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "形象/占位.txt": "x",
  });
  symlinkSync(join(root, "通用/验收"), join(root, "形象/验收")); // 整本链到另一个大类下面
  symlinkSync(join(root, "通用/验收/一.md"), join(root, "通用/验收/一链.md")); // 同一本里一页链了两次
  try {
    assert.equal(scanShelf(root, GEN, ARCH).pages.length, 4, "扫描有意跟着链接走，同一份内容出现在几条路径下");
    const db = openDb(":memory:");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 1, lessons: 1, skipped: [], aliases: 0 });
    const text = read(root, "通用/验收/一.md");
    assert.equal(text, "# 一 <!-- p:0001 -->\n简介：a\n什么时候翻：b\n\n## 教训\n- 教训：甲 <!-- l:0002 -->\n");
    const rows = items(db);
    assert.deepEqual(rows.map((x) => x.id), ["0001", "0002"], "每条只有一行，不是每条路径一行");
    const rels = rows.map((x) => x.rel);

    for (let i = 1; i <= 4; i++) {
      const again = assignIds(root, db, { now: () => T + i, generalCategory: GEN, archiveDir: ARCH });
      assert.deepEqual(again, { pages: 0, lessons: 0, skipped: [], aliases: 0 }, `第 ${i} 次再扫`);
      assert.equal(read(root, "通用/验收/一.md"), text, "文件不再变");
      assert.deepEqual(items(db).map((x) => [x.id, x.rel, x.gone]), [["0001", rels[0], null], ["0002", rels[1], null]]);
    }
    assert.equal(kvGet(db, "learn.next"), "3");
    assert.deepEqual(knownIds(db), new Set(["0001", "0002"]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：消失的标 gone 不删行，改名搬家的跟着号走，改了内容 hash 变", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲", "乙"]),
    "通用/验收/二.md": page("二"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    const first = new Map(items(db).map((x) => [x.id, x]));
    assert.equal(first.size, 4);

    // 乙（0003）删掉，甲（0002）改字，二.md 搬到别的本
    const one = read(root, "通用/验收/一.md").split("\n").filter((l) => !l.includes("乙")).join("\n").replace("教训：甲", "教训：甲改了");
    writeFileSync(join(root, "通用/验收/一.md"), one);
    mkdirSync(join(root, "通用/新本"), { recursive: true });
    writeFileSync(join(root, "通用/新本/SKILL.md"), COVER);
    renameSync(join(root, "通用/验收/二.md"), join(root, "通用/新本/二二.md"));

    const r = assignIds(root, db, { now: () => T + 5000, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(r, { pages: 0, lessons: 0, skipped: [], aliases: 0 });
    const now = new Map(items(db).map((x) => [x.id, x]));
    assert.equal(now.size, 4, "行都还在");
    assert.equal(now.get("0003")!.gone, T + 5000);
    assert.equal(now.get("0003")!.last_seen, T, "gone 的 last_seen 停在最后看到的时候");
    assert.equal(now.get("0002")!.gone, null);
    assert.notEqual(now.get("0002")!.hash, first.get("0002")!.hash, "改了字 hash 变");
    assert.equal(now.get("0001")!.hash, first.get("0001")!.hash);
    assert.equal(now.get("0004")!.rel, "通用/新本/二二.md", "搬家后路径更新，号不变");
    assert.equal(now.get("0004")!.first_seen, T);
    assert.deepEqual(knownIds(db), new Set(["0001", "0002", "0004"]), "gone 的不算在世");

    // 又回来了：gone 清掉
    writeFileSync(join(root, "通用/验收/一.md"), read(root, "通用/验收/一.md") + "- 教训：乙 <!-- l:0003 -->\n");
    assignIds(root, db, { now: () => T + 9000, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(items(db).find((x) => x.id === "0003")!.gone, null);
    assert.ok(knownIds(db).has("0003"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：整本或单页挪进大类、书架那层的归档，号还认得", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "做事/剪辑/SKILL.md": COVER,
    "做事/剪辑/二.md": page("二", ["乙"]),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(knownIds(db), new Set(["0001", "0002", "0003", "0004"]));
    // 验收整本进书架那层的归档；二.md 进做事大类的归档
    mkdirSync(join(root, "归档"));
    renameSync(join(root, "通用/验收"), join(root, "归档/验收"));
    mkdirSync(join(root, "做事/归档/剪辑"), { recursive: true });
    renameSync(join(root, "做事/剪辑/二.md"), join(root, "做事/归档/剪辑/二.md"));
    assignIds(root, db, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(knownIds(db), new Set(["0001", "0002", "0003", "0004"]), "归档的号都还认得");
    assert.ok(items(db).every((x) => x.gone === null));
    assert.deepEqual(items(db).map((x) => x.rel).sort(), ["归档/验收/一.md", "归档/验收/一.md", "做事/归档/剪辑/二.md", "做事/归档/剪辑/二.md"].sort());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：文件还在、只是这次扫描没走到（大类目录里多了 SKILL.md），条目不标 gone；文件真没了才标", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "做事/剪辑/SKILL.md": COVER,
    "做事/剪辑/二.md": page("二"),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(items(db).length, 3);
    // 大类目录直接带 SKILL.md 会被当成旧的一层手册跳过，里面的页这次扫不到，但文件都还在
    writeFileSync(join(root, "通用/SKILL.md"), COVER);
    assignIds(root, db, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    assert.ok(items(db).every((x) => x.gone === null), "没走到的不算没了");
    assert.deepEqual(knownIds(db), new Set(["0001", "0002", "0003"]));
    // 文件真删了：标 gone
    rmSync(join(root, "通用/验收/一.md"));
    assignIds(root, db, { now: () => T + 2, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(items(db).filter((x) => x.gone !== null).map((x) => x.rel), ["通用/验收/一.md", "通用/验收/一.md"]);
    assert.equal(items(db).filter((x) => x.gone === null).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：书架读不了的时候不把任何东西标 gone", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲"]),
    "通用/验收/二.md": page("二", ["乙"]),
  });
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.equal(items(db).length, 4);

    // 一个文件读不了（链接断了）：只有它的几条不动，别的照常
    rmSync(join(root, "通用/验收/一.md"));
    symlinkSync(join(root, "不存在"), join(root, "通用/验收/一.md"));
    writeFileSync(join(root, "通用/验收/二.md"), read(root, "通用/验收/二.md").split("\n").filter((l) => !l.includes("乙")).join("\n"));
    assignIds(root, db, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    const gone = (rel: string) => items(db).filter((x) => x.rel === rel).map((x) => x.gone);
    assert.deepEqual(gone("通用/验收/一.md"), [null, null], "读不了的文件里的条目不标 gone");
    assert.deepEqual(gone("通用/验收/二.md"), [null, T + 1], "读得了的照常：乙删了就 gone");

    // 本的封面没了，这本的页暂时不在书架上：也不标 gone
    rmSync(join(root, "通用/验收/SKILL.md"));
    assignIds(root, db, { now: () => T + 2, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual(gone("通用/验收/二.md"), [null, T + 1], "没封面的本里的条目不动（0004 还是上次标的时间）");

    // 整个书架目录读不了：什么都不动
    const db2 = openDb(":memory:");
    assert.deepEqual(assignIds(join(root, "不存在"), db2, { now: () => T, generalCategory: GEN, archiveDir: ARCH }), { pages: 0, lessons: 0, skipped: [], aliases: 0 });
    assignIds(root, db2, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assignIds(join(root, "不存在"), db2, { now: () => T + 1, generalCategory: GEN, archiveDir: ARCH });
    assert.ok(items(db2).every((x) => x.gone === null));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：CRLF、BOM、行尾空格、没有结尾换行的文件，除了补的注释一个字节不动", () => {
  const crlf = "\uFEFF# 标题\r\n简介：a\r\n什么时候翻：b\r\n\r\n## 教训\r\n- 教训：甲  \r\n- 教训：乙｜下次：丙 <!-- l:0009 -->\r\n\r\n## 相关\r\n- 别的\r\n";
  const tail = "# 无换行\n## 教训\n- 教训：尾巴";
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": crlf,
    "通用/验收/二.md": tail,
  });
  chmodSync(join(root, "通用/验收/一.md"), 0o664);
  try {
    const db = openDb(":memory:");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.deepEqual([r.pages, r.lessons], [2, 2]);
    assert.equal(
      readFileSync(join(root, "通用/验收/一.md"), "utf8"),
      "\uFEFF# 标题 <!-- p:0010 -->\r\n简介：a\r\n什么时候翻：b\r\n\r\n## 教训\r\n- 教训：甲  <!-- l:0011 -->\r\n- 教训：乙｜下次：丙 <!-- l:0009 -->\r\n\r\n## 相关\r\n- 别的\r\n",
    );
    assert.equal(readFileSync(join(root, "通用/验收/二.md"), "utf8"), "# 无换行 <!-- p:0012 -->\n## 教训\n- 教训：尾巴 <!-- l:0013 -->");
    assert.ok(parsePage(readFileSync(join(root, "通用/验收/一.md"), "utf8"), "a/b/c.md", GEN, ARCH).lessons[0]!.ids[0] === "0011");
    assert.equal(statSync(join(root, "通用/验收/一.md")).mode & 0o777, 0o664, "权限保持");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("编号：号从 learn.next 和所有见过的号里取大的往后发；没有标题行的页只给教训编号；不是 UTF-8 的文件不动", () => {
  const bad = Buffer.concat([Buffer.from("# 坏\n## 教训\n- 教训：x\n"), Buffer.from([0xff, 0xfe, 0x0a])]);
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一", ["甲 <!-- l:0039 -->"], " <!-- p:0012 -->"),
    "通用/验收/二.md": page("二"),
    "通用/验收/无标题.md": "简介：a\n## 教训\n- 教训：没有标题行\n",
  });
  writeFileSync(join(root, "通用/验收/坏.md"), bad);
  try {
    const db = openDb(":memory:");
    kvSet(db, "learn.next", "5");
    const r = assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0040 -->/, "文件里最大是 0039，kv 的 5 小，取 0040");
    assert.match(read(root, "通用/验收/无标题.md"), /- 教训：没有标题行 <!-- l:0041 -->\n$/);
    assert.ok(!read(root, "通用/验收/无标题.md").includes("p:"), "没有标题行放不了页号");
    assert.deepEqual(r.skipped, ["通用/验收/坏.md"]);
    assert.ok(readFileSync(join(root, "通用/验收/坏.md")).equals(bad), "原样");
    assert.equal(kvGet(db, "learn.next"), "42");

    kvSet(db, "learn.next", "100");
    writeFileSync(join(root, "通用/验收/三.md"), page("三"));
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    assert.match(read(root, "通用/验收/三.md"), /^# 三 <!-- p:0100 -->/, "kv 比文件里的大就用 kv");
    assert.equal(kvGet(db, "learn.next"), "101");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Decisions 客户端 ----

type DecisionsBody = { model: string; input: string; questions: Array<{ type: string; name: string; instructions: string }> };

// 假 Decisions：按请求里的题回答；refuse 里的 name 拒答，其余按 prob 给概率；每次请求的 input_tokens 固定
function fakeDecisions(o: { prob?: (name: string) => number; refuse?: string[]; tokens?: number; fail?: (call: number) => Response | null } = {}) {
  const calls: Array<{ url: string; init: RequestInit; body: DecisionsBody }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as DecisionsBody;
    calls.push({ url, init, body });
    const bad = o.fail?.(calls.length);
    if (bad) return bad;
    const answers = body.questions.map((q) =>
      o.refuse?.includes(q.name) ? { name: q.name, type: "refusal" } : { name: q.name, type: "predicate", probability: (o.prob ?? (() => 0.5))(q.name) });
    return new Response(JSON.stringify({ answers, usage: { input_tokens: o.tokens ?? 100, output_tokens: 7 } }), { status: 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const SH_NOON = Date.parse("2026-11-01T12:00:00+08:00");
const TOPIC = "她正要回应或开始做：发 B 站评论\n每题问：这件事需要翻这一页笔记吗？只有正好讲这类事的做法或教训才算。";

test("Decisions：请求照格式发，概率按 name 取，拒答当 0", async () => {
  const db = openDb(":memory:");
  const f = fakeDecisions({ prob: (n) => (n === "p0012" ? 0.83 : 0.2), refuse: ["p0020"], tokens: 123 });
  const d = new OpenAIDecisions({ key: "sk-test", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => SH_NOON, dailyUsd: 1 });
  const r = await d.judge(TOPIC, [
    { name: "p0012", text: "需要翻「形象制作 · 分层生图：拆层、生图的做法和踩过的坑」吗？" },
    { name: "p0020", text: "需要翻「别的」吗？" },
    { name: "correction", text: "这条是在纠正或否定她刚做的事吗？" },
  ]);
  assert.equal(f.calls.length, 1);
  const c = f.calls[0]!;
  assert.equal(c.url, "https://api.openai.com/v1/decisions");
  assert.equal(c.init.method, "POST");
  assert.equal((c.init.headers as Record<string, string>).Authorization, "Bearer sk-test");
  assert.ok(c.init.signal, "整个请求有超时");
  assert.equal(c.body.model, "gpt-6-luna");
  assert.equal(c.body.input, TOPIC);
  assert.equal(c.body.questions[0]!.type, "predicate");
  assert.deepEqual(c.body.questions[0], { type: "predicate", name: "p0012", instructions: "需要翻「形象制作 · 分层生图：拆层、生图的做法和踩过的坑」吗？" });
  assert.deepEqual([...r!.p], [["p0012", 0.83], ["p0020", 0], ["correction", 0.2]]);
  assert.equal(r!.tokens, 123);
  assert.equal(d.broken, false);
  assert.equal(d.lastError, "");
});

test("Decisions：超过 400 题分批并发，token 相加，花费记进她那天的 kv", async () => {
  const db = openDb(":memory:");
  const f = fakeDecisions({ tokens: 1000 });
  // 北京时间 11-01 01:00 = UTC 10-31 17:00：日子按她的时区算
  const at = Date.parse("2026-10-31T17:00:00Z");
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => at, dailyUsd: 1 });
  const qs = Array.from({ length: 450 }, (_, i) => ({ name: `p${String(i).padStart(4, "0")}`, text: `第${i}页吗？` }));
  const r = await d.judge(TOPIC, qs);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map((c) => c.body.questions.length).sort((a, b) => a - b), [50, 400]);
  assert.ok(f.calls.every((c) => c.body.input === TOPIC), "每批都带话题");
  assert.equal(r!.tokens, 2000);
  assert.equal(r!.p.size, 450);
  assert.equal(r!.p.get("p0449"), 0.5);
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "2000");
  assert.equal(kvGet(db, "learn.spend.2026-10-31"), undefined);

  const r2 = await d.judge(TOPIC, [{ name: "p0001", text: "吗？" }]);
  assert.equal(r2!.tokens, 1000);
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "3000", "同一天累加");
});

test("Decisions：没有题不发请求；一批失败整次返回 null，成功那批的花费照记", async () => {
  const db = openDb(":memory:");
  const f = fakeDecisions({ tokens: 500, fail: (n) => (n === 2 ? new Response("boom", { status: 500 }) : null) });
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => SH_NOON, dailyUsd: 1 });
  const empty = await d.judge(TOPIC, []);
  assert.deepEqual(empty, { p: new Map(), tokens: 0, ms: 0 });
  assert.equal(f.calls.length, 0);

  const qs = Array.from({ length: 401 }, (_, i) => ({ name: `p${i}`, text: "吗？" }));
  assert.equal(await d.judge(TOPIC, qs), null);
  assert.equal(f.calls.length, 2);
  assert.match(d.lastError, /HTTP 500 boom/);
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "500", "发出去并成功的那批已经收了钱");
});

test("Decisions：回答缺题、没有用量、不是 JSON 都当失败", async () => {
  const db = openDb(":memory:");
  const mk = (payload: unknown) =>
    new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", now: () => SH_NOON, dailyUsd: 1,
      fetchImpl: (async () => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch });
  const q = [{ name: "a", text: "吗？" }, { name: "b", text: "吗？" }];
  const d1 = mk({ answers: [{ name: "a", type: "predicate", probability: 0.9 }], usage: { input_tokens: 10 } });
  assert.equal(await d1.judge(TOPIC, q), null);
  assert.match(d1.lastError, /b/);
  const d2 = mk({ answers: [{ name: "a", type: "predicate", probability: 0.9 }, { name: "b", type: "predicate", probability: 0.1 }] });
  assert.equal(await d2.judge(TOPIC, q), null);
  assert.match(d2.lastError, /usage/);
  const d3 = mk("<html>");
  assert.equal(await d3.judge(TOPIC, q), null);
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), undefined, "失败的不记花费");
});

test("Decisions：超时管整个调用，超时算一次失败；错误里不带 key", async () => {
  const db = openDb(":memory:");
  let calls = 0;
  const hang: typeof fetch = (_u, init) => { calls += 1; return new Promise((_r, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted")))); };
  const d = new OpenAIDecisions({ key: "sk-secret", db, tz: "Asia/Shanghai", fetchImpl: hang, now: () => SH_NOON, dailyUsd: 1, timeoutMs: 5_000 });
  const qs = Array.from({ length: 450 }, (_, i) => ({ name: `p${i}`, text: "吗？" }));
  const t = Date.now();
  assert.equal(await d.judge(TOPIC, qs, { timeoutMs: 40 }), null, "调用时给的超时优先");
  assert.ok(Date.now() - t < 10_000, `两批都超时就回来，不卡死（只防卡死；墙钟在机器忙时会慢，11-14 部署前检查里 1 秒的界挂过（1.3 秒），别卡太紧）`);
  assert.equal(calls, 2);

  const leaky: typeof fetch = (async () => new Response('{"error":"Incorrect API key provided: sk-secret"}', { status: 401 })) as unknown as typeof fetch;
  const d2 = new OpenAIDecisions({ key: "sk-secret", db, tz: "Asia/Shanghai", fetchImpl: leaky, now: () => SH_NOON, dailyUsd: 1 });
  assert.equal(await d2.judge(TOPIC, [{ name: "a", text: "吗？" }]), null);
  assert.match(d2.lastError, /HTTP 401/);
  assert.ok(!d2.lastError.includes("sk-secret"), "key 不进错误");
});

test("Decisions：真实长度的 key 被错误正文回显、正好跨过第 200 个字符，lastError 和告警里也不留任何一段", async () => {
  const db = openDb(":memory:");
  const key = "sk-proj-" + Array.from({ length: 152 }, (_, i) => "abcdefghijklmnopqrstuvwxyz0123456789"[(i * 7) % 36]).join("");
  assert.equal(key.length, 160);
  // 正文里 key 从第 60 个字符开始，跨过 "HTTP 401 " + 正文 的第 200 个字符
  const body = JSON.stringify({ error: { message: `Incorrect API key provided: ${key}. You can find your API key at https://platform.openai.com.` } });
  assert.ok(body.indexOf(key) < 200 && body.indexOf(key) + key.length > 200, "key 跨过第 200 个字符");
  const leaky = (async () => new Response(body, { status: 401 })) as unknown as typeof fetch;
  const alerts: string[] = [];
  let t = SH_NOON;
  const d = new OpenAIDecisions({ key, db, tz: "Asia/Shanghai", fetchImpl: leaky, now: () => t, dailyUsd: 1, onAlert: (m) => alerts.push(m) });
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 3; i++) assert.equal(await d.judge(TOPIC, [{ name: "a", text: "吗？" }]), null);
    t += 10 * 60_000 + 1;
  }
  assert.equal(alerts.length, 1, "熔断连开 3 次，告警了");
  assert.match(d.lastError, /HTTP 401/);
  assert.ok(d.lastError.length <= 200);
  for (const text of [d.lastError, alerts[0]!]) {
    for (let i = 0; i + 40 <= key.length; i++) assert.ok(!text.includes(key.slice(i, i + 40)), `key 的第 ${i} 位起 40 个字符不该出现`);
  }
});

test("Decisions：连续 3 次失败熔断 10 分钟，期间不发请求，过了再试", async () => {
  const db = openDb(":memory:");
  let t = SH_NOON;
  let down = true;
  const f = fakeDecisions({ fail: () => (down ? new Response("x", { status: 500 }) : null) });
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => t, dailyUsd: 1 });
  const q = [{ name: "a", text: "吗？" }];
  for (let i = 0; i < 3; i++) assert.equal(await d.judge(TOPIC, q), null);
  assert.equal(f.calls.length, 3);
  assert.equal(d.broken, true);
  assert.equal(await d.judge(TOPIC, q), null, "第 4 次直接 null");
  assert.equal(f.calls.length, 3, "熔断中不发请求");
  t += 10 * 60_000 + 1;
  assert.equal(d.broken, false);
  down = false;
  assert.ok(await d.judge(TOPIC, q));
  assert.equal(f.calls.length, 4);
});

test("Decisions：失败、熔断打开、恢复都记日志（失败一分钟最多一条，不刷屏；不带 key）", async () => {
  const db = openDb(":memory:");
  let t = SH_NOON;
  let down = true;
  const f = fakeDecisions({ fail: () => (down ? new Response("bad key sk-secret", { status: 401 }) : null) });
  const logs: LogRecord[] = [];
  const d = new OpenAIDecisions({ key: "sk-secret", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => t, dailyUsd: 1, log: new Logger("test", memorySink(logs)) });
  const q = [{ name: "a", text: "吗？" }];
  const msgs = () => logs.map((l) => `${l.level}:${l.msg}`);
  await d.judge(TOPIC, q);
  await d.judge(TOPIC, q);
  assert.deepEqual(msgs(), ["warn:learning: judge failed"], "第二次失败离上一条不到一分钟，不再记");
  assert.match(String(logs[0]!.error), /HTTP 401/);
  assert.ok(!JSON.stringify(logs).includes("sk-secret"), "日志里不带 key");
  await d.judge(TOPIC, q);
  assert.deepEqual(msgs().slice(1), ["warn:learning: judge breaker open"], "熔断打开一定记");
  assert.equal(logs[1]!.until, new Date(SH_NOON + 10 * 60_000).toISOString());
  t += 10 * 60_000 + 1;
  down = false;
  assert.ok(await d.judge(TOPIC, q));
  assert.deepEqual(msgs().slice(2), ["info:learning: judge recovered"]);
  assert.ok(await d.judge(TOPIC, q));
  assert.equal(logs.length, 3, "一直好着不记");
  // 后台的失败也记（同样限流）
  down = true;
  t += 61_000;
  await d.judge(TOPIC, q, { background: true });
  assert.deepEqual(msgs().slice(3), ["warn:learning: judge failed"]);
  assert.equal(logs[3]!.background, true);
});

test("Decisions：超过每日上限返回 null、当天只告警一次，第二天恢复", async () => {
  const db = openDb(":memory:");
  const alerts: string[] = [];
  let t = SH_NOON;
  const f = fakeDecisions({ tokens: 100 });
  // 0.000001 美元 = 10 token：第一次发得出去（还没到上限），100 token 记账后就到了
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => t, dailyUsd: 0.000001, onAlert: (m) => alerts.push(m) });
  const q = [{ name: "a", text: "吗？" }];
  assert.ok(await d.judge(TOPIC, q));
  assert.deepEqual(alerts, []);
  assert.equal(await d.judge(TOPIC, q), null);
  assert.equal(await d.judge(TOPIC, q), null);
  assert.equal(f.calls.length, 1, "到上限后不再发请求");
  assert.equal(alerts.length, 1, "当天只告警一次");
  assert.match(alerts[0]!, /上限/);
  assert.equal(d.broken, false, "超上限不是故障，不进熔断");
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "100");

  t += 24 * 3_600_000;
  assert.ok(await d.judge(TOPIC, q), "第二天重新算");
  assert.equal(await d.judge(TOPIC, q), null);
  assert.equal(alerts.length, 2, "新的一天再告警一次");
});

test("Decisions：熔断连开 3 次（一直没成功）告警一次；中间成功过就重新数", async () => {
  const db = openDb(":memory:");
  const alerts: string[] = [];
  let t = SH_NOON;
  let down = true;
  const f = fakeDecisions({ fail: () => (down ? new Response("x", { status: 503 }) : null) });
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => t, dailyUsd: 1, onAlert: (m) => alerts.push(m) });
  const q = [{ name: "a", text: "吗？" }];
  // 把熔断打开一次：3 次失败，然后等它过期
  const open = async () => {
    for (let i = 0; i < 3; i++) await d.judge(TOPIC, q);
    assert.equal(d.broken, true);
    t += 10 * 60_000 + 1;
  };
  await open();
  await open();
  assert.deepEqual(alerts, [], "才开了两次");
  down = false;
  assert.ok(await d.judge(TOPIC, q));
  down = true;
  await open();
  await open();
  assert.deepEqual(alerts, [], "中间成功过，重新数");
  await open();
  assert.equal(alerts.length, 1);
  assert.match(alerts[0]!, /30 分钟/);
  await open();
  assert.equal(alerts.length, 1, "还没好也不再重复告警");
});

test("Decisions：spentRate 是今天（她的日子）花到每日上限的几成；上限 0 给 0", async () => {
  const db = openDb(":memory:");
  kvSet(db, "learn.spend.2026-11-01", "8000000");   // 0.8 美元
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: fakeDecisions().fetchImpl, now: () => SH_NOON, dailyUsd: 1 });
  assert.ok(Math.abs(d.spentRate() - 0.8) < 1e-9);
  assert.equal(new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: fakeDecisions().fetchImpl, now: () => SH_NOON + 86_400_000, dailyUsd: 1 }).spentRate(), 0, "第二天从 0 算");
  assert.equal(new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: fakeDecisions().fetchImpl, now: () => SH_NOON, dailyUsd: 0 }).spentRate(), 0);
});

test("Decisions：后台的判断（回测）失败不算进熔断、不告警；花费照记，上限照管", async () => {
  const db = openDb(":memory:");
  const alerts: string[] = [];
  const f = fakeDecisions({ fail: () => new Response("x", { status: 500 }) });
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f.fetchImpl, now: () => SH_NOON, dailyUsd: 1, onAlert: (m) => alerts.push(m) });
  const q = [{ name: "a", text: "吗？" }];
  for (let i = 0; i < 9; i++) assert.equal(await d.judge(TOPIC, q, { background: true }), null);
  assert.equal(f.calls.length, 9);
  assert.equal(d.broken, false);
  assert.match(d.lastError, /HTTP 500/);
  assert.equal(alerts.length, 0, "不告警");
  // 回复路径自己的失败照样数，后台的不凑数
  await d.judge(TOPIC, q);
  await d.judge(TOPIC, q);
  await d.judge(TOPIC, q, { background: true });
  assert.equal(d.broken, false);
  await d.judge(TOPIC, q);
  assert.equal(d.broken, true);
  assert.equal(await d.judge(TOPIC, q, { background: true }), null, "熔断中后台的也不发");
  assert.equal(f.calls.length, 13);

  // 花费照记；上限照管（0.000015 美元 = 150 token）
  const ok = fakeDecisions({ tokens: 100 });
  const d2 = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: ok.fetchImpl, now: () => SH_NOON, dailyUsd: 0.000015, onAlert: (m) => alerts.push(m) });
  assert.ok(await d2.judge(TOPIC, q, { background: true }));
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "100");
  assert.ok(await d2.judge(TOPIC, q, { background: true }));
  assert.equal(await d2.judge(TOPIC, q, { background: true }), null);
  assert.equal(ok.calls.length, 2, "到上限不再发");
});

/** 一直不回的请求：等到这次的超时，照真的 fetch 那样拿超时的原因（TimeoutError）拒掉 */
const hangUntilTimeout = (init: RequestInit): Promise<Response> =>
  new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason)));

test("Decisions：超时了再试一次（换一个新的超时），再试成了照常返回、不算失败；别的错照旧不再试（#0047）", async () => {
  const db = openDb(":memory:");
  const logs: LogRecord[] = [];
  const ok = fakeDecisions({ tokens: 100 });
  const sent: Array<{ signal: AbortSignal; abortedAtSend: boolean }> = [];
  const f = (async (u: string, init: RequestInit) => {
    sent.push({ signal: init.signal!, abortedAtSend: init.signal!.aborted });
    return sent.length === 1 ? hangUntilTimeout(init) : ok.fetchImpl(u, init);
  }) as unknown as typeof fetch;
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f, now: () => SH_NOON, dailyUsd: 1, log: new Logger("test", memorySink(logs)) });
  const q = [{ name: "a", text: "吗？" }];
  const r = await d.judge(TOPIC, q, { timeoutMs: 30 });
  assert.deepEqual([...r!.p], [["a", 0.5]], "再试那次的结果");
  assert.equal(sent.length, 2, "超时以后再发了一次");
  assert.equal((sent[0]!.signal.reason as Error).name, "TimeoutError");
  assert.notEqual(sent[1]!.signal, sent[0]!.signal);
  assert.equal(sent[1]!.abortedAtSend, false, "再试用新的超时，不是已经到点的那个");
  assert.equal(d.lastError, "", "没记失败");
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "100");
  assert.deepEqual(logs.map((l) => `${l.level}:${l.msg}`), ["info:learning: judge timed out, retrying once"], "再试记一笔，不记失败");

  // 别的错（HTTP 500）不再试
  const bad = fakeDecisions({ fail: () => new Response("x", { status: 500 }) });
  const d2 = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: bad.fetchImpl, now: () => SH_NOON, dailyUsd: 1 });
  assert.equal(await d2.judge(TOPIC, q, { timeoutMs: 30 }), null);
  assert.equal(bad.calls.length, 1);
});

test("Decisions：再试也超时只算一次失败（三次调用才熔断），不会一直试；后台的也再试、照旧不凑熔断；once 的只发一轮（#0047）", async () => {
  const db = openDb(":memory:");
  let calls = 0;
  const hang = ((_u: string, init: RequestInit) => { calls += 1; return hangUntilTimeout(init); }) as unknown as typeof fetch;
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: hang, now: () => SH_NOON, dailyUsd: 1 });
  const q = [{ name: "a", text: "吗？" }];
  const o = { timeoutMs: 20 };
  const t0 = Date.now();
  assert.equal(await d.judge(TOPIC, q, o), null);
  assert.equal(calls, 2, "只再试一次");
  assert.ok(Date.now() - t0 >= 400, "the retry waits at least 400ms instead of copying the first 20ms");
  assert.match(d.lastError, /TimeoutError/);
  assert.equal(await d.judge(TOPIC, q, o), null);
  assert.equal(calls, 4);
  assert.equal(d.broken, false, "两次调用、四个请求，只算两次失败");
  assert.equal(await d.judge(TOPIC, q, { ...o, background: true }), null);
  assert.equal(calls, 6, "后台的也再试一次");
  assert.equal(d.broken, false, "后台的不凑数");
  assert.equal(await d.judge(TOPIC, q, { ...o, once: true }), null);
  assert.equal(calls, 7, "once：超时也不再试");
  assert.equal(d.broken, true, "第三次失败才熔断");
  assert.equal(await d.judge(TOPIC, q, o), null);
  assert.equal(calls, 7, "熔断中不发，也不再试");
});

test("Decisions：分批时只再试超时的那几批，成了的那批不重发、花费各记一次；有一批是别的错就不再试（#0047）", async () => {
  const db = openDb(":memory:");
  const qs = Array.from({ length: 450 }, (_, i) => ({ name: `p${i}`, text: "吗？" }));
  const sizes = (init: RequestInit) => (JSON.parse(String(init.body)) as DecisionsBody).questions.length;
  const ok = fakeDecisions({ tokens: 100 });
  const sent: number[] = [];
  const f = (async (u: string, init: RequestInit) => {
    sent.push(sizes(init));
    return sizes(init) === 50 && sent.filter((n) => n === 50).length === 1 ? hangUntilTimeout(init) : ok.fetchImpl(u, init);
  }) as unknown as typeof fetch;
  const d = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: f, now: () => SH_NOON, dailyUsd: 1 });
  const r = await d.judge(TOPIC, qs, { timeoutMs: 30 });
  assert.equal(r!.p.size, 450);
  assert.equal(r!.tokens, 200);
  assert.deepEqual(sent, [400, 50, 50], "只再发超时的那批");
  assert.equal(kvGet(db, "learn.spend.2026-11-01"), "200");

  const sent2: number[] = [];
  const g = (async (_u: string, init: RequestInit) => {
    sent2.push(sizes(init));
    return sizes(init) === 50 ? hangUntilTimeout(init) : new Response("x", { status: 500 });
  }) as unknown as typeof fetch;
  const d2 = new OpenAIDecisions({ key: "k", db, tz: "Asia/Shanghai", fetchImpl: g, now: () => SH_NOON, dailyUsd: 1 });
  assert.equal(await d2.judge(TOPIC, qs, { timeoutMs: 30 }), null);
  assert.deepEqual(sent2, [400, 50], "有一批是别的错：照旧不再试");
  assert.match(d2.lastError, /HTTP 500/);
});

// ---------- 封面向量和粗筛 ----------

/** 假向量：标题里的数字 n 决定和 e0 的夹角（n 越大越远），所以和 e0 的余弦随 n 单调下降 */
const angleOf = (text: string): number => Number(/p(\d+)/.exec(text)?.[1] ?? 0) * 0.01;
function coverEmbedder(log: string[][] = []): Embedder {
  return {
    async embed(texts) {
      log.push(texts);
      return texts.map((t) => {
        const v = new Float32Array(512);
        v[0] = Math.cos(angleOf(t));
        v[1] = Math.sin(angleOf(t));
        return v;
      });
    },
  };
}
const E0 = (() => { const v = new Float32Array(512); v[0] = 1; return v; })();

function cp(n: number, o: Partial<Page> = {}): Page {
  return {
    ids: [String(n).padStart(4, "0")], rel: `${o.category ?? "做事"}/本/p${n}.md`, category: "做事", book: "本",
    title: `p${n}`, brief: `简介${n}`, when: `场合${n}`, archived: false, general: false, lessons: [], pending: 0, ...o,
  };
}
const shelfOf = (...pages: Page[]): Shelf => ({ pages, books: [], problems: [] });
const gen = (n: number, o: Partial<Page> = {}) => cp(n, { category: "通用", general: true, ...o });

test("封面：没变的不重算，改了重算；归档和没编号的不进；向量失败不动旧的", async () => {
  const db = openDb(":memory:");
  const log: string[][] = [];
  const ix = new CoverIndex(db, coverEmbedder(log));
  const p1 = cp(1);
  const p2 = cp(2);
  const arch = cp(3, { archived: true });
  const noId = cp(4, { ids: [] });

  assert.deepEqual(await ix.refresh(shelfOf(p1, p2, arch, noId)), { embedded: 2 });
  assert.equal(log.length, 1, "一批一次请求");
  assert.deepEqual(log[0], [coverText(p1), coverText(p2)]);
  const rows = () => all<{ page_id: string; hash: string; vec: Uint8Array }>(db, "SELECT page_id, hash, vec FROM learn_cover ORDER BY page_id");
  assert.deepEqual(rows().map((r) => r.page_id), ["0001", "0002"]);
  assert.ok(rows().every((r) => /^[0-9a-f]{40}$/.test(r.hash) && r.vec.byteLength === 512 * 4), "hash 是 sha1，向量是 512 个 Float32");

  // 没变：不请求
  assert.deepEqual(await ix.refresh(shelfOf(p1, p2, arch, noId)), { embedded: 0 });
  assert.equal(log.length, 1);

  // 改了 p2 的简介：只重算 p2；新页 p5 一起进同一批
  const p2b = cp(2, { brief: "改过的简介" });
  const before = rows();
  assert.deepEqual(await ix.refresh(shelfOf(p1, p2b, cp(5))), { embedded: 2 });
  assert.deepEqual(log[1], [coverText(p2b), coverText(cp(5))]);
  const after = rows();
  assert.deepEqual(after.map((r) => r.page_id), ["0001", "0002", "0005"]);
  assert.deepEqual(after[0], before[0], "没变的那行原样");
  assert.notEqual(after[1]!.hash, before[1]!.hash);

  // 归档的页取消归档：之前没存过，这次补
  assert.deepEqual(await ix.refresh(shelfOf(p1, p2b, cp(5), cp(3))), { embedded: 1 });

  // 向量服务不可用：旧的留着，不抛
  const down = new CoverIndex(db, { async embed() { return null; } });
  const keep = rows();
  assert.deepEqual(await down.refresh(shelfOf(p1, cp(2, { brief: "又改了" }), cp(6))), { embedded: 0 });
  assert.deepEqual(rows(), keep);
  assert.deepEqual(await new CoverIndex(db, null).refresh(shelfOf(cp(7))), { embedded: 0 });
  assert.deepEqual(rows(), keep);
});

test("封面：批量重算用批量超时（默认 60 秒），不用回复路径的 800 毫秒；可以覆盖", async () => {
  const db = openDb(":memory:");
  const seen: Array<number | undefined> = [];
  const base = coverEmbedder();
  const spy: Embedder = { embed: (texts, o) => { seen.push(o?.timeoutMs); return base.embed(texts, o); } };
  const ix = new CoverIndex(db, spy);
  await ix.refresh(shelfOf(cp(1)));
  await ix.refresh(shelfOf(cp(1), cp(2)), { timeoutMs: 5_000 });
  assert.deepEqual(seen, [60_000, 5_000]);
});

test("条目向量：两次刷新按先后来，前一次慢的旧结果不会盖掉后一次的；算不出来时报 failed、留着旧的", async () => {
  const base = coverEmbedder();
  let calls = 0;
  let release = (): void => {};
  const slow: Embedder = { embed: async (texts, o) => { calls += 1; if (calls === 1) await new Promise<void>((r) => { release = r; }); return base.embed(texts, o); } };
  const ix = new ItemIndex(slow, () => null, () => ROLE);
  const withLesson = (n: number, id: string, t: string) => cp(n, { lessons: [{ ...lesson(1), ids: [id], text: t }] });
  const s0 = shelfOf(withLesson(1, "0101", "甲"));
  const s1 = shelfOf(withLesson(1, "0101", "甲"), withLesson(2, "0102", "乙"));
  const a = ix.refresh(s0);
  const b = ix.refresh(s1);
  await new Promise<void>((r) => setImmediate(r));
  release();
  await a; await b;
  assert.deepEqual(ix.shortlist(E0, new Set(["0001", "0002"]), 10).map((it) => it.id).sort(), ["l:0101", "l:0102"]);
  const down = new ItemIndex({ embed: async () => null }, () => null, () => ROLE);
  assert.deepEqual(await down.refresh(s0), { embedded: 0, failed: true });
  assert.deepEqual(await new ItemIndex(base, () => null, () => ROLE).refresh(shelfOf(cp(3))), { embedded: 0 }, "没有条目不算失败");
});

test("粗筛：取余弦前 k，通用类补进，归档和没向量的不进", async () => {
  const db = openDb(":memory:");
  const ix = new CoverIndex(db, coverEmbedder());
  // p1..p6 离 e0 由近到远；p3 归档；p7 没编号；p8 没向量（刷新之后才上架）；通用类 p10、p11 离得最远
  const shelf = shelfOf(cp(1), cp(2), cp(3, { archived: true }), cp(4), cp(5), cp(6), cp(7, { ids: [] }), gen(10), gen(11));
  await ix.refresh(shelf);
  const late = shelfOf(...shelf.pages, cp(8));
  const names = (r: Page[]) => r.map((p) => p.title);
  assert.deepEqual(names(ix.shortlist(E0, late, 3, "通用")), ["p1", "p2", "p4", "p10", "p11"],
    "前 3（跳过归档的 p3）在前，然后是没进前 k 的通用类，各按余弦");
  // 通用类已经在前 k 里就不重复
  const all2 = ix.shortlist(E0, late, 20, "通用");
  assert.deepEqual(names(all2), ["p1", "p2", "p4", "p5", "p6", "p10", "p11"]);
  // k = 0：只剩通用类
  assert.deepEqual(names(ix.shortlist(E0, late, 0, "通用")), ["p10", "p11"]);
  // 从库里读，不靠刷新那个对象的内存：换一个实例照样能筛
  assert.deepEqual(names(new CoverIndex(db, null).shortlist(E0, late, 1, "通用")), ["p1", "p10", "p11"]);
  // 向量朝别处：排序跟着向量走
  const e1 = new Float32Array(512);
  e1[1] = 1;
  assert.deepEqual(names(ix.shortlist(e1, late, 2, "通用")), ["p11", "p10"], "p11、p10 离 e1 最近，前 k 里已经有了就不补");
});

test("粗筛：前 k 加通用类超过 60 时，通用类只补余弦最高的 10 页", async () => {
  const db = openDb(":memory:");
  const ix = new CoverIndex(db, coverEmbedder());
  // 60 页普通的（p1..p60），20 页通用的（p101..p120，离得更远）
  const normal = Array.from({ length: 60 }, (_, i) => cp(i + 1));
  const general = Array.from({ length: 20 }, (_, i) => gen(i + 101));
  const shelf = shelfOf(...general.reverse(), ...normal);   // 书架顺序和余弦无关
  await ix.refresh(shelf);

  // 40 + 20 = 60，不超过：通用类全补
  const r40 = ix.shortlist(E0, shelf, 40, "通用");
  assert.equal(r40.length, 60);
  assert.deepEqual(r40.slice(0, 40).map((p) => p.title), normal.slice(0, 40).map((p) => p.title));
  assert.deepEqual(r40.slice(40).map((p) => p.title), Array.from({ length: 20 }, (_, i) => `p${i + 101}`));

  // 41 + 20 = 61，超过：只补最近的 10 页通用类
  const r41 = ix.shortlist(E0, shelf, 41, "通用");
  assert.equal(r41.length, 51);
  assert.deepEqual(r41.slice(41).map((p) => p.title), Array.from({ length: 10 }, (_, i) => `p${i + 101}`));

  // k 很大时通用类都在前 k 里，没有额外要补的
  assert.equal(ix.shortlist(E0, shelf, 100, "通用").length, 80);
});

// ---------- 参数 ----------

test("参数：登记表给默认值和上下限；kv 里的覆盖值优先；改的时候校验、记一行日志；清掉回到默认；坏的 kv 当没有（ada 11-03 参数都要动态）", () => {
  const db = openDb(":memory:");
  assert.equal(param(db, "strength.residentMax"), 10);
  assert.equal(param(db, "assoc.kWake", 12), 12, "跟着配置的：不给覆盖就用配置的值");
  assert.equal(param(db, "assoc.threshold", 0.7), 0.9, "有自己默认的：配置的值不管用（11-04 门槛 0.9，纠正题照旧用配置的 0.7）");
  assert.deepEqual(setParam(db, "strength.residentMax", 12, { why: "ada 说多一点", by: "ada", now: 1000 }), { old: 10, value: 12 });
  assert.equal(param(db, "strength.residentMax"), 12);
  setParam(db, "assoc.kWake", 16, { why: "夜里调", by: "night", now: 2000 });
  assert.equal(param(db, "assoc.kWake", 12), 16);
  assert.throws(() => setParam(db, "strength.residentMax", 99, { why: "x", by: "x", now: 3 }), /上下限 0–30/);
  assert.throws(() => setParam(db, "strength.nope", 1, { why: "x", by: "x", now: 3 }), /不认识/);
  assert.throws(() => setParam(db, "strength.residentMax", Number.NaN, { why: "x", by: "x", now: 3 }), /不是数/);
  setParam(db, "strength.residentMax", null, { why: "回到默认", by: "ada", now: 4000 });
  assert.equal(param(db, "strength.residentMax"), 10);
  assert.deepEqual(paramLog(db).map((l) => [l.at, l.name, l.old, l.value, l.by, l.why]), [
    [1000, "strength.residentMax", 10, 12, "ada", "ada 说多一点"],
    [2000, "assoc.kWake", null, 16, "night", "夜里调"],
    [4000, "strength.residentMax", 12, null, "ada", "回到默认"],
  ]);
  kvSet(db, "learn.params", "{坏的");
  assert.equal(param(db, "strength.residentMax"), 10);
  // 直接写进 kv 的出界值、不是数的：卡回上下限、当没有；继承来的名字不认；强的最低是 4（3 就把所有教训都算强了）
  kvSet(db, "learn.params", JSON.stringify({ "strength.strongThreshold": 0, "strength.residentMax": "很多" }));
  assert.equal(param(db, "strength.strongThreshold"), 0.3);
  assert.equal(param(db, "strength.residentMax"), 10);
  assert.throws(() => param(db, "constructor"), /不认识/);
  assert.throws(() => setParam(db, "strength.strongMin", 3, { why: "x", by: "x", now: 3 }), /上下限 4–5/);
  assert.ok(listParams(db).some((r) => r.name === "strength.strongThreshold" && r.value === 0.3 && r.overridden && r.min === 0.3 && r.max === 0.9), "列出来的也卡在上下限里");
});

// ---------- 联想 ----------

const lesson = (n: number): Lesson => ({ ids: [], line: n, text: `教训${n}`, when: "", next: "", days: [], sources: [] });
type AssocRow = {
  id: number; at: number; region: string; binding: string | null; topic: string | null; task_id: number | null;
  candidates: number; mounted: string; shadow: number; skipped: string | null; ms: number; tokens: number;
};

/**
 * 一个联想器：书架就是给的这些页，封面向量用 coverEmbedder（p 后面的数字越小离 E0 越近），话题向量固定 E0；
 * 假判断按 name 给 probs 里的概率（没给的按 0），可以切成返回 null 或抛错；钟不走，tick 拨。
 */
async function associator(pages: Page[], o: { cfg?: Partial<LearningCfg>; probs?: Record<string, number>; covers?: boolean; judge?: Judge; files?: Record<string, string>; seenSince?: (region: string, seqs: number[]) => Map<number, number>; shelfDir?: string } = {}) {
  const db = openDb(":memory:");
  const shelf = shelfOf(...pages);
  const covers = new CoverIndex(db, coverEmbedder());
  const items = new ItemIndex(coverEmbedder(), (rel) => o.files?.[rel] ?? null, () => ROLE);
  if (o.covers !== false) { await covers.refresh(shelf); await items.refresh(shelf); }
  let clock = SH_NOON;
  const probs = { ...o.probs };
  let mode: "ok" | "null" | "throw" = "ok";
  const calls: Array<{ input: string; qs: Array<{ name: string; text: string }>; timeoutMs: number | undefined; background?: true }> = [];
  const judge: Judge = o.judge ?? {
    async judge(input, qs, jo) {
      calls.push({ input, qs, timeoutMs: jo?.timeoutMs, ...(jo?.background ? { background: true as const } : {}) });
      if (mode === "null") return null;
      if (mode === "throw") throw new RangeError("Invalid time zone specified: Mars/Base");
      return { p: new Map(qs.map((q) => [q.name, probs[q.name] ?? 0])), tokens: 100 * qs.length, ms: 5 };
    },
  };
  const vecCalls: Array<{ q: string; timeoutMs: number | undefined }> = [];
  let vecImpl = async (_q: string): Promise<Float32Array | null> => E0;
  const logs: LogRecord[] = [];
  // 这些老测试按 11-04 以前的默认写的（门槛 0.7、粗筛 20/40、通用类全补、条目 12、不照用上次判断；假向量每个话题都一样）：
  // 钉住它们，测的是行为不是默认值；新默认另有测试
  const cfg: LearningCfg = { ...testConfig().learning, enabled: true, inject: true, threshold: 0.7, kWake: 20, kTask: 40, ...o.cfg };
  for (const [k, v] of [["assoc.threshold", 0.7], ["assoc.itemsK", 12], ["assoc.generalExtra", 30], ["assoc.reuseCos", 1], ["assoc.fullTextAt", 0.5], ["strength.dailyMax", 0]] as const) setParam(db, k, v, { why: "老测试", by: "t", now: 0 });
  const notes = new NoteAssociator({
    db, cfg, shelf: () => shelf, covers, items, judge,
    vec: (q, timeoutMs) => { vecCalls.push({ q, timeoutMs }); return vecImpl(q); },
    now: () => clock, log: new Logger("test", memorySink(logs)),
    read: (rel) => o.files?.[rel] ?? null, shelfDir: o.shelfDir ?? WHO.shelfDir, keep: () => KEEP,
    ...(o.seenSince ? { seenSince: o.seenSince } : {}),
  });
  return {
    db, notes, cfg, probs, calls, vecCalls, logs,
    // 11-05 以后多的两列（asked、vec）不在这里：老测试整行比的照旧，新的两列用 cols 看
    rows: () => all<AssocRow>(db, "SELECT id, at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens FROM learn_assoc ORDER BY id").map((r) => ({ ...r })),
    cols: () => all<{ binding: string; asked: string | null; vec: Uint8Array | null }>(db, "SELECT binding, asked, vec FROM learn_assoc ORDER BY id"),
    setClock: (t: number) => { clock = t; },
    now: () => clock,
    names: (i: number) => calls[i]!.qs.map((q) => q.name),
    judgeMode: (m: typeof mode) => { mode = m; },
    setVec: (f: typeof vecImpl) => { vecImpl = f; },
    tick: (ms: number) => { clock += ms; },
  };
}

test("联想：过门槛的按概率取前 3，挂载文字照抄", async () => {
  const pages = [
    cp(1), cp(2, { lessons: [lesson(1), lesson(2)] }), cp(3),
    cp(4, { category: "形象制作", book: "分层生图", rel: "形象制作/分层生图/p4.md" }), cp(5),
  ];
  // 概率的高低和粗筛的先后故意不一样
  const a = await associator(pages, { probs: { "0001": 0.8, "0002": 0.95, "0003": 0.2, "0004": 0.9, "0005": 0.75 } });
  const r = await a.notes.associate("发 B 站评论", { region: "main", binding: "on_it", taskId: 7 });
  assert.equal(r.skipped, undefined);
  assert.deepEqual(r.pages, [{ id: "0002", p: 0.95 }, { id: "0004", p: 0.9 }, { id: "0001", p: 0.8 }]);
  assert.equal(r.text, [
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
    "· 本 · p2：简介2（2 条教训；skills/做事/本/p2.md）",
    "· 分层生图 · p4：简介4（skills/形象制作/分层生图/p4.md）",
    "· 本 · p1：简介1（skills/做事/本/p1.md）",
  ].join("\n"));
  assert.equal(r.tokens, 500);
  assert.equal(r.extra.size, 0);

  // 问法照抄：input 一段，每页一题，name 是页自己的编号
  assert.equal(a.calls.length, 1);
  assert.equal(a.calls[0]!.input, TOPIC);
  assert.deepEqual(a.calls[0]!.qs, pages.map((p) => ({ name: p.ids[0], text: `需要翻「${coverText(p)}」吗？` })));
  // 向量和判断共用 timeoutMs（钟没走，判断拿到全部）
  assert.deepEqual(a.vecCalls, [{ q: "发 B 站评论", timeoutMs: 800 }]);
  assert.equal(a.calls[0]!.timeoutMs, 800);

  // 记一行
  assert.deepEqual(a.rows(), [{
    id: 1, at: SH_NOON, region: "main", binding: "on_it", topic: "发 B 站评论", task_id: 7, candidates: 5,
    mounted: JSON.stringify(r.pages), shadow: 0, skipped: null, ms: 0, tokens: 500,
  }]);
  // 挂过的页：按脑区、按时间
  assert.deepEqual(a.notes.mountedSince("main", SH_NOON), ["0002", "0004", "0001"]);
  assert.deepEqual(a.notes.mountedSince("main", SH_NOON + 1), []);
  assert.deepEqual(a.notes.mountedSince("deep", 0), []);

  // k：叫醒用 kWake，其余用 kTask
  a.cfg.kWake = 2;
  a.cfg.kTask = 3;
  await a.notes.associate("另一件事", { region: "deep", binding: "wake" });
  assert.deepEqual(a.names(1), ["0001", "0002"]);
  await a.notes.associate("另一件事", { region: "side-1", binding: "mull_over" });
  assert.deepEqual(a.names(2), ["0001", "0002", "0003"]);
  // 话题很长时记录里只留前 500 字
  a.tick(1000);
  await a.notes.associate("长".repeat(800), { region: "side-2", binding: "goals" });
  assert.equal(a.rows().at(-1)!.topic, "长".repeat(500));
  assert.deepEqual(a.notes.mountedSince("main", 0), ["0002", "0004", "0001"], "别的脑区挂的不算");
});

test("联想：只算不挂时文字为空、照样记录", async () => {
  const a = await associator([cp(1), cp(2), cp(3)], { cfg: { inject: false }, probs: { "0001": 0.9 } });
  const r = await a.notes.associate("剪片子", { region: "main", binding: "wake" });
  assert.equal(r.text, "");
  assert.deepEqual(r.pages, [{ id: "0001", p: 0.9 }], "页照算");
  assert.equal(r.skipped, undefined);
  const rows = a.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.shadow, 1);
  assert.equal(rows[0]!.mounted, JSON.stringify([{ id: "0001", p: 0.9 }]));
  assert.equal(rows[0]!.skipped, null);
  // 只算不挂的不算她看过（做完时提的"想起过"只算真给她看的）
  assert.deepEqual(a.notes.mountedSince("main", 0), []);
  // 只算不挂也照样按"挂过"去重，统计和真挂时一样
  await a.notes.associate("剪另一个片子", { region: "main", binding: "wake" });
  assert.deepEqual(a.names(1), ["0002", "0003"]);

  // 回测：不管 inject 都出文字，不记
  const rp = await a.notes.associate("剪片子", { region: "replay", binding: "replay" });
  assert.deepEqual(rp.pages, [{ id: "0001", p: 0.9 }]);
  assert.equal(rp.text, "想起来的笔记（用得上就翻开）：\n· 本 · p1：简介1（skills/做事/本/p1.md）");
  assert.equal(a.rows().length, 2);

  // 开关关着：什么都不算、不记
  a.cfg.enabled = false;
  const off = await a.notes.associate("剪第三个片子", { region: "main", binding: "wake" });
  assert.deepEqual(off, { text: "", pages: [], extra: new Map(), ms: 0, tokens: 0, skipped: "off" });
  assert.equal(a.calls.length, 3);
  assert.equal(a.vecCalls.length, 3);
  assert.equal(a.rows().length, 2);
});

test("联想：判断失败不挂、记 skipped", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9 } });
  a.judgeMode("null");
  const r = await a.notes.associate("话题一", { region: "main", binding: "on_it" });
  assert.equal(r.text, "");
  assert.deepEqual(r.pages, []);
  assert.equal(r.skipped, "judge");
  assert.equal(r.tokens, 0);
  const row = a.rows()[0]!;
  assert.equal(row.skipped, "judge");
  assert.equal(row.candidates, 2);
  assert.equal(row.mounted, "[]");
  assert.equal(row.tokens, 0);

  // 判断抛错（时区不对、kv 出错）也一样，不往外抛，记一条 warn
  a.judgeMode("throw");
  const r2 = await a.notes.associate("话题二", { region: "main", binding: "on_it" });
  assert.equal(r2.skipped, "judge");
  assert.equal(r2.text, "");
  assert.equal(a.rows()[1]!.skipped, "judge");
  assert.ok(a.logs.some((l) => l.level === "warn" && /Mars\/Base/.test(String(l.error))), "抛的错记进日志");

  // 向量算不出来：不判，记 novec
  a.judgeMode("ok");
  a.setVec(async () => null);
  const r3 = await a.notes.associate("话题三", { region: "main", binding: "on_it" });
  assert.equal(r3.skipped, "novec");
  assert.equal(a.calls.length, 2);
  assert.deepEqual({ ...a.rows()[2]!, id: 0 }, {
    id: 0, at: SH_NOON, region: "main", binding: "on_it", topic: "话题三", task_id: null, candidates: 0,
    mounted: "[]", shadow: 0, skipped: "novec", ms: 0, tokens: 0,
  });

  // 向量用掉一部分时间：判断只拿剩下的
  a.setVec(async () => { a.tick(300); return E0; });
  const r4 = await a.notes.associate("话题四", { region: "main", binding: "on_it" });
  assert.deepEqual(r4.pages, [{ id: "0001", p: 0.9 }]);
  assert.equal(r4.ms, 300);
  assert.equal(a.calls.at(-1)!.timeoutMs, 500);
  assert.equal(a.rows().at(-1)!.ms, 300);
  // How long each stage took and how many questions were asked, numbers only
  const timing = () => a.logs.filter((l) => l.msg === "note association: timing").map(({ t: _t, level: _l, mod: _m, msg: _g, ...x }) => x).at(-1);
  assert.deepEqual(timing(), { binding: "on_it", limit: 800, vecMs: 300, prepMs: 0, judgeMs: 0, budgetMs: 500, questions: a.calls.at(-1)!.qs.length });

  // Less left than one round trip (150ms): the judge is not asked, and the round counts as the judge failing
  a.setVec(async () => { a.tick(700); return E0; });
  const short = await a.notes.associate("话题四又一", { region: "side-2", binding: "on_it" });
  assert.equal(short.skipped, "judge");
  assert.equal(a.calls.length, 3, "100ms left: the judge was not called");
  assert.equal(timing()!.budgetMs, 100);
  assert.equal(timing()!.failed, true);

  // 向量把时间用完了：不再判，按判断失败记
  a.setVec(async () => { a.tick(800); return E0; });
  const r5 = await a.notes.associate("话题五", { region: "side-1", binding: "on_it" });
  assert.equal(r5.skipped, "judge");
  assert.equal(r5.text, "");
  assert.equal(a.calls.length, 3, "没再调判断");
  assert.equal(a.rows().at(-1)!.skipped, "judge");
  assert.equal(a.rows().at(-1)!.ms, 800);
});

test("联想：同一个脑区同一个话题不再调 API；挂过的页这个前缀里不再挂", async () => {
  const a = await associator([cp(1), cp(2), cp(3), cp(4)], { probs: { "0001": 0.9, "0002": 0.8 } });
  const r1 = await a.notes.associate("话题一", { region: "main", binding: "wake" });
  assert.deepEqual(r1.pages.map((p) => p.id), ["0001", "0002"]);

  // 同一个话题：不算向量、不判，记一行 same
  const r2 = await a.notes.associate("话题一", { region: "main", binding: "wake" });
  assert.equal(r2.skipped, "same");
  assert.equal(r2.text, "");
  assert.deepEqual(r2.pages, []);
  assert.equal(a.calls.length, 1);
  assert.equal(a.vecCalls.length, 1);
  assert.equal(a.rows().at(-1)!.skipped, "same");

  // 换话题：挂过的页不进候选
  const r3 = await a.notes.associate("话题二", { region: "main", binding: "wake" });
  assert.deepEqual(a.names(1), ["0003", "0004"]);
  assert.equal(r3.skipped, "nothing", "一页都没过");
  assert.deepEqual(r3.pages, []);
  assert.equal(a.rows().at(-1)!.skipped, "nothing");
  assert.equal(a.rows().at(-1)!.candidates, 2);

  // 别的脑区各自算：同一个话题、同样的页照挂
  const r4 = await a.notes.associate("话题一", { region: "side-1", binding: "on_it" });
  assert.deepEqual(r4.pages.map((p) => p.id), ["0001", "0002"]);
  assert.deepEqual(a.names(2), ["0001", "0002", "0003", "0004"]);

  // 回测不去重也不缓存：同一个话题每次都判、每次都挂
  for (let i = 0; i < 2; i++) {
    const rp = await a.notes.associate("话题一", { region: "main", binding: "replay" });
    assert.deepEqual(rp.pages.map((p) => p.id), ["0001", "0002"]);
  }
  assert.equal(a.calls.length, 5);
  assert.deepEqual(a.names(4), ["0001", "0002", "0003", "0004"]);
  // 回测也不动这个脑区的"上一个话题"和"挂过的页"
  assert.equal((await a.notes.associate("话题二", { region: "main", binding: "wake" })).skipped, "same");

  // 所有页都挂过：没有候选，不判
  a.probs["0003"] = 0.9;
  a.probs["0004"] = 0.85;
  const r5 = await a.notes.associate("话题三", { region: "main", binding: "wake" });
  assert.deepEqual(r5.pages.map((p) => p.id), ["0003", "0004"]);
  const r6 = await a.notes.associate("话题四", { region: "main", binding: "wake" });
  assert.equal(r6.skipped, "nothing");
  assert.equal(a.calls.length, 6, "没有候选不调判断");
  assert.equal(a.rows().at(-1)!.candidates, 0);

  // 换前缀：清这个脑区挂过的页和上一个话题，又能挂；别的脑区不动
  a.notes.prefixRebuilt("main");
  const r7 = await a.notes.associate("话题四", { region: "main", binding: "wake" });
  assert.deepEqual(r7.pages.map((p) => p.id), ["0001", "0003", "0004"], "0.9、0.9、0.85，同分按粗筛的先后");
  assert.equal((await a.notes.associate("话题一", { region: "side-1", binding: "on_it" })).skipped, "same");
  await a.notes.associate("话题五", { region: "side-1", binding: "on_it" });
  assert.deepEqual(a.names(a.calls.length - 1), ["0003", "0004"]);
  // 不带参数：全清
  a.notes.prefixRebuilt();
  const r8 = await a.notes.associate("话题五", { region: "side-1", binding: "on_it" });
  assert.equal(r8.skipped, undefined);
  assert.deepEqual(a.names(a.calls.length - 1), ["0001", "0002", "0003", "0004"]);
});

test("联想：同一个脑区几次联想重叠时，一页也只挂一次", async () => {
  const a = await associator([cp(1), cp(2), cp(3), cp(4)], { cfg: { maxPages: 2 }, probs: { "0001": 0.9, "0002": 0.85, "0003": 0.8 } });
  // 不同话题同时进来（一条消息里几个并行的工具调用；叫醒正在算时工具也在算）：都判出 0001、0002、0003 过线
  const [x, y] = await Promise.all([
    a.notes.associate("开始剪片子", { region: "main", binding: "on_it" }),
    a.notes.associate("给片子配字幕", { region: "main", binding: "goals" }),
  ]);
  assert.equal(a.calls.length, 2, "两次都判了");
  const ids = [...x.pages, ...y.pages].map((p) => p.id);
  assert.deepEqual([...ids].sort(), ["0001", "0002", "0003"], "没有一页挂两次；先挂上的拿走的页在取前 maxPages 之前就去掉，后一次补下一页");
  const mounted = a.rows().flatMap((r) => (JSON.parse(r.mounted) as Array<{ id: string }>).map((m) => m.id));
  assert.deepEqual(mounted.sort(), ["0001", "0002", "0003"], "记录里也只有一次");
  assert.deepEqual(a.notes.mountedSince("main", 0).sort(), ["0001", "0002", "0003"]);
  // 别的脑区不受影响
  assert.deepEqual((await a.notes.associate("开始剪片子", { region: "side-1", binding: "on_it" })).pages.map((p) => p.id), ["0001", "0002"]);

  // 同一个话题同时进来两次：只判一次，另一次是 same
  a.notes.prefixRebuilt();
  const [u, w] = await Promise.all([
    a.notes.associate("开始剪片子", { region: "main", binding: "on_it" }),
    a.notes.associate("开始剪片子", { region: "main", binding: "on_it" }),
  ]);
  assert.equal(a.calls.length, 4);
  assert.deepEqual([u.skipped, w.skipped], [undefined, "same"]);
  assert.deepEqual(u.pages.map((p) => p.id), ["0001", "0002"]);
});

test("联想：没内容的话不联想", async () => {
  const a = await associator([cp(1)], { probs: { "0001": 0.9 } });
  for (const t of ["好的👌", "", "  哈哈哈！！ "]) {
    const r = await a.notes.associate(t, { region: "main", binding: "wake" });
    assert.equal(r.skipped, "lowinfo", JSON.stringify(t));
    assert.equal(r.text, "");
    assert.deepEqual(r.pages, []);
  }
  assert.equal(a.calls.length, 0, "判断没被调");
  assert.equal(a.vecCalls.length, 0, "向量也没算");
  assert.deepEqual(a.rows().map((r) => r.skipped), ["lowinfo", "lowinfo", "lowinfo"], "也记一行（统计用）");
  assert.equal(a.rows()[0]!.topic, "好的👌");
});

const PRACTICE_PAGE = [
  "# 形象怎么做 <!-- p:0033 -->",
  "简介：给形象加动作和效果",
  "什么时候翻：要给形象加新动作的时候",
  "",
  "## 做法",
  "项目在 projects/avatar，工人是 cc:avatar-motion。",
  "",
  "### 靠谱做法（ada 教的）",
  "- 新动作先学成熟做法，一步步来（ada 教的，10-25）",
  "  - 何时：要给形象加任何新动作",
  "  - 怎么做：先找官方 Live2D 教程",
  "- **转头**：照官方的 AngleX/Y 做 <!-- l:0040 -->",
  "- " + "长".repeat(200),
  "- 第四条不给",
  "### 待验证",
  "- 还没验证的不给",
  "## 教训",
  "- 教训：别拍脑袋",
].join("\n");

const HITS_PAGE = [
  "# 验收和核实 <!-- p:0001 -->",
  "简介：a",
  "什么时候翻：b",
  "",
  "## 做法",
  "- 整张看，和原图并排",
  "- 写数字前先核",
  "## 教训",
  "- 教训：验小样只核了动没动（11-02 12:47 ada「嘴是小红三角」）｜什么时候：验形象小样、发给 ada 之前｜下次：每个部件放大到原尺寸看｜犯的日子：2026-11-02 <!-- l:0150 -->",
  "- 教训：别的｜什么时候：x｜下次：y <!-- l:0151 -->",
].join("\n");
const hitsPage = (n: number, rel = `做事/本/p${n}.md`): Page =>
  cp(n, { rel, lessons: parsePage(HITS_PAGE.replace("0001", String(n).padStart(4, "0")).replace(/l:015/g, `l:${n}15`), rel, "通用", ARCH).lessons });

test("条目：有编号的教训和做法头几条；只说「何时」的那条不算（它说的是什么时候翻，不是怎么做）", () => {
  const md = "# 深度思考 <!-- p:0108 -->\n简介：a\n什么时候翻：b\n\n## 做法\n- **何时**：定选题、判断值不值的时候\n- 先问这件事到底要解决什么\n- 何时触发：要做新工具之前\n- 多开几个角度对抗审查\n";
  const page = parsePage(md + "## 教训\n- 教训：拍脑袋｜下次：先问本质 <!-- l:0200 -->\n- 教训：没编号的不算\n", "通用/basics/深度思考.md", "通用", ARCH);
  assert.deepEqual(pageItems(page, md, ROLE).map((it) => [it.id, it.line]), [
    ["l:0200", "先问本质（上次：拍脑袋）"],
    ["0108#2", "先问这件事到底要解决什么"],
    ["0108#4", "多开几个角度对抗审查"],
  ]);
  assert.deepEqual(pageItems(page, null, ROLE).map((it) => it.id), ["l:0200"], "读不到页就只有教训");
});

test("联想：页里的教训和做法也一起问，对得上的那几条贴在封面下面；条目过线、页没过线也挂（11-03 教训级别）", async () => {
  const page = hitsPage(1);
  const a = await associator([page, cp(2)], {
    probs: { "0001": 0.5, "l:1150": 0.92, "0001#1": 0.8, "l:1151": 0.1, "0001#2": 0.3 },
    files: { "做事/本/p1.md": HITS_PAGE },
  });
  const r = await a.notes.associate("会长的嘴还是三角的，你放大看看", { region: "main", binding: "wake" });
  assert.deepEqual(r.pages, [{
    id: "0001", p: 0.92, hits: [
      { id: "l:1150", kind: "lesson", text: "教训：验小样只核了动没动｜什么时候：验形象小样、发给 ada 之前｜下次：每个部件放大到原尺寸看", p: 0.92, strength: 3, strong: false },
      { id: "0001#1", kind: "practice", text: "整张看，和原图并排", p: 0.8, strength: 3, strong: false },
    ],
  }]);
  assert.equal(r.text, [
    "想起来的笔记（用得上就翻开）：",
    "· 本 · p1：简介1（2 条教训；skills/做事/本/p1.md）",
    "  对得上的：",
    "  - 每个部件放大到原尺寸看（上次：验小样只核了动没动）",
    "  - 整张看，和原图并排",
  ].join("\n"));
  // 问法：页一题，教训、做法各一题（名字是教训的编号、页号#第几条做法）
  const qs = a.calls[0]!.qs;
  assert.deepEqual(qs.map((q) => q.name), ["0001", "0002", "l:1150", "l:1151", "0001#1", "0001#2"]);
  assert.equal(qs.find((q) => q.name === "l:1150")!.text, "这件事正好用得上这条教训吗？「验形象小样、发给 ada 之前：验小样只核了动没动——下次：每个部件放大到原尺寸看」");
  assert.equal(qs.find((q) => q.name === "0001#1")!.text, "这件事正好用得上这条做法吗？「p1：整张看，和原图并排」");
  // 记录里只记命中条目的编号（原文在页里）
  assert.equal(a.rows()[0]!.mounted, JSON.stringify([{ id: "0001", p: 0.92, hits: ["l:1150", "0001#1"] }]));
});

test("联想：条目按自己的向量挑（最多 12 条），不靠封面排进粗筛：条目对得上，它那页没进粗筛也挂；开始做事时第一页有命中就贴命中的，没有才贴做法头几条；回测、派活不问条目", async () => {
  const pages = [1, 2, 3, 4, 5, 6, 7].map((n) => hitsPage(n));
  const files = Object.fromEntries(pages.map((p) => [p.rel, HITS_PAGE]));
  const a = await associator(pages, { probs: { "0001": 0.95, "l:3150": 0.9 }, files, cfg: { kTask: 2 } });
  const r = await a.notes.associate("给会长加转头", { region: "main", binding: "on_it" });
  const qs = a.calls[0]!.qs.map((q) => q.name);
  assert.deepEqual(qs.slice(0, 2), ["0001", "0002"], "粗筛只进了前 2 页");
  assert.equal(qs.length - 2, 12, "条目最多 12 条");
  assert.ok(qs.includes("l:3150"), "第 3 页没进粗筛，它的教训照样问");
  assert.deepEqual(r.pages.map((x) => [x.id, x.p, x.hits?.map((h) => h.id)]), [["0001", 0.95, undefined], ["0003", 0.9, ["l:3150"]]]);
  assert.equal(r.text, [
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
    "· 本 · p1：简介1（2 条教训；skills/做事/本/p1.md）",
    "  先照这几条做：",
    "  - 整张看，和原图并排",
    "  - 写数字前先核",
    "· 本 · p3：简介3（2 条教训；skills/做事/本/p3.md）",
    "  对得上的：",
    "  - 每个部件放大到原尺寸看（上次：验小样只核了动没动）",
  ].join("\n"));

  const b = await associator(pages, { probs: { "0001": 0.95, "l:1150": 0.9 }, files });
  const rb = await b.notes.associate("给会长加转头", { region: "main", binding: "on_it" });
  assert.match(rb.text, /p1：简介1[^\n]*\n  对得上的：\n  - 每个部件放大到原尺寸看/);
  assert.doesNotMatch(rb.text, /先照这几条做/, "有命中就不再贴做法头几条");

  for (const binding of ["replay", "helper"] as const) {
    const c = await associator(pages, { probs: { "0001": 0.95 }, files });
    if (binding === "helper") await c.notes.forHelper("给会长加转头", "w"); else await c.notes.associate("给会长加转头", { region: "x", binding });
    assert.deepEqual(c.calls[0]!.qs.map((q) => q.name), pages.map((p) => p.ids[0]), binding);
  }
});

test("联想：同一页挂过以后，叫醒照旧不再挂；干活的时刻（开始做、中途、交之前）要她又看了 remountTokens 那么多的经历才再挂（ada 11-03「折中一点」）", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9 }, cfg: { remountTokens: 100 } });
  const central = new CentralMemory(a.db, () => SH_NOON);
  central.append(1, "main", "say", "开头");
  assert.deepEqual((await a.notes.associate("话题一", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"]);
  assert.deepEqual((await a.notes.associate("话题二", { region: "main", binding: "on_it" })).pages, [], "刚挂过");
  central.append(1, "main", "say", "很".repeat(40));                       // 还不够 100
  assert.deepEqual((await a.notes.associate("话题三", { region: "main", binding: "midwork" })).pages, []);
  central.append(1, "main", "say", "长".repeat(400));                      // 够了
  assert.deepEqual((await a.notes.associate("话题四", { region: "main", binding: "wake" })).pages, [], "叫醒照旧去重");
  assert.deepEqual((await a.notes.associate("话题五", { region: "main", binding: "done_with" })).pages.map((x) => x.id), ["0001"]);
  assert.deepEqual((await a.notes.associate("话题六", { region: "main", binding: "on_it" })).pages, [], "再挂以后从这次重新算");
  assert.deepEqual((await a.notes.associate("话题七", { region: "side-1", binding: "on_it" })).pages.map((x) => x.id), ["0001"], "按脑区分开");
});

test("联想：先算不挂（hold）——贴给她那一刻 confirm 才记那一行、才算挂过；不 confirm 就什么都不记；confirm 时已经被别的联想挂上的页去掉（sess-62 的中途联想，11-03）", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9, "0002": 0.8 } });
  const held = await a.notes.associate("剪片子", { region: "main", binding: "midwork", taskId: 4, hold: true });
  assert.deepEqual(held.pages.map((x) => x.id), ["0001", "0002"]);
  assert.match(held.text, /p1[\s\S]*p2/);
  assert.deepEqual(a.rows(), [], "还没贴：不记");
  assert.deepEqual(a.notes.mountedSince("main", 0), []);

  // 丢掉不贴：之后照样能挂
  const dropped = await a.notes.associate("剪另一段片子", { region: "main", binding: "midwork", hold: true });
  assert.deepEqual(dropped.pages.map((x) => x.id), ["0001", "0002"], "上一份没贴，不算挂过");

  // 等着贴的时候，叫醒那边先挂了 0001：确认时去掉它
  a.probs["0002"] = 0;
  assert.deepEqual((await a.notes.associate("看看片子", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"]);
  a.tick(5_000);
  const r = held.confirm!();
  assert.deepEqual(r.pages.map((x) => x.id), ["0002"]);
  assert.doesNotMatch(r.text, /p1/);
  assert.match(r.text, /^想起来的笔记（用得上就翻开）：\n· 本 · p2/);
  const rows = a.rows();
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[1]!.binding, rows[1]!.task_id, rows[1]!.at, rows[1]!.mounted], ["midwork", 4, SH_NOON + 5_000, JSON.stringify([{ id: "0002", p: 0.8 }])]);
  assert.deepEqual(held.confirm!().pages, [], "只确认一次");
  assert.equal(a.rows().length, 2);
});

test("联想：交之前（done_with）跟别的干活时刻一样，开头刚挂过的页要隔够才再贴（ada 11-03：重要的立马贴、不重要的不立刻贴，等强度分级）", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9 }, cfg: { remountTokens: 100 } });
  const central = new CentralMemory(a.db, () => SH_NOON);
  central.append(1, "main", "say", "开头");
  assert.deepEqual((await a.notes.associate("开始做封面", { region: "main", binding: "on_it" })).pages.map((x) => x.id), ["0001"]);
  assert.deepEqual((await a.notes.associate("封面要交了", { region: "main", binding: "done_with" })).pages, []);
});

const STRONG_PAGE = (n: number) => parsePage([
  `# 验收和核实 <!-- p:${String(n).padStart(4, "0")} -->`, "简介：a", "什么时候翻：b", "", "## 教训",
  `- 教训：验小样只核了动没动（11-02 12:47 ada「嘴是小红三角」）｜什么时候：发小样给 ada 之前｜下次：每个部件放大看｜犯的日子：2026-10-30、2026-11-01、2026-11-02｜强度：5 <!-- l:${n}150 -->`,
  `- 教训：普通的一条｜下次：照做 <!-- l:${n}151 -->`,
].join("\n"), `做事/本/p${n}.md`, "通用", ARCH);

test("强联想：强度够的条目每次都问（不管像不像）、门槛低一点，单独一块放最前，标犯过几次、ada 的原话，要她先写「这次我会……」（ada 11-03）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2)], { probs: { "0002": 0.9, "l:1150": 0.6, "l:1151": 0.6 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  const r = await a.notes.associate("会长小样做好了，发给 ada 看", { region: "main", binding: "wake" });
  assert.ok(a.calls[0]!.qs.some((q) => q.name === "l:1150"), "强的不管像不像都问");
  assert.ok(!a.calls[0]!.qs.some((q) => q.name === "l:1151"), "普通的这次没挑上");
  assert.deepEqual(r.pages.map((x) => [x.id, x.strong, x.hits?.map((h) => [h.id, h.strength, h.strong])]), [
    ["0001", true, [["l:1150", 5, true]]],
    ["0002", undefined, undefined],
  ], "有强条目的页排最前");
  assert.equal(r.text, [
    "⚠️ 老毛病，这次别再犯（动手前先在心里写一句「这次我会……」，照着做）：",
    "- 每个部件放大看（上次：验小样只核了动没动；犯过 3 次，最近 11-02；ada：「嘴是小红三角」）〔skills/做事/本/p1.md〕",
    "想起来的笔记（用得上就翻开）：",
    "· 本 · p1：简介1（2 条教训；skills/做事/本/p1.md）",
    "· 本 · p2：简介2（skills/做事/本/p2.md）",
  ].join("\n"));
  // 门槛：强的 0.5 过、普通的 0.6 不过（普通的门槛 0.7）
  setParam(a.db, "strength.strongThreshold", 0.65, { why: "测试", by: "t", now: 2 });
  const b = await associator([strong, cp(2)], { probs: { "l:1150": 0.6 } });
  setParam(b.db, "strength.strongThreshold", 0.65, { why: "测试", by: "t", now: 2 });
  assert.deepEqual((await b.notes.associate("发小样", { region: "main", binding: "wake" })).pages, [], "门槛跟着参数");
});

test("强联想：有强条目的页挂过以后，叫醒时也隔 strongRemountTokens 就能再挂；普通的页叫醒照旧只挂一次", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2)], { probs: { "0001": 0.9, "0002": 0.9 } });
  setParam(a.db, "strength.strongRemountTokens", 100, { why: "测试", by: "t", now: 1 });
  const central = new CentralMemory(a.db, () => SH_NOON);
  central.append(1, "main", "say", "开头");
  assert.deepEqual((await a.notes.associate("话题一", { region: "main", binding: "wake" })).pages.map((x) => x.id).sort(), ["0001", "0002"]);
  assert.deepEqual((await a.notes.associate("话题二", { region: "main", binding: "wake" })).pages, []);
  central.append(1, "main", "say", "长".repeat(400));
  assert.deepEqual((await a.notes.associate("话题三", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"]);
});

test("强联想：页的分数取所有过线条目里最高的；强的、普通的条目各自最多 hitsPerPage 条；有强条目的页排最前、不占 maxPages（review fd8f373）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2), cp(3), cp(4)], { probs: { "0001": 0.3, "l:1151": 0.95, "l:1150": 0.55, "0002": 0.8, "0003": 0.8, "0004": 0.8 } });
  const r = await a.notes.associate("小样做好了", { region: "main", binding: "wake" });
  assert.deepEqual(r.pages.map((x) => [x.id, x.p, x.hits?.map((h) => h.id)]), [
    ["0001", 0.95, ["l:1150", "l:1151"]],
    ["0002", 0.8, undefined], ["0003", 0.8, undefined], ["0004", 0.8, undefined],
  ]);
  assert.match(r.text, /^⚠️ 老毛病[^\n]*\n- 每个部件放大看[\s\S]*· 本 · p1[^\n]*\n  对得上的：\n  - 照做/);
});

test("强联想：帮手那边同一页照旧只给一次（强的也不再给）（review fd8f373）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2)], { probs: { "0001": 0.9 } });
  setParam(a.db, "strength.strongRemountTokens", 0, { why: "测试", by: "t", now: 1 });
  assert.equal((await a.notes.forHelper("做小样", "w")).pages.length, 1);
  assert.equal((await a.notes.forHelper("再做一版小样", "w")).pages.length, 0);
});

test("强联想：交之前（done_with）、发给 ada 之前（handover），强的页这个脑区又看了 handRemountTokens 就再贴，刚贴过、还在眼前的不重贴；普通的照旧要隔够（ada 11-03「重要的立马贴」；11-04 两分钟里交两次差贴两遍）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  for (const binding of ["done_with", "handover"] as const) {
    const a = await associator([strong, cp(2)], { probs: { "0001": 0.9, "0002": 0.9 } });
    setParam(a.db, "strength.handRemountTokens", 100, { why: "测试", by: "t", now: 1 });
    const central = new CentralMemory(a.db, () => SH_NOON);
    central.append(1, "main", "say", "开头");
    assert.deepEqual((await a.notes.associate("开始做小样", { region: "main", binding: "on_it" })).pages.map((x) => x.id).sort(), ["0001", "0002"]);
    assert.deepEqual((await a.notes.associate("小样要交了", { region: "main", binding })).pages, [], `${binding}：刚贴过，还在眼前`);
    central.append(1, "main", "say", "长".repeat(400));
    assert.deepEqual((await a.notes.associate("小样真要交了", { region: "main", binding })).pages.map((x) => x.id), ["0001"], `${binding}：隔够了，强的再贴、普通的不贴`);
  }
  // 设成 0：每次交都贴（11-03 的做法）
  const b = await associator([strong, cp(2)], { probs: { "0001": 0.9, "0002": 0.9 } });
  setParam(b.db, "strength.handRemountTokens", 0, { why: "测试", by: "t", now: 1 });
  new CentralMemory(b.db, () => SH_NOON).append(1, "main", "say", "开头");
  await b.notes.associate("开始做小样", { region: "main", binding: "on_it" });
  assert.deepEqual((await b.notes.associate("小样要交了", { region: "main", binding: "done_with" })).pages.map((x) => x.id), ["0001"]);
});

test("强联想：隔多少再挂按这个脑区自己眼前的算（seenSince），别的脑区原文再多也不算（11-04 三个脑区并行，同一条中位 13 分钟就重贴一次）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const seen: Record<string, number> = { main: 0 };
  const asked: Array<[string, number[]]> = [];
  const a = await associator([strong, cp(2)], { probs: { "0001": 0.9, "0002": 0.9 }, seenSince: (r, s) => { asked.push([r, s]); return new Map(s.map((x) => [x, seen[r] ?? 0])); } });
  setParam(a.db, "strength.strongRemountTokens", 100, { why: "测试", by: "t", now: 1 });
  const central = new CentralMemory(a.db, () => SH_NOON);
  central.append(1, "main", "say", "开头");
  assert.equal((await a.notes.associate("话题一", { region: "main", binding: "wake" })).pages.length, 2);
  central.append(1, "side-1", "result", "长".repeat(4000));       // 别的脑区的原文：按原文合计早够了
  assert.deepEqual((await a.notes.associate("话题二", { region: "main", binding: "wake" })).pages, [], "她自己眼前没多什么：不再挂");
  assert.deepEqual(asked.at(-1), ["main", [1]], "只问要隔一段才能再挂的那几个挂的时刻（普通页叫醒不问），按脑区问");
  seen.main = 150;
  assert.deepEqual((await a.notes.associate("话题三", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"], "她自己看够了：强的再挂，普通的叫醒照旧只挂一次");
});

const STEP_PAGE = parsePage([
  "# 文件和提交 <!-- p:0001 -->", "简介：a", "什么时候翻：b", "", "## 教训",
  "- 教训：git 提交把别人的改动一起打包｜什么时候：要 git 提交的时候｜下次：只 add 自己的文件｜犯的日子：2026-10-30、2026-10-31｜提醒：动手时｜强度：4 <!-- l:1150 -->",
  "- 教训：钟点没核就写｜什么时候：写钟点的时候｜下次：先跑 date｜犯的日子：2026-11-01、2026-11-04｜强度：4 <!-- l:1151 -->",
].join("\n"), "做事/本/p1.md", "通用", ARCH);

test("强联想：标了「提醒：动手时」的条目同一次判断里多问一句「这一步就要做吗」，两句都过才贴；没标的不多问（11-04 动作型教训占了噪音的四分之三）", async () => {
  const page = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STEP_PAGE.lessons };
  const a = await associator([page, cp(2)], { probs: { "l:1150": 0.95, "l:1150~step": 0.1, "l:1151": 0.9 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  const r = await a.notes.associate("改完封面脚本，接着拆视频", { region: "main", binding: "midwork" });
  const qs = a.calls[0]!.qs;
  assert.deepEqual(qs.filter((q) => q.name.endsWith("~step")).map((q) => q.name), ["l:1150~step"], "只给标了的多问");
  assert.equal(qs.find((q) => q.name === "l:1150~step")!.text, "她接下来这一步就要碰上「要 git 提交的时候」这个情形吗？只凭上面写出来的判断，看不出来就答否；只是在做沾边的事不算，要看得出这一步就要这么做。");
  assert.equal(a.calls.length, 1, "跟原来的题在同一次判断里");
  assert.deepEqual(r.pages.map((x) => x.hits?.map((h) => h.id)), [["l:1151"]], "这一步不提交：git 那条不贴，钟点那条照贴");

  const b = await associator([page, cp(2)], { probs: { "l:1150": 0.95, "l:1150~step": 0.6 } });
  setParam(b.db, "assoc.itemsK", 0, { why: "测试", by: "t", now: 1 });
  const rb = await b.notes.associate("改完了，git 提交一下", { region: "main", binding: "midwork" });
  assert.deepEqual(rb.pages.map((x) => x.hits?.map((h) => h.id)), [["l:1150"]], "这一步就要提交：贴");
  assert.match(rb.text, /^⚠️ 老毛病[^\n]*\n- 只 add 自己的文件/);
  setParam(b.db, "assoc.stepThreshold", 0.7, { why: "测试", by: "t", now: 2 });
  assert.deepEqual((await b.notes.associate("改完了，git 提交", { region: "side-1", binding: "midwork" })).pages, [], "门槛跟着参数");
});

const SEND_PAGE = parsePage([
  "# 验收和核实 <!-- p:0001 -->", "简介：a", "什么时候翻：b", "", "## 教训",
  "- 教训：没核过就说过了｜什么时候：要说一样东西过了、发给 ada 验收的时候｜下次：先原尺寸看整帧｜犯的日子：2026-10-25、2026-10-28｜提醒：发之前｜强度：5 <!-- l:1160 -->",
  "- 教训：两边同时做同一件事｜什么时候：要发给 ada 之前｜下次：先 peek｜犯的日子：2026-10-25、2026-10-27｜强度：4 <!-- l:1161 -->",
  "- 教训：最终回复写成小结｜什么时候：后台续接回合要写最终回复的时候｜下次：只写 NO_REPLY｜强度：5 <!-- l:1162 -->",
].join("\n"), "做事/本/p1.md", "通用", ARCH);

test("发给 ada 之前（11-05）：强教训只认标了「提醒：发之前」的，没标的不问、不贴；标了的多问「这条里正好又犯了吗」，先只记进 asked，handover.sentAt 调到 1 以下才看它", async () => {
  const page = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: SEND_PAGE.lessons };
  const probs = { "l:1160": 0.97, "l:1160~sent": 0.1, "l:1161": 1, "l:1162": 0.9 };
  const a = await associator([page, cp(2)], { probs });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  const r = await a.notes.associate("要发给 ada：成片.mp4\n要跟 ada 说：成片好了，你有空看看", { region: "main", binding: "handover" });
  const names = a.calls[0]!.qs.map((q) => q.name);
  assert.ok(!names.includes("l:1161") && !names.includes("l:1162"), "没标「发之前」的强教训这时不问");
  assert.ok(names.includes("l:1160~sent"), "标了的多问一句");
  assert.equal(a.calls[0]!.qs.find((q) => q.name === "l:1160~sent")!.text,
    "她这次要发出去的这条里，是不是正好又犯了这条：「要说一样东西过了、发给 ada 验收的时候：没核过就说过了——下次：先原尺寸看整帧」？只凭上面写出来的判断，看不出来就答否；只是跟这条沾边、没犯的不算。");
  assert.deepEqual(r.pages.map((x) => [x.id, x.strong, x.hits?.map((h) => h.id)]), [["0001", true, ["l:1160"]]], "sentAt 默认 1.01：先不看那一问，照旧拦");
  assert.equal(JSON.parse(a.cols().at(-1)!.asked!)["l:1160~sent"], 0.1, "那一问的概率记进 asked");
  setParam(a.db, "handover.sentAt", 0.5, { why: "测试", by: "t", now: 2 });
  const r2 = await a.notes.associate("要发给 ada：成片 v2.mp4\n要跟 ada 说：改好了", { region: "side-1", binding: "handover" });
  assert.ok(!r2.pages.some((x) => x.strong), "调到 1 以下：没犯就不算对得上");
  a.probs["l:1160~sent"] = 0.8;
  const r3 = await a.notes.associate("要发给 ada：成片 v3.mp4\n要跟 ada 说：画面我一帧帧对过了", { region: "side-2", binding: "handover" });
  assert.deepEqual(r3.pages.map((x) => [x.id, x.strong]), [["0001", true]], "判断说犯了：拦");
  // 别的时候照旧：没标的强教训照问照贴
  const m = await a.notes.associate("写最终回复", { region: "side-3", binding: "done_with" });
  assert.ok(m.pages[0]!.hits!.some((h) => h.id === "l:1161"), "没标的强教训交之前照贴");
});

test("发给 ada 之前（review 622a69f）：标了的强教训在取前 strongAsk 条之前就筛出来；「又犯了吗」那一问不照用上次的；没拦的也记一行", async () => {
  const page = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: SEND_PAGE.lessons };
  const a = await associator([page, cp(2)], { probs: { "l:1160": 0.97, "l:1160~sent": 0.1, "0002": 0.95 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  setParam(a.db, "strength.strongAsk", 1, { why: "测试：名额只有一条", by: "t", now: 1 });
  setParam(a.db, "assoc.reuseCos", 0.95, { why: "测试：照用上次的", by: "t", now: 1 });
  // 先算不挂、没确认（像拦了以后她还没重发）：这个脑区还没挂过，下一次照样问得到
  const r1 = await a.notes.associate("要跟 ada 说：成片好了", { region: "main", binding: "handover", hold: true });
  assert.ok(a.calls[0]!.qs.some((q) => q.name === "l:1160"), "强度 5 的 l:1162 排前面也占不了名额：只在标了的里挑");
  r1.discard!();
  assert.equal(JSON.parse(a.cols().at(-1)!.asked!)["l:1160~sent"], 0.1);
  a.tick(60_000);
  a.probs["l:1160~sent"] = 0.8;
  const r2 = await a.notes.associate("要跟 ada 说：成片 v2，画面我一帧帧对过了", { region: "main", binding: "handover", hold: true });
  assert.deepEqual(a.calls[1]!.qs.map((q) => q.name), ["l:1160~sent"], "话题几乎一样（假向量都一样）：别的题照用上次的，只有「又犯了吗」重问");
  r2.confirm!();
  assert.equal(JSON.parse(a.cols().at(-1)!.asked!)["l:1160~sent"], 0.8, "这一次的是重问的");
  // 先算不挂、最后不拦：discard 记一行，概率在 asked 里，不算挂过
  a.tick(60_000);
  a.probs["l:1160"] = 0;
  const r3 = await a.notes.associate("要跟 ada 说：今天的日程", { region: "side-1", binding: "handover", hold: true });
  assert.deepEqual(r3.pages.map((x) => [x.id, x.strong ?? false]), [["0002", false]]);
  const before = a.rows().length;
  r3.discard!();
  r3.discard!();
  assert.equal(a.rows().length, before + 1, "只记一次");
  assert.deepEqual([a.rows().at(-1)!.mounted, a.rows().at(-1)!.skipped], ["[]", "nothing"]);
  assert.equal(JSON.parse(a.cols().at(-1)!.asked!)["0002"], 0.95);
});

test("联想：当天判断花到 assoc.saveAt，干活途中的联想先停（记一行 budget，不调判断）；叫醒、开始做、交之前照常（11-04 19:34 用完以后整晚没联想）", async () => {
  let rate = 0.85;
  const calls: string[] = [];
  const judge: Judge = {
    async judge(_input, qs) { calls.push(qs.map((q) => q.name).join(",")); return { p: new Map(qs.map((q) => [q.name, q.name === "0001" ? 0.9 : 0])), tokens: 1, ms: 1 }; },
    spentRate: () => rate,
  };
  const a = await associator([cp(1), cp(2)], { judge });
  const mid = await a.notes.associate("剪片子中途", { region: "main", binding: "midwork", hold: true });
  assert.equal(mid.skipped, "budget");
  assert.equal(calls.length, 0, "不调判断");
  assert.equal(a.rows()[0]!.skipped, "budget");
  assert.deepEqual((await a.notes.associate("剪片子", { region: "main", binding: "on_it" })).pages.map((x) => x.id), ["0001"], "开始做照常");
  rate = 0.5;
  assert.equal((await a.notes.associate("剪片子中途第二段", { region: "side-1", binding: "midwork" })).skipped, undefined, "没到线照常");
  setParam(a.db, "assoc.saveAt", 0.4, { why: "测试", by: "t", now: 1 });
  assert.equal((await a.notes.associate("剪片子中途第三段", { region: "side-2", binding: "midwork" })).skipped, "budget", "线跟着参数");
});

test("常驻单子：她自己的 skills/常驻.md 放进前缀（最多 residentMax 条，编号注释去掉）；没有单子按强度 5 的教训列，最近犯的在前", () => {
  const shelf = shelfOf({ ...cp(1), lessons: STRONG_PAGE(1).lessons }, { ...cp(2), lessons: [{ ...lesson(1), ids: ["0009"], text: "老的", next: "先核", days: ["2026-10-01"], strength: 5 }] });
  const mine = "# 常驻\n说明随便写\n\n- 发给 ada 之前每个部件放大看 <!-- l:1150 -->\n- 第二条\n- 第三条\n";
  assert.equal(renderResident(mine, shelf, 2, ROLE), [
    "# 常驻：我老犯的（每一轮都记着；单子在 skills/常驻.md，按最近最需要的自己换）",
    "- 发给 ada 之前每个部件放大看",
    "- 第二条",
  ].join("\n"));
  assert.equal(renderResident(null, shelf, 10, ROLE), [
    "# 常驻：我老犯的（每一轮都记着；单子在 skills/常驻.md，按最近最需要的自己换）",
    "- 发小样给 ada 之前 → 每个部件放大看",
    "- 先核",
  ].join("\n"));
  assert.equal(renderResident(null, shelf, 0, ROLE), "");
  assert.equal(renderResident("\uFEFF# 常驻\n1. 编号写的\n* 星号写的\n<!--\n- 注释里的不算\n-->\n", shelf, 10, ROLE).split("\n").slice(1).join("|"), "- 编号写的|- 星号写的", "编号、星号的列表也认；注释里的不算");
  assert.equal(renderResident("# 常驻\n还没写\n", shelfOf(cp(3)), 10, ROLE), "", "单子空、也没有强度 5 的：不放");
});

test("帮手：派给帮手的活拿去联想，挂上的页写成绝对路径附给帮手；每个帮手同一页只给一次；记成 helper，不算她的挂载", async () => {
  const pages = [cp(1), cp(2), cp(3)];
  const a = await associator(pages, { probs: { "0001": 0.9, "0002": 0.8 } });
  const r = await a.notes.forHelper("把会长的嘴照原图重画", "kaichou-l2d");
  assert.equal(r.text, [
    "（我笔记里跟这件事有关的页，动手前先读一遍，里面的做法和踩过的坑照着来：）",
    `- ${join(a.cfg.root, "做事/本/p1.md")}：简介1`,
    `- ${join(a.cfg.root, "做事/本/p2.md")}：简介2`,
  ].join("\n"));
  assert.deepEqual(r.pages, [{ id: "0001", p: 0.9 }, { id: "0002", p: 0.8 }]);
  assert.equal(a.calls[0]!.background, true, "不在回复路径上：失败不算进回复的熔断");
  assert.equal(a.calls[0]!.timeoutMs, 4000, "派活不急，给足时间");
  assert.match(a.calls[0]!.input, /把会长的嘴照原图重画/);
  const row = a.rows()[0]!;
  assert.deepEqual([row.binding, row.region, row.shadow], ["helper", "cc:kaichou-l2d", 0]);
  assert.equal((await a.notes.forHelper("嘴再改圆一点", "kaichou-l2d")).text, "", "同一个帮手同一页不再给");
  assert.match((await a.notes.forHelper("把会长的嘴照原图重画", "l2d-study")).text, /p1\.md/, "换个帮手照给");
  assert.deepEqual(a.notes.mountedSince("main", 0), [], "不算她自己挂过的");
  assert.equal(caught(a.db, shelfOf(...pages), a.rows() as never).mounts, 0, "不算进她的接住率");
  a.notes.prefixRebuilt();
  assert.equal((await a.notes.forHelper("把会长的嘴照原图重画一遍", "kaichou-l2d")).text, "", "她翻页不算帮手换了会话：给过的照样不再给");
  const long = "活".repeat(499) + "😀" + "尾";
  await a.notes.forHelper(long, "emoji-worker");
  assert.ok(!/[\ud800-\udbff]$/.test(a.calls.at(-1)!.input.split("\n")[0]!), "截断不把表情劈成半个");
  const off = await associator(pages, { cfg: { inject: false }, probs: { "0001": 0.9 } });
  assert.equal((await off.notes.forHelper("把会长的嘴照原图重画", "x")).text, "", "只算不挂时不给帮手");
  assert.equal(off.rows()[0]!.shadow, 1);
});

test("帮手：讲她自己的本（说话、学习、身体、派活、聊天）不附给帮手——11-02 拿当天 102 次派活重放，附得最多的是「回话规矩」", async () => {
  const pages = [cp(1, { book: "talk" }), cp(2, { book: "avatar" }), cp(3, { book: "self" }), cp(4, { book: "basics" })];
  const a = await associator(pages, { probs: { "0001": 0.99, "0002": 0.9, "0003": 0.95, "0004": 0.8 }, cfg: { helperSkipBooks: ["talk", "learning", "self", "delegate", "social"] } });
  const r = await a.notes.forHelper("把会长的嘴照原图重画", "kaichou-l2d");
  assert.deepEqual(r.pages, [{ id: "0002", p: 0.9 }, { id: "0004", p: 0.8 }]);
  assert.deepEqual(a.names(0), ["0002", "0004"], "跳过的本连题都不出");
  const mine = await a.notes.associate("回他一句", { region: "main", binding: "wake" });
  assert.deepEqual(mine.pages.map((x) => x.id), ["0001", "0003", "0002"], "她自己的联想照旧");
});

test("hh learn helper <帮手> <活…>：把活拿去给帮手联想，回给帮手看的那段；少了参数报用法", async () => {
  const asked: Array<[string, string]> = [];
  const rt = { notes: { forHelper: async (task: string, worker: string) => { asked.push([task, worker]); return { text: "（附给帮手的）", pages: [] }; } } } as unknown as LearningRuntime;
  const env = { cfg: { ...testConfig().learning, enabled: true }, tz: "UTC", now: () => 0 };
  assert.equal(await learnCommand(rt, "helper", ["kaichou-l2d", "把会长的嘴", "照原图重画"], env), "（附给帮手的）");
  assert.deepEqual(asked, [["把会长的嘴 照原图重画", "kaichou-l2d"]]);
  await assert.rejects(learnCommand(rt, "helper", ["kaichou-l2d"], env), /用法/);
});

test("联想：隔了一分钟以上没判过（连接和缓存都冷了），这次的时限翻倍；隔得近的照常；回测、自查不变", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9 } });
  await a.notes.associate("第一句", { region: "main", binding: "wake" });
  assert.equal(a.calls.at(-1)!.timeoutMs, 800, "刚建好（hhd 刚起来）不算冷");
  a.tick(30_000);
  await a.notes.associate("第二句", { region: "main", binding: "wake" });
  assert.equal(a.calls.at(-1)!.timeoutMs, 800);
  a.tick(61_000);
  await a.notes.associate("第三句", { region: "main", binding: "wake" });
  assert.equal(a.calls.at(-1)!.timeoutMs, 1600, "11-02：闲了 5 分钟以上的第一次判断，中位 1.1 秒，18% 超过 1.5 秒");
  assert.equal(a.vecCalls.at(-1)!.timeoutMs, 1600, "向量和判断共用这个时限");
  await a.notes.associate("第四句", { region: "main", binding: "wake" });
  assert.equal(a.calls.at(-1)!.timeoutMs, 800, "刚判过，又热了");
  a.tick(61_000);
  await a.notes.ask("剪片子");
  assert.equal(a.calls.at(-1)!.timeoutMs, 5000, "自查照旧");
});

test("practiceHead：「## 做法」里前几条顶层的条目（列表或编号），编号注释去掉、带时间的出处缩成「ada 教的」，太长的截断", () => {
  assert.deepEqual(practiceHead(PRACTICE_PAGE, 3, KEEP), [
    "新动作先学成熟做法，一步步来（ada 教的）：先找官方 Live2D 教程",
    "**转头**：照官方的 AngleX/Y 做",
    `${"长".repeat(120)}…`,
  ]);
  assert.deepEqual(practiceHead(PRACTICE_PAGE, 1, KEEP), ["新动作先学成熟做法，一步步来（ada 教的）：先找官方 Live2D 教程"]);
  const numbered = "# 页\n## 做法\n### 流程（10-29 走通，ada 11:40「记住这个流程」）\n1. 定稿素材冻结成一个目录（10-29）\n2. 参数照认可过的旧版原样搬\n代码在 final-rig/\n";
  assert.deepEqual(practiceHead(numbered), ["定稿素材冻结成一个目录", "参数照认可过的旧版原样搬"]);
  assert.deepEqual(practiceHead("# 页\n## 教训\n- 教训：没有做法这一节\n"), []);
});

test("practiceHead：「## 做法（…）」也算；代码块里的不算；「1、」也是编号；只剩个空标签的条目不给", () => {
  const md = [
    "# 页", "## 做法（11-01 起）", "```bash", "## 这是代码里的注释", "- 这也是代码", "```",
    "1、先看说明", "- **具体怎么做**：", "- （ada 教的，2026-10-25 20:29）", "- 真正的一条", "## 教训", "- 别的",
  ].join("\n");
  assert.deepEqual(practiceHead(md, 3, KEEP), ["先看说明", "真正的一条"]);
});

test("practiceHead：只是个小标题的条目，用它下一层的「怎么做」补上；做法全在待验证里时给待验证的，标出来", () => {
  const label = "# 页\n## 做法\n- **何时触发**：要做新工具之前。\n- **具体怎么做**：\n  1. 先搜现成的\n  2. 再魔改\n- 转头（ada 教的，2026-10-25 20:29）\n  - 何时：加转头\n  - 怎么做：照官方 AngleX 做三档\n";
  assert.deepEqual(practiceHead(label, 3, KEEP), ["**何时触发**：要做新工具之前。", "**具体怎么做**：先搜现成的", "转头（ada 教的）：照官方 AngleX 做三档"]);
  const pending = "# 页\n## 做法\n\n### 待验证\n（还没有靠谱的）\n- 什么时候：要看漫画\n- 怎么做：单页模式、关弹幕\n## 教训\n- 教训：别的\n";
  assert.deepEqual(practiceHead(pending), ["（待验证）什么时候：要看漫画", "（待验证）怎么做：单页模式、关弹幕"]);
  assert.deepEqual(practiceHead("# 页\n## 做法\n- 靠谱的一条\n### 待验证\n- 待验证的不给\n"), ["靠谱的一条"], "有靠谱的就不给待验证的");
});

test("联想：开始做一件事（on_it）时，挂上的第一页把「做法」的头几条直接贴出来；别的页、别的时候只给封面", async () => {
  const pages = [cp(1, { rel: "做事/本/p1.md" }), cp(2, { rel: "做事/本/p2.md" })];
  const files = { "做事/本/p1.md": PRACTICE_PAGE, "做事/本/p2.md": PRACTICE_PAGE };
  const a = await associator(pages, { probs: { "0001": 0.95, "0002": 0.9 }, files });
  const r = await a.notes.associate("给会长加转头", { region: "main", binding: "on_it", taskId: 3 });
  assert.equal(r.text, [
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
    "· 本 · p1：简介1（skills/做事/本/p1.md）",
    "  先照这几条做：",
    "  - 新动作先学成熟做法，一步步来（ada 教的）：先找官方 Live2D 教程",
    "  - **转头**：照官方的 AngleX/Y 做",
    `  - ${"长".repeat(120)}…`,
    "· 本 · p2：简介2（skills/做事/本/p2.md）",
  ].join("\n"));
  const b = await associator(pages, { probs: { "0001": 0.95 }, files });
  assert.doesNotMatch((await b.notes.associate("给会长加转头", { region: "main", binding: "wake" })).text, /先照这几条做/, "叫醒时只给封面");
  const c = await associator(pages, { probs: { "0001": 0.95 } });
  assert.equal((await c.notes.associate("给会长加转头", { region: "main", binding: "on_it" })).text,
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：\n· 本 · p1：简介1（skills/做事/本/p1.md）", "读不到页就只给封面");
});

test("联想：这句话单独一页都没过时，带上她刚说的几句再判一次（纠正题只在第一次问）；过了就挂，只记一行", async () => {
  const seen: string[] = [];
  const judge: Judge = {
    async judge(input, qs) {
      seen.push(input);
      return { p: new Map(qs.map((q) => [q.name, q.name === "0002" && input.includes("会长的形象") ? 0.9 : q.name === "correction" ? 0.1 : 0])), tokens: 10, ms: 5 };
    },
  };
  const a = await associator([cp(1), cp(2), cp(3)], { judge });
  const extra = [{ name: "correction", text: "这条是在纠正或否定她刚做的事吗？" }];
  const r = await a.notes.associate("这几个都不够好，再找找更现代的", { region: "main", binding: "wake", context: "会长的形象我照官方分层重做了", extra });
  assert.deepEqual(r.pages, [{ id: "0002", p: 0.9 }]);
  assert.equal(r.skipped, undefined);
  assert.match(r.text, /p2/);
  assert.equal(seen.length, 2);
  assert.doesNotMatch(seen[0]!, /会长的形象/);
  assert.match(seen[1]!, /会长的形象我照官方分层重做了\n这几个都不够好/);
  assert.deepEqual(a.vecCalls.map((c) => c.q), ["这几个都不够好，再找找更现代的", "会长的形象我照官方分层重做了\n这几个都不够好，再找找更现代的"]);
  assert.equal(r.extra.get("correction"), 0.1, "纠正题的结果是第一次判的");
  const rows = a.rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.topic, "这几个都不够好，再找找更现代的");
  assert.equal(rows[0]!.mounted, JSON.stringify(r.pages));
  assert.equal(rows[0]!.tokens, 20, "两次判断的花费都算");
});

test("联想：带上她的话再判只在单独一页都没过时；她的话没内容、或者剩的时间不够就不再判", async () => {
  let n = 0;
  let spend = 0;
  let a!: Awaited<ReturnType<typeof associator>>;
  const judge: Judge = {
    async judge(_input, qs) {
      n++;
      a.tick(spend);
      return { p: new Map(qs.map((q) => [q.name, q.name === "0001" && n === 1 && spend === 1 ? 0.9 : 0])), tokens: 1, ms: 5 };
    },
  };
  a = await associator([cp(1), cp(2)], { judge });
  spend = 1;
  assert.deepEqual((await a.notes.associate("剪片子的节奏", { region: "main", binding: "wake", context: "会长的形象我照官方分层重做了" })).pages, [{ id: "0001", p: 0.9 }]);
  assert.equal(n, 1, "第一次就挂上了，不再判");
  n = 0; spend = 0;
  assert.equal((await a.notes.associate("配音的嗓子", { region: "main", binding: "wake", context: "好的👌" })).skipped, "nothing");
  assert.equal(n, 1, "她的话没内容");
  n = 0;
  assert.equal((await a.notes.associate("封面的字", { region: "main", binding: "wake" })).skipped, "nothing");
  assert.equal(n, 1, "没给她的话");
  n = 0; spend = a.cfg.timeoutMs - 100;
  assert.equal((await a.notes.associate("标题怎么起", { region: "main", binding: "wake", context: "会长的形象我照官方分层重做了" })).skipped, "nothing");
  assert.equal(n, 1, "剩的时间不够再判一次");
  // 开始再判时够，带上她的话算完向量就不够了：不判（时间太短的判断多半超时，还会算进回复路径的熔断）
  n = 0; spend = 0;
  let vecs = 0;
  a.setVec(async () => { vecs++; if (vecs === 2) a.tick(a.cfg.timeoutMs - 100); return E0; });
  assert.equal((await a.notes.associate("配乐挑哪首", { region: "main", binding: "wake", context: "会长的形象我照官方分层重做了" })).skipped, "nothing");
  assert.deepEqual([vecs, n], [2, 1]);
});

test("联想：带上她的话再判的那次，判断标成后台的（失败不算进回复路径的熔断）", async () => {
  const seen: Array<{ input: string; background?: true }> = [];
  const judge: Judge = {
    async judge(input, qs, jo) {
      seen.push({ input, ...(jo?.background ? { background: true as const } : {}) });
      return { p: new Map(qs.map((q) => [q.name, 0])), tokens: 1, ms: 5 };
    },
  };
  const a = await associator([cp(1)], { judge });
  await a.notes.associate("这几个都不够好", { region: "main", binding: "wake", context: "会长的形象我照官方分层重做了" });
  assert.deepEqual(seen.map((s) => s.background ?? false), [false, true]);
});

test("联想：Brain 只等到时限的几处（开始做、目标、想一想）和派活附笔记（cc.py 只等 10 秒）判断超时不再试，别的照常再试（#0047）", async () => {
  const seen: string[] = [];
  let at = "";
  const judge: Judge = {
    async judge(_input, qs, jo) {
      seen.push(`${at}:${jo?.once ? "once" : "retry"}`);
      return { p: new Map(qs.map((q) => [q.name, 0])), tokens: 1, ms: 5 };
    },
  };
  const a = await associator([cp(1)], { judge });
  for (const binding of ["on_it", "goals", "mull_over", "wake", "midwork", "done_with", "handover", "replay"] as const) {
    at = binding;
    await a.notes.associate(`给会长做${binding}的小样`, { region: binding, binding });
  }
  at = "helper";
  await a.notes.forHelper("给会长做小样", "w");
  at = "ask";
  await a.notes.ask("给会长做小样");
  // 页问不了、只问纠正题的那一下也一样
  at = "on_it/lowinfo";
  await a.notes.associate("不行", { region: "x", binding: "on_it", extra: [{ name: "correction", text: "吗？" }] });
  assert.deepEqual(seen, [
    "on_it:once", "goals:once", "mull_over:once",
    "wake:retry", "midwork:retry", "done_with:retry", "handover:retry", "replay:retry", "helper:once", "ask:retry",
    "on_it/lowinfo:once",
  ]);
});

test("联想：没内容的话不联想，但纠正题照问", async () => {
  const q = { name: "correction", text: "这条是在纠正或否定她刚做的事吗？" };
  const input = (t: string) => `她正要回应或开始做：${t}\n每题问：这件事需要翻这一页笔记吗？只有正好讲这类事的做法或教训才算。`;
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9, correction: 0.92 } });

  // "不行"去掉语气词只剩一个字，算没内容：页不问，纠正题单独问
  const r = await a.notes.associate("不行", { region: "main", binding: "wake", extra: [q] });
  assert.equal(r.skipped, "lowinfo");
  assert.equal(r.text, "");
  assert.deepEqual(r.pages, []);
  assert.deepEqual([...r.extra], [["correction", 0.92]]);
  assert.equal(r.tokens, 100);
  assert.equal(a.vecCalls.length, 0, "不算向量");
  assert.deepEqual(a.calls, [{ input: input("不行"), qs: [q], timeoutMs: 800 }]);
  assert.deepEqual({ ...a.rows()[0]!, id: 0 }, {
    id: 0, at: SH_NOON, region: "main", binding: "wake", topic: "不行", task_id: null, candidates: 0,
    mounted: "[]", shadow: 0, skipped: "lowinfo", ms: 0, tokens: 100,
  });

  // 同一个话题：页不问，纠正题照问
  await a.notes.associate("不是这样，重来", { region: "main", binding: "wake", extra: [q] });
  assert.equal(a.calls[1]!.qs.length, 3);
  const same = await a.notes.associate("不是这样，重来", { region: "main", binding: "wake", extra: [q] });
  assert.equal(same.skipped, "same");
  assert.deepEqual([...same.extra], [["correction", 0.92]]);
  assert.deepEqual(a.calls[2]!.qs, [q]);
  assert.equal(a.vecCalls.length, 1, "same 不算向量");

  // 向量没算出来（用掉 300 毫秒）：纠正题在剩下的时间里问
  a.setVec(async () => { a.tick(300); return null; });
  const nv = await a.notes.associate("换个说法也不行", { region: "main", binding: "wake", extra: [q] });
  assert.equal(nv.skipped, "novec");
  assert.deepEqual([...nv.extra], [["correction", 0.92]]);
  assert.deepEqual(a.calls[3], { input: input("换个说法也不行"), qs: [q], timeoutMs: 500 });
  // 时间用完了就不问
  a.setVec(async () => { a.tick(800); return null; });
  const late = await a.notes.associate("还是不行啊", { region: "main", binding: "wake", extra: [q] });
  assert.equal(late.skipped, "novec");
  assert.equal(late.extra.size, 0);
  assert.equal(a.calls.length, 4);

  // 判断失败：原因照旧，extra 为空
  a.judgeMode("null");
  const failed = await a.notes.associate("不行", { region: "main", binding: "wake", extra: [q] });
  assert.equal(failed.skipped, "lowinfo");
  assert.equal(failed.extra.size, 0);
  assert.equal(failed.tokens, 0);
  assert.equal(a.calls.length, 5);

  // 开关关着：什么都不问
  a.judgeMode("ok");
  a.cfg.enabled = false;
  assert.equal((await a.notes.associate("不行", { region: "main", binding: "wake", extra: [q] })).skipped, "off");
  assert.equal(a.calls.length, 5);

  // 没候选（书架是空的）：页不问，纠正题照问
  const b = await associator([], { probs: { correction: 0.3 } });
  const none = await b.notes.associate("不是这样，重来", { region: "main", binding: "wake", extra: [q] });
  assert.equal(none.skipped, "nothing");
  assert.deepEqual([...none.extra], [["correction", 0.3]]);
  assert.deepEqual(b.calls, [{ input: input("不是这样，重来"), qs: [q], timeoutMs: 800 }]);
  assert.equal(b.rows()[0]!.candidates, 0);
  assert.equal(b.rows()[0]!.skipped, "nothing");
});

test("联想：extra 题一起问，结果单独给", async () => {
  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9, correction: 0.85 } });
  const q = { name: "correction", text: "这条是在纠正或否定她刚做的事吗？" };
  const r = await a.notes.associate("不是这样，重来", { region: "main", binding: "wake", extra: [q] });
  assert.deepEqual([...r.extra], [["correction", 0.85]]);
  assert.deepEqual(r.pages, [{ id: "0001", p: 0.9 }], "extra 不算进页");
  assert.equal(r.text, "想起来的笔记（用得上就翻开）：\n· 本 · p1：简介1（skills/做事/本/p1.md）");
  assert.deepEqual(a.calls[0]!.qs.at(-1), q, "同一次请求里问，排在页后面");
  assert.equal(a.calls[0]!.qs.length, 3);
  const row = a.rows()[0]!;
  assert.equal(row.candidates, 2, "候选只数页");
  assert.equal(row.mounted, JSON.stringify([{ id: "0001", p: 0.9 }]));

  // 一页都没过，extra 照样给
  a.probs["0002"] = 0.1;
  const r2 = await a.notes.associate("又不对，重来一遍", { region: "main", binding: "wake", extra: [q] });
  assert.equal(r2.skipped, "nothing");
  assert.deepEqual(r2.pages, []);
  assert.deepEqual([...r2.extra], [["correction", 0.85]]);
});

test("ask：不粗筛、门槛 0.5、全部列出", async () => {
  // 封面向量一个都没算：ask 不靠它
  const pages = [
    cp(1), cp(2, { lessons: [lesson(1)] }), cp(3, { archived: true }), cp(4, { ids: [] }), gen(5), cp(6), cp(7),
  ];
  const a = await associator(pages, {
    covers: false, cfg: { inject: false },
    probs: { "0001": 0.55, "0002": 0.9, "0003": 0.99, "0005": 0.6, "0006": 0.5, "0007": 0.49 },
  });
  const r = await a.notes.ask("要验收一条视频");
  assert.deepEqual(r.pages, [{ id: "0002", p: 0.9 }, { id: "0005", p: 0.6 }, { id: "0001", p: 0.55 }, { id: "0006", p: 0.5 }],
    "过 0.5 的全给（不受 maxPages 限），按概率排");
  assert.equal(r.text, [
    "· 本 · p2：简介2（1 条教训；skills/做事/本/p2.md）",
    "· 本 · p5：简介5（skills/通用/本/p5.md）",
    "· 本 · p1：简介1（skills/做事/本/p1.md）",
    "· 本 · p6：简介6（skills/做事/本/p6.md）",
  ].join("\n"));
  assert.equal(a.vecCalls.length, 0, "不算向量");
  assert.equal(a.calls[0]!.timeoutMs, 5000, "她自己要找、等着结果，给 5 秒");
  assert.equal(a.calls[0]!.input, "她正要回应或开始做：要验收一条视频\n每题问：这件事需要翻这一页笔记吗？只有正好讲这类事的做法或教训才算。");
  assert.deepEqual(a.names(0), ["0001", "0002", "0005", "0006", "0007"], "归档的、没编号的不问");
  assert.deepEqual(a.rows().map((x) => ({ ...x, id: 0 })), [{
    id: 0, at: SH_NOON, region: "ask", binding: "ask", topic: "要验收一条视频", task_id: null, candidates: 5,
    mounted: JSON.stringify(r.pages), shadow: 0, skipped: null, ms: 0, tokens: 500,
  }]);

  // 只看一个大类
  const g = await a.notes.ask("要验收一条视频", "通用");
  assert.deepEqual(a.names(1), ["0005"]);
  assert.deepEqual(g.pages, [{ id: "0005", p: 0.6 }]);

  // 不缓存：同一个话题再问照样判
  await a.notes.ask("要验收一条视频");
  assert.equal(a.calls.length, 3);
  assert.equal(a.rows().length, 3);

  // 开关关着照样能用，只是不记
  a.cfg.enabled = false;
  assert.deepEqual((await a.notes.ask("要验收一条视频")).pages, r.pages);
  assert.equal(a.rows().length, 3);

  // 判断失败：什么都不给，标上 failed（和真没找到分开）
  assert.equal(r.failed, false);
  a.judgeMode("null");
  assert.deepEqual(await a.notes.ask("要验收一条视频"), { text: "", pages: [], failed: true });
  a.judgeMode("throw");
  assert.deepEqual(await a.notes.ask("要验收一条视频"), { text: "", pages: [], failed: true });
  // 这个大类没有页：不调判断，不算失败
  a.judgeMode("ok");
  assert.deepEqual(await a.notes.ask("要验收一条视频", "没有这个大类"), { text: "", pages: [], failed: false });
  assert.equal(a.calls.length, 6, "没有候选不调判断");
  // 判了、一页都没过：真没找到
  a.cfg.askThreshold = 0.999;
  assert.deepEqual(await a.notes.ask("要验收一条视频"), { text: "", pages: [], failed: false });
});

// ---------- 运行时 ----------
import { createLearningRuntime } from "../src/learning/runtime.ts";

test("运行时：条目向量没算成（向量服务给 null）记一条，书架没变也会隔一阵再试", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一", ["甲"]) });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  try {
    const db = openDb(":memory:");
    const logs: LogRecord[] = [];
    const embedded: string[][] = [];
    const base = coverEmbedder(embedded);
    let down = true;
    const embedder: Embedder = { embed: async (texts, o) => (down && texts.includes("甲") ? null : base.embed(texts, o)) };
    let now = T;
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, enabled: true, root }, embedder, judge: { judge: async () => null },
      vec: async () => E0, now: () => now, log: new Logger("t", memorySink(logs)), stateDir: root, tz: "UTC",
    });
    rt.shelf();
    await tick(); await tick();
    assert.equal(logs.filter((l) => l.msg === "learning: item vectors failed").length, 1);
    down = false;
    rt.refreshIfChanged();
    await tick(); await tick();
    assert.ok(!embedded.some((b) => b.includes("甲")), "刚失败过，还没到再试的时候");
    now += 10 * 60_000;
    rt.refreshIfChanged();
    await tick(); await tick();
    assert.ok(embedded.some((b) => b.includes("甲")), "书架没变，隔了一阵也再试了");
    assert.equal(logs.filter((l) => l.msg === "learning: item vectors failed").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 算过几批封面向量（条目的向量另算，不带「什么时候翻」） */
const coverBatches = (embedded: string[][]): number => embedded.filter((b) => b.some((t) => t.includes("什么时候翻"))).length;

test("运行时：给了 viewItemChars，「隔多少再挂」按这个脑区自己眼前的算（central.viewTokens）：别的脑区的大结果只算一行（11-04）", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一", ["甲｜什么时候：交小样前｜下次：放大看｜强度：5"]) });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  try {
    const db = openDb(":memory:");
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, enabled: true, inject: true, root }, embedder: coverEmbedder([]),
      judge: { judge: async (_i, qs) => ({ p: new Map(qs.map((q) => [q.name, q.name === "0001" ? 0.9 : 0])), tokens: 1, ms: 1 }) },
      vec: async () => E0, now: () => T, log: new Logger("t", memorySink([])), stateDir: root, tz: "UTC", viewItemChars: 1500,
    });
    rt.shelf();
    await tick(); await tick();
    setParam(db, "strength.strongRemountTokens", 100, { why: "测试", by: "t", now: 1 });
    const central = new CentralMemory(db, () => T);
    central.append(1, "main", "say", "开头");
    assert.deepEqual((await rt.notes.associate("话题一", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"]);
    central.append(1, "side-1", "result", "长".repeat(4000), { id: "big" });
    assert.deepEqual((await rt.notes.associate("话题二", { region: "main", binding: "wake" })).pages, [], "帮手的大结果在她眼前只是一行");
    central.append(1, "main", "say", "长".repeat(400));
    assert.deepEqual((await rt.notes.associate("话题三", { region: "main", binding: "wake" })).pages.map((x) => x.id), ["0001"], "她自己看够了才再挂");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行时：scan 先发号再扫、封面在后台刷，shelf 用缓存；联想的向量最多等 timeoutMs", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一", ["甲"]) });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  try {
    const db = openDb(":memory:");
    const logs: LogRecord[] = [];
    const embedded: string[][] = [];
    let vec: (q: string) => Promise<Float32Array | null> = async () => E0;
    const vecCalls: Array<number | undefined> = [];
    const cfg: LearningCfg = { ...testConfig().learning, enabled: true, root, timeoutMs: 30 };
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg, embedder: coverEmbedder(embedded), judge: { judge: async () => null },
      vec: (q, ms) => { vecCalls.push(ms); return vec(q); }, now: () => T, log: new Logger("t", memorySink(logs)), stateDir: root, tz: "UTC",
    });

    // 没扫过：shelf() 先扫一次；扫出来的页已经带号（文件也写上了），封面在后台算
    const shelf = rt.shelf();
    assert.deepEqual(shelf.pages.map((p) => [p.ids, p.lessons.map((l) => l.ids)]), [[["0001"], [["0002"]]]]);
    assert.match(read(root, "通用/验收/一.md"), /^# 一 <!-- p:0001 -->/);
    await tick();
    assert.deepEqual(all<{ page_id: string }>(db, "SELECT page_id FROM learn_cover").map((r) => r.page_id), ["0001"]);
    assert.equal(coverBatches(embedded), 1);
    assert.ok(embedded.some((b) => b.includes("甲")), "页里的教训也算了向量（条目联想用）");
    assert.equal(rt.shelf(), shelf, "缓存着，不再扫");

    // 新加一页：scan 重扫，换掉缓存
    writeFileSync(join(root, "通用/验收/二.md"), page("二"));
    const again = rt.scan();
    assert.deepEqual(again.pages.map((p) => p.ids[0]), ["0001", "0003"]);
    assert.equal(rt.shelf(), again);
    await tick();
    assert.equal(coverBatches(embedded), 2);
    assert.equal(embedded.filter((b) => b.includes("甲")).length, 1, "没变的教训不重算");

    // 向量一直不回来（接上了一次等得更久的）：最多等 timeoutMs，按没有向量算
    vec = () => new Promise<Float32Array | null>(() => {});
    const t0 = Date.now();
    const r = await rt.notes.associate("验收这条成片", { region: "main", binding: "wake" });
    assert.equal(r.skipped, "novec");
    assert.ok(Date.now() - t0 < 10_000, `${Date.now() - t0}ms（向量那头永远不回；只防卡死；墙钟在机器忙时会慢，11-14 部署前检查里 1 秒的界挂过（1.3 秒），别卡太紧）`);
    assert.equal(vecCalls.at(-1), 30);

    // 刷封面出错：只记 warn，scan 照常返回
    const bad = createLearningRuntime({
      ...WHO,
      db: openDb(":memory:"), cfg, embedder: { async embed() { throw new Error("embed exploded"); } }, judge: { judge: async () => null },
      vec: async () => null, now: () => T, log: new Logger("t", memorySink(logs)), stateDir: root, tz: "UTC",
    });
    assert.equal(bad.scan().pages.length, 2);
    await tick();
    assert.ok(logs.some((l) => l.level === "warn" && /cover/.test(l.msg) && /embed exploded/.test(String(l.error))));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行时：扫书架出了问题记一条 warn（书架目录不进前缀时也记）；问题没变不重复记，好了以后再坏再记", () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一") });
  try {
    const logs: LogRecord[] = [];
    const rt = createLearningRuntime({
      ...WHO,
      db: openDb(":memory:"), cfg: { ...testConfig().learning, root, shelf: false }, embedder: null, judge: { judge: async () => null },
      vec: async () => null, now: () => T, log: new Logger("t", memorySink(logs)), stateDir: root, tz: "UTC",
    });
    const warns = () => logs.filter((l) => l.level === "warn" && l.msg === "learning: shelf scan problems");
    // 页上缺字段：scan 前后都有这个问题
    writeFileSync(join(root, "通用/验收/三.md"), "# 三\n");
    rt.scan();
    assert.equal(warns().length, 1);
    assert.equal(warns()[0]!.count, 2, "缺简介、缺什么时候翻");
    assert.match(JSON.stringify(warns()[0]!.first), /三\.md/);
    rt.scan();
    assert.equal(warns().length, 1, "一样的问题不再记");
    writeFileSync(join(root, "通用/验收/三.md"), page("三"));
    rt.scan();
    writeFileSync(join(root, "通用/验收/三.md"), "# 三\n");
    rt.scan();
    assert.equal(warns().length, 2, "好过一次再坏，再记");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行时：书架有改动、最近一次改动过了安静期才重扫（新页补号、刷封面）；还在写、没改动、读不了书架都不扫", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一") });
  const tick = () => new Promise<void>((r) => setImmediate(r));
  try {
    const db = openDb(":memory:");
    let now = T;
    const embedded: string[][] = [];
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, root }, embedder: coverEmbedder(embedded), judge: { judge: async () => null },
      vec: async () => E0, now: () => now, log: new Logger("t", memorySink([])), stateDir: root, tz: "UTC",
    });

    // 还没扫过：扫一次，页拿到号
    assert.equal(rt.refreshIfChanged(), true);
    assert.match(read(root, "通用/验收/一.md"), /^# 一 <!-- p:0001 -->/);
    // 没改动（发号自己写回文件不算）：不扫
    assert.equal(rt.refreshIfChanged(), false);

    // 她半分钟前刚写了一页：还在写，先不扫，缓存照旧
    writeFileSync(join(root, "通用/验收/二.md"), page("二"));
    const justNow = (now - 30_000) / 1000;
    utimesSync(join(root, "通用/验收/二.md"), justNow, justNow);
    assert.equal(rt.refreshIfChanged(), false);
    assert.doesNotMatch(read(root, "通用/验收/二.md"), /<!-- p:/);
    assert.equal(rt.shelf().pages.length, 1);

    // 安静过了两分钟：重扫，新页拿到号、进缓存，封面在后台算；之后又不扫了
    now += 120_000;
    assert.equal(rt.refreshIfChanged(), true);
    assert.match(read(root, "通用/验收/二.md"), /^# 二 <!-- p:0002 -->/);
    assert.deepEqual(rt.shelf().pages.map((p) => p.ids[0]), ["0001", "0002"]);
    await tick();
    assert.equal(embedded.length, 2);
    assert.equal(rt.refreshIfChanged(), false);

    // 改了一页的封面（大小变了）也算改动
    writeFileSync(join(root, "通用/验收/一.md"), read(root, "通用/验收/一.md").replace("简介：a", "简介：看完整条再说"));
    const quiet = (now - 200_000) / 1000;
    utimesSync(join(root, "通用/验收/一.md"), quiet, quiet);
    assert.equal(rt.refreshIfChanged(), true);
    assert.equal(rt.shelf().pages.find((p) => p.ids[0] === "0001")?.brief, "看完整条再说");

    // 书架目录读不了：不扫、不抛
    const gone = createLearningRuntime({
      ...WHO,
      db: openDb(":memory:"), cfg: { ...testConfig().learning, root: join(root, "没有这个目录") }, embedder: coverEmbedder(), judge: { judge: async () => null },
      vec: async () => E0, now: () => now, log: new Logger("t", memorySink([])), stateDir: root, tz: "UTC",
    });
    assert.equal(gone.refreshIfChanged(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("运行时：联想的向量按调用的人给的时间等（回测给得长，回复路径照旧掐在 timeoutMs）", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一") });
  try {
    const db = openDb(":memory:");
    let judged = 0;
    const cfg: LearningCfg = { ...testConfig().learning, enabled: true, root, timeoutMs: 30 };
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg, embedder: coverEmbedder(), judge: { judge: async (_i, qs) => { judged += 1; return { p: new Map(qs.map((q) => [q.name, 0])), tokens: 1, ms: 1 }; } },
      vec: () => new Promise<Float32Array | null>((r) => setTimeout(() => r(E0), 80)), now: () => T, log: new Logger("t", memorySink([])), stateDir: root, tz: "UTC",
    });
    await rt.rescan();
    assert.equal((await rt.notes.associate("验收这条成片", { region: "main", binding: "wake" })).skipped, "novec");
    assert.equal(judged, 0);
    assert.equal((await rt.notes.associate("验收这条成片", { region: "replay", binding: "replay" })).skipped, "nothing");
    assert.equal(judged, 1, "等到了向量，判了");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- hhd 接线 ----------
import { makeLearning } from "../src/learning/runtime.ts";
import { EventMemory } from "../src/memory/events/memory.ts";
import { OpenAIEmbedder } from "../src/memory/events/embed.ts";
import { learnView } from "../src/console/learn.ts";

const EMBED_URL = "https://api.openai.com/v1/embeddings";
const DECIDE_URL = "https://api.openai.com/v1/decisions";

/** 假的 OpenAI：记下打到哪个地址；向量都回 e0，Decisions 每题都说 0.9 */
function fakeOpenAI() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    urls.push(url);
    const body = JSON.parse(String(init.body)) as { input: string[] | string; questions?: Array<{ name: string }> };
    if (url === DECIDE_URL) {
      const answers = body.questions!.map((q) => ({ name: q.name, type: "predicate", probability: 0.9 }));
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 100 } }), { status: 200 });
    }
    const data = (body.input as string[]).map((_, index) => ({ embedding: [...E0], index }));
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as unknown as typeof fetch;
  return { urls, fetchImpl };
}

test("没有 OpenAI key：联想只按字找——和话题共有的字够多的页挂上，不沾边的不挂，不打任何网络", async () => {
  const root = makeShelf({
    "通用/剪辑/SKILL.md": "---\nname: 剪辑\ndescription: d\n---\n",
    "通用/剪辑/验收.md": "# 成片怎么验收\n简介：剪好的视频成片交出去之前怎么验收\n什么时候翻：要验收成片的时候\n",
    "通用/剪辑/煮面.md": "# 怎么煮面\n简介：煮面的火候\n什么时候翻：饿了的时候\n",
  });
  const logs: LogRecord[] = [];
  const cfg = testConfig({ stateDir: tmpDir("hh-kw-state-"), schedule: { timezone: "Australia/Melbourne" }, learning: { root, enabled: true } });
  const rt = makeLearning(cfg, openDb(":memory:"), undefined, new Logger("t", memorySink(logs)), { fetchImpl: (async () => { throw new Error("no network"); }) as unknown as typeof fetch, now: () => T })!;
  assert.equal((await rt.rescan()).embedded, 0, "no vectors");
  const shelf = rt.shelf().pages;
  const id = (title: string) => shelf.find((p) => p.title.includes(title))!.ids[0];
  const r = await rt.notes.associate("验收这条视频成片", { region: "main", binding: "wake" });
  assert.deepEqual(r.pages.map((p) => p.id), [id("验收")]);
  assert.deepEqual((await rt.notes.associate("今天天气不错", { region: "main", binding: "wake" })).pages, []);
});

test("hhd 接线：没有 key 也建（只按字找）、记 warn；开关全关也建；有事件记忆就共用它的向量服务和线索缓存；告警记 error、写进 kv，控制台只标 24 小时内的", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一") });
  const stateDir = tmpDir("hh-wire-state-");
  try {
    const logs: LogRecord[] = [];
    const log = new Logger("t", memorySink(logs));
    const tz = "Australia/Melbourne";
    const off = testConfig({ stateDir, schedule: { timezone: tz }, learning: { root, dailyUsd: 2 } });
    const on = testConfig({ stateDir, schedule: { timezone: tz }, learning: { root, dailyUsd: 2, enabled: true } });

    // 没有 key：照样建（联想只按字找，见下一条测试），记一条 warn
    assert.ok(makeLearning(off, openDb(":memory:"), undefined, log));
    assert.ok(logs.some((l) => l.level === "warn" && l.msg === "learning: no OpenAI key, keyword search only"));

    // 有 key：开关全关也建（hh learn、夜里的工作单要用）
    writeFileSync(join(stateDir, "secrets.json"), JSON.stringify({ openaiKey: "sk-test" }));
    assert.ok(makeLearning(off, openDb(":memory:"), undefined, log, { fetchImpl: fakeOpenAI().fetchImpl, now: () => T }));

    // 有事件记忆：封面、话题的向量都走事件记忆那个 embedder；同一句话事件记忆算过，联想就不再算；判断走自己的
    const db = openDb(":memory:");
    const memApi = fakeOpenAI();
    const mem = new EventMemory({ db, embedder: new OpenAIEmbedder({ key: "sk-test", fetchImpl: memApi.fetchImpl }), tz });
    const own = fakeOpenAI();
    const rt = makeLearning(on, db, mem, log, { fetchImpl: own.fetchImpl, now: () => T })!;
    assert.equal((await rt.rescan()).embedded, 1);
    assert.deepEqual(memApi.urls, [EMBED_URL]);
    await mem.index.cueVector("验收这条成片");
    assert.equal(memApi.urls.length, 2);
    const r = await rt.notes.associate("验收这条成片", { region: "main", binding: "wake" });
    assert.deepEqual(r.pages.map((p) => p.id), ["0001"]);
    assert.equal(memApi.urls.length, 2, "话题的向量从事件记忆的缓存里拿");
    assert.deepEqual(own.urls, [DECIDE_URL]);

    // 告警：记 error，kv learn.alert 写上时间和那句话（上限按 config，日子按她的时区）
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(T);
    kvSet(db, `learn.spend.${day}`, String(30_000_000));   // 3 美元，过了 2 美元的上限
    await rt.notes.ask("验收这条成片");
    const alert = logs.find((l) => l.level === "error" && l.msg === "learning alert");
    assert.match(String(alert?.alert), /今天用到上限了.*上限 2 美元/);
    const saved = JSON.parse(kvGet(db, "learn.alert")!) as { at: number; msg: string };
    assert.equal(saved.at, T);
    assert.match(saved.msg, /今天用到上限了.*上限 2 美元/);
    assert.equal(own.urls.length, 1, "到上限不再请求");

    // 控制台读的就是 hhd 写的这一行：24 小时内标出来（给那句话和时间），过了 24 小时不标；旧的纯文字照旧标、没有时间
    const view = (at: number) => { const v = learnView(db, at, { root, generalCategory: GEN, archiveDir: ARCH, tz, dailyUsd: 2 }); return [v.alert, v.alertAt]; };
    assert.deepEqual(view(T + 60_000), [saved.msg, T]);
    assert.deepEqual(view(T + 24 * 3_600_000), [null, null]);
    kvSet(db, "learn.alert", "联想的判断今天用到上限了");
    assert.deepEqual(view(T + 30 * 24 * 3_600_000), ["联想的判断今天用到上限了", null]);

    // 没有事件记忆、或者事件记忆没有向量服务：自己开一个 embedder（用自己的那个 key）
    for (const m of [undefined, new EventMemory({ db: openDb(":memory:"), embedder: null, tz })]) {
      const solo = fakeOpenAI();
      const rt2 = makeLearning(on, openDb(":memory:"), m, log, { fetchImpl: solo.fetchImpl, now: () => T })!;
      assert.equal((await rt2.rescan()).embedded, 1);
      assert.deepEqual((await rt2.notes.associate("验收这条成片", { region: "main", binding: "wake" })).pages.map((p) => p.id), ["0001"]);
      assert.deepEqual(solo.urls, [EMBED_URL, EMBED_URL, DECIDE_URL]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// ---------- 翻开了没有 ----------
import { materializeSkillsPlugin } from "../src/persona/skills.ts";
import { makeBrain, flush } from "./helpers.ts";
import type { LearningRuntime } from "../src/learning/runtime.ts";

test("翻开：读一页记页号，加载一本记本名，别的不记", () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一"),
    "通用/验收/二.md": page("二"),
    "通用/验收/旧.md": page("旧"),
  });
  const base = tmpDir("hh-open-");
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    // 发过号以后整页挪进归档（归档里的不发号，号是在活页时拿的）
    mkdirSync(join(root, "通用/验收/归档"));
    renameSync(join(root, "通用/验收/旧.md"), join(root, "通用/验收/归档/旧.md"));
    const real = scanShelf(root, GEN, ARCH);
    assert.deepEqual(real.pages.map((p) => [p.rel, p.ids[0], p.archived]), [
      ["通用/验收/一.md", "0001", false], ["通用/验收/二.md", "0002", false], ["通用/验收/归档/旧.md", "0003", true],
    ]);
    // 没编号的页：书架里有、文件也在，但没有号可记
    const noId = { ...real.pages[0]!, ids: [], rel: "通用/验收/没号.md" };
    writeFileSync(join(root, noId.rel), page("没号"));
    const shelf: Shelf = { ...real, pages: [...real.pages, noId] };

    // 书架根是个链接（cfg.root 给的是链接路径）；她的手册插件把整本链回原处
    const rootLink = join(base, "skills-link");
    symlinkSync(root, rootLink);
    const plugin = join(base, "plugin");
    materializeSkillsPlugin([{ name: "验收", dir: join(root, "通用/验收") }], plugin, "aqing");

    let shelfCalls = 0;
    let clock = SH_NOON;
    const logs: LogRecord[] = [];
    const make = (cfg: Partial<LearningCfg>, sh: () => Shelf = () => { shelfCalls++; return shelf; }) => new NoteAssociator({
      db, cfg: { ...testConfig().learning, enabled: true, root: rootLink, ...cfg }, shelf: sh, covers: new CoverIndex(db, null),
      judge: { judge: async () => null }, vec: async () => null, now: () => clock, log: new Logger("test", memorySink(logs)), shelfDir: WHO.shelfDir,
      skillsPlugin: "aqing-skills",
    });
    const notes = make({});
    const rows = () => all<{ at: number; region: string; page_id: string | null; book: string | null }>(db, "SELECT at, region, page_id, book FROM learn_open ORDER BY rowid").map((r) => ({ ...r }));
    const row = (page_id: string | null, book: string | null, region = "main", at = SH_NOON) => ({ at, region, page_id, book });

    // 读一页：原路径、链接路径、手册插件里的路径，都记那一页的号
    notes.observeTool("main", "Read", { file_path: join(root, "通用/验收/一.md") });
    notes.observeTool("main", "Read", { file_path: join(rootLink, "通用/验收/二.md") });
    clock += 1000;
    notes.observeTool("hippocampus", "Read", { file_path: join(plugin, "skills/验收/一.md"), offset: 10, limit: 20 });
    assert.deepEqual(rows(), [row("0001", null), row("0002", null), row("0001", null, "hippocampus", SH_NOON + 1000)]);

    // 归档的页也是翻开过：记；没编号的页：不记
    notes.observeTool("main", "Read", { file_path: join(root, "通用/验收/归档/旧.md") });
    notes.observeTool("main", "Read", { file_path: join(root, noId.rel) });
    assert.deepEqual(rows().slice(3), [row("0003", null, "main", SH_NOON + 1000)]);

    // 加载一本：技能名是本名，或带手册插件名的全名（斜杠开头的写法也认）；不是本的不记
    notes.observeTool("main", "Skill", { skill: "验收" });
    notes.observeTool("main", "Skill", { skill: "aqing-skills:验收", args: "看成片" });
    notes.observeTool("main", "Skill", { skill: " /验收 " });
    assert.deepEqual(rows().slice(4), [row(null, "验收", "main", SH_NOON + 1000), row(null, "验收", "main", SH_NOON + 1000), row(null, "验收", "main", SH_NOON + 1000)]);
    const n = rows().length;
    assert.equal(n, 7);

    // 别的一概不记：本的封面不是页、书架外的文件、没有这个文件、不是 Read/Skill 的工具、别的技能、坏输入
    const calls = shelfCalls;
    notes.observeTool("main", "Read", { file_path: join(root, "通用/验收/SKILL.md") });
    notes.observeTool("main", "Read", { file_path: join(rootLink, "通用/验收/不存在.md") });
    notes.observeTool("main", "Read", { file_path: join(base, "别处.md") });
    notes.observeTool("main", "Read", { file_path: join(root, "../别处.md") });
    notes.observeTool("main", "Read", { file_path: "通用/验收/一.md" });
    notes.observeTool("main", "Read", { file_path: 7 });
    notes.observeTool("main", "Read", {});
    notes.observeTool("main", "Read", null);
    notes.observeTool("main", "Read", undefined);
    // 路径不在书架下的 Read 连书架都不用取（每次工具调用都过这里）：只有封面和那个不存在的文件取了
    assert.equal(shelfCalls, calls + 2);
    notes.observeTool("main", "Write", { file_path: join(root, "通用/验收/一.md"), content: "x" });
    notes.observeTool("main", "Edit", { file_path: join(root, "通用/验收/一.md") });
    notes.observeTool("main", "Bash", { command: `echo x >> ${join(root, "通用/验收/一.md")}` });
    notes.observeTool("main", "what_do_i_know", { topic: "验收" });
    notes.observeTool("main", "Skill", { skill: "docs" });
    notes.observeTool("main", "Skill", { skill: "anthropic-skills:验收" });
    notes.observeTool("main", "Skill", { skill: "验收/一" });
    notes.observeTool("main", "Skill", {});
    notes.observeTool("main", "Skill", null);
    assert.equal(rows().length, n);

    // 开关关着不记；只算不挂（inject 关）照记，翻开的是她真实的行为
    make({ enabled: false }).observeTool("main", "Read", { file_path: join(root, "通用/验收/一.md") });
    make({ enabled: false }).observeTool("main", "Skill", { skill: "验收" });
    assert.equal(rows().length, n);
    make({ inject: false }).observeTool("main", "Read", { file_path: join(root, "通用/验收/二.md") });
    assert.deepEqual(rows().at(-1), row("0002", null, "main", SH_NOON + 1000));

    // 取书架出错、写不进表：只记一条 warn，不往外抛
    const boom = make({}, () => { throw new Error("scan exploded"); });
    boom.observeTool("main", "Read", { file_path: join(root, "通用/验收/一.md") });
    boom.observeTool("main", "Skill", { skill: "验收" });
    assert.equal(logs.filter((l) => l.level === "warn" && /open/.test(l.msg) && /scan exploded/.test(String(l.error))).length, 2);
    db.exec("DROP TABLE learn_open");
    assert.doesNotThrow(() => notes.observeTool("main", "Read", { file_path: join(root, "通用/验收/一.md") }));
    assert.ok(logs.some((l) => l.level === "warn" && /open/.test(l.msg) && /learn_open/.test(String(l.error))));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

import { bashReads } from "../src/learning/associate.ts";

test("翻开：Bash 命令里读了哪些文件——cd 跟着走，~ 和 $HOME 展开；写、改、heredoc 里的、通配、变量都不算", () => {
  const r = (cmd: string) => bashReads(cmd, "/ws", "/home/mira");
  assert.deepEqual(r("cat skills/a.md"), ["/ws/skills/a.md"]);
  assert.deepEqual(r("cd ~/.openclaw/workspace; head -40 skills/phone/wx.md; ls skills/phone/tools/ | grep -i wx"), ["/home/mira/.openclaw/workspace/skills/phone/wx.md"]);
  assert.deepEqual(r("cd $HOME/w && sed -n 1,40p skills/x.md | grep -n foo"), ["/home/mira/w/skills/x.md"]);
  assert.deepEqual(r("cd /ws/skills/通用/learning && cat 学新本事.md; sed -n 1,200p 学习的规矩.md | tail -40"), ["/ws/skills/通用/learning/学新本事.md", "/ws/skills/通用/learning/学习的规矩.md"]);
  // grep / rg：第一个不是选项的是要找的字（有 -e 时都是文件）；带值的选项跳过它的值
  assert.deepEqual(r("grep -n -iE \"签名|简写\" skills/a.md skills/b.md 2>/dev/null | head -5"), ["/ws/skills/a.md", "/ws/skills/b.md"]);
  assert.deepEqual(r("grep -A 3 -e foo -e bar skills/a.md"), ["/ws/skills/a.md"]);
  assert.deepEqual(r("rg -n --glob '*.md' 'x' skills/a.md"), ["/ws/skills/a.md"]);
  assert.deepEqual(r("tail -n 30 skills/a.md && less skills/b.md"), ["/ws/skills/a.md", "/ws/skills/b.md"]);
  assert.deepEqual(r("/usr/bin/grep x skills/a.md; cat -- -odd.md"), ["/ws/skills/a.md", "/ws/-odd.md"]);
  assert.deepEqual(r("cat skills/a.md skills/a.md"), ["/ws/skills/a.md"], "同一个文件只算一次");
  // 不算：sed -i、写进去（>、>>、tee）、heredoc 里的、通配、变量、命令替换、别的命令
  assert.deepEqual(r("sed -i '' 's/a/b/' skills/a.md; sed -ni 'p' skills/a.md"), []);
  assert.deepEqual(r("cat >> skills/a.md <<'EOF'\n- 一条\ncat skills/b.md\nEOF\necho done"), []);
  assert.deepEqual(r("python3 - <<'EOF'\np='skills/a.md'; s=open(p).read()\nEOF"), []);
  assert.deepEqual(r("cat skills/*.md; grep -n x skills/{a,b}.md; cat $P; cat \"$(ls skills | head -1)\"; cat `echo a`"), []);
  assert.deepEqual(r("echo skills/a.md; ls skills/a.md; cp skills/a.md /tmp/a.bak; python3 skills/a.md"), []);
  assert.deepEqual(r("cat skills/a.md > /tmp/out.md"), ["/ws/skills/a.md"], "读进来再写到别处：读的那份算");
  assert.deepEqual(r("echo x | tee skills/a.md"), []);
  // 引号里的空格、分号不拆
  assert.deepEqual(r("cat 'skills/有 空格.md' \"skills/b;c.md\""), ["/ws/skills/有 空格.md", "/ws/skills/b;c.md"]);
  assert.deepEqual(r(""), []);
});

test("翻开：Bash 里读了书架上的页也记页号（cat/sed/head/tail/less/grep/rg），相对路径按她的工作目录、cd 跟着走", () => {
  const ws = tmpDir("hh-open-bash-");
  const root = join(ws, "skills");
  for (const [rel, text] of Object.entries({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一"), "通用/验收/二.md": page("二"), "通用/验收/三.md": page("三") })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  try {
    const db = openDb(":memory:");
    assignIds(root, db, { now: () => T, generalCategory: GEN, archiveDir: ARCH });
    const shelf = scanShelf(root, GEN, ARCH);
    const notes = new NoteAssociator({
      db, cfg: { ...testConfig().learning, enabled: true, root }, shelf: () => shelf, covers: new CoverIndex(db, null),
      judge: { judge: async () => null }, vec: async () => null, now: () => SH_NOON, log: new Logger("test", memorySink([])), cwd: ws, home: ws, shelfDir: WHO.shelfDir,
    });
    const rows = () => all<{ region: string; page_id: string | null }>(db, "SELECT region, page_id FROM learn_open ORDER BY rowid").map((x) => `${x.region}:${x.page_id}`);
    notes.observeTool("main", "Bash", { command: "sed -n 1,40p skills/通用/验收/一.md | grep -n 封面", description: "读" });
    notes.observeTool("side-1", "Bash", { command: `cd ~/skills/通用/验收 && cat 二.md 三.md; head -3 SKILL.md` });
    notes.observeTool("main", "Bash", { command: "cat skills/通用/验收/*.md; sed -i '' 's/a/b/' skills/通用/验收/一.md" });
    notes.observeTool("main", "Bash", { command: 7 });
    notes.observeTool("main", "Bash", null);
    // 发号按扫描顺序（一、三、二）：二是 0003、三是 0002；记的顺序照命令里读的先后
    assert.deepEqual(rows(), ["main:0001", "side-1:0003", "side-1:0002"]);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("翻开：每个脑区的 guard 先交给 observeTool，它只记录——不改把关的结果，出错也不拦", async () => {
  const seen: Array<[string, string, unknown]> = [];
  let boom = false;
  const empty = { pages: [], books: [], problems: [] };
  const learning = {
    notes: { observeTool: (r: string, t: string, i: unknown) => { seen.push([r, t, i]); if (boom) throw new Error("boom"); }, prefixRebuilt: () => {} },
    shelf: () => empty, scan: () => empty, afterNight: async () => {},
  } as unknown as LearningRuntime;
  const t = makeBrain({ gate: { enabled: false }, regions: { perception: ["messages"] } }, undefined, { learning, fileExists: () => false });
  t.brain.wakeRegion("main", "开始");
  t.brain.fromSenses("B站 有人回复了你");
  await flush(); await flush();

  for (const id of ["main", "perception-messages"]) {
    const guard = t.driver.latest(id).spec.hooks.beforeTool;
    const read = { file_path: "/x/一.md" };
    assert.equal(guard("Read", read), undefined);
    assert.deepEqual(seen.at(-1), [id, "Read", read], "把脑区的 id、工具名、原样的输入交过去");
    // 原来的把关照旧：被拦的 Write 还是被拦，observeTool 看到的也是同一次调用
    const write = { file_path: "memory/threads/新的事.md", content: "x" };
    const deny = guard("Write", write);
    assert.match(deny ?? "", /事件线文件和时间轴/);
    assert.deepEqual(seen.at(-1), [id, "Write", write]);
    // observeTool 抛了：把关的结果一样
    boom = true;
    assert.equal(guard("Read", read), undefined);
    assert.equal(guard("Write", write), deny);
    boom = false;
  }
});

test("翻开：夜里整理（海马）翻的页不算她翻开；临时开的把关会话也不经过 observeTool；海马的把关照旧", async () => {
  const seen: Array<[string, string, unknown]> = [];
  const empty = { pages: [], books: [], problems: [] };
  const learning = {
    notes: { observeTool: (r: string, t: string, i: unknown) => { seen.push([r, t, i]); }, prefixRebuilt: () => {} },
    shelf: () => empty, scan: () => empty, afterNight: async () => {}, worklist: async () => "",
  } as unknown as LearningRuntime;
  const t = makeBrain({ learning: { shelf: true } }, undefined, { learning, fileExists: () => false });
  t.brain.wakeRegion("hippocampus", "整理");
  const h = t.driver.latest("hippocampus");
  const read = { file_path: "/x/一.md" };
  assert.equal(h.spec.hooks.beforeTool("Read", read), undefined);
  assert.match(h.spec.hooks.beforeTool("Write", { file_path: "memory/threads/新的事.md", content: "x" }) ?? "", /收进了档案/, "海马的把关照旧");
  // 把关会话（回头看用的是同一个临时会话的写法）
  await h.spec.tools.find((x) => x.name === "learn_check")!.handler({ day: "2026-10-28", candidates: [{ kind: "教训", page: "通用/验收/新.md", text: "甲", evidence: "#1" }] });
  assert.equal(t.driver.latest("check-2026-10-28").spec.hooks.beforeTool("Read", read), undefined);
  assert.deepEqual(seen, [], "都不记翻开");
  // 她自己（主线）翻的照记
  t.brain.wakeRegion("main", "开始");
  t.driver.latest("main").spec.hooks.beforeTool("Read", read);
  assert.deepEqual(seen, [["main", "Read", read]]);
});

// ---------- 又犯：分类和回测题 ----------

const RTZ = "Asia/Shanghai";
/** 10-28 当天某一刻（东八区）；给 "HH:MM" 或 "HH:MM:SS" */
const D28 = (hms: string): number => Date.parse(`2026-10-28T${hms.length === 5 ? `${hms}:00` : hms}+08:00`);
const DAY28 = "2026-10-28";
const recurLesson = (id: string, days: string[], sources: number[]): Lesson => ({ ids: [id], line: 1, text: `教训${id}`, when: "", next: "", days, sources });
type RecurRow = { lesson_id: string; day: string; seq: number | null; kind: string; case_id: number | null };
type CaseRow = { id: number; at: number; topic: string; expect: string; source: string };

function recurEnv() {
  const db = openDb(":memory:");
  const central = new CentralMemory(db);
  return {
    db,
    /** 中央记忆里的一条：编号和时间由测试定 */
    entry: (seq: number, ts: number, src = "main") =>
      db.prepare("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (?, ?, 1, ?, 'note', '原话', 1)").run(seq, ts, src),
    /** 一行联想记录；mounted 给页编号 */
    assoc: (region: string, at: number, topic: string | null, mounted: string[] = [], o: { shadow?: boolean; skipped?: string } = {}) =>
      db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, ?, 'wake', ?, NULL, 3, ?, ?, ?, 5, 0)")
        .run(at, region, topic, JSON.stringify(mounted.map((id) => ({ id, p: 0.9 }))), o.shadow ? 1 : 0, o.skipped ?? null),
    run: (pages: Page[], day: string, tz = RTZ) => classifyRecurrences(db, shelfOf(...pages), day, { central, tz }),
    recurs: () => all<RecurRow>(db, "SELECT * FROM learn_recur ORDER BY lesson_id, day").map((r) => ({ ...r })),
    cases: () => all<CaseRow>(db, "SELECT * FROM learn_case ORDER BY id").map((r) => ({ ...r })),
  };
}

test("又犯：之前挂过那页算 mounted，题的话题用那次的", () => {
  const e = recurEnv();
  // 页 12 的教训：10-28 15:00 在 main 又犯了（出处 #500）
  e.entry(500, D28("15:00"));
  e.assoc("main", D28("10:00"), "较早的话题", ["0012"]);
  e.assoc("main", D28("13:00"), "最近一次挂过的话题", ["0012", "0020"]);
  e.assoc("main", D28("13:30"), "只算不挂的不算挂过", ["0012"], { shadow: true });
  e.assoc("main", D28("14:00"), "没挂这页", ["0020"]);
  e.assoc("side-1", D28("14:30"), "别的脑区", ["0012"]);
  e.assoc("main", D28("15:00:01"), "那一刻之后", ["0012"]);
  // 页 30 的旧编号 0005 挂过：别名也算这页；页 40 刚好在 6 小时前那一刻挂的、页 41 刚好在又犯那一刻挂的：两头都含边界
  e.entry(501, D28("15:30"));
  e.assoc("main", D28("15:10"), "旧号挂的", ["0005"]);
  e.entry(502, D28("15:00"));
  e.assoc("main", D28("09:00:00"), "刚好六小时", ["0040"]);
  e.entry(503, D28("15:00"));
  e.assoc("main", D28("15:00:00"), "同一刻挂的", ["0041"]);

  const out = e.run([
    cp(12, { lessons: [recurLesson("0039", [DAY28], [500])] }),
    cp(30, { ids: ["0030", "0005"], lessons: [recurLesson("0050", [DAY28], [501])] }),
    cp(40, { lessons: [recurLesson("0060", [DAY28], [502])] }),
    cp(41, { lessons: [recurLesson("0061", [DAY28], [503])] }),
  ], DAY28);

  assert.deepEqual(out, [
    { lessonId: "0039", kind: "mounted", caseId: 1 },
    { lessonId: "0050", kind: "mounted", caseId: 2 },
    { lessonId: "0060", kind: "mounted", caseId: 3 },
    { lessonId: "0061", kind: "mounted", caseId: 4 },
  ]);
  assert.deepEqual(e.cases(), [
    { id: 1, at: D28("15:00"), topic: "最近一次挂过的话题", expect: "0012", source: "mounted" },
    { id: 2, at: D28("15:30"), topic: "旧号挂的", expect: "0030", source: "mounted" },
    { id: 3, at: D28("15:00"), topic: "刚好六小时", expect: "0040", source: "mounted" },
    { id: 4, at: D28("15:00"), topic: "同一刻挂的", expect: "0041", source: "mounted" },
  ]);
  assert.deepEqual(e.recurs()[0], { lesson_id: "0039", day: DAY28, seq: 500, kind: "mounted", case_id: 1 });
});

test("又犯：没挂过算 unmounted，话题取那一刻之前最近一次联想；一次都没有就不出题", () => {
  const e = recurEnv();
  e.entry(600, D28("15:00"), "side-1");
  e.assoc("side-1", D28("07:00"), "挂过但在六小时之外", ["0012"]);
  e.assoc("side-1", D28("11:00"), "只算不挂的", ["0012"], { shadow: true }); // 她没看到这页：不算挂过
  e.assoc("side-1", D28("12:00"), "较早的话题");
  e.assoc("side-1", D28("14:50"), "最近一次联想", [], { skipped: "nothing" });
  e.assoc("side-1", D28("14:55"), "没内容", [], { skipped: "lowinfo" }); // 这几行比上面那行晚，但不算
  e.assoc("side-1", D28("14:57"), "开关关着", [], { skipped: "off" });
  e.assoc("side-1", D28("14:59"), "", []); // 没有话题的行不能出题
  e.assoc("side-1", D28("15:00"), "同一刻不算", []);
  e.assoc("main", D28("14:58"), "别的脑区的话题");
  e.entry(601, D28("15:00"), "side-2"); // side-2 一次联想都没有

  const out = e.run([cp(12, { lessons: [recurLesson("0039", [DAY28], [600]), recurLesson("0041", [DAY28], [601])] })], DAY28);

  assert.deepEqual(out, [
    { lessonId: "0039", kind: "unmounted", caseId: 1 },
    { lessonId: "0041", kind: "unmounted", caseId: null },
  ]);
  assert.deepEqual(e.cases(), [{ id: 1, at: D28("15:00"), topic: "最近一次联想", expect: "0012", source: "unmounted" }]);
  // 没出题的那条复发照样记下来
  assert.deepEqual(e.recurs(), [
    { lesson_id: "0039", day: DAY28, seq: 600, kind: "unmounted", case_id: 1 },
    { lesson_id: "0041", day: DAY28, seq: 601, kind: "unmounted", case_id: null },
  ]);
});

test("又犯：同一条同一天只算一次", () => {
  const e = recurEnv();
  const DAY29 = "2026-10-29";
  e.entry(500, D28("15:00"));
  e.entry(501, D28("15:00") + 86_400_000);
  e.assoc("main", D28("14:00"), "话题", ["0012"]);
  const page = (id: string[]) => cp(12, { lessons: [{ ...recurLesson("0039", [DAY28, DAY29], [500, 501]), ids: id }] });

  assert.equal(e.run([page(["0039"])], DAY28).length, 1);
  assert.deepEqual(e.run([page(["0039"])], DAY28), [], "再算一遍：不重复、不重复出题");
  assert.equal(e.run([page(["0039"])], DAY29).length, 1, "另一天另算");
  assert.equal(e.recurs().length, 2);
  assert.equal(e.cases().length, 2);

  // 夜里并掉以后，这条换了新号、旧号留作别名：旧号当天记过的，不再记第二遍
  assert.deepEqual(e.run([page(["0060", "0039"])], DAY28), []);
  assert.equal(e.recurs().length, 2);
  assert.equal(e.cases().length, 2);
});

test("又犯：出处按本地日子找，对不上按位置，再不行也记一笔但不出题", () => {
  const e = recurEnv();
  const D = (day: string, hms: string, ms = 0): number => Date.parse(`${day}T${hms}+08:00`) + ms;
  e.entry(700, D("2026-10-27", "15:00:00"));
  e.entry(701, D("2026-10-28", "15:00:00"));
  e.entry(702, D("2026-10-30", "15:00:00"), "ada"); // 出处是收到的消息：当 main 的事
  e.assoc("main", D("2026-10-30", "14:00:00"), "那天 main 的话题", ["0012"]);
  e.assoc("main", D("2026-10-28", "14:00:00"), "10-28 main 的话题");
  e.assoc("main", D("2026-10-27", "14:00:00"), "10-27 main 的话题");

  const out = e.run([cp(12, {
    lessons: [
      recurLesson("0001", ["2026-10-27", DAY28], [701, 700]),   // 出处顺序和日子不一样：按日子找，不按位置
      recurLesson("0002", [DAY28], [702]),                      // 日子对不上：按位置，用 #702
      recurLesson("0003", ["无"], []),                          // 犯的日子写的不是日子
      recurLesson("0004", [DAY28], []),                         // 没有出处
      recurLesson("0005", [DAY28], [999]),                      // 出处在中央记忆里没有
      { ...recurLesson("0006", [DAY28], [701]), ids: [] },      // 没有编号的教训不管
    ],
  }), cp(13, { archived: true, lessons: [recurLesson("0007", [DAY28], [701])] })], DAY28);

  assert.deepEqual(out, [
    { lessonId: "0001", kind: "unmounted", caseId: 1 },
    { lessonId: "0002", kind: "mounted", caseId: 2 },
    { lessonId: "0004", kind: "unmounted", caseId: null },
    { lessonId: "0005", kind: "unmounted", caseId: null },
  ]);
  assert.deepEqual(e.recurs().map((r) => [r.lesson_id, r.seq, r.kind, r.case_id]), [
    ["0001", 701, "unmounted", 1], ["0002", 702, "mounted", 2], ["0004", null, "unmounted", null], ["0005", null, "unmounted", null],
  ]);
  assert.deepEqual(e.cases().map((c) => c.topic), ["10-28 main 的话题", "那天 main 的话题"]);
  assert.deepEqual(e.run([cp(12, { lessons: [recurLesson("0003", ["无"], [])] })], "无"), [], "day 不是日子格式：什么都不算");

  // 时区：同一条出处，东八区是 10-29 凌晨、UTC 还是 10-28
  const late = D("2026-10-29", "01:00:00"); // = 10-28 17:00 UTC
  const pick = (tz: string): number | null => {
    const t = recurEnv();
    t.entry(750, late);
    t.entry(751, D("2026-10-28", "10:00:00"));
    t.run([cp(12, { lessons: [recurLesson("0009", [DAY28], [750, 751])] })], DAY28, tz);
    return t.recurs()[0]!.seq;
  };
  assert.equal(pick(RTZ), 751);
  assert.equal(pick("UTC"), 750);
});

test("种子题：能加，expect 是页编号", () => {
  const db = openDb(":memory:");
  assert.equal(addSeedCase(db, "要验收一条成片", "0012", 12_345), 1);
  const before = Date.now();
  assert.equal(addSeedCase(db, "要发 B 站评论", "0020"), 2);
  const rows = all<CaseRow>(db, "SELECT * FROM learn_case ORDER BY id");
  assert.deepEqual({ ...rows[0]! }, { id: 1, at: 12_345, topic: "要验收一条成片", expect: "0012", source: "seed" });
  assert.equal(rows[1]!.expect, "0020");
  assert.equal(rows[1]!.source, "seed");
  assert.ok(rows[1]!.at >= before && rows[1]!.at <= Date.now(), "不给时间就用现在");
});

// ---------- 回测 ----------
import { runReplay, replayScore, weekly, renderWeekly } from "../src/learning/score.ts";

type RunRow = { case_id: number; passed: number };
const nightRuns = (db: ReturnType<typeof openDb>, night: string) =>
  all<RunRow>(db, "SELECT case_id, passed FROM learn_case_run WHERE night = ? ORDER BY case_id", night).map((r) => [r.case_id, r.passed]);

test("回测：别名也算对；结果按晚记", async () => {
  // 页 30 并过旧页 5（别名 0005 → 0030）；题按现在的封面重新联想，挂上的页里有应该挂的就算过
  const a = await associator([cp(30, { ids: ["0030", "0005"] }), cp(40), cp(50)], { probs: { "0030": 0.9 } });
  a.db.prepare("INSERT INTO learn_alias (alias, id, at) VALUES ('0005', '0030', 1)").run();
  addSeedCase(a.db, "要验收一条成片", "0005", 1);   // 旧编号：别名也算对
  addSeedCase(a.db, "要验收一条成片", "0030", 2);   // 同一个话题、同一页：只算一道
  addSeedCase(a.db, "要验收一条成片", "0040", 3);   // 同一个话题、别的页：另算一道，话题只判一次
  addSeedCase(a.db, "要发 B 站评论", "0040", 4);

  assert.deepEqual(await runReplay(a.db, a.notes, "2026-10-30"), { total: 3, passed: 1, skipped: 0, prevPassed: null });
  assert.equal(a.calls.length, 2, "一个话题判一次");
  assert.deepEqual(nightRuns(a.db, "2026-10-30"), [[1, 1], [2, 1], [3, 0], [4, 0]]);
  assert.deepEqual(a.rows(), [], "回测不记联想记录");

  // 第二晚：评论那页的封面改好了；前一晚过了 1 道
  a.probs["0040"] = 0.95;
  assert.deepEqual(await runReplay(a.db, a.notes, "2026-10-31"), { total: 3, passed: 3, skipped: 0, prevPassed: 1 });
  assert.deepEqual(nightRuns(a.db, "2026-10-30"), [[1, 1], [2, 1], [3, 0], [4, 0]], "前一晚的结果不动");
  assert.deepEqual(nightRuns(a.db, "2026-10-31"), [[1, 1], [2, 1], [3, 1], [4, 1]]);

  // 同一晚再跑（hh learn replay；夜里只在整理完最后一天跑一次）：有结果的题不重判（表只增不改），只补新出的题；
  // 和已有的题话题、页都一样的，照抄那一道的结果
  const before = a.calls.length;
  a.probs["0040"] = 0;
  addSeedCase(a.db, "要发 B 站评论", "0040", 5);
  addSeedCase(a.db, "要剪片头", "0050", 6);
  assert.deepEqual(await runReplay(a.db, a.notes, "2026-10-31"), { total: 4, passed: 3, skipped: 0, prevPassed: 1 });
  assert.equal(a.calls.length, before + 1, "只判了新的话题");
  assert.deepEqual(nightRuns(a.db, "2026-10-31"), [[1, 1], [2, 1], [3, 1], [4, 1], [5, 1], [6, 0]]);

  // 判断失败的题这次不记（不算没过），数进 skipped，再跑时补上
  a.judgeMode("null");
  assert.deepEqual(await runReplay(a.db, a.notes, "2026-11-01"), { total: 0, passed: 0, skipped: 4, prevPassed: 3 });
  assert.deepEqual(nightRuns(a.db, "2026-11-01"), []);
  assert.deepEqual(replayScore(a.db, "2026-11-01"), { total: 0, passed: 0, skipped: 4 }, "一题都没判成也记下这一晚没判成几道");
  a.judgeMode("ok");
  assert.deepEqual(await runReplay(a.db, a.notes, "2026-11-01"), { total: 4, passed: 1, skipped: 0, prevPassed: 3 });
  assert.deepEqual(replayScore(a.db, "2026-11-01"), { total: 4, passed: 1, skipped: 0 });
  assert.deepEqual(replayScore(a.db, "2026-10-31"), { total: 4, passed: 3, skipped: 0 });
  assert.equal(replayScore(a.db, "2026-10-20"), null);
});

test("回测：开关关着整次不算跑过，不判、不写结果", async () => {
  const a = await associator([cp(30)], { cfg: { enabled: false }, probs: { "0030": 0.9 } });
  addSeedCase(a.db, "要验收一条成片", "0030", 1);
  assert.deepEqual(await runReplay(a.db, a.notes, "2026-10-30"), { total: 0, passed: 0, skipped: 0, prevPassed: null });
  assert.equal(a.calls.length, 0);
  assert.equal(replayScore(a.db, "2026-10-30"), null);
  assert.deepEqual(all(a.db, "SELECT * FROM learn_case_run"), []);
});

test("回测：向量和判断共用 10 秒（不用回复路径的 800 毫秒），判断标成后台的", async () => {
  const a = await associator([cp(30)], { probs: { "0030": 0.9 } });
  await a.notes.associate("要验收一条成片", { region: "replay", binding: "replay" });
  assert.equal(a.vecCalls.at(-1)!.timeoutMs, 10_000);
  assert.equal(a.calls.at(-1)!.timeoutMs, 10_000);
  assert.equal(a.calls.at(-1)!.background, true);
  // 回复路径照旧
  await a.notes.associate("要验收一条成片", { region: "main", binding: "wake" });
  assert.equal(a.vecCalls.at(-1)!.timeoutMs, 800);
  assert.deepEqual([a.calls.at(-1)!.timeoutMs, a.calls.at(-1)!.background], [800, undefined]);
});

test("回测：判断超时的题算没判成、不写结果；回测的失败不打开回复路径的熔断", async () => {
  let sent = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    sent += 1;
    const body = JSON.parse(String(init.body)) as DecisionsBody;
    if (body.input.includes("超时")) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    return new Response(JSON.stringify({ answers: body.questions.map((q) => ({ name: q.name, type: "predicate", probability: 0.9 })), usage: { input_tokens: 10 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const alerts: string[] = [];
  const dec = new OpenAIDecisions({ key: "k", db: openDb(":memory:"), tz: RTZ, fetchImpl, now: () => SH_NOON, dailyUsd: 1, onAlert: (m) => alerts.push(m) });
  const a = await associator([cp(30)], { judge: dec });
  addSeedCase(a.db, "超时的话题一", "0030", 1);
  addSeedCase(a.db, "超时的话题二", "0030", 2);
  addSeedCase(a.db, "超时的话题三", "0030", 3);
  addSeedCase(a.db, "要验收一条成片", "0030", 4);

  assert.deepEqual(await runReplay(a.db, a.notes, "2026-10-30"), { total: 1, passed: 1, skipped: 3, prevPassed: null });
  assert.deepEqual(nightRuns(a.db, "2026-10-30"), [[4, 1]], "没判成的不写结果");
  assert.equal(sent, 7, "超时的三题各再试一次（#0047）");
  assert.equal(dec.broken, false, "回测连着 3 次超时也不熔断");
  assert.match(dec.lastError, /timeout/);
  assert.deepEqual(alerts, []);
  // 她的联想照常发出去
  const r = await a.notes.associate("要验收一条成片", { region: "main", binding: "wake" });
  assert.equal(sent, 8);
  assert.deepEqual(r.pages, [{ id: "0030", p: 0.9 }]);
});

// ---------- 每周数字 ----------

/** 东八区某天某刻 */
const SH = (day: string, hms = "12:00:00"): number => Date.parse(`${day}T${hms}+08:00`);

test("每周数字：各项按表算", () => {
  const root = makeShelf({
    "做事/剪辑/SKILL.md": "---\nname: 剪辑\ndescription: 剪片子\n---\n",
    "做事/剪辑/封面.md": [
      "# 封面 <!-- p:0012 -->", "简介：a", "什么时候翻：b", "",
      "## 做法", "- 先定字 ✓ 2026-10-28", "- 再配图（✓2026-10-20 第一次）", "```", "- ✓ 2026-10-29 代码块里的不算", "```",
      "### 待验证", "- 字号再大一点（2026-10-30 一次成功）",
      "## 教训", "- 教训：字太小｜什么时候：做封面｜下次：放大｜犯的日子：2026-10-28｜出处：#1 <!-- l:0013 -->",
      "## 旧做法", "- ✓ 2026-10-29 旧做法里的不算",
    ].join("\n"),
    "做事/剪辑/片头.md": "# 片头 <!-- p:0030 p:0005 -->\n简介：a\n什么时候翻：b\n\n## 做法\n- 片头三秒 ✓ 2026-11-01、二次确认 ✓ 2026-10-26\n",
    "做事/剪辑/归档/旧封面.md": "# 旧封面 <!-- p:0040 -->\n简介：a\n什么时候翻：b\n\n## 做法\n- ✓ 2026-10-30 归档的不算\n",
    "做事/配音/SKILL.md": "---\nname: 配音\ndescription: 配音\n---\n",
    "做事/配音/录音.md": "# 录音 <!-- p:0020 -->\n简介：a\n什么时候翻：b\n",
  });
  try {
    const db = openDb(":memory:");
    const run = (sql: string, ...p: Array<string | number | null>) => db.prepare(sql).run(...p);
    // 新教训：这 7 天（她的日子 10-26 到 11-01）第一次见到的教训
    for (const [id, kind, at] of [["0013", "lesson", SH("2026-10-26", "00:00:00")], ["0014", "lesson", SH("2026-10-31")], ["0015", "lesson", SH("2026-10-25", "23:59:59")], ["0012", "page", SH("2026-10-30")]] as const) {
      run("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen) VALUES (?, ?, 'x', 'h', ?, ?)", id, kind, at, at);
    }
    // 又犯
    for (const [id, day, kind] of [["0013", "2026-10-28", "mounted"], ["0013", "2026-10-26", "unmounted"], ["0014", "2026-11-01", "unmounted"], ["0015", "2026-10-25", "mounted"]]) {
      run("INSERT INTO learn_recur (lesson_id, day, kind) VALUES (?, ?, ?)", id!, day!, kind!);
    }
    // 主人的纠正（窗口外的、比现在晚的不算）
    for (const at of [SH("2026-10-27"), SH("2026-11-01", "11:00:00"), SH("2026-10-25", "23:00:00"), SH("2026-11-01", "13:00:00")]) {
      run("INSERT INTO learn_correction (at, p) VALUES (?, 0.9)", at);
    }
    // 挂和翻
    run("INSERT INTO learn_alias (alias, id, at) VALUES ('0005', '0030', 1)");
    const assoc = (at: number, binding: string, mounted: string[], shadow = 0) =>
      run("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', ?, 't', 3, ?, ?, ?, 5, 10)",
        at, binding, JSON.stringify(mounted.map((id) => ({ id, p: 0.9 }))), shadow, mounted.length ? null : "nothing");
    const open = (at: number, page: string | null, book: string | null = null) =>
      run("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'side-1', ?, ?)", at, page, book);
    assoc(SH("2026-10-30", "10:00:00"), "wake", ["0012", "0020"]);
    open(SH("2026-10-30", "10:30:00"), "0012");                 // 翻开那页（别的脑区翻的也算）
    open(SH("2026-10-30", "10:59:59"), null, "配音");           // 加载了那本
    assoc(SH("2026-10-30", "14:00:00"), "on_it", ["0012"]);
    open(SH("2026-10-30", "13:59:00"), "0012");                 // 挂之前翻的不算
    open(SH("2026-10-30", "15:00:01"), "0012");                 // 过了 1 小时才翻：白挂
    assoc(SH("2026-10-31", "09:00:00"), "wake", ["0012"], 1);   // 只算不挂的不算
    open(SH("2026-10-31", "09:05:00"), "0012");
    assoc(SH("2026-10-31", "10:00:00"), "ask", ["0020"]);       // 她自己找的不算
    assoc(SH("2026-10-25", "23:00:00"), "wake", ["0030"]);      // 窗口外
    assoc(SH("2026-10-31", "11:00:00"), "goals", ["0005"]);     // 挂的是旧编号，翻的是现在的编号
    open(SH("2026-10-31", "11:10:00"), "0030");
    assoc(SH("2026-10-31", "12:00:00"), "wake", []);
    // 估时间：3 件做完的事，估 10 分钟、实际 15 分钟
    for (let i = 0; i < 3; i++) {
      const start = SH("2026-10-29", `1${i}:00:00`);
      run("INSERT INTO tasks (topic, owner, about_min, state, started, ended) VALUES ('x', 'main', 10, 'done', ?, ?)", start, start + 15 * 60_000);
    }
    // 回测：取这 7 天里最近一晚
    addSeedCase(db, "甲", "0012", 1);
    addSeedCase(db, "乙", "0020", 2);
    for (const [night, id, passed] of [["2026-10-29", 1, 1], ["2026-10-29", 2, 0], ["2026-10-31", 1, 1], ["2026-10-31", 2, 1], ["2026-10-20", 1, 0], ["2026-11-02", 1, 0]] as const) {
      run("INSERT INTO learn_case_run (night, case_id, passed) VALUES (?, ?, ?)", night, id, passed);
    }

    const shelf = scanShelf(root, "通用", ARCH);
    const w = weekly(db, { now: SH("2026-11-01"), tz: RTZ, shelf, central: new CentralMemory(db), root });
    assert.deepEqual(w, {
      newLessons: 2, recurMounted: 1, recurUnmounted: 2, corrections: 2,
      mounts: 4, opened: 3, idleMounts: 1, promoted: 3, estimateRatio: 1.5, replayPassRate: 1,
    });
    assert.equal(renderWeekly(w, WHO.owner), [
      "# 最近 7 天的学习",
      "- 新教训：2 条",
      "- 又犯：3 次（挂了还犯 1，没挂就犯 2）",
      "- 被 ada 纠正：2 次",
      "- 接住率：75%（挂了 4 页，翻开 3 页）",
      "- 白挂（挂了没翻）：1 次",
      "- 待验证升级成靠谱：3 条",
      "- 估时间的准头：实际是估的 1.5 倍（最近 10 件做完的事）",
      "- 回测通过率：100%（最近一晚）",
      "",
    ].join("\n"));

    // 什么都没有：算不出的写明白
    const empty = weekly(openDb(":memory:"), { now: SH("2026-11-01"), tz: RTZ, shelf: shelfOf(), central: new CentralMemory(db), root });
    assert.deepEqual(empty, {
      newLessons: 0, recurMounted: 0, recurUnmounted: 0, corrections: 0,
      mounts: 0, opened: 0, idleMounts: 0, promoted: 0, estimateRatio: null, replayPassRate: null,
    });
    const text = renderWeekly(empty, WHO.owner);
    assert.match(text, /接住率：这几天没挂过/);
    assert.match(text, /估时间的准头：做完的事不到 3 件，还算不出/);
    assert.match(text, /回测通过率：这几天还没跑过/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 夜里的收尾 ----------

const dayOf = (t: number, tz: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);

test("运行时：夜里收工后发号、刷完封面、记又犯、回测，写每周数字；回测比前一晚低时第一行标出来；出错只 warn", async () => {
  const today = dayOf(T, "UTC");
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一", [`甲｜犯的日子：${today}`]) });
  const state = tmpDir("hh-learn-state-");
  try {
    const db = openDb(":memory:");
    const logs: LogRecord[] = [];
    const judged: string[] = [];
    const cfg: LearningCfg = { ...testConfig().learning, enabled: true, root };
    const make = (stateDir: string) => createLearningRuntime({
      ...WHO,
      db, cfg, embedder: coverEmbedder(),
      judge: { judge: async (input, qs) => { judged.push(input); return input.includes("判不成") ? null : { p: new Map(qs.map((q) => [q.name, 0])), tokens: 1, ms: 1 }; } },
      vec: async () => E0, now: () => T, log: new Logger("t", memorySink(logs)), stateDir, tz: "UTC",
    });
    const rt = make(state);
    addSeedCase(db, "验收这条成片", "0001", 1);   // 页一会拿到 0001（教训 0002）

    await rt.afterNight(today);
    // 发号写回了文件，封面向量等到刷完（不用再等后台）
    assert.match(read(root, "通用/验收/一.md"), /^# 一 <!-- p:0001 -->/);
    assert.deepEqual(all<{ page_id: string }>(db, "SELECT page_id FROM learn_cover").map((r) => r.page_id), ["0001"]);
    // 又犯：这条教训这天记了一笔（没出处：不出题）
    assert.deepEqual(all<{ lesson_id: string; day: string; kind: string }>(db, "SELECT lesson_id, day, kind FROM learn_recur").map((r) => ({ ...r })),
      [{ lesson_id: "0002", day: today, kind: "unmounted" }]);
    // 回测：按今晚（她的日子）记；一题没过
    assert.deepEqual(nightRuns(db, today), [[1, 0]]);
    assert.equal(judged.length, 1);
    const file = join(state, "learn", "weekly.md");
    assert.ok(readFileSync(file, "utf8").startsWith("# 最近 7 天的学习\n"), "第一晚没有可比的");
    assert.match(readFileSync(file, "utf8"), /又犯：1 次（挂了还犯 0，没挂就犯 1）/);
    assert.match(readFileSync(file, "utf8"), /\n- 今晚回测：通过 0\/1\n\n# 调参（夜里）\n[\s\S]*- 今晚没改参数\n$/, "回测后面接调参那一段；没有数据不调");

    // 前一晚过了：今晚再收尾（同一晚的题不重判），第一行标出来
    db.prepare("INSERT INTO learn_case_run (night, case_id, passed) VALUES ('2000-01-01', 1, 1)").run();
    await rt.afterNight(today);
    assert.equal(judged.length, 1);
    assert.equal(readFileSync(file, "utf8").split("\n")[0], "回测通过率比昨晚低：100%（1/1） → 0%（0/1）");
    assert.equal(readFileSync(file, "utf8").split("\n")[1], "# 最近 7 天的学习");

    // 今晚有题没判成：不和前一晚比，写明为什么
    addSeedCase(db, "这题判不成了", "0001", 2);
    await rt.afterNight(today);
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith("# 最近 7 天的学习\n"));
    assert.match(text, /\n- 今晚回测：通过 0\/1（没判成 1 道）\n- 回测这晚有 1 道没判成，不比较\n\n# 调参（夜里）\n/);

    // 写不了每周数字：只记 warn，不抛
    const blocked = join(state, "是个文件");
    writeFileSync(blocked, "x");
    await make(blocked).afterNight(today);
    assert.ok(logs.some((l) => l.level === "warn" && /weekly/.test(l.msg)));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("运行时：一夜整理几天时前面几天只记又犯；最后一天才发号、刷封面、回测一次（用最后的封面），前面几天的又犯再补一遍", async () => {
  const today = dayOf(T, "UTC");
  const yday = dayOf(T - 86_400_000, "UTC");
  // 甲已经有号；乙是今晚新写的、还没号
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": `# 一 <!-- p:0001 -->\n简介：a\n什么时候翻：b\n\n## 教训\n- 教训：甲｜犯的日子：${yday}、${today} <!-- l:0002 -->\n- 教训：乙｜犯的日子：${yday}\n`,
  });
  const state = tmpDir("hh-learn-state-");
  try {
    const db = openDb(":memory:");
    const embedded: string[][] = [];
    let judged = 0;
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, enabled: true, root }, embedder: coverEmbedder(embedded),
      judge: { judge: async (_i, qs) => { judged += 1; return { p: new Map(qs.map((q) => [q.name, 0.9])), tokens: 1, ms: 1 }; } },
      vec: async () => E0, now: () => T, log: new Logger("t", memorySink([])), stateDir: state, tz: "UTC",
    });
    addSeedCase(db, "验收这条成片", "0001", 1);
    const recurs = () => all<{ lesson_id: string; day: string }>(db, "SELECT lesson_id, day FROM learn_recur ORDER BY day, lesson_id").map((r) => [r.lesson_id, r.day]);
    const file = join(state, "learn", "weekly.md");

    await rt.afterNight(yday, { final: false });
    assert.deepEqual(recurs(), [["0002", yday]], "有号的又犯先记上");
    assert.match(read(root, "通用/验收/一.md"), /- 教训：乙｜犯的日子：\S+\n$/, "不发号");
    assert.equal(coverBatches(embedded), 0, "不刷封面");
    assert.equal(judged, 0, "不回测");
    assert.deepEqual(all(db, "SELECT * FROM learn_case_run"), []);
    assert.throws(() => readFileSync(file), /ENOENT/, "不写每周数字");

    await rt.afterNight(today);
    assert.match(read(root, "通用/验收/一.md"), /- 教训：乙｜犯的日子：\S+ <!-- l:0003 -->/);
    assert.deepEqual(recurs(), [["0002", yday], ["0003", yday], ["0002", today]], "前一天的又犯在发号以后补上");
    assert.equal(coverBatches(embedded), 1);
    assert.equal(judged, 1, "回测只跑一次");
    assert.deepEqual(nightRuns(db, today), [[1, 1]]);
    assert.ok(readFileSync(file, "utf8").startsWith("# 最近 7 天的学习\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

test("运行时：最后一天整理完，往前 7 天里每一天的又犯都记（她今晚补写的前几天的日子也算）；某一天出错不耽误别的天", async () => {
  const day = (n: number) => dayOf(T + n * 86_400_000, "UTC");
  // 甲今晚补上了前天的日子；乙补了 3 天前和昨天；丙是 8 天前的，不在窗口里
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": [
      "# 一 <!-- p:0001 -->", "简介：a", "什么时候翻：b", "", "## 教训",
      `- 教训：甲｜犯的日子：${day(-2)} <!-- l:0002 -->`,
      `- 教训：乙｜犯的日子：${day(-3)}、${day(-1)} <!-- l:0003 -->`,
      `- 教训：丙｜犯的日子：${day(-8)} <!-- l:0004 -->`, "",
    ].join("\n"),
  });
  const state = tmpDir("hh-learn-state-");
  try {
    const db = openDb(":memory:");
    // 查 3 天前记没记过时出错（只有这一天）
    const prepare = db.prepare.bind(db);
    (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const st = prepare(sql);
      if (!/FROM learn_recur WHERE day = \?/.test(sql)) return st;
      return { get: (...a: Array<string | number | null>) => { if (a[0] === day(-3)) throw new Error("坏了"); return st.get(...a); } };
    };
    const logs: LogRecord[] = [];
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, enabled: true, root }, embedder: coverEmbedder(),
      judge: { judge: async (_i, qs) => ({ p: new Map(qs.map((q) => [q.name, 0.9])), tokens: 1, ms: 1 }) },
      vec: async () => E0, now: () => T, log: new Logger("t", memorySink(logs)), stateDir: state, tz: "UTC",
    });
    await rt.afterNight(day(0));
    const recurs = all<{ lesson_id: string; day: string }>(db, "SELECT lesson_id, day FROM learn_recur ORDER BY day, lesson_id").map((r) => [r.lesson_id, r.day]);
    assert.deepEqual(recurs, [["0002", day(-2)], ["0003", day(-1)]], "前天、昨天的记上；8 天前的不看；出错的那天没记");
    assert.ok(logs.some((l) => l.level === "warn" && /after-night recurrences failed/.test(l.msg) && l.day === day(-3)), "出错的那天记 warn");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  }
});

// ---------- hh learn ----------
import { learnCommand } from "../src/learning/cli.ts";

test("hh learn：ids 一行一个；case add 加种子题（页编号要认得），case ls 列出来", async () => {
  const root = makeShelf({ "通用/验收/SKILL.md": COVER, "通用/验收/一.md": page("一", ["甲"]) });
  try {
    const db = openDb(":memory:");
    const cfg: LearningCfg = { ...testConfig().learning, enabled: true, root };
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg, embedder: null, judge: { judge: async () => null }, vec: async () => null, now: () => T,
      log: new Logger("t", memorySink([])), stateDir: root, tz: "UTC",
    });
    rt.scan();   // 页 0001，教训 0002
    db.prepare("INSERT INTO learn_alias (alias, id, at) VALUES ('0009', '0001', 1)").run();
    const env = { cfg, tz: "UTC", now: () => T };
    const cmd = (action: string, ...args: string[]) => learnCommand(rt, action, args, env);

    assert.equal(await cmd("ids"), "0001\n0002\n0009");
    assert.deepEqual(JSON.parse(await cmd("format") as string), { pageId: PAGE_ID.source, lessonId: LESSON_ID.source, lessonLine: "^[-*]\\s+教训[：:]", lessonSection: "教训", notPages: ["SKILL.md", "CHANGELOG.md"], archiveDir: env.cfg.archiveDir });

    // 参数：列出来、改、清（参数都要动态，不用重启）
    assert.match(String(await cmd("param")), /^strength\.residentMax = 10（默认；0–30，一步 1）常驻单子最多几条$/m);
    assert.equal(await cmd("param", "strength.residentMax", "12", "ada", "说多一点"), "strength.residentMax：10 → 12");
    assert.match(String(await cmd("param")), /^strength\.residentMax = 12（改过；默认 10；0–30，一步 1）/m);
    assert.equal(await cmd("param", "strength.residentMax", "默认"), "strength.residentMax：12 → 默认（10）");
    await assert.rejects(cmd("param", "strength.residentMax", "99"), /上下限/);
    await assert.rejects(cmd("param", "strength.residentMax", ""), /要给一个数/);

    assert.equal(await cmd("case", "add", "0001", "验收", "这条成片"), "加了第 1 题：验收 这条成片 → 0001");
    assert.equal(await cmd("case", "add", "0009", "做封面"), "加了第 2 题：做封面 → 0001", "旧编号换成现在的");
    await assert.rejects(cmd("case", "add", "0002", "x"), /0002 不是页/);
    await assert.rejects(cmd("case", "add", "0404", "x"), /不认识 0404/);
    await assert.rejects(cmd("case", "add", "0001"), /用法/);
    assert.deepEqual(all<CaseRow>(db, "SELECT * FROM learn_case ORDER BY id").map((c) => [c.topic, c.expect, c.source, c.at]),
      [["验收 这条成片", "0001", "seed", T], ["做封面", "0001", "seed", T]]);

    assert.equal(await cmd("case", "ls"), "1 seed 0001 验收 这条成片\n2 seed 0001 做封面");
    await assert.rejects(cmd("case", "rm", "1"), /不认识/);
    await assert.rejects(cmd("nope"), /hh learn 不认识：nope/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("hh learn stats：派活给帮手的（helper）照样计数，但不进耗时（它给 4 秒、不在回复路径上），也不算挂载", async () => {
  const db = openDb(":memory:");
  const cfg: LearningCfg = { ...testConfig().learning, root: "/nonexistent" };
  const rt = createLearningRuntime({
      ...WHO,
    db, cfg, embedder: null, judge: { judge: async () => null }, vec: async () => null, now: () => SH("2026-11-01"),
    log: new Logger("t", memorySink([])), stateDir: "/nonexistent", tz: RTZ,
  });
  const ins = db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, ?, ?, 't', 3, ?, 0, NULL, ?, 10)");
  ins.run(SH("2026-10-31"), "main", "wake", JSON.stringify([{ id: "0012", p: 0.9 }]), 300);
  ins.run(SH("2026-10-31", "13:00:00"), "cc:kaichou", "helper", JSON.stringify([{ id: "0020", p: 0.9 }]), 3900);
  const s = await learnCommand(rt, "stats", ["3"], { cfg, tz: RTZ, now: () => SH("2026-11-01") }) as { byBinding: Record<string, number>; ms: { median: number; max: number }; mounts: number };
  assert.deepEqual(s.byBinding, { wake: 1, helper: 1 });
  assert.deepEqual(s.ms, { median: 300, max: 300 });
  assert.equal(s.mounts, 1);
});

test("hh learn stats：按绑定点、跳过的原因数，耗时中位数和最长、花费、每次挂几页、接住率", async () => {
  const db = openDb(":memory:");
  const cfg: LearningCfg = { ...testConfig().learning, root: "/nonexistent" };
  const rt = createLearningRuntime({
      ...WHO,
    db, cfg, embedder: null, judge: { judge: async () => null }, vec: async () => null, now: () => SH("2026-11-01"),
    log: new Logger("t", memorySink([])), stateDir: "/nonexistent", tz: RTZ,
  });
  const assoc = (at: number, binding: string, mounted: string[], skipped: string | null, ms: number, tokens: number, shadow = 0) =>
    db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', ?, 't', 3, ?, ?, ?, ?, ?)")
      .run(at, binding, JSON.stringify(mounted.map((id) => ({ id, p: 0.9 }))), shadow, skipped, ms, tokens);
  assoc(SH("2026-10-31"), "wake", ["0012", "0020"], null, 300, 600_000);
  assoc(SH("2026-10-31", "13:00:00"), "on_it", ["0012"], null, 500, 400_000);
  assoc(SH("2026-10-31", "14:00:00"), "wake", [], "nothing", 200, 100_000);
  assoc(SH("2026-10-31", "15:00:00"), "wake", [], "lowinfo", 0, 0);           // 没去算的：不进耗时
  assoc(SH("2026-10-31", "16:00:00"), "ask", ["0012", "0020", "0030", "0040"], null, 900, 900_000);
  assoc(SH("2026-10-20"), "wake", ["0012"], null, 5000, 1);                   // 窗口外
  db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', '0012', NULL)").run(SH("2026-10-31", "12:10:00"));
  // 纠正题问到的概率（情境记的）：过门槛的、差一点的（门槛下 0.3 以内）、窗口外的
  kvSet(db, "learn.correction.asked", JSON.stringify([
    { at: SH("2026-10-20"), seq: 1, p: 0.9 },
    { at: SH("2026-10-31"), seq: 11, p: 0.85 }, { at: SH("2026-10-31", "13:00:00"), seq: 12, p: 0.55 },
    { at: SH("2026-10-31", "14:00:00"), seq: 13, p: 0.1 }, { at: SH("2026-10-31", "15:00:00"), seq: 14, p: 0.69 },
  ]));

  const s = await learnCommand(rt, "stats", ["3"], { cfg, tz: RTZ, now: () => SH("2026-11-01") });
  assert.deepEqual(s, {
    days: 3, calls: 5,
    byBinding: { wake: 3, on_it: 1, ask: 1 },
    skipped: { lowinfo: 1, nothing: 1 },
    ms: { median: 400, max: 900 },
    tokens: 2_000_000, usd: 0.2,
    pagesPerMount: { 0: 1, 1: 1, 2: 1 },
    mounts: 3, opened: 1, catchRate: 0.33,
    corrections: { asked: 4, over: 1, near: [{ seq: 12, p: 0.55 }, { seq: 14, p: 0.69 }] },
  });
});

// ---------- hh learn migrate-check ----------
const MOVED = "skills/归档/搬家前-20261101";

/** 搬家核对用的临时工作区（skills/ 是书架，归档目录先建好）；check() 跑 hh learn migrate-check，默认用相对工作区的路径 */
function migrateWs(files: Record<string, string>) {
  const ws = makeShelf(files);
  mkdirSync(join(ws, MOVED), { recursive: true });
  const cfg: LearningCfg = { ...testConfig().learning, root: join(ws, "skills") };
  const rt = createLearningRuntime({
      ...WHO,
    db: openDb(":memory:"), cfg, embedder: null, judge: { judge: async () => null }, vec: async () => null, now: () => T,
    log: new Logger("t", memorySink([])), stateDir: ws, tz: "UTC",
  });
  const run = (...args: string[]) => learnCommand(rt, "migrate-check", args, { cfg, tz: "UTC", now: () => T });
  const check = (lessons = "memory/lessons.md", archive = MOVED) => run(lessons, archive);
  return { ws, check, run };
}

test("搬家核对：教训都在时说都在；缺一条时列出来", async () => {
  const look = "验收只看局部、数字或组装图本身就说「过了」（10-25 22:17 转头脸歪只盯了接缝）";
  const old = "只在归档那页和做法里还留着的一条教训";
  const lessons = [
    `- 教训：${look}｜下次：先按原尺寸看整帧｜犯的日子：2026-10-25、2026-10-28`,
    "",
    "- 教训：给 Claude Code 插话后没确认对方接到 ｜下次：插话后看对方接没接到｜犯的日子：2026-10-25",
  ];
  const { ws, check } = migrateWs({
    "memory/lessons.md": `${lessons.join("\n")}\n`,
    "skills/通用/验收/SKILL.md": COVER,
    "skills/通用/验收/看成片.md": [
      "# 看成片 <!-- p:0012 -->", "简介：a", "什么时候翻：要说过了的时候", "", "## 做法", `- ${old}`, "", "## 教训",
      `- 教训：${look}｜什么时候：要说过了的时候｜下次：先按原尺寸看整帧｜犯的日子：2026-10-25、2026-10-28｜出处：#4001 <!-- l:0013 -->`,
    ].join("\n"),
    "skills/通用/验收/归档/旧.md": page("旧", [`${old}｜下次：x`]),
    "skills/工作/派活/SKILL.md": COVER,
    // 空白写法不一样也算同一条
    "skills/工作/派活/插话.md": page("插话", ["给 Claude Code  插话后没确认对方接到｜什么时候：要插话的时候｜下次：y｜犯的日子：2026-10-25"]),
  });
  try {
    assert.equal(await check(), "都在");
    assert.equal(await check(join(ws, "memory/lessons.md"), join(ws, MOVED)), "都在", "绝对路径也认");

    const long = "改稿时没写清是「换掉」还是「接上」，新结尾接在旧结尾后面，同一个对比讲了两遍，到成片才看出来（10-30 19:55 祥子 v10 那一版）";
    writeFileSync(join(ws, "memory/lessons.md"), [...lessons, `- 教训：${old}｜下次：z｜犯的日子：2026-10-20`, `- 教训：${long}｜下次：从头读一遍｜犯的日子：2026-10-30`].join("\n"));
    assert.equal(await check(), [
      "没在笔记页里找到的教训（2 条，共 4 条）：",
      `- ${old}`,   // 归档的页、做法里的行都不算
      `- ${[...long].slice(0, 60).join("")}…`,
    ].join("\n"));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("搬家核对：旧写法（开头带日期钟点、没有「教训：」）按正文比，正文到「下次：」为止", async () => {
  const { ws, check } = migrateWs({
    "memory/lessons.md": [
      "- 2026-10-25 16:47 新效果没调研就直接派工（眼睛果冻），ada 第二次纠正（12:02 第一次）。下次：新效果第一步是找官方样例。",
      "- 2026-10-25 22:5x 子代理里调 image_generate，结果回来的那一轮工具被收窄（exec 没了）；两次都卡在这",
      "- 2026-10-26 00:43 第五次：形象动作自己琢磨不照教程。下次：先学官方教程",
    ].join("\n"),
    "skills/形象/形象制作/SKILL.md": COVER,
    "skills/形象/形象制作/做新效果.md": page("做新效果", [
      // 搬过来时去掉了结尾的句号，也算
      "新效果没调研就直接派工（眼睛果冻），ada 第二次纠正（12:02 第一次）｜什么时候：要做新效果的时候｜下次：新效果第一步是找官方样例｜犯的日子：2026-10-25",
      "子代理里调 image_generate，结果回来的那一轮工具被收窄（exec 没了）；两次都卡在这｜什么时候：要生图的时候｜下次：子代理只生图｜犯的日子：2026-10-25",
    ]),
  });
  try {
    assert.equal(await check(), "没在笔记页里找到的教训（1 条，共 3 条）：\n- 第五次：形象动作自己琢磨不照教程");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("搬家核对：手册里没搬进新页的行按文件报一句（只是告诉，教训齐了照样说都在）", async () => {
  const { ws, check } = migrateWs({
    "memory/lessons.md": "",
    // 归档最上层的 lessons.md 是教训的原样，不算手册；CHANGELOG 不是页
    [`${MOVED}/lessons.md`]: "- 教训：没搬的一条｜下次：x\n",
    [`${MOVED}/living/CHANGELOG.md`]: "- 2026-10-25 | 改了一条 | 整理补记\n",
    [`${MOVED}/living/SKILL.md`]: [
      "---", "name: living", "description: 总手册", "---", "", "# 在这台 Mac 里生活 <!-- p:0100 -->", "",
      "## 看视频", "- 看视频用 watch.py 看画面，不只读字幕", "- 读 PDF 先用 pdftotext 转成文字",
      "```bash", "python3 scripts/watch.py <网址>", "```", "ok",
    ].join("\n"),
    [`${MOVED}/living/body.md`]: "# 身体\n\n- 内存紧了先关 Docker\n",
    [`${MOVED}/phone/apps/bili.md`]: "# B站\n\n- 搜索框在右上角\n",
    "skills/日常/电脑/SKILL.md": COVER,
    "skills/日常/电脑/看视频.md": ["# 看视频", "简介：a", "什么时候翻：b", "", "## 做法", "1. 看视频用 watch.py 看画面，不只读字幕"].join("\n"),
    "skills/工具/手机/SKILL.md": COVER,
    "skills/工具/手机/B站.md": ["# B站", "简介：a", "什么时候翻：b", "", "## 做法", "- 搜索框在右上角 <!-- l:0200 -->"].join("\n"),
  });
  try {
    // 归档里的那几份自己也在书架上（归档的页），不算搬过去了
    assert.equal(await check(), "都在\nliving/SKILL.md：2 行没搬进新页（在归档里）\nliving/body.md：1 行没搬进新页（在归档里）");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("搬家核对：书架的问题附在后面；归档目录不在也照样出报告；少参数、lessons 读不了时说清楚", async () => {
  const { ws, check, run } = migrateWs({
    "memory/lessons.md": "- 教训：放进了没封面那本的一条｜下次：x\n",
    "skills/通用/没封面/一.md": page("一", ["放进了没封面那本的一条｜下次：x"]),
  });
  try {
    // 缺的教训后面跟着书架的问题，说得出为什么缺
    assert.equal(await check(), [
      "没在笔记页里找到的教训（1 条，共 1 条）：", "- 放进了没封面那本的一条",
      "书架的问题（1）：", "- 通用/没封面：没有 SKILL.md，这本不算，里面的页也不进联想",
    ].join("\n"));
    assert.match(String(await check("memory/lessons.md", "skills/归档/没有这个目录")), /\n归档目录读不了：.*没有这个目录（.+）$/);
    await assert.rejects(run("memory/lessons.md"), /^Error: 用法：hh learn migrate-check <lessons\.md 路径> <归档目录>/);
    await assert.rejects(run("memory/没有这个.md", MOVED), /读不了 .*memory\/没有这个\.md（/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// root 读得了 000 的目录，造不出「读不了」
test("搬家核对：归档里一层读不了，照报一句，别的手册照样数", { skip: process.getuid?.() === 0 }, async () => {
  const { ws, check } = migrateWs({
    "memory/lessons.md": "",
    [`${MOVED}/living/SKILL.md`]: "# 生活\n\n- 这一行没搬进新页\n",
    [`${MOVED}/phone/SKILL.md`]: "# 手机\n\n- 这一行也没搬进新页\n",
  });
  const locked = join(ws, MOVED, "phone");
  try {
    chmodSync(locked, 0o000);
    const lines = String(await check()).split("\n");
    assert.equal(lines[0], "都在");
    assert.ok(lines.includes("living/SKILL.md：1 行没搬进新页（在归档里）"), lines.join("\n"));
    assert.ok(lines.some((l) => /^phone：读不了目录（.+）$/.test(l)), lines.join("\n"));
  } finally {
    chmodSync(locked, 0o755);
    rmSync(ws, { recursive: true, force: true });
  }
});

// ---------- 夜里的工作单 ----------
import { worklist } from "../src/learning/score.ts";
import * as PR from "../src/lang/zh/prompts.ts";

const WDAY = "2026-11-01";
/** 整理这一天的那一夜（她的日子 11-02 凌晨） */
const WNOW = SH("2026-11-02", "02:30:00");
type WlOpts = { day?: string; embedder?: Embedder | null; root?: string };
const wl = (db: ReturnType<typeof openDb>, shelf: Shelf, o: WlOpts = {}): Promise<string> =>
  worklist(db, shelf, o.day ?? WDAY, { now: WNOW, tz: RTZ, embedder: o.embedder ?? null, root: o.root ?? "/nonexistent", ...WHO, residentFile: RES_FILE });

/** 工作单里 `## 标题` 那一节的正文 */
function section(text: string, title: string): string {
  const s = text.split(/^## /m).find((x) => x.startsWith(`${title}\n`));
  assert.ok(s, `没有这一节：${title}`);
  return s.slice(title.length + 1).trim();
}
/** 一节里 `### 标题` 那一小节的正文 */
function subsection(body: string, title: string): string {
  const s = body.split(/^### /m).find((x) => x.startsWith(`${title}\n`));
  assert.ok(s, `没有这一小节：${title}`);
  return s.slice(title.length + 1).trim();
}

function wlEnv() {
  const db = openDb(":memory:");
  const run = (sql: string, ...p: Array<string | number | null>) => db.prepare(sql).run(...p);
  const assoc = (at: number, mounted: string[], o: { binding?: string; shadow?: number; topic?: string } = {}) =>
    run("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', ?, ?, 3, ?, ?, NULL, 5, 10)",
      at, o.binding ?? "wake", o.topic ?? "", JSON.stringify(mounted.map((id) => ({ id, p: 0.9 }))), o.shadow ?? 0);
  const open = (at: number, page: string | null, book: string | null = null) =>
    run("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', ?, ?)", at, page, book);
  const item = (id: string, kind: "page" | "lesson", firstSeen: number) =>
    run("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen) VALUES (?, ?, 'x', 'h', ?, ?)", id, kind, firstSeen, firstSeen);
  return { db, run, assoc, open, item };
}
const wlLesson = (id: string, text: string, days: string[] = [], sources: number[] = []): Lesson =>
  ({ ids: [id], line: 1, text, when: "", next: "", days, sources });
/** 第 n 页：标题 p${n}，书「本」，rel 做事/本/p${n}.md；o 里可以改 */
const wlPage = (n: number, title: string, o: Partial<Page> = {}): Page => cp(n, { title, ...o });
const HOUR = 3_600_000;

test("工作单：挂了没翻的页——当天真挂的、1 小时内没人翻的；只算不挂的、她自己找的、回测的、别的日子的不算", async () => {
  const { db, run, assoc, open } = wlEnv();
  const shelf = shelfOf(wlPage(12, "看成片"), wlPage(20, "配音"), wlPage(30, "剪辑", { ids: ["0030", "0005"] }), wlPage(40, "封面"), wlPage(50, "旧页"));
  run("INSERT INTO learn_alias (alias, id, at) VALUES ('0005', '0030', 1)");
  assoc(SH(WDAY, "10:00:00"), ["0012", "0020"], { topic: "验收成片" });
  open(SH(WDAY, "10:30:00"), "0020");                            // 翻开了配音
  assoc(SH(WDAY, "14:00:00"), ["0012"], { topic: "验收第二条" });   // 看成片又白挂一次
  assoc(SH(WDAY, "15:00:00"), ["0005", "0099"], { topic: "做片头" });   // 旧编号认得；书架上没有的编号也列出来
  open(SH(WDAY, "16:00:01"), "0030");                            // 过了 1 小时才翻：还是白挂
  assoc(SH(WDAY, "16:00:00"), ["0040"], { shadow: 1 });          // 只算不挂的
  assoc(SH(WDAY, "17:00:00"), ["0040"], { binding: "ask" });     // 她自己找的
  assoc(SH(WDAY, "18:00:00"), ["0040"], { binding: "replay" });  // 回测
  assoc(SH("2026-10-31", "23:59:00"), ["0050"]);                 // 前一天
  assoc(SH("2026-11-02", "00:00:30"), ["0050"]);                 // 后一天

  const body = section(await wl(db, shelf), "今天挂了没翻的页");
  const lines = body.split("\n");
  assert.equal(lines.length, 3, body);
  assert.match(lines.find((l) => l.includes("看成片"))!, /本 · 看成片（skills\/做事\/本\/p12\.md）：挂了 2 次没翻；当时在做：验收成片；验收第二条/);
  assert.match(lines.find((l) => l.includes("剪辑"))!, /挂了 1 次没翻；当时在做：做片头/);
  assert.match(lines.find((l) => l.includes("0099"))!, /p:0099（书架上找不到）：挂了 1 次没翻/);
  for (const t of ["配音", "封面", "旧页"]) assert.doesNotMatch(body, new RegExp(t), t);
});

test("工作单：又犯的两节——现场按「犯的日子」分类，不靠 learn_recur（那要等整理完才记）；这一天和前一天，每条每天只列一次，什么都不写", async () => {
  const { db, run, assoc } = wlEnv();
  const entry = (seq: number, ts: number) =>
    run("INSERT INTO central (seq, ts, epoch, src, kind, text, tokens) VALUES (?, ?, 1, 'main', 'note', '原话', 1)", seq, ts);
  const D1 = "2026-10-31";
  const L1 = wlLesson("0013", "只看了前十秒就说好", [WDAY], [100]);
  const shelf = shelfOf(
    wlPage(12, "看成片", { lessons: [L1] }),
    wlPage(20, "配音", { lessons: [
      wlLesson("0021", "前一天的又犯", [D1], [400]),
      wlLesson("0022", "前天的", ["2026-10-30"], [450]),
      wlLesson("0023", "后一天的", ["2026-11-02"], [460]),
    ] }),
    wlPage(30, "剪辑", { lessons: [
      wlLesson("0031", "没核对时长", [WDAY], [200]),
      { ...wlLesson("", "刚写的还没有编号", [WDAY], [300]), ids: [] },
      wlLesson("0032", "两天都犯", [D1, WDAY], [500, 501]),
    ] }),
    wlPage(40, "副本", { lessons: [L1] }),   // 同一条教训从另一条路径又出现一次
    wlPage(50, "旧页", { archived: true, lessons: [wlLesson("0051", "归档里的", [WDAY], [600])] }),
  );
  // 当天：看成片 13:00 挂过，15:00 又犯（出处 #100）→ 挂了还犯；剪辑没挂过 → 没挂就犯，话题取那一刻之前最近一次联想的
  entry(100, SH(WDAY, "15:00:00"));
  assoc(SH(WDAY, "13:00:00"), ["0012"], { topic: "验收成片" });
  entry(200, SH(WDAY, "16:00:00"));
  assoc(SH(WDAY, "15:30:00"), ["0020"], { topic: "做别的" });
  entry(300, SH(WDAY, "17:00:00"));
  entry(501, SH(WDAY, "18:00:00"));
  // 前一天：配音当天 09:00 挂过
  entry(400, SH(D1, "10:00:00"));
  assoc(SH(D1, "09:00:00"), ["0020"], { topic: "前一天的话题" });
  entry(500, SH(D1, "10:00:00"));
  // 学习表里有一行别人记的、书架上已经没有的：工作单只看现场，不读它
  run("INSERT INTO learn_recur (lesson_id, day, seq, kind, case_id) VALUES ('0077', ?, NULL, 'unmounted', NULL)", WDAY);

  const text = await wl(db, shelf);
  const missed = section(text, "今天又犯、当时没想起来的").split("\n");
  assert.equal(missed.length, 4, missed.join("\n"));
  assert.match(missed[0]!, /^- 两天都犯（本 · 剪辑，skills\/做事\/本\/p30\.md，l:0032）；2026-10-31；出处 #500；当时在做：前一天的话题$/);
  assert.match(missed[1]!, /^- 没核对时长（.*l:0031）；2026-11-01；出处 #200；当时在做：做别的$/);
  assert.match(missed[2]!, /^- 刚写的还没有编号（本 · 剪辑，skills\/做事\/本\/p30\.md）；2026-11-01；出处 #300；当时在做：做别的$/);
  assert.match(missed[3]!, /^- 两天都犯（.*l:0032）；2026-11-01；出处 #501；当时在做：做别的$/);
  const recalled = section(text, "想起来了还是又犯的").split("\n");
  assert.equal(recalled.length, 2, recalled.join("\n"));
  assert.match(recalled[0]!, /^- 前一天的又犯（本 · 配音，skills\/做事\/本\/p20\.md，l:0021）；2026-10-31；出处 #400；当时在做：前一天的话题$/);
  assert.match(recalled[1]!, /^- 只看了前十秒就说好（本 · 看成片，skills\/做事\/本\/p12\.md，l:0013）；2026-11-01；出处 #100；当时在做：验收成片$/);
  for (const t of ["前天的", "后一天的", "归档里的", "l:0077"]) assert.doesNotMatch(text, new RegExp(t), t);
  // 什么都不写：回测题和复发记录等夜里整理完才由 HH 记
  assert.deepEqual(all<{ lesson_id: string }>(db, "SELECT lesson_id FROM learn_recur").map((r) => r.lesson_id), ["0077"]);
  assert.deepEqual(all(db, "SELECT * FROM learn_case"), []);
});

test("工作单：ada 的纠正——当天的，带出处编号、话题和当时手上的事", async () => {
  const { db, run } = wlEnv();
  const cor = (at: number, seq: number | null, topic: string | null, task: number | null) =>
    run("INSERT INTO learn_correction (at, seq, topic, task_id, p) VALUES (?, ?, ?, ?, 0.9)", at, seq, topic, task);
  cor(SH(WDAY, "09:15:00"), 12345, "改封面", 7);
  cor(SH(WDAY, "20:00:00"), null, null, null);
  cor(SH("2026-10-31", "23:59:00"), 1, "前一天的", null);
  cor(SH("2026-11-02", "00:00:30"), 2, "后一天的", null);

  const body = section(await wl(db, shelfOf()), "今天 ada 的纠正");
  const lines = body.split("\n");
  assert.equal(lines.length, 3, body);
  assert.equal(lines[0], "- 09:15 #12345：改封面（当时手上的事 编号 7）");
  assert.equal(lines[1], "- 20:00（没有消息编号）：没记话题");
  assert.equal(lines[2], "- 还没落到笔记上：10-31 23:59 #1：前一天的", "前几天的纠正没落到笔记上的跟在后面（11-12）");
  assert.doesNotMatch(body, /后一天/);
});

test("工作单：做成的事——当天做完、最后一次回头看到了、之后 3 小时内没被纠正的才算", async () => {
  const { db, run } = wlEnv();
  const shelf = shelfOf(wlPage(12, "看成片"), wlPage(20, "配音"));
  const note = (src: string, ts: number, text: string) =>
    run("INSERT INTO central (ts, epoch, src, kind, text, tokens) VALUES (?, 1, ?, 'note', ?, 1)", ts, src, text);
  /** 一件事：ended 往前 30 分钟开头；met 默认记一条「回头看了一遍，到了」 */
  const task = (topic: string, ended: number, o: { state?: string; pages?: string[] | null; looks?: number; missing?: string | null; met?: boolean } = {}): number => {
    const r = run("INSERT INTO tasks (topic, owner, state, started, ended, looks, missing, pages) VALUES (?, 'main', ?, ?, ?, ?, ?, ?)",
      topic, o.state ?? "done", ended - 30 * 60_000, ended, o.looks ?? 0, o.missing ?? null, o.pages === undefined ? null : JSON.stringify(o.pages));
    if (o.met !== false) note("main", ended - 1000, PR.lookedMet("每条都对上了"));
    return Number(r.lastInsertRowid);
  };
  const cor = (at: number, task: number | null) => run("INSERT INTO learn_correction (at, seq, topic, task_id, p) VALUES (?, 1, 't', ?, 0.9)", at, task);

  // 各件事的时间互不重叠（回头看的记录按「开头到做完之间」认），纠正按做完之后 3 小时认
  const late = task("封面", SH(WDAY, "09:00:00"));                 // 9 小时后才被纠正，但那条纠正挂在这件事上
  cor(SH(WDAY, "18:00:00"), late);
  const fine = task("字幕", SH(WDAY, "10:00:00"), { pages: ["0099"] });   // 4 小时后有别的纠正，不算；页编号不在书架上就写编号
  cor(SH(WDAY, "14:00:00"), null);
  task("没回头看", SH(WDAY, "11:00:00"), { met: false });           // 没有「到了」的记录：没看过或没有结论
  task("只剩跟进", SH(WDAY, "13:00:00"), { state: "follow" });
  task("配音", SH(WDAY, "16:00:00"));                              // 1.5 小时后被纠正
  cor(SH(WDAY, "17:30:00"), null);
  const during = task("做的时候被纠正", SH(WDAY, "20:00:00"));       // 纠正在做完之前，挂在这件事上
  cor(SH(WDAY, "19:45:00"), during);
  const ok = task("剪片头", SH(WDAY, "21:00:00"), { pages: ["0012", "0020"] });
  const retried = task("返工后到了", SH(WDAY, "22:00:00"), { looks: 2, missing: "字太小" });   // 没到的记录还在，但最后一次到了
  task("昨天的", SH("2026-10-31", "15:00:00"));
  // 开头前的「到了」是更早那件事的，不算这件的；做完前只有「还没到」的也不算
  run("INSERT INTO tasks (topic, owner, state, started, ended) VALUES ('另一件', 'main', 'done', ?, ?)", SH(WDAY, "05:00:00"), SH(WDAY, "06:00:00"));
  note("main", SH(WDAY, "04:00:00"), PR.lookedMet("早一件的"));
  note("main", SH(WDAY, "05:30:00"), PR.lookedShort("还差一点"));

  const body = section(await wl(db, shelf), "做成的事");
  const lines = body.split("\n");
  assert.equal(lines.length, 3, body);
  assert.equal(lines[0], `- 「字幕」（编号 ${fine}）；挂过的页：0099`);
  assert.equal(lines[1], `- 「剪片头」（编号 ${ok}）；挂过的页：看成片、配音`);
  assert.equal(lines[2], `- 「返工后到了」（编号 ${retried}）；没挂过页`);
});

test("工作单：做成的事——同一个脑区同时有几件事，「到了」只算给当时收下的那一件", async () => {
  const { db, run } = wlEnv();
  const note = (ts: number) => run("INSERT INTO central (ts, epoch, src, kind, text, tokens) VALUES (?, 1, 'main', 'note', ?, 1)", ts, PR.lookedMet("每条都对上了"));
  const task = (topic: string, started: number, ended: number) =>
    Number(run("INSERT INTO tasks (topic, owner, state, started, ended) VALUES (?, 'main', 'done', ?, ?)", topic, started, ended).lastInsertRowid);
  // A 8 点开头、11 点没有回头看的结论就收下了；B 在它中间（9 点到 10 点）回头看到了：B 的「到了」落在 A 的开头到做完之间，但不是 A 的
  task("A 没结论就收下", SH(WDAY, "08:00:00"), SH(WDAY, "11:00:00"));
  const b = task("B 到了", SH(WDAY, "09:00:00"), SH(WDAY, "10:00:00"));
  note(SH(WDAY, "09:59:59"));
  // 「到了」和收下是同一刻写的：晚几秒也算，早 10 秒不算
  const c = task("C 晚两秒", SH(WDAY, "12:00:00"), SH(WDAY, "12:30:00"));
  note(SH(WDAY, "12:30:02"));
  task("D 早十秒", SH(WDAY, "13:00:00"), SH(WDAY, "13:30:00"));
  note(SH(WDAY, "13:29:50"));

  const lines = section(await wl(db, shelfOf()), "做成的事").split("\n");
  assert.deepEqual(lines, [`- 「B 到了」（编号 ${b}）；没挂过页`, `- 「C 晚两秒」（编号 ${c}）；没挂过页`]);
});

test("工作单：同一条犯了 3 天以上——只数合法的日子、同一天算一次，归档的页不算", async () => {
  const { db } = wlEnv();
  const shelf = shelfOf(
    wlPage(12, "看成片", { lessons: [
      wlLesson("0013", "甲三天", ["2026-10-25", "2026-10-28", "2026-11-01"]),
      wlLesson("0014", "乙两天", ["2026-10-25", "2026-10-28"]),
      wlLesson("0015", "丙重复", ["2026-10-25", "2026-10-25", "2026-10-26"]),
      wlLesson("0016", "丁带脏数据", ["2026-10-20", "2026-10-21", "2026-10-22", "昨天", "2026-02-30"]),
    ] }),
    wlPage(20, "旧页", { archived: true, lessons: [wlLesson("0021", "戊归档的", ["2026-10-25", "2026-10-28", "2026-11-01"])] }),
  );
  const body = section(await wl(db, shelf), "同一条犯了 3 天以上的");
  assert.equal(body.split("\n").length, 2, body);
  assert.match(body, /甲三天（本 · 看成片，skills\/做事\/本\/p12\.md，l:0013）：犯了 3 天（2026-10-25、2026-10-28、2026-11-01）/);
  assert.match(body, /丁带脏数据（.*l:0016）：犯了 3 天（2026-10-20、2026-10-21、2026-10-22）/);
  for (const t of ["乙两天", "丙重复", "戊归档的"]) assert.doesNotMatch(body, new RegExp(t), t);
});

test("工作单：删减和降级——白挂 5 次以上一次没翻的页、30 天没挂也没翻的页", async () => {
  const { db, assoc, open, item } = wlEnv();
  const shelf = shelfOf(
    wlPage(12, "全白挂"), wlPage(13, "翻过一次"), wlPage(14, "只挂四次"), wlPage(15, "靠书翻开", { book: "配音" }),
    wlPage(40, "冷门"), wlPage(41, "最近挂过"), wlPage(42, "新页"), wlPage(43, "最近翻过"), wlPage(44, "旧归档", { archived: true }),
  );
  // 白挂：全部挂了、一次没翻的页才算，数够 5 次
  for (let i = 0; i < 5; i++) assoc(SH("2026-10-1" + i, "10:00:00"), ["0012"]);
  for (let i = 0; i < 5; i++) assoc(SH("2026-10-1" + i, "11:00:00"), ["0013"]);
  open(SH("2026-10-12", "11:20:00"), "0013");
  for (let i = 0; i < 4; i++) assoc(SH("2026-10-1" + i, "12:00:00"), ["0014"]);
  for (let i = 0; i < 5; i++) assoc(SH("2026-10-1" + i, "13:00:00"), ["0015"]);     // 5 次，加载了那一本也算翻开
  open(SH("2026-10-10", "13:10:00"), null, "配音");
  for (let i = 0; i < 5; i++) assoc(SH("2026-10-2" + i, "10:00:00"), ["0014"], { shadow: 1 });   // 只算不挂的不加次数
  // 30 天没挂也没翻：要在书架上够 30 天（没有 learn_item 行的页不知道多久了，不列）；最近 30 天里挂过或翻过的不算
  const OLD = SH("2026-08-01");
  for (const id of ["0040", "0041", "0043", "0044"]) item(id, "page", OLD);
  item("0042", "page", SH("2026-10-20"));
  assoc(SH("2026-10-20", "10:00:00"), ["0041"]);
  open(SH("2026-10-25", "10:00:00"), "0043");

  const body = section(await wl(db, shelf), "删减和降级");
  const idle = subsection(body, "挂过 5 次以上、一次都没翻的页");
  assert.equal(idle, "- 本 · 全白挂（skills/做事/本/p12.md）：挂了 5 次，一次没翻");
  const cold = subsection(body, "30 天没挂也没翻的页");
  assert.equal(cold, "- 本 · 冷门（skills/做事/本/p40.md）");
});

test("工作单：删减和降级——待验证里 30 天没再用过的条目、学会了的教训", async () => {
  const root = makeShelf({
    "做事/剪辑/SKILL.md": "---\nname: 剪辑\ndescription: 剪片子\n---\n",
    "做事/剪辑/老做法.md": [
      "# 老做法 <!-- p:0070 -->", "简介：a", "什么时候翻：b", "", "## 做法", "- 稳的做法 ✓ 2026-09-01",
      "### 待验证", "- 先静音再看（2026-09-01 自己摸索）", "  - 细节：再试了两次", "- 抽帧看封面（2026-10-25 一次成功）", "- 没写日期的做法",
      "## 教训", "- 教训：这条不是待验证 2026-01-01｜什么时候：x｜下次：y",
    ].join("\n"),
    "做事/剪辑/常用.md": ["# 常用 <!-- p:0071 -->", "简介：a", "什么时候翻：b", "", "## 做法", "### 待验证", "- 老条目（2026-08-01）"].join("\n"),
    "做事/剪辑/归档/旧.md": ["# 旧 <!-- p:0072 -->", "简介：a", "什么时候翻：b", "", "## 做法", "### 待验证", "- 归档页的老条目（2026-08-01）"].join("\n"),
    "做事/剪辑/学得好.md": [
      "# 学得好 <!-- p:0050 -->", "简介：a", "什么时候翻：b", "", "## 教训",
      "- 教训：先看时长｜什么时候：x｜下次：y｜犯的日子：2026-09-01 <!-- l:0051 -->",
      "- 教训：又犯过的｜什么时候：x｜下次：y｜犯的日子：2026-09-01、2026-10-20 <!-- l:0052 -->",
      "- 教训：新写的｜什么时候：x｜下次：y <!-- l:0053 -->",
      "- 教训：从没犯过｜什么时候：x｜下次：y <!-- l:0054 -->",
    ].join("\n"),
    "做事/剪辑/才两天.md": ["# 才两天 <!-- p:0060 -->", "简介：a", "什么时候翻：b", "", "## 教训", "- 教训：还早｜什么时候：x｜下次：y｜犯的日子：2026-09-01 <!-- l:0061 -->"].join("\n"),
  });
  try {
    const { db, assoc, item } = wlEnv();
    const shelf = scanShelf(root, "通用", ARCH);
    assoc(SH("2026-10-20", "10:00:00"), ["0071"]);   // 常用最近挂过：老条目不算
    // 学得好 页在 30 天（10-03 到 11-01）里挂了 3 个不同的日子（第一天挂两次只算一天）
    for (const [d, h] of [["2026-10-05", "09"], ["2026-10-05", "15"], ["2026-10-12", "09"], ["2026-10-30", "09"]] as const) assoc(SH(d, `${h}:00:00`), ["0050"]);
    // 才两天 只有两个日子
    for (const d of ["2026-10-06", "2026-10-07", "2026-10-07"]) assoc(SH(d, "09:00:00"), ["0060"]);
    for (const id of ["0051", "0052", "0054"]) item(id, "lesson", SH("2026-09-10"));   // 早就在了
    item("0053", "lesson", SH("2026-10-29"));                                           // 10-29 才有：之前的挂载不是它的证据，之后只有 10-30 一天
    item("0061", "lesson", SH("2026-09-10"));

    const body = section(await wl(db, shelf, { root }), "删减和降级");
    const pend = subsection(body, "待验证里 30 天没再用过的条目");
    assert.equal(pend, "- 剪辑 · 老做法（skills/做事/剪辑/老做法.md）：先静音再看（2026-09-01 自己摸索）（日期 2026-09-01）");
    const learned = subsection(body, "学会了的教训");
    assert.equal(learned.split("\n").length, 2, learned);
    assert.match(learned, /先看时长（剪辑 · 学得好，skills\/做事\/剪辑\/学得好\.md，l:0051）：这 30 天页被挂了 3 天，这条没再犯/);
    assert.match(learned, /从没犯过（.*l:0054）：这 30 天页被挂了 3 天，这条没再犯/);
    for (const t of ["又犯过的", "新写的", "还早"]) assert.doesNotMatch(learned, new RegExp(t), t);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 在 e0、e1 张成的平面里转 angle 弧度的单位向量：两个向量的余弦就是夹角的余弦 */
const unitAt = (angle: number): Float32Array => {
  const v = new Float32Array(512);
  v[0] = Math.cos(angle);
  v[1] = Math.sin(angle);
  return v;
};
const putCover = (db: ReturnType<typeof openDb>, id: string, angle: number) =>
  db.prepare("INSERT INTO learn_cover (page_id, hash, vec) VALUES (?, 'h', ?)").run(id, new Uint8Array(unitAt(angle).buffer));

function dupEnv() {
  const env = wlEnv();
  const shelf = shelfOf(
    wlPage(12, "看成片", { lessons: [wlLesson("0013", "只看前十秒就说好")] }),
    wlPage(20, "配音", { lessons: [wlLesson("0021", "没看完整条就说好")] }),
    wlPage(30, "剪辑", { lessons: [wlLesson("0031", "忘了核对时长")] }),
    wlPage(40, "旧页", { archived: true, lessons: [wlLesson("0041", "归档里的教训")] }),
    wlPage(50, "没有封面向量"),
  );
  // 页的封面：看成片和配音夹角 0.3 弧度（余弦 0.955）；旧页是归档的，不进；剪辑离得远
  for (const [id, a] of [["0012", 0], ["0020", 0.3], ["0030", 1.2], ["0040", 0.1]] as const) putCover(env.db, id, a);
  const angles: Record<string, number> = { 只看前十秒就说好: 0, 没看完整条就说好: 0.2, 忘了核对时长: 1.5, 归档里的教训: 0.05 };
  const calls: Array<{ texts: string[]; timeoutMs: number | undefined }> = [];
  const embedder: Embedder = {
    async embed(texts, o) {
      calls.push({ texts, timeoutMs: o?.timeoutMs });
      return texts.map((t) => unitAt(angles[t] ?? 3));
    },
  };
  return { ...env, shelf, embedder, calls };
}

test("工作单：可能重复的——封面向量相近的页对、正文向量相近的教训对；归档的不算；教训一次请求算完", async () => {
  const { db, shelf, embedder, calls } = dupEnv();
  const body = section(await wl(db, shelf, { embedder }), "可能重复的");
  const lines = body.split("\n");
  assert.equal(lines.length, 2, body);
  assert.equal(lines[0], "- 页：本 · 看成片（skills/做事/本/p12.md） ≈ 本 · 配音（skills/做事/本/p20.md）（余弦 0.96）");
  assert.equal(lines[1], "- 教训：只看前十秒就说好（本 · 看成片，l:0013） ≈ 没看完整条就说好（本 · 配音，l:0021）（余弦 0.98）");
  assert.deepEqual(calls, [{ texts: ["只看前十秒就说好", "没看完整条就说好", "忘了核对时长"], timeoutMs: 60_000 }], "一次请求、归档页的教训不算、超时给足");
});

test("工作单：可能重复的——向量服务算不了（没有、返回空、抛错、条数对不上）时教训那半写「今晚算不了」，页对照常", async () => {
  const { db, shelf } = dupEnv();
  const broken: Array<[string, Embedder | null]> = [
    ["没有", null],
    ["返回空", { async embed() { return null; } }],
    ["抛错", { async embed() { throw new Error("boom"); } }],
    ["条数对不上", { async embed() { return [unitAt(0)]; } }],
  ];
  for (const [why, embedder] of broken) {
    const body = section(await wl(db, shelf, { embedder }), "可能重复的");
    assert.equal(body.split("\n").length, 2, `${why}：${body}`);
    assert.match(body, /^- 页：本 · 看成片.*本 · 配音/, why);
    assert.match(body, /\n- 教训：（今晚算不了）$/, why);
  }
  // 教训不到两条没有可比的，用不着向量服务
  const few = wlEnv();
  const one = shelfOf(wlPage(12, "看成片", { lessons: [wlLesson("0013", "只有一条")] }));
  assert.equal(section(await wl(few.db, one), "可能重复的"), "（没有）");
});

test("工作单：强度的升降建议——按参数算（窗口里犯几天升、多久没犯降），常驻着还犯的提机制，常驻单子该进该出的（11-03 强度）", async () => {
  const { db } = wlEnv();
  const root = makeShelf({ "常驻.md": "# 常驻\n- 丁那条 <!-- l:0034 -->\n- 丙那条 <!-- l:0033 -->\n" });
  try {
    const st = (l: Lesson, strength?: number): Lesson => (strength === undefined ? l : { ...l, strength });
    const shelf = shelfOf(wlPage(1, "看成片", { lessons: [
      st(wlLesson("0031", "甲三天", ["2026-10-25", "2026-10-28", "2026-11-01"])),
      st(wlLesson("0032", "乙两天", ["2026-10-30", "2026-11-01"])),
      st(wlLesson("0033", "丙很久没犯", ["2026-10-01"]), 5),
      st(wlLesson("0034", "丁常驻还犯", ["2026-11-01"]), 5),
      st(wlLesson("0035", "戊没变", ["2026-10-31"]), 3),
      st(wlLesson("0036", "己强度五", ["2026-10-29"]), 5),
    ] }));
    const body = section(await wl(db, shelf, { root }), "强度（升降建议）");
    assert.match(body, /^（参数：看最近 14 天；犯 2 天 → 强度 4，犯 3 天 → 5；4 级以上 14 天没犯降一级；常驻最多 10 条。改参数：hh learn param。写法/);
    assert.match(body, /- 甲三天（本 · 看成片，skills\/做事\/本\/p1\.md，l:0031）：3 → 5（14 天里犯了 3 天：10-25、10-28、11-01）/);
    assert.match(body, /- 乙两天（.*l:0032）：3 → 4（14 天里犯了 2 天：10-30、11-01）/);
    assert.match(body, /- 丙很久没犯（.*l:0033）：5 → 4（31 天没犯了）/);
    assert.match(body, /- 丁常驻还犯（.*l:0034）：常驻着今天还犯了：光提醒不够，想想能不能做成机制（工具、HH 拦住），记进毛病本交 ada/);
    assert.match(body, /强度 5、还没进常驻单子：.*l:0036/);
    assert.match(body, /常驻单子里很久没犯的：.*（l:0033，31 天没犯）/);
    assert.doesNotMatch(body, /戊没变/);
    assert.match(body, /写法：那一行加「｜强度：N」/);
    setParam(db, "strength.strongDays", 3, { why: "测试", by: "t", now: 1 });
    assert.doesNotMatch(section(await wl(db, shelf, { root }), "强度（升降建议）"), /乙两天/, "跟着参数");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工作单：常驻不常驻按前缀里真放的算——单子有了，单子外的强度 5 今天又犯只提「没进单子」，不提机制（review fd8f373）", async () => {
  const { db } = wlEnv();
  const root = makeShelf({ "常驻.md": "# 常驻\n- 别的那条 <!-- l:0041 -->\n" });
  try {
    const shelf = shelfOf(wlPage(1, "看成片", { lessons: [
      { ...wlLesson("0041", "甲在单子里", ["2026-10-20"]), strength: 5 },
      { ...wlLesson("0042", "乙不在单子里", ["2026-11-01"]), strength: 5 },
    ] }));
    const body = section(await wl(db, shelf, { root }), "强度（升降建议）");
    assert.doesNotMatch(body, /乙不在单子里[^\n]*常驻着今天还犯了/);
    assert.match(body, /强度 5、还没进常驻单子：乙不在单子里/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("工作单：空的节写（没有）；十节的标题和顺序照旧", async () => {
  const text = await wl(openDb(":memory:"), shelfOf(), { embedder: { async embed() { throw new Error("没有教训，不该去算向量"); } } });
  const titles = [
    "今天挂了没翻的页", "开始做时提过、没翻就做完了", "今天又犯、当时没想起来的", "想起来了还是又犯的", "今天 ada 的纠正",
    "做成的事", "同一条犯了 3 天以上的", "强度（升降建议）", "删减和降级", "可能重复的",
  ];
  assert.deepEqual([...text.matchAll(/^## (.*)$/gm)].map((m) => m[1]), titles);
  assert.ok(text.startsWith(`# 学习工作单 ${WDAY}\n`));
  for (const t of titles) assert.equal(section(text, t), "（没有）", t);
});

test("工作单：日期不是 YYYY-MM-DD（或不是真有的一天）就拒绝，说清楚怎么写", async () => {
  for (const day of ["11-01", "2026/11/01", "昨天", "2026-02-30", "2026-13-01", ""]) {
    await assert.rejects(wl(openDb(":memory:"), shelfOf(), { day }), /YYYY-MM-DD/, day || "空");
  }
});

test("运行时：worklist 按书架现在的样子出工作单（不用缓存、不发号、不写文件）", async () => {
  const lesson = (days: string) => `- 教训：只看前十秒就说好｜什么时候：x｜下次：y｜犯的日子：${days} <!-- l:0013 -->`;
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/看成片.md": ["# 看成片 <!-- p:0012 -->", "简介：a", "什么时候翻：b", "", "## 教训", lesson("2026-10-25")].join("\n"),
  });
  try {
    const db = openDb(":memory:");
    const rt = createLearningRuntime({
      ...WHO,
      db, cfg: { ...testConfig().learning, root }, embedder: null, judge: { judge: async () => null }, vec: async () => null,
      now: () => WNOW, log: new Logger("t", memorySink([])), stateDir: "/nonexistent", tz: RTZ,
    });
    rt.shelf();   // 缓存一份书架（这一步会发号）
    const itemsBefore = all(db, "SELECT * FROM learn_item").length;
    assert.equal(section(await rt.worklist(WDAY), "同一条犯了 3 天以上的"), "（没有）");
    // 白天她又犯了两次，写进了那一行：工作单要看得到
    const edited = ["# 看成片 <!-- p:0012 -->", "简介：a", "什么时候翻：b", "", "## 教训", lesson("2026-10-25、2026-10-28、2026-11-01"), "- 教训：刚写的还没有编号｜什么时候：x｜下次：y"].join("\n");
    writeFileSync(join(root, "通用/验收/看成片.md"), edited);
    db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', 'wake', '验收', 1, '[{\"id\":\"0012\",\"p\":0.9}]', 0, NULL, 1, 1)").run(SH(WDAY, "10:00:00"));
    const text = await rt.worklist(WDAY);
    assert.match(section(text, "同一条犯了 3 天以上的"), /只看前十秒就说好.*l:0013）：犯了 3 天/);
    assert.match(section(text, "今天挂了没翻的页"), /验收 · 看成片（skills\/通用\/验收\/看成片\.md）：挂了 1 次没翻/);
    assert.equal(all(db, "SELECT * FROM learn_item").length, itemsBefore, "不发号、不记 learn_item");
    assert.equal(readFileSync(join(root, "通用/验收/看成片.md"), "utf8"), edited, "文件原样（没号的教训也没被补号）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 夜里调参（参数靠每晚的 eval 平衡性能、价格、效果） ----------
import { planTuning, nightTune, nightMetrics, TUNER } from "../src/learning/tuner.ts";
import type { NightMetrics } from "../src/learning/tuner.ts";

const calm: NightMetrics = { spendUsd: 0.5, dailyUsd: 1, wake: { n: 50, judgeFail: 0.01, p90: 600, limitMs: 1500 }, mounted: 40, opened: 6, perAssoc: 1.2, midworkShare: 0.2, replay: { now: 0.8, prev: 0.8, n: 10 } };
const cur = { "midwork.everyMin": 5, "midwork.everyTools": 8, "assoc.itemsK": 8, "assoc.threshold": 0.7, "midwork.minMin": 2 };

test("调参：平常的一天不动；花费快到上限先省干活时联想再少问条目，一晚最多两个", () => {
  assert.deepEqual(planTuning(calm, cur, []), { rollbacks: [], changes: [], held: [] });
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.01, wake: { ...calm.wake, n: 2 }, mounted: 1 }, cur, []).changes, [], "这一天几乎没联想过：数不够不调");
  const r = planTuning({ ...calm, spendUsd: 0.85, midworkShare: 0.4 }, cur, []);
  assert.deepEqual(r.changes.map((c) => [c.name, c.value, c.watch]), [["midwork.everyMin", 6, "none"], ["midwork.everyTools", 10, "none"]], "省钱只省干活时联想的次数，不少问条目（sess-4c 11-04）");
  assert.ok(!planTuning({ ...calm, spendUsd: 0.95, midworkShare: 0.1 }, cur, []).changes.some((c) => c.name === "assoc.itemsK"), "花费再高也不砍条目数");
  // 还慢：第三条也想少问条目，已经在单子上了、也没位置
  assert.equal(planTuning({ ...calm, spendUsd: 0.85, midworkShare: 0.4, wake: { ...calm.wake, judgeFail: 0.2 } }, cur, []).changes.length, 2);
});

test("调参：叫醒时判断慢就少问条目；钱花得少又不慢，干活时联想勤一点；到了上下限不再动", () => {
  assert.deepEqual(planTuning({ ...calm, wake: { ...calm.wake, p90: 1450 } }, cur, []).changes.map((c) => [c.name, c.value]), [["assoc.itemsK", 6]]);
  assert.deepEqual(planTuning({ ...calm, wake: { ...calm.wake, n: 3, p90: 1450 } }, cur, []).changes, [], "叫醒太少不算");
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.1 }, cur, []).changes.map((c) => [c.name, c.value]), [["midwork.everyMin", 4]], "条目数在默认上，不往上加");
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.1 }, { ...cur, "midwork.everyMin": 2 }, []).changes, [], "到下限了");
  // 条目数往下调过：钱和速度宽裕时往回加，最多回到默认（review a530de7）
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.1 }, { ...cur, "midwork.everyMin": 2, "assoc.itemsK": 4 }, []).changes.map((c) => [c.name, c.value, c.watch]), [["assoc.itemsK", 6, "spend"]]);
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.1 }, { ...cur, "midwork.everyMin": 2, "assoc.itemsK": 7 }, []).changes.map((c) => [c.name, c.value]), [["assoc.itemsK", 8]]);
});

test("调参：条目数为了快往下减，最多减到 4（#0026：11-06 到 11-12 一路减到 0，普通教训一条都不贴了）", () => {
  const slow = { ...calm, wake: { ...calm.wake, p90: 1500 } };
  assert.deepEqual(planTuning(slow, { ...cur, "assoc.itemsK": 6 }, []).changes.map((c) => [c.name, c.value]), [["assoc.itemsK", 4]]);
  const at4 = planTuning(slow, { ...cur, "assoc.itemsK": 4 }, []);
  assert.deepEqual(at4.changes, [], "到 4 不再减");
  assert.match(at4.held.join("\n"), /assoc\.itemsK 不再往下调：已经到调参器的下限 4/);
  assert.deepEqual(planTuning(slow, { ...cur, "assoc.itemsK": 5 }, []).changes, [], "5 → 3 会过下限：不减");
  assert.deepEqual(planTuning(slow, { ...cur, "assoc.itemsK": 2 }, []).changes, [], "手动调到 4 以下的，调参器也不再往下减（2 → 0）");
  assert.deepEqual(planTuning({ ...calm, spendUsd: 0.1 }, { ...cur, "midwork.everyMin": 2, "assoc.itemsK": 0 }, []).changes.map((c) => [c.name, c.value]), [["assoc.itemsK", 2]],
    "钱和速度宽裕时照旧往回加");
});

test("调参：上次为了快减了条目、还是一样慢，就不再减，写一行为什么；减了有用的、30 天以前的，照常减", () => {
  const now = Date.UTC(2026, 10, 12, 16, 30);
  const cut = { night: "2026-11-10", at: now - 2 * 86_400_000, value: 6, p90: 1456, fail: 0.04 };
  const still = { ...calm, wake: { ...calm.wake, p90: 1519, judgeFail: 0.04 } };
  const at6 = { ...cur, "assoc.itemsK": 6 };   // 还停在那次减到的值
  const r = planTuning(still, at6, [], { "assoc.itemsK": cut }, now);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.held, ["- assoc.itemsK 不再减：2026-11-10 那晚为了快减过，减之前 p90 1456ms、4% 没回来，现在 1519ms、4%，没变快"]);
  // 上次减之前 p90 1500，现在 1300（快了一成以上），但没回来的有 5%，还算慢
  const faster = { ...calm, wake: { ...calm.wake, p90: 1300, judgeFail: 0.05 } };
  assert.deepEqual(planTuning(faster, at6, [], { "assoc.itemsK": { ...cut, p90: 1500 } }, now).changes.map((c) => c.name), ["assoc.itemsK"],
    "上次减了有用（p90 1500 → 1300）：还慢就照常减");
  assert.deepEqual(planTuning(still, at6, [], { "assoc.itemsK": { ...cut, at: now - 31 * 86_400_000 } }, now).changes.map((c) => c.name), ["assoc.itemsK"], "30 天以前减的不算数");
  const r6 = planTuning(still, { ...cur, "assoc.itemsK": 6 }, [], { "assoc.itemsK": cut }, now);
  assert.deepEqual([r6.changes, r6.held.length], [[], 1], "还停在那次减到的 6：算数，不减");
  assert.deepEqual(planTuning(still, { ...cur, "assoc.itemsK": 8 }, [], { "assoc.itemsK": cut }, now).changes.map((c) => [c.name, c.value]), [["assoc.itemsK", 6]],
    "后来往回加过（6 → 8）：那次的效果量不出来了，照常减");
  const noWarm = { ...calm, wake: { ...calm.wake, p90: 0, judgeFail: 0.05 } };
  assert.deepEqual(planTuning(noWarm, { ...cur, "assoc.itemsK": 6 }, [], { "assoc.itemsK": cut }, now).changes, [], "这一天没量到热的判断（p90 是 0）不算变快");
});

test("调参：夜里为了快减了条目，记下当时多慢；之后几晚还是一样慢就不再减（kv learn.tuner.cuts）", () => {
  const db = openDb(":memory:");
  const start = Date.UTC(2026, 10, 9, 16, 30);
  const ins = db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', 'wake', 't', NULL, 1, '[]', 0, NULL, ?, 1000)");
  const nightAt = (k: number) => start + k * 86_400_000;
  for (let k = 0; k < 3; k++) for (let i = 0; i < 12; i++) ins.run(nightAt(k) - 3600_000 - i * 30_000, 1490);   // 每晚之前那一天：叫醒 12 次，都是热的、1490ms
  const o = (k: number) => ({ now: nightAt(k), day: `2026-11-${10 + k}`, night: `2026-11-${11 + k}`, prevNight: null, dailyUsd: 1, limitMs: 1500, fallback: { "assoc.threshold": 0.7, "assoc.remountTokens": 50_000 } });
  assert.match(nightTune(db, o(0)).join("\n"), /assoc\.itemsK：8 → 6/);
  const cuts = JSON.parse(kvGet(db, "learn.tuner.cuts")!) as Record<string, { night: string; p90: number }>;
  assert.deepEqual([cuts["assoc.itemsK"]!.night, cuts["assoc.itemsK"]!.p90], ["2026-11-11", 1490]);
  const second = nightTune(db, o(1)).join("\n");
  assert.match(second, /assoc\.itemsK 不再减：2026-11-11 那晚为了快减过/);
  const third = nightTune(db, o(2)).join("\n");
  assert.doesNotMatch(third, /assoc\.itemsK：6 →/);
  assert.match(third, /不再减/);
  assert.equal(param(db, "assoc.itemsK"), 6);
  // 往回加过（手动调回 8）：那次减的效果量不出来了，还慢就照常减，再记一次
  setParam(db, "assoc.itemsK", 8, { why: "测试：手动加回去", by: "ada", now: nightAt(2) });
  for (let i = 0; i < 12; i++) ins.run(nightAt(3) - 3600_000 - i * 30_000, 1490);
  assert.match(nightTune(db, o(3)).join("\n"), /assoc\.itemsK：8 → 6/);
  assert.equal((JSON.parse(kvGet(db, "learn.tuner.cuts")!) as Record<string, { night: string }>)["assoc.itemsK"]!.night, "2026-11-14");
});

test("调参：老题回测过得少、挂的她还翻 → 门槛放低；回测都过、一次挂好几页、几乎不翻 → 抬高", () => {
  assert.deepEqual(planTuning({ ...calm, replay: { now: 0.5, prev: 0.6, n: 10 }, opened: 8 }, cur, []).changes.map((c) => [c.name, c.value, c.watch]), [["assoc.threshold", 0.65, "openRate"]], "放低怕挂得杂");
  assert.deepEqual(planTuning({ ...calm, replay: { now: 0.95, prev: 0.9, n: 10 }, perAssoc: 2, mounted: 40, opened: 1 }, cur, []).changes.map((c) => [c.name, c.value, c.watch]), [["assoc.threshold", 0.75, "replay"]], "抬高怕漏掉对的");
  assert.deepEqual(planTuning({ ...calm, replay: { now: 0.5, prev: 0.6, n: 3 }, opened: 8 }, cur, []).changes, [], "老题太少不算");
});

test("调参：上一晚的改动盯的数变坏了就退回，这一晚不再动它；没变坏的也先不动它", () => {
  const last = [{ night: "2026-11-03", name: "midwork.everyMin", old: 5, value: 4, watch: "spend" as const, before: 0.3 }];
  const bad = planTuning({ ...calm, spendUsd: 0.9, midworkShare: 0.5 }, { ...cur, "midwork.everyMin": 4 }, last);
  assert.deepEqual(bad.rollbacks.map((c) => [c.name, c.value]), [["midwork.everyMin", 5]]);
  assert.deepEqual(bad.changes.map((c) => c.name), ["midwork.everyTools"], "退回占一个，剩一个位置");
  const ok = planTuning({ ...calm, spendUsd: 0.1 }, { ...cur, "midwork.everyMin": 4 }, last);
  assert.deepEqual([ok.rollbacks, ok.changes], [[], []], "上一晚刚改过的这晚先看着");
});

test("调参：夜里量一天的数、按规矩改参数（记 night-tuner），同一晚重跑不再动，下一晚变坏了退回", () => {
  const db = openDb(":memory:");
  const now = Date.UTC(2026, 10, 3, 16, 30);   // 枫湾 11-04 03:30
  kvSet(db, "learn.spend.2026-11-03", String(9_000_000));   // $0.9
  const ins = db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, ?, ?, ?, NULL, 1, ?, 0, ?, ?, ?)");
  for (let i = 0; i < 20; i++) ins.run(now - 3600_000 - i * 60_000, "main", i < 12 ? "wake" : "midwork", "t", i % 2 ? '[{"id":"0001","p":0.9}]' : "[]", null, 500, i < 12 ? 1000 : 4000);
  db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'main', '0001', NULL)").run(now - 3600_000 - 60_000 + 5_000);
  const o = { now, day: "2026-11-03", night: "2026-11-04", prevNight: null, dailyUsd: 1, limitMs: 1500, fallback: { "assoc.threshold": 0.7, "assoc.remountTokens": 50_000 } };
  const m = nightMetrics(db, o);
  assert.equal(Math.round(m.spendUsd * 100), 90);
  assert.equal(m.wake.n, 12);
  assert.equal(m.mounted, 10);
  assert.equal(m.opened, 1);
  assert.equal(Math.round(m.midworkShare * 100), Math.round((8 * 4000) / (12 * 1000 + 8 * 4000) * 100));
  // 同一件事接着做带上的页（carry）不算进挂了几页、翻了几页：不是门槛挑的，又是她上次翻过的（11-05）
  const dbc = openDb(":memory:");
  dbc.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'side-1', 'on_it', 't', 1, 1, ?, 0, NULL, 500, 1000)")
    .run(now - 3600_000, '[{"id":"0001","p":0.95},{"id":"0002","p":0.97,"carry":true}]');
  dbc.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'side-2', 'on_it', 't', 2, 1, ?, 0, NULL, 500, 1000)")
    .run(now - 3600_000, '[{"id":"0003","p":0.97,"carry":true}]');
  dbc.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'side-1', '0002', NULL)").run(now - 3600_000 + 5_000);
  const mc = nightMetrics(dbc, o);
  assert.deepEqual([mc.mounted, mc.opened, mc.perAssoc], [1, 0, 1]);
  const lines = nightTune(db, o);
  assert.equal(lines[0], "# 调参（夜里）");
  assert.match(lines.join("\n"), /midwork\.everyMin：5 → 6/);
  assert.equal(param(db, "midwork.everyMin"), 6);
  assert.ok(paramLog(db).every((l) => l.by === TUNER));
  assert.deepEqual(nightTune(db, o).slice(1), ["- 今晚已经调过了"]);
  // 下一晚：花费还高，调稀那个量不出坏处，不退回；它刚改过也先不动
  kvSet(db, "learn.spend.2026-11-04", String(9_900_000));
  const lines2 = nightTune(db, { ...o, now: now + 24 * 3600_000, day: "2026-11-04", night: "2026-11-05" });
  assert.doesNotMatch(lines2.join("\n"), /退回/);
  assert.equal(param(db, "midwork.everyMin"), 6);
  // 钱花得少 → 勤一点（盯花费）；再下一晚花费冲上去了 → 退回
  const db2 = openDb(":memory:");
  kvSet(db2, "learn.spend.2026-11-03", String(1_000_000));   // $0.1
  const ins2 = db2.prepare("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', 'wake', 't', NULL, 1, '[]', 0, NULL, 400, 1000)");
  for (let i = 0; i < 12; i++) ins2.run(now - 3600_000 - i * 60_000);
  nightTune(db2, o);
  assert.equal(param(db2, "midwork.everyMin"), 4);
  kvSet(db2, "learn.spend.2026-11-04", String(9_500_000));
  const back = nightTune(db2, { ...o, now: now + 24 * 3600_000, day: "2026-11-04", night: "2026-11-05" });
  assert.match(back.join("\n"), /midwork\.everyMin：4 → 5（退回：上一晚把 midwork\.everyMin 从 5 改成 4/);
  assert.equal(param(db2, "midwork.everyMin"), 5);
});

test("联想的新默认（11-04 调研：花费几乎全在题数）：叫醒粗筛 10 页、做事 15 页，通用类不再全补；页过线 0.9", async () => {
  const pages = [...Array.from({ length: 25 }, (_, i) => cp(i + 1)), ...Array.from({ length: 8 }, (_, i) => gen(101 + i))];
  const d = testConfig().learning;   // 配置的默认：粗筛 10/15
  const a = await associator(pages, { probs: { "0001": 0.85, "0002": 0.92 }, cfg: { kWake: d.kWake, kTask: d.kTask } });
  for (const k of ["assoc.threshold", "assoc.itemsK", "assoc.generalExtra", "assoc.reuseCos"]) setParam(a.db, k, null, { why: "回到默认", by: "t", now: 1 });
  const wake = await a.notes.associate("话题一", { region: "main", binding: "wake", });
  const pageQs = (i: number) => a.calls[i]!.qs.filter((q) => /^\d{4}$/.test(q.name)).length;
  assert.equal(pageQs(0), 10, "叫醒：前 10 页，通用类不补");
  assert.deepEqual(wake.pages.map((x) => x.id), ["0002"], "0.85 不过线、0.92 过");
  await a.notes.associate("话题二", { region: "side-1", binding: "on_it" });
  assert.equal(pageQs(1), 15, "做事：前 15 页");
  setParam(a.db, "assoc.generalExtra", 5, { why: "测试", by: "t", now: 2 });
  await a.notes.associate("话题三", { region: "side-2", binding: "on_it" });
  assert.equal(pageQs(2), 20, "通用类最多补 assoc.generalExtra 页");
});

test("联想：同一个脑区隔不久又来一个几乎一样的话题，上次问过的题照用、只问新的；隔久了、换脑区、关掉（reuseCos 1）都照常问；ada 那句的纠正题每次都问", async () => {
  const a = await associator([cp(1), cp(2), cp(3)], { probs: { "0001": 0.9, correction: 0.2 } });
  setParam(a.db, "assoc.reuseCos", 0.95, { why: "测试：打开", by: "t", now: 1 });
  const extra = [{ name: "correction", text: "是在纠正她吗？" }];
  const r1 = await a.notes.associate("交小样之前再看一遍", { region: "main", binding: "done_with", extra });
  assert.deepEqual(r1.pages.map((x) => x.id), ["0001"]);
  a.tick(60_000);
  const r2 = await a.notes.associate("交小样之前再看一遍，补一句", { region: "main", binding: "done_with", extra });   // 假向量：每个话题都一样
  assert.equal(a.calls.length, 2, "纠正题照问");
  assert.deepEqual(a.calls[1]!.qs.map((q) => q.name), ["correction"], "页的题都照用上次的");
  assert.equal(r2.extra.get("correction"), 0.2);
  a.tick(60_000);
  await a.notes.associate("交小样之前再看一遍，再补一句", { region: "main", binding: "done_with" });
  assert.equal(a.calls.length, 2, "没有新题：不调判断");
  await a.notes.associate("交小样之前再看一遍", { region: "side-1", binding: "done_with" });
  assert.equal(a.calls.length, 3, "换个脑区照常问");
  assert.ok(a.calls[2]!.qs.some((q) => q.name === "0001"));
  a.tick(11 * 60_000);
  await a.notes.associate("交小样之前再看一遍，第四遍", { region: "main", binding: "done_with" });
  assert.equal(a.calls.length, 4, "隔了 10 分钟以上：照常问");
  setParam(a.db, "assoc.reuseCos", 1, { why: "关掉", by: "t", now: 2 });
  a.tick(60_000);
  await a.notes.associate("交小样之前再看一遍，第五遍", { region: "main", binding: "done_with" });
  assert.equal(a.calls.length, 5, "reuseCos 1：不照用");
});

test("联想照用上次判断（review 8a5fbae）：照用来的概率真能挂页；只按锚算时间（一串照用不会一直延下去）；题面改了的重问", async () => {
  const p1 = cp(1), p2 = cp(2);
  const a = await associator([p1, p2], { probs: { "0001": 0.9 } });
  setParam(a.db, "assoc.reuseCos", 0.95, { why: "测试：打开", by: "t", now: 1 });
  // 先算不挂、不 confirm：没算挂过，只留下判断
  await a.notes.associate("剪片子第一段", { region: "main", binding: "midwork", hold: true });
  assert.equal(a.calls.length, 1);
  a.probs["0001"] = 0;   // 再问的话就挂不上：挂上了只能是照用的
  a.tick(6 * 60_000);
  const r = await a.notes.associate("剪片子第一段，接着", { region: "main", binding: "midwork" });
  assert.equal(a.calls.length, 1, "没有新题：不调判断");
  assert.deepEqual(r.pages.map((x) => x.id), ["0001"], "照用来的 0.9 挂上了");
  a.tick(5 * 60_000);   // 离上一次 5 分钟、离锚 11 分钟
  await a.notes.associate("剪片子第一段，再接着", { region: "main", binding: "midwork", hold: true });
  assert.equal(a.calls.length, 2, "时间按锚算：过了 10 分钟就从头问");
  a.tick(60_000);
  p2.brief = "改过的简介";
  await a.notes.associate("剪片子第一段，又接着", { region: "main", binding: "midwork", hold: true });
  assert.deepEqual(a.calls[2]!.qs.map((q) => q.name), ["0002"], "题面改了的那页重问，别的照用");
});

test("联想给多少（ada 11-04：联想只给大概，判断很有把握才直接给原文；开始做事时提醒她先翻）：把握到 assoc.fullTextAt 的条目给原文，不到的只给一句大概；开始做时第一页的做法头几条也只在把握够时贴", async () => {
  const page = hitsPage(1);
  const a = await associator([page, cp(2)], { probs: { "l:1150": 0.999, "0001#1": 0.93 }, files: { "做事/本/p1.md": HITS_PAGE } });
  setParam(a.db, "assoc.fullTextAt", 0.995, { why: "测试：默认", by: "t", now: 1 });
  const r = await a.notes.associate("会长的嘴还是三角的，你放大看看", { region: "main", binding: "wake" });
  assert.equal(r.text, [
    "想起来的笔记（用得上就翻开）：",
    "· 本 · p1：简介1（2 条教训；skills/做事/本/p1.md）",
    "  对得上的：",
    "  - 每个部件放大到原尺寸看（上次：验小样只核了动没动）",
    "  可能有关（不一定准，翻开核一下）：",
    "  - 整张看，和原图并排",
  ].join("\n"));
  const b = await associator([page, cp(2)], { probs: { "0001": 0.95 }, files: { "做事/本/p1.md": HITS_PAGE } });
  setParam(b.db, "assoc.fullTextAt", 0.995, { why: "测试：默认", by: "t", now: 1 });
  const rb = await b.notes.associate("给会长加转头", { region: "main", binding: "on_it" });
  assert.equal(rb.text, "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：\n· 本 · p1：简介1（2 条教训；skills/做事/本/p1.md）", "把握不够：做法不贴，让她自己翻");
  b.probs["0001"] = 0.999;
  const rc = await b.notes.associate("给会长加转头", { region: "side-1", binding: "on_it" });
  assert.match(rc.text, /先照这几条做/, "很有把握：照旧贴做法头几条");
});

test("联想记录：因为强联想条目挂上的页，记录里带 strong（11-05：挂了没翻的提醒不把它算成「以前做过类似的」）", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2)], { probs: { "0002": 0.9, "l:1150": 0.6 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  await a.notes.associate("会长小样做好了，发给 ada 看", { region: "main", binding: "on_it" });
  assert.deepEqual(JSON.parse(a.rows()[0]!.mounted), [{ id: "0001", p: 0.6, hits: ["l:1150"], strong: true, loud: ["l:1150"] }, { id: "0002", p: 0.9 }],
    "loud：按「老毛病」贴出去的那几条（strength.dailyMax 按它数）");
});

test("工作单：开始做时提过、没翻就做完了（ada 11-04 先翻笔记）——普通联想挂过页、从开始到做完一页没翻的才列；强联想挂上的不算；翻了哪页都算翻过", async () => {
  const { db, run, open } = wlEnv();
  const shelf = shelfOf(cp(1, { title: "爆款和科普" }), cp(2, { title: "学习的规矩" }));
  const task = (topic: string, s: string, e: string) => Number(run("INSERT INTO tasks (topic, owner, state, started, ended) VALUES (?, 'main', 'done', ?, ?)", topic, SH(WDAY, s), SH(WDAY, e)).lastInsertRowid);
  const onIt = (id: number, at: string, mounted: Array<{ id: string; strong?: boolean; hits?: string[]; loud?: string[]; carry?: boolean }>) =>
    run("INSERT INTO learn_assoc (at, region, binding, topic, task_id, candidates, mounted, shadow, skipped, ms, tokens) VALUES (?, 'main', 'on_it', 'x', ?, 3, ?, 0, NULL, 5, 10)",
      SH(WDAY, at), id, JSON.stringify(mounted.map((m) => ({ ...m, p: 0.95 }))));
  const a = task("做一分钟片", "09:00:00", "10:00:00"); onIt(a, "09:00:01", [{ id: "0001" }]);                 // 没翻：列
  const b = task("写口播", "11:00:00", "12:00:00"); onIt(b, "11:00:01", [{ id: "0001" }]); open(SH(WDAY, "11:10:00"), "0099");   // 翻了别的页：不列
  const c2 = task("配音", "13:00:00", "14:00:00"); onIt(c2, "13:00:01", [{ id: "0002", strong: true, hits: ["l:1"] }, { id: "0001", carry: true }]);   // 只有强联想挂的（老的行，没有 loud）和带过来的：不算提过
  task("闲聊", "15:00:00", "15:30:00");                                                                      // 没挂页：不算
  const d = task("剪片", "16:00:00", "17:00:00"); onIt(d, "16:00:01", [{ id: "0002", strong: true, hits: ["l:1"], loud: [] }]);   // 封顶以后没再贴出来的强教训页：算提过
  const e = task("投稿", "18:00:00", "19:00:00"); onIt(e, "18:00:01", [{ id: "0002", strong: true, hits: ["l:1"], loud: ["l:1"] }]);   // 贴在老毛病那块的：不算
  const f = task("改封面", "20:00:00", "21:00:00"); onIt(f, "20:00:01", [{ id: "0001" }]); open(SH(WDAY, "19:55:00"), "0001");   // 开始前 10 分钟内先读了：算翻过
  const body = section(await wl(db, shelf), "开始做时提过、没翻就做完了");
  assert.equal(body, ["（这一天做完的事里，开始时提过笔记的 4 件，没翻就做完的 2 件）", `- 「做一分钟片」（编号 ${a}）：开始时提过「爆款和科普」，做完一页都没翻`, `- 「剪片」（编号 ${d}）：开始时提过「学习的规矩」，做完一页都没翻`].join("\n"));
  assert.ok(e > 0);
});

// ---------- 11-05：联想多记两样、同一件事接着做 ----------

test("联想多记两样（ada 11-05）：asked 记每题的概率（不到 0.05 的、纠正题不记，留三位），开始做的那行存话题向量", async () => {
  const a = await associator([cp(1), cp(2), cp(3)], { probs: { "0001": 0.95123, "0002": 0.3, "0003": 0.04, correction: 0.8 } });
  await a.notes.associate("写稿 v1", { region: "side-1", binding: "on_it", taskId: 1 });
  await a.notes.associate("这段没写清楚", { region: "main", binding: "wake", extra: [{ name: "correction", text: "是在纠正她吗" }] });
  await a.notes.associate("好的👌", { region: "main", binding: "wake" });
  const [onIt, wake, low] = a.cols();
  assert.deepEqual(JSON.parse(onIt!.asked!), { "0001": 0.951, "0002": 0.3 });
  assert.equal(onIt!.vec!.byteLength, 512 * 4);
  const v = new Float32Array(onIt!.vec!.buffer.slice(onIt!.vec!.byteOffset, onIt!.vec!.byteOffset + onIt!.vec!.byteLength));
  assert.deepEqual([v[0], v[1]], [1, 0], "存的就是话题向量");
  assert.deepEqual(JSON.parse(wake!.asked!), { "0001": 0.951, "0002": 0.3 }, "纠正题不记进 asked");
  assert.equal(wake!.vec, null, "只有开始做的行存向量");
  assert.equal(low!.asked, null, "没判断的是 null");
});

test("同一件事接着做（ada 11-05）：开始做时话题够像的上一件事，那时她在那个脑区翻过的页直接带上、不问判断；默认不带", async () => {
  const a = await associator([cp(1), cp(2), cp(3), cp(4), cp(5), cp(6)], { probs: { "0001": 0.95 } });
  const t0 = a.now();
  // 上一件事：任务 1 在 side-1 做了十分钟。期间翻了 0004、0001、0005；别的脑区翻的 0003、做完以后才翻的 0006 不算
  a.db.prepare("INSERT INTO tasks (id, topic, owner, state, started, ended) VALUES (1, 'Astra 写稿 v6', 'side-1', 'done', ?, ?)").run(t0, t0 + 600_000);
  await a.notes.associate("Astra 写稿 v6", { region: "side-1", binding: "on_it", taskId: 1 });
  for (const [dt, region, id] of [[1000, "side-1", "0004"], [2000, "side-1", "0001"], [3000, "side-1", "0005"], [4000, "side-2", "0003"], [700_000, "side-1", "0006"]] as const) {
    a.db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, ?, ?, NULL)").run(t0 + dt, region, id);
  }
  a.tick(3_600_000);

  const off = await a.notes.associate("Astra 改稿 v7", { region: "side-2", binding: "on_it", taskId: 2 });
  assert.deepEqual(off.pages, [{ id: "0001", p: 0.95 }], "默认（assoc.carryCos 1.01）不带");

  setParam(a.db, "assoc.carryCos", 0.9, { why: "测", by: "t", now: 0 });
  const calls = a.calls.length;
  const r = await a.notes.associate("Astra 改稿 v7 再改", { region: "side-3", binding: "on_it", taskId: 3 });
  assert.deepEqual(r.pages, [{ id: "0001", p: 0.95 }, { id: "0004", p: 1, carry: true }, { id: "0005", p: 1, carry: true }],
    "判断挑上的 0001 不重复带；任务 2 没有任务记录、不算");
  assert.equal(r.text, [
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
    "· 本 · p1：简介1（skills/做事/本/p1.md）",
    "上次做「Astra 写稿 v6」时翻过：",
    "· 本 · p4：简介4（skills/做事/本/p4.md）",
    "· 本 · p5：简介5（skills/做事/本/p5.md）",
  ].join("\n"));
  assert.equal(a.calls.length, calls + 1, "带上的页不另问判断");
  assert.equal(a.rows().at(-1)!.mounted, JSON.stringify([{ id: "0001", p: 0.95 }, { id: "0004", p: 1, carry: true }, { id: "0005", p: 1, carry: true }]));
  // 同一个脑区接着又开始一件：刚挂过的（还在眼前）不再带
  const again = await a.notes.associate("Astra 改稿 v7 第三遍", { region: "side-3", binding: "on_it", taskId: 4 });
  assert.ok(!again.pages.some((x) => x.carry), "刚挂过的不再带");

  // 一判断一页都没过也带
  a.probs["0001"] = 0;
  setParam(a.db, "assoc.carryMax", 1, { why: "测", by: "t", now: 0 });
  const one = await a.notes.associate("Astra 改稿 v8", { region: "side-4", binding: "on_it", taskId: 5 });
  assert.deepEqual(one.pages, [{ id: "0004", p: 1, carry: true }], "最多 carryMax 页；判断一页没挑上也带");
  assert.equal(a.rows().at(-1)!.skipped, null);

  // 话题不像的不带
  a.setVec(async () => { const v = new Float32Array(512); v[1] = 1; return v; });
  const other = await a.notes.associate("给小贝挑歌", { region: "side-5", binding: "on_it", taskId: 6 });
  assert.deepEqual(other.pages, []);
  assert.equal(a.rows().at(-1)!.skipped, "nothing");

  // 太久以前的不带（assoc.carryDays 7）
  a.setVec(async () => E0);
  a.tick(8 * 86_400_000);
  const old = await a.notes.associate("Astra 改稿 v9", { region: "side-6", binding: "on_it", taskId: 7 });
  assert.ok(!old.pages.some((x) => x.carry));
});

test("同一件事接着做：只在开始做时带；先算不挂的，贴的那一刻这期间挂上的去掉", async () => {
  const a = await associator([cp(1), cp(4), cp(5)], { probs: { "0001": 0.95 } });
  const t0 = a.now();
  a.db.prepare("INSERT INTO tasks (id, topic, owner, state, started, ended) VALUES (1, '写稿', 'side-1', 'done', ?, NULL)").run(t0);
  await a.notes.associate("写稿", { region: "side-1", binding: "on_it", taskId: 1 });
  a.db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'side-1', '0004', NULL), (?, 'side-1', '0005', NULL)").run(t0 + 1000, t0 + 2000);
  a.tick(60_000);
  setParam(a.db, "assoc.carryCos", 0.9, { why: "测", by: "t", now: 0 });
  const mid = await a.notes.associate("改稿中途", { region: "side-2", binding: "midwork" });
  assert.ok(!mid.pages.some((x) => x.carry), "干活途中不带");
  const held = await a.notes.associate("改稿", { region: "side-3", binding: "on_it", taskId: 2, hold: true });
  assert.deepEqual(held.pages.map((x) => x.id), ["0001", "0004", "0005"], "没做完的那件事，翻到现在的都算");
  await a.notes.associate("别的事", { region: "side-3", binding: "wake" });   // 这期间叫醒挂上了 0001（0004、0005 判断没挑）
  const got = held.confirm!();
  assert.deepEqual(got.pages.map((x) => [x.id, x.carry ?? false]), [["0004", true], ["0005", true]]);
});

test("同一件事接着做：几件事各带几页时按是哪件事翻的分开写；归档的、书架上没了的不带；翻的时候的旧编号按别名认", async () => {
  const a = await associator([cp(1), cp(4), cp(5), cp(6), cp(7, { archived: true })], { probs: {} });
  const t0 = a.now();
  const task = (id: number, topic: string, owner: string, opens: Array<[number, string]>, v: Float32Array) => async () => {
    a.db.prepare("INSERT INTO tasks (id, topic, owner, state, started, ended) VALUES (?, ?, ?, 'done', ?, ?)").run(id, topic, owner, a.now(), a.now() + 600_000);
    a.setVec(async () => v);
    await a.notes.associate(topic, { region: owner, binding: "on_it", taskId: id });
    for (const [dt, pg] of opens) a.db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, ?, ?, NULL)").run(a.now() + dt, owner, pg);
    a.tick(3_600_000);
  };
  const u = (x: number) => { const v = new Float32Array(512); v[0] = x; v[1] = Math.sqrt(1 - x * x); return v; };
  // 最像的那件（余弦 0.98）翻过 0004 和归档的 0007；次像的（0.95）翻过 0005、0099（书架上没有）、0004（前一件带过了）和 0066（是 0006 的旧编号）
  await task(1, "改稿 v6", "side-1", [[1000, "0004"], [2000, "0007"]], u(0.98))();
  await task(2, "写稿 v5", "side-2", [[1000, "0005"], [1500, "0099"], [2000, "0004"], [3000, "0066"]], u(0.95))();
  a.db.prepare("INSERT INTO learn_alias (alias, id, at) VALUES ('0066', '0006', ?)").run(t0);
  setParam(a.db, "assoc.carryCos", 0.9, { why: "测", by: "t", now: 0 });
  a.setVec(async () => E0);
  const r = await a.notes.associate("改稿 v7", { region: "side-3", binding: "on_it", taskId: 3 });
  assert.deepEqual(r.pages.map((x) => [x.id, x.p, x.carry]), [["0004", 0.98, true], ["0005", 0.95, true], ["0006", 0.95, true]]);
  assert.equal(r.text, [
    "这件事以前做过类似的，动手前先翻开这几页（联想不一定准，翻开核一下）：",
    "上次做「改稿 v6」时翻过：",
    "· 本 · p4：简介4（skills/做事/本/p4.md）",
    "上次做「写稿 v5」时翻过：",
    "· 本 · p5：简介5（skills/做事/本/p5.md）",
    "· 本 · p6：简介6（skills/做事/本/p6.md）",
  ].join("\n"));
});

// ---------- 笔记分层和连线（#0058；低的沉到深层、不消失；页之间有链接） ----------
const DAY_MS = 86_400_000;
const LC = { deepDays: 30, graceDays: 14, shallowOpens: 4 };

test("分层：重要的页永远不进深层（硬规矩）；不重要的 30 天没翻沉到深层，常翻的在浅层，从没翻过的有宽限", () => {
  const now = Date.parse("2026-12-15T12:00:00Z");
  const ago = (d: number) => now - d * DAY_MS;
  for (const importance of [4, 5]) {
    for (const use of [{ opens: 0, lastOpen: null, firstSeen: ago(400) }, { opens: 0, lastOpen: ago(300), firstSeen: ago(400) }, { opens: 0, lastOpen: null, firstSeen: null }]) {
      assert.equal(layerOf(importance, use, now, LC).layer, "shallow", `重要度 ${importance} 多久没翻都不沉`);
    }
  }
  assert.equal(layerOf(3, { opens: 0, lastOpen: ago(31), firstSeen: ago(100) }, now, LC).layer, "deep");
  assert.equal(layerOf(3, { opens: 0, lastOpen: ago(29), firstSeen: ago(100) }, now, LC).layer, "mid");
  assert.equal(layerOf(3, { opens: 4, lastOpen: ago(1), firstSeen: ago(100) }, now, LC).layer, "shallow", "常翻的");
  assert.deepEqual(layerOf(2, { opens: 0, lastOpen: null, firstSeen: ago(43) }, now, LC), { layer: "mid", days: 29, never: true, important: false }, "从没翻过：扫到以后宽限 14 天再起算");
  assert.equal(layerOf(2, { opens: 0, lastOpen: null, firstSeen: ago(45) }, now, LC).layer, "deep");
});

test("分层：重要度看她的数据（页开头写的、常驻、教训强度、规矩文件点名的记号）；规矩文件缺了、坏了看得见，代码里不带名字", () => {
  const rules = { importantMarks: ["师傅教的"], importanceKey: "重要度" };
  const pg = (lessons: Lesson[] = []) => ({ ...cp(1), lessons });
  const l = (id: string, strength?: number): Lesson => ({ ...lesson(1), ids: [id], ...(strength === undefined ? {} : { strength }) });
  assert.equal(importanceOf(pg(), "# 页\n简介：x\n", rules, new Set()), 3);
  assert.equal(importanceOf(pg(), "# 页\n- 做法（师傅教的）\n", rules, new Set()), 4);
  assert.equal(importanceOf(pg(), "# 页\n- 做法（师傅教的）\n", { ...rules, importantMarks: [] }, new Set()), 3, "没点名的记号不认");
  assert.equal(importanceOf(pg([l("0009", 4)]), "# 页\n", rules, new Set()), 4);
  assert.equal(importanceOf(pg([l("0009")]), "# 页\n", rules, new Set(["0009"])), 5, "有教训在常驻");
  assert.equal(importanceOf(pg([l("0009", 5)]), "---\n重要度: 1\n---\n# 页\n", rules, new Set(["0009"])), 1, "页里自己写的优先");
  assert.equal(statedImportance("# 页\n简介：x\n重要度：5\n", "重要度"), 5);
  assert.equal(statedImportance("# 页\nimportance: 2\n", "重要度"), null);
  const root = makeShelf({ "做事/剪辑/SKILL.md": COVER });
  try {
    const none = readShelfRules(root);
    assert.deepEqual(none.rules, { importantMarks: [], importanceKey: "importance" });
    assert.match(none.problem!, /shelf\.json 没有或读不了/);
    writeFileSync(join(root, "shelf.json"), "{坏的");
    assert.match(readShelfRules(root).problem!, /读不懂/);
    writeFileSync(join(root, "规矩.json"), JSON.stringify({ importantMarks: ["师傅教的", 3, ""], importanceKey: "重要度" }));
    assert.deepEqual(readShelfRules(root, "规矩.json"), { rules, problem: null });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("分层的夜里那一步：不挪、不删任何页；记下各页的层，报告列今晚沉到深层的和重要但很久没翻的，第二晚不重复列", () => {
  const now = Date.now();
  const root = makeShelf({
    "做事/剪辑/SKILL.md": COVER,
    "做事/剪辑/二.md": page("二", [], " <!-- p:0002 -->"),
    "做事/剪辑/三.md": page("三", [], " <!-- p:0003 -->"),
    "做事/剪辑/五.md": page("五", ["甲 <!-- l:0015 -->"], " <!-- p:0005 -->"),
    "做事/剪辑/六.md": page("六", ["师傅教的：乙"], " <!-- p:0006 -->"),
    "常驻.md": "- 甲 <!-- l:0015 -->\n",
    "shelf.json": JSON.stringify({ importantMarks: ["师傅教的"] }),
  });
  try {
    const db = openDb(":memory:");
    for (const id of ["0002", "0003", "0005", "0006"]) {
      db.prepare("INSERT INTO learn_item (id, kind, rel, hash, first_seen, last_seen, gone) VALUES (?, 'page', 'x', 'h', ?, ?, NULL)").run(id, now - 90 * DAY_MS, now);
    }
    db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'r', '0002', NULL)").run(now - 40 * DAY_MS);
    db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, 'r', '0003', NULL)").run(now - 2 * DAY_MS);
    const before = readdirSync(join(root, "做事/剪辑")).sort();
    const r = curateShelf(db, root, GEN, now, { archiveDir: ARCH, residentFile: RES_FILE });
    assert.deepEqual(readdirSync(join(root, "做事/剪辑")).sort(), before, "一页都没挪");
    assert.deepEqual(Object.fromEntries(r.pages.map((p) => [p.id, p.layer])), { "0002": "deep", "0003": "mid", "0005": "shallow", "0006": "shallow" });
    assert.deepEqual([...savedLayers(db)].sort(), [["0002", "deep"], ["0003", "mid"], ["0005", "shallow"], ["0006", "shallow"]]);
    assert.match(r.text, /^## 笔记分层（浅 2 页、中 1 页、深 1 页）\n### 今晚沉到深层的页（不挪、不删；现在只是记下层，联想照旧会带它[^\n]*\n- 做事\/剪辑\/二\.md：40 天没翻，重要度 3\n/);
    assert.match(r.text, /### 重要、但很久没翻的页[^\n]*\n- 做事\/剪辑\/五\.md：从没翻过（算上宽限 76 天），重要度 5\n- 做事\/剪辑\/六\.md：从没翻过（算上宽限 76 天），重要度 4$/);
    assert.equal(r.problem, null);
    assert.doesNotMatch(curateShelf(db, root, GEN, now + DAY_MS, { archiveDir: ARCH, residentFile: RES_FILE }).text, /今晚沉到深层/, "昨晚就在深层的不再列");
    rmSync(join(root, "shelf.json"));
    const r2 = curateShelf(db, root, GEN, now, { archiveDir: ARCH, residentFile: RES_FILE });
    assert.match(r2.text, /shelf\.json 没有或读不了/, "规矩文件没了：报告里看得见");
    assert.equal(r2.pages.find((p) => p.id === "0006")!.layer, "deep", "没有记号了就不算重要（不退回写死的字）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("连线：页里提到别的页（[[链接]]、markdown 链接、反引号路径、正文里的文件名）认成线；同名不止一页的只认路径；归档的不连", () => {
  const pages = [
    cp(1, { rel: "做事/剪辑/看成片.md", title: "看成片" }), cp(2, { rel: "做事/剪辑/配音.md", title: "配音怎么做" }),
    cp(3, { rel: "做事/投稿/流程.md", title: "投稿流程" }), cp(4, { rel: "电脑/mac/流程.md", title: "装机流程" }),
    cp(5, { rel: "做事/剪辑/归档/旧.md", title: "旧", archived: true }),
  ];
  const texts: Record<string, string> = {
    "做事/剪辑/看成片.md": "先看 [[配音怎么做]]，再看 [[配音|配音那页]]；投稿照 `skills/做事/投稿/流程.md`；流程.md 有两页，不猜；旧.md 归档了；自己 看成片.md 不算",
    "做事/剪辑/配音.md": "回头 [看成片](../剪辑/看成片.md)",
    "做事/投稿/流程.md": "装机见 电脑/mac/流程.md；Obsidian 的写法 [[做事/剪辑/配音]]；别处的同名文件 notes/看成片.md、sleep/2026-11-10/配音.md 不是书架上的页",
  };
  const links = refLinks(shelfOf(...pages), (rel) => texts[rel] ?? null).map((l) => [l.a, l.b, l.n]);
  assert.deepEqual(links, [["0001", "0002", 2], ["0001", "0003", 1], ["0002", "0001", 1], ["0003", "0002", 1], ["0003", "0004", 1]]);
  const ix = pageIndex(shelfOf(...pages));
  assert.equal(ix.resolve("做事/投稿/流程")?.ids[0], "0003", "写了路径、没写 .md 也认");
  assert.equal(ix.resolve("流程"), null, "同名两页、没写路径：不猜");
  assert.equal(ix.resolve("notes/看成片.md"), null, "路径对不上书架：不按文件名猜");
  // 一长串没有 .md 的字（图片的 base64）不拖慢：只从头起一次
  const t0 = Date.now();
  assert.deepEqual(refLinks(shelfOf(...pages), (rel) => (rel === "做事/剪辑/看成片.md" ? `data:image/png;base64,${"A".repeat(300_000)} 配音.md` : null)).map((l) => [l.a, l.b]), [["0001", "0002"]]);
  assert.ok(Date.now() - t0 < 10_000, "30 万字的一串十秒内扫完（防的是平方级的退化，那样要几分钟；机器忙时墙钟会慢，别卡太紧）");
});

test("连线：同一件事里一起翻过的两页连上，越久以前越轻；事件的经过里写到的几页连上；存进 learn_link 整张重算；links / near 查得到", () => {
  const db = openDb(":memory:");
  const now = Date.parse("2026-12-15T12:00:00Z");
  const shelf = shelfOf(cp(1), cp(2), cp(3), cp(4));
  const task = db.prepare("INSERT INTO tasks (id, topic, owner, state, started, ended) VALUES (?, 't', ?, 'done', ?, ?)");
  const open = db.prepare("INSERT INTO learn_open (at, region, page_id, book) VALUES (?, ?, ?, NULL)");
  task.run(1, "side-1", now - 3600_000, now - 1800_000);
  for (const id of ["0001", "0002", "0001"]) open.run(now - 3000_000, "side-1", id);
  open.run(now - 3000_000, "side-2", "0003");                       // 别的脑区翻的不算
  task.run(2, "side-1", now - 30 * DAY_MS, now - 30 * DAY_MS + 3600_000);
  for (const id of ["0001", "0002", "0003"]) open.run(now - 30 * DAY_MS + 60_000, "side-1", id);
  const co = coLinks(db, shelf, now).map((l) => [l.a, l.b, l.n, l.weight]);
  assert.deepEqual(co, [["0001", "0002", 2, 1.499], ["0001", "0003", 1, 0.5], ["0002", "0003", 1, 0.5]], "一小时前那次算 0.999，30 天前那次算 0.5");
  db.prepare("INSERT INTO mem_event (id, title, summary, gist, status, importance, created_at, updated_at) VALUES ('e0001', 't', 's', 'g', 'ongoing', 3, 0, 0)").run();
  const entry = db.prepare("INSERT INTO mem_entry (id, event_id, at, kind, full, gist, title, source, created_at) VALUES (?, 'e0001', 0, 'fact', ?, 'g', 't', ?, 0)");
  entry.run("n0001", "照 p3.md 做的", "[]");
  entry.run("n0002", "又查了一遍", JSON.stringify(["skills/做事/本/p4.md"]));
  assert.deepEqual(eventLinks(db, shelf).map((l) => [l.a, l.b, l.kind]), [["0003", "0004", "event"]]);
  // 还没做完的事（ended 空）按开始以后三小时算；旧编号按别名认；一件事里列了一大串页的（搬家清单）不连
  task.run(3, "side-3", now - 7200_000, null);
  db.prepare("INSERT INTO learn_alias (alias, id, at) VALUES ('0099', '0004', 0)").run();
  for (const id of ["0003", "0099"]) open.run(now - 3600_000, "side-3", id);
  assert.ok(coLinks(db, shelf, now).some((l) => l.a === "0003" && l.b === "0004" && l.n === 1));
  db.prepare("DELETE FROM tasks WHERE id = 3").run();
  // 一件事开了一整天：早上翻的和夜里翻的不连，挨着翻的才连；一页在两头都翻过，各连各的（11-14 两件事把一整天翻的 22 页全连上了）
  task.run(4, "side-4", now - 20 * 3600_000, now - 60_000);
  open.run(now - 19 * 3600_000, "side-4", "0001");
  open.run(now - 19 * 3600_000 + 59 * 60_000, "side-4", "0003");
  open.run(now - 19 * 3600_000 + 59 * 60_000 + 61 * 60_000, "side-4", "0004");
  open.run(now - 2 * 3600_000, "side-4", "0001");
  open.run(now - 2 * 3600_000 + 60_000, "side-4", "0004");
  const day = coLinks(db, shelf, now).filter((l) => !(l.a === "0001" && l.b === "0002")).map((l) => [l.a, l.b, l.n]);
  assert.deepEqual(day, [["0001", "0003", 2], ["0002", "0003", 1], ["0001", "0004", 1]], "0001~0003 隔 59 分钟连上；0003~0004 隔 61 分钟不连；0001~0004 靠夜里那两次连上，只算一次");
  setParam(db, "links.coGapMin", 120, { why: "测试", by: "test", now });
  assert.ok(coLinks(db, shelf, now).some((l) => l.a === "0003" && l.b === "0004"), "放宽到两小时，0003~0004 连上");
  setParam(db, "links.coGapMin", 60, { why: "测试", by: "test", now });
  db.prepare("DELETE FROM tasks WHERE id = 4").run();
  db.prepare("DELETE FROM learn_open WHERE region = 'side-4'").run();
  const many = shelfOf(...[1, 2, 3, 4, 5, 6, 7].map((i) => cp(i)));
  db.prepare("INSERT INTO mem_event (id, title, summary, gist, status, importance, created_at, updated_at) VALUES ('e0002', 't', 's', 'g', 'ongoing', 3, 0, 0)").run();
  db.prepare("INSERT INTO mem_entry (id, event_id, at, kind, full, gist, title, source, created_at) VALUES ('n0003', 'e0002', 0, 'fact', ?, 'g', 't', '[]', 0)").run("搬了 p1.md p2.md p3.md p4.md p5.md p6.md p7.md");
  assert.deepEqual(eventLinks(db, many).map((l) => [l.a, l.b]), [["0003", "0004"]], "列了 7 页的那件事不连");
  db.prepare("DELETE FROM mem_entry WHERE id = 'n0003'").run();
  const n = rebuildLinks(db, shelf, (rel) => (rel === "做事/本/p4.md" ? "见 p1.md" : null), now);
  assert.deepEqual(n, { ref: 1, co: 3, event: 1 });
  assert.deepEqual(rebuildLinks(db, shelf, () => null, now, { refOnly: true }), { ref: 0, co: 0, event: 0 });
  assert.equal(linksOf(db, "0001").length, 2, "只重算页里提到的：一起翻过的还在");
  rebuildLinks(db, shelf, (rel) => (rel === "做事/本/p4.md" ? "见 p1.md" : null), now);
  assert.deepEqual(neighbors(db, "0001", 5).map((x) => [x.id, x.kinds]), [["0002", ["co"]], ["0004", ["ref"]], ["0003", ["co"]]]);
  assert.deepEqual(neighbors(db, "0001", 5, new Set(["0002"])).map((x) => x.id), ["0004", "0003"]);
  assert.deepEqual(neighbors(db, "0003", 1).map((x) => x.id), ["0004"], "同一件事里写到的（0.6）比 30 天前一起翻过一次的（0.4）近");
});

test("hh learn links / near / graph：按编号、文件名、标题找页；列出连着的页、最近的几页、整张图（--json 给点和线）", async () => {
  const root = makeShelf({
    "做事/剪辑/SKILL.md": COVER,
    "做事/剪辑/看成片.md": page("看成片", [], " <!-- p:0001 -->") + "\n配音见 [[配音]]\n",
    "做事/剪辑/配音.md": page("配音怎么做", [], " <!-- p:0002 -->"),
    "做事/剪辑/投稿.md": page("投稿", [], " <!-- p:0003 -->"),
  });
  try {
    const db = openDb(":memory:");
    const shelf = scanShelf(root, GEN, ARCH);
    rebuildLinks(db, shelf, (rel) => read(root, rel), 0);
    db.prepare("INSERT INTO learn_link (a, b, kind, weight, n, updated) VALUES ('0001', '0003', 'co', 2, 2, 0)").run();
    const rt = { db, shelf: () => shelf } as unknown as LearningRuntime;
    const env = { cfg: { ...testConfig().learning, enabled: true, root }, tz: "UTC", now: () => Date.now() };
    const cmd = (action: string, ...args: string[]) => learnCommand(rt, action, args, env) as Promise<string>;
    assert.equal(await cmd("links", "看成片"), [
      "看成片（0001，做事/剪辑/看成片.md）",
      "— 投稿（0003，做事/剪辑/投稿.md）｜一起翻过 2 次",
      "→ 配音怎么做（0002，做事/剪辑/配音.md）｜页里提到",
    ].join("\n"));
    assert.match(await cmd("links", "0002"), /← 看成片（0001/);
    assert.equal(await cmd("links", "投稿.md"), "投稿（0003，做事/剪辑/投稿.md）\n— 看成片（0001，做事/剪辑/看成片.md）｜一起翻过 2 次");
    assert.equal(await cmd("near", "p:0001", "-n", "1"), "看成片（0001，做事/剪辑/看成片.md）\n- 投稿（0003，做事/剪辑/投稿.md）｜一起翻过");
    await assert.rejects(cmd("near", "没有这页"), /找不到这一页/);
    await assert.rejects(cmd("links"), /用法/);
    const g = JSON.parse(await cmd("graph", "--json")) as { nodes: Array<{ id: string; layer: string; category?: unknown; book?: unknown; rel: string }>; links: Array<{ a: string; b: string; kind: string }> };
    assert.deepEqual(g.nodes.map((x) => x.id).sort(), ["0001", "0002", "0003"]);
    assert.ok(g.nodes.every((x) => typeof x.category === "string" && x.category !== "" && x.rel.startsWith(`${x.category}/`) && typeof x.book === "string"), "点带大类和本（控制台按大类聚）");
    assert.deepEqual(g.links.map((l) => [l.a, l.b, l.kind]), [["0001", "0003", "co"], ["0001", "0002", "ref"]]);
    assert.match(await cmd("graph"), /^3 页：浅 0、中 3、深 0；2 条线，没有线的页 0 页/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 11-12：记分认带说明的日期、强教训贴够了降成普通、纠正没落到笔记上的列出来 ----------

test("教训的「犯的日子」：日期后面带括号说明（说明里有逗号、顿号）也只认出日期；以前整串当日子，又犯就记不上", () => {
  const l = parsePage([
    "# 页", "## 教训",
    "- 教训：钟点没核就写｜下次：先跑 date｜犯的日子：2026-10-29、2026-11-04（调研样本文件凭感觉写了一个半小时后的钟点）、2026-11-10（fermat 大纲头写 08:1x，跑 date 才是 07:50；当场改了、下次先跑）｜强度：5 <!-- l:0112 -->",
    "- 教训：乙｜犯的日子：2026-11-01, 2026-11-02 (补记)，待定 <!-- l:0113 -->",
  ].join("\n"), "a/b/c.md", "通用", ARCH).lessons;
  assert.deepEqual(l[0]!.days, ["2026-10-29", "2026-11-04", "2026-11-10"]);
  assert.equal(l[0]!.strength, 5, "后面的字段照认");
  assert.deepEqual(l[1]!.days, ["2026-11-01", "2026-11-02", "待定"], "不是日期的原样留着（validDay 会滤掉）");
});

test("强教训贴成墙纸（11-12：l:0112 九天贴了 425 次照样又犯）：同一条 24 小时里按强联想贴够 strength.dailyMax 次，之后要过普通门槛才贴、不再进「老毛病」；发之前那道核对不算；按话题挂页不变", async () => {
  const strong = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: STRONG_PAGE(1).lessons };
  const a = await associator([strong, cp(2)], { probs: { "0002": 0.9, "l:1150": 0.6 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试：只看强的", by: "t", now: 1 });
  setParam(a.db, "strength.dailyMax", 2, { why: "测试", by: "t", now: 1 });
  setParam(a.db, "strength.strongRemountTokens", 0, { why: "测试：每次都能再挂", by: "t", now: 1 });
  const ask = (topic: string, region: string, binding: "wake" | "handover" = "wake") => a.notes.associate(topic, { region, binding });
  const loud = (r: Awaited<ReturnType<typeof ask>>) => r.text.startsWith("⚠️");
  assert.ok(loud(await ask("话题一", "r1")));
  assert.ok(loud(await ask("话题二", "r2")));
  const third = await ask("话题三", "r3");
  assert.ok(!loud(third), "贴够两次：0.6 过不了普通门槛（0.7），不贴");
  assert.deepEqual(third.pages, [{ id: "0002", p: 0.9 }], "按话题对得上的页照挂");
  assert.ok(a.calls.at(-1)!.qs.some((q) => q.name === "l:1150"), "题照问（概率照记，以后好算）");
  a.probs["l:1150"] = 0.95;
  const fourth = await ask("话题四", "r4");
  assert.deepEqual(fourth.pages.map((x) => [x.id, x.strong ?? false, x.hits?.map((h) => [h.id, h.strong])]), [["0002", false, undefined], ["0001", false, [["l:1150", false]]]],
    "真对得上（0.95）：照贴，但不单列；它那一页排在按话题挂的页后面");
  assert.ok(!loud(fourth));
  a.probs["l:1150"] = 0.6;
  // 过了 24 小时重新算
  a.tick(25 * 3600_000);
  assert.ok(loud(await ask("话题五", "r5")));
  // 0 = 不限
  setParam(a.db, "strength.dailyMax", 0, { why: "测试", by: "t", now: 2 });
  for (const r of ["r6", "r7", "r8"]) assert.ok(loud(await ask(`话题${r}`, r)));
});

test("强教训贴够了也不挤别的（ada 11-12 硬要求：按说的话联想不能变弱）：不占普通条目的名额，它那一页不占 maxPages；同页另一条强的贴出去不算它的次数", async () => {
  const pg = parsePage([
    "# 验收和核实 <!-- p:0001 -->", "简介：a", "什么时候翻：b", "", "## 教训",
    "- 教训：强甲｜什么时候：x｜下次：做甲｜强度：5 <!-- l:1201 -->",
    "- 教训：强乙｜什么时候：x｜下次：做乙｜强度：4 <!-- l:1202 -->",
    "- 教训：普通一｜下次：照做一 <!-- l:1203 -->",
    "- 教训：普通二｜下次：照做二 <!-- l:1204 -->",
  ].join("\n"), "做事/本/p1.md", "通用", ARCH);
  const page = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: pg.lessons };
  const probs = { "l:1201": 0.96, "l:1202": 0.2, "l:1203": 0.94, "l:1204": 0.92, "0002": 0.97, "0003": 0.95, "0004": 0.92 };
  const mk = async (max: number) => {
    const a = await associator([page, cp(2), cp(3), cp(4)], { probs: { ...probs } });
    setParam(a.db, "strength.dailyMax", max, { why: "测试", by: "t", now: 1 });
    setParam(a.db, "strength.strongRemountTokens", 0, { why: "测试", by: "t", now: 1 });
    return a;
  };
  const shape = (r: { pages: Array<{ id: string; hits?: Array<{ id: string }> }> }) => r.pages.map((x) => [x.id, (x.hits ?? []).map((h) => h.id).sort()]);
  // 不封顶时的样子
  const off = await mk(0);
  const before = await off.notes.associate("话题", { region: "r1", binding: "wake" });
  assert.deepEqual(shape(before), [["0001", ["l:1201", "l:1203", "l:1204"]], ["0002", []], ["0003", []], ["0004", []]]);
  // 封顶 1：第二次起 l:1201 贴够了
  const a = await mk(1);
  await a.notes.associate("话题一", { region: "r1", binding: "wake" });
  const capped = await a.notes.associate("话题二", { region: "r2", binding: "wake" });
  assert.deepEqual(shape(capped), [["0002", []], ["0003", []], ["0004", []], ["0001", ["l:1201", "l:1203", "l:1204"]]],
    "挂的页、贴的条目和不封顶时一样：两条普通的都在，三页按话题的都在，只是那一页挪到最后");
  assert.ok(!capped.text.startsWith("⚠️"), "不再单列成老毛病");
  assert.equal(JSON.parse(a.rows().at(-1)!.mounted).find((m: { id: string }) => m.id === "0001").strong, undefined, "记录里不算强的挂载");
  // 贴够了、这次又不够普通门槛（0.6 < 0.7）：那条不贴，别的照旧，页靠普通条目还挂着、照样不占名额
  a.probs["l:1201"] = 0.6;
  const weak = await a.notes.associate("话题三", { region: "r3", binding: "wake" });
  assert.deepEqual(shape(weak), [["0002", []], ["0003", []], ["0004", []], ["0001", ["l:1203", "l:1204"]]]);
  // 同页另一条强的按老毛病贴出去：只记它自己的次数，不算 l:1201 的（l:1201 当普通条目跟着出现也不算）
  const b = await mk(2);
  b.probs["l:1202"] = 0.9;
  b.db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, ms, tokens) VALUES (?, 'x', 'wake', 't', 1, ?, 0, 0, 0)")
    .run(b.now() - 1000, JSON.stringify([{ id: "0001", p: 0.9, hits: ["l:1201", "l:1202"], strong: true, loud: ["l:1202"] }]));
  b.db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, ms, tokens) VALUES (?, 'x', 'handover', 't', 1, ?, 0, 0, 0)")
    .run(b.now() - 1000, JSON.stringify([{ id: "0001", p: 0.9, hits: ["l:1201"], strong: true, loud: ["l:1201"] }]));
  b.db.prepare("INSERT INTO learn_assoc (at, region, binding, topic, candidates, mounted, shadow, ms, tokens) VALUES (?, 'x', 'wake', 't', 1, ?, 0, 0, 0)")
    .run(b.now() - 1000, JSON.stringify([{ id: "0001", p: 0.9, hits: ["l:1201"], strong: true, loud: ["l:1201"] }]));
  const r = await b.notes.associate("话题四", { region: "r4", binding: "wake" });
  assert.deepEqual(r.pages[0]!.hits!.filter((h) => h.strong).map((h) => h.id).sort(), ["l:1201", "l:1202"], "l:1201 只算贴过 1 次（发之前那次、当普通条目跟着的那次都不算），还没到 2");
});

test("教训的「犯的日子」：括号套着、没关上、全角半角混着的，说明里的日期都不算", () => {
  const days = (s: string) => parsePage(`# 页\n## 教训\n- 教训：甲｜犯的日子：${s} <!-- l:0001 -->\n`, "a/b/c.md", "通用", ARCH).lessons[0]!.days;
  assert.deepEqual(days("2026-11-04（a（b）c，2026-10-30 也是）、2026-11-05"), ["2026-11-04", "2026-11-05"]);
  assert.deepEqual(days("2026-11-04（a，2026-10-30)、2026-11-06"), ["2026-11-04", "2026-11-06"]);
  assert.deepEqual(days("2026-11-04（没关上，2026-10-30"), ["2026-11-04"]);
});

test("强教训贴够了：发给主人之前那道核对照旧按强的算（要拦的照拦）", async () => {
  const page = { ...cp(1, { rel: "做事/本/p1.md" }), lessons: SEND_PAGE.lessons };
  const a = await associator([page, cp(2)], { probs: { "l:1160": 0.6 } });
  setParam(a.db, "assoc.itemsK", 0, { why: "测试", by: "t", now: 1 });
  setParam(a.db, "strength.dailyMax", 1, { why: "测试", by: "t", now: 1 });
  setParam(a.db, "strength.strongRemountTokens", 0, { why: "测试", by: "t", now: 1 });
  setParam(a.db, "strength.handRemountTokens", 0, { why: "测试", by: "t", now: 1 });
  assert.ok((await a.notes.associate("话题一", { region: "r1", binding: "wake" })).pages[0]?.strong);
  assert.deepEqual((await a.notes.associate("话题二", { region: "r2", binding: "wake" })).pages, [], "叫醒：贴够了");
  const h = await a.notes.associate("要跟 ada 说：成片好了", { region: "r3", binding: "handover" });
  assert.deepEqual(h.pages.map((x) => [x.id, x.strong]), [["0001", true]], "发之前照拦");
});

test("工作单「今天 ada 的纠正」：前三天的纠正，消息编号在书架哪页都找不到的，列成「还没落到笔记上」；找得到的、今天的、更早的不列", async () => {
  const root = makeShelf({
    "做事/剪辑/SKILL.md": COVER,
    "做事/剪辑/二.md": page("二", ["甲｜出处：#5002"], " <!-- p:0002 -->") + "\n## 做法\n- 好坏例子（ada 11-01，#5003）\n",
  });
  try {
    const { db, run } = wlEnv();
    const corr = (day: string, hms: string, seq: number, topic: string) => run("INSERT INTO learn_correction (at, seq, topic, task_id, p) VALUES (?, ?, ?, NULL, 0.9)", SH(day, hms), seq, topic);
    corr("2026-10-31", "10:00:00", 5001, "开头不够抓人");
    corr("2026-10-31", "11:00:00", 5002, "落到教训出处上的");
    corr("2026-10-30", "11:00:00", 5003, "落到做法里的");
    corr("2026-10-27", "11:00:00", 5004, "太早的");
    corr(WDAY, "09:00:00", 5005, "今天的");
    const body = section(await wl(db, scanShelf(root, GEN, ARCH), { root }), "今天 ada 的纠正");
    assert.equal(body, ["- 09:00 #5005：今天的", "- 还没落到笔记上：10-31 10:00 #5001：开头不够抓人"].join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 主人的名字、书架目录、出处的记号都是参数 ----------

test("条目：主人的名字、书架目录、出处里留的记号都按给的来（换个主人、换个目录，字里就是新的）", () => {
  const md = "# p1\n## 做法\n- 先学成熟做法（阿青教的，10-25）\n";
  const page = cp(1, { lessons: [{ ...lesson(1), ids: ["0150"], text: "验小样只核了动没动（11-02 12:47 阿青「嘴是小红三角」）", next: "每个部件放大看", days: ["2026-11-02"] }] });
  const items = pageItems(page, md, { owner: "阿青", shelfDir: "notes", keep: ["阿青教的"] });
  assert.deepEqual(items.map((it) => [it.id, it.loud]), [
    ["l:0150", "每个部件放大看（上次：验小样只核了动没动；犯过 1 次，最近 11-02；阿青：「嘴是小红三角」）〔notes/做事/本/p1.md〕"],
    ["0001#1", "先学成熟做法（阿青教的）〔notes/做事/本/p1.md〕"],
  ]);
  assert.ok(!/ada|skills\//.test(JSON.stringify(items)), "字里没有别的主人、别的目录");
  // 没给记号：那个括号不是只有日期，原样留着
  assert.equal(pageItems(page, md, { owner: "阿青", shelfDir: "notes" })[1]!.line, "先学成熟做法（阿青教的，10-25）");
  assert.deepEqual(practiceHead(md, 3, ["没有的记号", "阿青教的", "阿青"]), ["先学成熟做法（阿青教的）"], "几个记号按顺序，先对上的算");
  // 换一个主人：那句原话不是他说的，不带
  assert.ok(!pageItems(page, md, { owner: "老林", shelfDir: "notes" })[0]!.loud.includes("：「"));
});

test("条目：主人的名字里有正则的特殊字符也照字面认，不抛；没有名字就不认原话", () => {
  const page = cp(1, { lessons: [
    { ...lesson(1), ids: ["0151"], text: "验收漏了，a.b(c 说「别这样」", next: "先核" },
    { ...lesson(2), ids: ["0152"], text: "axb(c 说「不该认」" },
  ] });
  const loud = (owner: string): string[] => pageItems(page, null, { owner, shelfDir: "notes" }).map((it) => it.loud);
  assert.deepEqual(loud("a.b(c"), [
    "先核（上次：验收漏了，a.b(c 说「别这样」；a.b(c：「别这样」）〔notes/做事/本/p1.md〕",
    "教训：axb(c 说「不该认」（上次：axb(c 说「不该认」）〔notes/做事/本/p1.md〕",
  ], "点和括号按字面：axb(c 不算这个主人");
  for (const owner of ["a.b(c", "[", "x+*?", "\\", "^$|{}"]) assert.doesNotThrow(() => loud(owner), owner);
  assert.ok(loud("").every((l) => !l.includes("：「")), "没有名字：哪句引号都不当主人的原话");
});

test("常驻单子、每周数字、工作单、联想挂的那一行：主人的名字和书架目录都按给的来", async () => {
  assert.equal(renderResident("- 一条\n", shelfOf(), 10, { shelfDir: "notes", residentFile: RES_FILE }), "# 常驻：我老犯的（每一轮都记着；单子在 notes/常驻.md，按最近最需要的自己换）\n- 一条");
  const w = { newLessons: 0, recurMounted: 0, recurUnmounted: 0, corrections: 2, mounts: 0, opened: 0, idleMounts: 0, promoted: 0, estimateRatio: null, replayPassRate: null };
  const week = renderWeekly(w, "阿青");
  assert.ok(week.includes("\n- 被 阿青 纠正：2 次\n"));
  assert.ok(!week.includes("ada"));

  const { db } = wlEnv();
  const shelf = shelfOf(wlPage(1, "看成片", { lessons: [wlLesson("0101", "老毛病", ["2026-10-28", "2026-10-30", "2026-11-01"])] }));
  const text = await worklist(db, shelf, WDAY, { now: WNOW, tz: RTZ, embedder: null, root: "/nonexistent", owner: "阿青", shelfDir: "notes", residentFile: RES_FILE });
  assert.equal(section(text, "今天 阿青 的纠正"), "（没有）");
  assert.match(section(text, "同一条犯了 3 天以上的"), /^- 老毛病（本 · 看成片，notes\/做事\/本\/p1\.md，l:0101）：犯了 3 天/);
  assert.ok(!/ada|skills\//.test(text), "工作单里没有别的主人、别的目录");

  const a = await associator([cp(1), cp(2)], { probs: { "0001": 0.9 }, shelfDir: "notes" });
  const r = await a.notes.associate("剪片子", { region: "main", binding: "wake" });
  assert.equal(r.text, "想起来的笔记（用得上就翻开）：\n· 本 · p1：简介1（notes/做事/本/p1.md）");
});

test("归档目录的名字、常驻单子的文件名都按配置来：换了名字，叫「归档」的目录就是个普通目录", async () => {
  const root = makeShelf({
    "通用/验收/SKILL.md": COVER,
    "通用/验收/一.md": page("一"),
    "通用/验收/old/旧.md": page("旧"),
    "通用/验收/归档/留着.md": page("留着"),
    "old/搬走.md": page("搬走"),
    "归档/本/SKILL.md": COVER,
    "归档/本/页.md": page("页"),
    "always.md": "# 单子\n- 丁那条 <!-- l:0034 -->\n",
  });
  try {
    const archived = (dir: string): Record<string, boolean> => Object.fromEntries(scanShelf(root, GEN, dir).pages.map((p) => [p.rel, p.archived]));
    // 归档目录叫 old：old/ 下的（书架那层、本里的）算归档；「归档」是个普通的大类，本里叫「归档」的子目录和别的子目录一样不是页
    assert.deepEqual(archived("old"), { "old/搬走.md": true, "归档/本/页.md": false, "通用/验收/一.md": false, "通用/验收/old/旧.md": true });
    assert.deepEqual(scanShelf(root, GEN, "old").books.map((b) => [b.category, b.book, b.pages]), [["归档", "本", 1], ["通用", "验收", 1]]);
    // 照中文包的默认名：反过来
    assert.deepEqual(archived(ARCH), { "归档/本/页.md": true, "通用/验收/一.md": false, "通用/验收/归档/留着.md": true });
    assert.equal(parsePage("# 页\n", "归档/本/页.md", GEN, "old").archived, false);
    assert.equal(parsePage("# 页\n", "归档/本/页.md", GEN, ARCH).archived, true);
    assert.equal(parsePage("# 页\n", "通用/验收/old/旧.md", GEN, "old").archived, true);

    // 常驻单子：开头那句写的是配置的文件名；工作单按配置的文件名读单子
    const mine = readFileSync(join(root, "always.md"), "utf8");
    assert.equal(renderResident(mine, shelfOf(), 10, { shelfDir: "notes", residentFile: "always.md" }),
      "# 常驻：我老犯的（每一轮都记着；单子在 notes/always.md，按最近最需要的自己换）\n- 丁那条");
    const shelf = shelfOf(wlPage(1, "看成片", { lessons: [wlLesson("0034", "丁常驻还犯", ["2026-11-01"])] }));
    const strength = async (residentFile: string): Promise<string> =>
      section(await worklist(wlEnv().db, shelf, WDAY, { now: WNOW, tz: RTZ, embedder: null, root, ...WHO, residentFile }), "强度（升降建议）");
    assert.match(await strength("always.md"), /- 丁常驻还犯（.*l:0034）：常驻着今天还犯了/);
    assert.doesNotMatch(await strength(RES_FILE), /常驻着今天还犯了/, "书架上没有叫这个名字的单子：这条不在常驻");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
