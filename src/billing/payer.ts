import type { AgentRecord } from '../registry/types.js';

/**
 * Who pays for this agent's model calls and metered tools: a person (its owner, itself for a person, or for an ownerless
 * room agent the `payerId` who opened the room), unless their company pays for them: `billingAccountOf(person)` is the
 * company's workspace id while its plan is Team (the linked one, else the oldest
 * active one they own; each owner takes a seat). A company out of credit pauses them; there is no personal fallback.
 */
export async function payerOf(
  agent: Pick<AgentRecord, 'id' | 'payerId' | 'ownerId'>,
  billingAccountOf: (personId: string) => Promise<string | undefined>,
): Promise<string> {
  const person = agent.ownerId ?? (agent.payerId || agent.id);
  return (await billingAccountOf(person)) ?? person;
}

/** A payer's display name: a person's, or the company pool's workspace name (a pool id is a workspace id, not an agent). */
export async function payerName(
  id: string,
  lookups: { agent: (id: string) => Promise<{ name: string } | undefined>; workspace: (id: string) => Promise<{ name: string } | undefined> },
): Promise<string | undefined> {
  return (await lookups.agent(id))?.name ?? (await lookups.workspace(id))?.name;
}
