import type { AvatarOf } from '@/components/Avatar';
import type { Conversation, WaitingItem } from '@/lib/hub';
import { subscribeLive } from '@/lib/live';

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
 * threads can't be told apart here: they drop until the hub's read event re-reads the counts. */
export const markDestinationRead = (conversations: CanvasConversation[], replyTo: string) =>
  conversations.map((c) => (conversationDestination(c) === replyTo ? { ...c, unread: 0, mentions: c.mentions === undefined ? undefined : 0 } : c));

/** The hub's conversations (GET /conversations) as the canvas lists them. */
export const canvasConversations = (conversations: Conversation[], meId: string): CanvasConversation[] =>
  conversations.flatMap((c) => {
    const title = c.kind === 'channel' ? (c.channel ? `#${c.channel.name}` : undefined) : c.with?.name;
    if (!title) return [];
    return [{ key: c.key, title, preview: `${c.last.fromId === meId ? 'You' : c.last.from}: ${c.last.text}`, unread: c.unread, ...(c.kind === 'channel' ? { mentions: c.mentions } : {}), ...(c.thread ? { thread: c.thread } : {}), updatedAt: c.updatedAt, ...(c.with ? { who: c.with } : {}) }];
  });

/** Live messages and reads re-read the hub's own counts (GET /api/conversations), once per burst and with no page
 * re-render; nothing is counted here. One read at a time: events during a read cause one more after it, so a slow hub
 * still gets its answers applied. A failed read keeps the list as it is. Returns the unsubscribe. */
export function liveConversations(ws: string, meId: string, set: (list: CanvasConversation[]) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let again = false;
  let stopped = false;
  const load = async () => {
    timer = undefined;
    busy = true;
    try {
      const res = await fetch(`/api/conversations?workspace=${encodeURIComponent(ws)}`, { cache: 'no-store' });
      if (res.ok) {
        const list = canvasConversations((await res.json()) as Conversation[], meId);
        if (!stopped) set(list);
      }
    } catch {
      // Keep the list as it is.
    }
    busy = false;
    if (again && !stopped) {
      again = false;
      void load();
    }
  };
  // Not reset by later events: a steady stream still reads every 400ms, or as fast as the hub answers.
  const stop = subscribeLive((e) => {
    if (e.type === 'activity') return;
    if (busy) again = true;
    else timer ??= setTimeout(load, 400);
  });
  return () => {
    stop();
    clearTimeout(timer);
    stopped = true;
  };
}

/** The one unread count: ⌘K's badge, the tab title and the Needs you list all use it. */
export const attentionCount = (a: ReturnType<typeof attentionGroups>) => a.waiting.length + a.unread.length;
