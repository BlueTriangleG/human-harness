// What a channel is: the message that comes in, the message that goes out, what a send answers, and the hook before
// sending. The contract is docs/contracts/channels.md.

/** One message that arrived on a channel. */
export interface InboundMessage {
  channel: string;
  text: string;
  senderId?: string;
  sessionKey?: string;
  messageId?: string;
  isGroup?: boolean;
  conversationId?: string;
  replyToBody?: string;
  /** relay-spool 补交的：存下的时刻（hhd 不在时 relay 存的） */
  spooledAt?: number;
}

/** One message to send. */
export interface OutboundMessage {
  channel: string; target: string; text: string;
  media?: string; asVoice?: boolean; gifPlayback?: boolean;
  replyTo?: string;
}

/**
 * 发一条的结果。ok 为 false 时：有 unsure 是没确定发没发出去，没有的是确定没发出去。unsure 是怎么没确定的：
 * rechecked = 超时了、用同一个编号再问一次也没回音（网关多半卡住了）；dropped = 连接断了（可能是网关重启，再发会重连）
 * timeout = asked, no answer in time, and it cannot be asked again (a send through a bridge has no id to ask by).
 * resolved: the conversation id the channel recognised for the target (it differs from the target when a group was named).
 */
export interface Delivered { ok: boolean; out: string; resolved?: string; unsure?: "rechecked" | "dropped" | "timeout" }

export interface Channel {
  readonly connected: boolean;
  /** Why it will not come back by itself (the app logged this device out). Unset while it may still reconnect; a restart does not help while it is set. */
  readonly down?: string;
  start(onMessage: (m: InboundMessage) => void): Promise<void>;
  send(m: OutboundMessage): Promise<Delivered>;
  stop(): Promise<void>;
}

/** Nothing returned = send as is; { text } = send this text instead; { refuse } = do not send, the reason goes back to the caller. */
export type BeforeSend = (m: OutboundMessage) => Promise<{ text: string } | { refuse: string } | undefined>;

export type Send = (m: OutboundMessage) => Promise<Delivered>;
