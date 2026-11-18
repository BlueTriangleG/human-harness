// 控制台的「笔记」页：/api/notebook 给每一页的层、重要度、多久没翻和页之间的线（层由学习的 graphData 现算，这里只看控制台拼出来的那一份）；
// web/js/shelfmap.js 把页摆到图上（只算位置，不碰页面）。数据是演示库里编的那三十多页。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { openReadOnly } from "../src/console/data.ts";
import { notebookView } from "../src/console/notebook.ts";
import type { NotebookPage, NotebookView } from "../src/console/notebook.ts";
import { openDb } from "../src/store/db.ts";
import { buildDemo, startDemo } from "./console-demo.ts";
import { WEB_DIR, asPlainScript } from "./console-web.ts";
import { TEST_ROLE } from "./helpers.ts";
import { tmpDir } from "./tmp.ts";

const NOW = Date.UTC(2026, 10, 12, 3, 30);   // 枫湾 11-12 14:30
const TZ = "Australia/Melbourne";
const ids = (pages: NotebookPage[], want: (p: NotebookPage) => boolean): string[] => pages.filter(want).map((p) => p.id).sort();

function demoView(): { dir: string; view: NotebookView } {
  const dir = tmpDir("hh-notebook-");
  buildDemo(dir, NOW, { tz: TZ });
  const db = openReadOnly(join(dir, "hh.db"));
  try { return { dir, view: notebookView(db, NOW, { root: join(dir, "ws", "skills"), generalCategory: TEST_ROLE.learning.generalCategory, archiveDir: TEST_ROLE.learning.archiveDir, residentFile: TEST_ROLE.learning.residentFile }) }; } finally { db.close(); }
}

test("notebook: every page of the shelf with its layer, importance, days unopened and link count; important pages never sink", () => {
  const { view } = demoView();
  const p = view.pages;
  assert.equal(view.deepDays, 30);
  assert.equal(p.length, 34);
  assert.equal(new Set(p.map((x) => `${x.category}/${x.book}`)).size, 9);
  // 深层：不重要、又 30 天以上没翻（从没翻过的，过了宽限再起算）
  assert.deepEqual(ids(p, (x) => x.layer === "deep"), ["0013", "0103", "0106", "0114", "0121", "0161", "0172"]);
  assert.deepEqual(ids(p, (x) => x.layer === "shallow"), ["0003", "0012", "0021", "0110", "0111", "0112", "0122", "0130", "0132", "0140", "0141", "0142", "0150", "0160", "0171"]);
  assert.ok(p.every((x) => !(x.important && x.layer === "deep")));
  assert.deepEqual(ids(p, (x) => x.importance === 5), ["0110", "0132", "0140", "0160"]);
  // 重要但很久没翻：重要的不沉，所以单独标出来；从没翻过的那一页也算
  assert.deepEqual(ids(p, (x) => x.stale), ["0112", "0132", "0141"]);
  const never = p.find((x) => x.id === "0132")!;
  assert.deepEqual([never.never, never.days, never.layer], [true, 44, "shallow"], "58 天前第一次扫到，宽限 14 天，起算 44 天");
  assert.deepEqual([p.find((x) => x.id === "0152")!.never, p.find((x) => x.id === "0152")!.days], [true, 0], "还在宽限期里");
  assert.equal(p.find((x) => x.id === "0122")!.opens, 5, "最近 30 天里有 5 天翻过");
  // 线
  assert.deepEqual(ids(p, (x) => x.links === 0), ["0103", "0104", "0143", "0161", "0172"]);
  assert.deepEqual([view.links.filter((l) => l.kind === "ref").length, view.links.filter((l) => l.kind === "co").length, view.links.filter((l) => l.kind === "event").length], [23, 22, 6]);
  assert.equal(p.find((x) => x.id === "0120")!.links, 9, "一对页之间有几种线就算几条");
});

test("notebook: links to pages that are no longer on the shelf, and a page linked to itself, are left out", () => {
  const dir = tmpDir("hh-notebook-");
  buildDemo(dir, NOW, { tz: TZ });
  const rw = openDb(join(dir, "hh.db"));
  rw.prepare("INSERT INTO learn_link (a, b, kind, weight, n, updated) VALUES ('0012', '9999', 'ref', 1, 1, ?), ('8888', '0013', 'co', 2, 2, ?), ('0012', '0012', 'co', 1, 1, ?)").run(NOW, NOW, NOW);
  rw.close();
  const db = openReadOnly(join(dir, "hh.db"));
  try {
    const view = notebookView(db, NOW, { root: join(dir, "ws", "skills"), generalCategory: TEST_ROLE.learning.generalCategory, archiveDir: TEST_ROLE.learning.archiveDir, residentFile: TEST_ROLE.learning.residentFile });
    const on = new Set(view.pages.map((x) => x.id));
    assert.equal(view.links.length, 51);
    assert.ok(view.links.every((l) => l.a !== l.b && on.has(l.a) && on.has(l.b)));
  } finally { db.close(); }
});

test("notebook: /api/notebook serves it read-only; in English the demo's pages have English names", async () => {
  const dir = tmpDir("hh-notebook-");
  buildDemo(dir, NOW, { tz: TZ });
  const demo = await startDemo({ dir, port: 0, now: () => NOW });
  try {
    const r = await fetch(demo.url + "/api/notebook");
    assert.equal(r.status, 200);
    const view = await r.json() as NotebookView;
    assert.equal(view.pages.length, 34);
    assert.equal(view.at, NOW);
    assert.equal((await fetch(demo.url + "/api/notebook", { method: "POST" })).status, 405);
  } finally { await demo.close(); }
});

// ---------- 摆位置（web/js/shelfmap.js） ----------

interface ShelfMap {
  width: number; right: number; height: number; cell: number; scale: number;
  bands: Array<{ layer: string; y: number; h: number; count: number }>;
  books: Array<{ key: string; category: string; book: string; x: number; w: number; cols: number; count: number }>;
  categories: Array<{ name: string; x: number; w: number }>;
  at: Record<string, [number, number]>;
}
const ctx = vm.createContext({});
vm.runInContext(asPlainScript(readFileSync(join(WEB_DIR, "js/shelfmap.js"), "utf8")), ctx);
// 沙箱里出来的对象是另一个世界的：转成 JSON 再读回来
const shelfMap = (pages: unknown[], maxWidth: number): ShelfMap => JSON.parse(vm.runInContext(`JSON.stringify(shelfMap(${JSON.stringify(pages)}, ${maxWidth}))`, ctx) as string) as ShelfMap;
const call = <T>(code: string): T => vm.runInContext(code, ctx) as T;

test("shelf map: three bands top to bottom, one column per notebook, every page inside its band and its column, no two on the same spot", () => {
  const { view } = demoView();
  const m = shelfMap(view.pages, 1100);
  assert.deepEqual(m.bands.map((b) => [b.layer, b.count]), [["shallow", 15], ["mid", 12], ["deep", 7]]);
  assert.ok(m.bands[0]!.y < m.bands[1]!.y && m.bands[1]!.y < m.bands[2]!.y);
  assert.equal(m.books.length, 9);
  assert.ok(m.width <= 1100, `宽 ${m.width}`);
  // 同一个大类的本挨着；大类那一段正好盖住它的几本
  assert.deepEqual(m.categories.map((c) => c.name), [...new Set(m.books.map((b) => b.category))]);
  for (const c of m.categories) {
    const mine = m.books.filter((b) => b.category === c.name);
    assert.deepEqual([c.x, c.x + c.w], [mine[0]!.x, mine.at(-1)!.x + mine.at(-1)!.w]);
  }
  const spots = new Set<string>();
  for (const p of view.pages) {
    const [x, y] = m.at[p.id]!;
    const band = m.bands.find((b) => b.layer === p.layer)!;
    const book = m.books.find((b) => b.category === p.category && b.book === p.book)!;
    assert.ok(y > band.y && y < band.y + band.h, `${p.id} 不在 ${p.layer} 那一层里`);
    assert.ok(x > book.x && x < book.x + book.w, `${p.id} 不在它那一本的竖条里`);
    assert.ok(!spots.has(`${x},${y}`), `${p.id} 和别的页叠在一起`);
    spots.add(`${x},${y}`);
  }
  // 竖条不重叠；right 是最后一条的右边线，再往右留着放最后一本名字的地方
  for (let i = 1; i < m.books.length; i++) assert.ok(m.books[i]!.x >= m.books[i - 1]!.x + m.books[i - 1]!.w);
  assert.equal(m.right, m.books.at(-1)!.x + m.books.at(-1)!.w);
  assert.ok(m.width > m.right);
});

test("shelf map: a narrower space gets fewer columns and more rows; an empty deep layer keeps its band; pages in no notebook go last", () => {
  const { view } = demoView();
  const wide = shelfMap(view.pages, 2000), narrow = shelfMap(view.pages, 520);
  const rowsIn = (m: ShelfMap): number => new Set(view.pages.filter((p) => p.layer === "shallow").map((p) => m.at[p.id]![1])).size;
  assert.ok(narrow.width <= 520 && narrow.width < wide.width && rowsIn(narrow) > rowsIn(wide), `窄 ${narrow.width}（${rowsIn(narrow)} 行），宽 ${wide.width}（${rowsIn(wide)} 行）`);
  // 手机那么窄，怎么都摆不下：反正要横着滑，每层最多四行（宽一点、矮一点，图不比一屏还高），格子是最小的
  const phone = shelfMap(view.pages, 340);
  assert.ok(phone.width > 340 && phone.cell === 26 && rowsIn(phone) <= 4, `手机：宽 ${phone.width}，浅层 ${rowsIn(phone)} 行`);
  assert.deepEqual(shelfMap(view.pages, 100).at, phone.at, "再窄也是这个摆法");
  const many = Array.from({ length: 30 }, (_, i) => ({ id: String(i), layer: "shallow", category: "work", book: "alpha", score: 30 - i, importance: 3 }));
  const tall = shelfMap(many, 150);
  assert.deepEqual([new Set(Object.values(tall.at).map((a) => a[1])).size, tall.books[0]!.cols], [4, 8], "一本一层三十页、屏又窄：四行八列，不是一列三十行");
  // 地方有富余，格子放大（点跟着大），到上限为止；挤的时候是最小的格子
  assert.deepEqual([phone.cell, phone.scale, wide.cell], [26, 1, 42]);
  assert.ok(narrow.cell >= 26 && narrow.cell < 30, `刚好摆下的时候格子只大一点：${narrow.cell}`);
  assert.ok(wide.width <= 2000 && wide.scale > 1.5);
  const fit = shelfMap(view.pages, 700);
  assert.ok(fit.cell > 26 && fit.cell < 42 && fit.width <= 700 && fit.width > 700 - 30, `正好铺满：格子 ${fit.cell}，宽 ${fit.width}`);
  const page = (id: string, layer: string, book: string, score = 30): unknown => ({ id, layer, category: book ? "work" : "", book, score, importance: 3 });
  const m = shelfMap([page("1", "shallow", "alpha"), page("2", "mid", "alpha"), page("3", "shallow", ""), page("4", "shallow", "beta", 50), page("5", "shallow", "beta", 40)], 1000);
  assert.deepEqual(m.bands.map((b) => b.count), [4, 1, 0]);
  assert.ok(m.bands[2]!.h > 0, "深层一页都没有，也留着地方（写一句「现在没有」）");
  assert.deepEqual(m.books.map((b) => b.key), ["work\nalpha", "work\nbeta", ""]);
  assert.deepEqual(m.categories.map((c) => c.name), ["work"], "没归本的不算一个大类");
  assert.ok(m.at["4"]![0] < m.at["5"]![0] || m.at["4"]![1] < m.at["5"]![1], "同一本同一层里分数高的在前");
  assert.deepEqual(shelfMap([], 800).bands.map((b) => b.count), [0, 0, 0]);
});

test("shelf map: dot sizes are far enough apart to tell the three importance levels; long names are cut to fit; a link is a shallow arc", () => {
  const r = [3, 4, 5].map((n) => call<number>(`nbRadius(${n})`));
  assert.ok(r[1]! - r[0]! >= 2 && r[2]! - r[1]! >= 2, String(r));
  assert.equal(call<string>(`shelfFit("做饭", 60, 11.5)`), "做饭");
  assert.equal(call<string>(`shelfFit("一个特别特别长的本子名字", 60, 11.5)`), "一个特别…");
  assert.equal(call<string>(`shelfFit("Birthdays and anniversaries", 60, 11.5)`), "Birthday…");
  assert.match(call<string>(`shelfArc([0, 0], [100, 0])`), /^M0,0 Q50,18 100,0$/);
  assert.deepEqual([call<number>(`shelfTextWidth("做饭", 12)`), Math.round(call<number>(`shelfTextWidth("abc", 12)`) * 100)], [24, 2016]);
  // 页名写在哪一边：右边空着写右边；右边紧挨着有点、左边空着写左边；两边都有点写上方，上方也有（或者出了这一层）写下方；都不行还是右边
  const side = (dots: number[][], box: { from?: number; to?: number; top?: number; bottom?: number } = {}): string =>
    call<string>(`shelfNameSide([500, 100], 12, 60, ${JSON.stringify(dots)}, ${JSON.stringify({ from: 0, to: 1000, top: 0, bottom: 200, ...box })})`);
  const L = [460, 100, 7], R = [540, 100, 7], UP = [500, 74, 7], DOWN = [500, 126, 7];
  assert.equal(side([]), "right");
  assert.equal(side([R]), "left");
  assert.equal(side([L]), "right");
  assert.equal(side([L, R]), "above");
  assert.equal(side([L, R, UP]), "below");
  assert.equal(side([L, R, UP, DOWN]), "right", "四边都有点：还是右边");
  assert.equal(side([[540, 140, 7], [540, 60, 7]]), "right", "上一行、下一行的点压不到写在右边的名字");
  assert.equal(side([[580, 100, 7]]), "right", "右边的点在名字够不着的地方");
  assert.equal(side([R], { from: 465 }), "above", "右边有点、左边出了图");
  assert.equal(side([], { to: 560 }), "left", "右边出了图：写左边");
  assert.equal(side([L, R], { top: 85 }), "below", "最上面一行：上方就出了这一层（会压到本名那一行），写下方");
  assert.equal(side([L, R], { top: 85, bottom: 115 }), "right");
  // 先写的名字占了右边那一块：后写的让开
  const rightOf = call<number[]>(`shelfNameRect([500, 100], 12, 60, "right")`);
  assert.deepEqual([...rightOf], [512, 92, 572, 106]);
  assert.equal(call<string>(`shelfNameSide([500, 100], 12, 60, [], ${JSON.stringify({ from: 0, to: 1000, top: 0, bottom: 200 })}, [[560, 95, 640, 109]])`), "left");
  assert.equal(call<string>(`shelfNameSide([500, 100], 12, 60, [], ${JSON.stringify({ from: 0, to: 1000, top: 0, bottom: 200 })}, [[580, 95, 640, 109]])`), "right");
});
