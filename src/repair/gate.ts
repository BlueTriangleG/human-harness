// 守门：看一个提交的改动，按死规则给「通过 / 问主人 / 不过」。只看差异，不靠模型判断。
import { matchesPath } from "./rules.ts";
import type { RepairRules } from "./rules.ts";
import { R } from "../lang/index.ts";

export interface FileChange {
  path: string;
  status: "A" | "M" | "D" | "R";
  oldPath?: string;
  added: number;
  deleted: number;
  addedLines: string[];
  removedLines: string[];
}

export interface CommitInfo { sha: string; subject: string; trailers: Record<string, string>; files: FileChange[] }

export type Outcome = "pass" | "ask" | "fail";
/** key 是理由的类别（`tool`）或类别加对象（`protected:src/regions/specs.ts`）；她问主人时把 key 抄进 Ask-reasons */
export interface Reason { key: string; detail: string }
export interface Verdict { outcome: Outcome; reasons: Reason[] }

const RANK: Record<Outcome, number> = { pass: 0, ask: 1, fail: 2 };

export function isTestPath(p: string): boolean { return p.startsWith("test/"); }

export function judge(c: CommitInfo, rules: RepairRules): Verdict {
  const asks: Reason[] = [];
  const fails: Reason[] = [];
  const code = c.files.filter((f) => !isTestPath(f.path) && !(f.oldPath && isTestPath(f.oldPath)));
  const tests = c.files.filter((f) => isTestPath(f.path));

  // 测试被删、被跳过、断言变少：最容易被拿来「骗过」，没写理由一律不过
  if (!("Test-change" in c.trailers)) {
    const deleted = tests.filter((f) => f.status === "D");
    const skipped = tests.filter((f) => f.addedLines.some((l) => /\.(skip|only|todo)\(|\{\s*skip:/.test(l)));
    const asserts = (ls: string[]) => ls.filter((l) => /\bassert|\bexpect\(/.test(l)).length;
    const lost = tests.reduce((n, f) => n + asserts(f.removedLines) - asserts(f.addedLines), 0);
    if (deleted.length) fails.push({ key: "tests-weakened", detail: R.gate.gateTestsDeleted(deleted.map((f) => f.path).join(R.gate.gateDeletedSeparator)) });
    if (skipped.length) fails.push({ key: "tests-weakened", detail: R.gate.gateTestsSkipped(skipped.map((f) => f.path).join(R.gate.gateSkippedSeparator)) });
    if (lost > 0) fails.push({ key: "tests-weakened", detail: R.gate.gateAssertionsLost(lost) });
  }

  const autoload = rules.autoload ? new RegExp(rules.autoload, "i") : null;
  for (const f of c.files) {
    for (const p of [f.path, f.oldPath].filter((x): x is string => !!x)) {
      if (rules.protected.some((pat) => matchesPath(pat, p))) asks.push({ key: `protected:${p}`, detail: R.gate.gateProtectedPath(p) });
      else if (!rules.allowedRoots.some((r) => p.startsWith(r))) asks.push({ key: `outside:${p}`, detail: R.gate.gateOutsideRoots(p, rules.allowedRoots.join(R.gate.gateRootsSeparator)) });
      else if (autoload?.test(p)) asks.push({ key: `protected:${p}`, detail: R.gate.gateAutoloadedPath(p) });
    }
  }

  for (const cap of rules.capability) {
    const re = new RegExp(cap.re);
    const hit = code.find((f) => f.path.startsWith("src/") && f.addedLines.some((l) => re.test(l)));
    if (hit) asks.push({ key: `capability:${cap.id}`, detail: R.gate.gateCapabilityAdded(hit.path, cap.id) });
  }

  const toolRe = new RegExp(rules.toolDef);
  for (const f of code.filter((x) => x.path.startsWith("src/tools/"))) {
    const before = new Set(f.removedLines.filter((l) => toolRe.test(l)).map((l) => l.trim()));
    const fresh = f.addedLines.filter((l) => toolRe.test(l) && !before.has(l.trim()));
    if (fresh.length) asks.push({ key: "tool", detail: R.gate.gateToolAdded(f.path, fresh.map((l) => l.trim()).join(" ")) });
  }

  const lines = code.reduce((n, f) => n + f.added + f.deleted, 0);
  if (code.length > rules.size.maxFiles) asks.push({ key: "big", detail: R.gate.gateTooManyFiles(code.length, rules.size.maxFiles) });
  if (lines > rules.size.maxLines) asks.push({ key: "big", detail: R.gate.gateTooManyLines(lines, rules.size.maxLines) });
  const moved = code.filter((f) => f.status === "D" || f.status === "R");
  if (moved.length) asks.push({ key: "big", detail: R.gate.gateFilesMoved(moved.map((f) => f.oldPath ?? f.path).join(R.gate.gateMovedSeparator)) });
  for (const f of code.filter((x) => rules.size.coreFiles.includes(x.path))) {
    if (f.added + f.deleted > rules.size.coreMaxLines) asks.push({ key: `core:${f.path}`, detail: R.gate.gateCoreFileChanged(f.path, f.added + f.deleted, rules.size.coreMaxLines) });
  }

  const mig = new RegExp(rules.migration);
  if (code.some((f) => f.path === "src/store/db.ts" && f.addedLines.some((l) => mig.test(l)))) asks.push({ key: "migration", detail: R.gate.gateSchemaChanged });

  const inPrefix = code.filter((f) => rules.prefix.files.some((pat) => matchesPath(pat, f.path)));
  const grown = inPrefix.reduce((n, f) => n + chars(f.addedLines) - chars(f.removedLines), 0);
  if (grown > rules.prefix.maxChars) asks.push({ key: "prefix", detail: R.gate.gatePrefixGrown(grown, rules.prefix.maxChars) });

  if (fails.length) return { outcome: "fail", reasons: dedupe([...fails, ...asks]) };
  if (asks.length) return { outcome: "ask", reasons: dedupe(asks) };
  return { outcome: "pass", reasons: [] };
}

export function combine(vs: Verdict[]): Verdict {
  const outcome = vs.reduce<Outcome>((o, v) => (RANK[v.outcome] > RANK[o] ? v.outcome : o), "pass");
  return { outcome, reasons: dedupe(vs.flatMap((v) => v.reasons)) };
}

function chars(ls: string[]): number { return ls.reduce((n, l) => n + l.length, 0); }

function dedupe(rs: Reason[]): Reason[] {
  const seen = new Set<string>();
  return rs.filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true)));
}
