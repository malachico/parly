'use server';

import { agentKey, channelKey, hub, HubError, me, type Agent, type MessageView } from '../hub';

type SendResult = { ok: true; key: string; message?: MessageView } | { ok: false; error: string };

/**
 * Says something in a conversation, from the composer or the agent picker: to an agent (`to`), in a channel
 * (`channelId`), or in a post's `thread` there. Returns the conversation key and created message without
 * triggering a competing server-action `revalidatePath` render: `Composer` renders the message optimistically
 * and the live stream (`lib/live.ts`) refreshes the view when the hub event arrives, so an in-flight send never
 * flashes a stale thread while switching threads.
 */
export async function sendInConversation(input: {
  replyTo?: string;
  workspaceId?: string;
  to?: string;
  channelId?: string;
  text: string;
  /** Channel messages: reply in the thread of this post. */
  thread?: string;
  /** Ids of files this person uploaded (startUpload + completeUpload). */
  files?: string[];
}): Promise<SendResult> {
  const text = input.text.trim();
  const files = input.files?.length ? input.files : undefined;
  if (!text && !files) return { ok: false, error: 'Write a message first' };
  const key = input.channelId && !input.to ? channelKey(input.channelId) : input.to ? agentKey(input.to) : undefined;
  if (!key) return { ok: false, error: 'Choose who to message' };
  const target = input.channelId && input.thread ? `thread:${input.channelId}:${input.thread}` : key;
  try {
    const message = await hub<MessageView>(`/conversations/${encodeURIComponent(target)}/messages`, { method: 'POST', body: { text, files, replyTo: input.replyTo } });
    return { ok: true, key, message };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** One row of the Find dialog: who you can message. */
export type DirectoryEntry = Pick<Agent, 'id' | 'name' | 'description' | 'kind' | 'avatar' | 'public' | 'lastSeen' | 'listening' | 'wakes' | 'workspaces' | 'owner'> & {
  skills: string[];
};

/** The directory as the Find dialog shows it: public agents and everyone in my workspaces, without me. */
export async function searchDirectory(q: string): Promise<{ ok: true; agents: DirectoryEntry[] } | { ok: false; error: string }> {
  try {
    const [agents, user] = await Promise.all([hub<Agent[]>(`/agents?${new URLSearchParams(q.trim() ? { q: q.trim() } : {})}`), me()]);
    return {
      ok: true,
      agents: agents
        .filter((a) => a.id !== user?.id && !a.archived && !a.webhookChannel)
        .map((a) => ({
          id: a.id,
          name: a.name,
          description: a.description,
          kind: a.kind,
          avatar: a.avatar,
          public: a.public,
          lastSeen: a.lastSeen,
          listening: a.listening,
          wakes: a.wakes,
          workspaces: a.workspaces,
          owner: a.owner,
          skills: a.skills.map((s) => s.name),
        })),
    };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.status === 401 ? 'Your session ended. Sign in again.' : err.message };
    throw err;
  }
}

/** The open conversation is read up to now; the hub updates the viewer's cursor without triggering a full layout refetch. */
export async function markConversationRead(key: string): Promise<void> {
  try {
    await hub(`/conversations/${encodeURIComponent(key)}/read`, { method: 'POST' });
  } catch (err) {
    if (err instanceof HubError) return;
    throw err;
  }
}

/** The open thread has been read: next time it opens at whatever comes after now. */
export async function markThreadRead(channelId: string, thread: string): Promise<void> {
  await markConversationRead(`thread:${channelId}:${thread}`);
}

/** A message search hit: where it lives (conversation, and the thread for a channel reply) and the message. */
export type MessageHit = { key: string; title: string; thread?: string; message: MessageView };

/** Messages containing `q` in my recent conversations, newest first. Fewer than 2 characters: none. */
export async function searchMessages(q: string): Promise<MessageHit[]> {
  if (q.trim().length < 2) return [];
  return hub<MessageHit[]>(`/search?${new URLSearchParams({ q: q.trim(), limit: '20' })}`).catch(() => []);
}

/** A context-graph decision, with where each copy of it was recorded (a chat key, and the thread if any). */
export type Decision = { id: string; workspaceId: string; title?: string; sources: { key: string; thread?: string; text?: string }[] };
const decisions = (qs: Record<string, string>) => hub<{ decisions: Decision[] }>(`/decisions?${new URLSearchParams(qs)}`).then((r) => r.decisions);

/** Decisions matching `q` in what I can read. Fewer than 2 characters: none. */
export async function searchDecisions(q: string): Promise<Decision[]> {
  if (q.trim().length < 2) return [];
  return decisions({ q: q.trim() }).catch(() => []);
}

/** A channel's recent decisions; null when the hub can't be asked. */
export async function channelDecisions(channelId: string): Promise<Decision[] | null> {
  return decisions({ channel: channelId, limit: '20' }).catch(() => null);
}

/** Decisions recorded in a thread, and what the graph links them to. */
export async function relatedDecisions(channelId: string, thread: string): Promise<Decision[]> {
  return hub<{ decisions: Decision[] }>(`/decisions/related?${new URLSearchParams({ channel: channelId, thread })}`)
    .then((r) => r.decisions)
    .catch(() => []);
}

/**
 * Starts a browser upload. The hub answers with a signed URL locked to this size, type and MD5;
 * the browser PUTs the bytes straight to storage (they never pass through this server).
 */
export async function startUpload(input: { name: string; mediaType: string; size: number; md5: string }): Promise<
  { ok: true; id: string; url: string; headers: Record<string, string> } | { ok: false; error: string }
> {
  try {
    const res = await hub<{ file: { id: string }; upload: { url: string; headers: Record<string, string> } }>('/files', { method: 'POST', body: input });
    return { ok: true, id: res.file.id, url: res.upload.url, headers: res.upload.headers };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** After the PUT: the hub checks the stored bytes and makes the file attachable. */
export async function completeUpload(id: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hub(`/files/${encodeURIComponent(id)}/complete`, { method: 'POST' });
    return { ok: true };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}
