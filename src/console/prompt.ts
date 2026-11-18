// 「完整输入」：某个脑区的会话到底收到了什么。全部从 Claude Code 自己的 transcript 里读（只读）。
// transcript 里除了对话，还有：
//   prompt_snapshot（attachment）：系统提示分段 + 带完整定义的工具
//   api-request-shape：真正发给模型的 system 块和 tools
//   attachment：Claude Code 开场塞进来的附件（环境、日期、技能清单、延迟加载的工具名……），rendered 是原文
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { clip } from "./data.ts";
import { say } from "./lang/index.ts";
import type { Key } from "./lang/index.ts";
import { forYouHead, literal, midtermHead, prefixHeads } from "./packtext.ts";

export interface RoleMarker { role: string; marker: string }

export interface SessionRef { id: string; role: string; mtime: number; bytes: number; started: string | null }

/** Claude Code 存 transcript 的目录名：cwd 里不是字母数字的都换成 - */
export function projectDirFor(projectsDir: string, cwd: string): string {
  return join(projectsDir, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

function firstUserText(path: string, maxBytes = 1_500_000): { text: string; ts: string | null } | null {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(statSync(path).size, maxBytes);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.includes('"type":"user"')) continue;
      let o: { type?: string; isMeta?: boolean; timestamp?: string; message?: { content?: unknown } };
      try { o = JSON.parse(line); } catch { continue; }
      if (o.type !== "user" || o.isMeta) continue;
      const c = o.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("") : "";
      return { text, ts: o.timestamp ?? null };
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 最近的会话，按开场的角色说明认是哪个脑区的；最新的在前 */
export function listSessions(dir: string, markers: readonly RoleMarker[], sinceMs: number, limit = 60): SessionRef[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => {
    const p = join(dir, f);
    const st = statSync(p);
    return { f, p, mtime: st.mtimeMs, bytes: st.size };
  }).filter((x) => x.mtime >= sinceMs).sort((a, b) => b.mtime - a.mtime).slice(0, 200);
  const out: SessionRef[] = [];
  for (const x of files) {
    const first = firstUserText(x.p);
    if (!first) continue;
    const m = markers.find((r) => first.text.startsWith(r.marker));
    if (!m) continue;
    out.push({ id: x.f.slice(0, -".jsonl".length), role: m.role, mtime: x.mtime, bytes: x.bytes, started: first.ts });
    if (out.length >= limit) break;
  }
  return out;
}

/** 系统提示的一段是什么：页面按 kind 分组、上色，label 只管显示（按看的人的语言） */
export type SegmentKind = "cc" | "boundary" | "runtime" | "shelf" | "frame" | "personaFile" | "memoryFile" | "midterm" | "compacted" | "prefix";
export interface Segment { kind: SegmentKind; label: string; text: string; /** 人格文件、记忆文件：是哪个文件 */ file?: string }
export interface ToolDef { name: string; description: string; schema: string }
export interface Attachment { type: string; role: string | null; text: string; ts: string | null }
export interface Msg { ts: string | null; role: "user" | "assistant"; kind: string; text: string; tool?: string; error?: boolean; /** 发给她的这条里附着「只给你看」的那一段 */ forYou?: true }
export interface Usage { ts: string | null; total: number; read: number; write: number; output: number }

export interface PromptView {
  session: { id: string; model: string | null; started: string | null; mtime: number; bytes: number };
  system: Segment[];
  tools: ToolDef[];
  deferred: string[];
  attachments: Attachment[];
  messages: Msg[];
  usage: Usage[];
}

/**
 * How the parts of the prefix open. The role's own wording is read from its language pack (prefixHeads, midtermHead in
 * packtext.ts). Beside it, wordings no pack has: the first role's compacted heading before 2026-10-29 evening, and the
 * English demo's headings, which go once the English pack has these entries.
 */
const OTHER_HEADS = {
  runtime: ["# How you run now"],
  shelf: ["# My shelf"],
  frame: ["# Your life"],
  compacted: ["# 这次醒来以后", "# Since you woke up", "## Since you woke up"],
};
const DEMO_MIDTERM = "# Recently";
type Heads = ReturnType<typeof prefixHeads>;
const opens = (p: string, part: keyof Heads, heads: Heads): boolean => [heads[part], ...OTHER_HEADS[part]].some((h) => p.startsWith(h));
/** Claude Code 系统提示里认得的那几节（标签名 → 包里的条目） */
const CC_SECTIONS: ReadonlySet<string> = new Set(["intro", "communication", "pronouns", "action_caution", "surface", "environment", "context_management", "system_messages", "when_to_be_proactive"]);
const isMidtermHead = (line: string, packHead: string | null): boolean => line === packHead || line === DEMO_MIDTERM;
/** 「只给你看」旧的写法（「【只给你看：…】」那一版）和演示库的英文写法；包里现在的开头从包里取 */
const FOR_YOU_OLD = ["【只给你看", "[For you only"];
/** 发给她的一条消息里有没有附「只给你看」的那一段（看全文，不是截短以后的） */
function forYou(text: string): { forYou?: true } {
  const head = forYouHead();
  return (head !== null && text.includes(head)) || FOR_YOU_OLD.some((h) => text.includes(h)) ? { forYou: true } : {};
}
const seg = (kind: SegmentKind, text: string, params?: { file: string }): Segment => ({
  kind, label: say(`prompt.segment.${kind}` as Key, params), text, ...(params ? { file: params.file } : {}),
});

/**
 * 系统提示里 HH 追加的那段，按 buildPrefix 的拼法拆开：运行说明 / 每个人格文件 / 书架目录（开了才有）/ 过渡句「你的人生」/ 记忆文件 / 中期视图（事件库最近这一段，开了才有）/ 压缩记忆。
 * 旧会话（10-29 晚以前）没有过渡句，压缩记忆的标题是「# 这次醒来以后的经历」，也认。
 */
export function splitPrefix(text: string): Segment[] {
  const out: Segment[] = [];
  let inMemory = false;
  const head = midtermHead(), heads = prefixHeads();
  const alt = (list: readonly (string | null)[]) => list.filter((h) => h !== null).map(literal).join("|");
  const cut = new RegExp(`(?=<file path=")|(?=^(?:${alt([heads.compacted, ...OTHER_HEADS.compacted])}))|(?=^(?:${alt([head, DEMO_MIDTERM])})$)`, "m");
  for (const part of text.split("\n\n---\n\n")) {
    const pieces = part.split(cut);
    for (const raw of pieces) {
      const p = raw.replace(/\n+$/, "");
      if (!p.trim()) continue;
      if (opens(p, "runtime", heads)) { out.push(seg("runtime", p)); continue; }
      if (opens(p, "shelf", heads)) { out.push(seg("shelf", p)); continue; }
      if (opens(p, "frame", heads)) { inMemory = true; out.push(seg("frame", p)); continue; }
      if (opens(p, "compacted", heads)) { out.push(seg("compacted", p)); continue; }
      if (isMidtermHead(p.split("\n", 1)[0]!, head)) { out.push(seg("midterm", p)); continue; }
      const m = /^<file path="([^"]+)">/.exec(p);
      if (m) { out.push(seg(inMemory ? "memoryFile" : "personaFile", p, { file: m[1]! })); continue; }
      out.push(seg("prefix", p));
    }
  }
  return out;
}

/** Claude Code 自己的一段叫什么：认得的那几节用包里的名字，别的用它的标签名、标题或开头几个字 */
function ccName(s: string): string {
  const m = /^<([a-z_]+)>/.exec(s);
  if (m) return CC_SECTIONS.has(m[1]!) ? say(`prompt.ccSection.${m[1]}` as Key) : m[1]!;
  if (/^WebSearch takes/.test(s)) return say("prompt.ccSection.web_search");
  const tag = /^<([a-zA-Z_]+)/.exec(s);
  if (tag) return tag[1]!;
  const h = /^#+\s*(.+)$/m.exec(s.slice(0, 300));
  if (h) return h[1]!.trim().slice(0, 30);
  return s.replace(/\s+/g, " ").trim().slice(0, 24);
}
function ccSegment(s: string): Segment {
  if (s.startsWith("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__")) return seg("boundary", s);
  return { kind: "cc", label: say("prompt.segment.cc", { name: ccName(s) }), text: s };
}

function segmentsOf(systemPrompt: string[]): Segment[] {
  const out: Segment[] = [];
  for (const s of systemPrompt) {
    if (opens(s, "runtime", prefixHeads())) out.push(...splitPrefix(s));
    else out.push(ccSegment(s));
  }
  return out;
}

function textOf(c: unknown): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.map((b) => {
      const x = b as Record<string, unknown>;
      if (x.type === "text" && typeof x.text === "string") return x.text;
      if (x.type === "image") return say("common.image");
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

/** 读整份 transcript，拆成「完整输入」的各个部分 */
export function parsePrompt(path: string, maxMsgChars = 20_000): PromptView {
  const st = statSync(path);
  const id = path.split("/").pop()!.replace(/\.jsonl$/, "");
  let system: Segment[] = [];
  let tools: ToolDef[] = [];
  const deferred = new Set<string>();
  const attachments: Attachment[] = [];
  const messages: Msg[] = [];
  const usage: Usage[] = [];
  const seenUsage = new Set<string>();
  const toolName = new Map<string, string>();
  let model: string | null = null;
  let started: string | null = null;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const ts = typeof o.timestamp === "string" ? o.timestamp : null;
    const type = o.type;
    if (type === "api-request-shape") {
      const shape = o.shape as { system?: Array<{ text?: string }>; tools?: Array<{ name?: string; description?: string; input_schema?: unknown }> } | undefined;
      if (shape?.tools?.length) {
        tools = shape.tools.filter((t) => t.name && t.name !== "DeferredToolPlaceholder").map((t) => ({
          name: String(t.name), description: String(t.description ?? ""), schema: JSON.stringify(t.input_schema ?? {}, null, 1),
        }));
      }
      if (!system.length && shape?.system?.length) system = segmentsOf(shape.system.map((b) => String(b.text ?? "")));
      continue;
    }
    if (type === "attachment") {
      const a = (o.attachment ?? {}) as Record<string, unknown>;
      if (a.type === "prompt_snapshot") {
        if (Array.isArray(a.systemPrompt) && a.systemPrompt.length) system = segmentsOf(a.systemPrompt as string[]);
        continue;
      }
      if (a.type === "deferred_tools_delta") {
        for (const n of (a.addedNames as string[] | undefined) ?? []) deferred.add(n);
        for (const n of (a.removedNames as string[] | undefined) ?? []) deferred.delete(n);
      }
      const rendered = Array.isArray(o.rendered) ? (o.rendered as Array<{ content?: string }>).map((r) => r.content ?? "").join("\n") : "";
      if (rendered) attachments.push({ type: String(a.type ?? "?"), role: typeof o.renderedRole === "string" ? o.renderedRole : null, text: clip(rendered, maxMsgChars), ts });
      continue;
    }
    const msg = o.message as { content?: unknown; model?: string; id?: string; usage?: Record<string, number> } | undefined;
    if (!msg) continue;
    if (type === "user") {
      if (o.isMeta === true) continue;
      if (!started) started = ts;
      if (typeof msg.content === "string") {
        messages.push({ ts, role: "user", kind: "text", text: clip(msg.content, maxMsgChars), ...forYou(msg.content) });
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content as Array<Record<string, unknown>>) {
          if (b.type === "tool_result") {
            const tid = String(b.tool_use_id ?? "");
            messages.push({ ts, role: "user", kind: "tool_result", text: clip(textOf(b.content), maxMsgChars), ...(toolName.has(tid) ? { tool: toolName.get(tid)! } : {}), ...(b.is_error === true ? { error: true } : {}) });
          } else if (b.type === "text" && typeof b.text === "string") {
            messages.push({ ts, role: "user", kind: "text", text: clip(b.text, maxMsgChars), ...forYou(b.text) });
          }
        }
      }
    } else if (type === "assistant") {
      model = msg.model ?? model;
      const u = msg.usage;
      const key = msg.id ?? `${ts}`;
      if (u && !seenUsage.has(key)) {
        seenUsage.add(key);
        const read = u.cache_read_input_tokens ?? 0, write = u.cache_creation_input_tokens ?? 0;
        usage.push({ ts, total: (u.input_tokens ?? 0) + read + write, read, write, output: u.output_tokens ?? 0 });
      }
      for (const b of (Array.isArray(msg.content) ? msg.content : []) as Array<Record<string, unknown>>) {
        if (b.type === "thinking") messages.push({ ts, role: "assistant", kind: "thinking", text: typeof b.thinking === "string" && b.thinking.trim() ? clip(b.thinking, maxMsgChars) : say("prompt.noThinking") });
        else if (b.type === "text" && typeof b.text === "string") messages.push({ ts, role: "assistant", kind: "text", text: clip(b.text, maxMsgChars) });
        else if (b.type === "tool_use") {
          const name = String(b.name ?? "");
          if (typeof b.id === "string") toolName.set(b.id, name);
          messages.push({ ts, role: "assistant", kind: "tool_use", tool: name, text: clip(JSON.stringify(b.input ?? {}), maxMsgChars) });
        }
      }
    }
  }
  return { session: { id, model, started, mtime: st.mtimeMs, bytes: st.size }, system, tools, deferred: [...deferred].sort(), attachments, messages, usage };
}
