import type { ChannelRecord, SkillRecord, WorkspaceRecord } from '../registry/types.js';
import type { GraphStore } from './store.js';

/** Where a node came from, and so who may read it. */
export type GraphSource =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'room_doc'; workspaceId: string; conversationId: string }
  | { kind: 'skill'; skillId: string; channelId?: string };

/** A room document or skill write the graph mirrors. Room side briefs are private to a side and never come here. */
export type GraphSourceChange =
  | { skill: SkillRecord }
  | { deletedSkillId: string }
  | { roomDoc: { workspaceId: string; sharedChannelId: string; goal: string; text: string } }
  /** A restored channel: its archive purged its channel-scoped skills and (on a room's shared channel) the room doc. */
  | { restoredChannel: { workspaceId: string; channelId: string } };

/** What a sync reads besides the change itself. */
export interface GraphSourceReaders {
  channelDoc(id: string): Promise<ChannelRecord | undefined>;
  workspaceDoc(id: string): Promise<WorkspaceRecord | undefined>;
  channelSkills(channelId: string): Promise<SkillRecord[]>;
  roomDocument(workspaceId: string): Promise<{ text: string } | undefined>;
}

const EXCERPT = 280;

/**
 * Whether a reader may see a node with `source`: conversations and room docs by canRead, skills by canAccessSkill.
 * Fails closed on a missing or unknown source. The checks are injected so the graph read filter can call this.
 */
export async function canReadGraphSource(
  source: GraphSource | undefined,
  checks: { canRead: (conversationId: string) => Promise<boolean>; canAccessSkill: (skillId: string) => Promise<boolean> },
): Promise<boolean> {
  switch (source?.kind) {
    case 'conversation':
    case 'room_doc':
      return source.conversationId ? checks.canRead(source.conversationId) : false;
    case 'skill':
      return source.skillId ? checks.canAccessSkill(source.skillId) : false;
    default:
      return false;
  }
}

/**
 * Mirrors a room document or skill as a graph node: metadata only (title, a short excerpt, ids), no LLM call.
 * A room doc is a 'doc' node on the room's shared channel; a skill is a 'skill' node in the workspace it is scoped to.
 * ponytail: unscoped and agent-scoped skills have no workspace to live in, so they get no node; add one when the graph reads skills across workspaces.
 */
export async function syncGraphSource(graph: GraphStore, readers: GraphSourceReaders, change: GraphSourceChange): Promise<void> {
  if (!graph.enabled) return;
  if ('deletedSkillId' in change) return graph.deleteNodes({ kind: 'skill', 'source.skillId': change.deletedSkillId });
  if ('roomDoc' in change) return upsertRoomDoc(graph, change.roomDoc);
  if ('restoredChannel' in change) {
    const { workspaceId, channelId } = change.restoredChannel;
    const [workspace, skills] = await Promise.all([readers.workspaceDoc(workspaceId), readers.channelSkills(channelId)]);
    for (const skill of skills) await upsertSkill(graph, readers, skill);
    const doc = workspace?.room?.shared === channelId ? await readers.roomDocument(workspaceId) : undefined;
    if (doc) await upsertRoomDoc(graph, { workspaceId, sharedChannelId: channelId, goal: workspace!.room!.goal, text: doc.text });
    return;
  }
  await upsertSkill(graph, readers, change.skill);
}

async function upsertRoomDoc(graph: GraphStore, { workspaceId, sharedChannelId, goal, text }: { workspaceId: string; sharedChannelId: string; goal: string; text: string }): Promise<void> {
  const conversationId = `channel:${sharedChannelId}`;
  await graph.upsertNode({
    workspaceId, conversationId, kind: 'doc', key: 'room_doc', title: goal.slice(0, EXCERPT) || 'Room document', text: text.slice(0, EXCERPT),
    source: { kind: 'room_doc', workspaceId, conversationId },
  });
}

async function upsertSkill(graph: GraphStore, readers: GraphSourceReaders, skill: SkillRecord): Promise<void> {
  if (skill.builtin) return;
  let workspaceId: string | undefined;
  let channelId: string | undefined;
  if (skill.scope?.kind === 'workspace') workspaceId = skill.scope.id;
  else if (skill.scope?.kind === 'channel') {
    const channel = await readers.channelDoc(skill.scope.id);
    // An archived channel's skills stay out of the graph until it is restored.
    if (!channel || channel.archived) return;
    workspaceId = channel.workspaceId;
    channelId = channel.id;
  }
  if (!workspaceId) return;
  await graph.upsertNode({
    workspaceId, conversationId: `skill:${skill.id}`, kind: 'skill', key: skill.id, title: skill.name, text: (skill.description ?? '').slice(0, EXCERPT),
    source: { kind: 'skill', skillId: skill.id, ...(channelId ? { channelId } : {}) },
  });
}
