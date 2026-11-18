// hhd：Human Harness 常驻进程。启动大脑、每 30 秒 tick 一次、开控制 socket。
import { checkProviders } from "./providers.ts";
import { restartStatus } from "./sleep/replay.ts";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants as perf, performance, PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import { homedir, loadavg, freemem } from "node:os";
import { spawn } from "node:child_process";
import { loadConfig, requireInstance, roleNames } from "./config.ts";
import { setLang } from "./lang/index.ts";
import { openDb } from "./store/db.ts";
import { Logger, fileSink } from "./log.ts";
import { Persona } from "./persona/persona.ts";
import { People, registryFileOf } from "./persona/people.ts";
import { findSkills, materializeSkillsPlugin } from "./persona/skills.ts";
import { Brain, peopleSwitchFileOf } from "./brain.ts";
import { SdkDriver } from "./kernel/sdk.ts";
import { serve } from "./control.ts";
import { GatewayClient, readGatewayAuth } from "./gateway/client.ts";
import { closeComputerNow } from "./tools/computer.ts";
import { openChannels } from "./channels/send.ts";
import { gatewayAuthFile, usesGateway } from "./channels/gateway.ts";
import { watchLoop } from "./basal/loopWatch.ts";
import { spoolDirOf } from "./relaySpool.ts";
import { Situation } from "./memory/situation.ts";
import { EventMemory } from "./memory/events/memory.ts";
import { OpenAIEmbedder, loadOpenAIKey } from "./memory/events/embed.ts";
import { MemChores } from "./memory/events/chores.ts";
import { CARD_DIR, templateOr } from "./memory/events/people.ts";
import { loadStatusFile, readLoadTight } from "./basal/dispatch.ts";
import { makeLearning } from "./learning/runtime.ts";
import { Chrome } from "./browser/chrome.ts";
import { loadRules, type RepairRules } from "./repair/rules.ts";
import { RestartGate, HealthMark, markBoot, snapshotDb, snapshotAtBoot, ensureWatchdog, countTurns, stopRecorded, bridgeRecords, calmNow } from "./repair/restart.ts";
import { readDeployed } from "./repair/log.ts";
import { SHARED_REPO } from "./repair/machine.ts";
import { loadModules } from "./modules/load.ts";
import { withDeclared } from "./gate/sources.ts";
import { startProcesses, startTimers } from "./modules/timers.ts";
import { MisconfigWatch, noteEntryFailure, reportMisconfigTrace, statusExtraOf, traceTarget } from "./instance-trace.ts";

const TICK_MS = 30_000;

async function main(): Promise<void> {
  const cfg = loadConfig();
  try { requireInstance(cfg); } catch (e) { noteEntryFailure(e, "hhd"); throw e; }
  // no base URL but a provider's, and a role on another provider only on the Claude Code version it was tried on (src/providers.ts)
  try { await checkProviders(cfg); } catch (e) { noteEntryFailure(e, "hhd"); throw e; }
  setLang(cfg.lang, roleNames(cfg));
  const log = new Logger("hhd", fileSink(cfg.stateDir, process.env.HH_ECHO === "1"));
  // 带迁移的部署没等她闲下来就起来了（崩过、重启过电脑）：开库迁移之前先备份，起不来时看守拿它恢复
  try {
    const snap = snapshotAtBoot(cfg.stateDir, join(cfg.stateDir, "hh.db"), readDeployed(cfg.stateDir)?.commit ?? null);
    if (snap) log.info("repair: snapshot before migrating at boot", { snap });
  } catch (e) { log.warn("repair: boot snapshot failed", { error: String(e).slice(0, 200) }); }
  const db = openDb(join(cfg.stateDir, "hh.db"));
  const persona = Persona.load(cfg.workspace, cfg.id, cfg.personaFiles);
  const skillsDir = join(cfg.stateDir, "skills-plugin");
  // 手册重新打包：启动时一次，之后每次换前缀（翻页、醒来）再来一次，她新开的、改过的手册就进来了
  const refreshSkills = (): void => {
    const skills = findSkills(cfg.skills.roots, cfg.skills.names, cfg.skills.discover, cfg.skills.exclude ?? [], cfg.learning.archiveDir);
    materializeSkillsPlugin(skills, skillsDir, cfg.id);
    log.info("skills", { loaded: skills.map((s) => s.name), missing: cfg.skills.names.filter((n) => !skills.some((s) => s.name === n)) });
  };
  refreshSkills();
  const skillsPlugin = skillsDir;
  const ev = cfg.memory?.events;
  // The OpenAI key is read once, here (memory's vectors, the notebook's judge). One changed after (hh openai, the console's
  // settings) is taken up by restarting once she is calm, as a deploy is: see the tick below
  const bootKey = loadOpenAIKey(cfg.stateDir);
  // The version of the code this hhd runs. An upgrade (npx human-harness) puts a new copy in the same folder; a role that is
  // not deployed by repair (no deployed.json: repair restarts its own) takes it up by restarting once she is calm
  const codeVersion = (): string | null => { try { return (JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string }).version ?? null; } catch { return null; } };
  const bootVersion = codeVersion();
  let mem: EventMemory | undefined;
  if (ev?.enabled) {
    const key = bootKey;
    // no key is a way to run the setup offers (skip it), not a fault: info, so it stays out of the console's bell
    if (!key) log.info("event memory: no OpenAI key in secrets.json, keyword search only");
    // 人物卡模板（R17）：配置里的这个人格的卡；没配或配坏了就不开人物卡（写字段、钉原话都拒，不导出），hhd 照常起来
    const rawTemplate = cfg.memory?.people?.template;
    const peopleTemplate = templateOr(rawTemplate, (e) => log.error("people: memory.people.template invalid, person cards off", { error: e.message.slice(0, 300) }));
    if (rawTemplate === undefined) log.warn("people: no memory.people.template in config, person cards off");
    // 人物卡切过去了没有（R33、R34）：旧的人物档案收进档案（工作区里有这个文件）以后才写卡、才用库里的访客卡和指路
    const peopleSwitch = peopleSwitchFileOf(cfg);
    const peopleActive = (): boolean => !peopleSwitch || existsSync(join(cfg.workspace, peopleSwitch));
    mem = new EventMemory({ db, embedder: key ? new OpenAIEmbedder({ key, log: log.child("embed") }) : null, tz: cfg.schedule.timezone, peopleDir: join(cfg.workspace, CARD_DIR), ...(peopleTemplate ? { peopleTemplate } : {}), peopleActive, log: { warn: (msg, data) => log.warn(msg, data), info: (msg, data) => log.info(msg, data) } });
  }
  // 学习（笔记本）：有 OpenAI key 就建，开关全关也建（hh learn、夜里要用）；和事件记忆共用向量服务
  const learning = makeLearning(cfg, db, mem, log);
  const modules = await loadModules(cfg, { log: log.child("modules") });
  modules.writeEnv(cfg);
  // the source kinds the modules declare, under the role's own table
  cfg.senses = { ...cfg.senses, sources: withDeclared(cfg.senses?.sources, modules.senseKinds()) };
  const loadStatus = loadStatusFile(cfg);
  const situation = new Situation({
    workspace: cfg.workspace, loadStatusFile: loadStatus, timezone: cfg.schedule.timezone,
    log: log.child("situation"), now: Date.now,
    ...(mem && ev ? { events: { mem, inject: ev.inject, logDir: join(cfg.stateDir, "mem-assoc") } } : {}),
    modules: modules.situationHooks(),
  });
  let gateway: GatewayClient | undefined;
  // a role with no channel through the OpenClaw gateway and no gateway.authFile (a new role) does without it and without hh-relay
  const gatewayUsed = usesGateway(cfg);
  if (!gatewayUsed) log.info("no channel goes through the OpenClaw gateway and no gateway.authFile: no gateway client, no hh-relay");
  else try {
    gateway = new GatewayClient({ ...readGatewayAuth(gatewayAuthFile(cfg)), log: log.child("gateway") });
    await gateway.connect().catch((e: unknown) => log.warn("gateway first connect failed (will retry on use)", { error: String(e) }));
  } catch (e) {
    log.warn("no gateway client: messages cannot be sent", { error: String(e) });
  }
  const channels = openChannels(cfg, { gateway, log });
  const browser = new Chrome({ ...cfg.browser, shotsDir: join(cfg.stateDir, "shots") });
  const brain = new Brain({ cfg, db, driver: new SdkDriver(), loadTight: () => readLoadTight(loadStatus, Date.now()), persona, reloadPersona: () => Persona.load(cfg.workspace, cfg.id, cfg.personaFiles), log, people: People.loadOr(cfg.workspace, (e) => log.error("people: registry unreadable at boot, starting with nobody (Brain falls back to the approved baseline)", { error: String(e).slice(0, 200) })), registryFile: registryFileOf(cfg.workspace), plugins: [skillsPlugin], gateway, send: channels.send, browser, situation, refreshSkills, modules, ...(mem ? { mem } : {}), ...(learning ? { learning } : {}) });
  brain.start();
  const stopModuleTimers = startTimers(modules);
  const stopModuleProcesses = startProcesses(cfg, modules);
  // 起来时看一眼调试端口：被别的用户资料的 Chrome 占着只记一笔（连的时候 Chrome 自己会拒），不拦起来；这一步本身出错最多一条 warn
  void browser.holder()
    .then((h) => { if (h.state === "other") log.error("browser: the debug port is held by another profile", { port: cfg.browser.port }); })
    .catch((e) => log.warn("browser: debug port check failed", { error: String(e).slice(0, 200) }));

  // 自己修系统：部署留下重启请求，她闲着时自己退出、launchd 拉起新版本；起来、跑稳都记下来给看守看
  let restartGate: RestartGate | null = null;
  let restartRules: RepairRules["restart"] | null = null;
  let health: HealthMark | null = null;
  try {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const rules = loadRules(root);
    restartRules = rules.restart;
    const bootCommit = markBoot(cfg.stateDir, process.pid, root, SHARED_REPO);
    restartGate = new RestartGate({
      stateDir: cfg.stateDir, rules, tz: cfg.schedule.timezone, now: Date.now, bootCommit,
      // The console is its own process (KeepAlive): stop the one this role recorded in its state directory; launchd starts it on the new code
      // the console and the channel bridges, by the pids this role recorded (launchd brings them back on the new code)
      restartConsole: () => { for (const r of ["console.json" as const, ...bridgeRecords(cfg.stateDir)]) stopRecorded(cfg.stateDir, r); },
    });
    health = new HealthMark({ stateDir: cfg.stateDir, rules: rules.watch, started: Date.now(), now: Date.now, commit: bootCommit });
    // 这次部署的看守不在了（重启过电脑、等太久走了）：再叫一个
    if (ensureWatchdog(cfg.stateDir, (script, arg) => spawn(process.execPath, [script, arg], { detached: true, stdio: "ignore" }).unref())) log.info("repair: watchdog respawned");
  } catch (e) {
    log.warn("repair: no restart gate (config/repair.json?)", { error: String(e).slice(0, 200) });
  }

  // hhd 不在时 relay 存下的消息：先补交（按存的先后），再开始接新的；以后每次 tick 再看一眼（b，CEO 11-12）
  // relay 存在 ~/.hh/relay-spool（它和 socket 一样按 home 定）：状态目录不在那，存下的就没人来交，说一声（复核 efd28b20）
  if (gatewayUsed && spoolDirOf(cfg.stateDir) !== join(homedir(), ".hh", "relay-spool")) log.warn("relay spool: stateDir is not ~/.hh, messages hh-relay stores while hhd is away won't be found here", { stateDir: cfg.stateDir });
  const drain = (): void => brain.drainRelaySpool();
  drain();
  const sockPath = join(cfg.stateDir, "hh.sock");
  // 入口漏带实例配置留下的痕（instance-trace.ts）：起来时读一遍，之后每 10 分钟看有没有新行；有就按 error 记，hh status 也带一行。
  // 对照工具的世界（parity/world.ts）故意不照抄这一段：回放不该去读整台机器共用的文件
  const traceFile = traceTarget();
  const misconfig = traceFile ? new MisconfigWatch(traceFile) : null;
  reportMisconfigTrace(misconfig, log);
  const misconfigTimer = setInterval(() => reportMisconfigTrace(misconfig, log), 10 * 60_000);
  misconfigTimer.unref();
  // 事件循环卡顿自检（只记数据）：relay 等 hhd 回话有时限，卡住了要知道卡了多久、当时在做什么（CEO 11-12）
  let lastControl: { cmd: string; at: number } | null = null;
  const server = serve(brain, sockPath, (e) => log.error("control error", { error: String(e) }), {
    slowMs: 1000,
    seen: (cmd) => { lastControl = { cmd, at: Date.now() }; },
    onSlow: (cmd, ms) => log.warn("control slow", { cmd, ms }),
  }, () => ({
    ...statusExtraOf(misconfig)(),
    // whether this hhd runs with a key, and whether the one in secrets.json is another (taken up at a calm restart); never the key
    openai: { keyed: bootKey !== null, pending: loadOpenAIKey(cfg.stateDir) !== bootKey },
  }));
  await channels.start((m) => brain.fromChannel(m));
  // the collections of the last minute: a stall that a full collection filled is the machine paging hhd's heap back in
  // (11-17: the stalls came with 100–500 MB free and most of hhd's pages compressed or swapped out), not code that computes
  const gcs: Array<{ at: number; ms: number; kind: number }> = [];
  const keepGc = (entries: PerformanceEntry[]): void => {
    for (const e of entries) gcs.push({ at: performance.timeOrigin + e.startTime, ms: e.duration, kind: (e as PerformanceEntry & { detail?: { kind?: number } }).detail?.kind ?? 0 });
    while (gcs.length && gcs[0]!.at < Date.now() - 60_000) gcs.shift();
  };
  const gcWatch = new PerformanceObserver((list) => keepGc(list.getEntries()));
  gcWatch.observe({ entryTypes: ["gc"] });
  const stopLoopWatch = watchLoop({
    everyMs: 1000, thresholdMs: 2000, now: Date.now,
    onBlocked: (ms) => {
      let ctx: Record<string, unknown> = {};
      try { ctx = brain.loopState(); } catch { /* 看不了就只记时长 */ }
      // 机器那头的线索（11-12 23:xx 那一串是整机换页，不是 hhd 自己在算）：负载、空闲内存；hhd 自己多大，这段时间里的 GC
      const [l1, l5] = loadavg();
      const mem = process.memoryUsage();
      keepGc(gcWatch.takeRecords());
      const from = Date.now() - ms - 1000;
      const inside = gcs.filter((g) => g.at + g.ms >= from);
      const machine = {
        load1: Math.round(l1! * 10) / 10, load5: Math.round(l5! * 10) / 10, freeMemMb: Math.round(freemem() / 1048576),
        rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576),
        gc: { n: inside.length, ms: Math.round(inside.reduce((n, g) => n + g.ms, 0)), major: inside.filter((g) => g.kind === perf.NODE_PERFORMANCE_GC_MAJOR).length },
      };
      log.warn("event loop blocked", { ms, ...(lastControl ? { lastControl: { cmd: lastControl.cmd, agoMs: Date.now() - lastControl.at } } : {}), ...ctx, ...machine });
    },
  });
  log.info("hhd up", { pid: process.pid, socket: sockPath });

  // 事件记忆的日常：新原话抄进原话层、后台补算向量；每 10 分钟导出 events.json 和中期视图（给脚本和对比用）
  const chores = mem ? new MemChores({
    mem, exportsDir: join(cfg.stateDir, "exports"), tz: cfg.schedule.timezone, now: Date.now,
    asleep: () => brain.alertness === "asleep", log: (msg, data) => log.warn(msg, data),
  }) : null;

  let ticking = false;
  /** calm ticks in a row while a changed OpenAI key waits to be taken up */
  let keyCalm = 0;
  const timer = setInterval(async () => {
    // how long each part took, and how much of it the loop was busy (the rest waited on the network or a child): a tick
    // that kept the loop busy a second or more says which part did
    const elu = performance.eventLoopUtilization();
    const took: Record<string, number> = {};
    let at = performance.now();
    const lap = (part: string): void => { const t = performance.now(); took[part] = Math.round(t - at); at = t; };
    drain();
    lap("drain");
    if (ticking) return;
    ticking = true;
    let tickOk = true;
    try { await brain.tick(); } catch (e) { tickOk = false; log.error("tick failed", { error: e instanceof Error ? e.stack : String(e) }); }
    lap("brain");
    try { chores?.tick(); } catch (e) { log.error("event memory chores failed", { error: e instanceof Error ? e.stack : String(e) }); }
    lap("chores");
    // 她白天改了笔记本：安静两分钟后补编号、刷封面。睡着时不扫：夜里整理的提案照整理开始时的文件写，整理完 afterNight 会扫
    try { if (learning && brain.alertness !== "asleep" && learning.refreshIfChanged()) log.info("learning: shelf changed, rescanned"); }
    catch (e) { log.warn("learning: shelf refresh failed", { error: String(e).slice(0, 200) }); }
    lap("learning");
    try {
      health?.tick(tickOk, countTurns(brain.turnOutcomes()));
      // 回放在跑时不算闲着（sleep/replay.ts 的 restartStatus）：重启等它跑完。她的整份状态只在有部署等着重启时才算
      if (restartGate?.tick(() => restartStatus(brain.status(), brain.replayRunning)) === "restart") { log.info("repair: restarting for a deploy while she is calm", { snapshot: restartGate.snapshot }); await shutdown("restart"); }
      // the OpenAI key changed since hhd started: restarted once she is calm by a deploy's rule (calm checks in a row, not in
      // the quiet hours); launchd or systemd starts it again at once, and it starts with the key
      else {
        // the OpenAI key changed since hhd started, or (no repair deploys) the code under it was upgraded
        const why = loadOpenAIKey(cfg.stateDir) !== bootKey ? "openai: the key changed, restarting while she is calm to take it up"
          : !readDeployed(cfg.stateDir) && codeVersion() !== bootVersion ? "upgrade: the code was upgraded, restarting while she is calm to run it" : null;
        if (!why) keyCalm = 0;
        else {
          const rule = restartRules ?? { quiet: ["00:00", "00:00"] as [string, string], calmChecks: 3 };
          keyCalm = calmNow(restartStatus(brain.status(), brain.replayRunning), Date.now(), cfg.schedule.timezone, rule.quiet) ? keyCalm + 1 : 0;
          if (keyCalm >= rule.calmChecks) { log.info(why, { from: bootVersion, to: codeVersion() }); await shutdown("restart"); }
        }
      }
    } catch (e) { log.warn("repair: restart gate failed", { error: String(e).slice(0, 200) }); }
    finally { ticking = false; }
    lap("restart");
    const busy = performance.eventLoopUtilization(elu).active;
    if (busy >= 1000) log.warn("tick slow", { busyMs: Math.round(busy), ...took });
  }, TICK_MS);

  const shutdown = async (sig: string) => {
    log.info("shutting down", { sig });
    clearInterval(timer);
    clearInterval(misconfigTimer);
    stopModuleTimers();
    stopModuleProcesses();
    stopLoopWatch();
    server.close();
    await brain.stop();
    // 部署带数据库迁移：大脑停下、不再写了，这一刻备份（新版本起不来时看守拿它恢复）
    if (sig === "restart" && restartGate?.snapshot) {
      try { snapshotDb(db, restartGate.snapshot); } catch (e) { log.warn("repair: snapshot before restart failed", { error: String(e).slice(0, 200) }); }
    }
    // 电脑还开着的 execution 收掉（到点收的计时器跟着进程没了，不收就一直占着那台电脑，#0038）
    await closeComputerNow().catch(() => {});
    await channels.stop();
    gateway?.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", { error: e instanceof Error ? e.stack : String(e) }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
