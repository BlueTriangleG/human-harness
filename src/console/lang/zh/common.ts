// 各页共用的零碎：标点、时间、展开收起
export const common = {
  /** 时间和日期按哪个地区的写法出（toLocaleTimeString 这些的第一个参数） */
  locale: "zh-CN",
  /** 大数怎么缩写：wan = 按万写（12.3 万）；compact = 用上面那个地区的缩写（123K） */
  numbers: "wan",
  /** 月日怎么写：numeric = 数字（11-12）；words = 用上面那个地区的月份缩写（Nov 12） */
  dates: "numeric",
  /** 月日加时分 */
  dateTime: "{date} {time}",
  comma: "，",
  listSep: "、",
  dash: "—",
  expand: "展开",
  collapse: "收起",
  close: "关上",
  loading: "读取中…",
  justNow: "刚刚",
  minutesAgo: "{n} 分钟前",
  hoursAgo: "{n} 小时前",
  daysAgo: "{n} 天前",
  now: "现在",
  today: "今天",
  rows: "{n} 条",
  times: "{n} 次",
  turns: "{n} 轮",
  idle: "空闲",
  /** 太长的字中间省掉了多少（夹在留下的头和尾之间，单独一行） */
  clipped: "…（中间省略 {n} 字）…",
  image: "〔图片〕",
} as const;
