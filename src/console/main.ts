// 控制台入口：node src/console/main.ts（launchd ai.hh.console 跑的就是这个）
//   HH_CONSOLE_PORT  port (127.0.0.1 only); the instance must give it
//   HH_CC_DIR        folder of the helper sessions; default is where the role's helpers module keeps them, and with the module off the helpers panel is not shown
import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { consoleUsageCache, loadConfig, requireInstance, roleNames } from "../config.ts";
import { B, setLang } from "../lang/index.ts";
import { teamDirsOf } from "../metrics/numbers.ts";
import { createConsole } from "./server.ts";
import { loadWeb } from "./web.ts";
import { defaultLang, isLang, translator } from "./lang/index.ts";
import { runtimeFactsOf, runtimeNote, MEMORY_FILES, memoryFrame } from "../persona/persona.ts";
import { regionSpecs } from "../regions/specs.ts";
import { projectDirFor } from "./prompt.ts";
import { pageMarks } from "./packtext.ts";
import { sleepWeights } from "../sleep/host.ts";
import { noteEntryFailure } from "../instance-trace.ts";
import { sourcesOf } from "../gate/sources.ts";
import { markConsole } from "../repair/restart.ts";
import { helperSessionsDir } from "../basal/dispatch.ts";
import { ownerNameOf } from "../cli-parse.ts";
import { People } from "../persona/people.ts";
import { talkOf } from "./owner.ts";
import { services } from "../services/index.ts";

const cfg = loadConfig();
try { requireInstance(cfg); } catch (e) { noteEntryFailure(e, "console"); throw e; }
setLang(cfg.lang, roleNames(cfg));   // 她那边的字（记忆层的话）按她的语言取：控制台要认出其中几句（packtext.ts）
const port = Number(process.env.HH_CONSOLE_PORT);
if (!Number.isInteger(port) || port <= 0) { console.error("HH_CONSOLE_PORT is not set"); process.exit(1); }
const here = dirname(fileURLToPath(import.meta.url));
const helperDir = process.env.HH_CC_DIR || helperSessionsDir(cfg);
// the skill manuals the memory page lists: skills.discover, when it lies inside the workspace (the console reads nothing outside it)
const skillsDir = cfg.skills.discover ? relative(cfg.workspace, cfg.skills.discover) : "";
// which region a session record belongs to: its first message starts with that region's opening title, as the role's language pack writes it
const markers = [...new Set(regionSpecs(cfg).map((s) => s.role))].map((role) => ({ role, marker: B.specs.openings[role] }));
// talking as the owner (owner.ts): the owner is who hh tell speaks as when --from is not given; no owner = read-only
// a role under an account of its own names its token file in a config it can change: one it could write keeps the pane off
const tell = talkOf(cfg, ownerNameOf(People.load(cfg.workspace).registry), undefined, undefined, (what) => console.warn(translator(isLang(cfg.lang) ? cfg.lang : defaultLang())("api.tokenNotOwners", { what, user: userInfo().username })));
const server = createConsole({
  regions: regionSpecs(cfg).map((s) => s.id),
  ...(tell ? { tell } : {}),
  // with the talk pane: the role's short command (command.ts); a role under an account of its own: the owner's one command
  role: cfg.id,
  // the role's app (HH.app's launcher, the owner of its grants) opens its page of system permissions by its own link
  ...(cfg.launchd?.app && existsSync(cfg.launchd.app) ? { grants: `ai.hh.role.${cfg.id}://grants` } : {}),
  loadStatus: join(cfg.stateDir, "modules", "load-guard", "status.json"),
  // the roles on this computer: HH.app gives each one a folder there; this account's launchd jobs besides
  machine: { shared: "/Users/Shared/HH", jobs: () => services().list(""), account: userInfo().username, port, ...(cfg.console?.lockDir ? { lockDir: cfg.console.lockDir } : {}) },
  command: tell ? `${cfg.id} console` : `hh console --as ${userInfo().username}`,
  ...(cfg.console?.permissionsCheck?.length ? { permissionsCheck: cfg.console.permissionsCheck } : {}),
  dbPath: join(cfg.stateDir, "hh.db"),
  sockPath: join(cfg.stateDir, "hh.sock"),
  logPath: join(cfg.stateDir, "logs", "hh.jsonl"),
  ...(helperDir ? { helperSessionsDir: helperDir } : {}),
  projectsDir: join(homedir(), ".claude", "projects"),
  ...loadWeb(join(here, "web")),
  // 没选过语言的人看到哪个语言：跟角色的语言走（config 的 lang，角色读哪个语言包）；控制台没有那个语言的界面就还是默认的
  ...(isLang(cfg.lang) ? { lang: cfg.lang } : {}),
  // the role's name on an English page: its id capitalised when the id is a Latin word (mira → Mira), else me as it is
  labels: { ...(cfg.console?.sourceLabels ? { source: cfg.console.sourceLabels } : {}), ...(cfg.console?.channelLabels ? { channel: cfg.console.channelLabels } : {}) },
  marks: pageMarks(),
  // the English pages call a role whose name is not in Latin letters by its id ("xiaoran" → "Xiaoran"); a Latin name stays itself
  names: { ...roleNames(cfg), ...(/^[a-z][a-z0-9]*$/i.test(cfg.id) && !/\p{Script=Latin}/u.test(cfg.names?.me ?? "") ? { meLatin: cfg.id[0]!.toUpperCase() + cfg.id.slice(1) } : {}) },
  memory: {
    workspace: cfg.workspace,
    stateDir: cfg.stateDir,
    ...(cfg.console?.memoryPage ? { layout: cfg.console.memoryPage } : {}),
    sleepDir: cfg.sleep.workDir,
    ...(skillsDir && !skillsDir.startsWith("..") ? { skillsDir } : {}),
    limits: {
      pageTokens: cfg.limits.pageTokens,
      maxContextTokens: cfg.limits.maxContextTokens,
      sleepyAtTokens: cfg.limits.sleepyAtTokens,
      mustSleepAtTokens: cfg.limits.mustSleepAtTokens,
    },
    files: cfg.personaFiles,
    runtimeNote: runtimeNote(cfg.writingLanguage, runtimeFactsOf(cfg)),
    night: cfg.schedule.nightSleep,
    frame: memoryFrame(),
    memoryFiles: MEMORY_FILES,
    ...(cfg.memory?.events ? { events: cfg.memory.events } : {}),
  },
  people: { template: cfg.memory?.people?.template, tz: cfg.schedule.timezone },
  prompt: { dir: projectDirFor(join(homedir(), ".claude", "projects"), cfg.workspace), markers },
  incidents: { dir: projectDirFor(join(homedir(), ".claude", "projects"), cfg.workspace), logPath: join(cfg.stateDir, "logs", "hh.jsonl"), tz: cfg.schedule.timezone, stateDir: cfg.stateDir, ...(process.env.HH_CONFIG ? { configPath: process.env.HH_CONFIG } : {}) },
  numbers: {
    projectsDir: join(homedir(), ".claude", "projects"), workspace: cfg.workspace, replay: [join(cfg.stateDir, "replay")], tz: cfg.schedule.timezone,
    team: teamDirsOf(cfg),   // 团队借她的额度干活用的目录（实例配置 metrics.teamDirs）：周表的用量里单列一栏；没配就是空的
    cacheFile: consoleUsageCache(cfg.stateDir),
  },
  gate: { workspace: cfg.workspace, tz: cfg.schedule.timezone, dailyUnits: cfg.gate.dailyUnits, haikuMultiplier: sleepWeights(cfg.sleep.weights).model.haiku, sources: sourcesOf(cfg) },
  learning: {
    root: cfg.learning.root, generalCategory: cfg.learning.generalCategory, archiveDir: cfg.learning.archiveDir, residentFile: cfg.learning.residentFile, tz: cfg.schedule.timezone, dailyUsd: cfg.learning.dailyUsd, shelf: cfg.learning.shelf,
    ...(cfg.learning.shelfFile ? { shelfFile: cfg.learning.shelfFile } : {}),
  },
  openai: { stateDir: cfg.stateDir, tz: cfg.schedule.timezone, dailyUsd: cfg.learning.dailyUsd },
});
server.listen(port, "127.0.0.1", () => {
  markConsole(cfg.stateDir, process.pid);   // a deploy restarts this role's console by this record, not by command line
  console.log(translator(isLang(cfg.lang) ? cfg.lang : defaultLang())("api.listening", { url: `http://127.0.0.1:${port}/` }));
  // 记忆页的几个统计第一次要把中央记忆整张数一遍（之后只数新增的）。起来就先数掉，别让第一个打开记忆页的人等
  setTimeout(() => { void fetch(`http://127.0.0.1:${port}/api/memory`).then((r) => r.arrayBuffer()).catch(() => { /* 数不了就等真有人看的时候再数 */ }); }, 1500).unref();
});
const stop = () => { server.closeAllConnections(); server.close(() => process.exit(0)); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
