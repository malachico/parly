'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { hub, HUB_URL, safeNext, type Agent, type Schedule, type ProcessStepView, type SkillDetailView, type SkillScope, type SkillType } from '../hub';
import { agentHref, appsHref, skillsHref, triggersHref, wsHref } from '../routes';
import { siteOrigin } from '../site';
import { newSkillScope } from '../skillScope';
import { agentPage, attempt, channelDetails, field, setFlash, workspaceDetails } from './helpers';

// ---- webhooks & schedules ---------------------------------------------------------------

/**
 * Channel panel: an incoming webhook (not an agent: it posts as me, marked 🪝). Its URL carries its token, so it's
 * shown once (flash cookie); deleting it revokes it.
 */
export async function createWebhook(ws: string, channelId: string, form: FormData) {
  const back = channelDetails(ws, channelId);
  const { token } = await attempt(back, () => hub<{ token: string }>(`/channels/${encodeURIComponent(channelId)}/webhooks`, { method: 'POST', body: { name: field(form, 'name') } }));
  await setFlash('flash_webhook', JSON.stringify({ channelId, url: `${HUB_URL}/hooks/${channelId}/${token}` }));
  // A webhook shows on the crew canvas, in the workspace layout.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

export async function deleteWebhook(ws: string, channelId: string, id: string) {
  await attempt(channelDetails(ws, channelId), () => hub(`/webhooks/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  // A webhook shows on the crew canvas, in the workspace layout.
  revalidatePath(wsHref(ws), 'layout');
}

/** A schedule form's fields, as the hub takes them. */
function scheduleBody(form: FormData) {
  return { text: field(form, 'text'), repeat: field(form, 'repeat'), time: field(form, 'time'), date: field(form, 'date'), day: field(form, 'day'), minutes: field(form, 'minutes'), tz: field(form, 'tz') };
}

/** Edits a scheduled message's text and timing (its owner, their agents, or a channel owner). `back`: a path on this site. */
export async function updateSchedule(back: string, id: string, form: FormData) {
  const to = safeNext(back) ?? '/';
  await attempt(to, () => hub(`/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: scheduleBody(form) }));
  // `back` may be any page; the crew canvas lists schedules too, and the workspace isn't known here.
  revalidatePath('/', 'layout');
  redirect(to);
}

/** Pauses or resumes a scheduled message. */
export async function setScheduleActive(back: string, id: string, active: boolean) {
  await attempt(safeNext(back) ?? '/', () => hub(`/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: { active } }));
  // `back` may be any page; the crew canvas lists schedules too, and the workspace isn't known here.
  revalidatePath('/', 'layout');
}

/** A channel's scheduled messages (members), for a thread's next-scheduled line; [] when they can't be read. */
export async function threadSchedules(channelId: string): Promise<Schedule[]> {
  return hub<Schedule[]>(`/channels/${encodeURIComponent(channelId)}/schedules`).catch(() => []);
}

export async function deleteSchedule(back: string, id: string) {
  await attempt(safeNext(back) ?? '/', () => hub(`/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  // `back` may be any page; the crew canvas lists schedules too, and the workspace isn't known here.
  revalidatePath('/', 'layout');
}

// ---- Slack ------------------------------------------------------------------------------

/** Workspace settings: starts Slack OAuth v2 installation for this workspace (or the caller's side in a shared room). */
export async function connectSlack(ws: string) {
  const back = workspaceDetails(ws);
  const { url } = await attempt(back, () =>
    hub<{ url: string }>('/slack/install', { method: 'POST', body: { workspaceId: ws } }),
  );
  redirect(url);
}


/** New workspace: connects a Slack workspace, and the Parly workspace is made from it (its name) when Slack says yes. */
export async function connectSlackNew() {
  const { url } = await attempt('/?workspace=new', () => hub<{ url: string }>('/slack/install', { method: 'POST', body: { workspaceId: '' } }));
  redirect(url);
}

/** Channel panel: links a Parly channel to a Slack channel (or in a room, both shared + private corner for the side). */
export async function linkChannelSlack(ws: string, channelId: string, form: FormData) {
  const back = channelDetails(ws, channelId);
  const slackChannel = field(form, 'slackChannel');
  const cornerSlackChannel = field(form, 'cornerSlackChannel');
  await attempt(back, () =>
    hub(`/channels/${encodeURIComponent(channelId)}/slack`, {
      method: 'POST',
      body: {
        channelId: slackChannel,
        ...(cornerSlackChannel ? { cornerChannelId: cornerSlackChannel } : {}),
      },
    }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Channel panel: unlinks a Parly channel from Slack (in a room, unlinks the caller's side from shared + corner). */
export async function unlinkChannelSlack(ws: string, channelId: string) {
  const back = channelDetails(ws, channelId);
  await attempt(back, () =>
    hub(`/channels/${encodeURIComponent(channelId)}/slack`, { method: 'DELETE' }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** One-time Slack identity approval (/slack/link?code=): binds the Slack user to the signed-in Parly person. */
export async function approveSlackLink(form: FormData) {
  const code = field(form, 'code');
  const answer = field(form, 'answer');
  if (answer === 'deny') {
    redirect('/slack/link?denied=1');
  }
  const back = `/slack/link?code=${encodeURIComponent(code)}`;
  const { teamName } = await attempt(back, () =>
    hub<{ teamName: string }>('/slack/link', { method: 'POST', body: { code } }),
  );
  revalidatePath('/slack/link');
  revalidatePath('/account');
  redirect(`/slack/link?done=${encodeURIComponent(teamName)}`);
}

/** Account settings: unlinks the signed-in person's Slack identity in `teamId`. */
export async function unlinkMySlack(teamId: string) {
  await attempt('/account', () => hub(`/me/slack/${encodeURIComponent(teamId)}`, { method: 'DELETE' }));
  revalidatePath('/account');
  redirect('/account');
}

// ---- Telegram ---------------------------------------------------------------------------

function telegramLinkBody(form: FormData) {
  const chatId = field(form, 'chatId');
  const topicId = field(form, 'topicId');
  return {
    ...(chatId ? { chatId } : {}),
    ...(topicId ? { topicId } : {}),
  };
}

/** Workspace settings: connects a Telegram supergroup (`chatId` or `t.me/c/…` link) to this workspace. */
export async function connectWorkspaceTelegram(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  const chatId = field(form, 'chatId');
  const title = field(form, 'title');
  await attempt(back, () =>
    hub(`/workspaces/${encodeURIComponent(ws)}/telegram`, {
      method: 'POST',
      body: {
        chatId,
        ...(title ? { title } : {}),
      },
    }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Workspace settings: disconnects a Telegram supergroup from this workspace. */
export async function disconnectWorkspaceTelegram(ws: string, chatId?: string) {
  const back = workspaceDetails(ws);
  await attempt(back, () =>
    hub(`/workspaces/${encodeURIComponent(ws)}/telegram`, {
      method: 'DELETE',
      body: {
        ...(chatId ? { chatId } : {}),
      },
    }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}

/** Links a Parly channel to a Telegram topic; a hub error goes back to `back`. */
async function linkTelegram(ws: string, back: string, channelId: string, form: FormData) {
  await attempt(back, () =>
    hub(`/channels/${encodeURIComponent(channelId)}/telegram`, {
      method: 'POST',
      body: telegramLinkBody(form),
    }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
}

/** Unlinks a Parly channel from a Telegram chat/topic (or all Telegram links when omitted); a hub error goes back to `back`. */
async function unlinkTelegram(ws: string, back: string, channelId: string, chatId?: string, topicId?: number) {
  await attempt(back, () =>
    hub(`/channels/${encodeURIComponent(channelId)}/telegram`, {
      method: 'DELETE',
      body: {
        ...(chatId ? { chatId } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
      },
    }),
  );
  // The crew canvas in the workspace layout shows the workspace's Slack/Telegram links.
  revalidatePath(wsHref(ws), 'layout');
}

/** Workspace settings: maps a Parly channel in the workspace to a Telegram forum topic. */
export async function linkWorkspaceChannelTelegram(ws: string, form: FormData) {
  const back = workspaceDetails(ws);
  await linkTelegram(ws, back, field(form, 'channelId'), form);
  redirect(back);
}

/** Workspace settings: unlinks a Parly channel from a Telegram topic inside workspace settings. */
export async function unlinkWorkspaceChannelTelegram(ws: string, channelId: string, chatId?: string, topicId?: number) {
  const back = workspaceDetails(ws);
  await unlinkTelegram(ws, back, channelId, chatId, topicId);
  redirect(back);
}

/** Channel panel: links a Parly channel to a Telegram topic (using the workspace's connected supergroup or an explicit `chatId`). */
export async function linkChannelTelegram(ws: string, channelId: string, form: FormData) {
  await linkTelegram(ws, channelDetails(ws, channelId), channelId, form);
}

/** Channel panel: unlinks a Parly channel from a Telegram chat/topic (or all Telegram links when omitted). */
export async function unlinkChannelTelegram(ws: string, channelId: string, chatId?: string, topicId?: number) {
  await unlinkTelegram(ws, channelDetails(ws, channelId), channelId, chatId, topicId);
}

/** Account settings: generates a one-time `/start <code>` command to link the signed-in person's Telegram identity. */
export async function generateTelegramLinkCode() {
  const { code } = await attempt('/account', () =>
    hub<{ code: string }>('/telegram/link/code', { method: 'POST' }),
  );
  redirect(`/account?tgCode=${encodeURIComponent(code)}`);
}

/** One-time Telegram identity approval (/telegram/link?code=): binds the Telegram user to the signed-in Parly person. */
export async function approveTelegramLink(form: FormData) {
  const code = field(form, 'code');
  const answer = field(form, 'answer');
  if (answer === 'deny') {
    redirect('/telegram/link?denied=1');
  }
  const back = `/telegram/link?code=${encodeURIComponent(code)}`;
  const linked = await attempt(back, () =>
    hub<{ telegramUserId: string; username?: string; name?: string }>('/telegram/link', { method: 'POST', body: { code } }),
  );
  revalidatePath('/telegram/link');
  revalidatePath('/account');
  const label = linked.username ? `@${linked.username}` : linked.name ?? linked.telegramUserId;
  redirect(`/telegram/link?done=${encodeURIComponent(label)}`);
}

/** Account settings: unlinks the signed-in person's Telegram identity. */
export async function unlinkMyTelegram(telegramUserId: string) {
  await attempt('/account', () => hub(`/me/telegram/${encodeURIComponent(telegramUserId)}`, { method: 'DELETE' }));
  revalidatePath('/account');
  redirect('/account');
}

// ---- Composio tools & triggers ----------------------------------------------------------

/** Connects one of your accounts (GitHub, Gmail, ...) for your cloud agents: off to Composio's sign-in, then back here with that toolkit turned on for this agent. */
export async function connectTool(ws: string, agentId: string, toolkit: string, form?: FormData) {
  const back = agentPage(ws, agentId, form, '');
  const { url } = await attempt(back, async () => {
    const existing = await hub<Agent>(`/agents/${encodeURIComponent(agentId)}`).catch(() => undefined);
    if (existing && existing.kind !== 'human' && !existing.webhookChannel) {
      const next = [...new Set([...(existing.tools?.toolkits ?? []), toolkit])];
      await hub(`/agents/${encodeURIComponent(agentId)}/tools`, { method: 'PUT', body: { toolkits: next, act: Boolean(existing.tools?.act) } }).catch(() => {});
    }
    return hub<{ url: string }>(`/me/tools/${encodeURIComponent(toolkit)}/connect`, { method: 'POST', body: { callbackUrl: `${await siteOrigin()}${back}` } });
  });
  redirect(url);
}

/** Disconnects one of your accounts: none of your agents can use it any more. The page updates in place. */
export async function disconnectTool(ws: string, agentId: string, accountId: string, form?: FormData) {
  const back = agentPage(ws, agentId, form, '#tools');
  await attempt(back, () => hub(`/me/tools/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }));
  revalidatePath(agentHref(ws, agentId));
}

/** Which of your toolkits a cloud agent may use, and whether it may act (send, create, delete) or only read. The page updates in place. */
export async function saveAgentTools(ws: string, agentId: string, form: FormData) {
  const back = agentPage(ws, agentId, form, '#tools');
  await attempt(back, () => hub(`/agents/${encodeURIComponent(agentId)}/tools`, { method: 'PUT', body: { toolkits: form.getAll('toolkit').map(String), act: form.get('act') === 'on' } }));
  revalidatePath(agentHref(ws, agentId));
}

function triggerBody(slug: string, form: FormData) {
  const config: Record<string, string | boolean> = {};
  for (const [k, v] of form.entries()) if (k.startsWith('cfg.') && typeof v === 'string') config[k.slice(4)] = v === 'on' ? true : v;
  return {
    slug,
    config,
    from: field(form, 'from'),
    subject: field(form, 'subject'),
    contains: field(form, 'contains'),
    channelId: field(form, 'channelId'),
    task: field(form, 'task') || undefined,
  };
}

/** Turns on a trigger of type `slug` for an agent: its settings are the form's `cfg.*` fields. */
export async function createTrigger(ws: string, agentId: string, slug: string, form: FormData) {
  const back = agentPage(ws, agentId, form, '#when');
  await attempt(agentPage(ws, agentId, form, '#when', { trigger: slug }), () =>
    hub(`/agents/${encodeURIComponent(agentId)}/triggers`, {
      method: 'POST',
      body: {
        ...triggerBody(slug, form),
        grantTool: form.get('grantTool') !== null,
      },
    }),
  );
  revalidatePath(agentHref(ws, agentId));
  redirect(back);
}

export async function deleteTrigger(ws: string, agentId: string, id: string, form?: FormData) {
  const back = agentPage(ws, agentId, form, '#when');
  await attempt(back, () => hub(`/agents/${encodeURIComponent(agentId)}/triggers/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  revalidatePath(agentHref(ws, agentId));
  redirect(back);
}

// ---- Apps & triggers (/w/{ws}/apps, /w/{ws}/triggers): your apps and triggers, from their side -------------------

/** Lets one of your agents use an app (or not), keeping its read / act setting. */
export async function setAgentApp(ws: string, agentId: string, toolkit: string, on: boolean) {
  await attempt(appsHref(ws, toolkit), async () => {
    const agent = await hub<Agent>(`/agents/${encodeURIComponent(agentId)}`);
    const current = agent.tools?.toolkits ?? [];
    const toolkits = on ? [...new Set([...current, toolkit])] : current.filter((t) => t !== toolkit);
    await hub(`/agents/${encodeURIComponent(agentId)}/tools`, { method: 'PUT', body: { toolkits, act: Boolean(agent.tools?.act) } });
  });
  revalidatePath(appsHref(ws), 'layout');
}

/** Lets one of your agents act with its apps (send, create, change), or only read. It's per agent: all its apps. */
export async function setAgentAct(ws: string, agentId: string, toolkit: string, act: boolean) {
  await attempt(appsHref(ws, toolkit), async () => {
    const agent = await hub<Agent>(`/agents/${encodeURIComponent(agentId)}`);
    await hub(`/agents/${encodeURIComponent(agentId)}/tools`, { method: 'PUT', body: { toolkits: agent.tools?.toolkits ?? [], act } });
  });
  revalidatePath(appsHref(ws), 'layout');
}

/** Connects an app from the Apps page (a new one, or again after its connection was removed or expired); back to its page after. */
export async function reconnectApp(ws: string, toolkit: string) {
  const back = appsHref(ws, toolkit);
  const { url } = await attempt(back, async () =>
    hub<{ url: string }>(`/me/tools/${encodeURIComponent(toolkit)}/connect`, { method: 'POST', body: { callbackUrl: `${await siteOrigin()}${back}` } }),
  );
  redirect(url);
}

/** Disconnects one of your app accounts: none of your agents can use it any more. */
export async function disconnectApp(ws: string, accountId: string) {
  await attempt(appsHref(ws), () => hub(`/me/tools/accounts/${encodeURIComponent(accountId)}`, { method: 'DELETE' }));
  revalidatePath(appsHref(ws), 'layout');
}

/** Triggers panel: turns on a trigger of type `slug` for the agent picked in the form (its settings are `cfg.*`), then back to the list. */
export async function addTrigger(ws: string, slug: string, form: FormData) {
  const back = `${triggersHref(ws)}/new?type=${encodeURIComponent(slug)}`;
  const agentId = field(form, 'agentId');
  if (!agentId) redirect(`${back}&error=${encodeURIComponent('Pick the agent that should hear about it')}`);
  await attempt(back, () =>
    hub(`/agents/${encodeURIComponent(agentId)}/triggers`, {
      method: 'POST',
      body: triggerBody(slug, form),
    }),
  );
  revalidatePath(triggersHref(ws), 'layout');
  redirect(triggersHref(ws));
}

/**
 * Triggers → On a schedule: wakes an agent at set times with what to do, in its DM with you (sent as you) or in a
 * channel (the agent's own trigger: posted as it, with ⏰).
 */
export async function addScheduleTrigger(ws: string, form: FormData) {
  const back = `${triggersHref(ws)}/new?type=schedule`;
  const agentId = field(form, 'agentId');
  if (!agentId) redirect(`${back}&error=${encodeURIComponent('Pick the agent to wake')}`);
  const channelId = field(form, 'channelId');
  const body = scheduleBody(form);
  await attempt(back, () =>
    hub(channelId ? `/channels/${encodeURIComponent(channelId)}/schedules` : `/agents/${encodeURIComponent(agentId)}/schedules`, { method: 'POST', body: channelId ? { ...body, agent: agentId } : body }),
  );
  revalidatePath(triggersHref(ws), 'layout');
  redirect(triggersHref(ws));
}

/** Turns one listener of a trigger on or off. */
export async function setListenerOn(ws: string, sourceId: string, listenerId: string, enabled: boolean) {
  await attempt(triggersHref(ws, sourceId), () => hub(`/me/triggers/${encodeURIComponent(sourceId)}/listeners/${encodeURIComponent(listenerId)}`, { method: 'PATCH', body: { enabled } }));
  revalidatePath(triggersHref(ws), 'layout');
}

/** Adds a listener: one of your agents (its DM), a channel, or both (in the channel, mentioning the agent). */
export async function addTriggerListener(ws: string, sourceId: string, form: FormData) {
  await attempt(triggersHref(ws, sourceId), () =>
    hub(`/me/triggers/${encodeURIComponent(sourceId)}/listeners`, {
      method: 'POST',
      body: {
        agentId: field(form, 'agentId') || undefined,
        channelId: field(form, 'channelId') || undefined,
        filter: { contains: field(form, 'contains') || undefined },
        task: field(form, 'task') || undefined,
      },
    }),
  );
  revalidatePath(triggersHref(ws), 'layout');
}

/** Turns a whole trigger off (kept, with its history) or back on. */
export async function setTriggerOn(ws: string, sourceId: string, on: boolean) {
  await attempt(triggersHref(ws, sourceId), () =>
    on ? hub(`/me/triggers/${encodeURIComponent(sourceId)}/restore`, { method: 'POST' }) : hub(`/me/triggers/${encodeURIComponent(sourceId)}`, { method: 'DELETE' }),
  );
  revalidatePath(triggersHref(ws), 'layout');
}

// ---- Skills & Processes Library ---------------------------------------------------------

/** Parses ordered process steps from the ProcessStepsEditor form fields. */
function parseProcessStepsForm(form: FormData): Omit<ProcessStepView, 'skillName'>[] {
  const roles = form.getAll('step_role').map((v) => String(v ?? '').trim());
  const actions = form.getAll('step_action').map((v) => String(v ?? '').trim());
  const outputs = form.getAll('step_output').map((v) => String(v ?? '').trim());
  const transitions = form.getAll('step_transition').map((v) => String(v ?? '').trim());
  const skillIds = form.getAll('step_skillId').map((v) => String(v ?? '').trim());
  const count = Math.max(roles.length, actions.length, outputs.length, transitions.length);
  const steps: Omit<ProcessStepView, 'skillName'>[] = [];
  for (let i = 0; i < count; i++) {
    const role = roles[i] ?? '';
    const action = actions[i] ?? '';
    const output = outputs[i] ?? '';
    const transition = transitions[i] ?? '';
    const skillId = skillIds[i] || undefined;
    if (!role && !action && !output && !transition) continue;
    steps.push({
      order: steps.length + 1,
      role,
      action,
      output,
      transition,
      ...(skillId ? { skillId } : {}),
    });
  }
  return steps;
}

function skillContentBody(type: SkillType, form: FormData) {
  return type === 'process'
    ? { steps: parseProcessStepsForm(form) }
    : { instructions: String(form.get('instructions') ?? '').trim() };
}

/** Creates a skill or process in the Library, with optional immediate attachment to the workspace or a target scope. */
export async function createSkillAction(ws: string, form: FormData) {
  const type = (field(form, 'type') === 'process' ? 'process' : 'skill') as SkillType;
  const targetScope = field(form, 'targetScope') as SkillScope | '';
  const targetId = field(form, 'targetId');
  const attachWorkspace = form.get('attachWorkspace') === 'on';
  const backParams: Record<string, string | undefined> = {
    type,
    ...(targetScope ? { scope: targetScope } : {}),
    ...(targetId ? { scopeId: targetId } : {}),
  };
  const back = skillsHref(ws, 'new', backParams);

  const primary = newSkillScope(ws, targetScope, targetId, attachWorkspace);

  const created = await attempt(back, async () => {
    const res = await hub<SkillDetailView>('/me/skills', {
      method: 'POST',
      body: {
        name: field(form, 'name'),
        description: field(form, 'description'),
        type,
        ...skillContentBody(type, form),
        ...primary,
      },
    });
    if (attachWorkspace && primary?.scope !== 'workspace') {
      await hub(`/workspaces/${encodeURIComponent(ws)}/skills/${encodeURIComponent(res.id)}`, { method: 'POST' });
    }
    return res;
  });

  // A new Library skill is the person's, shared by every workspace they're in.
  revalidatePath('/', 'layout');
  const returnTo = safeNext(field(form, 'returnTo'));
  redirect(returnTo ?? skillsHref(ws, created.id));
}

/** Updates an existing skill or process (type is locked after creation). */
export async function updateSkillAction(ws: string, skillId: string, type: SkillType, form: FormData) {
  const back = skillsHref(ws, skillId);
  await attempt(back, () =>
    hub<SkillDetailView>(`/me/skills/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      body: {
        name: field(form, 'name'),
        description: field(form, 'description'),
        ...skillContentBody(type, form),
      },
    }),
  );
  // A Library skill is the person's, shared by every workspace they're in.
  revalidatePath('/', 'layout');
  redirect(back);
}

/** Deletes a skill or process from the Library and detaches it from all scopes. */
export async function deleteSkillAction(ws: string, skillId: string) {
  const back = skillsHref(ws, skillId);
  await attempt(back, () => hub(`/me/skills/${encodeURIComponent(skillId)}`, { method: 'DELETE' }));
  // A Library skill is the person's, shared by every workspace they're in.
  revalidatePath('/', 'layout');
  redirect(skillsHref(ws));
}

/** Attaches (`enabled = true`) or detaches (`enabled = false`) a skill/process on an agent, channel, or workspace. */
export async function setScopeSkillOn(ws: string, scope: SkillScope, targetId: string, skillId: string, enabled: boolean, backHref?: string) {
  const path = scope === 'agent' ? 'agents' : scope === 'channel' ? 'channels' : 'workspaces';
  const back = safeNext(backHref) ?? skillsHref(ws);
  await attempt(back, () =>
    hub(`/${path}/${encodeURIComponent(targetId)}/skills/${encodeURIComponent(skillId)}`, {
      method: enabled ? 'POST' : 'DELETE',
    }),
  );
  // Skills show on agent, channel and skills pages across the workspace.
  revalidatePath(wsHref(ws), 'layout');
}

/** Attaches a skill/process from its Library detail page to a selected agent or channel. */
export async function attachSkillFromLibrary(ws: string, skillId: string, scope: 'agent' | 'channel', form: FormData) {
  const back = skillsHref(ws, skillId);
  const targetId = field(form, 'targetId');
  if (!targetId) redirect(`${back}?error=${encodeURIComponent(`Pick a ${scope} first`)}`);
  const path = scope === 'agent' ? 'agents' : 'channels';
  await attempt(back, () =>
    hub(`/${path}/${encodeURIComponent(targetId)}/skills/${encodeURIComponent(skillId)}`, {
      method: 'POST',
    }),
  );
  // Skills show on agent, channel and skills pages across the workspace.
  revalidatePath(wsHref(ws), 'layout');
  redirect(back);
}



