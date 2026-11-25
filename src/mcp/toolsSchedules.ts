import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { HubService } from '../hub/hubService.js';
import { describe as describeSchedule } from '../hub/schedules.js';
import { HubError } from '../lib/errors.js';
import type { AgentRecord } from '../registry/types.js';

type ScheduleToolDeps = {
  hub: HubService;
  me: () => Promise<AgentRecord>;
  tool: (fn: () => Promise<unknown>, note?: (result: unknown) => string | undefined) => Promise<CallToolResult>;
};

/** Registers schedule_message…set_status (moved out of server.ts, with timing/scheduleOut). */
export function registerScheduleTools(server: McpServer, { hub, me, tool }: ScheduleToolDeps): void {
  // The timing of a scheduled message, shared by schedule_message and update_schedule.
  const timing = {
    repeat: z.enum(['once', 'daily', 'weekdays', 'weekly', 'interval']).describe('once, daily, weekdays (Mon–Fri), weekly, or interval (every N minutes).'),
    time: z.string().optional().describe('"HH:MM", 24-hour, in tz. Not for interval.'),
    date: z.string().optional().describe('once: "YYYY-MM-DD" in tz.'),
    day: z.number().int().min(0).max(6).optional().describe('weekly: 0 = Sunday … 6 = Saturday.'),
    minutes: z.number().int().optional().describe('interval: minutes between posts, at least 5.'),
    tz: z.string().optional().describe('IANA time zone, e.g. "Asia/Bangkok" (default UTC). Use the person\'s own when they say a local time.'),
  };
  const scheduleOut = (s: Awaited<ReturnType<typeof hub.scheduleService.createSchedule>>) => {
    const { botId: _b, ...rest } = s;
    return { ...rest, when: describeSchedule(s) };
  };

  server.registerTool(
    'schedule_message',
    {
      title: 'Schedule a message',
      description:
        'Posts a message on a schedule: once, daily, on weekdays, weekly, or every N minutes. When someone asks in plain words ' +
        '("every weekday at 9 tell QA to run the E2E suite", "remind me tomorrow at 10"), turn it into repeat/time/date/day/minutes/tz and call this. ' +
        "Give channel (one you are in: it's posted as you with ⏰ and wakes you; @Name wakes that agent too) or to (an agent: a direct message " +
        'sent as your owner, so its answer lands in their conversation with it). How to give an agent a recurring job, or yourself a follow-up.',
      inputSchema: {
        channel: z.string().optional().describe('A channel you are in (id or name).'),
        to: z.string().optional().describe("Instead of channel: an agent id, for a direct message to it. Your owner's agents only, or a public one."),
        thread: z.string().optional().describe("With channel: post in this post's thread instead (its message id)."),
        text: z.string().describe('What to post, with @Name to wake an agent.'),
        ...timing,
      },
    },
    (args) =>
      tool(async () => {
        const { channel, to, ...body } = args;
        if (!channel === !to) throw new HubError('invalid', 'Give channel or to (one of them)');
        const caller = await me();
        return scheduleOut(await (to ? hub.scheduleService.createAgentSchedule(caller, to, body) : hub.scheduleService.createSchedule(caller, channel!, body)));
      }),
  );

  server.registerTool(
    'list_schedules',
    {
      title: 'List scheduled messages',
      description: "A channel's scheduled messages, or (to) those your owner has scheduled to an agent: what each posts, when (in words), when next, and whether it's paused.",
      inputSchema: {
        channel: z.string().optional().describe('A channel you are in (id or name).'),
        to: z.string().optional().describe('Instead of channel: an agent id.'),
      },
    },
    (args) =>
      tool(async () => {
        if (!args.channel === !args.to) throw new HubError('invalid', 'Give channel or to (one of them)');
        const caller = await me();
        return (await (args.to ? hub.scheduleService.agentSchedules(caller, args.to) : hub.scheduleService.channelSchedules(caller, args.channel!))).map(scheduleOut);
      }),
  );

  server.registerTool(
    'update_schedule',
    {
      title: 'Change a scheduled message',
      description: 'Its maker or a channel owner: new text, a new timing (give repeat and its fields), active: false to pause or true to resume, or delete: true.',
      inputSchema: {
        id: z.string().describe('The scheduled message (list_schedules).'),
        text: z.string().optional(),
        active: z.boolean().optional(),
        delete: z.boolean().optional(),
        ...timing,
        repeat: timing.repeat.optional(),
      },
    },
    (args) =>
      tool(async () => {
        const { id, delete: del, ...change } = args;
        const out = await hub.scheduleService.changeSchedule(await me(), id, del ? null : change);
        return out ? scheduleOut(out) : { ok: true, deleted: id };
      }),
  );

  server.registerTool(
    'set_status',
    {
      title: 'Say what you are doing',
      description:
        'Shows people, live under a conversation, that you are working on it and what on ("running the tests", "opening a PR"), until ' +
        'you post there. Call it when an answer will take more than a few seconds. The conversation is the "conversation" of the message ' +
        'you are answering (check_inbox gives it). done: true clears it, if you decide not to answer. Your latest text also stays on your ' +
        'card on the team canvas, with its time, until you post in that conversation or set another.',
      inputSchema: {
        conversation: z.string().describe('"channel:<id>", "thread:<channelId>:<postId>" or "agent:<id>" (a DM).'),
        text: z.string().optional().describe('What you are doing, briefly (up to 120 characters).'),
        done: z.boolean().optional(),
      },
    },
    (args) => tool(async () => hub.setStatus(await me(), args.conversation, args.text, args.done === true)),
  );
}
