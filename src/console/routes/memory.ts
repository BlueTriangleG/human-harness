// 记忆那一面：一页一页、压缩记忆、前缀组成、长期记忆、回想；某段压缩记忆、某个记忆文件的全文。
import { areas, blockList, blockText, centralTotals, organizer, pages, prefixParts, readMemoryFile, recallCalls, recentlyChanged, skillsArea, wakeOpenings } from "../memory.ts";
import { midtermView, overview } from "../events.ts";
import { scanShelf } from "../../learning/notebook.ts";
import { renderShelf } from "../../learning/shelf.ts";
import { fail, num, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function memoryRoutes({ o, now, withDb }: Site): Routes {
  return {
    "/api/memory": ({ tx }) => {
      const m = o.memory;
      if (!m) return fail(404, tx("api.noMemory"));
      return ok(withDb((d) => {
        const bl = blockList(d);
        const active = bl.filter((b) => b.cleared === null).reverse();
        const ar = areas(m.workspace, m.layout);
        return {
          limits: m.limits,
          night: m.night ?? null,
          central: centralTotals(d, now()),
          pages: pages(d, 60, now()),
          blocks: bl,
          prefix: prefixParts(m.workspace, m.files, m.runtimeNote, active, {
            ...(m.frame ? { frame: m.frame } : {}), ...(m.memoryFiles ? { files: m.memoryFiles } : {}),
            midterm: m.events?.midterm ? midtermView(m.stateDir)?.text ?? null : null,
            shelf: o.learning?.shelf ? renderShelf(scanShelf(o.learning.root, o.learning.generalCategory, o.learning.archiveDir)) : null,
          }),
          areas: ar.map(({ list, ...rest }) => ({ ...rest, list: list.slice(0, 60) })),
          recent: recentlyChanged(ar, m.files, m.workspace, now() - 36 * 3600_000),
          organizer: organizer(m.workspace, m.sleepDir),
          wakes: wakeOpenings(m.stateDir),
          recall: recallCalls(d),
          skills: ((a) => (a ? { ...a, list: a.list.slice(0, 80) } : null))(skillsArea(m.workspace, m.skillsDir, m.layout)),
          events: ((v) => ({ flags: m.events ?? null, ready: v.ready, counts: v.counts, clarity: v.clarity, lastWrite: v.lastWrite }))(overview(d, now())),
        };
      }));
    },
    // 某段压缩记忆全文（?id=）
    "/api/memory/block": ({ q, tx }) => {
      const id = num(q.get("id"));
      const text = id === undefined ? null : withDb((d) => blockText(d, id));
      if (text === null) return fail(404, tx("api.noBlock"));
      return ok({ id, text });
    },
    // 某个记忆文件全文（?key=ws:… 工作区里的记忆文件，wake:… 早上的开头存档）
    "/api/memory/file": ({ q, tx }) => {
      const m = o.memory;
      const f = m ? readMemoryFile(q.get("key") ?? "", m) : null;
      if (!f) return fail(404, tx("api.fileOutOfRange"));
      return ok(f);
    },
  };
}
