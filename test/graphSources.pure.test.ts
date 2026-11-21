import { describe, expect, it } from 'vitest';
import type { Database } from '../src/db/types.js';
import { canReadGraphSource, syncGraphSource, type GraphSource, type GraphSourceReaders } from '../src/graph/sources.js';
import { GraphStore } from '../src/graph/store.js';
import type { ChannelRecord, SkillRecord, WorkspaceRecord } from '../src/registry/types.js';

const explodingDb = new Proxy({}, { get: () => { throw new Error('db touched'); } }) as Database;
const meter = { graphSpent: async () => 0, addGraphSpend: async () => {} };

describe('graph sources (pure)', () => {
  it('reads conversations and room docs by canRead, skills by canAccessSkill, and fails closed', async () => {
    const asked: string[] = [];
    const checks = {
      canRead: async (id: string) => { asked.push(`read ${id}`); return id === 'channel:ok'; },
      canAccessSkill: async (id: string) => { asked.push(`skill ${id}`); return id === 's-ok'; },
    };
    const can = (s: unknown) => canReadGraphSource(s as GraphSource, checks);
    expect(await can({ kind: 'conversation', conversationId: 'channel:ok' })).toBe(true);
    expect(await can({ kind: 'room_doc', workspaceId: 'w', conversationId: 'channel:ok' })).toBe(true);
    expect(await can({ kind: 'room_doc', workspaceId: 'w', conversationId: 'channel:no' })).toBe(false);
    expect(await can({ kind: 'skill', skillId: 's-ok' })).toBe(true);
    expect(await can({ kind: 'skill', skillId: 's-no' })).toBe(false);
    expect(asked).toEqual(['read channel:ok', 'read channel:ok', 'read channel:no', 'skill s-ok', 'skill s-no']);
    for (const bad of [undefined, {}, { kind: 'brief', conversationId: 'channel:ok' }, { kind: 'skill', skillId: '' }, { kind: 'conversation', conversationId: '' }]) {
      expect(await can(bad)).toBe(false);
    }
    expect(asked).toHaveLength(5);
  });

  it('is a no-op when the flag is off, and never reads a channel for a channel-scoped skill', async () => {
    const graph = new GraphStore(explodingDb, meter, { enabled: false, dailyCapMicros: 250_000 });
    const touched = async (): Promise<never> => { throw new Error('readers touched'); };
    const readers: GraphSourceReaders = { channelDoc: touched, workspaceDoc: touched, channelSkills: touched, roomDocument: touched };
    for (const scope of [{ kind: 'workspace', id: 'w' }, { kind: 'channel', id: 'c' }]) {
      await syncGraphSource(graph, readers, { skill: { id: 's', name: 'n', description: 'd', scope } as SkillRecord });
    }
    await syncGraphSource(graph, readers, { deletedSkillId: 's' });
    await syncGraphSource(graph, readers, { roomDoc: { workspaceId: 'w', sharedChannelId: 'c', goal: 'g', text: 't' } });
    await syncGraphSource(graph, readers, { restoredChannel: { workspaceId: 'w', channelId: 'c' } });
    await graph.deleteNodes({ kind: 'skill' });
  });

  describe('with the flag on', () => {
    const upserts: Record<string, any>[] = [];
    const graph = { enabled: true, upsertNode: async (n: Record<string, any>) => { upserts.push(n); return 'id'; }, deleteNodes: async () => {} } as unknown as GraphStore;
    const channels: Record<string, ChannelRecord> = {
      c1: { id: 'c1', workspaceId: 'w1' } as ChannelRecord,
      gone: { id: 'gone', workspaceId: 'w1', archived: true } as ChannelRecord,
    };
    const skill = (id: string, extra: Partial<SkillRecord>) => ({ id, name: id, description: 'd', ...extra }) as SkillRecord;
    const readers: GraphSourceReaders = {
      channelDoc: async (id) => channels[id],
      workspaceDoc: async (id) => ({ id, room: { goal: 'Spec', shared: 'c1' } }) as WorkspaceRecord,
      channelSkills: async (id) => [skill(`${id}-skill`, { scope: { kind: 'channel', id } })],
      roomDocument: async () => ({ text: 'POST /events' }),
    };

    it('a channel-scoped skill is a node in its channel\'s workspace, tagged with the channel', async () => {
      upserts.length = 0;
      await syncGraphSource(graph, readers, { skill: skill('s1', { scope: { kind: 'channel', id: 'c1' } }) });
      expect(upserts).toEqual([expect.objectContaining({ workspaceId: 'w1', kind: 'skill', source: { kind: 'skill', skillId: 's1', channelId: 'c1' } })]);
    });

    it('agent-scoped, unscoped, builtin, archived-channel and missing-channel skills get no node', async () => {
      upserts.length = 0;
      for (const s of [
        skill('a', { scope: { kind: 'agent', id: 'x' } as SkillRecord['scope'] }),
        skill('u', {}),
        skill('b', { builtin: true, scope: { kind: 'workspace', id: 'w1' } } as Partial<SkillRecord>),
        skill('g', { scope: { kind: 'channel', id: 'gone' } }),
        skill('m', { scope: { kind: 'channel', id: 'missing' } }),
      ]) await syncGraphSource(graph, readers, { skill: s });
      expect(upserts).toEqual([]);
    });

    it('a restored channel brings back its skills and, on a room\'s shared channel, the room doc', async () => {
      upserts.length = 0;
      await syncGraphSource(graph, readers, { restoredChannel: { workspaceId: 'w1', channelId: 'c1' } });
      expect(upserts).toEqual([
        expect.objectContaining({ kind: 'skill', source: { kind: 'skill', skillId: 'c1-skill', channelId: 'c1' } }),
        expect.objectContaining({ kind: 'doc', title: 'Spec', text: 'POST /events', conversationId: 'channel:c1' }),
      ]);
    });
  });
});
