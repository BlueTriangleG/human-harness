#!/bin/bash
# 只读检查：下面这几处里找得到的、直接用 node 起 src/cli.ts / src/hhd.ts / src/console/main.ts 的入口，有没有往环境里放 HH_CONFIG。
# 它只看：工作区的 scripts/ 和 tools/（一层层往下，跟着链接走）、~/.local/bin 这一层、launchd 目录里读得了的 plist
#   （不给 --launchd-dirs 时是 ~/Library/LaunchAgents、/Library/LaunchDaemons、/Library/LaunchAgents）。
# 所以它看不见：从别处起的入口（别的目录里的脚本起它：一行都没有）；路径是拼出来、字面上没写 src/cli.ts 这几个字的；
#   一条链 plist → 包一层的脚本（里面没写入口路径）→ 脚本 → 入口：中间那层看不见，那个脚本因为没有 plist 点它的名，列成「看」、不是红；
#   crontab 起的（只数一数）、别的目录里载入的任务、别的用户的任务、二进制格式的 plist（名字后面紧跟的是编码字节，认不出是它起的）。
# 没带 HH_CONFIG 的入口在启动检查处（requireInstance）退出码 1；起它的任务要是把退出码吞了，就是静悄悄地断。部署前跑它当门槛：
#   以角色的系统用户跑（只读：不写任何文件——脚本里没有 here-document 和 here-string，bash 3.2 会为它们写临时文件；不打印环境变量里别的内容）：
#     bash check-instance-entries.sh        或者从管道读：  … | bash -s -- [参数]
#   规矩（第三轮，只有确定的时候才拦）：
#     绿  入口自己有认得的赋值；或者自己没有、起它的 plist 有                                        不拦
#     红  起它的 plist 和它自己里面「HH_CONFIG」这几个字哪儿都没有（plist 直接起入口的：它自己里没有）  拦，退出码 1
#     看  提到了 HH_CONFIG 但不是认得的写法；或者没有 launchd 任务点它的名；或者一个 plist 读不了       不拦，行下面印着凭据和谁起它
#     跳  工作区 scripts / tools 里的测试文件（没有 plist 点它的名）                                     不拦
#   退出码：0 没有红的（只在判完以后的最后一行）；1 至少一处红（不能部署）；0 和 1 的输出最后一行都是
#           「entry-check: done red=<红的行数> look=<看的行数>」（部署的钩子只认最后一行是它的 0 和 1；2、3 和意外退出都不印它）。
#           输出只有一条流：参数读完就把 stderr 并进 stdout，所有的话（连同工具的警告）按顺序写在 stdout，stderr 是空的；
#           2 参数不对，或找不到工作区没法判断（--no-workspace 可以明说不查那一处）；
#           3 检查自己没跑成：工具不能用、launchd 目录列不出来、搜索没跑完 / 没跑全、某个入口没判出来、数不出数、脚本中途意外退出——没判就不说「没有红的」
#   --home <目录>            用这个目录代替 ${HOME}（测试用）。给了它：第 2 条（正在跑的进程）和第 3 条里 crontab 那一行跳过，
#                            hh 只认 <目录>/.local/bin/hh，实例配置只认 <目录>/.hh/config.json；不给 --launchd-dirs 时只看 <目录>/Library/LaunchAgents；
#                            也只有给了 --home 才认环境变量 HH_CHECK_GREP（换掉 grep，测试用：坏掉的 grep 不能让检查悄悄通过）
#   --launchd-dirs <目录>:<目录>   在这些目录里找 plist，代替系统的 LaunchAgents / LaunchDaemons（测试用）
#   --no-workspace           找不到工作区也不拦（输出里会写明这一处没查），继续查别的地方
# 判断用的工具一律写绝对路径（角色的 PATH 里可能有别的 grep / sed 排在前面），开头逐个核对能不能用。
# 不起 hh：不带 HH_CONFIG 起它会在留痕文件里记一行、hhd 当成「有入口没带配置」报出来——部署每次都跑这个检查，不能让检查自己造出它要找的毛病。
# 不列的文件（都只在没有 plist 点它的名时；有 plist 点它的名，launchd 照样起它，照常判）：备份（文件名以 .bak 结尾或带 .bak- 的后缀）、
# 编译产物（__pycache__ 里的、.pyc）；工作区 scripts / tools 里的测试文件（文件名 test_*.py、*_test.py、*.test.ts、*.test.js、*.test.py）。
# 测试文件不是入口，只在第 4 条里按名字列一遍（跳）；备份和编译产物不列。
# 已知的局限（每个 绿 / 看 的行下面都印着凭据，人能看出来）：
#   认得的赋值只看一行之内；行尾注释从第一个「空白 + 注释符」切（所以 echo "step #1"; HH_CONFIG=… 是看）。
#   只在注释里提到 HH_CONFIG 的入口是看、不是红——真漏带的话运行时由留痕那一层（/tmp/hh-misconfig-<uid>.jsonl）点名。
#   多出来的绿（判成带了、其实子进程拿不到）：字符串里恰好写着「; HH_CONFIG=」、Python 函数参数的默认值 HH_CONFIG=None、
#     任何 Python 字典或 docstring 里的 "HH_CONFIG":、JS 解构读出来的 { HH_CONFIG: x } = process.env、TS 类型里的成员、/* */ 块注释里的写法、
#     plist 里当普通参数的 <string>HH_CONFIG=…</string>、<key>HH_CONFIG</key> 配一个空的值、plist 里跨多行的 XML 注释；
#     「起它的 plist 带了」而脚本给子进程另拼了一份不带它的 env。
#   多出来的红（她自己过不了红：出路是在那个文件里写一行带 HH_CONFIG 的注释，它就成了看——结论里有这句）：plist 写的是另一个同名的文件
#     （/opt/x/sensor.py 也算点了 sensor.py 的名）、plist 的 XML 注释里提到这个名字；scripts / tools 下任何含入口路径的普通文件都当入口
#     （JSON、Markdown、日志、.git、node_modules 里的）；别的项目的 src/cli.ts 也算入口；plist 用读 rc 文件的 shell 起它、变量从 rc 里来。
#   工具「正常退出、却什么都没印」查不出来（/usr/bin 下的不会这样）；find … -exec grep … {} + 里的 grep 不说话地退 2、或者被杀，
#     find 也只是退 1、不说话，和「没找到」分不开（/usr/bin/grep 只有被杀才会这样）。数数那一步有两边对照。
#   结论里的「N 处」数的是行：一个起它的 plist 一行、一个读不了的 plist 一行，不是文件数。
# 环境：grep 认的 GREP_OPTIONS 一开头就清掉；家目录只认归跑检查的这个用户的（sudo -u 没带 -H 时 HOME 还是别人的）。
# 写法上的规矩：变量后面紧跟中文或全角符号时一律写 ${名字}——macOS 的 bash 3.2 会把那个字的第一个字节算进变量名（配上 set -u 就直接退出）。
set -u

# ---- 退出：每一个故意的退出都走 finish ----
# 没走 finish 就退出的（set -u 撞上没设的变量、bash 自己出错、有人删了最后那行 finish 0）由 EXIT 陷阱改成 3：意外退出不会被当成 0 或 1。
# 陷阱只在这个 shell 里：$( ) 和 ( ) 里的子 shell 不继承它，它们的退出由调用的地方看
DONE_RC=""
# 判完了（0 或 1）才印跑完的标记，而且是最后一行：部署的钩子只认最后一行是它的 0 和 1——空的脚本、什么都没执行的 shell、
# 跑到一半被截断的输出都是 0 或者 1 却没有它。印在 finish 里面：少了最后那行 finish 0，标记也跟着没了。
# 先印、后记 DONE_RC：BAD / LOOK 还没数出来就被叫到（set -u 撞上），陷阱照样改成 3
finish() {
  case "$1" in 0|1) echo "entry-check: done red=${BAD} look=${LOOK}" ;; esac
  DONE_RC="$1"; exit "$1"
}
trap 'if [ -z "${DONE_RC}" ]; then echo "检查自己没跑成：脚本中途意外退出"; exit 3; fi' EXIT
# 没判成：说一遍（参数读完以后 stderr 已经并进 stdout，只有一条流），退出码 3
fail3() { printf '%s\n' "$@"; finish 3; }

GREP=/usr/bin/grep
SED=/usr/bin/sed
FIND=/usr/bin/find
TR=/usr/bin/tr
HEAD=/usr/bin/head
CUT=/usr/bin/cut
# grep 认环境变量 GREP_OPTIONS（当成默认选项塞在最前面）：-x、--include、-s 这类会让搜索「什么都没找到」又不报错，一路判成 0。
# 它从部署那边原样传进来（只去掉 HH_*），所以自己清掉；GREP_COLOR / GREP_COLORS 一起
unset GREP_OPTIONS GREP_COLOR GREP_COLORS

FAKE_HOME=0
LAUNCHD_DIRS=""
NO_WORKSPACE=0
while [ $# -gt 0 ]; do
  # 参数不对是 2，还没开始判，不会被当成 0
  case "$1" in
    --home) [ $# -ge 2 ] || { echo "--home 后面要写目录"; finish 2; }; HOME="$2"; FAKE_HOME=1; shift 2 ;;
    --launchd-dirs) [ $# -ge 2 ] || { echo "--launchd-dirs 后面要写目录（冒号隔开）"; finish 2; }; LAUNCHD_DIRS="$2"; shift 2 ;;
    --no-workspace) NO_WORKSPACE=1; shift ;;
    *) echo "用法：check-instance-entries.sh [--home <目录>] [--launchd-dirs <目录>:<目录>] [--no-workspace]"; finish 2 ;;
  esac
done
# 从这里起只有一条流：脚本和它起的工具写到 stderr 的也按顺序进 stdout。部署的钩子把 stdout 和 stderr 接在一起、只认最后一行的
# 跑完的标记——哪个只是看看的命令往 stderr 写一句无关紧要的警告，不能让它排到标记后面、每次部署都被拦下（她又过不了）。
# 两遍搜索自己的重定向（第一遍 2>/dev/null、第二遍 2>&1 >/dev/null 只收 stderr）是在这之后各自再接的，不受影响
exec 2>&1
# 换掉 grep 只在测试里（给了 --home）认
if [ "${FAKE_HOME}" = 1 ] && [ -n "${HH_CHECK_GREP:-}" ]; then GREP="${HH_CHECK_GREP}"; fi
# 判断用的每个工具都要能执行：不能用就是没判成（3）——不能让「grep 起不来」变成「什么都没找到」
for t in "${GREP}" "${SED}" "${FIND}" "${TR}" "${HEAD}" "${CUT}"; do
  [ -f "${t}" ] && [ -x "${t}" ] || fail3 "检查自己没跑成：${t} 不能用"
done
# 文件按字节读：UTF-8 的 locale 里 sed 碰到不是 UTF-8 的字节会停下（后面的行就没判），C 的 locale 里不会。launchd 起的进程本来就没有 locale
export LC_ALL=C
# 家目录要归跑检查的这个用户：sudo -u 没带 -H 时 HOME 还是原来那个人的，拿别人的家判，可能判出一个空空的「没有红的」。只说哪不对，不印它的值
[ -O "${HOME}" ] || fail3 "检查自己没跑成：家目录不归跑检查的这个用户（sudo 要带 -H），没法判断"
if [ -z "${LAUNCHD_DIRS}" ]; then
  if [ "${FAKE_HOME}" = 1 ]; then LAUNCHD_DIRS="${HOME}/Library/LaunchAgents"
  else LAUNCHD_DIRS="${HOME}/Library/LaunchAgents:/Library/LaunchDaemons:/Library/LaunchAgents"; fi
fi
if [ "${FAKE_HOME}" = 1 ]; then INSTANCE_FILE="${HOME}/.hh/config.json"; else INSTANCE_FILE="${HH_CONFIG:-${HOME}/.hh/config.json}"; fi

ENTRY_RE='src/(cli|hhd|console/main)\.ts'

# ---- 「往环境里放了 HH_CONFIG」认得的写法：四种文件各一套 ----
# 认不出来只会让一行从「绿」变成「看」（不拦；红只看有没有这几个字），所以这几套求好读、不求全。每一套上面：认的写法、故意不认的一个。
# 每行先经过 grep -n（前面多了「行号:」，所以 NUM 就是行首），去掉注释行，再从第一个「空白 + 注释符」切掉行尾注释（plist 不切）。
NUM='^[0-9]+:'
Q='["'"'"']'
SET_='[[:space:]]*=([^=]|$)'
# plist     认：<key>HH_CONFIG</key>（EnvironmentVariables 里）   <string>HH_CONFIG=/x</string>（/usr/bin/env 的参数）
#           不认：<!-- <key>HH_CONFIG</key> -->（含 <!-- 的行整行不看）
CARRY_PLIST='<key>HH_CONFIG</key>|<string>HH_CONFIG='
# Python    认：env["HH_CONFIG"] = x   {"HH_CONFIG": x}   dict(os.environ, HH_CONFIG=x)   os.environ.setdefault('HH_CONFIG', x)   os.putenv("HH_CONFIG", x)
#           不认：HH_CONFIG = Path.home() / '.hh/config.json'（行首的模块常量，不是环境）
CARRY_PY='\['"${Q}"'HH_CONFIG'"${Q}"'\]'"${SET_}"'|'"${Q}"'HH_CONFIG'"${Q}"'[[:space:]]*:|[(,][[:space:]]*HH_CONFIG'"${SET_}"'|(setdefault|putenv)\([[:space:]]*'"${Q}"'HH_CONFIG'"${Q}"
# JS / TS   认：process.env["HH_CONFIG"] = x   { "HH_CONFIG": x }   { ...process.env, HH_CONFIG: x }   process.env.HH_CONFIG = x（??= ||= 也认）
#           不认：process.env.HH_CONFIG === x
CARRY_JS='\['"${Q}"'HH_CONFIG'"${Q}"'\]'"${SET_}"'|'"${Q}"'HH_CONFIG'"${Q}"'[[:space:]]*:|('"${NUM}"'|[{,])[[:space:]]*HH_CONFIG[[:space:]]*:|process\.env\.HH_CONFIG[[:space:]]*(\?\?|\|\|)?=([^=]|$)'
# shell     认（真放进子进程环境的）：export HH_CONFIG=…   export HH_CONFIG（先赋值、另一行再导出：凭据是导出的那一行）
#               declare -x / typeset -x HH_CONFIG…   和命令写在同一行的前缀 HH_CONFIG=/x node …、A=1 HH_CONFIG=/x node …、cd x && HH_CONFIG=/x node …、
#               then HH_CONFIG=/x node …、HH_CONFIG=/x \（命令在下一行）   env 的写法 exec env -i HH_CONFIG=/x node …、sudo -u x env HH_CONFIG=/x node …
#           不认：光赋值不导出的 HH_CONFIG=/x（子进程拿不到）、HH_CONFIG=/x; node …、… || HH_CONFIG=/x、dev) HH_CONFIG=/x ;;、: "${HH_CONFIG:=/x}"、
#               echo run HH_CONFIG=/x（不在一条命令的开头，前面也不是 env）、export HH_CONFIG_OLD=1、env -u HH_CONFIG …
ENVW='([^[:space:]]*/)?env([[:space:]]+-[^[:space:]]*)*[[:space:]]+'
NAMEVAL='[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+'
SH_START='('"${NUM}"'|[;&|(){])[[:space:]]*((then|do|else)[[:space:]]+)?'
SH_EXPORT='(export|declare[[:space:]]+-x|typeset[[:space:]]+-x)[[:space:]]+([A-Za-z_][A-Za-z0-9_]*(=[^[:space:]]*)?[[:space:]]+)*HH_CONFIG(=([^=]|$)|[[:space:];&|)]|$)'
SH_ENV='(exec[[:space:]]+)?'"${ENVW}"'('"${NAMEVAL}"')*HH_CONFIG=([^=]|$)'
# 前缀：HH_CONFIG=… 后面同一行还跟着一个命令（不是 ; & | # 这些）才算——光赋值的那一行什么都不导出
SH_PREFIX='('"${NAMEVAL}"')*HH_CONFIG=[^[:space:];&|]*[[:space:]]+('"${NAMEVAL}"')*[^[:space:];&|#]'
CARRY_SH="${SH_START}"'('"${NAMEVAL}"')*'"${SH_EXPORT}"'|('"${SH_START}"'|[[:space:]])'"${SH_ENV}"'|'"${SH_START}${SH_PREFIX}"
# 没有认得的扩展名时看第一行：#! 里是 python → Python；node / deno / bun / tsx → JS；别的都当 shell
SHEBANG_PY='^#!.*[/[:space:]]python[0-9.]*([[:space:]]|$)'
SHEBANG_JS='^#!.*[/[:space:]](node|deno|bun|tsx)([[:space:]]|$)'

# 文件的种类：plist / py / js / sh。种类认错只影响绿和看（红只看有没有这几个字），所以第一行读不了就当 shell
kind_of() {
  case "$1" in
    *.plist) echo plist; return 0 ;;
    *.py) echo py; return 0 ;;
    *.js|*.mjs|*.cjs|*.ts|*.mts|*.cts|*.tsx|*.jsx) echo js; return 0 ;;
  esac
  if "${HEAD}" -n 1 "$1" 2>/dev/null | "${GREP}" -aqE "${SHEBANG_PY}"; then echo py
  elif "${HEAD}" -n 1 "$1" 2>/dev/null | "${GREP}" -aqE "${SHEBANG_JS}"; then echo js
  else echo sh; fi
}
# 这个文件往环境里放 HH_CONFIG 的头两行证据（四个空格、行号、截到 100 个字符）；什么都没印 = 没认出来。
# 只有「绿」用它：它出了错只会少印证据（绿 → 看），不会多出一个红
carries() {
  local kind set drop cut
  kind=$(kind_of "$1")
  case "${kind}" in
    plist) set="${CARRY_PLIST}"; drop='<!--'; cut='' ;;
    py) set="${CARRY_PY}"; drop='^[0-9]+:[[:space:]]*#'; cut='s/[[:space:]]#.*$//' ;;
    js) set="${CARRY_JS}"; drop='^[0-9]+:[[:space:]]*//'; cut='s/[[:space:]]\/\/.*$//' ;;
    *) set="${CARRY_SH}"; drop='^[0-9]+:[[:space:]]*#'; cut='s/[[:space:]]#.*$//' ;;
  esac
  "${GREP}" -an '' "$1" 2>/dev/null | "${GREP}" -avE "${drop}" | "${SED}" -E "${cut}" | "${GREP}" -aE "${set}" | "${HEAD}" -n 2 | "${CUT}" -c1-100 | "${SED}" 's/^/    /'
}
# 这个文件里有没有 HH_CONFIG 这几个字（注释里、字符串里都算）：0 有，1 没有，别的 = grep 出错（调用的地方当成没判成）
mentions() { "${GREP}" -aqF HH_CONFIG "$1"; }
# 提到 HH_CONFIG 的头两行，标明是哪个文件（第二个参数：它自己 / 起它的 plist / 这个 plist）
mention_lines() { "${GREP}" -anF HH_CONFIG "$1" 2>/dev/null | "${HEAD}" -n 2 | "${CUT}" -c1-100 | "${SED}" "s/^/    提到 HH_CONFIG（${2}）：/"; }
# 行下面：这个文件里头两处匹配入口的行（行号、截到 100 个字符），一眼看出脚本找到的是什么（比如只是字符串里写了这几个字，不是调用）
detail() { "${GREP}" -anE "${ENTRY_RE}" "$1" 2>/dev/null | "${HEAD}" -n 2 | "${CUT}" -c1-100 | "${SED}" 's/^/    /'; }
# 把一段文字变成能放进 grep -E 里原样匹配的样子
reesc() { printf '%s' "$1" | "${SED}" 's/[][\.*^$(){}?+|/]/\\&/g'; }
# 工作区路径：实例配置（或默认配置）顶层的 workspace，一行；文件不在就什么都不印。
# /usr/bin/plutil 在的话先用它：-extract workspace raw 读 JSON、取顶层的那个键（嵌套的同名键在文本里排在前面也取不到）；
# 没有这个键、值是 null、读不懂这个文件时它退出码 1、什么都不印——这时（以及没有 plutil 时）退到文本里第一个 "workspace": "…"。
# 不先跑 plutil -lint：它不认 JSON，那样 plutil 这一支永远走不到
ws_from() {
  [ -f "$1" ] || return 0
  local v
  if [ -x /usr/bin/plutil ]; then
    v=$(/usr/bin/plutil -extract workspace raw -o - "$1" 2>/dev/null)
    if [ $? = 0 ] && [ -n "${v}" ]; then printf '%s\n' "${v}"; return 0; fi
  fi
  # 只替换第一个 "workspace": "…"（sed 的 s 不加 g），换成单独一行，再取那一行
  "${TR}" -d '\n' < "$1" | "${SED}" 's/"workspace"[[:space:]]*:[[:space:]]*"\([^"]*\)"/\
>>\1\
/' | "${SED}" -n 's/^>>//p' | "${HEAD}" -n 1
}

say() { printf '\n== %s\n' "$1"; }

say "1. hh 这条命令是什么（包一层的脚本里有没有给 HH_CONFIG 默认值）"
# 找不到 hh 不是错：这一条只是看（第 4 条照样查 ~/.local/bin）
if [ "${FAKE_HOME}" = 1 ]; then HH_BIN=""; else HH_BIN=$(command -v hh 2>/dev/null || true); fi
echo "command -v hh: ${HH_BIN:-（PATH 里没有）}"
# sudo -u 起的非登录 shell 里 PATH 不带 ~/.local/bin：找不到就直接用那里的 hh（后面第 4 条找工作区时要从它里面找代码目录）
if [ -z "${HH_BIN}" ] && [ -x "${HOME}/.local/bin/hh" ]; then
  HH_BIN="${HOME}/.local/bin/hh"
  echo "改用 ${HH_BIN}"
fi
SEEN=""
for f in "${HH_BIN}" "${HOME}/.local/bin/hh"; do
  [ -n "${f}" ] && [ -f "${f}" ] || continue
  case " ${SEEN} " in *" ${f} "*) continue ;; esac
  SEEN="${SEEN} ${f}"
  echo "-- ${f}（$(file -b "${f}" | "${CUT}" -c1-40)）"
  if file -b "${f}" | "${GREP}" -qi "text"; then
    "${GREP}" -n "HH_CONFIG\|cli\.ts\|exec \|node" "${f}" | "${CUT}" -c1-200
    "${GREP}" -q "HH_CONFIG" "${f}" && echo "   -> 脚本里提到了 HH_CONFIG" || echo "   -> 脚本里没有 HH_CONFIG：没带环境变量的调用会报错"
  fi
done

say "2. 正在跑的 hhd / 控制台进程带的 HH_CONFIG（只打印这一个变量）"
if [ "${FAKE_HOME}" = 1 ]; then
  echo "（给了 --home：这一条跳过）"
else
  ps -axEww -o pid=,command= 2>/dev/null | "${GREP}" -E "src/(hhd|console/main)\.ts" | "${GREP}" -v grep | while read -r line; do
    pid=${line%% *}
    what=$(echo "${line}" | "${GREP}" -oE "src/(hhd|console/main)\.ts" | "${HEAD}" -1)
    cfg=$(echo "${line}" | "${GREP}" -oE "HH_CONFIG=[^ ]+" | "${HEAD}" -1)
    echo "pid ${pid} ${what} ${cfg:-（没有 HH_CONFIG）}"
  done
fi

say "3. 定时和常驻任务（launchd）里启动 hh 的：有没有 HH_CONFIG"
PLISTS=""        # 读得了的 plist，一行一个：第 4 条里找入口、找「起它的」都只看这些
UNREADABLE=""    # 读不了的 plist，一行一个：第 4 条里各列一行「看」
# 目录用冒号隔开：临时把 IFS 换成冒号拆进位置参数（不用 here-document；拆的时候关掉通配，拆完就恢复）
OLD_IFS="${IFS}"
set -f
IFS=:
set -- ${LAUNCHD_DIRS}
IFS="${OLD_IFS}"
set +f
for d in "$@"; do
  # 不存在的目录：这台机器上没有这一处（默认列了三个，不是每台都有），跳过不是没看
  [ -n "${d}" ] && [ -d "${d}" ] || continue
  # 在、却列不出来（没有读或进入的权限）：里面可能就有起入口的 plist，当成「没有」就是没看就放行，所以是 3
  [ -r "${d}" ] && [ -x "${d}" ] || fail3 "检查自己没跑成：${d} 读不了"
  for p in "${d}"/*.plist; do
    [ -f "${p}" ] || continue    # 一个 plist 都没有时通配原样留着；叫 x.plist 的目录也不是
    if [ ! -r "${p}" ]; then
      UNREADABLE="${UNREADABLE}${p}
"
      echo "${p}：读不了（第 4 条里列成「看」）"
      continue
    fi
    PLISTS="${PLISTS}${p}
"
    if "${GREP}" -aqE "/hh[\"< ]|bin/hh<|cli\.ts|hhd\.ts|console/main\.ts" "${p}" 2>/dev/null; then
      if [ -n "$(carries "${p}")" ]; then s="有认得的 HH_CONFIG 写法"; else s="没有认得的 HH_CONFIG 写法"; fi
      echo "${p}：${s}"
    fi
  done
done
if [ "${FAKE_HOME}" = 1 ]; then
  echo "（给了 --home：crontab 不看）"
else
  echo "crontab 里提到 hh 的行数：$(crontab -l 2>/dev/null | "${GREP}" -cE '(^|[ /])hh( |$)')"
fi

say "4. 不经那层脚本、直接起 src/cli.ts / src/hhd.ts / src/console/main.ts 的入口（这种要自己带 HH_CONFIG；漏带的在启动检查处退出码 1）"
WS=""
TRIED=""
WS=$(ws_from "${INSTANCE_FILE}")
TRIED="${TRIED}
  实例配置 ${INSTANCE_FILE} 里的 workspace：${WS:-（没有）}"
# 实例配置里没有 workspace：从 hh 那层脚本里找到代码目录，读那里的 config/default.json
if [ -z "${WS}" ] && [ -n "${HH_BIN}" ]; then
  CODE=$("${SED}" -n 's#.* \(/[^ "]*\)/src/cli\.ts.*#\1#p' "${HH_BIN}" 2>/dev/null | "${HEAD}" -1)
  if [ -n "${CODE}" ]; then
    WS=$(ws_from "${CODE}/config/default.json")
    TRIED="${TRIED}
  代码目录 ${CODE}/config/default.json 里的 workspace：${WS:-（没有）}"
    [ -n "${WS}" ] && echo "（工作区路径取自 ${CODE}/config/default.json）"
  else
    TRIED="${TRIED}
  hh 那层脚本（${HH_BIN:-没有}）里找不到代码目录"
  fi
fi
case "${WS}" in "~"*) WS="${HOME}${WS#\~}" ;; esac
if [ -z "${WS}" ] || [ ! -d "${WS}" ]; then
  if [ "${NO_WORKSPACE}" = 1 ]; then
    echo "（--no-workspace：没找到工作区，它的 scripts / tools 这一处没查）"
    WS=""
  else
    # 工作区没找到就没法判：2，不是 0
    echo "没找到工作区，没法判断。找过的地方：${TRIED}"
    finish 2
  fi
else
  echo "工作区：${WS}"
fi

# ---- 4a. 列出入口文件：工作区的 scripts / tools、~/.local/bin 这一层、读得了的 plist ----
set --
if [ -n "${WS}" ]; then
  for d in "${WS}/scripts" "${WS}/tools"; do [ -d "${d}" ] && set -- "$@" "${d}"; done
fi
# 搜一遍，印出含 cli.ts / hhd.ts / console/main.ts 的文件。find -L 跟着符号链接走、-type f 不碰管道。
# 返回 1 = 有一步自己失败了（退出码 2 以上，或者被杀）。find 的 1 不算失败：-exec grep … {} + 里有一批一个都没找到时 grep 退 1、
# find 原样传上来，和「没找到」分不开——find / grep 真出错时都会说一句话，第二遍（只收 stderr）收得到
search_callers() {
  local bad=0
  if [ $# -gt 0 ]; then
    "${FIND}" -L "$@" -type f -exec "${GREP}" -alE "${ENTRY_RE}" {} +
    [ $? -le 1 ] || bad=1
  fi
  if [ -d "${HOME}/.local/bin" ]; then
    "${FIND}" -L "${HOME}/.local/bin" -maxdepth 1 -type f -exec "${GREP}" -alE "${ENTRY_RE}" {} +
    [ $? -le 1 ] || bad=1
  fi
  if [ -n "${PLISTS}" ]; then
    # 一行一个拆开交给一次 grep（在子 shell 里改 IFS、关通配，不带出来）；grep 的 1 = 这些 plist 里一个都没有
    ( IFS='
'; set -f; exec "${GREP}" -alE "${ENTRY_RE}" ${PLISTS} )
    [ $? -le 1 ] || bad=1
  fi
  return "${bad}"
}
# 第一遍只收结果（stderr 扔掉）。最后一行的标记由同一个 $( ) 在搜索没失败时印：不在最后一行 = 这一遍没跑到头
# （被杀、fork 不出来、某一步自己失败了），手里的结果不全，不能当成「只有这些」
FOUND=$(search_callers "$@" 2>/dev/null && echo "@@END@@")
case "${FOUND}" in
  "@@END@@"|*"
@@END@@") FOUND="${FOUND%@@END@@}" ;;
  *) fail3 "检查自己没跑成：搜索没跑完（结尾的标记没出来：搜索被打断，或者 find / grep 自己失败了）" ;;
esac
# 第二遍只收 stderr（结果扔掉），同样以标记结尾：读不了的目录、文件，find / grep 都会说一句——收到任何一句都是没搜全
ERRS=$(search_callers "$@" 2>&1 >/dev/null && echo "@@END@@")
if [ "${ERRS}" != "@@END@@" ]; then
  ERRS="${ERRS%@@END@@}"
  fail3 "搜索没跑全：" "${ERRS:-（第二遍没跑完，也没说为什么）}"
fi

# ---- 4b. 判一个入口 ----
NOBODY="    起它的：没有 launchd 任务点它的名（谁起它就继承谁的环境）"
# 这个文件是不是第 3 条列出来的（读得了的）plist：按整行比，不经 grep
is_plist() {
  case "
${PLISTS}" in *"
${1}
"*) return 0 ;; esac
  return 1
}
# 测试文件的名字（工作区 scripts / tools 里、没有 plist 点它的名时才跳过）
is_test_name() {
  case "$1" in test_*.py|*_test.py|*.test.ts|*.test.js|*.test.py) return 0 ;; esac
  return 1
}
# 起它的 plist，一行一个：写着它的完整路径，或者文件名——两边都要有分界（左：行首、「/」「>」「"」空格；右：「"」「'」「<」「;」「&」「|」「)」空格、行尾），
# 所以 sensor.py 在 <string>sensor.py</string>、python3 sensor.py、sh -c 'cd /x; python3 sensor.py' 里算，my_sensor.py、sensor.py.old 不算。
# 转义或 grep 出错（退出码 2 以上）返回 3：转义出了空串会让每个 plist 都像起它的
starters_of() {
  local esc escf rb
  esc=$(reesc "${1##*/}") && [ -n "${esc}" ] || return 3
  escf=$(reesc "$1") && [ -n "${escf}" ] || return 3
  rb='(["'"'"'< ;&|)]|$)'
  [ -n "${PLISTS}" ] || return 0      # 一个读得了的 plist 都没有：没有起它的（读不了的另有「看」行）
  ( IFS='
'; set -f; exec "${GREP}" -alE "${escf}${rb}|(^|[/>\" ])${esc}${rb}" ${PLISTS} )
  [ $? -le 1 ] || return 3            # grep 的 1 = 没有 plist 点它的名；2 以上是 grep 自己出错
  return 0
}
# plist 自己就直接起入口（ProgramArguments 里写着 cli.ts / hhd.ts / console/main.ts）：起它的是 launchd，带没带看它自己
classify_plist() {
  local p="$1" ev m
  ev=$(carries "${p}")
  if [ -n "${ev}" ]; then echo "绿  ${p}：自己往环境里放了 HH_CONFIG"; printf '%s\n' "${ev}"; return 0; fi
  mentions "${p}"
  m=$?
  case "${m}" in
    0) echo "看  ${p}：这个 plist 直接起入口，提到了 HH_CONFIG，但不是认得的写法"; detail "${p}"; mention_lines "${p}" "这个 plist" ;;
    1) echo "红  ${p}：这个 plist 直接起入口，里面没有 HH_CONFIG 这几个字"; detail "${p}" ;;
    *) return 3 ;;    # grep 出错：没判成，不能当成「没有」
  esac
  echo "    起它的：launchd（照这个 plist 起）"
}
# 判一个入口文件，印出它的行（规矩见开头）：一个起它的 plist 一行，行下面是凭据。判断要用的 grep 出了错就返回 3——
# 判到一半也不算：主循环见到返回不是 0、或者头一行不是这个文件的行，就以 3 退出、点它的名。
# 所以「红」只在两次 grep -F HH_CONFIG（它自己、起它的 plist）都明说「没有」（退出码 1）之后才印：看不了的文件不会被判成红
classify() {
  local f="$1" starters own m p ev
  [ -f "${f}" ] && [ -r "${f}" ] || return 3        # 刚搜到就没了 / 读不了：没法判
  if is_plist "${f}"; then classify_plist "${f}"; return $?; fi
  starters=$(starters_of "${f}") || return 3
  # 测试文件不是入口：只认工作区 scripts / tools 里这几种名字、而且没有 plist 点它的名；列出来，不悄悄藏
  if [ -z "${starters}" ] && [ -n "${WS}" ] && is_test_name "${f##*/}"; then
    case "${f}" in "${WS}/scripts/"*|"${WS}/tools/"*) echo "跳  ${f}"; return 0 ;; esac
  fi
  mentions "${f}"
  own=$?
  [ "${own}" -le 1 ] || return 3      # grep 出错：没判成，不能当成「没有」
  if [ "${own}" = 0 ]; then
    ev=$(carries "${f}")
    if [ -n "${ev}" ]; then echo "绿  ${f}：自己往环境里放了 HH_CONFIG"; printf '%s\n' "${ev}"; return 0; fi
  fi
  # 自己没有认得的赋值：看谁起它。不是 launchd 起的（hhd 里的会话、人手）继承调用者的环境，要人看
  if [ -z "${starters}" ]; then
    echo "看  ${f}：自己没有认得的 HH_CONFIG 写法，也没有 launchd 任务点它的名"
    detail "${f}"
    if [ "${own}" = 0 ]; then mention_lines "${f}" "它自己"; fi
    echo "${NOBODY}"
    return 0
  fi
  # 起它的 plist 一行一个拆进位置参数（关通配、IFS 只留换行，拆完恢复）
  local old_ifs="${IFS}"
  set -f
  IFS='
'
  set -- ${starters}
  IFS="${old_ifs}"
  set +f
  for p in "$@"; do
    ev=$(carries "${p}")
    if [ -n "${ev}" ]; then echo "绿  ${f}：自己没带，起它的 ${p} 带了"; printf '%s\n' "${ev}"; continue; fi
    mentions "${p}"
    m=$?
    [ "${m}" -le 1 ] || return 3      # 同上
    if [ "${own}" = 1 ] && [ "${m}" = 1 ]; then
      echo "红  ${f}：它和起它的 ${p} 里都没有 HH_CONFIG 这几个字"
      detail "${f}"
    else
      echo "看  ${f}：提到了 HH_CONFIG，但不是认得的写法（起它的 ${p} 里也没有认得的写法）"
      detail "${f}"
      if [ "${own}" = 0 ]; then mention_lines "${f}" "它自己"; fi
      if [ "${m}" = 0 ]; then mention_lines "${p}" "起它的 plist"; fi
    fi
    echo "    起它的：${p}"
  done
  return 0
}
# 印出来的头一行是不是这个文件的行（绿 / 红 / 看 / 跳 + 两个空格 + 它的路径）
rows_are_for() {
  case "$2" in "绿  ${1}："*|"红  ${1}："*|"看  ${1}："*|"跳  ${1}") return 0 ;; esac
  return 1
}

# ---- 4c. 一个入口一个入口地判：在主 shell 里循环（不套管道），每个入口都要判出它的行，不然以 3 退出、点它的名 ----
ROWS=""      # 所有的行连同下面的凭据，最后从这里数
SAW_RED=0    # 循环里亲眼见到过红的行（bash 自己看的；和 grep -c 数出来的红对照）
NEED=0       # 至少几行：每个入口一行、每个读不了的 plist 一行
SEEN="
"
OLD_IFS="${IFS}"
set -f
IFS='
'
set -- ${FOUND}
IFS="${OLD_IFS}"
set +f
for f in "$@"; do
  # 备份（x.bak、x.bak-20261101）、编译产物（__pycache__ 里的、.pyc）不是入口——只要没有 plist 点它的名。
  # 有 plist 点它的名，launchd 照样起它；launchd 目录里的 plist 自己名字像备份也照样载入：这两种照常判（和测试文件一样）
  aside=0
  case "${f##*/}" in *.bak|*.bak-*) aside=1 ;; esac
  case "${f}" in */__pycache__/*|*.pyc) aside=1 ;; esac
  if [ "${aside}" = 1 ] && ! is_plist "${f}"; then
    st=$(starters_of "${f}") || fail3 "检查自己没跑成：${f} 没判出来（找起它的 plist 时出错）"
    [ -n "${st}" ] || continue
  fi
  case "${SEEN}" in *"
${f}
"*) continue ;; esac                                         # 同一个文件搜到两次（目录之间有链接）：判一次
  SEEN="${SEEN}${f}
"
  NEED=$((NEED + 1))
  rows=$(classify "${f}")
  rc=$?
  # 没判出来（某个 grep 出错、判到一半、一行也没印）就是没判：3，不往下数
  if [ "${rc}" != 0 ] || ! rows_are_for "${f}" "${rows}"; then
    fail3 "检查自己没跑成：${f} 没判出来（退出码 ${rc}）"
  fi
  case "
${rows}" in *"
红  "*) SAW_RED=1 ;; esac
  printf '%s\n' "${rows}"
  ROWS="${ROWS}${rows}
"
done
# 读不了的 plist：不知道它起什么，列成看（不拦——一个改不了的系统 plist 不能让每次部署都卡住）
OLD_IFS="${IFS}"
set -f
IFS='
'
set -- ${UNREADABLE}
IFS="${OLD_IFS}"
set +f
for p in "$@"; do
  row="看  ${p}：读不了，没法看它起什么"
  echo "${row}"
  ROWS="${ROWS}${row}
"
  NEED=$((NEED + 1))
done
if [ "${NEED}" = 0 ]; then echo "（没有找到）"; fi

# ---- 4d. 数、对照、下结论：全脚本只有这里能退出 0 ----
count() { printf '%s' "${ROWS}" | "${GREP}" -ac "^${1}  "; }
GREEN=$(count 绿)
BAD=$(count 红)
LOOK=$(count 看)
SKIPPED=$(count 跳)
# 每个数单独验，是数字才往下走（几个拼在一起验，坏掉的一个会被别的数字盖住）
for v in "${GREEN}" "${BAD}" "${LOOK}" "${SKIPPED}"; do
  case "${v}" in ""|*[!0-9]*) fail3 "检查自己没跑成（数不出结果）" ;; esac
done
# 行不能比入口少；数出来的红要和循环里见到的对得上——说「没有红的」要两边都说没有
[ $((GREEN + BAD + LOOK + SKIPPED)) -ge "${NEED}" ] || fail3 "检查自己没跑成（数出来的行比入口少）"
case "${SAW_RED}:${BAD}" in
  0:0|1:[1-9]*) ;;
  *) fail3 "检查自己没跑成（数出来的红和见到的对不上）" ;;
esac
if [ "${SKIPPED}" -gt 0 ]; then echo "（跳过测试文件 ${SKIPPED} 个：它们不是入口，名字见上面「跳」的行）"; fi

say "结论"
echo "直接起 cli.ts / hhd.ts / console/main.ts 的入口：$((GREEN + BAD + LOOK)) 处；红 ${BAD} 处，要人看 ${LOOK} 处。"
if [ "${BAD}" -gt 0 ]; then
  echo "不能部署：红的每一处（它和起它的 plist 里都没有 HH_CONFIG 这几个字）先带上 HH_CONFIG——在它自己拼环境的地方给默认值，或者在起它的 plist 的 EnvironmentVariables 里加。"
  echo "认得的写法（一行写完，行尾可以跟注释）：Python env[\"HH_CONFIG\"] = …、\"HH_CONFIG\": …、dict(os.environ, HH_CONFIG=…)、setdefault(\"HH_CONFIG\", …)；JS process.env.HH_CONFIG ??= …、{ HH_CONFIG: … }；shell export HH_CONFIG=…，或者和命令写在同一行 HH_CONFIG=… node …（前面可以有 env / exec）；plist <key>HH_CONFIG</key> 或 <string>HH_CONFIG=…。写了别的样子也不再是红，是看。"
  echo "要是这个文件只是提到这几个路径、并不起它们：在文件里写一行注释说明（注释里带上 HH_CONFIG 这几个字），它就会列成「看」，不再拦。"
  finish 1
fi
echo "没有红的。「看」的几处确认一下是谁在起它们；第 1 条里那层脚本没有 HH_CONFIG 默认值的话也先补上。"
# 全脚本唯一的 0：走到这里，工具都能用、搜索跑完也没出错、每个入口都判出了自己的行、几个数都是数字而且和循环里见到的对得上、没有红的
finish 0
