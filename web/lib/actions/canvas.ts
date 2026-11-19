'use server';

import { revalidatePath } from 'next/cache';
import { hub, HubError, type AgentDayView, type CanvasBox, type CanvasNote, type Channel } from '../hub';
import { conversationRevalidateTarget, wsHref } from '../routes';
import { attempt } from './helpers';

// ---- crew canvas (PLAN-CANVAS.md) -------------------------------------------------------

/** Saves a team's frame coordinates `{ x, y, w, h }` on the workspace canvas. */
export async function saveChannelCanvas(
  channelId: string,
  box: CanvasBox,
): Promise<{ ok: true; canvas: CanvasBox } | { ok: false; error: string }> {
  try {
    const res = await hub<{ channelId: string; canvas: CanvasBox }>(`/channels/${encodeURIComponent(channelId)}/canvas`, {
      method: 'PATCH',
      body: box,
    });
    return { ok: true, canvas: res.canvas };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/**
 * Adds an agent to a team channel, moves it between two team channels, or removes it from one,
 * without redirecting away from the canvas. Also supports Undo.
 */
export async function canvasMembershipChange(input: {
  ws: string;
  agentId: string;
  addChannelId?: string;
  removeChannelId?: string;
  role?: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (input.addChannelId) {
      await hub(`/workspaces/${encodeURIComponent(input.ws)}/members`, {
        method: 'POST',
        body: { agentId: input.agentId },
      }).catch(() => {});
      await hub(`/channels/${encodeURIComponent(input.addChannelId)}/members`, {
        method: 'POST',
        body: { agentId: input.agentId },
      });
      if (input.role !== undefined) {
        await hub(`/channels/${encodeURIComponent(input.addChannelId)}/roles/${encodeURIComponent(input.agentId)}`, {
          method: 'PUT',
          body: { role: input.role.trim() },
        });
      }
    }
    if (input.removeChannelId) {
      await hub(`/channels/${encodeURIComponent(input.removeChannelId)}/members/${encodeURIComponent(input.agentId)}`, {
        method: 'DELETE',
      });
    }
    revalidatePath(wsHref(input.ws), 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Loads a page of an agent's log (its log on the canvas): the newest 20, or the 20 before `before`. */
export async function fetchAgentDay(
  agentId: string,
  before?: string,
): Promise<{ ok: true; day: AgentDayView } | { ok: false; error: string }> {
  try {
    const day = await hub<AgentDayView>(`/agents/${encodeURIComponent(agentId)}/day?${new URLSearchParams({ limit: '20', ...(before ? { before } : {}) })}`);
    return { ok: true, day };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Answers a "Needs you" item directly on the canvas without a full-page redirect. */
export async function replyCanvasWaiting(
  replyTo: string,
  text: string,
  ws?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: 'Write an answer first' };
  try {
    await hub(`/conversations/${encodeURIComponent(replyTo)}/messages`, {
      method: 'POST',
      body: { text: trimmed },
    });
    const rev = conversationRevalidateTarget(ws, replyTo);
    revalidatePath(rev.path, rev.type);
    return { ok: true };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Marks a "Needs you" item read (it was opened) without a full-page redirect. */
export async function markCanvasWaitingRead(
  ws: string,
  replyTo: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hub(`/conversations/${encodeURIComponent(replyTo)}/read`, { method: 'POST' });
    // The canvas's unread counts are per message; refetch them rather than guess what this read cleared.
    revalidatePath(wsHref(ws), 'layout');
    return { ok: true };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** Creates or places a team frame on the canvas (new channel, linked Slack channel, or existing channel). */
export async function createCanvasTeam(
  ws: string,
  input: {
    name: string;
    mode: 'new' | 'slack' | 'existing';
    slackChannelId?: string;
    existingChannelId?: string;
    canvas: CanvasBox;
  },
): Promise<{ ok: true; channelId: string } | { ok: false; error: string }> {
  try {
    let channelId: string;
    if (input.mode === 'existing' && input.existingChannelId) {
      channelId = input.existingChannelId;
      await hub(`/channels/${encodeURIComponent(channelId)}/join`, { method: 'POST' }).catch(() => {});
    } else {
      const name = input.name.trim();
      if (!name) return { ok: false, error: 'Give the team a name' };
      const ch = await hub<Channel>(`/workspaces/${encodeURIComponent(ws)}/channels`, {
        method: 'POST',
        body: { name },
      });
      channelId = ch.id;
      if (input.mode === 'slack' && input.slackChannelId) {
        await hub(`/channels/${encodeURIComponent(channelId)}/slack`, {
          method: 'POST',
          body: { channelId: input.slackChannelId },
        });
      }
    }
    await hub(`/channels/${encodeURIComponent(channelId)}/canvas`, {
      method: 'PATCH',
      body: input.canvas,
    }).catch(() => {});
    revalidatePath(wsHref(ws), 'layout');
    return { ok: true, channelId };
  } catch (err) {
    if (err instanceof HubError) return { ok: false, error: err.message };
    throw err;
  }
}

/** The canvas bench: adds one of your agents to this workspace, so it can be dragged into a team. */
export async function addMyAgentHere(ws: string, agentId: string) {
  await attempt(wsHref(ws), () => hub(`/workspaces/${encodeURIComponent(ws)}/members`, { method: 'POST', body: { agentId } }));
  revalidatePath(wsHref(ws), 'layout');
}



export async function saveCanvasNote(ws: string, input: { text?: string; files?: string[]; canvas?: CanvasBox; version?: number }, id?: string): Promise<{ ok: true; note: CanvasNote } | { ok: false; error: string }> {
  try {
    const result = await hub<{ note: CanvasNote }>(`/workspaces/${encodeURIComponent(ws)}/notes${id ? `/${encodeURIComponent(id)}` : ''}`, { method: id ? 'PATCH' : 'POST', body: input });
    revalidatePath(wsHref(ws), 'layout');
    return { ok: true, note: result.note };
  } catch (error) {
    if (error instanceof HubError) return { ok: false, error: error.message };
    throw error;
  }
}

export async function deleteCanvasNote(ws: string, note: Pick<CanvasNote, 'id' | 'version'>): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await hub(`/workspaces/${encodeURIComponent(ws)}/notes/${encodeURIComponent(note.id)}`, { method: 'DELETE', body: { version: note.version } });
    revalidatePath(wsHref(ws), 'layout');
    return { ok: true };
  } catch (error) {
    if (error instanceof HubError) return { ok: false, error: error.message };
    throw error;
  }
}
