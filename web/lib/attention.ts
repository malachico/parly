import type { AvatarOf } from '@/components/Avatar';
import type { WaitingItem } from '@/lib/hub';

export type CanvasConversation = { key: string; title: string; preview: string; unread: number; /** A channel's unread mentions. */ mentions?: number; thread?: string; updatedAt: string; who?: AvatarOf };

// Needs you: a DM with something new, or a channel/thread that @mentions you. A busy channel alone isn't yours to read.
const needsYou = (c: CanvasConversation) => c.unread > 0 && (c.mentions === undefined || c.mentions > 0);

const conversationDestination = (c: CanvasConversation) => c.thread && c.key.startsWith('channel:') ? `thread:${c.key.slice('channel:'.length)}:${c.thread}` : c.key;

/** One action per destination; channel unread totals can also include other threads, so never discard that remainder. */
export function attentionGroups(waiting: WaitingItem[], conversations: CanvasConversation[]) {
  const byDestination = new Map<string, WaitingItem>();
  for (const w of waiting) {
    if (!byDestination.has(w.replyTo) || w.at > byDestination.get(w.replyTo)!.at) byDestination.set(w.replyTo, w);
  }
  const uniqueWaiting = [...byDestination.values()].sort((a, b) => b.at.localeCompare(a.at));
  const destinations = new Set(uniqueWaiting.map((w) => w.replyTo));
  const unread = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).filter(needsYou).flatMap((c) => {
    if (!destinations.has(conversationDestination(c))) return [c];
    // A DM is one destination. A channel summary can contain additional unread messages we cannot attribute.
    return c.thread && c.unread > 1 ? [{ ...c, thread: undefined }] : [];
  });
  const recent = conversations.filter((c) => !needsYou(c) && !destinations.has(conversationDestination(c))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { waiting: uniqueWaiting, unread, recent };
}

/** Opening a destination reads it before the server catches up. Counts are per message, so a channel's other
 * threads can't be told apart here: they drop until the read's revalidation brings authoritative counts back. */
export const markDestinationRead = (conversations: CanvasConversation[], replyTo: string) =>
  conversations.map((c) => (conversationDestination(c) === replyTo ? { ...c, unread: 0, mentions: c.mentions === undefined ? undefined : 0 } : c));

/** The one unread count: ⌘K's badge, the tab title and the Needs you list all use it. */
export const attentionCount = (a: ReturnType<typeof attentionGroups>) => a.waiting.length + a.unread.length;
