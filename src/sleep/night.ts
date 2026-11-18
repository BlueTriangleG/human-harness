// 一夜的引擎怎么拼（真的夜里和回放共用这一份，回放才是「照真的夜里跑」）：会话的 host、验证器（核依据、交叉审、考试，考试排最后）、
// 多人模式（personas、前额叶，teamParts）、全天考试、runner。Brain 的 flowNight 和 sleep/replay.ts 都只调这里；
// 往引擎里加验证器、协调就加在这里，别往 flowNight 里接。
import { teamParts } from "./coordinator.ts";
import { finalExam } from "./final.ts";
import { examValidator } from "./examiner.ts";
import { examCacheCheck, ladderPlan, saveLevel } from "./ladder.ts";
import { nightHosts, type NightBrain, type NightHosts, type NightPlan } from "./host.ts";
import { SleepRunner } from "./runner.ts";
import { assembleTeamNight } from "./teamrun.ts";
import { auditValidator, type StageValidator } from "./validate.ts";
import type { Budget, Weights } from "./budget.ts";

export interface AssembleOpts {
  /** 这一夜叫什么（真的夜里是 nightOf；回放是 replay-<日>）：前额叶的会话 id（coord-<night>）用它 */
  night: string;
  budget: Budget;
  weights: Weights;
  /** 核依据（和交叉审、考试、前额叶的一轮）一个会话最多多久 */
  auditMs: number;
  watchdogMs: number;
  /** 一夜最多整理几天；Infinity = 不限 */
  maxDays: number;
  /** 回放（hh sleep replay）：只有那一天的材料——team 的夜里不提、不划以前欠着的日子 */
  replay?: boolean;
}

/** 拼一夜：b 给会话、文件、库、事件库（真的夜里是 Brain 自己的，回放是拷贝上的） */
export function assembleNight(b: NightBrain, plan: NightPlan, o: AssembleOpts): { hosts: NightHosts; runner: SleepRunner } {
  // 专员 + 领导的夜里另外拼（sleep/teamrun.ts）：没有核依据、交叉审、前额叶、每段的考试、全天考试
  if (plan.flow.engine === "team") return assembleTeamNight(b, plan, o);
  // 考试（有段配了 exam 才有）：省钱阶梯按这一夜的花费算；缓存核实、全天考试都是一夜一个，跟 runner 一起建
  const ladder = () => ladderPlan(plan.flow, saveLevel(o.budget));
  // 段外的会话（核依据、交叉审、考试、前额叶）花的记到各段头上（多人模式的报告、记账用）；引擎算的材料要过了的段
  const hosts = nightHosts(b, plan, {
    budget: o.budget, weights: o.weights, auditMs: o.auditMs, ladder, cache: examCacheCheck(),
    charge: (id, u) => runner.charge(id, u), passed: (day) => runner.passed(day),
  });
  const validators: StageValidator[] = [auditValidator(hosts.audit, { model: plan.flow.auditModel, timeoutMs: o.auditMs })];
  const exam = hosts.exam;
  const nightLog = hosts.stage.log;
  // 多人模式（写了 personasFile / coordinator 才有）：交叉审排在核依据后面、考试前面；runner 拿 personas 和前额叶
  const team = teamParts(hosts, plan, { night: o.night, auditMs: o.auditMs, nightMs: o.watchdogMs, later: hosts.stage.later, log: nightLog });
  if (team.review) validators.push(team.review);
  // 考试排在核依据后面，而且必须是最后一个（examiner 过了才记改层的 op，靠的就是它最后验）
  if (exam) validators.push(examValidator({ host: exam, bank: hosts.bank, flow: plan.flow, db: b.db, rnd: Math.random, ladder, passed: (day) => runner.passedStages(day), tonight: (day) => runner.tonight(day), log: nightLog }));
  const runner: SleepRunner = new SleepRunner(hosts.stage, plan.flow, {
    validators,
    ...(exam ? { finalCheck: finalExam({ host: exam, bank: hosts.bank, flow: plan.flow, fs: b.fs, rnd: Math.random, ladder, passed: (day) => runner.passed(day), tonight: (day) => runner.tonight(day), nightStart: () => runner.startedAt(), log: nightLog }) } : {}),
    budget: o.budget, weights: o.weights, watchdogMs: o.watchdogMs, maxDays: o.maxDays,
    ...team.runner,
  });
  return { hosts, runner };
}
