// 中文包里工具的字：她从工具描述、参数说明、回话里读到的话都在这里（src/tools/ 里的代码经 T 读，见 src/lang/index.ts）。
// 一个工具一个导出对象，名字和工具一样：先 description，再 params（按 zod 的键），再各种回话（有参数的回话是函数）；不属于单个工具的字另起一组。
// 搬字的规矩：字一个不改；没有 ${} 的保持原来的字面量种类（字符串还是字符串、模板还是模板），有 ${} 的变成箭头函数、模板原样放进函数体。
// 这里不能有运行时 import（只许 import type），键用普通标识符、不加引号。
// 不属于单个工具的五组（名字不是工具名）：mem（记忆工具共用的几句：失败回话、时间和人的参数说明、没配人物卡模板）、
// newEvent（新建事件的各字段说明，mem_event_create 和 mem_split 共用）、workspaceGit（改完工作区文件、git 没记上时接在回话后面的补话）、
// deliver（经网关投递的各种回话，发消息和发表情包共用）、schedule（remind / reminders 解析时间和循环时的报错、日期标签）。
// 文件里没导出的 VERB、DONE、skippedToday、everyText 是这个包自己的帮手（把动词、「今天这次」、循环的叫法拼进句子）：别的语言包可以不要它们，按自己的语言拼。
// 有两条代码会拿来当条件用：people_i_know.keyBad 返回的话非空，才算「key 不对」；what_do_i_know.unreadable 要过 filter(Boolean) 才留在回话里——写成空字符串行为就变了，别的语言包也不能留空。
// 加一个导出、或者在某个工具里加一条分支的字，要在 test/tooltext/calls.ts 里加一次调用，让逐字的锁（tools-text 测试）看得到。

export const jot_down = {
  description: "随手记一下：想法、发现、做出来的结果、想跟别人说的话。记下的你都会记得。",
  params: {
    urgent: "急事：得尽快让跟人说话的你知道（比如要说给谁、晚了就没用了），会把说话的你叫起来；平常记的不要加",
  },
  noted: "记下了。",
};

// modules/media
export const voice = {
  description: "把一段话变成你的语音条（Fish Audio），返回 ogg 文件的路径；再用 message 发出去（media 填这个路径、asVoice=true）。一行一句，行内的空格当逗号，停顿会自动补。",
  params: {
    text: "要说的话",
    voice: "音色：配置里的音色名或 Fish 音色 id；不写用默认的",
  },
};

export const watch_video = {
  description: "看一个视频（B站或 YouTube 链接）：信息、弹幕高能时刻、一张画面九宫格、前几分钟的台词，全在本机跑、不花钱。返回里的画面是图片路径，打开才看得见。听写越长越慢。",
  params: {
    url: "视频链接",
    minutes: "听前几分钟（默认 3）",
    noAudio: "true = 只看信息、弹幕和画面，最快",
    lang: "听写的语言：zh（默认）、en、ja，或 auto 自动识别",
  },
};

export const sticker = {
  /** The stickers module's weekly reminder */
  weeklyHunt: "该收表情包了（每周一次）：用 sticker 命令找几张新的（browse 按情绪分类、search 按番名或角色、grab 给图片网址），inbox 里一张张看过，好的 add 收进库、不要的 reject。这周不想收就跳过。",
  description: "发表情包：按情绪从你的表情库里挑一张发出去，默认发给正在跟你聊的人（图先到，你的话紧跟着到）。" +
    "也可以用 ref 指定发哪几张（库里的 id，或 stickers 目录里的图片路径）。收集、整理表情还是照 stickers 技能用 sticker 命令。",
  params: {
    mood: "情绪词，几个用空格隔开，比如「开心 得意」",
    ref: "指定发哪几张：库里的 id（s012）或 stickers 目录里的图片路径",
    to: "发给谁：不写就是正在跟你聊的人；也可以写人名（如 {{owner}}）、+61…、qqbot:c2c:…",
    channel: "不写就跟着对话走",
  },
  noChat: (channels: string): string => `现在没在 ${channels} 上跟谁聊，要发给谁写 to（人名或号码）。`,
  channelMismatch: (want: string, label: string, channel: string): string => `${want} 是 ${label} 的号，跟 channel=${channel} 对不上。`,
  noHandle: (who: string | undefined, label: string): string => `不知道${who ?? "对方"}的 ${label} 号。`,
  needMoodOrRef: "写个情绪词（mood），或者用 ref 指定发哪张。",
  pickFailed: (summary: string): string => `表情包没挑出来：${summary}`,
  pickErrors: (errors: string[]): string => `表情包没挑出来：${errors.join("；")}`,
  noMood: (mood: string, nearest: string[] | undefined): string => `库里没有「${mood}」这种情绪的表情，这次不发${nearest?.length ? `（接近的有：${nearest.join("、")}）` : ""}。`,
  failedItem: (name: string, why: string): string => `「${name}」${why}`,
  heldBack: (names: string[]): string => `${names.map((x) => `「${x}」`).join("")}先没发（前一张还没确认发出去）`,
  sentRecord: (name: string): string => `[表情包：${name}]`,
  who: (name: string, label: string): string => `${name}（${label}）`,
  sent: (dryRun: boolean, names: string[], who: string): string => `${dryRun ? "（模拟发送）" : ""}发出去了：「${names.join("」「")}」→ ${who}`,
  rerouted: "QQ 那边一个小时内没来消息，回复窗口过了，改发了 WhatsApp",
  notSent: (failed: string[]): string => `没发出去：${failed.join("；")}`,
  sep: "。",
};

export const browser = {
  /** what {logins} in the description becomes when the role's config has no browser.logins */
  loginsDefault: "你登过的网站会一直登着",
  description:
    "你自己的 Chrome（{logins}），逛网页、看要登录的网站、在网页上操作都用它。一步一个动作：\n" +
    "- open（url，开新标签页）/ navigate（url，当前页跳过去）/ back / tabs（看开着哪些，t1 t2…）/ focus（tab，换到那一页）/ close（tab，不写就关当前页）\n" +
    "- snapshot：看页面结构，能点的东西带 ref（e12 这种）；页面变了 ref 就要重新看\n" +
    "- click（ref 或 selector；或者 x、y 按坐标点）/ type（ref 或 selector + text，submit=true 顺手按回车；slowly=true 一个字一个字敲）/ press（key，比如 Enter、PageDown）\n" +
    "- evaluate（js：表达式、`() => …` 函数、或者几句语句（要结果写 return）都行）\n" +
    "- screenshot（full=true 整页；给 ref 只截那一块）：存成图片，用 Read 看\n" +
    "- upload（files 文件路径列表；ref 或 selector 指上传框，不写就找页面上第一个上传框）/ wait（ms 毫秒，或者等 text 出现）\n" +
    "- status / start / stop（关掉整个浏览器腾内存，下次用会自己再开）\n" +
    "tab 不写就是你刚才在用的那一页。",
  clipped: (head: string, rest: number): string => `${head}\n…（还有 ${rest} 字没显示）`,
  where: (id: string, title: string, url: string): string => `${id}「${title || "（没标题）"}」${url}`,
  noBrowser: "这里没有浏览器。",
  timedOut: (seconds: number): string => `没做成：浏览器 ${seconds} 秒没反应（页面可能卡住了）。先 tabs 或 screenshot 看看，必要时 close 这一页再来。`,
  notRunning: "浏览器没开（用的时候会自己开）。",
  running: (tabs: number): string => `浏览器开着，${tabs} 个标签页。`,
  started: "浏览器开好了。",
  alreadyRunning: "浏览器本来就开着。",
  stopHeld: (others: ReadonlyArray<{ who: string; tab: string }>): string => `先没关：${others.map((o) => `${o.who === "main" ? "前台" : "另一份心思"}在用 ${o.tab}`).join("、")}（十分钟内还用过），现在关会打断它。等它用完，或者只 close 你自己那页。`,
  stopped: "浏览器关了。",
  alreadyStopped: "浏览器本来就没开。",
  noTabs: "没有开着的标签页。",
  currentMark: "→ ",
  opened: (where: string): string => `开好了：${where}`,
  closeWhich: "你现在没在用哪一页，要关哪页写 tab（tabs 看开着哪些）。",
  closed: (id: string): string => `关了 ${id}。`,
  nowAt: (where: string): string => `现在在 ${where}`,
  navigateNeedsUrl: "navigate 要写 url。",
  arrived: (where: string): string => `到了：${where}`,
  wentBack: (where: string): string => `退回到：${where}`,
  clickNeeds: "click 要写 ref、selector，或者 x 和 y。",
  clicked: (where: string): string => `点了。现在在 ${where}`,
  typeNeeds: "type 要写 ref 或 selector，还有 text。",
  typedSubmitted: (where: string): string => `输入了，按了回车。现在在 ${where}`,
  typed: "输入了。",
  pressNeedsKey: "press 要写 key。",
  pressed: (key: string): string => `按了 ${key}。`,
  evaluateNeedsJs: "evaluate 要写 js。",
  evaluatedNothing: "跑完了（没有返回值）。",
  shot: (file: string): string => `截好了：${file}（用 Read 看）`,
  uploadNeedsFiles: "upload 要写 files。",
  uploaded: (files: string[]): string => `传上去了：${files.join("、")}`,
  textAppeared: (text: string): string => `「${text}」出来了。`,
  waited: "等好了。",
  unknownAction: (action: string): string => `不认识的动作：${action}`,
  refGone: (ref: string | undefined): string => `没做成：找不到 ${ref}（页面变过了，先 snapshot 重新看）。`,
  navigatedAway: (message: string): string => `页面中途跳转了，刚才的动作多半已经生效：先 tabs 或 screenshot 看看现在在哪，别急着再做一遍。（${message}）`,
  failed: (message: string): string => `没做成：${message}`,
};

export const mem = {
  failed: (message: string): string => `没做成：${message}`,
  threw: (message: string): string => `没做成：${message}`,
  time: "时间：2026-10-29 21:30（{{ta}}的时区）或 2026-10-29",
  people: "这一条里出现的每个人（群里说话的群友一个个写），用工作单第 8 节名单上的名字；你自己不写",
  noTemplate: "人物卡模板没配置（HH 配置 memory.people.template）：人物卡没开，调用会被拒。",
};

export const newEvent = {
  title: "几个字的名字",
  summary: "总结：这件事现在是什么样、走到哪了（第一人称、省略主语，两三句到一段）",
  gist: "一句话版本（≤80 字）",
  why: "为什么重要（重要度 4–5 必填）",
  importance: "0–5：5 核心（塑造人格）、4 很重要、3 值得记、2 普通、1 小事、0 无所谓",
  pinned: "〔不淡〕",
  entities: "有谁、关于什么：[{name, kind: person 人 / group 群 / work 作品 / thing 东西 / place 地方, role: with/about/by/where}]（事和项目是事件，不写成东西；你自己不写）",
  next: "有日子的事：下次要做或到期的那天 YYYY-MM-DD（考试、截止、约好的日子）；中期里到那天之前一直列着",
  parent: "属于哪件大事（父事件编号，如 e0013）：大事下面挂子事件，最多三层",
  stance: "喜欢 / 烦的事（{{owner}} 11-03）：记的是我和一个东西（作品、角色、一类内容）的关系，挂上那个东西；经过写每次被打动的那一下（kind=feeling）；写法、气质这类本质不建事件，进 soul/30 的口味",
};

export const learn_worklist = {
  description: "今晚学习这一块要看的：哪些页白挂了、哪些错没想起来、{{owner}} 的纠正、做成的事、该删减或降级的。",
  // 没接学习（笔记本没开）时回的话
  off: "笔记本没开，今晚没有学习的工作单。",
};

export const learn_check = {
  description: "今晚要进笔记本的新东西（做成的事、补记的做法、新教训），先交给把关看。看完会把结论告诉你，照结论写提案。",
  params: {
    page: "页编号；新页写打算放的路径",
    evidence: "依据：任务、编号、原话",
  },
  // 没接学习（笔记本没开）时回的话
  off: "笔记本没开，今晚没有把关。",
};

export const remember = {
  description: "想起事情：给一句话或一个线索，一次想起相关的一串事（顺着关联带出相关的），每件带编号，想细看用 recall_event 展开。可以限定和谁有关（who）、时间段（from/to）。",
};

export const recall_person = {
  description: "一个人：先是你记得的他/她（人物卡里公开的部分），再是和他/她有关的最近几件事，每件附上和这个人有关的最近几条经过。",
  params: {
    who: "人名，如 {{owner}}",
  },
};

export const recall_event = {
  description: "展开一件事细想：总结、完整的时间线（越久没碰的写得越简略，展开一次就重新变清楚）、相关的人和事、出处原话。ref 写事件编号（e0040）、条目编号（n00123）、原话编号（q123）、记忆里的编号（#123）或标题；from/to 只看某段时间。",
};

export const recall_period = {
  description: "按时间段翻：那段时间发生过、有进展的事一件一行（不靠搜索，搜不到的也翻得到）。when 写 今天、昨天、上周、这个月、最近7天、10-20 到 10-27；时间段太长先按周给，再挑一周细翻。",
};

export const like = {
  // like 的说明（不超过 6 行）。只讲机制（框架是通用的，用它的这个角色只是一个实现）：什么算一个东西、接在哪件上这类做法是她自己的，写在她的技能书里，不写死在工具里
  description: [
    "喜欢上、烦上一个东西，或者对喜欢 / 烦的东西有了新感受、腻了、又喜欢上了，用它当场记进记忆；记错了能改（fix）、能撤（drop）。",
    "how：like 喜欢上 / dislike 烦上（没有就新建一件）；feel 又有一下感受；over 腻了 / 不烦了；again 又喜欢上（又烦上）；fix 改标题、一句话；drop 记错了、不算数。",
    "按 what 找已有的那件：名字完全一样才自动接上；只是像的不写，列出最像的让你用 event 挑。",
    "知道编号就直接写 event（「最近这一段」里的「最近喜欢的」和 my_likes 里都有编号）。",
    "new=true 只配 like / dislike：不找了，单独新建一件。",
    "fix、drop 要写 why，不用 feeling；其余几种要写 feeling。",
  ].join("\n"),
  params: {
    what: "那个东西（作品、角色、一类内容），如《史记》、会长、评论区接梗的短帖",
    how: "like 喜欢上了；dislike 烦；feel 已经喜欢 / 烦着的再加一句感受；over 腻了 / 不烦了；again 又喜欢上（又烦上）了；fix 改标题、一句话；drop 记错了、不算数",
    feeling: "这一下的感受和为什么，用自己的话（fix、drop 以外必填）",
    title: "fix：新标题（没带「喜欢 」「烦 」会按这件补上）",
    gist: "fix：新的一句话（≤80 字）",
    why: "fix、drop：为什么改 / 为什么不算数（必填）",
    event: "已有那件的编号（如 e0158）：写了就直接接在它上面",
    importance: "只在新建时用，默认 3（0–5，和事件同一把尺子）",
    new: "只对 like / dislike：不找已有的，直接单独新建一件（名字只是像、其实是另一个东西时用）",
  },
};

export const my_likes = {
  description: "看我喜欢 / 烦的全部，包括腻了的。",
  params: {
    page: "第几页，从 1 开始（一页列不完，末尾会说还有几件）",
  },
};

export const mem_worklist = {
  description: "夜里整理：某一天的事件库工作单（还没进库的原话、今天有进展的事、疑似重复、可能的关联、有更正没改总结的、人和东西、人物卡）。",
};

export const mem_event_create = {
  description: "夜里整理：新建一件事（之后用 mem_entry_add 把经过一条条接上去）。",
};

export const mem_event_update = {
  description: "夜里整理：改一件事的总结、一句话、状态、重要度、why、下次的日子等（旧的会留档）。时间线不能改。",
  params: {
    next: "下次的日子 YYYY-MM-DD；过了换下一个，没有了写空字符串",
    parent: "挂到哪件大事下面（父事件编号）；写空字符串就不再属于哪件",
    stance: "喜欢 / 烦；写空字符串清掉",
    reason: "为什么改",
  },
};

export const mem_entry_add = {
  description: "夜里整理：给一件事的时间线加一条经过。full 是完整经过（带关键原话，标明谁说的），写入后不再改；gist 一句话、title 几个字也一起写好；people 这一条里有谁；source 出处（c:<中央记忆序号>、q<原话编号>）。重复加同一条不会重复记。",
  params: {
    full: "导入时不用写：给出处编号就会用那一行原文",
  },
};

export const mem_entries_add = {
  description: "夜里整理 / 导入：一次给一件事加一串经过（每条的写法同 mem_entry_add）。逐条校验，坏的那条会说明原因，其余照样记上。",
  params: {
    full: "导入时不用写：给出处编号就会用那一行原文",
  },
};

export const mem_entry_correct = {
  description: "夜里整理：以前记错了——加一条更正（原条目保留，显示时写成「当时记的是 X，后来更正为 Y」）。",
  params: {
    id: "被更正的条目编号",
    why: "依据",
  },
};

export const mem_link = {
  description: "夜里整理：两件事有关系。rel：cause（a 导致 b）、followup（b 是 a 的后续）、same_thread（同一件事的不同阶段）、contrast（相似的事结果不同）、supersedes（b 替换 a）、related（其他，要写 note）。",
};

export const mem_unlink = {
  description: "夜里整理：拆掉一条关联。",
};

export const mem_merge = {
  description: "夜里整理：几件其实是一件事——时间线并到 keep 上，其余标成被替换。",
};

export const mem_supersede = {
  description: "夜里整理：事实变了——旧的那件保留，标成被新的替换。",
};

export const mem_retire = {
  description: "夜里整理：这件事不再算数（还能显式找到）。",
};

export const mem_day_done = {
  description: "夜里整理：这一天的事件库整理做完了。",
};

export const mem_split = {
  description: "夜里整理：把这几条经过挪到新的一件事里。under=true：大事拆成小事，新的一件挂在原来那件下面当子事件；不写：一件事里其实是两件，两件标成同一件事的不同阶段。",
  params: {
    under: "true：新的一件当原来那件的子事件",
  },
};

export const mem_entity_upsert = {
  description: "夜里整理：登记或补充一个人/东西：种类、别名、对应的人物档案 key、一句话备注（他是谁、怎么认识的）、重要度。人、群、作品、东西、地方才登记；事和项目是事件。每个都要有重要度。",
  params: {
    kind: "person 人 / group 群 / work 作品（番、书、视频） / thing 东西 / place 地方",
    importance: "0–5，和事件同一把尺子：5 核心（{{owner}} 这样的）、4 很重要（家人、最亲近的朋友）、3 常打交道、2 认识、1 见过一两次、0 无所谓",
    why: "为什么重要（重要度 4–5 必填）",
    remove_aliases: "去掉这些别名（比如群友被写成了群的别名，要单独登记成人）",
  },
};

export const mem_entity_merge = {
  description: "夜里整理：几个登记其实是同一个人/东西：挂法都挪到 keep 上，名字变成别名，重要度取最高。",
};

export const mem_entity_tag = {
  description: "夜里整理：已有的事件或经过上漏写了谁（或什么）：挂上去。经过的原文不动。",
  params: {
    to: "事件编号（e0128）或经过编号（n01421）",
    role: "挂到事件上时：with 一起 / about 关于 / by 谁做的 / where 在哪",
  },
};

export const mem_entity_drop = {
  description: "夜里整理：不该登记的（其实是一件事、是你自己、是系统零件）去掉登记；事件和经过本身不动。名单上的人去不掉。",
};

export const mem_person_set = {
  // 开头讲机制，后面接模板生成的那一段（字段、原话段、上限都从模板来，不写死）；没配模板就说一句（mem.noTemplate）
  description: [
    "夜里整理 / 导入：写人物卡的一个字段。who 写人或群（名字、别名、名单 key、编号都认）；section 写字段名；text 是这个字段的全部新内容，替换旧的（旧的留档）。",
    "text 写空 = 清掉这个字段（要写 why）。夜里大改会存成待批，人批了才换；导入那一跑不按大改等批（等不等批、为什么、要谁批，回话都会说）；回话还会说这个字段和整张卡现在多大。",
  ].join("\n"),
  params: {
    who: "人或群：名字、别名、名单 key 或编号",
    section: "字段名（照模板）",
    text: "这个字段的全部新内容；写空 = 清掉",
    why: "为什么这样写 / 为什么清掉（清掉必填）",
    sources: "依据：库里真有的事件 e…、经过 n…、原话 q… / #… / c:…（至少一个）",
  },
  notWritten: "没写进去：",
};

export const mem_quote_pin = {
  description: [
    "夜里整理 / 导入：把原话层里的一句钉到人物卡的原话段。quote 写原话编号 q123，或中央记忆序号 #123 / c:123；只钉其中一段就写 text（要和原话一字不差）。",
    "只加不删，没有拿掉的工具：能换的原话段满了用 replaces 写要换下来的那一行（i0013），换下来的那句还在原话层。",
    "private：名单上、不是主人的人默认私聊（只在他自己那一面），写 false 公开；主人、不在名单上的人都公开。",
  ].join("\n"),
  params: {
    who: "人或群：名字、别名、名单 key 或编号",
    section: "原话段名（照模板）",
    quote: "原话编号 q123，或中央记忆序号 #123 / c:123",
    text: "只钉其中一段：原话里一字不差的那一段；不写就整句",
    why: "为什么钉这句",
    private: "名单上、不是主人的人默认 true（私聊）；写 false 公开",
    replaces: "满了要换下来的那一行（i0013）：只给能换的原话段用",
  },
  notPinned: "没钉上：",
};

export const workspaceGit = {
  failed: (summary: string): string => `\n（改是改好了，git 没记上：${summary}）`,
};

export const deliver = {
  unsure: (why: string): string => `不确定发出去没有（${why}）：先别重发，过一会儿看看对方收没收到`,
  dryRun: (channel: string, target: string): string => `（模拟发送）${channel} → ${target}`,
  noGateway: "没有网关连接，发不出去。",
  noChannel: (channel: string, connected: readonly string[]): string =>
    connected.length ? `没有接「${channel}」这个通道，发不出去。现在接着的通道：${connected.join("、")}。` : `没有接「${channel}」这个通道，发不出去：现在一个通道都没接。`,
  refused: (code: string, message: string): string => `网关没发出去：${code} ${message}`,
  unreachable: (message: string): string => `连不上网关，没发出去：${message}`,
  refusedAfterRecheck: (code: string, message: string): string => `网关没发出去：${code} ${message}（超时后查过一次）`,
  stillSilent: (first: string, message: string): string => `${first}；超时后用同一个编号又查了一次，还是没有回音：${message}`,
  noBridge: (channel: string, message: string): string => `「${channel}」的桥没在跑，没发出去：${message}`,
  bridgeSilent: (channel: string): string => `「${channel}」的桥没有回音`,
  offline: (channel: string): string => `「${channel}」现在没连上（桥在重连），没发出去。`,
  badTarget: (target: string): string => `看不懂这个收件人：${target}`,
  sendFailed: (message: string): string => `没发出去：${message}`,
  /**
   * The line a bridge adds for each file it saved from a message. It must open with a bracket and a label followed by a
   * colon: from that opening the bridge tells what a person typed to look like one (src/channels/bridge.ts withAttachments).
   */
  attachmentLine: (path: string): string => `[附件: ${path}]`,
};

export const computer = {
  description: "操作这台 Mac（屏幕、鼠标、键盘、App）。优先按窗口和按钮操作：list_apps → launch_app → get_window_state → 对按钮 left_click（带 windowRef/elementRef），按坐标点只作兜底（先 screenshot，带上它回的 displayFrameId）。action 还有 type（text）、key（keys）、scroll、bring_to_front、list_windows、get_accessibility_tree、screenshot（图存成文件，用 Read 看）。其余参数放 params。窗口、按钮的引用和截图帧闲几分钟会作废，作废了重新看一遍。",
  noGateway: "现在连不上网关，操作不了电脑。",
  noNode: "找不到能操作的电脑（Mac 节点没连上）。",
  locked: "电脑锁屏了，现在操作不了（要 {{owner}} 解锁）。",
  busy: "电脑正被别的程序占着（它的 computer 还没收）。等几分钟再试；一直这样，要管这台电脑的人重启 Mac 上的 OpenClaw。",
  failed: (message: string, closeFailed: boolean): string => `没做成：${message}${closeFailed ? "（上次收尾也没成功：要是一直报这个，多半要管这台电脑的人重启 Mac 上的 OpenClaw）" : ""}`,
  imageSaved: (file: string): string => `[图片存到了 ${file}，用 Read 看]`,
};

export const message = {
  /** {{channels}}: the role's channels as people call them (channelLabel), in name order */
  description: "发消息（{{channels}}，经 OpenClaw 发出）。action=send；一句一条地发；图片、语音用 media。",
  channelLabel: (name: string): string => (name === "qqbot" ? "QQ" : name === "whatsapp" ? "WhatsApp" : name),
  params: {
    target: "收件人：直接写人名（如 {{owner}}）就行；也可以写 qqbot:c2c:<openid>、+61…",
    message: "文字",
    media: "图片 / 语音等文件路径",
    replyTo: "回复哪条消息（QQ 用）",
    asVoice: "media 是语音（ogg）时设 true，发成语音气泡",
  },
};

export const on_it = {
  description: "开始做一件事前说一声，顺便估一下大概要多久。开始以后先用 set_bar 定下做到什么样才算好。",
  params: {
    topic: "这件事的简短名字",
    about: "大概要多久，比如「3分钟」「半小时」「两小时」",
    pri: "多急：T0 现在就要做、T1 今天、T2 这几天、T3 有空再做",
  },
};

export const set_bar = {
  description: "定下手上这件事做到什么样才算好（开始做时先定）。按估的时间定分量，写成能核对的样子：要回答哪些问题、要拿到哪些证据、交出去的东西长什么样。说做完时你会对照它回头看。中途要改，写上为什么改。",
  params: {
    bar: "做到什么样才算好",
    why: "改标准时：为什么改",
    topic: "手上不止一件时，写是哪件",
  },
};

export const done_with = {
  description: "这件事弄完了（和 on_it 配对）。说之前先自己对照开头定的标准查一遍；说完你会回头再仔细看一遍，没到会知道还差什么、接着做，到了才算完。" +
    "基本做完、只剩以后跟进的，state 写「只剩跟进」。卡在自己绕不过去的事上（等人拍板、等别人交东西），能做的先做完，state 写「卡住了」、on 写卡在什么上：回头看确认真卡住了就先放下，记进待办账本，等到了再接着做。",
  params: {
    on: "卡住了的话：卡在什么上，比如「等 {{owner}} 挑配音版本」",
  },
};

export const mull_over = {
  description: "这件事只要结果、不用你亲自细看（读论文、查清一件事、把一个问题想透），就放着慢慢想，想通了答案会自己冒出来。",
  params: {
    what: "要什么结果，写清楚",
  },
};

export const think_it_over = {
  description: "这个得好好想想：把你注意到的事交给正经思考（不是交给别人，是你自己认真对待它）。",
  params: {
    what: "你注意到了什么、为什么值得想，一两句",
  },
};

export const ack = {
  description: "确认一条感官动静已经处理完（就是原文里让你运行的 senses --ack <id>）。只 ack 你顺手处理掉的小事；交给 think_it_over 的不要 ack。",
  params: {
    id: "原文里 --ack 后面那串 id",
  },
  badId: "id 看起来不对：照原文 --ack 后面那串抄。",
  acked: "好，确认了。",
  failed: (summary: string): string => `没确认上：${summary}`,
};

export const goals = {
  description: "你的目标系统（goals 命令）。args 是命令行参数，比如 [\"ls\"]、[\"log\",\"g3\",\"推进了…\"]、[\"add\",\"today\",\"标题\",\"--why\",\"…\",\"--done-when\",\"…\"]。",
  topicWithWhy: (title: string, why: string): string => `${title}：${why}`,
};

export const hands = {
  description: "手脚：派 Claude Code 干重活（写代码、剪视频、长研究）。action=send 派活或接着说；show 看它回了什么；ls 看有哪些、谁还在干活；stop 叫停它（不要它了、它卡住了）。" +
    "派给帮手的事，要等它交回、你核过、真交出去了才算做完。",
  sendNeeds: "send 需要 name 和 text。",
};

export const recall = {
  description: "想起原话：[\"search\",\"关键词\",\"--who\",\"{{owner}}\"]、[\"day\",\"2026-10-28\"]、[\"around\",\"<序号>\"]、[\"show\",\"<序号>\"]（某一条的全文，比如记忆里折起来、截断的那条；太长时按提示加 \"--from\",\"<从第几个字>\" 往下看），可加 [\"-n\",\"20\"]。先逐字找，找不到再按意思找（包括 10-08 以来所有的旧原话）。想起一件事的来龙去脉用 remember / recall_event。",
  withMore: (local: string, more: string): string => `${local}\n（还有这些原话：）\n${more}`,
  dayNone: "那天没找到原话。",
  searchNone: "没找到。换个说法，或者用 remember 按意思想起相关的事。",
  none: "没找到。",
  honchoDown: (summary: string): string => `自己的记忆里没找到；Honcho 现在也查不了（${summary}）。`,
};

export const what_do_i_know = {
  description: "拿不准、想找全的时候：给一件事，把笔记里相关的页和以前做过的类似的事一次列出来。",
  params: {
    category: "只看哪个大类，不写就全部",
  },
  none: "笔记里还没有这类事的记录。",
  unreadable: "笔记这会儿翻不了（判断服务没回来），直接去 skills/ 里找。",
  categoryMissing: (category: string, names: readonly string[]): string =>
    `没有「${category}」这个大类。${names.length ? `书架上的大类：${names.join("、")}。` : ""}`,
};

export const schedule = {
  timeUnreadable: (when: string): string => `时间看不懂：${when}（写 +40m、+2h、15:00 或完整时间）`,
  today: "今天",
  tomorrow: "明天",
  everyUnreadable: (every: string): string => `循环看不懂：${every}（daily、30m、2h）`,
  everyTooShort: "循环最短 30 分钟",
};

/** 记了「今天做过了」不叫的是哪些：每天的就是今天这一次，几小时一次的是今天剩下的全部 */
const skippedToday = (everyMs: number): string => (everyMs >= 86_400_000 ? "今天这次" : "今天剩下的都");

const everyText = (ms: number): string => (ms === 86_400_000 ? "每天" : ms % 3_600_000 === 0 ? `每 ${ms / 3_600_000} 小时` : `每 ${Math.round(ms / 60_000)} 分钟`);

export const remind = {
  description: "给自己排提醒，或者排一段专注（像上班）。kind=focus：这段时间里你一直醒着做事，不睡、不停，每做完一轮马上接着做；minutes 写多久（默认 30），text 写这段要干嘛、为什么。when：now、+40m、+2h、15:00（今天，过了就明天）或完整时间；every：daily / 30m / 2h（不写就只来一次）。",
  params: {
    done_today: "循环提醒：这件今天已经做过了就加 done_today: true，今天这次不叫（几小时一次的，今天剩下的都不叫）",
  },
  repeating: (id: number, every: number, firstLabel: string, skipped: boolean, firstToday: boolean): string =>
    `排好了（#${id}），${everyText(every)}，第一次是${firstLabel}${skipped ? `（今天做过了，${skippedToday(every)}不叫）` : ""}。` +
      (firstToday ? `今天已经做过的话用 reminders done #${id}，${skippedToday(every)}不叫。` : ""),
  once: (id: number, at: string, minutes: number | null, every: number | null): string =>
    `排好了（#${id}），${at}${minutes ? ` 起专注 ${minutes} 分钟` : ""}${every ? "，循环" : ""}。`,
};

export const reminders = {
  description: "看和取消你排好的提醒、专注：action=ls 列出还没到点的（带编号）；action=cancel 按编号取消（id）；action=done 按编号记下一个循环提醒今天已经做过了：每天的今天这次不叫，几小时一次的今天剩下的都不叫，明天照常。想改时间就取消了再用 remind 重新排。{{owner}} 排的不能自己取消，要先问他。",
  line: (x: { id: number; at: string; everyMs: number | null; doneAt: string | null; kind: "remind" | "focus"; minutes: number | null; text: string }): string =>
    `#${x.id} ${x.at}${x.everyMs ? `（${everyText(x.everyMs)}）` : ""}${x.doneAt !== null ? `（今天已做 ${x.doneAt}）` : ""} ${x.kind === "focus" ? `专注 ${x.minutes ?? 30} 分钟` : "提醒"}：${x.text}`,
  list: (lines: string[]): string => `排着的（${lines.length} 个）：\n${lines.join("\n")}`,
  none: "现在没有排着的提醒。",
  needsId: (action: unknown): string => `写上要${action === "done" ? "记做过了" : "取消"}的编号（先 action=ls 看）。`,
  noSuch: (id: unknown): string => `没有 #${id}（可能已经到点了，或者取消过了）。`,
  onceOnly: (id: number): string => `#${id} 只来一次，不用记做过了：做过了就用 action=cancel 取消它。`,
  focusNotDone: (id: number): string => `#${id} 是专注，「今天做过了」只用在循环提醒上；今天这段不想上就先 cancel，再用 remind 重新排。`,
  doneSkips: (id: number, everyMs: number, nextLabel: string): string => `记下了：#${id} 今天做过了，${skippedToday(everyMs)}不叫；${nextLabel} 照常。`,
  doneNothingLeft: (id: number, nextLabel: string): string => `记下了：#${id} 今天做过了（今天已经没有要叫的了）；${nextLabel} 照常。`,
  ownerSet: (id: number): string => `#${id} 是 {{owner}} 排的，要取消先问他。`,
  cancelled: (id: number, text: string): string => `取消了 #${id}（${text}）。`,
};

const VERB: Record<string, string> = { add: "加", edit: "改", remove: "删", move: "挪" };
const DONE: Record<string, string> = { add: "加上了", edit: "改好了", remove: "删了", move: "挪好了" };

export const what_reaches_me = {
  description: "看和改：外面的动静哪些会到我面前、哪些我扫一眼就放下。固定的那些（{{owner}}、认识的人私聊、@我、要我处理的、帮手、提醒、目标）改不了。改之前可以用 try 拿过去几天的真动静试一下。",
  params: {
    rule: "一条规则：{ id, match, action, when?, want?, note? }。match 里可以写 src（来源，可以几个）、conv（会话名）、sender（谁说的）、known（认不认识）、isGroup、mentionsMe、keywords（出现任一个就算）、regex。" +
      "edit 只写要改的字段（写 null 删掉那个字段）；try 带上就是试「加上 / 改成这条以后」",
    id: "要改、删、挪、试的那条规则的 id",
    to: "move：挪到第几条（从 0 数）；add / try 新加的放第几条，不写放最前面",
    days: "try 拿过去几天的动静，默认 7",
  },
  fixedLine: "固定的那些（{{owner}}、认识的人私聊、@我、要我处理的、帮手、提醒、目标）改不了，总是先看它们；都没对上的按 judge now、默认的标准。",
  ruleLegend: "action：main 直达、judge 交给判断、digest 进总结、drop 丢；when：now 马上、work 和手头的事有关时、leisure 放空时；ifUnsure（只对 judge 有用）：判断说值得看但拿不准时，main 照样直达（不写就是这样）、digest 进总结。",
  gateOff: "下意识规则现在没开（闸门关着），改了也不起作用。",
  listUnreadable: (error: string): string => `规则文件现在读不了（${error}），用的是上一份能用的：`,
  ruleBroken: (i: number, id: unknown, error: string): string => `${i}. ${String(id ?? "（没 id）")}：没生效（${error}）`,
  listHead: (fresh: boolean): string => `从上往下，第一条对上的算（编号从 0 数）${fresh ? "；还没有规则文件，现在没有规则（都交给下意识判断）" : ""}：`,
  addNeedsRule: "add 要带 rule（一整条：id、match、action，可选 when、want、ifUnsure、note）。",
  editNeedsIdRule: "edit 要带 id 和 rule（只写要改的字段，写 null 删掉那个字段）。",
  removeNeedsId: "remove 要带 id。",
  moveNeedsIdTo: "move 要带 id 和 to（挪到第几条，从 0 数）。",
  unknownAction: (action: string): string => `不认识 ${action}。`,
  fileUnreadable: (error: string): string => `规则文件现在读不了（${error}），先别用工具改：把文件修好（或者告诉 {{owner}}）。`,
  notChanged: (error: string): string => `没改：${error}`,
  notWritten: (message: string): string => `没写成：${message}`,
  commit: (action: string, id: string): string => `下意识规则：${VERB[action]} ${id}`,
  changed: (action: string, id: string, at: number, git: string): string =>
    `${DONE[action]} ${id}${action === "remove" ? "" : `（现在是第 ${at} 条，从 0 数）`}。${git}`,
  currentRules: "现在的规则",
  tryFailed: (error: string): string => `试不了：${error}`,
  afterEdit: (id: string): string => `把 ${id} 改了以后`,
  afterAdd: (id: string, at: number): string => `加上 ${id}（第 ${at} 条）以后`,
  noSuchRule: (id: string): string => `没有 ${id} 这条规则（先 list 看看）。`,
  noEvents: "读不到 senses/events.jsonl，没法试。",
  clipped: (head: string): string => `${head}…`,
  tried: (days: number, count: number, what: string): string => `拿过去 ${days} 天的 ${count} 条真动静试了（${what}）：`,
  bucket: (outcome: string, count: number, examples: string[]): string => `${outcome} ${count} 条${count ? `：${examples.join("｜")}` : ""}`,
  caught: (id: string, count: number): string => `${id} 接住了 ${count} 条。`,
  underCurrent: (counts: ReadonlyArray<readonly [string, number]>): string => `现在的规则下是：${counts.map(([o, n]) => `${o} ${n}`).join("、")}。`,
  tryOnly: "只是试：规则没改，也没真去判断。",
};

export const people_i_know = {
  description: "我认识的人的名单：谁、在各个平台叫什么。加了的人私聊会直接到我面前。最多给到和{{ordinary}}一样的权限；更多的（信任、共享文件、能用别的脚本）要问 {{owner}}。",
  params: {
    key: "名单里的 key；add 不写就按名字起",
    entry: (cardDir: string): string =>
      "这个人：{ name, handles: { wx: [微信备注], xhs: [小红书昵称], bili: [B站昵称] }, senders: [QQ openid / 手机号], aliases, … }。" +
      "update 只写要改的字段（handles 按平台合并；写 null 删掉那个字段）。" +
      `profile：人物卡由夜里整理写进事件库，导出在 ${cardDir}/<key>.md，不用填`,
  },
  ownerOnly: "{{owner}} 那条我不能动（要改问 {{owner}}）。",
  noBook: "名单现在改不了（没接上名单文件）。",
  ownerTag: "改不了",
  listLine: (key: string, name: string, tags: string[], handles: string): string => `${key}：${name}（${tags.join("，")}）${handles}`,
  list: (lines: string[]): string => `名单（${lines.length} 个人）：\n${lines.join("\n")}`,
  listEmpty: "名单是空的。",
  ownerForbidden: "谁都不能写成 owner：只有 {{owner}} 是。",
  fileUnreadable: (error: string): string => `名单文件现在读不了（${error}），先别用工具改：把文件修好（或者告诉 {{owner}}）。`,
  keyBad: (key: string): string => `key 不对：${key || "（空的）"}（不能空、不能以 _ 开头、不能有空格）`,
  addNeedsEntry: "add 要带 entry（至少写 name）。",
  addNeedsName: "add 要写 name。",
  addExists: (key: string, name: string): string => `名单里已经有 ${key}（${name}）了：是同一个人就用 update，不是就换个 key。`,
  addRefused: (problem: string): string => `没加：${problem}`,
  addClash: (clash: string): string => `没加：${clash}。`,
  addedLine: (name: string, ids: string): string => `加了 ${name}${ids ? `（${ids}）` : ""}`,
  added: (key: string, name: string, ids: string): string => `加好了：${key}（${name}${ids ? `；${ids}` : ""}）。`,
  updateNeedsKeyEntry: "update 要带 key 和 entry（只写要改的字段；handles 按平台合并；写 null 删掉那个字段）。",
  updateNoKey: (key: string): string => `名单里没有 ${key}（先 list 看看）。`,
  updateRefused: (problem: string): string => `没改：${problem}`,
  updatePending: (name: string, ids: string[]): string => `没改：${name} 身上有没批过的号或显示名（${ids.join("、")}），先删掉它或者等 {{owner}} approve。`,
  updateClash: (clash: string): string => `没改：${clash}。`,
  updateAskOwnerIds: (name: string, asks: string[]): string => `没改：这个要问 {{owner}}：给 ${name} 加号/加名字（${asks.join("、")}）。`,
  updateAskOwner: (lost: string[]): string => `没改：这个要问 {{owner}}：${lost.join("、")}`,
  updateSame: "和原来一样，没有要改的。",
  updatedLine: (name: string, what: string[]): string => `改了 ${name}：${what.join("；")}`,
  updated: (key: string, what: string[]): string => `改好了 ${key}：${what.join("；")}。`,
  removeNeedsKey: "remove 要带 key。",
  removeNoKey: (key: string): string => `名单里没有 ${key}（先 list 看看）。`,
  removedLine: (name: string, key: string): string => `删了 ${name}（${key}）`,
  removed: (name: string, key: string): string => `删了 ${name}（${key}），以后不认得了。`,
  unknownAction: (action: string): string => `不认识 ${action}。`,
  droppedLine: (dropped: string[]): string => `；要问 {{owner}}：${dropped.join("、")}`,
  notWritten: (message: string): string => `没写成：${message}`,
  commit: (line: string): string => `名单：${line}`,
  droppedNote: (dropped: string[]): string => `\n这个要问 {{owner}}：${dropped.join("、")}（没写进去）`,
};

export const looked_again = {
  description: "回头看完了：到了没有（met），没到的话还差哪几条、下一步具体做什么（missing），凭什么这么判断（seen）。",
  ok: "好。",
};

export const checked = {
  description: "交结论：每条候选一个。i 是候选前面「第几条」的数；verdict 写 add（新增）、merge（并进已有的一条）或 reject（不收）。",
  params: {
    into: "并进哪条（教训编号或做法原文）",
    text: "新增或合并后的文字",
  },
  ok: "好。",
};
