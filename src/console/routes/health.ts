// 顺不顺：这一周的五个数（/api/numbers）；最近 24 小时每个小时的内核请求数、被停 / 被拒的次数、hhd 被卡住多久，和按每次上线切开的那几段。只有数和上线记录；五分钟内不重读文件。
import { IncidentScanner } from "../../metrics/incidents.ts";
import { healthView } from "../health.ts";
import { UsageScanner } from "../../metrics/usage.ts";
import { weeklyView } from "../weekly.ts";
import { fail, ok } from "./types.ts";
import type { Routes, Site } from "./types.ts";

export function healthRoutes({ o, now, withDb }: Site): Routes {
  // 有人要才读文件，读到哪了记在它里面（这个进程活着就一直接着读）
  const incidents = o.incidents ? new IncidentScanner(o.incidents) : null;
  // 这一周的用量当量：会话记录在后台接着读（第一遍要读最近三周动过的全部记录），读到哪了记在它里面、也存进缓存文件
  const n = o.numbers;
  // 按哪些目录认去向（HH 自己的工作区、回放、团队）：读会话记录和算那几个数用同一份
  const dirs = n ? { workspace: n.workspace, replay: n.replay, ...(n.team?.length ? { team: n.team } : {}) } : null;
  const usage = n && dirs ? new UsageScanner({ projectsDir: n.projectsDir, dirs, tz: n.tz, ...(n.cacheFile ? { cacheFile: n.cacheFile } : {}) }) : null;
  return {
    // 这一周：五个数一天一行，加前七天的对比。库和日志那几样现算；用量没读完时 usage.ready 是 false
    "/api/numbers": ({ tx }) => {
      if (!n || !usage || !dirs) return fail(404, tx("api.noNumbers"));
      usage.scan(now()).catch(() => undefined);   // 不等它：读完了下一次请求就带上
      return ok(withDb((d) => weeklyView(d, { logPath: o.logPath, tz: n.tz, dirs }, usage, now())));
    },
    "/api/incidents": ({ tx }) => (incidents
      ? incidents.scan(now()).then((r) => ok(healthView(r, { stateDir: o.incidents?.stateDir, configPath: o.incidents?.configPath }, incidents)))
      : fail(404, tx("api.noIncidents"))),
  };
}
