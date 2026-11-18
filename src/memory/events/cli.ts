// hh mem …：给主人和 Claude Code 翻阅、维护事件库（翻看不算她碰过）。
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import type { EventMemory } from "./memory.ts";
import { renderMidterm } from "./midterm.ts";
import { fmtDay } from "./render.ts";
import { readFileSync, existsSync } from "node:fs";
import { all } from "../../store/db.ts";
import { maskImpressionOp, privateReplaced } from "./people.ts";
import { assocStats } from "./assoc.ts";
import { parseExam } from "./exam.ts";
import type { ExamAnswer, ExamQuestion } from "./exam.ts";
import { B } from "../../lang/index.ts";
import { LAYOUT } from "../../persona/layout.ts";

export interface MemCliEnv {
  exportsDir: string;
  /** 联想日志目录（assoc-stats 读） */
  assocDir?: string;
  workspace?: string;
  /** 记忆体检：用她的前缀和只读记忆工具答考卷（hh mem exam） */
  runExam?: (questions: ExamQuestion[], out: string, o: { tier?: "opus" | "sonnet" }) => Promise<ExamAnswer[]>;
  log?: (msg: string, data: Record<string, unknown>) => void;
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

export async function memCommand(mem: EventMemory, action: string, argsIn: string[], o: MemCliEnv): Promise<unknown> {
  const args = [...argsIn];
  const s = mem.store;
  switch (action) {
    case "stats": return mem.stats();
    case "ls": {
      const status = opt(args, "--status");
      const who = opt(args, "--who");
      let evs = s.allEvents();
      if (status) evs = evs.filter((e) => e.status === status);
      if (who) { const t = s.entity(who); const ids = new Set(t ? s.eventsOf(t.id).map((e) => e.id) : []); evs = evs.filter((e) => ids.has(e.id)); }
      return evs.map((e) => B.eventsCli.eventListLine(e.id, e.ended_at ? fmtDay(e.ended_at, mem.tz) : "     ", e.importance, e.status.padEnd(10), e.title, e.gist, s.entries(e.id).length)).join("\n") || B.eventsCli.eventListEmpty;
    }
    case "show": return mem.recall.event(args.join(" "), { touch: false });
    case "person": return mem.recall.person(args[0] ?? "", Number(args[1] ?? 5));
    case "search": return mem.recall.cluster(args.join(" "));
    case "associate": return mem.recall.associate(args.join(" "));
    case "period": return mem.recallPeriod(args.join(" "));
    case "reverse": return mem.reverse(args.join(" "));
    case "quotes": return mem.quotes(args.join(" "));
    case "worklist": return mem.worklist(args[0] ?? "");
    case "batches": return s.batches();
    case "ops": {
      // 人物卡（印象表）里访客私密的行：理由就是私密的 why，不给看（R24）
      const ops = s.ops(args[0] ?? "");
      // 被私密行顶掉的旧行：先看这一批自己（撤回了也在），再看库里现在的
      const inBatch = privateReplaced(ops);
      const replacedByPrivate = (id: string): boolean => inBatch.has(id) || all<{ v: string }>(s.db, "SELECT visibility v FROM mem_impression WHERE supersedes = ?", id).some((r) => r.v !== "all");
      return ops.map((x) => ({ id: x.id, at: new Date(x.at).toISOString(), op: x.op, tbl: x.tbl, key: x.key, reason: maskImpressionOp(x.tbl, x.before, x.after, x.reason, replacedByPrivate).reason }));
    }
    case "revert": { const r = s.revertBatch(args[0] ?? ""); mem.exportPeople(); return r; }   // 撤回了，人物卡跟上（P4）
    case "exam": {
      // 记忆体检：hh mem exam <考卷.json> [--tier sonnet] [--only q01,q02]；后台一道道答，结果写进 exports/exam-<时间>.json
      const run = need(o.runExam, "runExam");
      const tier = opt(args, "--tier") as "opus" | "sonnet" | undefined;
      const only = opt(args, "--only")?.split(",");
      const file = args[0];
      if (!file || !existsSync(file)) throw new Error(B.eventsCli.examUsage);
      const qs = parseExam(JSON.parse(readFileSync(file, "utf8"))).filter((q) => !only || only.includes(q.id));
      const out = join(o.exportsDir, `exam-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      void run(qs, out, tier ? { tier } : {}).then((r) => o.log?.("memory exam finished", { out, answered: r.length }), (e: unknown) => o.log?.("memory exam failed", { error: String(e) }));
      return { started: true, questions: qs.length, out };
    }
    case "entity-plan": {
      // 人和东西一次整理好：计划是 JSON 数组，每步 {op: upsert|merge|drop|tag, …}，整份一个批次（事后能 hh mem revert <批次>）。
      // 整份在一个事务里同步跑完：哪一步出错整份不算；--dry 跑完给结果再全部退掉，库里不留痕迹
      const dry = args.includes("--dry");
      const file = args.find((x) => x !== "--dry");
      if (!file || !existsSync(file)) throw new Error(B.eventsCli.entityPlanUsage);
      const plan = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
      const batch = `tidy:entities:${new Date().toISOString()}`;
      let i = 0;
      s.db.exec("BEGIN");
      try {
        s.openBatch(batch);
        for (; i < plan.length; i++) {
          const { op, ...a } = plan[i]!;
          const reason = String(a.reason ?? "");
          if (op === "upsert") s.upsertEntity(a, batch);
          else if (op === "merge") s.mergeEntities(String(a.keep), (a.others as string[]) ?? [], reason, batch);
          else if (op === "drop") s.dropEntity(String(a.name), reason, batch);
          else if (op === "tag") s.tagEntity(String(a.name), String(a.to), String(a.role ?? "with"), batch, reason);
          else throw new Error(B.eventsCli.entityPlanUnknownOp(String(op)));
        }
        s.commitBatch(batch);
        const ents = s.entities();
        const out = {
          ok: true, dry, batch: dry ? null : batch, steps: plan.length, ops: s.ops(batch).length, entities: ents.length,
          unrated: ents.filter((t) => t.importance === null).map((t) => t.name),
          list: ents.map((t) => B.eventsCli.entityPlanListLine(t.kind, t.importance ?? "?", t.name, t.aliases.length ? B.eventsCli.entityPlanAliasSuffix(t.aliases.join(B.eventsCli.entityPlanAliasSeparator)) : "", s.eventsOf(t.id).length)),
        };
        s.db.exec(dry ? "ROLLBACK" : "COMMIT");
        if (!dry) mem.exportPeople();   // 人和东西并了、删了、换了 key：人物卡跟上（P4）
        return out;
      } catch (e) {
        s.db.exec("ROLLBACK");
        return { ok: false, step: i + 1, error: e instanceof Error ? e.message : String(e) };
      }
    }
    case "export": { const p = join(o.exportsDir, "events.json"); return { path: p, events: mem.exportJson(p) }; }
    case "midterm": {
      const text = renderMidterm(mem.recall, { now: Date.now(), tz: mem.tz });
      mkdirSync(o.exportsDir, { recursive: true });
      writeFileSync(join(o.exportsDir, "midterm.md"), text);
      return text;
    }
    case "backfill": {
      let n = 0;
      const max = Number(args[0] ?? 100000);
      while (n < max) { const k = await mem.index.backfillVectors(Math.min(500, max - n)); if (!k) break; n += k; }
      return { embedded: n, missing: mem.index.missingVectors() };
    }
    case "ingest": return { quotes: mem.index.ingestCentral() };
    case "purge-noreply": return { purged: mem.index.purgeNoReply() };
    case "assoc-stats": return assocStats(mem.store.db, need(o.assocDir, "assocDir"), { now: Date.now(), days: Number(args[0] ?? 7) });
    case "card": {
      // hh mem card <谁> [--as <key>|--public]：默认（和 --public 一样）只看公开的；--as <key> 才看那个人那一面（他的私密字段）——
      // 主人批访客的卡时不该顺手看到访客私聊里的东西（R24）。--as 的 key 要是名单上真有的，不认识就报错，不悄悄退回公开的
      const usage = B.eventsCli.cardUsage;
      const hasAs = args.includes("--as");
      const asRaw = opt(args, "--as");
      if (hasAs && (asRaw === undefined || !asRaw.trim() || asRaw.startsWith("--"))) throw new Error(B.eventsCli.cardAsKeyMissing(usage));
      const pub = args.includes("--public");
      const who = args.filter((x) => x !== "--public").join(" ").trim();
      if (!who) throw new Error(usage);
      if (pub && hasAs) throw new Error(B.eventsCli.cardAsAndPublicBoth);
      const t = s.entityById(who) ?? s.entity(who);
      if (!t) throw new Error(B.eventsCli.cardEntityNotRegistered(who));
      let viewer: string | null = null;
      if (asRaw !== undefined) {
        const k = asRaw.trim().toLowerCase();
        viewer = s.entities().find((e) => e.person_key?.toLowerCase() === k)?.person_key ?? null;
        if (!viewer) throw new Error(B.eventsCli.cardViewerKeyUnknown(asRaw, t.person_key ?? B.eventsCli.cardViewerNotOnRoster));
      }
      const card = mem.card(t.id, { viewer });
      const n = s.pendingImpressions().filter((r) => r.about === t.id).length;
      const waiting = n ? B.eventsCli.cardPendingNote(n) : "";
      // 空的：要么真没有卡，要么这一面看不到（只有私密的，换 --as 看）
      const why = s.impressions(t.id).length ? B.eventsCli.cardEmptyPrivateOnly(t.person_key ? B.eventsCli.cardEmptyTryAs(t.person_key) : "") : B.eventsCli.cardEmptyNoFields;
      if (!card) return B.eventsCli.cardEmpty(t.name, why, waiting ? B.eventsCli.cardEmptyWaitingSuffix(waiting) : "");
      return waiting ? B.eventsCli.cardWithPendingNote(card, waiting) : card;
    }
    case "pending": return mem.pendingList();
    case "approve": {
      // hh mem approve <iNNNN> | --who <谁>：各开一批 approve:<…>@<毫秒>，收尾后导出人物卡
      const who = opt(args, "--who");
      if (who !== undefined) return mem.approveWho(who);
      if (!/^i\d+$/.test(args[0] ?? "")) throw new Error(B.eventsCli.approveUsage);
      return mem.approve(args[0]!);
    }
    case "reject": {
      if (!/^i\d+$/.test(args[0] ?? "")) throw new Error(B.eventsCli.rejectUsage);
      return mem.reject(args[0]!, args.slice(1).join(" "));
    }
    case "export-people": return mem.exportPeople() ?? { error: mem.peopleExportError ?? B.eventsCli.exportPeopleNotConfigured };
    case "sync-people": {
      const reg = JSON.parse(readFileSync(join(need(o.workspace, "workspace"), LAYOUT.registry), "utf8")) as Record<string, unknown>;
      // 名单文件原样（没过批准底子）：只同步人，不改主人（主人只认 Brain 启动时给的那份）
      return { changed: mem.syncPeople(reg, { owners: false }) };
    }
    default: throw new Error(B.eventsCli.unknownAction(action));
  }
}

function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(B.eventsCli.argumentMissing(what));
  return v;
}
