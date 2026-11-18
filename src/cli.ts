// hh：控制台命令。
//   hh status                      大脑现在的状态
//   hh tell --from <是谁> "话"      以某人的身份给她发一条（渠道 local）；不写 --from 只在主人自己的终端里行（按名单里的主人发），空消息不发
//                                   a role with no channel: waits for the turn on it and prints what it said
//   hh <命令> --help（或 -h）        只打这段用法，什么都不做
//   hh wake <脑区> "话"             直接叫醒某个脑区（调试用）
//   hh events [n]                  中央记忆最后 n 条
//   hh sleep | hh pageturn         手动让她睡觉 / 翻页（hh sleep 后面跟别的词：打用法、退出码 2，不睡）
//   hh sleep plan                  今晚夜里整理的先后（分段引擎排的波次；用旧的整理就说为什么）
//   hh sleep bank import <文件> [--tag <标签>] [--layer resident|searchable|archive]
//                                  把白天体检的题文件导进夜里考试的题库（标签默认文件名，层默认 searchable；路径要 hhd 读得到）
//   hh sleep bank stats            题库：生效/待定/退休、各层题数、最近 30 天整理后通过率
//   hh sleep replay <日> [--base <提交>] [--flow-dir <目录>] --i-know-it-spends-quota
//                                  在隔离的工作区和事件库拷贝上，用新的流程把那一天重新整理一遍（后台跑，马上回回放目录；不调 OpenAI）。
//                                  开的是真的模型会话、花她这周的额度：新的睡眠 2026-11-13 停了，不加最后那个参数就只说一句、退出码 1、不连 hhd（hhd 那边也核）
//   hh sleep replay-status          回放的进度（没在跑就是最近一个的结果）
//   hh sleep replay-stop            叫停在跑的回放（开着的会话关掉；真的夜里开始时也会自己停）
//   hh mem <动作> …                 事件记忆：stats ls show person search period reverse quotes worklist batches ops revert export midterm backfill assoc-stats sync-people import
//   hh people approve <key>         批准名单里这个人现在的权限（她自己加的人超出访客上限的字段平时会被裁掉）
//   hh learn <动作> …               学习：scan stats [天数] week replay ids case add <页编号> <话题…> / case ls
//   hh gate probe                   闸门：量一次性调用的开销（空 system / 人格卡两次，看缓存）
//   hh gate replay <起> <止>         闸门：拿 senses/events.jsonl 里这一段（ISO 时间）重判一遍，只判不送、不记账（小判断照调，花一点额度）
//   hh send <人名或号码> <话…> [--channel whatsapp|qqbot] [--media 路径]
//                                  直接连网关发一条（不经 hhd，角色挂了也能用）：看门狗、负载告警、/cc 用
//   hh channels | hh channels restart <通道>
//   hh channels add <whatsapp|qq> … | hh channels link whatsapp --phone <number> | hh channels remove <channel>
//                                  Give the role a bridged channel, link WhatsApp as a new device (pairing code), take a channel away
//                                  How each channel is reached and what its bridge says of itself (connected, logged out, how many
//                                  messages wait); restart: stop a channel's bridge by its pid record, launchd starts it again. Not via hhd
//   hh outbound latin [on [--minutes N] | off]
//                                  Latin-only lines may go to anyone for a while (writes outbound.latinLinesFile); not via hhd
//   hh browser status | stop | cookies <网址>
//                                  她的 Chrome（cookies：B站 插件同步登录用；没开就临时无头开一下再关）
//   hh fix check|merge|audit|log|summary …  /  hh deploy [<提交>]
//                                  自己修 HH（见 src/repair/cli.ts），不经 hhd
//   hh console [--pair]            Open the role's console in your browser, on the talk page; the first time (or with --pair) it
//                                  pairs the browser first. Operator only
//   hh new <id> --owner <主人的名字> [--dir <目录>] [--me <名字>] [--lang <语言包>] [--persona <name>]
//   hh setup [--lang zh|en] [--name …] [--owner …] [--id …] [--model opus|sonnet|haiku] [--dir …] [--no-app] [--yes]
//                                  A role from nothing, in one go (./setup checks what it needs first): hh new, install, its window
//   hh remove <id> [--yes]         A role off this computer: its jobs, app, directory, short command, grants (asks once)
//                                  建一个新角色：一个目录，里面是它的实例配置和人格文件骨架（不连 hhd、不读任何现有角色的配置）
//   hh modules list | doctor | check <name> | install | run <module> <script> [args…]
//                                  Modules: which there are and whether each is on; check each (requirements, config, manuals
//                                  that clash, its own check; exit code 1 when one is broken); link the on modules' manuals onto the shelf; run a module's
//                                  script under its environment (what its bin/ wrappers call). Not through hhd
//   hh openai [status] | set | check | remove
//                                  The role's OpenAI key (state/secrets.json, 0600): memory and the notebook by meaning with one, by
//                                  words without. set takes it typed at a prompt (not shown) or piped in, never as an argument, checks
//                                  it and keeps it only if HH can use it; hhd takes a change up by itself, restarting once the role is
//                                  calm. Operator only, not through hhd
//   hh lang status [<code>] [--list <part>]
//                                  What a language pack has of its own, per part, and what it still reads from the reference pack
//                                  (default: every pack being translated); --list: the missing entries of one part. Reads no config
// 这两样以前都起 openclaw 命令行（每次 4–6 秒、三四百兆内存，不要走 OpenClaw）。
import { join } from "node:path";
import { loadConfig, requireInstance, roleNames } from "./config.ts";
import { B, setLang } from "./lang/index.ts";
import { request, UsageError } from "./control.ts";
import { parse, usage, wantsHelp, ownerNameOf } from "./cli-parse.ts";
import { People } from "./persona/people.ts";
import { sendCommand, browserCommand, channelsCommand, langCommand, outboundCommand } from "./cli-direct.ts";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { fixCommand, repairCommand, defaultEnv } from "./repair/cli.ts";
import { numbersCommand } from "./metrics/numbers.ts";
import { noteEntryFailure } from "./instance-trace.ts";
import { newCommand } from "./new.ts";
import { removeCommand } from "./remove.ts";
import { setupCommand } from "./setup.ts";
import { operatorOnly } from "./operator.ts";
import { modulesCommand } from "./modules/doctor.ts";
import { openaiCommand } from "./openai.ts";
import { consoleAs, consoleCommand } from "./console/open.ts";

const argv = process.argv.slice(2);
// 看用法：只打用法，什么都不做（不发消息、不部署、不叫醒谁）
if (wantsHelp(argv)) { console.log(usage()); process.exit(0); }
// hh console --as <account>: the owner opens the console of a role under another account, with no config of its own here
if (argv[0] === "console" && argv.includes("--as")) {
  try {
    operatorOnly();
    console.log(await consoleAs(argv.slice(1)));
    process.exit(0);
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
// A new role has no config yet, and what a language pack lacks is the same for every role: both handled before any config is read
if (argv[0] === "new" || argv[0] === "lang" || argv[0] === "setup" || argv[0] === "remove") {
  try {
    // refused in a role's own session, in that role's words when its config can be read
    if (argv[0] !== "lang") operatorOnly(process.env, loadConfig);
    console.log(argv[0] === "new" ? await newCommand(argv.slice(1)) : argv[0] === "setup" ? await setupCommand(argv.slice(1))
      : argv[0] === "remove" ? await removeCommand(argv.slice(1)) : langCommand(argv.slice(1)));
    process.exit(0);
  } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
}
// fix, deploy and numbers often run under the role's own account (sudo -u) with no HH_CONFIG: that account's config,
// not the defaults, which would send everything in rehearsal mode
if ((argv[0] === "fix" || argv[0] === "deploy" || argv[0] === "numbers") && !process.env.HH_CONFIG && existsSync(join(homedir(), ".hh", "config.json"))) {
  process.env.HH_CONFIG = join(homedir(), ".hh", "config.json");
}
const cfg = loadConfig();
// 这个人格自己的几样（工作区、状态目录、闸门开着时的名字）没配：一行说缺哪个，不往下走
// 漏带实例配置的入口留一行痕（hhd 会报出来），再照旧报错退出
// 先打报错、再留痕：报错不能等留痕（留痕要问 ps，出什么岔子都不该耽误这一行）。hhd 和控制台是记完再抛——留痕现在不会阻塞了
try { requireInstance(cfg); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); noteEntryFailure(e, argv[0] ?? ""); process.exit(1); }
// 角色读到的字按这个实例的语言取（和 hhd、控制台一样）：命令行里也有给角色看的话（hh send 的回话、不经 hhd 直接跑的那几条命令）
setLang(cfg.lang, roleNames(cfg));
if (argv[0] === "fix" || argv[0] === "deploy") {
  try {
    console.log(await (argv[0] === "deploy" ? repairCommand(argv, defaultEnv(cfg)) : fixCommand(argv.slice(1), defaultEnv(cfg))));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
if (argv[0] === "numbers") {
  // 周表的五个数：只读本地数据，不经 hhd（读会话记录要几秒，别占着她的进程）
  try {
    console.log(numbersCommand(cfg, argv.slice(1)));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
if (argv[0] === "console") {
  try {
    operatorOnly();
    console.log(await consoleCommand(cfg, argv.slice(1)));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
if (argv[0] === "openai") {
  try {
    operatorOnly();
    console.log(await openaiCommand(cfg, argv.slice(1)));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
if (argv[0] === "modules") {
  try {
    if (argv[1] === "install" || argv[1] === "app") operatorOnly();
    const { text, code, err } = await modulesCommand(cfg, argv.slice(1));
    if (text) console.log(text);
    if (err) process.stderr.write(err);
    process.exit(code);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
if (argv[0] === "send" || argv[0] === "browser" || argv[0] === "outbound" || argv[0] === "channels") {
  // 不经 hhd：自己连网关 / 连 Chrome。连着的 Chrome 会让进程一直挂着，做完直接退出
  try {
    const res = argv[0] === "send" ? await sendCommand(cfg, argv.slice(1))
      : argv[0] === "outbound" ? outboundCommand(cfg, argv.slice(1))
      : argv[0] === "channels" ? (["add", "link", "remove"].includes(argv[1] ?? "") && operatorOnly(), await channelsCommand(cfg, argv.slice(1))) : await browserCommand(cfg, argv.slice(1));
    console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
type EventRow = { seq: number; src: string; kind: string; text: string; failed?: boolean };
const lastSeq = (rows: unknown): number => (rows as EventRow[]).at(-1)?.seq ?? 0;
const LOCAL_REPLY_MIN = 10;

/** What the main region said after `before`, once it has said something and is idle again (or LOCAL_REPLY_MIN have gone by);
 *  a turn on it that failed says why at once */
async function localReply(sock: string, before: number): Promise<string> {
  const until = Date.now() + LOCAL_REPLY_MIN * 60_000;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1_000));
    const said = ((await request(sock, { cmd: "events", n: 500, full: true }, 30_000)) as EventRow[]).filter((e) => e.seq > before && e.src === "main" && (e.kind === "say" || e.failed));
    const status = (await request(sock, { cmd: "status" }, 30_000)) as { regions: Array<{ id: string; busy: boolean }> };
    const busy = status.regions.find((r) => r.id === "main")?.busy ?? false;
    if (said.length && !busy) return said.map((e) => e.text).join("\n");
    if (Date.now() > until) return said.map((e) => e.text).join("\n") || B.cliParse.tellNoReply(LOCAL_REPLY_MIN);
  }
}

try {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY;
  const req = parse(argv, { interactive, owner: () => ownerNameOf(People.load(cfg.workspace).registry) });
  const sock = join(cfg.stateDir, "hh.sock");
  // a role with no channel has no way to answer a tell: wait for the turn on it and print what it said (the local way back)
  const local = req.cmd === "tell" && Object.keys(cfg.channels).length === 0;
  const before = local ? lastSeq(await request(sock, { cmd: "events", n: 1 }, 30_000)) : 0;
  // 事件记忆的导入、学习的回测和刷封面都可能很久
  const res = await request(sock, req, req.cmd === "mem" || req.cmd === "learn" || req.cmd === "gate" ? 3_600_000 : 30_000);
  console.log(local ? await localReply(sock, before) : typeof res === "string" ? res : JSON.stringify(res, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(e instanceof UsageError ? 2 : 1);
}
