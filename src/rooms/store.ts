import type { Database } from '../db/types.js';
import type { RoomDecision, RoomDoc, RoomState } from './rooms.js';

/** Rooms' own records: `room_briefs`, `room_docs` (with their `versions`), `room_state` and `room_sides`. */
export class RoomStore {
  constructor(private readonly db: Database) {}

  private briefRef(workspaceId: string, sideId: string) {
    return this.db.collection('room_briefs').doc(`${workspaceId}_${sideId}`);
  }

  private docRef(workspaceId: string) {
    return this.db.collection('room_docs').doc(workspaceId);
  }

  private stateRef(workspaceId: string) {
    return this.db.collection('room_state').doc(workspaceId);
  }

  private sideRef(workspaceId: string, personId: string) {
    return this.db.collection('room_sides').doc(`${workspaceId}_${personId}`);
  }

  /** Counts one agent turn, unless `agreed(doc)` or the talks are already stuck. `newlyStuck`: this turn made them stuck. */
  async takeTurn(
    workspaceId: string,
    sideId: string | undefined,
    agreed: (doc: RoomDoc | undefined) => boolean,
    maxTurns: number,
  ): Promise<{ result: 'go' | 'agreed' | 'stuck'; newlyStuck: boolean }> {
    let newlyStuck = false;
    const result = await this.db.runTransaction(async (tx) => {
      const [docSnap, stateSnap] = await Promise.all([tx.get(this.docRef(workspaceId)), tx.get(this.stateRef(workspaceId))]);
      const doc = docSnap.data() as RoomDoc | undefined;
      if (agreed(doc)) return 'agreed' as const;
      const state = stateSnap.data() as RoomState | undefined;
      if (state?.stuck) return 'stuck' as const;
      const version = doc?.version ?? 0;
      const turns = state && state.docVersion === version ? state.turns + 1 : 1;
      const stuck = turns > maxTurns;
      newlyStuck = stuck;
      tx.set(
        this.stateRef(workspaceId),
        { turns, docVersion: version, ...(stuck ? { stuck: true } : {}), ...(sideId ? { lastSide: sideId } : {}), ...(state?.waiting ? { waiting: state.waiting } : {}) } satisfies RoomState,
      );
      return stuck ? ('stuck' as const) : ('go' as const);
    });
    return { result, newlyStuck };
  }

  /** The room waits on `decision`, replacing any earlier one (and clearing stuck). */
  async setWaiting(workspaceId: string, decision: RoomDecision): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(this.stateRef(workspaceId))).data() as RoomState | undefined;
      tx.set(this.stateRef(workspaceId), { turns: state?.turns ?? 0, docVersion: state?.docVersion ?? 0, ...(state?.lastSide ? { lastSide: state.lastSide } : {}), waiting: { ...decision, at: new Date().toISOString() } } satisfies RoomState);
    });
  }

  /** The room waits on `decision` unless something already waits. Returns whether it was asked. */
  async askIfIdle(workspaceId: string, decision: RoomDecision): Promise<boolean> {
    const ref = this.stateRef(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const state = (await tx.get(ref)).data() as RoomState | undefined;
      if (state?.waiting) return false;
      tx.set(ref, { ...(state ?? { turns: 0, docVersion: 0 }), waiting: { ...decision, at: new Date().toISOString() } } satisfies RoomState);
      return true;
    });
  }

  /** Clears a waiting "go" for `who` (in `thread`, when given). An ask stays. */
  async settleGo(workspaceId: string, who: string, thread?: string): Promise<void> {
    const ref = this.stateRef(workspaceId);
    await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(ref)).data() as RoomState | undefined;
      if (!state?.waiting) return;
      const { waiting, ...rest } = state;
      const isGo = waiting.options.length === 1 && waiting.options[0] === 'go';
      if (isGo && (waiting.agent === who || waiting.side === who) && (thread === undefined || waiting.thread === thread)) {
        tx.set(ref, { turns: rest.turns ?? 0, docVersion: rest.docVersion ?? 0, ...(rest.stuck ? { stuck: true } : {}), ...(rest.lastSide ? { lastSide: rest.lastSide } : {}) } satisfies RoomState);
      }
    });
  }

  /** Rooms with a decision waiting since `cutoff` (ISO) or earlier. */
  async overdue(cutoff: string): Promise<{ workspaceId: string; waiting: RoomDecision }[]> {
    const due = await this.db.collection('room_state').where('waiting.at', '<=', cutoff).get();
    return due.docs.map((snap) => ({ workspaceId: snap.id, waiting: (snap.data() as RoomState).waiting! }));
  }

  /** Marks the decision asked at `askedAt` reminded at `now`, unless it changed or was reminded already. Returns whether this call won. */
  async claimReminder(workspaceId: string, askedAt: string | undefined, now: string): Promise<boolean> {
    const ref = this.stateRef(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const current = ((await tx.get(ref)).data() as RoomState | undefined)?.waiting;
      if (!current || current.at !== askedAt || current.remindedAt) return false;
      tx.update(ref, { 'waiting.remindedAt': now });
      return true;
    });
  }

  /** Takes the decision waiting on `sideId`, clearing the room's state; undefined when none waits on that side. */
  async takeDecision(workspaceId: string, sideId: string): Promise<RoomDecision | undefined> {
    const ref = this.stateRef(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const waiting = ((await tx.get(ref)).data() as RoomState | undefined)?.waiting;
      if (!waiting || waiting.side !== sideId) return undefined;
      tx.delete(ref);
      return waiting;
    });
  }

  /** Turns count from zero again; a waiting decision stays. */
  async resume(workspaceId: string): Promise<void> {
    const ref = this.stateRef(workspaceId);
    await this.db.runTransaction(async (tx) => {
      const state = (await tx.get(ref)).data() as RoomState | undefined;
      if (state?.waiting) tx.set(ref, { turns: 0, docVersion: state.docVersion, waiting: state.waiting } satisfies RoomState);
      else tx.delete(ref);
    });
  }

  async document(workspaceId: string): Promise<RoomDoc | undefined> {
    return (await this.docRef(workspaceId).get()).data() as RoomDoc | undefined;
  }

  async state(workspaceId: string): Promise<RoomState | undefined> {
    return (await this.stateRef(workspaceId).get()).data() as RoomState | undefined;
  }

  /** An earlier version of the document, kept when it was replaced. */
  async version(workspaceId: string, version: number): Promise<RoomDoc | undefined> {
    return (await this.docRef(workspaceId).collection('versions').doc(String(version)).get()).data() as RoomDoc | undefined;
  }

  /**
   * Writes a new version on top of `base`, keeping the one it replaces. Not written: `conflict` (the current version
   * isn't `base`), or `approved` (an agent, not a person, would replace a version a side approved).
   */
  async writeDocument(
    workspaceId: string,
    base: number,
    byPerson: boolean,
    write: Omit<RoomDoc, 'version' | 'updatedAt' | 'approvals'>,
  ): Promise<{ doc: RoomDoc } | { conflict: number } | { approved: RoomDoc }> {
    const ref = this.docRef(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as RoomDoc | undefined;
      const version = current?.version ?? 0;
      if (base !== version) return { conflict: version };
      if (!byPerson && current && Object.values(current.approvals).some((a) => a.version === version)) return { approved: current };
      const doc: RoomDoc = { version: version + 1, text: write.text, updatedBy: write.updatedBy, updatedByName: write.updatedByName, updatedAt: new Date().toISOString(), approvals: {} };
      if (current) tx.set(ref.collection('versions').doc(String(current.version)), current);
      tx.set(ref, doc);
      return { doc };
    });
  }

  /** Records `sideId`'s approval of `version`. Not recorded: `missing` (no document yet) or `conflict` (it's at another version now). */
  async approve(
    workspaceId: string,
    sideId: string,
    by: { by: string; byName: string },
    version: number,
  ): Promise<{ doc: RoomDoc } | { missing: true } | { conflict: number }> {
    const ref = this.docRef(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const current = (await tx.get(ref)).data() as RoomDoc | undefined;
      if (!current) return { missing: true as const };
      if (current.version !== version) return { conflict: current.version };
      const next = { ...current, approvals: { ...current.approvals, [sideId]: { ...by, at: new Date().toISOString(), version } } };
      tx.set(ref, next);
      return { doc: next };
    });
  }

  /** A side's brief, as stored (anything but a string means none). */
  async brief(workspaceId: string, sideId: string): Promise<unknown> {
    return (await this.briefRef(workspaceId, sideId).get()).get('text') as unknown;
  }

  async setBrief(workspaceId: string, sideId: string, text: string): Promise<void> {
    await this.briefRef(workspaceId, sideId).set({ text });
  }

  async deleteBrief(workspaceId: string, sideId: string): Promise<void> {
    await this.briefRef(workspaceId, sideId).delete();
  }

  /** Claims `personId`'s one side in the room: false when they already have it. */
  async claimSide(workspaceId: string, personId: string): Promise<boolean> {
    try {
      await this.sideRef(workspaceId, personId).create({ at: new Date().toISOString() });
      return true;
    } catch (err) {
      if ((err as { code?: number }).code === 6) return false;
      throw err;
    }
  }

  async releaseSide(workspaceId: string, personId: string): Promise<void> {
    await this.sideRef(workspaceId, personId).delete();
  }
}
