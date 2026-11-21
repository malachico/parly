import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { CloudTasksQueue, parsePushJob, type PushQueue, type QueueJob } from '../src/chat/queue.js';
import type { ForwardResult } from '../src/hub/forward.js';
import { HubError } from '../src/lib/errors.js';
import type { WireMessage } from '../src/lib/wire.js';
import { crew, testConfig, testDb, freePort } from './helpers.js';

describe('Cloud Tasks', () => {
  it('enqueues an HTTP task to /internal/push, signed with an OIDC token, delayed when asked', async () => {
    const created: { url: string; body: any }[] = [];
    const queue = new CloudTasksQueue(
      { queue: 'projects/p/locations/us-central1/queues/parly-push', serviceAccount: 'hub@p.iam.gserviceaccount.com', url: 'https://hub.test/internal/push' },
      async (url, body) => void created.push({ url, body }),
    );
    await queue.enqueue({ agentId: 'a', conversationId: 'channel:c' });
    await queue.enqueue({ agentId: 'a', conversationId: 'channel:c', poll: { taskId: 't', messageId: 'm', until: 1 } }, 5000);

    expect(created[0]!.url).toBe('https://cloudtasks.googleapis.com/v2/projects/p/locations/us-central1/queues/parly-push/tasks');
    const req = created[0]!.body.task.httpRequest;
    expect(req).toMatchObject({ url: 'https://hub.test/internal/push', httpMethod: 'POST', oidcToken: { serviceAccountEmail: 'hub@p.iam.gserviceaccount.com', audience: 'https://hub.test/internal/push' } });
    expect(JSON.parse(Buffer.from(req.body, 'base64').toString())).toEqual({ agentId: 'a', conversationId: 'channel:c' });
    expect(created[0]!.body.task.scheduleTime).toBeUndefined();
    expect(Date.parse(created[1]!.body.task.scheduleTime)).toBeGreaterThan(Date.now());
    expect(() => new CloudTasksQueue({ queue: 'parly-push', serviceAccount: 's', url: 'u' }, async () => {})).toThrow(/projects\//);
  });

  it('reads only well-formed jobs', () => {
    expect(parsePushJob({ agentId: 'a', conversationId: 'c', extra: 1 })).toEqual({ agentId: 'a', conversationId: 'c' });
    expect(() => parsePushJob({ agentId: 'a' })).toThrow();
  });

  describe('/internal/push', () => {
    let hubUrl: string;
    let server: Server;
    const jobs: QueueJob[] = [];
    const sent: WireMessage[] = [];
    // The queue only records jobs: the test plays Cloud Tasks and delivers them to /internal/push itself.
    const queue: PushQueue = { enqueue: async (job) => void jobs.push(job) };
    let hub: ReturnType<typeof createApp>['hub'];

    beforeAll(async () => {
      const port = await freePort();
      hubUrl = `http://127.0.0.1:${port}`;
      const forwarder = {
        send: async (_a: unknown, m: WireMessage): Promise<ForwardResult> => {
          sent.push(m);
          return { kind: 'message', message: { messageId: `re-${m.messageId}`, role: 'ROLE_AGENT', parts: [{ text: 'pushed and answered' }] } };
        },
        getTask: async (): Promise<never> => {
          throw new Error('unused');
        },
        cancel: async () => {},
      };
      // Stands in for Google's OIDC check: "Bearer from-cloud-tasks" is the queue.
      const verifyPush = async (authorization: string | undefined, body: unknown) => {
        if (authorization !== 'Bearer from-cloud-tasks') throw new HubError('unauthorized', 'Not the push queue');
        return parsePushJob(body);
      };
      const config = testConfig({ port, publicUrl: hubUrl, cloudTasks: { queue: 'projects/p/locations/l/queues/q', serviceAccount: 'hub@p.iam.gserviceaccount.com' } });
      const app = createApp({ db: testDb(), config, queue, verifyPush, forwarder, fetchCard: async () => ({ name: 'ep', description: '', skills: [] }) });
      hub = app.hub;
      server = await new Promise<Server>((resolve) => {
        const s = app.app.listen(port, '127.0.0.1', () => resolve(s));
      });
    });

    afterAll(async () => {
      await new Promise((r) => server?.close(r));
    });

    const deliver = (authorization: string, job: unknown) =>
      fetch(`${hubUrl}/internal/push`, { method: 'POST', headers: { 'content-type': 'application/json', authorization }, body: JSON.stringify(job) });

    it("a post queues a push; the queue's call runs it, and the agent's answer lands in the thread", async () => {
      const { owner, channel } = await crew(hub.registry, 'ct', []);
      const { agent: ep } = await hub.registry.createBot(owner, { name: 'ct-ep', url: 'http://remote.test' });
      await hub.registry.addToWorkspace(owner, channel.workspaceId, ep.id);
      await hub.registry.addToChannel(owner, channel.id, ep.id);
      const { message } = await hub.send((await hub.registry.get(owner.id))!, { channel: channel.id }, [{ text: 'over the queue' }]);
      expect(jobs).toEqual([{ agentId: ep.id, conversationId: `channel:${channel.id}` }]);
      expect(sent).toHaveLength(0);

      // Not from the queue: refused, never run (an agent's token included).
      expect((await deliver('Bearer a2ah_whatever', jobs[0])).status).toBe(401);
      expect(sent).toHaveLength(0);

      expect((await deliver('Bearer from-cloud-tasks', jobs[0])).status).toBe(204);
      expect(sent.map((m) => m.parts.at(-1)?.text)).toEqual(['over the queue']);
      const thread = await hub.chat.readThread(owner, channel.id, message.id);
      expect(thread.map((m) => m.parts[0]?.text)).toEqual(['over the queue', 'pushed and answered']);

      // Cloud Tasks retries are harmless: nothing past the agent's cursor, nothing sent.
      expect((await deliver('Bearer from-cloud-tasks', jobs[0])).status).toBe(204);
      expect(sent).toHaveLength(1);
      expect((await deliver('Bearer from-cloud-tasks', { nope: true })).status).toBe(400);
    });
  });
});
