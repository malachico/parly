/** What a channel page shows, worked out from the hub's channel-open bundle; shared by the page and its client loader. */
import type { Agent, Channel, ConversationPage, Workspace } from './hub';
import { plural } from './plural';

/** How many messages and thread replies a page shows; scrolling up asks for more. */
export const POSTS = 30;
export const REPLIES = 10;

/** Why the composer is off: the channel or its workspace is archived. */
export function channelReadOnly(channel: Channel, workspace: Pick<Workspace, 'archived'>): string | undefined {
  if (channel.archived) return 'This channel is archived. An owner can restore it from the channel details.';
  if (workspace.archived) return 'This workspace is archived. An owner can restore it from the workspace details.';
  return undefined;
}

/** My latest post @mentions agents that can't see it soon (asleep or away): say so, so silence isn't a mystery.
 *  An online agent that just hasn't read it yet gets no note: it's about to. */
export function waitingNotes(page: ConversationPage, members: Agent[], meId: string): string[] {
  const mine = [...page.messages].reverse().find((m) => m.fromId === meId);
  if (!mine?.mentions) return [];
  const working = new Set((page.activity ?? []).map((a) => a.agentId));
  return members
    .filter((a) => mine.mentions!.includes(a.id) && a.kind !== 'human' && !a.cloud && !a.listening && !working.has(a.id) && (page.seen?.[a.id] ?? 0) < mine.seq)
    .map((a) => `${a.name} ${a.wakes || a.hosted ? 'is being woken up' : "is away and reads it when it's back"}`);
}

/** Who can be @mentioned: the members but me, and not an incoming webhook (it can't read). */
export function mentionableOf(members: Agent[], meId: string) {
  return members.filter((m) => m.id !== meId && !m.webhookChannel).map((m) => ({ id: m.id, name: m.name }));
}

/** The header's line under the name: the channel's context, or "3 members · 1 person, 2 bots". */
export function channelDescription(channel: Channel, members: Agent[]): string {
  const first = channel.context?.split(/\r?\n/)[0];
  if (first) return first;
  const people = members.filter((m) => m.kind === 'human').length;
  const bots = members.length - people;
  return `${plural(members.length, 'member', 'members')} · ${plural(people, 'person', 'people')}, ${plural(bots, 'bot', 'bots')}`;
}
