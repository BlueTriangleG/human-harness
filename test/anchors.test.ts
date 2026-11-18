// 翻页压缩分叉做时的锚点 → 编号范围
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAnchors } from "../src/memory/anchors.ts";
import type { Entry } from "../src/memory/central.ts";

const e = (seq: number, kind: Entry["kind"], text: string, meta: Record<string, unknown> | null = null, src = "main"): Entry =>
  ({ seq, ts: seq * 1000, epoch: 1, src, kind, text, tokens: 10, meta });

const page: Entry[] = [
  e(10, "input", "今天要不要一起看银魂", { from: "小贝" }, "外界"),
  e(11, "act", 'message {"channel":"whatsapp","target":"ada","message":"拿你说的价值关把手上没发的题都过了一遍，砍了俩"}', { tool: "message", id: "t1" }),
  e(12, "note", "（发给 ada）拿你说的价值关把手上没发的题都过了一遍，砍了俩"),
  e(13, "result", '{"messageId":"3EB0"}', { id: "t1" }),
  e(14, "think", "笑点也拆了，火的那几条几乎不讲笑话"),
  e(15, "act", 'message {"channel":"whatsapp","target":"ada","message":"打算拿同一句话发两遍，一遍被藏当开头"}', { tool: "message", id: "t2" }),
  e(16, "result", '{"messageId":"3EB1"}', { id: "t2" }),
  e(17, "say", "好的，晚上 8 点见"),
];

test("两段原话都找到：从 A 最早那条到 B，最后是工具调用就把结果也带上", () => {
  const r = resolveAnchors("- 跟 ada 说了价值关〔锚：拿你说的价值关把手上｜打算拿同一句话发两遍〕", page);
  assert.equal(r.text, "- 跟 ada 说了价值关（#11–#16）");
  assert.deepEqual(r.stats, { anchored: 1, resolved: 1, ambiguous: 0, dropped: 0, missing: [], ambiguousWhy: [] });
});

test("只写了一段：就是那一条（工具调用带上结果）", () => {
  assert.equal(resolveAnchors("- 小贝约看番〔锚：今天要不要一起看银魂〕", page).text, "- 小贝约看番（#10）");
  assert.equal(resolveAnchors("- 发了一条〔锚：打算拿同一句话发两遍〕", page).text, "- 发了一条（#15–#16）");
});

test("空白、标点抄得不一样也认（第二轮去掉标点再比）", () => {
  const r = resolveAnchors("- x〔锚：拿你说的价值关 把手上没发的题都过了一遍砍了俩〕", page);
  assert.match(r.text, /（#11–#13）$/);
});

test("找不到的锚点去掉、记下来；太短的不比", () => {
  const r = resolveAnchors("- 编的〔锚：这句话根本没出现过｜也没有这句〕\n- 太短〔锚：好的〕", page);
  assert.equal(r.text, "- 编的\n- 太短");
  assert.equal(r.stats.anchored, 2);
  assert.equal(r.stats.resolved, 0);
  assert.equal(r.stats.missing.length, 2);
});

test("B 写在 A 前面：对调", () => {
  const r = resolveAnchors("- x〔锚：好的，晚上 8 点见｜今天要不要一起看银魂〕", page);
  assert.equal(r.text, "- x（#10–#17）");
});

test("多条、多行：每条各换各的，别的字不动", () => {
  const block = "**下午**\n- 约看番〔锚：今天要不要一起看银魂〕\n- 心情很好\n- 约了时间〔锚：好的，晚上 8 点见〕";
  const r = resolveAnchors(block, page);
  assert.equal(r.text, "**下午**\n- 约看番（#10）\n- 心情很好\n- 约了时间（#17）");
  assert.equal(r.stats.resolved, 2);
});

test("复核：两段都在好几处出现，取挨得最近的一对，不从这一页最早那次算起", () => {
  const rows: Entry[] = [
    e(100, "say", "我们周六晚上一起看银魂吧"),
    ...Array.from({ length: 50 }, (_, i) => e(101 + i, "think", `中间别的事 ${i}`)),
    e(8800, "say", "我们周六晚上一起看银魂吧"),
    e(8801, "say", "最后决定周六晚上八点开始"),
  ];
  const r = resolveAnchors("- 约看番〔锚：我们周六晚上一起看银魂｜最后决定周六晚上八点〕", rows);
  assert.equal(r.text, "- 约看番（#8800–#8801）");
});

test("复核：只写了一段、在好几处隔得很远地出现 → 对不上；挨在一起的（消息和笔记）照样算", () => {
  const rows: Entry[] = [e(1, "say", "我看了一眼刚才的动静，没留下话。"), e(500, "say", "我看了一眼刚才的动静，没留下话。")];
  const far = resolveAnchors("- 看了一眼〔锚：我看了一眼刚才的动静〕", rows);
  assert.equal(far.text, "- 看了一眼");
  assert.equal(far.stats.ambiguous, 1);
  assert.deepEqual(far.stats.ambiguousWhy, ["我看了一眼刚才的动静：A 2 处 #1–#500，B 没有"]);
  assert.equal(resolveAnchors("- 发了一条〔锚：拿你说的价值关把手上〕", page).text, "- 发了一条（#11–#13）");
});

test("复核：少了右括号不吞后面的条目；括号里带【】不截断", () => {
  const r = resolveAnchors("- 第一件〔锚：今天要不要一起看银魂｜好的，晚上 8 点见\n- 第二件〔锚：今天要不要一起看银魂〕\n- 第三件", page);
  assert.equal(r.text, "- 第一件\n- 第二件（#10）\n- 第三件");
  const rows: Entry[] = [e(5, "input", "【提醒】你该吃药了，记得按时", { from: "你自己排的提醒" }, "外界")];
  assert.equal(resolveAnchors("- 吃药〔锚：【提醒】你该吃药了〕", rows).text, "- 吃药（#5）");
});

test("复核：整条落在上一页（会话开头带着的尾巴）的条目删掉；别人的工具结果不比", () => {
  const rows: Entry[] = [
    e(3, "say", "上一页的旧事已经压过了"),
    e(10, "input", "今天要不要一起看银魂", { from: "小贝" }, "外界"),
    e(11, "result", "搜索结果：银魂第三季很好看的一集", { id: "x" }, "side-1"),
  ];
  const r = resolveAnchors("- 旧事〔锚：上一页的旧事已经压过了〕\n- 小贝约看番〔锚：今天要不要一起看银魂〕\n- 查了〔锚：银魂第三季很好看的一集〕", rows, { viewer: "main", pageFrom: 10 });
  assert.equal(r.text, "- 小贝约看番（#10）\n- 查了");
  assert.equal(r.stats.dropped, 1);
});

test("复查：别人说话、记笔记这类工具按 1500 字比，别的工具只比前 300 字；落在上一页的条目连同下面缩进的小条目一起删", () => {
  const long = "前".repeat(400);
  const rows: Entry[] = [
    e(3, "say", "上一页的旧事已经压过了"),
    e(20, "act", `message ${JSON.stringify({ message: `${long}后面才说到周六晚上去看海` })}`, { tool: "message", id: "m" }, "side-1"),
    e(21, "act", `Bash ${JSON.stringify({ command: `${long} echo 只在命令很后面的一句话` })}`, { tool: "Bash", id: "b" }, "side-1"),
  ];
  const r = resolveAnchors("- 旧事〔锚：上一页的旧事已经压过了〕\n  - 旧事的细节\n- 约海边〔锚：后面才说到周六晚上去看海〕\n- 命令〔锚：只在命令很后面的一句话〕", rows, { viewer: "main", pageFrom: 10 });
  assert.equal(r.text, "- 约海边（#20）\n- 命令");
});
