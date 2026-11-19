/** On a ChannelRecord: a Slack channel it is mirrored to. A room's shared channel has one per side. */
export interface SlackLink {
  teamId: string;
  channelId: string;
  /** A room side's link (its shared-channel link, or its corner's). */
  sideId?: string;
  /** The Slack channel is archived: nothing is posted there until it's back (then this clears by itself). */
  paused?: boolean;
}

/** On a MessageDoc: one copy of it in Slack, where it was written or where the bridge posted it. */
export interface SlackCopy {
  teamId: string;
  channelId: string;
  ts: string;
}

/** On a ChannelRecord: a Telegram chat (and optional forum topic) it is mirrored to. */
export interface TelegramLink {
  chatId: string;
  /** Optional Telegram forum topic (`message_thread_id`) bound to this Parly channel (or thread when `threadId` is set). */
  topicId?: number;
  /** Optional Parly thread (root post id) bound to this Telegram forum topic. */
  threadId?: string;
  /** A room side's link (its shared-channel link, or its corner's). */
  sideId?: string;
  /** Paused when the Telegram chat is unavailable; clears when messages flow again. */
  paused?: boolean;
}

/** On a MessageDoc: one copy of it in Telegram, where it was written or where the bridge posted it. */
export interface TelegramCopy {
  chatId: string;
  messageId: number;
  topicId?: number;
}
