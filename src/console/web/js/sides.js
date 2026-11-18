"use strict";
// ---------- 大脑图上「同时在做」那几块的形状 ----------
/*
 * 顶叶那一片配了几个「同时在做」就分成几条（以前是画死的三条，线上其实只开两个）。这里只算形状，不碰页面。
 * 那一片的左边线、右边线各是一条三次曲线；中间的分界线按比例在两条之间取；
 * 每一条的下沿贴着「下意识」那一块的上边线（各块是半透明的，叠在一起会看出来）。
 */
const SIDE_LEFT = [[338, 0], [326, 100], [300, 170], [292, 250]];
const SIDE_RIGHT = [[478, 0], [486, 140], [492, 220], [502, 290]];
/** 「下意识」那一块的上边线：两段三次曲线（和 index.html 里它的 path 开头是同一条） */
const GATE_TOP = [[[166, 292], [220, 262], [300, 248], [380, 252]], [[380, 252], [432, 255], [472, 268], [502, 290]]];

/** 三次曲线上 t 那一点 */
function cubicAt(p, t) {
  const u = 1 - t;
  return [0, 1].map((k) => u * u * u * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t * t * t * p[3][k]);
}
/** 「下意识」上边线在 x 这一竖线上的高度 */
function gateTopY(x) {
  const seg = x <= GATE_TOP[0][3][0] ? GATE_TOP[0] : GATE_TOP[1];
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (cubicAt(seg, m)[0] < x) lo = m; else hi = m; }
  return cubicAt(seg, (lo + hi) / 2)[1];
}
/** 从左数 f（0 到 1）处的那条分界线：四个点，最后一点落在「下意识」的上边线上 */
function sideEdge(f) {
  const p = SIDE_LEFT.map((a, i) => [a[0] + (SIDE_RIGHT[i][0] - a[0]) * f, a[1] + (SIDE_RIGHT[i][1] - a[1]) * f]);
  p[3][1] = gateTopY(p[3][0]);
  return p;
}
/** n 条各自的形状（path 的 d）和标号放哪（x、y），从左到右 */
function sideShapes(n) {
  const r = (v) => Math.round(v * 10) / 10;
  const pt = (q) => r(q[0]) + "," + r(q[1]);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = sideEdge(k / n), b = sideEdge((k + 1) / n);
    const la = cubicAt(a, 0.72), lb = cubicAt(b, 0.72);
    out.push({
      d: "M" + pt(a[0]) + " L" + pt(b[0]) + " C" + pt(b[1]) + " " + pt(b[2]) + " " + pt(b[3]) + " L" + pt(a[3]) + " C" + pt(a[2]) + " " + pt(a[1]) + " " + pt(a[0]) + " Z",
      x: r((la[0] + lb[0]) / 2), y: r((la[1] + lb[1]) / 2 + 6),
    });
  }
  return out;
}

// ---------- 给别的文件用的 ----------
export { sideShapes };
