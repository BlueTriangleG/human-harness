// ops/check-instance-entries.sh：只读检查每条直接起 src/cli.ts / src/hhd.ts / src/console/main.ts 的入口有没有往环境里放 HH_CONFIG。
// 在临时目录里造一个假的家和假的 launchd 目录跑；要在 macOS 自带的 /bin/bash（3.2）下跑，那里的老毛病（变量后紧跟中文）是这个测试要守住的。
// 第三轮的规矩：只有「它自己和起它的 plist 里哪儿都没有 HH_CONFIG 这几个字」才红（拦部署）；提到了但写法不认得是「看」，不拦；
// 没判成（工具不能用、搜索没跑完 / 没跑全、某个入口没判出来、数不出数）一律退出码 3，不会说「没有红的」
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpDir } from "./tmp.ts";

const SCRIPT = fileURLToPath(new URL("../ops/check-instance-entries.sh", import.meta.url));
const BASH = "/bin/bash";
const skip = existsSync(BASH) ? false : `${BASH} does not exist on this machine`;
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
// 每次起进程都有上限：脚本卡住 = 失败，不是整个测试卡死
const BOUND = { encoding: "utf8" as const, timeout: 60_000, killSignal: "SIGKILL" as const };
// mode 000 的文件和目录：root 照样读得了，这几条在 root 下没法测
const asRoot = process.getuid?.() === 0 ? "running as root: a mode 000 file or directory is readable" : false;

test("语法过得去；变量后面紧跟非 ASCII 字符的地方一个都没有（bash 3.2 会吞字节）；没有 here-document / here-string", { skip }, () => {
  const syn = spawnSync(BASH, ["-n", SCRIPT], BOUND);
  assert.equal(syn.status, 0, syn.stderr);
  const g = spawnSync("grep", ["-n", "-E", "\\$[A-Za-z_][A-Za-z0-9_]*[^ -~[:space:]]", SCRIPT], { ...BOUND, env: { ...process.env, LC_ALL: "C" } });
  assert.equal(g.status, 1, `grep 自己出错了：${g.stderr}`);
  assert.equal(g.stdout, "", `这些行里变量后面直接跟了非 ASCII 字符：\n${g.stdout}`);
  // 不用 here-document / here-string（bash 3.2 会为它们写临时文件，「不写任何文件」就不成立了）
  const h = spawnSync("grep", ["-n", "<<", SCRIPT], BOUND);
  assert.equal(h.status, 1, `grep 自己出错了：${h.stderr}`);
  assert.equal(h.stdout, "", `脚本里有 here-document / here-string：\n${h.stdout}`);
});

type Where = "instance" | "default" | "none";
interface Fake { home: string; launchd: string; ws: string; code: string }

/** 只有骨架的假家：hh 那层脚本（带默认值，绿）、配置、空的 scripts 和 tools（tools 是符号链接）、空的 launchd 目录 */
function baseHome(where: Where = "default"): Fake {
  const home = tmpDir("hh-entries-");
  const code = join(home, "code");
  const ws = join(home, "ws");
  const launchd = join(home, "LaunchAgents");
  for (const d of [join(home, ".local", "bin"), join(home, ".hh"), join(code, "config"), join(ws, "scripts"), join(home, "real-tools"), launchd]) mkdirSync(d, { recursive: true });
  symlinkSync(join(home, "real-tools"), join(ws, "tools"));   // tools 目录本身是符号链接
  writeFileSync(join(home, ".local", "bin", "hh"), `#!/bin/sh\nexport HH_CONFIG="\${HH_CONFIG:-${home}/.hh/config.json}"\nexec node ${code}/src/cli.ts "$@"\n`);
  chmodSync(join(home, ".local", "bin", "hh"), 0o755);
  writeFileSync(join(home, ".hh", "config.json"), where === "instance" ? `{\n  "workspace": "${ws}",\n  "stateDir": "/x",\n  "other": { "workspace": "/nonexistent-other" }\n}\n` : "{}\n");
  writeFileSync(join(code, "config", "default.json"), where === "default" ? JSON.stringify({ workspace: ws }, null, 2) + "\n" : "{}\n");
  return { home, launchd, ws, code };
}

/** 一个 launchd plist：ProgramArguments 是给的几项；extra 放在 dict 里（比如 EnvironmentVariables） */
function plist(f: Fake, label: string, args: string[], extra = ""): string {
  const p = join(f.launchd, `${label}.plist`);
  writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n<key>Label</key><string>${label}</string>\n${extra}<key>ProgramArguments</key>\n<array>${args.map((a) => `<string>${a}</string>`).join("")}</array>\n</dict>\n</plist>\n`);
  return p;
}
const ENV_PATH_ONLY = "<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string></dict>\n";

/** 工作区路径放在哪：实例配置里（上线以后的样子）、代码目录的默认配置里（上线以前）、哪里都没有 */
function fakeHome(where: Where = "default"): Fake {
  const f = baseHome(where);
  const { home, ws, launchd, code } = f;
  const S = (name: string, text: string): void => writeFileSync(join(ws, "scripts", name), text);
  const call = (arg: string): string => `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "${arg}"])\n`;
  // 绿：自己往环境里放了
  S("green_own.py", `import os, subprocess\nenv = dict(os.environ)\nenv["HH_CONFIG"] = "/x/config.json"\nsubprocess.run(["node", "code/src/cli.ts", "status"], env=env)\n`);
  // 红：自己没带，起它的 plist 也没带（两边都没有这几个字）
  S("red_job.py", call("status"));
  writeFileSync(join(launchd, "job.red.plist"), `<plist><dict><key>Label</key><string>job.red</string><key>ProgramArguments</key><array><string>python3</string><string>${ws}/scripts/red_job.py</string></array></dict></plist>\n`);
  // 绿：自己没带，plist 带了
  S("green_plist.py", `import subprocess\nsubprocess.run(["node", "code/src/hhd.ts"])\n`);
  writeFileSync(join(launchd, "job.green.plist"), `<plist><dict><key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>/x/config.json</string></dict><key>ProgramArguments</key><array><string>${ws}/scripts/green_plist.py</string></array></dict></plist>\n`);
  // 看：谁都没起（在符号链接的 tools 目录里）
  writeFileSync(join(home, "real-tools", "orphan.py"), call("tell"));
  // 看：只有名字里带它的字（plist 里写的是 my_job.py，不是 job.py）
  S("job.py", call("wake"));
  writeFileSync(join(launchd, "job.other.plist"), `<plist><dict><key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>/x</string></dict><key>ProgramArguments</key><array><string>${ws}/scripts/my_job.py</string><string>${ws}/scripts/job.py.old</string></array></dict></plist>\n`);
  // 看：名字里有 .bak 但不是备份
  S("x.bakery.py", call("send"));
  // 备份：不算
  S("red_job.py.bak-20261101", call("status"));
  // 这几种提到了 HH_CONFIG、其实没往环境里放：plist 起它们，但只是「看」——提到了就不红
  S("commented.py", `import subprocess\n# env["HH_CONFIG"] = "/x"\nsubprocess.run(["node", "code/src/cli.ts", "a"])\n`);
  S("read_only.py", `import os, subprocess\ncfg = os.environ["HH_CONFIG"]\nsubprocess.run(["node", "code/src/cli.ts", "b"])\n`);
  S("printed.py", `import subprocess\nprint("run it as HH_CONFIG=/x hh status")\nsubprocess.run(["node", "code/src/cli.ts", "c"])\n`);
  S("old_name.sh", `OLD_HH_CONFIG=1\nnode code/src/cli.ts d\n`);
  // 测试文件：不是入口，列名字；但有 plist 点它的名就还是入口（下面的 test_job.py：两边都没有这几个字，红）
  S("test_something.py", call("status"));
  S("test_job.py", call("status"));
  // 带没带：每种写法一个文件，没有 plist 起它们，所以带了是绿、没带是看（g_ = 该绿，n_ = 不该绿）
  const G = (name: string, text: string): void => S(name, `${text}\n${call("shape").trim()}\n`);
  G("g_kwarg.py", `import os\nenv = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(p))`);
  G("g_setdefault.py", `import os\nos.environ.setdefault('HH_CONFIG', "/x")`);
  G("g_dict.py", `import os\nenv = {**os.environ, "HH_CONFIG": p}`);
  G("g_js.js", `const env = { ...process.env, HH_CONFIG: file };`);
  G("g_exec.sh", `exec env HH_CONFIG=/x node code/src/cli.ts "$@"`);
  G("g_prefix.sh", `A=1 HH_CONFIG=/x node code/src/cli.ts "$@"`);
  G("g_export.sh", `export HH_CONFIG="\${HH_CONFIG:-/x}"`);
  G("n_const.py", `HH_CONFIG="/x"`);
  G("n_read.py", `import os\ncfg = os.environ["HH_CONFIG"]`);
  G("n_comment.py", `# env["HH_CONFIG"] = "/x"`);
  G("n_trailing.py", `x = 1  # HH_CONFIG=/x`);
  G("n_print.py", `print("run it as HH_CONFIG=/x")`);
  G("n_old.sh", `OLD_HH_CONFIG=1`);
  // plist 起的脚本：env 的写法带了是绿；XML 注释里的 <key> 不算带了，但提到了，是看
  S("g_viaplist.py", call("viaplist"));
  writeFileSync(join(launchd, "job.env.plist"), `<plist><dict><key>ProgramArguments</key><array><string>/usr/bin/env</string><string>HH_CONFIG=/x</string><string>python3</string><string>${ws}/scripts/g_viaplist.py</string></array></dict></plist>\n`);
  S("n_xmlcomment.py", call("xml"));
  writeFileSync(join(launchd, "job.xml.plist"), `<plist><dict>\n<!-- <key>HH_CONFIG</key> -->\n<key>ProgramArguments</key><array><string>${ws}/scripts/n_xmlcomment.py</string></array></dict></plist>\n`);
  // plist 里只写文件名（WorkingDirectory + 裸名字、或 python3 名字）：照样是起它的，两边都没有这几个字就是红
  S("relative_job.py", call("rel1"));
  S("relative_cmd.py", call("rel2"));
  writeFileSync(join(launchd, "job.cwd.plist"), `<plist><dict><key>WorkingDirectory</key><string>${ws}/scripts</string><key>ProgramArguments</key><array><string>relative_job.py</string><string>python3 relative_cmd.py</string></array></dict></plist>\n`);
  const names = ["commented.py", "read_only.py", "printed.py", "old_name.sh", "test_job.py"];
  writeFileSync(join(launchd, "job.many.plist"), `<plist><dict><key>ProgramArguments</key><array>${names.map((n) => `<string>${ws}/scripts/${n}</string>`).join("")}</array></dict></plist>\n`);
  // 控制台直接由 plist 起、plist 里没有这几个字：红
  writeFileSync(join(launchd, "console.plist"), `<plist><dict><key>ProgramArguments</key><array><string>node</string><string>${code}/src/console/main.ts</string></array></dict></plist>\n`);
  return f;
}
const ENV = { PATH: "/usr/bin:/bin", TMPDIR: "/nonexistent-tmp" };
const DONE = /^entry-check: done red=(\d+) look=(\d+)$/;
/** 跑完的标记：退出码 0 和 1 的输出最后一行是它（数和红、看的行数对得上，1 的 red ≥ 1，0 的 red = 0）；2、3 的输出里哪儿都没有它。每次跑都核一遍 */
function doneLine(r: SpawnSyncReturns<string>): SpawnSyncReturns<string> {
  // 只有一条流：参数读完以后 stderr 并进 stdout，所以 stderr 永远是空的（只有 bash 自己的语法错误会在那之前写进去）
  assert.equal(r.stderr, "", `stderr 里不该有东西：\n${r.stderr}`);
  const last = r.stdout.trimEnd().split("\n").at(-1) ?? "";
  const m = DONE.exec(last);
  if (r.status === 0 || r.status === 1) {
    assert.ok(m, `退出码 ${r.status}，最后一行却不是跑完的标记：${last}`);
    const count = (mark: string): number => r.stdout.split("\n").filter((l) => l.startsWith(`${mark}  `)).length;
    assert.deepEqual([Number(m[1]), Number(m[2])], [count("红"), count("看")], last);
    assert.equal(Number(m[1]) > 0, r.status === 1, last);
  } else {
    assert.ok(!`${r.stdout}${r.stderr}`.includes("entry-check: done"), `退出码 ${r.status} 却印了跑完的标记`);
  }
  return r;
}
const run = (f: Fake, ...extra: string[]): SpawnSyncReturns<string> => doneLine(spawnSync(BASH, [SCRIPT, "--home", f.home, "--launchd-dirs", f.launchd, ...extra], { ...BOUND, env: ENV }));
const withGrep = (f: Fake, grep: string): SpawnSyncReturns<string> => doneLine(spawnSync(BASH, [SCRIPT, "--home", f.home, "--launchd-dirs", f.launchd], { ...BOUND, env: { ...ENV, HH_CHECK_GREP: grep } }));
/** 部署的钩子怎么跑它：脚本的文本当 bash -c 的参数（没有文件路径、没有结尾的换行），$0 = check-instance-entries */
const hookMode = (f: Fake): SpawnSyncReturns<string> =>
  doneLine(spawnSync(BASH, ["-c", readFileSync(SCRIPT, "utf8").replace(/\n$/, ""), "check-instance-entries", "--home", f.home, "--launchd-dirs", f.launchd], { ...BOUND, env: ENV }));
const row = (kind: string, file: string, rest: string): RegExp => new RegExp(`^${kind}  ${esc(file)}${rest}`, "m");
/** 某一行（绿 / 红 / 看 + 文件）连同它下面四个空格开头的几行；没有这一行就是 null */
function block(out: string, kind: string, file: string): string | null {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${kind}  ${file}：`));
  if (i < 0) return null;
  let j = i + 1;
  while (j < lines.length && lines[j]!.startsWith("    ")) j++;
  return lines.slice(i, j).join("\n");
}
const NOBODY = "    起它的：没有 launchd 任务点它的名（谁起它就继承谁的环境）";
/** 有红的时候结论里多说的一句：文件只是提到入口路径、并不起它们，怎么让它不拦 */
const MENTION_ONLY = "要是这个文件只是提到这几个路径、并不起它们：在文件里写一行注释说明（注释里带上 HH_CONFIG 这几个字），它就会列成「看」，不再拦。";
/** 行下面的一行文件内容：四个空格、行号、截到 100 个字符（这些夹具都是 ASCII，字节和字符一样多） */
const entry = (n: number, text: string): string => "    " + `${n}:${text}`.slice(0, 100);

test("假的家：绿、红、看各处、备份不算、测试文件按名字列、结论里的数对、退出码 1；把红的修好以后退出码 0", { skip }, () => {
  const f = fakeHome("default");
  const { ws, launchd } = f;
  const r = run(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = r.stdout;
  // 绿的行下面带着证据行（行号、四个空格开头）
  assert.match(out, row("绿", `${ws}/scripts/green_own.py`, `：自己往环境里放了 HH_CONFIG\\n    3:env\\["HH_CONFIG"\\] = "/x/config.json"`));
  assert.match(out, row("绿", `${ws}/scripts/green_plist.py`, `：自己没带，起它的 .*job\\.green\\.plist 带了\\n    1:`));
  assert.match(out, /^绿  .*\/\.local\/bin\/hh：自己往环境里放了 HH_CONFIG\n    2:export HH_CONFIG=/m);
  // 红的行下面：入口行和起它的
  assert.equal(block(out, "红", `${ws}/scripts/red_job.py`), `红  ${ws}/scripts/red_job.py：它和起它的 ${launchd}/job.red.plist 里都没有 HH_CONFIG 这几个字\n    2:subprocess.run(["node", "code/src/cli.ts", "status"])\n    起它的：${launchd}/job.red.plist`);
  assert.equal(block(out, "看", `${ws}/tools/orphan.py`), `看  ${ws}/tools/orphan.py：自己没有认得的 HH_CONFIG 写法，也没有 launchd 任务点它的名\n    2:subprocess.run(["node", "code/src/cli.ts", "tell"])\n${NOBODY}`, "符号链接的 tools 目录里的脚本也查了（路径是链接那一侧）");
  // 提到了 HH_CONFIG、但不是往环境里放：plist 起它们也只是看（不拦），行下面印着提到它的行和起它的
  for (const n of ["commented.py", "read_only.py", "printed.py", "old_name.sh"]) {
    const b = block(out, "看", `${ws}/scripts/${n}`);
    assert.ok(b, `${n} 应该是看：\n${out}`);
    assert.match(b, /\n    提到 HH_CONFIG（它自己）：1:|\n    提到 HH_CONFIG（它自己）：2:/, n);
    assert.match(b, new RegExp(`\\n    起它的：${esc(launchd)}/job\\.many\\.plist$`), n);
  }
  assert.match(out, row("红", `${ws}/scripts/test_job.py`, "："), "测试文件的名字、但有 plist 起它：两边都没有这几个字，红");
  assert.equal(block(out, "红", `${launchd}/console.plist`), `红  ${launchd}/console.plist：这个 plist 直接起入口，里面没有 HH_CONFIG 这几个字\n${entry(1, `<plist><dict><key>ProgramArguments</key><array><string>node</string><string>${f.code}/src/console/main.ts</string></array></dict></plist>`)}\n    起它的：launchd（照这个 plist 起）`, "控制台入口也查");
  // 名字只是片段的不算起它：job.py 是看，不是红；x.bakery.py 不是备份
  assert.match(out, row("看", `${ws}/scripts/x.bakery.py`, "："));
  assert.doesNotMatch(out, /\.bak-/);
  // 测试文件：不列成入口，按名字列在「跳」行里，再数一遍
  assert.match(out, new RegExp(`^跳  ${esc(ws)}/scripts/test_something\\.py$`, "m"));
  assert.doesNotMatch(out, /^(绿|红|看)  .*test_something/m);
  assert.match(out, /^（跳过测试文件 1 个：它们不是入口，名字见上面「跳」的行）$/m);
  // 写法逐个：该绿的绿（带证据行），不该绿的是看（没有 plist 起它们）。逐条记下哪条没对上，最后一起报
  const misses: string[] = [];
  const soft = (re: RegExp, label: string): void => { if (!re.test(out)) misses.push(label); };
  for (const n of ["g_kwarg.py", "g_setdefault.py", "g_dict.py", "g_js.js", "g_exec.sh", "g_prefix.sh", "g_export.sh"]) soft(row("绿", `${ws}/scripts/${n}`, "：自己往环境里放了 HH_CONFIG\\n    \\d+:"), `${n} 应该绿`);
  for (const n of ["n_const.py", "n_read.py", "n_comment.py", "n_trailing.py", "n_print.py", "n_old.sh"]) soft(row("看", `${ws}/scripts/${n}`, "："), `${n} 应该是看`);
  soft(row("绿", `${ws}/scripts/g_viaplist.py`, "：自己没带，起它的 .*job\\.env\\.plist 带了"), "g_viaplist.py 应该绿（plist 里 env 的写法）");
  soft(row("看", `${ws}/scripts/n_xmlcomment.py`, `：提到了 HH_CONFIG，但不是认得的写法（起它的 ${esc(launchd)}/job\\.xml\\.plist 里也没有认得的写法）`), "n_xmlcomment.py 应该是看（XML 注释不算带了，但提到了）");
  soft(new RegExp(`^看  ${esc(ws)}/scripts/n_xmlcomment\\.py：.*\\n(    .*\\n)*    提到 HH_CONFIG（起它的 plist）：2:<!-- <key>HH_CONFIG</key> -->\\n`, "m"), "n_xmlcomment.py 的看行下面印着 plist 里提到它的那一行");
  soft(row("红", `${ws}/scripts/relative_job.py`, "："), "relative_job.py 应该红（WorkingDirectory + 裸文件名）");
  soft(row("红", `${ws}/scripts/relative_cmd.py`, "："), "relative_cmd.py 应该红（python3 文件名）");
  soft(row("看", `${ws}/scripts/job.py`, "："), "job.py 应该是看（my_job.py、job.py.old 不是它）");
  soft(/入口：30 处；红 5 处，要人看 14 处。/, "结论里的数");
  assert.deepEqual(misses, []);
  assert.match(out, /不能部署/);
  assert.ok(out.includes(MENTION_ONLY), "有红的时候也说：只是提到这几个路径的文件怎么办");
  // 出路里只写真放进子进程环境的 shell 写法：光写 HH_CONFIG=… 那一行不导出，照着改还是会断
  assert.match(out, /shell export HH_CONFIG=…，或者和命令写在同一行 HH_CONFIG=… node …/);
  assert.doesNotMatch(out, /shell 命令开头的 HH_CONFIG=/);
  assert.equal(out.trimEnd().split("\n").at(-1), "entry-check: done red=5 look=14");
  assert.match(out, /给了 --home：这一条跳过/);
  assert.match(out, new RegExp(`改用 ${esc(f.home)}/\\.local/bin/hh`), "--home 真的生效了：用的是假家里的 hh，不是这台机器的");
  assert.equal(r.stderr, "");
  // 修好所有红的：往自己的环境里放 / 在 plist 里加
  const fix = `import subprocess, os\nsubprocess.run(["node", "code/src/cli.ts", "x"], env={**os.environ, "HH_CONFIG": "/x/config.json"})\n`;
  for (const n of ["red_job.py", "test_job.py", "relative_job.py", "relative_cmd.py"]) writeFileSync(join(ws, "scripts", n), fix);
  writeFileSync(join(launchd, "console.plist"), `<plist><dict><key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>/x</string></dict><key>ProgramArguments</key><array><string>${f.code}/src/console/main.ts</string></array></dict></plist>\n`);
  const ok = run(f);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /红 0 处/);
  assert.match(ok.stdout, /没有红的/);
  assert.match(ok.stdout, /要人看 14 处/, "看的几处还在，但不拦");
  assert.ok(!ok.stdout.includes(MENTION_ONLY), "没有红的就不说");
  assert.equal(ok.stdout.trimEnd().split("\n").at(-1), "entry-check: done red=0 look=14");
});

test("不再跑 hh status（原来的第 4 条）：输出的节是 1–4 和结论，第 4 条是直接起入口的那些；脚本里（注释以外）没有调 hh status 的地方，也不再提第 5 条", { skip }, () => {
  const r = run(fakeHome("default"));
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const heads = r.stdout.split("\n").filter((l) => l.startsWith("== "));
  assert.deepEqual(heads.map((h) => h.slice(0, 5)), ["== 1.", "== 2.", "== 3.", "== 4.", "== 结论"], heads.join("\n"));
  assert.match(heads[3] ?? "", /^== 4\. 不经那层脚本、直接起 src\/cli\.ts/);
  assert.ok(!r.stdout.includes("没带 HH_CONFIG 时 hh 现在的样子") && !r.stdout.includes("跑 hh status"), r.stdout);
  // 不带 HH_CONFIG 起 hh 会在留痕文件里记一行、hhd 报出来：每次部署（钩子跑这个脚本）都会多一条假的「有入口没带配置」
  const text = readFileSync(SCRIPT, "utf8");
  const code = text.split("\n").filter((l) => !/^\s*#/.test(l));
  assert.deepEqual(code.filter((l) => /"\$\{?HH_BIN\}?" +status|hh status/.test(l)), []);
  assert.doesNotMatch(text, /第 5 条|^# ---- 5[a-d]\./m);
  // 只查得到它看的那几处：开头不许说「这台机器上每一条」
  assert.doesNotMatch(text, /这台机器上每一条/);
});

// ---- 第三轮：T-a … T-f ----

/** 出事那天的两个脚本（名字是编的）：自己拼子进程的环境（从 os.environ 来），没有 HH_CONFIG；envBlock 换掉拼环境那几行 */
const sensorPy = (envLines: string, envArg: string): string =>
  `#!/usr/bin/env python3\nimport os, subprocess\nfrom pathlib import Path\nHH = Path.home() / "hh"\nNODE = "/usr/local/bin/node"\n${envLines}\ndef main():\n    r = subprocess.run([NODE, str(HH / "src/cli.ts"), "status"], env=${envArg}, capture_output=True, text=True)\n    print(r.stdout)\n\nmain()\n`;
const watchPy = (envLines: string): string =>
  `import os, subprocess\nfrom pathlib import Path\nnode = "node"\ncli = os.path.expanduser("~/hh/src/cli.ts")\n${envLines}\nsubprocess.Popen([node, cli, "tell", "x"], env=env)\n`;
/** 两个脚本各由一个 plist 起：/usr/bin/python3 + 脚本的完整路径；plist 里没有 HH_CONFIG（sensor 那个只给了 PATH） */
function incident(f: Fake, sensor: string, watch: string): { sensor: string; watch: string; ps: string; pw: string } {
  const s = join(f.ws, "scripts", "sensor.py");
  const w = join(f.ws, "scripts", "watch.py");
  writeFileSync(s, sensor);
  writeFileSync(w, watch);
  const ps = plist(f, "com.example.sensor", ["/usr/bin/python3", s], ENV_PATH_ONLY);
  const pw = plist(f, "com.example.watch", ["/usr/bin/python3", w]);
  return { sensor: s, watch: w, ps, pw };
}

test("T-a 出事那天的样子：两个 Python 脚本从 os.environ 拼环境、哪儿都没有 HH_CONFIG，各由一个没有 HH_CONFIG 的 plist 起 → 两个都红、退出码 1；红的行下面是入口行和起它的 plist；从管道读脚本（bash -s）也一样", { skip }, () => {
  const f = baseHome();
  const t = incident(f, sensorPy("", "dict(os.environ)"), watchPy("env = os.environ.copy()\nenv[\"PATH\"] = \"/usr/local/bin:\" + env.get(\"PATH\", \"\")"));
  const file = run(f);
  const piped = doneLine(spawnSync(BASH, ["-s", "--", "--home", f.home, "--launchd-dirs", f.launchd], { ...BOUND, env: ENV, input: readFileSync(SCRIPT) }));
  const hook = hookMode(f);
  // grep 认 GREP_OPTIONS（当成默认选项塞在最前面）：-x 会让搜索「什么都没找到」又不报错。脚本自己把它清掉
  const grepOpts = doneLine(spawnSync(BASH, [SCRIPT, "--home", f.home, "--launchd-dirs", f.launchd], { ...BOUND, env: { ...ENV, GREP_OPTIONS: "-x" } }));
  assert.deepEqual([hook.status, hook.stdout], [file.status, file.stdout], "钩子的跑法（bash -c 文本）和当文件跑的一模一样");
  for (const r of [file, piped, hook, grepOpts]) {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(block(r.stdout, "红", t.sensor), `红  ${t.sensor}：它和起它的 ${t.ps} 里都没有 HH_CONFIG 这几个字\n${entry(8, `    r = subprocess.run([NODE, str(HH / "src/cli.ts"), "status"], env=dict(os.environ), capture_output=True, text=True)`)}\n    起它的：${t.ps}`);
    assert.equal(block(r.stdout, "红", t.watch), `红  ${t.watch}：它和起它的 ${t.pw} 里都没有 HH_CONFIG 这几个字\n${entry(4, `cli = os.path.expanduser("~/hh/src/cli.ts")`)}\n    起它的：${t.pw}`);
    assert.match(r.stdout, /入口：3 处；红 2 处，要人看 0 处。/);
    assert.match(r.stdout, /不能部署/);
    assert.equal(r.stderr, "");
  }
});

test("T-b 那两个脚本后来的四种改法：每一种都绿（不是红），plist 不变，退出码 0", { skip }, () => {
  const fixes: [string, string, string][] = [
    ["env[...] = ...", `env = dict(os.environ)\nenv["HH_CONFIG"] = os.environ.get("HH_CONFIG") or os.path.expanduser("~/.hh/config.json")`, `env["HH_CONFIG"] = os.environ.get("HH_CONFIG") or os.path.expanduser("~/.hh/config.json")`],
    ["字典里单独一行", `HOME = Path.home()\nenv = {**os.environ,\n       "HH_CONFIG": os.environ.get("HH_CONFIG") or str(HOME / ".hh/config.json")}`, `       "HH_CONFIG": os.environ.get("HH_CONFIG") or str(HOME / ".hh/config.json")}`],
    ["dict(…, HH_CONFIG=…)", `home = Path.home()\nenv = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(home / '.hh/config.json'))`, `env = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(home / '.hh/config.json'))`],
    ["同上，文件里还有模块常量 HH_CONFIG = …", `HH_CONFIG = Path.home() / '.hh/config.json'\nhome = Path.home()\nenv = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(home / '.hh/config.json'))`, `env = dict(os.environ, HH_CONFIG=os.environ.get('HH_CONFIG') or str(home / '.hh/config.json'))`],
  ];
  for (const [label, lines, evidence] of fixes) {
    const f = baseHome();
    const t = incident(f, sensorPy(lines, "env"), watchPy(lines));
    const r = run(f);
    assert.equal(r.status, 0, `${label}\n${r.stdout}${r.stderr}`);
    const hook = hookMode(f);
    assert.deepEqual([hook.status, hook.stdout], [r.status, r.stdout], `${label}：钩子的跑法和当文件跑的一样`);
    for (const file of [t.sensor, t.watch]) {
      const b = block(r.stdout, "绿", file);
      assert.ok(b, `${label}：${file} 应该绿\n${r.stdout}`);
      assert.match(b, /：自己往环境里放了 HH_CONFIG\n/, label);
      assert.ok(b.split("\n").some((l) => /^    \d+:/.test(l) && l.includes(evidence.trim().slice(0, 40))), `${label}：证据行是改的那一行\n${b}`);
    }
    assert.match(r.stdout, /红 0 处/, label);
  }
});

test("T-c 提到了 HH_CONFIG 但不是认得的写法 → 看（不红、不拦），行下面印着提到它的行和起它的；谁都没起的 → 看，写明没有 launchd 任务点它的名", { skip }, () => {
  const f = baseHome();
  const S = (name: string, text: string): string => { const p = join(f.ws, "scripts", name); writeFileSync(p, text); return p; };
  const comment = S("c_comment.py", `import subprocess\n# HH_CONFIG comes from the wrapper\nsubprocess.run(["node", "code/src/cli.ts", "a"])\n`);
  const envList = S("c_envlist.py", `import subprocess\nnode, cli = "node", "code/src/cli.ts"\nsubprocess.run(["env", "HH_CONFIG=/x", node, cli])\n`);
  const plainByCommentedPlist = S("c_plistnote.py", `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "b"])\n`);
  const orphan = S("c_orphan.py", `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "c"])\n`);
  const p1 = plist(f, "com.example.comment", ["/usr/bin/python3", comment]);
  const p2 = plist(f, "com.example.envlist", ["/usr/bin/python3", envList]);
  const p3 = plist(f, "com.example.note", ["/usr/bin/python3", plainByCommentedPlist], "<!-- HH_CONFIG is set by the wrapper -->\n");
  // plist 自己直接起入口、提到了 HH_CONFIG 但不是 <key> / <string>HH_CONFIG= 的写法
  const p4 = plist(f, "com.example.direct", ["/bin/sh", "-c", `export HH_CONFIG=/x; exec node ${f.code}/src/hhd.ts`]);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(block(r.stdout, "看", comment), `看  ${comment}：提到了 HH_CONFIG，但不是认得的写法（起它的 ${p1} 里也没有认得的写法）\n    3:subprocess.run(["node", "code/src/cli.ts", "a"])\n    提到 HH_CONFIG（它自己）：2:# HH_CONFIG comes from the wrapper\n    起它的：${p1}`);
  assert.equal(block(r.stdout, "看", envList), `看  ${envList}：提到了 HH_CONFIG，但不是认得的写法（起它的 ${p2} 里也没有认得的写法）\n    2:node, cli = "node", "code/src/cli.ts"\n    提到 HH_CONFIG（它自己）：3:subprocess.run(["env", "HH_CONFIG=/x", node, cli])\n    起它的：${p2}`);
  assert.equal(block(r.stdout, "看", plainByCommentedPlist), `看  ${plainByCommentedPlist}：提到了 HH_CONFIG，但不是认得的写法（起它的 ${p3} 里也没有认得的写法）\n    2:subprocess.run(["node", "code/src/cli.ts", "b"])\n    提到 HH_CONFIG（起它的 plist）：5:<!-- HH_CONFIG is set by the wrapper -->\n    起它的：${p3}`);
  assert.equal(block(r.stdout, "看", orphan), `看  ${orphan}：自己没有认得的 HH_CONFIG 写法，也没有 launchd 任务点它的名\n    2:subprocess.run(["node", "code/src/cli.ts", "c"])\n${NOBODY}`);
  const b4 = block(r.stdout, "看", p4);
  assert.ok(b4, r.stdout);
  assert.match(b4, /^看  .*：这个 plist 直接起入口，提到了 HH_CONFIG，但不是认得的写法\n    6:<array>/);
  assert.match(b4, /\n    提到 HH_CONFIG（这个 plist）：6:<array><string>\/bin\/sh<\/string><string>-c<\/string><string>export HH_CONFIG=\/x; exec node /);
  assert.match(b4, /\n    起它的：launchd（照这个 plist 起）$/);
  assert.match(r.stdout, /红 0 处，要人看 5 处。/);
  assert.match(r.stdout, /没有红的/);
});

test("T-d 没有扩展名的脚本按第一行认：python 的 #! 里 env[\"HH_CONFIG\"] = … 是绿；node 的 #! 里 process.env.HH_CONFIG ??= … 是绿；python 的模块常量 HH_CONFIG=\"/x\" 不当 shell 读（不绿）", { skip }, () => {
  const f = baseHome();
  const B = (name: string, text: string): string => { const p = join(f.home, ".local", "bin", name); writeFileSync(p, text); chmodSync(p, 0o755); plist(f, `com.example.${name}`, [p]); return p; };
  const py = B("sensor-run", `#!/usr/bin/env python3\nimport os, subprocess\nenv = dict(os.environ)\nenv["HH_CONFIG"] = os.environ.get("HH_CONFIG") or "/x/config.json"\nsubprocess.run(["node", "/code/src/cli.ts", "status"], env=env)\n`);
  const js = B("watch-run", `#!/usr/bin/env node\nprocess.env.HH_CONFIG ??= "/x/config.json";\nrequire("node:child_process").spawnSync("node", ["/code/src/cli.ts", "status"], { stdio: "inherit" });\n`);
  const cst = B("const-run", `#!/usr/bin/python3\nHH_CONFIG="/x/config.json"\nimport subprocess\nsubprocess.run(["node", "/code/src/cli.ts", "status"])\n`);
  const r = run(f);
  assert.match(r.stdout, row("绿", py, `：自己往环境里放了 HH_CONFIG\\n    4:env\\["HH_CONFIG"\\] = `));
  assert.match(r.stdout, row("绿", js, `：自己往环境里放了 HH_CONFIG\\n    2:process\\.env\\.HH_CONFIG \\?\\?= `));
  assert.match(r.stdout, row("看", cst, "：提到了 HH_CONFIG，但不是认得的写法"), "Python 的常量不是往环境里放；提到了，所以是看不是红");
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test("T-f 行尾注释从第一个「空白 + 注释符」切，注释符按种类：Python / shell 是 #，JS 是 //；echo \"step #1\"; HH_CONFIG=… 是看（不红）", { skip }, () => {
  const f = baseHome();
  const S = (name: string, text: string): string => { const p = join(f.ws, "scripts", name); writeFileSync(p, `${text}\n${name.endsWith(".js") ? `require("node:child_process").spawnSync("node", ["code/src/cli.ts"])` : name.endsWith(".sh") ? "" : `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "x"])`}\n`); return p; };
  const cut1 = S("f_cut1.py", `x = 1  # env["HH_CONFIG"] = "/x"`);
  const cut2 = S("f_cut2.py", `x = 1  # env["HH_CONFIG"] = "/x"  # old`);
  const note = S("f_note.py", `p = "/x"\nenv = {}\nenv["HH_CONFIG"] = p  # note`);
  const div = S("f_div.py", `total, p = 4, "/x"\nenv = {}\nn = total // 2; env["HH_CONFIG"] = p`);
  const url = S("f_url.js", `const u = "http://x"; process.env.HH_CONFIG = u // note`);
  const jsc = S("f_jscomment.js", `const x = () => 1; x(); // process.env.HH_CONFIG = "/x"`);
  const step = S("f_step.sh", `echo "step #1"; HH_CONFIG=/x node code/src/cli.ts`);
  const ps = plist(f, "com.example.step", ["/bin/sh", step]);
  const r = run(f);
  const out = r.stdout;
  assert.match(out, row("看", cut1, "："), "注释里的赋值不算");
  assert.match(out, row("看", cut2, "："), "从第一个 # 切：后面还有一个 # 也不能让注释里的赋值算数");
  assert.match(out, row("绿", note, "：自己往环境里放了 HH_CONFIG\\n    3:env\\[\"HH_CONFIG\"\\] = p"), "赋值后面跟着注释：绿");
  assert.match(out, row("绿", div, "：自己往环境里放了 HH_CONFIG\\n    3:n = total // 2; env"), "Python 的 // 是整除，不是注释");
  assert.match(out, row("绿", url, "：自己往环境里放了 HH_CONFIG\\n    1:const u = \"http://x\"; process\\.env"), "JS 里 :// 前面不是空白，不切");
  assert.match(out, row("看", jsc, "："), "JS 的 // 后面是注释");
  assert.equal(block(out, "看", step), `看  ${step}：提到了 HH_CONFIG，但不是认得的写法（起它的 ${ps} 里也没有认得的写法）\n    1:echo "step #1"; HH_CONFIG=/x node code/src/cli.ts\n    提到 HH_CONFIG（它自己）：1:echo "step #1"; HH_CONFIG=/x node code/src/cli.ts\n    起它的：${ps}`, "定下来的：看，不是绿（从第一个空白 + # 切掉了），也绝不是红");
  assert.equal(r.status, 0, out + r.stderr);
});

test("起它的 plist：文件名右边是 ; ' ) | & 也算点了它的名（sh -c 里的写法）；两边都没有这几个字所以都红", { skip }, () => {
  const f = baseHome();
  const names = ["semi.py", "quoted.py", "paren.py", "pipe.py", "amp.py"];
  for (const n of names) writeFileSync(join(f.ws, "scripts", n), `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "x"])\n`);
  const s = join(f.ws, "scripts");
  const p = plist(f, "com.example.shell", ["/bin/sh", "-c", `cd ${s}; python3 semi.py; echo done`, `sh -c 'python3 ${s}/quoted.py'`, "(python3 paren.py)", "python3 pipe.py|cat", "python3 amp.py&amp;"]);
  const r = run(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  for (const n of names) assert.match(r.stdout, row("红", `${s}/${n}`, `：它和起它的 ${esc(p)} 里都没有 HH_CONFIG 这几个字\\n`), n);
});

test("F5 工作区取实例配置顶层的 workspace：嵌套的那个在文本里排在前面也不用它（有 /usr/bin/plutil 时；没有就是退回去取第一个，断言那个答案）", { skip }, () => {
  const f = baseHome("none");
  writeFileSync(join(f.home, ".hh", "config.json"), `{\n  "other": { "workspace": "/nonexistent-nested" },\n  "workspace": "${f.ws}"\n}\n`);
  const r = run(f);
  if (existsSync("/usr/bin/plutil")) {
    assert.match(r.stdout, new RegExp(`^工作区：${esc(f.ws)}$`, "m"), r.stdout + r.stderr);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  } else {
    // 没有 plutil：文本里的第一个 "workspace" 是嵌套的那个，不存在 → 退出码 2，找过的地方里写着它
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /workspace：\/nonexistent-nested/);
  }
});

test("工作区从哪来：实例配置里的 workspace（上线以后的路）能用；找不到就拦下、退出码 2；--no-workspace 明说不查这一处才放行", { skip }, () => {
  const a = fakeHome("instance");
  const ra = run(a);
  assert.equal(ra.status, 1, ra.stdout + ra.stderr);
  assert.match(ra.stdout, new RegExp(`^工作区：${esc(a.ws)}$`, "m"));
  assert.match(ra.stdout, /^红  .*red_job\.py/m, "实例配置里的工作区真的被查了");
  const b = fakeHome("default");
  assert.match(run(b).stdout, new RegExp(`工作区路径取自 ${esc(b.code)}/config/default\\.json`));
  const c = fakeHome("none");
  const rc = run(c);
  assert.equal(rc.status, 2, rc.stdout + rc.stderr);
  assert.match(rc.stdout, /没找到工作区，没法判断/);
  assert.equal(rc.stdout.split("\n").filter((l) => l.startsWith("没找到工作区")).length, 1, "只说一遍");
  assert.match(rc.stdout, /找过的地方/);
  assert.doesNotMatch(rc.stdout, /^结论|== 结论/m);
  const d = run(c, "--no-workspace");
  assert.match(d.stdout, /--no-workspace：没找到工作区/);
  assert.match(d.stdout, /== 结论/);
  assert.doesNotMatch(d.stdout, /red_job\.py/, "没查工作区，就不会出现它里面的东西");
});

test("不认识的参数退出码 2；只给 --home 时不碰系统的 LaunchDaemons（plist 只看假家里的）", { skip }, () => {
  const r = spawnSync(BASH, [SCRIPT, "--nope"], BOUND);
  assert.equal(r.status, 2);
  assert.equal(r.stderr, "", "参数不对也只写一条流");
  assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("用法：")).length, 1, r.stdout);
  const f = fakeHome("default");
  const o = spawnSync(BASH, [SCRIPT, "--home", f.home], { ...BOUND, env: { PATH: "/usr/bin:/bin" } });
  assert.doesNotMatch(o.stdout, /\/Library\/Launch(Daemons|Agents)/);
  assert.match(o.stdout, new RegExp(`改用 ${esc(f.home)}/\\.local/bin/hh`), "--home 被无视的话这一行不会出现");
});

/** 换掉 grep 的小脚本（只有给了 --home 才认 HH_CHECK_GREP）。body 在把参数交给真的 grep 之前跑 */
function stubGrep(name: string, body: string, mode = 0o755): string {
  const p = join(tmpDir("hh-entries-stub-"), name);
  writeFileSync(p, `#!/bin/sh\n${body}\nexec /usr/bin/grep "$@"\n`);
  chmodSync(p, mode);
  return p;
}
// 参数里有没有某个选项字母（只看 - 开头的参数；脚本里的模式和路径都不以 - 开头）
const hasOpt = (letter: string): string => `has_${letter}=0; for a in "$@"; do case "$a" in --*) ;; -*${letter}*) has_${letter}=1 ;; esac; done`;

test("T-e 工具不能用 → 退出码 3：给的 grep 不能执行（只有测试用的覆盖能做到）", { skip }, () => {
  const f = baseHome();
  const notExec = stubGrep("not-exec-grep", "", 0o644);
  const r = withGrep(f, notExec);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`检查自己没跑成：${esc(notExec)} 不能用`));
  assert.equal((r.stdout + r.stderr).split("\n").filter((l) => l.includes(" 不能用")).length, 1, "没判成的话只说一遍（钩子把两条流接在一起看）");
});

test("T-e 数不出数 → 退出码 3：grep 一个字也不出；-c 什么都不印；只有数「红」的那一次坏了（每个数单独验）；数「红」的说 0 但循环里见过红；每个数都说 0", { skip }, () => {
  // 出事的两个红 + 一个由三个带了的 plist 起的脚本（三行绿）：行比入口多两行，所以「数红的说 0」时总数那一关还过得去，只有「见过红」那一关拦得住
  const f = baseHome();
  incident(f, sensorPy("", "dict(os.environ)"), watchPy("env = os.environ.copy()"));
  const multi = join(f.ws, "scripts", "multi.py");
  writeFileSync(multi, `import subprocess\nsubprocess.run(["node", "code/src/hhd.ts"])\n`);
  for (const n of ["a", "b", "c"]) plist(f, `com.example.multi-${n}`, [multi], "<key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>/x</string></dict>\n");
  // 没有红的家：每个数都说 0 时，只有「行数不少于入口数」那一关拦得住
  const calm = baseHome();
  const red = `red=0; for a in "$@"; do case "$a" in *红*) red=1 ;; esac; done`;
  const cases: [string, Fake][] = [
    [stubGrep("silent-grep", "exit 0"), f],
    [stubGrep("nocount-grep", `${hasOpt("c")}\n[ $has_c = 1 ] && exit 2`), f],
    [stubGrep("redcount-grep", `${hasOpt("c")}\n${red}\n[ $has_c = 1 ] && [ $red = 1 ] && exit 2`), f],
    [stubGrep("redzero-grep", `${hasOpt("c")}\n${red}\nif [ $has_c = 1 ] && [ $red = 1 ]; then echo 0; exit 1; fi`), f],
    [stubGrep("allzero-grep", `${hasOpt("c")}\nif [ $has_c = 1 ]; then echo 0; exit 1; fi`), calm],
  ];
  for (const [stub, home] of cases) {
    const r = withGrep(home, stub);
    assert.equal(r.status, 3, `${stub}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout + r.stderr, /检查自己没跑成/, stub);
    assert.doesNotMatch(r.stdout, /没有红的/, stub);
  }
  // 对照：真的 grep 在这两个家里能数清楚（上面拦下来的确实是换掉的 grep，不是夹具本身有毛病）
  const real = run(f);
  assert.equal(real.status, 1, real.stdout + real.stderr);
  assert.match(real.stdout, /入口：6 处；红 2 处，要人看 0 处。/);
  assert.equal(run(calm).status, 0);
});

test("T-e 搜索没跑完 → 退出码 3：列文件的那一步（grep -l）自己失败、一句话也没说——结尾的标记没出来", { skip }, () => {
  const f = baseHome();
  incident(f, sensorPy("", "dict(os.environ)"), watchPy("env = os.environ.copy()"));
  const listFail = stubGrep("listfail-grep", `${hasOpt("l")}\n[ $has_l = 1 ] && exit 2`);
  const r = withGrep(f, listFail);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /搜索没跑完/);
});

test("T-e 某个入口没判出来 → 退出码 3、点它的名，不会因为看不了就判成红（查「提到没提到 HH_CONFIG」的那次 grep 出错）", { skip }, () => {
  const f = baseHome();
  incident(f, sensorPy("", "dict(os.environ)"), watchPy("env = os.environ.copy()"));
  const mentionFail = stubGrep("mentionfail-grep", `${hasOpt("q")}\nh=0; for a in "$@"; do [ "$a" = HH_CONFIG ] && h=1; done\n[ $has_q = 1 ] && [ $h = 1 ] && exit 2`);
  const r = withGrep(f, mentionFail);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, new RegExp(`检查自己没跑成：${esc(f.home)}/\\S+ 没判出来`));
  assert.doesNotMatch(r.stdout, /^红  /m);
});

test("T-e 有一个 launchd 目录在、却列不出来 → 退出码 3（里面可能就有起入口的 plist）", { skip: skip || asRoot }, () => {
  const f = baseHome();
  const locked = join(f.home, "LockedAgents");
  mkdirSync(locked);
  writeFileSync(join(locked, "x.plist"), "<plist/>\n");
  chmodSync(locked, 0o000);
  try {
    const r = spawnSync(BASH, [SCRIPT, "--home", f.home, "--launchd-dirs", `${f.launchd}:${locked}`], { ...BOUND, env: ENV });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, new RegExp(`${esc(locked)} 读不了`));
  } finally { chmodSync(locked, 0o755); }
});

test("T-e 一个 plist 读不了：列成「看」，不拦；退出码看别的（这里别的都绿，所以 0）", { skip: skip || asRoot }, () => {
  const f = baseHome();
  const p = plist(f, "com.example.locked", ["/usr/bin/python3", "/x/sensor.py"]);
  chmodSync(p, 0o000);
  try {
    const r = run(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`^看  ${esc(p)}：读不了，没法看它起什么$`, "m"));
    assert.match(r.stdout, /红 0 处，要人看 1 处。/);
  } finally { chmodSync(p, 0o644); }
});

test("S2：有一个目录读不了：搜索没跑全，退出码 3，把 find 的话打出来（不当成「没有」）", { skip: skip || asRoot }, () => {
  const f = fakeHome("default");
  const locked = join(f.ws, "scripts", "locked");
  mkdirSync(locked);
  chmodSync(locked, 0o000);
  try {
    const r = run(f);
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /搜索没跑全：/);
    assert.match(r.stdout + r.stderr, /locked/);
  } finally { chmodSync(locked, 0o755); rmSync(locked, { recursive: true, force: true }); }
});

test("S5：实例配置不存在时不往 stderr 报 shell 的错", { skip }, () => {
  const f = fakeHome("none");
  rmSync(join(f.home, ".hh", "config.json"));
  const r = run(f, "--no-workspace");
  // 只有一条流（stderr 是空的由 run 核）：shell 的错会按顺序混在输出里，所以在输出里找
  assert.doesNotMatch(r.stdout, /: line \d+: |No such file or directory/, r.stdout);
});

test("只有一条流：途中有个命令往 stderr 写了一句（实例配置读不了，bash 自己报 Permission denied），它按顺序进输出，跑完的标记照样是最后一行、退出码 0", { skip: skip || asRoot }, () => {
  const f = baseHome("default");
  const cfg = join(f.home, ".hh", "config.json");
  chmodSync(cfg, 0o000);
  try {
    for (const r of [run(f), hookMode(f)]) {
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Permission denied/, "那句警告真的出现了（不然这个测试什么都没测）");
      assert.equal((r.stdout + r.stderr).trimEnd().split("\n").at(-1), "entry-check: done red=0 look=0", "钩子把 stdout 和 stderr 接在一起看：最后一行还得是标记");
    }
  } finally { chmodSync(cfg, 0o644); }
});

// ---- 整段审阅后的最后一轮 ----

test("shell 写法：只有真放进子进程环境的才绿——export / declare -x / typeset -x、和命令写在同一行的前缀、env；光赋值、: \"${HH_CONFIG:=…}\"、分号后面才起命令的都不绿", { skip }, () => {
  const f = baseHome();
  // [该不该绿, 那一行]：每行单独一个 .sh，下一行起入口；没有 plist 起它们，所以带了是绿、没带是看
  const lines: Array<[boolean, string]> = [
    [true, "HH_CONFIG=/x node code/src/cli.ts"],
    [true, "A=1 HH_CONFIG=/x node code/src/cli.ts"],
    [true, "export HH_CONFIG=/x"],
    [true, "export HH_CONFIG"],
    [true, "declare -x HH_CONFIG=/x"],
    [true, "typeset -x HH_CONFIG=/x"],
    [true, "export A=1 HH_CONFIG=/x"],
    [true, "exec env HH_CONFIG=/x node code/src/cli.ts"],
    [true, "exec env -i HH_CONFIG=/x node code/src/cli.ts"],
    [true, "sudo -u x env HH_CONFIG=/x node code/src/cli.ts"],
    [true, "cd /x && HH_CONFIG=/x node code/src/cli.ts"],
    [true, "if true; then HH_CONFIG=/x node code/src/cli.ts; fi"],
    [true, "HH_CONFIG=/x \\"],
    [false, 'HH_CONFIG="$HOME/.hh/config.json"'],
    [false, "HH_CONFIG=/x; node code/src/cli.ts"],
    [false, '[ -n "$HH_CONFIG" ] || HH_CONFIG=/x'],
    [false, "dev) HH_CONFIG=/x ;;"],
    [false, ': "${HH_CONFIG:=/x}"'],
    [false, "echo run HH_CONFIG=/x"],
    [false, "OLD_HH_CONFIG=1"],
    [false, "export HH_CONFIG_OLD=1"],
    [false, 'echo "step #1"; HH_CONFIG=/x node code/src/cli.ts'],
    [false, "env -u HH_CONFIG node code/src/cli.ts"],
  ];
  const files = lines.map(([green, line], i) => {
    const p = join(f.ws, "scripts", `sh${String(i).padStart(2, "0")}.sh`);
    writeFileSync(p, `${line}\nnode code/src/cli.ts x\n`);
    return { p, green, line };
  });
  // 两步：先赋值、另一行再 export —— 绿，凭据是真导出的那一行
  const two = join(f.ws, "scripts", "two_step.sh");
  writeFileSync(two, `HH_CONFIG="$HOME/.hh/config.json"\nexport HH_CONFIG\nnode code/src/cli.ts x\n`);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const misses = files.filter(({ p, green }) => !row(green ? "绿" : "看", p, "：").test(r.stdout)).map(({ green, line }) => `${green ? "该绿" : "不该绿"}：${line}`);
  assert.deepEqual(misses, []);
  assert.match(r.stdout, row("绿", two, "：自己往环境里放了 HH_CONFIG\\n    2:export HH_CONFIG\\n"));
});

test("没走 finish 就退出（从管道读、少了最后那行 finish 0）→ 退出码 3、「脚本中途意外退出」、没有跑完的标记", { skip }, () => {
  const f = baseHome();
  const lines = readFileSync(SCRIPT, "utf8").trimEnd().split("\n");
  assert.equal(lines.at(-1), "finish 0", "脚本的最后一行变了：这个测试要跟着改");
  const r = doneLine(spawnSync(BASH, ["-s", "--", "--home", f.home, "--launchd-dirs", f.launchd], { ...BOUND, env: ENV, input: lines.slice(0, -1).join("\n") + "\n" }));
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /没有红的/, "判完了，只是没走 finish：照样不算 0");
  assert.match(r.stdout, /^检查自己没跑成：脚本中途意外退出$/m);
  assert.equal((r.stdout + r.stderr).split("\n").filter((l) => l === "检查自己没跑成：脚本中途意外退出").length, 1, "陷阱只说一遍");
});

test("一个脚本由两个 plist 起：一个带了、一个两边都没有 → 一行绿、一行红，退出码 1（碰到带了的那个不能就停）", { skip }, () => {
  const f = baseHome();
  const s = join(f.ws, "scripts", "twice.py");
  writeFileSync(s, `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "x"])\n`);
  const a = plist(f, "com.example.a-carries", ["/usr/bin/python3", s], "<key>EnvironmentVariables</key><dict><key>HH_CONFIG</key><string>/x</string></dict>\n");
  const b = plist(f, "com.example.b-bare", ["/usr/bin/python3", s]);
  const r = run(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, row("绿", s, `：自己没带，起它的 ${esc(a)} 带了`));
  assert.match(r.stdout, row("红", s, `：它和起它的 ${esc(b)} 里都没有 HH_CONFIG 这几个字`));
  assert.match(r.stdout, /红 1 处/);
});

test("备份、编译产物只在没有 plist 点它的名时才不算：plist 起的 job.bak、launchd 目录里叫 *.bak-*.plist 的照样判；没人起的照旧不列", { skip }, () => {
  const f = baseHome();
  const call = `import subprocess\nsubprocess.run(["node", "code/src/cli.ts", "x"])\n`;
  const S = (name: string): string => { const p = join(f.ws, "scripts", name); writeFileSync(p, call); return p; };
  const named = S("job.bak");
  plist(f, "com.example.bak", ["/usr/bin/python3", named]);
  mkdirSync(join(f.ws, "scripts", "__pycache__"));
  const quiet = [S("job2.py.bak-1114"), S("x.bak"), S("c.pyc"), S(join("__pycache__", "m.py"))];
  const direct = join(f.launchd, "com.example.direct.bak-1114.plist");
  writeFileSync(direct, `<plist><dict><key>ProgramArguments</key><array><string>node</string><string>${f.code}/src/hhd.ts</string></array></dict></plist>\n`);
  const r = run(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, row("红", named, "：它和起它的 "), "plist 起它：launchd 照样跑，名字像备份也要判");
  assert.match(r.stdout, row("红", direct, "：这个 plist 直接起入口"), "launchd 目录里的 plist 名字像备份也照样载入");
  for (const q of quiet) assert.ok(!r.stdout.includes(q), `没人起的 ${q} 不列`);
  assert.match(r.stdout, /红 2 处/);
});

test("家目录不归跑检查的用户（--home 指到别人的目录）→ 退出码 3，不拿别人的家判", { skip: skip || asRoot }, () => {
  const f = baseHome();
  const r = doneLine(spawnSync(BASH, [SCRIPT, "--home", "/", "--launchd-dirs", f.launchd], { ...BOUND, env: ENV }));
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stdout, /检查自己没跑成：家目录不归跑检查的这个用户/);
});

test("实例配置里的 workspace 以 ~ 开头：换成家目录", { skip }, () => {
  const f = baseHome("none");
  writeFileSync(join(f.home, ".hh", "config.json"), `{ "workspace": "~/ws" }\n`);
  const r = run(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`^工作区：${esc(f.ws)}$`, "m"));
});
