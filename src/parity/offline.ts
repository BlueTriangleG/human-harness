// 对照工具的断网、断进程：场景子进程里假 fetch 以外的出口——http / https / http2、net、tls、dgram、dns、全局 WebSocket，
// 和 child_process 起进程的七个函数、把整个进程换成别的程序的 process.execve——一律先记一条（net / spawn）再抛错。
// 树里跑命令只该走注入的 Runner（记录用的假的）；测试的探针（HH_PARITY_PROBE）直接连网、起进程也留在记录里。
// 这一层和 fence.ts 一样是早一步的、留记录的拒绝；真拦得全的是内核沙箱（sandbox.ts：没有网，换出去的程序也只写得了草稿区）。
import childProcess from "node:child_process";
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";
import type { Sink } from "./recorder.ts";

/** 连哪儿：url 字符串、URL、(端口, 主机)、选项对象（host / hostname / port / path / socketPath） */
function targetOf(args: unknown[]): string {
  const [a, b] = args;
  if (typeof a === "string") return a;
  if (a instanceof URL) return a.href;
  if (typeof a === "number") return `${typeof b === "string" ? b : "localhost"}:${a}`;
  if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    if (typeof o.socketPath === "string") return o.socketPath;
    if (typeof o.path === "string" && o.host === undefined && o.hostname === undefined && o.port === undefined) return o.path;
    const host = String(o.hostname ?? o.host ?? "localhost");
    return `${host}${o.port !== undefined ? `:${String(o.port)}` : ""}${typeof o.path === "string" ? o.path : ""}`;
  }
  return String(a);
}

/** 装上；返回拆掉的函数（只给测试用：场景子进程装上就不再拆） */
export function installOffline(rec: Sink): () => void {
  const saved: Array<[object, string, PropertyDescriptor | undefined]> = [];
  const replace = (obj: object, name: string, value: unknown): void => {
    const d = Object.getOwnPropertyDescriptor(obj, name);
    saved.push([obj, name, d]);
    Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: d?.enumerable ?? false });
  };
  const offNet = (api: string, target: (args: unknown[]) => string = targetOf) => function (...args: unknown[]): never {
    const where = target(args);
    rec.add("net", { api, target: where });
    throw new Error(`parity: network is off (${where})`);
  };
  replace(http, "request", offNet("http.request"));
  replace(http, "get", offNet("http.get"));
  replace(https, "request", offNet("https.request"));
  replace(https, "get", offNet("https.get"));
  replace(http2, "connect", offNet("http2.connect"));
  replace(net, "connect", offNet("net.connect"));
  replace(net, "createConnection", offNet("net.createConnection"));
  replace(net.Socket.prototype, "connect", offNet("net.Socket.connect"));
  replace(tls, "connect", offNet("tls.connect"));
  const socketType = (args: unknown[]): string => {
    const o = args[0];
    return typeof o === "string" ? o : String((o as { type?: unknown } | undefined)?.type);
  };
  replace(dgram, "createSocket", offNet("dgram.createSocket", socketType));
  replace(dgram, "Socket", offNet("dgram.Socket", socketType));
  // 域名解析：模块上的、promise 版的、Resolver 实例的 lookup / lookupService / reverse / resolve*（以后加的 resolveXxx 也算）
  const isLookup = (k: string): boolean => /^(lookup|reverse|resolve)/.test(k);
  const offDns = (api: string, promise: boolean) => {
    const f = offNet(api, (args) => String(args[0]));
    return promise ? (...args: unknown[]) => { try { return f(...args); } catch (e) { return Promise.reject(e); } } : f;
  };
  for (const [obj, name, promise] of [
    [dns, "dns", false], [dns.promises, "dns.promises", true],
    [dns.Resolver.prototype, "dns.Resolver", false], [dns.promises.Resolver.prototype, "dns.promises.Resolver", true],
  ] as const) {
    for (const k of Object.getOwnPropertyNames(obj)) {
      if (isLookup(k) && typeof (obj as unknown as Record<string, unknown>)[k] === "function") replace(obj, k, offDns(`${name}.${k}`, promise));
    }
  }
  // new WebSocket(url) 和直接调都拦（函数当构造器用，抛了就没有实例）
  replace(globalThis, "WebSocket", offNet("WebSocket"));

  const offSpawn = (api: string) => function (...args: unknown[]): never {
    const cmd = String(args[0]);
    rec.add("spawn", { api, cmd, args: Array.isArray(args[1]) ? args[1].map(String) : [] });
    throw new Error(`parity: processes are off (${cmd})`);
  };
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const) {
    replace(childProcess, name, offSpawn(`child_process.${name}`));
  }
  if (typeof process.execve === "function") replace(process, "execve", offSpawn("process.execve"));
  syncBuiltinESMExports();
  return () => {
    for (const [obj, name, d] of saved.reverse()) {
      if (d) Object.defineProperty(obj, name, d);
      else delete (obj as Record<string, unknown>)[name];
    }
    syncBuiltinESMExports();
  };
}
