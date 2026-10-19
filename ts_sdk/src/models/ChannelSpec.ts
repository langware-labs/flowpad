/**
 * What a conversation's channel is — mirrors `ChannelSpec` (flow_sdk/schema/data_spec/channel_spec.py),
 * computed by the backend from `Conversation.channel`. Surfaces read these traits; none of them
 * tests a channel's name or treats a missing channel as "ours".
 */
export const ChannelTransport = {
  /** Flowpad's own chat, through the hub conversation. */
  Flowpad: 'flowpad',
  /** The data source the conversation was projected from. */
  Source: 'source',
} as const;
export type ChannelTransport = (typeof ChannelTransport)[keyof typeof ChannelTransport];

/** A verb the channel offers on a whole conversation (approve a pull request, close an issue) —
 *  mirrors `ActionSpec` on the backend. The surface renders it; the channel carries it out. */
export interface IActionSpec {
  id: string;
  label: string;
  icon_name?: string;
  /** Ask this question before acting. */
  confirm?: string;
  /** The action takes a sentence from the person (a review comment, a reason). */
  needs_text?: boolean;
  destructive?: boolean;
  /** When the action is offered: on an open conversation (default), an ended one, or always. */
  when?: 'open' | 'ended' | 'any';
  /** The message mark key that says it is done: when the newest message the signed-in account sent
   *  carries it, the action is drawn as done instead of a button. Empty: never done. */
  done_mark?: string;
}

export interface IChannelSpec {
  name: string;
  title: string;
  icon_name?: string;
  /** Whether a row in this channel wears a source chip. Flowpad's own chat does not. */
  chip: boolean;
  /** The channel a conversation is born with (replaced when a source claims it). */
  home: boolean;
  transport: ChannelTransport;
  accepts_attachments: boolean;
  /** A person can answer ONE message here (the surface offers Reply). False for a channel that
   *  only speaks (a phone line) or only records (a harness transcript). */
  replies?: boolean;
  /** A reply to one message quotes it where the recipient reads (WhatsApp, Telegram); false: the
   *  reply only lands in that message's thread (email, Slack) — say "Reply in thread". */
  quotes?: boolean;
  /** People can put an emoji on a message here, and so can we. */
  reacts?: boolean;
  needs_cloud_login: boolean;
  hosts_sessions: boolean;
  /** Verbs on the whole conversation this channel offers. */
  actions?: IActionSpec[];
}
