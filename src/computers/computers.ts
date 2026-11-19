import type { Database } from '../db/types.js';
import { unseal } from '../lib/sealing.js';
import type { Registry } from '../registry/registry.js';
import type { AgentRecord } from '../registry/types.js';
import { ComputerStore } from './store.js';

/**
 * Parly computers: each person who hires agents gets one (on GKE, a gVisor pod per agent), where their hosted
 * agents run. The hub starts it when one of their agents has mail, starts the agents waiting for it once it's up,
 * and stops it after a quiet spell. A driver does the starting and stopping, and reports back (onState).
 */

export type ComputerState = 'stopped' | 'starting' | 'ready' | 'stopping';

/** `computers/{ownerId}`: one per person. */
export interface ComputerDoc {
  ownerId: string;
  state: ComputerState;
  /** When `state` was entered (ISO). */
  stateAt: string;
  /** Agents to start once it's ready. */
  pendingAgents: string[];
  /** The last sign of work: mail for one of its agents, a model or MCP call, or it coming up (ISO). */
  lastActivityAt: string;
  /** Why it last failed to start, for its owner. */
  problem?: string;
}

/** What an agent's session starts with on its computer. */
export interface RunSpec {
  agentId: string;
  agentName: string;
  agentToken: string;
  hubUrl: string;
  llmBaseUrl: string;
  llmKey: string;
}

/** Starts and stops computers, and agents on them: the GKE driver, or a fake in tests. */
export interface ComputerDriver {
  start(computerId: string): Promise<void>;
  stop(computerId: string): Promise<void>;
  runAgent(computerId: string, spec: RunSpec): Promise<void>;
}

/** A hub with no computers to drive yet: waking a hosted agent says so, and its mail waits in the inbox. */
export const noDriver: ComputerDriver = {
  start: () => Promise.reject(new Error("Parly computers aren't running on this hub yet: the message waits in the agent's inbox")),
  stop: () => Promise.resolve(),
  runAgent: () => Promise.resolve(),
};

interface ComputersOptions {
  hubUrl: string;
  sealingKey?: Buffer;
  /** A ready computer with no activity for this long is stopped. */
  idleMs: number;
  /** A computer still starting after this long failed to start. */
  bootTimeoutMs: number;
}

/** A busy agent calls its model many times a minute: one write a minute per computer is plenty. */
const TOUCH_EVERY_MS = 60_000;

export class Computers {
  private readonly touched = new Map<string, number>();
  private readonly store: ComputerStore;

  constructor(
    db: Database,
    private readonly registry: Registry,
    private readonly driver: ComputerDriver,
    private readonly opts: ComputersOptions,
  ) {
    this.store = new ComputerStore(db);
  }

  async get(ownerId: string): Promise<ComputerDoc | undefined> {
    return this.store.computer(ownerId);
  }

  /**
   * A hosted agent has mail: it runs at once on a ready computer, or waits for its computer to start (which this
   * starts when it's stopped). The Waker for `wake.type: 'computer'`.
   */
  async wake(agent: AgentRecord): Promise<void> {
    const ownerId = agent.ownerId!;
    const now = new Date().toISOString();
    const before = await this.store.queueAgent(ownerId, agent.id, now);
    if (before === 'stopped') {
      await this.registry.logActivity(agent.id, { text: 'Woke up: started its computer', at: now, conversationId: '' }).catch(() => {});
      await this.start(ownerId);
    }
    else if (before === 'ready') await this.runPending(ownerId);
    // starting: it runs once the computer says it's ready; stopping: onState starts it again when it has stopped.
  }

  /** An agent is working (a model or MCP call): its computer isn't idle, however long ago its last mail came. */
  async touch(ownerId: string, now = new Date()): Promise<void> {
    if (now.getTime() - (this.touched.get(ownerId) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(ownerId, now.getTime());
    // Fails for someone with no computer: their keys are used by other kinds of agent.
    await this.store.touch(ownerId, now.toISOString()).catch(() => {});
  }

  private async start(ownerId: string): Promise<void> {
    try {
      await this.driver.start(ownerId);
    } catch (err) {
      await this.store.fail(ownerId, new Date().toISOString(), (err as Error).message);
      throw err;
    }
  }

  /** The computer says where it is now (driver → hub). Once ready, it runs whatever waits for it. */
  async onState(ownerId: string, state: ComputerState | 'error', error?: string): Promise<void> {
    const doc = await this.get(ownerId);
    if (!doc) return;
    const now = new Date().toISOString();
    if (state === 'error') {
      await this.store.fail(ownerId, now, error ?? 'The computer failed');
      return;
    }
    await this.store.setState(ownerId, state, now, state === 'ready');
    this.touched.delete(ownerId);
    if (state === 'ready') await this.runPending(ownerId);
    // Mail came while it was stopping: start it again.
    else if (state === 'stopped' && doc.pendingAgents.length) {
      await this.store.setState(ownerId, 'starting', now);
      await this.start(ownerId);
    }
  }

  /** Starts each agent waiting for this ready computer (the driver makes it a nudge when one is already running). */
  private async runPending(ownerId: string): Promise<void> {
    const doc = await this.get(ownerId);
    if (!doc?.pendingAgents.length) return;
    await this.store.clearProblem(ownerId);
    for (const agentId of doc.pendingAgents) {
      const agent = await this.registry.get(agentId);
      if (!agent?.hosted || agent.archived || agent.ownerId !== ownerId) continue;
      let credentials: { token: string; llmKey: string };
      try {
        if (agent.hosted.sealed && !this.opts.sealingKey) throw new Error('Missing sealing key');
        credentials = JSON.parse(agent.hosted.sealed ? unseal(agent.hosted.sealed, this.opts.sealingKey!) : agent.hosted.secrets!);
      } catch {
        await this.store.dropPending(ownerId, agentId, `Could not open credentials for ${agent.name}. Check CREDENTIALS_KEY and reconnect the agent.`);
        continue;
      }
      await this.driver.runAgent(ownerId, {
        agentId,
        agentName: agent.name,
        agentToken: credentials.token,
        hubUrl: this.opts.hubUrl,
        llmBaseUrl: `${this.opts.hubUrl}/llm/vertex`,
        llmKey: credentials.llmKey,
      });
    }
    await this.store.clearPending(ownerId, doc.pendingAgents);
  }

  /** The /tick sweep: stops computers that went quiet, and gives up on ones that never came up. Returns how many it stopped. */
  // ponytail: reads every running computer each minute; a query on (state, lastActivityAt) when there are many
  async sweep(now = new Date()): Promise<number> {
    let stopped = 0;
    for (const { id, computer: c } of await this.store.running()) {
      if (c.state === 'starting' && now.getTime() - Date.parse(c.stateAt) > this.opts.bootTimeoutMs) {
        await this.store.fail(id, now.toISOString(), "The computer didn't start in time");
      } else if (c.state === 'ready' && now.getTime() - Date.parse(c.lastActivityAt) > this.opts.idleMs) {
        await this.store.setState(id, 'stopping', now.toISOString());
        await this.driver.stop(c.ownerId).catch((err) => console.error(`stopping computer ${c.ownerId}`, err));
        stopped++;
      }
    }
    return stopped;
  }
}
