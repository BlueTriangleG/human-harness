// computer: the Mac's screen, mouse, keyboard and apps, driven through the gateway's Mac node. A region has it only when
// the instance lists it in tools.extra (src/regions/specs.ts).
import { z } from "zod";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import type { ToolDef } from "../kernel/types.ts";
import type { ToolContext } from "./hhtools.ts";
import type { GatewayCaller } from "../gateway/client.ts";
import { GatewayError, idempotencyKey } from "../gateway/client.ts";
import { T } from "../lang/index.ts";

/** 这台电脑闲了多久收掉 execution（下次用再开；窗口、按钮、截图帧的引用跟着作废，要重新看） */
export const COMPUTER_IDLE_MS = 5 * 60_000;

/**
 * computer 的 executionId（#0038：OpenClaw 2026.10.7 起 computer.act 必须带，UUID 格式；同一时间只有一个 execution 占着这台电脑，
 * 换个 id 就报 COMPUTER_HOST_BUSY；窗口、按钮、截图帧的引用只在同一个 execution 里认）。
 * 按 HH 自己的目录算出一个固定的：hhd 重启后接着用同一个，不会被自己上次没收的那个占住
 */
export function computerExecutionId(seed: string): string {
  const h = createHash("sha1").update(`hh-computer:${seed}`).digest("hex");
  const variant = (8 | (parseInt(h[16]!, 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** 这台电脑的 execution 开着、等着闲够了收：计时、怎么收（一台电脑一个：每用一次往后推） */
let computerOpen: { timer: ReturnType<typeof setTimeout>; close: (waitMs: number, reason: string) => Promise<void>; gateway: GatewayCaller } | undefined;
/** 最近一次用到的节点：这一次 node.list 出错时，收尾照样发给它（不然排好的收尾被取消、再也不收，复核 092d98b0） */
let computerNode: string | undefined;
/** 上次收尾节点那边回了错：OpenClaw 2026.10.7 收不掉就一直卡着（同一个错误反复报），要重启 Mac 上的 OpenClaw（传输超时、断线不算：节点没卡） */
let computerCloseFailed = false;

/**
 * 排上闲够了收：__close_execution。reason 不用 completion：一收，这次的下载、录屏的句柄就都作废了（她拿不到真实路径），
 * completion 只是不删 /tmp 里的目录，留着也没人用、没人清（复核 c477231e）
 */
function armComputerClose(gateway: GatewayCaller, nodeId: string, executionId: string, log: ToolContext["log"]): void {
  if (computerOpen) clearTimeout(computerOpen.timer);
  const close = async (waitMs: number, reason: string): Promise<void> => {
    try {
      await gateway.request("node.invoke", {
        nodeId, command: "computer.act", params: { action: "__close_execution", executionId, reason },
        idempotencyKey: idempotencyKey(), timeoutMs: waitMs,
      }, waitMs + 5_000);
      computerCloseFailed = false;
    } catch (e) {
      if (e instanceof GatewayError) {
        computerCloseFailed = true;
        log?.error("computer: closing the execution failed — if computer keeps failing with the same error, OpenClaw on the Mac needs a restart", { error: String(e).slice(0, 200) });
      } else log?.warn("computer: closing the execution didn't get through", { error: String(e).slice(0, 200) });
    }
  };
  const timer = setTimeout(() => { computerOpen = undefined; void close(30_000, "idle"); }, COMPUTER_IDLE_MS);
  timer.unref?.();
  computerOpen = { timer, close, gateway };
}

/**
 * 马上收掉还开着的 execution（hhd 退出前：计时器跟着进程没了，execution 就一直占着电脑）；没开着就什么也不做。
 * 网关断着就不收：request 会先重连（最多 15 秒），退出会被拖到 launchd 强杀；下次用时接着用同一个 id，到点再收
 */
export async function closeComputerNow(waitMs = 5_000): Promise<void> {
  const open = computerOpen;
  if (!open) return;
  clearTimeout(open.timer);
  computerOpen = undefined;
  if (open.gateway.connected) await open.close(waitMs, "hhd-exit");
}

/** 经网关让 Mac 节点做事（OpenClaw 原来的 computer 工具也是这条路）：截图、点击都在同一个 execution 里，闲了收掉 */
export async function computerAct(ctx: ToolContext, action: string, params: Record<string, unknown>): Promise<string> {
  const gateway = ctx.gateway;
  if (!gateway) return T.computer.noGateway;
  const executionId = computerExecutionId(ctx.shotsDir ?? "hh");
  if (computerOpen) clearTimeout(computerOpen.timer);   // 用着不收：这一步做完再重新算
  let node: string | undefined;
  try {
    const list = await gateway.request<{ activeNodeId?: string; nodes?: Array<{ nodeId: string; commands?: string[] }> }>("node.list", {});
    node = list.nodes?.find((n) => n.commands?.includes("computer.act"))?.nodeId ?? list.activeNodeId;
    if (!node) return T.computer.noNode;
    computerNode = node;
    const shot = action === "screenshot";
    const res = await gateway.request("node.invoke", {
      nodeId: node, command: shot ? "screen.snapshot" : "computer.act", params: shot ? { ...params, executionId } : { action, ...params, executionId },
      idempotencyKey: idempotencyKey(), timeoutMs: 60_000,
    }, 90_000);
    computerCloseFailed = false;
    return JSON.stringify(saveImages(res, ctx.shotsDir ?? "/tmp")).slice(0, 6000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("COMPUTER_DESKTOP_LOCKED")) return T.computer.locked;
    if (msg.includes("COMPUTER_HOST_BUSY")) return T.computer.busy;
    return T.computer.failed(msg.slice(0, 400), computerCloseFailed);
  } finally {
    // 出错了也照样到点收（引用作废是正常的，下次重新看就行）；这一次没拿到节点就发给上次那个
    const nodeId = node ?? computerNode;
    if (nodeId) armComputerClose(gateway, nodeId, executionId, ctx.log);
  }
}

/** 结果里的大段 base64 图片存成文件，换成路径（她用 Read 看） */
function saveImages(v: unknown, dir: string, n = { i: 0 }): unknown {
  if (typeof v === "string") {
    const m = /^data:image\/(\w+);base64,(.+)$/s.exec(v);
    const b64 = m ? m[2]! : v.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 2000)) ? v : null;
    if (!b64) return v;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `shot-${Date.now()}-${n.i++}.${m?.[1] ?? "png"}`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    return T.computer.imageSaved(file);
  }
  if (Array.isArray(v)) return v.map((x) => saveImages(x, dir, n));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, saveImages(x, dir, n)]));
  return v;
}

export function computerTool(ctx: ToolContext): ToolDef {
  return {
    name: "computer",
    description: T.computer.description,
    shape: { action: z.string(), params: z.record(z.string(), z.unknown()).optional() },
    handler: async (a) => computerAct(ctx, String(a.action), (a.params as Record<string, unknown> | undefined) ?? {}),
  };
}
