// 交叉审（多人模式）：另一个性格的她开一个只读的新会话，看这一段做得对不对、好不好；打回的问题交给再另一个她修。
// 跟核依据一个套路：没交催一次，坏了再开一次，两次都没做完算「审查没做完」（照过，报告最上面写一句）。
import { P, S } from "../lang/index.ts";
import type { Personas, StageSpec } from "./flow.ts";
import type { Snapshot, StageRecord } from "./record.ts";
import type { StageSession } from "./session.ts";
import type { ReviewDone } from "./tools.ts";
import { auditDiff, type StageValidator } from "./validate.ts";

export interface ReviewHost {
  open(o: { id: string; model: string; allowed: string[] }): StageSession & { onReview(fn: (r: ReviewDone) => string): void };
  /** 相对工作区的路径；文件不存在给 null */
  read(path: string): string | null;
  /** 这一段的 skill 页（审的人照其中「## 审的时候看什么」看）；找不到给 null */
  page(stage: StageSpec): string | null;
}

/** list 从第 k 个起转一圈 */
const rotate = <T>(list: T[], k: number): T[] => (list.length ? [...list.slice(k % list.length), ...list.slice(0, k % list.length)] : []);

/**
 * 谁来审：reviewers（不写 = 除了做这一段的以外全部）按第几次转一圈，第一个不是这一次做的人的；
 * 都是做的人（换人修时修的人正好在名单里）就找段的本来那个做的人，再不行找别的随便哪一个
 */
export function pickReviewer(stage: StageSpec, personas: Personas, doer: string | null, attempt: number): string | null {
  const all = Object.keys(personas);
  const list = stage.reviewers ?? all.filter((id) => id !== stage.persona);
  const order = [...rotate(list, Math.max(0, attempt - 1)), ...(stage.persona ? [stage.persona] : []), ...all];
  return order.find((id) => id !== doer && Object.hasOwn(personas, id)) ?? null;
}

/** 第 round 轮谁来修：fixers（不写 = 全部）按轮转一圈，第一个不是上一次做的人的 */
export function pickFixer(stage: StageSpec, personas: Personas, prev: string | null, round: number): string | null {
  const all = Object.keys(personas);
  const order = [...rotate(stage.fixers ?? all, Math.max(0, round - 1)), ...all];
  return order.find((id) => id !== prev && Object.hasOwn(personas, id)) ?? null;
}

const DIFF_CAP = 20000;

/** 两份快照之间改了的文件：去掉头尾相同的行，中间 - 旧 + 新（给修的人看上一次做的样子；那时提案已经撤回，只能从快照拼）；cap = 最多多少字（不给照旧 20000） */
export function snapDiff(before: Snapshot, after: Snapshot, cap: number = DIFF_CAP): string {
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p)?.sha !== after.get(p)?.sha).sort();
  if (!paths.length) return S.review.noFilesChanged;
  let out = "";
  for (const p of paths) {
    const a = before.get(p)?.text.split("\n") ?? [];
    const b = after.get(p)?.text.split("\n") ?? [];
    let h = 0;
    while (h < a.length && h < b.length && a[h] === b[h]) h++;
    let t = 0;
    while (t < a.length - h && t < b.length - h && a[a.length - 1 - t] === b[b.length - 1 - t]) t++;
    out += `=== ${p} ===\n`;
    for (const l of a.slice(h, a.length - t)) out += `- ${l}\n`;
    for (const l of b.slice(h, b.length - t)) out += `+ ${l}\n`;
    if (out.length > cap) return out.slice(0, cap) + S.review.diffCut;
  }
  return out;
}

/** 审的人看的记录：改动、报告、拿不准的、提案、毛病 */
const shown = (r: StageRecord) => ({ status: r.status, changes: r.changes, report: r.report, uncertain: r.uncertain, proposals: r.proposals, bugs: r.bugs });

/**
 * 交叉审的验证器（多人模式才有，排在核依据后面、考试前面）。审的人照 pickReviewer 定（这一次做的人从 ctx.doer 来，没有就是段的 persona）；
 * 结果的 by 是审的人的 id（runner 记账、写报告）。会话的时限由 host 定（它开段外会话时给的 auditMs）
 */
export function reviewValidator(host: ReviewHost, o: { model: string; personas: Personas }): StageValidator {
  return {
    name: "review",
    async validate(stage, day, record, ctx) {
      const doer = ctx?.doer ?? stage.persona ?? null;
      const who = pickReviewer(stage, o.personas, doer, record.attempt);
      if (!who) return { pass: true, problems: [S.review.notReviewed] };
      let prompt: string;
      try {
        prompt = P.SLEEP_REVIEW({
          reviewer: o.personas[who]!, doer: doer && o.personas[doer] ? o.personas[doer]!.name : null,
          title: stage.title, attempt: record.attempt, page: host.page(stage) ?? "", record: shown(record), diff: auditDiff(host, day, record),
        });
      } catch { return { pass: true, problems: [S.review.notReviewed], by: who }; }

      const once = async (n: number): Promise<ReviewDone | null> => {
        let s: ReturnType<ReviewHost["open"]>;
        // review- 开头：memtools 照核对的规矩处理（不留痕迹）
        // 段写了 reviewModel 就用它（切换前 P8）
        try { s = host.open({ id: `review-${day}-${stage.id}-${record.attempt}-${n}`, model: stage.reviewModel ?? o.model, allowed: ["recall", "recall_event", "review_done"] }); }
        catch { return null; }
        let got: ReviewDone | null = null;
        let nudged = false;
        let finish!: () => void;
        const done = new Promise<void>((r) => { finish = r; });
        s.onReview((a) => { if (!got) got = a; return S.marks.received; });
        s.onTurnEnd((ok) => {
          if (got || !ok) return finish();
          if (nudged) return finish();
          nudged = true;
          try { s.wake(P.SLEEP_REVIEW_NUDGE); } catch { finish(); }
        });
        s.settled.then(finish, finish);
        try { s.wake(prompt); } catch { finish(); }
        await done;
        try { await s.close(); } catch { /* 关不掉也算了 */ }
        return got;
      };

      for (const n of [1, 2]) {
        const a = await once(n);
        if (!a) continue;
        const problems = a.problems.map((p) => `${p.what}${p.change ? S.review.problemChange(p.change) : ""}${p.fix ? S.review.problemFix(p.fix) : ""}`);
        if (a.verdict === "pass") return { pass: true, problems, by: who };
        return { pass: false, problems: problems.length ? problems : [S.review.redoWithoutItems], by: who };
      }
      return { pass: true, problems: [S.review.notReviewed], by: who };
    },
  };
}
