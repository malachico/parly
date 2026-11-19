import { FieldPath, FieldValue, Filter, Timestamp } from '../src/db/types.js';
import { describe, expect, it } from 'vitest';
import { createMongoDb } from '../src/db/mongo.js';
import { testDb } from './helpers.js';

// Exercises the production Mongo adapter against a disposable replica set.
describe('database conformance', () => {
  it('keeps document IDs and equality values from becoming query operators', async () => {
    const db = testDb();
    const col = db.collection('guards');
    await col.doc('one').set({ token: 'secret' });
    expect(() => col.doc({ $ne: null } as unknown as string)).toThrow();
    expect(() => col.doc('')).toThrow();
    expect((await col.where('token', '==', { $ne: null }).get()).size).toBe(0);
    expect((await col.where('token', 'in', [{ $ne: null }]).get()).size).toBe(0);
    expect((await col.where('token', '==', 'secret').get()).docs.map((d) => d.id)).toEqual(['one']);
    await col.doc('null').set({ token: null });
    await col.doc('absent').set({ other: true });
    expect((await col.where('token', '==', null).get()).docs.map((d) => d.id)).toEqual(['null']);
  });

  it('does not create missing documents on update and keeps batches atomic', async () => {
    const db = testDb();
    const col = db.collection('guards');
    await expect(col.doc('missing').update({ x: 1 })).rejects.toMatchObject({ code: 5 });
    await col.doc('one').create({ x: 1 });
    await expect(col.doc('one').create({ x: 2 })).rejects.toMatchObject({ code: 6 });
    const batch = db.batch();
    batch.set(col.doc('two'), { x: 2 });
    batch.update(col.doc('missing'), { x: 3 });
    await expect(batch.commit()).rejects.toMatchObject({ code: 5 });
    expect((await col.doc('two').get()).exists).toBe(false);
    await db.runTransaction(async (tx) => { tx.set(col.doc('merged'), { nested: { x: 1 } }, { merge: true }); });
    expect((await col.doc('merged').get()).data()).toEqual({ nested: { x: 1 } });
  });

  it('preserves timestamps, undefined omission, transforms, projections and subcollection isolation', async () => {
    const db = testDb();
    const a = db.collection('roots').doc('a').collection('events');
    const b = db.collection('roots').doc('b').collection('events');
    const ref = a.doc('one');
    const at = Timestamp.fromMillis(123456789);
    await ref.set({ at, count: 1, absent: undefined, nested: { x: 1, absent: undefined }, tags: ['a'] });
    await ref.set({ nested: { y: 2 }, count: FieldValue.increment(2) }, { merge: true });
    await ref.update({ tags: FieldValue.arrayUnion('b', 'a'), 'nested.x': FieldValue.delete() });
    await ref.update({ tags: FieldValue.arrayRemove('a'), updated: FieldValue.serverTimestamp() });
    await b.doc('one').set({ count: 99 });
    const data = (await ref.get()).data()!;
    expect(data).toMatchObject({ count: 3, nested: { y: 2 }, tags: ['b'] });
    expect(data.nested).toEqual({ y: 2 });
    expect(data).not.toHaveProperty('absent');
    expect(data.at.toMillis()).toBe(at.toMillis());
    expect(data.updated.toMillis()).toBeGreaterThan(0);
    expect((await a.where('tags', 'array-contains', 'b').get()).docs.map((d) => d.id)).toEqual(['one']);
    expect((await a.where('tags', 'array-contains-any', ['b', 'z']).get()).size).toBe(1);
    expect((await a.select('count').get()).docs[0]!.data()).toEqual({ count: 3 });
    expect((await a.select().get()).docs[0]!.data()).toEqual({});
    expect((await a.count().get()).data().count).toBe(1);
    expect((await db.collection('events').get()).empty).toBe(true);
    expect((await a.get()).docs[0]!.ref.path).toBe(ref.path);
  });

  it('orders and filters through Filter and documentId values', async () => {
    const db = testDb();
    const col = db.collection('rows');
    await col.doc('a').set({ rank: 1 });
    await col.doc('b').set({ rank: 2 });
    await col.doc('c').set({ other: true });
    const q = col.where(Filter.or(Filter.where('rank', '==', 1), Filter.where('rank', '>=', 2)));
    expect((await q.orderBy('rank', 'desc').get()).docs.map((d) => d.id)).toEqual(['b', 'a']);
    expect((await col.orderBy(FieldPath.documentId()).limit(2).get()).docs.map((d) => d.id)).toEqual(['a', 'b']);
    expect((await col.orderBy('rank').get()).docs.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('retries read guards even when contenders write different documents', async () => {
    const db = testDb();
    const col = db.collection('guards');
    await col.doc('a').set({ on: true });
    await col.doc('b').set({ on: true });
    // Both can stop only if the other stays on: snapshot-only transactions allow both off.
    await Promise.all(['a', 'b'].map((id) => db.runTransaction(async (tx) => {
      const [a, b] = await Promise.all([tx.get(col.doc('a')), tx.get(col.doc('b'))]);
      if (a.data()!.on && b.data()!.on) tx.update(col.doc(id), { on: false });
    })));
    expect((await col.where('on', '==', true).get()).size).toBe(1);
  });

  it('protects missing-document guards against a concurrent insertion', async () => {
    const db = testDb();
    const col = db.collection('guards');
    await Promise.all(['a', 'b'].map((id) => db.runTransaction(async (tx) => {
      const [a, b] = await tx.getAll(col.doc('a'), col.doc('b'));
      if (!a!.exists && !b!.exists) tx.create(col.doc(id), { winner: id });
    })));
    expect((await col.get()).size).toBe(1);
  });

  it('protects empty transactional query guards from phantoms', async () => {
    const db = testDb();
    const col = db.collection('guards');
    await Promise.all(['a', 'b'].map((id) => db.runTransaction(async (tx) => {
      if ((await tx.get(col.where('scope', '==', 'one'))).empty) tx.set(col.doc(id), { scope: 'one' });
    })));
    expect((await col.get()).size).toBe(1);
  });
});

it('rejects unsafe Mongo map fields instead of expanding them into update paths', async () => {
  const db = testDb();
  const ref = db.collection('guards').doc('one');
  await ref.set({ map: { safe: true } });
  for (const key of ['$ne', 'nested.path']) {
    await expect(ref.set({ map: { [key]: 'bad' } }, { merge: true })).rejects.toMatchObject({ code: 3 });
  }
  await expect(ref.update({ tags: FieldValue.arrayUnion({ $bad: true }) })).rejects.toMatchObject({ code: 3 });
  expect((await ref.get()).data()).toEqual({ map: { safe: true } });
});

it('refuses insecure Mongo options without leaking the URI or credentials', () => {
  for (const option of ['tls=false', 'ssl=false', 'tlsAllowInvalidCertificates=true', 'tlsInsecure=true', 'authMechanism=PLAIN']) {
    expect(() => createMongoDb(`mongodb+srv://private-user:private-password@example.com/parly?${option}`)).toThrow('Invalid or insecure MongoDB connection configuration');
  }
  // SCRAM-SHA-1 and -256 are both accepted: the prod Atlas user has only a SHA-1 verifier, so the driver must be free to negotiate it.
  for (const mech of ['SCRAM-SHA-1', 'SCRAM-SHA-256']) {
    expect(() => createMongoDb(`mongodb+srv://private-user:private-password@example.com/parly?authMechanism=${mech}`)).not.toThrow();
  }
});

it('sanitizes authentication failures before returning driver errors to callers', async () => {
  const uri = new URL(process.env.TEST_MONGODB_URI!);
  uri.username = 'conformance-private-user';
  uri.password = 'conformance-private-password';
  const previous = process.env.TEST_MONGODB_URI;
  let db;
  try {
    process.env.TEST_MONGODB_URI = uri.toString();
    db = createMongoDb(uri.toString(), 'test_auth_failure');
  } finally { process.env.TEST_MONGODB_URI = previous; }
  try {
    const error = await db.collection('guards').doc('one').get().catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 13, message: expect.stringMatching(/^MongoDB operation failed/) });
    expect(String(error)).not.toContain('conformance-private');
    expect(JSON.stringify(error)).not.toContain('conformance-private');
    expect(error).not.toHaveProperty('cause');
  } finally { await db.terminate(); }
});
