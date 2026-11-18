// 时间线：中央记忆的直播
export const timeline = {
  search: "找字、工具名、人名",
  sentTo: "发给",
  // 「收到」那一行里渠道的代号怎么显示：中文界面照原样显示代号
  channel: { senses: "senses" },
  someone: "对方",
  // 她的回复发出去以后，「说」那一行标上发给了谁（同一段话不再另列一行「发给」）
  saidTo: "发给 {name}",
  saidToMany: "发给 {name}（{n} 条）",
  saidAt: "{time} 发出",
  saidBetween: "{from} 到 {to} 分 {n} 条发出",
  rowTitle: "{day} 第 {seq} 条",
  innerNote: "，下意识内部的过程，没同步给其他脑区",
  older: "更早的",
  empty: "中央记忆还是空的。{ta}收到消息、开始想事情以后，这里会出现。",
  emptyRegion: "中央记忆里没有{name}的记录。看整个大脑，或者换一个脑区。",
  regionLoading: "最近这一段里没有{name}的记录，正在往前找它自己的…",
  regionFailed: "最近这一段里没有{name}的记录，往前找的时候没取到（{error}）。这不代表它没动过：点「更早的」再试一次。",
  emptyFiltered: "过滤之后没有记录。改一下上面的勾选或搜索。",
  unseen: "下面有 {n} 条新的",
  loadFailed: "读不到中央记忆：{error}",
} as const;
