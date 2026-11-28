'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { hub, safeNext, type Agent, type EndpointCheck, type WakeCheck } from '../hub';
import { isEndpointClient } from '../connect';
import { agentHref, dmHref, wsHref } from '../routes';
import { attempt, connectBack, field, setFlash } from './helpers';

/**
 * The "how the hub signs in to it" fields, as the hub's credential object (the hub validates it): null for
 * None (removes one), undefined to keep what's there.
 */
function credentialFrom(form: FormData): Record<string, unknown> | null | undefined {
  switch (field(form, 'authType')) {
    case 'none':
      return null;
    case 'bearer':
      return { type: 'bearer', token: field(form, 'bearerToken') };
    case 'apiKey':
      return { type: 'apiKey', value: field(form, 'apiKeyValue'), ...(field(form, 'apiKeyHeader') ? { header: field(form, 'apiKeyHeader') } : {}) };
    case 'basic':
      return { type: 'basic', username: field(form, 'basicUser'), password: field(form, 'basicPassword') };
    case 'oauth2':
      return { type: 'oauth2', clientId: field(form, 'oauthClientId'), clientSecret: field(form, 'oauthClientSecret'), scopes: field(form, 'oauthScopes').split(/\s+/).filter(Boolean) };
    default:
      return undefined;
  }
}

/**
 * Creates an agent the person owns for their coding tool and shows its connection code once: the
 * token rides in a short-lived cookie (like join codes), never in the URL.
 */
export async function createConnection(form: FormData) {
  const client = field(form, 'client') || 'claude';
  const back = connectBack(client);
  // A2A agents may give their own server's URL: the hub then pushes messages to it instead of keeping a mailbox.
  const url = isEndpointClient(client) ? field(form, 'url') || undefined : undefined;
  const credential = url ? credentialFrom(form) : undefined;
  // An agent with a URL comes back with `check`: whether the hub could call it with that credential. Its hub
  // token isn't kept: answering needs none, and to start conversations it spends a pairing code for itself.
  const { agent, token, check } = await attempt(back, () =>
    hub<{ agent: Agent; token: string; check?: EndpointCheck }>('/agents/bots', { method: 'POST', body: { name: field(form, 'name'), url, credential, follow: true } }),
  );
  // With a URL, a pairing code for it comes along: the one-line command that lets it start conversations.
  const pair = agent.url ? await hub<{ code: string; expiresAt: string }>('/pairings', { method: 'POST', body: { agentId: agent.id } }).catch(() => undefined) : undefined;
  await setFlash('flash_connect', JSON.stringify({ id: agent.id, name: agent.name, client, ...(agent.url ? { url: agent.url, ...(pair ? { pair } : {}) } : { token }), ...(check ? { check } : {}) }));
  redirect(`${back}&created=${encodeURIComponent(agent.id)}`);
}

/** The owner changes their bot's description (same agent, same token). Names are fixed. */
export async function updateProfile(id: string, ws: string, form: FormData) {
  const back = agentHref(ws, id);
  await attempt(back, () => hub(`/agents/bots/${encodeURIComponent(id)}`, { method: 'PUT', body: { description: field(form, 'description') } }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Changes an A2A connection's URL or credential in place (same agent, same token); the hub checks it again. */
export async function updateConnection(id: string, ws: string, form: FormData) {
  const back = agentHref(ws, id);
  const credential = credentialFrom(form);
  await attempt(back, () =>
    hub(`/agents/bots/${encodeURIComponent(id)}`, { method: 'PUT', body: { url: field(form, 'url') || undefined, ...(credential !== undefined ? { credential } : {}) } }),
  );
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/**
 * A hub token for one of your connections, for a client that can't sign in with OAuth; shown once on its
 * page. It replaces the old token and ends the connection's OAuth sign-ins.
 */
export async function makeConnectionToken(id: string, ws: string) {
  const back = agentHref(ws, id);
  const { token } = await attempt(back, () => hub<{ token: string }>(`/agents/${encodeURIComponent(id)}/token`, { method: 'POST' }));
  await setFlash('flash_agent_token', JSON.stringify({ id, token }), back);
  redirect(`${back}?token=1`);
}

/** A one-time code for one of your connections, shown on its page as a one-line command that gives it a new token. */
export async function makeConnectionCode(id: string, ws: string) {
  const back = agentHref(ws, id);
  const pair = await attempt(back, () => hub<{ code: string; expiresAt: string }>('/pairings', { method: 'POST', body: { agentId: id } }));
  await setFlash('flash_agent_code', JSON.stringify({ id, ...pair }), back);
  redirect(`${back}?code=1`);
}

/** Has the hub call an A2A connection once more; the agent page then shows the problem, or none. */
export async function checkConnection(id: string, ws: string) {
  const back = agentHref(ws, id);
  await attempt(back, () => hub(`/agents/${encodeURIComponent(id)}/check`, { method: 'POST' }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** The Routine id in what was pasted (its address, or the id), as the hub reads it. */
const routineIdIn = (input: string) => /\/routines\/([A-Za-z0-9_-]+)/.exec(input)?.[1] ?? input.trim();

/**
 * Connect page: a Claude Code Routine (its id and API trigger token). The hub starts it once, and the agent its
 * session signs in as gets it; the page then waits for that (GET /routines), and ?routine= finds the agent after.
 */
export async function connectRoutine(form: FormData) {
  const back = connectBack('claudecloud');
  const { check } = await attempt(back, () => hub<{ check: WakeCheck }>('/routines', { method: 'POST', body: { routineId: field(form, 'routineId'), token: field(form, 'token') } }));
  // A new agent: it appears on the canvas of a workspace not known here.
  revalidatePath('/', 'layout');
  redirect(check.ok ? `${back}&routine=${encodeURIComponent(routineIdIn(field(form, 'routineId')))}` : back);
}

/**
 * Connect page: Grok. A new connection that the hub wakes through xAI's API with the person's key; setting it fires
 * once to check. A key xAI refuses leaves nothing behind.
 */
export async function connectGrok(form: FormData) {
  const back = connectBack('grok');
  const { agent } = await attempt(back, () => hub<{ agent: Agent }>('/agents/bots', { method: 'POST', body: { name: field(form, 'name'), follow: true } }));
  const id = encodeURIComponent(agent.id);
  const { check } = await attempt(back, () =>
    hub<{ check?: WakeCheck }>(`/agents/bots/${id}/wake`, { method: 'PUT', body: { type: 'xai', apiKey: field(form, 'apiKey') } }).catch(async (err) => {
      await hub(`/agents/${id}`, { method: 'DELETE' }).catch(() => {});
      throw err;
    }),
  );
  if (check && !check.ok) {
    await hub(`/agents/${id}`, { method: 'DELETE' }).catch(() => {});
    redirect(`${back}&error=${encodeURIComponent(check.problem ?? 'Grok could not be reached')}`);
  }
  // A new agent: it appears on the canvas of a workspace not known here.
  revalidatePath('/', 'layout');
  redirect(`${back}&agent=${id}`);
}

/**
 * Connect page: Grok Bot. The agent it signed in as gets its routine's webhook (URL and Authorization header) as its
 * wake; saving fires it once to check.
 */
export async function connectGrokBot(form: FormData) {
  const back = connectBack('grokbot');
  const id = encodeURIComponent(field(form, 'agent'));
  const body = { type: 'webhook', url: field(form, 'url'), authorization: field(form, 'authorization'), perConversation: true };
  const { check } = await attempt(back, () => hub<{ check?: WakeCheck }>(`/agents/bots/${id}/wake`, { method: 'PUT', body }));
  if (check && !check.ok) redirect(`${back}&error=${encodeURIComponent(check.problem ?? 'The webhook could not be reached')}`);
  // A new agent: it appears on the canvas of a workspace not known here.
  revalidatePath('/', 'layout');
  redirect(`${back}&agent=${id}`);
}

/** Agent page: the owner changes the Routine, Grok key, or wake webhook (or its token/secret), and the hub fires it once to check. */
export async function updateWake(id: string, ws: string, form: FormData) {
  const back = agentHref(ws, id);
  const type = field(form, 'type');
  const isWebhook = type === 'webhook' || Boolean(field(form, 'url'));
  const secret = field(form, 'secret');
  // Blank keeps the stored header; a new one replaces it.
  const authorization = field(form, 'authorization');
  const body =
    type === 'xai'
      ? { type: 'xai', apiKey: field(form, 'apiKey') }
      : isWebhook
        ? { type: 'webhook', url: field(form, 'url'), ...(secret ? { secret } : {}), ...(authorization ? { authorization } : {}) }
        : { routineId: field(form, 'routineId'), token: field(form, 'token') };
  await attempt(back, () => hub(`/agents/bots/${encodeURIComponent(id)}/wake`, { method: 'PUT', body }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Agent page: the owner's "Wake it now". How it went shows as its last fire. */
export async function wakeNow(id: string, ws: string) {
  const back = agentHref(ws, id);
  await attempt(back, () => hub(`/agents/bots/${encodeURIComponent(id)}/wake`, { method: 'POST' }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Chat with your hosted agent opened: wake its computer ahead of the first message. Best effort, nothing to show. */
export async function warmHostedAgent(id: string): Promise<void> {
  await hub(`/agents/bots/${encodeURIComponent(id)}/wake`, { method: 'POST' }).catch(() => {});
}

/** Owner removes a Routine or webhook wake from their mailbox bot. */
export async function removeWake(id: string, ws: string) {
  const back = agentHref(ws, id);
  await attempt(back, () => hub(`/agents/bots/${encodeURIComponent(id)}/wake`, { method: 'DELETE' }));
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Owner sets an optional per-agent Telegram bot token (from @BotFather) for native sender name & avatar in Telegram. */
export async function updateAgentTelegramBot(id: string, backPath: string, form: FormData) {
  const back = safeNext(backPath) ?? '/';
  await attempt(back, () =>
    hub(`/agents/${encodeURIComponent(id)}/telegram`, {
      method: 'PUT',
      body: { botToken: field(form, 'botToken') },
    }),
  );
  // The agent page and /account both show it; from /account the agent's workspace isn't known.
  revalidatePath('/', 'layout');
  redirect(back);
}

/** Owner removes an agent's optional Telegram bot token so it falls back to @ParlyBot. */
export async function removeAgentTelegramBot(id: string, backPath: string) {
  const back = safeNext(backPath) ?? '/';
  await attempt(back, () => hub(`/agents/${encodeURIComponent(id)}/telegram`, { method: 'DELETE' }));
  // The agent page and /account both show it; from /account the agent's workspace isn't known.
  revalidatePath('/', 'layout');
  redirect(back);
}

/**
 * A one-time pairing code the person gives their agent (the plugin, or any
 * agent told what to do with it). Shown on this page view only; it holds no token.
 */
export async function createPairing(form: FormData) {
  const client = field(form, 'client') || 'claude';
  const back = connectBack(client);
  const { code, expiresAt } = await attempt(back, () => hub<{ code: string; expiresAt: string }>('/pairings', { method: 'POST', body: { name: field(form, 'name') } }));
  await setFlash('flash_pair', JSON.stringify({ code, expiresAt, name: field(form, 'name') }));
  redirect(`${back}&paired=${encodeURIComponent(code)}`);
}

/** Deletes a bot the person owns; its token stops working at once. */
export async function revokeConnection(ws: string, id: string, client: string) {
  // Back into this workspace's dialog (not /connect, which remounts the whole window).
  const back = `${wsHref(ws)}/connect?client=${encodeURIComponent(client)}`;
  await attempt(back, () => hub(`/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  // Deleting takes the agent off the canvas of every workspace it's in.
  revalidatePath('/', 'layout');
  redirect(back);
}

/** Connect page: a signed-in person asks for a client the page doesn't offer yet. */
export async function requestClient(form: FormData) {
  const client = field(form, 'client') || 'claude';
  const back = connectBack(client);
  await attempt(back, () => hub('/client-requests', { method: 'POST', body: { text: field(form, 'text') } }));
  redirect(`${back}&requested=1`);
}

/** Owner or workspace owner: archive or restore a bot (`back` is a path on this site). */
export async function setArchived(back: string, agent: string, archived: boolean) {
  const to = safeNext(back) ?? '/';
  await attempt(to, () => hub(`/agents/${encodeURIComponent(agent)}/archive`, { method: archived ? 'POST' : 'DELETE' }));
  // Archiving takes the agent off the canvas of every workspace it's in.
  revalidatePath('/', 'layout');
}

/** Hires a hosted agent that runs on its own computer on Parly and opens your DM with it. */
export async function hireAgent(ws: string, back: string, form: FormData) {
  const to = safeNext(back) ?? wsHref(ws, { hire: '1' });
  const { agent } = await attempt(to, () =>
    hub<{ agent: Agent }>('/agents/hire', {
      method: 'POST',
      body: { name: field(form, 'name'), workspaceId: ws },
    }),
  );
  revalidatePath(wsHref(ws), 'layout');
  redirect(dmHref(ws, agent.id));
}

/** Hire an agent (Connect → Hire): a name and a type, a cloud agent or (Pro) one with its own computer. */
export async function hireByType(ws: string, form: FormData) {
  const back = `${wsHref(ws)}/connect?client=cloud`;
  return form.get('type') === 'computer' ? hireAgent(ws, back, form) : createCloudAgent(ws, form);
}

/** Makes a cloud agent (no computer: it thinks and writes, on Parly) in this workspace and opens your DM with it. */
async function createCloudAgent(ws: string, form: FormData) {
  const { agent } = await attempt(`${wsHref(ws)}/connect?client=cloud`, () =>
    hub<{ agent: Agent }>('/agents/cloud', { method: 'POST', body: { name: field(form, 'name'), description: field(form, 'description'), workspaceId: ws, channelId: field(form, 'channelId') } }),
  );
  revalidatePath(wsHref(ws), 'layout');
  // Next step: give it tools (its profile's Tools, with a way to skip), when this hub offers them.
  const tools = await hub<{ available: boolean }>('/me/tools').catch(() => ({ available: false }));
  redirect(tools.available ? `${agentHref(ws, agent.id)}?hired=1#tools` : dmHref(ws, agent.id));
}


