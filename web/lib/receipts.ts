import type { ConversationPage, MessageView } from './hub';

/**
 * Who has seen what, like Messenger: each participant's avatar once, under the newest loaded message they've
 * seen (`seen`: how far each has read, by message seq). Not the viewer's own, and not someone whose own later
 * message already shows they read up to it. Keyed by message id.
 */
export function seenMarks(messages: MessageView[], seen: Record<string, number>, meId: string): Map<string, string[]> {
  const marks = new Map<string, string[]>();
  for (const [id, upTo] of Object.entries(seen)) {
    if (id === meId) continue;
    const at = messages.findLast((m) => m.seq <= upTo);
    if (!at || messages.some((m) => m.fromId === id && m.seq >= at.seq)) continue;
    marks.set(at.id, [...(marks.get(at.id) ?? []), id]);
  }
  return marks;
}

/**
 * How many messages in a loaded conversation page are unread for `meId` without scanning `GET /conversations`.
 * Uses `page.unread` directly when returned by the hub (`chat.page`), falling back to counting loaded messages
 * from others after `seen[meId]` when `page.unread` is absent.
 */
export function conversationUnread(page: Pick<ConversationPage, 'unread' | 'messages' | 'seen'>, meId: string): number {
  if (typeof page.unread === 'number') return page.unread;
  const mySeen = page.seen?.[meId] ?? 0;
  return page.messages.filter((m) => m.fromId !== meId && m.seq > mySeen).length;
}

