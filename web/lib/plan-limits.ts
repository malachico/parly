/** Plan usage from `/me/billing` or a workspace's `participants`. `max` null = unlimited (self-host). */
export type PlanUsage = { count: number; max: number | null };

export function atPlanCap(usage?: PlanUsage): boolean {
  return usage != null && usage.max != null && usage.count >= usage.max;
}

/** e.g. "8/8 participants" — action copy (upgrade vs ask the owner) lives in the UI. */
export function planCapMessage(kind: 'participants' | 'workspaces', usage: { count: number; max: number }): string {
  return `${usage.count}/${usage.max} ${kind}`;
}

/**
 * True when this person is the workspace creator (owners[0]): their plan sets the participant
 * cap. Co-owners manage the workspace but upgrading their own billing does not raise it.
 */
export function isBillingOwner(owners: string[] | undefined, userId: string): boolean {
  return owners?.[0] === userId;
}
