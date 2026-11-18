// 完整输入：某个脑区这个会话完整收到了什么
export const prompt = {
  regionsLabel: "看哪个脑区",
  /** 每一行最右边那个数是什么（悬停） */
  sizeTitle: "按字数估的 token 数",
  // 系统提示的每一段叫什么（服务端按段的种类出；键是 prompt.ts 的 SegmentKind）
  segment: {
    cc: "Claude Code：{name}",
    boundary: "（缓存分界线）",
    runtime: "HH 运行说明",
    shelf: "书架目录",
    frame: "过渡句：你的人生",
    personaFile: "人格文件 {file}",
    memoryFile: "记忆文件 {file}",
    midterm: "中期记忆（事件库最近这一段）",
    compacted: "压缩记忆（这次醒来以后）",
    prefix: "HH 前缀",
  },
  // Claude Code 系统提示里认得的那几节（键是它的标签名）
  ccSection: {
    intro: "开场介绍", communication: "怎么跟人说话", pronouns: "代词", action_caution: "谨慎行事", surface: "运行环境",
    environment: "模型和产品信息", context_management: "上下文管理", system_messages: "系统消息", when_to_be_proactive: "什么时候主动",
    web_search: "联网搜索怎么用",
  },
  noThinking: "（思考内容没有返回）",
  // 顶上那一行：看的是哪个会话
  session: {
    label: "会话 {id}（{how}）",
    started: "{when} 开的",
    calls: "调用了 {n} 次模型",
    context: "上下文：第一次 {first} token，最近一次 {last}（模型报的）",
    others: "看这个脑区别的会话",
    option: "{when} 最后更新（{id}）",
  },
  heading: "{name}这个会话收到的全部内容",
  hint: "按发给模型的顺序：系统提示 → 工具 → 对话（Claude Code 的附件夹在对话开头）。条的长短按字数估的 token，加起来约 {total}；模型实际报的数在上面。点任何一行看原文。",
  // 组成条上的每一段，和它下面的图例
  group: {
    claudeCode: "Claude Code 自带说明",
    hhNote: "HH 运行说明和过渡句",
    persona: "人格和规矩",
    slow: "慢记忆（MEMORY、经历和教训、账本快照）",
    slowWithMid: "慢记忆（MEMORY、经历和教训、账本快照、中期视图）",
    fast: "快记忆",
    tools: "工具定义",
    attachments: "Claude Code 附件",
    firstMessage: "第一条消息",
    laterMessages: "之后的对话",
  },
  groupSize: "{name}：约 {size} token",
  // 上下文怎么涨的那张小图
  growth: { title: "每次调用模型时的上下文大小", nth: "第 {n} 次" },
  system: { title: "一、系统提示", count: "{n} 段，约 {size} token", size: "{chars} 字，约 {size} token" },
  tools: { title: "二、工具（带完整定义）", count: "{n} 个，约 {size} token", selfPrefix: "self：", docSub: "工具说明和参数", params: "参数：" },
  deferred: { title: "三、先只给名字的工具", count: "{n} 个，用到时才加载完整定义", builtin: "Claude Code 自带", group: "{name}（{n}）" },
  attachments: {
    title: "四、Claude Code 塞进来的附件",
    count: "{n} 个，约 {size} token",
    asSystem: "以系统消息放进对话，约 {size} token",
    asUser: "以用户消息放进对话，约 {size} token",
  },
  // Claude Code 的附件是哪一种（键是 transcript 里的 type）
  attachmentType: {
    environment: "环境信息（工作目录、系统）", model: "模型", deferred_tools_delta: "先只给名字的工具（名单）", agent_listing_delta: "可用的子代理",
    mcp_instructions_delta: "MCP 服务器说明", skill_listing: "技能清单", auto_mode: "权限模式", session_context: "会话上下文（账号邮箱、git 状态）",
    context_sections: "上下文分节", date: "日期", remote_session_change: "远程会话变化",
    hook_additional_context: "工具调用后补进来的新记录", total_tokens_reminder: "上下文用量提醒",
  },
  messages: { title: "五、对话", count: "{n} 条，约 {size} token", size: "约 {size} token" },
  // 对话里每一行是什么
  messageLabel: {
    thinks: "{ta}想",
    uses: "{ta}用 {tool}",
    usesSomeTool: "{ta}用 工具",
    says: "{ta}说",
    toolError: "工具出错：{tool}",
    toolResult: "工具结果：{tool}",
    first: "第一条：角色说明和最近的经历",
    wakeWithContext: "叫醒{ta}（附处境和联想）",
    newRecords: "{ta}别处的新记录",
    newRecordsAndWake: "新记录 + 叫醒{ta}",
    wake: "叫醒{ta}",
  },
} as const;
