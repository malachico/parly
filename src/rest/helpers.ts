import type { NextFunction, Request, Response } from 'express';
import type { HubService } from '../hub/hubService.js';
import { channelView, messageView, workspaceView } from '../lib/present.js';
import type { AgentRecord } from '../registry/types.js';
import type { MessageDoc } from '../chat/chat.js';
import { describe, type ScheduleRecord } from '../hub/schedules.js';
import type { WebhookRecord } from '../hub/webhooks.js';
import { textOf } from '../lib/wire.js';

type Handler = (req: Request, res: Response) => Promise<unknown>;

/** Wraps an async handler so its result is sent as JSON and errors reach the error middleware. */
export const json = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).then((body) => res.json(body), next);
};


/** A webhook as members see it: never its token or hash. */
export function webhookView(w: WebhookRecord) {
  const { tokenHash: _t, ...rest } = w;
  return rest;
}

/** A scheduled message as the API shows it, with `when` in words. */
export function scheduleView(s: ScheduleRecord) {
  const { botId: _b, ...rest } = s;
  return { ...rest, when: describe(s) };
}

/**
 * A message as anyone may see it in a public channel: who, what text, when, and the hub files attached to it
 * (GET /public/channels/:id/files/:file). Not its data or mentions.
 */
export function publicMessageView(m: MessageDoc) {
  const files = m.parts.flatMap((p) =>
    typeof p.metadata?.fileId === 'string' ? [{ id: p.metadata.fileId, ...(p.filename ? { name: p.filename } : {}), ...(p.mediaType ? { mediaType: p.mediaType } : {}) }] : [],
  );
  return {
    id: m.id,
    ...(m.replyTo ? { replyTo: m.replyTo } : {}),
    seq: m.seq,
    from: m.from,
    fromId: m.fromId,
    text: textOf({ parts: m.parts }),
    at: m.at,
    ...(m.post ? { thread: m.post } : {}),
    ...(files.length ? { files } : {}),
  };
}

/** Names, avatars and what each agent runs on (cloud / computer) of who wrote in a public channel; no live presence. */
export async function publicPeople(hub: HubService, ids: string[]) {
  const agents = await hub.registry.getMany([...new Set(ids)]);
  return Object.fromEntries(
    agents.map((a) => [a.id, { id: a.id, name: a.name, kind: a.kind === 'human' ? 'human' : 'bot', ...(a.avatar ? { avatar: a.avatar } : {}), ...(a.webhookChannel ? { webhookChannel: a.webhookChannel } : {}), ...(a.cloud ? { cloud: true } : {}), ...(a.hosted ? { hosted: true } : {}) }]),
  );
}

/** A webhook's body as message text: Slack's fields, a line for a GitHub event, or else the JSON itself. */
export function hookText(body: unknown, githubEvent?: string): string {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  if (githubEvent) {
    const subject = obj(b[githubEvent]) ?? obj(b.pull_request) ?? obj(b.issue) ?? {};
    const head = obj(b.head_commit);
    const repo = obj(b.repository);
    const what = [githubEvent, b.action, subject.conclusion, typeof b.ref === 'string' ? b.ref.replace(/^refs\/heads\//, '') : undefined].filter(Boolean).join(' ');
    const title = subject.title ?? subject.name ?? (typeof head?.message === 'string' ? head.message.split('\n')[0] : undefined);
    const url = subject.html_url ?? b.compare ?? repo?.html_url;
    return [`GitHub ${what}${typeof repo?.full_name === 'string' ? ` on ${repo.full_name}` : ''}`, title, url].filter(Boolean).join('\n');
  }
  if (typeof b.text === 'string' && b.text) return b.text;
  const slack = [
    ...(Array.isArray(b.attachments) ? b.attachments.map((a) => obj(a)?.text ?? obj(a)?.fallback) : []),
    ...(Array.isArray(b.blocks) ? b.blocks.map((x) => obj(obj(x)?.text)?.text) : []),
  ].filter((t) => typeof t === 'string' && t);
  if (slack.length) return slack.join('\n');
  // ponytail: raw JSON for services without Slack's shape; add an adapter when one is common enough to want prettier.
  return '```json\n' + (JSON.stringify(body, null, 2) ?? '').slice(0, 4000) + '\n```';
}

/** The caller's workspaces, each with the channels they are in there (GET /me). A room an app opened names its app. */
export async function myWorkspaces(hub: HubService, me: AgentRecord) {
  const [workspaces, channels] = await Promise.all([hub.registry.workspacesOf(me), hub.registry.channelsOf(me)]);
  const appIds = [...new Set(workspaces.flatMap((w) => (w.room?.appId ? [w.room.appId] : [])))];
  const apps = new Map((await Promise.all(appIds.map((id) => hub.apps.get(id)))).flatMap((a) => (a ? [[a.id, { id: a.id, name: a.name, workspaceId: a.workspaceId }] as const] : [])));
  // ponytail: one member+invite read per workspace; denormalize a seat count if GET /me gets slow.
  const usage = await Promise.all(workspaces.map((w) => hub.registry.workspaceUsage(w, me)));
  return workspaces.map((w, i) => {
    const { count, max } = usage[i]!;
    const participants = { count, max };
    const view = workspaceView(w, me, { channels: channels.filter((c) => c.workspaceId === w.id).map((c) => channelView(c, me, w)), participants });
    const app = w.room?.appId ? apps.get(w.room.appId) : undefined;
    return view.room && app ? { ...view, room: { ...view.room, app } } : view;
  });
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The most messages one page returns; the web app grows its page up to the same number. */
const PAGE_MAX = 1000;

export const limitOf = (v: unknown) => Math.min(Math.max(Number(v) || 50, 1), PAGE_MAX);
export const seqOf = (v: unknown) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : undefined);

/** A conversation page as the API returns it. */
export function pageView(p: Awaited<ReturnType<HubService['chat']['page']>>) {
  return { ...p, messages: p.messages.map(messageView) };
}


/** A side's setup from a request body: its name, the caller's bots that represent it (or `ownAgent`), its private brief. */
export function roomSetup(body: Record<string, unknown>) {
  return {
    side: str(body.side) ?? '',
    bots: Array.isArray(body.bots) ? body.bots.filter((b): b is string => typeof b === 'string') : [],
    brief: str(body.brief) ?? '',
    ownAgent: body.ownAgent === true,
  };
}
