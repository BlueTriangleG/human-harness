// 事件记忆：总览、事件、人和东西、人物卡、原话层、某一批改了什么、中期视图。
// 全部直接只读查 hh.db，不经 hhd：翻看不算她碰过，不影响淡忘。
import { batchOps, entityList, eventDetail, eventList, midtermView, overview, quoteList, vectorStatus } from "../events.ts";
import { peopleCards, personCard } from "../people.ts";
import { estimateTokens } from "../../memory/tokens.ts";
import { fail, num, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function eventRoutes({ o, now, withDb }: Site): Routes {
  const cards = () => ({ template: o.people?.template, tz: o.people?.tz ?? "UTC", now: now() });
  return {
    // 总览：数量、批次、开关、中期视图有没有
    "/api/event-memory": () => {
      const m = o.memory;
      const mt = m ? midtermView(m.stateDir) : null;
      return ok({
        flags: m?.events ?? null,
        ...withDb((d) => overview(d, now())),
        midterm: mt ? { mtime: mt.mtime, chars: mt.chars, tokens: estimateTokens(mt.text) } : null,
        vectors: m ? vectorStatus(m.stateDir) : null,
      });
    },
    // 事件列表（?q= ?status= ?who=<实体编号> ?min=<重要度>）
    "/api/event-memory/events": ({ q }) => {
      const min = num(q.get("min"));
      return ok(withDb((d) => eventList(d, now(), {
        ...(q.get("q") ? { q: q.get("q")! } : {}), ...(q.get("status") ? { status: q.get("status")! } : {}),
        ...(q.get("who") ? { who: q.get("who")! } : {}), ...(min !== undefined ? { min } : {}),
      })));
    },
    // 一件事的全部（?id=e…，或条目编号 n…）
    "/api/event-memory/event": ({ q, tx }) => {
      const d = withDb((db) => eventDetail(db, q.get("id") ?? "", now()));
      if (!d) return fail(404, tx("api.noEvent", { id: q.get("id") ?? "" }));
      return ok(d);
    },
    // 人物卡：有卡的人和群（关系、合计 / 上限、待批几条）
    "/api/event-memory/people": () => ok(withDb((db) => peopleCards(db, cards()))),
    // 一张人物卡（?id=t…）：公开那一面、待批、改动记录（访客私密的不出原文）
    "/api/event-memory/person": ({ q, tx }) => {
      const id = q.get("id") ?? "";
      if (!id) return fail(400, tx("api.needPersonId"));
      const c = withDb((db) => personCard(db, id, cards()));
      if (!c) return fail(404, tx("api.noCard", { id }));
      return ok(c);
    },
    // 人和东西
    "/api/event-memory/entities": () => ok({ entities: withDb(entityList) }),
    // 原话层（?q= ?src= ?who= ?offset=）
    "/api/event-memory/quotes": ({ q }) => {
      const offset = num(q.get("offset")), limit = num(q.get("limit"));
      return ok(withDb((d) => quoteList(d, {
        ...(q.get("q") ? { q: q.get("q")! } : {}), ...(q.get("src") ? { src: q.get("src")! } : {}), ...(q.get("who") ? { who: q.get("who")! } : {}),
        ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}),
      })));
    },
    // 某一批改了什么（?id=）
    "/api/event-memory/batch": ({ q, tx }) => {
      const id = q.get("id") ?? "";
      if (!id || id.length > 300) return fail(400, tx("api.needBatch"));
      return ok(withDb((d) => batchOps(d, id)));
    },
    // 中期视图全文
    "/api/event-memory/midterm": ({ tx }) => {
      const mt = o.memory ? midtermView(o.memory.stateDir) : null;
      if (!mt) return fail(404, tx("api.noMidterm"));
      return ok({ ...mt, tokens: estimateTokens(mt.text), inPrefix: Boolean(o.memory?.events?.midterm) });
    },
  };
}
