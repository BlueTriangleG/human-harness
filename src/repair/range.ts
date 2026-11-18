// 一段提交能不能上线：每个提交要么有会话的批准记录，要么守门通过且有修理单号和帮手结论，要么问过主人且他真批了。
import type { DatabaseSync } from "node:sqlite";
import { judge } from "./gate.ts";
import type { Verdict } from "./gate.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInfo, git, revList } from "./git.ts";
import { ownerApproval, sessionApproval } from "./approvals.ts";
import type { RepairRules } from "./rules.ts";
import { B, R } from "../lang/index.ts";

export interface RangeItem { sha: string; subject: string; via: "session" | "gate" | "owner" | "rollback" | "blocked"; verdict: Verdict; why: string }

/** 帮手的结论要以「通过」结尾，「不通过」「未通过」「没通过」都不算 */
export function verifiedOk(v: string): boolean {
  return /(^|\s)通过\s*$/.test(v) && !/[不未没]通过/.test(v);
}

/** 看守推的还原提交：在它的上一个提交上把 Rollback-range 再还原一遍，得到的树一模一样才认（只是回到审过的旧样子） */
function rollbackReproduces(dir: string, sha: string, range: string): boolean {
  if (!/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(range)) return false;
  const tmp = mkdtempSync(join(tmpdir(), "hh-rollback-check-"));
  const wt = join(tmp, "wt");
  try {
    git(dir, ["worktree", "add", "-q", "--detach", wt, `${sha}^`]);
    git(wt, ["-c", "user.name=check", "-c", "user.email=check@local", "revert", "--no-commit", range]);
    return git(wt, ["write-tree"]) === git(dir, ["rev-parse", `${sha}^{tree}`]);
  } catch { return false; } finally {
    try { git(dir, ["worktree", "remove", "--force", wt]); } catch { /* 没建成 */ }
    // worktree remove 只删 wt，外面 mkdtemp 建的这层也删掉（#0055）
    rmSync(tmp, { recursive: true, force: true });
  }
}
export interface RangeResult { ok: boolean; items: RangeItem[] }

/** rollbacks：看守真退回过的范围（log.ts rolledBackRanges）；不在里面的「还原提交」照普通提交审 */
export function evaluateRange(o: { dir: string; from: string; to: string; rules: RepairRules; guardDir: string; selfUid: number; db: DatabaseSync | null; owner: { name: string; channels: string[] }; rollbacks?: string[] }): RangeResult {
  const items: RangeItem[] = [];
  for (const sha of revList(o.dir, o.from, o.to)) {
    const c = commitInfo(o.dir, sha);
    const rec = sessionApproval(o.guardDir, sha, o.selfUid);
    const verdict = judge(c, o.rules);
    if (rec) { items.push({ sha, subject: c.subject, via: "session", verdict, why: R.range.rangeSessionApproved(rec.by, rec.why) }); continue; }
    const rb = c.trailers["Rollback-range"] ?? "";
    if (c.trailers["Rollback-of"] && o.rollbacks?.includes(rb) && rollbackReproduces(o.dir, sha, rb)) {
      items.push({ sha, subject: c.subject, via: "rollback", verdict, why: R.range.rangeRollbackCommit(c.trailers["Rollback-range"]) });
      continue;
    }
    if (verdict.outcome === "fail") { items.push({ sha, subject: c.subject, via: "blocked", verdict, why: verdict.reasons.map((r) => r.detail).join(B.common.listSep) }); continue; }
    // 她的每个修理提交都要有单号和帮手「通过」（问过主人的也一样要帮手审过）
    if (!/^#\d{4}$/.test(c.trailers.Fix ?? "") || !verifiedOk(c.trailers["Verified-by"] ?? "")) {
      const why = c.trailers.Fix || c.trailers["Verified-by"]
        ? R.range.rangeNeedFixAndVerdict
        : R.range.rangeNeedApprovalOrFix;
      items.push({ sha, subject: c.subject, via: "blocked", verdict, why });
      continue;
    }
    if (verdict.outcome === "pass") { items.push({ sha, subject: c.subject, via: "gate", verdict, why: R.range.rangeHelperVerified(c.trailers["Verified-by"]) }); continue; }
    const g = o.db ? ownerApproval(o.db, c.trailers, verdict.reasons, o.owner) : { ok: false, why: R.range.rangeNoMessageDb };
    items.push({ sha, subject: c.subject, via: g.ok ? "owner" : "blocked", verdict, why: g.ok ? g.why : R.range.rangeAskOwner(verdict.reasons.map((r) => r.key).join(","), g.why) });
  }
  return { ok: items.every((i) => i.via !== "blocked"), items };
}
