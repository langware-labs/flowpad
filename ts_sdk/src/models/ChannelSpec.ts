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
  needs_cloud_login: boolean;
  hosts_sessions: boolean;
}
