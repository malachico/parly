import { randomBytes } from 'node:crypto';
import { FieldPath, FieldValue, Filter, type Op, Timestamp } from './types.js';
import { type ClientSession, type Db, type Document, MongoClient, MongoError, type Sort } from 'mongodb';

/**
 * The document-store API the stores use (collections, doc refs, queries, transactions), over MongoDB.
 * - A root collection is a Mongo collection with `_id` = doc id. A subcollection (`doc.collection('x')`)
 *   maps to one Mongo collection per leaf name, `_id` = `<parent doc path>/<collection>/<id>`, plus `_parent` to query by.
 * - Timestamps are stored as BSON Dates (ms precision) and read back as Timestamps.
 * - Transactions and batches buffer writes (stores call tx.set/batch.update without await) and flush
 *   inside `session.withTransaction`, which retries on write conflicts.
 *   Read/write locks in `_txlocks` also cover absent docs and query phantoms.
 * - Error codes match gRPC: create on an existing doc throws code 6, update on a missing doc code 5.
 */

// Field values are `any` like the stores' records (interfaces, not index signatures) expect.
type Data = Record<string, any>;
type Session = ClientSession | undefined;

const fsError = (code: number, message: string) => Object.assign(new Error(message), { code });
const isPlain = (v: unknown): v is Data => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};
const sentinel = (v: unknown) => (v instanceof FieldValue ? v.kind : undefined);
const operand = (v: unknown) => (v as FieldValue).operand!;
const elements = (v: unknown) => ((v as FieldValue).elements ?? []).map(toMongo);
const DROP = Symbol('drop');

const AUTO_ID = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const autoId = () => Array.from(randomBytes(20), (b) => AUTO_ID[b % AUTO_ID.length]).join('');

/** Stored value → Mongo value. Sentinels resolve as a plain (non-merge) set would: increment(n) → n, etc. */
function toMongo(v: unknown): unknown {
  if (v instanceof Timestamp) return v.toDate();
  const s = sentinel(v);
  if (s === 'increment') return operand(v);
  if (s === 'arrayUnion') return elements(v);
  if (s === 'arrayRemove') return [];
  if (s === 'serverTimestamp') return new Date();
  if (s === 'delete') return DROP;
  if (Array.isArray(v)) return v.map((x) => x === undefined ? null : toMongo(x));
  if (isPlain(v)) {
    const out: Data = {};
    for (const [k, x] of Object.entries(v)) {
      const y = toMongo(x);
      if (y !== DROP && y !== undefined) out[k] = y;
    }
    return out;
  }
  return v;
}

/** Mongo value → stored value: Dates come back as Timestamps. */
function fromMongo(v: unknown): unknown {
  if (v instanceof Date) return Timestamp.fromDate(v);
  if (Array.isArray(v)) return v.map(fromMongo);
  if (isPlain(v)) {
    const out: Data = {};
    for (const [k, x] of Object.entries(v)) out[k] = fromMongo(x);
    return out;
  }
  return v;
}

/** Keys Mongo can't address as a path segment: those get written with their parent object. */
const pathSafe = (k: string) => k !== '' && !k.includes('.') && !k.startsWith('$');

/**
 * A merge-set or update() payload → Mongo update operators. merge flattens nested plain objects into
 * dotted paths (a field mask); update() treats top-level keys as paths and nested objects as whole values.
 */
function toUpdate(data: Data, merge: boolean): Document {
  const ops: Record<string, Data> = {};
  const put = (op: string, path: string, v: unknown) => {
    ops[op] ??= {};
    ops[op][path] = v;
  };
  const visit = (path: string, v: unknown) => {
    if (v === undefined) return;
    const s = sentinel(v);
    if (s === 'delete') put('$unset', path, '');
    else if (s === 'increment') put('$inc', path, operand(v));
    else if (s === 'arrayUnion') put('$addToSet', path, { $each: elements(v) });
    else if (s === 'arrayRemove') put('$pullAll', path, elements(v));
    else if (s === 'serverTimestamp') put('$set', path, new Date());
    else if (merge && isPlain(v) && Object.keys(v).length > 0 && Object.keys(v).every(pathSafe)) {
      for (const [k, x] of Object.entries(v)) visit(`${path}.${k}`, x);
    } else put('$set', path, toMongo(v));
  };
  for (const [k, v] of Object.entries(data)) {
    // A merge key Mongo can't take as a path (e.g. an email with dots) can't be merged into: it replaces.
    if (merge && !pathSafe(k)) throw fsError(3, `Field name "${k}" can't be merged on MongoDB; nest it under a safe key`);
    visit(k, v);
  }
  return ops;
}

function validateData(data: unknown, update = false, root = true): void {
  if (data instanceof FieldValue) {
    for (const value of data.elements ?? []) validateData(value, false, false);
    return;
  }
  if (!isPlain(data) && !Array.isArray(data)) return;
  for (const [key, value] of Object.entries(data)) {
    if (!Array.isArray(data) && (!key || key.startsWith('$') || key === '__proto__' ||
      (!update && key.includes('.')) || (update && key.split('.').some((k) => !pathSafe(k))) ||
      (root && ['_id', '_parent', '_txLock'].includes(key)))) throw fsError(3, 'Unsupported document field name');
    validateData(value, false, false);
  }
}

function fieldName(f: string | FieldPath): string {
  if (typeof f === 'string') {
    if (!f || f.split('.').some((k) => !pathSafe(k)) || ['_id', '_parent'].includes(f)) throw fsError(3, 'Invalid field path');
    return f;
  }
  return f.name === '__name__' ? '_id' : f.name;
}

function condition(field: string, op: Op, value: unknown): Document {
  const v = toMongo(value);
  switch (op) {
    case '==':
      return { [field]: { $eq: v, $exists: true } };
    case 'array-contains':
      return { [field]: { $elemMatch: { $eq: v } } };
    case '<':
      return { [field]: { $lt: v } };
    case '<=':
      return { [field]: { $lte: v } };
    case '>':
      return { [field]: { $gt: v } };
    case '>=':
      return { [field]: { $gte: v } };
    case 'in':
    case 'array-contains-any': {
      if (!Array.isArray(v) || !v.length) throw fsError(3, 'Expected a non-empty query array');
      return { $or: v.map((item) => condition(field, op === 'in' ? '==' : 'array-contains', item)) };
    }
    default:
      throw fsError(3, `Unsupported operator ${op}`);
  }
}

/** Filter.where / Filter.or / Filter.and → a Mongo filter. */
function compileFilter(f: Filter): Document {
  if (f.filters) return { [f.op === 'OR' ? '$or' : '$and']: f.filters.map(compileFilter) };
  return condition(fieldName(f.field!), f.op as Op, f.value);
}

class MongoDocSnapshot {
  constructor(
    readonly ref: MongoDocRef,
    private readonly raw: Data | null,
  ) {}
  get id() {
    return this.ref.id;
  }
  get exists() {
    return this.raw !== null;
  }
  data(): Data | undefined {
    if (!this.raw) return undefined;
    const { _id, _parent, _txLock, ...rest } = this.raw;
    return fromMongo(rest) as Data;
  }
  get(path: string | FieldPath): unknown {
    let v: unknown = this.data();
    for (const k of fieldName(path).split('.')) v = isPlain(v) ? v[k] : undefined;
    return v;
  }
}

/** A query result's docs always exist. */
type QueryDocSnapshot = Omit<MongoDocSnapshot, 'data'> & { data(): Data };

class MongoQuerySnapshot {
  constructor(readonly docs: QueryDocSnapshot[]) {}
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(fn: (d: QueryDocSnapshot) => void) {
    this.docs.forEach(fn);
  }
}

export class MongoQuery {
  constructor(
    readonly col: MongoCollection,
    protected readonly q: { filters: Document[]; sort: [string, 1 | -1][]; limit?: number; fields?: string[] } = { filters: [], sort: [] },
  ) {}
  private with(patch: Partial<MongoQuery['q']>) {
    return new MongoQuery(this.col, { ...this.q, ...patch });
  }
  where(field: string | FieldPath | Filter, op?: Op, value?: unknown): MongoQuery {
    const f = field instanceof Filter ? compileFilter(field) : condition(fieldName(field), op!, value);
    return this.with({ filters: [...this.q.filters, f] });
  }
  orderBy(field: string | FieldPath, dir: 'asc' | 'desc' = 'asc'): MongoQuery {
    const name = fieldName(field);
    // Docs that lack an orderBy field are left out.
    const filters = name === '_id' ? this.q.filters : [...this.q.filters, { [name]: { $exists: true } }];
    return this.with({ filters, sort: [...this.q.sort, [name, dir === 'desc' ? -1 : 1]] });
  }
  limit(n: number) {
    return this.with({ limit: n });
  }
  select(...fields: (string | FieldPath)[]) {
    return this.with({ fields: fields.map(fieldName) });
  }
  private filter(): Document {
    const all = [{ _parent: this.col.parent ? { $eq: this.col.parent } : { $exists: false } }, ...this.q.filters];
    return all.length === 1 ? (all[0] as Document) : all.length === 0 ? {} : { $and: all };
  }
  async _get(session: Session): Promise<MongoQuerySnapshot> {
    const sort: [string, 1 | -1][] = [...this.q.sort];
    // Ties break on the doc name, in the direction of the last orderBy.
    if (!this.q.sort.some(([f]) => f === '_id')) sort.push(['_id', this.q.sort.at(-1)?.[1] ?? 1]);
    await this.col.db.ready();
    const projection = this.q.fields ? { _id: 1, ...Object.fromEntries(this.q.fields.map((f) => [f, 1])) } : undefined;
    const rows = await this.col.mongo
      .find(this.filter(), { session, sort: sort as Sort, limit: this.q.limit, projection })
      .toArray();
    if (session) {
      for (const row of rows) await this.col.mongo.updateOne({ _id: row._id }, { $set: { _txLock: randomBytes(16).toString('hex') } }, { session });
    }
    return new MongoQuerySnapshot(rows.map((r) => new MongoDocSnapshot(this.col.docFromKey(String(r._id)), r) as QueryDocSnapshot));
  }
  get() {
    return this.col.db.execute(() => this._get(undefined));
  }
  count() {
    return {
      get: () => this.col.db.execute(async () => {
        const count = await this.col.mongo.countDocuments(this.filter(), { limit: this.q.limit });
        return { data: () => ({ count }) };
      }),
    };
  }
}

class MongoCollection extends MongoQuery {
  readonly mongo;
  constructor(
    readonly db: MongoDatabase,
    readonly id: string,
    /** The parent doc's path for a subcollection. */
    readonly parent?: string,
  ) {
    super(undefined as unknown as MongoCollection);
    (this as { col: MongoCollection }).col = this;
    this.mongo = db.mongoDb.collection(id);
  }
  get path() {
    return this.parent ? `${this.parent}/${this.id}` : this.id;
  }
  doc(id: string = autoId()) {
    if (typeof id !== 'string' || !id || id.includes('/')) throw fsError(3, 'Document id must be a non-empty string without slashes');
    return new MongoDocRef(this, id);
  }
  /** A stored `_id` → its doc ref. */
  docFromKey(key: string) {
    return this.doc(this.parent ? key.slice(this.path.length + 1) : key);
  }
  async add(data: Data) {
    const ref = this.doc();
    await ref.create(data);
    return ref;
  }
}

const writeResult = () => ({ writeTime: Timestamp.now() });

export class MongoDocRef {
  constructor(
    readonly parent: MongoCollection,
    readonly id: string,
  ) {}
  get path() {
    return `${this.parent.path}/${this.id}`;
  }
  /** Mongo `_id`: the bare id in a root collection, the full path in a subcollection. */
  get key() {
    return this.parent.parent ? this.path : this.id;
  }
  private get mongo() {
    return this.parent.mongo;
  }
  private base(): Data {
    return this.parent.parent ? { _id: this.key, _parent: this.parent.parent } : { _id: this.key };
  }
  collection(name: string) {
    return new MongoCollection(this.parent.db, name, this.path);
  }
  async _get(session: Session) {
    await this.parent.db.ready();
    const filter = { _id: this.key } as Document;
    // Touch existing reads too: TTL deletion and other native Mongo writers must conflict.
    const raw = session
      ? await this.mongo.findOneAndUpdate(filter, { $set: { _txLock: randomBytes(16).toString('hex') } }, { session, returnDocument: 'before' })
      : await this.mongo.findOne(filter);
    return new MongoDocSnapshot(this, raw);
  }
  get() {
    return this.parent.db.execute(() => this._get(undefined));
  }
  async _create(data: Data, session: Session) {
    validateData(data, false);
    await this.parent.db.lock(this.parent.path, session!);
    try {
      await this.mongo.insertOne({ ...(toMongo(data) as Data), ...this.base() } as Document, { session });
    } catch (err) {
      if ((err as { code?: number }).code === 11000) throw fsError(6, `Document already exists: ${this.path}`);
      throw err;
    }
  }
  async _set(data: Data, opts: { merge?: boolean } | undefined, session: Session) {
    validateData(data, false);
    await this.parent.db.lock(this.parent.path, session!);
    if (!opts?.merge) {
      await this.mongo.replaceOne({ _id: this.key } as Document, { ...(toMongo(data) as Data), ...this.base() }, { upsert: true, session });
      return;
    }
    // $setOnInsert also gives an empty merge an operator, and subcollection docs their `_parent`.
    const update = { ...toUpdate(data, true), $setOnInsert: this.base() };
    await this.mongo.updateOne({ _id: this.key } as Document, update, { upsert: true, session });
  }
  async _update(data: Data, session: Session) {
    validateData(data, true);
    await this.parent.db.lock(this.parent.path, session!);
    const update = toUpdate(data, false);
    const res =
      Object.keys(update).length === 0
        ? { matchedCount: await this.mongo.countDocuments({ _id: this.key } as Document, { session }) }
        : await this.mongo.updateOne({ _id: this.key } as Document, update, { session });
    if (res.matchedCount === 0) throw fsError(5, `No document to update: ${this.path}`);
  }
  async _delete(session: Session) {
    await this.parent.db.lock(this.parent.path, session!);
    await this.mongo.deleteOne({ _id: this.key } as Document, { session });
  }
  async create(data: Data) {
    await this.parent.db.inTransaction((session) => this._create(data, session));
    return writeResult();
  }
  async set(data: Data, opts?: { merge?: boolean }) {
    await this.parent.db.inTransaction((session) => this._set(data, opts, session));
    return writeResult();
  }
  async update(data: Data) {
    await this.parent.db.inTransaction((session) => this._update(data, session));
    return writeResult();
  }
  async delete() {
    await this.parent.db.inTransaction((session) => this._delete(session));
    return writeResult();
  }
}

/** Buffered writes, shared by batches and transactions. */
class MongoWrites {
  protected readonly ops: ((s: ClientSession) => Promise<void>)[] = [];
  create(ref: MongoDocRef, data: Data) {
    this.ops.push((s) => ref._create(data, s));
    return this;
  }
  set(ref: MongoDocRef, data: Data, opts?: { merge?: boolean }) {
    this.ops.push((s) => ref._set(data, opts, s));
    return this;
  }
  update(ref: MongoDocRef, data: Data) {
    this.ops.push((s) => ref._update(data, s));
    return this;
  }
  delete(ref: MongoDocRef) {
    this.ops.push((s) => ref._delete(s));
    return this;
  }
  async flush(session: ClientSession) {
    for (const op of this.ops) await op(session);
  }
}

class MongoBatch extends MongoWrites {
  constructor(private readonly db: MongoDatabase) {
    super();
  }
  async commit() {
    if (this.ops.length > 0) await this.db.inTransaction((s) => this.flush(s));
    return [];
  }
}

export class MongoTransaction extends MongoWrites {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private readonly db: MongoDatabase, private readonly session: ClientSession) { super(); }
  // Stores use Promise.all(tx.get(...)); the Mongo driver requires serial session operations.
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.pending.then(fn);
    this.pending = result;
    return result;
  }
  get(target: MongoDocRef): Promise<MongoDocSnapshot>;
  get(target: MongoQuery): Promise<MongoQuerySnapshot>;
  get(target: MongoDocRef | MongoQuery): Promise<MongoDocSnapshot | MongoQuerySnapshot> {
    return this.enqueue(async () => {
      await this.db.lock(target instanceof MongoDocRef ? target.parent.path : target.col.path, this.session);
      return target._get(this.session);
    });
  }
  getAll(...refs: MongoDocRef[]) {
    return this.enqueue(async () => {
      for (const ref of refs) await this.db.lock(ref.parent.path, this.session);
      return this.db._getAll(refs, this.session);
    });
  }
}

export class MongoDatabase {
  private initialized?: Promise<void>;
  ready() {
    return this.initialized ??= ensureIndexes(this.mongoDb).catch((error) => { this.initialized = undefined; throw error; });
  }
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    try { await this.ready(); return await fn(); }
    catch (error) {
      // Driver metadata and connection error messages can contain credentials.
      // Embed only name/code/codeName (never credential-bearing) so failures aren't opaque.
      if (error instanceof MongoError) {
        const codeName = (error as { codeName?: string }).codeName;
        throw fsError(error.code === 11000 ? 6 : 13,
          `MongoDB operation failed (${error.name}${error.code !== undefined ? ` code=${error.code}` : ''}${codeName ? ` ${codeName}` : ''})`);
      }
      throw error;
    }
  }
  async lock(path: string, session: ClientSession) {
    // shortcut: collection locks also protect empty queries; use predicate locks if staging contention becomes material.
    try {
      await this.mongoDb.collection('_txlocks').updateOne(
        { _id: path } as Document,
        { $set: { token: randomBytes(16).toString('hex'), expiresAt: new Date(Date.now() + 86_400_000) } },
        { upsert: true, session },
      );
    } catch (error) {
      // Concurrent first readers can race to insert the marker; retry the entire transaction.
      if (error instanceof MongoError && error.code === 11000) error.addErrorLabel('TransientTransactionError');
      throw error;
    }
  }
  constructor(
    readonly client: MongoClient,
    readonly mongoDb: Db,
    private readonly pool: { uri: string; users: number },
  ) {}
  collection(name: string) {
    return new MongoCollection(this, name);
  }
  batch() {
    return new MongoBatch(this);
  }
  async inTransaction<T>(fn: (s: ClientSession) => Promise<T>): Promise<T> {
    return this.execute(async () => {
      const session = this.client.startSession();
      try {
        let result: T | undefined;
        await session.withTransaction(async (s) => {
          result = await fn(s);
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
        return result as T;
      } finally {
        await session.endSession();
      }
    });
  }
  /** Each attempt gets a fresh tx (fresh write buffer); withTransaction retries on transient conflicts. */
  runTransaction<T>(fn: (tx: MongoTransaction) => Promise<T>): Promise<T> {
    return this.inTransaction(async (session) => {
      const tx = new MongoTransaction(this, session);
      const result = await fn(tx);
      await tx.flush(session);
      return result;
    });
  }
  async _getAll(refs: unknown[], session: Session): Promise<MongoDocSnapshot[]> {
    await this.ready();
    const docRefs = refs.filter((r): r is MongoDocRef => r instanceof MongoDocRef);
    if (session) {
      const snapshots: MongoDocSnapshot[] = [];
      for (const ref of docRefs) snapshots.push(await ref._get(session));
      return snapshots;
    }
    const found = new Map<string, Data>();
    const byCol = new Map<string, MongoDocRef[]>();
    for (const r of docRefs) byCol.set(r.parent.id, [...(byCol.get(r.parent.id) ?? []), r]);
    for (const [colId, group] of byCol) {
      const rows = await (group[0] as MongoDocRef).parent.mongo.find({ _id: { $in: group.map((r) => r.key) } } as Document, { session }).toArray();
      for (const r of rows) found.set(`${colId}|${r._id}`, r);
    }
    return docRefs.map((r) => new MongoDocSnapshot(r, found.get(`${r.parent.id}|${r.key}`) ?? null));
  }
  getAll(...refs: unknown[]) {
    return this.execute(() => this._getAll(refs, undefined));
  }
  async terminate() {
    // Pools are shared by adapters (test databases included).
    if (--this.pool.users === 0) { clients.delete(this.pool.uri); await this.client.close(); }
  }
}

/** Compound indexes the hub queries need; ensureIndexes creates them (and the TTL indexes) at startup. */
export const MONGO_INDEXES: { collection: string; keys: Record<string, 1 | -1> }[] = [
  { collection: 'messages', keys: { channelId: 1, createdAt: -1 } },
  { collection: 'messages', keys: { conversationId: 1, seq: -1 } },
  { collection: 'messages', keys: { conversationId: 1, done: 1, seq: -1 } },
  { collection: 'messages', keys: { conversationId: 1, createdAt: 1 } },
  { collection: 'messages', keys: { mentions: 1, createdAt: -1 } },
  { collection: 'workspaces', keys: { 'room.appId': 1, createdAt: -1 } },
  { collection: 'conversations', keys: { participants: 1, lastAt: -1 } },
  { collection: 'conversations', keys: { participants: 1, changedAt: 1 } },
  { collection: 'conversations', keys: { channelId: 1, changedAt: 1 } },
  { collection: 'conversations', keys: { kind: 1, lastAt: 1 } },
  { collection: 'cursors', keys: { agentId: 1, updatedAt: 1 } },
  { collection: 'status_log', keys: { agentId: 1, at: -1 } },
  { collection: 'cursors', keys: { agentId: 1, handedUntilMs: 1 } },
  { collection: 'agentUsage', keys: { period: 1, micros: -1 } },
  // Live activity: by agent / conversation / channel (equality only, no sort) and the feed by time.
  { collection: 'activity', keys: { agentId: 1 } },
  { collection: 'activity', keys: { conversationId: 1 } },
  { collection: 'activity', keys: { channelId: 1 } },
  { collection: 'activity', keys: { atMs: 1 } },
  // Context graph (src/graph/store.ts): edge traversal and cross-conversation edge purge. Workspace+conversation
  // lookups ride the unique (workspaceId, conversationId, kind, key) index created in ensureIndexes.
  { collection: 'graph_edges', keys: { from: 1 } },
  { collection: 'graph_edges', keys: { to: 1 } },
  { collection: 'graph_edges', keys: { workspaceId: 1, fromConversationId: 1 } },
  { collection: 'graph_edges', keys: { workspaceId: 1, toConversationId: 1 } },
];
const MONGO_TTL_COLLECTIONS = [
  'invites',
  'files',
  'oauth_clients',
  'oauth_requests',
  'oauth_tokens',
  'slack_events',
  'slack_link_codes',
  'status_log',
  'events',
  'deliveries',
  'rate_limits',
  // ponytail: telegram_events sets expiresAt too but is left off deliberately to keep its history; add it here when that cleanup is worth more than the audit trail
  'telegram_link_codes',
  'github_oauth_states',
  'pairings',
  // A hosted agent's spend per turn (billing/store.ts): kept a week.
  'llm_turns',
];

/** Idempotent; Mongo has no automatic single-field indexes, so the hot ones are listed below. */
async function ensureIndexes(db: Db): Promise<void> {
  await Promise.all([
    ...MONGO_INDEXES.map((i) => db.collection(i.collection).createIndex(i.keys)),
    // TTL only fires on BSON Dates; `expiresAt` stored as a number or string never expires.
    ...MONGO_TTL_COLLECTIONS.map((c) => db.collection(c).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })),
    db.collection('_txlocks').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // Subcollection docs are queried by parent.
    ...['events', 'deliveries', 'versions', 'redemptions'].map((c) => db.collection(c).createIndex({ _parent: 1 })),
    // Agent lookups: members of a channel/workspace (multikey), a bot's owner, token/session auth, and a company's members.
    ...['channels', 'workspaces', 'ownerId', 'tokenHash', 'sessionHashes', 'billingAccountId'].map((f) => db.collection('agents').createIndex({ [f]: 1 })),
    // ponytail: non-unique sign-in lookups; a unique index on email/googleSub wants a dedup + backfill first (see docs/ponytail-debt.md)
    ...['email', 'googleSub'].map((f) => db.collection('agents').createIndex({ [f]: 1 })),
    // OAuth code exchange (authorization code + device code) and billing by Paddle ids and companies by owner (multikey).
    ...['codeHash', 'deviceCodeHash'].map((f) => db.collection('oauth_requests').createIndex({ [f]: 1 })),
    ...['paddleSubscriptionId', 'paddleCustomerId', 'owners'].map((f) => db.collection('billing').createIndex({ [f]: 1 })),
    // Messages' attachments (multikey) for array-contains lookups.
    db.collection('messages').createIndex({ files: 1 }),
    // Context graph idempotency: one row per (workspace, conversation, kind, normalized key).
    ...['graph_nodes', 'graph_edges', 'graph_embeddings'].map((c) => db.collection(c).createIndex({ workspaceId: 1, conversationId: 1, kind: 1, key: 1 }, { unique: true })),
    // Skill nodes by skill (update/delete sync).
    db.collection('graph_nodes').createIndex({ 'source.skillId': 1 }),
    // Duplicate matching: a workspace's latest people or topics (GraphStore.upsertNode).
    db.collection('graph_nodes').createIndex({ workspaceId: 1, kind: 1, updatedAt: -1 }),
  ]);
}

const clients = new Map<string, { uri: string; client: MongoClient; users: number }>();

/** The document-store client over MongoDB. One connection pool per URI per process. */
export function createMongoDb(uri: string, dbName = 'parly'): MongoDatabase {
  let pool = clients.get(uri);
  if (!pool) {
    try {
      const url = new URL(uri);
      const local = (process.env.NODE_ENV === 'test' && uri === process.env.TEST_MONGODB_URI) || url.protocol === 'mongodb:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      for (const [key, value] of url.searchParams) {
        const k = key.toLowerCase();
        if ((['tls', 'ssl', 'sslvalidate'].includes(k) && value.toLowerCase() === 'false') ||
            ((k.startsWith('tlsallowinvalid') || k === 'tlsinsecure') && value.toLowerCase() !== 'false') ||
            (k === 'authmechanism' && value !== 'SCRAM-SHA-1' && value !== 'SCRAM-SHA-256')) throw new Error();
      }
      pool = { uri, users: 0, client: new MongoClient(uri, {
        ignoreUndefined: true, promoteBuffers: true,
        // Conservative pool/timeouts: Cloud Run runs many instances, each with its own pool, so keep per-instance
        // bounds small (total Atlas conns ≈ instances × (maxPoolSize+2) × members). No change streams (.watch) exist,
        // so socketTimeoutMS can't sever one; 45s sits well above short OLTP ops and any first-time index build here.
        maxPoolSize: 20, minPoolSize: 2,
        serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 45000,
        // Let the driver negotiate the SCRAM mechanism (the prod Atlas user has only a SHA-1 verifier); TLS still enforced below.
        ...(!local ? { tls: true } : {}),
        tlsAllowInvalidCertificates: false, tlsAllowInvalidHostnames: false,
      }) };
    } catch { throw fsError(3, 'Invalid or insecure MongoDB connection configuration'); }
    clients.set(uri, pool);
  }
  pool.users++;
  return new MongoDatabase(pool.client, pool.client.db(dbName), pool);
}
