// 大脑图上「同时在做」那几块的形状（web/js/sides.js，只算形状不碰页面）：配了几个分几条，边线对得上，下沿贴着「下意识」的上边线。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { WEB_DIR, asPlainScript, consoleSource } from "./console-web.ts";
import { renderPage } from "../src/console/lang/index.ts";

interface Shape { d: string; x: number; y: number }
const ctx = vm.createContext({});
vm.runInContext(asPlainScript(readFileSync(join(WEB_DIR, "js/sides.js"), "utf8")), ctx);
// 沙箱里出来的数组是另一个世界的 Array：抄成这边的再比
const shapes = (n: number): Shape[] => Array.from(vm.runInContext(`sideShapes(${n})`, ctx) as Shape[], (s) => ({ ...s }));
const gateTopY = (x: number): number => vm.runInContext(`gateTopY(${x})`, ctx) as number;
/** path 的 d 里的点，按出现的次序，一共九个：M 起点、L 右上角、C 两个控制点和右下角、L 左下角、C 两个控制点和回到起点 */
const points = (d: string): number[][] => [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);

test("sides: the gate's top edge here is the one drawn in the page, and its height is read off correctly", () => {
  assert.match(readFileSync(join(WEB_DIR, "index.html"), "utf8"), /<path class="shape" d="M166,292 C220,262 300,248 380,252 C432,255 472,268 502,290 L600,340/, "「下意识」那一块的上边线改了，sides.js 的 GATE_TOP 要跟着改");
  for (const [x, y] of [[166, 292], [380, 252], [502, 290]] as const) assert.ok(Math.abs(gateTopY(x) - y) < 0.05, `${x} → ${gateTopY(x)}`);
  assert.ok(gateTopY(292) > 248 && gateTopY(292) < 256);
});

test("sides: n regions give n slices that share their edges, span the whole band, and sit on the gate's top edge", () => {
  assert.deepEqual(shapes(0), []);
  for (const n of [1, 2, 3, 5]) {
    const list = shapes(n).map((s) => ({ ...s, p: points(s.d) }));
    assert.equal(list.length, n);
    for (const s of list) {
      assert.match(s.d, /^M[\d.,-]+ L[\d.,-]+ C[\d.,-]+ [\d.,-]+ [\d.,-]+ L[\d.,-]+ C[\d.,-]+ [\d.,-]+ [\d.,-]+ Z$/);
      assert.equal(s.p.length, 9);
      assert.deepEqual(s.p[8], s.p[0], "回到起点");
      // 左下角、右下角都在「下意识」的上边线上
      for (const q of [s.p[4]!, s.p[5]!]) assert.ok(Math.abs(q[1]! - gateTopY(q[0]!)) < 0.2, `${q} 不在上边线上`);
      // 标号在这一条里面
      assert.ok(s.x > Math.min(s.p[5]![0]!, s.p[0]![0]!) && s.x < Math.max(s.p[1]![0]!, s.p[4]![0]!) && s.y > 150 && s.y < 240, `标号 ${s.x},${s.y}`);
    }
    assert.deepEqual(list[0]!.p[0], [338, 0]);
    assert.deepEqual(list[n - 1]!.p[1], [478, 0]);
    assert.deepEqual(list[n - 1]!.p[4], [502, 290]);
    for (let k = 1; k < n; k++) {
      const left = list[k - 1]!.p, right = list[k]!.p;
      // 左边那条的右边线（右上、两个控制点、右下）就是右边那条的左边线（起点、倒着的两个控制点、左下）
      assert.deepEqual([left[1], left[2], left[3], left[4]], [right[0], right[7], right[6], right[5]], `第 ${k} 条分界线两边对不上`);
    }
  }
  assert.deepEqual(shapes(2)[0]!.d.split(" ")[1], "L408,0", "两条：从中间分开");
});

test("sides: the page draws what the server says is configured — the regions go into the page's data, and the map has no fixed third slice left", () => {
  const data = (html: string): { regions: string[] | null; now: null } => JSON.parse(/<script type="application\/json" id="hh-data">(.*?)<\/script>/s.exec(html)![1]!) as { regions: string[] | null; now: null };
  const tpl = `<script type="application/json" id="hh-data">{{@data}}</script>`;
  assert.equal(data(renderPage(tpl, "zh")).regions, null, "没给：页面照默认的两个画");
  const html = renderPage(tpl, "zh", {}, false, ["main", "side-1", "side-2", "deep"]);
  assert.deepEqual(data(html).regions, ["main", "side-1", "side-2", "deep"]);
  assert.match(html, /"regions":\[[^\]]*\],"now":null\}<\/script>$/, "钟还在最后（withClock 认它）");
  const src = consoleSource();
  assert.doesNotMatch(src, /data-src="side-\d"/, "骨架里不再画死哪一条");
  assert.match(src, /<g id="sides"><\/g>/);
  assert.match(src, /<g class="region" data-src="deep"[^>]*>\s*<title>慢慢想（枕叶）/);
  assert.doesNotMatch(src, /还没用到/);
  assert.match(src, /const SIDE_IDS = \(Array\.isArray\(HH\.regions\) \? HH\.regions : \["side-1", "side-2"\]\)/);
  assert.match(src, /if \(src\.startsWith\("side-"\)\) return regionText\("side", "--l-side", 2, \{ n: src\.slice\(5\) \}\);/);
});
