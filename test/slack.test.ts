import { describe, expect, it } from 'vitest';
import { parseSealingKey } from '../src/lib/sealing.js';
import { SlackStore, slackKey } from '../src/slack/store.js';
import { testDb } from './helpers.js';

const key = parseSealingKey(Buffer.alloc(32, 3).toString('base64'))!;

describe('Slack bridge records', () => {
  it('keeps the bot token sealed, and finds installs by Parly workspace', async () => {
    const db = testDb();
    const store = new SlackStore(db, key);
    const teamId = `T${Date.now()}`;
    await store.saveInstall({ teamId, teamName: 'Acme', workspaceId: `ws-${teamId}`, botUserId: 'U0BOT', installedBy: 'p1' }, 'xoxb-secret-token');
    const install = (await store.install(teamId))!;
    expect(JSON.stringify(install)).not.toContain('xoxb-secret-token');
    expect(store.botToken(install)).toBe('xoxb-secret-token');
    expect((await store.installsFor(`ws-${teamId}`)).map((i) => i.teamId)).toEqual([teamId]);
    await expect(new SlackStore(db).saveInstall({ ...install }, 'xoxb-x')).rejects.toThrow(/CREDENTIALS_KEY/);
  });

  it('counts each Slack delivery once, and keys messages by team, channel and ts together', async () => {
    const store = new SlackStore(testDb(), key);
    const eventId = `Ev${Date.now()}`;
    expect(await store.keepEvent(eventId, { event: {} })).toBe(true);
    expect(await store.keepEvent(eventId, { event: {} })).toBe(false); // Slack's retry of the same event
    expect(await store.claimEvent(eventId)).toMatchObject({ attempts: 0 });
    expect(await store.claimEvent(eventId)).toBeUndefined(); // taken: a second handler leaves it alone
    expect(await store.claimEvent(eventId, Date.now() + 61_000)).toMatchObject({ attempts: 0 }); // its handler died
    await store.eventDone(eventId);
    expect(await store.claimEvent(eventId, Date.now() + 120_000)).toBeUndefined();
    const copy = { teamId: 'T1', channelId: `C${Date.now()}`, ts: '1700000000.000100' };
    await store.rememberCopy(copy, 'm1');
    expect(await store.messageAt(copy)).toBe('m1');
    // The same ts in another channel is another message.
    expect(await store.messageAt({ ...copy, channelId: 'C-other' })).toBeUndefined();
    expect(slackKey(copy)).toBe(`T1:${copy.channelId}:1700000000.000100`);
  });

  it('links a Parly channel to Slack channels both ways, one Parly channel per Slack channel', async () => {
    const db = testDb();
    const store = new SlackStore(db, key);
    const n = Date.now();
    const [TA, CA, TB, CB] = [`TA${n}`, `CA${n}`, `TB${n}`, `CB${n}`];
    const parly = `ch-${n}`;
    await db.collection('channels').doc(parly).set({ id: parly, name: 'room' });
    await store.linkChannel(parly, { teamId: TA, channelId: CA, sideId: 'a' });
    await store.linkChannel(parly, { teamId: TB, channelId: CB, sideId: 'b' });
    expect((await db.collection('channels').doc(parly).get()).data()!.slack).toEqual([
      { teamId: TA, channelId: CA, sideId: 'a' },
      { teamId: TB, channelId: CB, sideId: 'b' },
    ]);
    expect(await store.linkedChannel(TB, CB)).toMatchObject({ parlyChannelId: parly, sideId: 'b' });
    const other = `${parly}-other`;
    await db.collection('channels').doc(other).set({ id: other });
    await expect(store.linkChannel(other, { teamId: TA, channelId: CA })).rejects.toThrow(/already linked/);
    await store.unlinkChannel(parly, { teamId: TA, channelId: CA });
    expect(await store.linkedChannel(TA, CA)).toBeUndefined();
    expect((await db.collection('channels').doc(parly).get()).data()!.slack).toEqual([{ teamId: TB, channelId: CB, sideId: 'b' }]);
  });

  it('knows a Slack user only once they linked themselves', async () => {
    const store = new SlackStore(testDb(), key);
    const user = `U${Date.now()}`;
    expect(await store.identity('T1', user)).toBeUndefined();
    await store.linkIdentity('T1', user, 'person-1');
    expect((await store.identity('T1', user))?.agentId).toBe('person-1');
    expect(await store.identity('T2', user)).toBeUndefined(); // the same user id in another Slack workspace is someone else
    await store.unlinkIdentity('T1', user);
    expect(await store.identity('T1', user)).toBeUndefined();
  });
});
