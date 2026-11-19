import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { threadKey } from '../src/chat/chat.js';
import { FieldValue } from '../src/db/types.js';
import type { HubService } from '../src/hub/hubService.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, newAgent, testConfig, testDb } from './helpers.js';

const say = (text: string) => [{ text }];

/**
 * Review #94: lock the behaviours fixed in #3 / #20 / #21 through HubService.
 * A whole-doc register/append overwrite, or a loose domain auto-join, fails these.
 */
describe('concurrent updates and domain auto-join (review #94)', () => {
  let hub: HubService;

  beforeAll(() => {
    hub = createHub({
      db: testDb(),
      config: testConfig(),
      verifyGoogle: async (idToken) => {
        const [email = '', sub = ''] = idToken.split('|');
        return { email, sub, name: email.split('@')[0]! };
      },
    });
  });

  it('re-register keeps concurrent channel, listening, wake, and session fields (item 20)', async () => {
    const { agent } = await newAgent(hub.registry, { name: 'race-94', description: 'v1' });
    const listeningUntil = new Date(Date.now() + 60_000).toISOString();
    const lastFire = { at: new Date().toISOString(), ok: true, sessionUrl: 'https://example.test/s' };
    // Concurrent writers after the stale caller was loaded at request start.
    await hub.registry.col.doc(agent.id).update({
      channels: FieldValue.arrayUnion('ch-94'),
      listeningUntil,
      wake: { type: 'webhook', url: 'https://example.test/wake', lastFire },
      sessionHashes: FieldValue.arrayUnion('sess-94'),
    });

    await hub.registry.register({ name: 'race-94', description: 'v2' }, agent);

    const stored = (await hub.registry.get(agent.id))!;
    expect(stored.description).toBe('v2');
    expect(stored.channels).toContain('ch-94');
    expect(stored.listeningUntil).toBe(listeningUntil);
    expect(stored.wake).toMatchObject({ type: 'webhook', lastFire });
    expect(stored.sessionHashes).toContain('sess-94');
  });

  it('append preserves digest fields and other writers\' fields (item 21)', async () => {
    const { owner, channel, members } = await crew(hub.registry, 'append-94', ['append-94-bot']);
    const bot = members[0]!;
    const root = (await hub.send(owner, { channel: channel.id }, say(`@${bot.name} start`))).message;
    const key = threadKey(channel.id, root.id);
    await hub.send(bot, { replyTo: root.id }, say('working'));

    const ref = hub.registry.db.collection('conversations').doc(key);
    await ref.update({
      threadDigest: 'digest-kept',
      digestUpToSeq: 1,
      otherWriter: 'kept',
    });

    await hub.send(owner, { replyTo: root.id }, say('continue'));

    const stored = (await ref.get()).data()!;
    expect(stored.seq).toBeGreaterThan(1);
    expect(stored.threadDigest).toBe('digest-kept');
    expect(stored.digestUpToSeq).toBe(1);
    expect(stored.otherWriter).toBe('kept');

    // doneAt/doneBy set beside append traffic must survive an agent append (person reopen clears them on purpose).
    await hub.setThreadDone(owner, channel.id, root.id, true);
    const doneAt = (await ref.get()).data()!.doneAt as string;
    expect(doneAt).toBeTruthy();
    await hub.chat.store.append((await hub.chat.store.conversation(key))!, {
      id: `agent-keep-done-${Date.now()}`,
      from: bot.name,
      fromId: bot.id,
      parts: [{ text: 'late agent' }],
      human: false,
    });
    const afterAgent = (await ref.get()).data()!;
    expect(afterAgent.doneAt).toBe(doneAt);
    expect(afterAgent.doneBy).toBe(owner.id);
    expect(afterAgent.threadDigest).toBe('digest-kept');
    expect(afterAgent.digestUpToSeq).toBe(1);
    expect(afterAgent.otherWriter).toBe('kept');
  });

  it('domain auto-join refuses unverified ownership, archived workspaces, and banned agents (item 3)', async () => {
    const signIn = async (email: string): Promise<AgentRecord> =>
      (await hub.registry.signInWithGoogle(`${email}|g-${email}`)).agent;

    const founder = await signIn('founder@join-94.test');
    const [ws] = await hub.registry.workspacesOf(founder);

    await expect(hub.registry.setWorkspaceDomains(founder, ws!.id, ['not-theirs.test'])).rejects.toMatchObject({
      code: 'invalid',
    });

    // Stale/hand-written domain without a verified owner on it: no auto-join.
    await hub.registry.workspaceCol.doc(ws!.id).update({ domains: ['not-theirs.test'] });
    expect((await signIn('ceo@not-theirs.test')).workspaces).not.toContain(ws!.id);

    expect((await hub.registry.setWorkspaceDomains(founder, ws!.id, ['join-94.test'])).domains).toEqual(['join-94.test']);

    // Banned on that domain workspace: sign-in does not re-add them.
    const banned = await signIn('banned@join-94.test');
    expect(banned.workspaces).toContain(ws!.id);
    await hub.registry.col.doc(banned.id).update({ workspaces: FieldValue.arrayRemove(ws!.id) });
    await hub.registry.workspaceCol.doc(ws!.id).update({ bannedAgents: FieldValue.arrayUnion(banned.id) });
    expect((await signIn('banned@join-94.test')).workspaces).not.toContain(ws!.id);

    // Archived workspace: no auto-join.
    await hub.registry.workspaceCol.doc(ws!.id).update({ archived: true, bannedAgents: [] });
    expect((await signIn('late@join-94.test')).workspaces).not.toContain(ws!.id);
  });
});
