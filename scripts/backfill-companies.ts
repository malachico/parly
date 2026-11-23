/**
 * Backfill company `name`/`owners` on every workspace-keyed billing record (a pool), whatever its plan:
 * a lapsed or cancelled pool still holding a subscription id, top-ups or a budget is covered too.
 * Sets only missing fields, so it is safe to re-run. Dry run by default.
 *
 *   MONGODB_URI=... npx tsx scripts/backfill-companies.ts           # print what would change
 *   MONGODB_URI=... npx tsx scripts/backfill-companies.ts --apply   # write it
 *
 * Uses the raw driver, not createMongoDb, so a dry run never builds indexes.
 */
import { MongoClient } from 'mongodb';
import { companyFields, missingCompanyFields } from '../src/billing/company.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is required');
const apply = process.argv.includes('--apply');

const client = new MongoClient(uri, { ignoreUndefined: true });
try {
  const db = client.db(process.env.MONGODB_DB ?? 'parly');
  const billing = db.collection<{ _id: string; paddleCustomerId?: string; name?: string; owners?: string[] }>('billing');
  const workspaces = db.collection<{ _id: string; name?: string; domains?: string[]; ownerId?: string; ownerIds?: string[] }>('workspaces');
  const pools = await billing.find({ _id: { $in: await workspaces.distinct('_id') } }).toArray();
  let changed = 0;
  const ownerless: string[] = [];
  for (const pool of pools) {
    const ws = (await workspaces.findOne({ _id: pool._id })) ?? undefined;
    // The buyer: a workspace owner whose own billing record shares the pool's Paddle customer.
    // ponytail: only owners are candidates, so a non-owner buyer falls back to the workspace owners; fine for phase 1.
    const candidates = [ws?.ownerId, ...(ws?.ownerIds ?? [])].filter((o): o is string => !!o);
    const buyer = pool.paddleCustomerId && candidates.length
      ? (await billing.findOne({ _id: { $in: candidates }, paddleCustomerId: pool.paddleCustomerId }))?._id
      : undefined;
    const patch = missingCompanyFields(pool, companyFields(pool._id, ws, buyer));
    if (!(pool.owners?.length || patch.owners)) ownerless.push(pool._id);
    if (!Object.keys(patch).length) continue;
    changed++;
    console.log(`${pool._id}: ${JSON.stringify(patch)} (owners from ${patch.owners ? (buyer ? 'buyer' : 'workspace owners') : 'existing'})`);
    if (apply) await billing.updateOne({ _id: pool._id }, { $set: patch });
  }
  console.log(`${pools.length} pools, ${changed} ${apply ? 'updated' : 'would change (dry run; --apply to write)'}, ${ownerless.length} without owners${ownerless.length ? `: ${ownerless.join(', ')}` : ''}`);
} finally {
  await client.close();
}
