import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { THREAD_READ_DEFAULT, THREAD_READ_MAX, threadKey } from '../chat/chat.js';
import { pick } from '../hub/cloudTools.js';
import type { HubService } from '../hub/hubService.js';
import { BoundedMap } from '../lib/boundedMap.js';
import { HubError } from '../lib/errors.js';
import { messageView, skillSummaryView, CONTEXT_NOTE, PROCESS_NOTE, SKILLS_NOTE } from '../lib/present.js';
import type { AgentRecord } from '../registry/types.js';

type MessagingToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
  publicNote: (channelId?: string, thread?: string) => Promise<Record<string, unknown>>;
  whenToReply: (items: unknown) => string | undefined;
  calls: { getStore(): { idleWait?: boolean; skipPending?: boolean } | undefined };
};

const BOILERPLATE = ['channelContext', 'channelContextNote', 'skills', 'skillsNote', 'processes', 'processesNote'] as const;
const SEEN_TTL_MS = 60 * 60_000;
// ponytail: per-instance memory of which conversations an agent was already shown the channel context, skills and processes in (by check_inbox,
// wait_for_message or read_thread); another Cloud Run instance, an eviction or SEEN_TTL_MS just sends them again, a skills change alone does not
// within SEEN_TTL_MS, and any fresh session of the agent (a restarted worker, a memoryless `claude -p` loop) goes up to SEEN_TTL_MS without them. A per-session key
// if that matters (the MCP transport is stateless, so there is no session id yet).
const seen = new BoundedMap<string, { context: string; at: number; rules: boolean }>(50_000);

/** The agent's memory of this conversation, if it was shown the boilerplate with this channel context within SEEN_TTL_MS. */
function shown(agentId: string, conversation: string, context: unknown, now: number) {
  const hit = seen.get(`${agentId}|${conversation}`);
  return hit && hit.context === String(context ?? '') && now - hit.at < SEEN_TTL_MS ? hit : undefined;
}

/** Drops the boilerplate from items whose conversation already showed this agent the same; true if any item still needs the reply rules. */
function firstViews(agentId: string, views: Array<Record<string, unknown>>, now: number): boolean {
  let fresh = false;
  for (const v of views) {
    let entry = shown(agentId, String(v.conversation), v.channelContext, now);
    if (entry) for (const k of BOILERPLATE) delete v[k];
    else seen.set(`${agentId}|${String(v.conversation)}`, (entry = { context: String(v.channelContext ?? ''), at: now, rules: false }));
    if (!entry.rules) fresh = entry.rules = true;
  }
  return fresh;
}

/** Optional `fields` on list-style tools: run_tool's projection, so an agent can ask for less. */
export const fieldsArg = z.array(z.string()).optional().describe('Only these fields of each item, e.g. ["id", "text"]; omit for everything.');
export const project = (result: unknown, fields?: string[]) => (fields?.length ? pick(result, fields) : result);

/** Registers send_message…wait_for_message (moved out of server.ts). */
export function registerMessagingTools(server: McpServer, { hub, me, tool, publicNote, whenToReply, calls }: MessagingToolDeps): void {
  /** The public-channel warning for where a sent message landed (its post's thread). */
  const sentNote = (m: { id: string; channelId?: string; post?: string }) => publicNote(m.channelId, m.post ?? m.id);
  server.registerTool(
    'send_message',
    {
      title: 'Send message',
      description:
        'Sends a message to another agent ("to" an id, or "skill" for whoever offers it), or posts it in a channel you are in ("channel"): ' +
        'everyone there gets it. Add "thread" (a post\'s id) to reply in that post\'s thread: it reaches the post\'s author, everyone who wrote ' +
        'there, and everyone you @mention. By default waits up to ~25s for the first answer; otherwise call wait_for_reply later. ' +
        'A channel marked public (whoami and check_inbox say public: true) can be read by anyone on the internet: never post secrets, tokens or private data there.',
      inputSchema: {
        to: z.string().optional().describe('Recipient agent id (list_agents shows ids; names are not unique).'),
        skill: z.string().optional().describe('Instead of "to": an agent offering this skill.'),
        channel: z.string().optional().describe('Instead of "to": a channel you are in (id or name).'),
        workspace: z.string().optional().describe('With "channel" given by name: the workspace (id or name) it is in, when you are in channels of that name in several workspaces.'),
        thread: z.string().optional().describe('With "channel": reply in the thread of this post (its message id).'),
        replyTo: z.string().optional().describe('Quote this message id within the destination conversation; does not change the destination.'),
        text: z.string().optional().describe('Message text.'),
        data: z.record(z.string(), z.unknown()).optional().describe('Optional structured JSON payload.'),
        files: z.array(z.string()).optional().describe('Ids of files you uploaded (upload_file / create_upload) to attach.'),
        wait: z.boolean().optional().describe('Wait for the first answer (default true).'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        if ((args.thread || args.workspace) && !args.channel) throw new HubError('invalid', '"thread" and "workspace" only apply to channel messages');
        if (args.channel && (args.to || args.skill)) throw new HubError('invalid', 'Use "channel" on its own, without "to" or "skill"');
        const parts = await hub.parts(caller, args.text, args.data, args.files);
        const sent = await hub.send(caller, { to: args.to, skill: args.skill, channel: args.channel, thread: args.thread, workspace: args.workspace }, parts, { replyTo: args.replyTo });
        const answer = args.wait === false ? undefined : (await hub.chat.waitForReply(caller, sent.message.id, hub.maxWaitMs)).reply;
        const warnings = hub.listeningWarnings(sent.recipients, sent.message);
        return {
          message: messageView(sent.message),
          ...(answer ? { reply: messageView(answer) } : {}),
          ...(warnings.length ? { warnings } : {}),
          ...(await sentNote(sent.message)),
        };
      }),
  );

  server.registerTool(
    'reply',
    {
      title: 'Reply',
      description:
        'Answers a message (its messageId, from check_inbox or wait_for_message): in a channel, in the post\'s thread; otherwise in the same conversation. ' +
        'Everyone in that conversation gets it. ' +
        'A channel marked public (whoami and check_inbox say public: true) can be read by anyone on the internet: never post secrets, tokens or private data there.',
      inputSchema: {
        messageId: z.string(),
        replyTo: z.string().optional().describe('Quote this message id within the destination conversation; does not change the destination.'),
        text: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        files: z.array(z.string()).optional().describe('Ids of files you uploaded (upload_file / create_upload) to attach.'),
      },
    },
    (args) =>
      tool(async () => {
        const caller = await me();
        const sent = await hub.send(caller, { replyTo: args.messageId }, await hub.parts(caller, args.text, args.data, args.files), { replyTo: args.replyTo });
        return { ...messageView(sent.message), ...(await sentNote(sent.message)) };
      }),
  );

  server.registerTool(
    'wait_for_reply',
    {
      title: 'Wait for reply',
      description: 'Waits (up to ~25s) for the first answer to a message you sent (in its thread, for a channel post). Call again to keep waiting.',
      inputSchema: {
        messageId: z.string(),
        timeoutSeconds: z.number().min(0).optional().describe('Max seconds to wait (capped at ~25).'),
      },
    },
    (args) =>
      tool(async () => {
        const { message, reply } = await hub.chat.waitForReply(await me(), args.messageId, (args.timeoutSeconds ?? 25) * 1000);
        return { message: messageView(message), ...(reply ? { reply: messageView(reply) } : {}) };
      }),
  );

  server.registerTool(
    'read_thread',
    {
      title: 'Read a thread',
      description: `A channel post and its newest ${THREAD_READ_DEFAULT} replies, oldest first, with who said each. Ask for more only if you need them.`,
      inputSchema: {
        channel: z.string().describe('A channel you are in (id or name).'),
        thread: z.string().describe("The post's message id."),
        limit: z.number().int().positive().max(THREAD_READ_MAX).optional().describe(`Newest replies to return (default ${THREAD_READ_DEFAULT}).`),
        fields: fieldsArg,
      },
      annotations: { readOnlyHint: true },
    },
    (args) =>
      tool(async () => project(await (async () => {
        const caller = await me();
        const views = (await hub.chat.readThread(caller, args.channel, args.thread, args.limit ?? THREAD_READ_DEFAULT)).map(messageView);
        // The channel's context and attached skills come with the post, once per thread like an inbox item (read_thread doesn't give the reply rules).
        const channelId = views[0]?.channelId;
        const ch = channelId ? (await hub.registry.channelsById([channelId])).get(channelId) : undefined;
        if (!ch || !views[0]) return views;
        const conversation = threadKey(ch.id, views[0].id);
        const now = Date.now();
        if (shown(caller.id, conversation, ch.context, now)) return views;
        seen.set(`${caller.id}|${conversation}`, { context: ch.context ?? '', at: now, rules: false });
        const context = ch.context;
        const attached = await hub.registry.resolveAttachedSkills({ agent: caller, channel: ch, workspaceId: ch.workspaceId });
        const skills = attached.filter((s) => (s.type ?? 'skill') === 'skill');
        const processes = attached.filter((s) => s.type === 'process');
        return context || attached.length
          ? [
              {
                ...views[0],
                ...(context ? { channelContext: context, channelContextNote: CONTEXT_NOTE } : {}),
                ...(skills.length ? { skills: skills.map(skillSummaryView), skillsNote: SKILLS_NOTE } : {}),
                ...(processes.length ? { processes: processes.map(skillSummaryView), processesNote: PROCESS_NOTE } : {}),
              },
              ...views.slice(1),
            ]
          : views;
      })(), args.fields)),
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description: 'Your channels and direct conversations, most recent first, with how many messages in each are new to you.',
      inputSchema: { limit: z.number().int().positive().max(100).optional(), fields: fieldsArg },
      annotations: { readOnlyHint: true },
    },
    (args) => tool(async () => project(await hub.conversationViews(await me(), { limit: args.limit ?? 20 }), args.fields)),
  );

  server.registerTool(
    'check_inbox',
    {
      title: 'Check inbox',
      description:
        'What is new for you (without waiting): one item per conversation, its newest message with what came before it under "earlier". ' +
        'They count as read once you reply in that conversation or call check_inbox again; unanswered, they come back after ~10 min. Reply (reply(messageId)) where one asks you something or you have something useful to add.',
      inputSchema: {
        max: z.number().int().positive().max(20).optional(),
        conversation: z.string().max(200).optional().describe('Only this conversation ("thread:<channelId>:<postId>", "dm:..." or "channel:<id>"); the rest stay new.'),
        fields: fieldsArg,
      },
    },
    (args) => {
      let fresh = false;
      return tool(async () => {
        const caller = await me();
        const max = args.max ?? 20;
        const items = await hub.chat.take(caller, max, args.conversation);
        const ctx = calls.getStore();
        // Scoped: no note about other conversations. Full-inbox take already scanned; skip the rescan only when it drained (took < max).
        if (ctx && (args.conversation || items.length < max)) ctx.skipPending = true;
        const now = Date.now();
        const views = await hub.inboxView(caller, items, (c, context) => !!shown(caller.id, c, context, now));
        // ponytail: the boilerplate counts as shown even if `fields` dropped it; the agent asked for less.
        fresh = firstViews(caller.id, views, now);
        return project(views, args.fields);
      }, (r) => (fresh ? whenToReply(r) : undefined));
    },
  );

  server.registerTool(
    'wait_for_message',
    {
      title: 'Wait for message',
      description: 'Waits (up to ~25s) for something new for you and returns it like check_inbox, or an empty list on timeout. Call in a loop to stay online.',
      inputSchema: {
        timeoutSeconds: z.number().positive().optional().describe('Max seconds to wait (capped at ~25).'),
        conversation: z.string().max(200).optional().describe('Only this conversation, as for check_inbox.'),
        fields: fieldsArg,
      },
    },
    (args) => {
      let fresh = false;
      return tool(async () => {
        const caller = await me();
        await hub.registry.markListening(caller);
        const items = await hub.chat.waitAndTake(caller, (args.timeoutSeconds ?? 25) * 1000, args.conversation);
        const ctx = calls.getStore();
        if (ctx) {
          if (!items.length) ctx.idleWait = true;
          // Full-inbox wait already polled; skip the pending rescan only when it drained (< take's max of 20).
          if (!args.conversation && items.length < 20) ctx.skipPending = true;
        }
        const now = Date.now();
        const views = await hub.inboxView(caller, items, (c, context) => !!shown(caller.id, c, context, now));
        fresh = firstViews(caller.id, views, now);
        return project(views, args.fields);
      }, (r) => (fresh ? whenToReply(r) : undefined));
    },
  );
}
