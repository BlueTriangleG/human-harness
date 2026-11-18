// 后台那部分一轮结束了、事还没做完：接着做、等帮手、等人，还是先放下（spec 8.1）。
import type { TaskRow } from "./tasks.ts";
import { B } from "../lang/index.ts";

export type AfterTurn = "done" | "wait-helper" | "wait-person" | "continue" | "pause";

/** 连着几轮叫醒都没动手，就先放下 */
export const IDLE_WAKES_MAX = 3;

/**
 * 做太久了：钟表时间超过 max(k × about, about + 120) 分钟。k 平时是 3；定了标准的事按回头看的上限算（barFactor，4 倍）。
 * task.idleWakes 是算上这一轮之前的数；这一轮没用工具时再加一。
 */
export function overTime(task: TaskRow, now: number, barFactor?: number): boolean {
  const about = task.aboutMin ?? 30;
  const k = task.bar && barFactor ? barFactor : 3;
  return (now - task.started) / 60_000 > Math.max(k * about, about + 120);
}

export function afterBackgroundTurn(t: { task: TaskRow | undefined; helperRunning: boolean; sdkBackground: number; usedTools: boolean; now: number; barFactor?: number }): AfterTurn {
  const task = t.task;
  if (!task) return "done";
  if (overTime(task, t.now, t.barFactor)) return "pause";
  if (!t.usedTools && task.idleWakes + 1 >= IDLE_WAKES_MAX) return "pause";
  if (t.helperRunning || t.sdkBackground > 0) return "wait-helper";
  if (task.waitingFor) return "wait-person";
  return "continue";
}

/**
 * 帮手名：照 cc.py 的 check_name（字母、数字、中文、_、-，不收 .），另外不认 - 开头的（#0057：cc.py send --help 是在问用法，不是派活）。
 * 记派活和启动时认假帮手（ghostHelpers）都用这一条
 */
const CC_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_-]*$/u;
const ccName = (s: string | undefined): string | null => (s && CC_NAME.test(s) ? s : null);
/**
 * Bash 里 cc.py 后面的那个名字：按 shell 的分法取一整个词（空格、tab 分开；可以带引号；动作文本是 JSON，引号和换行都转义过，\ 也算边界）。
 * CEO 11-12：以前只认 ASCII、碰到不认得的字就停，cc.py send 剪片子 记不上，abc中文 记成 abc，剪片子，接着剪 记成 剪片子——
 * 可 cc.py 收到的是一整个词，不合规矩就什么都没派出去
 */
const W = String.raw`[^ \t\r\n"'\\;&|<>()\x60]+`;
// 带引号就要配对的引号（"my helper" 里有空格，不是 my）；词后面得是边界（"foo"bar 在 shell 里是 foobar，不是 foo）
// 动作文本是 JSON：不带反斜杠的 " 是命令结束；反斜杠只有 \n \t \r（转义的空白）算边界，紧跟 \" 是粘着一段引号里的字
const CC_WORD = String.raw`[ \t]+(?:\\"(${W})\\"|'(${W})'|(${W}))(?=$|[ \t;&|<>()\x60"]|\\[ntr])`;
// 只认 send：她的 cc.py 没有 new 这个命令（cc.py new X 只打印用法，以前却被记成派了帮手，CEO 11-12）
// cc.py run by python, or the helpers module's helper command (its bin/ wrapper)
const CC = String.raw`(?:\bpython3?\s+\S*cc\.py|(?<![\w./-])helper)`;
const CC_SEND = new RegExp(CC + String.raw`\s+send` + CC_WORD, "u");
const CC_STOP = new RegExp(CC + String.raw`\s+stop` + CC_WORD, "u");
const wordOf = (m: RegExpExecArray | null): string | undefined => (m ? m[1] ?? m[2] ?? m[3] : undefined);

/** 这个动作派了哪个 Claude Code 帮手：hands send，或者 Bash 里的 cc.py send */
/** 叫停帮手的那一步（hands stop 或 cc.py stop）：叫停的是谁（hands stop 不挑名字：挂着的假帮手她总能叫停） */
export function helperStoppedFromAct(text: string): string | null {
  const sp = text.indexOf(" ");
  const tool = sp > 0 ? text.slice(0, sp) : text;
  if (tool === "hands") {
    try {
      const a = JSON.parse(text.slice(sp + 1)) as { action?: string; name?: string };
      return a.action === "stop" && a.name ? a.name : null;
    } catch { return null; }
  }
  // 叫停只是从「在跑」里删，不用照 cc.py 的规矩核：带点的旧假帮手也能停；- 开头的仍是选项
  const w = wordOf(CC_STOP.exec(text));
  return w && !w.startsWith("-") ? w : null;
}

export function helperNameFromAct(text: string): string | null {
  const sp = text.indexOf(" ");
  const tool = sp > 0 ? text.slice(0, sp) : text;
  if (tool === "hands") {
    try {
      const a = JSON.parse(text.slice(sp + 1)) as { action?: string; name?: string };
      return a.action === "send" ? ccName(a.name) : null;
    } catch { return null; }
  }
  return ccName(wordOf(CC_SEND.exec(text)));
}

/**
 * 帮手派出去一天以上还没交回：问她一次要不要清。
 * HH 不替她判断它还在不在：她用 hands ls 自己看，要清就 hands stop
 */
export const HELPER_ASK_AFTER_MS = 24 * 3600_000;

/**
 * #0057 后续（CEO 11-12）：启动时挑出状态栏里根本不是帮手的名字，直接丢：名字不合规矩（--help、旧代码记下的带点的）、又没有会话文件的
 * （cc.py 其实也收 -x 这种名字，真派过、有 <名>.json 的照留）。hasSession 给 null = 不知道会话在哪（帮手模块没开，或它的会话目录不在）：照名字丢。
 * 挂得再久的不在这里丢，见 HELPER_ASK_AFTER_MS
 */
export function ghostHelpers(busy: Record<string, number>, hasSession: ((name: string) => boolean) | null): string[] {
  const session = (name: string): boolean => !!hasSession && !name.includes("/") && hasSession(name);
  return Object.keys(busy).filter((name) => !CC_NAME.test(name) && !session(name));
}

/** 文件名后缀：她干活时碰的稿、图、音视频、脚本 */
/** 从一段名字的开头算起（「out/%03d.jpg」这种模板不算） */
const FILE_RE = /(?<![%\w.\-\u4e00-\u9fff])(?:[\w.\-\u4e00-\u9fff]+\/)?[\w.\-\u4e00-\u9fff]+\.(?:md|txt|json|py|ts|js|html|css|png|jpe?g|webp|gif|svg|mp4|mov|webm|wav|mp3|m4a|srt|ass|psd|pdf)\b/g;
const CMD_RE = /\b(ffmpeg|ffprobe|whisper|mlx_whisper|magick|yt-dlp|tts|sips|blender|remotion)\b|phone\.py\s+(\w+)|cc\.py\s+(send)/g;

/** 动作里真正碰的东西：Bash 的命令；读写改的文件路径（不扫 Write、Edit 写进去的正文，正文里提到的文件不算碰过） */
const PATH_KEYS = ["file_path", "notebook_path", "path", "media", "image", "file"];
function touchedText(act: string): string[] {
  const sp = act.indexOf(" ");
  if (sp < 0) return [];
  let input: unknown;
  try { input = JSON.parse(act.slice(sp + 1)); } catch { input = null; }
  if (input && typeof input === "object") {
    const o = input as Record<string, unknown>;
    return [o.command, ...PATH_KEYS.map((k) => o[k])].filter((v): v is string => typeof v === "string");
  }
  // 截断了解析不了：只取这几个字段的值
  return [...act.matchAll(/"(?:command|file_path|notebook_path|path|media|image|file)":"((?:[^"\\]|\\.)*)/g)].map((m) => m[1]!);
}

/**
 * 这几步碰了什么（干活时联想用，11-03）：动作里的文件（带上一级目录）和几个看得出在干什么的命令，去重、按最后碰的先后，最多 n 个。
 * 「在干什么，看文件名往往最准」
 */
export function touchedOf(acts: string[], n = 6): string[] {
  const seen: string[] = [];
  const add = (x: string): void => {
    const i = seen.indexOf(x);
    if (i >= 0) seen.splice(i, 1);
    seen.push(x);
  };
  for (const a of acts) {
    for (const t of touchedText(a)) {
      for (const m of t.matchAll(FILE_RE)) add(m[0]);
      for (const m of t.matchAll(CMD_RE)) add(m[1] ?? (m[2] ? `phone ${m[2]}` : B.lifecycle.touchedHelper(m[3])));
    }
  }
  return seen.slice(-n);
}

/** 帮手回报里是哪个帮手：Claude Code「x」 */
export function helperNameFromReport(text: string): string | null {
  return /Claude Code「([^」]+)」/.exec(text)?.[1] ?? null;
}

/** 后台记下「要问 X：…」时，要问的是谁 */
export function askedPerson(note: string): string | null {
  const m = B.forms.askLine.exec(note);
  return m ? m[1]! : null;
}

/**
 * 前台派了帮手，挂不挂到前台手上那件事上（#0052）：前台那件事常常一整天没收，期间回人、处理提醒派的帮手都被挂上去了。
 * 只在两条都满足时挂：那件事还新鲜（开了不超过 2 × 估时，没估按 30 分钟）；帮手是在这件事里出生的（没挂到过别的事上，或者已经挂在这件事上）。
 */
export function attachHelperTo(t: { task: TaskRow; helper: string; now: number; seenElsewhere: boolean }): boolean {
  const fresh = t.now - t.task.started <= 2 * (t.task.aboutMin ?? 30) * 60_000;
  const bornHere = !t.seenElsewhere || t.task.helpers.includes(t.helper);
  return fresh && bornHere;
}
