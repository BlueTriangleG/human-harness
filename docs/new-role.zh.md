# 建一个新角色

一个角色就是一个目录：它的实例配置、它的工作区（人格文件、记忆）和它的状态。一个系统用户下可以并存好几个角色，各有各的任务名、端口和状态。下面的命令都在 HH 的代码目录里跑。English: [new-role.md](new-role.md).

`./setup` 会替你做完第 1 到第 3 步：问角色的语言、名字、它怎么称呼你，在 `~/HH/<id>` 建好角色（只开不用另外设置的模块），装好，打开它的窗口。它的参数：`./setup [--lang zh|en] [--name <名字>] [--owner <它怎么称呼你>] [--id <id>] [--model opus|sonnet|haiku] [--dir <路径>] [--no-app] [--yes]`（带 `--yes` 就不问，没给的都用默认值）。这一页讲它一步一步做了什么，以及自己动手怎么做。

## 1. 建目录

```sh
node src/cli.ts new <id> --owner <它怎么称呼主人> [--dir <路径>] [--me <它的名字>] [--lang zh] [--persona <名字>]
```

它会写出 `<目录>/instance.json`，在 `<目录>/workspace/` 里写五个人格文件和闸门的第一批规则（`gate.json`），在 `<目录>/launchd/` 里写 hhd 和控制台的 launchd 文件（只是给你看，第 2 步才装）。工作区从第一天起就是一个 git 仓库，带一个提交：夜里的人格快照要读它的 HEAD。

角色默认说英文，`--lang` 可以换成别的语言包（现在另一个是 `zh`）：它的提示、工具、手册和起步的人格文件都用这个语言，配置里无论如何都会写上 `lang`。英文角色还会碰到哪些中文，列在 README 的「Status」里。配置会：

- 打开所有自带模块（内核自己的本来就开着）；`./setup` 接着把要先登录、或者要先装别的程序的那几个关掉（新的 Mac 上是 `backup`、`bilibili`、`media`、`phone`、`qq`、`whatsapp`），`hh modules doctor` 会说每个怎么打开；
- 以 `config/new-role.json` 盖在框架默认值上：没有专注时段、不定时放空（要开就设 `schedule.focusSlots` 和 `schedule.wanderEveryMinutes`），笔记本开着，闸门的每日总结开着，再加上这个语言需要的设置；
- 把 `tools.python` 指到角色自己的 Python 环境 `<目录>/state/venv`（第 2 步建）；
- 保持 `tools.sendDryRun: true`：角色有渠道之前，什么都不往外发；
- 给它的浏览器和控制台各挑一个空闲端口，任务名是 `ai.hh.<id>.hhd` / `ai.hh.<id>.console`；
- 在 macOS 上给角色起一个自己的 app，`launchd.app`（`~/Applications/HH/<id>/<名字>.app`）：第 2 步生成它，角色的任务都经它起，所以主人给的隐私权限都算在这个 app 头上；
- 这个系统用户已经跑着另一个角色的负载守卫时，设 `modules.load-guard.shed: false`：一台机器上只有一个角色负责减负、告诉它的主人，其他的只看着。

开起来之前，把这个角色是谁写进 `IDENTITY.md`、`SOUL.md` 和 `USER.md`。`AGENTS.md` 开头有几条提到主人的工作规矩，随你改。

带 `--persona <名字>` 就从一个现成的人格起步（`personas/README.md` 列着有哪些）：它的文件替换起步的那几个，名字和主人会填进去；除非 `--me` 另给一个名字，角色就用这个人格的名字。人格没带的文件还是起步的那份。

## 2. 装起来

```sh
HH_CONFIG=<目录>/instance.json node src/cli.ts modules install
```

- 建 Python 环境，把每个开着的模块的 `requirements.txt` 装进去；模块自己带包的，也把包装好；
- 把每个开着的模块的手册链到角色的书架上（已经有的页不动，会说一声）；
- 在 macOS 上用 Xcode 命令行工具生成角色的 app（`launchd.app`），用角色自己的身份签名，然后打开它的开权限页（完全磁盘访问、录屏与系统录音、辅助功能；点「以后再说」也行，以后打开这个 app，只要还有一项没开就会再显示这一页）。app 生成不了时一个任务都不装，那一行会说原因。没有这套工具时 `./setup` 会带上 `--no-app`（用 `hh new` 时不要 app：把配置里的 `launchd.app` 删掉），任务就不经 app 起；
- 把 launchd 任务装进 `~/Library/LaunchAgents` 并加载：hhd、控制台，以及每个独立的模块定时任务（`<任务名前缀>.<模块>.<定时任务>`，跑的是 `hh modules timer <模块> <定时任务>`）。那里已经有一个内容不同的同名任务文件时不动它，会说一声。hhd 的任务一加载就起来；
- 把角色的短命令 `<id>` 放进 PATH 上第一个在你家目录里、你能写的文件夹（一个都没有就放 `~/.local/bin`）：`<id> "…"` 跟角色说话，`<id> console` 打开它的控制台。

`./setup` 接着打开角色的窗口（它的 app，已经和你配好对），没有 app 时在浏览器里打开它的控制台；以后用 `<id> console` 也一样，第一次会自己给浏览器配对。

每一步都会报出来，一步失败不耽误别的步骤；有一步失败时退出码是 1。带 `--no-start` 只写任务文件、不加载（那一行会说每个怎么加载）。

打开或关掉一个模块以后再跑一次就行，已经装好的不动。

HH 的代码要放在系统盘上。在 macOS 上，launchd 起的任务可能读不了外接盘：代码放在 `/Volumes/…` 下，hhd、控制台和模块定时任务一起来就因为读 `package.json` 报「operation not permitted」退出，而同一条命令在终端里敲却能跑。角色自己的目录放在 launchd 读得到的任何地方都行。

没有 app 时，node 也要放在固定路径，升级时原地覆盖。这时 macOS 把系统权限（录屏、完全磁盘访问……）给的是那个真正在跑的文件，launchd 任务跑的是 `tools.node`（`hh new` 会写下它当时用的那个 node）：要是路径里带版本号（`…/Cellar/node/24.1.0/bin/node`），下次升级就是另一个文件，所有权限都要重新开。有 app 时，权限都是 app 的，换了 node 也不丢。

## 3. 检查

```sh
HH_CONFIG=<目录>/instance.json node src/cli.ts modules doctor
```

每个模块都应该是「ok」或「needs setup」。「needs setup」会说人要做的一次性的事（装一个程序、登录、打开另一个模块）。「broken」说明声明或配置有错，那一行会说原因。

## 4. 给它接一个渠道

接上之前，它只能经 `hh tell` 说话：

```sh
HH_CONFIG=<目录>/instance.json node src/cli.ts tell --from <主人> "…"
```

没有渠道的角色没有 `message` 工具，所以 `hh tell` 会等这一轮结束，把角色说的话打出来（最多等十分钟）。两次主人说话之间它想告诉主人的事，会先记下来，等主人下次开口时先说。

渠道由桥来承载：每个聊天应用一个小进程，守着这个应用的连接，通过角色状态目录里的一个 socket 把消息交给 hhd（`docs/contracts/channels.md`）。现在有两座桥，WhatsApp 和 QQ，各有一个模块（`whatsapp`、`qq`）让它一直跑着、检查它。

```sh
export HH_CONFIG=<目录>/instance.json
# QQ：机器人的 app id；密钥从标准输入读，绝不放在命令行上
node src/cli.ts channels add qq --app-id <id> --allow <主人的 openid> --owner-id <主人的 openid> < secret.txt
# WhatsApp：谁可以发消息，然后把角色作为这个账号的新设备连上（手机上输一个配对码）
node src/cli.ts channels add whatsapp --allow +<主人的号码> --owner-id +<主人的号码>
node src/cli.ts channels link whatsapp --phone +<角色账号的号码>

node src/cli.ts modules install      # 装桥的包和它的 launchd 任务；桥会起来
# 重启 hhd（launchctl kickstart -k gui/$(id -u)/ai.hh.<id>.hhd），然后
node src/cli.ts channels             # 有哪些渠道、怎么承载、连没连上
node src/cli.ts modules doctor       # whatsapp / qq 那一行会说还缺什么
```

`channels add` 会写桥自己的文件 `<状态目录>/channels/<名字>.json`（0600：里面有登录信息），把 `channels.<名字>.via` 设成 `bridge`，在配置里打开这个应用的模块（会留一份备份），再把主人的发信 id 写进人员名单里主人那一项。`--allow` 是谁可以私聊角色，`--group-allow` 是群里谁的消息会收（`*` 是所有人）；别人的消息丢掉并计数。`--name` 可以给渠道起 `whatsapp` / `qqbot` 以外的名字。它会告诉你还剩哪些要人来做：

- `tools.sendDryRun` 保持原样；允许角色真的发消息时再关掉它。
- 主人的 `/cc`：由这台机器的账号把这个渠道加进角色的主人发信人文件（`docs/contracts/machine.md`）。角色自己的账号加不了，这是故意的。

桥是一个单独的 launchd 任务（`<角色的任务名前缀>.bridge.<名字>`）：hhd 重启时它照样跑着，部署时会在新代码上重启它。手动重启用 `hh channels restart <名字>`。开着 `watchdog` 模块时（新角色默认开着），桥不回应了会被重启，并告诉主人。

一个应用的登录同一时间只能由一个进程拿着：把角色的渠道从别的程序挪到桥上之前，先停掉那个程序的连接。

**连 WhatsApp。** `channels link whatsapp --phone <账号的号码，带国家码>` 会打出一个 8 位的配对码。在登着这个账号的手机上：WhatsApp > 设置 > 已关联的设备 > 关联新设备 >「改用手机号关联」，输入这个码。命令会一直等到手机接受，把登录写进 `<状态目录>/channels/whatsapp.auth`（0700），再说下一步做什么。码没在时限内输入，它就结束，什么都不留；再跑一次换一个新码。桥在跑时（一个登录只能一个进程），或者那里已经有登录时，它会拒绝。没有二维码。把现成的登录目录放到那个路径也行，不用再连。

`hh setup`、`hh new`、`hh remove`、`hh modules install` 和 `hh channels add | link | remove` 是操作员的命令。在角色自己的会话里跑（它的 shell 带着 `CLAUDECODE=1`）会被拒绝，并用一行话请主人来；在 Claude Code 会话里以操作员身份做事的人，设 `HH_OPERATOR=1`。这只防好心办错事，别的不防。

`channels remove <名字>` 把一个渠道拿掉：停掉并卸下桥的任务，`channels.<名字>` 和这个模块的那一项从配置里拿掉（会留一份备份），桥的文件、登录和收件箱挪进 `<状态目录>/channels/removed-<时间>/`。什么都不删。之后重启 hhd。

## 5. 卸载

```sh
bin/hh remove <id>
```

它先列出要删的东西，请你再输一次 id（带 `--yes` 就不问）：角色的 launchd 任务，它的 app 和 app 所在的文件夹，`hh new` 建的它的目录（配置、工作区和状态：记忆也一起删），它的短命令、控制台口令和 Claude Code 会话记录；然后重置这个 app 的隐私权限。配置里放在它目录外面的工作区或状态不删，会把路径告诉你。详见 [faq.zh.md](faq.zh.md#卸载角色)。

## 不用另外设置就能用的，和不能用的

- `<目录>/state/secrets.json` 里没有 OpenAI key 时，笔记本只按字找页，`hh modules doctor` 会说一声。有 key 就能按意思找：用 `hh openai set` 加一把（或者在 app 的设置里加）。
- 帮手会话用派活的那一方挑的模型；`modules.helpers.model` 可以给所有帮手固定一个。
- 要人登录或要人装程序的模块，在 `hh modules doctor` 里显示为「needs setup」，并写着要做什么。

配置的每一项在 `docs/contracts/instance-config.md`；模块和它们的配置在 `docs/contracts/modules.md`。
