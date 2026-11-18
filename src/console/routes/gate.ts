// 下意识（闸门）某一天的账（?day=YYYY-MM-DD，默认她的今天）：统计 + 最新 500 行；访客私聊不出原文。直接读库。
import { localDay } from "../../learning/score.ts";
import { gateDayRange, gateView, readPrivacy } from "../gate.ts";
import { fail, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function gateRoutes({ o, now, withDb }: Site): Routes {
  return {
    "/api/gate": ({ q, tx }) => {
      const g = o.gate;
      if (!g) return fail(404, tx("api.noGate"));
      const today = localDay(now(), g.tz);
      const day = q.get("day") || today;
      if (!gateDayRange(day, g.tz)) return fail(400, tx("api.badDay"));
      // 名单和批准底子每次现读（很小）：改了马上按新的遮
      return ok(withDb((d) => gateView(d, day, today, g, readPrivacy(d, g.workspace))));
    },
  };
}
