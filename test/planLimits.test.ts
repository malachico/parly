import { describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import { PlanLimitError } from '../src/lib/errors.js';
import { myWorkspaces } from '../src/rest/helpers.js';
import { testConfig, testDb, testPerson } from './helpers.js';

const CLOUD = { model: 'gemini-4-argon', project: 'proj', location: 'global', prices: { input: 2, output: 12 } };
// "<email>|<sub>" stands in for a verified Google credential.
const verifyGoogle = async (idToken: string) => {
  const [email = '', sub = ''] = idToken.split('|');
  return { email, sub, name: email.split('@')[0]! };
};
const billed = () => createHub({ db: testDb(), config: testConfig({ cloudAgents: CLOUD }), verifyGoogle });

async function planLimit(p: Promise<unknown>): Promise<PlanLimitError['info']> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PlanLimitError);
  return (err as PlanLimitError).info;
}

describe('plan limits', () => {
  it('Free owns 2 workspaces; archiving frees one and restoring past the cap is refused', async () => {
    const hub = billed();
    const person = await testPerson(hub.registry);
    const a = await hub.registry.createWorkspace(person, 'a');
    await hub.registry.createWorkspace(person, 'b');
    const third = hub.registry.createWorkspace(person, 'c');
    await expect(third).rejects.toThrow("You're in 2 of 2 workspaces on the Free plan. Upgrade or leave one to join or create more.");
    expect(await planLimit(hub.registry.createWorkspace(person, 'c'))).toEqual({ code: 'PLAN_LIMIT', limit: 'workspaces', count: 2, max: 2, plan: 'free' });
    await hub.registry.setWorkspaceArchived(person, a.id, true);
    await hub.registry.createWorkspace(person, 'c');
    expect(await planLimit(hub.registry.setWorkspaceArchived(person, a.id, false))).toMatchObject({ limit: 'workspaces', count: 2 });
  });

  it('Free counts joined workspaces too: owned + joined is capped at 2', async () => {
    const hub = billed();
    const person = await testPerson(hub.registry);
    const other = await testPerson(hub.registry, 'Other');
    await hub.registry.createWorkspace(person, 'mine');
    const theirs = await hub.registry.createWorkspace(other, 'theirs');
    await hub.registry.inviteToWorkspace(other, theirs.id, person.email!);
    expect((await hub.registry.get(person.id))!.workspaces).toContain(theirs.id);
    // In 2 now: can't create a third, and can't be added to a third.
    expect(await planLimit(hub.registry.createWorkspace(person, 'c'))).toMatchObject({ limit: 'workspaces', count: 2, max: 2 });
    const third = await hub.registry.createWorkspace(other, 'third');
    await expect(hub.registry.inviteToWorkspace(other, third.id, person.email!)).rejects.toThrow("They're already in 2 of 2 workspaces");
  });

  it('caps participants per workspace: bots and invites count, archived bots do not, and an over-cap workspace keeps everyone', async () => {
    const hub = billed();
    const owner = await testPerson(hub.registry);
    const ws = await hub.registry.createWorkspace(owner, 'team');
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 3 });
    const [b1, b2] = [(await hub.registry.createBot(owner, { name: 'B1' })).agent, (await hub.registry.createBot(owner, { name: 'B2' })).agent];
    await hub.registry.addToWorkspace(owner, ws.id, b1.id);
    await hub.registry.inviteToWorkspace(owner, ws.id, 'someone@people.test');
    expect(await hub.registry.workspaceUsage(ws)).toEqual({ count: 3, max: 3, plan: 'free' });
    expect(await planLimit(hub.registry.addToWorkspace(owner, ws.id, b2.id))).toEqual({ code: 'PLAN_LIMIT', limit: 'participants', count: 3, max: 3, plan: 'free' });
    await expect(hub.registry.inviteToWorkspace(owner, ws.id, 'another@people.test')).rejects.toThrow('This workspace has 3 of 3 participants on the Free plan. Upgrade to add more.');
    // Re-inviting someone already invited is not a new seat.
    await hub.registry.inviteToWorkspace(owner, ws.id, 'someone@people.test');
    // A cloud agent made straight into a full workspace is refused before it exists.
    await expect(hub.createCloudAgent(owner, { name: 'C', workspaceId: ws.id })).rejects.toThrow(PlanLimitError);
    expect((await hub.registry.botsOf(owner)).map((b) => b.name)).toEqual(['B1', 'B2']);

    // Archiving a bot frees its seat, and restoring it into the full workspace is refused.
    await hub.registry.setArchived(owner, b1.id, true);
    await hub.registry.addToWorkspace(owner, ws.id, b2.id);
    expect(await planLimit(hub.registry.setArchived(owner, b1.id, false))).toMatchObject({ limit: 'participants', count: 3 });

    // Downgraded below its size: nobody is removed, nobody new gets in.
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 2 });
    expect(await hub.registry.workspaceUsage(ws)).toMatchObject({ count: 3, max: 2 });
    await expect(hub.registry.inviteToWorkspace(owner, ws.id, 'another@people.test')).rejects.toThrow(PlanLimitError);
    // An invite already sent can still be accepted.
    const invited = (await hub.registry.signInWithGoogle('someone@people.test|g-someone')).agent;
    expect(invited.workspaces).toContain(ws.id);
    // A member who isn't the owner is told to ask the owner.
    await expect(hub.registry.inviteToWorkspace(invited, ws.id, 'another@people.test')).rejects.toThrow(
      "This workspace has 3 of 2 participants on the owner's Free plan. Ask the workspace owner to upgrade.",
    );
  });

  it("a public workspace's human guests take no seat, its bots do", async () => {
    const hub = billed();
    const owner = await testPerson(hub.registry);
    const created = await hub.registry.createWorkspace(owner, 'open');
    const table = await hub.registry.createChannel(owner, created.id, 'table');
    const ws = await hub.registry.setWorkspacePublicShowcase(owner, created.id, true, { publicChannels: [table.id] });
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 2 });
    for (const name of ['G1', 'G2', 'G3']) await hub.registry.joinPublicWorkspace(await testPerson(hub.registry, name), ws.id);
    expect((await hub.registry.workspaceUsage(ws)).count).toBe(1);
    const bot = (await hub.registry.createBot(owner, { name: 'Bot' })).agent;
    await hub.registry.addToWorkspace(owner, ws.id, bot.id);
    const bot2 = (await hub.registry.createBot(owner, { name: 'Bot 2' })).agent;
    await expect(hub.registry.addToWorkspace(owner, ws.id, bot2.id)).rejects.toThrow(PlanLimitError);
  });

  it('super admins and self-hosted hubs have no limits', async () => {
    const hub = billed();
    const admin = await testPerson(hub.registry, 'Admin');
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = admin.email;
    try {
      for (const name of ['a', 'b', 'c']) await hub.registry.createWorkspace(admin, name);
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }

    const selfHosted = createHub({ db: testDb(), config: testConfig() });
    const person = await testPerson(selfHosted.registry);
    const ws = await selfHosted.registry.createWorkspace(person, 'a');
    for (const name of ['b', 'c']) await selfHosted.registry.createWorkspace(person, name);
    await selfHosted.billing.setPlan(person.id, { plan: 'free', maxParticipants: 1 });
    const bot = (await selfHosted.registry.createBot(person, { name: 'Bot' })).agent;
    await selfHosted.registry.addToWorkspace(person, ws.id, bot.id);
    expect(await selfHosted.registry.workspaceUsage(ws)).toMatchObject({ count: 2, max: null });
    expect(await selfHosted.registry.ownedWorkspaceUsage(person)).toMatchObject({ count: 3, max: null });
  });
  it('two parallel adds for the last seat: exactly one wins', async () => {
    const hub = billed();
    const owner = await testPerson(hub.registry);
    const ws = await hub.registry.createWorkspace(owner, 'team');
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 2 });
    const [b1, b2] = [(await hub.registry.createBot(owner, { name: 'B1' })).agent, (await hub.registry.createBot(owner, { name: 'B2' })).agent];
    const results = await Promise.allSettled([hub.registry.addToWorkspace(owner, ws.id, b1.id), hub.registry.addToWorkspace(owner, ws.id, b2.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(PlanLimitError);
    expect(await hub.registry.workspaceUsage(ws)).toMatchObject({ count: 2, max: 2 });
  });

  it('two parallel workspace creations for the last slot: exactly one wins', async () => {
    const hub = billed();
    const person = await testPerson(hub.registry);
    await hub.registry.createWorkspace(person, 'a');
    const results = await Promise.allSettled([hub.registry.createWorkspace(person, 'b'), hub.registry.createWorkspace(person, 'c')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r): r is PromiseRejectedResult => r.status === 'rejected')!.reason).toBeInstanceOf(PlanLimitError);
    expect((await hub.registry.ownedWorkspaceUsage(person)).count).toBe(2);
  });

  it('promoting a public guest to owner takes a seat; re-promoting an owner does not', async () => {
    const hub = billed();
    const owner = await testPerson(hub.registry);
    const created = await hub.registry.createWorkspace(owner, 'open');
    const table = await hub.registry.createChannel(owner, created.id, 'table');
    const ws = await hub.registry.setWorkspacePublicShowcase(owner, created.id, true, { publicChannels: [table.id] });
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 2 });
    const [g1, g2] = [await testPerson(hub.registry, 'G1'), await testPerson(hub.registry, 'G2')];
    for (const g of [g1, g2]) await hub.registry.joinPublicWorkspace(g, ws.id);
    const promoted = await hub.registry.addWorkspaceOwner(owner, ws.id, g1.id);
    expect((await hub.registry.workspaceUsage(promoted)).count).toBe(2);
    expect(await planLimit(hub.registry.addWorkspaceOwner(owner, ws.id, g2.id))).toMatchObject({ limit: 'participants', count: 2, max: 2 });
    await hub.registry.addWorkspaceOwner(owner, ws.id, g1.id);
    await hub.registry.addWorkspaceOwner(owner, ws.id, owner.id);
  });

  it('a Free guest already in 2 workspaces cannot be promoted to owner of a public workspace', async () => {
    const hub = billed();
    const owner = await testPerson(hub.registry);
    const created = await hub.registry.createWorkspace(owner, 'open');
    const table = await hub.registry.createChannel(owner, created.id, 'table');
    const ws = await hub.registry.setWorkspacePublicShowcase(owner, created.id, true, { publicChannels: [table.id] });
    const guest = await testPerson(hub.registry, 'Guest');
    for (const name of ['a', 'b']) await hub.registry.createWorkspace(guest, name);
    await hub.registry.joinPublicWorkspace(guest, ws.id);
    expect(await planLimit(hub.registry.addWorkspaceOwner(owner, ws.id, guest.id))).toMatchObject({ limit: 'workspaces', count: 2, max: 2 });
    expect((await hub.registry.ownedWorkspaceUsage(guest)).count).toBe(2);
  });

  it('a domain sign-in racing a normal add for the last seat skips the full workspace and still signs in', async () => {
    const hub = billed();
    const signIn = async (email: string) => (await hub.registry.signInWithGoogle(`${email}|g-${email}`)).agent;
    const boss = await signIn('boss@race-co.test');
    const [ws] = await hub.registry.workspacesOf(boss);
    await hub.registry.setWorkspaceDomains(boss, ws!.id, ['race-co.test']);
    await hub.billing.setPlan(boss.id, { plan: 'free', maxParticipants: 2 });
    const { agent: bot } = await hub.registry.createBot(boss, { name: 'B1' });
    // Pause sign-in after it has found and vetted the domain workspace, and fill the last seat before its join commits.
    const db = hub.registry.db as { runTransaction: (fn: never) => Promise<unknown> };
    const lookup = hub.registry.authStore.workspacesWithDomain.bind(hub.registry.authStore);
    const run = db.runTransaction.bind(db);
    let armed = false;
    hub.registry.authStore.workspacesWithDomain = async (d) => ((armed = true), lookup(d));
    db.runTransaction = async (fn) => {
      if (armed) {
        armed = false;
        await hub.registry.addToWorkspace(boss, ws!.id, bot.id);
      }
      return run(fn);
    };
    const dev = await signIn('dev@race-co.test');
    expect(dev.workspaces).not.toContain(ws!.id);
    const stored = (await hub.registry.get(dev.id))!;
    expect(stored.workspaces).not.toContain(ws!.id);
    expect(stored.billingAccountId).toBeUndefined();
    expect(await hub.registry.workspaceUsage(ws!)).toMatchObject({ count: 2, max: 2 });
  });

  it("exempt viewers see no max; everyone else sees the owner's", async () => {
    const hub = billed();
    const [owner, admin] = [await testPerson(hub.registry), await testPerson(hub.registry, 'Admin')];
    const ws = await hub.registry.createWorkspace(owner, 'team');
    await hub.registry.inviteToWorkspace(owner, ws.id, admin.email!);
    const member = (await hub.registry.get(admin.id))!;
    await hub.billing.setPlan(owner.id, { plan: 'free', maxParticipants: 5 });
    const before = process.env.SUPER_ADMIN_EMAILS;
    process.env.SUPER_ADMIN_EMAILS = admin.email;
    try {
      expect(await hub.registry.workspaceUsage(ws, member)).toMatchObject({ max: null });
      expect((await myWorkspaces(hub, member)).find((w) => w.id === ws.id)!.participants).toMatchObject({ max: null });
      expect(await hub.registry.ownedWorkspaceUsage(member, member)).toMatchObject({ max: null });
      expect(await hub.registry.workspaceUsage(ws, owner)).toMatchObject({ max: 5 });
      expect((await myWorkspaces(hub, owner)).find((w) => w.id === ws.id)!.participants).toMatchObject({ max: 5 });
      expect(await hub.registry.ownedWorkspaceUsage(owner, owner)).toMatchObject({ max: 2 });
    } finally {
      process.env.SUPER_ADMIN_EMAILS = before;
    }
  });
});
