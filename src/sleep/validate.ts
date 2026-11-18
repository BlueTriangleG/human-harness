// 机械检查：段说的（record.changes）和实际做的（record.actual）对得上吗；再按名字跑点名的检查。
import { matchWrites, type StageSpec } from "./flow.ts";
import type { Snapshot, StageRecord } from "./record.ts";

/** runner 给验证器的这一次尝试：快照、给这一段的材料、整理前的事件库 */
export interface ValidateCtx {
  /** 这一段开始前、交差后 proposed/ 里它 writes 范围内的样子 */
  before: Snapshot;
  after: Snapshot;
  /** 给这一段的材料（不含 skill 页和前面几段的报告） */
  material: string;
  /** 整理前的事件库：拷贝的路径；这一段不写事件库时是 "live" */
  storeBefore: string;
  /** 多人模式：这一次是哪一个她做的（personas.json 的 id）；不是多人模式没有 */
  doer?: string;
}

/** 交 stage_done 时当场核对的结论：problems 空 = 没毛病；targets = 退回里点名要补题的那几处（exam_questions 这时只收挂在它们上面的） */
export interface Precheck { problems: string[]; targets: string[] }

/** 核依据是一个，第 2 份的考试是另一个 */
export interface StageValidator {
  name: string;
  /** by：谁验的（交叉审给审的人的 id），runner 记账、写报告用 */
  validate(stage: StageSpec, day: string, record: StageRecord, ctx?: ValidateCtx): Promise<{ pass: boolean; problems: string[]; by?: string }>;
  /**
   * 交 stage_done 时当场核对（会话还开着，没过就退回去补，不整段重做）：只查便宜的、机械的（考试查要压缩的每一处都出了题没有）。
   * 不给 = 这个验证器不当场核对
   */
  precheck?(stage: StageSpec, day: string, record: StageRecord, ctx: ValidateCtx): Precheck;
}

const FILE_LIKE = /^[^\s「#]+\.(md|json|txt)/;
const MEM_ID = /^(e|n|i|l|t)\d{3,}/;

/** target 说到了文件 p：整个相等，或后面跟「小节」/ #锚点 / 空白再写小节（页上让写「路径 小节」；回放 #2、#4 被这一处误判成没说到） */
const covers = (t: string, p: string) => t === p || t.startsWith(p + "「") || t.startsWith(p + "#") || (t.startsWith(p) && /^\s/.test(t.slice(p.length)));

export async function mechanical(o: {
  stage: StageSpec; record: StageRecord; checks: Record<string, string[]>;
  run(argv: string[]): Promise<{ code: number; out: string }>; day: string;
}): Promise<string[]> {
  const { stage, record, checks, run, day } = o;
  const problems: string[] = [];
  if (record.status === "blocked") problems.push(S.validate.blocked(record.blockedWhy ?? S.validate.noReason));
  problems.push(...bookkeeping(stage, record));

  for (const name of stage.validate) {
    const argv = checks[name];
    if (!argv) { problems.push(S.validate.noSuchCheck(name)); continue; }
    let r: { code: number; out: string };
    try { r = await run(argv.map((a) => a.replaceAll("{day}", day).replaceAll("{stage}", stage.id))); }
    catch (e) { problems.push(S.validate.checkCannotRun(name, e instanceof Error ? e.message : String(e))); continue; }
    if (r.code !== 0) problems.push(S.validate.checkFailed(name, r.code, r.out.slice(0, 1000)));
  }
  return problems;
}

/**
 * 段说的（changes）和实际做的（actual）对得上吗：改了没说、说了没改、改了 writes 以外的、事件库动了却没写编号（或反过来）。
 * 交差后的机械检查和交 stage_done 时的当场核对都用这一份（不跑点名的检查）
 */
export function bookkeeping(stage: StageSpec, record: StageRecord): string[] {
  const problems: string[] = [];
  const targets = record.changes.map((c) => c.target);
  const changed = record.actual.files.map((f) => f.path);

  for (const p of changed) {
    if (!matchWrites(stage.writes, p)) problems.push(S.validate.offLimits(p));
    if (!targets.some((t) => covers(t, p))) problems.push(S.validate.unreported(p));
  }
  for (const t of targets) {
    const file = t.split(/[\s「#]/)[0]!;
    if (FILE_LIKE.test(t) && !changed.includes(file)) problems.push(S.validate.notChanged(t));
  }

  const ids = targets.filter((t) => MEM_ID.test(t));
  if (record.actual.memOps > 0 && ids.length === 0) problems.push(S.validate.memUnreported(record.actual.memOps));
  if (record.actual.memOps === 0 && ids.length > 0) problems.push(S.validate.memNotTouched(ids.join(S.marks.listSep)));
  return problems;
}

// ---- 核依据：另开一个只读会话，抽查这一段新写进去的说法有没有依据 ----
import type { StageSession } from "./session.ts";
import type { AuditDone } from "./tools.ts";
import { P, S } from "../lang/index.ts";

export interface AuditHost {
  open(o: { id: string; model: string; allowed: string[] }): StageSession & { onAudit(fn: (a: AuditDone) => string): void };
  /** 相对工作区的路径；文件不存在给 null */
  read(path: string): string | null;
}

const DIFF_CAP = 20000;

/** 每个改到的文件：现在的（live）对提议稿（proposed），去掉头尾相同的行，中间 - 旧 + 新 */
export function auditDiff(host: Pick<AuditHost, "read">, day: string, record: StageRecord): string {
  if (record.actual.files.length === 0) return S.validate.noFilesChanged;
  const files = [...record.actual.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  let out = "";
  for (const f of files) {
    const lines = (t: string | null) => (t ? t.split("\n") : []);
    const before = lines(host.read(f.path));
    const after = lines(host.read(`sleep/${day}/proposed/${f.path}`));
    let h = 0;
    while (h < before.length && h < after.length && before[h] === after[h]) h++;
    let t = 0;
    while (t < before.length - h && t < after.length - h && before[before.length - 1 - t] === after[after.length - 1 - t]) t++;
    out += S.validate.diffFileHead(f.path, f.op);
    for (const l of before.slice(h, before.length - t)) out += `- ${l}\n`;
    for (const l of after.slice(h, after.length - t)) out += `+ ${l}\n`;
    if (out.length > DIFF_CAP) break;
  }
  return out.length > DIFF_CAP ? out.slice(0, DIFF_CAP) + S.validate.diffCut : out;
}

export function auditValidator(host: AuditHost, o: { model: string; timeoutMs: number }): StageValidator {
  return {
    name: "audit",
    async validate(stage, day, record) {
      let prompt: string;
      try { prompt = P.SLEEP_AUDIT(record, auditDiff(host, day, record)); }
      catch { return { pass: true, problems: [S.validate.notDone] }; }

      const attempt = async (n: number): Promise<AuditDone | null> => {
        let s: ReturnType<AuditHost["open"]>;
        // id 带上日子：一夜整理好几天时，同一段同一次的核依据不会撞名（audit- 开头，memtools 照核对的规矩处理）
        // 段写了 auditModel 就用它（切换前 P8）
        try { s = host.open({ id: `audit-${day}-${stage.id}-${record.attempt}-${n}`, model: stage.auditModel ?? o.model, allowed: ["recall", "recall_event", "audit_done"] }); }
        catch { return null; }
        let got: AuditDone | null = null;
        let nudged = false;
        let finish!: () => void;
        const done = new Promise<void>((r) => { finish = r; });
        s.onAudit((a) => { if (!got) got = a; return S.marks.received; });
        s.onTurnEnd((ok) => {
          if (got || !ok) return finish();
          if (nudged) return finish();
          nudged = true;
          try { s.wake(P.SLEEP_AUDIT_NUDGE); } catch { finish(); }
        });
        s.settled.then(finish, finish);
        try { s.wake(prompt); } catch { finish(); }
        await done;
        try { await s.close(); } catch { /* 关不掉也算了 */ }
        return got;
      };

      for (const n of [1, 2]) {
        const a = await attempt(n);
        if (!a) continue;
        if (a.verdict === "pass") return { pass: true, problems: [] };
        const problems = a.problems.map((p) => {
          const tail = [p.change, p.evidence].filter(Boolean).join(" / ");
          return tail ? S.validate.problemWithTail(p.what, tail) : p.what;
        });
        return { pass: false, problems: problems.length ? problems : [S.validate.redoWithoutItems] };
      }
      return { pass: true, problems: [S.validate.notDone] };
    },
  };
}
