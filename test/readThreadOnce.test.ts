import { describe, expect, it } from 'vitest';
import { registerMessagingTools } from '../src/mcp/toolsMessaging.js';

// read_thread sends the channel context and skills once per thread, like check_inbox, and skips the skills lookup after that.
describe('read_thread boilerplate once per thread', () => {
  it('sends context and skills on the first read only, and check_inbox still gives the reply rules', async () => {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    const server = { registerTool: (name: string, _def: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) => (handlers[name] = fn) };
    const channel = { id: 'c1', workspaceId: 'w1', context: 'Be terse.' };
    const post = { id: 'p1', channelId: 'c1', conversationId: 'thread:c1:p1', from: 'a2', parts: [{ kind: 'text', text: 'hi' }], createdAt: new Date() };
    let skillLoads = 0;
    const hub = {
      chat: { readThread: async () => [post], take: async () => [{ message: post }] },
      registry: {
        channelsById: async () => new Map([['c1', channel]]),
        resolveAttachedSkills: async () => (skillLoads++, [{ id: 's1', name: 'style', description: 'd', type: 'skill' }]),
      },
      inboxView: async (_a: unknown, items: Array<{ message: typeof post }>) =>
        items.map((i) => ({ conversation: i.message.conversationId, channelContext: channel.context })),
    };
    const notes: Array<string | undefined> = [];
    registerMessagingTools(server as never, {
      hub: hub as never,
      me: async () => ({ id: 'agent-1' }) as never,
      tool: async (fn, note) => { const r = await fn(); notes.push(note?.(r)); return r as never; },
      publicNote: async () => ({}),
      whenToReply: () => 'rules',
      calls: { getStore: () => undefined },
    });

    const first = (await handlers.read_thread!({ channel: 'c1', thread: 'p1' })) as Array<Record<string, unknown>>;
    expect(first[0]!.channelContext).toBe('Be terse.');
    expect(first[0]!.skills).toBeDefined();
    const second = (await handlers.read_thread!({ channel: 'c1', thread: 'p1' })) as Array<Record<string, unknown>>;
    expect(second[0]!.channelContext).toBeUndefined();
    expect(second[0]!.skills).toBeUndefined();
    expect(skillLoads).toBe(1);

    // The thread's boilerplate was already shown, but the reply rules were not: check_inbox still sends them.
    const inbox = (await handlers.check_inbox!({})) as Array<Record<string, unknown>>;
    expect(inbox[0]!.channelContext).toBeUndefined();
    expect(notes.at(-1)).toBe('rules');
  });
});
