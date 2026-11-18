// 页面的壳：标题、左边的五页和每页里的视图、顶栏里她现在怎么样
export const shell = {
  title: "{me}的控制台",
  heading: "{me}",
  viewsLabel: "这一页里的几个视图",
  navLabel: "看什么",
  nav: { now: "对话", activity: "活动", memory: "记忆", notes: "笔记", run: "运行", machine: "这台电脑", settings: "设置" },
  views: { timeline: "时间线", gate: "闸门", events: "记得的事", prefix: "每轮带着的", input: "完整输入", permissions: "系统权限", roles: "角色", monitor: "监视台" },
  lang: { label: "界面语言", zh: "中文", en: "English" },
  /** the bell: hhd's warnings and errors, the same kind folded into one */
  notes: { label: "通知", markRead: "全部标为已读", unread: "{n} 条没读", times: "{n} 次", bellLabel: "通知（{n} 条没读）" },
  skip: { content: "跳到正文", input: "跳到输入框" },
  /** 演示模式的标记 */
  demo: "演示数据",
  demoTitle: "这是造出来的演示数据，不是真实记录",
  state: {
    connecting: "连接 hhd…",
    consoleDown: "控制台连不上",
    hhdSilent: "hhd 没有回应",
    asleep: "在睡觉",
    sleepy: "有点困",
    nightRest: "夜里放空",
    focus: "专注中",
    awake: "醒着",
    until: "，到 {time}",
    turning: "，正在翻页",
    todos: "，{n} 件醒来再办",
  },
} as const;
