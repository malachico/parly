import { beforeAll, describe, expect, it } from 'vitest';
import { createHub } from '../src/app.js';
import type { ForwardResult, Forwarder } from '../src/hub/forward.js';
import type { HubService } from '../src/hub/hubService.js';
import { md5Base64, MemoryFileStore } from '../src/files/store.js';
import { messageView } from '../src/lib/present.js';
import type { WireMessage } from '../src/lib/wire.js';
import type { AgentRecord } from '../src/registry/types.js';
import { crew, newAgent, testConfig, testDb, testPerson } from './helpers.js';

class RecordingForwarder implements Forwarder {
  sent: WireMessage[] = [];
  replyParts: WireMessage['parts'] = [{ text: 'got it' }];
  async send(_a: AgentRecord, m: WireMessage): Promise<ForwardResult> {
    this.sent.push(m);
    return { kind: 'message', message: { messageId: 'r', role: 'ROLE_AGENT', parts: this.replyParts } };
  }
  async getTask(): Promise<never> {
    throw new Error('unused');
  }
  async cancel() {}
}

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('files', () => {
  let hub: HubService;
    let store: MemoryFileStore;
  let forwarder: RecordingForwarder;
  let ann: AgentRecord;
  let ben: AgentRecord;
  let eve: AgentRecord;

  beforeAll(async () => {
    store = new MemoryFileStore();
    forwarder = new RecordingForwarder();
    hub = createHub({ db: testDb(), config: testConfig({ maxFileBytes: 1024 }), fileStore: store, forwarder, fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
    ann = (await newAgent(hub.registry, { name: 'ann', public: true })).agent;
    ben = (await newAgent(hub.registry, { name: 'ben', public: true })).agent;
    eve = (await newAgent(hub.registry, { name: 'eve', public: true })).agent;
  });

  it('attaches an upload; the recipient can download it, an outsider cannot', async () => {
    const file = await hub.files.uploadInline(ann, { name: 'notes.txt', mediaType: 'text/plain', contentBase64: b64('hello') });
    const task = await hub.send(ann, { to: ben.id }, await hub.parts(ann, 'see attached', undefined, [file.id]));

    const view = messageView(task.message);
    expect(view.files).toEqual([{ id: file.id, name: 'notes.txt', mediaType: 'text/plain', size: 5, url: `http://127.0.0.1:0/files/${file.id}` }]);
    expect((await hub.fileForDownload(ben, file.id)).id).toBe(file.id);
    await expect(hub.fileForDownload(eve, file.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(await hub.files.downloadUrl((await hub.files.get(file.id))!)).toContain('disposition=attachment');
  });

  it("a bot's owner can download what its bot received (they see its conversations); another person can't", async () => {
    const owner = await testPerson(hub.registry, 'files-owner');
    const { agent: bot } = await hub.registry.createBot(owner, { name: 'files-bot', public: true });
    const file = await hub.files.uploadInline(ann, { name: 'spec.txt', contentBase64: b64('spec') });
    await hub.send(ann, { to: bot.id }, await hub.parts(ann, 'for your bot', undefined, [file.id]));
    expect((await hub.fileForDownload((await hub.registry.get(owner.id))!, file.id)).id).toBe(file.id);
    await expect(hub.fileForDownload(await testPerson(hub.registry, 'files-other'), file.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it("refuses someone else's file and unfinished uploads", async () => {
    const theirs = await hub.files.uploadInline(ben, { name: 'b.txt', contentBase64: b64('b') });
    await expect(hub.parts(ann, 'x', undefined, [theirs.id])).rejects.toMatchObject({ code: 'not_found' });
    const pending = await hub.files.create(ann, { name: 'p.bin', size: 3, md5: md5Base64(Buffer.from('abc')) });
    await expect(hub.parts(ann, 'x', undefined, [pending.file.id])).rejects.toMatchObject({ code: 'conflict' });
    await expect(hub.parts(ann, 'x', undefined, ['not', 'strings', 3] as never)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('completes a signed upload only when the stored bytes match what was declared', async () => {
    const bytes = Buffer.from('signed bytes');
    const { file, upload } = await hub.files.create(ann, { name: 'a.bin', mediaType: 'application/octet-stream', size: bytes.length, md5: md5Base64(bytes) });
    expect(upload.method).toBe('PUT');
    await expect(hub.files.complete(ann, file.id)).rejects.toMatchObject({ code: 'conflict' }); // nothing uploaded yet
    await store.put(`files/${file.id}`, Buffer.from('other bytes!'), 'application/octet-stream');
    await expect(hub.files.complete(ann, file.id)).rejects.toThrow(/don't match/);
    await store.put(`files/${file.id}`, bytes, 'application/octet-stream');
    expect((await hub.files.complete(ann, file.id)).status).toBe('ready');
    await expect(hub.files.complete(ben, file.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('enforces the size limit and validates input', async () => {
    await expect(hub.files.create(ann, { name: 'big', size: 2048, md5: md5Base64(Buffer.from('x')) })).rejects.toThrow(/limited to/);
    await expect(hub.files.create(ann, { name: 'x', size: 1, md5: 'nope' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(hub.files.uploadInline(ann, { name: '../../etc/passwd', mediaType: 'text/html; x', contentBase64: b64('x') })).rejects.toMatchObject({ code: 'invalid' });
    expect((await hub.files.uploadInline(ann, { name: '../../etc/passwd', contentBase64: b64('x') })).name).toBe('passwd');
  });

  it('a reply can carry files back to the sender', async () => {
    const task = await hub.send(ann, { to: ben.id }, [{ text: 'send me the report' }]);
    const report = await hub.files.uploadInline(ben, { name: 'report.png', mediaType: 'image/png', contentBase64: b64('png') });
    await hub.send(ben, { replyTo: task.message.id }, await hub.parts(ben, 'here', undefined, [report.id]));
    const file = await hub.fileForDownload(ann, report.id);
    expect(await hub.files.downloadUrl(file)).toContain('disposition=inline');
  });

  it('videos play in the browser; files that could run script still download', async () => {
    const clip = await hub.files.uploadInline(ann, { name: 'clip.mp4', mediaType: 'video/mp4', contentBase64: b64('mp4') });
    const page = await hub.files.uploadInline(ann, { name: 'page.html', mediaType: 'text/html', contentBase64: b64('<script>') });
    expect(await hub.files.downloadUrl(await hub.fileForDownload(ann, clip.id))).toContain('disposition=inline');
    expect(await hub.files.downloadUrl(await hub.fileForDownload(ann, page.id))).toContain('disposition=attachment');
    // Asked to save it, a video downloads instead of playing.
    expect(await hub.files.downloadUrl(await hub.fileForDownload(ann, clip.id), { attachment: true })).toContain('disposition=attachment');
  });

  it('channel posts share files with every member; a workspace member outside a direct conversation gets nothing', async () => {
    const { owner, workspace, channel } = await crew(hub.registry, 'crew', []);
    for (const x of [ann, ben, eve]) {
      await hub.registry.addToWorkspace(owner, workspace.id, x.id);
      await hub.registry.addToChannel(owner, channel.id, x.id);
    }
    const [a, b, e] = await Promise.all([ann, ben, eve].map(async (x) => (await hub.registry.get(x.id))!));
    const plan = await hub.files.uploadInline(a!, { name: 'plan.md', contentBase64: b64('# plan') });
    await hub.send(a!, { channel: channel.id }, await hub.parts(a!, 'plan', undefined, [plan.id]));
    expect((await hub.fileForDownload(b!, plan.id)).id).toBe(plan.id);
    expect((await hub.fileForDownload(e!, plan.id)).id).toBe(plan.id);

    // Someone who joins later reads the channel's earlier posts, so their files too.
    const late = (await newAgent(hub.registry, { name: 'files-late', public: true })).agent;
    await expect(hub.fileForDownload(late, plan.id)).rejects.toMatchObject({ code: 'not_found' });
    await hub.registry.addToWorkspace(owner, workspace.id, late.id);
    await hub.registry.addToChannel(owner, channel.id, late.id);
    expect((await hub.fileForDownload((await hub.registry.get(late.id))!, plan.id)).id).toBe(plan.id);

    const secret = await hub.files.uploadInline(a!, { name: 'dm.txt', contentBase64: b64('just for ben') });
    await hub.send(a!, { to: b!.id }, await hub.parts(a!, 'dm', undefined, [secret.id]));
    await expect(hub.fileForDownload(e!, secret.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('endpoint agents get a signed link instead of the hub URL', async () => {
    const ep = (await newAgent(hub.registry, { url: 'http://agent.test', public: true })).agent;
    const file = await hub.files.uploadInline(ann, { name: 'data.csv', mediaType: 'text/csv', contentBase64: b64('a,b') });
    await hub.send(ann, { to: ep.id }, await hub.parts(ann, 'data', undefined, [file.id]));
    await hub.wakeService.idle();
    const filePart = forwarder.sent.at(-1)!.parts.find((p) => p.metadata?.fileId === file.id)!;
    expect(filePart.url).toMatch(/^memory:\/\/get\/files\//);
  });

  describe('forged file references (anything not minted by the hub grants nothing)', () => {
    const forged = (fileId: string) => ({ url: 'https://evil.test/x', filename: 'x', metadata: { fileId } });

    it('in a sent message or a reply', async () => {
      const secret = await hub.files.uploadInline(ben, { name: 'secret.txt', contentBase64: b64('ben only') });
      // Raw parts, as an A2A client would send them.
      const sent = await hub.send(eve, { to: ann.id }, [{ text: 'hi' }, forged(secret.id)]);
      expect(sent.message.parts[1]!.metadata).toEqual({});
      await expect(hub.fileForDownload(eve, secret.id)).rejects.toMatchObject({ code: 'not_found' });
      await expect(hub.fileForDownload(ann, secret.id)).rejects.toMatchObject({ code: 'not_found' });

      const ask = await hub.send(ann, { to: eve.id }, [{ text: 'q' }]);
      await hub.send(eve, { replyTo: ask.message.id }, [forged(secret.id)]);
      await expect(hub.fileForDownload(ann, secret.id)).rejects.toMatchObject({ code: 'not_found' });
    });

    it('forwarded to an endpoint agent (no signed link) or coming back from one', async () => {
      const secret = await hub.files.uploadInline(ben, { name: 's2.txt', contentBase64: b64('ben only') });
      const ep = (await newAgent(hub.registry, { url: 'http://forger.test', public: true })).agent;
      forwarder.replyParts = [forged(secret.id)];
      await hub.send(eve, { to: ep.id }, [forged(secret.id)]);
      await hub.wakeService.idle();
      forwarder.replyParts = [{ text: 'got it' }];
      expect(forwarder.sent.at(-1)!.parts[0]!.url).toBe('https://evil.test/x');
      await expect(hub.fileForDownload(eve, secret.id)).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  it('finds a recipient however many times the file was shared', async () => {
    const file = await hub.files.uploadInline(ann, { name: 'popular.txt', contentBase64: b64('x') });
    for (let i = 0; i < 55; i++) await hub.send(ann, { to: ben.id }, await hub.parts(ann, `copy ${i}`, undefined, [file.id]));
    await hub.send(ann, { to: eve.id }, await hub.parts(ann, 'last', undefined, [file.id]));
    expect((await hub.fileForDownload(eve, file.id)).id).toBe(file.id);
  });

  it('caps download links at the file\'s remaining lifetime', async () => {
    const soon = createHub({ db: testDb(), config: testConfig({ fileTtlMs: 60_000 }), fileStore: new MemoryFileStore() });
    const who = (await newAgent(soon.registry, { name: 'soon' })).agent;
    const file = await soon.files.uploadInline(who, { name: 's.txt', contentBase64: b64('x') });
    const ttl = Number(/ttl=(\d+)/.exec(await soon.files.downloadUrl((await soon.files.get(file.id))!))![1]);
    expect(ttl).toBeLessThanOrEqual(60_000);
    expect(ttl).toBeGreaterThan(50_000);
  });

  it('refuses expired files right away', async () => {
    const shortLived = createHub({ db: testDb(), config: testConfig({ fileTtlMs: 1 }), fileStore: new MemoryFileStore() });
    const [a, b] = await Promise.all(['old-a', 'old-b'].map(async (name) => (await newAgent(shortLived.registry, { name, public: true })).agent));
    const file = await shortLived.files.uploadInline(a!, { name: 'old.txt', contentBase64: b64('x') });
    await new Promise((r) => setTimeout(r, 5));
    await expect(shortLived.parts(a!, 'x', undefined, [file.id])).rejects.toMatchObject({ code: 'not_found' });
    await expect(shortLived.fileForDownload(a!, file.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(b).toBeTruthy();
  });

  it('says uploads are not configured when there is no bucket', async () => {
    const bare = createHub({ db: testDb(), config: testConfig() });
    const who = (await newAgent(bare.registry, { name: 'solo' })).agent;
    await expect(bare.files.uploadInline(who, { name: 'a', contentBase64: b64('a') })).rejects.toMatchObject({ code: 'unsupported' });
    // Plain messages still work without a bucket.
    expect(await bare.parts(who, 'hi', undefined, undefined)).toEqual([{ text: 'hi' }]);
  });
});
