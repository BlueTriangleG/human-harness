// 笔记：书架上每一页的层、重要度、多久没翻，和页之间的线（/api/notebook）。只读；层是按请求那一刻现算的。
import { notebookView } from "../notebook.ts";
import { fail, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function notebookRoutes({ o, now, withDb }: Site): Routes {
  return {
    "/api/notebook": ({ tx }) => {
      const l = o.learning;
      if (!l) return fail(404, tx("api.noLearning"));
      return ok(withDb((d) => notebookView(d, now(), l)));
    },
  };
}
