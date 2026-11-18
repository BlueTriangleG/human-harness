// 控制台扫书架：目录下的文件没变就不重读（src/console/shelf.ts）。右栏的学习和笔记页都从这里拿书架。
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openReadOnly } from "../src/console/data.ts";
import { learnView } from "../src/console/learn.ts";
import { notebookView } from "../src/console/notebook.ts";
import { shelfOf, shelfStamp } from "../src/console/shelf.ts";
import { scanShelf } from "../src/learning/notebook.ts";
import { buildDemo } from "./console-demo.ts";
import { TEST_ROLE } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";

const NOW = Date.UTC(2026, 10, 12, 3, 30);
const GENERAL = TEST_ROLE.learning.generalCategory;
const ARCHIVE = TEST_ROLE.learning.archiveDir;

function demo(): { dir: string; root: string } {
  const dir = tmpDir("hh-shelf-");
  buildDemo(dir, NOW, { tz: "Australia/Melbourne" });
  return { dir, root: join(dir, "ws", "skills") };
}

test("shelf: nothing changed on disk — the same scan is handed back, not read again; what it holds is what a fresh scan gives", () => {
  const { root } = demo();
  const first = shelfOf(root, GENERAL, ARCHIVE);
  assert.ok(first.pages.length >= 34);
  assert.deepEqual(first, scanShelf(root, GENERAL, ARCHIVE));
  assert.equal(shelfOf(root, GENERAL, ARCHIVE), first, "文件没变：就是上一次那一份");
  assert.equal(shelfStamp(root), shelfStamp(root));
  // 另一个「通用」大类名：各记各的
  assert.notEqual(shelfOf(root, GENERAL + "-x", ARCHIVE), first);
  assert.equal(shelfOf(root, GENERAL, ARCHIVE), first);
});

test("shelf: a page edited, added, removed or only touched is seen on the next call", () => {
  const { root } = demo();
  const first = shelfOf(root, GENERAL, ARCHIVE);
  const one = join(root, first.pages.find((p) => !p.archived)!.rel);
  // 改了内容（大小变了）
  appendFileSync(one, "\n- 又记了一条\n");
  const edited = shelfOf(root, GENERAL, ARCHIVE);
  assert.notEqual(edited, first);
  assert.equal(shelfOf(root, GENERAL, ARCHIVE), edited);
  // 只改了修改时间（内容一样大）：也重读，宁可多读一遍
  utimesSync(one, new Date(NOW + 5000), new Date(NOW + 5000));
  const touched = shelfOf(root, GENERAL, ARCHIVE);
  assert.notEqual(touched, edited);
  // 加一页
  const book = join(one, "..");
  writeFileSync(join(book, "新加的一页.md"), "# 新加的一页 <!-- p:9001 -->\n简介：演示。\n什么时候翻：演示。\n");
  const added = shelfOf(root, GENERAL, ARCHIVE);
  assert.equal(added.pages.length, touched.pages.length + 1);
  // 删一页
  rmSync(join(book, "新加的一页.md"));
  assert.equal(shelfOf(root, GENERAL, ARCHIVE).pages.length, touched.pages.length);
  // 新开一个空目录、点开头的文件：书架没变（点开头的不看），但目录多了一层也不会出错
  mkdirSync(join(root, "新大类", "新本"), { recursive: true });
  writeFileSync(join(root, ".DS_Store"), "x");
  const again = shelfOf(root, GENERAL, ARCHIVE);
  assert.equal(shelfOf(root, GENERAL, ARCHIVE), again);
});

test("shelf: a root that cannot be read gives the scan's own answer and does not throw; when it appears it is read", () => {
  const dir = tmpDir("hh-shelf-none-");
  const root = join(dir, "not-yet");
  const none = shelfOf(root, GENERAL, ARCHIVE);
  assert.deepEqual([none.pages.length, none.problems.length > 0], [0, true]);
  assert.equal(shelfOf(root, GENERAL, ARCHIVE), none);
  mkdirSync(root);
  assert.notEqual(shelfOf(root, GENERAL, ARCHIVE), none);
});

test("shelf: the notebook view reads the shelf through it — a second view of an unchanged shelf has the same pages, and an edit shows up", () => {
  const { dir, root } = demo();
  const db = openReadOnly(join(dir, "hh.db"));
  try {
    const o = { root, generalCategory: GENERAL, archiveDir: ARCHIVE, residentFile: TEST_ROLE.learning.residentFile };
    const a = notebookView(db, NOW, o), b = notebookView(db, NOW, o);
    assert.deepEqual(b, a);
    const page = a.pages.find((p) => p.id === "0120")!;
    const file = join(root, page.rel);
    writeFileSync(file, `# 改了名字的一页 <!-- p:0120 -->\n简介：演示。\n什么时候翻：演示。\n`);
    assert.equal(notebookView(db, NOW, o).pages.find((p) => p.id === "0120")!.title, "改了名字的一页");
  } finally { db.close(); }
});

/** 连里面每一层都冻住：之后谁往上写、原地排序、加字段，就当场抛错（这个文件是模块，本来就是严格模式） */
function deepFreeze(v: unknown, seen = new Set<unknown>()): void {
  if (v === null || typeof v !== "object" || seen.has(v)) return;
  seen.add(v);
  Object.freeze(v);
  for (const x of Object.values(v)) deepFreeze(x, seen);
}

test("shelf: nobody who takes the shelf changes it — the notebook view and the learning panel both run on a deep-frozen scan, and it stays as it was", () => {
  // 记着的那一份是大家共用的：谁原地改了它，下一次请求拿到的就是脏的。把它冻住跑一遍两条取数的路，谁改谁抛错。
  const { dir, root } = demo();
  const shelf = shelfOf(root, GENERAL, ARCHIVE);
  deepFreeze(shelf);
  assert.ok(Object.isFrozen(shelf) && Object.isFrozen(shelf.pages) && Object.isFrozen(shelf.pages[0]) && Object.isFrozen(shelf.pages[0]!.ids) && Object.isFrozen(shelf.books));
  assert.throws(() => { (shelf.pages as unknown[]).sort(); }, TypeError, "冻住了：原地排序会抛错（这条测试真的看得住）");
  const before = JSON.stringify(shelf);
  const db = openReadOnly(join(dir, "hh.db"));
  try {
    for (let i = 0; i < 2; i++) {
      const view = notebookView(db, NOW + i * 60_000, { root, generalCategory: GENERAL, archiveDir: ARCHIVE, residentFile: TEST_ROLE.learning.residentFile });
      assert.equal(view.pages.length, 34);
      const learn = learnView(db, NOW + i * 60_000, { root, generalCategory: GENERAL, archiveDir: ARCHIVE, tz: "Australia/Melbourne", dailyUsd: 1 });
      assert.ok(learn.weekly !== undefined && Array.isArray(learn.recent));
    }
    assert.equal(shelfOf(root, GENERAL, ARCHIVE), shelf, "两条路都跑过两遍：拿到的还是那一份");
    assert.equal(JSON.stringify(shelf), before, "内容一个字没变");
  } finally { db.close(); }
});
