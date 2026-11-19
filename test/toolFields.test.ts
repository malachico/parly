import { describe, expect, it } from 'vitest';
import { registerMessagingTools } from '../src/mcp/toolsMessaging.js';

// list_conversations, read_thread, check_inbox... take run_tool's `fields`: only those keys come back, and without it nothing changes.
describe('fields on list-style Parly tools', () => {
  it('list_conversations returns only the asked fields, and the whole view without fields', async () => {
    const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {};
    const server = { registerTool: (name: string, _def: unknown, fn: (args: Record<string, unknown>) => Promise<unknown>) => (handlers[name] = fn) };
    const views = [
      { id: 'c1', kind: 'channel', name: 'dev', unread: 3, last: { from: 'a2', text: 'a long message' } },
      { id: 'dm:a1:a2', kind: 'dm', name: 'Bob', unread: 0, last: { from: 'a2', text: 'hi' } },
    ];
    registerMessagingTools(server as never, {
      hub: { conversationViews: async () => structuredClone(views) } as never,
      me: async () => ({ id: 'a1' }) as never,
      tool: async (fn) => (await fn()) as never,
      publicNote: async () => ({}),
      whenToReply: () => undefined,
      calls: { getStore: () => undefined },
    });

    expect(await handlers.list_conversations!({ fields: ['id', 'unread'] })).toEqual([
      { id: 'c1', unread: 3 },
      { id: 'dm:a1:a2', unread: 0 },
    ]);
    expect(JSON.stringify(await handlers.list_conversations!({}))).toBe(JSON.stringify(views));
  });
});
