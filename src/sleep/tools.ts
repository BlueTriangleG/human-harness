// 夜里整理引擎的交差工具：每段干完调 stage_done，把关的调 audit_done。回话由调用方（引擎）给。
import { z } from "zod";
import type { ToolDef } from "../kernel/types.ts";
import type { Change } from "./record.ts";
import type { QuestionIn, Layer, Verdict } from "./bank.ts";
import { S } from "../lang/index.ts";

export const ENGINE_TOOLS = ["stage_done", "audit_done", "exam_questions", "exam_answers", "exam_grades"] as const;

export interface StageDone {
  status: "done" | "nothing" | "blocked";
  blockedWhy?: string;
  changes: Change[];
  report: string;
  uncertain: string[];
  proposals: string[];
  bugs: string[];
}

export interface AuditDone {
  verdict: "pass" | "redo";
  problems: Array<{ change?: string; what: string; evidence?: string }>;
}

// The schemas are made when a tool is made, so that their descriptions are in the role's language (the pack is chosen after the imports)
const changeFields = () => ({
  target: z.string().describe(S.tools.change.target),
  op: z.string().describe(S.tools.change.op),
  before: z.string().describe(S.tools.change.before),
  after: z.string().describe(S.tools.change.after),
  evidence: z.array(z.string()).describe(S.tools.change.evidence),
  why: z.string().describe(S.tools.change.why),
});
/** 考试夜的改动多一个 affects（不考试的夜工具定义照旧，一字不差） */
const examChange = () => z.object({
  ...changeFields(),
  affects: z.array(z.object({ q: z.string(), layer: z.enum(["resident", "searchable", "archive"]) })).optional()
    .describe(S.tools.change.affects),
});
const plainChange = () => z.object(changeFields());

const guard = async (fn: () => string | Promise<string>): Promise<string> => {
  try { return await fn(); } catch (e) { return S.tools.notDone(e instanceof Error ? e.message : String(e)); }
};

/** o.affects：改动带不带 affects（考试夜带；不给 = 带） */
export function stageDoneTool(onDone: (d: StageDone) => string, o: { affects?: boolean } = {}): ToolDef {
  const change = o.affects === false ? plainChange() : examChange();
  return {
    name: "stage_done",
    description: S.tools.stageDone.description,
    shape: {
      status: z.enum(["done", "nothing", "blocked"]).describe(S.tools.stageDone.status),
      blocked_why: z.string().optional().describe(S.tools.stageDone.blockedWhy),
      changes: z.array(change),
      report: z.string().describe(S.tools.stageDone.report),
      uncertain: z.array(z.string()).optional().describe(S.tools.stageDone.uncertain),
      proposals: z.array(z.string()).optional().describe(S.tools.stageDone.proposals),
      bugs: z.array(z.string()).optional().describe(S.tools.stageDone.bugs),
    },
    handler: (a) => guard(() => onDone({
      status: a.status as StageDone["status"],
      ...(a.blocked_why ? { blockedWhy: String(a.blocked_why) } : {}),
      changes: (a.changes as Change[] | undefined) ?? [],
      report: String(a.report ?? ""),
      uncertain: (a.uncertain as string[] | undefined) ?? [],
      proposals: (a.proposals as string[] | undefined) ?? [],
      bugs: (a.bugs as string[] | undefined) ?? [],
    })),
  };
}

export function auditDoneTool(onAudit: (a: AuditDone) => string): ToolDef {
  return {
    name: "audit_done",
    description: S.tools.auditDone.description,
    shape: {
      verdict: z.enum(["pass", "redo"]),
      problems: z.array(z.object({
        change: z.string().optional().describe(S.tools.auditDone.change),
        what: z.string().describe(S.tools.auditDone.what),
        evidence: z.string().optional(),
      })),
    },
    handler: (a) => guard(() => onAudit({
      verdict: a.verdict as AuditDone["verdict"],
      problems: (a.problems as AuditDone["problems"] | undefined) ?? [],
    })),
  };
}

// ---- 多人：交叉审、前额叶 ----

/** 多人的夜才有的两个交差工具（不在 ENGINE_TOOLS 里：没写 personasFile / coordinator 的夜工具清单照旧） */
export const TEAM_TOOLS = ["review_done", "coordinate"] as const;

export interface ReviewDone {
  verdict: "pass" | "redo";
  problems: Array<{ change?: string; what: string; fix?: string }>;
}

export function reviewDoneTool(onReview: (r: ReviewDone) => string): ToolDef {
  return {
    name: "review_done",
    description: S.tools.reviewDone.description,
    shape: {
      verdict: z.enum(["pass", "redo"]),
      problems: z.array(z.object({
        change: z.string().optional().describe(S.tools.auditDone.change),
        what: z.string().describe(S.tools.auditDone.what),
        fix: z.string().optional().describe(S.tools.reviewDone.fix),
      })),
    },
    handler: (a) => guard(() => onReview({
      verdict: a.verdict as ReviewDone["verdict"],
      problems: (a.problems as ReviewDone["problems"] | undefined) ?? [],
    })),
  };
}

/** 专员 + 领导：领导出的一道题（keep = 改动不该碰坏的，new = 改动该带来的，missed = 专员漏掉的，continuity = 每晚固定要问的） */
export interface LeadQuestion extends QuestionIn {
  probe: "keep" | "new" | "missed" | "continuity";
  /** continuity 的题：必须答对的那一件事（只写一件）；别的题不写 */
  must?: string;
  /** continuity 的题：别的细节（各算各的，只记答对几条，不影响过不过） */
  extras?: string[];
}
/** 领导看完一个专员的改动交的：它觉得这次改动想做什么、哪里要改，和出的题 */
export interface LeadReview {
  intent: Array<{ target: string; what: string; fix: string }>; questions: LeadQuestion[];
  /** 对着出处核过标准答案了（引擎头一次把出处贴回来以后，第二次交时写 true） */
  checked?: boolean;
  /** 引擎标的：这一份里有题是头一次交的、出处贴回去以后领导没再交——照头一次的收了，没核过出处 */
  unchecked?: boolean;
}
/** 领导看完前后两场考试定的 */
export interface LeadVerdict {
  pass: boolean; fixes: Array<{ what: string; fix: string }>; notes: string[];
  /** 连着两轮没过的题：是题的毛病（question：给新的标准答案 gold，按新的单独再考）还是答的毛病（answer：照旧发回去改） */
  faults?: Array<{ id: string; fault: "question" | "answer"; gold?: string; why: string; action?: "narrow" | "correct" | "withdraw"; evidence?: WithdrawEvidence }>;
}
/**
 * 撤一道题的证据：refs 是这道题自己的原始出处（#N / c:N / 路径:行，最多两条）。
 * gold-wrong：标准答案跟出处对不上——wrongToken 是标准答案里那个错的词，rightToken 是出处里对的那个；
 * two-answers：出处里两种说法都有——answerA 是标准答案的那个，answerB 是她答的那个
 */
export interface WithdrawEvidence {
  kind: "gold-wrong" | "two-answers"; refs: string[];
  wrongToken?: string; rightToken?: string; answerA?: string; answerB?: string;
}

export interface CoordinateIn {
  decision: "pass" | "redo" | "defer";
  why: string;
  notes: string[];
}

export function coordinateTool(onCoordinate: (c: CoordinateIn) => string): ToolDef {
  return {
    name: "coordinate",
    description: S.tools.coordinate.description,
    shape: {
      decision: z.enum(["pass", "redo", "defer"]),
      why: z.string().describe(S.tools.coordinate.why),
      notes: z.array(z.string()).optional().describe(S.tools.coordinate.notes),
    },
    handler: (a) => guard(() => onCoordinate({
      decision: a.decision as CoordinateIn["decision"],
      why: String(a.why ?? ""),
      notes: (a.notes as string[] | undefined) ?? [],
    })),
  };
}

export interface QuestionsIn {
  questions: QuestionIn[];
  revise: Array<{ q: string; gold: string; why: string }>;
  retire: Array<{ q: string; why: string }>;
}

const question = () => z.object({
  q: z.string().describe(S.tools.question.q),
  gold: z.string().describe(S.tools.question.gold),
  accept: z.string().describe(S.tools.question.accept),
  sources: z.array(z.string()).describe(S.tools.question.sources),
  tags: z.object({
    who: z.array(z.string()), events: z.array(z.string()), files: z.array(z.string()), lessons: z.array(z.string()),
  }).describe(S.tools.question.tags),
  importance: z.number().int().min(1).max(5).describe(S.tools.question.importance),
  kind: z.enum(["fact", "why", "feeling", "taste", "unsure", "update"]).describe(S.tools.question.kind),
  layer: z.enum(["resident", "searchable", "archive"]).describe(S.tools.question.layer),
  isNew: z.boolean().describe(S.tools.question.isNew),
});

/** onQuestions 可以是异步的（段交够了题，解锁前要先把事件库拷一份） */
export function examQuestionsTool(onQuestions: (x: QuestionsIn) => string | Promise<string>): ToolDef {
  return {
    name: "exam_questions",
    description: S.tools.examQuestions.description,
    shape: {
      questions: z.array(question()),
      revise: z.array(z.object({ q: z.string(), gold: z.string(), why: z.string() })),
      retire: z.array(z.object({ q: z.string(), why: z.string() })),
    },
    handler: (a) => guard(() => onQuestions({
      questions: (a.questions as QuestionIn[] | undefined) ?? [],
      revise: (a.revise as QuestionsIn["revise"] | undefined) ?? [],
      retire: (a.retire as QuestionsIn["retire"] | undefined) ?? [],
    })),
  };
}

export interface ExamAnswers { answers: Array<{ id: string; answer: string }> }

export function examAnswersTool(onAnswers: (a: ExamAnswers) => string): ToolDef {
  return {
    name: "exam_answers",
    description: S.tools.examAnswers.description,
    shape: { answers: z.array(z.object({ id: z.string().describe(S.tools.examAnswers.id), answer: z.string() })) },
    handler: (a) => guard(() => onAnswers({ answers: (a.answers as ExamAnswers["answers"] | undefined) ?? [] })),
  };
}

export interface ExamGrades {
  grades: Array<{ id: string; verdict: Verdict; reason: string }>;
  layers: Array<{ id: string; layer: Layer }>;
}

export function examGradesTool(onGrades: (g: ExamGrades) => string): ToolDef {
  return {
    name: "exam_grades",
    description: S.tools.examGrades.description,
    shape: {
      grades: z.array(z.object({ id: z.string(), verdict: z.enum(["right", "partial", "wrong"]), reason: z.string() })),
      layers: z.array(z.object({ id: z.string(), layer: z.enum(["resident", "searchable", "archive"]) })),
    },
    handler: (a) => guard(() => onGrades({
      grades: (a.grades as ExamGrades["grades"] | undefined) ?? [],
      layers: (a.layers as ExamGrades["layers"] | undefined) ?? [],
    })),
  };
}

// ---- 专员 + 领导（engine: "team"）：领导的两个交差工具。team 的夜里每个会话的清单里都有（清单一字不差才吃得到同一份缓存），只有领导的会话能调 ----

export const LEAD_TOOLS = ["lead_review", "lead_verdict"] as const;

const leadQuestion = () => question().extend({
  layer: z.enum(["resident", "searchable"]).describe(S.tools.leadQuestion.layer),
  isNew: z.boolean().optional().describe(S.tools.leadQuestion.isNew),
  must: z.string().optional().describe(S.tools.leadQuestion.must),
  extras: z.array(z.string()).optional().describe(S.tools.leadQuestion.extras),
  probe: z.enum(["keep", "new", "missed", "continuity"]).describe(S.tools.leadQuestion.probe),
});

export function leadReviewTool(onReview: (r: LeadReview) => string): ToolDef {
  return {
    name: "lead_review",
    description: S.tools.leadReview.description,
    shape: {
      intent: z.array(z.object({
        target: z.string().describe(S.tools.leadReview.target),
        what: z.string().describe(S.tools.leadReview.what),
        fix: z.string().describe(S.tools.leadReview.fix),
      })),
      questions: z.array(leadQuestion()),
      checked: z.boolean().optional().describe(S.tools.leadReview.checked),
    },
    handler: (a) => guard(() => onReview({
      intent: (a.intent as LeadReview["intent"] | undefined) ?? [],
      questions: (a.questions as LeadQuestion[] | undefined) ?? [],
      ...(a.checked === true ? { checked: true } : {}),
    })),
  };
}

export function leadVerdictTool(onVerdict: (v: LeadVerdict) => string): ToolDef {
  return {
    name: "lead_verdict",
    description: S.tools.leadVerdict.description,
    shape: {
      pass: z.boolean(),
      fixes: z.array(z.object({ what: z.string().describe(S.tools.leadVerdict.fixWhat), fix: z.string().describe(S.tools.leadVerdict.fixHow) })),
      notes: z.array(z.string()).optional().describe(S.tools.coordinate.notes),
      faults: z.array(z.object({
        id: z.string().describe(S.tools.examAnswers.id),
        fault: z.enum(["question", "answer"]).describe(S.tools.leadVerdict.fault),
        gold: z.string().optional().describe(S.tools.leadVerdict.gold),
        why: z.string().describe(S.tools.leadVerdict.why),
        action: z.enum(["narrow", "correct", "withdraw"]).optional().describe(S.tools.leadVerdict.action),
        evidence: z.object({
          kind: z.enum(["gold-wrong", "two-answers"]).describe(S.tools.leadVerdict.evidenceKind),
          refs: z.array(z.string()).describe(S.tools.leadVerdict.refs),
          wrongToken: z.string().optional().describe(S.tools.leadVerdict.wrongToken),
          rightToken: z.string().optional().describe(S.tools.leadVerdict.rightToken),
          answerA: z.string().optional().describe(S.tools.leadVerdict.answerA),
          answerB: z.string().optional().describe(S.tools.leadVerdict.answerB),
        }).optional().describe(S.tools.leadVerdict.evidence),
      })).optional().describe(S.tools.leadVerdict.faults),
    },
    handler: (a) => guard(() => onVerdict({
      pass: a.pass === true,
      fixes: (a.fixes as LeadVerdict["fixes"] | undefined) ?? [],
      notes: (a.notes as string[] | undefined) ?? [],
      ...(Array.isArray(a.faults) && a.faults.length ? { faults: a.faults as NonNullable<LeadVerdict["faults"]> } : {}),
    })),
  };
}
