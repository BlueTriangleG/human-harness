"use strict";
// ---------- 笔记页：把每一页摆到图上（纯计算，不碰页面） ----------
/*
 * 三层从上到下：浅、中、深。每一本占一竖条（同一大类的挨着，没归本的放最后），一页一个点；
 * 同一本同一层里按分数从高到低，一行行摆。往下看一竖条，就是这一本的页沉到了多深。
 * 竖条有几列，看这一本在最挤的那层有多少页、每层最多摆几行（从两行起）；整张图比 maxWidth 宽时，行数加一行再试；
 * 加到头也摆不下（手机），就定成四行、横着滑。
 * 摆下了还有富余的宽度，就把格子放大（点跟着大），页少的时候图不至于缩在一角。
 */
const NB_LAYERS = ["shallow", "mid", "deep"];
const NB_CELL = 26;      // 一个点占的格子：最小这么大
const NB_CELL_MAX = 42;  // 地方有富余时最大放到这么大
const NB_PAD = 6;        // 竖条两边、每层上下留的空
const NB_GAP = 8;        // 竖条之间
const NB_GUTTER = 70;    // 左边写层名的地方
const NB_HEAD = 58;      // 上面写大类和本名的地方：大类一行，本名错开成两行
const NB_BAND_GAP = 3;   // 层和层之间
const NB_EDGE = 26;      // 最右边留的空：最后一本的名字比竖条宽，要有地方伸出去
const NB_MAX_ROWS = 12;
const NB_SWIPE_ROWS = 4; // 怎么都摆不下、只能横着滑的时候，每层最多这么多行：图不至于比一屏还高

/** 点的半径：重要度只有 3、4、5 三档用得上，差别拉开 */
const nbRadius = (importance) => (importance >= 5 ? 9.5 : importance >= 4 ? 7 : 4.5);

function shelfMap(pages, maxWidth) {
  const groups = new Map();
  for (const p of pages) {
    const key = p.book ? p.category + "\n" + p.book : "";
    if (!groups.has(key)) groups.set(key, { key, category: p.book ? p.category : "", book: p.book, pages: [] });
    groups.get(key).pages.push(p);
  }
  const list = [...groups.values()].sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.category.localeCompare(b.category) || a.book.localeCompare(b.book)));
  for (const g of list) g.byLayer = Object.fromEntries(NB_LAYERS.map((l) => [l, g.pages.filter((p) => p.layer === l).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1))]));
  const most = (g) => Math.max(...NB_LAYERS.map((l) => g.byLayer[l].length));
  const colsFor = (rows) => list.reduce((s, g) => s + Math.max(1, Math.ceil(most(g) / rows)), 0);
  const fixed = NB_GUTTER + list.length * 2 * NB_PAD + Math.max(0, list.length - 1) * NB_GAP + NB_EDGE;   // 不随格子大小变的那部分宽
  // 行数：摆得下的里面最少的那个；怎么都摆不下（手机上：每本一列还是太宽，反正要横着滑），就用 NB_SWIPE_ROWS 行，宽一点、矮一点
  let rows = NB_SWIPE_ROWS;
  for (let r = 2; r <= NB_MAX_ROWS; r++) if (fixed + colsFor(r) * NB_CELL <= maxWidth) { rows = r; break; }
  const cell = Math.max(NB_CELL, Math.min(NB_CELL_MAX, Math.floor((maxWidth - fixed) / Math.max(1, colsFor(rows)))));

  // 竖条
  const books = [];
  let x = NB_GUTTER;
  for (const g of list) {
    const cols = Math.max(1, Math.ceil(most(g) / rows));
    const w = cols * cell + 2 * NB_PAD;
    books.push({ key: g.key, category: g.category, book: g.book, x, w, cols, count: g.pages.length });
    x += w + NB_GAP;
  }
  // right：最后一条竖条的右边线（层的底色画到这里）
  const right = Math.max(x - NB_GAP, NB_GUTTER);
  // 大类：连着的同一个大类的竖条并成一段（没归本的不算大类）
  const categories = [];
  for (const b of books) {
    if (b.key === "") continue;
    const last = categories[categories.length - 1];
    if (last && last.name === b.category) last.w = b.x + b.w - last.x;
    else categories.push({ name: b.category, x: b.x, w: b.w });
  }
  // 层：这一层最挤的那一本要几行，就有多高；一页都没有也留一行的地方
  const bands = [];
  let y = NB_HEAD;
  for (const layer of NB_LAYERS) {
    const need = Math.max(1, ...list.map((g, i) => Math.ceil(g.byLayer[layer].length / books[i].cols)));
    const h = need * cell + 2 * NB_PAD;
    bands.push({ layer, y, h, count: list.reduce((s, g) => s + g.byLayer[layer].length, 0) });
    y += h + NB_BAND_GAP;
  }
  // 点
  const at = {};
  list.forEach((g, i) => {
    for (const band of bands) {
      g.byLayer[band.layer].forEach((p, k) => {
        at[p.id] = [books[i].x + NB_PAD + (k % books[i].cols) * cell + cell / 2, band.y + NB_PAD + Math.floor(k / books[i].cols) * cell + cell / 2];
      });
    }
  });
  // scale：格子比最小的大了多少倍，点的半径照这个放大
  return { width: right + NB_EDGE, right, height: y - NB_BAND_GAP, cell, scale: cell / NB_CELL, bands, books, categories, at };
}

/** 两页之间那条线：一条微微弯的弧（笔直的线会从中间的点上穿过去） */
function shelfArc(a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], d = Math.hypot(dx, dy) || 1;
  const bend = Math.min(40, d * 0.18);
  const mx = (a[0] + b[0]) / 2 - (dy / d) * bend, my = (a[1] + b[1]) / 2 + (dx / d) * bend;
  const f = (n) => Math.round(n * 10) / 10;
  return `M${f(a[0])},${f(a[1])} Q${f(mx)},${f(my)} ${f(b[0])},${f(b[1])}`;
}

/** 一个字在图上大概多宽（图上的字量不了，只能估）：中日韩的字按一个字宽、别的按半个多一点 */
const shelfCharWidth = (ch, fontPx) => (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/.test(ch) ? fontPx : fontPx * 0.56);
/** 一段字大概多宽 */
function shelfTextWidth(text, fontPx) {
  let w = 0;
  for (const ch of text) w += shelfCharWidth(ch, fontPx);
  return w;
}
/** 名字放不下就截短（图上的字没有自动省略） */
function shelfFit(text, widthPx, fontPx) {
  let used = 0;
  for (let i = 0; i < text.length; i++) {
    used += shelfCharWidth(text[i], fontPx);
    if (used > widthPx) return text.slice(0, Math.max(1, i - 1)) + "…";
  }
  return text;
}

/**
 * 页名写在点的哪一边：右边不压着别的点就写右边；压着、左边空着就写左边；两边都有点就写到点的上方，上方也有就下方；
 * 四边都不行还是写右边。伸到框外面的那一边不选（框：左右是图上能写字的两头，上下是这一页所在的那一层，名字不写到本名那一行上去）。
 * 够用就行，不是通用的避让：先写的名字占了的地方（taken）后写的会让开，仅此而已。
 * at：这个点在哪；gap：字离圆心多远；width：字多宽；dots：别的点 [x, y, 半径]；box：{ from, to, top, bottom }；taken：已经写了名字的几块 [x0, y0, x1, y1]。
 */
function shelfNameSide(at, gap, width, dots, box, taken = []) {
  for (const side of ["right", "left", "above", "below"]) {
    const [x0, y0, x1, y1] = shelfNameRect(at, gap, width, side);
    if (x0 < box.from || x1 > box.to || y0 < box.top || y1 > box.bottom) continue;
    if (dots.some(([x, y, r]) => x + r > x0 && x - r < x1 && y + r > y0 && y - r < y1)) continue;
    if (taken.some(([a0, b0, a1, b1]) => a1 > x0 && a0 < x1 && b1 > y0 && b0 < y1)) continue;
    return side;
  }
  return "right";
}
/** 名字写在某一边时占的那一块 [x0, y0, x1, y1] */
function shelfNameRect(at, gap, width, side) {
  const NAME_H = 13;
  if (side === "left") return [at[0] - gap - width, at[1] - 8, at[0] - gap, at[1] + 6];
  if (side === "above") return [at[0] - width / 2, at[1] - gap - NAME_H + 2, at[0] + width / 2, at[1] - gap + 2];
  if (side === "below") return [at[0] - width / 2, at[1] + gap - 2, at[0] + width / 2, at[1] + gap - 2 + NAME_H];
  return [at[0] + gap, at[1] - 8, at[0] + gap + width, at[1] + 6];
}

// ---------- 给别的文件用的 ----------
export { NB_GUTTER, NB_HEAD, nbRadius, shelfArc, shelfFit, shelfMap, shelfNameRect, shelfNameSide, shelfTextWidth };
