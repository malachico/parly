import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../src/lib/errors.js';
import { RateLimiter, SharedRateLimiter } from '../src/lib/rateLimit.js';
import { isPrivateHost, Registry, splitAgentUrl, type CardFetcher } from '../src/registry/registry.js';
import { crew, newAgent, testDb, testPerson } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { googleVerifier, type GoogleVerifier } from '../src/registry/google.js';
import type { AgentRecord } from '../src/registry/types.js';
import { agentView } from '../src/lib/present.js';
import { parseCardAuth } from '../src/hub/agentAuth.js';
import { A2AForwarder } from '../src/hub/forward.js';
import { randomBytes } from 'node:crypto';
import { FieldValue } from '../src/db/types.js';

const fakeCard: CardFetcher = async (baseUrl) => ({
  name: 'Weather Bot',
  description: `card at ${baseUrl}`,
  skills: [{ id: 'forecast', name: 'Forecast', tags: ['weather'] }],
});

describe('Registry', () => {
  const registry = new Registry(testDb(), { fetchCard: fakeCard });

  it('shows an unauthenticated workspace or channel listing only its public agents', async () => {
    const { workspace, channel, members } = await crew(registry, 'unauth-scope');
    expect(members.every((m) => !m.public)).toBe(true);
    expect(await registry.search(undefined, { workspace: workspace.id })).toEqual([]);
    expect(await registry.search(undefined, { channel: channel.id })).toEqual([]);
  });

  it('registers a mailbox agent and authenticates its token', async () => {
    const { agent, token } = await newAgent(registry, { name: 'Alice', description: 'first' });
    expect(agent.name).toBe('Alice');
    expect(agent.kind).toBe('mailbox');
    expect(token).toMatch(/^a2ah_/);
    expect((await registry.authenticate(token!))?.id).toBe(agent.id);
    expect(await registry.authenticate('a2ah_wrong')).toBeUndefined();
    expect(await registry.authenticate('not-a-token')).toBeUndefined();
  });

  it('bumps lastSeen at most once a minute, off the request path', async () => {
    const reg = new Registry(testDb(), { fetchCard: fakeCard });
    const { agent, token } = await newAgent(reg, { name: 'poller' });
    const col = reg.col;
    const realDoc = col.doc.bind(col);
    const ago = async (ms: number) => {
      const ts = new Date(Date.now() - ms).toISOString();
      await realDoc(agent.id).update({ lastSeen: ts });
      return ts;
    };
    const writes: unknown[] = [];
    let fail = false;
    const spy = vi.spyOn(reg.agentStore, 'update').mockImplementation(async (id, data) => {
      writes.push(data);
      if (fail) throw new Error('db down');
      await realDoc(id).update(data);
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Seen 45s ago: no write.
      await ago(45_000);
      await reg.authenticate(token!);
      await reg.authenticate(token!);
      expect(writes).toHaveLength(0);
      // Seen 2 minutes ago: one write for two calls.
      const stale = await ago(120_000);
      await reg.authenticate(token!);
      await vi.waitFor(async () => {
        expect((await realDoc(agent.id).get()).data()?.lastSeen).not.toBe(stale);
      });
      await reg.authenticate(token!);
      expect(writes).toHaveLength(1);
      // A failed write doesn't fail the request; it's logged.
      await ago(120_000);
      fail = true;
      expect((await reg.authenticate(token!))?.id).toBe(agent.id);
      await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('lastSeen update failed', agent.id, expect.any(Error)));
    } finally {
      spy.mockRestore();
      logged.mockRestore();
    }
  });

  it('lets agents share a name; the id tells them apart', async () => {
    const a = await newAgent(registry, { name: 'Same Name', public: true });
    const b = await newAgent(registry, { name: 'same name', public: true });
    expect(b.agent.id).not.toBe(a.agent.id);
    expect(b.agent.name).toBe('same name');
    expect((await registry.getVisible(a.agent.id, undefined))?.id).toBe(a.agent.id);
    // Names never address an agent; a miss on a name lists the ids to use.
    const miss = registry.requireVisible('Same Name', undefined);
    await expect(miss).rejects.toMatchObject({ code: 'not_found' });
    await expect(registry.requireVisible('Same Name', undefined)).rejects.toThrow(new RegExp(`${a.agent.id}.*${b.agent.id}|${b.agent.id}.*${a.agent.id}`));
  });

  it('lets an agent re-register itself without changing id or token', async () => {
    const { agent, token } = await newAgent(registry, { name: 'mutable', description: 'v1' });
    const { agent: updated, token: none } = await registry.register({ name: 'mutable', description: 'v2' }, agent);
    expect(none).toBeUndefined();
    expect(updated.id).toBe(agent.id);
    expect(updated.description).toBe('v2');
    expect((await registry.authenticate(token!))?.description).toBe('v2');
  });

  it('keeps fields written concurrently while an agent re-registers from a stale copy', async () => {
    const { agent } = await newAgent(registry, { name: 'racer', description: 'v1' });
    // Another writer joins a channel and starts listening after the caller was loaded.
    const listeningUntil = new Date(Date.now() + 60_000).toISOString();
    await registry.col.doc(agent.id).update({ channels: FieldValue.arrayUnion('ch-race'), listeningUntil });
    await registry.register({ name: 'racer', description: 'v2' }, agent);
    const stored = (await registry.col.doc(agent.id).get()).data() as AgentRecord;
    expect(stored.description).toBe('v2');
    expect(stored.channels).toContain('ch-race');
    expect(stored.listeningUntil).toBe(listeningUntil);
  });

  it('gives every agent an avatar seed that survives re-registration and can be redrawn', async () => {
    const { agent } = await newAgent(registry, { name: 'face' });
    expect(agent.avatar).toMatch(/^[\w-]{8}$/);
    const { agent: updated } = await registry.register({ name: 'face', description: 'v2' }, agent);
    expect(updated.avatar).toBe(agent.avatar);
    const redrawn = await registry.newAvatar(updated);
    expect(redrawn).not.toBe(agent.avatar);
    expect((await registry.get(agent.id))?.avatar).toBe(redrawn);
    // Or one the person picked from candidates.
    expect(await registry.newAvatar(updated, 'picked-1')).toBe('picked-1');
    await expect(registry.newAvatar(updated, 'no spaces')).rejects.toMatchObject({ code: 'invalid' });
    // Agents from before avatars get one when they next register.
    const { avatar: _a, ...legacy } = (await registry.get(agent.id))!;
    expect((await registry.register({ name: 'face' }, legacy)).agent.avatar).toMatch(/^[\w-]{8}$/);
  });

  it('validates names', async () => {
    await expect(newAgent(registry, { name: '' })).rejects.toBeInstanceOf(HubError);
    await expect(newAgent(registry, { name: '  \n ' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(newAgent(registry, { name: 'x'.repeat(65) })).rejects.toMatchObject({ code: 'invalid' });
    expect((await newAgent(registry, { name: '  מלאכי\tהבוט ' })).agent.name).toBe('מלאכי הבוט');
  });

  it('registers an endpoint agent from its card', async () => {
    const { agent } = await newAgent(registry, { url: 'https://weather.example.com/' });
    expect(agent).toMatchObject({
      name: 'Weather Bot',
      kind: 'endpoint',
      url: 'https://weather.example.com',
      cardPath: '.well-known/agent-card.json',
      description: 'card at https://weather.example.com',
    });
    expect(agent.skills[0]?.id).toBe('forecast');
  });

  it('resolves by name or id and searches by skill and text', async () => {
    const { agent } = await newAgent(registry, { name: 'finder', public: true, skills: [{ id: 'translate', name: 'Translate', tags: ['i18n'] }] });
    expect((await registry.getVisible(agent.id, undefined))?.name).toBe('finder');
    expect(await registry.getVisible('finder', undefined)).toBeUndefined();
    await expect(registry.requireVisible('nobody', undefined)).rejects.toMatchObject({ code: 'not_found' });
    expect((await registry.search(undefined, { skill: 'i18n' })).map((a) => a.name)).toEqual(['finder']);
    expect((await registry.search(undefined, { query: 'translate' })).map((a) => a.name)).toContain('finder');
    expect((await registry.findBySkill('translate', undefined, async () => true))?.id).toBe(agent.id);
    expect(await registry.findBySkill('translate', agent, async () => true)).toBeUndefined();
  });
});

describe('agent lifecycle', () => {
  const registry = new Registry(testDb(), { registerLimiter: new RateLimiter(2, 60_000, 'registrations') });

  it('never registers an agent without an owner, and never makes a person without Google', async () => {
    await expect(registry.register({ name: 'stray' })).rejects.toMatchObject({ code: 'forbidden' });
    const owner = await testPerson(registry);
    await expect(registry.register({ name: 'imposter', kind: 'human' }, undefined, undefined, owner.id)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.createBot(owner, { name: 'imposter', kind: 'human' })).rejects.toMatchObject({ code: 'invalid' });
    // A bot owns nothing: only people do.
    const { agent: bot } = await registry.createBot(owner, { name: 'tool' });
    await expect(registry.createBot(bot, { name: 'sub-tool' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses private, loopback and metadata agent URLs on a deployed hub', async () => {
    const owner = await testPerson(registry);
    const reg = new Registry(testDb(), { fetchCard: async () => ({ name: 'inside', description: '', skills: [] }), allowPrivateUrls: false });
    for (const url of ['http://10.128.0.3:18789', 'http://127.0.0.1:4001', 'http://169.254.169.254', 'http://192.168.1.2']) {
      await expect(reg.createBot(owner, { url, follow: true })).rejects.toMatchObject({ code: 'invalid' });
    }
  });

  it("keeps an endpoint's credential private and only for the URL it was given with", async () => {
    const owner = await testPerson(registry);
    const fetchCard = async () => ({ name: 'remote', description: '', skills: [] });
    const reg = new Registry(testDb(), { fetchCard });
    await expect(reg.createBot(owner, { name: 'x', credential: { type: 'bearer', token: 't' } })).rejects.toMatchObject({ code: 'invalid' });
    const { agent } = await reg.createBot(owner, { url: 'http://a.test', credential: { type: 'bearer', token: 't' }, follow: true });
    expect(agent.credential).toEqual({ type: 'bearer', token: 't', for: 'bearer' });
    expect(JSON.stringify(agentView(agent))).not.toContain('"t"');
    const same = (await reg.register({ url: 'http://a.test', name: 'r' }, agent)).agent;
    expect(same.credential?.type).toBe('bearer');
    const moved = (await reg.register({ url: 'http://b.test', name: 'r' }, same)).agent;
    expect(moved.credential).toBeUndefined();
  });

  it('checks a credential against the card, binds it to the scheme, and never shows it', async () => {
    const owner = await testPerson(registry);
    const card = (auth: unknown) => async () => ({ name: 'remote', description: '', skills: [], auth: parseCardAuth(auth) });
    const keyCard = { securitySchemes: { k: { apiKeySecurityScheme: { location: 'header', name: 'X-API-Key' } } }, securityRequirements: [{ schemes: { k: { list: [] } } }] };
    const reg = new Registry(testDb(), { fetchCard: card(keyCard) });
    await expect(reg.createBot(owner, { url: 'http://k.test', credential: { type: 'bearer', token: 't' }, follow: true })).rejects.toThrow(/API key in header X-API-Key/);
    await expect(reg.createBot(owner, { url: 'http://k.test', credential: { type: 'apiKey', header: 'X-Other', value: 'v' }, follow: true })).rejects.toThrow(/doesn't match/);
    const { agent } = await reg.createBot(owner, { url: 'http://k.test', credential: { type: 'apiKey', value: 'v' }, follow: true });
    expect(agent.credential).toEqual({ type: 'apiKey', header: 'X-API-Key', value: 'v', for: 'apiKey:x-api-key' });
    expect(agentView(agent, owner)).toMatchObject({ credential: { type: 'apiKey' } });
    // Only its owner sees which credential the hub holds.
    expect(agentView(agent)).not.toHaveProperty('credential');
    expect(JSON.stringify(agentView(agent))).not.toContain('"v"');

    // A card that asks only for what the hub can't send is refused with plain words.
    const oidc = new Registry(testDb(), { fetchCard: card({ securitySchemes: { o: { openIdConnectSecurityScheme: { openIdConnectUrl: 'https://x' } } } }) });
    await expect(oidc.createBot(owner, { url: 'http://o.test', credential: { type: 'bearer', token: 't' }, follow: true })).rejects.toThrow(/OpenID Connect.*can't send/);
    await expect(reg.createBot(owner, { url: 'http://k.test', credential: { type: 'magic' }, follow: true })).rejects.toThrow(/credential.type/);
  });

  it('binds OAuth2 client credentials to the card\'s token URL, with the owner\'s scopes only', async () => {
    const owner = await testPerson(registry);
    const auth = parseCardAuth({
      securitySchemes: { cc: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'https://auth.example.com/token', scopes: { read: '', write: '' } } } } } },
    });
    const reg = new Registry(testDb(), { fetchCard: async () => ({ name: 'remote', description: '', skills: [], auth }) });
    const { agent } = await reg.createBot(owner, { url: 'http://o.test', credential: { type: 'oauth2', clientId: 'id', clientSecret: 's', scopes: ['read'] }, follow: true });
    expect(agent.credential).toEqual({ type: 'oauth2', clientId: 'id', clientSecret: 's', tokenUrl: 'https://auth.example.com/token', scopes: ['read'], for: 'oauth2:https://auth.example.com/token' });
    const deployed = new Registry(testDb(), {
      allowPrivateUrls: false,
      fetchCard: async () => ({ name: 'r', description: '', skills: [], auth: parseCardAuth({ securitySchemes: { cc: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: 'http://10.0.0.1/token' } } } } } }) }),
    });
    await expect(deployed.createBot(owner, { url: 'https://o.example.com', credential: { type: 'oauth2', clientId: 'id', clientSecret: 's' }, follow: true })).rejects.toThrow(/token URL must be https/);
  });

  it('seals a credential at rest when the hub has a key, and the forwarder opens it to send', async () => {
    const owner = await testPerson(registry);
    const key = randomBytes(32);
    const db = testDb();
    const reg = new Registry(db, { sealingKey: key, fetchCard: async () => ({ name: 'remote', description: '', skills: [] }) });
    const { agent } = await reg.createBot(owner, { url: 'http://s.test', credential: { type: 'bearer', token: 'very-secret' }, follow: true });
    const raw = JSON.stringify((await db.collection('agents').doc(agent.id).get()).data());
    expect(raw).toContain('"sealed":"v1.');
    expect(raw).not.toContain('very-secret');
    expect(agent.credential).toMatchObject({ type: 'bearer', for: 'bearer' });
    expect(agentView(agent, owner)).toMatchObject({ credential: { type: 'bearer' } });
    const open = (f: A2AForwarder) => (f as unknown as { open(a: AgentRecord): unknown }).open(agent);
    expect(open(new A2AForwarder(1_000, { sealingKey: key }))).toEqual({ type: 'bearer', token: 'very-secret', for: 'bearer' });
    expect(() => open(new A2AForwarder(1_000))).toThrow(/no CREDENTIALS_KEY/);
    expect(() => open(new A2AForwarder(1_000, { sealingKey: randomBytes(32) }))).toThrow();
  });

  it('on a deployed hub without a key, refuses to store a credential at all rather than store it in the clear', async () => {
    const owner = await testPerson(registry);
    const fetchCard = async () => ({ name: 'remote', description: '', skills: [] });
    const strict = new Registry(testDb(), { fetchCard, requireSealing: true });
    await expect(strict.createBot(owner, { url: 'http://n.test', credential: { type: 'bearer', token: 't' }, follow: true })).rejects.toMatchObject({ code: 'unavailable' });
    // An agent without a credential is unaffected; with a key, credentials are stored sealed.
    expect((await strict.createBot(owner, { url: 'http://n.test', follow: true })).agent.kind).toBe('endpoint');
    const sealed = new Registry(testDb(), { fetchCard, requireSealing: true, sealingKey: randomBytes(32) });
    expect((await sealed.createBot(owner, { url: 'http://n.test', credential: { type: 'bearer', token: 't' }, follow: true })).agent.credential).toHaveProperty('sealed');
  });

  it('records and clears an endpoint agent\'s auth problem, shown in its view', async () => {
    const owner = await testPerson(registry);
    const reg = new Registry(testDb(), { fetchCard: async () => ({ name: 'remote', description: '', skills: [] }) });
    const { agent } = await reg.createBot(owner, { url: 'http://p.test', credential: { type: 'bearer', token: 't' }, follow: true });
    await reg.setAuthProblem(agent.id, "it refused the hub's credential (HTTP 401)");
    expect(agentView((await reg.get(agent.id))!, owner)).toMatchObject({ authProblem: "it refused the hub's credential (HTTP 401)" });
    // Auth problems are for the owner: anyone else who can see the agent doesn't get them.
    expect(agentView((await reg.get(agent.id))!)).not.toHaveProperty('authProblem');
    expect(agentView((await reg.get(agent.id))!, await testPerson(reg, 'someone'))).not.toHaveProperty('authProblem');
    await reg.setAuthProblem(agent.id, undefined);
    expect((await reg.get(agent.id))!.authProblem).toBeUndefined();
  });

  it('rotates a bot\'s token: the old one stops working; people have no token to rotate', async () => {
    const { agent, token } = await newAgent(registry, { name: 'rotator' });
    const fresh = await registry.rotateToken(agent);
    expect(fresh).not.toBe(token);
    expect(await registry.authenticate(token)).toBeUndefined();
    expect((await registry.authenticate(fresh))?.id).toBe(agent.id);
    await expect(registry.rotateToken(await testPerson(registry))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('limits new bots per IP, but not re-registration', async () => {
    const owner = await testPerson(registry);
    const { agent } = await registry.createBot(owner, { name: 'ip-one' }, '203.0.113.9');
    await registry.createBot(owner, { name: 'ip-two' }, '203.0.113.9');
    await expect(registry.createBot(owner, { name: 'ip-three' }, '203.0.113.9')).rejects.toMatchObject({ code: 'rate_limited' });
    await registry.register({ name: 'ip-one', description: 'updated' }, agent, '203.0.113.9');
    await registry.createBot(owner, { name: 'other-ip' }, '198.51.100.1');
  });
});

describe('RateLimiter', () => {
  it('allows `limit` hits per window, then resets', () => {
    const rl = new RateLimiter(2, 1000, 'things');
    rl.hit('k', 1, 0);
    rl.hit('k', 1, 10);
    expect(() => rl.hit('k', 1, 20)).toThrow(/Too many things. Try again in 1s/);
    rl.hit('other', 1, 20);
    expect(() => rl.hit('other', 2, 30)).toThrow(); // all or nothing: 1 + 2 > 2
    rl.hit('other', 1, 30);
    rl.hit('k', 1, 1000);
  });

  it('shares sign-in, registration and pairing counters across hub instances', async () => {
    const db = testDb();
    const a = new SharedRateLimiter(db, 'test', 2, 1000, 'attempts');
    const b = new SharedRateLimiter(db, 'test', 2, 1000, 'attempts');
    await a.hit('ip-1', 1, 0);
    await b.hit('ip-1', 1, 10);
    await expect(a.hit('ip-1', 1, 20)).rejects.toMatchObject({
      code: 'rate_limited',
      message: 'Too many attempts. Try again in 1s.',
    });
    // Another scope or key has its own window; expired windows reset.
    const otherScope = new SharedRateLimiter(db, 'other', 2, 1000, 'attempts');
    await otherScope.hit('ip-1', 1, 20);
    await b.hit('ip-1', 1, 1000);

    // Two Registry instances sharing one DB enforce one combined quota for sign-in, registration and pairing redeem.
    const verifyGoogle: GoogleVerifier = async (idToken) => ({ sub: idToken, email: `${idToken}@example.com`, name: idToken });
    const regOpts = () => ({
      verifyGoogle,
      registerLimiter: new SharedRateLimiter(db, 'register', 2, 60_000, 'registrations from your address'),
      googleLimiter: new SharedRateLimiter(db, 'sign-in', 2, 60_000, 'sign-in attempts from your address'),
    });
    const reg1 = new Registry(db, regOpts());
    const reg2 = new Registry(db, regOpts());
    const owner = await testPerson(reg1, 'owner');

    await reg1.createBot(owner, { name: 'bot-1' }, '203.0.113.10');
    await reg2.createBot(owner, { name: 'bot-2' }, '203.0.113.10');
    await expect(reg1.createBot(owner, { name: 'bot-3' }, '203.0.113.10')).rejects.toMatchObject({ code: 'rate_limited' });

    await reg1.signInWithGoogle('u1', '203.0.113.11');
    await reg2.signInWithGoogle('u1', '203.0.113.11');
    await expect(reg1.signInWithGoogle('u1', '203.0.113.11')).rejects.toMatchObject({ code: 'rate_limited' });

    const { code } = await reg1.createPairing(owner, 'Paired');
    await expect(reg1.redeemPairing('WRONG-CODE', '203.0.113.12')).rejects.toMatchObject({ code: 'unauthorized' });
    await reg2.redeemPairing(code, '203.0.113.12');
    await expect(reg1.redeemPairing('WRONG-CODE', '203.0.113.12')).rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('fails closed (rate_limited, not 500) when the DB transaction aborts', async () => {
    const fakeDb = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async () => {
        throw new Error('ABORTED: Too much contention on these documents.');
      },
    } as unknown as ConstructorParameters<typeof SharedRateLimiter>[0];
    const rl = new SharedRateLimiter(fakeDb, 'sign-in', 2, 60_000, 'sign-in attempts');
    await expect(rl.hit('ip-1')).rejects.toMatchObject({ code: 'rate_limited' });

    // A HubError thrown inside the transaction (the real limit hit) passes through unchanged.
    const limitDb = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: async () => {
        throw new HubError('rate_limited', 'Too many sign-in attempts. Try again in 42s.');
      },
    } as unknown as ConstructorParameters<typeof SharedRateLimiter>[0];
    const rl2 = new SharedRateLimiter(limitDb, 'sign-in', 2, 60_000, 'sign-in attempts');
    await expect(rl2.hit('ip-1')).rejects.toMatchObject({ code: 'rate_limited', message: /42s/ });
  });
});

describe('private agent URLs', () => {
  it('are refused when not allowed', async () => {
    const strict = new Registry(testDb(), { fetchCard: fakeCard, allowPrivateUrls: false });
    for (const url of ['http://127.0.0.1:4001', 'http://169.254.169.254/', 'http://metadata.google.internal', 'http://[::1]:80', 'http://10.1.2.3']) {
      await expect(newAgent(strict, { name: 'sneaky', url })).rejects.toMatchObject({ code: 'invalid' });
    }
    expect((await newAgent(strict, { name: 'public', url: 'https://agent.example.com' })).agent.kind).toBe('endpoint');
  });

  it('are denied by default, and allowed only when opted in', async () => {
    // Default construction (no allowPrivateUrls option) now denies private URLs.
    const def = new Registry(testDb(), { fetchCard: fakeCard });
    await expect(newAgent(def, { name: 'sneaky', url: 'http://127.0.0.1:4001' })).rejects.toMatchObject({ code: 'invalid' });
    // Explicit opt-in reaches the same URL.
    const lax = new Registry(testDb(), { fetchCard: fakeCard, allowPrivateUrls: true });
    expect((await newAgent(lax, { name: 'local', url: 'http://127.0.0.1:4001' })).agent.kind).toBe('endpoint');
  });

  it('are detected', () => {
    expect(['localhost', '192.168.1.1', '172.20.0.1', '100.64.0.1', 'fd00::1', '[fe80::1]'].every(isPrivateHost)).toBe(true);
    expect(['example.com', '8.8.8.8', '172.32.0.1', '2001:4860::8888'].some(isPrivateHost)).toBe(false);
  });

  it.each([
    ['198.18.0.1', true], ['198.19.255.255', true], ['192.0.0.8', true], ['224.0.0.1', true], ['239.255.255.250', true],
    ['240.0.0.1', true], ['255.255.255.255', true], ['[febf::1]', true], ['fe90::1', true], ['ff02::1', true],
    ['[64:ff9b::a00:1]', true], ['::ffff:a00:1', true], ['[::ffff:7f00:1]', true], ['0:0:0:0:0:ffff:a9fe:a9fe', true],
    ['198.20.0.1', false], ['192.0.1.1', false], ['223.255.255.255', false], ['2606:4700::1111', false],
  ])('classifies %s as private=%s', (host, isPrivate) => {
    expect(isPrivateHost(host)).toBe(isPrivate);
  });
});

describe('splitAgentUrl', () => {
  it('handles base URLs and full card URLs', () => {
    expect(splitAgentUrl('https://a.com/agent/')).toEqual({ url: 'https://a.com/agent', cardPath: '.well-known/agent-card.json' });
    expect(splitAgentUrl('https://a.com/x/.well-known/agent.json')).toEqual({ url: 'https://a.com/x', cardPath: '.well-known/agent.json' });
    expect(() => splitAgentUrl('ftp://a.com')).toThrow(HubError);
    expect(() => splitAgentUrl('nope')).toThrow(HubError);
  });
});

describe('Google sign-in', () => {
  // "<email>|<sub>" stands in for a verified Google credential.
  const verifyGoogle: GoogleVerifier = async (idToken) => {
    const [email, sub] = idToken.split('|');
    if (!email || !sub) throw new HubError('unauthorized', 'bad credential');
    return { email, sub, name: `Name of ${email}` };
  };
  const db = testDb();
  const registry = new Registry(db, { verifyGoogle });

  it('lets a signed-in person own bots, and only the owner manages them', async () => {
    const { agent: owner } = await registry.signInWithGoogle('bo@example.com|g-bo');
    const { agent: bot, token } = await registry.createBot(owner, { name: 'helper' });
    expect(bot).toMatchObject({ ownerId: owner.id, kind: 'mailbox' });
    expect((await registry.botsOf(owner)).map((b) => b.id)).toEqual([bot.id]);

    const { agent: stranger } = await newAgent(registry, { name: 'stranger' });
    await expect(registry.createBot(stranger, { name: 'nope' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(registry.requireSelfOrOwned(stranger, bot.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(registry.setArchived(stranger, bot.id, true)).rejects.toBeInstanceOf(HubError);

    const fresh = await registry.rotateToken(await registry.requireSelfOrOwned(owner, bot.id));
    expect(await registry.authenticate(token)).toBeUndefined();
    expect((await registry.authenticate(fresh))?.id).toBe(bot.id);
    expect((await registry.setArchived(owner, bot.id, true)).archived).toBe(true);
    expect((await registry.setArchived(owner, bot.id, false)).archived).toBe(false);
  });

  it('a token used a moment ago stops at once when rotated, archived or signed out (auth cache)', async () => {
    const { agent: owner, token: session } = await registry.signInWithGoogle('cache@example.com|g-cache');
    const { agent: bot, token } = await registry.createBot(owner, { name: 'cached' });
    // Each is used first, so its hash is in the cache when the change lands.
    expect((await registry.authenticate(token))?.id).toBe(bot.id);
    const fresh = await registry.rotateToken(await registry.requireSelfOrOwned(owner, bot.id));
    expect(await registry.authenticate(token)).toBeUndefined();

    expect((await registry.authenticate(fresh))?.id).toBe(bot.id);
    await registry.setArchived(owner, bot.id, true);
    await expect(registry.authenticate(fresh)).rejects.toMatchObject({ code: 'forbidden' });

    expect((await registry.authenticate(session))?.id).toBe(owner.id);
    await registry.revokeSession(owner, session);
    expect(await registry.authenticate(session)).toBeUndefined();
  });

  it('creates a human once, and issues a new session token per sign-in', async () => {
    const first = await registry.signInWithGoogle('ada@example.com|g-ada');
    expect(first).toMatchObject({ created: true, agent: { name: 'Name of ada@example.com', kind: 'human', email: 'ada@example.com', description: 'Name of ada@example.com' } });

    const again = await registry.signInWithGoogle('ada@example.com|g-ada');
    expect(again.created).toBe(false);
    expect(again.agent.id).toBe(first.agent.id);
    expect(again.token).not.toBe(first.token);
    expect((await registry.authenticate(first.token))?.id).toBe(first.agent.id);
    expect((await registry.authenticate(again.token))?.id).toBe(first.agent.id);

    await registry.revokeSession(again.agent, first.token);
    expect(await registry.authenticate(first.token)).toBeUndefined();
    expect((await registry.authenticate(again.token))?.id).toBe(first.agent.id);
  });

  it('uses the Google display name even when another agent has it', async () => {
    const other = (await newAgent(registry, { name: 'Name of Bob@Example.com' })).agent;
    const { agent } = await registry.signInWithGoogle('Bob@Example.com|g-bob');
    expect(agent.name).toBe('Name of Bob@Example.com');
    expect(agent.id).not.toBe(other.id);
    expect(agent.email).toBe('bob@example.com');
  });

  it('accepts dev:<email> only with the bypass on, and reports unconfigured Google sign-in', async () => {
    expect(await googleVerifier(undefined, true)('dev:Kim@Example.com')).toEqual({ sub: 'dev:kim@example.com', email: 'kim@example.com', name: 'kim' });
    await expect(googleVerifier(undefined, false)('dev:kim@example.com')).rejects.toMatchObject({ code: 'unsupported' });
    await expect(googleVerifier('client-id.apps.googleusercontent.com', false)('not-a-jwt')).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('refuses the dev bypass unless the database is a local Mongo', () => {
    const env = { ...process.env };
    try {
      process.env.GOOGLE_AUTH_DEV = '1';
      process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/?replicaSet=rs0';
      process.env.K_SERVICE = 'a2a-hub';
      expect(() => loadConfig()).toThrow(/only allowed locally/);
      delete process.env.K_SERVICE;
      expect(loadConfig().googleAuthDev).toBe(true);
      for (const uri of [undefined, 'mongodb+srv://cluster0.example.mongodb.net/', 'mongodb://db.example.com:27017', 'mongodb://localhost@evil.com/', 'mongodb://localhost,evil.com/', 'mongodb://localhost.evil.com/']) {
        if (uri === undefined) delete process.env.MONGODB_URI;
        else process.env.MONGODB_URI = uri;
        expect(() => loadConfig(), uri).toThrow(/only allowed locally/);
      }
    } finally {
      process.env = env;
    }
  });
});

describe('pairing codes', () => {
  it('connects a tool once, then the code is spent', async () => {
    const registry = new Registry(testDb());
    const owner = await testPerson(registry, 'pat');
    const { code } = await registry.createPairing(owner, "Pat's Codex");
    expect(code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    const { agent, token } = await registry.redeemPairing(` ${code.toLowerCase().replace('-', '')} `);
    expect(agent).toMatchObject({ ownerId: owner.id, name: "Pat's Codex", followsOwner: true });
    expect((await registry.authenticate(token))?.id).toBe(agent.id);
    await expect(registry.redeemPairing(code)).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(registry.redeemPairing('AAAA-AAAA')).rejects.toMatchObject({ code: 'unauthorized' });
    const { agent: bot } = await newAgent(registry, { name: 'not-a-person' });
    await expect(registry.createPairing(bot)).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('the whole directory', () => {
  it('reads only what the viewer may see: public, their workspaces and channels, their owner and bots', async () => {
    const registry = new Registry(testDb(), { fetchCard: fakeCard });
    const names = async (viewer: AgentRecord | undefined) => (await registry.search(viewer)).map((a) => a.name);
    const { owner, members: [x] } = await crew(registry, 'mine', ['x']);
    await crew(registry, 'theirs', ['y']);
    await newAgent(registry, { name: 'everyone', public: true });

    expect(await names(x)).toEqual(expect.arrayContaining(['everyone', 'mine-owner', 'x']));
    expect(await names(x)).not.toContain('y');
    expect(await names(owner)).toEqual(expect.arrayContaining(['x']));
    expect(await names(undefined)).toContain('everyone');
    expect(await names(undefined)).not.toContain('x');
    // A guest in another workspace's channel sees that channel's members.
    const { channel } = await crew(registry, 'guest', ['z']);
    await registry.col.doc(x!.id).update({ channels: FieldValue.arrayUnion(channel.id) });
    expect(await names((await registry.get(x!.id))!)).toContain('z');
  });
});
