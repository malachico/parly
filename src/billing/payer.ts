import type { AgentRecord } from '../registry/types.js';

/**
 * Who pays for this agent's model calls and metered tools. An ownerless room agent bills `payerId` (the person
 * who opened the room). Otherwise the person (its owner, or itself for a person) pays, unless their company pays
 * for them: `billingAccountOf(person)` is the workspace id of the company credit pool they joined by email domain.
 */
export async function payerOf(
  agent: Pick<AgentRecord, 'id' | 'payerId' | 'ownerId'>,
  billingAccountOf: (personId: string) => Promise<string | undefined>,
): Promise<string> {
  if (!agent.ownerId && agent.payerId) return agent.payerId;
  const person = agent.ownerId ?? agent.id;
  return (await billingAccountOf(person)) ?? person;
}

/** A payer's display name: a person's, or the company pool's workspace name (a pool id is a workspace id, not an agent). */
export async function payerName(
  id: string,
  lookups: { agent: (id: string) => Promise<{ name: string } | undefined>; workspace: (id: string) => Promise<{ name: string } | undefined> },
): Promise<string | undefined> {
  return (await lookups.agent(id))?.name ?? (await lookups.workspace(id))?.name;
}
