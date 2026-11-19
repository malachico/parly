import { FieldValue, type Database } from '../db/types.js';
import type { ComputerDoc, ComputerState } from './computers.js';

/** `computers/{ownerId}`: one computer per person. */
export class ComputerStore {
  constructor(private readonly db: Database) {}

  private ref(ownerId: string) {
    return this.db.collection('computers').doc(ownerId);
  }

  async computer(ownerId: string): Promise<ComputerDoc | undefined> {
    return (await this.ref(ownerId).get()).data() as ComputerDoc | undefined;
  }

  /** Queues `agentId` on the owner's computer (starting it if stopped); returns the state it was in before. */
  async queueAgent(ownerId: string, agentId: string, now: string): Promise<ComputerState> {
    return this.db.runTransaction(async (tx) => {
      const ref = this.ref(ownerId);
      const doc = (await tx.get(ref)).data() as ComputerDoc | undefined;
      const state: ComputerState = !doc || doc.state === 'stopped' ? 'starting' : doc.state;
      tx.set(
        ref,
        {
          ownerId,
          state,
          stateAt: state === doc?.state ? doc.stateAt : now,
          pendingAgents: FieldValue.arrayUnion(agentId),
          lastActivityAt: now,
        },
        { merge: true },
      );
      return doc?.state ?? 'stopped';
    });
  }

  async touch(ownerId: string, at: string): Promise<void> {
    await this.ref(ownerId).update({ lastActivityAt: at });
  }

  /** Stopped, with why. */
  async fail(ownerId: string, at: string, problem: string): Promise<void> {
    await this.ref(ownerId).update({ state: 'stopped', stateAt: at, problem });
  }

  /** Enters `state`; `active` also counts it as activity. */
  async setState(ownerId: string, state: ComputerState, at: string, active = false): Promise<void> {
    await this.ref(ownerId).update({ state, stateAt: at, ...(active ? { lastActivityAt: at } : {}) });
  }

  async clearProblem(ownerId: string): Promise<void> {
    await this.ref(ownerId).update({ problem: FieldValue.delete() });
  }

  /** An agent that can't run: unqueued, with why. */
  async dropPending(ownerId: string, agentId: string, problem: string): Promise<void> {
    await this.ref(ownerId).update({ problem, pendingAgents: FieldValue.arrayRemove(agentId) });
  }

  async clearPending(ownerId: string, agentIds: string[]): Promise<void> {
    await this.ref(ownerId).update({ pendingAgents: FieldValue.arrayRemove(...agentIds) });
  }

  /** Computers that are ready or starting, by id. */
  async running(): Promise<{ id: string; computer: ComputerDoc }[]> {
    const snap = await this.db.collection('computers').where('state', 'in', ['ready', 'starting']).get();
    return snap.docs.map((d) => ({ id: d.id, computer: d.data() as ComputerDoc }));
  }
}
