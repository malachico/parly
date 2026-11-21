import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { HubError } from '../lib/errors.js';

/**
 * Pushing a conversation's new messages to one endpoint agent (Pusher.run). A job sends whatever is past the
 * agent's cursor, so running one twice, or late, sends nothing new (see Pusher for the retry case). `poll`
 * follows an answer the agent is still working on.
 */
export interface PushJob {
  agentId: string;
  conversationId: string;
  /** Follows the agent's still-running answer to `messageId`. */
  poll?: { taskId: string; messageId: string; until: number; every?: number };
}

/** Extracting a done thread's, or a quiet channel's, decisions, people and topics into the context graph (src/graph/extract.ts). */
export interface GraphJob {
  kind: 'graph';
  workspaceId: string;
  conversationId: string;
  /** Channels: the seq of the post that scheduled it; a newer post means a later job will run instead. */
  seq?: number;
  /** How many times the daily cap has pushed this job to a later day. */
  deferred?: number;
}

export type QueueJob = PushJob | GraphJob;

/** Where push jobs wait. The handler retries nothing itself: a job that throws is the queue's to retry. */
export interface PushQueue {
  enqueue(job: QueueJob, delayMs?: number): Promise<void>;
}

/**
 * One id per channel graph run (conversation, seq and UTC run day), so enqueueing the same run twice makes one task.
 * The day keeps a cap-skipped run's next-day requeue distinct from the run itself.
 */
function graphTaskId(job: QueueJob, runAt: number): string | undefined {
  if (!('kind' in job) || (job.seq === undefined && !job.deferred)) return undefined;
  const day = new Date(runAt).toISOString().slice(0, 10).replaceAll('-', '');
  return `graph-${job.conversationId.replace(/[^A-Za-z0-9_-]/g, '_')}-${job.seq ?? 'thread'}-${day}`;
}

type PushHandler = (job: PushJob) => Promise<void>;
type GraphHandler = (job: GraphJob) => Promise<void>;

/**
 * Runs jobs in this process (local development and tests). A failed job is logged, not retried: the next
 * message in the conversation pushes again. `idle()` waits for every job, delayed ones included, except delayed
 * graph jobs: those wait on an unref'd timer and are dropped at shutdown (the next channel post schedules another).
 */
export class InlineQueue implements PushQueue {
  private handler?: PushHandler;
  private graphHandler?: GraphHandler;
  private readonly running = new Set<Promise<void>>();
  /** Graph runs scheduled and not yet started, by graphTaskId: the same run enqueued twice runs once. */
  private readonly pendingGraph = new Set<string>();

  /** Graph jobs go to `graph`; without one they are dropped. */
  setHandler(handler: PushHandler, graph?: GraphHandler): void {
    this.handler = handler;
    this.graphHandler = graph;
  }

  async enqueue(job: QueueJob, delayMs = 0): Promise<void> {
    const handler = this.handler;
    if (!handler) throw new Error('InlineQueue has no handler');
    const id = graphTaskId(job, Date.now() + delayMs);
    if (id) {
      if (this.pendingGraph.has(id)) return;
      this.pendingGraph.add(id);
    }
    const background = 'kind' in job && delayMs > 0;
    const run: Promise<void> = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delayMs);
      if (background) timer.unref();
    })
      .then(() => {
        if (id) this.pendingGraph.delete(id);
        return 'kind' in job ? this.graphHandler?.(job) : handler(job);
      })
      .catch((err) => console.error(`${'kind' in job ? 'Graph extraction' : `Push to ${job.agentId}`} in ${job.conversationId} failed`, err))
      .finally(() => this.running.delete(run));
    if (!background) this.running.add(run);
  }

  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }
}

interface CloudTasksOptions {
  /** projects/<project>/locations/<location>/queues/<queue> */
  queue: string;
  /** The service account Cloud Tasks signs its calls with; /internal/push accepts only it. */
  serviceAccount: string;
  /** Where Cloud Tasks delivers jobs: <hub public URL>/internal/push. */
  url: string;
}

const QUEUE_NAME = /^projects\/[^/]+\/locations\/[^/]+\/queues\/[^/]+$/;

/** Creates one Cloud Tasks task: POST to the Cloud Tasks REST API with the hub's own Google credentials. */
type CreateTask = (url: string, body: unknown) => Promise<void>;

const googleCreateTask = (): CreateTask => {
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  return async (url, data) => {
    await (await auth.getClient()).request({ url, method: 'POST', data });
  };
};

/** Jobs as Cloud Tasks HTTP tasks to /internal/push, signed with an OIDC token. Retries and backoff are the queue's. */
export class CloudTasksQueue implements PushQueue {
  constructor(
    private readonly opts: CloudTasksOptions,
    private readonly createTask: CreateTask = googleCreateTask(),
  ) {
    if (!QUEUE_NAME.test(opts.queue)) throw new Error(`CLOUD_TASKS_QUEUE must be projects/<p>/locations/<l>/queues/<q>, got "${opts.queue}"`);
  }

  async enqueue(job: QueueJob, delayMs = 0): Promise<void> {
    const runAt = Date.now() + delayMs;
    const id = graphTaskId(job, runAt);
    await this.createTask(`https://cloudtasks.googleapis.com/v2/${this.opts.queue}/tasks`, {
      task: {
        ...(id ? { name: `${this.opts.queue}/tasks/${id}` } : {}),
        ...(delayMs > 0 ? { scheduleTime: new Date(runAt).toISOString() } : {}),
        httpRequest: {
          url: this.opts.url,
          httpMethod: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: Buffer.from(JSON.stringify(job)).toString('base64'),
          oidcToken: { serviceAccountEmail: this.opts.serviceAccount, audience: this.opts.url },
        },
      },
    }).catch((err: { status?: number; response?: { status?: number } }) => {
      // A named task that already exists is this same run, already scheduled.
      if (id && (err?.response?.status ?? err?.status) === 409) return;
      throw err;
    });
  }
}

/** Reads a push job from a call to /internal/push, or throws when the call isn't from the queue. */
export type PushVerifier = (authorization: string | undefined, body: unknown) => Promise<QueueJob>;

/** Checks that a call to /internal/push comes from Cloud Tasks as our service account, and reads its job. */
export function pushRequestVerifier(opts: Pick<CloudTasksOptions, 'serviceAccount' | 'url'>): PushVerifier {
  const client = new OAuth2Client();
  return async (authorization: string | undefined, body: unknown): Promise<QueueJob> => {
    const token = /^Bearer (.+)$/i.exec(authorization ?? '')?.[1];
    if (!token) throw new HubError('unauthorized', 'Missing token');
    const payload = (await client.verifyIdToken({ idToken: token, audience: opts.url }).catch(() => undefined))?.getPayload();
    if (!payload?.email_verified || payload.email !== opts.serviceAccount) throw new HubError('unauthorized', 'Not the push queue');
    return parsePushJob(body);
  };
}

export function parsePushJob(body: unknown): QueueJob {
  const g = body as Partial<GraphJob> | undefined;
  if (g?.kind === 'graph') {
    if (typeof g.workspaceId !== 'string' || typeof g.conversationId !== 'string') throw new HubError('invalid', 'Not a graph job');
    return { kind: 'graph', workspaceId: g.workspaceId, conversationId: g.conversationId, ...(typeof g.seq === 'number' ? { seq: g.seq } : {}), ...(typeof g.deferred === 'number' ? { deferred: g.deferred } : {}) };
  }
  const b = body as Partial<PushJob> | undefined;
  if (!b || typeof b.agentId !== 'string' || typeof b.conversationId !== 'string') throw new HubError('invalid', 'Not a push job');
  const p = b.poll;
  const poll = p && typeof p.taskId === 'string' && typeof p.messageId === 'string' && typeof p.until === 'number' ? { taskId: p.taskId, messageId: p.messageId, until: p.until, ...(typeof p.every === 'number' ? { every: p.every } : {}) } : undefined;
  return { agentId: b.agentId, conversationId: b.conversationId, ...(poll ? { poll } : {}) };
}
