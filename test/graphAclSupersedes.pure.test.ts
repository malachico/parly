import { expect, it } from 'vitest';
import type { AgentRecord } from '../src/registry/types.js';
import { readableGraph } from '../src/graph/acl.js';

// Decision 3: a replacement shows only to a reader of both decisions.
it('shows a supersedes edge only when both ends are readable', async () => {
  const node = (id: string, conversationId: string) => ({ _id: id, workspaceId: 'w', conversationId });
  const graph = {
    nodes: [node('new', 'thread:c1:p'), node('old', 'channel:c2')],
    edges: [{ workspaceId: 'w', kind: 'supersedes', from: 'new', to: 'old', fromConversationId: 'thread:c1:p', toConversationId: 'channel:c2' }],
  };
  const reader = { workspaces: ['w'] } as unknown as AgentRecord;
  const chat = (ids: string[]) => ({ readableConversations: async () => new Set(ids) });
  expect((await readableGraph(reader, chat(['thread:c1:p', 'channel:c2']), graph)).edges).toHaveLength(1);
  expect((await readableGraph(reader, chat(['thread:c1:p']), graph)).edges).toEqual([]);
  expect((await readableGraph(reader, chat(['channel:c2']), graph)).edges).toEqual([]);
});
