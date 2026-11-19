import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { channelView } from '../src/lib/present.js';
import { parseSealingKey } from '../src/lib/sealing.js';
import { SLACK_BOT_SCOPES, SlackOAuth } from '../src/slack/oauth.js';
import { SlackStore } from '../src/slack/store.js';
import { crew, testConfig, testDb, testPerson } from './helpers.js';

const key = parseSealingKey(Buffer.alloc(32, 9).toString('base64'))!;
let seq = 0;
const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`.toUpperCase();

async function setup() {
  const db = testDb();
  const config = testConfig({
    credentialsKey: key,
    publicUrl: 'https://hub.parly.test',
    webUrl: 'https://parly.test',
    slack: { signingSecret: 'slack-secret', clientId: 'cid-123', clientSecret: 'csecret-456' },
  });
  const { app, hub } = createApp({ db, config });
  const calls: { url: string; method: string; body?: string }[] = [];
  const responses = new Map<string, () => Record<string, unknown>>();

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: String(init.body) } : {}) });
    for (const [pattern, fn] of responses) {
      if (url.includes(pattern)) {
        return new Response(JSON.stringify(fn()), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  const store = new SlackStore(db, key);
  const oauth = new SlackOAuth(db, store, hub, {
    clientId: 'cid-123',
    clientSecret: 'csecret-456',
    publicUrl: 'https://hub.parly.test',
    webUrl: 'https://parly.test',
    fetchImpl,
  });
  hub.slackOAuth = oauth;
  return { db, app, hub, store, oauth, calls, responses };
}

describe('Slack bridge: manifest, OAuth install, channel & room linking, and identity approval', () => {
  // slack/ is stripped from the public mirror (scripts/public-tree.sh).
  it.skipIf(!existsSync(new URL('../slack/manifest.json', import.meta.url)))('ships valid production and staging Slack app manifests with the required bot scopes and events', () => {
    for (const file of ['../slack/manifest.json', '../slack/manifest.staging.json']) {
      const manifest = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
      expect(manifest.oauth_config.scopes.bot).toEqual([...SLACK_BOT_SCOPES]);
      expect(manifest.settings.event_subscriptions.bot_events).toEqual([
        'message.channels',
        'message.groups',
        'message.im',
        'app_uninstalled',
        'tokens_revoked',
        'member_left_channel',
      ]);
      expect(manifest.oauth_config.redirect_urls[0]).toMatch(/\/slack\/installed$/);
      expect(manifest.settings.event_subscriptions.request_url).toMatch(/\/slack\/events$/);
    }
  });

  it('installs the Slack app with a single-use 10-minute state bound to the workspace owner, sealing the bot token', async () => {
    const s = await setup();
    const { owner, channel } = await crew(s.hub.registry, `oauth-${uid()}`, []);
    const outsider = await testPerson(s.hub.registry, `outsider-${uid()}`);

    await expect(s.oauth.startInstall(outsider, channel.workspaceId)).rejects.toMatchObject({ code: 'not_found' });

    const { url, state } = await s.oauth.startInstall(owner, channel.workspaceId);
    expect(url).toContain('https://slack.com/oauth/v2/authorize?');
    expect(url).toContain('client_id=cid-123');
    expect(url).toContain(`redirect_uri=${encodeURIComponent('https://parly.test/slack/installed')}`);
    expect(url).toContain(`state=${encodeURIComponent(state)}`);

    const teamId = `T${uid()}`;
    s.responses.set('oauth.v2.access', () => ({
      ok: true,
      access_token: 'xoxb-live-secret-token',
      bot_user_id: 'UBOT1',
      team: { id: teamId, name: 'Acme Slack' },
    }));

    const done = await s.oauth.completeInstall(owner, { code: 'oauth-code-1', state });
    expect(done.redirectUrl).toBe(`https://parly.test/w/${encodeURIComponent(channel.workspaceId)}?panel=workspace&slack=installed`);
    const saved = (await s.store.install(teamId))!;
    expect(saved).toMatchObject({
      teamId,
      teamName: 'Acme Slack',
      workspaceId: channel.workspaceId,
      botUserId: 'UBOT1',
      installedBy: owner.id,
    });
    expect(JSON.stringify(saved)).not.toContain('xoxb-live-secret-token');
    expect(s.store.botToken(saved)).toBe('xoxb-live-secret-token');

    // State is single-use: replaying it is rejected.
    await expect(s.oauth.completeInstall(owner, { code: 'oauth-code-1', state })).rejects.toThrow(/expired or was already used/);

    // Expired state (after 10 minutes) is rejected.
    const { state: expiring } = await s.oauth.startInstall(owner, channel.workspaceId, 1_000);
    await expect(s.oauth.completeInstall(owner, { code: 'oauth-code-2', state: expiring }, 1_000 + 10 * 60_000 + 1)).rejects.toThrow(/expired/);
  });

  it('refuses a state started by A when completed by B without exchanging the code, and leaves the state unusable', async () => {
    const s = await setup();
    const { owner: personA, channel } = await crew(s.hub.registry, `oauth-bind-${uid()}`, []);
    const personB = await testPerson(s.hub.registry, `personB-${uid()}`);

    const { state } = await s.oauth.startInstall(personA, channel.workspaceId);
    const victimTeamId = `TVICTIM${uid()}`;
    s.responses.set('oauth.v2.access', () => ({
      ok: true,
      access_token: 'xoxb-victim-token',
      bot_user_id: 'UBOTV',
      team: { id: victimTeamId, name: 'Victim Slack' },
    }));

    // Person B tries to finish the install that Person A started: refused before oauth.v2.access is called.
    await expect(s.oauth.completeInstall(personB, { code: 'victim-code', state })).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.calls.filter((c) => c.url.includes('oauth.v2.access'))).toHaveLength(0);
    expect(await s.store.install(victimTeamId)).toBeUndefined();

    // The state was consumed on the failed attempt, so even Person A cannot replay it afterwards.
    await expect(s.oauth.completeInstall(personA, { code: 'victim-code', state })).rejects.toThrow(/expired or was already used/);
    expect(s.calls.filter((c) => c.url.includes('oauth.v2.access'))).toHaveLength(0);
  });

  it('lists bot channels and links/unlinks a workspace channel, replacing previous links cleanly', async () => {
    const s = await setup();
    const { owner, channel } = await crew(s.hub.registry, `chlink-${uid()}`, []);
    const teamId = `T${uid()}`;
    const [c1, c2] = [`C1${uid()}`, `C2${uid()}`];
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: channel.workspaceId, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-tok');

    s.responses.set('users.conversations', () => ({
      ok: true,
      channels: [
        { id: c2, name: 'ops', is_private: true },
        { id: c1, name: 'general', is_private: false },
      ],
    }));

    const status = await s.oauth.workspaceStatus(owner, channel.workspaceId, true);
    expect(status.channels).toEqual([
      { id: c1, name: 'general', isPrivate: false },
      { id: c2, name: 'ops', isPrivate: true },
    ]);

    await s.oauth.linkChannel(owner, channel.id, { channelId: c1 });
    expect((await s.store.linkedChannel(teamId, c1))?.parlyChannelId).toBe(channel.id);

    // Re-linking to c2 removes the old reverse index for c1.
    await s.oauth.linkChannel(owner, channel.id, { channelId: c2 });
    expect(await s.store.linkedChannel(teamId, c1)).toBeUndefined();
    expect((await s.store.linkedChannel(teamId, c2))?.parlyChannelId).toBe(channel.id);

    await s.oauth.unlinkChannel(owner, channel.id);
    expect(await s.store.linkedChannel(teamId, c2)).toBeUndefined();
  });

  it('keeps room Slack installs and shared + corner channel links strictly side-scoped', async () => {
    const s = await setup();
    const a = await testPerson(s.hub.registry, `SideA-${uid()}`);
    const b = await testPerson(s.hub.registry, `SideB-${uid()}`);
    const { workspace, room } = await s.hub.rooms.create(a, { goal: 'Partner deal', invite: b.email!, side: 'Acme', bots: [], brief: '' });
    const joinedRoom = await s.hub.rooms.joinSide((await s.hub.registry.get(b.id))!, workspace.id, { side: 'Northwind', bots: [], brief: '' });
    const sideA = joinedRoom.sides.find((x) => x.id === a.id)!;
    const sideB = joinedRoom.sides.find((x) => x.id === b.id)!;

    const [TA, TB] = [`TA${uid()}`, `TB${uid()}`];
    const personA = (await s.hub.registry.get(a.id))!;
    const personB = (await s.hub.registry.get(b.id))!;
    const { state: stateA } = await s.oauth.startInstall(personA, workspace.id);
    s.responses.set('oauth.v2.access', () => ({ ok: true, access_token: 'xoxb-a', bot_user_id: 'UBA', team: { id: TA, name: 'Acme Slack' } }));
    await s.oauth.completeInstall(personA, { code: 'ca', state: stateA });

    const { state: stateB } = await s.oauth.startInstall(personB, workspace.id);
    s.responses.set('oauth.v2.access', () => ({ ok: true, access_token: 'xoxb-b', bot_user_id: 'UBB', team: { id: TB, name: 'Northwind Slack' } }));
    await s.oauth.completeInstall(personB, { code: 'cb', state: stateB });

    const [CA_SHARED, CA_CORNER, CB_SHARED, CB_CORNER] = [`CAS${uid()}`, `CAC${uid()}`, `CBS${uid()}`, `CBC${uid()}`];
    await expect(s.oauth.linkChannel(personA, room.shared, { channelId: CA_SHARED })).rejects.toThrow(/two Slack channels/);
    await expect(s.oauth.linkChannel(personA, room.shared, { channelId: CA_SHARED, cornerChannelId: CA_SHARED })).rejects.toThrow(/two different/);
    await expect(s.oauth.linkChannel(personA, sideB.corner, { channelId: CA_SHARED, cornerChannelId: CA_CORNER })).rejects.toMatchObject({ code: 'not_found' });

    await s.oauth.linkChannel(personA, room.shared, { channelId: CA_SHARED, cornerChannelId: CA_CORNER });
    await s.oauth.linkChannel(personB, room.shared, { channelId: CB_SHARED, cornerChannelId: CB_CORNER });

    expect(await s.store.linkedChannel(TA, CA_SHARED)).toMatchObject({ parlyChannelId: room.shared, sideId: a.id });
    expect(await s.store.linkedChannel(TA, CA_CORNER)).toMatchObject({ parlyChannelId: sideA.corner, sideId: a.id });
    expect(await s.store.linkedChannel(TB, CB_SHARED)).toMatchObject({ parlyChannelId: room.shared, sideId: b.id });
    expect(await s.store.linkedChannel(TB, CB_CORNER)).toMatchObject({ parlyChannelId: sideB.corner, sideId: b.id });

    const statusA = await s.oauth.workspaceStatus(personA, workspace.id);
    expect(statusA.install?.teamId).toBe(TA);
    expect(statusA.roomLinks).toMatchObject({ sharedChannelId: CA_SHARED, cornerChannelId: CA_CORNER });

    const sharedDoc = (await s.hub.registry.channelsById([room.shared])).get(room.shared)!;
    const wsDoc = (await s.hub.registry.workspaceById(workspace.id))!;
    expect(channelView(sharedDoc, personA, wsDoc).slack).toEqual([{ teamId: TA, channelId: CA_SHARED, sideId: a.id }]);
    expect(channelView(sharedDoc, personB, wsDoc).slack).toEqual([{ teamId: TB, channelId: CB_SHARED, sideId: b.id }]);

    await s.oauth.unlinkChannel(personA, room.shared);
    expect(await s.store.linkedChannel(TA, CA_SHARED)).toBeUndefined();
    expect(await s.store.linkedChannel(TA, CA_CORNER)).toBeUndefined();
    expect(await s.store.linkedChannel(TB, CB_SHARED)).toMatchObject({ parlyChannelId: room.shared, sideId: b.id });
    expect(await s.store.linkedChannel(TB, CB_CORNER)).toMatchObject({ parlyChannelId: sideB.corner, sideId: b.id });
  });

  it('inspects a one-time identity code with email match hint, approves it once, and unlinks on leaving a workspace', async () => {
    const s = await setup();
    const { owner, channel } = await crew(s.hub.registry, `idlink-${uid()}`, []);
    const member = await testPerson(s.hub.registry, `member-${uid()}`);
    await s.hub.registry.inviteToWorkspace(owner, channel.workspaceId, member.email!);
    const freshMember = (await s.hub.registry.get(member.id))!;

    const teamId = `T${uid()}`;
    await s.store.saveInstall({ teamId, teamName: 'Acme', workspaceId: channel.workspaceId, botUserId: 'UBOT', installedBy: owner.id }, 'xoxb-tok');

    const code = (await s.store.linkCode(teamId, 'U99'))!;
    s.responses.set('users.info', () => ({
      ok: true,
      user: { real_name: 'Member Person', profile: { display_name: 'mperson', email: freshMember.email } },
    }));

    // Inspecting does not spend the code and notes that the Slack email matches the signed-in Parly person's email.
    const preview = await s.oauth.inspectLinkCode(freshMember, code);
    expect(preview).toMatchObject({
      teamId,
      teamName: 'Acme',
      slackUserId: 'U99',
      slackUserName: 'mperson',
      slackEmail: freshMember.email,
      emailMatches: true,
    });
    expect(await s.store.identity(teamId, 'U99')).toBeUndefined(); // email hint alone grants nothing

    // Approving spends the code and writes slack_identities.
    expect(await s.hub.slack!.link(freshMember, code)).toEqual({ teamName: 'Acme' });
    expect((await s.store.identity(teamId, 'U99'))?.agentId).toBe(freshMember.id);
    await expect(s.oauth.inspectLinkCode(freshMember, code)).rejects.toThrow(/expired or was already used/);

    // Leaving the workspace unlinks their Slack identity for that workspace's Slack installation.
    await s.oauth.unlinkMemberFromWorkspace(channel.workspaceId, freshMember.id);
    expect(await s.store.identity(teamId, 'U99')).toBeUndefined();
  });
});

describe('Slack: connecting without a Parly workspace', () => {
  it('makes the workspace from the Slack one, reconnects it later, and never takes over someone else\'s', async () => {
    const s = await setup();
    const me = await testPerson(s.hub.registry, `fresh-${uid()}`);
    const teamId = `T${uid()}`;
    s.responses.set('oauth.v2.access', () => ({ ok: true, access_token: 'xoxb-fresh', bot_user_id: 'UBOT', team: { id: teamId, name: 'Acme Corp' } }));

    const first = await s.oauth.startInstall(me, '');
    const made = await s.oauth.completeInstall(me, { code: 'c1', state: first.state });
    const ws = (await s.hub.registry.workspaceById(made.workspaceId))!;
    expect(ws).toMatchObject({ name: 'Acme Corp', ownerId: me.id });
    expect(made.install).toMatchObject({ teamId, workspaceId: ws.id });
    expect(made.redirectUrl).toContain(`/w/${encodeURIComponent(ws.id)}`);

    const again = await s.oauth.startInstall(me, '');
    expect((await s.oauth.completeInstall(me, { code: 'c2', state: again.state })).workspaceId).toBe(ws.id); // no second workspace

    const other = await testPerson(s.hub.registry, `other-${uid()}`);
    const theirs = await s.oauth.startInstall(other, '');
    await expect(s.oauth.completeInstall(other, { code: 'c3', state: theirs.state })).rejects.toMatchObject({ code: 'conflict' });
  });
});
