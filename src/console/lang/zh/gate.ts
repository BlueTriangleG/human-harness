// 下意识：闸门（丘脑）一天的账
export const gate = {
  paneLabel: "下意识：闸门的账",
  subtitle: "丘脑，闸门",
  dayLabel: "看哪一天",
  prev: "前一天",
  prevButton: "‹ 前一天",
  next: "后一天",
  nextButton: "后一天 ›",
  back: "回到时间线",
  /** 日子后面带的：看的那天就是今天 */
  todayMark: "（今天）",
  loadFailed: "读不到闸门的账：{error}",
  loadFailedDay: "读不到闸门的账（{day}）：{error}",
  listed: "只列了最新的 {shown} 条，这天一共 {total} 条。",
  emptyToday: "今天闸门还没收到东西。",
  emptyDay: "这天闸门没有记录。",
  /** 额度的数，一万以上的写法：{n} 是几万（common.numbers 是 wan 的语言才用到） */
  tenThousands: "{n} 万",
  // 账里记的代号在页面上叫什么（代号本身不翻）：怎么分、判成什么、什么时候给、从哪来
  route: { "fixed-main": "直达", hands: "帮手", rule: "{ta}的规则", judge: "小判断", fallback: "兜底", pending: "还没分完" },
  verdict: { main: "给{ta}", digest: "进总结", drop: "放下" },
  when: { now: "马上", work: "做事时", leisure: "放空时" },
  source: { plain: "文字", "hh-quota": "额度" },
  // 大脑图旁边那张卡
  card: {
    inToday: "今天进来",
    inOn: "{day} 进来",
    judgeCalls: "小判断调了",
    quotaUsed: "额度用了",
    hint: "再点一次下意识、点空白处或按 Esc，回到时间线。",
  },
  // 账上面那一行数（怎么分的那几个名字用上面 route 里的）
  summary: {
    received: "进来",
    toHands: "交给帮手",
    verdicts: "（给{ta} {main} / 进总结 {digest} / 放下 {drop}）",
    fallbackWhy: "（{why}）",
    // 悬停在「小判断」「兜底」上的一句解释
    judgeTitle: "没有固定的路、{ta}自己的规则也没管到的事件，由一个又小又快的模型来判：给{ta}、进总结还是放下。",
    fallbackTitle: "小判断判不了的时候（超时、额度不够），按默认的办法处理。",
    quotaToday: "今天的额度",
    quotaThatDay: "这天的额度",
    judgeCalls: "（小判断调了 {n} 次）",
    quotaTitle: "小判断花的「单位」（和睡眠预算同一种算法：缓存读 1/10、乘模型倍数）。闸门自己把关时按最近 24 小时滚动算。",
  },
  // 认访客要用的东西读不了：前三条是哪一样读不了，后面接 unreadable
  note: {
    registry: "名单",
    baseline: "名单的批准底子",
    aliases: "事件库里的人名",
    unreadable: "读不了：认不出谁是访客，聊天的原文都先不显示，群也一样。",
  },
  head: { time: "时间", from: "从哪来", route: "怎么分", verdict: "判成", why: "为什么", unsure: "拿不准", delivered: "送到" },
  row: {
    private: "访客私聊（不显示原文）",
    privateTitle: "访客的一对一消息：闸门这一页不显示它的原文。",
    noReason: "（没写原因）",
    attachedDo: "附带的做法",
    judgeFloor: "最少进总结",
    gist: "要点：{gist}",
    unsure: "拿不准",
    unsureTitle: "小判断说它拿不准",
    sent: "送了",
    notSent: "还没送",
    sentTitle: "已经送到{ta}那里",
    notSentTitle: "要给{ta}，还没送到（排着等{ta}做事 / 放空时，或者送不出去）",
    noSendTitle: "不用送",
  },
} as const;
