import { randomUUID } from 'node:crypto';
import type { Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord, ChannelRecord, RoomInfo, RoomSide, WorkspaceRecord } from '../registry/types.js';
import { RoomStore } from './store.js';

/**
 * Shared rooms between organizations. A room is a workspace of its own, so invites, membership and
 * read rules are the ones that already hold: its shared channel takes every side, and each side has
 * a closed corner the others can't see or join. Joining a room opens nothing else of anyone's.
 *
 * Each side's private brief (what its representatives may share, agree to, aim for) is kept here,
 * apart from every message, and handed only to that side's agents when a message reaches them.
 */
interface RoomSetup {
  /** The side's name, shown on its members ("Acme"). */
  side: string;
  /** Bots of the caller's that represent the side. */
  bots: string[];
  brief: string;
  /** Parly makes the side an agent of its own, for this room only. Instead of `bots`. */
  ownAgent?: boolean;
}

/**
 * The room's shared document: what the sides work out together (a schema, an API, who owns what).
 * Anyone in the room writes a new version on top of the one they read; each side's person approves
 * a version, and any change clears the approvals. Every side approving the current one: agreed.
 */
export interface RoomDoc {
  version: number;
  text: string;
  updatedBy: string;
  updatedByName: string;
  updatedAt: string;
  /** By side id: who approved which version for that side. */
  approvals: Record<string, { by: string; byName: string; at: string; version: number }>;
}

/** What an agent in a room is given with each message there: whom it represents, its side's brief, its corner, the document. */
interface RoomBriefing {
  goal: string;
  side?: { name: string; brief?: string; corner: string; identity: string };
  doc?: { version: number; text: string; approvedBy: string[] };
  /** How the talks go, the same for every agent (see ROOM_RULES). */
  rules: string;
}

/**
 * Where a room's talks stand: agents' answers in it go to the other sides' agents (HubService.relayInRoom)
 * until every side approves the document, or ROOM_TURNS turns pass with no new version of it ("stuck").
 * A person posting in the room starts the count again.
 */
export interface RoomState {
  turns: number;
  /** The document version the turns are counted from: a new version is progress, and resets them. */
  docVersion: number;
  stuck?: boolean;
  /** The side whose agent took the last turn: the others are up next. */
  lastSide?: string;
  /** A side's agent hit the limits of its brief and asked its person to decide (see HubService.decideInRoom). */
  waiting?: RoomDecision;
}

export interface RoomDecision {
  side: string;
  /** The agent that asked, which goes on with the answer. */
  agent: string;
  question: string;
  options: string[];
  /** The room thread the talks were in, to carry on there. */
  thread?: string;
  /** When it was asked; the reminder counts from here. */
  at?: string;
  /** When its person was reminded: only once. */
  remindedAt?: string;
}

/** An agent's answer asking its side to decide: "ASK MY SIDE: question", then "- option" lines. */
export function parseAsk(text: string): { question: string; options: string[] } | undefined {
  const lines = text.trim().split('\n');
  const m = /^ASK MY SIDE:\s*(.*)$/i.exec(lines[0] ?? '');
  if (!m) return undefined;
  const options = lines.slice(1).map((l) => /^\s*[-*]\s+(.+)$/.exec(l)?.[1]?.trim()).filter((o): o is string => !!o).slice(0, 6);
  const rest = lines.slice(1).filter((l) => !/^\s*[-*]\s+/.test(l)).join(' ').trim();
  return { question: [m[1]!.trim(), rest].filter(Boolean).join(' '), options };
}

/** Where the room stands, for the people in it (see RoomStatus in the web app). */
interface RoomProgress {
  turns: number;
  maxTurns: number;
  /** The side that spoke last; the room waits on the others. */
  lastSide?: string;
  /** A decision a side's person was asked for (its agent can't go on without it): what was asked only to that side. */
  waiting?: { side: string; question?: string; options?: string[] };
}

/** Turns without a new document version before the room is stuck and the agents stop. */
export const ROOM_TURNS = 6;

/** How long a decision sits before its person is reminded, once. */
export const ROOM_REMIND_MS = 60 * 60 * 1000;

const ROOM_RULES = [
  'Your answers here go to the other side, and theirs come back to you: work toward the goal with them.',
  "Each side's person reads everything said here.",
  "Share no personal details, your side's or anyone's: no names, emails, phone numbers, links or handles, and no employer names. Talk about skills, experience, the work and the terms.",
  'Each turn, make a concrete proposal or counter-proposal, or accept theirs. Never only acknowledge.',
  'Keep the points being worked out in the shared document as a checklist, one per line: "- [ ] point" while open, "- [x] point" once both sides agreed on it.',
  'If you need your side to decide (the brief does not cover it, or you would have to cross a red line), answer with a first line "ASK MY SIDE: <the question>" and then one option per line starting with "- ". That goes to your side only; you get their decision in your corner, and your answer to it goes to the other side.',
  "Stay within your side's brief. If you can't move within it, say so plainly, and ask your side in your corner.",
  "When you agree, write the agreed terms into the shared document (a new version), then answer DONE. Each side's person approves it there.",
  `Answer DONE (only that word) when there is nothing left to say: the talks stop for you. After ${ROOM_TURNS} turns with no new version of the document, they stop and the people decide.`,
].join(' ');

const BRIEF_MAX = 4000;
const DOC_MAX = 50_000;
/** The document as handed to agents with each message; longer ones are cut, with a note. */
const DOC_SENT = 6000;
const GOAL_MAX = 200;

/** A room event for the app that opened it (RoomInfo.appId); set by the hub. */
type RoomEventSink = (workspaceId: string, type: 'room.needs_decision' | 'room.document_updated' | 'room.agreed' | 'room.stuck', data: Record<string, unknown>) => void;

export class Rooms {
  onEvent?: RoomEventSink;
  private readonly store: RoomStore;

  constructor(
    db: Database,
    private readonly registry: Registry,
  ) {
    this.store = new RoomStore(db);
  }

  /**
   * One agent turn in a room's talks: 'go' to pass it to the other side, or why not: every side approved the
   * document ('agreed'), or ROOM_TURNS turns passed with no new version of it ('stuck').
   */
  async turn(workspaceId: string, sideId?: string): Promise<'go' | 'agreed' | 'stuck'> {
    const room = (await this.registry.workspaceById(workspaceId))?.room;
    if (!room || room.closed) return 'stuck';
    const { result, newlyStuck } = await this.store.takeTurn(workspaceId, sideId, (doc) => isAgreed(room, doc), ROOM_TURNS);
    if (result === 'stuck' && newlyStuck) this.onEvent?.(workspaceId, 'room.stuck', {});
    return result;
  }

  /** A side's agent asks its person to decide; the room waits for them. */
  async ask(workspaceId: string, decision: RoomDecision): Promise<void> {
    await this.store.setWaiting(workspaceId, decision);
    this.onEvent?.(workspaceId, 'room.needs_decision', { side: decision.side, question: decision.question, options: decision.options });
  }

  /**
   * An owner is asked "go" before their agent wakes: the same decision as an ask, unless one is already waiting.
   * ponytail: one decision at a time, so a later go-prompt isn't in the room's status until it's answered in its corner.
   */
  async askGo(workspaceId: string, decision: RoomDecision): Promise<void> {
    const asked = await this.store.askIfIdle(workspaceId, decision);
    if (asked) this.onEvent?.(workspaceId, 'room.needs_decision', { side: decision.side, question: decision.question, options: decision.options });
  }

  /** A waiting "go" for `who` (its agent or side) is over: the owner answered in the prompt's thread (`thread`) or in the room, or the agent spoke anyway. An ask stays. */
  async settleGo(workspaceId: string, who: string, thread?: string): Promise<void> {
    await this.store.settleGo(workspaceId, who, thread);
  }

  /**
   * Decisions sitting since before `now - ROOM_REMIND_MS` in open rooms, each claimed so only one caller reminds.
   * ponytail: reads already-reminded ones again on every tick; add a remindAt field if that grows.
   */
  async claimOverdue(now: Date): Promise<{ workspaceId: string; corner: string; question: string }[]> {
    const cutoff = new Date(now.getTime() - ROOM_REMIND_MS).toISOString();
    const due = await this.store.overdue(cutoff);
    const claimed = await Promise.all(
      due.map(async ({ workspaceId, waiting }) => {
        if (waiting.remindedAt) return undefined;
        const room = (await this.registry.workspaceById(workspaceId))?.room;
        const corner = room?.sides.find((s) => s.id === waiting.side)?.corner;
        if (!room || room.closed || !corner) return undefined;
        if (isAgreed(room, await this.store.document(workspaceId))) return undefined;
        const won = await this.store.claimReminder(workspaceId, waiting.at, now.toISOString());
        return won ? { workspaceId, corner, question: waiting.question } : undefined;
      }),
    );
    return claimed.filter((c) => !!c);
  }

  /**
   * The person who set up a side answers the decision its agent asked for: the talks go on from it, counting
   * turns again. Returns what was asked, so the answer can go to that agent.
   */
  async decide(person: AgentRecord, workspaceId: string, choice: string): Promise<{ decision: RoomDecision; corner: string; sideName: string }> {
    const { side } = await this.sideOwnedBy(person, workspaceId, 'decides for it');
    return this.decideSide(workspaceId, side, choice);
  }

  /** A side's decision, by whoever speaks for it (its person, or its app over /v1). */
  async decideSide(workspaceId: string, side: RoomSide, choice: string): Promise<{ decision: RoomDecision; corner: string; sideName: string }> {
    if (!choice.trim()) throw new HubError('invalid', 'Say what you decided');
    const decision = await this.store.takeDecision(workspaceId, side.id);
    if (!decision) throw new HubError('conflict', 'Nothing is waiting for your decision');
    return { decision, corner: side.corner, sideName: side.name };
  }

  /** A person spoke in the room: the agents' talks go on, counting turns again. */
  async resume(workspaceId: string): Promise<void> {
    await this.store.resume(workspaceId);
  }

  /** The side `person` speaks for in a room: the one they set up as a member. Anyone else learns nothing about the room. */
  async sideOwnedBy(person: AgentRecord, workspaceId: string, action = 'acts for it'): Promise<{ room: RoomInfo; side: RoomSide }> {
    if (person.kind !== 'human') throw new HubError('forbidden', `A person ${action}; agents propose`);
    const room = (await this.registry.workspaceById(workspaceId))?.room;
    if (!room) throw new HubError('not_found', `No room ${workspaceId}`);
    if ((person.workspaces ?? []).includes(workspaceId)) {
      const mine = this.sideOf(room, person);
      if (mine && mine.id === person.id) return { room, side: mine };
    }
    if ((person.workspaces ?? []).includes(workspaceId)) throw new HubError('forbidden', `Only the person who set up a side ${action}`);
    throw new HubError('not_found', `No room ${workspaceId}`);
  }

  private async requireRoom(member: AgentRecord, workspaceId: string): Promise<RoomInfo> {
    const workspace = await this.registry.requireWorkspaceMembership(member, workspaceId);
    if (!workspace.room) throw new HubError('invalid', 'This workspace is not a shared room');
    return workspace.room;
  }

  /** The room's document, for anyone in the room; none until someone writes it. */
  async document(
    member: AgentRecord,
    workspaceId: string,
  ): Promise<{ doc?: RoomDoc; previous?: Pick<RoomDoc, 'version' | 'text' | 'updatedByName'>; agreed: boolean; stuck?: boolean; closed?: boolean; progress: RoomProgress }> {
    const room = await this.requireRoom(member, workspaceId);
    return this.readDocument(room, workspaceId, this.sideOf(room, member)?.id);
  }

  /** `viewerSide`: what its agent asked its person is theirs alone; other sides only see that the room waits on it. */
  private async readDocument(
    room: RoomInfo,
    workspaceId: string,
    viewerSide: string | undefined,
  ): Promise<{ doc?: RoomDoc; previous?: Pick<RoomDoc, 'version' | 'text' | 'updatedByName'>; agreed: boolean; stuck?: boolean; closed?: boolean; progress: RoomProgress }> {
    const [doc, state] = await Promise.all([
      this.store.document(workspaceId),
      this.store.state(workspaceId),
    ]);
    // The version before this one, to show what changed.
    const before = doc && doc.version > 1 ? await this.store.version(workspaceId, doc.version - 1) : undefined;
    const previous = before ? { version: before.version, text: before.text, updatedByName: before.updatedByName } : undefined;
    const progress: RoomProgress = {
      turns: state && state.docVersion === (doc?.version ?? 0) ? state.turns : 0,
      maxTurns: ROOM_TURNS,
      ...(state?.lastSide ? { lastSide: state.lastSide } : {}),
      ...(state?.waiting
        ? { waiting: state.waiting.side === viewerSide ? { side: state.waiting.side, question: state.waiting.question, options: state.waiting.options } : { side: state.waiting.side } }
        : {}),
    };
    return { ...(doc ? { doc } : {}), ...(previous ? { previous } : {}), agreed: isAgreed(room, doc), ...(state?.stuck ? { stuck: true } : {}), ...(room.closed ? { closed: true } : {}), progress };
  }

  /**
   * Anyone in the room writes a new version on top of `base`, the version they read (0: the first).
   * Someone else's newer version is never overwritten: that's a conflict, with the current one to merge into.
   */
  async writeDocument(member: AgentRecord, workspaceId: string, text: string, base: number): Promise<RoomDoc> {
    const room = await this.requireRoom(member, workspaceId);
    if (!text.trim()) throw new HubError('invalid', 'The document is empty');
    if (text.length > DOC_MAX) throw new HubError('invalid', `The document is at most ${DOC_MAX} characters`);
    // Once a side approved it, it's the people's: an agent can't replace it; a person can, which reopens it.
    // A change is a new version: every approval was for an older one. The one it replaces is kept, to compare.
    const out = await this.store.writeDocument(workspaceId, base, member.kind === 'human', { text, updatedBy: member.id, updatedByName: member.name });
    if ('conflict' in out) throw new HubError('conflict', `The document is at version ${out.conflict}, not ${base}: read it again and write on top of it`);
    if ('approved' in out) {
      throw new HubError('forbidden', `${isAgreed(room, out.approved) ? 'Every side' : 'A side'} approved version ${out.approved.version}: only a person can replace it now`);
    }
    const written = out.doc;
    this.onEvent?.(workspaceId, 'room.document_updated', { version: written.version });
    await this.registry.syncGraph?.({ roomDoc: { workspaceId, sharedChannelId: room.shared, goal: room.goal, text: written.text } });
    return written;
  }

  /** A person approves `version` (the current one) for their side. */
  async approve(person: AgentRecord, workspaceId: string, version: number): Promise<{ doc: RoomDoc; agreed: boolean }> {
    const { room, side } = await this.sideOwnedBy(person, workspaceId, 'approves for it');
    return this.approveSide(room, workspaceId, side, { by: person.id, byName: person.name }, version);
  }

  /** `side` approves `version`, recorded as `by` (a person, or the side itself when its app approves over /v1). */
  async approveSide(room: RoomInfo, workspaceId: string, side: RoomSide, by: { by: string; byName: string }, version: number): Promise<{ doc: RoomDoc; agreed: boolean }> {
    const out = await this.store.approve(workspaceId, side.id, by, version);
    if ('missing' in out) throw new HubError('not_found', 'There is no document to approve yet');
    if ('conflict' in out) throw new HubError('conflict', `The document changed: it is at version ${out.conflict} now`);
    const doc = out.doc;
    const agreed = isAgreed(room, doc);
    if (agreed) this.onEvent?.(workspaceId, 'room.agreed', { version: doc.version });
    return { doc, agreed };
  }

  /** What `agent` is given with a message in a room's channel, or nothing outside rooms. Read now, never stored on a task. */
  async briefing(agent: AgentRecord, workspaceId: string | undefined): Promise<RoomBriefing | undefined> {
    if (!workspaceId) return undefined;
    const room = (await this.registry.workspaceById(workspaceId))?.room;
    if (!room) return undefined;
    const side = this.sideOf(room, agent);
    const [brief, doc] = await Promise.all([
      side ? this.store.brief(workspaceId, side.id) : undefined,
      this.store.document(workspaceId),
    ]);
    const others = room.sides.filter((s) => s.id !== side?.id).map((s) => s.name).join(', ');
    const identity = side
      ? `You speak for ${side.name}. In this room and in your corner, "your side", "we" and "us" always mean ${side.name}${others ? `, and the other side is ${others}` : ''}. Whoever writes to you in your corner is your own person, on ${side.name}.`
      : '';
    const approvedBy = doc ? room.sides.filter((s) => doc.approvals[s.id]?.version === doc.version).map((s) => s.name) : [];
    return {
      goal: room.goal,
      rules: ROOM_RULES,
      ...(side ? { side: { name: side.name, corner: side.corner, identity, ...(typeof brief === 'string' && brief ? { brief } : {}) } } : {}),
      ...(doc ? { doc: { version: doc.version, text: doc.text.length > DOC_SENT ? `${doc.text.slice(0, DOC_SENT)}\n… (cut; the whole document is at version ${doc.version})` : doc.text, approvedBy } } : {}),
    };
  }

  /** The private brief of the side `person` set up. Only they read it here; the other side has no way to. */
  async readBrief(person: AgentRecord, workspaceId: string): Promise<{ brief: string }> {
    const { side } = await this.sideOwnedBy(person, workspaceId, 'reads its brief');
    const text = await this.store.brief(workspaceId, side.id);
    return { brief: typeof text === 'string' ? text : '' };
  }

  /** `person` replaces their side's brief. Its agents get the new one with their next message. */
  async writeBrief(person: AgentRecord, workspaceId: string, brief: string): Promise<{ brief: string }> {
    const { side } = await this.sideOwnedBy(person, workspaceId, 'changes its brief');
    const text = brief.trim();
    if (text.length > BRIEF_MAX) throw new HubError('invalid', `A brief is at most ${BRIEF_MAX} characters`);
    await this.store.setBrief(workspaceId, side.id, text);
    return { brief: text };
  }

  /** A person opens a room: its goal, their side, and an invite to the other side by email. */
  async create(person: AgentRecord, input: RoomSetup & { goal: string; invite: string }): Promise<{ workspace: WorkspaceRecord; room: RoomInfo }> {
    if (person.kind !== 'human') throw new HubError('forbidden', 'A person opens a room; their agents represent them in it');
    const goal = input.goal.trim();
    if (!goal || goal.length > GOAL_MAX) throw new HubError('invalid', `A room needs a goal of 1-${GOAL_MAX} characters`);
    const setup = await this.checkSetup(person, input);
    const workspace = await this.registry.createWorkspace(person, goal.length > 60 ? `${goal.slice(0, 59).trimEnd()}…` : goal, { unchecked: true });
    const shared = await this.registry.createChannel(person, workspace.id, 'room');
    const room = await this.registry.updateRoom(workspace.id, () => ({ goal, shared: shared.id, sides: [] }));
    let withSide: RoomInfo;
    try {
      withSide = await this.addSide(person, workspace.id, room, setup);
    } catch (err) {
      await this.registry.discardRoom(workspace.id).catch((e) => console.error('failed room not discarded', workspace.id, e));
      throw err;
    }
    await this.registry.inviteToWorkspace(person, workspace.id, input.invite);
    return { workspace: { ...workspace, room: withSide }, room: withSide };
  }

  /** Someone invited to a room sets up their own side in it: its name, representatives and brief. */
  async joinSide(person: AgentRecord, workspaceId: string, input: RoomSetup): Promise<RoomInfo> {
    if (person.kind !== 'human') throw new HubError('forbidden', 'A person sets up a side; their agents represent it');
    const workspace = await this.registry.requireWorkspaceMembership(person, workspaceId);
    if (!workspace.room) throw new HubError('invalid', 'This workspace is not a shared room');
    if (workspace.room.sides.some((s) => s.id === person.id)) throw new HubError('conflict', 'You already have a side in this room');
    const setup = await this.checkSetup(person, input);
    await this.registry.joinChannel(person, workspace.room.shared);
    return this.addSide(person, workspaceId, workspace.room, setup);
  }

  /**
   * An app opens a room over /v1: two sides, each named by the app's own `ref`, briefed privately, and represented by
   * a fresh agent made from one of the app's templates. That agent is only ever in this room (its shared channel and
   * its side's corner): an agent in two rooms could be talked into reading one from the other. The workspace and
   * corners are made by the app's maker (`owner`), who can read them as the app can. A failed open is taken apart.
   */
  async openForApp(
    owner: AgentRecord,
    appId: string,
    input: { goal: string; sides: { ref: string; name: string; brief: string; template: { name: string; instructions: string } }[]; metadata?: Record<string, string> },
  ): Promise<{ workspace: WorkspaceRecord; room: RoomInfo }> {
    const goal = input.goal.trim();
    if (!goal || goal.length > GOAL_MAX) throw new HubError('invalid', `A room needs a goal of 1-${GOAL_MAX} characters`);
    if (input.sides.length !== 2) throw new HubError('invalid', 'A room has two sides');
    for (const side of input.sides) {
      if (!side.ref || side.ref.length > 200) throw new HubError('invalid', 'Each side needs a ref of 1-200 characters');
      if (!side.name.trim() || side.name.length > 60) throw new HubError('invalid', 'Give each side a name of 1-60 characters');
      if (side.brief.length > BRIEF_MAX) throw new HubError('invalid', `A brief is at most ${BRIEF_MAX} characters`);
    }
    const [a, b] = input.sides as [(typeof input.sides)[0], (typeof input.sides)[0]];
    if (a.ref === b.ref) throw new HubError('invalid', 'The two sides need different refs');
    if (a.name.trim().toLowerCase() === b.name.trim().toLowerCase()) throw new HubError('invalid', 'The two sides need different names');
    const workspace = await this.registry.createWorkspace(owner, goal.length > 60 ? `${goal.slice(0, 59).trimEnd()}…` : goal, { unchecked: true });
    try {
      const shared = await this.registry.createChannel(owner, workspace.id, 'room');
      const sides: RoomSide[] = [];
      for (const side of input.sides) {
        const id = randomUUID();
        const name = side.name.trim();
        const corner = await this.registry.createChannel(owner, workspace.id, `${name} corner`);
        await this.registry.updateChannel(owner, corner.id, { open: false });
        const agent = await this.registry.createAppRoomAgent({ workspaceId: workspace.id, channels: [shared.id, corner.id], name: side.template.name, description: side.template.instructions, payerId: owner.id });
        await this.registry.setRoomRole(shared.id, agent.id, name);
        if (side.brief.trim()) await this.store.setBrief(workspace.id, id, side.brief.trim());
        sides.push({ id, name, corner: corner.id, agents: [agent.id], ref: side.ref });
      }
      const room = await this.registry.updateRoom(workspace.id, () => ({ goal, shared: shared.id, sides, appId, ...(input.metadata ? { metadata: input.metadata } : {}) }));
      return { workspace: { ...workspace, room }, room };
    } catch (err) {
      // Its agents are its own, so taking it apart touches nothing else.
      await this.registry.discardRoom(workspace.id).catch((e) => console.error('failed app room not discarded', workspace.id, e));
      throw err;
    }
  }

  /** Ends an app's room: its talks stop for good, and its agents are archived. */
  async close(workspaceId: string): Promise<void> {
    await this.registry.updateRoom(workspaceId, (now) => ({ ...now!, closed: true }));
    await this.registry.archiveRoomAgents(workspaceId);
  }

  /** Where a room stands, for its app: its document and what it waits on (any side's decision, in full). */
  async appView(workspaceId: string, room: RoomInfo) {
    const [view, state] = await Promise.all([this.readDocument(room, workspaceId, undefined), this.store.state(workspaceId)]);
    return { ...view, waiting: state?.waiting };
  }

  /** The room's moderator, made the first time it's needed (so rooms opened before moderators get one too). */
  async moderator(workspaceId: string): Promise<AgentRecord> {
    const room = (await this.registry.workspaceById(workspaceId))?.room;
    if (!room) throw new HubError('invalid', 'This workspace is not a shared room');
    const existing = room.moderator ? await this.registry.get(room.moderator) : undefined;
    if (existing) return existing;
    const made = await this.registry.createModerator(workspaceId, [room.shared, ...room.sides.map((s) => s.corner)]);
    // Two first uses at once: the room keeps the first moderator set; the other one stays unused.
    const kept = await this.registry.updateRoom(workspaceId, (now) => ((now ?? room).moderator ? (now ?? room) : { ...(now ?? room), moderator: made.id }));
    return kept.moderator === made.id ? made : ((await this.registry.get(kept.moderator!)) ?? made);
  }

  /** The side an agent is on: a person's own, or the one of the person who owns a bot. */
  sideOf(room: RoomInfo, agent: Pick<AgentRecord, 'id' | 'kind' | 'ownerId'>): RoomSide | undefined {
    return room.sides.find((s) => s.id === agent.id || s.agents?.includes(agent.id) || (agent.kind !== 'human' && !!agent.ownerId && s.id === agent.ownerId));
  }

  private async checkSetup(person: AgentRecord, input: RoomSetup): Promise<RoomSetup> {
    const side = input.side.trim();
    if (!side || side.length > 60) throw new HubError('invalid', 'Give your side a name of 1-60 characters');
    if (input.brief.length > BRIEF_MAX) throw new HubError('invalid', `A brief is at most ${BRIEF_MAX} characters`);
    const mine = new Set((await this.registry.botsOf(person)).filter((b) => !b.archived).map((b) => b.id));
    for (const id of input.bots) if (!mine.has(id)) throw new HubError('not_found', `No bot ${id} of yours`);
    if (input.ownAgent && input.bots.length) throw new HubError('invalid', 'Pick your own agents or let Parly make one, not both');
    return { side, bots: [...new Set(input.bots)], brief: input.brief.trim(), ...(input.ownAgent ? { ownAgent: true } : {}) };
  }

  /** The side's corner (closed), its bots in the room and the corner, side labels, and its brief. */
  private async addSide(person: AgentRecord, workspaceId: string, room: RoomInfo, setup: RoomSetup): Promise<RoomInfo> {
    // One side per person, claimed before anything is made: a second submit (a double click) fails here,
    // instead of leaving a second corner behind.
    if (!(await this.store.claimSide(workspaceId, person.id))) throw new HubError('conflict', 'You already have a side in this room');
    let corner: ChannelRecord | undefined;
    let ownAgent: AgentRecord | undefined;
    try {
      corner = await this.registry.createChannel(person, workspaceId, `${setup.side} corner`);
      await this.registry.updateChannel(person, corner.id, { open: false });
      if (room.moderator) await this.registry.addModerator(room.moderator, corner.id);
      // A side's own agent: like an app room's, it's in this room only, so nothing said here can reach another. Its calls are on the person's credits.
      if (setup.ownAgent) {
        ownAgent = await this.registry.createAppRoomAgent({
          workspaceId,
          channels: [room.shared, corner.id],
          name: `${setup.side} agent`,
          description: `Represents ${setup.side} in this shared room, on its private brief.`,
          payerId: person.id,
        });
        await this.registry.setRoomRole(room.shared, ownAgent.id, setup.side);
      }
      for (const bot of setup.bots) {
        await this.registry.addToWorkspace(person, workspaceId, bot);
        await this.registry.addToChannel(person, room.shared, bot);
        await this.registry.addToChannel(person, corner.id, bot);
      }
      for (const id of [person.id, ...setup.bots]) await this.registry.setRoomRole(room.shared, id, setup.side);
      if (setup.brief) await this.store.setBrief(workspaceId, person.id, setup.brief);
      const side: RoomSide = { id: person.id, name: setup.side, corner: corner.id, ...(ownAgent ? { agents: [ownAgent.id] } : {}) };
      return await this.registry.updateRoom(workspaceId, (current) => {
        const now = current ?? room;
        if (now.sides.some((s) => s.id === person.id)) throw new HubError('conflict', 'You already have a side in this room');
        return { ...now, sides: [...now.sides, side] };
      });
    } catch (err) {
      // Nothing half made, and no paid agent left answering: the person can set up their side again.
      await Promise.allSettled([
        this.store.releaseSide(workspaceId, person.id),
        this.store.deleteBrief(workspaceId, person.id),
        ...(corner ? [this.registry.updateChannel(person, corner.id, { archived: true })] : []),
        ...(ownAgent ? [this.registry.archiveRoomAgent(ownAgent.id)] : []),
      ]);
      throw err;
    }
  }
}

/** Every side has approved the current version (and there are at least two sides). */
function isAgreed(room: RoomInfo, doc: RoomDoc | undefined): boolean {
  return !!doc && room.sides.length >= 2 && room.sides.every((s) => doc.approvals[s.id]?.version === doc.version);
}

/** The briefing as text ahead of a message, for an agent that can't read structured fields. */
export function renderBriefing(b: RoomBriefing): string {
  const lines = [`[Shared room: ${b.goal}]`, b.rules];
  if (b.side) {
    lines.push(`${b.side.identity} To ask your own side something privately, post in your corner (channel ${b.side.corner}); the other side never sees it.`);
    if (b.side.brief) lines.push(`[Private brief for ${b.side.name}; the other side doesn't see it]`, b.side.brief);
  }
  if (b.doc) {
    lines.push(`[Shared document, version ${b.doc.version}${b.doc.approvedBy.length ? `, approved by ${b.doc.approvedBy.join(', ')}` : ''}]`, b.doc.text);
  } else lines.push('[No shared document yet: propose one in the room]');
  return lines.join('\n');
}
