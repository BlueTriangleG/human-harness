// 完整输入：某个脑区这个会话完整收到了什么，和它最近的会话。
import { existsSync } from "node:fs";
import { request } from "../../control.ts";
import { listSessions, parsePrompt } from "../prompt.ts";
import { fail, ok } from "./types.ts";
import type { Reply, Routes, Site } from "./types.ts";

/** 脑区 id → 角色（side-2 → side，perception-messages → perception） */
export function roleOf(region: string): string {
  if (region.startsWith("side-")) return "side";
  if (region.startsWith("perception-")) return "perception";
  return region;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REGION = /^[a-z0-9-]{1,40}$/;
const RECENT_MS = 3 * 86_400_000;

export function promptRoutes({ o, now }: Site): Routes {
  return {
    // 某个脑区最近的会话（?region=）
    "/api/prompt/sessions": ({ q, tx }) => {
      const p = o.prompt;
      const region = q.get("region") ?? "";
      if (!p || !REGION.test(region)) return fail(400, tx("api.needRegion"));
      return ok({ sessions: listSessions(p.dir, p.markers, now() - RECENT_MS).filter((x) => x.role === roleOf(region)).slice(0, 15) });
    },
    // 某个脑区这个会话完整收到了什么（?region= 或 ?session=）
    "/api/prompt": async ({ q, tx }) => {
      const p = o.prompt;
      if (!p) return fail(404, tx("api.noPrompt"));
      const open = (sid: string | null, how: string): Reply => {
        if (!sid || !SESSION_ID.test(sid)) return fail(404, tx("api.noSession"));
        const file = `${p.dir}/${sid}.jsonl`;
        if (!existsSync(file)) return fail(404, tx("api.noSessionFile", { id: sid }));
        return ok({ how, ...parsePrompt(file) });
      };
      const sid = q.get("session");
      if (sid) return open(sid, tx("api.howGiven"));
      const region = q.get("region") ?? "";
      if (!REGION.test(region)) return fail(400, tx("api.needRegionOrSession"));
      // 先问 hhd 这个脑区现在用的是哪个会话；问不到（或者那个会话读不出来）再按开场白找最近的
      try {
        const st = await request(o.sockPath, { cmd: "status" }, 3000) as { regions?: Array<{ id: string; sessionId?: string | null }> };
        const r = st.regions?.find((x) => x.id === region);
        if (r?.sessionId) return open(r.sessionId, tx("api.howStatus"));
      } catch { /* 问不到 */ }
      const latest = listSessions(p.dir, p.markers, now() - RECENT_MS).find((x) => x.role === roleOf(region));
      return open(latest?.id ?? null, tx("api.howOpening"));
    },
  };
}
