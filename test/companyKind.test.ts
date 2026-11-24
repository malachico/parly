import { expect, it } from 'vitest';
import { backfillCompanyKind, type MongoDatabase } from '../src/db/mongo.js';
import { testDb } from './helpers.js';

it('stamps kind=company on workspace-keyed billing records at startup, idempotently, and leaves people alone', async () => {
  const mongo = (testDb() as unknown as MongoDatabase).mongoDb;
  await mongo.collection<{ _id: string }>('workspaces').insertOne({ _id: 'ws1' });
  const billing = mongo.collection<{ _id: string; plan: string; kind?: string }>('billing');
  await billing.insertMany([{ _id: 'ws1', plan: 'team' }, { _id: 'person1', plan: 'pro' }]);
  await backfillCompanyKind(mongo);
  await backfillCompanyKind(mongo);
  expect(await billing.findOne({ _id: 'ws1' })).toMatchObject({ kind: 'company', plan: 'team' });
  expect((await billing.findOne({ _id: 'person1' }))?.kind).toBeUndefined();
});
