// hh 命令行的解析（从 cli.ts 拆出来好测）：认 --help、tell 要写清是谁、不发空消息。
import { readFileSync } from "node:fs";
import { peopleRequest, gateRequest, sleepRequest, UsageError } from "./control.ts";
import type { Request } from "./control.ts";
import { REPLAY_CONFIRM } from "./sleep/stopped.ts";
import { B, S } from "./lang/index.ts";

/** 用法：cli.ts 开头那段注释（只这一份，改命令时一起改） */
export function usage(): string {
  const src = readFileSync(new URL("./cli.ts", import.meta.url), "utf8").split("\n");
  const out: string[] = [];
  for (const l of src) { if (!l.startsWith("//")) break; out.push(l.replace(/^\/\/ ?/, "")); }
  return out.join("\n");
}

/**
 * 要看用法：任何一个参数正好是 --help 或 -h，或者头一个是 help。认出来就只打用法、什么都不做
 * （11-13 睡眠那头敲 hh tell --help，发了一条「--help」给她、记成主人说的；#0050 的「--help」帮手是同一类）
 */
export function wantsHelp(argv: readonly string[]): boolean {
  // hh modules run <module> <script> …: what follows the script is the script's own
  const own = argv[0] === "modules" && argv[1] === "run" ? argv.slice(0, 4) : argv;
  return own[0] === "help" || own.some((a) => a === "--help" || a === "-h");
}

/** 名单里的主人叫什么（privacy 是 owner 的那一条；name 没写就用 key）；没有就 null */
export function ownerNameOf(registry: Record<string, unknown>): string | null {
  for (const [key, e] of Object.entries(registry)) {
    if (key.startsWith("_") || typeof e !== "object" || e === null || Array.isArray(e)) continue;
    const r = e as Record<string, unknown>;
    if (r.privacy === "owner") return typeof r.name === "string" && r.name ? r.name : key;
  }
  return null;
}

/**
 * interactive：在人自己的终端里敲的（标准输入输出都是终端）。只有这时 tell 可以不写 --from，按名单里的主人发；
 * 会话、脚本里跑的一律要写清是谁（11-12 19:39 不带参数发了一条空的、11-13 08:16 发了「--help」，都记成了主人说的）
 */
export function parse(argv: string[], o: { interactive?: boolean; owner?: () => string | null } = {}): Request {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case "status": return { cmd: "status" };
    case "tell": {
      const TELL = B.cliParse.tellUsage;
      let from: string | undefined;
      const i = rest.indexOf("--from");
      if (i >= 0) {
        from = rest[i + 1];
        rest.splice(i, 2);
        if (!from?.trim() || from.startsWith("-")) throw new UsageError(B.cliParse.tellFromMissing(TELL));
      }
      const text = rest.join(" ").trim();
      if (!text) throw new UsageError(B.cliParse.tellTextEmpty(TELL));
      if (from === undefined) {
        if (!o.interactive) throw new UsageError(B.cliParse.tellFromRequired(TELL));
        const owner = o.owner?.() ?? null;
        if (!owner) throw new UsageError(B.cliParse.tellOwnerUnknown(TELL));
        from = owner;
      }
      return { cmd: "tell", from, text };
    }
    case "wake": return { cmd: "wake", region: rest[0] ?? "main", text: rest.slice(1).join(" ") };
    case "events": return { cmd: "events", n: rest[0] ? Number(rest[0]) : 30 };
    case "sleep": {
      const req = sleepRequest(rest);
      // 回放要明说（sleep/stopped.ts）：没加 --i-know-it-spends-quota 在这里就停下、不连 hhd（打到 stderr、退出码 1）；hhd 那边照样再核
      if (req.cmd === "sleep-replay" && req.iKnowItSpendsQuota !== true) throw new Error(S.stopped.replayRefused(REPLAY_CONFIRM, REPLAY_CONFIRM));
      return req;
    }
    case "pageturn": return { cmd: "pageturn" };
    case "mem": return { cmd: "mem", action: rest[0] ?? "stats", args: rest.slice(1) };
    case "people": return peopleRequest(rest);
    case "gate": return gateRequest(rest);
    case "learn": return { cmd: "learn", action: rest[0] ?? "stats", args: rest.slice(1) };
    case "sense": {
      const i = rest.indexOf("--file");
      const raw = i >= 0 ? readFileSync(rest[i + 1] ?? "", "utf8") : rest.join(" ");
      // 带字段的唤醒文件是 JSON：{"text": …, "events": […]}；旧的纯文字照常
      if (raw.trimStart().startsWith("{")) {
        try {
          const j = JSON.parse(raw) as { text?: unknown; events?: unknown };
          if (typeof j.text === "string") return { cmd: "sense", text: j.text, events: j.events };
        } catch { /* 不是 JSON，当纯文字 */ }
      }
      return { cmd: "sense", text: raw };
    }
    case "work": {
      // hh work add <when|now> <分钟> <为什么…> [--every daily] / hh work ls / hh work rm <id> / hh work stop
      const action = rest[0] ?? "ls";
      if (action === "ls") return { cmd: "work", action: "ls" };
      if (action === "stop") return { cmd: "work", action: "stop" };
      if (action === "rm") return { cmd: "work", action: "rm", id: Number(rest[1]) };
      if (action === "add") {
        const args = rest.slice(1);
        let every: string | undefined;
        const i = args.indexOf("--every");
        if (i >= 0) { every = args[i + 1]; args.splice(i, 2); }
        const [when, minutes, ...why] = args;
        if (!when || !minutes || !why.length) throw new Error(B.cliParse.workAddUsage);
        return { cmd: "work", action: "add", when, minutes: Number(minutes), why: why.join(" "), ...(every ? { every } : {}) };
      }
      throw new Error(B.cliParse.workUnknownAction(action));
    }
    default: throw new Error(B.cliParse.unknownCommand(cmd));
  }
}

