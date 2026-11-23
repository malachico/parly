import type { BillingRecord } from '../lib/plans.js';

/**
 * A company is a workspace-keyed billing record (a credit pool) plus a `name` and `owners`. A person bills it when their
 * `billingAccountId` points at it and its plan is Team or Enterprise; `owners` manage its budget and subscription.
 */
export type CompanyFields = Pick<BillingRecord, 'name' | 'owners'>;

/** What a pool's company fields should be: named after its workspace (else a domain, else its id), owned by its buyer (else the workspace's creator). */
export function companyFields(id: string, ws: { name?: string; domains?: string[]; ownerId?: string; ownerIds?: string[] } | undefined, buyer?: string): CompanyFields {
  const owners = buyer ? [buyer] : ws?.ownerId ? [ws.ownerId] : [];
  return { name: ws?.name?.trim() || ws?.domains?.[0] || id, ...(owners.length ? { owners } : {}) };
}

/** Only the fields `current` lacks: never overwrites a name or owners already set, never writes an empty one. */
export function missingCompanyFields(current: CompanyFields | undefined, want: CompanyFields | undefined): CompanyFields {
  return {
    ...(want?.name && !current?.name ? { name: want.name } : {}),
    ...(want?.owners?.length && !current?.owners?.length ? { owners: want.owners } : {}),
  };
}

/** Whether `personId` owns the company: listed in `owners`, or (a legacy record with none) the workspace's creator. */
export function isCompanyOwner(rec: Pick<BillingRecord, 'owners'> | undefined, ws: { ownerId?: string } | undefined, personId: string): boolean {
  return rec?.owners?.length ? rec.owners.includes(personId) : !!ws?.ownerId && ws.ownerId === personId;
}
