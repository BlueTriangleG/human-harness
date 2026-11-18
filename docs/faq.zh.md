# 常见问题

`<id>` 是角色的 id（`./setup` 会告诉你，也就是 `~/HH/` 下那个文件夹的名字），`<名字>` 是它的名字。`bin/hh` 开头的命令在你 clone 下来的 HH 文件夹里跑。English: [faq.md](faq.md).

## 要哪种 Claude 账号？钱算谁的？

HH 经 Anthropic 的 Agent SDK 驱动官方的、未改动的 Claude Code。它自己没有登录，也从不读取、保存或转交你的 Claude 凭证：角色的每个部分都用 Claude Code 的登录。Claude Code 还没登录时，`./setup` 和向导会替你启动 Claude Code 自己的登录（`claude auth login`，在浏览器里登）；已经登录就只问它是哪种登录（`claude auth status`）并告诉你。以后要换，在 Claude Code 自己的 `/login` 里换。

你自己选，角色用掉的额度跟着这个登录算：

- **你的 Claude 订阅**（Pro、Max、Team……），**默认就是它**：跑 `claude`，输 `/login`，选你的 Claude 账号。角色用的算进你这个套餐的用量上限，和你自己用 Claude Code 一样。HH 每天都在这种登录上跑。用多少：我们跑得最久的那个 agent 整天干活，一天大约用掉 Max 20x 套餐周额度的 5% 到 10%，这还没算帮手会话，算上可能再多一倍。干满一周大约用掉 Max 20x 一周的一半；Max 5x 只有它的四分之一，几天就用完。这是拿我们自己的用量估的。
- **Anthropic Console 账号**（API key）：跑 `claude`，输 `/login`，选 Anthropic Console 账号。按 token、按 API 价格计费。还没完整试过：HH 认这种登录，但它的额度把关是按订阅做的，这种登录下不显示用量，也不替你限花费；要限的话，在 Console 里自己设花费上限。花多少：按 API 价，Sonnet 大约每天 10 到 100 美元，Opus 约是它的两倍。这是拿我们跑得最久的那个 agent 的用量估的（接着两个聊天通道、带着几周的记忆）；新角色起步会低一些；没算帮手会话，实际会更高。
- **别家提供方的 Anthropic 格式接口**（进阶，实验性）：不是一种登录，而是角色的一项设置 `models.providers`（见[换模型](#换模型)）。还没完整试过，也不是每个模型都试过。

只在终端里设的 key 或 token（`ANTHROPIC_API_KEY`、`CLAUDE_CODE_OAUTH_TOKEN`）到不了角色那里：它的任务在后台跑，看不到这些。Amazon Bedrock 和 Google Vertex AI 没列进来：只要设了它们的开关，Claude Code 就报已登录，什么都不查；HH 也没在它们上面试过。

订阅、Agent SDK 和基于它们的工具，Anthropic 的规则改过不止一次。它对基于 Agent SDK 做的产品的说法，是用 API key 登录。选之前先看官方原文，以官方为准：

- [Claude Code：法务与合规](https://code.claude.com/docs/en/legal-and-compliance)
- [Agent SDK 概览](https://code.claude.com/docs/en/agent-sdk/overview)
- [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540)

HH 只从 Claude Code 自己报出来的数里读用量（每一轮的限流读数，和 SDK 的用量接口）。这一周用到 90% 以上，它在专注时段里自己醒得更少；到 97% 以上，会提醒它别再把活派给并行的会话（`schedule.focusQuotaWeekMax`、`parallel.quotaWeekMax`）。OpenAI key 可有可无，单独计费：安装和向导在 Claude 登录之后会问一句，以后用 `hh openai set` 或 app 的设置加、换、删（存在角色的 `state/secrets.json`，权限 0600；改了以后 hhd 等角色空下来自己重启接上）。有了它，记忆和笔记本按意思搜，费用由 OpenAI 收；没有就按字面找。

## 开权限页是什么？能跳过吗？

`./setup` 生成角色的 app 以后，会打开 app 的开权限页「给<名字>开权限」，一共三项：

| 权限 | 角色拿它做什么 |
|---|---|
| 完全磁盘访问 | 读邮件、照片这些受保护的文件 |
| 录屏与系统录音 | 截屏、看屏幕上有什么 |
| 辅助功能 | 替你点按钮、打字 |

每项有一个按钮，开好了会打 ✓。完全磁盘访问 macOS 不让程序自己申请：点「打开设置」，再把页面左边的图标拖进列表。

点「以后再说」也行。角色照样能跑，只是用到权限的事（截屏、读受保护的文件、动鼠标）在开之前做不成。想回到这一页，打开角色的 app（`~/Applications/HH/<id>/<名字>.app`）：三项里只要还有一项没开，它先显示这一页；都开了，就直接打开角色的窗口。

为什么要一个 app：macOS 把权限给提出申请的那个程序，而角色跑的所有东西都由它自己的 app 起，所以权限都算在这个 app 头上。开一次就够了，以后更新、重新生成 app、改名字都不用再开。

没装 Xcode 命令行工具就生成不了 app。`./setup`（还有 `npx human-harness`）会先问要不要装：答「是」就弹出苹果自己的安装窗口（`xcode-select --install`），setup 等它装完接着往下走，app 照样生成。答「不」的话，只要 git 和 Python 有别的来源，就不生成 app 接着装，改成在浏览器里打开角色的控制台。以后想要 app：先 `xcode-select --install`，再 `HH_CONFIG=~/HH/<id>/instance.json bin/hh modules install`。

## 配对：控制台怎么知道是我？

控制台（角色的窗口，或者浏览器里它的页面）只认跟它配过对的客户端。第一次打开时它会自己配对（`./setup` 已经替你打开过），什么都不用输。最多同时配 8 个（一两个浏览器加上 app），再多一个时最早那个会被挤掉。

怎么配的：`<id> console` 先生成一个新口令，再打开一个地址，`#` 后面带的是一次性的配对码，不是口令本身。页面拿这个码换口令，只能换一次、60 秒内有效；换到的口令存在这个浏览器给这个页面的存储里，地址里的码随即去掉。用过的码、超过一分钟的码都配不上：页面会说这个浏览器还没配对，并给出要敲的命令。跑一次 `<id> console --pair`，让新地址在一分钟内打开就行。清掉浏览器里这个页面的数据，这个浏览器就不再配对，照同样的办法再配一次。

## 换一个浏览器

`<id> console` 会在默认浏览器里打开角色的页面。要换浏览器：先把它设成默认浏览器（系统设置 → 桌面与程序坞 → 默认网页浏览器），再跑 `<id> console --pair`。这会给新浏览器配对，同时取消之前配过的所有客户端；角色的 app 下次打开时会自己重新配对。它打开的地址只能用一次、一分钟内有效：要是开到了别的浏览器里，换好默认浏览器再跑一次。

找不到 `<id>` 这个命令，是因为 `./setup` 把它放进了 `~/.local/bin`，而这个目录不在你的 PATH 上。这时改用 `HH_CONFIG=~/HH/<id>/instance.json bin/hh console --pair`。

## setup 加的那一行 PATH

`~/.local/bin` 不在 PATH 上时，setup 会问要不要加上。答「是」就在 `~/.zshrc` 末尾加一行（zsh，Mac 默认的 shell；bash 的话加在 `~/.bash_profile`，只有 `~/.profile` 时加在它里面）：

```sh
export PATH="$HOME/.local/bin:$PATH"  # added by HH setup (Human Harness): the folder of its short commands; delete this line to undo
```

只加一次：文件里已经有这一行，或者本来就把 `~/.local/bin` 放上了 PATH，就不再动它。新开的终端窗口就有。不要了就删掉这一行（用文本编辑器打开 `~/.zshrc` 删，或者 `sed -i '' '/# added by HH setup/d' ~/.zshrc`），再新开一个终端窗口。`hh remove` 不会去删它，因为 Claude Code 的安装脚本也把 `claude` 放在这个目录里；删掉最后一个角色时，它会提一句这一行还在。

## 卸载角色

```sh
bin/hh remove <id>
```

它先列出要删的东西，请你再输一次 id 确认（带 `--yes` 就不问）。然后停掉角色的任务，关掉它 app 的窗口，删掉：

- 它的 app 和 app 所在的文件夹（`~/Applications/HH/<id>`）；
- 它的目录（`~/HH/<id>`）：配置、工作区、状态，**记忆也在里面**，想留着就先把这个文件夹拷出去；
- 它的短命令、控制台口令，以及它跑过的 Claude Code 会话记录；
- `./setup` 为它建的文件夹（`~/HH`、`~/Applications/HH`），前提是里面已经没有别的东西。

它还会重置这个 app 的隐私权限。有几项要管理员才能重置，做不到时它会说一声，你去「系统设置 → 隐私与安全性」里自己删掉这个角色那几行。角色配置里放在它目录外面的工作区或状态文件夹不会删，它会把路径告诉你。`~/Applications/Human.app`（这台电脑上的角色列表）也留着，等一个角色都不剩了再拖进废纸篓。

## 换模型

角色靠 Claude Code 想事情，用的是这台电脑上登录的那个 Claude 账号。

- 建角色时：`./setup --model sonnet`（或 `haiku`）让主脑区用这个模型，不用默认的（默认值在 `config/default.json` 的 `models`）。
- 建好以后：改 `~/HH/<id>/instance.json` 里的 `models`。`models.opus`、`models.sonnet`、`models.haiku` 分别是三档用的模型；`models.byRole` 给某一个脑区（`main`、`side`、`deep`、`hippocampus`、`speech`、`perception`）单独指定模型。改完重启角色：`launchctl kickstart -k gui/$(id -u)/ai.hh.<id>.hhd`。
- 换别家兼容 Anthropic 接口的模型：用 `models.providers` 和 `models.providerByRole`。实验性：还没完整试过，也不是每个模型都试过；每个提供方都写明它是在哪个 Claude Code 版本上试的，而且 Anthropic 不支持在 Claude Code 后面接别家的模型。

所有配置项都在 [contracts/instance-config.md](contracts/instance-config.md)（「Choose models and the daily rhythm」一节）。

## Linux 和 Windows

HH 现在跑在 macOS 14 或更新版本上。起角色任务的那一层已经有 Linux 的实现（macOS 用 launchd，Linux 用 systemd 的用户单元）；在 Linux 上 `./setup` 会跳过 app，直接在浏览器里开控制台。一台干净的 Ubuntu 24.04 已经在容器里从 `git clone` 经 `./setup` 走到 `hh remove`，但 Claude Code 的登录是拿替身顶的（那里没有能登录的账号）：真正的角色还没在 Linux 上从头到尾跑过，而且有几个模块用的是 macOS 的工具（`computer`、`phone`、`media`）。WSL2 和 Windows 还不支持。进度看 README 的「Status」。

Linux 上不一样的地方：

- hhd 或控制台停了以后，systemd 隔 30 秒才把它重新起来（launchd 是马上）：崩了或重启以后，角色大约半分钟后回来。
- `hh console --as <用户>`（角色在它自己的账号下）会重启那个角色的控制台，最多等一分钟让它回来。
- 角色在你登录期间运行。想让它在你退出登录后也接着跑、开机就起来：`sudo loginctl enable-linger $(id -un)`（`./setup` 也会提这一句）。
- 没有桌面、开不了浏览器时，`<id> console` 会把配对地址打出来：自己去开；从另一台电脑开的话，先 `ssh -L <端口>:127.0.0.1:<端口>` 连到这台。只能配一次、一分钟内有效。
