import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { HubService } from '../src/hub/hubService.js';
import { describe as say, nextRun, parseSpec, Schedules } from '../src/hub/schedules.js';
import { crewOverHttp, newAgentOverHttp, testConfig, testDb, freePort, httpCaller } from './helpers.js';

describe('when a schedule posts next', () => {
  const at = (iso: string) => new Date(iso);
  it('posts daily at a local time, in its time zone', () => {
    // 09:00 in Bangkok (UTC+7) is 02:00 UTC.
    expect(nextRun({ repeat: 'daily', time: '09:00', tz: 'Asia/Bangkok' }, at('2026-10-15T01:00:00Z'))?.toISOString()).toBe('2026-10-15T02:00:00.000Z');
    expect(nextRun({ repeat: 'daily', time: '09:00', tz: 'Asia/Bangkok' }, at('2026-10-15T02:00:00Z'))?.toISOString()).toBe('2026-10-16T02:00:00.000Z');
  });
  it('skips weekends on weekdays, and picks the day on weekly', () => {
    // Friday 2026-10-16 10:00 UTC: next weekday 09:00 UTC is Monday the 19th.
    expect(nextRun({ repeat: 'weekdays', time: '09:00', tz: 'UTC' }, at('2026-10-16T10:00:00Z'))?.toISOString()).toBe('2026-10-19T09:00:00.000Z');
    expect(nextRun({ repeat: 'weekly', time: '09:00', day: 5, tz: 'UTC' }, at('2026-10-16T10:00:00Z'))?.toISOString()).toBe('2026-10-23T09:00:00.000Z');
  });
  it('keeps the wall-clock time across a daylight saving change', () => {
    // New York moves to UTC-4 on 2026-03-08: 09:00 is 14:00 UTC before, 13:00 UTC after.
    expect(nextRun({ repeat: 'daily', time: '09:00', tz: 'America/New_York' }, at('2026-03-07T15:00:00Z'))?.toISOString()).toBe('2026-03-08T13:00:00.000Z');
  });
  it('posts once only while in the future, and every N minutes on an interval', () => {
    expect(nextRun({ repeat: 'once', date: '2026-10-20', time: '10:00', tz: 'UTC' }, at('2026-10-15T00:00:00Z'))?.toISOString()).toBe('2026-10-20T10:00:00.000Z');
    expect(nextRun({ repeat: 'once', date: '2026-10-01', time: '10:00', tz: 'UTC' }, at('2026-10-15T00:00:00Z'))).toBeUndefined();
    expect(nextRun({ repeat: 'interval', minutes: 30, tz: 'UTC' }, at('2026-10-15T00:00:00Z'))?.toISOString()).toBe('2026-10-15T00:30:00.000Z');
  });
  it('checks what it is given, and says it in words', () => {
    expect(() => parseSpec({ repeat: 'interval', minutes: 1 })).toThrow(/at least 5/);
    expect(() => parseSpec({ repeat: 'daily', time: '25:00' })).toThrow(/HH:MM/);
    expect(() => parseSpec({ repeat: 'once', date: '2026-02-31', time: '09:00' })).toThrow(/isn't a date/);
    expect(() => parseSpec({ repeat: 'daily', time: '09:00', tz: 'Mars/Olympus' })).toThrow(/time zone/);
    expect(say(parseSpec({ repeat: 'weekdays', time: '09:00', tz: 'Asia/Bangkok' }))).toBe('Weekdays at 09:00 (Asia/Bangkok)');
  });
});

describe('one-time delivery failures', () => {
  it('retries a failed post, then completes once it is delivered', async () => {
    const schedules = new Schedules(testDb());
    const made = await schedules.create({ ownerId: 'owner', to: 'agent', text: 'reminder', repeat: 'once', date: '2099-01-01', time: '10:00', tz: 'UTC' });
    const due = new Date(made.nextAt!);
    expect(await schedules.runDue(async () => { throw new Error('temporarily unavailable'); }, due)).toBe(0);
    const failed = (await schedules.get(made.id))!;
    expect(failed).toMatchObject({ active: true, failures: 1, problem: 'temporarily unavailable' });
    expect(Date.parse(failed.nextAt!)).toBeGreaterThan(due.getTime());

    const delivered: string[] = [];
    const post = async (s: { text: string }) => { delivered.push(s.text); };
    expect(await schedules.runDue(post, due)).toBe(0);
    expect(await schedules.runDue(post, new Date(failed.nextAt!))).toBe(1);
    expect(await schedules.runDue(post, new Date(failed.nextAt!))).toBe(0);
    expect(delivered).toEqual(['reminder']);
    expect(await schedules.get(made.id)).toMatchObject({ active: false, failures: 0 });
    expect((await schedules.get(made.id))!.problem).toBeUndefined();
  });

  it('pauses after three failed attempts rather than retrying forever', async () => {
    const schedules = new Schedules(testDb());
    const made = await schedules.create({ ownerId: 'owner', to: 'agent', text: 'reminder', repeat: 'once', date: '2099-01-01', time: '10:00', tz: 'UTC' });
    for (let i = 1; i <= 3; i++) {
      const current = (await schedules.get(made.id))!;
      expect(await schedules.runDue(async () => { throw new Error('unavailable'); }, new Date(current.nextAt!))).toBe(0);
      expect((await schedules.get(made.id))!.failures).toBe(i);
    }
    const paused = (await schedules.get(made.id))!;
    expect(paused.active).toBe(false);
    expect(paused.nextAt).toBeUndefined();
    expect(await schedules.runDue(async () => { throw new Error('must not run'); }, new Date('2099-01-02'))).toBe(0);
  });
});

describe('scheduled messages', () => {
  let hubUrl: string;
  let server: Server;
  let hub: HubService;
  let qa: Awaited<ReturnType<typeof newAgentOverHttp>>;
  let channelId: string;
  const SECRET = 'tick-secret-for-tests';

  const call = httpCaller(() => hubUrl);

  beforeAll(async () => {
    const port = await freePort();
    hubUrl = `http://127.0.0.1:${port}`;
    let app;
    ({ app, hub } = createApp({ db: testDb(), config: { ...testConfig({ port, publicUrl: hubUrl }), tickSecret: SECRET } }));
    server = await new Promise<Server>((resolve) => {
      const s = app.listen(port, '127.0.0.1', () => resolve(s));
    });
    qa = await newAgentOverHttp(hubUrl, { name: 'QA' });
    ({ channelId } = await crewOverHttp(hubUrl, [qa], 'daily'));
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(r));
  });

  it('posts as whoever scheduled it, with a clock, when due, mentioning who it names, then waits for the next time', async () => {
    const made = await call(qa.owner.token, 'POST', `/channels/${channelId}/schedules`, { text: '@QA run the E2E suite', repeat: 'daily', time: '09:00', tz: 'Asia/Bangkok' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ when: 'Every day at 09:00 (Asia/Bangkok)', active: true });

    expect(await hub.scheduleService.runSchedules(new Date(Date.parse(made.json.nextAt) - 60_000))).toBe(0); // not yet
    expect(await hub.scheduleService.runSchedules(new Date(made.json.nextAt))).toBe(1);
    const page = await call(qa.owner.token, 'GET', `/conversations/channel:${channelId}/messages`);
    const last = page.json.messages.at(-1);
    expect(last).toMatchObject({ text: '⏰ @QA run the E2E suite', mentions: [qa.agent.id], fromId: qa.owner.id });

    const listed = await call(qa.owner.token, 'GET', `/channels/${channelId}/schedules`);
    expect(Date.parse(listed.json[0].nextAt)).toBe(Date.parse(made.json.nextAt) + 24 * 60 * 60_000);
    expect(await hub.scheduleService.runSchedules(new Date(made.json.nextAt))).toBe(0); // already posted for that time
  });

  it('lists everything you scheduled, in channels and to agents, in one place (the Triggers panel)', async () => {
    const digest = await call(qa.owner.token, 'POST', `/agents/${qa.agent.id}/schedules`, { text: 'morning digest', repeat: 'weekdays', time: '08:00', tz: 'UTC' });
    const mine = await call(qa.owner.token, 'GET', '/me/schedules');
    expect(mine.status).toBe(200);
    expect(mine.json.map((s: any) => [s.text, s.channelId ? 'channel' : 'agent'])).toEqual(expect.arrayContaining([['@QA run the E2E suite', 'channel'], ['morning digest', 'agent']]));
    await call(qa.owner.token, 'DELETE', `/schedules/${digest.json.id}`);
  });

  it('pauses, resumes and deletes, and never adds a bot to the team', async () => {
    const made = await call(qa.owner.token, 'POST', `/channels/${channelId}/schedules`, { text: 'standup', repeat: 'interval', minutes: 30 });
    const paused = await call(qa.owner.token, 'PATCH', `/schedules/${made.json.id}`, { active: false });
    expect(paused.json).toMatchObject({ active: false });
    expect(paused.json.nextAt).toBeUndefined();
    expect((await call(qa.owner.token, 'PATCH', `/schedules/${made.json.id}`, { active: true })).json.active).toBe(true);
    expect((await call(qa.owner.token, 'DELETE', `/schedules/${made.json.id}`)).status).toBe(200);
    const listed = await call(qa.owner.token, 'GET', `/channels/${channelId}/schedules`);
    expect(listed.json.map((s: any) => s.text)).toEqual(['@QA run the E2E suite']);
    const members = await call(qa.owner.token, 'GET', `/agents?channel=${channelId}`);
    expect(members.json.filter((a: any) => a.scheduler)).toHaveLength(0);
  });

  it('lets an agent schedule for its owner, and edits text and timing', async () => {
    const made = await call(qa.token, 'POST', `/channels/${channelId}/schedules`, { text: 'check CI', repeat: 'once', date: '2099-01-01', time: '10:00', tz: 'UTC' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ ownerId: qa.owner.id, when: 'On 2099-01-01 at 10:00 (UTC)' }); // its owner's, so they can change it in the panel
    expect((await call(qa.owner.token, 'PATCH', `/schedules/${made.json.id}`, { active: false })).json.active).toBe(false);
    expect((await call(qa.owner.token, 'PATCH', `/schedules/${made.json.id}`, { active: true })).json.active).toBe(true);
    const edited = await call(qa.token, 'PATCH', `/schedules/${made.json.id}`, { text: 'check CI again', repeat: 'weekly', day: 1, time: '08:30' });
    expect(edited.json).toMatchObject({ text: 'check CI again', when: 'Mondays at 08:30 (UTC)', active: true });
    expect(edited.json.date).toBeUndefined();
    expect(new Date(edited.json.nextAt).getUTCDay()).toBe(1);
    const other = await newAgentOverHttp(hubUrl, { name: 'Stranger' });
    expect((await call(other.token, 'PATCH', `/schedules/${made.json.id}`, { text: 'x' })).status).toBe(404); // not in the channel
    await call(qa.token, 'DELETE', `/schedules/${made.json.id}`);
  });

  it("an agent's trigger posts as it (⏰) and wakes it; a person can give a trigger to their agent", async () => {
    const own = await call(qa.token, 'POST', `/channels/${channelId}/schedules`, { text: 'nightly triage', repeat: 'once', date: '2099-01-02', time: '10:00', tz: 'UTC' });
    expect(own.json).toMatchObject({ ownerId: qa.owner.id, agentId: qa.agent.id });
    const given = await call(qa.owner.token, 'POST', `/channels/${channelId}/schedules`, { text: 'weekly report', agent: qa.agent.id, repeat: 'once', date: '2099-01-02', time: '10:00', tz: 'UTC' });
    expect(given.json).toMatchObject({ ownerId: qa.owner.id, agentId: qa.agent.id });
    const stranger = await newAgentOverHttp(hubUrl, { name: 'NotMine' });
    expect((await call(qa.owner.token, 'POST', `/channels/${channelId}/schedules`, { text: 'x', agent: stranger.agent.id, repeat: 'daily', time: '08:00' })).status).toBe(400);

    const agent = (await hub.registry.get(qa.agent.id))!;
    await hub.chat.take(agent);
    expect(await hub.scheduleService.runSchedules(new Date(own.json.nextAt))).toBeGreaterThanOrEqual(2);
    const posted = (await call(qa.owner.token, 'GET', `/conversations/channel:${channelId}/messages`)).json.messages
      .filter((m: any) => /nightly triage|weekly report/.test(m.text)); // other tests' due schedules fire too
    expect(posted.map((m: any) => m.fromId)).toEqual([qa.agent.id, qa.agent.id]);
    expect(JSON.stringify(await hub.chat.newFor(agent))).toContain('⏰');
  });

  it('schedules a direct message to an agent, sent as its owner with a clock, into their own conversation', async () => {
    const made = await call(qa.owner.token, 'POST', `/agents/${qa.agent.id}/schedules`, { text: 'daily summary please', repeat: 'daily', time: '08:00', tz: 'UTC' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ to: qa.agent.id, ownerId: qa.owner.id });
    expect(made.json.channelId).toBeUndefined();
    expect((await call(qa.owner.token, 'GET', `/agents/${qa.agent.id}/schedules`)).json.map((x: any) => x.id)).toEqual([made.json.id]);
    expect((await call(qa.owner.token, 'POST', `/agents/${qa.owner.id}/schedules`, { text: 'x', repeat: 'daily', time: '08:00' })).status).toBe(400); // not to yourself

    expect(await hub.scheduleService.runSchedules(new Date(made.json.nextAt))).toBe(1);
    const dm = await call(qa.owner.token, 'GET', `/conversations/agent:${qa.agent.id}/messages`);
    expect(dm.json.messages.at(-1)).toMatchObject({ fromId: qa.owner.id, text: '⏰ daily summary please' });

    const other = await newAgentOverHttp(hubUrl, { name: 'Other' });
    expect((await call(other.owner.token, 'DELETE', `/schedules/${made.json.id}`)).status).toBe(404); // someone else's
    expect((await call(qa.token, 'PATCH', `/schedules/${made.json.id}`, { active: false })).json.active).toBe(false); // the owner's agent may
    await call(qa.owner.token, 'DELETE', `/schedules/${made.json.id}`);
  });

  it('/tick runs only with the secret', async () => {
    expect((await call(undefined, 'POST', '/tick')).status).toBe(404);
    expect((await call(undefined, 'POST', '/tick', undefined, { 'x-tick-secret': 'wrong-secret-of-same-len' })).status).toBe(404);
    expect((await call(undefined, 'POST', '/tick', undefined, { 'x-tick-secret': SECRET })).json).toEqual({ ran: 0, woken: 0, slept: 0, appEvents: 0 });
  });
});
