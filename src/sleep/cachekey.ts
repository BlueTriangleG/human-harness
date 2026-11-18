// 一个会话的哪些东西会进内核发给模型的请求（sdk.ts 的 options()）：模型、系统提示、工具（名字、说明、参数的 schema）、内置工具、
// 目录、权限、环境、插件。两个会话要共用开头的缓存，这些得一字不差——这里每样给一个短哈希，好比、好记日志。
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SessionSpec } from "../kernel/types.ts";

const sha = (v: unknown): string => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v ?? null)).digest("hex").slice(0, 12);

/** 工具的参数照内核那样转成 JSON schema（转不了的照键名算） */
const schemaOf = (shape: SessionSpec["tools"][number]["shape"]): unknown => {
  try { return z.toJSONSchema(z.object(shape)); } catch { return Object.keys(shape); }
};

export type CacheKeyInput = Pick<SessionSpec, "model" | "systemAppend" | "cwd" | "permissionMode" | "tools">
  & Partial<Pick<SessionSpec, "fallbackModel" | "env" | "claudeExecutable" | "allowedTools" | "mcpServers" | "plugins" | "builtinTools">>;

/** 每样一个短哈希（模型原样）：键是固定的那几个，两份一比就知道哪样不一样 */
export function cacheKeyOf(spec: CacheKeyInput): Record<string, string> {
  return {
    model: spec.model,
    fallbackModel: spec.fallbackModel ?? "",
    systemAppend: sha(spec.systemAppend),
    tools: sha(spec.tools.map((t) => [t.name, t.description, schemaOf(t.shape)])),
    builtinTools: sha(spec.builtinTools ?? null),
    allowedTools: sha(spec.allowedTools ?? null),
    cwd: sha(spec.cwd),
    permissionMode: spec.permissionMode,
    env: sha(Object.entries(spec.env ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    claudeExecutable: sha(spec.claudeExecutable ?? null),
    mcpServers: sha(Object.keys((spec.mcpServers as Record<string, unknown> | undefined) ?? {}).sort()),
    plugins: sha(spec.plugins ?? null),
  };
}
