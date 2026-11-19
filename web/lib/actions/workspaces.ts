'use server';

import { OWN_AGENT } from '@/lib/roomStatus';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { channelKey, hub, HubError, type Channel, type Workspace } from '../hub';
import { chatHref, WORKSPACE_COOKIE, wsHref } from '../routes';
import { rememberWorkspace } from './auth';
import { attempt, channelDetails, field, setFlash, workspaceDetails } from './helpers';

export async function createWorkspace(form: FormData) {
  const workspace = await attempt('/?workspace=new', () => hub<Workspace>('/workspaces', { method: 'POST', body: { name: field(form, 'name') } }));
  await rememberWorkspace(workspace.id);
  revalidatePath(wsHref(workspace.id), 'layout');
  redirect(workspaceDetails(workspace.id));
}

/** Adds a person to the workspace by email: now if they have an account, otherwise when they first sign in with Google. */
export async function inviteByEmail(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  const email = field(form, 'email');
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/invites`, { method: 'POST', body: { email } }));
  // In a short-lived cookie, not the URL, so the address stays out of browser history and server logs.
  await setFlash('flash_invited', email);
  redirect(back);
}

export async function revokeInvite(ws: string, email: string) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/invites/${encodeURIComponent(email)}`, { method: 'DELETE' }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Adds a bot I can see (mine, a public one, or one from a workspace I share) to the workspace, by id. */
export async function addToWorkspace(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/members`, { method: 'POST', body: { agentId: field(form, 'agent') } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Owner only: renames the workspace. */
export async function renameWorkspace(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}`, { method: 'PATCH', body: { name: field(form, 'name') } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Owner only: the email domains whose Google sign-ins join automatically, one per line (or comma-separated). */
export async function setDomains(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  const domains = field(form, 'domains')
    .split(/[\s,]+/)
    .map((d) => d.trim())
    .filter(Boolean);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/domains`, { method: 'PUT', body: { domains } }));
  revalidatePath(wsHref(ws), 'layout');
}

export async function removeFromWorkspace(ws: string, member: string) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/members/${encodeURIComponent(member)}`, { method: 'DELETE' }));
  revalidatePath(wsHref(ws), 'layout');
}

export async function addWorkspaceOwner(ws: string, member: string) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/owners`, { method: 'POST', body: { agent: member } }));
  revalidatePath(wsHref(ws), 'layout');
}

export async function leaveWorkspace(ws: string) {
  await attempt(workspaceDetails(ws), () => hub(`/workspaces/${encodeURIComponent(ws)}/members/me`, { method: 'DELETE' }));
  (await cookies()).delete(WORKSPACE_COOKIE);
  revalidatePath('/', 'layout');
  redirect('/');
}


// ---- channels ---------------------------------------------------------------------------

export async function createChannel(ws: string, form: FormData) {
  const channel = await attempt(`${wsHref(ws)}?channel=new`, () =>
    hub<Channel>(`/workspaces/${encodeURIComponent(ws)}/channels`, { method: 'POST', body: { name: field(form, 'name') } }),
  );
  revalidatePath(wsHref(ws), 'layout');
  // Straight to the details, to add people.
  redirect(channelDetails(ws, channel.id));
}

/** Adds a member of the workspace (a person or a bot) to the channel, by id, and optionally assigns their channel role. */
export async function addToChannel(ws: string, channelId: string, form: FormData) {
  const back = channelDetails(ws, channelId);
  const agentId = field(form, 'agent');
  const role = field(form, 'role');
  await attempt(back, async () => {
    await hub(`/channels/${encodeURIComponent(channelId)}/members`, { method: 'POST', body: { agentId } });
    if (role) {
      await hub(`/channels/${encodeURIComponent(channelId)}/roles/${encodeURIComponent(agentId)}`, { method: 'PUT', body: { role } });
    }
  });
  revalidatePath(wsHref(ws), 'layout');
}

export async function removeFromChannel(ws: string, channelId: string, member: string) {
  const back = channelDetails(ws, channelId);
  await attempt(back, () => hub(`/channels/${encodeURIComponent(channelId)}/members/${encodeURIComponent(member)}`, { method: 'DELETE' }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: rename the channel (form `name`). */
export async function renameChannel(ws: string, channelId: string, form: FormData) {
  await attempt(channelDetails(ws, channelId), () => hub(`/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: { name: field(form, 'name') } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: what the channel is for ("" clears it); its agents get it with every message. */
export async function setChannelContext(ws: string, channelId: string, form: FormData) {
  await attempt(channelDetails(ws, channelId), () => hub(`/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: { context: String(form.get('context') ?? '') } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: let anyone in the workspace join, or only those added. */
export async function setChannelOpen(ws: string, channelId: string, open: boolean) {
  await attempt(channelDetails(ws, channelId), () => hub(`/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: { open } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: anyone, signed in or not, can read this one thread (/p/<id>?thread=<post>), or not anymore. */
export async function setThreadPublic(ws: string, channelId: string, post: string, pub: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hub(`/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(post)}`, { method: 'PATCH', body: { public: pub } });
    revalidatePath(chatHref(ws, channelKey(channelId)), 'page');
    return { ok: true };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Thread starter or channel/workspace owner: marks a thread as done (stops work, hides from open feed) or reopens it. */
export async function setThreadDone(ws: string, channelId: string, post: string, done: boolean, filter?: string) {
  await attempt(chatHref(ws, channelKey(channelId), { ...(filter ? { filter } : {}), ...(!done ? { thread: post } : {}) }), () =>
    hub(`/channels/${encodeURIComponent(channelId)}/threads/${encodeURIComponent(post)}`, { method: 'PATCH', body: { done } }),
  );
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: anyone, signed in or not, can read it from now on (/p/<id>), or not anymore. */
export async function setChannelPublic(ws: string, channelId: string, pub: boolean) {
  await attempt(channelDetails(ws, channelId), () => hub(`/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: { public: pub } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: archive (read-only) or restore the channel. */
export async function setChannelArchived(ws: string, channelId: string, archived: boolean, form?: FormData) {
  await attempt(channelDetails(ws, channelId), async () => {
    // "Also unlink from Slack / Telegram": otherwise the link stays, waiting for the channel to be restored.
    if (archived && form?.get('unlinkSlack') === 'on') await hub(`/channels/${encodeURIComponent(channelId)}/slack`, { method: 'DELETE' });
    if (archived && form?.get('unlinkTelegram') === 'on') await hub(`/channels/${encodeURIComponent(channelId)}/telegram`, { method: 'DELETE' });
    await hub(`/channels/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: { archived } });
  });
  revalidatePath(wsHref(ws), 'layout');
}

/** Workspace owner: archive or restore the workspace. */
export async function setWorkspaceArchived(ws: string, archived: boolean) {
  const back = workspaceDetails(ws);
  await attempt(back, () => hub(`/workspaces/${encodeURIComponent(ws)}/archived`, { method: 'PUT', body: { archived } }));
  revalidatePath(wsHref(ws), 'layout');
}

/** Channel or workspace owner: a member's role in the channel (form `role`; empty clears it). */
export async function setChannelRole(ws: string, channelId: string, member: string, form: FormData) {
  const back = channelDetails(ws, channelId);
  await attempt(back, () => hub(`/channels/${encodeURIComponent(channelId)}/roles/${encodeURIComponent(member)}`, { method: 'PUT', body: { role: field(form, 'role') } }));
  revalidatePath(wsHref(ws), 'layout');
}

export async function addChannelOwner(ws: string, channelId: string, member: string) {
  const back = channelDetails(ws, channelId);
  await attempt(back, () => hub(`/channels/${encodeURIComponent(channelId)}/owners`, { method: 'POST', body: { agent: member } }));
  revalidatePath(wsHref(ws), 'layout');
}

export async function leaveChannel(ws: string, channelId: string) {
  await attempt(channelDetails(ws, channelId), () => hub(`/channels/${encodeURIComponent(channelId)}/members/me`, { method: 'DELETE' }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(wsHref(ws));
}

/** Member counts for my channels in a workspace, by channel id; empty when the hub can't say. */
export async function channelMemberCounts(ws: string): Promise<Record<string, number>> {
  const channels = await hub<Channel[]>(`/workspaces/${encodeURIComponent(ws)}/channels`).catch(() => [] as Channel[]);
  return Object.fromEntries(channels.flatMap((c) => (c.memberCount === undefined ? [] : [[c.id, c.memberCount] as const])));
}

/** Owner only: enables or disables public workspace mode, atomically opening only the checked channels on enable. */
export async function setWorkspacePublic(ws: string, isPublic: boolean, form?: FormData) {
  const back = workspaceDetails(ws);
  const publicChannels = isPublic && form ? form.getAll('publicChannels').map(String).filter(Boolean) : undefined;
  await attempt(back, () =>
    hub(`/workspaces/${encodeURIComponent(ws)}/public`, {
      method: 'PUT',
      body: { public: isPublic, ...(publicChannels ? { publicChannels } : {}) },
    }),
  );
  revalidatePath(wsHref(ws), 'layout');
}

/** Joins an open channel of the workspace and opens it. */
export async function joinChannel(channelId: string, ws: string) {
  await attempt(wsHref(ws), () => hub(`/channels/${encodeURIComponent(channelId)}/join`, { method: 'POST' }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(chatHref(ws, channelKey(channelId)));
}

/** Self-joins a public+open showcase channel from /p/[id] and redirects into the live workspace channel. */
export async function joinPublicChannel(channelId: string) {
  const ch = await attempt(`/p/${encodeURIComponent(channelId)}`, () =>
    hub<Channel>(`/channels/${encodeURIComponent(channelId)}/join`, { method: 'POST' }),
  );
  await rememberWorkspace(ch.workspaceId);
  revalidatePath(wsHref(ch.workspaceId), 'layout');
  redirect(chatHref(ch.workspaceId, channelKey(ch.id)));
}

/** Self-joins every public channel of a public workspace from /p/w/[ws] and opens its canvas. */
export async function joinPublicWorkspace(ws: string) {
  await attempt(`/p/w/${encodeURIComponent(ws)}`, () => hub(`/workspaces/${encodeURIComponent(ws)}/join`, { method: 'POST' }));
  await rememberWorkspace(ws);
  revalidatePath(wsHref(ws), 'layout');
  redirect(wsHref(ws));
}

/** The bots ticked on a room form. */
/** The agent choice in RoomSideFields: my agents, or `OWN_AGENT` for one Parly makes. */
const sideAgents = (form: FormData) => {
  const picked = form.getAll('bots').map(String).filter(Boolean);
  return picked.includes(OWN_AGENT) ? { bots: [], ownAgent: true } : { bots: picked };
};

/** Opens a shared room: my side, my representatives, my brief, and an invite to the other side. */
export async function createRoom(form: FormData) {
  const ws = await attempt('/rooms/new', () =>
    hub<{ id: string; room: { shared: string } }>('/rooms', {
      method: 'POST',
      body: { goal: field(form, 'goal'), invite: field(form, 'invite'), side: field(form, 'side'), ...sideAgents(form), brief: briefOf(form) },
    }),
  );
  await rememberWorkspace(ws.id);
  revalidatePath(wsHref(ws.id), 'layout');
  redirect(chatHref(ws.id, channelKey(ws.room.shared)));
}

/** A side's brief from its parts (see INSTRUCTIONS in RoomForm), each under its own heading, so its agents know which is which. */
function briefOf(form: FormData): string {
  const parts: [string, string][] = [
    ['What we want', field(form, 'want')],
    ['Red lines (never agree to)', field(form, 'redLines')],
    ['What you may share with the other side', field(form, 'share')],
    ['Also', field(form, 'brief')],
  ];
  return parts
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}:\n${v}`)
    .join('\n\n');
}

/** Sets up my side in a room I was invited to. */
export async function setupRoomSide(ws: string, form: FormData) {
  const room = await attempt(`/rooms/${encodeURIComponent(ws)}/side`, () =>
    hub<{ room: { shared: string } }>(`/rooms/${encodeURIComponent(ws)}/side`, {
      method: 'POST',
      body: { side: field(form, 'side'), ...sideAgents(form), brief: briefOf(form) },
    }),
  );
  await rememberWorkspace(ws);
  revalidatePath(wsHref(ws), 'layout');
  redirect(chatHref(ws, channelKey(room.room.shared)));
}

/** A new version of a room's document, on top of `base` (the one shown). */
export async function writeRoomDocument(ws: string, base: number, back: string, form: FormData) {
  await attempt(back, () => hub(`/rooms/${encodeURIComponent(ws)}/document`, { method: 'PUT', body: { text: String(form.get('text') ?? ''), base } }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** I answer what my side's agent asked me to decide: the button I pressed (`choice`), or what I wrote. */
export async function decideInRoom(ws: string, back: string, form: FormData) {
  await attempt(back, () => hub(`/rooms/${encodeURIComponent(ws)}/decision`, { method: 'POST', body: { choice: field(form, 'choice') || field(form, 'other') } }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** I replace my side's private instructions; its agents get them with their next message. */
export async function saveRoomBrief(ws: string, back: string, form: FormData) {
  await attempt(back, () => hub(`/rooms/${encodeURIComponent(ws)}/brief`, { method: 'PUT', body: { brief: String(form.get('brief') ?? '') } }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** I approve this version of the room's document for my side. */
export async function approveRoomDocument(ws: string, version: number, back: string) {
  await attempt(back, () => hub(`/rooms/${encodeURIComponent(ws)}/approve`, { method: 'POST', body: { version } }));
  revalidatePath(wsHref(ws), 'layout');
}

