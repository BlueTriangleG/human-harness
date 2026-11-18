// 结构化日志：每行一条 JSON，写进 <stateDir>/logs/hh.jsonl；测试里可以换成内存收集。
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Level = "debug" | "info" | "warn" | "error";
export interface LogRecord { t: string; level: Level; mod: string; msg: string; [k: string]: unknown }
export type Sink = (r: LogRecord) => void;

export class Logger {
  readonly mod: string;
  private readonly sink: Sink;
  constructor(mod: string, sink: Sink) {
    this.mod = mod;
    this.sink = sink;
  }
  child(mod: string): Logger { return new Logger(`${this.mod}.${mod}`, this.sink); }
  private emit(level: Level, msg: string, extra?: Record<string, unknown>) {
    this.sink({ t: new Date().toISOString(), level, mod: this.mod, msg, ...extra });
  }
  debug(msg: string, extra?: Record<string, unknown>) { this.emit("debug", msg, extra); }
  info(msg: string, extra?: Record<string, unknown>) { this.emit("info", msg, extra); }
  warn(msg: string, extra?: Record<string, unknown>) { this.emit("warn", msg, extra); }
  error(msg: string, extra?: Record<string, unknown>) { this.emit("error", msg, extra); }
}

export function fileSink(stateDir: string, echo = false): Sink {
  const dir = join(stateDir, "logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "hh.jsonl");
  return (r) => {
    const line = JSON.stringify(r);
    appendFileSync(path, line + "\n");
    if (echo) console.log(line);
  };
}

export function memorySink(into: LogRecord[]): Sink { return (r) => { into.push(r); }; }
