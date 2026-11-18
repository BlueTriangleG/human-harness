// 控制台的路由：一页一个文件，各自登记自己的接口（地址 → 处理函数）。
// server.ts 只管守门（只认本机、只读）、选语言、把结果写出去；这里的处理函数只管取数，返回「状态码 + 内容」，不碰请求和响应本身。
import type { DatabaseSync } from "node:sqlite";
import type { ConsoleOptions } from "../server.ts";
import type { Translate } from "../lang/index.ts";

/** 每个请求共用的：配置、钟、只读的库连接 */
export interface Site {
  o: ConsoleOptions;
  now: () => number;
  /** 用只读连接做一件事；出错就把连接关掉，下次重开 */
  withDb: <T>(fn: (d: DatabaseSync) => T) => T;
}

/** 一次请求：地址里的参数、按看的人的语言出字 */
export interface Call {
  q: URLSearchParams;
  tx: Translate;
  /** 一个错说成一句话（带着包里条目的错按看的人的语言出） */
  told: (e: unknown) => string;
}

export interface Reply { code: number; body: unknown }
export type Handler = (c: Call) => Reply | Promise<Reply>;
/** 一页的接口：地址 → 处理函数 */
export type Routes = Readonly<Record<string, Handler>>;

export const ok = (body: unknown): Reply => ({ code: 200, body });
export const fail = (code: number, error: string): Reply => ({ code, body: { error } });

/** 地址里的数字参数：没给、不是数都当没给 */
export function num(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
