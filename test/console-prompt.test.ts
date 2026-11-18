// 控制台的「完整输入」：从 Claude Code transcript 里拆出系统提示、工具、附件、对话。假 transcript。
import "./names.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpDir } from "./tmp.ts";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { listSessions, parsePrompt, projectDirFor, splitPrefix } from "../src/console/prompt.ts";
import { createConsole, roleOf } from "../src/console/server.ts";
import { openDb } from "../src/store/db.ts";
import { buildPrefix, Persona } from "../src/persona/persona.ts";
import { OPEN_READS } from "./console-reads.ts";

const MARKERS = [
  { role: "main", marker: "【这是你此刻最专心的那头】" },
  { role: "side", marker: "【这是你同时在做的另一件事】" },
  { role: "perception", marker: "【这是你的下意识】" },
];
const MAIN = "11111111-2222-3333-4444-555555555555";
const SIDE = "22222222-2222-3333-4444-555555555555";
// 10-29 晚起的拼法：运行说明 / 人格文件 / 过渡句 + 记忆文件 + 压缩记忆
const PREFIX = "# 你现在的运行方式\n\n你是阿青。\n\n---\n\n<file path=\"IDENTITY.md\">\n我是阿青\n</file>\n\n<file path=\"SOUL.md\">\n人格\n</file>\n\n---\n\n# 你的人生\n\n接下来是你经历的人生。\n\n<file path=\"ledger/SOUL.md\">\n账本\n</file>\n\n## 这次醒来以后（压缩过的记忆）\n\n### 第 1 段\n\n早上剪了视频";
// 更早的会话：没有过渡句
const OLD_PREFIX = "# 你现在的运行方式\n\n你是阿青。\n\n---\n\n<file path=\"IDENTITY.md\">\n我是阿青\n</file>\n\n<file path=\"ledger/SOUL.md\">\n账本\n</file>\n\n---\n\n# 这次醒来以后的经历（整理过的记忆，按时间排）\n\n## 第 1 段\n\n早上剪了视频";

function transcript(first: string): string {
  const L = [
    { type: "queue-operation", operation: "enqueue" },
    { type: "attachment", timestamp: "2026-10-29T09:00:00Z", attachment: { type: "environment" }, rendered: [{ content: "工作目录 /home/role/.openclaw/workspace" }], renderedRole: "system" },
    { type: "attachment", attachment: { type: "deferred_tools_delta", addedNames: ["WebFetch", "mcp__bili__search", "mcp__claude_ai_Claude_Docs__create"], removedNames: [] }, rendered: [{ content: "可以用 ToolSearch 加载：WebFetch…" }], renderedRole: "system" },
    { type: "attachment", attachment: { type: "skill_listing", content: "x" }, rendered: [{ content: "- living: 这台 Mac 上的日常" }], renderedRole: "system" },
    { type: "attachment", attachment: { type: "credential_org" } },
    { type: "attachment", attachment: { type: "prompt_snapshot", systemPrompt: ["<intro> You're an interactive agent", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "<communication> # Communicating", "# Tone and style\nBe brief.", PREFIX] } },
    { type: "api-request-shape", shape: { system: [{ type: "text", text: "x" }], tools: [{ name: "Bash", description: "跑命令", input_schema: { type: "object" } }, { name: "DeferredToolPlaceholder", description: "", input_schema: {} }, { name: "mcp__self__message", description: "发消息", input_schema: { type: "object", properties: { to: { type: "string" } } } }] } },
    { type: "user", timestamp: "2026-10-29T09:00:01Z", message: { role: "user", content: first } },
    { type: "assistant", timestamp: "2026-10-29T09:00:05Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "", signature: "s" }], usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 10 } } },
    { type: "assistant", timestamp: "2026-10-29T09:00:05Z", message: { id: "m1", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }], usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 50, output_tokens: 10 } } },
    { type: "user", timestamp: "2026-10-29T09:00:06Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a.txt" }] }, { type: "text", text: "<记忆>\n另一头（在做：剪片子）说：好了\n</记忆>" }] } },
    { type: "user", isMeta: true, message: { content: "meta" } },
    { type: "assistant", timestamp: "2026-10-29T09:00:09Z", message: { id: "m2", model: "claude-opus-5-5", content: [{ type: "thinking", thinking: "看过了，回他" }, { type: "text", text: "好了" }], usage: { input_tokens: 1, cache_read_input_tokens: 160, cache_creation_input_tokens: 5, output_tokens: 3 } } },
    "坏的一行",
  ];
  return L.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n") + "\n";
}

function fixture() {
  const dir = tmpDir("hh-prompt-");
  const proj = join(dir, "projects", "-home-role--openclaw-workspace");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, `${MAIN}.jsonl`), transcript("【这是你此刻最专心的那头】你是阿青。\n\n下面是你最近的经历…\n\n今天怎么样"));
  writeFileSync(join(proj, `${SIDE}.jsonl`), transcript("【这是你同时在做的另一件事】你是阿青。\n\n剪片子"));
  writeFileSync(join(proj, "33333333-2222-3333-4444-555555555555.jsonl"), transcript("别的东西（额度探针）"));
  writeFileSync(join(proj, "44444444-2222-3333-4444-555555555555.jsonl"), transcript("【这是你此刻最专心的那头】很早以前的会话"));
  const old = (Date.now() - 10 * 86_400_000) / 1000;
  utimesSync(join(proj, "44444444-2222-3333-4444-555555555555.jsonl"), old, old);
  return { dir, proj };
}

test("projectDirFor mirrors Claude Code's folder naming", () => {
  assert.equal(projectDirFor("/p", "/home/role/.openclaw/workspace"), "/p/-home-role--openclaw-workspace");
});

test("listSessions recognises regions by their opening line, skips old and unknown sessions", () => {
  const f = fixture();
  try {
    const s = listSessions(f.proj, MARKERS, Date.now() - 86_400_000);
    assert.deepEqual(s.map((x) => [x.id, x.role]).sort(), [[MAIN, "main"], [SIDE, "side"]]);
    assert.equal(s.find((x) => x.id === MAIN)!.started, "2026-10-29T09:00:01Z");
    assert.equal(roleOf("side-2"), "side");
    assert.equal(roleOf("perception-messages"), "perception");
    assert.equal(roleOf("main"), "main");
  } finally { rmSync(f.dir, { recursive: true }); }
});

test("splitPrefix: runtime note, persona files, the 你的人生 frame, memory files, compacted blocks (old layout too)", () => {
  const p = splitPrefix(PREFIX);
  assert.deepEqual(p.map((x) => x.label), ["HH 运行说明", "人格文件 IDENTITY.md", "人格文件 SOUL.md", "过渡句：你的人生", "记忆文件 ledger/SOUL.md", "压缩记忆（这次醒来以后）"]);
  assert.equal(p.map((x) => x.text).join("").length > 0, true);
  assert.ok(p[3]!.text.startsWith("# 你的人生"));
  assert.ok(!p[3]!.text.includes("<file"));
  assert.deepEqual(splitPrefix(OLD_PREFIX).map((x) => x.label), ["HH 运行说明", "人格文件 IDENTITY.md", "人格文件 ledger/SOUL.md", "压缩记忆（这次醒来以后）"]);
});

test("splitPrefix: the shelf (# 我的书架) between persona files and the frame is its own part", () => {
  const shelf = "# 我的书架\n我的做法和教训都记在这些笔记本里。做事时相关的页会自己冒出来；想找全就用 what_do_i_know，或者直接翻文件。\n\n## 做事\n- 剪辑：剪片子（2 页）";
  const prefix = buildPrefix(new Persona("mira", [{ path: "IDENTITY.md", text: "我是阿青" }, { path: "ledger/SOUL.md", text: "账本" }]), [], { shelf });
  const p = splitPrefix(prefix);
  assert.deepEqual(p.map((x) => x.label), ["HH 运行说明", "人格文件 IDENTITY.md", "书架目录", "过渡句：你的人生", "记忆文件 ledger/SOUL.md"]);
  assert.equal(p[2]!.text, shelf);
});

test("parsePrompt: system segments, tools, deferred names, attachments, messages with tool names, de-duplicated usage", () => {
  const f = fixture();
  try {
    const p = parsePrompt(join(f.proj, `${MAIN}.jsonl`));
    assert.equal(p.session.id, MAIN);
    assert.equal(p.session.model, "claude-opus-5-5");
    assert.deepEqual(p.system.map((x) => x.label), ["Claude Code：开场介绍", "（缓存分界线）", "Claude Code：怎么跟人说话", "Claude Code：Tone and style", "HH 运行说明", "人格文件 IDENTITY.md", "人格文件 SOUL.md", "过渡句：你的人生", "记忆文件 ledger/SOUL.md", "压缩记忆（这次醒来以后）"]);
    assert.deepEqual(p.tools.map((t) => t.name), ["Bash", "mcp__self__message"]);
    assert.match(p.tools[1]!.schema, /"to"/);
    assert.deepEqual(p.deferred, ["WebFetch", "mcp__bili__search", "mcp__claude_ai_Claude_Docs__create"]);
    assert.deepEqual(p.attachments.map((a) => [a.type, a.role]), [["environment", "system"], ["deferred_tools_delta", "system"], ["skill_listing", "system"]]);
    assert.deepEqual(p.messages.map((m) => [m.role, m.kind, m.tool ?? null]), [
      ["user", "text", null], ["assistant", "thinking", null], ["assistant", "tool_use", "Bash"],
      ["user", "tool_result", "Bash"], ["user", "text", null], ["assistant", "thinking", null], ["assistant", "text", null],
    ]);
    assert.equal(p.messages[1]!.text, "（思考内容没有返回）");
    assert.equal(p.messages[5]!.text, "看过了，回他");
    assert.deepEqual(p.usage.map((u) => u.total), [152, 166]);
    assert.equal(p.session.started, "2026-10-29T09:00:01Z");
  } finally { rmSync(f.dir, { recursive: true }); }
});

test("server: /api/prompt by session, by region (falls back to the opening line when hhd is down), sessions list, bad ids", async () => {
  const f = fixture();
  const dbPath = join(f.dir, "hh.db");
  openDb(dbPath).close();
  const server = createConsole({ tell: OPEN_READS,
    dbPath, sockPath: join(f.dir, "no.sock"), helperSessionsDir: join(f.dir, "cc"), projectsDir: join(f.dir, "projects"), logPath: join(f.dir, "l.jsonl"),
    pageHtml: "<!doctype html>", prompt: { dir: f.proj, markers: MARKERS },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const a = await (await fetch(`${base}/api/prompt?session=${MAIN}`)).json() as { how: string; session: { id: string }; tools: unknown[] };
    assert.equal(a.session.id, MAIN);
    assert.equal(a.how, "指定的会话");
    const b = await (await fetch(`${base}/api/prompt?region=side-2`)).json() as { how: string; session: { id: string } };
    assert.equal(b.session.id, SIDE);
    assert.equal(b.how, "按开场白找到的最近会话");
    const s = await (await fetch(`${base}/api/prompt/sessions?region=main`)).json() as { sessions: Array<{ id: string }> };
    assert.deepEqual(s.sessions.map((x) => x.id), [MAIN]);
    assert.equal((await fetch(`${base}/api/prompt?session=../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${base}/api/prompt?region=hippocampus`)).status, 404);
    assert.equal((await fetch(`${base}/api/prompt?region=x/../y`)).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(f.dir, { recursive: true });
  }
});
