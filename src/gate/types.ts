// 潜意识门：感官事件的类型。
export interface SenseEvent {
  src: string; id: string;
  text: string;          // senses.py 那一行（不带「- [src id=]」和（do））
  line: string;          // 给主意识看的原文：`- [${src} id=${id}] ${text}（${do}）` + 正文块
  body?: string; do?: string;
  conv?: string; sender?: string; isGroup?: boolean; mentionsMe?: boolean; unread?: number;
  alarm?: boolean; urgent?: boolean;   // urgent：hhd 自己的额度提醒里「见底 / 用完 / 重置」那几档
  /**
   * 这条是角色自己的感官脚本生成的系统提示（比如「手机刚开，去补看一眼」「某个接口坏了」），不是谁发来的消息。
   * 只认脚本代码里写死的布尔 true：通知里的字变不成这个字段。现在只有控制台用它：带着它、而且没有 conv、sender、isGroup 这三个字段的行
   * 不当访客私聊遮。所以脚本生成这种提示时三个字段都别写（写了空的也不行，照旧遮）
   */
  system?: true;
}
export type Action = "main" | "judge" | "digest" | "drop";
export type When = "now" | "work" | "leisure";
