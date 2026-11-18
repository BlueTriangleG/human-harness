// 对照工具的虚拟世界：只做一件事——照 src/hhd.ts 的接法把整套系统搭起来（同样的构造参数、同样的先后），但全在进程里、不出网：
// 内核、网关、外部命令换成记录用的假的（fakes.ts），OpenAI 由全局的假 fetch 接住，时间走虚拟时钟。
// hhd 起来以后做的两件事也照抄：w.start()（brain.start、状态目录不在 ~/.hh 时那句提醒、把 relay 存下的消息补交）、
// w.tick()（定时器每 30 秒那一下的身子：先补交 relay 存下的，再 brain.tick、事件记忆的日常、书架重扫）。
// 控制面那三条命令（relay、sense、tell）在调大脑前后做的事由 drive.ts 的 feed 照抄。
// hhd.ts 的 main()、control.ts 的这三条命令改了，test/parity-wiring.test.ts 会挂：照着改这里和 feed，再更新那里的哈希。
// 故意不照抄的（都不是她读得到的字，也不改系统往外做的事）：
// - 启动时的备份（snapshotAtBoot）、重启闸门、健康标记、看守（repair/）：回放不重启、不部署；
// - 真网关的连接和认证（换成记录用的假网关）、控制 socket 本身（场景直接调大脑的入口）；
// - 启动时对浏览器调试端口的那一眼（hhd.ts main() 里的 browser.holder()）：它看这台机器的进程和一个本地端口，离线的世界里不碰；
// - 入口漏带实例配置的留痕和 hhd 定期读它（instance-trace.ts：reportMisconfigTrace、statusExtraOf）：那是整台机器共用的一个文件，回放不去读也不去写；
// - 事件循环卡顿自检（watchLoop）和控制命令的慢调用计时：量的是真时间，虚拟时钟下没有意义，只写诊断日志；
// - What main() checks or measures besides (1d4258e8, 5d5424a8): checkProviders before anything starts (it only refuses a
//   misconfigured machine: an ANTHROPIC_BASE_URL in hhd's environment, a provider's CLI version), the GC observer the stall
//   note reads, and each tick's laps and event-loop utilisation for "tick slow": real time again, diagnostics only;
// - The OpenAI key read once at start, and the restart once she is calm when secrets.json holds another (832490765):
//   a replay never changes the role's secrets, so the world gives the key (or none) at the start and never restarts;
// - 进程信号的收尾（SIGTERM / SIGINT）：w.close() 照 shutdown 的先后停大脑、收电脑、关库。
// - Starting and stopping the channels (channels.start / stop in hhd): the world connects nothing; scenarios hand messages to
//   brain.fromChannel themselves. Their send is mirrored: it is the way out the replay records.
// - The modules' timers and processes (startTimers, startProcesses in hhd): real intervals the virtual clock does not drive,
//   and real processes outside the world. The modules themselves are loaded as hhd loads them; their scripts run through
//   the world's recording runner.
// - The modules' env files (modules.writeEnv in hhd): they serve bin/hh and runs from outside HH, which the world has
//   none of, and they carry the work dir's absolute paths.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { loadConfig, remapConfig, requireInstance, type Config, roleNames } from "../config.ts";
import { setLang } from "../lang/index.ts";
import { openDb, type Db } from "../store/db.ts";
import { Logger } from "../log.ts";
import { Persona } from "../persona/persona.ts";
import { People, registryFileOf } from "../persona/people.ts";
import { findSkills, materializeSkillsPlugin } from "../persona/skills.ts";
import { Brain, peopleSwitchFileOf } from "../brain.ts";
import type { Script } from "../kernel/fake.ts";
import { closeComputerNow } from "../tools/computer.ts";
import { openChannels } from "../channels/send.ts";
import { usesGateway } from "../channels/gateway.ts";
import { spoolDirOf } from "../relaySpool.ts";
import { loadModules } from "../modules/load.ts";
import { withDeclared } from "../gate/sources.ts";
import { commandLine } from "../modules/command.ts";
import { Situation } from "../memory/situation.ts";
import { EventMemory } from "../memory/events/memory.ts";
import { OpenAIEmbedder, loadOpenAIKey } from "../memory/events/embed.ts";
import { MemChores } from "../memory/events/chores.ts";
import { CARD_DIR, templateOr } from "../memory/events/people.ts";
import { loadStatusFile, readLoadTight } from "../basal/dispatch.ts";
import { makeLearning } from "../learning/runtime.ts";
import { Chrome } from "../browser/chrome.ts";
import type { VirtualClock } from "./determinism.ts";
import { changedFiles, dbDigest, scanFiles } from "./digest.ts";
import { OFFLINE_KEY, RecordingDriver, recordingBridge, recordingGateway, recordingRunner, worldAnswers, type RunAnswer } from "./fakes.ts";
import { assertNoLiveMention, assertOffLive, contained } from "./fence.ts";
import type { Recorder } from "./recorder.ts";

/** 快照的 manifest.json */
export interface Manifest { id: string; takenAt: number; home: string; tz: string }

export interface World {
  /** 重映射到工作副本以后的配置（系统真用的这份） */
  cfg: Config;
  /** 合并完、还没重映射的配置 */
  loaded: Config;
  brain: Brain;
  db: Db;
  driver: RecordingDriver;
  clock: VirtualClock;
  rec: Recorder;
  /** hhd 起来那一下：brain.start()，状态目录不在 ~/.hh 时提醒一句，再把 relay 存下的消息按先后补交（场景不直接调 brain.start()） */
  start(): void;
  /** 在这个脑区最近开的那个假会话上演一轮剧本（先记一条 script）；演的时候排空，它要等的虚拟计时器照时间响 */
  play(region: string, script: Script): Promise<void>;
  /** hhd 每 30 秒那一下（先补交 relay 存下的，再 brain.tick、事件记忆的日常、书架有改动就重扫），少了健康标记和重启闸门；跑完排空 */
  tick(): Promise<void>;
  /** 排空：连着几圈没有新记录为止（到点的虚拟计时器也响掉） */
  drain(): Promise<void>;
  /** 外部命令从这以后由 fn 回答（系统按命令的输出做决定的地方才走得下去）；给的回答记在那条 run 的 answered 里。fn 不认得的命令照旧：世界自带的回答（fakes.ts 的 WORLD_ANSWERS），再不认得就是成功、没输出 */
  answerRun(fn: RunAnswer): void;
  /** 场景最后的三条 state：status、db、files */
  recordState(): void;
  /** 照 hhd 收尾：停大脑、收掉电脑、关库 */
  close(): Promise<void>;
}

export interface WorldOpts {
  manifest: Manifest;
  /** --work：工作副本在 <work>/home */
  work: string;
  rec: Recorder;
  clock: VirtualClock;
  /** 要守的真 home（fence.ts 的 fencedHomes） */
  liveHomes: readonly string[];
}

/** 配置里所有的字符串 */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) stringsOf(x, out);
  return out;
}

/** 照 hhd.ts 搭起整套系统（不 start：场景自己调 w.start()） */
export async function buildWorld(o: WorldOpts): Promise<World> {
  const { rec, clock } = o;
  const home = join(o.work, "home");
  const loaded = loadConfig();
  requireInstance(loaded);
  setLang(loaded.lang, roleNames(loaded));
  const cfg = remapConfig(loaded, [[o.manifest.home, home]]);
  const dbPath = join(cfg.stateDir, "hh.db");
  // 起来先查（写任何东西之前）：配置里的绝对路径、真开的库和工作区都不在真 home 里；哪个字符串里都不再提到真 home；
  // 状态目录、工作区都在工作副本里（假 key 只写在这里）
  const strings = stringsOf(cfg);
  assertOffLive([...strings.filter((s) => isAbsolute(s)), dbPath, cfg.workspace], o.liveHomes);
  assertNoLiveMention(strings, o.liveHomes);
  for (const [what, p] of [["stateDir", cfg.stateDir], ["workspace", cfg.workspace]] as const) {
    if (!contained(p, home)) throw new Error(`parity: ${what} is outside the work clone (${p})`);
  }
  // 克隆里没有库：openDb 会当场建一个空的，两棵树都对着空库回放、什么也没比就「一样」了——不建，先停
  if (!existsSync(dbPath)) throw new Error(`parity: the snapshot has no database at ${join("<WORK>", relative(o.work, dbPath))}`);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(cfg.stateDir, "secrets.json"), `${JSON.stringify({ openaiKey: OFFLINE_KEY })}\n`, { mode: 0o600 });
  // files 那条不看数据库和它的 -wal、-shm（db 那条按行记了内容，文件字节里有随机的盐）；临时目录照看（名字由 determinism.ts 定成计数的了）
  const dbFiles = new Set(["", "-wal", "-shm", "-journal"].map((x) => relative(o.work, dbPath + x)));
  const ignore = (rel: string): boolean => dbFiles.has(rel);
  const before = scanFiles(o.work, ignore);

  // warn、error 记成 log：哪个模块、那句话，附带的数据里只留 error 的第一行（rec.log）
  const log = new Logger("hhd", (r) => { if (r.level === "warn" || r.level === "error") rec.log(r.level, r.msg, { mod: r.mod, error: r.error }); });
  // 外部命令的回答：场景给的（answerRun）先，其次世界自带的那几条（情境要跑的命令），都不认得就是默认的成功、没输出
  let runAnswer: RunAnswer | undefined;
  const ownAnswer = worldAnswers(cfg);
  const run = recordingRunner(rec, (cmd, args, opts) => runAnswer?.(cmd, args, opts) ?? ownAnswer(cmd, args, opts));
  const gateway = recordingGateway(rec);

  // —— 以下照 hhd.ts main() 的先后（不传 fetchImpl：两个 OpenAI 客户端每次调用都找全局的 fetch，跟 hhd 一样，全局的就是记录用的假 fetch）——
  const db = openDb(dbPath);
  const persona = Persona.load(cfg.workspace, cfg.id, cfg.personaFiles);
  const skillsDir = join(cfg.stateDir, "skills-plugin");
  const refreshSkills = (): void => {
    const skills = findSkills(cfg.skills.roots, cfg.skills.names, cfg.skills.discover, cfg.skills.exclude ?? [], cfg.learning.archiveDir);
    materializeSkillsPlugin(skills, skillsDir, cfg.id);
    log.info("skills", { loaded: skills.map((s) => s.name), missing: cfg.skills.names.filter((n) => !skills.some((s) => s.name === n)) });
  };
  refreshSkills();
  const skillsPlugin = skillsDir;
  const ev = cfg.memory?.events;
  let mem: EventMemory | undefined;
  if (ev?.enabled) {
    const key = loadOpenAIKey(cfg.stateDir);
    if (!key) log.warn("event memory: no OpenAI key in secrets.json, keyword search only");
    const rawTemplate = cfg.memory?.people?.template;
    const peopleTemplate = templateOr(rawTemplate, (e) => log.error("people: memory.people.template invalid, person cards off", { error: e.message.slice(0, 300) }));
    if (rawTemplate === undefined) log.warn("people: no memory.people.template in config, person cards off");
    const peopleSwitch = peopleSwitchFileOf(cfg);
    const peopleActive = (): boolean => !peopleSwitch || existsSync(join(cfg.workspace, peopleSwitch));
    mem = new EventMemory({ db, embedder: key ? new OpenAIEmbedder({ key, log: log.child("embed") }) : null, tz: cfg.schedule.timezone, peopleDir: join(cfg.workspace, CARD_DIR), ...(peopleTemplate ? { peopleTemplate } : {}), peopleActive, log: { warn: (msg, data) => log.warn(msg, data), info: (msg, data) => log.info(msg, data) } });
  }
  // replays run with no OpenAI key and compare against trees where learning was simply off without one: keep it off here
  const learning = makeLearning(cfg, db, mem, log, { keywordWithoutKey: false });
  // the modules' scripts answer through the same recording runner as every other command here
  const modules = await loadModules(cfg, { log: log.child("modules"), run: (file, argv, o) => run(...commandLine(file, argv, o.python), { cwd: o.cwd, ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) }).then((r) => ({ ...r, timedOut: false })) });
  cfg.senses = { ...cfg.senses, sources: withDeclared(cfg.senses?.sources, modules.senseKinds()) };
  const loadStatus = loadStatusFile(cfg);
  const situation = new Situation({
    workspace: cfg.workspace, loadStatusFile: loadStatus, timezone: cfg.schedule.timezone,
    log: log.child("situation"), now: Date.now,
    ...(mem && ev ? { events: { mem, inject: ev.inject, logDir: join(cfg.stateDir, "mem-assoc") } } : {}),
    modules: modules.situationHooks(),
  });
  const channels = openChannels(cfg, { gateway, bridge: recordingBridge(rec), log });
  const driver = new RecordingDriver(rec);
  const brain = new Brain({
    cfg, db, driver, loadTight: () => readLoadTight(loadStatus, Date.now()), persona, reloadPersona: () => Persona.load(cfg.workspace, cfg.id, cfg.personaFiles), log,
    people: People.loadOr(cfg.workspace, (e) => log.error("people: registry unreadable at boot, starting with nobody (Brain falls back to the approved baseline)", { error: String(e).slice(0, 200) })),
    // hhd 起来时对调试端口的那一眼（browser.holder()）这里故意没有：它看这台机器的进程和一个本地端口，离线的世界里不碰
    registryFile: registryFileOf(cfg.workspace), plugins: [skillsPlugin], gateway, send: channels.send, browser: new Chrome({ ...cfg.browser, shotsDir: join(cfg.stateDir, "shots") }),
    situation, refreshSkills, modules, ...(mem ? { mem } : {}), ...(learning ? { learning } : {}),
    // hhd 不传、这里换掉的：外部命令、时钟、延时、气泡间隔
    run, now: () => clock.now, later: (fn, ms) => { const h = clock.setTimeout(fn, ms); return () => clock.clearTimeout(h); }, bubbleGapMs: () => 0,
  });
  const chores = mem ? new MemChores({
    mem, exportsDir: join(cfg.stateDir, "exports"), tz: cfg.schedule.timezone, now: Date.now,
    asleep: () => brain.alertness === "asleep", log: (msg, data) => log.warn(msg, data),
  }) : null;
  process.on("unhandledRejection", (e) => log.error("unhandled rejection", { error: e instanceof Error ? e.stack : String(e) }));

  // hhd 起来以后、开控制 socket 之前：relay 存下的消息先补交；以后每次 tick 再看一眼
  const drainSpool = (): void => brain.drainRelaySpool();
  // hhd 定时器回调的身子，一步一步照抄（补交在 ticking 那一关前面）；健康标记（health.tick）和重启闸门（restartGate.tick）不要
  let ticking = false;
  const tickBody = async (): Promise<void> => {
    drainSpool();
    if (ticking) return;
    ticking = true;
    try { await brain.tick(); } catch (e) { log.error("tick failed", { error: e instanceof Error ? e.stack : String(e) }); }
    try { chores?.tick(); } catch (e) { log.error("event memory chores failed", { error: e instanceof Error ? e.stack : String(e) }); }
    try { if (learning && brain.alertness !== "asleep" && learning.refreshIfChanged()) log.info("learning: shelf changed, rescanned"); }
    catch (e) { log.warn("learning: shelf refresh failed", { error: String(e).slice(0, 200) }); }
    finally { ticking = false; }
  };

  // 安静：从上次问到现在没有新记录（在跑的剧本、tick 由 clock.run 登记）
  let seen = rec.count;
  clock.setQuiet(() => {
    const quiet = rec.count === seen;
    seen = rec.count;
    return quiet;
  });

  return {
    cfg, loaded, brain, db, driver, clock, rec,
    start: () => {
      brain.start();
      // 这一句照抄 hhd（回放里 HOME 是工作副本，状态目录叫 .hh 的快照不会说这句；没有通道走 OpenClaw 网关的角色不说）
      if (usesGateway(cfg) && spoolDirOf(cfg.stateDir) !== join(homedir(), ".hh", "relay-spool")) log.warn("relay spool: stateDir is not ~/.hh, messages hh-relay stores while hhd is away won't be found here", { stateDir: cfg.stateDir });
      drainSpool();
    },
    play: async (region, script) => {
      rec.add("script", { region, script });
      await clock.run(driver.latest(region).play(script));
    },
    tick: () => clock.run(tickBody()),
    drain: () => clock.drain(),
    answerRun: (fn) => { runAnswer = fn; },
    recordState: () => {
      rec.add("state", { name: "status", value: brain.status() });
      rec.add("state", { name: "db", value: dbDigest(db, (v) => rec.normalize(v)) });
      rec.add("state", { name: "files", value: changedFiles(o.work, before, ignore) });
    },
    close: async () => {
      await clock.run((async () => {
        await brain.stop();
        await closeComputerNow().catch(() => {});
      })());
      db.close();
    },
  };
}
