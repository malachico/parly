import { MongoClient } from 'mongodb';

/** Fails fast when the test replica set is not reachable. */
export default async function setup() {
  const uri = process.env.TEST_MONGODB_URI;
  if (!uri) throw new Error('TEST_MONGODB_URI is not set. Start a disposable MongoDB replica set (see docs/development.md "Testing").');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try { await client.db().command({ ping: 1 }); }
  catch { throw new Error('Test MongoDB replica set is not reachable'); }
  finally { await client.close(); }
}
