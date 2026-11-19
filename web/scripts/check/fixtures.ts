import type { MessageView } from '../../lib/hub';

export const message = (seq: number, fromId = 'me', text = `m${seq}`): MessageView => ({ id: `m${seq}`, conversation: 'dm:me_bot', seq, fromId, from: fromId, text, at: `2026-10-08T00:00:0${seq}Z` });
export const people = { bot: { id: 'bot', name: 'Bot' }, other: { id: 'other', name: 'Other' } };
export const post = { ...message(1), conversation: 'channel:c', channelId: 'c' };
export const noop = () => {};
