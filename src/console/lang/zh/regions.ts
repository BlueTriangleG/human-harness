// 脑区：叫什么、在大脑哪一块、干什么；中央记忆里一条记录是哪一种；事件库工具名后面带的一句说明
// （脑区的称呼和工具的中文名以后从 src/lang/ 里角色那边的包取，现在先放这里）
export const regions = {
  main: { name: "主意识", where: "前额叶", what: "{ta}自己：拿主意、跟人说话、动手做事。" },
  side: { name: "同时在做 {n}", where: "顶叶", what: "一边做的另一件事，和主意识随时同步。", group: "同时在做" },
  speech: { name: "随口", where: "布洛卡区", what: "快速的口头回应，只转述主意识定下的话。" },
  hippocampus: { name: "整理记忆", where: "海马体", what: "翻页和睡觉时，把这一段经历压成记忆。" },
  outer: { name: "外界", where: "脑干", what: "从外面进来的：别人的消息、感官事件、提醒。" },
  system: { name: "系统", where: "小脑", what: "自动发生的事：翻页、去睡觉、醒来。" },
  deep: { name: "慢慢想", where: "枕叶", what: "只要结论的事放在这里慢慢想透。过程不进主意识，结论作为{ta}自己想到的回来。" },
  // 11-04 以前的下意识脑区：已经不开了，中央记忆里只剩它当时的记录
  oldPerception: {
    name: "旧下意识",
    nameOf: "旧下意识（{stream}）",
    where: "已停用（11-04 起由闸门代替）",
    what: "11-04 以前的下意识脑区，这里只剩它当时的记录。现在感官事件先过闸门：点大脑上的「下意识」看。",
    whatOther: "另一路感官的旧下意识，这里只剩它当时的记录。",
  },
  // 下意识 = 闸门（丘脑）
  gate: {
    name: "下意识",
    where: "丘脑",
    what: "所有感官事件（消息、通知、提醒）先到这里。固定的几条路直接给{ta}；其余的由{ta}自己的规则和一个小判断定：马上给{ta}、进总结、还是放下。放下的进夜里的每日总结。",
  },
  kinds: { input: "收到", think: "想", say: "说", act: "做了", result: "结果", note: "记下", system: "系统" },
  tools: {
    recall: "翻原话", remember: "按意思想起", recall_person: "想起一个人", recall_event: "展开一件事", recall_period: "按时间翻", like: "记喜好", my_likes: "看喜好",
    mem_worklist: "夜里的工作单", learn_worklist: "学习的工作单", learn_check: "交给把关", mem_event_create: "建一件事", mem_event_update: "改一件事", mem_entry_add: "记一条经过", mem_entries_add: "记一串经过",
    mem_entry_correct: "更正一条", mem_link: "关联两件事", mem_unlink: "拆掉关联", mem_merge: "并成一件", mem_split: "拆成两件", mem_supersede: "标成后来变了",
    mem_retire: "标成不算数", mem_entity_upsert: "登记人和东西", mem_entity_merge: "并成一个", mem_entity_drop: "去掉登记", mem_entity_tag: "补挂人和东西", mem_day_done: "这一天整理完了",
  },
} as const;
