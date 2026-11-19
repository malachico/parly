import type { MessageDoc } from '../chat/chat.js';
import type { ChatService, PostInput, RoomHooks } from '../chat/chatService.js';
import { HubError } from '../lib/errors.js';
import { textOf, type WirePart } from '../lib/wire.js';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord, ChannelRecord, RoomInfo, RoomSide, WorkspaceRecord } from '../registry/types.js';
import { parseAsk, type Rooms } from './rooms.js';

const text = (parts: WirePart[]) => textOf({ parts }).trim();

/**
 * A shared room's talks: everything the hub does differently in a room, in one place. Everyone in the room
 * reads everything; what a room changes is who an agent's message is handed to (MessageDoc.to).
 *
 * An agent's message in the room is its turn: it goes to the other sides' agents, who answer in turn. The talks
 * stop once every side approved the document, after ROOM_TURNS turns with no new version of it, or on DONE. An
 * agent at the limit of its brief asks its side ("ASK MY SIDE: ..."): that goes to its people in its corner,
 * and its answer to their decision (a reply to it there) is its next turn in the room.
 */
export class RoomTalks implements RoomHooks {
  constructor(
    private readonly rooms: Rooms,
    private readonly registry: Registry,
    private readonly chat: ChatService,
  ) {}

  sideOf(room: RoomInfo, agent: AgentRecord) {
    return this.rooms.sideOf(room, agent);
  }

  async prepare(from: AgentRecord, channel: ChannelRecord, workspace: WorkspaceRecord | undefined, input: PostInput, thread?: string): Promise<PostInput> {
    const room = workspace?.room;
    if (!room || input.to || from.id === room.moderator) return input;
    // External Slack messages never wake bots (enforced by isFor), while people in the room still receive them.
    if (input.external) return input;
    const side = this.rooms.sideOf(room, from);
    if (from.kind === 'human') {
      // A person speaking in the room starts stopped talks again.
      if (channel.id === room.shared) {
        await this.rooms.resume(channel.workspaceId);
        if (side) await this.rooms.settleGo(channel.workspaceId, side.id);
        // A person's own coding tool (followsOwner) is woken only by its owner, or once its owner approves in their corner.
        const inRoom = await this.registry.search(from, { channel: room.shared });
        const gated = inRoom.filter((a) => a.kind !== 'human' && a.followsOwner && a.ownerId !== from.id);
        if (gated.length) {
          const gatedIds = new Set(gated.map((a) => a.id));
          return {
            ...input,
            to: inRoom.filter((a) => a.id !== from.id && a.id !== room.moderator && !gatedIds.has(a.id)).map((a) => a.id),
          };
        }
      }
      // A person answering in their corner: in a go-prompt's thread that wakes its meta.agent; otherwise answers the room's waiting decision.
      if (side?.corner === channel.id && side.id === from.id) {
        const post = thread ? await this.chat.store.message(thread) : undefined;
        if (post?.meta?.agent && post.fromId !== post.meta.agent) {
          await this.rooms.settleGo(channel.workspaceId, post.meta.agent, post.meta.roomThread ?? '');
          return { ...input, to: [post.meta.agent], meta: { roomThread: post.meta.roomThread ?? '', agent: post.meta.agent } };
        }
        const decided = await this.rooms.decide(from, channel.workspaceId, text(input.parts)).catch((err) => {
          if (err instanceof HubError && (err.code === 'conflict' || err.code === 'invalid')) return undefined;
          throw err;
        });
        if (decided) return { ...input, to: [decided.decision.agent], meta: { roomThread: decided.decision.thread ?? '', agent: decided.decision.agent } };
      }
      return input;
    }
    if (channel.id !== room.shared) return input;
    await this.rooms.settleGo(channel.workspaceId, from.id);
    const said = text(input.parts);
    if (!said || /^done[.!]?$/i.test(said)) return { ...input, to: [] };
    // Asking its side to decide: that goes to its people, in its corner, and the room waits for them.
    const ask = parseAsk(said);
    if (ask && side) {
      await this.rooms.ask(channel.workspaceId, { side: side.id, agent: from.id, ...ask, ...(thread ? { thread } : {}) });
      const options = ask.options.map((o) => `- ${o}`).join('\n');
      const note = `${ask.question}${options ? `\n${options}` : ''}\n\n(Decide on the room's page, or answer here.)`;
      const people = (await this.registry.search(from, { channel: side.corner })).filter((a) => a.kind === 'human').map((a) => a.id);
      await this.chat.post(from, { channelId: side.corner }, { parts: [{ text: note }, { data: { decision: ask } }], to: people, meta: { roomThread: thread ?? '' } });
      return { ...input, parts: [{ text: `${from.name} is asking its side.` }], to: [] };
    }
    const go = (await this.rooms.turn(channel.workspaceId, side?.id)) === 'go';
    const otherSides = (await this.registry.search(from, { channel: room.shared })).filter((a) => {
      const theirs = a.kind !== 'human' && this.rooms.sideOf(room, a);
      return !!theirs && theirs.id !== side?.id && !a.followsOwner;
    });
    return { ...input, to: go ? otherSides.map((a) => a.id) : [] };
  }

  /**
   * After a post in a room:
   * - In the shared channel, a message from outside a side that @mentions a `followsOwner` agent (or continues a thread
   *   where it already took part, or an external Slack message that @mentions an agent on a side) asks that side's owner
   *   in their private corner ("go") before waking the agent.
   * - In a side's corner, an agent's first reply after a decision/approval there is its next turn in the room.
   */
  async afterPost(from: AgentRecord, channel: ChannelRecord, workspace: WorkspaceRecord | undefined, message: MessageDoc): Promise<void> {
    const room = workspace?.room;
    if (!room || from.id === room.moderator) return;
    if (channel.id === room.shared) {
      const said = text(message.parts);
      if (!said) return;
      const fromSide = message.external ? undefined : this.rooms.sideOf(room, from);
      const inRoom = (await this.registry.search(from, { channel: room.shared })).filter(
        (a) => a.kind !== 'human' && a.id !== room.moderator && !a.archived,
      );
      const mentioned = new Set(message.mentions ?? []);
      let tookPart = new Set<string>();
      if (message.kind === 'thread' && message.post) {
        const [post, replies] = await Promise.all([
          this.chat.store.message(message.post),
          this.chat.store.since(message.conversationId, 0, 50),
        ]);
        tookPart = new Set([post?.fromId, ...replies.map((r) => r.fromId)].filter((id): id is string => !!id));
      }
      const candidates = inRoom.filter((a) => {
        const aSide = this.rooms.sideOf(room, a);
        if (!aSide || aSide.id === fromSide?.id) return false;
        if (mentioned.has(a.id)) return Boolean(a.followsOwner || message.external);
        return Boolean(a.followsOwner && mentioned.size === 0 && tookPart.has(a.id));
      });
      if (!candidates.length) return;
      const moderator = await this.rooms.moderator(channel.workspaceId);
      const roomThread = message.post ?? message.id;
      for (const bot of candidates) {
        const botSide = this.rooms.sideOf(room, bot)!;
        const question = `${message.from} in #${channel.name}: "${said}"`;
        const note = `${question}\n\nReply "go" (or your instructions) to wake ${bot.name}. What you write here goes to the room. To ask your side, use ASK MY SIDE.`;
        const people = (await this.registry.search(bot, { channel: botSide.corner })).filter((a) => a.kind === 'human').map((a) => a.id);
        await this.chat.post(
          moderator,
          { channelId: botSide.corner },
          { parts: [{ text: note }, { data: { decision: { question, options: ['go'] } } }], to: people, meta: { roomThread, agent: bot.id } },
        );
        await this.rooms.askGo(channel.workspaceId, { side: botSide.id, agent: bot.id, question, options: ['go'], thread: roomThread });
      }
      return;
    }
    if (from.kind === 'human' || message.kind !== 'thread') return;
    const mySide = this.rooms.sideOf(room, from);
    if (mySide?.corner !== channel.id) return;
    const decision = await this.chat.store.message(message.post!);
    const roomThread = decision?.meta?.roomThread;
    if (roomThread === undefined) return;
    if (parseAsk(text(message.parts))) return;
    const replies = await this.chat.store.since(message.conversationId, 0, 50);
    const history = [decision, ...replies.filter((r) => r.id !== message.id)].filter((m): m is MessageDoc => !!m);
    const lastGrant = history.findLastIndex((m) => m.to?.includes(from.id));
    if (lastGrant < 0) return;
    if (history.slice(lastGrant + 1).some((m) => m.fromId === from.id)) return;
    await this.chat.post(from, { channelId: room.shared, ...(roomThread ? { thread: roomThread } : {}) }, { parts: message.parts });
  }

  /** Every side of a room is set up: its moderator opens the talks, to the agents, with the goal and the sides. */
  async start(workspaceId: string): Promise<void> {
    const room = (await this.registry.workspaceById(workspaceId))?.room;
    if (!room || room.sides.length < 2) return;
    const said = [
      `Every side is here: ${room.sides.map((s) => s.name).join(', ')}. The goal: ${room.goal}.`,
      "Agents, start now: each side, state your opening position. Your answers go to the other side's agents.",
      'When you agree, write the terms into the shared document, and each side approves it there.',
    ].join('\n');
    const moderator = await this.rooms.moderator(workspaceId);
    const bots = (await this.registry.search(moderator, { channel: room.shared })).filter((a) => a.kind !== 'human' && a.id !== moderator.id).map((a) => a.id);
    // No agents on any side: the people talk for themselves, and there's nobody to tell to start.
    if (!bots.length) return;
    await this.chat.post(moderator, { channelId: room.shared }, { parts: [{ text: said }], to: bots });
  }

  /** Reminds a side's people, once, of a decision that sat for ROOM_REMIND_MS: a room waiting on them is silent otherwise. */
  async remind(now = new Date()): Promise<void> {
    const overdue = await this.rooms.claimOverdue(now);
    const sent = await Promise.allSettled(
      overdue.map(async ({ workspaceId, corner, question }) => {
        const moderator = await this.rooms.moderator(workspaceId);
        const people = (await this.registry.search(moderator, { channel: corner })).filter((a) => a.kind === 'human').map((a) => a.id);
        if (!people.length) return;
        const note = `The room is still waiting for you: ${question}\n\nAnswer here or on the room's page, and your agent goes on.`;
        await this.chat.post(moderator, { channelId: corner }, { parts: [{ text: note }], to: people });
      }),
    );
    for (const s of sent) if (s.status === 'rejected') console.error('room reminder failed', s.reason);
  }

  /** A side's person answers what its agent asked them to decide: the moderator hands it to that agent, privately in their corner. */
  async decide(person: AgentRecord, workspaceId: string, choice: string): Promise<void> {
    await this.handOver(workspaceId, choice, await this.rooms.decide(person, workspaceId, choice));
  }

  /** The same, for a side whose app answers over /v1. */
  async decideSide(workspaceId: string, side: RoomSide, choice: string): Promise<void> {
    await this.handOver(workspaceId, choice, await this.rooms.decideSide(workspaceId, side, choice));
  }

  private async handOver(workspaceId: string, choice: string, { decision, corner, sideName }: Awaited<ReturnType<Rooms['decideSide']>>): Promise<void> {
    const said = `Decision from ${sideName}: ${choice.trim()}\n(About: ${decision.question})\nGo on in the room with it now: reply to this message, and your reply goes to the other side. What you write here goes to the room. To ask your side, use ASK MY SIDE.`;
    const moderator = await this.rooms.moderator(workspaceId);
    await this.chat.post(moderator, { channelId: corner }, { parts: [{ text: said }], to: [decision.agent], meta: { roomThread: decision.thread ?? '', agent: decision.agent } });
  }
}
