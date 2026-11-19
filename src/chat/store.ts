import { randomUUID } from 'node:crypto';
import { COLLECTIONS, FieldPath, FieldValue, Filter, Timestamp, type DocumentReference, type Database } from '../db/types.js';
import { HubError } from '../lib/errors.js';
import { nowIso, textOf, type WirePart } from '../lib/wire.js';
import type { ActivityDoc } from './activity.js';
import { channelKey, cursorId, keptSkillLoads, takeSkillLoads, type CommitTime, type ConversationDoc, type ConversationKind, type CursorDoc, type MessageDoc, type SkillLoad } from './chat.js';

/** What a new message is, before the conversation numbers it. */
interface NewMessage {
  replyTo?: MessageDoc['replyTo'];
  /** Set when the message must be stored once only (an endpoint agent's answer): a second append returns the first. */
  id: string;
  from: string;
  fromId: string;
  /** People reset the conversation's run of agents' messages; agents add to it. */
  human: boolean;
  external?: boolean;
  parts: WirePart[];
  mentions?: string[];
  to?: string[];
  forAgents?: string[];
  meta?: MessageDoc['meta'];
  slack?: MessageDoc['slack'];
  telegram?: MessageDoc['telegram'];
}

/** What a conversation is, for the message that starts it. */
export interface NewConversation {
  id: string;
  kind: ConversationKind;
  channelId?: string;
  workspaceId?: string;
  post?: string;
  participants: string[];
  /** DMs: both sides' names, kept so the conversation still shows who it was with once one side is gone. */
  names?: Record<string, string>;
}

const RECENT = 3;
/** How much of the newest message a conversation keeps for previews. */
const PREVIEW = 200;

/** The chat's three collections: conversations, messages, cursors (see chat.ts). */
export class ChatStore {
  constructor(private readonly db: Database) {}

  private conv(id: string): DocumentReference {
    return this.db.collection(COLLECTIONS.conversations).doc(id);
  }

  private msg(id: string): DocumentReference {
    if (!id || id.includes('/')) throw new HubError('not_found', `Message ${id} not found`);
    return this.db.collection(COLLECTIONS.messages).doc(id);
  }

  private cur(agentId: string, conversationId: string): DocumentReference {
    return this.db.collection(COLLECTIONS.cursors).doc(cursorId(agentId, conversationId));
  }

  private loads(agentId: string): DocumentReference {
    return this.db.collection(COLLECTIONS.skillLoads).doc(agentId);
  }

  /** Notes a get_skill until a message shows it. */
  async addSkillLoad(agentId: string, load: SkillLoad): Promise<void> {
    const ref = this.loads(agentId);
    await this.db.runTransaction(async (tx) => {
      const pending = ((await tx.get(ref)).data()?.loads ?? []) as SkillLoad[];
      const same = (l: SkillLoad) => l.id === load.id && l.conversation === load.conversation && l.messageId === load.messageId;
      // ponytail: the list lives in one doc, kept small by expiry; thousands of distinct loads in 30 minutes would hit the 1 MB limit.
      tx.set(ref, { loads: [...keptSkillLoads(pending, Date.now()).filter((l) => !same(l)), load] });
    });
  }

  async hasSkillLoads(agentId: string): Promise<boolean> {
    return (await this.loads(agentId).get()).exists;
  }

  /**
   * Stores a message as its conversation's next, in one transaction with the conversation (created with it
   * if new): its seq, the run of agents' messages, new participants, and the sender's own cursor. `showable`, for an
   * agent with pending loads, is what this conversation may show: the matching ones are taken in the same transaction.
   */
  async append(conversation: NewConversation, m: NewMessage, addParticipants: string[] = [], showable?: Set<string>): Promise<{ conversation: ConversationDoc; message: MessageDoc; created: boolean }> {
    const convRef = this.conv(conversation.id);
    const msgRef = this.msg(m.id);
    const curRef = this.cur(m.fromId, conversation.id);
    // An agent answering one message hasn't read the ones that came while it worked: its cursor stays before them, so
    // they're still pushed or handed out. Not a person (the whole conversation is on screen), nor a first post
    // somewhere it has no cursor yet (what came before isn't news to it).
    // A pushed agent answers what it was sent (`sending`): that isn't news it missed.
    // ponytail: read outside the transaction (a query in it would lock a busy channel); a message landing in between is missed, as before
    const c = m.human ? undefined : ((await curRef.get()).data() as CursorDoc | undefined);
    const was = c?.seenUpTo === undefined ? undefined : Math.max(c.seenUpTo, c.sending ?? 0);
    const heldBack =
      was !== undefined &&
      (await this.db.collection(COLLECTIONS.messages).where('conversationId', '==', conversation.id).where('seq', '>', was).orderBy('seq', 'desc').limit(20).get()).docs.some(
        (d) => (d.data() as MessageDoc).fromId !== m.fromId,
      );
    return this.db.runTransaction(async (tx) => {
      const loadsRef = this.loads(m.fromId);
      const [convSnap, msgSnap, loadsSnap] = await tx.getAll(convRef, msgRef, ...(showable ? [loadsRef] : []));
      if (msgSnap!.exists) {
        // Stored already (a retried push): the same message, not a second one.
        return { conversation: convSnap!.data() as ConversationDoc, message: msgSnap!.data() as MessageDoc, created: false };
      }
      let meta = m.meta;
      try {
        if (loadsSnap?.exists) {
          const pending = loadsSnap.data()!.loads as SkillLoad[];
          const { shown, left } = takeSkillLoads(pending, conversation.id, showable!, Date.now());
          if (shown.length) meta = { ...m.meta, skills: shown };
          if (!left.length) tx.delete(loadsRef);
          else if (left.length !== pending.length) tx.set(loadsRef, { loads: left });
        }
      } catch (err) {
        console.error(`Skill loads of ${m.fromId} not taken:`, err); // the message goes out regardless
      }
      const at = nowIso();
      const prev = convSnap!.exists ? (convSnap!.data() as ConversationDoc) : undefined;
      const seq = (prev?.seq ?? 0) + 1;
      // A webhook's post is an outside service, not its maker writing: it doesn't end the agents' run.
      const agentRun = (m.human || m.external) && !m.meta?.webhook ? 0 : (prev?.agentRun ?? 0) + 1;
      const participants = conversation.kind === 'channel' ? [] : [...new Set([...(prev?.participants ?? conversation.participants), ...addParticipants, m.fromId])];
      // Write payload uses server timestamps; the returned docs get a client Timestamp.now() stand-in.
      const next: Omit<ConversationDoc, 'changedAt'> = {
        id: conversation.id,
        kind: conversation.kind,
        ...(conversation.channelId ? { channelId: conversation.channelId } : {}),
        ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
        ...(conversation.post ? { post: conversation.post } : {}),
        participants,
        ...(conversation.names || prev?.names ? { names: { ...prev?.names, ...conversation.names } } : {}),
        seq,
        lastAt: at,
        lastFrom: m.fromId,
        lastFromName: m.from,
        lastText: textOf({ parts: m.parts }).slice(0, PREVIEW),
        recent: [m.fromId, ...(prev?.recent ?? []).filter((id) => id !== m.fromId)].slice(0, RECENT),
        agentRun,
        createdAt: prev?.createdAt ?? at,
        ...(!m.human && !m.external && prev?.doneAt ? { doneAt: prev.doneAt, ...(prev.doneBy ? { doneBy: prev.doneBy } : {}) } : {}),
        // The write merges, so other writers' fields survive; the digest is carried so the returned doc has it.
        ...(prev?.doneBackfilled ? { doneBackfilled: true } : {}),
        ...(prev?.doneBackfillSeq !== undefined ? { doneBackfillSeq: prev.doneBackfillSeq } : {}),
        ...(prev?.threadDigest ? { threadDigest: prev.threadDigest } : {}),
        ...(prev?.digestUpToSeq ? { digestUpToSeq: prev.digestUpToSeq } : {}),
        ...(prev?.digestFoldUntilMs ? { digestFoldUntilMs: prev.digestFoldUntilMs } : {}),
      };
      const files = [...new Set(m.parts.map((p) => p.metadata?.fileId).filter((id): id is string => typeof id === 'string'))];
      const message: Omit<MessageDoc, 'createdAt'> = {
        id: m.id,
        conversationId: conversation.id,
        kind: conversation.kind,
        ...(conversation.channelId ? { channelId: conversation.channelId } : {}),
        ...(conversation.workspaceId ? { workspaceId: conversation.workspaceId } : {}),
        ...(conversation.post ? { post: conversation.post } : {}),
        seq,
        from: m.from,
        fromId: m.fromId,
        at,
        parts: m.parts,
        ...(m.replyTo ? { replyTo: m.replyTo } : {}),
        ...(m.mentions?.length ? { mentions: m.mentions } : {}),
        ...(m.to ? { to: m.to } : {}),
        ...(m.forAgents ? { forAgents: m.forAgents } : {}),
        ...(files.length ? { files } : {}),
        agentRun,
        ...(conversation.kind === 'channel' ? { done: false } : {}),
        ...(m.external ? { external: true } : {}),
        ...(meta && Object.keys(meta).length ? { meta } : {}),
        ...(m.slack?.length ? { slack: m.slack } : {}),
        ...(m.telegram?.length ? { telegram: m.telegram } : {}),
      };
      tx.create(msgRef, { ...message, createdAt: FieldValue.serverTimestamp() });
      // Merge, so fields other writers own aren't wiped; a person's message reopens a done thread.
      const reopen = prev?.doneAt && !next.doneAt ? { doneAt: FieldValue.delete(), doneBy: FieldValue.delete() } : {};
      tx.set(convRef, { ...next, changedAt: FieldValue.serverTimestamp(), ...reopen }, { merge: true });
      // Writing is having read everything before it; a webhook or schedule posting as them while they're away isn't.
      if (!m.meta?.webhook && !m.meta?.scheduled && !heldBack) tx.set(curRef, { agentId: m.fromId, conversationId: conversation.id, seenUpTo: seq, updatedAt: at }, { merge: true });
      // The commit time isn't known until the commit; callers that need it read the message back.
      const now = Timestamp.now();
      return { conversation: { ...next, changedAt: now }, message: { ...message, createdAt: now }, created: true };
    });
  }

  async conversation(id: string): Promise<ConversationDoc | undefined> {
    const snap = await this.conv(id).get();
    return snap.exists ? (snap.data() as ConversationDoc) : undefined;
  }

  /** The ones that exist, by id. */
  async conversations(ids: string[]): Promise<Map<string, ConversationDoc>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const snaps = await this.db.getAll(...unique.map((id) => this.conv(id)));
    return new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data() as ConversationDoc]));
  }

  /** DMs and threads `agentId` takes part in, most recent first. Channels aren't listed here: membership is the registry's. */
  async mine(agentId: string, limit = 200): Promise<ConversationDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.conversations).where('participants', 'array-contains', agentId).orderBy('lastAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as ConversationDoc);
  }

  /** Of `agentId`'s DMs and threads and the given channels' conversations, those with a message committed at or after `at`. */
  async changedSince(agentId: string, channelIds: string[], at: CommitTime, limit = 200): Promise<ConversationDoc[]> {
    const ts = new Timestamp(at.seconds, at.nanoseconds); // ponytail: rehydrate the boundary POJO to a real Timestamp, or the DB adapter encodes it as a map and the range query matches nothing
    const [mine, channels] = await Promise.all([
      this.db.collection(COLLECTIONS.conversations).where('participants', 'array-contains', agentId).where('changedAt', '>=', ts).orderBy('changedAt').limit(limit).get(),
      this.conversations(channelIds.map(channelKey)),
    ]);
    const changed = [...channels.values()].filter((c) => (c.changedAt.seconds - at.seconds || c.changedAt.nanoseconds - at.nanoseconds) >= 0);
    return [...mine.docs.map((d) => d.data() as ConversationDoc), ...changed];
  }

  /** Threads in the given channels with a message committed at or after `at` (for people watching a channel live, in a thread or not). */
  async channelThreadsChangedSince(channelIds: string[], at: CommitTime, limit = 200): Promise<ConversationDoc[]> {
    const ts = new Timestamp(at.seconds, at.nanoseconds); // ponytail: rehydrate the boundary POJO to a real Timestamp, or the DB adapter encodes it as a map and the range query matches nothing
    if (!channelIds.length) return [];
    // A missing index (while it builds) only drops other people's threads from the stream, not the stream.
    const docs = await this.db.collection(COLLECTIONS.conversations).where('channelId', 'in', channelIds).where('changedAt', '>=', ts).orderBy('changedAt').limit(limit).get().then((s) => s.docs, () => []);
    return docs.map((d) => d.data() as ConversationDoc).filter((c) => c.kind === 'thread');
  }

  async message(id: string): Promise<MessageDoc | undefined> {
    const snap = await this.msg(id).get();
    return snap.exists ? (snap.data() as MessageDoc) : undefined;
  }

  /** The newest messages that mention `agentId`, newest first. */
  async mentioning(agentId: string, limit: number): Promise<MessageDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.messages).where('mentions', 'array-contains', agentId).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as MessageDoc);
  }

  /** A channel's messages, posts and thread replies together, oldest first: the newest `limit` of them. */
  async inChannel(channelId: string, limit: number): Promise<MessageDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.messages).where('channelId', '==', channelId).orderBy('createdAt', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as MessageDoc).reverse();
  }

  /** Messages after `seq`, oldest first: the newest `limit` of them. */
  async since(conversationId: string, seq: number, limit: number): Promise<MessageDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.messages).where('conversationId', '==', conversationId).where('seq', '>', seq).orderBy('seq', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as MessageDoc).reverse();
  }

  /** Like since(), batched across conversations using their latest sequence to bound each window. */
  async sinceMany(windows: { id: string; seen: number; seq: number }[], limit: number): Promise<Map<string, MessageDoc[]>> {
    const pending = windows.filter((w) => w.seq > w.seen);
    const out = new Map<string, MessageDoc[]>();
    // At most 30 OR branches per query; each uses the existing conversationId/seq index.
    await Promise.all(Array.from({ length: Math.ceil(pending.length / 30) }, async (_, i) => {
      const batch = pending.slice(i * 30, i * 30 + 30);
      const filters = batch.map((w) => Filter.and(Filter.where('conversationId', '==', w.id), Filter.where('seq', '>', Math.max(w.seen, w.seq - limit))));
      const snap = await this.db.collection(COLLECTIONS.messages).where(Filter.or(...filters)).orderBy('seq', 'desc').get();
      for (const doc of snap.docs) {
        const m = doc.data() as MessageDoc;
        const messages = out.get(m.conversationId) ?? [];
        if (messages.length < limit) messages.push(m);
        out.set(m.conversationId, messages);
      }
      await Promise.all(batch.map(async (w) => {
        const messages = out.get(w.id) ?? [];
        // Deleted messages can leave holes; refill from older surviving messages exactly as since() does.
        if (w.seq - limit > w.seen && messages.length < limit) out.set(w.id, await this.since(w.id, w.seen, limit));
        else out.set(w.id, messages.reverse());
      }));
    }));
    return out;
  }

  /**
   * since(read.id, read.after, limit) for each read, batched: one conversations() read plus sinceMany. Reads of the
   * same conversation share one window from the lowest `after`, then each keeps what's after its own: the newest
   * `limit` after the lowest, cut to after a higher one, are exactly the newest `limit` after that higher one.
   * A conversation without a doc has no messages (append writes both in one transaction).
   */
  async sinceEach(reads: { id: string; after: number }[], limit: number): Promise<MessageDoc[][]> {
    const lowest = new Map<string, number>();
    for (const r of reads) lowest.set(r.id, Math.min(r.after, lowest.get(r.id) ?? r.after));
    const convs = await this.conversations([...lowest.keys()]);
    const windows = [...lowest].flatMap(([id, seen]) => {
      const c = convs.get(id);
      return c ? [{ id, seen, seq: c.seq }] : [];
    });
    const got = await this.sinceMany(windows, limit);
    return reads.map((r) => (got.get(r.id) ?? []).filter((m) => m.seq > r.after));
  }

  /** The `limit` messages before `before` (default: the newest), oldest first. */
  async page(conversationId: string, limit: number, before?: number, done?: boolean): Promise<MessageDoc[]> {
    let q = this.db.collection(COLLECTIONS.messages).where('conversationId', '==', conversationId);
    if (done !== undefined) q = q.where('done', '==', done);
    if (before !== undefined) q = q.where('seq', '<', before);
    const snap = await q.orderBy('seq', 'desc').limit(limit).get();
    return snap.docs.map((d) => d.data() as MessageDoc).reverse();
  }

  /**
   * Backfills `done: boolean` on pre-existing channel posts (created before `done` lived on `MessageDoc`) once per
   * channel. Walks newest-first in pages, persisting the lowest seq covered (`doneBackfillSeq`) in the same batch as
   * each page's writes, so a run that times out mid-channel resumes at `seq < doneBackfillSeq` instead of restarting.
   * `from` is the caller's known cursor (avoids a re-read); concurrent viewers racing here is harmless — same writes.
   * ponytail: still runs synchronously in the viewer's first page request, so a legacy channel costs N/400 round trips
   * spread across that viewer's retries; move to a one-shot migration or a per-request page budget once a channel is big enough to feel it.
   */
  async ensureDoneBackfilled(conversationId: string, doneThreads: string[] = [], from?: number): Promise<void> {
    const doneSet = new Set(doneThreads);
    const convRef = this.conv(conversationId);
    const PAGE = 400; // leaves room under a 500-op batch for the cursor write.
    let before = from;
    for (;;) {
      let q = this.db.collection(COLLECTIONS.messages).where('conversationId', '==', conversationId);
      if (before !== undefined) q = q.where('seq', '<', before);
      const snap = await q.orderBy('seq', 'desc').limit(PAGE).select('done', 'seq').get();
      if (snap.empty) break;
      const batch = this.db.batch();
      for (const doc of snap.docs) {
        if (typeof doc.get('done') !== 'boolean') batch.update(doc.ref, { done: doneSet.has(doc.id) });
      }
      before = snap.docs[snap.docs.length - 1]!.get('seq') as number;
      batch.set(convRef, { doneBackfillSeq: before }, { merge: true });
      await batch.commit();
      if (snap.size < PAGE) break;
    }
    await convRef.set({ doneBackfilled: true, doneBackfillSeq: FieldValue.delete() }, { merge: true });
  }

  /** Messages committed at or after `at`, in commit order, at most `limit`. */
  async after(conversationId: string, at: CommitTime, limit: number): Promise<MessageDoc[]> {
    const ts = new Timestamp(at.seconds, at.nanoseconds); // ponytail: rehydrate the boundary POJO to a real Timestamp, or the DB adapter encodes it as a map and the range query matches nothing
    const snap = await this.db
      .collection(COLLECTIONS.messages)
      .where('conversationId', '==', conversationId)
      .where('createdAt', '>=', ts)
      .orderBy('createdAt')
      .orderBy(FieldPath.documentId())
      .limit(limit)
      .get();
    return snap.docs.map((d) => d.data() as MessageDoc);
  }

  async cursor(agentId: string, conversationId: string): Promise<CursorDoc | undefined> {
    const snap = await this.cur(agentId, conversationId).get();
    return snap.exists ? (snap.data() as CursorDoc) : undefined;
  }

  /** `agentId`'s cursors in these conversations, by conversation id (missing ones left out). */
  async cursorsOf(agentId: string, conversationIds: string[]): Promise<Map<string, CursorDoc>> {
    const unique = [...new Set(conversationIds)];
    if (unique.length === 0) return new Map();
    const snaps = await this.db.getAll(...unique.map((c) => this.cur(agentId, c)));
    return new Map(snaps.filter((s) => s.exists).map((s) => [(s.data() as CursorDoc).conversationId, s.data() as CursorDoc]));
  }

  /** Conversations `agentId` read (or wrote in) after `afterIso`, oldest first: the live stream clears them in other tabs. */
  async readSince(agentId: string, afterIso: string, limit = 50): Promise<CursorDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.cursors).where('agentId', '==', agentId).where('updatedAt', '>', afterIso).orderBy('updatedAt').limit(limit).get();
    return snap.docs.map((d) => d.data() as CursorDoc);
  }

  /** Where each of these agents has seen up to in one conversation, by agent id (missing ones left out). */
  async seenIn(conversationId: string, agentIds: string[]): Promise<Record<string, number>> {
    const unique = [...new Set(agentIds)];
    if (unique.length === 0) return {};
    const snaps = await this.db.getAll(...unique.map((a) => this.cur(a, conversationId)));
    return Object.fromEntries(snaps.filter((s) => s.exists).map((s) => [(s.data() as CursorDoc).agentId, (s.data() as CursorDoc).seenUpTo]));
  }

  /** `agentId` is being asked about `seq`: a retry can tell an answer to it from what came before. `see` clears it. */
  async sending(agentId: string, conversationId: string, seq: number): Promise<void> {
    await this.cur(agentId, conversationId).set({ agentId, conversationId, sending: seq, updatedAt: nowIso() }, { merge: true });
  }

  /** `agentId` has seen up to `seq`. Never moves back. */
  async see(agentId: string, conversationId: string, seq: number, downstream?: CursorDoc['downstream']): Promise<void> {
    const ref = this.cur(agentId, conversationId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as CursorDoc) : undefined;
      if (prev && prev.seenUpTo >= seq && !downstream) return;
      tx.set(ref, {
        agentId,
        conversationId,
        seenUpTo: Math.max(seq, prev?.seenUpTo ?? 0),
        updatedAt: nowIso(),
        ...(downstream ?? prev?.downstream ? { downstream: downstream ?? prev?.downstream } : {}),
        ...((prev?.handedUpTo ?? 0) > seq ? { handedUpTo: prev!.handedUpTo, handedUntilMs: prev!.handedUntilMs } : {}),
      });
    });
  }

  /** Hands `seq` to `agentId` for `ms` (it stays hidden until then, unless `see` acks it). False if it's seen or another reader holds it. */
  async hand(agentId: string, conversationId: string, seq: number, ms: number): Promise<boolean> {
    const ref = this.cur(agentId, conversationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const prev = snap.exists ? (snap.data() as CursorDoc) : undefined;
      if ((prev?.seenUpTo ?? 0) >= seq || ((prev?.handedUntilMs ?? 0) > Date.now() && (prev?.handedUpTo ?? 0) >= seq)) return false;
      tx.set(ref, { agentId, conversationId, handedUpTo: seq, handedUntilMs: Date.now() + ms, updatedAt: nowIso() }, { merge: true });
      return true;
    });
  }

  /** `agentId`'s hand-outs still held (not acked, not expired). */
  async handedOut(agentId: string): Promise<CursorDoc[]> {
    const snap = await this.db.collection(COLLECTIONS.cursors).where('agentId', '==', agentId).where('handedUntilMs', '>', Date.now()).get();
    return snap.docs.map((d) => d.data() as CursorDoc);
  }

  /** Takes the push lease for `agentId` in a conversation for `ms`; an owner token to release with, or undefined while another push holds it. */
  async lease(agentId: string, conversationId: string, ms: number): Promise<string | undefined> {
    const ref = this.db.collection(COLLECTIONS.pushLeases).doc(cursorId(agentId, conversationId));
    const token = randomUUID();
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { untilMs: number }).untilMs > Date.now()) return undefined;
      tx.set(ref, { untilMs: Date.now() + ms, token });
      return token;
    });
  }

  /** Whether a push still holds the lease for `agentId` in a conversation (see lease). */
  async leased(agentId: string, conversationId: string): Promise<boolean> {
    const snap = await this.db.collection(COLLECTIONS.pushLeases).doc(cursorId(agentId, conversationId)).get();
    return snap.exists && (snap.data() as { untilMs: number }).untilMs > Date.now();
  }

  /** Releases the push lease only if `token` still owns it, so a turn whose lease already expired and was retaken can't delete the new holder's lease. */
  async release(agentId: string, conversationId: string, token: string): Promise<void> {
    const ref = this.db.collection(COLLECTIONS.pushLeases).doc(cursorId(agentId, conversationId));
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists && (snap.data() as { token?: string }).token === token) tx.delete(ref);
    });
  }

  /** `agentId` joins a conversation now: what was said before isn't new to them. Leaves an existing cursor alone. */
  async start(agentId: string, conversationId: string): Promise<void> {
    const ref = this.cur(agentId, conversationId);
    await this.db.runTransaction(async (tx) => {
      const [snap, conv] = await tx.getAll(ref, this.conv(conversationId));
      if (snap!.exists) return;
      const seq = conv!.exists ? (conv!.data() as ConversationDoc).seq : 0;
      tx.set(ref, { agentId, conversationId, seenUpTo: seq, updatedAt: nowIso() });
    });
  }

  /** Sets `done` on the post message doc and sets or clears `doneAt` / `doneBy` on its thread conversation doc when it exists. */
  async setThreadDone(channelId: string, post: string, done: { doneAt: string; doneBy: string } | null): Promise<void> {
    const ref = this.conv(`thread:${channelId}:${post}`);
    const postRef = this.msg(post);
    await this.db.runTransaction(async (tx) => {
      const [snap, postSnap] = await tx.getAll(ref, postRef);
      if (postSnap?.exists) tx.update(postRef, { done: Boolean(done) });
      if (!snap?.exists) return;
      if (done) {
        tx.update(ref, { doneAt: done.doneAt, doneBy: done.doneBy });
      } else {
        tx.update(ref, { doneAt: FieldValue.delete(), doneBy: FieldValue.delete() });
      }
    });
  }

  /** Takes a shared fold lease on `conversationId` for `ms`; returns the fresh conversation doc, or `undefined` if another fold holds the lease. */
  async leaseDigestFold(conversationId: string, ms: number): Promise<ConversationDoc | undefined> {
    const ref = this.conv(conversationId);
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return undefined;
      const data = snap.data() as ConversationDoc;
      const now = Date.now();
      if ((data.digestFoldUntilMs ?? 0) > now) return undefined;
      const digestFoldUntilMs = now + ms;
      tx.update(ref, { digestFoldUntilMs });
      return { ...data, digestFoldUntilMs };
    });
  }

  /** Releases a fold lease without updating the digest (e.g. when the fold call failed or found too few replies). */
  async releaseDigestFold(conversationId: string): Promise<void> {
    const ref = this.conv(conversationId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      tx.update(ref, { digestFoldUntilMs: FieldValue.delete() });
    });
  }

  /** Stores a folded thread digest, only if it advances past the current `digestUpToSeq` (loses a concurrent fold race, no gap), and clears the fold lease. */
  async setDigest(conversationId: string, upToSeq: number, digest: string): Promise<void> {
    const ref = this.conv(conversationId);
    await this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      if (upToSeq <= ((snap.data() as ConversationDoc).digestUpToSeq ?? 0)) {
        tx.update(ref, { digestFoldUntilMs: FieldValue.delete() });
        return;
      }
      tx.update(ref, { threadDigest: digest, digestUpToSeq: upToSeq, digestFoldUntilMs: FieldValue.delete() });
    });
  }

  /** The messages a file is attached to: their conversation, place, and post (thread replies). Same ceiling as below. */
  async attachmentsOf(fileId: string): Promise<Pick<MessageDoc, 'id' | 'conversationId' | 'seq' | 'post'>[]> {
    const snap = await this.db.collection(COLLECTIONS.messages).where('files', 'array-contains', fileId).select('conversationId', 'seq', 'post').limit(500).get();
    return snap.docs.map((d) => ({ ...(d.data() as Pick<MessageDoc, 'conversationId' | 'seq' | 'post'>), id: d.id }));
  }

  /** The conversations a file is attached to a message in. */
  async conversationsWithFile(fileId: string): Promise<string[]> {
    // ponytail: the file's first 500 messages (usually one), conversation ids only; a file re-sent more than that may hide a reader
    const snap = await this.db.collection(COLLECTIONS.messages).where('files', 'array-contains', fileId).select('conversationId').limit(500).get();
    return [...new Set(snap.docs.map((d) => d.get('conversationId') as string))];
  }

  private get activityCol() {
    return this.db.collection('activity');
  }

  async getActivity(docId: string): Promise<ActivityDoc | undefined> {
    return (await this.activityCol.doc(docId).get()).data() as ActivityDoc | undefined;
  }

  async setActivity(docId: string, doc: ActivityDoc): Promise<void> {
    await this.activityCol.doc(docId).set(doc);
  }

  async updateActivityUntil(docId: string, untilMs: number): Promise<void> {
    await this.activityCol.doc(docId).update({ untilMs });
  }

  async listActivityByAgent(agentId: string): Promise<ActivityDoc[]> {
    return (await this.activityCol.where('agentId', '==', agentId).get()).docs.map((d) => d.data() as ActivityDoc);
  }

  async listActivityByConversation(conversationId: string): Promise<ActivityDoc[]> {
    return (await this.activityCol.where('conversationId', '==', conversationId).get()).docs.map((d) => d.data() as ActivityDoc);
  }

  async listActivityByChannel(channelId: string): Promise<ActivityDoc[]> {
    return (await this.activityCol.where('channelId', '==', channelId).get()).docs.map((d) => d.data() as ActivityDoc);
  }

  async listActivitySince(afterMs: number, limit: number): Promise<ActivityDoc[]> {
    return (await this.activityCol.where('atMs', '>', afterMs).orderBy('atMs').limit(limit).get()).docs.map((d) => d.data() as ActivityDoc);
  }
}
