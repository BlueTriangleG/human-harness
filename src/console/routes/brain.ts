// 大脑那一页：中央记忆的一段和活动条、hhd 的状态、右栏的帮手 / 日志 / 学习。（直播 /api/stream 要一直开着连接，在 server.ts 里）
import { request } from "../../control.ts";
import { activity, events, findTranscript, hiddenThinking, logTail, maxSeq, tailLines, transcriptSteps, validName, workers } from "../data.ts";
import { learnView } from "../learn.ts";
import { fail, num, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function brainRoutes({ o, now, withDb }: Site): Routes {
  return {
    // 中央记忆一段（?after= / ?before= / ?limit=）
    "/api/central": ({ q }) => {
      const after = num(q.get("after")), before = num(q.get("before")), limit = num(q.get("limit"));
      const src = q.get("src");   // 只要这一个脑区的（只看一个脑区时，页面拿它往前翻）
      const rows = withDb((d) => events(d, { ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}), ...(limit !== undefined ? { limit } : {}), ...(src ? { src } : {}) }));
      return ok({ rows, maxSeq: withDb(maxSeq) });
    },
    // 最近 60 分钟每个脑区每分钟几条
    "/api/activity": ({ q }) => ok(withDb((d) => activity(d, now(), Math.max(10, Math.min(num(q.get("minutes")) ?? 60, 360))))),
    // hhd 的 status（经 hh.sock）；问不到也是 200，页面要显示「hhd 没有回应」
    "/api/status": ({ told }) => request(o.sockPath, { cmd: "status" }, 4000)
      .then((s) => ok({ ok: true, status: s }), (e: unknown) => ok({ ok: false, error: told(e) })),
    // 她派出去的 Claude Code 会话
    "/api/workers": () => ok({ configured: o.helperSessionsDir !== undefined, workers: o.helperSessionsDir !== undefined ? workers(o.helperSessionsDir, o.projectsDir) : [] }),
    // 某个会话的过程（?name=）
    "/api/worker": ({ q, tx }) => {
      const name = q.get("name") ?? "";
      if (!validName(name)) return fail(400, tx("api.badName"));
      const w = o.helperSessionsDir !== undefined ? workers(o.helperSessionsDir, o.projectsDir).find((x) => x.name === name) : undefined;
      if (!w) return fail(404, tx("api.noWorker", { name }));
      const t = w.sessionId ? findTranscript(o.projectsDir, w.sessionId) : null;
      if (!t) return ok({ worker: w, steps: [], thinking: { shown: 0, hidden: 0 }, note: tx("api.noTranscript") });
      const lines = tailLines(t, 3_000_000);
      return ok({ worker: w, steps: transcriptSteps(lines, Math.min(num(q.get("limit")) ?? 400, 1500)), thinking: hiddenThinking(lines) });
    },
    // hhd 日志（?level=warn&n=200）
    "/api/log": ({ q }) => ok({ lines: logTail(o.logPath, Math.min(num(q.get("n")) ?? 200, 2000), q.get("level") ?? "info") }),
    // 学习：最近 7 天的每周数字、最近 20 次联想、今天的花费、告警（直接读库，书架只读地扫，不发号）
    "/api/learn": ({ tx }) => {
      const l = o.learning;
      if (!l) return fail(404, tx("api.noLearning"));
      return ok(withDb((d) => learnView(d, now(), l)));
    },
  };
}
