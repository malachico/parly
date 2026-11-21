/** URLs inside the chat window. Safe to import from client components (no server-only imports). */

/** The workspace the person had open last; "/" and old links open there. */
export const WORKSPACE_COOKIE = 'hub_workspace';

/** Conversation keys: "channel:<id>" is a channel, "agent:<id>" a direct message. */
export const channelKey = (channelId: string) => `channel:${channelId}`;
export const agentKey = (agentId: string) => `agent:${agentId}`;

/** Whether a navigation changes what the channel timeline shows (its filter, page size, anchor or error), not just the side panel. */
export function timelineParamsChanged(here: URLSearchParams, next: URLSearchParams): boolean {
  return ['filter', 'posts', 'at', 'error'].some((k) => (here.get(k) ?? '') !== (next.get(k) ?? ''));
}

/** A workspace's home: the rail of its channels and direct messages. */
export const wsHref = (ws: string, params?: Record<string, string | undefined>) => withParams(`/w/${encodeURIComponent(ws)}`, params);
/** Your apps, triggers, and skills & processes library, as a panel over a workspace's canvas: the list, or one item. */
export const appsHref = (ws: string, toolkit?: string) => `/w/${encodeURIComponent(ws)}/apps${toolkit ? `/${encodeURIComponent(toolkit)}` : ''}`;
/** A workspace's developer apps: API keys for its servers (owners only). */
export const devAppsHref = (ws: string) => `/w/${encodeURIComponent(ws)}/developers`;
export const triggersHref = (ws: string, id?: string) => `/w/${encodeURIComponent(ws)}/triggers${id ? `/${encodeURIComponent(id)}` : ''}`;
/** The workspace's Knowledge page: what its conversations decided and who and what they were about; `entry` opens one. */
export const knowledgeHref = (ws: string, params?: { entry?: string }) => withParams(`/w/${encodeURIComponent(ws)}/knowledge`, params);
export const skillsHref = (ws: string, id?: string, params?: Record<string, string | undefined>) =>
  withParams(`/w/${encodeURIComponent(ws)}/skills${id ? `/${encodeURIComponent(id)}` : ''}`, params);

/** A conversation in a workspace: "channel:<id>" is a channel, "agent:<id>" a direct message. */
export function chatHref(ws: string, key: string, params?: Record<string, string | undefined>): string {
  return withParams(`/w/${encodeURIComponent(ws)}/c/${encodeURIComponent(key)}`, params);
}

/** A Shared Room has no canvas: it opens on the shared chat, once your side is set up (an app's room has none to set up). */
export function roomHomeHref(ws: string, room: { shared: string; mySide?: unknown; appId?: string }, params?: Record<string, string | undefined>): string {
  return room.mySide || room.appId ? chatHref(ws, channelKey(room.shared), params) : `/rooms/${encodeURIComponent(ws)}/side`;
}

/** Is this path one of the room's own chats, the ones its tabs move between? Anywhere else in a room needs a way back. */
export function isRoomChat(ws: string, room: { shared: string; mySide?: { corner: string } }, pathname: string): boolean {
  const path = decodeURIComponent(pathname);
  return [room.shared, room.mySide?.corner].some((id) => id && path === decodeURIComponent(chatHref(ws, channelKey(id))));
}

/**
 * Returns the scoped Next.js page path to revalidate after sending in a conversation,
 * avoiding a full root layout (`revalidatePath('/', 'layout')`) refetch.
 */
export function conversationRevalidateTarget(workspaceId: string | undefined, key: string): { path: string; type: 'page' } {
  return {
    path: workspaceId ? chatHref(workspaceId, key) : '/(window)/w/[ws]/c/[key]',
    type: 'page',
  };
}

export const channelHref = (ws: string, channelId: string, params?: Record<string, string | undefined>) => chatHref(ws, channelKey(channelId), params);
export const dmHref = (ws: string, agentId: string, params?: Record<string, string | undefined>) => chatHref(ws, agentKey(agentId), params);
export const agentHref = (ws: string, agentId: string) => `/w/${encodeURIComponent(ws)}/agents/${encodeURIComponent(agentId)}`;
/** Hire a hosted agent in a workspace. */
export const hireHref = (ws: string) => `/w/${encodeURIComponent(ws)}/hire`;
/** An owner's read-only view of a bot's conversations; with `key`, one of them. */
export const botActivityHref = (ws: string, agentId: string, key?: string) => `${agentHref(ws, agentId)}/activity${key ? `/${encodeURIComponent(key)}` : ''}`;

function withParams(path: string, params?: Record<string, string | undefined>): string {
  const q = new URLSearchParams(Object.entries(params ?? {}).filter((e): e is [string, string] => Boolean(e[1])));
  const qs = q.toString();
  return `${path}${qs ? `?${qs}` : ''}`;
}
